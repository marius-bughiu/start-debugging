---
title: "Fix: RZ10012: Found markup element with unexpected name в Blazor"
description: "Компилятор Razor в Blazor выдаёт RZ10012, когда тег в PascalCase не связан с типом компонента в области видимости. Добавьте @using для пространства имён компонента в _Imports.razor или @namespace в самом компоненте, затем пересоберите проект."
pubDate: 2026-05-12
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "blazor"
  - "razor"
lang: "ru"
translationOf: "2026/05/fix-rz10012-found-markup-element-with-unexpected-name-blazor"
translatedBy: "claude"
translationDate: 2026-05-12
---

Решение: компилятор Razor увидел тег в PascalCase (например, `<NavMenu />` или `<MudButton />`) и не смог связать его с типом компонента, находящимся в области видимости этого файла. Добавьте `@using <namespace>` либо в родительский файл `.razor`, либо в `_Imports.razor`, который его покрывает, и пересоберите. Если компонент находится в Razor Class Library (RCL), структура папок которой не соответствует пространству имён, добавьте также `@namespace <FullNamespace>` в файл `.razor` компонента. Удалите `bin/`, `obj/` и `.vs/`, если предупреждение остаётся в IDE после чистой сборки.

```text
RZ10012: Found markup element with unexpected name 'NavMenu'.
If this is intended to be a component, add a @using directive for its namespace.
```

Это руководство написано для .NET 11 preview 4, Razor SDK, входящего в `Microsoft.AspNetCore.App` 11.0.0-preview.4, и Visual Studio 17.13. Идентификатор диагностики `RZ10012` и точная формулировка стабильны с .NET Core 3.1, поэтому приведённые ниже решения применимы без изменений к .NET 6, 7, 8, 10 и 11. Blazor Server, Blazor WebAssembly, Blazor United и Razor Class Libraries все выдают это сообщение из одного и того же прохода компилятора.

RZ10012 по умолчанию является **предупреждением компилятора**, а не ошибкой. Проект продолжает собираться. Если тег действительно задумывался как компонент и вы выкатываете без исправления, во время выполнения тег рендерится как **сырой HTML** (элемент `<NavMenu></NavMenu>` без потомков), обработчики клика никогда не подключаются, а параметры молча исчезают. Поэтому остаток этого поста рассматривает предупреждение как ошибку, которую стоит блокировать на сборке.

## Почему компилятор Razor считает ваш тег "unexpected"

Компилятор Razor классифицирует каждый элемент в файле `.razor` по одному правилу: тег, имя которого начинается с **заглавной ASCII-буквы**, является ссылкой на компонент; всё остальное — это HTML. Когда он видит `<NavMenu />`, он проходит по таблице **дескрипторов tag helper** для текущего файла, ища тип компонента, чьё короткое имя совпадает и чьё пространство имён импортировано директивой `@using`, применимой к этому файлу.

Если ни один дескриптор не совпадает, у компилятора два пути: считать это HTML и выдать предупреждение, чтобы человек поправил, или провалить сборку. Дизайнеры выбрали первый, поэтому RZ10012 — это предупреждение. Таблица дескрипторов наполняется из трёх источников, в таком порядке:

1. **Директивы `@using` в самом файле.** Лексическая область видимости, только файл, где они объявлены.
2. **Файлы `_Imports.razor`**, применяемые **снизу вверх по папкам**. `_Imports.razor` рядом с файлом применяется первым, затем тот, что в родительской папке, и так далее до корня проекта.
3. **Общепроектные импорты**, которые подставляет SDK: `Microsoft.AspNetCore.Components`, `Microsoft.AspNetCore.Components.Web` и ещё несколько. Поэтому вам не нужно вручную импортировать `<EditForm>`.

Учтите, что `_Imports.razor` **не транзитивен между проектами**. `_Imports.razor` внутри Razor Class Library не переносится в потребляющее приложение. Собственный `_Imports.razor` потребителя (или сама страница) должен объявить `@using MyRcl`, чтобы `<MyRclComponent />` связался.

## Минимальный файл, воспроизводящий проблему

Самое маленькое воспроизведение — два файла в одном проекте:

```razor
@* .NET 11 preview 4, Razor SDK 11.0.0-preview.4 *@
@* File: Components/Pages/Home.razor *@

<h1>Home</h1>
<NavMenu />
```

```razor
@* File: Components/Layout/NavMenu.razor *@

<nav>Navigation here</nav>
```

`NavMenu` находится в `MyApp.Components.Layout`. `Home.razor` находится в `MyApp.Components.Pages`. Ни в одном из файлов нет `@using` для `MyApp.Components.Layout`, и нет `_Imports.razor`, который их связал бы. Сборка:

```text
Components\Pages\Home.razor(3,2): warning RZ10012: Found markup element with unexpected name 'NavMenu'. If this is intended to be a component, add a @using directive for its namespace.
```

