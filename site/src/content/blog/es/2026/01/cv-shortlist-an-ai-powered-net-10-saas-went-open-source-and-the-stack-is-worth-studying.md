---
title: "CV Shortlist: un SaaS .NET 10 con IA se volvió open-source, y el stack vale la pena estudiarlo"
description: "CV Shortlist es un SaaS .NET 10 open-source que combina Azure Document Intelligence con un modelo de OpenAI. El stack, la disciplina de configuración y la frontera de integración con IA valen la pena estudiarlos."
pubDate: 2026-01-18
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-10"
lang: "es"
translationOf: "2026/01/cv-shortlist-an-ai-powered-net-10-saas-went-open-source-and-the-stack-is-worth-studying"
translatedBy: "claude"
translationDate: 2026-04-29
---
Un post de C# que guardé hoy no es "otra app demo". Es un SaaS completo y opinado que se construyó como producto comercial y luego se publicó como referencia educativa: **CV Shortlist**.

Fuente: [CV Shortlist repo](https://github.com/mihnea-radulescu/cvshortlist) y el [post original en r/csharp](https://www.reddit.com/r/csharp/comments/1qgbjo4/saas_educational_free_and_opensource_example_cv/).

## La parte útil es la frontera de integración, no la UI

La mayoría de las apps de muestra con IA se quedan en "llamar a un LLM". Esta documenta la frontera real que hace o rompe las funcionalidades de producción:

-   **Azure Document Intelligence** extrae datos estructurados de CVs en PDF (incluyendo tablas y layouts de varias columnas).
-   **OpenAI GPT-5** analiza los datos extraídos, los empareja con una vacante y produce la shortlist.

Esa combinación es la que sigo recomendando cuando los equipos preguntan "¿cómo hacemos RAG sobre documentos?" sin construir un pipeline OCR frágil desde cero: usa un servicio de extracción especializado y luego razona sobre texto y campos limpios.

## Un stack moderno de .NET 10, listado explícitamente

El README es refrescantemente concreto sobre versiones e infraestructura:

-   .NET 10, ASP.NET Core 10, Blazor 10, EF Core 10
-   Azure Web App, SQL Database, Blob Storage, Application Insights
-   Azure Document Intelligence y un modelo de Azure AI Foundry (el README menciona un modelo Foundry `gpt-5-mini`)
-   Una variante self-hosted que sigue dependiendo de los dos recursos de IA

Aunque nunca te interese el dominio de reclutamiento, esta es una referencia real de "cuántas piezas móviles aparecen en cuanto la IA deja de ser una funcionalidad de juguete".

## Disciplina de configuración: user secrets en local, variables de entorno en producción

El repo destaca las dos prácticas que quiero que todo equipo de .NET 10 estandarice:

-   Debug local: guardar secretos en **user secrets**
-   Despliegues a producción: usar **variables de entorno**

Este es el patrón que espero ver en `Program.cs` en proyectos como este:

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

El punto no son estos nombres de propiedades exactos. El punto es: trata la frontera de IA como cualquier otra dependencia externa en ASP.NET Core 10, y haz que la configuración y la validación sean aburridas.

## Por qué esto importa (incluso si nunca construyes software de HR)

Si intentas publicar funcionalidades de IA en .NET 10, necesitas ejemplos funcionales que incluyan:

-   ingesta de PDF que no se caiga con layouts reales
-   procesamiento multi-paso (extraer, normalizar, razonar, persistir)
-   recursos cloud con claves, rotación, telemetría y control de costos

CV Shortlist es una referencia compacta de "así es como se ve cuando lo construyes de verdad". Lee el README, hojea `Program.cs` y roba el diseño de la frontera para tu propio dominio.
