---
title: "Solución: la restauración de NuGet en Azure DevOps falla con \"Unable to find version 'x.y.z' of package\" desde un feed interno"
description: "La versión existe, pero el pipeline no puede verla. Revisa el rol de la identidad de compilación en el feed, la vista del feed en la URL, qué nuget.config usa la tarea, el mapeo de origen de paquetes y la caché HTTP de 30 minutos."
pubDate: 2026-10-29
template: error-page
tags:
  - "errors"
  - "nuget"
  - "azure-devops"
  - "dotnet"
  - "dotnet-10"
  - "ci-cd"
lang: "es"
translationOf: "2026/10/fix-azure-devops-nuget-restore-unable-to-find-version-of-package-from-an-internal-feed"
translatedBy: "claude"
translationDate: 2026-10-29
---

La solución: cuando un feed de Azure Artifacts tiene el paquete pero la restauración del pipeline dice que no encuentra la versión, casi nunca es que la compilación esté consultando el feed que crees, o bien lo consulta con una identidad que no puede ver esa versión. Revisa estos puntos en orden: ¿la identidad de compilación del pipeline tiene el rol **Feed and Upstream Reader (Collaborator)** en el feed? (Un simple **Feed Reader** no puede traer una versión de un origen ascendente como NuGet.org que aún no se haya guardado en el feed). ¿La URL del feed apunta a una vista como `@Release` a la que la versión nunca se promovió? ¿La tarea de restauración usa el `nuget.config` de tu repositorio o uno generado? ¿`packageSourceMapping` dirige el ID del paquete a otro origen? Por último, ¿un agente autohospedado está sirviendo una lista de versiones obsoleta desde la caché HTTP de 30 minutos de NuGet?

Todo lo que sigue se verificó con el SDK de .NET 10 (10.0.302, NuGet 7.6.0) y las tareas actuales de Azure DevOps Services (`NuGetAuthenticate@1`, `DotNetCoreCLI@2`, `NuGetCommand@2`) a octubre de 2026. Las mismas causas aplican a .NET 8, 9 y las versiones preliminares de .NET 11, porque el error proviene del resolvedor de NuGet y del modelo de permisos del feed, no de la versión del SDK.

El error tiene dos formas según el cliente que ejecute la restauración. `nuget.exe restore` sobre un proyecto `packages.config` imprime el mensaje más antiguo:

```text
// nuget.exe 6.x/7.x, packages.config restore
Unable to find version '1.5.0' of package 'Contoso.Core'.
  https://pkgs.dev.azure.com/contoso/_packaging/contoso-internal/nuget/v3/index.json: Package 'Contoso.Core.1.5.0' is not found on source 'https://pkgs.dev.azure.com/contoso/_packaging/contoso-internal/nuget/v3/index.json'.
```

`dotnet restore`, `msbuild -t:restore` y `nuget.exe` sobre proyectos PackageReference imprimen `NU1102`, y esa versión es mucho más útil porque te dice qué devolvió realmente cada origen:

```text
// dotnet restore, .NET SDK 10.0.302
error NU1102: Unable to find package Contoso.Core with version (>= 1.5.0)
error NU1102:   - Found 1 version(s) in contoso-internal [ Nearest version: 1.4.0 ]
```

Lee con atención esa segunda línea. "Found 1 version(s)" significa que la autenticación funcionó y que se encontró el ID del paquete. El feed simplemente no devolvió `1.5.0` a este solicitante. Eso reduce el problema a "qué versiones puede ver esta identidad, a través de esta URL", que es exactamente lo que controlan las causas de abajo.

## Por qué la versión existe en el navegador pero no en el pipeline

Cuando abres el feed en la interfaz web de Azure DevOps, lo ves como tú mismo (a menudo un Feed Owner), a través de la vista `@Local` predeterminada, con todos los orígenes ascendentes habilitados. El pipeline ve el feed como otra entidad, posiblemente a través de otra URL, usando un `nuget.config` que quizá no escribiste tú. Cada una de estas causas puede ocultar una versión:

