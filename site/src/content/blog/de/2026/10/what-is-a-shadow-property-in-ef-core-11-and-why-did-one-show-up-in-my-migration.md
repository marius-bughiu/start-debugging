---
title: "Was ist eine Shadow Property in EF Core 11, und warum taucht eine in meiner Migration auf?"
description: "Eine Shadow Property ist eine Spalte, die EF Core ohne passende CLR-Eigenschaft verfolgt. Hier steht, warum EF Core 11 sie erzeugt (fehlende FK-Eigenschaften, falsch benannte FKs, Typkonflikte, doppelt konfigurierte Beziehungen), wie Sie die BlogId1-Variante in einer Migration erkennen, wie Sie jede Ursache beheben und wie Sie Shadow Properties gezielt einsetzen."
pubDate: 2026-10-09
tags:
  - "ef-core"
  - "ef-core-11"
  - "dotnet-11"
  - "migrations"
  - "relationships"
lang: "de"
translationOf: "2026/10/what-is-a-shadow-property-in-ef-core-11-and-why-did-one-show-up-in-my-migration"
translatedBy: "claude"
translationDate: 2026-10-09
---

Kurze Antwort: Eine Shadow Property ist eine Eigenschaft, die im EF-Core-Modell und meist auch als Spalte in der Datenbank existiert, aber keine passende Eigenschaft in Ihrer Entitätsklasse hat. EF Core 11 erzeugt eine, sobald eine Beziehung einen Fremdschlüssel braucht und keine CLR-Eigenschaft dafür findet. Entsteht sie, weil Ihre Klasse schlicht keine FK-Eigenschaft hat, ist die Shadow-Spalte harmlos. Entsteht sie, weil Sie eine FK-Eigenschaft *haben*, die EF Core nicht verwenden konnte (falscher Name, falscher Typ, `[NotMapped]` oder eine doppelt konfigurierte Beziehung), erhalten Sie neben der gewünschten Spalte eine Spalte wie `BlogId1` oder `OwnerId`. Die Lösung besteht darin, EF Core mit `HasForeignKey` mitzuteilen, welche Eigenschaft der Fremdschlüssel ist.

Alles Folgende wurde mit `Microsoft.EntityFrameworkCore.Sqlite` 11.0.0-rc.1.26425.128 auf dem .NET-11-RC1-SDK (11.0.100-rc.1.26425.128) und C# 14 ausgeführt. Modellausgaben und Warnungen stammen aus echten Läufen und sind nicht umschrieben.

## Was EF Core mit "Shadow" meint

Jede Eigenschaft in einem EF-Core-Modell hat Metadaten: einen Namen, einen CLR-Typ, Nullbarkeit und die Angabe, ob sie Schlüssel oder FK ist. Für die meisten Eigenschaften gibt es außerdem ein Member in der Klasse, eine C#-Eigenschaft oder ein Feld, das EF Core beim Materialisieren von Entitäten oder beim Speichern von Änderungen liest und schreibt. Eine Shadow Property hat die Metadaten, aber keinen Member. Ihr Wert existiert nur im Change Tracker.

