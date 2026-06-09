---
title: "Исправление: render mode не поддерживается render mode родительского компонента (Blazor)"
description: "Вы поставили @rendermode на дочерний компонент, родитель которого уже интерактивен. У поддерева ровно один render mode. Уберите директиву или перенесите её на границу."
pubDate: 2026-06-09
template: error-page
tags:
  - "errors"
  - "blazor"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
lang: "ru"
translationOf: "2026/06/fix-render-mode-is-not-supported-by-the-parent-components-render-mode-blazor"
translatedBy: "claude"
translationDate: 2026-06-09
---

Исправление: вы применили `@rendermode` к дочернему компоненту, который находится внутри поддерева, уже имеющего интерактивный render mode, и эти два режима не совпадают. У поддерева Blazor ровно один render mode, зафиксированный на его интерактивной границе. Нельзя переключиться с `InteractiveServer` на `InteractiveWebAssembly` (или обратно) посреди дерева. Уберите директиву `@rendermode` с дочернего компонента, чтобы он унаследовал режим родителя, или поднимите render mode к единственному компоненту, который владеет интерактивной границей. Если режимы на самом деле одинаковы, реальная проблема в дублирующем `@rendermode` на вложенном компоненте, и вам следует удалить внутренний.

```text
System.InvalidOperationException: Cannot create a component of type
'BlazorSample.Components.SharedMessage' because its render mode
'Microsoft.AspNetCore.Components.Web.InteractiveWebAssemblyRenderMode'
is not supported by Interactive Server rendering.
   at Microsoft.AspNetCore.Components.Rendering.ComponentState..ctor(...)
   at Microsoft.AspNetCore.Components.RenderTree.Renderer.AddToRenderQueue(...)
   at Microsoft.AspNetCore.Components.Endpoints.EndpointHtmlRenderer...
```

Это руководство написано для .NET 11 (ASP.NET Core 11, `Microsoft.AspNetCore.Components` 11.0.0), но правило идентично с момента появления render modes в .NET 8. Текст сообщения варьируется в зависимости от того, какую комбинацию вы получили, поэтому поисковый трафик попадает сюда под несколькими формулировками: "its render mode is not supported by Interactive Server rendering", "render mode is not supported by the parent component's render mode" и тесно связанное "Cannot pass the parameter X to component Y with rendermode InteractiveServerRenderMode". Все три происходят из одного и того же базового ограничения, и у последнего другое исправление, рассмотренное ниже.

## Одно поддерево, один render mode

В Blazor Web App интерактивность не является переключателем на уровне отдельного компонента, который можно разбрасывать где угодно. Когда компонент объявляет `@rendermode InteractiveServer` или `@rendermode InteractiveWebAssembly`, он создаёт интерактивную *границу*. Всё, что отрисовывается внутри этой границы (каждый дочерний компонент, каждый потомок и содержимое, которое они отрисовывают), выполняется под этим одним render mode. Граница является корнем интерактивного *острова*, а у острова единая модель хостинга: либо SignalR-цепь на сервере, либо runtime WebAssembly в браузере. Нет механизма выполнять половину острова на сервере, а половину в браузере, потому что обе части разделяют живое дерево состояния компонентов и единый диспетчер.

Именно поэтому правила в официальной документации сформулированы как абсолютные. Из [документации по render modes Blazor](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes):

- Render modes распространяются вниз по иерархии компонентов.
- Render mode по умолчанию -- Static.
- Нельзя переключиться на другой интерактивный render mode в дочернем компоненте. Например, компонент Server не может быть дочерним для компонента WebAssembly.

Поэтому, когда рендерер обходит дерево, доходит до вашего дочернего компонента и находит `@rendermode`, конфликтующий с островом, в котором тот уже находится, он не может его выполнить. Он выбрасывает исключение вместо того, чтобы молча выбрать один. Исключение конструируется, когда фреймворк пытается создать состояние компонента для проблемного дочернего элемента, поэтому трассировка стека указывает на `ComponentState` и рендерер, а не на ваш код.

Полезная ментальная модель: `@rendermode` отвечает на вопрос "где начинается этот остров и что его хостит?". Это не свойство каждого компонента. Большинство компонентов не должны нести никакого render mode и просто наследовать тот остров, в который попали.

## Минимальное воспроизведение

Страница интерактивна на сервере и вкладывает компонент, который запрашивает WebAssembly:

