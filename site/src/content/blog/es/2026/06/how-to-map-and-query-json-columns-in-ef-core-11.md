---
title: "Cómo mapear y consultar columnas JSON en EF Core 11"
description: "Mapea un tipo anidado a una sola columna JSON con ComplexProperty(...).ToJson(), deja que EF Core 11 lo almacene en el tipo json nativo de SQL Server 2025 y luego consúltalo con LINQ que se traduce a JSON_VALUE, JSON_CONTAINS y JSON_PATH_EXISTS."
pubDate: 2026-06-23
template: how-to
tags:
  - "how-to"
  - "ef-core"
  - "ef-core-11"
  - "json"
  - "sql-server"
  - "dotnet-11"
lang: "es"
translationOf: "2026/06/how-to-map-and-query-json-columns-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-06-23
---

Respuesta corta: modela los datos anidados como un tipo complejo, llama a `ComplexProperty(b => b.Details, d => d.ToJson())` en `OnModelCreating`, y EF Core 11 mapea todo el grafo de objetos a una sola columna. En SQL Server 2025 (nivel de compatibilidad 170) esa columna es el tipo de datos `json` nativo, no `nvarchar(max)`. Luego la consultas con LINQ normal: `Where(b => b.Details.Viewers > 3)` se traduce a `JSON_VALUE(... RETURNING int)`, `b.Tags.Contains("ef-core")` se traduce a `JSON_CONTAINS`, y `EF.Functions.JsonPathExists(...)` comprueba una ruta. Las actualizaciones masivas dentro del documento también funcionan, mediante `ExecuteUpdateAsync` y la función `.modify()` del tipo `json` de SQL Server.

Este artículo usa `Microsoft.EntityFrameworkCore` 11.0.0 en .NET 11 con C# 14, contra SQL Server 2025. Las API de mapeo son independientes del proveedor, pero el SQL exacto y el tipo `json` nativo son específicos de SQL Server; PostgreSQL y SQLite usan sus propias funciones JSON para el mismo LINQ.

## Dos formas de mapear una columna a JSON, y por qué ahora se prefiere una

EF Core ha podido poner un objeto .NET anidado en una sola columna JSON desde hace tiempo, pero históricamente la única forma era mediante *tipos de entidad propios* (owned): `OwnsOne(...).ToJson()`. Eso sigue funcionando. El problema es que los tipos propios son tipos de entidad por debajo, así que arrastran identidad y semántica de referencia, lo que se filtra en tu código de formas sorprendentes.

A partir de EF Core 10 y estabilizado aún más en 11, la herramienta de modelado recomendada es el *tipo complejo*. Un tipo complejo no tiene clave, ni identidad, y tiene semántica de valor, que es exactamente lo que es un documento JSON dentro de una fila. Marca el tipo con `[ComplexType]` (o configúralo de forma fluida) y llama a `ToJson()`:

```csharp
// .NET 11, EF Core 11.0.0
public class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";

    public string[] Tags { get; set; } = [];     // primitive collection
    public required BlogDetails Details { get; set; }
}

[ComplexType]
public class BlogDetails
{
    public string? Description { get; set; }
    public int Viewers { get; set; }
}
```

```csharp
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Blog>()
        .ComplexProperty(b => b.Details, d => d.ToJson());
}
```

Aquí caen dos cosas en JSON. `Details` se convierte en columna JSON porque lo pediste con `ToJson()`. `Tags` se convierte en columna JSON automáticamente: EF mapea las colecciones de primitivos (`string[]`, `List<int>`, etc.) a una columna de arreglo JSON sin ninguna configuración, un comportamiento que existe desde EF Core 8.

## El tipo de datos json nativo, y cuándo lo obtienes

El *tipo* de columna depende de la base de datos a la que apuntes EF. Con EF Core 10 y 11, si configuras el proveedor con `UseAzureSql`, o con un nivel de compatibilidad de SQL Server de 170 o superior (que es lo que reporta SQL Server 2025), EF establece por defecto la columna al tipo de datos `json` nativo en lugar de `nvarchar(max)`:

```csharp
// .NET 11, EF Core 11.0.0 - opt into the SQL Server 2025 json type
protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
    => optionsBuilder.UseSqlServer(
        connectionString,
        o => o.UseCompatibilityLevel(170));
```

El modelo anterior produce entonces esta tabla:

```sql
CREATE TABLE [Blogs] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    [Tags] json NOT NULL,
    [Details] json NOT NULL,
    CONSTRAINT [PK_Blogs] PRIMARY KEY ([Id])
);
```

El tipo `json` nativo valida su contenido, lo almacena de forma más compacta que el texto y admite un índice JSON. Vale la pena señalar de entrada un detalle de las migraciones: si tu aplicación ya almacena JSON en columnas `nvarchar(max)` y subes el nivel de compatibilidad a 170, la siguiente migración que EF genere *cambiará esas columnas a `json`* automáticamente. Si no estás listo para eso, fija el tipo de columna de vuelta a `nvarchar(max)` explícitamente o mantén el nivel de compatibilidad por debajo de 170. Por debajo de 170, todo en este artículo sigue funcionando; los datos simplemente viven en una columna de texto y el SQL usa las funciones JSON antiguas basadas en cadenas.

## Configurando el mapeo, paso a paso

Aquí está la ruta mínima y ordenada desde una clase normal hasta una columna JSON consultable.

1. **Modela los datos anidados como un `[ComplexType]`.** Dale las propiedades que quieres dentro del documento. Las colecciones están permitidas dentro de un tipo complejo que se mapea a JSON, a diferencia de la división de tablas.
2. **Llama a `ToJson()` en `OnModelCreating`.** Usa `ComplexProperty(b => b.Details, d => d.ToJson())` para un solo objeto anidado. Para una colección de objetos anidados, usa `ComplexProperty` con un tipo de colección, y todo el arreglo se mapea a una columna.
3. **Apunta a SQL Server 2025 para el tipo nativo.** Establece `UseCompatibilityLevel(170)` (o `UseAzureSql`) para que la columna sea `json` en lugar de `nvarchar(max)`.
4. **Agrega una migración y aplícala.** `dotnet ef migrations add AddBlogDetailsJson` y luego `dotnet ef database update`. Inspecciona el `CREATE TABLE` generado para confirmar que el tipo de columna es el que esperas.
5. **Consulta y actualiza con LINQ normal.** Sin SQL crudo, sin serialización manual. Las secciones siguientes muestran a qué se traduce cada forma de LINQ.

## Consultando dentro del documento con LINQ

Esta es la parte que hace que valga la pena usar columnas JSON en lugar de un blob serializado que tienes que deserializar en memoria. Filtras, proyectas y ordenas sobre propiedades *dentro* del JSON, y EF lo traduce a funciones JSON del lado del servidor.

Filtrar sobre un escalar anidado lee a través de `JSON_VALUE` con una cláusula `RETURNING` tipada:

```csharp
// .NET 11, EF Core 11.0.0
var popular = await context.Blogs
    .Where(b => b.Details.Viewers > 3)
    .ToListAsync();
```

```sql
SELECT [b].[Id], [b].[Name], [b].[Tags], [b].[Details]
FROM [Blogs] AS [b]
WHERE JSON_VALUE([b].[Details], '$.Viewers' RETURNING int) > 3
```

La cláusula `RETURNING int` es lo que permite que la comparación ocurra como un entero en el servidor en lugar de una comparación de cadenas, lo cual es correcto y amigable con los índices.

### Buscar en una colección de primitivos: Contains se convierte en JSON_CONTAINS

Comprobar si un arreglo JSON contiene un valor es la consulta JSON más común. En SQL Server 2025, EF Core 11 traduce `Contains` sobre una colección de primitivos respaldada por JSON a la nueva función `JSON_CONTAINS`:

```csharp
var tagged = await context.Blogs
    .Where(b => b.Tags.Contains("ef-core"))
    .ToListAsync();
```

```sql
SELECT [b].[Id], [b].[Name], [b].[Tags], [b].[Details]
FROM [Blogs] AS [b]
WHERE JSON_CONTAINS([b].[Tags], 'ef-core') = 1
```

