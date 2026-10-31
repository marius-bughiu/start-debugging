---
title: "grpc-dotnet 2.85 aplica MaxReceiveMessageSize depois da descompressão, não apenas antes"
description: "Grpc.AspNetCore e Grpc.Net.Client 2.85.0 agora aplicam MaxReceiveMessageSize ao tamanho descomprimido de mensagens gzip e deflate. Uma requisição de 260 KB que se expande para 256 MiB é rejeitada com ResourceExhausted, mas payloads comprimidos grandes e legítimos também podem começar a falhar."
pubDate: 2026-10-31
tags:
  - "grpc"
  - "aspnetcore"
  - "dotnet"
  - "security"
  - "breaking-changes"
lang: "pt-br"
translationOf: "2026/10/grpc-dotnet-2-85-enforces-maxreceivemessagesize-after-decompression"
translatedBy: "claude"
translationDate: 2026-10-31
---

O [grpc-dotnet 2.85.0](https://github.com/grpc/grpc-dotnet/releases/tag/v2.85.0) foi lançado em 29 de outubro de 2026, e `Grpc.AspNetCore.Server` e `Grpc.Net.Client` 2.85.0 já estão no NuGet. As notas da versão têm quatro linhas, e uma delas é fácil de passar batido: "Enforce receive message size limits during decompression". Ela fecha uma brecha real de esgotamento de memória e também pode passar a rejeitar tráfego que funcionava ontem.

## O que o limite media antes

Tanto `GrpcServiceOptions.MaxReceiveMessageSize` no servidor quanto `GrpcChannelOptions.MaxReceiveMessageSize` no cliente têm como padrão 4 MB (4.194.304 bytes). Até a 2.84.0, essa verificação era feita contra o prefixo de tamanho do frame gRPC, que para uma mensagem comprimida é o tamanho **comprimido**. Depois que a verificação passava, a mensagem era expandida com um simples `compressionStream.CopyTo(new MemoryStream())`, sem nenhum limite.

Assim, um peer que enviasse `grpc-encoding: gzip` podia passar pela verificação de 4 MB com um payload minúsculo e fazer o outro lado alocar tudo o que os dados se expandissem. A reprodução no [PR #2780](https://github.com/grpc/grpc-dotnet/pull/2780) é uma requisição comprimida de 260.934 bytes que se expande para 256 MiB. Não era preciso ativar nada: quando `CompressionProviders` está vazio, `GrpcServiceOptionsSetup` registra `GzipCompressionProvider` e `DeflateCompressionProvider` para você, e `GrpcChannel` vem com os mesmos padrões. Todo serviço gRPC do ASP.NET Core estava exposto aos seus chamadores, e todo cliente estava exposto aos servidores que chamava.

## Como a 2.85.0 lê mensagens comprimidas

A correção move a descompressão, nos dois lados, para um `CommonGrpcProtocolHelpers.TryReadCompressedMessage` compartilhado. Quando há um limite configurado, ele lê o stream de descompressão em blocos de 8 KB vindos de um pool e nunca solicita mais do que um byte além do limite:

```csharp
// Read at most one byte beyond the limit to detect oversized messages without fully decompressing them.
while ((read = compressionStream.Read(buffer, 0, (int)Math.Min(buffer.Length, maxReceiveMessageSize.Value - output.Length + 1))) > 0)
{
    if (output.Length + read > maxReceiveMessageSize.Value)
    {
        message = default;
        return false;
    }

    output.Write(buffer, 0, read);
}
```

A chamada então falha com `StatusCode.ResourceExhausted` e o detalhe "Received message exceeds the maximum configured message size." antes que o método do seu serviço ou o desserializador do cliente veja qualquer coisa. Na reprodução do PR, a bomba de 256 MiB agora custa cerca de 9 MiB de alocações. A verificação do frame comprimido continua sendo executada primeiro, uma mensagem exatamente no limite ainda é aceita, e um limite `null` mantém o comportamento antigo sem restrição.

## A armadilha da atualização: payloads legítimos também contam

O limite agora significa "a mensagem que o seu código recebe", que é o que a maioria das pessoas supunha que ele significava. Mas se você já trafega mensagens comprimidas que se expandem além de 4 MB (exportações em massa, uploads em lote, streams de snapshot de dados muito repetitivos), essas chamadas funcionavam na 2.84.0 porque apenas o tamanho comprimido era verificado. Na 2.85.0 elas recebem `ResourceExhausted`.

Aumente o limite de forma deliberada e da maneira mais restrita possível:

```csharp
builder.Services.AddGrpc(options =>
{
    options.ResponseCompressionAlgorithm = "gzip";
    // Global default stays at 4 MB
})
.AddServiceOptions<ExportService>(options =>
{
    // This service legitimately receives large batches
    options.MaxReceiveMessageSize = 32 * 1024 * 1024;
});

// Client side, for responses that inflate past 4 MB
using var channel = GrpcChannel.ForAddress("https://exports.internal", new GrpcChannelOptions
{
    MaxReceiveMessageSize = 32 * 1024 * 1024
});
```

Evite definir `MaxReceiveMessageSize = null` para fazer os erros sumirem: isso restaura exatamente a expansão sem limite que esta versão remove.

Antes de atualizar, descubra quais dos seus chamadores realmente comprimem: procure nos seus traces por um header de requisição `grpc-encoding` diferente de `identity`, ou por metadados `grpc-internal-encoding-request` e `ResponseCompressionAlgorithm` na configuração do cliente e do servidor. Se nada comprime, a 2.85.0 é uma atualização direta. Se algo comprime, meça o tamanho descomprimido da sua maior mensagem real e defina o limite por serviço acima dele. Para uma visão mais ampla de onde o gRPC se encaixa ao lado de REST e SignalR, veja [gRPC vs REST vs SignalR para chamadas entre serviços no .NET 11](/pt-br/2026/08/grpc-vs-rest-vs-signalr-for-service-to-service-calls-in-dotnet-11/).
