---
title: "Vom HasData-Seeding zu UseAsyncSeeding in EF Core 11 migrieren"
description: "Eine Schritt-fuer-Schritt-Anleitung, um Seed-Daten von HasData auf UseSeeding und UseAsyncSeeding in EF Core 11 umzustellen, inklusive der DeleteData-Migrationsfalle, die Ihre vorhandenen Zeilen loescht, wenn Sie sie uebersehen."
pubDate: 2026-07-08
updatedDate: 2026-07-08
template: migration
tags:
  - "migration"
  - "efcore"
  - "dotnet"
lang: "de"
translationOf: "2026/07/migrate-from-hasdata-seeding-to-useasyncseeding-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-08
---

Seed-Daten von `HasData` auf `UseSeeding`/`UseAsyncSeeding` in EF Core 11 zu verschieben, ist fuer eine typische Anwendung eine halbtaegige Aufgabe, und die eine Sache, die Sie beisst, ist nicht die neue API: Es ist, dass das Loeschen eines `HasData`-Aufrufs den naechsten `dotnet ef migrations add` dazu bringt, eine `DeleteData`-Anweisung auszugeben, die genau diese Zeilen aus jeder Datenbank entfernt, gegen die die Migration laeuft. Wenn Sie das `HasData` loeschen und das `UseSeeding` in derselben Bereitstellung hinzufuegen, ohne an die Reihenfolge zu denken, koennen Sie Referenzdaten in der Produktion loeschen. Diese Anleitung durchlaeuft die Migration in der Reihenfolge, die das vermeidet, unter Verwendung von .NET 11, EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0) und C# 14. Planen Sie einen Nachmittag fuer eine mittelgrosse Anwendung ein, der grosste Teil davon fuer das Pruefen, welche Seeds schon vor Jahren haetten verschoben werden sollen.

Lohnt es sich? Fuer alles Dynamische, mit generiertem Schluessel, Berechnetes oder Bedingtes: ja, und es war ueberfaellig. Fuer eine wirklich statische Referenztabelle mit drei Zeilen lassen Sie sie auf `HasData`. Das Ziel hier ist nicht "jedes `HasData` loeschen", sondern "die Seeds verschieben, die nie ins Modell gehoerten".

## Warum HasData ueberhaupt verlassen

`HasData` baut Ihre Seed-Daten in den Modell-Snapshot ein. Diese eine Design-Tatsache ist die Wurzel jedes Grundes, es zu verlassen:

- **Nicht-deterministische Werte erzeugen Phantom-Migrationen.** Ein `DateTime.UtcNow`, ein `Guid.NewGuid()` oder ein gehashtes Passwort innerhalb einer `HasData`-Zeile fuehrt dazu, dass der Modell-Diff nie uebereinstimmt, sodass EF glaubt, das Modell habe sich bei jedem Build geaendert, und entweder mit `PendingModelChangesWarning` warnt oder ein endloses Rinnsal wirkungsloser Migrationen ausspuckt. Das ist die Wand, gegen die die meisten Teams laufen, oft mitten in einer [Migration von EF Core 6 zu EF Core 11](/de/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).
- **Von der Datenbank generierte Schluessel sind unmoeglich.** `HasData` verlangt jeden Primaerschluessel von Hand ausgeschrieben. Identity-Spalten und Sequenzen fallen weg, sodass Sie am Ende Schluessel erfinden und beten, dass sie nie mit echten Inserts kollidieren.
- **Keine bedingte Logik, keine Navigationsgraphen, keine Transformationen.** "Einen Demo-Tenant nur in Development seeden" oder "diesen Objektgraphen ueber seine Navigationseigenschaften einfuegen" laesst sich in `HasData` ueberhaupt nicht ausdruecken.
- **Der Seed ist Teil Ihres Schema-Diffs, ob Sie wollen oder nicht.** Jede Wertaenderung wird zu einem `UpdateData` in einer Migration, was fuer Laendercodes eine Funktion und fuer alles andere, das Sie lieber als Code verwalten wuerden, ein Aergernis ist.

Das EF-Team hat `HasData` in "model-managed data" umbenannt, gerade um von seiner Verwendung als allgemeines Seeding-Werkzeug abzuraten. `UseSeeding` und `UseAsyncSeeding`, in EF Core 9 eingefuehrt und in EF Core 11 aktuell, sind gewoehnlicher Anwendungscode, der gegen einen lebendigen `DbContext` laeuft, ohne einen dieser Grenzen. Wenn Sie noch entscheiden, welche Seeds Sie verschieben, zieht die [HasData-vs-UseSeeding-Entscheidungsmatrix](/de/2026/06/hasdata-vs-useseeding-for-seeding-data-in-ef-core-11/) die Linie Zeile fuer Zeile.

