---
title: "Cómo publicar una aplicación .NET 11 como imagen de contenedor con dotnet publish /t:PublishContainer"
description: "Guía completa para construir imágenes de contenedor desde una aplicación .NET 11 sin Dockerfile: el target PublishContainer, ContainerRepository y ContainerImageTags, la selección de imagen base con ContainerBaseImage y ContainerFamily, el push a un registro y cómo se resuelve la autenticación, índices de imagen OCI multiarquitectura, el usuario no root por defecto, el control del entrypoint, la salida en tarball para escáneres y los casos en los que todavía necesitas un Dockerfile."
pubDate: 2026-07-27
template: how-to
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "containers"
  - "docker"
  - "devops"
  - "msbuild"
lang: "es"
translationOf: "2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer"
translatedBy: "claude"
translationDate: 2026-07-27
---

Para convertir una aplicación .NET 11 en una imagen de contenedor sin escribir un Dockerfile, ejecuta `dotnet publish --os linux --arch x64 /t:PublishContainer` desde el directorio del proyecto. El SDK descarga la imagen base de Microsoft adecuada, coloca encima la salida de tu publicación y envía el resultado al daemon local de Docker o Podman. Agrega `-p ContainerRegistry=ghcr.io` para publicar en un registro real, o `-p ContainerArchiveOutputPath=./images/app.tar.gz` para obtener un tarball sin tocar ningún daemon. Todo lo que expresaría un Dockerfile (imagen base, tags, puertos, variables de entorno, etiquetas, usuario, entrypoint) es una propiedad o un item de MSBuild. Este artículo apunta a .NET 11 (preview 6 al momento de escribirlo, versión final en noviembre de 2026) con C# 14 y el SDK 11.0.1xx. Casi todo funciona igual en los SDK de .NET 8, 9 y 10, y menciono las versiones mínimas donde importan.

## Qué hace el SDK en lugar de un Dockerfile

El modelo mental con el que la gente suele llegar está equivocado de una forma útil. `PublishContainer` no es un envoltorio alrededor de `docker build`. No se genera ningún Dockerfile por detrás, y Docker no participa en absoluto en la producción de la imagen.

Lo que ocurre en realidad es que los targets `Microsoft.NET.Build.Containers`, que vienen dentro del SDK, hablan directamente con la API HTTP del registro:

1. Tu aplicación se publica normalmente en `bin/Release/net11.0/<rid>/publish/`.
2. El SDK resuelve una imagen base (por defecto uno de los repositorios `mcr.microsoft.com/dotnet/*`) y descarga su manifiesto y su configuración desde MCR. No descarga blobs de capas que no necesita.
3. Tu carpeta de publicación se empaqueta en una única capa tar nueva.
4. Se ensamblan una nueva configuración y un nuevo manifiesto de imagen: las capas base más la tuya, junto con el entrypoint, el directorio de trabajo, los puertos expuestos, las variables de entorno, las etiquetas y el usuario.
5. El resultado se envía a algún destino. Al daemon local por defecto, a un registro remoto si defines `ContainerRegistry`, o a un `tar.gz` en disco si defines `ContainerArchiveOutputPath`.

De aquí se desprenden dos consecuencias inmediatas. Primero, no necesitas un runtime de contenedores instalado para *construir* una imagen, solo para *ejecutarla* localmente, lo que hace esto viable en agentes de CI sin socket de Docker. Segundo, no hay paso `RUN`, porque no se ejecuta ningún contenedor durante la compilación. Si tu imagen necesita `apt-get install`, eso lo horneas en una imagen base propia y apuntas `ContainerBaseImage` a ella.

`/t:PublishContainer` es un target de MSBuild, no una opción de `dotnet publish`, por eso usa sintaxis de MSBuild. La forma antigua `-p PublishProfile=DefaultContainer` sigue funcionando y hace lo mismo. Si la distinción entre `dotnet build` y `dotnet publish` te resulta difusa, [la diferencia entre dotnet build y dotnet publish](/es/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/) merece cinco minutos, porque todo lo que sigue depende de la salida de la publicación.

