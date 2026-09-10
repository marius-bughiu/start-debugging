---
title: "Исправление: PublishAot вместе с EFOptimizeContext исчерпывает память при сборке EF Core"
description: "Генерация модели EF Core во время сборки снова и снова запускала MSBuild, пока не заканчивалась RAM. Обновите Tasks и Design до 10.0.10+, а в EF Core 11 удалите EFOptimizeContext."
pubDate: 2026-09-10
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "entity-framework"
  - "native-aot"
  - "msbuild"
  - "dotnet-10"
lang: "ru"
translationOf: "2026/09/fix-publishaot-and-efoptimizecontext-exhaust-memory-during-an-ef-core-build"
translatedBy: "claude"
translationDate: 2026-09-10
---

Обновите и `Microsoft.EntityFrameworkCore.Tasks`, и `Microsoft.EntityFrameworkCore.Design` до 10.0.10 или новее (на 2026-09-10 актуальна 10.0.12), затем завершите оставшиеся процессы сборки и перезапустите Visual Studio. Вплоть до 10.0.9 генерация скомпилированной модели и предкомпиляция запросов EF Core во время сборки повторно запускали сами себя изнутри собственных вложенных сборок и порождали процессы MSBuild, пока машине не переставало хватать памяти. В EF Core 11 исправление уже есть, а самого `EFOptimizeContext` больше не существует: удалите его, иначе сборка упадёт.

## Ошибка в контексте

