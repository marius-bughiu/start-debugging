---
title: "Что такое режим рендеринга в Blazor и какой из них выполняет мой компонент?"
description: "Режим рендеринга определяет, где выполняется компонент Razor и является ли он интерактивным. Здесь разобраны четыре режима в .NET 11, правила наследования, определяющие, что получит ваш компонент, и свойства RendererInfo и AssignedRenderMode, которые во время выполнения показывают, какой режим победил."
pubDate: 2026-09-05
tags:
  - "blazor"
  - "aspnetcore"
  - "dotnet-11"
  - "csharp"
lang: "ru"
translationOf: "2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component"
translatedBy: "claude"
translationDate: 2026-09-05
---

Режим рендеринга -- это настройка уровня компонента в Blazor Web App, которая определяет две вещи: где компонент выполняется (на сервере или в браузере) и может ли он реагировать на события интерфейса. Режимов четыре: Static Server, Interactive Server, Interactive WebAssembly и Interactive Auto. Режим назначается директивой или атрибутом-директивой `@rendermode`, по умолчанию используется Static Server, и режимы распространяются вниз по дереву компонентов, поэтому большинство компонентов вообще ничего не объявляют. Чтобы выяснить, какой режим на самом деле выполняет конкретный компонент, прочитайте `ComponentBase.AssignedRenderMode` и `ComponentBase.RendererInfo` изнутри компонента: при статическом SSR `AssignedRenderMode` равно `null`, а `RendererInfo.IsInteractive` равно `false` во время предварительного рендеринга даже у компонента с интерактивным назначенным режимом.

Всё здесь ориентировано на .NET 11 и ASP.NET Core 11 с C# 14. Режимы рендеринга существуют только в Blazor Web App (унифицированный шаблон, появившийся в .NET 8). У отдельного приложения Blazor WebAssembly или у устаревшего приложения Blazor Server одна модель размещения на всё приложение и директивы `@rendermode` нет вовсе. Там, где поведение изменилось в .NET 10 или .NET 11, я это отмечаю.

## Четыре режима и две оси, по которым они различаются

| Режим | Выполняется | Интерактивный | Требуется проект `.Client` |
| --- | --- | --- | --- |
| Static Server | На сервере | Нет | Нет |
| Interactive Server | На сервере, через канал SignalR | Да | Нет |
| Interactive WebAssembly | В браузере | Да | Да |
| Interactive Auto | Сначала на сервере, при последующих визитах в браузере | Да | Да |

Static Server, обычно называемый статическим SSR, рендерит компонент в поток HTTP-ответа и на этом останавливается. Нет канала, нет среды выполнения .NET в браузере и нет обработки событий. Обработчик `@onclick` на статически отрендеренной кнопке компилируется нормально и во время выполнения не делает ничего. Это режим по умолчанию, и для страниц с контентом он правильный: не нужно держать соединение открытым и не нужно загружать полезную нагрузку WebAssembly.

Interactive Server держит компонент живым на сервере и передаёт события DOM и различия через соединение SignalR. Interactive WebAssembly загружает среду выполнения .NET и бандл приложения и выполняет компонент в браузере. Interactive Auto -- это не третья среда выполнения: при первом визите рендеринг идёт через Interactive Server, пока бандл WebAssembly загружается в фоне, а при последующих визитах используется WebAssembly, когда бандл уже в кеше.

Одно свойство Auto удивляет многих. Согласно [документации по режимам рендеринга](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes), Auto никогда не меняет режим рендеринга компонента, уже находящегося на странице. Решение принимается один раз, при первом рендеринге компонента, и этот режим сохраняется всё время его жизни. Кроме того, Auto предпочитает совпадать с режимом уже присутствующих на странице интерактивных компонентов, чтобы посреди страницы не появилась вторая среда выполнения .NET, не разделяющая состояние с первой. Если вы ещё выбираете между моделями размещения, а не отлаживаете одну из них, подробный разбор есть в статье [Blazor Server vs WebAssembly vs Blazor United в .NET 11](/ru/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/).

