---
title: "Как отрендерить заголовок, уровень которого (h1-h6) выбирается во время выполнения, в компоненте Blazor"
description: "В Razor нет синтаксиса для переменного имени тега, а DynamicComponent рендерит только типы компонентов. Переопределите BuildRenderTree и вызовите builder.OpenElement(0, $\"h{level}\"). Разбираются проброс атрибутов, почему имя тега нужно ограничивать до того, как оно попадёт в DOM, почему смена уровня вырывает элемент из DOM даже с @key, и вариант с автоматическим уровнем на каскадном значении."
pubDate: 2026-08-27
template: how-to
tags:
  - "dotnet"
  - "csharp"
  - "aspnetcore"
  - "how-to"
lang: "ru"
translationOf: "2026/08/how-to-render-a-heading-with-a-runtime-chosen-level-in-blazor"
translatedBy: "claude"
translationDate: 2026-08-27
---

Razor не позволяет написать `<h@Level>`, а `<DynamicComponent>` здесь не поможет, поскольку его параметр `Type` обязан реализовывать `IComponent`. Решение состоит в том, чтобы спуститься до `RenderTreeBuilder` и построить элемент самостоятельно: переопределить `BuildRenderTree` и вызвать `builder.OpenElement(0, $"h{level}")` с уровнем, который вы уже ограничили диапазоном от 1 до 6. Всё изложенное ниже проверено на .NET 10 (SDK 10.0.201, `Microsoft.AspNetCore.App` 10.0.5); в предварительных версиях .NET 11 эти API не изменились.

## Почему два очевидных подхода не работают

Первое, что приходит в голову, это `<DynamicComponent Type="...">`. Здесь он неприменим. Документация описывает его как способ "рендерить компоненты по типу", и среда выполнения это требование обеспечивает. Передача имени элемента или любого типа, не являющегося компонентом, приводит к исключению ещё до того, как что-либо будет отрендерено:

```text
System.ArgumentException: The component type must implement Microsoft.AspNetCore.Components.IComponent.
```

Аналога для HTML-элементов не существует. `DynamicComponent` предназначен для выбора между `RocketLab.razor` и `SpaceX.razor`, а не между `h2` и `h3`.

Второй порыв состоит в том, чтобы разбить тег на два значения `MarkupString`:

```csharp
// .NET 10. Renders correctly in static SSR and breaks interactively.
builder.AddContent(0, (MarkupString)$"<h{Level}>");
builder.AddContent(1, ChildContent);
builder.AddContent(2, (MarkupString)$"</h{Level}>");
```

Это та ловушка, в которой стоит разобраться, потому что внешне она выглядит рабочей. При рендеринге через `HtmlRenderer` для статического серверного рендеринга вывод получается совершенно правильным:

```html
<h3>Release notes</h3>
```

Так происходит лишь потому, что статический SSR склеивает фреймы в строку. Осмотр дерева рендеринга показывает, что было создано на самом деле: три независимых соседних фрейма, а не элемент с потомком.

```text
PrependFrame @sibling 0 frame=[Markup "<h3>"]
PrependFrame @sibling 1 frame=[Text "Release notes"]
PrependFrame @sibling 2 frame=[Markup "</h3>"]
```

