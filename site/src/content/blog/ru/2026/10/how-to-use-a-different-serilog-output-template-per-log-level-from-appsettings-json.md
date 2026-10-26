---
title: "Как использовать разные шаблоны вывода Serilog для разных уровней журналирования из appsettings.json"
description: "outputTemplate задаётся для sink целиком, поэтому для форматирования по уровням нужен либо ExpressionTemplate с блоками {#if @l ...}, либо два вложенных логгера Logger с фильтрами ByIncludingOnly / ByExcluding. Оба варианта настраиваются только через appsettings.json, проверено на Serilog 4.4, Serilog.Settings.Configuration 10.0.1 и Serilog.Expressions 5.0."
pubDate: 2026-10-26
template: how-to
tags:
  - "dotnet"
  - "csharp"
  - "logging"
  - "serilog"
  - "aspnet-core"
lang: "ru"
translationOf: "2026/10/how-to-use-a-different-serilog-output-template-per-log-level-from-appsettings-json"
translatedBy: "claude"
translationDate: 2026-10-26
---

`outputTemplate` в Serilog принадлежит sink, а не уровню, поэтому настройки вида `"outputTemplate": { "Error": "..." }` не существует. Есть два аккуратных способа получить форматирование по уровням только из `appsettings.json`. Первый: заменить `outputTemplate` на `formatter` типа `Serilog.Templates.ExpressionTemplate` (из пакета `Serilog.Expressions`) и ветвить логику прямо в шаблоне через `{#if @l in ['Error', 'Fatal']} ... {#else} ... {#end}`. Второй: писать в два вложенных логгера `"Name": "Logger"`, у каждого свой `Filter` (`ByIncludingOnly` / `ByExcluding` по `@l`) и свой обычный `outputTemplate`. Не стоит просто добавлять второй sink с `restrictedToMinimumLevel`: это нижняя граница, поэтому каждая ошибка будет записана дважды. Всё ниже запускалось на .NET 10.0.302 SDK с Serilog 4.4.0, Serilog.Settings.Configuration 10.0.1, Serilog.Expressions 5.0.0, Serilog.Sinks.Console 6.1.1 и Serilog.Sinks.File 7.0.0. Тот же JSON без изменений работает на .NET 11.

## Почему outputTemplate не может зависеть от уровня

`outputTemplate` является аргументом конструктора консольного и файлового sink. Внутри sink строит один `MessageTemplateTextFormatter` из этой строки и применяет его ко всем получаемым событиям. Serilog.Settings.Configuration просто вызывает за вас `WriteTo.Console(outputTemplate: "...")`, так что всё, что вы пишете в JSON, соответствует этому единственному форматтеру один к одному. Уровень доступен *внутри* шаблона как `{Level}`, но у классического шаблона сообщения нет условий: он может вывести уровень, но не может изменить свою форму в зависимости от него.

Поэтому для вывода по уровням нужно одно из двух:

1. форматтер, который сам умеет принимать решения, то есть `ExpressionTemplate`, или
2. отдельные конвейеры, у каждого свой форматтер и перед каждым фильтр, чтобы событие попадало ровно в один из них.

Типичные причины, зачем это нужно: короткий однострочный вывод для `Debug` и `Information` в консоли, но полные метки времени, дополнительные свойства контекста и трассировка стека для `Error` и `Fatal`; или отдельный `errors.log` с более подробным форматом, чем у основного журнала.

## Наивная конфигурация, дублирующая ошибки

Эту конфигурацию большинство пробует первой, и именно поэтому этот вопрос и задают:

```json
// appsettings.json, Serilog 4.4.0, Serilog.Settings.Configuration 10.0.1
{
  "Serilog": {
    "Using": [ "Serilog.Sinks.Console" ],
    "MinimumLevel": "Debug",
    "WriteTo": [
      { "Name": "Console", "Args": { "outputTemplate": "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj}{NewLine}" } },
      { "Name": "Console", "Args": { "restrictedToMinimumLevel": "Error", "outputTemplate": "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj} ({SourceContext}){NewLine}{Exception}" } }
    ]
  }
}
```

Тестовая программа пишет по одному событию на каждый уровень, а для `Error` добавляет исключение:

```csharp
// Program.cs, .NET 10, Serilog 4.4.0
using Microsoft.Extensions.Configuration;
using Serilog;

var config = new ConfigurationBuilder().AddJsonFile(args[0]).Build();
Log.Logger = new LoggerConfiguration().ReadFrom.Configuration(config).CreateLogger();

var orderId = 42;
Log.Debug("Cache warm for {Region}", "eu-west");
Log.Information("Order {OrderId} accepted", orderId);
Log.Warning("Order {OrderId} took {Elapsed} ms", orderId, 1830);
try { throw new InvalidOperationException("Payment gateway timed out"); }
catch (Exception ex) { Log.Error(ex, "Order {OrderId} failed", orderId); }
Log.Fatal("Shutting down: {Reason}", "unrecoverable");
Log.CloseAndFlush();
```

Вывод:

```text
[09:04:23 DBG] Cache warm for eu-west
[09:04:23 INF] Order 42 accepted
[09:04:23 WRN] Order 42 took 1830 ms
[09:04:23 ERR] Order 42 failed
[09:04:23 ERR] Order 42 failed ()
System.InvalidOperationException: Payment gateway timed out
   at Program.<Main>$(String[] args) in .../Program.cs:line 11
[09:04:23 FTL] Shutting down: unrecoverable
[09:04:23 FTL] Shutting down: unrecoverable ()
```

`restrictedToMinimumLevel` означает только "этот уровень и выше". У первого sink верхней границы нет, поэтому `Error` и `Fatal` попадают в оба. Аргумента `restrictedToMaximumLevel` не существует. Нужен настоящий фильтр или настоящее условие.

## Вариант 1: один sink и ExpressionTemplate с блоками #if

`Serilog.Expressions` поставляет `ExpressionTemplate`, то есть `ITextFormatter`, язык шаблонов которого поддерживает `{#if <expr>}`, `{#else if <expr>}`, `{#else}` и `{#end}`. Текущий уровень обозначается `@l`. Serilog.Settings.Configuration умеет создать его прямо из JSON: у консольного и файлового sink есть перегрузка, принимающая `ITextFormatter formatter`, а читатель настроек привязывает объект с ключом `type` к конструктору этого типа.

1. Добавьте пакеты:

```bash
# .NET 10 SDK; package versions as of October 2026
dotnet add package Serilog.AspNetCore --version 10.0.0
dotnet add package Serilog.Expressions --version 5.0.0
```

`Serilog.AspNetCore` 10.0.0 подтягивает Serilog 4.x, Serilog.Settings.Configuration, а также консольный и файловый sink. В обычном консольном приложении или worker используйте вместо него `Serilog.Extensions.Hosting` (или отдельные пакеты, как в тестовом проекте).

2. Замените `outputTemplate` объектом `formatter`:

```json
// appsettings.json, Serilog.Expressions 5.0.0
{
  "Serilog": {
    "Using": [ "Serilog.Sinks.Console", "Serilog.Expressions" ],
    "MinimumLevel": "Debug",
    "WriteTo": [
      {
        "Name": "Console",
        "Args": {
          "formatter": {
            "type": "Serilog.Templates.ExpressionTemplate, Serilog.Expressions",
            "template": "{#if @l = 'Debug'}  dbg {@m}\n{#else if @l in ['Information', 'Warning']}[{@t:HH:mm:ss} {@l:u3}] {@m}\n{#else}[{@t:yyyy-MM-dd HH:mm:ss.fff} {@l:u3}] {@m} {Rest()}\n{#if @x is not null}{@x}{#end}{#end}"
          }
        }
      }
    ]
  }
}
```

3. Запустите. Один sink выдаёт три разных формата:

```text
  dbg Cache warm for eu-west
[09:04:47 INF] Order 42 accepted
[09:04:47 WRN] Order 42 took 1830 ms
[2026-10-26 09:04:47.048 ERR] Order 42 failed {"OrderId":42}
System.InvalidOperationException: Payment gateway timed out
   at Program.<Main>$(String[] args) in .../Program.cs:line 11
[2026-10-26 09:04:47.051 FTL] Shutting down: unrecoverable {"Reason":"unrecoverable"}
```

