---
title: "HttpClient vs HttpClientFactory vs Refit: ¿cuál deberías usar en .NET 11?"
description: "Nunca crees un HttpClient por solicitud. Usa IHttpClientFactory para gestionar el ciclo de vida, y añade Refit encima cuando quieras una interfaz tipada en lugar de escribir el código de solicitud a mano. Un HttpClient singleton sin más solo sirve para los casos más simples."
pubDate: 2026-05-23
template: vs
tags:
  - "comparison"
  - "httpclient"
  - "httpclientfactory"
  - "refit"
  - "dotnet"
  - "dotnet-11"
lang: "es"
translationOf: "2026/05/httpclient-vs-httpclientfactory-vs-refit"
translatedBy: "claude"
translationDate: 2026-05-23
---

Lo primero que hay que entender es que estos tres no son realmente competidores. Son tres capas de la misma pila. `IHttpClientFactory` gestiona el ciclo de vida de `HttpClient`, y Refit genera las llamadas de `HttpClient` por ti, encima de la fábrica. Así que la verdadera pregunta es a qué altura de la pila deberías situarte. Para código nuevo de .NET 11 en 2026: registra tus clientes a través de **IHttpClientFactory** para que el ciclo de vida de la conexión y el DNS se gestionen correctamente, y recurre a **Refit** cuando quieras una interfaz tipada en lugar de escribir el código de construcción de solicitudes a mano. Un `HttpClient` singleton crudo y de larga vida solo es aceptable para los casos de una sola llamada más simples, y `new HttpClient()` por solicitud es el único patrón que siempre está mal.

Todos los ejemplos aquí apuntan a `<TargetFramework>net11.0</TargetFramework>` con el SDK de .NET 11 y C# 14. Refit se refiere a la versión 10.1.6 (publicada el 2026-03-21, estable actual en NuGet), y las piezas de resiliencia usan `Microsoft.Extensions.Http.Resilience` 10.6.0. `IHttpClientFactory` vive en `Microsoft.Extensions.Http`, que se incluye de fábrica con los SDK de ASP.NET Core y Worker.

## La matriz de características de un vistazo

Esta es la tabla por la que viniste. Las columnas son las tres formas en las que realmente conectarás una llamada HTTP, y las filas son las decisiones que cambian cuál eliges.

| Consideración | HttpClient crudo (singleton) | IHttpClientFactory | Refit (+ HttpClientFactory) |
| ------- | -------------------------- | ------------------ | --------------------------- |
| Seguro ante agotamiento de sockets | Sí, si es realmente singleton | Sí | Sí |
| Respeta los cambios de DNS | Solo con `PooledConnectionLifetime` | Sí, el handler rota (2 min por defecto) | Sí, hereda de la fábrica |
| Pipeline de handlers vía DI | Manual | De primera clase (`AddHttpMessageHandler`) | De primera clase, hereda de la fábrica |
| Resiliencia integrada | Hecha a mano | `AddStandardResilienceHandler` | `AddStandardResilienceHandler` |
| Clientes con nombre / tipados | No | Sí | Sí, la interfaz es el cliente |
| Código de construcción de solicitudes que escribes | Todo | Todo | Nada, generado en tiempo de compilación |
| Respuestas fuertemente tipadas | Deserialización manual | Deserialización manual | Automática |
| Native AOT / trimming | Sí | Sí | Sí, desde 9.0.2 en .NET 10+ |
| Dependencia NuGet adicional | Ninguna (de fábrica) | Ninguna para ASP.NET Core | `Refit`, `Refit.HttpClientFactory` |
| Ideal para | Una o dos llamadas simples | La mayoría del código de servidor | Muchos endpoints contra una misma API |

El patrón de la tabla es que cada columna hereda las garantías de seguridad de la que tiene a su izquierda y añade ergonomía encima. El costo de moverte a la derecha es una dependencia y un poco de indirección, no la corrección.

## Cuándo HttpClient crudo está bien de verdad

Existe un mito persistente de que nunca debes usar `HttpClient` directamente. Eso es una sobrecorrección. Un único `HttpClient` de larga vida compartido por toda la aplicación es un patrón perfectamente válido y bien soportado. El peligro nunca fue `HttpClient` en sí, sino crear uno nuevo por solicitud dentro de un bloque `using`, lo que filtra sockets en `TIME_WAIT` y, con el tiempo, agota el rango de puertos bajo carga.

