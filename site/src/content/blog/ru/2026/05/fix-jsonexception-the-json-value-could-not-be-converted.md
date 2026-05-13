---
title: "Исправление: System.Text.Json.JsonException: The JSON value could not be converted"
description: "System.Text.Json выбрасывает это исключение, когда входящий JSON-токен не соответствует целевому типу CLR. Согласуйте JSON с типом или зарегистрируйте JsonConverter или JsonSerializerOption, которые их связывают."
pubDate: 2026-05-13
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "json"
lang: "ru"
translationOf: "2026/05/fix-jsonexception-the-json-value-could-not-be-converted"
translatedBy: "claude"
translationDate: 2026-05-13
---

Исправление: `System.Text.Json` выбросил это исключение, потому что JSON-токен по указанному пути не может быть десериализован в целевой тип CLR. Сообщение обычно встречается в двух формах. Либо у JSON неверный **вид токена** (строка там, где ожидалось число, или наоборот, или число там, где ожидалось значение enum), либо JSON правильного вида, но **содержимое** не соответствует правилам разбора типа (дата не в формате ISO, некорректный `Guid`, литерал вроде `"NaN"`). Выберите одно из трёх исправлений для каждой точки вызова: измените производителя так, чтобы он выдавал ожидаемую форму JSON, включите конвертер, принимающий форму, которую вы на самом деле получаете (`JsonStringEnumConverter`, `JsonNumberHandling.AllowReadingFromString`), или напишите `JsonConverter<T>`, который выполняет разбор сам.

```text
System.Text.Json.JsonException: The JSON value could not be converted to MyApp.OrderStatus. Path: $.status | LineNumber: 0 | BytePositionInLine: 21.
   at System.Text.Json.ThrowHelper.ThrowJsonException(String message)
   at System.Text.Json.Serialization.Converters.EnumConverter`1.Read(Utf8JsonReader& reader, Type typeToConvert, JsonSerializerOptions options)
   at System.Text.Json.Serialization.JsonConverter`1.ReadCore(Utf8JsonReader& reader, JsonSerializerOptions options, ReadStack& state)
   at System.Text.Json.JsonSerializer.ReadFromSpan[TValue](ReadOnlySpan`1 utf8Json, JsonTypeInfo jsonTypeInfo)
   at System.Text.Json.JsonSerializer.Deserialize[TValue](String json, JsonSerializerOptions options)
