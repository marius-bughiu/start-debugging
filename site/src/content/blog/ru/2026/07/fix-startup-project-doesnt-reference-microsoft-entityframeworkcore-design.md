---
title: "Решение: Your startup project doesn't reference Microsoft.EntityFrameworkCore.Design"
description: "Добавьте Microsoft.EntityFrameworkCore.Design в стартовый проект, который собирает dotnet ef, а не в проект с вашим DbContext, и передавайте -s в многослойных решениях."
pubDate: 2026-07-30
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "migrations"
lang: "ru"
translationOf: "2026/07/fix-startup-project-doesnt-reference-microsoft-entityframeworkcore-design"
translatedBy: "claude"
translationDate: 2026-07-30
---

Добавьте пакет в **стартовый проект**, то есть в проект, который `dotnet ef` собирает и запускает, а не в библиотеку классов с вашим `DbContext`: `dotnet add package Microsoft.EntityFrameworkCore.Design`. В многослойном решении дополнительно укажите инструментам, какой это проект, через `-s ./src/Api`. Начиная с `Microsoft.EntityFrameworkCore.Tools` 10.0.6 пакет Design больше не подтягивается автоматически.

```text
Your startup project 'Shop.Api' doesn't reference Microsoft.EntityFrameworkCore.Design. This package is required for the Entity Framework Core Tools to work. Ensure your startup project is correct, install the package, and try again.
```

Эта статья написана для EF Core 11.0.0-preview.6 (`11.0.0-preview.6.26359.118`, 2026-07-14), SDK .NET 11 preview 6 и C# 14, с пометками про EF Core 9 и 10 там, где инструменты ведут себя иначе. Текущая стабильная линия -- 10.0.10. Сам текст ошибки не менялся со времён EF Core 2.1, но то, **как** инструменты решают, что пакет отсутствует, существенно изменилось в EF Core 10, и именно это определяет, какое из решений ниже подходит вам.

## На что на самом деле жалуются инструменты

Сообщение читается как статическая проверка вашего `.csproj`. Это не так. Это ошибка загрузки, о которой сообщают уже по факту.

Вот реальная последовательность, когда вы выполняете `dotnet ef migrations add Init`:

1. `dotnet-ef` запускает сборку метаданных стартового проекта. В EF Core 10 и 11 это `dotnet build --no-restore /getProperty:AssemblyName /getProperty:OutputPath ... /t:ResolvePackageAssets /getItem:RuntimeCopyLocalItems`.
2. Он просматривает возвращённые `RuntimeCopyLocalItems` в поисках `FullPath`, содержащего `Microsoft.EntityFrameworkCore.Design`, и запоминает этот абсолютный путь.
3. Он собирает стартовый проект, а затем вызывает `ef.dll`, передавая найденный путь как `--design-assembly` вместе с файлами `.deps.json` и `.runtimeconfig.json` проекта, чтобы процесс инструмента воспроизводил загрузку сборок вашего приложения.
4. `ef.dll` загружает `Microsoft.EntityFrameworkCore.Design.dll` в `AssemblyLoadContext`: по этому пути, если путь получен, иначе по имени сборки.
5. Если шаг 4 выбрасывает `FileNotFoundException` и имя отсутствующей сборки в точности равно `Microsoft.EntityFrameworkCore.Design`, инструмент проглатывает исключение и печатает приведённое выше дружелюбное сообщение, называя стартовую сборку.

Из этого напрямую следуют два вывода. Во-первых, названный в сообщении проект -- это **стартовый** проект, поэтому, если это имя вас удивляет, ваша проблема в шаге 1, а не в отсутствующем пакете. Во-вторых, `PackageReference`, который существует, но не порождает копируемый локально ресурс среды выполнения, для шага 2 невидим, и именно поэтому люди вставляют свой `.csproj` в отчёты об ошибках и настаивают, что пакет вот он.

