---
title: "Columna json nativa vs nvarchar(max) para almacenar JSON en SQL Server con EF Core 11"
description: "Usa el tipo json nativo en SQL Server 2025 y Azure SQL: EF Core 11 obtiene de él JSON_CONTAINS, JSON_VALUE tipado, modify() en el lugar e índices JSON. Quédate en nvarchar(max) para SQL Server 2019/2022, herramientas heredadas o un esquema que debas poder revertir."
pubDate: 2026-09-12
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "json"
  - "dotnet-11"
lang: "es"
translationOf: "2026/09/json-vs-nvarchar-max-for-storing-json-in-sql-server-with-ef-core-11"
translatedBy: "claude"
translationDate: 2026-09-12
---

Respuesta corta: si tu base de datos es SQL Server 2025 o Azure SQL, almacena el JSON en el tipo nativo `json`. Con él, EF Core 11 emite `JSON_VALUE(... RETURNING int)` tipado, traduce `Contains` sobre una colección primitiva a `JSON_CONTAINS`, ejecuta `ExecuteUpdate` mediante el método `.modify()` en el lugar y puede crear un `CREATE JSON INDEX`. Nada de eso funciona sobre `nvarchar(max)`. Quédate en `nvarchar(max)` si usas SQL Server 2019 o 2022, si tienes herramientas que leen la columna en bruto (formato nativo de bcp, clientes ODBC antiguos) o si necesitas un cambio de esquema que puedas revertir: SQL Server se niega a hacer `ALTER` de una columna `json` de vuelta a un tipo de cadena.

Todo lo que sigue se comprobó con `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0-rc.1.26425.128 sobre el SDK de .NET 11 RC 1 (11.0.100-rc.1.26425.128), con C# 14. El comportamiento del lado del servidor proviene de la documentación de SQL Server 2025 (17.x).

## La comparación de un vistazo

| | `json` (nativo) | `nvarchar(max)` |
| --- | --- | --- |
| Disponible en | SQL Server 2025, Azure SQL Database, Azure SQL MI, SQL database en Fabric | Todas las versiones de SQL Server |
| Predeterminado de EF Core 11 cuando | `UseAzureSql`, o `UseCompatibilityLevel(170)` | `UseSqlServer` (nivel predeterminado 160) |
| Almacenamiento | Binario ya analizado, UTF-8 (`Latin1_General_100_BIN2_UTF8`), hasta 2 GB | Texto UTF-16 |
| Validación al escribir | Siempre; el nivel superior debe ser un objeto o un arreglo | Ninguna, salvo que agregues `CHECK (ISJSON(...) = 1)` |
| SQL de filtro escalar | `JSON_VALUE(col, '$.x' RETURNING int)` | `CAST(JSON_VALUE(col, '$.x') AS int)` |
| `tags.Contains("x")` | `JSON_CONTAINS(col, N'x') = 1` | `N'x' IN (SELECT ... FROM OPENJSON(col) ...)` |
| `ExecuteUpdate` sobre una propiedad | `SET [col].modify('$.x', ...)` | `SET col = JSON_MODIFY(col, '$.x', ...)` |
| `CREATE JSON INDEX` | Sí (SQL Server 2025, versión preliminar) | No |
| Tipo de parámetro que envía EF | `SqlDbType.Json` | `SqlDbType.NVarChar` |
| Revertir con `ALTER COLUMN` | No permitido | N/A |
| Lo que ven los clientes antiguos | `varchar(max)` o `nvarchar(max)` | `nvarchar(max)` |

## Qué cambia cuando EF Core 11 elige el tipo json

EF no decide en función de la base de datos a la que se conecta. Decide en función del nivel de compatibilidad que configuras, y lo hace al construir el modelo. Armé una pequeña prueba que configura el mismo modelo de cuatro maneras e imprime el DDL y el SQL, con un interceptor que suprime la conexión para que no haga falta ninguna base de datos:

```csharp
// .NET 11 RC 1, C# 14, Microsoft.EntityFrameworkCore.SqlServer 11.0.0-rc.1.26425.128
public class Order
{
    public int Id { get; set; }
    public string Customer { get; set; } = "";
    public string[] Tags { get; set; } = [];          // primitive collection, always JSON
    public required Shipping Shipping { get; set; }   // complex type mapped with ToJson()
}

public class Shipping
{
    public string City { get; set; } = "";
    public int Priority { get; set; }
}

protected override void OnModelCreating(ModelBuilder mb)
    => mb.Entity<Order>().ComplexProperty(o => o.Shipping, s => s.ToJson());
