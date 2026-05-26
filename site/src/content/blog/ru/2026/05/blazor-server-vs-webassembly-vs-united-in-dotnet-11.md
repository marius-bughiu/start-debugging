---
title: "Blazor Server vs Blazor WebAssembly vs Blazor United в .NET 11: что выбрать в 2026 году?"
description: "Для любого нового Blazor-приложения на .NET 11 создавайте Blazor Web App (шаблон, ранее известный как Blazor United) и выбирайте режим рендеринга для каждой страницы. Шаблоны только Server или только WebAssembly остаются оправданными лишь в узких случаях."
pubDate: 2026-05-26
tags:
  - "comparison"
  - "blazor"
  - "dotnet"
  - "csharp"
  - "aspnetcore"
lang: "ru"
translationOf: "2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-26
---

Для нового Blazor-проекта на .NET 11 ответ один: шаблон Blazor Web App (модель, которую во время preview .NET 8 называли "Blazor United"). Он позволяет выбирать рендеринг по компоненту: статический серверный рендеринг для маркетинговых страниц, интерактивный Server для CRUD-экранов с низкой задержкой, интерактивный WebAssembly для виджетов с поддержкой офлайн и Auto для компонентов, которые должны переключаться с Server на WebAssembly, как только загрузится пакет WASM. Шаблоны только Server или только WebAssembly стоит выбирать только при жёстком ограничении, исключающем унифицированную модель: внутреннее приложение, где загрузка WebAssembly недопустима, или PWA, которое должно работать полностью офлайн против сторонней API.

Эта статья ориентирована на .NET 11 (на момент написания в preview, GA запланирована на ноябрь 2026 года) и набор пакетов `Microsoft.AspNetCore.Components` 11.0.x. Шаблоны проектов взяты из `Microsoft.AspNetCore.Components.WebAssembly.Templates` и встроенного `dotnet new blazor`, поставляемого с SDK .NET 11. Там, где поведение различается между версиями, я указываю разницу между .NET 8, .NET 9, .NET 10 и .NET 11 прямо в тексте.

## Что такое "Blazor United" в .NET 11 на самом деле

"Blazor United" не отдельная модель хостинга. Это было рабочее название, которым Microsoft пользовалась в течение цикла preview .NET 8 для того, что в итоге вышло как шаблон **Blazor Web App**. Шаблон объединяет четыре режима рендеринга в одном проекте:

- **Static Server (SSR)**: HTML рендерится на сервере, без интерактивности, без circuit SignalR, без загрузки WebAssembly. Загружается как Razor Page.
- **Interactive Server**: HTML рендерится на сервере, обновления DOM передаются по circuit SignalR. Классическая модель Blazor Server.
- **Interactive WebAssembly**: Компонент выполняется в браузере на среде выполнения WebAssembly. Классическая модель Blazor WebAssembly.
- **Interactive Auto**: Рендерится на Server, пока пользователь ждёт фоновой загрузки пакета WebAssembly, а затем прозрачно передаётся в WebAssembly при следующей навигации. Покомпонентный fallback, если WebAssembly не загрузится.

Режим объявляется для каждого компонента: `@rendermode InteractiveServer`, `@rendermode InteractiveWebAssembly` или `@rendermode InteractiveAuto`. Один и тот же файл `.razor` может работать в любом из этих режимов, если не вызывает API, специфичные для конкретного режима (об этом ниже).

Blazor Server (автономный шаблон, `dotnet new blazorserver`) и Blazor WebAssembly (`dotnet new blazorwasm`) по-прежнему существуют в .NET 11, но рекомендация Microsoft с .NET 8 такова: предпочитайте унифицированный шаблон Blazor Web App, если у вас нет конкретной причины этого не делать.

## Матрица возможностей

