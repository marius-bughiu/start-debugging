---
title: "ASP.NET Core no .NET 11 Preview 4 ensina o metodo HTTP QUERY ao OpenAPI"
description: "O .NET 11 Preview 4 faz a geracao de OpenAPI no ASP.NET Core reconhecer o HTTP QUERY como uma operacao de primeira classe no OpenAPI 3.2, com um fallback elegante para documentos 3.0 e 3.1."
pubDate: 2026-05-24
tags:
  - "dotnet-11"
  - "aspnetcore"
  - "openapi"
  - "http"
  - "minimal-apis"
lang: "pt-br"
translationOf: "2026/05/aspnetcore-11-http-query-method-openapi"
translatedBy: "claude"
translationDate: 2026-05-24
---

O [.NET 11 Preview 4](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-4/), lancado em 2026-05-12, trouxe uma mudanca pequena, mas com visao de futuro, ao ASP.NET Core: a geracao de documentos OpenAPI agora reconhece `QUERY` como um tipo de operacao HTTP conhecido. Se voce nunca ouviu falar do metodo QUERY, esse e justamente o ponto deste post. E um metodo padrao proposto que resolve uma tensao real que ha anos incomoda os endpoint de busca.

## Por que um novo verbo para buscar

Uma requisicao de busca quer duas coisas que os verbos existentes nao conseguem oferecer juntas. Ela quer ser segura e idempotente, como o `GET`, para que caches e proxies a tratem com bom senso e uma nova tentativa nunca altere nada. E quer carregar um corpo de requisicao estruturado, como o `POST`, porque um filtro serio (clausulas booleanas aninhadas, limites geograficos, um vetor mais predicados sobre metadados) nao cabe de forma limpa em uma query string e esbarra nos limites de comprimento da URL.

As equipes contornaram isso por uma decada enviando `POST /search` com um corpo JSON e fingindo silenciosamente que e idempotente. Isso funciona, mas mente para cada cache e intermediario no caminho. O metodo `QUERY` da IETF e a versao honesta: semantica de `GET` (segura, idempotente, armazenavel em cache) mais um corpo de requisicao. O Preview 4 nao inventa o metodo, ele ensina o pipeline do OpenAPI a descreve-lo corretamente.

## Mapeando um endpoint QUERY

O roteamento ja suportava verbos arbitrarios, entao nao ha nenhum atributo novo para aprender. Voce mapeia um endpoint QUERY com a sobrecarga existente de `MapMethods`:

```csharp
app.MapMethods("/search", ["QUERY"], (SearchRequest request) =>
    SearchService.Run(request));
```

A parte nova e o que sai do gerador de documentos OpenAPI. QUERY so se tornou um conceito de primeira classe no OpenAPI 3.2, entao voce precisa optar por essa versao da especificacao:

```csharp
builder.Services.AddOpenApi(options =>
{
    options.OpenApiVersion = OpenApiSpecVersion.OpenApi3_2;
});
```

Com o 3.2 selecionado, o endpoint acima e emitido como uma operacao `query` apropriada no path item. Se voce ainda esta preso ao OpenAPI 3.0 ou 3.1, que sao anteriores ao metodo, o gerador nao descarta o endpoint silenciosamente. Ele recorre a uma extensao `x-oai-additionalOperations`, para que ferramentas que entendem a extensao ainda consigam ver a operacao, e as que nao entendem ao menos nao engasguem.

## Vale saber antes de colocar em producao

QUERY ainda e um metodo proposto, entao o suporte entre navegadores, clientes HTTP, CDNs e proxies corporativos e irregular. Essa mudanca trata de documentar com precisao um endpoint, nao de prometer que todo intermediario vai rotea-lo. Para APIs de busca internas, de servico para servico, em que voce controla as duas pontas, ela se encaixa bem hoje. Para APIs publicas, trate-a como preparacao para o futuro e mantenha um caminho `POST` ate o ecossistema acompanhar.

O trabalho chegou em [dotnet/aspnetcore #65714](https://github.com/dotnet/aspnetcore/pull/65714). E uma linha discreta em um preview discreto, mas e o tipo de encanamento que decide se o QUERY realmente vai chegar ou ficar como um rascunho para sempre.
