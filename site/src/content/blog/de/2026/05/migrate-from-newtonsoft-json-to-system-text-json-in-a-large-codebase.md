---
title: "Migration von Newtonsoft.Json 13 zu System.Text.Json in einer großen .NET 11 Codebasis"
description: "Ein versionsfixierter Leitfaden zum Ersetzen von Newtonsoft.Json 13.0.4 durch das in .NET 11 integrierte System.Text.Json: die Attribut- und Optionszuordnungen, die Standardwerte, die Ihr Ausgabeformat stillschweigend ändern, eine gestufte Rollout-Strategie, die Verifikation und die Fallstricke, die große Codebasen treffen."
pubDate: 2026-05-30
updatedDate: 2026-05-30
template: migration
tags:
  - "migration"
  - "newtonsoft-json"
  - "system-text-json"
  - "dotnet-11"
lang: "de"
translationOf: "2026/05/migrate-from-newtonsoft-json-to-system-text-json-in-a-large-codebase"
translatedBy: "claude"
translationDate: 2026-05-30
---

`Newtonsoft.Json` durch `System.Text.Json` in einer großen Codebasis zu ersetzen, ist selten eine Suchen-und-Ersetzen-Aufgabe. Die beiden Bibliotheken unterscheiden sich in ihren Standardwerten auf eine Weise, die Ihre serialisierte Ausgabe verändert und die Deserialisierung stillschweigend bricht. Ein naiver Austausch liefert daher eine Vertragsänderung an jeden Konsumenten Ihres JSON aus. Planen Sie einige Tage für einen kleinen Dienst und zwei bis vier Wochen für eine ausgedehnte Codebasis mit benutzerdefinierten Konvertern, polymorphen Payloads und `dynamic`/`JObject`-Parsing ein. Der Gewinn ist real: `System.Text.Json` ist Teil der Laufzeit, serialisiert etwa doppelt so schnell mit einem Bruchteil der Allokationen und ist das einzige der beiden, das unter Native AOT läuft. Dieser Artikel fixiert `Newtonsoft.Json` 13.0.4 (die aktuelle stabile Version, veröffentlicht am 2025-12-30) als Quelle und das in das .NET 11 SDK integrierte `System.Text.Json` mit C# 14 als Ziel. Wenn Sie noch entscheiden, ob Sie überhaupt wechseln sollen, lesen Sie zuerst [System.Text.Json vs Newtonsoft.Json im Jahr 2026](/de/2026/05/system-text-json-vs-newtonsoft-json-in-2026/); dieser Artikel setzt voraus, dass Sie sich für die Migration entschieden haben.

## Warum jetzt migrieren

- `System.Text.Json` ist Teil des Shared Frameworks in .NET 11. Das Entfernen der `PackageReference` von `Newtonsoft.Json` beseitigt eine transitive Abhängigkeit, die die Laufzeit, ASP.NET Core und die Testplattform aktiv abgebaut haben.
- Durchsatz. Bei typischen POCO-Payloads serialisiert `System.Text.Json` etwa 2x schneller als `Newtonsoft.Json` mit deutlich geringeren Allokationen, da es direkt über UTF-8-Bytes mit `Utf8JsonReader` und `Utf8JsonWriter` arbeitet, statt über `string` und `TextReader` zu gehen.
- Native AOT und Trimming. `Newtonsoft.Json` beruht auf Reflektion und funktioniert nicht unter Native AOT. `System.Text.Json` verfügt über einen Source-Generator-Modus (`JsonSerializerContext`), der trim-sichere, AOT-kompatible Serialisierungsmetadaten zur Kompilierzeit emittiert. Wenn [Native AOT](/de/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) auf Ihrer Roadmap steht, ist diese Migration eine Voraussetzung, keine Optimierung.
- Sicherheitslage. `System.Text.Json` ist standardmäßig strikt (RFC 8259), escaped HTML-sensitive und Nicht-ASCII-Zeichen bei der Ausgabe und interpretiert kein fehlerhaftes JSON. Das beseitigt eine Klasse von Injektions- und Parsing-Überraschungen, die die permissiven Standardwerte von `Newtonsoft.Json` zulassen.

