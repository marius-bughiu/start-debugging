---
title: "Как написать пользовательский JsonConverter в System.Text.Json"
description: "Полное руководство по написанию пользовательского JsonConverter<T> для System.Text.Json в .NET 11: когда он действительно нужен, как корректно работать с Utf8JsonReader, как обрабатывать обобщённые типы с помощью JsonConverterFactory и как оставаться совместимым с AOT."
pubDate: 2026-04-25
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "serialization"
lang: "ru"
translationOf: "2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json"
translatedBy: "claude"
translationDate: 2026-04-25
---

Чтобы написать пользовательский конвертер для `System.Text.Json`, унаследуйтесь от `JsonConverter<T>`, переопределите `Read` и `Write` и либо пометьте целевой тип атрибутом `[JsonConverter(typeof(MyConverter))]`, либо добавьте экземпляр в `JsonSerializerOptions.Converters`. Внутри `Read` нужно пройти по `Utf8JsonReader` ровно столько токенов, сколько занимает ваше значение, не больше и не меньше, иначе следующий вызов десериализатора увидит сломанный поток. Внутри `Write` вы вызываете методы `Utf8JsonWriter` напрямую и никогда не выделяете промежуточные строки, если этого можно избежать. Для обобщённых типов или полиморфизма используйте `JsonConverterFactory`, чтобы один класс мог производить конвертеры для множества закрытых обобщённых инстанциаций. Всё в этом руководстве рассчитано на .NET 11 (preview 3) и C# 14, но API стабилен с .NET Core 3.0, так что тот же код работает на каждой поддерживаемой среде выполнения.

## Когда JsonConverter -- правильный инструмент

Большинство команд берётся за пользовательский конвертер слишком рано. Прежде чем писать его, проверьте, можно ли решить вашу задачу встроенными возможностями, которые поставляются в .NET 11 (и более ранних версиях):

- Имена свойств не совпадают: используйте `JsonPropertyNameAttribute` или `JsonNamingPolicy`. В preview 3 добавлены `JsonNamingPolicy.PascalCase` и атрибут `[JsonNamingPolicy]` уровня члена, поэтому [политики именования в System.Text.Json 11](/ru/2026/04/system-text-json-11-pascalcase-per-member-naming/), скорее всего, покрывают то, что вам нужно.
- Числа в виде строк: `JsonNumberHandling.AllowReadingFromString` в `JsonSerializerOptions`.
- Перечисления в виде строк: `JsonStringEnumConverter` встроен. Существует даже [совместимый с trim вариант для Native AOT](/2023/09/net-8-how-to-use-jsonstringenumconverter-with-native-aot/).
- Свойства только для чтения или параметры конструктора: генератор исходного кода (`[JsonSerializable]` плюс `JsonSerializerContext`) обрабатывает записи и первичные конструкторы напрямую.
- Полиморфизм по дискриминатору: `[JsonDerivedType]` и `[JsonPolymorphic]` (добавлены в .NET 7) избавляют почти от всех старых трюков с конвертерами.

Пользовательский конвертер -- правильный инструмент, когда форма JSON и форма .NET по-настоящему расходятся. Примеры:

- Тип значения, который должен сериализоваться как примитив (`Money` становится `"42.00 USD"`).
- Тип, чья форма JSON зависит от контекста (иногда строка, иногда объект).
- Дерево, где одно и то же имя свойства несёт разные типы в зависимости от соседнего поля.
- Формат данных, которым вы не владеете (суммы в стиле Stripe в центах, длительности ISO 8601, правила повторения RFC 5545).

Если ничего из этого не подходит, используйте встроенные средства и пропустите эту статью.

## Контракт JsonConverter<T>

`System.Text.Json.Serialization.JsonConverter<T>` имеет два абстрактных метода, которые вы должны переопределить, и пару необязательных хуков:

```csharp
// .NET 11, C# 14
public abstract class JsonConverter<T> : JsonConverter
{
    public abstract T? Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options);

    public abstract void Write(
        Utf8JsonWriter writer,
        T value,
        JsonSerializerOptions options);

    // Optional: opt in to dictionary-key handling.
    public virtual T ReadAsPropertyName(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options) => throw new NotSupportedException();

    public virtual void WriteAsPropertyName(
        Utf8JsonWriter writer,
        T value,
        JsonSerializerOptions options) => throw new NotSupportedException();

    public virtual bool HandleNull => false;
}
```

