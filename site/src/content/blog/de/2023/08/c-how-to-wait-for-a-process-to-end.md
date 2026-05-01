---
title: "C# Wie warten Sie, bis ein Prozess endet?"
description: "Mit der Methode WaitForExit können Sie auf das Ende eines Prozesses warten. Ihr Code wartet synchron, bis der Prozess fertig ist, und führt dann die Ausführung fort. Sehen wir uns ein Beispiel an: Der Code oben startet einen neuen cmd.exe-Prozess und führt den Befehl timeout 5 aus. Der Aufruf process.WaitForExit() zwingt Ihr Programm..."
pubDate: 2023-08-11
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
lang: "de"
translationOf: "2023/08/c-how-to-wait-for-a-process-to-end"
translatedBy: "claude"
translationDate: 2026-05-01
---
Mit der Methode `WaitForExit` können Sie auf das Ende eines Prozesses warten. Ihr Code wartet synchron, bis der Prozess fertig ist, und führt die Ausführung anschließend fort.

Sehen wir uns ein Beispiel an:

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

Der Code oben startet einen neuen `cmd.exe`-Prozess und führt darin den Befehl `timeout 5` aus. Der Aufruf von `process.WaitForExit()` zwingt Ihr Programm zu warten, bis der Prozess den `timeout`-Befehl abgearbeitet hat. Danach wird die Ausführung des Threads fortgesetzt.
