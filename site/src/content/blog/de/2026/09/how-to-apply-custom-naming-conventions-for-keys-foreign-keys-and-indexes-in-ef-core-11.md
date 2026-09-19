---
title: "Eigene Namenskonventionen für Primärschlüssel, Fremdschlüssel und Indizes in EF Core 11 Migrationen anwenden"
description: "Benennen Sie jedes PK_, FK_, AK_ und IX_, das EF Core 11 erzeugt, mit einer einzigen IModelFinalizingConvention um, lassen Sie explizite Namen weiterhin gewinnen, bleiben Sie unter der Längengrenze für Bezeichner und vermeiden Sie den Neuaufbau des Clustered Index, den die nächste Migration auf einer bestehenden Datenbank erzeugt."
pubDate: 2026-09-19
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "migrations"
  - "sql-server"
  - "dotnet-11"
  - "how-to"
lang: "de"
translationOf: "2026/09/how-to-apply-custom-naming-conventions-for-keys-foreign-keys-and-indexes-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-09-19
---

Kurz gesagt: Schreiben Sie eine Klasse, die `IModelFinalizingConvention` implementiert, durchlaufen Sie die deklarierten Schlüssel, Fremdschlüssel und Indizes jedes Entitätstyps und setzen Sie die Namen über die Convention-Builder (`key.Builder.HasName(...)`, `fk.Builder.HasConstraintName(...)`, `index.Builder.HasDatabaseName(...)`). Registriert wird sie in `ConfigureConventions` mit `configurationBuilder.Conventions.Add(_ => new ConstraintNamingConvention())`. Da die Builder den Namen mit der Quelle `Convention` erfassen, gewinnt jeder Name, den Sie explizit über die Fluent API oder `[Index(Name = ...)]` setzen, weiterhin. Bei einer neuen Datenbank ist damit alles erledigt. Bei einer bestehenden löscht die nächste Migration jeden Primärschlüssel und Fremdschlüssel und legt ihn neu an, nur um ihn umzubenennen. Diese Migration sollten Sie deshalb von Hand in Umbenennungen umschreiben.

Alles in diesem Beitrag lief auf dem .NET 11 RC 1 SDK (`11.0.100-rc.1.26425.128`) mit `Microsoft.EntityFrameworkCore.SqlServer` `11.0.0-rc.1.26425.128`. Die gezeigte DDL und das Migrations-SQL sind die echte Ausgabe von `Database.GenerateCreateScript()` und `IMigrationsSqlGenerator` für ein SQL-Server-Modell. Ein Datenbankserver war nicht beteiligt, daher gibt es hier keine Zeitmessungen, nur das SQL, das EF Core senden würde.

## Die Namen, die EF Core 11 standardmäßig wählt

Ausgangspunkt ist ein kleines Modell: ein `Blog` mit einem eindeutigen Alternativschlüssel `Slug`, ein `Post`, der auf `Blog` und optional auf `Author` verweist, ein eindeutiger Index auf `Author.Email`, ein zusammengesetzter Index auf `Post` und eine Many-to-many-Beziehung mit Skip Navigation zwischen `Post` und `Tag`.

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
public class Blog
{
    public int Id { get; set; }
    public string Slug { get; set; } = "";
    public List<Post> Posts { get; } = [];
}

public class Post
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int BlogId { get; set; }
    public Blog Blog { get; set; } = null!;
    public int? AuthorId { get; set; }
    public Author? Author { get; set; }
    public List<Tag> Tags { get; } = [];
}

public class Author { public int Id { get; set; } public string Email { get; set; } = ""; }
public class Tag { public int Id { get; set; } public string Name { get; set; } = ""; public List<Post> Posts { get; } = []; }

public class AppDb : DbContext
{
    public DbSet<Blog> Blogs => Set<Blog>();
    public DbSet<Post> Posts => Set<Post>();
    public DbSet<Author> Authors => Set<Author>();
    public DbSet<Tag> Tags => Set<Tag>();

