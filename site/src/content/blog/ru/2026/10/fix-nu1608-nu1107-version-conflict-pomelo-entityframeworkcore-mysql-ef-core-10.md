---
title: "Исправление: конфликт версий NU1608 / NU1107 между Pomelo.EntityFrameworkCore.MySql и EF Core 10"
description: "Pomelo 9.0.0 допускает только EF Core Relational 9.0.x, а сборки для EF Core 10 нет. Оставьте все пакеты EF Core на 9.0.x или перейдите на Microting.EntityFrameworkCore.MySql 10.0.x. Подавление предупреждения приводит к падению при запуске."
pubDate: 2026-10-13
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-10"
  - "dotnet-10"
  - "nuget"
  - "mysql"
lang: "ru"
translationOf: "2026/10/fix-nu1608-nu1107-version-conflict-pomelo-entityframeworkcore-mysql-ef-core-10"
translatedBy: "claude"
translationDate: 2026-10-13
---

**Кратко:** `Pomelo.EntityFrameworkCore.MySql` 9.0.0 остаётся самым новым релизом на nuget.org (октябрь 2026) и объявляет `Microsoft.EntityFrameworkCore.Relational` как `[9.0.0, 9.0.999]`. Любой пакет EF Core 10 в графе зависимостей либо конфликтует с этим диапазоном (`NU1107`, ошибка восстановления), либо переопределяет его (`NU1608`, предупреждение). Сборки Pomelo для EF Core 10 не существует, даже в nightly-ленте. Есть два рабочих варианта: оставить все пакеты EF Core и Identity на 9.0.x (они прекрасно работают на `net10.0`) или заменить Pomelo форком `Microting.EntityFrameworkCore.MySql` 10.0.x. Не подавляйте `NU1608` через `NoWarn`: приложение соберётся, а затем упадёт внутри `UseMySql` с `MissingMethodException`.

Всё ниже воспроизведено на macOS с .NET SDK 10.0.302, EF Core 10.0.13 и 9.0.21, Pomelo 9.0.0, Microting 10.0.12 и `MySql.EntityFrameworkCore` 10.0.9 от Oracle.

## Ошибка в контексте

Вы получите одну из двух форм в зависимости от того, какой пакет EF Core 10 вы добавили. Если EF Core 10 подтягивается транзитивно, обычно через `Microsoft.EntityFrameworkCore.Design` или ASP.NET Core Identity, восстановление завершается жёсткой ошибкой:

```text
error NU1107: Version conflict detected for Microsoft.EntityFrameworkCore.Relational. Install/reference Microsoft.EntityFrameworkCore.Relational 10.0.13 directly to project App to resolve this issue.
error NU1107:  App -> Microsoft.EntityFrameworkCore.Design 10.0.13 -> Microsoft.EntityFrameworkCore.Relational (>= 10.0.13)
error NU1107:  App -> Pomelo.EntityFrameworkCore.MySql 9.0.0 -> Microsoft.EntityFrameworkCore.Relational (>= 9.0.0 && <= 9.0.999).
```

Если последовать этому совету и сослаться на `Microsoft.EntityFrameworkCore.Relational` 10.0.13 напрямую, ошибка превратится в предупреждение, потому что прямая ссылка всегда побеждает транзитивный диапазон:

```text
warning NU1608: Detected package version outside of dependency constraint: Pomelo.EntityFrameworkCore.MySql 9.0.0 requires Microsoft.EntityFrameworkCore.Relational (>= 9.0.0 && <= 9.0.999) but version Microsoft.EntityFrameworkCore.Relational 10.0.13 was resolved.
```

А вот что делает такая "исправленная" сборка во время выполнения, на самой первой строке, которая настраивает контекст:

```text
Unhandled exception. System.MissingMethodException: Method not found: 'System.String Microsoft.EntityFrameworkCore.Diagnostics.AbstractionsStrings.ArgumentIsEmpty(System.Object)'.
   at Microsoft.EntityFrameworkCore.Utilities.Check.NullButNotEmpty(String value, String parameterName)
   at Microsoft.EntityFrameworkCore.MySqlDbContextOptionsBuilderExtensions.UseMySql(DbContextOptionsBuilder optionsBuilder, String connectionString, ServerVersion serverVersion, Action`1 mySqlOptionsAction)
