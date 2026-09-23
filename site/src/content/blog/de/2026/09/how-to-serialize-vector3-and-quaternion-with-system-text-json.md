---
title: "Öffentliche Felder wie Vector3 und Quaternion mit System.Text.Json serialisieren"
description: "System.Text.Json schreibt Vector3 als {} und Quaternion als {\"IsIdentity\":false}, weil beide ihre Daten in öffentlichen Feldern speichern. So beheben IncludeFields, ein eigener Converter, ein Resolver-Modifier und Source Generation das Problem, gemessen auf .NET 10 und .NET 11 RC 1."
pubDate: 2026-09-23
template: how-to
tags:
  - "system-text-json"
  - "csharp"
  - "dotnet-10"
  - "dotnet-11"
  - "serialization"
  - "json"
lang: "de"
translationOf: "2026/09/how-to-serialize-vector3-and-quaternion-with-system-text-json"
translatedBy: "claude"
translationDate: 2026-09-23
---

**Kurze Antwort:** `System.Numerics.Vector3`, `Vector2`, `Vector4`, `Quaternion`, `Plane` und `Matrix4x4` speichern ihre Daten in öffentlichen *Feldern*, und System.Text.Json ignoriert Felder standardmäßig. Deshalb liefert `JsonSerializer.Serialize(new Vector3(1, 2.5f, -3))` den Wert `{}`, und das Deserialisieren von `{"X":1,"Y":2,"Z":3}` ergibt stillschweigend `<0, 0, 0>`. Setzen Sie `IncludeFields = true` auf `JsonSerializerOptions` (oder `[JsonSourceGenerationOptions(IncludeFields = true)]` auf einem quellgenerierten Kontext) und ergänzen Sie `IgnoreReadOnlyProperties = true`, damit `Quaternion.IsIdentity` nicht mehr in der Ausgabe landet. Wenn Sie eine kompakte Form `[x, y, z]` möchten oder `Matrix4x4` serialisieren, schreiben Sie stattdessen einen `JsonConverter<T>`.

Jede Ausgabe in diesem Beitrag stammt aus demselben dateibasierten Testprogramm, ausgeführt auf .NET 10.0.10 (SDK 10.0.302) und auf .NET 11.0.0 RC 1 (SDK 11.0.100-rc.1.26425.128). Beide Laufzeiten erzeugten byte-identische Ausgaben, in .NET 11 ändert sich hier also nichts. Die APIs für Felder (`IncludeFields`, `[JsonInclude]`) gibt es seit .NET 5; die Zeileneigenschaften `Matrix4x4.X/Y/Z/W`, die die Matrixausgabe aufblähen, sind neu in .NET 10.

## Warum System.Text.Json für Vector3 ein leeres Objekt schreibt

