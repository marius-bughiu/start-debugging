---
title: "Cómo guardar un enum como string en EF Core 11 con un value converter"
description: "Guarda los enums de C# como strings legibles en lugar de ints en EF Core 11: HasConversion, configuración masiva para todos los enums, la trampa de nvarchar(max), el problema del ordenamiento y cómo migrar una columna int existente."
pubDate: 2026-08-03
updatedDate: 2026-11-02
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

Usa `.HasConversion<string>()` para guardar nombres de enum con EF Core. Elige una longitud que cubra todos los nombres válidos y revisa el DDL generado. Los filtros de igualdad usan el valor convertido. La comparación y ordenación de texto siguen la intercalación de la base, que puede diferir del orden numérico del flujo.

**Corrección, 2 de noviembre de 2026.** Antes se afirmaba que el conversor integrado no podía leer cadenas numéricas y que 900 bytes era el límite universal de las claves de índice de SQL Server. Ambas afirmaciones eran incorrectas. La migración distingue ahora materializar un valor de encontrarlo con un filtro.

La comprobación se hizo con SDK 10.0.302 y EF Core 10.0.10. Se ejecutaron lecturas y predicados en SQLite y se generó DDL y SQL de consultas para SQL Server sin conexión al servidor. Las optimizaciones específicas de EF Core 11 están en las [notas de versión](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew). [Convertir valores nulos de base de datos](/es/2026/09/how-to-write-an-ef-core-11-value-converter-that-maps-null-to-a-non-null-value/) es otro problema.

## Por qué el mapeo int por defecto es un pasivo

Por defecto EF Core usa el tipo numérico subyacente. Con valores implícitos, insertar o reordenar miembros puede cambiar los números de los siguientes. Asigna valores explícitos estables si esos números forman parte del contrato persistido.

```csharp
// Implicit numeric values follow declaration order.
public enum OrderStatus { Pending, Paid, Shipped, Delivered, Cancelled }
```

Seis meses después alguien inserta `Refunded` entre `Paid` y `Shipped` porque se lee mejor. El enum sigue compilando, todas las pruebas siguen pasando, y toda fila de la base de datos que decía `Shipped` ahora significa `Refunded`. No hay error de compilación ni error en tiempo de ejecución. Es un bug de corrupción silenciosa de datos que solo aparece cuando una persona lee un reporte.

Los nombres eliminan la dependencia del orden declarado. Cambiar un nombre modifica el contrato almacenado y requiere migración o asignación explícita. Considera legibilidad, almacenamiento, índices y ordenación.

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
// Explicit converter: Enum.Parse here is case-sensitive.
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

Especifica una longitud apropiada y revisa la migración. SQL Server distingue columnas normales, claves de índice y columnas incluidas que no son clave.

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

En este ejemplo `Status` sin facetas es `nvarchar(max)`. No puede ser una clave de índice normal, aunque puede incluirse como columna no clave en un índice no agrupado. `PrevStatus` con `.HasMaxLength(20).IsUnicode(false)` resulta `varchar(20)`.

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

El proveedor SQL Server generó `nvarchar(450)` para la propiedad indexada en EF Core 10.0.10: admite hasta 900 bytes de datos de caracteres. Desde SQL Server 2016, las claves de índice agrupado admiten hasta 900 bytes y las no agrupadas hasta 1.700. El máximo declarado no es el tamaño real de un valor corto. Elige una longitud válida para todos los nombres o códigos.

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

### Inspeccionar el SQL de ToString()

Proyectar o filtrar sobre `Status.ToString()` parece inofensivo cuando la columna ya es un string, pero EF Core 10 sigue emitiendo el cast implicado por la llamada CLR:

```csharp
context.Orders.Where(o => o.Status.ToString()!.StartsWith("P"))
```

```sql
-- EF Core 10
WHERE CAST([o].[Status] AS nvarchar(max)) LIKE N'P%'
```

El proveedor SQL Server de EF Core 10.0.10 generó el `CAST` mostrado. El uso de índice depende del plan efectivo. EF Core 11 documenta una optimización de conversiones redundantes, pero comprueba `ToQueryString()` con tu proveedor y versión. Para un estado exacto, compara valores de enum. `EF.Functions.Like` espera una expresión de texto, por lo que no admite directamente la propiedad enum. Consulta [logging de SQL en desarrollo](/es/2026/07/how-to-log-the-sql-that-ef-core-11-generates/).

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

