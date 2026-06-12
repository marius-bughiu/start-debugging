---
title: "Lösung: The entity type 'X' requires a primary key to be defined in EF Core 11"
description: "EF Core findet keinen Schlüssel für Ihren Typ. Benennen Sie eine Eigenschaft Id oder {Type}Id, ergänzen Sie [Key], rufen Sie HasKey auf oder, bei einer View oder rohem SQL, HasNoKey."
pubDate: 2026-06-12
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
lang: "de"
translationOf: "2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined"
translatedBy: "claude"
translationDate: 2026-06-12
---

Die Lösung: EF Core erstellt Ihr Modell und findet einen Typ, den es für eine Entität hält, für den es aber keinen Primärschlüssel finden kann. Sie haben drei echte Optionen, in dieser Reihenfolge: geben Sie dem Typ einen Schlüssel (benennen Sie eine Eigenschaft `Id` oder `{Type}Id`, ergänzen Sie `[Key]` oder rufen Sie `modelBuilder.Entity<T>().HasKey(...)` auf); teilen Sie EF Core mit, dass der Typ absichtlich ohne Schlüssel ist, mit `HasNoKey()` (korrekt für Views und Ergebnisse aus rohem SQL); oder verhindern Sie, dass EF Core ihn als Entität behandelt, indem Sie das überflüssige `DbSet<T>` entfernen oder `modelBuilder.Ignore<T>()` aufrufen. Wählen Sie die Option, die dem entspricht, was der Typ tatsächlich ist.

```text
System.InvalidOperationException: The entity type 'OrderSummary' requires a primary key to be defined.
If you intended to use a keyless entity type, call 'HasNoKey' in 'OnModelCreating'.
For more information on keyless entity types, see https://go.microsoft.com/fwlink/?linkid=2141943.
   at Microsoft.EntityFrameworkCore.Infrastructure.ModelValidator.ValidateNonNullPrimaryKeys(IModel model)
   at Microsoft.EntityFrameworkCore.Infrastructure.ModelValidator.Validate(IModel model, ...)
   at Microsoft.EntityFrameworkCore.Metadata.Conventions.Infrastructure.ModelRuntimeInitializer.Initialize(...)
```

Dies ist ein Fehler bei der Modellvalidierung, kein Abfragefehler zur Laufzeit. Er wird beim ersten Erstellen des Modells durch EF Core ausgelöst: die erste Abfrage, das erste `SaveChanges`, der erste `dotnet ef`-Befehl oder ein Aufruf von `context.Model`. Der Typname in Anführungszeichen ist derjenige, für den EF Core keinen Schlüssel ermitteln konnte. Dieser Leitfaden ist für .NET 11, C# 14 und `Microsoft.EntityFrameworkCore` 11.0.0 geschrieben. Das Verhalten und der Meldungstext sind seit EF Core 7 unverändert, alles hier Beschriebene gilt also bis zu dieser Version zurück.

## Was "requires a primary key" tatsächlich bedeutet

Wenn EF Core Ihr Modell erstellt, führt es eine Reihe von Konventionen aus. Eine davon, `KeyDiscoveryConvention`, versucht, für jeden Entitätstyp einen Primärschlüssel zu wählen, indem sie nach einer Eigenschaft sucht, die ohne Beachtung der Groß-/Kleinschreibung `Id` oder `{EntityTypeName}Id` heißt. Findet sie genau eine solche Eigenschaft, wird diese zum Schlüssel. Findet sie keine, bleibt die Entität ohne Schlüssel, und dann läuft `ModelValidator` und lehnt schlüssellose Entitäten ab, die nicht explizit als schlüssellos markiert wurden. Diese Ablehnung ist die Ausnahme, die Sie gerade lesen.

Der Fehler bedeutet also immer eines von zwei Dingen:

1. EF Core hält diesen Typ für eine Entität, aber die Konvention konnte keinen Schlüssel ermitteln, und Sie haben keinen konfiguriert.
2. EF Core sollte diesen Typ überhaupt nicht als Entität behandeln, aber etwas hat ihn ins Modell gezogen.

Die gesamte Lösung besteht darin herauszufinden, welches der beiden zutrifft. Zwei Fragen klären das: entspricht dieser Typ einer echten Tabelle oder View, die ich lese und schreibe, und hat er eine natürliche eindeutige Kennung? Lautet die Antwort auf beide ja, will der Typ einen Schlüssel. Ist es eine Projektion, eine Berichtszeile oder ein Ergebnis aus rohem SQL, will er `HasNoKey` oder gar nicht im Modell auftauchen.

