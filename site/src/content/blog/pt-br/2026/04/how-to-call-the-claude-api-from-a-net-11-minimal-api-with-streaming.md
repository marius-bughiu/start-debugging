---
title: "Como chamar a Claude API de uma Minimal API do .NET 11 com streaming"
description: "Faça streaming de respostas do Claude a partir de uma minimal API do ASP.NET Core 11 de ponta a ponta: o SDK oficial da Anthropic para .NET, TypedResults.ServerSentEvents, SseItem, IAsyncEnumerable, fluxo de cancelamento e os detalhes que silenciosamente acumulam seus tokens em buffer. Com exemplos de Claude Sonnet 4.6 e Opus 4.7."
pubDate: 2026-04-30
tags:
  - "llm"
  - "ai-agents"
  - "anthropic-sdk"
  - "aspnet-core"
  - "dotnet-11"
  - "streaming"
lang: "pt-br"
translationOf: "2026/04/how-to-call-the-claude-api-from-a-net-11-minimal-api-with-streaming"
translatedBy: "claude"
translationDate: 2026-04-30
---

Se você conectar Claude a uma minimal API do ASP.NET Core 11 do jeito óbvio, vai obter uma requisição que "funciona" e uma saída que chega em um único bloco lento depois de doze segundos. A API da Anthropic está fazendo streaming da resposta enquanto gera cada token. Seu endpoint está coletando os tokens, serializando a mensagem completa em JSON e enviando tudo de uma vez quando o modelo diz `message_stop`. Cada servidor, proxy e navegador entre Kestrel e o usuário está colocando em buffer porque nada disse a eles que isso era um stream.

Este guia mostra a fiação correta na stack atual: ASP.NET Core 11 (preview 3 em abril de 2026, RTM ainda este ano), o SDK oficial da Anthropic para .NET (`Anthropic` no NuGet), Claude Sonnet 4.6 (`claude-sonnet-4-6`) e Claude Opus 4.7 (`claude-opus-4-7`), e `TypedResults.ServerSentEvents` de `Microsoft.AspNetCore.Http`. Vamos sair de um endpoint simples que coloca em buffer, passar por um endpoint `IAsyncEnumerable<string>` que faz streaming de texto em chunks, até um endpoint `SseItem<T>` tipado que emite eventos SSE adequados que um `EventSource` do navegador consegue ler. Depois lidamos com cancelamento, erros, chamadas de ferramentas e os proxies que silenciosamente quebram tudo.

## Por que "só aguardar a resposta" está errado aqui

Uma chamada não-streaming ao Claude retorna uma `Message` completa depois que o modelo terminou. Para uma resposta de 1.500 tokens no Sonnet 4.6 isso são aproximadamente seis a doze segundos de ar morto. É UX ruim em uma UI de chat e pior em uma conexão lenta, porque o usuário não vê nada até tudo chegar. Também custa os mesmos tokens de input fazer streaming ou não, então não há vantagem em colocar em buffer.

