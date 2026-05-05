---
title: "Исправление: System.InvalidOperationException: No connection string named 'DefaultConnection' could be found"
description: "Если GetConnectionString возвращает null в .NET 11, в вашем appsettings.json нет ключа, файл не копируется в выходной каталог сборки или выбран не тот файл окружения. Три проверки решают 95% случаев."
pubDate: 2026-05-05
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "ef-core"
  - "configuration"
lang: "ru"
translationOf: "2026/05/fix-no-connection-string-named-defaultconnection"
translatedBy: "claude"
translationDate: 2026-05-05
---

Решение: `IConfiguration.GetConnectionString("DefaultConnection")` возвращает `null`, и EF Core бросает исключение, потому что ожидал строку. Либо в вашем `appsettings.json` нет записи `ConnectionStrings:DefaultConnection`, либо файл не копируется в выходной каталог сборки, либо выбрано не то окружение, и ключ существует только в соседнем файле. Проверьте JSON, выставьте `Copy to Output Directory = Copy if newer` и убедитесь, что `ASPNETCORE_ENVIRONMENT` соответствует тому файлу, в который вы записали строку.

```text
Unhandled exception. System.InvalidOperationException: No connection string named 'DefaultConnection' could be found in the application configuration.
   at Microsoft.EntityFrameworkCore.SqlServerDbContextOptionsExtensions.UseSqlServer(DbContextOptionsBuilder optionsBuilder, String connectionString, Action`1 sqlServerOptionsAction)
   at Program.<Main>$(String[] args) in C:\src\Api\Program.cs:line 14
   at Program.<Main>(String[] args)
```

Ошибку выбрасывает `UseSqlServer(string)` из EF Core (и эквиваленты в Npgsql, MySQL, SQLite), когда строковый параметр равен `null`. Текст исключения берётся из проверки параметров EF Core, но корневая причина всегда находится выше по цепочке, в `Microsoft.Extensions.Configuration`. Это руководство написано для .NET 11 preview 4, EF Core 11.0.0-preview.4 и `Microsoft.AspNetCore.App` 11.0.0-preview.4. Те же советы применимы вплоть до .NET Core 3.1.

## Почему GetConnectionString возвращает null

`IConfiguration.GetConnectionString("X")` это синтаксический сахар для `configuration["ConnectionStrings:X"]`. Система конфигурации обходит каждый зарегистрированный провайдер по порядку (JSON-файлы, user secrets, переменные окружения, аргументы командной строки) и возвращает первое совпадение. `null` означает, что **ни один** из провайдеров не имел этого ключа. Есть шесть распространённых причин:

1. Ключа нет в `appsettings.json`.
2. Ключ есть, но файл не копируется в выходной каталог, поэтому работающий бинарник его никогда не видит.
3. Ключ находится в `appsettings.Production.json`, но приложение работает в `Development`, где загружается только `appsettings.Development.json`.
4. Инструменты EF Core времени проектирования (`dotnet ef migrations add`) вызываются из каталога, в котором нет JSON-файла.
5. Ключ хранится в User Secrets, но в `.csproj` проекта отсутствует `<UserSecretsId>`.
6. Строка подключения задана как переменная окружения, но имя использует одинарное подчёркивание (`ConnectionStrings_DefaultConnection`) вместо обязательного двойного (`ConnectionStrings__DefaultConnection`).

Случаи 2 и 6 это тихие убийцы, потому что код выглядит корректно при беглом осмотре.

## Минимальное воспроизведение

Чистый Web API, созданный командой `dotnet new webapi -n Api`, и подключение EF Core. Это минимальная конфигурация, надёжно воспроизводящая ошибку.

```csharp
// .NET 11, C# 14, EF Core 11.0.0
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddDbContext<AppDb>(options =>
    options.UseSqlServer(builder.Configuration.GetConnectionString("DefaultConnection")));

var app = builder.Build();
app.MapGet("/", () => "ok");
app.Run();

