---
title: "Migrar de ValueTask<T> de volta para Task<T>: quando e por quê (.NET 11, C# 14)"
description: "Um checklist prático para reverter os tipos de retorno ValueTask e ValueTask<T> para Task e Task<T>, o que quebra nos pontos de chamada, como verificar cada mudança e como saber se a troca valeu a pena."
pubDate: 2026-06-06
updatedDate: 2026-06-06
template: migration
tags:
  - "migration"
  - "csharp"
  - "dotnet"
  - "async"
  - "performance"
lang: "pt-br"
translationOf: "2026/06/migrate-from-valuetask-back-to-task-when-and-why"
translatedBy: "claude"
translationDate: 2026-06-06
---

Reverter uma API de `ValueTask<T>` de volta para `Task<T>` costuma ser um trabalho de meio dia e quase sempre é seguro, porque `Task<T>` é o tipo mais tolerante: tudo que compilava contra `ValueTask<T>` vai continuar compilando, e vários bugs latentes nos seus chamadores desaparecem no momento em que você faz a troca. O trabalho que leva tempo não é a mudança do tipo de retorno em si, mas auditar os pontos de chamada que dependiam da semântica de `ValueTask`: um método aguardado duas vezes, um resultado armazenado em cache em um campo, um `.GetAwaiter().GetResult()` em um caminho crítico. Este guia cobre quando a reversão é a decisão certa, as edições exatas na declaração e em cada chamador, como verificar cada passo e como confirmar depois que você não causou uma regressão no perfil de alocação que originalmente adotou `ValueTask` para corrigir.

Isto tem como alvo .NET 11 e C# 14, vigentes em junho de 2026, mas nada aqui é específico de versão: o contrato de `ValueTask` é estável desde que foi lançado no .NET Core 2.1. O conselho segue a orientação canônica de Stephen Toub em [Understanding the Whys, Whats, and Whens of ValueTask](https://devblogs.microsoft.com/dotnet/understanding-the-whys-whats-and-whens-of-valuetask/), cuja conclusão é direta: "a escolha padrão ainda é `Task` / `Task<TResult>`." Se você adotou `ValueTask` sem um profiler dizer para fazê-lo, este é o post que te traz de volta.

## Por que reverter

`ValueTask<T>` existe para evitar uma alocação específica: o objeto `Task<T>` que um método assíncrono aloca no heap mesmo quando ele se completa de forma síncrona. Esse é um custo real em caminhos críticos que quase sempre terminam sem aguardar (um acerto de cache, uma leitura em buffer, um cálculo memoizado). Mas o tipo paga por esse ganho com um contrato que é fácil de violar, e a maioria das bases de código que recorrem a ele nunca teve o problema de alocação em primeiro lugar. Razões concretas para voltar atrás:

- **Os pontos de chamada continuam disparando CA2012.** Se a sua equipe repetidamente aguarda o mesmo `ValueTask` duas vezes, o armazena em um campo ou bloqueia sobre ele, o tipo está custando ativamente a sua correção. `Task<T>` torna todas essas operações legais.
- **Você nunca mediu um ganho.** `ValueTask` é uma otimização guiada por profiler. Se você o adotou por reflexo e um benchmark não mostra diferença de alocação, a cautela adicional é puro overhead.
- **O método agora geralmente se completa de forma assíncrona.** `ValueTask` só compensa quando a conclusão síncrona é o caso comum. Se o método passou a aguardar E/S real na maioria das chamadas, você está alocando um objeto de suporte de qualquer forma e ainda carrega as restrições da struct à toa.
- **Você quer a ergonomia de `WhenAll` / `WhenAny`.** Os combinadores recebem `Task`, então uma API que retorna `ValueTask` obriga cada chamador a escrever `.AsTask()` antes de paralelizar. Reverter remove esse atrito.

Se você está pesando a direção inversa, ou ainda decidindo se `ValueTask` pertence ao seu código, as regras abaixo servem também como auxílio de decisão.

## O que quebra (spoiler: muito pouco)

