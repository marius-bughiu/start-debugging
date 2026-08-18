---
title: "Исправление: CA1873 \"Evaluation of this argument may be expensive and unnecessary if logging is disabled\""
description: "CA1873 срабатывает на неявный массив params object[], поэтому его вызывает почти любой вызов LogDebug. Исправьте через [LoggerMessage] или проверку IsEnabled."
pubDate: 2026-08-18
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "logging"
  - "analyzers"
  - "performance"
lang: "ru"
translationOf: "2026/08/fix-ca1873-evaluation-of-this-argument-may-be-expensive-and-unnecessary-if-logging-is-disabled"
translatedBy: "claude"
translationDate: 2026-08-18
---

CA1873 представляет собой анализатор производительности, который в SDK .NET 10 включён как **предложение**, а не как предупреждение, поэтому он виден в Visual Studio, Rider и `dotnet format`, но оставляет `dotnet build` чистым. Срабатывает он на неявный массив `params object?[]`, который выделяет любой вызов в стиле `ILogger.LogDebug`. Это означает, что правило срабатывает практически на каждом вызове структурированного логирования хотя бы с одним аргументом, даже с обычной строкой. Настоящее исправление состоит в генерации исходного кода через `[LoggerMessage]`, а быстрое решение сводится к проверке `IsEnabled`, уровень которой точно совпадает с уровнем вызова.

Текст диагностики, который вы ищете:

```text
warning CA1873: Evaluation of this argument may be expensive and unnecessary if logging is disabled
```

Всё изложенное ниже проверено на SDK `10.0.201`, `Microsoft.Extensions.Logging` 10.0.0 и C# 14, а исходный код анализатора прочитан из `dotnet/sdk`.

## Что делает CA1873 невидимым в dotnet build?

Потому что уровень серьёзности по умолчанию в .NET 10 равен предложению (info), а диагностики уровня info не выводятся командой `dotnet build` и не затрагиваются параметром `TreatWarningsAsErrors`.

Проект с десятком вызовов `LogDebug` собирается полностью чисто:

```text
    0 Warning(s)
    0 Error(s)
```

Превратить его в настоящее предупреждение можно одним из двух способов:

```xml
<!-- .NET 10 SDK 10.0.201: promotes every "All"-mode analyzer, CA1873 included -->
<PropertyGroup>
  <AnalysisMode>All</AnalysisMode>
</PropertyGroup>
```

```ini
# .editorconfig, targeted at just this rule
[*.{cs,vb}]
dotnet_diagnostic.CA1873.severity = warning
```

Тот же проект после этого сообщает о 12 предупреждениях CA1873. Если вы подключаете уровни серьёзности анализаторов к CI, компромиссы разобраны в статье [как удержать TreatWarningsAsErrors вне сборок разработчика](/ru/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/).

## Как очевидно дешёвый аргумент всё же вызывает CA1873?

Именно эта деталь отправляет людей в поисковики. Правило смотрит не только на ваш аргумент. Оно смотрит на **неявный массив `params object?[]`**, который компилятор создаёт для передачи этого аргумента, и создание непустого массива само по себе считается дорогим.

У `LoggerExtensions.LogDebug` нет перегрузки без params, принимающей аргументы сообщения:

```csharp
// Microsoft.Extensions.Logging.Abstractions 10.0.0
public static void LogDebug(this ILogger logger, string? message, params object?[] args);
```

Поэтому `_logger.LogDebug("v {V}", x)` компилируется в выделение `object[1]` независимо от того, чем является `x`. Проверка стоимости в анализаторе считает нарушением любое создание массива, если только массив не пуст:

```csharp
// dotnet/sdk, AvoidPotentiallyExpensiveCallWhenLogging.cs
static bool IsEmptyImplicitParamsArrayCreation(IArrayCreationOperation arrayCreationOperation) =>
    arrayCreationOperation.IsImplicit &&
    arrayCreationOperation.DimensionSizes.Length == 1 &&
    arrayCreationOperation.DimensionSizes[0].ConstantValue.HasValue &&
    arrayCreationOperation.DimensionSizes[0].ConstantValue.Value is int size &&
    size == 0;
```

