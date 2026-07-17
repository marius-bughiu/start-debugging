---
title: "Solución: \"The property could not be mapped, because it is not a supported primitive type or a valid entity type\" en EF Core 11"
description: "EF Core encontró una propiedad que no sabe almacenar. Mapéala como tipo complejo, conviértela con HasConversion, dale una clave o ignórala con [NotMapped]."
pubDate: 2026-07-17
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
lang: "es"
translationOf: "2026/07/fix-property-could-not-be-mapped-not-a-supported-primitive-type-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-17
---

EF Core lanza `The property 'X.Y' could not be mapped, because it is of type 'Z' which is not a supported primitive type or a valid entity type` cuando tu modelo expone una propiedad que EF Core no puede convertir en columna ni tratar como relación. Corrígelo de una de cuatro formas, en orden de preferencia: mapéala como tipo complejo con `ComplexProperty` si es un objeto de valor, conviértela en un escalar con `HasConversion` (un conversor de valores) si es una lista de enum o un envoltorio personalizado, dale una clave al tipo para que EF Core lo mapee como entidad relacionada, o exclúyela por completo con `[NotMapped]` / `EntityTypeBuilder.Ignore` si nunca debería persistirse. Esto aplica a `Microsoft.EntityFrameworkCore` 11.0 en .NET 11 con C# 14, y el mensaje ha sido estable desde EF Core 3.0.

## El error en contexto

La excepción completa en tiempo de ejecución es una `InvalidOperationException` que se lanza mientras EF Core construye el modelo, lo que significa que se dispara la primera vez que tocas el `DbContext` (una consulta, un `SaveChanges` o `dotnet ef migrations add`), no cuando compilas:

```
System.InvalidOperationException: The property 'Customer.Tags' could not be mapped, because it is of type 'HashSet<Tag>' which is not a supported primitive type or a valid entity type. Either explicitly map this property, or ignore it using the '[NotMapped]' attribute or by using 'EntityTypeBuilder.Ignore' in 'OnModelCreating'.
```

Los dos identificadores del mensaje son lo único que necesitas leer: la propiedad (`Customer.Tags`) y su tipo (`HashSet<Tag>`). EF Core te está diciendo que recorrió tu entidad, encontró este miembro y no tenía ninguna regla para almacenarlo. La última frase enumera las salidas de emergencia pero no la correcta, y por eso este error manda a tanta gente directo a `[NotMapped]` incluso cuando los datos debían guardarse.

## Por qué ocurre

EF Core mapea una propiedad de exactamente una de tres maneras. Un escalar se convierte en columna (`int`, `string`, `decimal`, `DateTime`, `Guid`, `bool`, un `enum` y, desde EF Core 8, también `DateOnly` y `TimeOnly` y colecciones de primitivos como `List<string>`). Un tipo con una clave detectable se convierte en entidad relacionada, conectada a través de una clave foránea. Y un objeto de valor sin clave se convierte en un tipo complejo o una entidad propia, almacenado en línea en la tabla del propietario.

Este error significa que la propiedad no encajó en ninguna de las tres. El tipo no es un escalar que EF Core conozca, no tiene una clave que EF Core pueda encontrar (así que no puede ser una relación), y nunca le dijiste a EF Core que lo tratara como tipo complejo o propio. Desencadenantes habituales:

- Una **clase o struct personalizada** usada como objeto de valor (`Address`, `Money`, `GeoPoint`) que nunca configuraste.
- Una **colección de un tipo personalizado** (`List<OrderLine>`, `HashSet<Tag>`) cuyo tipo de elemento no tiene clave.
- Una **colección de enum** (`List<Status>`). Un solo enum se mapea sin problema, pero antes de EF Core 8 una colección de ellos no, y una colección de un tipo personalizado sigue sin hacerlo sin configuración.
- Un **diccionario u objeto arbitrario** (`Dictionary<string, string>`, `IDictionary`, `object`, `dynamic`, `JsonElement`) que no tiene representación natural en columna.
- Un **tipo de otra biblioteca** (`NodaTime.Instant`, un primitivo de dominio) sin mapeo de proveedor incorporado.

