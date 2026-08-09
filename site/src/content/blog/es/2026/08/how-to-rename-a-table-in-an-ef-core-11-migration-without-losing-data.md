---
title: "Cómo renombrar una tabla en una migración de EF Core 11 sin perder datos"
description: "EF Core genera RenameTable cuando cambias el nombre de la tabla, pero DropTable más CreateTable cuando renombras la clase de entidad. Aquí verás cómo distinguir ambos casos, el truco de ToTable que hace gratis el renombrado de una clase, y el bug de renombrado de columnas que intercambia tus datos en silencio."
pubDate: 2026-08-09
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "migrations"
  - "sql-server"
  - "dotnet-11"
  - "how-to"
lang: "es"
translationOf: "2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data"
translatedBy: "claude"
translationDate: 2026-08-09
---

Respuesta corta: si cambias solo el *nombre de la tabla* con `ToTable("Clients")` y dejas la clase de entidad intacta, EF Core genera un `migrationBuilder.RenameTable(...)` correcto y no se pierde ningún dato. Si renombras la *clase de entidad* de `Customer` a `Client`, EF Core genera `DropTable("Customers")` más `CreateTable("Clients")`, y aplicar esa migración borra todas las filas. La solución es no hacer nunca ambas cosas a la vez: fija el nombre viejo de la tabla con `ToTable("Customers")` en el mismo commit que renombra la clase, lo que produce cero cambios en el modelo, y luego cambia el nombre de la tabla en una migración aparte.

Este artículo cubre la salida exacta del scaffolding para ambos casos, el T-SQL que genera cada uno, la reconstrucción de la clave primaria que EF Core cuela dentro de un renombrado de tabla, y tres detalles que muerden después de que la migración se aplique sin errores.

Todo lo que sigue se midió sobre EF Core 10.0.10 con el SDK de .NET 10.0.201, generando el scaffolding contra el generador de DDL del proveedor de SQL Server. EF Core 11 requiere el runtime de .NET 11, que no tengo en esta máquina, así que no pude ejecutarlo allí. El comportamiento de `MigrationsModelDiffer` y la API `RenameTable` no cambian entre EF Core 8, 9, 10 y 11; el único elemento específico de EF Core 11, el comando `dotnet ef database update --add`, se señala más abajo y proviene de la documentación, no de una medición.

## Los dos renombrados que EF Core trata de forma completamente distinta

Parte de un modelo con un `Customer`, un `Order` que lo apunta, y un índice único:

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

Ahora renombra la clase a `Client`, renombra la propiedad `DbSet<Customer> Customers` a `Clients`, y deja que el IDE ajuste `Order.CustomerId` a `Order.ClientId`. Ejecuta `dotnet ef migrations add RenameCustomerToClient` y obtienes esto:

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

Fíjate en la asimetría, porque ahí está toda la historia. La tabla `Orders` conservó su nombre, así que el comparador la emparejó con su versión anterior y emitió correctamente `RenameColumn` para la columna de clave foránea. La tabla `Customers` *no* conservó su nombre, así que el comparador vio desaparecer una tabla y aparecer otra sin relación, y emitió un drop seguido de un create.

EF Core sí avisa aquí. La CLI imprime una línea que es fácil pasar por alto:

```
An operation was scaffolded that may result in the loss of data. Please review the migration for accuracy.
```

Ahora haz el otro renombrado. Mantén la clase llamada `Customer` y cambia solo el nombre de la tabla:

```csharp
// EF Core 11, OnModelCreating
b.Entity<Customer>().ToTable("Clients");
```

Genera el scaffolding y obtienes una migración que preserva todas las filas, sin ningún aviso impreso:

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

Esa es la migración que quieres. La lección es que EF Core no está adivinando nada sobre renombrados de tablas: basa todo el diff en el nombre de la tabla. Cambia el nombre de la tabla y obtienes un renombrado. Cambia la identidad del tipo de entidad y obtienes un drop.

## El procedimiento que hace gratis el renombrado de una clase

El truco consiste en desacoplar la refactorización de C# del cambio de esquema, para que ningún paso sea nunca ambiguo.

1. **Fija el nombre actual de la tabla antes de tocar la clase.** Agrega `ToTable` con el nombre que la base de datos ya usa, y no generes nada:

   ```csharp
   // EF Core 11 - this is a no-op against the existing schema
   b.Entity<Customer>().ToTable("Customers");
   ```

