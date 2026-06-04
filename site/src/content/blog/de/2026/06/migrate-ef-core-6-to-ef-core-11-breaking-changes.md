---
title: "Von EF Core 6 auf EF Core 11 migrieren: die Breaking Changes, die wirklich wehtun"
description: "Ein versionsgenauer Migrationsleitfaden von EF Core 6.0 auf EF Core 11.0, der die Breaking Changes von EF7, 8, 9, 10 und 11 durchgeht, die echte Apps brechen: Encrypt=True, Contains mit OPENJSON, PendingModelChangesWarning, die native json-Spalte und die Aufteilung von SqlClient 7.0."
pubDate: 2026-06-04
updatedDate: 2026-06-04
template: migration
tags:
  - "migration"
  - "ef-core"
  - "ef-core-6"
  - "ef-core-11"
  - "dotnet-11"
lang: "de"
translationOf: "2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes"
translatedBy: "claude"
translationDate: 2026-06-04
---

Der Wechsel von EF Core 6.0 auf EF Core 11.0 sind fünf Hauptversionen in einem Sprung, und die schmerzhaften Teile sind fast nie die API-Umbenennungen. Es sind die stillen Verhaltensänderungen: eine Verbindungszeichenfolge, die jahrelang funktioniert hat, wirft jetzt einen SSL-Fehler, eine `Contains`-Abfrage erreicht plötzlich auf einem alten SQL Server das Zeitlimit, und eine Bereitstellung bricht ab, weil EF entschieden hat, dass Ihr Modell ausstehende Änderungen hat. Planen Sie einen halben Tag für einen kleinen Dienst und zwei bis vier Tage für einen Monolithen mit einem nicht-trivialen Modell, benutzerdefinierten Wertkonvertern und einem Database-First-Scaffolding-Flow ein. Nichts davon ist auf Datenbankebene eine Einbahnstraße, aber zwei Änderungen (der `Encrypt`-Standardwert in EF Core 7 und die `PendingModelChangesWarning`-Ausnahme in EF Core 9) verhindern, dass Ihre App am ersten Tag startet, wenn Sie nicht dafür planen.

Dieser Leitfaden fixiert `Microsoft.EntityFrameworkCore` 6.0 als Quelle und 11.0 als Ziel, lauffähig auf .NET 11. Da die Target-Framework-Untergrenze von EF Core unterwegs steigt (EF Core 7 benötigt .NET 6, EF Core 8 und 9 benötigen .NET 8, EF Core 10 benötigt .NET 10 und EF Core 11 benötigt .NET 11), ist dies auch eine Runtime-Migration. Falls Sie die Runtime noch nicht migriert haben, tun Sie das zuerst mit der [Checkliste von .NET 8 auf .NET 11](/de/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) und kehren Sie dann zurück.

## Warum jetzt migrieren

- EF Core 6.0 hat im November 2024 den Support verlassen. Sie betreiben eine nicht unterstützte Datenschicht gegen eine unterstützte Runtime, was für eine Sicherheitsprüfung das Schlechteste aus beiden Welten ist.
- EF Core 11 bringt echte Abfragegewinne kostenlos: die `OPENJSON`-basierte `Contains`-Übersetzung (seit EF 8 dreimal verfeinert), bessere Kardinalitätsschätzungen durch mehrere skalare Parameter und den nativen SQL-Server-`json`-Spaltentyp mit erstklassiger Indizierung.
- `ExecuteUpdate` und `ExecuteDelete`, in EF Core 7 hinzugefügt und seitdem in jeder Version verbessert, verwandeln mengenbasierte Schreibvorgänge in eine einzelne SQL-Anweisung. Wenn Sie noch Entitäten laden, um sie zu mutieren, verschenken Sie eine bis zwei Größenordnungen. Siehe [ExecuteUpdate im Vergleich zum Laden von Entitäten und SaveChanges](/de/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) für den Benchmark.
- Die Migrations-Leitplanken, die in EF 9 (Erkennung ausstehender Modelländerungen) und EF 11 (Erkennung fehlender Migrationen) kamen, fangen eine ganze Klasse von Produktionsvorfällen ab, bei denen Datenbank und Modell stillschweigend auseinanderdrifteten.

## Was bricht

Dies ist die kumulative Liste über alle fünf Versionen. Die Schwere gibt an, wie wahrscheinlich eine typische App bricht, nicht wie schwer die Korrektur ist.

