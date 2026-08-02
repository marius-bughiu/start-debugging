---
title: "Como executar trabalho intensivo de CPU em um app Blazor WebAssembly com Web Workers no .NET 11"
description: "Guia completo para tirar o trabalho intensivo de CPU da thread de UI do Blazor WebAssembly no .NET 11: por que Task.Run não ajuda, o novo template blazorwebworker, a API WebWorkerClient com cancelamento e timeouts, os limites de marshalling do JSExport e o custo do segundo runtime que você paga por worker."
pubDate: 2026-08-02
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "blazor"
  - "webassembly"
  - "web-workers"
  - "performance"
lang: "pt-br"
translationOf: "2026/08/how-to-run-cpu-bound-work-in-a-blazor-webassembly-app-with-web-workers-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-08-02
---

O Blazor WebAssembly executa seu código .NET na única thread de UI do navegador, então um laço `for` apertado congela a página: sem repinturas, sem cliques, sem `StateHasChanged`. `Task.Run` não te salva, porque não existe uma segunda thread onde executar. A solução no .NET 11 é o template de projeto `blazorwebworker`, que gera uma biblioteca de classes cujos métodos rodam dentro de um Web Worker real do navegador, em uma thread de sistema operacional separada. Você marca esses métodos com `[JSExport]`, referencia a biblioteca a partir do seu app e os chama através de `WebWorkerClient.InvokeAsync<TResult>`.

Tudo abaixo tem como alvo o .NET 11 (Preview 6 no momento em que isto foi escrito, SDK `11.0.100-preview.6`) com C# 14. O template chegou no .NET 11 Preview 1 com o nome `webworker` e foi [renomeado para `blazorwebworker`](https://github.com/dotnet/aspnetcore/pull/66070) antes da versão final; projetos gerados com o nome antigo continuam funcionando, apenas o identificador do template mudou. Duas capacidades são novas no cliente final do .NET 11: `InvokeVoidAsync`, e suporte a cancelamento e timeout tanto na criação do worker quanto na invocação.

## Os seis passos, do início ao fim

1. Crie uma biblioteca de classes worker com `dotnet new blazorwebworker` e referencie-a a partir do app Blazor WebAssembly.
2. Escreva seu código intensivo de CPU como métodos `static` marcados com `[JSExport]` dentro de uma `static partial class`.
3. Retorne apenas primitivos ou strings; serialize para JSON dentro do worker qualquer coisa mais rica.
4. Crie o `WebWorkerClient` uma única vez (não por chamada) e mantenha-o por toda a vida do componente ou do app.
5. Invoque os métodos pelo nome totalmente qualificado, passando um `CancellationToken` e um timeout.
6. Descarte o cliente para encerrar o worker e liberar o segundo runtime que ele carregou.

O resto deste post trata de por que cada um importa, e do que quebra quando você pula algum.

## Por que `Task.Run` não tira o trabalho da thread de UI

Isto é a primeira coisa que as pessoas tentam, e vale a pena entender exatamente por que falha antes de recorrer aos workers.

```csharp
// .NET 11, C# 14 - Blazor WebAssembly. This still freezes the browser.
private async Task Compute()
{
    status = "Working...";
    await Task.Run(() => CountPrimes(5_000_000));
    status = "Done";
}

private static int CountPrimes(int limit)
{
    var count = 0;
    for (var n = 2; n <= limit; n++)
    {
        var isPrime = true;
        for (var d = 2; d * d <= n; d++)
        {
            if (n % d == 0) { isPrime = false; break; }
        }
        if (isPrime) count++;
    }

    return count;
}
```

A linha `status = "Working..."` nunca é renderizada. A aba do navegador para de responder por vários segundos, e então as duas atualizações de status aparecem de uma vez.

O motivo é que o runtime do Blazor WebAssembly é de thread única. `Task.Run` enfileira trabalho no thread pool do .NET, mas no runtime `browser-wasm` esse pool é emulado sobre a única thread que o runtime possui. O delegate não começa até que o bloco síncrono atual ceda o controle, e uma vez que começa, nada mais pode se intercalar até que ele retorne. Um `await Task.Delay(1)` antes do laço deixa o primeiro render passar, mas o laço continua bloqueando tudo o que vem depois.

