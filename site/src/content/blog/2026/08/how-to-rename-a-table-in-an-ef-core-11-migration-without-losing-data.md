---
title: "How to rename a table in an EF Core 11 migration without losing data"
description: "EF Core scaffolds RenameTable when you change the table name, but DropTable plus CreateTable when you rename the entity class. Here is how to tell the two apart, the ToTable trick that makes a class rename free, and the column-rename bug that silently swaps your data."
pubDate: 2026-08-09
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "migrations"
  - "sql-server"
  - "dotnet-11"
  - "how-to"
---

Short answer: if you change only the *table name* with `ToTable("Clients")` and leave the entity class alone, EF Core scaffolds a correct `migrationBuilder.RenameTable(...)` and no data is lost. If you rename the *entity class* from `Customer` to `Client`, EF Core scaffolds `DropTable("Customers")` plus `CreateTable("Clients")`, and applying that migration deletes every row. The fix is to never do both at once: pin the old table name with `ToTable("Customers")` in the same commit that renames the class, which produces zero model changes, then change the table name in a separate migration.

This post covers the exact scaffolding output for both cases, the T-SQL each one generates, the primary-key rebuild that EF Core sneaks into a table rename, and three gotchas that bite after the migration applies cleanly.

Everything below was measured on EF Core 10.0.10 with the .NET SDK 10.0.201, scaffolding against the SQL Server provider's DDL generator. EF Core 11 requires the .NET 11 runtime, which I do not have on this machine, so I could not execute it there. The `MigrationsModelDiffer` behaviour and the `RenameTable` API are unchanged across EF Core 8, 9, 10 and 11; the one EF Core 11 specific item, the `dotnet ef database update --add` command, is called out below and sourced from the docs rather than measured.

## The two renames EF Core treats completely differently

Start from a model with a `Customer`, an `Order` that points at it, and a unique index:

```csharp
// .NET 11, C# 14, EF Core 11
public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public string Email { get; set; } = "";
    public List<Order> Orders { get; set; } = new();
}

protected override void OnModelCreating(ModelBuilder b)
{
    b.Entity<Customer>().Property(c => c.Name).HasMaxLength(200);
    b.Entity<Customer>().HasIndex(c => c.Email).IsUnique();
}
```

Now rename the class to `Client`, rename the `DbSet<Customer> Customers` property to `Clients`, and let the IDE fix up `Order.CustomerId` to `Order.ClientId`. Run `dotnet ef migrations add RenameCustomerToClient` and you get this:

```csharp
// scaffolded by EF Core 10.0.10 after renaming the entity class
migrationBuilder.DropForeignKey(name: "FK_Orders_Customers_CustomerId", table: "Orders");

migrationBuilder.DropTable(name: "Customers");   // <- every row, gone

migrationBuilder.RenameColumn(name: "CustomerId", table: "Orders", newName: "ClientId");
migrationBuilder.RenameIndex(name: "IX_Orders_CustomerId", table: "Orders", newName: "IX_Orders_ClientId");

migrationBuilder.CreateTable(
    name: "Clients",
    columns: table => new
    {
        Id = table.Column<int>(type: "int", nullable: false)
            .Annotation("SqlServer:Identity", "1, 1"),
        Name = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: false),
        Email = table.Column<string>(type: "nvarchar(450)", nullable: false)
    },
    constraints: table => { table.PrimaryKey("PK_Clients", x => x.Id); });
```

Note the asymmetry, because it is the whole story. The `Orders` table kept its name, so the differ matched it to its old self and correctly emitted `RenameColumn` for the foreign-key column. The `Customers` table did *not* keep its name, so the differ saw one table disappear and an unrelated table appear, and emitted a drop followed by a create.

EF Core does warn here. The CLI prints a line that is easy to scroll past:

```
An operation was scaffolded that may result in the loss of data. Please review the migration for accuracy.
```

Now do the other rename. Keep the class called `Customer` and change only the table name:

```csharp
// EF Core 11, OnModelCreating
b.Entity<Customer>().ToTable("Clients");
```

Scaffold that and you get a migration that preserves every row, with no warning printed at all:

```csharp
// scaffolded by EF Core 10.0.10 after ToTable("Clients")
migrationBuilder.DropForeignKey(name: "FK_Orders_Customers_CustomerId", table: "Orders");
migrationBuilder.DropPrimaryKey(name: "PK_Customers", table: "Customers");

migrationBuilder.RenameTable(name: "Customers", newName: "Clients");
migrationBuilder.RenameIndex(name: "IX_Customers_Email", table: "Clients", newName: "IX_Clients_Email");

migrationBuilder.AddPrimaryKey(name: "PK_Clients", table: "Clients", column: "Id");
migrationBuilder.AddForeignKey(
    name: "FK_Orders_Clients_CustomerId", table: "Orders", column: "CustomerId",
    principalTable: "Clients", principalColumn: "Id", onDelete: ReferentialAction.Cascade);
```

That is the migration you want. The lesson is that EF Core is not guessing about table renames at all: it keys the whole diff off the table name. Change the table name and you get a rename. Change the identity of the entity type and you get a drop.

## The procedure that makes a class rename free

The trick is to decouple the C# refactor from the schema change, so neither step is ever ambiguous.

1. **Pin the current table name before you touch the class.** Add `ToTable` with the name the database already uses, and scaffold nothing:

   ```csharp
   // EF Core 11 - this is a no-op against the existing schema
   b.Entity<Customer>().ToTable("Customers");
   ```

2. **Rename the class, the `DbSet`, and the navigation properties.** Let the IDE do it across the solution. The fluent configuration becomes `b.Entity<Client>().ToTable("Customers")`.

3. **Confirm there is nothing to migrate.** This is the step that proves the refactor was schema-neutral:

   ```bash
   dotnet ef migrations has-pending-model-changes
   ```

   On EF Core 10.0.10 this prints `No changes have been made to the model since the last migration.` The class is now called `Client`, the `DbSet` is `Clients`, and the database has not noticed. Ship that commit on its own.

4. **Change the table name in a separate migration.** Update the pin to `b.Entity<Client>().ToTable("Clients")` and scaffold. Because the entity type identity is stable this time, you get the clean `RenameTable` shown above.

5. **Read the generated migration before applying it.** Every time. Confirm there is no `DropTable` and no `DropColumn` in the `Up` method, and confirm the `Down` method reverses the rename rather than recreating the table.

The reason to keep the pin permanently, rather than deleting it once the rename lands, is that the table name is otherwise derived from the `DbSet` property name by convention. Leave it implicit and the next person who renames a property for readability moves your table again.

## What the rename actually runs against SQL Server

`dotnet ef migrations script` on the `RenameTable` migration produces this:

```sql
-- EF Core 10.0.10, SQL Server provider
ALTER TABLE [Orders] DROP CONSTRAINT [FK_Orders_Customers_CustomerId];
ALTER TABLE [Customers] DROP CONSTRAINT [PK_Customers];
EXEC sp_rename N'[Customers]', N'Clients', 'OBJECT';
EXEC sp_rename N'[Clients].[IX_Customers_Email]', N'IX_Clients_Email', 'INDEX';
ALTER TABLE [Clients] ADD CONSTRAINT [PK_Clients] PRIMARY KEY ([Id]);
ALTER TABLE [Orders] ADD CONSTRAINT [FK_Orders_Clients_CustomerId]
    FOREIGN KEY ([CustomerId]) REFERENCES [Clients] ([Id]) ON DELETE CASCADE;
```

The table rename itself is metadata only and effectively instant regardless of row count. The expensive part is the constraint churn around it. EF Core drops the primary key and adds it back purely to change the constraint's *name* from `PK_Customers` to `PK_Clients`. On SQL Server the primary key is clustered by default, so `ADD CONSTRAINT ... PRIMARY KEY` rebuilds the entire clustered index. On a table with tens of millions of rows that is a long, log-heavy operation inside the migration transaction, to cosmetically rename a constraint.

`sp_rename` can rename constraints directly, so you can hand-edit the migration to skip the rebuild:

```csharp
// EF Core 11 - replace DropPrimaryKey/AddPrimaryKey on a large SQL Server table
migrationBuilder.RenameTable(name: "Customers", newName: "Clients");
migrationBuilder.RenameIndex(name: "IX_Customers_Email", table: "Clients", newName: "IX_Clients_Email");
migrationBuilder.Sql("EXEC sp_rename N'[dbo].[PK_Customers]', N'PK_Clients', 'OBJECT';");
migrationBuilder.Sql("EXEC sp_rename N'[dbo].[FK_Orders_Customers_CustomerId]', N'FK_Orders_Clients_CustomerId', 'OBJECT';");
```

`sp_rename` needs the schema-qualified name when the target is a constraint, hence the `[dbo].` prefix. This is provider-specific and it diverges from what the model snapshot expects EF Core to have done, so only reach for it when the rebuild is genuinely a problem. If you take this route, apply it through a reviewed script rather than at app startup; the [migrations bundle workflow](/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) is the right shape for it.

