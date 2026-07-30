---
title: "Исправление: JavaScript interop calls cannot be issued at this time (предварительный рендеринг Blazor)"
description: "Предварительный рендеринг выполняет компонент на сервере без браузера, поэтому IJSRuntime бросает исключение. Перенесите вызов в OnAfterRenderAsync, проверяйте RendererInfo.IsInteractive или отключите предварительный рендеринг."
pubDate: 2026-07-30
template: error-page
tags:
  - "errors"
  - "blazor"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
lang: "ru"
translationOf: "2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering"
translatedBy: "claude"
translationDate: 2026-07-30
---

Исправление: вы вызвали `IJSRuntime` из `OnInitialized`, `OnInitializedAsync`, `OnParametersSet{Async}` или конструктора компонента, и этот код выполнился во время предварительного рендеринга, когда ни один браузер не подключён и выполнить JavaScript невозможно. Перенесите вызов в `OnAfterRenderAsync(bool firstRender)` под защитой `if (firstRender)`: этот метод никогда не выполняется при предварительном рендеринге. Если ветвление нужно раньше первого интерактивного рендеринга, проверяйте `RendererInfo.IsInteractive` (.NET 9 и новее). Если компонент действительно не работает без JavaScript, отключите для него предварительный рендеринг через `@rendermode @(new InteractiveServerRenderMode(prerender: false))`.

```text
System.InvalidOperationException: JavaScript interop calls cannot be issued at this time.
This is because the component is being statically rendered. When prerendering is enabled,
JavaScript interop calls can only be performed during the OnAfterRenderAsync lifecycle method.
   at Microsoft.AspNetCore.Components.Server.Circuits.RemoteJSRuntime.BeginInvokeJS(...)
   at Microsoft.JSInterop.JSRuntime.InvokeAsync[TValue](String identifier, Object[] args)
   at BlazorSample.Components.Pages.Theme.OnInitializedAsync()
```

Статья ориентирована на .NET 11 (ASP.NET Core 11, `Microsoft.AspNetCore.Components` 11.0.x), но поведение не менялось с момента появления предварительного рендеринга, и рекомендации применимы также к .NET 8, 9 и 10. Единственное исключение -- `RendererInfo`, появившийся в .NET 9.

## Две строки ошибки, два рендерера

Поисковый трафик по этой проблеме приходит на два разных сообщения, и по тому, какое из них вы получили, понятно, какая модель размещения его бросила.

Сообщение, приведённое выше, приходит из `RemoteJSRuntime` в стеке circuit-а Blazor Server. Оно бросается, когда клиентский прокси среды выполнения равен null, то есть компонент выполняется вне активного circuit-а SignalR. В классическом приложении Blazor Server с `render-mode="ServerPrerendered"` вы увидите именно это сообщение.

Второе сообщение приходит из совсем другого типа:

```text
System.InvalidOperationException: JavaScript interop calls cannot be issued during
server-side static rendering, because the page has not yet loaded in the browser.
Statically-rendered components must wrap any JavaScript interop calls in conditional
logic to ensure those interop calls are not attempted during static rendering.
   at Microsoft.AspNetCore.Components.Endpoints.UnsupportedJavaScriptRuntime.Microsoft.JSInterop.IJSRuntime.InvokeAsync[TValue](...)
```

`UnsupportedJavaScriptRuntime` -- это внутренний sealed-класс, реализующий `IJSRuntime`, который рендерер конечных точек регистрирует для статического серверного рендеринга. Каждый его метод бросает исключение. В Blazor Web App (шаблон .NET 8 и новее) и предварительный рендеринг, и статический SSR проходят через рендерер конечных точек, поэтому именно это сообщение вы получаете для страницы вообще без render mode и для прохода предварительного рендеринга компонента `InteractiveWebAssembly` или `InteractiveAuto`.