| Возможность                               | Blazor Server (автономный)               | Blazor WebAssembly (автономный)              | Blazor Web App / United (.NET 11)            |
| ----------------------------------------- | ---------------------------------------- | -------------------------------------------- | -------------------------------------------- |
| Место рендеринга                          | сервер                                   | браузер                                      | покомпонентно (Static, Server, WASM, Auto)   |
| Начальный payload (холодный кеш)          | ~50-80 КБ HTML                           | ~1,4 МБ WASM + сборки (R2R, .NET 11)         | ~50-80 КБ HTML, WASM подгружается лениво     |
| First Contentful Paint (LAN)              | ~80-150 мс                               | ~600-900 мс                                  | ~80-150 мс (Static / Server) ~600-900 мс (WASM-first) |
| Время до интерактивности после FCP        | десятки мс (открытие WebSocket)          | сотни мс (загрузка WASM)                     | зависит от режима рендеринга страницы        |
| Требуется постоянный WebSocket            | да (SignalR)                             | нет                                          | только для компонентов Interactive Server    |
| Работает офлайн                           | нет                                      | да (с service worker)                        | да для компонентов WebAssembly, нет для Server |
| Прямой доступ к БД / файлам / секретам    | да (процесс сервера)                     | нет (sandbox браузера)                       | да в компонентах Server, нет в компонентах WASM |
| Поверхность API .NET                      | полная серверная среда выполнения        | урезанное, безопасное для браузера подмножество | обе, в зависимости от компонента          |
| Отладка                                   | F5 в Visual Studio / Rider               | devtools Chrome + отладчик WebAssembly в VS  | обе                                          |
| Потолок масштабирования на сервер         | ограничен открытыми circuits (~5k на узел) | неограничен (статика + API)                | ограничен только для страниц Interactive Server |
| Поддержка Native AOT                      | нет (сервер по-прежнему JIT)             | частично через WASM AOT                      | по режиму рендеринга                         |
| Аутентификация                            | cookie + circuit                         | OIDC / токен в браузере                      | cookie для SSR/Server, токен для WASM        |
| Статус в .NET 11                          | поддерживается, не рекомендованный по умолчанию | поддерживается, не рекомендованный по умолчанию | рекомендованный по умолчанию          |

Последняя строка закрывает обсуждение для большинства новых приложений. Собственные шаблоны Microsoft, примеры из документации и туториалы начинают именно с шаблона Blazor Web App. Выбор только Server или только WebAssembly в 2026 году теперь является явным отклонением, которое требует обоснования.

## Когда выбирать Blazor Server (автономный)

Автономный шаблон Blazor Server остаётся правильным выбором при одном из следующих ограничений:

- **Внутреннее приложение в LAN, фиксированное число пользователей, запрет на загрузку WebAssembly.** Полевые сервисные инструменты, дашборды производства, экраны на этажах больницы. Загрузка 1,4 МБ WebAssembly через нестабильный киоск Wi-Fi даёт худший опыт, чем переподключение SignalR. В .NET 11 автономный шаблон Server также даёт самый лёгкий контейнерный образ, потому что никогда не копирует среду выполнения WASM в вашу публикацию.
- **Нужно обращаться из компонента к SQL Server с Windows-аутентификацией или к сервису под Kerberos.** Компонент выполняется в процессе сервера, поэтому может использовать интегрированные учётные данные идентификации app pool. Эквивалента для WebAssembly без серверного прокси нет.
- **В команде нет фронтенд-разработчиков и не будет.** Серверный рендеринг с circuit SignalR прячет почти все браузерные нюансы. Состояние живёт на сервере, отладка ведётся обычными инструментами .NET, и нет второго билд-пайплайна для пакета WASM.

Минимальный `Program.cs` для Blazor Server в .NET 11:

```csharp
// .NET 11, C# 14, Microsoft.AspNetCore.Components.Server 11.0.x
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();

var app = builder.Build();

app.UseStaticFiles();
app.UseAntiforgery();

app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode();

app.Run();
```

Обратите внимание: `AddRazorComponents()` плюс `AddInteractiveServerComponents()` — это API из .NET 8+. Старый `AddServerSideBlazor()` ещё работает, но проходит через слой совместимости и не задействует новую инфраструктуру режимов рендеринга. В любом greenfield-проекте используйте новые API.

## Когда выбирать Blazor WebAssembly (автономный)

Берите автономный шаблон WebAssembly, когда:

- **Приложение должно работать офлайн.** PWA для инженеров на выезде, планшетное приложение для сотрудников в магазине, что угодно, что общается с бекендом за нестабильным каналом. Сочетайте service worker с локальным хранилищем (`IndexedDB` через `Microsoft.JSInterop`), и приложение переживёт полную потерю сети.
- **Вы разворачиваетесь на CDN или статическом хостинге без среды выполнения .NET.** Blazor WebAssembly — это просто `wwwroot/` плюс папка `_framework/`. Положите его на Cloudflare Pages, GitHub Pages, Azure Static Web Apps или любой S3-bucket за CloudFront. Платите ноль за вычисления. Шаблон Blazor Web App, напротив, требует ASP.NET Core хост для страниц Server и SSR.
- **Бекенд — сторонняя API, которую вы не контролируете.** Если ваше хранилище данных — Stripe, Auth0 или публичная REST API, серверной логики хостить нечего. Автономный шаблон WASM плюс поток OIDC PKCE даёт полностью клиентское приложение без собственной инфраструктуры.
- **Вы хотите доставить фронтенд как часть приложения MAUI Hybrid или Electron.** И `BlazorWebView`, и шаблон .NET MAUI Hybrid ожидают граф компонентов в стиле автономного WebAssembly. Встраивать туда проект Blazor Web App смысла нет.

