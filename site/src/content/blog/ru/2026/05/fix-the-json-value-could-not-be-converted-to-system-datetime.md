---
title: "Fix: The JSON value could not be converted to System.DateTime"
description: "System.Text.Json принимает для DateTime только строки в ISO 8601. Отправляйте 2026-05-08T14:00:00Z или зарегистрируйте JsonConverter, разбирающий ваш формат. Пустые строки и Unix-таймстампы тоже бросают исключение."
pubDate: 2026-05-08
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "json"
lang: "ru"
translationOf: "2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime"
translatedBy: "claude"
translationDate: 2026-05-08
---

Решение: `System.Text.Json` десериализует `DateTime` только из JSON-строки в расширенном формате ISO 8601, например `"2026-05-08T14:00:00Z"` или `"2026-05-08T14:00:00+02:00"`. Если ваш производитель отправляет `"05/08/2026"`, пустую строку `""`, число с Unix-таймстампом или `"/Date(1746715200000)/"` от Newtonsoft, десериализатор бросает исключение. Либо измените формат на проводе на ISO 8601, либо зарегистрируйте `JsonConverter<DateTime>`, который умеет разбирать то, что вы реально получаете.

```text
System.Text.Json.JsonException: The JSON value could not be converted to System.DateTime. Path: $.startedAt | LineNumber: 0 | BytePositionInLine: 27.
   at System.Text.Json.ThrowHelper.ReThrowWithPath(ReadStack& state, JsonReaderException ex)
   at System.Text.Json.Serialization.JsonConverter`1.ReadCore(Utf8JsonReader& reader, JsonSerializerOptions options, ReadStack& state)
   at System.Text.Json.JsonSerializer.ReadFromSpan[TValue](ReadOnlySpan`1 utf8Json, JsonTypeInfo jsonTypeInfo)
   at System.Text.Json.JsonSerializer.Deserialize[TValue](String json, JsonSerializerOptions options)
 ---> System.FormatException: The JSON value is not in a supported DateTime format.
```

Это руководство написано против .NET 11 preview 4 и `System.Text.Json` 11.0.0-preview.4. Принимаемый формат и исключение не менялись с момента выпуска `System.Text.Json` в .NET Core 3.0; текст внутреннего `FormatException` подтянули примерно в .NET 8. Сегмент `Path` это JSON-путь к проблемному свойству и первое, что нужно прочитать, он сообщает, на каком поле споткнулся конвертер, без какой-либо инструментации.

## Почему System.Text.Json настолько строгий

`System.Text.Json` намеренно реализует только профиль [ISO 8601-1:2019 Extended](https://learn.microsoft.com/en-us/dotnet/standard/datetime/system-text-json-support) для `DateTime` и `DateTimeOffset`. Формат должен быть `YYYY-MM-DDTHH:mm:ss[.fffffff][Z|+hh:mm]` с литералом `T` в качестве разделителя. Строчная `t`, пробел вместо разделителя, американский стиль `MM/dd/yyyy`, двузначный год, отсутствующие секунды, значения только-время или только-дата отвергаются. Также отвергается JSON-токен `null`, если только свойство не является `DateTime?` с поддержкой null, и пустая строка `""`.

Это сделано намеренно: разрешающий мульти-форматный парсер Newtonsoft.Json вызывал реальные баги, когда производитель в одной локали отправлял `01/05/2026`, а потребитель в другой молча разбирал это как неправильную дату. `System.Text.Json` обращается с разбором DateTime так же, как с числами в JSON: одна каноническая форма, никаких догадок.

Так что десериализатор справедливо бросает исключение. Задача либо привести провод в соответствие, либо зарегистрировать конвертер, который ровно один раз отображает ваш формат на проводе в `DateTime`.

## Минимальное воспроизведение

```csharp
// .NET 11, C# 14, System.Text.Json 11.0.0-preview.4
using System.Text.Json;

record Event(DateTime StartedAt);

var bad = """{ "startedAt": "05/08/2026" }""";
var ev = JsonSerializer.Deserialize<Event>(bad); // throws
```

Производитель отправил дату со слэшами в американском стиле, а `System.Text.Json` такого формата не знает. Та же ошибка срабатывает на любом из этих payload-ов:

```json
{ "startedAt": "" }
{ "startedAt": "2026-05-08" }
{ "startedAt": 1746715200 }
{ "startedAt": "/Date(1746715200000)/" }
{ "startedAt": "2026-05-08 14:00:00" }
{ "startedAt": "Friday, May 8, 2026" }
```

Каждый падает по своей причине. Пустая строка не разбирается как дата. Голая дата `"2026-05-08"` без компонента времени, ISO 8601 Extended требует `T` и время. Число Unix-таймстампа в принципе не привязывается к `DateTime`. Синтаксис `/Date(...)` исторический артефакт Newtonsoft. Формат, разделённый пробелом, это ISO 8601 Basic, а не Extended. Английская длинная форма не машинный формат.

## Решение, в деталях

### 1. Заставьте производителя отправлять ISO 8601

Правильный ответ исправить в источнике. ISO 8601 Extended с `T` и UTC-`Z` (или явным офсетом) совершает round-trip между всеми современными стеками: `Date.prototype.toISOString()` в JavaScript, `datetime.isoformat()` в Python, `to_char(... 'YYYY-MM-DD"T"HH24:MI:SSOF')` в Postgres, `Instant.toString()` в Java и `DateTime.UtcNow.ToString("o")` в .NET, все его выдают.

```csharp
// .NET 11, C# 14
var iso = DateTime.UtcNow.ToString("o"); // 2026-05-08T14:00:00.0000000Z
```

Если вы контролируете производителя, это работа на одну строку. Избегайте `"u"` (использует пробел в качестве разделителя, а не `T`) и избегайте сериализации `DateTime.Now` без офсета, что создаёт значения с kind `Unspecified`, неоднозначно проходящие round-trip.

### 2. Зарегистрируйте JsonConverter для не-ISO форматов

Когда вы не можете изменить производителя (сторонний API, устаревший payload), пишите конвертер. Шаблон конвертера одинаков независимо от исходного формата, меняется только вызов разбора.

```csharp
// .NET 11, C# 14, System.Text.Json 11.0.0-preview.4
using System.Buffers;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

public sealed class UsSlashDateConverter : JsonConverter<DateTime>
{
    private const string Format = "MM/dd/yyyy";

    public override DateTime Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options)
    {
        var text = reader.GetString();
        return DateTime.ParseExact(
            text!, Format, CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);
    }

    public override void Write(
        Utf8JsonWriter writer,
        DateTime value,
        JsonSerializerOptions options)
        => writer.WriteStringValue(value.ToUniversalTime().ToString(Format, CultureInfo.InvariantCulture));
}
```

Зарегистрируйте его один раз в опциях, не создавайте экземпляр в каждой точке вызова:

```csharp
// .NET 11
var options = new JsonSerializerOptions
{
    Converters = { new UsSlashDateConverter() }
};
var ev = JsonSerializer.Deserialize<Event>(bad, options);
```

Всегда передавайте `CultureInfo.InvariantCulture` и фиксируйте точный формат через `ParseExact`. `Parse` и `TryParse` опираются на текущую культуру и снова привносят ту самую неоднозначность, которую ISO 8601 был призван убрать. Детали обвязки конвертера разобраны в [руководстве по пользовательскому JsonConverter](/ru/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/), где описаны трюки горячего пути (`Utf8JsonReader.ValueSpan`, разбор по span), важные, когда конвертер находится в высокопропускном конвейере.

### 3. Конвертируйте Unix-таймстампы с помощью читателя, понимающего числа

Если на проводе число (`"startedAt": 1746715200`), `reader.GetString()` бросит, потому что токен это `Number`, а не `String`. Ветвитесь по `TokenType`:

```csharp
// .NET 11, C# 14, System.Text.Json 11.0.0-preview.4
public sealed class UnixSecondsConverter : JsonConverter<DateTime>
{
    public override DateTime Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options)
    {
        return reader.TokenType switch
        {
            JsonTokenType.Number => DateTimeOffset.FromUnixTimeSeconds(reader.GetInt64()).UtcDateTime,
            JsonTokenType.String when long.TryParse(reader.GetString(), out var s)
                => DateTimeOffset.FromUnixTimeSeconds(s).UtcDateTime,
            JsonTokenType.String
                => DateTime.Parse(reader.GetString()!, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind),
            _ => throw new JsonException($"Unexpected token {reader.TokenType} for DateTime.")
        };
    }

    public override void Write(
        Utf8JsonWriter writer,
        DateTime value,
        JsonSerializerOptions options)
        => writer.WriteNumberValue(new DateTimeOffset(value, TimeSpan.Zero).ToUnixTimeSeconds());
}
```

Это конвертер, который вы пишете для старых REST API, смешивающих строковые и числовые payload-ы (Twitter, Stripe, устаревшие поля Slack). `DateTimeOffset.FromUnixTimeSeconds` правильный помощник, не умножайте на 10 000 ради значения `Ticks`, этот путь теряет субсекундную точность и игнорирует разницу эпох.

### 4. Считайте пустые строки эквивалентом null

Распространённая особенность API отправлять `""` для "нет даты". Десериализатор не может привязать пустую строку ни к `DateTime`, ни к `DateTime?`. Сделайте свойство допускающим null и добавьте конвертер, возвращающий `null` на пустом входе:

```csharp
// .NET 11, C# 14, System.Text.Json 11.0.0-preview.4
public sealed class NullableEmptyDateTimeConverter : JsonConverter<DateTime?>
{
    public override DateTime? Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.Null) return null;
        var text = reader.GetString();
        if (string.IsNullOrEmpty(text)) return null;
        return DateTime.Parse(text, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind);
    }

    public override void Write(
        Utf8JsonWriter writer,
        DateTime? value,
        JsonSerializerOptions options)
    {
        if (value is null) writer.WriteNullValue();
        else writer.WriteStringValue(value.Value.ToString("o", CultureInfo.InvariantCulture));
    }
}
```

Применяйте его на уровне свойства, если плохо себя ведёт только одно поле, через `[JsonConverter(typeof(NullableEmptyDateTimeConverter))]` на свойстве. Глобальная регистрация выше заменяет конвертер по умолчанию для каждого `DateTime?` в графе; атрибут на уровне свойства уже и безопаснее.

### 5. Используйте DateOnly, когда времени нет

Если на проводе действительно `"2026-05-08"` (календарная дата без времени суток), типом на стороне потребителя должен быть `DateOnly`, а не `DateTime`. `System.Text.Json` 8.0+ имеет встроенную поддержку и принимает формат даты ISO 8601 напрямую:

```csharp
// .NET 11, C# 14
record Event(DateOnly StartedOn);

var json = """{ "startedOn": "2026-05-08" }""";
var ev = JsonSerializer.Deserialize<Event>(json); // works, no converter needed
```

`DateOnly` был добавлен в .NET 6 именно потому, что дата-без-времени самый частый связанный с DateTime баг моделирования. Если ваш домен действительно календарный день (день рождения, дата доставки, праздник), смените тип, и проблема разбора JSON испарится.

## Распространённые формы, которые это запускают

### Свойство имеет тип struct DateTime, но значение может отсутствовать

Не допускающий null `DateTime` не может содержать "отсутствует". Производитель отправляет `null` или `""`, десериализатор бросает. Сделайте свойство `DateTime?`. Если вы не контролируете схему, `[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]` чистит round-trip на выходе, но путь чтения всё равно требует допускающего null.

### Настроенный формат даты Newtonsoft просочился в контракт

Если вы мигрируете с Newtonsoft.Json, в старом коде, скорее всего, был `IsoDateFormatString = "MM/dd/yyyy"` или `DateTimeFormat`, заданный на `JsonSerializerSettings`. Newtonsoft это принимал, `System.Text.Json` эту настройку вообще не уважает. Поищите в репозитории `DateFormatHandling`, `DateTimeFormat` и `IsoDateFormatString`, а затем либо исправьте производителя, либо напишите конвертер выше. Команда vstest [удалила транзитивную зависимость от Newtonsoft.Json](/ru/2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4/) в .NET 11 preview 4 по схожим причинам ужесточения контракта.

### Привязка модели MVC проглатывает внутреннее исключение

В ASP.NET Core невалидная дата в теле запроса даёт `400 Bad Request` с `{"errors":{"$.startedAt":["The JSON value could not be converted to System.DateTime..."]}}`. `Path: $.startedAt` из внутреннего исключения попадает в словарь `errors`. Если вы видите только "One or more validation errors occurred", смотрите тело ответа, проблемный путь там.

### Генераторы исходного кода скрывают регистрацию конвертера

Когда вы переходите на генерацию исходного кода `System.Text.Json` через `[JsonSerializable]` и `JsonSerializerContext`, конвертеры нужно регистрировать на том же контексте, а не только на runtime-`JsonSerializerOptions`. Генератор выдаёт `TypeInfo` для каждого корневого типа во время компиляции, и конвертер, который вы забыли подключить к контексту, на рантайме невидим. [Пост про interceptors и генерацию исходного кода](/ru/2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics/) проходит форму регистрации, переживающую trimming и AOT.

### Часовой пояс зашит в имени свойства, а не в значении

Схема вида `{"startedAtUtc": "2026-05-08T14:00:00"}` (без `Z`, но имя свойства утверждает UTC) разбирается в `DateTimeKind.Unspecified`. Не бросает, но round-trip неверный: `ToUniversalTime` будет считать его локальным. Либо исправьте производителя, чтобы он выдавал `Z`, либо используйте `DateTimeOffset`, чтобы офсет был явным. Ещё лучше моделируйте значение как `DateTime` с конвертером, утверждающим `Kind == Utc` и бросающим на всём остальном, шаблон строгого конвертера ловит дрейф рано.

## Варианты, похожие на эту ошибку, но иные

### "The JSON value could not be converted to System.DateTimeOffset"

Та же семья первопричин, чуть другой домен. `DateTimeOffset` требует явного офсета (`Z` или `+hh:mm`) и отвергает строки в форме `Unspecified`, которые принял бы голый `DateTime`. Решение той же формы: отправляйте офсет или пишите конвертер. Избегайте round-trip-а `DateTimeOffset` через `DateTime`, если он у вас есть в домене, информация об офсете это данные.

### "Cannot get the value of a token type 'Number' as a String"

Другое исключение, другой стек. Означает, что конвертер или читатель по умолчанию вызвал `GetString()` на JSON-токене `Number`. Решение ветвиться по `reader.TokenType` перед чтением. Конвертер из варианта 3 выше каноническая форма.

### "A possible object cycle was detected"

Цикл ссылок, не разбор даты. Установите `ReferenceHandler = ReferenceHandler.IgnoreCycles` (или `Preserve` для полного round-trip-а графа) в опциях. Компромиссы разобраны в [руководстве по обработке циклов](/ru/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) (тот же пост о конвертере описывает опцию циклов в разделе с подвохами).

### "The JSON value could not be converted to System.Guid"

Тот же класс исключения (`JsonException`), та же форма сообщения, другой целевой тип. Причина похожая: строка Guid не в одном из четырёх форматов, которые принимает `System.Text.Json` (`D`, `N`, `B`, `P`). Решение снова либо исправить производителя, чтобы отправлял `D` (форму с дефисами), либо написать конвертер, вызывающий `Guid.ParseExact`.

### "The JSON value could not be converted to System.Enum"

Та же семья. Решение `JsonStringEnumConverter` (встроенный), зарегистрированный в опциях; конвертер принимает как числовые, так и строковые формы и настраивается по чувствительности к регистру. Также возможно по enum через `[JsonConverter(typeof(JsonStringEnumConverter<MyEnum>))]` начиная с .NET 8, что предпочтительнее под trimming, поскольку не отражается над каждым enum в сборке.

## Связанное

Для обвязки конвертера, на которую опираются решения выше, [руководство по пользовательскому JsonConverter](/ru/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) разбирает приёмы разбора по байтовым span на горячих путях. [Пост про PascalCase именование на уровне члена](/ru/2026/04/system-text-json-11-pascalcase-per-member-naming/) показывает обходы `[JsonPropertyName]` и политики именования, которые решают связанные ошибки 400 "неправильное имя свойства". Если ваш DateTime сохраняется в EF Core 11 как JSON-колонка, [руководство по JSON contains в SQL Server 2025](/ru/2026/04/efcore-11-json-contains-sql-server-2025/) объясняет, как база данных гоняет ту же ISO 8601 строку. Для параллельной диагностики "неправильный тип" с более крупными последствиями для графа [маршрут миграции с Newtonsoft на System.Text.Json](/ru/2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4/) канонический кейс самой команды .NET.

## Источники

- [DateTime and DateTimeOffset support in System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/datetime/system-text-json-support), Microsoft Learn.
- [How to write custom converters](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/converters-how-to), Microsoft Learn.
- [`DateTimeStyles` enumeration](https://learn.microsoft.com/en-us/dotnet/api/system.globalization.datetimestyles), Microsoft Learn.
- [`DateTimeOffset.FromUnixTimeSeconds`](https://learn.microsoft.com/en-us/dotnet/api/system.datetimeoffset.fromunixtimeseconds), Microsoft Learn.
- [System.Text.Json source repository](https://github.com/dotnet/runtime/tree/main/src/libraries/System.Text.Json), dotnet/runtime on GitHub.
- [`DateOnly` and `TimeOnly` types](https://learn.microsoft.com/en-us/dotnet/api/system.dateonly), Microsoft Learn.
