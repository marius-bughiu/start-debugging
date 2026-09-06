---
title: "Cómo escribir un value converter de EF Core 11 que mapee un null de la base de datos a un valor no nulo en código"
description: "EF Core nunca pasa null a un value converter por defecto. Aquí está el constructor interno convertsNulls que cambia eso, la llamada IsRequired(false) de la que depende, por qué no puede funcionar con enums ni otros tipos de valor, la trampa WHERE col = NULL que crea, y los dos patrones que resuelven el problema sin usar una API interna."
pubDate: 2026-09-06
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "value-converters"
  - "nullability"
  - "dotnet-11"
  - "how-to"
lang: "es"
translationOf: "2026/09/how-to-write-an-ef-core-11-value-converter-that-maps-null-to-a-non-null-value"
translatedBy: "claude"
translationDate: 2026-09-06
---

Respuesta corta: EF Core nunca entrega `null` a un value converter de forma deliberada, así que `HasConversion(v => ..., v => v ?? "Unknown")` no hace absolutamente nada con una columna NULL. La única forma de cambiarlo es el constructor de cuatro argumentos de `ValueConverter<TModel, TProvider>` con `convertsNulls: true`, que está marcado como `[EntityFrameworkInternal]` y produce la advertencia `EF1001`. Funciona, pero solo para propiedades cuyo tipo CLR es un tipo de referencia, solo si además llamas a `.IsRequired(false)`, y a costa de romper toda consulta LINQ que filtre por el valor centinela. Para un `enum`, `int`, `DateTime` o cualquier otro tipo de valor no anulable, no hay manera de que funcione. Para esos casos, mapea una propiedad anulable y expón una fachada no anulable.

Este artículo cubre qué hace EF realmente con una columna NULL, la configuración exacta que hace funcionar `convertsNulls`, las cuatro formas de consulta que rompe (con el SQL que EF emite para cada una), el muro contra el que chocas con los tipos de valor, y los dos patrones soportados que conviene usar en su lugar.