Минимальный `Program.cs` для Blazor WebAssembly в .NET 11:

```csharp
// .NET 11, C# 14, Microsoft.AspNetCore.Components.WebAssembly 11.0.x
using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;

var builder = WebAssemblyHostBuilder.CreateDefault(args);
builder.RootComponents.Add<App>("#app");
builder.RootComponents.Add<HeadOutlet>("head::after");

builder.Services.AddScoped(sp => new HttpClient
{
    BaseAddress = new Uri(builder.HostEnvironment.BaseAddress)
});

await builder.Build().RunAsync();
```

В .NET 11 в среде выполнения WebAssembly многопоточность включена по умолчанию для новых проектов, если в `.csproj` поставить `<WasmEnableThreads>true</WasmEnableThreads>`. Это убирает одну из главных причин, по которой раньше отвергали Blazor WebAssembly: загрузка CPU больше не блокирует UI-поток.

## Когда выбирать Blazor Web App (модель United)

Во всех остальных случаях. Унифицированный шаблон даёт один проект, в котором:

- Главная страница имеет `@rendermode StaticServer` и загружается менее чем за 100 мс вообще без JavaScript. Для поискового бота она неотличима от Razor Page.
- Дашборд имеет `@rendermode InteractiveServer`, потому что напрямую общается с `DbContext`, и вы не хотите выставлять эти запросы наружу через API.
- Аннотатор изображений имеет `@rendermode InteractiveWebAssembly`, потому что выполняет ONNX-модель в браузере через `Microsoft.ML.OnnxRuntime`.
- Общие компоненты оболочки имеют `@rendermode InteractiveAuto`: рендерятся под Server при первом paint, затем передаются в WebAssembly, когда пакет догружается, так что последующие навигации мгновенные и переживают перезапуск сервера.

Такая композиция не повторяется больше нигде. Вы уходите от бинарного выбора "Server-приложение или WASM-приложение" к выбору по странице, ровно как Next.js позволяет смешивать `ssr`, `static` и `client`. Минимальный `Program.cs` для Blazor Web App в .NET 11:

```csharp
// .NET 11, C# 14, Microsoft.AspNetCore.Components.Server 11.0.x +
// Microsoft.AspNetCore.Components.WebAssembly.Server 11.0.x
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents()
    .AddInteractiveWebAssemblyComponents();

var app = builder.Build();

app.UseStaticFiles();
app.UseAntiforgery();

app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode()
    .AddInteractiveWebAssemblyRenderMode()
    .AddAdditionalAssemblies(typeof(BlazorApp.Client._Imports).Assembly);

app.Run();
```

Проект `.Client`, идущий в комплекте с шаблоном, — это место для компонентов, которым нужно работать на WebAssembly. Компоненты только для сервера остаются в хост-проекте. Компоненты Interactive Auto живут в `.Client` (потому что должны быть достижимы и со стороны WebAssembly).

## Данные по холодному старту и размеру пакета

Цифры ниже получены из чистых `dotnet new blazor`, `dotnet new blazorserver` и `dotnet new blazorwasm` на SDK .NET 11 `11.0.100-preview.4.26152.6`, опубликованных через `dotnet publish -c Release` и поданных `dotnet run`. Измерено в Chrome 137 на MacBook Pro M2, с холодным кешем, при throttling "Fast 3G" в DevTools.

| Метрика                                      | Blazor Server | Blazor WebAssembly | Blazor Web App (Auto на главной) |
| -------------------------------------------- | ------------- | ------------------ | -------------------------------- |
| Передано начального HTML                     | 8 КБ          | 4 КБ               | 8 КБ                             |
| Передано WebAssembly + сборок                | 0             | 1,42 МБ (gzip)     | 1,42 МБ (gzip, лениво)           |
| Время до First Contentful Paint              | 320 мс        | 1850 мс            | 340 мс                           |
| Время до интерактивности (кнопка counter)    | 410 мс        | 2300 мс            | 440 мс (Server) / 2400 мс (передача в WASM) |
| Память после первой навигации                | 7 МБ браузера | 38 МБ браузера     | 9 МБ, затем 41 МБ после передачи |

Blazor Web App в режиме Auto выигрывает у автономного WebAssembly по first paint в пять раз, потому что не ждёт пакет. Автономный Server он не выигрывает, потому что как только пакет WebAssembly догружается, память расходуется так же. Дело не в том, что Auto самый быстрый по какой-то одной метрике. Дело в том, что он никогда не самый медленный.

Для более глубокого взгляда на то, как SDK .NET 11 урезает пакет WASM, посмотрите [новый шаблон Blazor WebWorker в .NET 11](/2026/04/dotnet-11-preview-2-blazor-webworker-template/), который использует те же настройки trimmer.

