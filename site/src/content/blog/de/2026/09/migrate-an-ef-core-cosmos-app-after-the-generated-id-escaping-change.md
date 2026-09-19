---
title: "Eine EF Core Cosmos-App nach der Änderung am Escaping generierter ids in EF Core 11 migrieren"
description: "EF Core 11 escapt '/', '\\', '?' und '#' in generierten Cosmos DB id-Werten nicht mehr, daher werden Dokumente, die EF Core 8-10 geschrieben hat, nicht mehr über den Schlüssel gefunden. Wie Sie herausfinden, ob Sie betroffen sind, wann Sie den Schalter EscapeIllegalCosmosIdCharacters setzen und wie Sie die ids mit einem Transactional Batch sicher neu schreiben."
pubDate: 2026-09-19
updatedDate: 2026-09-19
template: migration
tags:
  - "migration"
  - "efcore"
  - "efcore-11"
  - "cosmos-db"
  - "dotnet-11"
lang: "de"
translationOf: "2026/09/migrate-an-ef-core-cosmos-app-after-the-generated-id-escaping-change"
translatedBy: "claude"
translationDate: 2026-09-19
---

EF Core 11 ändert, wie der Azure Cosmos DB-Provider die `id` eines Dokuments bildet, wenn diese `id` aus mehr als einem Wert besteht. EF Core 8, 9 und 10 ersetzten `/`, `\`, `?` und `#` in jedem Teil durch `^2F`, `^5C`, `^3F` und `^23`. EF Core 11 (die Änderung kam mit 11.0 Preview 5, und ich habe sie auf 11.0.0 RC 1 überprüft) schreibt stattdessen die rohen Zeichen. Wenn keiner Ihrer zusammengesetzten Schlüsselwerte eines dieser vier Zeichen enthält, ändert das Upgrade nichts, und Sie können nach dem nächsten Abschnitt aufhören zu lesen. Wenn doch, finden `FindAsync` und Schlüsselabfragen diese Dokumente nach dem Upgrade nicht mehr. Dann haben Sie zwei Möglichkeiten: den Schalter `Microsoft.EntityFrameworkCore.EscapeIllegalCosmosIdCharacters` vor dem Start der App setzen oder die betroffenen ids neu schreiben. Für Schlüssel, die `/` oder `\` enthalten, funktioniert nur der Schalter, weil Cosmos DB diese Zeichen in einer `id` ablehnt. Rechnen Sie mit etwa einer Stunde für die Prüfung; die meisten Teams werden nichts zu tun haben.

## Wer tatsächlich betroffen ist

Das Escaping galt immer nur für mehrteilige ids. Ich habe `JsonIdDefinition` am Tag von EF Core 11 RC 1 gelesen: Ein Schlüssel aus einem einzigen Wert wird unverändert geschrieben, und Escaping findet nur statt, wenn mehr als ein Wert mit `|` verbunden wird. Partitionsschlüssel-Eigenschaften werden vor dieser Prüfung aus der id entfernt. Ein Entitätstyp ist also nur betroffen, wenn eine dieser Bedingungen zutrifft:

- Sein Primärschlüssel hat nach dem Entfernen der Partitionsschlüssel-Eigenschaften noch zwei oder mehr Eigenschaften. Zum Beispiel ergibt `HasKey(x => new { x.TenantId, x.OrderId, x.Sku })` mit `HasPartitionKey(x => x.TenantId)` die id `OrderId|Sku`.
- Er verwendet `HasDiscriminatorInJsonId()`. Apps, die von EF Core 8 aktualisiert wurden, haben das in EF Core 9 oft eingeschaltet, um ihre alten `Post|1`-ids zu behalten, daher ist das der häufigste Weg, betroffen zu sein.

