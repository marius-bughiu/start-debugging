---
title: "Blazor static SSR erhält [SupplyParameterFromSession] in .NET 11 Preview 5"
description: "Das Lesen des Sitzungszustands im statisch serverseitig gerenderten Blazor bedeutete, auf HttpContext.Session zuzugreifen und von Hand zu serialisieren. .NET 11 Preview 5 fügt [SupplyParameterFromSession] hinzu, um eine Komponenteneigenschaft direkt an einen Sitzungsschlüssel zu binden."
pubDate: 2026-06-16
tags:
  - "blazor"
  - "dotnet-11"
  - "aspnetcore"
  - "ssr"
  - "csharp"
lang: "de"
translationOf: "2026/06/blazor-supplyparameterfromsession-static-ssr-dotnet-11-preview-5"
translatedBy: "claude"
translationDate: 2026-06-16
---

[.NET 11 Preview 5](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/), veröffentlicht am 2026-06-09, vervollständigt die Familie der "supply parameter from X"-Attribute, die das statische serverseitige Rendering (static SSR) von Blazor bereits für Query Strings und Formulardaten hatte. Das neue ist `[SupplyParameterFromSession]`, und es bindet eine Komponenteneigenschaft an einen Schlüssel in der Serversitzung von ASP.NET Core. Wenn Sie jemals den Zustand eines mehrstufigen Assistenten über static-SSR-Seitenladevorgänge hinweg übertragen haben, wissen Sie, warum das wichtig ist.

## Warum die Sitzung die unbequeme war

Static SSR rendert reines HTML ohne SignalR-Circuit und ohne WebAssembly-Payload, daher gibt es keinen Komponentenzustand im Speicher, der eine Navigation überlebt. Blazor gab Ihnen bereits typisierten, deklarativen Zugriff auf die beiden offensichtlichen Eingaben pro Anfrage: `[SupplyParameterFromQuery]` für die URL und `[SupplyParameterFromForm]` für einen POST-Body. Die Sitzung war die Lücke. Um sie zu lesen, leiteten Sie den `HttpContext` per Kaskade in die Komponente und gingen selbst über `HttpContext.Session`, mit manuellen Schlüssel-Strings und manueller Serialisierung auf beiden Seiten:

```csharp
@inject IHttpContextAccessor Http

@code {
    private int CurrentStep;

    protected override void OnInitialized()
    {
        var raw = Http.HttpContext?.Session.GetString("checkout-step");
        CurrentStep = raw is null ? 0 : JsonSerializer.Deserialize<int>(raw);
    }
}
```

Jede Komponente, die die Sitzung berührte, wiederholte diese Zeremonie, und der Schlüssel-String war ein String-basierter Vertrag, der nur darauf wartete, auseinanderzudriften.

## Was das Attribut ersetzt

Preview 5 reduziert das Lesen auf eine Eigenschaftsdeklaration. Das Attribut nimmt einen `Name` für den Sitzungsschlüssel und verwendet `System.Text.Json`, um den Wert zu serialisieren und zu deserialisieren, sodass es für jeden JSON-fähigen Typ funktioniert, nicht nur für Strings:

```csharp
@code {
    [SupplyParameterFromSession(Name = "checkout-step")]
    public int CurrentStep { get; set; }
}
```

Das Framework liest `checkout-step` aus der Sitzung, deserialisiert es in `int` und weist es zu, bevor die Komponente rendert. Eine Zuweisung zurück an die Eigenschaft schreibt den neuen Wert in die Sitzung, sodass ein Assistent seinen Schritt in einer einzigen Zeile weiterschalten kann, statt eines Lesen-, Ändern-, Serialisieren-, Schreiben-Tanzes.

Die Infrastruktur ist die Standard-Sitzungs-Middleware von ASP.NET Core, daher konfigurieren Sie sie weiterhin in `Program.cs`:

```csharp
builder.Services.AddDistributedMemoryCache();
builder.Services.AddSession();

// ...
app.UseSession();
```

## Wo es hineinpasst

Dies ist einer von mehreren Schärfungsdurchläufen für static SSR in Preview 5. Es passt natürlich zur [clientseitigen Validierung für static-SSR-Formulare](/de/2026/06/blazor-static-ssr-client-side-validation-dotnet-11-preview-5/), die in derselben Version kam: Binden Sie den Arbeitszustand des Formulars an einen Sitzungsschlüssel, validieren Sie im Browser und behalten Sie den günstigen Rendermodus über einen gesamten Checkout-Ablauf hinweg bei. Sortierung und Paginierung von QuickGrid laufen jetzt ebenfalls in static SSR, sodass sich das Muster "interaktives Gefühl, null Circuit" weiter ausdehnt.

Um es auszuprobieren, installieren Sie das .NET 11 Preview 5 SDK, zielen Sie auf `net11.0` und prüfen Sie die [ASP.NET Core Preview 5 Release Notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/aspnetcore.md) für die vollständige Liste.