| Área | Mudança | Severidade |
| --- | --- | --- |
| Declaração do método | `ValueTask<T>` vira `Task<T>`; `ValueTask` vira `Task` | baixa |
| Pontos de chamada com `await` direto | Nenhuma mudança necessária; ambos os tipos são aguardáveis | nenhuma |
| Chamadas a `.AsTask()` | Agora redundantes; remova-as | baixa |
| Implementações de `IValueTaskSource<T>` | Devem ser substituídas por uma fonte `Task` real ou `TaskCompletionSource<T>` | alta |
| Retornos de caminho rápido síncrono | `return new ValueTask<T>(value)` vira `return Task.FromResult(value)` | média |
| Assinaturas de interface / classe base | Cada implementador e override deve mudar junto | média |
| Superfície de API pública | Mudança que quebra a compatibilidade binária para consumidores externos | alta |

Os únicos casos genuinamente difíceis são um `IValueTaskSource<T>` feito à mão (raro, e se você tem um, adotou `ValueTask` deliberadamente, então pense duas vezes) e uma superfície pública de NuGet onde a mudança de tipo de retorno é uma quebra binária. Todo o resto é mecânico.

## Checklist pré-voo

Antes de tocar em uma única assinatura:

- Confirme que o analisador está ativo. A regra de correção de `ValueTask` **CA2012** está habilitada como sugestão por padrão no .NET 10 e posteriores. Promova-a a aviso para que o compilador mostre exatamente quais pontos de chamada dependiam da semântica de `ValueTask`: adicione `dotnet_diagnostic.CA2012.severity = warning` ao seu `.editorconfig`.
- Capture uma linha base. Se a alocação foi alguma vez a razão de `ValueTask`, execute agora uma passada de `BenchmarkDotNet` com `[MemoryDiagnoser]` sobre o caminho crítico, para poder comparar depois.
- Identifique a fronteira do contrato. Se o método implementa uma interface ou sobrescreve um membro base, cada declaração relacionada muda no mesmo commit. Busque primeiro o nome do método em toda a solução.
- Verifique a superfície pública. Se este tipo é distribuído em um pacote NuGet, uma mudança de tipo de retorno quebra a compatibilidade binária mesmo sendo compatível em nível de código-fonte. Planeje um incremento de versão maior.

## Passos de migração

Cada passo a seguir é uma mudança discreta com uma linha de verificação. Faça-os em ordem; espere estados intermediários em que a build está em vermelho até que o contrato esteja atualizado em todos os lugares.

1. **Transforme CA2012 em aviso e compile.** Faça o analisador ficar barulhento antes de mudar qualquer coisa, para que a build mostre cada padrão de consumo arriscado enquanto a assinatura de `ValueTask` ainda está no lugar.

   ```ini
   # .editorconfig - .NET 11 SDK, CA2012 ships in the built-in analyzers
   [*.cs]
   dotnet_diagnostic.CA2012.severity = warning
   ```

   Execute `dotnet build`. Cada aviso CA2012 é um ponto de chamada que aguardou duas vezes, armazenou ou bloqueou sobre o `ValueTask`, exatamente o código que se torna trivialmente correto assim que você reverte. Anote cada um; você vai apagar as soluções temporárias no passo 4. **Verificar:** a build se completa e você tem uma lista escrita dos acertos de CA2012 (muitas vezes zero, o que já é uma informação útil).

2. **Mude a declaração.** Troque o tipo de retorno. O corpo do método normalmente precisa de uma edição por cada `return` de um valor materializado.

   ```csharp
   // Before: .NET 11, C# 14
   public ValueTask<User> GetUserAsync(int id)
   {
       if (_cache.TryGetValue(id, out var user))
           return new ValueTask<User>(user);          // synchronous fast path

       return new ValueTask<User>(LoadFromDbAsync(id)); // wraps a Task
   }

   // After: .NET 11, C# 14
   public Task<User> GetUserAsync(int id)
   {
       if (_cache.TryGetValue(id, out var user))
           return Task.FromResult(user);              // synchronous fast path

       return LoadFromDbAsync(id);                     // already a Task<User>
   }
   ```

   Para um método com a palavra-chave `async`, a mudança é apenas a assinatura; o compilador reescreve o resto:

   ```csharp
   // Before
   public async ValueTask<int> CountAsync(CancellationToken ct)
   {
       await Task.Delay(5, ct);
       return 42;
   }

   // After: only the return type changed
   public async Task<int> CountAsync(CancellationToken ct)
   {
       await Task.Delay(5, ct);
       return 42;
   }
   ```

   **Verificar:** o projeto compila. A forma com a palavra-chave `async` não precisa de mais edições; a forma manual precisa que cada `new ValueTask<T>(...)` seja reescrito como `Task.FromResult(...)` ou que retorne o `Task` interno diretamente.