Un singleton estático evita el agotamiento de sockets, pero introduce un segundo problema más sutil: `HttpClient` resuelve el DNS solo cuando abre una conexión, y un pool de conexiones de larga vida nunca vuelve a resolver. Si el host de destino conmuta a una nueva IP, tu singleton sigue machacando la antigua. La solución, en .NET Core y .NET 5+, es acotar el ciclo de vida de la conexión en el handler:

```csharp
// .NET 11, C# 14 - a singleton that still picks up DNS changes
using System.Net;

var handler = new SocketsHttpHandler
{
    // Recycle pooled connections so DNS failover is respected
    PooledConnectionLifetime = TimeSpan.FromMinutes(2),
    AutomaticDecompression = DecompressionMethods.All
};

// Construct once, reuse for the entire process lifetime
var http = new HttpClient(handler)
{
    BaseAddress = new Uri("https://api.example.com")
};
```

Usa esto cuando tengas una herramienta de consola, un worker pequeño o una biblioteca sin contenedor de DI y hagas llamadas a uno o dos endpoints. En el momento en que tengas un contenedor de DI y más de un par de clientes, estarás reimplementando `IHttpClientFactory` a mano, y deberías detenerte y usar la versión real.

## Cuándo IHttpClientFactory es el valor por defecto correcto

Para casi todo el código de servidor en 2026, `IHttpClientFactory` es la base. Encapsula la gestión del ciclo de vida descrita arriba para que no tengas que pensar en `PooledConnectionLifetime` ni en la rotación de DNS: la fábrica agrupa instancias de `HttpMessageHandler` y las rota en un intervalo configurable (dos minutos por defecto), lo que te da reutilización de sockets y frescura de DNS al mismo tiempo.

La mayor ventaja es el pipeline de handlers de mensajes. Puedes registrar aspectos transversales (cabeceras de autenticación, registro, IDs de correlación, reintentos) como instancias de `DelegatingHandler` en DI, y cada cliente construido por la fábrica los compone en orden. Un cliente tipado vincula un `HttpClient` configurado a una clase de servicio específica:

```csharp
// .NET 11, C# 14 - typed client registered through the factory
using Microsoft.Extensions.DependencyInjection;

builder.Services.AddHttpClient<GitHubService>(client =>
{
    client.BaseAddress = new Uri("https://api.github.com");
    client.DefaultRequestHeaders.UserAgent.ParseAdd("start-debugging");
})
.AddStandardResilienceHandler(); // Polly-backed retries, timeout, circuit breaker

public sealed class GitHubService(HttpClient client)
{
    public async Task<Repo?> GetRepoAsync(string owner, string name, CancellationToken ct)
    {
        // You still hand-write the path, the verb, and the deserialize
        return await client.GetFromJsonAsync<Repo>($"/repos/{owner}/{name}", ct);
    }
}

public record Repo(long Id, string FullName, int StargazersCount);
```

`AddStandardResilienceHandler` (de `Microsoft.Extensions.Http.Resilience` 10.6.0) apila un limitador de tasa, un timeout total de la solicitud, reintentos, un cortacircuitos y un timeout por intento con valores por defecto razonables. Este es el reemplazo moderno de cablear políticas de Polly a mano, y es una sola línea. Si sigues viendo timeouts después de añadirlo, la causa suele ser un timeout por intento mal configurado en lugar del handler en sí, lo cual es una fuente común de un [TaskCanceledException, una tarea fue cancelada](/es/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/).

Lo único que la fábrica no hace es escribir tu código de solicitud. Sigues redactando la ruta, el verbo HTTP, la cadena de consulta y la deserialización para cada llamada. Para uno o dos endpoints eso está bien. Para una API REST con treinta endpoints, eso son treinta métodos de código repetitivo casi idéntico, y ese es exactamente el hueco que Refit llena.

## Cuándo Refit se gana su dependencia

Refit convierte una interfaz de C# en un cliente REST funcional. Declaras la forma de la API con atributos, y el generador de código fuente de Refit emite la implementación en tiempo de compilación. No hay construcción de solicitudes por llamada ni deserialización manual:

```csharp
// .NET 11, C# 14, Refit 10.1.6 - the interface IS the client
using Refit;

public interface IGitHubApi
{
    [Get("/repos/{owner}/{name}")]
    Task<Repo> GetRepoAsync(string owner, string name, CancellationToken ct = default);

    [Get("/users/{user}/repos")]
    Task<IReadOnlyList<Repo>> GetUserReposAsync(string user, [Query] string sort = "updated");

    [Post("/repos/{owner}/{name}/issues")]
    Task<Issue> CreateIssueAsync(string owner, string name, [Body] NewIssue issue);
}

public record Repo(long Id, string FullName, int StargazersCount);
public record Issue(long Number, string Title);
public record NewIssue(string Title, string Body);
```

Regístralo contra la misma infraestructura de la fábrica con `Refit.HttpClientFactory`, para conservar todas las garantías de ciclo de vida, DNS y resiliencia de la capa inferior:

```csharp
// .NET 11, C# 14, Refit.HttpClientFactory 10.1.6
using Refit;
using Microsoft.Extensions.DependencyInjection;

builder.Services
    .AddRefitClient<IGitHubApi>()
    .ConfigureHttpClient(c =>
    {
        c.BaseAddress = new Uri("https://api.github.com");
        c.DefaultRequestHeaders.UserAgent.ParseAdd("start-debugging");
    })
    .AddStandardResilienceHandler(); // same resilience stack as a typed client
```

Ese es el cliente completo. Tres métodos de interfaz reemplazan lo que serían tres métodos escritos a mano más su lógica de construcción de solicitudes y de parseo. Para una base de código que habla con una API de terceros grande, la reducción de código que tienes que leer y mantener es todo el argumento. Refit también maneja bien las partes incómodas: `[Query]` para cadenas de consulta, `[Body]` con serialización, `[Header]` y `[Authorize]` para autenticación, subidas multipart, y `ApiResponse<T>` cuando necesitas el código de estado y las cabeceras en lugar de solo el cuerpo deserializado.

Dos notas prácticas para 2026. Primero, Refit 9.0.2 (noviembre de 2025) añadió soporte para Native AOT y trimming en .NET 10 y posteriores, así que Refit ya no queda descalificado de los contenedores con trimming y las funciones scale-to-zero como les ocurre a los clientes con mucha reflexión. Para la vía AOT, proporciona metadatos de `System.Text.Json` generados por código fuente mediante un `JsonSerializerContext` para que el serializador siga libre de reflexión, la misma disciplina que se cubre en [Native AOT vs ReadyToRun vs JIT en .NET 11](/es/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/). Segundo, si tu API está descrita por un documento OpenAPI, ni siquiera escribes la interfaz a mano: las herramientas pueden emitir interfaces de Refit a partir de la especificación, lo que se solapa con [generar un cliente fuertemente tipado a partir de una especificación OpenAPI](/es/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/).

## Cuál es realmente la sobrecarga

La respuesta honesta sobre el rendimiento es que, para llamadas HTTP, la red domina y la elección entre estos tres queda en el ruido. Un viaje de ida y vuelta a una API real se mide en milisegundos a cientos de milisegundos; la sobrecarga de construcción de la solicitud se mide en microsegundos. Elegir Refit sobre un cliente tipado para ahorrar CPU es optimizar la capa equivocada.

Dicho esto, la sobrecarga no es cero y vale la pena saber dónde reside:

| Aspecto | Cliente crudo / tipado | Refit |
| ------ | ------------------ | ----- |
| Construcción de solicitud por llamada | Directa, escrita a mano | Generada, casi directa en .NET 8+ |
| Reflexión en tiempo de ejecución | Ninguna | Ninguna con el generador de código fuente |
| Costo de arranque | Ninguno | Registro único de stubs generados |
| Asignación por llamada | Línea base | Comparable, el parseo de atributos es en tiempo de compilación |

El punto metodológico clave: Refit pasó a un generador de código fuente de Roslyn (el `InterfaceStubGenerator`), así que el análisis de la interfaz ocurre en tiempo de compilación, no en cada llamada. El antiguo costo de reflexión y `Reflection.Emit` que AOT no podía tolerar ha desaparecido. Si quieres un número real para tus propias formas de objeto, ejecuta BenchmarkDotNet contra tus DTOs en lugar de confiar en una cifra genérica, pero espera que el delta entre un cliente tipado y un cliente Refit sea de decenas de nanosegundos frente a una llamada de red que toma milisegundos. La decisión trata sobre el código que mantienes, no sobre los ciclos que gastas.

## El detalle que decide por ti

