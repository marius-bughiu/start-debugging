---
title: "EF Core 11 poda joins de referencia innecesarios en split queries"
description: "EF Core 11 Preview 3 remueve joins to-one redundantes de split queries y tira claves ORDER BY innecesarias. Un escenario reportado se volvió 29% más rápido, otro 22%. Así se ve el SQL ahora."
pubDate: 2026-04-18
tags:
  - "ef-core"
  - "dotnet-11"
  - "sql-server"
  - "performance"
  - "csharp"
lang: "es"
translationOf: "2026/04/efcore-11-preview-3-prunes-reference-joins-split-queries"
translatedBy: "claude"
translationDate: 2026-04-24
---

Las split queries de EF Core siempre han tenido una arista filosa: cuando mezclabas `Include` de navegaciones de referencia con `Include` de navegaciones de colección, cada query hija seguía re-joineando las tablas de referencia, aunque nada en esas queries de colección las necesitara. EF Core 11 Preview 3 arregla eso, junto con una sobre-especificación de `ORDER BY` relacionada. Las [release notes](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) cuantifican el impacto del benchmark en 29% para un escenario común de split-query y 22% para un caso de single-query. Es la clase de cambio que aparece en producción sin ninguna edición de LINQ de tu lado.

## El join extra que nunca era necesario

Considera la forma canónica: un blog con un `BlogType` to-one y `Posts` to-many, cargados con `AsSplitQuery()`:

```csharp
var blogs = context.Blogs
    .Include(b => b.BlogType)
    .Include(b => b.Posts)
    .AsSplitQuery()
    .ToList();
```

Las split queries corren un SQL por cada colección incluida, más la query raíz. La query raíz legítimamente necesita joinear `BlogType` para proyectar sus columnas. La query de colección para `Posts` no, porque solo proyecta columnas de post. EF Core 10 y anteriores seguían emitiendo el join:

```sql
-- Before EF Core 11
SELECT [p].[Id], [p].[BlogId], [p].[Title], [b].[Id], [b0].[Id]
FROM [Blogs] AS [b]
INNER JOIN [BlogType] AS [b0] ON [b].[BlogTypeId] = [b0].[Id]
INNER JOIN [Post] AS [p] ON [b].[Id] = [p].[BlogId]
ORDER BY [b].[Id], [b0].[Id]
```

Ese `INNER JOIN [BlogType]` extra se resuelve por cada fila, luego participa en el sort, sin razón de payload. EF Core 11 lo poda:

```sql
-- EF Core 11
SELECT [p].[Id], [p].[BlogId], [p].[Title], [b].[Id]
FROM [Blogs] AS [b]
INNER JOIN [Post] AS [p] ON [b].[Id] = [p].[BlogId]
ORDER BY [b].[Id]
```

Cuantas más navegaciones de referencia tenías empaquetadas en `Include`, más joins desaparecen. Si tu modelo de dominio se apoya en `Include` de lookups pequeños (`Country`, `Status`, `Currency`) junto con una colección real, esto es throughput esencialmente gratis.

## Sobre-especificación de ORDER BY, también se va

La segunda optimización aplica también a single queries. Cuando incluyes una navegación de referencia, EF históricamente emitía su clave en la cláusula `ORDER BY`, aunque la primary key del parent ya la determinaba a través de la foreign key:

```csharp
var blogs = context.Blogs
    .Include(b => b.Owner)
    .Include(b => b.Posts)
    .ToList();
```

Antes de EF Core 11:

```sql
ORDER BY [b].[BlogId], [p].[PersonId]
```

En EF Core 11:

```sql
ORDER BY [b].[BlogId]
```

`BlogId` es único, y `PersonId` estaba completamente determinado por `BlogId` vía el FK, así que mantenerlo en la clave de sort era puro costo. Tirarlo acorta la clave de sort, lo que importa una vez que la tabla es lo suficientemente grande para derramar a disco o una vez que el planner elige un merge join sobre el resultado.

## Cuándo lo notarás

Verás los mayores wins en queries con múltiples includes de referencia pequeños más uno o más includes de colección, ya que esos solían repetir los mismos joins innecesarios en cada query hija. Customer-order, invoice-with-lines, y blog-with-posts son los candidatos obvios. Queries sin `AsSplitQuery()`, y queries sin includes de referencia, obtienen la simplificación de `ORDER BY` pero no la poda de joins.

No hay cambio de API y nada que prender. Actualiza a EF Core 11.0.0-preview.3 (targeteando .NET 11 Preview 3), corre el mismo LINQ, y el SQL generado está más apretado. Los detalles del benchmark viven en el [issue de tracking de EF Core](https://github.com/dotnet/efcore/issues/29182).
