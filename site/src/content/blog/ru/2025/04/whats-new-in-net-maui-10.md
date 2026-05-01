---
title: "Что нового в .NET MAUI 10"
description: "Краткий обзор новых возможностей, улучшений и обратно несовместимых изменений в .NET MAUI 10, выпущенном вместе с .NET 10 и C# 14 в ноябре 2025 года."
pubDate: 2025-04-11
updatedDate: 2026-01-08
tags:
  - "maui"
  - "dotnet"
  - "dotnet-10"
lang: "ru"
translationOf: "2025/04/whats-new-in-net-maui-10"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET MAUI 10 был выпущен в ноябре 2025 года вместе с .NET 10 и C# 14.  
  
.NET 10 -- это версия с долгосрочной поддержкой (LTS), которая будет получать бесплатную поддержку и патчи в течение 3 лет с момента выпуска, до ноября 2028 года. Подробнее см. [что нового в .NET 10](/2024/12/dotnet-10/) и [что нового в C# 14](/2024/12/csharp-14/).

В .NET MAUI 10 появилось несколько новых возможностей и улучшений:

-   Улучшения элементов управления
    -   Улучшения производительности и стабильности `CollectionView` и `CarouselView`
    -   Перегрузка `HybridWebView.InvokeJavaScriptAsync`
    -   Свойство `SearchIconColor` у `SearchBar`
    -   Свойство `OffColor` у `Switch`
-   Новый `ShadowTypeConverter`
-   Свойство `Rate` у `SpeechOptions`
-   XAML-расширение разметки `FontImageExtension`
-   iOS и Mac Catalyst
    -   новые `AccessibilityExtensions`
    -   переопределения `MauiWebViewNavigationDelegate`
    -   отображение модальной страницы как поповера
-   Android
    -   поддержка Android 16 Baklava -- API 36 -- и JDK 21
    -   поддержка `dotnet run`
    -   `AndroidEnableMarshalMethods` включён по умолчанию
    -   метаданные `ArtifactFilename` для элемента `@(AndroidMavenLibrary)`
    -   сборки времени проектирования Visual Studio больше не вызывают `aapt2`
    -   вывод `generator` избегает потенциального использования System.Reflection.Emit
    -   `ApplicationAttribute.ManageSpaceActivity` больше не выбрасывает `InvalidCastException`

Обратно несовместимые изменения в .NET MAUI для .NET 10:

-   `TableView` объявлен устаревшим. Вместо него следует использовать `CollectionView`.
-   `MessagingCenter` стал внутренним в .NET 10. Используйте вместо него `WeakReferenceMessenger` из [CommunityToolkit.Mvvm](https://www.nuget.org/packages/CommunityToolkit.Mvvm).
