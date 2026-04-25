---
title: "ASP.NET Core 11 liefert natives OpenTelemetry-Tracing: das zusätzliche NuGet-Paket fällt weg"
description: "ASP.NET Core in .NET 11 Preview 2 fügt OpenTelemetry-Semantikattribute direkt zur HTTP-Server-Aktivität hinzu und macht OpenTelemetry.Instrumentation.AspNetCore überflüssig."
pubDate: 2026-04-12
tags:
  - "aspnet-core"
  - "dotnet-11"
  - "opentelemetry"
  - "observability"
lang: "de"
translationOf: "2026/04/aspnetcore-11-native-opentelemetry-tracing"
translatedBy: "claude"
translationDate: 2026-04-25
---

Jedes ASP.NET Core-Projekt, das Traces exportiert, hat dieselbe Zeile in seiner `.csproj`: eine Referenz auf `OpenTelemetry.Instrumentation.AspNetCore`. Dieses Paket abonniert die `Activity`-Quelle des Frameworks und stempelt jeden Span mit den semantischen Attributen, die Exporter erwarten: `http.request.method`, `url.path`, `http.response.status_code`, `server.address` und so weiter.

Mit [.NET 11 Preview 2](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-2/) erledigt das Framework diese Arbeit selbst. ASP.NET Core befüllt nun die standardmäßigen OpenTelemetry-Semantikattribute direkt auf der HTTP-Server-Aktivität, sodass die separate Instrumentierungsbibliothek nicht mehr erforderlich ist, um Basis-Tracing-Daten zu sammeln.

## Was das Framework jetzt bereitstellt

Wenn ein Request in .NET 11 Preview 2 auf Kestrel trifft, schreibt die eingebaute Middleware dieselben Attribute, die das Instrumentierungspaket hinzuzufügen pflegte:

- `http.request.method`
- `url.path` und `url.scheme`
- `http.response.status_code`
- `server.address` und `server.port`
- `network.protocol.version`

Das sind die [HTTP-Server-Semantik-Konventionen](https://opentelemetry.io/docs/specs/semconv/http/http-spans/), auf die sich jedes OTLP-kompatible Backend für Dashboards und Alerting verlässt.

## Vorher und nachher

Ein typisches .NET 10-Setup, um HTTP-Traces zu bekommen, sah so aus:

```csharp
builder.Services.AddOpenTelemetry()
    .WithTracing(tracing =>
    {
        tracing
            .AddAspNetCoreInstrumentation()   // requires the NuGet package
            .AddOtlpExporter();
    });
```

In .NET 11 abonnieren Sie stattdessen die eingebaute Activity-Quelle:

```csharp
builder.Services.AddOpenTelemetry()
    .WithTracing(tracing =>
    {
        tracing
            .AddSource("Microsoft.AspNetCore")  // no extra package needed
            .AddOtlpExporter();
    });
```

Das Paket `OpenTelemetry.Instrumentation.AspNetCore` ist nicht weg; es existiert weiterhin für Teams, die seine Anreicherungs-Callbacks oder fortgeschrittene Filterung brauchen. Aber die Basis-Attribute, die 90 % der Projekte brauchen, sind nun ins Framework eingebacken.

## Warum das wichtig ist

Weniger Pakete bedeutet einen kleineren Abhängigkeitsgraphen, schnellere Restore-Zeiten und eine Sache weniger, die bei Major-Versions-Upgrades synchron gehalten werden muss. Es bedeutet auch, dass NativeAOT-veröffentlichte ASP.NET Core-Apps Standard-Traces erhalten, ohne reflection-lastigen Instrumentierungscode hereinzuziehen.

Falls Sie bereits das Instrumentierungspaket nutzen, bricht nichts. Die Framework-Attribute und die Paket-Attribute verschmelzen sauber auf derselben `Activity`. Sie können die Paketreferenz entfernen, wenn Sie bereit sind, Ihre Dashboards testen und weitergehen.

Die [vollständigen Release Notes zu ASP.NET Core .NET 11 Preview 2](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview2/aspnetcore.md) decken den Rest der Änderungen ab, einschließlich Blazor SSR TempData-Unterstützung und der neuen Web-Worker-Projektvorlage.