2. **Renombra la clase, el `DbSet` y las propiedades de navegación.** Deja que el IDE lo haga en toda la solución. La configuración fluida pasa a ser `b.Entity<Client>().ToTable("Customers")`.

3. **Confirma que no hay nada que migrar.** Este es el paso que demuestra que la refactorización fue neutral respecto al esquema:

   ```bash
   dotnet ef migrations has-pending-model-changes
   ```

   En EF Core 10.0.10 esto imprime `No changes have been made to the model since the last migration.` La clase ahora se llama `Client`, el `DbSet` es `Clients`, y la base de datos no se ha enterado. Publica ese commit por separado.

4. **Cambia el nombre de la tabla en una migración aparte.** Actualiza la fijación a `b.Entity<Client>().ToTable("Clients")` y genera el scaffolding. Como esta vez la identidad del tipo de entidad es estable, obtienes el `RenameTable` limpio mostrado arriba.

5. **Lee la migración generada antes de aplicarla.** Siempre. Confirma que no hay ningún `DropTable` ni `DropColumn` en el método `Up`, y confirma que el método `Down` revierte el renombrado en lugar de recrear la tabla.

La razón para mantener la fijación de forma permanente, en vez de borrarla una vez aplicado el renombrado, es que si no el nombre de la tabla se deriva por convención del nombre de la propiedad `DbSet`. Déjalo implícito y la próxima persona que renombre una propiedad por legibilidad moverá tu tabla otra vez.

## Qué ejecuta realmente el renombrado contra SQL Server

`dotnet ef migrations script` sobre la migración con `RenameTable` produce esto:

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

El renombrado de la tabla en sí es solo metadatos y es prácticamente instantáneo sin importar el número de filas. La parte cara es el trajín de constraints a su alrededor. EF Core elimina la clave primaria y la vuelve a agregar únicamente para cambiar el *nombre* de la constraint de `PK_Customers` a `PK_Clients`. En SQL Server la clave primaria es clustered por defecto, así que `ADD CONSTRAINT ... PRIMARY KEY` reconstruye el índice clustered entero. En una tabla con decenas de millones de filas eso es una operación larga y pesada en log dentro de la transacción de la migración, para renombrar cosméticamente una constraint.

`sp_rename` puede renombrar constraints directamente, así que puedes editar a mano la migración para saltarte la reconstrucción:

```csharp
// EF Core 11 - replace DropPrimaryKey/AddPrimaryKey on a large SQL Server table
migrationBuilder.RenameTable(name: "Customers", newName: "Clients");
migrationBuilder.RenameIndex(name: "IX_Customers_Email", table: "Clients", newName: "IX_Clients_Email");
migrationBuilder.Sql("EXEC sp_rename N'[dbo].[PK_Customers]', N'PK_Clients', 'OBJECT';");
migrationBuilder.Sql("EXEC sp_rename N'[dbo].[FK_Orders_Customers_CustomerId]', N'FK_Orders_Clients_CustomerId', 'OBJECT';");
```

`sp_rename` necesita el nombre calificado con el esquema cuando el objetivo es una constraint, de ahí el prefijo `[dbo].`. Esto es específico del proveedor y se aparta de lo que el snapshot del modelo espera que EF Core haya hecho, así que recurre a ello solo cuando la reconstrucción sea realmente un problema. Si tomas este camino, aplícalo mediante un script revisado en vez de al arrancar la aplicación; el [flujo de trabajo con migration bundles](/es/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) tiene la forma adecuada para eso.

## Renombrar una columna es donde EF Core sí adivina

La documentación de Microsoft todavía dice que renombrar una propiedad genera `DropColumn` más `AddColumn`. Eso hace tiempo que dejó de ser cierto. En EF Core 10.0.10, renombrar `Customer.Name` a `Customer.FullName` genera exactamente lo que quieres:

```csharp
migrationBuilder.RenameColumn(name: "Name", table: "Customers", newName: "FullName");
```

La mejora es real, pero viene de una heurística que empareja columnas eliminadas con columnas agregadas, y esa heurística puede emparejarlas mal. Toma una entidad con dos propiedades string de configuración idéntica, `Alpha` y `Bravo`, y renómbralas en una sola migración a `Zulu` y `Yankee` respectivamente. EF Core 10.0.10 genera esto:

```csharp
// WRONG: Alpha should become Zulu, Bravo should become Yankee
migrationBuilder.RenameColumn(name: "Bravo", table: "Customers", newName: "Zulu");
migrationBuilder.RenameColumn(name: "Alpha", table: "Customers", newName: "Yankee");
```

