---
title: "Blazor static SSR получает [SupplyParameterFromSession] в .NET 11 Preview 5"
description: "Чтение состояния сессии в статически серверно отрендеренном Blazor означало обращение к HttpContext.Session и сериализацию вручную. .NET 11 Preview 5 добавляет [SupplyParameterFromSession] для привязки свойства компонента напрямую к ключу сессии."
pubDate: 2026-06-16
tags:
  - "blazor"
  - "dotnet-11"
  - "aspnetcore"
  - "ssr"
  - "csharp"
lang: "ru"
translationOf: "2026/06/blazor-supplyparameterfromsession-static-ssr-dotnet-11-preview-5"
translatedBy: "claude"
translationDate: 2026-06-16
---

[.NET 11 Preview 5](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/), выпущенный 2026-06-09, дополняет семейство атрибутов "supply parameter from X", которые статический серверный рендеринг (static SSR) в Blazor уже имел для строк запроса и данных формы. Новый из них -- `[SupplyParameterFromSession]`, и он привязывает свойство компонента к ключу в серверной сессии ASP.NET Core. Если вы когда-нибудь переносили состояние многошагового мастера через загрузки страниц static SSR, вы понимаете, почему это важно.

## Почему сессия была неудобной

Static SSR рендерит обычный HTML без circuit SignalR и без payload WebAssembly, поэтому нет состояния компонента в памяти, которое переживает навигацию. Blazor уже давал типизированный, декларативный доступ к двум очевидным входным данным на запрос: `[SupplyParameterFromQuery]` для URL и `[SupplyParameterFromForm]` для тела POST. Сессия была пробелом. Чтобы прочитать её, вы каскадировали `HttpContext` в компонент и проходили через `HttpContext.Session` сами, со строками ключей вручную и сериализацией вручную с обеих сторон:

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

Каждый компонент, который обращался к сессии, повторял эту церемонию, а строка ключа была контрактом на основе строк, готовым разойтись.

## Что заменяет атрибут

Preview 5 сворачивает чтение до объявления свойства. Атрибут принимает `Name` для ключа сессии и использует `System.Text.Json` для сериализации и десериализации значения, поэтому он работает для любого типа, который можно преобразовать в JSON, а не только для строк:

```csharp
@code {
    [SupplyParameterFromSession(Name = "checkout-step")]
    public int CurrentStep { get; set; }
}
```

Фреймворк читает `checkout-step` из сессии, десериализует его в `int` и присваивает до рендеринга компонента. Присваивание обратно свойству записывает новое значение в сессию, поэтому мастер может перейти к следующему шагу одной строкой вместо танца «получить, изменить, сериализовать, записать».

Инфраструктура -- это стандартный middleware сессии ASP.NET Core, поэтому вы по-прежнему настраиваете его в `Program.cs`:

```csharp
builder.Services.AddDistributedMemoryCache();
builder.Services.AddSession();

// ...
app.UseSession();
```

## Где это уместно

Это один из нескольких проходов по отточке static SSR в Preview 5. Он естественно сочетается с [валидацией на стороне клиента для форм static SSR](/ru/2026/06/blazor-static-ssr-client-side-validation-dotnet-11-preview-5/), которая появилась в том же выпуске: привяжите рабочее состояние формы к ключу сессии, валидируйте в браузере и сохраняйте дешёвый режим рендеринга на протяжении всего процесса оформления заказа. Сортировка и пагинация QuickGrid теперь тоже работают в static SSR, поэтому шаблон «интерактивное ощущение, ноль circuit» продолжает расширяться.

Чтобы попробовать, установите SDK .NET 11 Preview 5, нацельтесь на `net11.0` и просмотрите [заметки о выпуске ASP.NET Core Preview 5](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/aspnetcore.md) для полного списка.
