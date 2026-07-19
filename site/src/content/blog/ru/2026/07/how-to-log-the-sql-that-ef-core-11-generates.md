---
title: "Как логировать SQL, который генерирует EF Core 11"
description: "Смотрите точный SQL, который Entity Framework Core 11 отправляет в базу данных, вместе со значениями параметров, с помощью LogTo, Microsoft.Extensions.Logging и ToQueryString."
pubDate: 2026-07-19
tags:
  - "ef-core"
  - "dotnet"
  - "csharp"
  - "logging"
lang: "ru"
translationOf: "2026/07/how-to-log-the-sql-that-ef-core-11-generates"
translatedBy: "claude"
translationDate: 2026-07-19
---

Самый быстрый способ увидеть SQL, который генерирует Entity Framework Core 11, - вызвать `LogTo(Console.WriteLine)` на вашем `DbContextOptionsBuilder`. Это выводит каждую команду, которую EF Core отправляет в базу данных, на уровне `Information`, в категории `Microsoft.EntityFrameworkCore.Database.Command`. В приложении ASP.NET Core это обычно даже не нужно: задайте `Microsoft.EntityFrameworkCore.Database.Command` со значением `Information` в `appsettings.json`, и SQL пойдёт через уже имеющееся журналирование. Чтобы увидеть реальные значения параметров вместо `?`, добавьте `EnableSensitiveDataLogging()`. Чтобы получить SQL для одного запроса без его выполнения, вызовите `.ToQueryString()`.

Эта статья охватывает все эти варианты, объясняет, когда каждый из них - правильный инструмент, и разбирает детали, о которые спотыкаются: почему по умолчанию вы ничего не видите, почему параметры скрыты и почему `EnableSensitiveDataLogging` никогда нельзя выводить в продакшен. Всё описанное здесь актуально для EF Core 11 и C# 14 на .NET 11.

## Почему по умолчанию вы не видите SQL

EF Core ничего не логирует, пока вы не укажете, куда отправлять журналы. Это сделано намеренно. Формирование сообщения журнала стоит ресурсов, поэтому EF Core полностью пропускает эту работу, когда не настроен ни один приёмник. Это смена подхода по сравнению с EF6, где `Database.Log` можно было подключить в любой момент. В EF Core журналирование настраивается один раз, при инициализации контекста, и фреймворк генерирует сообщения только тогда, когда приёмник присутствует.

Каждая SQL-команда, которую выполняет EF Core, логируется как единое событие: `RelationalEventId.CommandExecuted`, событие с ID `20101`, в категории `Microsoft.EntityFrameworkCore.Database.Command`, на уровне `LogLevel.Information`. Эта последняя деталь важна. Если ваше журналирование отфильтровано до `Warning` и выше, что является распространённым продакшен-значением по умолчанию, SQL генерируется внутри, но никогда не достигает вашего приёмника. Увидеть SQL почти всегда - это вопрос понижения уровня для этой одной категории, а не включения какого-то особого переключателя.

## Одна строка: LogTo

`LogTo` - это встроенное "простое журналирование" EF Core. Оно не требует пакета NuGet и внедрения зависимостей. Оно принимает `Action<string>`, который EF Core вызывает по одному разу на каждое сообщение журнала.

```csharp
// EF Core 11, C# 14, .NET 11
public sealed class AppDbContext : DbContext
{
    protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
        => optionsBuilder
            .UseSqlServer("Server=(localdb)\\mssqllocaldb;Database=Shop;Trusted_Connection=True")
            .LogTo(Console.WriteLine);

    public DbSet<Order> Orders => Set<Order>();
}
```

Выполните запрос - и вы получите команду, её параметры, время и текст SQL:

```output
info: RelationalEventId.CommandExecuted[20101] (Microsoft.EntityFrameworkCore.Database.Command)
      Executed DbCommand (3ms) [Parameters=[@__customerId_0='?' (DbType = Int32)], CommandType='Text', CommandTimeout='30']
      SELECT [o].[Id], [o].[CustomerId], [o].[Total]
      FROM [Orders] AS [o]
      WHERE [o].[CustomerId] = @__customerId_0
```