## Pasos para publicar una aplicación .NET 11 como imagen de contenedor

1. Confirma que tienes el SDK de .NET 11 (`dotnet --info`). La publicación de contenedores funciona desde el SDK de .NET 7, pero los valores por defecto descritos aquí son los del SDK de .NET 8 en adelante.
2. Define `ContainerRepository` en el archivo del proyecto si el nombre del ensamblado no es un nombre de imagen válido (las mayúsculas son el problema habitual).
3. Ejecuta `dotnet publish --os linux --arch x64 /t:PublishContainer` para construir la imagen y cargarla en el daemon local.
4. Verifica con `docker images` y ejecútala: `docker run --rm -p 8080:8080 my-app:latest`.
5. Agrega `-p ContainerRegistry=<registry>` cuando la imagen ya sea correcta en local, después de autenticarte con `docker login <registry>`.
6. Mueve al `.csproj` los ajustes que quieras dejar permanentes, para que CI y las ejecuciones locales coincidan.

Ese es todo el ciclo. El resto del artículo explica qué hace cada perilla y dónde están los filos.

## Nombres: registro, repositorio, tag

El nombre de imagen que produce el SDK se ensambla a partir de propiedades separadas que se corresponden con las partes de una referencia de imagen completa:

```text
REGISTRY[:PORT]/REPOSITORY[:TAG]
```

- `ContainerRegistry` apunta por defecto al daemon local. Defínelo como `ghcr.io`, `myorg.azurecr.io`, `docker.io`, `quay.io` o un `registry.mycorp.com:5000` privado.
- `ContainerRepository` toma por defecto el `AssemblyName` del proyecto. Los nombres de imagen deben ser alfanuméricos en minúsculas más puntos, guiones bajos, guiones y barras, y deben empezar con letra o número. Un ensamblado llamado `DotNet.ContainerImage` no es un nombre de repositorio válido, y por eso el tutorial de Microsoft define la propiedad de forma explícita.
- `ContainerImageTag` es `latest` por defecto en el SDK de .NET 8 y posteriores. Antes de eso, el valor por defecto era la `Version` del proyecto.

```xml
<!-- .csproj, .NET 11 SDK 11.0.1xx -->
<PropertyGroup>
  <TargetFramework>net11.0</TargetFramework>
  <ContainerRegistry>ghcr.io</ContainerRegistry>
  <ContainerRepository>marius-bughiu/orders-api</ContainerRepository>
  <ContainerImageTags>1.4.2;latest</ContainerImageTags>
</PropertyGroup>
```

`ContainerImageTags` (en plural, delimitado por punto y coma) produce una imagen por tag, que es el patrón habitual de "versión más latest móvil". Los tags tienen un límite de 127 caracteres y deben empezar con un carácter alfanumérico o un guion bajo.

La forma plural es una trampa real en la línea de comandos, porque el punto y coma es el separador de listas de MSBuild y tanto PowerShell como Bash quieren opinar al respecto. El escapado difiere según el shell:

```bash
dotnet publish --os linux --arch x64 /t:PublishContainer \
  /p:ContainerImageTags='"1.4.2;latest"'
```

```powershell
dotnet publish --os linux --arch x64 /t:PublishContainer /p:ContainerImageTags=`"1.4.2`;latest`"
```

Si esa pelea no vale la pena en un script de CI, define la variable de entorno `ContainerImageTags` en su lugar. MSBuild lee las variables de entorno como propiedades, y el shell nunca ve un punto y coma que quiera interpretar.

Ten en cuenta también que publicar en Docker Hub requiere el nombre de usuario en el repositorio (`myuser/orders-api`), no solo el nombre pelado de la imagen.

## Elegir una imagen base sin línea FROM

Por defecto el SDK infiere la imagen base a partir de la forma del proyecto:

- Los proyectos ASP.NET Core reciben `mcr.microsoft.com/dotnet/aspnet`.
- Los proyectos self-contained reciben `mcr.microsoft.com/dotnet/runtime-deps`, porque el runtime viaja dentro de la salida de publicación.
- Todo lo demás recibe `mcr.microsoft.com/dotnet/runtime`.

El tag sale de la parte numérica de tu `TargetFramework`, así que `net11.0` resuelve al tag `11.0`. Desde el SDK 8.0.200 la inferencia también reacciona a cómo publicas: un RID `linux-musl-x64` o `linux-musl-arm64` selecciona las variantes Alpine, y `PublishAot=true` selecciona una variante chiseled AOT de `runtime-deps`.

Para elegir un *sabor* distinto de la imagen de Microsoft, en lugar de otra imagen por completo, usa `ContainerFamily`. El valor se anexa al tag inferido:

```xml
<PropertyGroup>
  <ContainerFamily>alpine</ContainerFamily>