Eso reemplaza la traducción antigua y más lenta basada en `OPENJSON`, y `JSON_CONTAINS` puede usar un índice JSON si hay uno definido. Cubrí esta traducción en detalle en [el artículo sobre EF Core 11 y JSON_CONTAINS](/2026/04/efcore-11-json-contains-sql-server-2025/), incluyendo el cambio de nivel de compatibilidad que la activa. Un punto delicado: `JSON_CONTAINS` no puede buscar null, así que EF solo lo emite cuando puede demostrar que un lado no admite null (una constante no nula, o una columna o elemento no anulable). Cuando no puede, recurre a la forma `OPENJSON` para que la consulta siga devolviendo la respuesta correcta.

### Búsqueda con ruta y modo específicos: EF.Functions.JsonContains

Cuando necesitas buscar en una ruta específica dentro del documento, o especificar un modo de búsqueda, llama a `JSON_CONTAINS` directamente mediante `EF.Functions.JsonContains()`:

```csharp
var rated = await context.Blogs
    .Where(b => EF.Functions.JsonContains(b.JsonData, 8, "$.Rating") == 1)
    .ToListAsync();
```

```sql
SELECT [b].[Id], [b].[Name], [b].[JsonData]
FROM [Blogs] AS [b]
WHERE JSON_CONTAINS([b].[JsonData], 8, N'$.Rating') = 1
```

Acepta el valor JSON, el valor a buscar y, opcionalmente, una ruta y un modo de búsqueda. Funciona contra propiedades escalares de cadena, tipos complejos y tipos de entidad propios mapeados a JSON.

### ¿Existe esta ruta?: EF.Functions.JsonPathExists

Nuevo en EF Core 11, `EF.Functions.JsonPathExists()` comprueba si una ruta JSON está presente, traduciéndose a `JSON_PATH_EXISTS` de SQL Server (disponible desde SQL Server 2022). Esta es la herramienta correcta para "filas donde el documento tiene un campo opcional establecido":

```csharp
var withOptional = await context.Blogs
    .Where(b => EF.Functions.JsonPathExists(b.JsonData, "$.OptionalInt"))
    .ToListAsync();
```

```sql
SELECT [b].[Id], [b].[Name], [b].[JsonData]
FROM [Blogs] AS [b]
WHERE JSON_PATH_EXISTS([b].[JsonData], N'$.OptionalInt') = 1
```

## Actualizando dentro del documento sin cargarlo

Escribir en una columna JSON tiene dos modos. El familiar es el seguimiento de cambios: cargas la entidad, mutas la propiedad anidada, llamas a `SaveChanges`. EF serializa el documento actualizado y escribe la columna. Eso está bien para una fila.

El interesante es la actualización masiva directamente en la base de datos. EF Core 10 agregó soporte de `ExecuteUpdateAsync` para JSON, y se mantiene en 11. Dado el mapeo de tipo complejo anterior, puedes incrementar un contador dentro del JSON para todo un conjunto de resultados en un solo viaje de ida y vuelta:

```csharp
await context.Blogs.ExecuteUpdateAsync(s =>
    s.SetProperty(b => b.Details.Viewers, b => b.Details.Viewers + 1));
```

En SQL Server 2025 esto usa la función `.modify()` del tipo `json`, así que el servidor reescribe solo esa propiedad en su lugar en vez de leer y reserializar todo el documento:

```sql
UPDATE [b]
SET [Details].modify('$.Viewers', JSON_VALUE([b].[Details], '$.Viewers' RETURNING int) + 1)
FROM [Blogs] AS [b]
```

Un requisito firme: `ExecuteUpdate` en JSON solo funciona cuando el tipo está mapeado como un *tipo complejo*. No funciona para tipos de entidad propios. Esta es la razón más concreta para preferir tipos complejos en código nuevo, y el compromiso más amplio entre [`ExecuteUpdate` y cargar entidades para luego llamar a SaveChanges](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) también aplica aquí.

## Las columnas JSON ahora funcionan con herencia TPT y TPC

