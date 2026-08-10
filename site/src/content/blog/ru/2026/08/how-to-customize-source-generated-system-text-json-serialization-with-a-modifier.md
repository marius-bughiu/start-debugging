---
title: "Как настроить сериализацию System.Text.Json, сгенерированную генератором исходного кода, с помощью модификатора type info resolver"
description: "Как подключить модификатор JsonTypeInfo к сгенерированному JsonSerializerContext в .NET 11: почему new MyContext(options) молча его отбрасывает, рабочая схема с WithAddedModifier, быстрый путь, который вы теряете (с измерениями), и ловушка политики именования, из-за которой модификатор ничего не делает."
pubDate: 2026-08-10
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "source-generators"
  - "serialization"
  - "how-to"
lang: "ru"
translationOf: "2026/08/how-to-customize-source-generated-system-text-json-serialization-with-a-modifier"
translatedBy: "claude"
translationDate: 2026-08-10
---

Чтобы настроить сгенерированный контракт `System.Text.Json`, модификатор нужно назначать на `JsonSerializerOptions`, а не на контекст: `new JsonSerializerOptions { TypeInfoResolver = MyContext.Default.WithAddedModifier(MyModifier) }`. Очевидный на вид вариант `new MyContext(optionsWithModifier)` компилируется, выполняется и молча игнорирует модификатор, потому что конструктор `JsonSerializerContext` перезаписывает `TypeInfoResolver` самим контекстом. Модификаторы прекрасно работают с генерацией исходного кода, в том числе при отключённой сериализации через рефлексию для Native AOT, но они стоят вам сгенерированного быстрого пути. Всё описанное ниже проверено на .NET 10.0.5 с SDK 10.0.201; API не менялись с .NET 8 по .NET 11.

## Почему настройка контрактов и генерация исходного кода кажутся несовместимыми

Настройка контрактов появилась в .NET 7. Вы передаёте `System.Text.Json` делегат `Action<JsonTypeInfo>`, и он вызывается один раз для каждого типа: после того, как контракт построен, но до того, как он использован. Так можно переименовывать свойства, удалять их, добавлять синтетические или оборачивать делегаты чтения и записи. Канонической точкой входа является `DefaultJsonTypeInfoResolver.Modifiers`, а в .NET 8 добавили [метод расширения `WithAddedModifier`](/2023/10/system-text-json-how-to-modify-existing-type-info-resolver/), позволяющий наложить модификатор на любой `IJsonTypeInfoResolver`, а не только на основанный на рефлексии.

Именно слова "любой resolver" здесь и важны, потому что сгенерированный `JsonSerializerContext` **является** `IJsonTypeInfoResolver`. Никаких технических причин, по которым модификатор не мог бы декорировать `MyContext.Default`, не существует. Вывод о том, что модификаторы контрактов не работают с генерацией исходного кода, так распространён потому, что естественно выглядящий способ подключения выбрасывает модификатор без предупреждения, без исключения и без диагностики компилятора.

Вот модель, которая используется дальше по тексту. Класс `Order` с секретом внутри и вложенный `Address` с той же проблемой:

```csharp
// .NET 11, C# 14
public class Order
{
    public int Id { get; set; }
    public string Customer { get; set; } = "";
    public string? ApiKey { get; set; }
    public Address? ShipTo { get; set; }
}

public class Address
{
    public string City { get; set; } = "";
    public string? ApiKey { get; set; }
}

[JsonSerializable(typeof(Order))]
public partial class OrderContext : JsonSerializerContext { }
```

И модификатор, который маскирует каждое свойство с именем `ApiKey` в любом месте графа объектов:

```csharp
// .NET 11, C# 14
static void RedactApiKey(JsonTypeInfo typeInfo)
{
    if (typeInfo.Kind != JsonTypeInfoKind.Object)
        return;

    foreach (JsonPropertyInfo property in typeInfo.Properties)
    {
        if (property.Name != "ApiKey")
            continue;

        Func<object, object?>? get = property.Get;
        if (get is not null)
            property.Get = obj => get(obj) is null ? null : "***";
    }
}
```

## Схема, которая работает, и схема, которая молча не делает ничего

Три шага, и порядок здесь важен:

1. Сначала соберите resolver, вызвав `WithAddedModifier` на свойстве `Default` сгенерированного контекста. Возвращается `JsonTypeInfoResolverWithAddedModifiers`, который делегирует контексту, а затем выполняет ваш callback.
2. Назначьте этот resolver в `JsonSerializerOptions.TypeInfoResolver` и сохраните экземпляр options в поле `static readonly`. Никогда не создавайте `JsonSerializerContext` самостоятельно.
3. Передавайте этот экземпляр options в `JsonSerializer.Serialize` или `JsonSerializer.Deserialize`. Не передавайте контекст и не передавайте `JsonTypeInfo`, взятый из `MyContext.Default`.