EF Core 9 и более ранние версии работали иначе: `dotnet-ef` внедрял в проект встроенный файл `EntityFrameworkCore.targets`, а `ef.dll` разрешал Design по имени сборки через `.deps.json` стартового проекта. Это различие важно для одного конкретного сценария сбоя, разобранного ниже.

## Минимальное воспроизведение

Многослойное решение из двух проектов -- именно такая структура чаще всего порождает эту ошибку:

```text
Shop.sln
  src/Shop.Api/Shop.Api.csproj          <- startup project, has Program.cs
  src/Shop.Data/Shop.Data.csproj        <- has AppDbContext and Migrations/
```

```xml
<!-- src/Shop.Data/Shop.Data.csproj - .NET 11, EF Core 11.0.0-preview.6 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0-preview.6.26359.118" />
    <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="11.0.0-preview.6.26359.118" />
  </ItemGroup>
</Project>
```

```xml
<!-- src/Shop.Api/Shop.Api.csproj - .NET 11, EF Core 11.0.0-preview.6 -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../Shop.Data/Shop.Data.csproj" />
  </ItemGroup>
</Project>
```

```bash
# .NET 11 SDK preview 6
cd src/Shop.Data
dotnet ef migrations add Init -s ../Shop.Api
# Your startup project 'Shop.Api' doesn't reference Microsoft.EntityFrameworkCore.Design.
```

Пакет Design подключён. Он подключён не в том проекте, и путешествовать он не умеет.

## Решение 1: подключите Design в стартовом проекте

Это решение подходит почти во всех случаях. Выполните команду из каталога стартового проекта:

```bash
# .NET 11 SDK preview 6, EF Core 11
dotnet add src/Shop.Api/Shop.Api.csproj package Microsoft.EntityFrameworkCore.Design
```

NuGet запишет вот это, потому что Design помечен как `developmentDependency` в своём nuspec:

```xml
<!-- src/Shop.Api/Shop.Api.csproj - EF Core 11.0.0-preview.6 -->
<PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="11.0.0-preview.6.26359.118">
  <PrivateAssets>all</PrivateAssets>
  <IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>
</PackageReference>
```

Внимательно прочитайте этот список `IncludeAssets`, потому что он объясняет обе половины проблемы:

- `runtime` в списке **есть**. Именно это помещает `Microsoft.EntityFrameworkCore.Design.dll` в вашу папку `bin` и, следовательно, в `RuntimeCopyLocalItems`, которые и просматривают инструменты. Не удаляйте его.
- `compile` в списке **нет**. Вы не можете ссылаться на типы Design из кода приложения, и это сделано намеренно: это пакет времени разработки, и ничто в вашем рабочем коде не должно с ним связываться.
- `PrivateAssets: all` означает, что ссылка **не передаётся транзитивно**. Именно поэтому Решение 1 существует как отдельный шаг, а наличия пакета в проекте данных недостаточно.

## Решение 2: направьте инструменты на правильный стартовый проект

Если имя проекта в ошибке -- не тот проект, который вы имели в виду, то с пакетом всё в порядке, а цель выбрана неверно. Правило из документации CLI EF Core: *целевой проект* -- это тот, куда записываются файлы (`--project`, `-p`, по умолчанию текущий каталог), а *стартовый проект* -- тот, который инструменты собирают и выполняют, чтобы обнаружить строку подключения и модель (`--startup-project`, `-s`, тоже по умолчанию текущий каталог).

```bash
# EF Core 11, run from the repository root
dotnet ef migrations add Init -p src/Shop.Data -s src/Shop.Api
```

Необходимость набирать это в каждой команде -- та самая причина, по которой команды прикручивают пакет к неправильному проекту, лишь бы ошибка исчезла. EF Core 11 добавляет файл конфигурации именно для этого; он обнаруживается подъёмом от текущего каталога вверх до первого найденного `.config/dotnet-ef.json`:

```json
{
  "project": "src/Shop.Data",
  "startupProject": "src/Shop.Api"
}
```