Hasta EF Core 11, los tipos complejos y las columnas JSON no podían usarse en tipos de entidad que usaban herencia tabla por tipo (TPT) o tabla por tipo concreto (TPC). Esa restricción desapareció en 11. Puedes mapear una propiedad JSON en un tipo base y usarla en toda la jerarquía:

```csharp
public abstract class Animal
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public required AnimalDetails Details { get; set; }
}

public class Dog : Animal { public string Breed { get; set; } = ""; }
public class Cat : Animal { public bool IsIndoor { get; set; } }

[ComplexType]
public class AnimalDetails
{
    public DateTime BirthDate { get; set; }
    public string? Veterinarian { get; set; }
}
```

```csharp
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Animal>()
        .UseTptMappingStrategy()
        .ComplexProperty(a => a.Details, b => b.ToJson());
}
```

Si mantienes un modelo de dominio con una jerarquía de herencia real, este es el cambio que te permite conservar TPT/TPC y aun así modelar como documento las partes compartidas y estructuradas de cada entidad.

## Casos límite que muerden

**Semántica de owned frente a complejo.** Con tipos de entidad propios, asignar un documento a otro (`blog.BillingDetails = blog.ShippingDetails`) lanza una excepción, porque la misma instancia de entidad no puede rastrearse dos veces. Los tipos complejos se comparan y asignan por valor, así que la asignación simplemente copia los campos. Si aún estás con tipos propios para JSON, migrar a tipos complejos elimina toda una categoría de estos errores; encaja bien con la disciplina de [usar records con EF Core 11 correctamente](/2026/04/how-to-use-records-with-ef-core-11-correctly/) para formas de valor inmutables.

**Los tipos complejos struct aún no pueden estar en colecciones.** EF Core 10 agregó soporte de `struct` y `record struct` para tipos complejos, lo que encaja bien con su semántica de valor. Pero una *colección* de tipos complejos struct no está soportada actualmente. Usa una clase si el tipo anidado vive en una lista.

**Los tipos complejos opcionales necesitan una propiedad requerida.** Un tipo complejo opcional (anulable) mapeado a JSON requiere al menos una propiedad requerida definida en el tipo, de lo contrario EF no puede distinguir un documento todo-null de uno ausente.

**La migración de nvarchar a json es automática.** Subir el nivel de compatibilidad a 170 reescribe las columnas JSON `nvarchar(max)` existentes al tipo `json` nativo en la siguiente migración. Revisa esa migración antes de aplicarla en producción; es un cambio de esquema en cada columna JSON a la vez.

**Indexación.** Un índice JSON es lo que hace que `JSON_CONTAINS` y las búsquedas por ruta sean rápidas a escala. El tipo `json` nativo admite `CREATE JSON INDEX`; las columnas de texto plano no. Si tus consultas JSON son rutas críticas, el tipo nativo más un índice es la diferencia entre un seek y un escaneo completo, la misma lección que aparece en [los cambios disruptivos de la migración de EF Core 6 a 11](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) en torno a los planes de consulta.

La versión corta: opta por `[ComplexType]` más `ToJson()`, apunta a SQL Server 2025 para que la columna sea `json` real, y luego trata el documento como cualquier otra parte de tu modelo en LINQ. EF Core 11 traduce el filtrado, el `Contains` del arreglo, las comprobaciones de ruta e incluso las actualizaciones masivas a funciones JSON del lado del servidor, así que el documento nunca tiene que hacer un viaje a la memoria solo para ser consultado.

## Fuentes

- [What's New in EF Core 11: complex types and JSON with TPT/TPC, JsonPathExists, JSON_CONTAINS](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [What's New in EF Core 10: native json data type, complex types ToJson, ExecuteUpdate for JSON](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew)
- [SQL Server json data type and the modify() method](https://learn.microsoft.com/en-us/sql/t-sql/data-types/json-data-type)
- [JSON_CONTAINS (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/functions/json-contains-transact-sql)
- [JSON_PATH_EXISTS (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/functions/json-path-exists-transact-sql)
</content>
