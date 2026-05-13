---
title: "Solución: System.Text.Json.JsonException: The JSON value could not be converted"
description: "System.Text.Json lanza esta excepción cuando el token JSON entrante no coincide con el tipo CLR de destino. Haz que el JSON coincida con el tipo, o registra un JsonConverter o una JsonSerializerOption que los reconcilie."
pubDate: 2026-05-13
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "json"
lang: "es"
translationOf: "2026/05/fix-jsonexception-the-json-value-could-not-be-converted"
translatedBy: "claude"
translationDate: 2026-05-13
---

La solución: `System.Text.Json` lanzó esta excepción porque el token JSON en la ruta que indica no puede deserializarse en el tipo CLR de destino. El mensaje suele aparecer en dos formas. O bien el JSON tiene el **tipo de token** equivocado (una cadena donde se esperaba un número, o al revés, o un número donde se esperaba un valor de enum), o bien el JSON tiene el tipo correcto pero el **contenido** no coincide con las reglas de análisis del tipo (una fecha que no es ISO, un `Guid` mal formado, un literal como `"NaN"`). Elige una de las tres soluciones por sitio de llamada: cambia el productor para que emita la forma JSON esperada, activa un convertidor que acepte la forma que realmente recibes (`JsonStringEnumConverter`, `JsonNumberHandling.AllowReadingFromString`), o escribe un `JsonConverter<T>` que haga el análisis tú mismo.

```text
System.Text.Json.JsonException: The JSON value could not be converted to MyApp.OrderStatus. Path: $.status | LineNumber: 0 | BytePositionInLine: 21.
   at System.Text.Json.ThrowHelper.ThrowJsonException(String message)
   at System.Text.Json.Serialization.Converters.EnumConverter`1.Read(Utf8JsonReader& reader, Type typeToConvert, JsonSerializerOptions options)
   at System.Text.Json.Serialization.JsonConverter`1.ReadCore(Utf8JsonReader& reader, JsonSerializerOptions options, ReadStack& state)
   at System.Text.Json.JsonSerializer.ReadFromSpan[TValue](ReadOnlySpan`1 utf8Json, JsonTypeInfo jsonTypeInfo)
   at System.Text.Json.JsonSerializer.Deserialize[TValue](String json, JsonSerializerOptions options)
