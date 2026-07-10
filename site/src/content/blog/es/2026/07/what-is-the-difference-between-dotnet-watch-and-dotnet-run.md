---
title: "¿Cuál es la diferencia entre dotnet watch y dotnet run?"
description: "dotnet run compila tu proyecto una vez y lo lanza. dotnet watch envuelve a dotnet run en un observador de archivos: relanza o aplica hot reload a la app cada vez que guardas un archivo fuente. Esto es exactamente lo que hace cada uno, qué configura dotnet watch que dotnet run no, y cuándo usar cada uno."
pubDate: 2026-07-10
tags:
  - "dotnet"
  - "dotnet-cli"
  - "dotnet-watch"
  - "hot-reload"
  - "dotnet-11"
lang: "es"
translationOf: "2026/07/what-is-the-difference-between-dotnet-watch-and-dotnet-run"
translatedBy: "claude"
translationDate: 2026-07-10
---

`dotnet run` compila tu proyecto una vez (Debug por defecto) y lanza la app resultante una sola vez. Cuando el proceso termina, vuelves al prompt. `dotnet watch` es un observador de archivos envuelto alrededor de `dotnet run`: arranca la app, luego observa tus archivos fuente, y cada vez que guardas un cambio aplica hot reload de ese cambio en el proceso en ejecución o reinicia la app. La versión corta: `dotnet run` es "compilar y lanzar, una vez"; `dotnet watch` es "mantener la app sincronizada con mi código mientras edito". No son competidores. `dotnet watch` invoca literalmente a `dotnet run` por debajo, así que todo lo que hace `dotnet run`, `dotnet watch` también lo hace, además de la observación y el hot reload encima.

Todo lo de abajo usa el SDK de .NET 11 (`11.0.100`) con `<TargetFramework>net11.0</TargetFramework>` y C# 14. El comportamiento central se ha mantenido estable desde el SDK de .NET 6, cuando `dotnet watch` incorporó Hot Reload; los cambios específicos de cada versión se señalan donde importan.

## El modelo mental en una línea

Ejecuta estos dos comandos uno tras otro y la diferencia es inmediata:

```bash
# .NET 11 SDK 11.0.100, project targeting net11.0.
dotnet run     # builds, launches once, returns to the prompt when the app exits
dotnet watch   # builds, launches, then stays resident watching for file changes
```

`dotnet run` es un comando que termina. Hace su trabajo y devuelve el control. `dotnet watch` es una sesión de larga duración. No regresa hasta que lo detienes con Ctrl+C. Ese único hecho de comportamiento, residente frente a terminante, es la raíz de todas las demás diferencias.

Así se alinean los dos comandos característica por característica:

| Comportamiento                       | `dotnet run`                  | `dotnet watch`                                  |
| ------------------------------------ | ----------------------------- | ----------------------------------------------- |
| Compila antes de lanzar              | Sí (vía `dotnet build`)       | Sí (delega en `dotnet run`)                     |
| Configuración por defecto            | `Debug`                       | `Debug`                                          |
| Lanza la app                         | Una vez                       | Una vez, luego relanza al cambiar               |
| Observa archivos fuente              | No                            | Sí                                               |
| Hot Reload al editar                 | No                            | Sí (desde el SDK de .NET 6)                     |
| Reinicio ante edición no soportada   | N/A                           | Sí (aviso de edición brusca o reinicio auto)    |
| Auto-refresco del navegador (web)    | No                            | Sí                                               |
| Vuelve al prompt al terminar         | Cuando la app termina         | Solo con Ctrl+C                                  |
| Lee `launchSettings.json`            | Sí                            | Sí (a través del `dotnet run` que invoca)        |

## dotnet run: compilar una vez, lanzar una vez

La [referencia de dotnet run](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-run) lo describe como un comando que ejecuta tu aplicación "desde el código fuente con un solo comando". Depende de `dotnet build`, así que cualquier requisito de la compilación se aplica también a `dotnet run`. La secuencia es: restore implícito, compilación a `bin/<configuration>/<framework>/`, y luego lanzar el binario producido. Por defecto usa `Debug` para la mayoría de los proyectos.

Como `dotnet run` trabaja a partir del proyecto y no de una DLL compilada, también lee `Properties/launchSettings.json` y aplica el primer perfil de lanzamiento por defecto. De ahí viene un nombre de entorno como `ASPNETCORE_ENVIRONMENT=Development` y cualquier variable de entorno del perfil. Puedes optar por no usarlo con `--no-launch-profile` o seleccionar uno explícitamente con `-lp|--launch-profile`.

