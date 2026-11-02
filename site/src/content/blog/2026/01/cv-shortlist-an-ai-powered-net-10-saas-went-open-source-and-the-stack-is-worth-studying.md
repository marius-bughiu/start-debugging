---
title: "CV Shortlist: historical notes on a .NET 10 AI SaaS"
description: "What the CV Shortlist author announced, what its former README described, and which .NET AI design ideas remain useful now that the public repository is unavailable."
pubDate: 2026-01-18
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-10"
---

**Status checked 2 November 2026:** the former public repository, `github.com/mihnea-radulescu/cvshortlist`, returns 404, including through GitHub's repository API. That does not establish whether it was deleted, made private, or moved. No public replacement was verified. This is a historical note, not a currently runnable source-code walkthrough.

## What the author actually announced

In the [original announcement](https://www.reddit.com/r/csharp/comments/1qgbjo4/saas_educational_free_and_opensource_example_cv/), Mihnea Radulescu described a commercial SaaS started in November 2025, then shut down and offered as an educational MIT-licensed project. The stated technologies were .NET 10, ASP.NET Core, Blazor Server, Azure Cloud, and Azure AI Foundry. Its intended task was shortlisting candidate applications. These are the author's descriptions, not independent evidence of accuracy or production readiness.

A cached copy of the former GitHub README describes Document Intelligence extracting PDF content and a GPT-5-family model comparing it with a job description. It lists EF Core 10, Azure storage/database services, and a self-hosted option that still needed Azure AI resources; the deployment instructions named `gpt-5-mini`. That historical README is not proof of the current code, model availability, deployment requirements, or test results. The unavailable repository was not built or audited in this review.

## Useful design questions that survive the missing repository

Separating document extraction from model processing is a useful design to evaluate. Microsoft's [Document Intelligence layout documentation](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/prebuilt/layout?view=doc-intel-4.0.0) describes extracting text, tables, and structural information. Test that extraction against your own documents before deciding how to send the output to a model. Extraction followed by an LLM call does not, by itself, establish a retrieval-augmented generation (RAG) architecture.

Keep configuration outside source code, and validate the settings your application actually needs. The README's user-secrets/environment-variable advice is historical project guidance, not a complete production security design. Microsoft's [Secret Manager guidance](https://learn.microsoft.com/en-us/aspnet/core/security/app-secrets?view=aspnetcore-10.0) explains that user secrets are for development and are not encrypted. Environment variables also need appropriate access controls. The former illustrative `Program.cs` block has been removed: it was not inspected repository code, and its C# `required` properties did not provide runtime required-value validation through `ValidateDataAnnotations()`.

For an accessible learning path, see [Generative AI for Beginners .NET v2](/2026/03/generative-ai-beginners-dotnet-v2-dotnet10-meai/). Use its linked materials to explore document processing and model integration, rather than relying on an unavailable project as a deployment template.

**Correction, 2 November 2026:** distinguished the author's announcement and historical README from verified current source; removed unsupported implementation recommendations and the unverified configuration sample.