```

Con un simple `UseSqlServer(connectionString)`, EF Core 11 funciona con el nivel de compatibilidad 160. Ese valor predeterminado cambió en EF Core 11: EF Core 10 usaba 150. Ambas columnas JSON salen como `nvarchar(max)`:

```sql
-- UseSqlServer, default level 160
CREATE TABLE [Orders] (
    [Id] int NOT NULL,
    [Customer] nvarchar(max) NOT NULL,
    [Tags] nvarchar(max) NOT NULL,
    [Shipping] nvarchar(max) NOT NULL,
    CONSTRAINT [PK_Orders] PRIMARY KEY ([Id])
);
```

Cambia a `UseSqlServer(cs, o => o.UseCompatibilityLevel(170))`, o a `UseAzureSql(cs)` (cuyo valor predeterminado es 170), y el mismo modelo produce `[Tags] json NOT NULL` y `[Shipping] json NOT NULL`. Nada más cambia en tu código. Eso es lo primero que hay que interiorizar: **pasar de `UseSqlServer` a `UseAzureSql` es un cambio de tipo de columna**, lo quieras o no.

Las consultas también cambian. Estas son las tres formas de LINQ que más importan, tal como se generan en cada nivel:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1
ctx.Orders.Where(o => o.Shipping.Priority > 2);
ctx.Orders.Where(o => o.Tags.Contains("gift"));
await ctx.Orders.Where(o => o.Id == 1)
    .ExecuteUpdateAsync(s => s.SetProperty(o => o.Shipping.Priority, o => o.Shipping.Priority + 1));
```

En el nivel 160 (`nvarchar(max)`):

```sql
WHERE CAST(JSON_VALUE([o].[Shipping], '$.Priority') AS int) > 2

WHERE N'gift' IN (
    SELECT [t].[value]
    FROM OPENJSON([o].[Tags]) WITH ([value] nvarchar(max) '$') AS [t]
)

UPDATE [o]
SET [o].[Shipping] = JSON_MODIFY([o].[Shipping], '$.Priority', CAST(JSON_VALUE([o].[Shipping], '$.Priority') AS int) + 1)
FROM [Orders] AS [o]
WHERE [o].[Id] = 1
```

En el nivel 170 (`json`):

```sql
WHERE JSON_VALUE([o].[Shipping], '$.Priority' RETURNING int) > 2

WHERE JSON_CONTAINS([o].[Tags], N'gift') = 1

UPDATE [o]
SET [Shipping].modify('$.Priority', JSON_VALUE([o].[Shipping], '$.Priority' RETURNING int) + 1)
FROM [Orders] AS [o]
WHERE [o].[Id] = 1
```

En la ruta de escritura, `SaveChanges` sigue enviando el documento completo cuando cambia una sola propiedad (`UPDATE [Orders] SET [Shipping] = @p0`), en ambos niveles. La diferencia está en el parámetro: en 170, el `Microsoft.Data.SqlClient` 7.0.2 que trae EF Core 11 RC 1 lo envía como `SqlDbType.Json` en lugar de `SqlDbType.NVarChar`. Solo `ExecuteUpdate` obtiene la actualización parcial en el lugar. Si quieres capturar este SQL desde tu propia aplicación, [registrar el SQL que genera EF Core 11](/es/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) cubre las opciones.

## Cuándo elegir el tipo json nativo

- **Estás en Azure SQL Database o Managed Instance.** El tipo está disponible de forma general allí con la directiva de actualización SQL Server 2025 o Always-up-to-date, y `UseAzureSql` ya lo selecciona. Renunciar a él te cuesta `JSON_CONTAINS` y la cláusula tipada `RETURNING` y no te aporta nada.
- **Estás en SQL Server 2025 y filtras dentro de los documentos.** `JSON_VALUE`, `JSON_PATH_EXISTS` y `JSON_CONTAINS` pueden usar un índice JSON, y EF Core 11 ahora puede crear uno desde el modelo (siguiente sección). Sobre `nvarchar(max)` tu única opción de índice es una columna calculada por cada ruta.
- **Actualizas campos dentro de documentos de forma masiva.** `ExecuteUpdate` se convierte en `.modify()`, que según la documentación de Microsoft actualiza en el lugar cuando el nuevo valor cabe: una cadena no más larga que la anterior, o un número del mismo tipo o rango. `JSON_MODIFY` sobre texto reescribe el valor.
- **Quieres que la base de datos rechace basura.** Una columna `json` rechaza cualquier cosa que no sea un objeto o arreglo bien formado. Con `nvarchar(max)` esa comprobación solo existe si la agregas tú.

## Cuándo quedarse en nvarchar(max)

