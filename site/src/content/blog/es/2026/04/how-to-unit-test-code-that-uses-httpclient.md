---
title: "Cómo hacer pruebas unitarias de código que usa HttpClient"
description: "Una guía completa para probar HttpClient en .NET 11: por qué no debes mockear HttpClient directamente, cómo escribir un HttpMessageHandler de stub, intercambiar el handler primario con IHttpClientFactory, verificar reintentos de Polly, y la opción WireMock.Net."
pubDate: 2026-04-26
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "testing"
  - "httpclient"
lang: "es"
translationOf: "2026/04/how-to-unit-test-code-that-uses-httpclient"
translatedBy: "claude"
translationDate: 2026-04-26
---

Para hacer pruebas unitarias de código que se comunica con una API HTTP, no mockees `HttpClient` en sí. Reemplaza su `HttpMessageHandler` con un stub que devuelva la respuesta que quieres simular, y luego inyecta el `HttpClient` resultante (o un `IHttpClientFactory` que entregue uno) en la clase bajo prueba. El handler es el punto de extensión, no el cliente. Todo lo siguiente apunta a .NET 11 (`Microsoft.NET.Sdk` 11.0.0, C# 14) con xUnit 2.9, pero el patrón es el mismo en .NET 6, 8, 9 y 10.

## Por qué mockear HttpClient directamente es una mala decisión

`HttpClient` tiene una superficie pública (`GetAsync`, `PostAsync`, `SendAsync`) que parece mockeable, y Moq te permitirá crear un mock sin quejarse. El problema es lo que esos métodos hacen en realidad: cada uno desemboca en `HttpMessageInvoker.SendAsync(HttpRequestMessage, CancellationToken)` sobre el `HttpMessageHandler` subyacente. Los métodos de conveniencia de `HttpClient` no son `virtual`, lo que significa que un `Mock<HttpClient>` o no intercepta nada, o depende de herramientas como `Protected()` de Moq para alcanzar elementos internos privados.

Dos consecuencias prácticas:

1. Las pruebas que mockean `HttpClient.GetAsync` directamente saltan silenciosamente el pipeline de handlers. Cualquier cosa que conectaste a `IHttpClientFactory`, handlers de reintento, handlers de logging, handlers de autenticación, no se ejecuta en la prueba, así que una prueba en verde puede enviar a producción una cadena de handlers rota.
2. Si cambias de `GetAsync` a `Send`, la prueba se rompe aunque el comportamiento sea idéntico.

La guía oficial de Microsoft, cualquier respuesta razonable de Stack Overflow desde 2018, y el propio código fuente de `HttpClient` apuntan al mismo punto de extensión: sustituir el `HttpMessageHandler`. El handler tiene exactamente un método para sobrescribir (`SendAsync`), es `protected internal virtual`, y es el contrato al que ya apunta el resto del pipeline.

## Un stub handler mínimo

La implementación más simple es una clase que envuelve un delegado. No requiere ningún framework de mocking:

```csharp
// .NET 11, C# 14
public sealed class StubHttpMessageHandler : HttpMessageHandler
{
    private readonly Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> _handler;
    public List<HttpRequestMessage> Requests { get; } = new();

    public StubHttpMessageHandler(
        Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> handler)
    {
        _handler = handler;
    }

    public StubHttpMessageHandler(HttpStatusCode status, string? body = null, string mediaType = "application/json")
        : this((_, _) => Task.FromResult(new HttpResponseMessage(status)
        {
            Content = body is null ? null : new StringContent(body, Encoding.UTF8, mediaType),
        }))
    {
    }

    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        Requests.Add(request);
        return _handler(request, cancellationToken);
    }
}
```

Dos constructores cubren la mayoría de las pruebas: un constructor con delegado para pruebas que necesitan inspeccionar la solicitud, y un atajo de status/body para el caso trivial de "devolver 200 con este JSON". La lista `Requests` permite a la prueba afirmar lo que se envió.

## La clase bajo prueba

Para concretar el resto, esta es la forma típica del código que la gente quiere probar:

```csharp
// .NET 11, C# 14
public sealed record Repo(int Id, string Name, int Stars);

public sealed class GitHubClient
{
    private readonly HttpClient _http;

    public GitHubClient(HttpClient http) => _http = http;

    public async Task<Repo> GetRepoAsync(string owner, string name, CancellationToken ct = default)
    {
        var path = $"/repos/{Uri.EscapeDataString(owner)}/{Uri.EscapeDataString(name)}";
        using var response = await _http.GetAsync(path, ct);
        response.EnsureSuccessStatusCode();

        var dto = await response.Content.ReadFromJsonAsync<RepoDto>(ct);
        return new Repo(dto!.Id, dto.Full_Name, dto.Stargazers_Count);
    }

    private sealed record RepoDto(int Id, string Full_Name, int Stargazers_Count);
}
```

El constructor toma un `HttpClient`, no una referencia estática y no uno recién creado. Esa única decisión de diseño es lo que hace posible todo lo de abajo.

## Una prueba que devuelve una respuesta predefinida

```csharp
// .NET 11, C# 14, xUnit 2.9
[Fact]
public async Task GetRepoAsync_returns_parsed_repo_when_api_returns_200()
{
    var json = """
    { "id": 42, "full_name": "octocat/hello-world", "stargazers_count": 1300 }
    """;

    var handler = new StubHttpMessageHandler(HttpStatusCode.OK, json);
    var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.github.com") };
    var sut = new GitHubClient(http);

    var repo = await sut.GetRepoAsync("octocat", "hello-world");

    Assert.Equal(42, repo.Id);
    Assert.Equal("octocat/hello-world", repo.Name);
    Assert.Equal(1300, repo.Stars);

    var sent = Assert.Single(handler.Requests);
    Assert.Equal(HttpMethod.Get, sent.Method);
    Assert.Equal("/repos/octocat/hello-world", sent.RequestUri!.AbsolutePath);
}
```

Tres cosas que notar. El handler se construye con un status y un body, el `HttpClient` se construye con ese handler y un `BaseAddress`, y la prueba afirma tanto el resultado parseado como la solicitud saliente. La tercera afirmación es la que la mayoría de pruebas omite y la que atrapa más regresiones, una ruta incorrecta, un header olvidado, un body que está vacío cuando no debería estarlo.

## Devolver respuestas distintas por solicitud

Para una clase que emite varias llamadas (lista paginada, reintento, GET condicional), pasa un delegado:

```csharp
// .NET 11, C# 14
[Fact]
public async Task GetRepoAsync_throws_on_404()
{
    var handler = new StubHttpMessageHandler((req, _) =>
        Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound)
        {
            RequestMessage = req,
            Content = new StringContent("""{ "message": "Not Found" }""", Encoding.UTF8, "application/json"),
        }));

    var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.github.com") };
    var sut = new GitHubClient(http);

    await Assert.ThrowsAsync<HttpRequestException>(() => sut.GetRepoAsync("octocat", "ghost"));
}
```

Para respuestas secuenciales (la primera llamada devuelve 401, la segunda devuelve 200 después de un refresco de token), mantén un contador dentro del delegado:

```csharp
// .NET 11, C# 14
var calls = 0;
var handler = new StubHttpMessageHandler((req, _) =>
{
    var status = calls++ == 0 ? HttpStatusCode.Unauthorized : HttpStatusCode.OK;
    return Task.FromResult(new HttpResponseMessage(status)
    {
        Content = new StringContent("""{ "id": 1, "full_name": "x/y", "stargazers_count": 0 }""",
                                    Encoding.UTF8, "application/json"),
    });
});
```

Esto es suficiente para casi todos los escenarios de pruebas unitarias. Sin framework de mocking, sin trucos de miembros protegidos, sin ceremonia.

## La variante con Moq, y por qué la evito

Si tu base de código ya estandariza Moq, el equivalente es:

```csharp
// .NET 11, C# 14, Moq 4.20
var handler = new Mock<HttpMessageHandler>(MockBehavior.Strict);
handler
    .Protected()
    .Setup<Task<HttpResponseMessage>>(
        "SendAsync",
        ItExpr.IsAny<HttpRequestMessage>(),
        ItExpr.IsAny<CancellationToken>())
    .ReturnsAsync(new HttpResponseMessage(HttpStatusCode.OK)
    {
        Content = new StringContent("""{ "id": 1, "full_name": "x/y", "stargazers_count": 0 }""",
                                    Encoding.UTF8, "application/json"),
    });

var http = new HttpClient(handler.Object) { BaseAddress = new Uri("https://api.github.com") };
```

Funciona. Las desventajas:

- `"SendAsync"` es una cadena. Si el framework alguna vez lo renombra (no lo hará, pero el principio se mantiene), el compilador no lo detectará.
- `Protected()` requiere `using Moq.Protected;` y obliga a cada desarrollador que lee la prueba a conocer el truco.
- Devolver una sola instancia de `HttpResponseMessage` desde una configuración de mock singleton fuga estado entre llamadas si la respuesta se enumera más de una vez. El stub handler de la sección anterior crea una respuesta nueva por llamada.

Para pruebas puntuales Moq está bien. Para una clase de prueba con cinco escenarios HTTP, el stub hecho a mano es más corto, más rápido de leer y más fácil de depurar.

## Probar a través de IHttpClientFactory

En código de producción que usa `IHttpClientFactory` (y la mayoría del código moderno lo hace), la unidad bajo prueba toma un `IHttpClientFactory` o un cliente tipado, y la factory construye un `HttpClient` con la cadena de handlers que registraste en `Program.cs`. El punto de extensión de la prueba pasa de "construir un `HttpClient` directamente" a "configurar el handler primario de la factory".

```csharp
// .NET 11, C# 14, Microsoft.Extensions.Http 11.0
[Fact]
public async Task TypedClient_uses_registered_handler_chain()
{
    var stub = new StubHttpMessageHandler(HttpStatusCode.OK,
        """{ "id": 7, "full_name": "a/b", "stargazers_count": 5 }""");

    using var provider = new ServiceCollection()
        .AddHttpClient<GitHubClient>(c => c.BaseAddress = new Uri("https://api.github.com"))
        .ConfigurePrimaryHttpMessageHandler(() => stub)
        .Services
        .BuildServiceProvider();

    var sut = provider.GetRequiredService<GitHubClient>();

    var repo = await sut.GetRepoAsync("a", "b");
    Assert.Equal(7, repo.Id);
}
```

`ConfigurePrimaryHttpMessageHandler` intercambia la base de la cadena. Cualquier otro handler que registraste (logging, retry, auth) se sigue ejecutando, que es justamente el punto. Si quieres reemplazar la cadena entera (casi nunca lo quieres), usa `AddHttpMessageHandler` más un stub handler al final, o construye el `HttpClient` manualmente como en los ejemplos anteriores.

## Verificar que un reintento de Polly realmente reintentó

Esta es la prueba que Moq vuelve dolorosa y que el stub handler vuelve trivial. Supón que tu `Program.cs` registra:

```csharp
// .NET 11, C# 14, Microsoft.Extensions.Http.Resilience 9.0
builder.Services.AddHttpClient<GitHubClient>(c => c.BaseAddress = new Uri("https://api.github.com"))
    .AddStandardResilienceHandler();
```

El handler de resiliencia estándar reintenta errores 5xx y de timeout tres veces por defecto. Para demostrarlo bajo prueba:

```csharp
// .NET 11, C# 14
[Fact]
public async Task GetRepoAsync_retries_on_503()
{
    var calls = 0;
    var handler = new StubHttpMessageHandler((_, _) =>
    {
        calls++;
        var status = calls < 3 ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.OK;
        return Task.FromResult(new HttpResponseMessage(status)
        {
            Content = new StringContent("""{ "id": 1, "full_name": "x/y", "stargazers_count": 0 }""",
                                        Encoding.UTF8, "application/json"),
        });
    });

    using var provider = new ServiceCollection()
        .AddHttpClient<GitHubClient>(c => c.BaseAddress = new Uri("https://api.github.com"))
        .AddStandardResilienceHandler()
        .Services
        .ConfigureAll<HttpClientFactoryOptions>(o => o.HttpMessageHandlerBuilderActions.Add(b =>
            b.PrimaryHandler = handler))
        .BuildServiceProvider();

    var sut = provider.GetRequiredService<GitHubClient>();
    var repo = await sut.GetRepoAsync("x", "y");

    Assert.Equal(3, calls);
    Assert.Equal(1, repo.Id);
}
```

La afirmación `Assert.Equal(3, calls)` es lo que convierte esto en una prueba de integración de la cadena de handlers. Un mock puro de `HttpClient.GetAsync` no habría invocado a Polly y la afirmación habría sido `calls == 1`, que es la falla silenciosa que advertí antes.

## Cancelación y timeout

La cancelación es directa: el stub handler recibe el `CancellationToken` y puedes hacer que lo observe.

```csharp
// .NET 11, C# 14
[Fact]
public async Task GetRepoAsync_propagates_cancellation()
{
    var handler = new StubHttpMessageHandler(async (_, ct) =>
    {
        await Task.Delay(TimeSpan.FromSeconds(5), ct);
        return new HttpResponseMessage(HttpStatusCode.OK);
    });

    var http = new HttpClient(handler) { BaseAddress = new Uri("https://x") };
    var sut = new GitHubClient(http);

    using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(50));

    await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        sut.GetRepoAsync("a", "b", cts.Token));
}
```

`HttpClient.Timeout` en sí mismo se manifiesta como un `TaskCanceledException` (con un `TimeoutException` interno desde .NET 5). Si quieres probar el comportamiento de timeout, fija `http.Timeout = TimeSpan.FromMilliseconds(50)` y haz que el handler espere con `await Task.Delay` más tiempo que eso. Consulta [Cómo cancelar una Task de larga duración en C# sin causar interbloqueo](/es/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) para los patrones de cancelación cooperativa que el código de producción ya debería seguir.

## Afirmar sobre cuerpos de solicitud

Para `POST` y `PUT`, captura y lee el contenido de la solicitud dentro del delegado del handler:

```csharp
// .NET 11, C# 14
string? captured = null;
var handler = new StubHttpMessageHandler(async (req, ct) =>
{
    captured = req.Content is null ? null : await req.Content.ReadAsStringAsync(ct);
    return new HttpResponseMessage(HttpStatusCode.Created);
});
```

Lee el body dentro del handler, no después. Una vez que `SendAsync` retorna, el stream de la solicitud puede haber sido descartado.

## Headers, cadenas de consulta y direcciones base

`BaseAddress` más una ruta relativa es la configuración más limpia, pero cuidado con la barra final. `new Uri("https://api.example.com/v1")` más una solicitud a `/users` descarta `/v1` porque el URI no tiene barra final. `https://api.example.com/v1/` más `users` (sin barra inicial) te da `/v1/users`. Pruébalo:

```csharp
// .NET 11, C# 14
Assert.Equal("/v1/users", handler.Requests[0].RequestUri!.AbsolutePath);
```

Los headers por defecto van en el `HttpClient`, no en cada solicitud, y son visibles para el handler:

```csharp
// .NET 11, C# 14
http.DefaultRequestHeaders.Add("User-Agent", "start-debugging/1.0");
// in the handler:
Assert.Contains("start-debugging/1.0", req.Headers.UserAgent.ToString());
```

## Cuándo recurrir a WireMock.Net

El enfoque del stub handler es una prueba unitaria, sin socket, sin HTTP real. Para pruebas de componente o de integración que ejercitan la pila HTTP real (TLS, negociación de contenido, transferencia chunked real, timeouts del servidor) recurre a [WireMock.Net](https://github.com/WireMock-Net/WireMock.Net):

```csharp
// .NET 11, C# 14, WireMock.Net 1.6
using var server = WireMockServer.Start();
server
    .Given(Request.Create().WithPath("/repos/octocat/hello-world").UsingGet())
    .RespondWith(Response.Create()
        .WithStatusCode(200)
        .WithHeader("Content-Type", "application/json")
        .WithBody("""{ "id": 42, "full_name": "octocat/hello-world", "stargazers_count": 1300 }"""));

var http = new HttpClient { BaseAddress = new Uri(server.Url!) };
var sut = new GitHubClient(http);
var repo = await sut.GetRepoAsync("octocat", "hello-world");
```

WireMock.Net levanta un servidor HTTP real en un puerto local. Más lento que un stub handler, más realista, más frágil (conflictos de puerto, TLS, arranque asíncrono). Lo uso para pruebas que necesitan verificar comportamientos que el framework solo realiza para sockets reales, en otro caso el stub handler es más rápido y silencioso. Para un enfoque comparable de mockeo de otras dependencias consulta [Cómo escribir un JsonConverter personalizado en System.Text.Json](/es/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/), del que ya depende el paso de deserialización en `GetRepoAsync`.

## Errores que aparecen en revisiones de código

Una lista corta de cosas que he marcado en más de un PR:

- Construir `HttpClient` dentro de la clase bajo prueba (`private readonly HttpClient _http = new();`). La prueba no puede inyectar un handler falso, así que la prueba llama a una red real o falla. Toma la dependencia.
- Usar `MockBehavior.Loose` en el mock de `HttpMessageHandler` y luego olvidar verificar la solicitud. La prueba pasa cuando el código de producción nunca llama a la API.
- Devolver la misma instancia de `HttpResponseMessage` desde múltiples llamadas de prueba. El stream de contenido se lee una sola vez, así que la segunda llamada ve un body vacío. O construye una respuesta nueva por llamada (constructor con delegado), o copia el body en un `StringContent` nuevo.
- Afirmar sobre `response.StatusCode` en lugar de comportamiento. El propósito de la prueba es lo que `GetRepoAsync` hace con un 503, no que un literal de `HttpResponseMessage` que tú construiste tenga el código de estado con el que lo construiste.
- Mockear a través de `Mock<HttpClient>` directamente. Como se cubrió arriba, esto salta la cadena de handlers y rompe silenciosamente los handlers de resiliencia o de autenticación.

El handler es el punto de extensión, lo demás se sigue. Si tu prueba necesita Moq, NSubstitute, FakeItEasy o WireMock, está bien, pero configura el punto de extensión, no la superficie.

## Enlaces de referencia

- [HttpMessageHandler.SendAsync (MS Learn)](https://learn.microsoft.com/dotnet/api/system.net.http.httpmessagehandler.sendasync)
- [Guía de IHttpClientFactory (MS Learn)](https://learn.microsoft.com/dotnet/core/extensions/httpclient-factory)
- [ConfigurePrimaryHttpMessageHandler (MS Learn)](https://learn.microsoft.com/dotnet/api/microsoft.extensions.dependencyinjection.httpclientbuilderextensions.configureprimaryhttpmessagehandler)
- [Microsoft.Extensions.Http.Resilience](https://learn.microsoft.com/dotnet/core/resilience/http-resilience)
- [WireMock.Net](https://github.com/WireMock-Net/WireMock.Net)