```

Это руководство написано против .NET 11 preview 4 и `System.Text.Json` 11.0.0-preview.4. Тип исключения и поля `Path` / `LineNumber` / `BytePositionInLine` остаются стабильными с момента появления `System.Text.Json` в .NET Core 3.0, поэтому все исправления ниже применимы к .NET 6, 8, 10 и 11 без изменений. Между версиями меняются только настройки конвертера: `JsonNumberHandling` появился в .NET 5, `JsonStringEnumConverter<TEnum>` (обобщённая, дружественная к AOT версия) вышел в .NET 8, а атрибут `[JsonStringEnumMemberName]` появился в .NET 9.

Первое, что нужно прочитать, это сегмент **`Path`**. Это путь в стиле JSON Pointer с `$` в качестве корня, и он точно сообщает, на каком свойстве запнулся читатель. Поисковики обычно приводят вас к трассировке стека, в которой назван обобщённый конвертер ("the JSON value could not be converted to `Int32`") без указания свойства, но `Path` всегда присутствует. Если вы не видите сегмента `Path`, значит, вы смотрите на завёрнутое исключение. Перехватывайте `JsonException` прямо в точке вызова десериализации и читайте `ex.Path` из свойства, а не из `ex.Message`.

## Почему System.Text.Json отказывается приводить типы

В отличие от `Newtonsoft.Json`, `System.Text.Json` **строг по умолчанию**: он не приводит между видами JSON-токенов и не запускает парсер с потерями над содержимым строки. Если ваша конечная точка принимает `{ "amount": "12.50" }`, а ваш DTO имеет `decimal Amount`, читатель видит `JsonTokenType.String`, не находит встроенного преобразования из `string` в `decimal` и выбрасывает. Та же логика отвергает:

- JSON-строку там, где свойство ожидает `bool`, `int`, `long`, `decimal`, `double`, `Guid`, `DateTime` или `TimeSpan`. Обратное направление (JSON-число там, где свойство ожидает `string`) тоже отвергается.
- JSON-число, обозначающее значение enum, когда `JsonStringEnumConverter` не зарегистрирован, **или** JSON-строку, обозначающую значение enum, когда действует конвертер по умолчанию, принимающий только целые числа.
- Пустую строку `""` там, где свойство ожидает значимый тип. Пустые строки не то же самое, что `null`, а значимые типы не допускают null, пока не объявлены как `T?`.
- Полиморфный JSON-объект, где дискриминатор не соответствует ни одному `[JsonDerivedType]`, который вы зарегистрировали.
- Литерал с плавающей точкой вроде `"NaN"`, `"Infinity"` или `"-Infinity"`, когда не установлен `JsonNumberHandling.AllowNamedFloatingPointLiterals`.
- Число Unix-timestamp (`1715600000`) для свойства `DateTime`, потому что `System.Text.Json` читает `DateTime` только из строки ISO 8601. Этот частный случай разобран в [каноническом исправлении для преобразования DateTime](/ru/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/).

Строгость - это дизайн, а не баг. Обоснование команды в том, что преобразование с потерями - самый частый источник тихого повреждения данных в бизнес-приложениях, и что явная регистрация конвертера делает намерение видимым на стыке между форматом передачи и системой типов. Компромисс в том, что каждый сквозной аспект, который вы раньше получали из значений по умолчанию `Newtonsoft.Json` (строка-в-число, строка-в-enum, строка-в-bool), теперь требует явного включения.

## Минимальное воспроизведение

Минимальная программа, воспроизводящая самый частый вариант - enum, приходящий как строка:

```csharp
// .NET 11 preview 4, System.Text.Json 11.0.0-preview.4
using System.Text.Json;

var json = """{ "status": "Pending" }""";

var order = JsonSerializer.Deserialize<Order>(json);

Console.WriteLine(order!.Status);

public record Order(OrderStatus Status);
public enum OrderStatus { Pending, Shipped, Delivered }
```

Запуск выбрасывает:

```text
Unhandled exception. System.Text.Json.JsonException:
The JSON value could not be converted to OrderStatus. Path: $.status | LineNumber: 0 | BytePositionInLine: 20.
```

Стандартный конвертер enum принимает только **целочисленное** представление (`{ "status": 0 }`). Всё остальное вызывает исключение. Как только вы понимаете, что это режим отказа, все остальные варианты в этом посте следуют той же схеме: форма JSON не соответствует типу, и вы выбираете, какую сторону гнуть.

## Исправление 1: enum, полученные как строки

Зарегистрируйте `JsonStringEnumConverter<TEnum>` один раз в ваших `JsonSerializerOptions`:

```csharp
// .NET 11 preview 4, System.Text.Json 11.0.0-preview.4
var options = new JsonSerializerOptions
{
    Converters = { new JsonStringEnumConverter<OrderStatus>() }
};

var order = JsonSerializer.Deserialize<Order>(json, options)!;
```

Если у вас много enum, зарегистрируйте вместо этого необобщённый `JsonStringEnumConverter()`. Он применяется к каждому типу enum, который встречает сериализатор, ценой несовместимости с обрезкой Native AOT. Для Native AOT предпочтите обобщённый конвертер для каждого enum или аннотируйте каждый enum напрямую через `[JsonConverter(typeof(JsonStringEnumConverter<OrderStatus>))]`, а глобальный список конвертеров оставьте пустым.

Если производитель чувствителен к регистру ("PENDING" в проводе, `Pending` в C#), передайте политику именования:

```csharp
var options = new JsonSerializerOptions
{
    Converters =
    {
        new JsonStringEnumConverter<OrderStatus>(JsonNamingPolicy.SnakeCaseUpper)
    }
};
```

Для производителей, отправляющих значения, не представимые как идентификаторы C# ("in-progress", "n/a"), .NET 9 ввёл `[JsonStringEnumMemberName]`:

```csharp
public enum OrderStatus
{
    Pending,

