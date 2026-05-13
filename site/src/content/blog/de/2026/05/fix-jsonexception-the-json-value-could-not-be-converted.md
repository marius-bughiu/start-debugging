---
title: "Fix: System.Text.Json.JsonException: The JSON value could not be converted"
description: "System.Text.Json wirft diese Exception, wenn das eingehende JSON-Token nicht zum CLR-Zieltyp passt. Passen Sie das JSON dem Typ an, oder registrieren Sie einen JsonConverter oder eine JsonSerializerOption, die beide verbindet."
pubDate: 2026-05-13
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "json"
lang: "de"
translationOf: "2026/05/fix-jsonexception-the-json-value-could-not-be-converted"
translatedBy: "claude"
translationDate: 2026-05-13
---

Die Lösung: `System.Text.Json` hat diese Exception ausgelöst, weil das JSON-Token am angegebenen Pfad nicht in den CLR-Zieltyp deserialisiert werden kann. Die Meldung tritt in der Regel in zwei Formen auf. Entweder hat das JSON die falsche **Token-Art** (ein String, wo eine Zahl erwartet wurde, oder umgekehrt, oder eine Zahl, wo ein Enum-Wert erwartet wurde), oder das JSON hat die richtige Art, aber der **Inhalt** entspricht nicht den Parsing-Regeln des Typs (ein Nicht-ISO-Datum, eine fehlerhafte `Guid`, ein Literal wie `"NaN"`). Wählen Sie eine von drei Lösungen pro Aufrufstelle: Ändern Sie den Produzenten, damit er das erwartete JSON-Format ausgibt, aktivieren Sie einen Converter, der das tatsächlich empfangene Format akzeptiert (`JsonStringEnumConverter`, `JsonNumberHandling.AllowReadingFromString`), oder schreiben Sie einen `JsonConverter<T>`, der das Parsing selbst übernimmt.

```text
System.Text.Json.JsonException: The JSON value could not be converted to MyApp.OrderStatus. Path: $.status | LineNumber: 0 | BytePositionInLine: 21.
   at System.Text.Json.ThrowHelper.ThrowJsonException(String message)
   at System.Text.Json.Serialization.Converters.EnumConverter`1.Read(Utf8JsonReader& reader, Type typeToConvert, JsonSerializerOptions options)
   at System.Text.Json.Serialization.JsonConverter`1.ReadCore(Utf8JsonReader& reader, JsonSerializerOptions options, ReadStack& state)
   at System.Text.Json.JsonSerializer.ReadFromSpan[TValue](ReadOnlySpan`1 utf8Json, JsonTypeInfo jsonTypeInfo)
   at System.Text.Json.JsonSerializer.Deserialize[TValue](String json, JsonSerializerOptions options)
