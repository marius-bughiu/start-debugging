---
title: "Ignite UI for Blazor переходит на MIT: более 50 бесплатных компонентов в IgniteUI.Blazor.Lite 1.0.0"
description: "Infragistics открыла под лицензией MIT более 50 элементов управления Ignite UI for Blazor и выпустила IgniteUI.Blazor.Lite и IgniteUI.Blazor.GridLite 1.0.0 для net8.0, net9.0 и net10.0. Что именно бесплатно, как это подключить и на какие подводные камни стоит обратить внимание."
pubDate: 2026-10-28
tags:
  - "blazor"
  - "aspnet-core"
  - "dotnet"
  - "nuget"
lang: "ru"
translationOf: "2026/10/ignite-ui-for-blazor-goes-mit-50-free-components-in-igniteui-blazor-lite"
translatedBy: "claude"
translationDate: 2026-10-28
---

27 октября 2026 года команда ASP.NET [объявила](https://devblogs.microsoft.com/dotnet/blazor-welcomes-infragistics/), что Infragistics теперь участвует в развитии Blazor, и главная новость для большинства из нас - лицензия: более 50 элементов управления Ignite UI for Blazor теперь распространяются под MIT, бесплатны для коммерческого использования, а исходный код доступен на [GitHub](https://github.com/IgniteUI/igniteui-blazor). Это не пробный уровень. Это постоянное подмножество коммерческого набора.

## Что именно бесплатно

Два пакета, оба версии 1.0.0 на NuGet и оба с таргетами `net8.0`, `net9.0` и `net10.0`:

- `IgniteUI.Blazor.Lite`: элементы ввода, навигации и компоновки. Combo, Date Picker, Date Range Picker, Tree, Stepper, Tile Manager, Splitter, Dialog, Tabs, Calendar, Mask Input, Slider, Rating, Chat (предварительная версия) и примерно 40 других.
- `IgniteUI.Blazor.GridLite`: облегчённая таблица данных с фильтрацией по столбцам и пользовательскими шаблонами ячеек.

Полные Grid, Tree Grid, Pivot Grid, Hierarchical Grid и Dock Manager остаются коммерческими в пакете `IgniteUI.Blazor`. Если вам нужны группировка, редактирование или экспорт в Excel, Grid Lite - это не та таблица.

## Подключение в Blazor Web App

```bash
dotnet add package IgniteUI.Blazor.Lite --version 1.0.0
```

Зарегистрируйте сервисы в `Program.cs` и импортируйте пространство имён в `_Imports.razor`:

```csharp
builder.Services.AddIgniteUIBlazor();
```

```razor
@using IgniteUI.Blazor.Controls
```

Затем добавьте тему в `Components/App.razor` (или в `wwwroot/index.html` для автономного WebAssembly):

```html
<link href="_content/IgniteUI.Blazor/themes/light/bootstrap.css" rel="stylesheet" />
```

Обратите внимание на путь: это `_content/IgniteUI.Blazor/`, а не `_content/IgniteUI.Blazor.Lite/`. Я проверил пакет 1.0.0: у его статических веб-ресурсов `BasePath` равен `_content/IgniteUI.Blazor`, так что Lite и коммерческий пакеты используют одни и те же URL ресурсов. Если угадать "очевидный" путь, вы получите компоненты без стилей и ошибку 404 на вкладке сети. Темы поставляются в вариантах `bootstrap`, `fluent`, `indigo` и `material`, каждая в `light` и `dark`.

Тег `<script>` не нужен. Инициализатор JavaScript загружает веб-компоненты при запуске Blazor.

## Combo с настоящей привязкой данных

`IgbCombo` является обобщённым по `TValue` и `TItem`, а `Value` всегда имеет тип `TValue[]`, даже при `SingleSelect`. Именно на этом спотыкаются в первый раз:

```razor
@rendermode InteractiveServer

<IgbCombo TItem="City" TValue="int"
          Data="cities"
          ValueKey="Id"
          DisplayKey="Name"
          Label="Destination"
          SingleSelect="true"
          @bind-Value="selected" />

<p>Selected id: @(selected.FirstOrDefault())</p>

@code {
    record City(int Id, string Name);

    City[] cities = [new(1, "Bucharest"), new(2, "Cluj"), new(3, "Iasi")];
    int[] selected = [];
}
```

Строка `@rendermode` важна. Компоненты построены на взаимодействии с JavaScript, поэтому им нужен `InteractiveServer`, `InteractiveWebAssembly` или `InteractiveAuto`. Статический SSR не поддерживается, и страница без режима рендеринга выдаёт неработающую разметку.

## Часть, которая появится в .NET 11

Инженеры Infragistics также внесли два анализатора Blazor, влитых для .NET 11 в [dotnet/aspnetcore#67176](https://github.com/dotnet/aspnetcore/pull/67176) и [#67383](https://github.com/dotnet/aspnetcore/pull/67383). Первый отмечает вызовы `StateHasChanged()`, которые `ComponentBase` уже делает избыточными, например вызов прямо перед первым `await` в `OnInitializedAsync`, и поставляется с исправлением кода, удаляющим их. Второй предупреждает, когда класс вызывает `GetAuthenticationStateAsync()` без подписки на `AuthenticationStateChanged`, из-за чего и получается устаревший кешированный пользователь.

Есть также навык `use-igniteui-blazor` в [dotnet/skills](https://github.com/dotnet/skills/tree/main/plugins/dotnet-blazor/skills/use-igniteui-blazor) для кодирующих агентов и генератор шаблонов, который всё ещё на рассмотрении в [dotnet/Scaffolding#3823](https://github.com/dotnet/Scaffolding/pull/3823).

Командам, которые обходили поставщиков компонентов из-за лицензирования по числу рабочих мест, бесплатные Combo, Date Range Picker и Tree под MIT, прошедшие планку команды Blazor по обрезке (trimming) и доступности, стоит попробовать на этой неделе.
