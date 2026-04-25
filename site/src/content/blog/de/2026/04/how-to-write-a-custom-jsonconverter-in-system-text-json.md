---
title: "So schreiben Sie einen benutzerdefinierten JsonConverter in System.Text.Json"
description: "Eine vollständige Anleitung zum Schreiben eines benutzerdefinierten JsonConverter<T> für System.Text.Json in .NET 11: wann Sie ihn wirklich brauchen, wie Sie Utf8JsonReader korrekt navigieren, wie Sie generische Typen mit JsonConverterFactory behandeln und wie Sie AOT-freundlich bleiben."
pubDate: 2026-04-25
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "serialization"
lang: "de"
translationOf: "2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json"
translatedBy: "claude"
translationDate: 2026-04-25
---

Um einen benutzerdefinierten Konverter für `System.Text.Json` zu schreiben, leiten Sie von `JsonConverter<T>` ab, überschreiben `Read` und `Write` und versehen entweder den Zieltyp mit `[JsonConverter(typeof(MyConverter))]` oder fügen eine Instanz zu `JsonSerializerOptions.Converters` hinzu. Innerhalb von `Read` müssen Sie den `Utf8JsonReader` exakt um die Anzahl Tokens vorrücken, die Ihr Wert umfasst, nicht mehr und nicht weniger, sonst sieht der nächste Deserialisierungsaufruf einen kaputten Stream. Innerhalb von `Write` rufen Sie Methoden direkt auf `Utf8JsonWriter` auf und allokieren keine Zwischenstrings, es sei denn, Sie müssen. Für generische Typen oder Polymorphie nutzen Sie `JsonConverterFactory`, damit eine einzige Klasse Konverter für viele geschlossene generische Instanziierungen erzeugen kann. Alles in dieser Anleitung zielt auf .NET 11 (Preview 3) und C# 14, aber die API ist seit .NET Core 3.0 stabil, sodass derselbe Code auf jeder unterstützten Laufzeit funktioniert.

## Wann ein JsonConverter das richtige Werkzeug ist

Die meisten Teams greifen zu früh zu einem benutzerdefinierten Konverter. Bevor Sie einen schreiben, prüfen Sie, ob Ihr Problem mit den eingebauten Funktionen lösbar ist, die in .NET 11 (und früher) ausgeliefert werden:

- Eigenschaftsnamen, die nicht passen: nutzen Sie `JsonPropertyNameAttribute` oder eine `JsonNamingPolicy`. Preview 3 hat `JsonNamingPolicy.PascalCase` und ein Member-Level-`[JsonNamingPolicy]`-Attribut hinzugefügt, sodass die [Naming Policies in System.Text.Json 11](/de/2026/04/system-text-json-11-pascalcase-per-member-naming/) wahrscheinlich abdecken, was Sie brauchen.
- Zahlen als Strings: `JsonNumberHandling.AllowReadingFromString` auf `JsonSerializerOptions`.
- Enums als Strings: `JsonStringEnumConverter` ist eingebaut. Es gibt sogar eine [trim-freundliche Variante für Native AOT](/2023/09/net-8-how-to-use-jsonstringenumconverter-with-native-aot/).
- Schreibgeschützte Eigenschaften oder Konstruktorparameter: der Source Generator (`[JsonSerializable]` plus `JsonSerializerContext`) behandelt Records und primäre Konstruktoren direkt.
- Polymorphie per Diskriminator: `[JsonDerivedType]` und `[JsonPolymorphic]` (in .NET 7 hinzugefügt) vermeiden fast jeden alten Konverter-Trick.

Ein benutzerdefinierter Konverter ist das richtige Werkzeug, wenn die JSON-Form und die .NET-Form wirklich auseinanderlaufen. Beispiele:

- Ein Werttyp, der als Primitiv serialisiert werden soll (`Money` wird zu `"42.00 USD"`).
- Ein Typ, dessen JSON-Form kontextabhängig ist (mal ein String, mal ein Objekt).
- Ein Baum, in dem derselbe Eigenschaftsname je nach Geschwisterfeld unterschiedliche Typen trägt.
- Ein Drahtformat, das Ihnen nicht gehört (Beträge in Cents im Stripe-Stil, ISO-8601-Dauern, RFC-5545-Wiederholungsregeln).

Falls keines davon zutrifft, nutzen Sie die eingebauten Funktionen und überspringen Sie diesen Artikel.

## Der JsonConverter<T>-Vertrag

`System.Text.Json.Serialization.JsonConverter<T>` hat zwei abstrakte Methoden, die Sie überschreiben müssen, und ein paar optionale Hooks:

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

Zwei Dinge in dieser Signatur kann man leicht falsch machen:

