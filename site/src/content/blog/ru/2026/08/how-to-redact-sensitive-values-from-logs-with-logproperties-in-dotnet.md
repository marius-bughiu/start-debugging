---
title: "Как скрывать чувствительные значения в журналах с помощью LogProperties и редактирования данных в .NET"
description: "Полное руководство по редактированию классифицированных данных в журналах, созданных генератором исходного кода: постройте таксономию, напишите Redactor, подключите EnableRedaction и AddRedaction и разберитесь с дискриминатором, который незаметно ломает частичное маскирование. С реальным выводом из Microsoft.Extensions.Compliance.Redaction 10.9.0."
pubDate: 2026-08-17
template: how-to
tags:
  - "dotnet"
  - "logging"
  - "security"
  - "source-generators"
lang: "ru"
translationOf: "2026/08/how-to-redact-sensitive-values-from-logs-with-logproperties-in-dotnet"
translatedBy: "claude"
translationDate: 2026-08-17
---

Редактирование чувствительных значений в журналах .NET требует трёх составных частей, и все они должны присутствовать: атрибут классификации данных на свойстве, `AddRedaction` для регистрации редакторов во внедрении зависимостей и `EnableRedaction` на построителе журналирования. Если пропустить классификацию, ничего не защищается. Если пропустить `EnableRedaction`, классифицированные значения полностью исчезают из структурированного состояния. Если пропустить `AddRedaction` при включённом `EnableRedaction`, необработанные значения записываются в ваши журналы открытым текстом. В этой статье разбираются все три части, а также дискриминатор редактирования, который незаметно ломает любой редактор с частичным маскированием.

Всё, что описано ниже, было скомпилировано и запущено с `Microsoft.Extensions.Compliance.Redaction` 10.9.0, `Microsoft.Extensions.Compliance.Abstractions` 10.9.0 и `Microsoft.Extensions.Telemetry` 10.9.0 на SDK .NET 10.0.201 с целевой платформой `net10.0`. Эти пакеты выходят в ритме `dotnet/extensions`, а не среды выполнения, и версия 10.9.0 (опубликована 2026-08-11) нацелена на `net8.0`, `net9.0`, `net10.0` и `net462`, поэтому тот же код применим от .NET 8 до текущих превью .NET 11. Выпуска 11.x этих пакетов пока не существует.

## Что генератор исходного кода действительно создаёт для классифицированного свойства

Вся возможность держится на одном факте: генератор исходного кода `[LoggerMessage]` помещает классифицированные значения в *отдельный массив*, отличный от массива обычных тегов. Для такого метода журналирования:

```csharp
// Microsoft.Extensions.Telemetry.Abstractions 10.9.0, net10.0
public static partial class Log
{
    [LoggerMessage(2, LogLevel.Information, "Via LogProperties")]
    public static partial void ViaProps(this ILogger logger, [LogProperties] Payment payment);
}
```

генератор создаёт (сокращённо, но в остальном дословно из `EmitCompilerGeneratedFiles`):

```csharp
var state = LoggerMessageHelper.ThreadLocalState;

_ = state.ReserveTagSpace(2);
state.TagArray[1] = new("{OriginalFormat}", "Via LogProperties");
state.TagArray[0] = new("payment.Amount", payment?.Amount);

_ = state.ReserveClassifiedTagSpace(2);
state.ClassifiedTagArray[1] = new("payment.CardNumber", payment?.CardNumber,
    new DataClassificationSet(_SensitiveAttribute));
state.ClassifiedTagArray[0] = new("payment.Cvv", payment?.Cvv,
    new DataClassificationSet(_SensitiveAttribute));
```

`Amount` попадает в `TagArray`. `CardNumber` и `Cvv` попадают в `ClassifiedTagArray` вместе с `DataClassificationSet`, полученным из атрибута. Здесь ничто ничего не редактирует: генератор только *помечает* значения. Тот, кто потребляет `LoggerMessageState`, решает, что произойдёт дальше, и именно поэтому подключение так важно. Если вы ещё не знаете, как `[LoggerMessage]` вообще порождает код, стоит сделать крюк через материал о том, [что такое генератор исходного кода и когда он нужен](/ru/2026/06/what-is-a-source-generator-and-when-do-i-need-one/).