В этой сигнатуре две вещи легко сделать неправильно:

1. `Read` получает `Utf8JsonReader` по `ref`. Читатель -- это изменяемая структура, владеющая курсором. Если вы передаёте его во вспомогательный метод, передавайте также по `ref`, иначе курсор вызывающего не продвинется и вы будете читать один и тот же токен бесконечно.
2. `HandleNull` по умолчанию равен `false`, что означает, что сериализатор вернёт `default(T)` для JSON `null` и никогда не вызовет ваш конвертер. Если вам нужно сопоставить `null` со значением, отличным от значения по умолчанию (или различать "отсутствует" и "null"), установите `HandleNull => true` и проверяйте `reader.TokenType == JsonTokenType.Null` самостоятельно.

Полный контракт описан на официальной странице MS Learn о [написании пользовательских конвертеров](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/converters-how-to). Остальная часть этого поста -- практическая версия.

## Рабочий пример: тип значения Money

Возьмём строго типизированное значение `Money`:

```csharp
// .NET 11, C# 14
public readonly record struct Money(decimal Amount, string Currency)
{
    public override string ToString() =>
        $"{Amount.ToString("0.00", CultureInfo.InvariantCulture)} {Currency}";
}
```

Поведение `System.Text.Json` по умолчанию сериализует его как `{"Amount":42.00,"Currency":"USD"}`. Вместо этого мы хотим один строковый токен: `"42.00 USD"`. Это именно то несоответствие формы, для которого нужен конвертер.

```csharp
// .NET 11, C# 14
using System.Buffers;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

public sealed class MoneyJsonConverter : JsonConverter<Money>
{
    public override Money Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options)
    {
        if (reader.TokenType != JsonTokenType.String)
            throw new JsonException(
                $"Expected string for Money, got {reader.TokenType}.");

        string raw = reader.GetString()!; // "42.00 USD"
        int space = raw.LastIndexOf(' ');
        if (space <= 0 || space == raw.Length - 1)
            throw new JsonException($"Invalid Money literal: '{raw}'.");

        decimal amount = decimal.Parse(
            raw.AsSpan(0, space),
            NumberStyles.Number,
            CultureInfo.InvariantCulture);
        string currency = raw[(space + 1)..];

        return new Money(amount, currency);
    }

    public override void Write(
        Utf8JsonWriter writer,
        Money value,
        JsonSerializerOptions options)
    {
        // Formats directly into the writer's UTF-8 buffer.
        Span<char> buffer = stackalloc char[64];
        if (!value.Amount.TryFormat(
                buffer, out int written,
                "0.00", CultureInfo.InvariantCulture))
        {
            writer.WriteStringValue(value.ToString());
            return;
        }

        // "<number> <currency>" without intermediate string allocation.
        Span<char> output = stackalloc char[written + 1 + value.Currency.Length];
        buffer[..written].CopyTo(output);
        output[written] = ' ';
        value.Currency.AsSpan().CopyTo(output[(written + 1)..]);
        writer.WriteStringValue(output);
    }
}
```

Несколько деталей, на которые стоит обратить внимание:

- `reader.GetString()` материализует управляемую `string`. Если вы десериализуете миллионы записей, а разобранное значение недолговечно, предпочтите `reader.ValueSpan` (UTF-8 байты) плюс `Utf8Parser`, чтобы избежать выделения памяти.
- `writer.WriteStringValue(ReadOnlySpan<char>)` кодирует в UTF-8 напрямую в пулированный буфер писателя. Промежуточной `string` нет. Эта перегрузка плюс `WriteStringValue(ReadOnlySpan<byte> utf8)` -- дешёвый путь.
- `JsonException` -- каноническое исключение "данные неверны". Сериализатор оборачивает его информацией о строке и позиции до того, как оно достигнет вызывающего, так что вам не нужно ничего добавлять.

## Корректное чтение: дисциплина курсора

