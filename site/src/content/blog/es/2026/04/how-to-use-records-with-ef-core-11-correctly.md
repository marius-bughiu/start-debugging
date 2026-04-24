---
title: "Cómo usar records con EF Core 11 correctamente"
description: "Una guía práctica para mezclar records de C# y EF Core 11. Dónde encajan los records, dónde rompen el change tracking, y cómo modelar value objects, entidades y proyecciones sin pelearte con el framework."
pubDate: 2026-04-21
tags:
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "records"
  - "dotnet-11"
  - "how-to"
lang: "es"
translationOf: "2026/04/how-to-use-records-with-ef-core-11-correctly"
translatedBy: "claude"
translationDate: 2026-04-24
---

Respuesta corta: en EF Core 11 y C# 14, usa tipos `record class` para proyecciones, DTOs y tipos complejos (value objects), y prefiere una `class` plana con propiedades `init`-only y un constructor de binding para entidades trackeadas. `record struct` está bien como tipo complejo pero nunca como entidad trackeada. La fricción que sufre la gente casi siempre viene de intentar usar records posicionales como entidades completas y luego sorprenderse cuando las expresiones `with`, la igualdad por valor, o las claves primarias de solo lectura chocan con el tracking de identidad de EF Core. La solución no es un setting, es saber qué forma de record va en cada asiento.

Este post cubre los tres asientos (entidad, tipo complejo, proyección), muestra las reglas de binding del constructor que realmente vienen en EF Core 11, y recorre las trampas específicas que hacen tropezar a la gente: claves generadas por la base, la expresión `with`, propiedades de navegación, trampas de igualdad por valor, y records mapeados a JSON.

## Por qué records y EF Core tienen reputación de pelearse

Los records de C# se diseñaron para hacer fáciles los tipos de datos inmutables y con igualdad por valor. Dos instancias de un `record Address(string City, string Zip)` son iguales cuando sus campos son iguales, no cuando son la misma referencia. Esa es exactamente la semántica correcta para un value object.

