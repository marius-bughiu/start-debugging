---
title: "Fix: FOREIGN KEY constraint failed beim Löschen einer Entität in EF Core 11"
description: "EF Core wirft FOREIGN KEY constraint failed, weil das übergeordnete Element noch abhängige Zeilen hat, die die Datenbank nicht verwaisen lässt. Laden Sie die Kinder, machen Sie die Beziehung optional oder konfigurieren Sie OnDelete."
pubDate: 2026-06-26
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
lang: "de"
translationOf: "2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-06-26
---

Der Fix: Sie löschen eine Prinzipal-Zeile (übergeordnet), auf die noch abhängige Zeilen (untergeordnet) zeigen, und die Datenbank lässt sie nicht verwaisen. Sie haben drei echte Optionen, der Reihe nach: Laden Sie die abhängigen Zeilen vor `SaveChanges` in den Kontext, damit EF Core den Löschvorgang selbst kaskadieren kann; machen Sie die Beziehung optional (nullbarer Fremdschlüssel), damit der Fremdschlüssel der Kinder auf null gesetzt werden kann; oder konfigurieren Sie `OnDelete(DeleteBehavior.Cascade)` und erstellen Sie das Schema neu, damit die Datenbank die Kinder für Sie löscht. Wählen Sie die Option, die zu dem passt, was mit den Kindern geschehen soll.

```text
Microsoft.EntityFrameworkCore.DbUpdateException: An error occurred while saving the entity changes. See the inner exception for details.
 ---> Microsoft.Data.Sqlite.SqliteException (0x80004005): SQLite Error 19: 'FOREIGN KEY constraint failed'.
   at Microsoft.Data.Sqlite.SqliteException.ThrowExceptionForRC(int rc, sqlite3 db)
   at Microsoft.EntityFrameworkCore.Update.ReaderModificationCommandBatch.ExecuteAsync(...)
```

Dies ist ein Laufzeit-Datenbankfehler, ausgelöst von `SaveChanges`/`SaveChangesAsync` und in einer `DbUpdateException` verpackt. Der genaue Wortlaut stammt vom SQLite-Provider. Auf SQL Server erzeugt dieselbe Situation `The DELETE statement conflicted with the REFERENCE constraint "FK_..."`, auf PostgreSQL ist es `23503: update or delete on table "..." violates foreign key constraint` und auf MySQL ist es `Cannot delete or update a parent row: a foreign key constraint fails`. Anderer Text, identische Ursache. Dieser Leitfaden ist geschrieben für .NET 11, C# 14, `Microsoft.EntityFrameworkCore` 11.0.0 und `Microsoft.Data.Sqlite` 11.0.0. Das Verhalten ist seit EF Core 7 unverändert, gilt also bis zu jenem Release zurück.

## Warum die Datenbank den Löschvorgang verweigert

EF Core modelliert eine Beziehung mit einem Fremdschlüssel: Die abhängige Zeile speichert den Primärschlüssel ihres Prinzipals. Wenn Sie den Prinzipal löschen, verweist jeder abhängige Fremdschlüssel, der auf ihn zeigte, nun auf eine Zeile, die nicht mehr existiert. Das ist eine Verletzung der referenziellen Integrität, und eine relationale Datenbank verhindert sie am Constraint.

Es gibt nur zwei legale Auswege, und die Datenbank kann nur einen wählen, wenn Sie ihr sagen, welchen:

1. Die abhängigen Zeilen ebenfalls löschen (Cascade Delete).
2. Den Fremdschlüssel der abhängigen Zeilen auf null setzen (nur möglich, wenn die Spalte nullbar ist).

Wenn Sie den Prinzipal löschen, ohne eines von beiden zu arrangieren, wirft die Datenbank. Der Grund, warum dies so häufig auftritt, ist, dass die *Standard*-Konfiguration von EF Core davon abhängt, ob die Beziehung erforderlich oder optional ist und ob die abhängigen Zeilen zum Zeitpunkt des Aufrufs von `SaveChanges` in den Kontext geladen sind. Diese beiden Schalter entscheiden, ob EF Core die Dinge im Arbeitsspeicher korrigiert, bevor SQL gesendet wird, oder ob es das Problem direkt an die Datenbank weitergibt, die es dann verweigert.

