---
title: "Исправление: Model building is not supported when publishing with NativeAOT в сборке .NET MAUI для iOS"
description: "Сборки для iOS выставляют DynamicCodeSupport=false, поэтому EF Core отказывается строить модель, даже если вы никогда не включали NativeAOT. Поставляйте скомпилированную модель и предкомпилированные запросы либо снова включите интерпретатор."
pubDate: 2026-08-30
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "maui"
  - "ios"
  - "native-aot"
  - "dotnet-10"
lang: "ru"
translationOf: "2026/08/fix-model-building-is-not-supported-when-publishing-with-nativeaot-in-maui-ios"
translatedBy: "claude"
translationDate: 2026-08-30
---

Ваше приложение MAUI для iOS падает на первом обращении к базе данных с сообщением `Model building is not supported when publishing with NativeAOT. Use a compiled model.`, а установка `<PublishAot>false</PublishAot>` ничего не меняет. Причина в том, что EF Core вообще не смотрит на `PublishAot`. Он проверяет `RuntimeFeature.IsDynamicCodeSupported`, а targets .NET для iOS выставляют этот переключатель в `false` в любой сборке для iOS, tvOS и Mac Catalyst, если только не включён интерпретатор. Поддерживаемое решение: перенесите `DbContext` и все запросы LINQ в обычную библиотеку классов, выполните для неё `dotnet ef dbcontext optimize --precompile-queries --nativeaot` и добавьте `<InterceptorsNamespaces>$(InterceptorsNamespaces);Microsoft.EntityFrameworkCore.GeneratedInterceptors</InterceptorsNamespaces>`. Запасной выход в одну строку это `<UseInterpreter>true</UseInterpreter>`, с реальной платой при запуске.

Всё изложенное ниже проверено на macOS с .NET SDK 10.0.302, `Microsoft.EntityFrameworkCore.Sqlite` 8.0.21 / 9.0.19 / 10.0.11 и CLI `dotnet-ef` 10.0.11. Сбой и все три решения воспроизводятся в обычном консольном приложении, без Xcode и без iPhone, потому что триггером служит один переключатель AppContext. Там, где утверждение касается самой сборки для iOS, а не того, что я запускал, оно взято из targets `dotnet/macios` и `dotnet/sdk`, и я об этом говорю.

## Ошибка в контексте

```text
System.InvalidOperationException: Model building is not supported when publishing with NativeAOT. Use a compiled model.
   at Microsoft.EntityFrameworkCore.Internal.DbContextServices.CreateModel(Boolean designTime)
   at Microsoft.EntityFrameworkCore.Internal.DbContextServices.get_Model()
   at Microsoft.EntityFrameworkCore.Infrastructure.EntityFrameworkServicesBuilder...
   at Microsoft.EntityFrameworkCore.DbContext.get_Model()
```

Она возникает при первой операции, которая обращается к модели: запрос, `Add`, `SaveChanges` или `EnsureCreated`. Само по себе создание `DbContext` её не вызывает, поэтому падение обычно происходит далеко от кода настройки базы данных.

Два родственных сообщения, на которые вы можете наткнуться, начав это исправлять, это `Design-time DbContext operations are not supported when publishing with NativeAOT.` и `Query wasn't precompiled and dynamic code isn't supported with NativeAOT.` Оба разобраны ниже.

## Почему сборка для iOS сообщает об ошибке NativeAOT, если вы никогда не включали NativeAOT