Здесь нет исключения, которое можно было бы поискать, и именно это делает проблему такой неприятной. Отчёт по EF Core 10.0.5, [dotnet/efcore#38087](https://github.com/dotnet/efcore/issues/38087), описывает симптом целиком: потребление RAM растёт, пока машина не перестаёт отвечать, вывод сборки так и не продвигается дальше первой строки, а для запуска проблемы достаточно просто открыть решение в Visual Studio, потому что IntelliSense начинает design-time сборки сразу после загрузки проекта. Подробный журнал сборки в этом отчёте содержит ровно это и ничего больше:

```
Build started at 5:55 PM...
```

Тем временем диспетчер задач или `top` показывает растущую кучу процессов `dotnet` и `MSBuild`. Настройки проекта, которые это вызывают, всегда одни и те же четыре строки:

```xml
<!-- EF Core 10.0.5 through 10.0.9: do not build this without the fix -->
<PublishAot>true</PublishAot>
<EFOptimizeContext>true</EFOptimizeContext>
<EFScaffoldModelStage>build</EFScaffoldModelStage>
<EFPrecompileQueriesStage>build</EFPrecompileQueriesStage>
```

Если вы попали сюда после обновления на EF Core 11, картина другая: жёсткая ошибка сборки из target `_EFValidateProperties` в `Microsoft.EntityFrameworkCore.Tasks` 11.0.0-rc.1.26425.128 с таким сообщением:

```
$(EFOptimizeContext) is no longer supported. Use $(EFScaffoldModelStage) and $(EFPrecompileQueriesStage) instead.
```

## Почему это происходит

Здесь сходятся два факта, которые на первый взгляд никак не связаны.

Во-первых, `PublishAot` влияет не только на публикацию. При `<PublishAot>true</PublishAot>` в файле проекта даже обычный `dotnet build` записывает переключатели возможностей AOT в `bin/Debug/net10.0/YourApp.runtimeconfig.json`, в том числе этот:

```json
"System.Runtime.CompilerServices.RuntimeFeature.IsDynamicCodeSupported": false
```

EF Core учитывает этот переключатель и отказывается строить модель в среде выполнения, поэтому сеанс отладки по F5 падает на первом же запросе:

```
Unhandled exception. System.InvalidOperationException: Model building is not supported when publishing with NativeAOT. Use a compiled model.
   at Microsoft.EntityFrameworkCore.Internal.DbContextServices.CreateModel(Boolean designTime)
   at Microsoft.EntityFrameworkCore.Internal.DbContextServices.get_Model()
```

Естественная реакция: генерировать скомпилированную модель и предкомпилированные запросы при каждой сборке. Именно это делают `EFScaffoldModelStage=build` и `EFPrecompileQueriesStage=build`, а в EF Core 9 и 10 они действуют только вместе с `EFOptimizeContext=true`. Отсюда и четыре строки.

Во-вторых, есть то, как `Microsoft.EntityFrameworkCore.Tasks` встраивает генерацию в сборку. Target `_EFGenerateFilesAfterBuild` добавляется в `$(TargetsTriggeredByCompilation)`, поэтому выполняется после каждого `CoreCompile`. Он запускает вложенный MSBuild того же проекта с `_EFGenerationStage=build`, который заново собирает проект с отключённым AOT и затем выполняет задачу `OptimizeDbContext`. Для предкомпилированных запросов design-time код EF затем открывает проект через `MSBuildWorkspace` из Roslyn, а загрузка проекта таким способом выполняет ещё одну design-time сборку.

Единственным, что удерживало эту цепочку от рекурсии, было условие `'$(_EFGenerationStage)'==''` на target-ах генерации. В нём было две дыры:

1. **Design-time сборки Visual Studio.** `CoreCompile` выполняется и во время облегчённых design-time сборок, которые VS непрерывно запускает, пока проект открыт. Каждая из них запускала полную генерацию во внешнем процессе, и они накапливались быстрее, чем завершались. [dotnet/efcore#38386](https://github.com/dotnet/efcore/pull/38386) исправил это, добавив `'$(DesignTimeBuild)' != 'True'` в target-ы генерации. Это изменение находится в файле `.targets` пакета **Tasks**.
2. **Сборки из командной строки.** `MSBuildWorkspace`, открытый для предкомпиляции запросов, не получал `_EFGenerationStage`, поэтому его сборка удовлетворяла условию и снова запускала генерацию, которая открывала ещё один workspace, и так далее. [dotnet/efcore#38403](https://github.com/dotnet/efcore/pull/38403) исправил это, создавая workspace с глобальным свойством `_EFGenerationStage=build`. Это изменение находится в `DbContextOperations` внутри пакета **Design**.

Оба исправления попали в `release/10.0` в июне 2026 года и впервые вышли в 10.0.10 2026-07-14. Я проверил это по самим пакетам, а не по milestone: в `Microsoft.EntityFrameworkCore.Tasks.targets` из 10.0.9 нет ни одной проверки `DesignTimeBuild`, в 10.0.10 их три, а строка `_EFGenerationStage` впервые появляется в `Microsoft.EntityFrameworkCore.Design.dll` в 10.0.10.

## Минимальное воспроизведение

Это проект из исходного отчёта, урезанный до одной сущности и одного контекста поверх SQLite. Проблему воспроизводит любая версия до 10.0.9 включительно. Не собирайте его на машине, где вы не готовы убить дерево процессов.

```xml
<!-- .NET 10 SDK, EF Core 10.0.9 (broken). Reproduces the memory exhaustion. -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <PublishAot>true</PublishAot>
    <EFOptimizeContext>true</EFOptimizeContext>
    <EFScaffoldModelStage>build</EFScaffoldModelStage>
    <EFPrecompileQueriesStage>build</EFPrecompileQueriesStage>
    <InterceptorsNamespaces>$(InterceptorsNamespaces);Microsoft.EntityFrameworkCore.GeneratedInterceptors</InterceptorsNamespaces>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.0.9" />
    <PackageReference Include="Microsoft.EntityFrameworkCore.Tasks" Version="10.0.9" PrivateAssets="all" />
  </ItemGroup>
</Project>
```

```csharp
// .NET 10, EF Core 10.0.x
using Microsoft.EntityFrameworkCore;

await using var db = new AppDbContext();
await db.Database.OpenConnectionAsync();
await db.Database.ExecuteSqlRawAsync(
    "CREATE TABLE IF NOT EXISTS Entities (Id INTEGER PRIMARY KEY)");
var count = await db.Entities.Where(e => e.Id > 0).CountAsync();
Console.WriteLine($"Entities: {count}");

public class Entity { public int Id { get; set; } }

public class AppDbContext : DbContext
{
    public DbSet<Entity> Entities => Set<Entity>();
    protected override void OnConfiguring(DbContextOptionsBuilder o) => o.UseSqlite("Data Source=db.sqlite");
}
```

Таблица намеренно создаётся сырым SQL, а не через `EnsureCreatedAsync()`. Почему, объясняется в разделе о подводных камнях ниже.

## Исправление в деталях

### 1. Обновите Tasks и Design вместе до 10.0.10 или новее

```xml
<!-- .NET 10 SDK 10.0.302, EF Core 10.0.12 (fixed) -->
<ItemGroup>
  <PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.0.12" />
  <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.12" PrivateAssets="all" />
  <PackageReference Include="Microsoft.EntityFrameworkCore.Tasks" Version="10.0.12" PrivateAssets="all" />
</ItemGroup>
```

Зафиксируйте Design явно. Защита для design-time сборок находится в Tasks, защита для командной строки находится в Design, а без явной ссылки Design попадает в граф транзитивно в той версии, которую выберет NuGet. Это не всегда та версия, на которую вы рассчитываете: Tools с 10.0.6 по 10.0.8 позволяли Design разрешаться вплоть до 8.0.0, и эта путаница разобрана в [исправлении MissingMethodException ArgumentIsEmpty](/ru/2026/09/fix-missingmethodexception-argumentisempty-after-upgrading-ef-core-tools/). Обновление одного только Tasks чинит Visual Studio, но оставляет `dotnet build` сломанным. Команда `dotnet nuget why . Microsoft.EntityFrameworkCore.Design` покажет, что вы получили на самом деле.

Затем уберите то, что осталось от сломанной версии. Закройте Visual Studio, завершите осиротевшие процессы `dotnet` или `MSBuild`, остановите серверы сборки и удалите `obj`, чтобы наполовину записанные сгенерированные файлы и их списки `*.EFGeneratedSources.Build.txt` не попали в следующую компиляцию:

```bash
dotnet build-server shutdown
```

После перевода воспроизведения выше на 10.0.12 с SDK 10.0.302 `dotnet build` завершается за 5.4 секунды с 0 ошибок, приложение выводит `Entities: 0`, а `obj/Debug/net10.0/EfBombRepro.EFGeneratedSources.Build.txt` перечисляет шесть сгенерированных файлов:

```
AppDbContextAssemblyAttributes.g.cs
EntityUnsafeAccessors.g.cs
AppDbContextModel.g.cs
AppDbContextModelBuilder.g.cs
EntityEntityType.g.cs
Program.EFInterceptors.AppDbContext.g.cs
```

Файл перехватчиков содержит готовый SQL для вызова `CountAsync`, `SELECT COUNT(*) FROM "Entities" AS "e" WHERE "e"."Id" > 0`, в виде строкового литерала. В этом и состоит смысл предкомпиляции запросов: в среде выполнения LINQ больше не транслируется.

### 2. В EF Core 11 удалите EFOptimizeContext

EF Core 11 удалил это свойство ([dotnet/efcore#35079](https://github.com/dotnet/efcore/issues/35079)), потому что свойства стадий уже выражали всё, что оно делало. Теперь они включают генерацию сами по себе:

```xml
<!-- .NET 11, EF Core 11.0.0-rc.1.26425.128 -->
<PropertyGroup>
  <PublishAot>true</PublishAot>
  <EFScaffoldModelStage>build</EFScaffoldModelStage>
  <EFPrecompileQueriesStage>build</EFPrecompileQueriesStage>
</PropertyGroup>
```

Файл targets из rc.1 содержит защиту `DesignTimeBuild`, а сборка Design из rc.1 содержит исправление workspace с `_EFGenerationStage`, поэтому такая конфигурация безопасна. Если генерация нужна только при публикации, удалите и обе строки стадий: обе по умолчанию равны `publish`, и при `PublishAot=true` EF Core 11 генерирует скомпилированную модель и предкомпилированные запросы во время `dotnet publish` без каких-либо дополнительных свойств. Одна комбинация отклоняется сразу, `EFScaffoldModelStage=publish` вместе с `EFPrecompileQueriesStage=build`: она падает с сообщением "If $(EFScaffoldModelStage) is set to 'publish' then $(EFPrecompileQueriesStage) must also be set to 'publish'."

Следите за порядком. В 10.x `EFOptimizeContext` по-прежнему включает генерацию на стадии сборки. Я убрал его из исправленного воспроизведения на 10.0.12 и оставил обе стадии в `build`: сборка прошла успешно, ничего не сгенерировала, а приложение выбросило исключение "Model building is not supported" на первом запросе. Удаляйте свойство в рамках обновления на EF Core 11, а не раньше. Учтите также, что в EF Core 11 пакет Tasks вообще больше не зависит от Design, и это ещё одна причина сохранить явную ссылку на Design из шага 1.

Поскольку единственный SDK на моей машине 10.0.302, а пакеты EF Core 11 нацелены только на `net11.0`, утверждения об EF Core 11 выше основаны на чтении опубликованных в rc.1 файла targets и сборки, а не на реальной сборке.

### 3. Держите PublishAot вне внутреннего цикла разработки

Совет мейнтейнера EF в обсуждении issue прямолинеен: "I'd recommend not setting `<PublishAot>true</PublishAot>` for the inner dev loop". Возражение автора отчёта и есть настоящая проблема: без `PublishAot` предупреждения trimming и AOT исчезают из IDE. Это необязательно, потому что у анализаторов есть собственные переключатели:

```xml
<!-- .NET 10 SDK 10.0.302, EF Core 10.0.12 -->
<PropertyGroup>
  <EnableAotAnalyzer>true</EnableAotAnalyzer>
  <EnableTrimAnalyzer>true</EnableTrimAnalyzer>
</PropertyGroup>
```

Если заменить `PublishAot` этими двумя строками, воспроизведение по-прежнему выдаёт те же предупреждения `IL2026` и `IL3050` на `new AppDbContext()`. В runtimeconfig больше нет переключателя `IsDynamicCodeSupported`, EF Core строит модель в среде выполнения как обычно, и во время сборки ничего не генерируется. AOT становится решением на этапе публикации:

```bash
dotnet publish -c Release -r linux-x64 -p:PublishAot=true
```

Документация EF также рекомендует задавать `<RuntimeIdentifier>` в стартовом проекте, когда генерация выполняется на стадии публикации.

Цена во внутреннем цикле вполне реальна. На воспроизведении с одной сущностью инкрементальная сборка после правки `Program.cs` заняла 4.7 секунды с генерацией на стадии сборки и 1.2 секунды без неё. Сборка без изменений заняла 0.6 секунды в обоих случаях, потому что генерация пропускается всякий раз, когда пропускается `CoreCompile`. Документация предупреждает, что сгенерированные модель и перехватчики "may currently be quite large" и долго создаются, так что этот разрыв растёт вместе с вашей моделью.

## Подводные камни и похожие ошибки

**"Design-time DbContext operations are not supported when publishing with NativeAOT."** При `PublishAot=true` `EnsureCreatedAsync()`, `Migrate()` и всё остальное, чему нужна design-time модель, выбрасывают это исключение, даже по F5 и даже при наличии скомпилированной модели. Поэтому воспроизведение создаёт таблицу сырым SQL. Применяйте изменения схемы из конвейера развёртывания с помощью migrations bundle или SQL-скрипта.

**`warning CS9270: 'InterceptsLocationAttribute(string, int, int)' is not supported`.** Перехватчики, сгенерированные 10.0.12, всё ещё используют форму атрибута на основе пути к файлу, поэтому компилятор выдаёт предупреждение для сгенерированного файла. Это предупреждение в сгенерированном коде, а не то, что нужно исправлять в вашем. Та же деталь объясняет, почему эти файлы содержат абсолютные пути конкретной машины и должны лежать в `obj`, а не в системе контроля версий.

**CS9137, "The 'interceptors' feature is not enabled in this namespace".** Либо отсутствует строка `InterceptorsNamespaces`, либо, согласно документации EF, в графе есть устаревшие транзитивные ссылки на `Microsoft.CodeAnalysis.CSharp.Workspaces` и `Microsoft.CodeAnalysis.Workspaces.MSBuild`. Тот же код ошибки от другого генератора разобран в [исправлении ошибки CS9137 про interceptors](/ru/2026/08/fix-the-interceptors-feature-is-not-enabled-in-this-namespace-microsoft-aspnetcore-openapi/).

**Генерация молча пропускается в решении из нескольких проектов.** Каждому проекту, который содержит `DbContext` или запрос EF, нужна собственная ссылка на `Microsoft.EntityFrameworkCore.Tasks`, поскольку она не транзитивна. Интеграция также не умеет работать с отдельным стартовым проектом, поэтому контексту, который настраивается из хоста в другом проекте, нужна `IDesignTimeDbContextFactory<TContext>`.

**То же исключение построения модели на iOS без PublishAot.** Сборки для iOS сами выставляют `DynamicCodeSupport=false`, поэтому приложения .NET MAUI попадают на этот путь, даже не включая AOT. См. [исправление построения модели с NativeAOT в MAUI iOS](/ru/2026/08/fix-model-building-is-not-supported-when-publishing-with-nativeaot-in-maui-ios/).

## Связанные статьи

- [Как прогреть модель EF Core перед первым запросом](/ru/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/), включая поставку скомпилированной модели через `dotnet ef dbcontext optimize`, когда AOT вам вообще не нужен.
- [Исправление: Model building is not supported when publishing with NativeAOT в сборке .NET MAUI для iOS](/ru/2026/08/fix-model-building-is-not-supported-when-publishing-with-nativeaot-in-maui-ios/)
- [Native AOT vs ReadyToRun vs JIT в .NET 11: что выбрать для поставки?](/ru/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/), стоит прочитать до того, как переводить приложение EF Core на AOT.
- [Исправление: MissingMethodException 'AbstractionsStrings.ArgumentIsEmpty' после обновления EF Core Tools](/ru/2026/09/fix-missingmethodexception-argumentisempty-after-upgrading-ef-core-tools/)
- [Исправление: The 'interceptors' feature is not enabled in this namespace](/ru/2026/08/fix-the-interceptors-feature-is-not-enabled-in-this-namespace-microsoft-aspnetcore-openapi/)

## Источники

- [dotnet/efcore#38087, `PublishAot` + `EFOptimizeContext` fork bombs the system](https://github.com/dotnet/efcore/issues/38087)
- [dotnet/efcore#38386, защита генерации файлов EF от design-time сборок](https://github.com/dotnet/efcore/pull/38386)
- [dotnet/efcore#38403, защита генерации файлов EF при сборке из командной строки](https://github.com/dotnet/efcore/pull/38403)
- [dotnet/efcore#35079, удаление свойства EFOptimizeContext из target-ов EF](https://github.com/dotnet/efcore/issues/35079)
- [Задачи MSBuild в EF Core](https://learn.microsoft.com/en-us/ef/core/cli/msbuild)
- [Критические изменения в EF Core 11: свойство MSBuild EFOptimizeContext удалено](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/breaking-changes)
- [Поддержка NativeAOT и предкомпилированные запросы в EF Core](https://learn.microsoft.com/en-us/ef/core/performance/nativeaot-and-precompiled-queries)
- [Microsoft.EntityFrameworkCore.Tasks на NuGet](https://www.nuget.org/packages/Microsoft.EntityFrameworkCore.Tasks)
