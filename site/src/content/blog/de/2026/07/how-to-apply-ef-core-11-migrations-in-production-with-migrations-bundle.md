---
title: "EF Core 11 Migrationen in Produktion anwenden mit dotnet ef migrations bundle"
description: "Ein vollständiger Leitfaden zur Bereitstellung von EF Core 11 Schemaänderungen mit Migration Bundles: efbundle in der CI kompilieren, die appsettings.json-Falle bei benannten Verbindungszeichenfolgen, self-contained Bundles und der musl-RID von Alpine, Migration Locking seit EF Core 9, Rollback über eine Zielmigration und warum Transaktionen pro Migration Sie unter MySQL nicht retten."
pubDate: 2026-07-28
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "migrations"
  - "devops"
lang: "de"
translationOf: "2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle"
translatedBy: "claude"
translationDate: 2026-07-28
---

Um EF Core 11 Migrationen auf eine Produktionsdatenbank anzuwenden, kompilieren Sie in der CI ein Migration Bundle mit `dotnet ef migrations bundle --self-contained -r linux-x64 -o ./artifacts/efbundle`, veröffentlichen diese eine ausführbare Datei als Build-Artefakt und führen sie als eigenen Bereitstellungsschritt aus: `./efbundle --connection "$CONNECTION_STRING"`. Das Bundle trägt Ihre kompilierten Migrationen und die EF Core Laufzeit in einer einzigen Datei. Die ausführende Maschine braucht kein .NET SDK, kein `dotnet-ef` Werkzeug und keinen Zugriff auf Ihren Quellcode, und Ihre Anwendung braucht nie schemaändernde Rechte auf der Datenbank. Dieser Artikel zielt auf EF Core 11 und .NET 11 (Preview 6 zum Zeitpunkt des Schreibens, GA im November 2026) mit C# 14. Bundles gibt es seit EF Core 6, alles hier funktioniert also von EF Core 6 bis 11, und ich weise auf die Versionsuntergrenzen hin, an denen sich das Verhalten unterscheidet.

## Was an den anderen drei Strategien tatsächlich falsch ist

Jedes .NET Team entscheidet sich am Ende für einen von vier Wegen, Schemaänderungen in Produktion zu bringen, und drei davon haben einen Fehlermodus, der erst unter Last oder unter Druck auftritt.

**`Database.Migrate()` beim Start aufzurufen** schmerzt am häufigsten. Microsofts eigene Empfehlung nennt das für Produktion ungeeignet, und die Gründe summieren sich: Ihr Anwendungsprozess braucht dauerhaft `db_ddladmin` oder Äquivalent, nicht nur während der Bereitstellung; die Migration läuft, ohne dass ein Mensch das SQL sieht; und ein Rollback bedeutet, einen neuen Build auszuliefern. Seit EF Core 9 ist die Nebenläufigkeitsgefahr immerhin behandelt, denn `Migrate()` und `MigrateAsync()` nehmen vor jeder Anwendung eine datenbankweite Sperre, sodass zehn gleichzeitig ausgerollte Replikate sich serialisieren statt sich gegenseitig zu beschädigen. Das behob das schlimmste Symptom, aber keines der strukturellen Probleme.

**`dotnet ef database update` auf dem Bereitstellungsagenten auszuführen** bedeutet, das .NET SDK und das `dotnet-ef` Werkzeug auf diesem Agenten zu installieren, den Quellcode auszuchecken und das Projekt zu kompilieren, nur um ein `CREATE INDEX` anzuwenden. Wenn dieser Agent Ihre Produktionsmaschine ist, steht dort jetzt ein Compiler.

**Ein SQL-Skript zu generieren** mit `dotnet ef migrations script --idempotent` ist die Strategie, die Microsoft weiterhin zuerst empfiehlt, und sie hat einen echten Vorteil: eine DBA kann es vor der Ausführung lesen. Der Preis ist, dass Sie nun ein Werkzeug zur Ausführung brauchen, und wie das EF Team in der Dokumentation formuliert, sind Transaktionsbehandlung und Weiterlaufen-nach-Fehler dieser Werkzeuge inkonsistent und mitunter unerwartet. `sqlcmd` läuft munter weiter, nachdem Anweisung 40 von 120 fehlgeschlagen ist, und lässt Ihr Schema irgendwo zwischen zwei Migrationen zurück, ohne Aufzeichnung wo.

