---
title: "Solución: Reflection-based serialization has been disabled for this application"
description: "Esta InvalidOperationException significa que PublishTrimmed o PublishAot pusieron JsonSerializerIsReflectionEnabledByDefault en false. Se soluciona con un JsonSerializerContext generado."
pubDate: 2026-07-29
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "trimming"
  - "native-aot"
lang: "es"
translationOf: "2026/07/fix-reflection-based-serialization-has-been-disabled-for-this-application"
translatedBy: "claude"
translationDate: 2026-07-29
---

Tu proyecto tiene `PublishTrimmed` o `PublishAot` en `true`, y el SDK de .NET respondió poniendo `JsonSerializerIsReflectionEnabledByDefault` en `false`. Eso desactiva el resolvedor de contratos basado en reflexión del que `JsonSerializer.Serialize(obj)` depende en silencio. La solución es darle al serializador una fuente de contratos: agrega una `partial class` que derive de `JsonSerializerContext`, anótala con `[JsonSerializable(typeof(YourType))]` y pasa `MyContext.Default.YourType` (o asigna `options.TypeInfoResolver = MyContext.Default`) en cada punto de llamada.

```text
System.InvalidOperationException: Reflection-based serialization has been disabled for this application. Either use the source generator APIs or explicitly configure the 'JsonSerializerOptions.TypeInfoResolver' property.
   at System.Text.Json.ThrowHelper.ThrowInvalidOperationException_JsonSerializerIsReflectionDisabled()
   at System.Text.Json.JsonSerializerOptions.ConfigureForJsonSerializer()
   at System.Text.Json.JsonSerializerOptions.GetTypeInfoForRootType(Type type, Boolean fallBackToNearestAncestorType)
   at System.Text.Json.JsonSerializer.Serialize[TValue](TValue value, JsonSerializerOptions options)
   at MyApp.Program.Main(String[] args)
```

El texto exacto viene del recurso `JsonSerializerIsReflectionDisabled` de `System.Text.Json`, y está redactado igual desde .NET 8. Todo lo que sigue apunta al SDK de .NET 11 (`11.0.100`) y C# 14, pero el comportamiento es idéntico en `net8.0` y posteriores, porque ahí fue cuando se introdujo el interruptor.

## Por qué un proyecto que nunca configuraste tiene la reflexión desactivada

`System.Text.Json` resuelve la forma de un tipo de dos maneras: en tiempo de ejecución con reflexión (`DefaultJsonTypeInfoResolver`), o en tiempo de compilación con el generador de código fuente (`JsonSerializerContext`). Cuando llamas a `JsonSerializer.Serialize(obj)` sin opciones, recae en el resolvedor por reflexión.

