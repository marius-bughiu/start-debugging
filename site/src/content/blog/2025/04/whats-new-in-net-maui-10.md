---
title: "What’s new in .NET MAUI 10"
description: "A summary of new features, improvements, and breaking changes in .NET MAUI 10, released with .NET 10 and C# 14 in November 2025."
pubDate: 2025-04-11
updatedDate: 2026-01-08
tags:
  - "maui"
  - "net"
  - "net-10"
---
.NET MAUI 10 was released in November 2025 along with .NET 10 and C# 14.  
  
.NET 10 is a Long Term Support (LTS) version, which will receive free support and patches for 3 years from the release date, up until November 2028. For more information see [what’s new in .NET 10](/2024/12/dotnet-10/) and [what’s new in C# 14](/2024/12/csharp-14/).

There are several new features and improvements in .NET MAUI 10:

-   Control enhancements
    -   `CollectionView` and `CarouselView` performance and stability improvements
    -   `HybridWebView.InvokeJavaScriptAsync` overload
    -   `SearchIconColor` property on `SearchBar`
    -   `OffColor` property on `Switch`
-   New `ShadowTypeConverter`
-   `Rate` property on `SpeechOptions`
-   `FontImageExtension` XAML markup extension
-   iOS and Mac Catalyst
    -   new `AccessibilityExtensions`
    -   `MauiWebViewNavigationDelegate` overrides
    -   display a modal page as a popover
-   Android
    -   support for Android 16 Baklava – API 36 – and JDK 21
    -   `dotnet run` support
    -   `AndroidEnableMarshalMethods` enabled by default
    -   `ArtifactFilename` metadata for `@(AndroidMavenLibrary)` item
    -   Visual Studio design time builds no longer invoke `aapt2`
    -   `generator` output avoids potential System.Reflection.Emit usage
    -   `ApplicationAttribute.ManageSpaceActivity` no longer throws an `InvalidCastException`

Breaking changes in .NET MAUI for .NET 10:

-   `TableView` has been deprecated. `CollectionView` should be used instead.
-   `MessagingCenter` was made internal in .NET 10. Use `WeakReferenceMessenger` from [CommunityToolkit.Mvvm](https://www.nuget.org/packages/CommunityToolkit.Mvvm) instead.
