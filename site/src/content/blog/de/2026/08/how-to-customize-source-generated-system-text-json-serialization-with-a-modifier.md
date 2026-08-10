---
title: "So passen Sie quellcodegenerierte System.Text.Json-Serialisierung mit einem Type-Info-Resolver-Modifier an"
description: "Einen JsonTypeInfo-Modifier an einen quellcodegenerierten JsonSerializerContext in .NET 11 anhängen: warum new MyContext(options) ihn stillschweigend verwirft, das funktionierende Setup mit WithAddedModifier, der Fast Path, den Sie aufgeben (gemessen), und die Namensrichtlinien-Falle, die den Modifier wirkungslos macht."
pubDate: 2026-08-10
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "source-generators"
  - "serialization"
  - "how-to"
lang: "de"
translationOf: "2026/08/how-to-customize-source-generated-system-text-json-serialization-with-a-modifier"
translatedBy: "claude"
translationDate: 2026-08-10
---

Um einen quellcodegenerierten `System.Text.Json`-Vertrag anzupassen, gehört der Modifier an die `JsonSerializerOptions`, niemals an den Context: `new JsonSerializerOptions { TypeInfoResolver = MyContext.Default.WithAddedModifier(MyModifier) }`. Die naheliegend wirkende Alternative, `new MyContext(optionsWithModifier)`, kompiliert, läuft und ignoriert den Modifier stillschweigend, weil der Konstruktor von `JsonSerializerContext` `TypeInfoResolver` mit dem Context selbst überschreibt. Modifier funktionieren einwandfrei mit Quellcodegenerierung, auch bei deaktivierter reflectionbasierter Serialisierung für Native AOT, kosten aber den generierten Fast Path. Alles Folgende wurde gegen .NET 10.0.5 mit SDK 10.0.201 verifiziert; die APIs sind von .NET 8 bis .NET 11 unverändert.

## Warum Vertragsanpassung und Quellcodegenerierung unvereinbar wirken

Die Vertragsanpassung kam mit .NET 7. Sie übergeben `System.Text.Json` eine `Action<JsonTypeInfo>`, und die Bibliothek ruft Sie einmal pro Typ auf, nachdem der Vertrag gebaut, aber bevor er verwendet wurde. So können Sie Eigenschaften umbenennen, entfernen, synthetische hinzufügen oder die Lese- und Schreib-Delegates umhüllen. Der kanonische Einstiegspunkt ist `DefaultJsonTypeInfoResolver.Modifiers`, und .NET 8 hat [die Erweiterungsmethode `WithAddedModifier`](/2023/10/system-text-json-how-to-modify-existing-type-info-resolver/) ergänzt, mit der sich ein Modifier über jeden `IJsonTypeInfoResolver` legen lässt, nicht nur über den reflectionbasierten.

Dieses "jeder Resolver" ist der entscheidende Punkt, denn ein quellcodegenerierter `JsonSerializerContext` **ist** ein `IJsonTypeInfoResolver`. Es gibt keinen technischen Grund, warum ein Modifier `MyContext.Default` nicht dekorieren könnte. Der Grund, warum so viele zu dem Schluss kommen, Vertrags-Modifier funktionierten nicht mit Quellcodegenerierung, ist, dass die naheliegende Verdrahtung den Modifier ohne Warnung, ohne Exception und ohne Compiler-Diagnose wegwirft.

Dies ist das Modell für den Rest des Artikels. Ein `Order` mit einem Geheimnis darin, dazu eine verschachtelte `Address` mit demselben Problem:

```csharp
// .NET 11, C# 14
public class Order
{
    public int Id { get; set; }
    public string Customer { get; set; } = "";
    public string? ApiKey { get; set; }
    public Address? ShipTo { get; set; }
}

public class Address
{
    public string City { get; set; } = "";
    public string? ApiKey { get; set; }
}

[JsonSerializable(typeof(Order))]
public partial class OrderContext : JsonSerializerContext { }
```

Und der Modifier, der jede Eigenschaft namens `ApiKey` an jeder Stelle des Objektgraphen unkenntlich macht:

```csharp
// .NET 11, C# 14
static void RedactApiKey(JsonTypeInfo typeInfo)
{
    if (typeInfo.Kind != JsonTypeInfoKind.Object)
        return;

    foreach (JsonPropertyInfo property in typeInfo.Properties)
    {
        if (property.Name != "ApiKey")
            continue;

        Func<object, object?>? get = property.Get;
        if (get is not null)
            property.Get = obj => get(obj) is null ? null : "***";
    }
}
```

## Die Verdrahtung, die funktioniert, und die, die stillschweigend nichts tut

Drei Schritte, und die Reihenfolge zählt:

1. Bauen Sie zuerst den Resolver, indem Sie `WithAddedModifier` auf der `Default`-Eigenschaft Ihres generierten Context aufrufen. Das liefert einen `JsonTypeInfoResolverWithAddedModifiers`, der an den Context delegiert und danach Ihren Callback ausführt.
2. Weisen Sie diesen Resolver einem `JsonSerializerOptions.TypeInfoResolver` zu und halten Sie die Options-Instanz in einem `static readonly`-Feld. Konstruieren Sie den `JsonSerializerContext` niemals selbst.
3. Übergeben Sie diese Options-Instanz an `JsonSerializer.Serialize` oder `JsonSerializer.Deserialize`. Übergeben Sie nicht den Context und auch keine `JsonTypeInfo`, die Sie von `MyContext.Default` geholt haben.

```csharp
// .NET 11, C# 14 - works
static readonly JsonSerializerOptions RedactingOptions = new()
{
    TypeInfoResolver = OrderContext.Default.WithAddedModifier(RedactApiKey)
};

var order = new Order
{
    Id = 7,
    Customer = "acme",
    ApiKey = "sk-live-123",
    ShipTo = new Address { City = "Cluj", ApiKey = "sk-nested-999" }
};

Console.WriteLine(JsonSerializer.Serialize(order, typeof(Order), RedactingOptions));
// {"Id":7,"Customer":"acme","ApiKey":"***","ShipTo":{"City":"Cluj","ApiKey":"***"}}
```

Beachten Sie, dass auch die verschachtelte `Address` unkenntlich gemacht wird, obwohl sie nie in einem `[JsonSerializable]`-Attribut steht. Der Generator läuft den Objektgraphen von jeder deklarierten Wurzel aus ab, also liefert `OrderContext.Default.GetTypeInfo(typeof(Address))` einen Vertrag, und der Modifier läuft dafür wie für jeden anderen Typ.

Nun die Variante, die genauso vernünftig aussieht und nichts tut:

```csharp
// .NET 11, C# 14 - modifier is silently discarded
var context = new OrderContext(new JsonSerializerOptions
{
    TypeInfoResolver = OrderContext.Default.WithAddedModifier(RedactApiKey)
});

Console.WriteLine(JsonSerializer.Serialize(order, typeof(Order), context));
// {"Id":7,"Customer":"acme","ApiKey":"sk-live-123","ShipTo":{...,"ApiKey":"sk-nested-999"}}

Console.WriteLine(context.Options.TypeInfoResolver?.GetType().Name);
// OrderContext
```

