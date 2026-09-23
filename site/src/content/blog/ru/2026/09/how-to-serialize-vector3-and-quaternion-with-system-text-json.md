---
title: "Как сериализовать публичные поля, такие как Vector3 и Quaternion, с помощью System.Text.Json"
description: "System.Text.Json записывает Vector3 как {}, а Quaternion как {\"IsIdentity\":false}, потому что эти типы хранят данные в публичных полях. Разбираем, как это исправляют IncludeFields, собственный конвертер, модификатор resolver и генерация исходного кода, с измерениями на .NET 10 и .NET 11 RC 1."
pubDate: 2026-09-23
template: how-to
tags:
  - "system-text-json"
  - "csharp"
  - "dotnet-10"
  - "dotnet-11"
  - "serialization"
  - "json"
lang: "ru"
translationOf: "2026/09/how-to-serialize-vector3-and-quaternion-with-system-text-json"
translatedBy: "claude"
translationDate: 2026-09-23
---

**Коротко:** `System.Numerics.Vector3`, `Vector2`, `Vector4`, `Quaternion`, `Plane` и `Matrix4x4` хранят данные в публичных *полях*, а System.Text.Json по умолчанию поля игнорирует. Поэтому `JsonSerializer.Serialize(new Vector3(1, 2.5f, -3))` возвращает `{}`, а десериализация `{"X":1,"Y":2,"Z":3}` молча дает `<0, 0, 0>`. Установите `IncludeFields = true` в `JsonSerializerOptions` (или `[JsonSourceGenerationOptions(IncludeFields = true)]` на контексте с генерацией исходного кода) и добавьте `IgnoreReadOnlyProperties = true`, чтобы `Quaternion.IsIdentity` перестал попадать в вывод. Если нужна компактная форма `[x, y, z]` или вы сериализуете `Matrix4x4`, напишите вместо этого `JsonConverter<T>`.

Весь вывод в этой статье получен запуском одной и той же файловой пробы на .NET 10.0.10 (SDK 10.0.302) и на .NET 11.0.0 RC 1 (SDK 11.0.100-rc.1.26425.128). Обе среды выполнения выдали побайтово идентичный результат, так что в .NET 11 здесь ничего не меняется. API для работы с полями (`IncludeFields`, `[JsonInclude]`) существуют начиная с .NET 5; свойства строк `Matrix4x4.X/Y/Z/W`, из-за которых вывод матриц становится более шумным, появились в .NET 10.

## Почему System.Text.Json записывает пустой объект для Vector3