Оба исключения -- `InvalidOperationException`, у обоих одна и та же первопричина и один и тот же набор исправлений. Если в трассировке стека вы видите `UnsupportedJavaScriptRuntime`, обратите внимание на формулировку: "must wrap any JavaScript interop calls in conditional logic". Эта фраза важна, и именно с ней связана ловушка, описанная ниже.

## Почему при предварительном рендеринге некому звонить в браузер

Предварительный рендеринг -- это статическая отрисовка содержимого страницы на сервере, чтобы HTML попал в браузер как можно быстрее. Дерево компонентов выполняется полностью, порождает разметку, записывается в HTTP-ответ и отбрасывается. Только после этого в браузере запускается скрипт Blazor, открывает circuit (для `InteractiveServer`) или загружает среду выполнения (для `InteractiveWebAssembly`) и заново создаёт компонент в интерактивном режиме.

Во время этого первого прохода нет ни DOM, ни `window`, ни транспорта, по которому можно отправить сообщение JS interop. `IJSRuntime` по-прежнему можно внедрить, потому что сервис зарегистрирован и компонент нормально компилируется, но за ним стоит реализация, у которой либо нет клиентского прокси, либо это заглушка, единственная задача которой -- бросить понятное сообщение. Поэтому это всегда ошибка времени выполнения и никогда -- времени компиляции.

Документация по жизненному циклу прямо описывает следствие: `OnAfterRender` и `OnAfterRenderAsync` "aren't invoked during prerendering or static server-side rendering (static SSR) on the server because those processes aren't attached to a live browser DOM and are already complete before the DOM is updated". Именно это свойство и делает `OnAfterRenderAsync` безопасным местом для interop.

Учтите также, что `OnInitializedAsync` у предварительно отрисованного компонента выполняется дважды: один раз при статическом проходе и второй раз, когда компонент становится интерактивным. Всё, что вы там загружаете, вычисляется дважды. Это отдельная проблема с отдельным решением, разобранная в статье [как сохранить состояние через границу статического и интерактивного рендеринга в Blazor](/ru/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/).

## Минимальное воспроизведение

Вставьте это в Blazor Web App, созданное по шаблону .NET 11, с глобальным или постраничным интерактивным render mode. Падает на первом же запросе, каждый раз.

```razor
@* Theme.razor *@
@* .NET 11, Microsoft.AspNetCore.Components 11.0.0, Blazor Web App *@
@page "/theme"
@rendermode InteractiveServer
@inject IJSRuntime JS

<p>Stored theme: @theme</p>

@code {
    private string? theme;

    protected override async Task OnInitializedAsync()
    {
        // Throws during the prerender pass: no browser, no localStorage.
        theme = await JS.InvokeAsync<string>("localStorage.getItem", "theme");
    }
}
```

Тот же код с `@rendermode InteractiveWebAssembly` бросит вариант `UnsupportedJavaScriptRuntime`, потому что проход предварительного рендеринга происходит в рендерере конечных точек на сервере, а не в circuit-е. Удалите строку `@rendermode` целиком -- и вы тоже получите вариант `UnsupportedJavaScriptRuntime`, теперь уже навсегда, потому что страница стала статическим SSR и никогда не станет интерактивной.

## Исправление 1: перенесите вызов в `OnAfterRenderAsync`

Это рекомендуемое исправление, и именно на него указывает сообщение об ошибке самого фреймворка. `OnAfterRenderAsync` вызывается только после того, как компонент отрисован интерактивно с живым DOM, поэтому interop там всегда допустим.

```razor
@* Theme.razor *@
@* .NET 11, Microsoft.AspNetCore.Components 11.0.0 *@
@page "/theme"
@rendermode InteractiveServer
@inject IJSRuntime JS

<p>Stored theme: @(theme ?? "loading...")</p>

@code {
    private string? theme;

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (firstRender)
        {
            theme = await JS.InvokeAsync<string>("localStorage.getItem", "theme");
            StateHasChanged();
        }
    }
}
```