## Was bricht

| Bereich | Aenderung | Schweregrad |
| ------- | --------- | ----------- |
| Bestehende Datenbanken | Das Entfernen eines `HasData`-Aufrufs erzeugt `DeleteData`, das die Seed-Zeilen bei der Migration loescht | hoch |
| Idempotenz | `HasData` wurde automatisch differenziert; `UseSeeding` laeuft jedes Mal und braucht eine von Hand geschriebene Existenzpruefung | hoch |
| Zwei Codepfade | Das Tooling ruft das synchrone `UseSeeding`, der async-Start ruft `UseAsyncSeeding`; implementieren Sie nur eines, und das andere macht still nichts | hoch |
| Versionskontrolle | Die Seed-Werte verlassen den Migrations-Snapshot und leben im Startcode; sie werden nicht mehr in der Migrationshistorie erfasst | mittel |
| Referenzielle Integritaet | Daten, von denen Fremdschluessel anderer Tabellen abhaengen, landen jetzt in einem Start-Callback, nicht innerhalb der Migrationstransaktion | mittel |
| Test-Setup | Tests, die darauf angewiesen waren, dass `HasData` ueber `EnsureCreated` laeuft, funktionieren weiterhin, aber nur, wenn beide Overloads implementiert sind | niedrig |

Die oberste Zeile ist die, die in einem Vorfallsbericht endet. Alles andere ist mechanisch.

## Pre-Flight-Checkliste

Bevor Sie eine Zeile Seeding-Code anfassen:

- **Bestaetigen Sie, dass Ihre EF-Core-Version 9.0 oder neuer ist.** `UseSeeding`/`UseAsyncSeeding` existieren vor EF Core 9 nicht. Fuehren Sie `dotnet list package | findstr EntityFrameworkCore` aus und bestaetigen Sie 11.0 (oder mindestens 9.0).
- **Inventarisieren Sie jeden `HasData`-Aufruf.** Grep den Code: `grep -rn "HasData" .` (oder `findstr /s HasData *.cs` unter Windows). Entscheiden Sie fuer jeden mit der Regel unten, ob behalten oder verschieben.
- **Klassifizieren Sie jeden Seed.** Behalten Sie ihn auf `HasData`, wenn die Daten klein, fest, deterministisch, von Hand verschluesselt und etwas sind, ohne das das Schema bedeutungslos ist (Bestellstatus-Enums, ISO-Laendercodes). Verschieben Sie ihn auf `UseSeeding`, wenn er von der Datenbank generierte Schluessel, berechnete oder nicht-deterministische Werte, bedingte Logik, Navigationseigenschaften oder externe Transformationen hat.
- **Sichern Sie die Produktion oder proben Sie an einer wiederhergestellten Kopie.** Sie sind dabei, eine Migration zu erzeugen, die `DELETE`-Anweisungen ausgibt. Entdecken Sie ihr Verhalten nicht in der Produktion.
- **Halten Sie eine Staging-Datenbank bereit, auf der die `HasData`-Zeilen bereits angewendet sind.** Sie muessen sehen, was die Entfernungs-Migration mit einer Datenbank macht, die auf die alte Weise geseedet wurde, nicht nur mit einer leeren.

## Migrationsschritte

Die Reihenfolge zaehlt. Dies in der falschen Sequenz zu tun, ist genau, wie Sie Referenzdaten aus der Produktion loeschen.

### 1. Schreiben Sie zuerst die UseSeeding- und UseAsyncSeeding-Callbacks

Fuegen Sie den neuen Seeding-Pfad hinzu, bevor Sie etwas entfernen. Beide Overloads, identische Logik, Existenzpruefung oben in jedem. Faktorisieren Sie den Rumpf in gemeinsame Methoden, damit die synchrone und die async-Version nicht auseinanderdriften:

```csharp
// Program.cs -- .NET 11, ASP.NET Core 11, EF Core 11 (Microsoft.EntityFrameworkCore 11.0), C# 14
builder.Services.AddDbContext<AppDbContext>(options =>
    options
        .UseSqlServer(builder.Configuration.GetConnectionString("Default"))
        .UseSeeding((context, _) => SeedStatuses(context))
        .UseAsyncSeeding((context, _, ct) => SeedStatusesAsync(context, ct)));

static void SeedStatuses(DbContext context)
{
    string[] required = ["Pending", "Shipped", "Delivered"];
    var existing = context.Set<OrderStatus>()
        .Where(s => required.Contains(s.Name))
        .Select(s => s.Name)
        .ToHashSet();

    var missing = required
        .Where(name => !existing.Contains(name))
        .Select(name => new OrderStatus { Name = name })
        .ToList();

    if (missing.Count > 0)
    {
        context.Set<OrderStatus>().AddRange(missing);
        context.SaveChanges();
    }
}

static async Task SeedStatusesAsync(DbContext context, CancellationToken ct)
{
    string[] required = ["Pending", "Shipped", "Delivered"];
    var existing = await context.Set<OrderStatus>()
        .Where(s => required.Contains(s.Name))
        .Select(s => s.Name)
        .ToListAsync(ct);

    var missing = required
        .Where(name => !existing.Contains(name))
        .Select(name => new OrderStatus { Name = name })
        .ToList();

    if (missing.Count > 0)
    {
        context.Set<OrderStatus>().AddRange(missing);
        await context.SaveChangesAsync(ct);
    }
}
```

Beachten Sie, dass diese Version `Id` nicht mehr von Hand fest vergibt. Die Datenbank weist ihn zu. Das ist der ganze Punkt: Wenn Sie zuvor Schluessel von Hand in `HasData` zugewiesen haben, koennen bestehende Fremdschluessel-Referenzen auf genau diese Werte zeigen, was Schritt 2 heikel macht.

**Pruefen:** Fuehren Sie die Anwendung gegen eine leere lokale Datenbank aus, wobei die `HasData`-Aufrufe noch vorhanden sind. Sie sollte sauber starten, ohne doppelte Zeilen. Die Existenzpruefung sollte einen zweiten Start zu einem No-op machen (eine Lese-Abfrage, null Schreibvorgaenge).

### 2. Entscheiden Sie, wie bestehende Zeilen erhalten bleiben, bevor Sie HasData entfernen

Dies ist der Schritt, den alle ueberspringen und bereuen. Wenn Sie einen `HasData`-Aufruf loeschen und `dotnet ef migrations add` ausfuehren, erzeugt EF ein `DeleteData` in der `Up`-Methode fuer jede zuvor geseedete Zeile:

```csharp
// .NET 11, EF Core 11 -- what removing HasData generates
migrationBuilder.DeleteData(
    table: "OrderStatuses",
    keyColumn: "Id",
    keyValues: new object[] { 1, 2, 3 });
```

Auf einer bestehenden Datenbank laeuft dieses `DELETE`. Wenn andere Tabellen Fremdschluessel haben, die auf diese Zeilen zeigen, schlaegt das Delete entweder mit einem Fehler `FOREIGN KEY constraint failed` fehl oder, schlimmer, kaskadiert. Sie haben drei sichere Optionen:

- **A. Halten Sie die Schluessel stabil und lassen Sie den Seed neu einfuegen.** Wenn die Zeilen reine Referenzdaten ohne eingehende Fremdschluessel sind, ist es in Ordnung, die Migration sie loeschen und `UseSeeding` sie beim naechsten Start neu einfuegen zu lassen, aber die neuen Schluessel werden abweichen (von der Datenbank generiert), sodass dies nur sicher ist, wenn nichts die alten Schluessel referenziert.
- **B. Bearbeiten Sie die generierte Migration von Hand, um das `DeleteData` zu entfernen.** Oeffnen Sie nach `dotnet ef migrations add RemoveStatusSeed` die generierte Datei und loeschen Sie den `DeleteData`-Aufruf (und das passende `InsertData` in `Down`). Die Zeilen bleiben; nur der Modell-Snapshot hoert auf, sie zu verfolgen. Dies ist die sicherste Option, wenn Fremdschluessel die geseedeten Zeilen referenzieren und Sie sie unberuehrt lassen wollen.
- **C. Bewahren Sie die Schluessel im neuen Seeder.** Wenn Sie die genauen Schluesselwerte behalten muessen (weil Fremdschluessel von ihnen abhaengen), weisen Sie sie in `UseSeeding` weiterhin explizit zu und bearbeiten Sie trotzdem das `DeleteData` von Hand heraus. Sie verlieren den Vorteil des von der Datenbank generierten Schluessels fuer diese Tabelle, aber Sie behalten die referenzielle Integritaet.

Fuer alles mit eingehenden Fremdschluesseln ist Option B fast immer, was Sie wollen. Die Zeilen muessen sich nicht bewegen; nur die Eigentuemerschaft an ihnen.