Los argumentos después de un `--` literal se reenvían a tu app, no a la CLI:

```bash
# .NET 11 SDK 11.0.100. Everything after -- goes to your Main / top-level args.
dotnet run -- --input data.csv --verbose
```

El `--` importa más de lo que parece. `dotnet run` reenvía a la aplicación cualquier token que no reconozca, pero primero quita sus propias opciones, lo que puede reordenar el resto. Poner los argumentos de la app después de `--` marca cada token siguiente como argumento de la aplicación, para que la CLI no lo reinterprete. También protege tus scripts a futuro frente a nuevas opciones de `dotnet run` que más adelante podrían chocar con un token que pretendías para la app.

Algunas cosas que `dotnet run` deliberadamente no hace. No es una herramienta de despliegue: la documentación es explícita en que resuelve dependencias desde la caché de NuGet y "no se recomienda usar `dotnet run` para ejecutar aplicaciones en producción". Para eso quieres `dotnet publish`, que es otra historia cubierta en [la diferencia entre dotnet build y dotnet publish](/es/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/). Y no observa nada. Una vez la app está en marcha, `dotnet run` ha terminado; no tiene idea de que acabas de editar un archivo.

## dotnet watch: dotnet run, más un observador de archivos y Hot Reload

La [referencia de dotnet watch](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-watch) lo dice claro: `dotnet watch` "es un observador de archivos. Cuando detecta un cambio, ejecuta el comando `dotnet run` o un comando `dotnet` especificado". Si el cambio es compatible con Hot Reload, aplica el cambio a la app en ejecución sin reiniciar. Si no lo es, reinicia la app.

Esa es toda la propuesta de valor. Editas un archivo `.cs`, guardas, y el cambio está activo en uno o dos segundos sin que toques el terminal. Sin el ciclo manual de detener, recompilar y relanzar.

El subcomando por defecto es `run`, así que estos dos son idénticos:

```bash
# .NET 11 SDK 11.0.100. 'dotnet watch' with no subcommand defaults to 'run'.
dotnet watch
dotnet watch run
```

Desde el SDK de .NET 8, `dotnet watch` acepta `run`, `build` o `test` como comando hijo. Así que `dotnet watch test` reejecuta tu proyecto de pruebas en cada guardado, lo que es un ciclo rojo-verde-refactor muy ceñido que `dotnet run` no puede darte en absoluto.

Los argumentos reenviados funcionan igual, delegados al `dotnet run` subyacente:

```bash
# .NET 11 SDK 11.0.100. Args after -- reach the app on every relaunch.
dotnet watch run -- --input data.csv
```

Mientras la sesión está viva tienes dos controles de teclado. Ctrl+R fuerza una recompilación y reinicio incluso sin un cambio de archivo. Ctrl+C lo desmonta todo, tanto el observador como la app. Ctrl+R solo hace algo mientras la app está realmente en ejecución: si observas una app de consola que termina de inmediato, pulsar Ctrl+R no hace nada, aunque el observador sigue observando y relanzará cuando un archivo cambie.

## Hot Reload y la "edición brusca" que fuerza un reinicio

Hot Reload es la pieza que hace que `dotnet watch` se sienta mágico y es lo más grande que `dotnet run` no tiene. Desde el SDK de .NET 6, `dotnet watch` aplica ediciones elegibles, cuerpos de método, muchos cambios de sentencias, miembros añadidos en muchos casos, dentro del proceso en vivo mientras sigue corriendo. El estado en memoria de tu app sobrevive a la edición.

No toda edición puede aplicarse a un proceso en ejecución. Cambiar la firma de un método, renombrar un tipo, editar algo que el runtime no puede parchear en el sitio: estas son "ediciones bruscas". Cuando `dotnet watch` topa con una, no puede hacer Hot Reload, y por defecto pregunta qué hacer:

```
dotnet watch ⌚ Unable to apply hot reload because of a rude edit.
  ❔ Do you want to restart your app - Yes (y) / No (n) / Always (a) / Never (v)?
```

Elige Always y deja de preguntar y simplemente reinicia ante cada edición brusca a partir de entonces. También puedes saltar el aviso por completo: define `DOTNET_WATCH_RESTART_ON_RUDE_EDIT=1` para reiniciar siempre en silencio, o ejecuta con `--non-interactive` (disponible desde el SDK de .NET 7) para que reinicie ante ediciones bruscas sin esperar entrada por consola, que es lo que quieres en escenarios con scripts o contenedores. Si prefieres no lidiar con Hot Reload en absoluto y quieres un ciclo simple de reinicio-al-cambiar, desactívalo:

```bash
# .NET 11 SDK 11.0.100. Watch and restart, no Hot Reload.
dotnet watch --no-hot-reload
```

El motor de Hot Reload aquí es el mismo que usa Visual Studio, y el conjunto de ediciones soportadas frente a no soportadas sigue las mismas reglas; el comportamiento de [auto-reinicio ante ediciones bruscas de Hot Reload en Visual Studio 2026](/es/2026/04/visual-studio-2026-hot-reload-auto-restart-rude-edits/) refleja el de la CLI. Si entiendes las ediciones bruscas en uno, las entiendes en el otro.

## Qué configura dotnet watch en el entorno que dotnet run no

Cuando `dotnet watch` lanza tu app, inyecta varias variables de entorno que un `dotnet run` pelado nunca define. Vale la pena conocerlas porque permiten a tu app detectar que se ejecuta bajo el observador, y de vez en cuando explican comportamientos sorprendentes. Las principales, según la documentación:

- **`DOTNET_WATCH`** se define en `1` en cada proceso hijo que el observador lanza. Esta es la forma limpia de detectar "¿estoy corriendo bajo `dotnet watch`?".
- **`DOTNET_WATCH_ITERATION`** empieza en `1` y se incrementa en uno cada vez que la app se reinicia o se le aplica hot reload. Puedes registrarla para ver cuántos ciclos de recarga lleva una sesión.
- **`DOTNET_HOTRELOAD_NAMEDPIPE_NAME`** nombra la tubería con nombre que el observador usa para enviar los deltas de Hot Reload al proceso en ejecución.

Así que un paso de compilación o un diagnóstico de arranque puede ramificar según el observador:

```csharp
// .NET 11, C# 14. Detect the watcher from inside the app.
if (Environment.GetEnvironmentVariable("DOTNET_WATCH") == "1")
{
    var iteration = Environment.GetEnvironmentVariable("DOTNET_WATCH_ITERATION");
    Console.WriteLine($"Running under dotnet watch, reload iteration {iteration}");
}
```

También hay varios interruptores `DOTNET_WATCH_SUPPRESS_*` para desactivar comportamientos individuales (refresco del navegador, apertura del navegador, salida de emojis, incrementalidad de MSBuild). Ninguno de ellos existe en el mundo de `dotnet run` porque `dotnet run` no tiene observación, ni canal de Hot Reload, ni inyección de refresco del navegador que suprimir.

## Qué archivos disparan una recarga y cuáles no

Una fuente común de confusión: editas `appsettings.json` bajo `dotnet watch` y no se reinicia nada. Eso es por diseño. `dotnet watch` observa los ítems del grupo `Watch` del proyecto, que por defecto es todo lo del grupo `Compile` y `EmbeddedResource`, a lo largo de todo el grafo de referencias de proyecto. En la práctica eso significa:

- `**/*.cs`
- `*.csproj`
- `**/*.resx`
- Contenido web: `wwwroot/**`

Los archivos de configuración (`.json`, `.config`) deliberadamente no disparan un reinicio, porque el sistema de configuración tiene su propia detección de cambios vía `IOptionsMonitor` y tokens de recarga. Si de verdad quieres que el observador reaccione a otro tipo de archivo, extiende el grupo `Watch` en el `.csproj`:

```xml
<!-- .NET 11. Make dotnet watch react to JS files too. -->
<ItemGroup>
  <Watch Include="**\*.js"
         Exclude="node_modules\**\*;**\*.js.map;obj\**\*;bin\**\*" />
</ItemGroup>
```

Desde el SDK de .NET 10 también puedes excluir carpetas enteras que de otro modo causarían recargas ruidosas con `DefaultItemExcludes`, por ejemplo un directorio `App_Data` en el que la app escribe en tiempo de ejecución. `dotnet run` no tiene nada de esta maquinaria porque nunca vuelve a leer nada después de lanzar.

## Para apps web, dotnet watch también refresca el navegador

Hay un comportamiento más exclusivo de `dotnet watch` que `dotnet run` no toca: para apps ASP.NET Core y Blazor, el observador inyecta un pequeño script de refresco del navegador y abre un WebSocket de vuelta a la herramienta. Cuando guardas un cambio de Razor o CSS, el navegador se recarga (o se actualiza en vivo, para ediciones de Blazor soportadas) sin que cambies a él ni pulses F5. Es la razón por la que `dotnet watch` define `DOTNET_WATCH_AUTO_RELOAD_WS_HOSTNAME` y el middleware de refresco del navegador aparece en proyectos web. Bajo un `dotnet run` pelado no obtienes nada de eso: cambia una vista, y el navegador muestra la página antigua hasta que recompiles y recargues a mano.

