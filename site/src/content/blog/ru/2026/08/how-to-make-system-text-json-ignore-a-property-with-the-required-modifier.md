---
title: "Как заставить System.Text.Json игнорировать свойство с модификатором required"
description: "[JsonIgnore] на члене с required выбрасывает InvalidOperationException: marked required but does not specify a setter. Почему эти две возможности конфликтуют и четыре способа всё же проигнорировать свойство, измерено на .NET 10."
pubDate: 2026-08-16
tags:
  - "system-text-json"
  - "csharp"
  - "csharp-14"
  - "dotnet-10"
  - "serialization"
  - "json"
lang: "ru"
translationOf: "2026/08/how-to-make-system-text-json-ignore-a-property-with-the-required-modifier"
translatedBy: "claude"
translationDate: 2026-08-16
---

Короткий ответ: поставить `[JsonIgnore]` на член с модификатором `required` из C# нельзя. В момент, когда System.Text.Json строит контракт для этого типа, он выбрасывает `InvalidOperationException: JsonPropertyInfo 'InternalId' defined in type 'Ignored' is marked required but does not specify a setter`, причём и при сериализации, и при десериализации. Есть четыре рабочих варианта, и нужный зависит от того, что значит "игнорировать": *перестать записывать свойство в JSON* или *перестать требовать его из JSON*. Если тип ваш, поставьте `[SetsRequiredMembers]` на конструктор и оставьте `[JsonIgnore]`. Если тип не ваш, сбросьте `JsonPropertyInfo.IsRequired` в модификаторе `DefaultJsonTypeInfoResolver`.

Всё изложенное ниже измерено на SDK .NET 10.0.201 со средой выполнения 10.0.5 и C# 14. System.Text.Json учитывает модификатор `required` начиная с .NET 7, а использованные здесь API модели контракта стабильны с .NET 7, поэтому поведение справедливо для .NET 7 и новее, если в разделе не сказано иное. Единственное исключение, это `RespectRequiredConstructorParameters`, появившийся в .NET 9.

## Почему required и JsonIgnore несовместимы

Эти две возможности выглядят независимыми. `required` появился в C# 11 и заставляет вызывающий код присвоить член в инициализаторе объекта, а `[JsonIgnore]` является инструкцией сериализатору. Конфликтуют они потому, что System.Text.Json читает модификатор `required` и превращает его в метаданные сериализации.

Согласно [документации об обязательных свойствах](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/required-properties), модификатор `required` из C# и `[JsonRequired]` "эквивалентны, и оба отображаются на одну и ту же часть метаданных", а именно на `JsonPropertyInfo.IsRequired`. Значит, `required` является не только контрактом компилятора, но и контрактом десериализации: свойство обязано присутствовать в полезной нагрузке.

`[JsonIgnore]` работает иначе. Он не убирает свойство из контракта. Он сохраняет `JsonPropertyInfo` и снимает у него методы доступа. Увидеть это можно, повесив модификатор на резолвер и распечатав контракт:

```csharp
// .NET 10.0.5, C# 14
var probe = new JsonSerializerOptions
{
    TypeInfoResolver = new DefaultJsonTypeInfoResolver
    {
        Modifiers =
        {
            static typeInfo =>
            {
                if (typeInfo.Type != typeof(Ignored)) return;
                foreach (JsonPropertyInfo p in typeInfo.Properties)
                    Console.WriteLine($"{p.Name}: IsRequired={p.IsRequired} hasSet={p.Set is not null} hasGet={p.Get is not null}");
            }
        }
    }
};

JsonSerializer.Deserialize<Ignored>("""{"Name":"a"}""", probe);

public class Ignored
{
    public required string Name { get; set; }
    [JsonIgnore] public required string InternalId { get; set; }
}
```

Модификатор выполняется до проверки, поэтому вывод появляется раньше исключения:

```text
Name: IsRequired=True hasSet=True hasGet=True
InternalId: IsRequired=True hasSet=False hasGet=False
InvalidOperationException: JsonPropertyInfo 'InternalId' defined in type 'Ignored' is marked required but does not specify a setter.
```

Вот и всё. `InternalId` по-прежнему в контракте, по-прежнему помечен как `IsRequired=True`, но `[JsonIgnore]` обнулил оба метода доступа. У сериализатора остаётся свойство, которое он обязан заполнить из полезной нагрузки и заполнить не может. Он отказывается вообще строить контракт, и поэтому сообщение об ошибке говорит об отсутствующем сеттере, хотя в исходном коде сеттер явно есть.

Два следствия того, что это отказ *проверки контракта*, а не десериализации:

- Исключение возникает и при сериализации. `JsonSerializer.Serialize(new Ignored { Name = "a", InternalId = "x" })` падает с тем же `InvalidOperationException`, хотя записи JSON сеттер не нужен никогда.
- Это отказ во время выполнения, а не во время компиляции. Ничто вас не предупредит. Код уезжает в продакшен и падает при первом же обращении к этому типу.

То же самое происходит с `[JsonRequired]` вместо ключевого слова `required` и с полями `required`, как только включён `IncludeFields`. Значение имеет флаг `IsRequired`, а не способ, которым вы его установили.

## Минимальное воспроизведение

```csharp
// .NET 10.0.5, C# 14
using System.Text.Json;
using System.Text.Json.Serialization;

var order = new Order { Id = 7, InternalAuditToken = "tok_abc" };

// Throws InvalidOperationException, not a JsonException.
string json = JsonSerializer.Serialize(order);

public class Order
{
    public required int Id { get; set; }

    [JsonIgnore]
    public required string InternalAuditToken { get; set; }
}
```

Замысел очевиден и разумен: `InternalAuditToken` всегда должен задаваться вашим собственным кодом (для этого и нужен `required`) и никогда не должен уходить по сети (для этого нужен `[JsonIgnore]`). System.Text.Json просто не умеет выразить оба требования сразу одними лишь атрибутами.

## Пометить конструктор атрибутом SetsRequiredMembers

К этому решению стоит обращаться, когда тип принадлежит вам. `System.Diagnostics.CodeAnalysis.SetsRequiredMembersAttribute` сообщает компилятору, что данный конструктор присваивает все обязательные члены, поэтому вызывающему коду делать это уже не нужно. System.Text.Json тоже понимает этот атрибут и при его наличии перестаёт считать члены обязательными.

```csharp
// .NET 10.0.5, C# 14
using System.Diagnostics.CodeAnalysis;

public class Order
{
    [SetsRequiredMembers]
    public Order()
    {
        Id = 0;
        InternalAuditToken = TokenFactory.NewToken();
    }

    public required int Id { get; set; }

    [JsonIgnore]
    public required string InternalAuditToken { get; set; }
}
```

Теперь работают оба направления. `JsonSerializer.Deserialize<Order>("""{"Id":7}""")` возвращает экземпляр, в котором `InternalAuditToken` содержит то, что произвёл конструктор, а сериализация выдаёт `{"Id":7}` без следа токена.

Механизм стоит понимать, потому что он объясняет радиус поражения. Печать контракта для типа с атрибутом и без него показывает, что именно меняется:

```text
[without SetsRequiredMembers]
  Name: IsRequired=True  set=True
  InternalId: IsRequired=True  set=True

[with SetsRequiredMembers]
  Name: IsRequired=False set=True
  InternalId: IsRequired=False set=True
```

`[SetsRequiredMembers]` сбрасывает `IsRequired` у **всех** членов типа, а не только у проигнорированного. Если вы рассчитывали, что `required` отклонит полезную нагрузку без `Id`, эта проверка исчезла вместе с ошибкой, которую вы пытались исправить. Верните `[JsonRequired]` на те члены, которые всё ещё хотите проверять:

```csharp
// .NET 10.0.5, C# 14
public class Order
{
    [SetsRequiredMembers]
    public Order() { Id = 0; InternalAuditToken = TokenFactory.NewToken(); }

    [JsonRequired]                       // keeps the payload requirement
    public required int Id { get; set; }

    [JsonIgnore]                         // no longer required by the serializer
    public required string InternalAuditToken { get; set; }
}
```

Эта комбинация даёт ровно исходный замысел: компилятор C# по-прежнему обязывает ваш код задать оба члена, контракт JSON по-прежнему отклоняет полезную нагрузку без `Id`, а токен никогда не появляется в JSON.

## Сброс IsRequired через модификатор резолвера

Когда тип приходит из пакета, который вы не контролируете, или правило нужно применить сразу ко многим типам, правьте контракт, а не тип. Модификатор `DefaultJsonTypeInfoResolver` выполняется после построения контракта по умолчанию и до его проверки, поэтому успевает выключить `IsRequired`.

Общая кувалда, взятая прямо из примера Microsoft Learn, снимает ограничение везде:

```csharp
// .NET 10.0.5, C# 14
var options = new JsonSerializerOptions
{
    TypeInfoResolver = new DefaultJsonTypeInfoResolver
    {
        Modifiers =
        {
            static typeInfo =>
            {
                if (typeInfo.Kind != JsonTypeInfoKind.Object) return;
                foreach (JsonPropertyInfo p in typeInfo.Properties)
                    p.IsRequired = false;
            }
        }
    }
};
```