Unas pocas restricciones resuelven la elección antes de que la preferencia entre en escena.

**`new HttpClient()` por solicitud nunca es la respuesta.** Este es el único patrón genuinamente erróneo, y está mal para las tres columnas. Agota los sockets bajo carga aunque `HttpClient` sea `IDisposable` y parezca que pide un `using`. Si te llevas una sola cosa, llévate esta: construye `HttpClient` una vez, o deja que la fábrica lo construya por ti, pero nunca por llamada.

**Los singletons que capturan un cliente tipado anulan la fábrica.** Registrar un cliente tipado o un cliente Refit y luego capturarlo dentro de un singleton fija un handler para siempre, lo que significa que deja de rotar y deja de ver los cambios de DNS, justo el problema que la fábrica existe para resolver. Inyecta el cliente donde lo uses, o inyecta `IHttpClientFactory` y crea bajo demanda. No lo guardes en un campo estático.

**Refit necesita que la respuesta coincida con el contrato.** Como la deserialización es automática, una respuesta que no coincide con tu record (un sobre envolvente, un casing diferente, un cuerpo de error devuelto con un 200) aparece como un fallo de deserialización en lugar de algo que manejas en línea. Usa `ApiResponse<T>` cuando necesites inspeccionar el estado y las cabeceras, y configura el serializador igual que lo harías en otro lugar. Probar estos clientes también es ligeramente diferente porque no hay cuerpo de método que simular; simulas el `HttpMessageHandler`, el mismo enfoque que [probar unitariamente código que usa HttpClient](/es/2026/04/how-to-unit-test-code-that-uses-httpclient/).

**La licencia no es un factor aquí.** A diferencia de algunos de los debates sobre mappers y mediators en 2026, las tres opciones son gratuitas y tienen licencias permisivas. `HttpClient` e `IHttpClientFactory` se incluyen con .NET, y Refit es MIT. No hay una barrera comercial que te empuje hacia o lejos de ninguna de ellas.

## La decisión, en una línea

Para código nuevo de .NET 11 en 2026: haz de `IHttpClientFactory` tu opción por defecto para que el ciclo de vida, el DNS y la resiliencia se gestionen por ti, y añade Refit encima cuando llames a muchos endpoints contra una misma API y quieras que el código de solicitud se genere en lugar de escribirse a mano. Reserva `HttpClient` crudo para el caso genuinamente simple (un singleton con `PooledConnectionLifetime`, una o dos llamadas, sin DI), y nunca crees uno por solicitud. No son tres bibliotecas rivales entre las que eliges; son tres peldaños de una misma escalera, y subes al peldaño que coincide con cuánta de la fontanería HTTP quieres dejar de escribir tú mismo.

## Relacionados

- [Cómo generar un cliente fuertemente tipado a partir de una especificación OpenAPI en .NET 11](/es/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/)
- [Cómo probar unitariamente código que usa HttpClient](/es/2026/04/how-to-unit-test-code-that-uses-httpclient/)
- [Fix: TaskCanceledException, una tarea fue cancelada en HttpClient](/es/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/)
- [Native AOT vs ReadyToRun vs JIT en .NET 11](/es/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [System.Text.Json vs Newtonsoft.Json en 2026](/es/2026/05/system-text-json-vs-newtonsoft-json-in-2026/)

## Fuentes

- [Use IHttpClientFactory to implement resilient HTTP requests](https://learn.microsoft.com/en-us/dotnet/core/extensions/httpclient-factory) - clientes con nombre y tipados, ciclo de vida del handler, y el pipeline de handlers de mensajes.
- [HttpClient guidelines for .NET](https://learn.microsoft.com/en-us/dotnet/fundamentals/networking/http/httpclient-guidelines) - agotamiento de sockets, DNS, y el patrón `PooledConnectionLifetime` para singletons.
- [Build resilient HTTP apps: key development patterns](https://learn.microsoft.com/en-us/dotnet/core/resilience/http-resilience) - `AddStandardResilienceHandler` y la pila de resiliencia estándar.
- [Refit on GitHub](https://github.com/reactiveui/refit) - el generador de código fuente, la referencia de atributos, y la integración con `Refit.HttpClientFactory`.
- [Refit.HttpClientFactory 10.1.6 on NuGet](https://www.nuget.org/packages/refit.httpclientfactory) - versión estable actual y frameworks de destino.