    [JsonStringEnumMemberName("in-progress")]
    InProgress,

    Delivered
}
```

В минимальных API ASP.NET Core настройте конвертер на `JsonSerializerOptions` приложения, чтобы каждая конечная точка его подхватила:

```csharp
// .NET 11 preview 4, ASP.NET Core 11.0.0-preview.4
builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.Converters.Add(new JsonStringEnumConverter<OrderStatus>());
});
```

Для контроллеров эквивалентный вызов - `builder.Services.AddControllers().AddJsonOptions(o => o.JsonSerializerOptions.Converters.Add(...))`. Однократная настройка в корне композиции предпочтительнее открытия `JsonConverter` через каждый атрибут `[JsonConverter(...)]`.

## Исправление 2: числа, полученные как строки (и наоборот)

Когда производитель кодирует числовое поле в JSON как строку, `{ "amount": "12.50" }`, включите `JsonNumberHandling.AllowReadingFromString`:

```csharp
// .NET 11 preview 4, System.Text.Json 11.0.0-preview.4
var options = new JsonSerializerOptions
{
    NumberHandling = JsonNumberHandling.AllowReadingFromString
};

var dto = JsonSerializer.Deserialize<Invoice>(json, options);

public record Invoice(decimal Amount);
```

`AllowReadingFromString` работает для каждого целочисленного типа и типа с плавающей точкой, а также `decimal`. Он симметричен `WriteAsString`, которое можно скомбинировать, если хотите, чтобы сериализатор и выдавал, и читал значение как строку:

```csharp
NumberHandling = JsonNumberHandling.AllowReadingFromString | JsonNumberHandling.WriteAsString
```

Для области видимости на уровне свойства, а не глобально, аннотируйте свойство напрямую:

```csharp
public record Invoice(
    [property: JsonNumberHandling(JsonNumberHandling.AllowReadingFromString)] decimal Amount
);
```

Обратный случай, JSON-число, отправленное там, где ожидается `string` (идентификатор отслеживания, закодированный как `42` вместо `"42"`), **не** покрывается `JsonNumberHandling`. Нужен небольшой пользовательский конвертер:

```csharp
// .NET 11 preview 4
public sealed class NumberOrStringConverter : JsonConverter<string>
{
    public override string? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        => reader.TokenType switch
        {
            JsonTokenType.String => reader.GetString(),
            JsonTokenType.Number => reader.GetInt64().ToString(System.Globalization.CultureInfo.InvariantCulture),
            JsonTokenType.Null => null,
            _ => throw new JsonException()
        };

    public override void Write(Utf8JsonWriter writer, string value, JsonSerializerOptions options)
        => writer.WriteStringValue(value);
}
```

Контракт конвертера я подробнее разбираю в [руководстве по написанию пользовательского JsonConverter](/ru/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/), включая то, как комбинировать конвертеры и как сокращать полиморфную диспетчеризацию.

## Исправление 3: булевы значения, полученные как 0 / 1 или как строки "true" / "false"

`System.Text.Json` принимает для `bool` только JSON-токены `true` / `false`. Числовые `0` / `1` и строковые `"true"` / `"false"` оба отвергаются. Встроенной опции для какой-либо из форм нет; напишите конвертер:

```csharp
// .NET 11 preview 4
public sealed class LooseBooleanConverter : JsonConverter<bool>
{
    public override bool Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        => reader.TokenType switch
        {
            JsonTokenType.True => true,
            JsonTokenType.False => false,
            JsonTokenType.Number => reader.GetInt32() != 0,
            JsonTokenType.String => bool.Parse(reader.GetString()!),
            _ => throw new JsonException()
        };

