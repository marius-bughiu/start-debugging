---
title: "Fix: The property 'X' is part of a key and so cannot be modified or marked as modified in EF Core"
description: "EF Core ändert nie einen Schlüsselwert an einer verfolgten Entität. Hören Sie auf, den Schlüssel aus DTOs zu kopieren, verwenden Sie statt eines Alternativschlüssels einen eindeutigen Index und ändern Sie einen echten Schlüssel, indem Sie eine neue Zeile einfügen und die alte löschen. Getestet mit EF Core 10.0.14."
pubDate: 2026-10-27
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "dotnet"
  - "csharp"
  - "change-tracker"
  - "dotnet-10"
lang: "de"
translationOf: "2026/10/fix-the-property-is-part-of-a-key-and-so-cannot-be-modified-in-ef-core"
translatedBy: "claude"
translationDate: 2026-10-27
---

**Kurze Antwort:** EF Core behandelt jede Schlüsseleigenschaft (Primärschlüssel, Alternativschlüssel und jeden Fremdschlüssel, der zugleich Teil des Primärschlüssels ist) als schreibgeschützt, sobald die Entität gespeichert wurde, und der Change Tracker wirft eine Ausnahme, sobald er einen neuen Wert bemerkt. Finden Sie heraus, was den Schlüssel schreibt: meist ein DTO-Mapper oder `CurrentValues.SetValues`, die eine `Id` von `0` kopieren, eine natürliche Spalte, die mit `HasAlternateKey` konfiguriert wurde, oder eine untergeordnete Zeile mit zusammengesetztem Schlüssel, die zu einem anderen Elternobjekt verschoben wird. Hören Sie auf, ihn zu schreiben, stellen Sie den Alternativschlüssel auf einen eindeutigen Index um, oder fügen Sie, wenn sich der Schlüssel wirklich ändern muss, eine neue Entität mit dem neuen Schlüssel hinzu und entfernen Sie die alte im selben `SaveChanges`.

Alles Folgende wurde mit .NET 10 (SDK 10.0.302) und `Microsoft.EntityFrameworkCore.Sqlite` 10.0.14 gegen eine In-Memory-SQLite-Datenbank reproduziert. Die Prüfung, die die Ausnahme auslöst, steckt in `InternalEntryBase.SetPropertyModified` und ist im EF-Core-`main`-Branch, der als EF Core 11 erscheint, unverändert. Dieselben Regeln gelten also auch für die .NET-11-Release-Candidates.

## Der Fehler im Kontext

```
System.InvalidOperationException: The property 'Blog.Id' is part of a key and so cannot be modified or marked as modified. To change the principal of an existing entity with an identifying foreign key, first delete the dependent and invoke 'SaveChanges', and then associate the dependent with the new principal.
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.InternalEntryBase.SetPropertyModified(IProperty property, Boolean changeState, Boolean isModified, Boolean isConceptualNull, Boolean acceptChanges)
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.ChangeDetector.DetectValueChange(IInternalEntry entry, IProperty property)
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.ChangeDetector.LocalDetectChanges(InternalEntryBase entry)
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.ChangeDetector.LocalDetectChanges(InternalEntityEntry entry)
```

Der Eigenschaftsname in der Meldung verrät, welchen Schlüssel EF schützt. `Blog.Id` ist ein Primärschlüssel. Etwas wie `Blog.Slug` bedeutet einen Alternativschlüssel. `OrderLine.OrderId` steht für einen Fremdschlüssel, der zugleich Teil eines zusammengesetzten Primärschlüssels ist, also den "identifizierenden Fremdschlüssel", von dem der zweite Satz der Meldung spricht.

## Warum EF Core keine Schlüsseländerung zulässt

