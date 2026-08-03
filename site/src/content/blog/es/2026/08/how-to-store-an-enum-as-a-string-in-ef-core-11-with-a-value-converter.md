---
title: "Cómo guardar un enum como string en EF Core 11 con un value converter"
description: "Guarda los enums de C# como strings legibles en lugar de ints en EF Core 11: HasConversion, configuración masiva para todos los enums, la trampa de nvarchar(max), el problema del ordenamiento y cómo migrar una columna int existente."
pubDate: 2026-08-03
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "value-converters"
  - "enums"
  - "dotnet-11"
  - "how-to"
lang: "es"
translationOf: "2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter"
translatedBy: "claude"
translationDate: 2026-08-03
---

Respuesta corta: en EF Core 11 (ejecutándose sobre .NET 11 con C# 14), agrega `.HasConversion<string>()` a la propiedad y EF Core elige por ti el converter integrado `EnumToStringConverter<TEnum>`. Agrega `.HasMaxLength(...)` al mismo tiempo, porque sin eso SQL Server te da una columna `nvarchar(max)` que ningún índice va a tocar. Hazlo una sola vez para todos los enums del modelo con `configurationBuilder.Properties<Enum>().HaveConversion<string>()` en `ConfigureConventions`. La igualdad y `Contains` se siguen traduciendo correctamente a SQL; las comparaciones relacionales como `>` y `OrderBy` pasan silenciosamente a orden alfabético, y eso es lo único que realmente se rompe.

Este post cubre las tres formas de configurar la conversión, cómo se ven realmente el DDL y el SQL generados, los cinco problemas que muerden en producción y el procedimiento de migración para una columna que ya guarda ints.

Todo el SQL y el comportamiento de abajo se midieron con EF Core 10.0.10 contra SQLite y contra el generador de DDL del proveedor de SQL Server, usando el SDK .NET 10.0.201. EF Core 11 requiere el runtime de .NET 11, así que no pude ejecutarlo en esta máquina; las diferencias de EF Core 11 que se señalan abajo provienen de las [notas de la versión de EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) y están marcadas como tales. La API de conversión de valores en sí no cambió entre EF Core 8 y 11.

## Por qué el mapeo int por defecto es un pasivo

Por defecto EF Core mapea un enum a su tipo numérico subyacente. `OrderStatus.Shipped` se convierte en `2`. Eso es compacto y ordena tal como el enum declara, pero acopla tu base de datos al *orden de declaración* de un tipo de C#.

```csharp
// .NET 11, C# 14
public enum OrderStatus { Pending, Paid, Shipped, Delivered, Cancelled }
```

Seis meses después alguien inserta `Refunded` entre `Paid` y `Shipped` porque se lee mejor. El enum sigue compilando, todas las pruebas siguen pasando, y toda fila de la base de datos que decía `Shipped` ahora significa `Refunded`. No hay error de compilación ni error en tiempo de ejecución. Es un bug de corrupción silenciosa de datos que solo aparece cuando una persona lee un reporte.

Los strings no tienen ese modo de falla. `"Shipped"` significa `Shipped` sin importar lo que le hagas al orden de declaración, y la columna es legible para cualquiera que corra SQL ad-hoc, una herramienta de BI o una consulta de soporte. Lo pagas en almacenamiento, en ancho de índice y en la advertencia sobre ordenamiento de más abajo.

## Las tres formas de configurar la conversión

La forma más corta usa la sobrecarga genérica de `HasConversion`. EF Core inspecciona el tipo del modelo (un enum) y el tipo de proveedor solicitado (`string`) y selecciona el converter integrado automáticamente:

```csharp
// EF Core 11, OnModelCreating
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Order>()
        .Property(o => o.Status)
        .HasConversion<string>()
        .HasMaxLength(20);
}
```

La segunda forma escribe las dos lambdas explícitamente. Casi nunca la necesitas para un enum simple, pero es lo que muestra primero la [documentación de conversiones de valores](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions), así que vale la pena reconocerla:

```csharp
// EF Core 11 - equivalent to HasConversion<string>(), just more typing
modelBuilder.Entity<Order>()
    .Property(o => o.Status)
    .HasConversion(
        v => v.ToString(),
        v => (OrderStatus)Enum.Parse(typeof(OrderStatus), v));
```

Estas dos *no* son idénticas, y la diferencia importa. El `EnumToStringConverter<TEnum>` integrado parsea sin distinguir mayúsculas de minúsculas; el `Enum.Parse` escrito a mano de arriba sí distingue y lanza una excepción en una fila que guarda `"pending"` en lugar de `"Pending"`. Prefiere la sobrecarga genérica.

La tercera forma se salta la fluent API por completo y solo declara el tipo de columna. EF Core ve una columna string bajo una propiedad enum e infiere la conversión:

```csharp
// EF Core 11 - conversion inferred from the store type
public class Order
{
    public int Id { get; set; }

    [Column(TypeName = "varchar(20)")]
    public OrderStatus Status { get; set; }
}
```

### Configurar todos los enums del modelo de una vez

Repetir `HasConversion<string>()` en cuarenta propiedades es la manera de terminar con una olvidada. La configuración de modelo previa a las convenciones hace match por tipo CLR, y la documentación señala que el tipo "puede ser un tipo base", lo que significa que `System.Enum` hace match con todos los enums del modelo:

```csharp
// EF Core 11 - applies to every enum property in the model
protected override void ConfigureConventions(ModelConfigurationBuilder configurationBuilder)
{
    configurationBuilder
        .Properties<Enum>()
        .HaveConversion<string>()
        .HaveMaxLength(32);
}
```

Verifiqué esto en EF Core 10.0.10. Volcar el modelo después muestra la conversión aplicada tanto a una propiedad enum no anulable como a una anulable, incluyendo la longitud máxima:

```text
Id:         clr=Int32       provider=(none)  maxlen=
Perms:      clr=Perms       provider=String  maxlen=32
PrevStatus: clr=Nullable`1  provider=String  maxlen=32
Status:     clr=OrderStatus provider=String  maxlen=32
```

Fíjate que `IProperty.GetValueConverter()` devuelve `null` aquí aunque la conversión esté activa. Cuando la conversión viene del tipo de proveedor y no de una instancia explícita de converter, vive en el type mapping. Si estás inspeccionando un modelo en el depurador, mira `property.GetTypeMapping().Converter`, que reporta una instancia de `EnumToStringConverter<TEnum>`.

La configuración previa a las convenciones sobrescribe las convenciones *y* las data annotations, así que si necesitas un enum guardado como int, configura ese explícitamente en `OnModelCreating` después.

## La trampa de nvarchar(max)

Este es el error más común de todos, y es invisible hasta que una consulta se pone lenta.

Configura la conversión sin longitud y el proveedor de SQL Server no tiene idea de cuán largos son los strings, así que elige lo más ancho que tiene. Este es el DDL que EF Core generó para un modelo con tres propiedades enum convertidas, de las cuales solo dos fijan una longitud:

```sql
CREATE TABLE [Orders] (
    [Id] int NOT NULL IDENTITY,
    [Status] nvarchar(max) NOT NULL,
    [PrevStatus] varchar(20) NULL,
    [Perms] nvarchar(64) NOT NULL,
    CONSTRAINT [PK_Orders] PRIMARY KEY ([Id])
);
```

`Status` no tenía facetas, así que quedó como `nvarchar(max)`. En SQL Server no puedes poner un índice normal sobre una columna `nvarchar(max)` en absoluto, y las columnas de estado son exactamente el tipo de columna por la que filtras constantemente. `PrevStatus` usó `.HasMaxLength(20).IsUnicode(false)` y quedó como un prolijo `varchar(20)`.

Hay una salvedad que conviene conocer: si declaras un índice sobre la propiedad, el proveedor de SQL Server de EF Core recae en su valor por defecto para columnas clave en lugar de `max`:

```csharp
// EF Core 11
modelBuilder.Entity<Order>().Property(o => o.Status).HasConversion<string>();
modelBuilder.Entity<Order>().HasIndex(o => o.Status);
```

```sql
CREATE TABLE [Orders] (
    [Id] int NOT NULL IDENTITY,
    [Status] nvarchar(450) NOT NULL,
    CONSTRAINT [PK_Orders] PRIMARY KEY ([Id])
);
GO

CREATE INDEX [IX_Orders_Status] ON [Orders] ([Status]);
```

`nvarchar(450)` son 900 bytes, el límite de tamaño de clave de índice en SQL Server. Funciona, pero una clave de 900 bytes para una columna que guarda `"Pending"` es un desperdicio de cada página del índice. Fija la longitud tú. Los nombres de enum son cortos; 32 o 64 caracteres no Unicode casi siempre es lo correcto.

Si quieres que la longitud viaje con el converter en lugar de repetirla en cada propiedad, pasa `ConverterMappingHints`:

```csharp
// EF Core 11 - the size travels with the converter
var converter = new ValueConverter<OrderStatus, string>(
    v => v.ToString(),
    v => Enum.Parse<OrderStatus>(v, ignoreCase: true),
    new ConverterMappingHints(size: 20, unicode: false));
```

Cualquier faceta que fijes explícitamente en la propiedad sobrescribe estas pistas.

## En qué se compilan realmente tus consultas LINQ

La igualdad se traduce exactamente como esperarías. El enum se convierte al entrar al parámetro, no al salir de la columna, así que la columna sigue siendo utilizable por el índice:

```csharp
var pending = await context.Orders
    .Where(o => o.Status == OrderStatus.Pending)
    .ToListAsync();
```

```sql
SELECT "o"."Id", "o"."Perms", "o"."PrevStatus", "o"."Status"
FROM "Orders" AS "o"
WHERE "o"."Status" = 'Pending'
```

`Contains` sobre un arreglo de valores enum se vuelve un `IN` parametrizado, con cada valor convertido:

```sql
-- Parameters: @wanted1='Pending', @wanted2='Paid'
WHERE "o"."Status" IN (@wanted1, @wanted2)
```

`ExecuteUpdate` también maneja enums convertidos, enviando el string como parámetro:

```csharp
await context.Orders
    .Where(o => o.Id == id)
    .ExecuteUpdateAsync(s => s.SetProperty(o => o.Status, OrderStatus.Paid));
```

Eso cubre los casos normales. Ahora los que no se portan bien.

### La comparación relacional y OrderBy pasan a orden alfabético

Este es el costo real de guardar strings, y EF Core no te avisa. Una comparación `>` sobre un enum es C# perfectamente legal y se traduce a una comparación de strings de SQL perfectamente legal, que no es lo mismo:

```csharp
// Intent: "everything after Paid in the workflow"
var later = await context.Orders
    .Where(o => o.Status > OrderStatus.Paid)
    .ToListAsync();
```

```sql
WHERE "o"."Status" > 'Paid'
```

Con tres filas que contienen `Pending`, `Delivered` y `Cancelled`, LINQ en memoria devuelve las filas `Delivered` y `Cancelled`. La base de datos devuelve la fila `Pending`, porque `'Pending' > 'Paid'` alfabéticamente y `'Cancelled'` y `'Delivered'` no. `OrderBy(o => o.Status)` tiene el mismo problema: vuelve como `Cancelled, Delivered, Pending` en lugar del orden de declaración.

La solución no es una opción del converter. O mantienes un int para todo lo que ordenes o compares por rango, o agregas una columna explícita `int SortOrder`, o reemplazas la consulta de rango por un conjunto explícito: `Where(o => finished.Contains(o.Status))`. Si ya tienes código en producción que compara enums por rango, búscalo con grep antes de cambiar el mapeo.

### ToString() en una consulta emite un CAST, y EF Core 11 lo elimina

Proyectar o filtrar sobre `Status.ToString()` parece inofensivo cuando la columna ya es un string, pero EF Core 10 sigue emitiendo el cast implicado por la llamada CLR:

```csharp
context.Orders.Where(o => o.Status.ToString()!.StartsWith("P"))
```

```sql
-- EF Core 10
WHERE CAST([o].[Status] AS nvarchar(max)) LIKE N'P%'
```

Ese cast es semánticamente inocuo y un desastre para el planificador de consultas: envolver la columna en una función impide que SQL Server use cualquier índice sobre ella. EF Core 11 detecta y elimina los casts redundantes durante el post-procesamiento del SQL, y las notas de la versión señalan las propiedades con conversión de valor como la fuente habitual. En EF Core 11 la misma consulta produce un `WHERE [o].[Status] LIKE N'P%'` limpio. Si estás en EF Core 10 o anterior, quita el `.ToString()` y usa `EF.Functions.Like` sobre la propiedad, o espera la actualización. Verificar esto es una buena razón para mantener [el registro de SQL activado en desarrollo](/es/2026/07/how-to-log-the-sql-that-ef-core-11-generates/).

## Leer los valores de vuelta: nombres desconocidos y mayúsculas

Los value converters corren durante la materialización, y una columna string acepta cualquier cosa. Una fila que contiene un nombre que tu enum no tiene falla al leer, no al consultar:

```text
InvalidOperationException: Cannot convert string value 'Refunded' from the database
to any value in the mapped 'OrderStatus' enum.
```

La excepción aparece cuando la fila se materializa, así que una consulta que devuelve 10 000 filas muere en la fila que resulte estar mal. Protege la columna con una restricción `CHECK` si la base de datos está compartida con algo que escriba directamente en ella.

Las mayúsculas, en cambio, son perdonadas por el converter integrado: una fila que guarda `"pending"` se materializa como `OrderStatus.Pending`. Eso es `EnumToStringConverter<TEnum>` parseando sin distinguir mayúsculas. Cambia a un `Enum.Parse(typeof(OrderStatus), v)` escrito a mano y esa misma fila lanza excepción, porque el valor por defecto de la BCL sí distingue mayúsculas. Si escribes el tuyo, escribe `Enum.Parse<OrderStatus>(v, ignoreCase: true)`.

### Los enums `[Flags]` van y vuelven, pero no se consultan

Un enum `[Flags]` se convierte mediante `ToString()` como cualquier otro, lo que produce una lista separada por comas:

```text
row 1 | Read
row 2 | Read, Write
row 3 | None
```

El viaje de ida y vuelta funciona. Consultar no: `Where(o => o.Perms.HasFlag(Perms.Write))` no se puede traducir a un predicado de string, y `LIKE '%Write%'` no encuentra nada útil y escanea todo. Mantén los enums `[Flags]` como ints, o modela los permisos como filas.

### Los parámetros de SQL crudo ignoran el converter en silencio

La documentación de conversión de valores lista esto como una limitación conocida, y vale la pena ver cómo se ve, porque no lanza excepción:

```csharp
var rows = await context.Orders
    .FromSql($"SELECT Id, Status FROM Orders WHERE Status = {OrderStatus.Pending}")
    .ToListAsync();
```

El parámetro llega a la base de datos como `DbType = Int32` con valor `0`. La consulta corre, no encuentra nada y devuelve una lista vacía. Pasa `OrderStatus.Pending.ToString()` explícitamente en SQL crudo, o quédate en LINQ. Esta es una falla distinta de las que están detrás de [la expresión LINQ no se pudo traducir](/es/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/): aquí no hay excepción alguna.

## Guardar códigos cortos en lugar de nombres

Si quieres `"PND"` en lugar de `"Pending"` (los códigos de ancho fijo son comunes en esquemas compartidos con un data warehouse), hereda de `ValueConverter<TModel, TProvider>` para que el mapeo sea explícito y revisable:

```csharp
// EF Core 11
public class StatusCodeConverter : ValueConverter<OrderStatus, string>
{
    public StatusCodeConverter() : base(v => ToCode(v), v => FromCode(v)) { }

    private static string ToCode(OrderStatus s) => s switch
    {
        OrderStatus.Pending => "PND",
        OrderStatus.Paid => "PAI",
        OrderStatus.Shipped => "SHP",
        OrderStatus.Delivered => "DLV",
        OrderStatus.Cancelled => "CAN",
        _ => throw new ArgumentOutOfRangeException(nameof(s), s, null)
    };

    private static OrderStatus FromCode(string c) => c switch
    {
        "PND" => OrderStatus.Pending,
        "PAI" => OrderStatus.Paid,
        "SHP" => OrderStatus.Shipped,
        "DLV" => OrderStatus.Delivered,
        "CAN" => OrderStatus.Cancelled,
        _ => throw new InvalidOperationException($"Unknown status code '{c}'.")
    };
}
```

```csharp
modelBuilder.Entity<Order>()
    .Property(o => o.Status)
    .HasConversion<StatusCodeConverter>()
    .HasMaxLength(3)
    .IsUnicode(false);
```

Los predicados se traducen a través del converter, así que `Where(o => o.Status == OrderStatus.Pending)` se vuelve `WHERE "o"."Status" = 'PND'`. Como las ramas del switch son exhaustivas sobre los códigos conocidos, un valor inesperado te da *tu* mensaje en lugar del de EF, lo que es mucho más fácil de diagnosticar. Los converters no tienen estado y se pueden compartir entre todas las propiedades que los usan.

## Migrar una columna que ya guarda ints

No dejes que EF Core genere esta migración por ti. La que produce es un único `AlterColumn`, que en SQL Server ejecuta una conversión implícita de `int` a `nvarchar`: el valor `2` se vuelve el string `"2"`, no `"Shipped"`. Después de eso ninguna fila se puede parsear y la siguiente lectura lanza excepción.

El procedimiento seguro son cuatro pasos:

1. Agrega el converter al modelo y luego genera la migración con `dotnet ef migrations add StoreStatusAsString`.
2. Abre la migración generada y reemplaza el `AlterColumn` por un `AddColumn` para una columna temporal, por ejemplo `StatusText nvarchar(20) NULL`.
3. Agrega un relleno con `migrationBuilder.Sql(...)` entre el add y el drop, mapeando cada int a su nombre explícitamente: `UPDATE Orders SET StatusText = CASE Status WHEN 0 THEN 'Pending' WHEN 1 THEN 'Paid' ... END;`. Escribe el CASE a mano contra la declaración del enum tal como existe en este commit, no contra lo que llegue a ser después.
4. Elimina la columna vieja, renombra `StatusText` a `Status` y hazla `NOT NULL`. Escribe la lógica espejo en `Down` para que la migración sea reversible.

Verifica el SQL antes de que corra en cualquier lugar real. `dotnet ef migrations script` lo imprime, y ese mismo script es lo que un [migration bundle](/es/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) ejecutará en la máquina destino. Si el enum se usa como clave foránea o dentro de un índice filtrado, elimina y recrea el índice en la misma migración.

Un último consejo sobre el modelo en sí: los value converters son para una sola columna. En el momento en que te encuentres serializando varios campos en un string para sortear eso, lo que quieres es un [tipo complejo mapeado a JSON](/es/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/), que EF Core 11 puede indexar y actualizar en el lugar. Y si EF Core se niega a mapear la propiedad del todo, ese es otro problema con otra solución, cubierto en [el error de propiedad que no se pudo mapear](/es/2026/07/fix-property-could-not-be-mapped-not-a-supported-primitive-type-in-ef-core-11/).

## Fuentes

- [Value Conversions](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions) en Microsoft Learn, incluyendo la lista de converters integrados y las limitaciones documentadas.
- [Model bulk configuration](https://learn.microsoft.com/en-us/ef/core/modeling/bulk-configuration) para la configuración previa a las convenciones y el match por tipo base.
- [What's New in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) para la eliminación de los CAST inocuos.
- Referencia de la API de [EnumToStringConverter&lt;TEnum&gt;](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.storage.valueconversion.enumtostringconverter-1).
- [dotnet/efcore#10434](https://github.com/dotnet/efcore/issues/10434), el issue de seguimiento para consultar dentro de propiedades con conversión de valor.