Я собрал матрицу, чтобы подтвердить, что именно вызывает срабатывание. Каждый из этих случаев дал CA1873 на SDK 10.0.201:

```csharp
// .NET 10, C# 14, Microsoft.Extensions.Logging.Abstractions 10.0.0
public void StringProp(Order o) => _logger.LogDebug("v {V}", o.Name);      // CA1873
public void IntProp(Order o)    => _logger.LogDebug("v {V}", o.Id);        // CA1873
public void StringField()       => _logger.LogDebug("v {V}", _nameField);  // CA1873
public void StringLocal()       { var s = "a"; _logger.LogDebug("v {V}", s); }  // CA1873
public void StringParam(string s) => _logger.LogDebug("v {V}", s);         // CA1873
public void ConstInt()          => _logger.LogDebug("v {V}", 42);          // CA1873
```

Избегает срабатывания только вызов вообще без аргументов сообщения, поскольку тогда неявный массив params имеет нулевую длину:

```csharp
public void LiteralOnly() => _logger.LogDebug("nothing to see");           // clean
```

В этом и состоит вся неожиданность. С `o.Name` ничего не так. Изменение от ноября 2025 года под названием "Reduce noise from CA1873" специально исключило из проверки стоимости обращения к свойствам, `GetType`, `GetHashCode` и `Stopwatch.GetTimestamp`, но это исключение применяется к *элементам* массива, тогда как само выделение массива по-прежнему помечается. Для перегрузок на основе params снижение шума остаётся незаметным.

## Как выглядит минимальное воспроизведение?

```csharp
// .NET 10 (SDK 10.0.201), C# 14
// dotnet new console + Microsoft.Extensions.Logging.Abstractions 10.0.0
using Microsoft.Extensions.Logging;

public class OrderService(ILogger<OrderService> logger)
{
    public void Process(Order order)
    {
        // CA1873: Evaluation of this argument may be expensive
        // and unnecessary if logging is disabled
        logger.LogDebug("Order {OrderId} for {Customer}", order.Id, order.Customer);
    }
}
```

С `<AnalysisMode>All</AnalysisMode>` или явным уровнем серьёзности в `.editorconfig` этот единственный вызов сообщает о CA1873.

## Как правильно исправить CA1873?

Используйте генератор исходного кода `[LoggerMessage]`. Он порождает строго типизированный метод без массива params и без упаковки, поэтому анализатору нечего помечать, а среде выполнения нечего выделять, когда уровень отключён.

```csharp
// .NET 10, C# 14. The class must be partial.
public partial class OrderService(ILogger<OrderService> logger)
{
    public void Process(Order order) => LogOrder(order.Id, order.Customer);

    [LoggerMessage(Level = LogLevel.Debug, Message = "Order {OrderId} for {Customer}")]
    private partial void LogOrder(int orderId, string customer);
}
```

Сгенерированный метод проверяет `IsEnabled` до того, как обращается к своим аргументам, поэтому анализатор молчит, а вызов не стоит ничего, когда Debug выключен. Тот же механизм лежит в основе [замены new Regex(...) на генератор исходного кода GeneratedRegex](/ru/2026/08/how-to-replace-new-regex-with-the-generatedregex-source-generator-in-dotnet-11/); если такой подход вам незнаком, начните с материала о том, [что такое генератор исходного кода и когда он нужен](/ru/2026/06/what-is-a-source-generator-and-when-do-i-need-one/).

## Когда достаточно проверки IsEnabled?

Когда нужна правка в одну строку и нет желания перестраивать класс в partial-тип. Анализатор распознаёт такую проверку и подавляет диагностику:

```csharp
// .NET 10, C# 14
if (logger.IsEnabled(LogLevel.Debug))
{
    logger.LogDebug("Order {OrderId} for {Customer}", order.Id, order.Customer);
}
```

Есть два ограничения, и я проверил, что нарушение каждого из них даёт диагностику:

