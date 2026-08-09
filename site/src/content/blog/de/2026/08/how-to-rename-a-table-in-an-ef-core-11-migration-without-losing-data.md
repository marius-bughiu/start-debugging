---
title: "Wie Sie eine Tabelle in einer EF Core 11 Migration umbenennen, ohne Daten zu verlieren"
description: "EF Core erzeugt RenameTable, wenn Sie den Tabellennamen ändern, aber DropTable plus CreateTable, wenn Sie die Entitätsklasse umbenennen. Hier steht, wie Sie beide Fälle unterscheiden, der ToTable-Trick, der eine Klassenumbenennung kostenlos macht, und der Spaltenumbenennungs-Bug, der Ihre Daten stillschweigend vertauscht."
pubDate: 2026-08-09
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "migrations"
  - "sql-server"
  - "dotnet-11"
  - "how-to"
lang: "de"
translationOf: "2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data"
translatedBy: "claude"
translationDate: 2026-08-09
---

Kurze Antwort: Wenn Sie nur den *Tabellennamen* mit `ToTable("Clients")` ändern und die Entitätsklasse unangetastet lassen, erzeugt EF Core ein korrektes `migrationBuilder.RenameTable(...)` und es gehen keine Daten verloren. Wenn Sie die *Entitätsklasse* von `Customer` zu `Client` umbenennen, erzeugt EF Core `DropTable("Customers")` plus `CreateTable("Clients")`, und das Anwenden dieser Migration löscht jede Zeile. Die Lösung besteht darin, beides niemals gleichzeitig zu tun: Fixieren Sie den alten Tabellennamen mit `ToTable("Customers")` im selben Commit, der die Klasse umbenennt, was null Modelländerungen ergibt, und ändern Sie den Tabellennamen dann in einer separaten Migration.

Dieser Artikel behandelt die exakte Scaffolding-Ausgabe für beide Fälle, das T-SQL, das jeder Fall erzeugt, den Primärschlüssel-Neuaufbau, den EF Core in eine Tabellenumbenennung einschleust, und drei Fallstricke, die zuschlagen, nachdem die Migration sauber durchgelaufen ist.

Alles Folgende wurde auf EF Core 10.0.10 mit dem .NET SDK 10.0.201 gemessen, mit Scaffolding gegen den DDL-Generator des SQL Server Providers. EF Core 11 benötigt die .NET 11 Runtime, die ich auf dieser Maschine nicht habe, daher konnte ich es dort nicht ausführen. Das Verhalten von `MigrationsModelDiffer` und die `RenameTable` API sind über EF Core 8, 9, 10 und 11 hinweg unverändert; der einzige EF Core 11 spezifische Punkt, der Befehl `dotnet ef database update --add`, ist unten hervorgehoben und stammt aus der Dokumentation, nicht aus einer Messung.

## Die zwei Umbenennungen, die EF Core völlig unterschiedlich behandelt

Beginnen Sie mit einem Modell aus einem `Customer`, einem `Order`, der darauf zeigt, und einem eindeutigen Index:

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

Benennen Sie nun die Klasse in `Client` um, benennen Sie die Eigenschaft `DbSet<Customer> Customers` in `Clients` um, und lassen Sie die IDE `Order.CustomerId` zu `Order.ClientId` anpassen. Führen Sie `dotnet ef migrations add RenameCustomerToClient` aus und Sie erhalten dies:

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

Beachten Sie die Asymmetrie, denn sie ist die ganze Geschichte. Die Tabelle `Orders` behielt ihren Namen, also ordnete der Differ sie ihrem alten Zustand zu und gab korrekt `RenameColumn` für die Fremdschlüsselspalte aus. Die Tabelle `Customers` behielt ihren Namen *nicht*, also sah der Differ eine Tabelle verschwinden und eine unverwandte Tabelle auftauchen, und gab ein Drop gefolgt von einem Create aus.

EF Core warnt hier durchaus. Die CLI gibt eine Zeile aus, die man leicht überscrollt:

```
An operation was scaffolded that may result in the loss of data. Please review the migration for accuracy.
```