Две детали, на которых спотыкаются чаще всего:

Проверка `if (firstRender)` -- не факультативная гигиена. Без неё interop повторяется на каждом рендеринге, а так как `StateHasChanged` запускает рендеринг, получается бесконечный цикл.

Явный вызов `StateHasChanged()` обязателен. В отличие от остальных методов жизненного цикла, фреймворк намеренно не планирует повторный рендеринг по завершении `Task`, возвращённой из `OnAfterRenderAsync`, как раз чтобы избежать этого бесконечного цикла. Если вы присвоили значение полю и не вызвали `StateHasChanged`, интерфейс никогда не обновится, и баг выглядит как "мой interop возвращает null".

Проектируйте разметку так, чтобы предварительно отрисованный вывод был осмысленным и без результата JavaScript. Пользователь видит именно этот первый проход. Заполнитель, скелетон или разумное значение по умолчанию лучше, чем пустой элемент, который возникает из ниоткуда мгновением позже.

## Исправление 2: проверяйте `RendererInfo.IsInteractive`

Иногда ветвление нужно раньше первого интерактивного рендеринга, например чтобы решить, что отрисовывать, а не что загружать. `ComponentBase.RendererInfo` (.NET 9 и новее) даёт ровно это:

- `RendererInfo.Name` возвращает `Static`, `Server`, `WebAssembly` или `WebView`.
- `RendererInfo.IsInteractive` равно `true` при интерактивном рендеринге и `false` при предварительном рендеринге или статическом SSR.
- `ComponentBase.AssignedRenderMode` возвращает назначенный компоненту render mode или `null`, если он не назначен.

```razor
@* ThemeAware.razor *@
@* .NET 11 / .NET 10 / .NET 9. RendererInfo requires aspnetcore 9.0+ *@
@page "/theme-aware"
@rendermode InteractiveServer
@inject IJSRuntime JS

@if (!RendererInfo.IsInteractive)
{
    <p>Loading preferences...</p>
}
else
{
    <p>Stored theme: @theme</p>
}

@code {
    private string? theme;

    protected override async Task OnInitializedAsync()
    {
        if (RendererInfo.IsInteractive)
        {
            theme = await JS.InvokeAsync<string>("localStorage.getItem", "theme");
        }
    }
}
```

Это и есть та самая "conditional logic", которой требует сообщение `UnsupportedJavaScriptRuntime`. Это же правильный инструмент для компонента, который обязан отрисовать пригодную статическую разметку: например, форма, отправляемая обычным способом при `AssignedRenderMode is null` и использующая обработчик события в противном случае.

В .NET 8, где `RendererInfo` отсутствует, ближайший способ определить проход предварительного рендеринга -- добавить компоненту `[CascadingParameter] public HttpContext? HttpContext { get; set; }`: он не равен null только при серверном рендеринге. Это работает, но привязывает компонент к типам хостинга ASP.NET Core, поэтому предпочитайте `RendererInfo`, если можете нацелиться на .NET 9 или новее.

## Исправление 3: отключите предварительный рендеринг для компонента

Если компонент бессмыслен без JavaScript (обёртка над графиком, карта, редактор форматированного текста), предварительный рендеринг покупает вам лишь вспышку сломанной разметки. Отключите его в определении компонента:

```razor
@* MapView.razor *@
@* .NET 11. prerender: false is valid on all three interactive render modes *@
@rendermode @(new InteractiveServerRenderMode(prerender: false))
```

Или в месте использования:

```razor
@* .NET 11 *@
<MapView @rendermode="new InteractiveWebAssemblyRenderMode(prerender: false)" />
```

Чтобы отключить его во всём приложении, задайте режим у компонента `Routes` в `App.razor` и не забудьте сделать то же самое для `HeadOutlet`:

```razor
@* App.razor, .NET 11 Blazor Web App template *@
<Routes @rendermode="new InteractiveServerRenderMode(prerender: false)" />
<HeadOutlet @rendermode="new InteractiveServerRenderMode(prerender: false)" />
```

Правило, о которое многие спотыкаются: отключение предварительного рендеринга действует только для render mode верхнего уровня. Если родительский компонент уже задаёт render mode, настройки предварительного рендеринга его потомков игнорируются. Это то же ограничение "одно поддерево -- один render mode", которое стоит за [ошибкой render mode не поддерживается render mode родительского компонента](/ru/2026/06/fix-render-mode-is-not-supported-by-the-parent-components-render-mode-blazor/). Прибегайте к `prerender: false`, только когда граница принадлежит вам, и считайте это крайней мерой: вы отказываетесь от быстрой первой отрисовки и от выигрыша в SEO, ради которых предварительный рендеринг и существует.

## Ловушка: `OnAfterRenderAsync` никогда не выполняется на странице со статическим SSR

Это самая частая причина жалобы "я перенёс код в `OnAfterRenderAsync`, и он всё равно не работает".

`OnAfterRender{Async}` не вызывается ни при предварительном рендеринге, *ни* при статическом SSR. Для предварительно отрисованного интерактивного компонента это не проблема, потому что мгновением позже компонент пересоздаётся интерактивно и метод срабатывает. Но на странице **без** render mode компонент отрисовывается только статически. Второго прохода нет. `OnAfterRenderAsync` не вызывается никогда, ваш interop молча не выполняется, и симптом меняется с громкого исключения на мёртвую функциональность.

Если interop перестал бросать исключение, но и работать перестал, проверьте, что у компонента действительно есть интерактивный render mode: заданный напрямую, унаследованный от родителя или применённый глобально к `Routes`. `AssignedRenderMode is null` внутри компонента -- однострочное подтверждение того, что вы в статическом SSR. Какую модель размещения выбрать -- отдельное решение, разобранное в статье [Blazor Server vs Blazor WebAssembly vs Blazor United в .NET 11](/ru/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/).

## Третий вариант: "the circuit has disconnected and is being disposed"

Есть третье сообщение с теми же первыми словами, и это совсем другой баг с другим исправлением:

```text
Microsoft.JSInterop.JSDisconnectedException: JavaScript interop calls cannot be issued
at this time. This is because the circuit has disconnected and is being disposed.
```

Обратите внимание на тип исключения: `JSDisconnectedException`, а не `InvalidOperationException`. К предварительному рендерингу это отношения не имеет. Оно возникает на другом конце жизни компонента, в серверных приложениях, когда вы вызываете JS (или освобождаете `IJSObjectReference`) после того, как circuit SignalR уже исчез, обычно из `DisposeAsync`, пока пользователь уходит со страницы или перезагружает её. Исправление -- перехватить его:

```csharp
// .NET 11, server-side Blazor. Disposing a JS module after the circuit is gone.
async ValueTask IAsyncDisposable.DisposeAsync()
{
    try
    {
        if (module is not null)
        {
            await module.DisposeAsync();
        }
    }
    catch (JSDisconnectedException)
    {
    }
}
```

В компоненте WebAssembly терять нечего, circuit-а там нет, поэтому уберите `try`/`catch` и просто освободите модуль. А если после потери соединения вам нужна настоящая очистка в браузере, JS interop -- неподходящий инструмент: используйте на клиенте паттерн `MutationObserver` или `disconnectedCallback` у custom element.

## Подводные камни, дающие то же исключение

**Сторонние библиотеки компонентов.** MudBlazor, Radzen и подобные библиотеки вызывают interop внутри себя, чтобы измерить viewport, спозиционировать popover или узнать возможности браузера. Если трассировка стека исключения упирается в тип библиотеки, а не в ваш код, исправление обычно состоит в переключателе на уровне библиотеки или в отключении предварительного рендеринга для страницы, где размещён компонент. Сначала загляните в примечания к выпуску библиотеки: большинство добавили защиту от предварительного рендеринга ещё со времён .NET 8.

