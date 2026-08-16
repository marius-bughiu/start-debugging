---
title: "Cómo hacer que System.Text.Json ignore una propiedad con el modificador required"
description: "[JsonIgnore] sobre un miembro required lanza InvalidOperationException: marked required but does not specify a setter. Aquí está por qué ambas funciones chocan y las cuatro formas de ignorar la propiedad de todos modos, medido en .NET 10."
pubDate: 2026-08-16
tags:
  - "system-text-json"
  - "csharp"
  - "csharp-14"
  - "dotnet-10"
  - "serialization"
  - "json"
lang: "es"
translationOf: "2026/08/how-to-make-system-text-json-ignore-a-property-with-the-required-modifier"
translatedBy: "claude"
translationDate: 2026-08-16
---

Respuesta corta: no puedes poner `[JsonIgnore]` en un miembro que tiene el modificador `required` de C#. En el momento en que System.Text.Json construye el contrato de ese tipo lanza `InvalidOperationException: JsonPropertyInfo 'InternalId' defined in type 'Ignored' is marked required but does not specify a setter`, tanto en la serialización como en la deserialización. Existen cuatro alternativas que funcionan, y cuál te conviene depende de si "ignorar" significa *dejar de escribirla en el JSON* o *dejar de exigirla en el JSON*. Si el tipo es tuyo, pon `[SetsRequiredMembers]` en un constructor y conserva el `[JsonIgnore]`. Si el tipo no es tuyo, limpia `JsonPropertyInfo.IsRequired` en un modificador de `DefaultJsonTypeInfoResolver`.

Todo lo que sigue fue medido con el SDK .NET 10.0.201 contra el runtime 10.0.5 con C# 14. System.Text.Json respeta el modificador `required` desde .NET 7 y las APIs del modelo de contrato usadas aquí son estables desde .NET 7, así que el comportamiento aplica a .NET 7 y posteriores salvo que una sección diga lo contrario. La única excepción es `RespectRequiredConstructorParameters`, que llegó en .NET 9.

## Por qué required y JsonIgnore no pueden convivir

Las dos funciones parecen ortogonales. `required` es una característica del lenguaje C# 11 que obliga a quien llama a asignar un miembro en un inicializador de objeto, y `[JsonIgnore]` es una instrucción para el serializador. Chocan porque System.Text.Json lee el modificador `required` y lo convierte en metadatos de serialización.

Según la [documentación de propiedades requeridas](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/required-properties), el modificador `required` de C# y `[JsonRequired]` "son equivalentes, y ambos se asignan a la misma pieza de metadatos", concretamente `JsonPropertyInfo.IsRequired`. Así que `required` no es solo un contrato del compilador, es un contrato de deserialización: la propiedad debe aparecer en el payload.

`[JsonIgnore]` funciona de otra manera. No elimina la propiedad del contrato. Conserva el `JsonPropertyInfo` y le quita los accesores. Puedes verlo ocurrir colgando un modificador del resolver e imprimiendo el contrato:

```csharp
// .NET 10.0.5, C# 14
var probe = new JsonSerializerOptions
{
    TypeInfoResolver = new DefaultJsonTypeInfoResolver
    {
        Modifiers =
        {
            static typeInfo =>
            {
                if (typeInfo.Type != typeof(Ignored)) return;
                foreach (JsonPropertyInfo p in typeInfo.Properties)
                    Console.WriteLine($"{p.Name}: IsRequired={p.IsRequired} hasSet={p.Set is not null} hasGet={p.Get is not null}");
            }
        }
    }
};

JsonSerializer.Deserialize<Ignored>("""{"Name":"a"}""", probe);

public class Ignored
{
    public required string Name { get; set; }
    [JsonIgnore] public required string InternalId { get; set; }
}
```

El modificador se ejecuta antes de la validación, así que imprime antes de la excepción:

```text
Name: IsRequired=True hasSet=True hasGet=True
InternalId: IsRequired=True hasSet=False hasGet=False
InvalidOperationException: JsonPropertyInfo 'InternalId' defined in type 'Ignored' is marked required but does not specify a setter.
```

Ahí está. `InternalId` sigue en el contrato, sigue marcado como `IsRequired=True`, pero `[JsonIgnore]` anuló ambos accesores. El serializador se queda con una propiedad que debe poblar desde el payload y sin forma de poblarla. Se niega a construir el contrato siquiera, y por eso el mensaje de la excepción habla de un setter faltante cuando tu código fuente claramente tiene uno.

Dos consecuencias de que esto sea un fallo de *validación del contrato* y no de deserialización:

- También lanza al serializar. `JsonSerializer.Serialize(new Ignored { Name = "a", InternalId = "x" })` falla con la misma `InvalidOperationException`, aunque escribir JSON nunca necesita un setter.
- Es un fallo en tiempo de ejecución, no en tiempo de compilación. Nada te avisa. El código se publica y luego lanza la primera vez que se toca ese tipo.

Lo mismo pasa con `[JsonRequired]` en lugar de la palabra clave `required`, y con campos `required` una vez que `IncludeFields` está activo. Lo que importa es la marca `IsRequired`, no cómo la pusiste.

## La reproducción mínima

```csharp
// .NET 10.0.5, C# 14
using System.Text.Json;
using System.Text.Json.Serialization;

var order = new Order { Id = 7, InternalAuditToken = "tok_abc" };

// Throws InvalidOperationException, not a JsonException.
string json = JsonSerializer.Serialize(order);

public class Order
{
    public required int Id { get; set; }

    [JsonIgnore]
    public required string InternalAuditToken { get; set; }
}
```

La intención es obvia y razonable: `InternalAuditToken` siempre debe ser asignado por tu propio código (para eso está `required`) y nunca debe cruzar la red (para eso está `[JsonIgnore]`). System.Text.Json simplemente no tiene forma de expresar ambas cosas a la vez solo con atributos.

## Marcar un constructor con SetsRequiredMembers

Esta es la solución a la que recurrir cuando el tipo es tuyo. `System.Diagnostics.CodeAnalysis.SetsRequiredMembersAttribute` le dice al compilador que un constructor dado asigna todos los miembros requeridos, de modo que quien llama ya no tiene que hacerlo. System.Text.Json también entiende ese atributo, y cuando está presente deja de tratar los miembros como requeridos.

```csharp
// .NET 10.0.5, C# 14
using System.Diagnostics.CodeAnalysis;

public class Order
{
    [SetsRequiredMembers]
    public Order()
    {
        Id = 0;
        InternalAuditToken = TokenFactory.NewToken();
    }

    public required int Id { get; set; }

    [JsonIgnore]
    public required string InternalAuditToken { get; set; }
}
```

Ahora funcionan ambas direcciones. `JsonSerializer.Deserialize<Order>("""{"Id":7}""")` devuelve una instancia cuyo `InternalAuditToken` contiene lo que haya producido el constructor, y la serialización emite `{"Id":7}` sin rastro del token.

Vale la pena entender el mecanismo, porque explica el radio de impacto. Imprimir el contrato de un tipo con y sin el atributo muestra qué cambia:

```text
[without SetsRequiredMembers]
  Name: IsRequired=True  set=True
  InternalId: IsRequired=True  set=True

[with SetsRequiredMembers]
  Name: IsRequired=False set=True
  InternalId: IsRequired=False set=True
```

`[SetsRequiredMembers]` limpia `IsRequired` para **todos** los miembros del tipo, no solo para el ignorado. Si dependías de `required` para rechazar payloads que omiten `Id`, esa validación desapareció junto con el error que intentabas arreglar. Vuelve a poner `[JsonRequired]` en los miembros que aún quieres exigir:

```csharp
// .NET 10.0.5, C# 14
public class Order
{
    [SetsRequiredMembers]
    public Order() { Id = 0; InternalAuditToken = TokenFactory.NewToken(); }

    [JsonRequired]                       // keeps the payload requirement
    public required int Id { get; set; }

    [JsonIgnore]                         // no longer required by the serializer
    public required string InternalAuditToken { get; set; }
}
```

Esa combinación te da exactamente la intención original: el compilador de C# sigue obligando a tu propio código a asignar ambos miembros, el contrato JSON sigue rechazando un payload sin `Id`, y el token nunca aparece en el JSON.

## Limpiar IsRequired con un modificador del resolver

Cuando el tipo viene de un paquete que no controlas, o quieres aplicar la regla a muchos tipos a la vez, edita el contrato en vez del tipo. Un modificador de `DefaultJsonTypeInfoResolver` se ejecuta después de construir el contrato por defecto y antes de validarlo, así que puede desactivar `IsRequired` a tiempo.

El mazo general, sacado directamente del ejemplo de Microsoft Learn, elimina la restricción en todas partes:

```csharp
// .NET 10.0.5, C# 14
var options = new JsonSerializerOptions
{
    TypeInfoResolver = new DefaultJsonTypeInfoResolver
    {
        Modifiers =
        {
            static typeInfo =>
            {
                if (typeInfo.Kind != JsonTypeInfoKind.Object) return;
                foreach (JsonPropertyInfo p in typeInfo.Properties)
                    p.IsRequired = false;
            }
        }
    }
};
```