```

Diese Anleitung ist gegen .NET 11 Preview 4 und `System.Text.Json` 11.0.0-preview.4 geschrieben. Der Exception-Typ und die Felder `Path` / `LineNumber` / `BytePositionInLine` sind seit dem Erscheinen von `System.Text.Json` in .NET Core 3.0 stabil, daher gelten alle Lösungen unten ohne Änderungen für .NET 6, 8, 10 und 11. Die einzigen beweglichen Teile zwischen den Versionen sind die Converter-Stellschrauben: `JsonNumberHandling` kam mit .NET 5, `JsonStringEnumConverter<TEnum>` (die generische, AOT-freundliche Version) erschien in .NET 8, und das Attribut `[JsonStringEnumMemberName]` landete in .NET 9.

Das Erste, was Sie lesen sollten, ist das Segment **`Path`**. Es ist ein Pfad im JSON-Pointer-Stil mit `$` als Wurzel und sagt genau, an welcher Eigenschaft sich der Reader verschluckt hat. Suchmaschinen führen Sie häufig auf einen Stack Trace, der einen generischen Converter nennt ("the JSON value could not be converted to `Int32`"), ohne Hinweis auf die Eigenschaft, aber `Path` ist immer da. Wenn Sie kein `Path`-Segment sehen, schauen Sie auf eine umhüllte Exception. Fangen Sie `JsonException` direkt an der Deserialisierungs-Aufrufstelle und lesen Sie `ex.Path` über die Eigenschaft, nicht aus `ex.Message`.

## Warum System.Text.Json keine Koercion durchführt

Im Gegensatz zu `Newtonsoft.Json` ist `System.Text.Json` **standardmäßig strikt**: Es führt keine Koercion zwischen JSON-Token-Arten durch und lässt keinen verlustbehafteten Parser über den String-Inhalt laufen. Wenn Ihr Endpunkt `{ "amount": "12.50" }` akzeptiert und Ihr DTO `decimal Amount` hat, sieht der Reader `JsonTokenType.String`, findet keine eingebaute Konvertierung von `string` zu `decimal` und wirft. Dieselbe Logik lehnt ab:

- Einen JSON-String, wo die Eigenschaft einen `bool`, `int`, `long`, `decimal`, `double`, `Guid`, `DateTime` oder `TimeSpan` erwartet. Die umgekehrte Richtung (eine JSON-Zahl, wo die Eigenschaft einen `string` erwartet) wird ebenfalls abgelehnt.
- Eine JSON-Zahl, die einen Enum-Wert benennt, wenn kein `JsonStringEnumConverter` registriert ist, **oder** einen JSON-String, der einen Enum-Wert benennt, wenn der nur-ganzzahlige Standard-Converter aktiv ist.
- Einen leeren String `""`, wo die Eigenschaft einen Werttyp erwartet. Leere Strings sind nicht dasselbe wie `null`, und Werttypen sind nicht nullbar, sofern nicht als `T?` deklariert.
- Ein polymorphes JSON-Objekt, bei dem der Diskriminator zu keinem registrierten `[JsonDerivedType]` passt.
- Ein Fließkomma-Literal wie `"NaN"`, `"Infinity"` oder `"-Infinity"`, wenn `JsonNumberHandling.AllowNamedFloatingPointLiterals` nicht gesetzt ist.
- Eine Unix-Timestamp-Zahl (`1715600000`) für eine `DateTime`-Eigenschaft, weil `System.Text.Json` `DateTime` nur aus einem ISO-8601-String liest. Der spezielle Fall wird in [der kanonischen DateTime-Konvertierungslösung](/de/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) behandelt.

Die Striktheit ist Design, kein Fehler. Die Begründung des Teams ist, dass verlustbehaftete Konvertierung die häufigste Quelle stiller Datenkorruption in Geschäftsanwendungen ist und dass explizite Converter-Registrierung die Absicht an der Naht zwischen Wire-Format und Typsystem sichtbar macht. Der Tradeoff ist, dass jedes Querschnittsthema, das Sie früher aus den `Newtonsoft.Json`-Defaults bekamen (String-zu-Zahl, String-zu-Enum, String-zu-Bool), jetzt eine explizite Aktivierung braucht.

## Minimale Reproduktion

Das kleinste Programm, das die häufigste Variante reproduziert, ein Enum, das als String ankommt:

```csharp
// .NET 11 preview 4, System.Text.Json 11.0.0-preview.4
using System.Text.Json;

var json = """{ "status": "Pending" }""";

var order = JsonSerializer.Deserialize<Order>(json);

Console.WriteLine(order!.Status);

public record Order(OrderStatus Status);
public enum OrderStatus { Pending, Shipped, Delivered }
```

Die Ausführung wirft:

```text
Unhandled exception. System.Text.Json.JsonException:
The JSON value could not be converted to OrderStatus. Path: $.status | LineNumber: 0 | BytePositionInLine: 20.
```

Der Standard-Enum-Converter akzeptiert nur die **Integer**-Darstellung (`{ "status": 0 }`). Alles andere löst die Exception aus. Sobald Sie verstanden haben, dass dies der Fehlermodus ist, folgen alle anderen Varianten in diesem Beitrag demselben Muster: Das JSON-Format passt nicht zum Typ, und Sie wählen, welche Seite Sie biegen.

## Lösung 1: Enums, die als Strings empfangen werden

Registrieren Sie `JsonStringEnumConverter<TEnum>` einmal in Ihren `JsonSerializerOptions`:

```csharp
// .NET 11 preview 4, System.Text.Json 11.0.0-preview.4
var options = new JsonSerializerOptions
{
    Converters = { new JsonStringEnumConverter<OrderStatus>() }
};