**Pruefen:** Lesen Sie nach dem Erzeugen der Entfernungs-Migration die generierte Datei, bevor Sie sie anwenden. Bestaetigen Sie, dass die `DeleteData`-Aufrufe genau die Zeilen anvisieren, die Sie erwarten, und dass Sie fuer jede Tabelle A, B oder C gewaehlt und angewendet haben.

### 3. Entfernen Sie die HasData-Aufrufe aus OnModelCreating

Loeschen Sie jetzt den `HasData`-Block fuer die Seeds, die Sie verschieben:

```csharp
// Before -- .NET 11, EF Core 11
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<OrderStatus>().HasData(
        new OrderStatus { Id = 1, Name = "Pending" },
        new OrderStatus { Id = 2, Name = "Shipped" },
        new OrderStatus { Id = 3, Name = "Delivered" });
}

// After -- the HasData block is gone; seeding lives in UseSeeding now
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    // OrderStatus seeding moved to UseSeeding in Program.cs
}
```

**Pruefen:** Das Projekt kompiliert weiterhin, und `dotnet ef migrations has-pending-model-changes` meldet eine ausstehende Aenderung (der entfernte Seed), die Sie gleich erfassen.

### 4. Erzeugen und pruefen Sie die Entfernungs-Migration

```bash
# .NET 11, EF Core 11
dotnet ef migrations add RemoveOrderStatusSeed
```

Oeffnen Sie die generierte Migration und wenden Sie Ihre Entscheidung aus Schritt 2 an. Wenn Sie Option B gewaehlt haben, loeschen Sie das `DeleteData` aus `Up` und das entsprechende `InsertData` aus `Down`. Lassen Sie die Modell-Snapshot-Aenderungen unberuehrt; diese sind korrekt und notwendig.

**Pruefen:** Fuehren Sie `dotnet ef migrations script` gegen Ihre Staging-Datenbank aus und lesen Sie das SQL. Bestaetigen Sie, dass kein unerwartetes `DELETE FROM OrderStatuses` ueberlebt, wenn Sie die Zeilen erhalten wollten.

### 5. Wenden Sie gegen Staging an und bestaetigen Sie, dass die Daten ueberleben

```bash
# .NET 11, EF Core 11
dotnet ef database update
```

Starten Sie dann die Anwendung, damit `UseAsyncSeeding` laeuft.

**Pruefen:** Fragen Sie die Tabelle ab. Die Referenzzeilen sind genau einmal vorhanden. Starten Sie die Anwendung ein zweites Mal und bestaetigen Sie, dass keine Duplikate aufgetaucht sind, was beweist, dass die Existenzpruefung funktioniert. Wenn Fremdschluessel die Zeilen referenzieren, bestaetigen Sie, dass diese Beziehungen intakt sind.

## Rauchtest nach der Migration

Fuehren Sie diese Checkliste gegen Staging aus, bevor Sie ausliefern:

- `dotnet build` ist erfolgreich ohne `PendingModelChangesWarning`.
- `dotnet ef migrations has-pending-model-changes` meldet nichts Ausstehendes.
- Die Anwendung startet ueber ihren async-Pfad (`await context.Database.MigrateAsync()`) und die geseedeten Zeilen existieren einmal.
- `dotnet ef database update` auf einer frischen Datenbank seedet ebenfalls korrekt (dies uebt das synchrone `UseSeeding`, das das Tooling aufruft).
- Ein Neustart der Anwendung fuegt nichts Neues ein (die Idempotenz haelt).
- Fremdschluessel-Beziehungen, die auf die alten Seed-Schluessel zeigten, loesen sich weiterhin auf.
- Keine Tabelle zeigt das Phantom-Migrations-Symptom: Das Hinzufuegen einer frischen Migration erzeugt kein seed-bezogenes `InsertData`/`DeleteData`.

## Rollback-Plan

Diese Migration ist umkehrbar, aber lesen Sie das Kleingedruckte. Wenn Sie Option B gewaehlt haben (das `DeleteData` von Hand herausbearbeitet), ist das schema-seitige `Down` fuer die Daten ein No-op, sodass das Zurueckrollen der Migration die Zeilen an Ort und Stelle laesst und einfach den Modell-Snapshot wiederherstellt. Das erneute Hinzufuegen des `HasData`-Blocks und das Erzeugen einer neuen Migration bringt Sie in die alte Welt zurueck, obwohl EF jede fehlende Zeile per `InsertData` einfuegen will.

