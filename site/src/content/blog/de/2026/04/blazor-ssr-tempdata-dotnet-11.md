---
title: "Blazor SSR erhält endlich TempData in .NET 11"
description: "ASP.NET Core in .NET 11 Preview 2 bringt TempData zum statischen serverseitigen Rendering von Blazor und ermöglicht Flash-Nachrichten und Post-Redirect-Get-Flüsse ohne Workarounds."
pubDate: 2026-04-13
tags:
  - "blazor"
  - "aspnet-core"
  - "dotnet-11"
  - "ssr"
lang: "de"
translationOf: "2026/04/blazor-ssr-tempdata-dotnet-11"
translatedBy: "claude"
translationDate: 2026-04-25
---

Falls Sie statische Blazor-SSR-Apps gebaut haben, sind Sie mit ziemlicher Sicherheit gegen dieselbe Wand gelaufen: nach einem Formular-POST, der weiterleitet, gibt es keine eingebaute Möglichkeit, eine einmalige Nachricht an die nächste Seite zu übergeben. MVC und Razor Pages hatten `TempData` über ein Jahrzehnt lang. Blazor SSR nicht, bis [.NET 11 Preview 2](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-2/).

## Wie TempData in Blazor SSR funktioniert

Wenn Sie `AddRazorComponents()` in Ihrer `Program.cs` aufrufen, wird TempData automatisch registriert. Keine zusätzliche Service-Verdrahtung. Greifen Sie es innerhalb einer beliebigen statischen SSR-Komponente als Cascading-Parameter ab:

```csharp
@code {
    [CascadingParameter]
    public ITempData? TempData { get; set; }

    private void HandleSubmit()
    {
        // Store a flash message before redirecting
        TempData?.Set("StatusMessage", "Record saved.");
        Navigation.NavigateTo("/dashboard", forceLoad: true);
    }
}
```

Auf der Zielseite lesen Sie den Wert. Sobald Sie `Get` aufrufen, wird der Eintrag aus dem Speicher entfernt:

```csharp
@code {
    [CascadingParameter]
    public ITempData? TempData { get; set; }

    private string? StatusMessage;

    protected override void OnInitialized()
    {
        StatusMessage = TempData?.Get<string>("StatusMessage");
    }
}
```

Das ist das klassische Post-Redirect-Get-Muster, und es funktioniert nun in Blazor SSR ohne individuelles State Management.

## Peek und Keep

`ITempData` bietet vier Methoden, die den TempData-Lebenszyklus von MVC widerspiegeln:

- `Get<T>(key)` liest den Wert und markiert ihn zur Löschung.
- `Peek<T>(key)` liest ohne zu markieren, so überlebt der Wert bis zum nächsten Request.
- `Keep()` behält alle Werte.
- `Keep(key)` behält einen bestimmten Wert.

Diese geben Ihnen Kontrolle darüber, ob eine Flash-Nachricht nach einem Lesevorgang verschwindet oder für eine zweite Weiterleitung erhalten bleibt.

## Speicheranbieter

Standardmäßig ist TempData cookie-basiert über `CookieTempDataProvider`. Werte werden mit ASP.NET Core Data Protection verschlüsselt, sodass Sie Manipulationsschutz von Haus aus erhalten. Falls Sie serverseitige Speicherung bevorzugen, tauschen Sie auf `SessionStorageTempDataProvider`:

```csharp
builder.Services.AddSession();
builder.Services
    .AddSingleton<ITempDataProvider, SessionStorageTempDataProvider>();
```

## Der Haken: nur statisches SSR

TempData funktioniert nicht mit den Render-Modi Interactive Blazor Server oder Blazor WebAssembly. Es ist auf statisches SSR beschränkt, wo jede Navigation ein vollständiger HTTP-Request ist. Für interaktive Szenarien bleiben `PersistentComponentState` oder Ihr eigener Cascading-Zustand die richtigen Werkzeuge.

Das ist eine kleine Ergänzung, aber sie beseitigt eine der häufigen "Warum kann Blazor nicht das, was Razor Pages kann?"-Beschwerden. Holen Sie sich [.NET 11 Preview 2](https://dotnet.microsoft.com/download/dotnet/11.0) und probieren Sie es in Ihrem nächsten SSR-Formularfluss aus.
