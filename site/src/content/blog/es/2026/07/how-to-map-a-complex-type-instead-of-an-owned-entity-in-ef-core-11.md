---
title: "Cómo mapear un complex type en lugar de una entidad propia en EF Core 11"
description: "Las entidades propias arrastran una clave oculta y una identidad por referencia que chocan con los objetos de valor. Aquí verás cómo mapear un objeto de valor como complex type en EF Core 11, cuándo cambiar y las trampas."
pubDate: 2026-07-12
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "complex-types"
  - "owned-entities"
  - "dotnet-11"
  - "how-to"
lang: "es"
translationOf: "2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-12
---

Respuesta corta: en EF Core 11 (con .NET 11 y C# 14), mapea un objeto de valor como `Address` o `Money` con `ComplexProperty` en lugar de `OwnsOne`. Un complex type no tiene clave ni identidad, así que EF Core lo trata con semántica de valor: asignarlo copia los campos, compararlo compara el contenido, y `ExecuteUpdate` puede tocar sus propiedades. Una entidad propia sigue siendo un tipo de entidad por debajo, con una clave en sombra e identidad por referencia, y eso es justamente el origen de las sorpresas con las que la gente se topa (no puedes asignar una referencia compartida, la igualdad LINQ se rompe, la actualización masiva queda bloqueada). Los complex types se introdujeron en EF Core 8, ganaron mapeo opcional (anulable) y columnas JSON en EF Core 10, y en EF Core 11 pasaron a ser utilizables en jerarquías de herencia TPT/TPC con una API de configuración más limpia. El cambio es una modificación de la configuración del modelo más una migración.

Este artículo cubre qué diferencia realmente los dos mapeos, la configuración exacta de `ComplexProperty` para table splitting y JSON, cómo migrar un mapeo `OwnsOne` existente sin perder datos, y los casos en los que todavía tienes que recurrir a entidades propias.

## Por qué las entidades propias nunca fueron la forma correcta para un objeto de valor

Cuando EF Core añadió los tipos de entidad propia, se presentaron como la manera de modelar objetos de valor: un `Address` que vive dentro de un `Customer`, mapeado a la misma tabla. Eso funciona, pero siempre fue un compromiso. Una entidad propia **es un tipo de entidad**. EF Core le da una clave primaria (normalmente una clave en sombra que gestiona por ti), la rastrea en el change tracker como su propio nodo, y razona sobre ella con identidad por referencia. La [documentación de entidades propias](https://learn.microsoft.com/en-us/ef/core/modeling/owned-entities) lleva años advirtiendo sobre las aristas afiladas que se derivan de eso.

Tres de esas aristas muerden constantemente.

Primero, no puedes compartir una instancia. Esto parece que debería funcionar y no lo hace:

```csharp
// .NET 11, EF Core 11 - owned entity mapping
var customer = await context.Customers.SingleAsync(c => c.Id == id);
customer.BillingAddress = customer.ShippingAddress;
await context.SaveChangesAsync(); // throws with owned entities
```

Como ambas propiedades son el mismo tipo de entidad, EF Core ve una entidad referenciada dos veces y la rechaza. Segundo, la igualdad LINQ compara por identidad, no por contenido, así que `context.Customers.Where(c => c.BillingAddress == c.ShippingAddress)` no significa lo que crees. Tercero, `ExecuteUpdate` no admite en absoluto propiedades de entidades propias.

Un complex type es el mapeo que realmente estaba pensado para esto. No tiene identidad propia. Se define por completo por sus datos, que es la definición de un objeto de valor. Asignarlo copia los campos. Compararlo compara los campos. Y EF Core 11 lo admite en `ExecuteUpdate`. La propia recomendación del equipo de EF en las [notas de la versión EF Core 10](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew#complex-types) es contundente: "se aconseja a los usuarios que ya usan tipos de entidad propia para esto que cambien a complex types."

## El mapeo mínimo de un complex type

Empieza con el objeto de valor y la entidad que lo contiene. El objeto de valor no necesita clave, ni `Id`, ni nada que huela a identidad:

```csharp
// .NET 11, C# 14, EF Core 11
public class Address
{
    public required string Street { get; set; }
    public required string City { get; set; }
    public required string PostalCode { get; set; }
}

public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public required Address ShippingAddress { get; set; }
    public Address? BillingAddress { get; set; }
}
```

Hay dos maneras de decirle a EF Core que esto es un complex type. La API fluida en `OnModelCreating`:

```csharp
// .NET 11, EF Core 11
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Customer>(b =>
    {
        b.ComplexProperty(c => c.ShippingAddress);
        b.ComplexProperty(c => c.BillingAddress);
    });
}
```

O el atributo `[ComplexType]` sobre el objeto de valor, que permite que EF Core lo detecte por convención dondequiera que se use:

```csharp
// .NET 11, C# 14, EF Core 11
[ComplexType]
public class Address
{
    public required string Street { get; set; }
    public required string City { get; set; }
    public required string PostalCode { get; set; }
}
```

Por defecto esto se mapea a **table splitting**: las columnas de la dirección viven directamente en la tabla `Customers` con un prefijo.

```sql
CREATE TABLE [Customers] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    [ShippingAddress_Street] nvarchar(max) NOT NULL,
    [ShippingAddress_City] nvarchar(max) NOT NULL,
    [ShippingAddress_PostalCode] nvarchar(max) NOT NULL,
    [BillingAddress_Street] nvarchar(max) NULL,
    [BillingAddress_City] nvarchar(max) NULL,
    [BillingAddress_PostalCode] nvarchar(max) NULL,
    CONSTRAINT [PK_Customers] PRIMARY KEY ([Id])
);
```

Fíjate en que no hay una tabla `Addresses` separada ni una clave foránea. Ese es el punto: el objeto de valor es parte de la fila de su propietario, sin join ni identidad que gestionar.

## Los complex types opcionales (anulables) necesitan al menos una propiedad requerida

El `BillingAddress? BillingAddress` de arriba funciona porque EF Core 10 añadió soporte para complex types **opcionales**. El objeto entero puede ser null, y EF Core decide la presencia a partir de los valores de las columnas. Hay una regla que hace tropezar a la gente: un complex type opcional debe tener al menos una propiedad requerida (no anulable). EF Core usa esa columna para distinguir "toda la dirección es null" de "la dirección está presente pero sus campos opcionales son null". Si cada propiedad de `Address` fuera anulable, EF Core no tendría ninguna señal para diferenciar esos dos estados, y la construcción del modelo lanza una excepción.

En la práctica esto casi nunca es una restricción, porque una dirección real tiene al menos un campo que debe estar presente. Si de verdad tienes un objeto de valor en el que todos los campos son opcionales, añade un discriminador o replantéate si debería ser anulable siquiera.

## Mapear un complex type a una sola columna JSON

El table splitting reparte los campos entre columnas. Si prefieres mantener el objeto de valor como un único documento JSON opaco, EF Core 10 añadió `ToJson()` en las complex properties, y EF Core 11 lo mantiene estable:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Customer>(b =>
{
    b.ComplexProperty(c => c.ShippingAddress, c => c.ToJson());
    b.ComplexProperty(c => c.BillingAddress, c => c.ToJson());
});
```

En SQL Server 2025 (o Azure SQL) esto usa el tipo de columna nativo `json`:

```sql
CREATE TABLE [Customers] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    [ShippingAddress] json NOT NULL,
    [BillingAddress] json NULL,
    CONSTRAINT [PK_Customers] PRIMARY KEY ([Id])
);
```

El mapeo a JSON te compra una cosa que el table splitting no puede hacer: **colecciones dentro del tipo mapeado**. Un complex type mapeado con table splitting tiene que ser un único valor, pero un complex type mapeado a JSON puede contener una `List<string>` o una lista anidada de objetos de valor. Aun así puedes consultar dentro del documento. En SQL Server 2025, `context.Customers.Where(c => c.ShippingAddress.City == "Cluj")` se traduce a una búsqueda `JSON_VALUE`, y EF Core 11 añade `EF.Functions.JsonPathExists` y `EF.Functions.JsonContains`, ambos funcionan contra complex types mapeados a JSON. Para el panorama más amplio de consultar datos mapeados a JSON, mira [cómo mapear y consultar columnas JSON en EF Core 11](/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) y la [traducción de JSON_CONTAINS añadida en SQL Server 2025](/2026/04/efcore-11-json-contains-sql-server-2025/).

## Qué te da realmente la semántica de valor

Una vez que el mapeo es un complex type, las tres aristas de las entidades propias desaparecen.

Compartir una instancia ahora funciona, porque la asignación copia campos en lugar de aliasear una referencia rastreada:

```csharp
// .NET 11, EF Core 11 - complex type mapping
var customer = await context.Customers.SingleAsync(c => c.Id == id);
customer.BillingAddress = customer.ShippingAddress; // copies the values
await context.SaveChangesAsync(); // succeeds
```

La igualdad LINQ compara contenido, así que esto devuelve los clientes cuyas dos direcciones son genuinamente iguales:

```csharp
// .NET 11, EF Core 11
var sameAddress = await context.Customers
    .Where(c => c.BillingAddress == c.ShippingAddress)
    .ToListAsync();
```

Y la actualización masiva alcanza el interior del complex type, cosa que las entidades propias nunca permitieron:

```csharp
// .NET 11, EF Core 11
await context.Customers
    .Where(c => c.ShippingAddress.City == "Bucuresti")
    .ExecuteUpdateAsync(s =>
        s.SetProperty(c => c.ShippingAddress.PostalCode, "010001"));
```

Si estás sopesando las rutas de escritura frente a cargar y mutar entidades, los compromisos son los mismos que se cubren en [ExecuteUpdate frente a cargar entidades y SaveChanges](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/); los complex types simplemente hacen que el caso del objeto de valor sea elegible para la ruta rápida.

Los struct también funcionan, lo que encaja perfectamente con la idea de "sin identidad":

```csharp
// .NET 11, C# 14, EF Core 11
public struct Money
{
    public required decimal Amount { get; set; }
    public required string Currency { get; set; }
}
```

Los record también encajan bien, y la interacción entre records, complex types y change tracking merece leerse en detalle en [cómo usar records con EF Core 11 correctamente](/2026/04/how-to-use-records-with-ef-core-11-correctly/).

## Migrar un mapeo OwnsOne existente a un complex type

Si ya usas `OwnsOne` en producción, el cambio es mecánico, y con table splitting suele ser neutral respecto al esquema porque las columnas se nombran y tipan de la misma manera. Aquí está el procedimiento.

1. **Confirma la forma de almacenamiento actual.** Si tu `OwnsOne` mapea a la tabla del propietario (el valor por defecto), las columnas ya son `Owner_Property`. Si usa `OwnsOne(...).ToTable("Addresses")` (una tabla separada) o `OwnsOne(...).ToJson()`, anótalo, porque el almacenamiento de destino importa para saber si la migración mueve datos.
2. **Elimina la fuga de identidad del objeto de valor.** Borra cualquier propiedad `Id`, cualquier configuración explícita de clave, y cualquier navegación de vuelta al propietario. Un complex type no puede tener clave ni referencia de vuelta.
3. **Reemplaza `OwnsOne` con `ComplexProperty`.** Cambia `b.OwnsOne(c => c.ShippingAddress)` por `b.ComplexProperty(c => c.ShippingAddress)`, y `b.OwnsOne(c => c.ShippingAddress, a => a.ToJson())` por `b.ComplexProperty(c => c.ShippingAddress, a => a.ToJson())`. Traslada la configuración por propiedad como `HasMaxLength` y `HasColumnName`.
4. **Haz anulables en el tipo CLR los objetos de valor opcionales.** Si la referencia propia podía estar ausente, declara la propiedad como `Address?` y confirma que el tipo tiene al menos una propiedad requerida para que EF Core pueda detectar el null.
5. **Añade e inspecciona la migración.** Ejecuta `dotnet ef migrations add SwitchAddressToComplexType`. Para un `OwnsOne` con table splitting en la misma tabla, la migración debería estar vacía o casi vacía porque las columnas no se mueven. Si quiere eliminar y recrear columnas, tus nombres de columna divergieron; fíjalos con `HasColumnName` hasta que el diff quede limpio, para que no pierdas datos.
6. **Verifica primero el comportamiento que preserva los datos en una copia.** Aplica la migración a una base de datos de prueba restaurada desde producción antes de ejecutarla en serio, sobre todo si estás pasando de una tabla separada o de JSON `nvarchar` al tipo nativo `json`.

La única migración que realmente mueve datos es pasar de `OwnsOne(...).ToTable("Addresses")` (una tabla separada) a un complex type con table splitting. No hay una ruta autogenerada limpia para eso, porque las filas tienen que moverse de la tabla hija a la padre. Escribe esa migración a mano: añade las nuevas columnas, `UPDATE ... FROM` para copiar los valores, luego elimina la tabla vieja. Si ya estás metido de lleno en una actualización de EF Core, el mismo cuidado aplica al resto de tu modelo; la [guía de migración de EF Core 6 a EF Core 11](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) cubre los cambios que rompen y que tienden a aparecer junto a este.

## EF Core 11 elimina la fricción de herencia y configuración

Dos cosas mejoraron específicamente en EF Core 11 y hacen más fácil el cambio.

Los complex types (y las columnas JSON) ahora funcionan en entidades que usan **herencia TPT (table-per-type) y TPC (table-per-concrete-type)**. Antes de EF Core 11, una complex property en un tipo base dentro de una jerarquía TPT/TPC no se admitía, lo que te obligaba a volver a las entidades propias para cualquier objeto de valor heredado. Ahora esto se mapea correctamente:

```csharp
// .NET 11, C# 14, EF Core 11
public abstract class Animal
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public required AnimalDetails Details { get; set; }
}

public class Dog : Animal { public string Breed { get; set; } = ""; }
public class Cat : Animal { public bool IsIndoor { get; set; } }

[ComplexType]
public class AnimalDetails
{
    public DateTime BirthDate { get; set; }
    public string? Veterinarian { get; set; }
}

// OnModelCreating
modelBuilder.Entity<Animal>().UseTptMappingStrategy();
```

EF Core 11 crea las columnas `Details_BirthDate` y `Details_Veterinarian` en la tabla `Animal` como se espera.

La configuración también se acortó. Antes, entrar en una propiedad de un complex type significaba agarrar primero el builder del complex:

```csharp
// Pre-EF Core 11
modelBuilder.Entity<Customer>()
    .ComplexProperty(c => c.ShippingAddress)
    .Property(a => a.Street)
    .HasMaxLength(200);
```

EF Core 11 te permite encadenar el acceso a miembros directamente en `Property`:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Customer>()
    .Property(c => c.ShippingAddress.Street)
    .HasMaxLength(200);
```

EF Core 11 también trajo un lote de correcciones de estabilización para complex types, incluyendo la comparación correcta de complex types anidados, la asignación correcta de `ExecuteUpdate` en propiedades anidadas, y un arreglo para una `NullReferenceException` cuando dos tipos compartían una complex property anulable mapeada a la misma columna. Si probaste complex types en EF Core 9 y te topaste con aristas ásperas, EF Core 11 es la versión en la que están pensados para ser un reemplazo completo de las entidades propias.

## Cuándo todavía tienes que usar una entidad propia

Los complex types no cubren todos los casos. Recurre a `OwnsOne` u `OwnsMany` cuando:

- **Necesitas el objeto de valor en una tabla separada.** Los complex types siempre son inline, ya sea como columnas divididas o una única columna JSON. No existe `ComplexProperty(...).ToTable("Addresses")`. Si tu esquema requiere los datos en su propia tabla con una clave foránea, eso es una entidad propia (o completa).
- **Necesitas una colección mapeada a filas separadas.** Un complex type con table splitting debe ser un único valor; las colecciones de struct no se admiten en absoluto. Un complex type mapeado a JSON puede contener una colección dentro del documento, pero si quieres cada elemento como su propia fila en una tabla hija, `OwnsMany` sigue siendo la herramienta.
- **Algo genuinamente necesita identidad.** Si dos "objetos de valor" con el mismo contenido deben ser distinguibles, o necesitas rastrearlos y actualizarlos de forma independiente, no son objetos de valor. Modélalos como una entidad relacionada real.

La regla general es la misma que separa una `class` de un `record`: si la cosa se define por sus datos, mapéala como complex type; si tiene una identidad que sobrevive a sus datos, es una entidad. Para la mayoría de los tipos `Address`, `Money`, `GeoPoint` y `DateRange` en una base de código .NET 11, los complex types son ahora el valor por defecto correcto, y las entidades propias son la excepción a la que bajas solo cuando la forma de almacenamiento te obliga.

## Lecturas relacionadas

- [Cómo usar records con EF Core 11 correctamente](/2026/04/how-to-use-records-with-ef-core-11-correctly/) profundiza en los records como complex types frente a entidades y las reglas de change tracking detrás de la división.
- [Cómo mapear y consultar columnas JSON en EF Core 11](/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) cubre el lado de la consulta de los complex types mapeados a JSON.
- [EF Core 11 traduce Contains a JSON_CONTAINS en SQL Server 2025](/2026/04/efcore-11-json-contains-sql-server-2025/) explica las funciones JSON que ahora funcionan contra complex types.
- [ExecuteUpdate frente a cargar entidades y SaveChanges](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) enmarca la ruta de actualización masiva que los complex types desbloquean para los objetos de valor.
- [Migrar de EF Core 6 a EF Core 11: cambios que rompen y que de verdad muerden](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) es el complemento si este cambio es parte de una actualización mayor.

## Fuentes

- [What's New in EF Core 10: Complex types](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew#complex-types)
- [What's New in EF Core 11: Complex types](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [EF Core owned entity types](https://learn.microsoft.com/en-us/ef/core/modeling/owned-entities)
- [EF Core inheritance mapping](https://learn.microsoft.com/en-us/ef/core/modeling/inheritance)
- [Allow mapping optional complex properties (efcore#31376)](https://github.com/dotnet/efcore/issues/31376)