## Подводный камень, который выбирает за вас

Три вещи диктуют выбор независимо от предпочтений:

1. **Нельзя внедрить `DbContext` в компонент WebAssembly.** Так же как и значение `IConfiguration`, содержащее секрет. И blob-клиент, использующий строку подключения. Браузер по дизайну — враждебная среда. Если ваш компонент должен читать БД напрямую, он обязан быть Server (или вам нужна бекенд-API, к которой обращается компонент WASM). Шаблон Blazor Web App показывает это сразу: добавьте `@inject ApplicationDbContext Db` в компонент `.Client`, и сборка упадёт с понятной ошибкой об отсутствующем внедрении зависимостей.

2. **Нельзя переключать `@rendermode` внутри границы режима рендеринга.** Страница, рендерящаяся как Static Server, может содержать остров Interactive Server, а страница Interactive Server может содержать острова Interactive WebAssembly, но вложить интерактивность в интерактивность нельзя. На практике это означает: выбирайте самый низкий режим рендеринга, который годится для страницы, и поднимайтесь только на уровне островов.

3. **HTTPS, antiforgery и состояние аутентификации идут через cookies по умолчанию.** Компоненты WebAssembly не видят эти cookies для cross-origin запросов. Если часть WebAssembly в Blazor Web App вызывает внешнюю API, поверх нужен поток токенов OIDC, а не только cookie хоста. Это самый частый камень преткновения при миграции приложения Blazor Server на шаблон Web App.

По части antiforgery [поведение TempData в Blazor SSR в .NET 11](/2026/04/blazor-ssr-tempdata-dotnet-11/) и [руководство по совместной логике валидации](/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) разбирают практические паттерны.

## Рекомендация ещё раз

Для нового Blazor-проекта на .NET 11 в 2026 году начинайте с `dotnet new blazor` (шаблона Blazor Web App) и назначайте режимы рендеринга для каждой страницы. Стоимость возможности опуститься до `@rendermode StaticServer` для маркетинговой страницы или подняться до `@rendermode InteractiveWebAssembly` для компонента с поддержкой офлайн почти нулевая по сравнению со стоимостью неправильного выбора автономного шаблона и последующей переписки. Выбирайте `dotnet new blazorserver` только при жёстком запрете на загрузку WebAssembly. Выбирайте `dotnet new blazorwasm` только если в целевом окружении нет среды выполнения .NET или если вы встраиваете фронтенд в MAUI Hybrid или Electron.

Если вы уже на Blazor Server и взвешиваете миграцию, цель почти всегда — шаблон Blazor Web App с большинством существующих страниц на `@rendermode InteractiveServer`. Это миграция с наименьшим риском: поведение страниц, которые переезжают, остаётся идентичным, а возможность инкрементально добавлять компоненты Static Server и Auto разблокирована.

## Связанное

- [Minimal APIs vs контроллеры в ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) — про решения по бекенд-API, которые открывает Blazor Web App.
- [Как использовать Tailwind CSS с Blazor WebAssembly в .NET 11](/2026/05/how-to-use-tailwind-css-with-blazor-webassembly-in-dotnet-11/) — про различия пайплайна стилей между автономным WASM и шаблоном Blazor Web App.
- [Как делить логику валидации между сервером и Blazor WebAssembly](/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) — про практический паттерн "общего проекта", который шаблон Web App формализует.
- [Native AOT vs ReadyToRun vs JIT в .NET 11](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) — про компромиссы режима компиляции, которые касаются и Server, и WASM.
- [Blazor `Virtualize` с переменной высотой в .NET 11 Preview 3](/2026/04/blazor-virtualize-variable-height-dotnet-11-preview-3/) — про одну из новых API, выгодных спискам компонентов в режиме Auto.

## Источники

- [ASP.NET Core Blazor render modes](https://learn.microsoft.com/aspnet/core/blazor/components/render-modes), Microsoft Learn, доступ 2026-05-26.
- [What's new in ASP.NET Core in .NET 8](https://learn.microsoft.com/aspnet/core/release-notes/aspnetcore-8.0) — про первую поставку унифицированного шаблона (тогда в preview его звали "Blazor United").
- [What's new in ASP.NET Core for .NET 11](https://learn.microsoft.com/aspnet/core/release-notes/aspnetcore-11.0) — про улучшения для каждого режима рендеринга.
- [ASP.NET Core Blazor WebAssembly with multithreading](https://learn.microsoft.com/aspnet/core/blazor/performance#webassembly-multithreading) — про флаг `WasmEnableThreads`.
- [`dotnet/aspnetcore` discussion 51020](https://github.com/dotnet/aspnetcore/discussions/51020), где инженеры Microsoft объясняли, почему "United" стал "Web App" в имени GA-шаблона.
