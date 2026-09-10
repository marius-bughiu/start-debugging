---
title: "Исправление: IsAuthenticated равно false, а RemoteUserAccount равен null в Blazor WebAssembly после обновления MSAL"
description: "Microsoft.Authentication.WebAssembly.Msal 10.0.8, 9.0.16 и 8.0.27 перешли на msal.js 4, асинхронный init которого конкурирует сам с собой. Инициализируйте MSAL один раз в Program.cs или закрепите версию 10.0.7."
pubDate: 2026-09-10
template: error-page
tags:
  - "errors"
  - "blazor"
  - "blazor-webassembly"
  - "authentication"
  - "msal"
  - "entra-id"
  - "dotnet-10"
  - "aspnet-core"
lang: "ru"
translationOf: "2026/09/fix-isauthenticated-false-remoteuseraccount-null-blazor-webassembly-msal-upgrade"
translatedBy: "claude"
translationDate: 2026-09-10
---

Если вход в приложение Blazor WebAssembly перестал работать после перехода `Microsoft.Authentication.WebAssembly.Msal` с 10.0.7 на 10.0.8 или новее (или с 9.0.15 на 9.0.16, или с 8.0.26 на 8.0.27), дело не в конфигурации. В этих версиях встроенный msal.js 2.39.0 заменили на 4.30.0, и теперь JavaScript-метод `init` пакета может выполняться дважды одновременно, создавая два клиента MSAL, которые мешают друг другу. Решение: сделать так, чтобы MSAL инициализировался ровно один раз до отрисовки первого компонента, то есть дождаться `GetAuthenticationStateAsync()` в `Program.cs` перед `RunAsync()`. Закрепление пакета на 10.0.7 тоже работает, но только как временная мера. На 2026-09-10 последний релиз, 10.0.12, по-прежнему затронут.

## Ошибка в контексте

