---
title: ".NET 11 adiciona captura de saída de processos livre de deadlock"
description: ".NET 11 Preview 4 traz novas APIs em System.Diagnostics.Process que drenam stdout e stderr em paralelo, helpers de uma linha para executar e capturar, e KillOnParentExit."
pubDate: 2026-05-15
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "process"
lang: "pt-br"
translationOf: "2026/05/dotnet-11-process-api-deadlock-free-capture"
translatedBy: "claude"
translationDate: 2026-05-15
---

Adam Sitnik [anunciou](https://devblogs.microsoft.com/dotnet/process-api-improvements-in-dotnet-11/) uma rodada de melhorias em `System.Diagnostics.Process` que entraram no .NET 11 Preview 4. O ponto principal é que a armadilha de deadlock que todo desenvolvedor .NET pisa pelo menos uma vez finalmente foi resolvida no nível da BCL, e o código repetitivo de "iniciar um processo, capturar a saída, aguardar" se reduz a uma única chamada.

## Por que o padrão antigo causa deadlock

A forma clássica parece segura e não é:

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

Se o processo filho escrever em `stderr` mais do que cabe no buffer do pipe antes do processo pai chegar em `stderr.ReadToEnd()`, o filho trava esperando o pipe esvaziar e o pai trava esperando o `stdout` fechar. Os dois ficam esperando para sempre. A solução documentada era a API baseada em eventos com `OutputDataReceived`, `StringBuilder` manuais e um `ManualResetEvent` por stream. Funciona, mas ninguém escreve isso corretamente na primeira tentativa.

## Os novos one-liners

O .NET 11 adiciona `Process.RunAndCaptureText` e `Process.RunAndCaptureTextAsync`, que multiplexam os dois pipes internamente:

```csharp
ProcessTextOutput result = await Process.RunAndCaptureTextAsync(
    "git",
    ["log", "--oneline", "-n", "20"]);

if (result.ExitStatus.ExitCode != 0)
    throw new InvalidOperationException(result.StandardError);

Console.WriteLine(result.StandardOutput);
```

`ProcessTextOutput` carrega o stdout capturado, o stderr, o ID do processo e um `ProcessExitStatus` que reporta tanto o código de saída quanto, no Unix, o sinal de término. Existe um irmão `Process.ReadAllText` para quem já tem um `Process` rodando, além de `ReadAllLines/Async` para transmitir `IEnumerable<ProcessOutputLine>` com uma flag `StandardError` em cada linha, e `ReadAllBytes/Async` para ferramentas binárias. Segundo o blog, o `RunAndCaptureText` síncrono aloca cerca de 4.5x menos memória que o loop equivalente baseado em eventos no Windows.

## Tempo de vida e desanexação

Dois problemas antigos também ganham suporte de primeira classe. `ProcessStartInfo.KillOnParentExit` amarra o filho ao ciclo de vida do pai no Windows, Linux e Android, de forma que uma ferramenta de CLI que quebra não deixa mais workers órfãos. `ProcessStartInfo.StartDetached` é o oposto: o filho sobrevive ao pai e ao terminal que o iniciou. E `Process.StartAndForget` devolve apenas o PID e libera imediatamente o handle do pai, que é o que você quer para lançamentos "fire and forget":

```csharp
int pid = Process.StartAndForget("notepad.exe");
```

## Encanamento de handles

Para cenários de mais baixo nível, `ProcessStartInfo.StandardInputHandle`, `StandardOutputHandle` e `StandardErrorHandle` aceitam qualquer `SafeFileHandle`, incluindo pipes do novo `SafeFileHandle.CreateAnonymousPipe` e o sumidouro de descarte do `File.OpenNullHandle`. `ProcessStartInfo.InheritedHandles` permite que você liste explicitamente quais handles cruzam a fronteira do fork, o que fecha uma fonte real de vazamentos de lock de arquivo no Windows.

Teste no [.NET 11 Preview 4](https://dotnet.microsoft.com/en-us/download/dotnet/11.0) e comece a apagar handlers `OutputDataReceived`.