## Die kleinste Reproduktion

Ein `DbSet` eines Typs, dessen Schlüsseleigenschaft nicht so benannt ist, dass die Konvention sie erkennt.

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public class AppDb : DbContext
{
    public DbSet<OrderSummary> OrderSummaries => Set<OrderSummary>();

    public AppDb(DbContextOptions<AppDb> options) : base(options) { }
}

public class OrderSummary
{
    public Guid Reference { get; set; }   // not "Id", not "OrderSummaryId"
    public decimal Total { get; set; }
}
```

`Reference` ist eine vollkommen gute Kennung, aber die Konvention weiß das nicht. Sie hat nach `Id` oder `OrderSummaryId` gesucht, keines gefunden, den Typ schlüssellos gelassen, und die Validierung schlug fehl. Derselbe Fehler erscheint, wenn Sie eine SQL-View auf eine Klasse abbilden, Zeilen aus `FromSql` in einen nicht abgebildeten Typ zurückgeben oder versehentlich ein DTO als `DbSet` offenlegen.

## Lösung 1: geben Sie dem Typ einen Schlüssel

Verwenden Sie dies, wenn der Typ eine echte Entität ist, die Sie abfragen und persistieren. Drei Wege, in zunehmender Explizitheit.

Benennen Sie die Eigenschaft um, damit die Konvention sie findet:

```csharp
// .NET 11, EF Core 11.0.0 -- convention discovers this automatically
public class OrderSummary
{
    public Guid Id { get; set; }          // discovered by KeyDiscoveryConvention
    public decimal Total { get; set; }
}
```

Oder behalten Sie Ihren eigenen Namen und annotieren Sie ihn:

```csharp
// .NET 11, EF Core 11.0.0
public class OrderSummary
{
    [Key]
    public Guid Reference { get; set; }
    public decimal Total { get; set; }
}
```

Oder konfigurieren Sie ihn in `OnModelCreating`, was der richtige Ort ist, wenn Sie keine Attribute auf den Typ setzen können oder wollen (etwa weil die Klasse in einem Domänenprojekt liegt, das EF Core nicht referenzieren darf):

```csharp
// .NET 11, EF Core 11.0.0
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<OrderSummary>().HasKey(o => o.Reference);
}
```

Für einen zusammengesetzten Schlüssel übergeben Sie ein anonymes Objekt. Es gibt kein `[Key]`-Attribut-Äquivalent, das die Spaltenreihenfolge zuverlässig festlegt, bevorzugen Sie also die Fluent-Form:

```csharp
// .NET 11, EF Core 11.0.0 -- composite key, order matters for the index
modelBuilder.Entity<OrderLine>().HasKey(l => new { l.OrderId, l.LineNumber });
```

Eine Falle innerhalb dieser Lösung: die Schlüsseleigenschaft muss eine lesbare, abgebildete CLR-Eigenschaft sein. Ein öffentliches **Feld**, eine mit `[NotMapped]` markierte Eigenschaft oder eine Eigenschaft eines Typs, den EF Core nicht abbilden kann, werden nicht erkannt, und Sie erhalten den Fehler weiterhin, obwohl "dort doch eindeutig ein Id ist". Machen Sie sie zu einer Auto-Eigenschaft eines abbildbaren Typs (`int`, `long`, `Guid`, `string` und so weiter).

## Lösung 2: deklarieren Sie den Typ mit HasNoKey als schlüssellos

Verwenden Sie dies, wenn der Typ wirklich keinen Primärschlüssel hat: eine Datenbank-View, die Ergebnisform einer gespeicherten Prozedur oder eine schreibgeschützte Berichtszeile. Schlüssellose Entitätstypen sind schreibgeschützt, werden nie vom Change Tracker verfolgt und können nicht an `SaveChanges` teilnehmen.

```csharp
// .NET 11, EF Core 11.0.0 -- a view with no natural key
modelBuilder.Entity<OrderSummary>()
    .HasNoKey()
    .ToView("vw_OrderSummary");
