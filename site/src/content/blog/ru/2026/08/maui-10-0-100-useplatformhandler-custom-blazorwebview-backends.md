---
title: ".NET MAUI 10.0.100 добавляет UsePlatformHandler для собственных бэкендов BlazorWebView"
description: "В MAUI 10.0.100 появился MauiBlazorWebViewBuilderExtensions.UsePlatformHandler, поддерживаемая точка расширения для замены BlazorWebViewHandler без повторной реализации всего, что регистрирует AddMauiBlazorWebView(). Две перегрузки и одна ловушка с порядком вызовов."
pubDate: 2026-08-24
tags:
  - "dotnet"
  - "maui"
  - "blazor"
  - "dotnet-10"
lang: "ru"
translationOf: "2026/08/maui-10-0-100-useplatformhandler-custom-blazorwebview-backends"
translatedBy: "claude"
translationDate: 2026-08-24
---

.NET MAUI 10.0.100 [вышел 2026-08-20](https://github.com/dotnet/maui/releases/tag/10.0.100) и содержит 209 коммитов, большая часть которых является обычным содержимым сервисного выпуска: регрессии прокрутки в `CollectionView`, отступы безопасной области во флайауте Shell на Android, iOS-овский `ActivityIndicator`, который отказывался исчезать. Однако в этом списке спрятан по-настоящему новый публичный API, и он разблокирует целую категорию проектов, застрявших с момента выхода Blazor Hybrid: `MauiBlazorWebViewBuilderExtensions.UsePlatformHandler`.

## Почему AddMauiBlazorWebView() был тупиком для собственных платформ

`AddMauiBlazorWebView()` выполняет две задачи. Он регистрирует общую инфраструктуру, которая нужна любому BlazorWebView (JSInterop, навигация, разрешение статических ресурсов), и жёстко задаёт `BlazorWebViewHandler` в качестве обработчика для `IBlazorWebView`.

Проблема была во второй задаче. Если вы делали бэкенд для платформы, для которой MAUI не поставляет обработчиков (мотивирующим примером был GTK-рендерер для Linux), встроенный обработчик вам просто не подходил, а точки расширения для его замены не существовало. В [issue #34103](https://github.com/dotnet/maui/issues/34103) описан обходной путь, к которому в итоге пришли: полностью пропустить `AddMauiBlazorWebView()`, вручную заново зарегистрировать каждый внутренний сервис, а затем догонять эти регистрации всякий раз, когда они меняются в апстриме.

## Новая точка расширения

[PR #34225](https://github.com/dotnet/maui/pull/34225) добавляет два метода расширения для `IMauiBlazorWebViewBuilder`:

```csharp
public static IMauiBlazorWebViewBuilder UsePlatformHandler<THandler>(
    this IMauiBlazorWebViewBuilder builder)
    where THandler : IViewHandler, new();

public static IMauiBlazorWebViewBuilder UsePlatformHandler(
    this IMauiBlazorWebViewBuilder builder,
    Func<IServiceProvider, IViewHandler> factory);
```

В `MauiProgram.cs` весь этот обходной путь сворачивается до одного вызова в цепочке:

```csharp
builder.Services
    .AddMauiBlazorWebView()
    .UsePlatformHandler<GtkBlazorWebViewHandler>();
```

Всё, что регистрирует `AddMauiBlazorWebView()`, остаётся на месте. Меняется только обработчик. Внутри метод перенаправляет вызов в `ConfigureMauiHandlers(h => h.AddHandler<IBlazorWebView, THandler>())`, то есть в ту же коллекцию обработчиков, в которую пишет встроенная регистрация.

Обратите внимание на обобщённое ограничение: `where THandler : IViewHandler, new()`. Параметр типа дополнительно помечен атрибутом `[DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.PublicConstructors)]`, чтобы тримминг сохранял конструктор без параметров в обрезанной сборке или в сборке с NativeAOT, а не удалял его молча. Обработчики, которым нужны аргументы конструктора, проходят через фабричную перегрузку.

## Порядок вызовов является острым краем

Замена работает по правилу "побеждает последняя регистрация", и это режет в обе стороны. Вызывайте `UsePlatformHandler` после `AddMauiBlazorWebView()`, иначе он ничего не сделает. Ещё неприятнее другое: если нижележащая библиотека позже в вашем конвейере запуска снова вызовет `AddMauiBlazorWebView()`, этот второй вызов заново зарегистрирует обработчик по умолчанию, и ваш бэкенд исчезнет без ошибки и без предупреждения. Когда конфигурация MAUI Blazor собирается из нескольких источников, вызывайте `UsePlatformHandler` последним.

У фабричной перегрузки есть вторая ловушка, о которой стоит знать. `IServiceProvider`, который она передаёт, является провайдером фабрики обработчиков MAUI, а не корневым провайдером приложения. Он разрешает только сервисы, зарегистрированные через `ConfigureMauiHandlers`, и ничего больше, поэтому попытка достать оттуда синглтон уровня приложения завершится неудачей.

Обеих перегрузок нет в `Microsoft.AspNetCore.Components.WebView.Maui` 10.0.90 и они присутствуют в 10.0.100, так что это прямое пополнение 10.0.100, а не тихий бэкпорт. Если вы следите за поездом сервисных выпусков .NET MAUI 10, то [выкатка Material 3 на Android завершилась ещё в SR6](/ru/2026/05/maui-10-material-3-android-usematerial3-flag/).
