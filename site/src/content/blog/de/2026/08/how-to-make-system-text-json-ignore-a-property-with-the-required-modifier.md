---
title: "Wie System.Text.Json eine Eigenschaft mit dem required-Modifikator ignoriert"
description: "[JsonIgnore] auf einem required-Member wirft InvalidOperationException: marked required but does not specify a setter. Warum die beiden Features kollidieren und vier Wege, die Eigenschaft trotzdem zu ignorieren, gemessen unter .NET 10."
pubDate: 2026-08-16
tags:
  - "system-text-json"
  - "csharp"
  - "csharp-14"
  - "dotnet-10"
  - "serialization"
  - "json"
lang: "de"
translationOf: "2026/08/how-to-make-system-text-json-ignore-a-property-with-the-required-modifier"
translatedBy: "claude"
translationDate: 2026-08-16
---

Kurze Antwort: `[JsonIgnore]` lässt sich nicht auf einem Member verwenden, der den C#-Modifikator `required` trägt. Sobald System.Text.Json den Vertrag für diesen Typ aufbaut, wirft es `InvalidOperationException: JsonPropertyInfo 'InternalId' defined in type 'Ignored' is marked required but does not specify a setter`, und zwar beim Serialisieren ebenso wie beim Deserialisieren. Es gibt vier funktionierende Alternativen, und welche die richtige ist, hängt davon ab, ob "ignorieren" bedeutet *nicht mehr ins JSON schreiben* oder *nicht mehr aus dem JSON verlangen*. Wenn der Typ Ihnen gehört, setzen Sie `[SetsRequiredMembers]` auf einen Konstruktor und behalten Sie das `[JsonIgnore]`. Wenn der Typ Ihnen nicht gehört, löschen Sie `JsonPropertyInfo.IsRequired` in einem Modifier des `DefaultJsonTypeInfoResolver`.

Alles Folgende wurde mit dem .NET 10.0.201 SDK gegen die Laufzeit 10.0.5 mit C# 14 gemessen. System.Text.Json berücksichtigt den `required`-Modifikator seit .NET 7, und die hier verwendeten APIs des Vertragsmodells sind seit .NET 7 stabil. Das Verhalten gilt also für .NET 7 und neuer, sofern ein Abschnitt nichts anderes sagt. Die einzige Ausnahme ist `RespectRequiredConstructorParameters`, das mit .NET 9 kam.

## Warum required und JsonIgnore nicht zusammenpassen

Die beiden Features wirken orthogonal. `required` ist ein Sprachfeature aus C# 11, das Aufrufer zwingt, einen Member im Objektinitialisierer zuzuweisen, und `[JsonIgnore]` ist eine Anweisung an den Serializer. Sie kollidieren, weil System.Text.Json den `required`-Modifikator liest und in Serialisierungsmetadaten übersetzt.

Laut der [Dokumentation zu erforderlichen Eigenschaften](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/required-properties) sind der C#-Modifikator `required` und `[JsonRequired]` "äquivalent, und beide bilden auf dasselbe Stück Metadaten ab", nämlich `JsonPropertyInfo.IsRequired`. `required` ist damit nicht nur ein Compiler-Vertrag, sondern ein Deserialisierungsvertrag: Die Eigenschaft muss im Payload vorkommen.

`[JsonIgnore]` arbeitet anders. Es entfernt die Eigenschaft nicht aus dem Vertrag. Es behält die `JsonPropertyInfo` und entfernt deren Accessoren. Das lässt sich beobachten, indem man einen Modifier an den Resolver hängt und den Vertrag ausgibt:

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

Der Modifier läuft vor der Validierung und gibt daher vor der Ausnahme aus:

```text
Name: IsRequired=True hasSet=True hasGet=True
InternalId: IsRequired=True hasSet=False hasGet=False
InvalidOperationException: JsonPropertyInfo 'InternalId' defined in type 'Ignored' is marked required but does not specify a setter.
```

Damit ist es klar. `InternalId` steht weiterhin im Vertrag und ist weiterhin als `IsRequired=True` markiert, aber `[JsonIgnore]` hat beide Accessoren auf null gesetzt. Der Serializer hält nun eine Eigenschaft, die er aus dem Payload befüllen muss und nicht befüllen kann. Er weigert sich, den Vertrag überhaupt aufzubauen, und deshalb spricht die Ausnahme von einem fehlenden Setter, obwohl Ihr Quelltext eindeutig einen hat.