1. **Las versiones ascendentes necesitan un rol que pueda guardarlas.** Azure Artifacts sirve un paquete desde un origen ascendente (NuGet.org, otro feed) guardando una copia en tu feed en la primera solicitud. Según la [tabla de permisos de feed](https://learn.microsoft.com/en-us/azure/devops/artifacts/feeds/feed-permissions), "Save packages from upstream sources" requiere **Feed and Upstream Reader (Collaborator)** o superior. Una identidad de compilación que solo tiene **Feed Reader** puede restaurar versiones que ya están guardadas, pero no versiones nuevas. Tu laptop restauró `1.5.0` sin problemas la semana pasada porque eres Collaborator y tu restauración la guardó; la siguiente versión que nadie ha restaurado todavía falla en CI.
2. **La identidad de compilación equivocada.** Un pipeline se ejecuta como `Project Collection Build Service (<org>)` o como `<Project> Build Service (<org>)`. Cuál de las dos depende de la opción "Limit job authorization scope to current project". Otorgar el rol a la otra no sirve de nada.
3. **Una URL de vista.** `.../_packaging/contoso-internal@Release/nuget/v3/index.json` solo expone las versiones promovidas a `@Release`. Un `1.5.0` recién publicado vive en `@Local` hasta que alguien lo promueva.
4. **La tarea ignoró tu `nuget.config`.** `DotNetCoreCLI@2` y `NuGetCommand@2` con `feedsToUse: 'select'` generan una configuración temporal que contiene solo el feed que elegiste en `vstsFeed` (más NuGet.org si `includeNuGetOrg` es true).
5. **El mapeo de origen de paquetes** envía `Contoso.*` a un origen, y la versión que necesitas está en otro. NuGet entonces informa que las versiones del otro origen "were not considered".
6. **Caché HTTP obsoleta.** En un agente autohospedado, NuGet reutiliza la lista de versiones en caché de un paquete hasta por 30 minutos, así que una versión publicada hace cinco minutos es invisible para la siguiente ejecución.
7. **Retraso del origen ascendente o una versión externa bloqueada.** Los paquetes de NuGet.org pueden tardar de 3 a 6 horas en aparecer a través de un origen ascendente, y un ID de paquete que también publicas internamente puede tener las versiones externas bloqueadas.

## Reproducción mínima: el mismo NU1102 desde un feed de carpeta local

No necesitas Azure DevOps para ver lo que hace NuGet cuando un origen devuelve menos versiones de las que pediste. Esta reproducción simula las causas 1 y 3 en local con un origen que solo "muestra" `1.4.0` al solicitante.

```bash
# .NET SDK 10.0.302, macOS/Linux shell
mkdir -p feed lib app
cd lib && dotnet new classlib -n Contoso.Core -o . -f net10.0
dotnet pack -c Release -p:Version=1.4.0 -o ../feed
cd ../app && dotnet new console -f net10.0
dotnet add package Contoso.Core --version 1.5.0 --no-restore
```

```xml
<!-- app/nuget.config, NuGet 7.6 -->
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="contoso-internal" value="../feed" />
  </packageSources>
</configuration>
```

```text
// dotnet restore output, .NET SDK 10.0.302
error NU1102: Unable to find package Contoso.Core with version (>= 1.5.0)
error NU1102:   - Found 1 version(s) in contoso-internal [ Nearest version: 1.4.0 ]
```

Esa es, byte por byte, la misma forma que obtienes de Azure Artifacts cuando la identidad de compilación no puede guardar `1.5.0` desde un origen ascendente, o cuando la URL apunta a una vista que solo tiene `1.4.0`. La restauración no está rota. Está informando fielmente lo que el origen le entregó.

## Solución 1: otorga el rol Collaborator a la identidad de compilación correcta

Esta es la causa detrás de la mayoría de los reportes de "en mi máquina funciona", porque los desarrolladores suelen ser Collaborators o superior, y la identidad de compilación en los feeds más antiguos a menudo es solo un Reader.

1. Averigua con qué identidad se ejecuta el pipeline. En **Project settings > Pipelines > Settings**, revisa **Limit job authorization scope to current project for non-release pipelines**. Si está activada, la identidad es `<Project> Build Service (<org>)`. Si está desactivada, es `Project Collection Build Service (<org>)`. Los pipelines de versión (release) tienen su propio interruptor en la misma página.
2. Abre **Artifacts**, elige el feed, selecciona el ícono de engranaje de **Feed settings** y luego **Permissions**.
3. Agrega esa identidad (busca "Build Service") con el rol **Feed and Upstream Reader (Collaborator)**. Si el pipeline también publica paquetes, otorga **Feed Publisher (Contributor)** a ambas identidades de compilación, como recomienda la documentación.
4. Si el feed vive en un proyecto distinto al del pipeline y usas la identidad con alcance de proyecto, ese otro proyecto también tiene que otorgar a la identidad al menos **Edit project-level information**, según la nota al final de [Manage permissions](https://learn.microsoft.com/en-us/azure/devops/artifacts/feeds/feed-permissions#pipelines-permissions).

En Azure DevOps Services, los feeds nuevos ya otorgan el rol Collaborator a ambas identidades de compilación. Los que fallan son los feeds creados antes de ese valor predeterminado, los feeds creados en Azure DevOps Server 2022 (donde solo la identidad de la colección lo recibe) y los feeds cuyos permisos alguien "endureció".

Después asegúrate de que el pipeline se autentique. Con la CLI de .NET, `NuGetAuthenticate@1` es la forma admitida, y en las imágenes hospedadas de Ubuntu 24.04 y posteriores es obligatoria, porque `nuget.exe` ya no es compatible allí:

```yaml
# Azure Pipelines YAML, .NET SDK 10.0.302, NuGetAuthenticate@1
steps:
- task: UseDotNet@2
  inputs:
    packageType: sdk
    version: '10.0.x'

- task: NuGetAuthenticate@1

- script: dotnet restore MySolution.sln --configfile nuget.config
  displayName: Restore
```

`NuGetAuthenticate@1` instala el proveedor de credenciales de Azure Artifacts y le entrega el token de acceso del trabajo para cada feed de Azure Artifacts de la misma organización. Para un feed en otra organización, crea un PAT con **Packaging > Read**, envuélvelo en una conexión de servicio de NuGet y pásalo mediante `nuGetServiceConnections`, como se muestra en [Restore NuGet packages with Azure Pipelines](https://learn.microsoft.com/en-us/azure/devops/pipelines/packages/nuget-restore).

## Solución 2: apunta a la vista que realmente contiene la versión

Mira la URL del feed en tu `nuget.config`. Todo lo que va después de un `@` en el segmento del feed es una vista:

```xml
<!-- nuget.config, NuGet 7.6: the @Release view only sees promoted versions -->
<add key="contoso-internal"
     value="https://pkgs.dev.azure.com/contoso/_packaging/contoso-internal@Release/nuget/v3/index.json" />
```

Todo feed empieza con `@Local`, `@Prerelease` y `@Release`. `@Local` contiene todo lo publicado en el feed más todo lo guardado desde los orígenes ascendentes. `@Prerelease` y `@Release` solo contienen lo que un Feed Publisher promovió explícitamente. Promueve la versión (abre el paquete, elige **Promote**, selecciona la vista) o haz que el pipeline productor la promueva como último paso. Si la compilación consumidora debe ver versiones no promovidas, quita el sufijo `@Release` para que use la vista predeterminada del feed.

Lo mismo aplica cuando la versión que necesitas llega a través de un origen ascendente de feed a feed. La definición del origen ascendente nombra una vista del otro feed, así que una versión que no está promovida allí también es invisible a través de tu feed.

## Solución 3: evita que la tarea reemplace tu nuget.config

Este YAML parece inofensivo, pero descarta el `nuget.config` de tu repositorio:

```yaml
# Azure Pipelines YAML, DotNetCoreCLI@2: generates a temporary nuget.config
- task: DotNetCoreCLI@2
  inputs:
    command: restore
    projects: '**/*.csproj'
    feedsToUse: select
    vstsFeed: 'contoso-internal'
    includeNuGetOrg: false
```

Con `feedsToUse: select`, la tarea escribe una configuración temporal con solo `vstsFeed` (y NuGet.org si `includeNuGetOrg: true`). Si tu `nuget.config` lista dos feeds, o usa una URL de feed con alcance de proyecto con el segmento del proyecto, o contiene `packageSourceMapping`, nada de eso se aplica a esta restauración. Indícale a la tarea que use tu archivo:

```yaml
# Azure Pipelines YAML, DotNetCoreCLI@2 with the repo's nuget.config
- task: DotNetCoreCLI@2
  inputs:
    command: restore
    projects: '**/*.csproj'
    feedsToUse: config
    nugetConfigPath: 'nuget.config'
```

O sáltate por completo la tarea de restauración y ejecuta `dotnet restore --configfile nuget.config` después de `NuGetAuthenticate@1`, como en la Solución 1. Eso tiene la ventaja de que lo que ejecuta CI es exactamente lo que ejecuta un desarrollador en local.

Ya que estás en ese archivo, sigue el consejo de Microsoft para los feeds con orígenes ascendentes: empieza `<packageSources>` con `<clear />` y lista exactamente un feed de Azure Artifacts con orígenes ascendentes habilitados. NuGet consulta todos los orígenes en paralelo y toma la primera respuesta, así que dos orígenes vuelven las restauraciones no deterministas. Un solo feed con orígenes ascendentes busca en un orden fijo: primero los paquetes publicados en el feed, luego los paquetes guardados desde orígenes ascendentes y después cada origen ascendente en el orden configurado.

## Solución 4: revisa el mapeo de origen de paquetes

Si el repositorio usa [package source mapping](https://learn.microsoft.com/en-us/nuget/consume-packages/package-source-mapping), el error te lo dice directamente:

```text
// dotnet restore output, .NET SDK 10.0.302, with packageSourceMapping
error NU1102: Unable to find package Contoso.Core with version (>= 1.5.0)
error NU1102:   - Found 1 version(s) in contoso-internal [ Nearest version: 1.4.0 ]
error NU1102:   - Versions from contoso-release were not considered
```

"Were not considered" significa que la versión bien puede estar en `contoso-release`, pero ningún patrón de mapeo dirige `Contoso.Core` hacia allí. Cada ID de paquete se resuelve solo contra los orígenes cuyos patrones coinciden con él, y gana el patrón más específico. Corrige el mapeo:

```xml
<!-- nuget.config, NuGet 7.6 -->
<packageSourceMapping>
  <packageSource key="contoso-internal">
    <package pattern="Contoso.*" />
    <package pattern="*" />
  </packageSource>
</packageSourceMapping>
```

Con un solo feed con orígenes ascendentes habilitados, el mapeo correcto más simple es `*` hacia ese feed. El mapeo solo tiene sentido cuando realmente mantienes dos orígenes, y entonces hay que listar cada prefijo interno.

## Solución 5: omite la caché HTTP en agentes autohospedados

Los agentes hospedados empiezan con la caché vacía, así que esto solo afecta a los agentes autohospedados y a las máquinas de desarrollo. La [caché HTTP](https://learn.microsoft.com/en-us/nuget/consume-packages/managing-the-global-packages-and-cache-folders#http-cache) de NuGet almacena la lista de versiones que devolvió cada origen, y las entradas con menos de 30 minutos se reutilizan. Publicas `1.5.0`, disparas la compilación consumidora tres minutos después en el mismo agente, y la restauración sigue viendo la lista en caché que termina en `1.4.0`.

```bash
# .NET SDK 10.0.302
dotnet restore --no-http-cache
# or, for packages.config projects with nuget.exe
nuget restore MySolution.sln -NoHttpCache
# or clear it once
dotnet nuget locals http-cache --clear
```

`--no-http-cache` es lo bastante barato como para dejarlo activado en CI en el paso que restaura paquetes internos recién publicados. No recurras a `dotnet nuget locals all --clear` en un agente compartido; vaciar `global-packages` obliga a todos los demás pipelines de esa máquina a descargar todo de nuevo.

## Solución 6: espera la latencia del origen ascendente o permite versiones externas

Dos comportamientos del lado del feed producen el mismo síntoma de "nearest version" para paquetes que se originan en NuGet.org:

- **Retraso de propagación.** La [documentación de orígenes ascendentes](https://learn.microsoft.com/en-us/azure/devops/artifacts/concepts/upstream-sources) indica que normalmente hay un retraso de 3 a 6 horas entre una publicación en NuGet.org y el momento en que la versión está disponible a través de un origen ascendente. Entre feeds de Azure Artifacts suele ser de unos pocos minutos. Si falla una dependencia lanzada esta mañana y la versión de la semana pasada se restaura, espera o fija la versión anterior por unas horas.
- **Versiones externas bloqueadas.** Si publicas internamente un ID de paquete que también existe públicamente, Azure Artifacts puede bloquear el guardado de nuevas versiones públicas de ese ID para protegerte contra la confusión de dependencias. Un Feed Owner puede permitirlas por paquete con **Allow externally-sourced versions** en la página del paquete, o con la llamada REST `versionsFromExternalUpstreams: AllowExternalVersions` descrita en [Safeguard against malicious public packages](https://learn.microsoft.com/en-us/azure/devops/artifacts/concepts/upstream-behavior). Calcula hasta 3 horas para que ese cambio se propague.

Revisa también **Feed settings > Upstream sources** por si hay un estado de sincronización fallido. Un origen ascendente roto detiene la actualización de metadatos de todos los paquetes de ese protocolo, así que las versiones nuevas dejan de aparecer incluso desde orígenes ascendentes sanos.

## Trampas que se parecen a este error pero no lo son

**`NU1101: Unable to find package Contoso.Core. No packages exist with this id in source(s)`.** Es una situación distinta: el ID no se encontró en absoluto. Por lo general el origen es incorrecto, el feed tiene alcance de proyecto y a la URL le falta el segmento del proyecto (`https://pkgs.dev.azure.com/<org>/<project>/_packaging/<feed>/nuget/v3/index.json`), o el mapeo de origen de paquetes excluye todos los orígenes para ese ID.

**`NU1301: Unable to load the service index for source` o un `401 Unauthorized`.** La autenticación falló antes de que comenzara la resolución de versiones. Agrega `NuGetAuthenticate@1` y verifica que nada en el `nuget.config` del repositorio tenga fijado `<packageSourceCredentials>` con un PAT vencido, ya que eso anula el proveedor de credenciales.

**`403 Forbidden ... lacks permission to complete this action`.** La identidad llegó al feed pero no tiene ningún rol en él. La solución es la misma que la Solución 1, además de revisar el alcance de autorización del trabajo.

**Una versión que se restaura en un pipeline y en otro no.** Distintos pipelines pueden ejecutarse con identidades distintas: los pipelines de versión clásicos tienen su propio interruptor de alcance, y los pipelines YAML disparados desde otro proyecto se ejecutan como el build service de ese proyecto.

**Versiones con administración central de paquetes.** Con `Directory.Packages.props`, la versión del error proviene del archivo central, no del `.csproj`, así que "arreglar" el archivo del proyecto no hace nada. Si estás en medio de una migración, la guía sobre [mover una solución a la administración central de paquetes](/es/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/) cubre de dónde se resuelve cada versión.

**Un paquete que desaparece después de actualizar el SDK.** Si un paquete transitivo desapareció en lugar de fallar al resolverse, puede haber sido eliminado por la [poda de paquetes de NuGet en .NET 10](/es/2026/05/nuget-package-pruning-default-net-10/), que es un comportamiento esperado y no un problema del feed.

**Problemas del lado de la publicación.** Si la versión realmente falta en el feed, la publicación del productor falló o fue rechazada. El versionado con MinVer y la configuración de trusted publishing de [publicar varios paquetes NuGet de forma independiente](/2026/05/independently-release-multiple-nuget-packages-with-minver-and-trusted-publishing/) facilita ver qué versión produjo cada etiqueta. Para los controles de seguridad del lado de NuGet.org que también bloquean publicaciones, consulta [qué proteger en tu cuenta de NuGet](/es/2026/01/nuget-become-owner-request-spam-what-to-do-and-what-to-lock-down-in-net-9-net-10/).

## Una lista de verificación que encuentra la causa en cinco minutos

1. Lee la salida completa de `NU1102`. "Found N version(s)" significa que la autenticación funciona y el problema es de visibilidad. "Were not considered" significa mapeo de origen de paquetes.
2. Copia la URL del feed del registro de la restauración, no de tu `nuget.config` local. Si la tarea generó una configuración temporal, el registro muestra su ruta; cambia a `feedsToUse: config`.
3. Busca `@` en esa URL. Si hay una vista, verifica si la versión está promovida a ella.
4. Busca la versión en la página de paquetes del feed. Si falta allí pero existe en NuGet.org o en un feed ascendente, nunca se ha guardado: otorga el rol Collaborator a la identidad de compilación, o restáurala una vez como Collaborator para guardarla.
5. Confirma qué identidad de compilación ejecuta el trabajo mediante la opción de alcance de autorización del trabajo, y revisa exactamente esa identidad en la página de Permissions del feed.
6. En un agente autohospedado, vuelve a ejecutar con `--no-http-cache`.
7. Para un paquete publicado hoy en NuGet.org, revisa el estado del origen ascendente y la configuración de versiones externas del paquete, y luego espera.

Nueve de cada diez veces la respuesta es el paso 4 o 5. El feed no miente y NuGet no está roto; el pipeline simplemente es un lector distinto de ti.

## Fuentes

- [Manage permissions - Azure Artifacts](https://learn.microsoft.com/en-us/azure/devops/artifacts/feeds/feed-permissions) (roles del feed, nombres de las identidades de compilación, nota entre proyectos)
- [What are upstream sources?](https://learn.microsoft.com/en-us/azure/devops/artifacts/concepts/upstream-sources) (orden de búsqueda, consejo de feed único, retraso de 3 a 6 horas)
- [Safeguard against malicious public packages](https://learn.microsoft.com/en-us/azure/devops/artifacts/concepts/upstream-behavior) (Allow external versions)
- [Restore NuGet packages with Azure Pipelines](https://learn.microsoft.com/en-us/azure/devops/pipelines/packages/nuget-restore) (`NuGetAuthenticate@1`, nota de Ubuntu 24.04, feeds entre organizaciones)
- [Feed views](https://learn.microsoft.com/en-us/azure/devops/artifacts/concepts/views)
- [NuGet Error NU1102](https://learn.microsoft.com/en-us/nuget/reference/errors-and-warnings/nu1102)
- [Package Source Mapping](https://learn.microsoft.com/en-us/nuget/consume-packages/package-source-mapping)
- [Managing the global packages, cache, and temp folders](https://learn.microsoft.com/en-us/nuget/consume-packages/managing-the-global-packages-and-cache-folders) (caché HTTP de 30 minutos)
- [NuGet.Client Strings.resx](https://github.com/NuGet/NuGet.Client/blob/dev/src/NuGet.Core/NuGet.PackageManagement/Strings.resx) (mensajes `UnknownPackageSpecificVersion` y `PackageNotFoundOnSource`)