var order = JsonSerializer.Deserialize<Order>(json, options)!;
```

Wenn Sie viele Enums haben, registrieren Sie stattdessen den nicht-generischen `JsonStringEnumConverter()`. Er gilt für jeden Enum-Typ, dem der Serializer begegnet, auf Kosten der Inkompatibilität mit Native-AOT-Trimming. Für Native AOT ziehen Sie den generischen Converter pro Enum vor oder annotieren jeden Enum direkt mit `[JsonConverter(typeof(JsonStringEnumConverter<OrderStatus>))]` und halten die globale Converter-Liste leer.

Wenn der Produzent zwischen Groß- und Kleinschreibung unterscheidet ("PENDING" auf der Leitung, `Pending` in C#), übergeben Sie eine Naming-Policy:

```csharp
var options = new JsonSerializerOptions
{
    Converters =
    {
        new JsonStringEnumConverter<OrderStatus>(JsonNamingPolicy.SnakeCaseUpper)
    }
};
```

Für Produzenten, die Werte senden, die nicht als C#-Bezeichner darstellbar sind ("in-progress", "n/a"), führte .NET 9 `[JsonStringEnumMemberName]` ein:

```csharp
public enum OrderStatus
{
    Pending,

    [JsonStringEnumMemberName("in-progress")]
    InProgress,

    Delivered
}
```

In ASP.NET Core Minimal APIs konfigurieren Sie den Converter auf den `JsonSerializerOptions` der Anwendung, sodass jeder Endpunkt ihn aufgreift:

```csharp
// .NET 11 preview 4, ASP.NET Core 11.0.0-preview.4
builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.Converters.Add(new JsonStringEnumConverter<OrderStatus>());
});
```

Für Controller lautet der entsprechende Aufruf `builder.Services.AddControllers().AddJsonOptions(o => o.JsonSerializerOptions.Converters.Add(...))`. Eine einmalige Konfiguration im Composition Root ist vorzuziehen, statt `JsonConverter` an jedem `[JsonConverter(...)]`-Attribut zu öffnen.

## Lösung 2: Zahlen als Strings empfangen (und umgekehrt)

Wenn der Produzent ein numerisches Feld JSON-seitig als String kodiert, `{ "amount": "12.50" }`, aktivieren Sie `JsonNumberHandling.AllowReadingFromString`:

```csharp
// .NET 11 preview 4, System.Text.Json 11.0.0-preview.4
var options = new JsonSerializerOptions
{
    NumberHandling = JsonNumberHandling.AllowReadingFromString
};

var dto = JsonSerializer.Deserialize<Invoice>(json, options);

