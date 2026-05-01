---
title: "C# ¿Cómo esperar a que termine un proceso?"
description: "Puedes usar el método WaitForExit para esperar a que el proceso se complete. Tu código esperará de forma síncrona hasta que el proceso termine y entonces continuará la ejecución. Veamos un ejemplo: El código anterior inicia un nuevo proceso cmd.exe y ejecuta el comando timeout 5. La llamada a process.WaitForExit() obligará a tu programa..."
pubDate: 2023-08-11
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
lang: "es"
translationOf: "2023/08/c-how-to-wait-for-a-process-to-end"
translatedBy: "claude"
translationDate: 2026-05-01
---
Puedes usar el método `WaitForExit` para esperar a que el proceso se complete. Tu código esperará de forma síncrona hasta que el proceso termine y entonces continuará la ejecución.

Veamos un ejemplo:

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

El código anterior inicia un nuevo proceso `cmd.exe` y ejecuta el comando `timeout 5`. La llamada a `process.WaitForExit()` obligará a tu programa a esperar hasta que el proceso termine de ejecutar el comando `timeout`. Después se reanudará la ejecución del hilo.
