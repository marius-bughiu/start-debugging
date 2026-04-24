---
title: "Cómo generar código cliente fuertemente tipado desde una especificación OpenAPI en .NET 11"
description: "Usa Kiota, el generador oficial de OpenAPI de Microsoft, para producir un cliente C# fluent y fuertemente tipado desde cualquier especificación OpenAPI. Paso a paso: instalar, generar, conectar a la inyección de dependencias de ASP.NET Core y gestionar la autenticación."
pubDate: 2026-04-24
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "aspnet"
  - "openapi"
lang: "es"
translationOf: "2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11"
translatedBy: "claude"
translationDate: 2026-04-24
---

En el momento en que una API publica un documento OpenAPI, mantener un wrapper de `HttpClient` escrito a mano es una apuesta perdida. Cada nuevo campo, ruta renombrada o código de estado adicional implica una actualización manual, y la especificación y el cliente se desincronizan silenciosamente. La solución correcta es invertir la relación: tratar la especificación como la fuente de verdad y generar los tipos de C# a partir de ella.

En .NET 11, la herramienta canónica para esto es [Kiota](https://learn.microsoft.com/en-us/openapi/kiota/overview), el generador de clientes OpenAPI de Microsoft. Instálalo como herramienta de .NET, apúntalo a una especificación y escribirá un cliente C# fluent y orientado a recursos con clases reales y fuertemente tipadas para solicitudes y respuestas. Un único metapaquete gestiona HTTP, JSON y el middleware de autenticación. La configuración completa lleva menos de diez minutos con una especificación limpia.

## Por qué los wrappers HttpClient escritos a mano dejan de funcionar

Un wrapper típico escrito a mano tiene este aspecto: escribes un POCO para la respuesta, añades un método en una clase de servicio, hardcodeas el segmento de URL. Repites para cada endpoint. Luego repites de nuevo cuando el propietario de la API añade un nuevo campo de respuesta, cambia el nombre de un parámetro de ruta o ajusta un contrato nullable. Ninguno de esos cambios produce un error del compilador. Afloran como sorpresas en tiempo de ejecución -- excepciones de referencia nula en producción, nombres de propiedades JSON que no coinciden y que ponen silenciosamente un valor en cero.

Un cliente generado invierte eso. La especificación se compila directamente en tipos de C#. Si la especificación dice que un campo es `nullable: false`, la propiedad es `string`, no `string?`. Si la especificación añade una nueva ruta, la siguiente ejecución de `kiota generate` añade el método. Un diff en los archivos generados muestra exactamente qué cambió en el contrato de la API.

## Kiota vs NSwag: qué generador elegir

Dos generadores dominan el espacio de .NET: NSwag (maduro, produce un único archivo de clase monolítico) y Kiota (más reciente, orientado a recursos, produce muchos archivos pequeños y enfocados).

Kiota construye una jerarquía de rutas que refleja la estructura de la URL. Una llamada a `GET /repos/{owner}/{repo}/releases` se convierte en `client.Repos["owner"]["repo"].Releases.GetAsync()`. Cada segmento de ruta es una clase C# separada. Esto produce más archivos pero hace que el código generado sea navegable y se pueda simular a cualquier nivel de ruta.

NSwag genera una clase con un método por operación: `GetReposOwnerRepoReleasesAsync(owner, repo)`. Eso es sencillo para APIs pequeñas pero se vuelve inmanejable cuando la especificación tiene cientos de rutas. La especificación completa de GitHub genera un archivo que se acerca a 400.000 líneas con NSwag.

Kiota es lo que Microsoft usa para el SDK de Microsoft Graph y el SDK de Azure para .NET. Se declaró de disponibilidad general en 2024 y es el generador al que apuntan los inicios rápidos de la documentación oficial. Ambas herramientas se muestran a continuación; la sección de NSwag cubre la alternativa mínima para equipos ya invertidos en esa cadena de herramientas.

## Paso 1: Instalar Kiota

**Instalación global** (la más sencilla para una máquina de desarrollador):

```bash
dotnet tool install --global Microsoft.OpenApi.Kiota
```

**Instalación local** (recomendada para proyectos en equipo -- reproducible en máquinas de CI):

```bash
dotnet new tool-manifest   # creates .config/dotnet-tools.json
dotnet tool install Microsoft.OpenApi.Kiota
```

Tras una instalación local, `dotnet tool restore` en cualquier máquina de desarrollador o trabajo de CI instala la versión exacta fijada. Sin deriva de versiones en el equipo.

Verifica la instalación:

```bash
kiota --version
# 1.x.x
```

## Paso 2: Generar el cliente

```bash
# .NET 11 / Kiota 1.x
kiota generate \
  -l CSharp \
  -c WeatherClient \
  -n MyApp.ApiClient \
  -d ./openapi.yaml \
  -o ./src/ApiClient
```

Los parámetros clave:

| Parámetro | Propósito |
|-----------|-----------|
| `-l CSharp` | Lenguaje destino. Kiota también soporta Go, Java, TypeScript, Python, PHP, Ruby. |
| `-c WeatherClient` | Nombre de la clase cliente raíz. |
| `-n MyApp.ApiClient` | Espacio de nombres raíz de C# para todos los archivos generados. |
| `-d ./openapi.yaml` | Ruta o URL HTTPS al documento OpenAPI. Kiota acepta YAML y JSON. |
| `-o ./src/ApiClient` | Directorio de salida. Kiota lo sobreescribe en cada ejecución -- no edites los archivos generados a mano. |

Para especificaciones públicas grandes (GitHub, Stripe, Azure), añade `--include-path` para limitar el cliente a las rutas que realmente utilizas:

```bash
# Only generate the /releases subtree from GitHub's spec
kiota generate \
  -l CSharp \
  -c GitHubClient \
  -n MyApp.GitHub \
  -d https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.yaml \
  -o ./src/GitHub \
  --include-path "/repos/{owner}/{repo}/releases/*"
```

Sin `--include-path`, la especificación completa de GitHub genera aproximadamente 600 archivos. Con él, obtienes la docena de archivos para el subárbol de releases. Siempre puedes ampliar el filtro más adelante.

Confirma los archivos generados en el control de código fuente. La URL de la especificación o la ruta local es suficiente para regenerarlos, y los revisores pueden ver los tipos exactos en uso durante la revisión de código.

## Paso 3: Añadir el paquete NuGet

```bash
dotnet add package Microsoft.Kiota.Bundle
```

`Microsoft.Kiota.Bundle` es un metapaquete que incluye:

- `Microsoft.Kiota.Abstractions` -- contratos del adaptador de solicitudes e interfaces de serialización
- `Microsoft.Kiota.Http.HttpClientLibrary` -- `HttpClientRequestAdapter`, el backend HTTP predeterminado
- `Microsoft.Kiota.Serialization.Json` -- serialización con System.Text.Json
- `Microsoft.Kiota.Authentication.Azure` -- opcional, para proveedores de autenticación de Azure Identity

El bundle tiene como destino `netstandard2.0`, por lo que es compatible con .NET 8, .NET 9, .NET 10 y .NET 11 (actualmente en versión preliminar) sin ningún ajuste adicional en `<TargetFramework>`.

## Paso 4: Usar el cliente en una aplicación de consola

```csharp
// .NET 11, Kiota 1.x
using MyApp.ApiClient;
using Microsoft.Kiota.Abstractions.Authentication;
using Microsoft.Kiota.Http.HttpClientLibrary;

var adapter = new HttpClientRequestAdapter(new AnonymousAuthenticationProvider());
var client = new WeatherClient(adapter);

// GET /forecasts
var all = await client.Forecasts.GetAsync();
Console.WriteLine($"Received {all?.Count} forecasts.");

// GET /forecasts/{location}
var specific = await client.Forecasts["lon=51.5,lat=-0.1"].GetAsync();
Console.WriteLine($"Temperature: {specific?.Temperature}");

// POST /forecasts
var created = await client.Forecasts.PostAsync(new()
{
    Location = "lon=51.5,lat=-0.1",
    TemperatureC = 21,
});
Console.WriteLine($"Created forecast ID: {created?.Id}");
```

`AnonymousAuthenticationProvider` no añade cabeceras de autenticación -- correcto para APIs públicas. Consulta la sección de autenticación a continuación para los tokens Bearer.

Cada método asíncrono generado acepta un `CancellationToken` opcional. Pasa uno desde tu propio contexto:

```csharp
// .NET 11, Kiota 1.x
using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
var forecasts = await client.Forecasts.GetAsync(cancellationToken: cts.Token);
```

El token fluye a través del adaptador HTTP y cancela la llamada subyacente de `HttpClient`. No se necesita ningún cableado adicional.

## Paso 5: Conectar el cliente a la inyección de dependencias de ASP.NET Core

Crear el adaptador de solicitudes en cada manejador desperdicia sockets (omitiendo el pool de conexiones de `IHttpClientFactory`) y hace el cliente imposible de probar. El patrón correcto es una clase de fábrica que acepta un `HttpClient` gestionado a través de inyección de dependencias en el constructor.

Crea la fábrica:

```csharp
// .NET 11, Kiota 1.x
using MyApp.ApiClient;
using Microsoft.Kiota.Abstractions.Authentication;
using Microsoft.Kiota.Http.HttpClientLibrary;

public class WeatherClientFactory(HttpClient httpClient)
{
    public WeatherClient GetClient() =>
        new(new HttpClientRequestAdapter(
            new AnonymousAuthenticationProvider(),
            httpClient: httpClient));
}
```

Registra todo en `Program.cs`:

```csharp
// .NET 11
using Microsoft.Kiota.Http.HttpClientLibrary;

// Registra los manejadores HTTP integrados de Kiota en el contenedor de DI
builder.Services.AddKiotaHandlers();

// Registra el HttpClient nombrado y adjunta esos manejadores
builder.Services.AddHttpClient<WeatherClientFactory>(client =>
{
    client.BaseAddress = new Uri("https://api.weather.example.com");
})
.AttachKiotaHandlers();

// Expone el cliente generado directamente para inyección
builder.Services.AddTransient(sp =>
    sp.GetRequiredService<WeatherClientFactory>().GetClient());
```

`AddKiotaHandlers` y `AttachKiotaHandlers` son métodos de extensión de `Microsoft.Kiota.Http.HttpClientLibrary`. Registran los manejadores delegantes predeterminados de Kiota -- reintento, redirección, inspección de cabeceras -- y los conectan al ciclo de vida de `IHttpClientFactory` para que se eliminen correctamente.

Inyecta `WeatherClient` directamente en tus endpoints de API mínima:

```csharp
// .NET 11
app.MapGet("/weather", async (WeatherClient client, CancellationToken ct) =>
{
    var forecasts = await client.Forecasts.GetAsync(cancellationToken: ct);
    return forecasts;
});
```

El parámetro `CancellationToken` en un manejador de API mínima se vincula automáticamente al token de cancelación de solicitud HTTP. Si el cliente se desconecta, la llamada de Kiota en vuelo se cancela limpiamente sin ningún código adicional.

## Paso 6: Autenticación

Para APIs que requieren un token Bearer, implementa `IAccessTokenProvider` y pásalo a `BaseBearerTokenAuthenticationProvider`:

```csharp
// .NET 11, Kiota 1.x
using Microsoft.Kiota.Abstractions;
using Microsoft.Kiota.Abstractions.Authentication;

public class StaticTokenProvider(string token) : IAccessTokenProvider
{
    public Task<string> GetAuthorizationTokenAsync(
        Uri uri,
        Dictionary<string, object>? additionalContext = null,
        CancellationToken cancellationToken = default) =>
        Task.FromResult(token);

    public AllowedHostsValidator AllowedHostsValidator { get; } = new();
}
```

Conéctalo en la fábrica:

```csharp
// .NET 11, Kiota 1.x
var authProvider = new BaseBearerTokenAuthenticationProvider(
    new StaticTokenProvider(apiKey));

return new WeatherClient(new HttpClientRequestAdapter(authProvider, httpClient: httpClient));
```

En producción, sustituye `StaticTokenProvider` por una implementación que lea el token del contexto HTTP actual, un valor `IOptions<>`, o `DefaultAzureCredential` de Azure Identity (el paquete `Microsoft.Kiota.Authentication.Azure` expone `AzureIdentityAuthenticationProvider` para exactamente este caso).

## Usar NSwag si prefieres una estructura de archivos más simple

Si tu proyecto ya usa NSwag o fue generado con `dotnet-openapi`, no necesitas migrar. Instala la CLI de NSwag y regenera con:

```bash
dotnet tool install --global NSwag.ConsoleCore

nswag openapi2csclient \
  /input:openapi.yaml \
  /classname:WeatherClient \
  /namespace:MyApp.ApiClient \
  /output:WeatherClient.cs
```

NSwag produce un único archivo C# que contiene la clase cliente y una interfaz `IWeatherClient` correspondiente. Esa interfaz hace que las pruebas unitarias sean sencillas -- puedes simular `IWeatherClient` directamente sin ningún nivel de indirección por ruta. Para especificaciones pequeñas y estables donde el archivo generado completo cabe en una pantalla, NSwag es una elección práctica. Para especificaciones grandes o que cambian frecuentemente, la estructura de archivos por ruta de Kiota hace que los diffs de la API sean más fáciles de revisar.

## Problemas a tener en cuenta antes de confirmar los archivos generados

**La calidad de la especificación determina la precisión de los tipos.** Kiota valida el documento OpenAPI en el momento de la generación. Una anotación `nullable: true` faltante se convierte en `string` donde esperabas `string?`. Un `type: integer` incorrecto se convierte en `int` donde la API realmente envía flotantes. Si eres el propietario del servidor, ejecuta [Spectral](https://stoplight.io/open-source/spectral) contra la especificación antes de generar. Datos de entrada incorrectos, tipos engañosos como resultado.

**`--include-path` no es opcional para APIs públicas grandes.** Sin él, la especificación de GitHub genera cientos de archivos, la de Stripe aún más. Limita el cliente en el momento de la generación a las rutas que utilizas. Siempre puedes regenerar con un filtro más amplio más adelante; un cliente con 600 archivos que crece con el tiempo es más difícil de reducir.

**Las colisiones de nombres de modelos se resuelven con espacios de nombres automáticamente.** Si `GET /posts/{id}` y `GET /users/{id}` referencian ambos un esquema llamado `Item`, Kiota genera `Posts.Item.Item` y `Users.Item.Item`. Revisa tus sentencias `using` si los nombres parecen colisionar.

**`CancellationToken` en endpoints de API mínima es gratuito.** Decláralo como parámetro y ASP.NET Core lo vincula al token de cancelación de la solicitud sin ningún atributo. Pásalo a cada llamada de Kiota y tu cliente HTTP se cancela automáticamente cuando el navegador cierra la conexión o se activa un timeout de gateway. La mecánica de la cancelación cooperativa de tareas en C# se cubre en profundidad en [cómo cancelar una tarea de larga duración en C# sin interbloqueo](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/).

**Regenera en CI, no solo localmente.** Añade `dotnet tool restore && kiota generate [...]` como paso de la pipeline. Si la especificación cambia y el código generado en el repositorio queda desactualizado, la compilación detectará la diferencia antes de que llegue a producción.

## Artículos relacionados

- Si expones el servidor de la API y quieres que la autenticación Bearer aparezca correctamente en la interfaz de documentación de Scalar, el cableado no es obvio: [Scalar en ASP.NET Core: por qué se ignora tu token Bearer](/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)
- Si tus llamadas de servicio a servicio van por gRPC en lugar de REST, las trampas de red en contenedores son diferentes a las de HTTP: [gRPC en contenedores en .NET 9 y .NET 10](/2026/01/grpc-in-containers-feels-hard-in-net-9-and-net-10-4-traps-you-can-fix/)
- Añadir trazas distribuidas a la capa del cliente HTTP encaja bien con [trazado nativo de OpenTelemetry en ASP.NET Core 11](/2026/04/aspnetcore-11-native-opentelemetry-tracing/)

## Fuentes

- [Descripción general de Kiota](https://learn.microsoft.com/en-us/openapi/kiota/overview) -- Microsoft Learn
- [Compilar clientes de API para .NET](https://learn.microsoft.com/en-us/openapi/kiota/quickstarts/dotnet) -- Microsoft Learn
- [Registrar un cliente de Kiota con inyección de dependencias en .NET](https://learn.microsoft.com/en-us/openapi/kiota/tutorials/dotnet-dependency-injection) -- Microsoft Learn
- [NSwag: la cadena de herramientas Swagger/OpenAPI para .NET](https://github.com/RicoSuter/NSwag) -- GitHub
