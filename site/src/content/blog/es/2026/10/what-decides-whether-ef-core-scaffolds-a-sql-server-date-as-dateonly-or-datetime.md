---
title: "¿Qué decide si EF Core genera una columna `date` de SQL Server como `DateOnly` o `DateTime`?"
description: "Lo decide la versión de EF Core del proveedor de SQL Server en tu proyecto de inicio: EF Core 7 y anteriores generan date como DateTime, EF Core 8 a 11 lo generan como DateOnly. Aquí está el mapeo de tipos que toma la decisión, la salida medida con EF Core 7, 8, 10 y 11 RC 2, y las dos formas de recuperar DateTime sin remapear en silencio la columna a datetime2."
pubDate: 2026-10-16
tags:
  - "ef-core"
  - "ef-core-10"
  - "ef-core-11"
  - "sql-server"
  - "scaffolding"
  - "dateonly"
lang: "es"
translationOf: "2026/10/what-decides-whether-ef-core-scaffolds-a-sql-server-date-as-dateonly-or-datetime"
translatedBy: "claude"
translationDate: 2026-10-16
---

**Respuesta corta:** lo decide una sola cosa, la versión de `Microsoft.EntityFrameworkCore.SqlServer` (y de `Microsoft.EntityFrameworkCore.Design`) que referencia tu proyecto de inicio cuando ejecutas `dotnet ef dbcontext scaffold`. El generador le pregunta a la fuente de mapeo de tipos del proveedor cuál es el tipo CLR por defecto de cada tipo de almacén. Hasta EF Core 7, esa consulta devuelve `DateTime` para `date` y `TimeSpan` para `time`. Desde EF Core 8, pasando por EF Core 10 y las versiones candidatas de EF Core 11, devuelve `DateOnly` y `TimeOnly`. No existe ningún interruptor de `dotnet ef` para cambiarlo. Si necesitas recuperar `DateTime`, puedes sobrescribir el mapeo de tipos en tiempo de diseño mediante `IDesignTimeServices`, o editar la plantilla T4. Si aplicas tal cual la corrección de plantilla de las notas oficiales de cambios importantes, tus columnas `date` terminan mapeadas como `datetime2` en runtime. El resto de este artículo muestra por qué y cómo arreglarlo.