| Bereich | Änderung | Version | Schwere |
| ------- | -------- | ------- | ------- |
| SQL-Server-Verbindungen | `Encrypt` ist jetzt standardmäßig `true`; nicht vertrauenswürdige Zertifikate werfen eine Ausnahme | EF 7 | hoch |
| SaveChanges mit Triggern | Der OUTPUT-Klausel-Pfad bricht bei Tabellen mit Triggern oder bestimmten berechneten Spalten | EF 7 | hoch |
| Optionale Beziehungen | Verwaiste abhängige Entitäten werden beim Trennen nicht mehr automatisch gelöscht | EF 7 | mittel |
| `Contains` über eine Liste | Über `OPENJSON` übersetzt; schlägt unter SQL Server 2016 / Kompatibilitätsgrad 130 fehl | EF 8 | hoch |
| `Contains`-Leistung | Der `OPENJSON`-Plan kann bei manchen Workloads stark zurückfallen | EF 8 | hoch |
| Enums in JSON-Spalten | Standardmäßig als `int` statt als `string` gespeichert | EF 8 | hoch |
| String-Schlüssel auf SQL Server | Im Change-Tracker ohne Beachtung der Groß-/Kleinschreibung verglichen | EF 8 | mittel |
| Migrationen anwenden | `PendingModelChangesWarning` wirft jetzt eine Ausnahme bei `Migrate()` | EF 9 | hoch |
| Migrationen in einer Transaktion | Eine externe Transaktion um `Migrate()` wirft jetzt eine Ausnahme | EF 9 | hoch |
| `EF.Constant` / `EF.Parameter` | Werfen `InvalidCastException` innerhalb kompilierter Abfragen | EF 9 | niedrig |
| EF-Tools, Multi-Target-Projekte | `--framework` ist jetzt erforderlich | EF 10 | mittel |
| Parametrisierte Sammlungen | Die Standardübersetzung sind jetzt mehrere skalare Parameter | EF 10 | niedrig |
| JSON-Speicherung auf SQL Server | JSON in `nvarchar(max)` migriert zum nativen `json` bei Kompatibilitätsgrad 170 / Azure SQL | EF 10 | niedrig |
| Migrate ohne Migrationen | Wirft standardmäßig eine Ausnahme statt zu protokollieren | EF 11 | niedrig |
| `Microsoft.Data.SqlClient` 7.0 | Die Entra-ID-Authentifizierungsabhängigkeiten werden in ein separates Paket ausgelagert | EF 11 | mittel |

Die maßgeblichen Listen pro Version sind am Ende verlinkt. Lesen Sie die Seiten zu [EF 7](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-7.0/breaking-changes), [EF 8](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/breaking-changes) und [EF 9](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/breaking-changes) vor dem Start; diese drei tragen die Änderungen mit hoher Schwere.

## Vorab-Checkliste

1. Migrieren Sie die Runtime auf .NET 11 und bestätigen Sie zuerst einen sauberen `dotnet test` mit den alten EF-Core-6-Paketen. Es soll sich jeweils nur eine Variable ändern, damit das erste Rot nach dem EF-Sprung eindeutig ist.
2. Inventarisieren Sie Ihren Provider. SQL Server, SQLite, PostgreSQL (Npgsql) und Cosmos haben jeweils eigene Breaking Changes. Dieser Leitfaden konzentriert sich auf SQL Server und weist auf SQLite hin, wo es abweicht.
3. Prüfen Sie Version und Kompatibilitätsgrad Ihres SQL Servers. Die `Contains`-Änderung von EF 8 benötigt Kompatibilitätsgrad 130 oder höher:
   ```sql
   -- run against your target database
   SELECT name, compatibility_level FROM sys.databases;
   ```
4. Suchen Sie nach `Database.Migrate(` und `MigrateAsync(`. Jede Aufrufstelle ist ein Kandidat für die Ausnahme bei ausstehenden Änderungen von EF 9 und die Ausnahme bei expliziter Transaktion von EF 9.
5. Suchen Sie nach `.HasConversion<string>()` bei Enums und nach allen Enum-Eigenschaften, die in JSON-gemappte Owned-Typen abgebildet werden. Das ist die Enum-in-JSON-Änderung von EF 8.
6. Notieren Sie, ob Sie Entra-ID-Authentifizierung (Azure AD) in einer Verbindungszeichenfolge verwenden (`Authentication=Active Directory Default`, verwaltete Identität, Dienstprinzipal). Das ist die SqlClient-Aufteilung von EF 11.
7. Erstellen Sie einen Branch für die Migration und sichern Sie die Datenbank. Schemaändernde Migrationen (maximale Länge des Diskriminators, natives `json`) werden automatisch generiert und sollten überprüft werden, bevor sie gegen die Produktion laufen.

