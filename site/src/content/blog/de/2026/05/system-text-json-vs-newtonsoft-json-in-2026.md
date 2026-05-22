---
title: "System.Text.Json vs Newtonsoft.Json im Jahr 2026: Welche sollten Sie wählen?"
description: "Wählen Sie System.Text.Json für neuen .NET-11-Code: Es ist integriert, rund 2x schneller und das Einzige, das mit Native AOT funktioniert. Greifen Sie nur für JSONPath, TypeNameHandling oder wirklich permissives JSON zu Newtonsoft.Json."
pubDate: 2026-05-22
tags:
  - "comparison"
  - "system-text-json"
  - "newtonsoft-json"
  - "dotnet"
  - "dotnet-11"
lang: "de"
translationOf: "2026/05/system-text-json-vs-newtonsoft-json-in-2026"
translatedBy: "claude"
translationDate: 2026-05-22
---

Wenn Sie 2026 neuen Code auf .NET 11 beginnen, verwenden Sie **System.Text.Json**. Es ist in die Laufzeit integriert, serialisiert etwa doppelt so schnell mit einem Bruchteil der Speicherallokationen und ist das Einzige der beiden, das unter Native AOT läuft. Greifen Sie nur dann zu **Newtonsoft.Json**, wenn Sie von einer Funktion abhängen, die System.Text.Json noch nicht hat: JSONPath-Abfragen, Typ-Einbettung im Stil von `TypeNameHandling` oder das Parsen von wirklich fehlerhaftem JSON (einfache Anführungszeichen, Schlüssel ohne Anführungszeichen). Beide Bibliotheken leben 2026, aber sie sind für neue Arbeit nicht mehr gleichwertig.

Jedes Beispiel hier zielt auf `<TargetFramework>net11.0</TargetFramework>` mit dem .NET 11 SDK und C# 14. System.Text.Json ist die integrierte Version, die mit .NET 11 ausgeliefert wird. Newtonsoft.Json bezieht sich auf Version 13.0.4, veröffentlicht am 2025-12-30, die aktuelle stabile Version auf NuGet.

## Die Funktionsmatrix auf einen Blick

Dies ist die Tabelle, für die Sie gekommen sind. Sie ist die praktische Fassung des [offiziellen Microsoft-Migrationsleitfadens](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/migrate-from-newtonsoft), reduziert auf die Entscheidungen, die tatsächlich ändern, welches Paket Sie referenzieren.

| Aspekt | System.Text.Json (.NET 11) | Newtonsoft.Json 13.0.4 |
| ------ | -------------------------- | ---------------------- |
| Integriert | Ja, Teil der Laufzeit | Nein, NuGet-Paket |
| Durchsatz (serialisieren) | Basis, am schnellsten | ~2x langsamer |
| Allokationen | Span-basiert, niedrig | Höher |
| Native AOT / Trimming | Ja, über Source Generator | Nein |
| Standard-Permissivität | Strikt (RFC 8259) | Permissiv |
| Kommentare / abschließende Kommas | Optional | Standardmäßig aktiv |
| Abgleich ohne Groß-/Kleinschreibung | Optional (in ASP.NET Core aktiv) | Standardmäßig aktiv |
| Polymorphe (De-)Serialisierung | Ja, seit .NET 7 (`[JsonDerivedType]`) | Ja (`TypeNameHandling`) |
| `TypeNameHandling.All` (CLR-Typ einbetten) | Nein, by design | Ja |
| JSONPath / `SelectToken` | Nein | Ja |
| LINQ-to-JSON DOM | `JsonNode` / `JsonDocument` | `JObject` / `JArray` |
| `DataTable`, `ExpandoObject`, `BigInteger` | Benutzerdefinierter Konverter erforderlich | Integriert |
| Einfache Anführungszeichen, Schlüssel ohne Anführungszeichen | Abgelehnt, by design | Akzeptiert |
| Wartungsstatus | Aktive Entwicklung | Wartungsmodus |
| Lizenz | MIT | MIT |

Die Schlagzeile lautet: Die Zeilen, in denen Newtonsoft.Json noch gewinnt, sind eng und spezifisch, während die Zeilen, in denen System.Text.Json gewinnt (integriert, AOT, Geschwindigkeit), auf fast jedes neue Projekt zutreffen.

## Wann Sie System.Text.Json wählen sollten

Wählen Sie es als Standard für alles Neue auf .NET 11. Konkret:

- **ASP.NET-Core-APIs.** Das Framework verwendet System.Text.Json bereits intern und konfiguriert für Sie die web-freundlichen Standardwerte: camelCase-Eigenschaftsnamen, Abgleich ohne Groß-/Kleinschreibung und Unterstützung für Zahlen in Anführungszeichen. `Microsoft.AspNetCore.Mvc.NewtonsoftJson` hinzuzufügen, um das alte Verhalten zurückzubekommen, ist ein Rückschritt, sofern nicht eine bestimmte Funktion Sie dazu zwingt.
- **Alles, was unter Native AOT oder aggressivem Trimming läuft.** Das ist keine Vorliebe, sondern eine harte Anforderung. System.Text.Json hat einen [Source Generator](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/), der die Serialisierungsmetadaten zur Kompilierzeit erzeugt, sodass zur Laufzeit keine Reflexion benötigt wird. Newtonsoft.Json baut auf Laufzeitreflexion und `Reflection.Emit` auf, was AOT nicht erlaubt. Wenn Sie sich für die Kompromisse dort interessieren, sehen Sie sich die Aufschlüsselung von [Native AOT vs ReadyToRun vs JIT](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) an.
- **Pfade mit hohem Durchsatz oder hoher Speicherempfindlichkeit.** Serialisierer, Log-Versender, Message-Bus-Consumer, alles, was in einer engen Schleife läuft. System.Text.Json arbeitet direkt über `ReadOnlySpan<byte>` und UTF-8 und vermeidet so die String-Zwischenallokationen, die Newtonsoft.Json vornimmt.
- **Sie möchten eine deterministische, spezifikationskonforme Ausgabe.** System.Text.Json folgt RFC 8259 strikt. Es maskiert HTML-sensible Zeichen standardmäßig als Defense-in-Depth-Schutz gegen XSS und Informationspreisgabe, was wichtig ist, wenn das JSON in eine Seite eingebettet wird.

Ein durch den Source Generator erzeugter Kontext ist das Muster, das AOT und den schnellsten Start freischaltet:

```csharp
// .NET 11, C# 14 - compile-time metadata, no runtime reflection
using System.Text.Json;
using System.Text.Json.Serialization;

[JsonSerializable(typeof(WeatherForecast))]
public partial class AppJsonContext : JsonSerializerContext;

var forecast = new WeatherForecast(DateOnly.FromDateTime(DateTime.Now), 22, "Mild");

// Pass the generated TypeInfo, not the raw type, to stay reflection-free
string json = JsonSerializer.Serialize(forecast, AppJsonContext.Default.WeatherForecast);

public record WeatherForecast(DateOnly Date, int TemperatureC, string Summary);
```

System.Text.Json hat außerdem die meisten historischen Lücken geschlossen. Seit .NET 7 führt es polymorphe (De-)Serialisierung über `[JsonDerivedType]` durch, und .NET 9 fügte mehrere lange gewünschte Optionen hinzu: `RespectNullableAnnotations`, um nicht-nullbare Referenztypen zu berücksichtigen, das Attribut `JsonStringEnumMemberName`, um Enum-Werte umzubenennen, und `JsonSchemaExporter`, um aus einem .NET-Typ ein JSON-Schema zu erzeugen. .NET 10 fügte die direkte Deserialisierung aus einem `PipeReader` und einen einzeiligen strikten Preset hinzu:

```csharp
// .NET 10 and later - the strict, spec-compliant defaults in one preset
var options = JsonSerializerOptions.Strict;

// .NET 10 and later - deserialize straight from a PipeReader, no stream adapter
WeatherForecast? f = await JsonSerializer.DeserializeAsync<WeatherForecast>(pipeReader);
```

## Wann Sie Newtonsoft.Json wählen sollten

Es gibt noch echte Gründe, dazu zu greifen. Wählen Sie Newtonsoft.Json, wenn Sie auf eines davon stoßen:

- **Sie benötigen JSONPath-Abfragen.** `SelectToken("$.store.book[0].title")` hat kein integriertes Äquivalent in System.Text.Json. `JsonNode` erlaubt die Navigation über Indexer, aber es gibt keine Engine für Pfadabfragen. Wenn Sie beliebige Dokumente parsen und Werte per Pfad herausziehen, ist Newtonsoft.Json deutlich weniger Code.
- **Sie hängen von `TypeNameHandling` ab.** Newtonsoft.Json kann den CLR-Typnamen in die Nutzlast einbetten (`$type`) und den exakten Laufzeittyp auf dem Rückweg rekonstruieren. System.Text.Json weigert sich, dies zu tun, by design, denn die Deserialisierung eines von einem Angreifer kontrollierten Typnamens ist ein bekannter Vektor für Remote Code Execution. Wenn Sie ein bestehendes internes Protokoll haben, das darauf beruht, ist die Migration kein Konfigurationsschalter, sondern ein Neuentwurf.
- **Sie parsen wirklich permissives oder nicht standardkonformes JSON.** Strings mit einfachen Anführungszeichen, Eigenschaftsnamen ohne Anführungszeichen und andere nicht-RFC-konforme Eingaben werden von Newtonsoft.Json akzeptiert und von System.Text.Json by design abgelehnt. Kommentare und abschließende Kommas sind in System.Text.Json optional (`ReadCommentHandling`, `AllowTrailingCommas`), aber einfache Anführungszeichen und nackte Schlüssel können überhaupt nicht aktiviert werden.
- **Sie serialisieren Typen ohne integrierte Unterstützung.** `DataTable`, `ExpandoObject`, `TimeZoneInfo`, `BigInteger`, `DBNull` und `ValueTuple` benötigen in System.Text.Json alle einen benutzerdefinierten Konverter. Newtonsoft.Json behandelt sie nativ.

Der Unterschied bei der Standard-Permissivität ist der, der bei einer Migration zubeißt. Dieselbe Nutzlast verhält sich unterschiedlich:

```csharp
// Newtonsoft.Json 13.0.4 - lenient by default, this parses fine
using Newtonsoft.Json;

var config = JsonConvert.DeserializeObject<Config>("""
{
    "Name": "api", // inline comment
    "Retries": 3,
}
""");

public record Config(string Name, int Retries);
```

```csharp
// .NET 11, System.Text.Json - strict by default, the same input throws JsonException
using System.Text.Json;

// You must opt in to match Newtonsoft.Json's leniency
var options = new JsonSerializerOptions
{
    ReadCommentHandling = JsonCommentHandling.Skip,
    AllowTrailingCommas = true,
    PropertyNameCaseInsensitive = true
};
var config = JsonSerializer.Deserialize<Config>(input, options);
```

Diese Striktheit ist die häufigste Ursache für die Überraschung nach der Migration, bei der eine Nutzlast, die jahrelang funktionierte, plötzlich eine Ausnahme wirft, was auch der Grund ist, warum Fehler wie ein [JSON-Wert, der nicht konvertiert werden konnte](/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/) oder ein [DateTime, das nicht geparst wird](/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) direkt nach einem Wechsel auftauchen.

## Was die Benchmarks tatsächlich zeigen

Leistung ist die Behauptung, die sich am leichtesten verschwommen abhandeln lässt, also hier konkrete Zahlen statt des Wortes "schneller". Veröffentlichte BenchmarkDotNet-Läufe auf .NET 10, die eine Sammlung von 10.000 einfachen POCO-Objekten serialisieren, zeigen, dass System.Text.Json in etwa 3,7 ms abschließt und dabei 3,4 MB allokiert, gegenüber Newtonsoft.Json mit etwa 7,6 ms und 8,1 MB für dieselbe Arbeitslast.

| Metrik (10.000 POCOs serialisieren) | System.Text.Json | Newtonsoft.Json 13.x |
| ----------------------------------- | ---------------- | -------------------- |
| Mittlere Zeit | ~3,7 ms | ~7,6 ms |
| Allokiert | ~3,4 MB | ~8,1 MB |
| Relativ | 1,0x (Basis) | ~2,0x langsamer, ~2,4x Speicher |

Methodik und Vorbehalte sind wichtig, lesen Sie diese Zahlen also ehrlich:

- Die obigen Werte stammen aus einem öffentlichen .NET-10-Benchmark (BenchmarkDotNet, Standard-Release-Konfiguration) und sind repräsentativ, kein Dogma. Lassen Sie BenchmarkDotNet gegen Ihre eigenen Objektformen laufen, bevor Sie eine Zahl in einem Design-Review zitieren.
- Die Lücke ist am größten bei einfachen POCOs und großen Sammlungen, genau der Form, die Web-APIs und Message-Pipelines dominiert.
- Bei winzigen Nutzlasten (ein einzelnes kleines Objekt pro Anfrage) beträgt der absolute Unterschied Mikrosekunden und ist selten der Engpass. Wählen Sie dort nach den anderen Aspekten.
- Source Generation vergrößert die Lücke zugunsten von System.Text.Json weiter, weil sie die Reflexion pro Aufruf entfernt. Newtonsoft.Json hat kein Äquivalent.

Die Zusammenfassung ist über jeden glaubwürdigen Benchmark von 2025 und 2026 hinweg konsistent: System.Text.Json ist etwa doppelt so schnell und allokiert für den Standardfall ungefähr die Hälfte bis ein Drittel. Die Spanne hat sich nicht zugunsten von Newtonsoft.Json verengt.

