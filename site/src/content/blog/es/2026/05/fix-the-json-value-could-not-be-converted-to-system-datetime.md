---
title: "Fix: The JSON value could not be converted to System.DateTime"
description: "System.Text.Json solo acepta cadenas ISO 8601 para DateTime. Envía 2026-05-08T14:00:00Z o registra un JsonConverter que parsee tu formato. Cadenas vacías y timestamps Unix también lanzan."
pubDate: 2026-05-08
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "json"
lang: "es"
translationOf: "2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime"
translatedBy: "claude"
translationDate: 2026-05-08
---

La solución: `System.Text.Json` solo deserializa un `DateTime` desde una cadena JSON en formato ISO 8601 extendido, como `"2026-05-08T14:00:00Z"` o `"2026-05-08T14:00:00+02:00"`. Si tu productor envía `"05/08/2026"`, una cadena vacía `""`, un número con timestamp Unix, o el `"/Date(1746715200000)/"` de Newtonsoft, el deserializador lanza una excepción. O cambias el formato del cable a ISO 8601, o registras un `JsonConverter<DateTime>` que sepa parsear lo que realmente recibes.

```text
System.Text.Json.JsonException: The JSON value could not be converted to System.DateTime. Path: $.startedAt | LineNumber: 0 | BytePositionInLine: 27.
   at System.Text.Json.ThrowHelper.ReThrowWithPath(ReadStack& state, JsonReaderException ex)
   at System.Text.Json.Serialization.JsonConverter`1.ReadCore(Utf8JsonReader& reader, JsonSerializerOptions options, ReadStack& state)
   at System.Text.Json.JsonSerializer.ReadFromSpan[TValue](ReadOnlySpan`1 utf8Json, JsonTypeInfo jsonTypeInfo)
   at System.Text.Json.JsonSerializer.Deserialize[TValue](String json, JsonSerializerOptions options)
 ---> System.FormatException: The JSON value is not in a supported DateTime format.
```

Esta guía está escrita contra .NET 11 preview 4 y `System.Text.Json` 11.0.0-preview.4. El formato aceptado y la excepción no han cambiado desde que `System.Text.Json` se publicó en .NET Core 3.0; el texto de la `FormatException` interna es lo que se ajustó alrededor de .NET 8. El segmento `Path` es la ruta JSON de la propiedad ofensiva y es lo primero que hay que leer, te dice en qué campo se atascó el conversor sin tener que instrumentar nada.

## Por qué System.Text.Json es tan estricto

`System.Text.Json` implementa deliberadamente solo el [perfil ISO 8601-1:2019 Extended](https://learn.microsoft.com/en-us/dotnet/standard/datetime/system-text-json-support) para `DateTime` y `DateTimeOffset`. El formato debe ser `YYYY-MM-DDTHH:mm:ss[.fffffff][Z|+hh:mm]` con un literal `T` como separador. La `t` minúscula, un espacio como separador, el estilo estadounidense `MM/dd/yyyy`, años de dos dígitos, segundos faltantes, y valores solo de hora o solo de fecha son todos rechazados. También lo es el token JSON `null` a menos que la propiedad sea un `DateTime?` anulable, y también lo es una cadena vacía `""`.

Esto es por diseño: el parser permisivo de múltiples formatos de Newtonsoft.Json causaba bugs reales donde un productor en una región enviaba `01/05/2026` y un consumidor en otra lo parseaba silenciosamente como la fecha incorrecta. `System.Text.Json` trata el parseo de DateTime de la misma forma que trata los números en JSON: una forma canónica, sin adivinanzas.

Así que el deserializador hace bien en lanzar. El trabajo es o hacer que el cable se ajuste, o registrar un conversor que mapee tu formato del cable a un `DateTime` exactamente una vez.

## Una reproducción mínima

```csharp
// .NET 11, C# 14, System.Text.Json 11.0.0-preview.4
using System.Text.Json;

record Event(DateTime StartedAt);

var bad = """{ "startedAt": "05/08/2026" }""";
var ev = JsonSerializer.Deserialize<Event>(bad); // throws
```

El productor envió una fecha con barras al estilo estadounidense y `System.Text.Json` no conoce ese formato. El mismo error se dispara para cualquiera de estos payloads:

```json
{ "startedAt": "" }
{ "startedAt": "2026-05-08" }
{ "startedAt": 1746715200 }
{ "startedAt": "/Date(1746715200000)/" }
{ "startedAt": "2026-05-08 14:00:00" }
{ "startedAt": "Friday, May 8, 2026" }
```

Cada uno falla por una razón distinta. La cadena vacía no es parseable como fecha. La fecha desnuda `"2026-05-08"` no tiene componente de hora, ISO 8601 Extended requiere la `T` y una hora. El número con timestamp Unix no puede vincularse a `DateTime` en absoluto. La sintaxis `/Date(...)` es un artefacto histórico de Newtonsoft. El formato separado por espacios es ISO 8601 Basic, no Extended. La forma larga en inglés no es un formato máquina.

## Solución, en detalle

### 1. Haz que el productor envíe ISO 8601

La respuesta correcta es arreglarlo en el origen. ISO 8601 Extended con una `T` y una `Z` UTC (o un offset explícito) hace round-trip entre todos los stacks modernos: `Date.prototype.toISOString()` de JavaScript, `datetime.isoformat()` de Python, `to_char(... 'YYYY-MM-DD"T"HH24:MI:SSOF')` de Postgres, `Instant.toString()` de Java, y `DateTime.UtcNow.ToString("o")` en .NET, todos lo emiten.

```csharp
// .NET 11, C# 14
var iso = DateTime.UtcNow.ToString("o"); // 2026-05-08T14:00:00.0000000Z
```

Si controlas el productor, esto es una línea de trabajo. Evita `"u"` (usa un espacio como separador, no una `T`) y evita serializar `DateTime.Now` sin un offset, lo que crea valores con kind `Unspecified` que hacen round-trip de forma ambigua.

### 2. Registra un JsonConverter para formatos no ISO

Cuando no puedes cambiar el productor (API de terceros, payload heredado), escribe un conversor. El patrón del conversor es el mismo independientemente del formato origen, lo único que cambia es la llamada de parseo.

```csharp
// .NET 11, C# 14, System.Text.Json 11.0.0-preview.4
using System.Buffers;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

public sealed class UsSlashDateConverter : JsonConverter<DateTime>
{
    private const string Format = "MM/dd/yyyy";

    public override DateTime Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options)
    {
        var text = reader.GetString();
        return DateTime.ParseExact(
            text!, Format, CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);
    }

    public override void Write(
        Utf8JsonWriter writer,
        DateTime value,
        JsonSerializerOptions options)
        => writer.WriteStringValue(value.ToUniversalTime().ToString(Format, CultureInfo.InvariantCulture));
}
```

Regístralo una vez en las opciones, no lo instancies en cada punto de llamada:

```csharp
// .NET 11
var options = new JsonSerializerOptions
{
    Converters = { new UsSlashDateConverter() }
};
var ev = JsonSerializer.Deserialize<Event>(bad, options);
```

Pasa siempre `CultureInfo.InvariantCulture` y fija el formato exacto con `ParseExact`. `Parse` y `TryParse` dependen de la cultura actual y reintroducen la misma ambigüedad que ISO 8601 fue diseñado para eliminar. Para los detalles del andamiaje del conversor, el [recorrido por JsonConverter personalizado](/es/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) cubre los trucos de hot path (`Utf8JsonReader.ValueSpan`, parseo con span) que importan cuando el conversor está en una ruta de alto rendimiento.

### 3. Convierte timestamps Unix con un lector que detecta números

Si el cable envía un número (`"startedAt": 1746715200`), `reader.GetString()` lanzará porque el token es `Number`, no `String`. Bifurca según `TokenType`:

```csharp
// .NET 11, C# 14, System.Text.Json 11.0.0-preview.4
public sealed class UnixSecondsConverter : JsonConverter<DateTime>
{
    public override DateTime Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options)
    {
        return reader.TokenType switch
        {
            JsonTokenType.Number => DateTimeOffset.FromUnixTimeSeconds(reader.GetInt64()).UtcDateTime,
            JsonTokenType.String when long.TryParse(reader.GetString(), out var s)
                => DateTimeOffset.FromUnixTimeSeconds(s).UtcDateTime,
            JsonTokenType.String
                => DateTime.Parse(reader.GetString()!, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind),
            _ => throw new JsonException($"Unexpected token {reader.TokenType} for DateTime.")
        };
    }

    public override void Write(
        Utf8JsonWriter writer,
        DateTime value,
        JsonSerializerOptions options)
        => writer.WriteNumberValue(new DateTimeOffset(value, TimeSpan.Zero).ToUnixTimeSeconds());
}
```

Este es el conversor que escribes para APIs REST antiguas que mezclan payloads de tipo cadena y número (Twitter, Stripe, campos heredados de Slack). `DateTimeOffset.FromUnixTimeSeconds` es el helper correcto, no multipliques por 10.000 para hacer un valor `Ticks`, esa ruta pierde precisión sub-segundo e ignora la diferencia de epoch.

### 4. Trata las cadenas vacías como null

Una rareza común de las APIs es enviar `""` para "sin fecha". El deserializador no puede vincular una cadena vacía ni a `DateTime` ni a `DateTime?`. Haz la propiedad anulable y añade un conversor que devuelva `null` ante entrada vacía:

```csharp
// .NET 11, C# 14, System.Text.Json 11.0.0-preview.4
public sealed class NullableEmptyDateTimeConverter : JsonConverter<DateTime?>
{
    public override DateTime? Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.Null) return null;
        var text = reader.GetString();
        if (string.IsNullOrEmpty(text)) return null;
        return DateTime.Parse(text, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind);
    }

    public override void Write(
        Utf8JsonWriter writer,
        DateTime? value,
        JsonSerializerOptions options)
    {
        if (value is null) writer.WriteNullValue();
        else writer.WriteStringValue(value.Value.ToString("o", CultureInfo.InvariantCulture));
    }
}
```

Aplícalo por propiedad si solo un campo se comporta mal, con `[JsonConverter(typeof(NullableEmptyDateTimeConverter))]` sobre la propiedad. El registro global de arriba reemplaza el conversor por defecto para cada `DateTime?` del grafo; el atributo por propiedad es más estrecho y más seguro.

### 5. Usa DateOnly cuando no hay hora

Si el cable realmente es `"2026-05-08"` (una fecha del calendario sin hora del día), el tipo en el consumidor debería ser `DateOnly`, no `DateTime`. `System.Text.Json` 8.0+ tiene soporte integrado y acepta el formato de fecha ISO 8601 directamente:

```csharp
// .NET 11, C# 14
record Event(DateOnly StartedOn);

var json = """{ "startedOn": "2026-05-08" }""";
var ev = JsonSerializer.Deserialize<Event>(json); // works, no converter needed
```

`DateOnly` se añadió en .NET 6 específicamente porque fecha-sin-hora era el bug de modelado relacionado con DateTime más común. Si tu dominio realmente es un día del calendario (un cumpleaños, una fecha de entrega, un día festivo), cambia los tipos y el problema de parseo JSON se evapora.

## Formas comunes que disparan esto

### La propiedad es un struct DateTime pero el valor puede faltar

Un `DateTime` no anulable no puede contener "ausente". El productor envía `null` o `""`, el deserializador lanza. Haz la propiedad `DateTime?`. Si no controlas el esquema, `[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]` limpia el round-trip a la salida, pero la ruta de lectura aún necesita ser anulable.

### Un formato de fecha de Newtonsoft configurado se filtró al contrato

Si estás migrando desde Newtonsoft.Json, tu código antiguo probablemente tenía `IsoDateFormatString = "MM/dd/yyyy"` o un `DateTimeFormat` definido en un `JsonSerializerSettings`. Newtonsoft lo aceptaba, `System.Text.Json` no honra esa configuración en absoluto. Busca en tu repo `DateFormatHandling`, `DateTimeFormat` e `IsoDateFormatString`, y o arregla el productor o escribe el conversor de arriba. El equipo de vstest [eliminó la dependencia transitiva de Newtonsoft.Json](/es/2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4/) en .NET 11 preview 4 por razones similares de endurecimiento de contrato.

### El model binding de MVC se traga la excepción interna

En ASP.NET Core, una fecha inválida en un cuerpo de solicitud produce un `400 Bad Request` con `{"errors":{"$.startedAt":["The JSON value could not be converted to System.DateTime..."]}}`. El `Path: $.startedAt` de la excepción interna acaba en el diccionario `errors`. Si solo ves "One or more validation errors occurred", revisa el cuerpo de la respuesta, la ruta ofensiva está ahí.

### Los source generators ocultan el registro del conversor

Cuando optas por la generación de código fuente de `System.Text.Json` con `[JsonSerializable]` y un `JsonSerializerContext`, debes registrar conversores en el mismo contexto, no solo en un `JsonSerializerOptions` en tiempo de ejecución. El generador emite `TypeInfo` para cada tipo raíz en tiempo de compilación, y un conversor que olvidaste cablear en el contexto es invisible en tiempo de ejecución. El [post sobre interceptors y generación de código fuente](/es/2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics/) recorre la forma de registro que sobrevive al trimming y AOT.

### Zona horaria embebida en el nombre de la propiedad, no en el valor

Un esquema como `{"startedAtUtc": "2026-05-08T14:00:00"}` (sin `Z`, pero el nombre de la propiedad afirma UTC) parsea a `DateTimeKind.Unspecified`. No lanza, pero hace round-trip mal: `ToUniversalTime` lo tratará como local. O arregla el productor para emitir la `Z`, o usa `DateTimeOffset` para que el offset sea explícito. Mejor aún, modela el valor como `DateTime` con un conversor que afirme `Kind == Utc` y lance ante cualquier otra cosa, el patrón de conversor estricto detecta la deriva temprano.

## Variantes que parecen este error pero no lo son

### "The JSON value could not be converted to System.DateTimeOffset"

Misma familia de causa raíz, dominio ligeramente distinto. `DateTimeOffset` requiere un offset explícito (`Z` o `+hh:mm`) y rechaza cadenas con forma `Unspecified` que un `DateTime` desnudo aceptaría. La solución tiene la misma forma: envía el offset, o escribe un conversor. Evita hacer round-trip de un `DateTimeOffset` a través de un `DateTime` si tienes uno en el dominio, la información del offset es dato.

### "Cannot get the value of a token type 'Number' as a String"

Excepción distinta, stack distinto. Significa que el conversor o el lector por defecto llamó a `GetString()` sobre un token JSON `Number`. La solución es bifurcar según `reader.TokenType` antes de leer. El conversor de la variante 3 de arriba es la forma canónica.

### "A possible object cycle was detected"

Ciclo de referencias, no parseo de fechas. Establece `ReferenceHandler = ReferenceHandler.IgnoreCycles` (o `Preserve` para round-trip completo del grafo) en las opciones. Recorre las concesiones en [la guía de manejo de ciclos](/es/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) (el mismo post sobre conversores cubre la opción de ciclos en su sección de gotchas).

### "The JSON value could not be converted to System.Guid"

Clase de excepción idéntica (`JsonException`), forma de mensaje idéntica, tipo destino distinto. La causa es similar: la cadena Guid no está en ninguno de los cuatro formatos que `System.Text.Json` acepta (`D`, `N`, `B`, `P`). La solución es de nuevo o arreglar el productor para enviar `D` (la forma con guiones) o escribir un conversor que llame a `Guid.ParseExact`.

### "The JSON value could not be converted to System.Enum"

Misma familia. La solución es `JsonStringEnumConverter` (integrado) registrado en las opciones; el conversor acepta tanto formas numéricas como de cadena y es configurable para sensibilidad a mayúsculas. También es posible por enum con `[JsonConverter(typeof(JsonStringEnumConverter<MyEnum>))]` desde .NET 8 en adelante, lo que es preferible bajo trimming porque no reflexiona sobre cada enum del ensamblado.

## Relacionado

Para el andamiaje del conversor en el que se apoyan las soluciones de arriba, el [recorrido por JsonConverter personalizado](/es/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) cubre los trucos de parseo con span de bytes para hot paths. El [post sobre nombrado por miembro PascalCase](/es/2026/04/system-text-json-11-pascalcase-per-member-naming/) muestra los escapes `[JsonPropertyName]` y de política de nombres que resuelven los errores 400 relacionados de "nombre de propiedad incorrecto". Si tu DateTime se persiste como columna JSON en EF Core 11, el [recorrido por JSON contains de SQL Server 2025](/es/2026/04/efcore-11-json-contains-sql-server-2025/) explica cómo la base de datos hace round-trip de la misma cadena ISO 8601. Para el diagnóstico paralelo de "tipo incorrecto" con implicaciones de grafo más grandes, el [trayecto de migración de Newtonsoft a System.Text.Json](/es/2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4/) es el caso de estudio canónico del propio equipo de .NET.

## Fuentes

- [DateTime and DateTimeOffset support in System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/datetime/system-text-json-support), Microsoft Learn.
- [How to write custom converters](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/converters-how-to), Microsoft Learn.
- [`DateTimeStyles` enumeration](https://learn.microsoft.com/en-us/dotnet/api/system.globalization.datetimestyles), Microsoft Learn.
- [`DateTimeOffset.FromUnixTimeSeconds`](https://learn.microsoft.com/en-us/dotnet/api/system.datetimeoffset.fromunixtimeseconds), Microsoft Learn.
- [System.Text.Json source repository](https://github.com/dotnet/runtime/tree/main/src/libraries/System.Text.Json), dotnet/runtime on GitHub.
- [`DateOnly` and `TimeOnly` types](https://learn.microsoft.com/en-us/dotnet/api/system.dateonly), Microsoft Learn.
