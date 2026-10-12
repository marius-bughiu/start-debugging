---
title: "How to discard buffered keypresses before Console.ReadKey in a C# console game loop"
description: "Drain the console input buffer with while (Console.KeyAvailable) Console.ReadKey(true) before you wait for a fresh key, and drain it every frame in a game loop so key repeat cannot pile up. How the buffer works on Windows and Unix in .NET 10, why held keys lag, the Unix echo trap, and FlushConsoleInputBuffer."
pubDate: 2026-10-12
template: how-to
tags:
  - "csharp"
  - "dotnet-10"
  - "console"
  - "how-to"
---

**Short answer:** there is no `Console.ClearInputBuffer()` in .NET, so you drain it yourself: `while (Console.KeyAvailable) Console.ReadKey(intercept: true);`. Put that right before any "press a key to continue" `ReadKey` so keys typed during a cutscene or a loading pause do not skip the prompt. In a game loop, run the same drain once per frame and act on the last key (or on every key you care about) instead of reading one key per frame, otherwise held-key auto-repeat queues up and the player keeps moving after they let go. Guard it with `Console.IsInputRedirected`, because both `KeyAvailable` and `ReadKey` throw `InvalidOperationException` when stdin is a pipe or file.

Everything below was run on .NET 10 (SDK 10.0.302, runtime 10.0.10) on macOS, driving the app through a real pseudo-terminal so the keystrokes go through the same path as a human typing. The Windows behaviour is described from the `System.Console` source at the [`v10.0.0` tag](https://github.com/dotnet/runtime/tree/v10.0.0/src/libraries/System.Console/src/System); the relevant code (`KeyAvailable`, `ReadKey`, and the native terminal setup on Unix) is unchanged on `main`, so the same answer applies to the .NET 11 release candidates.

## Where the "buffered" keys actually live

A keypress does not go straight to your `ReadKey` call. It is queued by the operating system and sits there until someone reads it, no matter what your program was doing when the key went down. That is why a player who mashes Enter during a two-second `Thread.Sleep` "intro" skips the next three prompts.

The queue is in a different place on each platform, which matters for picking the right flush:

- **Windows.** The console host keeps a queue of `INPUT_RECORD` structures: key-down and key-up events, mouse events, window resize events, focus events. `Console.KeyAvailable` calls `PeekConsoleInput`, and if the record at the head is not a key-down event that `ReadKey` would return, it reads and throws it away, then looks again. `Console.ReadKey` calls `ReadConsoleInput` in the same loop. One extra detail: if a key record carries a repeat count greater than 1, .NET caches it in a private static field (`_cachedInputRecord`) and hands out one `ConsoleKeyInfo` per repeat from that cache.
- **Linux and macOS.** Bytes arrive on the terminal's file descriptor. .NET's `StdInReader` reads them in chunks into its own `char[]` buffer and parses escape sequences (`ESC [ A` for the up arrow and so on) into `ConsoleKeyInfo` values. `Console.KeyAvailable` returns `true` if that managed buffer still holds unparsed characters, or if `poll()` on stdin says the kernel has more bytes waiting.

So on both platforms there is a layer the operating system owns and a layer .NET owns. A flush that only clears the operating system's layer can leave keys behind in .NET's layer. Draining through `ReadKey` empties both, which is why it is the portable answer.

## A minimal repro of type-ahead skipping a prompt

```csharp
// .NET 10, C# 14 -- save as typeahead.cs and run with: dotnet run typeahead.cs
Console.WriteLine("Loading level (type some keys now)...");
Thread.Sleep(3000);                       // stands in for a cutscene, a save, a slow load

Console.WriteLine("Press any key to start.");
var key = Console.ReadKey(intercept: true);
Console.WriteLine($"Started by: {key.Key}");
```

Type `abc` and an arrow key during the three-second pause. The program prints "Press any key to start." and immediately reports `Started by: A`, because the first buffered key satisfied `ReadKey` before the prompt was even visible. If you use this as a file-based app, the [`dotnet run file.cs` walkthrough](/2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11/) covers how those single-file programs are built and cached.

## The portable fix: drain with KeyAvailable and ReadKey

1. Check `Console.IsInputRedirected` and skip the drain when it is `true`.
2. Loop `while (Console.KeyAvailable)` and call `Console.ReadKey(intercept: true)` inside it, discarding the result.
3. Only then show the prompt and call `ReadKey` for the key you actually want.

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

The prompt from the repro becomes:

```csharp
// .NET 10, C# 14
Console.WriteLine("Press any key to start.");
var key = ConsoleInput.ReadFreshKey();
Console.WriteLine($"Started by: {key.Key}");
```

I verified the drain with this probe, feeding `abc`, up arrow and down arrow into a pseudo-terminal during the sleep and a `z` a few seconds later:

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

Two details worth noticing. The arrow keys came out as one `ConsoleKeyInfo` each, not as three loose characters, because `ReadKey` runs the escape-sequence parser. A byte-level flush (reading raw stdin, or calling `tcflush`) can cut an escape sequence in half and leave `[A` behind to be read as two printable keys. And `intercept: true` matters: with `false`, every discarded key is echoed to the screen, which is exactly the garbage you were trying to hide.

## Why held keys keep moving the player after release

The same buffer bites in a real-time loop, just more quietly. When a player holds an arrow key, the terminal or console host generates auto-repeat key-down events, commonly around 30 per second after an initial delay. A typical beginner loop reads at most one key per frame:

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

If keys arrive faster than frames, the backlog grows for as long as the key is held and then drains one key per frame after release. I measured it: a loop at 10 frames per second, fed 30 right-arrow sequences 33 ms apart (one second of simulated auto-repeat, starting about one second after launch).

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

With one key per frame, the player moved 30 cells and was still moving about 1.5 seconds after the key was "released". With a full drain per frame, movement stopped within a frame of the last repeat. The drained version moves one cell per frame while the key is held, which is what a game usually wants: speed tied to the frame rate, not to the operating system's repeat rate.

The general pattern is to drain every frame into a small per-frame input state, then let `Update` read that state:

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

A set rather than "last key wins" means a jump pressed in the same frame as a direction change is not lost. If you need modifiers, store the whole `ConsoleKeyInfo` or a `(ConsoleKey, ConsoleModifiers)` pair instead.

What the console cannot tell you is whether a key is *currently held*. `ReadKey` only surfaces key-down events (on Windows, key-up records are skipped, except an Alt key-up that carries a composed character, and so are presses of Shift, Ctrl and Alt on their own; on Unix, terminals do not send key-up at all). "Held" in a console game is inferred from repeat events arriving, which is why there is always the operating system's initial repeat delay before continuous movement starts. If you need true key state on Windows, `GetAsyncKeyState` via P/Invoke is the usual escape hatch, and at that point a real game framework is worth considering.

## The Unix echo trap: type-ahead shows up on screen

On Linux and macOS there is a second symptom that the drain does not fix. In my first probe, the output actually looked like this:

```text
busy for 3s, type ahead now...
abc^[[A^[[Bdiscarded: Key=A Char=97
```

The keys were discarded correctly, but the terminal had already echoed them while the program slept. The reason is in `pal_console.c`: .NET switches the terminal to non-canonical, no-echo mode (`ECHO`, `ICANON` and `IEXTEN` cleared) the first time you do a console *read*, and that includes `Console.KeyAvailable`, which calls `SystemNative_StdinReady`. Before that first read, the terminal is still in its default cooked mode and echoes everything. Once configured, .NET leaves the terminal in that mode until the process exits, when it restores the original settings.

The fix is to touch the input side once at startup:

```csharp
// .NET 10, C# 14 -- first line of Main, before any long-running work
if (!Console.IsInputRedirected)
    _ = Console.KeyAvailable;   // puts the terminal in no-echo, non-canonical mode
```

With that line first, the same three-second sleep with keys typed into it produced clean output: the keys stayed in the buffer, nothing was echoed, and the later drain removed them. On Windows this is not an issue, because a console app's type-ahead sits as input records and is not echoed until something reads it in line mode.

## Windows only: FlushConsoleInputBuffer

Win32 has a direct call, [`FlushConsoleInputBuffer`](https://learn.microsoft.com/en-us/windows/console/flushconsoleinputbuffer), which empties the console's input record queue in one shot. It is tempting because it is O(1) and also clears mouse and resize records:

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

I compiled this on .NET 10 (as a file-based app with `#:property AllowUnsafeBlocks=true`), but I could only run it on macOS, where `TryFlush` returns `false` without calling into `kernel32`. I would still call the managed drain after it, for one reason visible in the source: `FlushConsoleInputBuffer` cannot reach .NET's private `_cachedInputRecord`. If the last record `ReadKey` pulled had a repeat count above 1, the remaining repeats are served from that field, and `KeyAvailable` returns `true` for them before it even asks the console. `DiscardPendingKeys()` drains the cache too. If you are new to `LibraryImport` and source-generated marshalling, the [Polars.NET post](/2026/02/dotnet-polarsnet-rust-dataframe-engine-with-libraryimport/) walks through it, and the [Windows session lock and unlock events post](/2026/10/how-to-detect-windows-session-lock-unlock-logon-and-logoff-events-in-csharp/) uses the same `LibraryImport` pattern against `wtsapi32.dll`, including the `AllowUnsafeBlocks` setup.

## Gotchas and edge cases

**Redirected input throws.** With stdin piped (`echo abc | dotnet run game.cs`), both calls throw. The exact .NET 10 messages:

```text
KeyAvailable threw InvalidOperationException: Cannot see if a key has been pressed when either application does not have a console or when console input has been redirected from a file. Try Console.In.Peek.
ReadKey threw InvalidOperationException: Cannot read keys when either application does not have a console or when console input has been redirected. Try Console.Read.
```

That bites in CI, in `dotnet test` runs that exercise the console code, and in some IDE "run" consoles that redirect stdin. Every helper above returns early on `Console.IsInputRedirected`.

**Do not drain with Console.In.** `Console.In.Read()` and `Console.In.Peek()` are line-oriented on Unix: they read a whole line into a separate stack inside `StdInReader` before returning, so they block until Enter and pull keys into a place `KeyAvailable` does not check. Mixing `ReadLine` and `ReadKey` in one program is fine; draining with the `TextReader` API is not.

**A drain is not a debounce.** If the user presses a key 5 ms after your drain, it is a fresh key and `ReadKey` will return it. That is correct, but if your concern is accidental double-presses on a menu, add a small delay before the drain, for example `Thread.Sleep(150)` right after the action that triggered the prompt.

**Do not spin on KeyAvailable.** `while (!Console.KeyAvailable) { }` burns a core. In a frame loop, sleep or wait for the next frame. If you want "wait for a key, but give up after N seconds", poll `KeyAvailable` with a short `Task.Delay` and a deadline, or wrap it in a token from [`CancellationTokenSource.CancelAfter`](/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/). `Console.ReadKey` itself cannot be cancelled once it is blocking, so the only way to give up is to never call it until `KeyAvailable` says there is something to read. Pass the token down the call chain the same way you would for any [async method that should honour cancellation](/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/).

**Ctrl+C is not a key by default.** Unless you set `Console.TreatControlCAsInput = true`, Ctrl+C raises `Console.CancelKeyPress` and never enters the buffer, so a drain neither sees nor swallows it. If you do set it to `true` for a game, remember that your drain will now silently eat a Ctrl+C that was pressed during a pause.

**Multithreaded reads.** On Windows, `ReadKey` takes a lock; on Unix, `KeyAvailable` and `ReadKey` go through a synchronized reader. That makes them safe to call from different threads, but not meaningful: a background input thread and a main-thread drain will steal keys from each other. Pick one thread to own console input.

### Read next

- [How to run a file-based C# app with dotnet run in .NET 11](/2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11/)
- [How to time out an async operation with CancellationTokenSource.CancelAfter in C#](/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/)
- [How to propagate a CancellationToken through async methods in .NET 11](/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/)
- [How to detect Windows session lock, unlock, logon and logoff events in a C# app](/2026/10/how-to-detect-windows-session-lock-unlock-logon-and-logoff-events-in-csharp/)

## Sources

- [`Console.KeyAvailable` property](https://learn.microsoft.com/en-us/dotnet/api/system.console.keyavailable), Microsoft Learn.
- [`Console.ReadKey` method](https://learn.microsoft.com/en-us/dotnet/api/system.console.readkey), Microsoft Learn.
- [`FlushConsoleInputBuffer` function](https://learn.microsoft.com/en-us/windows/console/flushconsoleinputbuffer), Windows Console docs.
- [`ConsolePal.Windows.cs`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Console/src/System/ConsolePal.Windows.cs) at `v10.0.0` (`KeyAvailable`, `ReadKey`, `_cachedInputRecord`).
- [`StdInReader.cs`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Console/src/System/IO/StdInReader.cs) and [`SyncTextReader.Unix.cs`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Console/src/System/IO/SyncTextReader.Unix.cs) at `v10.0.0` (Unix buffering and `KeyAvailable`).
- [`pal_console.c`](https://github.com/dotnet/runtime/blob/v10.0.0/src/native/libs/System.Native/pal_console.c) at `v10.0.0` (terminal echo and canonical mode).