## Die Details, die für Sie entscheiden

Manchmal beendet eine einzige Einschränkung die Entscheidung, bevor Vorlieben den Raum betreten.

**Native AOT ist ein geschlossenes Tor.** Wenn Ihr Bereitstellungsziel AOT erfordert (ein getrimmter Container, eine Scale-to-Zero-Funktion, ein iOS-Build), ist Newtonsoft.Json schlicht keine Option. Es hängt von Laufzeitreflexion ab, die AOT nicht bereitstellt. Diese eine Tatsache disqualifiziert es für eine ganze Klasse moderner .NET-Arbeitslasten.

**Wartungs-Trajektorie.** Newtonsoft.Json ist nicht tot und nicht veraltet. James Newton-King, der jetzt bei Microsoft an System.Text.Json selbst arbeitet, veröffentlicht weiterhin Sicherheits- und Bugfix-Releases (13.0.4 erschien am 2025-12-30). Aber es ist explizit im Wartungsmodus: keine größere Funktionsarbeit, keine AOT-Strategie in Sicht. System.Text.Json erhält mit jedem .NET-Release neue Fähigkeiten. Neuen Code auf die aktiv weiterentwickelte Bibliothek zu setzen, ist die risikoärmere Wahl für ein System, das Sie über Jahre pflegen werden.

**Referenzbehandlung und Objektzyklen unterscheiden sich.** Newtonsoft.Json hat `ReferenceLoopHandling` und `PreserveReferencesHandling`. System.Text.Json bildet diese auf `ReferenceHandler.IgnoreCycles` und `ReferenceHandler.Preserve` ab, aber das Verhalten ist nicht identisch (`IgnoreCycles` schreibt `null`, wo Newtonsoft.Json die Eigenschaft weglässt). Wenn Sie EF-Core-Entitätsgraphen serialisieren, ist dies der Unterschied zwischen einer sauberen Nutzlast und einer [Ausnahme wegen eines möglichen Objektzyklus](/2026/05/fix-possible-object-cycle-was-detected-system-text-json/). Wissen Sie, welchen Handler Sie brauchen, bevor Sie migrieren.

**Die Lizenzen sind identisch.** Beide werden unter MIT ausgeliefert, anders als bei der Situation um MediatR oder AutoMapper ist die Lizenz hier also kein Faktor. Lassen Sie nicht "Ist Newtonsoft.Json noch kostenlos?" die Entscheidung treiben: Es ist es, und System.Text.Json ebenso.

## Die Entscheidung, in einer Zeile

Für neuen .NET-11-Code im Jahr 2026: standardmäßig System.Text.Json, und Newtonsoft.Json nur hinzufügen, wenn Sie auf eine konkrete, benannte Funktion stoßen, die es nicht kann (JSONPath, `TypeNameHandling`, permissives Parsen oder ein nicht unterstützter Typ ohne Konverter). Es ist integriert, schneller, AOT-fähig und das, woran Microsoft weiterhin baut. Behalten Sie Newtonsoft.Json in bestehenden Systemen, die von seiner Flexibilität abhängen; überstürzen Sie keine Migration, die keinen Nutzen bringt, aber beginnen Sie auch nicht dort. Der strategische Standard kippte vor Jahren, und 2026 ist die Lücke breit genug, dass die Beweislast auf der Wahl von Newtonsoft.Json liegt, nicht auf der Wahl der integrierten Bibliothek.

## Verwandt

- [How to write a custom JsonConverter in System.Text.Json](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/)
- [Fix: a possible object cycle was detected with System.Text.Json](/2026/05/fix-possible-object-cycle-was-detected-system-text-json/)
- [Fix: the JSON value could not be converted](/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/)
- [Fix: the JSON value could not be converted to System.DateTime](/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/)
- [Native AOT vs ReadyToRun vs JIT in .NET 11](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)

## Quellen

- [Migrate from Newtonsoft.Json to System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/migrate-from-newtonsoft) - die maßgebliche Tabelle der Funktionsunterschiede und die Liste des Standardverhaltens.
- [What's new in System.Text.Json in .NET 9](https://devblogs.microsoft.com/dotnet/system-text-json-in-dotnet-9/) - Nullable-Annotationen, Enum-Mitgliedsnamen, Schema-Exporter.
- [JsonSerializer.DeserializeAsync (PipeReader overload)](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializer.deserializeasync?view=net-10.0) - die Streaming-API von .NET 10.
- [Newtonsoft.Json releases](https://github.com/JamesNK/Newtonsoft.Json/releases) - Version 13.0.4 und die aktuelle Wartungskadenz.