Ein subtiler erschwerender Faktor: SQLite erzwingt Fremdschlüssel überhaupt nicht, es sei denn `PRAGMA foreign_keys = ON`, was `Microsoft.Data.Sqlite` standardmäßig setzt. Entwickler, die mit einer älteren Konfiguration getestet haben oder mit dem In-Memory-Provider von EF Core (der keine Constraints erzwingt), sind oft überrascht, wenn eine echte SQLite- oder SQL-Server-Datenbank den Löschvorgang zum ersten Mal ablehnt.

## Das kleinste Repro

Eine erforderliche Eins-zu-viele-Beziehung: `Blog` hat viele `Post`, und `Post.BlogId` ist nicht nullbar, also ist die Beziehung erforderlich.

```csharp
// .NET 11, C# 14, EF Core 11.0.0, Microsoft.Data.Sqlite 11.0.0
public class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public List<Post> Posts { get; } = new();
}

public class Post
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int BlogId { get; set; }            // non-nullable => required relationship
    public Blog Blog { get; set; } = null!;
}

public class AppDb : DbContext
{
    public DbSet<Blog> Blogs => Set<Blog>();
    public DbSet<Post> Posts => Set<Post>();

    public AppDb(DbContextOptions<AppDb> options) : base(options) { }
}
```

Löschen Sie nun einen Blog, der Posts hat, ohne diese Posts zu laden:

```csharp
// .NET 11, EF Core 11.0.0 -- throws DbUpdateException -> "FOREIGN KEY constraint failed"
var blog = await db.Blogs.SingleAsync(b => b.Id == 1);   // no Include(b => b.Posts)
db.Blogs.Remove(blog);
await db.SaveChangesAsync();
```

EF Core weiß nur vom Blog. Es gibt ein einzelnes `DELETE FROM Blogs WHERE Id = 1` aus. Die Posts verweisen weiterhin auf Blog 1, und die Datenbank bricht die Anweisung ab. Der Fehler ist korrekt: Sie haben verlangt, eine Zeile zu löschen, von der andere Zeilen abhängen, und Sie haben nicht gesagt, was mit ihnen geschehen soll.

Beachten Sie den Gegensatz. Bei einer erforderlichen Beziehung ist das Standard-Löschverhalten `Cascade`, aber "Cascade" kann auf zwei Arten angewendet werden: von EF Core (im Arbeitsspeicher, erfordert, dass die Kinder geladen sind) oder von der Datenbank (erfordert `ON DELETE CASCADE` am Constraint). Wenn das Schema ohne `ON DELETE CASCADE` erstellt wurde und die Kinder nicht geladen sind, greift kein Mechanismus, und Sie landen bei diesem Fehler.

## Fix 1: Die abhängigen Zeilen laden, damit EF Core kaskadieren kann

Der portabelste Fix und derjenige, der unabhängig davon funktioniert, wie der Datenbank-Constraint erstellt wurde. Ziehen Sie die Kinder mit `Include` in den Kontext, und EF Core gibt `DELETE`-Anweisungen für sie aus, bevor das übergeordnete Element gelöscht wird.

```csharp
// .NET 11, EF Core 11.0.0 -- EF Core deletes posts, then the blog
var blog = await db.Blogs
    .Include(b => b.Posts)
    .SingleAsync(b => b.Id == 1);

db.Blogs.Remove(blog);
await db.SaveChangesAsync();
```

Mit den verfolgten Posts erkennt EF Core, dass das Löschen des Blogs eine erforderliche Beziehung trennt, wendet die Kaskade im Arbeitsspeicher an und ordnet das SQL korrekt an: zuerst die Posts löschen, dann den Blog. Das funktioniert, weil EF Core "konfigurierte Kaskadenverhalten immer auf verfolgte Entitäten anwendet", unabhängig vom Datenbankschema.

