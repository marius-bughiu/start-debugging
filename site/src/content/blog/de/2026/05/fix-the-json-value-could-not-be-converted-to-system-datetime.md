---
title: "Fix: The JSON value could not be converted to System.DateTime"
description: "System.Text.Json akzeptiert für DateTime nur ISO-8601-Strings. Senden Sie 2026-05-08T14:00:00Z oder registrieren Sie einen JsonConverter, der Ihr Format parst. Leere Strings und Unix-Timestamps lösen ebenfalls aus."
pubDate: 2026-05-08
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "json"
lang: "de"
translationOf: "2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime"
translatedBy: "claude"
translationDate: 2026-05-08
---

Die Lösung: `System.Text.Json` deserialisiert ein `DateTime` ausschließlich aus einem JSON-String im erweiterten ISO-8601-Format wie `"2026-05-08T14:00:00Z"` oder `"2026-05-08T14:00:00+02:00"`. Wenn Ihr Producer `"05/08/2026"`, einen leeren String `""`, einen Unix-Timestamp als Zahl oder Newtonsofts `"/Date(1746715200000)/"` sendet, wirft der Deserializer eine Exception. Sie ändern entweder das Drahtformat auf ISO 8601 oder registrieren einen `JsonConverter<DateTime>`, der das tatsächlich empfangene Format parst.