**Внедряемые сервисы, вызывающие JS.** Scoped-сервис, оборачивающий `localStorage`, бросит исключение там, где вы вызовете его первым, а это часто `OnInitializedAsync`. Сервис не может исправить это за вас: переносить или обусловливать нужно место вызова. Некоторые библиотеки (в том числе Blazored.LocalStorage) прямо рекомендуют обращаться к хранилищу только после первого рендеринга -- именно по этой причине.

**`IJSInProcessRuntime` в WebAssembly.** Синхронный interop доступен в клиентских компонентах только после запуска среды выполнения WebAssembly. Во время серверного прохода предварительного рендеринга компонента `InteractiveWebAssembly` приведение `IJSRuntime` к `IJSInProcessRuntime` не удаётся или вызов бросает исключение. Используйте `OperatingSystem.IsBrowser()`, когда нужно узнать, действительно ли код выполняется на WebAssembly.

**Интерактивная маршрутизация пропускает предварительный рендеринг.** Если вы попадаете на страницу внутренней расширенной навигацией в приложении, где компонент `Routes` интерактивен, предварительного рендеринга не происходит вовсе, поэтому баг воспроизводится только при полной загрузке страницы. Компонент, который работает при клике по ссылке и падает при F5, -- почти всегда этот случай.

**Долгая работа в инициализации.** Так как предварительный рендеринг ждёт quiescence, медленный `OnInitializedAsync` блокирует весь предварительно отрисованный ответ. Это не то же исключение, но соседняя проблема, ради которой существует потоковый рендеринг, и всплывает она обычно в тех же компонентах.

## Связанные статьи

- [Как сохранить состояние через границу статического и интерактивного рендеринга в Blazor на .NET 11](/ru/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/) решает вторую половину задачи о границе предварительного рендеринга -- двойную инициализацию.
- [Исправление: render mode не поддерживается render mode родительского компонента (Blazor)](/ru/2026/06/fix-render-mode-is-not-supported-by-the-parent-components-render-mode-blazor/) объясняет правило "одно поддерево -- один render mode", ограничивающее действие `prerender: false`.
- [Blazor Server vs Blazor WebAssembly vs Blazor United в .NET 11](/ru/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) разбирает, какой render mode назначать в первую очередь.
- [Миграция приложения Blazor Server на Blazor United (Blazor Web App) в .NET 11](/ru/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/) показывает, как ввести render mode в приложение, где их никогда не было.
- [Как разделить логику валидации между сервером и Blazor WebAssembly](/ru/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) -- паттерн для логики, которая должна работать по обе стороны границы.

## Источники

- [Prerender ASP.NET Core Razor components](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/prerender) (Microsoft Learn, .NET 10/11)
- [ASP.NET Core Razor component lifecycle](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/lifecycle) (Microsoft Learn)
- [ASP.NET Core Blazor render modes](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes) (Microsoft Learn), раздел "Detect rendering location, interactivity, and assigned render mode at runtime"
- [ASP.NET Core Blazor JavaScript interoperability (JS interop)](https://learn.microsoft.com/en-us/aspnet/core/blazor/javascript-interoperability/) (Microsoft Learn), раздел "JavaScript interop calls without a circuit"
- [`RemoteJSRuntime.cs`](https://github.com/dotnet/aspnetcore/blob/main/src/Components/Server/src/Circuits/RemoteJSRuntime.cs) и [`UnsupportedJavaScriptRuntime.cs`](https://github.com/dotnet/aspnetcore/blob/main/src/Components/Endpoints/src/DependencyInjection/UnsupportedJavaScriptRuntime.cs) в `dotnet/aspnetcore`, где бросаются оба сообщения
- [dotnet/aspnetcore #24320](https://github.com/dotnet/aspnetcore/issues/24320), давняя issue по этой ошибке