Die Kosten liegen auf der Hand: Sie laden jede abhängige Zeile in den Arbeitsspeicher, nur um sie zu löschen. Für einen Blog mit zehn Posts ist das in Ordnung. Für ein übergeordnetes Element mit hunderttausend Kindern ist es ein Arbeitsspeicher- und Roundtrip-Problem, und Sie wollen stattdessen Fix 3 (Datenbank-Kaskade) oder ein mengenbasiertes Bulk-Delete. EF Core 11's [`ExecuteDelete` für Bulk-Writes](/de/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) löscht Kinder in einer einzigen SQL-Anweisung, ohne sie zu materialisieren, was das richtige Werkzeug ist, wenn die Kindermenge groß ist. Denken Sie nur daran, dass `ExecuteDelete` den Change Tracker umgeht, sodass Sie Kinder explizit vor dem übergeordneten Element löschen, statt sich auf die Kaskade zu verlassen.

## Fix 2: Die Beziehung optional machen, damit der FK auf null gesetzt werden kann

Verwenden Sie dies, wenn das Kind legitimerweise ohne das übergeordnete Element existieren kann. Machen Sie den Fremdschlüssel nullbar, und das Standardverhalten für eine optionale Beziehung wird `ClientSetNull`: EF Core setzt den Fremdschlüssel der abhängigen Zeilen auf null, statt sie zu löschen.

```csharp
// .NET 11, EF Core 11.0.0 -- optional relationship
public class Post
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int? BlogId { get; set; }           // nullable => optional relationship
    public Blog? Blog { get; set; }
}
```

Nach einer Migration, die die Spalte `BlogId` nullbar macht, erzeugt das Löschen eines Blogs mit geladenen Posts für jeden Post `UPDATE Posts SET BlogId = NULL ...` und anschließend `DELETE FROM Blogs ...`. Die Posts überleben, losgelöst von jedem Blog.

```csharp
// .NET 11, EF Core 11.0.0 -- posts kept, FK set to null
var blog = await db.Blogs.Include(b => b.Posts).SingleAsync(b => b.Id == 1);
db.Blogs.Remove(blog);
await db.SaveChangesAsync();
```

Zwei Vorbehalte. Erstens ist dies eine semantische Entscheidung, kein Trick, um den Fehler zum Schweigen zu bringen: Machen Sie eine Beziehung nur dann optional, wenn ein verwaistes Kind in Ihrer Domäne wirklich gültig ist. Ein `Post` ohne `Blog` mag Unsinn sein. Zweitens benötigt EF Core bei `ClientSetNull` (dem Standard) immer noch die geladenen abhängigen Zeilen, um deren FK auf null zu setzen; wenn sie nicht geladen sind, erhalten Sie erneut eine `DbUpdateException`. Um das Nullsetzen in die Datenbank zu verlagern, sodass es ohne Laden funktioniert, konfigurieren Sie `OnDelete(DeleteBehavior.SetNull)`, was `ON DELETE SET NULL` am Constraint ausgibt.

```csharp
// .NET 11, EF Core 11.0.0 -- database nulls the FK on delete, no need to load children
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Blog>()
        .HasMany(b => b.Posts)
        .WithOne(p => p.Blog)
        .HasForeignKey(p => p.BlogId)
        .OnDelete(DeleteBehavior.SetNull);
}
```

## Fix 3: Die Datenbank so konfigurieren, dass sie den Löschvorgang kaskadiert

Verwenden Sie dies, wenn die Kinder mit dem übergeordneten Element sterben sollen und Sie sie nicht zuerst laden möchten. Konfigurieren Sie `DeleteBehavior.Cascade` und erstellen oder migrieren Sie das Schema so, dass der Constraint `ON DELETE CASCADE` trägt. Die Datenbank löscht dann die abhängigen Zeilen selbst, wenn Sie den Prinzipal löschen.

```csharp
// .NET 11, EF Core 11.0.0 -- ON DELETE CASCADE in the database
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Blog>()
        .HasMany(b => b.Posts)
        .WithOne(p => p.Blog)
        .HasForeignKey(p => p.BlogId)
        .OnDelete(DeleteBehavior.Cascade);
}
```