La solución nunca es adivinar. Decide qué *es* el dato y luego elige el mapeo que le corresponde.

## Reproducción mínima

El programa más pequeño que lo reproduce usa un objeto de valor que parece inofensivo. `Address` no tiene `Id`, así que EF Core no puede convertirlo en entidad relacionada, y no es un escalar, así que EF Core lanza el error:

```csharp
// .NET 11, C# 14, EF Core 11, Microsoft.EntityFrameworkCore.SqlServer 11.0
using Microsoft.EntityFrameworkCore;

using var db = new ShopContext();
await db.Database.EnsureCreatedAsync(); // throws here while building the model

public class Address
{
    public required string Street { get; set; }
    public required string City { get; set; }
}

public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public required Address ShippingAddress { get; set; } // unmapped: not scalar, no key
}

public class ShopContext : DbContext
{
    public DbSet<Customer> Customers => Set<Customer>();

    protected override void OnConfiguring(DbContextOptionsBuilder options) =>
        options.UseSqlServer("Server=.;Database=Shop;Trusted_Connection=True;Encrypt=False");
}
```

EF Core informa `The property 'Customer.ShippingAddress' could not be mapped, because it is of type 'Address'...`. La propiedad es real, el tipo es real, pero nada en el modelo le dice a EF Core cómo `Address` se convierte en almacenamiento.

## La solución, en detalle

Trabaja de arriba abajo. El primer mapeo que encaje con tu intención es el correcto.

### 1. Es un objeto de valor: mapéalo como tipo complejo

Si la propiedad es un objeto de valor que pertenece a la fila del propietario (una dirección, un importe de dinero, una coordenada), mapéala con `ComplexProperty`. Un tipo complejo no tiene identidad y se almacena en línea, que es exactamente lo que quiere un objeto de valor:

```csharp
// .NET 11, EF Core 11
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Customer>()
        .ComplexProperty(c => c.ShippingAddress);
}
```

O marca el tipo con `[ComplexType]` para que EF Core lo detecte por convención en todos los lugares donde aparezca:

```csharp
// .NET 11, C# 14, EF Core 11
[ComplexType]
public class Address
{
    public required string Street { get; set; }
    public required string City { get; set; }
}
```

Esto se mapea con división de tabla: columnas `ShippingAddress_Street` y `ShippingAddress_City` en `Customers`, sin join, sin clave foránea. Los tipos complejos son el reemplazo moderno de las entidades propias para objetos de valor, y traen semántica de valor que las entidades propias nunca tuvieron. La historia completa, incluyendo cuándo siguen quedándose cortos, está en [cómo mapear un tipo complejo en lugar de una entidad propia en EF Core 11](/es/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/). Si el tipo es un `record`, lee primero [cómo usar records con EF Core 11 correctamente](/es/2026/04/how-to-use-records-with-ef-core-11-correctly/), porque la igualdad de records interactúa con el seguimiento de cambios de formas que conviene entender antes de publicar.

### 2. En realidad es un escalar: conviértela con HasConversion

Si la propiedad es conceptualmente un solo valor para el que EF Core no tiene un mapeo incorporado, un conversor de valores lo transforma en un escalar de camino a la base de datos y de vuelta al salir. Esto cubre tipos de `NodaTime`, primitivos de dominio o un enum que quieras almacenar como su nombre en texto:

```csharp
// .NET 11, EF Core 11 - store the enum as its name, not its int
modelBuilder.Entity<Order>()
    .Property(o => o.Status)
    .HasConversion<string>();
```

Para un tipo de envoltorio personalizado, proporciona ambas direcciones explícitamente:

```csharp
// .NET 11, EF Core 11 - EmailAddress is a struct wrapping a string
modelBuilder.Entity<Customer>()
    .Property(c => c.Email)
    .HasConversion(
        email => email.Value,          // to the database column (nvarchar)
        value => new EmailAddress(value)); // back from the column
```

Un conversor de valores es la herramienta adecuada cuando hay un mapeo limpio y sin pérdida a una sola columna. Si el mapeo pierde información o el tipo es genuinamente compuesto (varios campos), usa un tipo complejo en su lugar. No recurras a un conversor solo para serializar todo un grafo de objetos en una cadena; ese camino viene a continuación y tiene aristas más afiladas.