Das ist die gesamte Definition laut der [Dokumentation zu Shadow- und Indexer-Eigenschaften](https://learn.microsoft.com/en-us/ef/core/modeling/shadow-properties). EF Core ist es egal, wie die Eigenschaft entstanden ist. Sie können eine bewusst deklarieren, oder Konventionen erzeugen sie beim Erstellen des Modells. Der zweite Fall überrascht die Leute, weil er zuerst in einer Migration sichtbar wird, die eine Spalte hinzufügt, die Sie nie geschrieben haben.

Welche Eigenschaften Shadow Properties sind, sehen Sie, wenn Sie das Modell ausgeben. `Model.ToDebugString()` kennzeichnet sie mit `(no field, ...)` und `Shadow`:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
using Microsoft.EntityFrameworkCore.Infrastructure;

using var db = new AppDbContext();
Console.WriteLine(db.Model.ToDebugString(MetadataDebugStringOptions.ShortDefault));
```

Heben Sie sich diese eine Zeile auf. Sie ist der schnellste Weg, die Frage "Woher kommt diese Spalte?" zu beantworten, ohne den Migrations-Snapshot zu lesen.

## Fall 1: Die Navigation hat keine FK-Eigenschaft (erwartet, harmlos)

Die häufigste Shadow Property erzeugt EF Core, wenn Sie eine Beziehung nur mit Navigationen modellieren:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
public class Blog
{
    public int Id { get; set; }
    public List<Post> Posts { get; set; } = [];
}

public class Post
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
}
```

Hier liegt eine One-to-Many-Beziehung vor, daher braucht die Tabelle `Post` eine Fremdschlüsselspalte. `Post` hat kein `BlogId`, also erfindet EF Core eines. Die Debug-Ansicht zeigt es:

```text
EntityType: Post
  Properties:
    Id (int) Required PK AfterSave:Throw ValueGenerated.OnAdd
    BlogId (no field, int?) Shadow FK Index
    Title (string) Required
  Foreign keys:
    Post {'BlogId'} -> Blog {'Id'} ClientSetNull ToDependent: Posts
```

Und die erzeugte Tabelle:

```sql
CREATE TABLE "Post" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_Post" PRIMARY KEY AUTOINCREMENT,
    "Title" TEXT NOT NULL,
    "BlogId" INTEGER NULL,
    CONSTRAINT "FK_Post_Blogs_BlogId" FOREIGN KEY ("BlogId") REFERENCES "Blogs" ("Id")
);
```

Der Name folgt der Konvention `<Navigations- oder Prinzipaltypname><Prinzipalschlüsselname>`, hier `Blog` + `Id`. Zwei Details sind wichtig. Erstens ist der Shadow-FK `int?`, die Beziehung ist also optional und das Löschverhalten ist `ClientSetNull`, nicht `Cascade`. Wenn Sie erforderliche Semantik erwartet haben, fügen Sie eine echte Eigenschaft `int BlogId` hinzu oder rufen `.IsRequired()` an der Beziehung auf. Zweitens protokolliert EF Core dies nur auf Debug-Ebene als `CoreEventId.ShadowPropertyCreated` (Ereignis 10600):

```text
The property 'Post.BlogId' was created in shadow state because there are no eligible CLR members with a matching name.
```

In einem Standard-Konsolenlog sehen Sie das nicht. Das ist Absicht: Es ist eine legitime Modellierungsentscheidung, und viele Codebasen halten FK-Werte aus ihren Domänenklassen heraus.

## Fall 2: Die FK-Eigenschaft hat einen unkonventionellen Namen (still, und falsch)

Dieser Fall erzeugt eine "Geisterspalte" in einer Migration, völlig ohne Warnung:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
public class User
{
    public int Id { get; set; }
}

public class Post
{
    public int Id { get; set; }
    public int OwnerUserId { get; set; }
    public User Owner { get; set; } = null!;
}
```

Sie wollten, dass `OwnerUserId` der Fremdschlüssel für `Owner` ist. Die FK-Erkennungskonvention von EF Core erkennt nur Namen der Form `<Navigationsname><Prinzipalschlüsselname>` (`OwnerId`), `<Prinzipaltypname><Prinzipalschlüsselname>` (`UserId`) oder `<Prinzipal-Entitätstypname>Id`. `OwnerUserId` passt auf keine davon, daher behandelt EF Core es als gewöhnliche `int`-Spalte und erzeugt einen Shadow-FK `OwnerId`:

```text
EntityType: Post
  Properties:
    Id (int) Required PK AfterSave:Throw ValueGenerated.OnAdd
    OwnerId (no field, int) Shadow Required FK Index
    OwnerUserId (int) Required
```

```sql
CREATE TABLE "Posts" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_Posts" PRIMARY KEY AUTOINCREMENT,
    "OwnerUserId" INTEGER NOT NULL,
    "OwnerId" INTEGER NOT NULL,
    CONSTRAINT "FK_Posts_User_OwnerId" FOREIGN KEY ("OwnerId") REFERENCES "User" ("Id") ON DELETE CASCADE
);
```

Ihr Code setzt `post.OwnerUserId = 42`, speichert, und nichts wird verknüpft. Die Beziehung steckt in `OwnerId`, das Ihr Code nie anfasst. EF Core protokolliert auch hier nur das Ereignis `ShadowPropertyCreated` auf Debug-Ebene. Das erste Symptom ist daher meist ein Join, der nichts zurückgibt, oder ein Migrationsdiff, das zufällig jemand genau liest.

Die Lösung ist, den FK explizit zu benennen:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Post>()
        .HasOne(p => p.Owner)
        .WithMany()
        .HasForeignKey(p => p.OwnerUserId);
}
```