Bundles beseitigen diese Problemklasse: die ausführbare Datei wendet Migrationen über denselben EF Core Codepfad an wie `dotnet ef database update`, mit derselben Transaktionssemantik, und meldet entweder Erfolg oder einen Exit-Code ungleich null.

## Die vierstufige Pipeline

Das ist die gesamte Form der Bereitstellung, der Rest des Artikels ist Detail zu jedem Schritt.

1. **Prüfen Sie, dass Modell und Migrationen übereinstimmen.** Führen Sie `dotnet ef migrations has-pending-model-changes` in der CI aus. Der Befehl endet mit einem Code ungleich null, wenn jemand eine Entität geändert und `migrations add` vergessen hat.
2. **Kompilieren Sie das Bundle einmal**, in der CI, aus demselben Commit, der Ihre Anwendungsbinaries erzeugt hat: `dotnet ef migrations bundle --self-contained -r linux-x64 -o ./artifacts/efbundle --force`.
3. **Veröffentlichen Sie `efbundle` als Build-Artefakt**, zusammen mit jeder benötigten `appsettings.json`.
4. **Führen Sie es als eigenständigen Bereitstellungsschritt aus**, bevor die neue Anwendungsversion Anfragen bedient: `./efbundle --connection "$CONNECTION_STRING"`.

## Das Bundle kompilieren

Der Befehl läuft zur Entwurfszeit, er braucht also `Microsoft.EntityFrameworkCore.Design` als Referenz im Startprojekt und eine funktionierende `dotnet ef` Installation:

```bash
# EF Core 11, .NET 11
dotnet tool install --global dotnet-ef
dotnet ef migrations bundle
```

```output
Build started...
Build succeeded.
Building bundle...
Done. Migrations Bundle: /src/App.Api/efbundle
```

Standardmäßig landet die Ausgabe neben dem Startprojekt und heißt `efbundle` (`efbundle.exe` unter Windows), kompiliert für die RID der kompilierenden Maschine. Die Optionen sind kurz genug, um sie vollständig aufzulisten:

| Option | Kurz | Wirkung |
| --- | --- | --- |
| `--output <FILE>` | `-o` | Pfad der zu erzeugenden ausführbaren Datei. |
| `--force` | `-f` | Überschreibt ein vorhandenes Bundle. |
| `--self-contained` | | Bündelt auch die .NET Laufzeit, sodass die Zielmaschine keine installiert haben muss. |
| `--target-runtime <RID>` | `-r` | Der Runtime Identifier, für den kompiliert wird. |

Dazu die üblichen Entwurfszeit-Optionen: `--project`, `--startup-project`, `--context`, `--configuration`, `--framework`, `--no-build`.

In einer realen Solution liegt der Kontext in einer Bibliothek und der Host woanders, die CI führt also eher so etwas aus:

```bash
# EF Core 11, .NET 11 - context in a class library, host in the API project
dotnet ef migrations bundle \
  --project src/App.Infrastructure \
  --startup-project src/App.Api \
  --context AppDbContext \
  --configuration Release \
  --self-contained -r linux-x64 \
  -o ./artifacts/efbundle \
  --force
```

EF Core 11 erspart Ihnen die meiste dieser Wiederholung. Legen Sie eine Datei `.config/dotnet-ef.json` im Repository-Wurzelverzeichnis ab, und `dotnet ef` sucht vom Arbeitsverzeichnis aus den Verzeichnisbaum aufwärts danach:

```json
{
  "project": "src/App.Infrastructure",
  "startupProject": "src/App.Api",
  "context": "AppDbContext",
  "configuration": "Release"
}
```

