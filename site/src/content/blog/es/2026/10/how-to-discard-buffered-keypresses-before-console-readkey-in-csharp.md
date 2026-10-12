---
title: "Cómo descartar las pulsaciones de teclas en búfer antes de Console.ReadKey en un bucle de juego de consola en C#"
description: "Vacía el búfer de entrada de la consola con while (Console.KeyAvailable) Console.ReadKey(true) antes de esperar una tecla nueva, y vacíalo en cada fotograma de un bucle de juego para que la repetición de teclas no se acumule. Cómo funciona el búfer en Windows y Unix en .NET 10, por qué las teclas mantenidas generan retraso, la trampa del eco en Unix y FlushConsoleInputBuffer."
pubDate: 2026-10-12
template: how-to
tags:
  - "csharp"
  - "dotnet-10"
  - "console"
  - "how-to"
lang: "es"
translationOf: "2026/10/how-to-discard-buffered-keypresses-before-console-readkey-in-csharp"
translatedBy: "claude"
translationDate: 2026-10-12
---

**Respuesta corta:** en .NET no existe `Console.ClearInputBuffer()`, así que lo vacías tú mismo: `while (Console.KeyAvailable) Console.ReadKey(intercept: true);`. Ponlo justo antes de cualquier `ReadKey` de tipo "pulsa una tecla para continuar", para que las teclas escritas durante una escena o una pausa de carga no se salten el mensaje. En un bucle de juego, ejecuta el mismo vaciado una vez por fotograma y actúa sobre la última tecla (o sobre cada tecla que te interese) en lugar de leer una tecla por fotograma; de lo contrario, la repetición automática de una tecla mantenida se acumula en la cola y el jugador sigue moviéndose después de soltarla. Protégelo con `Console.IsInputRedirected`, porque tanto `KeyAvailable` como `ReadKey` lanzan `InvalidOperationException` cuando stdin es una tubería o un archivo.