Самая частая ошибка в пользовательских конвертерах -- не оставить читатель на правильном токене. Контракт такой:

> Когда `Read` возвращает управление, читатель должен быть позиционирован на **последнем токене, потреблённом вашим значением**, а не на следующем.

Сериализатор вызывает `reader.Read()` один раз между значениями. Если ваш конвертер потребляет слишком много токенов, следующее свойство молча пропускается. Если он потребляет слишком мало, следующий вызов десериализатора видит некорректный поток и выбрасывает исключение на токене, которого не ожидал.

Два правила покрывают почти каждый случай:

1. Для однотокенного значения (строка, число, логическое) ничего не делайте, кроме чтения из текущего токена. Курсор уже находится на правильном токене, когда вызывается `Read`.
2. Для объекта или массива зацикливайтесь, пока не увидите соответствующий токен `EndObject` или `EndArray`, и пусть финальный `reader.Read()` цикла оставит вас именно на этом закрывающем токене.

Вот канонический скелет для чтения объекта:

```csharp
// .NET 11, C# 14
public override Foo Read(
    ref Utf8JsonReader reader,
    Type typeToConvert,
    JsonSerializerOptions options)
{
    if (reader.TokenType != JsonTokenType.StartObject)
        throw new JsonException();

    var result = new Foo();

    while (reader.Read())
    {
        if (reader.TokenType == JsonTokenType.EndObject)
            return result;

        if (reader.TokenType != JsonTokenType.PropertyName)
            throw new JsonException();

        string property = reader.GetString()!;
        reader.Read(); // advance to the value token

        switch (property)
        {
            case "id":
                result.Id = reader.GetInt32();
                break;
            case "name":
                result.Name = reader.GetString();
                break;
            case "child":
                // Recurse through the serializer so nested converters and
                // contracts apply.
                result.Child = JsonSerializer.Deserialize<Child>(
                    ref reader, options);
                break;
            default:
                reader.Skip(); // unknown field, advance past its value
                break;
        }
    }

    throw new JsonException(); // unexpected end of stream
}
```

`reader.Skip()` -- недооценённый помощник: он проходит мимо всего, что вводит текущий токен, включая вложенный объект или массив, оставляя курсор на его закрывающем токене. Используйте его для всего, чего вы не понимаете, никогда не пишите собственный цикл пропуска.

## Эффективная запись: оставайтесь на писателе

`Utf8JsonWriter` пишет напрямую в пулированный буфер UTF-8, поэтому всё, что не требует управляемой `string`, должно оставаться вне кучи. Три правила:

1. Предпочитайте типизированные перегрузки: `WriteNumber`, `WriteBoolean`, `WriteString(ReadOnlySpan<char>)`. Они форматируют прямо в буфер.
2. Для пар свойство+значение внутри объекта используйте `WriteString("name", value)` и подобные. Они выдают имя свойства и значение за один вызов без выделения памяти.
3. Если вам нужно построить строку, используйте `string.Create` или выделенный на стеке `Span<char>` вместо `string.Format` или интерполяции, которые обе выделяют память.

Для приведённого выше примера `Money` ещё более дешёвая версия использует UTF-8 напрямую:

```csharp
// .NET 11, C# 14, micro-optimized hot path
public override void Write(
    Utf8JsonWriter writer,
    Money value,
    JsonSerializerOptions options)
{
    Span<byte> buffer = stackalloc byte[64];
    if (!value.Amount.TryFormat(
            buffer, out int written,
            "0.00", CultureInfo.InvariantCulture))
    {
        writer.WriteStringValue(value.ToString());
        return;
    }

    int currencyLen = Encoding.UTF8.GetByteCount(value.Currency);
    Span<byte> output = stackalloc byte[written + 1 + currencyLen];
    buffer[..written].CopyTo(output);
    output[written] = (byte)' ';
    Encoding.UTF8.GetBytes(value.Currency, output[(written + 1)..]);
    writer.WriteStringValue(output);
}
```

Эта версия никогда не производит управляемую строку для отформатированного значения. Для сервиса, сериализующего десятки тысяч экземпляров `Money` в секунду, это измеримая разница в темпе выделения памяти.

## Обобщённые типы и JsonConverterFactory