`OnConfiguring` по-прежнему вызывается, даже когда вы строите контекст через `AddDbContext` или передаёте заранее созданный `DbContextOptions`, поэтому это единственное место для размещения настройки журналирования независимо от того, как построен контекст. Если вы уже регистрируете параметры в `Program.cs`, можете добавить `LogTo` там же:

```csharp
// EF Core 11, .NET 11 - Program.cs
builder.Services.AddDbContext<AppDbContext>(options =>
    options
        .UseSqlServer(connectionString)
        .LogTo(Console.WriteLine, LogLevel.Information));
```

Второй аргумент поднимает минимальный уровень. По умолчанию `LogTo` выдаёт всё на уровне `Debug` и выше, что довольно шумно. Передача `LogLevel.Information` сокращает вывод до обращений к базе данных плюс несколько служебных сообщений, что обычно и нужно, когда вы отслеживаете запрос.

## Показ значений параметров вместо вопросительных знаков

Обратите внимание на `@__customerId_0='?'` в выводе выше. EF Core по умолчанию скрывает значения параметров, потому что они могут быть персональными или конфиденциальными данными, которые не должны попадать в файл журнала. Когда вы отлаживаете локально и вам нужно увидеть, какое значение было фактически отправлено, включите журналирование конфиденциальных данных:

```csharp
// EF Core 11 - only ever do this in Development
optionsBuilder
    .UseSqlServer(connectionString)
    .LogTo(Console.WriteLine, LogLevel.Information)
    .EnableSensitiveDataLogging();
```

Теперь параметр материализуется:

```output
Executed DbCommand (2ms) [Parameters=[@__customerId_0='42' (DbType = Int32)], ...]
SELECT [o].[Id], [o].[CustomerId], [o].[Total]
FROM [Orders] AS [o]
WHERE [o].[CustomerId] = @__customerId_0
```

Защитите это проверкой окружения, чтобы оно никогда не активировалось в продакшене. Утёкший журнал запросов с реальными значениями ключей - это настоящий риск раскрытия данных:

```csharp
// EF Core 11, .NET 11
optionsBuilder.UseSqlServer(connectionString);
if (builder.Environment.IsDevelopment())
{
    optionsBuilder
        .LogTo(Console.WriteLine, LogLevel.Information)
        .EnableSensitiveDataLogging();
}
```

Раз уж вы здесь, `EnableDetailedErrors()` - полезное дополнение. EF Core пропускает блоки try-catch для каждого значения ради производительности, из-за чего некоторые ошибки (например, `NULL`, возвращённый для свойства, не допускающего null) трудно привязать к конкретному полю. `EnableDetailedErrors()` возвращает эти проверки и выдаёт сообщение с именем проблемного свойства. Это средство отладки, а не продакшен-настройка.

## Способ ASP.NET Core: Microsoft.Extensions.Logging

В приложении ASP.NET Core `LogTo` вам почти никогда не нужен. `AddDbContext` и `AddDbContextPool` автоматически подключают EF Core к конвейеру `Microsoft.Extensions.Logging` приложения, поэтому SQL от EF Core проходит через тот же логгер, провайдеры и фильтры, что и остальная часть вашего приложения. Вы управляете этим полностью из `appsettings.json`, задавая уровень для категории команд:

```json
{
  "Logging": {
    "LogLevel": {
      "Default": "Information",
      "Microsoft.AspNetCore": "Warning",
      "Microsoft.EntityFrameworkCore.Database.Command": "Information"
    }
  }
}
```

Эта одна строка - весь секрет. Категория иерархична, поэтому `Microsoft.EntityFrameworkCore.Database.Command` нацелена именно на события выполненных команд и ни на что больше. Поместите её в `appsettings.Development.json`, чтобы видеть SQL локально, сохраняя тишину в продакшене, а затем включайте её без повторного развёртывания, когда нужно что-то диагностировать в работающей среде.