    protected override void OnModelCreating(ModelBuilder mb)
    {
        mb.Entity<Blog>().HasAlternateKey(b => b.Slug);
        mb.Entity<Author>().HasIndex(a => a.Email).IsUnique();
        mb.Entity<Post>().HasIndex(p => new { p.BlogId, p.Title });
    }
}
```

Die erzeugte SQL-Server-DDL verwendet vier Muster:

```sql
-- EF Core 11.0.0-rc.1, SQL Server provider, default names
CONSTRAINT [PK_Blogs] PRIMARY KEY ([Id]),
CONSTRAINT [AK_Blogs_Slug] UNIQUE ([Slug])
CONSTRAINT [FK_Posts_Blogs_BlogId] FOREIGN KEY ([BlogId]) REFERENCES [Blogs] ([Id]) ON DELETE CASCADE
CONSTRAINT [FK_PostTag_Tags_TagsId] FOREIGN KEY ([TagsId]) REFERENCES [Tags] ([Id]) ON DELETE CASCADE
CREATE UNIQUE INDEX [IX_Authors_Email] ON [Authors] ([Email]);
CREATE INDEX [IX_Posts_BlogId_Title] ON [Posts] ([BlogId], [Title]);
```

Die Standardwerte sind also `PK_{table}`, `AK_{table}_{columns}`, `FK_{dependent table}_{principal table}_{columns}` und `IX_{table}_{columns}`, wobei ein eindeutiger Index dasselbe Präfix `IX_` erhält wie ein nicht eindeutiger. Beachten Sie, dass das Muster den *Tabellennamen* verwendet (`Blogs`, aus dem `DbSet`), nicht den Namen des CLR-Typs. Teile der Microsoft-Learn-Dokumentation beschreiben den Standard für Primärschlüssel als `PK_<type name>`, was nur stimmt, wenn beide zufällig übereinstimmen.

Teams wollen das meist aus einem von drei Gründen ändern: ein DBA-Standard (`pk_`, `fk_`, `ux_` für eindeutige Indizes), eine PostgreSQL-Datenbank, in der alles andere kleingeschrieben ist, oder ein bestehendes Schema, das ein anderes Werkzeug angelegt hat und dessen Namen EF Core übernehmen soll, statt gegen sie anzukämpfen.

## Einzelne Namen: HasName, HasConstraintName, HasDatabaseName

Wenn nur eine Handvoll Objekte einen bestimmten Namen braucht, bietet die Fluent API eine Methode pro Objekttyp:

```csharp
// .NET 11, EF Core 11 - per-object names
mb.Entity<Blog>().HasKey(b => b.Id).HasName("pk_blog");
mb.Entity<Blog>().HasAlternateKey(b => b.Slug).HasName("ak_blog_slug");

mb.Entity<Post>()
    .HasOne(p => p.Blog).WithMany(b => b.Posts)
    .HasForeignKey(p => p.BlogId)
    .HasConstraintName("fk_post_blog");