## Was bricht

Die Gefahr dieser Migration ist nicht der Code, der nicht kompiliert. Es ist der Code, der einwandfrei kompiliert und Ihr Ausgabeformat ändert. Diese Tabelle sollten Sie zweimal lesen.

| Bereich                           | Änderung                                                                                       | Schweregrad |
| --------------------------------- | ---------------------------------------------------------------------------------------------- | ----------- |
| Abgleich von Eigenschaftsnamen    | `Newtonsoft.Json` ist beim Lesen standardmäßig case-insensitiv; `System.Text.Json` ist case-sensitiv | hoch  |
| Kommentare und nachgestellte Kommas | Standardmäßig in `Newtonsoft.Json` akzeptiert, werfen `JsonException` in `System.Text.Json`     | hoch        |
| JSON mit einfachen / ohne Anführungszeichen | Von `Newtonsoft.Json` akzeptiert, in `System.Text.Json` per Design abgelehnt           | hoch        |
| Nicht-string in `string`-Eigenschaft | `Newtonsoft.Json` konvertiert `1` oder `true`; `System.Text.Json` wirft eine Ausnahme        | hoch        |
| Zahlen in Anführungszeichen       | `Newtonsoft.Json` liest `"23"` in ein `int`; `System.Text.Json` benötigt `NumberHandling`       | mittel      |
| Zeichen-Escaping                  | `System.Text.Json` escaped aggressiver, sodass die Ausgabe-Bytes für Nicht-ASCII und HTML abweichen | mittel  |
| `[JsonProperty("name")]`          | Wird zu `[JsonPropertyName("name")]`; keine kombinierten ignore/required-Optionen in einem Attribut | mittel  |
| `TypeNameHandling.All`            | Kein Äquivalent, per Design. Polymorphie verwendet stattdessen `[JsonDerivedType]`              | hoch        |
| `JObject` / `JToken` / `dynamic`  | Ersetzt durch `JsonNode` / `JsonDocument` / `JsonElement` mit einer anderen API                 | mittel      |
| `JsonConvert.PopulateObject`      | Kein eingebautes Äquivalent; benötigt einen benutzerdefinierten Konverter oder ein manuelles Merge | mittel   |
| `ReferenceLoopHandling.Ignore`    | Kein Modus "die Schleife stillschweigend verwerfen"; Sie erhalten `ReferenceHandler.Preserve` oder gestalten den Graphen neu | mittel |
| `DateFormatString`, `DateTimeZoneHandling` | Kein globaler Datumsformat-Schalter; benötigt einen benutzerdefinierten `JsonConverter<DateTime>` | mittel |
| Präzedenz der Konverter-Registrierung | Die `Converters`-Sammlung überschreibt nun ein Attribut auf Typebene (umgekehrt zu `Newtonsoft.Json`) | niedrig |

Die maßgebliche Referenz für jede Zeile hier ist der [Microsoft-Migrationsleitfaden](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/migrate-from-newtonsoft), der auch die wenigen Funktionen (`JsonPath`-Abfragen, `TypeNameHandling.All`, Parsing einfacher Anführungszeichen) auflistet, für die es keine Umgehungslösung gibt.

## Pre-Flight-Checkliste

Erledigen Sie all dies, bevor Sie ein einziges `using Newtonsoft.Json` löschen.