Una nota sobre versiones. EF Core 11 está en versión preliminar en septiembre de 2026 y se publica junto con .NET 11 en noviembre de 2026, según la [página de versiones y planificación de EF Core](https://learn.microsoft.com/en-us/ef/core/what-is-new/). EF11 requiere el runtime de .NET 11, y el único SDK en esta máquina es .NET 10.0.302, así que todo lo que sigue se midió contra `Microsoft.EntityFrameworkCore.Sqlite` 10.0.10 sobre una base de datos SQLite en memoria. Nada de esto cambió en EF11: la página [What's New in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) no lista ningún cambio en value conversions ni en el manejo de nulos, y `convertsNulls` es interno desde EF Core 6.0.

## Por qué tu converter nunca se ejecuta con una columna NULL

La [documentación de value conversions](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions) enuncia la regla sin rodeos: un valor null nunca se pasa a un value converter, y un null en una columna de la base de datos siempre es un null en la instancia de la entidad. Esto no es un descuido. Es lo que permite compartir un mismo converter entre una clave primaria no anulable y las claves foráneas anulables que la apuntan, sin escribir el manejo de nulos dos veces.

La consecuencia es que el código obvio no hace nada:

```csharp
// .NET 11, C# 14 - this ?? is dead code
modelBuilder.Entity<Order>()
    .Property(o => o.Notes)
    .HasConversion(v => v, v => v ?? "");
```

La rama `v ?? ""` nunca se alcanza, porque EF cortocircuita la conversión antes de entrar en ella.

Lo que ocurre después depende del tipo CLR. Toma una tabla heredada donde la columna es anulable y NULL tiene significado:

```sql
CREATE TABLE Orders (
    Id     INTEGER PRIMARY KEY AUTOINCREMENT,
    Notes  TEXT NULL,   -- NULL means "no notes"
    Status TEXT NULL    -- NULL means "status unknown"
);
INSERT INTO Orders (Notes, Status) VALUES (NULL, NULL);
INSERT INTO Orders (Notes, Status) VALUES ('hi', 'Shipped');
```

mapeada a una entidad que promete no-nulo:

```csharp
// .NET 11, C# 14
public enum ShippingStatus { Unknown, Pending, Shipped }

public class Order
{
    public int Id { get; set; }
    public string Notes { get; set; } = "";      // never null, we hope
    public ShippingStatus Status { get; set; }   // Unknown, we hope
}
```

Lee la fila 1 y `Notes` es `null` a pesar del inicializador y a pesar de la declaración no anulable, porque EF asigna el valor de la columna directamente a la propiedad. `Status` es peor: el data reader del proveedor lanza una excepción antes de que EF pueda hacer nada, lo que en SQLite se lee así:

```
System.InvalidOperationException: The data is NULL at ordinal 2. This method can't be
called on NULL values. Check using IsDBNull before calling.
```

Esa excepción es la forma más común de descubrir el problema. El tipo exacto varía según el proveedor, pero la causa siempre es la misma: EF solo emite una comprobación `IsDBNull` para una columna que cree anulable, y aquí no lo cree en absoluto. Este fallo es distinto de [la propiedad no se pudo mapear porque no es un tipo primitivo soportado](/es/2026/07/fix-property-could-not-be-mapped-not-a-supported-primitive-type-in-ef-core-11/), que se dispara al construir el modelo y no al materializar.

## El converter que sí convierte nulos

`ValueConverter<TModel, TProvider>` tiene un segundo constructor, añadido en EF Core 6.0, que recibe un flag `convertsNulls`:

```csharp
[Microsoft.EntityFrameworkCore.Infrastructure.EntityFrameworkInternal]
public ValueConverter(
    Expression<Func<TModel, TProvider>> convertToProviderExpression,
    Expression<Func<TProvider, TModel>> convertFromProviderExpression,
    bool convertsNulls,
    ConverterMappingHints? mappingHints = default);
```

No existe una sobrecarga de `HasConversion` para él, así que tienes que crear una subclase. El procedimiento tiene tres pasos:

1. Escribe una clase converter cuyo tipo de proveedor sea explícitamente anulable, y pasa `convertsNulls: true` al constructor base.
2. Suprime `EF1001` alrededor de la clase, ya que el constructor es interno.
3. Llama a `.IsRequired(false)` sobre la propiedad para que EF trate la columna como anulable y emita la comprobación `IsDBNull` que necesita la ruta de lectura.

```csharp
// .NET 11, C# 14, EF Core 11
#pragma warning disable EF1001
public class NullToEmptyString : ValueConverter<string, string?>
{
    public NullToEmptyString()
        : base(
            v => v.Length == 0 ? null : v,   // model -> provider
            v => v ?? "",                    // provider -> model
            convertsNulls: true)
    {
    }
}
#pragma warning restore EF1001

protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Order>()
        .Property(o => o.Notes)
        .HasConversion(new NullToEmptyString())
        .IsRequired(false);
}
```

Sin el `#pragma`, la compilación emite:

```
warning EF1001: Microsoft.EntityFrameworkCore.Storage.ValueConversion.ValueConverter<string, string?>
is an internal API that supports the Entity Framework Core infrastructure and not subject to the same
compatibility standards as public APIs. It may be changed or removed without notice in any release.
```

Eso es una advertencia, no un error, pero se convierte en error bajo `TreatWarningsAsErrors`, que es la razón habitual por la que la gente encuentra esta API.

Con esa configuración, ambas direcciones funcionan. La fila 1 se materializa con `Notes` igual a `""` en lugar de `null`, y guardar una entidad nueva cuyo `Notes` es `""` escribe un `NULL` real en la columna, confirmado leyendo la tabla en crudo después.

El paso 3 no es opcional y es el paso que casi todo el mundo se salta. Quita el `.IsRequired(false)` y `Notes` sigue siendo no anulable en el modelo (`IsNullable = False`), EF omite la comprobación de nulo y la lectura lanza la misma excepción `The data is NULL at ordinal 1` de antes. El converter está bien configurado y nunca se invoca. Si no sabes en qué estado estás, `context.Model.FindEntityType(typeof(Order))!.FindProperty("Notes")!.IsNullable` te lo dice en una línea.

## La trampa de las consultas: WHERE col = NULL

Aquí está la parte contra la que advierte la [documentación de EF Core](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions) sin mostrarla, y es la razón de que la API sea interna. EF aplica la mitad modelo-a-proveedor de tu converter también a las constantes de la consulta. Tu centinela se convierte en `null`, y EF planta ese `null` en el SQL como un operando de comparación cualquiera.

Cuatro formas de preguntar "qué pedidos no tienen notas", el SQL que EF Core 10.0.10 emite para cada una, y las filas devueltas contra una tabla que contiene una fila NULL y una fila `'hi'`:

| LINQ | Predicado SQL generado | Filas |
| --- | --- | --- |
| `o.Notes == ""` | `"o"."Notes" = NULL` | 0 |
| `o.Notes == null!` | `"o"."Notes" IS NULL` | 1 |
| `string.IsNullOrEmpty(o.Notes)` | `"o"."Notes" IS NULL OR "o"."Notes" = NULL` | 1 |
| `o.Notes.Length == 0` | `length("o"."Notes") = 0` | 0 |

La consulta natural, comparando contra el centinela que inventaste, no devuelve nada. `= NULL` nunca es verdadero bajo la lógica de tres valores de SQL, así que la fila se descarta en silencio. Sin excepción, sin advertencia: solo un filtro que calladamente no coincide con ninguna fila en producción.

La consulta que sí funciona es `o.Notes == null`, una comparación que el analizador de tipos de referencia anulables marca como siempre falsa, sobre una propiedad que realmente nunca contiene null una vez materializada. Estás escribiendo código que el compilador considera muerto para producir el SQL que necesitas. `string.IsNullOrEmpty` sobrevive solo por casualidad, porque EF lo expande en dos predicados y la mitad `IS NULL` sostiene el resultado. `Length == 0` falla por la razón habitual: NULL se propaga a través de `length()`.

Esto no es un bug que se arregle aguas abajo. Es a lo que se refiere el [issue #26230](https://github.com/dotnet/efcore/issues/26230) cuando dice "value conversion to null in the store generates bad queries", y es por lo que el equipo de EF marcó el constructor como interno en la 6.0 en lugar de publicarlo: el fallo es invisible y no es fácil de detectar. Si tomas este camino, la mitigación es verificar el predicado en lugar de confiar en él, ya sea con `ToQueryString()` en un test o [registrando el SQL que genera EF Core 11](/es/2026/07/how-to-log-the-sql-that-ef-core-11-generates/).

## Por qué no puede funcionar con un enum, int o DateTime

Para un tipo de valor no anulable, `convertsNulls` te lleva a mitad de camino y ahí se detiene. Escribe el converter:

```csharp
// .NET 11, C# 14, EF Core 11
#pragma warning disable EF1001
public class NullToUnknown : ValueConverter<ShippingStatus, string?>
{
    public NullToUnknown()
        : base(
            v => v == ShippingStatus.Unknown ? null : v.ToString(),
            v => v == null ? ShippingStatus.Unknown : Enum.Parse<ShippingStatus>(v),
            convertsNulls: true)
    {
    }
}
#pragma warning restore EF1001
```

La escritura funciona: guardar `ShippingStatus.Unknown` escribe `NULL`. La lectura no, y el paso 3 de arriba explica por qué. `.IsRequired(false)` lanza al construir el modelo:

```
System.InvalidOperationException: The property 'Order.Status' cannot be marked as
nullable/optional because the type of the property is 'ShippingStatus' which is not a
nullable type. Any property can be marked as non-nullable/required, but only properties
of nullable types can be marked as nullable/optional.
```

La comprobación de nulabilidad de EF mira el tipo CLR, no el converter, así que ninguna combinación de ajustes te lleva a destino. Omite la llamada y el modelo mantiene `IsNullable = False`, EF se salta la comprobación `IsDBNull`, y toda lectura de una fila NULL lanza. No hay una tercera opción. `convertsNulls` sobre un tipo de valor no anulable es una característica de solo escritura, lo que es peor que inútil: persistirá alegremente NULLs que ese mismo modelo no puede volver a leer.

## Los dos patrones que sí funcionan

### Mapea una propiedad anulable y expón una fachada no anulable

La propiedad mapeada refleja honestamente la nulabilidad de la base de datos. La propiedad de dominio hace el coalescing en C# puro, donde no interviene ningún traductor de consultas:

```csharp
// .NET 11, C# 14, EF Core 11
public class Order
{
    public int Id { get; set; }

    public ShippingStatus? StatusRaw { get; set; }

    [NotMapped]
    public ShippingStatus Status
    {
        get => StatusRaw ?? ShippingStatus.Unknown;
        set => StatusRaw = value == ShippingStatus.Unknown ? null : value;
    }
}

protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Order>()
        .Property(o => o.StatusRaw)
        .HasColumnName("Status")
        .HasConversion<string>()
        .HasMaxLength(20);
}
```

Sin API interna, sin `EF1001`, y las consultas son correctas por construcción: `Where(o => o.StatusRaw == null)` emite `WHERE "o"."Status" IS NULL` y coincide con la fila NULL, mientras que `Where(o => o.StatusRaw == ShippingStatus.Shipped)` emite `WHERE "o"."Status" = 'Shipped'`. La mitad enum-a-string es la conversión integrada de siempre, cubierta en [cómo guardar un enum como string con un value converter](/es/2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter/), incluido el `HasMaxLength` que evita que SQL Server te entregue un `nvarchar(max)` no indexable.

El costo es que LINQ tiene que nombrar `StatusRaw`, no `Status`. Referenciar `Status` en un `Where` te da [la expresión LINQ no se pudo traducir](/es/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/), porque los miembros `[NotMapped]` no tienen contrapartida en SQL. Es un intercambio justo: el traductor se niega en tiempo de compilación y ejecución en vez de emitir `= NULL` en silencio.

### Mapea un campo de respaldo privado

Si prefieres no ampliar la superficie pública con un `StatusRaw`, mapea un campo y conserva una sola propiedad pública:

```csharp
// .NET 11, C# 14, EF Core 11
public class Order
{
    public int Id { get; set; }

    private string? _notes;

    public string Notes
    {
        get => _notes ?? "";
        set => _notes = value.Length == 0 ? null : value;
    }
}

protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Order>(e =>
    {
        e.Ignore(o => o.Notes);
        e.Property<string?>("_notes")
            .HasColumnName("Notes")
            .UsePropertyAccessMode(PropertyAccessMode.Field);
    });
}
```

Las lecturas y escrituras se comportan igual que en la versión con fachada, y `Where(o => EF.Property<string>(o, "_notes") == null)` se traduce a `WHERE "o"."Notes" IS NULL`. La desventaja es que toda consulta que toque la columna pasa por el `EF.Property<T>` basado en cadenas, que ningún refactor de renombrado seguirá. Prefiere la fachada salvo que la propiedad pública extra sea realmente inaceptable.

### O cambia los datos

Vale la pena decirlo sin rodeos, porque a menudo es la respuesta correcta: si NULL y tu centinela significan exactamente lo mismo, el esquema está cargando una distinción que el dominio no tiene. Un `UPDATE Orders SET Status = 'Unknown' WHERE Status IS NULL`, un `ALTER COLUMN ... NOT NULL` y un `HasDefaultValue("Unknown")` eliminan el problema en lugar de esquivarlo. Eso es una migración de datos más que un truco de mapeo, y [cómo renombrar una tabla en una migración sin perder datos](/es/2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data/) cubre la forma general de editar a mano una migración para llevar cambios de datos junto a cambios de esquema.

## En qué punto está la característica

El [issue #13850](https://github.com/dotnet/efcore/issues/13850), "Allow HasConversion/ValueConverters to convert nulls", sigue abierto y en el milestone Backlog sin fecha. Una petición de 2026 de una sobrecarga pública de `HasConversion` que reciba `convertsNulls`, el [issue #36365](https://github.com/dotnet/efcore/issues/36365), se cerró como duplicado de aquel. Así que el constructor de cuatro argumentos es donde queda esto para EF Core 11, advertencia incluida.

Úsalo cuando la propiedad del modelo sea un tipo de referencia, el centinela nunca se use como filtro, y tengas un test que verifique `ToQueryString()` para cada consulta que toque la columna. En todos los demás casos, y siempre con tipos de valor, mapea la propiedad anulable y haz el coalescing en C#.

### Sigue leyendo

- [Cómo guardar un enum como string en EF Core 11 con un value converter](/es/2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter/)
- [Solución: "The LINQ expression could not be translated" en EF Core 11](/es/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)
- [Solución: "The property could not be mapped, because it is not a supported primitive type or a valid entity type" en EF Core 11](/es/2026/07/fix-property-could-not-be-mapped-not-a-supported-primitive-type-in-ef-core-11/)
- [Cómo registrar el SQL que genera EF Core 11](/es/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [Solución: CS8618 "Non-nullable property must contain a non-null value when exiting constructor" en C#](/es/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/)

### Fuentes

- [Value Conversions](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions), documentación de EF Core
- [Constructores de ValueConverter&lt;TModel,TProvider&gt;](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.storage.valueconversion.valueconverter-2.-ctor), referencia de API de .NET
- [Issue #26230: Problems with value converters that convert nulls](https://github.com/dotnet/efcore/issues/26230), dotnet/efcore
- [Issue #13850: Allow HasConversion/ValueConverters to convert nulls](https://github.com/dotnet/efcore/issues/13850), dotnet/efcore
- [What's New in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew), documentación de EF Core
