---
title: "Cómo serializar campos públicos como Vector3 y Quaternion con System.Text.Json"
description: "System.Text.Json escribe Vector3 como {} y Quaternion como {\"IsIdentity\":false} porque guardan sus datos en campos públicos. Así lo solucionan IncludeFields, un converter personalizado, un modificador del resolver y la generación de código fuente, medido en .NET 10 y .NET 11 RC 1."
pubDate: 2026-09-23
template: how-to
tags:
  - "system-text-json"
  - "csharp"
  - "dotnet-10"
  - "dotnet-11"
  - "serialization"
  - "json"
lang: "es"
translationOf: "2026/09/how-to-serialize-vector3-and-quaternion-with-system-text-json"
translatedBy: "claude"
translationDate: 2026-09-23
---

**Respuesta corta:** `System.Numerics.Vector3`, `Vector2`, `Vector4`, `Quaternion`, `Plane` y `Matrix4x4` guardan sus datos en *campos* públicos, y System.Text.Json ignora los campos por defecto. Por eso `JsonSerializer.Serialize(new Vector3(1, 2.5f, -3))` devuelve `{}`, y deserializar `{"X":1,"Y":2,"Z":3}` te da `<0, 0, 0>` sin ningún aviso. Configura `IncludeFields = true` en `JsonSerializerOptions` (o `[JsonSourceGenerationOptions(IncludeFields = true)]` en un contexto generado por código fuente) y agrega `IgnoreReadOnlyProperties = true` para que `Quaternion.IsIdentity` deje de colarse en la salida. Si quieres una forma compacta `[x, y, z]`, o serializas `Matrix4x4`, escribe un `JsonConverter<T>` en su lugar.

Cada salida de este artículo se obtuvo ejecutando la misma prueba basada en archivo en .NET 10.0.10 (SDK 10.0.302) y en .NET 11.0.0 RC 1 (SDK 11.0.100-rc.1.26425.128). Los dos runtimes produjeron una salida idéntica byte a byte, así que nada de esto cambia en .NET 11. Las API de manejo de campos (`IncludeFields`, `[JsonInclude]`) existen desde .NET 5; las propiedades de fila `Matrix4x4.X/Y/Z/W`, que hacen más ruidosa la salida de las matrices, son nuevas en .NET 10.

## Por qué System.Text.Json escribe un objeto vacío para Vector3

