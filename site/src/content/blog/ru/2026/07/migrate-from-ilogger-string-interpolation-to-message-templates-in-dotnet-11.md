---
title: "Переход от интерполяции строк в ILogger к шаблонам сообщений структурированного журналирования в .NET 11"
description: "Пошаговое руководство по переводу вызовов ILogger с $-интерполяцией на шаблоны сообщений и методы, сгенерированные через [LoggerMessage], в .NET 11: что ломается, как пройтись по кодовой базе с CA2254, как проверить состояние JSON и как откатиться."
pubDate: 2026-07-25
updatedDate: 2026-07-25
template: migration
tags:
  - "migration"
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "logging"
  - "observability"
lang: "ru"
translationOf: "2026/07/migrate-from-ilogger-string-interpolation-to-message-templates-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-07-25
---

Каждый `_logger.LogInformation($"Order {orderId} failed for {customerId}")` в вашей кодовой базе выбрасывает ровно те два поля, которые понадобятся вам, когда сработает оповещение. Это руководство переводит кодовую базу .NET 11 (SDK 11.0.100-preview.6, C# 14) с интерполированных вызовов журналирования на шаблоны сообщений, а затем переводит горячие пути на методы, сгенерированные через `[LoggerMessage]`. В сервисе среднего размера проход по шаблонам занимает полдня почти механических правок, которыми управляет CA2254, а проход с генератором исходного кода занимает ещё день, если делать его как следует. Ничего рискованного здесь нет: исправление не ломает совместимость, каждый шаг откатывается независимо, а выигрыш в том, что ваш backend журналов наконец может фильтровать по `OrderId`, а не искать grep-ом отрендеренные фразы.

## Почему интерполяция теряет данные, которые вам нужны

- **Структура исчезает до того, как логгер её увидит.** `$"Order {orderId} failed"` компилируется в вызов `string.Concat` или `DefaultInterpolatedStringHandler` в точке вызова. К моменту работы `ILogger.Log` свойства `orderId` уже нет, есть только предложение. `{OriginalFormat}` в состоянии журнала оказывается заполнен полностью отрендеренным текстом, поэтому каждый отдельный идентификатор заказа порождает отдельный "шаблон" в вашем агрегаторе.
- **Кардинальность взрывается не в том месте.** Seq, Loki, Elastic и любой backend OTLP группируют и индексируют по шаблону и его именованным свойствам. Интерполированные вызовы дают уникальный шаблон на каждый вызов, а это ровно та форма, с которой эти системы справляются хуже всего.
- **Строка собирается, даже когда уровень выключен.** `_logger.LogDebug($"Payload: {Serialize(request)}")` выделяет строку и выполняет `Serialize` на каждый запрос, в продакшене, при отключённом `Debug`. Собственное [руководство Microsoft для авторов библиотек](https://learn.microsoft.com/en-us/dotnet/core/extensions/logging/library-guidance) говорит об этом прямо. Предложение добавить в `LoggerExtensions` перегрузки с обработчиком интерполированных строк ([dotnet/runtime#111283](https://github.com/dotnet/runtime/issues/111283)) закрыто как незапланированное, так что само это не исправится.
- **Фигурные скобки в данных могут привести к исключению.** Подробнее об этом ниже, но интерполированная строка, значение которой содержит `{` или `}`, может выбросить `FormatException` изнутри конвейера журналирования.

Если вы ещё не решили, куда идут журналы, разберитесь с этим сначала. [Структурированное журналирование с Serilog и Seq](/ru/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) и [OpenTelemetry с .NET 11 и бесплатным backend](/ru/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) оба предполагают, что шаблоны из этого руководства уже корректны.

## Что на самом деле выдают две формы

Вот минимальное воспроизведение. Одно и то же намерение, два стиля вызова, пропущенные через форматтер `JsonConsole` в .NET 11.

```csharp
// .NET 11 preview 6, C# 14
int orderId = 4711;
string customerId = "acme-inc";

// Interpolated: the template IS the rendered sentence.
_logger.LogInformation($"Order {orderId} failed for {customerId}");

// Message template: placeholders survive as named properties.
_logger.LogInformation("Order {OrderId} failed for {CustomerId}", orderId, customerId);
```

Первый вызов выдаёт состояние с единственной бесполезной записью:

```json
{
  "LogLevel": "Information",
  "Message": "Order 4711 failed for acme-inc",
  "State": {
    "Message": "Order 4711 failed for acme-inc",
    "{OriginalFormat}": "Order 4711 failed for acme-inc"
  }
}
```

Второй вызов выдаёт поля:

```json
{
  "LogLevel": "Information",
  "Message": "Order 4711 failed for acme-inc",
  "State": {
    "Message": "Order 4711 failed for acme-inc",
    "OrderId": 4711,
    "CustomerId": "acme-inc",
    "{OriginalFormat}": "Order {OrderId} failed for {CustomerId}"
  }
}
```

Отрендеренное `Message` одинаково. Всё, что делает журнал пригодным для запросов, живёт в разнице.

## Что ломается

| Область | Изменение | Серьёзность |
| --- | --- | --- |
| Точки вызова с `$"..."` | Должны стать константным шаблоном плюс аргументы | высокая (по объёму, не по риску) |
| Запросы и панели журналов | Сохранённые поиски по отрендеренному тексту продолжают работать; новые фильтры по свойствам надо строить | средняя |
| Правила оповещений на `{OriginalFormat}` | Строка шаблона меняется, поэтому правила точного совпадения со старым отрендеренным текстом перестают срабатывать | средняя |
| Конкатенация строк в шаблонах | `"Order " + id + " failed"` это тот же дефект, и его ловит то же правило | средняя |
| Переход на `[LoggerMessage]` | Содержащий класс и метод должны стать `partial`; метод должен возвращать `void` | низкая |
| Значения `EventId` | Дублирующиеся идентификаторы внутри сборки порождают предупреждения генератора | низкая |
| Деструктуризация `@` в Serilog | Семантика `{@Order}` отличается от перечисления состояния в `Microsoft.Extensions.Logging` | низкая |

Ничто из этого не является ломающим изменением во время выполнения. Правило Roslyn, которое ведёт весь проход, [CA2254](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2254), явно задокументировано как неломающее исправление.

## Подготовительный чек-лист

- Установлен .NET SDK 11.0.100-preview.6 или новее (`dotnet --list-sdks`). Всё в этом руководстве работает и на .NET 8, 9 и 10.
- `<LangVersion>` на 9 или выше. Генератор `[LoggerMessage]` отказывается работать ниже C# 9. На .NET 11 вы получаете C# 14 по умолчанию.
- `Microsoft.Extensions.Logging.Abstractions` подключён в каждом проекте, который будет объявлять методы `[LoggerMessage]`. Проекты на `Microsoft.NET.Sdk.Web` получают его транзитивно.
- `<EnableNETAnalyzers>true</EnableNETAnalyzers>` и `<AnalysisLevel>latest</AnalysisLevel>` в `Directory.Build.props`, иначе CA2254 никогда не сработает.
- Чистый `git status` и зелёный прогон тестов перед стартом. Проход затрагивает сотни строк, и вам нужен тривиальный откат.

## Шаги миграции

Порядок важен: сначала заставьте анализатор кричать, исправьте всё, что он найдёт, и только потом беритесь за генератор исходного кода на тех путях, где выделение памяти действительно чего-то стоит.

1. **Сделайте CA2254 ошибкой сборки.** Добавьте правило в `.editorconfig` сначала как `warning`, чтобы увидеть масштаб, и поднимите до `error`, когда счётчик дойдёт до нуля. Проверка: `dotnet build` сообщает ненулевое число CA2254 на первом прогоне.
2. **Переведите интерполированные и конкатенированные вызовы на шаблоны сообщений.** Вынесите каждое значение из строки в аргумент, с именем заполнителя в PascalCase. Проверка: `dotnet build` сообщает ноль диагностик CA2254.
3. **Исправьте порядок аргументов, потому что связывание позиционное.** `LoggerExtensions` связывает аргументы с заполнителями слева направо, а не по имени. Проверка: запустите приложение и убедитесь, что каждое свойство в состоянии JSON содержит то значение, которое обещает его имя.
4. **Добавьте методы `[LoggerMessage]` для горячих путей.** Переведите вызовы журналирования на каждый запрос и на каждый элемент в методы `partial` внутри класса `partial`, чтобы шаблон разбирался один раз во время компиляции. Проверка: `dotnet build` чист, а сгенерированный файл появляется в `obj/**/Microsoft.Extensions.Logging.Generators/`.
5. **Назначьте стабильный `EventId` каждому сообщению и держите их уникальными.** Проверка: в журнале сборки нет предупреждений `SYSLIB` о дублирующихся идентификаторах событий.
6. **Используйте `SkipEnabledCheck` плюс ручную проверку там, где вычисление аргументов дорого.** Проверка: поставьте категорию на `Information` и убедитесь, что дорогой вызов не выполняется.
7. **Раскрывайте объекты через `[LogProperties]`, а не через `ToString()`.** Проверка: публичные свойства объекта появляются отдельными записями в состоянии журнала, а не одной плоской строкой.

### 1. Сделайте CA2254 ошибкой сборки

CA2254 начиная с .NET 10 по умолчанию включено как подсказка, а значит в CI оно невидимо. Поднимите его:

```ini
# .editorconfig -- .NET 11, analyzers at latest
[*.{cs,vb}]

# CA2254: Template should be a static expression
dotnet_diagnostic.CA2254.severity = warning
```

Соберите и посчитайте, с чем имеете дело:

```bash
dotnet build -warnaserror:CA2254 --no-incremental
```

Пока не включайте CA1848. Это правило срабатывает на каждом вызове `LogInformation` в кодовой базе, включая корректные, и похоронит сигнал CA2254. Оно вернётся на шаге 4.

### 2. Переведите на шаблоны сообщений

Механическое преобразование в трёх типичных формах:

```csharp
// .NET 11, C# 14 -- before
_logger.LogInformation($"Order {order.Id} failed for {order.CustomerId}");
_logger.LogWarning("Retry " + attempt + " of " + maxAttempts);
_logger.LogError(ex, $"Import of {file.Name} aborted after {sw.ElapsedMilliseconds} ms");

// after
_logger.LogInformation("Order {OrderId} failed for {CustomerId}", order.Id, order.CustomerId);
_logger.LogWarning("Retry {Attempt} of {MaxAttempts}", attempt, maxAttempts);
_logger.LogError(ex, "Import of {FileName} aborted after {ElapsedMs} ms", file.Name, sw.ElapsedMilliseconds);
```

Три правила именования, которые окупаются позже:

- Заполнители в PascalCase. Собственное руководство Microsoft рекомендует именно это, и оно держит имена свойств согласованными между рукописными и сгенерированными шаблонами.
- Одно и то же понятие везде получает одно имя. Если это `OrderId` в одном сервисе, то `OrderId` во всех, иначе межсервисным запросам нужна конструкция `or` на каждое написание.
- Никогда не помещайте исключение в шаблон. `LogError(ex, "...")` передаёт его через выделенный параметр `Exception`, и провайдер сам решает, как его отрисовать.

### 3. Связывание аргументов позиционное, а не по имени

Это единственная ошибка, которую способен занести такой проход, и CA2254 её не поймает:

```csharp
// .NET 11 -- compiles, no analyzer warning, WRONG
_logger.LogInformation("Order {OrderId} for {CustomerId}", customerId, orderId);
```

`Microsoft.Extensions.Logging` сопоставляет заполнители с аргументами по порядку. Имена это ярлыки для получающихся свойств, а не ключ связывания. Строка журнала отрисует идентификатор клиента под именем `OrderId`, и никто этого не заметит, пока через три недели запрос не вернёт бессмыслицу. Прочитайте каждую переведённую строку один раз, держа в голове именно этот отказ, и лучше переводите метод целиком, чем принимайте результат массовой замены.

У генератора `[LoggerMessage]` из шага 4 такой проблемы нет: он сопоставляет заполнители шаблона с именами параметров без учёта регистра, так что порядок параметров там не имеет значения.

### 4. Добавьте [LoggerMessage] на горячих путях

Шаблоны сообщений починили структуру. Стоимость одного вызова они не починили: `LoggerExtensions.LogInformation` по-прежнему упаковывает значимые типы в `object`, выделяет `params object?[]` и заново разбирает шаблон на каждом вызове. [Генератор исходного кода `[LoggerMessage]`](/ru/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) убирает все три пункта, выпуская во время компиляции строго типизированную обёртку над `LoggerMessage.Define`.

```csharp
// .NET 11 preview 6, C# 14
using Microsoft.Extensions.Logging;

public partial class OrderProcessor(ILogger<OrderProcessor> logger, OrderPipeline pipeline)
{
    public async Task ProcessAsync(Order order, CancellationToken ct)
    {
        try
        {
            await pipeline.RunAsync(order, ct);
            OrderProcessed(order.Id, order.CustomerId);
        }
        catch (PaymentDeclinedException ex)
        {
            OrderFailed(ex, order.Id, order.CustomerId);
        }
    }

    [LoggerMessage(
        EventId = 1001,
        Level = LogLevel.Information,
        Message = "Order {OrderId} processed for {CustomerId}")]
    private partial void OrderProcessed(int orderId, string customerId);

    [LoggerMessage(
        EventId = 1002,
        Level = LogLevel.Warning,
        Message = "Order {OrderId} failed for {CustomerId}")]
    private partial void OrderFailed(Exception ex, int orderId, string customerId);
}
```

Начиная с .NET 9 генератор берёт `ILogger` и из параметра первичного конструктора, поэтому в примере выше нет явного поля `_logger`. Если есть и поле, и параметр первичного конструктора, побеждает поле.

Ограничения, которые стоит запомнить, согласно [документации по генерации исходного кода](https://learn.microsoft.com/en-us/dotnet/core/extensions/logger-message-generator): методы должны быть `partial` и возвращать `void`, ни имена методов, ни имена параметров не должны начинаться с подчёркивания, а параметры не могут использовать `params`, `scoped` или `out` и не могут быть типами `ref struct`. Статические методы обязаны принимать `ILogger` параметром; добавьте `this`, чтобы сделать из них методы расширения.

Теперь включите CA1848 для тех проектов, которые вы уже перевели, ограничив область, чтобы не залить остальное:

```ini
# .editorconfig, in the hot-path project folder only
[*.cs]
# CA1848: Use the LoggerMessage delegates
dotnet_diagnostic.CA1848.severity = warning
```

CA1848 не включено по умолчанию даже в .NET 10 и новее и намеренно агрессивно: оно помечает каждый вызов в стиле `LogInformation`. Включайте его по проектам, а не на всё решение, если только вы действительно не собираетесь генерировать все сообщения.

### 5. Держите идентификаторы событий стабильными и уникальными

`EventId` это стабильная идентичность сообщения журнала. Она переживает переформулировку шаблона, что делает её правильной опорой для правил оповещений. Держите идентификаторы в одном месте на сборку, чтобы коллизии были очевидны:

```csharp
// .NET 11 -- one file, one range per subsystem
internal static class LogEvents
{
    public const int OrderProcessed = 1001;
    public const int OrderFailed    = 1002;
    public const int PaymentRetried = 1003;
}
```

Генератор предупреждает о дублирующихся идентификаторах событий внутри класса. Между классами он не предупреждает, так что файл с константами делает реальную работу.

### 6. SkipEnabledCheck для дорогих аргументов

По умолчанию сгенерированный метод сначала вызывает `ILogger.IsEnabled`, так что отключённый уровень стоит одного виртуального вызова. Чего он не может, так это помешать вызывающему коду вычислить аргументы. Когда аргумент дорогой, поднимите проверку наверх:

```csharp
// .NET 11, C# 14
[LoggerMessage(
    EventId = 2001,
    Level = LogLevel.Debug,
    Message = "Request body: {Body}",
    SkipEnabledCheck = true)]
private partial void RequestBody(string body);

// call site
if (logger.IsEnabled(LogLevel.Debug))
{
    RequestBody(await SerializeAsync(request, ct));  // only runs when Debug is on
}
```

Это тот паттерн, который возвращает пропускную способность, которую интерполированные вызовы `LogDebug` тихо у вас отбирали.

### 7. Раскрывайте объекты через [LogProperties]

`Message = "Processing {Order}"` с параметром `Order` даёт одно свойство, содержащее вывод `ToString()`. Чтобы получить поля объекта отдельными свойствами, добавьте `Microsoft.Extensions.Telemetry.Abstractions` и разметьте параметр:

```csharp
// .NET 11, Microsoft.Extensions.Telemetry.Abstractions
[LoggerMessage(
    EventId = 1004,
    Level = LogLevel.Information,
    Message = "Processing order")]
private partial void ProcessingOrder([LogProperties] Order order);
```

Каждое публичное свойство `Order` попадает в состояние журнала как `order.Id`, `order.CustomerId` и так далее. Тот же пакет включает редактирование классифицированных параметров, и это правильный ответ, когда вас просят записать в журнал объект запроса, содержащий адрес электронной почты.

## Проверка

Проходите этот чек-лист после каждой фазы, а не один раз в конце:

- `dotnet build -warnaserror:CA2254` завершается с кодом ноль.
- `dotnet test` проходит без новых падений. Тесты, которые проверяют отрендеренный текст журнала, обычная жертва; перепишите их на проверку свойств состояния.
- Переключите консольный форматтер на JSON (`"Console": { "FormatterName": "json" }` в `appsettings.Development.json`), обратитесь к одному показательному endpoint и прочитайте выданный объект `State`. Каждое значимое для вас значение должно быть отдельным ключом, а `{OriginalFormat}` должен содержать заполнители, а не данные.
- Поищите grep-ом в выводе сборки `SYSLIB1015` (параметр без соответствующего заполнителя) и `SYSLIB0025` (исключение включено в шаблон). Оба это предупреждения, которые стоит исправить, а не подавить.
- Убедитесь, что сгенерированный исходный код существует: `obj/Debug/net11.0/generated/Microsoft.Extensions.Logging.Generators/`. Если папка пуста, атрибут стоит на члене, который не `partial`, и генератор молча не сделал ничего полезного.
- Разверните на staging и сравните объём журналов. Он должен остаться прежним. Падение означает, что какая-то проверка уровня случайно стала строже.

## План отката

Каждый шаг откатывается независимо через `git revert`, и ни один шаг не меняет публичный API или формат передачи. Есть одна оговорка, которую стоит сказать громко: как только ваш backend журналов начнёт индексировать новые имена свойств, панели и оповещения, построенные на них, сломаются, если вы откатите код. Откатывайте сначала код, потом панели, и держите оба изменения в отдельных коммитах, чтобы порядок был вам доступен.

Повышение серьёзности в `.editorconfig` стоит сохранить, даже если вы откатите изменения кода. Оставленное на `warning` правило CA2254 не даёт новым интерполированным вызовам появляться, пока вы решаете.

## Что нас укусило

**Фигурные скобки в данных приводят к FormatException.** У интерполированной формы есть отказ, с которым большинство команд впервые знакомится в продакшене. `Microsoft.Extensions.Logging` считает аргумент `message` строкой формата и прогоняет его через `LogValuesFormatter`, который переписывает `{Name}` в `{0}` и вызывает `string.Format`. Если ваш интерполированный результат содержит скобки, например потому что вы записали в журнал полезную нагрузку JSON, форматтер видит заполнители без соответствующих аргументов и выбрасывает исключение (`aspnet/Logging#351` это каноническое сообщение об этом). Шаблоны сообщений к этому невосприимчивы: JSON это аргумент, а не часть строки формата.

```csharp
// .NET 11 -- throws FormatException at runtime when json contains { }
_logger.LogInformation($"Response: {json}");

// safe
_logger.LogInformation("Response: {Json}", json);
```

**`{@Property}` из Serilog это не возможность Microsoft.Extensions.Logging.** Если вы на Serilog, `{@Order}` деструктурирует объект в структурированное значение. Генератор `[LoggerMessage]` шаблон примет, но `@` это соглашение Serilog, которое обрабатывает `Serilog.Extensions.Logging`. Не считайте, что оно что-то делает в обычном провайдере OTLP или консоли. Используйте `[LogProperties]`, когда вам нужно раскрытие, не зависящее от провайдера.

**Тесты, проверяющие текст журнала.** `Assert.Contains("Order 4711 failed", sink.Messages)` продолжает проходить через всю миграцию, потому что отрендеренное сообщение не меняется. Это ловушка: получается, что кодовую базу можно перевести, а тесты так и не докажут, что свойства существуют. Добавьте хотя бы один тест на подсистему, который проверяет ключ состояния.

**Собственные журналы EF Core уже используют шаблоны.** Не надо их "чинить". Если вы пытаетесь получить читаемый SQL от провайдера, то [журналирование SQL, который генерирует EF Core 11](/ru/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) это вопрос конфигурации, а не точки вызова.

**Миграция backend это другая работа.** Перевод точек вызова никуда не переносит журналы. Если целью является OTLP, сначала сделайте эту миграцию, чтобы шаблоны были правильными, а затем следуйте руководству [переход с Serilog на журналирование через OpenTelemetry](/ru/2026/06/migrate-from-serilog-to-opentelemetry-logging-in-dotnet-11/). Делать и то и другое одновременно значит лишиться возможности понять, какое изменение сломало панель.

## Источники

- [Генерация кода журналирования во время компиляции](https://learn.microsoft.com/en-us/dotnet/core/extensions/logger-message-generator), Microsoft Learn
- [Высокопроизводительное журналирование в .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/logging/high-performance-logging), Microsoft Learn
- [Руководство по журналированию для авторов библиотек .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/logging/library-guidance), Microsoft Learn
- [CA2254: шаблон должен быть статическим выражением](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2254), Microsoft Learn
- [CA1848: используйте делегаты LoggerMessage](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1848), Microsoft Learn
- [Предложение API: перегрузки с интерполированными строками для расширений ILogger](https://github.com/dotnet/runtime/issues/111283), dotnet/runtime, закрыто как незапланированное
- [LogInformation(string) выбрасывает FormatException](https://github.com/aspnet/Logging/issues/351), aspnet/Logging
- [.NET 11 Preview 6 уже доступен](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-6/), .NET Blog
