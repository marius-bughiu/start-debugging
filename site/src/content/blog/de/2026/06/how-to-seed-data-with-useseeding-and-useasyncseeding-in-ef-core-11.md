---
title: "Daten mit UseSeeding und UseAsyncSeeding in EF Core 11 seeden"
description: "Referenzdaten in EF Core 11 richtig seeden mit UseSeeding und UseAsyncSeeding: wo Sie sie konfigurieren, wann sie laufen, die Idempotenzprüfung, die Sie nicht weglassen dürfen, und warum Sie beide implementieren müssen."
pubDate: 2026-06-21
template: how-to
tags:
  - "dotnet"
  - "efcore"
  - "csharp"
lang: "de"
translationOf: "2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-06-21
---

Um Daten in EF Core 11 zu seeden, konfigurieren Sie `UseSeeding` und `UseAsyncSeeding` am `DbContextOptionsBuilder`, schreiben Sie eine Existenzprüfung an den Anfang jedes Callbacks, damit das Insert nur läuft, wenn die Zeile fehlt, und lösen Sie sie durch einen Aufruf von `EnsureCreated`/`EnsureCreatedAsync`, `Migrate`/`MigrateAsync` oder `dotnet ef database update` aus. Die Callbacks werden bei jeder dieser Operationen ausgeführt, selbst wenn keine Migration angewendet wurde, weshalb die Existenzprüfung das ist, was Sie vor dem Einfügen von Duplikaten bewahrt. Implementieren Sie sowohl die synchrone als auch die asynchrone Überladung mit derselben Logik, denn die EF-Core-Tools rufen nur die synchrone auf. Dieser Beitrag verwendet .NET 11, EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0) und C# 14.

`UseSeeding` und `UseAsyncSeeding` kamen in EF Core 9 und sind der empfohlene Allzweck-Seeding-Mechanismus in EF Core 11. Sie ersetzen die alte Gewohnheit, alles in `HasData` zu stopfen, das das EF-Team seither in "model managed data" umbenannt hat, eben weil es nie für die dynamischen, von der Datenbank abhängigen Daten gedacht war, die die meisten Anwendungen tatsächlich seeden wollen.

## Warum UseSeeding überhaupt existiert

Jahrelang war die Antwort auf "wie bekomme ich Anfangsdaten in meine Datenbank" `HasData`. Es funktioniert, hat aber scharfe Kanten, die zustechen, sobald Ihre Daten etwas anderes sind als eine feste Nachschlagetabelle. `HasData` ist in das Modell eingebacken: EF berechnet Inserts, Updates und Deletes durch einen Vergleich der Daten in Ihrem Migrations-Snapshot, also benötigt es jeden Primärschlüssel von Hand ausgeschrieben, kann keine von der Datenbank generierten Schlüssel verwenden, und jeder Wert, der nicht deterministisch ist (ein `DateTime.UtcNow`, ein `Guid.NewGuid()`, ein gehashtes Passwort), lässt das Modell bei jedem Build "geändert" aussehen. Genau dieser letzte Fall ist eine häufige Quelle der `PendingModelChangesWarning`, die Leute bei einer [Migration von EF Core 6 zu EF Core 11](/de/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) überrascht.

`UseSeeding` ist ganz normaler Anwendungscode, der gegen einen aktiven `DbContext` läuft. Sie fragen ab, Sie verzweigen, Sie rufen externe APIs auf, falls nötig, Sie rufen `SaveChanges` auf. Es gibt keinen Modell-Snapshot, kein Schlüssel-Diffing, keine Determinismus-Anforderung. Es ist das richtige Werkzeug, wann immer Ihre Seed-Daten einer der folgenden Fälle sind: Test-Fixtures, Daten, die von dem abhängen, was bereits in der Datenbank steht, große Blobs, die Sie nicht in Migrations-Snapshots erfassen möchten, Zeilen, deren Schlüssel von der Datenbank generiert werden, oder alles, was eine Transformation wie Passwort-Hashing erfordert. Die offizielle Anleitung sagt es deutlich: `UseSeeding` und `UseAsyncSeeding` sind die empfohlene Art, in EF Core zu seeden, und `HasData` ist nun für wirklich statische Referenzdaten wie Ländercodes oder Postleitzahlen reserviert.

## Wo die Callbacks konfiguriert werden

Die Methoden hängen am `DbContextOptionsBuilder`, sie gehören also dorthin, wo Sie Ihre Optionen erstellen. Die beiden üblichen Orte sind `OnConfiguring` am Kontext selbst und die `AddDbContext`-Registrierung in `Program.cs`.

