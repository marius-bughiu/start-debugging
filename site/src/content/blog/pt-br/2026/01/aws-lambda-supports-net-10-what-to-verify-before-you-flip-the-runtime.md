---
title: "AWS Lambda suporta .NET 10: o que verificar antes de virar o runtime"
description: "AWS Lambda agora suporta .NET 10, mas a atualização do runtime não é a parte difícil. Aqui está um checklist prático cobrindo cold starts, trimming, native AOT e formato de deploy."
pubDate: 2026-01-08
tags:
  - "aws"
  - "dotnet"
  - "dotnet-10"
lang: "pt-br"
translationOf: "2026/01/aws-lambda-supports-net-10-what-to-verify-before-you-flip-the-runtime"
translatedBy: "claude"
translationDate: 2026-04-30
---
O suporte do AWS Lambda para **.NET 10** está começando a aparecer nos canais da comunidade hoje, e é o tipo de mudança que parece "feito" até você bater em cold starts, trimming ou uma dependência nativa em produção.

Discussão original: [r/dotnet thread](https://www.reddit.com/r/dotnet/comments/1q7p9t3/aws_lambda_supports_net_10/)

## O suporte de runtime é a parte fácil; o formato do seu deploy é a parte difícil

Mover um Lambda de .NET 8/9 para **.NET 10** não é só um bump de target framework. O runtime que você seleciona dirige:

-   **Comportamento de cold start**: JIT, ReadyToRun, native AOT e quanto código você envia mudam o perfil de inicialização.
-   **Empacotamento**: imagem de contêiner vs ZIP, mais como você lida com bibliotecas nativas.
-   **Frameworks pesados em reflection**: trimming e AOT podem transformar "funciona localmente" em "falha em runtime".

Se você quer .NET 10 principalmente por desempenho, não assuma que a atualização do runtime do Lambda é a vitória. Meça cold starts com seu handler real, dependências reais, variáveis de ambiente reais e configuração de memória real.

## Um handler mínimo de Lambda em .NET 10 que você pode fazer benchmark

Aqui está um pequeno handler que é fácil de fazer benchmark e fácil de quebrar com trimming. Ele também mostra um padrão que eu gosto: manter o handler minúsculo, empurrar tudo o mais para trás de DI ou caminhos de código explícitos.

```cs
using Amazon.Lambda.Core;

[assembly: LambdaSerializer(typeof(Amazon.Lambda.Serialization.SystemTextJson.DefaultLambdaJsonSerializer))]

public sealed class Function
{
    // Use a static instance to avoid per-invocation allocations.
    private static readonly HttpClient Http = new();

    public async Task<Response> FunctionHandler(Request request, ILambdaContext context)
    {
        // Touch something typical: logging + a small outbound call.
        context.Logger.LogLine($"RequestId={context.AwsRequestId} Name={request.Name}");

        var status = await Http.GetStringAsync("https://example.com/health");
        return new Response($"Hello {request.Name}. Upstream says: {status.Length} chars");
    }
}

public sealed record Request(string Name);
public sealed record Response(string Message);
```

Agora publique de uma forma que combine com seu caminho de produção pretendido. Se você está testando trimming, deixe explícito:

```bash
dotnet publish -c Release -f net10.0 -p:PublishTrimmed=true
```

Se você planeja ir mais fundo em native AOT no .NET 10, publique dessa forma também, e valide se suas dependências são realmente compatíveis com AOT (serialização, reflection, libs nativas).

## Um checklist prático para o primeiro rollout do .NET 10

-   **Meça cold start e steady state separadamente**: p50 e p99 para ambos.
-   **Ligue trimming somente se você puder testar**: falhas de trimming geralmente são falhas em runtime.
-   **Confirme a configuração de memória do seu Lambda**: ela muda a alocação de CPU e pode virar seus resultados.
-   **Fixe dependências sensíveis a TFMs**: `Amazon.Lambda.*`, serializadores e qualquer coisa que use reflection.

Se você quer um primeiro passo seguro, atualize o runtime para **.NET 10** e mantenha sua estratégia de deploy a mesma. Uma vez que esteja estável, experimente com trimming ou AOT em uma branch, e só publique quando seu monitoramento disser que está chato.
