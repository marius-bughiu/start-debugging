---
title: "Process.Run vs Process.Start no .NET 11: qual usar?"
description: "Use Process.Run quando você inicia uma ferramenta e só se importa com como ela terminou: uma chamada, um timeout que mata o processo filho e um ProcessExitStatus com o sinal. Mantenha Process.Start quando você precisa do objeto Process: escrever no stdin, ler a saída conforme ela chega, UseShellExecute ou matar uma árvore de processos inteira."
pubDate: 2026-09-17
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "process"
lang: "pt-br"
translationOf: "2026/09/process-run-vs-process-start-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-09-17
---

**Use `Process.Run` (ou `Process.RunAsync`) sempre que você inicia um processo, deixa ele terminar e só precisa saber como ele terminou.** É uma chamada só, não tem como vazar um handle de `Process`, o timeout ou o `CancellationToken` realmente matam o processo filho, e ele retorna um `ProcessExitStatus` que diz se o filho terminou normalmente, foi morto por um sinal ou foi morto por você. **Mantenha `Process.Start` quando você precisa do objeto `Process` vivo**: escrever no stdin, ler a saída linha por linha enquanto o processo roda, `UseShellExecute` para abrir uma URL ou um documento, o evento `Exited`, ou `Kill(entireProcessTree: true)` para ferramentas que criam seus próprios workers. O desempenho não decide nada: os dois mediram cerca de 740 microssegundos por spawn no .NET 11 RC 1. Tudo abaixo foi verificado no .NET 11 RC 1 (SDK `11.0.100-rc.1.26425.128`, runtime `11.0.0-rc.1.26425.128`, C# 15) no macOS 26.6 com um Apple M4.

## As duas APIs lado a lado

| Comportamento (.NET 11 RC 1)              | `Process.Run` / `RunAsync`                          | `Process.Start` + `WaitForExit`                  |
| ----------------------------------------- | --------------------------------------------------- | ------------------------------------------------ |
| Disponível em                             | .NET 11+                                            | todas as versões do .NET                         |
| Retorna                                   | `ProcessExitStatus`                                 | `Process` (precisa de dispose)                   |
| stdin/stdout/stderr padrão                | herdados do pai (ou null com `silent: true`)        | herdados do pai                                  |
| `RedirectStandardOutput = true`           | `InvalidOperationException`                         | sim                                              |
| Escrever no stdin durante a execução      | não                                                 | sim                                              |
| `UseShellExecute = true`                  | `InvalidOperationException`                         | sim                                              |
| Timeout                                   | mata o filho, `Canceled = true`                     | `WaitForExit(TimeSpan)` retorna `false`, o filho continua rodando |
| Cancelamento (assíncrono)                 | mata o filho, sem exceção                           | `WaitForExitAsync(ct)` lança, o filho continua rodando |
| Sinal de término                          | `ProcessExitStatus.Signal`                          | adivinhar pelo `ExitCode` (137, 143)             |
| Matar netos no timeout                    | não, só o filho direto                              | `Kill(entireProcessTree: true)`                  |
| ID do processo                            | não retornado                                       | `Process.Id`                                     |
| Spawn de `/usr/bin/true`, síncrono        | 737.0 us, 16.56 KB                                  | 739.4 us, 16.84 KB                               |

As cinco primeiras linhas decidem a maioria dos casos. Se o seu ponto de chamada usa `StandardInput`, `BeginOutputReadLine` ou `UseShellExecute`, `Process.Run` nem é uma opção. Se não usa nenhum deles, `Process.Run` é mais curto e tem padrões mais seguros.

## O que Process.Run realmente faz

`Process.Run` chegou no .NET 11 Preview 4 junto com `RunAndCaptureText` e `StartAndForget`, como parte da [reformulação da API Process](https://devblogs.microsoft.com/dotnet/process-api-improvements-in-dotnet-11/) que eu cobri quando [chegou a captura de saída sem deadlock](/pt-br/2026/05/dotnet-11-process-api-deadlock-free-capture/). A superfície no RC 1 é:

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

Dois detalhes diferem do post do blog do Preview 4. O Preview 7 mudou `arguments` de `IList<string>?` para `IEnumerable<string>?` ([dotnet/runtime#130630](https://github.com/dotnet/runtime/pull/130630)), e as sobrecargas com `fileName` ganharam uma flag `silent` que aponta stdin, stdout e stderr para o dispositivo nulo.

A implementação em [`Process.Scenarios.cs`](https://github.com/dotnet/runtime/blob/v11.0.0-rc.1.26425.128/src/libraries/System.Diagnostics.Process/src/System/Diagnostics/Process.Scenarios.cs) é curta o suficiente para resumir com exatidão. Ela nunca cria um objeto `Process`. Ela chama `SafeProcessHandle.Start(startInfo)`, depois `WaitForExit()` ou `WaitForExitOrKillOnTimeout(timeout)`, e faz dispose do handle antes de retornar. `RunAsync` faz o mesmo com `WaitForExitOrKillOnCancellationAsync`. É por isso que ela não tem como vazar um handle, e também por isso que ela rejeita tudo o que precisa de um `Process` para ser conduzido: as flags `RedirectStandard*` só fazem sentido se alguém segura `Process.StandardOutput` e o drena.

`ProcessExitStatus` tem três propriedades: `ExitCode`, `Canceled` e um `PosixSignal? Signal` anulável. O mesmo tipo volta dos [novos métodos `Process.WaitForExitStatus` no RC 1](/pt-br/2026/09/dotnet-11-rc-1-process-signal-exit-status/).

## A mesma tarefa escrita das duas formas

Este é o caso do dia a dia: rodar `dotnet build`, deixar a saída ir para o console, falhar se ele falhar e desistir depois de cinco minutos.

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

A versão com `Process.Start` está correta, mas só porque lembra de duas coisas que as pessoas esquecem com frequência: `WaitForExit(TimeSpan)` não mata nada no timeout, e o `Process` precisa de dispose. A versão com `Process.Run` não tem como errar em nenhuma das duas. Note, porém, que mantive `entireProcessTree: true` na primeira versão de propósito. Mais sobre isso nas armadilhas.

## Timeouts e cancelamento se comportam de forma diferente

Esta é a diferença que pega quem migra com localizar e substituir. Rodei os dois contra `sleep 10` com um limite de 500 ms no .NET 11 RC 1:

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

Três coisas para tirar dessa saída:

1. **`RunAsync` não lança exceção no cancelamento.** Ele mata o filho com `SIGKILL` (ou `TerminateProcess` no Windows), espera ele terminar e retorna um status com `Canceled = true`. Código que o envolve em `catch (OperationCanceledException)` nunca vai entrar no bloco catch. Verifique `status.Canceled` em vez disso.
2. **`Process.WaitForExitAsync(ct)` só cancela a espera.** Ele lança `TaskCanceledException` e deixa o processo vivo. Se você queria ele morto, chame `Kill()` você mesmo.
3. **`Signal` acaba com a adivinhação do código de saída.** No Unix, um processo morto por `SIGKILL` reporta código de saída 137 e um morto por `SIGTERM` reporta 143, e um processo também pode simplesmente fazer `exit 137`. `ProcessExitStatus.Signal` diz qual deles aconteceu. Dentro de uma chamada a `Process.Run`, `Canceled` diz se quem matou foi você.

O `Run` síncrono recebe um `TimeSpan? timeout` e nenhum token; `RunAsync` recebe um token e nenhum timeout. Para um timeout assíncrono, use `new CancellationTokenSource(TimeSpan)` como acima. Se o cancelamento vem de uma requisição do ASP.NET Core ou de um hosted service, os padrões de [como cancelar uma Task de longa duração sem deadlock](/pt-br/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) se aplicam sem mudanças.

## Quando escolher Process.Run

- **Scripts de build e wrappers de CLI** que rodam `git`, `dotnet`, `npm` ou `docker` e deixam a saída ir direto para o console. Com o padrão `silent: false`, o filho herda os handles do pai, então cores e barras de progresso continuam funcionando.
- **Health checks e probes** em que só o código de saída importa. `Process.Run("pg_isready", ["-h", host], silent: true, timeout: TimeSpan.FromSeconds(3))` é a implementação inteira.
- **Ferramentas que nunca podem travar o seu serviço.** Os caminhos de timeout e cancelamento matam o filho por você, então um `ffprobe` travado não se acumula atrás de uma requisição.
- **Escrever a saída em um arquivo em vez do console.** `ProcessStartInfo.StandardOutputHandle` aceita qualquer `SafeFileHandle`, e `Run(ProcessStartInfo)` dá suporte a isso:

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

Se você precisa da saída em memória em vez de em um arquivo, pule as duas APIs e chame `Process.RunAndCaptureText`, que drena stdout e stderr de forma concorrente para que o clássico deadlock de redirecionamento não aconteça.

## Quando manter Process.Start

- **stdin interativo.** Passar uma senha para o `ssh-keygen`, enviar SQL por pipe para o `psql` ou conversar com um REPL exige `RedirectStandardInput` e `Process.StandardInput`. `Run` lança exceção com qualquer flag `RedirectStandard*`.
- **Saída em streaming enquanto o processo roda.** Uma UI de progresso que mostra as linhas do `ffmpeg` conforme aparecem precisa do `Process`. No .NET 11 você pode pelo menos abandonar os event handlers e usar `process.ReadAllLinesAsync(ct)`, que produz valores `ProcessOutputLine` dos dois streams sem deadlock.
- **Execução via shell.** `Process.Start(new ProcessStartInfo("https://startdebugging.net") { UseShellExecute = true })` continua sendo a forma de abrir uma URL ou um documento com o app padrão. `Run`, `RunAsync` e `StartAndForget` lançam exceção, porque no Windows a execução via shell pode nem criar um processo novo.
- **Árvores de processos.** Se o filho cria workers (nós do MSBuild, `npm` rodando `node`, um shell script), só `Process.Kill(entireProcessTree: true)` limpa tudo. Veja a próxima seção.
- **Você precisa do próprio `Process`**: `Id` para logging, o evento `Exited`, `PriorityClass` ou as sobrecargas `userName`/`password` exclusivas do Windows.
- **Você tem como alvo qualquer versão anterior ao .NET 11.** `Process.Run` não existe no .NET 10. Uma biblioteca com múltiplos targets precisa de `#if NET11_0_OR_GREATER`.

## O benchmark

O desempenho não é motivo para escolher nenhum dos dois, e eu medi para você não ficar na dúvida. Ambiente: .NET 11 RC 1 (`11.0.0-rc.1.26425.128`), BenchmarkDotNet 0.15.8 com o toolchain in-process emit (a 0.15.8 ainda não reconhece `net11.0` para execuções out-of-process), 3 iterações de aquecimento e 15 medidas, macOS 26.6.2, Apple M4 com 10 núcleos. Cada benchmark faz spawn de `/usr/bin/true` e espera por ele.

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

A diferença está dentro do ruído. Quase todo o custo é o sistema operacional criando o processo, e as duas APIs compartilham o mesmo caminho de start do `SafeProcessHandle`. Dispensar o objeto `Process` economiza cerca de 300 bytes. Os grandes ganhos do .NET 11 (start de processo 98x mais rápido no Apple Silicon, segundo as medições do time do .NET) valem igualmente para as duas APIs, porque ficam abaixo dessa camada.

## Armadilhas que decidem por você

**Um timeout mata só o filho direto.** Rodei `Process.Run("sh", ["-c", "sleep 31; true"], timeout: TimeSpan.FromMilliseconds(500))`. `Run` retornou `Canceled=True Signal=SIGKILL`, e `pgrep -f "sleep 31"` ainda encontrou o processo `sleep` depois, com novo pai e rodando. O mesmo teste com `Process.Start` e `Kill(entireProcessTree: true)` não deixou nada para trás. `dotnet build`, `npm run`, `docker compose` e a maioria dos shell scripts criam filhos, então se um timeout precisa deixar a máquina limpa, `Process.Start` com kill da árvore continua sendo a ferramenta certa. `ProcessStartInfo.KillOnParentExit` (só Windows, Linux e Android) não é substituto: ele dispara quando o seu processo termina, não quando um timeout expira.

**Não existe sobrecarga com argumentos em string.** `Process.Run("git", "status")` não compila, porque `string` não é `IEnumerable<string>`. Passe `["status"]`, ou monte um `ProcessStartInfo("git", "status")` e use a sobrecarga `Run(ProcessStartInfo)`.

**`silent: true` também anula o stdin.** Um filho que pede entrada, como o `git` pedindo credenciais, lê fim de arquivo imediatamente em vez de travar. Isso costuma ser o que você quer em um serviço e surpreendente em um script de desenvolvimento.

**`Run(ProcessStartInfo)` rejeita o seu start info existente.** Se você migra um `ProcessStartInfo` que ainda tem `RedirectStandardOutput = true`, recebe `InvalidOperationException: The RedirectStandardInput, RedirectStandardOutput, and RedirectStandardError properties cannot be used by SafeProcessHandle.Start or Process.StartAndForget`. A mensagem não menciona nem `Run` nem `RunAsync`, mas é a mesma verificação. Troque a flag por `StandardOutputHandle`, ou mude para `RunAndCaptureText`.

**Falhas ao iniciar são idênticas.** Um executável ausente lança o mesmo `Win32Exception` ("No such file or directory") nas duas APIs, então o tratamento de erros existente continua valendo.

**Nenhum dos dois tem suporte no iOS ou tvOS.** Os dois carregam `[UnsupportedOSPlatform("ios")]` e `[UnsupportedOSPlatform("tvos")]`, e o Mac Catalyst tem suporte. O analisador de plataforma sinaliza as chamadas em um projeto MAUI de qualquer forma.

## A decisão

Para código novo no .NET 11 que roda um processo até o fim, use por padrão `Process.Run` ou `Process.RunAsync`. Eles eliminam os três erros mais comuns em código de processos (o `Process` sem dispose, o timeout que não mata, o código de saída que esconde um sinal) sem custo mensurável. Passe para `Process.RunAndCaptureText` no momento em que você precisar da saída como string. Recorra a `Process.Start` só quando o processo precisa ser conduzido enquanto roda, aberto via shell ou derrubado como uma árvore inteira. Esse último caso importa mais do que parece, porque muitas ferramentas que você envolveria em `Process.Run` silenciosamente criam filhos que o timeout dele não alcança. Se você ainda mantém código antigo que bloqueia em `WaitForExit`, os [padrões básicos de espera pelo fim do processo](/pt-br/2023/08/c-how-to-wait-for-a-process-to-end/) são onde o código com `Process.Start` costuma começar, e vale revisitá-los com esses padrões em mente.

### Relacionados

- [O .NET 11 adiciona captura de saída de processos sem deadlock](/pt-br/2026/05/dotnet-11-process-api-deadlock-free-capture/)
- [O .NET 11 RC 1 permite enviar SIGTERM a um processo filho sem P/Invoke](/pt-br/2026/09/dotnet-11-rc-1-process-signal-exit-status/)
- [C#: como esperar um processo terminar](/pt-br/2023/08/c-how-to-wait-for-a-process-to-end/)
- [Como cancelar uma Task de longa duração em C# sem deadlock](/pt-br/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- [.Result e .Wait() vs GetAwaiter().GetResult() vs await em C#](/pt-br/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/)

### Fontes

- [Process API improvements in .NET 11](https://devblogs.microsoft.com/dotnet/process-api-improvements-in-dotnet-11/), .NET Blog
- [`Process.Scenarios.cs`](https://github.com/dotnet/runtime/blob/v11.0.0-rc.1.26425.128/src/libraries/System.Diagnostics.Process/src/System/Diagnostics/Process.Scenarios.cs) e [`SafeProcessHandle.cs`](https://github.com/dotnet/runtime/blob/v11.0.0-rc.1.26425.128/src/libraries/System.Diagnostics.Process/src/Microsoft/Win32/SafeHandles/SafeProcessHandle.cs) na tag `v11.0.0-rc.1.26425.128`, dotnet/runtime
- [Implement Process.Run, RunAsync, RunAndCaptureText, RunAndCaptureTextAsync](https://github.com/dotnet/runtime/pull/127210), PR do dotnet/runtime
- [Notas de versão das bibliotecas do .NET 11 Preview 7](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview7/libraries.md) (a mudança nos argumentos para `IEnumerable<string>`), dotnet/core
- [Novidades nas bibliotecas do .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/libraries), MS Learn
- [Método `Process.Start`](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.start), MS Learn
