---
title: ".NET 11 RC 1 permite enviar SIGTERM para um processo filho sem P/Invoke"
description: "Signal, WaitForExitStatus e ProcessExitStatus chegam diretamente em System.Diagnostics.Process no .NET 11 RC 1, então encerrar um processo filho de forma limpa não exige mais um P/Invoke para kill nem um desvio por SafeProcessHandle."
pubDate: 2026-09-09
tags:
  - "dotnet-11"
  - "csharp"
  - "process"
  - "dotnet"
lang: "pt-br"
translationOf: "2026/09/dotnet-11-rc-1-process-signal-exit-status"
translatedBy: "claude"
translationDate: 2026-09-09
---

O [.NET 11 Release Candidate 1](https://devblogs.microsoft.com/dotnet/dotnet-11-rc-1/) saiu em 2026-09-08 com licença go-live. A seção de bibliotecas começa com algo que irrita qualquer pessoa que já tenha supervisionado um processo filho a partir do C#: `System.Diagnostics.Process` agora envia sinais POSIX e informa como o processo realmente morreu, sem descer até `SafeProcessHandle` ([dotnet/runtime#131165](https://github.com/dotnet/runtime/pull/131165)).

## Kill() sempre foi um SIGKILL

`Process.Kill()` no Unix é `SIGKILL`. O filho não tem chance de esvaziar um buffer, fechar um socket ou rodar um handler de encerramento. Isso serve para um processo descontrolado e é errado para quase todo o resto: um servidor de desenvolvimento, uma transcodificação com `ffmpeg`, um contêiner Postgres, um arcabouço de testes que você quer parar de forma limpa.

A alternativa era um P/Invoke:

```csharp
[LibraryImport("libc", SetLastError = true)]
private static partial int kill(int pid, int sig);

// 15 on Linux and macOS, but you had to know that
kill(process.Id, 15);
```

São três linhas de suposições sobre a plataforma, um número de sinal fixo no código e nenhuma forma de saber se o sinal foi realmente entregue.

## A superfície de API do RC 1

O RC 1 adiciona quatro membros a `Process`:

```csharp
public bool Signal(PosixSignal signal);
public ProcessExitStatus WaitForExitStatus();
public bool TryWaitForExitStatus(TimeSpan timeout, out ProcessExitStatus? exitStatus);
public Task<ProcessExitStatus> WaitForExitStatusAsync(
    CancellationToken cancellationToken = default);
```

Isso já basta para escrever o padrão de escalonamento do jeito certo:

```csharp
using System.Diagnostics;
using System.Runtime.InteropServices;

using Process worker = Process.Start("./worker")!;

if (!worker.Signal(PosixSignal.SIGTERM))
{
    // false means the process is already gone, not that the call failed
    return;
}

if (!worker.TryWaitForExitStatus(TimeSpan.FromSeconds(10), out ProcessExitStatus? status))
{
    worker.Signal(PosixSignal.SIGKILL);
    status = worker.WaitForExitStatus();
}

Console.WriteLine($"exit={status.ExitCode} signal={status.Signal}");
```

## ProcessExitStatus acaba com o chute no código de saída

`ProcessExitStatus` é uma classe pequena marcada como sealed com três propriedades: `ExitCode`, `Canceled` e um `PosixSignal? Signal` anulável. O sinal anulável é a parte útil. Até agora você inferia a morte por sinal a partir da convenção `128 + signal number` embutida no código de saída, que colide silenciosamente com qualquer processo que saia legitimamente com 143. Agora `status.Signal is PosixSignal.SIGTERM` responde a pergunta direto, e `Canceled` informa se a espera terminou pelo seu tempo limite ou pelo seu `CancellationToken` em vez de pelo filho.

É o mesmo `ProcessExitStatus` retornado por `Process.RunAndCaptureText` e afins, que eu cobri quando [as APIs de captura sem deadlock chegaram no Preview 4](/pt-br/2026/05/dotnet-11-process-api-deadlock-free-capture/).

## Onde isso não funciona

Três limites que vale conhecer antes de escrever código supervisor multiplataforma:

- `Signal` é anotado com `[UnsupportedOSPlatform("ios")]` e `[UnsupportedOSPlatform("tvos")]`. Mac Catalyst é suportado.
- No Windows apenas `PosixSignal.SIGKILL` é aceito, e ele é mapeado para `TerminateProcess`. Qualquer outro sinal lança `PlatformNotSupportedException`, então um caminho primeiro limpo e depois forçado precisa de um desvio com `OperatingSystem.IsWindows()`.
- No Unix, `WaitForExitStatus` só funciona para um filho do processo atual. Esperar por um `Process` ao qual você se anexou pelo PID lança uma exceção.

A lista completa está nas [notas de versão das bibliotecas do RC 1](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/rc1/libraries.md). Com a licença go-live junto, este é o primeiro RC que você pode colocar por trás de uma supervisão de processos em produção.
