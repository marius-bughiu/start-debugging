---
title: "Novidades no .NET MAUI 10"
description: "Um resumo dos novos recursos, melhorias e mudanças incompatíveis no .NET MAUI 10, lançado junto com o .NET 10 e o C# 14 em novembro de 2025."
pubDate: 2025-04-11
updatedDate: 2026-01-08
tags:
  - "maui"
  - "dotnet"
  - "dotnet-10"
lang: "pt-br"
translationOf: "2025/04/whats-new-in-net-maui-10"
translatedBy: "claude"
translationDate: 2026-05-01
---
O .NET MAUI 10 foi lançado em novembro de 2025 junto com o .NET 10 e o C# 14.  
  
O .NET 10 é uma versão Long Term Support (LTS), que receberá suporte e correções gratuitas por 3 anos a partir da data de lançamento, até novembro de 2028. Para mais informações, veja [novidades no .NET 10](/2024/12/dotnet-10/) e [novidades no C# 14](/2024/12/csharp-14/).

Há vários novos recursos e melhorias no .NET MAUI 10:

-   Melhorias em controles
    -   Melhorias de desempenho e estabilidade em `CollectionView` e `CarouselView`
    -   Sobrecarga de `HybridWebView.InvokeJavaScriptAsync`
    -   Propriedade `SearchIconColor` em `SearchBar`
    -   Propriedade `OffColor` em `Switch`
-   Novo `ShadowTypeConverter`
-   Propriedade `Rate` em `SpeechOptions`
-   Extensão de marcação XAML `FontImageExtension`
-   iOS e Mac Catalyst
    -   novas `AccessibilityExtensions`
    -   sobrescritas de `MauiWebViewNavigationDelegate`
    -   exibir uma página modal como popover
-   Android
    -   suporte para Android 16 Baklava -- API 36 -- e JDK 21
    -   suporte ao `dotnet run`
    -   `AndroidEnableMarshalMethods` habilitado por padrão
    -   metadado `ArtifactFilename` para o item `@(AndroidMavenLibrary)`
    -   builds em tempo de design do Visual Studio não invocam mais `aapt2`
    -   a saída do `generator` evita o uso potencial de System.Reflection.Emit
    -   `ApplicationAttribute.ManageSpaceActivity` não lança mais `InvalidCastException`

Mudanças incompatíveis no .NET MAUI para o .NET 10:

-   `TableView` foi descontinuado. Use `CollectionView` em vez disso.
-   `MessagingCenter` virou interno no .NET 10. Use `WeakReferenceMessenger` do [CommunityToolkit.Mvvm](https://www.nuget.org/packages/CommunityToolkit.Mvvm).