```

Esta guía está escrita contra .NET 11 versión preliminar 4 y `System.Text.Json` 11.0.0-preview.4. El tipo de excepción y los campos `Path` / `LineNumber` / `BytePositionInLine` se han mantenido estables desde que `System.Text.Json` se publicó en .NET Core 3.0, así que cada solución a continuación se aplica a .NET 6, 8, 10 y 11 sin cambios. Lo único que se ha movido entre versiones son los ajustes del convertidor: `JsonNumberHandling` llegó en .NET 5, `JsonStringEnumConverter<TEnum>` (la versión genérica, compatible con AOT) se publicó en .NET 8, y el atributo `[JsonStringEnumMemberName]` aterrizó en .NET 9.

Lo primero que hay que leer es el segmento **`Path`**. Es una ruta al estilo JSON Pointer con `$` como raíz, y te dice exactamente qué propiedad atragantó al lector. Los motores de búsqueda tienden a llevarte a una traza de pila que nombra un convertidor genérico ("the JSON value could not be converted to `Int32`") sin pista de qué propiedad, pero `Path` siempre está ahí. Si no ves un segmento `Path`, estás viendo una excepción envuelta. Captura `JsonException` directamente en el sitio de llamada de la deserialización y lee `ex.Path` desde la propiedad, no desde `ex.Message`.

## Por qué System.Text.Json se niega a coaccionar

A diferencia de `Newtonsoft.Json`, `System.Text.Json` es **estricto por defecto**: no coacciona entre tipos de tokens JSON y no ejecuta un analizador con pérdida sobre el contenido de la cadena. Si tu endpoint acepta `{ "amount": "12.50" }` y tu DTO tiene `decimal Amount`, el lector ve `JsonTokenType.String`, no encuentra conversión incorporada de `string` a `decimal` y lanza. La misma lógica rechaza:

- Una cadena JSON donde la propiedad espera un `bool`, `int`, `long`, `decimal`, `double`, `Guid`, `DateTime` o `TimeSpan`. La dirección contraria (un número JSON donde la propiedad espera un `string`) también se rechaza.
- Un número JSON que nombra un valor de enum cuando no hay un `JsonStringEnumConverter` registrado, **o** una cadena JSON que nombra un valor de enum cuando el convertidor por defecto solo acepta enteros.
- Una cadena vacía `""` donde la propiedad espera un tipo por valor. Las cadenas vacías no son lo mismo que `null`, y los tipos por valor no son anulables a menos que se declaren como `T?`.
- Un objeto JSON polimórfico donde el discriminador no coincide con ningún `[JsonDerivedType]` que hayas registrado.
- Un literal de punto flotante como `"NaN"`, `"Infinity"` o `"-Infinity"` cuando no está activado `JsonNumberHandling.AllowNamedFloatingPointLiterals`.
- Un número de timestamp Unix (`1715600000`) para una propiedad `DateTime`, porque `System.Text.Json` solo lee `DateTime` desde una cadena ISO 8601. El caso específico está cubierto en [la solución canónica para la conversión de DateTime](/es/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/).



La estricticidad es el diseño, no el error. La justificación del equipo es que la conversión con pérdida es la fuente más común de corrupción silenciosa de datos en aplicaciones de negocio, y que el registro explícito de convertidores hace visible la intención en la frontera entre el formato de cable y el sistema de tipos. La contrapartida es que toda preocupación transversal que solías obtener de los valores por defecto de `Newtonsoft.Json` (cadena-a-número, cadena-a-enum, cadena-a-bool) ahora necesita una activación explícita.

## Reproducción mínima

El programa más pequeño que reproduce la variante más común, un enum que llega como cadena:

```csharp
// .NET 11 preview 4, System.Text.Json 11.0.0-preview.4
using System.Text.Json;

var json = """{ "status": "Pending" }""";

var order = JsonSerializer.Deserialize<Order>(json);

Console.WriteLine(order!.Status);

public record Order(OrderStatus Status);
public enum OrderStatus { Pending, Shipped, Delivered }
```

Ejecutar esto lanza:

```text
Unhandled exception. System.Text.Json.JsonException:
The JSON value could not be converted to OrderStatus. Path: $.status | LineNumber: 0 | BytePositionInLine: 20.
```

El convertidor de enums por defecto acepta solo la representación **entera** (`{ "status": 0 }`). Cualquier otra cosa dispara la excepción. Una vez entiendes que este es el modo de fallo, todas las demás variantes en este post siguen el mismo patrón: la forma JSON no coincide con el tipo, y eliges qué lado doblar.

## Solución 1: enums recibidos como cadenas

Registra `JsonStringEnumConverter<TEnum>` una vez en tu `JsonSerializerOptions`:

```csharp
// .NET 11 preview 4, System.Text.Json 11.0.0-preview.4
var options = new JsonSerializerOptions
{
    Converters = { new JsonStringEnumConverter<OrderStatus>() }
};

var order = JsonSerializer.Deserialize<Order>(json, options)!;
```

Si tienes muchos enums, registra en su lugar el `JsonStringEnumConverter()` no genérico. Se aplica a cada tipo enum que el serializador encuentra, al costo de ser incompatible con el recorte de Native AOT. Para Native AOT, prefiere el convertidor genérico por enum o anota cada enum con `[JsonConverter(typeof(JsonStringEnumConverter<OrderStatus>))]` directamente, luego mantén la lista global de convertidores vacía.

Si el productor distingue entre mayúsculas y minúsculas ("PENDING" en el cable, `Pending` en C#), pasa una política de nombres:

```csharp
var options = new JsonSerializerOptions
{
    Converters =
    {
        new JsonStringEnumConverter<OrderStatus>(JsonNamingPolicy.SnakeCaseUpper)
    }
};
```

Para productores que envían valores que no se pueden representar como identificadores de C# ("in-progress", "n/a"), .NET 9 introdujo `[JsonStringEnumMemberName]`:

```csharp
public enum OrderStatus
{
    Pending,