oder mit dem Data Annotation an der Navigation: `[ForeignKey(nameof(OwnerUserId))] public User Owner { get; set; }`. Danach hat das Modell genau einen FK, `OwnerUserId`, und die Shadow-Spalte ist verschwunden. Wurde bereits eine Migration mit `OwnerId` ausgeliefert, entfernt die nächste Migration `OwnerId` und fügt die FK-Einschränkung für `OwnerUserId` hinzu. Prüfen Sie, ob Zeilen über die alte Spalte geschrieben wurden, bevor Sie sie verwerfen lassen.

## Fall 3: Die FK-Eigenschaft hat den falschen Typ (BlogId1)

Nun das berüchtigte Suffix `1`:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
public class Blog
{
    public int Id { get; set; }
    public List<Post> Posts { get; set; } = [];
}

public class Post
{
    public int Id { get; set; }
    public string BlogId { get; set; } = "";   // principal key is int
    public Blog Blog { get; set; } = null!;
}
```

`BlogId` hat den konventionellen Namen, ist aber ein `string`, während `Blog.Id` ein `int` ist. EF Core kann eine inkompatible Eigenschaft nicht als FK verwenden. Es kann die Shadow Property auch nicht `BlogId` nennen, weil der Name vergeben ist, und macht ihn daher eindeutig zu `BlogId1`. Diesmal protokolliert EF Core eine Warnung, `CoreEventId.ShadowForeignKeyPropertyCreated` (Ereignis 10625):

```text
warn: CoreEventId.ShadowForeignKeyPropertyCreated[10625]
      The foreign key property 'Post.BlogId1' was created in shadow state because a conflicting property
      with the simple name 'BlogId' exists in the entity type, but is either not mapped, is already used
      for another relationship, or is incompatible with the associated primary key type.
```

Die Meldung nennt die drei Ursachen, die zu einem nummerierten Shadow-FK führen. Ein Typkonflikt ist eine davon. Die anderen beiden folgen.

## Fall 4: Die Beziehung wurde doppelt konfiguriert (BlogId und BlogId1)

Dieser Fall entsteht durch Fluent API, die nur eine Seite der Beziehung benennt:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
public class Post
{
    public int Id { get; set; }
    public int BlogId { get; set; }
    public Blog Blog { get; set; } = null!;
}

protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Blog>()
        .HasMany(b => b.Posts)
        .WithOne()                       // no navigation passed
        .HasForeignKey(p => p.BlogId);
}
```

`WithOne()` ohne Argument teilt EF Core mit: "Diese Beziehung hat auf der Seite von `Post` keine Navigation." `Post.Blog` existiert aber, daher bauen die Konventionen daraus eine *zweite* Beziehung. `BlogId` wird bereits von der ersten verwendet, also bekommt die zweite `BlogId1`:

```text
Foreign keys:
  Post {'BlogId'} -> Blog {'Id'} Required Cascade ToDependent: Posts
  Post {'BlogId1'} -> Blog {'Id'} Required Cascade ToPrincipal: Blog
```

```sql
CREATE TABLE "Post" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_Post" PRIMARY KEY AUTOINCREMENT,
    "BlogId" INTEGER NOT NULL,
    "BlogId1" INTEGER NOT NULL,
    CONSTRAINT "FK_Post_Blogs_BlogId" FOREIGN KEY ("BlogId") REFERENCES "Blogs" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_Post_Blogs_BlogId1" FOREIGN KEY ("BlogId1") REFERENCES "Blogs" ("Id") ON DELETE CASCADE
);
```

Zwei erforderliche FKs auf dieselbe Tabelle, und `blog.Posts` sowie `post.Blog` beschreiben nicht mehr dieselbe Verknüpfung. Die Lösung besteht darin, die Navigation zu übergeben, damit beide Enden zu einer Beziehung gehören: `.WithOne(p => p.Blog)`. Mit dieser Änderung hat das Modell wieder einen einzigen FK `BlogId` mit `Inverse: Posts`.

Ein nützlicher Unterschied: Entfernen Sie den Aufruf `HasForeignKey(p => p.BlogId)` aus dieser fehlerhaften Konfiguration, erzeugt EF Core 11 nicht stillschweigend `BlogId1`. Stattdessen wirft es beim Finalisieren des Modells eine Ausnahme:

```text
System.InvalidOperationException: Both relationships between 'Post' and 'Blog.Posts' and between 'Post.Blog'
and 'Blog' could use {'BlogId'} as the foreign key. To resolve this, configure the foreign key properties
explicitly in 'OnModelCreating' on at least one of the relationships.
```