3. **Atualize as declarações de interface e classe base juntas.** Se o método veio de um contrato, mude o contrato e cada implementador na mesma passada, ou a build quebra pela metade.

   ```csharp
   // Before
   public interface IUserRepository
   {
       ValueTask<User> GetUserAsync(int id);
   }

   // After
   public interface IUserRepository
   {
       Task<User> GetUserAsync(int id);
   }
   ```

   **Verificar:** `dotnet build` em toda a solução, não apenas no projeto. Um implementador omitido aparece como `CS0535` (não implementa o membro da interface) ou `CS0508` (tipo de retorno não corresponde no override).

4. **Apague as soluções temporárias `.AsTask()` e as correções de duplo await.** Aqui é onde a reversão compensa. Em qualquer lugar onde um chamador se defendia contra a regra de await único de `ValueTask`, a defesa agora é código morto.

   ```csharp
   // Before: caller had to convert because it awaited twice / fanned out
   ValueTask<User> vt = repo.GetUserAsync(id);
   Task<User> safe = vt.AsTask();        // required for ValueTask
   var a = await safe;
   var b = await safe;

   // After: Task is awaitable repeatedly; no conversion needed
   Task<User> t = repo.GetUserAsync(id);
   var a = await t;
   var b = await t;
   ```

   `Task.WhenAll` e `Task.WhenAny` agora recebem os resultados diretamente:

   ```csharp
   // Before: each ValueTask needed .AsTask() before combining
   await Task.WhenAll(ids.Select(id => repo.GetUserAsync(id).AsTask()));

   // After
   await Task.WhenAll(ids.Select(id => repo.GetUserAsync(id)));
   ```

   **Verificar:** cada aviso CA2012 do passo 1 sumiu, e você removeu pelo menos tantas chamadas a `.AsTask()` quanto os avisos que tinha.

5. **Substitua qualquer plumbing de `IValueTaskSource<T>`.** Se um método retornava um `ValueTask<T>` agrupado (pooled) com suporte em um `IValueTaskSource<T>` personalizado (o padrão que `ManualResetValueTaskSourceCore<T>` habilita), não há substituto direto. Você está abrindo mão do pooling, então use um `TaskCompletionSource<T>` no lugar e aceite a alocação que está escolhendo reintroduzir.

   ```csharp
   // After: a Task source replaces the pooled IValueTaskSource<T>
   private readonly TaskCompletionSource<int> _tcs =
       new(TaskCreationOptions.RunContinuationsAsynchronously);

   public Task<int> WaitForValueAsync() => _tcs.Task;

   public void Complete(int value) => _tcs.TrySetResult(value);
   ```

   A flag `RunContinuationsAsynchronously` importa: sem ela, `TrySetResult` executa a continuação inline na thread que completa, o que pode causar deadlock ou privar o thread pool da mesma forma que um bloqueio síncrono. Este é o único passo em que reverter realmente custa algo, então só faça isso se o pooling nunca foi justificado por um benchmark. **Verificar:** o tipo não implementa mais `IValueTaskSource<T>`, e um teste de estresse que complete a operação milhares de vezes continua passando sem problemas de reentrância.

## Verificação após a troca

Execute este checklist de ponta a ponta antes de dar a migração por concluída:

- `dotnet build` está limpo com CA2012 em `warning` e zero acertos.
- `dotnet test` passa sem novas falhas, especialmente em torno de qualquer código que antes armazenava em cache o aguardável.
- A passada de `BenchmarkDotNet` com `[MemoryDiagnoser]` do pré-voo mostra o delta de alocação que você esperava. Se um caminho crítico de conclusão síncrona agora aloca um `Task<T>` por chamada (24 bytes em 64 bits) e esse caminho executa milhões de vezes por segundo, você tem sua evidência de que `ValueTask` ganhava seu lugar e a reversão foi um erro. Se os números estão planos, a reversão foi correção de graça.
- Busque no diff qualquer `new ValueTask`, `.AsTask()` ou `ValueTask<` remanescente que você tenha deixado passar.

## Plano de rollback

