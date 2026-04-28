---
title: "Cómo usar Native AOT con APIs mínimas de ASP.NET Core"
description: "Un recorrido completo para .NET 11 sobre cómo enviar una API mínima de ASP.NET Core con Native AOT: PublishAot, CreateSlimBuilder, JSON con generador de código fuente, la limitación de AddControllers, advertencias IL2026 / IL3050, y EnableRequestDelegateGenerator para proyectos de biblioteca."
pubDate: 2026-04-27
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "native-aot"
lang: "es"
translationOf: "2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis"
translatedBy: "claude"
translationDate: 2026-04-29
---

Para enviar una API mínima de ASP.NET Core con Native AOT en .NET 11, pon `<PublishAot>true</PublishAot>` en el `.csproj`, construye el host con `WebApplication.CreateSlimBuilder` en lugar de `CreateBuilder`, y registra un generador de código fuente `JsonSerializerContext` a través de `ConfigureHttpJsonOptions` para que cada tipo de petición y respuesta sea alcanzable sin reflexión. Cualquier cosa que no sean APIs mínimas o gRPC, incluyendo `AddControllers`, Razor, hubs de SignalR, y árboles de consulta de EF Core sobre grafos de POCOs, producirá advertencias IL2026 o IL3050 al publicar y se comportará de forma impredecible en runtime. Esta guía recorre la ruta completa sobre `Microsoft.NET.Sdk.Web` con .NET 11 SDK y C# 14, incluyendo las partes que la plantilla de proyecto nuevo te oculta, y termina con una lista de verificación para confirmar que el binario publicado realmente no necesita el JIT.

## Las dos opciones de proyecto que lo cambian todo

Una API mínima Native AOT es un proyecto regular de ASP.NET Core con dos propiedades MSBuild añadidas. La primera cambia la ruta de publicación de CoreCLR a ILC, el compilador AOT. La segunda le dice al analizador que rompa tu build en el momento en que toques una API que requiera generación de código en runtime.

```xml
<!-- .NET 11, C# 14 -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>

    <PublishAot>true</PublishAot>
    <InvariantGlobalization>true</InvariantGlobalization>
  </PropertyGroup>
</Project>
```

`PublishAot` hace el trabajo pesado. Habilita la compilación Native AOT durante `dotnet publish` y, lo que es importante, también enciende el análisis de código dinámico durante el build y el editor, para que las advertencias IL2026 (`RequiresUnreferencedCode`) e IL3050 (`RequiresDynamicCode`) se iluminen en el IDE antes incluso de llegar a una publicación. Microsoft lo documenta en la [visión general del despliegue Native AOT](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/).

`InvariantGlobalization` no es estrictamente necesario, pero lo dejo activado para proyectos nuevos. Native AOT no incluye el archivo de datos ICU por defecto en Linux, y una comparación de cadenas sensible a la cultura sobre un payload de petición lanzará `CultureNotFoundException` en producción si lo olvidas. Envía la globalización explícitamente cuando realmente la necesites.

La plantilla de proyecto nuevo (`dotnet new webapiaot`) también añade `<StripSymbols>true</StripSymbols>` y `<TrimMode>full</TrimMode>` por ti. `TrimMode=full` está implícito en `PublishAot=true`, así que es redundante pero inofensivo conservarlo.

## CreateSlimBuilder no es CreateBuilder con nombre más corto

El cambio de comportamiento más grande entre una API mínima regular y una AOT es el host builder. `WebApplication.CreateBuilder` conecta cada característica común de ASP.NET Core: HTTPS, HTTP/3, filtros de hosting, ETW, proveedores de configuración basados en variables de entorno, y un serializador JSON por defecto que hace fallback basado en reflexión. Mucha de esa maquinaria no es compatible con Native AOT, así que la plantilla AOT usa `CreateSlimBuilder`, documentado en la referencia de [soporte de Native AOT en ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot?view=aspnetcore-10.0) y sin cambios en .NET 11.

```csharp
// .NET 11, C# 14
// PackageReference: Microsoft.AspNetCore.OpenApi 11.0.0
using System.Text.Json.Serialization;

var builder = WebApplication.CreateSlimBuilder(args);

builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.TypeInfoResolverChain.Insert(0, AppJsonContext.Default);
});

var app = builder.Build();

var todos = app.MapGroup("/todos");
todos.MapGet("/", () => Todo.Sample);
todos.MapGet("/{id:int}", (int id) =>
    Todo.Sample.FirstOrDefault(t => t.Id == id) is { } t
        ? Results.Ok(t)
        : Results.NotFound());

app.Run();

public record Todo(int Id, string Title, bool Done)
{
    public static readonly Todo[] Sample =
    [
        new(1, "Try Native AOT", true),
        new(2, "Profile cold start", false),
    ];
}

[JsonSerializable(typeof(Todo))]
[JsonSerializable(typeof(Todo[]))]
internal partial class AppJsonContext : JsonSerializerContext;
```