mb.Entity<Author>().HasIndex(a => a.Email).IsUnique().HasDatabaseName("ux_author_email");
```

Für Indizes gibt es zusätzlich die Attributform `[Index(nameof(Email), IsUnique = true, Name = "ux_author_email")]`. Der `Name` des Attributs wird zum Datenbanknamen.

Das skaliert nicht. Jede neue Entität braucht dieselben drei Aufrufe, die Join-Tabelle einer Skip Navigation vergisst man leicht, und an dem Tag, an dem jemand einen Index ohne den Aufruf hinzufügt, sind Sie wieder bei `IX_`. Genau dafür gibt es Konventionen.

## Eine Model Finalizing Convention, die alles benennt

Die EF-Core-Dokumentation zur [Massenkonfiguration des Modells](https://learn.microsoft.com/en-us/ef/core/modeling/bulk-configuration) beschreibt zwei Arten eigener Konventionen. Interaktive reagieren auf jede Modelländerung in dem Moment, in dem sie passiert. *Model Finalizing* Conventions laufen einmal, nachdem `OnModelCreating` und alle eingebauten Konventionen fertig sind, und sehen das nahezu fertige Modell. Constraint-Namen hängen von Tabellen- und Spaltennamen ab, die sich bis zum Ende des Modellaufbaus noch ändern können, daher ist eine Finalizing Convention der richtige Einstiegspunkt. Wer früher läuft, benennt womöglich einen Index nach einer Spalte, die ein späteres `HasColumnName` umbenennt.

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Microsoft.EntityFrameworkCore.Metadata.Conventions;

public sealed class ConstraintNamingConvention : IModelFinalizingConvention
{
    public void ProcessModelFinalizing(
        IConventionModelBuilder modelBuilder,
        IConventionContext<IConventionModelBuilder> context)
    {
        var maxLength = modelBuilder.Metadata.GetMaxIdentifierLength();

        foreach (var entityType in modelBuilder.Metadata.GetEntityTypes())
        {
            var table = entityType.GetTableName();
            if (table is null) continue; // views, keyless query types, TPC abstract roots
            var store = StoreObjectIdentifier.Table(table, entityType.GetSchema());

            foreach (var key in entityType.GetDeclaredKeys())
            {
                var name = key.IsPrimaryKey()
                    ? $"pk_{table}"
                    : $"ak_{table}_{Columns(key.Properties, store)}";
                key.Builder.HasName(Truncate(name, maxLength));
            }

            foreach (var fk in entityType.GetDeclaredForeignKeys())
            {
                var principalTable = fk.PrincipalEntityType.GetTableName();
                if (principalTable is null) continue;
                var name = $"fk_{table}_{principalTable}_{Columns(fk.Properties, store)}";
                fk.Builder.HasConstraintName(Truncate(name, maxLength));
            }

            foreach (var index in entityType.GetDeclaredIndexes())
            {
                var prefix = index.IsUnique ? "ux" : "ix";
                var name = $"{prefix}_{table}_{Columns(index.Properties, store)}";
                index.Builder.HasDatabaseName(Truncate(name, maxLength));
            }
        }
    }

    static string Columns(IEnumerable<IConventionPropertyBase> props, StoreObjectIdentifier store)
        => string.Join("_", props.Select(p =>
            (p as IConventionProperty)?.GetColumnName(store) ?? p.Name));

    static string Truncate(string name, int maxLength)
    {
        if (name.Length <= maxLength) return name;
        // keep names unique after truncation: prefix + 8 hex chars of a stable hash
        var hash = Convert.ToHexString(
            System.Security.Cryptography.SHA256.HashData(
                System.Text.Encoding.UTF8.GetBytes(name)))[..8].ToLowerInvariant();
        return $"{name[..(maxLength - 9)]}_{hash}";
    }
}
```

Registrieren Sie sie auf dem Kontext:

```csharp
// .NET 11, EF Core 11
protected override void ConfigureConventions(ModelConfigurationBuilder configurationBuilder)
    => configurationBuilder.Conventions.Add(_ => new ConstraintNamingConvention());
```

`Conventions.Add` nimmt eine Factory statt einer Instanz entgegen, damit eine Konvention Dienste aus dem internen Service Provider von EF Core beziehen kann. Diese hier hat keine Abhängigkeiten, daher der verworfene Parameter `_`.

Dasselbe Modell erzeugt jetzt:

```sql
-- EF Core 11.0.0-rc.1, SQL Server provider, with ConstraintNamingConvention
CONSTRAINT [pk_Blogs] PRIMARY KEY ([Id]),
CONSTRAINT [ak_Blogs_Slug] UNIQUE ([Slug])
CONSTRAINT [fk_Posts_Blogs_BlogId] FOREIGN KEY ([BlogId]) REFERENCES [Blogs] ([Id]) ON DELETE CASCADE
CONSTRAINT [pk_PostTag] PRIMARY KEY ([PostsId], [TagsId]),
CONSTRAINT [fk_PostTag_Tags_TagsId] FOREIGN KEY ([TagsId]) REFERENCES [Tags] ([Id]) ON DELETE CASCADE
CREATE INDEX [ix_Posts_BlogId_Title] ON [Posts] ([BlogId], [Title]);
CREATE INDEX [ix_PostTag_TagsId] ON [PostTag] ([TagsId]);
```