public record Invoice(decimal Amount);
```

`AllowReadingFromString` funktioniert für jeden ganzzahligen und Fließkomma-Typ sowie `decimal`. Es ist symmetrisch zu `WriteAsString`, das Sie kombinieren können, wenn der Serializer den Wert als String emittieren und lesen soll:

```csharp
NumberHandling = JsonNumberHandling.AllowReadingFromString | JsonNumberHandling.WriteAsString
```

Für einen Scope pro Eigenschaft statt global annotieren Sie die Eigenschaft direkt:

```csharp
public record Invoice(
    [property: JsonNumberHandling(JsonNumberHandling.AllowReadingFromString)] decimal Amount
);
```

Der umgekehrte Fall, eine JSON-Zahl, die gesendet wird, wo ein `string` erwartet wird (eine Tracking-ID kodiert als `42` statt `"42"`), wird **nicht** von `JsonNumberHandling` abgedeckt. Sie brauchen einen kleinen benutzerdefinierten Converter:

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

Den Converter-Vertrag behandle ich tiefer in [der Anleitung zum Schreiben eines eigenen JsonConverter](/de/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/), inklusive Komposition von Convertern und Kurzschluss bei polymorpher Auswahl.

## Lösung 3: Booleans als 0 / 1 oder als "true" / "false"-Strings

`System.Text.Json` akzeptiert für `bool` nur die JSON-Tokens `true` / `false`. Numerische `0` / `1` und String-Werte `"true"` / `"false"` werden beide abgelehnt. Es gibt keine eingebaute Option für eine der Formen; schreiben Sie einen Converter:

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

Registrieren Sie ihn pro Eigenschaft mit `[JsonConverter(typeof(LooseBooleanConverter))]` statt global, weil die meisten Felder in einer gut konstruierten API nicht lax sind und das Biegen jedes `bool`, um drei Formen zu akzeptieren, den Vertrag verschleiert.

## Lösung 4: leere Strings für Werttypen

Wenn der Produzent `{ "shippedAt": "" }` für ein fehlendes Datum ausgibt, liest `System.Text.Json` `JsonTokenType.String` und schlägt beim Parsen des leeren Inhalts als `DateTime` fehl. Es gibt zwei saubere Lösungen. Die erste ist, die C#-Eigenschaft nullbar zu machen und einen Converter zu schreiben, der `""` auf `null` abbildet:

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

Die zweite ist, `JsonSerializerOptions.RespectNullableAnnotations = true` zu setzen (Standard ab .NET 9+) und den Produzenten `null` statt `""` senden zu lassen. Die produzentenseitige Lösung ist vorzuziehen, wenn Sie beide Seiten kontrollieren, weil jeder `""`-als-null-Sonderfall irgendwann in eine nicht nullbare Spalte oder eine NullReferenceException stromabwärts durchsickert.

## Lösung 5: Guid im falschen Format

`System.Text.Json` verwendet `Guid.TryParseExact` mit Format `D` (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`). In Klammern (`{...}`), in runden Klammern (`(...)`) und ohne Bindestriche (`N`) werden alle abgelehnt. Die kürzeste Lösung ist ein Converter pro Eigenschaft:

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

`Guid.Parse` akzeptiert jeden Standard-Format-String, das reicht.

## Lösung 6: polymorphe Objekte mit unbekanntem Diskriminator

Wenn Sie einen Basistyp mit `[JsonPolymorphic]` und `[JsonDerivedType]` deklarieren, prüft der Reader die Diskriminator-Eigenschaft und geht zum passenden Subtyp. Wenn der Diskriminator-Wert fehlt oder unbekannt ist, wirft der Reader "the JSON value could not be converted to BaseType". Zwei produktionsreife Lösungen:

- Setzen Sie `UnknownDerivedTypeHandling = JsonUnknownDerivedTypeHandling.FallBackToBaseType`, damit der Reader den Basistyp materialisiert, wenn kein abgeleiteter Typ passt.
- Setzen Sie `UnknownDerivedTypeHandling = JsonUnknownDerivedTypeHandling.FallBackToNearestAncestor`, wenn Sie eine Klassenhierarchie tiefer als eine Ebene haben und den nächsten registrierten Vorfahren wollen.

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

Das Standardverhalten (`JsonUnknownDerivedTypeHandling.FailSerialization`) ist für geschlossene Schemas korrekt, in denen jede Variante bekannt ist. Verwenden Sie die Fallback-Optionen, wenn Sie Ereignisse von einem Produzenten konsumieren, der neue Varianten ohne koordinierte Bereitstellung hinzufügt.

## Lösung 7: Fließkomma-NaN und Infinity

Wenn ein Serializer auf der Produzentenseite `"NaN"`, `"Infinity"` oder `"-Infinity"` für `double` / `float` emittiert, aktivieren Sie:

```csharp
var options = new JsonSerializerOptions
{
    NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals
};
```

Das ist symmetrisch: Dieselbe Option erlaubt Ihrem Serializer auch, diese Literale auf dem Schreibpfad zu emittieren. Ohne sie werfen sowohl Lesen als auch Schreiben.

## Fallen und Lookalikes