La reflexión no sobrevive al recorte. El trimmer elimina los miembros cuya accesibilidad no puede demostrar, y los getters de propiedades que solo se invocan a través de `PropertyInfo` son exactamente eso: inaccesibles para el análisis estático. Antes de .NET 8, una aplicación recortada serializaba tan campante y simplemente descartaba en silencio las propiedades que el trimmer había borrado. La pérdida silenciosa de datos es peor que un fallo, así que .NET 8 cambió el valor por defecto: poner `PublishTrimmed` en `true` [pone automáticamente `JsonSerializerIsReflectionEnabledByDefault` en `false`](https://learn.microsoft.com/en-us/dotnet/core/compatibility/serialization/8.0/publishtrimmed) salvo que indiques lo contrario. `PublishAot` implica `PublishTrimmed`, así que las aplicaciones Native AOT heredan el mismo valor por defecto.

La propiedad de MSBuild no es el mecanismo, solo el interruptor. El SDK la convierte en una opción de configuración del host de runtime:

```xml
<!-- Microsoft.NET.Sdk.targets, .NET 11 SDK -->
<RuntimeHostConfigurationOption Include="System.Text.Json.JsonSerializer.IsReflectionEnabledByDefault"
                                Condition="'$(JsonSerializerIsReflectionEnabledByDefault)' != ''"
                                Value="$(JsonSerializerIsReflectionEnabledByDefault)"
                                Trim="true" />
```

Eso aterriza en tu `.runtimeconfig.json` como un interruptor de `AppContext`, y `Trim="true"` le indica a ILLink que lo trate como una constante de tiempo de enlace, de modo que las rutas de código con reflexión se puedan eliminar por completo. `JsonSerializer.IsReflectionEnabledByDefault` lee ese interruptor y [vale `true` por defecto cuando no está definido](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializer.isreflectionenabledbydefault).

De esto se derivan dos cosas que explican la mayoría de los reportes de error confusos. Primero, el interruptor es por aplicación, no por biblioteca: un paquete NuGet no puede desactivarlo por ti, y tú no puedes activarlo para un solo ensamblado. Segundo, la excepción ocurre en el primer uso, no al iniciar. `JsonSerializerOptions.Default` se construye con `JsonTypeInfoResolver.Empty` en lugar del resolvedor por reflexión, y `ConfigureForJsonSerializer` solo lanza la excepción cuando una llamada de serialización o deserialización encuentra un resolvedor vacío. Así que la ruta de código que se ejecuta una vez por semana es donde te vas a enterar.

## La reproducción mínima

Tres líneas de archivo de proyecto y una línea de C#:

```xml
<!-- MyApp.csproj, .NET 11 SDK 11.0.100 -->
<PropertyGroup>
  <TargetFramework>net11.0</TargetFramework>
  <PublishTrimmed>true</PublishTrimmed>
</PropertyGroup>
```

```csharp
// .NET 11, C# 14
using System.Text.Json;

var json = JsonSerializer.Serialize(new { Value = 42 });
// System.InvalidOperationException: Reflection-based serialization has been disabled...
```

Fíjate dónde vive `PublishTrimmed`. Como la propiedad fluye hacia `runtimeconfig.json` en tiempo de **compilación**, ponerla en el archivo de proyecto hace que `dotnet run` en Debug también lance la excepción. Si en cambio solo la pasas en la línea de comandos de publicación (`dotnet publish -p:PublishTrimmed=true`), tu `dotnet run` local sigue funcionando y solo falla el artefacto publicado, que es la versión de este error que llega a producción. La documentación de recorte recomienda el archivo de proyecto [precisamente para que el ajuste se aplique durante `dotnet build`](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/trimming-options).

Para confirmar que estás viendo esto y no otra cosa, revisa la salida de compilación:

```bash
cat bin/Debug/net11.0/MyApp.runtimeconfig.json
```

```json
{
  "runtimeOptions": {
    "tfm": "net11.0",
    "configProperties": {
      "System.Text.Json.JsonSerializer.IsReflectionEnabledByDefault": false
    }
  }
}
```

O compruébalo desde el código, lo cual también funciona con Native AOT, donde no hay archivo runtimeconfig que leer:

```csharp
// .NET 11, C# 14
Console.WriteLine(JsonSerializer.IsReflectionEnabledByDefault); // False
```

## Solución 1: incluye un JsonSerializerContext y úsalo en todas partes

Esta es la solución que pide el mensaje de error y la única que te deja con una aplicación realmente segura frente al recorte. Declara un contexto parcial, lista cada tipo raíz que serialices y enruta las llamadas a través de él.

```csharp
// .NET 11, C# 14, System.Text.Json 11.0.0
using System.Text.Json;
using System.Text.Json.Serialization;

public record WeatherForecast(DateOnly Date, int TemperatureC, string? Summary);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(WeatherForecast))]
[JsonSerializable(typeof(List<WeatherForecast>))]
internal partial class AppJsonContext : JsonSerializerContext;
```

Luego elige una de las tres formas de llamada soportadas:

```csharp
// .NET 11, C# 14
// 1. Strongly typed, zero options plumbing. Preferred.
string json = JsonSerializer.Serialize(forecast, AppJsonContext.Default.WeatherForecast);
WeatherForecast? back = JsonSerializer.Deserialize(json, AppJsonContext.Default.WeatherForecast);

// 2. Through options, when an API forces you to hand it a JsonSerializerOptions.
var options = new JsonSerializerOptions { TypeInfoResolver = AppJsonContext.Default };
json = JsonSerializer.Serialize(forecast, options);

// 3. Non-generic, when the type is only known at runtime.
json = JsonSerializer.Serialize(forecast, typeof(WeatherForecast), AppJsonContext.Default);
```

Define tus opciones en `[JsonSourceGenerationOptions]` en lugar de en una instancia de `JsonSerializerOptions` siempre que puedas. Así la propiedad `Default` generada queda preconfigurada en tiempo de compilación, y no puedes olvidarte de aplicar la política de nombres en uno de seis puntos de llamada. Las colecciones necesitan su propia entrada `[JsonSerializable]` (`List<WeatherForecast>` arriba), y los miembros declarados como `object` necesitan que registres cada tipo posible en tiempo de ejecución, porque el generador no tiene nada más de donde deducirlo.

## Solución 2: conecta el contexto con ASP.NET Core, HttpClient y Blazor

La mayoría de las aplicaciones no llaman a `JsonSerializer` directamente. Le pasan un tipo a un método del framework que lo llama por ellas, y esos necesitan que el resolvedor se instale una sola vez al inicio.

Para minimal APIs, incluida la plantilla de Native AOT que usa `CreateSlimBuilder`:

```csharp
// .NET 11, ASP.NET Core 11
var builder = WebApplication.CreateSlimBuilder(args);

builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.TypeInfoResolverChain.Insert(0, AppJsonContext.Default);
});
```

Para controladores de MVC y Web API:

```csharp
// .NET 11, ASP.NET Core 11
builder.Services.AddControllers().AddJsonOptions(static options =>
    options.JsonSerializerOptions.TypeInfoResolverChain.Add(AppJsonContext.Default));
```

Para `HttpClient`, usa las sobrecargas que reciben un `JsonTypeInfo<T>` en lugar de las que lo infieren:

```csharp
// .NET 11, C# 14
var forecast = await client.GetFromJsonAsync("/weather", AppJsonContext.Default.WeatherForecast);
await client.PostAsJsonAsync("/weather", forecast, AppJsonContext.Default.WeatherForecast);
```

`TypeInfoResolverChain` merece conocerse por sí mismo: las opciones consultan cada resolvedor en orden y toman el primer resultado no nulo, así que puedes componer varios contextos de distintos proyectos con `JsonTypeInfoResolver.Combine(ContextA.Default, ContextB.Default)` o insertar uno por delante del propio framework.

## Solución 3: vuelve a habilitar la reflexión en el punto de llamada, sin tocar MSBuild

El mensaje de error ofrece una segunda salida: "explicitly configure the `JsonSerializerOptions.TypeInfoResolver` property". El resolvedor por reflexión sigue siendo un tipo público, y construirlo no comprueba el interruptor:

```csharp
// .NET 11, C# 14. Works in a trimmed app. Does NOT work under Native AOT.
var options = new JsonSerializerOptions
{
    TypeInfoResolver = new DefaultJsonTypeInfoResolver()
};
string json = JsonSerializer.Serialize(new { Value = 42 }, options);
```

Entiende lo que estás comprando. La excepción desaparece porque pediste reflexión por su nombre, pero el trimmer ya borró los miembros que consideró sin uso. Obtienes una serialización que se ejecuta y emite en silencio un objeto incompleto, que es exactamente el modo de fallo que el cambio de .NET 8 existía para evitar. Con Native AOT es peor: `DefaultJsonTypeInfoResolver` está anotado con `[RequiresDynamicCode]`, así que cambias `InvalidOperationException` por un `PlatformNotSupportedException` o un fallo por metadatos faltantes en tiempo de ejecución. Trata esto como un paso de diagnóstico (¿sobrevive mi carga útil al recorte?) y no como una solución.

El patrón que sí resulta útil es el resolvedor condicional, que la documentación recomienda para bibliotecas que deben funcionar en ambos mundos:

```csharp
// .NET 11, C# 14
static JsonSerializerOptions CreateDefaultOptions() => new()
{
    TypeInfoResolver = JsonSerializer.IsReflectionEnabledByDefault
        ? new DefaultJsonTypeInfoResolver()
        : AppJsonContext.Default
};
```

Como `IsReflectionEnabledByDefault` se sustituye por una constante de tiempo de enlace, ILLink pliega la rama y nunca ancla el resolvedor por reflexión en una compilación AOT.

## Solución 4: vuelve a activar el interruptor, y cuándo eso se defiende

Puedes restaurar el comportamiento de .NET 7 con una sola propiedad:

```xml
<!-- MyApp.csproj, .NET 11 SDK -->
<PropertyGroup>
  <PublishTrimmed>true</PublishTrimmed>
  <JsonSerializerIsReflectionEnabledByDefault>true</JsonSerializerIsReflectionEnabledByDefault>
</PropertyGroup>
```

Haz esto cuando una dependencia de terceros llame a `JsonSerializer.Serialize` sobre sus propios tipos en lo profundo de su propio código y no incluya ningún `JsonSerializerContext`. No puedes reescribir sus puntos de llamada, y un generador de código fuente en tu ensamblado no ayuda, porque el resolvedor tiene que estar adjunto a la instancia de opciones que la biblioteca crea. Varios paquetes muy usados han chocado con esto: generó reportes de error contra el proveedor de Azure App Configuration y contra el endpoint de Swagger UI de ASP.NET Core, entre otros.

Dos advertencias. Primero, esto reintroduce la pérdida silenciosa de datos: el resolvedor por reflexión se ejecutará, pero solo sobre los miembros que sobrevivieron al recorte, así que prueba el artefacto publicado real contra cargas útiles reales en lugar de confiar en un `dotnet run` que pasa. Segundo, si estás en Native AOT, cambiar esta propiedad no hace que la reflexión funcione; solo quita la barrera de protección que te estaba diciendo la verdad a tiempo.

## Trampas que llevan a la solución equivocada

**El siguiente error es `NoMetadataForType`.** Después de agregar un contexto, un tipo que olvidaste anotar lanza `JsonTypeInfo metadata for type 'X' was not provided by TypeInfoResolver of type 'Y'`. Eso es progreso, no una regresión: nombra el tipo que falta. Agrégale un `[JsonSerializable(typeof(X))]`, incluidos los tipos de colección y cada subtipo que serialices de forma polimórfica. Si usas `[JsonDerivedType]`, cada tipo derivado necesita su propia entrada, algo que la guía de [serialización polimórfica con `JsonDerivedType`](/es/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/) cubre en detalle.

**No hay advertencia en tiempo de compilación.** La petición obvia, un analizador que marque `JsonSerializer.Serialize(x)` cuando el interruptor está apagado, se registró como [dotnet/runtime#107440](https://github.com/dotnet/runtime/issues/107440) y se cerró como no planificada. Las advertencias de análisis de recorte (`IL2026`, `IL3050`) sí apuntarán a la serialización por reflexión en tu propio código, así que trata una compilación limpia de análisis de recorte como lo más parecido a una comprobación en tiempo de compilación. Llegar ahí es el tema de [escribir código seguro frente al recorte](/es/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/).

**En .NET MAUI solo se reproduce en Release, o solo en el dispositivo.** MAUI define las propiedades de recorte por ti: Android y Mac Catalyst usan recorte parcial en compilaciones Release, e iOS lo usa en cualquier compilación para dispositivo sin importar la configuración, mientras que las compilaciones para simulador no se recortan en absoluto. Así que "funciona en el simulador, falla en un iPhone real" y "funciona en Debug, falla en Release" son el mismo error. No definas `PublishTrimmed` tú mismo en un proyecto MAUI; el SDK es su dueño.

**Una `PlatformNotSupportedException` es un error distinto.** Si tu traza de pila menciona `Reflection.Emit` o compilación de árboles de expresión en lugar de `ConfigureForJsonSerializer`, estás viendo la ausencia del JIT en AOT, no el interruptor de JSON. Eso se cubre en el artículo sobre [`PlatformNotSupportedException` en Native AOT](/es/2026/05/fix-platformnotsupportedexception-in-native-aot/).

**El `JsonStringEnumConverter` no genérico no está soportado en AOT.** Una vez que estés con generación de código fuente, reemplázalo por `JsonStringEnumConverter<TEnum>` sobre el enum, o define `UseStringEnumConverter = true` en `[JsonSourceGenerationOptions]`. La misma restricción aplica a los convertidores escritos a mano, algo que conviene revisar frente a las reglas para [escribir un `JsonConverter` personalizado](/es/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/).

**Activarlo a propósito es una decisión válida.** Si quieres este error en una aplicación sin recorte para que las incompatibilidades con AOT salgan a la luz sobre CoreCLR durante el desarrollo, pon `JsonSerializerIsReflectionEnabledByDefault` en `false` tú mismo. Su comportamiento es consistente entre CoreCLR y Native AOT, que es justo lo que lo convierte en un buen sistema de alerta temprana. Ese uso independiente de la propiedad se cubre en la nota más antigua sobre [desactivar la serialización basada en reflexión](/es/2023/10/system-text-json-disable-reflection-based-serialization/).

## Relacionado

- [¿Qué es el código seguro frente al recorte y cómo se escribe?](/es/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/)
- [¿Qué es Native AOT y cuánto te cuesta?](/es/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [Solución: PlatformNotSupportedException en Native AOT](/es/2026/05/fix-platformnotsupportedexception-in-native-aot/)
- [Cómo serializar una jerarquía de tipos polimórfica con JsonDerivedType](/es/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/)
- [Cómo usar Native AOT con minimal APIs de ASP.NET Core](/es/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)

## Fuentes

- [Breaking change: PublishTrimmed projects fail reflection-based serialization](https://learn.microsoft.com/en-us/dotnet/core/compatibility/serialization/8.0/publishtrimmed) - MS Learn
- [How to use source generation in System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation), incluida la sección "Disable reflection defaults" - MS Learn
- [Propiedad JsonSerializer.IsReflectionEnabledByDefault](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializer.isreflectionenabledbydefault) - MS Learn
- [Trimming options](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/trimming-options) - MS Learn
- [Trim a .NET MAUI app](https://learn.microsoft.com/en-us/dotnet/maui/deployment/trimming), por los valores por defecto de recorte por plataforma - MS Learn
- [System.Text.Json analyzers should warn about using reflection when reflection is disabled](https://github.com/dotnet/runtime/issues/107440) - dotnet/runtime
- [`JsonSerializerOptions.ConfigureForJsonSerializer`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Text.Json/src/System/Text/Json/Serialization/JsonSerializerOptions.cs) y el recurso de texto `JsonSerializerIsReflectionDisabled` - dotnet/runtime
