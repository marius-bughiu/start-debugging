---
title: "Fix: A possible object cycle was detected"
description: "System.Text.Json se niega a serializar grafos con referencias cíclicas. Configura ReferenceHandler.IgnoreCycles, proyecta a un DTO o marca el puntero hacia atrás con [JsonIgnore]. Preserve es un último recurso."
pubDate: 2026-05-14
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "json"
  - "ef-core"
lang: "es"
translationOf: "2026/05/fix-possible-object-cycle-was-detected-system-text-json"
translatedBy: "claude"
translationDate: 2026-05-14
---

La solución: `System.Text.Json` se niega a serializar cualquier grafo de objetos que vuelva sobre sí mismo. En una entidad de EF Core con una propiedad `Parent` y una colección `Children` que se referencian mutuamente, el escritor entra en bucle infinito, choca contra el guard de profundidad y lanza la excepción. Configura `JsonSerializerOptions.ReferenceHandler = ReferenceHandler.IgnoreCycles` como solución de una línea, marca el puntero hacia atrás con `[JsonIgnore]` para una solución permanente, o proyecta la entidad a un DTO que simplemente no tenga el puntero hacia atrás. `ReferenceHandler.Preserve` funciona pero cambia el formato del cable a `$id`/`$ref`, lo cual rara vez es lo que un consumidor de API quiere.

```text
System.Text.Json.JsonException: A possible object cycle was detected. This can either be due to a cycle or if the object depth is larger than the maximum allowed depth of 32. Consider using ReferenceHandler.Preserve on JsonSerializerOptions to support cycles. Path: $.Children.Parent.Children.Parent.Children.Parent...
   at System.Text.Json.ThrowHelper.ThrowJsonException_SerializerCycleDetected(Int32 maxDepth)
   at System.Text.Json.Serialization.JsonConverter`1.TryWrite(Utf8JsonWriter writer, T& value, JsonSerializerOptions options, WriteStack& state)
   at System.Text.Json.Serialization.Metadata.JsonTypeInfo`1.SerializeAsObject(Utf8JsonWriter writer, Object rootValue)
   at System.Text.Json.JsonSerializer.WriteString[TValue](TValue value, JsonTypeInfo jsonTypeInfo)
```

Esta guía está escrita contra .NET 11 preview 4 y `System.Text.Json` 11.0.0-preview.4. El mensaje de la excepción no ha cambiado desde que `System.Text.Json` añadió la detección de ciclos en .NET 5, y `ReferenceHandler.IgnoreCycles` está disponible desde .NET 6. El segmento `Path` en la excepción es la ruta JSON en la que el escritor estaba cuando se rindió. Si la ruta es un patrón repetido como `$.Children.Parent.Children.Parent`, tienes un ciclo real. Si la ruta es un descenso recto como `$.Order.Customer.Address.Country.Region.Continent...`, no tienes un ciclo, tienes un grafo que es genuinamente más profundo que 32 niveles y necesitas `MaxDepth`, que es una solución diferente.

## Por qué el escritor se niega a seguir el bucle

`System.Text.Json` serializa grafos como árboles. Un documento JSON es un árbol por definición, no hay sintaxis para "este nodo es el mismo que aquel nodo de allá". Así que el escritor recorre el grafo de objetos en profundidad y emite cada referencia como un nuevo objeto anidado. En el momento en que una propiedad apunta a un ancestro, el recorrido no termina.

Para evitar que el proceso siga ejecutándose hasta agotar la pila, el escritor lleva la cuenta de la profundidad actual y lanza una `JsonException` cuando supera `JsonSerializerOptions.MaxDepth`, que por defecto es 64. El mensaje de error por defecto mezcla dos casos (un ciclo real y un árbol honestamente profundo) porque el escritor no puede distinguirlos desde dentro, solo ve que está demasiado profundo. La pista `Consider using ReferenceHandler.Preserve` al final del mensaje es la mejor suposición del runtime. Es correcto que `Preserve` permitiría que la llamada tuviera éxito, pero rara vez es la solución correcta para una API. Proyectar a un DTO o romper el puntero hacia atrás sí lo es.

El valor por defecto en ASP.NET Core cambió en .NET 6 de manera que las `JsonOptions` del framework (usadas por las APIs mínimas y las acciones de controlador) no cambian a `IgnoreCycles` por ti. Optas explícitamente. El razonamiento era que descartar ciclos silenciosamente oculta bugs en el modelo de respuesta, la respuesta canónica es arreglar el modelo.

## Una repro mínima

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4, System.Text.Json 11.0.0-preview.4
public class Author
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public List<Book> Books { get; set; } = new();
}