```

Сообщение NuGet буквально советует сделать то, что вызывает падение. Поэтому эта ошибка продолжает появляться в трекерах задач спустя месяцы после выхода .NET 10.

## Почему это происходит

Провайдеры EF Core компилируются против внутренних API одной мажорной версии EF Core. Pomelo фиксирует это в nuspec верхней границей:

```xml
<!-- Pomelo.EntityFrameworkCore.MySql 9.0.0 nuspec -->
<group targetFramework="net8.0">
  <dependency id="Microsoft.EntityFrameworkCore.Relational" version="[9.0.0, 9.0.999]" include="All" />
  <dependency id="MySqlConnector" version="2.4.0" exclude="Build,Analyzers" />
</group>
```

NuGet выбирает одну версию каждого пакета на проект. Когда два пути в графе расходятся:

- **Оба транзитивные, диапазоны не пересекаются** (`Design 10 -> Relational >= 10.0.13` против `Pomelo -> Relational <= 9.0.999`): NuGet не может выбрать, поэтому завершается ошибкой `NU1107`.
- **Побеждает одна прямая ссылка** (вы сами ссылаетесь на Relational 10.0.13 или версию закрепляет Central Package Management): NuGet принимает прямую версию и предупреждает через `NU1608`, что ограничение Pomelo нарушено.

Верхняя граница - не перестраховка. Pomelo 9.0.0 вызывает вспомогательные методы вроде `Check.NullButNotEmpty`, которые в EF Core 9 перенаправляют в `AbstractionsStrings.ArgumentIsEmpty(object)`. В EF Core 10 эти внутренние методы ресурсов изменились, поэтому IL в сборке Pomelo указывает на метод, которого больше нет. JIT обнаруживает это только при первом вызове метода, поэтому сборка зелёная, а падение происходит при запуске.

Почему проблема остаётся в октябре 2026, почти через год после GA EF Core 10: [задача Pomelo по отслеживанию EF Core 10 #2007](https://github.com/PomeloFoundation/Pomelo.EntityFrameworkCore.MySql/issues/2007) открыта и набрала более 120 реакций, последний комментарий мейнтейнера (октябрь 2025) обещал релиз "скоро", а несколько PR от сообщества для EF Core 10 так и не влиты. Я проверил и страницу на nuget.org, и nightly-ленту Pomelo в Azure DevOps: самая новая сборка в обоих местах - CI-пакет `9.0.1-servicing` от августа 2025. Версии 10.x, на которую можно обновиться, нет.

## Минимальное воспроизведение

Три проекта на `net10.0`, в каждом Pomelo 9.0.0 плюс один пакет EF Core 10:

```xml
<!-- .NET SDK 10.0.302. Swap the second reference to get each outcome. -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Exe</OutputType>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Pomelo.EntityFrameworkCore.MySql" Version="9.0.0" />
    <!-- NU1107: -->
    <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.13" />
    <!-- NU1107 too: Microsoft.AspNetCore.Identity.EntityFrameworkCore 10.0.13 -->
    <!-- NU1608 + crash: Microsoft.EntityFrameworkCore.Relational 10.0.13 -->
    <!-- No warning at all + crash: Microsoft.EntityFrameworkCore 10.0.13 -->
  </ItemGroup>
</Project>
```

```csharp
// .NET 10, EF Core 9.0.x or 10.0.x depending on the graph above
using Microsoft.EntityFrameworkCore;

var options = new DbContextOptionsBuilder<Shop>()
    .UseMySql("Server=localhost;Database=shop;User=root;Password=x",
              new MySqlServerVersion(new Version(8, 4, 0)))
    .Options;

using var db = new Shop(options);
Console.WriteLine(db.Orders.Where(o => o.Total > 10m).ToQueryString());

public class Order { public int Id { get; set; } public decimal Total { get; set; } }
public class Shop(DbContextOptions<Shop> o) : DbContext(o)
{
    public DbSet<Order> Orders => Set<Order>();
}
```

Последний вариант из этого списка заслуживает отдельного предупреждения. Если добавить `Microsoft.EntityFrameworkCore` 10.0.13 (а не Relational), восстановление проходит молча. `Microsoft.EntityFrameworkCore.Relational` 9.0.0 требует лишь `Microsoft.EntityFrameworkCore >= 9.0.0` без верхней границы, поэтому NuGet спокойно разрешает EF Core 10.0.13 рядом с Relational 9.0.0. Это показывает `dotnet nuget why`:

```text
[net10.0]
 └── Pomelo.EntityFrameworkCore.MySql (v9.0.0)
     └── Microsoft.EntityFrameworkCore.Relational (v9.0.0)