Todo lo que sigue se ejecutó en .NET 10 (SDK 10.0.302, runtime 10.0.10) en macOS, manejando la aplicación a través de un pseudoterminal real para que las pulsaciones sigan la misma ruta que si las escribiera una persona. El comportamiento en Windows se describe a partir del código fuente de `System.Console` en la [etiqueta `v10.0.0`](https://github.com/dotnet/runtime/tree/v10.0.0/src/libraries/System.Console/src/System); el código relevante (`KeyAvailable`, `ReadKey` y la configuración nativa del terminal en Unix) no ha cambiado en `main`, así que la misma respuesta aplica a los release candidates de .NET 11.

## Dónde viven realmente las teclas "en búfer"

Una pulsación no va directamente a tu llamada a `ReadKey`. El sistema operativo la pone en cola y ahí se queda hasta que alguien la lee, sin importar lo que hiciera tu programa cuando se pulsó la tecla. Por eso un jugador que machaca Enter durante una "intro" con `Thread.Sleep` de dos segundos se salta los tres mensajes siguientes.

La cola está en un lugar distinto en cada plataforma, lo que importa para elegir el vaciado correcto:

- **Windows.** El host de la consola mantiene una cola de estructuras `INPUT_RECORD`: eventos de tecla presionada y liberada, eventos de ratón, eventos de cambio de tamaño de ventana y eventos de foco. `Console.KeyAvailable` llama a `PeekConsoleInput` y, si el registro al frente de la cola no es un evento de tecla presionada que `ReadKey` devolvería, lo lee, lo descarta y vuelve a mirar. `Console.ReadKey` llama a `ReadConsoleInput` en el mismo bucle. Un detalle adicional: si un registro de tecla trae un contador de repetición mayor que 1, .NET lo guarda en un campo estático privado (`_cachedInputRecord`) y entrega un `ConsoleKeyInfo` por cada repetición desde esa caché.
- **Linux y macOS.** Los bytes llegan al descriptor de archivo del terminal. El `StdInReader` de .NET los lee en bloques hacia su propio búfer `char[]` y analiza las secuencias de escape (`ESC [ A` para la flecha arriba, etc.) para convertirlas en valores `ConsoleKeyInfo`. `Console.KeyAvailable` devuelve `true` si ese búfer administrado aún contiene caracteres sin analizar, o si `poll()` sobre stdin indica que el kernel tiene más bytes esperando.

Es decir, en ambas plataformas hay una capa que pertenece al sistema operativo y otra que pertenece a .NET. Un vaciado que solo limpia la capa del sistema operativo puede dejar teclas en la capa de .NET. Vaciar mediante `ReadKey` limpia ambas, y por eso es la respuesta portable.

## Un ejemplo mínimo de cómo el type-ahead se salta un mensaje

```csharp
// .NET 10, C# 14 -- save as typeahead.cs and run with: dotnet run typeahead.cs
Console.WriteLine("Loading level (type some keys now)...");
Thread.Sleep(3000);                       // stands in for a cutscene, a save, a slow load

Console.WriteLine("Press any key to start.");
var key = Console.ReadKey(intercept: true);
Console.WriteLine($"Started by: {key.Key}");
```

Escribe `abc` y una tecla de flecha durante la pausa de tres segundos. El programa imprime "Press any key to start." e inmediatamente informa `Started by: A`, porque la primera tecla en búfer satisfizo `ReadKey` antes de que el mensaje siquiera fuera visible. Si usas esto como aplicación basada en archivo, el [recorrido de `dotnet run file.cs`](/es/2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11/) explica cómo se compilan y almacenan en caché esos programas de un solo archivo.

## La solución portable: vaciar con KeyAvailable y ReadKey

1. Comprueba `Console.IsInputRedirected` y omite el vaciado cuando sea `true`.
2. Haz un bucle `while (Console.KeyAvailable)` y llama a `Console.ReadKey(intercept: true)` dentro, descartando el resultado.
3. Solo entonces muestra el mensaje y llama a `ReadKey` para obtener la tecla que realmente quieres.

```csharp
// .NET 10, C# 14
static class ConsoleInput
{
    /// <summary>Discards every key that is already waiting. Returns how many were dropped.</summary>
    public static int DiscardPendingKeys()
    {
        if (Console.IsInputRedirected) return 0;

        int discarded = 0;
        while (Console.KeyAvailable)
        {
            Console.ReadKey(intercept: true);
            discarded++;
        }
        return discarded;
    }

    /// <summary>Waits for a key pressed after this call, ignoring type-ahead.</summary>
    public static ConsoleKeyInfo ReadFreshKey(bool intercept = true)
    {
        DiscardPendingKeys();
        return Console.ReadKey(intercept);
    }
}
```

El mensaje del ejemplo queda así:

```csharp
// .NET 10, C# 14
Console.WriteLine("Press any key to start.");
var key = ConsoleInput.ReadFreshKey();
Console.WriteLine($"Started by: {key.Key}");
```

Verifiqué el vaciado con esta sonda, enviando `abc`, flecha arriba y flecha abajo a un pseudoterminal durante el sleep y una `z` unos segundos después:

```csharp
// .NET 10, C# 14
Console.WriteLine("busy for 3s, type ahead now...");
Thread.Sleep(3000);
int discarded = 0;
while (Console.KeyAvailable)
{
    var k = Console.ReadKey(intercept: true);
    discarded++;
    Console.WriteLine($"discarded: Key={k.Key} Char={(int)k.KeyChar}");
}
Console.WriteLine($"discarded {discarded} keys; press a key");
var key = Console.ReadKey(intercept: true);
Console.WriteLine($"got: {key.Key}");
```

```text
discarded: Key=A Char=97
discarded: Key=B Char=98
discarded: Key=C Char=99
discarded: Key=UpArrow Char=0
discarded: Key=DownArrow Char=0
discarded 5 keys; press a key
got: Z
```

Dos detalles que vale la pena notar. Las teclas de flecha salieron como un `ConsoleKeyInfo` cada una, no como tres caracteres sueltos, porque `ReadKey` ejecuta el analizador de secuencias de escape. Un vaciado a nivel de bytes (leer stdin en bruto o llamar a `tcflush`) puede cortar una secuencia de escape por la mitad y dejar `[A` para que se lea como dos teclas imprimibles. Y `intercept: true` importa: con `false`, cada tecla descartada se muestra en pantalla, que es justo la basura que querías ocultar.

## Por qué las teclas mantenidas siguen moviendo al jugador tras soltarlas

El mismo búfer causa problemas en un bucle en tiempo real, solo que de forma más sutil. Cuando un jugador mantiene pulsada una flecha, el terminal o el host de la consola generan eventos de repetición automática, comúnmente unos 30 por segundo tras un retraso inicial. Un bucle típico de principiante lee como máximo una tecla por fotograma:

```csharp
// .NET 10, C# 14 -- one key per frame: input lags behind
while (running)
{
    if (Console.KeyAvailable)
        Handle(Console.ReadKey(intercept: true).Key);

    Update();
    Draw();
    Thread.Sleep(100);   // ~10 fps
}
```

Si las teclas llegan más rápido que los fotogramas, la cola crece mientras la tecla se mantiene y luego se vacía a razón de una tecla por fotograma tras soltarla. Lo medí: un bucle a 10 fotogramas por segundo, alimentado con 30 secuencias de flecha derecha separadas 33 ms (un segundo de repetición automática simulada, comenzando aproximadamente un segundo después del arranque).

```csharp
// .NET 10, C# 14
bool drainAll = args.Length > 0 && args[0] == "drain";
_ = Console.KeyAvailable;
var sw = System.Diagnostics.Stopwatch.StartNew();
int x = 0; long lastMove = 0;
while (sw.ElapsedMilliseconds < 4000)
{
    if (drainAll)
    {
        ConsoleKey? last = null;
        while (Console.KeyAvailable) last = Console.ReadKey(intercept: true).Key;
        if (last == ConsoleKey.RightArrow) { x++; lastMove = sw.ElapsedMilliseconds; }
    }
    else if (Console.KeyAvailable)
    {
        if (Console.ReadKey(intercept: true).Key == ConsoleKey.RightArrow) { x++; lastMove = sw.ElapsedMilliseconds; }
    }
    Thread.Sleep(100); // 10 fps
}
Console.WriteLine($"{(drainAll ? "drain" : "one-per-frame")}: x={x}, last move at {lastMove} ms");
```

```text
one-per-frame: x=30, last move at 3739 ms
drain: x=13, last move at 2268 ms
```

Con una tecla por fotograma, el jugador se movió 30 celdas y seguía moviéndose cerca de 1,5 segundos después de que la tecla fuera "soltada". Con un vaciado completo por fotograma, el movimiento se detuvo dentro de un fotograma tras la última repetición. La versión con vaciado mueve una celda por fotograma mientras la tecla se mantiene, que es lo que normalmente quiere un juego: velocidad atada a la tasa de fotogramas, no a la tasa de repetición del sistema operativo.

El patrón general es vaciar en cada fotograma hacia un pequeño estado de entrada por fotograma, y luego dejar que `Update` lea ese estado:

```csharp
// .NET 10, C# 14
sealed class FrameInput
{
    private readonly HashSet<ConsoleKey> _pressed = new();

    public bool WasPressed(ConsoleKey key) => _pressed.Contains(key);

    public void Poll()
    {
        _pressed.Clear();
        if (Console.IsInputRedirected) return;

        while (Console.KeyAvailable)
            _pressed.Add(Console.ReadKey(intercept: true).Key);
    }
}

// game loop
var input = new FrameInput();
while (running)
{
    input.Poll();
    if (input.WasPressed(ConsoleKey.Escape)) break;
    if (input.WasPressed(ConsoleKey.LeftArrow))  player.X--;
    if (input.WasPressed(ConsoleKey.RightArrow)) player.X++;
    if (input.WasPressed(ConsoleKey.Spacebar))   player.Jump();

    Draw();
    Thread.Sleep(16);
}
```

Usar un conjunto en lugar de "gana la última tecla" significa que un salto pulsado en el mismo fotograma que un cambio de dirección no se pierde. Si necesitas modificadores, guarda el `ConsoleKeyInfo` completo o un par `(ConsoleKey, ConsoleModifiers)`.

Lo que la consola no puede decirte es si una tecla está *mantenida en este momento*. `ReadKey` solo expone eventos de tecla presionada (en Windows se omiten los registros de tecla liberada, salvo una liberación de Alt que lleve un carácter compuesto, y también las pulsaciones de Shift, Ctrl y Alt por sí solas; en Unix, los terminales no envían la liberación de tecla en absoluto). "Mantenida" en un juego de consola se infiere de la llegada de eventos de repetición, por lo que siempre existe el retraso de repetición inicial del sistema operativo antes de que empiece el movimiento continuo. Si necesitas el estado real de las teclas en Windows, `GetAsyncKeyState` mediante P/Invoke es la salida habitual, y a ese punto vale la pena considerar un framework de juegos de verdad.

## La trampa del eco en Unix: el type-ahead aparece en pantalla

En Linux y macOS hay un segundo síntoma que el vaciado no corrige. En mi primera sonda, la salida realmente se veía así:

```text
busy for 3s, type ahead now...
abc^[[A^[[Bdiscarded: Key=A Char=97
```

Las teclas se descartaron correctamente, pero el terminal ya las había mostrado mientras el programa dormía. La razón está en `pal_console.c`: .NET cambia el terminal a modo no canónico y sin eco (`ECHO`, `ICANON` e `IEXTEN` desactivados) la primera vez que haces una *lectura* de consola, y eso incluye `Console.KeyAvailable`, que llama a `SystemNative_StdinReady`. Antes de esa primera lectura, el terminal sigue en su modo cocinado por defecto y muestra todo. Una vez configurado, .NET deja el terminal en ese modo hasta que el proceso termina, momento en que restaura los ajustes originales.

La solución es tocar el lado de entrada una vez al inicio:

```csharp
// .NET 10, C# 14 -- first line of Main, before any long-running work
if (!Console.IsInputRedirected)
    _ = Console.KeyAvailable;   // puts the terminal in no-echo, non-canonical mode
```

Con esa línea al principio, la misma pausa de tres segundos con teclas escritas produjo una salida limpia: las teclas permanecieron en el búfer, no se mostró nada y el vaciado posterior las eliminó. En Windows esto no es un problema, porque el type-ahead de una aplicación de consola queda como registros de entrada y no se muestra hasta que algo lo lee en modo de línea.

## Solo en Windows: FlushConsoleInputBuffer

Win32 tiene una llamada directa, [`FlushConsoleInputBuffer`](https://learn.microsoft.com/en-us/windows/console/flushconsoleinputbuffer), que vacía la cola de registros de entrada de la consola de un solo golpe. Resulta tentadora porque es O(1) y además limpia los registros de ratón y de cambio de tamaño:

```csharp
// .NET 10, C# 14 -- needs <AllowUnsafeBlocks>true</AllowUnsafeBlocks> for LibraryImport
using System.Runtime.InteropServices;

static partial class WinConsole
{
    private const int StdInputHandle = -10;

    [LibraryImport("kernel32.dll", SetLastError = true)]
    private static partial nint GetStdHandle(int nStdHandle);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool FlushConsoleInputBuffer(nint hConsoleInput);

    public static bool TryFlush()
    {
        if (!OperatingSystem.IsWindows() || Console.IsInputRedirected) return false;
        return FlushConsoleInputBuffer(GetStdHandle(StdInputHandle));
    }
}
```

Compilé esto en .NET 10 (como aplicación basada en archivo con `#:property AllowUnsafeBlocks=true`), pero solo pude ejecutarlo en macOS, donde `TryFlush` devuelve `false` sin llamar a `kernel32`. Aun así, llamaría al vaciado administrado después, por una razón visible en el código fuente: `FlushConsoleInputBuffer` no puede alcanzar el `_cachedInputRecord` privado de .NET. Si el último registro que sacó `ReadKey` tenía un contador de repetición superior a 1, las repeticiones restantes se sirven desde ese campo, y `KeyAvailable` devuelve `true` para ellas antes incluso de consultar a la consola. `DiscardPendingKeys()` también vacía esa caché. Si eres nuevo con `LibraryImport` y el marshalling generado por código fuente, el [artículo sobre Polars.NET](/es/2026/02/dotnet-polarsnet-rust-dataframe-engine-with-libraryimport/) lo recorre paso a paso, y el [artículo sobre los eventos de bloqueo y desbloqueo de sesión de Windows](/es/2026/10/how-to-detect-windows-session-lock-unlock-logon-and-logoff-events-in-csharp/) usa el mismo patrón de `LibraryImport` contra `wtsapi32.dll`, incluida la configuración de `AllowUnsafeBlocks`.

## Casos límite y trampas

**La entrada redirigida lanza excepciones.** Con stdin canalizado (`echo abc | dotnet run game.cs`), ambas llamadas lanzan excepciones. Los mensajes exactos de .NET 10:

```text
KeyAvailable threw InvalidOperationException: Cannot see if a key has been pressed when either application does not have a console or when console input has been redirected from a file. Try Console.In.Peek.
ReadKey threw InvalidOperationException: Cannot read keys when either application does not have a console or when console input has been redirected. Try Console.Read.
```

Eso te afecta en CI, en ejecuciones de `dotnet test` que ejercitan el código de consola y en algunas consolas de "ejecutar" de los IDE que redirigen stdin. Todos los helpers anteriores retornan pronto con `Console.IsInputRedirected`.

**No vacíes con Console.In.** `Console.In.Read()` y `Console.In.Peek()` están orientados a líneas en Unix: leen una línea completa hacia una pila separada dentro de `StdInReader` antes de retornar, así que se bloquean hasta Enter y llevan las teclas a un lugar que `KeyAvailable` no revisa. Mezclar `ReadLine` y `ReadKey` en un mismo programa está bien; vaciar con la API de `TextReader` no.

**Un vaciado no es un antirrebote.** Si el usuario pulsa una tecla 5 ms después de tu vaciado, es una tecla nueva y `ReadKey` la devolverá. Eso es correcto, pero si te preocupan las pulsaciones dobles accidentales en un menú, agrega una pequeña espera antes del vaciado, por ejemplo `Thread.Sleep(150)` justo después de la acción que disparó el mensaje.

**No hagas espera activa sobre KeyAvailable.** `while (!Console.KeyAvailable) { }` consume un núcleo completo. En un bucle de fotogramas, duerme o espera al siguiente fotograma. Si quieres "esperar una tecla, pero rendirte tras N segundos", sondea `KeyAvailable` con un `Task.Delay` corto y un plazo, o envuélvelo en un token de [`CancellationTokenSource.CancelAfter`](/es/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/). `Console.ReadKey` en sí no se puede cancelar una vez que está bloqueado, así que la única forma de rendirse es no llamarlo hasta que `KeyAvailable` indique que hay algo que leer. Pasa el token por la cadena de llamadas igual que harías con cualquier [método asíncrono que deba respetar la cancelación](/es/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/).

**Ctrl+C no es una tecla por defecto.** A menos que establezcas `Console.TreatControlCAsInput = true`, Ctrl+C dispara `Console.CancelKeyPress` y nunca entra al búfer, así que un vaciado ni lo ve ni lo traga. Si lo estableces en `true` para un juego, recuerda que tu vaciado ahora se tragará en silencio un Ctrl+C pulsado durante una pausa.

**Lecturas desde varios hilos.** En Windows, `ReadKey` toma un bloqueo; en Unix, `KeyAvailable` y `ReadKey` pasan por un lector sincronizado. Eso los hace seguros de llamar desde hilos distintos, pero no tiene sentido: un hilo de entrada en segundo plano y un vaciado en el hilo principal se robarán teclas mutuamente. Elige un hilo que sea dueño de la entrada de la consola.

### Sigue leyendo

- [Cómo ejecutar una aplicación C# basada en archivo con dotnet run en .NET 11](/es/2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11/)
- [Cómo aplicar un tiempo de espera a una operación asíncrona con CancellationTokenSource.CancelAfter en C#](/es/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/)
- [Cómo propagar un CancellationToken a través de métodos asíncronos en .NET 11](/es/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/)
- [Cómo detectar los eventos de bloqueo, desbloqueo, inicio y cierre de sesión de Windows en una aplicación C#](/es/2026/10/how-to-detect-windows-session-lock-unlock-logon-and-logoff-events-in-csharp/)

## Fuentes

- [Propiedad `Console.KeyAvailable`](https://learn.microsoft.com/en-us/dotnet/api/system.console.keyavailable), Microsoft Learn.
- [Método `Console.ReadKey`](https://learn.microsoft.com/en-us/dotnet/api/system.console.readkey), Microsoft Learn.
- [Función `FlushConsoleInputBuffer`](https://learn.microsoft.com/en-us/windows/console/flushconsoleinputbuffer), documentación de la consola de Windows.
- [`ConsolePal.Windows.cs`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Console/src/System/ConsolePal.Windows.cs) en `v10.0.0` (`KeyAvailable`, `ReadKey`, `_cachedInputRecord`).
- [`StdInReader.cs`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Console/src/System/IO/StdInReader.cs) y [`SyncTextReader.Unix.cs`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Console/src/System/IO/SyncTextReader.Unix.cs) en `v10.0.0` (almacenamiento en búfer en Unix y `KeyAvailable`).
- [`pal_console.c`](https://github.com/dotnet/runtime/blob/v10.0.0/src/native/libs/System.Native/pal_console.c) en `v10.0.0` (eco del terminal y modo canónico).