</PropertyGroup>
```

Eso convierte el tag de la imagen base en `11.0-alpine`. El campo es de formato libre y simplemente se concatena, así que verifica que el tag que estás pidiendo exista realmente en el repositorio `mcr.microsoft.com/dotnet/aspnet` (o `runtime`) antes de comprometerte con él. `ContainerFamily` se ignora por completo cuando `ContainerBaseImage` está definido.

Para control total, define `ContainerBaseImage` con un nombre completo incluyendo el tag:

```xml
<PropertyGroup>
  <ContainerBaseImage>mcr.microsoft.com/dotnet/aspnet:11.0-alpine</ContainerBaseImage>
</PropertyGroup>
```

Esta es además la vía de escape ante la ausencia de `RUN`: construye una imagen base una vez con un Dockerfile que instale el paquete nativo que necesites, publícala y apunta todos los servicios a ella.

Los contenedores de Windows requieren el mismo tratamiento. Desde .NET 8, las listas de manifiestos de Microsoft ya no incluyen variantes de Windows, así que apuntar a Nano Server significa nombrar el tag explícitamente, por ejemplo `mcr.microsoft.com/dotnet/aspnet:11.0-nanoserver-ltsc2022`.

Si combinas esto con Native AOT para obtener una imagen realmente pequeña, las contrapartidas descritas en [qué te cuesta realmente Native AOT](/es/2026/06/what-is-native-aot-and-what-does-it-cost-you/) aplican igual dentro de un contenedor, y el ahorro de capas suele ser menor que lo que te cuestan las restricciones de reflexión en compatibilidad de bibliotecas.

## Publicar en un registro y cómo se resuelve la autenticación

Define `ContainerRegistry` y el SDK envía la imagen por la Docker Registry HTTP API V2 en lugar de cargarla en un daemon local:

```bash
# .NET 11 SDK
dotnet publish --os linux --arch x64 /t:PublishContainer \
  -p ContainerRegistry=ghcr.io \
  -p ContainerRepository=marius-bughiu/orders-api
