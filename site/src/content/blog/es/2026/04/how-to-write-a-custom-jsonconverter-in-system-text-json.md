---
title: "Cómo escribir un JsonConverter personalizado en System.Text.Json"
description: "Una guía completa para escribir un JsonConverter<T> personalizado para System.Text.Json en .NET 11: cuándo realmente necesitas uno, cómo navegar correctamente Utf8JsonReader, cómo manejar genéricos con JsonConverterFactory y cómo mantenerlo compatible con AOT."
pubDate: 2026-04-25
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "serialization"
lang: "es"
translationOf: "2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json"
translatedBy: "claude"
translationDate: 2026-04-25
---

Para escribir un convertidor personalizado para `System.Text.Json`, deriva de `JsonConverter<T>`, sobrescribe `Read` y `Write`, y decora el tipo objetivo con `[JsonConverter(typeof(MyConverter))]` o agrega una instancia a `JsonSerializerOptions.Converters`. Dentro de `Read` debes recorrer el `Utf8JsonReader` exactamente la cantidad de tokens que abarca tu valor, ni más ni menos, de lo contrario la siguiente llamada al deserializador verá un flujo roto. Dentro de `Write` llamas a métodos en `Utf8JsonWriter` directamente y nunca asignas cadenas intermedias a menos que tengas que hacerlo. Para tipos genéricos o polimorfismo, usa `JsonConverterFactory` para que una sola clase pueda producir convertidores para muchas instanciaciones genéricas cerradas. Todo en esta guía se enfoca en .NET 11 (preview 3) y C# 14, pero la API ha sido estable desde .NET Core 3.0, así que el mismo código funciona en cada runtime soportado.

## Cuándo un JsonConverter es la herramienta correcta

La mayoría de los equipos recurren a un convertidor personalizado demasiado pronto. Antes de escribir uno, verifica si tu problema se puede resolver con características integradas que vienen en .NET 11 (y versiones anteriores):

- Nombres de propiedades que no coinciden: usa `JsonPropertyNameAttribute` o un `JsonNamingPolicy`. Preview 3 agregó `JsonNamingPolicy.PascalCase` y un atributo `[JsonNamingPolicy]` a nivel de miembro, así que las [políticas de nombres en System.Text.Json 11](/es/2026/04/system-text-json-11-pascalcase-per-member-naming/) probablemente cubren lo que necesitas.
- Números como cadenas: `JsonNumberHandling.AllowReadingFromString` en `JsonSerializerOptions`.
- Enums como cadenas: `JsonStringEnumConverter` está integrado. Incluso hay una [variante compatible con trim para Native AOT](/2023/09/net-8-how-to-use-jsonstringenumconverter-with-native-aot/).
- Propiedades de solo lectura o parámetros de constructor: el generador de código fuente (`[JsonSerializable]` más `JsonSerializerContext`) maneja records y constructores primarios directamente.
- Polimorfismo por discriminador: `[JsonDerivedType]` y `[JsonPolymorphic]` (agregados en .NET 7) evitan casi todos los antiguos trucos de convertidores.

Un convertidor personalizado es la herramienta correcta cuando la forma del JSON y la forma de .NET divergen genuinamente. Ejemplos:

- Un value type que debería serializarse como una primitiva (`Money` se convierte en `"42.00 USD"`).
- Un tipo cuya forma JSON depende del contexto (a veces una cadena, a veces un objeto).
- Un árbol donde el mismo nombre de propiedad lleva diferentes tipos según un campo hermano.
- Un formato de cable que no controlas (montos al estilo Stripe en centavos, duraciones ISO 8601, reglas de recurrencia RFC 5545).

Si ninguno de estos coincide, usa lo integrado y omite este artículo.

## El contrato JsonConverter<T>

`System.Text.Json.Serialization.JsonConverter<T>` tiene dos métodos abstractos que debes sobrescribir y un par de hooks opcionales:

```csharp
// .NET 11, C# 14
public abstract class JsonConverter<T> : JsonConverter
{
    public abstract T? Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options);

    public abstract void Write(
        Utf8JsonWriter writer,
        T value,
        JsonSerializerOptions options);

    // Optional: opt in to dictionary-key handling.
    public virtual T ReadAsPropertyName(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options) => throw new NotSupportedException();

    public virtual void WriteAsPropertyName(
        Utf8JsonWriter writer,
        T value,
        JsonSerializerOptions options) => throw new NotSupportedException();

    public virtual bool HandleNull => false;
}
```

Dos cosas en esta firma son fáciles de equivocar:

1. `Read` recibe `Utf8JsonReader` por `ref`. El reader es una struct mutable que posee el cursor. Si lo pasas a un método auxiliar, pásalo por `ref` también, de lo contrario el cursor del llamador no avanzará y leerás el mismo token para siempre.
2. `HandleNull` por defecto es `false`, lo que significa que el serializador devolverá `default(T)` para `null` JSON y nunca llamará a tu convertidor. Si necesitas mapear `null` a un valor no predeterminado (o distinguir "ausente" de "null"), establece `HandleNull => true` y verifica `reader.TokenType == JsonTokenType.Null` tú mismo.

El contrato completo está documentado en la página oficial de MS Learn sobre [escribir convertidores personalizados](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/converters-how-to). El resto de este artículo es la versión práctica.

## Un ejemplo trabajado: un value type Money

Toma un valor `Money` fuertemente tipado:

```csharp
// .NET 11, C# 14
public readonly record struct Money(decimal Amount, string Currency)
{
    public override string ToString() =>
        $"{Amount.ToString("0.00", CultureInfo.InvariantCulture)} {Currency}";
}
```

El comportamiento por defecto de `System.Text.Json` lo serializa como `{"Amount":42.00,"Currency":"USD"}`. Queremos un solo token de cadena en su lugar: `"42.00 USD"`. Ese es exactamente el tipo de desajuste de forma para el que sirve un convertidor.

```csharp
// .NET 11, C# 14
using System.Buffers;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

public sealed class MoneyJsonConverter : JsonConverter<Money>
{
    public override Money Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options)
    {
        if (reader.TokenType != JsonTokenType.String)
            throw new JsonException(
                $"Expected string for Money, got {reader.TokenType}.");

        string raw = reader.GetString()!; // "42.00 USD"
        int space = raw.LastIndexOf(' ');
        if (space <= 0 || space == raw.Length - 1)
            throw new JsonException($"Invalid Money literal: '{raw}'.");

        decimal amount = decimal.Parse(
            raw.AsSpan(0, space),
            NumberStyles.Number,
            CultureInfo.InvariantCulture);
        string currency = raw[(space + 1)..];

        return new Money(amount, currency);
    }

    public override void Write(
        Utf8JsonWriter writer,
        Money value,
        JsonSerializerOptions options)
    {
        // Formats directly into the writer's UTF-8 buffer.
        Span<char> buffer = stackalloc char[64];
        if (!value.Amount.TryFormat(
                buffer, out int written,
                "0.00", CultureInfo.InvariantCulture))
        {
            writer.WriteStringValue(value.ToString());
            return;
        }

        // "<number> <currency>" without intermediate string allocation.
        Span<char> output = stackalloc char[written + 1 + value.Currency.Length];
        buffer[..written].CopyTo(output);
        output[written] = ' ';
        value.Currency.AsSpan().CopyTo(output[(written + 1)..]);
        writer.WriteStringValue(output);
    }
}
```

Algunos detalles que vale la pena mencionar:

- `reader.GetString()` materializa una `string` administrada. Si estás deserializando millones de registros y el valor analizado es de corta duración, prefiere `reader.ValueSpan` (bytes UTF-8) más `Utf8Parser` para evitar la asignación.
- `writer.WriteStringValue(ReadOnlySpan<char>)` codifica en UTF-8 directamente en el búfer agrupado del writer. No hay una `string` intermedia. Esa sobrecarga, junto con `WriteStringValue(ReadOnlySpan<byte> utf8)`, es el camino económico.
- `JsonException` es la excepción canónica de "los datos están mal". El serializador la envuelve con información de línea y posición antes de que llegue al llamador, así que no necesitas agregar ninguna.

## Leer correctamente: disciplina del cursor