Hier ist die `OnConfiguring`-Variante direkt aus einer Kontextklasse:

```csharp
// .NET 11, EF Core 11 (Microsoft.EntityFrameworkCore 11.0), C# 14
protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
    => optionsBuilder
        .UseSqlServer(connectionString)
        .UseSeeding((context, _) =>
        {
            var admin = context.Set<Role>().FirstOrDefault(r => r.Name == "Admin");
            if (admin is null)
            {
                context.Set<Role>().Add(new Role { Name = "Admin" });
                context.SaveChanges();
            }
        })
        .UseAsyncSeeding(async (context, _, cancellationToken) =>
        {
            var admin = await context.Set<Role>()
                .FirstOrDefaultAsync(r => r.Name == "Admin", cancellationToken);
            if (admin is null)
            {
                context.Set<Role>().Add(new Role { Name = "Admin" });
                await context.SaveChangesAsync(cancellationToken);
            }
        });
```

Der an den Callback übergebene `context` ist ein voll funktionsfähiger `DbContext`, also gibt Ihnen `context.Set<T>()` dieselbe Abfrage- und Tracking-Oberfläche, die Sie überall verwenden. Der verworfene Parameter `_` ist ein `bool`, der Ihnen mitteilt, ob EF die Datenbank während dieser Operation erstellt hat; die meisten Seeder ignorieren ihn.

In einer typischen ASP.NET-Core-Anwendung konfigurieren Sie dasselbe während der Dependency-Injection-Registrierung. Beachten Sie, dass die Signaturen identisch sind; nur der Host unterscheidet sich:

```csharp
// Program.cs -- .NET 11, ASP.NET Core 11, EF Core 11
builder.Services.AddDbContext<AppDbContext>(options =>
    options
        .UseSqlServer(builder.Configuration.GetConnectionString("Default"))
        .UseSeeding((context, _) => SeedRoles(context))
        .UseAsyncSeeding(async (context, _, ct) => await SeedRolesAsync(context, ct)));
```

Den Rumpf in benannte Methoden (`SeedRoles`, `SeedRolesAsync`) auszulagern, hält die Registrierung lesbar und gibt Ihnen einen offensichtlichen Ort, an dem die gesamte Seed-Logik lebt, was ein großer Teil des Sinns dieser Funktion war.

## Wann die Callbacks tatsächlich laufen

Das ist das Detail, über das Leute stolpern, daher lohnt es sich, es präzise zu formulieren. Die Seeding-Callbacks werden als Teil der folgenden Operationen aufgerufen:

- `context.Database.EnsureCreated()` ruft `UseSeeding` auf.
- `context.Database.EnsureCreatedAsync()` ruft `UseAsyncSeeding` auf.
- `context.Database.Migrate()` und `MigrateAsync()` rufen sie auf.
- `dotnet ef database update` ruft sie auf.

Entscheidend ist, dass sie bei **jedem** Aufruf dieser Operationen laufen, selbst wenn es keine Modelländerungen gab und keine Migrationen angewendet wurden. Ein `Migrate()` auf einer bereits aktuellen Datenbank löst den Seed-Callback trotzdem aus. Das ist beabsichtigt, und es ist das Wichtigste, was Sie verinnerlichen müssen: Das Framework merkt sich nicht, dass es beim letzten Mal geseedet hat, um Sie zu überspringen. Ihr Callback ist dafür verantwortlich, zu entscheiden, ob es etwas zu tun gibt.

Deshalb beginnt jedes obige Beispiel mit einer Abfrage. Das Muster ist immer dasselbe: Suchen Sie die Zeile, fügen Sie nur ein, wenn sie fehlt. Lassen Sie die Prüfung weg, und Sie fügen "Admin" bei jedem Start ein, der `Migrate` aufruft, und innerhalb einer Woche haben Sie eine Tabelle voller doppelter Admin-Rollen.

## Die Idempotenzprüfung ist nicht optional

Da der Callback erneut läuft, muss Ihre Seed-Logik idempotent sein: ihn einmal auszuführen und ihn zehnmal auszuführen, muss die Datenbank im selben Zustand hinterlassen. Die `FirstOrDefault`/`if (x is null)`-Absicherung aus den Beispielen ist die minimale Form. Fragen Sie für einen Stapel von Zeilen die Menge ab, die Sie bereits haben, und fügen Sie nur die Differenz ein:

```csharp
// .NET 11, EF Core 11, C# 14 -- idempotent batch seed
static void SeedRoles(DbContext context)
{
    string[] required = ["Admin", "Editor", "Viewer"];

    var existing = context.Set<Role>()
        .Where(r => required.Contains(r.Name))
        .Select(r => r.Name)
        .ToHashSet();

    var missing = required
        .Where(name => !existing.Contains(name))
        .Select(name => new Role { Name = name })
        .ToList();

    if (missing.Count > 0)
    {
        context.Set<Role>().AddRange(missing);
        context.SaveChanges();
    }
}
```

Ein Roundtrip, um zu lesen, was existiert, einer, um nur das Neue zu schreiben, und es passiert überhaupt nichts, sobald die Tabelle vollständig befüllt ist. Diese letzte Eigenschaft ist wichtig: Ein Seeder, der bei jedem Start ein `SaveChanges` absetzt, selbst ein wirkungsloses, ist Verschwendung und macht Ihre Logs unübersichtlich. Berechnen Sie zuerst die Differenz, schreiben Sie nur, wenn `missing.Count > 0`.

Verlassen Sie sich nicht auf einen eindeutigen Index plus eine verschluckte Ausnahme als Ihre "Idempotenz". Das verwandelt jeden Neustart nach dem ersten in eine abgefangene `DbUpdateException`, die langsam ist, die Logs verschmutzt und echte Fehler verbirgt. Fragen Sie zuerst ab.

## Warum Sie beide Überladungen implementieren müssen

Der Hinweis in der Dokumentation ist leicht zu überlesen und teuer zu ignorieren: Die EF-Core-Tools verlassen sich derzeit auf die **synchrone** `UseSeeding`-Methode und seeden nicht korrekt, wenn nur `UseAsyncSeeding` implementiert ist. Wenn Sie also `dotnet ef database update` ausführen, ist es der synchrone Callback, der ausgelöst wird, ganz gleich, wie asynchron Ihr Anwendungscode ist.

Auch der umgekehrte Fall gilt. Wenn Ihre Anwendung mit `await context.Database.MigrateAsync()` startet (der idiomatische asynchrone Start), ruft dieser Pfad `UseAsyncSeeding` auf, nicht `UseSeeding`. Implementieren Sie nur den synchronen, und das Seeding beim eigenen Start Ihrer Anwendung tut stillschweigend nichts, während Ihr Seeding über die CLI funktioniert, oder umgekehrt.

Die sichere Regel: Implementieren Sie beide mit identischer Logik. Lagern Sie den Rumpf in eine gemeinsame Methode aus, damit die beiden Callbacks nicht auseinanderlaufen können:

```csharp
// .NET 11, EF Core 11, C# 14
options
    .UseSeeding((context, _) => SeedRoles(context))
    .UseAsyncSeeding((context, _, ct) => SeedRolesAsync(context, ct));

// sync and async bodies kept in lockstep
static void SeedRoles(DbContext context) { /* query, branch, SaveChanges */ }

static async Task SeedRolesAsync(DbContext context, CancellationToken ct)
{
    // same query, same branch, SaveChangesAsync(ct)
}
```

Widerstehen Sie der Versuchung, den einen durch Blockieren auf dem anderen zu implementieren (`SeedRolesAsync(context, ct).GetAwaiter().GetResult()` innerhalb des synchronen Callbacks oder `Task.Run` um den synchronen Rumpf im asynchronen). Sync-over-Async lädt unter manchen Synchronisationskontexten zu Deadlocks ein, und Async-over-Sync täuscht nur vor, asynchron zu sein. Schreiben Sie die beiden Rümpfe aus; sie sind kurz.

## Die Nebenläufigkeit ist abgedeckt, aber nur für den Seed-Rumpf

Eine wirklich angenehme Eigenschaft: Der Code innerhalb von `UseSeeding` und `UseAsyncSeeding` ist durch den Migrations-Sperrmechanismus von EF Core geschützt. Wenn zwei Instanzen Ihrer Anwendung im selben Moment starten und beide `Migrate` aufrufen, serialisiert die Sperre sie, sodass nicht beide an der Existenzprüfung vorbeirauschen und doppelt einfügen. Das ist ein echter Vorteil gegenüber handgeschriebenem Start-Seeding, bei dem Sie diese Koordination selbst bauen müssten.

Der Schutz deckt speziell den Seed-Callback ab. Er macht Ihre gesamte Anwendung nicht zu einem Single-Writer-System und schützt keine Daten, die Sie außerhalb des Seed-Pfads schreiben. Behandeln Sie ihn genau als das, was er ist: eine Absicherung, die den Seed-Schritt sicher macht, um ihn nebenläufig aus vielen Instanzen auszuführen.

## Wann UseSeeding die falsche Wahl ist