```

Ни `NU1608`, ни `NU1107`, и тот же самый `MissingMethodException` во время выполнения. Если вы видите это исключение без каких-либо предупреждений NuGet, причина именно в этом.

## Исправление подробно

### 1. Найдите все пакеты, которые тянут EF Core 10

Прежде чем что-то менять, выясните, кто запросил 10.x. В проекте, который восстанавливается (случай `NU1608`), путь покажет `dotnet nuget why`:

```bash
dotnet nuget why src/App/App.csproj Microsoft.EntityFrameworkCore.Relational
```

В проекте, застрявшем на `NU1107`, оба пути перечислены в самой ошибке. Обычные подозреваемые в приложении на `net10.0`:

- `Microsoft.EntityFrameworkCore.Design` и `Microsoft.EntityFrameworkCore.Tools`, обновлённые Dependabot или Renovate.
- `Microsoft.AspNetCore.Identity.EntityFrameworkCore`, потому что шаблон Identity использует версию фреймворка (10.0.x).
- `Microsoft.Extensions.Diagnostics.HealthChecks.EntityFrameworkCore`, `Microsoft.EntityFrameworkCore.InMemory` или `.Sqlite` в тестовом проекте, который ссылается на приложение.
- Сторонняя библиотека, уже перешедшая на EF Core 10 (массовые операции, аудит, мультитенантность).
- Файл `Directory.Packages.props`, который закрепляет все пакеты `Microsoft.EntityFrameworkCore.*` на одном общем свойстве версии.

Последнее - ловушка Central Package Management: один `$(EfCoreVersion)`, поднятый до 10.0.x, незаметно превращает транзитивный Relational в закреплённый, так что вы получаете `NU1608` вместо `NU1107` и теряете жёсткую остановку.

### 2. Вариант A: остаться на EF Core 9.0.x на .NET 10

EF Core 9 нацелен на `net8.0`, поэтому работает на среде выполнения .NET 10 без проблем. Закрепите все пакеты EF Core, а также Identity, если он используется, на одном патче 9.0.x:

```xml
<!-- .NET 10 app, EF Core 9.0.21, Pomelo 9.0.0 -->
<ItemGroup>
  <PackageReference Include="Pomelo.EntityFrameworkCore.MySql" Version="9.0.0" />
  <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="9.0.21">
    <PrivateAssets>all</PrivateAssets>
  </PackageReference>
  <PackageReference Include="Microsoft.AspNetCore.Identity.EntityFrameworkCore" Version="9.0.21" />
</ItemGroup>
```

При использовании Central Package Management разделите свойство, чтобы мир провайдера был выделен явно:

```xml
<!-- Directory.Packages.props, .NET 10 solution with Pomelo 9.0.0 -->
<PropertyGroup>
  <!-- Pomelo 9.0.0 caps Relational at 9.0.999. Do not bump until the provider moves. -->
  <EfCoreVersion>9.0.21</EfCoreVersion>
</PropertyGroup>
<ItemGroup>
  <PackageVersion Include="Microsoft.EntityFrameworkCore" Version="$(EfCoreVersion)" />
  <PackageVersion Include="Microsoft.EntityFrameworkCore.Relational" Version="$(EfCoreVersion)" />
  <PackageVersion Include="Microsoft.EntityFrameworkCore.Design" Version="$(EfCoreVersion)" />
  <PackageVersion Include="Microsoft.AspNetCore.Identity.EntityFrameworkCore" Version="$(EfCoreVersion)" />
  <PackageVersion Include="Pomelo.EntityFrameworkCore.MySql" Version="9.0.0" />
</ItemGroup>
```

Я запустил программу из воспроизведения с этим графом на `net10.0`: EF Core и Relational оба сообщают `9.0.21.0`, построение модели, `ToQueryString()` и `GenerateCreateScript()` работают, а проект с Identity 9.0.21 восстанавливается и запускается без проблем. Скажите Dependabot не трогать линейку 9.x (правило `ignore` для `Microsoft.EntityFrameworkCore*` с `update-types: ["version-update:semver-major"]`), иначе он будет заново открывать один и тот же PR каждую неделю.

Подвох - в календаре. EF Core 9 поставляется с окном поддержки .NET 9 STS, которое заканчивается [10 ноября 2026](https://dotnet.microsoft.com/platform/support/policy/dotnet-core). После этой даты исправлений безопасности для пакетов EF Core 9 не будет (EF Core 8 LTS заканчивается в тот же день). Вариант A - мост, а не конечная точка.

### 3. Вариант B: перейти на Microting.EntityFrameworkCore.MySql 10.0.x

[Microting.EntityFrameworkCore.MySql](https://github.com/microting/Pomelo.EntityFrameworkCore.MySql) - форк Pomelo, который выпускает сборки для EF Core 10 с февраля 2026 года, а также имеет `11.0.0-preview.1`. Nuspec версии 10.0.12 нацелен на `net10.0` с `Microsoft.EntityFrameworkCore.Relational [10.0.12, 10.0.999]` и `MySqlConnector 2.6.2`. Именно на него перешло большинство участников обсуждения в задаче Pomelo.

```xml
<!-- .NET 10, EF Core 10.0.13, Microting 10.0.12 -->
<ItemGroup>
  <PackageReference Include="Microting.EntityFrameworkCore.MySql" Version="10.0.12" />
  <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.13">
    <PrivateAssets>all</PrivateAssets>
  </PackageReference>