Tres cosas en ese ejemplo importan y son fáciles de pasar por alto:

1. `CreateSlimBuilder` no registra HTTPS ni HTTP/3 por defecto. El slim builder incluye configuración por archivo JSON para `appsettings`, secretos de usuario, registro por consola y configuración de logging, pero deja fuera intencionadamente protocolos típicamente manejados por un proxy de terminación TLS. Si ejecutas esto sin un Nginx, Caddy o YARP delante, añade configuración explícita de `Kestrel.Endpoints`.
2. `MapGroup("/todos")` está bien en el mismo archivo que `Program.cs`. Muévelo a otro archivo en el mismo proyecto y empezarás a ver IL3050 a menos que también enciendas el generador de delegados de petición. Llegamos a eso en un momento.
3. El context JSON se inserta en el índice `0` de la cadena de resolvers, así que tiene precedencia sobre el resolver basado en reflexión por defecto. Sin `Insert(0, ...)`, el writer de respuesta de ASP.NET Core puede aún caer en reflexión para tipos que no registraste, lo cual produce una `NotSupportedException` en runtime en modo AOT.

## JSON: el único serializador es el que generas

`System.Text.Json` tiene dos modos. El modo de reflexión recorre cada propiedad en runtime, lo cual es incompatible tanto con trimming como con AOT. El modo de generación de código fuente emite metadatos en tiempo de compilación para cada tipo registrado, lo cual es totalmente seguro para AOT. Native AOT requiere generación de fuente para cada tipo que pongas o saques de un cuerpo de petición HTTP. Esta es la mayor fuente de bugs "compila bien, lanza en runtime".

El `JsonSerializerContext` mínimo viable:

```csharp
// .NET 11, C# 14
using System.Text.Json.Serialization;

[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(Todo))]
[JsonSerializable(typeof(Todo[]))]
[JsonSerializable(typeof(List<Todo>))]
[JsonSerializable(typeof(ProblemDetails))]
internal partial class AppJsonContext : JsonSerializerContext;
```

Cada tipo que viaje por el cable debe estar en esta clase, incluyendo las formas `T[]` y `List<T>` que realmente devuelves desde los endpoints de API mínima. El writer de respuesta de ASP.NET Core no desenvuelve `IEnumerable<T>` por ti en modo AOT. Si devuelves `Enumerable.Range(...).Select(...)`, registra también `IEnumerable<Todo>` o materialízalo a un array primero.

Tres trampas que muerden incluso a autores cuidadosos:

- **`Results.Json(value)` versus `return value`**: devolver un valor directamente funciona porque el framework conoce el tipo de retorno estático. Envolver en `Results.Json(value)` sin pasar un `JsonTypeInfo<T>` cae al serializador por defecto y puede lanzar en runtime en AOT. Usa la sobrecarga de `Results.Json` que toma `JsonTypeInfo<T>` de tu context generado, o simplemente devuelve el valor.
- **Polimorfismo**: `[JsonDerivedType(typeof(Cat))]` funciona bajo AOT, pero el tipo base y todos los tipos derivados deben estar en el context. Los retornos de `object` plano requieren un registro `JsonSerializable(typeof(object))`, lo cual entonces fuerza cada forma que pueda ver, así que prefiere tipos concretos.
- **`IFormFile` y `HttpContext.Request.ReadFromJsonAsync`**: el binding de parámetros de formulario para primitivos funciona en AOT, pero `ReadFromJsonAsync<T>()` sin un context lanzará. Pasa siempre `AppJsonContext.Default.T` como segundo argumento.

