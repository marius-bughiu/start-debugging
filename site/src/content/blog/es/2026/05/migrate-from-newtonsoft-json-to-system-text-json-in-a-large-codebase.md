---
title: "Migrar de Newtonsoft.Json 13 a System.Text.Json en una base de código grande de .NET 11"
description: "Una guía con versiones fijadas para reemplazar Newtonsoft.Json 13.0.4 por el System.Text.Json integrado en .NET 11: los mapeos de atributos y opciones, los valores predeterminados que cambian en silencio tu formato de salida, una estrategia de despliegue por etapas, la verificación y los problemas que afectan a las bases de código grandes."
pubDate: 2026-05-30
updatedDate: 2026-05-30
template: migration
tags:
  - "migration"
  - "newtonsoft-json"
  - "system-text-json"
  - "dotnet-11"
lang: "es"
translationOf: "2026/05/migrate-from-newtonsoft-json-to-system-text-json-in-a-large-codebase"
translatedBy: "claude"
translationDate: 2026-05-30
---

Reemplazar `Newtonsoft.Json` por `System.Text.Json` en una base de código grande rara vez es un trabajo de buscar y reemplazar. Las dos bibliotecas difieren en sus valores predeterminados de maneras que cambian tu salida serializada y rompen la deserialización en silencio, así que un reemplazo ingenuo envía un cambio de contrato a cada consumidor de tu JSON. Reserva unos días para un servicio pequeño y de dos a cuatro semanas para una base de código extensa con convertidores personalizados, payloads polimórficos y análisis con `dynamic`/`JObject`. La ganancia es real: `System.Text.Json` se incluye de fábrica con el runtime, serializa aproximadamente el doble de rápido con una fracción de las asignaciones, y es el único de los dos que se ejecuta bajo Native AOT. Este artículo fija `Newtonsoft.Json` 13.0.4 (la versión estable actual, lanzada el 2025-12-30) como origen y el `System.Text.Json` integrado en el .NET 11 SDK con C# 14 como destino. Si todavía estás decidiendo si moverte o no, lee primero [System.Text.Json vs Newtonsoft.Json en 2026](/es/2026/05/system-text-json-vs-newtonsoft-json-in-2026/); este artículo asume que ya decidiste migrar.

## Por qué migrar ahora

- `System.Text.Json` forma parte del framework compartido en .NET 11. Eliminar el `PackageReference` de `Newtonsoft.Json` quita una dependencia transitiva que el runtime, ASP.NET Core y la plataforma de pruebas han estado desprendiendo activamente.
- Throughput. En payloads POCO típicos, `System.Text.Json` serializa alrededor de 2x más rápido que `Newtonsoft.Json` con asignaciones marcadamente menores, porque trabaja directamente sobre bytes UTF-8 con `Utf8JsonReader` y `Utf8JsonWriter` en lugar de pasar por `string` y `TextReader`.
- Native AOT y trimming. `Newtonsoft.Json` depende de la reflexión y no funciona bajo Native AOT. `System.Text.Json` tiene un modo de generador de código fuente (`JsonSerializerContext`) que emite metadatos de serialización compatibles con AOT y seguros para el trimming en tiempo de compilación. Si [Native AOT](/es/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) está en tu hoja de ruta, esta migración es un prerrequisito, no una optimización.
- Postura de seguridad. `System.Text.Json` es estricto por defecto (RFC 8259), escapa caracteres sensibles a HTML y no ASCII en la salida, y no interpreta JSON mal formado. Eso elimina una clase de sorpresas de inyección y análisis que los valores predeterminados permisivos de `Newtonsoft.Json` permiten.

## Qué se rompe

El peligro de esta migración no es el código que no compila. Es el código que compila bien y cambia tu formato de salida. Esta tabla es la que hay que leer dos veces.

