---
title: "El servidor de MSBuild viene activado por defecto en .NET 11 Preview 7"
description: "Preview 7 cambia el servidor de MSBuild de opcional a activado por defecto, así que las llamadas consecutivas a dotnet build y dotnet test reutilizan un proceso de trabajo ya caliente. Esto es lo que cambió, cómo desactivarlo y cómo comprobar que el servidor realmente se activó."
pubDate: 2026-08-18
tags:
  - "dotnet-11"
  - "msbuild"
  - "dotnet-sdk"
  - "build-performance"
lang: "es"
translationOf: "2026/08/msbuild-server-on-by-default-dotnet-11-preview-7"
translatedBy: "claude"
translationDate: 2026-08-18
---

.NET 11 Preview 7 salió el 2026-08-11 y, escondido en la sección del SDK, hay un cambio de valor por defecto que afecta a cada compilación que ejecutas: el servidor de MSBuild ahora está activado a menos que lo desactives explícitamente ([dotnet/sdk#55231](https://github.com/dotnet/sdk/pull/55231)).

El servidor de MSBuild mantiene vivo un proceso de trabajo de MSBuild ya caliente entre invocaciones de la CLI. Sin él, cada `dotnet build`, `dotnet test` y `dotnet run` paga el arranque del proceso de MSBuild, el calentamiento del JIT y la resolución del SDK desde cero. Con él, la segunda invocación y todas las siguientes se saltan ese costo. La característica existía detrás de `MSBUILDUSESERVER` desde hace varias versiones, y Preview 7 termina el trabajo convirtiendo "activado" en el valor por defecto.

## Cómo desactivarlo, y qué variable manda de verdad

Dos variables de entorno lo desactivan, y no son equivalentes:

```bash
# Either of these keeps the classic single-shot MSBuild behavior
export DOTNET_CLI_USE_MSBUILD_SERVER=false
export MSBUILDUSESERVER=0
```

`DOTNET_CLI_USE_MSBUILD_SERVER=false` ahora es la autoritativa. Propaga `MSBUILDUSESERVER=0` hacia abajo, de modo que el servidor no puede volver a activarse en silencio por un archivo de respuesta, por `MSBUILDFORCEMULTITHREADED=1` o al pasar `/mt` ([dotnet/sdk#55393](https://github.com/dotnet/sdk/pull/55393)). Si tienes una etapa de CI que necesita garantizar un proceso frío por compilación, esa es la variable que debes definir. Definir solo `MSBUILDUSESERVER=0` deja la puerta abierta a que algo más abajo lo vuelva a activar.

## Por qué el valor por defecto cambió ahora

El valor por defecto no cambió solo. Preview 7 endureció el servidor porque el modo experimental de compilación multihilo (`-mt`) lo trata como requisito previo, y en la misma versión se corrigieron varias asperezas de larga data:

- El Server GC ahora está disponible incluso con `-nr:false`. Como el servidor de MSBuild es la única forma de obtener Server GC, `-mt` ahora usa un servidor de vida corta que se apaga justo después de la compilación, respetando la intención de no reutilizar procesos ([dotnet/msbuild#14248](https://github.com/dotnet/msbuild/pull/14248)).
- Los procesos anidados de MSBuild ya no producen interbloqueos. Una compilación lanzada por una tarea que a su vez invoca MSBuild puede avanzar sin esperar al coordinador externo ([dotnet/msbuild#14224](https://github.com/dotnet/msbuild/pull/14224)).
- Las excepciones inesperadas durante el saludo inicial de conexión se capturan y se informan de forma limpia en lugar de abortar el cliente ([dotnet/msbuild#14292](https://github.com/dotnet/msbuild/pull/14292)).

La ganancia se ve con más claridad en las compilaciones con `-mt`, que se apoyan en el servidor caliente para el estado del JIT y la resolución del SDK. En el panel de rendimiento de MSBuild, un `-t:Rebuild` desde cero de la solución de OrchardCore promedió un 26% menos de tiempo de reloj con `-mt` en Windows (de 146.2 s a 107.8 s) y un 23% menos en Linux (de 118.8 s a 91.5 s).

## Cómo comprobar que el servidor se activó

Un arranque frío silencioso se ve idéntico a uno caliente, solo que más lento. Preview 7 agrega un evento de compilación estructurado, `MSBuildServerLifecycleEventArgs`, que informa si el servidor se creó, se creó de vida corta, se reutilizó o no se usó en absoluto, junto con el ID del proceso del servidor ([dotnet/msbuild#14156](https://github.com/dotnet/msbuild/pull/14156)). Se registra con importancia baja, así que aparece en los registros binarios y con verbosidad de diagnóstico sin tocar la salida normal de consola:

```bash
dotnet build -v:diag
# or capture it for later
dotnet build -bl
```

Cuando necesites partir de cero, por ejemplo después de instalar un SDK nuevo o de cambiar una propiedad global de MSBuild que el proceso caliente dejó en caché, apaga el servidor explícitamente en lugar de andar buscando el proceso:

```bash
dotnet build-server shutdown --msbuild
```

El comando no es nuevo, pero se vuelve mucho más relevante ahora que un servidor caliente es el valor por defecto. Pertenece a tu lista mental junto a "borrar obj y bin" cuando una compilación empieza a comportarse de forma extraña.

Los detalles completos están en las [notas de la versión del SDK de .NET 11 Preview 7](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview7/sdk.md). Si estás recorriendo el resto de Preview 7, el [soporte de archivos ZIP protegidos con contraseña](/es/2026/08/dotnet-11-preview-7-password-protected-zip-archives/) es el otro cambio que vale la pena leer.