Если вы предпочитаете держать всё в коде или находитесь в консольном приложении, использующем универсальный хост, зарегистрируйте `ILoggerFactory` и передайте его EF Core через `UseLoggerFactory`. Храните фабрику как единый общий экземпляр; создание её на каждый контекст приводит к утечке памяти и сводит на нет внутреннее кеширование.

```csharp
// EF Core 11, .NET 11
public static readonly ILoggerFactory DbLoggerFactory =
    LoggerFactory.Create(b => b.AddConsole().AddFilter(
        "Microsoft.EntityFrameworkCore.Database.Command", LogLevel.Information));

protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
    => optionsBuilder
        .UseSqlServer(connectionString)
        .UseLoggerFactory(DbLoggerFactory);
```

Поскольку этот путь - стандартный `Microsoft.Extensions.Logging`, любой провайдер подключается точно так же. Если вы направляете журналы через Serilog, SQL от EF Core попадает в ваши приёмники без дополнительной настройки, специфичной для EF. Это тот же конвейер, что рассматривается в [структурированном журналировании с Serilog и Seq](/ru/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/); EF Core - просто ещё одна категория, питающая его.

## Отфильтровать до чистого SQL

`LogTo` даёт три способа сузить поток только до тех команд, которые вас интересуют. Самый читаемый - по категории. Используйте строго типизированные имена `DbLoggerCategory`, чтобы не жёстко прописывать строки:

```csharp
// EF Core 11 - only database interactions
optionsBuilder.LogTo(
    Console.WriteLine,
    new[] { DbLoggerCategory.Database.Command.Name },
    LogLevel.Information);
```

Можно также фильтровать по ID события, когда вам нужно одно точное событие и ничего больше. Только для сырого SQL это `RelationalEventId.CommandExecuted`:

```csharp
// EF Core 11 - only the executed-command event
optionsBuilder.LogTo(
    Console.WriteLine,
    new[] { RelationalEventId.CommandExecuted });
```

А для всего, что встроенные варианты выразить не могут, передайте предикат над `(eventId, logLevel)`. Это фильтрует в горячем пути EF Core, до того как формируется строка сообщения, поэтому дешевле, чем фильтрация внутри вашего делегата:

```csharp
// EF Core 11 - custom filter
optionsBuilder.LogTo(
    Console.WriteLine,
    (eventId, level) => eventId == RelationalEventId.CommandExecuted);
```

Фильтрация здесь - это способ сохранить журналы запросов читаемыми, когда вы охотитесь за конкретной проблемой, например замечаете повторяющийся идентичный `SELECT`, который выдаёт цикл отложенной загрузки. Если вы охотитесь именно за этим, фильтр по категории плюс просмотр вывода - это ровно ручная версия [обнаружения запросов N+1 в EF Core 11](/ru/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/).

## Отправка журналов в файл

`LogTo` принимает любой `Action<string>`, поэтому запись в файл - это просто вопрос направления его в `StreamWriter`. Освобождайте writer, когда освобождается контекст, чтобы файл закрывался корректно:

```csharp
// EF Core 11, .NET 11
public sealed class AppDbContext : DbContext
{
    private readonly StreamWriter _log = new("ef-sql.log", append: true);

    protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
        => optionsBuilder
            .UseSqlServer(connectionString)
            .LogTo(_log.WriteLine, LogLevel.Information);

    public override void Dispose()
    {
        base.Dispose();
        _log.Dispose();
    }

    public override async ValueTask DisposeAsync()
    {
        await base.DisposeAsync();
        await _log.DisposeAsync();
    }
}
```

Для более компактного файла запросите однострочный вывод и метки времени в UTC через `DbContextLoggerOptions`:

```csharp
// EF Core 11 - compact one-line-per-message format
optionsBuilder.LogTo(
    _log.WriteLine,
    LogLevel.Information,
    DbContextLoggerOptions.UtcTime | DbContextLoggerOptions.SingleLine);
```

Для чего-либо, помимо одноразового отладочного файла, предпочтите маршрутизацию через `Microsoft.Extensions.Logging` и настоящий файловый приёмник. `LogTo` в `StreamWriter` подходит для беглого взгляда; это не продакшен-стратегия журналирования.