```csharp
// .NET 11, C# 14 - works
static readonly JsonSerializerOptions RedactingOptions = new()
{
    TypeInfoResolver = OrderContext.Default.WithAddedModifier(RedactApiKey)
};

var order = new Order
{
    Id = 7,
    Customer = "acme",
    ApiKey = "sk-live-123",
    ShipTo = new Address { City = "Cluj", ApiKey = "sk-nested-999" }
};

Console.WriteLine(JsonSerializer.Serialize(order, typeof(Order), RedactingOptions));
// {"Id":7,"Customer":"acme","ApiKey":"***","ShipTo":{"City":"Cluj","ApiKey":"***"}}
```

Обратите внимание, что вложенный `Address` тоже маскируется, хотя он ни разу не указан в атрибуте `[JsonSerializable]`. Генератор обходит граф объектов от каждого объявленного корня, поэтому `OrderContext.Default.GetTypeInfo(typeof(Address))` возвращает контракт, и модификатор отрабатывает для него, как для любого другого типа.

Теперь вариант, который выглядит столь же разумным и не делает ничего:

```csharp
// .NET 11, C# 14 - modifier is silently discarded
var context = new OrderContext(new JsonSerializerOptions
{
    TypeInfoResolver = OrderContext.Default.WithAddedModifier(RedactApiKey)
});

Console.WriteLine(JsonSerializer.Serialize(order, typeof(Order), context));
// {"Id":7,"Customer":"acme","ApiKey":"sk-live-123","ShipTo":{...,"ApiKey":"sk-nested-999"}}

Console.WriteLine(context.Options.TypeInfoResolver?.GetType().Name);
// OrderContext
```