1. `Read` erhält `Utf8JsonReader` per `ref`. Der Reader ist ein veränderlicher Struct, der den Cursor besitzt. Wenn Sie ihn an eine Hilfsmethode übergeben, übergeben Sie ihn ebenfalls per `ref`, sonst wird der Cursor des Aufrufers nicht weiterrücken und Sie lesen ewig dasselbe Token.
2. `HandleNull` ist standardmäßig `false`, was bedeutet, dass der Serialisierer für JSON-`null` `default(T)` zurückgibt und Ihren Konverter nie aufruft. Wenn Sie `null` auf einen Nicht-Default-Wert abbilden müssen (oder zwischen "fehlend" und "null" unterscheiden), setzen Sie `HandleNull => true` und prüfen Sie selbst `reader.TokenType == JsonTokenType.Null`.

Der vollständige Vertrag ist auf der offiziellen MS-Learn-Seite zum [Schreiben benutzerdefinierter Konverter](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/converters-how-to) dokumentiert. Der Rest dieses Beitrags ist die praktische Version.

## Ein durchgearbeitetes Beispiel: ein Money-Werttyp

Nehmen Sie einen stark typisierten `Money`-Wert:

```csharp
// .NET 11, C# 14
public readonly record struct Money(decimal Amount, string Currency)
{
    public override string ToString() =>
        $"{Amount.ToString("0.00", CultureInfo.InvariantCulture)} {Currency}";
}
```

Das Standardverhalten von `System.Text.Json` serialisiert ihn als `{"Amount":42.00,"Currency":"USD"}`. Wir wollen stattdessen ein einzelnes String-Token: `"42.00 USD"`. Das ist genau die Art von Form-Diskrepanz, für die ein Konverter da ist.

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

Ein paar Details, die der Erwähnung wert sind:

- `reader.GetString()` materialisiert einen verwalteten `string`. Wenn Sie Millionen von Datensätzen deserialisieren und der geparste Wert kurzlebig ist, bevorzugen Sie `reader.ValueSpan` (UTF-8-Bytes) plus `Utf8Parser`, um die Allokation zu vermeiden.
- `writer.WriteStringValue(ReadOnlySpan<char>)` codiert UTF-8 direkt in den gepoolten Puffer des Writers. Es gibt keinen Zwischen-`string`. Diese Überladung sowie `WriteStringValue(ReadOnlySpan<byte> utf8)` sind der günstige Pfad.
- `JsonException` ist die kanonische "die Daten sind falsch"-Exception. Der Serialisierer umhüllt sie mit Zeilen- und Positionsinformationen, bevor sie den Aufrufer erreicht, sodass Sie diese nicht selbst hinzufügen müssen.

## Korrekt lesen: Cursor-Disziplin

Der mit Abstand häufigste Fehler in benutzerdefinierten Konvertern ist, den Reader nicht auf dem richtigen Token stehen zu lassen. Der Vertrag lautet:

> Wenn `Read` zurückkehrt, muss der Reader auf dem **letzten von Ihrem Wert verbrauchten Token** positioniert sein, nicht auf dem nächsten.

Der Serialisierer ruft zwischen den Werten einmal `reader.Read()` auf. Verbraucht Ihr Konverter zu viele Tokens, wird die nächste Eigenschaft stillschweigend übersprungen. Verbraucht er zu wenige, sieht der nächste Deserialisierungsaufruf einen fehlerhaften Stream und wirft auf einem Token, das er nicht erwartet hat.

Zwei Regeln decken fast jeden Fall ab:

1. Bei einem Einzel-Token-Wert (String, Zahl, Boolean) tun Sie nichts außer dem aktuellen Token zu lesen. Der Cursor steht beim Aufruf von `Read` bereits auf dem richtigen Token.
2. Bei einem Objekt oder Array schleifen Sie, bis Sie das passende `EndObject`- oder `EndArray`-Token sehen, und lassen das letzte `reader.Read()` der Schleife genau auf diesem schließenden Token landen.

Hier ist das kanonische Skelett zum Lesen eines Objekts:

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

`reader.Skip()` ist der unterschätzte Helfer: er geht über alles hinweg, was das aktuelle Token einleitet, einschließlich eines verschachtelten Objekts oder Arrays, und lässt den Cursor auf dessen schließendem Token stehen. Nutzen Sie es für alles, was Sie nicht verstehen, und schreiben Sie nie eine eigene Skip-Schleife.

## Effizient schreiben: bleiben Sie auf dem Writer

`Utf8JsonWriter` schreibt direkt in einen gepoolten UTF-8-Puffer, daher sollte alles, was keinen verwalteten `string` erfordert, vom Heap fernbleiben. Drei Regeln:

1. Bevorzugen Sie die typisierten Überladungen: `WriteNumber`, `WriteBoolean`, `WriteString(ReadOnlySpan<char>)`. Sie formatieren in den Puffer.
2. Für Eigenschaft-Wert-Paare innerhalb eines Objekts nutzen Sie `WriteString("name", value)` und Verwandte. Sie geben Eigenschaftsnamen und Wert in einem Aufruf aus, ohne zu allokieren.
3. Wenn Sie einen String bauen müssen, nutzen Sie `string.Create` oder eine stack-allokierte `Span<char>` statt `string.Format` oder Interpolation, die beide allokieren.

Für das obige `Money`-Beispiel nutzt eine noch günstigere Version UTF-8 direkt:

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

Diese Version erzeugt nie einen verwalteten String für den formatierten Wert. Für einen Service, der Zehntausende von `Money`-Instanzen pro Sekunde serialisiert, ist das ein messbarer Unterschied in der Allokationsrate.

## Generische Typen und JsonConverterFactory

`JsonConverter<T>` ist ein geschlossener Typ. Wenn Sie einen Konverter für `Result<TValue, TError>` wollen, der für jede geschlossene Generik funktioniert, schreiben Sie eine `JsonConverterFactory`, die die geschlossenen Konverter bei Bedarf erzeugt:

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

Die Factory wird auf dieselbe Weise registriert wie ein regulärer Konverter (Attribut oder `Options.Converters.Add`). Der Serialisierer cached den geschlossenen Konverter pro geschlossener Generik, sodass `CreateConverter` einmal pro `(TValue, TError)`-Paar pro `JsonSerializerOptions`-Instanz läuft.

`Activator.CreateInstance` plus `MakeGenericType` ist Reflection, was Native AOT und Trim feindlich gegenübersteht. Wenn Sie auf AOT zielen, lesen Sie den AOT-Abschnitt unten.

## Einen Konverter registrieren

Zwei Wege, und sie haben unterschiedliche Priorität:

```csharp
// .NET 11, C# 14
[JsonConverter(typeof(MoneyJsonConverter))]
public readonly record struct Money(decimal Amount, string Currency);
```

Das Attribut bindet den Konverter an den Typ und wird von jedem `JsonSerializer`-Aufruf ohne Per-Options-Setup berücksichtigt. Nutzen Sie es für Werttypen, die Ihnen gehören.

```csharp
// .NET 11, C# 14
var options = new JsonSerializerOptions
{
    Converters = { new MoneyJsonConverter() }
};

string json = JsonSerializer.Serialize(invoice, options);
```

Die Registrierung auf Options-Ebene ist die richtige Antwort, wenn Ihnen der Zieltyp nicht gehört, wenn der Konverter umgebungsspezifisch ist (Test vs. Prod) oder wenn ein einzelner Typ in unterschiedlichen Kontexten unterschiedliche Formen braucht (eine öffentliche API vs. ein internes Log).

Die Suchreihenfolge, von höchster zu niedrigster Priorität:

1. Der Konverter, der direkt an einen `JsonSerializer`-Aufruf übergeben wird.
2. `[JsonConverter]` an der Eigenschaft.
3. `Options.Converters` (zuletzt hinzugefügt gewinnt für passende Typen).
4. `[JsonConverter]` am Typ.
5. Der eingebaute Default für diesen Typ.

Wenn zwei Konverter denselben Typ über unterschiedliche Mechanismen beanspruchen, gewinnt derjenige, der in dieser Liste höher steht. Skizzieren Sie das im Kopf, bevor Sie debuggen "warum läuft mein Konverter nicht": fast immer überschreibt ein Property-Attribut oder ein Options-Eintrag das Typ-Attribut.

## Source Generation und Native AOT

`JsonConverter<T>` funktioniert mit dem Source Generator: deklarieren Sie den Typ in Ihrem `JsonSerializerContext` und der Generator emittiert einen Metadaten-Provider, der dort, wo angebracht, an Ihren Konverter delegiert. Dasselbe gilt **nicht** automatisch für `JsonConverterFactory`. Alles, was die Factory mit `MakeGenericType` oder `Activator.CreateInstance` tut, ist Reflection, was Trim und AOT statisch nicht sehen können.

Für AOT-freundliche Factories tun Sie eines von beidem:

- Beschränken Sie die Factory auf eine bekannte, endliche Menge geschlossener Generika und instanziieren Sie sie direkt mit `new ResultConverter<MyValue, MyError>()` pro Paar.
- Annotieren Sie die Factory mit `[RequiresDynamicCode]` und `[RequiresUnreferencedCode]`, akzeptieren Sie die Trim-Warnungen und dokumentieren Sie, dass AOT-Konsumenten den geschlossenen Konverter manuell registrieren müssen.