Обычно это слишком широко. Точечный вариант опирается на ваш собственный атрибут-маркер, так что политика живёт рядом со свойством, которое описывает, и распространяется на все типы модели:

```csharp
// .NET 10.0.5, C# 14
[AttributeUsage(AttributeTargets.Property)]
public sealed class ServerOwnedAttribute : Attribute;

public class Order
{
    public required int Id { get; set; }

    [ServerOwned]
    public required string? InternalAuditToken { get; set; }
}

var options = new JsonSerializerOptions
{
    TypeInfoResolver = new DefaultJsonTypeInfoResolver
    {
        Modifiers =
        {
            static typeInfo =>
            {
                foreach (JsonPropertyInfo p in typeInfo.Properties)
                {
                    if (p.AttributeProvider?.IsDefined(typeof(ServerOwnedAttribute), inherit: true) != true)
                        continue;

                    p.IsRequired = false;                        // stop demanding it on read
                    p.ShouldSerialize = static (_, _) => false;  // stop emitting it on write
                }
            }
        }
    }
};
```

Измеренные результаты с этими параметрами: `Deserialize<Order>("""{"Id":7}""")` отрабатывает успешно и оставляет токен равным null, а `Serialize(new Order { Id = 7, InternalAuditToken = "secret" })` выдаёт `{"Id":7}`. Обратите внимание, что `[JsonIgnore]` на свойстве здесь нет. Запись подавляет именно `ShouldSerialize`, и, в отличие от `[JsonIgnore]`, он не снимает методы доступа, поэтому ошибки проверки не возникает.

Если вы предпочитаете, чтобы свойство исчезло из контракта полностью, удалите его, а не перенастраивайте. `typeInfo.Properties` является изменяемым списком:

```csharp
// .NET 10.0.5, C# 14
for (int i = typeInfo.Properties.Count - 1; i >= 0; i--)
    if (typeInfo.Properties[i].Name == "InternalAuditToken")
        typeInfo.Properties.RemoveAt(i);
```

Это тоже работает в обе стороны и ближе всего к тому, чего люди ждут от `[JsonIgnore]`. Помните, что `Name` здесь является именем в JSON, то есть отражает уже применённую политику именования или `[JsonPropertyName]`. Если вы навешиваете это на параметры, у которых резолвер уже есть, сначала стоит прочитать про механику [изменения существующего type info resolver](/ru/2023/10/system-text-json-how-to-modify-existing-type-info-resolver/); та же точка расширения работает и для [контрактов, сгенерированных из исходного кода](/ru/2026/08/how-to-customize-source-generated-system-text-json-serialization-with-a-modifier/).

## Игнорировать только при записи, чего многие на самом деле и хотят

В половине случаев требование асимметрично: свойство обязано присутствовать при чтении полезной нагрузки, но не должно возвращаться при её записи. Хеши паролей, токены аудита и внутренние идентификаторы обычно попадают сюда. Для этого случая есть штатный ответ без конфликта с `required`, потому что условное игнорирование не снимает методы доступа:

```csharp
// .NET 10.0.5, C# 14
public class Order
{
    public required int Id { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public required string? InternalAuditToken { get; set; }
}
```

Измерено: `Serialize(new Order { Id = 7, InternalAuditToken = null })` выдаёт `{"Id":7}`, а `Deserialize<Order>("""{"Id":7}""")` по-прежнему выбрасывает `JsonException: JSON deserialization for type 'Order' was missing required properties including: 'InternalAuditToken'`. Обе половины сохранены. `JsonIgnoreCondition.WhenWritingDefault` ведёт себя так же для значимых типов. Ломается только голый `[JsonIgnore]`, который означает `JsonIgnoreCondition.Always`.

Четвёртый вариант, часто верный для публичной поверхности API, состоит в том, чтобы перестать нагружать один тип двумя задачами. Отдельный транспортный DTO без членов `required`, отображаемый в ваш доменный тип и обратно, обходит проблему целиком и даёт место, куда позже лягут вопросы версионирования. Он стоит одного метода отображения и покупает контракт, который можно менять, не трогая доменную модель.

## Что стоит знать до выбора

**Явный `null` удовлетворяет `required`.** `Deserialize<Order>("""{"Id":7,"InternalAuditToken":null}""")` отрабатывает успешно. `required` означает, что ключ присутствует, а не что значение осмысленно. Если вам нужно значение, отличное от null, это вопрос валидации, а не сериализации.

