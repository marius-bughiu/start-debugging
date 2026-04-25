---
title: "Cómo perfilar una app .NET con dotnet-trace y leer su salida"
description: "Guía completa para perfilar apps .NET 11 con dotnet-trace: instalación, elección del perfil correcto, captura desde el inicio y lectura del .nettrace en PerfView, Visual Studio, Speedscope o Perfetto."
pubDate: 2026-04-25
tags:
  - "dotnet"
  - "dotnet-11"
  - "performance"
  - "diagnostics"
  - "profiling"
lang: "es"
translationOf: "2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output"
translatedBy: "claude"
translationDate: 2026-04-25
---

Para perfilar una app .NET con `dotnet-trace`, instala la herramienta global con `dotnet tool install --global dotnet-trace`, busca el PID del proceso objetivo con `dotnet-trace ps` y luego ejecuta `dotnet-trace collect --process-id <PID>`. Sin parámetros, las versiones de la herramienta para .NET 10/11 usan por defecto los perfiles `dotnet-common` y `dotnet-sampled-thread-time`, que juntos cubren el mismo terreno que el antiguo perfil `cpu-sampling`. Pulsa Enter para detener la captura y `dotnet-trace` escribirá un archivo `.nettrace`. Para leerlo, ábrelo en Visual Studio o PerfView en Windows, o conviértelo a un archivo Speedscope o Chromium con `dotnet-trace convert` y visualízalo en [speedscope.app](https://www.speedscope.app/) o `chrome://tracing` / Perfetto. Este artículo usa dotnet-trace 9.0.661903 contra .NET 11 (preview 3), pero el flujo de trabajo ha sido estable desde .NET 5.

## Qué captura realmente dotnet-trace

`dotnet-trace` es un perfilador exclusivo de código administrado que habla con un proceso .NET a través del [puerto de diagnóstico](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/diagnostic-port) y le pide al runtime que transmita eventos a través de [EventPipe](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/eventpipe). No se adjunta ningún perfilador nativo, no se reinicia ningún proceso y no se requieren privilegios de administrador (la excepción es el verbo `collect-linux`, lo veremos más adelante). La salida es un archivo `.nettrace`: un flujo binario de eventos más información de rundown (nombres de tipos, mapas de IL a nativo del JIT) emitida al final de la sesión.

Ese contrato exclusivo de código administrado es la razón principal por la que los equipos eligen `dotnet-trace` en lugar de PerfView, ETW o `perf record`. Obtienes pilas de llamadas administradas resueltas por el JIT, eventos de GC, muestras de asignación, comandos de ADO.NET y eventos personalizados basados en `EventSource` desde una sola herramienta que se ejecuta de forma idéntica en Windows, Linux y macOS. Lo que no obtienes del verbo multiplataforma `collect` son frames nativos, pilas del kernel ni eventos de procesos que no sean .NET.

## Instala y captura tu primera traza

Instala una vez por máquina:

```bash
# Verified against dotnet-trace 9.0.661903, .NET 11 preview 3
dotnet tool install --global dotnet-trace
```

La herramienta toma el runtime .NET más alto disponible en la máquina. Si solo tienes .NET 6 instalado, sigue funcionando, pero no verás los nombres de perfil de .NET 10/11 introducidos en 2025. Ejecuta `dotnet-trace --version` para confirmar qué tienes.

Ahora busca un PID. El verbo `ps` propio de la herramienta es la opción más segura porque solo imprime procesos administrados que exponen un endpoint de diagnóstico:

```bash
dotnet-trace ps
# 21932 dotnet  C:\Program Files\dotnet\dotnet.exe   run --configuration Release
# 36656 dotnet  C:\Program Files\dotnet\dotnet.exe
```

Captura durante 30 segundos contra el primer PID:

```bash
dotnet-trace collect --process-id 21932 --duration 00:00:00:30
```

La consola imprimirá qué providers se habilitaron, el nombre del archivo de salida (por defecto: `<appname>_<yyyyMMdd>_<HHmmss>.nettrace`) y un contador de KB en vivo. Pulsa Enter antes si quieres detenerlo antes de que se cumpla la duración. Detenerlo no es instantáneo: el runtime tiene que volcar la información de rundown de cada método compilado por el JIT que apareció en la traza, lo que en una app grande puede tardar decenas de segundos. Resiste la tentación de pulsar Ctrl+C dos veces.

## Elige el perfil correcto

Toda la razón por la que `dotnet-trace` se siente confuso la primera vez es que "¿qué eventos debo capturar?" tiene muchas respuestas correctas. La herramienta incluye perfiles con nombre para que no tengas que memorizar máscaras de bits de keywords. A partir de dotnet-trace 9.0.661903, el verbo `collect` admite:

- `dotnet-common`: diagnósticos ligeros del runtime. Eventos de GC, AssemblyLoader, Loader, JIT, Exceptions, Threading, JittedMethodILToNativeMap y Compilation en nivel `Informational`. Equivalente a `Microsoft-Windows-DotNETRuntime:0x100003801D:4`.
- `dotnet-sampled-thread-time`: muestrea pilas de hilos administrados a aproximadamente 100 Hz para identificar hotspots a lo largo del tiempo. Usa el sample profiler del runtime con pilas administradas.
- `gc-verbose`: colecciones de GC más muestreo de asignaciones de objetos. Más pesado que `dotnet-common`, pero la única forma de encontrar hotspots de asignación sin un perfilador de memoria.
- `gc-collect`: solo colecciones de GC, sobrecarga muy baja. Bueno para "¿el GC me está pausando?" sin afectar el throughput en estado estable.
- `database`: eventos de comandos de ADO.NET y Entity Framework. Útil para detectar consultas N+1.

Cuando ejecutas `dotnet-trace collect` sin parámetros, la herramienta ahora elige `dotnet-common` más `dotnet-sampled-thread-time` por defecto. Esta combinación reemplaza al antiguo perfil `cpu-sampling`, que muestreaba todos los hilos sin importar el uso de CPU y llevaba a la gente a malinterpretar hilos inactivos como activos. Si necesitas el comportamiento antiguo exacto por compatibilidad con trazas anteriores, usa `--profile dotnet-sampled-thread-time --providers "Microsoft-Windows-DotNETRuntime:0x14C14FCCBD:4"`.

Puedes apilar perfiles con comas:

```bash
dotnet-trace collect -p 21932 --profile dotnet-common,gc-verbose,database --duration 00:00:01:00
```

Para algo más a medida, usa `--providers`. El formato es `Provider[,Provider]` donde cada provider es `Name[:Flags[:Level[:KeyValueArgs]]]`. Por ejemplo, para capturar solo eventos de contención en nivel verbose:

```bash
dotnet-trace collect -p 21932 --providers "Microsoft-Windows-DotNETRuntime:0x4000:5"
```

Si quieres una sintaxis más amigable para keywords del runtime, `--clrevents gc+contention --clreventlevel informational` es equivalente a `--providers Microsoft-Windows-DotNETRuntime:0x4001:4` y es mucho más fácil de leer en scripts.

## Captura desde el arranque

La mitad de los problemas de rendimiento interesantes ocurren en los primeros 200 ms, antes de que puedas siquiera copiar un PID. .NET 5 añadió dos formas de adjuntar `dotnet-trace` antes de que el runtime empiece a atender solicitudes.

La más simple es dejar que `dotnet-trace` lance el proceso hijo:

```bash
dotnet-trace collect --profile dotnet-common,dotnet-sampled-thread-time -- dotnet exec ./bin/Debug/net11.0/MyApp.dll arg1 arg2
```

Por defecto, el stdin/stdout del hijo se redirigen. Pasa `--show-child-io` si necesitas interactuar con la app en la consola. Usa `dotnet exec <app.dll>` o un binario publicado autónomo en lugar de `dotnet run`: este último crea procesos de build/launcher que pueden conectarse a la herramienta antes y dejar tu app real suspendida en el runtime.

La opción más flexible es el puerto de diagnóstico. En un shell:

```bash
dotnet-trace collect --diagnostic-port myport.sock
# Waiting for connection on myport.sock
# Start an application with the following environment variable:
# DOTNET_DiagnosticPorts=/home/user/myport.sock
```

En otro shell, define la variable de entorno y lanza normalmente:

```bash
export DOTNET_DiagnosticPorts=/home/user/myport.sock
./MyApp arg1 arg2
```

El runtime queda suspendido hasta que la herramienta esté lista, y luego arranca con normalidad. Este patrón se compone con contenedores (monta el socket dentro del contenedor), con servicios que no puedes envolver fácilmente y con escenarios multi-proceso donde solo quieres trazar un hijo específico.

## Detente en un evento específico

Las trazas largas son ruidosas. Si solo te importa el segmento entre "el JIT empezó a compilar X" y "la solicitud terminó", `dotnet-trace` puede detenerse en el momento en que se dispare un evento concreto:

```bash
dotnet-trace collect -p 21932 \
  --stopping-event-provider-name Microsoft-Windows-DotNETRuntime \
  --stopping-event-event-name Method/JittingStarted \
  --stopping-event-payload-filter MethodNamespace:MyApp.HotPath,MethodName:Render
```

El flujo de eventos se analiza de forma asíncrona, por lo que algunos eventos extra se cuelan después de la coincidencia antes de que la sesión cierre realmente. Eso normalmente no es un problema cuando estás buscando hotspots.

## Lee la salida .nettrace

Un archivo `.nettrace` es el formato canónico. Tres visualizadores lo manejan directamente y dos más quedan disponibles tras una conversión de una sola línea.

### PerfView (Windows, gratuito)

[PerfView](https://github.com/microsoft/perfview) es la herramienta original que utiliza el equipo del runtime de .NET. Abre el archivo `.nettrace`, haz doble clic en "CPU Stacks" si capturaste `dotnet-sampled-thread-time`, o en "GC Heap Net Mem" / "GC Stats" si capturaste `gc-verbose` o `gc-collect`. La columna "Exclusive %" te dice dónde gastaron su tiempo los hilos administrados; "Inclusive %" te dice qué pila de llamadas alcanzó el frame caliente.

PerfView es denso. Los dos clics que vale la pena memorizar son: clic derecho en un frame y elegir "Set As Root" para profundizar, y usar el cuadro de texto "Fold %" para colapsar frames pequeños y que el camino caliente sea legible. Si la traza fue truncada por una excepción no manejada, lanza PerfView con el flag `/ContinueOnError` y aún podrás inspeccionar lo que ocurrió hasta el crash.

### Visual Studio Performance Profiler

Visual Studio 2022/2026 abre archivos `.nettrace` directamente vía File > Open. La vista CPU Usage es la interfaz más amigable para alguien que nunca ha usado PerfView, con un flame graph, un panel "Hot Path" y atribución a línea de código fuente si tus PDB están cerca. La desventaja es que Visual Studio tiene menos tipos de vista que PerfView, así que el perfilado de asignaciones y el análisis de GC suelen ser más claros en PerfView.

### Speedscope (multiplataforma, navegador)

La forma más rápida de mirar una traza desde Linux o macOS es convertirla a Speedscope y abrir el resultado en el navegador. Puedes pedirle a `dotnet-trace` que escriba Speedscope directamente:

```bash
dotnet-trace collect -p 21932 --format Speedscope --duration 00:00:00:30
```

O convertir un `.nettrace` existente:

```bash
dotnet-trace convert myapp_20260425_120000.nettrace --format Speedscope -o myapp.speedscope.json
```

Arrastra el `.speedscope.json` resultante a [speedscope.app](https://www.speedscope.app/). La vista "Sandwich" es la característica clave: ordena los métodos por tiempo total y te permite hacer clic en cualquiera para ver llamadores y llamados en línea. Es lo más cerca que estarás de PerfView en una Mac. Ten en cuenta que la conversión es con pérdida: se descartan metadatos de rundown, eventos de GC y eventos de excepciones. Mantén el `.nettrace` original al lado por si quieres mirar asignaciones más adelante.

### Perfetto / chrome://tracing

`--format Chromium` produce un archivo JSON que puedes soltar en `chrome://tracing` o [ui.perfetto.dev](https://ui.perfetto.dev/). Esta vista brilla para preguntas de concurrencia: picos del thread pool, cascadas async y síntomas de contención de locks se leen más naturalmente en una línea de tiempo que en un flame graph. El artículo comunitario [Using dotnet-trace with Perfetto](https://dfamonteiro.com/posts/using-dotnet-trace-with-perfetto/) recorre un loop completo, y nosotros cubrimos [un flujo práctico de Perfetto + dotnet-trace](/2026/01/perfetto-dotnet-trace-a-practical-profiling-loop-for-net-9-net-10/) con más detalle a principios de este año.

### dotnet-trace report (CLI)

Si estás en un servidor sin interfaz o solo quieres una verificación rápida, la propia herramienta puede resumir una traza:

```bash
dotnet-trace report myapp_20260425_120000.nettrace topN -n 20
```

Esto imprime los 20 métodos con mayor tiempo de CPU exclusivo. Añade `--inclusive` para cambiar al tiempo inclusivo y `-v` para imprimir firmas de parámetros completas. No es un sustituto de un visualizador, pero alcanza para responder "¿el deploy regresó algo obvio?" sin salir de SSH.

## Detalles que muerden a los novatos

Un puñado de casos límite explica la mayoría de los reportes de "¿por qué mi traza está vacía?".

- El buffer es de 256 MB por defecto. Escenarios con alta tasa de eventos (cada método en un loop apretado, muestreo de asignaciones en una carga de streaming) desbordan ese buffer y descartan eventos en silencio. Auméntalo con `--buffersize 1024`, o reduce los providers.
- En Linux y macOS, `--name` y `--process-id` requieren que la app objetivo y `dotnet-trace` compartan la misma variable de entorno `TMPDIR`. Si no coinciden, la conexión expira sin un error útil. Los contenedores y las invocaciones con `sudo` son los culpables habituales.
- La traza queda incompleta si la app objetivo se cae a mitad de captura. El runtime trunca el archivo para evitar corrupción. Ábrelo en PerfView con `/ContinueOnError` y lee lo que haya: normalmente alcanza para encontrar la causa.
- `dotnet run` lanza procesos auxiliares que se conectan a un listener `--diagnostic-port` antes de que lo haga tu app real. Usa `dotnet exec MyApp.dll` o un binario publicado autónomo cuando estés trazando desde el arranque.
- El valor por defecto `--resume-runtime true` deja que la app arranque en cuanto la sesión esté lista. Si quieres que la app permanezca suspendida (raro, sobre todo para depuradores), pasa `--resume-runtime:false`.
- Para .NET 10 en Linux con kernel 6.4+, el nuevo verbo `collect-linux` captura eventos del kernel, frames nativos y muestras de toda la máquina, pero requiere root y escribe un `.nettrace` con formato preview que no todos los visualizadores soportan aún. Úsalo cuando realmente necesites frames nativos; usa `collect` por defecto para todo lo demás.

## Hacia dónde seguir

`dotnet-trace` es la herramienta correcta para "¿qué está haciendo mi app ahora mismo?". Para métricas continuas (RPS, tamaño del heap del GC, longitud de la cola del thread pool) sin producir un archivo en absoluto, recurre a `dotnet-counters`. Para cazar fugas de memoria que necesitan un volcado de heap real, recurre a `dotnet-gcdump`. Las tres herramientas comparten la plomería del puerto de diagnóstico, así que la memoria muscular de install / `ps` / `collect` se traslada.

Si escribes código que corre en producción, también querrás un modelo mental del lenguaje amigable con el tracing. Nuestras notas sobre [cancelar tareas de larga duración sin deadlocks](/es/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/), [transmitir archivos desde endpoints de ASP.NET Core sin almacenarlos en buffer](/es/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) y [leer archivos CSV grandes en .NET 11 sin quedarte sin memoria](/es/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) muestran patrones que se ven muy diferentes en un flame graph de `dotnet-trace` que las versiones ingenuas, y eso es algo bueno.

El formato `.nettrace` es abierto: si quieres automatizar el análisis, [Microsoft.Diagnostics.Tracing.TraceEvent](https://www.nuget.org/packages/Microsoft.Diagnostics.Tracing.TraceEvent) lee los mismos archivos programáticamente. Así funciona PerfView por dentro, y así construyes un reporte puntual cuando ningún visualizador existente hace la pregunta que tú tienes.

## Fuentes

- [Referencia de la herramienta de diagnóstico dotnet-trace](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-trace) (MS Learn, última actualización 2026-03-19)
- [Documentación de EventPipe](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/eventpipe)
- [Documentación del puerto de diagnóstico](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/diagnostic-port)
- [Providers de eventos conocidos en .NET](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/well-known-event-providers)
- [PerfView en GitHub](https://github.com/microsoft/perfview)
- [Speedscope](https://www.speedscope.app/)
- [Perfetto UI](https://ui.perfetto.dev/)
