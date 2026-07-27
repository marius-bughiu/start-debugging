---
title: "Cómo serializar una jerarquía de tipos polimórfica con JsonDerivedType en System.Text.Json"
description: "Guía completa de JSON polimórfico en .NET 11: JsonDerivedType y JsonPolymorphic, por qué el tipo declarado lo decide todo, la regla de orden de $type, todas las excepciones que lanza la característica, el modelo de contratos para tipos que no son tuyos y lo que ASP.NET Core emite en OpenAPI."
pubDate: 2026-07-27
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "serialization"
lang: "es"
translationOf: "2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json"
translatedBy: "claude"
translationDate: 2026-07-27
---

Para hacer round-trip de una jerarquía de clases con `System.Text.Json`, pon `[JsonDerivedType(typeof(Derived), "discriminator")]` en el tipo base por cada subtipo que quieras admitir, y luego serializa y deserializa a través del tipo **base**. El serializador escribe una propiedad `$type` como primer miembro del objeto y la vuelve a leer para elegir el subtipo correcto. Sin una cadena discriminadora, la serialización sigue emitiendo las propiedades derivadas, pero la deserialización siempre materializa el tipo base. Esto funciona igual desde .NET 7 y todo lo que sigue apunta a .NET 11 (`net11.0`, C# 14), con las dos incorporaciones posteriores señaladas donde importan: `AllowOutOfOrderMetadataProperties` (.NET 9) y `JsonSerializerOptions.Strict` (.NET 10).

## Por qué la versión ingenua pierde datos en silencio

La razón por la que la gente busca esta característica es que el código obvio hace lo incorrecto sin avisar. Toma una jerarquía de pagos:

```csharp
// .NET 11, C# 14
public abstract class PaymentMethod
{
    public decimal Amount { get; set; }
}

public class CardPayment : PaymentMethod
{
    public string Last4 { get; set; } = "";
}
```

Serializa un `CardPayment` a través de una variable declarada como `PaymentMethod` sin ningún atributo y obtienes `{"Amount":10}`. La propiedad `Last4` desaparece. `System.Text.Json` resuelve el contrato a partir del tipo **declarado**, no del tipo en runtime, así que solo conoce los miembros de `PaymentMethod`. Esto es deliberado: evita que un tipo derivado filtre propiedades que quien llama nunca aceptó exponer, lo que es una consideración de seguridad real en respuestas de API.

Agregar un solo atributo cambia el contrato:

```csharp
// .NET 11, C# 14
[JsonDerivedType(typeof(CardPayment))]
public abstract class PaymentMethod
{
    public decimal Amount { get; set; }
}
```

Ahora `JsonSerializer.Serialize<PaymentMethod>(card)` produce `{"Last4":"4242","Amount":10}`. La serialización queda arreglada, la deserialización no. Leer esa carga útil de vuelta como `PaymentMethod` lanza `NotSupportedException: Deserialization of interface or abstract types is not supported. Type 'PaymentMethod'.`, porque nada en el JSON dice qué subtipo construir. Si el tipo base es concreto en lugar de abstracto, el fallo es más silencioso y peor: obtienes una instancia de `PaymentMethod` y `Last4` se pierde por el camino. El discriminador es lo que cierra el círculo.

## Cinco pasos para una jerarquía con round-trip

1. **Haz que el tipo base admita polimorfismo.** Debe ser una clase no sellada, una clase abstracta o una interfaz. Los struct, los tipos sellados, los tipos genéricos y `System.Object` se rechazan con `InvalidOperationException: Specified type 'X' does not support polymorphism. Polymorphic types cannot be structs, sealed types, generic types or System.Object.`

2. **Declara cada subtipo con un discriminador.** El segundo argumento de `[JsonDerivedType]` es el valor discriminador, y es lo que hace que la deserialización funcione.

```csharp
// .NET 11, C# 14
using System.Text.Json.Serialization;

[JsonDerivedType(typeof(CardPayment), "card")]
[JsonDerivedType(typeof(PaypalPayment), "paypal")]
public abstract class PaymentMethod
{
    public decimal Amount { get; set; }
}

public class CardPayment : PaymentMethod
{
    public string Last4 { get; set; } = "";
}

public class PaypalPayment : PaymentMethod
{
    public string Email { get; set; } = "";
}
```

3. **Serializa a través del tipo base.** El tipo declarado en el punto de llamada tiene que ser la base polimórfica, ya sea como argumento genérico, como tipo de la propiedad o como tipo del elemento de la colección.

```csharp
// .NET 11, C# 14
PaymentMethod payment = new CardPayment { Amount = 10, Last4 = "4242" };

string json = JsonSerializer.Serialize(payment);
// {"$type":"card","Last4":"4242","Amount":10}
```

Fíjate en el orden. `$type` siempre se escribe primero, antes que las propiedades propias del tipo derivado, y las propiedades del tipo base van al final. Eso no es cosmético, como explica la siguiente sección.

4. **Deserializa a través del tipo base.** El lector mira `$type`, encuentra `CardPayment` y lo construye:

```csharp
// .NET 11, C# 14
PaymentMethod? back = JsonSerializer.Deserialize<PaymentMethod>(json);
Console.WriteLine(back is CardPayment); // True
```

5. **Renombra el discriminador si `$type` choca con tu formato de transporte.** `[JsonPolymorphic(TypeDiscriminatorPropertyName = "kind")]` en el tipo base cambia el nombre de la propiedad. Dos cosas que debes saber: `$id`, `$ref` y `$values` están reservados y se rechazan, y el nombre personalizado **no** pasa por la política de nombres. Con `JsonSerializerOptions.Web`, un discriminador declarado como `"Kind"` se queda como `"Kind"` mientras el resto de propiedades van en camelCase. Elige exactamente la capitalización que quieres en el transporte.

Los valores discriminadores también pueden ser enteros: `[JsonDerivedType(typeof(ClickEvent), 1)]` emite `{"$type":1,...}`. Mezclar ids `string` e `int` en una misma jerarquía compila y funciona, pero hace la carga útil más difícil de consumir desde clientes que no son .NET. Elige una sola forma.

## El tipo declarado decide, en todas partes

La mayoría de los reportes de "falta el discriminador" se reducen a un punto de llamada donde el tipo declarado es la clase derivada. La regla es mecánica, y vale la pena interiorizarla como tabla. Todo esto se ejecutó contra la misma jerarquía de arriba:

| Punto de llamada | Salida |
| --- | --- |
| `Serialize<PaymentMethod>(card)` | `{"$type":"card","Last4":"4242","Amount":10}` |
| `Serialize<CardPayment>(card)` | `{"Last4":"4242","Amount":10}` |
| `Serialize(card)` donde `card` es de tipo `CardPayment` | `{"Last4":"4242","Amount":10}` |
| `Serialize<object>(card)` | `{"$type":"card","Last4":"4242","Amount":10}` |
| Elemento de `List<PaymentMethod>` | `[{"$type":"card",...}]` |
| Propiedad declarada como `PaymentMethod` | `{"Method":{"$type":"card",...}}` |
| Propiedad declarada como `CardPayment` | `{"Concrete":{"Last4":"9","Amount":3}}` |

La fila de `object` sorprende. `System.Object` no puede ser una base polimórfica, pero cuando el tipo declarado es `object` el serializador resuelve el tipo en runtime y luego aplica la configuración polimórfica del ancestro configurado más cercano de ese tipo. Así que `Serialize<object>(card)` sí emite el discriminador, y `Serialize<object>(someUndeclaredSubtype)` lanza exactamente igual que la llamada tipada con la base. Deserializar hacia `object` no es simétrico: recibes un `JsonElement`, no un `CardPayment`.

En ASP.NET Core el tipo declarado es el tipo de retorno del endpoint, lo que significa que la misma tabla aplica a las minimal API:

```csharp
// .NET 11, C# 14
app.MapGet("/payments/latest", () => (PaymentMethod)card);      // {"$type":"card","last4":"4242","amount":10}
app.MapGet("/payments/card",   () => card);                     // {"last4":"4242","amount":10}
app.MapGet("/typed",  () => TypedResults.Ok((PaymentMethod)card)); // discriminator present
app.MapGet("/typed2", () => TypedResults.Ok(card));             // discriminator absent
```

`TypedResults.Ok(card)` infiere `Ok<CardPayment>`, y ese argumento genérico es el tipo declarado hasta llegar a `WriteAsJsonAsync`. Si un endpoint tiene que devolver una jerarquía, tipa el valor de retorno de la lambda como la base, o usa una unión explícita `Results<T1, T2>` para que la forma sea visible tanto para el serializador como para el generador de OpenAPI. Devolver el tipo base es también lo que recomienda la [guía de uniones con typed results](/es/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/) para cualquier cosa sobre la que un cliente tenga que ramificar.

## La propiedad `$type` tiene que ir primero

Por defecto el discriminador tiene que estar al inicio del objeto JSON, agrupado con las demás propiedades de metadatos `$id` y `$ref`. Esta carga útil se deserializa:

```json
{"$type":"card","Amount":10,"Last4":"4242"}
```

Esta otra lanza `NotSupportedException: The JSON payload for polymorphic interface or abstract type 'PaymentMethod' must specify a type discriminator.`:

```json
{"Amount":10,"$type":"card","Last4":"4242"}
```

La razón es el streaming. Leer en una sola pasada hacia adelante implica que el lector debe conocer el tipo destino antes de empezar a enlazar miembros. El mensaje de la excepción confunde si lo lees por encima, porque el discriminador *sí* está en la carga útil, solo que demasiado tarde.

Desde .NET 9 hay una opción para activarlo:

```csharp
// .NET 11, C# 14, requires .NET 9 or later
var options = new JsonSerializerOptions { AllowOutOfOrderMetadataProperties = true };
var back = JsonSerializer.Deserialize<PaymentMethod>(json, options); // works
```

El costo es real, así que no lo actives globalmente sin pensarlo. Con la bandera activa, el deserializador ya no puede procesar las propiedades en una sola pasada, así que almacena en búfer el objeto JSON completo en memoria antes de enlazar. En un evento de 200 bytes eso es gratis. En un documento de varios megabytes transmitido desde blob storage es un riesgo de quedarse sin memoria. Si la carga útil viene de un sistema que controlas, arregla el escritor. La fuente habitual de discriminadores fuera de orden es un viaje a la base de datos: las columnas `jsonb` de PostgreSQL normalizan el orden de las claves, así que un documento escrito correctamente puede volver con `$type` en el medio.

## Todas las excepciones que lanza esta característica

Estos son los mensajes exactos del runtime, lo que los hace buscables y acelera el triage.

| Mensaje | Causa | Solución |
| --- | --- | --- |
| `Specified type 'X' does not support polymorphism. Polymorphic types cannot be structs, sealed types, generic types or System.Object.` | `[JsonDerivedType]` sobre un struct, una clase sellada o un genérico abierto | Quita el sellado de la base, o introduce una base o interfaz no genérica |
| `Runtime type 'X' is not supported by polymorphic type 'Y'.` | Serializar un subtipo que nunca se declaró | Agrega `[JsonDerivedType(typeof(X), "...")]`, o configura `UnknownDerivedTypeHandling` |
| `The JSON payload for polymorphic interface or abstract type 'X' must specify a type discriminator.` | Falta el discriminador, o no es la primera propiedad | Emite `$type` primero, o activa `AllowOutOfOrderMetadataProperties` |
| `Read unrecognized type discriminator id 'x'.` | La carga útil nombra un subtipo que no declaraste | Decláralo, o activa `IgnoreUnrecognizedTypeDiscriminators = true` |
| `The polymorphic type 'X' has already specified a type discriminator 'y'.` | Dos atributos `[JsonDerivedType]` comparten un id | Haz que los ids discriminadores sean únicos por jerarquía |
| `The type 'X' contains property '$type' that conflicts with an existing metadata property name.` | Una propiedad real se serializa bajo el nombre del discriminador | Renombra la propiedad, ponle `[JsonIgnore]`, o renombra el discriminador |
| `Runtime type 'X' has a diamond ambiguity between derived types 'A' and 'B'.` | `FallBackToNearestAncestor` con dos ancestros igual de cercanos | Declara `X` explícitamente para que no haga falta el fallback |
| `Deserialization of interface or abstract types is not supported. Type 'X'.` | Base abstracta sin ningún discriminador declarado | Dale a cada `[JsonDerivedType]` un id discriminador |

El caso del discriminador no reconocido lanza `JsonException`; el resto lanza `NotSupportedException` o `InvalidOperationException`. Esa distinción importa si capturas fallos de serialización para devolver un 400: `JsonException` es el cubo de "entrada inválida", mientras que `NotSupportedException` aquí casi siempre significa un error de configuración de tu lado.

## Manejar subtipos que no declaraste

Por defecto un subtipo no declarado es un error duro al escribir, que es el comportamiento correcto: degradar en silencio al contrato base es como desaparecen propiedades de las cargas útiles en producción. Cuando sí quieres un modo de fallo más suave, `[JsonPolymorphic]` expone el interruptor:

```csharp
// .NET 11, C# 14
[JsonPolymorphic(
    UnknownDerivedTypeHandling = JsonUnknownDerivedTypeHandling.FallBackToBaseType,
    IgnoreUnrecognizedTypeDiscriminators = true)]
[JsonDerivedType(typeof(LeafNode), "leaf")]
public class Node
{
    public string Label { get; set; } = "";
}

public class DeepNode : Node { public int Depth { get; set; } }
```

Con esa configuración, serializar un `DeepNode` como `Node` escribe `{"Label":"x"}` en vez de lanzar, y leer `{"$type":"unknown","Label":"x"}` produce un `Node` normal. Ambos ajustes solo tienen sentido cuando el tipo base es concreto y construible. `IgnoreUnrecognizedTypeDiscriminators` sobre una base abstracta solo mueve el fallo un paso más adelante, porque sigue sin haber nada que instanciar.

La tercera opción, `JsonUnknownDerivedTypeHandling.FallBackToNearestAncestor`, sube hasta el ancestro declarado más cercano. Es útil para jerarquías de interfaces donde otros equipos agregan implementaciones, y es el único ajuste que puede producir el error de ambigüedad en diamante: si un tipo implementa dos interfaces que son ambas tipos derivados declarados de la raíz, el serializador se niega a adivinar.

## La configuración no se hereda hacia abajo en la jerarquía

Esta le cuesta una tarde a mucha gente. La configuración polimórfica de un tipo base no se propaga a través de los tipos intermedios:

```csharp
// .NET 11, C# 14
[JsonDerivedType(typeof(Middle), "middle")]
public abstract class Root { }

[JsonDerivedType(typeof(Leaf), "leaf")]
public class Middle : Root { }

public class Leaf : Middle { }

JsonSerializer.Serialize<Root>(new Leaf());
// NotSupportedException: Runtime type 'Leaf' is not supported by polymorphic type 'Root'.
```

`Middle` conoce a `Leaf`, pero `Root` no, y el serializador no compone ambas configuraciones. Cada base polimórfica tiene que enumerar todos los tipos concretos que pueden aparecer debajo, incluidos los nietos. Declarar `Leaf` tanto en `Root` como en `Middle` funciona, y cada nivel puede usar su propio id discriminador, ya que el id se resuelve contra el tipo base que declaró el punto de llamada.

## Cuando no puedes anotar el tipo base

Los atributos quedan fuera de alcance para tipos de un paquete NuGet, de un cliente generado o de un ensamblado de contratos compartido que no tienes permitido tocar. El modelo de contratos resuelve esto: crea una subclase de `DefaultJsonTypeInfoResolver` y adjunta `PolymorphismOptions` al `JsonTypeInfo` del tipo base.

```csharp
// .NET 11, C# 14
using System.Text.Json.Serialization.Metadata;

public class PaymentResolver : DefaultJsonTypeInfoResolver
{
    public override JsonTypeInfo GetTypeInfo(Type type, JsonSerializerOptions options)
    {
        JsonTypeInfo info = base.GetTypeInfo(type, options);

        if (info.Type == typeof(PaymentMethod))
        {
            info.PolymorphismOptions = new JsonPolymorphismOptions
            {
                TypeDiscriminatorPropertyName = "kind",
                IgnoreUnrecognizedTypeDiscriminators = true,
                UnknownDerivedTypeHandling = JsonUnknownDerivedTypeHandling.FailSerialization,
                DerivedTypes =
                {
                    new JsonDerivedType(typeof(CardPayment), "card"),
                    new JsonDerivedType(typeof(PaypalPayment), "paypal")
                }
            };
        }

        return info;
    }
}

var options = new JsonSerializerOptions { TypeInfoResolver = new PaymentResolver() };
```

El resolver se ejecuta una vez por tipo y el resultado queda en caché en la instancia de opciones, así que el costo de reflexión se paga al inicio, no en cada llamada. Esta es también la salida de emergencia cuando el discriminador tiene que variar por endpoint o por tenant: construye dos instancias de opciones con dos resolvers en lugar de intentar mutar una. Las opciones pasan a ser de solo lectura tras la primera llamada de serialización, la misma restricción descrita en la [guía de JsonConverter personalizado](/es/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/).

## Generación de código fuente y Native AOT

El polimorfismo funciona con el generador de código fuente, pero solo en modo metadata. La vía rápida (`JsonSourceGenerationMode.Serialization`) emite llamadas fijas a `Utf8JsonWriter` para una forma conocida y no tiene dónde ramificar según el tipo en runtime, así que falla con `InvalidOperationException: TypeInfoResolver 'MyContext' did not provide property metadata for type 'CardPayment'.`

```csharp
// .NET 11, C# 14
[JsonSerializable(typeof(PaymentMethod))]
[JsonSourceGenerationOptions(GenerationMode = JsonSourceGenerationMode.Metadata)]
public partial class PaymentContext : JsonSerializerContext { }

string json = JsonSerializer.Serialize(payment, PaymentContext.Default.PaymentMethod);
// {"$type":"card","Last4":"4242","Amount":10}
```

Registrar el tipo base es suficiente; el generador sigue `[JsonDerivedType]` y emite metadatos para cada subtipo declarado. Eso es lo que hace que el patrón sea seguro para trimming y para AOT, y es la razón por la que el polimorfismo es una de las pocas características con forma de reflexión que sobrevive al publicar con [Native AOT y minimal API](/es/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/). Lo que no sobrevive es cualquier subtipo que solo existe en runtime, por ejemplo uno creado por una biblioteca de mocking o emitido dinámicamente.

## Lo que ASP.NET Core pone en el documento OpenAPI

El generador integrado `Microsoft.AspNetCore.OpenApi` lee los mismos atributos, así que un tipo de respuesta polimórfico se documenta solo. Para la jerarquía de pagos de arriba, el esquema generado es:

```json
{
  "PaymentMethod": {
    "required": [ "$type" ],
    "type": "object",
    "anyOf": [
      { "$ref": "#/components/schemas/PaymentMethodCardPayment" },
      { "$ref": "#/components/schemas/PaymentMethodPaypalPayment" }
    ],
    "discriminator": {
      "propertyName": "$type",
      "mapping": {
        "card": "#/components/schemas/PaymentMethodCardPayment",
        "paypal": "#/components/schemas/PaymentMethodPaypalPayment"
      }
    }
  }
}
```

Cada esquema derivado obtiene una propiedad `$type` tipada como un enum de un solo valor, que es lo que permite a los generadores de clientes producir una unión etiquetada. Vale la pena repetir una advertencia de la documentación: la palabra clave `discriminator` solo aparece cuando el tipo base es **abstracto**. Una base concreta no puede marcar `$type` como requerida en términos de OpenAPI, porque las instancias de la propia base no tienen discriminador, así que el generador descarta el objeto discriminator. Si el documento es un entregable, haz la base abstracta. Si necesitas remodelar algo de esto, eso ocurre en un transformador de esquema, cubierto en la [guía de transformadores de OpenAPI](/es/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/).

## Detalles pequeños que muerden

- **Los record funcionan, incluidos los posicionales.** `[JsonDerivedType(typeof(TextMessage), "text")]` sobre un record abstracto hace round-trip de `TextMessage(string Body)` sin ceremonia extra, porque el discriminador se lee antes de enlazar los argumentos del constructor.
- **Los subtipos genéricos cerrados son legales.** La base no puede ser genérica, pero `[JsonDerivedType(typeof(Envelope<int>), "int-envelope")]` está bien. Cada instanciación cerrada necesita su propio atributo y su propio id.
- **Los convertidores personalizados y el polimorfismo no se mezclan.** Los discriminadores solo se admiten con los convertidores por defecto de objetos, colecciones y diccionarios. Un `JsonConverter<T>` sobre el tipo base reemplaza toda la maquinaria y tiene que escribir el discriminador por su cuenta.
- **`JsonSerializerOptions.Strict` (.NET 10) es compatible.** La propiedad `$type` se trata como metadato, no como un miembro sin mapear, así que `UnmappedMemberHandling.Disallow` no la rechaza. Las propiedades de *datos* desconocidas siguen lanzando, que es el objetivo del preset.
- **`TypeNameHandling` de Newtonsoft.Json no tiene equivalente, por diseño.** Incrustar un nombre de tipo CLR en la carga útil es un vector conocido de gadgets de deserialización. `[JsonDerivedType]` exige una lista explícita de permitidos, y por eso la ruta de migración desde `TypeNameHandling.All` es la arista más filosa al [mover una base de código grande a System.Text.Json](/es/2026/05/migrate-from-newtonsoft-json-to-system-text-json-in-a-large-codebase/).
- **Un discriminador incorrecto se manifiesta ante quien llama como un fallo de conversión.** Si lo estás depurando desde fuera, los síntomas se solapan con la familia general de errores [JSON value could not be converted](/es/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/).

El modelo mental que mantiene todo esto en orden: el tipo declarado selecciona el contrato, el contrato lleva la lista de permitidos de tipos derivados, y el discriminador es un metadato que tiene que llegar antes que los datos que describe. Todos los modos de fallo de arriba son una de esas tres frases siendo violada.

## Lecturas relacionadas

- [Cómo escribir un JsonConverter personalizado en System.Text.Json](/es/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/)
- [Fix: System.Text.Json.JsonException: The JSON value could not be converted](/es/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/)
- [Migrar de Newtonsoft.Json a System.Text.Json en una base de código grande](/es/2026/05/migrate-from-newtonsoft-json-to-system-text-json-in-a-large-codebase/)
- [Cómo usar Native AOT con las minimal API de ASP.NET Core](/es/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)
- [record vs class vs struct en C#: una matriz de decisión](/es/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/)

## Fuentes

- [How to serialize properties of derived classes, MS Learn](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/polymorphism)
- [Referencia de `JsonDerivedTypeAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonderivedtypeattribute)
- [Referencia de `JsonPolymorphicAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonpolymorphicattribute)
- [`JsonSerializerOptions.AllowOutOfOrderMetadataProperties`, .NET 9+](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializeroptions.allowoutofordermetadataproperties)
- [Personalizar un contrato JSON con el modelo de contratos](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/custom-contracts)
- [Incluir metadatos de OpenAPI en una app de ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/include-metadata)
- [Cadenas de recursos de `System.Text.Json`, dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Text.Json/src/Resources/Strings.resx)
