---
title: "Cómo mantener carpetas de migraciones separadas para varios DbContext en un proyecto de EF Core"
description: "Pasa --output-dir una vez por DbContext y EF Core mantiene cada migración posterior en esa carpeta y espacio de nombres. Por qué el diseño predeterminado queda desbalanceado, la colisión CS0111 que aparece con una carpeta compartida, cómo mover migraciones existentes y cuándo separar la tabla de historial."
pubDate: 2026-10-26
template: how-to
tags:
  - "ef-core"
  - "ef-core-10"
  - "ef-core-11"
  - "migrations"
  - "dotnet"
lang: "es"
translationOf: "2026/10/how-to-keep-separate-migrations-folders-for-multiple-dbcontexts-in-ef-core"
translatedBy: "claude"
translationDate: 2026-10-26
---

**Respuesta corta:** crea la primera migración de cada contexto con su propio `--output-dir`, por ejemplo `dotnet ef migrations add InitialCreate --context CatalogDbContext --output-dir Data/Migrations/Catalog` y lo mismo para `OrdersDbContext` con `Data/Migrations/Orders`. EF Core deriva el espacio de nombres de esa carpeta (`Shop.Data.Migrations.Catalog`), y cada `migrations add` posterior para el mismo contexto se guarda automáticamente junto a la migración y el snapshot anteriores, así que nunca tienes que volver a pasar `--output-dir`. No apuntes dos contextos a la misma carpeta: las migraciones con el mismo nombre se convierten en una sola clase parcial y la compilación falla con CS0111. Todo lo que sigue se ejecutó en EF Core 10.0.14 con `dotnet-ef` 10.0.14 en .NET 10 (SDK 10.0.302) contra SQLite. También revisé el código de scaffolding en la rama `release/11.0`, y la lógica de carpetas y espacios de nombres no cambia en EF Core 11.

## Qué hace EF Core cuando no eliges

Mucha gente nunca decide un diseño. Agregan un segundo `DbContext` al proyecto, se topan con el primer error, añaden `--context` y siguen adelante. Vale la pena ver qué produce eso, porque explica la mayoría de las estructuras de carpetas confusas que veo en repositorios reales.

Esta es la configuración que se usa en todo el artículo: un proyecto de consola llamado `Shop`, dos contextos, ambos apuntando al mismo archivo SQLite.

```csharp
// .NET 10, EF Core 10.0.14
// Data/Contexts.cs
using Microsoft.EntityFrameworkCore;

namespace Shop.Data;

public class Product { public int Id { get; set; } public string Name { get; set; } = ""; }
public class Order { public int Id { get; set; } public int ProductId { get; set; } public int Quantity { get; set; } }

public class CatalogDbContext(DbContextOptions<CatalogDbContext> options) : DbContext(options)
{
    public DbSet<Product> Products => Set<Product>();
}

public class OrdersDbContext(DbContextOptions<OrdersDbContext> options) : DbContext(options)
{
    public DbSet<Order> Orders => Set<Order>();
}
```

```csharp
// .NET 10, EF Core 10.0.14
// Program.cs
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Shop.Data;

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddDbContext<CatalogDbContext>(o => o.UseSqlite("Data Source=shop.db"));
builder.Services.AddDbContext<OrdersDbContext>(o => o.UseSqlite("Data Source=shop.db"));
using var host = builder.Build();
```

Sin `--context`, la herramienta se niega a adivinar:

```text
$ dotnet ef migrations add InitialCreate
More than one DbContext was found. Specify which one to use. Use the '-Context' parameter for PowerShell commands and the '--context' parameter for dotnet commands.
```

Agrega `--context` para cada uno y deja que EF Core elija la carpeta:

```bash
# dotnet-ef 10.0.14
dotnet ef migrations add InitialCreate --context CatalogDbContext
dotnet ef migrations add InitialCreate --context OrdersDbContext
```

El resultado queda desbalanceado:

```text
Migrations/
  20261026120305_InitialCreate.cs              namespace Shop.Migrations        (Catalog)
  20261026120305_InitialCreate.Designer.cs
  CatalogDbContextModelSnapshot.cs
  OrdersDb/
    20261026120307_InitialCreate.cs            namespace Shop.Migrations.OrdersDb
    20261026120307_InitialCreate.Designer.cs
    OrdersDbContextModelSnapshot.cs
```