El bug más común en convertidores personalizados es no dejar el reader en el token correcto. El contrato es:

> Cuando `Read` retorna, el reader debe estar posicionado en el **último token consumido por tu valor**, no en el siguiente.

El serializador llama a `reader.Read()` una vez entre valores. Si tu convertidor consume demasiados tokens, la siguiente propiedad se omite silenciosamente. Si consume muy pocos, la siguiente llamada al deserializador ve un flujo malformado y lanza una excepción en un token que no esperaba.

Dos reglas cubren casi todos los casos:

1. Para un valor de un solo token (cadena, número, booleano), no hagas nada más que leer del token actual. El cursor ya está en el token correcto cuando se invoca `Read`.
2. Para un objeto o array, haz un loop hasta ver el token `EndObject` o `EndArray` correspondiente, y deja que el `reader.Read()` final del loop te deje exactamente en ese token de cierre.

Aquí está el esqueleto canónico de lectura de objetos:

```csharp
// .NET 11, C# 14
public override Foo Read(
    ref Utf8JsonReader reader,
    Type typeToConvert,
    JsonSerializerOptions options)
{
    if (reader.TokenType != JsonTokenType.StartObject)
        throw new JsonException();

    var result = new Foo();

    while (reader.Read())
    {
        if (reader.TokenType == JsonTokenType.EndObject)
            return result;

        if (reader.TokenType != JsonTokenType.PropertyName)
            throw new JsonException();

        string property = reader.GetString()!;
        reader.Read(); // advance to the value token

        switch (property)
        {
            case "id":
                result.Id = reader.GetInt32();
                break;
            case "name":
                result.Name = reader.GetString();
                break;
            case "child":
                // Recurse through the serializer so nested converters and
                // contracts apply.
                result.Child = JsonSerializer.Deserialize<Child>(
                    ref reader, options);
                break;
            default:
                reader.Skip(); // unknown field, advance past its value
                break;
        }
    }

    throw new JsonException(); // unexpected end of stream
}
```

`reader.Skip()` es el helper subestimado: avanza más allá de lo que el token actual introduce, incluyendo un objeto o array anidado, dejando el cursor en su token de cierre. Úsalo para cualquier cosa que no entiendas, nunca escribas un loop de skip personalizado.

## Escribir eficientemente: mantente en el writer

`Utf8JsonWriter` escribe directamente en un búfer UTF-8 agrupado, así que cualquier cosa que no requiera una `string` administrada debería mantenerse fuera del heap. Tres reglas:

1. Prefiere las sobrecargas tipadas: `WriteNumber`, `WriteBoolean`, `WriteString(ReadOnlySpan<char>)`. Formatean en el búfer.
2. Para pares propiedad+valor dentro de un objeto, usa `WriteString("name", value)` y similares. Emiten el nombre de propiedad y el valor en una sola llamada sin asignar.
3. Si debes construir una cadena, usa `string.Create` o un `Span<char>` asignado en pila en lugar de `string.Format` o interpolación, ambos asignan.

Para el ejemplo de `Money` anterior, una versión aún más económica usa UTF-8 directamente:

```csharp
// .NET 11, C# 14, micro-optimized hot path
public override void Write(
    Utf8JsonWriter writer,
    Money value,
    JsonSerializerOptions options)
{
    Span<byte> buffer = stackalloc byte[64];
    if (!value.Amount.TryFormat(
            buffer, out int written,
            "0.00", CultureInfo.InvariantCulture))
    {
        writer.WriteStringValue(value.ToString());
        return;
    }

    int currencyLen = Encoding.UTF8.GetByteCount(value.Currency);
    Span<byte> output = stackalloc byte[written + 1 + currencyLen];
    buffer[..written].CopyTo(output);
    output[written] = (byte)' ';
    Encoding.UTF8.GetBytes(value.Currency, output[(written + 1)..]);
    writer.WriteStringValue(output);
}
```

Esta versión nunca produce una cadena administrada para el valor formateado. Para un servicio que serializa decenas de miles de instancias de `Money` por segundo, esa es una diferencia medible en la tasa de asignación.

## Tipos genéricos y JsonConverterFactory