```

Las credenciales se resuelven a través de la propia configuración de Docker, en este orden de utilidad:

1. `~/.docker/config.json`, o el directorio indicado por la variable de entorno `DOCKER_CONFIG`. La sección `auths` (lo que escribe `docker login`) se lee directamente.
2. Las entradas `credHelpers`, que asocian un registro a un ejecutable `docker-credential-<name>` en el `PATH`. Así es como ACR, ECR y Google Artifact Registry entregan tokens de corta duración.
3. `credsStore`, el helper del llavero del sistema operativo.

Si nada de eso está disponible, por ejemplo dentro de un contenedor del SDK sin la configuración de Docker montada, hay dos variables de entorno como último recurso:

```bash
export DOTNET_CONTAINER_REGISTRY_UNAME='<token>'
export DOTNET_CONTAINER_REGISTRY_PWORD="$GITHUB_TOKEN"
```

Dos cosas que conviene saber sobre ellas. El prefijo cambió de `SDK_CONTAINER_*` a `DOTNET_CONTAINER_*` en el SDK 8.0.400, y los artículos desactualizados todavía muestran los nombres antiguos. Y aplican a *ambos* registros, el de origen (MCR, de donde viene la imagen base) y el de destino, lo que las vuelve inadecuadas cuando cada uno necesita credenciales distintas. Prefiere `docker login`.

Para un registro con HTTP plano en una red interna, el SDK 9.0.1xx y posteriores aceptan una lista permitida separada por comas:

```bash
export DOTNET_CONTAINER_INSECURE_REGISTRIES=localhost:5000,registry.mycorp.com
```

**Nuevo en .NET 11:** el SDK ahora valida el `realm` del bearer token que un registro devuelve en su desafío de autenticación antes de seguirlo ([dotnet/sdk#54225](https://github.com/dotnet/sdk/pull/54225)). El realm debe ser un URI absoluto, debe ser HTTPS salvo que ese registro esté listado explícitamente como inseguro, y no debe resolver a un literal de IP de loopback, privada, link-local o no especificada. El host del registro y el de autenticación todavía pueden diferir, que es el patrón OCI normal. Es un cambio disruptivo en el sentido de que un registro mal configurado o malicioso que antes "funcionaba" ahora hará fallar la publicación de forma temprana. Si un registro interno que antes iba bien empieza a fallar en .NET 11, esa validación es lo primero que hay que revisar.

## Imágenes multiarquitectura y el índice de imagen OCI

Desde los SDK 8.0.405, 9.0.102 y 9.0.2xx, `PublishContainer` puede producir una imagen multiarquitectura real. La regla depende de qué propiedades de RID defines:

- Un único `RuntimeIdentifier` o `ContainerRuntimeIdentifier` te da una imagen de una sola arquitectura, como antes.
- Sin un RID único, pero con varios `RuntimeIdentifiers` o `ContainerRuntimeIdentifiers`, el SDK publica una vez por RID y combina los resultados en un [OCI Image Index](https://specs.opencontainers.org/image-spec/image-index/) para que todas las arquitecturas compartan un mismo nombre.

```xml
<!-- .NET 11, SDK 11.0.1xx -->
<PropertyGroup>
  <RuntimeIdentifiers>linux-x64;linux-arm64</RuntimeIdentifiers>
  <ContainerRuntimeIdentifiers>linux-x64;linux-arm64</ContainerRuntimeIdentifiers>
</PropertyGroup>
```

```bash
# Note: no --arch, and no -r. Passing either collapses it back to one architecture.
dotnet publish --os linux /t:PublishContainer
```

`ContainerRuntimeIdentifiers` debe ser un subconjunto de `RuntimeIdentifiers`, o partes del pipeline de compilación fallan de formas confusas. Las imágenes multiarquitectura siempre se emiten en formato OCI sin importar lo que diga `ContainerImageFormat`, porque el esquema de manifiesto Docker v2 no tiene equivalente del índice de imagen.

Dos notas operativas. Los proyectos Blazor WebAssembly pueden encontrarse con condiciones de carrera de compilación cuando los RID se publican de forma concurrente; `ContainerPublishInParallel=false` los serializa a costa de tiempo de reloj (SDK 8.0.408, 9.0.300, 10.0 y posteriores). Y .NET 11 preview 6 agregó soporte multiarquitectura cuando Podman es el motor local ([dotnet/sdk#54575](https://github.com/dotnet/sdk/pull/54575)), algo que antes requería Docker.

`ContainerImageFormat`, agregado en .NET 10, te deja forzar `Docker` u `OCI` para el caso de una sola arquitectura. El valor por defecto se infiere de la imagen base, y las imágenes de Microsoft siguen usando el media type del manifiesto de Docker. Ponlo en `OCI` si alguna herramienta aguas abajo insiste.

## Puertos, variables de entorno, etiquetas y el usuario

Estos son items en lugar de propiedades, así que van en un `ItemGroup`:

```xml
<ItemGroup>
  <ContainerPort Include="8080" Type="tcp" />
  <ContainerEnvironmentVariable Include="ASPNETCORE_FORWARDEDHEADERS_ENABLED" Value="true" />
  <ContainerLabel Include="org.contoso.businessunit" Value="orders" />