System.Text.Json строит контракт для каждого типа по его публичным **свойствам** экземпляра. Публичные поля учитываются, только если вы это явно включите. Это поведение по умолчанию описано на странице [Include fields in serialization](https://learn.microsoft.com/dotnet/standard/serialization/system-text-json/fields), и оно противоположно тому, что делал Newtonsoft.Json, поэтому на нем часто спотыкаются при миграции.

Типы `System.Numerics` проектировались для SIMD и interop, а не для сериализации. Их компоненты - обычные изменяемые поля:

```csharp
// Shape of the types in System.Numerics (.NET 10), simplified
public struct Vector3    { public float X; public float Y; public float Z; }
public struct Quaternion { public float X; public float Y; public float Z; public float W;
                           public bool IsIdentity { get; } }
public struct Plane      { public Vector3 Normal; public float D; }
```

У `Vector3` нет публичных свойств экземпляра, которые мог бы использовать сериализатор, поэтому его контракт пуст. У `Quaternion` ровно одно публичное свойство экземпляра, вычисляемое `IsIdentity`, и только оно и записывается. Ничего не выбрасывает исключений, ничего не выдает предупреждений.

## Минимальное воспроизведение

```csharp
// .NET 10.0.10 and .NET 11.0.0 RC 1, C# 14
using System.Numerics;
using System.Text.Json;

var v = new Vector3(1f, 2.5f, -3f);
var q = Quaternion.CreateFromYawPitchRoll(0.5f, 0f, 0f);

Console.WriteLine(JsonSerializer.Serialize(v));
// {}
Console.WriteLine(JsonSerializer.Serialize(q));
// {"IsIdentity":false}
Console.WriteLine(JsonSerializer.Serialize(new Transform { Position = v, Rotation = q }));
// {"Position":{},"Rotation":{"IsIdentity":false}}

Vector3 back = JsonSerializer.Deserialize<Vector3>("""{"X":1,"Y":2,"Z":3}""");
Console.WriteLine(back);
// <0. 0. 0>

public class Transform
{
    public Vector3 Position { get; set; }
    public Quaternion Rotation { get; set; }
}
```

Опасна именно строка с десериализацией. JSON явно содержит `X`, `Y` и `Z`, но поскольку в контракте нет членов с такими именами, сериализатор считает их несопоставленными и пропускает. Вы получаете `Vector3.Zero` и зеленый тест, если тест проверяет только то, что десериализация не выбросила исключение.

Если вы хотите, чтобы такие ошибки проявлялись громко, включите `UnmappedMemberHandling`:

```csharp
// .NET 10.0.10
var strict = new JsonSerializerOptions
{
    UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
};
JsonSerializer.Deserialize<Vector3>("""{"X":1,"Y":2,"Z":3}""", strict);
// JsonException: The JSON property 'X' could not be mapped to any .NET member
// contained in type 'System.Numerics.Vector3'.
```

Эта настройка существует с .NET 8 и подробнее разобрана в статье [об обработке отсутствующих и несопоставленных членов при десериализации](/ru/2023/09/net-8-handle-missing-members-during-json-deserialization/).

## Исправление 1: IncludeFields в JsonSerializerOptions

Это исправление в одну строку, и для большинства приложений оно правильное:

```csharp
// .NET 10.0.10 and .NET 11.0.0 RC 1
var options = new JsonSerializerOptions
{
    IncludeFields = true,
    IgnoreReadOnlyProperties = true
};

JsonSerializer.Serialize(new Vector3(1f, 2.5f, -3f), options);
// {"X":1,"Y":2.5,"Z":-3}
JsonSerializer.Serialize(Quaternion.Identity, options);
// {"X":0,"Y":0,"Z":0,"W":1}
JsonSerializer.Serialize(new Plane(new Vector3(0, 1, 0), 5), options);
// {"Normal":{"X":0,"Y":1,"Z":0},"D":5}

JsonSerializer.Deserialize<Vector3>("""{"X":1,"Y":2,"Z":3}""", options);
// <1. 2. 3>
```

Зачем еще и `IgnoreReadOnlyProperties`? С одним только `IncludeFields = true` `Quaternion` сериализуется так:

```json
{"IsIdentity":false,"X":0,"Y":0.24740396,"Z":0,"W":0.9689124}
```

`IsIdentity` - производные данные. Оно стоит лишних байтов в каждом записанном повороте, а любой клиент, читающий ваш JSON, видит поле, которое выглядит записываемым, но при обратном чтении игнорируется. `IgnoreReadOnlyProperties` убирает из вывода свойства только для чтения, то есть удаляет `IsIdentity` и сохраняет все четыре компонента. На поля эта настройка не влияет, так что комбинировать их безопасно.

Десериализация работает потому, что это структуры: System.Text.Json создает экземпляр по умолчанию и присваивает поля, конструктор `Vector3(float, float, float)` ему не нужен. Отсутствующий компонент остается `0`, так что `{"X":1}` превращается в `<1, 0, 0>`.

Про `IncludeFields` нужно знать две вещи:

- **Настройка глобальная.** У каждого типа в графе теперь сериализуются публичные поля. Если в ваших собственных DTO есть публичные поля, которые вы не собирались раскрывать, они тоже попадут в вывод. Прежде чем включать ее в общем экземпляре настроек, поищите `public`-поля в сериализуемых типах.
- **Она меняет поведение `required`.** Публичное поле с `required` невидимо для System.Text.Json, пока поля не включены, а после этого payload без него начинает выбрасывать исключение. Я измерял это в статье об [игнорировании свойств с модификатором `required`](/ru/2026/08/how-to-make-system-text-json-ignore-a-property-with-the-required-modifier/).

### Почему [JsonInclude] здесь не помогает

Альтернатива `IncludeFields` на уровне отдельного члена - `[JsonInclude]`, но атрибут ставится на само *поле*, а `System.Numerics.Vector3` вам не принадлежит. Если поставить его на собственный член типа `Vector3`, на поля внутри него это никак не повлияет:

```csharp
// .NET 10.0.10
public class Holder
{
    [JsonInclude] public Vector3 Pos = new(1, 2, 3);
}

JsonSerializer.Serialize(new Holder());
// {"Pos":{}}
```

`[JsonInclude]` сделал частью контракта `Holder` само `Pos`. Контракт `Vector3` по-прежнему пуст.

## Исправление 2: JsonConverter для компактной формы в виде массива

Именованные компоненты удобно читать, но файл сцены или поток телеметрии с тысячами позиций платит за `"X":`, `"Y":`, `"Z":` в каждой из них. И glTF, и GeoJSON используют для векторов массивы. Конвертер дает такую форму и делает выбор независимым от глобальных настроек:

```csharp
// .NET 10.0.10 and .NET 11.0.0 RC 1, C# 14
using System.Numerics;
using System.Text.Json;
using System.Text.Json.Serialization;

public sealed class Vector3ArrayConverter : JsonConverter<Vector3>
{
    public override Vector3 Read(ref Utf8JsonReader reader, Type typeToConvert,
        JsonSerializerOptions options)
    {
        if (reader.TokenType != JsonTokenType.StartArray)
            throw new JsonException("Expected [x, y, z].");

        Span<float> c = stackalloc float[3];
        for (int i = 0; i < 3; i++)
        {
            if (!reader.Read() || reader.TokenType != JsonTokenType.Number)
                throw new JsonException("Expected [x, y, z].");
            c[i] = reader.GetSingle();
        }

        if (!reader.Read() || reader.TokenType != JsonTokenType.EndArray)
            throw new JsonException("Expected [x, y, z].");

        return new Vector3(c);
    }

    public override void Write(Utf8JsonWriter writer, Vector3 value,
        JsonSerializerOptions options)
    {
        writer.WriteStartArray();
        writer.WriteNumberValue(value.X);
        writer.WriteNumberValue(value.Y);
        writer.WriteNumberValue(value.Z);
        writer.WriteEndArray();
    }
}
```

Зарегистрируйте его в настройках или через `[JsonConverter(typeof(Vector3ArrayConverter))]` на свойстве:

```csharp
// .NET 10.0.10
var options = new JsonSerializerOptions { Converters = { new Vector3ArrayConverter() } };

JsonSerializer.Serialize(new Vector3(1f, 2.5f, -3f), options);  // [1,2.5,-3]
JsonSerializer.Deserialize<Vector3>("[1,2,3]", options);         // <1. 2. 3>
JsonSerializer.Deserialize<Vector3>("[1,2]", options);           // JsonException: Expected [x, y, z].
```

Конвертер покрывает только тот тип, для которого зарегистрирован. В воспроизведении с `Transform` выше этот экземпляр настроек записывает `{"Position":[1,2.5,-3],"Rotation":{"IsIdentity":false}}`: позиция исправлена, поворот по-прежнему сломан. Напишите по конвертеру на каждый используемый тип (версия для `Quaternion` - тот же код с четырьмя компонентами) или комбинируйте конвертер с `IncludeFields = true` для остального. Механику reader/writer, в том числе почему reader нужно оставлять на последнем прочитанном токене, смотрите в статье [как написать собственный JsonConverter в System.Text.Json](/ru/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/).

## Исправление 3: Matrix4x4 нужен конвертер, а не IncludeFields

На `Matrix4x4` подход с `IncludeFields` в .NET 10 и новее разваливается. У структуры 16 публичных полей от `M11` до `M44`, а .NET 10 добавил свойства строк `X`, `Y`, `Z` и `W` (каждое типа `Vector4`) для чтения и записи поверх уже существующего свойства `Translation`, тоже доступного для чтения и записи. Поскольку у них есть сеттеры, `IgnoreReadOnlyProperties` их не убирает. Результат для `Matrix4x4.CreateTranslation(1, 2, 3)` с `IncludeFields = true`:

```json
{"IsIdentity":false,"Translation":{"X":1,"Y":2,"Z":3},
 "X":{"X":1,"Y":0,"Z":0,"W":0},"Y":{"X":0,"Y":1,"Z":0,"W":0},
 "Z":{"X":0,"Y":0,"Z":1,"W":0},"W":{"X":1,"Y":2,"Z":3,"W":1},
 "M11":1,"M12":0,"M13":0,"M14":0,"M21":0,"M22":1,"M23":0,"M24":0,
 "M31":0,"M32":0,"M33":1,"M34":0,"M41":1,"M42":2,"M43":3,"M44":1}
```

Каждое значение записано дважды, а `M41`-`M43` трижды. Обратное чтение работает, но при десериализации члены применяются в том порядке, в котором они идут в JSON, и побеждает последний. Я это проверил: `{"M41":9,"W":{"X":1,"Y":2,"Z":3,"W":1}}` дает `M41 == 1`, а те же члены в обратном порядке дают `M41 == 9`. Клиент, который изменит одно представление и не изменит другое, получит матрицу, зависящую от порядка ключей. Учтите также, что частичный payload вроде `{"M11":1}` дает матрицу с нулями во всех остальных элементах, а не `Matrix4x4.Identity`, потому что начальное значение - `default`.

Для матриц напишите конвертер, который выводит 16 полей `M` плоским массивом в построчном порядке, по тому же шаблону, что и `Vector3ArrayConverter`, только с циклом на 16 элементов. Кода получится меньше, чем для защиты от дублированной формы.

## Исправление 4: удаление членов модификатором resolver

Если нужны именованные компоненты (форма из исправления 1), но требуется точный контроль, например вы не можете использовать `IgnoreReadOnlyProperties`, потому что ваши собственные DTO полагаются на запись свойств только для чтения, настройте контракт только для типов numerics:

```csharp
// .NET 10.0.10 and .NET 11.0.0 RC 1
using System.Numerics;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;

var options = new JsonSerializerOptions
{
    IncludeFields = true,
    TypeInfoResolver = new DefaultJsonTypeInfoResolver
    {
        Modifiers =
        {
            ti =>
            {
                if (ti.Type != typeof(Quaternion) && ti.Type != typeof(Matrix4x4))
                    return;

                for (int i = ti.Properties.Count - 1; i >= 0; i--)
                {
                    if (ti.Properties[i].Name is "IsIdentity" or "Translation")
                        ti.Properties.RemoveAt(i);
                }
            }
        }
    }
};

JsonSerializer.Serialize(Quaternion.CreateFromYawPitchRoll(0.5f, 0f, 0f), options);
// {"X":0,"Y":0.24740396,"Z":0,"W":0.9689124}
```

Это тот же прием, что и [модификация существующего type info resolver](/ru/2023/10/system-text-json-how-to-modify-existing-type-info-resolver/). Выигрыш в области действия на уровне типа: ваши собственные типы сохраняют контракт по умолчанию. Учтите, что в .NET 10+ строки `X/Y/Z/W` у `Matrix4x4` все равно остаются, и это еще один аргумент в пользу конвертера для матриц.

## Генерация исходного кода и Native AOT

Если вы используете `JsonSerializerContext` (обязателен для Native AOT и приложений с тримингом), переключатель находится на контексте, а не в настройках:

```csharp
// .NET 10.0.10 and .NET 11.0.0 RC 1
[JsonSourceGenerationOptions(IncludeFields = true, IgnoreReadOnlyProperties = true)]
[JsonSerializable(typeof(Transform))]
internal partial class SceneContext : JsonSerializerContext;

JsonSerializer.Serialize(new Transform { Position = v, Rotation = q },
    SceneContext.Default.Transform);
// {"Position":{"X":1,"Y":2.5,"Z":-3},"Rotation":{"X":0,"Y":0.24740396,"Z":0,"W":0.9689124}}
```

Контекст без `IncludeFields = true` генерирует тот же пустой контракт, что и в воспроизведении: `{}` для `Vector3`, проверено измерением. Собственные конвертеры тоже работают с генерацией исходного кода; добавьте их через `[JsonSourceGenerationOptions(Converters = [typeof(Vector3ArrayConverter)])]`.

Одна ловушка, на которую я наткнулся при создании пробы: файловые приложения .NET 10 (`dotnet run probe.cs`) по умолчанию используют `PublishAot=true`, что отключает сериализацию на основе рефлексии. Вызов `JsonSerializer.Serialize(v)` без контекста тогда выбрасывает `InvalidOperationException: Reflection-based serialization has been disabled for this application`. Либо используйте контекст, либо для быстрого эксперимента добавьте `#:property JsonSerializerIsReflectionEnabledByDefault=true`. Подробности в статье [об отключении сериализации на основе рефлексии в System.Text.Json](/ru/2023/10/system-text-json-disable-reflection-based-serialization/).

## Подводные камни: NaN, точность, регистр и векторы в стиле Unity

**NaN и бесконечность выбрасывают исключение.** Шаг физики с делением на ноль дает компоненты `NaN`, а `Utf8JsonWriter` отказывается их записывать:

```csharp
// .NET 10.0.10
JsonSerializer.Serialize(new Vector3(float.NaN, 0, 0), new JsonSerializerOptions { IncludeFields = true });
// ArgumentException: .NET number values such as positive and negative infinity
// cannot be written as valid JSON.
```

`NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals` записывает их строками: `{"X":"NaN","Y":"Infinity","Z":0}`. Лучше ли это, чем ошибка, зависит от того, кто читает JSON; `JSON.parse` в JavaScript вернет строку `"NaN"`, а не число.

**Float при обратном чтении сохраняются в кратчайшем представлении.** `new Vector3(0.1f, 1f/3f, 1e-8f)` сериализуется как `{"X":0.1,"Y":0.33333334,"Z":1E-08}`. System.Text.Json записывает кратчайшую строку, которая при чтении дает тот же `float`, поэтому потери точности нет, но потребитель, разбирающий значение в `double`, увидит `0.33333334`, а не `1/3`.

**Политики именования применяются к полям.** `JsonSerializerDefaults.Web` вместе с `IncludeFields = true` записывает `{"x":1,"y":2.5,"z":-3}`, а читает любой регистр, потому что настройки Web нечувствительны к регистру. Если клиент на JavaScript ожидает `X` в верхнем регистре, не используйте настройки Web для этого payload.

**Векторы в стиле Unity падают с ошибкой цикла.** `UnityEngine.Vector3` тоже хранит `x`, `y`, `z` в полях, но у него также есть вычисляемые свойства вроде `normalized`, которые возвращают другой `Vector3`. Структура такой формы, сериализуемая с `IncludeFields` или без него, падает, потому что у `normalized` есть свой `normalized`, и так до бесконечности:

```text
JsonException: A possible object cycle was detected. This can either be due to a cycle
or if the object depth is larger than the maximum allowed depth of 64.
Path: $.normalized.normalized.no...
```

`ReferenceHandler.IgnoreCycles` не помогает, поскольку в структуре нет ссылок, которые можно отслеживать; каждый `normalized` - новое значение. `IgnoreReadOnlyProperties = true` вместе с `IncludeFields = true` исправили это в моем тесте и дали `{"x":3,"y":0,"z":4}`, который корректно прошел обратное чтение. Я тестировал на структуре, повторяющей форму Unity (поля плюс свойства только для чтения `magnitude`, `sqrMagnitude` и `normalized`), а не внутри редактора Unity, у которого свой сериализатор. Подробнее об этом исключении в статье [об исправлении "A possible object cycle was detected"](/ru/2026/05/fix-possible-object-cycle-was-detected-system-text-json/).

## Какое исправление выбрать

1. Добавьте `IncludeFields = true` и `IgnoreReadOnlyProperties = true` в настройки (или в `JsonSourceGenerationOptions`), если вы сериализуете `Vector2`, `Vector3`, `Vector4`, `Quaternion` или `Plane` и вас устраивают объекты вида `{"X":..,"Y":..}`.
2. Включите `UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow` в тестах, чтобы будущий тип с той же проблемой полей падал, а не десериализовался в нули.
3. Напишите `JsonConverter<T>` для `Matrix4x4`, а также для векторов, если важен размер payload или спецификация (glTF, GeoJSON) требует массивов.
4. Используйте модификатор `DefaultJsonTypeInfoResolver`, когда `IncludeFields` должен оставаться включенным, но конкретное свойство нужно убрать, не меняя сериализацию ваших собственных типов.

Если вы переходите с `BinaryFormatter`, который сериализовал эти структуры поле за полем без лишних вопросов, то же решение про `IncludeFields` встречается в [руководстве по миграции с BinaryFormatter](/ru/2026/09/migrate-off-binaryformatter-after-its-removal-in-modern-dotnet/).

## Связанные статьи

- [Как написать собственный JsonConverter в System.Text.Json](/ru/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/)
- [Как заставить System.Text.Json игнорировать свойство с модификатором required](/ru/2026/08/how-to-make-system-text-json-ignore-a-property-with-the-required-modifier/)
- [Исправление "A possible object cycle was detected" в System.Text.Json](/ru/2026/05/fix-possible-object-cycle-was-detected-system-text-json/)
- [.NET 8: включение непубличных членов в JSON-сериализацию](/ru/2023/09/net-8-include-non-public-members-in-json-serialization/)
- [System.Text.Json: модификация существующего type info resolver](/ru/2023/10/system-text-json-how-to-modify-existing-type-info-resolver/)

## Источники

- [Include fields in serialization](https://learn.microsoft.com/dotnet/standard/serialization/system-text-json/fields), Microsoft Learn
- [`JsonSerializerOptions.IncludeFields`](https://learn.microsoft.com/dotnet/api/system.text.json.jsonserializeroptions.includefields) и [`IgnoreReadOnlyProperties`](https://learn.microsoft.com/dotnet/api/system.text.json.jsonserializeroptions.ignorereadonlyproperties)
- [Свойство `Matrix4x4.X`](https://learn.microsoft.com/dotnet/api/system.numerics.matrix4x4.x), применимо к .NET 10 и .NET 11
- [Customize a JSON contract](https://learn.microsoft.com/dotnet/standard/serialization/system-text-json/custom-contracts), Microsoft Learn
- [`JsonNumberHandling`](https://learn.microsoft.com/dotnet/api/system.text.json.serialization.jsonnumberhandling)