## Построение таксономии, атрибутов и редактора

Классификация представляет собой пару `(TaxonomyName, Value)`. Определите их один раз в статическом классе, чтобы всё решение использовало единый словарь:

```csharp
// Microsoft.Extensions.Compliance.Abstractions 10.9.0
using Microsoft.Extensions.Compliance.Classification;

public static class Taxonomy
{
    public const string Name = "Contoso";

    public static DataClassification Sensitive => new(Name, nameof(Sensitive));
    public static DataClassification Pii => new(Name, nameof(Pii));
}
```

Примеры MS Learn для этой возможности показывают классифицированные параметры в виде `[MyTaxonomyClassifications.Private] string SSN`. Это не компилируется: статическое свойство не является атрибутом. Вам нужен настоящий подкласс `DataClassificationAttribute` для каждой классификации, и именно так корректно описывает это [документация по классификации данных](https://learn.microsoft.com/en-us/dotnet/core/extensions/data-classification):

```csharp
public sealed class SensitiveAttribute : DataClassificationAttribute
{
    public SensitiveAttribute() : base(Taxonomy.Sensitive) { }
}

public sealed class PiiAttribute : DataClassificationAttribute
{
    public PiiAttribute() : base(Taxonomy.Pii) { }
}
```

Теперь разметьте модель. Всё, что не имеет атрибута, журналируется как есть:

```csharp
public sealed class Payment
{
    [Sensitive] public string CardNumber { get; set; } = "";
    [Pii] public string Email { get; set; } = "";
    public int Amount { get; set; }
    [LogPropertyIgnore] public string InternalTrace { get; set; } = "";
}
```

Редактор представляет собой абстрактный класс с двумя членами. `GetRedactedLength` задаёт размер буфера назначения, `Redact` заполняет его и возвращает количество записанных символов:

```csharp
// Microsoft.Extensions.Compliance.Redaction 10.9.0
using Microsoft.Extensions.Compliance.Redaction;

public sealed class LastFourRedactor : Redactor
{
    public override int GetRedactedLength(ReadOnlySpan<char> input)
        => input.Length <= 4 ? input.Length : 4 + 4;

    public override int Redact(ReadOnlySpan<char> source, Span<char> destination)
    {
        if (source.Length <= 4)
        {
            source.CopyTo(destination);
            return source.Length;
        }

        "****".CopyTo(destination);
        source[^4..].CopyTo(destination[4..]);
        return 8;
    }
}
```

Сигнатура на основе span выбрана намеренно: конвейер журналирования редактирует из span в span через пулированный `JustInTimeRedactor`, поэтому хорошо написанный редактор не выделяет памяти на каждую запись журнала.

## Подключение

Четыре шага, и все четыре несущие:

1. Установите `Microsoft.Extensions.Compliance.Redaction` для редакторов и `Microsoft.Extensions.Telemetry` для интеграции с журналированием. Типы классификации приходят транзитивно из `Microsoft.Extensions.Compliance.Abstractions`.
2. Вызовите `AddRedaction` на коллекции служб и сопоставьте каждой классификации редактор.
3. Вызовите `EnableRedaction` на построителе журналирования. Это подставляет `ExtendedLogger`, единственный компонент, который читает `ClassifiedTagArray`.
4. Журналируйте через метод `[LoggerMessage]`, созданный генератором исходного кода. Редактирование не применяется к `logger.LogInformation(...)`.

```csharp
var services = new ServiceCollection();

services.AddLogging(b =>
{
    b.AddJsonConsole();
    b.EnableRedaction();          // Microsoft.Extensions.Logging namespace
});

services.AddRedaction(r =>
{
    r.SetRedactor<LastFourRedactor>(Taxonomy.Sensitive);
    r.SetFallbackRedactor<ErasingRedactor>();
});
```

`EnableRedaction` находится в пространстве имён `Microsoft.Extensions.Logging`, хотя поставляется в пакете `Microsoft.Extensions.Telemetry`, поэтому `using Microsoft.Extensions.Telemetry;` из официального примера не нужен.

## Три конфигурации и что каждая из них журналирует на самом деле

Вот здесь возможность и кусается. Ниже один и тот же `Payment`, записанный при трёх разных вариантах подключения, взятый из реального вывода `JsonConsole`.

**`AddRedaction` зарегистрирован, `EnableRedaction` не вызван.** Обычный `ILogger` никогда не смотрит в `ClassifiedTagArray`, поэтому классифицированные свойства отсутствуют в структурированном состоянии, а в уплощённом сообщении отображается заполнитель:

```json
{"State":{"Message":"customer.Plan=enterprise,customer.Id=42,customer.CardNumber=<omitted> ([Contoso:Sensitive]),customer.Email=<omitted> ([Contoso:Pii])","customer.Plan":"enterprise","customer.Id":42}}
```

Утечки нет, но и данных тоже нет, и никакая ошибка не сообщает, что редактирование отключено. Это поведение отслеживается в [issue 5163 репозитория dotnet/extensions](https://github.com/dotnet/extensions/issues/5163).

**`EnableRedaction` вызван, `AddRedaction` не вызывался.** Вот это опасный случай. Без `IRedactorProvider` в контейнере конвейер скатывается к сквозному редактору и записывает необработанное значение:

```json
{"State":{"customer.CardNumber":"4111111111111111:customer.CardNumber","customer.Email":"ada@contoso.com:customer.Email"}}
```

Номера ваших карт теперь лежат в файле журнала, причём с любезно приписанным именем тега. Ничто вас не предупреждает. Если вы вынесете из этой статьи одну мысль, пусть это будет такая: `EnableRedaction` и `AddRedaction` необходимо добавлять вместе, а интеграционный тест, который ищет известный секрет в приёмнике журналов, обходится дёшево.

**Оба вызваны.** Классифицированные значения редактируются, неклассифицированные проходят нетронутыми, а свойства с `[LogPropertyIgnore]` не появляются вовсе:

```json
{"State":{"payment.Email":"****","payment.CardNumber":"****","payment.Amount":1999}}
```

Вызвать `AddRedaction()` вообще без настройки безопасно: запасным вариантом по умолчанию служит `ErasingRedactor`, поэтому каждое классифицированное значение превращается в пустую строку. Проверено напрямую на поставщике: `GetRedactor` возвращает `ErasingRedactor` для несопоставленной классификации и для `DataClassification.Unknown`, а `NullRedactor` (сквозной) только для `DataClassification.None`.

## Дискриминатор, который ломает частичное маскирование

Зарегистрируйте `LastFourRedactor` из примера выше, запишите номер карты `4111111111111111`, и получите вот что:

```json
{"payment.CardNumber":"****mber","payment.Email":"****mail"}
```

`mber` представляет собой последние четыре символа строки `payment.CardNumber`, а не номера карты. Редактор никогда не видел само значение отдельно. Инструментирование `Redact` шпионом показывает, что именно приходит:

```text
[spy] Redact saw: "4111111111111111:payment.CardNumber" (len 35)
[spy] Redact saw: "ada@contoso.com:payment.Email"      (len 29)
```

Это сделано намеренно, а не по ошибке. `ExtendedLogger` строит каждое редактирование через `JustInTimeRedactor.Get(value, redactor, discriminator)`, где дискриминатором служит имя тега, а `LoggerRedactionOptions.ApplyDiscriminator` по умолчанию равен `true`. Задокументированное обоснование состоит в устойчивости к корреляции: включение имени тега в редактированный текст делает невозможным определить, что хешированные `user.Email` и `contact.Email` представляют собой один и тот же адрес. Для хеширующих редакторов это по-настоящему хорошее значение по умолчанию, а для всего, что анализирует входные данные, тихая ошибка корректности.

Исправление состоит в одной опции:

```csharp
b.EnableRedaction(o => o.ApplyDiscriminator = false);
```

С отключённым дискриминатором тот же редактор выдаёт ожидаемое:

```json
{"payment.CardNumber":"****1111","payment.Email":"****.com"}
```

Отключайте его только для редакторов, которым необходимо видеть настоящее значение. Если вы полагаетесь на хешированные значения, чтобы выявлять повторы в пределах одного поля, оставьте его включённым. Учтите, что редактор, вызванный напрямую через `IRedactorProvider`, никогда не видит дискриминатора, поэтому изолированный модульный тест вашего редактора пройдёт, пока конвейер журналирования ведёт себя неправильно. Тестируйте через логгер.

## Хеширование вместо стирания

`HmacRedactor` выдаёт устойчивый хеш `HMACSHA256`, что позволяет сопоставлять вхождения одного и того же значения, не сохраняя его:

```csharp
#pragma warning disable EXTEXP0002
services.AddRedaction(r => r.SetHmacRedactor(o =>
{
    o.KeyId = 42;
    o.Key = Convert.ToBase64String(keyBytes);   // base64, at least 44 chars
}, Taxonomy.Pii));
#pragma warning restore EXTEXP0002
```

Реальный вывод, с отключённым `ApplyDiscriminator`:

```json
{"payment.Email":"42:AjapxXMS14J9i8GFw62JBQ==","payment.CardNumber":""}
```

Префикс `42:` представляет собой `KeyId`, поэтому после ротации можно определить, каким ключом получен хеш. Две оговорки. `SetHmacRedactor` является экспериментальным и вызывает `EXTEXP0002`, поэтому нужно явное подавление либо `<NoWarn>$(NoWarn);EXTEXP0002</NoWarn>`. А `CardNumber` вышел пустым выше, потому что он классифицирован как `Sensitive`, для которого здесь нет сопоставленного редактора, и поэтому срабатывает запасной `ErasingRedactor`. Сопоставляйте редактор каждой определённой вами классификации, иначе запасной вариант молча решит за вас.

## Остальная поверхность LogProperties

У `[LogProperties]` больше настроек, чем использует большинство:

```csharp
[LoggerMessage(4, LogLevel.Information, "Charging customer")]
public static partial void Charging(this ILogger logger,
    [LogProperties(OmitReferenceName = false, SkipNullProperties = true)] Customer customer);
```

`OmitReferenceName` по умолчанию равен `false`, и именно это порождает префикс `customer.` в каждом имени тега; установите его в `true`, и теги станут просто `Id`, `Plan` и так далее. `SkipNullProperties = true` опускает свойства со значением null из состояния вместо записи null. Обе настройки представляют собой обычные опции времени компиляции без затрат во время выполнения.

Вложенные объекты по умолчанию не обходятся. Свойство `Customer.Address` сложного типа порождает предупреждение сборки вместо тихого преобразования в строку:

```text
warning LOGGEN036: The type "Address?" doesn't implement ToString(), IConvertible, or IFormattable
(did you forget to apply [LogProperties] or [TagProvider] to "Address"?)
```

Исправляется размещением `[LogProperties]` на самом вложенном свойстве, которое затем выдаёт теги `customer.Address.Street`, включая атрибуты классификации на `Address`. Существует также `[LogProperties(Transitive = true)]` для автоматического обхода графа, но он помечен как экспериментальный и обрушивает сборку с `EXTEXP0003`, пока не будет подавлен.

## Классификация значений, которые нельзя разметить атрибутами

Атрибуты работают только на типах, которые принадлежат вам. Для стороннего DTO или когда классификация зависит от состояния во время выполнения используйте `[TagProvider]` и классифицируйте внутри написанного вручную метода-сборщика:

```csharp
public static class SessionTagProvider
{
    public static void Provide(ITagCollector collector, Session session)
    {
        collector.Add("user", session.User);
        collector.Add("token", session.Token, new DataClassificationSet(Taxonomy.Sensitive));
    }
}

[LoggerMessage(2, LogLevel.Information, "Session opened")]
public static partial void Opened(this ILogger logger,
    [TagProvider(typeof(SessionTagProvider), nameof(SessionTagProvider.Provide),
                 OmitReferenceName = true)] Session session);
```

Перегрузка `ITagCollector.Add`, принимающая `DataClassificationSet`, представляет собой программный эквивалент атрибута классификации, и значение попадает в `ClassifiedTagArray` точно так же. Следите за именованием: по умолчанию имя параметра добавляется перед тем ключом, который вы передаёте, поэтому `collector.Add("session.token", ...)` для параметра с именем `session` порождает тег `session.session.token`. Передавайте простые ключи и позвольте имени параметра дать префикс, либо передавайте простые ключи и задайте `OmitReferenceName = true`, чтобы убрать префикс полностью. Не выписывайте префикс самостоятельно.

## Доказательство тестом

`FakeLogger` из `Microsoft.Extensions.Diagnostics.Testing` 10.9.0 работает за тем же `ExtendedLogger`, поэтому редактирование применяется, а редактированные теги доступны для чтения через `FakeLogCollector`. Это делает проверку на утечку простой:

```csharp
var services = new ServiceCollection();
services.AddLogging(b => { b.AddFakeLogging(); b.EnableRedaction(); });
services.AddRedaction(r => r.SetRedactor<StarRedactor>(Taxonomy.Sensitive));

using var sp = services.BuildServiceProvider();
sp.GetRequiredService<ILoggerFactory>().CreateLogger("T")
  .Taken(new Payment { CardNumber = "4111111111111111", Amount = 1999 });

var records = sp.GetRequiredService<FakeLogCollector>().GetSnapshot();
Assert.DoesNotContain("4111111111111111",
    string.Join('\n', records.SelectMany(r => r.StructuredState ?? [])
                             .Select(kv => $"{kv.Key}={kv.Value}")));
```

Структурированное состояние этой записи выглядит ровно так: `payment.CardNumber = ****`, `payment.Amount = 1999`, `{OriginalFormat} = Payment taken`. Проверяйте отсутствие секрета, а не наличие `****`, чтобы тест по-прежнему ловил регрессию, если кто-нибудь заменит редактор.

Две вещи меня удивили. Редактирование применяется только к методам журналирования, созданным генератором исходного кода, поэтому любой оставшийся в коде `logger.LogInformation($"card {card}")` совершенно не защищён. Если вы ещё не проводили такую зачистку, [перевод интерполированных вызовов ILogger на шаблоны сообщений](/ru/2026/07/migrate-from-ilogger-string-interpolation-to-message-templates-in-dotnet-11/) является предварительным условием для всей этой возможности. Во-вторых, `EnableRedaction` меняет то, что `JsonConsole` записывает во вложенное поле `State.Message`: оно превращается в буквальную строку `Microsoft.Extensions.Logging.ExtendedLogger+ModernTagJoiner`. Поле `Message` верхнего уровня остаётся правильным, и каждый отдельный тег по-прежнему присутствует, но если у вас есть нижестоящий парсер, читающий `State.Message`, он сломается. Структурированные приёмники, перечисляющие состояние, вроде описанных в [руководстве по настройке Serilog и Seq](/ru/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) или в [конвейере журналирования на OpenTelemetry](/ru/2026/06/migrate-from-serilog-to-opentelemetry-logging-in-dotnet-11/), не затронуты.

Самый сильный аргумент в пользу этой возможности состоит в том, что классификация живёт на модели, рядом со свойством, где её увидит разработчик, добавляющий поле. Политика редактирования живёт в одном вызове в корне композиции, который проверяющий безопасность прочитает за десять секунд. Такое разделение стоит затрат на настройку при условии, что вы действительно его проверяете: добавьте один тест, который журналирует полностью заполненную модель в приёмник в памяти и падает, если в выводе появляется любая известная секретная строка.

## Источники

- [Генерация кода журналирования во время компиляции](https://learn.microsoft.com/en-us/dotnet/core/extensions/logging/source-generation), MS Learn
- [Классификация данных в .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/data-classification), MS Learn
- [Редактирование данных в .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/data-redaction), MS Learn
- [ExtendedLogger.ModernPath](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Telemetry/Logging/ExtendedLogger.cs) и [JustInTimeRedactor](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Telemetry/Logging/JustInTimeRedactor.cs), dotnet/extensions
- [LoggerRedactionOptions.ApplyDiscriminator](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Telemetry/Logging/LoggerRedactionOptions.cs), dotnet/extensions
- [Issue 5163 репозитория dotnet/extensions](https://github.com/dotnet/extensions/issues/5163), о выводе LogProperties при отключённом редактировании