Der Konstruktor `JsonSerializerContext(JsonSerializerOptions)` kopiert Ihre Options und weist sich anschließend selbst an `TypeInfoResolver` zu, sodass der sorgfältig gebaute dekorierte Resolver schon vor der ersten Serialisierung verschwunden ist. Die Empfehlung der `System.Text.Json`-Maintainer in [dotnet/runtime-Diskussion 121304](https://github.com/dotnet/runtime/discussions/121304) lautet genau so: Verzichten Sie auf `JsonSerializerContext`-Instanzen und übergeben Sie die Options direkt an `JsonSerializer`.

Zwei weitere Wege, den Modifier zu verlieren, beide leicht versehentlich geschrieben:

```csharp
// .NET 11, C# 14 - both bypass the modifier
JsonSerializer.Serialize(order, OrderContext.Default.Order);
JsonSerializer.Serialize(order, typeof(Order), OrderContext.Default);
```

`OrderContext.Default` ist der unveränderte Vertrag. Das ist ein Feature, kein Fehler: Modifier verändern die gemeinsam genutzte `Default`-Instanz nie, sodass ein anonymisierender Resolver aus einem Teil der Anwendung nicht in einen anderen durchschlagen kann. Wenn Sie für den heißen Pfad die `JsonTypeInfo`-Überladung möchten, holen Sie die Type-Info stattdessen aus den modifizierten Options:

```csharp
// .NET 11, C# 14
var typeInfo = (JsonTypeInfo<Order>)RedactingOptions.GetTypeInfo(typeof(Order));
JsonSerializer.Serialize(order, typeInfo);   // redacted
```

## Der Vergleich mit Name ist die Falle, die in ASP.NET Core zuschlägt

`JsonPropertyInfo.Name` ist der **JSON**-Name, nachdem `PropertyNamingPolicy` angewendet wurde. In einer einfachen Konsolenanwendung mit Standard-Options ist die Namensrichtlinie null, sodass `property.Name` zufällig dem CLR-Eigenschaftsnamen entspricht und die Prüfung `== "ApiKey"` greift. Hängen Sie denselben Modifier in ASP.NET Core ein, wo die Standardrichtlinie camelCase ist, trifft die Prüfung nichts mehr:

```csharp
// .NET 11, ASP.NET Core 11
builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.TypeInfoResolver = AppJsonContext.Default.WithAddedModifier(RedactApiKey);
});
```

Mit `property.Name != "ApiKey"` liefert der Endpunkt ungerührt `{"id":7,"customer":"acme","apiKey":"sk-live-1"}`. Der Modifier lief; er hat nur nie getroffen, weil der Vertrag die Eigenschaft bereits als `apiKey` meldete.

Vergleichen Sie stattdessen mit dem CLR-Member. `JsonPropertyInfo.AttributeProvider` ist auch bei quellcodegenerierten Verträgen eine `PropertyInfo`, sodass sowohl der Membername als auch beliebige eigene Attribute verfügbar sind:

```csharp
// .NET 11, C# 14
[AttributeUsage(AttributeTargets.Property)]
public sealed class RedactAttribute : Attribute { }

static void RedactByAttribute(JsonTypeInfo typeInfo)
{
    if (typeInfo.Kind != JsonTypeInfoKind.Object)
        return;

    foreach (JsonPropertyInfo property in typeInfo.Properties)
    {
        object[]? attributes = property.AttributeProvider
            ?.GetCustomAttributes(typeof(RedactAttribute), inherit: true);

        if (attributes is not { Length: > 0 })
            continue;

        Func<object, object?>? get = property.Get;
        if (get is not null)
            property.Get = obj => get(obj) is null ? null : "***";
    }
}
```

Diese Variante übersteht jede Namensrichtlinie und lieferte in meinem Test `{"id":7,"customer":"acme","apiKey":"***"}` vom selben Minimal-API-Endpunkt.

## Was sich an einem quellcodegenerierten Vertrag tatsächlich ändern lässt

Alles, was [die Dokumentation zu benutzerdefinierten Verträgen](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/custom-contracts) für den Reflection-Resolver beschreibt, funktioniert auch über einem generierten. Ich habe jeden dieser Punkte gegen `OrderContext.Default` verifiziert:

- **Eine Eigenschaft entfernen.** `typeInfo.Properties.RemoveAt(i)` entfernt sie aus Serialisierung und Deserialisierung. Die Ausgabe wird zu `{"Id":7,"Customer":"acme","ShipTo":{"City":"Cluj"}}`.
- **Eine synthetische Eigenschaft hinzufügen.** `typeInfo.CreateJsonPropertyInfo(typeof(string), "kind")` plus ein `Get`-Delegate, danach `typeInfo.Properties.Add(...)`, hängt `"kind":"order"` an die Nutzlast an. Ein CLR-Member muss dafür nicht existieren.
- **Den Setter umhüllen.** Ein neu zugewiesenes `property.Set` läuft bei der Deserialisierung. `Customer` über einen umhüllten Setter in Großbuchstaben zu wandeln, machte aus `{"Customer":"acme"}` ein `Customer == "ACME"`.
- **Bedingtes Schreiben.** `property.ShouldSerialize = (_, value) => !string.IsNullOrEmpty((string?)value)` unterdrückte den leeren `Customer`-String, ohne den Rest des Vertrags anzutasten.
- **Zahlenbehandlung pro Typ.** `typeInfo.NumberHandling` ist der einzige Schalter, der für `JsonTypeInfoKind.None`-Verträge wie `int` gilt.

Modifier werden in der Reihenfolge angewendet, in der Sie sie hinzufügen. Bei zwei verketteten `WithAddedModifier`-Aufrufen, der erste setzt alle Namen in Kleinbuchstaben und der zweite fügt an Index 0 eine Eigenschaft `"v"` ein, entstand `{"v":"2","id":7,"customer":"acme",...}`: der Kleinbuchstaben-Durchlauf lief zuerst, sodass die später eingefügte Eigenschaft ihre Schreibweise behielt.

## Native AOT: Modifier sind nicht das, was bricht

Der ganze Grund, hier [einen Source Generator](/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) einzusetzen, sind Trimming und Native AOT. Die naheliegende Sorge ist also, ob ein angehängter Modifier Reflection wieder hereinzieht. Tut er nicht. Ich habe denselben Code erneut mit `<JsonSerializerIsReflectionEnabledByDefault>false</JsonSerializerIsReflectionEnabledByDefault>` ausgeführt, was `PublishAot` und `PublishTrimmed` für Sie setzen:

```text
IsReflectionEnabledByDefault = False
attribute-driven modifier over source-gen: {"Id":7,"Customer":"acme","ApiKey":"***","ShipTo":{"City":"Cluj","ApiKey":"***"}}
synthetic property with reflection off:    {"Id":7,...,"kind":"order"}
```

Sowohl die Attributsuche über `AttributeProvider` als auch die zur Laufzeit erzeugte Eigenschaft funktionierten. Was in dieser Konfiguration weiterhin bricht, ist die übliche Regel der Quellcodegenerierung: Jeder Wurzeltyp, der im Context fehlt, wirft eine Exception, und der Modifier hat damit nichts zu tun:

```text
NotSupportedException: JsonTypeInfo metadata for type '<>f__AnonymousType0`1[System.Int32]'
was not provided by TypeInfoResolver of type
'System.Text.Json.Serialization.Metadata.JsonTypeInfoResolverWithAddedModifiers'.
```

Wenn Sie auf den verwandten Fehler zur [deaktivierten reflectionbasierten Serialisierung](/2026/07/fix-reflection-based-serialization-has-been-disabled-for-this-application/) stoßen, fehlt ein Resolver, der Modifier ist nicht defekt.

## Der eigentliche Preis: Sie geben den generierten Fast Path auf

Die Quellcodegenerierung kennt zwei Modi. Der Metadatenmodus verlagert den Vertragsaufbau auf die Kompilierzeit. Der Serialisierungsoptimierungsmodus erzeugt zusätzlich einen handgeschriebenen Writer, der direkt `Utf8JsonWriter` aufruft. Laut [der Dokumentation zu den Quellcodegenerierungsmodi](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation-modes) verlässt der Serializer diesen Fast Path, sobald die Options etwas verlangen, das der generierte Writer nicht ausdrücken kann, und ein modifizierter Vertrag ist genau das.

Gemessen mit BenchmarkDotNet 0.15.8 auf .NET 10.0.5 (Intel Core Ultra 7 265KF, 20 Kerne), Serialisierung des obigen `Order` mit vier Eigenschaften:

| Methode | Mittelwert | Ratio | Alloziert | Alloc Ratio |
| --- | ---: | ---: | ---: | ---: |
| Source-Gen, ohne Modifier | 88,76 ns | 1,00 | 200 B | 1,00 |
| Source-Gen + Modifier | 136,83 ns | 1,54 | 496 B | 2,48 |
| Reflection-Resolver, ohne Modifier | 136,23 ns | 1,53 | 512 B | 2,56 |
| Reflection-Resolver + Modifier | 138,97 ns | 1,57 | 496 B | 2,48 |

Ein Modifier kostet bei dieser Nutzlast rund 54 % Durchsatz und das 2,5-fache an Allokationen und bringt die Quellcodegenerierung genau dorthin, wo der Reflection-Resolver ohnehin schon lag. Die Vorteile bei Startzeit und Trimming bleiben erhalten, weil der Vertragsaufbau weiterhin zur Kompilierzeit stattfindet; Sie verlieren nur den optimierten Writer. Für die meisten APIs ist das ein vertretbarer Handel, aber man sollte es wissen, bevor man einen Modifier an einen heißen Serialisierungspfad hängt und sich wundert, warum sich die Zahlen nicht bewegen.

## GenerationMode = Serialization macht Ihren Modifier zum stillen No-Op

Das ist der Fehlerfall, der am ehesten nach "Modifier funktionieren nicht mit Quellcodegenerierung" aussieht. Wenn Sie einen Context auf reine Fast-Path-Generierung festlegen, gibt es keine Eigenschaftsmetadaten, die der Modifier durchlaufen könnte:

```csharp
// .NET 11, C# 14 - do not do this if you want a modifier
[JsonSourceGenerationOptions(GenerationMode = JsonSourceGenerationMode.Serialization)]
[JsonSerializable(typeof(Order))]
public partial class FastPathOnlyContext : JsonSerializerContext { }
```

Ich habe die Vertragsform für alle drei Generierungsmodi ausgegeben:

```text
Default mode         Kind=Object Properties=4
Serialization only   Kind=Object Properties=0
Metadata only        Kind=Object Properties=4
```

Bei `Properties=0` wird der Modifier einmal aufgerufen, iteriert über nichts und kehrt zurück. Die Serialisierung gelingt mit der ursprünglichen, nicht anonymisierten Nutzlast. Die Deserialisierung nicht, und die Meldung ist immerhin eindeutig:

```text
InvalidOperationException: TypeInfoResolver
'System.Text.Json.Serialization.Metadata.JsonTypeInfoResolverWithAddedModifiers'
did not provide property metadata for type 'Order'.
```

Der Standard-Generierungsmodus erzeugt sowohl Metadaten als auch den Fast Path, und genau das wollen Sie: Der Fast Path greift, wenn kein Modifier angehängt ist, und der Metadatenpfad übernimmt, sobald einer vorhanden ist.

## Options zwischenspeichern und nach dem ersten Gebrauch nicht mehr verändern

Verträge werden pro `JsonSerializerOptions`-Instanz zwischengespeichert, nicht global. Dreimal über dasselbe zwischengespeicherte Options-Objekt zu serialisieren, rief meinen Modifier insgesamt 4-mal auf, einmal pro Typ im Graphen. Frische `JsonSerializerOptions` innerhalb der Schleife zu bauen, rief ihn 12-mal auf und baute jeden Vertrag neu:

```text
modifierCalls after 3 serializations (cached options)  = 4
modifierCalls after 3 serializations (fresh options)   = 12
```

Sobald eine Options-Instanz benutzt wurde, sind sowohl sie als auch die daraus entstandenen Verträge eingefroren. `WriteIndented` nach der ersten Serialisierung zuzuweisen, wirft `InvalidOperationException: This JsonSerializerOptions instance is read-only or has already been used in serialization or deserialization`, und der Griff nach `options.GetTypeInfo(...)`, um nachträglich `Properties` zu bearbeiten, wirft das `JsonTypeInfo`-Pendant. Alle Vertragsänderungen müssen im Modifier passieren.

Wenn Sie mehrere Resolver übereinanderlegen wollen statt eines einzelnen dekorierten Context, akzeptiert [`TypeInfoResolverChain`](/2023/10/add-remove-typeinforesolver-to-existing-jsonserializeroptions/) den dekorierten Resolver genauso wie den einfachen, und die Kette wird der Reihe nach abgefragt, bis ein Vertrag ungleich null zurückkommt. Dasselbe Muster deckt eine Hierarchie ab, die bereits [`JsonDerivedType` für Polymorphie](/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/) verwendet, denn die abgeleiteten Verträge laufen wie jeder andere Typ durch den Modifier.

Die Kurzfassung zum Merken: Dekorieren Sie den Resolver, nie den Context, prüfen Sie gegen `AttributeProvider` statt gegen `Name`, lassen Sie den Generierungsmodus auf dem Standard und speichern Sie die Options zwischen.

## Quellen

- [Benutzerdefinierte Serialisierungs- und Deserialisierungsverträge](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/custom-contracts) auf MS Learn
- [Quellcodegenerierungsmodi in System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation-modes) auf MS Learn
- [dotnet/runtime-Diskussion 121304: JSON-Vertrags-Modifier und Quellcodegenerierung](https://github.com/dotnet/runtime/discussions/121304)
- [API-Referenz zu `JsonTypeInfoResolver.WithAddedModifier`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.metadata.jsontypeinforesolver.withaddedmodifier), verfügbar von .NET 8 bis .NET 11