O endpoint de streaming, documentado na [referência de streaming da Anthropic](https://platform.claude.com/docs/en/build-with-claude/streaming), usa Server-Sent Events. Cada chunk é um frame SSE com um evento nomeado (`message_start`, `content_block_delta`, `message_stop`, etc.) e um payload JSON. O SDK do .NET embrulha isso em um `IAsyncEnumerable` para você não ter que parsear SSE você mesmo ao chamar a Anthropic. A metade mais difícil é o lado de *saída*: como reemitir esses chunks para o navegador sem um framework colocá-los em buffer prestativamente?

ASP.NET Core 8 ganhou streaming nativo de `IAsyncEnumerable<T>` para minimal APIs. ASP.NET Core 10 adicionou `TypedResults.ServerSentEvents` e `SseItem<T>` para você poder retornar SSE adequado sem escrever `text/event-stream` à mão. Ambos vêm no 11. Juntos, cobrem as duas formas que você realmente quer.

## A versão com buffer que você não deveria publicar

Aqui está o endpoint ingênuo, só para termos um ponto de partida para quebrar.

```csharp
// .NET 11 preview 3, Anthropic 0.2.0-alpha (NuGet: Anthropic)
using Anthropic;
using Anthropic.Models.Messages;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton(_ => new AnthropicClient());
var app = builder.Build();

app.MapPost("/chat", async (ChatRequest req, AnthropicClient client) =>
{
    var parameters = new MessageCreateParams
    {
        Model = Model.ClaudeSonnet4_6,
        MaxTokens = 1024,
        Messages = [new() { Role = Role.User, Content = req.Prompt }]
    };

    var message = await client.Messages.Create(parameters);
    return Results.Ok(new { text = message.Content[0].Text });
});

app.Run();

record ChatRequest(string Prompt);
```

Isso funciona. Também bloqueia toda a resposta até o Claude terminar. A correção são duas mudanças: trocar a chamada do SDK para `CreateStreaming` e entregar ao ASP.NET um enumerador em vez de uma `Task<T>`.

## Streaming de chunks de texto com IAsyncEnumerable<string>

O SDK da Anthropic para .NET expõe `client.Messages.CreateStreaming(parameters)`, que retorna um enumerable assíncrono de deltas de texto. Combine isso com um endpoint de minimal API que retorne `IAsyncEnumerable<string>` e o ASP.NET Core fará streaming como `application/json` (um array JSON, escrito incrementalmente) sem buffer.

```csharp
// .NET 11 preview 3, Anthropic 0.2.0-alpha
using System.Runtime.CompilerServices;
using Anthropic;
using Anthropic.Models.Messages;

app.MapPost("/chat/stream", (ChatRequest req,
                              AnthropicClient client,
                              CancellationToken ct) =>
{
    return StreamChat(req.Prompt, client, ct);

    static async IAsyncEnumerable<string> StreamChat(
        string prompt,
        AnthropicClient client,
        [EnumeratorCancellation] CancellationToken ct)
    {
        var parameters = new MessageCreateParams
        {
            Model = Model.ClaudeSonnet4_6,
            MaxTokens = 1024,
            Messages = [new() { Role = Role.User, Content = prompt }]
        };

        await foreach (var chunk in client.Messages.CreateStreaming(parameters)
                                                    .WithCancellation(ct))
        {
            yield return chunk;
        }
    }
});
```

Três detalhes importam aqui:

1. **Função local**, não uma lambda. O compilador do C# não permite `yield return` dentro de lambdas ou métodos anônimos, então o delegate da minimal API chama um método iterador async local. Isso pega de surpresa todo mundo que escreve minimal APIs desde o .NET 6, porque qualquer outra forma de endpoint funciona como lambda.
2. **`[EnumeratorCancellation]`** no parâmetro `CancellationToken` do iterador. Sem ele, o token de abort da requisição do ASP.NET não fluirá para dentro do enumerador, e uma conexão fechada não vai parar o SDK, que continuará alegremente o stream e queimará seus tokens de output. O compilador não avisa sobre isso. Adicione o atributo ou verifique com um profiler se fechar a aba realmente cancela a requisição.
3. **`.WithCancellation(ct)`** sobre o enumerable do SDK. Cinto e suspensório, mas torna o cancelamento explícito na fronteira que importa.

O formato no fio neste endpoint é um array JSON. O navegador não recebe um stream amigável para `EventSource`, mas `fetch` com um leitor de `ReadableStream` funciona bem, assim como qualquer consumidor que saiba lidar com um array JSON em chunks. Se seu cliente é um hub do SignalR ou um framework de UI dirigido pelo servidor, geralmente é a forma que você quer.

## Streaming de SSE adequado com TypedResults.ServerSentEvents

Se seu cliente é um navegador usando `EventSource` ou uma ferramenta de terceiros que espera `text/event-stream`, você quer SSE, não JSON. ASP.NET Core 10 adicionou `TypedResults.ServerSentEvents`, que recebe um `IAsyncEnumerable<SseItem<T>>` e escreve uma resposta SSE real com o content type correto, headers no-cache e framing correto.

`SseItem<T>` está em `System.Net.ServerSentEvents`. Cada item carrega um tipo de evento, um ID opcional, um intervalo de reconexão opcional e um payload `Data` do tipo `T`. ASP.NET serializa o payload como JSON, a menos que você envie uma string, caso em que passa direto.

```csharp
// .NET 11 preview 3, Anthropic 0.2.0-alpha
using System.Net.ServerSentEvents;
using System.Runtime.CompilerServices;
using Anthropic;
using Anthropic.Models.Messages;
using Microsoft.AspNetCore.Http;

app.MapPost("/chat/sse", (ChatRequest req,
                           AnthropicClient client,
                           CancellationToken ct) =>
{
    return TypedResults.ServerSentEvents(StreamChat(req.Prompt, client, ct));

    static async IAsyncEnumerable<SseItem<string>> StreamChat(
        string prompt,
        AnthropicClient client,
        [EnumeratorCancellation] CancellationToken ct)
    {
        var parameters = new MessageCreateParams
        {
            Model = Model.ClaudeSonnet4_6,
            MaxTokens = 1024,
            Messages = [new() { Role = Role.User, Content = prompt }]
        };

        await foreach (var chunk in client.Messages.CreateStreaming(parameters)
                                                    .WithCancellation(ct))
        {
            yield return new SseItem<string>(chunk, eventType: "delta");
        }

        yield return new SseItem<string>("", eventType: "done");
    }
});
```

Agora um navegador pode fazer isto:

```javascript
// Browser, native EventSource (still GET-only) or fetch-event-source for POST.
const es = new EventSource("/chat/sse?prompt=...");
es.addEventListener("delta", (e) => append(e.data));
es.addEventListener("done", () => es.close());
```

O framing no fio é o formato SSE padrão:

```
event: delta
data: "Hello"

event: delta
data: " world"

event: done
data: ""

```

Duas notas sobre escolher entre os dois endpoints. Se o cliente é um navegador usando `EventSource`, você quer SSE. Se for qualquer outra coisa, incluindo seu próprio front-end com um leitor de `fetch`, o endpoint `IAsyncEnumerable<string>` é mais simples, mais cacheável em config de CDN e mantém a forma do body óbvia. A API `TypedResults.ServerSentEvents` está documentada em [Create responses in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/responses?view=aspnetcore-10.0).

## Fixando IDs de modelo e custo

Para streaming estilo chat, os defaults corretos em abril de 2026 são:

- **Claude Sonnet 4.6 (`claude-sonnet-4-6`)** para chat geral. $3 / milhão de tokens de input, $15 / milhão de output. Latência ao primeiro byte por volta de 400-600 ms em `us-east-1`. Janela de contexto 200k.
- **Claude Opus 4.7 (`claude-opus-4-7`)** para raciocínio difícil. $15 / $75. Primeiro byte mais lento, 800 ms-1.2 s. Janela de contexto 200k, 1M com a beta de contexto longo.
- **Claude Haiku 4.5 (`claude-haiku-4-5`)** para chamadas baratas de alto throughput. $1 / $5. Primeiro byte sub-300 ms.

Declare o ID do modelo no código, nunca via uma string de configuração que o front end possa sobrescrever. As constantes do SDK (`Model.ClaudeSonnet4_6`, `Model.ClaudeOpus4_7`, `Model.ClaudeHaiku4_5`) compilam eliminando o risco de typos. Os preços estão na [página de preços da Claude API](https://www.anthropic.com/pricing); confira antes de faturar qualquer coisa.

Se você está prestes a colocar um system prompt longo ou catálogo de ferramentas na frente de cada requisição, também quer prompt caching ligado, porque streaming e caching compõem limpinho. O detalhamento está em [Como adicionar prompt caching a uma app do Anthropic SDK e medir a taxa de acertos](/pt-br/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/).

## O que o SDK está escondendo de você

Os chunks de string saindo de `CreateStreaming` são a visão amigável do SDK do stream cru de eventos SSE. Os eventos reais que você veria se parseasse o fio você mesmo são:

- `message_start`: um envelope `Message` com `content` vazio. Carrega o ID da mensagem e `usage` inicial.
- `content_block_start`: abre um bloco de conteúdo (text, tool_use ou thinking).
- `content_block_delta`: atualizações incrementais. O `delta.type` é um de `text_delta`, `input_json_delta`, `thinking_delta` ou `signature_delta`.
- `content_block_stop`: fecha o bloco atual.
- `message_delta`: atualizações de nível superior incluindo `stop_reason` e uso cumulativo de tokens de output.
- `message_stop`: fim do stream.
- `ping`: enchimento, enviado para evitar que proxies matem conexões inativas. Ignorar.

O SDK colapsa tudo isso na saída do iterador que você vê, mas você ganha uma visão mais rica se pedir. Cheque a sobrecarga do SDK que retorna os eventos crus, ou segure a `Message` acumulada depois do loop com `.GetFinalMessage()` para conseguir ler o `usage` real (cumulativo no `message_delta`, final no `message_stop`). Para um loop de agente quase sempre você quer a mensagem final: é onde o SDK te dá `stop_reason`, as chamadas de ferramentas montadas e os contadores de tokens de input/output que você precisa para faturamento.

## Cancelamento que realmente cancela

Este é o bug que ninguém pega em dev e todo mundo pega em prod. O usuário fecha a aba. ASP.NET dispara o token de abort da requisição. Seu `IAsyncEnumerable` do endpoint deveria parar, o SDK deveria parar, o stream HTTP subjacente para a Anthropic deveria fechar. Cada elo dessa cadeia tem que honrar o token, e qualquer um quebrando deixa você gerando tokens que ninguém está lendo.

Três lugares para verificar:

1. O atributo `[EnumeratorCancellation]` no parâmetro de token do seu iterador. Sem ele, o token passado pelo ASP.NET no `WithCancellation` não vira o `ct` do iterador.
2. A chamada `CreateStreaming` precisa do token. Passe via `.WithCancellation(ct)` ou via as opções por chamada do SDK se você está em uma versão que aceita um token diretamente.
3. O lado do navegador tem que fechar de verdade. `EventSource` reconecta por padrão. Se você não chama `es.close()` do cliente, uma navegação para fora pode disparar uma requisição nova alguns segundos depois. Para conclusões longas, isso pode custar dinheiro real.

O teste mais limpo é chamar o endpoint com `curl`, matá-lo com Ctrl-C no meio do stream e observar o dashboard da Anthropic ou seus próprios logs de requisição. A conexão para a Anthropic deveria fechar em menos de um segundo da desconexão do cliente. Se não fecha, seu token não está fluindo em algum lugar.

Para um tratamento mais longo de cancelamento em loops de IO em geral, veja [Como cancelar uma tarefa de longa duração em C# sem deadlock](/pt-br/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/).

## Erros no meio do stream

Uma resposta streaming que já começou não pode retornar um 500. Você se comprometeu com um 200 no momento em que o Kestrel mandou o primeiro byte. Erros depois desse ponto têm que fluir como dados, não como status HTTP. O padrão que mantém clientes sãos:

```csharp
static async IAsyncEnumerable<SseItem<string>> StreamChat(
    string prompt,
    AnthropicClient client,
    [EnumeratorCancellation] CancellationToken ct)
{
    var parameters = new MessageCreateParams
    {
        Model = Model.ClaudeSonnet4_6,
        MaxTokens = 1024,
        Messages = [new() { Role = Role.User, Content = prompt }]
    };

    IAsyncEnumerator<string>? enumerator = null;
    try
    {
        enumerator = client.Messages.CreateStreaming(parameters)
                                     .WithCancellation(ct)
                                     .GetAsyncEnumerator();
    }
    catch (Exception ex)
    {
        yield return new SseItem<string>(ex.Message, eventType: "error");
        yield break;
    }

    while (true)
    {
        bool moved;
        try
        {
            moved = await enumerator.MoveNextAsync();
        }
        catch (OperationCanceledException) { yield break; }
        catch (Exception ex)
        {
            yield return new SseItem<string>(ex.Message, eventType: "error");
            yield break;
        }

        if (!moved) break;
        yield return new SseItem<string>(enumerator.Current, eventType: "delta");
    }

    yield return new SseItem<string>("", eventType: "done");
}
```

Isso é mais feio que o caminho feliz, mas é o formato certo. Um `try` não pode envolver um `yield return`, então você divide a iteração em um loop manual de `MoveNextAsync`. Falhas no meio do stream (rate limits, sobrecarga do modelo, soluços de rede) viram um evento `error` que o cliente pode renderizar. Desligamentos limpos viram um evento `done`. Cancelamentos saem silenciosamente porque a requisição já foi.

Dois erros específicos da Anthropic merecem o próprio tratamento do lado do cliente: `overloaded_error` (o modelo está temporariamente sem capacidade, retente com backoff) e `rate_limit_error` (você bateu no limite por minuto ou por dia da org). Ambos chegam como exceções do SDK no lado .NET, com um `AnthropicException` tipado sobre o qual você pode fazer pattern matching.

## Chamadas de ferramentas em um stream

Se seu endpoint pode produzir blocos de conteúdo `tool_use`, o SDK ainda te dá um iterador tipo string para deltas de texto, mas você perde o payload da chamada de ferramenta a menos que também se inscreva nos eventos que o carregam. O `Messages.CreateStreamingRaw` de mais baixo nível (ou o equivalente na sua versão do SDK) expõe os eventos tipados. O padrão: rotear `text_delta` para seu canal SSE delta, rotear `input_json_delta` (os fragmentos de argumento da chamada de ferramenta) para um canal `tool` separado, e deixar o cliente decidir o que renderizar.

Na prática, a maioria das UIs de chat não precisa renderizar os argumentos JSON enquanto fazem streaming. Elas esperam o `content_block_stop` no bloco de ferramenta, depois mostram "Calling get_weather..." e o resultado. Fazer streaming de argumentos de ferramenta token por token é principalmente uma ajuda de depuração.

Se você já está cabendo chamadas de ferramentas, provavelmente também está expondo serviços para o Claude como ferramentas MCP. O padrão do lado servidor em .NET está em [Como construir um servidor MCP customizado em C# no .NET 11](/pt-br/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/). O endpoint streaming aqui é o *cliente* dessas ferramentas, não o servidor.

## O buffering de proxy que quebra tudo

Você cabea tudo corretamente. Bate nele a partir de `localhost`. Faz streaming. Você publica atrás de nginx, Cloudflare ou um Azure Front Door, e a resposta volta em um grande bloco bufferizado. Três configurações para conhecer, em ordem de prioridade:

- **nginx**: configure `proxy_buffering off;` na location SSE, ou adicione `X-Accel-Buffering: no` como header de resposta do seu endpoint. O truque do header é portátil e sobrevive a mudanças de proxy reverso. Adicione em middleware para qualquer endpoint retornando `text/event-stream` ou `application/json` com `IAsyncEnumerable`.
- **Cloudflare**: ative [Streaming responses](https://developers.cloudflare.com/) na rota relevante. O comportamento padrão preserva chunks na maioria dos planos, mas regras WAF enterprise podem bufferizar. Teste primeiro com o truque do header de resposta.
- **Compressão**: o middleware de compressão de resposta pode coletar chunks para comprimir em blocos maiores. Ou desative compressão para `text/event-stream`, ou use `application/json` com transferência em chunks; a compressão de resposta do ASP.NET conhece os dois, mas um middleware customizado ordenado antes do endpoint streaming pode derrotar.

Adicione este filtro aos endpoints streaming para garantir que o header está presente:

```csharp
app.MapPost("/chat/sse", ...)
   .AddEndpointFilter(async (ctx, next) =>
   {
       ctx.HttpContext.Response.Headers["X-Accel-Buffering"] = "no";
       return await next(ctx);
   });
```

Para mais sobre fazer streaming de bodies com segurança a partir do ASP.NET Core, veja [Como fazer streaming de um arquivo de um endpoint do ASP.NET Core sem buffer](/pt-br/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/). A lição "não deixe middleware coletar seus chunks" se aplica identicamente a streams de LLM.

## Observabilidade para o endpoint streaming

Uma chamada streaming ao Claude tem dois números de latência que vale a pena rastrear: tempo até o primeiro token (a latência que o usuário sente) e tempo total até a conclusão. Ambos deveriam aterrissar nos seus traces. O suporte nativo a OpenTelemetry do ASP.NET Core 11 torna isso fácil sem pegar dependência em pacotes `Diagnostics.Otel`. A configuração está em [Tracing nativo de OpenTelemetry no ASP.NET Core 11](/pt-br/2026/04/aspnetcore-11-native-opentelemetry-tracing/).

Capture três atributos customizados no span da requisição: o ID do modelo, o contador de tokens de input (da `Message` final do SDK) e o contador de tokens de output. Reconstruir custo só dos logs é doloroso de outra forma. Histogramas de latência agrupados por modelo deixam óbvio quando você deveria cair de Opus 4.7 para Sonnet 4.6 para tráfego de rotina.

## E sobre Microsoft.Extensions.AI

Se você prefere codar contra as abstrações neutras de provedor, `IChatClient.GetStreamingResponseAsync` do Microsoft.Extensions.AI retorna `IAsyncEnumerable<ChatResponseUpdate>` e funciona da mesma forma na fronteira HTTP. Embrulhe o adapter `IChatClient` da Anthropic, projete os updates para texto ou `SseItem<T>`, e o resto deste artigo se aplica sem mudanças. O trade-off é uma camada de abstração pela opção de trocar para OpenAI ou um modelo local depois. Para código de agentes você também quer a versão do framework, veja [Microsoft Agent Framework 1.0: agentes de IA em C#](/pt-br/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/), que constrói em cima dessas mesmas abstrações.

Para o ângulo BYOK (entregando essa mesma chave da Anthropic ao GitHub Copilot no VS Code), a configuração espelha o que você faz aqui: os mesmos IDs de modelo, a mesma chave, um consumidor diferente. Veja [GitHub Copilot no VS Code: BYOK com Anthropic, Ollama e Foundry Local](/pt-br/2026/04/github-copilot-vs-code-byok-anthropic-ollama-foundry-local/).

## Fontes

- [Streaming Messages, Claude API docs](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Anthropic .NET SDK on GitHub](https://github.com/anthropics/anthropic-sdk-csharp)
- [Anthropic NuGet package](https://www.nuget.org/packages/Anthropic/)
- [Create responses in Minimal API applications, ASP.NET Core docs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/responses?view=aspnetcore-10.0)
- [System.Net.ServerSentEvents.SseItem<T>](https://learn.microsoft.com/en-us/dotnet/api/system.net.serversentevents.sseitem-1)
- [Claude API pricing](https://www.anthropic.com/pricing)