`UseSeeding` ist kein Hammer für jeden Nagel. Zwei Fälle drängen Sie woanders hin.

Erstens sind wirklich statische Referenzdaten, die sich außerhalb einer Schema-Migration nie ändern -- das kanonische Beispiel ist eine Tabelle von Postleitzahlen oder ISO-Ländercodes -- mit `HasData` immer noch besser bedient. Sie reisen mit der Migration mit, werden zusammen mit dem Schema versioniert und erfordern keine Laufzeit-Abfrage bei jedem Start. Greifen Sie zu `HasData`, wenn die Daten fest, deterministisch und klein sind und Sie damit einverstanden sind, dass sie den Migrationen gehören.

Zweitens lässt sich Seeding, das zwei verschiedene `DbContext`-Instanzen innerhalb einer Transaktion benötigt, nicht sauber in einem einzelnen `UseSeeding`-Callback ausdrücken, der einen Kontext erhält. Dafür verweist die Dokumentation Sie zurück auf die normale benutzerdefinierte Initialisierungslogik: Öffnen Sie die Kontexte selbst, führen Sie die Arbeit aus und halten Sie sie vor allem aus dem normalen Anfragepfad heraus, damit Sie nicht auf Nebenläufigkeitsprobleme stoßen oder von der laufenden Anwendung verlangen, dass sie Rechte zum Ändern des Schemas hat.

```csharp
// .NET 11, EF Core 11 -- custom initialization, run once at deploy time
await using var context = new AppDbContext();
await context.Database.MigrateAsync();

if (!await context.Roles.AnyAsync())
{
    context.Roles.AddRange(new Role { Name = "Admin" }, new Role { Name = "Viewer" });
    await context.SaveChangesAsync();
}
```

Die Warnung in der Dokumentation ist eine Wiederholung wert: Seeding sollte im Allgemeinen nicht Teil der normalen Anwendungsausführung sein. Es beim Start jeder Instanz auszuführen bedeutet, dass jede Instanz Schreibrechte benötigt und dass Sie sich für die Korrektheit auf die Sperre verlassen. In der Produktion ist ein dedizierter, einmaliger Initialisierungsschritt zum Zeitpunkt der Bereitstellung sauberer. `UseSeeding` glänzt für die lokale Entwicklung, Tests und die Art kleiner idempotenter Referenzdaten, bei denen die Abfrage pro Start günstig ist.

## Alles zusammengeführt

Das mentale Modell ist kurz. `UseSeeding` und `UseAsyncSeeding` sind Anwendungscode, den EF Core bei `EnsureCreated`, `Migrate` und `dotnet ef database update` aufruft. Sie laufen jedes Mal, also ist Ihre erste Zeile stets eine Existenzprüfung, und Ihr Schreibvorgang passiert nur für fehlende Zeilen. Sie implementieren beide Überladungen, weil die Tools und Ihr asynchroner Startpfad jeweils unterschiedliche aufrufen. Der Seed-Rumpf ist durch eine Sperre geschützt, damit nebenläufige Starts nicht kollidieren. Und `HasData` ist weiterhin da für den engen Fall statischer, deterministischer, von Migrationen verwalteter Referenzdaten.

Wenn Sie den Rest Ihrer EF-Core-11-Datenschicht straffen, taucht dieselbe Sorgfalt darüber, was wann läuft, an anderen Stellen auf: Sehen Sie, wie [EF-Core-11-Interceptoren das Auditing](/de/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/) am `SaveChanges`-Engpass handhaben, wann Sie [ExecuteUpdate gegenüber dem Laden von Entitäten und einem SaveChanges-Aufruf](/de/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) für Massen-Schreibvorgänge bevorzugen sollten, und warum [AsNoTracking gegenüber AsNoTrackingWithIdentityResolution](/de/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/) bei leselastigen Abfragen wichtig ist. Wenn Ihr Seed-Insert jemals über [der Entitätstyp erfordert die Definition eines Primärschlüssels](/de/2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined/) stolpert, ist das ein Modellierungsproblem, das behoben werden muss, bevor der Seeder läuft.

Quellen: Die [Dokumentation zum Daten-Seeding](https://learn.microsoft.com/en-us/ef/core/modeling/data-seeding) von EF Core auf Microsoft Learn behandelt die `UseSeeding`/`UseAsyncSeeding`-API, das Ausführungs-Timing, die Anforderung beider Überladungen und die Garantie der Migrationssperre; die API-Referenz zu [DbContextOptionsBuilder.UseSeeding](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.dbcontextoptionsbuilder.useseeding) dokumentiert die exakten Signaturen.