System.Text.Json construye un contrato para cada tipo a partir de sus **propiedades** públicas de instancia. Los campos públicos solo se tienen en cuenta si lo activas explícitamente. Ese comportamiento por defecto está documentado en la página [Include fields in serialization](https://learn.microsoft.com/dotnet/standard/serialization/system-text-json/fields), y es lo contrario de lo que hacía Newtonsoft.Json, razón por la cual sorprende a la gente durante una migración.

Los tipos de `System.Numerics` se diseñaron para SIMD e interoperabilidad, no para serialización. Sus componentes son simples campos mutables:

```csharp
// Shape of the types in System.Numerics (.NET 10), simplified
public struct Vector3    { public float X; public float Y; public float Z; }
public struct Quaternion { public float X; public float Y; public float Z; public float W;
                           public bool IsIdentity { get; } }
public struct Plane      { public Vector3 Normal; public float D; }
```

`Vector3` no tiene propiedades públicas de instancia que el serializador pueda usar, así que su contrato está vacío. `Quaternion` tiene exactamente una propiedad pública de instancia, la calculada `IsIdentity`, así que es lo único que se escribe. Nada lanza una excepción, nada advierte.

## La reproducción mínima

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

La línea de deserialización es la peligrosa. El JSON contiene claramente `X`, `Y` y `Z`, pero como el contrato no tiene miembros con esos nombres, el serializador los trata como no mapeados y los omite. Obtienes `Vector3.Zero` y una prueba en verde si tu prueba solo verifica que la deserialización no lanzó una excepción.

Si quieres que este tipo de bug falle de forma ruidosa, activa `UnmappedMemberHandling`:

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

Esa configuración existe desde .NET 8 y se trata con más detalle en [manejar miembros faltantes y no mapeados durante la deserialización](/es/2023/09/net-8-handle-missing-members-during-json-deserialization/).

## Solución 1: IncludeFields en JsonSerializerOptions

Esta es la solución de una línea y es la correcta para la mayoría de las aplicaciones:

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

¿Por qué también `IgnoreReadOnlyProperties`? Solo con `IncludeFields = true`, `Quaternion` se serializa así:

```json
{"IsIdentity":false,"X":0,"Y":0.24740396,"Z":0,"W":0.9689124}
```

`IsIdentity` es un dato derivado. Cuesta bytes en cada rotación que escribes, y cualquier cliente que lea tu JSON ve ahora un campo que parece modificable pero que se ignora al deserializar. `IgnoreReadOnlyProperties` quita de la salida las propiedades de solo lectura, lo que elimina `IsIdentity` y conserva los cuatro componentes. No afecta a los campos, así que es seguro combinarlas.

La deserialización funciona porque son structs: System.Text.Json crea una instancia por defecto y asigna los campos, no necesita el constructor `Vector3(float, float, float)`. Un componente faltante se queda en `0`, así que `{"X":1}` se convierte en `<1, 0, 0>`.

Dos cosas que debes saber sobre `IncludeFields`:

- **Es global.** Todos los tipos del grafo pasan a serializar sus campos públicos. Si algunos de tus propios DTO tienen campos públicos que no pretendías exponer, también aparecen en la salida. Busca campos `public` en tus tipos serializados antes de activarlo en una instancia de opciones compartida.
- **Cambia el comportamiento de `required`.** Un campo público `required` es invisible para System.Text.Json hasta que se incluyen los campos; a partir de ese momento, un payload que lo omite empieza a lanzar excepciones. Lo medí en el artículo sobre [ignorar propiedades que tienen el modificador `required`](/es/2026/08/how-to-make-system-text-json-ignore-a-property-with-the-required-modifier/).

### Por qué [JsonInclude] no ayuda aquí

La alternativa por miembro a `IncludeFields` es `[JsonInclude]`, pero se coloca en el *campo*, y `System.Numerics.Vector3` no es tuyo. Ponerlo en tu propio miembro de tipo `Vector3` no hace nada por los campos que contiene:

```csharp
// .NET 10.0.10
public class Holder
{
    [JsonInclude] public Vector3 Pos = new(1, 2, 3);
}

JsonSerializer.Serialize(new Holder());
// {"Pos":{}}
```

`[JsonInclude]` hizo que `Pos` formara parte del contrato de `Holder`. El contrato de `Vector3` sigue vacío.

## Solución 2: un JsonConverter para una forma de arreglo compacta

Los componentes con nombre son legibles, pero un archivo de escena o un flujo de telemetría con miles de posiciones paga por `"X":`, `"Y":`, `"Z":` en cada una. Tanto glTF como GeoJSON usan arreglos para los vectores. Un converter te da esa forma y hace que la decisión sea independiente de cualquier opción global:

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

Regístralo en las opciones o con `[JsonConverter(typeof(Vector3ArrayConverter))]` en la propiedad:

```csharp
// .NET 10.0.10
var options = new JsonSerializerOptions { Converters = { new Vector3ArrayConverter() } };

JsonSerializer.Serialize(new Vector3(1f, 2.5f, -3f), options);  // [1,2.5,-3]
JsonSerializer.Deserialize<Vector3>("[1,2,3]", options);         // <1. 2. 3>
JsonSerializer.Deserialize<Vector3>("[1,2]", options);           // JsonException: Expected [x, y, z].
```

Un converter solo cubre el tipo para el que está registrado. En la reproducción de `Transform` de arriba, esta instancia de opciones escribe `{"Position":[1,2.5,-3],"Rotation":{"IsIdentity":false}}`: la posición queda arreglada, la rotación sigue rota. Escribe un converter por cada tipo que uses (una versión para `Quaternion` es el mismo código con cuatro componentes), o combina el converter con `IncludeFields = true` para el resto. Para la mecánica del reader y el writer, incluido por qué debes dejar el reader en el último token que consumiste, consulta [cómo escribir un JsonConverter personalizado en System.Text.Json](/es/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/).

## Solución 3: Matrix4x4 necesita un converter, no IncludeFields

`Matrix4x4` es donde `IncludeFields` se viene abajo en .NET 10 y posteriores. El struct tiene 16 campos públicos, de `M11` a `M44`, y .NET 10 agregó las propiedades de fila de lectura y escritura `X`, `Y`, `Z` y `W` (cada una un `Vector4`) además de la propiedad de lectura y escritura `Translation` que ya existía. Como tienen setters, `IgnoreReadOnlyProperties` no las elimina. El resultado para `Matrix4x4.CreateTranslation(1, 2, 3)` con `IncludeFields = true`:

```json
{"IsIdentity":false,"Translation":{"X":1,"Y":2,"Z":3},
 "X":{"X":1,"Y":0,"Z":0,"W":0},"Y":{"X":0,"Y":1,"Z":0,"W":0},
 "Z":{"X":0,"Y":0,"Z":1,"W":0},"W":{"X":1,"Y":2,"Z":3,"W":1},
 "M11":1,"M12":0,"M13":0,"M14":0,"M21":0,"M22":1,"M23":0,"M24":0,
 "M31":0,"M32":0,"M33":1,"M34":0,"M41":1,"M42":2,"M43":3,"M44":1}
```

Cada valor se escribe dos veces, y de `M41` a `M43` tres veces. Hace el viaje de ida y vuelta, pero al deserializar los miembros se aplican en el orden en que aparecen en el JSON y gana el último que escribe. Lo verifiqué: `{"M41":9,"W":{"X":1,"Y":2,"Z":3,"W":1}}` produce `M41 == 1`, y los mismos miembros en el orden opuesto producen `M41 == 9`. Un cliente que edita una representación y no la otra obtiene una matriz que depende del orden de las claves. Ten en cuenta también que un payload parcial como `{"M11":1}` da una matriz con ceros en todo lo demás, no `Matrix4x4.Identity`, porque el valor inicial es `default`.

Para las matrices, escribe un converter que emita los 16 campos `M` como un arreglo plano en orden por filas, con el mismo patrón que `Vector3ArrayConverter` y un bucle de 16 elementos. Es menos código que defenderse de la forma duplicada.

## Solución 4: quitar miembros con un modificador del resolver

Si quieres componentes con nombre (la forma de la Solución 1) pero necesitas un control preciso, por ejemplo porque no puedes usar `IgnoreReadOnlyProperties` ya que tus propios DTO dependen de que se escriban las propiedades de solo lectura, personaliza el contrato solo para los tipos numéricos:

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

Es la misma técnica que [modificar un type info resolver existente](/es/2023/10/system-text-json-how-to-modify-existing-type-info-resolver/). La ventaja es el alcance a nivel de tipo: tus propios tipos conservan su contrato por defecto. Ten en cuenta que en .NET 10+ esto sigue dejando las filas `X/Y/Z/W` de `Matrix4x4`, lo que es otro argumento a favor del converter para matrices.

## Generación de código fuente y Native AOT

Si usas un `JsonSerializerContext` (obligatorio para Native AOT y aplicaciones recortadas con trimming), la opción va en el contexto en lugar de en las opciones:

```csharp
// .NET 10.0.10 and .NET 11.0.0 RC 1
[JsonSourceGenerationOptions(IncludeFields = true, IgnoreReadOnlyProperties = true)]
[JsonSerializable(typeof(Transform))]
internal partial class SceneContext : JsonSerializerContext;

JsonSerializer.Serialize(new Transform { Position = v, Rotation = q },
    SceneContext.Default.Transform);
// {"Position":{"X":1,"Y":2.5,"Z":-3},"Rotation":{"X":0,"Y":0.24740396,"Z":0,"W":0.9689124}}
```

Un contexto sin `IncludeFields = true` genera el mismo contrato vacío que viste en la reproducción: `{}` para `Vector3`, medido. Los converters personalizados también funcionan con la generación de código fuente; agrégalos con `[JsonSourceGenerationOptions(Converters = [typeof(Vector3ArrayConverter)])]`.

Una trampa con la que me topé al construir la prueba: las aplicaciones basadas en archivo de .NET 10 (`dotnet run probe.cs`) usan `PublishAot=true` por defecto, lo que desactiva la serialización basada en reflexión. Llamar a `JsonSerializer.Serialize(v)` sin un contexto lanza entonces `InvalidOperationException: Reflection-based serialization has been disabled for this application`. Usa un contexto, o agrega `#:property JsonSerializerIsReflectionEnabledByDefault=true` para un experimento rápido. El contexto está en [desactivar la serialización basada en reflexión en System.Text.Json](/es/2023/10/system-text-json-disable-reflection-based-serialization/).

## Trampas: NaN, precisión, mayúsculas y vectores al estilo de Unity

**NaN e infinito lanzan excepciones.** Un paso de física que divide entre cero produce componentes `NaN`, y `Utf8JsonWriter` los rechaza:

```csharp
// .NET 10.0.10
JsonSerializer.Serialize(new Vector3(float.NaN, 0, 0), new JsonSerializerOptions { IncludeFields = true });
// ArgumentException: .NET number values such as positive and negative infinity
// cannot be written as valid JSON.
```

`NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals` los escribe como cadenas, `{"X":"NaN","Y":"Infinity","Z":0}`. Que eso sea mejor que fallar depende de quién lea el JSON; `JSON.parse` de JavaScript te da la cadena `"NaN"`, no un número.

**Los float hacen el viaje de ida y vuelta con la representación más corta.** `new Vector3(0.1f, 1f/3f, 1e-8f)` se serializa como `{"X":0.1,"Y":0.33333334,"Z":1E-08}`. System.Text.Json escribe la cadena más corta que vuelve al mismo `float`, así que no hay pérdida de precisión, pero un consumidor que la parsea como `double` ve `0.33333334`, no `1/3`.

**Las políticas de nombres se aplican a los campos.** `JsonSerializerDefaults.Web` más `IncludeFields = true` escribe `{"x":1,"y":2.5,"z":-3}`, y lee cualquiera de las dos variantes porque los valores por defecto de Web no distinguen mayúsculas de minúsculas. Si un cliente JavaScript espera `X` en mayúscula, no uses los valores por defecto de Web para este payload.

**Los vectores al estilo de Unity revientan con un error de ciclo.** `UnityEngine.Vector3` también guarda `x`, `y`, `z` en campos, pero además tiene propiedades calculadas como `normalized` que devuelven otro `Vector3`. Un struct con esa forma, serializado con o sin `IncludeFields`, falla porque `normalized` tiene su propio `normalized`, indefinidamente:

```text
JsonException: A possible object cycle was detected. This can either be due to a cycle
or if the object depth is larger than the maximum allowed depth of 64.
Path: $.normalized.normalized.no...
```

`ReferenceHandler.IgnoreCycles` no ayuda, ya que en un struct no hay referencias que rastrear; cada `normalized` es un valor nuevo. `IgnoreReadOnlyProperties = true` con `IncludeFields = true` lo resolvió en mi prueba y dio `{"x":3,"y":0,"z":4}`, que hizo el viaje de ida y vuelta. Lo probé con un struct con la forma del de Unity (campos más `magnitude`, `sqrMagnitude` y `normalized` de solo lectura), no dentro del editor de Unity, que trae su propio serializador. Más sobre esta excepción en [solucionar "A possible object cycle was detected"](/es/2026/05/fix-possible-object-cycle-was-detected-system-text-json/).

## Qué solución elegir

1. Agrega `IncludeFields = true` e `IgnoreReadOnlyProperties = true` a tus opciones (o a tus `JsonSourceGenerationOptions`) si serializas `Vector2`, `Vector3`, `Vector4`, `Quaternion` o `Plane` y te sirven objetos `{"X":..,"Y":..}`.
2. Activa `UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow` en las pruebas, para que un tipo futuro con el mismo problema de campos falle en lugar de deserializarse como ceros.
3. Escribe un `JsonConverter<T>` para `Matrix4x4`, y también para los vectores si importa el tamaño del payload o si una especificación (glTF, GeoJSON) exige arreglos.
4. Usa un modificador de `DefaultJsonTypeInfoResolver` cuando `IncludeFields` tenga que seguir activado pero una propiedad concreta deba desaparecer, sin cambiar cómo se serializan tus propios tipos.

Si vienes de `BinaryFormatter`, que serializaba estos structs campo por campo sin preguntar, la misma decisión sobre `IncludeFields` aparece en la [guía de migración desde BinaryFormatter](/es/2026/09/migrate-off-binaryformatter-after-its-removal-in-modern-dotnet/).

## Relacionados

- [Cómo escribir un JsonConverter personalizado en System.Text.Json](/es/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/)
- [Cómo hacer que System.Text.Json ignore una propiedad que tiene el modificador required](/es/2026/08/how-to-make-system-text-json-ignore-a-property-with-the-required-modifier/)
- [Solucionar "A possible object cycle was detected" en System.Text.Json](/es/2026/05/fix-possible-object-cycle-was-detected-system-text-json/)
- [.NET 8: incluir miembros no públicos en la serialización JSON](/es/2023/09/net-8-include-non-public-members-in-json-serialization/)
- [System.Text.Json: modificar un type info resolver existente](/es/2023/10/system-text-json-how-to-modify-existing-type-info-resolver/)

## Fuentes

- [Include fields in serialization](https://learn.microsoft.com/dotnet/standard/serialization/system-text-json/fields), Microsoft Learn
- [`JsonSerializerOptions.IncludeFields`](https://learn.microsoft.com/dotnet/api/system.text.json.jsonserializeroptions.includefields) y [`IgnoreReadOnlyProperties`](https://learn.microsoft.com/dotnet/api/system.text.json.jsonserializeroptions.ignorereadonlyproperties)
- [Propiedad `Matrix4x4.X`](https://learn.microsoft.com/dotnet/api/system.numerics.matrix4x4.x), aplica a .NET 10 y .NET 11
- [Customize a JSON contract](https://learn.microsoft.com/dotnet/standard/serialization/system-text-json/custom-contracts), Microsoft Learn
- [`JsonNumberHandling`](https://learn.microsoft.com/dotnet/api/system.text.json.serialization.jsonnumberhandling)
