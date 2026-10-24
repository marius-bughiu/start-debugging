---
title: "How to Configure a Self-Referencing Many-to-Many Relationship (Followers/Following) in EF Core"
description: "Model followers and following on a single User entity in EF Core 11: what the convention builds, why SQL Server quietly turns one join foreign key into ClientCascade, how to map an explicit Follow join entity with a timestamp, and how to delete a user without error 547 or 1785."
pubDate: 2026-10-24
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "dotnet-11"
  - "sql-server"
  - "relationships"
  - "how-to"
---

**Short answer:** put two collection navigations of the same type on the entity, `List<User> Followers` and `List<User> Following`, and pair them with `HasMany(u => u.Following).WithMany(u => u.Followers)`. EF Core maps that to one join table with two foreign keys back to `Users`. For anything real, give the join table its own class (`Follow` with `FollowerId`, `FolloweeId`, `CreatedAt`) through `UsingEntity<Follow>`, and decide the delete behaviour yourself: SQL Server refuses two cascading foreign keys from one table to the same parent (error 1785), so leave `Cascade` on one side and set the other to `ClientCascade`, then delete users with `ExecuteDeleteAsync` on the join rows first. Everything below was measured with .NET 11 SDK 11.0.100-rc.2, EF Core 11 (`Microsoft.EntityFrameworkCore.SqlServer` and `.Sqlite` 11.0.0-rc.2.26504.105) and C# 14.

The follower graph is the textbook self-referencing many-to-many: any user can follow any number of users, and any user can be followed by any number of users. It looks like a two-line mapping, and with EF Core's conventions it almost is. The trouble starts when you add a migration for SQL Server, try to delete a user, or want to know *when* someone followed someone.

## What the convention builds for Followers and Following

Start with the smallest model:

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

There is no `OnModelCreating` here, and EF Core still figures out that `Followers` and `Following` are the two ends of a single many-to-many relationship, because they are the only two collection navigations on `User` that point at `User`. This is the same mechanism the official docs show with `Person.Parents` and `Person.Children`. Calling `Database.GenerateCreateScript()` with the SQL Server provider prints this join table:

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

Three things in that output are worth slowing down for.

First, the names. The table is `UserUser` and the columns are named after the navigations, which reads backwards. When Alice (Id 1) adds Bob (Id 2) to `alice.Following`, the row that lands in the table is `FollowersId = 1, FollowingId = 2`. So `FollowersId` holds the follower and `FollowingId` holds the person being followed. That is correct, but nobody reading the table in SSMS six months from now will guess it.