Интерактивным режимам нужны соответствующие сервисы и конечные точки, зарегистрированные в `Program.cs`, иначе `@rendermode` ничего не значит:

```csharp
// .NET 11, C# 14 -- Program.cs of a Blazor Web App
builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents()
    .AddInteractiveWebAssemblyComponents();

// ...

app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode()
    .AddInteractiveWebAssemblyRenderMode();
```

## Три места, где можно задать режим рендеринга

Режим, доходящий до компонента, может прийти из трёх разных синтаксических позиций, и они не взаимозаменяемы.

**На экземпляре компонента**, как атрибут-директива, там, где компонент используется:

```razor
@* .NET 11 -- any render mode instance is allowed here *@
<Dialog @rendermode="InteractiveServer" />
```

**На определении компонента**, как директива в начале файла `.razor`. Это то, что вы используете для маршрутизируемой страницы, потому что страницу никто не создаёт вручную:

```razor
@* .NET 11 -- Pages/Counter.razor *@
@page "/counter"
@rendermode InteractiveServer
```

`@rendermode` одновременно является и директивой Razor, и атрибутом-директивой Razor, и различие важно ровно один раз: форма директивы требует статического экземпляра режима рендеринга, а форма атрибута-директивы принимает любой экземпляр, в том числе созданный с параметрами.

**Для всего приложения**, размещением режима на компоненте `Routes` внутри `App.razor`. Маршрутизатор передаёт свой режим каждой странице, которую он маршрутизирует:

```razor
@* .NET 11 -- Components/App.razor *@
<Routes @rendermode="InteractiveServer" />
<HeadOutlet @rendermode="InteractiveServer" />
```

Задание режима на самом корневом компоненте `App` не поддерживается. Именно поэтому глобальная интерактивность выражается через `Routes` и `HeadOutlet`, а не одной директивой наверху. Если вы переносите устаревшее приложение в эту модель, механика описана в статье [миграция приложения Blazor Server в Blazor Web App на .NET 11](/ru/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/).

Режим можно и вычислять, и именно так из в остальном интерактивного приложения вырезаются страницы со статическим SSR:

```razor
@* .NET 11 -- Components/App.razor *@
<Routes @rendermode="PageRenderMode" />

@code {
    private IComponentRenderMode? PageRenderMode => InteractiveServer;
}
```

## Правила наследования, определяющие, что получит ваш компонент

У большинства компонентов реального приложения нет никакого `@rendermode`. Они наследуют режим, и правил всего четыре:

1. Режим рендеринга по умолчанию -- Static.
2. Компонент без `@rendermode` принимает режим своего родителя.
3. Нельзя переключиться на другой интерактивный режим в дочернем компоненте. Компонент Interactive Server не может содержать дочерний компонент Interactive WebAssembly.
4. Параметры, передаваемые от статического родителя интерактивному потомку, должны сериализоваться в JSON.

Правило 2 объясняет, почему общий компонент, работающий на одной странице и мёртвый на другой, почти никогда не виноват сам. Положите это на страницу без режима, и кнопка ничего не сделает:

```razor
@* .NET 11 -- Components/SharedMessage.razor, render-mode agnostic *@
<button @onclick="UpdateMessage">Click me</button> @message

@code {
    private string message = "Not updated yet.";

    private void UpdateMessage() => message = "Somebody updated me!";
}
```

Поместите тот же компонент под `@rendermode InteractiveServer`, и он заработает. В самом компоненте ничего не изменилось. Правильный рефлекс при "моя кнопка ничего не делает" -- смотреть вверх по дереву, а не на обработчик.

Правило 3 вместо тишины даёт ошибку времени выполнения. Страница, закреплённая за Interactive Server, с дочерним компонентом WebAssembly падает с сообщением `Cannot create a component of type '...' because its render mode 'Microsoft.AspNetCore.Components.Web.InteractiveWebAssemblyRenderMode' is not supported by Interactive Server rendering.` Соседние компоненты с разными интерактивными режимами на статической странице допустимы, вложение одного в другой -- нет.