1. Fixieren Sie den Vertrag. Wenn Ihr JSON eine Prozessgrenze überschreitet (eine öffentliche API, eine Nachrichtenwarteschlange, eine persistierte Spalte), erfassen Sie Referenzbeispiele der aktuellen Ausgabe. Serialisieren Sie eine repräsentative Menge von Objekten mit `Newtonsoft.Json` 13.0.4 und speichern Sie die Strings als Test-Fixtures. Diese sind Ihr Regressions-Orakel.
2. Inventarisieren Sie die Oberfläche. Verwenden Sie grep für alles, was die alte Bibliothek berührt, um den Umfang der Arbeit zu kennen:
   ```bash
   # run from the repo root; counts the call sites you have to touch
   grep -rEl "Newtonsoft\.Json|JsonConvert|JObject|JArray|JToken|JsonProperty|JsonSerializerSettings" --include="*.cs" .
   ```
   Verifizieren: Die Dateiliste entspricht Ihrem mentalen Modell davon, wo die Serialisierung lebt. Überraschungen hier (ein Konverter, der in einem Logging-Helfer vergraben ist) sind genau das, was Sie jetzt finden wollen.
3. Markieren Sie die Funktionen ohne Umgehungslösung. Suchen Sie gezielt nach `TypeNameHandling`, `SelectToken`, `SelectTokens` und Test-Fixtures mit einfachen Anführungszeichen. Wenn Sie `TypeNameHandling.All` oder `.Auto` finden, halten Sie an und entwerfen Sie den Polymorphie-Ersatz, bevor Sie fortfahren, denn dafür gibt es keinen direkten Ersatz.
4. Bestätigen Sie das Ziel. Führen Sie `dotnet --version` aus und bestätigen Sie `11.0.x`. `System.Text.Json` ist integriert, sodass für die Kernszenarien kein Paket hinzugefügt werden muss; Sie fügen `System.Text.Json` nur als explizite `PackageReference` hinzu, wenn Sie eine neuere Out-of-Band-Version als die im SDK enthaltene benötigen.

## Migrationsschritte

1. **Ordnen Sie die globalen Optionen zu.**

   `Newtonsoft.Json` zentralisiert das Verhalten in `JsonSerializerSettings`. `System.Text.Json` verwendet `JsonSerializerOptions`. Übersetzen Sie Ihr bestehendes Settings-Objekt Feld für Feld; akzeptieren Sie die Standardwerte von `System.Text.Json` nicht blind, denn sie unterscheiden sich von dem, was Ihr Code seit Jahren emittiert.

   ```csharp
   // .NET 11, C# 14
   // BEFORE: Newtonsoft.Json 13.0.4
   var settings = new JsonSerializerSettings
   {
       ContractResolver = new CamelCasePropertyNamesContractResolver(),
       NullValueHandling = NullValueHandling.Ignore,
       ReferenceLoopHandling = ReferenceLoopHandling.Ignore,
   };

   // AFTER: System.Text.Json (in-box on .NET 11)
   var options = new JsonSerializerOptions
   {
       PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
       PropertyNameCaseInsensitive = true,                       // restore Newtonsoft read behavior
       DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
       ReferenceHandler = ReferenceHandler.IgnoreCycles,         // closest match to ReferenceLoopHandling.Ignore
       // AllowTrailingCommas = true,                            // uncomment only if your inputs have them
       // ReadCommentHandling = JsonCommentHandling.Skip,        // uncomment only if your inputs have comments
   };
   ```

   Verifizieren: Serialisieren Sie Ihre Referenzbeispiel-Objekte mit diesen `options` und vergleichen Sie sie mit den Fixtures aus Pre-Flight-Schritt 1. Die Differenz sollte leer oder erklärt sein. `PropertyNameCaseInsensitive = true` ist die wichtigste Zeile für große Codebasen, weil unzählige Deserialisierungspfade stillschweigend vom case-insensitiven Abgleich von `Newtonsoft.Json` abhängen.