Führen Sie nun die andere Umbenennung durch. Behalten Sie den Klassennamen `Customer` bei und ändern Sie nur den Tabellennamen:

```csharp
// EF Core 11, OnModelCreating
b.Entity<Customer>().ToTable("Clients");
```

Das Scaffolding dafür liefert eine Migration, die jede Zeile erhält, ganz ohne ausgegebene Warnung:

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

Das ist die Migration, die Sie wollen. Die Lehre daraus: EF Core rät bei Tabellenumbenennungen überhaupt nicht, sondern koppelt den gesamten Diff an den Tabellennamen. Ändern Sie den Tabellennamen und Sie bekommen eine Umbenennung. Ändern Sie die Identität des Entitätstyps und Sie bekommen ein Drop.

## Das Verfahren, das eine Klassenumbenennung kostenlos macht

Der Trick besteht darin, das C#-Refactoring von der Schemaänderung zu entkoppeln, sodass kein Schritt jemals mehrdeutig ist.

1. **Fixieren Sie den aktuellen Tabellennamen, bevor Sie die Klasse anfassen.** Fügen Sie `ToTable` mit dem Namen hinzu, den die Datenbank bereits verwendet, und erzeugen Sie nichts:

   ```csharp
   // EF Core 11 - this is a no-op against the existing schema
   b.Entity<Customer>().ToTable("Customers");
   ```

2. **Benennen Sie die Klasse, das `DbSet` und die Navigationseigenschaften um.** Lassen Sie die IDE das über die gesamte Solution erledigen. Die Fluent-Konfiguration wird zu `b.Entity<Client>().ToTable("Customers")`.

3. **Bestätigen Sie, dass es nichts zu migrieren gibt.** Dieser Schritt beweist, dass das Refactoring schemaneutral war:

   ```bash
   dotnet ef migrations has-pending-model-changes
   ```

   Auf EF Core 10.0.10 gibt das `No changes have been made to the model since the last migration.` aus. Die Klasse heißt nun `Client`, das `DbSet` ist `Clients`, und die Datenbank hat nichts davon bemerkt. Liefern Sie diesen Commit für sich allein aus.

4. **Ändern Sie den Tabellennamen in einer separaten Migration.** Aktualisieren Sie die Fixierung auf `b.Entity<Client>().ToTable("Clients")` und erzeugen Sie das Scaffolding. Da die Identität des Entitätstyps diesmal stabil ist, erhalten Sie das saubere `RenameTable` von oben.

5. **Lesen Sie die erzeugte Migration, bevor Sie sie anwenden.** Jedes Mal. Prüfen Sie, dass es kein `DropTable` und kein `DropColumn` in der `Up`-Methode gibt, und dass die `Down`-Methode die Umbenennung rückgängig macht, statt die Tabelle neu anzulegen.

Der Grund, die Fixierung dauerhaft zu behalten statt sie nach der Umbenennung zu entfernen: Der Tabellenname wird sonst per Konvention vom Namen der `DbSet`-Eigenschaft abgeleitet. Lassen Sie ihn implizit, und die nächste Person, die eine Eigenschaft der Lesbarkeit halber umbenennt, verschiebt Ihre Tabelle erneut.

## Was die Umbenennung tatsächlich gegen SQL Server ausführt

`dotnet ef migrations script` auf der `RenameTable`-Migration erzeugt dies:

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

Die Tabellenumbenennung selbst betrifft nur Metadaten und ist praktisch sofort abgeschlossen, unabhängig von der Zeilenzahl. Teuer ist das Constraint-Geschiebe drumherum. EF Core löscht den Primärschlüssel und fügt ihn wieder hinzu, nur um den *Namen* des Constraints von `PK_Customers` auf `PK_Clients` zu ändern. Auf SQL Server ist der Primärschlüssel standardmäßig gruppiert, also baut `ADD CONSTRAINT ... PRIMARY KEY` den gesamten gruppierten Index neu auf. Bei einer Tabelle mit zig Millionen Zeilen ist das eine lange, protokollintensive Operation innerhalb der Migrationstransaktion, nur um ein Constraint kosmetisch umzubenennen.

