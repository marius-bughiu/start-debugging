---
title: "Eine polymorphe Typhierarchie mit JsonDerivedType in System.Text.Json serialisieren"
description: "Vollständiger Leitfaden zu polymorphem JSON in .NET 11: JsonDerivedType und JsonPolymorphic, warum der deklarierte Typ alles entscheidet, die Reihenfolgeregel für $type, alle Ausnahmen dieser Funktion, das Contract-Modell für fremde Typen und was ASP.NET Core in OpenAPI ausgibt."
pubDate: 2026-07-27
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "serialization"
lang: "de"
translationOf: "2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json"
translatedBy: "claude"
translationDate: 2026-07-27
---

Damit eine Klassenhierarchie über `System.Text.Json` verlustfrei hin und zurück läuft, setzen Sie `[JsonDerivedType(typeof(Derived), "discriminator")]` für jeden unterstützten Subtyp auf den Basistyp und serialisieren und deserialisieren dann über den **Basistyp**. Der Serializer schreibt eine `$type`-Eigenschaft als erstes Mitglied des Objekts und liest sie zurück, um den richtigen Subtyp auszuwählen. Ohne Diskriminator-String gibt die Serialisierung zwar weiterhin die abgeleiteten Eigenschaften aus, die Deserialisierung materialisiert aber immer den Basistyp. Das funktioniert seit .NET 7 unverändert, und alles Folgende zielt auf .NET 11 (`net11.0`, C# 14), mit den beiden späteren Ergänzungen an den Stellen, an denen sie relevant sind: `AllowOutOfOrderMetadataProperties` (.NET 9) und `JsonSerializerOptions.Strict` (.NET 10).

## Warum die naive Variante stillschweigend Daten verliert

Der Grund, warum man nach dieser Funktion sucht, ist, dass der naheliegende Code klammheimlich das Falsche tut. Nehmen wir eine Zahlungshierarchie:

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

Serialisieren Sie ein `CardPayment` über eine als `PaymentMethod` deklarierte Variable ganz ohne Attribute, erhalten Sie `{"Amount":10}`. Die Eigenschaft `Last4` verschwindet. `System.Text.Json` löst den Vertrag über den **deklarierten** Typ auf, nicht über den Laufzeittyp, kennt also nur die Mitglieder von `PaymentMethod`. Das ist Absicht: So kann ein abgeleiteter Typ keine Eigenschaften nach außen tragen, deren Offenlegung der Aufrufer nie zugesagt hat, und das ist bei API-Antworten ein reales Sicherheitsthema.

Ein einziges Attribut ändert den Vertrag:

```csharp
// .NET 11, C# 14
[JsonDerivedType(typeof(CardPayment))]
public abstract class PaymentMethod
{
    public decimal Amount { get; set; }
}
```

Jetzt liefert `JsonSerializer.Serialize<PaymentMethod>(card)` das Ergebnis `{"Last4":"4242","Amount":10}`. Die Serialisierung ist repariert, die Deserialisierung nicht. Dieselbe Nutzlast als `PaymentMethod` zurückzulesen wirft `NotSupportedException: Deserialization of interface or abstract types is not supported. Type 'PaymentMethod'.`, weil im JSON nichts steht, welcher Subtyp zu bauen ist. Ist der Basistyp konkret statt abstrakt, ist der Fehler leiser und schlimmer: Sie bekommen eine `PaymentMethod`-Instanz und `Last4` fällt unter den Tisch. Der Diskriminator schließt den Kreis.

## Fünf Schritte zu einer verlustfrei serialisierbaren Hierarchie

1. **Machen Sie den Basistyp polymorphiefähig.** Er muss eine nicht versiegelte Klasse, eine abstrakte Klasse oder ein Interface sein. Struct, versiegelte Typen, generische Typen und `System.Object` werden abgelehnt mit `InvalidOperationException: Specified type 'X' does not support polymorphism. Polymorphic types cannot be structs, sealed types, generic types or System.Object.`

2. **Deklarieren Sie jeden Subtyp mit einem Diskriminator.** Das zweite Argument von `[JsonDerivedType]` ist der Diskriminatorwert, und erst er macht die Deserialisierung möglich.

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

3. **Serialisieren Sie über den Basistyp.** Der deklarierte Typ an der Aufrufstelle muss die polymorphe Basis sein, entweder als generisches Argument, als Eigenschaftstyp oder als Elementtyp der Auflistung.

```csharp
// .NET 11, C# 14
PaymentMethod payment = new CardPayment { Amount = 10, Last4 = "4242" };

string json = JsonSerializer.Serialize(payment);
// {"$type":"card","Last4":"4242","Amount":10}
```

Beachten Sie die Reihenfolge. `$type` wird immer zuerst geschrieben, noch vor den Eigenschaften des abgeleiteten Typs, und die Eigenschaften des Basistyps kommen zuletzt. Das ist nicht kosmetisch, wie der nächste Abschnitt erklärt.

4. **Deserialisieren Sie über den Basistyp.** Der Leser sieht `$type`, findet `CardPayment` und erzeugt es:

```csharp
// .NET 11, C# 14
PaymentMethod? back = JsonSerializer.Deserialize<PaymentMethod>(json);
Console.WriteLine(back is CardPayment); // True
```

5. **Benennen Sie den Diskriminator um, wenn `$type` mit Ihrem Wire-Format kollidiert.** `[JsonPolymorphic(TypeDiscriminatorPropertyName = "kind")]` auf dem Basistyp ändert den Eigenschaftsnamen. Zwei Dinge sind wichtig: `$id`, `$ref` und `$values` sind reserviert und werden abgelehnt, und der eigene Name läuft **nicht** durch die Namensrichtlinie. Unter `JsonSerializerOptions.Web` bleibt ein als `"Kind"` deklarierter Diskriminator `"Kind"`, während alle anderen Eigenschaften in camelCase erscheinen. Wählen Sie genau die Schreibweise, die auf der Leitung stehen soll.

Diskriminatorwerte können auch Ganzzahlen sein: `[JsonDerivedType(typeof(ClickEvent), 1)]` gibt `{"$type":1,...}` aus. `string`- und `int`-Ids in einer Hierarchie zu mischen kompiliert und läuft, macht die Nutzlast für Clients außerhalb von .NET aber schwerer konsumierbar. Entscheiden Sie sich für eine Form.

## Der deklarierte Typ entscheidet, überall

Die meisten Meldungen über einen "fehlenden Diskriminator" laufen auf eine Aufrufstelle hinaus, an der der deklarierte Typ die abgeleitete Klasse ist. Die Regel ist mechanisch und lohnt sich als Tabelle. Alles Folgende wurde gegen dieselbe Hierarchie oben ausgeführt:

| Aufrufstelle | Ausgabe |
| --- | --- |
| `Serialize<PaymentMethod>(card)` | `{"$type":"card","Last4":"4242","Amount":10}` |
| `Serialize<CardPayment>(card)` | `{"Last4":"4242","Amount":10}` |
| `Serialize(card)`, wobei `card` als `CardPayment` typisiert ist | `{"Last4":"4242","Amount":10}` |
| `Serialize<object>(card)` | `{"$type":"card","Last4":"4242","Amount":10}` |
| Element in `List<PaymentMethod>` | `[{"$type":"card",...}]` |
| Als `PaymentMethod` deklarierte Eigenschaft | `{"Method":{"$type":"card",...}}` |
| Als `CardPayment` deklarierte Eigenschaft | `{"Concrete":{"Last4":"9","Amount":3}}` |

Die `object`-Zeile überrascht viele. `System.Object` selbst kann keine polymorphe Basis sein, aber wenn der deklarierte Typ `object` ist, löst der Serializer den Laufzeittyp auf und wendet dann die polymorphe Konfiguration des nächstgelegenen konfigurierten Vorfahren dieses Typs an. `Serialize<object>(card)` gibt den Diskriminator also aus, und `Serialize<object>(someUndeclaredSubtype)` wirft genau wie der Aufruf über den Basistyp. Die Deserialisierung nach `object` ist nicht symmetrisch: Sie erhalten ein `JsonElement`, kein `CardPayment`.

In ASP.NET Core ist der deklarierte Typ der Rückgabetyp des Endpunkts, die Tabelle gilt also genauso für Minimal APIs:

```csharp
// .NET 11, C# 14
app.MapGet("/payments/latest", () => (PaymentMethod)card);      // {"$type":"card","last4":"4242","amount":10}
app.MapGet("/payments/card",   () => card);                     // {"last4":"4242","amount":10}
app.MapGet("/typed",  () => TypedResults.Ok((PaymentMethod)card)); // discriminator present
app.MapGet("/typed2", () => TypedResults.Ok(card));             // discriminator absent
```

`TypedResults.Ok(card)` leitet `Ok<CardPayment>` ab, und dieses generische Argument ist der deklarierte Typ bis hinunter zu `WriteAsJsonAsync`. Muss ein Endpunkt eine Hierarchie zurückgeben, typisieren Sie den Rückgabewert des Lambdas als Basis oder verwenden Sie eine explizite `Results<T1, T2>`-Union, damit die Form für den Serializer und den OpenAPI-Generator sichtbar ist. Den Basistyp zurückzugeben empfiehlt auch der [Leitfaden zu Typed-Results-Unions](/de/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/) für alles, worauf ein Client verzweigen muss.

## Die Eigenschaft `$type` muss zuerst kommen

Standardmäßig muss der Diskriminator am Anfang des JSON-Objekts stehen, gruppiert mit den anderen Metadaten-Eigenschaften `$id` und `$ref`. Diese Nutzlast wird deserialisiert:

```json
{"$type":"card","Amount":10,"Last4":"4242"}
```

Diese wirft `NotSupportedException: The JSON payload for polymorphic interface or abstract type 'PaymentMethod' must specify a type discriminator.`:

```json
{"Amount":10,"$type":"card","Last4":"4242"}
```

Der Grund ist Streaming. Ein einziger Vorwärtsdurchlauf bedeutet, dass der Leser den Zieltyp kennen muss, bevor er Mitglieder bindet. Die Ausnahmemeldung führt beim Überfliegen in die Irre, denn der Diskriminator *ist* in der Nutzlast, nur zu spät.

Seit .NET 9 gibt es ein Opt-in:

```csharp
// .NET 11, C# 14, requires .NET 9 or later
var options = new JsonSerializerOptions { AllowOutOfOrderMetadataProperties = true };
var back = JsonSerializer.Deserialize<PaymentMethod>(json, options); // works
```

Die Kosten sind real, schalten Sie das also nicht unbedacht global ein. Mit gesetztem Flag kann der Deserializer die Eigenschaften nicht mehr in einem Durchlauf verarbeiten und puffert das gesamte JSON-Objekt vor dem Binden im Speicher. Bei einem 200 Byte großen Ereignis ist das kostenlos. Bei einem mehrere Megabyte großen Dokument, das aus Blob Storage gestreamt wird, ist es ein Out-of-Memory-Risiko. Kommt die Nutzlast aus einem System, das Sie kontrollieren, reparieren Sie stattdessen den Schreiber. Die häufigste Quelle für Diskriminatoren in falscher Reihenfolge ist der Umweg über die Datenbank: PostgreSQL-`jsonb`-Spalten normalisieren die Schlüsselreihenfolge, sodass ein korrekt geschriebenes Dokument mit `$type` in der Mitte zurückkommen kann.

## Alle Ausnahmen dieser Funktion

Das sind die exakten Laufzeitmeldungen, was sie durchsuchbar macht und die Fehlereingrenzung beschleunigt.

| Meldung | Ursache | Lösung |
| --- | --- | --- |
| `Specified type 'X' does not support polymorphism. Polymorphic types cannot be structs, sealed types, generic types or System.Object.` | `[JsonDerivedType]` auf einem Struct, einer versiegelten Klasse oder einem offenen Generic | Versiegelung der Basis entfernen oder eine nicht generische Basis bzw. ein Interface einführen |
| `Runtime type 'X' is not supported by polymorphic type 'Y'.` | Serialisierung eines nie deklarierten Subtyps | `[JsonDerivedType(typeof(X), "...")]` ergänzen oder `UnknownDerivedTypeHandling` setzen |
| `The JSON payload for polymorphic interface or abstract type 'X' must specify a type discriminator.` | Diskriminator fehlt oder ist nicht die erste Eigenschaft | `$type` zuerst ausgeben oder `AllowOutOfOrderMetadataProperties` setzen |
| `Read unrecognized type discriminator id 'x'.` | Die Nutzlast nennt einen nicht deklarierten Subtyp | Deklarieren oder `IgnoreUnrecognizedTypeDiscriminators = true` setzen |
| `The polymorphic type 'X' has already specified a type discriminator 'y'.` | Zwei `[JsonDerivedType]`-Attribute teilen sich eine Id | Diskriminator-Ids je Hierarchie eindeutig machen |
| `The type 'X' contains property '$type' that conflicts with an existing metadata property name.` | Eine echte Eigenschaft serialisiert unter dem Diskriminatornamen | Eigenschaft umbenennen, mit `[JsonIgnore]` ausschließen oder den Diskriminator umbenennen |
| `Runtime type 'X' has a diamond ambiguity between derived types 'A' and 'B'.` | `FallBackToNearestAncestor` mit zwei gleich nahen Vorfahren | `X` explizit deklarieren, damit kein Fallback nötig ist |
| `Deserialization of interface or abstract types is not supported. Type 'X'.` | Abstrakte Basis ohne jeglichen deklarierten Diskriminator | Jedem `[JsonDerivedType]` eine Diskriminator-Id geben |

Der Fall des unbekannten Diskriminators wirft `JsonException`; der Rest wirft `NotSupportedException` oder `InvalidOperationException`. Diese Unterscheidung zählt, wenn Sie Serialisierungsfehler abfangen, um einen 400er zurückzugeben: `JsonException` ist der Topf "fehlerhafte Eingabe", `NotSupportedException` bedeutet hier fast immer einen Konfigurationsfehler auf Ihrer Seite.

## Umgang mit nicht deklarierten Subtypen

Standardmäßig ist ein nicht deklarierter Subtyp beim Schreiben ein harter Fehler, und das ist die richtige Voreinstellung: Stilles Zurückfallen auf den Basisvertrag ist genau der Weg, auf dem Eigenschaften aus Produktionsnutzlasten verschwinden. Wenn Sie ein sanfteres Fehlerverhalten wollen, bietet `[JsonPolymorphic]` den Schalter:

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

Mit dieser Konfiguration schreibt die Serialisierung eines `DeepNode` als `Node` schlicht `{"Label":"x"}`, statt zu werfen, und das Lesen von `{"$type":"unknown","Label":"x"}` liefert einen einfachen `Node`. Beide Einstellungen ergeben nur Sinn, wenn der Basistyp konkret und instanziierbar ist. `IgnoreUnrecognizedTypeDiscriminators` auf einer abstrakten Basis verschiebt den Fehler nur um einen Schritt, denn es gibt weiterhin nichts zu instanziieren.

Die dritte Option, `JsonUnknownDerivedTypeHandling.FallBackToNearestAncestor`, geht bis zum nächstgelegenen deklarierten Vorfahren hoch. Sie ist nützlich für Interface-Hierarchien, in denen andere Teams Implementierungen ergänzen, und sie ist die einzige Einstellung, die den Diamant-Mehrdeutigkeitsfehler auslösen kann: Implementiert ein Typ zwei Interfaces, die beide als abgeleitete Typen der Wurzel deklariert sind, verweigert der Serializer das Raten.

## Die Konfiguration wird nicht nach unten vererbt

Das kostet viele einen Nachmittag. Polymorphe Konfiguration auf einem Basistyp reicht nicht durch Zwischentypen hindurch:

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

`Middle` kennt `Leaf`, `Root` aber nicht, und der Serializer setzt die beiden Konfigurationen nicht zusammen. Jede polymorphe Basis muss jeden konkreten Typ aufzählen, der unter ihr auftreten kann, Enkel eingeschlossen. `Leaf` sowohl auf `Root` als auch auf `Middle` zu deklarieren funktioniert, und jede Ebene darf ihre eigene Diskriminator-Id verwenden, da die Id gegen den an der Aufrufstelle deklarierten Basistyp aufgelöst wird.

## Wenn Sie den Basistyp nicht annotieren können

Attribute sind unerreichbar bei Typen aus einem NuGet-Paket, aus einem generierten Client oder aus einer geteilten Contracts-Assembly, die Sie nicht anfassen dürfen. Das Contract-Modell löst das: Leiten Sie von `DefaultJsonTypeInfoResolver` ab und hängen Sie `PolymorphismOptions` an die `JsonTypeInfo` des Basistyps.

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

Der Resolver läuft einmal pro Typ und das Ergebnis wird auf der Options-Instanz zwischengespeichert, die Reflexionskosten fallen also beim Start an, nicht pro Aufruf. Das ist auch der Notausgang, wenn der Diskriminator pro Endpunkt oder pro Mandant variieren muss: Bauen Sie zwei Options-Instanzen mit zwei Resolvern, statt eine zu mutieren. Options werden nach dem ersten Serialisierungsaufruf schreibgeschützt, dieselbe Einschränkung wie im [Leitfaden zu eigenen JsonConvertern](/de/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/).

## Source Generator und Native AOT

Polymorphie funktioniert mit dem Source Generator, aber nur im Metadata-Modus. Der schnelle Pfad (`JsonSourceGenerationMode.Serialization`) gibt fest verdrahtete `Utf8JsonWriter`-Aufrufe für eine bekannte Form aus und hat keine Stelle, an der er auf den Laufzeittyp verzweigen könnte, und scheitert deshalb mit `InvalidOperationException: TypeInfoResolver 'MyContext' did not provide property metadata for type 'CardPayment'.`

```csharp
// .NET 11, C# 14
[JsonSerializable(typeof(PaymentMethod))]
[JsonSourceGenerationOptions(GenerationMode = JsonSourceGenerationMode.Metadata)]
public partial class PaymentContext : JsonSerializerContext { }

string json = JsonSerializer.Serialize(payment, PaymentContext.Default.PaymentMethod);
// {"$type":"card","Last4":"4242","Amount":10}
```

Den Basistyp zu registrieren genügt; der Generator folgt `[JsonDerivedType]` und erzeugt Metadaten für jeden deklarierten Subtyp. Genau das macht das Muster trimming- und AOT-sicher, und darum ist Polymorphie eine der wenigen reflexionsartigen Funktionen, die eine Veröffentlichung mit [Native AOT und Minimal APIs](/de/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) übersteht. Nicht übersteht sie jeder Subtyp, der erst zur Laufzeit existiert, etwa einer aus einer Mocking-Bibliothek oder dynamisch erzeugt.

## Was ASP.NET Core in das OpenAPI-Dokument schreibt

Der eingebaute Generator `Microsoft.AspNetCore.OpenApi` liest dieselben Attribute, ein polymorpher Antworttyp dokumentiert sich also selbst. Für die Zahlungshierarchie von oben lautet das erzeugte Schema:

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

Jedes abgeleitete Schema erhält eine `$type`-Eigenschaft als Enum mit genau einem Wert, und das erlaubt Client-Generatoren, eine getaggte Union zu erzeugen. Ein Hinweis aus der Dokumentation ist eine Wiederholung wert: Das Schlüsselwort `discriminator` erscheint nur, wenn der Basistyp **abstrakt** ist. Eine konkrete Basis kann `$type` im Sinne von OpenAPI nicht als erforderlich markieren, weil Instanzen der Basis selbst keinen Diskriminator haben, also lässt der Generator das discriminator-Objekt weg. Ist das Dokument ein Liefergegenstand, machen Sie die Basis abstrakt. Wenn Sie daran etwas umformen müssen, geschieht das in einem Schema-Transformer, beschrieben im [Leitfaden zu OpenAPI-Transformern](/de/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/).

## Kleinere Stolperfallen

- **Record funktionieren, auch positionelle.** `[JsonDerivedType(typeof(TextMessage), "text")]` auf einem abstrakten Record führt `TextMessage(string Body)` ohne Zusatzaufwand hin und zurück, weil der Diskriminator gelesen wird, bevor die Konstruktorargumente gebunden werden.
- **Geschlossene generische Subtypen sind erlaubt.** Die Basis darf nicht generisch sein, aber `[JsonDerivedType(typeof(Envelope<int>), "int-envelope")]` ist in Ordnung. Jede geschlossene Instanziierung braucht ihr eigenes Attribut und ihre eigene Id.
- **Eigene Converter und Polymorphie vertragen sich nicht.** Diskriminatoren werden nur von den Standard-Convertern für Objekte, Auflistungen und Dictionaries unterstützt. Ein `JsonConverter<T>` auf dem Basistyp ersetzt die gesamte Mechanik und muss den Diskriminator selbst schreiben.
- **`JsonSerializerOptions.Strict` (.NET 10) ist kompatibel.** Die Eigenschaft `$type` gilt als Metadatum, nicht als nicht zugeordnetes Mitglied, `UnmappedMemberHandling.Disallow` lehnt sie also nicht ab. Unbekannte *Daten*-Eigenschaften werfen weiterhin, und genau darum geht es bei dem Preset.
- **`TypeNameHandling` aus Newtonsoft.Json hat bewusst kein Gegenstück.** Einen CLR-Typnamen in die Nutzlast einzubetten ist ein bekannter Vektor für Deserialisierungs-Gadgets. `[JsonDerivedType]` verlangt eine explizite Positivliste, und deshalb ist der Migrationspfad von `TypeNameHandling.All` die schärfste Kante beim [Umzug einer großen Codebasis auf System.Text.Json](/de/2026/05/migrate-from-newtonsoft-json-to-system-text-json-in-a-large-codebase/).
- **Ein falscher Diskriminator erscheint dem Aufrufer als Konvertierungsfehler.** Wenn Sie das von außen debuggen, überschneiden sich die Symptome mit der allgemeinen Fehlerfamilie [JSON value could not be converted](/de/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/).

Das mentale Modell, das alles zusammenhält: Der deklarierte Typ wählt den Vertrag, der Vertrag trägt die Positivliste der abgeleiteten Typen, und der Diskriminator ist ein Metadatum, das vor den beschriebenen Daten eintreffen muss. Jeder Fehlerfall oben ist eine Verletzung genau eines dieser drei Sätze.

## Weiterführende Artikel

- [Einen eigenen JsonConverter in System.Text.Json schreiben](/de/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/)
- [Fix: System.Text.Json.JsonException: The JSON value could not be converted](/de/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/)
- [Von Newtonsoft.Json auf System.Text.Json in einer großen Codebasis migrieren](/de/2026/05/migrate-from-newtonsoft-json-to-system-text-json-in-a-large-codebase/)
- [Native AOT mit ASP.NET Core Minimal APIs verwenden](/de/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)
- [record vs class vs struct in C#: eine Entscheidungsmatrix](/de/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/)

## Quellen

- [How to serialize properties of derived classes, MS Learn](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/polymorphism)
- [Referenz zu `JsonDerivedTypeAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonderivedtypeattribute)
- [Referenz zu `JsonPolymorphicAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonpolymorphicattribute)
- [`JsonSerializerOptions.AllowOutOfOrderMetadataProperties`, .NET 9+](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializeroptions.allowoutofordermetadataproperties)
- [Einen JSON-Vertrag mit dem Contract-Modell anpassen](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/custom-contracts)
- [OpenAPI-Metadaten in einer ASP.NET Core App einbinden](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/include-metadata)
- [Ressourcen-Strings von `System.Text.Json`, dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Text.Json/src/Resources/Strings.resx)
