---
title: "C# como esperar um processo terminar?"
description: "Você pode usar o método WaitForExit para esperar o processo finalizar. Seu código espera de forma síncrona até o processo terminar e então retoma a execução. Veja um exemplo: O código acima inicia um novo processo cmd.exe e executa o comando timeout 5. A chamada process.WaitForExit() força o programa..."
pubDate: 2023-08-11
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
lang: "pt-br"
translationOf: "2023/08/c-how-to-wait-for-a-process-to-end"
translatedBy: "claude"
translationDate: 2026-05-01
---
Você pode usar o método `WaitForExit` para esperar o processo finalizar. Seu código espera de forma síncrona até o processo terminar e então retoma a execução.

Veja um exemplo:

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

O código acima inicia um novo processo `cmd.exe` e executa o comando `timeout 5`. A chamada `process.WaitForExit()` força o programa a esperar até o processo terminar de executar o `timeout`. Depois disso, a execução da thread continua normalmente.
