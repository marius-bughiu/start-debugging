---
title: "Cómo personalizar la serialización de System.Text.Json generada por código fuente con un modificador de type info resolver"
description: "Adjunta un modificador de JsonTypeInfo a un JsonSerializerContext generado por código fuente en .NET 11: por qué new MyContext(options) lo descarta en silencio, la configuración con WithAddedModifier que sí funciona, la ruta rápida que pierdes (medida) y la trampa de la política de nombres que deja el modificador sin efecto."
pubDate: 2026-08-10
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "source-generators"
  - "serialization"
  - "how-to"
lang: "es"
translationOf: "2026/08/how-to-customize-source-generated-system-text-json-serialization-with-a-modifier"
translatedBy: "claude"
translationDate: 2026-08-10
---

Para personalizar un contrato de `System.Text.Json` generado por código fuente, pon tu modificador en las `JsonSerializerOptions`, nunca en el contexto: `new JsonSerializerOptions { TypeInfoResolver = MyContext.Default.WithAddedModifier(MyModifier) }`. La alternativa que parece obvia, `new MyContext(optionsWithModifier)`, compila, se ejecuta e ignora tu modificador en silencio, porque el constructor de `JsonSerializerContext` sobrescribe `TypeInfoResolver` con el propio contexto. Los modificadores funcionan bien con la generación de código fuente, incluso con la serialización basada en reflexión deshabilitada para Native AOT, pero te cuestan la ruta rápida generada. Todo lo que sigue fue verificado con .NET 10.0.5 y el SDK 10.0.201; las APIs no cambian desde .NET 8 hasta .NET 11.

## Por qué la personalización de contratos y la generación de código fuente parecen incompatibles

La personalización de contratos llegó en .NET 7. Le entregas a `System.Text.Json` un `Action<JsonTypeInfo>` y este te llama una vez por tipo, después de construir el contrato pero antes de usarlo, así que puedes renombrar propiedades, quitarlas, agregar propiedades sintéticas o envolver los delegados de lectura y escritura. El punto de entrada canónico es `DefaultJsonTypeInfoResolver.Modifiers`, y .NET 8 agregó [el método de extensión `WithAddedModifier`](/2023/10/system-text-json-how-to-modify-existing-type-info-resolver/) para que puedas superponer un modificador sobre cualquier `IJsonTypeInfoResolver`, no solo sobre el basado en reflexión.

Esa parte de "cualquier resolver" es lo importante, porque un `JsonSerializerContext` generado por código fuente **es** un `IJsonTypeInfoResolver`. No hay ninguna razón técnica por la que un modificador no pueda decorar `MyContext.Default`. La razón por la que tanta gente concluye que los modificadores de contrato no funcionan con la generación de código fuente es que el cableado que parece natural descarta el modificador sin advertencia, sin excepción y sin diagnóstico del compilador.

Este es el modelo que usaré en el resto del artículo. Un `Order` con un secreto encima, más un `Address` anidado que tiene el mismo problema:

```csharp
// .NET 11, C# 14
public class Order
{
    public int Id { get; set; }
    public string Customer { get; set; } = "";
    public string? ApiKey { get; set; }
    public Address? ShipTo { get; set; }
}

public class Address
{
    public string City { get; set; } = "";
    public string? ApiKey { get; set; }
}

[JsonSerializable(typeof(Order))]
public partial class OrderContext : JsonSerializerContext { }
```

Y el modificador, que censura todas las propiedades llamadas `ApiKey` en cualquier punto del grafo de objetos:

```csharp
// .NET 11, C# 14
static void RedactApiKey(JsonTypeInfo typeInfo)
{
    if (typeInfo.Kind != JsonTypeInfoKind.Object)
        return;

    foreach (JsonPropertyInfo property in typeInfo.Properties)
    {
        if (property.Name != "ApiKey")
            continue;

        Func<object, object?>? get = property.Get;
        if (get is not null)
            property.Get = obj => get(obj) is null ? null : "***";
    }
}
```

## El cableado que funciona y el que no hace nada en silencio

Tres pasos, y el orden importa:

1. Construye primero el resolver llamando a `WithAddedModifier` sobre la propiedad `Default` de tu contexto generado. Esto devuelve un `JsonTypeInfoResolverWithAddedModifiers` que delega en el contexto y luego ejecuta tu callback.
2. Asigna ese resolver a un `JsonSerializerOptions.TypeInfoResolver` y guarda la instancia de opciones en un campo `static readonly`. Nunca construyas el `JsonSerializerContext` tú mismo.
3. Pasa esa instancia de opciones a `JsonSerializer.Serialize` o `JsonSerializer.Deserialize`. No pases el contexto, y no pases un `JsonTypeInfo` que hayas sacado de `MyContext.Default`.