Das Muster, Interceptors zu nutzen, damit `JsonSerializer.Serialize`-Aufrufe automatisch einen generierten Kontext aufgreifen, behandelt im [C#-14-Interceptor-Vorschlag für quellgenerierten JSON](/2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics/), ist unabhängig von Konvertern: selbst damit schreiben Sie Ihren benutzerdefinierten `JsonConverter<T>` weiterhin auf dieselbe Weise.

## Stolperfallen, in der Reihenfolge, wie oft sie zuschlagen

- **Vergessen, den Reader über `EndObject`/`EndArray` hinauszubewegen.** Symptom: die nächste Eigenschaft im übergeordneten Objekt wird stillschweigend übersprungen oder der Parser wirft zwei Ebenen weiter oben einen verwirrenden Fehler. Prüfen Sie, indem Sie einen Konverter-Test schreiben, der `{ "wrapped": <yourThing>, "next": 1 }` deserialisiert und sicherstellt, dass `next` gelesen wird.
- **`JsonSerializer.Deserialize<T>(ref reader, options)` für denselben `T` aufrufen, den Ihr Konverter behandelt.** Das rekursiert unendlich. Rekursion durch den Serialisierer ist für *andere* Typen (Kinder, verschachtelte Werte).
- **Den `Utf8JsonReader` über ein `await` hinweg halten.** Der Reader ist ein `ref struct`, der Compiler lässt es nicht zu, aber Sie könnten versucht sein, Werte in lokale Variablen zu kopieren und später wieder anzubinden. Tun Sie es nicht. Lesen Sie den gesamten Wert synchron innerhalb von `Read`. Wenn Ihre Datenquelle asynchron ist, puffern Sie zuerst in eine `ReadOnlySequence<byte>` und übergeben Sie diese an den Reader.
- **Etwas anderes als `JsonException` für fehlerhafte Daten werfen.** Andere Exceptions überschreiten die Serialisierer-Grenze unverpackt und verlieren den Zeilen-/Positionskontext.
- **`JsonSerializerOptions` nach dem ersten Serialisieraufruf mutieren.** Der Serialisierer cached aufgelöste Konverter pro Options-Instanz; nachfolgende Mutationen werfen `InvalidOperationException`. Bauen Sie stattdessen eine frische Options-Instanz oder rufen Sie `MakeReadOnly()` explizit auf, wenn Sie die Konfiguration abschließen.
- **`JsonConverterAttribute` auf einer Schnittstelle oder einem abstrakten Typ verwenden und Polymorphie umsonst erwarten.** So funktioniert es nicht. Nutzen Sie `[JsonPolymorphic]` und `[JsonDerivedType]` für Hierarchie-Serialisierung oder schreiben Sie einen benutzerdefinierten Konverter, der die Diskriminator-Verteilung selbst übernimmt.
- **In `Write` allokieren.** Es ist leicht, `JsonSerializer.Serialize(value)` rekursiv zu schreiben und zu vergessen, dass dabei ein `string` entsteht, den Sie dann zurück in den Writer schreiben. Nutzen Sie stattdessen die `ref Utf8JsonWriter`-Überladung von `Serialize`.

Wenn Sie das im Kopf behalten, braucht ein Konverter selten mehr als 30 Zeilen Code und läuft im selben Allokationsbudget wie der eingebaute Serialisierer.

## Verwandte Beiträge

- [How to use Channels instead of BlockingCollection in C#](/de/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) -- Async-First-Muster, dieselbe Ära des API-Designs.
- [System.Text.Json in .NET 11 Preview 3 fügt PascalCase und Per-Member-Naming hinzu](/de/2026/04/system-text-json-11-pascalcase-per-member-naming/) -- wann eine Naming Policy reicht und ein Konverter nicht.
- [How to use JsonStringEnumConverter with Native AOT](/2023/09/net-8-how-to-use-jsonstringenumconverter-with-native-aot/) -- die Trim-/AOT-Geschichte für eingebaute Konverter.
- [Interceptors for System.Text.Json source generation](/2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics/) -- eine parallele Ergonomie-Richtung, die es zu verfolgen lohnt.
- [How to return multiple values from a method in C# 14](/de/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/) -- die Value-Tuple- und Record-Muster, die oft einen Konverter brauchen.

## Quellen

- MS Learn: [Write custom converters for JSON serialization](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/converters-how-to)
- MS Learn: [How to use the source generator in System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation)
- API-Referenz: [`Utf8JsonReader`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.utf8jsonreader), [`Utf8JsonWriter`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.utf8jsonwriter)
- dotnet/runtime Issue Tracker für den System.Text.Json-Bereich: [area-System.Text.Json](https://github.com/dotnet/runtime/labels/area-System.Text.Json)
