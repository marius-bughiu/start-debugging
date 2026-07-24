---
title: "Clientes SignalR finalmente podem cancelar um método de hub em execução no .NET 11 Preview 6"
description: "Cancelar o CancellationToken que você passa para InvokeAsync agora chega ao servidor e cancela o método de hub. Isso encerra uma solicitação do SignalR aberta desde 2019."
pubDate: 2026-07-24
tags:
  - "aspnetcore"
  - "dotnet-11"
  - "signalr"
  - "csharp"
lang: "pt-br"
translationOf: "2026/07/signalr-client-cancel-hub-method-dotnet-11-preview-6"
translatedBy: "claude"
translationDate: 2026-07-24
---

O [.NET 11 Preview 6](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-6/) foi lançado em 2026-07-15, e encerra uma das solicitações de recurso mais antigas do SignalR. A [issue #11542](https://github.com/dotnet/aspnetcore/issues/11542), "Possibility to cancel long running hub method from client," estava aberta desde 2019. O [PR #64098](https://github.com/dotnet/aspnetcore/pull/64098) finalmente ligou tudo: o `CancellationToken` que você passa para `InvokeAsync` no cliente .NET agora realmente chega ao servidor e cancela o método de hub.

## O token que antes mentia para você

Antes do Preview 6, o cliente .NET do SignalR já aceitava um `CancellationToken` em `InvokeAsync`. Só que não fazia o que a maioria imaginava. Cancelá-lo interrompia a espera do *cliente* por um resultado, mas o método de hub no servidor continuava executando até o fim. Não havia como dizer ao servidor "pare, quem chamou foi embora." As invocações de streaming enviavam uma mensagem `CancelInvocation`, mas as invocações normais de requisição-resposta não.

Essa lacuna acabou. Quando você cancela o token passado para `InvokeAsync`, o cliente envia um `CancelInvocationMessage` ao servidor, que encontra a invocação correspondente e a cancela.

## Como ligar isso

No servidor, declare um parâmetro `CancellationToken` no método de hub. O SignalR o preenche como um argumento sintético, então o cliente nunca o envia:

```csharp
public class ReportHub : Hub
{
    public async Task<string> BuildReport(int rows, CancellationToken cancellationToken)
    {
        for (var i = 0; i < rows; i++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await Task.Delay(50, cancellationToken); // real work here
        }

        return "done";
    }
}
```

Até o Preview 6, um parâmetro `CancellationToken` em um método de hub que não fosse de streaming era ignorado: o framework só sintetizava um para métodos de streaming. Agora o `HubMethodDescriptor` permite isso em todo lugar.

No cliente, passe um token e cancele-o quando não precisar mais do resultado:

```csharp
using var cts = new CancellationTokenSource();
cts.CancelAfter(TimeSpan.FromSeconds(2));

try
{
    var result = await connection.InvokeAsync<string>(
        "BuildReport", 100_000, cts.Token);
}
catch (OperationCanceledException)
{
    // The server's token fired too, so the hub method stopped.
}
```

## O que acontece nos bastidores

O `DefaultHubDispatcher` registra o `CancellationTokenSource` de cada invocação em `ActiveRequestCancellationSources`, indexado pelo id da invocação. Quando o `CancelInvocationMessage` chega, ele procura essa fonte e chama `Cancel()`, o que dispara o token que o seu método de hub está observando. É o mesmo registro que as invocações de streaming já usavam, agora compartilhado com as normais.

Dois pontos a lembrar. O cancelamento é cooperativo: se o seu método de hub nunca verifica o token nem o repassa para as chamadas assíncronas que faz, nada para. E esta é uma versão prévia, então o comportamento ainda pode mudar antes de o .NET 11 ser lançado em novembro de 2026.

O mesmo Preview 6 também [ativou a proteção CSRF automática](/pt-br/2026/07/aspnetcore-11-automatic-csrf-protection-fetch-metadata-preview-6/), então é uma boa versão para testar. Todos os detalhes estão nas [notas de versão do ASP.NET Core Preview 6](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/aspnetcore.md). Se você já construiu um botão de "cancelar" que só mentia para o usuário, esta é a versão que o torna honesto.