## Получение SQL для одного запроса без его выполнения

Иногда вам не нужен шквал из каждой команды. У вас есть один LINQ-запрос, и вы хотите увидеть SQL, который он произведёт. `ToQueryString()` формирует SQL для `IQueryable`, не выполняя его против базы данных:

```csharp
// EF Core 11, C# 14
var query = db.Orders
    .Where(o => o.Total > 100)
    .OrderByDescending(o => o.Total);

Console.WriteLine(query.ToQueryString());
```

```output
SELECT [o].[Id], [o].[CustomerId], [o].[Total]
FROM [Orders] AS [o]
WHERE [o].[Total] > 100.0
ORDER BY [o].[Total] DESC
```

Это инструмент, к которому стоит обратиться, когда вы дорабатываете запрос в тесте или черновой конечной точке, потому что нет никакой настройки журналирования и никакого другого шума. Он работает только для запросов (`IQueryable`), а не для `SaveChanges`, `ExecuteUpdate` или `ExecuteDelete`; для них вернитесь к `LogTo` или категории команд. Если вы рассуждаете о SQL, который выдают массовые операции, формы, показанные в [ExecuteUpdate и ExecuteDelete для массовых записей](/ru/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/), - это то, что вы увидите в журнале команд.

## Детали, о которых стоит знать

**`CommandExecuted` срабатывает после обхода.** Событие `20101` несёт время, поэтому оно логируется, как только команда возвращается. Если запрос зависает, вы не увидите его SQL в журнале выполнения, потому что он так и не завершился. Обратите внимание на `CommandExecuting` (`20100`), если вам нужен SQL до выполнения, или используйте `ToQueryString()`, чтобы осмотреть его статически.

**Конфигурация фиксируется при инициализации.** Вы не можете подключить или отключить `LogTo` после того, как контекст построен. Если вам нужен переключатель во время выполнения, захватите делегат и проверяйте на null: `optionsBuilder.LogTo(s => _sink?.Invoke(s))`, а затем задавайте `_sink` по требованию. Это повторяет старое поведение `Database.Log` из EF6.

**Не вызывайте `LogTo` дважды с намерением добавить приёмники.** Второй вызов заменяет конфигурацию, а не дополняет её. Чтобы разветвить вывод на несколько приёмников, напишите делегат, который перенаправляет в каждый из них.

**Журналирование конфиденциальных данных и подробные ошибки предназначены только для разработки.** `EnableSensitiveDataLogging` помещает реальные значения параметров, включая ключи и персональные данные, в ваши журналы. `EnableDetailedErrors` добавляет накладные расходы на каждое чтение. Защитите оба проверкой окружения. Здесь же неожиданно шумный журнал может раскрыть больше, чем вы намеревались, поэтому проверяйте, что удерживают ваши приёмники.

**Категория, а не переключатель, - ваш продакшен-контроль.** В развёрнутом приложении оставьте EF Core подключённым к `Microsoft.Extensions.Logging` и управляйте видимостью исключительно через уровень `Microsoft.EntityFrameworkCore.Database.Command`. Вы получаете SQL по требованию, меняя одно значение конфигурации, и никогда не отправляете `LogTo(Console.WriteLine)`, который забыли убрать.

Чтение сгенерированного SQL - первый шаг почти в любом исследовании производительности EF Core, от запроса, который молча вычисляется на клиенте, до миграции, которая выдаёт больше, чем вы ожидали. Как только вы можете его видеть, исправления из [не удалось перевести выражение LINQ](/ru/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) и заметки о критических изменениях в [миграции с EF Core 6 на EF Core 11](/ru/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) становятся гораздо проще применять, потому что вы отлаживаете реальный SQL, а не гадаете о нём.

## Источники

- [EF Core simple logging (LogTo) - Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/simple-logging)
- [Using Microsoft.Extensions.Logging with EF Core - Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/extensions-logging)
- [ToQueryString / viewing generated SQL - Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/querying/#viewing-generated-sql)
- [RelationalEventId.CommandExecuted - .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.diagnostics.relationaleventid.commandexecuted)
