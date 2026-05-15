---
title: ".NET 11 добавляет захват вывода процессов без взаимных блокировок"
description: ".NET 11 Preview 4 представляет новые API System.Diagnostics.Process, которые параллельно вычитывают stdout и stderr, плюс однострочные хелперы запуска с захватом и KillOnParentExit."
pubDate: 2026-05-15
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "process"
lang: "ru"
translationOf: "2026/05/dotnet-11-process-api-deadlock-free-capture"
translatedBy: "claude"
translationDate: 2026-05-15
---

Адам Ситник [объявил](https://devblogs.microsoft.com/dotnet/process-api-improvements-in-dotnet-11/) о наборе улучшений `System.Diagnostics.Process`, которые попали в .NET 11 Preview 4. Главное: ловушка дедлока, в которую хотя бы раз попадает каждый .NET-разработчик, наконец-то решена на уровне BCL, а шаблонный код "запустить процесс, захватить вывод, дождаться завершения" сворачивается в один вызов.

## Почему старый шаблон приводит к взаимной блокировке

Классическая форма выглядит безопасной, но это не так:

```csharp
var psi = new ProcessStartInfo("git", "log")
{
    RedirectStandardOutput = true,
    RedirectStandardError = true,
};
using var p = Process.Start(psi)!;
string stdout = p.StandardOutput.ReadToEnd();
string stderr = p.StandardError.ReadToEnd();
p.WaitForExit();
```

Если дочерний процесс записывает в `stderr` больше, чем помещается в буфер канала, до того как родительский процесс доберётся до `stderr.ReadToEnd()`, дочерний процесс блокируется на заполненном канале, а родительский ожидает закрытия `stdout`. Оба ждут вечно. Документированным обходным путём была API на событиях с `OutputDataReceived`, ручными `StringBuilder` и отдельным `ManualResetEvent` для каждого потока. Это работает, но никто не пишет такой код правильно с первой попытки.

## Новые однострочники

.NET 11 добавляет `Process.RunAndCaptureText` и `Process.RunAndCaptureTextAsync`, которые внутри мультиплексируют оба канала:

```csharp
ProcessTextOutput result = await Process.RunAndCaptureTextAsync(
    "git",
    ["log", "--oneline", "-n", "20"]);

if (result.ExitStatus.ExitCode != 0)
    throw new InvalidOperationException(result.StandardError);

Console.WriteLine(result.StandardOutput);
```

`ProcessTextOutput` содержит захваченные stdout, stderr, идентификатор процесса и `ProcessExitStatus`, который сообщает как код завершения, так и, в Unix, сигнал, прервавший процесс. Есть и родственный `Process.ReadAllText` для вызывающих, у которых уже есть запущенный `Process`, плюс `ReadAllLines/Async` для потоковой выдачи `IEnumerable<ProcessOutputLine>` с флагом `StandardError` для каждой строки, и `ReadAllBytes/Async` для бинарных инструментов. По данным блога, синхронный `RunAndCaptureText` под Windows аллоцирует примерно в 4.5 раза меньше памяти, чем эквивалентный цикл на событиях.

## Время жизни и отвязка

Две давние ловушки тоже получают полноценную поддержку. `ProcessStartInfo.KillOnParentExit` связывает дочерний процесс с временем жизни родителя в Windows, Linux и Android, поэтому падающий CLI-инструмент больше не оставляет осиротевших воркеров. `ProcessStartInfo.StartDetached` делает обратное: дочерний процесс переживает родителя и терминал, из которого он был запущен. А `Process.StartAndForget` возвращает только PID и сразу освобождает handle родителя, что и нужно для запусков по принципу "запустил и забыл":

```csharp
int pid = Process.StartAndForget("notepad.exe");
```

## Работа с handle

Для более низкоуровневых сценариев `ProcessStartInfo.StandardInputHandle`, `StandardOutputHandle` и `StandardErrorHandle` принимают любой `SafeFileHandle`, включая каналы из нового `SafeFileHandle.CreateAnonymousPipe` и приёмник-заглушку из `File.OpenNullHandle`. `ProcessStartInfo.InheritedHandles` позволяет в белом списке указать, какие именно handle пересекают границу fork, и закрывает реальный источник утечек файловых блокировок в Windows.

Попробуйте на [.NET 11 Preview 4](https://dotnet.microsoft.com/en-us/download/dotnet/11.0) и начинайте удалять обработчики `OutputDataReceived`.
