---
title: "Как отбросить буферизованные нажатия клавиш перед Console.ReadKey в игровом цикле консольного приложения на C#"
description: "Очищайте буфер ввода консоли с помощью while (Console.KeyAvailable) Console.ReadKey(true) перед ожиданием новой клавиши и делайте это в каждом кадре игрового цикла, чтобы автоповтор не копился. Как устроен буфер в Windows и Unix в .NET 10, почему зажатые клавиши отстают, ловушка с эхо в Unix и FlushConsoleInputBuffer."
pubDate: 2026-10-12
template: how-to
tags:
  - "csharp"
  - "dotnet-10"
  - "console"
  - "how-to"
lang: "ru"
translationOf: "2026/10/how-to-discard-buffered-keypresses-before-console-readkey-in-csharp"
translatedBy: "claude"
translationDate: 2026-10-12
---

**Короткий ответ:** в .NET нет `Console.ClearInputBuffer()`, поэтому буфер очищают вручную: `while (Console.KeyAvailable) Console.ReadKey(intercept: true);`. Ставьте этот цикл прямо перед любым `ReadKey` вида "нажмите любую клавишу для продолжения", чтобы клавиши, нажатые во время заставки или паузы загрузки, не пропускали приглашение. В игровом цикле выполняйте такую же очистку один раз за кадр и работайте с последней клавишей (или со всеми нужными) вместо чтения одной клавиши за кадр, иначе автоповтор зажатой клавиши накапливается в очереди, и персонаж продолжает двигаться после того, как игрок отпустил клавишу. Защитите код проверкой `Console.IsInputRedirected`, потому что и `KeyAvailable`, и `ReadKey` выбрасывают `InvalidOperationException`, когда stdin является каналом или файлом.