Zwei Konsequenzen daraus, dass dies ein Fehler der *Vertragsvalidierung* ist und keiner der Deserialisierung:

- Es wirft auch beim Serialisieren. `JsonSerializer.Serialize(new Ignored { Name = "a", InternalId = "x" })` scheitert mit derselben `InvalidOperationException`, obwohl das Schreiben von JSON nie einen Setter braucht.
- Es ist ein Laufzeitfehler, kein Compilerfehler. Nichts warnt Sie. Der Code geht produktiv und wirft dann beim ersten Zugriff auf diesen Typ.

Dasselbe passiert mit `[JsonRequired]` statt des Schlüsselworts `required` und mit `required`-Feldern, sobald `IncludeFields` aktiv ist. Entscheidend ist das Flag `IsRequired`, nicht der Weg, auf dem es gesetzt wurde.

## Die minimale Reproduktion

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

Die Absicht ist offensichtlich und vernünftig: `InternalAuditToken` muss immer vom eigenen Code gesetzt werden (dafür ist `required` da) und darf nie über die Leitung gehen (dafür ist `[JsonIgnore]` da). System.Text.Json kann beides allein über Attribute schlicht nicht ausdrücken.

## Einen Konstruktor mit SetsRequiredMembers markieren

Das ist die Lösung, wenn der Typ Ihnen gehört. `System.Diagnostics.CodeAnalysis.SetsRequiredMembersAttribute` teilt dem Compiler mit, dass ein bestimmter Konstruktor alle erforderlichen Member zuweist, sodass Aufrufer das nicht mehr tun müssen. System.Text.Json versteht dieses Attribut ebenfalls und behandelt die Member dann nicht mehr als erforderlich.

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

Beide Richtungen funktionieren jetzt. `JsonSerializer.Deserialize<Order>("""{"Id":7}""")` liefert eine Instanz, deren `InternalAuditToken` das enthält, was der Konstruktor erzeugt hat, und die Serialisierung gibt `{"Id":7}` aus, ohne Spur des Tokens.

Der Mechanismus ist es wert, verstanden zu werden, denn er erklärt die Reichweite. Die Ausgabe des Vertrags für einen Typ mit und ohne das Attribut zeigt, was sich ändert:

```text
[without SetsRequiredMembers]
  Name: IsRequired=True  set=True
  InternalId: IsRequired=True  set=True

[with SetsRequiredMembers]
  Name: IsRequired=False set=True
  InternalId: IsRequired=False set=True
```

`[SetsRequiredMembers]` löscht `IsRequired` für **jeden** Member des Typs, nicht nur für den ignorierten. Wenn Sie sich darauf verlassen haben, dass `required` Payloads ohne `Id` ablehnt, ist diese Prüfung zusammen mit dem Fehler verschwunden, den Sie beheben wollten. Setzen Sie `[JsonRequired]` auf die Member zurück, die weiterhin erzwungen werden sollen:

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

Diese Kombination liefert genau die ursprüngliche Absicht: Der C#-Compiler zwingt Ihren eigenen Code weiterhin, beide Member zu setzen, der JSON-Vertrag lehnt weiterhin ein Payload ohne `Id` ab, und das Token taucht nie im JSON auf.

## IsRequired mit einem Resolver-Modifier löschen

Wenn der Typ aus einem Paket stammt, das Sie nicht kontrollieren, oder wenn die Regel für viele Typen auf einmal gelten soll, bearbeiten Sie den Vertrag statt des Typs. Ein Modifier des `DefaultJsonTypeInfoResolver` läuft, nachdem der Standardvertrag aufgebaut und bevor er validiert wurde, kann `IsRequired` also rechtzeitig abschalten.

Der grobe Hammer, direkt aus dem Microsoft-Learn-Beispiel, entfernt die Einschränkung überall:

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

Das ist meist zu weitreichend. Eine gezielte Variante orientiert sich an einem eigenen Marker-Attribut, sodass die Regel neben der Eigenschaft steht, die sie beschreibt, und für jeden Typ im Modell gilt:

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

Gemessene Ergebnisse mit diesen Optionen: `Deserialize<Order>("""{"Id":7}""")` gelingt und lässt das Token null, und `Serialize(new Order { Id = 7, InternalAuditToken = "secret" })` gibt `{"Id":7}` aus. Beachten Sie, dass hier kein `[JsonIgnore]` auf der Eigenschaft steht. `ShouldSerialize` unterdrückt das Schreiben und entfernt anders als `[JsonIgnore]` nicht die Accessoren, daher gibt es keinen Validierungsfehler.