Esta migração é totalmente reversível em nível de código-fonte e de baixo risco para desfazer: mudar `Task<T>` de volta para `ValueTask<T>` é a mesma edição mecânica no sentido inverso. A única ressalva é o caso de API pública. Se você distribuiu a versão `Task<T>` em um pacote NuGet lançado, voltar para `ValueTask<T>` é outra mudança que quebra a compatibilidade binária, então consumidores externos recompilam duas vezes. Código interno não tem essa restrição; mantenha a migração em um branch e reverta o commit se o benchmark disser que você causou uma regressão.

## Problemas que encontramos

**`Task.FromResult` não é de graça para tipos de referência que você aloca de qualquer forma.** `Task.FromResult(value)` ainda aloca um `Task<T>` para um valor arbitrário. O runtime armazena em cache as tarefas para `Task.FromResult(true)`, `false` e inteiros pequenos, mas não para o seu `User`. Se você reverte precisamente porque o método agora raramente se completa de forma síncrona, isso não importa; se ele ainda se completa de forma síncrona na maioria das vezes, essa alocação é justamente o que `ValueTask` evitava. Meça antes de assumir que a reversão é inofensiva.

**`async` sobre um corpo síncrono reintroduz a máquina de estados.** Reescrever `return new ValueTask<T>(cachedValue)` como um método `async` que retorna `cachedValue` adiciona uma alocação de máquina de estados em cima do `Task<T>`. Mantenha o caminho rápido sem `async`: retorne `Task.FromResult(...)` de um método simples, exatamente como no passo 2. O mesmo raciocínio que faz [ConfigureAwait continuar importando no .NET 11](/2026/05/configureawait-false-vs-default-in-dotnet-11/) se aplica aqui: o caminho assíncrono mais barato é o que nunca constrói uma máquina de estados.

**A semântica de cancelamento não muda, mas verifique-a mesmo assim.** Tanto `Task<T>` quanto `ValueTask<T>` expõem o cancelamento como um aguardável com falha/cancelado; a reversão não muda como um `CancellationToken` flui. Ainda assim, teste novamente seus caminhos de cancelamento, porque a reescrita toca cada instrução de retorno. Se o seu tratamento de cancelamento já era frágil, veja [como cancelar uma Task de longa duração sem causar deadlock](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/).

**`IAsyncEnumerable<T>` é o único lugar onde convém manter `ValueTask`.** `IAsyncEnumerator<T>.MoveNextAsync` retorna `ValueTask<bool>` por design, e `DisposeAsync` retorna `ValueTask`. Não "reverta" estes; a maquinaria de async streams é construída para reutilizar a fonte de suporte entre iterações, que é o caso de manual onde `ValueTask` compensa. Se você trabalha com streams, [usar IAsyncEnumerable<T> com EF Core 11](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) mostra o padrão em contexto.

**Fire-and-forget escondia um duplo consumo.** Um padrão que encontramos ao reverter: um `ValueTask` era atribuído a um campo e observado mais tarde, o que é ilegal e corrompia silenciosamente os resultados sob carga. Mudar para `Task<T>` tornou isso legal, mas a correção certa era parar de fazer fire-and-forget de vez. Se você vir isso, leia [como executar trabalho fire-and-forget com segurança](/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/) antes de tapar com uma mudança de tipo, e fique de olho na [ObjectDisposedException sobre um contexto liberado](/2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance/) que o mesmo padrão fire-and-forget tende a produzir.

O resumo honesto: reverter `ValueTask<T>` para `Task<T>` é o padrão correto para código que adotou a struct sem um profiler em mãos. Você troca uma microotimização que provavelmente não estava obtendo por um tipo que toda a sua equipe pode usar sem ler uma lista de regras. Mantenha `ValueTask` exatamente onde os dados dizem que ele ganha seu lugar (caminhos críticos de conclusão síncrona e async streams) e deixe `Task<T>` carregar todo o resto.

## Fontes

- [Understanding the Whys, Whats, and Whens of ValueTask -- .NET Blog (Stephen Toub)](https://devblogs.microsoft.com/dotnet/understanding-the-whys-whats-and-whens-of-valuetask/)
- [CA2012: Use ValueTasks correctly -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2012)
- [ValueTask&lt;TResult&gt; Struct -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.valuetask-1)
- [ValueTask Restrictions -- Stephen Cleary](https://blog.stephencleary.com/2020/03/valuetask.html)