Синтаксис шаблона не совпадает с классическим, так что переводите по ходу дела:

| Классический `outputTemplate` | `ExpressionTemplate` |
| --- | --- |
| `{Timestamp:HH:mm:ss}` | `{@t:HH:mm:ss}` |
| `{Level:u3}` | `{@l:u3}` |
| `{Message:lj}` | `{@m}` (строки уже выводятся без кавычек) |
| `{Exception}` | `{@x}` |
| `{NewLine}` | литерал `\n` в JSON-строке |
| `{Properties:j}` | `{Rest()}` или `{Rest(true)}` |
| `{SourceContext}` | `{SourceContext}` (без изменений) |

Из этой таблицы на практике важны две детали. `{NewLine}` в шаблонах выражений не существует; `\n` в JSON-строке после разбора JSON становится настоящим переводом строки, что как раз и нужно, так что не экранируйте его дважды. А `{@x}` уже заканчивается переводом строки, поэтому `{@x}\n` выведет пустую строку после каждой трассировки стека.

### Показывать свойства контекста, только когда они есть

`Rest()` возвращает свойства события, на которые *шаблон выражения* не ссылался. Сюда всё равно входят и те, что встречаются в тексте сообщения, поэтому выше появляется `{"OrderId":42}`, хотя сообщение уже говорит "Order 42". `Rest(true)` дополнительно исключает свойства, на которые ссылается шаблон сообщения, и его можно защитить условием, чтобы пустое `{}` никогда не выводилось:

```json
"template": "{#if @l in ['Error', 'Fatal']}[{@t:HH:mm:ss.fff} {@l:u3}] {@m}{#if Rest(true) <> {}} {Rest(true)}{#end}\n{@x}{#else}[{@t:HH:mm:ss} {@l:u3}] {@m}\n{#end}"
```

Если вокруг вызова `Log.Error` через `LogContext` добавлен `TenantId`, получится:

```text
[09:05:30 DBG] Cache warm for eu-west
[09:05:30 INF] Order 42 accepted
[09:05:30 WRN] Order 42 took 1830 ms
[09:05:30.374 ERR] Order 42 failed {"TenantId":"acme"}
System.InvalidOperationException: Payment gateway timed out
   at Program.<Main>$(String[] args) in .../Program.cs:line 13
[09:05:30.383 FTL] Shutting down: unrecoverable
```

В строке `Fatal` нет завершающих фигурных скобок, потому что её единственное свойство `Reason` уже есть в сообщении.

## Вариант 2: два вложенных логгера, у каждого свой outputTemplate

Если вы хотите сохранить классические строки `outputTemplate` или два формата уходят в разные sink (консоль и файл, Seq и файл), используйте sink `Logger`. Он создаёт вложенный логгер со своими секциями `Filter`, `WriteTo` и `Enrich`. Выражения для фильтров снова берутся из `Serilog.Expressions`, который добавляет `ByIncludingOnly(string expression)` и `ByExcluding(string expression)`.

1. Сделайте два фильтра взаимодополняющими, чтобы каждое событие попадало ровно в один вложенный логгер:

```json
// appsettings.json, Serilog.Settings.Configuration 10.0.1, Serilog.Expressions 5.0.0
{
  "Serilog": {
    "Using": [ "Serilog.Sinks.Console", "Serilog.Expressions" ],
    "MinimumLevel": "Debug",
    "WriteTo": [
      {
        "Name": "Logger",
        "Args": {
          "configureLogger": {
            "Filter": [ { "Name": "ByExcluding", "Args": { "expression": "@l in ['Error', 'Fatal']" } } ],
            "WriteTo": [ { "Name": "Console", "Args": { "outputTemplate": "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj}{NewLine}" } } ]
          }
        }
      },
      {
        "Name": "Logger",
        "Args": {
          "configureLogger": {
            "Filter": [ { "Name": "ByIncludingOnly", "Args": { "expression": "@l in ['Error', 'Fatal']" } } ],
            "WriteTo": [ { "Name": "Console", "Args": { "outputTemplate": "[{Timestamp:HH:mm:ss.fff} {Level:u3}] {Message:lj} {Properties:j}{NewLine}{Exception}" } } ]
          }
        }
      }
    ]
  }
}
```