**Уровень должен совпадать точно.** Защита `LogDebug` проверкой `IsEnabled(LogLevel.Information)` по-прежнему сообщает о CA1873, поскольку анализатор сравнивает константу из проверки с уровнем вызова:

```csharp
if (logger.IsEnabled(LogLevel.Information))
{
    logger.LogDebug("v {V}", order.Describe());   // CA1873, levels differ
}
```

**Проверка должна быть встроенной.** Вынос её в свойство или вспомогательный метод полностью обходит анализ, поскольку анализатор обходит охватывающие операции в поисках буквального вызова `ILogger.IsEnabled`:

```csharp
private bool DebugOn => logger.IsEnabled(LogLevel.Debug);

public void Process(Order order)
{
    if (DebugOn) { logger.LogDebug("v {V}", order.Describe()); }   // CA1873
}
```

## Сколько на самом деле стоит незащищённый вызов?

Достаточно, чтобы иметь значение на горячем пути, и совершенно ничего за его пределами. Измерено с помощью BenchmarkDotNet 0.15.4 на .NET 10.0.5, Intel Core Ultra 7 265KF, с минимальным уровнем `Information`, так что вызов Debug отключён:

| Метод | Среднее | Ratio | Выделено |
| --- | ---: | ---: | ---: |
| Unguarded | 13.22 ns | 1.00 | 64 B |
| Guarded | 0.27 ns | 0.02 | 0 B |
| SourceGenerated | 0.51 ns | 0.04 | 0 B |

Эти 64 байта складываются из массива `object[2]` и упакованного `int`. Оба исправления снижают их до нуля. Обратите внимание на отношение, а не только на наносекунды: 13 нс на вызов не имеют значения в обработчике запроса, выполняющем запрос к базе данных, и очень важны в цикле, который выполняется миллион раз. Именно поэтому правило поставляется как предложение, а не как предупреждение.

## Какие уровни логирования проверяет CA1873?

По умолчанию Information и ниже. Обоснование, взятое из истории коммитов самого анализатора, состоит в том, что горячие пути пишут в Debug и Trace, тогда как Warning и Error встречаются достаточно редко, чтобы накладные расходы на вызов не имели значения.

Есть также недокументированный переключатель в `.editorconfig` для изменения порога:

```ini
# Not listed on the CA1873 docs page. Values: trace, debug, information, warning, error, critical
[*.{cs,vb}]
dotnet_code_quality.CA1873.max_log_level = warning
```

Перебор всех значений на SDK 10.0.201 даёт следующую картину и обнажает ошибку:

| `max_log_level` | Уровни, дающие CA1873 |
| --- | --- |
| `trace` | Trace, **Critical** |
| `debug` | Trace, Debug, **Critical** |
| `information` (по умолчанию) | Trace, Debug, Information, **Critical** |
| `warning` | Trace, Debug, Information, Warning, Critical |
| `error` | все шесть |

`LogCritical` срабатывает при любом пороге, включая `trace`. Это ошибка на единицу: поставленное сравнение исключает Critical из диапазона, на котором происходит досрочный выход.

```csharp
// dotnet/sdk commit 574cda32, "CA1873: Fix log level comparison"
-                    logLevel < LogLevelCritical &&
+                    logLevel <= LogLevelCritical &&
```

Исправление попало в `dotnet/sdk` 2026-06-19, уже после выхода SDK 10.0.201. Пока вы не перейдёте на SDK, который его содержит, вызовы `LogCritical` продолжат сообщать о CA1873 независимо от настройки `max_log_level`. Подавляйте их точечно, а не отключайте правило целиком.

## Известное ложное срабатывание: защищённые сгенерированные вызовы

Если обернуть сгенерированный метод логирования в проверку `IsEnabled`, анализатор всё равно сообщит о CA1873. Это зафиксировано как открытая проблема анализатора и воспроизводится на SDK 10.0.201:

```csharp
// .NET 10, C# 14. Guarded, source-generated, still reports CA1873.
if (logger.IsEnabled(LogLevel.Information))
{
    LogKeys([.. dictionary.Select(p => p.Key)]);
}

[LoggerMessage(Level = LogLevel.Information, Message = "keys {Keys}")]
private partial void LogKeys(string[] keys);
```

Проверка учитывается только тогда, когда она охватывает распознанный вызов `ILogger`. Для анализатора сгенерированный метод остаётся обычным методом, поэтому аргумент с выражением коллекции оценивается сам по себе и помечается. Подавляйте этот случай локально, пока исправление не вышло:

```csharp
#pragma warning disable CA1873
    LogKeys([.. dictionary.Select(p => p.Key)]);
#pragma warning restore CA1873
```

## Похожие правила, из-за которых сюда попадают по ошибке

**CA1848** ("For improved performance, use the LoggerMessage delegates") срабатывает в тех же местах вызова и имеет то же исправление, но касается стоимости разбора шаблона сообщения при каждом вызове, а не вычисления аргументов. Обычно вы увидите оба сразу, и `[LoggerMessage]` снимает оба.

**CA2254** ("The logging message template should not vary between calls") касается интерполяции строк, разрушающей ваши структурированные поля. Если вы гонитесь именно за этим, посмотрите [переход от интерполяции строк в ILogger к шаблонам сообщений](/ru/2026/07/migrate-from-ilogger-string-interpolation-to-message-templates-in-dotnet-11/), где разобраны также `SkipEnabledCheck` и `[LogProperties]`.

## Стоит ли просто отключить правило?

Для кодовой базы, которая пишет логи на уровне Information на путях обработки запросов и не имеет измеренных горячих циклов, да. Поставьте `none` и вернитесь к вопросу, когда профилирование покажет, что накладные расходы логирования важны:

```ini
[*.{cs,vb}]
dotnet_diagnostic.CA1873.severity = none
```

Более полезная середина состоит в том, чтобы оставить уровень серьёзности по умолчанию и применять `[LoggerMessage]` по мере необходимости. Вы получаете подсказку IDE в тех местах вызова, которые и так правите, отсутствие шума в CI, а логирование без выделений накапливается со временем вместо того, чтобы прийти рефакторингом на 400 файлов. Выигрыш по выделениям реален, просто он не срочный, а массив params за ним тот же самый, который C# 13 [начал устранять для других API](/ru/2026/01/c-13-the-end-of-params-allocations/).

## Связанные материалы

- [Переход от интерполяции строк в ILogger к шаблонам сообщений структурированного логирования в .NET 11](/ru/2026/07/migrate-from-ilogger-string-interpolation-to-message-templates-in-dotnet-11/)
- [Как скрывать конфиденциальные значения в логах с помощью LogProperties в .NET](/ru/2026/08/how-to-redact-sensitive-values-from-logs-with-logproperties-in-dotnet/)
- [Что такое генератор исходного кода и когда он нужен?](/ru/2026/06/what-is-a-source-generator-and-when-do-i-need-one/)
- [TreatWarningsAsErrors без вреда для сборок разработчика (.NET 10)](/ru/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/)
- [C# 13: конец выделениям params](/ru/2026/01/c-13-the-end-of-params-allocations/)

## Источники

- [CA1873: Avoid potentially expensive logging](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1873) на MS Learn
- [Add CA1873: Avoid potentially expensive logging](https://github.com/dotnet/roslyn-analyzers/pull/7290), исходный PR анализатора
- [Reduce noise from CA1873](https://github.com/dotnet/sdk/commit/bb4aee4d), добавивший параметр `max_log_level` и исключение для обращений к свойствам
- [CA1873: Fix log level comparison](https://github.com/dotnet/sdk/commit/574cda32), исправление ошибки на единицу для `LogCritical`
- [Ложные срабатывания CA1873, когда сообщение обёрнуто в проверку IsEnabled](https://github.com/dotnet/roslyn-analyzers/issues/7690)
- [Справочник по API LoggerMessageAttribute](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.logging.loggermessageattribute)