2. **Ersetzen Sie die Attribute.**

   Die Umbenennung der Attribute ist mechanisch, aber `[JsonProperty]` packte mehrere Belange in ein einziges Attribut, das `System.Text.Json` aufteilt.

   ```csharp
   // .NET 11, C# 14
   // BEFORE
   public class Order
   {
       [JsonProperty("order_id")]
       public int Id { get; set; }

       [JsonProperty("notes", NullValueHandling = NullValueHandling.Ignore)]
       public string? Notes { get; set; }

       [JsonProperty(Required = Required.Always)]
       public string Customer { get; set; } = "";

       [JsonIgnore]
       public string Internal { get; set; } = "";
   }

   // AFTER
   public class Order
   {
       [JsonPropertyName("order_id")]
       public int Id { get; set; }

       [JsonPropertyName("notes")]
       [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
       public string? Notes { get; set; }

       [JsonRequired]                       // or the C# `required` modifier
       public string Customer { get; set; } = "";

       [JsonIgnore]
       public string Internal { get; set; } = "";
   }
   ```

   Verifizieren: Das Projekt kompiliert mit null `using`-Direktiven von `Newtonsoft.Json` im Modell-Assembly, und ein Round-Trip-Test (`Deserialize(Serialize(order))`) bewahrt jedes Feld.

3. **Portieren Sie die benutzerdefinierten Konverter.**

   Hier verstreichen die Stunden. Die Formen sind ähnlich, aber die Verträge unterscheiden sich: Die Konverter von `System.Text.Json` arbeiten über `Utf8JsonReader` (ein `ref struct`) und `Utf8JsonWriter`, und `Read` wird auf dem ersten Token positioniert aufgerufen.

   ```csharp
   // .NET 11, C# 14 -- a converter that reads/writes DateTime in a fixed format,
   // replacing Newtonsoft's DateFormatString / DateTimeZoneHandling settings.
   public sealed class Iso8601DateTimeConverter : JsonConverter<DateTime>
   {
       public override DateTime Read(ref Utf8JsonReader reader, Type type, JsonSerializerOptions o)
           => DateTime.ParseExact(reader.GetString()!, "yyyy-MM-dd'T'HH:mm:ss'Z'",
                                  CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal);

       public override void Write(Utf8JsonWriter writer, DateTime value, JsonSerializerOptions o)
           => writer.WriteStringValue(value.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'",
                                      CultureInfo.InvariantCulture));
   }
   ```

   Registrieren Sie ihn in `options.Converters`, nicht nur als Typattribut, und beachten Sie die Präzedenzänderung: In `System.Text.Json` überschreibt ein Konverter in der `Converters`-Sammlung ein `[JsonConverter]`-Attribut auf Typebene, das Gegenteil von `Newtonsoft.Json`. Die detaillierten Mechanismen finden Sie unter [wie man einen benutzerdefinierten JsonConverter in System.Text.Json schreibt](/de/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/). Verifizieren Sie jeden portierten Konverter gegen sein eigenes Fixture, nicht nur das End-to-End-Payload, damit sich eine Präzedenzüberraschung nicht hinter einem bestandenen Integrationstest versteckt.

4. **Ersetzen Sie Polymorphie und TypeNameHandling.**

   Wenn Sie `TypeNameHandling` verwendet haben, um eine Klassenhierarchie zu round-trippen, gibt es kein Äquivalent, und das ist beabsichtigt: `TypeNameHandling.All` ist ein bekannter Vektor für Remote Code Execution. `System.Text.Json` betreibt diskriminierte Polymorphie mit Attributen am Basistyp.

   ```csharp
   // .NET 11, C# 14
   [JsonDerivedType(typeof(Dog), typeDiscriminator: "dog")]
   [JsonDerivedType(typeof(Cat), typeDiscriminator: "cat")]
   public abstract class Animal { public string Name { get; set; } = ""; }

   public sealed class Dog : Animal { public bool GoodBoy { get; set; } }
   public sealed class Cat : Animal { public int Lives { get; set; } }
   ```

   Dies emittiert einen `"$type": "dog"`-Diskriminator und liest ihn zurück zum richtigen Subtyp. Verifizieren: Serialisieren Sie eine `List<Animal>` aus gemischten Subtypen, deserialisieren Sie sie und prüfen Sie, dass die Laufzeittypen erhalten bleiben. Beachten Sie, dass sich das Ausgabeformat geändert hat (ein expliziter Diskriminator-String statt des assembly-qualifizierten `$type` von `Newtonsoft.Json`), sodass jeder externe Konsument im Gleichschritt aktualisiert werden muss.