```

Die Attribut-Form ist `[Keyless]` auf der Klasse, was dem Aufruf von `HasNoKey()` entspricht:

```csharp
// .NET 11, EF Core 11.0.0
[Keyless]
public class OrderSummary
{
    public Guid Reference { get; set; }
    public decimal Total { get; set; }
}
```

Wird der schlüssellose Typ von rohem SQL statt von einer View gespeist, bilden Sie ihn auf die Abfrage statt auf eine Tabelle ab:

```csharp
// .NET 11, EF Core 11.0.0
modelBuilder.Entity<OrderSummary>()
    .HasNoKey()
    .ToSqlQuery("SELECT Reference, SUM(Total) AS Total FROM Orders GROUP BY Reference");
```

Greifen Sie nicht zu `HasNoKey`, nur um den Fehler bei einem Typ verschwinden zu lassen, der tatsächlich eine Identität hat. Eine schlüssellose Entität kann über den Kontext weder aktualisiert noch gelöscht werden, und EF Core dedupliziert keine Zeilen mit denselben Werten, sodass Sie stillschweigend Duplikate im Speicher erhalten können. `HasNoKey` ist eine Aussage über die Daten, kein Workaround.

## Lösung 3: verhindern Sie die Abbildung des Typs durch EF Core ganz

Oft ist der Typ keine Entität und sollte nie eine sein. Er wurde auf eine von drei Arten ins Modell gezogen:

- Sie haben ein `DbSet<SomeDto>` für eine Projektion oder ein View-Model hinzugefügt. Entfernen Sie es und projizieren Sie stattdessen mit `Select` in das DTO.
- Eine abgebildete Entität hat eine Navigationseigenschaft, die auf den Typ zeigt, sodass EF Core ihn transitiv abgebildet hat. Soll diese Navigation keine Beziehung sein, markieren Sie sie mit `[NotMapped]`.
- Sie haben irgendwo `modelBuilder.Entity<SomeDto>()` aufgerufen (oft um eine einzelne Eigenschaft zu setzen), was ihn als Entität registriert.

Um einen Typ explizit auszuschließen, ignorieren Sie ihn:

```csharp
// .NET 11, EF Core 11.0.0
modelBuilder.Ignore<OrderSummary>();
```

Oder, auf einer Eigenschaft, die die transitive Abbildung verursacht:

```csharp
// .NET 11, EF Core 11.0.0
public class Order
{
    public int Id { get; set; }

    [NotMapped]
    public OrderSummary? Computed { get; set; }   // a view model, not a relationship
}
```

Für einmalige Projektionen brauchen Sie selten überhaupt einen abgebildeten Typ. Projizieren Sie direkt in die gewünschte Form, und EF Core versucht nie, einen Schlüssel dafür zu vergeben:

```csharp
// .NET 11, EF Core 11.0.0 -- no DbSet, no HasNoKey, nothing to key
var summaries = await db.Orders
    .GroupBy(o => o.CustomerId)
    .Select(g => new OrderSummary { Reference = g.Key, Total = g.Sum(o => o.Total) })
    .ToListAsync();