В сообщении назван NativeAOT, но в самой проверке о нём нет ни слова. Вот реальный код из [`DbContextServices.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore/Internal/DbContextServices.cs):

```csharp
// Microsoft.EntityFrameworkCore 10.0.11, DbContextServices.CreateModel
if (modelFromOptions == null
    || (designTime && modelFromOptions is not Metadata.Internal.Model))
{
    return RuntimeFeature.IsDynamicCodeSupported
        ? dependencies.ModelSource.GetModel(_currentContext!.Context, dependencies, designTime)
        : designTime
            ? throw new InvalidOperationException(CoreStrings.NativeAotDesignTimeModel)
            : throw new InvalidOperationException(CoreStrings.NativeAotNoCompiledModel);
}
```

`RuntimeFeature.IsDynamicCodeSupported` читает переключатель AppContext `System.Runtime.CompilerServices.RuntimeFeature.IsDynamicCodeSupported`, который SDK записывает в `runtimeconfig.json` из свойства MSBuild `DynamicCodeSupport`. Из [`Microsoft.NET.Sdk.targets`](https://github.com/dotnet/sdk/blob/main/src/Tasks/Microsoft.NET.Build.Tasks/targets/Microsoft.NET.Sdk.targets):

```xml
<!-- .NET SDK 10.0.302 -->
<RuntimeHostConfigurationOption Include="System.Runtime.CompilerServices.RuntimeFeature.IsDynamicCodeSupported"
                                Condition="'$(DynamicCodeSupport)' != ''"
                                Value="$(DynamicCodeSupport)"
                                Trim="true" />
```

А вот строка, которая его устанавливает, из [`Xamarin.Shared.Sdk.targets`](https://github.com/dotnet/macios/blob/main/dotnet/targets/Xamarin.Shared.Sdk.targets) в `dotnet/macios`:

```xml
<!-- dotnet/macios, Xamarin.Shared.Sdk.targets -->
<DynamicCodeSupport Condition="'$(DynamicCodeSupport)' == '' And ( '$(MtouchInterpreter)' == '' And '$(UseInterpreter)' != 'true' ) And ('$(_PlatformName)' == 'iOS' Or '$(_PlatformName)' == 'tvOS' Or '$(_PlatformName)' == 'MacCatalyst')">false</DynamicCodeSupport>
```

Из этого условия следуют три вещи, и все три противоречат фольклору вокруг этой ошибки.

Дело не в `PublishAot`. Это свойство нигде в цепочке не встречается, поэтому его установка в `false` ничего не меняет.

Дело не в конфигурации Release. В условии нет никакой проверки `Configuration`. Решает то, включён ли интерпретатор, поэтому сборка Debug без интерпретатора тоже получает `IsDynamicCodeSupported = false`, а сборка Release с `UseInterpreter=true` не получает.

К Android это не относится. В списке платформ только iOS, tvOS и Mac Catalyst, поэтому одно и то же решение продолжает работать на Android и Windows, пока iOS падает.

Свойство появилось в [PR #18555 в dotnet/macios](https://github.com/dotnet/macios/pull/18555), "Set `DynamicCodeSupport=false` to enable trimming in full AOT mode", и попало в workload MAUI в диапазоне 8.0.6x. Это совпадает по времени с [dotnet/maui#23595](https://github.com/dotnet/maui/issues/23595), где автор локализовал регрессию между workload 8.0.40 (работал) и 8.0.61 (сломан), не меняя ни строчки кода EF Core.

## Как воспроизвести без iPhone

Поскольку триггером служит один переключатель, воспроизвести и исправить это можно в настольном консольном приложении. Создайте проект и задайте то же свойство, которое задают targets для iOS:

```xml
<!-- .NET SDK 10.0.302, net10.0 -->
<PropertyGroup>
  <TargetFramework>net10.0</TargetFramework>
  <!-- exactly what Xamarin.Shared.Sdk.targets sets for iOS/tvOS/MacCatalyst -->
  <DynamicCodeSupport>false</DynamicCodeSupport>
</PropertyGroup>

<ItemGroup>
  <PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.0.11" />
</ItemGroup>
```

```csharp
// .NET 10, EF Core 10.0.11
using System.Runtime.CompilerServices;
using Microsoft.EntityFrameworkCore;

Console.WriteLine($"IsDynamicCodeSupported = {RuntimeFeature.IsDynamicCodeSupported}");

using var db = new NotesContext();
db.Database.EnsureCreated();

public class Note
{
    public int Id { get; set; }
    public string Text { get; set; } = "";
}

public class NotesContext : DbContext
{
    public DbSet<Note> Notes => Set<Note>();

    protected override void OnConfiguring(DbContextOptionsBuilder o)
        => o.UseSqlite("Data Source=notes.db");
}
```

`dotnet run` печатает `IsDynamicCodeSupported = False`, а затем выбрасывает ровно эту ошибку. Сгенерированный файл `bin/Debug/net10.0/<app>.runtimeconfig.json` показывает, откуда она взялась:

```json
"configProperties": {
  "System.Runtime.CompilerServices.RuntimeFeature.IsDynamicCodeSupported": false
}
```

Такой цикл воспроизведения важен, потому что альтернатива это десятиминутная сборка на устройство на каждую попытку.

## Решение 1: скомпилированная модель и предкомпилированные запросы в общей библиотеке

Это поддерживаемый путь и единственный, который сохраняет выигрыш от обрезки, ради которого переключатель и существует. У него три части, и пропуск любой из них просто приводит вас к следующему исключению.

**Шаг 1: перенесите `DbContext`, сущности и все запросы LINQ в обычную библиотеку классов `net10.0`.** Не `net10.0-ios`. Инструменты `dotnet ef` загружают вашу сборку в процессе времени разработки на хосте, и им нужен проект, который они действительно смогут собрать и загрузить. Обычная библиотека также даёт вам проект, где `IsDynamicCodeSupported` всё ещё равен `true`, а это требуется на следующем шаге.

Слова "все запросы LINQ" здесь не про стиль. Я это проверил: запрос, написанный в проекте приложения, которое ссылается на оптимизированную библиотеку, по-прежнему выбрасывает `Query wasn't precompiled and dynamic code isn't supported with NativeAOT.` Предкомпиляция работает, генерируя перехватчики C# для тех мест вызова, которые она видит, поэтому место вызова в другом проекте для неё невидимо. На практике это подталкивает вас к классу репозитория или сервиса данных внутри библиотеки, где приложениям MAUI и следует держать этот код.

```csharp
// .NET 10, EF Core 10.0.11 - Notes.Data class library
public static class NoteRepository
{
    public static async Task<List<Note>> GetAllAsync()
    {
        using var db = new NotesContext();
        return await db.Notes.OrderBy(n => n.Id).ToListAsync();
    }

    public static async Task<Note?> FindByTextAsync(string text)
    {
        using var db = new NotesContext();
        var needle = text;
        return await db.Notes.FirstOrDefaultAsync(n => n.Text == needle);
    }
}
```

Строка `var needle = text;` не косметическая. Если написать `n.Text == text` напрямую по параметру метода, предкомпиляция в EF Core 10.0.11 падает с `System.Diagnostics.UnreachableException: IdentifierName of type ParameterSymbol: text`. Если сначала скопировать параметр в локальную переменную, тот же запрос предкомпилируется без проблем. Сохраняйте локальную переменную, пока это не исправят в самом проекте.

**Шаг 2: включите перехватчики и сгенерируйте модель.** Добавьте свойство в библиотеку:

```xml
<!-- Notes.Data.csproj, EF Core 10.0.11 -->
<PropertyGroup>
  <InterceptorsNamespaces>$(InterceptorsNamespaces);Microsoft.EntityFrameworkCore.GeneratedInterceptors</InterceptorsNamespaces>
</PropertyGroup>
```

Без него сборка падает с `CS9137: The 'interceptors' feature is not enabled in this namespace`. Если этот код кажется знакомым, это то же самое включение, на котором люди спотыкаются с [перехватчиками генератора исходного кода OpenAPI](/ru/2026/08/fix-the-interceptors-feature-is-not-enabled-in-this-namespace-microsoft-aspnetcore-openapi/).

Затем из каталога библиотеки:

```bash
dotnet ef dbcontext optimize --output-dir CompiledModels --namespace Notes.Data.CompiledModels --precompile-queries --nativeaot
```

При успехе выводится:

```text
Successfully generated a compiled model, it will be discovered automatically, but you can also
call 'options.UseModel(Notes.Data.CompiledModels.NotesContextModel.Instance)'.
Run this command again when the model is modified.
```

Это "discovered automatically" появилось в EF Core 9 и более поздних: генератор пишет `[assembly: DbContextModel(typeof(NotesContext), typeof(NotesContextModel))]` в `NotesContextAssemblyAttributes.cs`, и EF находит его, пока атрибут лежит в той же сборке, что и `DbContext`. В EF Core 8 атрибута нет, и `UseModel` нужно вызывать самому.

**Шаг 3: перегенерируйте при каждом изменении кода.** Перехватчики C# привязаны к позициям в исходном коде, поэтому любая правка в библиотеке делает их недействительными. Документация EF об этом говорит прямо: генерация перехватчиков "isn't expected to happen in the inner loop". Для настоящего приложения добавьте в библиотеку пакет [`Microsoft.EntityFrameworkCore.Tasks`](https://www.nuget.org/packages/Microsoft.EntityFrameworkCore.Tasks) (10.0.11), чтобы это делал MSBuild при публикации, а не расчёт на то, что кто-то вспомнит команду CLI. Путь через CLI я проверил целиком; интеграцию с MSBuild документация рекомендует для CI.

Со всеми тремя частями моё консольное приложение с `DynamicCodeSupport=false` вставляет строку, перечисляет строки и выполняет параметризованный поиск без единого исключения.

## Решение 2: снова включить интерпретатор

Посмотрите на условие macios ещё раз: установка `MtouchInterpreter` или `UseInterpreter` полностью подавляет `DynamicCodeSupport=false`, так что EF Core строит модель во время выполнения ровно так же, как на Android.

```xml
<!-- MAUI app csproj -->
<PropertyGroup Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'ios'">
  <UseInterpreter>true</UseInterpreter>
</PropertyGroup>
```

Это законная конфигурация, а не хак: интерпретатор IL в Mono это не JIT, и Apple его разрешает. Платите вы пропускной способностью и временем запуска, поскольку интерпретируемый код медленнее скомпилированного AOT, а модель по-прежнему строится через рефлексию при первом использовании. Используйте это, чтобы разблокировать релиз, а затем сделайте Решение 1.

Две оговорки. Интерпретатор также отключает удаление IL (`EnableAssemblyILStripping` принудительно ставится в `false`, когда задан `MtouchInterpreter`), так что бандл приложения растёт. И это возможность Mono: targets macios выдают предупреждение "The property 'UseInterpreter' has no effect when not using the Mono runtime (for instance when using CoreCLR)". Это важно на перспективу, потому что [мобильный MAUI работает только на CoreCLR начиная с .NET 11 Preview 6](/ru/2026/07/maui-coreclr-only-runtime-in-dotnet-11-preview-6/). Считайте это решение мостом для .NET 10, а не долгосрочным планом.

## Решение 3: принудительно вернуть DynamicCodeSupport в true

```xml
<PropertyGroup Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'ios'">
  <DynamicCodeSupport>true</DynamicCodeSupport>
</PropertyGroup>
```

Условие в строке macios начинается с `'$(DynamicCodeSupport)' == ''`, поэтому явное значение побеждает и переключатель попадает в `runtimeconfig.json` как `true`. После этого EF Core перестаёт выбрасывать исключение.

Я ставлю это последним не случайно. Переключатель не декоративный: именно он сообщает обрезчику, что тот может удалить пути динамического кода, ради чего и был сделан [PR #18555](https://github.com/dotnet/macios/pull/18555). Установка его в `true`, пока приложение по-прежнему полностью скомпилировано AOT, вводит среду выполнения в заблуждение, и вы начинаете полагаться на то, что каждая библиотека в графе зависимостей стерпит окружение, которое заявляет поддержку динамического кода, которой нет. Если вы уже разобрались, [что на самом деле требует код, безопасный для обрезки](/ru/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/), вы узнаете форму этого риска. Используйте это для диагностики, а не для выпуска.

## EnsureCreated и Migrate продолжают падать после исправления модели

Это шаг, на котором спотыкается большинство приложений MAUI, потому что стандартная инициализация SQLite это вызов `EnsureCreated()` в конструкторе приложения. Со скомпилированной моделью и `IsDynamicCodeSupported = false` оба вызова падают:

```text
EnsureCreated: InvalidOperationException: Design-time DbContext operations are not supported when publishing with NativeAOT.
Migrate:       InvalidOperationException: Design-time DbContext operations are not supported when publishing with NativeAOT.
```

Вернитесь к фрагменту `CreateModel`: скомпилированная модель это `RuntimeModel`, а не `Metadata.Internal.Model`, поэтому любой путь кода, запрашивающий модель времени разработки, уходит в ветку `NativeAotDesignTimeModel`. Создание схемы требует модели времени разработки, чтобы выдать DDL, поэтому из скомпилированной модели оно работать не может. Это ещё одна регрессия EF Core 9: я выполнил тот же вызов `EnsureCreated()` с выключенным переключателем на EF Core 8.0.21, и он создал базу данных без нареканий.

Обходной путь в том, чтобы перестать просить приложение вычислять DDL. Сгенерируйте SQL один раз на хосте и выполните его как текст:

```bash
dotnet ef migrations script -o Migrations.sql
```

```csharp
// .NET 10, EF Core 10.0.11 - runs fine with IsDynamicCodeSupported = false
using var db = new NotesContext();
db.Database.ExecuteSqlRaw(await File.ReadAllTextAsync(scriptPath));
```

Поставляйте `Migrations.sql` как raw asset MAUI и выполняйте при первом запуске. Учтите, что SQLite не поддерживает `--idempotent`; `dotnet ef migrations script --idempotent` падает с сообщением "Generating idempotent scripts for migrations is not currently supported for SQLite", так что отслеживайте применённую миграцию сами или защитите скрипт через `CREATE TABLE IF NOT EXISTS`. То же рассуждение "отдайте скрипт вместо вызова `Migrate()`" применимо, когда [учётная запись миграции не может создать базу данных](/ru/2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update/), только по другим причинам.

## Что изменилось между EF Core 8, 9 и 10

Если ваше приложение работало на iOS с одной лишь скомпилированной моделью и сломалось снова после обновления EF Core, вот почему. Я выполнил один и тот же код с `DynamicCodeSupport=false` и скомпилированной моделью, но без предкомпилированных запросов, на трёх версиях EF Core:

| EF Core | Обнаружение скомпилированной модели | `EnsureCreated()` | Простой запрос LINQ |
| --- | --- | --- | --- |
| 8.0.21 | требуется `UseModel(...)` | работает | работает |
| 9.0.19 | автоматическое | `NativeAotDesignTimeModel` | `QueryNotPrecompiled` |
| 10.0.11 | автоматическое | `NativeAotDesignTimeModel` | `QueryNotPrecompiled` |

В EF Core 8 конвейер запросов всё ещё компилировал LINQ во время выполнения, и интерпретатор выражений это вытягивал. Начиная с EF Core 9 компилятор опирается на тот же переключатель, в [`QueryCompiler.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore/Query/Internal/QueryCompiler.cs):