### 3. Es una colección o un diccionario: colecciones de primitivos o una columna JSON

EF Core 8 añadió mapeo nativo para **colecciones de primitivos**, así que en EF Core 11 una `List<string>`, `int[]` o `List<DateOnly>` se mapea automáticamente a una columna JSON sin configuración. Si aún ves el error para una colección de primitivos, estás en EF Core 7 o anterior; actualizar lo corrige de raíz.

Para una colección de un **tipo personalizado** o un **diccionario**, EF Core no puede inferir la forma, así que serializa toda la propiedad a una columna JSON. En EF Core 11 la vía más limpia para una colección de objetos de valor es un tipo complejo mapeado a JSON:

```csharp
// .NET 11, EF Core 11 - store the whole collection as one json document
modelBuilder.Entity<Customer>()
    .ComplexProperty(c => c.Tags, b => b.ToJson());
```

Para un `Dictionary<string, string>` u otra bolsa de forma libre, un conversor de valores que ejecute `System.Text.Json` te da el mismo almacenamiento de una sola columna:

```csharp
// .NET 11, EF Core 11 - dictionary stored as a json string
modelBuilder.Entity<Customer>()
    .Property(c => c.Metadata)
    .HasConversion(
        dict => JsonSerializer.Serialize(dict, (JsonSerializerOptions?)null),
        json => JsonSerializer.Deserialize<Dictionary<string, string>>(json, (JsonSerializerOptions?)null)
                ?? new());
```

Una columna JSON es consultable en los proveedores modernos, así que no renuncias al filtrado para obtener almacenamiento de una sola columna. El lado de las consultas, incluyendo las funciones SQL que se adentran en un documento JSON, se cubre en [cómo mapear y consultar columnas JSON en EF Core 11](/es/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/). Si necesitas una forma de serialización personalizada en lugar de la predeterminada, [cómo escribir un JsonConverter personalizado en System.Text.Json](/es/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) muestra cómo controlar exactamente qué acaba en la columna.

### 4. En realidad es una entidad relacionada: dale una clave

Si la propiedad debería ser su propia tabla con sus propias filas (un `Order` que referencia registros `OrderLine` reales, no un objeto de valor en línea), entonces es una entidad, y el error significa que EF Core no pudo encontrar una clave para establecer la relación. Añade una clave y EF Core conecta la clave foránea automáticamente:

```csharp
// .NET 11, C# 14, EF Core 11
public class OrderLine
{
    public int Id { get; set; }     // now discoverable as a key
    public string Sku { get; set; } = "";
    public int Quantity { get; set; }
}

public class Order
{
    public int Id { get; set; }
    public List<OrderLine> Lines { get; set; } = []; // maps as a one-to-many
}
```

Si el tipo tiene un identificador que no se llama `Id` ni `OrderLineId`, díselo a EF Core con `HasKey` en `OnModelCreating`. Un tipo sin clave que no tiene clave natural pero aún necesita sus propias filas debe mapearse como colección propia con `OwnsMany`. Y si el error que en realidad estás mirando es [la entidad de tipo 'X' requiere que se defina una clave primaria](/es/2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined/), ese es el hermano cercano: EF Core llegó lo bastante lejos como para tratar el tipo como entidad pero luego no encontró ninguna clave.

### 5. Nunca debería persistirse: ignórala

Si la propiedad es una comodidad calculada, una caché o una referencia a un servicio que no tiene nada que hacer en la base de datos, exclúyela. El atributo es lo más rápido:

```csharp
// .NET 11, C# 14, EF Core 11
public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";

    [NotMapped]
    public string DisplayName => $"{Name} (#{Id})";
}
```

O hazlo en la configuración del modelo, lo que mantiene los POCO ignorantes de la persistencia libres de atributos de EF Core:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Customer>()
    .Ignore(c => c.DisplayName);