Одна и та же регрессия проявляется разными симптомами, и у каждого есть свой issue в `dotnet/aspnetcore`. Исходный отчёт, [dotnet/aspnetcore#66978](https://github.com/dotnet/aspnetcore/issues/66978), описывает приложение, которое работало на 10.0.7, а после обновления до 10.0.8 без каких-либо других изменений `User.Identity.IsAuthenticated` всегда равно `false`, а `RemoteUserAccount`, который получает собственный `AccountClaimsPrincipalFactory.CreateUserAsync` во время колбэка входа, равен `null`. В консоли есть только журнал авторизации:

```
info: Microsoft.AspNetCore.Authorization.DefaultAuthorizationService[2]
      Authorization failed. These requirements were not met:
      DenyAnonymousAuthorizationRequirement: Requires an authenticated user.
```

Затем автор отчёта провёл решающий эксперимент: копирование `AuthenticationService.js` из 10.0.7 в приложение на 10.0.8 устранило проблему без каких-либо других изменений. Ошибка находится в слое JavaScript.

[dotnet/aspnetcore#68549](https://github.com/dotnet/aspnetcore/issues/68549) показывает шумный вариант. На 10.0.10 перезагрузка аутентифицированной страницы в Firefox завершается исключением, выброшенным из `_content/Microsoft.Authentication.WebAssembly.Msal/AuthenticationService.js`:

```
uninitialized_public_client_application: You must call and await the initialize function before attempting to call any other MSAL API.
```

В Edge воспроизвести не удалось. [dotnet/aspnetcore#68136](https://github.com/dotnet/aspnetcore/issues/68136) описывает тихий вариант: вход проходит успешно, но `InteractiveRequestOptions.ReturnUrl` игнорируется, и каждый пользователь попадает на `/`. Комментарии в #66978 добавляют зависание выхода на версиях с 10.0.8 по 10.0.10. У всех четырёх симптомов одна причина.

## Что изменилось в 10.0.8

`Microsoft.Authentication.WebAssembly.Msal` не подключает msal.js с CDN. Пакет компилирует `@azure/msal-browser` в статический ресурс `AuthenticationService.js`, который загружает ваш `index.html`. Поддержка msal.js 2.x закончилась, и сканирование component governance в Microsoft пометило его, поэтому [dotnet/aspnetcore#66055](https://github.com/dotnet/aspnetcore/pull/66055) перевёл пакет на `^4.30.0` в .NET 11 preview 4, а изменение перенесли во все поддерживаемые ветки: [#66094](https://github.com/dotnet/aspnetcore/pull/66094) для 10.0, [#66234](https://github.com/dotnet/aspnetcore/pull/66234) для 9.0 и [#66236](https://github.com/dotnet/aspnetcore/pull/66236) для 8.0. Все три сервисных релиза вышли 2026-05-12. Я проверил сами опубликованные файлы, а не milestones: `AuthenticationService.js` из 10.0.7 содержит msal-browser 2.39.0, а из 10.0.12 содержит 4.30.0.

| Ветка | Последняя версия с msal.js 2 | Первая версия с msal.js 4 |
| ---- | --------------------------- | ---------------------------- |
| .NET 8 | 8.0.26 | 8.0.27 |
| .NET 9 | 9.0.15 | 9.0.16 |
| .NET 10 | 10.0.7 | 10.0.8 |
| .NET 11 | 11.0.0-preview.3 | 11.0.0-preview.4 (включая RC 1) |

## Почему обновление msal.js ломает вход

В msal-browser 3.0 появилось изменение, которое здесь важно: `PublicClientApplication` больше нельзя использовать сразу после создания. Согласно [руководству по миграции с v2 на v3](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-browser/docs/v2-migration.md), сначала нужно вызвать `initialize()` и дождаться его завершения. Пакет Blazor добавил этот вызов в очевидное место, в середину своего статического `init`:

```ts
// Microsoft.Authentication.WebAssembly.Msal 10.0.8 through 10.0.12 (msal-browser 4.30.0)
public static async init(settings: AuthorizeServiceConfiguration, jsLoggingOptions: JavaScriptLoggingOptions) {
    if (!AuthenticationService._initialized) {
        AuthenticationService.instance = new MsalAuthorizeService(settings, new Logger(jsLoggingOptions));
        await AuthenticationService.instance.initialize(); // new in 10.0.8
        AuthenticationService.instance.initializeMsalHandler();
        AuthenticationService._initialized = true;
    }
    return Promise.resolve();
}
```

В 10.0.7 строки с `await` не было. Между чтением `_initialized` и его установкой не было ни одной точки приостановки, а поскольку JavaScript выполняется в одном потоке, весь блок был атомарным. Второй вызов всегда видел `_initialized === true` и ничего не делал. Теперь флаг устанавливается только после `await`, поэтому второй вызов, пришедший, пока первый приостановлен, тоже проходит проверку.

И второй вызов действительно приходит, потому что на стороне C# та же самая схема существует уже много лет. Вот `RemoteAuthenticationService` в `Microsoft.AspNetCore.Components.WebAssembly.Authentication` 10.0.x:

```csharp
// Microsoft.AspNetCore.Components.WebAssembly.Authentication 10.0.x
private async ValueTask EnsureAuthService()
{
    if (!_initialized)
    {
        await JsRuntime.InvokeVoidAsync("AuthenticationService.init", Options.ProviderOptions, _loggingOptions);
        _initialized = true;
    }
}
```

Его вызывает каждая точка входа: `GetAuthenticationStateAsync`, `RequestAccessToken`, `SignInAsync`, `CompleteSignInAsync`, `SignOutAsync` и `CompleteSignOutAsync`. Если две из них стартуют до завершения первого JS-вызова `init`, обе его вызывают. Пока JavaScript был атомарным, это ни на что не влияло. С msal.js 4 каждый вызов создаёт собственный `MsalAuthorizeService`, каждый вызывает `initialize()`, а затем `handleRedirectPromise()`, и второе присваивание перезаписывает `AuthenticationService.instance`. С этого момента каждый статический метод, `getUser`, `completeSignIn` и `signOut`, обращается к последнему присвоенному экземпляру. Этот экземпляр может ещё инициализироваться, а может оказаться тем, кто проиграл гонку за обработку ответа перенаправления.

Это объясняет симптомы. Если `getUser` попадает во второй экземпляр до того, как его `initialize()` завершится, выбрасывается `uninitialized_public_client_application`, и произойдёт ли это, зависит от порядка выполнения промисов, поэтому Firefox показывает ошибку, а Edge нет. Blazor сохраняет URL возврата в `sessionStorage` и удаляет его при первом чтении, поэтому, когда два экземпляра обрабатывают один колбэк, один из них остаётся без состояния, и `RemoteAuthenticatorView` возвращается на `/`. Такой диагноз опубликовал один из комментаторов в #68136 вместе с черновиком исправления, в котором `init` возвращает один общий промис. А когда `completeSignIn` обращается к экземпляру, который не обрабатывал ответ, учётная запись не возвращается, `CreateUserAsync` получает `null`, и пользователь остаётся анонимным.

## Минимальное воспроизведение

Двойную инициализацию легко доказать без тенанта Entra. Создайте шаблон с фиктивными идентификаторами на .NET SDK 10.0.302:

```bash
dotnet new blazorwasm -au SingleOrg --client-id "00001111-aaaa-2222-bbbb-3333cccc4444" --tenant-id "aaaabbbb-0000-cccc-1111-dddd2222eeee" -o MsalRepro
```

Установите все три ссылки на пакеты в 10.0.12. Сам по себе шаблон состояния гонки не показывает: `AuthorizeRouteView` дожидается состояния аутентификации, прежде чем отрисовать `RemoteAuthenticatorView`, поэтому к моменту любого другого запроса первый `init` уже завершён. Реальные приложения редко остаются такими простыми. Достаточно чего угодно за пределами барьера авторизации, что обращается к аутентификации при запуске, например компонента разметки, который загружает данные через авторизованный `HttpClient`. `AuthorizeRouteView` отрисовывает разметку, пока авторизация ещё идёт, поэтому этот код выполняется параллельно с первым `GetAuthenticationStateAsync`:

```razor
@* Layout/NavMenu.razor, .NET 10, Microsoft.Authentication.WebAssembly.Msal 10.0.12 *@
@using Microsoft.AspNetCore.Components.WebAssembly.Authentication
@inject IAccessTokenProvider TokenProvider

@code {
    protected override async Task OnInitializedAsync()
    {
        // Same effect as any startup call through the authorized HttpClient.
        await TokenProvider.RequestAccessToken();
    }
}
```

Чтобы посчитать происходящее, подключите сразу после `AuthenticationService.js` небольшой диагностический скрипт, который оборачивает `init` и отслеживает присваивания `AuthenticationService.instance`:

```js
// wwwroot/probe.js, diagnostic only. Load after AuthenticationService.js.
(() => {
  const svc = window.AuthenticationService;
  const probe = window.__probe = { initCalls: 0, instances: 0 };
  let current;
  Object.defineProperty(svc, 'instance', {
    configurable: true,
    get: () => current,
    set: v => { probe.instances++; current = v; }
  });
  const init = svc.init;
  svc.init = function (...args) { probe.initCalls++; return init.apply(svc, args); };
})();
```

Я открыл `/` и `/authentication/login-callback` в браузере на базе Chromium и после запуска прочитал `window.__probe`. Оба маршрута дали одинаковые числа:

| Конфигурация | Вызовы `init` | Созданные экземпляры MSAL |
| ----- | ------------ | ---------------------- |
| Msal 10.0.12 | 2 | 2 |
| Msal 10.0.7 (msal.js 2.39.0) | 2 | 1 |
| Msal 10.0.12 + предварительная инициализация в `Program.cs` (решение 1) | 1 | 1 |
| Msal 10.0.12 + идемпотентный шим для `init` (решение 2) | 2 | 1 |

Самая показательная строка относится к 10.0.7: двойной вызов из C# существовал всегда, а синхронный `init` из msal.js 2 его поглощал. Без одноразовой регистрации приложения в Entra я не смог пройти настоящий вход через сломанную сборку, поэтому связь второго экземпляра с каждым симптомом выведена из кода и из обсуждений в упомянутых issues. Сам двойной экземпляр измерен.

## Исправление в деталях

### 1. Инициализируйте MSAL один раз в Program.cs

Вызовите поставщик состояния аутентификации один раз, после `Build()` и перед `RunAsync()`:

```csharp
// .NET 10, Microsoft.Authentication.WebAssembly.Msal 10.0.12
using Microsoft.AspNetCore.Components.Authorization;
using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;
using MsalRepro;

var builder = WebAssemblyHostBuilder.CreateDefault(args);
builder.RootComponents.Add<App>("#app");
builder.RootComponents.Add<HeadOutlet>("head::after");

builder.Services.AddScoped(sp => new HttpClient { BaseAddress = new Uri(builder.HostEnvironment.BaseAddress) });

builder.Services.AddMsalAuthentication(options =>
{
    builder.Configuration.Bind("AzureAd", options.ProviderOptions.Authentication);
});

var host = builder.Build();

// Run AuthenticationService.init to completion before any component can race it.
await host.Services.GetRequiredService<AuthenticationStateProvider>().GetAuthenticationStateAsync();

await host.RunAsync();
```

В этот момент ещё не существует ни одного компонента, поэтому с вызовом ничто не может пересечься. `EnsureAuthService` выполняется до конца, устанавливая флаг `_initialized` и в C#, и в JavaScript, и все последующие вызовы полностью пропускают `init`. Взаимодействие с JavaScript доступно в хосте WebAssembly ещё до `RunAsync`, и в моём воспроизведении это снизило счёт до одного вызова `init` и одного экземпляра на обоих маршрутах.

Цена в том, что первая отрисовка ждёт, пока MSAL инициализируется и прочитает свой кеш, а эту работу приложение и так выполняло бы несколькими миллисекундами позже. Если ваш `AccountClaimsPrincipalFactory` в `CreateUserAsync` обращается к Microsoft Graph или к вашему собственному API, этот вызов тоже переместится перед первой отрисовкой. Держите его лёгким или смиритесь с чуть более поздней первой отрисовкой.

### 2. Или сделайте init идемпотентным в JavaScript

Если вы не контролируете запуск, например потому, что общая библиотека компонентов запрашивает токены без вашего участия, исправьте гонку там, где она возникает: в `init`. Этот шим запоминает промис, и то же самое делает внутри пакета черновик исправления из #68136:

```js
// wwwroot/msal-init-fix.js
// Workaround for dotnet/aspnetcore#66978, #68549, #68136
// (Microsoft.Authentication.WebAssembly.Msal 8.0.27+, 9.0.16+, 10.0.8+).
(() => {
  const svc = window.AuthenticationService;
  if (!svc || svc.__initFixApplied) return;
  const originalInit = svc.init;
  let pending;
  svc.init = function (settings, loggingOptions) {
    pending ??= originalInit.call(svc, settings, loggingOptions)
      .catch(e => { pending = undefined; throw e; });
    return pending;
  };
  svc.__initFixApplied = true;
})();
```

Порядок скриптов важен. Шим должен выполниться после того, как скрипт пакета определит `window.AuthenticationService`, и до запуска Blazor:

```html
<!-- wwwroot/index.html -->
<script src="_content/Microsoft.Authentication.WebAssembly.Msal/AuthenticationService.js"></script>
<script src="msal-init-fix.js"></script>
<script src="_framework/blazor.webassembly#[.{fingerprint}].js"></script>
```

C# по-прежнему вызывает `init` дважды, но теперь оба вызова ожидают один и тот же промис, и создаётся только один `MsalAuthorizeService`. `.catch` сбрасывает кеш, чтобы неудачную инициализацию можно было повторить, а не получать ошибку навсегда. Это работает, потому что Blazor при каждом вызове находит `AuthenticationService.init` по имени через `window`, так что достаточно подменить свойство.

### 3. Или закрепите пакет на 10.0.7

```xml
<!-- .NET 10: last Msal release that bundles msal.js 2.39.0 -->
<PackageReference Include="Microsoft.Authentication.WebAssembly.Msal" Version="10.0.7" />
```

Аналоги: 9.0.15 и 8.0.26. `Microsoft.AspNetCore.Components.WebAssembly` можно оставить на 10.0.12: такая комбинация собирается, и приложение отдаёт бандл 2.39.0. Учтите, что закрепление тянет `Microsoft.AspNetCore.Components.WebAssembly.Authentication` вниз до 10.0.7 как транзитивную зависимость. Цена в том, что вы поставляете msal.js с истёкшей поддержкой, а именно из-за этого Microsoft и обновилась, так что считайте это временным мостом. Проверьте, что браузер получает на самом деле:

```bash
curl -s http://localhost:5117/_content/Microsoft.Authentication.WebAssembly.Msal/AuthenticationService.js | grep -oE '"(2\.39\.0|4\.30\.0)"'
```

После любой смены версии очищайте данные сайта в браузере, в котором тестируете. Кеш MSAL и состояние, которое Blazor сохраняет в `sessionStorage`, переживают обновления приложения, на что [раздел по устранению неполадок в Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/blazor/security/webassembly/standalone-with-microsoft-entra-id#cookies-and-site-data) указывает именно для такого тестирования.

## Подводные камни и похожие ошибки

**Пользователи выходят из системы после закрытия браузера при `CacheLocation = "localStorage"`.** Это msal.js 4, работающий так, как задумано, а не состояние гонки. Начиная с v4 MSAL шифрует кеш в `localStorage` алгоритмом AES-GCM и хранит ключ в сессионном cookie с именем `msal.cache.encryption` (он есть в бандле 10.0.12). В [руководстве по миграции с v3 на v4](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-browser/docs/v3-migration.md) сказано, что ключ удаляется при закрытии браузера, поэтому `localStorage` больше не сохраняется между сеансами браузера. Ни одно из решений выше этого не меняет. Закладывайте тихий или интерактивный вход после перезапуска браузера.

**Тихий вход не работает только на хостах с частными IP-адресами.** Если приложение работает на `192.168.x.x` или `10.x.x.x`, а Chrome 142 или новее блокирует скрытый iframe с ошибкой `LocalNetworkAccessPermissionDenied`, это ограничение Local Network Access в Chrome, которое отслеживается в [dotnet/aspnetcore#64699](https://github.com/dotnet/aspnetcore/issues/64699). Оно проявляется на любой версии пакета.

**Приложения с `AddOidcAuthentication` это изменение не затрагивает.** Замена msal.js коснулась только скрипта взаимодействия пакета Msal. Если вы используете универсальный OIDC-провайдер или Blazor Web App с аутентификацией на сервере, причину нужно искать в другом месте.

**Когда выйдет исправление, обходные пути ничему не помешают.** Все три issue открыты в milestone 10.0.x, и на 2026-09-10 исправление не слито. Вызов в `Program.cs` после этого ничего не стоит. Шим превратится в обёртку без эффекта, и его можно удалить, когда `AuthenticationService.init` начнёт хранить промис вместо булева значения.

Если речь о новом приложении, а не о сломанном, сначала стоит прочитать [Blazor Server vs WebAssembly vs United в .NET 11](/ru/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/). Аутентификация на стороне сервера полностью избавляет от токенов в браузере.

## Связанные статьи

- [Blazor Server vs Blazor WebAssembly vs Blazor United в .NET 11](/ru/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/)
- [JWT или аутентификация через cookie в ASP.NET Core 11](/ru/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/), для серверной части API клиента на WebAssembly.
- [Что такое режим отрисовки Blazor и какой из них выполняет мой компонент](/ru/2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component/)
- [SignalR в .NET 11 RC 1 заменяет истекающий токен без разрыва соединения](/ru/2026/09/signalr-authentication-refresh-finalized-dotnet-11-rc-1/)

## Источники

- [dotnet/aspnetcore#66978, проблема аутентификации MSAL после обновления до 10.0.8](https://github.com/dotnet/aspnetcore/issues/66978)
- [dotnet/aspnetcore#68549, `uninitialized_public_client_application` после перезагрузки в Firefox на 10.0.10](https://github.com/dotnet/aspnetcore/issues/68549)
- [dotnet/aspnetcore#68136, `RemoteAuthenticatorView` игнорирует `ReturnUrl` на 10.0.10](https://github.com/dotnet/aspnetcore/issues/68136)
- [dotnet/aspnetcore#66055, обновление `@azure/msal-browser` до 4.x](https://github.com/dotnet/aspnetcore/pull/66055), и его бэкпорты [#66094](https://github.com/dotnet/aspnetcore/pull/66094), [#66234](https://github.com/dotnet/aspnetcore/pull/66234), [#66236](https://github.com/dotnet/aspnetcore/pull/66236)
- [`AuthenticationService.ts` в `release/10.0`](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Components/WebAssembly/Authentication.Msal/src/Interop/AuthenticationService.ts)
- [`RemoteAuthenticationService.cs` в `release/10.0`](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Components/WebAssembly/WebAssembly.Authentication/src/Services/RemoteAuthenticationService.cs)
- [Защита автономного приложения Blazor WebAssembly с помощью Microsoft Entra ID](https://learn.microsoft.com/en-us/aspnet/core/blazor/security/webassembly/standalone-with-microsoft-entra-id)
- [Руководство по миграции msal-browser с v2 на v3](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-browser/docs/v2-migration.md) и [руководство по миграции с v3 на v4](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-browser/docs/v3-migration.md)
- [Microsoft.Authentication.WebAssembly.Msal на NuGet](https://www.nuget.org/packages/Microsoft.Authentication.WebAssembly.Msal)