    public override void Write(Utf8JsonWriter writer, bool value, JsonSerializerOptions options)
        => writer.WriteBooleanValue(value);
}
```

Регистрируйте его на уровне свойства через `[JsonConverter(typeof(LooseBooleanConverter))]`, а не глобально, потому что большинство полей в добропорядочном API не должны быть гибкими, и изгибать каждый `bool` под три формы значит затушёвывать контракт.

## Исправление 4: пустые строки для значимых типов

Если производитель выдаёт `{ "shippedAt": "" }` для отсутствующей даты, `System.Text.Json` читает `JsonTokenType.String` и не может разобрать пустое содержимое как `DateTime`. Есть два чистых исправления. Первое - сделать C#-свойство допускающим null и написать конвертер, отображающий `""` в `null`:

```csharp
public sealed class NullableDateTimeConverter : JsonConverter<DateTime?>
{
    public override DateTime? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.Null) return null;
        if (reader.TokenType == JsonTokenType.String)
        {
            var s = reader.GetString();
            return string.IsNullOrEmpty(s) ? null : DateTime.Parse(s, System.Globalization.CultureInfo.InvariantCulture);
        }
        throw new JsonException();
    }

    public override void Write(Utf8JsonWriter writer, DateTime? value, JsonSerializerOptions options)
        => writer.WriteStringValue(value);
}
```

Второе - установить `JsonSerializerOptions.RespectNullableAnnotations = true` (по умолчанию в .NET 9+) и заставить производителя отправлять `null` вместо `""`. Исправление на стороне производителя предпочтительнее, когда вы контролируете обе стороны, потому что каждый частный случай `""`-как-null рано или поздно просочится в столбец, не допускающий null, или в NullReferenceException ниже по течению.

## Исправление 5: Guid в неверном формате

`System.Text.Json` использует `Guid.TryParseExact` с форматом `D` (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`). Представления в фигурных скобках (`{...}`), в круглых скобках (`(...)`) и без дефисов (`N`) - все выбрасывают. Самое короткое исправление - конвертер на уровне свойства:

```csharp
public sealed class FlexibleGuidConverter : JsonConverter<Guid>
{
    public override Guid Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        var s = reader.GetString();
        return Guid.Parse(s!);
    }

    public override void Write(Utf8JsonWriter writer, Guid value, JsonSerializerOptions options)
        => writer.WriteStringValue(value);
}
```

`Guid.Parse` принимает каждую стандартную форматную строку, так что этого достаточно.

## Исправление 6: полиморфные объекты с неизвестным дискриминатором

Когда вы объявляете базовый тип с `[JsonPolymorphic]` и `[JsonDerivedType]`, читатель проверяет свойство-дискриминатор и идёт к соответствующему подтипу. Если значение дискриминатора отсутствует или неизвестно, читатель выбрасывает "the JSON value could not be converted to BaseType". Два промышленных исправления:

- Установите `UnknownDerivedTypeHandling = JsonUnknownDerivedTypeHandling.FallBackToBaseType`, чтобы читатель материализовывал базовый тип, когда ни один производный тип не подходит.
- Установите `UnknownDerivedTypeHandling = JsonUnknownDerivedTypeHandling.FallBackToNearestAncestor`, если у вас иерархия классов глубже одного уровня и нужен ближайший зарегистрированный предок.

```csharp
// .NET 11 preview 4
[JsonPolymorphic(
    TypeDiscriminatorPropertyName = "$kind",
    UnknownDerivedTypeHandling = JsonUnknownDerivedTypeHandling.FallBackToBaseType)]
[JsonDerivedType(typeof(EmailEvent), "email")]
[JsonDerivedType(typeof(SmsEvent), "sms")]
public abstract record Event;

public record EmailEvent(string To, string Subject) : Event;
public record SmsEvent(string To, string Body) : Event;
```

Поведение по умолчанию (`JsonUnknownDerivedTypeHandling.FailSerialization`) корректно для закрытых схем, где каждый вариант известен. Используйте резервные варианты, когда принимаете события от производителя, добавляющего новые варианты без согласованного развёртывания.

## Исправление 7: NaN и Infinity для чисел с плавающей точкой

Если сериализатор на стороне производителя выдаёт `"NaN"`, `"Infinity"` или `"-Infinity"` для `double` / `float`, включите:

```csharp
var options = new JsonSerializerOptions
{
    NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals
};
```

Это симметрично: та же опция также позволяет вашему сериализатору выдавать эти литералы на пути записи. Без неё и чтение, и запись выбрасывают.

## Подводные камни и похожие случаи

