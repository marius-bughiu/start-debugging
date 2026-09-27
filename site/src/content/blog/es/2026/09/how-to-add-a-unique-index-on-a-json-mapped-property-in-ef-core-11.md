---
title: "Cómo agregar un índice único en una propiedad mapeada a JSON en EF Core 11 (SQL Server y SQLite)"
description: "HasIndex(...).IsUnique() en un miembro ToJson() no impone unicidad en EF Core 11 RC 1: SQL Server descarta IsUnique y SQLite indexa el documento completo. Expón el valor JSON como una columna calculada y coloca el índice único sobre esa columna en su lugar."
pubDate: 2026-09-27
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "sqlite"
  - "json"
  - "dotnet-11"
lang: "es"
translationOf: "2026/09/how-to-add-a-unique-index-on-a-json-mapped-property-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-09-27
---

Respuesta corta: en EF Core 11 RC 1, no pongas `IsUnique()` en un índice sobre un miembro de una propiedad compleja `ToJson()`. No hace lo que el modelo indica. En SQL Server, EF emite `CREATE JSON INDEX`, que no tiene una forma única, y descarta `IsUnique()` en silencio. En SQLite, EF emite `CREATE UNIQUE INDEX ... ("Contact")`, con lo cual indexa el documento JSON completo, y se aceptan dos filas con el mismo correo electrónico. La solución que funciona en ambos proveedores es exponer el valor JSON como una propiedad sombra mapeada a una columna calculada (`JSON_VALUE` en SQL Server, `json_extract` en SQLite), poner `HasIndex(...).IsUnique()` sobre esa columna, y consultar a través de `EF.Property` para que el índice realmente se use.

Verifiqué todo lo que sigue contra `Microsoft.EntityFrameworkCore.SqlServer` y `Microsoft.EntityFrameworkCore.Sqlite` 11.0.0-rc.1.26425.128 en el SDK de .NET 11 RC 1 (11.0.100-rc.1.26425.128), C# 14. Ejecuté los resultados de SQLite contra una base de datos real en memoria. Generé el DDL de SQL Server con `GenerateCreateScript()` y el generador de SQL de migraciones, y no lo ejecuté contra un SQL Server 2025 real. Donde el comportamiento del servidor importa, cito la documentación de SQL Server.

## El modelo que parece correcto pero no lo es

EF Core 11 agregó índices sobre propiedades dentro de tipos complejos, incluyendo tipos complejos mapeados a una columna JSON. La [página de novedades](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) muestra que `HasIndex("Contact.Address.City")` produce un índice JSON de SQL Server. Es natural agregarle `.IsUnique()` y esperar una restricción:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128, C# 14
public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public Contact Contact { get; set; } = new();
}

public class Contact
{
    public string Email { get; set; } = "";
    public Address Address { get; set; } = new();
}

public class Address { public string City { get; set; } = ""; }