Second, only one foreign key has `ON DELETE CASCADE`. On SQLite the same model produces cascade on both. The difference comes from `SqlServerOnDeleteConvention`, which the SQL Server provider has carried since EF Core 5 ([dotnet/efcore#21959](https://github.com/dotnet/efcore/pull/21959)). When both foreign keys of a join table point at the same table, it keeps `Cascade` on one and downgrades the other to `DeleteBehavior.ClientCascade`. Which one wins is decided by an ordinal string comparison of the two navigation names, not by anything you would choose on purpose. You can see it in the model:

```csharp
// .NET 11, EF Core 11.0.0-rc.2
foreach (var fk in db.Model.FindEntityType("UserUser")!.GetForeignKeys())
    Console.WriteLine($"{fk.Properties[0].Name}: {fk.DeleteBehavior}");

// SQL Server provider:  FollowersId: Cascade, FollowingId: ClientCascade
// SQLite provider:      FollowersId: Cascade, FollowingId: Cascade
```

Third, the join entity is a shared-type entity backed by `Dictionary<string, object>`. There is nowhere to put a `CreatedAt` column, and the docs explicitly warn not to depend on that dictionary type. If the column naming is the same trap you hit with other conventions, the post on [why a shadow property showed up in my migration](/2026/10/what-is-a-shadow-property-in-ef-core-11-and-why-did-one-show-up-in-my-migration/) covers how EF invents these properties.

## Why SQL Server needs one side to stop cascading

If both foreign keys cascaded, deleting one row in `Users` could reach the same `UserUser` row through two paths (once as the follower, once as the followee). SQL Server does not allow that, and rejects the `CREATE TABLE` with error 1785: *Introducing FOREIGN KEY constraint ... may cause cycles or multiple cascade paths. Specify ON DELETE NO ACTION or ON UPDATE NO ACTION, or modify other FOREIGN KEY constraints.*

With the convention-only model you never see this error, because the provider already avoided it. You see it as soon as you take control of the join entity and write the "obvious" configuration:

```csharp
// .NET 11, EF Core 11.0.0-rc.2 -- DON'T: explicit Cascade beats the convention
.UsingEntity<Follow>(
    r => r.HasOne<User>().WithMany().HasForeignKey(f => f.FolloweeId).OnDelete(DeleteBehavior.Cascade),
    l => l.HasOne<User>().WithMany().HasForeignKey(f => f.FollowerId).OnDelete(DeleteBehavior.Cascade));
```

Explicit configuration always outranks a convention, so `SqlServerOnDeleteConvention` backs off and the generated DDL now has `ON DELETE CASCADE` on both constraints. `dotnet ef database update` fails on SQL Server with 1785, while the same migration runs fine on SQLite and PostgreSQL. That provider difference is why the bug tends to show up only in CI or staging.

The other half of the trade-off is what `ClientCascade` means at runtime. The database constraint becomes `NO ACTION`, and EF Core promises to delete dependent rows *only if they are tracked*. Delete a user whose join rows on the `ClientCascade` side are not loaded and SQL Server answers with error 547 (*The DELETE statement conflicted with the REFERENCE constraint*). On SQLite the same situation shows up as `SQLite Error 19: 'FOREIGN KEY constraint failed'`. More on that in the delete section below, and the general version of the problem is in [fixing FOREIGN KEY constraint failed when deleting an entity](/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/).

## Map an explicit Follow join entity

For a follower graph you nearly always want an explicit join class: it gives you readable column names, a place for `CreatedAt` (or `Muted`, `NotificationsEnabled`, and so on), and a `DbSet` you can query and bulk-delete without loading users. Here is the full mapping, step by step:

1. Add a `Follow` class with `FollowerId`, `FolloweeId`, the payload columns, and reference navigations to both users.
2. Keep the skip navigations (`Followers`, `Following`) on `User` so everyday code stays natural, and add the join navigations (`FollowerLinks`, `FollowingLinks`) for when you need the payload.
3. Pair the skip navigations with `HasMany(...).WithMany(...)` and pass `Follow` to `UsingEntity<Follow>`, configuring each side's foreign key explicitly so neither name nor direction is left to convention.
4. Set `Cascade` on one foreign key and `ClientCascade` on the other, on purpose.
5. Add the composite key, an index on the second key column, a default for `CreatedAt`, and a check constraint that forbids following yourself.

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

The `r` lambda configures the relationship to the *right* side of `HasMany(...).WithMany(...)`, which is the entity reached through `Following`, so that is the followee. The `l` lambda is the *left* side, the user who owns `Following`, so that is the follower. Getting these swapped compiles fine and silently inverts your whole graph, so I always assert the direction once in a test (shown below).

The SQL Server DDL this produces:

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

The composite primary key `(FollowerId, FolloweeId)` already serves "who does X follow?" lookups. The extra index on `FolloweeId` serves "who follows X?", which is the query behind every follower count, so do not drop it. On SQLite, swap `SYSUTCDATETIME()` for `CURRENT_TIMESTAMP`.

## Following, unfollowing and checking direction

You can write through either the skip navigation or the join entity. Through the skip navigation, EF creates the `Follow` row for you and the database fills in `CreatedAt`:

```csharp
// .NET 11, EF Core 11.0.0-rc.2
var dave = await db.Users.Include(u => u.Followers).SingleAsync(u => u.Name == "dave");
var alice = await db.Users.SingleAsync(u => u.Name == "alice");

dave.Followers.Add(alice);   // alice follows dave
await db.SaveChangesAsync();

var row = await db.Follows.SingleAsync(f => f.FollowerId == alice.Id && f.FolloweeId == dave.Id);
// row.FollowerId == alice.Id, row.FolloweeId == dave.Id, row.CreatedAt populated
```

That round trip is my direction test: if `FollowerId` comes back as Dave's id, the `r` and `l` lambdas are swapped.

In request handlers, though, loading a user plus a whole follower collection just to insert one row is wasteful. Go through the join entity instead, which needs no loading at all:

```csharp
// .NET 11, EF Core 11.0.0-rc.2
db.Follows.Add(new Follow { FollowerId = currentUserId, FolloweeId = targetId });
await db.SaveChangesAsync();

// unfollow, one DELETE statement, no tracking
await db.Follows
    .Where(f => f.FollowerId == currentUserId && f.FolloweeId == targetId)
    .ExecuteDeleteAsync();
```

Both guard rails from the mapping fire as real database errors. On SQLite, following yourself fails with `CHECK constraint failed: CK_Follows_NoSelfFollow`, and following someone twice fails with `UNIQUE constraint failed: Follows.FollowerId, Follows.FolloweeId`. On SQL Server the second one is a primary key violation (error 2627). Under concurrent double-clicks you will hit it, so treat it as "already following" rather than a 500; the same pattern is described for PostgreSQL in [handling a duplicate key on a concurrent EF Core insert](/2026/08/fix-23505-duplicate-key-value-violates-unique-constraint-on-a-concurrent-ef-core-insert/).

## Querying counts, mutual follows and suggestions

Skip navigations translate to joins through `Follows`, so counts never load the collections:

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

"Mutual follows" (people I follow who follow me back) reads naturally with skip navigations:

```csharp
// .NET 11, EF Core 11.0.0-rc.2
var mutual = await db.Users
    .Where(u => u.Id == userId)
    .SelectMany(u => u.Following.Where(f => f.Following.Any(x => x.Id == userId)))
    .Select(f => f.Name)
    .ToListAsync();
```

That works, but the SQL it emits joins `Users` three times because every skip navigation hop goes through the user table. For heavier graph queries, write against `Follows` directly. Here is "people followed by people I follow, that I do not follow yet", ranked by how many of my follows lead there:

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

With the sample graph alice -> bob, alice -> carol, bob -> alice, carol -> dave, bob -> dave, the counts query returns `{ Name = alice, Followers = 1, Following = 2 }`, mutual follows for Alice returns `bob`, and suggestions return `dave via 2`. That query compiles to one `SELECT ... GROUP BY` with two `EXISTS` subqueries and no extra user joins. For follower lists that need paging, use the `(FolloweeId, CreatedAt)` pair with [keyset pagination](/2026/06/how-to-do-keyset-cursor-pagination-in-ef-core-11/) instead of `Skip`.

## Deleting a user without error 547

This is where the `ClientCascade` side bites. In the mapping above, rows where the deleted user is the *followee* go away through the database cascade. Rows where the deleted user is the *follower* rely on EF Core, and EF only deletes what it tracks. I measured three variations against SQLite with the same constraints:

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

Option 2 is fine for an admin screen, but loading every follow row of a user with 200,000 followings into the change tracker to delete them is not. The approach I use in production skips tracking entirely and runs in one transaction:

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

For Bob in the sample graph that deleted three follow rows and one user, leaving only follows that never touched him. Remember that `ExecuteDeleteAsync` bypasses the change tracker, so any `Follow` or `User` instances already tracked by this context are stale afterwards. The trade-offs are covered in more depth in [ExecuteUpdate and ExecuteDelete for bulk writes](/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/).

If your app soft-deletes users instead, none of this applies to the delete itself: the user row stays, so do the join rows, and you decide in your queries whether a deactivated account still counts as a follower.

## Gotchas worth knowing before the first migration

- **Changing from convention to an explicit join entity renames the table.** `UserUser` with `FollowersId`/`FollowingId` becomes `Follows` with `FollowerId`/`FolloweeId`. The scaffolded migration drops and recreates the table, which loses every follow. Edit the migration to use `RenameTable` and `RenameColumn` instead, the same way you would when [renaming a table without losing data](/2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data/).
- **A symmetric "friends" relationship is a different shape.** With a single `List<User> Friends` navigation there is no inverse to pair it with. The docs recommend mapping it as unidirectional (`HasMany(u => u.Friends).WithMany()`) and adding each person to the other's collection yourself, or storing both directions as two rows.
- **A third `List<User>` navigation silently removes all of them.** Add `Blocked` next to `Followers` and `Following` and EF can no longer tell which two belong together. On EF Core 11 RC 2 it does not throw: `Model.ToDebugString()` shows `User` with only its `Id` and no relationships at all, and the collections simply never load. Configure each pair explicitly with `HasMany(...).WithMany(...)` the moment a third self-typed collection appears.
- **Seeding follows needs the join entity.** `HasData` cannot fill skip navigations; seed `Follow` rows with fixed keys, as explained in [seeding a many-to-many relationship in EF Core 11](/2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11/).
- **`Include(u => u.Followers)` on a popular account is a trap.** It materializes every follower. Project counts or page through `Follows` instead.

## Read next

- [How to seed a many-to-many relationship in EF Core 11](/2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11/)
- [Fix FOREIGN KEY constraint failed when deleting an entity in EF Core 11](/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/)
- [How to use ExecuteUpdate and ExecuteDelete for bulk writes in EF Core 11](/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/)
- [What is a shadow property in EF Core 11, and why did one show up in my migration?](/2026/10/what-is-a-shadow-property-in-ef-core-11-and-why-did-one-show-up-in-my-migration/)

Sources: the EF Core [many-to-many relationships documentation](https://learn.microsoft.com/en-us/ef/core/modeling/relationships/many-to-many) (self-referencing and symmetrical sections, `UsingEntity` overloads), the [cascade delete documentation](https://learn.microsoft.com/en-us/ef/core/saving/cascade-delete) for `ClientCascade` semantics, the [`SqlServerOnDeleteConvention` source](https://github.com/dotnet/efcore/blob/main/src/EFCore.SqlServer/Metadata/Conventions/SqlServerOnDeleteConvention.cs) and the PR that introduced it, [dotnet/efcore#21959](https://github.com/dotnet/efcore/pull/21959), and the SQL Server documentation on [cascading referential integrity](https://learn.microsoft.com/en-us/sql/relational-databases/tables/primary-and-foreign-key-constraints).