Für eine erforderliche Beziehung ist dies bereits der Konventions-Standard, aber der Constraint trägt `ON DELETE CASCADE` nur dann, wenn die Datenbank *mit dieser Konfiguration erstellt oder migriert wurde*. Das ist die Falle, in die die meisten Leute tappen: Sie fügen `OnDelete(Cascade)` hinzu (oder verlassen sich auf den Standard), der Build gelingt, und der Löschvorgang scheitert trotzdem, weil die laufende Datenbank erstellt wurde, bevor die Kaskade konfiguriert wurde, und der bestehende Constraint keine Cascade-Klausel hat. Die Konfiguration in `OnModelCreating` ändert das Modell, nicht die laufende Datenbank. Sie müssen eine Migration generieren und anwenden:

```bash
# .NET 11 SDK, EF Core tools 11.0.0
dotnet ef migrations add ConfigurePostCascade
dotnet ef database update
```

Überprüfen Sie, dass der Constraint die Kaskade tatsächlich trägt. Inspizieren Sie auf SQLite die Fremdschlüsselliste:

```sql
-- run against the SQLite database file
SELECT * FROM pragma_foreign_key_list('Posts');
-- the "on_delete" column should read CASCADE, not NO ACTION
```

Danach löscht `db.Blogs.Remove(blog); await db.SaveChangesAsync();` den Blog ohne `Include`, und die Datenbank entfernt die Posts im selben Vorgang.

Eine Plattformeinschränkung, die man kennen sollte, bevor man überall zur Kaskade greift: SQL Server lehnt mehrere Kaskadenpfade zur selben Tabelle ab. Wenn zwei erforderliche Beziehungen beide per Cascade Delete in eine Tabelle löschen würden, scheitert das Erstellen des Schemas mit `Introducing FOREIGN KEY constraint '...' on table '...' may cause cycles or multiple cascade paths`. Der Fix dort besteht darin, eine Beziehung optional zu machen oder eine auf `ClientCascade` zu setzen, sodass EF Core (nicht SQL Server) diesen Zweig der Kaskade mit den geladenen Kindern abwickelt. SQLite und PostgreSQL haben diese Einschränkung nicht.

## Varianten, die auf demselben Fehler landen

### Selbstreferenzierende Hierarchien (Baumtabellen)

Eine `Category` mit einer nullbaren `ParentId`, die zurück auf `Category` zeigt, trifft auf dieses Problem ständig. Das Löschen einer übergeordneten Kategorie, deren Kinder nicht geladen sind, scheitert an der FK-Prüfung. Weil SQL Server eine selbstreferenzierende Kaskade verbietet, die zyklisch sein könnte, können Sie sich hier in der Regel überhaupt nicht auf `ON DELETE CASCADE` verlassen; laden Sie den Teilbaum und lassen Sie EF Core ihn löschen, oder löschen Sie von unten nach oben mit `ExecuteDelete`.

### Many-to-many-Join-Zeilen

Mit einer Skip-Navigation (`Blog` hat viele `Tag` über eine implizite Join-Tabelle) erfordert das Löschen eines `Blog`, dass die Join-Zeilen zuerst verschwinden. EF Core erledigt dies automatisch, wenn der Blog mit seinen `Tags` geladen wird, aber ein bloßes `Remove` ohne Laden der Navigation lässt die Join-Zeilen verwaist zurück und der Löschvorgang scheitert. Laden Sie entweder die Skip-Navigation oder löschen Sie die Join-Zeilen per `ExecuteDelete`. Die Mechanik von Join-Entitäten wird in [Seeding einer Many-to-many-Beziehung in EF Core 11](/de/2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11/) behandelt.

### "Es hat mit dem In-Memory-Provider funktioniert"

Die In-Memory-Datenbank von EF Core erzwingt keine Fremdschlüssel oder Cascade Deletes, sodass ein Löschvorgang, der in einem Unit-Test "besteht", gegen eine echte SQLite- oder SQL-Server-Datenbank scheitern kann. Dies ist einer von mehreren Gründen, warum der In-Memory-Provider ein schlechter Ersatz für relationales Verhalten ist; bevorzugen Sie SQLite in-memory oder eine echte Datenbank für Tests des Löschpfads. Siehe [DbContext mocken, ohne das Change Tracking zu zerbrechen](/de/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) für Tracking-bewusste Testmuster, und beachten Sie, dass die Regeln zur Beziehungskorrektur hier mit [AsNoTracking vs AsNoTrackingWithIdentityResolution](/de/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/) interagieren: Eine No-Tracking-Abfrage lässt EF Core nicht im Arbeitsspeicher kaskadieren, weil nichts verfolgt wird, das kaskadiert werden könnte.