Die implizite Join-Tabelle `PostTag` ist ohne zusätzlichen Code abgedeckt, weil sie ein echter (Shared-Type-)Entitätstyp im Modell ist und `GetEntityTypes()` sie zurückgibt.

Einige Details in diesem Code sind bewusst so gewählt.

**Verwenden Sie die Convention-Builder, nicht die Setter.** `key.Builder.HasName(...)` setzt den Namen mit `ConfigurationSource.Convention`. EF Core verfolgt, woher jedes Stück Konfiguration stammt, und ein aus einer Konvention stammender Wert überschreibt nie einen Wert aus `DataAnnotation` oder `Explicit`. Im Repro habe ich den eindeutigen Index in `OnModelCreating` explizit mit `.HasDatabaseName("UX_Authors_Email_Legacy")` benannt gelassen, und die Ausgabe enthält weiterhin `CREATE UNIQUE INDEX [UX_Authors_Email_Legacy]`, während alle anderen Indizes die `ix_`/`ux_`-Behandlung bekamen. Rufen Sie stattdessen die veränderlichen Setter (`IMutableKey.SetName`) in einer Schleife am Ende von `OnModelCreating` auf, verlieren Sie diese Rangfolge und überschreiben stillschweigend Namen, die ein Kollege absichtlich gesetzt hat.

**Verwenden Sie den Spaltennamen für das Store-Objekt, nicht den Eigenschaftsnamen.** `GetColumnName(StoreObjectIdentifier)` liefert, was tatsächlich in der Tabelle steht, einschließlich `HasColumnName`-Überschreibungen und Präfixen von Owned Types wie `Where_City`. Einen Index nach der CLR-Eigenschaft zu benennen, ergibt Namen, die nicht zu den abgedeckten Spalten passen.

**`Properties` ist in EF Core 11 `IConventionPropertyBase`.** In EF Core 11 RC 1 ist `IConventionKey.Properties` als `IReadOnlyList<IConventionPropertyBase>` typisiert, sodass ein Helfer, der als `IEnumerable<IConventionProperty>` deklariert ist, mit CS1503 nicht kompiliert. Der Cast in `Columns` fängt das ab und greift für alles, was keine einfache skalare Eigenschaft ist, auf den Membernamen zurück.

## Die Einführung: neue Datenbank vs. bestehende Datenbank

Die Namenskonvention ändert das Modell, also sieht `dotnet ef migrations add` einen Diff. Was dieser Diff enthält, ist der Teil, der wehtut.

1. **Neues Projekt oder noch keine bereitgestellte Datenbank.** Fügen Sie die Konvention vor der ersten Migration hinzu. `InitialCreate` enthält die neuen Namen, und sonst ist nichts zu tun.
2. **Bestehende Datenbank, kleine Tabellen.** Erzeugen Sie die Migration, lesen Sie sie und wenden Sie sie an. EF Core baut die Schlüssel neu auf, was bei kleinen Tabellen in Ordnung ist.
3. **Bestehende Datenbank, große Tabellen.** Erzeugen Sie die Migration und ersetzen Sie die Drop/Add-Paare durch Umbenennungen, bevor jemand sie anwendet.

Um genau zu sehen, worum es in Schritt 3 geht, habe ich das Modell mit Standardnamen gegen das Modell mit Konventionsnamen per `IMigrationsModelDiffer` verglichen, also mit derselben Komponente, die `migrations add` verwendet. Indizes kommen als günstige Umbenennungen heraus:

```sql
-- EF Core 11.0.0-rc.1: RenameIndexOperation on SQL Server
EXEC sp_rename N'[Posts].[IX_Posts_BlogId_Title]', N'ix_Posts_BlogId_Title', 'INDEX';
EXEC sp_rename N'[PostTag].[IX_PostTag_TagsId]', N'ix_PostTag_TagsId', 'INDEX';
```