Eso suele ser demasiado amplio. Una versión dirigida se apoya en tu propio atributo marcador, de modo que la política vive junto a la propiedad que describe y aplica a todos los tipos del modelo:

```csharp
// .NET 10.0.5, C# 14
[AttributeUsage(AttributeTargets.Property)]
public sealed class ServerOwnedAttribute : Attribute;

public class Order
{
    public required int Id { get; set; }

    [ServerOwned]
    public required string? InternalAuditToken { get; set; }
}

var options = new JsonSerializerOptions
{
    TypeInfoResolver = new DefaultJsonTypeInfoResolver
    {
        Modifiers =
        {
            static typeInfo =>
            {
                foreach (JsonPropertyInfo p in typeInfo.Properties)
                {
                    if (p.AttributeProvider?.IsDefined(typeof(ServerOwnedAttribute), inherit: true) != true)
                        continue;

                    p.IsRequired = false;                        // stop demanding it on read
                    p.ShouldSerialize = static (_, _) => false;  // stop emitting it on write
                }
            }
        }
    }
};
```

Resultados medidos con esas opciones: `Deserialize<Order>("""{"Id":7}""")` tiene éxito y deja el token en null, y `Serialize(new Order { Id = 7, InternalAuditToken = "secret" })` emite `{"Id":7}`. Fíjate en que aquí no hay `[JsonIgnore]` sobre la propiedad. `ShouldSerialize` es lo que suprime la escritura y, a diferencia de `[JsonIgnore]`, no quita los accesores, así que no hay error de validación.

Si prefieres que la propiedad desaparezca del contrato por completo, quítala en lugar de reconfigurarla. `typeInfo.Properties` es una lista mutable:

```csharp
// .NET 10.0.5, C# 14
for (int i = typeInfo.Properties.Count - 1; i >= 0; i--)
    if (typeInfo.Properties[i].Name == "InternalAuditToken")
        typeInfo.Properties.RemoveAt(i);
```

Eso también funciona en ambas direcciones, y es lo más parecido a lo que la gente espera que haga `[JsonIgnore]`. Recuerda que `Name` aquí es el nombre JSON, así que refleja cualquier política de nombres o `[JsonPropertyName]` ya aplicada. Si vas a engancharlo a unas opciones que ya tienen un resolver, conviene leer antes la mecánica de [modificar un type info resolver existente](/es/2023/10/system-text-json-how-to-modify-existing-type-info-resolver/), y el mismo punto de extensión funciona para [contratos generados por código fuente](/es/2026/08/how-to-customize-source-generated-system-text-json-serialization-with-a-modifier/).

## Ignorar solo al escribir, que es lo que mucha gente quiere en realidad

La mitad de las veces el requisito es asimétrico: la propiedad debe estar presente al leer un payload, pero no debe devolverse al escribir uno. Los hashes de contraseñas, los tokens de auditoría y los identificadores internos suelen caer aquí. Ese caso tiene una respuesta de primera clase y ningún conflicto con `required`, porque el ignorado condicional no quita los accesores:

```csharp
// .NET 10.0.5, C# 14
public class Order
{
    public required int Id { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public required string? InternalAuditToken { get; set; }
}
```

Medido: `Serialize(new Order { Id = 7, InternalAuditToken = null })` emite `{"Id":7}`, mientras que `Deserialize<Order>("""{"Id":7}""")` sigue lanzando `JsonException: JSON deserialization for type 'Order' was missing required properties including: 'InternalAuditToken'`. Ambas mitades quedan intactas. `JsonIgnoreCondition.WhenWritingDefault` se comporta igual para los tipos por valor. Solo el `[JsonIgnore]` a secas, que significa `JsonIgnoreCondition.Always`, rompe.

La cuarta opción, y a menudo la correcta en una superficie de API pública, es dejar de hacer que un mismo tipo cumpla dos funciones. Un DTO de transporte aparte, sin miembros `required`, mapeado hacia y desde tu tipo de dominio, esquiva el problema entero y te da un sitio donde poner después las preocupaciones de versionado. Cuesta un método de mapeo y te compra un contrato que puedes cambiar sin tocar tu modelo de dominio.

## Detalles que conviene conocer antes de elegir

**Un `null` explícito satisface a `required`.** `Deserialize<Order>("""{"Id":7,"InternalAuditToken":null}""")` tiene éxito. `required` significa que la clave está presente, no que el valor sea significativo. Si necesitas que no sea null, eso es un asunto de validación, no de serialización.