Правило 4 даёт самое запутанное сообщение. Передача дочернего содержимого через границу от статического к интерактивному выбрасывает:

> System.InvalidOperationException: Cannot pass the parameter 'ChildContent' to component 'SharedMessage' with rendermode 'InteractiveServerRenderMode'. This is because the parameter is of the delegate type 'Microsoft.AspNetCore.Components.RenderFragment', which is arbitrary code and cannot be serialized.

Интерактивный потомок статического родителя является корневым компонентом для собственного рендерера, и его параметры должны пересечь границу процесса (или сети) в виде JSON. `RenderFragment` -- это делегат, а делегат не сериализуется. Историческое решение сдвигает границу вверх: оберните потомка в компонент, не принимающий render fragment, и поставьте `@rendermode` на обёртку.

```razor
@* .NET 11 -- Components/WrapperComponent.razor *@
<SharedMessage>
    Child content
</SharedMessage>
```

```razor
@* .NET 11 -- the page *@
@page "/render-mode-10"

<WrapperComponent @rendermode="InteractiveServer" />
```

Именно поэтому шаблон поставляется с `Routes.razor`, оборачивающим `Router`, вместо того чтобы ставить `@rendermode` прямо на `Router`.

## Изменение в .NET 11: интерактивные макеты наконец работают

У правила 4 была хорошо известная жертва. `LayoutComponentBase` предоставляет `@Body` как `RenderFragment`, поэтому `@rendermode InteractiveServer` на `MainLayout` в приложении с постраничной интерактивностью выбрасывал ту же ошибку сериализации, но с именем параметра `'Body'`. Все обходные пути последних трёх мажорных версий сводились к варианту "положите интерактивность в обёртку или в секцию Blazor".