Una advertencia que la documentación señala: si tu app habilita compresión de respuesta, la herramienta puede fallar al inyectar el script de refresco y avisa de ello. La solución es condicionar tú mismo el script de refresco o desactivar la compresión en desarrollo.

## Las versiones donde cambió el comportamiento

La mecánica es antigua y estable, pero vale la pena fijar algunas fechas:

- **SDK de .NET 6**: `dotnet watch` incorporó Hot Reload. Antes de eso era solo reinicio.
- **SDK de .NET 7**: llegaron `--non-interactive` y `--disable-build-servers`.
- **SDK de .NET 8**: `dotnet watch` acotó sus comandos hijos a `run`, `build` y `test`; antes podía envolver cualquier comando `dotnet`.
- **SDK de .NET 9 (9.0.200)**: aterrizó `dotnet run -e KEY=VALUE`, así que ahora puedes pasar una variable de entorno puntual directamente desde la CLI sin un perfil de lanzamiento. Como `dotnet watch` reenvía a `dotnet run`, también lo obtienes bajo el observador. Ver [dotnet run -e para variables de entorno sin perfiles de lanzamiento](/es/2026/04/dotnet-11-preview-3-dotnet-run-environment-variables/).
- **SDK de .NET 10 (10.0.100)**: `dotnet run --file app.cs` para apps basadas en archivo, y soporte de `DefaultItemExcludes` en `dotnet watch`.
- **SDK de .NET 11**: `dotnet watch` aprendió a integrarse limpiamente con los app hosts de Aspire y a relanzar automáticamente tras un fallo, detallado en [dotnet watch en .NET 11: app hosts de Aspire y recuperación ante fallos](/es/2026/04/dotnet-watch-11-preview-3-aspire-crash-recovery/).

## Cuál ejecutar

Recurre a `dotnet run` cuando quieras lanzar la app una vez: para verificar un cambio, ejecutar una herramienta de consola, guionar una única invocación en CI, o cualquier momento en que no planees editar código mientras corre. Compila, lanza, y termina con la app. Es lo más simple que pone tu código en marcha.

Recurre a `dotnet watch` cuando estés en un ciclo de editar-guardar-ver: iterando sobre una API, dando estilo a una página Blazor, ciclando rojo-verde con `dotnet watch test`, o depurando algo que requiere varias ediciones para acorralarlo. Te cuesta un terminal residente, y de vez en cuando Hot Reload baja a un reinicio ante una edición brusca, pero a cambio dejas de pagar el impuesto manual de recompilar-relanzar en cada cambio.

La prueba de una frase: si vas a ejecutar la app y luego seguir escribiendo en tu editor, usa `dotnet watch`; si solo quieres que corra, usa `dotnet run`. Ninguno reemplaza a `dotnet publish`, que sigue siendo la única forma soportada de producir algo que realmente despliegues.

## Relacionados

- [¿Cuál es la diferencia entre dotnet build y dotnet publish?](/es/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/)
- [dotnet watch en .NET 11 Preview 3: app hosts de Aspire, recuperación ante fallos y un Ctrl+C más sensato](/es/2026/04/dotnet-watch-11-preview-3-aspire-crash-recovery/)
- [.NET 11 Preview 3: dotnet run -e define variables de entorno sin perfiles de lanzamiento](/es/2026/04/dotnet-11-preview-3-dotnet-run-environment-variables/)
- [Visual Studio 2026: auto-reinicio de Hot Reload ante ediciones bruscas](/es/2026/04/visual-studio-2026-hot-reload-auto-restart-rude-edits/)
- [.NET 11 Preview 5: las apps basadas en archivo obtienen la directiva #:ref](/es/2026/06/dotnet-11-preview-5-file-based-apps-ref-directive/)

## Fuentes

- [Referencia del comando dotnet watch](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-watch) (Microsoft Learn)
- [Referencia del comando dotnet run](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-run) (Microsoft Learn)
- [Referencia del comando dotnet build](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-build) (Microsoft Learn)
- [Frameworks y escenarios de .NET soportados para Hot Reload](https://learn.microsoft.com/en-us/visualstudio/debugger/hot-reload) (Microsoft Learn)