Soll die Eigenschaft ganz aus dem Vertrag verschwinden, entfernen Sie sie, statt sie umzukonfigurieren. `typeInfo.Properties` ist eine veränderbare Liste:

```csharp
// .NET 10.0.5, C# 14
for (int i = typeInfo.Properties.Count - 1; i >= 0; i--)
    if (typeInfo.Properties[i].Name == "InternalAuditToken")
        typeInfo.Properties.RemoveAt(i);
```

Das funktioniert ebenfalls in beide Richtungen und kommt dem am nächsten, was Leute von `[JsonIgnore]` erwarten. Denken Sie daran, dass `Name` hier der JSON-Name ist und damit jede bereits angewandte Namensrichtlinie oder `[JsonPropertyName]` widerspiegelt. Wenn Sie das an Optionen hängen, die bereits einen Resolver haben, lohnt sich vorher ein Blick auf die Mechanik, [einen bestehenden Type Info Resolver zu ändern](/de/2023/10/system-text-json-how-to-modify-existing-type-info-resolver/), und derselbe Erweiterungspunkt funktioniert für [quellcodegenerierte Verträge](/de/2026/08/how-to-customize-source-generated-system-text-json-serialization-with-a-modifier/).

## Nur beim Schreiben ignorieren, was viele eigentlich wollen

Oft ist die Anforderung asymmetrisch: Die Eigenschaft muss beim Lesen eines Payloads vorhanden sein, soll aber beim Schreiben nicht zurückgegeben werden. Passwort-Hashes, Audit-Token und interne Bezeichner fallen meist in diese Kategorie. Dafür gibt es eine erstklassige Antwort ohne Konflikt mit `required`, denn das bedingte Ignorieren entfernt die Accessoren nicht:

```csharp
// .NET 10.0.5, C# 14
public class Order
{
    public required int Id { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public required string? InternalAuditToken { get; set; }
}
```

Gemessen: `Serialize(new Order { Id = 7, InternalAuditToken = null })` gibt `{"Id":7}` aus, während `Deserialize<Order>("""{"Id":7}""")` weiterhin `JsonException: JSON deserialization for type 'Order' was missing required properties including: 'InternalAuditToken'` wirft. Beide Hälften bleiben erhalten. `JsonIgnoreCondition.WhenWritingDefault` verhält sich bei Werttypen genauso. Nur das nackte `[JsonIgnore]`, das `JsonIgnoreCondition.Always` bedeutet, geht kaputt.

Die vierte Option, an einer öffentlichen API-Oberfläche oft die richtige, besteht darin, einen Typ nicht länger zwei Aufgaben erfüllen zu lassen. Ein separates Wire-DTO ohne `required`-Member, das auf Ihren Domänentyp und zurück abgebildet wird, umgeht das Problem vollständig und bietet später Platz für Versionierungsfragen. Es kostet eine Mapping-Methode und bringt einen Vertrag, den Sie ändern können, ohne Ihr Domänenmodell anzufassen.

## Was Sie vor der Wahl wissen sollten

**Ein explizites `null` erfüllt `required`.** `Deserialize<Order>("""{"Id":7,"InternalAuditToken":null}""")` gelingt. `required` heißt, dass der Schlüssel vorhanden ist, nicht dass der Wert sinnvoll ist. Wenn Sie Nicht-null brauchen, ist das eine Frage der Validierung, nicht der Serialisierung.

**Ein Eigenschaftsinitialisierer erfüllt es ebenfalls nicht.** `public required string InternalId { get; set; } = "fallback";` wirft weiterhin `JsonException`, wenn der Schlüssel im Payload fehlt. Der Standardwert wird angewandt, und der Serializer lehnt das Payload trotzdem ab.

**Die Fehlermeldung nennt den JSON-Namen.** Mit `[JsonPropertyName("internal_id")]` auf einer erforderlichen Eigenschaft lautet die Ausnahme `missing required properties including: 'internal_id'` und nicht der CLR-Membername. Praktisch, wenn eine Namensrichtlinie im Spiel ist und Sie nach der falschen Zeichenfolge suchen.

**Erforderliche Felder werden nur erzwungen, wenn `IncludeFields` aktiv ist.** Ein Feld `public required string InternalId;` ist für System.Text.Json standardmäßig unsichtbar, ein Payload ohne dieses Feld wird also sauber deserialisiert. Setzen Sie `IncludeFields = true`, und derselbe Typ beginnt zu werfen. Wer diese Option in einer bestehenden Codebasis aktiviert, sollte damit rechnen.