**Un inicializador de propiedad tampoco lo satisface.** `public required string InternalId { get; set; } = "fallback";` sigue lanzando `JsonException` cuando la clave falta en el payload. El valor por defecto se aplica y luego el serializador rechaza el payload igualmente.

**El mensaje de error usa el nombre JSON.** Con `[JsonPropertyName("internal_id")]` sobre una propiedad requerida, la excepción de propiedad faltante dice `missing required properties including: 'internal_id'`, no el nombre del miembro CLR. Útil cuando hay una política de nombres de por medio y estás buscando la cadena equivocada.

**Los campos requeridos solo se exigen cuando `IncludeFields` está activo.** Un campo `public required string InternalId;` es invisible para System.Text.Json por defecto, así que un payload que lo omite se deserializa sin problemas. Activa `IncludeFields = true` y ese mismo tipo empieza a lanzar. Si activas esa opción en una base de código existente, espera que esto salga a la superficie.

**No puedes esconder el miembro tras un setter privado.** `public required string InternalId { get; private set; }` no compila: el compilador de C# lo rechaza con `CS9032: Required member 'X' cannot be less visible or have a setter less visible than the containing type`. Eso cierra una vía de escape a la que la gente recurre, y es primo del [error CS9035 que aparece cuando un inicializador de objeto omite un miembro requerido](/es/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/).

**La generación de código fuente se comporta igual.** Deserializar a través de un `JsonSerializerContext` produce exactamente la misma `InvalidOperationException` para `[JsonIgnore]` más `required`, y la misma `JsonException` para una propiedad requerida ausente. Inspeccionar el código generado con `EmitCompilerGeneratedFiles` muestra por qué: emite `properties[0].IsRequired = true;` directamente. Vale la pena señalarlo porque la página de Microsoft Learn todavía aconseja usar `[JsonRequired]` en lugar de `required` en modo de generación de código fuente con el argumento de que "tu código no compilará" con la palabra clave. En .NET 10 compila y funciona; `[SetsRequiredMembers]` también funciona a través de un contexto generado. Si estás en un SDK más antiguo, verifícalo antes de confiar en ello.

**`RespectRequiredConstructorParameters` es otra perilla distinta.** Introducida en .NET 9, hace que los *parámetros de constructor* no opcionales sean obligatorios en el payload. No tiene nada que ver con el modificador `required` sobre miembros, y desactivarla no te va a rescatar aquí. Verificado: con un constructor `Order(string name, string internalId)` y sin opciones, `Deserialize<Order>("""{"Name":"a"}""")` tiene éxito y deja el parámetro en su valor por defecto; con `RespectRequiredConstructorParameters = true` esa misma llamada lanza `JsonException`. Si tu problema es un argumento de constructor ausente y no un miembro ausente, esa es la bandera que hay que mirar.

Si el objetivo real es rechazar payloads que traen campos que no modelaste, ese es el problema espejo y tiene su propio interruptor: mira [cómo manejar miembros faltantes y no mapeados durante la deserialización](/es/2023/09/net-8-handle-missing-members-during-json-deserialization/). Y cuando la propiedad solo debe ignorarse en algunas formas de una jerarquía, un [JsonConverter personalizado](/es/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) te da control total sobre lo que se escribe, a cambio de mantener a mano las rutas de lectura y escritura.

Mi recomendación por defecto: si el tipo es tuyo, `[SetsRequiredMembers]` en un constructor más `[JsonRequired]` en los miembros que aún quieres exigir. Son tres líneas, conserva la garantía a nivel de compilador que te hizo escribir `required` en primer lugar, y no necesita un objeto de opciones personalizado atravesando toda tu aplicación.

## Fuentes

- [Require properties for deserialization](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/required-properties) en Microsoft Learn, por la equivalencia entre `required`, `[JsonRequired]` y `JsonPropertyInfo.IsRequired`, y por el interruptor de característica `RespectRequiredConstructorParameters`.
- [How to ignore properties with System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/ignore-properties) por la lista completa de `JsonIgnoreCondition` y el ajuste global `DefaultIgnoreCondition`.
- Referencia de API de [JsonPropertyInfo.IsRequired](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.metadata.jsonpropertyinfo.isrequired) y [JsonPropertyInfo.ShouldSerialize](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.metadata.jsonpropertyinfo.shouldserialize).
- Referencia de API de [SetsRequiredMembersAttribute](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.codeanalysis.setsrequiredmembersattribute).
- [El modificador required](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/required) en la referencia del lenguaje C#, incluida la regla de visibilidad CS9032.
