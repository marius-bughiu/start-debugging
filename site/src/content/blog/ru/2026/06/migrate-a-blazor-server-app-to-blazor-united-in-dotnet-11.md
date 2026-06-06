---
title: "Миграция приложения Blazor Server на Blazor United (Blazor Web App) в .NET 11"
description: "Пошаговый чек-лист для перевода отдельного приложения Blazor Server на унифицированный шаблон Blazor Web App в .NET 11 с сохранением каждой страницы в режиме InteractiveServer без изменения поведения."
pubDate: 2026-06-05
updatedDate: 2026-06-05
template: migration
tags:
  - "migration"
  - "blazor"
  - "dotnet"
  - "aspnetcore"
  - "csharp"
lang: "ru"
translationOf: "2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-06-05
---

Если у вас есть отдельное приложение Blazor Server (`dotnet new blazorserver`) и вы хотите перевести его на унифицированный шаблон, который во время цикла предварительной версии .NET 8 имел прозвище "Blazor United" и был выпущен как **Blazor Web App**, миграция в основном механическая и обычно занимает полдня для небольшого приложения, от одного до трёх дней для крупного. Ничего в коде ваших компонентов менять не нужно. Меняется хост: `_Host.cshtml` исчезает, маршрутизация переезжает в компонент `Routes`, в `Program.cs` `MapBlazorHub` меняется на `MapRazorComponents`, и вы явно объявляете render mode. Держите каждую страницу на `@rendermode InteractiveServer`, и поведение останется идентичным Blazor Server эпохи .NET 7. Единственное, что кусается, это двойное выполнение пререндеринга. Это руководство ориентировано на **.NET 11** (на момент написания предварительная версия, GA запланирован на ноябрь 2026) и набор пакетов `Microsoft.AspNetCore.Components` 11.0.x.

## Зачем уходить с отдельного шаблона Server

Отдельный шаблон `blazorserver` по-прежнему работает в .NET 11, так что это не вынужденная миграция. Делайте её, когда одно из этого станет реальным результатом, которого вы хотите, не раньше:

- **Render modes на страницу.** Оказавшись на шаблоне Web App, вы можете поставить маркетинговую страницу на `@rendermode StaticServer` (без circuit SignalR, без JavaScript, индексируется как Razor Page), сохранив при этом дашборд на `InteractiveServer`. В отдельном шаблоне смешивать режимы вообще нельзя.
- **Путь к WebAssembly и Auto без переписывания.** Добавление позже виджета с поддержкой офлайн означает добавление проекта `.Client` и одного `@rendermode InteractiveWebAssembly`, а не перенос всего приложения.
- **Вы на рекомендованном Microsoft значении по умолчанию.** Шаблоны, примеры из документации и новые руководства ведут с шаблоном Blazor Web App начиная с .NET 8. Оставаться на отдельном Server теперь отклонение, которое вам придётся обосновывать на code review.
- **Устойчивое состояние circuit в .NET 10+.** Шаблон Web App вместе с атрибутом `[PersistentState]` может восстанавливать состояние компонента при переподключении оборвавшегося circuit SignalR, чего старая модель `ServerPrerendered` никогда чисто не делала.

Если ничего из этого не применимо, изменение `<TargetFramework>net11.0</TargetFramework>` в вашем существующем отдельном приложении Server является допустимой альтернативой и не является этой миграцией.

## Что ломается

| Область                    | Изменение                                                                                     | Серьёзность |
| -------------------------- | ------------------------------------------------------------------------------------------- | -------- |
| Хост-страница              | `Pages/_Host.cshtml` и `_Layout.cshtml` заменяются корневым хост-компонентом `App.razor`     | high     |
| Маршрутизация              | `<Router>` переезжает из `App.razor` в новый `Routes.razor`                                   | high     |
| Запуск в `Program.cs`      | `AddServerSideBlazor()` + `MapBlazorHub()` + `MapFallbackToPage("/_Host")` заменяются на `AddRazorComponents().AddInteractiveServerComponents()` + `MapRazorComponents<App>().AddInteractiveServerRenderMode()` | high     |
| Render mode                | Интерактивность включается по выбору на компонент или глобально; нет неявного "всё приложение интерактивно" | high     |
| Пререндеринг               | `OnInitialized`/`OnInitializedAsync` по умолчанию выполняются дважды (проход пререндера + интерактивный проход) | medium   |
| Клиентский скрипт          | `_framework/blazor.server.js` становится `_framework/blazor.web.js`                          | medium   |
| Подключение аутентификации | Компонент `CascadingAuthenticationState` заменяется на `AddCascadingAuthenticationState()` в DI | medium   |
| Доступ к `HttpContext`     | `HttpContext` доступен только во время статического SSR, а не внутри интерактивного компонента | medium   |
| Семантика `App.razor`      | `App.razor` больше не маршрутизатор; это оболочка HTML-документа                              | low      |