**Der Member lässt sich nicht hinter einem privaten Setter verstecken.** `public required string InternalId { get; private set; }` kompiliert nicht: Der C#-Compiler lehnt es mit `CS9032: Required member 'X' cannot be less visible or have a setter less visible than the containing type` ab. Das schließt einen Notausgang, nach dem viele greifen, und es ist ein Verwandter des [Fehlers CS9035, wenn ein Objektinitialisierer einen erforderlichen Member auslässt](/de/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/).

**Die Quellcodegenerierung verhält sich identisch.** Deserialisieren über einen `JsonSerializerContext` erzeugt exakt dieselbe `InvalidOperationException` für `[JsonIgnore]` plus `required` und dieselbe `JsonException` für eine fehlende erforderliche Eigenschaft. Ein Blick in den generierten Code mit `EmitCompilerGeneratedFiles` zeigt den Grund: Er gibt direkt `properties[0].IsRequired = true;` aus. Das ist erwähnenswert, weil die Microsoft-Learn-Seite weiterhin dazu rät, im Quellcodegenerierungsmodus `[JsonRequired]` statt `required` zu verwenden, mit der Begründung, der Code werde mit dem Schlüsselwort "nicht kompilieren". Unter .NET 10 kompiliert er und funktioniert; `[SetsRequiredMembers]` funktioniert ebenfalls über einen generierten Kontext. Auf einem älteren SDK sollten Sie das prüfen, bevor Sie sich darauf verlassen.

**`RespectRequiredConstructorParameters` ist ein anderer Schalter.** Eingeführt in .NET 9, macht er nicht optionale *Konstruktorparameter* im Payload erforderlich. Er hat nichts mit dem `required`-Modifikator auf Membern zu tun, und ihn abzuschalten hilft hier nicht. Verifiziert: Mit einem Konstruktor `Order(string name, string internalId)` und ohne Optionen gelingt `Deserialize<Order>("""{"Name":"a"}""")` und lässt den Parameter auf seinem Standardwert; mit `RespectRequiredConstructorParameters = true` wirft derselbe Aufruf `JsonException`. Wenn Ihr Problem ein fehlendes Konstruktorargument und kein fehlender Member ist, ist das der richtige Schalter.

Geht es eigentlich darum, Payloads mit nicht modellierten Feldern abzulehnen, ist das die Spiegelfrage mit eigenem Schalter: siehe [fehlende und nicht zugeordnete Member bei der Deserialisierung behandeln](/de/2023/09/net-8-handle-missing-members-during-json-deserialization/). Und wenn die Eigenschaft nur in bestimmten Ausprägungen einer Hierarchie ignoriert werden soll, gibt Ihnen ein [eigener JsonConverter](/de/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) volle Kontrolle über das Geschriebene, um den Preis, Lese- und Schreibpfad von Hand zu pflegen.

Meine Standardempfehlung: Wenn der Typ Ihnen gehört, `[SetsRequiredMembers]` auf einem Konstruktor plus `[JsonRequired]` auf den Membern, die weiterhin erzwungen werden sollen. Das sind drei Zeilen, es erhält die Compiler-Garantie, derentwegen Sie `required` überhaupt geschrieben haben, und es braucht kein eigenes Options-Objekt, das durch die ganze Anwendung gereicht wird.

## Quellen

- [Require properties for deserialization](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/required-properties) auf Microsoft Learn, für die Äquivalenz von `required`, `[JsonRequired]` und `JsonPropertyInfo.IsRequired` sowie für den Feature Switch `RespectRequiredConstructorParameters`.
- [How to ignore properties with System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/ignore-properties) für die vollständige `JsonIgnoreCondition`-Liste und die globale Einstellung `DefaultIgnoreCondition`.
- API-Referenz zu [JsonPropertyInfo.IsRequired](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.metadata.jsonpropertyinfo.isrequired) und [JsonPropertyInfo.ShouldSerialize](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.metadata.jsonpropertyinfo.shouldserialize).
- API-Referenz zu [SetsRequiredMembersAttribute](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.codeanalysis.setsrequiredmembersattribute).
- [Der required-Modifikator](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/required) in der C#-Sprachreferenz, einschließlich der Sichtbarkeitsregel CS9032.
