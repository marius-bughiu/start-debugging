---
title: "Cómo configurar el mapeo de herencia tabla por jerarquía (TPH) en EF Core 11"
description: "TPH es la estrategia de herencia predeterminada de EF Core: una tabla, una columna discriminadora. Aquí verás cómo configurar el discriminador, compartir columnas, manejar propiedades derivadas anulables y los detalles en EF Core 11."
pubDate: 2026-07-13
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "inheritance"
  - "tph"
  - "dotnet-11"
  - "how-to"
lang: "es"
translationOf: "2026/07/how-to-configure-table-per-hierarchy-tph-inheritance-mapping-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-13
---

Respuesta corta: en EF Core 11 (con .NET 11 y C# 14), no tienes que hacer nada para obtener tabla por jerarquía (TPH). Es el valor predeterminado. En el momento en que mapeas un tipo base y al menos un tipo derivado, EF Core almacena toda la jerarquía en una tabla y añade una columna de cadena `Discriminator` para distinguir las filas. La configuración consiste en ajustar ese comportamiento predeterminado: renombrar la columna discriminadora con `HasDiscriminator`, elegir los valores almacenados con `HasValue`, mapear el discriminador a una propiedad real, marcar la jerarquía como incompleta con `IsComplete(false)` y compartir columnas entre tipos hermanos. EF Core 11 también elimina una limitación de larga data al permitir que los tipos complejos y las columnas JSON funcionen en jerarquías de herencia, y corrige un error de nulabilidad específico de TPH para las propiedades complejas mapeadas a JSON.

Este artículo cubre la API de configuración exacta, el esquema que genera EF Core, cómo funciona realmente una consulta contra una jerarquía TPH, el detalle de las columnas anulables que sorprende a todos al menos una vez, y cuándo TPH deja de ser la opción correcta.

## Por qué TPH es el valor predeterminado y suele ser el correcto

EF Core admite tres estrategias de herencia relacional: tabla por jerarquía (TPH), tabla por tipo (TPT) y tabla por tipo concreto (TPC). TPH es el valor predeterminado porque es el más rápido para el caso común. Todo vive en una tabla, así que cargar una entidad es una lectura de una sola fila sin joins, y consultar el tipo base es un `SELECT` sencillo sin `UNION` y sin ramificarse a través de tablas. La [documentación de herencia de EF Core](https://learn.microsoft.com/en-us/ef/core/modeling/inheritance) y la [guía de rendimiento](https://learn.microsoft.com/en-us/ef/core/performance/modeling-for-performance#inheritance-mapping) llegan a la misma regla: usa TPH salvo que un benchmark o una restricción externa te obligue a abandonarlo.

El costo que pagas es una tabla más ancha y dispersa. Cada propiedad de cada tipo derivado se convierte en una columna de la tabla compartida, y cualquier columna que solo usan algunas filas tiene que ser anulable. Para la mayoría de las jerarquías ese intercambio está bien. Cuando deja de estarlo, te mueves a TPT o TPC, que es una decisión aparte tratada al final.

## El mapeo predeterminado, sin nada configurado

EF no escanea tu ensamblado en busca de tipos derivados. Incluyes cada tipo en el modelo de forma explícita, normalmente exponiendo un `DbSet` o referenciándolo en `OnModelCreating`. Aquí tienes una jerarquía de dos niveles:

```csharp
// .NET 11, C# 14, EF Core 11
public class Payment
{
    public int Id { get; set; }
    public decimal Amount { get; set; }
    public DateTime CreatedAt { get; set; }
}

public class CardPayment : Payment
{
    public string Last4 { get; set; } = "";
    public string Network { get; set; } = "";
}

public class BankTransferPayment : Payment
{
    public string Iban { get; set; } = "";
}
```

```csharp
// .NET 11, EF Core 11
public class PaymentsContext : DbContext
{
    public DbSet<Payment> Payments { get; set; } = null!;
    public DbSet<CardPayment> CardPayments { get; set; } = null!;
    public DbSet<BankTransferPayment> BankTransferPayments { get; set; } = null!;
}
```

Sin ninguna configuración de herencia, EF Core 11 genera una sola tabla con cada propiedad de cada tipo, más una columna `Discriminator` que añade de forma implícita:

```sql
CREATE TABLE [Payments] (
    [Id] int NOT NULL IDENTITY,
    [Amount] decimal(18,2) NOT NULL,
    [CreatedAt] datetime2 NOT NULL,
    [Discriminator] nvarchar(max) NOT NULL,
    [Last4] nvarchar(max) NULL,
    [Network] nvarchar(max) NULL,
    [Iban] nvarchar(max) NULL,
    CONSTRAINT [PK_Payments] PRIMARY KEY ([Id])
);
```

Dos cosas a notar. El discriminador es una columna de cadena que almacena el nombre del tipo CLR (`"CardPayment"`, `"BankTransferPayment"`, `"Payment"`) para que EF sepa qué tipo materializar en cada fila. Y `Last4`, `Network` e `Iban` son todas anulables, porque una fila `BankTransferPayment` no tiene campos de tarjeta y una fila `CardPayment` no tiene IBAN. Esa nulabilidad es automática y, como veremos, no es algo que puedas anular para una propiedad de tipo derivado.

## Cómo una consulta TPH filtra por tipo

Cuando consultas el tipo base, EF Core lee cada fila y usa el discriminador para construir el objeto concreto correcto para cada una:

```csharp
// .NET 11, EF Core 11
var all = await context.Payments.ToListAsync();
// SELECT [p].[Id], [p].[Amount], [p].[CreatedAt], [p].[Discriminator],
//        [p].[Last4], [p].[Network], [p].[Iban]
// FROM [Payments] AS [p]
```

Cuando consultas un tipo derivado, EF añade un predicado sobre el discriminador para que solo obtengas las filas que coinciden:

```csharp
// .NET 11, EF Core 11
var cards = await context.CardPayments
    .Where(c => c.Network == "Visa")
    .ToListAsync();
// ... WHERE [p].[Discriminator] = N'CardPayment' AND [p].[Network] = N'Visa'
```

También puedes filtrar por tipo dentro de una consulta del tipo base con `OfType<T>()` o un patrón de tipo de C#, y ambos se traducen al mismo predicado sobre el discriminador:

```csharp
// .NET 11, EF Core 11
var cardsOnly = await context.Payments.OfType<CardPayment>().ToListAsync();
```

Hay una regla de materialización que conviene conocer: si la tabla contiene un valor de discriminador que no está mapeado a ningún tipo de tu modelo, EF lanza una excepción al llegar a esa fila, porque no sabe qué construir. Eso solo ocurre si algo ajeno a EF escribió filas con un discriminador desconocido. Si esa es tu situación, marca el mapeo como incompleto (más abajo) para que EF siempre añada el filtro del discriminador, incluso en las consultas del tipo base.

## Configurar la columna discriminadora y sus valores

La columna `Discriminator` implícita y los nombres de tipo CLR que almacena rara vez son lo que quieres en un esquema con el que tienes que convivir. Renombra la columna, fija su tipo y elige valores de cadena estables con `HasDiscriminator` y `HasValue`:

```csharp
// .NET 11, EF Core 11
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Payment>()
        .HasDiscriminator<string>("payment_type")
        .HasValue<Payment>("base")
        .HasValue<CardPayment>("card")
        .HasValue<BankTransferPayment>("bank_transfer");
}
```

Fijar cadenas `HasValue` explícitas importa más de lo que parece. Si dependes del valor predeterminado (el nombre del tipo CLR), renombrar una clase en una refactorización posterior cambia silenciosamente el valor del discriminador almacenado, y cada fila existente en producción tiene ahora un valor que tu nuevo modelo no reconoce. Los valores explícitos desacoplan la base de datos de los nombres de tus clases.

El discriminador no tiene que ser una cadena. Un `int` o un `enum` es más pequeño y se indexa mejor:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Payment>()
    .HasDiscriminator<int>("payment_type")
    .HasValue<Payment>(0)
    .HasValue<CardPayment>(1)
    .HasValue<BankTransferPayment>(2);
```

Como EF añade el discriminador de forma implícita como una [shadow property](https://learn.microsoft.com/en-us/ef/core/modeling/shadow-properties), también puedes configurarlo como cualquier otra propiedad, por ejemplo limitando la longitud de la cadena para que no sea `nvarchar(max)`:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Payment>()
    .Property("payment_type")
    .HasMaxLength(20);
```

## Mapear el discriminador a una propiedad real de .NET

A veces quieres que la etiqueta de tipo sea legible en la propia entidad, no oculta en una shadow property. Añade una propiedad al tipo base y apunta `HasDiscriminator` a ella:

```csharp
// .NET 11, C# 14, EF Core 11
public class Payment
{
    public int Id { get; set; }
    public decimal Amount { get; set; }
    public DateTime CreatedAt { get; set; }
    public string PaymentType { get; set; } = "";
}
```

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Payment>()
    .HasDiscriminator(p => p.PaymentType)
    .HasValue<CardPayment>("card")
    .HasValue<BankTransferPayment>("bank_transfer");
```

Ahora `payment.PaymentType` se rellena en cada entidad cargada. EF gestiona el valor: lo establece en el insert según el tipo concreto, y no te dejará escribir un valor que contradiga al tipo. Trátalo como de solo lectura desde tu código. Un discriminador mapeado es útil para consultas de reporte y para respuestas de API donde el cliente necesita el nombre del tipo sin que tú reflexiones sobre él.

## Decirle a EF que la jerarquía está incompleta

Si otro sistema escribe filas en la misma tabla con valores de discriminador que deliberadamente no mapeas, marca el discriminador como incompleto para que EF siempre filtre, incluso en las consultas del tipo base:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Payment>()
    .HasDiscriminator()
    .IsComplete(false);
```

Con `IsComplete(false)`, `context.Payments.ToListAsync()` añade `WHERE [payment_type] IN (N'card', N'bank_transfer', ...)` y omite las filas cuyo discriminador no está mapeado, en lugar de lanzar una excepción por ellas. Esta es exactamente la vía de escape para una tabla compartida donde EF solo posee algunos de los tipos.

## Compartir una columna entre tipos hermanos

De forma predeterminada, dos tipos hermanos que declaran una propiedad con el mismo nombre obtienen dos columnas separadas. Si las propiedades son del mismo tipo y representan realmente el mismo almacenamiento, mapéalas a una sola columna con `HasColumnName`:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<CardPayment>()
    .Property(c => c.Reference)
    .HasColumnName("Reference");

modelBuilder.Entity<BankTransferPayment>()
    .Property(b => b.Reference)
    .HasColumnName("Reference");
```

Esto mantiene la tabla más estrecha, pero hay una trampa de consulta que la documentación señala explícitamente. Los proveedores relacionales no añaden el predicado del discriminador cuando lees una columna compartida a través de un cast. Una consulta como `(payment as CardPayment).Reference` devuelve el valor de `Reference` también para las filas hermanas, porque la columna está físicamente compartida. Para restringirla a un solo tipo tienes que condicionar por el tipo tú mismo:

```csharp
// .NET 11, EF Core 11 - guard the cast so siblings return null
var refs = await context.Payments
    .Select(p => p is CardPayment ? ((CardPayment)p).Reference : null)
    .ToListAsync();
```

Comparte columnas solo cuando los valores sean realmente el mismo concepto. Ante la duda, deja que EF le dé a cada hermano su propia columna anulable.

## El detalle de las columnas anulables que nadie espera

Aquí está el que sorprende a la gente. Una propiedad que es requerida en un tipo derivado no puede ser una columna `NOT NULL` bajo TPH. Como todos los tipos comparten una tabla, una columna que pertenece a `CardPayment` debe ser anulable para que las filas `BankTransferPayment` puedan dejarla vacía. Aunque `Last4` sea `required` en C#, EF Core tiene que mapearla como una columna anulable:

```sql
[Last4] nvarchar(max) NULL   -- required on CardPayment, still NULL in the DB
```

La base de datos no impondrá por ti que "cada pago con tarjeta tenga Last4". La capa de aplicación y la propia validación de EF Core lo imponen en la escritura, pero un `INSERT` en crudo o una migración mal hecha puede producir una fila de tarjeta con un `Last4` nulo y el esquema no lo detendrá. Si el no-nulo impuesto por la base de datos sobre propiedades derivadas es un requisito firme, esa es una razón genuina para elegir TPT (cada tipo obtiene su propia tabla, así que la columna puede ser `NOT NULL` ahí) o para añadir una restricción `CHECK` a mano en una migración. Esta es la razón más común por la que un equipo mueve una jerarquía fuera de TPH, así que sopésala antes de comprometerte.

## Qué cambió EF Core 11 para la herencia

TPH en sí ha sido estable durante años; los cambios de EF Core 11 se refieren a lo que puedes poner dentro de una jerarquía. Los tipos complejos y las columnas JSON ahora funcionan en tipos de entidad que usan herencia TPT y TPC, algo que antes no se admitía y te obligaba a volver a las entidades propias (owned) para cualquier objeto de valor heredado. TPH ya admitía tipos complejos, y EF Core 11 corrigió un error específico de TPH donde una [propiedad compleja almacenada como JSON se marcaba incorrectamente como no anulable en una jerarquía de clases TPH](https://github.com/dotnet/efcore/issues/37404). Así que un objeto de valor mapeado en una tabla TPH ahora se comporta de forma anulable como debería:

```csharp
// .NET 11, C# 14, EF Core 11
[ComplexType]
public class CardMetadata
{
    public required string Bin { get; set; }
    public string? IssuerCountry { get; set; }
}

public class CardPayment : Payment
{
    public string Last4 { get; set; } = "";
    public CardMetadata? Metadata { get; set; }
}
```

La configuración también se acortó en todos los frentes. EF Core 11 te permite encadenar el acceso a miembros directamente a través de `Property`, así que profundizar en un tipo complejo o en una propiedad adyacente al discriminador ya no necesita un builder intermedio:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<CardPayment>()
    .Property(c => c.Metadata!.Bin)
    .HasMaxLength(8);
```

Si estás combinando un objeto de valor heredado con un mapeo de división de tabla o JSON, la mecánica de ese mapeo es la misma que en [cómo mapear un tipo complejo en lugar de una entidad propia en EF Core 11](/es/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/), y el lado de consulta JSON se cubre en [cómo mapear y consultar columnas JSON en EF Core 11](/es/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/).

## Las actualizaciones masivas y los filtros de consulta se llevan bien con TPH

Como una jerarquía TPH es una sola tabla, `ExecuteUpdate` y `ExecuteDelete` apuntan a un tipo derivado limpiamente, aplicando por ti el predicado del discriminador:

```csharp
// .NET 11, EF Core 11
await context.CardPayments
    .Where(c => c.Network == "Amex")
    .ExecuteUpdateAsync(s => s.SetProperty(c => c.Amount, c => c.Amount * 1.03m));
// UPDATE [p] SET [p].[Amount] = ... WHERE [p].[payment_type] = N'card' AND ...
```

Los compromisos entre esa vía y cargar entidades son los mismos que en [cómo usar ExecuteUpdate y ExecuteDelete para escrituras masivas en EF Core 11](/es/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/). Los filtros de consulta también se combinan con el discriminador, así que un filtro de borrado lógico o de multiinquilino sobre el tipo base se aplica a toda la jerarquía, como se describe en [cómo usar filtros de consulta con nombre para borrado lógico y multiinquilino en EF Core 11](/es/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/).

## Cuándo abandonar TPH

Quédate en TPH salvo que se cumpla una de estas condiciones:

- **Necesitas no-nulo impuesto por la base de datos en propiedades derivadas.** TPH no puede hacerlo; la columna compartida tiene que ser anulable. TPT le da a cada tipo su propia tabla donde la columna puede ser `NOT NULL`.
- **La tabla se está volviendo genuinamente dispersa y ancha.** Una jerarquía con muchos tipos derivados, cada uno añadiendo varias columnas requeridas en el código, produce una tabla que es mayormente nulos. Si eso perjudica el almacenamiento o tu DBA lo veta, TPT lo normaliza a costa de joins.
- **Consultas mayormente un solo tipo hoja y los benchmarks muestran que TPC gana.** TPC mantiene cada tipo concreto en su propia tabla con todas las columnas en línea, lo que puede superar a TPH en consultas de un solo tipo hoja. Mide antes de cambiar; TPC trae su propia generación de claves y restricciones de clave foránea.

Ten en cuenta que cambiar el tipo de una entidad en tiempo de ejecución (convertir un `CardPayment` en un `BankTransferPayment`) no se admite en ninguna estrategia. Borras y reinsertas. Esa es una realidad de modelado, no una limitación de TPH.

Para la regla práctica: TPH es el valor predeterminado porque es el predeterminado correcto. Configura el discriminador para que tu esquema no dependa de los nombres de clase, recuerda que las columnas de tipo derivado siempre son anulables, y recurre a TPT o TPC solo cuando una restricción concreta o un benchmark real te lo indiquen. Si esta decisión es parte de una actualización de versión mayor, la [guía de migración de EF Core 6 a EF Core 11](/es/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) cubre los cambios de herencia y mapeo que tienden a surgir junto a ella.

## Lecturas relacionadas

- [Cómo mapear un tipo complejo en lugar de una entidad propia en EF Core 11](/es/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/) explica el mapeo de objetos de valor, que ahora funciona dentro de las jerarquías de herencia.
- [Cómo mapear y consultar columnas JSON en EF Core 11](/es/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) cubre el lado JSON de las propiedades complejas en una tabla TPH.
- [Cómo usar ExecuteUpdate y ExecuteDelete para escrituras masivas en EF Core 11](/es/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) muestra la vía de escritura masiva que los predicados del discriminador dejan limpia.
- [Cómo usar filtros de consulta con nombre para borrado lógico y multiinquilino en EF Core 11](/es/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/) combina los filtros globales con una jerarquía TPH.
- [Fix: The entity type requires a primary key to be defined en EF Core 11](/es/2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined) es el complemento cuando a un tipo base o derivado le falta su clave.

## Fuentes

- [EF Core inheritance mapping](https://learn.microsoft.com/en-us/ef/core/modeling/inheritance)
- [What's New in EF Core 11: complex types and JSON on TPT/TPC](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [Modeling for performance: inheritance mapping](https://learn.microsoft.com/en-us/ef/core/performance/modeling-for-performance#inheritance-mapping)
- [EF Core shadow properties](https://learn.microsoft.com/en-us/ef/core/modeling/shadow-properties)
- [Complex property stored as JSON marked non-nullable in TPH class hierarchy (efcore#37404)](https://github.com/dotnet/efcore/issues/37404)
