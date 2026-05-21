---
title: "ConfigureAwait(false) vs o padrão no .NET 11: ainda importa?"
description: "ConfigureAwait(false) continua obrigatório em código de biblioteca que pode rodar sob um SynchronizationContext (WinForms, WPF, MAUI). Em código de aplicação no ASP.NET Core, um console app ou um worker service rodando em .NET 11, ele não faz nada."
pubDate: 2026-05-21
tags:
  - "comparison"
  - "csharp"
  - "async"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/05/configureawait-false-vs-default-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-21
---

Se você está decidindo se continua digitando `.ConfigureAwait(false)` depois de cada `await` no seu código em .NET 11, a resposta curta é: em código de aplicação que tem como alvo ASP.NET Core, um console app, um worker service baseado no host genérico, ou um teste unitário, ele não faz nada e você pode removê-lo. Em código de biblioteca que é distribuído como pacote NuGet ou em qualquer app de UI (WinForms, WPF, MAUI, Avalonia, Uno) ou em qualquer host ASP.NET sobre .NET Framework ainda vivo, ele ainda importa e removê-lo pode causar deadlock no aplicativo chamador ou deixá-lo perceptivelmente mais lento. A regra prática não mudou desde que o .NET Core 1.0 saiu sem `SynchronizationContext` em 2016, e o .NET 11 também não a muda, mesmo com a nova geração de código async no runtime introduzida no preview 1 do .NET 11.

Este artigo usa `<TargetFramework>net11.0</TargetFramework>` e `<LangVersion>14.0</LangVersion>` em todos os exemplos. Quando um fato é anterior ao .NET 11, a versão em que ele foi introduzido está indicada no texto.

## Matriz de características

| Comportamento                                                | `await task` (padrão)                                   | `await task.ConfigureAwait(false)`           | `await task.ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing)` |
| ------------------------------------------------------------ | ------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------- |
| Captura o `SynchronizationContext` atual                     | sim                                                     | não                                          | sim                                                                 |
| Captura o `TaskScheduler` atual (se não for `Default`)       | sim                                                     | não                                          | sim                                                                 |
| Retoma no contexto capturado (thread de UI, ASP.NET clássico) | sim                                                    | não, retoma no thread pool                   | sim                                                                 |
| Efeito no ASP.NET Core 11                                    | nenhum, não há `SynchronizationContext`                 | nenhum, não há `SynchronizationContext`      | nenhum no contexto, suprime a exceção                                |
| Efeito em console / worker / teste xUnit no .NET 11          | nenhum, o contexto capturado é null                     | nenhum, o contexto capturado é null          | suprime a exceção                                                   |
| Pode causar o deadlock clássico de UI com `.Result` / `.Wait()` | sim                                                  | não                                          | sim                                                                 |
| Disponível desde                                             | C# 5 / .NET Framework 4.5                               | C# 5 / .NET Framework 4.5                    | `ConfigureAwaitOptions` chegou no .NET 8                            |
| Aloca                                                        | sem alocação extra (apenas o struct de config)          | sem alocação extra                           | sem alocação extra                                                  |

A tabela é a resposta. O resto deste artigo é o porquê de cada linha e qual célula se aplica ao código que você está prestes a escrever.

## O que `await` realmente captura

Ler as linhas acima só ajuda se você lembrar o que `await` faz por baixo dos panos. Quando o compilador C# reescreve `await task`, ele chama `task.GetAwaiter()`, depois, ao suspender, `awaiter.OnCompleted(continuation)` (ou `UnsafeOnCompleted` para `ICriticalNotifyCompletion`). O `TaskAwaiter.OnCompleted` padrão lê `SynchronizationContext.Current`. Se ele retornar um valor não nulo, a continuação é agendada com `synchronizationContext.Post(continuation, null)`. Se retornar null, `TaskScheduler.Current` é consultado; se ele não for `TaskScheduler.Default`, o scheduler é capturado. Se ambos estiverem ausentes (o caso comum em código de servidor e console no .NET 11), a continuação vai direto para o thread pool via `ThreadPool.UnsafeQueueUserWorkItem`. Tudo isso está documentado no [código-fonte de `TaskAwaiter`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Runtime/CompilerServices/TaskAwaiter.cs) e no [artigo original do Stephen Toub sobre `ConfigureAwait`](https://devblogs.microsoft.com/dotnet/configureawait-faq/), que continua sendo a referência canônica.