</ItemGroup>
```

Расширение `UseMySql(...)` и `MySqlServerVersion`/`ServerVersion.AutoDetect` находятся в пространстве имён `Microsoft.EntityFrameworkCore` в обоих пакетах, поэтому мой `Program.cs` из воспроизведения после замены скомпилировался без изменений и вывел тот же MySQL-запрос, что и Pomelo 9.0.0 с EF Core 9:

```text
SELECT `o`.`Id`, `o`.`Customer`, `o`.`Total`
FROM `Orders` AS `o`
WHERE (`o`.`Total` > 10.0) AND (`o`.`Customer` LIKE 'A%')
ORDER BY `o`.`Id`
LIMIT 5
```

Что изменить всё же придётся:

1. Переименуйте каждый `using Pomelo.EntityFrameworkCore.MySql.*;` в `using Microting.EntityFrameworkCore.MySql.*;`. Форк переименовал и сборку, и пространства имён (например, `Pomelo.EntityFrameworkCore.MySql.Infrastructure` становится `Microting.EntityFrameworkCore.MySql.Infrastructure`).
2. Замените и пакеты плагинов: `Pomelo.EntityFrameworkCore.MySql.Json.Microsoft` становится `Microting.EntityFrameworkCore.MySql.Json.Microsoft`, то же для `.Json.Newtonsoft` и `.NetTopologySuite`. Если оставить один плагин Pomelo, Pomelo 9.0.0 и `NU1107` сразу вернутся.
3. Обновите имя провайдера в командах скаффолдинга: `dotnet ef dbcontext scaffold "<conn>" Microting.EntityFrameworkCore.MySql`.
4. Обновите инструмент `dotnet-ef` до 10.0.x, чтобы он совпадал с версией EF Core во время выполнения.
5. Выполните `dotnet ef migrations add ProviderSwapCheck` поверх существующих миграций. Если сгенерированная миграция пуста, снимок модели совместим; удалите её командой `dotnet ef migrations remove`. Если не пуста, прочитайте её, прежде чем что-либо выпускать: этот diff - ровно то, что выполнится на проде.

Трезво оценивайте, что это такое: форк сообщества, поддерживаемый одной компанией, а не официальный провайдер. Закрепите точную версию, читайте заметки о выпуске перед обновлением и следите за обоими репозиториями. Если позже Pomelo выпустит 10.0.0, возврат - то же переименование в обратную сторону.

### 4. Вариант C: MySql.EntityFrameworkCore от Oracle

Провайдер Oracle, [MySql.EntityFrameworkCore](https://www.nuget.org/packages/MySql.EntityFrameworkCore), имеет сборки для EF Core 10 с версии 10.0.0-rc и сейчас на 10.0.9. Его nuspec использует простые нижние границы (`Microsoft.EntityFrameworkCore.Relational >= 10.0.9`), поэтому этот конфликт для него невозможен. Это другой провайдер, а не форк, и API отличается:

```csharp
// .NET 10, EF Core 10.0.13, MySql.EntityFrameworkCore 10.0.9
options.UseMySQL(connectionString); // capital SQL, no ServerVersion argument
```

Он и транслирует запросы иначе. Тот же фильтр `Customer.StartsWith("A")` из воспроизведения превращается в `LIKE CONCAT('A', '%')` плюс сравнение `LEFT(...) = CONVERT(... USING utf8mb4) COLLATE utf8mb4_bin`, тогда как Pomelo и Microting выдают `LIKE 'A%'`. Отображения типов и аннотации миграций тоже отличаются, поэтому ожидайте непустой diff миграции и планируйте полноценный разбор миграций. Выбирайте его, если нужен провайдер от вендора и вы можете позволить такой разбор; иначе вариант B - более мелкое изменение.

### 5. Чего не делать

- **Не добавляйте `<NoWarn>NU1608</NoWarn>`.** Результат показан в воспроизведении: чистая сборка и `MissingMethodException` при первом вызове `UseMySql`. Если `NU1608` обнаружился благодаря `TreatWarningsAsErrors`, эта настройка сделала свою работу.
- **Не ссылайтесь на `Microsoft.EntityFrameworkCore.Relational` 10.x напрямую**, даже если так советует сообщение `NU1107`. Это превращает ошибку в падение.
- **Не смешивайте мажорные версии внутри решения.** Тестовый проект на EF Core 10 InMemory, ссылающийся на приложение на EF Core 9, втягивает обе версии в свой граф, и вы получаете `NU1107` (или тихое несоответствие) только в тестовом проекте.

## Подводные камни и похожие ошибки

- **`MissingMethodException` без предупреждений NuGet**: граф `Microsoft.EntityFrameworkCore` 10 + Relational 9.0.0 из воспроизведения. Выполните `dotnet nuget why <project> Microsoft.EntityFrameworkCore.Relational` и поищите Relational 9.x рядом с EF Core 10.x.
- **`NU1107` или `NU1608` с упоминанием `Pomelo.EntityFrameworkCore.MySql.Json.Microsoft`**: пакеты плагинов повторяют то же ограничение `Microsoft.EntityFrameworkCore.Relational [9.0.0, 9.0.999]` и сами зависят от Pomelo 9.0.0. Обновляйте их синхронно с основным пакетом.
- **`NU1605` (обнаружено понижение версии пакета)**: другая проблема. Что-то в графе требует более новую версию, чем вы закрепили напрямую. Часто появляется сразу после применения варианта A, когда какой-то транзитивный пакет всё ещё хочет EF Core 10. Исправляется поиском и закреплением этого пакета, а не дальнейшим понижением.
- **`dotnet ef` предупреждает, что версия инструментов новее среды выполнения**: само по себе безвредно, но после варианта A держите инструмент `dotnet-ef` на той же мажорной версии, что и пакеты EF Core приложения, чтобы поведение во время разработки совпадало с тем, что работает в продакшене.
- **Пакеты Npgsql или SQL Server версии 10.x в том же решении**: нормально, пока они находятся в разных проектах, которые никогда не делят граф. Один проект - одна мажорная версия EF Core.

## Связанные материалы

- Если `NU1608` обнаружился только потому, что предупреждения ломают сборку, см. [TreatWarningsAsErrors без ущерба для сборок при разработке](/ru/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/): как сохранить строгость, не скрывая реальных проблем.
- Для шаблона общего свойства версии из варианта A см. [миграцию решения .NET на Central Package Management](/ru/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/).
- .NET 10 также изменил, какие транзитивные пакеты вообще попадают в ваш граф: [обрезка пакетов NuGet включена по умолчанию в .NET 10](/ru/2026/05/nuget-package-pruning-default-net-10/).
- Когда расходятся не EF Core и провайдер, а инструмент `dotnet-ef` и SDK, читайте [исправление DotnetToolSettings.xml](/ru/2026/10/fix-settings-file-dotnettoolsettings-xml-was-not-found-in-the-package/).
- Если планируете переход дальше EF Core 9: [миграция с EF Core 6 на EF Core 11: критические изменения, которые действительно бьют](/ru/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

## Источники

- [Pomelo EF Core 10 support tracking issue #2007](https://github.com/PomeloFoundation/Pomelo.EntityFrameworkCore.MySql/issues/2007)
- [Pomelo.EntityFrameworkCore.MySql README: compatibility table and nightly feeds](https://github.com/PomeloFoundation/Pomelo.EntityFrameworkCore.MySql)
- [Pomelo.EntityFrameworkCore.MySql 9.0.0 on NuGet](https://www.nuget.org/packages/Pomelo.EntityFrameworkCore.MySql/9.0.0)
- [Microting.EntityFrameworkCore.MySql on NuGet](https://www.nuget.org/packages/Microting.EntityFrameworkCore.MySql) and [its README on the namespace rename](https://github.com/microting/Pomelo.EntityFrameworkCore.MySql)
- [MySql.EntityFrameworkCore on NuGet](https://www.nuget.org/packages/MySql.EntityFrameworkCore)
- [NuGet warning NU1608](https://learn.microsoft.com/nuget/reference/errors-and-warnings/nu1608) and [NuGet error NU1107](https://learn.microsoft.com/nuget/reference/errors-and-warnings/nu1107)
- [.NET and .NET Core support policy](https://dotnet.microsoft.com/platform/support/policy/dotnet-core)
