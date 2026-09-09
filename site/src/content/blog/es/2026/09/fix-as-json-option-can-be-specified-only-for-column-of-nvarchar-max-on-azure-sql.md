---
title: "Solución: AS JSON option can be specified only for column of nvarchar(max) type in WITH clause"
description: "EF Core emite [col] json '$.path' AS JSON dentro de OPENJSON WITH, y Azure SQL lo rechaza con el Msg 13618. Actualiza a EF Core 10.0.11+ o baja el nivel de compatibilidad del proveedor a 160."
pubDate: 2026-09-09
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "azure"
  - "json"
  - "dotnet-10"
lang: "es"
translationOf: "2026/09/fix-as-json-option-can-be-specified-only-for-column-of-nvarchar-max-on-azure-sql"
translatedBy: "claude"
translationDate: 2026-09-09
---

Actualiza `Microsoft.EntityFrameworkCore.SqlServer` a 10.0.11 o posterior. Antes de esa versión, EF Core generaba `[col] json '$.path' AS JSON` dentro de una cláusula `OPENJSON ... WITH` siempre que un tipo complejo mapeado a JSON contenía una colección anidada y el proveedor corría con nivel de compatibilidad 170. SQL Server 2025 acepta el tipo nativo `json` en esa posición; Azure SQL no, y lo rechaza con el Msg 13618. Si no puedes actualizar, pasa `o => o.UseCompatibilityLevel(160)`. Un detalle: la corrección solo se activa cuando EF sabe que está hablando con Azure SQL, es decir, cuando llamas a `UseAzureSql` y no a `UseSqlServer` con una cadena de conexión de Azure.

## El error en contexto

La excepción aparece como una `SqlException` normal en la primera consulta que entra en una colección JSON anidada:

```
Microsoft.Data.SqlClient.SqlException (0x80131904): AS JSON option can be specified only for column of nvarchar(max) type in WITH clause.
   at Microsoft.EntityFrameworkCore.Storage.RelationalCommand.ExecuteReaderAsync(RelationalCommandParameterObject parameterObject, CancellationToken cancellationToken)
   at Microsoft.EntityFrameworkCore.Query.Internal.SingleQueryingEnumerable`1.AsyncEnumerator.InitializeReaderAsync(AsyncEnumerator enumerator, CancellationToken cancellationToken)
   at Microsoft.EntityFrameworkCore.Storage.ExecutionStrategy.ExecuteAsync[TState,TResult](TState state, ...)
   at Microsoft.EntityFrameworkCore.EntityFrameworkQueryableExtensions.ToListAsync[TSource](IQueryable`1 source, CancellationToken cancellationToken)
```

El número de error del servidor es 13618. El SQL que lo produjo se ve así:

```sql
SELECT [p].[value]
FROM [Cars] AS [c]
CROSS APPLY OPENJSON([c].[CarConfiguration], '$.optionPackages') WITH (
    [packageId] nvarchar(max) '$.packageId',
    [partNumbers] json '$.partNumbers' AS JSON
) AS [o]
CROSS APPLY OPENJSON([o].[partNumbers]) WITH ([value] varchar(32) '$') AS [p]
WHERE [c].[Vin] = '1FA6P8TH8J5123456' AND [c].[DealerId] = 'DEALER-001' AND [o].[packageId] = N'PKG-SPORT'
```

La línea problemática es `[partNumbers] json '$.partNumbers' AS JSON`. Todo lo demás en la sentencia está bien.

La señal de que estás en la página correcta y no en una parecida: la falla depende del entorno. El mismo binario, el mismo modelo y la misma consulta funcionan contra una instancia local de SQL Server 2025 y fallan contra Azure SQL, incluso cuando ambas bases de datos reportan nivel de compatibilidad 170.

## Por qué ocurre

Chocan tres hechos independientes.

**`AS JSON` siempre ha exigido `nvarchar(max)`.** La [referencia de OPENJSON](https://learn.microsoft.com/en-us/sql/t-sql/functions/openjson-transact-sql) es explícita: "If you specify the `AS JSON` option, the type of the column must be **nvarchar(MAX)**." Esa regla es nueve años anterior al tipo nativo `json`.

**SQL Server 2025 relajó la regla, Azure SQL no.** El tipo de datos nativo `json` está disponible de forma general en Azure SQL Database y Azure SQL Managed Instance, y en versión preliminar en SQL Server 2025. Pero las [limitaciones del tipo de datos json](https://learn.microsoft.com/en-us/sql/t-sql/data-types/json-data-type#limitations) hacen una excepción específica con `OPENJSON`: "Currently, the `OPENJSON()` function doesn't accept the **json** data type in some platforms. Currently, it's an implicit conversion. Explicitly convert to **nvarchar(max)** first. In SQL Server 2025 (17.x), the `OPENJSON()` function does support **json**." Así que el tipo `json` en una cláusula `WITH` es una capacidad de SQL Server 2025 local, no de Azure SQL.

**`UseAzureSql` activa el nivel de compatibilidad 170 por defecto, y 170 es lo que hace que EF elija el tipo `json`.** En `SqlServerOptionsExtension`, `SqlServerDefaultCompatibilityLevel` es 160 mientras que `AzureSqlDefaultCompatibilityLevel` es 170. `SqlServerSingletonOptions.SupportsJsonType` devuelve true a partir de 170. La consecuencia práctica es que no tienes que optar por nada: cambiar de `UseSqlServer` a `UseAzureSql` basta para mover tus columnas JSON al tipo nativo `json` y empezar a emitir `json ... AS JSON` en las consultas generadas.

Antes de EF Core 10.0.11, `SqlServerQuerySqlGenerator.GenerateColumnInfo` escribía `columnInfo.TypeMapping.StoreType` tal cual para cada columna de la cláusula `WITH`. Cuando el tipo de almacenamiento era `json` y la columna llevaba `AS JSON`, eso producía SQL que solo SQL Server 2025 podía analizar.

Ten en cuenta que la forma de la consulta importa. Una columna JSON que solo lees entera nunca cae aquí, y tampoco un `Where` sobre un escalar dentro del documento. `AS JSON` aparece cuando la consulta entra en una colección anidada dentro del documento JSON, porque EF tiene que entregar ese arreglo anidado a una segunda llamada a `OPENJSON`. Si es la primera vez que ves cómo EF convierte documentos anidados en árboles de `OPENJSON`, la mecánica está cubierta en [mapear y consultar columnas JSON en EF Core 11](/es/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/).

## Reproducción mínima

El modelo necesita un tipo complejo mapeado a JSON, que contiene una colección de tipos complejos, que a su vez contiene una colección de primitivos. Esa es la forma reportada en [dotnet/efcore#38615](https://github.com/dotnet/efcore/issues/38615):

```csharp
// .NET 10, C# 14, Microsoft.EntityFrameworkCore.SqlServer 10.0.10
public class Car
{
    public int CarId { get; set; }
    public string Vin { get; set; } = null!;
    public string DealerId { get; set; } = null!;
    public CarConfiguration CarConfiguration { get; set; } = null!;
}

public class CarConfiguration
{
    public string? CurrentTrim { get; set; }
    public List<OptionPackage>? OptionPackages { get; set; }
}

public class OptionPackage
{
    public required string PackageId { get; set; }
    public required ICollection<string> PartNumbers { get; set; }
}
```

```csharp
// .NET 10, C# 14, Microsoft.EntityFrameworkCore.SqlServer 10.0.10
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Car>(builder =>
    {
        builder.ToTable("Cars");
        builder.HasKey(e => e.CarId);
        builder.Property(e => e.Vin).IsUnicode(false).HasMaxLength(32);
        builder.Property(e => e.DealerId).IsUnicode(false).HasMaxLength(32);

        builder.ComplexProperty(e => e.CarConfiguration, pp =>
        {
            pp.ToJson("CarConfiguration");
            pp.IsRequired();
            pp.Property(p => p.CurrentTrim).HasJsonPropertyName("currentTrim");

            pp.ComplexCollection(p => p.OptionPackages, op =>
            {
                op.HasJsonPropertyName("optionPackages");
                op.Property(o => o.PackageId).HasJsonPropertyName("packageId");
                op.PrimitiveCollection(o => o.PartNumbers)
                    .ElementType(e => e.IsUnicode(false).HasMaxLength(32))
                    .HasJsonPropertyName("partNumbers");
            });
        });
    });
}
```

En esa configuración no hay `HasColumnType("json")` a propósito. No lo necesitas: con nivel de compatibilidad 170 el proveedor elige el tipo nativo por su cuenta.

La consulta que falla es cualquier proyección que baja dos niveles:

```csharp
// .NET 10, C# 14, Microsoft.EntityFrameworkCore.SqlServer 10.0.10
var options = new DbContextOptionsBuilder<CarContext>()
    .UseAzureSql(connectionString)   // defaults to compatibility level 170
    .Options;

await using var ctx = new CarContext(options);

var partNumbers = await ctx.Cars
    .Where(c => c.Vin == "1FA6P8TH8J5123456" && c.DealerId == "DEALER-001")
    .SelectMany(c => c.CarConfiguration.OptionPackages!)
    .Where(op => op.PackageId == "PKG-SPORT")
    .SelectMany(op => op.PartNumbers)
    .ToListAsync();                  // Msg 13618 on Azure SQL
```

No necesitas una suscripción de Azure para ver el SQL defectuoso. `ToQueryString()` genera sin abrir una conexión, así que una aplicación de consola desechable con una cadena de conexión falsa basta para confirmar qué forma produce tu compilación. Ejecutar ese arnés contra 10.0.10 imprime la línea `[partNumbers] json '$.partNumbers' AS JSON` mostrada antes.

## La solución, en detalle

### 1. Actualiza a EF Core 10.0.11 o posterior

Esta es la solución real y no requiere cambios en el modelo ni en la consulta. [dotnet/efcore#38665](https://github.com/dotnet/efcore/pull/38665) aterrizó en la rama `release/10.0` el 2026-07-20 y salió en 10.0.11 (2026-08-11). El parche actual, 10.0.12, también lo trae.

```xml
<!-- .NET 10 -->
<PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="10.0.12" />
```

Misma reproducción, misma consulta, `Microsoft.EntityFrameworkCore.SqlServer` 10.0.12 y `UseAzureSql`:

```sql
SELECT [p].[value]
FROM [Cars] AS [c]
CROSS APPLY OPENJSON([c].[CarConfiguration], '$.optionPackages') WITH (
    [packageId] nvarchar(max) '$.packageId',
    [partNumbers] nvarchar(max) '$.partNumbers' AS JSON
) AS [o]
CROSS APPLY OPENJSON([o].[partNumbers]) WITH ([value] varchar(32) '$') AS [p]
WHERE [c].[Vin] = '1FA6P8TH8J5123456' AND [c].[DealerId] = 'DEALER-001' AND [o].[packageId] = N'PKG-SPORT'
```

El generador ahora sustituye el tipo solo en esa posición:

```csharp
// dotnet/efcore, SqlServerQuerySqlGenerator.GenerateColumnInfo, release/10.0
if (columnInfo.AsJson
    && columnInfo.TypeMapping.StoreType == "json"
    && (_sqlServerSingletonOptions.EngineType != SqlServerEngineType.SqlServer
        || _sqlServerSingletonOptions.SqlServerCompatibilityLevel < 170))
{
    Sql.Append("nvarchar(max)");
}
else
{
    Sql.Append(columnInfo.TypeMapping.StoreType);
}
```

Nada cambia en tu tabla. La columna sigue siendo `json` en disco; solo se reescribe la declaración de la cláusula `WITH`, y `OPENJSON` sigue aceptando la columna `json` como primer argumento mediante conversión implícita.

### 2. Si no puedes actualizar, baja el nivel de compatibilidad a 160

```csharp
// .NET 10, Microsoft.EntityFrameworkCore.SqlServer 10.0.9 or 10.0.10
optionsBuilder.UseAzureSql(connectionString, o => o.UseCompatibilityLevel(160));
```

Con 160, `SupportsJsonType` es false, la columna JSON se mapea a `nvarchar(max)`, y la cláusula `WITH` vuelve a `[partNumbers] nvarchar(max) '$.partNumbers' AS JSON`. Confirmado contra 10.0.10.

El costo no se limita a esa cláusula. El nivel de compatibilidad 160 también desactiva la traducción de `JSON_CONTAINS`, el soporte de `.modify()` del tipo `json` para `ExecuteUpdate`, y las demás traducciones exclusivas de 170 descritas en [la traducción de JSON_CONTAINS en EF Core 11](/es/2026/04/efcore-11-json-contains-sql-server-2025/). Más importante aún, cambia el tipo de columna del modelo, y el pipeline de migraciones lo notará. Leer el tipo de almacenamiento directamente del modelo relacional en 10.0.12 lo deja claro:

```
UseAzureSql (default compat 170)            Cars.CarConfiguration -> json
UseSqlServer + UseCompatibilityLevel(170)   Cars.CarConfiguration -> json
UseSqlServer + UseCompatibilityLevel(160)   Cars.CarConfiguration -> nvarchar(max)
```

Si tu tabla ya es `json` y bajas el nivel de compatibilidad, el siguiente `dotnet ef migrations add` generará un `ALTER COLUMN` de vuelta a `nvarchar(max)`. De todas formas SQL Server no te deja convertir una columna `json` a un tipo de cadena con `ALTER TABLE`, así que esa migración falla al desplegarse en lugar de reescribir tus datos en silencio. Trata 160 como una solución temporal en tiempo de ejecución y mantenlo fuera del modelo desde el que generas migraciones, o asume que te quedas con almacenamiento `nvarchar(max)` para siempre.

### 3. Verifica que realmente estás llamando a `UseAzureSql`

Esta es la parte que confunde a quienes actualizan y siguen viendo el error. Mira otra vez la condición del generador: sustituye `nvarchar(max)` cuando el tipo de motor no es `SqlServer`, o cuando es `SqlServer` con un nivel de compatibilidad inferior a 170. Apunta `UseSqlServer` a una cadena de conexión de Azure SQL, pide el nivel 170, y EF concluye que habla con un SQL Server 2025 local que soporta `json` en `OPENJSON`. En 10.0.12 esa combinación sigue emitiendo la línea que falla:

```sql
-- UseSqlServer + UseCompatibilityLevel(170), EF Core 10.0.12
CROSS APPLY OPENJSON([c].[CarConfiguration], '$.optionPackages') WITH (
    [packageId] nvarchar(max) '$.packageId',
    [partNumbers] json '$.partNumbers' AS JSON
) AS [o]
```

Ese comportamiento es correcto, no un segundo error: EF no puede saber a dónde apunta una cadena de conexión sin preguntarle al servidor. La solución es declarar el motor en el que estás. `UseAzureSql` existe desde EF Core 9.0 y además configura resiliencia de conexión apropiada para Azure sin costo adicional.

```csharp
// .NET 10, EF Core 9.0 and later
builder.Services.AddDbContext<CarContext>(options =>
    options.UseAzureSql(builder.Configuration.GetConnectionString("CarContext")));
```

Azure SQL Managed Instance usa la misma llamada. Azure Synapse tiene `UseAzureSynapse`, que reporta `SupportsJsonType` como false de forma incondicional, así que nunca llega a esta ruta de código.

### 4. Lo que no funciona: sobrescribir el tipo de la columna contenedora

La solución que parece obvia es forzar la columna JSON de vuelta a un tipo de cadena:

```csharp
// Does NOT fix the WITH clause
pp.ToJson("CarConfiguration");
pp.HasColumnType("nvarchar(max)");
```

En 10.0.10 con `UseSqlServer` en nivel 170, eso sigue emitiendo `[partNumbers] json '$.partNumbers' AS JSON`. La razón es que `HasColumnType` fija el tipo de almacenamiento de la columna contenedora, mientras que la entrada de la cláusula `WITH` para una colección anidada toma su tipo del mapeo de tipos JSON del proveedor, que se elige según el nivel de compatibilidad. Cambiar la columna externa no llega a la declaración interna. Recurre al salto de versión o al nivel de compatibilidad.

## Trampas y errores parecidos

**"The store type 'nvarchar(2000)' specified for JSON column ... is not supported by the current provider."** Error distinto, causa distinta. Este es una `InvalidOperationException` lanzada por la validación del modelo antes de generar cualquier SQL, y se dispara en todas las configuraciones, con Azure o sin él:

```
InvalidOperationException: The store type 'nvarchar(2000)' specified for JSON column 'CarConfiguration' in table 'Cars' is not supported by the current provider. JSON columns require a provider-specific JSON store type.
```

Significa que fijaste una columna JSON a un `nvarchar(x)` que no es MAX, algo que funcionaba en EF Core 9 y se convirtió en error de validación en EF Core 10 ([dotnet/efcore#37424](https://github.com/dotnet/efcore/issues/37424)). Usa `nvarchar(max)` o `json`, o elimina la llamada a `HasColumnType` y deja que el proveedor elija.

**SQL escrito a mano y `FromSql`.** El Msg 13618 es una regla de T-SQL, no de EF. Si la sentencia que falla es tu propio `OPENJSON ... WITH (Payload nvarchar(100) '$.payload' AS JSON)`, ninguna versión de EF lo arregla: amplía la declaración de la columna a `nvarchar(max)`. La página de [problemas comunes con JSON](https://learn.microsoft.com/en-us/sql/relational-databases/json/solve-common-issues-with-json-in-sql-server) en la documentación de SQL cubre la misma regla desde el lado de T-SQL. Como el SQL crudo se salta el pipeline de consultas, `ToQueryString()` no te ayudará aquí; el SQL que escribiste es el SQL que se ejecuta.

**SQL Server 2025 local no está afectado.** Si tu base de datos es SQL Server 2025 (17.x) y EF está configurado con `UseSqlServer` más nivel 170, `json ... AS JSON` es válido y el SQL anterior a 10.0.11 corre bien. Esa asimetría es justamente por lo que este error sobrevivió hasta que un cliente ejecutó la misma compilación contra Azure.

**El nivel de compatibilidad de EF no es el de la base de datos.** `UseCompatibilityLevel(170)` solo le dice a EF qué SQL puede generar. No ejecuta `ALTER DATABASE ... SET COMPATIBILITY_LEVEL`. Configurar EF en 170 contra una base de datos que sigue en 150 produce una familia de errores de sintaxis completamente distinta.

**Un `SELECT` que solo lee el documento completo es seguro.** Si el error apareció después de una refactorización aparentemente ajena, busca un nuevo `SelectMany`, `Any` o `Contains` sobre una colección anidada. Eso es lo que arrastra el segundo `OPENJSON` y la columna `AS JSON`. Activar el registro de SQL como se describe en [cómo registrar el SQL que genera EF Core 11](/es/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) te dice en una sola solicitud qué consulta cambió de forma.

## Tiene EF Core 11 la corrección

El mismo código del generador está presente en la rama `release/11.0`, así que `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0-rc.1.26425.128, publicado el 2026-09-08, trae la corrección. Ese paquete solo apunta a `net11.0`, así que verificarlo requiere un SDK de .NET 11; todos los ejemplos de SQL de arriba se produjeron con el SDK de .NET 10.0.302 contra EF Core 10.0.10, 10.0.11 y 10.0.12 usando `ToQueryString()`.

Si de todas formas estás llevando un modelo con mucho JSON a EF Core 11, conviene incluir esto en la misma pasada que las decisiones de mapeo de [tipos complejos frente a entidades propias](/es/2026/07/complex-types-vs-owned-entities-in-ef-core-11/) y los cambios a nivel de proveedor de [migrar de EF Core 6 a EF Core 11](/es/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/). La lección de fondo va más allá de este error: "Azure SQL" y "SQL Server 2025" no son el mismo objetivo, divergen en JSON en particular, y EF solo sabe en cuál estás porque tú se lo dijiste.

## Relacionado

- [Cómo mapear y consultar columnas JSON en EF Core 11](/es/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/)
- [EF Core 11 traduce Contains a JSON_CONTAINS en SQL Server 2025](/es/2026/04/efcore-11-json-contains-sql-server-2025/)
- [Tipos complejos frente a entidades propias en EF Core 11](/es/2026/07/complex-types-vs-owned-entities-in-ef-core-11/)
- [Cómo registrar el SQL que genera EF Core 11](/es/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [Migrar de EF Core 6 a EF Core 11: los cambios incompatibles que de verdad duelen](/es/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)

## Fuentes

- [dotnet/efcore#38615, excepción al consultar json que solo ocurre en Azure SQL con nivel de compatibilidad 170](https://github.com/dotnet/efcore/issues/38615)
- [dotnet/efcore#38665, corrección del fallo de OPENJSON AS JSON en Azure SQL cuando el tipo de columna es json con nivel de compatibilidad 170](https://github.com/dotnet/efcore/pull/38665)
- [dotnet/efcore#37424, EF10 SQL Server: los tipos JSON mapeados a nvarchar(x) ya no funcionan](https://github.com/dotnet/efcore/issues/37424)
- [OPENJSON (Transact-SQL), incluida la regla del tipo de columna para AS JSON](https://learn.microsoft.com/en-us/sql/t-sql/functions/openjson-transact-sql)
- [Limitaciones del tipo de datos json, sobre OPENJSON y el tipo json](https://learn.microsoft.com/en-us/sql/t-sql/data-types/json-data-type#limitations)
- [Proveedor de base de datos Microsoft SQL Server para EF Core, sobre UseAzureSql y los niveles de compatibilidad](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/)
- [Resolver problemas comunes con JSON en SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/json/solve-common-issues-with-json-in-sql-server)