```

`Ignore` es la solución correcta solo cuando la respuesta a "¿debería existir esta columna?" es genuinamente no. Recurrir a él para silenciar el error sobre datos que pensabas guardar es la forma más común de que este error se convierta en un bug silencioso de pérdida de datos.

## Detalles y variantes

**Lo disparó una propiedad calculada de solo lectura.** EF Core intenta mapear cualquier propiedad legible, incluidas las de cuerpo de expresión. Si `DisplayName => ...` se deriva de otras columnas, no necesita almacenamiento; ignórala. Si es costosa y la quieres en la base de datos, mapea una columna calculada con `HasComputedColumnSql` en su lugar.

**Se rompió después de que añadieras `required` o cambiaras un tipo.** Añadir una propiedad de un tipo no mapeado, o cambiar un `string` por una struct personalizada, introduce el miembro no mapeado. El error nombra la propiedad exacta; revisa qué cambió en ese tipo.

**Una colección de enum.** `List<Status>` lanza el error en EF Core 7 y anteriores porque las colecciones de enum todavía no eran colecciones de primitivos. En EF Core 8 en adelante se mapea a una columna JSON automáticamente. Si estás en plena actualización, el comportamiento de las colecciones de enum es uno de varios cambios de mapeo en la [guía de migración de EF Core 6 a EF Core 11](/es/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

**El tipo vive en otro ensamblado y no puedes anotarlo.** No puedes poner `[ComplexType]` ni `[NotMapped]` en un tipo que no es tuyo, pero cada atributo tiene un equivalente fluido en `OnModelCreating` (`ComplexProperty`, `Property(...).HasConversion(...)`, `Ignore`). Configúralo desde tu `DbContext` y nunca tocas el tipo ajeno.

**Una navegación a un tipo abstracto o de interfaz.** EF Core no puede mapear una propiedad tipada como interfaz (`IAddress`) o como una base no mapeada sin un discriminador. Mapea el tipo concreto, o configura la herencia explícitamente.

**Es un filtro de `DbSet`, no una propiedad persistida.** Si la "propiedad" es en realidad un ayudante que consulta otros datos, no pertenece a la entidad en absoluto. Muévela a un repositorio o un servicio para que EF Core nunca la vea durante la construcción del modelo.

La decisión que te mantiene fuera de este error para siempre es una sola pregunta hecha antes de añadir la propiedad: ¿qué es esto, en términos de almacenamiento? Un objeto de valor va en línea como tipo complejo. Un solo valor convertible recibe un `HasConversion`. Una bolsa de datos se convierte en columna JSON. Algo con identidad se convierte en entidad relacionada con una clave. Y un ayudante puramente en memoria se ignora. EF Core lanza el error precisamente porque se niega a adivinar cuál de esos querías.

## Relacionados

- [Cómo mapear un tipo complejo en lugar de una entidad propia en EF Core 11](/es/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/) es el análisis a fondo del mapeo de objeto de valor al que este error apunta con más frecuencia.
- [Cómo mapear y consultar columnas JSON en EF Core 11](/es/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) cubre cómo almacenar y filtrar una colección o documento serializado.
- [Solución: la entidad de tipo 'X' requiere que se defina una clave primaria](/es/2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined/) es el error hermano cuando EF Core trata el tipo como entidad pero no encuentra clave.
- [Cómo usar records con EF Core 11 correctamente](/es/2026/04/how-to-use-records-with-ef-core-11-correctly/) importa cuando tu objeto de valor es un record y el seguimiento de cambios entra en juego.
- [Cómo escribir un JsonConverter personalizado en System.Text.Json](/es/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) da forma exacta a lo que almacena una propiedad de conversor a JSON.

## Fuentes

- [Conversiones de valores, documentación de EF Core](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions)
- [Tipos complejos, novedades de EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [Colecciones de primitivos, novedades de EF Core 8](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/whatsnew#primitive-collections)
- [Excluir tipos o propiedades del modelo, documentación de EF Core](https://learn.microsoft.com/en-us/ef/core/modeling/#excluding-types-from-the-model)
- [dotnet/efcore issue #15987: property could not be mapped, not a supported primitive type](https://github.com/dotnet/efcore/issues/15987)