**Инициализатор свойства тоже его не удовлетворяет.** `public required string InternalId { get; set; } = "fallback";` по-прежнему выбрасывает `JsonException`, когда ключа нет в полезной нагрузке. Значение по умолчанию применяется, после чего сериализатор всё равно отклоняет нагрузку.

**В сообщении об ошибке используется имя из JSON.** С `[JsonPropertyName("internal_id")]` на обязательном свойстве исключение о пропущенном свойстве читается как `missing required properties including: 'internal_id'`, а не как имя члена CLR. Полезно, когда задействована политика именования, а вы ищете не ту строку.

**Обязательные поля проверяются только при включённом `IncludeFields`.** Поле `public required string InternalId;` по умолчанию невидимо для System.Text.Json, поэтому нагрузка без него десериализуется нормально. Включите `IncludeFields = true`, и тот же тип начнёт выбрасывать исключение. Если вы включаете этот параметр в существующей кодовой базе, будьте готовы к тому, что это всплывёт.

**Спрятать член за закрытым сеттером не получится.** `public required string InternalId { get; private set; }` не компилируется: компилятор C# отклоняет его с `CS9032: Required member 'X' cannot be less visible or have a setter less visible than the containing type`. Это закрывает лазейку, к которой часто тянутся, и приходится роднёй [ошибке CS9035, возникающей, когда инициализатор объекта пропускает обязательный член](/ru/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/).

**Генерация исходного кода ведёт себя точно так же.** Десериализация через `JsonSerializerContext` даёт ровно то же `InvalidOperationException` для связки `[JsonIgnore]` и `required` и то же `JsonException` для отсутствующего обязательного свойства. Осмотр сгенерированного кода с `EmitCompilerGeneratedFiles` показывает причину: он напрямую выдаёт `properties[0].IsRequired = true;`. Отметить это стоит потому, что страница Microsoft Learn до сих пор советует использовать `[JsonRequired]` вместо `required` в режиме генерации исходного кода на том основании, что с ключевым словом "ваш код не скомпилируется". На .NET 10 он компилируется и работает; `[SetsRequiredMembers]` через сгенерированный контекст тоже работает. На более старом SDK это стоит проверить, прежде чем на это полагаться.

**`RespectRequiredConstructorParameters` является другой настройкой.** Появившись в .NET 9, она делает необязательные *параметры конструктора* обязательными в полезной нагрузке. К модификатору `required` на членах она отношения не имеет, и её отключение здесь не спасёт. Проверено: с конструктором `Order(string name, string internalId)` и без параметров сериализации `Deserialize<Order>("""{"Name":"a"}""")` отрабатывает успешно и оставляет параметр со значением по умолчанию; с `RespectRequiredConstructorParameters = true` тот же вызов выбрасывает `JsonException`. Если ваша проблема в отсутствующем аргументе конструктора, а не в отсутствующем члене, смотреть надо именно на этот флаг.

Если настоящая цель состоит в том, чтобы отклонять нагрузки с полями, которых нет в модели, это зеркальная задача со своим переключателем: смотрите [обработку отсутствующих и несопоставленных членов при десериализации](/ru/2023/09/net-8-handle-missing-members-during-json-deserialization/). А когда свойство нужно игнорировать лишь в некоторых ветвях иерархии, [собственный JsonConverter](/ru/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) даёт полный контроль над записываемым содержимым ценой ручного сопровождения путей чтения и записи.

Моя рекомендация по умолчанию: если тип ваш, ставьте `[SetsRequiredMembers]` на конструктор и `[JsonRequired]` на те члены, которые всё ещё нужно проверять. Это три строки, это сохраняет гарантию уровня компилятора, ради которой вы и написали `required`, и это не требует протаскивать через всё приложение отдельный объект параметров.

## Источники

- [Require properties for deserialization](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/required-properties) на Microsoft Learn, про эквивалентность `required`, `[JsonRequired]` и `JsonPropertyInfo.IsRequired`, а также про переключатель `RespectRequiredConstructorParameters`.
- [How to ignore properties with System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/ignore-properties) про полный список `JsonIgnoreCondition` и глобальную настройку `DefaultIgnoreCondition`.
- Справочник API по [JsonPropertyInfo.IsRequired](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.metadata.jsonpropertyinfo.isrequired) и [JsonPropertyInfo.ShouldSerialize](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.metadata.jsonpropertyinfo.shouldserialize).
- Справочник API по [SetsRequiredMembersAttribute](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.codeanalysis.setsrequiredmembersattribute).
- [Модификатор required](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/required) в справочнике по языку C#, включая правило видимости CS9032.