El primer contexto en recibir una migración se queda con `Migrations/`. El segundo recibe una subcarpeta con el nombre del contexto sin el sufijo `Context`, así que `OrdersDbContext` se convierte en `OrdersDb`. Eso no es un error, es código deliberado en `MigrationsScaffolder`: cuando no pasas un directorio de salida y el espacio de nombres `Migrations` predeterminado ya contiene migraciones cuyo atributo `[DbContext]` apunta a un contexto distinto, EF Core cambia a `<RootNamespace>.Migrations.<ContextNameWithoutSuffix>`. Un contexto cuyo nombre no termina en `Context` obtiene `<Name>Migrations`. Esta lógica existe desde EF Core 3.1 y sigue ahí en la 11.

Funciona, pero depende del orden. Clona el repositorio desde cero, borra las migraciones y ejecuta los comandos en el otro orden, y las carpetas se intercambian. Además, la asimetría (un contexto en la raíz y otro anidado dentro) hace que `Migrations/` parezca pertenecer a ambos. Ser explícito cuesta un solo parámetro, una sola vez.

## El diseño explícito con --output-dir

Empieza desde cero y dale a cada contexto su propia carpeta en su primera migración:

```bash
# dotnet-ef 10.0.14
dotnet ef migrations add InitialCreate --context CatalogDbContext --output-dir Data/Migrations/Catalog
dotnet ef migrations add InitialCreate --context OrdersDbContext --output-dir Data/Migrations/Orders
```

```text
Data/
  Contexts.cs
  Migrations/
    Catalog/
      20261026120357_InitialCreate.cs           namespace Shop.Data.Migrations.Catalog
      20261026120357_InitialCreate.Designer.cs
      CatalogDbContextModelSnapshot.cs
    Orders/
      20261026120359_InitialCreate.cs           namespace Shop.Data.Migrations.Orders
      20261026120359_InitialCreate.Designer.cs
      OrdersDbContextModelSnapshot.cs
```

El valor de `--output-dir` es relativo al directorio del proyecto, y EF Core convierte los segmentos de la ruta en el sub-espacio de nombres, así que `Data/Migrations/Catalog` se convierte en `Shop.Data.Migrations.Catalog` (el espacio de nombres raíz viene del `RootNamespace` del proyecto). Si quieres un espacio de nombres que no refleje la carpeta, agrega `--namespace`:

```bash
# dotnet-ef 10.0.14
dotnet ef migrations add InitialCreate --context CatalogDbContext \
  --output-dir Data/Migrations/Catalog \
  --namespace Shop.Catalog.Migrations
```

En la Package Manager Console de Visual Studio las mismas opciones son `-Context`, `-OutputDir` y `-Namespace`:

```powershell
# EF Core 10.0.14 PMC tools
Add-Migration InitialCreate -Context CatalogDbContext -OutputDir Data\Migrations\Catalog
Add-Migration InitialCreate -Context OrdersDbContext -OutputDir Data\Migrations\Orders
```

## Solo pasas --output-dir una vez

Esta es la parte que la mayoría de las respuestas en internet omiten, y es la razón por la que la gente termina con scripts que repiten `--output-dir` para siempre. Después de la primera migración, la carpeta se mantiene. Cambié la entidad `Product` y agregué una segunda migración sin ningún directorio de salida:

```bash
# dotnet-ef 10.0.14
dotnet ef migrations add AddPrice --context CatalogDbContext
```

```text
Data/Migrations/Catalog/20261026120401_AddPrice.cs
Data/Migrations/Catalog/20261026120401_AddPrice.Designer.cs
```

Dos reglas en `MigrationsScaffolder` hacen que esto funcione:

1. **Espacio de nombres**: cuando no se indica un directorio de salida, la nueva migración reutiliza el espacio de nombres del último tipo de migración del contexto, y el snapshot reutiliza el espacio de nombres de la clase de snapshot existente.
2. **Directorio**: `Save` busca recursivamente en el directorio del proyecto el archivo de la migración anterior (`<PreviousMigrationId>.cs`) y escribe los archivos nuevos en la misma carpeta. El snapshot se encuentra de la misma forma, por el nombre de su archivo `CatalogDbContextModelSnapshot.cs`.

