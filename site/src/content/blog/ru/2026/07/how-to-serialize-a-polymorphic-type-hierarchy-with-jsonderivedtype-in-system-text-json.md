---
title: "Как сериализовать полиморфную иерархию типов с JsonDerivedType в System.Text.Json"
description: "Полное руководство по полиморфному JSON в .NET 11: JsonDerivedType и JsonPolymorphic, почему всё решает объявленный тип, правило порядка $type, все исключения этой возможности, модель контрактов для чужих типов и то, что ASP.NET Core выдаёт в OpenAPI."
pubDate: 2026-07-27
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "serialization"
lang: "ru"
translationOf: "2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json"
translatedBy: "claude"
translationDate: 2026-07-27
---

Чтобы иерархия классов проходила полный цикл через `System.Text.Json`, поставьте на базовый тип атрибут `[JsonDerivedType(typeof(Derived), "discriminator")]` для каждого поддерживаемого подтипа, а затем сериализуйте и десериализуйте через **базовый** тип. Сериализатор пишет свойство `$type` первым членом объекта и читает его обратно, чтобы выбрать нужный подтип. Без строки-дискриминатора сериализация всё ещё выводит свойства производного типа, но десериализация всегда создаёт базовый тип. Так это работает начиная с .NET 7, и всё описанное ниже ориентировано на .NET 11 (`net11.0`, C# 14), с указанием двух более поздних дополнений там, где они важны: `AllowOutOfOrderMetadataProperties` (.NET 9) и `JsonSerializerOptions.Strict` (.NET 10).

## Почему наивный вариант молча теряет данные

Причина, по которой эту возможность вообще ищут, в том, что очевидный код тихо делает не то. Возьмём иерархию платежей:

```csharp
// .NET 11, C# 14
public abstract class PaymentMethod
{
    public decimal Amount { get; set; }
}

public class CardPayment : PaymentMethod
{
    public string Last4 { get; set; } = "";
}
```

Сериализуйте `CardPayment` через переменную, объявленную как `PaymentMethod`, вообще без атрибутов, и вы получите `{"Amount":10}`. Свойство `Last4` исчезает. `System.Text.Json` строит контракт по **объявленному** типу, а не по типу времени выполнения, поэтому знает только о членах `PaymentMethod`. Это сделано намеренно: так производный тип не может выдать наружу свойства, раскрывать которые вызывающая сторона не соглашалась, а для ответов API это реальный вопрос безопасности.

Один атрибут меняет контракт:

```csharp
// .NET 11, C# 14
[JsonDerivedType(typeof(CardPayment))]
public abstract class PaymentMethod
{
    public decimal Amount { get; set; }
}
```

Теперь `JsonSerializer.Serialize<PaymentMethod>(card)` даёт `{"Last4":"4242","Amount":10}`. Сериализация исправлена, десериализация нет. Чтение той же полезной нагрузки обратно как `PaymentMethod` бросает `NotSupportedException: Deserialization of interface or abstract types is not supported. Type 'PaymentMethod'.`, потому что в JSON нет ничего, что указывало бы, какой подтип создавать. Если базовый тип конкретный, а не абстрактный, отказ тише и хуже: вы получаете экземпляр `PaymentMethod`, а `Last4` теряется. Дискриминатор и замыкает этот круг.

## Пять шагов к иерархии с полным циклом

1. **Сделайте базовый тип пригодным для полиморфизма.** Это должен быть незапечатанный класс, абстрактный класс или интерфейс. Структуры, запечатанные типы, обобщённые типы и `System.Object` отклоняются с `InvalidOperationException: Specified type 'X' does not support polymorphism. Polymorphic types cannot be structs, sealed types, generic types or System.Object.`

2. **Объявите каждый подтип с дискриминатором.** Второй аргумент `[JsonDerivedType]` и есть значение дискриминатора, именно оно заставляет десериализацию работать.

```csharp
// .NET 11, C# 14
using System.Text.Json.Serialization;

[JsonDerivedType(typeof(CardPayment), "card")]
[JsonDerivedType(typeof(PaypalPayment), "paypal")]
public abstract class PaymentMethod
{
    public decimal Amount { get; set; }
}

public class CardPayment : PaymentMethod
{
    public string Last4 { get; set; } = "";
}

public class PaypalPayment : PaymentMethod
{
    public string Email { get; set; } = "";
}
```

3. **Сериализуйте через базовый тип.** Объявленный тип в точке вызова должен быть полиморфной базой: как обобщённый аргумент, как тип свойства или как тип элемента коллекции.

```csharp
// .NET 11, C# 14
PaymentMethod payment = new CardPayment { Amount = 10, Last4 = "4242" };

string json = JsonSerializer.Serialize(payment);
// {"$type":"card","Last4":"4242","Amount":10}
```

Обратите внимание на порядок. `$type` всегда пишется первым, раньше собственных свойств производного типа, а свойства базового типа идут последними. Это не косметика, как объясняет следующий раздел.

4. **Десериализуйте через базовый тип.** Читатель смотрит на `$type`, находит `CardPayment` и создаёт его:

```csharp
// .NET 11, C# 14
PaymentMethod? back = JsonSerializer.Deserialize<PaymentMethod>(json);
Console.WriteLine(back is CardPayment); // True
```

5. **Переименуйте дискриминатор, если `$type` конфликтует с вашим форматом обмена.** `[JsonPolymorphic(TypeDiscriminatorPropertyName = "kind")]` на базовом типе меняет имя свойства. Две детали: `$id`, `$ref` и `$values` зарезервированы и отклоняются, а собственное имя **не** проходит через политику именования. При `JsonSerializerOptions.Web` дискриминатор, объявленный как `"Kind"`, остаётся `"Kind"`, тогда как все прочие свойства переводятся в camelCase. Выбирайте ровно тот регистр, который нужен в протоколе обмена.

Значения дискриминатора могут быть и целыми числами: `[JsonDerivedType(typeof(ClickEvent), 1)]` выдаёт `{"$type":1,...}`. Смешивать идентификаторы `string` и `int` в одной иерархии допустимо, код компилируется и работает, но полезную нагрузку становится сложнее потреблять из клиентов вне .NET. Выберите одну форму.

## Объявленный тип решает всё и везде

Большинство сообщений про «дискриминатор пропал» сводится к точке вызова, где объявленный тип является производным классом. Правило механическое, и его стоит запомнить в виде таблицы. Всё это выполнено на той же иерархии, что выше:

| Точка вызова | Вывод |
| --- | --- |
| `Serialize<PaymentMethod>(card)` | `{"$type":"card","Last4":"4242","Amount":10}` |
| `Serialize<CardPayment>(card)` | `{"Last4":"4242","Amount":10}` |
| `Serialize(card)`, где `card` имеет тип `CardPayment` | `{"Last4":"4242","Amount":10}` |
| `Serialize<object>(card)` | `{"$type":"card","Last4":"4242","Amount":10}` |
| Элемент `List<PaymentMethod>` | `[{"$type":"card",...}]` |
| Свойство, объявленное как `PaymentMethod` | `{"Method":{"$type":"card",...}}` |
| Свойство, объявленное как `CardPayment` | `{"Concrete":{"Last4":"9","Amount":3}}` |

Строка с `object` многих удивляет. Сам `System.Object` полиморфной базой быть не может, но когда объявленный тип это `object`, сериализатор определяет тип времени выполнения и затем применяет полиморфную конфигурацию ближайшего настроенного предка этого типа. Поэтому `Serialize<object>(card)` дискриминатор всё же выводит, а `Serialize<object>(someUndeclaredSubtype)` бросает исключение ровно так же, как вызов через базовый тип. Десериализация в `object` несимметрична: вы получаете `JsonElement`, а не `CardPayment`.

В ASP.NET Core объявленный тип это возвращаемый тип конечной точки, поэтому та же таблица применима к minimal API:

```csharp
// .NET 11, C# 14
app.MapGet("/payments/latest", () => (PaymentMethod)card);      // {"$type":"card","last4":"4242","amount":10}
app.MapGet("/payments/card",   () => card);                     // {"last4":"4242","amount":10}
app.MapGet("/typed",  () => TypedResults.Ok((PaymentMethod)card)); // discriminator present
app.MapGet("/typed2", () => TypedResults.Ok(card));             // discriminator absent
```

`TypedResults.Ok(card)` выводит `Ok<CardPayment>`, и этот обобщённый аргумент остаётся объявленным типом вплоть до `WriteAsJsonAsync`. Если конечная точка должна возвращать иерархию, типизируйте возвращаемое значение лямбды как базу или используйте явное объединение `Results<T1, T2>`, чтобы форма была видна и сериализатору, и генератору OpenAPI. Возвращать базовый тип рекомендует и [руководство по объединениям типизированных результатов](/ru/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/) для всего, по чему клиенту нужно ветвиться.

## Свойство `$type` должно идти первым

По умолчанию дискриминатор обязан находиться в начале JSON-объекта, сгруппированный с другими свойствами метаданных `$id` и `$ref`. Эта полезная нагрузка десериализуется:

```json
{"$type":"card","Amount":10,"Last4":"4242"}
```

А эта бросает `NotSupportedException: The JSON payload for polymorphic interface or abstract type 'PaymentMethod' must specify a type discriminator.`:

```json
{"Amount":10,"$type":"card","Last4":"4242"}
```

Причина в потоковой обработке. Чтение за один проход вперёд означает, что читатель должен знать целевой тип до того, как начнёт связывать члены. Сообщение исключения вводит в заблуждение при беглом чтении, потому что дискриминатор *есть* в полезной нагрузке, просто слишком поздно.

Начиная с .NET 9 есть явное включение:

```csharp
// .NET 11, C# 14, requires .NET 9 or later
var options = new JsonSerializerOptions { AllowOutOfOrderMetadataProperties = true };
var back = JsonSerializer.Deserialize<PaymentMethod>(json, options); // works
```

Цена вполне реальна, поэтому не включайте это глобально не подумав. С включённым флагом десериализатор больше не может обрабатывать свойства за один проход, поэтому буферизует весь JSON-объект в памяти перед связыванием. На событии в 200 байт это бесплатно. На документе в несколько мегабайт, передаваемом потоком из blob storage, это риск нехватки памяти. Если полезная нагрузка приходит из системы, которую вы контролируете, лучше исправьте писателя. Обычный источник дискриминаторов не по порядку это поход в базу данных: столбцы `jsonb` в PostgreSQL нормализуют порядок ключей, поэтому корректно записанный документ может вернуться с `$type` в середине.

## Все исключения этой возможности

Это точные сообщения среды выполнения, что делает их пригодными для поиска и ускоряет разбор.

| Сообщение | Причина | Решение |
| --- | --- | --- |
| `Specified type 'X' does not support polymorphism. Polymorphic types cannot be structs, sealed types, generic types or System.Object.` | `[JsonDerivedType]` на структуре, запечатанном классе или открытом обобщении | Снимите `sealed` с базы или введите необобщённую базу либо интерфейс |
| `Runtime type 'X' is not supported by polymorphic type 'Y'.` | Сериализация подтипа, который не был объявлен | Добавьте `[JsonDerivedType(typeof(X), "...")]` или задайте `UnknownDerivedTypeHandling` |
| `The JSON payload for polymorphic interface or abstract type 'X' must specify a type discriminator.` | Дискриминатор отсутствует или стоит не первым | Выводите `$type` первым или включите `AllowOutOfOrderMetadataProperties` |
| `Read unrecognized type discriminator id 'x'.` | Полезная нагрузка называет необъявленный подтип | Объявите его или включите `IgnoreUnrecognizedTypeDiscriminators = true` |
| `The polymorphic type 'X' has already specified a type discriminator 'y'.` | Два атрибута `[JsonDerivedType]` делят один идентификатор | Сделайте идентификаторы дискриминатора уникальными в пределах иерархии |
| `The type 'X' contains property '$type' that conflicts with an existing metadata property name.` | Реальное свойство сериализуется под именем дискриминатора | Переименуйте свойство, пометьте его `[JsonIgnore]` или переименуйте дискриминатор |
| `Runtime type 'X' has a diamond ambiguity between derived types 'A' and 'B'.` | `FallBackToNearestAncestor` с двумя одинаково близкими предками | Объявите `X` явно, чтобы откат не потребовался |
| `Deserialization of interface or abstract types is not supported. Type 'X'.` | Абстрактная база вообще без объявленных дискриминаторов | Дайте каждому `[JsonDerivedType]` идентификатор дискриминатора |

Случай нераспознанного дискриминатора бросает `JsonException`; остальные бросают `NotSupportedException` или `InvalidOperationException`. Это различие важно, если вы перехватываете сбои сериализации, чтобы вернуть 400: `JsonException` это корзина «плохой ввод», тогда как `NotSupportedException` здесь почти всегда означает ошибку конфигурации на вашей стороне.

## Работа с подтипами, которые вы не объявляли

По умолчанию необъявленный подтип это жёсткая ошибка при записи, и это верное поведение: молчаливый откат к базовому контракту как раз и есть тот путь, которым свойства исчезают из продакшн-нагрузок. Когда более мягкий режим отказа действительно нужен, `[JsonPolymorphic]` даёт переключатель:

```csharp
// .NET 11, C# 14
[JsonPolymorphic(
    UnknownDerivedTypeHandling = JsonUnknownDerivedTypeHandling.FallBackToBaseType,
    IgnoreUnrecognizedTypeDiscriminators = true)]
[JsonDerivedType(typeof(LeafNode), "leaf")]
public class Node
{
    public string Label { get; set; } = "";
}

public class DeepNode : Node { public int Depth { get; set; } }
```

С такой конфигурацией сериализация `DeepNode` как `Node` пишет `{"Label":"x"}` вместо исключения, а чтение `{"$type":"unknown","Label":"x"}` даёт обычный `Node`. Обе настройки имеют смысл только когда базовый тип конкретный и его можно создать. `IgnoreUnrecognizedTypeDiscriminators` на абстрактной базе лишь отодвигает сбой на шаг, ведь создавать по-прежнему нечего.

Третий вариант, `JsonUnknownDerivedTypeHandling.FallBackToNearestAncestor`, поднимается до ближайшего объявленного предка. Он полезен для иерархий интерфейсов, куда реализации добавляют другие команды, и это единственная настройка, способная вызвать ошибку ромбовидной неоднозначности: если тип реализует два интерфейса, оба объявленные производными типами корня, сериализатор отказывается угадывать.

## Конфигурация не наследуется вниз по иерархии

Эта деталь стоит людям половины дня. Полиморфная конфигурация базового типа не проходит сквозь промежуточные типы:

```csharp
// .NET 11, C# 14
[JsonDerivedType(typeof(Middle), "middle")]
public abstract class Root { }

[JsonDerivedType(typeof(Leaf), "leaf")]
public class Middle : Root { }

public class Leaf : Middle { }

JsonSerializer.Serialize<Root>(new Leaf());
// NotSupportedException: Runtime type 'Leaf' is not supported by polymorphic type 'Root'.
```

`Middle` знает про `Leaf`, а `Root` нет, и сериализатор не складывает две конфигурации вместе. Каждая полиморфная база обязана перечислить все конкретные типы, которые могут появиться под ней, включая «внуков». Объявить `Leaf` и на `Root`, и на `Middle` можно, причём каждый уровень вправе использовать свой идентификатор дискриминатора, так как идентификатор разрешается относительно того базового типа, который объявлен в точке вызова.

## Когда базовый тип нельзя разметить атрибутами

Атрибуты недоступны для типов из пакета NuGet, из сгенерированного клиента или из общей сборки контрактов, которую вам трогать нельзя. Это решает модель контрактов: унаследуйтесь от `DefaultJsonTypeInfoResolver` и прикрепите `PolymorphismOptions` к `JsonTypeInfo` базового типа.

```csharp
// .NET 11, C# 14
using System.Text.Json.Serialization.Metadata;

public class PaymentResolver : DefaultJsonTypeInfoResolver
{
    public override JsonTypeInfo GetTypeInfo(Type type, JsonSerializerOptions options)
    {
        JsonTypeInfo info = base.GetTypeInfo(type, options);

        if (info.Type == typeof(PaymentMethod))
        {
            info.PolymorphismOptions = new JsonPolymorphismOptions
            {
                TypeDiscriminatorPropertyName = "kind",
                IgnoreUnrecognizedTypeDiscriminators = true,
                UnknownDerivedTypeHandling = JsonUnknownDerivedTypeHandling.FailSerialization,
                DerivedTypes =
                {
                    new JsonDerivedType(typeof(CardPayment), "card"),
                    new JsonDerivedType(typeof(PaypalPayment), "paypal")
                }
            };
        }

        return info;
    }
}

var options = new JsonSerializerOptions { TypeInfoResolver = new PaymentResolver() };
```

Резолвер выполняется один раз на тип, а результат кешируется на экземпляре options, поэтому стоимость рефлексии платится на старте, а не на каждом вызове. Это же и запасной выход, когда дискриминатор должен различаться по конечной точке или по арендатору: постройте два экземпляра options с двумя резолверами вместо того, чтобы менять один. После первого вызова сериализации options становятся доступны только для чтения, то же ограничение описано в [руководстве по собственному JsonConverter](/ru/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/).

## Генератор исходного кода и Native AOT

Полиморфизм работает с генератором исходного кода, но только в режиме metadata. Быстрый путь (`JsonSourceGenerationMode.Serialization`) выдаёт жёстко заданные вызовы `Utf8JsonWriter` для известной формы, и ему негде ветвиться по типу времени выполнения, поэтому он падает с `InvalidOperationException: TypeInfoResolver 'MyContext' did not provide property metadata for type 'CardPayment'.`

```csharp
// .NET 11, C# 14
[JsonSerializable(typeof(PaymentMethod))]
[JsonSourceGenerationOptions(GenerationMode = JsonSourceGenerationMode.Metadata)]
public partial class PaymentContext : JsonSerializerContext { }

string json = JsonSerializer.Serialize(payment, PaymentContext.Default.PaymentMethod);
// {"$type":"card","Last4":"4242","Amount":10}
```

Достаточно зарегистрировать базовый тип; генератор идёт по `[JsonDerivedType]` и выпускает метаданные для каждого объявленного подтипа. Именно это делает шаблон безопасным для тримминга и AOT, и поэтому полиморфизм одна из немногих «рефлексивных по форме» возможностей, переживающих публикацию с [Native AOT и minimal API](/ru/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/). Не переживает её любой подтип, существующий только во время выполнения, например созданный библиотекой моков или сгенерированный динамически.

## Что ASP.NET Core кладёт в документ OpenAPI

Встроенный генератор `Microsoft.AspNetCore.OpenApi` читает те же атрибуты, поэтому полиморфный тип ответа документирует себя сам. Для иерархии платежей выше сгенерированная схема выглядит так:

```json
{
  "PaymentMethod": {
    "required": [ "$type" ],
    "type": "object",
    "anyOf": [
      { "$ref": "#/components/schemas/PaymentMethodCardPayment" },
      { "$ref": "#/components/schemas/PaymentMethodPaypalPayment" }
    ],
    "discriminator": {
      "propertyName": "$type",
      "mapping": {
        "card": "#/components/schemas/PaymentMethodCardPayment",
        "paypal": "#/components/schemas/PaymentMethodPaypalPayment"
      }
    }
  }
}
```

Каждая производная схема получает свойство `$type` в виде перечисления с одним значением, и именно это позволяет генераторам клиентов строить размеченное объединение. Одно замечание из документации стоит повторить: ключевое слово `discriminator` появляется только если базовый тип **абстрактный**. Конкретная база не может пометить `$type` как обязательное в терминах OpenAPI, поскольку у экземпляров самой базы дискриминатора нет, поэтому генератор опускает объект discriminator. Если документ является результатом поставки, сделайте базу абстрактной. Если что-то из этого нужно переформировать, это делается в трансформере схемы, описанном в [руководстве по трансформерам OpenAPI](/ru/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/).

## Мелочи, которые кусаются

- **`record` работают, включая позиционные.** `[JsonDerivedType(typeof(TextMessage), "text")]` на абстрактном `record` без лишних церемоний прогоняет `TextMessage(string Body)` туда и обратно, потому что дискриминатор читается до связывания аргументов конструктора.
- **Закрытые обобщённые подтипы допустимы.** База обобщённой быть не может, но `[JsonDerivedType(typeof(Envelope<int>), "int-envelope")]` вполне нормален. Каждой закрытой инстанциации нужен свой атрибут и свой идентификатор.
- **Собственные конвертеры и полиморфизм не сочетаются.** Дискриминаторы поддерживаются только конвертерами по умолчанию для объектов, коллекций и словарей. `JsonConverter<T>` на базовом типе полностью заменяет механизм и должен писать дискриминатор сам.
- **`JsonSerializerOptions.Strict` (.NET 10) совместим.** Свойство `$type` считается метаданными, а не несопоставленным членом, поэтому `UnmappedMemberHandling.Disallow` его не отвергает. Неизвестные свойства *данных* по-прежнему приводят к исключению, в этом и смысл пресета.
- **У `TypeNameHandling` из Newtonsoft.Json намеренно нет аналога.** Встраивание имени CLR-типа в полезную нагрузку это известный вектор гаджетов десериализации. `[JsonDerivedType]` требует явного белого списка, и поэтому путь миграции с `TypeNameHandling.All` самый острый угол при [переносе большой кодовой базы на System.Text.Json](/ru/2026/05/migrate-from-newtonsoft-json-to-system-text-json-in-a-large-codebase/).
- **Неверный дискриминатор виден вызывающей стороне как ошибка преобразования.** Если вы отлаживаете это снаружи, симптомы пересекаются с общим семейством ошибок [JSON value could not be converted](/ru/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/).

Мысленная модель, которая держит всё это вместе: объявленный тип выбирает контракт, контракт несёт белый список производных типов, а дискриминатор это метаданные, которые обязаны прийти раньше описываемых ими данных. Каждый режим отказа выше это нарушение одного из этих трёх утверждений.

## Похожие материалы

- [Как написать собственный JsonConverter в System.Text.Json](/ru/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/)
- [Fix: System.Text.Json.JsonException: The JSON value could not be converted](/ru/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/)
- [Миграция с Newtonsoft.Json на System.Text.Json в большой кодовой базе](/ru/2026/05/migrate-from-newtonsoft-json-to-system-text-json-in-a-large-codebase/)
- [Как использовать Native AOT с minimal API в ASP.NET Core](/ru/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)
- [record vs class vs struct в C#: матрица решений](/ru/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/)

## Источники

- [How to serialize properties of derived classes, MS Learn](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/polymorphism)
- [Справочник по `JsonDerivedTypeAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonderivedtypeattribute)
- [Справочник по `JsonPolymorphicAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonpolymorphicattribute)
- [`JsonSerializerOptions.AllowOutOfOrderMetadataProperties`, .NET 9+](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializeroptions.allowoutofordermetadataproperties)
- [Настройка контракта JSON с помощью модели контрактов](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/custom-contracts)
- [Включение метаданных OpenAPI в приложение ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/include-metadata)
- [Строки ресурсов `System.Text.Json`, dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Text.Json/src/Resources/Strings.resx)