- **Tu servidor de producción es SQL Server 2019 o 2022.** El tipo no existe allí, y EF solo lo usa si subes el nivel de compatibilidad, así que mantén el nivel predeterminado 160 o establece 150 explícitamente.
- **Algo fuera de EF lee la columna.** La documentación de `json` de SQL Server señala que `sp_describe_first_result_set` no informa el tipo `json`. Los clientes con TDS 7.4 o posterior ven `varchar(max)` con una intercalación UTF-8, y los más antiguos ven `nvarchar(max)`. El formato nativo de bcp escribe el documento como texto, así que necesitas un archivo de formato para volver a cargarlo. Los paquetes ETL con metadatos de columna codificados de forma fija son las víctimas habituales.
- **Necesitas una migración reversible.** Puedes hacer `ALTER` de `nvarchar(max)` a `json`, pero SQL Server no permite que `ALTER TABLE` convierta una columna `json` de vuelta a un tipo de cadena o binario. El método `Down()` que EF genera para la conversión es un simple `ALTER COLUMN ... nvarchar(max)`, así que revertir implica agregar una columna nueva, copiar los datos e intercambiarlas a mano.
- **Tus consultas usan formas que el tipo todavía no admite.** La nota de cambios importantes de EF Core 10 menciona una: `DISTINCT` sobre arreglos JSON no se admite en `json`, y esas consultas fallan.

## Evidencia: qué medí y qué no

No ejecuté ningún benchmark de almacenamiento ni de latencia. No hay ninguna instancia de SQL Server 2025 en mi entorno de pruebas, y no voy a poner una cifra de aceleración junto a un tipo que no cronometré. Lo que sí muestra la prueba anterior, para EF Core 11 RC 1:

1. El tipo de columna lo decide únicamente `UseAzureSql` o un nivel de compatibilidad 170 o superior. `UseSqlServer` usa 160 de forma predeterminada (confirmado en `SqlServerOptionsExtension`, donde `SqlServerDefaultCompatibilityLevel = 160` y `AzureSqlDefaultCompatibilityLevel = 170`).
2. Cada diferencia de traducción de la tabla anterior es SQL generado exacto, no parafraseado de las notas de la versión.
3. La migración que genera EF para pasar de 160 a 170 es un `ALTER COLUMN` por cada columna JSON (se omite el manejo de restricciones predeterminadas):

```sql
-- EF Core 11.0.0-rc.1, model diff from level 160 to level 170
ALTER TABLE [Orders] ALTER COLUMN [Tags] json NOT NULL;
ALTER TABLE [Orders] ALTER COLUMN [Shipping] json NOT NULL;
```