Primärschlüssel, Alternativschlüssel und Fremdschlüssel nicht. Es gibt keine Migrationsoperation `RenamePrimaryKey` oder `RenameForeignKey`, also erzeugt der Differ für jeden einen Drop und ein Add, 24 Operationen für dieses Modell mit fünf Tabellen:

```sql
-- EF Core 11.0.0-rc.1: what the scaffolded migration does to keys
ALTER TABLE [Posts] DROP CONSTRAINT [FK_Posts_Blogs_BlogId];
ALTER TABLE [Posts] DROP CONSTRAINT [PK_Posts];
ALTER TABLE [Blogs] DROP CONSTRAINT [AK_Blogs_Slug];
ALTER TABLE [Blogs] DROP CONSTRAINT [PK_Blogs];
-- ...
ALTER TABLE [Posts] ADD CONSTRAINT [pk_Posts] PRIMARY KEY ([Id]);
ALTER TABLE [Blogs] ADD CONSTRAINT [ak_Blogs_Slug] UNIQUE ([Slug]);
ALTER TABLE [Blogs] ADD CONSTRAINT [pk_Blogs] PRIMARY KEY ([Id]);
ALTER TABLE [Posts] ADD CONSTRAINT [fk_Posts_Blogs_BlogId] FOREIGN KEY ([BlogId]) REFERENCES [Blogs] ([Id]) ON DELETE CASCADE;
```

Auf SQL Server ist der Primärschlüssel standardmäßig der Clustered Index. Ihn zu löschen, macht die Tabelle zum Heap und schreibt jeden Nonclustered Index neu; ihn wieder hinzuzufügen, sortiert die Tabelle und schreibt sie erneut, danach werden die Nonclustered Indizes ein zweites Mal neu geschrieben. Das erneute Hinzufügen jedes Fremdschlüssels validiert jede vorhandene Zeile. Bei einer Tabelle mit zig Millionen Zeilen ist das eine lange, logintensive Operation innerhalb der Migrationstransaktion, nur um die Groß- und Kleinschreibung eines Präfixes zu ändern. Dasselbe Drop-und-Add-Muster taucht auf, wenn Sie [eine Tabelle in einer EF Core 11 Migration umbenennen](/de/2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data/), und die Lösung ist dieselbe: die Constraints an Ort und Stelle umbenennen.

Ersetzen Sie auf SQL Server die erzeugten Aufrufe `DropForeignKey`/`DropPrimaryKey`/`DropUniqueConstraint` und die passenden `Add*`-Aufrufe in `Up` durch `sp_rename`, das einen Constraint als reine Metadatenänderung umbenennt. Wird ein Primärschlüssel oder Unique Constraint mit `sp_rename` umbenannt, wird auch der zugehörige Index umbenannt.

```csharp
// .NET 11, EF Core 11 - hand-edited Up() for SQL Server
protected override void Up(MigrationBuilder migrationBuilder)
{
    migrationBuilder.Sql("EXEC sp_rename N'[dbo].[PK_Blogs]', N'pk_Blogs', 'OBJECT';");
    migrationBuilder.Sql("EXEC sp_rename N'[dbo].[AK_Blogs_Slug]', N'ak_Blogs_Slug', 'OBJECT';");
    migrationBuilder.Sql("EXEC sp_rename N'[dbo].[PK_Posts]', N'pk_Posts', 'OBJECT';");
    migrationBuilder.Sql("EXEC sp_rename N'[dbo].[FK_Posts_Blogs_BlogId]', N'fk_Posts_Blogs_BlogId', 'OBJECT';");
    // ...one line per key and foreign key

    // the scaffolded index renames are already fine, keep them
    migrationBuilder.RenameIndex(
        name: "IX_Posts_BlogId_Title", table: "Posts", newName: "ix_Posts_BlogId_Title");
}
```

Auf PostgreSQL ist das Gegenstück `ALTER TABLE "Posts" RENAME CONSTRAINT "PK_Posts" TO "pk_Posts";`, das ebenfalls den Index hinter einem Primärschlüssel oder Unique Constraint umbenennt. Npgsql erzeugt für einfache Indizes bereits `ALTER INDEX ... RENAME TO`.