## Чек-лист перед стартом

- Установите **SDK .NET 11** (`dotnet --version` сообщает `11.0.1xx`). Подтвердите через `dotnet --list-sdks`.
- Закоммитьте чистую контрольную точку и **создайте ветку**. Эта миграция удаляет файлы; вам нужен лёгкий путь назад.
- Запишите вашу текущую точку входа. Отдельный Blazor Server использует либо `_Host.cshtml` (распространённый макет до .NET 8), либо уже хост `App.razor`. Шаги ниже предполагают `_Host.cshtml`.
- Инвентаризируйте каждый `OnInitializedAsync`, имеющий побочные эффекты (записи, события аналитики, одноразовые fetch). Это методы, которые пререндеринг выполнит дважды. Вы вернётесь к каждому на шаге 7.
- Обновите ваш CI до образа SDK .NET 11 и подтвердите, что эталонные `dotnet build` и `dotnet test` проходят на текущем коде, прежде чем что-либо трогать.
- Сгенерируйте одноразовое эталонное приложение через `dotnet new blazor --interactivity Server -o _ref`, чтобы иметь заведомо рабочие `App.razor`, `Routes.razor` и `Program.cs`, с которых можно скопировать структуру.

## Шаги миграции

### 1. Поднимите target framework и пакеты

Отредактируйте `.csproj`. SDK остаётся `Microsoft.NET.Sdk.Web`.

```xml
<!-- .NET 11 -->
<PropertyGroup>
  <TargetFramework>net11.0</TargetFramework>
  <Nullable>enable</Nullable>
  <ImplicitUsings>enable</ImplicitUsings>
</PropertyGroup>
```

Поднимите любые ссылки на пакеты `Microsoft.AspNetCore.Components.*` до `11.0.x`. Удалите `Microsoft.AspNetCore.Components.Web`, если он указан явно; он входит во framework reference для проектов веб-SDK.

Проверка: `dotnet restore` завершается, а `dotnet build` падает только с ошибками о хост-странице и `Program.cs` (что ожидаемо на этом этапе), а не с ошибками разрешения пакетов.

### 2. Создайте хост-компонент `App.razor`

В отдельном шаблоне Server HTML-документ живёт в `Pages/_Host.cshtml` и `Pages/_Layout.cshtml`. Перенесите эту разметку в новый корневой `App.razor` (сначала удалите старый маршрутизатор `App.razor` или переименуйте его). Tag helper `<component>`, который запускал корень, становится `<Routes />`.

```razor
@* .NET 11 - App.razor is now the HTML document shell, not the router *@
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <base href="/" />
    <link rel="stylesheet" href="app.css" />
    <link rel="stylesheet" href="YourApp.styles.css" />
    <HeadOutlet />
</head>
<body>
    <Routes />
    <script src="_framework/blazor.web.js"></script>
</body>
</html>
```

Два изменения, которые легко пропустить: скрипт это `blazor.web.js` (не `blazor.server.js`), а `<HeadOutlet />` вместе с `<Routes />` это компоненты, поэтому они принимают тот render mode, который вы им назначите на шаге 6.

Проверка: файл компилируется как компонент Razor (без директивы `@page`, без `@model`).

### 3. Перенесите маршрутизацию в `Routes.razor`

Создайте `Routes.razor` в корне проекта и вставьте блок `<Router>`, который раньше жил в старом `App.razor`.

```razor
@* .NET 11 - Routes.razor holds the router that used to be in App.razor *@
<Router AppAssembly="@typeof(Program).Assembly">
    <Found Context="routeData">
        <RouteView RouteData="@routeData" DefaultLayout="@typeof(Layout.MainLayout)" />
        <FocusOnNavigate RouteData="@routeData" Selector="h1" />
    </Found>
    <NotFound>
        <PageTitle>Not found</PageTitle>
        <LayoutView Layout="@typeof(Layout.MainLayout)">
            <p role="alert">Sorry, there's nothing at this address.</p>
        </LayoutView>
    </NotFound>
</Router>
```

Проверка: `dotnet build` больше не жалуется на отсутствующий тип `Routes`.

### 4. Включите сокращения render mode в `_Imports.razor`

Добавьте эту строку в `_Imports.razor`, чтобы вы могли писать `InteractiveServer` вместо полного указания:

```razor
@* .NET 11 *@
@using static Microsoft.AspNetCore.Components.Web.RenderMode
```

Проверка: `@rendermode InteractiveServer` в компоненте разрешается без ошибки using.

### 5. Перепишите `Program.cs`

Замените регистрацию Blazor Server и эндпойнты на эквиваленты Razor Components.

