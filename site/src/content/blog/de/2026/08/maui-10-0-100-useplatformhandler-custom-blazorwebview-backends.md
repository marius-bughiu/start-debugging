---
title: ".NET MAUI 10.0.100 ergänzt UsePlatformHandler für eigene BlazorWebView-Backends"
description: "MAUI 10.0.100 liefert MauiBlazorWebViewBuilderExtensions.UsePlatformHandler, einen unterstützten Erweiterungspunkt zum Austausch des BlazorWebViewHandler, ohne alles nachzubauen, was AddMauiBlazorWebView() registriert. Zwei Überladungen und eine Reihenfolgen-Falle."
pubDate: 2026-08-24
tags:
  - "dotnet"
  - "maui"
  - "blazor"
  - "dotnet-10"
lang: "de"
translationOf: "2026/08/maui-10-0-100-useplatformhandler-custom-blazorwebview-backends"
translatedBy: "claude"
translationDate: 2026-08-24
---

.NET MAUI 10.0.100 [erschien am 2026-08-20](https://github.com/dotnet/maui/releases/tag/10.0.100) mit 209 Commits, und das meiste davon ist übliche Service-Release-Kost: Scroll-Regressionen in `CollectionView`, Safe-Area-Insets im Android-Shell-Flyout, ein `ActivityIndicator` unter iOS, der sich weigerte zu verschwinden. In der Liste versteckt sich jedoch eine wirklich neue öffentliche API, und sie befreit eine Projektkategorie, die seit dem Erscheinen von Blazor Hybrid feststeckte: `MauiBlazorWebViewBuilderExtensions.UsePlatformHandler`.

## Warum AddMauiBlazorWebView() für eigene Plattformen eine Sackgasse war

`AddMauiBlazorWebView()` erledigt zwei Aufgaben. Es registriert die gemeinsame Infrastruktur, die jede BlazorWebView braucht (JSInterop, Navigation, Auflösung statischer Assets), und es verdrahtet `BlazorWebViewHandler` fest als Handler für `IBlazorWebView`.

Die zweite Aufgabe war das Problem. Wer ein Backend für eine Plattform baute, für die MAUI keine Handler ausliefert, motivierendes Beispiel war ein GTK-Renderer für Linux, für den war der eingebaute Handler schlicht falsch, und es gab keinen Erweiterungspunkt, um ihn zu ersetzen. [Issue #34103](https://github.com/dotnet/maui/issues/34103) beschreibt den Umweg, auf den man sich einigte: `AddMauiBlazorWebView()` komplett überspringen, jeden internen Service von Hand neu registrieren und diesen Registrierungen dann bei jeder Änderung upstream hinterherlaufen.

## Der neue Erweiterungspunkt

[PR #34225](https://github.com/dotnet/maui/pull/34225) ergänzt zwei Erweiterungsmethoden auf `IMauiBlazorWebViewBuilder`:

```csharp
public static IMauiBlazorWebViewBuilder UsePlatformHandler<THandler>(
    this IMauiBlazorWebViewBuilder builder)
    where THandler : IViewHandler, new();

public static IMauiBlazorWebViewBuilder UsePlatformHandler(
    this IMauiBlazorWebViewBuilder builder,
    Func<IServiceProvider, IViewHandler> factory);
```

In `MauiProgram.cs` schrumpft der gesamte Umweg damit auf einen verketteten Aufruf:

```csharp
builder.Services
    .AddMauiBlazorWebView()
    .UsePlatformHandler<GtkBlazorWebViewHandler>();
```

Alles, was `AddMauiBlazorWebView()` registriert, bleibt erhalten. Nur der Handler wechselt. Intern leitet die Methode an `ConfigureMauiHandlers(h => h.AddHandler<IBlazorWebView, THandler>())` weiter, also an dieselbe Handler-Sammlung, in die auch die eingebaute Registrierung schreibt.

Beachten Sie die generische Einschränkung: `where THandler : IViewHandler, new()`. Der Typparameter trägt zusätzlich die Annotation `[DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.PublicConstructors)]`, damit der Trimmer den parameterlosen Konstruktor in einem getrimmten oder NativeAOT-Build erhält, statt ihn stillschweigend zu entfernen. Handler mit Konstruktorargumenten laufen über die Factory-Überladung.

## Die Reihenfolge ist die scharfe Kante

Der Austausch folgt der Regel, dass die letzte Registrierung gewinnt, und das schneidet in beide Richtungen. Rufen Sie `UsePlatformHandler` nach `AddMauiBlazorWebView()` auf, sonst passiert nichts. Schmerzhafter noch: Ruft eine nachgelagerte Bibliothek später in Ihrer Startup-Pipeline erneut `AddMauiBlazorWebView()` auf, registriert dieser zweite Aufruf den Standard-Handler wieder, und Ihr Backend verschwindet ohne Fehler und ohne Warnung. Wenn Sie die MAUI-Blazor-Konfiguration aus mehreren Quellen zusammensetzen, rufen Sie `UsePlatformHandler` zuletzt auf.

Die Factory-Überladung hat eine zweite Falle. Der `IServiceProvider`, den sie übergibt, ist der Provider der MAUI-Handler-Factory, nicht der Root-Provider der Anwendung. Er löst nur Services auf, die über `ConfigureMauiHandlers` registriert wurden, sonst nichts. Ein Singleton auf App-Ebene lässt sich darüber also nicht beziehen.

Beide Überladungen fehlen in `Microsoft.AspNetCore.Components.WebView.Maui` 10.0.90 und sind in 10.0.100 vorhanden. Es handelt sich also um einen echten Neuzugang in 10.0.100 und nicht um einen stillen Backport. Wer den Service-Release-Zug von .NET MAUI 10 verfolgt: Der [Material-3-Rollout unter Android wurde bereits in SR6 abgeschlossen](/de/2026/05/maui-10-material-3-android-usematerial3-flag/).