### Der Fehler tritt erst nach einem Upgrade auf

Wenn ein Löschvorgang, der früher funktionierte, nach dem Wechsel der Laufzeit- oder Provider-Versionen zu werfen beginnt, prüfen Sie, ob sich ein Standard-`DeleteBehavior` oder eine FK-Nullbarkeit in Ihrem Model-Snapshot geändert hat. Die Oberfläche der Breaking Changes ist in [Migration von EF Core 6 zu EF Core 11](/de/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) katalogisiert; vergleichen Sie Ihre generierten Migrationen, um zu sehen, ob sich die Cascade-Klausel verschoben hat.

### Der Löschvorgang befindet sich in einer wiederholenden Ausführungsstrategie

Wenn Sie den Löschvorgang in eine manuelle Transaktion einbetten, während Sie `EnableRetryOnFailure` verwenden, können Sie eine *andere* Ausnahme erhalten, die diese maskiert. Diese Interaktion ist ihr eigener Fehler, behandelt in [the execution strategy does not support user-initiated transactions](/de/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/).

## Den Fix bestätigen

Reproduzieren Sie den Löschvorgang gegen den echten Provider, nicht den In-Memory-Provider, und beobachten Sie das generierte SQL. Schalten Sie in der Entwicklung Sensitive Logging ein, damit die Parameterwerte und die Reihenfolge der Anweisungen sichtbar sind:

```csharp
// .NET 11, EF Core 11.0.0 -- dev only; never enable sensitive logging in production
var options = new DbContextOptionsBuilder<AppDb>()
    .UseSqlite("Data Source=app.db")
    .LogTo(Console.WriteLine, LogLevel.Information)
    .EnableSensitiveDataLogging()
    .Options;
```

Wenn der Fix funktioniert hat, sehen Sie entweder `DELETE FROM Posts ...` vor `DELETE FROM Blogs ...` (Fix 1 oder Fix 3) oder `UPDATE Posts SET BlogId = NULL ...` vor dem Blog-Löschvorgang (Fix 2). Wenn Sie weiterhin ein einsames `DELETE FROM Blogs ...` gefolgt von der Ausnahme sehen, wurden die abhängigen Zeilen weder geladen noch von der Datenbank behandelt, und Sie haben die Konfiguration auf das Modell, aber nicht auf das laufende Schema angewendet. Führen Sie `dotnet ef database update` erneut aus und überprüfen Sie `pragma_foreign_key_list` erneut.

Das mentale Modell, das man behalten sollte: Dieser Fehler ist die Datenbank, die Sie bittet, über das Schicksal der Kinder zu entscheiden, bevor Sie das übergeordnete Element löschen. Löschen Sie sie mit ihm (Cascade), behalten Sie sie und kappen Sie die Verbindung (Set Null) oder ziehen Sie sie in den Kontext, damit EF Core Zeile für Zeile entscheiden kann. Der Fehler ist nicht EF Core, das sich schwierig verhält; es ist die referenzielle Integrität, die genau ihre Aufgabe erfüllt.

## Quellen

- [Cascade Delete](https://learn.microsoft.com/en-us/ef/core/saving/cascade-delete), EF Core docs, zu `DeleteBehavior`, den Standards für erforderlich vs. optional und den Verhaltenstabellen für geladen vs. nicht geladen.
- [Relationships](https://learn.microsoft.com/en-us/ef/core/modeling/relationships), EF Core docs, dazu, wie erforderliche und optionale Beziehungen aus der FK-Nullbarkeit abgeleitet werden.
- [Microsoft.Data.Sqlite foreign keys](https://learn.microsoft.com/en-us/dotnet/standard/data/sqlite/foreign-keys), zur Erzwingung von `PRAGMA foreign_keys`.
- [SQLite result and error codes](https://www.sqlite.org/rescode.html), zu `SQLITE_CONSTRAINT_FOREIGNKEY` (erweiterter Code 787).