Wenn Sie auf diese Ausnahme stoßen, ist es also nicht die richtige Reaktion, so lange `HasForeignKey` hinzuzufügen, bis sie verschwindet. Dadurch wird die Ausnahme in das oben gezeigte `BlogId1`-Schema umgewandelt. Suchen Sie die Beziehung, der die Navigation fehlt, und beheben Sie diese.

## Fall 5: Die FK-Eigenschaft ist nicht gemappt

Die dritte Ursache in der Warnung ist eine Eigenschaft, die EF Core nicht verwenden darf:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
public class Post
{
    public int Id { get; set; }
    [NotMapped] public int BlogId { get; set; }
    public Blog Blog { get; set; } = null!;
}
```

Das Ergebnis ist eine Tabelle mit nur einer Spalte `BlogId1`, plus derselben Warnung 10625. Dasselbe passiert mit `modelBuilder.Entity<Post>().Ignore(p => p.BlogId)`. Soll die CLR-Eigenschaft der FK sein, entfernen Sie das Ignorieren. Soll sie ein ungemappter Helfer sein, benennen Sie sie um, damit sie nicht mit dem konventionellen FK-Namen kollidiert.

## Versehentliche Shadow-FKs abfangen, bevor sie ausgeliefert werden

Jedes Migrationsdiff zu lesen funktioniert, bis es nicht mehr funktioniert. Zwei günstigere Schutzmaßnahmen:

Machen Sie aus der Warnung eine Ausnahme. Die Fälle 3, 4 und 5 lösen alle `ShadowForeignKeyPropertyCreated` aus, und EF Core lässt sich anweisen, dafür eine Ausnahme zu werfen:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
using Microsoft.EntityFrameworkCore.Diagnostics;

protected override void OnConfiguring(DbContextOptionsBuilder options) => options
    .UseSqlite("Data Source=app.db")
    .ConfigureWarnings(w => w.Throw(CoreEventId.ShadowForeignKeyPropertyCreated));
```

Der Zugriff auf `db.Model` schlägt nun mit `An error was generated for warning 'Microsoft.EntityFrameworkCore.Model.Validation.ShadowForeignKeyPropertyCreated'` fehl, und da `dotnet ef migrations add` das Modell ebenfalls erstellt, entsteht die fehlerhafte Migration gar nicht erst. Tun Sie dasselbe nicht für `ShadowPropertyCreated`, außer Sie haben keine einzige beabsichtigte Shadow Property, denn das Ereignis wird auch für den harmlosen Fall 1 ausgelöst.

Prüfen Sie das Modell in einem Test. Fall 2 löst nie eine Warnung aus, ein Unit-Test, der das Modell durchläuft, ist daher das einzige automatische Sicherheitsnetz:

```csharp
// .NET 11, EF Core 11.0.0-rc.1, xUnit
[Fact]
public void No_unexpected_shadow_foreign_keys()
{
    using var db = new AppDbContext();
    var allowed = new HashSet<string> { "Post.BlogId" };   // the ones you chose on purpose

    var shadowFks = db.Model.GetEntityTypes()
        .SelectMany(e => e.GetProperties())
        .Where(p => p.IsShadowProperty() && p.IsForeignKey())
        .Select(p => $"{p.DeclaringType.ClrType.Name}.{p.Name}")
        .Where(name => !allowed.Contains(name))
        .ToList();

    Assert.Empty(shadowFks);
}
```

`IsShadowProperty()` und `IsForeignKey()` gehören zur öffentlichen Metadaten-API von `IReadOnlyProperty`, dafür sind also weder interner Zugriff noch eine Datenbank nötig.

## Shadow Properties gezielt einsetzen

Wenn Sie wissen, was sie sind, sind Shadow Properties ein sauberes Werkzeug für Daten, die in die Tabelle gehören, aber nicht ins Domänenobjekt. Audit-Zeitstempel sind der klassische Fall:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Post>().Property<DateTime>("LastUpdated");
}

public override int SaveChanges()
{
    foreach (var entry in ChangeTracker.Entries<Post>()
                 .Where(e => e.State is EntityState.Added or EntityState.Modified))
    {
        entry.Property("LastUpdated").CurrentValue = DateTime.UtcNow;
    }
    return base.SaveChanges();
}
```

Die Klasse `Post` bleibt frei von Persistenzbelangen, und die Tabelle erhält eine Spalte `"LastUpdated" TEXT NOT NULL` (unter SQLite). Lesen und Schreiben laufen über den Change Tracker, `db.Entry(post).Property<DateTime>("LastUpdated").CurrentValue`, und Abfragen laufen über `EF.Property`:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
var recent = await db.Posts
    .Where(p => EF.Property<DateTime>(p, "LastUpdated") > DateTime.UtcNow.AddDays(-1))
    .OrderBy(p => EF.Property<DateTime>(p, "LastUpdated"))
    .ToListAsync();
```