```csharp
// .NET 11, C# 14 - Blazor Web App startup
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();

// keep your existing app services here (DbContext, HttpClient, etc.)

var app = builder.Build();

if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Error", createScopeForErrors: true);
    app.UseHsts();
}

app.UseHttpsRedirection();
app.UseStaticFiles();
app.UseAntiforgery();

app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode();

app.Run();
```

Удалите `AddServerSideBlazor()`, `app.MapBlazorHub()` и `app.MapFallbackToPage("/_Host")`. Вызов `app.UseAntiforgery()` новый и обязательный; шаблон Web App включает middleware antiforgery по умолчанию, и отправки форм без него падают.

Проверка: `dotnet build` завершается с нулём ошибок.

### 6. Сделайте приложение интерактивным (глобальный render mode)

Миграция с наименьшим риском делает всё приложение `InteractiveServer`, точно воспроизводя старое поведение. Установите render mode на `<Routes />` и `<HeadOutlet />` внутри `App.razor`:

```razor
@* .NET 11 - global InteractiveServer, matches standalone Blazor Server behaviour *@
<HeadOutlet @rendermode="InteractiveServer" />
...
<Routes @rendermode="InteractiveServer" />
```

Проверка: запустите `dotnet run`, откройте приложение и подтвердите, что интерактивные компоненты (кнопки, `@onclick`, отправки `EditForm`) работают и что браузер держит открытый WebSocket к `/_blazor`. Когда это заработает, позже вы сможете опускать отдельные страницы до `@rendermode StaticServer` или поднимать острова до WebAssembly, но это работа после миграции.

### 7. Обработайте двойное выполнение пререндеринга

Это единственное изменение поведения, которое удивляет людей. С интерактивным render mode Blazor сначала пререндерит статический HTML, затем рендерит снова поверх живого circuit, поэтому `OnInitialized` и `OnInitializedAsync` выполняются дважды. У старого значения по умолчанию отдельного Server (`render-mode="ServerPrerendered"`) было то же свойство, но многие приложения использовали `render-mode="Server"` и никогда этого не видели.

У вас есть три варианта. Самый чистый в .NET 11 это декларативный атрибут `[PersistentState]` (добавлен в .NET 10): получить данные один раз во время пререндера, сериализовать в HTML, восстановить в интерактивном проходе.

```csharp
// .NET 11 - fetch once, survive the prerender-to-interactive handoff
public partial class Dashboard : ComponentBase
{
    [PersistentState]
    public List<Order>? Orders { get; set; }

    [Inject] public required IOrderService OrderService { get; init; }

    protected override async Task OnInitializedAsync()
    {
        // Orders is non-null on the interactive pass: state was restored,
        // so the service is not hit a second time.
        Orders ??= await OrderService.GetRecentAsync();
    }
}
```

Если вы вообще не хотите получать данные во время пререндера, отключите пререндеринг для этой границы:

```razor
@* .NET 11 - skip the prerender pass entirely for this component tree *@
<Routes @rendermode="new InteractiveServerRenderMode(prerender: false)" />
```

Проверка: поставьте точку останова или строку журнала в каждый `OnInitializedAsync` с побочными эффектами и подтвердите, что он выполняется один раз на реальную навигацию, а не дважды.

### 8. Переподключите аутентификацию и авторизацию

Если ваше приложение использовало `<CascadingAuthenticationState>`, обёрнутый вокруг маршрутизатора, удалите этот компонент и зарегистрируйте его в DI вместо этого, затем замените `RouteView` на `AuthorizeRouteView` в `Routes.razor`.

```csharp
// .NET 11 - Program.cs
builder.Services.AddCascadingAuthenticationState();
```

```razor
@* .NET 11 - Routes.razor, authorized routing *@
<AuthorizeRouteView RouteData="@routeData" DefaultLayout="@typeof(Layout.MainLayout)" />
```

Проверка: зайдите на страницу `[Authorize]` без входа в систему и подтвердите, что вас перенаправляет, затем войдите и подтвердите доступ.

### 9. Удалите мёртвые хост-файлы

Удалите `Pages/_Host.cshtml`, `Pages/_Layout.cshtml` и любой вызов `app.MapRazorPages()`, который существовал только для обслуживания `_Host`. Уберите `AddRazorPages()` из `Program.cs`, если больше ничто не использует Razor Pages.

Проверка: `dotnet build` чист, и приложение по-прежнему обслуживает каждый маршрут.

## Проверка: дымовой тест после миграции

Прогоните всё это перед слиянием:

- `dotnet build -c Release` сообщает ноль предупреждений, связанных с render modes.
- `dotnet test` проходит с тем же количеством, что и ваш эталон до миграции.
- Приложение стартует через `dotnet run`, и главная страница рендерится.
- Интерактивный элемент управления (`@onclick`, `EditForm`) работает, и браузер держит открытый WebSocket `/_blazor`.
- Навигация по странице не запускает побочный эффект дважды (проверка из шага 7, повторённая от начала до конца).
- Маршрут, защищённый `[Authorize]`, перенаправляет при отсутствии входа.
- POST формы проходит успешно (это проверка middleware antiforgery из шага 5).
- Просмотрите исходный код страницы: разметка это пререндеренный HTML, а не пустой `<div id="app">`.