```csharp
// Microsoft.EntityFrameworkCore 10.0.11, QueryCompiler.ExecuteAsync
var compiledQuery
    = _compiledQueryCache
        .GetOrAddQuery(
            _compiledQueryCacheKeyGenerator.GenerateCacheKey(queryAfterExtraction, async),
            () => RuntimeFeature.IsDynamicCodeSupported
                ? CompileQueryCore<TResult>(_database, queryAfterExtraction, _model, async)
                : throw new InvalidOperationException(CoreStrings.QueryNotPrecompiled));
```

Переключателя AppContext, который вернул бы прежнее поведение, нет. В EF Core 8 хватало скомпилированной модели; начиная с EF Core 9 нужны ещё и предкомпилированные запросы.

## Похожие ошибки

`Query wasn't precompiled and dynamic code isn't supported with NativeAOT.` означает, что скомпилированная модель найдена, а запрос нет. Проверьте, что запрос находится в том проекте, для которого вы выполняли `optimize --precompile-queries`, и что сгенерированный файл `*.EFInterceptors.*.cs` попадает в компиляцию.

`Dynamic LINQ queries are not supported when precompiling queries.` приходит от команды optimize, а не от приложения. Это значит, что запрос собирается из нескольких инструкций (`query = query.Where(...)` внутри `if`). Перепишите его как два полных запроса за условным выражением, как это прямо показано в документации.