### Pasar el valor del proveedor en SQL directo

Un argumento interpolado de SQL directo no usa automáticamente el conversor de la propiedad. Proporciona la representación almacenada. Para la conversión integrada por nombre:

```csharp
var providerValue = OrderStatus.Pending.ToString();
var rows = await context.Orders
    .FromSql($"SELECT * FROM Orders WHERE Status = {providerValue}")
    .ToListAsync();
```

La interpolación usa aquí un parámetro. Con una conversión personalizada a `PND`, pasa ese código para `Pending`. El entero subyacente puede dar filas distintas o un error de conversión según el proveedor. Una consulta de entidad necesita las columnas requeridas para materializarla. Es distinto de [un error de traducción de LINQ](/es/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/).

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

Una conversión directa de columna puede guardar `2` como texto `"2"` en vez de `"Shipped"`. En SQLite, el conversor integrado de EF Core 10.0.10 materializó ambas cadenas como `Shipped`. El filtro de igualdad para `Shipped` solo encontró la fila con el nombre porque el valor enviado era `"Shipped"`. Incluso `"99"` se materializó como valor sin nombre, mientras que `"Bogus"` lanzó una excepción. El texto numérico altera el contrato aunque la lectura funcione.

En una migración coordinada, rellena explícitamente los nombres previstos. Haz copia de seguridad, prueba sobre una copia y considera escritores que aún usen la columna antigua durante el despliegue.

1. Agrega el converter al modelo y luego genera la migración con `dotnet ef migrations add StoreStatusAsString`.
2. Abre la migración generada y reemplaza el `AlterColumn` por un `AddColumn` para una columna temporal, por ejemplo `StatusText nvarchar(20) NULL`.
3. Agrega un relleno con `migrationBuilder.Sql(...)` entre el add y el drop, mapeando cada int a su nombre explícitamente: `UPDATE Orders SET StatusText = CASE Status WHEN 0 THEN 'Pending' WHEN 1 THEN 'Paid' ... END;`. Escribe el CASE a mano contra la declaración del enum tal como existe en este commit, no contra lo que llegue a ser después.
4. Elimina la columna vieja, renombra `StatusText` a `Status` y hazla `NOT NULL`. Escribe la lógica espejo en `Down` para que la migración sea reversible.

Antes de eliminar columnas, verifica recuentos, enteros sin correspondencia, nulabilidad y todas las asignaciones. Reconstruye índices y claves externas afectados y prueba actualización y reversión cuando corresponda. Revisa `dotnet ef migrations script` y ensaya el despliegue real, incluido el [bundle de migración](/es/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) si lo utilizas.

Un último consejo sobre el modelo en sí: los value converters son para una sola columna. En el momento en que te encuentres serializando varios campos en un string para sortear eso, lo que quieres es un [tipo complejo mapeado a JSON](/es/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/), que EF Core 11 puede indexar y actualizar en el lugar. Y si EF Core se niega a mapear la propiedad del todo, ese es otro problema con otra solución, cubierto en [el error de propiedad que no se pudo mapear](/es/2026/07/fix-property-could-not-be-mapped-not-a-supported-primitive-type-in-ef-core-11/).

## Fuentes

- [Value Conversions](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions) en Microsoft Learn, incluyendo la lista de converters integrados y las limitaciones documentadas.
- [Model bulk configuration](https://learn.microsoft.com/en-us/ef/core/modeling/bulk-configuration) para la configuración previa a las convenciones y el match por tipo base.
- [What's New in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) para la eliminación de los CAST inocuos.
- Referencia de la API de [EnumToStringConverter&lt;TEnum&gt;](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.storage.valueconversion.enumtostringconverter-1).
- [dotnet/efcore#10434](https://github.com/dotnet/efcore/issues/10434), el issue de seguimiento para consultar dentro de propiedades con conversión de valor.
- [SQL Server index key limits](https://learn.microsoft.com/en-us/sql/sql-server/maximum-capacity-specifications-for-sql-server?view=sql-server-ver17)
- [EF Core 10.0.10 enum converter source](https://github.com/dotnet/efcore/blob/v10.0.10/src/EFCore/Storage/ValueConversion/Internal/StringEnumConverter.cs)