Wenn Sie Option A gewaehlt haben (das Loeschen-und-neu-Seeden zugelassen), ist der Rollback riskanter: Die Zeilen haben jetzt von der Datenbank generierte Schluessel, sodass das Zuruecksetzen auf ein `HasData`-Modell, das feste Schluessel erwartet, nicht uebereinstimmt. Versuchen Sie in diesem Fall keinen In-Place-Rollback von Live-Daten. Stellen Sie aus dem Backup wieder her, das Sie im Pre-Flight-Schritt gemacht haben. Deshalb ist das Pre-Flight-Backup nicht optional.

## Fallen, in die wir getappt sind

- **Das Delete kaskadierte durch einen Fremdschluessel.** Eine `Order`-Tabelle referenzierte `OrderStatus.Id`. Das `DeleteData` der Entfernungs-Migration loeste ein `FOREIGN KEY constraint failed` aus, was zumindest lautstark fehlschlaegt. Waere die Beziehung mit Cascade-Delete konfiguriert gewesen, haette es die Bestellungen stillschweigend mitgenommen. Option B (das `DeleteData` herausbearbeiten) ist die Loesung. Siehe die [Loesung fuer FOREIGN KEY constraint failed](/de/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/) fuer die Mechanik, warum sich das Delete fortpflanzt.
- **Nur der async-Overload wurde implementiert, sodass `dotnet ef database update` nichts geseedet hat.** Das Tooling ruft das synchrone `UseSeeding`. Die Anwendung funktionierte in der Produktion (async-Startpfad), aber das `database update` der CI erzeugte eine leere Lookup-Tabelle und die Integrationstests schlugen fehl. Implementieren Sie immer beide.
- **Die Existenzpruefung fragte ein `DateTime` ab, keinen Schluessel.** Jemand schrieb den Guard als `if (!context.Set<User>().Any(u => u.CreatedAt == seedTime))`. Da `CreatedAt` ein `DateTime.UtcNow` war, stimmte die Pruefung nie ueberein und der Seeder fuegte bei jedem Start einen neuen Admin ein. Machen Sie den Guard ueber einen stabilen natuerlichen Schluessel (die E-Mail, den Statusnamen), nie ueber eine nicht-deterministische Spalte. Das vollstaendige Muster ist in [wie man Daten mit UseSeeding und UseAsyncSeeding seedet](/de/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/).
- **Das Seeden beim Start jeder Instanz erforderte ueberall Schreibrechte.** `UseSeeding` laeuft bei `Migrate` in jeder Replik. Wenn Ihre Produktions-App-Pods mit weitgehend lesenden Datenbankrechten laufen, wirft der Seed-Callback. Bevorzugen Sie fuer die Produktion einen einmaligen Initialisierungsschritt zur Bereitstellungszeit gegenueber dem Seeden bei jedem Start; `UseSeeding` glaenzt fuer lokale Entwicklung und Tests.
- **Ein teilweiser Umzug hinterliess eine `HasData`-Zeile, von der andere Seeds abhingen.** Die Haelfte der Seeds zu migrieren bedeutete, dass ein Insert eines Start-Callbacks eine Lookup-Zeile referenzierte, die die Entfernungs-Migration gerade geloescht hatte. Verschieben Sie abhaengige Seeds zusammen, oder halten Sie den Lookup auf `HasData` und verschieben Sie nur die abhaengigen Daten.

Wenn Ihre Entitaeten Records sind, aendert sich daran nichts: [Records funktionieren mit EF Core 11 korrekt](/de/2026/04/how-to-use-records-with-ef-core-11-correctly/) sowohl unter `HasData` als auch `UseSeeding`. Und wenn Sie die Datenschicht ohnehin gerade straffen, taucht dieselbe "was laeuft und wann"-Disziplin bei [den EF-Core-11-Interceptoren fuer Auditing](/de/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/) auf.

## Verwandt

- [HasData vs UseSeeding fuer das Seeden von Daten in EF Core 11](/de/2026/06/hasdata-vs-useseeding-for-seeding-data-in-ef-core-11/)
- [Wie man Daten mit UseSeeding und UseAsyncSeeding in EF Core 11 seedet](/de/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/)
- [Von EF Core 6 zu EF Core 11 migrieren: Breaking Changes, die wirklich beissen](/de/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)
- [Fix: FOREIGN KEY constraint failed beim Loeschen einer Entitaet in EF Core 11](/de/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/)
- [Wie man Records mit EF Core 11 korrekt verwendet](/de/2026/04/how-to-use-records-with-ef-core-11-correctly/)

## Quellen

- [Data Seeding - EF Core, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/modeling/data-seeding)
- [What's New in EF Core 9: UseSeeding and UseAsyncSeeding, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/whatsnew)
- [DbContextOptionsBuilder.UseSeeding, API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.dbcontextoptionsbuilder.useseeding)
