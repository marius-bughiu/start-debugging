---
title: "Scalar no ASP.NET Core: por que seu token Bearer é ignorado (.NET 10)"
description: "Se seu token Bearer funciona no Postman mas não no Scalar, o problema provavelmente é seu documento OpenAPI. Veja como declarar um esquema de segurança apropriado no .NET 10."
pubDate: 2026-01-23
tags:
  - "aspnet"
  - "dotnet"
  - "dotnet-10"
lang: "pt-br"
translationOf: "2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10"
translatedBy: "claude"
translationDate: 2026-04-29
---
O Scalar vem aparecendo cada vez mais como uma UI alternativa e limpa para documentações OpenAPI no ASP.NET Core. Uma pergunta recente no r/dotnet ilumina uma armadilha comum: você cola um token na UI de auth do Scalar, o Postman funciona, mas as chamadas do Scalar continuam batendo na sua API sem `Authorization: Bearer ...`: [https://www.reddit.com/r/dotnet/comments/1qkjvb0/need_help_with_authentication_using_scalar_aspnet/](https://www.reddit.com/r/dotnet/comments/1qkjvb0/need_help_with_authentication_using_scalar_aspnet/).

O problema raramente é "a auth JWT está quebrada". Geralmente é que seu documento OpenAPI não declara um esquema de segurança HTTP Bearer adequado, então a UI não tem nada confiável para aplicar nas suas operações.

## O Scalar segue seu contrato OpenAPI, não seu middleware

No .NET 10 você pode ter autenticação totalmente configurada no pipeline e ainda assim entregar um documento OpenAPI que não diz nada sobre auth. Quando isso acontece, as ferramentas se comportam de forma inconsistente:

-   O Postman funciona porque você adiciona os headers manualmente.
-   O Scalar (ou qualquer UI) não consegue inferir requisitos de segurança a menos que o documento OpenAPI os declare.

A própria documentação de integração do Scalar com ASP.NET Core é o melhor ponto de partida: [https://scalar.com/products/api-references/integrations/aspnetcore/integration](https://scalar.com/products/api-references/integrations/aspnetcore/integration).

## Declarar segurança Bearer no documento OpenAPI

Se você usa o suporte nativo a OpenAPI, a correção é adicionar um transformer que injete o esquema `http` `bearer` e o aplique nas operações (globalmente ou seletivamente).

Esta é a forma que você precisa (cortada para o essencial):

```cs
using Microsoft.OpenApi.Models;

// Program.cs (.NET 10)
builder.Services.AddOpenApi("v1", options =>
{
    options.AddDocumentTransformer((document, context, ct) =>
    {
        document.Components ??= new OpenApiComponents();
        document.Components.SecuritySchemes ??= new Dictionary<string, OpenApiSecurityScheme>();

        document.Components.SecuritySchemes["Bearer"] = new OpenApiSecurityScheme
        {
            Type = SecuritySchemeType.Http,
            Scheme = "bearer",
            BearerFormat = "JWT"
        };

        // Apply globally (or attach per operation if you prefer)
        document.SecurityRequirements ??= new List<OpenApiSecurityRequirement>();
        document.SecurityRequirements.Add(new OpenApiSecurityRequirement
        {
            [new OpenApiSecurityScheme { Reference = new OpenApiReference
                { Type = ReferenceType.SecurityScheme, Id = "Bearer" } }] = Array.Empty<string>()
        });

        return ValueTask.CompletedTask;
    });
});
```

Quando o documento expressa o esquema de segurança, o Scalar consegue aplicar o token que você inseriu nas requisições de forma previsível.

## Garanta que o Scalar está mapeado para o mesmo endpoint OpenAPI

A segunda armadilha é o encanamento: o Scalar precisa apontar para o documento OpenAPI que você acabou de corrigir (por exemplo `"/openapi/v1.json"`). Mantenha o mapeamento junto da configuração do OpenAPI para não acabar servindo o Scalar contra um documento antigo sem querer.

No Scalar também existe uma opção para configurar auth HTTP Bearer na camada de mapeamento da UI. Se você usa, trate como conveniência, não como fonte da verdade. O contrato OpenAPI ainda deve declarar o esquema Bearer.

## Uma rápida checagem de realidade

Se você quer confirmar a causa raiz em minutos:

-   Abra seu JSON OpenAPI gerado e procure por `"securitySchemes"` e `"bearer"`.
-   Se não estiver lá, o Scalar não está "ignorando seu token". Ele está apenas seguindo o contrato que você deu.

Thread original que disparou isso (com screenshots): [https://www.reddit.com/r/dotnet/comments/1qkjvb0/need_help_with_authentication_using_scalar_aspnet/](https://www.reddit.com/r/dotnet/comments/1qkjvb0/need_help_with_authentication_using_scalar_aspnet/).