- **Сообщение исключения называет базовый тип, а не конкретный.** Полиморфная десериализация сообщает о сбое относительно полиморфного корня, а не относительно типа, на который указывал дискриминатор. Прочитайте значение дискриминатора в исходном JSON, прежде чем считать, что виноват конвертер.
- **Контексты, сгенерированные исходным кодом, скрывают опции.** Если вы объявили `[JsonSerializable(typeof(Order))]` в `JsonSerializerContext`, список конвертеров в передаваемых вами `JsonSerializerOptions` времени выполнения **учитывается**, но сгенерированные метаданные также кодируют атрибуты `[JsonConverter]` на этапе компиляции. Смешивать оба варианта допустимо, но `[JsonConverter(...)]` на уровне свойства всегда побеждает зарегистрированный во время выполнения глобальный. См. [поддержку перехватчиков C# 14 для генерации исходного кода System.Text.Json](/ru/2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics/) для работы по эргономике в этой области.
- **Чувствительность к регистру независима от конвертера.** `PropertyNameCaseInsensitive = true` и политики именования, учитывающие регистр (`JsonNamingPolicy.CamelCase`, `JsonNamingPolicy.SnakeCaseLower`, атрибут [именования PascalCase для каждого члена в .NET 11](/ru/2026/04/system-text-json-11-pascalcase-per-member-naming/)), влияют на то, к какому свойству CLR привязывается читатель, а не на то, как он преобразует значение. Если ваша ошибка упоминает `Path: $.OrderStatus`, но в вашем JSON `"orderStatus"`, вы смотрите на промах привязки, а не на сбой преобразования.
- **У ветки DateTime свои соглашения.** Только ISO 8601, только разделитель `T`, без Unix-timestamp. Полная таблица принимаемых и отвергаемых форматов есть в [специальном исправлении для преобразования DateTime](/ru/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/).
- **Чтение числа, не помещающегося в тип.** JSON `9999999999` не читается в `int` и выбрасывает с тем же текстом исключения. Проверьте величину, прежде чем считать это проблемой формата.
- **Newtonsoft.Json молча приводил типы.** Самый частый путь к этому багу - миграция с `Newtonsoft.Json`, где старый код принимал `{ "amount": "12.50" }`, потому что Newtonsoft под капотом пытается строку-в-decimal. В `System.Text.Json` нет глобального переключателя "будь снисходительным". Либо устанавливайте `NumberHandling` и регистрируйте `JsonStringEnumConverter`, либо оставайтесь на Newtonsoft для этой границы.

## Связанное

- [Исправление: The JSON value could not be converted to System.DateTime](/ru/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) разбирает специфический для DateTime вариант, включая требование формата ISO 8601 и разбор Unix-timestamp.
- [Как написать пользовательский JsonConverter в System.Text.Json](/ru/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) показывает контракт конвертера, фабричные конвертеры и как перейти к конвертеру по умолчанию.
- [Именование PascalCase для каждого члена в System.Text.Json 11](/ru/2026/04/system-text-json-11-pascalcase-per-member-naming/) - подходящий инструмент, когда сбой связан с привязкой свойства, а не с преобразованием значения.
- [Перехватчики C# 14 для генерации исходного кода System.Text.Json](/ru/2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics/) объясняет, как сгенерированные исходным кодом конвертеры взаимодействуют с `JsonSerializerOptions` времени выполнения.
- [Исправление: InvalidOperationException: Synchronous operations are disallowed](/ru/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed/) не связано, но часто встречается вместе с ошибками преобразования JSON при миграции с буферизованного JSON на потоковый JSON в ASP.NET Core.

## Источники

- [Обзор System.Text.Json, .NET docs](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/overview)
- [Как сериализовать и десериализовать значения enum, MS Learn](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/customize-properties)
- [Справочник по `JsonNumberHandling`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonnumberhandling)
- [`JsonPolymorphicAttribute` и `JsonDerivedTypeAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonpolymorphicattribute)
- [`JsonStringEnumMemberNameAttribute`, .NET 9+](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonstringenummembernameattribute)
- [Исходный код `dotnet/runtime` для `EnumConverter<T>`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Text.Json/src/System/Text/Json/Serialization/Converters/Value/EnumConverter.cs)
