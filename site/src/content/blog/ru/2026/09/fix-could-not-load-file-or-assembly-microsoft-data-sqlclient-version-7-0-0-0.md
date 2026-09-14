---
title: "Исправление: Could not load file or assembly 'Microsoft.Data.SqlClient, Version=7.0.0.0' после обновления EF Core"
description: "EF Core 11 скомпилирован против Microsoft.Data.SqlClient 7.0.0.0, но при восстановлении пакетов или развёртывании победила копия 6.x. Удалите старую фиксацию версии SqlClient и заново разверните весь вывод сборки."
pubDate: 2026-09-14
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "dotnet"
  - "dotnet-11"
lang: "ru"
translationOf: "2026/09/fix-could-not-load-file-or-assembly-microsoft-data-sqlclient-version-7-0-0-0"
translatedBy: "claude"
translationDate: 2026-09-14
---

**Коротко:** `Microsoft.EntityFrameworkCore.SqlServer` 11 (проверено на `11.0.0-rc.1.26425.128`, .NET 11 RC 1) скомпилирован против `Microsoft.Data.SqlClient, Version=7.0.0.0` и требует пакет 7.0.2 или новее. Исключение означает, что процесс нашёл SqlClient версии 6.x или не нашёл его вовсе. Удалите оставшуюся ссылку на `Microsoft.Data.SqlClient` 6.x (или её `PackageVersion` в `Directory.Packages.props`), уберите любой `NoWarn` для `NU1605`, пересоберите проект и заново разверните всю папку вывода, включая `runtimes/`.

Дальше в статье показано, откуда берётся копия 6.x, как найти её меньше чем за минуту, и две похожие ошибки, которые уводят людей к неправильному исправлению. Каждый сценарий ниже воспроизведён на macOS с SDK .NET 11 RC 1 (`11.0.100-rc.1.26425.128`) и SDK 10.0.302; база данных для воспроизведения не нужна.

## Ошибка в контексте

EF Core не трогает SqlClient при регистрации контекста. Загрузка происходит, когда провайдер впервые строит свои сопоставления типов, то есть при первом запросе, `SaveChanges`, `MigrateAsync` или `Database.GetDbConnection()`. Вот цепочка исключений, которую вывело моё воспроизведение, начиная с внешнего:

```text
System.TypeInitializationException: The type initializer for 'Microsoft.EntityFrameworkCore.SqlServer.Storage.Internal.SqlServerTypeMappingSource' threw an exception.
System.TypeInitializationException: The type initializer for 'Microsoft.EntityFrameworkCore.SqlServer.Storage.Internal.SqlServerVectorTypeMapping' threw an exception.
System.IO.FileNotFoundException: Could not load file or assembly 'Microsoft.Data.SqlClient, Version=7.0.0.0, Culture=neutral, PublicKeyToken=23ec7fc2d6eaa4a5'. The system cannot find the file specified.
```

Если в журналах виден только внешний `TypeInitializationException`, дважды разверните `InnerException`. Настоящая ошибка это `FileNotFoundException` в самом низу.

