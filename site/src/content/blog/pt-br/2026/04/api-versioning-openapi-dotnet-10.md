---
title: "Asp.Versioning 10.0 finalmente se entende com o OpenAPI nativo do .NET 10"
description: "Asp.Versioning 10.0 é o primeiro release que tem como alvo o .NET 10 e o novo pipeline do Microsoft.AspNetCore.OpenApi. O guia de 23 de abril de Sander ten Brinke mostra como registrar um documento OpenAPI por versão da API com WithDocumentPerVersion()."
pubDate: 2026-04-28
tags:
  - "dotnet-10"
  - "aspnetcore"
  - "openapi"
  - "api-versioning"
lang: "pt-br"
translationOf: "2026/04/api-versioning-openapi-dotnet-10"
translatedBy: "claude"
translationDate: 2026-04-28
---

Quando o ASP.NET Core 9 trocou o Swashbuckle pelo gerador nativo [`Microsoft.AspNetCore.OpenApi`](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/overview?view=aspnetcore-10.0), faltou uma peça de cola: não existia uma forma limpa de ligar o novo pipeline ao `Asp.Versioning` e emitir um documento separado por versão. A correção chegou na semana passada. O [post de 23 de abril no .NET Blog](https://devblogs.microsoft.com/dotnet/api-versioning-in-dotnet-10-applications/) de Sander ten Brinke é o passo a passo oficial de "faça assim", e ele anda de mãos dadas com os primeiros pacotes `Asp.Versioning` que têm como alvo o .NET 10.

## Os pacotes que mudaram

Para minimal APIs, agora você referencia três pacotes, todos atuais em abril de 2026:

- `Asp.Versioning.Http` 10.0.0
- `Asp.Versioning.Mvc.ApiExplorer` 10.0.0
- `Asp.Versioning.OpenApi` 10.0.0-rc.1

Para controllers, troque `Asp.Versioning.Http` por `Asp.Versioning.Mvc` 10.0.0. O pacote `OpenApi` é quem faz o trabalho de verdade: ele liga o modelo do API explorer que a biblioteca de versionamento já produz ao pipeline de transformadores de documento que o `Microsoft.AspNetCore.OpenApi` espera. Antes desse release, você precisava escrever à mão um transformador que lesse `IApiVersionDescriptionProvider` e filtrasse operações por documento. Esse código agora vem de fábrica.

## Um documento por versão, em três linhas

O registro de serviços não muda em relação ao versionamento pré-OpenAPI, com uma chamada extra a `.AddOpenApi()`:

```csharp
builder.Services.AddApiVersioning()
    .AddApiExplorer(options =>
    {
        options.GroupNameFormat = "'v'VVV";
    })
    .AddOpenApi();
```

O lado dos endpoint é onde a nova extensão aparece:

```csharp
app.MapOpenApi().WithDocumentPerVersion();
```

`WithDocumentPerVersion()` enumera o que `DescribeApiVersions()` retornar e registra um documento por versão. Você acessa `/openapi/v1.json` e `/openapi/v2.json` e obtém exatamente as operações que pertencem a cada versão, sem IDs de operação compartilhados nem schemas duplicados vazando entre documentos. Tanto o Scalar (`app.MapScalarApiReference()`) quanto o Swagger UI (`app.UseSwaggerUI()`) descobrem os documentos automaticamente pelo mesmo provider de descrições de versão da API, então o seletor no navegador já vem ligado de graça.

## Grupos de rotas versionados

Para minimal APIs, o lado das rotas continua compacto. Você declara uma API versionada uma vez e pendura grupos por versão nela:

```csharp
var usersApi = app.NewVersionedApi("Users");

var usersV1 = usersApi.MapGroup("api/users").HasApiVersion("1.0");
var usersV2 = usersApi.MapGroup("api/users").HasApiVersion("2.0");

usersV1.MapGet("", () => Results.Ok(new { shape = "v1" }));
usersV2.MapGet("", () => Results.Ok(new { shape = "v2" }));
```

O nome `Users` vira o grupo da API; `HasApiVersion` é o que o API explorer lê para decidir a qual documento OpenAPI cada endpoint pertence.

## Por que isso importa agora

Se você começou um app novo em ASP.NET Core 9 ou 10 e descartou o Swashbuckle por princípio, o versionamento era a única coisa que te puxava de volta. Com o `Asp.Versioning.OpenApi` 10.0.0-rc.1 essa saída de emergência se fecha. O sufixo RC é a única razão para esperar: a superfície da API é a que vai sair, e o time mira o GA junto com o trem de serviço do .NET 10. O exemplo completo vive [no repositório do Sander linkado a partir do post](https://devblogs.microsoft.com/dotnet/api-versioning-in-dotnet-10-applications/) e vale clonar antes da próxima vez que você for escrever um transformador na mão.