2. Запустите. Дубликатов нет, а ветка ошибок получает миллисекунды, свойства и исключение:

```text
[09:04:23 DBG] Cache warm for eu-west
[09:04:23 INF] Order 42 accepted
[09:04:23 WRN] Order 42 took 1830 ms
[09:04:23.840 ERR] Order 42 failed {}
System.InvalidOperationException: Payment gateway timed out
   at Program.<Main>$(String[] args) in .../Program.cs:line 11
[09:04:23.842 FTL] Shutting down: unrecoverable {}
```

`{}` это обычное поведение классического `{Properties:j}`: он перечисляет только те свойства, которых ещё нет в сообщении, а здесь таких нет. В отличие от `Rest(true)`, его нельзя сделать условным, и это одна из практических причин предпочесть Вариант 1 для консольного вывода.

### Когда достаточно одного restrictedToMinimumLevel

Если второму формату нужно только "этот уровень и выше" *и* он пишет в другое место, фильтр не нужен. Типичный случай, отдельный файл ошибок:

```json
// appsettings.json, Serilog.Sinks.File 7.0.0
{
  "Name": "File",
  "Args": {
    "path": "logs/errors-.log",
    "rollingInterval": "Day",
    "restrictedToMinimumLevel": "Error",
    "outputTemplate": "{Timestamp:o} [{Level:u3}] {Message:lj}{NewLine}{Properties:j}{NewLine}{Exception}"
  }
}
```

Проблема дублирования из наивной конфигурации возникает, только когда оба вывода попадают в одно и то же место.

## Подключение в ASP.NET Core или worker

Выбор шаблона никак не меняет код хостинга. С Serilog.AspNetCore 10.0.0:

```csharp
// Program.cs, ASP.NET Core on .NET 10 / .NET 11, Serilog.AspNetCore 10.0.0
using Serilog;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSerilog((services, lc) => lc
    .ReadFrom.Configuration(builder.Configuration)
    .ReadFrom.Services(services));

var app = builder.Build();
app.MapGet("/", (ILogger<Program> log) =>
{
    log.LogError("Something failed for {OrderId}", 42);
    return "ok";
});
app.Run();
```

Поскольку форматтер живёт в конфигурации, в `appsettings.Development.json` можно положить компактный однострочный шаблон, а в `appsettings.Production.json` JSON-форматтер, не трогая код. Про bootstrap-логгер и `Log.CloseAndFlush()` вокруг этого рассказывает [статья о настройке Serilog и Seq](/ru/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/).

## Подводные камни, найденные при тестировании

**Сравнения уровней чувствительны к регистру.** `@l = 'error'` даёт `false` для события `Error`. Используйте точные имена `Verbose`, `Debug`, `Information`, `Warning`, `Error`, `Fatal` или добавьте модификатор `ci`: `@l = 'error' ci` в тесте дало `true`. Кроме того, `{#if}` требует настоящего булева `true`; небулево значение "истинным" не считается.

**Вложенный логгер не может быть подробнее родительского.** При корневом `"MinimumLevel": "Information"` и `"MinimumLevel": "Debug"` внутри `configureLogger` вложенный логгер всё равно ничего не вывел ниже `INF`. События отбрасывает корневой логгер ещё до того, как их увидит sink `Logger`. Задайте корневой минимум равным самому низкому уровню, нужному любой из веток, и повышайте его для каждой ветки отдельно.

**Отсутствующие свойства оставляют после себя окружающий текст.** Оба стиля шаблонов выводят отсутствующее у события свойство как пустоту: в наивной конфигурации `({SourceContext})` вывело `()`, а в `ExpressionTemplate` выражение `(OrderId={OrderId})` для события `Fatal` вывело `(OrderId=)`. Исправить это можно только в шаблоне выражений: оберните необязательные свойства в `{#if OrderId is not null} ... {#end}`.

**Неизвестные имена не вызывают ошибок.** `"Enrich": [ "WithMachineName" ]` без установленного пакета `Serilog.Enrichers.Environment` исключения не вызвал. Единственным следом стало это сообщение после включения `Serilog.Debugging.SelfLog.Enable(Console.Error)`:

