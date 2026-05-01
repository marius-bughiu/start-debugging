---
title: "C# Как дождаться завершения процесса?"
description: "Дождаться завершения процесса можно с помощью метода WaitForExit. Ваш код синхронно подождёт, пока процесс завершится, и затем продолжит выполнение. Рассмотрим пример: Этот код запустит новый процесс cmd.exe и выполнит команду timeout 5. Вызов process.WaitForExit() заставит вашу программу..."
pubDate: 2023-08-11
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
lang: "ru"
translationOf: "2023/08/c-how-to-wait-for-a-process-to-end"
translatedBy: "claude"
translationDate: 2026-05-01
---
Дождаться завершения процесса можно с помощью метода `WaitForExit`. Ваш код синхронно подождёт, пока процесс завершится, и затем продолжит выполнение.

Рассмотрим пример:

```cs
var process = new Process
{
    StartInfo = new ProcessStartInfo
    {
        WindowStyle = ProcessWindowStyle.Hidden,
        FileName = "cmd.exe",
        Arguments = "/C timeout 5"
    }
};

process.Start();
process.WaitForExit();
```

Этот код запустит новый процесс `cmd.exe` и выполнит команду `timeout 5`. Вызов `process.WaitForExit()` заставит программу дождаться, пока процесс закончит выполнение команды `timeout`. После этого выполнение потока возобновится.