## Renaming a column is where EF Core actually guesses

The Microsoft docs still say that renaming a property scaffolds `DropColumn` plus `AddColumn`. That has not been true for a while. On EF Core 10.0.10, renaming `Customer.Name` to `Customer.FullName` scaffolds exactly what you want:

```csharp
migrationBuilder.RenameColumn(name: "Name", table: "Customers", newName: "FullName");
```

The improvement is real, but it comes from a heuristic that pairs removed columns with added columns, and the heuristic can pair them wrongly. Take an entity with two string properties of identical configuration, `Alpha` and `Bravo`, and rename them in one migration to `Zulu` and `Yankee` respectively. EF Core 10.0.10 scaffolds this:

```csharp
// WRONG: Alpha should become Zulu, Bravo should become Yankee
migrationBuilder.RenameColumn(name: "Bravo", table: "Customers", newName: "Zulu");
migrationBuilder.RenameColumn(name: "Alpha", table: "Customers", newName: "Yankee");
```

The pairing is crossed. Apply that and the data in the two columns is silently swapped for every row in the table. Nothing is dropped, so no data-loss warning is printed, the migration applies cleanly, and the corruption only surfaces when a human reads a screen. I reproduced this on a two-column table with no other model changes.

The practical rule: rename one column per migration when the columns share a type, or read the scaffolded `RenameColumn` pairs and fix them by hand. This is the same class of silent-corruption problem as [storing an enum by its integer value](/2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter/), where the schema stays valid while the meaning of the data shifts underneath it.

## Three things that still break after the migration succeeds

**Views, stored procedures, and triggers keep the old name.** SQL Server's `sp_rename` does not chase references. The docs are blunt about it: "Changing any part of an object name can break scripts and stored procedures." A view that selects from `Customers` will not fail at rename time; it fails the next time somebody queries it. Before you scaffold, list what depends on the table:

```sql
SELECT OBJECT_NAME(referencing_id) AS referencing_object
FROM sys.sql_expression_dependencies
WHERE referenced_entity_name = 'Customers';
```

Then add `migrationBuilder.Sql("ALTER VIEW ...")` operations to the same migration so the rename and its dependents move together.

**`dotnet ef database update --add` applies the migration before you can read it.** EF Core 11 added a single-step command that scaffolds a migration, compiles it with Roslyn, and applies it immediately. That is genuinely useful for containerized and Aspire workflows, and it is exactly the wrong tool for a rename, because the whole safety procedure above depends on reading the scaffolded file first. For any migration that touches an existing table's identity, scaffold and apply as two commands. The [single-step migration feature](/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/) is worth using everywhere else.

**A rename is not backward compatible, so it breaks rolling deploys.** During a rolling deployment the old build is still running and still issuing `SELECT ... FROM Customers` while the new build expects `Clients`. A single migration that renames the table takes the old instances down. If you need zero downtime, the rename becomes a multi-deploy sequence: create a view named `Customers` over `Clients` in the same migration as the rename, deploy the new build, then drop the view in a later migration once no instance references the old name.

One last detail worth checking before you commit: the `Down` method. EF Core generates a correct inverse for `RenameTable`, but if you hand-edited `Up` to use `sp_rename` on constraints, `Down` still contains the scaffolded `DropPrimaryKey` and `AddPrimaryKey`, and your rollback will not be symmetric. If the model snapshot and the database ever drift apart after this, you will meet [the pending model changes exception](/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/) on the next startup, and [logging the SQL EF Core generates](/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) is the fastest way to see which name the runtime actually thinks it is querying.

## Related

- [How to apply EF Core 11 migrations in production with dotnet ef migrations bundle](/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)
- [EF Core 11 lets you create and apply a migration in one command](/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/)
- [Fix: the model for context 'X' has pending changes in EF Core 11](/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/)
- [Migrate EF Core 6 to EF Core 11: breaking changes that actually bite](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)
- [How to log the SQL that EF Core 11 generates](/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)

## Sources

- [Managing migrations](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/managing) on Microsoft Learn, including the `dotnet ef database update --add` command added in EF Core 11
- [MigrationBuilder.RenameTable](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.migrations.migrationbuilder.renametable) API reference for the `schema` and `newSchema` parameters
- [sys.sp_rename](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-rename-transact-sql) for constraint renaming and the dependency caveats
- [sys.sql_expression_dependencies](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-sql-expression-dependencies-transact-sql) for finding objects that reference a table before renaming it