System.Text.Json baut für jeden Typ einen Vertrag aus seinen öffentlichen Instanz-**Eigenschaften**. Öffentliche Felder werden nur berücksichtigt, wenn Sie das explizit aktivieren. Dieses Standardverhalten ist auf der Seite [Include fields in serialization](https://learn.microsoft.com/dotnet/standard/serialization/system-text-json/fields) dokumentiert, und es ist das Gegenteil dessen, was Newtonsoft.Json tat. Genau deshalb trifft es viele bei einer Migration.

Die `System.Numerics`-Typen wurden für SIMD und Interop entworfen, nicht für die Serialisierung. Ihre Komponenten sind einfache, veränderbare Felder:

```csharp
// Shape of the types in System.Numerics (.NET 10), simplified
public struct Vector3    { public float X; public float Y; public float Z; }
public struct Quaternion { public float X; public float Y; public float Z; public float W;
                           public bool IsIdentity { get; } }
public struct Plane      { public Vector3 Normal; public float D; }
```

`Vector3` hat keine öffentlichen Instanzeigenschaften, die der Serializer verwenden könnte, also ist sein Vertrag leer. `Quaternion` hat genau eine öffentliche Instanzeigenschaft, das berechnete `IsIdentity`, und das ist das Einzige, was geschrieben wird. Nichts wirft eine Ausnahme, nichts warnt.

## Die minimale Reproduktion

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

Die Deserialisierungszeile ist die gefährliche. Das JSON enthält eindeutig `X`, `Y` und `Z`, aber da der Vertrag keine Member mit diesen Namen hat, behandelt der Serializer sie als nicht zugeordnet und überspringt sie. Sie erhalten `Vector3.Zero` und einen grünen Test, falls Ihr Test nur prüft, dass die Deserialisierung keine Ausnahme geworfen hat.

Wenn diese Fehlerklasse laut scheitern soll, aktivieren Sie `UnmappedMemberHandling`:

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

Diese Einstellung gibt es seit .NET 8; ausführlicher behandelt sie der Beitrag zum [Umgang mit fehlenden und nicht zugeordneten Membern bei der Deserialisierung](/de/2023/09/net-8-handle-missing-members-during-json-deserialization/).

## Lösung 1: IncludeFields auf JsonSerializerOptions

Das ist die einzeilige Lösung, und für die meisten Anwendungen ist sie die richtige:

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

Warum zusätzlich `IgnoreReadOnlyProperties`? Mit `IncludeFields = true` allein wird `Quaternion` so serialisiert:

```json
{"IsIdentity":false,"X":0,"Y":0.24740396,"Z":0,"W":0.9689124}
```

`IsIdentity` ist abgeleitete Information. Es kostet bei jeder geschriebenen Rotation Bytes, und jeder Client, der Ihr JSON liest, sieht nun ein Feld, das beschreibbar wirkt, beim Einlesen aber ignoriert wird. `IgnoreReadOnlyProperties` entfernt Eigenschaften ohne Setter aus der Ausgabe, wodurch `IsIdentity` verschwindet und alle vier Komponenten erhalten bleiben. Felder berührt die Option nicht, die Kombination ist also sicher.

Die Deserialisierung funktioniert, weil es sich um Structs handelt: System.Text.Json erzeugt eine Standardinstanz und weist die Felder zu, der Konstruktor `Vector3(float, float, float)` wird nicht benötigt. Eine fehlende Komponente bleibt `0`, aus `{"X":1}` wird also `<1, 0, 0>`.

Zwei Dinge sollten Sie über `IncludeFields` wissen:

- **Die Option gilt global.** Jeder Typ im Objektgraphen wird nun mit seinen öffentlichen Feldern serialisiert. Haben einige Ihrer eigenen DTOs öffentliche Felder, die Sie nicht offenlegen wollten, erscheinen diese ebenfalls in der Ausgabe. Suchen Sie in Ihren serialisierten Typen nach `public`-Feldern, bevor Sie die Option in einer gemeinsam genutzten Options-Instanz aktivieren.
- **Sie ändert das Verhalten von `required`.** Ein `required`-Feld ist für System.Text.Json unsichtbar, bis Felder einbezogen werden; danach wirft ein Payload, dem es fehlt, plötzlich eine Ausnahme. Das habe ich im Beitrag zum [Ignorieren von Eigenschaften mit dem Modifizierer `required`](/de/2026/08/how-to-make-system-text-json-ignore-a-property-with-the-required-modifier/) gemessen.

### Warum [JsonInclude] hier nicht hilft

Die Alternative zu `IncludeFields` pro Member ist `[JsonInclude]`, aber das Attribut gehört auf das *Feld*, und `System.Numerics.Vector3` gehört nicht Ihnen. Setzen Sie es auf einen eigenen Member vom Typ `Vector3`, bewirkt das nichts für die Felder darin:

```csharp
// .NET 10.0.10
public class Holder
{
    [JsonInclude] public Vector3 Pos = new(1, 2, 3);
}

JsonSerializer.Serialize(new Holder());
// {"Pos":{}}
```

`[JsonInclude]` hat `Pos` selbst zum Teil des `Holder`-Vertrags gemacht. Der Vertrag von `Vector3` ist weiterhin leer.

## Lösung 2: ein JsonConverter für eine kompakte Array-Form

Benannte Komponenten sind gut lesbar, aber eine Szenendatei oder ein Telemetriestrom mit Tausenden von Positionen bezahlt bei jeder einzelnen für `"X":`, `"Y":`, `"Z":`. glTF und GeoJSON verwenden beide Arrays für Vektoren. Ein Converter liefert diese Form und macht die Entscheidung unabhängig von globalen Optionen:

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

Registrieren Sie ihn in den Optionen oder mit `[JsonConverter(typeof(Vector3ArrayConverter))]` an der Eigenschaft:

```csharp
// .NET 10.0.10
var options = new JsonSerializerOptions { Converters = { new Vector3ArrayConverter() } };

JsonSerializer.Serialize(new Vector3(1f, 2.5f, -3f), options);  // [1,2.5,-3]
JsonSerializer.Deserialize<Vector3>("[1,2,3]", options);         // <1. 2. 3>
JsonSerializer.Deserialize<Vector3>("[1,2]", options);           // JsonException: Expected [x, y, z].
```

Ein Converter deckt nur den Typ ab, für den er registriert ist. In der `Transform`-Reproduktion oben schreibt diese Options-Instanz `{"Position":[1,2.5,-3],"Rotation":{"IsIdentity":false}}`: Die Position ist korrigiert, die Rotation ist weiterhin kaputt. Schreiben Sie einen Converter pro verwendetem Typ (eine `Quaternion`-Variante ist derselbe Code mit vier Komponenten), oder kombinieren Sie den Converter für den Rest mit `IncludeFields = true`. Die Mechanik von Reader und Writer, einschließlich der Frage, warum der Reader auf dem zuletzt verarbeiteten Token stehen bleiben muss, erklärt der Beitrag [einen eigenen JsonConverter in System.Text.Json schreiben](/de/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/).

## Lösung 3: Matrix4x4 braucht einen Converter, nicht IncludeFields

Bei `Matrix4x4` versagt `IncludeFields` ab .NET 10. Das Struct hat 16 öffentliche Felder `M11` bis `M44`, und .NET 10 hat zusätzlich zur bestehenden les- und schreibbaren Eigenschaft `Translation` die les- und schreibbaren Zeileneigenschaften `X`, `Y`, `Z` und `W` (jeweils ein `Vector4`) eingeführt. Da diese Setter haben, entfernt `IgnoreReadOnlyProperties` sie nicht. Das Ergebnis für `Matrix4x4.CreateTranslation(1, 2, 3)` mit `IncludeFields = true`:

```json
{"IsIdentity":false,"Translation":{"X":1,"Y":2,"Z":3},
 "X":{"X":1,"Y":0,"Z":0,"W":0},"Y":{"X":0,"Y":1,"Z":0,"W":0},
 "Z":{"X":0,"Y":0,"Z":1,"W":0},"W":{"X":1,"Y":2,"Z":3,"W":1},
 "M11":1,"M12":0,"M13":0,"M14":0,"M21":0,"M22":1,"M23":0,"M24":0,
 "M31":0,"M32":0,"M33":1,"M34":0,"M41":1,"M42":2,"M43":3,"M44":1}
```

Jeder Wert wird zweimal geschrieben, `M41` bis `M43` sogar dreimal. Der Round-Trip funktioniert, aber beim Deserialisieren werden die Member in der Reihenfolge ihres Auftretens im JSON angewendet, und der letzte Schreibvorgang gewinnt. Ich habe es geprüft: `{"M41":9,"W":{"X":1,"Y":2,"Z":3,"W":1}}` ergibt `M41 == 1`, dieselben Member in umgekehrter Reihenfolge ergeben `M41 == 9`. Ein Client, der eine Darstellung ändert und die andere nicht, erhält eine Matrix, die von der Reihenfolge der Schlüssel abhängt. Beachten Sie außerdem, dass ein unvollständiger Payload wie `{"M11":1}` eine Matrix mit Nullen an allen anderen Stellen ergibt, nicht `Matrix4x4.Identity`, weil der Ausgangswert `default` ist.

Schreiben Sie für Matrizen einen Converter, der die 16 `M`-Felder als flaches Array in zeilenweiser Reihenfolge ausgibt, nach demselben Muster wie `Vector3ArrayConverter` mit einer Schleife über 16 Elemente. Das ist weniger Code, als sich gegen die doppelte Darstellung abzusichern.

## Lösung 4: Member mit einem Resolver-Modifier entfernen

Wenn Sie benannte Komponenten (die Form aus Lösung 1) möchten, aber präzise Kontrolle brauchen, etwa weil Sie `IgnoreReadOnlyProperties` nicht verwenden können, da Ihre eigenen DTOs darauf angewiesen sind, dass Eigenschaften ohne Setter geschrieben werden, passen Sie den Vertrag nur für die Numerics-Typen an:

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

Das ist dieselbe Technik wie beim [Anpassen eines bestehenden Type Info Resolvers](/de/2023/10/system-text-json-how-to-modify-existing-type-info-resolver/). Der Vorteil liegt im Geltungsbereich auf Typebene: Ihre eigenen Typen behalten ihren Standardvertrag. Beachten Sie, dass dies ab .NET 10 die Zeilen `X/Y/Z/W` von `Matrix4x4` weiterhin bestehen lässt, ein weiteres Argument für den Matrix-Converter.

## Source Generation und Native AOT

Wenn Sie einen `JsonSerializerContext` verwenden (erforderlich für Native AOT und getrimmte Anwendungen), sitzt der Schalter auf dem Kontext statt auf den Optionen:

```csharp
// .NET 10.0.10 and .NET 11.0.0 RC 1
[JsonSourceGenerationOptions(IncludeFields = true, IgnoreReadOnlyProperties = true)]
[JsonSerializable(typeof(Transform))]
internal partial class SceneContext : JsonSerializerContext;

JsonSerializer.Serialize(new Transform { Position = v, Rotation = q },
    SceneContext.Default.Transform);
// {"Position":{"X":1,"Y":2.5,"Z":-3},"Rotation":{"X":0,"Y":0.24740396,"Z":0,"W":0.9689124}}
```

Ein Kontext ohne `IncludeFields = true` erzeugt denselben leeren Vertrag wie in der Reproduktion: `{}` für `Vector3`, gemessen. Eigene Converter funktionieren auch mit Source Generation; fügen Sie sie mit `[JsonSourceGenerationOptions(Converters = [typeof(Vector3ArrayConverter)])]` hinzu.

Eine Falle, in die ich beim Bau des Testprogramms getappt bin: Dateibasierte Anwendungen in .NET 10 (`dotnet run probe.cs`) verwenden standardmäßig `PublishAot=true`, was die reflexionsbasierte Serialisierung deaktiviert. Ein Aufruf von `JsonSerializer.Serialize(v)` ohne Kontext wirft dann `InvalidOperationException: Reflection-based serialization has been disabled for this application`. Verwenden Sie entweder einen Kontext, oder fügen Sie für ein schnelles Experiment `#:property JsonSerializerIsReflectionEnabledByDefault=true` hinzu. Den Hintergrund liefert der Beitrag zum [Deaktivieren der reflexionsbasierten Serialisierung in System.Text.Json](/de/2023/10/system-text-json-disable-reflection-based-serialization/).

## Stolperfallen: NaN, Genauigkeit, Schreibweise und Vektoren im Unity-Stil

**NaN und Unendlich werfen Ausnahmen.** Ein Physikschritt, der durch null teilt, erzeugt `NaN`-Komponenten, und `Utf8JsonWriter` verweigert sie:

```csharp
// .NET 10.0.10
JsonSerializer.Serialize(new Vector3(float.NaN, 0, 0), new JsonSerializerOptions { IncludeFields = true });
// ArgumentException: .NET number values such as positive and negative infinity
// cannot be written as valid JSON.
```

`NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals` schreibt sie als Strings, `{"X":"NaN","Y":"Infinity","Z":0}`. Ob das besser ist als ein Fehlschlag, hängt davon ab, wer das JSON liest; `JSON.parse` in JavaScript liefert den String `"NaN"`, keine Zahl.

**Floats werden in der kürzesten Darstellung geschrieben.** `new Vector3(0.1f, 1f/3f, 1e-8f)` wird als `{"X":0.1,"Y":0.33333334,"Z":1E-08}` serialisiert. System.Text.Json schreibt den kürzesten String, der beim Round-Trip wieder denselben `float` ergibt, es geht also keine Genauigkeit verloren, aber ein Konsument, der in `double` parst, sieht `0.33333334` und nicht `1/3`.

**Benennungsrichtlinien gelten auch für Felder.** `JsonSerializerDefaults.Web` plus `IncludeFields = true` schreibt `{"x":1,"y":2.5,"z":-3}` und liest beide Schreibweisen, weil die Web-Standards die Groß- und Kleinschreibung ignorieren. Erwartet ein JavaScript-Client großgeschriebenes `X`, verwenden Sie für diesen Payload nicht die Web-Standards.

**Vektoren im Unity-Stil scheitern mit einem Zyklusfehler.** `UnityEngine.Vector3` speichert `x`, `y`, `z` ebenfalls in Feldern, hat aber zusätzlich berechnete Eigenschaften wie `normalized`, die wieder einen `Vector3` zurückgeben. Ein Struct dieser Form scheitert, ob mit oder ohne `IncludeFields` serialisiert, weil `normalized` sein eigenes `normalized` hat, und so weiter ohne Ende:

```text
JsonException: A possible object cycle was detected. This can either be due to a cycle
or if the object depth is larger than the maximum allowed depth of 64.
Path: $.normalized.normalized.no...
```

`ReferenceHandler.IgnoreCycles` hilft nicht, da es in einem Struct keine Referenzen zu verfolgen gibt; jedes `normalized` ist ein neuer Wert. `IgnoreReadOnlyProperties = true` zusammen mit `IncludeFields = true` hat das Problem in meinem Test behoben und `{"x":3,"y":0,"z":4}` ergeben, inklusive erfolgreichem Round-Trip. Getestet habe ich mit einem Struct, das wie das von Unity aufgebaut ist (Felder plus die Eigenschaften ohne Setter `magnitude`, `sqrMagnitude` und `normalized`), nicht im Unity-Editor, der einen eigenen Serializer mitbringt. Mehr zu dieser Ausnahme im Beitrag [Behebung von "A possible object cycle was detected"](/de/2026/05/fix-possible-object-cycle-was-detected-system-text-json/).

## Welche Lösung Sie wählen sollten

1. Fügen Sie `IncludeFields = true` und `IgnoreReadOnlyProperties = true` zu Ihren Optionen (oder zu Ihren `JsonSourceGenerationOptions`) hinzu, wenn Sie `Vector2`, `Vector3`, `Vector4`, `Quaternion` oder `Plane` serialisieren und mit Objekten der Form `{"X":..,"Y":..}` einverstanden sind.
2. Aktivieren Sie in Tests `UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow`, damit ein künftiger Typ mit demselben Feldproblem fehlschlägt, statt als Nullen deserialisiert zu werden.
3. Schreiben Sie einen `JsonConverter<T>` für `Matrix4x4`, und auch für Vektoren, wenn die Payload-Größe zählt oder eine Spezifikation (glTF, GeoJSON) Arrays vorschreibt.
4. Verwenden Sie einen `DefaultJsonTypeInfoResolver`-Modifier, wenn `IncludeFields` aktiv bleiben muss, eine bestimmte Eigenschaft aber verschwinden soll, ohne die Serialisierung Ihrer eigenen Typen zu verändern.

Wenn Sie von `BinaryFormatter` kommen, der diese Structs ungefragt Feld für Feld serialisiert hat, begegnet Ihnen dieselbe Entscheidung zu `IncludeFields` im [Leitfaden zur Migration weg von BinaryFormatter](/de/2026/09/migrate-off-binaryformatter-after-its-removal-in-modern-dotnet/).

## Verwandte Beiträge

- [Einen eigenen JsonConverter in System.Text.Json schreiben](/de/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/)
- [System.Text.Json eine Eigenschaft mit dem Modifizierer required ignorieren lassen](/de/2026/08/how-to-make-system-text-json-ignore-a-property-with-the-required-modifier/)
- [Behebung von "A possible object cycle was detected" in System.Text.Json](/de/2026/05/fix-possible-object-cycle-was-detected-system-text-json/)
- [.NET 8: nicht öffentliche Member in die JSON-Serialisierung einbeziehen](/de/2023/09/net-8-include-non-public-members-in-json-serialization/)
- [System.Text.Json: einen bestehenden Type Info Resolver anpassen](/de/2023/10/system-text-json-how-to-modify-existing-type-info-resolver/)

## Quellen

- [Include fields in serialization](https://learn.microsoft.com/dotnet/standard/serialization/system-text-json/fields), Microsoft Learn
- [`JsonSerializerOptions.IncludeFields`](https://learn.microsoft.com/dotnet/api/system.text.json.jsonserializeroptions.includefields) und [`IgnoreReadOnlyProperties`](https://learn.microsoft.com/dotnet/api/system.text.json.jsonserializeroptions.ignorereadonlyproperties)
- [`Matrix4x4.X`-Eigenschaft](https://learn.microsoft.com/dotnet/api/system.numerics.matrix4x4.x), gilt für .NET 10 und .NET 11
- [Customize a JSON contract](https://learn.microsoft.com/dotnet/standard/serialization/system-text-json/custom-contracts), Microsoft Learn
- [`JsonNumberHandling`](https://learn.microsoft.com/dotnet/api/system.text.json.serialization.jsonnumberhandling)