Eine verfolgte Entität wird über ihren Schlüssel identifiziert. Der `DbContext` führt eine Identity Map von Schlüsselwerten auf Entitätsinstanzen, verwendet den ursprünglichen Schlüssel in der `WHERE`-Klausel des `UPDATE` und stellt Navigationen wieder her, indem er Fremdschlüssel mit Primärschlüsseln abgleicht. Könnte sich der Schlüssel an Ort und Stelle ändern, müssten alle drei mitten im Vorgang umgeschrieben werden, dazu jede abhängige Zeile in der Datenbank. EF Core unterstützt das nicht, und die Anfrage, es hinzuzufügen, [dotnet/efcore#4073](https://github.com/dotnet/efcore/issues/4073), ist weiterhin offen.

Die Absicherung ist metadatengesteuert. Jede Schlüsseleigenschaft erhält `PropertySaveBehavior.Throw` als Verhalten nach dem Speichern, und der Change Tracker prüft es, sobald eine Eigenschaft einer `Unchanged`- oder `Modified`-Entität als geändert markiert werden soll:

```csharp
// EF Core source, src/EFCore/ChangeTracking/Internal/InternalEntryBase.cs (simplified)
if (changeState
    && !isConceptualNull
    && isModified
    && !StateManager.SavingChanges
    && property.IsKey()
    && property.GetAfterSaveBehavior() == PropertySaveBehavior.Throw)
{
    throw new InvalidOperationException(CoreStrings.KeyReadOnly(property.Name, StructuralType.DisplayName()));
}
```

Zwei Folgen sind fürs Debugging wichtig. Erstens kehren Entitäten im Zustand `Added` vor dieser Prüfung zurück, den Schlüssel einer noch nicht gespeicherten Entität zu ändern ist also in Ordnung. Zweitens wird die Ausnahme bei der standardmäßigen Snapshot-Änderungsverfolgung nicht in der Zeile geworfen, die den Schlüssel zuweist. Sie wird beim nächsten `DetectChanges` geworfen, das innerhalb von `SaveChanges`, `ChangeTracker.HasChanges()`, `ChangeTracker.Entries()` und ähnlichen Aufrufen läuft. In meiner Reproduktion lief `blog.Id = 99;` ohne Fehler durch, und das unmittelbar folgende `db.ChangeTracker.HasChanges()` warf die Ausnahme. Wenn Ihr Stack Trace in einem Repository auf `SaveChangesAsync` zeigt, liegt der eigentliche Verursacher weiter vorn in der Anfrage.

Abschalten lässt sich das auch nicht. Der Versuch, das Speicherverhalten einer Schlüsseleigenschaft umzustellen, schlägt schon beim Aufbau des Modells fehl:

```csharp
// .NET 10, EF Core 10.0.14
modelBuilder.Entity<Blog>().Property(b => b.Id).Metadata
    .SetAfterSaveBehavior(PropertySaveBehavior.Save);
// InvalidOperationException: The property 'Blog.Id' must be marked as read-only after it has been
// saved because it is part of a key. Key properties are always read-only once an entity has been
// saved for the first time.
```

## Minimale Reproduktion

```csharp
// .NET 10, C# 14, EF Core 10.0.14, Microsoft.EntityFrameworkCore.Sqlite
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

using var conn = new SqliteConnection("Data Source=:memory:");
conn.Open();

using (var db = new AppDb(conn))
{
    db.Database.EnsureCreated();
    db.Blogs.Add(new Blog { Id = 1, Name = "Start Debugging" });
    db.SaveChanges();
}

using (var db = new AppDb(conn))
{
    var blog = db.Blogs.Single(b => b.Id == 1);
    blog.Id = 99;       // no exception here
    db.SaveChanges();   // InvalidOperationException: The property 'Blog.Id' is part of a key...
}

class AppDb(SqliteConnection c) : DbContext
{
    public DbSet<Blog> Blogs => Set<Blog>();
    protected override void OnConfiguring(DbContextOptionsBuilder o) => o.UseSqlite(c);
    protected override void OnModelCreating(ModelBuilder mb) =>
        mb.Entity<Blog>().Property(b => b.Id).ValueGeneratedNever();
}

class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
}
```

Niemand schreibt absichtlich `blog.Id = 99`. Der Rest dieses Beitrags behandelt daher die vier Stellen, von denen der Schreibzugriff tatsächlich kommt, geordnet nach Häufigkeit.

## Fix 1: den Schlüssel nicht aus einem DTO kopieren

Das ist mit Abstand die häufigste Ursache. Ein PUT-Endpunkt lädt die Entität und kopiert dann das eingehende Modell darüber:

```csharp
// .NET 10, EF Core 10.0.14
public record BlogDto(int Id, string Name);

var blog = await db.Blogs.SingleAsync(b => b.Id == id);
db.Entry(blog).CurrentValues.SetValues(dto);   // dto.Id is 0 because the client never sent it
await db.SaveChangesAsync();                    // throws: 'Blog.Id' is part of a key
```

`PropertyValues.SetValues` kopiert jede Eigenschaft mit passendem Namen, Schlüssel eingeschlossen. Stimmt die `Id` des DTO mit der verfolgten überein, ändert sich nichts und das Speichern gelingt; ich habe bestätigt, dass `SetValues` mit `Id = 1` auf der Zeile mit `Id = 1` sauber speichert. Lässt der Client die Id im Body weg oder weichen Routen-Id und Body-Id voneinander ab, ändert sich der Schlüssel und EF wirft die Ausnahme. Beachten Sie, dass der Stack Trace in diesem Fall anders aussieht: Da `SetValues` direkt über den Change Tracker läuft, wird die Ausnahme in `SetValues` selbst ausgelöst (`ChangeDetector.PropertyChanged`), nicht bei `SaveChanges`.

Wählen Sie eine einzige Quelle der Wahrheit für die Id, meist die Route, und lassen Sie sie nie vom Body überschreiben:

```csharp
// .NET 10, EF Core 10.0.14
app.MapPut("/blogs/{id:int}", async (int id, BlogDto dto, AppDb db) =>
{
    if (dto.Id != 0 && dto.Id != id)
        return Results.BadRequest("Route id and body id differ.");

    var blog = await db.Blogs.SingleOrDefaultAsync(b => b.Id == id);
    if (blog is null) return Results.NotFound();

    db.Entry(blog).CurrentValues.SetValues(dto with { Id = id });
    await db.SaveChangesAsync();
    return Results.NoContent();
});
```

Noch besser ist ein Update-DTO ganz ohne `Id`-Eigenschaft, sodass es nichts zu kopieren gibt. Mit AutoMapper ist das Pendant `.ForMember(d => d.Id, o => o.Ignore())` in der Zuordnung von DTO zu Entität, und es lohnt sich, `ForMember(...Ignore())` für jede Schlüsselspalte hinzuzufügen, auch für Fremdschlüssel, die Teil eines zusammengesetzten Schlüssels sind.

Derselbe Fehler passiert bei handgeschriebenen Helfern, die "alle Eigenschaften kopieren", und bei reflexionsbasierten Patchern. Wenn Sie so etwas schreiben, filtern Sie `entry.Metadata.FindPrimaryKey()!.Properties` und alles heraus, wofür `property.IsKey()` wahr ist.

## Fix 2: für natürliche Bezeichner einen eindeutigen Index statt eines Alternativschlüssels verwenden

Die zweite Form ist eine Spalte, die Sie als "eindeutig" betrachten, etwa ein Slug, eine E-Mail-Adresse oder eine SKU, und die als Alternativschlüssel konfiguriert ist:

```csharp
// .NET 10, EF Core 10.0.14
modelBuilder.Entity<Blog>().HasAlternateKey(b => b.Slug);

var blog = db.Blogs.Single();
blog.Slug = "new-slug";
db.SaveChanges();   // InvalidOperationException: The property 'Blog.Slug' is part of a key...
```

Ein Alternativschlüssel ist für EF in jeder relevanten Hinsicht ein Schlüssel und daher nach dem Speichern schreibgeschützt. Die EF-Core-Dokumentation sagt es direkt: "In EF, alternate keys are read-only". Wenn Sie nur Eindeutigkeit in der Datenbank brauchen, konfigurieren Sie stattdessen einen eindeutigen Index:

```csharp
// .NET 10, EF Core 10.0.14
modelBuilder.Entity<Blog>().HasIndex(b => b.Slug).IsUnique();
```

Mit dieser einen geänderten Zeile wurde derselbe Code gespeichert, und die Zeile wurde mit `Slug = "new-slug"` zurückgelesen. Die Datenbank erzwingt die Eindeutigkeit weiterhin, Sie können nur keinen Fremdschlüssel mehr auf `Slug` zeigen lassen.

Achten Sie auf Alternativschlüssel, die Sie nicht deklariert haben. `HasPrincipalKey(x => x.Slug)` an einer Beziehung lässt EF per Konvention einen erzeugen, weil ein Fremdschlüssel auf einen Schlüssel zeigen muss. Nennt die Meldung eine Eigenschaft, für die Sie nie `HasAlternateKey` aufgerufen haben, durchsuchen Sie die Modellkonfiguration nach `HasPrincipalKey` oder untersuchen Sie zur Laufzeit `db.Model.FindEntityType(typeof(Blog))!.GetKeys()`. Die saubere Lösung ist, die Beziehung auf den Primärschlüssel zielen zu lassen. Migrationstechnisch ersetzt der Wechsel von Alternativschlüssel zu eindeutigem Index eine eindeutige `AK_`-Einschränkung durch einen eindeutigen `IX_`-Index; prüfen Sie die generierte Migration, bevor Sie sie anwenden.

## Fix 3: Abhängige mit zusammengesetztem Schlüssel durch Löschen und erneutes Hinzufügen verschieben

Der zweite Satz der Meldung betrifft diesen Fall. Angenommen, eine Auftragsposition wird durch `(OrderId, LineNumber)` identifiziert und `OrderId` ist zugleich der Fremdschlüssel zu `Order`. Das ist eine identifizierende Beziehung: Die Identität der Position schließt ihr Elternobjekt ein. Sie zu einem anderen Auftrag zu verschieben bedeutet, ihren Primärschlüssel zu ändern, und jede Art, das auszudrücken, wirft eine Ausnahme:

```csharp
// .NET 10, EF Core 10.0.14
modelBuilder.Entity<OrderLine>().HasKey(l => new { l.OrderId, l.LineNumber });

var line = db.OrderLines.Single();
line.OrderId = 2;                     // throws at SaveChanges
// line.Order = order2;               // throws during fix-up
// order2.Lines.Add(line);            // throws during fix-up
db.SaveChanges();
```

Alle drei Varianten erzeugten in meiner Reproduktion `The property 'OrderLine.OrderId' is part of a key`. Die Varianten mit Navigation und Auflistung werfen aus dem Beziehungs-Fixup, das den Fremdschlüssel für Sie setzt.

Die Lösung besteht darin, das Verschieben als das zu behandeln, was es wirklich ist: das Löschen einer Zeile und das Einfügen einer anderen.

```csharp
// .NET 10, EF Core 10.0.14
var line = await db.OrderLines.SingleAsync(l => l.OrderId == 1 && l.LineNumber == 1);

db.OrderLines.Remove(line);
db.OrderLines.Add(new OrderLine
{
    OrderId = 2,
    LineNumber = 1,
    Sku = line.Sku,
});

await db.SaveChangesAsync();
```

Die Meldung schlägt vor, nach dem Löschen und vor dem Einfügen `SaveChanges` aufzurufen. Unter EF Core 10 war das in keinem der von mir getesteten Fälle nötig: Das Entfernen der alten Position und das Hinzufügen der neuen in einem einzigen `SaveChanges` funktionierte sowohl bei anderem neuem Schlüssel (`2/1`) als auch bei identischem (`1/1` mit neuer `Sku`), und beide Anweisungen liefen in derselben Transaktion. Ein einziges `SaveChanges` ist zudem sicherer, denn ein Absturz zwischen zwei Speichervorgängen würde die Position gelöscht und nicht neu angelegt zurücklassen.

Wenn Positionen regelmäßig zwischen Eltern wandern, sagt Ihnen das Modell etwas. Geben Sie `OrderLine` einen eigenen Ersatzschlüssel (`int Id`) und machen Sie `OrderId` zu einem gewöhnlichen Fremdschlüssel ohne Schlüsselrolle. Dann ist `line.OrderId = 2` ein normales Update. Halten Sie `(OrderId, LineNumber)` mit einem eindeutigen Index eindeutig, falls Sie diese Einschränkung brauchen.

## Fix 4: einen Principal neu verschlüsseln, indem Sie eine Kopie einfügen und die Kinder umhängen

Manchmal muss der Primärschlüssel selbst geändert werden: Ein älterer natürlicher Schlüssel wurde falsch erfasst, oder zwei Systeme werden zusammengeführt. Innerhalb des Change Trackers ist das Muster dasselbe wie bei Fix 3, mit einem zusätzlichen Schritt für die Kinder:

```csharp
// .NET 10, EF Core 10.0.14
var old = await db.Blogs.Include(b => b.Posts).SingleAsync(b => b.Id == 1);

var replacement = new Blog { Id = 99, Name = old.Name, Slug = old.Slug + "-moved" };
db.Blogs.Add(replacement);

foreach (var post in old.Posts.ToList())
    post.Blog = replacement;          // Post.BlogId is a plain FK, not part of Post's key

db.Blogs.Remove(old);
await db.SaveChangesAsync();
```

EF Core ermittelt die Reihenfolge der Befehle (neuen Blog einfügen, Beiträge aktualisieren, alten Blog löschen) und führt sie in einer Transaktion aus. In der Reproduktion blieb danach ein Blog mit `Id = 99` übrig, und das `BlogId` des Beitrags war auf `99` gesetzt. Beachten Sie, dass der Slug in der Kopie geändert wurde: Hätte `Slug` einen eindeutigen Index, kann das Einfügen eines identischen Werts mit der alten Zeile kollidieren, die noch nicht gelöscht ist. Geben Sie der Kopie entweder einen temporären Wert und korrigieren Sie ihn danach, oder verwenden Sie den mengenbasierten Ansatz unten.

### Der mengenbasierte Ausweg: ExecuteUpdate

`ExecuteUpdate` wird direkt in SQL übersetzt und berührt den Change Tracker nie, die Schlüsselprüfung greift also nicht:

```csharp
// .NET 10, EF Core 10.0.14
var rows = await db.Blogs
    .Where(b => b.Id == 1)
    .ExecuteUpdateAsync(s => s.SetProperty(b => b.Id, 99));
```

Bei einem Blog ohne Beiträge gab das `1` zurück, und die Id der Zeile wurde zu `99`. Bei einem Blog mit einem darauf verweisenden Beitrag antwortete SQLite mit `SQLite Error 19: 'FOREIGN KEY constraint failed'`, was genau das ist, was jede Datenbank tut, sofern der Fremdschlüssel nicht mit `ON UPDATE CASCADE` deklariert wurde. Die Fluent API von EF Core kennt `OnDelete`, aber kein Gegenstück für Updates, Sie müssten das Cascade also mit `migrationBuilder.Sql(...)` in einer Migration ergänzen. Für eine einmalige Datenkorrektur lohnt sich das meist nicht; Einfügen, Umhängen, Löschen ist leichter nachzuvollziehen.

Zwei Einschränkungen, wenn Sie `ExecuteUpdate` auf Schlüssel anwenden. Jede Entität, die derselbe Kontext bereits verfolgt, hat weiterhin den alten Schlüssel, führen Sie das Update also in einem frischen Kontext aus oder lösen Sie sie zuvor ab. Und es umgeht `SaveChanges`-Interceptors und Audit-Logik, was vermutlich der Zweck ist, aber eine bewusste Entscheidung sein sollte.

## Stolperfallen und ähnliche Fehler

**Das Setzen von `IsModified` auf einem Schlüssel wirft sofort.** Code, der über `entry.Properties` iteriert und bei allen `IsModified = true` setzt, scheitert an der ersten Schlüsseleigenschaft. `db.Entry(blog).Property(b => b.Id).IsModified = true` warf in der Reproduktion ohne jeden `SaveChanges`-Aufruf. Überspringen Sie Eigenschaften, bei denen `p.Metadata.IsKey()` wahr ist. Den ganzen Eintrag auf `EntityState.Modified` zu setzen ist in Ordnung (er wurde in der Reproduktion sauber gespeichert), weil EF nur Nicht-Schlüssel-Eigenschaften markiert.

**`Update()` auf einem losgelösten Objekt mit anderer Id ist ein anderer Fehler.** `db.Update(new Blog { Id = 2, ... })` versucht nicht, einen Schlüssel zu ändern. Es sendet `UPDATE ... WHERE Id = 2`, und existiert diese Zeile nicht, erhalten Sie `DbUpdateConcurrencyException: The database operation was expected to affect 1 row(s), but actually affected 0 row(s)`. Derselbe Grundfehler (falsche Id vom Client), anderes Symptom.

**Zwei Instanzen mit demselben Schlüssel sind ebenfalls ein anderer Fehler.** Beheben Sie diesen Fehler, indem Sie ein zweites Objekt mit dem neuen Schlüssel anhängen, während das alte noch verfolgt wird, stoßen Sie stattdessen womöglich auf [den Fehler "cannot be tracked because another instance with the same key value is already being tracked"](/de/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/). [Vor dem Anhängen zu prüfen, ob eine Entität bereits verfolgt wird](/de/2026/10/how-to-check-whether-an-entity-is-already-tracked-by-the-dbcontext-in-ef-core/), vermeidet beide.

**Den Schlüssel einer `Added`-Entität zu ändern ist in Ordnung.** Bis zum ersten `SaveChanges` gilt der Schlüssel noch nicht als "gespeichert", daher fügt `var b = new Blog { Id = 5 }; db.Add(b); b.Id = 6;` eine Zeile mit `Id = 6` ein. Das ist relevant für Code, der eine vorläufige Id vergibt und sie vor dem Speichern korrigiert.

## Verwandte Themen

Wenn Sie Schlüssel am Ende mit mengenbasierten Anweisungen ändern, behandelt die Anleitung zu [ExecuteUpdate und ExecuteDelete für Massenschreibvorgänge](/de/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) die API und ihr Zusammenspiel mit verfolgten Entitäten, und der Vergleich von [ExecuteUpdate gegenüber dem Laden von Entitäten mit anschließendem SaveChanges](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) erklärt, wann welches Werkzeug das richtige ist. Scheitert die Lösch-Hälfte einer Neuverschlüsselung, weil Kinder noch auf die alte Zeile zeigen, lesen Sie [den Fix für "foreign key constraint failed"](/de/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/). Um genau zu sehen, welche Einträge gespeichert werden sollen, bevor die Ausnahme auftritt, ist [`ChangeTracker.GetEntriesForState`](/de/2026/04/efcore-11-changetracker-getentriesforstate/) der günstigste Weg, sie auszugeben.

## Quellen

- [`KeyReadOnly` resource string](https://github.com/dotnet/efcore/blob/main/src/EFCore/Properties/CoreStrings.resx) und [`InternalEntryBase.SetPropertyModified`](https://github.com/dotnet/efcore/blob/main/src/EFCore/ChangeTracking/Internal/InternalEntryBase.cs), dotnet/efcore-Quellcode.
- [Support modifying the value of primary or alternate key properties, dotnet/efcore#4073](https://github.com/dotnet/efcore/issues/4073), offene Funktionsanfrage.
- [Keys: alternate keys](https://learn.microsoft.com/en-us/ef/core/modeling/keys#alternate-keys), EF-Core-Dokumentation.
- [Indexes: index uniqueness](https://learn.microsoft.com/en-us/ef/core/modeling/indexes#index-uniqueness), EF-Core-Dokumentation.
- [Change detection and notifications](https://learn.microsoft.com/en-us/ef/core/change-tracking/change-detection), EF-Core-Dokumentation.
- [`PropertyValues.SetValues`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.changetracking.propertyvalues.setvalues), Microsoft Learn.
- [ExecuteUpdate and ExecuteDelete](https://learn.microsoft.com/en-us/ef/core/saving/execute-insert-update-delete), EF-Core-Dokumentation.
