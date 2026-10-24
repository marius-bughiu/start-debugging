---
title: "Wie man eine selbstreferenzierende Many-to-Many-Beziehung (Followers/Following) in EF Core konfiguriert"
description: "Followers und Following auf einer einzelnen User-Entität in EF Core 11 modellieren: was die Konvention erzeugt, warum SQL Server einen Join-Fremdschlüssel stillschweigend zu ClientCascade macht, wie man eine explizite Follow-Join-Entität mit Zeitstempel abbildet und wie man einen User ohne Fehler 547 oder 1785 löscht."
pubDate: 2026-10-24
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "dotnet-11"
  - "sql-server"
  - "relationships"
  - "how-to"
lang: "de"
translationOf: "2026/10/how-to-configure-a-self-referencing-many-to-many-relationship-in-ef-core"
translatedBy: "claude"
translationDate: 2026-10-24
---

**Kurze Antwort:** Legen Sie auf der Entität zwei Collection-Navigationen desselben Typs an, `List<User> Followers` und `List<User> Following`, und koppeln Sie sie mit `HasMany(u => u.Following).WithMany(u => u.Followers)`. EF Core bildet das auf eine Join-Tabelle mit zwei Fremdschlüsseln zurück auf `Users` ab. Für alles Ernsthafte geben Sie der Join-Tabelle über `UsingEntity<Follow>` eine eigene Klasse (`Follow` mit `FollowerId`, `FolloweeId`, `CreatedAt`) und legen das Löschverhalten selbst fest: SQL Server lehnt zwei kaskadierende Fremdschlüssel von einer Tabelle auf dieselbe Elterntabelle ab (Fehler 1785). Lassen Sie daher auf einer Seite `Cascade` und setzen Sie die andere auf `ClientCascade`, und löschen Sie User, indem Sie zuerst die Join-Zeilen mit `ExecuteDeleteAsync` entfernen. Alles Folgende wurde mit .NET 11 SDK 11.0.100-rc.2, EF Core 11 (`Microsoft.EntityFrameworkCore.SqlServer` und `.Sqlite` 11.0.0-rc.2.26504.105) und C# 14 gemessen.

Der Follower-Graph ist die klassische selbstreferenzierende Many-to-Many-Beziehung: Jeder User kann beliebig vielen Usern folgen, und jedem User können beliebig viele User folgen. Es sieht nach einer Abbildung in zwei Zeilen aus, und mit den Konventionen von EF Core ist es das fast auch. Probleme beginnen, wenn Sie eine Migration für SQL Server hinzufügen, einen User löschen wollen oder wissen möchten, *wann* jemand jemandem gefolgt ist.

## Was die Konvention für Followers und Following erzeugt

Beginnen Sie mit dem kleinsten Modell:

```csharp
// .NET 11, EF Core 11.0.0-rc.2, C# 14
public class User
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public List<User> Followers { get; } = [];
    public List<User> Following { get; } = [];
}

public class AppDb : DbContext
{
    public DbSet<User> Users => Set<User>();
}
```

Hier gibt es kein `OnModelCreating`, und EF Core erkennt trotzdem, dass `Followers` und `Following` die beiden Enden einer einzigen Many-to-Many-Beziehung sind, weil sie die einzigen zwei Collection-Navigationen auf `User` sind, die auf `User` zeigen. Das ist derselbe Mechanismus, den die offizielle Dokumentation mit `Person.Parents` und `Person.Children` zeigt. Der Aufruf von `Database.GenerateCreateScript()` mit dem SQL-Server-Provider gibt diese Join-Tabelle aus:

```sql
-- EF Core 11.0.0-rc.2, SQL Server provider, convention-only model
CREATE TABLE [UserUser] (
    [FollowersId] int NOT NULL,
    [FollowingId] int NOT NULL,
    CONSTRAINT [PK_UserUser] PRIMARY KEY ([FollowersId], [FollowingId]),
    CONSTRAINT [FK_UserUser_Users_FollowersId] FOREIGN KEY ([FollowersId]) REFERENCES [Users] ([Id]) ON DELETE CASCADE,
    CONSTRAINT [FK_UserUser_Users_FollowingId] FOREIGN KEY ([FollowingId]) REFERENCES [Users] ([Id])
);

CREATE INDEX [IX_UserUser_FollowingId] ON [UserUser] ([FollowingId]);
```

Drei Dinge in dieser Ausgabe verdienen einen genaueren Blick.

