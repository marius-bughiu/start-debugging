---
title: "Process.Run vs Process.Start в .NET 11: что выбрать?"
description: "Используйте Process.Run, когда запускаете инструмент и вас интересует только то, как он завершился: один вызов, тайм-аут, который убивает дочерний процесс, и ProcessExitStatus с сигналом. Оставьте Process.Start, когда нужен объект Process: запись в stdin, чтение вывода по мере поступления, UseShellExecute или завершение всего дерева процессов."
pubDate: 2026-09-17
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "process"
lang: "ru"
translationOf: "2026/09/process-run-vs-process-start-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-09-17
---

**Используйте `Process.Run` (или `Process.RunAsync`) всякий раз, когда вы запускаете процесс, даёте ему завершиться и хотите знать только то, как он завершился.** Это один вызов, он не может допустить утечку дескриптора `Process`, его тайм-аут или `CancellationToken` действительно убивает дочерний процесс, а возвращает он `ProcessExitStatus`, который сообщает, завершился ли дочерний процесс штатно, был убит сигналом или был убит вами. **Оставьте `Process.Start`, когда нужен живой объект `Process`**: запись в stdin, построчное чтение вывода во время работы процесса, `UseShellExecute` для открытия URL или документа, событие `Exited` или `Kill(entireProcessTree: true)` для инструментов, которые порождают собственные рабочие процессы. Производительность здесь ничего не решает: оба варианта показали около 740 микросекунд на запуск в .NET 11 RC 1. Всё, что описано ниже, проверено на .NET 11 RC 1 (SDK `11.0.100-rc.1.26425.128`, среда выполнения `11.0.0-rc.1.26425.128`, C# 15) на macOS 26.6 с Apple M4.

## Два API рядом

| Поведение (.NET 11 RC 1)                  | `Process.Run` / `RunAsync`                          | `Process.Start` + `WaitForExit`                  |
| ----------------------------------------- | --------------------------------------------------- | ------------------------------------------------ |
| Доступен в                                | .NET 11+                                            | любой версии .NET                                |
| Возвращает                                | `ProcessExitStatus`                                 | `Process` (нужно освободить)                     |
| stdin/stdout/stderr по умолчанию          | наследуются от родителя (или null при `silent: true`) | наследуются от родителя                        |
| `RedirectStandardOutput = true`           | `InvalidOperationException`                         | да                                               |
| Запись в stdin во время работы            | нет                                                 | да                                               |
| `UseShellExecute = true`                  | `InvalidOperationException`                         | да                                               |
| Тайм-аут                                  | убивает дочерний процесс, `Canceled = true`         | `WaitForExit(TimeSpan)` возвращает `false`, дочерний процесс продолжает работать |
| Отмена (async)                            | убивает дочерний процесс, без исключения            | `WaitForExitAsync(ct)` выбрасывает исключение, дочерний процесс продолжает работать |
| Завершающий сигнал                        | `ProcessExitStatus.Signal`                          | угадывать по `ExitCode` (137, 143)               |
| Убийство внуков по тайм-ауту              | нет, только прямой дочерний процесс                 | `Kill(entireProcessTree: true)`                  |
| ID процесса                               | не возвращается                                     | `Process.Id`                                     |
| Запуск `/usr/bin/true`, синхронно         | 737.0 us, 16.56 KB                                  | 739.4 us, 16.84 KB                               |

Первые пять строк решают большинство случаев. Если ваш код обращается к `StandardInput`, `BeginOutputReadLine` или `UseShellExecute`, `Process.Run` вообще не вариант. Если ни к чему из этого, `Process.Run` короче и имеет более безопасные значения по умолчанию.

## Что на самом деле делает Process.Run

`Process.Run` появился в .NET 11 Preview 4 вместе с `RunAndCaptureText` и `StartAndForget` в рамках [переработки Process API](https://devblogs.microsoft.com/dotnet/process-api-improvements-in-dotnet-11/), о которой я писал, когда [появился захват вывода без взаимных блокировок](/ru/2026/05/dotnet-11-process-api-deadlock-free-capture/). Поверхность API в RC 1 такова:

```csharp
// .NET 11 RC 1, System.Diagnostics.Process
public static ProcessExitStatus Run(ProcessStartInfo startInfo, TimeSpan? timeout = default);
public static ProcessExitStatus Run(string fileName, IEnumerable<string>? arguments = null,
    bool silent = false, TimeSpan? timeout = default);

public static Task<ProcessExitStatus> RunAsync(ProcessStartInfo startInfo,
    CancellationToken cancellationToken = default);
public static Task<ProcessExitStatus> RunAsync(string fileName, IEnumerable<string>? arguments = null,
    bool silent = false, CancellationToken cancellationToken = default);
```

Две детали отличаются от статьи в блоге о Preview 4. В Preview 7 тип `arguments` сменился с `IList<string>?` на `IEnumerable<string>?` ([dotnet/runtime#130630](https://github.com/dotnet/runtime/pull/130630)), а перегрузки с `fileName` получили флаг `silent`, который направляет stdin, stdout и stderr на нулевое устройство.

Реализация в [`Process.Scenarios.cs`](https://github.com/dotnet/runtime/blob/v11.0.0-rc.1.26425.128/src/libraries/System.Diagnostics.Process/src/System/Diagnostics/Process.Scenarios.cs) достаточно коротка, чтобы описать её точно. Она никогда не создаёт объект `Process`. Она вызывает `SafeProcessHandle.Start(startInfo)`, затем либо `WaitForExit()`, либо `WaitForExitOrKillOnTimeout(timeout)`, и освобождает дескриптор перед возвратом. `RunAsync` делает то же самое с `WaitForExitOrKillOnCancellationAsync`. Поэтому утечка дескриптора невозможна, и поэтому же отвергается всё, что требует `Process` для управления: флаги `RedirectStandard*` имеют смысл, только если кто-то держит `Process.StandardOutput` и вычитывает его.

У `ProcessExitStatus` три свойства: `ExitCode`, `Canceled` и допускающий null `PosixSignal? Signal`. Тот же тип возвращают [новые методы `Process.WaitForExitStatus` в RC 1](/ru/2026/09/dotnet-11-rc-1-process-signal-exit-status/).

## Одна и та же задача, написанная двумя способами

Вот повседневный случай: запустить `dotnet build`, пустить его вывод в консоль, упасть при ошибке и сдаться через пять минут.

```csharp
// .NET 11 RC 1, C# 15 -- before: Process.Start
using System.Diagnostics;

using Process build = Process.Start("dotnet", ["build", "-c", "Release"]);

if (!build.WaitForExit(TimeSpan.FromMinutes(5)))
{
    build.Kill(entireProcessTree: true);
    build.WaitForExit();
    throw new TimeoutException("dotnet build took longer than 5 minutes");
}

if (build.ExitCode != 0)
    throw new InvalidOperationException($"dotnet build failed with {build.ExitCode}");
```

```csharp
// .NET 11 RC 1, C# 15 -- after: Process.Run
using System.Diagnostics;

ProcessExitStatus status = Process.Run(
    "dotnet", ["build", "-c", "Release"],
    timeout: TimeSpan.FromMinutes(5));

if (status.Canceled)
    throw new TimeoutException("dotnet build took longer than 5 minutes");

if (status.ExitCode != 0)
    throw new InvalidOperationException($"dotnet build failed with {status.ExitCode}");
```

Версия с `Process.Start` корректна, но только потому, что помнит о двух вещах, которые обычно забывают: `WaitForExit(TimeSpan)` ничего не убивает по тайм-ауту, а `Process` нужно освободить. В версии с `Process.Run` ошибиться ни в том, ни в другом невозможно. Заметьте, впрочем, что `entireProcessTree: true` в первой версии я оставил намеренно. Подробнее об этом в разделе о подводных камнях.

## Тайм-ауты и отмена ведут себя по-разному

Именно на этом различии обжигаются те, кто мигрирует поиском и заменой. Я запустил оба варианта против `sleep 10` с бюджетом 500 ms на .NET 11 RC 1:

```csharp
// .NET 11 RC 1, C# 15, macOS 26.6
using System.Diagnostics;

using var cts = new CancellationTokenSource(500);
ProcessExitStatus s = await Process.RunAsync("sleep", ["10"], cancellationToken: cts.Token);
Console.WriteLine($"ExitCode={s.ExitCode} Canceled={s.Canceled} Signal={s.Signal}");
// ExitCode=137 Canceled=True Signal=SIGKILL   (returned after 505 ms, no exception)

using var cts2 = new CancellationTokenSource(500);
using Process p = Process.Start("sleep", ["10"]);
try { await p.WaitForExitAsync(cts2.Token); }
catch (TaskCanceledException) { Console.WriteLine($"HasExited={p.HasExited}"); }
// HasExited=False   (the child is still running)
```

Из этого вывода следуют три вещи:

1. **`RunAsync` не выбрасывает исключение при отмене.** Он убивает дочерний процесс сигналом `SIGKILL` (или через `TerminateProcess` на Windows), дожидается его завершения и возвращает статус с `Canceled = true`. Код, обёрнутый в `catch (OperationCanceledException)`, никогда не попадёт в блок catch. Проверяйте вместо этого `status.Canceled`.
2. **`Process.WaitForExitAsync(ct)` отменяет только ожидание.** Он выбрасывает `TaskCanceledException` и оставляет процесс живым. Если процесс нужно убить, вызывайте `Kill()` сами.
3. **`Signal` избавляет от угадывания по коду выхода.** В Unix процесс, убитый `SIGKILL`, сообщает код выхода 137, убитый `SIGTERM` сообщает 143, а процесс может и просто выполнить `exit 137`. `ProcessExitStatus.Signal` говорит, что именно произошло. Внутри вызова `Process.Run` свойство `Canceled` говорит, было ли убийство вашим.

Синхронный `Run` принимает `TimeSpan? timeout` и не принимает токен; `RunAsync` принимает токен и не принимает тайм-аут. Для асинхронного тайм-аута используйте `new CancellationTokenSource(TimeSpan)`, как выше. Если отмена приходит из запроса ASP.NET Core или hosted service, приёмы из статьи [как отменить долго выполняющуюся Task без взаимной блокировки](/ru/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) применимы без изменений.

## Когда выбирать Process.Run

- **Скрипты сборки и CLI-обёртки**, которые запускают `git`, `dotnet`, `npm` или `docker` и пускают вывод прямо в консоль. При значении по умолчанию `silent: false` дочерний процесс наследует дескрипторы родителя, поэтому цвета и индикаторы прогресса продолжают работать.
- **Проверки работоспособности и пробы**, где важен только код выхода. `Process.Run("pg_isready", ["-h", host], silent: true, timeout: TimeSpan.FromSeconds(3))` и есть вся реализация.
- **Инструменты, которые никогда не должны подвешивать ваш сервис.** Пути тайм-аута и отмены убивают дочерний процесс за вас, поэтому зависший `ffprobe` не сможет копиться за запросом.
- **Запись вывода в файл вместо консоли.** `ProcessStartInfo.StandardOutputHandle` принимает любой `SafeFileHandle`, и `Run(ProcessStartInfo)` это поддерживает:

```csharp
// .NET 11 RC 1, C# 15
using System.Diagnostics;
using Microsoft.Win32.SafeHandles;

using SafeFileHandle log = File.OpenHandle("build.log", FileMode.Create, FileAccess.Write);

ProcessExitStatus status = Process.Run(new ProcessStartInfo("dotnet", ["build"])
{
    StandardOutputHandle = log,
    StandardErrorHandle = log,
    WorkingDirectory = "/src/app",
});
```

Если вывод нужен в памяти, а не в файле, пропустите оба API и вызовите `Process.RunAndCaptureText`, который вычитывает stdout и stderr параллельно, так что классическая взаимная блокировка при перенаправлении невозможна.

## Когда оставить Process.Start

- **Интерактивный stdin.** Передача пароля в `ssh-keygen`, отправка SQL в `psql` или общение с REPL требуют `RedirectStandardInput` и `Process.StandardInput`. `Run` выбрасывает исключение при любом флаге `RedirectStandard*`.
- **Потоковый вывод во время работы процесса.** Интерфейсу прогресса, который показывает строки `ffmpeg` по мере их появления, нужен `Process`. В .NET 11 можно хотя бы отказаться от обработчиков событий и использовать `process.ReadAllLinesAsync(ct)`, который выдаёт значения `ProcessOutputLine` из обоих потоков без взаимных блокировок.
- **Запуск через оболочку.** `Process.Start(new ProcessStartInfo("https://startdebugging.net") { UseShellExecute = true })` по-прежнему остаётся способом открыть URL или документ в приложении по умолчанию. `Run`, `RunAsync` и `StartAndForget` выбрасывают исключение, потому что на Windows запуск через оболочку может вообще не создать новый процесс.
- **Деревья процессов.** Если дочерний процесс порождает рабочие процессы (узлы MSBuild, `npm`, запускающий `node`, shell-скрипт), убрать их может только `Process.Kill(entireProcessTree: true)`. См. следующий раздел.
- **Вам нужен сам `Process`**: `Id` для журналирования, событие `Exited`, `PriorityClass` или перегрузки с `userName`/`password`, доступные только на Windows.
- **Вы нацелены на что-то до .NET 11.** В .NET 10 `Process.Run` не существует. Библиотеке с несколькими целевыми платформами нужен `#if NET11_0_OR_GREATER`.

## Бенчмарк

Производительность не повод выбирать ни один из вариантов, и я измерил её, чтобы вам не пришлось гадать. Окружение: .NET 11 RC 1 (`11.0.0-rc.1.26425.128`), BenchmarkDotNet 0.15.8 с внутрипроцессным emit-тулчейном (0.15.8 пока не распознаёт `net11.0` для запусков вне процесса), 3 итерации прогрева и 15 измеряемых, macOS 26.6.2, Apple M4 с 10 ядрами. Каждый бенчмарк запускает `/usr/bin/true` и ждёт его завершения.

```csharp
// .NET 11 RC 1, BenchmarkDotNet 0.15.8
[MemoryDiagnoser]
[InProcess, WarmupCount(3), IterationCount(15)]
public class SpawnBenchmarks
{
    private const string Exe = "/usr/bin/true";

    [Benchmark(Baseline = true)]
    public int Start_WaitForExit()
    {
        using Process p = Process.Start(Exe);
        p.WaitForExit();
        return p.ExitCode;
    }

    [Benchmark]
    public int Run() => Process.Run(Exe).ExitCode;

    [Benchmark]
    public async Task<int> Start_WaitForExitAsync()
    {
        using Process p = Process.Start(Exe);
        await p.WaitForExitAsync();
        return p.ExitCode;
    }

    [Benchmark]
    public async Task<int> RunAsync() => (await Process.RunAsync(Exe)).ExitCode;
}
```

| Method                   | Mean     | StdDev   | Allocated |
| ------------------------ | -------: | -------: | --------: |
| `Start_WaitForExit`      | 739.4 us | 6.26 us  | 16.84 KB  |
| `Run`                    | 737.0 us | 2.76 us  | 16.56 KB  |
| `Start_WaitForExitAsync` | 768.5 us | 13.89 us | 17.89 KB  |
| `RunAsync`               | 762.6 us | 2.56 us  | 17.47 KB  |

Разница в пределах шума. Почти вся стоимость приходится на создание процесса операционной системой, а оба API используют один и тот же путь запуска через `SafeProcessHandle`. Отказ от объекта `Process` экономит около 300 байт. Крупные выигрыши .NET 11 (запуск процесса в 98 раз быстрее на Apple Silicon, по измерениям команды .NET) одинаково распространяются на оба API, потому что находятся ниже этого уровня.

## Подводные камни, которые решат за вас

**Тайм-аут убивает только прямой дочерний процесс.** Я запустил `Process.Run("sh", ["-c", "sleep 31; true"], timeout: TimeSpan.FromMilliseconds(500))`. `Run` вернул `Canceled=True Signal=SIGKILL`, а `pgrep -f "sleep 31"` после этого всё ещё находил процесс `sleep`, переподчинённый и работающий. Тот же тест с `Process.Start` и `Kill(entireProcessTree: true)` ничего после себя не оставил. `dotnet build`, `npm run`, `docker compose` и большинство shell-скриптов порождают дочерние процессы, поэтому если тайм-аут должен оставлять машину чистой, правильным инструментом по-прежнему остаётся `Process.Start` с убийством дерева. `ProcessStartInfo.KillOnParentExit` (только Windows, Linux и Android) заменой не является: он срабатывает, когда завершается ваш процесс, а не когда истекает тайм-аут.

**Перегрузки со строковыми аргументами нет.** `Process.Run("git", "status")` не компилируется, потому что `string` не является `IEnumerable<string>`. Передайте `["status"]` или создайте `ProcessStartInfo("git", "status")` и используйте перегрузку `Run(ProcessStartInfo)`.

**`silent: true` обнуляет и stdin.** Дочерний процесс, который что-то запрашивает, например `git`, спрашивающий учётные данные, сразу читает конец файла вместо того, чтобы зависнуть. В сервисе обычно это и нужно, а в скрипте разработчика это неожиданно.

**`Run(ProcessStartInfo)` отвергает ваш существующий start info.** Если вы переносите `ProcessStartInfo`, в котором всё ещё стоит `RedirectStandardOutput = true`, вы получите `InvalidOperationException: The RedirectStandardInput, RedirectStandardOutput, and RedirectStandardError properties cannot be used by SafeProcessHandle.Start or Process.StartAndForget`. В сообщении не упоминаются ни `Run`, ни `RunAsync`, но это та же проверка. Замените флаг на `StandardOutputHandle` или перейдите на `RunAndCaptureText`.

**Ошибки запуска одинаковы.** Отсутствующий исполняемый файл приводит к одному и тому же `Win32Exception` ("No such file or directory") в обоих API, поэтому существующая обработка ошибок переносится без изменений.

**Ни один из них не поддерживается на iOS и tvOS.** Оба помечены `[UnsupportedOSPlatform("ios")]` и `[UnsupportedOSPlatform("tvos")]`, а Mac Catalyst поддерживается. Анализатор платформ в любом случае пометит вызовы в проекте MAUI.

## Итоговый выбор

Для нового кода на .NET 11, который запускает процесс до завершения, по умолчанию берите `Process.Run` или `Process.RunAsync`. Они устраняют три самые частые ошибки в коде работы с процессами (неосвобождённый `Process`, тайм-аут, который не убивает, код выхода, скрывающий сигнал) без измеримых затрат. Переходите на `Process.RunAndCaptureText`, как только вывод понадобится в виде строки. Беритесь за `Process.Start`, только когда процессом нужно управлять во время работы, открывать его через оболочку или завершать целым деревом. Последний случай важнее, чем кажется, потому что многие инструменты, которые вы обернули бы в `Process.Run`, незаметно порождают дочерние процессы, до которых его тайм-аут не дотянется. Если вы всё ещё сопровождаете старый код, блокирующийся на `WaitForExit`, то [базовые приёмы ожидания завершения процесса](/ru/2023/08/c-how-to-wait-for-a-process-to-end/) обычно и служат отправной точкой для кода с `Process.Start`, и их стоит пересмотреть с учётом этих значений по умолчанию.

### Связанные материалы

- [.NET 11 добавляет захват вывода процесса без взаимных блокировок](/ru/2026/05/dotnet-11-process-api-deadlock-free-capture/)
- [.NET 11 RC 1 позволяет отправить SIGTERM дочернему процессу без P/Invoke](/ru/2026/09/dotnet-11-rc-1-process-signal-exit-status/)
- [C#: как дождаться завершения процесса](/ru/2023/08/c-how-to-wait-for-a-process-to-end/)
- [Как отменить долго выполняющуюся Task в C# без взаимной блокировки](/ru/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- [.Result и .Wait() vs GetAwaiter().GetResult() vs await в C#](/ru/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/)

### Источники

- [Process API improvements in .NET 11](https://devblogs.microsoft.com/dotnet/process-api-improvements-in-dotnet-11/), .NET Blog
- [`Process.Scenarios.cs`](https://github.com/dotnet/runtime/blob/v11.0.0-rc.1.26425.128/src/libraries/System.Diagnostics.Process/src/System/Diagnostics/Process.Scenarios.cs) и [`SafeProcessHandle.cs`](https://github.com/dotnet/runtime/blob/v11.0.0-rc.1.26425.128/src/libraries/System.Diagnostics.Process/src/Microsoft/Win32/SafeHandles/SafeProcessHandle.cs) на теге `v11.0.0-rc.1.26425.128`, dotnet/runtime
- [Implement Process.Run, RunAsync, RunAndCaptureText, RunAndCaptureTextAsync](https://github.com/dotnet/runtime/pull/127210), PR в dotnet/runtime
- [Заметки о выпуске библиотек .NET 11 Preview 7](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview7/libraries.md) (изменение аргументов на `IEnumerable<string>`), dotnet/core
- [Что нового в библиотеках .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/libraries), MS Learn
- [Метод `Process.Start`](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.start), MS Learn