```csharp
// .NET 11, C# 14 - works
static readonly JsonSerializerOptions RedactingOptions = new()
{
    TypeInfoResolver = OrderContext.Default.WithAddedModifier(RedactApiKey)
};

var order = new Order
{
    Id = 7,
    Customer = "acme",
    ApiKey = "sk-live-123",
    ShipTo = new Address { City = "Cluj", ApiKey = "sk-nested-999" }
};

Console.WriteLine(JsonSerializer.Serialize(order, typeof(Order), RedactingOptions));
// {"Id":7,"Customer":"acme","ApiKey":"***","ShipTo":{"City":"Cluj","ApiKey":"***"}}
```

Fíjate en que el `Address` anidado también queda censurado, aunque nunca aparezca en un atributo `[JsonSerializable]`. El generador recorre el grafo de objetos desde cada raíz declarada, así que `OrderContext.Default.GetTypeInfo(typeof(Address))` devuelve un contrato y el modificador se ejecuta para él como para cualquier otro tipo.

Ahora la versión que parece igual de razonable y no hace nada:

```csharp
// .NET 11, C# 14 - modifier is silently discarded
var context = new OrderContext(new JsonSerializerOptions
{
    TypeInfoResolver = OrderContext.Default.WithAddedModifier(RedactApiKey)
});

Console.WriteLine(JsonSerializer.Serialize(order, typeof(Order), context));
// {"Id":7,"Customer":"acme","ApiKey":"sk-live-123","ShipTo":{...,"ApiKey":"sk-nested-999"}}

Console.WriteLine(context.Options.TypeInfoResolver?.GetType().Name);
// OrderContext
```