protected override void OnModelCreating(ModelBuilder mb)
{
    mb.Entity<Customer>().ComplexProperty(c => c.Contact, b => b.ToJson());
    mb.Entity<Customer>().HasIndex("Contact.Email").IsUnique(); // looks fine, is not
}
```

En SQL Server con nivel de compatibilidad 170, `GenerateCreateScript()` imprime:

```sql
CREATE TABLE [Customers] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    [Contact] json NOT NULL,
    CONSTRAINT [PK_Customers] PRIMARY KEY ([Id])
);
CREATE JSON INDEX [IX_Customers_Contact_Email] ON [Customers]([Contact]) FOR (N'$.Email');
```

No hay ningún `UNIQUE` en ninguna parte. La [sintaxis de CREATE JSON INDEX](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-json-index-transact-sql) no tiene ninguna opción de unicidad. Un índice JSON es una estructura de búsqueda para predicados `JSON_VALUE`, `JSON_PATH_EXISTS` y `JSON_CONTAINS`, no una restricción. En el nivel 160 obtienes el mismo `CREATE JSON INDEX` sobre una columna `nvarchar(max)`, que fallará al aplicarse, una trampa que cubrí en [json nativo vs nvarchar(max) en EF Core 11](/es/2026/09/json-vs-nvarchar-max-for-storing-json-in-sql-server-with-ef-core-11/). Con el registro en `Warning`, EF no registró nada sobre el `IsUnique()` descartado.

SQLite es peor, porque parece que funcionó:

```sql
CREATE TABLE "Customers" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_Customers" PRIMARY KEY AUTOINCREMENT,
    "Name" TEXT NOT NULL,
    "Contact" TEXT NOT NULL
);
CREATE UNIQUE INDEX "IX_Customers_Contact_Email" ON "Customers" ("Contact");
```

El índice lleva el nombre `Contact_Email`, pero la clave es toda la columna `"Contact"`. Inserté dos clientes con el mismo correo electrónico y ciudades distintas, y ambas llamadas a `SaveChanges` tuvieron éxito. Luego inserté dos clientes cuyos documentos `Contact` completos eran idénticos, y el segundo falló con `SQLite Error 19: 'UNIQUE constraint failed: Customers.Contact'`. Así que la restricción que obtienes es "ningún par de clientes puede tener documentos de contacto idénticos byte a byte", que no es una regla que nadie quiera.

Ambos comportamientos están reportados en el repositorio: [dotnet/efcore#39065](https://github.com/dotnet/efcore/issues/39065) para SQL Server y [dotnet/efcore#39064](https://github.com/dotnet/efcore/issues/39064) para SQLite. Npgsql tiene el mismo problema de columna completa para `jsonb` en [npgsql/efcore.pg#3918](https://github.com/npgsql/efcore.pg/issues/3918).

## Por qué una ruta JSON no puede ser una clave única directamente

Un índice único necesita una clave escalar por fila. Un documento JSON es un solo valor en una sola columna. La base de datos solo ve `$.Email` como un escalar si algo lo extrae:

- SQL Server no permite que la clave de un índice sea una expresión. El patrón documentado en [Index JSON data](https://learn.microsoft.com/en-us/sql/relational-databases/json/index-json-data) es una columna calculada sobre `JSON_VALUE` más un índice B-tree ordinario sobre ella. `JSON_VALUE` es determinista, y [CREATE INDEX](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-index-transact-sql) permite un índice `UNIQUE` sobre una columna calculada que sea determinista y precisa.
- SQLite sí admite índices sobre expresiones, y también admite columnas generadas. EF Core no tiene una API para un índice de expresión, pero sí tiene `HasComputedColumnSql`, que SQLite convierte en una columna generada.

Una columna calculada es la única forma que ambos proveedores admiten y que EF Core puede modelar, migrar y volver a leer. Esa es la solución.

## La solución: una columna calculada con un índice único

1. Agrega una propiedad sombra para el valor que quieres que sea único, y mapéala a una columna calculada que lo extraiga de la columna JSON.
2. Coloca `HasIndex(...).IsUnique()` sobre esa propiedad sombra, no sobre la ruta JSON.
3. En SQL Server, asegúrate de que EF no agregue su filtro `IS NOT NULL` predeterminado al índice (detalles más abajo).
4. Agrega una migración, revísala en busca de duplicados existentes antes de aplicarla, y consulta a través de `EF.Property` para que las búsquedas usen el índice.

Aquí está la configuración del modelo, escrita una sola vez para ambos proveedores:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128, C# 14
protected override void OnModelCreating(ModelBuilder mb)
{
    var customer = mb.Entity<Customer>();
    customer.ComplexProperty(c => c.Contact, b => b.ToJson());

    var emailSql = Database.IsSqlServer()
        ? "CAST(JSON_VALUE([Contact], '$.Email') AS nvarchar(320))"
        : "json_extract(\"Contact\", '$.Email')";

    customer.Property<string>("ContactEmail")
        .HasMaxLength(320)
        .HasComputedColumnSql(emailSql, stored: false)
        .IsRequired();

    customer.HasIndex("ContactEmail").IsUnique();
}
```

SQL Server, nivel 170 (el nivel 160 es idéntico excepto que `[Contact]` es `nvarchar(max)`):