    [JsonStringEnumMemberName("in-progress")]
    InProgress,

    Delivered
}
```

En las APIs mínimas de ASP.NET Core, configura el convertidor en las `JsonSerializerOptions` de la aplicación para que cada endpoint lo recoja:

```csharp
// .NET 11 preview 4, ASP.NET Core 11.0.0-preview.4
builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.Converters.Add(new JsonStringEnumConverter<OrderStatus>());
});
```

Para controladores, la llamada equivalente es `builder.Services.AddControllers().AddJsonOptions(o => o.JsonSerializerOptions.Converters.Add(...))`. Configurarlo una vez en la raíz de composición es preferible a abrir `JsonConverter` en cada atributo `[JsonConverter(...)]`.

## Solución 2: números recibidos como cadenas (y viceversa)

Cuando el productor codifica en JSON un campo numérico como cadena, `{ "amount": "12.50" }`, activa `JsonNumberHandling.AllowReadingFromString`:

```csharp
// .NET 11 preview 4, System.Text.Json 11.0.0-preview.4
var options = new JsonSerializerOptions
{
    NumberHandling = JsonNumberHandling.AllowReadingFromString
};

var dto = JsonSerializer.Deserialize<Invoice>(json, options);

public record Invoice(decimal Amount);
```

`AllowReadingFromString` funciona para todo tipo integral y de punto flotante, más `decimal`. Es simétrico con `WriteAsString`, que puedes combinar si quieres que el serializador emita y lea el valor como cadena:

```csharp
NumberHandling = JsonNumberHandling.AllowReadingFromString | JsonNumberHandling.WriteAsString
```

Para un alcance por propiedad en lugar de global, anota la propiedad directamente:

```csharp
public record Invoice(
    [property: JsonNumberHandling(JsonNumberHandling.AllowReadingFromString)] decimal Amount
);
```

El caso inverso, un número JSON enviado donde se espera un `string` (un ID de seguimiento codificado como `42` en lugar de `"42"`), **no** está cubierto por `JsonNumberHandling`. Necesitas un pequeño convertidor personalizado:

```csharp
// .NET 11 preview 4
public sealed class NumberOrStringConverter : JsonConverter<string>
{
    public override string? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        => reader.TokenType switch
        {
            JsonTokenType.String => reader.GetString(),
            JsonTokenType.Number => reader.GetInt64().ToString(System.Globalization.CultureInfo.InvariantCulture),
            JsonTokenType.Null => null,
            _ => throw new JsonException()
        };

    public override void Write(Utf8JsonWriter writer, string value, JsonSerializerOptions options)
        => writer.WriteStringValue(value);
}
```

Cubro el contrato del convertidor con más profundidad en [la guía para escribir un JsonConverter personalizado](/es/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/), incluyendo cómo componer convertidores y cómo cortocircuitar el despacho polimórfico.

## Solución 3: booleanos recibidos como 0 / 1 o como cadenas "true" / "false"

`System.Text.Json` solo acepta los tokens JSON `true` / `false` para `bool`. El numérico `0` / `1` y las cadenas `"true"` / `"false"` se rechazan ambos. No hay opción incorporada para ninguna de las dos formas; escribe un convertidor:

```csharp
// .NET 11 preview 4
public sealed class LooseBooleanConverter : JsonConverter<bool>
{
    public override bool Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        => reader.TokenType switch
        {
            JsonTokenType.True => true,
            JsonTokenType.False => false,
            JsonTokenType.Number => reader.GetInt32() != 0,
            JsonTokenType.String => bool.Parse(reader.GetString()!),
            _ => throw new JsonException()
        };