public class Book
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int AuthorId { get; set; }
    public Author Author { get; set; } = null!;
}
```

```csharp
// .NET 11, C# 14
using System.Text.Json;

var author = new Author { Id = 1, Name = "Carla" };
var book = new Book { Id = 1, Title = "Refactoring", Author = author };
author.Books.Add(book);

var json = JsonSerializer.Serialize(author); // throws
```

`author.Books[0].Author` es la misma instancia que `author`. El escritor desciende a `Books`, desciende al primer `Book`, luego desciende a su `Author`, encuentra `Books` de nuevo y entra en bucle. El guard de 64 niveles de profundidad dispara antes de que el proceso muera.

La misma forma aparece en el momento en que haces `Include` de una propiedad de navegación en EF Core y devuelves la entidad rastreada desde un controlador sin proyectarla. EF Core arregla las propiedades de navegación de modo que el padre apunte a sus hijos y los hijos apunten al padre. Ese es el comportamiento correcto para el rastreo de cambios. Es la forma incorrecta para JSON.

## Solución, en detalle

### 1. Proyectar a un DTO

La respuesta canónica es nunca serializar entidades de EF Core directamente. Devuelve un DTO que aplane u omita el puntero hacia atrás:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4
public record AuthorDto(int Id, string Name, IReadOnlyList<BookDto> Books);
public record BookDto(int Id, string Title);

var dto = await db.Authors
    .Where(a => a.Id == 1)
    .Select(a => new AuthorDto(
        a.Id,
        a.Name,
        a.Books.Select(b => new BookDto(b.Id, b.Title)).ToList()))
    .FirstAsync();

var json = JsonSerializer.Serialize(dto); // works
```

Esta es la respuesta que el equipo de .NET recomienda y es la respuesta correcta para cualquier API pública. El DTO es lo que el consumidor realmente quiere, la entidad es un tipo interno que casualmente tiene los mismos nombres de campo. Proyectar en la consulta de EF Core también hace que el SQL sea más pequeño, la base de datos solo devuelve las columnas que el DTO necesita. Para más contexto sobre el lado de EF Core de este patrón, el post [calentar el modelo de EF Core antes de la primera consulta](/es/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/) cubre la mecánica de proyección con más profundidad.

### 2. Configurar ReferenceHandler.IgnoreCycles globalmente

Si debes serializar una entidad directamente (un endpoint interno rápido, una herramienta de admin, un dump de depuración), configura la opción una vez en el host:

```csharp
// .NET 11, C# 14, ASP.NET Core 11
var builder = WebApplication.CreateBuilder(args);
builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.ReferenceHandler =
        System.Text.Json.Serialization.ReferenceHandler.IgnoreCycles;
});
```

Para controladores (System.Text.Json):

```csharp
// .NET 11, C# 14, ASP.NET Core 11
builder.Services.AddControllers().AddJsonOptions(o =>
{
    o.JsonSerializerOptions.ReferenceHandler =
        System.Text.Json.Serialization.ReferenceHandler.IgnoreCycles;
});
```

`IgnoreCycles` escribe `null` cada vez que el escritor detecta que está a punto de revisitar una instancia que ya está en la rama actual. El ciclo se rompe, la llamada tiene éxito y el consumidor recibe un árbol. El costo es que `book.Author` se serializará como `null` aunque claramente estuviera poblado, lo cual puede ser confuso si el consumidor espera fidelidad de ida y vuelta.

`IgnoreCycles` se añadió en .NET 6 específicamente porque `Preserve` era un valor por defecto demasiado disruptivo y `[JsonIgnore]` solo resuelve el problema caso por caso. Recurre a él como la configuración global del serializador para rutas de respuesta de solo lectura y deja el modelo en paz.

### 3. Marcar el puntero hacia atrás con [JsonIgnore]

Si el puntero hacia atrás nunca es útil en JSON (el consumidor siempre conoce al padre porque acaba de pedirlo), márcalo directamente:

```csharp
// .NET 11, C# 14
using System.Text.Json.Serialization;

public class Book
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int AuthorId { get; set; }

    [JsonIgnore]
    public Author Author { get; set; } = null!;
}
```

`[JsonIgnore]` elimina la propiedad tanto del serializador como del deserializador para ese tipo. El ciclo desaparece en tiempo de compilación, no se necesita ninguna opción en runtime. Esta es la solución correcta para una propiedad de navegación que existe solo para el rastreo de cambios y que ningún consumidor de JSON necesita.