## Migrationsschritte

1. **Heben Sie alle EF-Core-Pakete in einem Zug auf 11.0 an.** Steigen Sie nicht Version für Version; die Breaking Changes sind kumulativ und pro Version dokumentiert, daher ist ein einziger Sprung mit geöffneter Dokumentation schneller als fünf Zwischenkompilierungen. Aktualisieren Sie `Microsoft.EntityFrameworkCore`, den Provider (`Microsoft.EntityFrameworkCore.SqlServer`) und `Microsoft.EntityFrameworkCore.Design`. Prüfen Sie mit `dotnet restore` und `dotnet build` und behandeln Sie die ersten Kompilierungsfehler als den tatsächlichen Umfang.
   ```xml
   <!-- src/MyApp.csproj, EF Core 11 on .NET 11 -->
   <ItemGroup>
     <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0" />
     <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="11.0.0" PrivateAssets="all" />
   </ItemGroup>
   ```

2. **Aktualisieren Sie das `dotnet ef`-Tool auf eine passende Hauptversion.** Das 6.x-Tool kann ein 11.0-Modell nicht lesen. Prüfen Sie mit `dotnet ef --version` und bestätigen Sie `11.0.x`.
   ```bash
   dotnet tool update --global dotnet-ef --version 11.*
   ```

3. **Beheben Sie zuerst den `Encrypt=True`-Standardwert.** Dies ist die Änderung von EF Core 7, die in `Microsoft.Data.SqlClient` lebt, nicht in EF, daher gibt es keinen Schalter auf EF-Seite. Auf einem Entwicklungsrechner ohne vertrauenswürdiges Serverzertifikat wirft Ihre erste Verbindung einen SSL-Fehler. Fügen Sie für die lokale Entwicklung `TrustServerCertificate=True` hinzu; installieren Sie in der Produktion ein gültiges Zertifikat. Prüfen Sie durch Öffnen einer Verbindung: `dotnet ef dbcontext info` sollte ohne SSL-Provider-Fehler verbinden.
   ```text
   Server=localhost;Database=App;Trusted_Connection=True;TrustServerCertificate=True
   ```

4. **Behandeln Sie die Migrations-Leitplanken an jeder `Migrate()`-Aufrufstelle.** EF Core 9 wirft `PendingModelChangesWarning`, wenn das Modell von der letzten Migration abweicht, und EF Core 11 wirft `MigrationsNotFound`, wenn es überhaupt keine Migrationen gibt. Wenn Sie das Schema mit Migrationen verwalten, besteht die Korrektur darin, die fehlende Migration hinzuzufügen. Wenn Sie das Schema anders verwalten (Dapper, DACPAC, handgeschriebenes SQL) und `Migrate()` nur aus Gewohnheit aufrufen, entfernen Sie den Aufruf oder unterdrücken Sie die Warnungen. Prüfen Sie durch Ausführen von `dotnet ef migrations has-pending-model-changes` und ein sauberes Ergebnis.
   ```csharp
   // EF Core 11. Only suppress if you intentionally manage schema elsewhere.
   protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
       => optionsBuilder.ConfigureWarnings(w =>
       {
           w.Ignore(RelationalEventId.PendingModelChangesWarning);
           w.Ignore(RelationalEventId.MigrationsNotFound);
       });
   ```

5. **Entfernen Sie jede explizite Transaktion, die `Migrate()` umschließt.** Das gängige Muster der "resilienten Migration" (Transaktion beginnen, migrieren, committen, innerhalb einer Ausführungsstrategie) wirft in EF Core 9 `MigrationsUserTransactionWarning`, weil EF die Transaktion und die Datenbanksperre jetzt selbst verwaltet. Löschen Sie den Wrapper und rufen Sie `MigrateAsync` direkt auf. Prüfen Sie, dass die App startet und die Migrationen einmal anwendet.
   ```csharp
   // EF Core 9+. EF manages the transaction and execution strategy.
   await dbContext.Database.MigrateAsync(cancellationToken);
   ```

6. **Bestätigen Sie den SQL-Server-Kompatibilitätsgrad für die `Contains`-Änderung.** Wenn `sys.databases` einen Grad unter 130 meldet, schlägt die `OPENJSON`-Übersetzung von EF Core 8 zur Laufzeit fehl. Heben Sie den Grad an, wenn Sie können, oder fixieren Sie den Übersetzungsmodus. Prüfen Sie durch Ausführen einer Abfrage, die `.Where(x => list.Contains(x.Id))` verwendet, und bestätigen Sie gültiges SQL.
   ```csharp
   // EF Core 10+: pick the translation strategy explicitly.
   // Constant = pre-EF8 inlining, Parameter = OPENJSON, MultipleParameters = EF10 default.
   protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
       => optionsBuilder.UseSqlServer(connectionString,
           o => o.UseParameterizedCollectionMode(ParameterTranslationMode.MultipleParameters));
   ```