Erstens die Namen. Die Tabelle heißt `UserUser`, und die Spalten sind nach den Navigationen benannt, was verkehrt herum wirkt. Wenn Alice (Id 1) Bob (Id 2) zu `alice.Following` hinzufügt, landet in der Tabelle die Zeile `FollowersId = 1, FollowingId = 2`. `FollowersId` enthält also den Follower und `FollowingId` die Person, der gefolgt wird. Das ist korrekt, aber niemand, der die Tabelle in sechs Monaten in SSMS liest, wird das erraten.

Zweitens hat nur ein Fremdschlüssel `ON DELETE CASCADE`. Auf SQLite erzeugt dasselbe Modell Cascade auf beiden. Der Unterschied stammt von `SqlServerOnDeleteConvention`, die der SQL-Server-Provider seit EF Core 5 mitbringt ([dotnet/efcore#21959](https://github.com/dotnet/efcore/pull/21959)). Zeigen beide Fremdschlüssel einer Join-Tabelle auf dieselbe Tabelle, behält sie auf einem `Cascade` und stuft den anderen auf `DeleteBehavior.ClientCascade` herab. Welcher gewinnt, entscheidet ein ordinaler Zeichenkettenvergleich der beiden Navigationsnamen, nichts, was Sie bewusst wählen würden. Im Modell sehen Sie es:

```csharp
// .NET 11, EF Core 11.0.0-rc.2
foreach (var fk in db.Model.FindEntityType("UserUser")!.GetForeignKeys())
    Console.WriteLine($"{fk.Properties[0].Name}: {fk.DeleteBehavior}");

// SQL Server provider:  FollowersId: Cascade, FollowingId: ClientCascade
// SQLite provider:      FollowersId: Cascade, FollowingId: Cascade
```

Drittens ist die Join-Entität eine Shared-Type-Entität, die auf `Dictionary<string, object>` basiert. Es gibt keinen Platz für eine `CreatedAt`-Spalte, und die Dokumentation warnt ausdrücklich davor, sich auf diesen Dictionary-Typ zu verlassen. Wenn die Spaltenbenennung dieselbe Falle ist wie bei anderen Konventionen, erklärt der Beitrag [warum in meiner Migration eine Shadow Property auftauchte](/de/2026/10/what-is-a-shadow-property-in-ef-core-11-and-why-did-one-show-up-in-my-migration/), wie EF diese Eigenschaften erfindet.

## Warum SQL Server auf einer Seite das Kaskadieren stoppen muss

Würden beide Fremdschlüssel kaskadieren, könnte das Löschen einer Zeile in `Users` dieselbe `UserUser`-Zeile über zwei Pfade erreichen (einmal als Follower, einmal als Followee). SQL Server erlaubt das nicht und lehnt das `CREATE TABLE` mit Fehler 1785 ab: *Introducing FOREIGN KEY constraint ... may cause cycles or multiple cascade paths. Specify ON DELETE NO ACTION or ON UPDATE NO ACTION, or modify other FOREIGN KEY constraints.*

Mit dem reinen Konventionsmodell sehen Sie diesen Fehler nie, weil der Provider ihn bereits vermieden hat. Sie sehen ihn, sobald Sie die Join-Entität selbst in die Hand nehmen und die "naheliegende" Konfiguration schreiben:

```csharp
// .NET 11, EF Core 11.0.0-rc.2 -- DON'T: explicit Cascade beats the convention
.UsingEntity<Follow>(
    r => r.HasOne<User>().WithMany().HasForeignKey(f => f.FolloweeId).OnDelete(DeleteBehavior.Cascade),
    l => l.HasOne<User>().WithMany().HasForeignKey(f => f.FollowerId).OnDelete(DeleteBehavior.Cascade));
```

Explizite Konfiguration hat immer Vorrang vor einer Konvention, daher zieht sich `SqlServerOnDeleteConvention` zurück, und das erzeugte DDL enthält nun `ON DELETE CASCADE` auf beiden Constraints. `dotnet ef database update` scheitert auf SQL Server mit 1785, während dieselbe Migration auf SQLite und PostgreSQL problemlos läuft. Dieser Provider-Unterschied ist der Grund, warum der Fehler meist erst in CI oder Staging auftaucht.

Die andere Hälfte des Kompromisses ist, was `ClientCascade` zur Laufzeit bedeutet. Der Datenbank-Constraint wird zu `NO ACTION`, und EF Core verspricht, abhängige Zeilen *nur zu löschen, wenn sie getrackt werden*. Löschen Sie einen User, dessen Join-Zeilen auf der `ClientCascade`-Seite nicht geladen sind, antwortet SQL Server mit Fehler 547 (*The DELETE statement conflicted with the REFERENCE constraint*). Auf SQLite zeigt sich dieselbe Situation als `SQLite Error 19: 'FOREIGN KEY constraint failed'`. Mehr dazu im Abschnitt zum Löschen unten; die allgemeine Fassung des Problems steht in [FOREIGN KEY constraint failed beim Löschen einer Entität beheben](/de/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/).

## Eine explizite Follow-Join-Entität abbilden

Für einen Follower-Graphen möchten Sie fast immer eine explizite Join-Klasse: Sie liefert lesbare Spaltennamen, einen Platz für `CreatedAt` (oder `Muted`, `NotificationsEnabled` und so weiter) und ein `DbSet`, das Sie abfragen und per Massenlöschung bearbeiten können, ohne User zu laden. Hier die vollständige Abbildung, Schritt für Schritt:

1. Fügen Sie eine Klasse `Follow` mit `FollowerId`, `FolloweeId`, den Nutzdatenspalten und Referenznavigationen zu beiden Usern hinzu.
2. Behalten Sie die Skip-Navigationen (`Followers`, `Following`) auf `User`, damit der Alltagscode natürlich bleibt, und fügen Sie die Join-Navigationen (`FollowerLinks`, `FollowingLinks`) für die Fälle hinzu, in denen Sie die Nutzdaten brauchen.
3. Koppeln Sie die Skip-Navigationen mit `HasMany(...).WithMany(...)` und übergeben Sie `Follow` an `UsingEntity<Follow>`, wobei Sie den Fremdschlüssel jeder Seite explizit konfigurieren, damit weder Name noch Richtung der Konvention überlassen bleiben.
4. Setzen Sie `Cascade` auf einem Fremdschlüssel und `ClientCascade` auf dem anderen, mit Absicht.
5. Fügen Sie den zusammengesetzten Schlüssel, einen Index auf die zweite Schlüsselspalte, einen Standardwert für `CreatedAt` und einen Check-Constraint hinzu, der verbietet, sich selbst zu folgen.

```csharp
// .NET 11, EF Core 11.0.0-rc.2, C# 14
public class User
{
    public int Id { get; set; }
    public string Name { get; set; } = "";

    // skip navigations
    public List<User> Followers { get; } = [];
    public List<User> Following { get; } = [];

    // navigations to the join entity
    public List<Follow> FollowerLinks { get; } = [];   // rows where I am the followee
    public List<Follow> FollowingLinks { get; } = [];  // rows where I am the follower
}

public class Follow
{
    public int FollowerId { get; set; }
    public int FolloweeId { get; set; }
    public DateTime CreatedAt { get; set; }
    public User Follower { get; set; } = null!;
    public User Followee { get; set; } = null!;
}

public class AppDb(DbContextOptions<AppDb> options) : DbContext(options)
{
    public DbSet<User> Users => Set<User>();
    public DbSet<Follow> Follows => Set<Follow>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<User>()
            .HasMany(u => u.Following)
            .WithMany(u => u.Followers)
            .UsingEntity<Follow>(
                r => r.HasOne(f => f.Followee).WithMany(u => u.FollowerLinks)
                      .HasForeignKey(f => f.FolloweeId)
                      .OnDelete(DeleteBehavior.Cascade),
                l => l.HasOne(f => f.Follower).WithMany(u => u.FollowingLinks)
                      .HasForeignKey(f => f.FollowerId)
                      .OnDelete(DeleteBehavior.ClientCascade),
                j =>
                {
                    j.ToTable("Follows", t => t.HasCheckConstraint(
                        "CK_Follows_NoSelfFollow", "FollowerId <> FolloweeId"));
                    j.HasKey(f => new { f.FollowerId, f.FolloweeId });
                    j.HasIndex(f => f.FolloweeId);
                    j.Property(f => f.CreatedAt).HasDefaultValueSql("SYSUTCDATETIME()");
                });
    }
}
```

Das Lambda `r` konfiguriert die Beziehung zur *rechten* Seite von `HasMany(...).WithMany(...)`, also zur Entität, die über `Following` erreicht wird, und das ist der Followee. Das Lambda `l` ist die *linke* Seite, der User, dem `Following` gehört, also der Follower. Vertauscht man sie, kompiliert das problemlos und kehrt den gesamten Graphen stillschweigend um, daher prüfe ich die Richtung immer einmal in einem Test (siehe unten).

Das erzeugte SQL-Server-DDL:

```sql
-- EF Core 11.0.0-rc.2, SQL Server provider, explicit Follow join entity
CREATE TABLE [Follows] (
    [FollowerId] int NOT NULL,
    [FolloweeId] int NOT NULL,
    [CreatedAt] datetime2 NOT NULL DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT [PK_Follows] PRIMARY KEY ([FollowerId], [FolloweeId]),
    CONSTRAINT [CK_Follows_NoSelfFollow] CHECK (FollowerId <> FolloweeId),
    CONSTRAINT [FK_Follows_Users_FolloweeId] FOREIGN KEY ([FolloweeId]) REFERENCES [Users] ([Id]) ON DELETE CASCADE,
    CONSTRAINT [FK_Follows_Users_FollowerId] FOREIGN KEY ([FollowerId]) REFERENCES [Users] ([Id])
);

CREATE INDEX [IX_Follows_FolloweeId] ON [Follows] ([FolloweeId]);
```

Der zusammengesetzte Primärschlüssel `(FollowerId, FolloweeId)` bedient bereits die Abfragen "wem folgt X?". Der zusätzliche Index auf `FolloweeId` bedient "wer folgt X?", also die Abfrage hinter jeder Follower-Zählung, lassen Sie ihn daher nicht weg. Auf SQLite ersetzen Sie `SYSUTCDATETIME()` durch `CURRENT_TIMESTAMP`.

## Folgen, Entfolgen und die Richtung prüfen

Sie können über die Skip-Navigation oder über die Join-Entität schreiben. Über die Skip-Navigation erzeugt EF die `Follow`-Zeile für Sie, und die Datenbank füllt `CreatedAt`:

```csharp
// .NET 11, EF Core 11.0.0-rc.2
var dave = await db.Users.Include(u => u.Followers).SingleAsync(u => u.Name == "dave");
var alice = await db.Users.SingleAsync(u => u.Name == "alice");

dave.Followers.Add(alice);   // alice follows dave
await db.SaveChangesAsync();

var row = await db.Follows.SingleAsync(f => f.FollowerId == alice.Id && f.FolloweeId == dave.Id);
// row.FollowerId == alice.Id, row.FolloweeId == dave.Id, row.CreatedAt populated
```

Dieser Roundtrip ist mein Richtungstest: Kommt `FollowerId` als Daves Id zurück, sind die Lambdas `r` und `l` vertauscht.

In Request-Handlern ist es allerdings verschwendet, einen User samt kompletter Follower-Collection zu laden, nur um eine Zeile einzufügen. Gehen Sie stattdessen über die Join-Entität, die ganz ohne Laden auskommt:

```csharp
// .NET 11, EF Core 11.0.0-rc.2
db.Follows.Add(new Follow { FollowerId = currentUserId, FolloweeId = targetId });
await db.SaveChangesAsync();

// unfollow, one DELETE statement, no tracking
await db.Follows
    .Where(f => f.FollowerId == currentUserId && f.FolloweeId == targetId)
    .ExecuteDeleteAsync();
```

Beide Schutzmechanismen der Abbildung lösen als echte Datenbankfehler aus. Auf SQLite scheitert das Folgen der eigenen Person mit `CHECK constraint failed: CK_Follows_NoSelfFollow`, und doppeltes Folgen scheitert mit `UNIQUE constraint failed: Follows.FollowerId, Follows.FolloweeId`. Auf SQL Server ist Letzteres eine Primärschlüsselverletzung (Fehler 2627). Bei gleichzeitigen Doppelklicks werden Sie sie treffen, behandeln Sie sie also als "folgt bereits" statt als 500; dasselbe Muster ist für PostgreSQL in [Umgang mit einem doppelten Schlüssel bei einem nebenläufigen EF-Core-Insert](/de/2026/08/fix-23505-duplicate-key-value-violates-unique-constraint-on-a-concurrent-ef-core-insert/) beschrieben.

## Zählungen, gegenseitige Follows und Vorschläge abfragen

Skip-Navigationen werden in Joins über `Follows` übersetzt, daher laden Zählungen die Collections nie:

```csharp
// .NET 11, EF Core 11.0.0-rc.2
var profile = await db.Users
    .Where(u => u.Id == userId)
    .Select(u => new { u.Name, Followers = u.Followers.Count, Following = u.Following.Count })
    .SingleAsync();
```

```sql
-- SQL Server, from ToQueryString()
SELECT [u].[Name], (
    SELECT COUNT(*)
    FROM [Follows] AS [f]
    WHERE [u].[Id] = [f].[FolloweeId]) AS [Followers], (
    SELECT COUNT(*)
    FROM [Follows] AS [f0]
    WHERE [u].[Id] = [f0].[FollowerId]) AS [Following]
FROM [Users] AS [u]
WHERE [u].[Id] = @userId
```

"Gegenseitige Follows" (Leute, denen ich folge und die mir zurückfolgen) lesen sich mit Skip-Navigationen natürlich:

```csharp
// .NET 11, EF Core 11.0.0-rc.2
var mutual = await db.Users
    .Where(u => u.Id == userId)
    .SelectMany(u => u.Following.Where(f => f.Following.Any(x => x.Id == userId)))
    .Select(f => f.Name)
    .ToListAsync();
```

Das funktioniert, aber das erzeugte SQL verbindet `Users` dreimal, weil jeder Skip-Navigations-Schritt über die User-Tabelle läuft. Für aufwendigere Graph-Abfragen schreiben Sie direkt gegen `Follows`. Hier "Leute, denen die Leute folgen, denen ich folge, und denen ich noch nicht folge", gereiht danach, über wie viele meiner Follows man dorthin gelangt:

```csharp
// .NET 11, EF Core 11.0.0-rc.2
var suggestions = await db.Follows
    .Where(f => db.Follows.Any(a => a.FollowerId == userId && a.FolloweeId == f.FollowerId)
             && f.FolloweeId != userId
             && !db.Follows.Any(a => a.FollowerId == userId && a.FolloweeId == f.FolloweeId))
    .GroupBy(f => f.Followee.Name)
    .Select(g => new { Name = g.Key, Via = g.Count() })
    .OrderByDescending(x => x.Via)
    .ToListAsync();
```

Mit dem Beispielgraphen alice -> bob, alice -> carol, bob -> alice, carol -> dave, bob -> dave liefert die Zähl-Abfrage `{ Name = alice, Followers = 1, Following = 2 }`, die gegenseitigen Follows für Alice liefern `bob`, und die Vorschläge liefern `dave via 2`. Diese Abfrage kompiliert zu einem einzigen `SELECT ... GROUP BY` mit zwei `EXISTS`-Unterabfragen und ohne zusätzliche User-Joins. Für Follower-Listen mit Paginierung verwenden Sie das Paar `(FolloweeId, CreatedAt)` mit [Keyset-Paginierung](/de/2026/06/how-to-do-keyset-cursor-pagination-in-ef-core-11/) statt `Skip`.

## Einen User ohne Fehler 547 löschen

Hier schlägt die `ClientCascade`-Seite zu. In der obigen Abbildung verschwinden Zeilen, in denen der gelöschte User der *Followee* ist, durch die Datenbank-Kaskade. Zeilen, in denen der gelöschte User der *Follower* ist, verlassen sich auf EF Core, und EF löscht nur, was es trackt. Ich habe drei Varianten gegen SQLite mit denselben Constraints gemessen:

```csharp
// .NET 11, EF Core 11.0.0-rc.2

// 1. Join rows on the ClientCascade side NOT loaded -> fails
var bob = await db.Users.SingleAsync(u => u.Name == "bob");
db.Remove(bob);
await db.SaveChangesAsync();
// SQLite: SQLite Error 19: 'FOREIGN KEY constraint failed'
// SQL Server: error 547, DELETE conflicted with the REFERENCE constraint

// 2. Load the ClientCascade side first -> works
var carol = await db.Users.Include(u => u.FollowingLinks).SingleAsync(u => u.Name == "carol");
db.Remove(carol);
await db.SaveChangesAsync();
// EF deletes carol -> dave itself, the database cascade deletes alice -> carol
```

Option 2 ist für eine Admin-Oberfläche in Ordnung, aber alle Follow-Zeilen eines Users mit 200.000 Followings in den Change Tracker zu laden, nur um sie zu löschen, ist es nicht. Der Ansatz, den ich in Produktion nutze, überspringt das Tracking vollständig und läuft in einer Transaktion:

```csharp
// .NET 11, EF Core 11.0.0-rc.2
// 3. Bulk-delete the join rows, then the user
await using var tx = await db.Database.BeginTransactionAsync();

await db.Follows
    .Where(f => f.FollowerId == userId || f.FolloweeId == userId)
    .ExecuteDeleteAsync();

await db.Users
    .Where(u => u.Id == userId)
    .ExecuteDeleteAsync();

await tx.CommitAsync();
```

Für Bob im Beispielgraphen wurden damit drei Follow-Zeilen und ein User gelöscht, und es blieben nur Follows übrig, die ihn nie berührten. Denken Sie daran, dass `ExecuteDeleteAsync` den Change Tracker umgeht, sodass alle von diesem Context bereits getrackten `Follow`- oder `User`-Instanzen danach veraltet sind. Die Abwägungen werden ausführlicher in [ExecuteUpdate und ExecuteDelete für Massenschreibvorgänge](/de/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) behandelt.

Wenn Ihre App User stattdessen per Soft Delete entfernt, gilt nichts davon für das Löschen selbst: Die User-Zeile bleibt bestehen, ebenso die Join-Zeilen, und Sie entscheiden in Ihren Abfragen, ob ein deaktiviertes Konto noch als Follower zählt.

## Stolperfallen vor der ersten Migration

- **Der Wechsel von der Konvention zu einer expliziten Join-Entität benennt die Tabelle um.** `UserUser` mit `FollowersId`/`FollowingId` wird zu `Follows` mit `FollowerId`/`FolloweeId`. Die erzeugte Migration löscht die Tabelle und legt sie neu an, wodurch jedes Follow verloren geht. Bearbeiten Sie die Migration so, dass sie `RenameTable` und `RenameColumn` verwendet, genau wie beim [Umbenennen einer Tabelle ohne Datenverlust](/de/2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data/).
- **Eine symmetrische "Friends"-Beziehung hat eine andere Form.** Bei einer einzelnen Navigation `List<User> Friends` gibt es kein Gegenstück zum Koppeln. Die Dokumentation empfiehlt, sie unidirektional abzubilden (`HasMany(u => u.Friends).WithMany()`) und jede Person selbst in die Collection der anderen aufzunehmen, oder beide Richtungen als zwei Zeilen zu speichern.
- **Eine dritte `List<User>`-Navigation entfernt stillschweigend alle.** Fügen Sie `Blocked` neben `Followers` und `Following` hinzu, kann EF nicht mehr erkennen, welche zwei zusammengehören. In EF Core 11 RC 2 wirft es keine Ausnahme: `Model.ToDebugString()` zeigt `User` nur mit seiner `Id` und ganz ohne Beziehungen, und die Collections werden einfach nie geladen. Konfigurieren Sie jedes Paar explizit mit `HasMany(...).WithMany(...)`, sobald eine dritte Collection mit dem eigenen Typ auftaucht.
- **Das Seeden von Follows braucht die Join-Entität.** `HasData` kann keine Skip-Navigationen füllen; seeden Sie `Follow`-Zeilen mit festen Schlüsseln, wie in [Seeding einer Many-to-Many-Beziehung in EF Core 11](/de/2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11/) erklärt.
- **`Include(u => u.Followers)` auf einem beliebten Konto ist eine Falle.** Es materialisiert jeden Follower. Projizieren Sie stattdessen Zählungen oder paginieren Sie über `Follows`.

## Weiterlesen

- [How to seed a many-to-many relationship in EF Core 11](/de/2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11/)
- [Fix FOREIGN KEY constraint failed when deleting an entity in EF Core 11](/de/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/)
- [How to use ExecuteUpdate and ExecuteDelete for bulk writes in EF Core 11](/de/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/)
- [What is a shadow property in EF Core 11, and why did one show up in my migration?](/de/2026/10/what-is-a-shadow-property-in-ef-core-11-and-why-did-one-show-up-in-my-migration/)

Quellen: die EF-Core-Dokumentation zu [Many-to-Many-Beziehungen](https://learn.microsoft.com/en-us/ef/core/modeling/relationships/many-to-many) (Abschnitte zu selbstreferenzierend und symmetrisch, `UsingEntity`-Überladungen), die [Dokumentation zum kaskadierenden Löschen](https://learn.microsoft.com/en-us/ef/core/saving/cascade-delete) für die Semantik von `ClientCascade`, der [Quellcode von `SqlServerOnDeleteConvention`](https://github.com/dotnet/efcore/blob/main/src/EFCore.SqlServer/Metadata/Conventions/SqlServerOnDeleteConvention.cs) und der PR, der sie eingeführt hat, [dotnet/efcore#21959](https://github.com/dotnet/efcore/pull/21959), sowie die SQL-Server-Dokumentation zu [kaskadierender referenzieller Integrität](https://learn.microsoft.com/en-us/sql/relational-databases/tables/primary-and-foreign-key-constraints).
