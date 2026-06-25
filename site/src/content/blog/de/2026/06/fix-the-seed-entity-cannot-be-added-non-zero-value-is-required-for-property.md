---
title: "Fix: The seed entity for entity type 'X' cannot be added because a non-zero value is required for property 'Id'"
description: "HasData befüllt eine Entität mit vom Speicher generiertem Schlüssel, aber ohne expliziten Wert. Geben Sie jeder Zeile einen stabilen Id-Wert ungleich null, oder nutzen Sie UseSeeding."
pubDate: 2026-06-25
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
lang: "de"
translationOf: "2026/06/fix-the-seed-entity-cannot-be-added-non-zero-value-is-required-for-property"
translatedBy: "claude"
translationDate: 2026-06-25
---

Die Lösung: Sie haben `HasData` aufgerufen, um eine Entität zu befüllen, deren Primärschlüssel vom Speicher generiert wird (eine `IDENTITY`-Spalte), aber den Schlüssel auf seinem CLR-Standardwert belassen (`0` für `int`, `Guid.Empty` für `Guid`). `HasData` baut sein Insert-Skript zur Migrationszeit auf, ohne die Datenbank zu berühren, und kann sich daher nicht darauf verlassen, dass die Datenbank Schlüssel vergibt. Geben Sie jeder befüllten Zeile einen expliziten, stabilen Schlüsselwert ungleich null (`new Country { Id = 1, ... }`). Wenn die Datenbank den Schlüssel tatsächlich generieren soll, verwenden Sie `HasData` gar nicht erst: nutzen Sie stattdessen `UseSeeding`/`UseAsyncSeeding`. Dieser Leitfaden ist für .NET 11, C# 14 und `Microsoft.EntityFrameworkCore` 11.0.0 geschrieben, doch der Meldungstext und das Verhalten sind seit EF Core 2.1 unverändert.

```text
System.InvalidOperationException: The seed entity for entity type 'Country' cannot be added
because a non-zero value is required for property 'Id'. Consider providing a negative value
to avoid collisions with non-seed data.
   at Microsoft.EntityFrameworkCore.Metadata.Internal.EntityType.<>c__DisplayClass...
   at Microsoft.EntityFrameworkCore.Infrastructure.ModelValidator.ValidateData(IModel model, ...)
   at Microsoft.EntityFrameworkCore.Infrastructure.ModelValidator.Validate(IModel model, ...)
   at Microsoft.EntityFrameworkCore.Metadata.Conventions.Infrastructure.ModelRuntimeInitializer.Initialize(...)
```

Dies ist ein Modellvalidierungsfehler, kein Abfragefehler zur Laufzeit. Er tritt das erste Mal auf, wenn EF Core Ihr Modell aufbaut: bei der ersten Abfrage, dem ersten `SaveChanges`, dem ersten Zugriff auf `context.Model` oder, am häufigsten, wenn Sie `dotnet ef migrations add` ausführen. Der Typname in Anführungszeichen ist die befüllte Entität; die Eigenschaft in Anführungszeichen ist deren Primärschlüssel. Der Hinweis "consider providing a negative value" am Ende ist ein echter Ratschlag, kein Füllwort, und der Abschnitt weiter unten über Kollisionen erklärt, warum.

## Warum HasData den Schlüssel ausgeschrieben braucht