Medí todo lo que sigue en macOS con el SDK 10.0.302 contra `Microsoft.EntityFrameworkCore.SqlServer` 7.0.20, 8.0.32, 10.0.13 y 11.0.0-rc.2.26504.105 (sobre el SDK 11.0.100-rc.1). En esta máquina no hay SQL Server, así que construí yo mismo el `DatabaseModel` que el generador normalmente lee de `INFORMATION_SCHEMA` y lo pasé por los servicios reales de tiempo de diseño de SQL Server. La ruta de generación de código (fábrica del modelo de scaffolding, generador de C#, plantillas T4) es la misma que ejecuta `dotnet ef dbcontext scaffold` después de leer el esquema.

## La fuente de mapeo de tipos decide, no la herramienta

Cuando generas el código, EF Core lee el tipo de almacén de cada columna (`date`, `datetime2`, `nvarchar(50)`, etcétera) y tiene que elegir un tipo CLR. No tiene una tabla de reglas de scaffolding aparte para esto. Llama a `IScaffoldingTypeMapper.FindMapping(storeType, ...)`, que le pide al `IRelationalTypeMappingSource` del proveedor el mapeo por defecto de ese tipo de almacén. El tipo CLR que el proveedor registre primero para `date` es el que acaba en tu entidad.

En EF Core 8 el proveedor de SQL Server incorporó soporte nativo para `DateOnly` y `TimeOnly` ([dotnet/efcore#24507](https://github.com/dotnet/efcore/issues/24507)) y los convirtió en los mapeos por defecto de `date` y `time`. La [página de cambios importantes de EF Core 8](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/breaking-changes#sqlserver-date-time-only) lo lista como un cambio de impacto medio que solo afecta a quienes trabajan con base de datos primero y vuelven a generar el código.

Aquí hay una sonda que le pregunta directamente al mapeador:

```csharp
// .NET 10, EF Core 10.0.13 (same code compiles against 7.0.20, 8.0.32, 11.0.0-rc.2)
// Reference Microsoft.EntityFrameworkCore.Design with IncludeAssets="all" so the code can see its types.
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;
using Microsoft.EntityFrameworkCore.Scaffolding.Internal;
using Microsoft.EntityFrameworkCore.SqlServer.Design.Internal;
using Microsoft.Extensions.DependencyInjection;

var services = new ServiceCollection();
new SqlServerDesignTimeServices().ConfigureDesignTimeServices(services);
services.AddEntityFrameworkDesignTimeServices();
var mapper = services.BuildServiceProvider().GetRequiredService<IScaffoldingTypeMapper>();

foreach (var storeType in new[] { "date", "time", "datetime", "datetime2", "smalldatetime", "datetimeoffset" })
    Console.WriteLine($"{storeType,-15} -> {mapper.FindMapping(storeType, keyOrIndex: false, rowVersion: false)?.ClrType.Name}");
```

Los resultados, una columna por versión del proveedor:

| Tipo de almacén | EF Core 7.0.20 | EF Core 8.0.32 | EF Core 10.0.13 | EF Core 11.0 RC 2 |
| --- | --- | --- | --- | --- |
| `date` | `DateTime` | `DateOnly` | `DateOnly` | `DateOnly` |
| `time` | `TimeSpan` | `TimeOnly` | `TimeOnly` | `TimeOnly` |
| `datetime` | `DateTime` | `DateTime` | `DateTime` | `DateTime` |
| `datetime2` | `DateTime` | `DateTime` | `DateTime` | `DateTime` |
| `smalldatetime` | `DateTime` | `DateTime` | `DateTime` | `DateTime` |
| `datetimeoffset` | `DateTimeOffset` | `DateTimeOffset` | `DateTimeOffset` | `DateTimeOffset` |

Estos son los hechos que lo deciden:

- **La versión del paquete del proveedor en el proyecto de inicio.** `dotnet ef` carga `Microsoft.EntityFrameworkCore.Design` y el proveedor desde la salida de compilación de tu proyecto, no desde el paquete de la herramienta, así que el mapeo viene de la versión de EF Core del proyecto. Fijar una versión anterior de la herramienta `dotnet-ef` no recupera `DateTime`. Solo consigues la advertencia de que la versión de las herramientas es anterior a la del runtime, o algo peor.
- **El tipo de almacén, no los datos.** Cambiaron `date` y `time`. `datetime`, `datetime2` y `smalldatetime` se generan como `DateTime` en todas las versiones, porque ninguno es solo fecha.
- **El proveedor.** Es una decisión de cada proveedor. Los servicios de tiempo de diseño de Npgsql (revisé la 10.0.3) también mapean `date` de PostgreSQL a `DateOnly` y `time` a `TimeOnly`.

Nada más influye: ni la versión de SQL Server, ni el nivel de compatibilidad de la base de datos, ni `--use-database-names`, ni `--data-annotations`.

## Cómo se ve el código generado antes y después

Generé el código de una tabla con una clave `int`, un `date NOT NULL`, un `date` anulable, un `time` y un `datetime2`. EF Core 7.0.20 escribe esto:

```csharp
// Scaffolded by EF Core 7.0.20
public partial class Order
{
    public int Id { get; set; }
    public DateTime OrderDate { get; set; }
    public DateTime? ShippedOn { get; set; }
    public TimeSpan CutoffTime { get; set; }
    public DateTime CreatedAt { get; set; }
}

// In ShopContext.OnModelCreating
modelBuilder.Entity<Order>(entity =>
{
    entity.Property(e => e.Id).ValueGeneratedNever();
    entity.Property(e => e.OrderDate).HasColumnType("date");
    entity.Property(e => e.ShippedOn).HasColumnType("date");
});
```

EF Core 8.0.32, 10.0.13 y 11.0 RC 2 escriben esto, idéntico en las tres:

```csharp
// Scaffolded by EF Core 8.0.32 / 10.0.13 / 11.0.0-rc.2
public partial class Order
{
    public int Id { get; set; }
    public DateOnly OrderDate { get; set; }
    public DateOnly? ShippedOn { get; set; }
    public TimeOnly CutoffTime { get; set; }
    public DateTime CreatedAt { get; set; }
}

// In ShopContext.OnModelCreating
modelBuilder.Entity<Order>(entity =>
{
    entity.Property(e => e.Id).ValueGeneratedNever();
});
```

Fíjate en lo que desapareció de `OnModelCreating`. En EF Core 7, `DateTime` se mapea a `datetime2` por convención, así que el generador tenía que escribir `HasColumnType("date")` para que la columna siguiera siendo `date`. En EF Core 8+, `DateOnly` se mapea a `date` por convención, así que el generador considera redundante `HasColumnType("date")` y lo omite. El tipo de columna ya no aparece en ningún lugar del código generado. Está implícito en el tipo CLR. Ese detalle es la razón por la que el camino obvio de vuelta a `DateTime` está roto.

## La corrección de plantilla de la documentación pierde el tipo de columna

La página de cambios importantes sugiere una mitigación: ejecutar `dotnet new ef-templates`, abrir `CodeTemplates/EFCore/EntityType.t4` y cambiar el tipo CLR cuando la columna es `date` o `time`:

```csharp
// EntityType.t4 snippet from the EF Core 8 breaking-changes page
var clrType = property.GetColumnType() switch
{
    "date" when property.ClrType == typeof(DateOnly) => typeof(DateTime),
    "date" when property.ClrType == typeof(DateOnly?) => typeof(DateTime?),
    "time" when property.ClrType == typeof(TimeOnly) => typeof(TimeSpan),
    "time" when property.ClrType == typeof(TimeOnly?) => typeof(TimeSpan?),
    _ => property.ClrType
};
```

Apliqué esa edición a las plantillas de EF Core 10.0.13 (`Microsoft.EntityFrameworkCore.Templates` 10.0.13) y volví a generar el código. Ahora la entidad dice `DateTime OrderDate`. Pero `DbContext.t4` sigue renderizando la API fluida a partir del modelo, donde la propiedad es `DateOnly`, así que sigue omitiendo `HasColumnType("date")`. Obtienes una propiedad `DateTime` sin tipo de columna en ningún lugar.

En runtime, EF Core aplica entonces la convención de `DateTime`, que es `datetime2`. Aquí hay un contexto que equivale a lo que produjo la plantilla, junto a otro con el tipo de columna restaurado:

```csharp
// .NET 10, EF Core 10.0.13
var day = new DateTime(2026, 10, 16);
foreach (DbContext db in new DbContext[] { new ImplicitContext(), new ExplicitContext() })
{
    var p = db.Model.FindEntityType(typeof(Order))!.FindProperty(nameof(Order.OrderDate))!;
    Console.WriteLine($"{db.GetType().Name}: {p.GetColumnType()}");
    Console.WriteLine(db.Set<Order>().Where(o => o.OrderDate == day).ToQueryString());
}

public class Order
{
    public int Id { get; set; }
    public DateTime OrderDate { get; set; }
}

public class ImplicitContext() : ShopContext(false); // what the docs' template produces
public class ExplicitContext() : ShopContext(true);  // with HasColumnType("date")

public abstract class ShopContext(bool explicitType) : DbContext
{
    protected override void OnConfiguring(DbContextOptionsBuilder o) => o.UseSqlServer("Server=.;Database=Shop");
    protected override void OnModelCreating(ModelBuilder b) => b.Entity<Order>(e =>
    {
        e.Property(x => x.Id).ValueGeneratedNever();
        if (explicitType) e.Property(x => x.OrderDate).HasColumnType("date");
    });
}
```

Salida:

```text
ImplicitContext: datetime2
DECLARE @day datetime2 = '2026-10-16T00:00:00.0000000';

SELECT [o].[Id], [o].[OrderDate]
FROM [Order] AS [o]
WHERE [o].[OrderDate] = @day
ExplicitContext: date
DECLARE @day date = '2026-10-16';

SELECT [o].[Id], [o].[OrderDate]
FROM [Order] AS [o]
WHERE [o].[OrderDate] = @day
```

Sin el tipo de columna, cada parámetro que se compara con esa columna viaja por la red como `datetime2`. `datetime2` tiene una [precedencia de tipo de datos](https://learn.microsoft.com/en-us/sql/t-sql/data-types/data-type-precedence-transact-sql) mayor que `date`, así que SQL Server convierte la columna a `datetime2` para la comparación. Entonces un `DateTime` con parte horaria nunca es igual a una fecha almacenada, mientras que un parámetro `date` habría descartado primero la hora. Si el proyecto también usa migraciones, `GenerateCreateScript()` ahora emite `[OrderDate] datetime2 NOT NULL`, y el siguiente `migrations add` que toque la tabla querrá alterar la columna. La mitad de `time` del fragmento es inofensiva, porque `TimeSpan` se mapea a `time` por convención de todos modos.

La corrección es un bloque más en la misma plantilla, justo después del `switch`, de modo que la propiedad cambiada lleve consigo su tipo de almacén:

```csharp
// CodeTemplates/EFCore/EntityType.t4, EF Core 10.0.13 templates, after the clrType switch
        usings.AddRange(code.GetRequiredUsings(clrType));

        if (clrType != property.ClrType)
        {
            // Keep the store type: DateTime/TimeSpan would otherwise map to datetime2/time by convention.
            usings.Add("System.ComponentModel.DataAnnotations.Schema");
#>
    [Column(TypeName = "<#= property.GetColumnType() #>")]
<#
        }
```

Luego reemplaza `property.ClrType` por `clrType` en las líneas de `needsNullable`, `needsInitializer` y de la propiedad, como muestra la documentación. Al volver a generar el código, la entidad queda así:

```csharp
// Scaffolded by EF Core 10.0.13 with the patched EntityType.t4
using System.ComponentModel.DataAnnotations.Schema;

public partial class Order
{
    public int Id { get; set; }

    [Column(TypeName = "date")]
    public DateTime OrderDate { get; set; }

    [Column(TypeName = "date")]
    public DateTime? ShippedOn { get; set; }

    [Column(TypeName = "time")]
    public TimeSpan CutoffTime { get; set; }

    public DateTime CreatedAt { get; set; }
}
```

El atributo se emite se pase o no `--data-annotations`, porque lo escribe el código de tu plantilla, no el generador de anotaciones. Eso es lo que quieres aquí, ya que el lado fluido nunca lo escribirá.

## La reversión más limpia: sobrescribir el mapeo de tipos en tiempo de diseño

El enfoque de la plantilla corrige la salida después de que EF ya decidió que la propiedad es `DateOnly`. Una opción más robusta es cambiar la decisión misma, lo que hace que EF Core 8+ se comporte exactamente como EF Core 7 para `date` y `time`, API fluida incluida. `dotnet ef` descubre cualquier implementación de `IDesignTimeServices` en el proyecto de inicio y la ejecuta **después** de los registros del proveedor y de EF (consulta `DesignTimeServicesBuilder.CreateServiceCollection`), así que un `AddSingleton` posterior gana:

```csharp
// .NET 10, EF Core 10.0.13 / 11.0. Lives in the startup project; only used by dotnet ef.
#pragma warning disable EF1001 // SqlServerTypeMappingSource is an internal API
using System.Data;
using Microsoft.EntityFrameworkCore.Design;
using Microsoft.EntityFrameworkCore.SqlServer.Infrastructure.Internal;
using Microsoft.EntityFrameworkCore.SqlServer.Storage.Internal;
using Microsoft.EntityFrameworkCore.Storage;
using Microsoft.Extensions.DependencyInjection;

public sealed class ShopDesignTimeServices : IDesignTimeServices
{
    public void ConfigureDesignTimeServices(IServiceCollection services)
        => services.AddSingleton<IRelationalTypeMappingSource, DateTimeScaffoldingTypeMappingSource>();
}

public sealed class DateTimeScaffoldingTypeMappingSource(
    TypeMappingSourceDependencies dependencies,
    RelationalTypeMappingSourceDependencies relationalDependencies,
    ISqlServerSingletonOptions sqlServerSingletonOptions)
    : SqlServerTypeMappingSource(dependencies, relationalDependencies, sqlServerSingletonOptions)
{
    protected override RelationalTypeMapping? FindMapping(in RelationalTypeMappingInfo mappingInfo)
        => mappingInfo.StoreTypeNameBase switch
        {
            "date" => new SqlServerDateTimeTypeMapping("date", DbType.Date),
            "time" => new SqlServerTimeSpanTypeMapping("time"),
            _ => base.FindMapping(mappingInfo)
        };
}
```

Con esto registrado, EF Core 10.0.13 genera la misma tabla con la salida de EF Core 7 byte por byte: `DateTime OrderDate`, `DateTime? ShippedOn`, `TimeSpan CutoffTime` y `HasColumnType("date")` de vuelta en `OnModelCreating`. Como ahora la comparación ocurre entre `DateTime` y su valor por defecto `datetime2`, el generador de código sabe que el tipo de columna explícito es necesario. Una columna `time(0)` también sale bien, como `HasColumnType("time(0)")`, donde EF Core 10 estándar escribe `TimeOnly` con `HasPrecision(0)`.

Tres cosas que debes saber de esta ruta:

- `SqlServerTypeMappingSource` vive en un espacio de nombres `Internal`, de ahí la supresión de `EF1001`. Su constructor tomaba dos parámetros en EF Core 8 y 9 y ganó `ISqlServerSingletonOptions` en EF Core 10, así que espera tener que tocar esta clase en las actualizaciones de versión mayor.
- Solo afecta al tiempo de diseño. Tu `DbContext` en runtime nunca ve este servicio, porque `IDesignTimeServices` solo lo invocan las herramientas.
- Usa `AddSingleton`, no `TryAddSingleton`. El proveedor ya registró su fuente de mapeo de tipos, así que un `TryAdd` no hace nada en silencio. La misma trampa aparece al [reemplazar el pluralizador de `dbcontext scaffold`](/es/2026/09/how-to-add-custom-pluralization-to-dotnet-ef-dbcontext-scaffold-with-ipluralizer/).

Si generas el código con EF Core Power Tools o su CLI `efcpt`, esto ya viene incorporado: su motor de ingeniería inversa incluye una sobrescritura de `SqlServerTypeMappingSource` que hace exactamente lo anterior, activada con `type-mappings` / `use-DateOnly-TimeOnly` en `efcpt-config.json`. El esquema de configuración publicado lista ese ajuste con un valor por defecto de `false`, así que revisa tu archivo de configuración en lugar de suponer qué tipo obtendrás.

## ¿Deberías revertir?

Normalmente no. Para una columna que guarda un día de calendario, `DateOnly` es el tipo honesto. Un `DateTime` mapeado a `date` lleva una hora y un `Kind` que la base de datos descarta, y esa discrepancia está detrás de muchos errores de un día de diferencia cuando los valores cruzan zonas horarias o fronteras JSON. EF Core 8+ traduce los miembros comunes de `DateOnly` en SQL Server, `System.Text.Json` lo serializa como `"2026-10-16"` de fábrica, y Dapper [vuelve a manejar `DateOnly` de forma nativa desde la 2.1.86](/es/2026/09/dapper-2-1-86-brings-back-dateonly-and-timeonly-support/).

Revierte cuando no puedas migrar a los consumidores en la misma versión: un ensamblado compartido de DTO, una capa de reportes que hace aritmética con `DateTime` por todas partes, o un equipo que vuelve a generar el código cada semana y no puede absorber unos cientos de errores de compilación de golpe. En ese caso elige una de las dos correcciones anteriores y hazla parte del repositorio, para que la siguiente persona que vuelva a generar el código obtenga los mismos tipos.

## Detalles que aparecen después de volver a generar el código

- **Modelos migrados a medias.** Si generas solo algunas tablas con `--table`, las entidades nuevas reciben `DateOnly` y las antiguas mantenidas a mano conservan `DateTime`. Ambas funcionan, ya que EF Core 8+ mapea `DateTime` con `HasColumnType("date")` sin problema, pero los joins y las comparaciones entre ellas ahora necesitan conversiones en C#. Decide un solo tipo por columna, no por fecha de scaffolding.
- **Los modelos code-first no se ven afectados.** El valor por defecto de una propiedad `DateTime` existente sigue siendo `datetime2`, y un `HasColumnType("date")` explícito sigue funcionando. No cambia nada en runtime al actualizar el paquete. Solo cambia el código recién generado. Si una migración de pronto quiere alterar una columna después de una actualización, busca un tipo de columna faltante como el de arriba, y luego lee [por qué EF Core informa de cambios pendientes en el modelo](/es/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/).
- **`datetime` sigue siendo `DateTime`.** Solo cambiaron `date` y `time`. Una columna `datetime` heredada (precisión de 3,33 ms) sigue generándose como `DateTime` con `HasColumnType("datetime")`, en todas las versiones.
- **Actualizar desde EF Core 6 o 7 con el paquete de ErikEJ.** Si usabas `ErikEJ.EntityFrameworkCore.SqlServer.DateOnlyTimeOnly` y `UseDateOnlyTimeOnly()` para obtener `DateOnly` antes de EF Core 8, elimina ambos al actualizar. El soporte ya viene incorporado. El resto de ese salto se cubre en [la guía de cambios importantes de EF Core 6 a 11](/es/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).
- **Revisa el SQL, no el C#.** El remapeo a `datetime2` de arriba compila, se ejecuta y devuelve resultados plausibles para valores a medianoche. La única forma de verlo es el tipo del parámetro, así que [registra el SQL que genera EF Core](/es/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) o llama a `ToQueryString()` una vez después de cualquier personalización del scaffolding.

## Relacionado

- [How to add custom pluralization to `dotnet ef dbcontext scaffold` with `IPluralizer`](/es/2026/09/how-to-add-custom-pluralization-to-dotnet-ef-dbcontext-scaffold-with-ipluralizer/), el otro gancho de `IDesignTimeServices` que querrás en la misma clase.
- [Migrate EF Core 6 to EF Core 11: the breaking changes that bite](/es/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)
- [Fix "The JSON value could not be converted to System.DateTime"](/es/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/), incluido el caso en que un valor de la red debería ser un `DateOnly`.
- [How to log the SQL that EF Core 11 generates](/es/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)

## Fuentes

- [Breaking changes in EF Core 8.0: SQL Server `date` and `time` now scaffold to `DateOnly` and `TimeOnly`](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/breaking-changes#sqlserver-date-time-only), Microsoft Learn.
- [dotnet/efcore#24507: DateOnly and TimeOnly support for SQL Server](https://github.com/dotnet/efcore/issues/24507)
- [Custom reverse engineering templates (T4)](https://learn.microsoft.com/en-us/ef/core/managing-schemas/scaffolding/templates), Microsoft Learn.
- [Design-time services](https://learn.microsoft.com/en-us/ef/core/cli/services), Microsoft Learn.
- [`DesignTimeServicesBuilder.cs` on the release/10.0 branch](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore.Design/Design/Internal/DesignTimeServicesBuilder.cs), dotnet/efcore.
- [Data type precedence (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/data-types/data-type-precedence-transact-sql), Microsoft Learn.
- [EF Core Power Tools `SqlServerTypeMappingSource`](https://github.com/ErikEJ/EFCorePowerTools/blob/master/src/Core/RevEng.Core.80/SqlServerTypeMappingSource.cs) and [efcpt config schema](https://github.com/ErikEJ/EFCorePowerTools/blob/master/samples/efcpt-schema.json), ErikEJ/EFCorePowerTools.