Всё ниже запускалось на .NET 10 (SDK 10.0.302, среда выполнения 10.0.10) на macOS, при этом приложение управлялось через настоящий псевдотерминал, так что нажатия проходят тот же путь, что и при вводе человеком. Поведение Windows описано по исходному коду `System.Console` на [теге `v10.0.0`](https://github.com/dotnet/runtime/tree/v10.0.0/src/libraries/System.Console/src/System); соответствующий код (`KeyAvailable`, `ReadKey` и нативная настройка терминала в Unix) в `main` не изменился, поэтому тот же ответ подходит и для release candidate .NET 11.

## Где на самом деле лежат "буферизованные" клавиши

Нажатие клавиши не попадает прямо в ваш вызов `ReadKey`. Его ставит в очередь операционная система, и оно лежит там, пока кто-нибудь его не прочитает, чем бы ни занималась ваша программа в момент нажатия. Поэтому игрок, который молотит по Enter во время двухсекундного "интро" на `Thread.Sleep`, пропускает следующие три приглашения.

На каждой платформе очередь находится в своём месте, и это важно для выбора правильного способа очистки:

- **Windows.** Хост консоли хранит очередь структур `INPUT_RECORD`: события нажатия и отпускания клавиш, события мыши, изменения размера окна, события фокуса. `Console.KeyAvailable` вызывает `PeekConsoleInput`, и если запись в начале очереди не является событием нажатия клавиши, которое вернул бы `ReadKey`, она читается и отбрасывается, после чего проверка повторяется. `Console.ReadKey` вызывает `ReadConsoleInput` в таком же цикле. Ещё одна деталь: если у записи клавиши счётчик повторов больше 1, .NET кеширует её в закрытом статическом поле (`_cachedInputRecord`) и выдаёт по одному `ConsoleKeyInfo` на каждый повтор из этого кеша.
- **Linux и macOS.** Байты приходят в файловый дескриптор терминала. `StdInReader` в .NET читает их порциями в собственный буфер `char[]` и разбирает escape-последовательности (`ESC [ A` для стрелки вверх и так далее) в значения `ConsoleKeyInfo`. `Console.KeyAvailable` возвращает `true`, если в этом управляемом буфере остались неразобранные символы или если `poll()` на stdin сообщает, что ядро ждёт ещё байты.

Итак, на обеих платформах есть слой, которым владеет операционная система, и слой, которым владеет .NET. Очистка, затрагивающая только слой операционной системы, может оставить клавиши в слое .NET. Очистка через `ReadKey` опустошает оба, поэтому это переносимый ответ.

## Минимальный пример, где type-ahead пропускает приглашение

```csharp
// .NET 10, C# 14 -- save as typeahead.cs and run with: dotnet run typeahead.cs
Console.WriteLine("Loading level (type some keys now)...");
Thread.Sleep(3000);                       // stands in for a cutscene, a save, a slow load

Console.WriteLine("Press any key to start.");
var key = Console.ReadKey(intercept: true);
Console.WriteLine($"Started by: {key.Key}");
```

Нажмите `abc` и стрелку во время трёхсекундной паузы. Программа выведет "Press any key to start." и сразу сообщит `Started by: A`, потому что первая буферизованная клавиша удовлетворила `ReadKey` ещё до того, как приглашение стало видно. Если вы используете это как файловое приложение, [разбор `dotnet run file.cs`](/ru/2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11/) объясняет, как собираются и кешируются такие однофайловые программы.

## Переносимое решение: очистка через KeyAvailable и ReadKey

1. Проверьте `Console.IsInputRedirected` и пропустите очистку, если значение `true`.
2. Запустите цикл `while (Console.KeyAvailable)` и внутри вызывайте `Console.ReadKey(intercept: true)`, отбрасывая результат.
3. Только после этого показывайте приглашение и вызывайте `ReadKey` для нужной клавиши.

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

Приглашение из примера выше превращается в:

```csharp
// .NET 10, C# 14
Console.WriteLine("Press any key to start.");
var key = ConsoleInput.ReadFreshKey();
Console.WriteLine($"Started by: {key.Key}");
```

Очистку я проверил таким зондом: во время паузы в псевдотерминал подавались `abc`, стрелка вверх и стрелка вниз, а через несколько секунд ещё и `z`:

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

Стоит отметить две детали. Стрелки вышли как по одному `ConsoleKeyInfo`, а не как по три отдельных символа, потому что `ReadKey` пропускает данные через разборщик escape-последовательностей. Побайтовая очистка (чтение сырого stdin или вызов `tcflush`) может разрезать escape-последовательность пополам и оставить `[A`, которое затем прочитается как две печатные клавиши. И важен `intercept: true`: при `false` каждая отброшенная клавиша выводится на экран, то есть получается именно тот мусор, который вы пытались скрыть.

## Почему зажатые клавиши продолжают двигать игрока после отпускания

Тот же буфер мешает и в цикле реального времени, только менее заметно. Когда игрок держит стрелку, терминал или хост консоли генерирует события автоповтора нажатия, обычно порядка 30 в секунду после начальной задержки. Типичный цикл новичка читает не больше одной клавиши за кадр:

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

Если клавиши поступают быстрее, чем сменяются кадры, очередь растёт, пока клавиша зажата, а после отпускания разбирается по одной клавише за кадр. Я это измерил: цикл с частотой 10 кадров в секунду, на вход которого подано 30 последовательностей правой стрелки с интервалом 33 мс (секунда имитации автоповтора, начало примерно через секунду после запуска).

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

При одной клавише за кадр игрок прошёл 30 клеток и продолжал двигаться примерно через 1,5 секунды после "отпускания" клавиши. При полной очистке в каждом кадре движение прекратилось в пределах кадра после последнего повтора. Версия с очисткой делает одну клетку за кадр, пока клавиша зажата, и именно этого обычно хотят от игры: скорость привязана к частоте кадров, а не к частоте повтора операционной системы.

Общий приём такой: в каждом кадре очищайте буфер в небольшое состояние ввода кадра, а затем пусть `Update` читает это состояние:

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

Множество вместо правила "побеждает последняя клавиша" означает, что прыжок, нажатый в том же кадре, что и смена направления, не потеряется. Если нужны модификаторы, храните целиком `ConsoleKeyInfo` или пару `(ConsoleKey, ConsoleModifiers)`.

Чего консоль сообщить не может, так это удерживается ли клавиша *прямо сейчас*. `ReadKey` выдаёт только события нажатия (в Windows записи отпускания пропускаются, кроме отпускания Alt, несущего составной символ, и так же пропускаются нажатия одних лишь Shift, Ctrl и Alt; в Unix терминалы вообще не отправляют отпускание). "Удержание" в консольной игре выводится из поступающих событий повтора, поэтому перед началом непрерывного движения всегда есть начальная задержка повтора операционной системы. Если на Windows нужно настоящее состояние клавиш, обычный запасной выход это `GetAsyncKeyState` через P/Invoke, но на этом этапе стоит задуматься о полноценном игровом фреймворке.

## Ловушка с эхо в Unix: type-ahead появляется на экране

В Linux и macOS есть второй симптом, который очистка не устраняет. В моём первом зонде вывод на самом деле выглядел так:

```text
busy for 3s, type ahead now...
abc^[[A^[[Bdiscarded: Key=A Char=97
```

Клавиши были отброшены правильно, но терминал уже вывел их эхом, пока программа спала. Причина в `pal_console.c`: .NET переводит терминал в неканонический режим без эхо (сбрасываются `ECHO`, `ICANON` и `IEXTEN`) при первом *чтении* из консоли, и к чтению относится `Console.KeyAvailable`, который вызывает `SystemNative_StdinReady`. До первого чтения терминал остаётся в обычном каноническом режиме и выводит эхом всё подряд. После настройки .NET оставляет терминал в этом режиме до завершения процесса, когда восстанавливает исходные параметры.

Решение: один раз при запуске обратиться к стороне ввода:

```csharp
// .NET 10, C# 14 -- first line of Main, before any long-running work
if (!Console.IsInputRedirected)
    _ = Console.KeyAvailable;   // puts the terminal in no-echo, non-canonical mode
```

С этой строкой в начале тот же трёхсекундный сон с набранными в него клавишами дал чистый вывод: клавиши остались в буфере, ничего не вывелось эхом, а последующая очистка их удалила. В Windows такой проблемы нет, потому что type-ahead консольного приложения лежит как записи ввода и не выводится эхом, пока что-то не прочитает его в построчном режиме.

## Только Windows: FlushConsoleInputBuffer

В Win32 есть прямой вызов [`FlushConsoleInputBuffer`](https://learn.microsoft.com/en-us/windows/console/flushconsoleinputbuffer), который опустошает очередь записей ввода консоли одним махом. Он соблазнителен тем, что работает за O(1) и заодно очищает записи мыши и изменения размера:

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

Я скомпилировал это на .NET 10 (как файловое приложение с `#:property AllowUnsafeBlocks=true`), но запустить смог только на macOS, где `TryFlush` возвращает `false`, не обращаясь к `kernel32`. Я всё равно вызывал бы управляемую очистку после него по одной причине, видной в исходниках: `FlushConsoleInputBuffer` не достаёт до закрытого `_cachedInputRecord` в .NET. Если у последней записи, которую прочитал `ReadKey`, счётчик повторов больше 1, оставшиеся повторы выдаются из этого поля, и `KeyAvailable` возвращает для них `true`, даже не спрашивая консоль. `DiscardPendingKeys()` очищает и этот кеш. Если `LibraryImport` и маршалинг на основе генераторов исходного кода вам в новинку, их разбирает [статья про Polars.NET](/ru/2026/02/dotnet-polarsnet-rust-dataframe-engine-with-libraryimport/), а [статья о событиях блокировки и разблокировки сеанса Windows](/ru/2026/10/how-to-detect-windows-session-lock-unlock-logon-and-logoff-events-in-csharp/) использует тот же шаблон `LibraryImport` с `wtsapi32.dll`, включая настройку `AllowUnsafeBlocks`.

## Подводные камни и граничные случаи

**Перенаправленный ввод выбрасывает исключение.** Если stdin подан через канал (`echo abc | dotnet run game.cs`), оба вызова выбрасывают исключение. Точные сообщения .NET 10:

```text
KeyAvailable threw InvalidOperationException: Cannot see if a key has been pressed when either application does not have a console or when console input has been redirected from a file. Try Console.In.Peek.
ReadKey threw InvalidOperationException: Cannot read keys when either application does not have a console or when console input has been redirected. Try Console.Read.
```

Это бьёт по CI, по запускам `dotnet test`, в которых выполняется консольный код, и по некоторым консолям "запуска" в IDE, перенаправляющим stdin. Каждый вспомогательный метод выше сразу возвращается при `Console.IsInputRedirected`.

**Не очищайте буфер через Console.In.** `Console.In.Read()` и `Console.In.Peek()` в Unix построчные: они читают всю строку в отдельный стек внутри `StdInReader` перед возвратом, поэтому блокируются до Enter и забирают клавиши в место, которое `KeyAvailable` не проверяет. Смешивать `ReadLine` и `ReadKey` в одной программе можно; очищать буфер через API `TextReader` нельзя.

**Очистка это не подавление дребезга.** Если пользователь нажмёт клавишу через 5 мс после вашей очистки, это новая клавиша, и `ReadKey` её вернёт. Это правильно, но если вас беспокоят случайные двойные нажатия в меню, добавьте небольшую задержку перед очисткой, например `Thread.Sleep(150)` сразу после действия, вызвавшего приглашение.

**Не крутитесь в цикле на KeyAvailable.** `while (!Console.KeyAvailable) { }` занимает ядро целиком. В кадровом цикле спите или ждите следующего кадра. Если нужно "ждать клавишу, но сдаться через N секунд", опрашивайте `KeyAvailable` с коротким `Task.Delay` и крайним сроком или оберните это в токен от [`CancellationTokenSource.CancelAfter`](/ru/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/). `Console.ReadKey` нельзя отменить, пока он блокируется, поэтому единственный способ сдаться это вообще не вызывать его, пока `KeyAvailable` не скажет, что есть что читать. Передавайте токен по цепочке вызовов так же, как для любого [асинхронного метода, учитывающего отмену](/ru/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/).

**Ctrl+C по умолчанию не клавиша.** Если не установить `Console.TreatControlCAsInput = true`, Ctrl+C вызывает `Console.CancelKeyPress` и никогда не попадает в буфер, поэтому очистка его не видит и не поглощает. Если вы всё же установили `true` для игры, помните, что теперь очистка молча съест Ctrl+C, нажатый во время паузы.

**Чтение из нескольких потоков.** В Windows `ReadKey` берёт блокировку; в Unix `KeyAvailable` и `ReadKey` идут через синхронизированный читатель. Это делает их безопасными для вызова из разных потоков, но не осмысленными: фоновый поток ввода и очистка в главном потоке будут красть клавиши друг у друга. Выберите один поток, который владеет вводом консоли.

### Читайте дальше

- [Как запустить файловое приложение C# с помощью dotnet run в .NET 11](/ru/2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11/)
- [Как задать тайм-аут асинхронной операции с помощью CancellationTokenSource.CancelAfter в C#](/ru/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/)
- [Как передавать CancellationToken через асинхронные методы в .NET 11](/ru/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/)
- [Как отслеживать события блокировки, разблокировки, входа и выхода сеанса Windows в приложении на C#](/ru/2026/10/how-to-detect-windows-session-lock-unlock-logon-and-logoff-events-in-csharp/)

## Источники

- [Свойство `Console.KeyAvailable`](https://learn.microsoft.com/en-us/dotnet/api/system.console.keyavailable), Microsoft Learn.
- [Метод `Console.ReadKey`](https://learn.microsoft.com/en-us/dotnet/api/system.console.readkey), Microsoft Learn.
- [Функция `FlushConsoleInputBuffer`](https://learn.microsoft.com/en-us/windows/console/flushconsoleinputbuffer), документация по консоли Windows.
- [`ConsolePal.Windows.cs`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Console/src/System/ConsolePal.Windows.cs) на `v10.0.0` (`KeyAvailable`, `ReadKey`, `_cachedInputRecord`).
- [`StdInReader.cs`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Console/src/System/IO/StdInReader.cs) и [`SyncTextReader.Unix.cs`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Console/src/System/IO/SyncTextReader.Unix.cs) на `v10.0.0` (буферизация в Unix и `KeyAvailable`).
- [`pal_console.c`](https://github.com/dotnet/runtime/blob/v10.0.0/src/native/libs/System.Native/pal_console.c) на `v10.0.0` (эхо терминала и канонический режим).