A pergunta óbvia em seguida é se você pode simplesmente ligar as threads. O runtime de fato suporta `<WasmEnableThreads>true</WasmEnableThreads>`, mas esse é um recurso de nível de runtime, e o Blazor WebAssembly não o suporta. O renderizador do Blazor depende da garantia histórica de thread única: lotes de render são entregues ao JavaScript via memória compartilhada sem cópia, e eventos são despachados para o .NET de forma síncrona. O runtime multithread move todo o código .NET para uma thread "deputy" em segundo plano, o que quebra as duas premissas. A issue de acompanhamento [dotnet/aspnetcore#54365](https://github.com/dotnet/aspnetcore/issues/54365) continua aberta. Ligar a flag em um projeto Blazor WASM te dá um build que não roda, não um app mais rápido.

Então a única opção real é executar uma segunda cópia independente do runtime .NET dentro de um Web Worker, e conversar com ela por troca de mensagens. É exatamente isso que o template constrói.

## Criando o projeto worker

Dois comandos e uma referência de projeto:

```bash
# .NET 11 SDK
dotnet new blazorwasm -n SampleApp
dotnet new blazorwebworker -n WebWorker

cd SampleApp
dotnet add reference ../WebWorker/WebWorker.csproj
```

A biblioteca gerada tem esta cara:

```
WebWorker/
├── WebWorker.csproj
├── WebWorkerClient.cs
├── WorkerMethods.cs
└── wwwroot/
    ├── dotnet-web-worker-client.js
    └── dotnet-web-worker.js
```

`dotnet-web-worker.js` é o ponto de entrada do worker. Ele chama `dotnet.create()` para inicializar um runtime WebAssembly sem nenhuma camada do Blazor, depois `getAssemblyExports(assemblyName)` para obter um handle sobre seus métodos `[JSExport]`, e resolve contra esse grafo de objetos os nomes de método que chegam. `dotnet-web-worker-client.js` roda na thread principal, cria o worker e correlaciona requisições com respostas por ID. `WebWorkerClient.cs` é o wrapper em C# sobre esse cliente JavaScript. Você não precisa editar nenhum dos três.

Uma propriedade de projeto importa e o template já a configura:

```xml
<PropertyGroup>
  <AllowUnsafeBlocks>true</AllowUnsafeBlocks>
</PropertyGroup>
```

`[JSExport]` e `[JSImport]` geram código de marshalling que usa ponteiros, então o compilador recusa sem ela. Se mais tarde você adicionar chamadas `[JSImport]` no próprio projeto do app Blazor, precisa da mesma propriedade lá.

## Escrevendo os métodos do worker

Os métodos do worker são `static`, marcados com `[JSExport]`, e vivem em uma `static partial class`. O `partial` não é decorativo: o gerador de código-fonte de interop com JS emite a outra metade. `[SupportedOSPlatform("browser")]` suprime os avisos do analisador de compatibilidade de plataforma, já que essas APIs só existem no runtime do navegador.

`WebWorker/WorkerMethods.cs`:

```csharp
// .NET 11, C# 14
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Text.Json;

namespace WebWorker;

[SupportedOSPlatform("browser")]
public static partial class WorkerMethods
{
    [JSExport]
    public static int CountPrimes(int limit)
    {
        var count = 0;
        for (var n = 2; n <= limit; n++)
        {
            var isPrime = true;
            for (var d = 2; d * d <= n; d++)
            {
                if (n % d == 0) { isPrime = false; break; }
            }
            if (isPrime) count++;
        }

        return count;
    }

    [JSExport]
    public static string Analyze(string csv)
    {
        var rows = csv.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        var report = new Report(rows.Length, rows.Length == 0 ? 0 : rows.Max(r => r.Length));
        return JsonSerializer.Serialize(report);
    }
}

public record Report(int RowCount, int WidestRow);
```

Repare no formato de `Analyze`. `[JSExport]` faz marshalling de um conjunto fixo de tipos através da fronteira com o JavaScript: primitivos, `string`, `byte[]`, `Task<T>` desses, e alguns poucos tipos específicos de JS. Ele não faz marshalling de POCOs ou records arbitrários. A solução padrão é serializar dentro do worker e desserializar do outro lado, que é o que a documentação recomenda e o que o exemplo gerado faz. Se seu payload é uma hierarquia polimórfica, a [configuração do discriminador `[JsonDerivedType]`](/pt-br/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/) se aplica aqui sem mudanças, porque as duas pontas são System.Text.Json.

Também vale saber: `byte[]` cruza diretamente, e o cliente gerado otimiza as transferências de `ArrayBuffer` para que resultados binários grandes sejam movidos em vez de copiados. Se você está retornando bytes de imagem ou de arquivo, prefira `byte[]` a base64 dentro de uma string JSON.

## Chamando o worker a partir de um componente

`WebWorkerClient.CreateAsync` inicializa o worker e espera até que o runtime dentro dele reporte que está pronto. Essa é uma operação assíncrona que envolve um download de rede, então ela pertence ao `OnAfterRenderAsync`, não ao `OnInitializedAsync`.

`Pages/Home.razor.cs`:

```csharp
// .NET 11, C# 14
using System.Text.Json;
using System.Runtime.Versioning;
using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;
using WebWorker;

namespace SampleApp.Pages;

[SupportedOSPlatform("browser")]
public partial class Home : ComponentBase, IAsyncDisposable
{
    private WebWorkerClient? worker;
    private string status = "Booting worker...";

    [Inject] private IJSRuntime JSRuntime { get; set; } = default!;

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (firstRender)
        {
            worker = await WebWorkerClient.CreateAsync(JSRuntime);
            status = "Ready";
            StateHasChanged();
        }
    }

    private async Task Run()
    {
        if (worker is null) return;

        status = "Working...";

        var count = await worker.InvokeAsync<int>(
            "WebWorker.WorkerMethods.CountPrimes", [5_000_000]);

        status = $"Found {count} primes";
    }

    public async ValueTask DisposeAsync()
    {
        if (worker is not null)
        {
            await worker.DisposeAsync();
        }
    }
}
```

Agora `status = "Working..."` é renderizado imediatamente, o spinner gira, e a UI continua interativa enquanto cinco milhões de números são fatorados em outra thread do sistema operacional.

O nome do método é uma string: `AssemblyName.ClassName.MethodName`. O worker a divide e percorre o objeto de exports retornado por `getAssemblyExports`, então um erro de digitação é uma falha em tempo de execução em vez de um erro de compilação. Envolver cada chamada em um pequeno método tipado em uma classe de serviço vale as dez linhas, porque te dá um único lugar onde as strings mágicas vivem.

A posição em `OnAfterRenderAsync` não é estilística. Em um Blazor Web App cujo projeto `.Client` é pré-renderizado no servidor, a interop com JS fica indisponível durante a passagem de prerender, e chamá-la ali lança o erro [JavaScript interop calls cannot be issued at this time](/pt-br/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/). `OnAfterRenderAsync` só roda depois que a interatividade é estabelecida, então o worker é criado exatamente uma vez, no cliente.

## Cancelamento e timeouts

Esta é a adição do .NET 11 que torna o cliente utilizável em produção. A superfície completa:

```csharp
// .NET 11
public sealed class WebWorkerClient : IAsyncDisposable
{
    public static async Task<WebWorkerClient> CreateAsync(
        IJSRuntime jsRuntime,
        int timeoutMs = 60000,
        string? assemblyName = null,
        CancellationToken cancellationToken = default);

    public async Task<TResult> InvokeAsync<TResult>(
        string method,
        object[] args,
        int timeoutMs = 60000,
        CancellationToken cancellationToken = default);

    public async Task InvokeVoidAsync(
        string method,
        object[] args,
        int timeoutMs = 60000,
        CancellationToken cancellationToken = default);

    public async ValueTask DisposeAsync();
}
```

Tanto `timeoutMs` quanto o token protegem a espera da thread principal, não a execução do worker. Um método `[JSExport]` rodando um laço síncrono não consegue observar um `CancellationToken`, porque não há como interrompê-lo de fora. O que o cancelamento te dá é a capacidade de parar de aguardar e derrubar um worker travado:

```csharp
// .NET 11, C# 14
private CancellationTokenSource? cts;

private async Task RunCancellable()
{
    cts?.Cancel();
    cts?.Dispose();
    cts = new CancellationTokenSource();

    try
    {
        var count = await worker!.InvokeAsync<int>(
            "WebWorker.WorkerMethods.CountPrimes",
            [5_000_000],
            timeoutMs: 10_000,
            cancellationToken: cts.Token);

        status = $"Found {count} primes";
    }
    catch (OperationCanceledException)
    {
        status = "Cancelled";

        // The worker is still busy. Kill it and start a fresh one.
        await worker.DisposeAsync();
        worker = await WebWorkerClient.CreateAsync(JSRuntime);
    }
}

private void Cancel() => cts?.Cancel();
```

Descartar depois de um cancelamento é a metade importante. Se você cancela a espera mas mantém o cliente, o cálculo abandonado continua queimando um núcleo e o próximo `InvokeAsync` fica na fila atrás dele. `DisposeAsync` chama `terminate()` no `Worker` subjacente, o que o para imediatamente, não importa o que ele esteja fazendo. O formato geral de propagar um token por uma cadeia de chamadas está coberto no guia sobre [propagar um CancellationToken através de métodos assíncronos](/pt-br/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/), e [`CancellationTokenSource.CancelAfter`](/pt-br/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/) se compõe com `timeoutMs` se você quiser um prazo do lado do cliente que também dispare sua própria limpeza.

Para trabalho cujo resultado você não precisa, `InvokeVoidAsync` pula a viagem de volta do resultado:

```csharp
await worker.InvokeVoidAsync("WebWorker.WorkerMethods.WarmCaches", []);
```

## O custo: cada worker baixa seu próprio runtime

Esta é a parte que surpreende as pessoas, e ela dirige a maioria das decisões de design acima.

O worker não compartilha o runtime da thread principal. Ele inicializa um segundo runtime .NET WebAssembly completo: `dotnet.js`, o `.wasm` do runtime, e todo assembly que sua biblioteca worker referencia transitivamente. O cache HTTP do navegador faz com que o segundo download normalmente seja barato depois da primeira carga, mas a instanciação não é de graça, e a memória realmente dobra porque os dois runtimes têm heaps separados.

As regras práticas que decorrem disso:

- **Crie o cliente uma vez, reutilize para sempre.** Um `CreateAsync` por clique de botão é a forma mais comum de tornar um worker mais lento do que o código que ele substituiu.
- **Para uso em todo o app, registre-o como singleton** e inicialize-o de forma preguiçosa em vez de criá-lo por componente:

  ```csharp
  // .NET 11, C# 14 - Program.cs of the Blazor WebAssembly app
  builder.Services.AddSingleton<WorkerService>();
  ```

  ```csharp
  public sealed class WorkerService(IJSRuntime js) : IAsyncDisposable
  {
      private WebWorkerClient? client;
      private readonly SemaphoreSlim gate = new(1, 1);

      private async Task<WebWorkerClient> GetClientAsync(CancellationToken ct)
      {
          if (client is not null) return client;

          await gate.WaitAsync(ct);
          try
          {
              return client ??= await WebWorkerClient.CreateAsync(js, cancellationToken: ct);
          }
          finally
          {
              gate.Release();
          }
      }

      public async Task<int> CountPrimesAsync(int limit, CancellationToken ct = default)
      {
          var c = await GetClientAsync(ct);
          return await c.InvokeAsync<int>(
              "WebWorker.WorkerMethods.CountPrimes", [limit], cancellationToken: ct);
      }

      public async ValueTask DisposeAsync()
      {
          if (client is not null) await client.DisposeAsync();
          gate.Dispose();
      }
  }
  ```

  O semáforo importa porque dois componentes renderizando ao mesmo tempo vão os dois ver `client is null` e os dois vão chamar `CreateAsync`, te dando dois runtimes onde você queria um.

- **Mantenha pequeno o grafo de dependências da biblioteca worker.** Cada pacote que você referencia a partir do projeto worker é um assembly a mais baixado e carregado no segundo runtime. Coloque ali apenas o código de cálculo, não sua biblioteca de modelos compartilhada com EF Core e validação penduradas nela.
- **Agrupe as chamadas.** Cada invocação é uma ida e volta de `postMessage` com um passo de serialização nas duas pontas. Dez chamadas em um laço são mensuravelmente piores do que uma chamada com um argumento de array.

## O que não cruza a fronteira

O worker é um runtime genuinamente separado, e tratá-lo como uma thread em segundo plano no mesmo processo é de onde vêm os bugs.

**Sem estado compartilhado.** Campos estáticos do seu assembly worker existem duas vezes: uma cópia no runtime da thread principal, outra no worker. Escrever em um estático a partir de um componente e lê-lo de um método `[JSExport]` retorna o que quer que a cópia do worker contenha. Todo o estado precisa viajar nos argumentos e no valor de retorno.

**Sem injeção de dependência.** Os métodos do worker são estáticos e o runtime do worker nunca constrói um provedor de serviços. Se seu código de cálculo precisa de configuração, passe-a como argumentos ou como um blob JSON.

**Sem DOM, sem `IJSRuntime`, sem `NavigationManager`.** Um Web Worker não tem `document` nem `window`. Qualquer coisa que toque a UI precisa acontecer de volta na thread principal depois que `InvokeAsync` retornar.

**Sem callbacks de progresso, de fábrica.** O cliente gerado modela requisição e resposta, não streaming. Se você precisa de uma barra de progresso para um cálculo longo, divida o trabalho em pedaços e faça uma chamada por pedaço, atualizando a UI entre as chamadas.

## Depuração e trimming, as duas arestas ásperas

Exceções lançadas dentro de um método `[JSExport]` voltam como uma string de mensagem através do `postMessage`, então o stack trace de C# que você recebe na thread principal descreve a camada de interop, não seu laço. Quando um método do worker se comporta mal, o caminho mais rápido normalmente é chamar temporariamente o mesmo método estático direto do componente, reproduzi-lo na thread principal com o depurador anexado, e então movê-lo de volta.

Trimming é a segunda coisa a observar. Apps Blazor publicados fazem trimming agressivo, e o worker resolve seus métodos pelo nome em tempo de execução através de `getAssemblyExports`. O atributo `[JSExport]` é o que mantém esses métodos enraizados, então um método exportado está seguro. Qualquer coisa que ele alcance apenas por reflexão, não. Se uma chamada ao worker funciona no `dotnet run` e falha depois do `dotnet publish`, reflexão mais trimming é a primeira hipótese a testar, e as mesmas [regras de segurança de trimming que se aplicam ao Native AOT](/pt-br/2026/06/what-is-native-aot-and-what-does-it-cost-you/) se aplicam aqui.

Por fim, seja honesto sobre se você precisa disso. Se você está construindo um Blazor Web App em vez de um app WebAssembly standalone, o servidor normalmente consegue fazer o cálculo mais rápido do que o cliente leva para inicializar um segundo runtime, e uma simples chamada de API é menos maquinário para o mesmo resultado. Os trade-offs entre os modelos de hospedagem estão descritos na comparação de [Blazor Server, WebAssembly e United](/pt-br/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/). Web Workers são a resposta certa quando os dados já estão no cliente, quando o trabalho é genuinamente intensivo de CPU em vez de intensivo de IO, e quando uma ida e volta ao servidor não é aceitável. Para todo o resto, o servidor continua sendo um thread pool com hardware melhor.

## Relacionados

- [dotnet new webworker: Web Workers de primeira classe para Blazor no .NET 11 Preview 2](/pt-br/2026/04/dotnet-11-preview-2-blazor-webworker-template/)
- [Blazor Server vs Blazor WebAssembly vs Blazor United no .NET 11](/pt-br/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/)
- [Como propagar um CancellationToken através de métodos assíncronos no .NET 11](/pt-br/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/)
- [Fix: JavaScript interop calls cannot be issued at this time durante o prerender do Blazor](/pt-br/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/)
- [Como serializar uma hierarquia de tipos polimórfica com JsonDerivedType no System.Text.Json](/pt-br/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/)
- [Como escrever um isolate de Dart para trabalho intensivo de CPU](/pt-br/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/)

## Fontes

- [ASP.NET Core Blazor with .NET on Web Workers](https://learn.microsoft.com/en-us/aspnet/core/blazor/blazor-with-dotnet-on-web-workers?view=aspnetcore-11.0), Microsoft Learn
- [.NET on Web Workers](https://learn.microsoft.com/en-us/aspnet/core/client-side/dotnet-on-webworkers?view=aspnetcore-11.0), Microsoft Learn
- [What's new in ASP.NET Core in .NET 11: New Blazor Web Worker template](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-11?view=aspnetcore-11.0), Microsoft Learn
- [.NET Web Worker template update to Blazor Web Worker template (dotnet/aspnetcore #66070)](https://github.com/dotnet/aspnetcore/pull/66070), GitHub
- [Make Blazor WebAssembly work on multithreaded runtime (dotnet/aspnetcore #54365)](https://github.com/dotnet/aspnetcore/issues/54365), GitHub
- [JSExportAttribute](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.javascript.jsexportattribute), Microsoft Learn
- [Running background tasks in Blazor with Web Workers](https://andrewlock.net/exploring-the-dotnet-11-preview-1-running-background-tasks-in-blazor-with-web-workers/), Andrew Lock
- [Web Workers API](https://developer.mozilla.org/docs/Web/API/Web_Workers_API), MDN
