---
title: "Исправление: MissingMethodException 'AbstractionsStrings.ArgumentIsEmpty' после обновления EF Core Tools"
description: "dotnet ef бросает MissingMethodException на ArgumentIsEmpty, потому что Tools 10.0.6 перестал подтягивать совместимый Microsoft.EntityFrameworkCore.Design. Зафиксируйте Design на своей версии EF Core."
pubDate: 2026-09-08
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "entity-framework"
  - "dotnet"
  - "dotnet-10"
  - "nuget"
lang: "ru"
translationOf: "2026/09/fix-missingmethodexception-argumentisempty-after-upgrading-ef-core-tools"
translatedBy: "claude"
translationDate: 2026-09-08
---

Добавьте явный `PackageReference` на `Microsoft.EntityFrameworkCore.Design`, зафиксированный на той же версии, что и остальные пакеты EF Core, в **стартовый проект**, и выполните восстановление. `Microsoft.EntityFrameworkCore.Tools` 10.0.6, 10.0.7 и 10.0.8 понизили свою зависимость от Design до `>= 8.0.0`, поэтому NuGet спокойно разрешает Design 8.0.0 рядом с runtime EF Core 10, а сборка времени разработки вызывает метод, которого больше нет. Обновление Tools до 10.0.9 или новее тоже решает проблему, потому что в 10.0.9 согласование версий по фреймворкам было восстановлено.

## Ошибка в контексте

Запуск `dotnet ef migrations add` на сломанном графе пакетов:

```
Build started...
Build succeeded.
System.MissingMethodException: Method not found: 'System.String Microsoft.EntityFrameworkCore.Diagnostics.AbstractionsStrings.ArgumentIsEmpty(System.Object)'.
   at Microsoft.EntityFrameworkCore.Utilities.Check.NotEmpty(String value, String parameterName)
   at Microsoft.EntityFrameworkCore.Design.OperationExecutor.AddMigrationImpl(String name, String outputDir, String contextType, String namespace)
   at Microsoft.EntityFrameworkCore.Design.OperationExecutor.AddMigration.<>c__DisplayClass0_0.<.ctor>b__0()
   at Microsoft.EntityFrameworkCore.Design.OperationExecutor.OperationBase.<>c__DisplayClass3_0`1.<Execute>b__0()
   at Microsoft.EntityFrameworkCore.Design.OperationExecutor.OperationBase.Execute(Action action)