El emparejamiento está cruzado. Aplica eso y los datos de las dos columnas quedan intercambiados en silencio en todas las filas de la tabla. No se elimina nada, así que no se imprime ningún aviso de pérdida de datos, la migración se aplica sin errores, y la corrupción solo sale a la luz cuando una persona mira la pantalla. Lo reproduje en una tabla de dos columnas sin ningún otro cambio en el modelo.

La regla práctica: renombra una columna por migración cuando las columnas compartan tipo, o lee los pares `RenameColumn` generados y corrígelos a mano. Este es el mismo tipo de problema de corrupción silenciosa que [guardar un enum por su valor entero](/es/2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter/), donde el esquema sigue siendo válido mientras el significado de los datos cambia por debajo.

## Tres cosas que se siguen rompiendo tras una migración exitosa

**Las vistas, los procedimientos almacenados y los triggers conservan el nombre viejo.** `sp_rename` de SQL Server no persigue las referencias. La documentación es tajante: "Changing any part of an object name can break scripts and stored procedures." Una vista que selecciona de `Customers` no fallará en el momento del renombrado; falla la próxima vez que alguien la consulta. Antes de generar el scaffolding, lista lo que depende de la tabla:

```sql
SELECT OBJECT_NAME(referencing_id) AS referencing_object
FROM sys.sql_expression_dependencies
WHERE referenced_entity_name = 'Customers';
```

Después agrega operaciones `migrationBuilder.Sql("ALTER VIEW ...")` a la misma migración para que el renombrado y sus dependientes se muevan juntos.

**`dotnet ef database update --add` aplica la migración antes de que puedas leerla.** EF Core 11 agregó un comando de un solo paso que genera una migración, la compila con Roslyn y la aplica de inmediato. Eso es genuinamente útil para flujos con contenedores y Aspire, y es exactamente la herramienta equivocada para un renombrado, porque todo el procedimiento de seguridad de arriba depende de leer primero el archivo generado. Para cualquier migración que toque la identidad de una tabla existente, genera y aplica en dos comandos. La [funcionalidad de migración en un solo paso](/es/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/) vale la pena en todos los demás casos.

**Un renombrado no es compatible hacia atrás, así que rompe los despliegues progresivos.** Durante una implementación progresiva la versión antigua sigue corriendo y sigue emitiendo `SELECT ... FROM Customers` mientras la nueva espera `Clients`. Una única migración que renombra la tabla tumba las instancias viejas. Si necesitas cero tiempo de inactividad, el renombrado se convierte en una secuencia de varias implementaciones: crea una vista llamada `Customers` sobre `Clients` en la misma migración que el renombrado, implementa la versión nueva, y elimina la vista en una migración posterior cuando ninguna instancia referencie ya el nombre viejo.

Un último detalle que conviene revisar antes de hacer commit: el método `Down`. EF Core genera un inverso correcto para `RenameTable`, pero si editaste a mano `Up` para usar `sp_rename` sobre las constraints, `Down` sigue conteniendo el `DropPrimaryKey` y el `AddPrimaryKey` generados, y tu reversión no será simétrica. Si el snapshot del modelo y la base de datos llegan a divergir después de esto, te encontrarás con [la excepción de cambios pendientes en el modelo](/es/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/) en el siguiente arranque, y [registrar el SQL que genera EF Core](/es/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) es la forma más rápida de ver qué nombre cree el runtime que está consultando.

## Relacionado

- [Cómo aplicar migraciones de EF Core 11 en producción con dotnet ef migrations bundle](/es/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)
- [EF Core 11 te deja crear y aplicar una migración en un solo comando](/es/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/)
- [Fix: el modelo del contexto 'X' tiene cambios pendientes en EF Core 11](/es/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/)
- [Migrar de EF Core 6 a EF Core 11: los breaking changes que de verdad duelen](/es/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)
- [Cómo registrar el SQL que genera EF Core 11](/es/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)

## Fuentes

- [Managing migrations](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/managing) en Microsoft Learn, incluido el comando `dotnet ef database update --add` agregado en EF Core 11
- Referencia de la API [MigrationBuilder.RenameTable](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.migrations.migrationbuilder.renametable) para los parámetros `schema` y `newSchema`
- [sys.sp_rename](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-rename-transact-sql) para el renombrado de constraints y las advertencias sobre dependencias
- [sys.sql_expression_dependencies](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-sql-expression-dependencies-transact-sql) para encontrar los objetos que referencian una tabla antes de renombrarla