`sp_rename` kann Constraints direkt umbenennen, Sie können die Migration also von Hand anpassen, um den Neuaufbau zu überspringen:

```csharp
// EF Core 11 - replace DropPrimaryKey/AddPrimaryKey on a large SQL Server table
migrationBuilder.RenameTable(name: "Customers", newName: "Clients");
migrationBuilder.RenameIndex(name: "IX_Customers_Email", table: "Clients", newName: "IX_Clients_Email");
migrationBuilder.Sql("EXEC sp_rename N'[dbo].[PK_Customers]', N'PK_Clients', 'OBJECT';");
migrationBuilder.Sql("EXEC sp_rename N'[dbo].[FK_Orders_Customers_CustomerId]', N'FK_Orders_Clients_CustomerId', 'OBJECT';");
```

`sp_rename` benötigt den schemaqualifizierten Namen, wenn das Ziel ein Constraint ist, daher das Präfix `[dbo].`. Das ist providerspezifisch und weicht davon ab, was der Modell-Snapshot von EF Core erwartet, greifen Sie also nur darauf zurück, wenn der Neuaufbau wirklich ein Problem ist. Wenn Sie diesen Weg gehen, wenden Sie ihn über ein geprüftes Skript an statt beim Anwendungsstart; der [Workflow mit Migration Bundles](/de/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) hat dafür die passende Form.

## Beim Umbenennen einer Spalte rät EF Core tatsächlich

Die Microsoft-Dokumentation sagt immer noch, dass das Umbenennen einer Eigenschaft `DropColumn` plus `AddColumn` erzeugt. Das stimmt schon länger nicht mehr. Auf EF Core 10.0.10 erzeugt das Umbenennen von `Customer.Name` zu `Customer.FullName` genau das, was Sie wollen:

```csharp
migrationBuilder.RenameColumn(name: "Name", table: "Customers", newName: "FullName");
```

Die Verbesserung ist real, aber sie stammt von einer Heuristik, die entfernte Spalten mit hinzugefügten Spalten paart, und diese Heuristik kann sie falsch paaren. Nehmen Sie eine Entität mit zwei String-Eigenschaften identischer Konfiguration, `Alpha` und `Bravo`, und benennen Sie beide in einer Migration in `Zulu` und `Yankee` um. EF Core 10.0.10 erzeugt dies:

```csharp
// WRONG: Alpha should become Zulu, Bravo should become Yankee
migrationBuilder.RenameColumn(name: "Bravo", table: "Customers", newName: "Zulu");
migrationBuilder.RenameColumn(name: "Alpha", table: "Customers", newName: "Yankee");
```

Die Paarung ist vertauscht. Wenden Sie das an, und die Daten der beiden Spalten werden für jede Zeile der Tabelle stillschweigend getauscht. Es wird nichts gelöscht, also erscheint keine Datenverlust-Warnung, die Migration läuft sauber durch, und die Korruption fällt erst auf, wenn ein Mensch auf den Bildschirm schaut. Ich habe das auf einer Zwei-Spalten-Tabelle ohne weitere Modelländerungen reproduziert.

Die praktische Regel: Benennen Sie eine Spalte pro Migration um, wenn die Spalten denselben Typ haben, oder lesen Sie die erzeugten `RenameColumn`-Paare und korrigieren Sie sie von Hand. Das ist dieselbe Klasse von stiller Korruption wie [das Speichern eines Enums über seinen Integer-Wert](/de/2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter/), wo das Schema gültig bleibt, während sich die Bedeutung der Daten darunter verschiebt.

## Drei Dinge, die nach einer erfolgreichen Migration weiterhin brechen

**Views, Stored Procedures und Trigger behalten den alten Namen.** `sp_rename` von SQL Server verfolgt keine Referenzen. Die Dokumentation ist unmissverständlich: "Changing any part of an object name can break scripts and stored procedures." Eine View, die aus `Customers` selektiert, scheitert nicht zum Zeitpunkt der Umbenennung; sie scheitert, wenn sie das nächste Mal abgefragt wird. Listen Sie vor dem Scaffolding auf, was von der Tabelle abhängt:

```sql
SELECT OBJECT_NAME(referencing_id) AS referencing_object
FROM sys.sql_expression_dependencies
WHERE referenced_entity_name = 'Customers';
```

Fügen Sie dann `migrationBuilder.Sql("ALTER VIEW ...")` Operationen zur selben Migration hinzu, damit die Umbenennung und ihre abhängigen Objekte gemeinsam wandern.

**`dotnet ef database update --add` wendet die Migration an, bevor Sie sie lesen können.** EF Core 11 hat einen Ein-Schritt-Befehl hinzugefügt, der eine Migration erzeugt, sie mit Roslyn kompiliert und sie sofort anwendet. Das ist für containerisierte und Aspire-Workflows wirklich nützlich, und es ist für eine Umbenennung genau das falsche Werkzeug, weil das gesamte Sicherheitsverfahren oben davon abhängt, die erzeugte Datei zuerst zu lesen. Erzeugen und wenden Sie jede Migration, die die Identität einer bestehenden Tabelle berührt, in zwei getrennten Befehlen an. Das [Feature für Migrationen in einem Schritt](/de/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/) lohnt sich überall sonst.

**Eine Umbenennung ist nicht abwärtskompatibel und bricht daher rollierende Bereitstellungen.** Während einer rollierenden Bereitstellung läuft der alte Build weiter und setzt weiterhin `SELECT ... FROM Customers` ab, während der neue Build `Clients` erwartet. Eine einzelne Migration, die die Tabelle umbenennt, legt die alten Instanzen lahm. Wenn Sie null Ausfallzeit brauchen, wird die Umbenennung zu einer Sequenz über mehrere Bereitstellungen: Legen Sie in derselben Migration wie die Umbenennung eine View namens `Customers` über `Clients` an, stellen Sie den neuen Build bereit, und löschen Sie die View in einer späteren Migration, sobald keine Instanz mehr den alten Namen referenziert.

Ein letztes Detail, das Sie vor dem Commit prüfen sollten: die `Down`-Methode. EF Core erzeugt eine korrekte Umkehrung für `RenameTable`, aber wenn Sie `Up` von Hand auf `sp_rename` für die Constraints umgestellt haben, enthält `Down` weiterhin das erzeugte `DropPrimaryKey` und `AddPrimaryKey`, und Ihr Rollback ist nicht symmetrisch. Falls Modell-Snapshot und Datenbank danach jemals auseinanderlaufen, begegnen Sie beim nächsten Start [der Ausnahme wegen ausstehender Modelländerungen](/de/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/), und [das Protokollieren des von EF Core erzeugten SQL](/de/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) ist der schnellste Weg zu sehen, welchen Namen die Runtime tatsächlich abfragt.

## Verwandt

- [Wie Sie EF Core 11 Migrationen in der Produktion mit dotnet ef migrations bundle anwenden](/de/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)
- [EF Core 11 lässt Sie eine Migration mit einem einzigen Befehl erstellen und anwenden](/de/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/)
- [Fix: Das Modell für Kontext 'X' hat ausstehende Änderungen in EF Core 11](/de/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/)
- [Von EF Core 6 auf EF Core 11 migrieren: die Breaking Changes, die wirklich wehtun](/de/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)
- [Wie Sie das von EF Core 11 erzeugte SQL protokollieren](/de/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)

## Quellen

- [Managing migrations](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/managing) auf Microsoft Learn, einschließlich des in EF Core 11 hinzugefügten Befehls `dotnet ef database update --add`
- API-Referenz zu [MigrationBuilder.RenameTable](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.migrations.migrationbuilder.renametable) für die Parameter `schema` und `newSchema`
- [sys.sp_rename](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-rename-transact-sql) für das Umbenennen von Constraints und die Einschränkungen bei Abhängigkeiten
- [sys.sql_expression_dependencies](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-sql-expression-dependencies-transact-sql) zum Auffinden von Objekten, die eine Tabelle vor dem Umbenennen referenzieren