Schreiben Sie die umgekehrten `sp_rename`-Aufrufe auch in `Down`. Das erzeugte `Down` enthält weiterhin Drop/Add-Paare, und wenn Sie es so lassen, führt ein Rollback genau den Neuaufbau durch, den Sie gerade vermieden haben. Der Modell-Snapshot ist von dieser Handbearbeitung nicht betroffen: Er speichert die neuen Namen so oder so, daher erzeugt das nächste `migrations add` einen leeren Diff. Falls nicht, haben Sie einen Constraint übersehen, und die Prüfung beim Start meldet das mit [der Ausnahme wegen ausstehender Modelländerungen](/de/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/). Wenden Sie die bearbeitete Migration über ein geprüftes Skript oder ein [Migrations Bundle](/de/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) an, nicht über `Database.Migrate()` beim Start der App.

## Stolperfallen: geteilte Tabellen, Längengrenzen und das snake_case-Paket

**Benennen Sie nach der Tabelle, nie nach dem Entitätstyp.** Ein Owned Type, der in der Tabelle seines Besitzers gespeichert wird, Table Splitting und TPH legen jeweils mehrere Entitätstypen in eine Tabelle, und jeder davon hat eigene Primärschlüssel-Metadaten. Sie müssen sich auf den Constraint-Namen einigen. Im Repro habe ich das Muster für den Primärschlüssel auf `pk_{entityType.ClrType.Name}` umgestellt, bei einem Modell mit einem Owned Type `Address` innerhalb von `Media`, und die Modellvalidierung schlug sofort fehl:

```text
InvalidOperationException: The table 'Media' cannot be used for entity type 'Media' since it is being used
for entity type 'Address' and the name 'pk_Media' of the primary key {'Id'} does not match the name
'pk_Address' of the primary key {'MediaId'}.
```

Den Namen aus `GetTableName()` abzuleiten, umgeht das, weil jeder Entitätstyp in der geteilten Tabelle auf dieselbe Tabelle auflöst. Dasselbe Repro mit `pk_{table}` erzeugte einen einzigen Constraint `pk_Media`, und die TPH-Fremdschlüssel, die auf den abgeleiteten Typen `Photo` und `Clip` deklariert sind, kamen als `fk_Media_Author_PhotographerId` und `fk_Media_Author_EditorId` auf der geteilten Tabelle heraus. Der [Leitfaden zum TPH-Mapping](/de/2026/07/how-to-configure-table-per-hierarchy-tph-inheritance-mapping-in-ef-core-11/) erklärt, warum Spalten abgeleiteter Typen dort nullbar werden.

**Beachten Sie die Längengrenze für Bezeichner und halten Sie gekürzte Namen eindeutig.** `IConventionModel.GetMaxIdentifierLength()` liefert die Grenze des Providers: 128 auf SQL Server und 32767 auf SQLite in meinem Repro. PostgreSQL kürzt Bezeichner bei 63 Bytes. Ein zusammengesetzter Index über lange Spaltennamen überschreitet 63 leicht, und wenn Sie den String einfach abschneiden, fallen zwei Indizes, die sich nur am Ende unterscheiden, auf denselben Namen zusammen. EF Core scheitert dann an der Validierung, weil zwei Indizes auf einer Tabelle mit unterschiedlichen Spalten auf denselben Namen abgebildet werden. Der Helfer `Truncate` behält ein Präfix und hängt acht Hex-Zeichen eines SHA-256 des vollständigen Namens an. Mit einer Grenze von 40 Zeichen wurden `ix_customer_order_line_items_warehouse_location_id_created_at` und `..._updated_at` zu `ix_customer_order_line_items_wa_0e2c7d55` und `ix_customer_order_line_items_wa_a5c1910c`. Verwenden Sie einen stabilen Hash, nie `string.GetHashCode()`, das in .NET pro Prozess zufällig ist und bei jedem Build einen anderen Namen und damit eine neue Migration erzeugen würde.

