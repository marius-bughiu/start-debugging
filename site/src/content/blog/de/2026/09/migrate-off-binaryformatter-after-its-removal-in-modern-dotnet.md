---
title: "Nach der Entfernung im modernen .NET von BinaryFormatter migrieren"
description: "Die Implementierung von BinaryFormatter wurde in .NET 9 entfernt und wirft in .NET 10 und .NET 11 weiterhin PlatformNotSupportedException: wie Sie einen Ersatzserializer auswählen, bereits gespeicherte NRBF-Blobs mit NrbfDecoder lesen und was in WinForms, WPF und ResX bricht."
pubDate: 2026-09-02
updatedDate: 2026-09-02
template: migration
tags:
  - "migration"
  - "binaryformatter"
  - "serialization"
  - "system-text-json"
  - "dotnet-10"
  - "dotnet-11"
  - "security"
  - "dotnet"
lang: "de"
translationOf: "2026/09/migrate-off-binaryformatter-after-its-removal-in-modern-dotnet"
translatedBy: "claude"
translationDate: 2026-09-02
---

Ein Dienst, der seine eigenen Typen in seinen eigenen Speicher serialisiert, braucht ein bis drei Tage, um von `BinaryFormatter` wegzukommen. Eine Codebasis, in der NRBF-Payloads eine Grenze überschritten haben, die Sie nicht kontrollieren (eine Queue, eine gemeinsam genutzte Datenbankspalte, ein Desktop-Client mit eigenem Releaseplan), braucht Wochen, denn der schwierige Teil ist nicht der Austausch des Serializers, sondern das Leeren der alten Payloads. Die eingebaute Implementierung wurde in .NET 9 Preview 6 gelöscht und ist gelöscht geblieben: In .NET 9, .NET 10 und .NET 11 Preview werfen `BinaryFormatter.Serialize` und `BinaryFormatter.Deserialize` für jeden Projekttyp eine [`PlatformNotSupportedException`](https://learn.microsoft.com/en-us/dotnet/core/compatibility/serialization/9.0/binaryformatter-removal), und die alte MSBuild-Eigenschaft `EnableUnsafeBinaryFormatterSerialization` allein holt sie nicht mehr zurück. Dieser Leitfaden ist gegen .NET 10.0.11 (GA) geschrieben, mit Hinweisen zum .NET 11 SDK (Preview 7, August 2026), `System.Formats.Nrbf` 10.0.11 und `System.Runtime.Serialization.Formatters` 10.0.11.

## Warum das nicht optional ist

- **Es ist kein Schalter mehr übrig.** In .NET 8 war der Abschaltschalter standardmäßig aktiv und `<EnableUnsafeBinaryFormatterSerialization>true</EnableUnsafeBinaryFormatterSerialization>` funktionierte noch. Ab .NET 9 ist die Eigenschaft allein wirkungslos; der implementierende Code ist überhaupt nicht mehr im Shared Framework enthalten.
- **Das Kompatibilitätspaket ist ausdrücklich nicht unterstützt.** `System.Runtime.Serialization.Formatters` liefert eine funktionierende Implementierung aus, Schwachstellen inklusive. Es ist eine Überbrückung für einen Termin, kein Ziel.
- **Das Risiko ist das Format, nicht die Bugs.** NRBF kodiert im Payload selbst, welche Typen instanziiert werden sollen, und das ist [CWE-502, "Deserialization of Untrusted Data"](https://cwe.mitre.org/data/definitions/502.html). Kein noch so großer Patch-Aufwand repariert ein Format, dessen Aufgabe darin besteht, den Konstruktor vom Payload wählen zu lassen.
- **Sie können die alten Blobs lesen, ohne sie zu deserialisieren.** `NrbfDecoder`, der in .NET 9 zusammen mit der Entfernung ausgeliefert wurde, dekodiert NRBF in Records, ohne einen einzigen benutzerdefinierten Typ zu laden. Genau das macht eine schrittweise Migration statt einer Umstellung auf einen Schlag möglich.

## Was bricht

| Bereich | Änderung | Schweregrad |
| --- | --- | --- |
| `BinaryFormatter.Serialize` / `Deserialize` | Wirft bei jedem Aufruf eine `PlatformNotSupportedException`, in allen Projekttypen | hoch |
| `EnableUnsafeBinaryFormatterSerialization` | Reicht allein nicht mehr; benötigt zusätzlich das Kompatibilitätspaket | hoch |
| Gespeicherte NRBF-Blobs | Nichts im Framework deserialisiert sie noch | hoch |
| `SoapFormatter`, `NetDataContractSerializer` | Entfernt oder als [gefährliche Serializer](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-security-guide) eingestuft; kein Migrationsziel | hoch |
| Zwischenablage und Drag-and-Drop in WinForms/WPF | Nur eine Liste intrinsischer Typen übersteht den Roundtrip. `DataFormats.Serializable` und eigene Formate scheitern bei allem anderen | hoch |
| WinForms-Designer / ResX | Die Serialisierung eines eigenen Typs zur Entwurfszeit benötigt stattdessen einen `TypeConverter` | mittel |
| `Exception(SerializationInfo, StreamingContext)` | Als `SYSLIB0051` veraltet; die alte Ausnahmeserialisierung ist Ballast | mittel |
| MSBuild `MSB3825` | Warnung zu binär formatierten Ressourcen; mit `GenerateResourceWarnOnBinaryFormatterUse` unterdrücken | niedrig |
| `SettingsPropertyValue.PropertyValue` | Als `object` typisiert, daher lassen sich `System.Configuration`-Benutzereinstellungen mit eigenen Typen ohne API-Bruch nicht migrieren | hoch |

## Checkliste vor dem Start

- .NET SDK 10.0.100 oder neuer installiert (`dotnet --list-sdks`).
- Eine Inventur: `grep -rn "BinaryFormatter\|IFormatter\|SoapFormatter\|NetDataContractSerializer" --include=*.cs .` plus ein Scan der NuGet-Abhängigkeiten, denn die transitiven Aufrufer sind die, die überraschen.
- Roundtrip-Tests um jede Serialisierungsgrenze, **bevor** Sie irgendetwas anfassen. Serialisierungsfehler sind still; sie zeigen sich drei Releases später als ein null-Feld.
- Eine Stichprobe echter gespeicherter Payloads aus dem Produktivspeicher. Synthetische Payloads decken Versionsdrift nicht ab.
- Eine schriftlich festgehaltene Entscheidung, ob Sie sowohl Produzent als auch Konsument jedes Payloads kontrollieren. Wenn nicht, brauchen Sie den Dual-Read-Pfad aus Schritt 4 und keinen direkten Austausch.

## Migrationsschritte

1. **Inventarisieren Sie jede Payload-Grenze, nicht jede Aufrufstelle.** Gruppieren Sie die `BinaryFormatter`-Verwendungen danach, wohin die Bytes gehen: nur im Speicher (ein Deep-Clone-Helfer), prozesslokaler Cache, dauerhafter Speicher (Datenbankspalte, Blob, Datei auf der Platte) und prozessübergreifend (Zwischenablage, Queue, Remoting-artiges RPC). Verwendungen im Speicher und prozesslokal lassen sich in einem einzigen Commit austauschen. Dauerhafte und prozessübergreifende brauchen ein Übergangsfenster für das Format. Halten Sie die geschlossene Menge der Typen fest, die jede Grenze erreichen.

   Prüfung: Jeder Treffer des obigen `grep` ist genau einer der vier Gruppen zugeordnet, und jede dauerhafte Grenze hat einen benannten Verantwortlichen und eine benannte Liste der serialisierten Typen.

2. **Wählen Sie den Ersatzserializer pro Grenze.** Es gibt keinen direkten Ersatz, und Sie müssen nicht überall denselben wählen. Der [offizielle Vergleich](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/choose-a-serializer) lässt sich so zusammenfassen: `System.Text.Json`, wenn der Payload Text sein darf und Sie die Typen annotieren können (die einzige Option der Liste mit erstklassiger AOT-Unterstützung und Quellcodegenerierung); `DataContractSerializer`, wenn Sie die Typen überhaupt nicht ändern können, denn er ist der einzige empfohlene Serializer, der `[Serializable]` und `ISerializable` berücksichtigt; [MessagePack for C#](https://github.com/MessagePack-CSharp/MessagePack-CSharp) oder [protobuf-net](https://github.com/protobuf-net/protobuf-net), wenn der Payload kompakt binär bleiben muss.

   Prüfung: Neben jeder Grenze aus Schritt 1 steht ein Serializer mit einer einzeiligen Begründung. Lautet die Begründung "war die Voreinstellung", gehen Sie zurück.

3. **Tauschen Sie zuerst die Verwendungen im Speicher und prozesslokal aus.** Das sind kostenlose Gewinne und sie verkleinern die Fläche für die schwierigen Schritte. Ein `[Serializable]`-Typ, der zu `System.Text.Json` wechselt, braucht ein ausdrückliches Opt-in für alles, was vorher implizit war: Felder werden nicht serialisiert, wenn Sie es nicht verlangen, private Member brauchen einen eigenen Contract, und `[Serializable]` selbst bedeutet gar nichts.

   ```csharp
   // .NET 10.0.11, C# 14
   using System.Text.Json;
   using System.Text.Json.Serialization;

   [JsonSourceGenerationOptions(IncludeFields = true)]
   [JsonSerializable(typeof(CartSnapshot))]
   internal partial class CartContext : JsonSerializerContext;

   public sealed class CartSnapshot
   {
       public int Version;                 // a field, so IncludeFields is required
       public string? CouponCode { get; set; }
       public List<int> LineItemIds { get; set; } = [];
   }

   byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(snapshot, CartContext.Default.CartSnapshot);
   CartSnapshot? back = JsonSerializer.Deserialize(bytes, CartContext.Default.CartSnapshot);
   ```

   Prüfung: `dotnet test` ist grün, und eine Roundtrip-Assertion vergleicht jeden öffentlichen **und** privaten Member, nicht nur die, an die Sie gedacht haben.

4. **Fügen Sie an jeder dauerhaften Grenze einen Dual-Read-Pfad ein.** Das ist der Schritt, der Ihnen das Ausliefern ermöglicht. `NrbfDecoder.StartsWithPayloadHeader` sagt Ihnen, ob die gerade gelesenen Bytes altes NRBF sind, und wenn ja, dekodieren Sie sie, serialisieren sie mit dem neuen Serializer neu und schreiben sie zurück. Lesevorgänge migrieren den Bestand nach und nach; Schreibvorgänge nutzen ab dem ersten Tag nur das neue Format.

   ```csharp
   // .NET 10.0.11, System.Formats.Nrbf 10.0.11
   using System.Formats.Nrbf;

   internal static CartSnapshot Load(string path)
   {
       byte[] raw = File.ReadAllBytes(path);

       if (!NrbfDecoder.StartsWithPayloadHeader(raw))
       {
           return JsonSerializer.Deserialize(raw, CartContext.Default.CartSnapshot)!;
       }

       CartSnapshot upgraded = ReadLegacy(raw);
       File.WriteAllBytes(path, JsonSerializer.SerializeToUtf8Bytes(upgraded, CartContext.Default.CartSnapshot));
       return upgraded;
   }
   ```

   Prüfung: ein Test, der eine echte NRBF-Stichprobe aus der Produktion in eine temporäre Datei schreibt, `Load` aufruft, die Werte prüft und anschließend prüft, dass ein zweiter `Load` den Legacy-Zweig nicht mehr nimmt.

5. **Implementieren Sie `ReadLegacy` mit `NrbfDecoder`, Typ für Typ.** `NrbfDecoder` dekodiert; er instanziiert niemals Ihre Typen, lädt niemals eine Assembly und rekursiert nie. Die Konstruktion übernehmen Sie, und genau deshalb ist er bei nicht vertrauenswürdiger Eingabe sicher. `ClassRecord` stellt die Member namentlich über typisierte Accessoren bereit, und `TypeNameMatches` vergleicht Typnamen unter Ignorieren der Assembly-Identität, sodass Type Forwarding und Versionssprünge von Assemblies Sie nicht brechen.

   ```csharp
   // .NET 10.0.11, System.Formats.Nrbf 10.0.11
   using System.Formats.Nrbf;

   private static CartSnapshot ReadLegacy(byte[] raw)
   {
       using MemoryStream stream = new(raw);
       ClassRecord root = NrbfDecoder.DecodeClassRecord(stream);

       if (!root.TypeNameMatches(typeof(CartSnapshot)))
       {
           throw new InvalidDataException($"Unexpected payload type '{root.TypeName.AssemblyQualifiedName}'.");
       }

       SZArrayRecord<int> ids = (SZArrayRecord<int>)root.GetArrayRecord(nameof(CartSnapshot.LineItemIds))!;
       if (ids.Length > 10_000)
       {
           throw new InvalidDataException("Line item array exceeds the sane limit.");
       }

       return new CartSnapshot
       {
           Version = root.HasMember(nameof(CartSnapshot.Version)) ? root.GetInt32(nameof(CartSnapshot.Version)) : 1,
           CouponCode = root.GetString(nameof(CartSnapshot.CouponCode)),
           LineItemIds = [.. ids.GetArray()],
       };
   }
   ```

   `HasMember` ist die Notluke für Versionierung: Ein Feld, das zwischen dem Schreiben des Payloads und heute hinzugefügt oder umbenannt wurde, ergibt `false` und keine Ausnahme. Die Längenprüfung vor `GetArray` ist nicht optional, denn NRBF macht es für einen feindlichen Payload billig, zwei Milliarden Nullwerte zu versprechen.

   Prüfung: ein Dekodiertest pro Legacy-Typ gegen einen echten gespeicherten Payload, plus ein Test, der bestätigt, dass ein überdimensionierter oder falsch typisierter Payload eine `InvalidDataException` wirft, statt Speicher zu belegen.

6. **Wenn Sie die Typen wirklich nicht ändern können, verwenden Sie `DataContractSerializer` anstelle der Schritte 3 bis 5.** Er ist die einzige empfohlene Option, die das Programmiermodell von `[Serializable]` und `ISerializable` berücksichtigt, sodass die Typen unangetastet bleiben. Der Haken: Bekannte Typen müssen vorab angegeben werden, private eingeschlossen, und einige verbreitete Typen (insbesondere `DateTimeOffset`) stehen nicht auf der Standard-Allowlist. `PreserveObjectReferences` stellt das Verhalten für Objektidentität und Zyklen wieder her, das `BinaryFormatter` kostenlos mitbrachte.

   ```csharp
   // .NET 10.0.11
   using System.Runtime.Serialization;

   DataContractSerializer serializer = new(
       typeof(CartSnapshot),
       new DataContractSerializerSettings
       {
           KnownTypes = [typeof(PercentageCoupon), typeof(FixedAmountCoupon), typeof(DateTimeOffset)],
           PreserveObjectReferences = true,
       });
   ```

   Greifen Sie nicht zu `NetDataContractSerializer`, nur weil der Name näher klingt. Er bettet Typinformationen genauso in den Payload ein wie `BinaryFormatter` und ist als gefährlicher Serializer gelistet.

   Prüfung: ein Roundtrip-Test über die vollständige Hülle der bekannten Typen, inklusive eines Graphen mit einem absichtlichen Zyklus, der mit `PreserveObjectReferences = true` besteht.

7. **Behandeln Sie WinForms und WPF getrennt.** Seit .NET 9 verwenden beide Frameworks intern eine NRBF-Teilmenge für Zwischenablage, Drag-and-Drop und Entwurfszeitressourcen, aber nur für eine intrinsische Liste: die primitiven Typen, `string`, `decimal`, `TimeSpan`, `DateTime`, `nint`, `nuint`, `PointF`, `RectangleF`, dazu `Bitmap` und `ImageListStreamer` in WinForms, sowie Arrays und Listen davon. Alles andere fällt auf `BinaryFormatter` zurück und schlägt fehl. Der vorgesehene Weg für Zwischenablage und Drag-and-Drop ist, selbst einen `string` oder ein `byte[]` in die Zwischenablage zu legen, typischerweise JSON, und es auf der Empfangsseite zu parsen. Für die Designer- bzw. ResX-Serialisierung eines eigenen Typs registrieren Sie einen `TypeConverter`, damit der Designer ihn nutzt, statt auf `BinaryFormatter` durchzufallen.

   Prüfung: ein manuelles Kopieren und Einfügen sowie ein Drag-and-Drop zwischen zwei laufenden Instanzen der Anwendung für jedes eigene Format, plus ein Designer-Roundtrip (Formular öffnen, speichern, erneut öffnen) ohne `MSB3825` und ohne Laufzeitausnahme.

8. **Erst dann entscheiden Sie über das Kompatibilitätspaket.** Wenn eine Drittanbieter-Abhängigkeit intern `BinaryFormatter` aufruft und Sie nicht auf deren Korrektur warten können, installieren Sie `System.Runtime.Serialization.Formatters` nur im **Anwendungsprojekt**. Das Paket ändert die Typidentität von `BinaryFormatter` nicht, also übernehmen Bibliotheken im Graphen die funktionierende Implementierung, ohne neu gebaut zu werden.

   ```xml
   <!-- .NET 10.0.11. Unsupported, and a temporary measure. -->
   <PropertyGroup>
     <TargetFramework>net10.0</TargetFramework>
     <EnableUnsafeBinaryFormatterSerialization>true</EnableUnsafeBinaryFormatterSerialization>
   </PropertyGroup>

   <ItemGroup>
     <PackageReference Include="System.Runtime.Serialization.Formatters" Version="10.0.11" />
   </ItemGroup>
   ```

   Für ResX gibt es eine zweite Hürde: Setzen Sie zusätzlich den AppContext-Schalter `System.Resources.Extensions.UseBinaryFormatter` auf `true`.

   Prüfung: Die Paketreferenz existiert in genau einer Projektdatei, und es gibt ein datiertes Tracking-Issue, das die erzwingende Abhängigkeit benennt.

## Die Migration prüfen

- `grep -rn "BinaryFormatter" --include=*.cs src/` liefert außerhalb des Legacy-Dekodierpfads und seiner Tests nichts.
- `dotnet build -warnaserror` ist sauber, ohne `SYSLIB0011` und ohne `MSB3825`.
- `dotnet test -c Release` ist grün und enthält mindestens einen Dekodiertest pro Legacy-Typ gegen eine echte Produktions-Payload-Stichprobe.
- Ein Staging-Lauf liest den Produktionsbestand: Protokollieren Sie die Anzahl der Payloads, die den Legacy-Zweig genommen haben, und bestätigen Sie, dass sie über das Übergangsfenster gegen null geht.
- Die Logs zeigen keine First-Chance-`PlatformNotSupportedException`.
- Handelt es sich um eine WinForms- oder WPF-Anwendung, wurden Zwischenablage und Drag-and-Drop zwischen zwei Prozessen geprüft, nicht nur innerhalb eines Prozesses.

## Rollback

Die Codeänderung ist umkehrbar, die Datenänderung nicht. Sobald Schritt 4 einen Blob im neuen Format neu schreibt, sind die alten Bytes weg, ein Rollback auf einen Build, der nur NRBF versteht, kann sie also nicht lesen. Zwei Konsequenzen, die eingeplant gehören: Bewahren Sie die Bytes im alten Format über die gesamte Rollback-Frist auf (schreiben Sie den aktualisierten Payload in eine neue Spalte oder unter einen neuen Schlüssel, statt an Ort und Stelle zu überschreiben, und verwerfen Sie den alten erst nach Ablauf der Frist), und behalten Sie den Legacy-Lesepfad mit `NrbfDecoder` mindestens ein Release lang im Code, nachdem der Migrationszähler null erreicht hat. Wenn Sie mit dem Kompatibilitätspaket als Brücke ausliefern, ist der Rollback trivial, das Sicherheitsrisiko besteht aber während der gesamten Laufzeit, also datieren Sie das Tracking-Issue.

## Fallstricke, die Sie vorher kennen sollten

**`[Serializable]` bedeutet für `System.Text.Json` nichts.** Typen, die über `BinaryFormatter` mit privaten Feldern und ohne öffentlichen Konstruktor den Roundtrip überstanden, erzeugen unter JSON stillschweigend `{}`. Der Fehler ist keine Ausnahme, sondern leere Ausgabe, und deshalb muss der Roundtrip-Test aus Schritt 3 den privaten Zustand vergleichen.

**Objektidentität verschwindet.** `BinaryFormatter` erhielt Referenzen und kam mit Zyklen zurecht. `System.Text.Json` braucht `ReferenceHandler.Preserve`, `DataContractSerializer` braucht `PreserveObjectReferences = true`, und wenn Sie beides auslassen, wird aus einem gemeinsam genutzten Kindobjekt nach dem Roundtrip stillschweigend zweimal dasselbe Objekt. Wo alter Code sich nach der Deserialisierung auf Referenzgleichheit verließ, ist diese Annahme nun falsch.

**`NrbfDecoder` ist ein Decoder, kein `BinaryFormatter`-Emulator.** Sein Verhalten weicht bewusst von dem des `BinaryFormatter` ab, Sie können eine erfolgreiche Dekodierung also nicht als Beleg dafür nehmen, dass ein `BinaryFormatter`-Aufruf sicher gewesen wäre. Er unterstützt außerdem keine Arrays mit von null verschiedenem Startindex, die .NET Framework in NRBF-Payloads schreiben konnte, .NET aber nie gelesen hat.

**Manche Bibliotheken lassen sich überhaupt nicht migrieren.** `SettingsPropertyValue.PropertyValue` ist als `object` typisiert, eine `System.Configuration`-Einstellungsdatei konnte also buchstäblich alles enthalten. Es gibt keine geschlossene Typmenge, gegen die dekodiert werden könnte, und damit keinen `NrbfDecoder`-Pfad ohne API-Bruch. Solche Typen sind der Grund, warum die Inventur aus Schritt 1 zuerst kommt.

**Die Ausnahmeserialisierung ist eine eigene Obsoletion.** `SYSLIB0051` betrifft den Konstruktor `Exception(SerializationInfo, StreamingContext)` und den Rest der alten Serialisierungsunterstützung. Ihre eigenen Ausnahmen tragen diesen Konstruktor vermutlich noch; ihn zu löschen ist sicher, sobald nichts mehr Ausnahmen durch einen Formatter schickt, und es ist ein guter `grep` für denselben Durchgang.

**Die versionsübergreifende Konvertierung muss dort laufen, wo es noch eine Implementierung gibt.** Wenn Sie zugleich .NET Framework hinter sich lassen, schreiben Sie das einmalige Blob-Konvertierungswerkzeug, solange Sie noch eine Laufzeit mit funktionierendem `BinaryFormatter` haben, oder nutzen Sie `System.Formats.Nrbf`, das genau deshalb auch .NET Standard 2.0 und .NET Framework als Ziel hat, damit die Dekodierseite überall laufen kann.

## Verwandt

- Der BinaryFormatter-Schritt steckt im größeren Sprung der [Upgrade-Checkliste von .NET 8 auf .NET 11](/de/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) und ist meist der teuerste Posten beim [Umzug einer .NET Framework 4.8-Codebasis auf .NET 11](/de/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/).
- Wenn JSON Ihr Ersatz ist, brauchen die `[Serializable]`-Typhierarchien, die BinaryFormatter implizit behandelte, [ausdrückliche `JsonDerivedType`-Annotationen](/de/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/), und sperrige Formen landen meist in [einem eigenen `JsonConverter`](/de/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/).
- Teams, die das zusammen mit einer Newtonsoft-Aufräumaktion angehen, sollten zuerst [die Newtonsoft-zu-System.Text.Json-Migration in einer großen Codebasis](/de/2026/05/migrate-from-newtonsoft-json-to-system-text-json-in-a-large-codebase/) lesen, weil beide Durchgänge dieselben Dateien anfassen.
- Getrimmte und AOT-Builds laufen gegen eine benachbarte Wand: siehe [reflection-based serialization has been disabled for this application](/de/2026/07/fix-reflection-based-serialization-has-been-disabled-for-this-application/) und die umfassendere Fehlersuche zu [PlatformNotSupportedException in Native AOT](/de/2026/05/fix-platformnotsupportedexception-in-native-aot/).

## Quellen

- [BinaryFormatter migration guide](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/), Microsoft Learn
- [Breaking change: In-box BinaryFormatter implementation removed and always throws](https://learn.microsoft.com/en-us/dotnet/core/compatibility/serialization/9.0/binaryformatter-removal), Microsoft Learn
- [Read BinaryFormatter (NRBF) payloads](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/read-nrbf-payloads), Microsoft Learn
- [Choose a serializer](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/choose-a-serializer), Microsoft Learn
- [WinForms and WPF OLE guidance](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/winforms-wpf-ole-guidance), Microsoft Learn
- [BinaryFormatter removal from .NET 9 is complete](https://github.com/dotnet/announcements/issues/317), dotnet/announcements
- [BinaryFormatter obsoletion plan](https://github.com/dotnet/designs/blob/main/accepted/2020/better-obsoletion/binaryformatter-obsoletion.md), dotnet/designs
- [MS-NRBF: .NET Remoting Binary Format specification](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-nrbf/)