```sql
CREATE TABLE [Customers] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    [ContactEmail] AS CAST(JSON_VALUE([Contact], '$.Email') AS nvarchar(320)),
    [Contact] json NOT NULL,
    CONSTRAINT [PK_Customers] PRIMARY KEY ([Id])
);
CREATE UNIQUE INDEX [IX_Customers_ContactEmail] ON [Customers] ([ContactEmail]);
```

SQLite:

```sql
CREATE TABLE "Customers" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_Customers" PRIMARY KEY AUTOINCREMENT,
    "Name" TEXT NOT NULL,
    "ContactEmail" AS (json_extract("Contact", '$.Email')),
    "Contact" TEXT NOT NULL
);
CREATE UNIQUE INDEX "IX_Customers_ContactEmail" ON "Customers" ("ContactEmail");
```

Con este modelo en SQLite, un segundo cliente con `a@x.com` falla en `SaveChanges` con `DbUpdateException` envolviendo `SQLite Error 19: 'UNIQUE constraint failed: Customers.ContactEmail'`. `ExecuteUpdate` también queda cubierto: `SetProperty(x => x.Contact.Email, "a@x.com")` sobre una fila distinta falló con el mismo error, porque la columna generada se recalcula a partir del documento actualizado. Después de `SaveChanges`, EF también lee el valor calculado de vuelta en la propiedad sombra (`Entry(e).Property("ContactEmail").CurrentValue` devolvió `a@x.com`), ya que las columnas calculadas son `ValueGenerated.OnAddOrUpdate`.

En SQL Server el duplicado aparece como `SqlException` número 2601 ("Cannot insert duplicate key row"). Captura `DbUpdateException` e inspecciona la excepción interna si quieres convertirlo en un error de validación.

Unas cuantas decisiones en ese código importan:

- **El `CAST` a `nvarchar(320)`.** `JSON_VALUE` devuelve `nvarchar(4000)`, y la [página de Index JSON data](https://learn.microsoft.com/en-us/sql/relational-databases/json/index-json-data) advierte que las claves de índice de más de 1700 bytes hacen fallar los inserts. 320 caracteres es el máximo práctico para una dirección de correo electrónico y son 640 bytes como `nvarchar`. Convierte al tipo más estrecho que quepa tu valor. Para números, convierte a `int` o `bigint`.
- **`stored: false`.** Ningún proveedor necesita que el valor esté persistido para poder indexarlo. En SQL Server, una columna calculada no persistida puede indexarse siempre que sea determinista y precisa. En SQLite, una columna generada virtual puede indexarse, y solo las virtuales pueden agregarse después con `ALTER TABLE`.
- **`IsRequired()`.** Esto no tiene que ver con la columna. Evita que EF agregue un filtro al índice, que es el tema de la siguiente sección.

## La trampa del filtro en SQL Server

Si dejas la propiedad sombra como opcional, el proveedor de SQL Server de EF hace lo mismo que hace para todo índice único sobre una columna anulable, y agrega un filtro:

```sql
CREATE UNIQUE INDEX [IX_Customers_ContactEmail] ON [Customers] ([ContactEmail]) WHERE [ContactEmail] IS NOT NULL;
```

Esa sentencia no se ejecutará. La [referencia de CREATE INDEX](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-index-transact-sql) establece que el predicado del filtro "can't reference a computed column" (no puede hacer referencia a una columna calculada). EF lo genera sin quejarse, así que te enteras cuando `dotnet ef database update` falla.

Dos salidas, ambas verificadas para eliminar la cláusula `WHERE` del SQL generado:

```csharp
// .NET 11 RC 1, EF Core 11 - either mark the value required...
customer.Property<string>("ContactEmail").IsRequired();

// ...or keep it optional and remove the filter explicitly
customer.HasIndex("ContactEmail").IsUnique().HasFilter(null);
```

Sin el filtro, SQL Server trata los NULL como iguales en un índice único, así que solo una fila puede carecer de correo electrónico. Si tu propiedad JSON realmente es opcional, incorpora un valor por fila en la expresión para que los correos faltantes nunca choquen entre sí. Por ejemplo: `ISNULL(CAST(JSON_VALUE([Contact], '$.Email') AS nvarchar(320)), N'#' + CAST([Id] AS nvarchar(11)))`. Es determinista y precisa, así que sigue siendo indexable. No ejecuté esta contra un servidor real. SQLite no tiene este problema: los NULL siempre son distintos en un índice único de SQLite, y EF no agrega ningún filtro ahí.

## Consulta a través de la columna, o el índice queda sin usar

El índice único impone la regla sin importar cómo escribas las consultas. Usarlo para búsquedas es un tema aparte. Un filtro LINQ simple sobre la ruta JSON no hace referencia a tu columna calculada:

```csharp
// .NET 11 RC 1, EF Core 11
db.Customers.Where(c => c.Contact.Email == email);
// SQL Server 170: WHERE JSON_VALUE([c].[Contact], '$.Email' RETURNING nvarchar(max)) = N'a@x.com'
// SQLite:         WHERE "c"."Contact" ->> 'Email' = 'a@x.com'
```

SQL Server puede hacer coincidir una expresión de consulta con una columna calculada equivalente, pero solo cuando las expresiones son iguales. `JSON_VALUE(... RETURNING nvarchar(max))` no es lo mismo que `CAST(JSON_VALUE(...) AS nvarchar(320))`. SQLite no hace coincidir expresiones de columnas generadas en absoluto. Con la CLI de sqlite3 3.50.6, `EXPLAIN QUERY PLAN` devolvió `SCAN c` tanto para `Contact ->> 'Email'` como para un `json_extract(Contact, '$.Email')` escrito a mano, y solo la referencia a la columna produjo `SEARCH c USING INDEX IX_Customers_ContactEmail (ContactEmail=?)`.

Así que filtra sobre la propiedad sombra:

```csharp
// .NET 11 RC 1, EF Core 11 - produces WHERE [c].[ContactEmail] = @email on both providers
var existing = await db.Customers
    .Where(c => EF.Property<string>(c, "ContactEmail") == email)
    .FirstOrDefaultAsync();
```

Si las cadenas de `EF.Property` te incomodan, mapea en su lugar una propiedad real de solo lectura (`public string ContactEmail { get; private set; } = "";`) con el mismo `HasComputedColumnSql`. EF la completa después de cada guardado, y tus consultas obtienen una lambda normal.

## Agregarlo a una tabla que ya tiene datos

La migración que EF genera consta de dos sentencias en cada proveedor:

```sql
-- SQL Server
ALTER TABLE [Customers] ADD [ContactEmail] AS CAST(JSON_VALUE([Contact], '$.Email') AS nvarchar(320));
CREATE UNIQUE INDEX [IX_Customers_ContactEmail] ON [Customers] ([ContactEmail]);

-- SQLite
ALTER TABLE "Customers" ADD "ContactEmail" AS (json_extract("Contact", '$.Email'));
CREATE UNIQUE INDEX "IX_Customers_ContactEmail" ON "Customers" ("ContactEmail");
```

El `ALTER TABLE` tiene éxito incluso cuando existen duplicados. El `CREATE UNIQUE INDEX` no. En SQLite, con dos filas existentes de `a@x.com`, falló con `UNIQUE constraint failed: Customers.ContactEmail (19)`. Encuentra primero a los infractores. EF traduce la agrupación sobre la ruta JSON sin necesidad de la columna nueva:

```csharp
// .NET 11 RC 1, EF Core 11 - run before applying the migration
var duplicates = await db.Customers
    .GroupBy(c => c.Contact.Email)
    .Where(g => g.Count() > 1)
    .Select(g => new { Email = g.Key, Count = g.Count() })
    .ToListAsync();
```

Limpia esas filas y luego aplica la migración. Para despliegues en producción, genera el SQL y revísalo en lugar de dejar que la aplicación se migre sola; el [flujo de trabajo de migrations bundle](/es/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) cubre eso. Si tu equipo impone convenciones de nombres para índices, la columna calculada se nombra como cualquier otra propiedad, así que las reglas de [convenciones de nombres personalizadas para claves e índices en EF Core 11](/es/2026/09/how-to-apply-custom-naming-conventions-for-keys-foreign-keys-and-indexes-in-ef-core-11/) se aplican a `IX_Customers_ContactEmail` sin casos especiales.

## Detalles a tener en cuenta antes de publicar

**La sensibilidad a mayúsculas y minúsculas difiere entre proveedores.** En SQLite inserté `a@x.com` y `A@X.com` y ambos fueron aceptados, porque SQLite compara con la intercalación `BINARY` de forma predeterminada. En SQL Server, la unicidad sigue la intercalación de la columna de origen, y para la mayoría de las bases de datos eso no distingue mayúsculas de minúsculas, así que el mismo par chocaría. Si la regla es "una cuenta por correo electrónico", normaliza: guarda los correos en minúsculas, o usa `lower(json_extract("Contact", '$.Email'))` en SQLite para que ambos proveedores coincidan. Mezclar proveedores entre pruebas y producción es donde esto muerde, una de las razones por las que [WebApplicationFactory vs Testcontainers](/es/2026/08/webapplicationfactory-vs-testcontainers-for-aspnetcore-integration-tests/) importa para las pruebas de reglas de datos.

**El nombre de la propiedad JSON es parte del SQL.** `$.Email` debe coincidir con lo que EF escribe en el documento. Si renombras la propiedad CLR, o configuras `HasJsonPropertyName("email")`, actualiza el SQL de la columna calculada en la misma migración. EF no lo hará por ti, porque la ruta es una cadena opaca. Un desajuste no falla: cada fila produce NULL, y tu regla "única" deja de imponer nada.

**Las colecciones complejas quedan fuera de alcance.** Un índice único necesita un valor por fila. Para "el SKU debe ser único en `Items[]`" necesitas una tabla hija, no una columna JSON. EF Core 11 puede indexar `Items[].Sku` para búsquedas en SQL Server, pero eso es un índice JSON, no una restricción.

**No confíes en un futuro `IsUnique()`.** La corrección para SQL Server, [dotnet/efcore#39090](https://github.com/dotnet/efcore/pull/39090), se fusionó en `release/11.0` el 2026-09-26, después de que saliera RC 1. No hace que los índices JSON sean únicos. Hace que el modelo falle la validación con `JSON index '{index}' on entity type '{entityType}' was configured with the '{option}' option, which is not supported on JSON indexes.` Eso es una mejora, ya que el descarte silencioso se convierte en un error ruidoso, pero la respuesta sigue siendo una columna calculada. El issue de SQLite seguía abierto cuando escribí esto.

**La columna calculada necesita las opciones SET habituales de SQL Server.** Los índices sobre columnas calculadas requieren configuraciones como `QUOTED_IDENTIFIER ON` y `ANSI_NULLS ON` para las sesiones que modifican la tabla. Los valores predeterminados de SqlClient las satisfacen, pero un script o herramienta legado que los desactive obtendrá errores al escribir en `Customers`.

Si todavía no has definido tu mapeo JSON, [cómo mapear y consultar columnas JSON en EF Core 11](/es/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) cubre `ComplexProperty(...).ToJson()` de principio a fin. Todo lo de aquí asume ese mapeo.

## Fuentes

- [Novedades de EF Core 11: claves e índices en propiedades de tipos complejos, índices JSON](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [CREATE JSON INDEX (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-json-index-transact-sql)
- [Index JSON data (columnas calculadas sobre JSON_VALUE)](https://learn.microsoft.com/en-us/sql/relational-databases/json/index-json-data)
- [CREATE INDEX (Transact-SQL): reglas de índices filtrados y columnas calculadas](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-index-transact-sql)
- [Columnas generadas en SQLite](https://www.sqlite.org/gencol.html)
- [dotnet/efcore#39065: IsUnique() en un índice sobre un miembro mapeado a JSON se descarta en silencio](https://github.com/dotnet/efcore/issues/39065)
- [dotnet/efcore#39064: el índice de SQLite sobre un miembro mapeado a JSON indexa toda la columna](https://github.com/dotnet/efcore/issues/39064)
- [dotnet/efcore#39090: valida las opciones de índice JSON de SQL Server no compatibles](https://github.com/dotnet/efcore/pull/39090)
- [npgsql/efcore.pg#3918: el índice sobre un miembro mapeado a JSON indexa toda la columna jsonb](https://github.com/npgsql/efcore.pg/issues/3918)
</content>