Во время выполнения страница рендерит `<navmenu></navmenu>` как буквальный HTML-тег.

## Четыре решения, по приоритету

Применяйте их в этом порядке. Остановитесь на первом, которое решит ваш случай.

### 1. Добавьте `@using` в ближайший `_Imports.razor`

Это каноническое решение и то, на которое указывает сам текст предупреждения. Положите одну строку в `_Imports.razor`, покрывающий ваше дерево компонентов:

```razor
@* File: Components/_Imports.razor *@
@using MyApp.Components.Layout
@using MyApp.Components.Shared
```

Если `_Imports.razor` для папки ещё не существует, создайте его. Стандартный шаблон `dotnet new blazor` кладёт один в `Components/_Imports.razor` с типовыми using-ами уже подключёнными.

Это работает, потому что Razor SDK подаёт компилятору каждый `_Imports.razor` между корнем проекта и текущим файлом так, будто его директивы стоят в начале текущего файла. Добавленный сюда using распространяется на каждый `.razor` в этой папке или ниже, включая layout-ы, страницы и партиалы.

### 2. Добавьте `@using` прямо в потребляющий файл `.razor`

Когда компонент используется ровно из одного файла и вы хотите ограничить загрязнение пространств имён, объявите using прямо в файле:

```razor
@* File: Components/Pages/Home.razor *@
@using MyApp.Components.Layout

<h1>Home</h1>
<NavMenu />
```

Механически идентично решению 1, просто с меньшей областью. Полезно, когда две папки определяют компоненты с одним коротким именем, а вам нужно разрешение неоднозначности только в одном месте.

### 3. Добавьте `@namespace` в компонент (сценарий Razor Class Library)

Когда компонент живёт в RCL, автогенерируемое пространство имён выводится из `RootNamespace` плюс пути файла относительно файла проекта RCL. Если `RootNamespace` RCL не совпадает с её фактическим пространством имён или файл лежит в папке, имя которой компилятор C# не принимает буквально (цифры, дефисы), сгенерированное пространство имён не совпадёт с тем, что импортирует потребитель. Добавьте `@namespace`, чтобы устранить расхождение в источнике:

```razor
@* File: src/MyRcl/Components/Button.razor *@
@namespace MyRcl.Components

<button class="my-rcl-button" @onclick="OnClick">@ChildContent</button>

@code {
    [Parameter] public RenderFragment? ChildContent { get; set; }
    [Parameter] public EventCallback OnClick { get; set; }
}
```

Теперь потребитель может написать `@using MyRcl.Components` и получить чистое связывание. Без `@namespace` Razor сгенерировал бы `MyRcl.src.MyRcl.Components` или `Some.RootNamespace.src.MyRcl.Components` в зависимости от устройства RCL, и ваш `@using` молча не нашёл бы тип.

Также можно задать `RootNamespace` в `.csproj` RCL, чтобы полностью обойти именование на основе папок:

```xml
<!-- src/MyRcl/MyRcl.csproj -->
<PropertyGroup>
  <RootNamespace>MyRcl</RootNamespace>
</PropertyGroup>
```

### 4. Очистите кэш IDE, когда предупреждение остаётся после чистой сборки

Языковая служба Razor в Visual Studio кэширует дескрипторы tag helper по проекту. После добавления ссылки на проект или переименования пространства имён кэш может продолжать сообщать RZ10012, даже если `dotnet build` из свежего `obj/` чист. Надёжный сброс:

```powershell
# Close Visual Studio first, then from the solution root:
Remove-Item -Recurse -Force .vs, **/bin, **/obj
dotnet build
```

Откройте решение заново. Первая сборка IntelliSense заполнит кэш дескрипторов состоянием после исправления. В JetBrains Rider аналог — **File > Invalidate Caches**.

## Сделайте так, чтобы предупреждение проваливало сборку

Уровень по умолчанию выпускает сборки, рендерящие сломанные страницы. Два способа поднять его:

**Точечно (рекомендуется):** считать ошибкой только RZ10012.

```xml
<!-- MyApp.csproj, .NET 11 preview 4 -->
<PropertyGroup>
  <WarningsAsErrors>$(WarningsAsErrors);RZ10012</WarningsAsErrors>
</PropertyGroup>
```

Префикс `$(WarningsAsErrors);` сохраняет то, что SDK уже повысил, что важно, потому что новые SDK .NET со временем добавляют записи в этот список.

**Сплошное:** считать ошибками все предупреждения. В целом более здоровая дисциплина, но заставляет гоняться за каждым другим предупреждением, которое SDK когда-либо выдавал, что для большинства команд — больше уборки, чем хочется ради одного исправления.

```xml
<PropertyGroup>
  <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
</PropertyGroup>
```

В любом случае, отсутствующий `@using` теперь останавливает сборку, а не просачивается в QA в виде тикета "кнопка ничего не делает".

## Часто путаемые варианты, попадающие сюда по ошибке

