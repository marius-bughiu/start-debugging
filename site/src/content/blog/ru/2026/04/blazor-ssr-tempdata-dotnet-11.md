---
title: "Blazor SSR наконец получает TempData в .NET 11"
description: "ASP.NET Core в .NET 11 Preview 2 приносит TempData в статический серверный рендеринг Blazor, позволяя flash-сообщения и потоки Post-Redirect-Get без обходных путей."
pubDate: 2026-04-13
tags:
  - "blazor"
  - "aspnet-core"
  - "dotnet-11"
  - "ssr"
lang: "ru"
translationOf: "2026/04/blazor-ssr-tempdata-dotnet-11"
translatedBy: "claude"
translationDate: 2026-04-25
---

Если вы строили статические приложения Blazor SSR, то почти наверняка натыкались на одну и ту же стену: после POST-запроса формы с редиректом нет встроенного способа передать одноразовое сообщение на следующую страницу. У MVC и Razor Pages был `TempData` более десятилетия. У Blazor SSR его не было, до [.NET 11 Preview 2](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-2/).

## Как TempData работает в Blazor SSR

Когда вы вызываете `AddRazorComponents()` в `Program.cs`, TempData регистрируется автоматически. Без дополнительной настройки сервисов. Внутри любого статического SSR-компонента получите его как каскадный параметр:

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

На целевой странице прочитайте значение. Как только вы вызываете `Get`, запись удаляется из хранилища:

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

Это классический шаблон Post-Redirect-Get, и теперь он работает в Blazor SSR без пользовательского управления состоянием.

## Peek и Keep

`ITempData` предоставляет четыре метода, отражающих жизненный цикл TempData в MVC:

- `Get<T>(key)` читает значение и помечает его для удаления.
- `Peek<T>(key)` читает без пометки, поэтому значение переживает до следующего запроса.
- `Keep()` сохраняет все значения.
- `Keep(key)` сохраняет конкретное значение.

Они дают вам контроль над тем, исчезнет ли flash-сообщение после одного чтения или останется для второго редиректа.

## Поставщики хранилища

По умолчанию TempData основан на cookie через `CookieTempDataProvider`. Значения шифруются с помощью ASP.NET Core Data Protection, так что вы получаете защиту от подделки из коробки. Если вы предпочитаете серверное хранилище, замените на `SessionStorageTempDataProvider`:

```csharp
builder.Services.AddSession();
builder.Services
    .AddSingleton<ITempDataProvider, SessionStorageTempDataProvider>();
```

## Подвох: только статический SSR

TempData не работает с интерактивными режимами рендеринга Blazor Server или Blazor WebAssembly. Он ограничен статическим SSR, где каждая навигация -- полноценный HTTP-запрос. Для интерактивных сценариев `PersistentComponentState` или ваше собственное каскадное состояние остаются правильными инструментами.

Это небольшое дополнение, но оно устраняет одну из распространённых жалоб "почему Blazor не может то, что может Razor Pages?". Возьмите [.NET 11 Preview 2](https://dotnet.microsoft.com/download/dotnet/11.0) и попробуйте в следующем SSR-потоке формы.