| Área                              | Cambio                                                                                         | Severidad |
| --------------------------------- | ---------------------------------------------------------------------------------------------- | --------- |
| Coincidencia de nombres de propiedad | `Newtonsoft.Json` no distingue mayúsculas al leer por defecto; `System.Text.Json` sí distingue | alta      |
| Comentarios y comas finales       | Aceptados por defecto en `Newtonsoft.Json`, lanzan `JsonException` en `System.Text.Json`        | alta      |
| JSON con comillas simples / sin comillas | Aceptado por `Newtonsoft.Json`, rechazado por diseño en `System.Text.Json`               | alta      |
| Valor no-string en propiedad `string` | `Newtonsoft.Json` convierte `1` o `true`; `System.Text.Json` lanza una excepción           | alta      |
| Números entre comillas            | `Newtonsoft.Json` lee `"23"` en un `int`; `System.Text.Json` necesita `NumberHandling`          | media     |
| Escape de caracteres              | `System.Text.Json` escapa de forma más agresiva, así que los bytes de salida difieren para no-ASCII y HTML | media |
| `[JsonProperty("name")]`          | Se convierte en `[JsonPropertyName("name")]`; no hay opciones combinadas de ignore/required en un atributo | media |
| `TypeNameHandling.All`            | No hay equivalente, por diseño. El polimorfismo usa `[JsonDerivedType]` en su lugar             | alta      |
| `JObject` / `JToken` / `dynamic`  | Reemplazados por `JsonNode` / `JsonDocument` / `JsonElement` con una API diferente              | media     |
| `JsonConvert.PopulateObject`      | No hay equivalente integrado; necesita un convertidor personalizado o una fusión manual         | media     |
| `ReferenceLoopHandling.Ignore`    | No hay modo "descartar el bucle en silencio"; obtienes `ReferenceHandler.Preserve` o rediseñas el grafo | media |
| `DateFormatString`, `DateTimeZoneHandling` | No hay opción global de formato de fecha; necesita un `JsonConverter<DateTime>` personalizado | media |
| Precedencia de registro de convertidores | La colección `Converters` ahora anula un atributo a nivel de tipo (invertido respecto a `Newtonsoft.Json`) | baja |

La referencia autoritativa para cada fila aquí es la [guía de migración de Microsoft](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/migrate-from-newtonsoft), que también lista el puñado de características (consultas `JsonPath`, `TypeNameHandling.All`, análisis de comillas simples) que no tienen solución alternativa.

## Lista de comprobación previa

Haz todo esto antes de borrar un solo `using Newtonsoft.Json`.

1. Fija el contrato. Si tu JSON cruza un límite de proceso (una API pública, una cola de mensajes, una columna persistida), captura muestras de referencia de la salida actual. Serializa un conjunto representativo de objetos con `Newtonsoft.Json` 13.0.4 y guarda las cadenas como fixtures de prueba. Estas son tu oráculo de regresión.
2. Inventaría la superficie. Busca con grep todo lo que toque la biblioteca antigua para conocer el tamaño del trabajo:
   ```bash
   # run from the repo root; counts the call sites you have to touch
   grep -rEl "Newtonsoft\.Json|JsonConvert|JObject|JArray|JToken|JsonProperty|JsonSerializerSettings" --include="*.cs" .
   ```
   Verifica: la lista de archivos coincide con tu modelo mental de dónde vive la serialización. Las sorpresas aquí (un convertidor enterrado en un ayudante de registro) son exactamente lo que quieres encontrar ahora.
3. Marca las características sin solución alternativa. Busca específicamente `TypeNameHandling`, `SelectToken`, `SelectTokens` y fixtures de prueba con comillas simples. Si encuentras `TypeNameHandling.All` o `.Auto`, detente y diseña el reemplazo del polimorfismo antes de continuar, porque no hay un sustituto directo para ello.
4. Confirma el destino. Ejecuta `dotnet --version` y confirma `11.0.x`. `System.Text.Json` viene integrado, así que no hay paquete que agregar para los escenarios principales; solo agregas `System.Text.Json` como un `PackageReference` explícito si necesitas una versión out-of-band más nueva que la que incluye el SDK.

## Pasos de migración

