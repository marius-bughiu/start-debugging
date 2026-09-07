---
title: "Cómo encontrar los manejadores async void que causan ANR en una app Android de .NET MAUI"
description: "Play Console te dice que tu tasa de ANR supera el 0.47% y te entrega una traza nativa llena de frames de libcoreclr.so. Así se pasa de esa traza inútil al manejador de eventos async void exacto que bloqueó el hilo principal, usando un printer de Looper, un envoltorio de SynchronizationContext que nombra la máquina de estados y dotnet-trace sobre dsrouter."
pubDate: 2026-09-07
template: how-to
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "maui"
  - "android"
  - "async"
  - "performance"
  - "how-to"
lang: "es"
translationOf: "2026/09/how-to-find-the-async-void-handlers-causing-anrs-in-a-dotnet-maui-android-app"
translatedBy: "claude"
translationDate: 2026-09-07
---

Respuesta corta: la traza de ANR que te da Google Play no va a nombrar tu método de C#, así que deja de leerla como si lo fuera a hacer. Enumera cada `async void` de la base de código con VSTHRD100, reduce la lista a los que están conectados a eventos de interfaz y luego instala dos cosas en una compilación Release: un `Android.Util.IPrinter` en el `Looper` principal que mida el tiempo de cada mensaje del hilo principal, y un envoltorio de `SynchronizationContext` que lea la máquina de estados asíncrona empaquetada en la continuación publicada para que la línea de registro diga `MainPage+<OnSyncClicked>d__7` en lugar de un Runnable anónimo. El primero detecta el trabajo hecho antes del primer `await`, el segundo el trabajo hecho después. Entre los dos obtienes un nombre de método.

Este artículo apunta a .NET 11 (`11.0.100-preview.7`, publicado el 2026-08-11, GA prevista para el 2026-11-10) con .NET MAUI 11 sobre `net11.0-android`, donde CoreCLR es el único runtime móvil. Todo lo de aquí funciona también en .NET 10 con Mono; las diferencias se señalan donde importan.

## Por qué `async void` aparece en los informes de ANR

`async void` no bloquea un hilo por sí mismo. Causa ANR de forma indirecta, a través de tres mecanismos que terminan todos en el mismo sitio.

**El prefijo síncrono se ejecuta en el hilo de quien llama.** Un método `async` no cede el control en la llave de apertura. Se ejecuta de corrido hasta llegar a un `await` sobre algo que todavía no se ha completado. En un manejador de clic sobre el hilo principal de Android, cada línea anterior a ese primer punto de suspensión real es trabajo del hilo principal, y la palabra clave `async` en la firma hace que parezca lo contrario.

```csharp
// MainPage.xaml.cs, .NET 11, net11.0-android, MAUI 11
private async void OnSyncClicked(object sender, EventArgs e)
{
    using var db = new SqliteConnection(_dbPath);   // opens the file, ~40 ms cold
    var orders = db.Query<Order>(
        "select * from Orders where Status = 0");    // 3-9 s on a 40k-row table
    await RenderAsync(orders);                       // the first real await, far too late
}
```

Cinco segundos de eso y el despachador de entrada de Android se rinde. El `await` de la última línea no te está haciendo ningún favor.

**Le quita a quien llama la posibilidad de esperar, así que alguien añade un bloqueo.** Como un método `async void` no devuelve nada que se pueda esperar, en cuanto una segunda porción de código necesita su resultado, el camino de menor resistencia es `.Result` o `.Wait()`. En un hilo con un `SynchronizationContext` que redirige las continuaciones hacia sí mismo, eso es el [interbloqueo asíncrono clásico](/es/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/), y en Android el hilo interbloqueado es justo el que Android está cronometrando.

```csharp
private async void OnRefreshClicked(object sender, EventArgs e)
{
    // The handler could not be awaited, so this got "fixed" by blocking.
    var settings = _settings.LoadAsync().Result;   // main thread parked, permanently
    await ReloadAsync(settings);
}
```

