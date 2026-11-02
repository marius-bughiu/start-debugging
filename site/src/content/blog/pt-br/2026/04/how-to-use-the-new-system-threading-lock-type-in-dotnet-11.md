---
title: "Como usar System.Threading.Lock no .NET"
description: "Use System.Threading.Lock em seções críticas síncronas desde o .NET 9. Entenda a compilação, os limites de await e a diferença para Monitor."
pubDate: 2026-04-30
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "concurrency"
template: "how-to"
lang: "pt-br"
translationOf: "2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-04-30
---

`System.Threading.Lock` foi introduzido no .NET 9. Desde o C# 13, uma instrução `lock` cuja expressão tem esse tipo estático usa `EnterScope()` em vez do caminho baseado em `Monitor`. É uma opção para exclusão mútua síncrona dentro de um processo; o código `lock(object)` existente não é migrado automaticamente.

**Correção — 2 de novembro de 2026:** a versão anterior afirmava incorretamente que SyncBlocks nunca são recuperados e que `EnterScope()` pode atravessar um `await`. Também exagerava os ganhos de memória e desempenho. Os exemplos do compilador foram verificados com o SDK 10.0.302 e C# 14; não foi feita uma execução no .NET 11.

## Um bloqueio privado com tipo explícito

```csharp
using System.Threading;

public sealed class Counter
{
    private readonly Lock _gate = new();
    private int _value;

    public int Next()
    {
        lock (_gate)
        {
            return ++_value;
        }
    }
}
```

O compilador gera um escopo que libera o bloqueio mesmo quando o corpo lança uma exceção. `Lock.Scope` é um `ref struct`, não um wrapper descartável alocado no heap. `Lock` é um tipo por referência e permite entradas recursivas da mesma thread. Cada `Enter()` ou `TryEnter()` bem-sucedido exige um `Exit()` nessa thread; use `try/finally` com essas APIs manuais.

## Não misture Lock e Monitor

`lock (_gate)` e `Monitor.Enter(_gate)` usam mecanismos de sincronização diferentes. Expressões do tipo `object` ou `dynamic` usam o bloqueio de Monitor, a menos que sejam convertidas explicitamente de volta para `Lock`. Misturar os dois caminhos pode deixar os dados compartilhados sem sincronização.

CS9216 avisa sobre algumas conversões visíveis estaticamente na expressão, como `lock ((object)gate)`. Isso não garante detectar todos os acessos indiretos ou chamadas explícitas a `Monitor`. Mantenha o bloqueio privado e seu tipo visível. Use `using System.Threading;` ou o nome completo; `using static System.Threading;` é inválido porque `System.Threading` é um namespace.

## Await exige outra abordagem

Um `await` dentro de `lock` é rejeitado. Um `Lock.Scope` também não pode permanecer ativo através de um `await`; trocar a sintaxe por `using` não contorna essa restrição:

```csharp
// Does not compile: CS4007 on .NET SDK 10.0.302, C# 14.
using System.Threading;
using System.Threading.Tasks;

public static class InvalidExample
{
    public static async Task InvalidAsync()
    {
        Lock gate = new();
        using (gate.EnterScope())
        {
            await Task.Delay(10);
        }
    }
}
```

Mantenha curtas as seções críticas síncronas. Quando for necessário serializar trabalho assíncrono, um `SemaphoreSlim(1, 1)` compartilhado é uma opção adequada:

```csharp
using System;
using System.Threading;
using System.Threading.Tasks;

public static class AsyncOperations
{
    public static async Task RunExclusiveAsync(
        SemaphoreSlim gate, Func<Task> work, CancellationToken cancellationToken)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            await work();
        }
        finally
        {
            gate.Release();
        }
    }
}
// Share a SemaphoreSlim(1, 1) between callers of this operation.
```

Também não use `Lock.Enter()`/`Exit()` manualmente através de um `await`: a propriedade do bloqueio pertence à thread, e a continuação pode executar em outra. No exemplo verificado com C# 14, compilou um bloco síncrono que terminava antes de um await posterior.

## SyncBlocks e desempenho

Monitor pode usar o cabeçalho do objeto e, quando necessário, um SyncBlock associado. Contenção não significa que todo objeto recebe imediatamente um SyncBlock permanente. O CoreCLR possui caminhos de limpeza, um pool de SyncBlocks livres e uma lista de entradas reutilizáveis da tabela. Reutilizar entradas não é o mesmo que devolver toda a capacidade da tabela ao sistema operacional.

`Lock` não usa esse mesmo mecanismo de monitor de objeto para suas próprias aquisições. Isso não comprova uma economia fixa por objeto nem um multiplicador universal de desempenho. Meça o runtime, a contenção e o trabalho protegido reais. Ambas as APIs são reentrantes; nenhuma oferece garantia geral de justiça.

Em destinos antigos sem `System.Threading.Lock`, mantenha um bloqueio `object` ou use compilação condicional para .NET 9 e posteriores. Nem `Lock` nem um semáforo local coordenam processos distintos. Um builder mutável como `ImmutableArray<T>.Builder` também não admite alterações concorrentes automaticamente só porque produz um resultado imutável.

Para coordenação assíncrona entre produtores e consumidores, veja [Channels e BlockingCollection](/pt-br/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/).

## Fontes

- [System.Threading.Lock API](https://learn.microsoft.com/en-us/dotnet/api/system.threading.lock?view=net-10.0)
- [C# lock statement](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/statements/lock)
- [CoreCLR SyncBlock implementation, .NET 10](https://github.com/dotnet/runtime/blob/v10.0.0/src/coreclr/vm/syncblk.cpp)
- [C# 13 lock-object proposal](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-13.0/lock-object.md)