1. **Mapea las opciones globales.**

   `Newtonsoft.Json` centraliza el comportamiento en `JsonSerializerSettings`. `System.Text.Json` usa `JsonSerializerOptions`. Traduce tu objeto de configuración existente campo por campo; no aceptes los valores predeterminados de `System.Text.Json` a ciegas, porque difieren de lo que tu código ha estado emitiendo durante años.

   ```csharp
   // .NET 11, C# 14
   // BEFORE: Newtonsoft.Json 13.0.4
   var settings = new JsonSerializerSettings
   {
       ContractResolver = new CamelCasePropertyNamesContractResolver(),
       NullValueHandling = NullValueHandling.Ignore,
       ReferenceLoopHandling = ReferenceLoopHandling.Ignore,
   };

   // AFTER: System.Text.Json (in-box on .NET 11)
   var options = new JsonSerializerOptions
   {
       PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
       PropertyNameCaseInsensitive = true,                       // restore Newtonsoft read behavior
       DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
       ReferenceHandler = ReferenceHandler.IgnoreCycles,         // closest match to ReferenceLoopHandling.Ignore
       // AllowTrailingCommas = true,                            // uncomment only if your inputs have them
       // ReadCommentHandling = JsonCommentHandling.Skip,        // uncomment only if your inputs have comments
   };
   ```

   Verifica: serializa tus objetos de muestra de referencia con estas `options` y compáralos con los fixtures del paso 1 del preflight. La diferencia debería estar vacía o explicada. `PropertyNameCaseInsensitive = true` es la línea más importante para las bases de código grandes, porque innumerables rutas de deserialización dependen silenciosamente de la coincidencia sin distinción de mayúsculas de `Newtonsoft.Json`.

2. **Reemplaza los atributos.**

   El renombrado de atributos es mecánico, pero `[JsonProperty]` empaquetaba varias responsabilidades en un solo atributo que `System.Text.Json` separa.

   ```csharp
   // .NET 11, C# 14
   // BEFORE
   public class Order
   {
       [JsonProperty("order_id")]
       public int Id { get; set; }

       [JsonProperty("notes", NullValueHandling = NullValueHandling.Ignore)]
       public string? Notes { get; set; }

       [JsonProperty(Required = Required.Always)]
       public string Customer { get; set; } = "";

       [JsonIgnore]
       public string Internal { get; set; } = "";
   }

   // AFTER
   public class Order
   {
       [JsonPropertyName("order_id")]
       public int Id { get; set; }

       [JsonPropertyName("notes")]
       [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
       public string? Notes { get; set; }

       [JsonRequired]                       // or the C# `required` modifier
       public string Customer { get; set; } = "";

       [JsonIgnore]
       public string Internal { get; set; } = "";
   }
   ```

   Verifica: el proyecto compila con cero directivas `using` de `Newtonsoft.Json` en el ensamblado de modelos, y una prueba de ida y vuelta (`Deserialize(Serialize(order))`) preserva cada campo.

3. **Porta los convertidores personalizados.**

   Aquí es donde se van las horas. Las formas son similares pero los contratos difieren: los convertidores de `System.Text.Json` trabajan sobre `Utf8JsonReader` (un `ref struct`) y `Utf8JsonWriter`, y `Read` se llama posicionado en el primer token.

   ```csharp
   // .NET 11, C# 14 -- a converter that reads/writes DateTime in a fixed format,
   // replacing Newtonsoft's DateFormatString / DateTimeZoneHandling settings.
   public sealed class Iso8601DateTimeConverter : JsonConverter<DateTime>
   {
       public override DateTime Read(ref Utf8JsonReader reader, Type type, JsonSerializerOptions o)
           => DateTime.ParseExact(reader.GetString()!, "yyyy-MM-dd'T'HH:mm:ss'Z'",
                                  CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal);

       public override void Write(Utf8JsonWriter writer, DateTime value, JsonSerializerOptions o)
           => writer.WriteStringValue(value.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'",
                                      CultureInfo.InvariantCulture));
   }
   ```

   Regístralo en `options.Converters`, no solo como un atributo de tipo, y nota el cambio de precedencia: en `System.Text.Json` un convertidor en la colección `Converters` anula un atributo `[JsonConverter]` a nivel de tipo, lo contrario de `Newtonsoft.Json`. Los detalles mecánicos están en [cómo escribir un JsonConverter personalizado en System.Text.Json](/es/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/). Verifica cada convertidor portado contra su propio fixture, no solo el payload de extremo a extremo, para que una sorpresa de precedencia no se esconda detrás de una prueba de integración que pasa.