Así que la fuente de verdad es el lugar donde los archivos viven en ese momento. Eso tiene dos consecuencias prácticas. Primero, no hace falta poner un directorio de salida en un script ni en el `.config/dotnet-ef.json` de EF Core 11 (que de todas formas no tiene una clave output-dir). Segundo, puedes mover las migraciones más adelante y EF Core las seguirá, que es la siguiente sección.

Si pasas `--output-dir` explícitamente en una migración posterior, gana para los archivos de la migración, pero el snapshot se sigue escribiendo donde esté el archivo de snapshot existente. Apuntar una migración posterior a otro lugar divide entonces un contexto en dos carpetas. Evítalo.

## No compartas una carpeta entre contextos

¿Qué pasa si pasas el mismo `--output-dir` para ambos contextos? EF Core te lo permite, con una advertencia:

```bash
# dotnet-ef 10.0.14
dotnet ef migrations add InitialCreate --context CatalogDbContext --output-dir Migrations
dotnet ef migrations add InitialCreate --context OrdersDbContext --output-dir Migrations
```

```text
The namespace 'Shop.Migrations' contains migrations for a different DbContext. This can result in conflicting migration names. It's recommend to put migrations for different DbContext classes into different namespaces.
Done. To undo this action, use 'ef migrations remove'
```

La advertencia se queda corta. Ambos contextos ahora tienen una `partial class InitialCreate` en `Shop.Migrations`. Los nombres de archivo difieren porque las marcas de tiempo difieren, pero C# fusiona las declaraciones parciales en una sola clase, y la siguiente compilación falla:

```text
error CS0111: Type 'InitialCreate' already defines a member called 'Up' with the same parameter types
error CS0111: Type 'InitialCreate' already defines a member called 'Down' with the same parameter types
error CS0111: Type 'InitialCreate' already defines a member called 'BuildTargetModel' with the same parameter types
error CS0579: Duplicate 'Migration' attribute
```

La comprobación de nombres duplicados de EF Core (`The name 'InitialCreate' is used by an existing migration.`) solo mira las migraciones del mismo contexto, así que no puede detectar esto. Te pasará con cualquier nombre que ambos equipos elijan por casualidad: `InitialCreate`, `AddIndexes`, `Cleanup`. Una carpeta y un espacio de nombres por contexto hacen imposible la colisión.

## Mover las migraciones que ya tienes

Si tu proyecto ya tiene el diseño predeterminado desbalanceado, o todo en una sola carpeta, puedes reorganizarlo sin tocar la base de datos. EF Core encuentra las migraciones por reflexión: cualquier tipo que derive de `Migration` con un atributo `[DbContext(typeof(X))]` y un atributo `[Migration("<id>")]` pertenece al contexto `X`. La carpeta y el espacio de nombres son irrelevantes en tiempo de ejecución, y el ID de la migración en la tabla de historial no cambia.

Los pasos para cada contexto:

1. Mueve los archivos de migración del contexto (`<id>_<Name>.cs` y `<id>_<Name>.Designer.cs`) y su `<Context>ModelSnapshot.cs` a la nueva carpeta. El archivo `.cs` simple no tiene el atributo `[DbContext]`, así que busca por el ID de la migración en lugar de hacer grep del nombre del contexto, o dejarás atrás la mitad de cada migración.
2. Cambia la línea `namespace` de cada archivo movido, incluido el snapshot, al nuevo espacio de nombres.
3. Compila y luego ejecuta `dotnet ef migrations list --context <Context>` para confirmar que aparecen los mismos IDs.
4. Agrega la siguiente migración sin `--output-dir` y comprueba que cae en la nueva carpeta.

Hice exactamente esto en el proyecto roto con carpeta compartida de arriba: moví los tres archivos de `OrdersDbContext` a `Migrations/Orders`, cambié `namespace Shop.Migrations` por `namespace Shop.Migrations.Orders`, y la compilación pasó a verde. `migrations list --context OrdersDbContext` seguía listando `20261026120430_InitialCreate`, y una nueva migración `AddPlacedAt` cayó en `Migrations/Orders` con el espacio de nombres `Shop.Migrations.Orders` sin ningún parámetro adicional.