`JsonConverter<T>` -- закрытый тип. Если вам нужен конвертер для `Result<TValue, TError>`, который работает для каждого закрытого обобщённого, вы пишете `JsonConverterFactory`, который производит закрытые конвертеры по требованию:

```csharp
// .NET 11, C# 14
public sealed class ResultJsonConverterFactory : JsonConverterFactory
{
    public override bool CanConvert(Type typeToConvert) =>
        typeToConvert.IsGenericType
        && typeToConvert.GetGenericTypeDefinition() == typeof(Result<,>);

    public override JsonConverter CreateConverter(
        Type typeToConvert,
        JsonSerializerOptions options)
    {
        Type[] args = typeToConvert.GetGenericArguments();
        Type closed = typeof(ResultConverter<,>).MakeGenericType(args);
        return (JsonConverter)Activator.CreateInstance(closed)!;
    }

    private sealed class ResultConverter<TValue, TError>
        : JsonConverter<Result<TValue, TError>>
    {
        public override Result<TValue, TError> Read(
            ref Utf8JsonReader reader,
            Type typeToConvert,
            JsonSerializerOptions options) =>
            throw new NotImplementedException(); // exercise for the reader

        public override void Write(
            Utf8JsonWriter writer,
            Result<TValue, TError> value,
            JsonSerializerOptions options) =>
            throw new NotImplementedException();
    }
}
```

Фабрика регистрируется так же, как обычный конвертер (атрибут или `Options.Converters.Add`). Сериализатор кеширует закрытый конвертер для каждого закрытого обобщённого, так что `CreateConverter` выполняется один раз на пару `(TValue, TError)` на экземпляр `JsonSerializerOptions`.

`Activator.CreateInstance` плюс `MakeGenericType` -- это рефлексия, враждебная Native AOT и trim. Если вы нацеливаетесь на AOT, см. раздел про AOT ниже.

## Регистрация конвертера

Два способа, и у них разный приоритет:

```csharp
// .NET 11, C# 14
[JsonConverter(typeof(MoneyJsonConverter))]
public readonly record struct Money(decimal Amount, string Currency);
```

Атрибут привязывает конвертер к типу и учитывается каждым вызовом `JsonSerializer` без настройки на уровне опций. Используйте его для типов значений, которыми вы владеете.

```csharp
// .NET 11, C# 14
var options = new JsonSerializerOptions
{
    Converters = { new MoneyJsonConverter() }
};

string json = JsonSerializer.Serialize(invoice, options);
```

Регистрация на уровне опций -- правильный ответ, когда вы не владеете целевым типом, когда конвертер специфичен для среды (тест против прода) или когда одному типу нужны разные формы в разных контекстах (публичный API против внутреннего журнала).

Порядок поиска, от наивысшего к наинизшему приоритету:

1. Конвертер, переданный напрямую в вызов `JsonSerializer`.
2. `[JsonConverter]` на свойстве.
3. `Options.Converters` (для совпадающих типов выигрывает добавленный последним).
4. `[JsonConverter]` на типе.
5. Встроенное значение по умолчанию для этого типа.

Если два конвертера претендуют на один и тот же тип через разные механизмы, выигрывает тот, что выше в этом списке. Прикиньте это в голове, прежде чем отлаживать "почему мой конвертер не запускается": почти всегда атрибут на свойстве или запись в опциях переопределяет атрибут на типе.

## Генерация исходного кода и Native AOT

`JsonConverter<T>` работает с генератором исходного кода: объявите тип в своём `JsonSerializerContext`, и генератор выпустит провайдер метаданных, который делегирует вашему конвертеру там, где это уместно. То же самое **не** автоматически верно для `JsonConverterFactory`. Всё, что фабрика делает с `MakeGenericType` или `Activator.CreateInstance`, -- это рефлексия, которую trim и AOT не могут увидеть статически.

Для совместимых с AOT фабрик сделайте одно из:

- Ограничьте фабрику известным конечным набором закрытых обобщённых и инстанциируйте их напрямую с `new ResultConverter<MyValue, MyError>()` для каждой пары.
- Пометьте фабрику атрибутами `[RequiresDynamicCode]` и `[RequiresUnreferencedCode]`, примите предупреждения trim и задокументируйте, что потребители AOT должны регистрировать закрытый конвертер вручную.