5. **Konvertieren Sie dynamic- und JObject-Parsing.**

   Code, der untypisiertes JSON über `JObject`/`JToken`/`dynamic` durchstöbert, wechselt zu `JsonNode` (veränderbar) oder `JsonDocument`/`JsonElement` (schreibgeschützt, gepoolt).

   ```csharp
   // .NET 11, C# 14
   // BEFORE: JObject o = JObject.Parse(json); var name = (string)o["user"]!["name"]!;
   JsonNode root = JsonNode.Parse(json)!;
   string name = root["user"]!["name"]!.GetValue<string>();
   ```

   Die eine Falle: `JsonDocument` besitzt einen gepoolten Puffer und ist `IDisposable`, anders als `JObject`. Umschließen Sie es mit einem `using`, sonst lecken Sie den geliehenen Puffer. Bevorzugen Sie `JsonNode`, wenn Sie einen veränderbaren, `JObject`-ähnlichen Baum benötigen. Verifizieren: Jeder ehemalige `JObject`-Zugriffspfad hat einen Unit-Test, der dieselben Schlüsselsuchen durchführt.

6. **Wechseln Sie die ASP.NET Core-Integration.**

   Wenn die Codebasis `AddNewtonsoftJson()` in `Program.cs` aufruft, schaltet das Entfernen die gesamte Pipeline auf `System.Text.Json` um. Die Web-Standardwerte von ASP.NET Core aktivieren bereits camelCase, den case-insensitiven Abgleich und das Lesen von Zahlen in Anführungszeichen, sodass viele Ihrer manuellen Optionen im MVC-Pfad redundant werden.

   ```csharp
   // .NET 11, C# 14
   // BEFORE: builder.Services.AddControllers().AddNewtonsoftJson();
   builder.Services.AddControllers().AddJsonOptions(o =>
   {
       o.JsonSerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
       // camelCase + case-insensitive are already on by ASP.NET Core web defaults
   });
   ```

   Achten Sie auf das Tiefenlimit: ASP.NET Core begrenzt das `MaxDepth` von `System.Text.Json` auf 32, nicht auf den Bibliotheksstandard von 64. Tief verschachtelte Payloads, die mit `AddNewtonsoftJson()` funktionierten, können beginnen, Ausnahmen zu werfen. Verifizieren: Führen Sie die Integrationstests des Controllers aus und bestätigen Sie, dass kein Payload das Tiefenlimit überschreitet.

## Verifikation

Führen Sie diese Smoke-Test-Liste nach jedem PR aus, nicht nur am Ende:

- Die Lösung kompiliert mit null Verweisen auf `Newtonsoft.Json` in den migrierten Projekten (`grep -r "Newtonsoft" --include="*.csproj"` gibt für diese Projekte nichts zurück).
- Die Referenzbeispiel-Differenz aus Pre-Flight-Schritt 1 ist leer oder jede Differenz ist dokumentiert und beabsichtigt.
- Die gesamte Testsuite besteht: `dotnet test` meldet null Fehlschläge.
- Ein Round-Trip-Test (`Deserialize(Serialize(x))`) gilt für jedes Modell mit einem benutzerdefinierten Konverter oder einer polymorphen Hierarchie.
- Führen Sie für heiße Pfade einen schnellen `BenchmarkDotNet`-Vergleich durch und bestätigen Sie, dass sich die Durchsatz- und Allokationszahlen in die richtige Richtung bewegt haben, statt wegen eines versehentlichen `new JsonSerializerOptions()` pro Aufruf zu regredieren (cachen und wiederverwenden Sie die Options-Instanz immer; sie pro Aufruf zu konstruieren ist die häufigste Performance-Regression in dieser Migration).