**Es reentrante.** Nada impide que un segundo toque inicie una segunda invocación mientras la primera está suspendida. Dos ejecuciones solapadas compiten por el mismo `SemaphoreSlim` o la misma `SQLiteConnection`, y esa contención aparece como un bloqueo del hilo principal que solo se reproduce con un doble toque rápido. Si quieres el tratamiento completo de cuándo la construcción es legítima, mira [async void vs async Task en C#: cuándo es correcto cada uno](/es/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/).

## Qué está midiendo Android en realidad

Conocer el presupuesto exacto te dice qué manejadores merecen investigación. Según la [documentación de ANR de Android](https://developer.android.com/topic/performance/anrs/diagnose-and-fix-anrs):

| Disparador | Tiempo límite |
| --- | --- |
| Despacho de entrada (toque, tecla) | 5 segundos |
| Broadcast receiver con `FLAG_RECEIVER_FOREGROUND` | 10 s en Android 13 y anteriores, 10-20 s en Android 14+ |
| Broadcast receiver con prioridad de segundo plano | 60 s en Android 13 y anteriores, 60-120 s en Android 14+ |
| `onCreate` / `onStartCommand` / `onBind` de un servicio en primer plano | 20 segundos |
| Servicio en segundo plano | 200 segundos |

El despacho de entrada es el que muerde a las apps de MAUI, y es el que ven los usuarios, porque por definición la app estaba en primer plano y la estaban tocando. Lo que está en juego lo fija Play: la tasa de ANR percibida por el usuario es una métrica esencial con un umbral de mal comportamiento del 0.47% global, evaluado sobre una ventana móvil de 28 días, y superarlo hace que tu app sea menos descubrible en todos los dispositivos ([requisitos de calidad técnica de Play Console](https://support.google.com/googleplay/android-developer/answer/17492799)).

## Por qué la traza que te da Play no basta

Extrae el registro del ANR y mira el hilo principal. En un dispositivo al que puedas conectarte:

```sh
# Everything in the device's dropbox, newest last
adb shell dumpsys dropbox --print data_app_anr | tail -300

# Or the full set, which is what you want for a device that has been running a while
adb bugreport anr.zip
unzip -o anr.zip -d anr && ls anr/FS/data/anr/
```

La cabecera te dice el disparador:

```
ANR in com.example.orders (com.example.orders/crc64e1fb321c08285b90.MainActivity)
PID: 14882
Reason: Input dispatching timed out (Waited 5003ms for MotionEvent)
```

La traza de pila del hilo principal, en cambio, la vuelca ART, que resuelve símbolos de frames de Java. Tu manejador no es un frame de Java. En una app Android sobre CoreCLR obtienes algo con esta forma:

```
"main" prio=5 tid=1 Native
  #00 pc 00000000000a1b3c  /apex/com.android.runtime/lib64/bionic/libc.so (syscall+28)
  #01 pc 00000000004f21d8  /data/app/.../lib/arm64/libcoreclr.so (???)
  #02 pc 00000000004e0a44  /data/app/.../lib/arm64/libcoreclr.so (???)
  at crc64e1fb321c08285b90.MainActivity.n_onCreate(Native method)
  at android.os.Handler.dispatchMessage(Handler.java:106)
  at android.os.Looper.loop(Looper.java:294)
```

Esa es toda la historia que obtienes: frames nativos sin nombre dentro de `libcoreclr.so` (`libmonosgen-2.0.so` si sigues en Mono bajo .NET 10). No es inútil. Clasifica el problema en uno de tres grupos:

- Frames parados en `syscall`, `futex_wait` o `pthread_cond_wait` bajo el runtime: el hilo principal está **bloqueado**, lo que significa un lock, un `.Result`, un `.Wait()` o un `SemaphoreSlim.Wait()`.
- Frames girando dentro de `libcoreclr.so` sin ninguna llamada al sistema encima: el hilo principal está **ejecutando código gestionado**, lo que significa trabajo limitado por CPU dentro de un manejador.
- `android.os.MessageQueue.nativePollOnce` arriba del todo: el hilo principal estaba **inactivo** cuando se tomó el volcado. El ANR está en otra parte, o el volcado llegó tarde. Android lo documenta explícitamente, y perseguir tus manejadores con esta firma es esfuerzo desperdiciado.

Hay una cuarta forma que conviene reconocer antes de empezar: una pila detenida dentro de `coreclr_initialize` justo después de un arranque en frío. Eso no es tu código, es la regresión de arranque de CoreCLR registrada en [dotnet/android#10588](https://github.com/dotnet/android/issues/10588), donde una app grande que arrancaba en un segundo con Mono puede tardar unos seis con CoreCLR y superar el presupuesto del sistema operativo. Esos casos se agrupan aparte en vitals bajo `handleBindApplication`. Si esa es tu forma, el arreglo es el trabajo de arranque que cubre [migrar una app Android de MAUI de Mono a CoreCLR](/es/2026/09/migrate-a-dotnet-maui-android-app-from-mono-to-coreclr-in-dotnet-11/), no el triaje de manejadores.

## El flujo de triaje en cinco pasos

1. **Enumera cada declaración y delegado `async void` de la solución.** Añade `Microsoft.VisualStudio.Threading.Analyzers` y convierte VSTHRD100 (métodos async void) y VSTHRD101 (delegados y lambdas async void) en advertencias de compilación. Esto te da el conjunto completo de candidatos en una sola compilación, incluidas las lambdas `async` asignadas a `EventHandler` que una búsqueda de texto no encuentra.
2. **Ordena los candidatos según si pueden ejecutarse en el hilo principal.** Solo los manejadores alcanzables desde un evento de interfaz, un callback de ciclo de vida `Loaded`/`Appearing` o el cuerpo de un `MainThread.BeginInvokeOnMainThread` pueden producir un ANR de despacho de entrada. Todo lo demás es un problema de corrección, no un ANR.
3. **Instrumenta el `Looper` principal en una compilación Release** para que cada mensaje del hilo principal que supere un umbral quede registrado con su duración. Esto detecta el prefijo síncrono, que nunca toca el `SynchronizationContext` y es por tanto invisible para el resto de técnicas de aquí.
4. **Envuelve el `SynchronizationContext` del hilo principal** para que las continuaciones lentas reanudadas registren el nombre de la máquina de estados asíncrona a la que pertenecen. Este es el paso que convierte una duración en un nombre de método.
5. **Confirma con `dotnet-trace` sobre `dotnet-dsrouter`** y lee el flame graph del hilo principal, para que el arreglo se mida en lugar de suponerse.

## Pasos 1 y 2: la pasada estática

```xml
<!-- MyApp.csproj, .NET 11 -->
<ItemGroup>
  <PackageReference Include="Microsoft.VisualStudio.Threading.Analyzers" Version="17.14.15">
    <PrivateAssets>all</PrivateAssets>
  </PackageReference>
</ItemGroup>
```

```ini
# .editorconfig
dotnet_diagnostic.VSTHRD100.severity = warning   # Avoid async void methods
dotnet_diagnostic.VSTHRD101.severity = warning   # Avoid unsupported async delegates
```

Luego vuelca la lista:

```sh
dotnet build -c Release -f net11.0-android -warnaserror:none \
  | grep -E 'VSTHRD10[01]' | sort -u
```

Espera ruido. VSTHRD100 también salta con manejadores de eventos legítimos, que es la queja de larga data en [microsoft/vs-threading#510](https://github.com/microsoft/vs-threading/issues/510): el analizador no tiene forma de saber que un método cuya firma es `(object, EventArgs)` está obligado a ser `void`. No lo silencies y sigas adelante. El objetivo del paso 1 es el inventario, y el paso 2 es donde lo filtras, a mano, hasta quedarte con los manejadores que pueden ejecutarse en el hilo principal. En una app MAUI de tamaño medio típica, una lista de 60 avisos VSTHRD100 se reduce a 8 o 10 candidatos reales.

`AsyncFixer03`, del paquete AsyncFixer, informa de la misma forma "dispara y olvida" si prefieres no añadir la dependencia de vs-threading. Cualquiera de los dos sirve; no ejecutes ambos, o triarás cada hallazgo dos veces.

## Paso 3: medir cada mensaje del hilo principal

`Looper.setMessageLogging` escribe una línea al inicio y al final de cada despacho de mensaje. Restar las marcas de tiempo te da la duración exacta de cada unidad de trabajo del hilo principal, incluido el prefijo síncrono de un manejador.

```csharp
// Platforms/Android/MainThreadWatchdog.cs, .NET 11, net11.0-android
using Android.OS;
using Android.Util;

sealed class MainThreadWatchdog(long thresholdMs) : Java.Lang.Object, IPrinter
{
    private long _startedAt;
    private string? _current;

    public void Println(string? message)
    {
        if (string.IsNullOrEmpty(message))
            return;

        // Looper emits ">>>>> Dispatching to <handler> <callback>: <what>"
        // then "<<<<< Finished to <handler> <callback>".
        if (message[0] == '>')
        {
            _current = message;
            _startedAt = SystemClock.UptimeMillis();
            return;
        }

        var elapsed = SystemClock.UptimeMillis() - _startedAt;
        if (elapsed >= thresholdMs)
            Log.Warn("anr-hunt", $"main thread busy {elapsed} ms: {_current}");
        _current = null;
    }
}
```

Instálalo pronto, y solo en una compilación que pienses tirar a la basura:

```csharp
// Platforms/Android/MainActivity.cs
protected override void OnCreate(Bundle? savedInstanceState)
{
    base.OnCreate(savedInstanceState);
#if ANR_HUNT
    Looper.MainLooper!.SetMessageLogging(new MainThreadWatchdog(thresholdMs: 300));
#endif
}
```

Luego obsérvalo bajo uso real:

```sh
adb logcat -s anr-hunt:W
```

Un umbral de 300 ms es agresivo a propósito. Un ANR de despacho de entrada necesita 5000 ms, pero un manejador que cuesta 400 ms en tu teléfono de desarrollo costará varios segundos en un dispositivo de hace cuatro años con la caché de páginas fría, y esos dispositivos son de donde sale tu número de vitals.

Lo que esto te da es una duración y una cadena con el destino del Looper. Lo que no te da es un nombre de método de C#: una continuación publicada por el runtime llega como un envoltorio genérico `Java.Lang.IRunnable`, así que el campo `<callback>` se lee como un tipo opaco `crc64...`. Para eso está el paso 4.

## Paso 4: nombrar la máquina de estados

`Task` publica sus continuaciones a través de `SynchronizationContext.Post`, y en el hilo principal de Android ese contexto es el que las redirige al `Handler` principal. Envuélvelo y podrás inspeccionar el estado publicado antes de pasarlo adelante.

La sutileza es que el delegado `SendOrPostCallback` no es tu método. El runtime usa un único callback estático compartido y pasa la continuación real en `state`, como una `Action` cuyo destino es la máquina de estados asíncrona empaquetada. Ese paquete es un tipo genérico cuyo argumento de tipo es la estructura generada por el compilador para tu método, y su nombre contiene el nombre del método original.

```csharp
// Platforms/Android/AnrHuntingSyncContext.cs, .NET 11
using System.Diagnostics;
using Android.Util;

sealed class AnrHuntingSyncContext(SynchronizationContext inner, long thresholdMs)
    : SynchronizationContext
{
    public override void Post(SendOrPostCallback d, object? state)
    {
        var origin = Describe(d, state);
        inner.Post(_ =>
        {
            var sw = Stopwatch.StartNew();
            d(state);
            if (sw.ElapsedMilliseconds >= thresholdMs)
                Log.Warn("anr-hunt", $"continuation {sw.ElapsedMilliseconds} ms: {origin}");
        }, null);
    }

    public override SynchronizationContext CreateCopy() =>
        new AnrHuntingSyncContext(inner.CreateCopy(), thresholdMs);

    // Best effort. Reads the boxed state machine the runtime passes as `state`;
    // this is an implementation detail, so fall back to the delegate's method.
    private static string Describe(SendOrPostCallback d, object? state)
    {
        if (state is Action a && a.Target is { } box)
        {
            var t = box.GetType();
            if (t.IsGenericType)
                // AsyncStateMachineBox`1[MyApp.MainPage+<OnSyncClicked>d__7]
                return t.GetGenericArguments()[0].FullName ?? t.Name;
            return t.FullName ?? t.Name;
        }
        return $"{d.Method.DeclaringType?.FullName}.{d.Method.Name}";
    }
}
```

Instálalo en el hilo principal, después de que MAUI haya montado su propio contexto:

```csharp
// Platforms/Android/MainActivity.cs
protected override void OnCreate(Bundle? savedInstanceState)
{
    base.OnCreate(savedInstanceState);
#if ANR_HUNT
    Looper.MainLooper!.SetMessageLogging(new MainThreadWatchdog(300));
    SynchronizationContext.SetSynchronizationContext(
        new AnrHuntingSyncContext(SynchronizationContext.Current!, thresholdMs: 300));
#endif
}
```

La línea de registro que buscas tiene este aspecto, y es el objetivo de todo el ejercicio:

```
W anr-hunt: continuation 4412 ms: MyApp.MainPage+<OnSyncClicked>d__7
```

Tres restricciones, todas importantes:

- Solo pasan por el envoltorio las continuaciones cuyo `await` capturó el contexto **después** de instalarlo. Instálalo en `OnCreate`, antes de que se construya la primera página.
- `MainThread.BeginInvokeOnMainThread` y el `IDispatcher` de MAUI publican directamente en el `Handler` de Android, no a través del `SynchronizationContext`, así que evitan por completo este envoltorio. El printer del Looper del paso 3 sí los ve, y por eso ejecutas ambos.
- El código que espera con [`ConfigureAwait(false)`](/es/2026/05/configureawait-false-vs-default-in-dotnet-11/) no captura el contexto en absoluto, y su continuación es correctamente invisible aquí. Ese es el comportamiento que quieres: no se está reanudando en el hilo principal.

## Paso 5: confirmar con `dotnet-trace`

Cuando ya tengas un sospechoso, mídelo. Bajo CoreCLR en .NET 11 el componente de diagnóstico está integrado en el runtime, así que no hace falta `EnableDiagnostics` (en .NET 10 con Mono sí, y añade `libmono-component-diagnostics_tracing.so` al paquete).

```sh
# .NET 11, dotnet-trace and dotnet-dsrouter 9.0.652701 or newer
dotnet tool install -g dotnet-trace
dotnet tool install -g dotnet-dsrouter

# Physical Android device. Use 10.0.2.2 instead of 127.0.0.1 on an emulator.
dotnet build -t:Run -c Release -f net11.0-android \
  -p:DiagnosticAddress=127.0.0.1 -p:DiagnosticPort=9000 \
  -p:DiagnosticSuspend=false -p:DiagnosticListenMode=connect

dotnet-trace collect --dsrouter android --format speedscope
```

Navega hasta la pantalla, pulsa el botón, presiona Enter para parar y abre el `.speedscope.json` en [speedscope.app](https://speedscope.app/). Selecciona el hilo principal, cambia a la vista sandwich y ordena por tiempo propio. El frame que buscas es `MainPage.OnSyncClicked` con un bloque ancho y contiguo, y justo debajo lo que realmente está costando el tiempo.

Perfila únicamente compilaciones `Release`. Las compilaciones Debug en Android se ejecutan bajo el intérprete (`UseInterpreter=true`) para hot reload, y los tiempos que salen de ahí son ficción.

## Los arreglos, en el orden en que deberías probarlos

Una vez identificado el manejador, la reparación es casi siempre una de cuatro cosas.

**Convierte el manejador en una envoltura fina sobre un método que devuelve `Task`.** La firma del evento obliga a `void`, pero nada obliga a que el cuerpo sea largo.

```csharp
// The only line allowed to be async void.
private void OnSyncClicked(object sender, EventArgs e) => _ = SyncAsync();

private async Task SyncAsync()
{
    _syncButton.IsEnabled = false;                    // re-entrancy guard
    try
    {
        var orders = await Task.Run(() => _repo.LoadPendingOrders());
        await RenderAsync(orders);
    }
    catch (Exception ex)
    {
        _logger.LogError(ex, "sync failed");           // an async void body cannot do this
    }
    finally
    {
        _syncButton.IsEnabled = true;
    }
}
```

**Empuja el prefijo síncrono al thread pool.** `Task.Run` es la herramienta correcta aquí precisamente porque el trabajo está limitado por CPU o por IO bloqueante y ahora mismo corre en el hilo de interfaz. Ese es el caso para el que existe `Task.Run`.

**Elimina la llamada bloqueante.** Si el manejador contiene `.Result`, `.Wait()` o `GetAwaiter().GetResult()`, nada de la instrumentación anterior importa hasta que eso desaparezca. La versión mecánica está cubierta en [migrar de llamadas bloqueantes .Result/.Wait() a async en toda la cadena](/es/2026/07/migrate-from-blocking-result-and-wait-calls-to-async-all-the-way-up-in-csharp/).

**Enlaza a un comando en lugar de a un evento.** `AsyncRelayCommand` del MVVM Community Toolkit devuelve una `Task` que el framework observa, lo que elimina el `async void` de tu código por completo y te da `IsRunning` gratis como guarda de reentrancia.

## Trampas que te cuestan una tarde

**Un descarte `_ =` de dispara y olvida sigue tragándose las excepciones.** La envoltura de arriba registra dentro de `SyncAsync`, que es lo que la hace segura. Un `_ = SomethingAsync()` pelado sin un `try` dentro tiene el mismo riesgo de excepción no observada que `async void`, solo que más silencioso, y el compilador no avisará porque el descarte suprime [CS4014](/es/2026/07/fix-cs4014-because-this-call-is-not-awaited-execution-continues-in-csharp/).

**`StrictMode` no encontrará esto.** `StrictMode.ThreadPolicy` con `DetectAll()` detecta accesos a disco y red en el hilo principal, lo cual es una comprobación adyacente útil, pero es ciego al trabajo gestionado limitado por CPU y a un hilo bloqueado en un lock gestionado. Ambos son causas de ANR.

**Puede que tu grupo de ANR no sea un manejador en absoluto.** Comprueba el frame superior del grupo en vitals antes de dedicarle un día a esto. `handleBindApplication` significa arranque lento. `nativePollOnce` significa que el hilo principal estaba inactivo. Solo las formas ocupada o bloqueada apuntan a un manejador.

**No envíes la instrumentación a ninguna parte.** El printer del `Looper` asigna una cadena por mensaje y el envoltorio de `SynchronizationContext` añade un `Stopwatch` y un closure por continuación publicada. Ambos son lo bastante baratos para dejarlos activos durante una sesión de depuración sobre una compilación Release, y ambos son inaceptables en producción. Enciérralos tras una constante definida por MSBuild (`<DefineConstants>$(DefineConstants);ANR_HUNT</DefineConstants>` en una configuración de compilación dedicada) para que el código no pueda llegar a la Play Store por accidente.

**Vigila el nivel de API.** Los presupuestos de los broadcast receiver se estrecharon en Android 14, y un receptor que estaba cómodamente por debajo de 10 segundos ahora puede verse empujado a la ventana de 10-20 segundos bajo presión de CPU. Si acabas de cambiar el target, contrasta con [qué cambia en el nivel de API 36](/es/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/).

El patrón detrás de todo esto es que `async void` no es el error. Es la construcción que hace el error invisible: elimina el valor de retorno que habría permitido a quien llama esperar, la ruta de excepción que te habría dicho que falló y la advertencia del compilador que lo habría señalado. Nombrar la máquina de estados es cómo recuperas esa visibilidad.

## Relacionado

- [async void vs async Task en C#: cuándo es correcto cada uno](/es/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)
- [Solución: interbloqueo al llamar a .Result o .Wait() sobre un método async en C#](/es/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/)
- [Migra una app Android de .NET MAUI de Mono a CoreCLR en .NET 11](/es/2026/09/migrate-a-dotnet-maui-android-app-from-mono-to-coreclr-in-dotnet-11/)
- [ConfigureAwait(false) vs el valor por defecto en .NET 11: ¿sigue importando?](/es/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- [Migrar de llamadas bloqueantes .Result/.Wait() a async en toda la cadena en una base de código C# heredada](/es/2026/07/migrate-from-blocking-result-and-wait-calls-to-async-all-the-way-up-in-csharp/)

## Fuentes

- [Diagnose and fix ANRs, Android Developers](https://developer.android.com/topic/performance/anrs/diagnose-and-fix-anrs)
- [ANRs, documentación de calidad de apps de Android](https://developer.android.com/topic/performance/vitals/anr)
- [Requisitos de calidad técnica de Play Console](https://support.google.com/googleplay/android-developer/answer/17492799)
- [Análisis de rendimiento en .NET MAUI, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/maui/fundamentals/profiling)
- [Documentación de dotnet-dsrouter, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-dsrouter)
- [Tracing .NET for Android applications, dotnet/android](https://github.com/dotnet/android/blob/main/Documentation/guides/tracing.md)
- [Documentación de los analizadores VSTHRD100 y VSTHRD101, microsoft/vs-threading](https://github.com/microsoft/vs-threading/blob/main/docfx/analyzers/index.md)
- [Falso positivo de VSTHRD100 en manejadores de eventos, microsoft/vs-threading#510](https://github.com/microsoft/vs-threading/issues/510)
- [CoreCLR ANR while running large app, dotnet/android#10588](https://github.com/dotnet/android/issues/10588)
- [Capturar y leer informes de errores, documentación de Android Studio](https://developer.android.com/studio/debug/bug-report)