Haz el movimiento en un solo commit, sin otros cambios, de modo que el diff sean solo renombrados más ediciones de espacio de nombres de una línea. La revisión de código es trivial y `git log --follow` sigue funcionando.

## La tabla compartida __EFMigrationsHistory

Las carpetas son un asunto del código fuente. En la base de datos, ambos contextos escriben por defecto en la misma tabla de historial, porque el nombre de la tabla no depende del contexto. Después de aplicar ambos:

```bash
# dotnet-ef 10.0.14
dotnet ef database update --context CatalogDbContext
dotnet ef database update --context OrdersDbContext
```

```text
sqlite> select * from __EFMigrationsHistory;
20261026120357_InitialCreate|10.0.14
20261026120401_AddPrice|10.0.14
20261026120359_InitialCreate|10.0.14
```

No hay una columna de contexto. Cada contexto lee todas las filas y solo le importan los IDs que coinciden con sus propias migraciones, y por eso esto funciona bien la mayoría de las veces. El formato del ID es `yyyyMMddHHmmss_Name` con resolución de un segundo, así que dos contextos solo chocan si alguien genera el mismo nombre de migración para ambos en el mismo segundo, algo que puede pasar con un script que recorre los contextos en un bucle.

Si quieres separar el historial, por ejemplo porque los dos contextos se asignan a esquemas distintos o pertenecen a equipos diferentes, configura una tabla por contexto:

```csharp
// .NET 10, EF Core 10.0.14
builder.Services.AddDbContext<CatalogDbContext>(o => o.UseSqlite("Data Source=shop.db",
    sql => sql.MigrationsHistoryTable("__CatalogMigrationsHistory")));
```

`MigrationsHistoryTable` también acepta un esquema en los proveedores que soportan esquemas, como SQL Server: `sql.MigrationsHistoryTable("__EFMigrationsHistory", "catalog")`.

Aquí está la trampa: hacer esto en una base de datos que ya tiene migraciones aplicadas. La tabla nueva está vacía, así que EF Core piensa que no se ha ejecutado nada y vuelve a ejecutar `InitialCreate`:

```text
$ dotnet ef database update --context CatalogDbContext
SQLite Error 1: 'table "Products" already exists'.
```

Copia las filas del contexto a la nueva tabla antes de actualizar. En SQLite:

```sql
-- SQLite, run once per database before deploying the history table change
CREATE TABLE "__CatalogMigrationsHistory" (
    "MigrationId" TEXT NOT NULL CONSTRAINT "PK___CatalogMigrationsHistory" PRIMARY KEY,
    "ProductVersion" TEXT NOT NULL);

INSERT INTO "__CatalogMigrationsHistory"
SELECT "MigrationId", "ProductVersion" FROM "__EFMigrationsHistory"
WHERE "MigrationId" IN ('20261026120357_InitialCreate', '20261026120401_AddPrice');

DELETE FROM "__EFMigrationsHistory"
WHERE "MigrationId" IN ('20261026120357_InitialCreate', '20261026120401_AddPrice');
```

Después de eso, `database update --context CatalogDbContext` no hace nada y `migrations list` muestra ambas migraciones como aplicadas. Para una base de datos nueva no hace falta nada especial: el script generado empieza con `CREATE TABLE IF NOT EXISTS "__CatalogMigrationsHistory"`. Si implementas con un script idempotente o un bundle de migraciones, ejecuta la copia antes, en cada entorno.

## Cuando ambos contextos asignan la misma tabla

Las carpetas separadas no impiden que dos contextos generen DDL para la misma tabla. Supón que `OrdersDbContext` necesita acceso de lectura a los productos y le agregas `public DbSet<Product> Products => Set<Product>();`. La siguiente migración de `OrdersDbContext` contiene un `CreateTable(name: "Products", ...)`, que falla al implementar porque `CatalogDbContext` ya la creó.

Elige un dueño y excluye la tabla de las migraciones del otro contexto:

```csharp
// .NET 10, EF Core 10.0.14
public class OrdersDbContext(DbContextOptions<OrdersDbContext> options) : DbContext(options)
{
    public DbSet<Order> Orders => Set<Order>();
    public DbSet<Product> Products => Set<Product>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
        => modelBuilder.Entity<Product>()
            .ToTable("Products", t => t.ExcludeFromMigrations());
}
```

