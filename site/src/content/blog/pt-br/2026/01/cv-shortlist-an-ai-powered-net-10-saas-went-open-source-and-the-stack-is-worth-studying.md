---
title: "CV Shortlist: um SaaS .NET 10 com IA virou open-source, e a stack vale a pena estudar"
description: "CV Shortlist é um SaaS .NET 10 open-source que combina Azure Document Intelligence com um modelo da OpenAI. A stack, a disciplina de configuração e a fronteira de integração com IA valem o estudo."
pubDate: 2026-01-18
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-10"
lang: "pt-br"
translationOf: "2026/01/cv-shortlist-an-ai-powered-net-10-saas-went-open-source-and-the-stack-is-worth-studying"
translatedBy: "claude"
translationDate: 2026-04-29
---
Um post de C# que salvei hoje não é "mais um app de demonstração". É um SaaS completo e opinativo que foi construído como produto comercial e depois aberto como referência educativa: **CV Shortlist**.

Fonte: [CV Shortlist repo](https://github.com/mihnea-radulescu/cvshortlist) e o [post original em r/csharp](https://www.reddit.com/r/csharp/comments/1qgbjo4/saas_educational_free_and_opensource_example_cv/).

## A parte útil é a fronteira de integração, não a UI

A maioria dos apps de exemplo com IA para em "chamar uma LLM". Este documenta a fronteira real que faz ou quebra recursos em produção:

-   **Azure Document Intelligence** extrai dados estruturados de CVs em PDF (incluindo tabelas e layouts em múltiplas colunas).
-   **OpenAI GPT-5** analisa os dados extraídos, faz o match com uma vaga e produz a shortlist.

Esse pareamento é o que continuo recomendando quando os times perguntam "como fazemos RAG para documentos?" sem construir um pipeline de OCR frágil do zero: use um serviço de extração especializado e depois raciocine sobre texto e campos limpos.

## Uma stack moderna de .NET 10, listada explicitamente

O README é refrescantemente concreto sobre versões e infraestrutura:

-   .NET 10, ASP.NET Core 10, Blazor 10, EF Core 10
-   Azure Web App, SQL Database, Blob Storage, Application Insights
-   Azure Document Intelligence e um modelo do Azure AI Foundry (o README cita um modelo Foundry `gpt-5-mini`)
-   Uma variante self-hosted que ainda depende dos dois recursos de IA

Mesmo que você nunca se importe com o domínio de recrutamento, esta é uma referência do mundo real para "quantas peças móveis aparecem assim que IA deixa de ser um recurso de brinquedo".

## Disciplina de configuração: user secrets localmente, variáveis de ambiente em produção

O repo destaca as duas práticas que quero que todo time de .NET 10 padronize:

-   Debug local: armazenar segredos em **user secrets**
-   Implantações em produção: usar **variáveis de ambiente**

Aqui está o padrão que espero ver em `Program.cs` em projetos como este:

```cs
var builder = WebApplication.CreateBuilder(args);

// Local debugging: dotnet user-secrets
if (builder.Environment.IsDevelopment())
{
    builder.Configuration.AddUserSecrets<Program>(optional: true);
}

builder.Services
    .AddOptions<AiSettings>()
    .Bind(builder.Configuration.GetSection("Ai"))
    .ValidateDataAnnotations()
    .ValidateOnStart();

var app = builder.Build();
app.Run();

public sealed class AiSettings
{
    public required string DocumentIntelligenceEndpoint { get; init; }
    public required string DocumentIntelligenceKey { get; init; }
    public required string FoundryModel { get; init; } // example: gpt-5-mini
}
```

O ponto não são esses nomes exatos de propriedades. O ponto é: trate a fronteira de IA como qualquer outra dependência externa no ASP.NET Core 10, e faça com que configuração e validação sejam entediantes.

## Por que isso importa (mesmo que você nunca construa software de RH)

Se você está tentando entregar recursos de IA em .NET 10, precisa de exemplos funcionais que incluam:

-   ingestão de PDF que não quebra com layouts reais
-   processamento em múltiplos passos (extrair, normalizar, raciocinar, persistir)
-   recursos de cloud com chaves, rotação, telemetria e controle de custos

CV Shortlist é uma referência compacta de "é assim que parece quando você constrói de verdade". Leia o README, dê uma olhada no `Program.cs` e roube o design da fronteira para o seu próprio domínio.