Dann muss einer der Schlüsselwerte `/`, `\`, `?` oder `#` enthalten. GUID- und Integer-Schlüssel können das nicht. Freitext- oder pfadartige String-Schlüssel (SKUs wie `shoes/red`, Slugs wie `2026/09/hello`, Dateinamen, URLs) sind die Stellen, an denen es zuschlägt.

Ich habe dieselben Entitäten ohne Datenbank durch EF Core 10.0.12 und EF Core 11.0.0 RC 1 geschickt. Das Hinzufügen einer Entität zu einem `DbContext` führt den id-Wertgenerator aus, daher lässt sich die generierte id direkt aus dem Change Tracker lesen:

| Schlüsselwerte | EF Core 10.0.12 | EF Core 11 RC 1 | EF Core 11 RC 1 + Schalter |
| ---------- | --------------- | --------------- | ------------------------ |
| `o-1`, `shoes/red` | `o-1\|shoes^2Fred` | `o-1\|shoes/red` | `o-1\|shoes^2Fred` |
| `o-1`, `shoes^2Fred` | `o-1\|shoes^2Fred` | `o-1\|shoes^2Fred` | `o-1\|shoes^2Fred` |
| `o-1`, `C:\temp?#1` | `o-1\|C:^5Ctemp^3F^231` | `o-1\|C:\temp?#1` | `o-1\|C:^5Ctemp^3F^231` |
| `o-1`, `a\|b` | `o-1\|a^\|b` | `o-1\|a^\|b` | `o-1\|a^\|b` |
| einzelner Schlüssel `shoes/red` | `shoes/red` | `shoes/red` | `shoes/red` |
| `HasDiscriminatorInJsonId`, `2026/09/hello` | `LegacyPost\|2026^2F09^2Fhello` | `LegacyPost\|2026/09/hello` | `LegacyPost\|2026^2F09^2Fhello` |

