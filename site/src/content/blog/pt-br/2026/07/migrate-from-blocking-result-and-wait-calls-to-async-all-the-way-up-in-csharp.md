---
title: "Migrar de chamadas bloqueantes .Result/.Wait() para async em toda a cadeia em uma base de código C# legada"
description: "Um manual em etapas para remover sync-over-async de uma base de código .NET existente: inventariar com analisadores, medir a inanição do ThreadPool, converter uma cadeia de chamadas por vez e reduzir a contagem a zero no .NET 11."
pubDate: 2026-07-25
template: migration
tags:
  - "migration"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
lang: "pt-br"
translationOf: "2026/07/migrate-from-blocking-result-and-wait-calls-to-async-all-the-way-up-in-csharp"
translatedBy: "claude"
translationDate: 2026-07-25
---

Remover sync-over-async de uma base de código real não é um localizar e substituir. Reserve de um a três sprints para um serviço com algumas centenas de milhares de linhas, e espere que o trabalho tenha o formato de uma série de fatias verticais em vez de um único PR gigante. O que quebra são principalmente as assinaturas: todo método que deixa de bloquear precisa retornar `Task`, e isso se propaga para cima através de interfaces, construtores, `Dispose`, blocos `lock` e a superfície pública da sua API. Vale a pena fazer quando você está vendo inanição do ThreadPool sob carga ou deadlocks graves em uma thread de UI, e vale a pena adiar quando a chamada bloqueante está em uma ferramenta de linha de comando que roda uma vez e encerra. Este manual tem como alvo o .NET 11 (`Microsoft.NET.Sdk` 11.0.0, C# 14); todas as ferramentas mencionadas funcionam desde o .NET 6, com a etapa de rastreamento em runtime exigindo .NET 9 ou posterior.

## Por que as chamadas bloqueantes precisam sair

- **A inanição do ThreadPool desaparece.** Cada `.Result` em um caminho de requisição estaciona uma thread do pool. O próprio [tutorial de inanição do ThreadPool](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/debug-threadpool-starvation) da Microsoft mede o mesmo endpoint em 3,48 s de latência média sob 125 conexões concorrentes enquanto bloqueia, e 532 ms depois que a chamada é aguardada. Isso não é uma diferença de ajuste fino, é outra aplicação.
- **Deadlocks graves se tornam impossíveis, não improváveis.** Em uma thread de WPF, WinForms ou ASP.NET clássico, bloquear em uma tarefa cuja continuação precisa daquela thread é uma espera circular. O mecanismo está coberto em [por que bloquear em um método assíncrono causa deadlock](/pt-br/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/); remover o bloqueio remove essa classe de bug.
- **A memória cai junto com a contagem de threads.** Um pool que estabilizou em 130 threads para compensar o bloqueio está segurando 130 pilhas. Ir para assíncrono normalmente devolve a contagem a um múltiplo pequeno do número de núcleos.
- **O cancelamento passa a funcionar.** Uma thread bloqueada não consegue observar um `CancellationToken`. Uma vez que a cadeia é assíncrona, timeouts e desconexões do cliente realmente se propagam.

## O que quebra ao ir para assíncrono

| Área                                | Mudança                                                                                                   | Severidade |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------- |
| Superfície pública da API           | `T Get()` vira `Task<T> GetAsync()`: quebra de código-fonte e binária para os consumidores                    | alta       |
| Interfaces que não são suas         | Um método de interface de terceiros ou do framework não pode receber um tipo de retorno `Task`                | alta       |
| Construtores, getters de propriedade| Nenhum dos dois pode ser `async`; o trabalho migra para um método de fábrica ou um inicializador preguiçoso   | alta       |
| Instruções `lock`                   | `await` dentro de `lock` é o erro de compilação `CS1996`; exige `SemaphoreSlim`                               | média      |
| Tratamento de exceções              | `AggregateException` deixa de aparecer, então `catch (AggregateException)` para de casar silenciosamente      | média      |
| `TransactionScope`                  | Não flui através de `await` a menos que seja construído com `TransactionScopeAsyncFlowOption.Enabled`         | média      |
| `IDisposable`                       | Limpeza assíncrona no `Dispose` precisa de `IAsyncDisposable` e `await using`                                 | média      |
| Suíte de testes                     | Métodos de teste síncronos que chamam código agora assíncrono viram `async Task`                              | baixa      |

As linhas de severidade alta são as que definem seu sequenciamento. Todo o resto é mecânico.

## Checklist de preparação

- A solution compila limpa no .NET 6 ou posterior. Nada aqui exige .NET 11, mas a etapa de rastreamento em runtime precisa do .NET 9+ para o evento `WaitHandleWait`.
- `Microsoft.VisualStudio.Threading.Analyzers` adicionado a todos os projetos, ou pelo menos aos projetos do caminho quente. Este é o pacote que encontra chamadas bloqueantes em métodos síncronos, coisa que os analisadores nativos do .NET não fazem.
- `dotnet-counters`, `dotnet-trace` e `dotnet-stack` instalados como ferramentas globais.
- Um teste de carga que reproduza o sintoma. Sem ele você não consegue provar que a migração funcionou, nem que ela não causou regressão.
- Uma estratégia de branches que permita muitos PRs pequenos. Um PR de 400 arquivos que muda todas as assinaturas da solution não será revisado.

## Etapas da migração

1. **Monte o inventário com analisadores, não com grep.**

   `grep -r "\.Result"` encontra acessos a propriedades em qualquer coisa chamada Result e perde completamente a E/S síncrona. Ative as duas regras que de fato entendem o padrão:

   ```ini
   # .editorconfig -- .NET 11 SDK 11.0.0
   [*.cs]
   # Avoid problematic synchronous waits (.Result, .Wait(), GetAwaiter().GetResult())
   dotnet_diagnostic.VSTHRD002.severity = warning
   # Call async methods when in an async method
   dotnet_diagnostic.VSTHRD103.severity = warning
   # Built-in equivalent; off by default through .NET 10
   dotnet_diagnostic.CA1849.severity = warning
   ```

   A distinção importa numa base de código legada. O [CA1849](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1849) só dispara dentro de um método que retorna `Task`, então em código onde nada ainda é assíncrono ele reporta quase nada. O `VSTHRD002` dispara na chamada bloqueante onde quer que ela esteja, que é exatamente a população que você está tentando contar.

   **Verificação**: compile a solution e conte as linhas `VSTHRD002` na saída. Guarde esse número. Ele é o seu gráfico de queima.

2. **Capture uma linha de base sob carga antes de mudar uma linha.**

   Rode seu teste de carga e observe o pool:

   ```bash
   dotnet-counters monitor -n YourApp System.Runtime
   ```

   No .NET 9 e posteriores, os contadores a ler são `dotnet.thread_pool.thread.count`, `dotnet.thread_pool.queue.length` e `dotnet.thread_pool.work_item.count`. O sinal de inanição é uma contagem de threads subindo lentamente enquanto a CPU fica bem abaixo de 100%. Uma contagem que estabiliza acima de aproximadamente três vezes o número de processadores significa que o código está bloqueando threads do pool e o runtime está compensando criando mais.

   **Verificação**: registre a contagem de threads estabilizada, a latência p95 e as requisições por segundo. Você vai comparar com esses valores na etapa de verificação.

3. **Encontre as chamadas bloqueantes que a análise estática não enxerga.**

   Analisadores não conseguem sinalizar `File.ReadAllText`, `SqlCommand.ExecuteReader` ou um `SemaphoreSlim.Wait()` enterrado em uma dependência da qual você não tem o código-fonte. O .NET 9 adicionou o evento `WaitHandleWait` exatamente para isso:

   ```bash
   dotnet trace collect -n YourApp --clrevents waithandle --clreventlevel verbose --duration 00:00:30
   ```

   Abra o arquivo `.nettrace` resultante no PerfView ou no .NET Events Viewer da comunidade e expanda as pilhas `WaitHandleWaitStart`. Qualquer pilha cujos frames de base mencionem `ThreadPoolWorkQueue.Dispatch` ou `WorkerThread.WorkerThreadStart` é uma thread do pool sendo bloqueada, e o frame acima da espera nomeia o seu método.

   **Verificação**: cada pilha do trace ou corresponde a um ponto de chamada que já está no inventário da etapa 1, ou é adicionada a ele.

4. **Converta uma cadeia de chamadas de ponta a ponta, não um arquivo.**

   Escolha o único ponto de entrada mais quente da etapa 3. Comece pela folha (o método que de fato chama `HttpClient` ou o EF Core), dê a ele um gêmeo assíncrono e suba a pilha convertendo cada chamador até chegar a um método que possa fazer `await` sem ter um chamador próprio: uma action de controller, um `BackgroundService.ExecuteAsync`, um manipulador de eventos ou `Main`.

   ```csharp
   // .NET 11, C# 14 -- before: the block is three frames below the controller
   public IActionResult GetOrder(int id)
   {
       var order = _repository.Get(id);          // sync wrapper
       return Ok(order);
   }

   // after: no wrapper, no block, Task all the way to the framework
   public async Task<IActionResult> GetOrderAsync(int id, CancellationToken ct)
   {
       var order = await _repository.GetAsync(id, ct);
       return Ok(order);
   }
   ```

   Conversão parcial é pior do que nenhuma nesse caminho. Um único `.Result` restante em qualquer ponto do trecho síncrono reintroduz tanto o deadlock quanto a thread estacionada, então uma fatia só está pronta quando alcança um ponto de entrada.

   **Verificação**: rode de novo o trace da etapa 3 contra apenas aquele endpoint. Zero eventos `WaitHandleWait` em threads do pool para aquela pilha.

5. **Apague o gêmeo síncrono em vez de manter os dois.**

   O atalho tentador é deixar `Get()` no lugar como `GetAsync().GetAwaiter().GetResult()` para que nada mais precise mudar. Esse é o wrapper síncrono contra o qual Stephen Toub argumenta em [Should I expose synchronous wrappers for asynchronous methods?](https://devblogs.microsoft.com/dotnet/should-i-expose-synchronous-wrappers-for-asynchronous-methods/), e numa migração ele é ativamente prejudicial: o wrapper é onde as chamadas bloqueantes restantes se escondem, e ele permite que os chamadores escapem do trabalho para sempre.

   Se você realmente tem um consumidor síncrono e outro assíncrono e não pode abrir mão de nenhum, use o padrão de argumento de flag que a BCL usa em vez de um wrapper:

   ```csharp
   // .NET 11, C# 14 -- one implementation, two entry points, no sync-over-async
   public int Read(byte[] buffer) => ReadCoreAsync(buffer, sync: true).GetAwaiter().GetResult();
   public Task<int> ReadAsync(byte[] buffer) => ReadCoreAsync(buffer, sync: false);

   private async Task<int> ReadCoreAsync(byte[] buffer, bool sync)
   {
       // Every I/O call inside branches on `sync`, so the synchronous path
       // never awaits an incomplete task and cannot deadlock.
       return sync ? _stream.Read(buffer) : await _stream.ReadAsync(buffer);
   }
   ```

   **Verificação**: o ponto de entrada síncrono não aparece mais num trace `WaitHandleWait`, porque ele nunca espera por uma tarefa incompleta.

6. **Trate as costuras que realmente não podem ser assíncronas.**

   Três aparecem em toda migração. Um construtor não pode ser `async`, então mova a inicialização para uma fábrica estática (`public static async Task<Foo> CreateAsync()`) ou para um campo `Lazy<Task<T>>` que os chamadores aguardam. Um `Dispose` que faz limpeza assíncrona deve implementar `IAsyncDisposable` e ser consumido com [await using](/pt-br/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/). Um bloco `lock` contendo trabalho assíncrono novo falha ao compilar com `CS1996`, porque um monitor precisa ser liberado na mesma thread que o adquiriu:

   ```csharp
   // .NET 11, C# 14 -- lock cannot span an await; SemaphoreSlim can
   private readonly SemaphoreSlim _gate = new(1, 1);

   public async Task<Config> LoadAsync(CancellationToken ct)
   {
       await _gate.WaitAsync(ct);
       try { return _cached ??= await FetchAsync(ct); }
       finally { _gate.Release(); }
   }
   ```

   **Verificação**: o projeto compila sem `CS1996` e sem novos `async void` fora de manipuladores de eventos.

7. **Propague o CancellationToken enquanto as assinaturas já estão abertas.**

   Adicionar `CancellationToken ct = default` não custa nada em uma assinatura que você já vai mudar, e é doloroso adaptar depois. Passe-o para cada chamada assíncrona da cadeia, não só para a mais externa, seguindo as regras de [propagar um CancellationToken através de métodos assíncronos](/pt-br/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/).

   **Verificação**: cancele uma requisição em pleno voo (derrube a conexão do cliente) e confirme que a chamada ao banco de dados é de fato abandonada em vez de rodar até o fim.

8. **Trave o analisador como catraca para que a contagem só possa cair.**

   Assim que um projeto chega a zero, trave-o:

   ```xml
   <!-- Directory.Build.props -- .NET 11 SDK 11.0.0 -->
   <PropertyGroup>
     <TreatWarningsAsErrors>false</TreatWarningsAsErrors>
     <WarningsAsErrors>$(WarningsAsErrors);VSTHRD002;CA1849</WarningsAsErrors>
   </PropertyGroup>
   ```

   Para projetos ainda em meio à migração, mantenha as regras em `warning` e faça o CI falhar diante de um aumento na contagem em vez de diante de qualquer aviso. Uma catraca que bloqueia dívida nova enquanto a dívida antiga é queimada é a única versão disso que os times realmente mantêm.

   **Verificação**: adicione um `.Result` proposital em um projeto já convertido e confirme que a build falha.

## Verificando se a migração realmente funcionou

Assinaturas compilando não são evidência. Rode o mesmo teste de carga da etapa 2 e compare quatro números:

- **A contagem de threads do ThreadPool** deve estabilizar perto de um múltiplo pequeno do número de núcleos em vez de escalar para as centenas.
- **A latência p95 sob carga** deve se aproximar da latência de uma requisição isolada. O endpoint do tutorial de inanição saiu de 3,48 s de volta para cerca dos seus 500 ms sem carga.
- **O throughput** deve subir, muitas vezes em uma ordem de magnitude, porque as mesmas threads agora atendem muito mais requisições.
- **Os eventos `WaitHandleWait` em threads do pool** devem ficar perto de zero nos caminhos convertidos.

Depois rode as verificações funcionais: `dotnet test` com zero falhas, um teste de cancelamento que prove que uma desconexão do cliente aborta a chamada downstream, e uma passada manual sobre qualquer bloco `catch (AggregateException)` no código tocado, já que eles não casam mais com nada depois que as chamadas bloqueantes somem.

## Plano de rollback

Fatia a fatia, esta migração reverte de forma limpa: cada fatia vertical é um PR autocontido, e revertê-lo restaura a chamada bloqueante e suas assinaturas. Esse é o principal argumento para fatiar por cadeia de chamadas em vez de por camada.

O que não reverte de forma limpa é uma biblioteca publicada. Mudar `T Get()` para `Task<T> GetAsync()` é uma quebra binária para todo consumidor que compilou contra o assembly antigo, então para um pacote NuGet isso é uma migração de versão maior e a reversão precisa ser um novo release, não um `git revert`. Decida antes de começar se o pacote entrega as duas superfícies por uma versão maior (usando o padrão de argumento de flag da etapa 5, nunca um wrapper síncrono) ou se quebra de uma vez.

## Armadilhas que nos custaram tempo

**`async void` volta escondido através de lambdas.** Uma lambda passada para um parâmetro do tipo `Action` vira `async void`, então exceções dentro dela derrubam o processo em vez de aparecerem em uma tarefa. `List<T>.ForEach(async x => ...)` e `Parallel.ForEach` com um corpo assíncrono são os dois portadores comuns. O `VSTHRD101` pega o caso do delegate; a fronteira entre uso legítimo e quebrado está em [quando async void é correto e quando é uma armadilha](/pt-br/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/).

**`.Select(async x => ...)` produz `IEnumerable<Task>`, não resultados.** Compila, parece convertido, e nada o aguarda. Complemente com `await Task.WhenAll(...)` ou mude a enumeração para [IAsyncEnumerable](/pt-br/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/).

**`TransactionScope` para de fluir silenciosamente.** O construtor padrão não propaga a transação ambiente através de um `await`, então o código depois do primeiro await roda fora da transação sem nenhum erro. Construa-o com `TransactionScopeAsyncFlowOption.Enabled`.

**O ASP.NET Core lança exceções antes de você terminar.** Converter as camadas externas pode revelar `InvalidOperationException: Synchronous operations are disallowed` vindo de um `Stream.Read` síncrono mais abaixo, porque `AllowSynchronousIO` é false por padrão. Essa exceção é um mapa do trabalho restante, não um motivo para religar a chave; os detalhes estão em [como corrigir synchronous operations are disallowed](/pt-br/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed/).

**Bloquear um `ValueTask` é comportamento indefinido, não apenas lento.** Se uma folha convertida retorna `ValueTask<T>` e algum chamador acima ainda bloqueia, `.Result` sobre ele é comportamento indefinido, não só risco de deadlock. Converta com `.AsTask()` nessa fronteira até o chamador estar pronto, e leia as restrições em [o que o ValueTask custa a você](/pt-br/2026/06/what-is-valuetask-and-when-is-it-worth-it/).

**Não use `ConfigureAwait(false)` como substituto de terminar o trabalho.** Ele desarma o deadlock dentro de uma biblioteca que você controla, mas não faz nada quanto à thread estacionada, e no ASP.NET Core não há contexto do qual sair de qualquer forma. É uma mitigação para código que você não pode mudar, não uma estratégia de migração.

A medida de sucesso não é a contagem do analisador chegar a zero. É a contagem de threads do pool parar de subir sob carga, e uma requisição cancelada agora de fato cancelar alguma coisa.

## Relacionados

- [Fix: deadlock ao chamar .Result ou .Wait() em um método assíncrono em C#](/pt-br/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/)
- [.Result vs .Wait() vs GetAwaiter().GetResult() vs await em C#](/pt-br/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/)
- [Como propagar um CancellationToken através de métodos assíncronos no .NET 11](/pt-br/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/)
- [Quando async void é correto e quando é uma armadilha em C#](/pt-br/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)
- [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock em C#](/pt-br/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/)

## Fontes

- [Debug ThreadPool starvation](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/debug-threadpool-starvation) -- Microsoft Learn
- [CA1849: Call async methods when in an async method](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1849) -- Microsoft Learn
- [VSTHRD002: Avoid problematic synchronous waits](https://microsoft.github.io/vs-threading/analyzers/VSTHRD002.html) -- Microsoft.VisualStudio.Threading
- [Should I expose synchronous wrappers for asynchronous methods?](https://devblogs.microsoft.com/dotnet/should-i-expose-synchronous-wrappers-for-asynchronous-methods/) -- Stephen Toub
- [CS1996: Cannot await in the body of a lock statement](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/cs1996) -- Microsoft Learn
- [Don't Block on Async Code](https://blog.stephencleary.com/2012/07/dont-block-on-async-code.html) -- Stephen Cleary
