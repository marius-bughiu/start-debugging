---
title: "¿Cuál es la diferencia entre dotnet build y dotnet publish?"
description: "dotnet build compila tu proyecto para el ciclo de desarrollo interno y usa Debug por defecto. dotnet publish ejecuta el target Publish de MSBuild, usa Release por defecto en net8.0 y versiones posteriores, y empaqueta una carpeta lista para implementar con los assets web, los runtimes autocontenidos, el archivo único, el recorte y AOT ya resueltos. Esto es exactamente lo que produce cada uno y cuándo usarlo."
pubDate: 2026-07-10
tags:
  - "dotnet"
  - "dotnet-cli"
  - "msbuild"
  - "deployment"
  - "dotnet-11"
lang: "es"
translationOf: "2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish"
translatedBy: "claude"
translationDate: 2026-07-10
---

`dotnet build` compila tu proyecto y sus dependencias en ensamblados IL para el ciclo de desarrollo interno, y usa la configuración `Debug` por defecto. `dotnet publish` ejecuta un target de MSBuild distinto que produce una carpeta autocontenida lista para copiar a un servidor, usa la configuración `Release` por defecto para cualquier proyecto cuyo target sea `net8.0` o posterior, y es la única forma oficialmente soportada de preparar una aplicación para la implementación. La versión corta: `build` es lo que ejecutas mientras escribes código, `publish` es lo que ejecutas cuando terminaste y quieres algo que puedas distribuir. Las diferencias que de verdad te afectan son el cambio de configuración por defecto y todo lo que hace el target `Publish` que `Build` no hace, como procesar los assets web, empaquetar el runtime para las implementaciones autocontenidas y aplicar archivo único, recorte y AOT.

Todo lo que sigue usa el SDK de .NET 11 (`11.0.100`) con `<TargetFramework>net11.0</TargetFramework>` y C# 14. El comportamiento descrito aplica desde el SDK de .NET 8 en adelante salvo que se indique una versión concreta, porque la diferencia más importante, la configuración por defecto, cambió en .NET 8.

## Dos targets de MSBuild distintos, no dos variantes de lo mismo

Ambos comandos son envoltorios delgados sobre MSBuild, pero invocan targets distintos, y ese único hecho explica casi todas las diferencias que vas a notar.

`dotnet build` ejecuta el target `Build` por defecto. Según la [referencia de dotnet build](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-build), ejecutarlo equivale a `dotnet msbuild -restore` con un nivel de detalle por defecto distinto. Compila tu código más sus dependencias en un conjunto de binarios y se detiene ahí.

`dotnet publish` ejecuta el target `Publish`. La [referencia de dotnet publish](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-publish) es explícita en que "compila la aplicación, lee sus dependencias especificadas en el archivo del proyecto y publica el conjunto de archivos resultante en un directorio", y en que su salida "está lista para su implementación en un sistema de hospedaje". El target `Publish` depende de `Build`, así que un publish siempre compila primero y luego hace más trabajo encima.

Ese "más trabajo encima" es toda la historia. Cuando entiendes qué agrega el target `Publish`, entiendes cuándo la salida de `build` es suficiente y cuándo va a fallar silenciosamente en producción.

## La configuración por defecto es la trampa con la que casi todos tropiezan primero

Esta es la diferencia que le cuesta a la gente una tarde entera, así que va primero.

`dotnet build` usa `Debug` por defecto. `dotnet publish` usa `Release` por defecto, pero solo para proyectos cuyo target sea `net8.0` o posterior. Ambos valores por defecto se pueden sobrescribir con `-c|--configuration`.

```bash
# .NET 11 SDK 11.0.100, project targeting net11.0.
dotnet build      # builds Debug   -> bin/Debug/net11.0/
dotnet publish    # publishes Release -> bin/Release/net11.0/publish/
```