Конструктор `JsonSerializerContext(JsonSerializerOptions)` копирует ваши options, а затем присваивает самого себя в `TypeInfoResolver`, поэтому аккуратно собранный декорированный resolver исчезает ещё до первой сериализации. Рекомендация сопровождающих `System.Text.Json` в [обсуждении 121304 в dotnet/runtime](https://github.com/dotnet/runtime/discussions/121304) именно такая: избегайте экземпляров `JsonSerializerContext` и передавайте options напрямую в `JsonSerializer`.

Ещё два способа потерять модификатор, оба легко написать по невнимательности:

```csharp
// .NET 11, C# 14 - both bypass the modifier
JsonSerializer.Serialize(order, OrderContext.Default.Order);
JsonSerializer.Serialize(order, typeof(Order), OrderContext.Default);
```

`OrderContext.Default` содержит немодифицированный контракт. Это возможность, а не ошибка: модификаторы никогда не изменяют общий экземпляр `Default`, поэтому маскирующий resolver из одной части приложения не может протечь в другую. Если для горячего пути нужна перегрузка с `JsonTypeInfo`, возьмите type info из модифицированных options:

```csharp
// .NET 11, C# 14
var typeInfo = (JsonTypeInfo<Order>)RedactingOptions.GetTypeInfo(typeof(Order));
JsonSerializer.Serialize(order, typeInfo);   // redacted
```

## Сравнение по Name это ловушка, которая срабатывает в ASP.NET Core

`JsonPropertyInfo.Name` содержит имя в **JSON**, уже после применения `PropertyNamingPolicy`. В обычном консольном приложении с настройками по умолчанию политика именования равна null, поэтому `property.Name` случайно совпадает с именем свойства CLR и проверка `== "ApiKey"` срабатывает. Подключите тот же модификатор в ASP.NET Core, где политика по умолчанию camelCase, и проверка не найдёт ничего:

```csharp
// .NET 11, ASP.NET Core 11
builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.TypeInfoResolver = AppJsonContext.Default.WithAddedModifier(RedactApiKey);
});
```

С условием `property.Name != "ApiKey"` эндпоинт спокойно возвращает `{"id":7,"customer":"acme","apiKey":"sk-live-1"}`. Модификатор отработал, просто ни разу не совпал, потому что контракт уже сообщал имя свойства как `apiKey`.

Сравнивайте вместо этого с членом CLR. `JsonPropertyInfo.AttributeProvider` является `PropertyInfo` даже в сгенерированных контрактах, поэтому доступны и имя члена, и любые пользовательские атрибуты:

```csharp
// .NET 11, C# 14
[AttributeUsage(AttributeTargets.Property)]
public sealed class RedactAttribute : Attribute { }

static void RedactByAttribute(JsonTypeInfo typeInfo)
{
    if (typeInfo.Kind != JsonTypeInfoKind.Object)
        return;

    foreach (JsonPropertyInfo property in typeInfo.Properties)
    {
        object[]? attributes = property.AttributeProvider
            ?.GetCustomAttributes(typeof(RedactAttribute), inherit: true);

        if (attributes is not { Length: > 0 })
            continue;

        Func<object, object?>? get = property.Get;
        if (get is not null)
            property.Get = obj => get(obj) is null ? null : "***";
    }
}
```

Такой вариант переживает любую политику именования и в моём тесте выдал `{"id":7,"customer":"acme","apiKey":"***"}` с того же эндпоинта minimal API.

## Что на самом деле можно менять в сгенерированном контракте

Всё, что [документация по пользовательским контрактам](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/custom-contracts) описывает для resolver на рефлексии, работает и поверх сгенерированного. Каждый из этих случаев я проверил на `OrderContext.Default`:

- **Удаление свойства.** `typeInfo.Properties.RemoveAt(i)` убирает его и из сериализации, и из десериализации. Вывод становится `{"Id":7,"Customer":"acme","ShipTo":{"City":"Cluj"}}`.
- **Добавление синтетического свойства.** `typeInfo.CreateJsonPropertyInfo(typeof(string), "kind")` плюс делегат `Get`, затем `typeInfo.Properties.Add(...)` добавляет `"kind":"order"` в полезную нагрузку. Соответствующего члена CLR существовать не обязано.
- **Обёртка setter.** Переназначенный `property.Set` выполняется при десериализации. Перевод `Customer` в верхний регистр через обёрнутый setter превратил `{"Customer":"acme"}` в `Customer == "ACME"`.
- **Условная запись.** `property.ShouldSerialize = (_, value) => !string.IsNullOrEmpty((string?)value)` подавил пустую строку `Customer`, не затронув остальной контракт.
- **Обработка чисел по типу.** `typeInfo.NumberHandling` это единственный переключатель, применимый к контрактам `JsonTypeInfoKind.None`, таким как `int`.

Модификаторы применяются в том порядке, в котором вы их добавляете. При двух вызовах `WithAddedModifier` подряд, где первый переводит все имена в нижний регистр, а второй вставляет свойство `"v"` в позицию 0, получилось `{"v":"2","id":7,"customer":"acme",...}`: проход с нижним регистром выполнился первым, поэтому вставленное позже свойство сохранило свой регистр.

## Native AOT: ломаются не модификаторы

Весь смысл использовать здесь [генератор исходного кода](/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) в trimming и Native AOT, поэтому очевидное опасение состоит в том, не тянет ли подключённый модификатор рефлексию обратно. Не тянет. Я повторил тот же код с `<JsonSerializerIsReflectionEnabledByDefault>false</JsonSerializerIsReflectionEnabledByDefault>`, а именно это значение устанавливают за вас `PublishAot` и `PublishTrimmed`:

```text
IsReflectionEnabledByDefault = False
attribute-driven modifier over source-gen: {"Id":7,"Customer":"acme","ApiKey":"***","ShipTo":{"City":"Cluj","ApiKey":"***"}}
synthetic property with reflection off:    {"Id":7,...,"kind":"order"}
```

Сработали и поиск атрибута через `AttributeProvider`, и созданное во время выполнения свойство. В такой конфигурации по-прежнему ломается обычное правило генерации исходного кода: любой корневой тип, отсутствующий в контексте, приводит к исключению, и модификатор здесь ни при чём:

```text
NotSupportedException: JsonTypeInfo metadata for type '<>f__AnonymousType0`1[System.Int32]'
was not provided by TypeInfoResolver of type
'System.Text.Json.Serialization.Metadata.JsonTypeInfoResolverWithAddedModifiers'.
```

Если вы столкнулись с родственной ошибкой про [отключённую сериализацию на основе рефлексии](/2026/07/fix-reflection-based-serialization-has-been-disabled-for-this-application/), это отсутствующий resolver, а не сломанный модификатор.

## Реальная цена: вы отказываетесь от сгенерированного быстрого пути

У генерации исходного кода два режима. Режим метаданных переносит построение контракта на время компиляции. Режим оптимизации сериализации дополнительно порождает написанный вручную writer, который напрямую вызывает `Utf8JsonWriter`. Согласно [документации по режимам генерации исходного кода](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation-modes), сериализатор уходит с быстрого пути всякий раз, когда options требуют того, что сгенерированный writer выразить не может, и модифицированный контракт является именно таким случаем.

Измерено с BenchmarkDotNet 0.15.8 на .NET 10.0.5 (Intel Core Ultra 7 265KF, 20 ядер), сериализация приведённого выше `Order` с четырьмя свойствами:

| Метод | Среднее | Ratio | Выделено | Alloc Ratio |
| --- | ---: | ---: | ---: | ---: |
| Source-gen, без модификатора | 88.76 ns | 1.00 | 200 B | 1.00 |
| Source-gen + модификатор | 136.83 ns | 1.54 | 496 B | 2.48 |
| Resolver на рефлексии, без модификатора | 136.23 ns | 1.53 | 512 B | 2.56 |
| Resolver на рефлексии + модификатор | 138.97 ns | 1.57 | 496 B | 2.48 |

Добавление модификатора стоит примерно 54% пропускной способности и в 2.5 раза больше выделений памяти на такой полезной нагрузке, приводя генерацию исходного кода ровно туда, где уже находился resolver на рефлексии. Выигрыш во времени запуска и в trimming сохраняется, потому что построение контракта всё ещё происходит на этапе компиляции; теряется только оптимизированный writer. Для большинства API это приемлемый размен, но об этом стоит знать заранее, прежде чем подключать модификатор к горячему пути сериализации и удивляться, почему цифры не изменились.

## GenerationMode = Serialization превращает модификатор в молчаливый no-op

Это тот сценарий отказа, который сильнее всего похож на "модификаторы не работают с генерацией исходного кода". Если зафиксировать контекст в режиме генерации только быстрого пути, метаданных свойств, по которым модификатор мог бы пройти, просто нет:

```csharp
// .NET 11, C# 14 - do not do this if you want a modifier
[JsonSourceGenerationOptions(GenerationMode = JsonSourceGenerationMode.Serialization)]
[JsonSerializable(typeof(Order))]
public partial class FastPathOnlyContext : JsonSerializerContext { }
```

Я вывел форму контракта для всех трёх режимов генерации:

```text
Default mode         Kind=Object Properties=4
Serialization only   Kind=Object Properties=0
Metadata only        Kind=Object Properties=4
```

При `Properties=0` модификатор вызывается один раз, не итерирует ничего и завершается. Сериализация проходит успешно с исходной, немаскированной полезной нагрузкой. Десериализация не проходит, и сообщение хотя бы недвусмысленное:

```text
InvalidOperationException: TypeInfoResolver
'System.Text.Json.Serialization.Metadata.JsonTypeInfoResolverWithAddedModifiers'
did not provide property metadata for type 'Order'.
```

Режим генерации по умолчанию выдаёт и метаданные, и быстрый путь, и это именно то, что нужно: быстрый путь используется, когда модификатор не подключён, а путь через метаданные берёт своё, когда он есть.

## Кешируйте options и не изменяйте их после первого использования

Контракты кешируются на экземпляр `JsonSerializerOptions`, а не глобально. Три сериализации через один закешированный объект options вызвали мой модификатор 4 раза суммарно, по одному на каждый тип в графе. Создание новых `JsonSerializerOptions` внутри цикла вызвало его 12 раз и заново построило все контракты:

```text
modifierCalls after 3 serializations (cached options)  = 4
modifierCalls after 3 serializations (fresh options)   = 12
```

После того как экземпляр options был использован, и он сам, и порождённые им контракты замораживаются. Присваивание `WriteIndented` после первой сериализации бросает `InvalidOperationException: This JsonSerializerOptions instance is read-only or has already been used in serialization or deserialization`, а попытка через `options.GetTypeInfo(...)` отредактировать `Properties` задним числом бросает аналог для `JsonTypeInfo`. Все изменения контракта должны происходить внутри модификатора.

Если нужно наложить несколько resolver вместо одного декорированного контекста, [`TypeInfoResolverChain`](/2023/10/add-remove-typeinforesolver-to-existing-jsonserializeroptions/) принимает декорированный resolver так же, как и обычный, и цепочка опрашивается по порядку, пока контракт не вернётся отличным от null. Тот же приём подходит для иерархии, которая уже использует [`JsonDerivedType` для полиморфизма](/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/), поскольку производные контракты проходят через модификатор как любой другой тип.

Короткая версия, которую стоит держать в голове: декорируйте resolver, а не контекст, сравнивайте через `AttributeProvider`, а не через `Name`, оставляйте режим генерации по умолчанию и кешируйте options.

## Источники

- [Пользовательские контракты сериализации и десериализации](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/custom-contracts) на MS Learn
- [Режимы генерации исходного кода в System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation-modes) на MS Learn
- [Обсуждение 121304 в dotnet/runtime: модификаторы контрактов JSON и генерация исходного кода](https://github.com/dotnet/runtime/discussions/121304)
- [Справочник API `JsonTypeInfoResolver.WithAddedModifier`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.metadata.jsontypeinforesolver.withaddedmodifier), доступен с .NET 8 по .NET 11