</ItemGroup>
```

`ContainerPort` se infiere en .NET 8 y posteriores desde `ASPNETCORE_URLS`, `ASPNETCORE_HTTP_PORTS` o `ASPNETCORE_HTTPS_PORTS`, leídas de la imagen base o de tus propios items `ContainerEnvironmentVariable`. Como las imágenes de ASP.NET Core definen `ASPNETCORE_HTTP_PORTS=8080`, una web API normal no suele necesitar configuración de puertos.

`ContainerEnvironmentVariable` tiene una limitación real que conviene planificar: actualmente no hay forma de definirla desde la CLI, solo desde el archivo del proyecto ([dotnet/sdk-container-builds#451](https://github.com/dotnet/sdk-container-builds/issues/451)). Todo lo específico de entorno pertenece, por lo tanto, a la configuración de tu orquestador, no horneado en la imagen, que es donde debería estar de todos modos.

Las etiquetas se resuelven casi solas. El SDK escribe las anotaciones OCI estándar (`org.opencontainers.image.created`, `.version`, `.title`, `.source`, `.revision`, `.base.name`, `.base.digest` y otras) a partir de propiedades de MSBuild existentes. `.source` y `.revision` solo aparecen cuando `PublishRepositoryUrl` es `true` y SourceLink forma parte de la compilación. Desactiva todo el conjunto con `ContainerGenerateLabels=false`, o una etiqueta concreta con su flag `ContainerGenerateLabelsImage*`.

El valor por defecto del usuario es de los que sorprenden para bien. Apuntando a .NET 8 o posterior contra las imágenes de runtime de Microsoft, el contenedor se ejecuta como el usuario sin privilegios `app` en Linux (referenciado por UID a través de la variable de entorno `APP_UID`) y como `ContainerUser` en Windows. Ese es el valor correcto y deberías dejarlo tal cual. Sí implica que la aplicación no puede escribir en rutas arbitrarias, no puede escuchar en puertos por debajo de 1024 y no puede leer archivos cuyos permisos asumen root. Si realmente necesitas root, ahí está `ContainerUser=root`, y el SDK no verifica que el usuario que nombres exista en la imagen.

`ContainerWorkingDirectory` es `/app` por defecto.

## Controlar el entrypoint

Para la mayoría de las aplicaciones el binario apphost generado es el entrypoint y no hay nada que hacer. Cuando quieres que la imagen ejecute una herramienta en lugar de tu aplicación, usa `ContainerAppCommand` más `ContainerAppCommandArgs`, y `ContainerDefaultArgs` para argumentos que quien invoque deba poder sobrescribir:

```xml
<ItemGroup>
  <!-- Semicolons split tokens: this is dotnet ef database update -->
  <ContainerAppCommand Include="dotnet;ef" />
  <ContainerAppCommandArgs Include="database;update" />
</ItemGroup>
```

`ContainerAppCommandInstruction` decide cómo se combinan estos con cualquier `ENTRYPOINT` de la imagen base, y acepta `Entrypoint`, `DefaultArgs` o `None`. `DefaultArgs` es el valor por defecto y el más sutil: cuando no hay items `ContainerEntrypoint`, omite un entrypoint de la imagen base fijado a `dotnet` o `/usr/bin/dotnet` para darte control completo. `ContainerEntrypoint` y `ContainerEntrypointArgs` están obsoletos desde .NET 8; usa los items de app command en su lugar.

## Salida en tarball para pipelines de escaneo

Los pipelines con foco en seguridad suelen querer escanear antes de que nada llegue a un registro. `ContainerArchiveOutputPath` escribe la imagen a un `tar.gz` y no necesita daemon:

```bash
dotnet publish --os linux --arch x64 /t:PublishContainer \
  -p ContainerArchiveOutputPath=./images/orders-api.tar.gz
```

```bash
docker load -i ./images/orders-api.tar.gz
```

Podman usa `podman load -i` con el mismo archivo. Si das un directorio en lugar de un nombre de archivo, el archivo se llama `$(ContainerRepository).tar.gz`. Todos los `ContainerImageTags` terminan dentro de ese único archivo en vez de producir varios.

## Integrarlo en GitHub Actions

Todo se reduce a tres pasos, porque no hay Buildx, ni QEMU, ni un Dockerfile que mantener sincronizado con el proyecto:

```yaml
# .github/workflows/publish.yml
- uses: actions/setup-dotnet@v4
  with:
    dotnet-version: '11.0.x'