## Rollback-Plan

Diese Migration ist pro Projekt reversibel, aber nicht trivial, denn Schritt 1 ändert Ihr Ausgabeformat. Die saubere Strategie ist ein Strangler-Ansatz: Migrieren Sie ein Assembly oder einen Endpunkt nach dem anderen, behalten Sie `Newtonsoft.Json` referenziert, bis der letzte Konsument umgezogen ist, und schützen Sie riskante Endpunkte hinter einem Feature Flag, das auf den Formatter von `Newtonsoft.Json` zurückleiten kann. Sobald Sie die `PackageReference` gelöscht und das neue Ausgabeformat an externe Konsumenten ausgeliefert haben, bedeutet ein Rollback, das Paket wieder hinzuzufügen und die Formatänderung überall auf einmal rückgängig zu machen, was ein koordiniertes Release ist, kein `git revert`. Löschen Sie den Paketverweis nicht, bevor die Referenzbeispiel-Differenzen für mindestens einen Release-Zyklus in der Produktionstelemetrie grün waren.

## Fallstricke, auf die wir gestoßen sind

- **Stiller Datenverlust durch Groß-/Kleinschreibung.** Ein Konfigurationsobjekt, das aus einer Datei mit `PascalCase`-Schlüsseln deserialisiert wurde, kam mit jeder Eigenschaft auf ihrem Standardwert zurück, weil `System.Text.Json` case-sensitiv gegen die camelCase-Member abglich. Nichts warf eine Ausnahme. Die Lösung war `PropertyNameCaseInsensitive = true`, und die Lehre war, auf Werte zu prüfen, nicht nur darauf, ob "geparst wurde".
- **`DateTime`-Round-Trips drifteten.** Das `DateTimeZoneHandling` von `Newtonsoft.Json` hatte Timestamps stillschweigend normalisiert. `System.Text.Json` liest das ISO 8601-Round-Trip-Format und bewahrt den Offset, sodass gespeicherte Timestamps mit einem anderen Kind zurückkamen. Der benutzerdefinierte Konverter aus Schritt 3 plus die Behebung von [der JSON-Wert konnte nicht in System.DateTime konvertiert werden](/de/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) löste es.
- **Objektzyklen warfen Ausnahmen, statt verworfen zu werden.** `ReferenceLoopHandling.Ignore` hatte eine echte Zirkelreferenz in einer EF Core-Navigationseigenschaft maskiert. `System.Text.Json` brachte sie als [ein möglicher Objektzyklus wurde erkannt](/de/2026/05/fix-possible-object-cycle-was-detected-system-text-json/) zum Vorschein. `ReferenceHandler.IgnoreCycles` ist die Brücke, aber die bessere Lösung war ein Projektions-DTO, das die Schleife gar nicht hatte.
- **Ein `new JsonSerializerOptions()` pro Anfrage ließ den Durchsatz einbrechen.** Das Options-Objekt innerhalb eines heißen Handlers zu konstruieren, hebelt den internen Metadaten-Cache aus und war langsamer als der `Newtonsoft.Json`-Code, den es ersetzte. Cachen Sie ein `static readonly JsonSerializerOptions` und verwenden Sie es wieder.

## Quellen

- [Microsoft Learn: Migration von Newtonsoft.Json zu System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/migrate-from-newtonsoft)
- [Microsoft Learn: Eigenschaftsnamen und -werte anpassen](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/customize-properties)
- [Microsoft Learn: Polymorphe Serialisierung mit System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/polymorphism)
- [Microsoft Learn: Referenzen bewahren und Zirkelreferenzen behandeln](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/preserve-references)
- [Newtonsoft.Json 13.0.4 auf NuGet](https://www.nuget.org/packages/newtonsoft.json/)