    public override void Write(Utf8JsonWriter writer, bool value, JsonSerializerOptions options)
        => writer.WriteBooleanValue(value);
}
```

Regístralo por propiedad con `[JsonConverter(typeof(LooseBooleanConverter))]` en lugar de globalmente, porque la mayoría de los campos en una API bien comportada no son flexibles, y doblar cada `bool` para aceptar tres formas oscurece el contrato.

## Solución 4: cadenas vacías para tipos por valor

Si el productor emite `{ "shippedAt": "" }` para una fecha ausente, `System.Text.Json` lee `JsonTokenType.String` y falla al analizar el contenido vacío como `DateTime`. Hay dos soluciones limpias. La primera es hacer la propiedad C# anulable y escribir un convertidor que mapee `""` a `null`:

```csharp
public sealed class NullableDateTimeConverter : JsonConverter<DateTime?>
{
    public override DateTime? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.Null) return null;
        if (reader.TokenType == JsonTokenType.String)
        {
            var s = reader.GetString();
            return string.IsNullOrEmpty(s) ? null : DateTime.Parse(s, System.Globalization.CultureInfo.InvariantCulture);
        }
        throw new JsonException();
    }

    public override void Write(Utf8JsonWriter writer, DateTime? value, JsonSerializerOptions options)
        => writer.WriteStringValue(value);
}
```

La segunda es establecer `JsonSerializerOptions.RespectNullableAnnotations = true` (por defecto en .NET 9+) y hacer que el productor envíe `null` en lugar de `""`. La solución del lado productor es preferible cuando controlas ambos lados, porque cada caso especial `""`-como-null acaba filtrándose en una columna no anulable o una NullReferenceException río abajo.

## Solución 5: Guid en formato incorrecto

`System.Text.Json` usa `Guid.TryParseExact` con formato `D` (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`). Las representaciones con llaves (`{...}`), con paréntesis (`(...)`) y sin guiones (`N`) todas lanzan. La solución más corta es un convertidor por propiedad:

```csharp
public sealed class FlexibleGuidConverter : JsonConverter<Guid>
{
    public override Guid Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        var s = reader.GetString();
        return Guid.Parse(s!);
    }

    public override void Write(Utf8JsonWriter writer, Guid value, JsonSerializerOptions options)
        => writer.WriteStringValue(value);
}
```

`Guid.Parse` acepta cada cadena de formato estándar, así que esto es suficiente.

## Solución 6: objetos polimórficos con un discriminador desconocido

Cuando declaras un tipo base con `[JsonPolymorphic]` y `[JsonDerivedType]`, el lector inspecciona la propiedad discriminadora y camina al subtipo correspondiente. Si el valor del discriminador falta o es desconocido, el lector lanza "the JSON value could not be converted to BaseType". Dos soluciones de grado de producción:

- Establece `UnknownDerivedTypeHandling = JsonUnknownDerivedTypeHandling.FallBackToBaseType` para que el lector materialice el tipo base cuando ningún tipo derivado coincida.
- Establece `UnknownDerivedTypeHandling = JsonUnknownDerivedTypeHandling.FallBackToNearestAncestor` si tienes una jerarquía de clases más profunda que un nivel y quieres el ancestro registrado más cercano.

```csharp
// .NET 11 preview 4
[JsonPolymorphic(
    TypeDiscriminatorPropertyName = "$kind",
    UnknownDerivedTypeHandling = JsonUnknownDerivedTypeHandling.FallBackToBaseType)]
[JsonDerivedType(typeof(EmailEvent), "email")]
[JsonDerivedType(typeof(SmsEvent), "sms")]
public abstract record Event;

public record EmailEvent(string To, string Subject) : Event;
public record SmsEvent(string To, string Body) : Event;
```

El comportamiento por defecto (`JsonUnknownDerivedTypeHandling.FailSerialization`) es correcto para esquemas cerrados donde se conoce cada variante. Usa las opciones de fallback cuando ingieras eventos de un productor que añade variantes nuevas sin coordinar un despliegue.

## Solución 7: NaN e Infinity de punto flotante

Si un serializador del lado productor emite `"NaN"`, `"Infinity"` o `"-Infinity"` para `double` / `float`, actívalo:

```csharp
var options = new JsonSerializerOptions
{
    NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals
};
```

Esto es simétrico: la misma opción también permite a tu serializador emitir esos literales en la ruta de escritura. Sin él, tanto leer como escribir lanzan.

## Trampas y casos parecidos