`Design-time DbContext operations are not supported when publishing with NativeAOT.` это `EnsureCreated`, `Migrate`, `GenerateCreateScript` или инструмент времени разработки, запущенный на конфигурации с выключенным переключателем. Обратите внимание, что это блокирует и сам `dotnet ef`: запуск `dotnet ef dbcontext optimize` в проекте с `DynamicCodeSupport=false` падает с тем же семейством ошибок NativeAOT, и именно эта проблема курицы и яйца делает отдельную библиотеку классов необходимой.

`PlatformNotSupportedException` при запуске обрезанного или AOT приложения это другой сбой с другой причиной; смотрите заметки о [PlatformNotSupportedException в Native AOT](/ru/2026/05/fix-platformnotsupportedexception-in-native-aot/).

## Связанное

- [Что такое Native AOT и чего он вам стоит?](/ru/2026/06/what-is-native-aot-and-what-does-it-cost-you/) разбирает компромисс, ради которого существует этот переключатель.
- [Мобильный MAUI работает только на CoreCLR в .NET 11 Preview 6](/ru/2026/07/maui-coreclr-only-runtime-in-dotnet-11-preview-6/) объясняет, почему у запасного выхода с интерпретатором есть срок годности.
- [Что такое код, безопасный для обрезки, и как его писать?](/ru/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) даёт фон, почему переопределять переключатель рискованно.
- [Исправление: возможность 'interceptors' не включена в этом пространстве имён](/ru/2026/08/fix-the-interceptors-feature-is-not-enabled-in-this-namespace-microsoft-aspnetcore-openapi/) разбирает CS9137, на который вы наткнётесь на шаге 2.
- [Исправление: CREATE DATABASE permission denied in database 'master'](/ru/2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update/) это другой случай, когда поставка SQL скрипта лучше вызова `Migrate()`.