Con eso, el mismo `migrations add` produjo un método `Up` vacío. La entidad sigue siendo parte del modelo, así que las consultas y el seguimiento de cambios funcionan; solo las migraciones ignoran la tabla. Recuerda que un cambio de esquema en `Product` ahora debe migrarse a través de `CatalogDbContext`, y `OrdersDbContext` lo recoge mediante la clase de entidad compartida.

## Los demás comandos también necesitan --context

Cada comando de migraciones opera sobre un contexto, así que una vez que hay dos, `--context` es obligatorio en todos, no solo en `add`:

```bash
# dotnet-ef 10.0.14
dotnet ef migrations list   --context OrdersDbContext
dotnet ef migrations remove --context OrdersDbContext
dotnet ef migrations script --context OrdersDbContext --idempotent -o orders.sql
dotnet ef migrations bundle --context OrdersDbContext -o efbundle-orders
dotnet ef database update   --context OrdersDbContext
```

`migrations remove` elimina los archivos de la última migración dondequiera que estén (busca en el proyecto por nombre de archivo) y reescribe el snapshot en su carpeta existente, así que también respeta tu diseño. En tiempo de ejecución, llama a `Database.MigrateAsync()` una vez por contexto, en el orden que necesite tu esquema (primero el dueño de las tablas compartidas).

Si escribir `--context` te cansa, EF Core 11 puede leer un `context` predeterminado desde `.config/dotnet-ef.json`. Los parámetros de línea de comandos siguen teniendo prioridad, así que configurarías el contexto que migras con más frecuencia y pasarías `--context` para el otro.

## Un proyecto de migraciones separado por contexto

Las carpetas dentro de un solo proyecto bastan para la mayoría de las aplicaciones. Cuando los contextos se implementan por separado, o un equipo no debe poder tocar las migraciones del otro, mueve las migraciones de cada contexto a su propia biblioteca de clases e indícale a EF Core dónde encontrarlas:

```csharp
// .NET 10, EF Core 10.0.14
builder.Services.AddDbContext<CatalogDbContext>(o => o.UseSqlServer(catalogConnection,
    sql => sql.MigrationsAssembly("Shop.Migrations.Catalog")));
```

Luego ejecuta `dotnet ef migrations add` con `--project Shop.Migrations.Catalog --startup-project Shop --context CatalogDbContext`. La contrapartida es un proyecto más por contexto y una referencia desde el proyecto de inicio a cada proyecto de migraciones, de modo que se cargan en tiempo de ejecución. La [guía oficial para un proyecto de migraciones separado](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/projects) cubre la conexión.

## Relacionado

- [Fix: The model for context has pending changes in EF Core 11](/es/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/), que también aparece cuando agregas una migración para el contexto equivocado.
- [Deja de reescribir --project y --startup-project con .config/dotnet-ef.json](/es/2026/06/efcore-11-dotnet-ef-json-config-file/) en EF Core 11.
- [Cómo aplicar migraciones de EF Core 11 en producción con bundles de migraciones](/es/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/), un bundle por contexto.
- [Fix: There is already an object named 'X' in the database after resetting migrations](/es/2026/10/fix-there-is-already-an-object-named-in-the-database-after-resetting-ef-core-migrations/), la misma mecánica de la tabla de historial desde otro ángulo.
- [Fix: dotnet ef migrations add "Unable to create an object of type DbContext"](/es/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/) para cuando las herramientas de tiempo de diseño no pueden construir ninguno de los contextos.

## Fuentes

- [EF Core tools reference (.NET CLI)](https://learn.microsoft.com/en-us/ef/core/cli/dotnet), Microsoft Learn: `--context`, `--output-dir`, `--namespace`.
- [Using a Separate Migrations Project](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/projects), Microsoft Learn.
- [Custom Migrations History Table](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/history-table), Microsoft Learn.
- [Entity types: excluding from migrations](https://learn.microsoft.com/en-us/ef/core/modeling/entity-types#excluding-from-migrations), Microsoft Learn.
- [`MigrationsScaffolder.cs` on release/10.0](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore.Design/Migrations/Design/MigrationsScaffolder.cs), la definición del espacio de nombres predeterminado, la comprobación de migraciones ajenas y la reutilización del directorio descritas arriba.