```text
System.Text.Json.JsonException: The JSON value could not be converted to System.DateTime. Path: $.startedAt | LineNumber: 0 | BytePositionInLine: 27.
   at System.Text.Json.ThrowHelper.ReThrowWithPath(ReadStack& state, JsonReaderException ex)
   at System.Text.Json.Serialization.JsonConverter`1.ReadCore(Utf8JsonReader& reader, JsonSerializerOptions options, ReadStack& state)
   at System.Text.Json.JsonSerializer.ReadFromSpan[TValue](ReadOnlySpan`1 utf8Json, JsonTypeInfo jsonTypeInfo)
   at System.Text.Json.JsonSerializer.Deserialize[TValue](String json, JsonSerializerOptions options)
 ---> System.FormatException: The JSON value is not in a supported DateTime format.
```

Diese Anleitung wurde gegen .NET 11 preview 4 und `System.Text.Json` 11.0.0-preview.4 geschrieben. Das akzeptierte Format und die Exception haben sich seit dem Release von `System.Text.Json` in .NET Core 3.0 nicht geändert; der Text der inneren `FormatException` wurde rund um .NET 8 geschärft. Das `Path`-Segment ist der JSON-Pfad der problematischen Eigenschaft und das Erste, was Sie lesen sollten: Es zeigt Ihnen, an welchem Feld der Konverter gescheitert ist, ohne dass Sie etwas instrumentieren müssen.

## Warum System.Text.Json so streng ist

`System.Text.Json` implementiert bewusst nur das [ISO 8601-1:2019 Extended Profile](https://learn.microsoft.com/en-us/dotnet/standard/datetime/system-text-json-support) für `DateTime` und `DateTimeOffset`. Das Format muss `YYYY-MM-DDTHH:mm:ss[.fffffff][Z|+hh:mm]` mit einem literalen `T` als Trenner sein. Kleines `t`, ein Leerzeichen als Trenner, das US-Format `MM/dd/yyyy`, zweistellige Jahre, fehlende Sekunden sowie reine Uhrzeit- oder reine Datumswerte werden alle abgelehnt. Ebenso das JSON-`null`-Token, sofern die Eigenschaft kein nullbares `DateTime?` ist, und ebenso ein leerer String `""`.

Das ist Absicht: Newtonsoft.Jsons toleranter Multi-Format-Parser hat reale Bugs verursacht, bei denen ein Producer in einer Region `01/05/2026` sendete und ein Consumer in einer anderen Region das stillschweigend als das falsche Datum parste. `System.Text.Json` behandelt das DateTime-Parsing genauso wie Zahlen in JSON: eine kanonische Form, kein Raten.

Der Deserializer wirft also zu Recht. Die Aufgabe besteht darin, entweder den Draht konform zu machen oder einen Konverter zu registrieren, der Ihr Drahtformat genau einmal auf ein `DateTime` mappt.

## Eine minimale Reproduktion

```csharp
// .NET 11, C# 14, System.Text.Json 11.0.0-preview.4
using System.Text.Json;

record Event(DateTime StartedAt);

var bad = """{ "startedAt": "05/08/2026" }""";
var ev = JsonSerializer.Deserialize<Event>(bad); // throws
```

Der Producer hat ein Datum im US-Slash-Format gesendet, und `System.Text.Json` kennt dieses Format nicht. Der gleiche Fehler tritt für jedes dieser Payloads auf:

```json
{ "startedAt": "" }
{ "startedAt": "2026-05-08" }
{ "startedAt": 1746715200 }
{ "startedAt": "/Date(1746715200000)/" }
{ "startedAt": "2026-05-08 14:00:00" }
{ "startedAt": "Friday, May 8, 2026" }
```

Jedes scheitert aus einem anderen Grund. Der leere String ist nicht als Datum parsbar. Das nackte Datum `"2026-05-08"` hat keine Zeitkomponente; ISO 8601 Extended verlangt das `T` und eine Uhrzeit. Die Unix-Timestamp-Zahl lässt sich überhaupt nicht an `DateTime` binden. Die Syntax `/Date(...)` ist ein historisches Newtonsoft-Artefakt. Das durch ein Leerzeichen getrennte Format ist ISO 8601 Basic, nicht Extended. Die englische Langform ist kein Maschinenformat.

## Lösung im Detail

### 1. Lassen Sie den Producer ISO 8601 senden

Die richtige Antwort ist, das an der Quelle zu beheben. ISO 8601 Extended mit einem `T` und einem UTC-`Z` (oder explizitem Offset) macht zwischen jedem modernen Stack einen Round-Trip: JavaScripts `Date.prototype.toISOString()`, Pythons `datetime.isoformat()`, Postgres `to_char(... 'YYYY-MM-DD"T"HH24:MI:SSOF')`, Javas `Instant.toString()` und `DateTime.UtcNow.ToString("o")` in .NET geben es alle aus.

```csharp
// .NET 11, C# 14
var iso = DateTime.UtcNow.ToString("o"); // 2026-05-08T14:00:00.0000000Z
```

Wenn Sie den Producer kontrollieren, ist das eine Zeile Arbeit. Vermeiden Sie `"u"` (verwendet ein Leerzeichen als Trenner, kein `T`) und vermeiden Sie es, `DateTime.Now` ohne Offset zu serialisieren, was Werte mit dem Kind `Unspecified` erzeugt, die mehrdeutig hin- und herwandern.

### 2. Registrieren Sie einen JsonConverter für Nicht-ISO-Formate

Wenn Sie den Producer nicht ändern können (Drittanbieter-API, Legacy-Payload), schreiben Sie einen Konverter. Das Konverter-Pattern ist unabhängig vom Quellformat dasselbe; nur der Parsing-Aufruf ändert sich.

```csharp
// .NET 11, C# 14, System.Text.Json 11.0.0-preview.4
using System.Buffers;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

public sealed class UsSlashDateConverter : JsonConverter<DateTime>
{
    private const string Format = "MM/dd/yyyy";

    public override DateTime Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options)
    {
        var text = reader.GetString();
        return DateTime.ParseExact(
            text!, Format, CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);
    }

    public override void Write(
        Utf8JsonWriter writer,
        DateTime value,
        JsonSerializerOptions options)
        => writer.WriteStringValue(value.ToUniversalTime().ToString(Format, CultureInfo.InvariantCulture));
}
```

Registrieren Sie ihn einmal an den Optionen, instanziieren Sie ihn nicht an jeder Aufrufstelle:

```csharp
// .NET 11
var options = new JsonSerializerOptions
{
    Converters = { new UsSlashDateConverter() }
};
var ev = JsonSerializer.Deserialize<Event>(bad, options);
```

Übergeben Sie immer `CultureInfo.InvariantCulture` und fixieren Sie das exakte Format mit `ParseExact`. `Parse` und `TryParse` stützen sich auf die aktuelle Kultur und führen genau die Mehrdeutigkeit wieder ein, die ISO 8601 entfernen sollte. Für die Konverter-Strukturdetails behandelt der [Custom-JsonConverter-Walkthrough](/de/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) die Hot-Path-Tricks (`Utf8JsonReader.ValueSpan`, Span-Parsing), die wichtig werden, wenn der Konverter in einer Hochdurchsatz-Pipeline sitzt.

### 3. Konvertieren Sie Unix-Timestamps mit einem zahlenbewussten Reader

Wenn der Draht eine Zahl sendet (`"startedAt": 1746715200`), wirft `reader.GetString()`, weil das Token `Number` ist, nicht `String`. Verzweigen Sie über `TokenType`:

```csharp
// .NET 11, C# 14, System.Text.Json 11.0.0-preview.4
public sealed class UnixSecondsConverter : JsonConverter<DateTime>
{
    public override DateTime Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options)
    {
        return reader.TokenType switch
        {
            JsonTokenType.Number => DateTimeOffset.FromUnixTimeSeconds(reader.GetInt64()).UtcDateTime,
            JsonTokenType.String when long.TryParse(reader.GetString(), out var s)
                => DateTimeOffset.FromUnixTimeSeconds(s).UtcDateTime,
            JsonTokenType.String
                => DateTime.Parse(reader.GetString()!, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind),
            _ => throw new JsonException($"Unexpected token {reader.TokenType} for DateTime.")
        };
    }

    public override void Write(
        Utf8JsonWriter writer,
        DateTime value,
        JsonSerializerOptions options)
        => writer.WriteNumberValue(new DateTimeOffset(value, TimeSpan.Zero).ToUnixTimeSeconds());
}
```

Das ist der Konverter, den Sie für ältere REST-APIs schreiben, die String- und Number-Payloads mischen (Twitter, Stripe, Slack-Legacy-Felder). `DateTimeOffset.FromUnixTimeSeconds` ist der richtige Helfer; multiplizieren Sie nicht mit 10.000, um einen `Ticks`-Wert zu erzeugen, dieser Pfad verliert Sub-Sekunden-Präzision und ignoriert die Epoch-Differenz.

### 4. Behandeln Sie leere Strings als null

Eine verbreitete API-Eigenheit ist das Senden von `""` für "kein Datum". Der Deserializer kann einen leeren String weder an `DateTime` noch an `DateTime?` binden. Machen Sie die Eigenschaft nullbar und fügen Sie einen Konverter hinzu, der bei leerer Eingabe `null` zurückgibt:

```csharp
// .NET 11, C# 14, System.Text.Json 11.0.0-preview.4
public sealed class NullableEmptyDateTimeConverter : JsonConverter<DateTime?>
{
    public override DateTime? Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.Null) return null;
        var text = reader.GetString();
        if (string.IsNullOrEmpty(text)) return null;
        return DateTime.Parse(text, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind);
    }

    public override void Write(
        Utf8JsonWriter writer,
        DateTime? value,
        JsonSerializerOptions options)
    {
        if (value is null) writer.WriteNullValue();
        else writer.WriteStringValue(value.Value.ToString("o", CultureInfo.InvariantCulture));
    }
}
```

Wenden Sie ihn pro Eigenschaft an, wenn nur ein Feld sich daneben benimmt, mit `[JsonConverter(typeof(NullableEmptyDateTimeConverter))]` an der Eigenschaft. Die globale Registrierung oben ersetzt den Default-Konverter für jedes `DateTime?` im Graphen; das per-Property-Attribut ist enger und sicherer.

### 5. Verwenden Sie DateOnly, wenn keine Uhrzeit vorhanden ist

Wenn der Draht tatsächlich `"2026-05-08"` ist (ein Kalenderdatum ohne Tageszeit), sollte der Typ auf der Consumer-Seite `DateOnly` sein, nicht `DateTime`. `System.Text.Json` 8.0+ hat eingebaute Unterstützung und akzeptiert das ISO-8601-Datumsformat direkt:

```csharp
// .NET 11, C# 14
record Event(DateOnly StartedOn);

var json = """{ "startedOn": "2026-05-08" }""";
var ev = JsonSerializer.Deserialize<Event>(json); // works, no converter needed
```

`DateOnly` wurde in .NET 6 speziell hinzugefügt, weil Datum-ohne-Uhrzeit der häufigste DateTime-bezogene Modellierungsbug war. Wenn Ihre Domäne tatsächlich ein Kalendertag ist (ein Geburtstag, ein Liefertermin, ein Feiertag), tauschen Sie den Typ aus, und das JSON-Parsing-Problem löst sich in Luft auf.

## Häufige Formen, die das auslösen

### Eigenschaft ist ein struct DateTime, aber der Wert kann fehlen

Ein nicht nullbares `DateTime` kann "fehlend" nicht abbilden. Der Producer sendet `null` oder `""`, der Deserializer wirft. Machen Sie die Eigenschaft `DateTime?`. Wenn Sie das Schema nicht kontrollieren, räumt `[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]` den Round-Trip auf dem Rückweg auf, aber der Lesepfad braucht trotzdem nullbar.

### Ein konfiguriertes Newtonsoft-Datumsformat ist in den Vertrag durchgesickert

Wenn Sie von Newtonsoft.Json migrieren, hatte Ihr alter Code wahrscheinlich `IsoDateFormatString = "MM/dd/yyyy"` oder ein `DateTimeFormat` an einem `JsonSerializerSettings` gesetzt. Newtonsoft hat das akzeptiert; `System.Text.Json` ehrt diese Einstellung überhaupt nicht. Suchen Sie in Ihrem Repo nach `DateFormatHandling`, `DateTimeFormat` und `IsoDateFormatString`, und beheben Sie dann entweder den Producer oder schreiben Sie den oben gezeigten Konverter. Das vstest-Team hat die [transitive Newtonsoft.Json-Abhängigkeit entfernt](/de/2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4/) in .NET 11 preview 4 aus ähnlichen Gründen der Vertragsverschärfung.

### MVC-Modelbinding schluckt die innere Exception

In ASP.NET Core erzeugt ein ungültiges Datum im Request-Body ein `400 Bad Request` mit `{"errors":{"$.startedAt":["The JSON value could not be converted to System.DateTime..."]}}`. Der `Path: $.startedAt` aus der inneren Exception landet im `errors`-Dictionary. Wenn Sie nur "One or more validation errors occurred" sehen, prüfen Sie den Response-Body, der problematische Pfad steht darin.

### Source Generators verbergen die Konverter-Registrierung

Wenn Sie sich für die Source-Generation von `System.Text.Json` mit `[JsonSerializable]` und einem `JsonSerializerContext` entscheiden, müssen Sie Konverter am gleichen Kontext registrieren, nicht nur an einem Laufzeit-`JsonSerializerOptions`. Der Generator emittiert `TypeInfo` für jeden gerooteten Typ zur Compile-Zeit, und ein Konverter, den Sie vergessen haben, am Kontext zu verdrahten, ist zur Laufzeit unsichtbar. Der [Beitrag zu Interceptors und Source-Generation](/de/2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics/) geht die Registrierungsform durch, die Trimming und AOT überlebt.

### Zeitzone im Eigenschaftsnamen eingebettet, nicht im Wert

Ein Schema wie `{"startedAtUtc": "2026-05-08T14:00:00"}` (kein `Z`, aber der Eigenschaftsname behauptet UTC) parst zu `DateTimeKind.Unspecified`. Es wirft nicht, aber der Round-Trip ist falsch: `ToUniversalTime` wird es als lokal behandeln. Reparieren Sie entweder den Producer, sodass er das `Z` ausgibt, oder verwenden Sie `DateTimeOffset`, damit der Offset explizit ist. Noch besser: Modellieren Sie den Wert als `DateTime` mit einem Konverter, der `Kind == Utc` zusichert und bei allem anderen wirft; das Strict-Konverter-Pattern fängt Drift früh ab.

## Varianten, die wie dieser Fehler aussehen, es aber nicht sind

### "The JSON value could not be converted to System.DateTimeOffset"

Gleiche Ursachenfamilie, leicht anderer Bereich. `DateTimeOffset` verlangt einen expliziten Offset (`Z` oder `+hh:mm`) und lehnt Strings in `Unspecified`-Form ab, die ein nacktes `DateTime` akzeptieren würde. Die Lösung hat dieselbe Form: Senden Sie den Offset oder schreiben Sie einen Konverter. Vermeiden Sie es, ein `DateTimeOffset` durch ein `DateTime` zu schicken, wenn Sie eines in der Domäne haben, die Offset-Information ist Datum.

### "Cannot get the value of a token type 'Number' as a String"

Andere Exception, anderer Stack. Bedeutet, dass der Konverter oder der Default-Reader `GetString()` an einem JSON-`Number`-Token aufgerufen hat. Die Lösung ist, vor dem Lesen über `reader.TokenType` zu verzweigen. Der Konverter aus Variante 3 oben ist die kanonische Form.

### "A possible object cycle was detected"

Referenzzyklus, kein Datums-Parsing. Setzen Sie `ReferenceHandler = ReferenceHandler.IgnoreCycles` (oder `Preserve` für vollständigen Graph-Round-Trip) an den Optionen. Geht die Trade-offs im [Cycle-Handling-Guide](/de/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) durch (derselbe Konverter-Beitrag deckt die Cycle-Option in seiner Gotchas-Sektion ab).

### "The JSON value could not be converted to System.Guid"

Identische Exception-Klasse (`JsonException`), identische Nachrichtenform, anderer Zieltyp. Die Ursache ist ähnlich: Der Guid-String liegt in keinem der vier Formate vor, die `System.Text.Json` akzeptiert (`D`, `N`, `B`, `P`). Die Lösung ist wieder, entweder den Producer auf `D` (die Form mit Bindestrichen) zu fixen oder einen Konverter zu schreiben, der `Guid.ParseExact` aufruft.

### "The JSON value could not be converted to System.Enum"

Gleiche Familie. Die Lösung ist `JsonStringEnumConverter` (eingebaut), an den Optionen registriert; der Konverter akzeptiert sowohl numerische als auch String-Formen und ist hinsichtlich Groß-/Kleinschreibung konfigurierbar. Pro Enum ist es ab .NET 8 auch mit `[JsonConverter(typeof(JsonStringEnumConverter<MyEnum>))]` möglich, was unter Trimming vorzuziehen ist, weil es nicht über jedes Enum im Assembly reflektiert.

## Verwandt

Für die Konverter-Struktur, auf der die obigen Lösungen aufbauen, behandelt der [Custom-JsonConverter-Walkthrough](/de/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) die Byte-Span-Parsing-Tricks für Hot Paths. Der [Beitrag zur PascalCase-Pro-Member-Benennung](/de/2026/04/system-text-json-11-pascalcase-per-member-naming/) zeigt die `[JsonPropertyName]`- und Naming-Policy-Ausweichlösungen, die die verwandten 400-Fehler "falscher Eigenschaftsname" beheben. Wird Ihr DateTime in EF Core 11 als JSON-Spalte persistiert, erklärt der [SQL-Server-2025-JSON-contains-Walkthrough](/de/2026/04/efcore-11-json-contains-sql-server-2025/), wie die Datenbank denselben ISO-8601-String hin- und herträgt. Für die parallele "falscher Typ"-Diagnose mit größeren Graph-Implikationen ist der [Migrationspfad von Newtonsoft zu System.Text.Json](/de/2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4/) die kanonische Fallstudie aus dem .NET-Team selbst.

## Quellen

- [DateTime and DateTimeOffset support in System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/datetime/system-text-json-support), Microsoft Learn.
- [How to write custom converters](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/converters-how-to), Microsoft Learn.
- [`DateTimeStyles` enumeration](https://learn.microsoft.com/en-us/dotnet/api/system.globalization.datetimestyles), Microsoft Learn.
- [`DateTimeOffset.FromUnixTimeSeconds`](https://learn.microsoft.com/en-us/dotnet/api/system.datetimeoffset.fromunixtimeseconds), Microsoft Learn.
- [System.Text.Json source repository](https://github.com/dotnet/runtime/tree/main/src/libraries/System.Text.Json), dotnet/runtime on GitHub.
- [`DateOnly` and `TimeOnly` types](https://learn.microsoft.com/en-us/dotnet/api/system.dateonly), Microsoft Learn.