public class AppDb : DbContext
{
    public AppDb(DbContextOptions<AppDb> options) : base(options) { }
}
```

```json
// appsettings.json -- this file is what you THINK is being read
{
  "Logging": { "LogLevel": { "Default": "Information" } },
  "AllowedHosts": "*"
}
```

`builder.Configuration.GetConnectionString("DefaultConnection")` возвращает `null`, EF Core бросает на `UseSqlServer(null)`, и хост не собирается. В сообщении исключения упомянуто `DefaultConnection`, что вводит в заблуждение: ничего в EF Core не требует именно такого имени. Любая строка, переданная в `GetConnectionString(...)`, окажется там.

## Решение в три проверки

Выполняйте по порядку. Каждая ловила меня хотя бы раз.

### 1. Убедитесь, что в JSON есть ключ

Откройте `appsettings.json` в проекте, который содержит `Program.cs` (а не в проекте, где определён `DbContext`, если они разные), и добавьте секцию:

```json
// appsettings.json
{
  "ConnectionStrings": {
    "DefaultConnection": "Server=(localdb)\\mssqllocaldb;Database=AppDb;Trusted_Connection=True;TrustServerCertificate=True"
  }
}
```

Имя провайдера в `UseSqlServer` не зависит от формата строки подключения; SQL Server, PostgreSQL, MySQL и SQLite читают одну и ту же форму `ConnectionStrings:Name`. Если в вашем JSON ключ есть, но он лежит во вложенном объекте `Settings`, `GetConnectionString` его не найдёт. Точный путь должен быть `ConnectionStrings.<Name>`.

### 2. Подтвердите, что файл попадает в вывод сборки

Эта проблема цепляется к библиотекам классов и worker-сервисам, у которых шаблон проекта не включает `appsettings.json` по умолчанию. После `dotnet build` проверьте, что файл лежит рядом с вашей DLL:

```bash
dotnet build
ls bin/Debug/net11.0/appsettings.json
```

Если его нет, добавьте в `.csproj`:

```xml
<!-- .NET 11 SDK-style csproj -->
<ItemGroup>
  <None Update="appsettings.json">
    <CopyToOutputDirectory>PreserveNewest</CopyToOutputDirectory>
  </None>
  <None Update="appsettings.*.json">
    <CopyToOutputDirectory>PreserveNewest</CopyToOutputDirectory>
    <DependentUpon>appsettings.json</DependentUpon>
  </None>
</ItemGroup>
```

`Microsoft.NET.Sdk.Web` включает это неявно, поэтому проекту, созданному через `dotnet new webapi`, дополнительная настройка не нужна. Worker-проекты (`Microsoft.NET.Sdk.Worker`) тоже включают. Простой `Microsoft.NET.Sdk` нет, и именно там и живёт большинство таких багов: консольный хост, переиспользованный для `dotnet ef`, или библиотека классов, в которую позже добавили `Program.cs`.

### 3. Сделайте окружение совпадающим с записанным файлом

`WebApplication.CreateBuilder` сначала загружает `appsettings.json`, затем `appsettings.{Environment}.json`, причём второй переопределяет первый. Окружение читается из `ASPNETCORE_ENVIRONMENT` (Web) или `DOTNET_ENVIRONMENT` (общий хост) и по умолчанию `Production`, если ни одна из переменных не задана. Типичный отказ: вы кладёте строку подключения только в `appsettings.Development.json`, а потом запускаете приложение в продакшене, где загружаются только `appsettings.json` и `appsettings.Production.json`.

```bash
# powershell
$env:ASPNETCORE_ENVIRONMENT = "Development"

# bash
export ASPNETCORE_ENVIRONMENT=Development

dotnet run
```

Один раз при старте напечатайте разрешённое значение, чтобы видеть его в логах:

```csharp
// .NET 11, C# 14
var cs = builder.Configuration.GetConnectionString("DefaultConnection");
Console.WriteLine($"DefaultConnection length: {cs?.Length ?? 0}");
```

Никогда не логируйте полную строку подключения в продакшене, потому что там обычно лежат пароли. Логирование длины достаточно, чтобы отличить `null` от "загружена, но пустая" и от "загружена с содержимым".

## Варианты, бьющие по разной аудитории

### `dotnet ef migrations add` из библиотеки классов

Инструменты EF Core времени проектирования разрешают `DbContext` либо вызывая ваш `Program.Main`, либо находя `IDesignTimeDbContextFactory<T>`. Если `DbContext` живёт в библиотеке классов, `dotnet ef` вызывает **стартовый проект** (Web API) и читает его конфигурацию. Запускайте из правильной папки:

```bash
# Bad: connection string is in Api/appsettings.json,
# but you ran this in Data/, where there is no JSON.
cd Data
dotnet ef migrations add Init

