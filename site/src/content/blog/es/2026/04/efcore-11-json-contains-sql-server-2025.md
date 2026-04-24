---
title: "EF Core 11 traduce Contains a JSON_CONTAINS en SQL Server 2025"
description: "EF Core 11 traduce automáticamente LINQ Contains sobre colecciones JSON a la nueva función JSON_CONTAINS de SQL Server 2025, y añade EF.Functions.JsonContains para queries con path y modos específicos que pueden golpear un índice JSON."
pubDate: 2026-04-20
tags:
  - ".NET 11"
  - "EF Core 11"
  - "SQL Server"
  - "JSON"
  - "LINQ"
lang: "es"
translationOf: "2026/04/efcore-11-json-contains-sql-server-2025"
translatedBy: "claude"
translationDate: 2026-04-24
---

SQL Server 2025 añadió una función nativa [`JSON_CONTAINS`](https://learn.microsoft.com/en-us/sql/t-sql/functions/json-contains-transact-sql), y EF Core 11 es el release que se enchufa a ella. Dos cosas cambian para cualquiera que almacene colecciones como columnas JSON: `Contains` sobre colecciones JSON ahora obtiene una traducción directa en lugar del viejo join `OPENJSON`, y hay un nuevo `EF.Functions.JsonContains()` para casos donde necesitas un path JSON o un modo de búsqueda específico. El trabajo es parte de [EF Core 11 Preview 3](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/efcore.md).

## Activando el nivel de compatibilidad de SQL Server 2025

La nueva traducción solo se enciende cuando el provider sabe que está hablando con SQL Server 2025. Lo haces vía `UseCompatibilityLevel(170)` en las opciones del provider:

```csharp
protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
    => optionsBuilder.UseSqlServer(
        connectionString,
        o => o.UseCompatibilityLevel(170));
```

El nivel de compatibilidad 170 es lo que reporta SQL Server 2025; los niveles inferiores seguirán usando la traducción más vieja, así que es seguro dejar esto sin tocar hasta que realmente actualices la base de datos.

## Cómo se ve Contains ahora

Toma una forma clásica de "tags como array JSON":

```csharp
public class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public List<string> Tags { get; set; } = new();
}

modelBuilder.Entity<Blog>()
    .Property(b => b.Tags)
    .HasColumnType("json"); // SQL Server 2025 native JSON type
```

En EF Core 10 o sobre un target de SQL Server más antiguo, esta query:

```csharp
var posts = await context.Blogs
    .Where(b => b.Tags.Contains("ef-core"))
    .ToListAsync();
```

te da la traducción `OPENJSON`, que se lee como una subconsulta correlacionada:

```sql
WHERE N'ef-core' IN (
    SELECT [t].[value]
    FROM OPENJSON([b].[Tags]) WITH ([value] nvarchar(max) '$') AS [t]
)
```

EF Core 11 contra el nivel de compatibilidad 170 emite esto en su lugar:

```sql
WHERE JSON_CONTAINS([b].[Tags], 'ef-core') = 1
```

La razón por la que esto importa no es solo lo bonito del SQL. `JSON_CONTAINS` es el único predicado en SQL Server 2025 que puede usar un [índice JSON](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-json-index-transact-sql). Si tienes `CREATE JSON INDEX IX_Tags ON Blogs(Tags)`, la ruta `OPENJSON` nunca lo tocará, pero la traducción de EF 11 sí.

Hay una trampa señalada en las release notes: `JSON_CONTAINS` no maneja NULL como lo hace `Contains` de LINQ, así que EF solo elige la nueva traducción cuando al menos un lado es demostrablemente no-nullable (una constante no-nula, o una columna no-nullable). Si ambos lados pueden ser null, EF cae a `OPENJSON` para preservar el comportamiento existente.

## Cuando necesitas un path o un modo de búsqueda

`Contains` cubre el caso de "este escalar está en el array". Para cualquier otra cosa, EF Core 11 expone `EF.Functions.JsonContains(container, value, path?, mode?)`. El ejemplo clásico es buscar un valor en un path específico dentro de un documento JSON estructurado:

```csharp
public class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public string JsonData { get; set; } = "{}"; // { "Rating": 8, ... }
}

var ratedEights = await context.Blogs
    .Where(b => EF.Functions.JsonContains(b.JsonData, 8, "$.Rating") == 1)
    .ToListAsync();
```

Se traduce a:

```sql
WHERE JSON_CONTAINS([b].[JsonData], 8, N'$.Rating') = 1
```

Puedes usarlo con columnas string escalares, con tipos complejos mapeados a JSON, y con tipos owned mapeados vía `OwnsOne(... b.ToJson())`. La comparación contra `= 1` es load-bearing: `JSON_CONTAINS` devuelve un `bit`, y EF lo preserva para que predicados compuestos como `WHERE ... AND JSON_CONTAINS(...) = 1` se mantengan SARGables contra un índice JSON.

Combina esto con [`EF.Functions.JsonPathExists`](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) para chequeos de "¿existe la propiedad?" y cubres la mayoría de la superficie de queries de columnas JSON sin bajar a SQL crudo. La lista completa de cambios del traductor de EF Core 11 está en el doc [What's New](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew).
