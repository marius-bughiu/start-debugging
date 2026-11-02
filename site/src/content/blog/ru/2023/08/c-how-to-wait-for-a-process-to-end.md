---
title: "C# Как дождаться завершения процесса?"
description: "Ожидание дочернего процесса в C# через WaitForExit и WaitForExitAsync: готовый пример для .NET 8 и 10 с кодами выхода, тайм-аутами, отменой и очисткой ресурсов."
pubDate: 2023-08-11
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
lang: "ru"
translationOf: "2023/08/c-how-to-wait-for-a-process-to-end"
translatedBy: "claude"
translationDate: 2026-05-01
---
Вызов `process.WaitForExit()` блокирует текущий поток до завершения запущенного процесса. В асинхронном коде используйте `await process.WaitForExitAsync()`: ожидание не блокирует вызывающий поток. Читайте `ExitCode` после завершения процесса.

> Обновлено 2 ноября 2026 года: исходный пример с `cmd.exe /C timeout 5` зависел от Windows и её командного окружения. Новый пример запускает собственный дочерний процесс и проверяет оба способа ожидания, тайм-ауты и отмену на .NET 8 и .NET 10.

## Запуск полного примера

[Скачайте готовый проект process-wait](/examples/process-wait.zip). Распакуйте архив и выполните следующие команды из папки проекта с помощью SDK .NET 10. Для команды .NET 8 также нужна среда выполнения .NET 8:

```sh
dotnet run -c Release -f net10.0
dotnet run -c Release -f net8.0
```

Один и тот же код работает с обеими целевыми платформами. Он запускает копии самого себя, не обращаясь к оболочке и не требуя стороннего исполняемого файла. Первые два дочерних процесса намеренно возвращают код выхода `7`; родительский процесс проверяет его и возвращает `0`, если все проверки пройдены. Третий дочерний процесс ждёт ввода, поэтому проверки тайм-аута и отмены не зависят от скорости завершения короткой команды.

Полный файл `Program.cs`:

```cs
using System.Diagnostics;
using System.Reflection;

if (args is ["--child"])
{
    await Task.Delay(100);
    return 7;
}

if (args is ["--child-until-input"])
{
    await Console.In.ReadLineAsync();
    return 0;
}

using (var process = StartChild("--child"))
{
    process.WaitForExit();
    Require(process.ExitCode == 7, "Synchronous child exit code.");
    Console.WriteLine($"sync exit: {process.ExitCode}");
}

using (var process = StartChild("--child"))
{
    await process.WaitForExitAsync();
    Require(process.ExitCode == 7, "Asynchronous child exit code.");
    Console.WriteLine($"async exit: {process.ExitCode}");
}

using (var process = StartChild("--child-until-input"))
{
    try
    {
        bool exited = process.WaitForExit(50);
        Require(!exited, "A timed-out wait must leave the child running.");
        Console.WriteLine($"timed wait exited: {exited}");

        using var cancellation = new CancellationTokenSource(50);
        bool canceled = false;
        try
        {
            await process.WaitForExitAsync(cancellation.Token);
        }
        catch (OperationCanceledException)
        {
            canceled = true;
        }

        Require(canceled && !process.HasExited, "Canceling the wait must not kill the child.");
        Console.WriteLine("canceled wait; child still running");

        process.StandardInput.Close();
        await process.WaitForExitAsync();
        Require(process.ExitCode == 0, "The released child must exit normally.");
        Console.WriteLine($"released child exit: {process.ExitCode}");
    }
    finally
    {
        if (!process.HasExited)
        {
            try { process.Kill(); }
            catch (InvalidOperationException) when (process.HasExited) { }
            await process.WaitForExitAsync();
        }
    }
}

return 0;

static Process StartChild(string mode)
{
    var start = new ProcessStartInfo
    {
        FileName = Environment.ProcessPath ?? throw new InvalidOperationException("No process path."),
        UseShellExecute = false,
        RedirectStandardInput = mode == "--child-until-input"
    };

    if (string.Equals(Path.GetFileNameWithoutExtension(start.FileName), "dotnet", StringComparison.OrdinalIgnoreCase))
        start.ArgumentList.Add(Assembly.GetExecutingAssembly().Location);

    start.ArgumentList.Add(mode);
    return Process.Start(start) ?? throw new InvalidOperationException("Child did not start.");
}

static void Require(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}
```

Ожидаемый вывод:

```text
sync exit: 7
async exit: 7
timed wait exited: False
canceled wait; child still running
released child exit: 0
```

## Тайм-ауты, отмена и очистка ресурсов

`WaitForExit(50)` возвращает `false`, если дочерний процесс не завершился за указанное число миллисекунд. `WaitForExitAsync(token)` выбрасывает `OperationCanceledException` при отмене ожидания. Ни один из этих результатов не завершает дочерний процесс. В примере закрытие его входного потока позволяет завершиться нормально; блок `finally` при необходимости очистки после ошибки завершает только дочерний процесс, созданный этим примером.

Для реальной утилиты явно выберите способ завершения: продолжить ожидание, запросить штатное завершение по её протоколу или при необходимости принудительно завершить процесс. `Kill()` запрашивает принудительное завершение, поэтому после него тоже следует дождаться выхода процесса. Вызов `Dispose` у `Process` освобождает ресурсы компонента, но не останавливает работающую программу.

В [руководстве по объявлению using в C#](/ru/2020/05/c-using-var-using-declaration/) объясняется, как `using` управляет освобождением ресурсов при выходе из области видимости.

Если вы перенаправляете стандартный вывод или поток ошибок, начинайте читать их до ожидания завершения. Иначе заполненный канал может привести к тому, что дочерний процесс ждёт родителя, а родитель — дочерний процесс. В [руководстве по захвату вывода процессов](/ru/2026/05/dotnet-11-process-api-deadlock-free-capture/) рассматривается эта отдельная задача и новые API .NET 11; здесь используются API, доступные уже в .NET 8.

Проверено локально на macOS arm64 с настоящими средами выполнения .NET 8.0.33 и .NET 10.0.10, как через сгенерированный apphost, так и через `dotnet ProcessWait.dll`. Это не утверждение о выполнении на Windows или Linux; архив содержит точный протокол проверки.

Справочники API: [WaitForExit](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.waitforexit), [WaitForExitAsync](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.waitforexitasync) и [Kill](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.kill).