La contrapartida es que `Author` ahora es invisible para la capa JSON en todas partes. Si tienes un endpoint diferente que sí quiere devolver un `Book` con su `Author` anidado, `[JsonIgnore]` es demasiado contundente y deberías proyectar a un DTO en su lugar.

### 4. ReferenceHandler.Preserve, cuando realmente necesitas ida y vuelta

Si tu escenario es interno a interno (un sistema de actores, un protocolo servidor a servidor, un snapshot que vuelves a leer en otro proceso .NET), `Preserve` es la opción que mantiene el grafo intacto:

```csharp
// .NET 11, C# 14
var options = new JsonSerializerOptions
{
    ReferenceHandler =
        System.Text.Json.Serialization.ReferenceHandler.Preserve
};

var json = JsonSerializer.Serialize(author, options);
```

La salida obtiene propiedades `$id` y `$ref`:

```json
{
  "$id": "1",
  "Id": 1,
  "Name": "Carla",
  "Books": {
    "$id": "2",
    "$values": [
      {
        "$id": "3",
        "Id": 1,
        "Title": "Refactoring",
        "Author": { "$ref": "1" }
      }
    ]
  }
}
```

`Preserve` **nunca** es la respuesta correcta para una API REST pública. Los clientes JavaScript, los clientes móviles, Postman, todos los generadores de código, todos los validadores Swagger esperan JSON plano. `$id` y `$ref` son una convención propia de System.Text.Json (originalmente de Newtonsoft), no son estándar. Los navegadores no las desempaquetarán. Si no estás deserializando al otro lado con `System.Text.Json` configurado con la misma opción `Preserve`, no las emitas.

El uso legítimo es servidor a servidor donde ambos extremos son .NET, tú controlas el contrato y realmente necesitas que el grafo dé la vuelta sin duplicación.

### 5. Aumentar MaxDepth, pero solo para árboles honestamente profundos

Si has inspeccionado la ruta en la excepción y no es un patrón repetido sino un largo descenso recto, tu grafo es genuinamente más profundo que 64 niveles:

```csharp
// .NET 11
var options = new JsonSerializerOptions
{
    MaxDepth = 128
};
```

Esto es raro. La mayoría de los dominios no tienen árboles de 64 niveles de profundidad, y si el tuyo los tiene casi seguro quieres trocear o paginar la respuesta. Pero es la perilla correcta para cosas como estructuras de carpetas recursivas, jerarquías organizacionales o árboles de expresiones donde la profundidad es datos, no un bug.

**No** subas `MaxDepth` para "rodear" un ciclo. El guard de profundidad es lo único que se interpone entre tu proceso y un desbordamiento de pila.

## Formas comunes que producen esto

### Propiedades de navegación de EF Core en una entidad serializada

El caso de manual. `Order` tiene `Customer`, `Customer` tiene `List<Order> Orders`, y un `Include` puebla ambos lados. La solución es proyectar a un DTO o aplicar `[JsonIgnore]` al puntero hacia atrás. Devolver entidades desde un controlador es la fuente individual más común de esta excepción.

### Árboles auto-referenciantes

Una `Category` con un `Parent` y `List<Category> Children`, poblada por `Include` recursivos. El ciclo es `category.Children[0].Parent == category`. `IgnoreCycles` maneja esto limpiamente porque el escritor detecta el bucle en el puntero hacia atrás y emite `null` allí.

### Tipos anónimos construidos desde LINQ

Una proyección LINQ que se convierte en tipo anónimo dentro de un grafo suele ser segura (los tipos anónimos no tienen punteros hacia atrás). Pero una proyección como `Select(a => new { a, Books = a.Books })` reintroduce la entidad y el ciclo está de vuelta. Inspecciona lo que realmente escribiste, no lo que querías escribir.

### Un DTO que copió las propiedades de navegación de su fuente

Una configuración de mapeo que porta `Author Author` de la entidad al DTO derrota el propósito del DTO. O elimina la propiedad del DTO, o cambia su tipo a `AuthorDto` (un record en forma de hoja sin puntero hacia atrás).

### Un grafo más profundo que 32, con el viejo mensaje por defecto

Antes de .NET 8, el `MaxDepth` por defecto era 64 solo cuando no se establecía explícitamente; la ruta del generador de código fuente y algunos inicializadores legacy usaban 32. El mensaje de excepción tiene codificado "32" en algunas versiones más antiguas, y "64" o tu valor personalizado en las más nuevas. Lee la excepción real, no los documentos, la versión del runtime determina el número.

## Variantes que parecen esto pero no lo son

### "The object or value could not be serialized. There was a recursive call detected."