- **El mensaje de excepción nombra un tipo base, no el concreto.** La deserialización polimórfica reporta el fallo contra la raíz polimórfica, no contra el tipo al que apuntaba el discriminador. Lee el valor del discriminador en tu JSON crudo antes de asumir que el convertidor es el problema.
- **Los contextos generados por código fuente ocultan opciones.** Si declaraste `[JsonSerializable(typeof(Order))]` en un `JsonSerializerContext`, la lista de convertidores en las `JsonSerializerOptions` de tiempo de ejecución que pasas **se** respeta, pero los metadatos generados por código fuente también codifican los atributos `[JsonConverter]` en tiempo de compilación. Mezclar ambos está bien, pero un `[JsonConverter(...)]` a nivel de propiedad siempre gana sobre un global registrado en tiempo de ejecución. Consulta [el soporte de interceptores de C# 14 para la generación de código fuente de System.Text.Json](/es/2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics/) para el trabajo de ergonomía en esta área.
- **La sensibilidad a mayúsculas es independiente del convertidor.** `PropertyNameCaseInsensitive = true` y las políticas de nombres conscientes del caso (`JsonNamingPolicy.CamelCase`, `JsonNamingPolicy.SnakeCaseLower`, el atributo de [nombres PascalCase por miembro en .NET 11](/es/2026/04/system-text-json-11-pascalcase-per-member-naming/)) afectan a qué propiedad CLR enlaza el lector, no a cómo convierte el valor. Si tu error menciona `Path: $.OrderStatus` pero tu JSON tiene `"orderStatus"`, estás viendo un fallo de enlace, no un fallo de conversión.
- **La rama DateTime tiene sus propias convenciones.** Solo ISO 8601, solo separador `T`, sin timestamps Unix. La tabla completa de formatos aceptados y rechazados está en [la solución dedicada para la conversión de DateTime](/es/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/).
- **Leer un número que no cabe.** Un JSON `9999999999` no se puede leer en un `int` y lanza con el mismo texto de excepción. Verifica la magnitud antes de asumir que es un problema de formato.
- **Newtonsoft.Json coaccionaba silenciosamente.** El camino más común a este error es una migración desde `Newtonsoft.Json` donde el código viejo aceptaba `{ "amount": "12.50" }` porque Newtonsoft intenta cadena-a-decimal bajo el capó. No hay interruptor global "sé tolerante" en `System.Text.Json`. O bien estableces `NumberHandling` y registras `JsonStringEnumConverter`, o te quedas en Newtonsoft para esa frontera.

## Relacionados

- [Solución: The JSON value could not be converted to System.DateTime](/es/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) cubre la variante específica de DateTime, incluyendo el requisito de formato ISO 8601 y el análisis de timestamp Unix.
- [Cómo escribir un JsonConverter personalizado en System.Text.Json](/es/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) muestra el contrato del convertidor, los convertidores de fábrica y cómo caer al convertidor por defecto.
- [Nombres PascalCase por miembro en System.Text.Json 11](/es/2026/04/system-text-json-11-pascalcase-per-member-naming/) es la herramienta correcta cuando el fallo es de enlace de propiedad en lugar de conversión de valor.
- [Interceptores de C# 14 para la generación de código fuente de System.Text.Json](/es/2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics/) explica cómo los convertidores generados por código fuente interactúan con las `JsonSerializerOptions` de tiempo de ejecución.
- [Solución: InvalidOperationException: Synchronous operations are disallowed](/es/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed/) no está relacionado pero suele aparecer junto con errores de conversión JSON al migrar de JSON bufferizado a JSON en streaming en ASP.NET Core.

## Fuentes

- [Resumen de System.Text.Json, .NET docs](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/overview)
- [Cómo serializar y deserializar valores de enum, MS Learn](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/customize-properties)
- [Referencia de `JsonNumberHandling`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonnumberhandling)
- [`JsonPolymorphicAttribute` y `JsonDerivedTypeAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonpolymorphicattribute)
- [`JsonStringEnumMemberNameAttribute`, .NET 9+](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonstringenummembernameattribute)
- [Código fuente de `dotnet/runtime` para `EnumConverter<T>`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Text.Json/src/System/Text/Json/Serialization/Converters/Value/EnumConverter.cs)