Прежде чем начать, важно знать одно: `Version=7.0.0.0` это версия **сборки**, а не версия пакета. SqlClient фиксирует `AssemblyVersion` как `Major.0.0.0` для каждого релиза в пределах мажорной линейки, поэтому пакет 7.0.3 поставляет DLL с версией сборки `7.0.0.0` (версия файла `7.0.3.26253`). Мейнтейнеры подтвердили, что это сделано намеренно, в [dotnet/SqlClient#4310](https://github.com/dotnet/SqlClient/issues/4310). Ссылку удовлетворяет любой пакет 7.x. Искать "ровно 7.0.0" не нужно.

## Почему это происходит

Среда выполнения привязывается по версии сборки и умеет только повышать версию, но никогда не понижать. Когда EF Core 11 запрашивает `7.0.0.0`, а единственный `Microsoft.Data.SqlClient.dll` на пути поиска относится к сборке 6.x (версия сборки `6.0.0.0`), загрузка завершается ошибкой. Причём с обманчивым сообщением "cannot find the file specified", даже когда файл 6.x лежит ровно по тому пути, на который указывает `.deps.json`. Я проверил это отдельно: если положить DLL 6.1.6 поверх 7.0.2 в папке вывода, сообщение получается идентичным.

Вот против чего скомпилирован каждый пакет, по данным метаданных сборок прямо из пакетов NuGet:

| Пакет | Зависимость от пакета SqlClient | Ссылка на сборку в DLL |
| --- | --- | --- |
| `Microsoft.EntityFrameworkCore.SqlServer` 10.0.10, 10.0.11, 10.0.12 | `>= 6.1.x` (10.0.12: `>= 6.1.6`) | `Microsoft.Data.SqlClient 6.0.0.0` |
| `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0-rc.1.26425.128 | `>= 7.0.2` | `Microsoft.Data.SqlClient 7.0.0.0` |

Значит, на EF Core 10 сам провайдер никогда не запрашивает 7.0.0.0. На EF Core 11 он запрашивает её всегда. Вот способы, которыми копия 6.x всё равно побеждает, в порядке того, как часто я их встречаю:

1. **Оставшаяся прямая ссылка на `Microsoft.Data.SqlClient` 6.x с заглушённым предупреждением о понижении версии.** Многие проекты на EF Core 8-10 добавляли явную ссылку на SqlClient, чтобы получить исправление или поддержку Entra ID. После обновления EF эта фиксация версии становится понижением. NuGet сообщает о нём как `NU1605`, и SDK считает это ошибкой, если только в проекте нет `<NoWarn>NU1605</NoWarn>`, оставшегося от какого-то прежнего конфликта.
2. **Развёртывание теряет или подменяет DLL.** У SqlClient нет переносимой реализации. Настоящие сборки лежат в `runtimes/unix/lib/net9.0/` и `runtimes/win/lib/net9.0/`. Dockerfile или скрипт копирования, который берёт только `*.dll` из корня `bin/` или распаковывает новую сборку поверх старой папки, оставляет приложение без SqlClient 7.x.
3. **Хост плагинов загружает ваш слой данных динамически.** В процессе хоста нет записи `.deps.json` для SqlClient, поэтому его контекст загрузки по умолчанию не может разрешить зависимости плагина.

## Минимальное воспроизведение

Консольное приложение, которое было на EF Core 10 с фиксацией версии SqlClient и обновлено до EF Core 11 RC 1. Именно строка `NoWarn` превращает ошибку сборки в падение во время выполнения:

```xml
<!-- .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net11.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <NoWarn>$(NoWarn);NU1605</NoWarn>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0-rc.1.26425.128" />
    <PackageReference Include="Microsoft.Data.SqlClient" Version="6.1.6" />
  </ItemGroup>
</Project>
```

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
using Microsoft.EntityFrameworkCore;

var options = new DbContextOptionsBuilder<ShopDb>()
    .UseSqlServer("Server=localhost;Database=Shop;User ID=sa;Password=x;TrustServerCertificate=True")
    .Options;

using var db = new ShopDb(options);
// Throws the FileNotFoundException above; no server connection is attempted.
Console.WriteLine(db.Database.GetDbConnection().GetType().Assembly.GetName());

class ShopDb(DbContextOptions<ShopDb> options) : DbContext(options);
```

Уберите строку `NoWarn`, и сборка остановится уже на восстановлении пакетов, чего вы и добиваетесь:

```text
error NU1605: Warning As Error: Detected package downgrade: Microsoft.Data.SqlClient from 7.0.2 to 6.1.6. Reference the package directly from the project to select a different version.
error NU1605:  app -> Microsoft.EntityFrameworkCore.SqlServer 11.0.0-rc.1.26425.128 -> Microsoft.Data.SqlClient (>= 7.0.2)
error NU1605:  app -> Microsoft.Data.SqlClient (>= 6.1.6)
```

Без фиксации версии та же программа выводит `Microsoft.Data.SqlClient, Version=7.0.0.0, Culture=neutral, PublicKeyToken=23ec7fc2d6eaa4a5`.

## Исправление по шагам

### 1. Выясните, кто поставляет копию 6.x

Не гадайте. Запросите у NuGet граф зависимостей стартового проекта, а не библиотеки классов:

```bash
# .NET SDK 10.0.302 or .NET 11 RC 1 SDK
dotnet nuget why src/Shop.Api/Shop.Api.csproj Microsoft.Data.SqlClient
dotnet list src/Shop.Api/Shop.Api.csproj package --include-transitive
```

`dotnet nuget why` выводит дерево для каждого целевого фреймворка, так что прямая ссылка на 6.x или пакет, который её подтягивает, видны сразу. Затем проверьте, что на самом деле записано для среды выполнения, ведь именно это читает хост:

```bash
# .NET 11 RC 1 SDK
grep -A3 '"Microsoft.Data.SqlClient/' src/Shop.Api/bin/Release/net11.0/Shop.Api.deps.json
```

Если `.deps.json` указывает `7.0.x`, а приложение всё равно падает, проблема в развёртывании (шаг 4), а не в восстановлении пакетов.

### 2. Удалите или поднимите фиксацию версии SqlClient

Если вашему коду не нужна конкретная версия SqlClient, удалите прямую ссылку и позвольте EF Core подтянуть ту версию, против которой он собран. Если хотите оставить ссылку явной, поднимите её до текущей 7.x:

```xml
<!-- .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128 -->
<ItemGroup>
  <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0-rc.1.26425.128" />
  <!-- Was 6.1.6. Any 7.x works; 7.0.3 is the latest stable at the time of writing. -->
  <PackageReference Include="Microsoft.Data.SqlClient" Version="7.0.3" />
</ItemGroup>
```

При использовании [Central Package Management](/ru/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/) с транзитивной фиксацией версий фиксация находится в `Directory.Packages.props`, а у ошибки восстановления другой код:

```text
error NU1109: Detected package downgrade: Microsoft.Data.SqlClient from 7.0.2 to centrally defined 6.1.6. Update the centrally managed package version to a higher version.
```

Обновите саму запись `PackageVersion`:

```xml
<!-- .NET 11 RC 1, Directory.Packages.props -->
<ItemGroup>
  <PackageVersion Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0-rc.1.26425.128" />
  <PackageVersion Include="Microsoft.Data.SqlClient" Version="7.0.3" />
</ItemGroup>
```

### 3. Перестаньте подавлять NU1605

Поищите в решении `NU1605` внутри `NoWarn`, включая `Directory.Build.props`. Это подавление единственная причина, по которой проблема вообще доходит до среды выполнения при обычной сборке. Без него следующий, кто снова внесёт понижение версии, получит ошибку восстановления с точным путём пакета вместо падения в продакшене.

### 4. Разверните заново весь вывод, включая `runtimes/`

При framework-dependent сборке без RID настоящая реализация SqlClient лежит в `runtimes/<os>/lib/net9.0/`, и `.deps.json` указывает туда. Я удалил этот единственный файл из рабочей сборки и получил тот же `FileNotFoundException`; удаление всей папки `runtimes/` приводит к тому же. Если ваш Dockerfile или конвейер копирует файлы выборочно, перейдите на копирование всей папки публикации:

```dockerfile
# .NET 11 RC 1 images
FROM mcr.microsoft.com/dotnet/sdk:11.0 AS build
WORKDIR /src
COPY . .
RUN dotnet publish src/Shop.Api/Shop.Api.csproj -c Release -r linux-x64 --self-contained false -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:11.0
WORKDIR /app
COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "Shop.Api.dll"]
```

Публикация с RID (`-r linux-x64`) выносит платформенно-специфичный SqlClient в корень рядом с `Microsoft.Data.SqlClient.Extensions.Abstractions.dll` и `Microsoft.Data.SqlClient.Internal.Logging.dll`, и такую структуру сломать гораздо труднее. Для IIS, zip-развёртывания в Azure App Service или развёртывания через xcopy разворачивайте в чистую папку, чтобы DLL 6.x от предыдущего релиза не могла уцелеть рядом с новым `.deps.json`. Если вы не уверены, какой вывод нужно поставлять, `dotnet build` или `dotnet publish`, здесь важна [разница между ними](/ru/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/).

### 5. Добавьте расширение для Azure, если используете Entra ID

Переход на SqlClient 7.0 указан как изменение средней значимости в [критических изменениях EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/breaking-changes). Аутентификация Entra ID (`Active Directory Default`, управляемое удостоверение, субъект-служба) вынесена из основного пакета. После исправления ошибки загрузки строке подключения, которая её использует, нужна ещё одна ссылка:

```xml
<!-- .NET 11 RC 1, Microsoft.Data.SqlClient 7.x -->
<PackageReference Include="Microsoft.Data.SqlClient.Extensions.Azure" Version="7.0.3" />
```

Держите этот пакет на той же версии, что и `Microsoft.Data.SqlClient`. Начиная с 7.0.2, SqlClient, `Extensions.Azure` и `Extensions.Abstractions` выпускаются синхронно, а SqlClient 7.0.2 требует `Extensions.Abstractions` в диапазоне `[7.0.2, 8.0.0)`. В NuGet нет версии 7.0.0 пакета для Azure: его версии идут 1.0.0, 7.0.2, 7.0.3, поэтому `Version="7.0.0"`, скопированный из фрагмента документации, не разрешается именно в эту версию. Без пакета 7.0 выбрасывает понятную ошибку, в которой он назван, так что гадать не придётся. [Руководство по миграции с EF Core 6 на EF Core 11](/ru/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) описывает это вместе с другими изменениями, связанными с SqlClient.

### 6. Хосты плагинов: загружайте через `AssemblyLoadContext`

Если хост без ссылки на EF Core загружает ваш слой данных через `Assembly.LoadFrom`, в контексте хоста по умолчанию нет записи `.deps.json` для SqlClient. Ответ мейнтейнеров в [#4310](https://github.com/dotnet/SqlClient/issues/4310) это стандартный паттерн плагинов. Соберите плагин с `<EnableDynamicLoading>true</EnableDynamicLoading>` и загружайте его через контекст, который читает собственный `.deps.json` плагина:

```csharp
// .NET 11 RC 1
using System.Reflection;
using System.Runtime.Loader;

sealed class PluginLoadContext(string pluginPath) : AssemblyLoadContext(isCollectible: false)
{
    private readonly AssemblyDependencyResolver _resolver = new(pluginPath);

    protected override Assembly? Load(AssemblyName name)
    {
        var path = _resolver.ResolveAssemblyToPath(name);
        return path is null ? null : LoadFromAssemblyPath(path);
    }

    protected override IntPtr LoadUnmanagedDll(string unmanagedDllName)
    {
        var path = _resolver.ResolveUnmanagedDllToPath(unmanagedDllName);
        return path is null ? IntPtr.Zero : LoadUnmanagedDllFromPath(path);
    }
}

// var asm = new PluginLoadContext(pluginPath).LoadFromAssemblyPath(pluginPath);
```

В моём тесте тот же плагин падал при `Assembly.LoadFrom` и без проблем загружал `Microsoft.Data.SqlClient, Version=7.0.0.0` через этот контекст. Для SqlClient резолвер особенно важен: он сопоставляет запрос с нужным файлом из `runtimes/<os>/`, а не со сборкой-заглушкой в корне.

## Подводные камни и похожие ошибки

**"Но я всё ещё на EF Core 10."** Тогда 7.0.0.0 запрашивает не EF. DLL провайдера версий с 10.0.10 по 10.0.12 ссылаются на `6.0.0.0`. Поэтому [dotnet/efcore#38845](https://github.com/dotnet/efcore/issues/38845), где об этой ошибке сообщили после перехода с 10.0.10 на 10.0.11, закрыли без воспроизведения. Против 7.x скомпилировано что-то другое в графе. Частый источник это Aspire. `Aspire.Microsoft.EntityFrameworkCore.SqlServer` 13.5.3 зависит одновременно от `Microsoft.Data.SqlClient >= 7.0.1` и от EF Core 10.0.11, поэтому `dotnet nuget why` для сервиса Aspire показывает SqlClient, разрешённый в 7.0.1, в приложении на EF Core 10. Такая комбинация работает: в моём тесте EF Core 10.0.12 инициализировал свои сопоставления типов и создал `SqlConnection` как на SqlClient 7.0.0, так и на 7.0.3. Ломается она, только когда побеждает фиксация версии 6.x или устаревшее развёртывание, а это возвращает вас к шагам 1-4.

**`Could not load type 'Microsoft.Data.SqlClient.SqlAuthenticationMethod' from assembly 'Microsoft.Data.SqlClient, Version=7.0.0.0'`.** Это другой сбой с той же строкой версии. Файл загрузился нормально, но библиотека, скомпилированная против 6.x (чаще всего это была SQL Server Management Objects 181.x), искала тип, который в 7.0.0 переехал в `Microsoft.Data.SqlClient.Extensions.Abstractions`. SqlClient 7.0.1 добавил переадресацию типов для `SqlAuthenticationMethod`, `SqlAuthenticationProvider` и трёх связанных типов ([#4117](https://github.com/dotnet/SqlClient/pull/4117)), поэтому обновление SqlClient до 7.0.1 или новее это исправляет.

**`PlatformNotSupportedException: Microsoft.Data.SqlClient is not supported on this platform.`** Файл нашёлся, но не тот. Сборка в корневой папке `lib/` пакета это заглушка, а рабочая реализация лежит в `runtimes/`. Мой хост плагинов столкнулся ровно с этим при `Assembly.LoadFrom`, потому что в корневой папке плагина лежала заглушка. Исправление то же: `AssemblyLoadContext` из шага 6 или полное развёртывание с ресурсами для конкретного RID.

**В сообщении другое имя сборки.** Если ошибка называет вашу собственную библиотеку или другой пакет, описанные выше особенности SqlClient не применимы. Общий порядок действий при [ошибке "Could not load file or assembly" в опубликованном приложении](/ru/2026/05/fix-could-not-load-file-or-assembly-in-published-app/) охватывает трассировку хоста и тримминг. Для варианта несовпадения в инструментах EF, когда падает `dotnet ef`, а не ваше приложение, см. [MissingMethodException после обновления EF Core Tools](/ru/2026/09/fix-missingmethodexception-argumentisempty-after-upgrading-ef-core-tools/).

## Связанные материалы

- [Миграция решения .NET на Central Package Management с Directory.Packages.props](/ru/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/)
- [Миграция с EF Core 6 на EF Core 11: критические изменения, которые действительно мешают](/ru/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)
- [Исправление FileNotFoundException "Could not load file or assembly" в опубликованном приложении](/ru/2026/05/fix-could-not-load-file-or-assembly-in-published-app/)
- [Нативный столбец json против nvarchar(max) в SQL Server с EF Core 11](/ru/2026/09/json-vs-nvarchar-max-for-storing-json-in-sql-server-with-ef-core-11/), где показан `SqlDbType.Json` из SqlClient 7 в действии
- [В чём разница между dotnet build и dotnet publish](/ru/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/)

## Источники

- [Критические изменения в EF Core 11: Microsoft.Data.SqlClient обновлён до 7.0](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/breaking-changes)
- [Заметки о выпуске Microsoft.Data.SqlClient 7.0.0](https://github.com/dotnet/SqlClient/blob/main/release-notes/7.0/7.0.0.md) и [заметки о выпуске 7.0.1](https://github.com/dotnet/SqlClient/blob/main/release-notes/7.0/7.0.1.md)
- [dotnet/SqlClient#4310: версия сборки остаётся 7.0.0.0 во всей линейке 7.x, рекомендации по загрузке плагинов](https://github.com/dotnet/SqlClient/issues/4310)
- [dotnet/efcore#38845: сообщение об ошибке в EF Core 10.0.11](https://github.com/dotnet/efcore/issues/38845)
- [dotnet/SqlClient#4064](https://github.com/dotnet/SqlClient/issues/4064) и [#4117](https://github.com/dotnet/SqlClient/pull/4117): переадресация типа `SqlAuthenticationMethod`
- [Предупреждение NuGet NU1605](https://learn.microsoft.com/en-us/nuget/reference/errors-and-warnings/nu1605) и [ошибка NU1109](https://learn.microsoft.com/en-us/nuget/reference/errors-and-warnings/nu1109)
- [Создание приложения .NET с поддержкой плагинов](https://learn.microsoft.com/en-us/dotnet/core/tutorials/creating-app-with-plugin-support) и [Поиск сборок по умолчанию](https://learn.microsoft.com/en-us/dotnet/core/dependency-loading/default-probing)
