---
title: "Neuerungen in .NET MAUI 10"
description: "Eine Zusammenfassung der neuen Funktionen, Verbesserungen und Breaking Changes in .NET MAUI 10, veröffentlicht zusammen mit .NET 10 und C# 14 im November 2025."
pubDate: 2025-04-11
updatedDate: 2026-01-08
tags:
  - "maui"
  - "dotnet"
  - "dotnet-10"
lang: "de"
translationOf: "2025/04/whats-new-in-net-maui-10"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET MAUI 10 wurde im November 2025 zusammen mit .NET 10 und C# 14 veröffentlicht.  
  
.NET 10 ist eine Long-Term-Support-Version (LTS) und erhält ab Veröffentlichungsdatum 3 Jahre lang kostenlosen Support und Patches, bis November 2028. Weitere Informationen finden Sie unter [Neuerungen in .NET 10](/2024/12/dotnet-10/) und [Neuerungen in C# 14](/2024/12/csharp-14/).

In .NET MAUI 10 gibt es mehrere neue Funktionen und Verbesserungen:

-   Verbesserungen an Steuerelementen
    -   Verbesserungen bei Leistung und Stabilität von `CollectionView` und `CarouselView`
    -   Überladung `HybridWebView.InvokeJavaScriptAsync`
    -   Eigenschaft `SearchIconColor` an `SearchBar`
    -   Eigenschaft `OffColor` an `Switch`
-   Neuer `ShadowTypeConverter`
-   Eigenschaft `Rate` an `SpeechOptions`
-   XAML-Markup-Erweiterung `FontImageExtension`
-   iOS und Mac Catalyst
    -   neue `AccessibilityExtensions`
    -   Überschreibungen von `MauiWebViewNavigationDelegate`
    -   modale Seite als Popover anzeigen
-   Android
    -   Unterstützung für Android 16 Baklava -- API 36 -- und JDK 21
    -   Unterstützung von `dotnet run`
    -   `AndroidEnableMarshalMethods` standardmäßig aktiviert
    -   `ArtifactFilename`-Metadatum für `@(AndroidMavenLibrary)`-Item
    -   Visual-Studio-Designtime-Builds rufen `aapt2` nicht mehr auf
    -   `generator`-Ausgabe vermeidet die potenzielle Nutzung von System.Reflection.Emit
    -   `ApplicationAttribute.ManageSpaceActivity` löst keine `InvalidCastException` mehr aus

Breaking Changes in .NET MAUI für .NET 10:

-   `TableView` ist veraltet. Verwenden Sie stattdessen `CollectionView`.
-   `MessagingCenter` wurde in .NET 10 als intern markiert. Verwenden Sie stattdessen `WeakReferenceMessenger` aus [CommunityToolkit.Mvvm](https://www.nuget.org/packages/CommunityToolkit.Mvvm).
