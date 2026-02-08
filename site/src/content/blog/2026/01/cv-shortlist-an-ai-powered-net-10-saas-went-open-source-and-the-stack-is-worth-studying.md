---
title: "CV Shortlist: an AI-powered .NET 10 SaaS went open-source, and the stack is worth studying"
description: "A C# post I bookmarked today is not “another demo app”. It is a full, opinionated SaaS that was built as a commercial product, then open-sourced as an educational reference: CV Shortlist. Source: CV Shortlist repo and the original r/csharp post. The useful part is the integration boundary, not the UI Most AI sample apps…"
pubDate: 2026-01-18
tags:
  - "c-sharp"
  - "net"
  - "net-10"
---
A C# post I bookmarked today is not “another demo app”. It is a full, opinionated SaaS that was built as a commercial product, then open-sourced as an educational reference: **CV Shortlist**.

Source: [CV Shortlist repo](https://github.com/mihnea-radulescu/cvshortlist) and the original [r/csharp post](https://www.reddit.com/r/csharp/comments/1qgbjo4/saas_educational_free_and_opensource_example_cv/).

## The useful part is the integration boundary, not the UI

Most AI sample apps stop at “call an LLM”. This one documents the real boundary that makes or breaks production features:

-   **Azure Document Intelligence** extracts structured data from PDF CVs (including tables and multi-column layouts).
-   **OpenAI GPT-5** analyzes the extracted data, matches it to a job opening, and produces the shortlist.

That pairing is what I keep recommending when teams ask “how do we do RAG for documents?” without building a brittle OCR pipeline from scratch: use a specialized extraction service, then do reasoning on clean text and fields.

## A modern .NET 10 stack, explicitly listed

The README is refreshingly concrete about versions and infrastructure:

-   .NET 10, ASP.NET Core 10, Blazor 10, EF Core 10
-   Azure Web App, SQL Database, Blob Storage, Application Insights
-   Azure Document Intelligence and an Azure AI Foundry model (the README calls out a `gpt-5-mini` Foundry model)
-   A self-hosted variant that still depends on the two AI resources

Even if you never care about the recruiting domain, this is a real-world reference for “how many moving parts show up the moment AI is not a toy feature”.

## Config discipline: user secrets locally, env vars in prod

The repo calls out the two practices I want every .NET 10 team to standardize:

-   Local debugging: store secrets in **user secrets**
-   Production deployments: use **environment variables**

Here is the pattern I expect to see in `Program.cs` on projects like this:

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

The point is not these exact property names. The point is: treat the AI boundary like any other external dependency in ASP.NET Core 10, and make configuration and validation boring.

## Why this matters (even if you never build HR software)

If you are trying to ship AI features in .NET 10, you need working examples that include:

-   PDF ingestion that does not fall over on real layouts
-   multi-step processing (extract, normalize, reason, persist)
-   cloud resources with keys, rotation, telemetry, and cost controls

CV Shortlist is a compact “this is what it looks like when you actually build it” reference. Read the README, scan `Program.cs`, and steal the boundary design for your own domain.