## План отката

Эта миграция обратима только если вы сохранили ветку с шага перед стартом. После того как вы удалите `_Host.cshtml` и перепишете `Program.cs`, нет переключателя на месте обратно к модели отдельного Server. Откатывайтесь через checkout коммита до миграции, а не редактированием вперёд. Поскольку изменение структурное, а не миграция данных, в вашей базе данных или хранилище ничего отменять не нужно. Создайте ветку, выполните работу, проверьте по дымовому тесту и сливайте только когда всё зелёное.

## Грабли, на которые мы наступили

- **Забыть `app.UseAntiforgery()`.** Шаблон Web App требует middleware antiforgery. Без этого вызова каждый POST `EditForm` возвращает 400 с `Antiforgery token validation failed`. Отдельному шаблону Server это не было нужно, потому что обработка форм шла поверх circuit SignalR, а не поверх HTTP POST.
- **`HttpContext` равен null внутри интерактивных компонентов.** В отдельном Server вы иногда могли достучаться до `IHttpContextAccessor` из компонента. Под шаблоном Web App `HttpContext` существует только во время прохода статического SSR. Прочитайте то, что вам нужно (заголовки, cookie, аутентифицированного пользователя), во время пререндера и передайте вниз, либо используйте каскадный `AuthenticationState`.
- **`blazor.server.js`, оставленный в разметке.** Если вы скопируете старый тег скрипта из `_Host.cshtml` дословно, страница загружается, но никакой circuit не открывается и ничто не интерактивно. Должно быть `_framework/blazor.web.js`.
- **Scoped-сервисы ведут себя по-разному через границу пререндера.** Сервис, разрешённый во время пререндера и снова во время интерактивного прохода, это два разных scope. Если вы кешировали состояние на запрос в scoped-сервисе, ожидая, что оно переживёт, оно не переживёт. Это тот же класс проблем, что разобран в [Невозможно использовать scoped-сервис из singleton](/ru/2026/05/fix-cannot-consume-scoped-service-from-singleton/).
- **Статические ресурсы с 404 после перемещения.** Шаблон Web App обслуживает CSS с областью компонента как `YourApp.styles.css`. Если ваш старый `_Layout.cshtml` ссылался на bundle с другим именем, ссылка ломается молча. Проверьте href у `<link>` в новом `App.razor`.

Пункт назначения здесь почти всегда "каждая страница на `InteractiveServer`, пререндеринг обработан". Это миграция, которая не меняет ничего из того, что видит пользователь. Добавление страниц Static Server, островов WebAssembly и компонентов Auto это награда, которую вы собираете потом, по одному компоненту за раз, без дальнейшей структурной встряски.

## Связанное

- [Blazor Server против Blazor WebAssembly против Blazor United в .NET 11: что выбрать](/ru/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) для решения, стоящего за целевым шаблоном.
- [Как разделить логику валидации между сервером и Blazor WebAssembly](/ru/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) для паттерна общего проекта, который вам понадобится, как только вы добавите компоненты WASM.
- [Blazor SSR наконец получает TempData в .NET 11](/ru/2026/04/blazor-ssr-tempdata-dotnet-11/) для потоков Post-Redirect-Get на страницах статического SSR, которые теперь можно добавить.
- [Решение: Невозможно использовать scoped-сервис из singleton](/ru/2026/05/fix-cannot-consume-scoped-service-from-singleton/) для проблем времени жизни scope, которые обнажает граница пререндера.
- [Миграция с .NET Framework 4.8 на .NET 11 в 2026](/ru/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/), если этот переход на Blazor является частью более крупного скачка фреймворка.

## Источники

- [ASP.NET Core Blazor render modes](https://learn.microsoft.com/aspnet/core/blazor/components/render-modes), Microsoft Learn, дата обращения 2026-06-05.
- [ASP.NET Core Blazor prerendered state persistence](https://learn.microsoft.com/aspnet/core/blazor/state-management/prerendered-state-persistence), Microsoft Learn, об атрибуте `[PersistentState]`, добавленном в .NET 10.
- [Migrate from ASP.NET Core in .NET 7 to .NET 8](https://learn.microsoft.com/aspnet/core/migration/70-to-80), Microsoft Learn, об исходных шагах реструктуризации хоста с Blazor Server на Web App.
- [ASP.NET Core Razor component lifecycle](https://learn.microsoft.com/aspnet/core/blazor/components/lifecycle), Microsoft Learn, о поведении двойного выполнения пререндера.
</content>