`JsonConverter<T>` es un tipo cerrado. Si quieres un convertidor para `Result<TValue, TError>` que funcione para cada genérico cerrado, escribes un `JsonConverterFactory` que produce los convertidores cerrados bajo demanda:

```csharp
// .NET 11, C# 14
public sealed class ResultJsonConverterFactory : JsonConverterFactory
{
    public override bool CanConvert(Type typeToConvert) =>
        typeToConvert.IsGenericType
        && typeToConvert.GetGenericTypeDefinition() == typeof(Result<,>);

    public override JsonConverter CreateConverter(
        Type typeToConvert,
        JsonSerializerOptions options)
    {
        Type[] args = typeToConvert.GetGenericArguments();
        Type closed = typeof(ResultConverter<,>).MakeGenericType(args);
        return (JsonConverter)Activator.CreateInstance(closed)!;
    }

    private sealed class ResultConverter<TValue, TError>
        : JsonConverter<Result<TValue, TError>>
    {
        public override Result<TValue, TError> Read(
            ref Utf8JsonReader reader,
            Type typeToConvert,
            JsonSerializerOptions options) =>
            throw new NotImplementedException(); // exercise for the reader

        public override void Write(
            Utf8JsonWriter writer,
            Result<TValue, TError> value,
            JsonSerializerOptions options) =>
            throw new NotImplementedException();
    }
}
```

La factory se registra de la misma forma que un convertidor regular (atributo o `Options.Converters.Add`). El serializador almacena en caché el convertidor cerrado por cada genérico cerrado, así que `CreateConverter` se ejecuta una vez por par `(TValue, TError)` por instancia de `JsonSerializerOptions`.

`Activator.CreateInstance` más `MakeGenericType` es reflexión, lo cual es hostil para Native AOT y trim. Si apuntas a AOT, mira la sección de AOT más abajo.

## Registrar un convertidor

Dos formas, y tienen diferente precedencia:

```csharp
// .NET 11, C# 14
[JsonConverter(typeof(MoneyJsonConverter))]
public readonly record struct Money(decimal Amount, string Currency);
```

El atributo fija el convertidor al tipo y es respetado por cada llamada a `JsonSerializer` sin configuración por opciones. Úsalo para value types que controlas.

```csharp
// .NET 11, C# 14
var options = new JsonSerializerOptions
{
    Converters = { new MoneyJsonConverter() }
};

string json = JsonSerializer.Serialize(invoice, options);
```

El registro a nivel de opciones es la respuesta correcta cuando no controlas el tipo objetivo, cuando el convertidor es específico del entorno (test vs prod), o cuando un solo tipo necesita formas diferentes en contextos diferentes (una API pública vs un log interno).

El orden de búsqueda, de mayor a menor prioridad:

1. El convertidor pasado directamente a una llamada de `JsonSerializer`.
2. `[JsonConverter]` en la propiedad.
3. `Options.Converters` (el último agregado gana para tipos coincidentes).
4. `[JsonConverter]` en el tipo.
5. El predeterminado integrado para ese tipo.

Si dos convertidores reclaman el mismo tipo a través de mecanismos diferentes, el que está más arriba en esta lista gana. Esboza esto en tu cabeza antes de depurar "por qué mi convertidor no se está ejecutando": casi siempre, un atributo de propiedad o una entrada de opciones está sobrescribiendo el atributo de tipo.

## Generación de código fuente y Native AOT

`JsonConverter<T>` funciona con el generador de código fuente: declara el tipo en tu `JsonSerializerContext` y el generador emite un proveedor de metadatos que delega a tu convertidor donde sea apropiado. Lo mismo **no** es automáticamente cierto para `JsonConverterFactory`. Cualquier cosa que la factory haga con `MakeGenericType` o `Activator.CreateInstance` es reflexión, que trim y AOT no pueden ver estáticamente.

Para factorías compatibles con AOT, haz una de estas:

- Restringe la factory a un conjunto conocido y finito de genéricos cerrados e instánciaalos directamente con `new ResultConverter<MyValue, MyError>()` por par.
- Anota la factory con `[RequiresDynamicCode]` y `[RequiresUnreferencedCode]`, acepta las advertencias de trim y documenta que los consumidores AOT deben registrar el convertidor cerrado manualmente.