Das wird in einen einfachen Spaltenverweis übersetzt:

```sql
SELECT "p"."Id", "p"."LastUpdated", "p"."Title"
FROM "Posts" AS "p"
WHERE "p"."LastUpdated" > rtrim(rtrim(strftime('%Y-%m-%d %H:%M:%f', 'now', CAST(-1.0 AS TEXT) || ' days'), '0'), '.')
```

Für alles, was über eine einzelne Entität hinausgeht, legen Sie die Stempellogik in einen `SaveChangesInterceptor`, statt `SaveChanges` in jedem Kontext zu überschreiben.

## Stolpersteine

- **Shadow-Werte gehen beim Trennen verloren.** Der Wert existiert nur im Change Tracker. Abfragen mit `AsNoTracking()` liefern die Shadow-Spalten zwar im SQL, aber Sie können sie aus dem materialisierten Objekt nicht lesen. Projizieren Sie sie bei Bedarf explizit mit `EF.Property` in einem `Select`.
- **Shadow-FKs und getrennte Graphen.** Hängen Sie einen `Post` an, bei dem nur eine Navigation gesetzt ist, füllt EF Core den Shadow-FK bei `SaveChanges` aus der Navigation. Hängen Sie einen `Post` ohne Navigation und ohne FK-Eigenschaft an, gibt es nichts zum Füllen, und Sie müssen ihn über `Entry(...).Property("BlogId").CurrentValue` setzen.
- **Umbenennungen sind Migrationen, nicht nur Code.** Die Behebung der Fälle 2, 3 oder 4 ändert das Schema. EF Core erzeugt ein Drop für die Shadow-Spalte. Wurden Produktionsdaten darüber geschrieben, kopieren Sie sie innerhalb der Migration vor dem Drop in die echte FK-Spalte.
- **Indexer-Eigenschaften sind verwandt, aber nicht dasselbe.** Property Bags (Entitätstypen vom Typ `Dictionary<string, object>`) verwenden Indexer-Eigenschaften, die einen CLR-Zugriff haben, den Indexer. Sie sind keine Shadow Properties, auch wenn sie ebenfalls keine benannte C#-Eigenschaft haben.

## Verwandte Beiträge

- Wenn die Shadow-Spalte zuerst als unerklärliche Migration auftauchte, erklärt [fixing "the model for context has pending changes" in EF Core 11](/de/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/), wie das Snapshot-Diff funktioniert.
- Das Audit-Muster in sauberer Form zeigt [using EF Core 11 interceptors for auditing](/de/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/).
- Um die Spalte `BlogId1` im tatsächlich von EF Core erzeugten SQL zu sehen, zeigt [logging the SQL that EF Core 11 generates](/de/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) alle Optionen.
- Ein erforderlicher Shadow-FK mit `Cascade` ändert das Löschverhalten; [fixing FOREIGN KEY constraint failed on delete](/de/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/) erklärt, wie EF Core es auswählt.
- Wenn Sie FKs ohnehin umbenennen, zeigt [custom naming conventions for keys, foreign keys, and indexes in EF Core 11](/de/2026/09/how-to-apply-custom-naming-conventions-for-keys-foreign-keys-and-indexes-in-ef-core-11/), wie das modellweit geht.

## Quellen

- [Shadow and Indexer Properties](https://learn.microsoft.com/en-us/ef/core/modeling/shadow-properties), EF-Core-Dokumentation.
- [Foreign and principal keys in relationships](https://learn.microsoft.com/en-us/ef/core/modeling/relationships/foreign-and-principal-keys), EF-Core-Dokumentation, für die Namensregeln der FK-Erkennung.
- [CoreEventId.ShadowForeignKeyPropertyCreated](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.diagnostics.coreeventid.shadowforeignkeypropertycreated), API-Referenz.
- [Microsoft.EntityFrameworkCore 11.0.0-rc.1.26425.128](https://www.nuget.org/packages/Microsoft.EntityFrameworkCore/11.0.0-rc.1.26425.128) auf NuGet, die Version, die für jeden Lauf in diesem Beitrag verwendet wurde.
