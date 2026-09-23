---
title: "How to serialize public fields like Vector3 and Quaternion with System.Text.Json"
description: "System.Text.Json writes Vector3 as {} and Quaternion as {\"IsIdentity\":false} because they store data in public fields. Here is how IncludeFields, a custom converter, a resolver modifier and source generation fix it, measured on .NET 10 and .NET 11 RC 1."
pubDate: 2026-09-23
template: how-to
tags:
  - "system-text-json"
  - "csharp"
  - "dotnet-10"
  - "dotnet-11"
  - "serialization"
  - "json"
---

**Short answer:** `System.Numerics.Vector3`, `Vector2`, `Vector4`, `Quaternion`, `Plane` and `Matrix4x4` keep their data in public *fields*, and System.Text.Json ignores fields by default. So `JsonSerializer.Serialize(new Vector3(1, 2.5f, -3))` returns `{}`, and deserializing `{"X":1,"Y":2,"Z":3}` silently gives you `<0, 0, 0>`. Set `IncludeFields = true` on `JsonSerializerOptions` (or `[JsonSourceGenerationOptions(IncludeFields = true)]` on a source-generated context) and add `IgnoreReadOnlyProperties = true` so `Quaternion.IsIdentity` stops leaking into the output. If you want a compact `[x, y, z]` shape, or you serialize `Matrix4x4`, write a `JsonConverter<T>` instead.

Every output in this post was captured by running the same file-based probe on .NET 10.0.10 (SDK 10.0.302) and on .NET 11.0.0 RC 1 (SDK 11.0.100-rc.1.26425.128). The two runtimes produced byte-identical output, so nothing here changes in .NET 11. The field-handling APIs (`IncludeFields`, `[JsonInclude]`) have existed since .NET 5; the `Matrix4x4.X/Y/Z/W` row properties that make matrix output noisier are new in .NET 10.

## Why System.Text.Json writes an empty object for Vector3