# Good: point at the startup project explicitly.
cd Data
dotnet ef migrations add Init --startup-project ../Api/Api.csproj
```

Если миграции нужно запускать из проекта данных автономно (например, в release-пайплайне), добавьте `IDesignTimeDbContextFactory<AppDb>`:

```csharp
// .NET 11, EF Core 11.0.0
public class AppDbFactory : IDesignTimeDbContextFactory<AppDb>
{
    public AppDb CreateDbContext(string[] args)
    {
        var config = new ConfigurationBuilder()
            .SetBasePath(Directory.GetCurrentDirectory())
            .AddJsonFile("appsettings.json", optional: false)
            .AddEnvironmentVariables()
            .Build();

        var options = new DbContextOptionsBuilder<AppDb>()
            .UseSqlServer(config.GetConnectionString("DefaultConnection"))
            .Options;

        return new AppDb(options);
    }
}
```

Эта фабрика только времени проектирования; она не регистрируется в DI и не работает в рантайме.

### Переменные окружения в контейнерах

В Docker и Kubernetes принято расплющивать пути конфигурации двойным подчёркиванием. `ConnectionStrings:DefaultConnection` превращается в `ConnectionStrings__DefaultConnection`. Одинарное подчёркивание это просто обычное имя, и система конфигурации его не распознает.

```yaml
# docker-compose, .NET 11
services:
  api:
    image: api:11.0
    environment:
      ASPNETCORE_ENVIRONMENT: Production
      ConnectionStrings__DefaultConnection: "Server=db;Database=App;User Id=sa;Password=..."
```

```bash
# Kubernetes secret reference
- name: ConnectionStrings__DefaultConnection
  valueFrom:
    secretKeyRef:
      name: db
      key: connection
```

Если переменная корректна, но всё равно не подхватывается, убедитесь, что `AddEnvironmentVariables()` включён в пайплайн конфигурации. `WebApplication.CreateBuilder` делает это за вас. Кастомный `ConfigurationBuilder` в консольном проекте нет, если только вы не добавите его явно.

### User Secrets в разработке

`dotnet user-secrets set "ConnectionStrings:DefaultConnection" "..."` работает только тогда, когда в `.csproj` проекта есть элемент `<UserSecretsId>`:

```xml
<!-- .NET 11 SDK-style csproj -->
<PropertyGroup>
  <TargetFramework>net11.0</TargetFramework>
  <UserSecretsId>aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee</UserSecretsId>
</PropertyGroup>
```

`dotnet user-secrets init` добавляет его за вас. User secrets загружаются только когда `IHostEnvironment.IsDevelopment()` равно `true`, что ещё одна причина, почему важна проверка 3 (про окружение).

### Azure Key Vault и другие провайдеры

Если вы используете `builder.Configuration.AddAzureKeyVault(...)`, имя секрета должно совпадать с путём конфигурации, где `--` это разделитель. Секрет vault с именем `ConnectionStrings--DefaultConnection` появляется как `ConnectionStrings:DefaultConnection`. Секрет с именем `DefaultConnection` нет.

### В ошибке упомянуто незнакомое имя

Если в сообщении написано `No connection string named 'X'` и `X` не то имя, которое вы задавали, скорее всего вы вызываете `UseSqlServer(connectionStringName: "X")` через старую перегрузку EF Core, которая разрешает имена по таблице строк подключения приложения. EF Core 11 всё ещё поддерживает это для обратной совместимости. Решение то же самое: добавить запись `ConnectionStrings:X` или передавать литеральную строку подключения вместо имени.

### Native AOT и обрезка

Если вы публикуетесь с Native AOT, биндинг конфигурации для `GetConnectionString` продолжает работать, потому что это обычный поиск строки. Ошибка, которую вы видите, не предупреждение AOT trim. Если вы дополнительно видите `IL3050`, это предупреждение биндинга для рефлексивного биндинга `Configure<T>`, не для строк подключения.

## Связанное

Для более широкого контекста EF Core, который обычно окружает эту ошибку, посмотрите обзор по [обнаружению N+1 запросов](/ru/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) и руководство по [скомпилированным запросам на горячих путях](/ru/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/). Когда вы прокидываете ту же строку подключения в тесты, [инструкция по Testcontainers](/ru/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) показывает, как поднимать настоящий SQL Server на каждый fixture без коммита учётных данных. Для диагностики таких отказов старта в работающем приложении [настройка Serilog и Seq](/ru/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) делает разрешённую конфигурацию читаемой в продакшен-логах.

## Источники

- [`IConfiguration.GetConnectionString` extension](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.configuration.configurationextensions.getconnectionstring), Microsoft Learn.
- [Configuration in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/configuration/), Microsoft Learn.
- [Design-time DbContext Creation](https://learn.microsoft.com/en-us/ef/core/cli/dbcontext-creation), EF Core docs.
- [Safe storage of app secrets in development](https://learn.microsoft.com/en-us/aspnet/core/security/app-secrets), Microsoft Learn.
- [Environment variables configuration provider](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/configuration/#environment-variables), Microsoft Learn, про разделитель `__`.