Относительные пути разрешаются относительно родительского каталога для каталога `.config`, поэтому положите файл в корень репозитория, и любой вызов `dotnet ef` из любого подкаталога его подхватит. Явные параметры командной строки по-прежнему приоритетнее файла. Принимаются только документированные ключи: `project`, `startupProject`, `context`, `framework`, `configuration`, `runtime`, `verbose`, `noColor`, `prefixOutput`. Неизвестный ключ -- это жёсткая ошибка, а не предупреждение, так что опечатка вида `startProject` приведёт к полному отказу команды.

## Решение 3: перестаньте пытаться протолкнуть ссылку из проекта данных

Время от времени кто-нибудь находит этот приём, и он действительно работает:

```xml
<!-- src/Shop.Data/Shop.Data.csproj - do not do this -->
<PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="11.0.0-preview.6.26359.118">
  <PrivateAssets>none</PrivateAssets>
</PackageReference>
```

Установка `PrivateAssets` в `none` заставляет ссылку транзитивно дойти до `Shop.Api`, и ошибка исчезает. Одновременно она тянет Roslyn в каждый проект, ссылающийся на ваш слой данных, поскольку Design зависит от `Microsoft.CodeAnalysis.CSharp` и `Microsoft.CodeAnalysis.CSharp.Workspaces` (5.0.0 или новее в пакете 10.0.10), а также от `Microsoft.Build.Framework`, `Humanizer.Core`, `Mono.TextTemplating` и `Newtonsoft.Json`. Вы перенесли инструментарий генерации кода в граф зависимостей среды выполнения, чтобы сэкономить одну строку в одном `.csproj`. Возьмите вместо этого явную ссылку в стартовом проекте.

## Вариант с несовпадением версий начиная с Tools 10.0.6

Если вы устанавливаете `Microsoft.EntityFrameworkCore.Tools` (модуль Package Manager Console) и ожидаете, что он притащит Design с собой, это предположение больше не верно. До версии 10.0.6 Tools зависел от совпадающей версии Design. Это ломало восстановление пакетов для проектов, нацеленных на `net8.0`, потому что Design 10.0.x нацелен только на `net10.0`, поэтому команда EF снизила нижнюю границу до Design 8.0.0 в Tools 10.0.6. В ветке EF Core 11 у `Microsoft.EntityFrameworkCore.Tools` вообще нет `PackageReference` на Design.

Практический результат: теперь NuGet может разрешить старую версию Design, удовлетворяющую нижней границе, и симптом -- не эта ошибка, а:

```text
System.MissingMethodException: Method not found ...
System.TypeLoadException: Could not load type ...
```

Лечится это явной ссылкой с совпадающей версией. При централизованном управлении пакетами зафиксируйте её один раз:

```xml
<!-- Directory.Packages.props - EF Core 11.0.0-preview.6 -->
<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0-preview.6.26359.118" />
    <PackageVersion Include="Microsoft.EntityFrameworkCore.Design" Version="11.0.0-preview.6.26359.118" />
  </ItemGroup>
</Project>
```

У централизованного управления пакетами здесь есть и своя ловушка: запись `PackageVersion` в `Directory.Packages.props` -- это не ссылка. Стартовому проекту всё равно нужен `<PackageReference Include="Microsoft.EntityFrameworkCore.Design" />` без атрибута `Version`. Держите в согласии и сам `dotnet-ef`, потому что инструмент 10.x, управляющий сборкой Design 11.x, -- это отдельный класс сбоев:

```bash
dotnet tool update --global dotnet-ef --version 11.0.0-preview.6.26359.118
```

## Когда ссылка на месте, а сбой всё равно происходит

Выполните тот же запрос, что выполняют инструменты, и посмотрите на ответ сами. Ключ `-getItem` требует SDK .NET 8 или новее:

```bash
# .NET 11 SDK preview 6
dotnet build src/Shop.Api/Shop.Api.csproj --no-restore \
  /t:ResolvePackageAssets /getItem:RuntimeCopyLocalItems
```