System.Text.Json builds a contract for each type from its public instance **properties**. Public fields are only considered when you opt in. That default is documented on the [Include fields in serialization](https://learn.microsoft.com/dotnet/standard/serialization/system-text-json/fields) page, and it is the opposite of what Newtonsoft.Json did, which is why this bites people during a migration.

The `System.Numerics` types were designed for SIMD and interop, not for serialization. Their components are plain mutable fields:

```csharp
// Shape of the types in System.Numerics (.NET 10), simplified
public struct Vector3    { public float X; public float Y; public float Z; }
public struct Quaternion { public float X; public float Y; public float Z; public float W;
                           public bool IsIdentity { get; } }
public struct Plane      { public Vector3 Normal; public float D; }
```

`Vector3` has no public instance properties the serializer can use, so its contract is empty. `Quaternion` has exactly one public instance property, the computed `IsIdentity`, so that is the only thing that gets written. Nothing throws, nothing warns.

## The minimal repro

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

The deserialization line is the dangerous one. The JSON clearly contains `X`, `Y` and `Z`, but since the contract has no members with those names, the serializer treats them as unmapped and skips them. You get `Vector3.Zero` and a green test if your test only checks that deserialization did not throw.

If you want this class of bug to fail loudly, turn on `UnmappedMemberHandling`:

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

That setting has been around since .NET 8 and is covered in more depth in [handling missing and unmapped members during deserialization](/2023/09/net-8-handle-missing-members-during-json-deserialization/).

## Fix 1: IncludeFields on JsonSerializerOptions

This is the one-line fix and it is the right one for most apps:

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

Why `IgnoreReadOnlyProperties` as well? With `IncludeFields = true` alone, `Quaternion` serializes as:

```json
{"IsIdentity":false,"X":0,"Y":0.24740396,"Z":0,"W":0.9689124}
```

`IsIdentity` is derived data. It costs bytes on every rotation you write, and any client reading your JSON now sees a field that looks writable but is ignored on the way back in. `IgnoreReadOnlyProperties` drops get-only properties from the output, which removes `IsIdentity` and keeps all four components. It does not touch fields, so it is safe to combine.

Deserialization works because these are structs: System.Text.Json creates a default instance and assigns the fields, it does not need the `Vector3(float, float, float)` constructor. A missing component stays `0`, so `{"X":1}` becomes `<1, 0, 0>`.

Two things to know about `IncludeFields`:

- **It is global.** Every type in the graph now has its public fields serialized. If some of your own DTOs have public fields you did not intend to expose, they appear in the output too. Grep for `public` fields in your serialized types before flipping it on in a shared options instance.
- **It changes `required` behaviour.** A `required` public field is invisible to System.Text.Json until fields are included, after which a payload that omits it starts throwing. I measured that in the post on [ignoring properties that have the `required` modifier](/2026/08/how-to-make-system-text-json-ignore-a-property-with-the-required-modifier/).

### Why [JsonInclude] does not help here

The per-member alternative to `IncludeFields` is `[JsonInclude]`, but it goes on the *field*, and you do not own `System.Numerics.Vector3`. Putting it on your own member that has type `Vector3` does nothing for the fields inside it:

```csharp
// .NET 10.0.10
public class Holder
{
    [JsonInclude] public Vector3 Pos = new(1, 2, 3);
}

JsonSerializer.Serialize(new Holder());
// {"Pos":{}}
```

`[JsonInclude]` made `Pos` itself part of the `Holder` contract. The `Vector3` contract is still empty.

## Fix 2: a JsonConverter for a compact array shape

Named components are readable, but a scene file or a telemetry stream with thousands of positions pays for `"X":`, `"Y":`, `"Z":` on every one. glTF and GeoJSON both use arrays for vectors. A converter gives you that shape and makes the choice independent of any global option:

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

Register it on the options or with `[JsonConverter(typeof(Vector3ArrayConverter))]` on the property:

```csharp
// .NET 10.0.10
var options = new JsonSerializerOptions { Converters = { new Vector3ArrayConverter() } };

JsonSerializer.Serialize(new Vector3(1f, 2.5f, -3f), options);  // [1,2.5,-3]
JsonSerializer.Deserialize<Vector3>("[1,2,3]", options);         // <1. 2. 3>
JsonSerializer.Deserialize<Vector3>("[1,2]", options);           // JsonException: Expected [x, y, z].
```

A converter only covers the type it is registered for. In the `Transform` repro above, this options instance writes `{"Position":[1,2.5,-3],"Rotation":{"IsIdentity":false}}`: the position is fixed, the rotation is still broken. Write one converter per type you use (a `Quaternion` version is the same code with four components), or combine the converter with `IncludeFields = true` for the rest. For the reader/writer mechanics, including why you must leave the reader on the last token you consumed, see [how to write a custom JsonConverter in System.Text.Json](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/).

## Fix 3: Matrix4x4 needs a converter, not IncludeFields

`Matrix4x4` is where `IncludeFields` falls apart on .NET 10 and later. The struct has 16 public fields `M11` to `M44`, and .NET 10 added read-write row properties `X`, `Y`, `Z` and `W` (each a `Vector4`) on top of the existing read-write `Translation` property. Since those have setters, `IgnoreReadOnlyProperties` does not remove them. The result for `Matrix4x4.CreateTranslation(1, 2, 3)` with `IncludeFields = true`:

```json
{"IsIdentity":false,"Translation":{"X":1,"Y":2,"Z":3},
 "X":{"X":1,"Y":0,"Z":0,"W":0},"Y":{"X":0,"Y":1,"Z":0,"W":0},
 "Z":{"X":0,"Y":0,"Z":1,"W":0},"W":{"X":1,"Y":2,"Z":3,"W":1},
 "M11":1,"M12":0,"M13":0,"M14":0,"M21":0,"M22":1,"M23":0,"M24":0,
 "M31":0,"M32":0,"M33":1,"M34":0,"M41":1,"M42":2,"M43":3,"M44":1}
```

Every value is written twice, `M41` to `M43` three times. It round-trips, but on deserialization the members are applied in the order they appear in the JSON and the last writer wins. I verified it: `{"M41":9,"W":{"X":1,"Y":2,"Z":3,"W":1}}` produces `M41 == 1`, and the same members in the opposite order produce `M41 == 9`. A client that edits one representation and not the other gets a matrix that depends on key order. Also note that a partial payload such as `{"M11":1}` yields a matrix with zeros everywhere else, not `Matrix4x4.Identity`, because the starting value is `default`.

For matrices, write a converter that emits the 16 `M` fields as a flat array in row-major order, the same pattern as `Vector3ArrayConverter` with a 16-element loop. It is less code than defending against the duplicated shape.

## Fix 4: strip members with a resolver modifier

If you want named components (the Fix 1 shape) but need precise control, for example you cannot use `IgnoreReadOnlyProperties` because your own DTOs rely on get-only properties being written, customize the contract for just the numerics types:

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

This is the same technique as [modifying an existing type info resolver](/2023/10/system-text-json-how-to-modify-existing-type-info-resolver/). The type-level scope is the win: your own types keep their default contract. Note that on .NET 10+ this still leaves `Matrix4x4`'s `X/Y/Z/W` rows in place, which is another argument for the matrix converter.

## Source generation and Native AOT

If you use a `JsonSerializerContext` (required for Native AOT and trimmed apps), the switch lives on the context instead of the options:

```csharp
// .NET 10.0.10 and .NET 11.0.0 RC 1
[JsonSourceGenerationOptions(IncludeFields = true, IgnoreReadOnlyProperties = true)]
[JsonSerializable(typeof(Transform))]
internal partial class SceneContext : JsonSerializerContext;

JsonSerializer.Serialize(new Transform { Position = v, Rotation = q },
    SceneContext.Default.Transform);
// {"Position":{"X":1,"Y":2.5,"Z":-3},"Rotation":{"X":0,"Y":0.24740396,"Z":0,"W":0.9689124}}
```

A context without `IncludeFields = true` generates the same empty contract you saw in the repro: `{}` for `Vector3`, measured. Custom converters work with source generation too; add them with `[JsonSourceGenerationOptions(Converters = [typeof(Vector3ArrayConverter)])]`.

One trap I hit while building the probe: .NET 10 file-based apps (`dotnet run probe.cs`) default to `PublishAot=true`, which disables reflection-based serialization. Calling `JsonSerializer.Serialize(v)` without a context then throws `InvalidOperationException: Reflection-based serialization has been disabled for this application`. Either use a context, or add `#:property JsonSerializerIsReflectionEnabledByDefault=true` for a quick experiment. The background is in [disabling reflection-based serialization in System.Text.Json](/2023/10/system-text-json-disable-reflection-based-serialization/).

## Gotchas: NaN, precision, casing, and Unity-style vectors

**NaN and infinity throw.** A physics step that divides by zero produces `NaN` components, and `Utf8JsonWriter` refuses them:

```csharp
// .NET 10.0.10
JsonSerializer.Serialize(new Vector3(float.NaN, 0, 0), new JsonSerializerOptions { IncludeFields = true });
// ArgumentException: .NET number values such as positive and negative infinity
// cannot be written as valid JSON.
```

`NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals` writes them as strings, `{"X":"NaN","Y":"Infinity","Z":0}`. Whether that is better than failing depends on who reads the JSON; JavaScript's `JSON.parse` gives you the string `"NaN"`, not a number.

**Floats round-trip as the shortest representation.** `new Vector3(0.1f, 1f/3f, 1e-8f)` serializes as `{"X":0.1,"Y":0.33333334,"Z":1E-08}`. System.Text.Json writes the shortest string that round-trips to the same `float`, so there is no precision loss, but a consumer that parses into `double` sees `0.33333334`, not `1/3`.

**Naming policies apply to fields.** `JsonSerializerDefaults.Web` plus `IncludeFields = true` writes `{"x":1,"y":2.5,"z":-3}`, and reads either casing because Web defaults are case-insensitive. If a JavaScript client expects uppercase `X`, do not use the Web defaults for this payload.

**Unity-style vectors blow up with a cycle error.** `UnityEngine.Vector3` stores `x`, `y`, `z` in fields too, but it also has computed properties such as `normalized` that return another `Vector3`. A struct with that shape, serialized with or without `IncludeFields`, fails because `normalized` has its own `normalized`, forever:

```text
JsonException: A possible object cycle was detected. This can either be due to a cycle
or if the object depth is larger than the maximum allowed depth of 64.
Path: $.normalized.normalized.no...
```

`ReferenceHandler.IgnoreCycles` does not help, since there are no references to track in a struct; each `normalized` is a fresh value. `IgnoreReadOnlyProperties = true` with `IncludeFields = true` fixed it in my test and gave `{"x":3,"y":0,"z":4}`, which round-tripped. I tested with a struct shaped like Unity's (fields plus get-only `magnitude`, `sqrMagnitude` and `normalized`), not inside the Unity editor, which ships its own serializer. More on this exception in [fixing "A possible object cycle was detected"](/2026/05/fix-possible-object-cycle-was-detected-system-text-json/).

## Which fix to pick

1. Add `IncludeFields = true` and `IgnoreReadOnlyProperties = true` to your options (or to your `JsonSourceGenerationOptions`) if you serialize `Vector2`, `Vector3`, `Vector4`, `Quaternion` or `Plane` and you are fine with `{"X":..,"Y":..}` objects.
2. Turn on `UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow` in tests, so a future type with the same field problem fails instead of deserializing as zeros.
3. Write a `JsonConverter<T>` for `Matrix4x4`, and for vectors too if payload size matters or a spec (glTF, GeoJSON) dictates arrays.
4. Use a `DefaultJsonTypeInfoResolver` modifier when `IncludeFields` must stay on but a specific property has to go, without changing how your own types serialize.

If you are coming from `BinaryFormatter`, which serialized these structs field by field without asking, the same `IncludeFields` decision shows up in the [BinaryFormatter migration guide](/2026/09/migrate-off-binaryformatter-after-its-removal-in-modern-dotnet/).

## Related

- [How to write a custom JsonConverter in System.Text.Json](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/)
- [How to make System.Text.Json ignore a property that has the required modifier](/2026/08/how-to-make-system-text-json-ignore-a-property-with-the-required-modifier/)
- [Fix "A possible object cycle was detected" in System.Text.Json](/2026/05/fix-possible-object-cycle-was-detected-system-text-json/)
- [.NET 8: include non-public members in JSON serialization](/2023/09/net-8-include-non-public-members-in-json-serialization/)
- [System.Text.Json: modify an existing type info resolver](/2023/10/system-text-json-how-to-modify-existing-type-info-resolver/)

## Sources

- [Include fields in serialization](https://learn.microsoft.com/dotnet/standard/serialization/system-text-json/fields), Microsoft Learn
- [`JsonSerializerOptions.IncludeFields`](https://learn.microsoft.com/dotnet/api/system.text.json.jsonserializeroptions.includefields) and [`IgnoreReadOnlyProperties`](https://learn.microsoft.com/dotnet/api/system.text.json.jsonserializeroptions.ignorereadonlyproperties)
- [`Matrix4x4.X` property](https://learn.microsoft.com/dotnet/api/system.numerics.matrix4x4.x), applies to .NET 10 and .NET 11
- [Customize a JSON contract](https://learn.microsoft.com/dotnet/standard/serialization/system-text-json/custom-contracts), Microsoft Learn
- [`JsonNumberHandling`](https://learn.microsoft.com/dotnet/api/system.text.json.serialization.jsonnumberhandling)