El constructor `JsonSerializerContext(JsonSerializerOptions)` copia tus opciones y luego se asigna a sí mismo a `TypeInfoResolver`, así que el resolver decorado que armaste con cuidado desaparece antes de la primera serialización. La recomendación de los mantenedores de `System.Text.Json` en [la discusión 121304 de dotnet/runtime](https://github.com/dotnet/runtime/discussions/121304) es exactamente esa: evita las instancias de `JsonSerializerContext` y pasa las opciones directamente a `JsonSerializer`.

Dos formas más de perder el modificador, ambas fáciles de escribir por accidente:

```csharp
// .NET 11, C# 14 - both bypass the modifier
JsonSerializer.Serialize(order, OrderContext.Default.Order);
JsonSerializer.Serialize(order, typeof(Order), OrderContext.Default);
```

`OrderContext.Default` es el contrato sin modificar. Eso es una característica, no un error: los modificadores nunca mutan la instancia `Default` compartida, así que un resolver que censura datos en una parte de tu aplicación no puede filtrarse a otra. Si quieres la sobrecarga con `JsonTypeInfo` para la ruta caliente, saca el type info de las opciones modificadas:

```csharp
// .NET 11, C# 14
var typeInfo = (JsonTypeInfo<Order>)RedactingOptions.GetTypeInfo(typeof(Order));
JsonSerializer.Serialize(order, typeInfo);   // redacted
```

## Comparar contra Name es la trampa que muerde en ASP.NET Core

`JsonPropertyInfo.Name` es el nombre **JSON**, después de aplicar `PropertyNamingPolicy`. En una aplicación de consola con opciones por defecto la política de nombres es null, así que `property.Name` coincide por casualidad con el nombre de la propiedad de CLR y la comparación `== "ApiKey"` funciona. Conecta el mismo modificador a ASP.NET Core, donde la política por defecto es camelCase, y la comparación no encuentra nada:

```csharp
// .NET 11, ASP.NET Core 11
builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.TypeInfoResolver = AppJsonContext.Default.WithAddedModifier(RedactApiKey);
});
```

Con `property.Name != "ApiKey"` el endpoint devuelve tan tranquilo `{"id":7,"customer":"acme","apiKey":"sk-live-1"}`. El modificador se ejecutó; simplemente nunca coincidió, porque el contrato ya reportaba la propiedad como `apiKey`.

Compara contra el miembro de CLR en su lugar. `JsonPropertyInfo.AttributeProvider` es un `PropertyInfo` incluso en contratos generados por código fuente, así que tanto el nombre del miembro como cualquier atributo personalizado están disponibles:

```csharp
// .NET 11, C# 14
[AttributeUsage(AttributeTargets.Property)]
public sealed class RedactAttribute : Attribute { }

static void RedactByAttribute(JsonTypeInfo typeInfo)
{
    if (typeInfo.Kind != JsonTypeInfoKind.Object)
        return;

    foreach (JsonPropertyInfo property in typeInfo.Properties)
    {
        object[]? attributes = property.AttributeProvider
            ?.GetCustomAttributes(typeof(RedactAttribute), inherit: true);

        if (attributes is not { Length: > 0 })
            continue;

        Func<object, object?>? get = property.Get;
        if (get is not null)
            property.Get = obj => get(obj) is null ? null : "***";
    }
}
```

Esa versión sobrevive a cualquier política de nombres y, en mi prueba, produjo `{"id":7,"customer":"acme","apiKey":"***"}` desde el mismo endpoint de minimal API.

## Qué puedes cambiar realmente en un contrato generado por código fuente

Todo lo que [la documentación de contratos personalizados](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/custom-contracts) describe para el resolver de reflexión también funciona sobre uno generado. Verifiqué cada uno de estos casos contra `OrderContext.Default`:

- **Quitar una propiedad.** `typeInfo.Properties.RemoveAt(i)` la elimina tanto de la serialización como de la deserialización. La salida pasa a ser `{"Id":7,"Customer":"acme","ShipTo":{"City":"Cluj"}}`.
- **Agregar una propiedad sintética.** `typeInfo.CreateJsonPropertyInfo(typeof(string), "kind")` más un delegado `Get`, y luego `typeInfo.Properties.Add(...)`, añade `"kind":"order"` al payload. No hace falta que exista ningún miembro de CLR.
- **Envolver el setter.** Reasignar `property.Set` se ejecuta en la deserialización. Pasar `Customer` a mayúsculas mediante un setter envuelto convirtió `{"Customer":"acme"}` en `Customer == "ACME"`.
- **Escrituras condicionales.** `property.ShouldSerialize = (_, value) => !string.IsNullOrEmpty((string?)value)` suprimió el string vacío de `Customer` sin tocar el resto del contrato.
- **Manejo de números por tipo.** `typeInfo.NumberHandling` es la única perilla que aplica a contratos `JsonTypeInfoKind.None` como `int`.

Los modificadores se componen en el orden en que los agregas. Al encadenar dos llamadas a `WithAddedModifier`, la primera pasando todos los nombres a minúsculas y la segunda insertando una propiedad `"v"` en el índice 0, obtuve `{"v":"2","id":7,"customer":"acme",...}`: la pasada de minúsculas corrió primero, así que la propiedad insertada después conservó su capitalización.

## Native AOT: los modificadores no son lo que se rompe

La razón entera para usar [un generador de código fuente](/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) aquí es el trimming y Native AOT, así que la preocupación obvia es si adjuntar un modificador vuelve a arrastrar la reflexión. No lo hace. Repetí el mismo código con `<JsonSerializerIsReflectionEnabledByDefault>false</JsonSerializerIsReflectionEnabledByDefault>`, que es lo que `PublishAot` y `PublishTrimmed` configuran por ti:

```text
IsReflectionEnabledByDefault = False
attribute-driven modifier over source-gen: {"Id":7,"Customer":"acme","ApiKey":"***","ShipTo":{"City":"Cluj","ApiKey":"***"}}
synthetic property with reflection off:    {"Id":7,...,"kind":"order"}
```

Tanto la búsqueda de atributos vía `AttributeProvider` como la propiedad creada en tiempo de ejecución funcionaron. Lo que sí sigue rompiéndose en esa configuración es la regla habitual de la generación de código fuente: cualquier tipo raíz ausente del contexto lanza una excepción, y el modificador no tiene nada que ver:

```text
NotSupportedException: JsonTypeInfo metadata for type '<>f__AnonymousType0`1[System.Int32]'
was not provided by TypeInfoResolver of type
'System.Text.Json.Serialization.Metadata.JsonTypeInfoResolverWithAddedModifiers'.
```

Si te encuentras con el error hermano sobre [la serialización basada en reflexión deshabilitada](/2026/07/fix-reflection-based-serialization-has-been-disabled-for-this-application/), eso es un resolver ausente, no un modificador roto.

## El costo real: renuncias a la ruta rápida generada

La generación de código fuente tiene dos modos. El modo de metadatos mueve la construcción del contrato al tiempo de compilación. El modo de optimización de serialización además emite un escritor hecho a mano que llama directamente a `Utf8JsonWriter`. Según [la documentación de modos de generación de código fuente](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation-modes), el serializador abandona esa ruta rápida cada vez que las opciones piden algo que el escritor generado no puede expresar, y un contrato modificado es exactamente eso.

Medido con BenchmarkDotNet 0.15.8 sobre .NET 10.0.5 (Intel Core Ultra 7 265KF, 20 núcleos), serializando el `Order` de cuatro propiedades de arriba:

| Método | Media | Ratio | Asignado | Ratio de asignación |
| --- | ---: | ---: | ---: | ---: |
| Source-gen, sin modificador | 88.76 ns | 1.00 | 200 B | 1.00 |
| Source-gen + modificador | 136.83 ns | 1.54 | 496 B | 2.48 |
| Resolver de reflexión, sin modificador | 136.23 ns | 1.53 | 512 B | 2.56 |
| Resolver de reflexión + modificador | 138.97 ns | 1.57 | 496 B | 2.48 |

Agregar un modificador cuesta cerca de un 54% de throughput y 2.5 veces más asignaciones con este payload, dejando la generación de código fuente exactamente donde ya estaba el resolver de reflexión. Conservas los beneficios de tiempo de arranque y de trimming de la generación de código fuente, porque la construcción del contrato sigue ocurriendo en tiempo de compilación; solo pierdes el escritor optimizado. Para la mayoría de las APIs es un intercambio razonable, pero conviene saberlo antes de adjuntar un modificador a una ruta de serialización caliente y preguntarte por qué los números no se movieron.

## GenerationMode = Serialization deja tu modificador sin efecto y en silencio

Este es el modo de fallo que más se parece a "los modificadores no funcionan con la generación de código fuente". Si fijas un contexto a generación solo de ruta rápida, no hay metadatos de propiedades que el modificador pueda recorrer:

```csharp
// .NET 11, C# 14 - do not do this if you want a modifier
[JsonSourceGenerationOptions(GenerationMode = JsonSourceGenerationMode.Serialization)]
[JsonSerializable(typeof(Order))]
public partial class FastPathOnlyContext : JsonSerializerContext { }
```

Imprimí la forma del contrato para los tres modos de generación:

```text
Default mode         Kind=Object Properties=4
Serialization only   Kind=Object Properties=0
Metadata only        Kind=Object Properties=4
```

Con `Properties=0` el modificador se invoca una vez, no itera nada y retorna. La serialización tiene éxito con el payload original, sin censurar. La deserialización no, y el mensaje al menos es explícito:

```text
InvalidOperationException: TypeInfoResolver
'System.Text.Json.Serialization.Metadata.JsonTypeInfoResolverWithAddedModifiers'
did not provide property metadata for type 'Order'.
```

El modo de generación por defecto emite tanto los metadatos como la ruta rápida, que es lo que quieres: la ruta rápida se usa cuando no hay ningún modificador adjunto, y la ruta de metadatos toma el relevo cuando lo hay.

## Guarda las opciones en caché y deja de mutarlas tras el primer uso

Los contratos se almacenan en caché por instancia de `JsonSerializerOptions`, no globalmente. Serializar tres veces con un mismo objeto de opciones en caché invocó mi modificador 4 veces en total, una por tipo del grafo. Construir unas `JsonSerializerOptions` nuevas dentro del bucle lo invocó 12 veces y reconstruyó todos los contratos:

```text
modifierCalls after 3 serializations (cached options)  = 4
modifierCalls after 3 serializations (fresh options)   = 12
```

Una vez que se ha usado una instancia de opciones, tanto ella como los contratos que produjo quedan congelados. Asignar `WriteIndented` después de la primera serialización lanza `InvalidOperationException: This JsonSerializerOptions instance is read-only or has already been used in serialization or deserialization`, y entrar a `options.GetTypeInfo(...)` para editar `Properties` después del hecho lanza el equivalente de `JsonTypeInfo`. Todos los cambios de contrato tienen que ocurrir dentro del modificador.

Si necesitas superponer varios resolvers en vez de un solo contexto decorado, [`TypeInfoResolverChain`](/2023/10/add-remove-typeinforesolver-to-existing-jsonserializeroptions/) acepta el resolver decorado igual de bien que el simple, y la cadena se consulta en orden hasta que un contrato vuelve distinto de null. El mismo patrón cubre una jerarquía que ya usa [`JsonDerivedType` para polimorfismo](/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/), porque los contratos derivados pasan por el modificador como cualquier otro tipo.

La versión corta para tener presente: decora el resolver, nunca el contexto, compara contra `AttributeProvider` en vez de `Name`, mantén el modo de generación por defecto y guarda las opciones en caché.

## Fuentes

- [Contratos personalizados de serialización y deserialización](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/custom-contracts) en MS Learn
- [Modos de generación de código fuente en System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation-modes) en MS Learn
- [Discusión 121304 de dotnet/runtime: modificadores de contrato JSON y generación de código fuente](https://github.com/dotnet/runtime/discussions/121304)
- [Referencia de la API `JsonTypeInfoResolver.WithAddedModifier`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.metadata.jsontypeinforesolver.withaddedmodifier), disponible desde .NET 8 hasta .NET 11