В .NET 11 это ограничение снято. Документация Microsoft теперь ограничивает весь раздел "Statically-rendered layout components" версиями `>= 8.0 < 11.0` и указывает, что он относится к периоду "prior to the release of .NET 11". Лежащая в основе работа -- [dotnet/aspnetcore#52768](https://github.com/dotnet/aspnetcore/issues/52768), выпущенная в .NET 11 Preview 5: когда компонент с режимом рендеринга получает параметр `RenderFragment`, фреймворк теперь вызывает фрагмент на статической стороне, сериализует полученное дерево рендеринга в JSON и восстанавливает его в делегат `RenderFragment` на интерактивной стороне. Чтобы это оставалось честным, компилятор требует, чтобы такие обёрнутые функции были статическими локальными функциями и не могли захватить состояние сервера, которое не пережило бы такую передачу.

Практический эффект: в .NET 11 вы можете написать

```razor
@* .NET 11 only -- Components/Layout/MainLayout.razor *@
@inherits LayoutComponentBase
@rendermode InteractiveServer

<div class="page">
    <NavMenu />
    <main>@Body</main>
</div>
```

и получить интерактивную панель навигации без плясок с обёрткой на секциях. В .NET 10 и более ранних версиях этот же файл падает во время выполнения. Уточняйте целевую версию фреймворка, прежде чем копировать фрагмент макета из интернета, потому что этот момент изменился на противоположный.

## Какой режим выполняет мой компонент прямо сейчас?

`ComponentBase` предоставляет для этого два свойства, оба доступны начиная с .NET 9. Ни одно из них не требует внедрения зависимостей.

`AssignedRenderMode` возвращает назначенный компоненту режим: экземпляр `InteractiveServerRenderMode`, `InteractiveWebAssemblyRenderMode` или `InteractiveAutoRenderMode`, либо `null`, когда компонент работает под статическим SSR.

`RendererInfo` описывает рендерер, который реально выполняет компонент. `RendererInfo.Name` принимает одно из значений `Static`, `Server`, `WebAssembly` или `WebView`. `RendererInfo.IsInteractive` равно `true` только тогда, когда компонент действительно интерактивен, и `false` как при статическом SSR, так и во время прохода предварительного рендеринга интерактивного компонента.

Последнее различие и есть полезное. Компонент с `@rendermode InteractiveServer` рендерится дважды: один раз при предварительном рендеринге, где `AssignedRenderMode` -- экземпляр `InteractiveServerRenderMode`, но `RendererInfo.IsInteractive` равно `false`, и второй раз через канал, где оба согласуются. Отсюда:

- Используйте `AssignedRenderMode is null`, чтобы спросить "станет ли этот компонент интерактивным вообще?" Это решение о форме разметки.
- Используйте `RendererInfo.IsInteractive`, чтобы спросить "могу ли я обрабатывать события прямо сейчас?" Это решение о текущем проходе.

Диагностический компонент, который можно положить в любое место дерева и увидеть, что унаследовало поддерево:

```razor
@* .NET 11 -- Components/RenderModeProbe.razor *@
<dl>
    <dt>AssignedRenderMode</dt>
    <dd>@(AssignedRenderMode?.GetType().Name ?? "null (static SSR)")</dd>
    <dt>RendererInfo.Name</dt>
    <dd>@RendererInfo.Name</dd>
    <dt>RendererInfo.IsInteractive</dt>
    <dd>@RendererInfo.IsInteractive</dd>
</dl>
```

Поскольку сам зонд не объявляет режим, он наследует его и сообщает ровно то, что передала вниз содержащая его страница. Это более быстрый ответ, чем чтение директив `@rendermode` вверх по дереву, особенно в приложении, где режимы назначаются программно.

Документированное применение `AssignedRenderMode` -- корректная деградация: рендерить настоящую HTML-форму `form`, когда компонент статический, и привязанные поля ввода с обработчиком события, когда нет.

```razor
@* .NET 11 *@
@if (AssignedRenderMode is null)
{
    <form action="/movies">
        <input type="text" name="titleFilter" />
        <input type="submit" value="Search" />
    </form>
}
else
{
    <input @bind="titleFilter" />
    <button @onclick="FilterMovies">Search</button>
}
```

А документированное применение `IsInteractive` -- отключение элементов управления, которые во время прохода предварительного рендеринга молча ничего не делали бы:

```razor
@* .NET 11 *@
<button @onclick="Send" disabled="@(!RendererInfo.IsInteractive)">
    Send
</button>
```

## Предварительный рендеринг и почему инициализатор выполняется дважды

Предварительный рендеринг включён по умолчанию для всех трёх интерактивных режимов. Сервер рендерит компонент статически в первоначальный HTML-ответ, затем эстафету принимает интерактивный рендерер и рендерит его снова. Поэтому `OnInitializedAsync` выполняется дважды, по одному разу на рендерер, и это настоящая причина жалоб "мой API вызывается дважды" и "интерфейс мигает обратно в состояние загрузки".

`OnAfterRender` и `OnAfterRenderAsync` -- исключение: во время предварительного рендеринга они не вызываются вовсе. По той же причине вызов JS-взаимодействия из `OnInitializedAsync` выбрасывает исключение, ведь браузера, к которому можно обратиться, ещё нет; подробно это разобрано в статье [JavaScript interop calls cannot be issued at this time](/ru/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/).

У вас есть два ответа. Отключить предварительный рендеринг для компонента:

```razor
@* .NET 11 -- component definition form *@
@rendermode @(new InteractiveServerRenderMode(prerender: false))
```

```razor
@* .NET 11 -- component instance form *@
<Dialog @rendermode="new InteractiveServerRenderMode(prerender: false)" />
```

Либо, что лучше для всего видимого пользователю, сохранить предварительный рендеринг и перенести состояние через границу с помощью атрибута `[PersistentState]` (`[SupplyParameterFromPersistentComponentState]` под старым именем; `PersistentStateAttribute` -- это API начиная с .NET 10):

```csharp
// .NET 11, C# 14
[PersistentState]
public int? CurrentCount { get; set; }
```

Полный разбор, включая `RestoreBehavior` и `AllowUpdates`, есть в статье [как сохранить состояние через границу статического и интерактивного рендеринга в Blazor на .NET 11](/ru/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/).

Одна ловушка на пути отключения: `prerender: false` действует только на режиме рендеринга верхнего уровня. Если родительский компонент уже объявил режим, настройка предварительного рендеринга у его потомков игнорируется полностью. Установить её на вложенном компоненте и увидеть, что предварительный рендеринг продолжается, -- это не баг.

## Статический SSR теряет не только интерактивность

При статическом SSR запрос обрабатывается конвейером middleware ASP.NET Core, и компоненты Razor во время этой обработки не рендерятся. Поэтому собственные возможности маршрутизатора Blazor не участвуют. В .NET 10 и .NET 11 содержимое `<NotAuthorized>` у `AuthorizeRouteView` не показывается на статически отрендеренных страницах; неавторизованные запросы обрабатывает middleware авторизации, обычно через собственный `IAuthorizationMiddlewareResultHandler`. До .NET 10 та же проблема была у содержимого `<NotFound>`. Приложение с интерактивностью на уровне корня с этим не сталкивается, потому что после первого статического рендеринга конвейер middleware больше не задействован.

.NET 11 также добавляет смежный с режимами рендеринга инструмент, о котором стоит знать: компонент `CacheView` кеширует отрендеренный вывод поддерева компонентов во время статического SSR и при попадании в кеш воспроизводит разметку, не создавая дочерние компоненты и не выполняя их методы жизненного цикла.

```razor
@* .NET 11 *@
<CacheView VaryByQuery="category" ExpiresAfter="TimeSpan.FromMinutes(5)">
    <ProductList Category="@Category" />
</CacheView>
```

Он применим только к статическому SSR, что даёт ещё одну причину оставлять страницы с контентом в режиме по умолчанию, а не делать интерактивным всё приложение по привычке.

## Коротко

Режим рендеринга -- это то, где выполняется компонент и может ли он обрабатывать события. Назначайте его на экземпляре, на определении или на `Routes` для всего приложения; всё, у чего директивы нет, наследует режим от родителя, а по умолчанию используется статический. Мёртвая кнопка означает, что надо смотреть вверх по дереву. Исключение сериализации означает, что `RenderFragment` пересёк границу от статического к интерактивному, к чему в .NET 10 и раньше относился любой интерактивный макет, а в .NET 11 уже нет. Двойной вызов API означает предварительный рендеринг, и решением гораздо чаще является `[PersistentState]`, а не `prerender: false`. Когда нужна точная картина, а не догадка, читайте `AssignedRenderMode` для назначения и `RendererInfo.IsInteractive` для текущего прохода и помните, что во время предварительного рендеринга они расходятся намеренно.

## Похожее

- [Blazor Server vs Blazor WebAssembly vs Blazor United в .NET 11](/ru/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/)
- [Миграция приложения Blazor Server в Blazor United (Blazor Web App) на .NET 11](/ru/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/)
- [Как сохранить состояние через границу статического и интерактивного рендеринга в Blazor на .NET 11](/ru/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/)
- [Fix: JavaScript interop calls cannot be issued at this time (предварительный рендеринг Blazor)](/ru/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/)
- [Fix: Attempting to reconnect to the server при разрыве канала Blazor Server](/ru/2026/08/fix-attempting-to-reconnect-to-the-server-after-a-blazor-circuit-disconnects/)

## Источники

- [ASP.NET Core Blazor render modes -- Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes?view=aspnetcore-11.0)
- [Prerender ASP.NET Core Razor components -- Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/prerender?view=aspnetcore-11.0)
- [ASP.NET Core Blazor layouts -- Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/layouts?view=aspnetcore-11.0)
- [Persist state across prerendering -- Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/blazor/state-management/prerendered-state-persistence?view=aspnetcore-11.0)
- [What's new in ASP.NET Core in .NET 11 -- Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-11)
- [Support serializing RenderFragment parameters -- dotnet/aspnetcore #52768](https://github.com/dotnet/aspnetcore/issues/52768)
- [ComponentBase.AssignedRenderMode Property -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.components.componentbase.assignedrendermode)
- [RendererInfo Struct -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.components.rendererinfo)
