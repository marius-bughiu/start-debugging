---
title: "AG-UI .NET SDK 1.0: AGUI.Server e AGUI.Client tiram o protocolo de dentro do Agent Framework"
description: "O protocolo AG-UI agora tem um SDK .NET independente: AGUI.Server 1.0.0 transmite qualquer IChatClient como eventos AG-UI via SSE, e AGUIChatClient consome um endpoint AG-UI como um IChatClient, até no .NET Framework 4.7.2. Quem usa Agent Framework recebe APIs renomeadas."
pubDate: 2026-09-27
tags:
  - "ag-ui"
  - "dotnet"
  - "ai-agents"
  - "microsoft-extensions-ai"
  - "agent-framework"
lang: "pt-br"
translationOf: "2026/09/ag-ui-dotnet-sdk-1-0-moves-agui-out-of-agent-framework"
translatedBy: "claude"
translationDate: 2026-09-27
---

Em 25 de setembro de 2026 o time do .NET [anunciou um SDK .NET de primeira classe para o protocolo AG-UI](https://devblogs.microsoft.com/dotnet/ag-ui-dotnet-sdk/). Os pacotes chegaram ao NuGet como `1.0.0` em 17 de setembro: `AGUI.Abstractions`, `AGUI.Formatting`, `AGUI.Protobuf`, `AGUI.Server` e `AGUI.Client`, sob licença MIT, hospedados em [ag-ui-protocol/ag-ui em sdks/dotnet](https://github.com/ag-ui-protocol/ag-ui/tree/main/sdks/dotnet). Até agora, suportar AG-UI em .NET significava depender do Microsoft Agent Framework. Esse acoplamento acabou.

## O que é AG-UI, em um parágrafo

[AG-UI](https://docs.ag-ui.com/) é um protocolo de comunicação entre um backend de agente e um frontend. O cliente faz POST de um `RunAgentInput` (mensagens, ferramentas, estado), e o servidor responde com um stream de eventos tipados: `RUN_STARTED`, `TEXT_MESSAGE_CONTENT`, eventos de chamada de ferramenta, `STATE_DELTA`, `RUN_FINISHED`. Server-Sent Events é o transporte padrão, com um codec protobuf opcional para parte do conjunto de eventos. Frontends como o CopilotKit já falam esse protocolo, então um backend .NET que emite eventos AG-UI corretos se conecta diretamente a eles.

## Qualquer IChatClient vira um endpoint AG-UI

`AGUI.Server` tem como alvo `net8.0`, `net9.0` e `net10.0`, e só precisa de um `IChatClient` do `Microsoft.Extensions.AI`. Nenhuma abstração de agente é necessária:

```csharp
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton(CreateChatClient());
builder.Services.Configure<JsonOptions>(options =>
    options.SerializerOptions.TypeInfoResolverChain.Insert(
        0, AGUIJsonUtilities.DefaultTypeInfoResolver));

var app = builder.Build();

app.MapPost("/", (RunAgentInput input, IChatClient chatClient,
    IOptions<JsonOptions> jsonOptions, CancellationToken ct) =>
{
    var context = input.ToChatRequestContext(jsonOptions.Value.SerializerOptions);

    var events = chatClient
        .GetStreamingResponseAsync(context.Messages, context.ChatOptions, ct)
        .AsAGUIEventStreamAsync(context, ct);

    return TypedResults.ServerSentEvents(events);
});

await app.RunAsync();
```

O trabalho interessante acontece em `AsAGUIEventStreamAsync`. Ele envolve a execução em `RUN_STARTED` e `RUN_FINISHED`, fecha um bloco de texto ou de raciocínio aberto antes de passar para outra mensagem ou chamada de ferramenta, e junta múltiplas interrupções em um único `RUN_FINISHED` terminal. São exatamente as regras de ordenação que um mapeador SSE feito à mão costuma errar, e um frontend que recebe um `TEXT_MESSAGE_CONTENT` para um bloco que nunca foi iniciado geralmente falha em silêncio.

## O lado cliente chega ao .NET Framework 4.7.2

`AGUI.Client` também tem como alvo `netstandard2.0` e `net472`. Seu `AGUIChatClient` implementa `IChatClient`, então um agente AG-UI remoto parece qualquer outro modelo para o seu código:

```csharp
using AGUI.Client;

using var httpClient = new HttpClient();
IChatClient agent = new AGUIChatClient(
    new AGUIChatClientOptions(httpClient, "http://localhost:5001"));

await foreach (var update in agent.GetStreamingResponseAsync("Summarize ticket 4211"))
    Console.Write(update.Text);
```

Isso é útil para um app legado WinForms ou WPF no .NET Framework que precisa chamar um agente hospedado em outro lugar sem migrar antes.

## Renomeações que quebram código para quem usa Agent Framework

Se você já usava `Microsoft.Agents.AI.Hosting.AGUI.AspNetCore` (atualmente `1.22.0-preview.260918.1`), o pacote de hosting agora é construído sobre o novo SDK e os nomes mudaram:

| Antes | Depois |
| --- | --- |
| `AddAGUI()` / `MapAGUI()` | `AddAGUIServer()` / `MapAGUIServer()` |
| namespace `Microsoft.Agents.AI.AGUI` | `AGUI.Client`, `AGUI.Server`, `AGUI.Abstractions` |
| construtor posicional de `AGUIChatClient` | `AGUIChatClientOptions` |

```csharp
builder.Services.AddAGUIServer();
var app = builder.Build();

AIAgent agent = chatClient.AsAIAgent(
    name: "AGUIAssistant",
    instructions: "You are a helpful assistant.");

app.MapAGUIServer("/", agent);
```

Somado ao [`AsIChatClient` do Agent Framework 1.22](/pt-br/2026/09/agent-framework-1-22-asichatclient-exposes-an-agent-as-an-ichatclient/) da semana passada, as peças agora se compõem nas duas direções: um `AIAgent` pode ser um `IChatClient`, um `IChatClient` pode ser um endpoint AG-UI, e um endpoint AG-UI pode voltar a ser um `IChatClient`. Se você só precisa de um backend de chat com streaming para um frontend no estilo CopilotKit, `AGUI.Server` mais o seu chat client existente é agora a menor dependência que faz isso corretamente.