Explizite Kommandozeilenoptionen gewinnen weiterhin gegen die Datei, eine Entwicklerin kann also lokal jede davon überschreiben. Das ist neu in EF Core 11 und der beste einzelne Grund, das Werkzeug auf Ihren Build-Agenten zu aktualisieren.

## Was das Bundle zur Laufzeit tut

Führen Sie die Datei aus, und sie wendet jede Migration der Assembly an, die noch nicht in `__EFMigrationsHistory` verzeichnet ist:

```bash
./efbundle --connection "Server=prod-sql.contoso.com;Database=Orders;Authentication=Active Directory Default;Encrypt=true"
```

```output
Applying migration '20260721104512_AddOrderIndexes'.
Applying migration '20260726091133_AddCustomerTier'.
Done.
```

Beim zweiten Lauf passiert nichts, genau das wollen Sie von einem Bereitstellungsschritt, der wiederholt werden könnte:

```output
No migrations were applied. The database is already up to date.
Done.
```

Die gesamte Oberfläche besteht aus einem Argument und vier Optionen. Das Argument ist die Zielmigration: Übergeben Sie einen Migrationsnamen oder eine ID, um bis zu diesem Punkt hoch oder **herunter** zu migrieren, und `0`, um alle Migrationen zurückzunehmen. Die Optionen sind `--connection`, `--verbose` (`-v`), `--no-color` und `--prefix-output`. Mehr nicht. Es gibt keine Option `--timeout`, weshalb ein langlaufender Indexaufbau auf einer großen Tabelle `Command Timeout=600` in der Verbindungszeichenfolge selbst braucht; diesen Fehlermodus habe ich im Detail behandelt, als ich über [das Timeout schrieb, das EF Core Migrationen mitten in der Bereitstellung abbricht](/de/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/).

`--prefix-output` lohnt sich in der CI: die Option versieht jede Zeile mit ihrer Schwere, womit Ihre Log-Aggregation etwas zum Filtern hat.

## Die appsettings.json-Falle

Das ist der Fehler, der Teams einen Nachmittag kostet, und er ist aus der Dokumentation nicht offensichtlich.

Wenn Ihr `DbContext` mit einer **benannten** Verbindungszeichenfolge konfiguriert ist, etwa `optionsBuilder.UseSqlServer("name=ConnectionStrings:DefaultConnection")`, braucht das Bundle trotzdem eine `appsettings.json` im Arbeitsverzeichnis, die diesen Schlüssel enthält. Auch dann, wenn Sie `--connection` auf der Kommandozeile übergeben. Ohne sie erhalten Sie:

```output
A named connection string was used, but the name 'ConnectionStrings:DefaultConnection'
was not found in the application's configuration. Note that named connection strings
are only supported when using 'IConfiguration' and a service provider, such as in a
typical ASP.NET Core application.
```

