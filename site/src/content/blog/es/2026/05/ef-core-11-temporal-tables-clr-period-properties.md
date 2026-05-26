---
title: "EF Core 11 Preview 4: las columnas de período de las tablas temporales por fin pueden ser propiedades reales"
description: "EF Core 11 Preview 4 elimina la antigua restricción de propiedad shadow en las tablas temporales de SQL Server. PeriodStart y PeriodEnd ahora pueden ser propiedades CLR normales, configuradas con lambdas HasPeriodStart y HasPeriodEnd fuertemente tipadas."
pubDate: 2026-05-26
tags:
  - "ef-core"
  - "dotnet-11"
  - "sql-server"
  - "csharp"
  - "dotnet"
lang: "es"
translationOf: "2026/05/ef-core-11-temporal-tables-clr-period-properties"
translatedBy: "claude"
translationDate: 2026-05-26
---

EF Core ha admitido las tablas temporales de SQL Server desde la versión 6.0, pero con una restricción molesta: las columnas `PeriodStart` y `PeriodEnd` debían modelarse como propiedades shadow. Podías consultarlas con `EF.Property<DateTime>(entity, "PeriodStart")`, pero no podías ponerlas en tu clase de entidad y leerlas como cualquier otra columna. Esa restricción ha desaparecido en EF Core 11 Preview 4, publicado el 12 de mayo de 2026 como parte de [.NET 11 Preview 4](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-4/).

La solución llega como [efcore#38110](https://github.com/dotnet/efcore/pull/38110), cerrando una [incidencia abierta en 2021](https://github.com/dotnet/efcore/issues/26463). Es un cambio pequeño en líneas y enorme en ergonomía.

## Cómo se veía el antiguo modelo de propiedad shadow

Antes de Preview 4, una entidad temporal solo podía declarar las columnas de la aplicación. Las columnas de período vivían en el modelo, pero no en la clase:

```csharp
public class Order
{
    public int Id { get; set; }
    public string Status { get; set; } = "";
}

modelBuilder.Entity<Order>().ToTable(tb => tb.IsTemporal());
```

Leer los valores de período implicaba pasar por el change tracker:

```csharp
var start = context.Entry(order).Property<DateTime>("PeriodStart").CurrentValue;
var end   = context.Entry(order).Property<DateTime>("PeriodEnd").CurrentValue;
```

Dos problemas. Primero, pierdes IntelliSense y seguridad de refactor: el nombre de la columna es una cadena mágica. Segundo, proyectar valores de período en una consulta LINQ es incómodo porque la propiedad no existe en el tipo CLR. Mapear un DTO que incluya la ventana de validez exigía o bien una consulta SQL en crudo o `EF.Property<>` dentro del `Select`, ambas opciones peleadas con el sistema de tipos.

## El modelo de Preview 4

En Preview 4 puedes simplemente poner las columnas de período en la entidad:

```csharp
public class Order
{
    public int Id { get; set; }
    public string Status { get; set; } = "";
    public DateTime PeriodStart { get; set; }
    public DateTime PeriodEnd { get; set; }
}
```

Configúralas con las nuevas sobrecargas fuertemente tipadas de `HasPeriodStart` y `HasPeriodEnd` que aceptan una lambda:

```csharp
modelBuilder.Entity<Order>().ToTable(tb => tb.IsTemporal(ttb =>
{
    ttb.HasPeriodStart(o => o.PeriodStart);
    ttb.HasPeriodEnd(o => o.PeriodEnd);
}));
```

Ahora `PeriodStart` y `PeriodEnd` se comportan como cualquier otra columna mapeada. Puedes leerlas en una entidad materializada, proyectarlas en `Select`, ordenar por ellas y filtrar por ellas en LINQ normal:

```csharp
var openOrders = await context.Orders
    .Where(o => o.PeriodEnd == DateTime.MaxValue)
    .Select(o => new { o.Id, o.Status, o.PeriodStart })
    .ToListAsync();
```

Ese predicado `PeriodEnd == DateTime.MaxValue` es el filtro canónico de "fila actual" para las tablas temporales de SQL Server. Antes había que escribirlo contra la propiedad shadow.

## Lo que no cambia

La semántica de la tabla temporal del lado de la base de datos es idéntica. SQL Server sigue manteniendo la tabla de historial, sigue actualizando `PeriodStart` y `PeriodEnd` en cada escritura y sigue rechazando escrituras directas a las columnas de período. EF Core las sigue marcando como `ValueGeneratedOnAddOrUpdate` y las ignora en insert y update. Puedes leerlas, no puedes asignarlas.

Las consultas de viaje en el tiempo también funcionan igual:

```csharp
var snapshot = await context.Orders
    .TemporalAsOf(new DateTime(2026, 5, 1))
    .ToListAsync();
```

La única diferencia es que las entidades devueltas ahora llevan los valores de período en el objeto CLR en lugar de ocultarlos detrás de `EF.Property<>`.

## La migración es opcional

Si tienes un modelo existente con columnas de período shadow, no necesitas cambiar nada. La API antigua sigue funcionando. Para cualquier entidad temporal nueva, poner `PeriodStart` y `PeriodEnd` en la clase es ahora el camino de menor resistencia.

Notas completas de EF Core de Preview 4: [release-notes/11.0/preview/preview4/efcore.md](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview4/efcore.md).