Если `Microsoft.EntityFrameworkCore.Design.dll` в этом JSON нет, EF Core 10 и 11 его не видят, что бы ни было написано в `.csproj`. Обычные виновники -- атрибуты потока ресурсов, скопированные кем-то из пакета, содержащего только анализаторы:

- `<ExcludeAssets>runtime</ExcludeAssets>` или `<ExcludeAssets>all</ExcludeAssets>` на ссылке Design.
- Список `<IncludeAssets>`, из которого выпал `runtime`, например `build; analyzers`.
- `<PackageReference ... GeneratePathProperty="true" ExcludeAssets="all" />` -- шаблон, который появляется, когда кому-то нужен только каталог tools из пакета.

Добавьте `-v`, чтобы получить собственный отчёт инструмента о том, что он разрешил. Подробный вывод печатает полную команду сборки метаданных и путь к выбранной сборке Design, что превращает игру в угадайку в диагностику из двух строк:

```bash
dotnet ef migrations add Init -s src/Shop.Api -v
```

Единственный случай, когда корректного `.csproj` действительно было недостаточно: в EF Core 9 с определёнными сборками SDK .NET 9 изменение [dotnet/sdk#45259](https://github.com/dotnet/sdk/pull/45259) прекратило записывать в `.deps.json` записи `PackageReference`, помеченные `PrivateAssets="all"`. Поскольку `ef.dll` в EF Core 9 разрешал Design по имени сборки через этот файл, инструменты теряли пакет ([dotnet/efcore#35265](https://github.com/dotnet/efcore/issues/35265), одним из дубликатов которого стал [#35544](https://github.com/dotnet/efcore/issues/35544)). Исправлено в EF Core 10 через [dotnet/efcore#35527](https://github.com/dotnet/efcore/pull/35527), где регистрируется обработчик `AssemblyLoadContext.Resolving`, просматривающий базовый путь приложения, наряду с описанным выше явным путём `--design-assembly`. Если вы застряли на проекте EF Core 9 и столкнулись с этим, достаточно обновить глобальный инструмент `dotnet-ef` до версии 10 или новее, потому что инструменты не зависят от версии пакетов среды выполнения, которыми управляют.

## Подводные камни и похожие случаи

**Сгенерированные проекты, поставленные без пакета.** Ранние сборки SDK .NET 11 preview 3 создавали проекты `dotnet new mvc --auth Individual` без ссылки на Design -- регрессия относительно preview 2, отслеженная как [dotnet/aspnetcore#65750](https://github.com/dotnet/aspnetcore/issues/65750). Начиная с SDK `11.0.100-preview.3.26166.111` она перестала воспроизводиться. Если проект был сгенерирован в этом окне, виноват шаблон, и Решение 1 -- всё, что вам нужно.

**Библиотека классов `netstandard2.0` как стартовый проект.** Инструментам приходится выполнять код приложения, а для этого нужна настоящая среда выполнения, тогда как .NET Standard -- это скорее спецификация, чем реализация. Добавление Design не поможет. Создайте одноразовый консольный проект, ссылающийся на библиотеку, и используйте его как `-s`.

**Платформенно-специфичный целевой фреймворк.** С `net11.0-android` или `net11.0-ios` вы получите другое сообщение -- о платформенно-специфичном фреймворке, и документированный ответ здесь: реализовать `IDesignTimeDbContextFactory<TContext>`, чтобы инструментам никогда не приходилось запускать ваше приложение.

**`NETSDK1004` в подробном выводе.** Сборка метаданных выполняется с `--no-restore`. Если проект ни разу не восстанавливался, `dotnet-ef` сообщит о необходимости восстановления, а не об отсутствующем пакете. Выполните `dotnet restore` и повторите попытку.

**Множественные целевые фреймворки.** `dotnet-ef` берёт первый целевой фреймворк и повторно вызывает себя. Если Design обусловлен одним TFM, а первым идёт другой, передайте `--framework net11.0` явно.

**`Unable to create an object of type 'AppDbContext'`.** Другая ошибка, другая причина. Сборка Design загрузилась нормально, а затем инструменты не смогли создать экземпляр вашего контекста. Это разбирается в [руководстве по обнаружению DbContext во время разработки](/ru/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/).

**Контейнеры CI.** Образ `dotnet/sdk`, а не `dotnet/aspnet`, и `dotnet tool install --global dotnet-ef` перед любым вызовом `dotnet ef`. Если вашему конвейеру нужно только применять миграции, а не создавать их, откажитесь от инструмента совсем и поставляйте пакет миграций.

## Структура, которая никогда в это не упирается

Четыре правила, и эта ошибка перестанет появляться в вашем решении:

1. `Microsoft.EntityFrameworkCore.Design` подключён стартовым проектом, со значениями `PrivateAssets` и `IncludeAssets` по умолчанию, которые записывает `dotnet add package`.
2. Пакет провайдера (`Microsoft.EntityFrameworkCore.SqlServer`, `Npgsql.EntityFrameworkCore.PostgreSQL` и так далее) достижим из стартового проекта, транзитивно через проект данных -- это нормально.
3. Все версии пакетов EF Core и версия инструмента `dotnet-ef` совпадают, в идеале зафиксированы в `Directory.Packages.props`.
4. `.config/dotnet-ef.json` фиксирует `project` и `startupProject`, чтобы никому не приходилось помнить про `-p` и `-s`.

## Похожие материалы

- [Почему инструменты времени разработки не могут создать экземпляр вашего DbContext](/ru/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/) разбирает ошибку, с которой вы столкнётесь сразу после исправления этой.
- [Доставка изменений схемы с помощью пакетов миграций](/ru/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) -- команда времени разработки, которую этот пакет тоже блокирует, и способ держать `dotnet-ef` вне продакшн-машин.
- [PendingModelChangesWarning и что она на самом деле обнаруживает](/ru/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/) -- следующее, о чём вам сообщит CI, когда миграции заработают.
- [Правильная регистрация DbContextOptions](/ru/2026/06/fix-no-service-for-type-dbcontextoptions-has-been-registered/) объясняет сбой на стороне внедрения зависимостей, который в многослойном решении выглядит похоже.
- [Ломающие изменения при переходе с EF Core 6 на EF Core 11](/ru/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) включают изменения в инструментах, о которых стоит знать до обновления.

## Источники

- [Справочник инструментов EF Core (.NET CLI)](https://learn.microsoft.com/en-us/ef/core/cli/dotnet), включая правила про целевой и стартовый проекты и файл конфигурации `dotnet-ef.json` в EF Core 11.
- [Архитектура инструментов времени разработки](https://learn.microsoft.com/en-us/ef/core/miscellaneous/internals/tools) -- о цепочке от `dotnet-ef` к `ef.dll` и далее к `EFCore.Design.dll`.
- [`src/dotnet-ef/Project.cs`](https://github.com/dotnet/efcore/blob/main/src/dotnet-ef/Project.cs) и [`src/ef/Commands/ProjectCommandBase.cs`](https://github.com/dotnet/efcore/blob/main/src/ef/Commands/ProjectCommandBase.cs) -- поиск в `RuntimeCopyLocalItems` и точное место, где `FileNotFoundException` превращается в это сообщение.
- [Объявление: изменение зависимости на пакет Design в Microsoft.EntityFrameworkCore.Tools 10.0.6](https://github.com/dotnet/efcore/issues/38124).
- [dotnet/efcore#35265](https://github.com/dotnet/efcore/issues/35265) и [dotnet/efcore#35527](https://github.com/dotnet/efcore/pull/35527) -- про регрессию с `.deps.json` и `PrivateAssets`.
- [dotnet/aspnetcore#65750](https://github.com/dotnet/aspnetcore/issues/65750) -- про регрессию шаблонов в .NET 11 preview 3.