Der Wert in dieser Datei ist irrelevant, denn `--connection` überschreibt ihn; der *Schlüssel* muss lediglich existieren, damit die Konfigurationsbindung gelingt. Gemeldet wurde das als [dotnet/efcore#32009](https://github.com/dotnet/efcore/issues/32009) und als nicht geplant geschlossen, planen Sie also darum herum, statt auf eine Korrektur zu warten. Zwei Auswege:

- Liefern Sie eine Platzhalter-`appsettings.json` neben dem Bundle in Ihrem Artefakt aus, mit einem beliebigen Wert unter dem erwarteten Schlüssel.
- Oder verwenden Sie im Entwurfszeitpfad keine benannte Verbindungszeichenfolge mehr, dann hat das Bundle nichts aufzulösen.

Die EF Core Dokumentation ist auch zum allgemeinen Fall deutlich: Vergessen Sie nicht, `appsettings.json` neben Ihr Bundle zu kopieren, denn das Bundle setzt ihre Anwesenheit im Ausführungsverzeichnis voraus. Ist Ihre Konfiguration nach Umgebung getrennt, setzen Sie `ASPNETCORE_ENVIRONMENT` (oder `DOTNET_ENVIRONMENT` für einen Nicht-Web-Host), bevor Sie das Bundle starten, und kopieren Sie auch die passende `appsettings.Production.json`. Das Bundle hat keine eigene Option `--environment`.

Ich umgehe die Konfiguration lieber ganz: Übergeben Sie die vollständige Verbindungszeichenfolge mit `--connection`, zur Bereitstellungszeit aus Ihrem Secret Store bezogen, und behalten Sie eine Platzhalter-`appsettings.json` nur, um den Binder zufriedenzustellen. So wird das Bundle zu einer reinen Funktion seiner Argumente, und genau das wollen Sie, wenn dasselbe Artefakt von Staging nach Produktion durchgereicht wird.

## Self-contained Bundles und die Alpine-Falle

`--self-contained -r linux-x64` erzeugt eine ausführbare Datei, die die .NET Laufzeit mitbringt. Das ist der richtige Standard für Bereitstellungen in Containern, denn Ihr Migrationsschritt kann damit in einem minimalen Image laufen, auf dem gar kein .NET installiert ist.

Die RID muss zur libc des Ziels passen, nicht nur zur Architektur. Ein self-contained Bundle für `linux-x64` zielt auf glibc und läuft nicht auf Alpine oder einem anderen musl-basierten Image; dort brauchen Sie `linux-musl-x64`. Der Fehler ist ein verwirrendes "not found" oder ein Loader-Fehler statt einer klaren Meldung, legen Sie die RID also bewusst fest:

```bash
# EF Core 11, .NET 11 - for an Alpine-based runner
dotnet ef migrations bundle --self-contained -r linux-musl-x64 -o ./artifacts/efbundle --force
```

Globalisierung ist die zweite Alpine-Stolperstelle. Ein self-contained Bundle erwartet ICU, und Alpine-Images brauchen ein installiertes `icu-libs`. `apk add --no-cache icu-libs` in das Migrations-Image aufzunehmen, ist billiger, als `Couldn't find a valid ICU package installed on the system` innerhalb eines Bereitstellungsfensters zu debuggen.

Hat Ihre Produktionsmaschine bereits die passende .NET Laufzeit, lassen Sie `--self-contained` weg und erhalten ein deutlich kleineres Artefakt. In einem Kubernetes Init Container oder einem Job vor dem Rollout gewinnt die self-contained Variante meist trotzdem, weil sie den Migrationsschritt von der Laufzeitversion Ihres Anwendungs-Images entkoppelt. Dieselbe Überlegung gilt, wenn Sie [das Anwendungs-Image selbst mit `dotnet publish /t:PublishContainer` bauen](/de/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/): halten Sie Schemaschritt und Anwendungsschritt als getrennte Artefakte.

## Migration Locking und was es nicht abdeckt

Seit EF Core 9 nimmt das Anwenden von Migrationen zuerst eine datenbankweite Sperre. Das gilt für `dotnet ef database update`, für `Update-Database`, für `Migrate()` und `MigrateAsync()` sowie für Migration Bundles. Die Sperre wird über die gesamte Operation gehalten, einschließlich Seeding-Code, der als Teil davon läuft; wenn Sie also mit [`UseSeeding` und `UseAsyncSeeding`](/de/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/) befüllen, ist auch diese Arbeit abgedeckt.

Was die Sperre **nicht** abdeckt, sind SQL-Skripte, denn die laufen vollständig außerhalb von EF Core. Wenn die eine Hälfte Ihrer Pipeline ein Bundle und die andere ein generiertes Skript ausführt, haben Sie zwischen beiden keinen gegenseitigen Ausschluss. Entscheiden Sie sich für eines.

Der Sperrmechanismus ist providerspezifisch und hat scharfe Kanten. Unter SQLite ist er über eine Sperrtabelle umgesetzt, die zurückbleiben kann, wenn der Prozess mitten in der Migration stirbt, und die anschließend jede weitere Migration blockiert, bis Sie sie von Hand entfernen. Das ist relevant, wenn Sie Integrationstests gegen SQLite laufen lassen und den Testhost abschießen.

Eine weitere Einschränkung sollten Sie kennen, bevor Sie darum herum entwerfen: Sie können `MigrateAsync` nicht in eine explizite Transaktion einbetten. Seit EF Core 9 wirft das eine Ausnahme.

## Transaktionen gelten pro Migration, nicht pro Bundle

Ein häufiges Missverständnis ist, ein Bundle wende alle ausstehenden Migrationen atomar an. Tut es nicht. EF Core kapselt **jede Migration** in eine eigene Transaktion. Drei ausstehende Migrationen bedeuten drei Transaktionen. Scheitert die zweite, bleibt die erste angewendet und in `__EFMigrationsHistory` verzeichnet, und die dritte läuft nie.

Meist ist das genau das gewünschte Verhalten, denn ein erneuter Lauf des Bundles setzt exakt dort an, wo es stehenblieb. Es bedeutet aber, dass "die Bereitstellung ist gescheitert, setze die Datenbank zurück" keine einzelne Operation ist, und Sie sollten über die Zwischenzustände nachdenken, die Ihr Schema einnehmen kann.

Zwei providerspezifische Einschränkungen schärfen das:

- Auf Datenbanken ohne transaktionales DDL, allen voran MySQL, kann eine gescheiterte Migration teilweise Schemaänderungen hinterlassen, ganz ohne Rollback. Jede DDL-Anweisung committet implizit. Behandeln Sie unter MySQL jede Migration, als wäre sie nicht transaktional, und halten Sie Migrationen klein genug, um sie von Hand nachzuvollziehen.
- Manche Operationen laufen selbst unter SQL Server oder PostgreSQL nicht innerhalb einer Transaktion, etwa das nebenläufige Anlegen eines Index. Übergeben Sie dafür `suppressTransaction: true` an `migrationBuilder.Sql(...)` und akzeptieren Sie, dass die Anweisung nicht abgedeckt ist.

```csharp
// EF Core 11, C# 14 - a statement that must not run inside the migration transaction
protected override void Up(MigrationBuilder migrationBuilder)
{
    migrationBuilder.Sql(
        "CREATE INDEX CONCURRENTLY IX_Orders_CustomerId ON \"Orders\" (\"CustomerId\");",
        suppressTransaction: true);
}
```

## Rollback

Das Bundle nimmt eine Zielmigration als positionelles Argument, und "abwärts" zu migrieren ist derselbe Befehl mit einem früheren Ziel:

```bash
# EF Core 11 - revert to the state right after AddOrderIndexes
./efbundle 20260721104512_AddOrderIndexes

# EF Core 11 - revert everything. Read that twice before running it.
./efbundle 0
```

Damit das funktioniert, muss das ausgeführte Bundle die Migrationen, auf die Sie zurückgehen, tatsächlich *enthalten*, was dafür spricht, jedes je bereitgestellte Bundle-Artefakt aufzubewahren und nicht nur das letzte. Auch die `Down` Methoden müssen korrekt sein, und sie sind in den meisten Repositories der am wenigsten getestete Code. Ein `Down`, das eine Spalte löscht, ist kein Rollback; es ist Datenverlust mit Zusatzschritten. Genau diese Prüfung kauft Ihnen ein generiertes Skript, und nichts hindert Sie daran, in der CI beide Artefakte zu erzeugen: das Bundle in der Pipeline ausführen und `dotnet ef migrations script --idempotent -o schema.sql` an denselben Build anhängen, damit die DBA es lesen kann.

## Die Abweichung vor der Bereitstellung erkennen

Seit EF Core 9 wirft `Migrate()` eine Ausnahme, wenn das Modell gegenüber der letzten Migration ausstehende Änderungen hat (`RelationalEventId.PendingModelChangesWarning`). Das wollen Sie nicht während einer Bereitstellung entdecken. Setzen Sie die Prüfung stattdessen in die CI:

```bash
# EF Core 11 - fails the build if an entity changed without a migration
dotnet ef migrations has-pending-model-changes \
  --project src/App.Infrastructure \
  --startup-project src/App.Api
```

Der Befehl kam in EF Core 8 dazu und endet mit einem Code ungleich null, wenn Modell und Migrationen auseinandergelaufen sind. Kombinieren Sie ihn im selben Job mit dem Bau des Bundles, damit Artefakt und Prüfung aus einem Commit stammen.

Während Sie die Pipeline härten, lohnt es sich, zwei verwandten Fehlermodi vorzubeugen: `dotnet ef` braucht eine Entwurfszeit-Factory, wenn [es Ihren DbContext nicht erzeugen kann](/de/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/), und die Verhaltensänderungen, die beim [Aktualisieren von EF Core 6 auf EF Core 11](/de/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) zubeißen.

## Wo `database update --add` passt und wo nicht

EF Core 11 brachte `dotnet ef database update <NAME> --add`, das eine Migration erzeugt und in einem Befehl anwendet, wobei Roslyn die Migration zur Laufzeit kompiliert. Für die innere Entwicklungsschleife ist das wirklich angenehm, und ich habe über [den einstufigen Migrationsablauf](/de/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/) geschrieben, als er erschien. Es ist zugleich das genaue Gegenteil dessen, was Sie in Produktion wollen: es erzeugt und wendet Schemaänderungen ohne Artefakt und ohne dazwischenliegenden Prüfschritt an. Nutzen Sie es beim Prototyping und behalten Sie das Bundle für alles mit echten Daten dahinter. Dasselbe gilt für die übrigen Werkzeugergänzungen in EF Core 11, `--connection` bei `database drop` und `migrations remove` sowie `--offline` bei `migrations remove`: Bequemlichkeiten der Entwicklungsschleife, keine Bereitstellungswerkzeuge.

Wenn ein Bundle Migrationen anwendet und danach etwas seltsam aussieht, reproduzieren Sie es lokal mit erhöhter Protokollierung, was eine Frage davon ist, [EF Core 11 das generierte SQL protokollieren zu lassen](/de/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) gegen eine Wegwerfkopie des Schemas.

## Verwandte Artikel

- [Fix: SqlException Timeout expired während EF Core Migrationen](/de/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/)
- [Fix: dotnet ef migrations add scheitert mit "Unable to create an object of type DbContext"](/de/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/)
- [Von EF Core 6 auf EF Core 11 migrieren: die Breaking Changes, die wirklich wehtun](/de/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)
- [EF Core 11 erlaubt das Erstellen und Anwenden einer Migration in einem Befehl](/de/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/)
- [Eine .NET 11 Anwendung als Container-Image veröffentlichen mit dotnet publish /t:PublishContainer](/de/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/)

## Quellen

- [Applying Migrations](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/applying) behandelt alle vier Bereitstellungsstrategien, die Argument- und Optionstabellen von `efbundle` und das Migration Locking.
- [EF Core tools reference (.NET CLI)](https://learn.microsoft.com/en-us/ef/core/cli/dotnet) ist die maßgebliche Quelle zu den Optionen von `dotnet ef migrations bundle` und zur neuen Konfigurationsdatei `.config/dotnet-ef.json` in EF Core 11.
- [Introducing DevOps-friendly EF Core Migration Bundles](https://devblogs.microsoft.com/dotnet/introducing-devops-friendly-ef-core-migration-bundles/) ist die ursprüngliche Ankündigung und erläutert die Entwurfsabsicht.
- [dotnet/efcore#32009](https://github.com/dotnet/efcore/issues/32009) dokumentiert die `appsettings.json`-Anforderung bei benannten Verbindungszeichenfolgen, geschlossen als nicht geplant.
- [Managing Migrations](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/managing) beschreibt Transaktionen pro Migration und `suppressTransaction`.
- [SQLite provider limitations](https://learn.microsoft.com/en-us/ef/core/providers/sqlite/limitations) behandelt verwaiste Migrationssperren.