Error diferente, misma familia. Este es el mensaje que emite Newtonsoft.Json cuando su `ReferenceLoopHandling` se deja en el valor por defecto `Error`. La solución en Newtonsoft es `ReferenceLoopHandling.Ignore` (el análogo de `IgnoreCycles`) o `PreserveReferencesHandling.All` (el análogo de `Preserve`). Si estás a mitad de migración, el [recorrido de migración de Newtonsoft a System.Text.Json](/es/2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4/) es lo más parecido a un caso de estudio canónico; ambas bibliotecas llegan a la misma forma de solución pero deletrean las opciones de manera diferente.

### "JsonException: The JSON value could not be converted to ..."

Excepción diferente, pila diferente. Esa es sobre parsear una entrada que no coincide con el tipo objetivo. La excepción de ciclo es un problema del lado de escritura; la excepción de conversión es un problema del lado de lectura. La [guía de conversión de System.DateTime](/es/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) es el escrito canónico para la familia del lado de lectura.

### "Self referencing loop detected for property ..."

Este es el mensaje de Newtonsoft, palabra por palabra. Si lo ves en una base de código de 2026 que creías que usaba `System.Text.Json`, todavía hay un serializador Newtonsoft conectado en alguna parte, normalmente una llamada residual a `AddNewtonsoftJson()` en el builder MVC. Busca en el startup del host; el framework elige el formateador JSON que se registra último.

### "An item with the same key has already been added. Key: $id"

Este es el deserializador de `Preserve` fallando porque el mismo `$id` aparece dos veces en la entrada. O el payload está malformado (a dos objetos diferentes se les dio el mismo id) o fue serializado con `Preserve` y luego re-serializado a través de un transformador que reescribió los ids. La solución está en el productor, no en el consumidor.

### "PossibleCycleDetected" desde un render de Blazor

Capa completamente diferente. El motor de diffing de Blazor tiene su propio guard de ciclos para parámetros de componente; el tipo de excepción y la pila son diferentes. No cambies `JsonSerializerOptions` para arreglar un bucle de render de Blazor.

## Trabajar con el generador de código fuente

Cuando uses la generación de código fuente de `System.Text.Json`, se aplican las mismas opciones. Configura `ReferenceHandler` en las `JsonSerializerOptions` que pasas al contexto generado, o usa el atributo `[JsonSourceGenerationOptions]` en el tipo de contexto:

```csharp
// .NET 11, C# 14, System.Text.Json 11.0.0-preview.4
using System.Text.Json.Serialization;

[JsonSourceGenerationOptions(
    ReferenceHandler = JsonKnownReferenceHandler.IgnoreCycles)]
[JsonSerializable(typeof(Author))]
public partial class ApiJsonContext : JsonSerializerContext { }
```

`JsonKnownReferenceHandler` es el enum amigable con atributos, mapea a los mismos handlers que `ReferenceHandler.IgnoreCycles` / `Preserve` en runtime. El post sobre [interceptores y la ergonomía del generador de código fuente de System.Text.Json](/es/2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics/) recorre la forma del registro del contexto que sobrevive al trimming y a la publicación AOT, la misma forma se aplica aquí.

## Relacionados

Para la contraparte de lado de lectura de esta excepción, consulta el [fix de The JSON value could not be converted to System.DateTime](/es/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/). El andamiaje general para escribir tus propios conversores que evitan el manejo de referencias por defecto vive en el [recorrido de JsonConverter personalizado](/es/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/). Si la entidad que estás serializando viene de EF Core 11 y quieres la historia de ida y vuelta con la base de datos, el [recorrido de SQL Server 2025 JSON contains](/es/2026/04/efcore-11-json-contains-sql-server-2025/) cubre cómo el tipo de columna JSON maneja grafos en la capa de base de datos. Para el caso más amplio de migrar una base de código completa lejos del `ReferenceLoopHandling` de Newtonsoft, la nota sobre [vstest descartando Newtonsoft.Json en .NET 11 preview 4](/es/2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4/) tiene el manual del propio equipo de .NET.

## Fuentes

- [Preserve references and handle circular references in System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/preserve-references), Microsoft Learn.
- [`JsonSerializerOptions.ReferenceHandler`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializeroptions.referencehandler), Microsoft Learn.
- [`JsonSerializerOptions.MaxDepth`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializeroptions.maxdepth), Microsoft Learn.
- [`JsonIgnoreAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonignoreattribute), Microsoft Learn.
- [dotnet/runtime issue 30820: cycle detection in JSON serialization](https://github.com/dotnet/runtime/issues/30820), la discusión de diseño original que aterrizó `Preserve` y luego `IgnoreCycles`.