Las afirmaciones sobre almacenamiento y lectura son de Microsoft. La [referencia del tipo de datos json](https://learn.microsoft.com/en-us/sql/t-sql/data-types/json-data-type) dice que las lecturas son más eficientes porque el documento ya está analizado, que las escrituras pueden actualizar valores individuales y que el formato binario está "optimizado para compresión". Mide con tus propios documentos antes de prometerle una cifra a nadie. Los documentos pequeños y planos ganan mucho menos que los grandes y anidados sobre los que filtras.

## El detalle que decide por ti: índices JSON

EF Core 11 agrega `HasIndex` sobre rutas dentro de tipos complejos JSON, que se convierte en el `CREATE JSON INDEX` de SQL Server 2025. Es la razón más fuerte para pasar a `json`, y tiene una trampa. Esto es lo que imprimió la prueba cuando agregué un índice al modelo anterior:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1
mb.Entity<Order>().HasIndex("Shipping.City");
```

En el nivel 170 obtienes lo que quieres:

```sql
CREATE JSON INDEX [IX_Orders_Shipping_City] ON [Orders]([Shipping]) FOR (N'$.City');
```

En el nivel 160, EF emite **exactamente la misma instrucción**, aunque la columna que acaba de crear sea `nvarchar(max)`. El generador de SQL de migraciones no comprueba el tipo de almacenamiento antes de escribir `CREATE JSON INDEX`. La [referencia de CREATE JSON INDEX](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-json-index-transact-sql) exige una columna `json`, así que esa migración fallará al aplicarse. Por eso también el propio ejemplo de Microsoft fija el tipo explícitamente:

```csharp
// .NET 11, EF Core 11 - make the column type independent of the compatibility level
modelBuilder.Entity<Customer>()
    .ComplexProperty(c => c.Contact, b => b.ToJson().HasColumnType("json"));

modelBuilder.Entity<Customer>()
    .HasIndex("Contact.Address.City");
```

Hay tres restricciones más que vienen del lado de SQL. Los índices JSON están en versión preliminar y documentados solo para SQL Server 2025, no para Azure SQL. La tabla necesita una clave primaria agrupada. Y un índice solo se puede crear sin conexión, tomando un bloqueo de modificación de esquema durante toda su duración. Planifica la ventana de migración en consecuencia; el [flujo de trabajo con migrations bundle para producción](/es/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) es la forma segura de ejecutarla.

Una nota relacionada para Azure SQL: la documentación del tipo `json` todavía lista `.modify()` como una característica en versión preliminar disponible solo en SQL Server 2025, pero EF lo emite para cada columna `json`, incluso con `UseAzureSql`. No pude probar esa combinación. Antes de depender de `ExecuteUpdate` sobre propiedades JSON en Azure SQL, ejecútalo una vez contra una base de datos real. Este desajuste ya afectó a EF antes: [el error `AS JSON` en Azure SQL](/es/2026/09/fix-as-json-option-can-be-specified-only-for-column-of-nvarchar-max-on-azure-sql/) surgió porque EF emitía `json` en una cláusula `OPENJSON` que solo acepta SQL Server 2025. Se corrigió en EF Core 10.0.11.

## Cómo excluirse, por columna o globalmente

Si estás en Azure SQL pero no estás listo para convertir, tienes dos interruptores. El global baja el nivel de compatibilidad que asume EF:

```csharp
// .NET 11, EF Core 11 - keep every JSON column on nvarchar(max) on Azure SQL
optionsBuilder.UseAzureSql(connectionString, o => o.UseCompatibilityLevel(160));
```

Eso también desactiva todas las demás traducciones del nivel 170, incluido `JSON_CONTAINS`. El específico fija columnas individuales y mantiene el resto del modelo en 170:

```csharp
// .NET 11, EF Core 11 - pin specific columns to text, verified to emit nvarchar(max) at level 170
modelBuilder.Entity<Order>()
    .ComplexProperty(o => o.Shipping, s => s.ToJson().HasColumnType("nvarchar(max)"));
modelBuilder.Entity<Order>()
    .PrimitiveCollection(o => o.Tags).HasColumnType("nvarchar(max)");
```

Para ir en la otra dirección en una base de datos existente, sube el nivel, ejecuta `dotnet ef migrations add ConvertJsonColumns` y lee la migración generada antes de aplicarla. Toca todas las columnas JSON del modelo a la vez, incluidas las colecciones primitivas, algo fácil de olvidar cuando solo mapeaste un tipo complejo con `ToJson()`. Para el lado del modelado de esa decisión, [tipos complejos vs entidades owned en EF Core 11](/es/2026/07/complex-types-vs-owned-entities-in-ef-core-11/) explica por qué `ComplexProperty(...).ToJson()` es el mapeo en el que debes estar antes de convertir. `ExecuteUpdate` sobre JSON solo funciona con tipos complejos.

## La recomendación, de nuevo

Elige `json` en SQL Server 2025 y Azure SQL. Hacia allí se dirige EF Core 11: `JSON_CONTAINS`, `JSON_VALUE` tipado, `.modify()` y los índices JSON dependen de él, y `UseAzureSql` ya lo da por hecho. Establece `HasColumnType("json")` explícitamente en cualquier columna JSON que indexes, para que un cambio de nivel de compatibilidad nunca pueda producir una migración que falle. Quédate en `nvarchar(max)` cuando el servidor sea anterior a 2025, cuando herramientas ajenas a EF lean la columna en bruto o cuando todavía no puedas aceptar un cambio de esquema sin vuelta atrás. En ese último caso, fija el tipo por columna en lugar de bajar el nivel de compatibilidad para todo el contexto. Para el lado de las consultas una vez que hayas convertido, la guía sobre [mapear y consultar columnas JSON en EF Core 11](/es/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) retoma donde termina este artículo.

## Fuentes

- [json data type (SQL Server 2025, Azure SQL)](https://learn.microsoft.com/en-us/sql/t-sql/data-types/json-data-type): formato de almacenamiento, `modify`, reglas de conversión, limitaciones
- [CREATE JSON INDEX (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-json-index-transact-sql)
- [What's New in EF Core 11: JSON indexes, JSON_CONTAINS, compatibility level 160 default](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [What's New in EF Core 10: JSON type support](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew)
- [EF Core 10 breaking change: json data type used by default on Azure SQL and compatibility level 170](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/breaking-changes)
- [JSON data type support in SqlClient](https://learn.microsoft.com/en-us/sql/connect/ado-net/sql/json-data-sql-server)
- [dotnet/efcore#29623: SQL Server, support JSON indexes](https://github.com/dotnet/efcore/issues/29623)