- name: Log in to GHCR
  run: echo "${{ secrets.GITHUB_TOKEN }}" | docker login ghcr.io -u ${{ github.actor }} --password-stdin

- name: Publish container
  run: >
    dotnet publish src/Orders.Api/Orders.Api.csproj
    --os linux /t:PublishContainer
    -p ContainerRegistry=ghcr.io
    -p ContainerRepository=${{ github.repository_owner }}/orders-api
    -p ContainerImageTag=${{ github.sha }}
```

`docker login` se usa solo para poblar `~/.docker/config.json`; el push en sí lo hace el SDK sobre HTTPS. En un runner sin Docker, reemplaza ese paso exportando `DOTNET_CONTAINER_REGISTRY_UNAME` y `DOTNET_CONTAINER_REGISTRY_PWORD`.

## Cuándo sigues queriendo un Dockerfile

Sé honesto con los límites. Recurre a un Dockerfile cuando necesites pasos `RUN`, cuando una compilación multietapa tenga que compilar recursos que no son .NET (un frontend Node, dependencias nativas) en el mismo archivo, o cuando necesites control fino del orden de las capas para eficiencia de caché entre muchas imágenes.

Todo lo demás, que en la práctica son la mayoría de los servicios ASP.NET Core y los worker services, está mejor con `PublishContainer`. La configuración de la imagen vive en el mismo archivo que el resto de la compilación, no puede desincronizarse del TFM, y no hay línea `COPY --from=build /app/publish .` que equivocar. Si ya ejecutas la aplicación bajo [.NET Aspire](/es/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/), este es además el mecanismo que usa el AppHost cuando contenedoriza un recurso de proyecto para su implementación.

Una última nota de versiones para aplicaciones de consola: en el SDK de .NET 10 y posteriores, un proyecto de consola puede publicar un contenedor sin configuración extra. En los SDK de .NET 9 y anteriores necesitabas `<EnableSdkContainerSupport>true</EnableSdkContainerSupport>` en el archivo del proyecto, y esa propiedad sigue siendo la que defines para los tipos de proyecto que el SDK no habilita automáticamente.

## Relacionados

- [¿Cuál es la diferencia entre dotnet build y dotnet publish?](/es/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/) para saber qué acaba realmente en la carpeta que se convierte en tu capa de imagen.
- [¿Qué es Native AOT y qué te cuesta?](/es/2026/06/what-is-native-aot-and-what-does-it-cost-you/) antes de perseguir una imagen más pequeña con `PublishAot`.
- [Native AOT vs ReadyToRun vs JIT en .NET 11](/es/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) para los números de arranque y tamaño detrás de esa decisión.
- [Cómo agregar .NET Aspire a una solución ASP.NET Core existente](/es/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/) si los mismos proyectos también necesitan orquestación local.
- [¿Qué es el código seguro para trimming y cómo se escribe?](/es/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) porque el trimming es la otra mitad de achicar una imagen de contenedor.

## Fuentes

- [Containerize an app with dotnet publish](https://learn.microsoft.com/en-us/dotnet/core/containers/sdk-publish) en Microsoft Learn.
- [Containerize a .NET app reference](https://learn.microsoft.com/en-us/dotnet/core/containers/publish-configuration), la lista completa de propiedades e items.
- [Authenticating to container registries](https://github.com/dotnet/sdk-container-builds/blob/main/docs/RegistryAuthentication.md) en el repositorio dotnet/sdk-container-builds.
- [What's new in the SDK and tooling for .NET 10](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-10/sdk) para `ContainerImageFormat` y el soporte de aplicaciones de consola.
- [.NET SDK in .NET 11 Preview 5 release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/sdk.md) para la validación del realm del bearer token.
- [.NET SDK in .NET 11 Preview 6 release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/sdk.md) para el soporte multiarquitectura con Podman.