Шаблон использования интерсепторов, чтобы вызовы `JsonSerializer.Serialize` автоматически подбирали сгенерированный контекст, обсуждаемый в [предложении интерсепторов C# 14 для сгенерированного исходным кодом JSON](/2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics/), независим от конвертеров: даже с ним вы всё равно пишете свой пользовательский `JsonConverter<T>` тем же способом.

## Подводные камни, в порядке частоты возникновения

- **Забыли продвинуть читатель за `EndObject`/`EndArray`.** Симптом: следующее свойство в родительском объекте молча пропускается или парсер выбрасывает запутанную ошибку двумя слоями выше. Проверяйте, написав тест конвертера, который десериализует `{ "wrapped": <yourThing>, "next": 1 }` и проверяет, что `next` прочитан.
- **Вызов `JsonSerializer.Deserialize<T>(ref reader, options)` для того же `T`, который обрабатывает ваш конвертер.** Это бесконечная рекурсия. Рекурсия через сериализатор -- для *других* типов (детей, вложенных значений).
- **Удержание `Utf8JsonReader` через `await`.** Читатель -- это `ref struct`, компилятор вам не позволит, но у вас может возникнуть искушение скопировать значения в локальные переменные и переподключить позже. Не делайте этого. Читайте всё значение синхронно внутри `Read`. Если ваш источник данных асинхронный, сначала буферизуйте в `ReadOnlySequence<byte>` и передайте это читателю.
- **Выбрасывание чего-либо кроме `JsonException` для некорректных данных.** Другие исключения пересекают границу сериализатора без обёртки и теряют контекст строки/позиции.
- **Изменение `JsonSerializerOptions` после первого вызова сериализации.** Сериализатор кеширует разрешённые конвертеры на экземпляр опций; последующие изменения выбрасывают `InvalidOperationException`. Постройте свежий экземпляр опций или явно вызовите `MakeReadOnly()`, когда закончите конфигурацию.
- **Использование `JsonConverterAttribute` на интерфейсе или абстрактном типе с ожиданием полиморфизма бесплатно.** Это не работает таким образом. Используйте `[JsonPolymorphic]` и `[JsonDerivedType]` для сериализации иерархии или напишите пользовательский конвертер, который сам выполняет диспетчеризацию по дискриминатору.
- **Выделение памяти в `Write`.** Легко написать `JsonSerializer.Serialize(value)` рекурсивно и забыть, что он производит `string`, которую вы затем записываете обратно в писатель. Используйте перегрузку `Serialize` с `ref Utf8JsonWriter`.

Если вы держите это в уме, конвертер редко занимает более 30 строк кода и работает в том же бюджете выделения памяти, что и встроенный сериализатор.

## Похожее

- [Как использовать Channels вместо BlockingCollection в C#](/ru/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) -- паттерны "async-first", та же эпоха проектирования API.
- [System.Text.Json в .NET 11 Preview 3 добавляет PascalCase и именование по членам](/ru/2026/04/system-text-json-11-pascalcase-per-member-naming/) -- когда политики именования достаточно, а конвертера -- нет.
- [Как использовать JsonStringEnumConverter с Native AOT](/2023/09/net-8-how-to-use-jsonstringenumconverter-with-native-aot/) -- история trim/AOT для встроенных конвертеров.
- [Интерсепторы для генерации исходного кода System.Text.Json](/2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics/) -- параллельное направление эргономики, за которым стоит следить.
- [Как вернуть несколько значений из метода в C# 14](/ru/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/) -- паттерны кортежей значений и записей, которым часто нужен конвертер.

## Источники

- MS Learn: [Write custom converters for JSON serialization](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/converters-how-to)
- MS Learn: [How to use the source generator in System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation)
- Справочник API: [`Utf8JsonReader`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.utf8jsonreader), [`Utf8JsonWriter`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.utf8jsonwriter)
- Трекер задач dotnet/runtime для области System.Text.Json: [area-System.Text.Json](https://github.com/dotnet/runtime/labels/area-System.Text.Json)