Die ersten beiden Zeilen sind der Grund für die Änderung ([dotnet/efcore#38244](https://github.com/dotnet/efcore/issues/38244)). Das Escape-Zeichen `^` wurde selbst nie escapt, daher bekamen `shoes/red` und `shoes^2Fred` dieselbe id, und das zweite Insert überschrieb stillschweigend das erste Dokument. Das EF-Team hat entschieden, das Escaping ganz einzustellen, statt zusätzlich `^` zu escapen, weil das Escapen von `^` jede bestehende id mit einem Caret gebrochen hätte. Der Fix ist [dotnet/efcore#38245](https://github.com/dotnet/efcore/pull/38245), gemergt am 2026-05-08. Beachten Sie, dass das Trennzeichen `|` in beiden Versionen weiterhin als `^|` escapt wird, dieser Teil Ihrer ids bleibt also gleich.

## Was kaputtgeht

| Bereich | Änderung nach dem Upgrade auf EF Core 11 | Schweregrad |
| ---- | ------------------------------------ | -------- |
| `FindAsync` und Abfragen, die auf den vollständigen Schlüssel plus Partitionsschlüssel filtern | EF macht daraus einen Point Read mit der neu generierten id, daher kommen Dokumente, die mit escapter id gespeichert sind, als `null` oder als leeres Ergebnis zurück | hoch |
| Einfügen einer Entität, deren Schlüssel einem alten Dokument entspricht | Die neue id ist anders, daher erhalten Sie bei `?` und `#` ein zweites Dokument mit denselben Schlüsselwerten statt eines Konflikts | hoch |
| Neue Schlüssel mit `/` oder `\` | EF 11 sendet diese Zeichen jetzt in der id, und der Cosmos DB-Dienst erlaubt `/` und `\` in einer id nicht ([Dienstlimits](https://learn.microsoft.com/azure/cosmos-db/concepts-limits#per-item-limits)), daher schlägt der Schreibvorgang fehl | hoch |
| Updates und Deletes von Entitäten, die per Abfrage geladen wurden | Funktionieren weiterhin: `SaveChanges` verwendet den `__id`-Wert, der aus dem Dokument materialisiert wurde, keinen neu generierten | keiner |
| Abfragen, die nicht auf den vollständigen Schlüssel filtern | Funktionieren weiterhin, sie verwenden die id nicht | keiner |

Die zweite Zeile ist die gefährliche. Das verbreitete Muster "suchen und hinzufügen, falls es fehlt" liefert für das alte Dokument `null` und legt daneben ein Duplikat an. Es wird keine Exception ausgelöst.

## Checkliste vor dem Start

- Die App kompiliert gegen `Microsoft.EntityFrameworkCore.Cosmos` 11.0.0-rc.1.26425.128 (oder GA, sobald es erscheint), und Sie haben den Rest der [Breaking Changes in EF Core 11](https://learn.microsoft.com/ef/core/what-is-new/ef-core-11.0/breaking-changes) gelesen. Der Cosmos-Provider hat in 11 mehrere Änderungen, darunter das Entfernen von synchronem I/O und des Round-Trippings nicht gemappter Eigenschaften.
- Sie haben Zugriff über Data Explorer oder das SDK auf jeden Container, in den EF schreibt.
- Continuous Backup oder eine Point-in-Time-Wiederherstellung ist auf dem Konto aktiviert, bevor Sie ids neu schreiben.
- Sie wissen, welche Schlüsseleigenschaften vom Benutzer gelieferte oder Freitext-Strings enthalten.

## Migrationsschritte

1. **Die Entitätstypen mit mehrteiligen ids auflisten.**
   Dieser Code durchläuft das EF-Modell mit öffentlichen Cosmos-Metadaten-APIs und wendet dieselbe Regel an wie der Provider:

   ```csharp
   // EF Core 11.0 RC 1, .NET 11 RC 1
   foreach (var entityType in db.Model.GetEntityTypes().Where(t => !t.IsOwned()))
   {
       var key = entityType.FindPrimaryKey()!;
       var partitionKeyNames = entityType.GetPartitionKeyPropertyNames();
       var idParts = key.Properties.Count(p => !partitionKeyNames.Contains(p.Name));
       var discriminatorInId = entityType.GetDiscriminatorInKey()
           is IdDiscriminatorMode.EntityType or IdDiscriminatorMode.RootEntityType;

       Console.WriteLine($"{entityType.DisplayName(),-12} container={entityType.GetContainer(),-8} " +
           $"id parts={idParts} discriminator in id={discriminatorInId} " +
           $"-> {(idParts > 1 || discriminatorInId ? "AFFECTED" : "not affected")}");
   }
   ```

   Für ein Modell mit einer partitionierten `OrderLine` (Schlüssel `TenantId, OrderId, Sku`) und einem `Product` mit Einzelschlüssel gibt er aus:

   ```text
   OrderLine    container=Orders   id parts=2 discriminator in id=False -> AFFECTED
   Product      container=Catalog  id parts=1 discriminator in id=False -> not affected
   ```

   Prüfen: Jeder mit `AFFECTED` markierte Entitätstyp hat mindestens eine `string`-Schlüsseleigenschaft. Wenn alle `Guid`, `int` oder `long` sind, sind Sie fertig. EF Core 11 generiert dafür dieselben ids wie EF Core 10.

2. **Die Dokumente zählen, die tatsächlich eine Escape-Sequenz tragen.**
   Führen Sie das in Data Explorer gegen jeden Container aus, der einen betroffenen Typ enthält:

   ```sql
   -- Azure Cosmos DB for NoSQL
   SELECT c.id, c["$type"] FROM c
   WHERE CONTAINS(c.id, "^2F") OR CONTAINS(c.id, "^5C")
      OR CONTAINS(c.id, "^3F") OR CONTAINS(c.id, "^23")
   ```

   `$type` ist der JSON-Diskriminatorname, den EF seit EF Core 9 schreibt. EF Core 11 hat die Modelleigenschaft in `Discriminator` umbenannt, aber der Name im JSON ist weiterhin `$type`. Prüfen: Null Zeilen bedeuten, dass kein gespeichertes Dokument seine id ändert. Dann bleibt nur die Frage, ob *neue* Schlüssel diese Zeichen enthalten können, und dafür gilt Schritt 3 weiterhin.

3. **Entscheiden: das alte Escaping behalten oder auf rohe ids umstellen.**
   Verwenden Sie diese Regel:

   - Schlüssel können `/` oder `\` enthalten: Behalten Sie das alte Escaping mit dem Schalter (Schritt 4). Rohe ids mit diesen Zeichen lassen sich in Cosmos DB nicht speichern, es gibt also nichts, wohin man migrieren könnte. Die einzige Alternative ist, die Schlüsselwerte selbst zu ändern.
   - Schlüssel können nur `?` oder `#` enthalten: Sie können die ids neu schreiben (Schritt 5) und das alte Escaping endgültig aufgeben. Damit verschwindet auch der Kollisionsfehler.
   - Schlüsselwerte können von Benutzern geliefert werden: Beachten Sie, dass bei eingeschaltetem Schalter ein Benutzer, der den literalen String `shoes^2Fred` sendet, `shoes/red` überschreiben kann. Wenn das relevant ist, validieren Sie die Schlüsseleingabe so, dass sie nie `^` enthält.

   Prüfen: Halten Sie die Entscheidung pro Entitätstyp schriftlich fest. Ein gemischter Container kann beides brauchen.

4. **Wenn Sie das Escaping behalten, setzen Sie den Schalter, bevor EF lädt.**
   Der Provider liest den Schalter einmal, in ein `static readonly`-Feld von `JsonIdDefinition`. Der sicherste Ort dafür ist die Projektdatei, weil MSBuild ihn in `runtimeconfig.json` schreibt:

   ```xml
   <!-- EF Core 11.0, .NET 11 -->
   <ItemGroup>
     <RuntimeHostConfigurationOption Include="Microsoft.EntityFrameworkCore.EscapeIllegalCosmosIdCharacters"
                                     Value="true" />
   </ItemGroup>
   ```

   `AppContext.SetSwitch("Microsoft.EntityFrameworkCore.EscapeIllegalCosmosIdCharacters", true)` funktioniert ebenfalls, solange es die erste Zeile von `Program.cs` ist, bevor irgendein `DbContext` erstellt wurde. Prüfen Sie das mit dem id-Generator selbst (Schritt 6). Ich habe auf RC 1 sowohl den Eintrag in `runtimeconfig.json` als auch einen `SetSwitch`-Aufruf beim Start getestet, und beide ergaben `o-1|shoes^2Fred`.

5. **Wenn Sie auf rohe ids umstellen, schreiben Sie die Dokumente an Ort und Stelle neu.**
   Cosmos DB kann eine `id` nicht umbenennen, daher wird jedes Dokument unter der neuen id neu angelegt und das alte gelöscht. Beide Dokumente teilen sich einen Partitionsschlüssel, daher macht ein Transactional Batch den Austausch atomar. Berechnen Sie die neue id mit EF Core 11 selbst, statt das Format nachzubauen: Fügen Sie eine Instanz, die nur den Schlüssel enthält, einem Wegwerf-Kontext hinzu und lesen Sie `__id`. Schreiben Sie mit dem rohen JSON und nicht über EF neu, weil EF Core 11 JSON-Eigenschaften, die nicht im Modell gemappt sind, nicht mehr behält; ein Speichern über EF würde sie verwerfen.

   ```csharp
   // EF Core 11.0 RC 1, Microsoft.Azure.Cosmos 3.x, .NET 11 RC 1
   // Run with the switch OFF, so EF generates the new ids.
   using var client = new CosmosClient(connectionString);
   var container = client.GetContainer("shop", "Orders");
   var query = new QueryDefinition(
       """
       SELECT * FROM c
       WHERE c["$type"] = "OrderLine"
         AND (CONTAINS(c.id, "^2F") OR CONTAINS(c.id, "^5C") OR CONTAINS(c.id, "^3F") OR CONTAINS(c.id, "^23"))
       """);

   await using var idContext = new ShopContext(connectionString); // never saved
   using var iterator = container.GetItemQueryStreamIterator(query);
   while (iterator.HasMoreResults)
   {
       using var page = await iterator.ReadNextAsync();
       page.EnsureSuccessStatusCode();
       var documents = JsonNode.Parse(page.Content)!["Documents"]!.AsArray();

       foreach (var doc in documents.Select(d => d!.AsObject()))
       {
           var oldId = (string)doc["id"]!;
           var line = new OrderLine
           {
               TenantId = (string)doc["TenantId"]!,
               OrderId = (string)doc["OrderId"]!,
               Sku = (string)doc["Sku"]!,
           };
           var entry = idContext.Add(line);
           var newId = (string)entry.Property("__id").CurrentValue!;
           entry.State = EntityState.Detached;

           if (newId == oldId) continue; // the key really contains "^2F"
           if (newId.Contains('/') || newId.Contains('\\'))
           {
               Console.WriteLine($"BLOCKED  {oldId} -> {newId}");
               continue;
           }

           Console.WriteLine($"{(apply ? "REWRITE " : "DRY RUN ")} {oldId} -> {newId}");
           if (!apply) continue;

           var etag = (string)doc["_etag"]!;
           foreach (var system in new[] { "_rid", "_self", "_etag", "_attachments", "_ts" })
               doc.Remove(system);
           doc["id"] = newId;

           using var body = new MemoryStream(JsonSerializer.SerializeToUtf8Bytes(doc));
           using var result = await container
               .CreateTransactionalBatch(new PartitionKey(line.TenantId))
               .CreateItemStream(body)
               .DeleteItem(oldId, new TransactionalBatchItemRequestOptions { IfMatchEtag = etag })
               .ExecuteAsync();

           if (!result.IsSuccessStatusCode)
               Console.WriteLine($"  FAILED {result.StatusCode}: {result.ErrorMessage}");
       }
   }
   ```

   Der Schlüssel wird aus den eigenen Eigenschaften des Dokuments gelesen, nicht aus der escapten id rekonstruiert. Genau das macht das Tool für den Kollisionsfall sicher: Ein als `o-1|shoes^2Fred` gespeichertes Dokument, dessen `Sku` tatsächlich `shoes^2Fred` ist, ergibt auf EF 11 dieselbe id und wird daher übersprungen. Ich habe die id-Logik offline auf RC 1 gegen vier Beispieldokumente laufen lassen. Sie gab `BLOCKED o-1|shoes^2Fred -> o-1|shoes/red`, `DRY RUN o-1|gift^23card -> o-1|gift#card` und `DRY RUN o-1|what^3F -> o-1|what?` aus und übersprang das literale `shoes^2Fred`. Den Batch habe ich nicht gegen ein echtes Konto oder den Emulator ausgeführt, also machen Sie zuerst den Probelauf und dann `--apply` gegen eine wiederhergestellte Kopie der Datenbank. Das `IfMatchEtag` beim Delete lässt den Batch fehlschlagen, statt einen gleichzeitigen Schreibvorgang zu verlieren. Wenn er fehlschlägt, führen Sie das Tool erneut aus. Prüfen: Die Abfrage aus Schritt 2 liefert nur noch `BLOCKED`-Dokumente oder gar keine.

6. **Das id-Format mit einem Test festschreiben.**
   Der id-Generator läuft bei `Add`, daher kann ein Unit-Test das Format ohne Cosmos DB prüfen:

   ```csharp
   // EF Core 11.0 RC 1, xUnit v3
   [Theory]
   [InlineData("shoes/red", "o-1|shoes^2Fred")] // expected with the switch on
   [InlineData("gift#card", "o-1|gift^23card")]
   public void Generated_id_matches_stored_documents(string sku, string expectedId)
   {
       using var db = new ShopContext("AccountEndpoint=https://localhost:8081/;AccountKey=dGVzdA==");
       var entry = db.Add(new OrderLine { TenantId = "t1", OrderId = "o-1", Sku = sku });
       Assert.Equal(expectedId, entry.Property("__id").CurrentValue);
   }
   ```

   Prüfen: Der Test besteht in der CI mit derselben `runtimeconfig.json`, mit der die App ausgeliefert wird. Wenn jemand die `RuntimeHostConfigurationOption` entfernt, schlägt dieser Test fehl statt der Produktion.

## Verifizierung

Prüfen Sie nach der Bereitstellung von EF Core 11 diese drei Dinge gegen echte Daten:

- `await db.OrderLines.FindAsync("t1", "o-1", "shoes/red")` (ein Schlüssel, der früher escapt wurde) liefert die Entität und nicht `null`.
- Die Abfrage aus Schritt 2 liefert dieselbe Anzahl wie vorher, wenn Sie den Schalter behalten haben, und null (abgesehen von `BLOCKED`-Zeilen), wenn Sie migriert haben.
- Eine Abfrage nach Duplikaten liefert nichts: `SELECT c.TenantId, c.OrderId, c.Sku, COUNT(1) AS n FROM c GROUP BY c.TenantId, c.OrderId, c.Sku`, suchen Sie dann nach einem `n` größer als 1. Das fängt die stillen doppelten Inserts aus der Tabelle "Was kaputtgeht" ab.

## Rollback-Plan

Das Behalten des Schalters ist vollständig umkehrbar: Machen Sie das Paket-Upgrade rückgängig, und EF Core 10 generiert dieselben ids wie immer. Das Neuschreiben von ids lässt sich durch erneutes Bereitstellen nicht umkehren. EF Core 10 generiert wieder escapte ids und findet die neu geschriebenen Dokumente nicht. Das Neuschreiben bindet Sie also an EF Core 11. Wenn Sie einen Weg zurück brauchen, stellen Sie entweder den Container aus dem Backup wieder her, das Sie vor dem Neuschreiben angelegt haben, oder stellen Sie EF Core 11 mit eingeschaltetem Schalter bereit (die alten ids sind damit weiterhin gültig) und lassen Sie das Tool in umgekehrter Richtung laufen. Testen Sie diesen Weg, bevor Sie sich darauf verlassen.

## Stolperfallen

- **Der Schaltername kursiert in zwei Schreibweisen.** Das Issue und ein Codekommentar in `JsonIdDefinition` nennen beide `Microsoft.EntityFrameworkCore.EscapeIllegalIdCharacters`. Der Code liest tatsächlich `Microsoft.EntityFrameworkCore.EscapeIllegalCosmosIdCharacters`, was auch in der Breaking-Changes-Dokumentation steht. Ich habe den kürzeren Namen auf RC 1 in `runtimeconfig.json` gesetzt, und er hatte keine Wirkung: Die ids blieben unescapt.
- **Ein spät gesetzter Schalter bewirkt nichts.** In meinem Test wurde `AppContext.SetSwitch`, aufgerufen nachdem der erste `DbContext` eine id generiert hatte, ignoriert, und der nächste Kontext erzeugte weiterhin `o-2|shoes/red`. Gehostete Apps, die Schalter nach `builder.Build()` aus der Konfiguration setzen, laufen in genau dieses Problem.
- **Einzelschlüssel-ids wurden nie escapt.** Ein `Product` mit `Id = "shoes/red"` wurde immer als `shoes/red` geschrieben, auf 10 wie auf 11, daher galt die Cosmos DB-Einschränkung für `/` dort schon immer. Die Änderung betrifft nur ids, die aus mehreren Werten bestehen.
- **Partitionsschlüssel-Eigenschaften sind nicht Teil der id.** Ignorieren Sie beim Prüfen Ihrer Schlüssel die Eigenschaften, die Sie an `HasPartitionKey` übergeben. Diese Werte können beliebige Zeichen enthalten, weil der Provider sie als Partitionsschlüssel sendet und nicht in der id.
- **Batches gelten pro Partition und sind auf 100 Operationen begrenzt.** Das Tool sendet einen Batch pro Dokument, damit Fehler lokal bleiben. Wenn Sie mehrere Dokumente in einem Batch bündeln, gruppieren Sie sie nach Partitionsschlüssel und bleiben Sie unter dem Limit.

## Verwandte Artikel

- Das Tool zum Neuschreiben nutzt denselben Mechanismus, den EF Core 11 jetzt für jedes `SaveChanges` verwendet: [EF Core 11 schaltet Cosmos DB Transactional Batches standardmäßig ein](/de/2026/04/efcore-11-cosmos-transactional-batches/).
- Wenn Sie mehrere Hauptversionen auf einmal überspringen, listet [die Migration von EF Core 6 auf EF Core 11](/de/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) die anderen Breaking Changes auf, auf die Sie unterwegs stoßen.
- Ein weiterer Standard in EF Core 11, der sich bei einem Upgrade still ändert: [SQL Server-Kompatibilitätsgrad 150 vs. 160](/de/2026/09/sql-server-compatibility-level-150-vs-160-what-changes-for-ef-core-11-queries/).
- Um jeden Point Read zu protokollieren und zu sehen, welche ids EF bei Cosmos DB anfragt, ist [ein EF Core Interceptor](/de/2026/09/what-is-an-ef-core-interceptor-and-when-do-i-need-one/) der leichtgewichtigste Einstiegspunkt.
- Wenn Owned Types in Ihren Cosmos-Dokumenten ebenfalls auf der Upgrade-Liste stehen, lesen Sie [Complex Types vs. Owned Entities in EF Core 11](/de/2026/07/complex-types-vs-owned-entities-in-ef-core-11/).

## Quellen

- [Breaking Changes in EF Core 11: Unzulässige Cosmos-`id`-Zeichen werden nicht mehr escapt](https://learn.microsoft.com/ef/core/what-is-new/ef-core-11.0/breaking-changes#cosmos-no-id-escape)
- [dotnet/efcore#38244: Generierte `id`-Werte können kollidieren, wenn Schlüsselwerte Escape-Sequenzen enthalten](https://github.com/dotnet/efcore/issues/38244)
- [dotnet/efcore#38245: Unzulässige id-Zeichen nicht escapen](https://github.com/dotnet/efcore/pull/38245)
- [`JsonIdDefinition.cs` bei v11.0.0-rc.1.26425.128](https://github.com/dotnet/efcore/blob/v11.0.0-rc.1.26425.128/src/EFCore.Cosmos/Metadata/Internal/JsonIdDefinition.cs)
- [`JsonIdDefinitionFactory.cs` bei v11.0.0-rc.1.26425.128](https://github.com/dotnet/efcore/blob/v11.0.0-rc.1.26425.128/src/EFCore.Cosmos/Metadata/Internal/JsonIdDefinitionFactory.cs)
- [Dienstkontingente von Azure Cosmos DB: zulässige Zeichen für den ID-Wert](https://learn.microsoft.com/azure/cosmos-db/concepts-limits#per-item-limits)
- [Transactional-Batch-Operationen in Azure Cosmos DB](https://learn.microsoft.com/azure/cosmos-db/transactional-batch)
- [Breaking Changes in EF Core 9: Diskriminator nicht mehr in der `id` enthalten](https://learn.microsoft.com/ef/core/what-is-new/ef-core-9.0/breaking-changes#cosmos-id-property-changes)