```razor
@* RenderMode11.razor -- .NET 11, ASP.NET Core 11 -- throws at render time *@
@page "/render-mode-11"
@rendermode InteractiveServer

<h1>Dashboard</h1>

<SharedMessage @rendermode="InteractiveWebAssembly" />
```

Сам `SharedMessage` не зависит от render mode (он не объявляет собственный режим):

```razor
@* SharedMessage.razor -- .NET 11 *@
<p>@message</p>
<button @onclick="UpdateMessage">Update</button>

@code {
    private string message = "Not updated yet.";
    private void UpdateMessage() => message = "Updated!";
}
```

Перейдите на `/render-mode-11`, и страница не отрисовывается с ошибкой:

```text
Cannot create a component of type 'SharedMessage' because its render mode
'InteractiveWebAssemblyRenderMode' is not supported by Interactive Server rendering.
```

Родитель владеет серверным островом. Дочерний компонент потребовал WebAssembly-остров, вложенный внутрь. Такое вложение непредставимо, поэтому выбрасывается исключение.

## Исправление, по приоритету

**1. Уберите render mode с дочернего компонента (самое частое).** В девяти случаях из десяти у дочернего компонента вообще не должно было быть `@rendermode`. Он был скопирован из примера или добавлен на всякий случай, "чтобы сделать его интерактивным", тогда как на самом деле он наследует интерактивность от родителя бесплатно. Удалите директиву:

```razor
@* RenderMode11.razor -- fixed: child inherits the parent's server island *@
@page "/render-mode-11"
@rendermode InteractiveServer

<h1>Dashboard</h1>

<SharedMessage />
```