4. **Reemplaza el polimorfismo y TypeNameHandling.**

   Si usabas `TypeNameHandling` para hacer un ida y vuelta de una jerarquía de clases, no hay equivalente, y eso es deliberado: `TypeNameHandling.All` es un vector de ejecución remota de código bien conocido. `System.Text.Json` hace polimorfismo discriminado con atributos en el tipo base.

   ```csharp
   // .NET 11, C# 14
   [JsonDerivedType(typeof(Dog), typeDiscriminator: "dog")]
   [JsonDerivedType(typeof(Cat), typeDiscriminator: "cat")]
   public abstract class Animal { public string Name { get; set; } = ""; }

   public sealed class Dog : Animal { public bool GoodBoy { get; set; } }
   public sealed class Cat : Animal { public int Lives { get; set; } }
   ```

   Esto emite un discriminador `"$type": "dog"` y lo lee de vuelta al subtipo correcto. Verifica: serializa una `List<Animal>` de subtipos mezclados, deserialízala y comprueba que los tipos en tiempo de ejecución sobreviven. Nota que el formato de salida cambió (una cadena discriminadora explícita en lugar del `$type` calificado por ensamblado de `Newtonsoft.Json`), así que cualquier consumidor externo debe actualizarse al mismo tiempo.

5. **Convierte el análisis con dynamic y JObject.**

   El código que hurga en JSON sin tipo vía `JObject`/`JToken`/`dynamic` pasa a `JsonNode` (mutable) o `JsonDocument`/`JsonElement` (de solo lectura, agrupado en un pool).

   ```csharp
   // .NET 11, C# 14
   // BEFORE: JObject o = JObject.Parse(json); var name = (string)o["user"]!["name"]!;
   JsonNode root = JsonNode.Parse(json)!;
   string name = root["user"]!["name"]!.GetValue<string>();
   ```

   La única trampa: `JsonDocument` posee un búfer agrupado en un pool y es `IDisposable`, a diferencia de `JObject`. Envuélvelo en un `using` o filtrarás el búfer alquilado. Prefiere `JsonNode` cuando necesites un árbol mutable parecido a `JObject`. Verifica: cada antigua ruta de acceso a `JObject` tiene una prueba unitaria que ejercita las mismas búsquedas de clave.

6. **Cambia la integración de ASP.NET Core.**

   Si la base de código llama a `AddNewtonsoftJson()` en `Program.cs`, eliminarlo conmuta todo el pipeline a `System.Text.Json`. Los valores predeterminados web de ASP.NET Core ya habilitan camelCase, la coincidencia sin distinción de mayúsculas y la lectura de números entre comillas, así que muchas de tus opciones manuales se vuelven redundantes en la ruta MVC.

   ```csharp
   // .NET 11, C# 14
   // BEFORE: builder.Services.AddControllers().AddNewtonsoftJson();
   builder.Services.AddControllers().AddJsonOptions(o =>
   {
       o.JsonSerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
       // camelCase + case-insensitive are already on by ASP.NET Core web defaults
   });
   ```

   Atención al límite de profundidad: ASP.NET Core limita `MaxDepth` de `System.Text.Json` a 32, no al valor predeterminado de la biblioteca de 64. Los payloads profundamente anidados que funcionaban con `AddNewtonsoftJson()` pueden empezar a lanzar excepciones. Verifica: ejecuta las pruebas de integración del controlador y confirma que ningún payload supera el límite de profundidad.

## Verificación

Ejecuta esta lista de pruebas de humo después de cada PR, no solo al final:

- La solución compila con cero referencias a `Newtonsoft.Json` en los proyectos migrados (`grep -r "Newtonsoft" --include="*.csproj"` no devuelve nada para esos proyectos).
- La diferencia de muestras de referencia del paso 1 del preflight está vacía o cada diferencia está documentada y es intencional.
- Toda la suite de pruebas pasa: `dotnet test` informa cero fallos.
- Una prueba de ida y vuelta (`Deserialize(Serialize(x))`) se cumple para cada modelo con un convertidor personalizado o una jerarquía polimórfica.
- Para las rutas calientes, ejecuta una comparación rápida con `BenchmarkDotNet` y confirma que los números de throughput y asignaciones se movieron en la dirección correcta en lugar de retroceder por un accidental `new JsonSerializerOptions()` por llamada (siempre cachea y reutiliza la instancia de options; construirla en cada llamada es la regresión de rendimiento más común en esta migración).

## Plan de reversión

Esta migración es reversible por proyecto pero no trivialmente, porque el paso 1 cambia tu formato de salida. La estrategia limpia es un enfoque strangler: migra un ensamblado o un endpoint a la vez, mantén `Newtonsoft.Json` referenciado hasta que el último consumidor se haya movido, y protege los endpoints riesgosos detrás de un feature flag que pueda enrutar de vuelta al formateador de `Newtonsoft.Json`. Una vez que hayas borrado el `PackageReference` y enviado el nuevo formato de salida a los consumidores externos, revertir significa volver a agregar el paquete y deshacer el cambio de formato en todas partes a la vez, lo cual es una versión coordinada, no un `git revert`. No borres la referencia al paquete hasta que las diferencias de muestras de referencia hayan estado en verde en la telemetría de producción durante al menos un ciclo de versión.

## Problemas que encontramos

- **Pérdida silenciosa de datos por distinción de mayúsculas.** Un objeto de configuración deserializado de un archivo con claves `PascalCase` volvió con cada propiedad en su valor predeterminado porque `System.Text.Json` coincidió distinguiendo mayúsculas contra los miembros en camelCase. Nada lanzó una excepción. La solución fue `PropertyNameCaseInsensitive = true`, y la lección fue verificar valores, no solo si "se analizó".
- **Los ida y vuelta de `DateTime` se desviaron.** El `DateTimeZoneHandling` de `Newtonsoft.Json` había estado normalizando timestamps en silencio. `System.Text.Json` lee el formato de ida y vuelta ISO 8601 y preserva el offset, así que los timestamps almacenados volvieron con un kind diferente. El convertidor personalizado del paso 3 más la corrección de [el valor JSON no se pudo convertir a System.DateTime](/es/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) lo resolvió.
- **Los ciclos de objetos lanzaban excepciones en lugar de descartarse.** `ReferenceLoopHandling.Ignore` había estado enmascarando una referencia circular genuina en una propiedad de navegación de EF Core. `System.Text.Json` la sacó a la superficie como [se detectó un posible ciclo de objetos](/es/2026/05/fix-possible-object-cycle-was-detected-system-text-json/). `ReferenceHandler.IgnoreCycles` es el puente, pero la mejor solución fue un DTO de proyección que no tenía el bucle en absoluto.
- **Un `new JsonSerializerOptions()` por solicitud hundió el throughput.** Construir el objeto de options dentro de un handler caliente derrota la caché de metadatos interna y fue más lento que el código de `Newtonsoft.Json` que reemplazó. Cachea un `static readonly JsonSerializerOptions` y reutilízalo.

## Fuentes

- [Microsoft Learn: Migrar de Newtonsoft.Json a System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/migrate-from-newtonsoft)
- [Microsoft Learn: Cómo personalizar nombres y valores de propiedades](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/customize-properties)
- [Microsoft Learn: Serialización polimórfica con System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/polymorphism)
- [Microsoft Learn: Preservar referencias y manejar referencias circulares](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/preserve-references)
- [Newtonsoft.Json 13.0.4 en NuGet](https://www.nuget.org/packages/newtonsoft.json/)