- **Die Exception-Meldung nennt einen Basistyp, nicht den konkreten.** Polymorphe Deserialisierung meldet den Fehler gegen die polymorphe Wurzel, nicht gegen den Typ, auf den der Diskriminator zeigte. Lesen Sie den Diskriminator-Wert in Ihrem rohen JSON, bevor Sie annehmen, der Converter sei falsch.
- **Source-generierte Kontexte verbergen Optionen.** Wenn Sie `[JsonSerializable(typeof(Order))]` auf einem `JsonSerializerContext` deklariert haben, **wird** die Converter-Liste auf den übergebenen `JsonSerializerOptions` zur Laufzeit respektiert, aber die source-generierten Metadaten kodieren `[JsonConverter]`-Attribute auch zur Compile-Zeit. Beide zu mischen ist okay, aber ein `[JsonConverter(...)]` auf Eigenschaftsebene gewinnt immer gegen einen zur Laufzeit registrierten globalen Converter. Siehe [die C# 14 Interceptor-Unterstützung für System.Text.Json Source Generation](/de/2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics/) für die Ergonomie-Arbeit in diesem Bereich.
- **Groß-/Kleinschreibung ist unabhängig vom Converter.** `PropertyNameCaseInsensitive = true` und die schreibweisenbewussten Naming-Policies (`JsonNamingPolicy.CamelCase`, `JsonNamingPolicy.SnakeCaseLower`, das Attribut für [PascalCase-Namen pro Member in .NET 11](/de/2026/04/system-text-json-11-pascalcase-per-member-naming/)) beeinflussen, an welche CLR-Eigenschaft der Reader bindet, nicht, wie er den Wert konvertiert. Wenn Ihre Fehlermeldung `Path: $.OrderStatus` nennt, Ihr JSON aber `"orderStatus"` enthält, sehen Sie einen Binding-Miss, nicht einen Konvertierungsfehler.
- **Der DateTime-Zweig hat eigene Konventionen.** Nur ISO 8601, nur `T`-Trennzeichen, keine Unix-Timestamps. Die vollständige Tabelle akzeptierter und abgelehnter Formate steht in [der dedizierten DateTime-Konvertierungslösung](/de/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/).
- **Eine Zahl lesen, die nicht passt.** Ein JSON `9999999999` kann nicht in einen `int` gelesen werden und wirft mit demselben Exception-Text. Prüfen Sie die Größenordnung, bevor Sie ein Formatproblem annehmen.
- **Newtonsoft.Json hat still gecoerced.** Der häufigste Weg zu diesem Bug ist eine Migration von `Newtonsoft.Json`, bei der der alte Code `{ "amount": "12.50" }` akzeptiert hat, weil Newtonsoft im Hintergrund String-zu-Decimal versucht. Es gibt keinen globalen "sei nachsichtig"-Schalter in `System.Text.Json`. Entweder Sie setzen `NumberHandling` und registrieren `JsonStringEnumConverter`, oder Sie bleiben für diese Grenze bei Newtonsoft.

## Verwandt

- [Fix: The JSON value could not be converted to System.DateTime](/de/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) behandelt die DateTime-spezifische Variante, inklusive der ISO-8601-Formatanforderung und des Unix-Timestamp-Parsings.
- [Einen eigenen JsonConverter in System.Text.Json schreiben](/de/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) zeigt den Converter-Vertrag, Factory-Converter und wie man auf den Standard-Converter zurückfällt.
- [PascalCase-Namen pro Member in System.Text.Json 11](/de/2026/04/system-text-json-11-pascalcase-per-member-naming/) ist das richtige Werkzeug, wenn der Fehler ein Property-Binding und keine Wertkonvertierung ist.
- [C# 14 Interceptors für System.Text.Json Source Generation](/de/2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics/) erklärt, wie source-generierte Converter mit Laufzeit-`JsonSerializerOptions` zusammenspielen.
- [Fix: InvalidOperationException: Synchronous operations are disallowed](/de/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed/) ist nicht verwandt, tritt aber häufig zusammen mit JSON-Konvertierungsfehlern auf, wenn man in ASP.NET Core von gepuffertem auf gestreamtes JSON migriert.

## Quellen

- [System.Text.Json Übersicht, .NET docs](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/overview)
- [Enum-Werte serialisieren und deserialisieren, MS Learn](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/customize-properties)
- [`JsonNumberHandling` Referenz](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonnumberhandling)
- [`JsonPolymorphicAttribute` und `JsonDerivedTypeAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonpolymorphicattribute)
- [`JsonStringEnumMemberNameAttribute`, .NET 9+](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonstringenummembernameattribute)
- [`dotnet/runtime` Quellcode für `EnumConverter<T>`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Text.Json/src/System/Text/Json/Serialization/Converters/Value/EnumConverter.cs)