El change tracker de EF Core está construido sobre la suposición opuesta. El [ChangeTracker](https://learn.microsoft.com/en-us/ef/core/change-tracking/) guarda un snapshot de los valores de propiedad de cada entidad cuando la entidad se attach por primera vez, y la [identity resolution](https://learn.microsoft.com/en-us/ef/core/change-tracking/identity-resolution) dice que dentro de un solo `DbContext` hay exactamente una instancia CLR por clave primaria. Ambos dependen de la identidad por referencia, no por valor. Si estampas un `record` con una clave primaria y luego lo mutas produciendo una nueva instancia vía `with`, ahora tienes dos referencias CLR que comparan iguales pero no son la misma entidad trackeada. El change tracker o lanza porque la PK ya está trackeada, o silenciosamente ignora tus ediciones.

La documentación oficial de C# lleva años diciendo que "los record types no son apropiados para usar como entity types en Entity Framework Core". Esa advertencia es un resumen contundente de la situación de arriba, no una prohibición dura. Puedes usar records como entidades, y EF Core 11 sigue soportando todos los mecanismos necesarios para hacerlo. Solo tienes que escoger la forma no-posicional, init-only, y jugar siguiendo las reglas de binding del constructor en [los docs de constructores de EF Core](https://learn.microsoft.com/en-us/ef/core/modeling/constructors).

## Asiento 1: records como tipos complejos (el sweet spot)

EF Core 8 introdujo `ComplexProperty`, y EF Core 11 hizo los tipos complejos lo suficientemente estables como para recomendarlos como reemplazo por defecto de las entidades owned en la mayoría de los casos. Los tipos complejos son exactamente donde brillan los records: un tipo complejo no tiene identidad propia, su igualdad por valor encaja con la semántica de la base de datos, y está pensado para reemplazarse por completo cuando cualquier campo cambia.

```csharp
// .NET 11, C# 14, EF Core 11
public record Address(string Street, string City, string PostalCode);

public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public Address ShippingAddress { get; set; } = new("", "", "");
    public Address BillingAddress { get; set; } = new("", "", "");
}

// OnModelCreating
modelBuilder.Entity<Customer>(b =>
{
    b.ComplexProperty(c => c.ShippingAddress);
    b.ComplexProperty(c => c.BillingAddress);
});
```

Lo que hace que esto funcione:

- `Address` es un `record class` posicional. EF Core mapea records posicionales out of the box para tipos complejos porque el constructor primario coincide con los nombres de las propiedades uno a uno.
- `Address` no necesita su propia clave primaria, porque los tipos complejos no tienen identidad.
- Reemplazar la `ShippingAddress` de un cliente con `customer.ShippingAddress = customer.ShippingAddress with { City = "Cluj" };` actualiza la entidad trackeada como esperas. EF Core ve que el snapshot del `Customer` diverge de sus valores previos y marca las tres columnas mapeadas como dirty.

Si necesitas un tipo por valor, un `record struct` también es válido para una propiedad compleja y evita la asignación extra en heap por fila. La compensación es la habitual: conjuntos grandes de campos duelen al copiar, y pierdes la posibilidad de añadir un constructor sin parámetros para las convenciones de EF sin salirte del camino.

```csharp
// .NET 11, C# 14
public readonly record struct Money(decimal Amount, string Currency);
```

Usa `record struct` para valores pequeños y de forma fija (dinero, coordenadas, rangos de fechas). Usa `record class` para todo lo demás.

## Asiento 2: records como entidades (funciona, pero requiere disciplina)

Si quieres una entidad con apariencia de inmutable, la forma que sobrevive al change tracking es un `record class` con propiedades **no-posicionales** init-only y un constructor de binding al que EF Core pueda llamar durante la materialización.

```csharp
// .NET 11, C# 14, EF Core 11
public record class BlogPost
{
    // EF binds to this ctor during materialization
    public BlogPost(int id, string title, DateTime publishedAt)
    {
        Id = id;
        Title = title;
        PublishedAt = publishedAt;
    }

    // Parameterless ctor lets EF (and serializers) create instances
    // before setting properties one at a time when needed.
    private BlogPost() { }

    public int Id { get; init; }
    public string Title { get; init; } = "";
    public DateTime PublishedAt { get; init; }

    // Navigation props cannot be bound via constructor.
    public List<Comment> Comments { get; init; } = new();
}
```

Las reglas de [los docs de binding del constructor](https://learn.microsoft.com/en-us/ef/core/modeling/constructors), aplicadas a records:

1. Si EF Core encuentra un constructor cuyos nombres y tipos de parámetros coincidan con propiedades mapeadas, usa ese constructor durante la materialización. Las propiedades en Pascal-case pueden coincidir con parámetros en camel-case.
2. Las propiedades de navegación (colecciones, referencias) no pueden bindearse por el constructor. Mantenlas fuera del constructor primario e inicialízalas con un default.
3. Las propiedades sin ningún setter no se mapean por convención. `init` cuenta como setter, así que las propiedades init-only se mapean. Una propiedad declarada como `public string Title { get; }` sin setter es tratada como propiedad calculada y se omite.
4. Las claves generadas por la base necesitan una clave escribible. `init` es escribible en tiempo de inicialización del objeto, que es cuando EF Core la setea, así que `int Id { get; init; }` funciona para columnas de identidad generadas por la base.

¿Por qué no usar un record posicional para la entidad en sí? Dos razones.

Primero, un record posicional tiene un **set de propiedades implícito generado por el compilador** con setters `init`, pero también tiene un método `<Clone>$` protegido y un constructor de copia que las expresiones `with` usan. En el momento en que llamas a `post with { Title = "New title" }`, obtienes una instancia nueva de `BlogPost` que tiene la misma clave primaria que la trackeada. Si intentas `context.Update(newPost)` te dará `InvalidOperationException: The instance of entity type 'BlogPost' cannot be tracked because another instance with the same key value for {'Id'} is already being tracked.` La identity resolution está haciendo su trabajo; le diste dos referencias a lo que cree que es la misma fila.

Segundo, los records posicionales generan `Equals` y `GetHashCode` basados en valor. El change tracker de EF Core, el fixup de relaciones y `DbSet.Find` se apoyan en identidad por referencia. La igualdad por valor no rompe esto del todo, pero crea comportamientos sorprendentes: dos entidades recién cargadas de queries distintas pueden ser hash-iguales siendo instancias trackeadas diferentes, y `HashSet<BlogPost>` las colapsa. Mantén la igualdad por valor lejos de cualquier cosa que tenga identidad.

Un record class con propiedades explícitas, como arriba, evita ambas trampas. Obtienes la inmutabilidad y el bonito `ToString`, y renuncias a la mutación basada en `with` (que es la característica que no querías en una entidad trackeada de todas formas).

### Actualizando una entidad de estilo inmutable

Como la entidad es "inmutable", el camino de actualización no puede ser "mutar, luego SaveChanges". Los dos patrones viables en EF Core 11:

```csharp
// .NET 11, EF Core 11
// Pattern A: load, assign to a local with init setters cleared.
// Requires exposing init setters on the class.
var post = await db.BlogPosts.SingleAsync(p => p.Id == id);

// This mutates the tracked instance. Works because 'init' is
// a settable accessor from EF Core's point of view, and nothing
// stops you from assigning through reflection or source-gen.
// If you want real immutability, use Pattern B.
db.Entry(post).Property(p => p.Title).CurrentValue = "New title";
await db.SaveChangesAsync();

// Pattern B: detach the old, attach a freshly-constructed one,
// mark the touched columns modified. No 'with' expression.
var updated = new BlogPost(post.Id, "New title", post.PublishedAt);
db.Entry(post).State = EntityState.Detached;
db.Attach(updated);
db.Entry(updated).Property(p => p.Title).IsModified = true;
await db.SaveChangesAsync();
```

El Patrón A es donde la mayoría de los equipos terminan: usan records por el `ToString` ergonómico, la deconstrucción y la igualdad por campo en lecturas, y aceptan que el camino de escritura va por el change tracker mutando las propiedades init vía la metadata de EF Core. Eso no es una violación de la inmutabilidad a nivel de lenguaje, es solo cómo EF Core bindea propiedades. Hay un issue de larga data en EF Core trackeando soporte de primer nivel para actualizaciones inmutables ([efcore#11457](https://github.com/dotnet/efcore/issues/11457)) si quieres la historia completa.

## Asiento 3: records como proyecciones y DTOs (siempre seguro)

Cualquier vez que un record se materialice fuera del change tracker, ninguno de los problemas de arriba aplica. Las proyecciones de records son el patrón más aburrido y el más útil:

```csharp
// .NET 11, C# 14, EF Core 11
public record PostSummary(int Id, string Title, DateTime PublishedAt);

// No tracking, no identity, no ChangeTracker snapshot.
var summaries = await db.BlogPosts
    .AsNoTracking()
    .Select(p => new PostSummary(p.Id, p.Title, p.PublishedAt))
    .ToListAsync();
```

El pipeline de queries de EF Core 11 bindea felizmente a records posicionales en proyecciones. Puedes enviarlos directamente desde una API web con `System.Text.Json`, que ha soportado serialización de records desde .NET 5 y deserialización de records posicionales desde .NET 7.

El mismo argumento aplica a DTOs de input en comandos: acepta un record posicional desde el controller, valídalo, mapéalo a la forma de entidad de arriba, y deja que EF Core trackee la entidad. Mantener el tipo de cable (record) separado del tipo de persistencia (class con init) elimina toda la categoría de bugs de la que trata este post.

Para más sobre records como formas de retorno, ver la [matriz de decisión al final del post sobre múltiples valores](/es/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/).

## Claves generadas por la base y propiedades init-only

Este es el lugar más común donde la gente se atasca. Si `Id` está declarado como `public int Id { get; }` sin setter, EF Core no lo mapeará, y las migraciones se quejarán de una clave faltante. Si es `public int Id { get; init; }`, está mapeado y es escribible durante la inicialización del objeto, que es exactamente cuando EF Core setea el valor que leyó de la base.

Para inserts, EF Core también necesita escribir el valor generado de vuelta a la entidad después de `SaveChanges`. Lo hace a través del setter de la propiedad, que para propiedades init-only sigue funcionando porque EF Core usa metadata de acceso a propiedad en vez de la sintaxis pública de C#. Confirmado a partir de EF Core 11; esto ha sido estable desde EF Core 5.

Lo que no funciona: `public int Id { get; } = GetNextId();` con un inicializador de campo y sin setter. EF Core no ve setter, no mapea la propiedad, y obtienes o un error de build por clave faltante o una shadow key no intencional.

## La expresión `with` es un disparo en el pie en entidades trackeadas

Cuando la entidad es un `record` (posicional o no) con una copia generada por el constructor primario, `with` produce un clon que compara igual al original pero es una referencia CLR distinta. EF Core lo trata como "misma clave, instancia distinta", lo que dispara la identity resolution. La regla segura:

```csharp
// .NET 11, EF Core 11
// BAD: creates a second instance with the same PK.
var edited = post with { Title = "New" };
db.Update(edited); // throws InvalidOperationException on SaveChanges

// GOOD: mutate the tracked instance.
post.Title = "New"; // via init (within EF) or a regular setter
await db.SaveChangesAsync();
```

Si genuinamente quieres semántica de "detach, clone, re-attach", primero pasa por `db.Entry(post).State = EntityState.Detached;`, luego attach el clon y marca propiedades como `IsModified`. La mayoría del tiempo no quieres eso. Quieres el Patrón A de la sección anterior.

Los tipos complejos no tienen este problema. Un `with` sobre una `Address` dentro de un `Customer` produce un nuevo valor, lo asignas de vuelta a `customer.ShippingAddress`, y EF Core compara campo por campo contra el snapshot. Ese es el punto entero de los tipos complejos.

## Igualdad por valor vs identidad en caminos calientes

Si insistes en una entidad de record posicional, recuerda que la igualdad por valor se filtra en cada colección respaldada por `GetHashCode`. Un `HashSet<BlogPost>` colapsará dos "entidades distintas con los mismos datos". Un diccionario indexado por la entidad se comportará impredeciblemente si dos PKs distintas resultan contener el mismo payload. El workaround estándar es sobrescribir `Equals` y `GetHashCode` en el record para indexar solo por la clave primaria, lo que anula la razón entera por la que elegiste un record en primer lugar.

El change tracker en sí, a partir de EF Core 11, sigue usando identidad por referencia internamente. Puedes revisar [la fuente de change-tracking](https://github.com/dotnet/efcore) para los detalles, pero la versión corta es: EF Core no "fusiona" accidentalmente dos entidades solo porque sean iguales por valor. Sin embargo, sí surfacea esa fusión a través de `DbSet.Find`, `FirstOrDefault` en una query trackeada, y el fixup de relaciones, que es por lo que los equipos siguen viendo comportamientos raros que no pueden explicar de inmediato.

De nuevo, el arreglo no es discutir con el runtime. Es mantener la igualdad por valor en tipos por valor (tipos complejos, DTOs) y dejar los tipos de entidad con la igualdad por referencia por defecto.

## Columnas JSON y records

EF Core 7 añadió mapeo de columnas JSON, y EF Core 11 lo extiende más con [traducción de JSON_CONTAINS en SQL Server 2025](/2026/04/efcore-11-json-contains-sql-server-2025/) y tipos complejos dentro de documentos JSON. Los records posicionales son un encaje ergonómico para tipos JSON owned:

```csharp
// .NET 11, C# 14, EF Core 11
public record TagSet(List<string> Tags, DateTime UpdatedAt);

public class Article
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public TagSet Metadata { get; set; } = new(new(), DateTime.UtcNow);
}

// OnModelCreating
modelBuilder.Entity<Article>()
    .OwnsOne(a => a.Metadata, b => b.ToJson());
```

El record es una propiedad compleja almacenada como JSON. Lo reemplazas entero vía `article.Metadata = article.Metadata with { Tags = [..article.Metadata.Tags, "net11"] };` y EF Core serializa todo el subárbol en `SaveChanges`. Sin tracking de identidad, sin debate `with` vs mutación.

## Juntándolo todo

Un dominio realista, de extremo a extremo:

```csharp
// .NET 11, C# 14, EF Core 11
// Complex types (records)
public record Address(string Street, string City, string PostalCode);
public readonly record struct Money(decimal Amount, string Currency);

// Entity (class with init-only properties + binding ctor)
public class Order
{
    public Order(int id, string customerName, Money total, Address shipTo)
    {
        Id = id;
        CustomerName = customerName;
        Total = total;
        ShipTo = shipTo;
    }

    private Order() { } // EF fallback

    public int Id { get; init; }
    public string CustomerName { get; init; } = "";
    public Money Total { get; init; }
    public Address ShipTo { get; init; } = new("", "", "");

    public List<OrderLine> Lines { get; init; } = new();
}

// Projection/DTO (positional record)
public record OrderSummary(int Id, string CustomerName, decimal Total);

// Input command (positional record, validated before mapping)
public record CreateOrder(string CustomerName, Money Total, Address ShipTo);
```

Esa es toda la regla general: clases para cosas con identidad, records para cosas que se definen por sus datos. El binding de constructor de EF Core 11, el mapeo de tipos complejos y el mapeo JSON soportan todos esta división sin configuración extra más allá de `ComplexProperty` u `OwnsOne(..ToJson())` donde aplique.

## Lecturas relacionadas

- [EF Core 11 añade GetEntriesForState para saltar DetectChanges](/2026/04/efcore-11-changetracker-getentriesforstate/) cubre los internals del change tracker en los que se apoya este post.
- [EF Core 11 poda joins de referencia innecesarios en split queries](/2026/04/efcore-11-preview-3-prunes-reference-joins-split-queries/) es un buen complemento si tus entidades dependen mucho de las navigations.
- [EF Core 11 traduce Contains a JSON_CONTAINS en SQL Server 2025](/2026/04/efcore-11-json-contains-sql-server-2025/) se enlaza con el patrón de record mapeado a JSON de arriba.
- [Cómo devolver múltiples valores desde un método en C# 14](/es/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/) profundiza en cuándo los records ganan sobre tuplas y clases a nivel de retorno de método.

## Fuentes

- [EF Core constructors y property binding](https://learn.microsoft.com/en-us/ef/core/modeling/constructors)
- [Visión general de change tracking de EF Core](https://learn.microsoft.com/en-us/ef/core/change-tracking/)
- [Identity resolution de EF Core](https://learn.microsoft.com/en-us/ef/core/change-tracking/identity-resolution)
- [Novedades en EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [Referencia de tipos record de C#](https://learn.microsoft.com/en-us/dotnet/csharp/fundamentals/types/records)
- [Soporte para actualizaciones de entidades inmutables (efcore#11457)](https://github.com/dotnet/efcore/issues/11457)
- [Documentar tipos record como entidades (EntityFramework.Docs#4438)](https://github.com/dotnet/EntityFramework.Docs/issues/4438)