7. **Fixieren Sie die Enum-in-JSON-Speicherung, wenn Sie auf String-Werte angewiesen sind.** EF Core 8 änderte Enums innerhalb von JSON-gemappten Owned-Typen von Strings auf Ganzzahlen. Bestehende, von EF 6 geschriebene Dokumente enthalten Strings; nach dem Upgrade liest EF sie als Ganzzahlen und schlägt fehl. Erzwingen Sie die String-Konvertierung, damit alte Daten lesbar bleiben. Prüfen Sie durch einen Round-Trip einer Entität mit einer Enum-Eigenschaft in einer JSON-Spalte.
   ```csharp
   protected override void ConfigureConventions(ModelConfigurationBuilder configurationBuilder)
       => configurationBuilder.Properties<OrderStatus>().HaveConversion<string>();
   ```

8. **Fügen Sie eine Migration für die Schemaänderungen hinzu, die EF jetzt will.** EF Core 8 gibt TPH-Diskriminatorspalten eine begrenzte maximale Länge, und EF Core 10 mappt JSON-Spalten auf Azure SQL oder bei Kompatibilitätsgrad 170 auf den nativen `json`-Typ. Generieren Sie die Migration, lesen Sie sie und wenden Sie sie erst dann an. Prüfen Sie mit einer Durchsicht der generierten `AlterColumn`-Operationen.
   ```bash
   dotnet ef migrations add UpgradeToEfCore11
   dotnet ef migrations script --idempotent --output migrate.sql
   ```

9. **Lagern Sie die Entra-ID-Authentifizierung aus, falls Sie sie verwenden.** EF Core 11 wechselt zu `Microsoft.Data.SqlClient` 7.0, das die Azure-Authentifizierungsabhängigkeiten aus dem Kernpaket entfernt. Wenn eine Verbindungszeichenfolge `Active Directory`-Authentifizierung verwendet, fügen Sie das Erweiterungspaket hinzu. Prüfen Sie durch Verbinden mit der verwalteten Identität in einer bereitgestellten Umgebung, nicht nur lokal.
   ```xml
   <PackageReference Include="Microsoft.Data.SqlClient.Extensions.Azure" Version="7.0.0" />
   ```

## Verifizierung

Führen Sie diesen Smoke-Test nach der Migration in dieser Reihenfolge aus:

1. `dotnet build` ist sauber, einschließlich der Auflösung der `Microsoft.EntityFrameworkCore.Design`-Referenz (die EF-11-Tools ziehen sie nicht mehr transitiv mit).
2. `dotnet ef migrations has-pending-model-changes` meldet keine ausstehenden Änderungen.
3. Die App startet, und `Migrate()` (sofern Sie es aufrufen) wird sauber angewendet, ohne `PendingModelChangesWarning` oder `MigrationsNotFound`.
4. `dotnet test` ist grün. Achten Sie auf Tests, die generierte SQL-Strings prüfen; die Übersetzungen von `Contains` und parametrisierten Sammlungen haben sich geändert, daher müssen Snapshot-Assertions aktualisiert werden.
5. Führen Sie eine Abfrage aus, die über ein `Contains` über eine Liste filtert, und bestätigen Sie, dass sie ausgeführt wird, nicht nur kompiliert.
6. Prüfen Sie stichprobenartig eine JSON-gemappte Entität mit einem Enum und eine Entität mit String-Schlüssel, die in einer Beziehung verwendet wird, auf korrekte Werte.

## Rollback-Plan

Die Paket- und Codeänderungen sind reversibel: Setzen Sie den Branch zurück, stellen Sie die EF-Core-6.0-Pakete wieder her und stufen Sie das `dotnet-ef`-Tool herunter. Das Risiko ist die Schemamigration aus Schritt 8. Die Änderungen an der maximalen Diskriminatorlänge und am nativen `json` ändern die Datenbank, und EF Core 6.0 kennt eine von EF Core 11 gestempelte Migration nicht. Wenn Sie die Runtime nach dem Anwenden dieser Migration zurückrollen können müssen, generieren Sie zuerst ein Down-Skript (`dotnet ef migrations script UpgradeToEfCore11 PreviousMigration`) und bewahren Sie es beim Release auf. Ohne dieses Skript ist die Schemaänderung für ein EF-6-Binary faktisch eine Einbahnstraße.