**Имя тега в нижнем регистре.** `<navMenu />` не вызывает RZ10012, потому что первая буква строчная, и Razor классифицирует это как HTML. Если ваш компонент рендерится как буквальная разметка, а предупреждения **нет**, у вас ошибка регистра, а не пространства имён. Переименуйте тег в PascalCase.

**`@inherits`, маскирующий компонент.** В .NET 7.0.302 и ранее есть известная проблема ([dotnet/razor#8800](https://github.com/dotnet/razor/issues/8800)), когда добавление `@inherits MyBase` в компонент приводило к тому, что компилятор терял "компонентность" и выдавал RZ10012 везде, где компонент использовался. Исправлено в .NET 8. Если вы всё ещё на .NET 7 и не можете обновиться, обходите через наследование в `@code { protected partial class ... }` вместо директивы.

**Сторонняя библиотека компонентов не зарегистрирована.** При использовании MudBlazor, Radzen, Telerik или Syncfusion библиотека поставляет фрагмент `_Imports.razor`, который нужно вставить в ваш. Пропуск означает, что каждый `<MudButton />` загорается RZ10012. На странице "getting started" вендора есть точный список (MudBlazor требует `@using MudBlazor`, Radzen — `@using Radzen` и `@using Radzen.Blazor` и т. д.).

**Generic-компонент с параметром типа.** `<MyList T="string" />` всё равно выдаст предупреждение, если `MyList<T>` не в области видимости. Атрибут `T="..."` не импортирует пространство имён; правило `@using` применяется так же.

**Ложноположительное срабатывание редактора в VS 17.4.x.** [dotnet/razor#8146](https://github.com/dotnet/razor/issues/8146) отслеживает серию ложных срабатываний в ранних релизах VS 2022. Если сборка чиста, а только IDE отмечает RZ10012, обновите VS до 17.6 или новее и очистите `.vs/`, как в решении 4.

**Компонент в ссылочном проекте, нацеленном на другой фреймворк.** Razor Class Library, нацеленная на `net6.0` и потребляемая приложением `net11.0`, может не показать свои компоненты, если у RCL нет `<UseRazorSourceGenerator>true</UseRazorSourceGenerator>` или у неё устаревшая ссылка на SDK. Обновите `<PackageReference>` RCL на `Microsoft.AspNetCore.App` 11 и пересоберите.

## Чек-лист на 30 секунд

Когда RZ10012 прилетает в CI, а у вас рейс, пройдитесь по этому списку сверху вниз:

1. Тег в PascalCase? Если в нижнем регистре — переименуйте.
2. Компонент в **этом** проекте? Если да, `@using` его пространства имён в ближайший `_Imports.razor`.
3. Компонент в RCL? Проверьте, что у RCL есть `@namespace`, совпадающий с импортом, и что потребитель ссылается на пакет или проект RCL.
4. Сторонняя библиотека? Вставьте фрагмент вендора в `_Imports.razor`.
5. Всё ещё предупреждает после чистой сборки? Удалите `.vs/`, `bin/`, `obj/` и пересоберите.
6. Хотите, чтобы это валило CI? Добавьте `RZ10012` в `<WarningsAsErrors>`.

Девяносто процентов случаев — это пункт 2 или 4. Остальное — водопроводные работы с пространствами имён.

## Связанное

- [Fix: The type or namespace name could not be found after a project reference](/ru/2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference/) покрывает C#-сторону того же семейства сбоев разрешения пространств имён.
- [Как разделить логику валидации между сервером и Blazor WebAssembly](/ru/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) проходит через многопроектную раскладку, где RZ10012 кусается сильнее всего.
- [Как использовать Tailwind CSS с Blazor WebAssembly в .NET 11](/ru/2026/05/how-to-use-tailwind-css-with-blazor-webassembly-in-dotnet-11/) показывает чистую раскладку Blazor-проекта для сравнения.
- [Как добавить глобальный фильтр исключений в ASP.NET Core 11](/ru/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) — рантайм-аналог для отлова багов "тег отрендерен как сырой HTML", которые предотвратил бы RZ10012.

## Источники

- [dotnet/aspnetcore#45427: Referenced Razor Class Library component reporting error RZ10012](https://github.com/dotnet/aspnetcore/issues/45427)
- [dotnet/razor#8800: `@inherits` breaks component recognition](https://github.com/dotnet/razor/issues/8800)
- [dotnet/razor#8146: Unusable Blazor analyzers blinking invalid RZ10012 warnings in VS 17.4.x](https://github.com/dotnet/razor/issues/8146)
- [Microsoft Learn: ASP.NET Core Blazor namespaces](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/?view=aspnetcore-9.0#namespaces)
- [Jonathan Crozier: Treat Blazor component warnings as errors](https://jonathancrozier.com/blog/treat-blazor-component-warnings-as-errors-found-markup-element-with-unexpected-name)