Antes de .NET 8, `dotnet publish` también usaba `Debug` por defecto, y mucha memoria muscular y muchos scripts de CI todavía lo asumen. Microsoft lo cambió deliberadamente para que el comando cuyo trabajo es producir artefactos de implementación produzca por defecto artefactos optimizados. El cambio está documentado en ['dotnet publish' usa la configuración Release](https://learn.microsoft.com/en-us/dotnet/core/compatibility/sdk/8.0/dotnet-publish-config).

La consecuencia práctica: si haces `dotnet build` y luego copias `bin/Debug/...` a un servidor, estás distribuyendo un binario sin optimizar, con las optimizaciones del JIT desactivadas y las ayudas de depuración activadas. Si tu pipeline de CI todavía pasa `-c Release` a `dotnet publish` "por si acaso", ahora eso es redundante pero inofensivo. Si pasa `-c Debug` por costumbre, estás sobrescribiendo el valor por defecto sensato y distribuyendo Debug. Lee tu pipeline una vez y elimina el culto a la carga.

## Qué escribe en disco realmente cada comando

Los conjuntos de salida se solapan, por eso los comandos parecen intercambiables a primera vista, pero no son la misma carpeta.

`dotnet build` escribe en `bin/<configuration>/<framework>/`, por ejemplo `bin/Debug/net11.0/`. Emite tu `.dll` de IL, un ejecutable para lanzarlo en proyectos `Exe`, archivos de símbolos `.pdb`, un `.deps.json` que lista las dependencias, un `.runtimeconfig.json` que nombra el runtime compartido y copias de los DLL de tus dependencias. Para proyectos ejecutables cuyo target sea .NET Core 3.0 o posterior, la documentación señala que "si no hay ninguna otra lógica específica de publicación (como la que tienen los proyectos web), la salida de la compilación debería ser implementable".

`dotnet publish` escribe en una subcarpeta `publish`: `bin/<configuration>/<framework>/publish/` para una compilación dependiente del framework, o `bin/<configuration>/<framework>/<runtime>/publish/` cuando compilas autocontenido para un runtime concreto. Emite los mismos archivos base (`.dll` de IL, `.deps.json`, `.runtimeconfig.json`, dependencias) más lo que requiera la forma de la implementación.

Fíjate en que la salida de `publish` va a un directorio `publish` anidado precisamente para que no choque con la salida normal de la compilación. Si apuntas `-o` a una carpeta que está directamente bajo tu proyecto en un proyecto web, publicaciones sucesivas pueden anidarse en `publish/publish`, un filo conocido señalado en la documentación.

## Por qué "la salida de la compilación es implementable" es una verdad a medias

La documentación dice que la salida de la compilación "debería ser implementable" para un ejecutable simple, y para una aplicación de consola simple eso es genuinamente cierto. Puedes hacer `dotnet build -c Release`, comprimir `bin/Release/net11.0/`, dejarlo en una máquina con el runtime de .NET 11 correspondiente instalado y ejecutarlo.

El problema es que el matiz "si no hay ninguna otra lógica específica de publicación" cubre muchas aplicaciones reales. El target `Publish` hace trabajo que `Build` nunca ejecuta:

- **Assets web.** Los proyectos de ASP.NET Core y Blazor reúnen archivos estáticos, compilan los componentes de Razor, producen la disposición de `wwwroot` y generan los manifiestos de static-web-assets durante el publish. Un `build` a secas no ensambla el árbol de contenido web implementable de la forma que el host espera.
- **Empaquetado del runtime autocontenido.** Cuando pasas `--self-contained`, el publish copia un runtime de .NET completo dentro de la salida para que la máquina de destino no necesite nada preinstalado. `build` nunca empaqueta un runtime.
- **Ready-to-run, archivo único, recorte y AOT.** Todas son transformaciones del momento de publicación, descritas más abajo.

Así que la regla exacta es: para una biblioteca o una aplicación de consola trivial, la salida de `build` y la de `publish` son casi el mismo conjunto de archivos. Para una aplicación web, una implementación autocontenida o cualquier cosa que use las transformaciones del momento de publicación, solo `publish` produce algo correcto. Cuando la gente reporta un [error de no se pudo cargar el archivo o ensamblado en una aplicación publicada](/es/2026/05/fix-could-not-load-file-or-assembly-in-published-app/), la causa raíz suele ser que implementaron una carpeta de `build`, o una copia parcial de una, en lugar de una salida real de `publish`.

## Dependiente del framework vs autocontenido: una decisión exclusiva del publish

`dotnet build` compila contra el framework compartido y asume que el runtime está presente en tiempo de ejecución. No tiene ningún concepto de empaquetar un runtime.

`dotnet publish` te deja elegir el modelo de implementación. Dependiente del framework es el valor por defecto y mantiene la salida pequeña, requiriendo un runtime de .NET correspondiente en el destino:

```bash
# .NET 11 SDK 11.0.100. Framework-dependent, cross-platform. Target needs .NET 11 installed.
dotnet publish -c Release
```

Autocontenido empaqueta el runtime para que el destino no necesite nada preinstalado, a costa de una salida mucho más grande y una compilación por runtime:

```bash
# .NET 11 SDK 11.0.100. Self-contained: the runtime ships inside the output folder.
dotnet publish -c Release -r linux-x64 --self-contained
```

El `-r` (identificador de runtime) hace que la salida sea específica de la plataforma: un publish `linux-x64` no se ejecuta en `win-x64`. Por eso la ruta de salida autocontenida incluye el segmento del runtime (`bin/Release/net11.0/linux-x64/publish/`). Si distribuyes a varias plataformas, ejecutas un publish por RID. Este intercambio de portabilidad es el mismo que sopesas al decidir si recurrir a [Native AOT y lo que te cuesta](/es/2026/06/what-is-native-aot-and-what-does-it-cost-you/).

## Las transformaciones del momento de publicación que no tienen equivalente en build

Cuatro propiedades de MSBuild cambian lo que produce `publish`, y ninguna hace nada significativo durante un `build` a secas. Son la razón por la que `publish` existe como comando aparte.

**`PublishReadyToRun`** compila tus ensamblados al formato ReadyToRun (R2R), una forma de compilación anticipada que pre-JITea tu código para recortar el tiempo de arranque mientras mantiene el JIT disponible para más adelante. Es un paso del momento de publicación; mira cómo se compara con las alternativas en [Native AOT vs ReadyToRun vs JIT](/es/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/).

**`PublishSingleFile`** empaqueta la aplicación en un único ejecutable específico de la plataforma. Activarlo activa implícitamente `PublishSelfContained`.

**`PublishTrimmed`** elimina código de biblioteca que el recortador no puede demostrar que sea alcanzable, reduciendo una implementación autocontenida. Solo aplica a publicaciones autocontenidas.

**`PublishAot`** ejecuta el compilador ILC para producir un único binario nativo sin JIT en absoluto.

```xml
<!-- .NET 11, C# 14. These belong in the .csproj, not on the build command line. -->
<PropertyGroup>
  <PublishSingleFile>true</PublishSingleFile>
  <PublishTrimmed>true</PublishTrimmed>
  <PublishReadyToRun>true</PublishReadyToRun>
</PropertyGroup>
```

```bash
# .NET 11 SDK 11.0.100. Only 'publish' honors these; 'build' ignores them.
dotnet publish -c Release -r win-x64
```

Ejecuta `dotnet build` en un proyecto con estas propiedades definidas y no pasa nada: el recortador no se ejecuta, no se produce ningún archivo único, ILC nunca se invoca. Las transformaciones están cableadas en el grafo de dependencias del target `Publish`, no en el de `Build`. Esta es la razón concreta y mecánica por la que la documentación llama a `publish` "la única forma oficialmente soportada de preparar la aplicación para la implementación".

## Saltarse la recompilación con --no-build

Como `publish` depende de `Build`, un publish recompila por defecto. En un pipeline de CI donde ya ejecutaste `dotnet build` (para correr analizadores o pruebas contra los binarios exactos), recompilar durante el publish desperdicia tiempo y, peor aún, puede producir salidas sutilmente distintas. Pasa `--no-build` para reutilizar la salida de compilación existente:

```bash
# .NET 11 SDK 11.0.100. Build once with the config you want, then publish that.
dotnet build -c Release
dotnet publish -c Release --no-build
```

Dos cosas a vigilar. Primero, `--no-build` activa implícitamente `--no-restore`, así que el restore ya tuvo que haber ocurrido. Segundo, las configuraciones deben coincidir: si haces `dotnet build -c Release` y luego `dotnet publish --no-build` sin `-c Release`, publish busca la salida `Debug` (su valor por defecto), no encuentra una compilación correspondiente y falla. Mantén el valor de `-c` idéntico en ambos comandos. Si usas la disposición de salida de artefactos (`--artifacts-path`), la documentación señala que también debes propagar esa misma ruta a ambos comandos.

## dotnet run y dotnet test conviven junto a estos

Ayuda situar los dos comandos dentro de la CLI más amplia. `dotnet run` compila (Debug por defecto) e inmediatamente lanza la aplicación; es el envoltorio de conveniencia del ciclo interno, no una herramienta de implementación. `dotnet test` compila y ejecuta tu proyecto de pruebas. `dotnet pack` produce un paquete NuGet en lugar de una aplicación implementable, y como publish usa `Release` por defecto en `net8.0` y versiones posteriores. Todos ellos ejecutan un `dotnet restore` implícito primero salvo que pases `--no-restore`. Si tu CI ni siquiera encuentra el SDK para ejecutar cualquiera de estos, ese es un problema de entorno aparte cubierto en [el comando dotnet no se pudo encontrar en CI](/es/2026/05/fix-the-command-dotnet-could-not-be-found-on-ci/).

## Cuál ejecutar, decidido en una línea cada uno

Usa `dotnet build` mientras desarrollas: para compilar, sacar a la luz advertencias y diagnósticos del analizador, y producir binarios para tus pruebas. Es rápido, usa Debug por defecto y su salida está pensada para tu máquina.

Usa `dotnet publish` cuando quieras un artefacto para distribuir: usa Release por defecto, ejecuta los pasos específicos de la implementación y es el camino soportado hacia una carpeta que puedas entregar a un servidor, una imagen de contenedor o un binario de Native AOT. Cuando estás cortando una compilación de release en CI, publish (opcionalmente después de un único `build` compartido con `--no-build`) es el comando que produce lo que implementas. Si además estás moviéndote entre versiones mayores del runtime al mismo tiempo, combínalo con la [lista de verificación de migración de .NET 8 a .NET 11](/es/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) para que la salida de publish apunte al runtime en el que de verdad piensas ejecutar.

La prueba de una sola frase: si la salida es para ti, `build`; si la salida es para una máquina que no es la tuya, `publish`.

## Relacionados

- [¿Qué es Native AOT y qué te cuesta?](/es/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [Native AOT vs ReadyToRun vs JIT en .NET 11](/es/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [Fix: No se pudo cargar el archivo o ensamblado en una aplicación publicada](/es/2026/05/fix-could-not-load-file-or-assembly-in-published-app/)
- [Fix: El comando 'dotnet' no se pudo encontrar en CI](/es/2026/05/fix-the-command-dotnet-could-not-be-found-on-ci/)
- [Migrar de .NET 8 a .NET 11: la lista de verificación completa](/es/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)

## Fuentes

- [Referencia del comando dotnet publish](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-publish) (Microsoft Learn)
- [Referencia del comando dotnet build](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-build) (Microsoft Learn)
- ['dotnet publish' usa la configuración Release por defecto](https://learn.microsoft.com/en-us/dotnet/core/compatibility/sdk/8.0/dotnet-publish-config) (Microsoft Learn)
- [Descripción general de la publicación de aplicaciones .NET](https://learn.microsoft.com/en-us/dotnet/core/deploying/) (Microsoft Learn)