## Stolpersteine, die wir hatten

**Das `Contains`-Timeout ist der hinterhältigste.** Die Abfrage kompiliert, liefert korrekte Ergebnisse und besteht bei einem kleinen Datensatz jeden Test. Dann trifft eine Produktionstabelle mit Millionen Zeilen auf den `OPENJSON`-Plan, und die Abfrage erreicht das Zeitlimit. Das EF-Team hat dies dreimal verfeinert: EF 8 führte `OPENJSON` ein, EF 9 fügte `TranslateParameterizedCollectionsToConstants` hinzu, und EF 10 änderte den Standard auf mehrere skalare Parameter. Wenn Sie einen Rückgang sehen, ist das Notventil pro Abfrage `EF.Constant(list).Contains(...)`, um die Werte für diese eine Abfrage einzubetten und den globalen Standard unangetastet zu lassen. Der [Leitfaden zur N+1-Erkennung](/de/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) und der [Leitfaden zur Abfrageaufteilung](/de/2026/06/how-to-use-query-splitting-to-avoid-a-cartesian-explosion-in-ef-core-11/) decken die benachbarten Fallen der Abfrageform ab, die im selben Durchgang einen Blick wert sind.

**String-Schlüssel ohne Beachtung der Groß-/Kleinschreibung ändern den Abgleich stillschweigend.** EF Core 8 ließ den SQL-Server-Provider String-Schlüsselwerte im Change-Tracker ohne Beachtung der Groß-/Kleinschreibung vergleichen, passend dazu, wie SQL Server Fremdschlüssel abgleicht. Wenn Ihr Code darauf angewiesen war, dass `"ABC"` und `"abc"` im Speicher unterschiedliche Schlüssel sind, behandelt der Change-Tracker sie jetzt als dieselbe Entität. Die Korrektur ist ein benutzerdefinierter, Groß-/Kleinschreibung beachtender `ValueComparer` für diese Schlüssel, aber bestätigen Sie zuerst, dass Sie tatsächlich darauf angewiesen sind; die meisten Apps wollen das neue Verhalten.

**Die Ausnahme bei ausstehenden Änderungen löst bei dynamischen Seed-Daten aus.** Ein Modell, das mit `HasData` unter Verwendung von `DateTime.UtcNow` oder `Guid.NewGuid()` seedet, erscheint EF bei jedem Build als "geändert", sodass EF 9 `PendingModelChangesWarning` wirft, obwohl Sie nichts geändert haben. Ersetzen Sie die dynamischen Werte durch statische Konstanten im Seed oder wechseln Sie zum Seeding-Muster von EF 9. Dieser lässt sich leicht als echter Migrationsfehler fehldeuten.

**Die Ausgabe des Database-First-Scaffolding ändert ihre Form.** Wenn Sie aus der Datenbank neu scaffolden, generiert EF 8 jetzt `DateOnly` und `TimeOnly` für `date`- und `time`-Spalten, entfernt die Nullable-Hülle bei Boolean-Spalten mit einem Standardwert und benennt Navigationen für zusammengesetzte Fremdschlüssel anders. Keine davon bricht eine laufende App, aber sie erzeugen einen großen, rauschenden Diff, der leicht mit einem Fehler verwechselt wird. Scaffolden Sie in einem eigenen Commit neu, damit der Diff überprüfbar ist.

Fünf Hauptversionen klingen schwerer, als es ist. Zwei Änderungen stoppen Ihre App beim ersten Start abrupt (der `Encrypt`-Standardwert und die Migrationsausnahme), und eine ist eine latente Leistungsfalle (die `Contains`-Übersetzung). Planen Sie für diese drei, generieren und lesen Sie die eine Schemamigration, und der Rest sind Paket-Bumps und ein grüner Testlauf. Für die breitere Runtime-Seite desselben Upgrades deckt die [Checkliste von .NET 8 auf .NET 11](/de/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) die Framework-, ASP.NET-Core- und C#-14-Änderungen ab, die zusammen mit dieser kommen.

## Quellen

- [Breaking changes in EF Core 7.0](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-7.0/breaking-changes)
- [Breaking changes in EF Core 8.0](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/breaking-changes)
- [Breaking changes in EF Core 9.0](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/breaking-changes)
- [Breaking changes in EF Core 10.0](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/breaking-changes)
- [Breaking changes in EF Core 11.0](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/breaking-changes)
- [Microsoft.Data.SqlClient 7.0 release notes](https://github.com/dotnet/SqlClient/blob/main/release-notes/7.0/7.0.0.md)