## Источники

- [Поддержка NativeAOT и предкомпилированные запросы](https://learn.microsoft.com/en-us/ef/core/performance/nativeaot-and-precompiled-queries), документация EF Core, включая включение `InterceptorsNamespaces`, пакет `Microsoft.EntityFrameworkCore.Tasks` и ограничение по динамическим запросам.
- [Скомпилированные модели](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics#compiled-models), документация EF Core, про `dotnet ef dbcontext optimize` и ограничения скомпилированной модели.
- [`DbContextServices.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore/Internal/DbContextServices.cs) и [`QueryCompiler.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore/Query/Internal/QueryCompiler.cs) в `dotnet/efcore`, про обе проверки `RuntimeFeature.IsDynamicCodeSupported`.
- [`Xamarin.Shared.Sdk.targets`](https://github.com/dotnet/macios/blob/main/dotnet/targets/Xamarin.Shared.Sdk.targets) в `dotnet/macios`, про значение по умолчанию `DynamicCodeSupport` и условия интерпретатора.
- [PR #18555 в dotnet/macios](https://github.com/dotnet/macios/pull/18555), который ввёл это свойство.
- [dotnet/maui#23653](https://github.com/dotnet/maui/issues/23653) и [dotnet/maui#23595](https://github.com/dotnet/maui/issues/23595), исходные сообщения, привязывающие регрессию к обновлению workload.