`HasData` (die Dokumentation nennt es jetzt [model managed data](https://learn.microsoft.com/en-us/ef/core/modeling/data-seeding), da "seeding" mehr versprach, als es einhält) gehört den Migrationen. Wenn Sie eine Migration hinzufügen, vergleicht EF Core die befüllten Zeilen in Ihrem aktuellen Modell mit den Zeilen, die es im letzten Modell-Snapshot erfasst hat, und gibt Aufrufe von `InsertData`, `UpdateData` oder `DeleteData` aus, um sie abzugleichen. Dieser Vergleich geschieht zur Entwurfszeit, auf Ihrem Rechner, ohne Datenbankverbindung.

Der Primärschlüssel macht den Vergleich erst möglich. EF Core nutzt ihn, um "das ist dieselbe Zeile, die ich in der letzten Migration eingefügt habe, aber der Name hat sich geändert" von "das ist eine ganz neue Zeile" zu unterscheiden. Ohne stabilen Schlüsselwert hat es nichts, woran es über Migrationen hinweg anknüpfen kann. Deshalb erzwingt der Modellvalidator eine harte Regel: jede `HasData`-Zeile muss einen expliziten Wert für ihren Primärschlüssel tragen, selbst wenn dieser Schlüssel als vom Speicher generiert konfiguriert ist.

Wenn der Schlüssel vom Speicher generiert wird und Sie ihn auf dem CLR-Standardwert belassen, kann EF Core nicht zwischen "die Entwicklerin hat vergessen, den Schlüssel zu setzen" und "die Entwicklerin will Schlüssel 0" unterscheiden. Statt stillschweigend eine Zeile mit `Id = 0` einzufügen (was mit Identity-Spalten heftig kollidiert), wirft es eine Ausnahme. Die [Liste der Einschränkungen von model managed data](https://learn.microsoft.com/en-us/ef/core/modeling/data-seeding) führt dies an erster Stelle: "Der Primärschlüsselwert muss angegeben werden, auch wenn er normalerweise von der Datenbank generiert wird. Er wird verwendet, um Datenänderungen zwischen Migrationen zu erkennen."

## Das kleinste Repro

Eine einzelne Entität mit einem konventionellen `Id` und einem `HasData`-Aufruf, der ihn weglässt.

```csharp
// .NET 11, C# 14, Microsoft.EntityFrameworkCore 11.0.0
public class Country
{
    public int Id { get; set; }      // conventional PK -> store-generated IDENTITY
    public string Name { get; set; } = "";
}

public class AppDbContext : DbContext
{
    public DbSet<Country> Countries => Set<Country>();

    protected override void OnConfiguring(DbContextOptionsBuilder options)
        => options.UseSqlServer("Server=(localdb)\\mssqllocaldb;Database=SeedRepro;Trusted_Connection=True");

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Country>().HasData(
            new Country { Name = "USA" },      // no Id -> Id stays 0 -> throws
            new Country { Name = "Canada" });
    }
}
```

Führen Sie dagegen `dotnet ef migrations add Seed` aus, und Sie erhalten die Ausnahme. Die `Id`-Eigenschaften sind `0`, EF Core behandelt `0` als "kein Wert" für einen vom Speicher generierten `int`-Schlüssel, und die Validierung schlägt fehl, bevor irgendein Migrationscode geschrieben wird.

## Lösung 1: jeder befüllten Zeile einen expliziten, stabilen Schlüssel geben

Dies ist die richtige Lösung für echte Referenzdaten: kleine, feste Nachschlagetabellen, die sich nur über Migrationen ändern (Länder, Währungen, Rollen, Status). Weisen Sie jeder Zeile von Hand einen Schlüsselwert zu und verwenden Sie ihn nie wieder und nummerieren Sie ihn nie um.

```csharp
// .NET 11, C# 14, EF Core 11.0.0
modelBuilder.Entity<Country>().HasData(
    new Country { Id = 1, Name = "USA" },
    new Country { Id = 2, Name = "Canada" },
    new Country { Id = 3, Name = "Mexico" });
```

Zwei Regeln halten dies langfristig am Laufen:

1. **Die Schlüsselwerte sind jetzt Teil Ihrer Schemahistorie.** Behandeln Sie sie als unveränderlich. Wenn Sie Zeile 2 von `Id = 2` auf `Id = 22` ändern, gibt die nächste Migration ein `DeleteData` für `2` und ein `InsertData` für `22` aus, was die alte Zeile und alles, was per Fremdschlüssel auf sie verwies, wegwirft.
2. **Wählen Sie die Werte explizit, lassen Sie sie nicht abdriften.** Fest codierte Konstanten sind in Ordnung. Was Sie nicht tun dürfen, ist sie aus etwas Nichtdeterministischem zu berechnen (einem Schleifenzähler, der von der Sammlungsreihenfolge abhängt, `DateTime.Now`, einem Aufruf von `Guid.NewGuid()`), denn der Migrationsvergleich muss auf jedem Rechner dieselben Werte erzeugen.

Ist der Schlüssel ein `Guid`, gilt dieselbe Regel: liefern Sie einen festen, fest codierten `Guid`, nicht `Guid.NewGuid()`. Ein bei jedem Build neu generierter GUID lässt jede Migration glauben, die Zeile habe sich geändert.

```csharp
// .NET 11, C# 14, EF Core 11.0.0 - fixed GUIDs, not Guid.NewGuid()
modelBuilder.Entity<Role>().HasData(
    new Role { Id = new Guid("3f2504e0-4f89-41d3-9a0c-0305e82c3301"), Name = "Admin" },
    new Role { Id = new Guid("3f2504e0-4f89-41d3-9a0c-0305e82c3302"), Name = "User" });
```

## Lösung 2: negative Schlüssel nutzen, um Identity-Kollisionen zu umgehen

Der Hinweis der Ausnahme selbst, "consider providing a negative value to avoid collisions with non-seed data", löst ein Problem, das Sie später treffen, nicht das vor Ihnen. Wenn Sie `Id = 1, 2, 3` in eine `IDENTITY`-Spalte von SQL Server befüllen, weiß der Identity-Zähler nichts von Ihren befüllten Zeilen. Der erste echte `INSERT` nach der Befüllung startet den Zähler bei `1`, versucht einen Schlüssel zu verwenden, den Ihre Befüllung bereits belegt hat, und schlägt mit einer Primärschlüsselverletzung fehl, oder die `IDENTITY_INSERT`-Maschinerie kommt ins Spiel und es wird unübersichtlich.

Negative Schlüssel für die befüllten Daten umgehen dies. Echte, vom Benutzer erzeugte Zeilen zählen ab `1` aufwärts; Ihre befüllten Referenzzeilen leben unter `0` und überschneiden sich nie.

```csharp
// .NET 11, C# 14, EF Core 11.0.0
modelBuilder.Entity<Country>().HasData(
    new Country { Id = -1, Name = "USA" },
    new Country { Id = -2, Name = "Canada" },
    new Country { Id = -3, Name = "Mexico" });
```

Dies ist die langjährige Empfehlung des EF-Core-Teams für `IDENTITY`-gestützte Nachschlagetabellen, die auch zur Laufzeit Einfügungen erhalten. Für eine Tabelle, die *nur* befüllt wird (eine reine Nachschlagetabelle, in die die App nie einfügt), ist es übertrieben; dort lesen sich positive Schlüssel natürlicher.

## Lösung 3: HasData für diese Daten nicht mehr verwenden

Wenn Ihr Grund, zu `HasData` zu greifen, war "ich will einfach ein paar Anfangszeilen in der Datenbank", dann wollen Sie wahrscheinlich gar keine model managed data. `HasData` ist für statische, deterministische, migrationsbesessene Daten gebaut, und für nichts anderes. Für Daten, die von der Datenbank generierte Schlüssel verwenden sollen, von anderen Zeilen abhängen oder einfach praktische Startdaten sind, empfiehlt das EF-Core-Team jetzt [UseSeeding und UseAsyncSeeding](/de/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/), eingeführt in EF Core 9. Diese führen ein echtes `SaveChanges` gegen eine aktive Datenbank aus, sodass die Datenbank die Schlüssel generiert und die Nicht-Null-Regel nie greift.

```csharp
// .NET 11, C# 14, EF Core 11.0.0
protected override void OnConfiguring(DbContextOptionsBuilder options)
    => options
        .UseSqlServer(connectionString)
        .UseSeeding((context, _) =>
        {
            if (!context.Set<Country>().Any())
            {
                // No Id set: the database generates it on SaveChanges. No error.
                context.Set<Country>().AddRange(
                    new Country { Name = "USA" },
                    new Country { Name = "Canada" });
                context.SaveChanges();
            }
        })
        .UseAsyncSeeding(async (context, _, ct) =>
        {
            if (!await context.Set<Country>().AnyAsync(ct))
            {
                context.Set<Country>().AddRange(
                    new Country { Name = "USA" },
                    new Country { Name = "Canada" });
                await context.SaveChangesAsync(ct);
            }
        });
```

`UseSeeding` wird von `EnsureCreated` und `Migrate` sowie von `dotnet ef database update` aufgerufen, selbst wenn keine ausstehenden Migrationen vorliegen. Implementieren Sie beide Überladungen, die sync und die async: die EF-Core-Tools rufen die synchrone auf, und sie überspringt die Befüllung stillschweigend, wenn nur die async-Version existiert. Da der Befüllungskörper als Anwendungscode ohne Schlüsselanforderung zur Entwurfszeit läuft, ist das Weglassen von `Id` hier genau richtig: die Datenbank weist ihn zu.

## Varianten, die denselben Fehler erzeugen

Der Wortlaut der Meldung ist in all diesen Fällen identisch, sodass Suchverkehr für sie alle hier landet. Die Ursache ist immer dieselbe (einer `HasData`-Zeile fehlt ein expliziter, vom Speicher generierter Schlüsselwert), doch die Oberfläche unterscheidet sich.

- **Owned-Entitäten und komplexe Typen.** `OwnsOne(...).HasData(...)` braucht den Schlüssel des *Eigentümers* in jeder befüllten Zeile, geliefert über ein anonymes Objekt: `new { CountryId = 1, ... }`. Lassen Sie ihn weg, und Sie erhalten den Nicht-Null-Fehler gegen die Schlüsseleigenschaft des Eigentümers.
- **Verknüpfungszeilen für Viele-zu-viele.** Das Befüllen der Verknüpfungstabelle mit `UsingEntity(...).HasData(...)` erfordert beide Fremdschlüssel in jeder Zeile. Eine fehlende oder auf null stehende Seite wirft denselben Fehler. Siehe [wie man eine Viele-zu-viele-Beziehung in EF Core 11 befüllt](/de/2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11/) für die vollständige Einrichtung der Verknüpfungsentität.
- **Zusammengesetzte Schlüssel.** Jede Spalte des zusammengesetzten Schlüssels muss in jeder befüllten Zeile gesetzt sein. Eine Null in irgendeinem Teil löst den Fehler für diese Eigenschaft aus.
- **Schlüssel mit Wertkonvertierung.** Eine stark typisierte ID (ein `record struct CountryId(int Value)`), gestützt von einem Wertkonverter, braucht weiterhin einen Wert ungleich Standard. Die Standardinstanz konvertiert zum Speicherstandard, was als "kein Wert" zählt.

Ein anderer, aber leicht zu verwechselnder Fehler ist `The seed entity for entity type 'X' cannot be added because there was no value provided for the required property 'Y'`, wobei `Y` eine erforderliche Nicht-Schlüssel-Eigenschaft wie `Name` ist. Dieser bedeutet, dass eine `[Required]`- oder `IsRequired()`-Spalte in einer befüllten Zeile null gelassen wurde, nicht dass der Schlüssel fehlt. Die Lösung dort ist, die fehlende Nicht-Schlüssel-Eigenschaft auszufüllen.

Wenn das Modell nie weit genug aufgebaut wird, um die befüllten Daten zu validieren, weil EF Core nicht einmal einen Schlüssel für den Typ findet, haben Sie ein anderes Problem vor sich: siehe die Lösung für [the entity type requires a primary key to be defined](/de/2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined/).

## Warum "setze einfach Id = 0 explizit" nicht funktioniert

Ein verlockender Nicht-Fix ist, `new Country { Id = 0, Name = "USA" }` zu schreiben und anzunehmen, Explizitsein befriedige den Validator. Tut es nicht. Für einen vom Speicher generierten Schlüssel vergleicht EF Core den Wert mit dem CLR-Standardwert, und `0` *ist* der Standard für `int`. Der Validator kann Ihre absichtliche `0` nicht von einem nicht gesetzten Feld unterscheiden, also wirft er weiterhin die Ausnahme. Die einzigen Werte, die durchkommen, sind Nicht-Standardwerte: jeder `int` ungleich null, jeder nicht leere `Guid`, jeder Nicht-Standard-Verbund. Wenn Sie wirklich eine Zeile mit Schlüssel `0` brauchen, ist das ein Zeichen, dass der Schlüssel nicht vom Speicher generiert werden sollte; markieren Sie ihn mit `ValueGeneratedNever()`, und der Validator wendet die Nicht-Null-Regel nicht mehr an, weil der Schlüssel nun vollständig in Ihrer Verantwortung liegt.

```csharp
// .NET 11, C# 14, EF Core 11.0.0 - opt out of store generation, then 0 is allowed
modelBuilder.Entity<Country>(b =>
{
    b.Property(c => c.Id).ValueGeneratedNever();
    b.HasData(new Country { Id = 0, Name = "Unknown" });   // now valid
});
```

Das ist ein echtes Muster für eine Wächterzeile "unbekannt", aber gehen Sie bewusst damit um: sobald der Schlüssel `ValueGeneratedNever` ist, muss jede künftige Einfügung in diese Tabelle ihren eigenen Schlüssel liefern, einschließlich Laufzeiteinfügungen aus Ihrer App.

## Verwandt

- [Wie man Daten mit UseSeeding und UseAsyncSeeding in EF Core 11 befüllt](/de/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/) behandelt den modernen Laufzeit-Befüllungspfad, der diesen Fehler vollständig vermeidet.
- [Wie man eine Viele-zu-viele-Beziehung in EF Core 11 befüllt](/de/2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11/) geht das `HasData` der Verknüpfungsentität durch, wo dieser Fehler häufig auftaucht.
- [Fix: The entity type 'X' requires a primary key to be defined](/de/2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined/) ist der vorgelagerte Fehler, wenn EF Core nicht einmal einen Schlüssel entdecken kann.
- [Von EF Core 6 auf EF Core 11 migrieren: Breaking Changes, die wirklich beißen](/de/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) behandelt, was sich sonst noch geändert hat, falls Sie eine ältere Befüllungseinrichtung aktualisieren.

## Quellen

- Die [Dokumentation zu data seeding](https://learn.microsoft.com/en-us/ef/core/modeling/data-seeding) von EF Core auf Microsoft Learn: der Abschnitt "model managed data", seine Einschränkungsliste ("der Primärschlüsselwert muss angegeben werden, auch wenn er normalerweise von der Datenbank generiert wird"), und die Alternative `UseSeeding`/`UseAsyncSeeding`.
- [dotnet/efcore #27871, "Warn when seeding with a 0 key"](https://github.com/dotnet/efcore/issues/27871): die Diskussion des Teams über den Null-Schlüssel-Fall hinter dieser Ausnahme.
- [dotnet/EntityFramework.Docs #1528](https://github.com/dotnet/EntityFramework.Docs/issues/1528): die Begründung für negative Befüllungsschlüssel bei `IDENTITY`-gestützten Tabellen.