Method not found: 'System.String Microsoft.EntityFrameworkCore.Diagnostics.AbstractionsStrings.ArgumentIsEmpty(System.Object)'.
```

Тот же самый граф пакетов на `dotnet ef database update` или `dotnet ef migrations list` даёт совершенно другое исключение:

```
System.TypeLoadException: Method 'Identifier' in type 'Microsoft.EntityFrameworkCore.Design.Internal.CSharpHelper' from assembly 'Microsoft.EntityFrameworkCore.Design, Version=8.0.26.0, Culture=neutral, PublicKeyToken=adb9793829ddae60' does not have an implementation.
   at Microsoft.EntityFrameworkCore.Design.DesignTimeServiceCollectionExtensions.<>c__DisplayClass0_0.<AddEntityFrameworkDesignTimeServices>b__0(ServiceCollectionMap services)
   at Microsoft.EntityFrameworkCore.Infrastructure.EntityFrameworkServicesBuilder.TryAddProviderSpecificServices(Action`1 serviceMap)
```

В Package Manager Console в Visual Studio то же самое всплывает на `Add-Migration` и `Update-Database`. У обоих сообщений одна причина. `TypeLoadException` полезнее, потому что печатает версию виновной сборки прямо в тексте сообщения.

## Почему это происходит

`Microsoft.EntityFrameworkCore.Design` -- это сборка, которая реально реализует генерацию миграций и обратный инжиниринг. Ни `dotnet ef`, ни Package Manager Console её не поставляют: они загружают её из разрешённого графа зависимостей вашего стартового проекта. То есть версия Design -- это та, которую выбрал NuGet, а NuGet выбирает наименьшую версию, удовлетворяющую всем ограничениям.

До 10.0.5 `Microsoft.EntityFrameworkCore.Tools` объявлял зависимость от `Microsoft.EntityFrameworkCore.Design` с нижней границей, равной собственной версии, поэтому ссылки на Tools хватало, чтобы подтянуть совместимый Design. В 10.0.6 эта граница опустилась до `8.0.0`. Изменение читается прямо из каталога NuGet:

| Версия Tools | Опубликована | Зависимость от Design |
| --- | --- | --- |
| 10.0.5 | 2026-03-12 | `net8.0` -> `[10.0.5, )` |
| 10.0.6 | 2026-04-14 | `net8.0` -> `[8.0.0, )` |
| 10.0.7 | 2026-04-21 | `net8.0` -> `[8.0.0, )` |
| 10.0.8 | 2026-05-12 | `net8.0` -> `[8.0.0, )` |
| 10.0.9 | 2026-06-09 | `net8.0` -> `[8.0.26, )`, `net9.0` -> `[9.0.15, )`, `net10.0` -> `[10.0.9, )` |
| 10.0.10 | 2026-07-14 | та же форма, `net10.0` -> `[10.0.10, )` |
| 10.0.11 | 2026-08-11 | та же форма, `net10.0` -> `[10.0.11, )` |

Причина изменения в 10.0.6 была законной. Пакет Tools нацелен на `net8.0` и должен использоваться из проектов `net8.0`, `net9.0` и `net10.0`, но Design 10.0.x поставляет только asset для `net10.0`, поэтому единственная высокая нижняя граница ломала восстановление для проектов на более старых фреймворках. Понижение границы до `8.0.0` починило восстановление и сломало всех, у кого runtime EF Core был 9.x или 10.x, потому что единственная группа зависимостей `net8.0` применяется ко всем потребляющим фреймворкам. В Tools 10.0.9 это решили правильно: тремя группами зависимостей, по одной на целевой фреймворк.

Сбой -- это чистое нарушение двоичной совместимости. `Check.NotEmpty` в EF Core 10 вызывает `AbstractionsStrings.ArgumentIsEmpty(object)`; сборки 8.x и 9.x этого класса ресурсов имеют другую сигнатуру. JIT разрешает вызов при первом выполнении `AddMigrationImpl` и бросает исключение.

## Минимальное воспроизведение

Достаточно двух ссылок на пакеты и одного `DbContext`. Это весь проект целиком, проверенный на SDK 10.0.302 с `dotnet-ef` 10.0.11 2026-09-08:

```xml
<!-- SDK 10.0.302. Reproduces the failure exactly as written. -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.0.11" />
    <PackageReference Include="Microsoft.EntityFrameworkCore.Tools" Version="10.0.6" />
  </ItemGroup>
</Project>
```

```csharp
// .NET 10, EF Core 10.0.11
using Microsoft.EntityFrameworkCore;

public class Blog { public int Id { get; set; } public string Name { get; set; } = ""; }

public class AppDb : DbContext
{
    public DbSet<Blog> Blogs => Set<Blog>();
    protected override void OnConfiguring(DbContextOptionsBuilder o)
        => o.UseSqlite("Data Source=app.db");
}
```

После `dotnet restore` граф выглядит так:

```
$ dotnet list package --include-transitive
   > Microsoft.EntityFrameworkCore              10.0.11
   > Microsoft.EntityFrameworkCore.Abstractions 10.0.11
   > Microsoft.EntityFrameworkCore.Design       8.0.0
```

Всё на стороне runtime -- 10.0.11, а сборка времени разработки -- 8.0.0. `dotnet ef migrations add Initial` после этого падает.

## Исправление, подробно

### 1. Зафиксируйте Design явно в стартовом проекте

Это исправление, которое рекомендует команда EF, и именно оно продолжает работать независимо от того, что объявят будущие выпуски Tools:

```xml
<!-- SDK 10.0.302, EF Core 10.0.11. Version must match your other EF Core packages. -->
<PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.11">
  <PrivateAssets>all</PrivateAssets>
  <IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>
</PackageReference>
```

`PrivateAssets=all` не даёт сборке времени разработки попасть в опубликованный вывод, поэтому блок метаданных стоит выписать полностью, а не ограничиваться однострочной формой. С этим `dotnet ef migrations add Initial` работает даже когда Tools всё ещё на 10.0.6.

Слово **стартовый** здесь принципиально. `dotnet ef` собирает и загружает стартовый проект, а не проект, где лежит ваш `DbContext`. В решении, где `Data` владеет контекстом, а `Api` -- точка входа, фиксация Design внутри `Data` ничего не даёт, потому что `PrivateAssets=all` не пропускает его через ссылку на проект:

```
$ dotnet list Api/Api.csproj package --include-transitive | grep Design
   > Microsoft.EntityFrameworkCore.Design       8.0.0
```

Команда по-прежнему падает с тем же `MissingMethodException`. Перенесите ссылку в `Api` -- и она проходит. Если по соглашению вы держите пакеты времени разработки в проекте контекста, добавьте ссылку в оба.

### 2. Или обновите Tools до 10.0.9 либо новее

Если вы не хотите добавлять ссылку на пакет, обновления пакета Tools достаточно само по себе, потому что в 10.0.9 согласование по фреймворкам восстановлено:

```
$ dotnet list package --include-transitive | grep Design
   > Microsoft.EntityFrameworkCore.Design       10.0.9
```

Оговорка: вы получаете нижнюю границу пакета Tools, а не свою версию EF Core. Tools 10.0.9 рядом с EF Core 10.0.11 даёт Design 10.0.9, что работает, но это расхождение версий, которое вы не выбирали. Исправление 1 всё равно остаётся лучшей привычкой.

### 3. Или откатите Tools до 10.0.5

Откат до 10.0.5 возвращает старую зависимость с совпадающей версией и является допустимой аварийной мерой, если вы в середине релиза и не можете широко трогать файлы проектов. Но это тупик: 10.0.5 предшествует нескольким месяцам исправлений в инструментах, и любое последующее обновление вернёт вас прямиком в сломанное окно, если вы дополнительно не примените исправление 1.

### 4. Central Package Management

При CPM версия живёт в `Directory.Packages.props`, и действует то же правило: объявите Design там и сошлитесь на него из стартового проекта.

```xml
<!-- Directory.Packages.props, EF Core 10.0.11 -->
<ItemGroup>
  <PackageVersion Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.0.11" />
  <PackageVersion Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.11" />
  <PackageVersion Include="Microsoft.EntityFrameworkCore.Tools" Version="10.0.11" />
</ItemGroup>
```

Одна запись `PackageVersion` пакет не добавляет. Она лишь задаёт версию, если на пакет кто-то ссылается. Если Design попадает в граф транзитивно через Tools, то `CentralPackageTransitivePinningEnabled` со значением `true` поднимет транзитивный Design до объявленной вами версии, что для большого решения является разумной второй линией обороны.

## Как узнать, какую версию Design загрузит инструмент

Не доверяйте `dotnet ef --version`. Он сообщает версию глобального инструмента, которая не зависит от графа проекта:

```
$ dotnet ef --version
Entity Framework Core .NET Command-line Tools
10.0.11
```

Здесь печатается 10.0.11, тогда как проект загружает Design 8.0.0. Настоящий ответ дают две команды. Первая показывает разрешённую версию и того, кто её запросил:

```
$ dotnet nuget why . Microsoft.EntityFrameworkCore.Design
Project 'EfToolsRepro' has the following dependency graph(s) for
'Microsoft.EntityFrameworkCore.Design':

  [net10.0]
  └── Microsoft.EntityFrameworkCore.Tools (v10.0.6)
      └── Microsoft.EntityFrameworkCore.Design (v8.0.0)
```

`dotnet nuget why` требует SDK .NET 9 или новее и является самым быстрым способом выяснить, какой пакет тянет старый Design, а это не всегда Tools. Любая библиотека в вашем решении, ссылающаяся на Design напрямую со старой нижней границей, может дать тот же эффект.

Вторая проверка читает вывод сборки, относительно которого инструменты и разрешают зависимости:

```
$ grep -o '"Microsoft.EntityFrameworkCore.Design/[0-9.]*"' bin/Debug/net10.0/Api.deps.json
"Microsoft.EntityFrameworkCore.Design/8.0.0"
```

Обратите внимание, что сама сборка Design в `bin` не копируется. Она разрешается из глобальной папки пакетов NuGet через запись в `deps.json`, поэтому поиск DLL рядом с исполняемым файлом ничего вам не скажет.

## Подводные камни и похожие ошибки

**Некоторые команды продолжают работать, и именно поэтому проблему с пакетами исключают слишком рано.** С Design 8.0.26 рядом с EF Core 10.0.11 команда `dotnet ef dbcontext info` без единой жалобы печатает контекст, провайдер и источник данных, а `dotnet ef dbcontext script` выдаёт корректный SQL. Падают только те ветки кода, которые задевают несогласованные типы. Не делайте вывод, что с инструментами всё в порядке, только потому что одна команда отработала успешно.

**Прочитайте сигнатуру `AddMigrationImpl` в трассировке стека.** Она опознаёт загруженную версию Design без дальнейших разбирательств. У Design 9.x есть параметр `Boolean dryRun`, которого нет у 8.x и 10.x:

```
// Design 9.0.15
at ...OperationExecutor.AddMigrationImpl(String name, String outputDir, String contextType, String namespace, Boolean dryRun)

// Design 8.0.26
at ...OperationExecutor.AddMigrationImpl(String name, String outputDir, String contextType, String namespace)
```

**"Your startup project doesn't reference Microsoft.EntityFrameworkCore.Design" -- другая ошибка с соседней причиной.** Она означает, что Design отсутствует полностью, а не присутствует не той версии. Стоит знать, что `Microsoft.EntityFrameworkCore.Tools` 11.0.0-preview.7.26381.103, опубликованный 2026-08-11, объявляет пустую группу зависимостей `net10.0`: зависимости от Design нет вообще. Если вы перенесёте привычку ссылаться только на Tools в обновление до EF Core 11, то встретите [ошибку о том, что стартовый проект не ссылается на Design](/ru/2026/07/fix-startup-project-doesnt-reference-microsoft-entityframeworkcore-design/), а не эту. Явная фиксация из исправления 1 закрывает обе.

**"Unable to create an object of type 'DbContext'" к делу не относится.** Это проблема фабрики времени разработки или построителя хоста, а не расхождения версий. Если в трассировке стека упоминается `DbContextActivator` или отсутствующая `IDesignTimeDbContextFactory`, вам нужен [путь диагностики создания DbContext](/ru/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/), а не эта страница.

**`MissingMethodException` во время выполнения приложения, а не во время разработки.** Если исключение возникает в вашем веб-приложении, а не в `dotnet ef`, виновата обычно библиотека, скомпилированная против другой мажорной версии EF Core, а не пакет Design. Диагностика при этом та же: запустите `dotnet nuget why` для `Microsoft.EntityFrameworkCore` и поищите пакет со старой нижней границей.

**Bundle миграций наследует проблему.** Поскольку `dotnet ef migrations bundle` запускает тот же стек времени разработки для сборки исполняемого файла, сломанный граф может выдать bundle из устаревшей модели или упасть совсем. Почините ссылку до того, как сгенерируете артефакт, который собираетесь запускать на продакшене, как описано в [разборе развёртывания через bundle миграций](/ru/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/).

## Что делать при обновлении до EF Core 11

EF Core 11 находится в состоянии preview по состоянию на сентябрь 2026 года и выходит вместе с .NET 11 в ноябре 2026 года. Поскольку единственный SDK на этой машине -- 10.0.302, весь вывод команд выше получен на EF Core 10.0.11, а не 11. Что проверяемо сегодня по каталогу NuGet, так это форма зависимостей: у Tools 11.0.0-preview.7 нет никаких зависимостей от пакетов. Относитесь к `Microsoft.EntityFrameworkCore.Design` как к пакету, который вы всегда объявляете сами, точно в версии остальных пакетов EF Core, и этот класс сбоев станет невозможным независимо от того, что объявит Tools. Это изменение в одну строку, которое стоит сделать до начала [более широкой работы по миграции на .NET 11](/ru/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/), потому что команду миграций, падающую посреди обновления, крайне трудно связать с нижней границей в NuGet.

Общее правило, которое иллюстрирует этот случай: держите все пакеты `Microsoft.EntityFrameworkCore.*` на одной версии, включая те, которые вы никогда не подключаете через `using`. EF Core не поддерживает смешивание мажорных версий между собственными сборками, а инструменты не выдают никакого предупреждения, когда NuGet тихо разрешает граф, где они смешаны.

## Похожие материалы

- [Исправление: Your startup project doesn't reference Microsoft.EntityFrameworkCore.Design](/ru/2026/07/fix-startup-project-doesnt-reference-microsoft-entityframeworkcore-design/)
- [Исправление: dotnet tool install --global dotnet-ef выдаёт ошибку](/ru/2026/08/fix-dotnet-tool-install-global-dotnet-ef-throws-an-error/)
- [Исправление: dotnet ef migrations add падает с "Unable to create an object of type DbContext"](/ru/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/)
- [Как применять миграции EF Core 11 на продакшене через bundle миграций](/ru/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)
- [Исправление: "The model for context 'X' has pending changes" в EF Core 11](/ru/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/)

## Источники

- [dotnet/efcore#38124, анонс: изменение зависимости от пакета Design в Microsoft.EntityFrameworkCore.Tools 10.0.6](https://github.com/dotnet/efcore/issues/38124)
- [dotnet/efcore#38107, исключение в Add-Migration: AbstractionsStrings.ArgumentIsEmpty](https://github.com/dotnet/efcore/issues/38107)
- [dotnet/efcore#38123, закрыт как дубликат 38107, с вариантом TypeLoadException](https://github.com/dotnet/efcore/issues/38123)
- [Microsoft.EntityFrameworkCore.Tools на NuGet, группы зависимостей по версиям](https://www.nuget.org/packages/Microsoft.EntityFrameworkCore.Tools/)
- [Справочник по инструментам Entity Framework Core для .NET CLI](https://learn.microsoft.com/en-us/ef/core/cli/dotnet)
- [Справочник по команде dotnet nuget why](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-nuget-why)