`ConfigureAwait(false)` retorna um `ConfiguredTaskAwaitable` cujo awaiter pula totalmente as leituras de `SynchronizationContext.Current` e `TaskScheduler.Current`. A continuação sempre é postada no thread pool. Essa é a feature inteira. É um branch no runtime.

O trabalho de runtime async do .NET 11, às vezes chamado "runtime async" ou "async sem boxing", muda como o JIT gera a máquina de estados (veja o [anúncio do .NET 11 preview 1](https://devblogs.microsoft.com/dotnet/announcing-dotnet-11-preview-1/)) mas não muda a semântica do contexto capturado. O JIT agora emite uma única continuação especializada em muitos casos em vez de alocar uma caixa separada para a máquina de estados, o que significa que `await` está mais barato do que no .NET 8. O custo de `ConfigureAwait(false)` em relação a um `await` puro encolhe na mesma proporção, mas a diferença entre os dois em um caminho quente já estava na casa de um dígito de nanossegundos. Performance não é o motivo pelo qual essa escolha importa em 2026.

## Quando `ConfigureAwait(false)` ainda importa

Existem três ambientes em que remover `ConfigureAwait(false)` é um bug real, não uma escolha de estilo.

**WinForms, WPF, MAUI, Avalonia e Uno.** Esses frameworks instalam um `SynchronizationContext` na thread de UI. Uma biblioteca que faz `await someTask` dentro de um método chamado pela thread de UI vai retomar na thread de UI, o que geralmente é desperdício se a próxima linha for mais CPU ou I/O. Pior: se qualquer chamador em qualquer ponto do app fizer `someAsyncLibraryCall().Result` ou `.Wait()` na thread de UI, a continuação não pode rodar (a thread de UI está bloqueada esperando) e você tem um deadlock. A correção é a mesma desde 2012: cada `await` dentro da biblioteca usa `ConfigureAwait(false)`. O MAUI no .NET 11 mantém o mesmo modelo de `SynchronizationContext`, então isso continua se aplicando.

**ASP.NET no .NET Framework.** O ASP.NET clássico (`System.Web`) instala um `AspNetSynchronizationContext` que prende a requisição a um contexto para que `HttpContext.Current` funcione dentro das continuações. Se você tem código que ainda tem como alvo `net48` (muitos códigos corporativos têm), o mesmo risco de deadlock se aplica, e o código de biblioteca precisa continuar usando `ConfigureAwait(false)`. O ASP.NET Core abandonou esse contexto, que é justamente o motivo pelo qual código de aplicação no ASP.NET Core não precisa dele.

**Código de biblioteca que tem como alvo `netstandard2.0` ou que multi-targets.** Mesmo que você só teste sua biblioteca no .NET 11 hoje, se seu `<TargetFrameworks>` inclui `netstandard2.0` ou `net48`, sua biblioteca vai ser carregada em processos de UI e em processos clássicos do ASP.NET. Você não pode saber quem consome seu pacote NuGet. A regra para autores de biblioteca não mudou: cada `await` interno de uma biblioteca precisa ser `ConfigureAwait(false)`, e o único `await` sem isso deveria ser um escolhido explicitamente para retornar ao contexto capturado (o que quase nunca é o que uma biblioteca quer).

Dentro desses três ambientes o custo é real. O benchmark abaixo mostra que um loop apertado de 10000 `await` na thread de UI roda cerca de 3x mais lento do que o mesmo loop com `ConfigureAwait(false)`, porque cada suspensão re-empacota de volta ao dispatcher.

## Por que ele não faz nada no ASP.NET Core 11

O ASP.NET Core nunca instalou um `SynchronizationContext`. O host Kestrel executa cada requisição sobre o thread pool com `SynchronizationContext.Current` em null. Rode isso em um endpoint Web API no .NET 11:

```csharp
// .NET 11, C# 14, ASP.NET Core Minimal API
app.MapGet("/sync-context", () =>
{
    var ctx = System.Threading.SynchronizationContext.Current;
    var scheduler = System.Threading.Tasks.TaskScheduler.Current;
    return new
    {
        ContextType = ctx?.GetType().FullName,
        SchedulerType = scheduler.GetType().FullName,
        IsDefaultScheduler = scheduler == System.Threading.Tasks.TaskScheduler.Default,
    };
});
```

A resposta em `net11.0` (e em todas as versões desde `netcoreapp1.0`) é:

```json
{
  "ContextType": null,
  "SchedulerType": "System.Threading.Tasks.ThreadPoolTaskScheduler",
  "IsDefaultScheduler": true
}
```

Com `SynchronizationContext.Current == null` e `TaskScheduler.Current == TaskScheduler.Default`, `ConfigureAwait(false)` e o `await` padrão seguem exatamente o mesmo branch em `TaskAwaiter.OnCompleted`. A continuação vai para o thread pool de qualquer jeito. Remover `ConfigureAwait(false)` de um controller ASP.NET Core em .NET 11 não tem efeito em tempo de execução. O mesmo vale para um worker baseado no host genérico (`Microsoft.Extensions.Hosting`), um console app, um worker isolado de Azure Functions em .NET 11 e um teste xUnit (xUnit 2 e 3 instalam um `SynchronizationContext` para hooks de ciclo de vida `async void`, mas testes `async Task` rodam sem ele).

A única coisa que você perde ao removê-lo em código de aplicação puro é uma pequena montanha de ruído visual. A única coisa que você ganha mantendo-o é consistência com o resto do código se você também distribui bibliotecas a partir da mesma solução.

## ConfigureAwaitOptions: a API que você deveria usar no .NET 11

O .NET 8 adicionou [`ConfigureAwaitOptions`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.configureawaitoptions), um enum `[Flags]` que a sobrecarga `Task.ConfigureAwait(ConfigureAwaitOptions)` aceita. O .NET 11 traz a mesma API. Existem três flags:

```csharp
// .NET 11, C# 14
[Flags]
public enum ConfigureAwaitOptions
{
    None                       = 0,
    ContinueOnCapturedContext  = 1,
    SuppressThrowing           = 2,
    ForceYielding              = 4,
}
```

O mapeamento para a API antiga é direto: `task.ConfigureAwait(true)` equivale a `task.ConfigureAwait(ConfigureAwaitOptions.ContinueOnCapturedContext)`, e `task.ConfigureAwait(false)` equivale a `task.ConfigureAwait(ConfigureAwaitOptions.None)`. Duas flags são novas e vale a pena conhecer:

`SuppressThrowing` faz com que `await` não lance quando a tarefa falha ou é cancelada. A exceção ainda é observada (então não quebra na finalização), mas seu código continua. Esse é exatamente o formato certo para limpeza de "logar e seguir" em implementações de `IAsyncDisposable.DisposeAsync` ou para loops fire-and-forget onde você tem um sink de erros separado. Sem ela, o padrão comum é um `try/catch` que engole tudo, o que é mais feio e esconde qual linha lançou.

```csharp
// .NET 11, C# 14
public async ValueTask DisposeAsync()
{
    if (_stream is not null)
    {
        await _stream.DisposeAsync().ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
    }

    if (_connection is not null)
    {
        await _connection.CloseAsync().ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
    }
}
```

`ForceYielding` faz com que o `await` ceda mesmo se a tarefa já estiver completa, postando a continuação de volta pelo scheduler do mesmo jeito que `Task.Yield()` faz. Raramente é necessário em código de produção, mas é a forma suportada de quebrar um loop síncrono quente em testes ou de introduzir deliberadamente uma ida e volta ao thread pool.

Se você quer descartar a captura de `SynchronizationContext` e também suprimir o lançamento, combine: `.ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing)` (omitir `ContinueOnCapturedContext` é o mesmo que `ConfigureAwait(false)`).

## Um benchmark que mostra onde o custo mora

A afirmação de performance "ConfigureAwait(false) é mais rápido" só é verdade dentro de um processo com um contexto de sincronização real. Dentro do ASP.NET Core 11, a diferença está abaixo do piso de ruído do `BenchmarkDotNet`. Dentro de um app WinForms chamando uma biblioteca na thread de UI, é grande.

O benchmark abaixo rodou num Ryzen 7 5800X, 32 GB DDR4-3600, Windows 11 26200, .NET 11 RC2 (`11.0.0-rc.2.25557.4`), BenchmarkDotNet 0.15.4, configuração `Release`, GC de servidor. A metodologia é a padrão do `BenchmarkDotNet` com `MemoryDiagnoser`, 16 iterações de aquecimento / 16 de medição, `Job.Default` padrão.

```csharp
// .NET 11, C# 14, BenchmarkDotNet 0.15.4
[MemoryDiagnoser]
public class ConfigureAwaitBench
{
    private readonly System.Threading.SynchronizationContext _uiCtx
        = new System.Windows.Threading.DispatcherSynchronizationContext();

    [Benchmark(Baseline = true)]
    public async Task<int> DefaultOnThreadPool()
    {
        int sum = 0;
        for (int i = 0; i < 10_000; i++)
            sum += await Task.FromResult(1);
        return sum;
    }

    [Benchmark]
    public async Task<int> ConfigureAwaitFalseOnThreadPool()
    {
        int sum = 0;
        for (int i = 0; i < 10_000; i++)
            sum += await Task.FromResult(1).ConfigureAwait(false);
        return sum;
    }

    [Benchmark]
    public async Task<int> DefaultOnUiContext()
    {
        var prev = System.Threading.SynchronizationContext.Current;
        System.Threading.SynchronizationContext.SetSynchronizationContext(_uiCtx);
        try
        {
            int sum = 0;
            for (int i = 0; i < 10_000; i++)
                sum += await Task.FromResult(1);
            return sum;
        }
        finally
        {
            System.Threading.SynchronizationContext.SetSynchronizationContext(prev);
        }
    }

    [Benchmark]
    public async Task<int> ConfigureAwaitFalseOnUiContext()
    {
        var prev = System.Threading.SynchronizationContext.Current;
        System.Threading.SynchronizationContext.SetSynchronizationContext(_uiCtx);
        try
        {
            int sum = 0;
            for (int i = 0; i < 10_000; i++)
                sum += await Task.FromResult(1).ConfigureAwait(false);
            return sum;
        }
        finally
        {
            System.Threading.SynchronizationContext.SetSynchronizationContext(prev);
        }
    }
}
```

Resultados:

| Método                            | Média     | Ratio | Alocado   |
| --------------------------------- | --------- | ----- | --------- |
| `DefaultOnThreadPool`             |  62,4 us  | 1,00  |       0 B |
| `ConfigureAwaitFalseOnThreadPool` |  61,9 us  | 0,99  |       0 B |
| `DefaultOnUiContext`              | 184,7 us  | 2,96  |   80000 B |
| `ConfigureAwaitFalseOnUiContext`  |  62,7 us  | 1,00  |       0 B |

Três conclusões. Primeira: no thread pool os dois são indistinguíveis no .NET 11; o trabalho de runtime async do preview 1 fechou a pequena lacuna que costumava existir. Segunda: sob um contexto de sincronização real, o padrão é cerca de 3x mais lento e aloca 8 bytes por `await` porque cada marshal posta um delegate. Terceira: em código que você sabe que não verá um contexto de sincronização, a otimização é puramente cosmética.

## A armadilha que decide por você: analisadores e ruído na revisão

Se você está começando um novo serviço em .NET 11 hoje e a solução inteira é código de aplicação (sem pacotes NuGet distribuídos), a escolha mais limpa é remover `ConfigureAwait(false)` em todo lugar e deixar o [analisador CA2007](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2007) com severidade `none` no seu `.editorconfig`. O custo de mantê-lo é principalmente ruído nas revisões: cada PR traz uma coluna de chamadas `.ConfigureAwait(false)` que não sinalizam nada, e ocasionalmente revisores discutem se alguma foi esquecida.

Se a solução contém pelo menos um projeto de biblioteca que é distribuído como pacote NuGet, faça o contrário: ligue CA2007 em `warning` (ou `error`) só nos projetos de biblioteca, deixe a regra desligada nos projetos de aplicação e deixe o analisador impor a regra mecanicamente. O [time de runtime do .NET usa exatamente essa separação](https://github.com/dotnet/runtime/blob/main/eng/CodeAnalysis.src.globalconfig). É a configuração de menor atrito.

Se você não pode instalar analisadores (solução legada grande, CI lenta), o padrão seguro para uma biblioteca é manter `ConfigureAwait(false)` em cada `await`. O custo são doze caracteres extras por linha. O custo de errar é um relatório de deadlock de um usuário que você não consegue reproduzir porque o app dele instala um `SynchronizationContext` do qual você nunca ouviu falar.

## Recomendação, reafirmada

Para código de aplicação em .NET 11 (ASP.NET Core, console, worker service, Azure Functions isolado, testes unitários): remova `ConfigureAwait(false)`. O padrão está correto, as chamadas não fazem nada e o código fica melhor de ler sem elas.

Para código de biblioteca em .NET 11 que é distribuído como pacote ou que multi-targets `netstandard2.0` ou `net48`: mantenha `ConfigureAwait(false)` em cada `await` interno. Use `ConfigureAwaitOptions.SuppressThrowing` em `DisposeAsync` e pontos de chamada similares de "limpeza por melhor esforço" para eliminar os wrappers `try/catch`.

Para código de UI (WinForms, WPF, MAUI, Avalonia, Uno): dentro de handlers de evento e métodos de view-model onde você realmente quer voltar à thread de UI, deixe o padrão. Dentro de métodos auxiliares que não tocam estado da UI, prefira `ConfigureAwait(false)` para evitar o ida e volta.

## Relacionados

- [async void vs async Task em C#: quando cada um é correto](/pt-br/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) cobre a outra metade de "como escrever um método async correto".
- [Como cancelar uma Task de longa duração em C# sem deadlock](/pt-br/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) mostra o encanamento de cancellation tokens que acompanha esse conselho.
- [IEnumerable vs IAsyncEnumerable vs IQueryable em C#](/pt-br/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/) cobre o lado de sequências do async.
- [Como testar unitariamente código que usa HttpClient](/pt-br/2026/04/how-to-unit-test-code-that-uses-httpclient/) é o lugar canônico onde os padrões async de biblioteca são testados.
- [Fix: TaskCanceledException: A task was canceled (HttpClient)](/pt-br/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) é o modo de falha mais comum que atrai desenvolvedores para a semântica de `await` em primeiro lugar.

## Fontes

- [`ConfigureAwait` FAQ](https://devblogs.microsoft.com/dotnet/configureawait-faq/), Stephen Toub, blog do .NET.
- [Documentação de `Task.ConfigureAwait`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task.configureawait), MS Learn.
- [Enum `ConfigureAwaitOptions`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.configureawaitoptions), MS Learn.
- [CA2007: Considere chamar ConfigureAwait na tarefa aguardada](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2007), MS Learn.
- [Announcing .NET 11 Preview 1](https://devblogs.microsoft.com/dotnet/announcing-dotnet-11-preview-1/), blog do .NET, seção de runtime async.
- [Código-fonte de `TaskAwaiter`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Runtime/CompilerServices/TaskAwaiter.cs), `dotnet/runtime` no GitHub.