```

## Varianten, die in demselben Fehler enden

### Einen Record ohne Id abbilden

Ein positionaler `record` funktioniert gut als Entität, aber nur, wenn einer seiner Parameter zu einem auffindbaren Schlüssel wird. `public record OrderSummary(Guid Reference, decimal Total);` läuft aus demselben Grund in diesen Fehler wie die Klasse: `Reference` ist nicht `Id`. Benennen Sie den ersten Parameter `Id`, ergänzen Sie `[property: Key]` am positionalen Parameter oder konfigurieren Sie `HasKey` in `OnModelCreating`. Die Mechanik der Abbildung von Records, einschließlich init-only-Eigenschaften und Wertgleichheit, wird im Leitfaden zur [korrekten Verwendung von Records mit EF Core 11](/2026/04/how-to-use-records-with-ef-core-11-correctly/) behandelt.

### Ergebnistypen von Database.SqlQuery<T> und FromSql

`db.Database.SqlQuery<OrderSummary>($"...")` bildet `OrderSummary` zur Abfragezeit als impliziten schlüssellosen Typ ab, und dieser Pfad braucht keine Konfiguration. Rufen Sie jedoch zusätzlich an anderer Stelle `modelBuilder.Entity<OrderSummary>()` für denselben Typ auf, haben Sie ihn nun als reguläre Entität registriert, und die Konvention verlangt einen Schlüssel. Halten Sie den Typ entweder ganz aus `OnModelCreating` heraus (lassen Sie `SqlQuery` ihn handhaben) oder registrieren Sie ihn explizit mit `HasNoKey()`. Dies ist die Grundursache hinter [dotnet/efcore#35575](https://github.com/dotnet/efcore/issues/35575), wo ein Abfragetyp mit einer konfigurierten Entität gleichen Namens kollidierte.

### Der Fehler nennt einen Typ, den Sie nicht geschrieben haben

Ist der Typ in Anführungszeichen ein Framework- oder Bibliothekstyp, hat ihn eine Navigation hereingezogen. Finden Sie die Entität, die ihn referenziert, und entscheiden Sie: echte Beziehung (konfigurieren Sie den Schlüssel auf dem referenzierten Typ) oder nicht (markieren Sie die Navigation mit `[NotMapped]` oder `Ignore<T>()` den Typ). Das tritt oft bei stark typisierten JSON-Spalten und schemaübergreifenden Fremdschlüsseln auf, wie in [dotnet/efcore#36614](https://github.com/dotnet/efcore/issues/36614).

### Es schlägt nur unter dotnet ef fehl, nicht zur Laufzeit

`dotnet ef migrations add` und `dotnet ef database update` erstellen das vollständige Modell, sie bringen also Modellfehler ans Licht, die ein enger Laufzeit-Codepfad vielleicht noch nicht ausgelöst hat. Der Fehler ist echt; die Tools haben ihn nur zuerst gefunden. Kann der Entwurfszeit-Build Ihren Kontext nicht einmal konstruieren, sehen Sie zuerst eine andere Meldung; diese wird in [warum dotnet ef migrations add Ihren DbContext nicht erstellen kann](/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/) behandelt.

### Ein nullbarer oder verdeckter Schlüssel

Ist Ihre Schlüsseleigenschaft nullbar (`int?`), wird EF Core sie erkennen, aber `ModelValidator` lehnt null-Primärschlüssel mit einer eng verwandten Meldung ab. Machen Sie den Schlüssel nicht nullbar. Ebenso kann, wenn eine Basisklasse und eine abgeleitete Klasse beide `Id` deklarieren, das verdeckte Element die Ermittlung verwirren; deklarieren Sie den Schlüssel einmal auf dem Typ, den EF Core abbildet.

## Die Lösung bestätigen

Nachdem Sie eine der drei Lösungen angewendet haben, erzwingen Sie einen Modell-Build, ohne Ihre App auszuführen, damit die Rückkopplungsschleife schnell ist:

```bash
# .NET 11 SDK, EF Core tools 11.0.0
dotnet ef dbcontext info --startup-project ./Api
```

Ist das Modell gültig, gibt dies den Provider und die Kontextdetails aus. Ist ein Typ weiterhin schlüssellos und unmarkiert, wirft es dieselbe Ausnahme, und die Meldung sagt Ihnen genau, welcher Typ noch ungelöst ist. Arbeiten Sie sie einzeln ab; ein Modell mit mehreren View- oder DTO-Typen kann einmal pro Typ werfen, bis jeder behandelt ist.

Das Denkmodell, das es sich zu merken lohnt: dieser Fehler ist EF Core, das Sie bittet, einen Typ einzuordnen. Entität mit Identität, schreibgeschützte schlüssellose Form oder Nicht-Entität. Sobald Sie das beantworten, ist die Lösung mechanisch. Wenn Sie diese Typen in Ihre Tests einbinden und möchten, dass sich das Change-Tracking richtig verhält, passen die Muster aus [DbContext mocken, ohne das Change-Tracking zu zerstören](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) und [das EF-Core-Modell vor der ersten Abfrage aufwärmen](/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/) gut dazu, Ihre Schlüssel richtig zu setzen.

## Quellen

- [Keyless entity types](https://learn.microsoft.com/en-us/ef/core/modeling/keyless-entity-types), EF-Core-Dokumentation, zu `HasNoKey`, `[Keyless]` und den Schreibschutz-Beschränkungen.
- [Keys](https://learn.microsoft.com/en-us/ef/core/modeling/keys), EF-Core-Dokumentation, zur Ermittlung per Konvention, `[Key]` und zusammengesetzten Schlüsseln.
- [Model validation and conventions](https://learn.microsoft.com/en-us/ef/core/modeling/), EF-Core-Dokumentation.
- [dotnet/efcore#29198](https://github.com/dotnet/efcore/issues/29198) und [dotnet/efcore#35575](https://github.com/dotnet/efcore/issues/35575), die kanonischen Issues hinter dieser Meldung.
