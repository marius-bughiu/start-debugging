---
title: "Blazor ganha componentes de UI agêntica no .NET 11 RC1: ChatPage, UIAgent e aprovações de ferramentas"
description: "Microsoft.AspNetCore.Components.AI é um pacote experimental do Blazor no .NET 11 RC1 que transforma qualquer IChatClient em uma UI de chat com streaming, aprovações de ferramentas, renderização tipada de ferramentas e estado compartilhado via AG-UI."
pubDate: 2026-09-29
tags:
  - "blazor"
  - "dotnet-11"
  - "aspnet-core"
  - "ai-agents"
  - "microsoft-extensions-ai"
  - "ag-ui"
lang: "pt-br"
translationOf: "2026/09/blazor-ai-components-agentic-ui-dotnet-11-rc1"
translatedBy: "claude"
translationDate: 2026-09-29
---

Em 2026-09-28, Daniel Roth publicou [Build Agentic UI with the new Blazor AI components](https://devblogs.microsoft.com/dotnet/build-agentic-ui-blazor/), o primeiro tutorial de verdade sobre `Microsoft.AspNetCore.Components.AI`. O pacote chegou discretamente com o [.NET 11 RC1](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/rc1/aspnetcore.md#experimental-blazor-ai-components-for-agentic-user-interfaces) e está marcado como experimental: ele continua em versão prévia durante todo o ciclo do .NET 11. O que ele entrega é a parte que toda equipe que constrói um frontend de agente vem reescrevendo à mão: renderização de mensagens em streaming, exibição de chamadas de ferramentas, etapas de aprovação humana e estado que o agente pode editar.

## Do IChatClient a uma página de chat funcional

Tudo gira em torno de `UIAgent`, que envolve qualquer `IChatClient` do `Microsoft.Extensions.AI`, consome o stream de `ChatResponseUpdate` e o mapeia para instâncias observáveis de `ContentBlock` que os componentes Razor renderizam. O caminho mais rápido é o `ChatPage`, um shell completo com lista de mensagens, entrada de texto, status de streaming e nova tentativa:

```bash
dotnet add package Microsoft.AspNetCore.Components.AI --prerelease
```

```razor
<link rel="stylesheet" href="@Assets["_content/Microsoft.AspNetCore.Components.AI/ai-chat.css"]" />

<ChatPage Agent="_agent" Placeholder="Type a message...">
    <WelcomeContent>
        <p>Ask the agent a question.</p>
    </WelcomeContent>
</ChatPage>

@code {
    private UIAgent _agent = default!;

    protected override void OnInitialized()
    {
        IChatClient chatClient = GetChatClient();
        _agent = new UIAgent(chatClient);
    }
}
```

Quando o shell não for mais suficiente, o `ChatPage` se decompõe em `AgentBoundary`, `MessageList`, `MessageInput` e `BlockRenderer<TBlock>`, para que você monte o layout da conversa por conta própria e escolha o conteúdo Razor de cada tipo de bloco.

## Aprovações e renderização tipada de ferramentas

A parte que mais me interessa é o fluxo de aprovação. Envolva uma ferramenta de consequências importantes em `ApprovalRequiredAIFunction` e o agente pausa em um `FunctionApprovalBlock` até que o usuário decida:

```razor
<BlockRenderer TBlock="FunctionApprovalBlock" Context="block">
    @if (block.Status == ApprovalStatus.Pending)
    {
        <button @onclick="block.Approve">Approve</button>
        <button @onclick="() => block.Reject()">Reject</button>
    }
</BlockRenderer>
```

Para ferramentas de backend, você declara como uma chamada é renderizada com um bloco gerado por source generator e depois o registra com `options.AddGeneratedToolBlocks()`:

```csharp
[ToolBlock("get_weather")]
public partial class WeatherToolBlock : FunctionInvocationContentBlock
{
    [ToolParameter(Name = "location")]
    public string? Location { get; set; }

    [ToolResult]
    public WeatherInfo? Weather { get; set; }
}
```

As ferramentas de frontend são simples delegates `AIFunctionFactory.Create` adicionados a `ChatOptions.Tools`, de modo que o modelo pode chamar de volta o componente (o exemplo define a cor de destaque da página por meio de `InvokeAsync`).

## Estado compartilhado e AG-UI

`UIAgent<TState>` adiciona um objeto de estado fortemente tipado que o agente e o usuário editam juntos. Um `StateMapper` em `UIAgentOptions` aplica o estado recebido, e o estado preditivo permite que o agente prepare uma alteração que a UI confirma com `AcceptPredictiveState()` ou descarta com `RejectPredictiveState()`.

O estado trafega pelo [AG-UI](https://docs.ag-ui.com/sdk/dotnet): `STATE_SNAPSHOT` o substitui, `STATE_DELTA` o altera com JSON Patch (RFC 6902), e os eventos `REASONING_*` aparecem como painéis de raciocínio recolhíveis. Para apontar a UI para um agente remoto, entregue ao `UIAgent` um `AGUIChatClient` em vez de um cliente de modelo:

```csharp
HttpClient http = httpClientFactory.CreateClient("agentserver");
IChatClient client = new AGUIChatClient(new AGUIChatClientOptions(http, endpoint));
```

O lado do servidor é `AddAGUIServer()` mais `MapAGUIServer("/agentic_chat", agent)`, tanto de `Microsoft.Agents.AI.Hosting.AGUI.AspNetCore` quanto de `AGUI.Server`, o pacote independente que abordei em [AG-UI .NET SDK 1.0](/pt-br/2026/09/ag-ui-dotnet-sdk-1-0-moves-agui-out-of-agent-framework/).

## Vale usar agora?

Ele exige o SDK do .NET 11 RC1 e a API está explicitamente aberta a feedback, então espere renomeações antes do GA. Para uma nova ferramenta interna com agente, já é o caminho mais curto de um `IChatClient` até uma UI com aprovações. O conjunto completo de cenários está no [repositório de exemplo AgenticUI](https://github.com/danroth27/AgenticUI).