В Blazor Server или WebAssembly клиент обходит эти фреймы и вызывает `insertMarkup` по одному разу на каждый фрейм разметки, а [`insertMarkup` разбирает содержимое каждого фрейма по отдельности](https://github.com/dotnet/aspnetcore/blob/main/src/Components/Web.JS/src/Rendering/BrowserRenderer.ts), прежде чем вставить полученные узлы. Парсер браузера превращает одиночную строку `<h3>` в пустой элемент `<h3></h3>`, а одиночную строку `</h3>` не превращает ни во что. Ваш текст оказывается соседом *после* пустого заголовка. Компонент проходит быструю проверку под статическим SSR и выдаёт сломанную, недоступную для скринридеров разметку, как только режим рендеринга становится интерактивным.

Конструкция `@switch` с шестью жёстко заданными ветками действительно работает. Просто это шесть копий каждого атрибута, каждого CSS-класса и дочернего содержимого, и всё это придётся вечно держать в согласованном состоянии. Для одного компонента терпимо, для дизайн-системы с заголовками, подписями и названиями разделов уже нет.

## Шаги: построить компонент Heading, который сам выбирает тег

1. Создайте обычный файл `.cs`, а не файл `.razor`. Компонент Razor уже генерирует метод `BuildRenderTree`, поэтому объявление собственного метода в блоке `@code` приводит к `CS0111: Type 'Heading' already defines a member called 'BuildRenderTree' with the same parameter types`.
2. Унаследуйтесь от `ComponentBase` и добавьте параметр `int Level`, параметр `RenderFragment? ChildContent` и словарь `AdditionalAttributes`, помеченный атрибутом `[Parameter(CaptureUnmatchedValues = true)]`, чтобы вызывающая сторона по-прежнему могла передавать `class`, `id` и атрибуты `data-`.
3. Переопределите `BuildRenderTree` и ограничьте уровень вызовом `Math.Clamp(Level, 1, 6)` до того, как подставите его в имя тега. Это ограничение является мерой безопасности, а не удобством.
4. Вызовите `builder.OpenElement(0, $"h{level}")`, затем `builder.AddMultipleAttributes(1, AdditionalAttributes)`, затем `builder.AddContent(2, ChildContent)` и в конце `builder.CloseElement()`.
5. Каждый порядковый номер задавайте целочисленным литералом. Не используйте переменную-счётчик, даже если она выглядит безобидно.

## Компонент целиком

```csharp
// Heading.cs -- .NET 10, C# 14
using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Rendering;

public class Heading : ComponentBase
{
    [Parameter] public int Level { get; set; } = 2;
    [Parameter] public RenderFragment? ChildContent { get; set; }

    [Parameter(CaptureUnmatchedValues = true)]
    public IReadOnlyDictionary<string, object>? AdditionalAttributes { get; set; }

    protected override void BuildRenderTree(RenderTreeBuilder builder)
    {
        var level = Math.Clamp(Level, 1, 6);

        builder.OpenElement(0, $"h{level}");
        builder.AddMultipleAttributes(1, AdditionalAttributes);
        builder.AddContent(2, ChildContent);
        builder.CloseElement();
    }
}
```

Используется он точно так же, как любой другой компонент:

```razor
@* .NET 10 *@
<Heading Level="SectionDepth" class="title" id="release-notes">
    Release notes
</Heading>
```

При рендеринге через `HtmlRenderer` результат получается таким, какой вы написали бы вручную:

```text
Level= 1 -> <h1 class="title" id="s1">Release notes</h1>
Level= 3 -> <h3 class="title" id="s1">Release notes</h3>
Level= 6 -> <h6 class="title" id="s1">Release notes</h6>
Level= 9 -> <h6 class="title" id="s1">Release notes</h6>
Level=-4 -> <h1 class="title" id="s1">Release notes</h1>
```

Обратите внимание, что `AddMultipleAttributes` идёт до `AddContent`. Все фреймы атрибутов элемента должны быть добавлены до любого дочернего содержимого; их чередование приводит к исключению во время рендеринга.

## Как оставить всё в файле .razor

Если уходить из Razor не хочется, это возможно, при условии что вы не переопределяете `BuildRenderTree`. Вынесите логику построителя в свойство типа `RenderFragment` и отрендерите его как всё тело компонента:

```razor
@* Heading.razor -- .NET 10 *@
@Rendered

@code {
    [Parameter] public int Level { get; set; } = 2;
    [Parameter] public RenderFragment? ChildContent { get; set; }

    [Parameter(CaptureUnmatchedValues = true)]
    public IReadOnlyDictionary<string, object>? AdditionalAttributes { get; set; }

    private RenderFragment Rendered => builder =>
    {
        builder.OpenElement(0, $"h{Math.Clamp(Level, 1, 6)}");
        builder.AddMultipleAttributes(1, AdditionalAttributes);
        builder.AddContent(2, ChildContent);
        builder.CloseElement();
    };
}
```

Это компилируется без ошибок и выдаёт `<h4 class="title">Release notes</h4>` без лишних текстовых узлов вокруг, поскольку выражение `@Rendered` является единственной разметкой компонента. Сгенерированный `BuildRenderTree` просто вызывает ваш фрагмент. Выбирайте тот тип файла, который ваша команда чаще ищет; дерево рендеринга получается одинаковым.

## Имя тега попадает в DOM дословно

Ограничение из третьего шага чаще всего пропускают, и именно оно имеет значение. `OpenElement` не проверяет и не экранирует свой аргумент `elementName`. Переданная строка записывается в вывод как имя тега. Вот компонент с непроверяемым параметром `string Level`, отрендеренный с тремя разными входными значениями:

```text
Level="2"                          -> <h2>hi</h2>
Level="2 onload=alert(1)"          -> <h2 onload=alert(1)>hi</h2 onload=alert(1)>
Level="2><script>alert(1)</script" -> <h2><script>alert(1)</script>hi</h2><script>alert(1)</script>
```

Это тег script на вашей странице, пришедший из параметра компонента. Автоматическое кодирование в Blazor защищает текст и *значения* атрибутов; имя тега оно не защищает, потому что имя тега никогда не предполагается пользовательскими данными. Собственное руководство Microsoft по `RenderTreeBuilder` говорит ровно об этом: некорректно сформированный компонент "может привести к неопределённому поведению", включая "скомпрометированную безопасность".

Поэтому никогда не допускайте, чтобы недоверенное или просто непроверенное значение доходило до `OpenElement`. Принимайте `int`, а не `string`, ограничивайте его, а если ваш API действительно требует строку, проверяйте её по белому списку из шести имён заголовков, а не подставляйте напрямую.

## Смена уровня уничтожает и пересоздаёт элемент

Алгоритм сравнения в Blazor сопоставляет фреймы по порядковому номеру и типу фрейма. Два фрейма элементов с одинаковым порядковым номером, но *разными* именами тегов, не являются одним и тем же элементом, поэтому старый удаляется, а новый вставляется. Захват пакета рендеринга при переходе `Level` с 2 на 3 показывает именно это:

```text
after Level 2 -> 3:
  RemoveFrame @sibling 0 frame=[Element h3]
  PrependFrame @sibling 0 frame=[Element h3]
```

Сравните с изменением одного лишь атрибута `class`, которое применяется на месте:

```text
after class change only:
  SetAttribute @sibling 0 frame=[Attribute class=subtitle]
```

Практическое следствие: заголовок, меняющий уровень, теряет свой узел DOM. Фокус внутри него сбрасывается, любая захваченная `ElementReference` устаревает, CSS-переходы запускаются заново, а сторонний скрипт, привязавшийся к этому узлу, теперь привязан к осиротевшему элементу. Добавление `@key` положения не спасает. Ключи позволяют алгоритму сопоставлять элементы при их перестановке; они не делают два разных имени тега одним и тем же элементом. Версия с ключом выдаёт побайтово тот же самый скрипт правок:

```text
keyed, Level 2 -> 3:
  RemoveFrame @sibling 0 frame=[Element h3]
  PrependFrame @sibling 0 frame=[Element h3]
```

Проблемой это становится редко, поскольку уровень заголовка обычно фиксирован на всё время жизни раздела. Проблема возникает, когда уровень выводится из чего-то часто меняющегося, например из сворачиваемого оглавления, которое перенумеровывается по мере раскрытия узлов пользователем. Если вы столкнулись с этим, оставьте уровень неизменным и меняйте вместо него оформление.

## Порядковые номера остаются литералами, в том числе в разных ветках

Это правило нарушить проще всего, как только появляется второй путь исполнения. Возникает соблазн написать `var seq = 0;` и использовать `seq++` повсюду, особенно в компоненте с `if`/`else`. Так делать не следует. Документация Microsoft высказывается прямо: "производительность приложения страдает, если порядковые номера генерируются динамически", потому что счётчик стирает ту информацию, по которой алгоритм сравнения распознаёт, в какой ветке вы находились. Результатом становятся более длинные скрипты правок, а во вложенных структурах ещё и заметно более глубокая рекурсия при сравнении.

Правильный шаблон это то, что генерирует сам компилятор Razor: литеральные числа, возрастающие в порядке *исходного кода*, причём каждая ветка владеет собственным диапазоном.

```csharp
// AutoHeading.cs -- .NET 10, C# 14
protected override void BuildRenderTree(RenderTreeBuilder builder)
{
    var level = Ambient?.Value ?? 1;

    if (level <= 6)
    {
        builder.OpenElement(0, $"h{level}");
        builder.AddMultipleAttributes(1, AdditionalAttributes);
        builder.AddContent(2, ChildContent);
        builder.CloseElement();
    }
    else
    {
        builder.OpenElement(3, "div");
        builder.AddAttribute(4, "role", "heading");
        builder.AddAttribute(5, "aria-level", level);
        builder.AddMultipleAttributes(6, AdditionalAttributes);
        builder.AddContent(7, ChildContent);
        builder.CloseElement();
    }
}
```

Если компонент разрастается больше чем на экран вызовов построителя, оберните его части в `OpenRegion`/`CloseRegion`. Каждая область получает собственное пространство порядковых номеров, так что внутри неё можно начинать с нуля, не сбивая алгоритм сравнения.

## Автоматический уровень через каскадное значение

Приведённый выше вариант намекает на более полезную форму этого компонента. Вместо того чтобы заставлять каждого вызывающего передавать правильное число, позвольте заголовку считывать свою глубину из контекста. Небольшое каскадное значение переносит текущий уровень, а любой компонент, открывающий вложенный раздел, передаёт вниз следующий:

```csharp
// HeadingLevel.cs -- .NET 10, C# 14
public sealed class HeadingLevel
{
    public int Value { get; init; } = 1;
    public HeadingLevel Next() => new() { Value = Value + 1 };
}
```

```razor
@* Section.razor -- .NET 10 *@
<CascadingValue Value="_child" IsFixed="true">
    <section>@ChildContent</section>
</CascadingValue>

@code {
    [CascadingParameter] public HeadingLevel? Ambient { get; set; }
    [Parameter] public RenderFragment? ChildContent { get; set; }

    private HeadingLevel _child = default!;

    protected override void OnParametersSet()
        => _child = (Ambient ?? new HeadingLevel()).Next();
}
```

Тогда `AutoHeading` вообще не принимает параметр `Level`. Компонент карточки, помещённый на три раздела вглубь, отрендерит `h4`, ничего не зная о том, где его использовали, и именно это свойство делает переиспользуемые компоненты композируемыми. Указывайте `IsFixed="true"` у `CascadingValue`, когда уровень не может измениться после рендеринга раздела; это позволяет Blazor не подписывать каждого потомка на уведомления об изменениях.

## Что делать за пределами h6

HTML заканчивается на `h6`, а глубоко вложенное оглавление нет. Вместо того чтобы молча обрезать уровень и выдавать три соседних элемента `h6`, которые вспомогательные технологии читают как равноправные, используйте эквивалент из ARIA. Сочетание `role="heading"` и `aria-level` выражает любую глубину:

```text
ambient=2 -> <h2 class="title">Release notes</h2>
ambient=6 -> <h6 class="title">Release notes</h6>
ambient=7 -> <div role="heading" aria-level="7" class="title">Release notes</div>
```

Нативные элементы остаются лучшим выбором там, где они существуют, поэтому используйте настоящие теги `h1`-`h6` для уровней с первого по шестой, а запасной вариант с ARIA приберегите для случая переполнения. На практике потребность в седьмом уровне обычно означает, что структуру страницы стоит сделать более плоской, так что имеет смысл логировать предупреждение в режиме разработки при срабатывании этого запасного пути.

Последнее замечание о самих типах дерева рендеринга: документация помечает всё, что находится в пространстве имён `Microsoft.AspNetCore.Components.RenderTree`, как нестабильные внутренние детали фреймворка. `RenderTreeBuilder` и `ComponentBase.BuildRenderTree` являются публичным поддерживаемым API, и использовать их безопасно. Чтение `RenderBatch` и `RenderTreeEdit`, как я делал выше для захвата вывода сравнения, годится для диагностики, но не для production-кода.

## Похожие материалы

- Разрешение тегов компилятором Razor и есть причина, по которой переменное имя тега изначально невозможно, и оно же стоит за ошибкой в статье [Обнаружен элемент разметки с неожиданным именем в Blazor](/ru/2026/05/fix-rz10012-found-markup-element-with-unexpected-name-blazor/).
- Код компонента, обращающийся к DOM, обязан учитывать границу режима рендеринга, о чём рассказано в статье [Вызовы взаимодействия с JavaScript сейчас невозможны](/ru/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/).
- То же стремление обойтись без JS там, где фреймворк справляется сам, применимо и к [загрузке файла из компонента Blazor без взаимодействия с JavaScript](/ru/2026/08/how-to-download-a-file-from-a-blazor-component-without-javascript-interop/).
- Если пересоздание заголовка теряет важное для вас состояние, механизм описан в статье [Сохранение состояния при переходе границы между статическим и интерактивным рендерингом](/ru/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/).
- Выбранный режим рендеринга определяет, достижима ли вообще описанная выше ошибка с `MarkupString`; смотрите [Blazor Server vs WebAssembly vs United](/ru/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/).

## Источники

- [Расширенные сценарии Blazor в ASP.NET Core (построение дерева рендеринга)](https://learn.microsoft.com/en-us/aspnet/core/blazor/advanced-scenarios?view=aspnetcore-10.0), включая рекомендации по порядковым номерам и предупреждение о безопасности при некорректно сформированных компонентах.
- [Динамически рендеримые компоненты Razor в ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/dynamiccomponent?view=aspnetcore-10.0) о контракте `DynamicComponent`.
- [Справочник по API `RenderTreeBuilder.OpenElement`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.components.rendering.rendertreebuilder.openelement).
- [`BrowserRenderer.ts` в dotnet/aspnetcore](https://github.com/dotnet/aspnetcore/blob/main/src/Components/Web.JS/src/Rendering/BrowserRenderer.ts) о том, как фреймы разметки разбираются и вставляются на клиенте.