El [recorrido de Andrew Lock por el generador de código fuente de API mínima](https://andrewlock.net/exploring-the-dotnet-8-preview-exploring-the-new-minimal-api-source-generator/) y el paseo de Martin Costello sobre [usar generadores de código fuente JSON con APIs mínimas](https://blog.martincostello.com/using-json-source-generators-with-aspnet-core-minimal-apis/) cubren el diseño original de .NET 8 que .NET 11 hereda sin cambios.

## Los proyectos de biblioteca necesitan EnableRequestDelegateGenerator

El generador de código fuente de API mínima convierte cada `MapGet(...)`, `MapPost(...)`, etc., en un `RequestDelegate` fuertemente tipado en tiempo de compilación. Cuando `PublishAot=true`, el SDK habilita este generador automáticamente para el proyecto web. **No** lo habilita para proyectos de biblioteca que referencias, aunque esas bibliotecas llamen a `MapGet` ellas mismas a través de métodos de extensión.

El síntoma son advertencias IL3050 al publicar que apuntan a tu biblioteca, quejándose de que `MapGet` hace reflexión sobre un delegado. La solución es una propiedad de MSBuild en la biblioteca:

```xml
<!-- Library project that defines endpoint extension methods -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
    <IsAotCompatible>true</IsAotCompatible>
    <EnableRequestDelegateGenerator>true</EnableRequestDelegateGenerator>
  </PropertyGroup>
</Project>
```

`IsAotCompatible=true` enciende los cuatro analizadores de trim y AOT, y `EnableRequestDelegateGenerator=true` cambia las llamadas `Map*` de la biblioteca al camino generado. Sin esta última, la biblioteca puede marcarse como compatible con AOT y aun así emitir IL3050 por cómo el analizador ve los call sites estilo `Delegate.DynamicInvoke` en `RouteHandlerBuilder`. El equipo de dotnet/aspnetcore rastrea las aristas en [issue #58678](https://github.com/dotnet/aspnetcore/issues/58678).

Si la biblioteca debe ser reutilizable tanto en proyectos AOT como no-AOT, deja la propiedad. El generador cae con elegancia al camino de runtime en builds CoreCLR regulares.

## A qué tienes que renunciar

Native AOT no es un interruptor que activas en un monolito MVC terminado. La lista de subsistemas no soportados es corta pero pesa.

- **Controladores MVC**: `AddControllers()` es el ejemplo canónico. La API no es trim-safe y no está soportada por Native AOT. El equipo de dotnet/aspnetcore rastrea el soporte a largo plazo en [issue #53667](https://github.com/dotnet/aspnetcore/issues/53667), pero a partir de .NET 11 no hay camino AOT para clases decoradas con `[ApiController]`. O reescribes los endpoints como APIs mínimas o no envías AOT. Los modelos y filtros se apoyan demasiado en reflexión y model binding en runtime para que ILC pueda recortar de forma segura.
- **Razor Pages y Vistas MVC**: misma razón. Ambos dependen de compilación de vistas en runtime. Compilarán bajo `PublishAot=true` si no los usas, pero registrar `AddRazorPages()` enciende IL2026.
- **Hubs de SignalR del lado del servidor**: no soportado bajo AOT en .NET 11. Los paquetes cliente tienen modos amigables con AOT, el host del hub no.
- **EF Core**: el runtime funciona, pero la traducción de consultas que depende de reflexión sobre grafos de propiedades de POCOs puede producir IL2026 a menos que optes por consultas compiladas y configuración con generador de código fuente. Para la mayoría de servicios AOT lo correcto es Dapper más una configuración a mano de `SqlClient`, o EF Core solo para acceso simple estilo `DbSet<T>.Find()`.
- **Patrones de DI con mucha reflexión**: cualquier cosa que resuelva `IEnumerable<IPlugin>` desde un assembly escaneado es frágil bajo trimming. Registra tipos concretos explícitamente, o usa un contenedor de DI con generador de código fuente.
- **`AddOpenApi()`**: la integración de OpenAPI de .NET 9 es compatible con AOT, pero versiones de `Swashbuckle.AspNetCore` anteriores al refactor consciente de AOT aún emiten IL2026. Si necesitas OpenAPI en una API mínima AOT, usa el paquete integrado [`Microsoft.AspNetCore.OpenApi`](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/aspnetcore-openapi) y omite Swashbuckle.

El equipo de Thinktecture publicó una [visión legible de escenarios soportados y no soportados](https://www.thinktecture.com/en/net/native-aot-with-asp-net-core-overview/) a la que recurro al onboardear un equipo a Native AOT.

## Leer IL2026 e IL3050 como un profesional

Las dos advertencias con las que pelearás son fáciles de confundir:

- **IL2026** significa que la llamada requiere código no referenciado. La implementación lee miembros mediante reflexión que el trimmer eliminaría de otro modo. Causa común: pasar un `Type` de runtime a una sobrecarga de serializador, llamar a `GetProperties()`, o usar `Activator.CreateInstance(Type)`.
- **IL3050** significa que la llamada requiere generación de código dinámico. Aun con todos los miembros preservados, la implementación necesita `Reflection.Emit` o un paso similar de codegen en tiempo de JIT, que no existe en AOT. Causa común: sobrecargas de `JsonSerializer.Serialize(object)`, `MakeGenericType` sobre un genérico aún sin instanciar, compilación de árbol de expresión.

Ambas son emitidas por el analizador `IsAotCompatible`, pero solo IL2026 es mostrada por el analizador de trimming a solas. Siempre ejecuto un publish puntual a `bin\publish` desde la línea de comandos durante el desarrollo para sacarlas todas a la vez:

```bash
dotnet publish -c Release -r linux-x64 -o ./publish
```

Una segunda gotcha: dotnet/sdk [discussion #51966](https://github.com/dotnet/sdk/discussions/51966) rastrea un problema recurrente donde Visual Studio 2026 y `dotnet build` tragan IL2026 / IL3050 en algunas configuraciones, pero `dotnet format` las muestra. Si tu equipo usa Visual Studio, añade un paso de CI que ejecute `dotnet publish` contra el runtime AOT para que una advertencia perdida rompa el pipeline.

Cuando no puedas evitar una API que use reflexión, puedes suprimir la advertencia en el call site con los atributos `[RequiresUnreferencedCode]` y `[RequiresDynamicCode]` en el método envoltorio, lo cual propaga el requisito hacia arriba. Haz esto solo cuando sepas que los caminos de código consumidores no están en la superficie de publicación AOT. Suprimir dentro de un endpoint handler es casi siempre incorrecto.

## Verificar que el binario realmente funciona

Una publicación limpia no demuestra que la app arranque bajo AOT. Tres comprobaciones que ejecuto antes de cantar victoria:

```bash
# 1. The output is a single static binary, not a CoreCLR loader.
ls -lh ./publish
file ./publish/MyApi
# Expected on Linux: "ELF 64-bit LSB pie executable ... statically linked"

# 2. The runtime never loads the JIT.
LD_DEBUG=libs ./publish/MyApi 2>&1 | grep -E "libcoreclr|libclrjit"
# Expected: empty output. If libclrjit.so loads, you accidentally shipped a runtime fallback.

# 3. A real request round-trips with the source generator.
./publish/MyApi &
curl -s http://localhost:5000/todos | head -c 200
```

La tercera comprobación es la importante. El modo de fallo clásico es "compila, publica, arranca, devuelve 500 en la primera petición" porque falta un tipo de retorno en el context JSON. Toca cada endpoint al menos una vez con un payload representativo antes de enviar.

Para despliegues en contenedor, build con `--self-contained true` está implícito bajo `PublishAot=true`. La salida `./publish/MyApi` más su archivo `.dbg` es la unidad de despliegue completa. Una API mínima típica de .NET 11 aterriza en 8-12 MB sin símbolos, comparado con los 80-90 MB de un publish CoreCLR self-contained.

## Guías relacionadas en Start Debugging

- La palanca Native AOT está dentro de una historia más amplia de cold-start: [el manual de cold-start de AWS Lambda con .NET 11](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) recorre el camino AOT en `provided.al2023` con la misma configuración de generador de código fuente.
- Para OpenAPI sobre una API mínima AOT, la [guía de generación de cliente OpenAPI](/es/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/) cubre el round trip desde metadatos de API mínima a un `HttpClient` tipado.
- Los proyectos AOT prohíben JSON basado en reflexión, así que [escribir un `JsonConverter` personalizado en System.Text.Json](/es/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) es el primer paso correcto cuando una conversión integrada no basta.
- Una historia de excepciones limpia importa más bajo AOT, donde los diagnósticos basados en reflexión no están disponibles: [añadir un filtro global de excepciones en ASP.NET Core 11](/es/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) muestra el camino `IExceptionHandler`, totalmente compatible con AOT.

## Fuentes

- [Soporte de ASP.NET Core para Native AOT (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot?view=aspnetcore-10.0)
- [Visión general del despliegue Native AOT (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/)
- [Generación de código fuente en System.Text.Json (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation)
- [aspnetcore#58678 - Advertencias AOT de Map* fuera de Program.cs](https://github.com/dotnet/aspnetcore/issues/58678)
- [aspnetcore#53667 - Soporte Native AOT para MVC](https://github.com/dotnet/aspnetcore/issues/53667)
- [Andrew Lock - Explorando el nuevo generador de código fuente de API mínima](https://andrewlock.net/exploring-the-dotnet-8-preview-exploring-the-new-minimal-api-source-generator/)
- [Martin Costello - Usando generadores de código fuente JSON con APIs mínimas](https://blog.martincostello.com/using-json-source-generators-with-aspnet-core-minimal-apis/)
- [Thinktecture - Native AOT con ASP.NET Core, una visión general](https://www.thinktecture.com/en/net/native-aot-with-asp-net-core-overview/)