El patrón de usar interceptors para hacer que las llamadas a `JsonSerializer.Serialize` recojan automáticamente un contexto generado, discutido en [la propuesta de interceptors de C# 14 para JSON con generación de código fuente](/2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics/), es independiente de los convertidores: incluso con eso, sigues escribiendo tu `JsonConverter<T>` personalizado de la misma manera.

## Trampas, en orden de qué tan seguido muerden

- **Olvidar avanzar el reader más allá de `EndObject`/`EndArray`.** Síntoma: la siguiente propiedad en el objeto padre se omite silenciosamente o el parser lanza un error confuso dos capas arriba. Audita escribiendo un test de convertidor que deserialice `{ "wrapped": <yourThing>, "next": 1 }` y afirme que `next` se lee.
- **Llamar a `JsonSerializer.Deserialize<T>(ref reader, options)` en el mismo `T` que tu convertidor maneja.** Esto recursa infinitamente. La recursión a través del serializador es para *otros* tipos (hijos, valores anidados).
- **Mantener el `Utf8JsonReader` a través de un `await`.** El reader es un `ref struct`, el compilador no te dejará, pero podrías estar tentado a copiar valores a variables locales y reconectar más tarde. No lo hagas. Lee todo el valor sincrónicamente dentro de `Read`. Si tu fuente de datos es asíncrona, primero almacena en búfer en un `ReadOnlySequence<byte>` y pásalo al reader.
- **Lanzar cualquier cosa que no sea `JsonException` para datos malformados.** Otras excepciones cruzan el límite del serializador sin envolver y pierden el contexto de línea/posición.
- **Mutar `JsonSerializerOptions` después de la primera llamada de serialización.** El serializador almacena en caché los convertidores resueltos por instancia de opciones; las mutaciones posteriores lanzan `InvalidOperationException`. Construye una nueva instancia de opciones en su lugar, o llama a `MakeReadOnly()` explícitamente cuando termines la configuración.
- **Usar `JsonConverterAttribute` en una interfaz o tipo abstracto y esperar polimorfismo gratis.** No funciona así. Usa `[JsonPolymorphic]` y `[JsonDerivedType]` para serialización de jerarquías, o escribe un convertidor personalizado que haga el despacho de discriminador tú mismo.
- **Asignar en `Write`.** Es fácil escribir `JsonSerializer.Serialize(value)` recursivamente y olvidar que produce una `string` que luego escribes de regreso al writer. Usa la sobrecarga `ref Utf8JsonWriter` de `Serialize` en su lugar.

Si tienes esto en mente, un convertidor rara vez toma más de 30 líneas de código y se ejecuta en el mismo presupuesto de asignación que el serializador integrado.

## Relacionados

- [Cómo usar Channels en lugar de BlockingCollection en C#](/es/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) -- patrones primero-asíncrono, misma era de diseño de API.
- [System.Text.Json en .NET 11 Preview 3 agrega PascalCase y nombres por miembro](/es/2026/04/system-text-json-11-pascalcase-per-member-naming/) -- cuando una política de nombres es suficiente y un convertidor no.
- [Cómo usar JsonStringEnumConverter con Native AOT](/2023/09/net-8-how-to-use-jsonstringenumconverter-with-native-aot/) -- la historia de trim/AOT para convertidores integrados.
- [Interceptors para la generación de código fuente de System.Text.Json](/2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics/) -- una dirección paralela de ergonomía que vale la pena seguir.
- [Cómo retornar múltiples valores desde un método en C# 14](/es/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/) -- los patrones de value-tuple y record que a menudo terminan necesitando un convertidor.

## Fuentes

- MS Learn: [Write custom converters for JSON serialization](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/converters-how-to)
- MS Learn: [How to use the source generator in System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation)
- API reference: [`Utf8JsonReader`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.utf8jsonreader), [`Utf8JsonWriter`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.utf8jsonwriter)
- dotnet/runtime issue tracker for the System.Text.Json area: [area-System.Text.Json](https://github.com/dotnet/runtime/labels/area-System.Text.Json)