```text
Unable to find a method called WithMachineName. Candidate methods are:
...
```

То же относится к опечатке в имени sink или фильтра, когда на `Serilog.Expressions` нет ссылки. Включайте `SelfLog` в тот момент, когда изменение шаблона кажется не дающим никакого эффекта.

**Оставляйте секцию `Using`, если публикуете в один файл.** Serilog.Settings.Configuration автоматически находит все зависимости со словом "Serilog" в имени через `.deps.json`, поэтому тестовый проект работал вообще без `Using`. В README проекта отмечено, что автообнаружение не работает в bundled-режиме (single-file), так что перечисляйте `"Serilog.Expressions"` и все сборки sink явно.

**Переменные окружения переопределяют элементы массива по индексу.** Шаблон по уровням это длинная строка в `WriteTo:0:Args:formatter:template`. Переопределение из контейнера выглядит как `Serilog__WriteTo__0__Args__formatter__template`, и индекс сдвинется, если кто-то поменяет порядок в `WriteTo`. Если шаблоны различаются по окружениям, лучше использовать файл `appsettings.{Environment}.json`.

## Какой вариант выбрать

Используйте `ExpressionTemplate`, когда форматы делят одно место назначения, обычно консоль. Это один sink, один проход по событию, и он умеет то, чего не могут вложенные логгеры, например скрывать пустые наборы свойств. Используйте вложенные логгеры, когда форматы идут в разные sink или требуют разных enricher, либо когда команда предпочитает классические шаблоны, которые читаются всеми. В любом случае фильтр или условие нужно писать по `@l`; настройки шаблона с ключом по уровню не существует, искать её не нужно.

## Что почитать дальше

- Начните со статьи о [структурированном журналировании с Serilog и Seq в .NET 11](/ru/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/), если Serilog у вас ещё не подключён.
- Чтобы формат по уровням показывал, кто вызвал ошибку, [добавьте идентификатор текущего пользователя в каждую запись журнала в ASP.NET Core](/ru/2026/09/how-to-add-the-current-user-id-to-every-log-entry-in-aspnet-core/) через `LogContext`.
- Свойства, попадающие в `Rest()` или `{Properties:j}`, могут раскрыть секреты; [скрывайте чувствительные значения с помощью `[LogProperties]`](/ru/2026/08/how-to-redact-sensitive-values-from-logs-with-logproperties-in-dotnet/) до того, как они попадут в любой шаблон.
- `{@m}` и `{Message:lj}` остаются структурированными, только если в местах вызова используются шаблоны сообщений, и именно это решает [миграция с интерполяции строк в `ILogger` на шаблоны сообщений](/ru/2026/07/migrate-from-ilogger-string-interpolation-to-message-templates-in-dotnet-11/).
- Если вы уходите с Serilog на OpenTelemetry, смотрите [миграцию с Serilog на журналирование OpenTelemetry](/ru/2026/06/migrate-from-serilog-to-opentelemetry-logging-in-dotnet-11/).

## Источники

- [Serilog.Expressions README](https://github.com/serilog/serilog-expressions): `ExpressionTemplate`, встроенные `@l`/`@x`, `#if`/`#else if`, `Rest([deep])` и модификатор `ci`.
- [Serilog.Settings.Configuration README](https://github.com/serilog/serilog-settings-configuration): `Using` и автообнаружение (включая ограничение bundled-режима), привязка сложного `formatter` через `type` и конфигурация вложенных логгеров.
- [Serilog wiki: Configuration Basics](https://github.com/serilog/serilog/wiki/Configuration-Basics): вложенные логгеры и почему они не могут понизить минимальный уровень родителя.
- [Serilog.Sinks.Console](https://github.com/serilog/serilog-sinks-console) и [Serilog.Sinks.File](https://github.com/serilog/serilog-sinks-file): параметры `outputTemplate`, `formatter` и `restrictedToMinimumLevel`.
- [Serilog.AspNetCore](https://github.com/serilog/serilog-aspnetcore): `AddSerilog` с `ReadFrom.Configuration` и `ReadFrom.Services`.