**Finalizing Conventions laufen in der Reihenfolge, in der Sie sie hinzufügen.** Wenn Sie zusätzlich eine Konvention haben, die Tabellen oder Spalten umbenennt (zum Beispiel in snake_case), fügen Sie diese in `ConfigureConventions` *vor* der Konvention für Constraint-Namen hinzu. Sonst werden die Constraint-Namen aus den alten Tabellennamen berechnet.

**`EFCore.NamingConventions` ist noch kein EF Core 11 Paket.** Das beliebte Community-Paket, das alles in snake_case umwandelt, einschließlich Schlüssel- und Indexnamen, steht heute bei 10.0.1, und seine nuspec fixiert `Microsoft.EntityFrameworkCore.Relational` auf `[10.0.1, 11.0.0)`. Wer es neben EF Core 11 referenziert, bekommt die NuGet-Warnung NU1608 "outside of dependency constraint" und ein Paket, das nie gegen die Metadaten-API von 11.0 getestet wurde, die sich, wie die Änderung bei `IConventionPropertyBase` zeigt, sehr wohl bewegt hat. Eine 60-zeilige Konvention, die Ihnen selbst gehört, hat dieses Problem nicht.

**Per Scaffolding erzeugte (Database-First-)Modelle ignorieren all das.** `dotnet ef dbcontext scaffold` liest die echten Namen aus der Datenbank und schreibt explizite `HasName`/`HasDatabaseName`-Aufrufe, und explizit schlägt Konvention. Das ist das richtige Verhalten, aber erwarten Sie nicht, dass die Konvention ein per Reverse Engineering erzeugtes Modell "repariert".

**Prüfen Sie das Ergebnis, nicht den Code.** `Database.GenerateCreateScript()` auf einem Kontext mit einem Dummy-Connection-String gibt die vollständige DDL aus, ohne einen Server zu berühren, und `dotnet ef migrations script` zeigt, was eine ausstehende Migration ausführen wird. Beides ist schneller, als den Modell-Snapshot zu lesen. Für die Laufzeitseite zeigt [das Protokollieren des SQL, das EF Core 11 erzeugt](/de/2026/07/how-to-log-the-sql-that-ef-core-11-generates/), die Constraint-Namen in jeder `DbUpdateException`, die sich auf sie bezieht.

## Verwandte Beiträge

- [Eine Tabelle in einer EF Core 11 Migration umbenennen, ohne Daten zu verlieren](/de/2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data/)
- [Fix: Das Modell für den Kontext 'X' hat ausstehende Änderungen in EF Core 11](/de/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/)
- [EF Core 11 Migrationen in Produktion mit Migrations Bundles anwenden](/de/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)
- [Table-per-Hierarchy (TPH) Vererbungsmapping in EF Core 11 konfigurieren](/de/2026/07/how-to-configure-table-per-hierarchy-tph-inheritance-mapping-in-ef-core-11/)
- [Complex Types vs. Owned Entities in EF Core 11](/de/2026/07/complex-types-vs-owned-entities-in-ef-core-11/)

## Quellen

- [Model bulk configuration](https://learn.microsoft.com/en-us/ef/core/modeling/bulk-configuration) auf Microsoft Learn: `ConfigureConventions`, `IModelFinalizingConvention`, Konfigurationsquellen und Convention-Builder
- [Keys](https://learn.microsoft.com/en-us/ef/core/modeling/keys) und [Indexes and constraints](https://learn.microsoft.com/en-us/ef/core/modeling/indexes) auf Microsoft Learn zu `HasName` und `HasDatabaseName`
- [sys.sp_rename](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-rename-transact-sql) zum Umbenennen von Constraints an Ort und Stelle auf SQL Server
- [ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html) (`RENAME CONSTRAINT`) und [Länge von Bezeichnern](https://www.postgresql.org/docs/current/sql-syntax-lexical.html#SQL-SYNTAX-IDENTIFIERS) in der PostgreSQL-Dokumentation
- [EFCore.NamingConventions auf NuGet](https://www.nuget.org/packages/EFCore.NamingConventions), Abhängigkeitsbereiche der Version 10.0.1