Теперь `SharedMessage` выполняется интерактивно через то же SignalR-соединение, что и родитель. Кнопка работает. Это поведение [наследования render mode](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes#render-mode-inheritance), описанное в документации: компонент, помещённый внутрь интерактивного родителя, принимает режим этого родителя.

**2. Сделайте оба режима согласованными.** Если вы действительно хотели здесь WebAssembly, то неправильным является *родитель*. Задайте всему острову WebAssembly на его границе и уберите директиву с дочернего компонента:

```razor
@* fixed: the whole island is WebAssembly *@
@page "/render-mode-11"
@rendermode InteractiveWebAssembly

<SharedMessage />
```

Помните, что WebAssembly-остров может жить только в клиентском проекте (том, имя которого заканчивается на `.Client`). Перенесите туда и страницу, и `SharedMessage`, иначе это исправление заменит одну ошибку на `Could not find any interactive components`.

**3. Разделите остров так, чтобы оба режима были соседями, а не вложенными.** Содержимое Server и WebAssembly может сосуществовать на одной странице, пока ни одно не находится *внутри* другого. Сделайте оба дочерними для статического родителя:

```razor
@* fixed: two sibling islands under a static page *@
@page "/render-mode-11"

@* no @rendermode here -- the page stays static SSR *@
<ServerWidget @rendermode="InteractiveServer" />
<WasmWidget @rendermode="InteractiveWebAssembly" />
```

Сама страница отрисовывается статически и хостит два независимых острова. Это правильный паттерн, когда одному виджету нужны только серверные службы (база данных, HTTP-cookies), а другому нужно работать офлайн в браузере. Ограничение касается только *вложения* несовпадающих режимов, а не наличия обоих на странице.

**4. Используйте `InteractiveAuto` на границе, а не посередине.** `InteractiveAuto` по-прежнему единый render mode для острова: он выбирает Server для первого визита и WebAssembly после того, как bundle закеширован. Вы задаёте его один раз, на границе, точно так же, как и два других. Он не позволяет смешивать режимы внутри поддерева.

## Двойник: "Cannot pass the parameter ... with rendermode"

Другая, но постоянно путаемая ошибка имеет почти тот же триггер. Когда интерактивный дочерний компонент находится под *статическим* родителем и вы передаёте ему `RenderFragment` (дочернее содержимое), вы получаете:

```text
System.InvalidOperationException: Cannot pass the parameter 'ChildContent' to
component 'SharedMessage' with rendermode 'InteractiveServerRenderMode'. This is
because the parameter is of the delegate type
'Microsoft.AspNetCore.Components.RenderFragment', which is arbitrary code and
cannot be serialized.
```

Здесь режимы не конфликтуют; *параметр* не может пересечь границу. Параметры, передаваемые от статического родителя интерактивному дочернему компоненту, должны быть сериализуемы в JSON, потому что статический сервер обязан сериализовать их в страницу, чтобы интерактивный runtime смог их регидрировать. `RenderFragment` -- это скомпилированный делегат (произвольный код), поэтому его нельзя маршалировать.

Исправление, которое использует сам фреймворк, -- это компонент-обёртка, который не принимает параметров и применяет render mode в собственном определении. Именно поэтому шаблон Blazor Web App оборачивает `Router` в компонент `Routes`:

```razor
@* WrapperComponent.razor -- holds the render mode, takes no serialized params *@
@rendermode InteractiveServer

<SharedMessage>
    <p>This child content is created inside the interactive island, not passed across it.</p>
</SharedMessage>
```

Поскольку `RenderFragment` теперь пишется *внутри* интерактивной границы, а не передаётся через неё, сериализовать нечего. Тот же приём решает вариант, на который вы натыкаетесь, пытаясь сделать интерактивным макет, наследующий от `LayoutComponentBase`, в приложении с интерактивностью на уровне страницы: оберните интерактивную часть, а не размечайте макет.

## Ловушки, ведущие к неверному исправлению

**Пометка компонента `App` или корневого как интерактивного.** Сделать корневой компонент, такой как `App`, интерактивным не поддерживается, поэтому нельзя задать общий для приложения render mode прямо на `App`. Шаблон задаёт его на `<Routes @rendermode="..." />` и `<HeadOutlet @rendermode="..." />`. Если поставить `@rendermode` на `App.razor`, вы увидите связанные ошибки границы; перенесите его вниз, на `Routes`.

**Render mode `null` -- это не "статический".** Передача `@rendermode="@некаяNullПеременная"` не форсирует статическую отрисовку. Render mode `null` означает "наследовать от родителя". Если родитель интерактивен, дочерний компонент с `null` остаётся интерактивным. Единственная причина, по которой [паттерн статических SSR-страниц](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes#static-ssr-pages-in-an-interactive-app) работает с режимом `null`, в том, что его родитель (`App`) изначально статичен.

**Глобальная интерактивность скрывает директиву.** Если вы приняли глобальную интерактивность, задав режим на `Routes`, каждая страница наследует его. Добавление *второго* `@rendermode` к странице или компоненту теперь в лучшем случае избыточно, а в худшем -- конфликтно. Найдите случайные директивы `@rendermode` в проекте, прежде чем считать, что фреймворк ошибается.

**Определение компонента против экземпляра компонента.** Применить `@rendermode` можно двумя способами: на *экземпляре* компонента (`<SharedMessage @rendermode="InteractiveServer" />`) или на *определении* компонента (`@rendermode InteractiveServer` в начале `SharedMessage.razor`, через форму атрибута). Режим, встроенный в определение, срабатывает везде, где используется компонент, в том числе внутри острова, у которого уже другой режим. Если вы не можете найти проблемную директиву экземпляра, проверьте сам файл `.razor` дочернего компонента на наличие директивы уровня определения.

Общая нить всех вариантов: решите, где начинается каждый интерактивный остров, задайте режим один раз на этой границе и позвольте всему внутри наследовать его. Рендерер выбрасывает исключение именно потому, что вы попытались перерисовать границу посреди поддерева, у которого она уже была.

## Связанное

- [Как сохранить состояние через границу отрисовки от статической к интерактивной в Blazor на .NET 11](/ru/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/) рассматривает сторону данных той же границы, которую охраняет эта ошибка.
- [Blazor Server vs Blazor WebAssembly vs Blazor United в .NET 11](/ru/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) объясняет, какую модель хостинга выбирает каждый render mode и когда что брать.
- [Миграция приложения Blazor Server на Blazor United в .NET 11](/ru/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/) шаг за шагом показывает, как ввести render modes в приложение, где их никогда не было.
- [Как разделить логику валидации между сервером и Blazor WebAssembly](/ru/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) -- это паттерн, который вам нужен, когда соседним островам требуются одни и те же правила.
- [Blazor SSR наконец получает TempData в .NET 11](/ru/2026/04/blazor-ssr-tempdata-dotnet-11/) полезен, когда статической SSR-странице в остальном интерактивного приложения нужно передать данные через полную перезагрузку страницы.

## Источники

- [ASP.NET Core Blazor render modes -- Render mode propagation and inheritance](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes), Microsoft Learn (aspnetcore-11.0).
- [ASP.NET Core Blazor render modes -- Child component with a different render mode than its parent](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes#render-mode-propagation), Microsoft Learn.
- [dotnet/aspnetcore #55319 -- Blazor component cannot be nested inside a parent using a render fragment if the nested component is interactive](https://github.com/dotnet/aspnetcore/issues/55319).
</content>
