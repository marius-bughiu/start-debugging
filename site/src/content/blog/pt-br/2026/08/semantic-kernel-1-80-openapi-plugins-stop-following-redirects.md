---
title: "Semantic Kernel 1.80.0 impede que plugins OpenAPI sigam redirecionamentos"
description: "O Semantic Kernel .NET 1.80.0 traz uma mudança incompatível: o HttpClient padrão do plugin OpenAPI não segue mais redirecionamentos e fecha um bypass de SSRF. Veja o que muda e por que o seu próprio HttpClient reabre a brecha."
pubDate: 2026-08-19
tags:
  - "dotnet"
  - "semantic-kernel"
  - "ai-agents"
  - "security"
  - "csharp"
lang: "pt-br"
translationOf: "2026/08/semantic-kernel-1-80-openapi-plugins-stop-following-redirects"
translatedBy: "claude"
translationDate: 2026-08-19
---

O Semantic Kernel .NET 1.80.0 saiu em 2026-08-18, e a linha do changelog que importa é a mais seca de todas: [".NET: [Breaking] Update OpenAPI HTTP client defaults"](https://github.com/microsoft/semantic-kernel/pull/14293). Ela fecha uma brecha que o Semantic Kernel vinha documentando como limitação conhecida nos próprios comentários XML desde maio.

## A validação era real, o redirecionamento era a saída de emergência

Desde que o [PR #14029](https://github.com/microsoft/semantic-kernel/pull/14029) entrou em maio de 2026, `RestApiOperationServerUrlValidationOptions` é aplicado por padrão a todo plugin OpenAPI. Deixe `ServerUrlValidationOptions` como null e você ainda recebe uma instância construída por padrão que exige https para tudo que esteja fora da lista de permitidos e rejeita hosts que resolvem para loopback, link-local (incluindo o endereço de metadados de nuvem `169.254.169.254`), RFC1918, `fc00::/7`, NAT de nível de operadora, multicast e faixas reservadas.

O problema era a ordem. A validação roda sobre a URL antes de a requisição sair. O `HttpClient` padrão seguia redirecionamentos, então um host público que você tivesse liberado podia responder com um `302` apontando para `http://169.254.169.254/latest/meta-data/` e o handler ia atrás, já tendo passado pelo filtro. O Semantic Kernel dizia isso nos comentários do próprio tipo e mandava você configurar `AllowAutoRedirect = false` por conta própria.

## O que a 1.80.0 mudou de fato

A factory do plugin não resolve mais o cliente padrão por `HttpClientProvider.GetHttpClient()`. Agora ela chama um novo `GetNonRedirectingHttpClient()`, apoiado em um singleton de handler não descartável separado, com redirecionamentos desligados:

```csharp
public static HttpClient GetNonRedirectingHttpClient()
    => new(NonDisposableHttpClientHandler.NonRedirectingInstance, disposeHandler: false);
```

Todos os pontos de entrada passam por ele: `ImportPluginFromOpenApiAsync`, `CreatePluginFromOpenApiAsync`, `OpenApiKernelPluginFactory.CreateFromOpenApiAsync`, além das extensões de API Manifest e Copilot Agent Plugin. Um redirecionamento agora aparece como uma `HttpOperationException` carregando o status `3xx`, em vez de ser seguido em silêncio.

## O seu HttpClient continua sendo problema seu

Esta é a parte a conferir antes de atualizar `Microsoft.SemanticKernel.Plugins.OpenApi` para 1.80.0. O novo padrão só vale quando o Semantic Kernel constrói o cliente. Se você passar um, ele é usado do jeito que veio:

```csharp
var handler = new HttpClientHandler { AllowAutoRedirect = false };
using var http = new HttpClient(handler);

await kernel.ImportPluginFromOpenApiAsync(
    pluginName: "partner",
    uri: new Uri("https://partner.example.com/openapi.json"),
    executionParameters: new OpenApiFunctionExecutionParameters
    {
        HttpClient = http,
    });
```

O caso sutil é a injeção de dependências. As extensões do kernel caem em `kernel.Services.GetService<HttpClient>()` antes de chegar ao padrão, então um registro simples de `AddHttpClient()` vence e traz `AllowAutoRedirect = true` de volta junto. Se você monta os plugins dentro de um host, como em [rodar um plugin do Semantic Kernel a partir de um BackgroundService](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/), configure o handler primário explicitamente.

A parte incompatível é real: uma API interna que responde `301` quando a barra final não bate antes funcionava e agora lança exceção. Corrija o `servers[].url` do documento em vez de entregar ao plugin um cliente que segue redirecionamentos.
