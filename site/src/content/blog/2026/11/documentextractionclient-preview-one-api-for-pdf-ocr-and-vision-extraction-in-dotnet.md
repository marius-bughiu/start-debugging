---
title: "DocumentExtractionClient preview: one .NET API for PDF parsing, OCR, and vision-model extraction"
description: "Microsoft.Extensions.DocumentExtraction 11.0.0-preview.1 adds DocumentExtractionClient, an IChatClient-style abstraction that turns PDFs, scans, and Office files into a tree of sections, tables, and sourced elements, with swappable providers and middleware."
pubDate: 2026-11-25
tags:
  - "dotnet"
  - "dotnet-11"
  - "ai"
  - "microsoft-extensions-ai"
  - "rag"
---

On November 24, 2026 the .NET team [announced a preview of `DocumentExtractionClient`](https://devblogs.microsoft.com/dotnet/document-extraction-dotnet-preview/) in the new `Microsoft.Extensions.DocumentExtraction` package. It does for document parsing what `IChatClient` did for model calls: one abstract type, interchangeable providers, and a middleware pipeline. If you have an ingestion job wired directly to PdfPig or the Azure Document Intelligence SDK, this is the layer that lets you swap that out without touching the code that consumes the result.

## What you get back

The core method is `ExtractAsync(Stream, string identifier, string mediaType)`, and it returns an `ExtractionDocument`. That is a tree: `Sections` contain `Elements`, which are text (`ExtractionDocumentTextElement`, with an optional `HeadingLevel` or `Role` like `pageHeader`), tables (`ExtractionDocumentTableElement`, with row and column spans per cell), images, or nested sections. Every element carries `Sources` pointing back to a page and, when the provider knows it, a polygon on that page, which is what you need for citations.

Sections nest differently per provider, so iterating `document.Sections` only reaches the top level. Use `EnumerateContent()` to walk every non-section element in document order.

## The providers

The abstraction ships in `Microsoft.Extensions.DocumentExtraction` (`11.0.0-preview.1.26560.3`, with `11.0.1-preview.1.26570.2` already on NuGet). Starter providers live in the [.NET AI Community Toolkit](https://github.com/CommunityToolkit/AI/tree/main/DocumentExtraction), all `1.0.0-preview`:

- `CommunityToolkit.DocumentExtraction.PdfPig`: in process, PDFs with a text layer only.
- `CommunityToolkit.DocumentExtraction.VisionLanguageModel`: any `IChatClient` that accepts images, local (Ollama) or hosted.
- `CommunityToolkit.DocumentExtraction.AzureContentUnderstanding` and `.AzureDocumentIntelligence`: OCR, layout, tables, figures.
- `CommunityToolkit.DocumentExtraction.Mistral`: Mistral OCR via Foundry or the Mistral API.

## A minimal run

This file-based app builds a one-page PDF with PdfPig's writer, then extracts it. It ran on the .NET 11 SDK (11.0.100) against `11.0.1-preview.1.26570.2`:

```csharp
#:package Microsoft.Extensions.DocumentExtraction@11.0.1-preview.1.26570.2
#:package CommunityToolkit.DocumentExtraction.PdfPig@1.0.0-preview
#:property PublishAot=false
#:property NoWarn=$(NoWarn);MEDE0001;EXTEXP0019;CTDE0001

using CommunityToolkit.DocumentExtraction.PdfPig;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.DocumentExtraction;
using Microsoft.Extensions.Documents;

using DocumentExtractionClient extractor = new PdfPigDocumentExtractionClient();
await using var input = File.OpenRead("notes.pdf");
ExtractionDocument doc = await extractor.ExtractAsync(input, "notes.pdf", "application/pdf");

foreach (var e in doc.EnumerateContent())
{
    string text = e.Content is TextContent t ? t.Text : "";
    Console.WriteLine($"page {e.Sources.FirstOrDefault()?.Page.PageNumber}: {text}");
}
```

One thing the output makes obvious: with the default constructor, PdfPig returned the title, the body line, and the "Page 1 of 1" footer as a **single** text element. A text layer has positions, not meaning. The announcement's sample passes `pageSegmenter: DocstrumBoundingBoxes.Instance` and a `roleResolver` that flags text of 13pt or larger as a heading. You need that before heading-based chunking does anything useful. Layout-aware providers such as Content Understanding return `pageHeader`, `pageNumber`, and real tables without that tuning, at about 10 seconds per page instead of 0.4.

## Middleware is the real win

Because every provider derives from `DocumentExtractionClient`, you can register one in DI and layer `UseLogging()` or your own `DelegatingDocumentExtractionClient` on top. The post's example tries PdfPig first and, when fewer than 100 characters come back, replays the buffered stream into an OCR provider. Scanned and digital PDFs then go through one code path, and the expensive call only happens when it is needed.

## Caveats

Everything is preview and gated behind the `MEDE0001`, `EXTEXP0019`, and `CTDE0001` diagnostics. There is no built-in reader for `Microsoft.Extensions.DataIngestion` yet: the samples ship an `ExtractionReader` you copy, and the team says composing the two will get simpler. Any hosted provider, including a hosted vision model, sends your document off the machine.

If you already call local models through `IChatClient`, as in the [Llama on Windows post](/2026/11/llama-on-windows-call-local-models-from-dotnet-11-with-ichatclient/), the vision provider plugs into that same client. The full samples are in [luisquintanilla/dotnet-document-extraction-samples](https://github.com/luisquintanilla/dotnet-document-extraction-samples).
