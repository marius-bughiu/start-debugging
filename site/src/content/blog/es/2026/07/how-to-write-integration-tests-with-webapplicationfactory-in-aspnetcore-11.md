---
title: "Cómo escribir pruebas de integración con WebApplicationFactory<T> en ASP.NET Core 11"
description: "Guía completa de WebApplicationFactory<TEntryPoint> en ASP.NET Core 11: cómo hacer accesible el punto de entrada Program, ConfigureTestServices frente a ConfigureWebHost, reemplazar el registro de EF Core a través de IDbContextOptionsConfiguration, el nuevo hook ConfigureHostApplicationBuilder de .NET 11 preview 6, autenticación simulada, WebApplicationFactoryClientOptions y UseKestrel cuando necesitas un puerto real."
pubDate: 2026-07-26
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "testing"
  - "integration-tests"
  - "xunit"
lang: "es"
translationOf: "2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-26
---

Para escribir una prueba de integración con `WebApplicationFactory<TEntryPoint>` en ASP.NET Core 11, referencia `Microsoft.AspNetCore.Mvc.Testing` desde el proyecto de pruebas, haz accesible el punto de entrada de la aplicación agregando `public partial class Program { }` al final de `Program.cs`, y luego inyecta `WebApplicationFactory<Program>` en una clase de pruebas de xUnit mediante `IClassFixture<T>` y llama a `CreateClient()`. Ese `HttpClient` habla con tu pipeline de middleware real y con tu contenedor de inyección de dependencias real sobre un transporte en memoria, sin socket, sin puerto y sin `dotnet run`. Todo lo demás (sustituir un servicio por un doble, apuntar EF Core a otra base de datos, simular un usuario autenticado) ocurre dentro de `ConfigureWebHost` o `WithWebHostBuilder`. Este artículo apunta a .NET 11 (preview 6 al momento de escribir, GA en noviembre de 2026) con C# 14, y señala las dos APIs nuevas desde .NET 9: `UseKestrel` de .NET 10 y `ConfigureHostApplicationBuilder` de .NET 11 preview 6. Todo lo demás funciona sin cambios en .NET 8, 9 y 10.

## Qué arranca realmente la factory

`WebApplicationFactory<TEntryPoint>` no inicia tu aplicación como lo hace `dotnet run`. Usa `HostFactoryResolver` para invocar tu punto de entrada, intercepta el `IHost` justo antes de que se ejecutara, cambia la implementación del servidor por `TestServer` y te devuelve el host ya construido. Vale la pena interiorizar la consecuencia porque explica casi todo el comportamiento sorprendente:

- Tu `Program.cs` se ejecuta. Cada llamada a `builder.Services.Add*`, cada registro de middleware y cada `MapGet` se ejecutan exactamente igual que en producción.
- No se abre ningún socket de red. `TestServer` implementa `IServer` sobre un `HttpMessageHandler` en memoria, así que las solicitudes se saltan por completo la capa de transporte. Kestrel no interviene, lo que además significa que la redirección a HTTPS, la negociación de HTTP/2 y los límites de conexión no se ejercitan.
- El contenedor de inyección de dependencias es el de producción más lo que agregues en `ConfigureTestServices`. Los singletons viven durante toda la vida de la factory, así que el estado se filtra entre pruebas del mismo fixture salvo que lo reinicies.

Ese último punto es la verdadera propuesta de valor. Una prueba unitaria te dice que un handler devuelve el objeto correcto. Una prueba de integración te dice que la plantilla de ruta coincide, que el model binding parsea el cuerpo, que la política de autorización admite al llamante, que el pipeline de filtros se ejecuta en el orden correcto y que el JSON que viaja por el cable tiene los nombres de propiedad que tu cliente espera. Nada de eso se ejercita llamando al handler directamente.

## Pasos para agregar una prueba con WebApplicationFactory

1. Agrega un proyecto de pruebas y referencia `Microsoft.AspNetCore.Mvc.Testing` más una referencia de proyecto a la aplicación bajo prueba.
2. Expón el punto de entrada agregando `public partial class Program { }` al `Program.cs` de la aplicación.
3. Inyecta `WebApplicationFactory<Program>` en la clase de pruebas mediante `IClassFixture<T>` y llama a `CreateClient()`.
4. Deriva una factory propia y sobrescribe `ConfigureWebHost` cuando necesites reemplazar servicios o configuración.
5. Usa `WithWebHostBuilder` para sustituciones por prueba que no deben filtrarse al resto de la clase.
6. Reinicia el estado compartido entre pruebas, ya que el host y sus singletons se comparten en todo el fixture.

## Los paquetes

```xml
<!-- .NET 11 preview 6, test project -->
<ItemGroup>
  <PackageReference Include="Microsoft.AspNetCore.Mvc.Testing" Version="11.0.0-preview.6.*" />
  <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.14.0" />
  <PackageReference Include="xunit.v3" Version="3.1.0" />
  <PackageReference Include="xunit.runner.visualstudio" Version="3.1.0" />
</ItemGroup>

<ItemGroup>
  <ProjectReference Include="..\..\src\Orders.Api\Orders.Api.csproj" />
</ItemGroup>
```

En .NET 10 usa la versión estable `10.0.0` de `Microsoft.AspNetCore.Mvc.Testing`. Si todavía no migraste desde xUnit v2, `xunit` 2.9.x funciona igual para todo lo que sigue, salvo por la firma de `IAsyncLifetime`, que se cubre en la sección de ciclo de vida.

`Microsoft.AspNetCore.Mvc.Testing` no es específico de MVC pese al nombre. Funciona para minimal APIs, controladores, Razor Pages y Blazor Server. Además incluye un target de MSBuild que estampa un `WebApplicationFactoryContentRootAttribute` en el ensamblado de pruebas para que la factory pueda encontrar el content root de la aplicación, lo que importa para los archivos estáticos y las vistas de Razor.

## Hacer accesible el punto de entrada

Aquí es donde se detiene la mayoría de los primeros intentos. Las instrucciones de nivel superior compilan a una clase llamada `Program` cuya accesibilidad es `internal`, así que referenciarla desde un ensamblado de pruebas falla en tiempo de compilación:

```
error CS0122: 'Program' is inaccessible due to its protection level
```

La solución es una línea al final de `Program.cs`, después de `app.Run()`:

```csharp
// .NET 11, C# 14 -- Program.cs, last line
app.Run();

public partial class Program { }
```

El compilador fusiona tu declaración parcial con la generada y la clase pasa a ser pública. La alternativa es `[assembly: InternalsVisibleTo("Orders.Api.Tests")]` en el proyecto de la aplicación, que mantiene `Program` como internal pero también abre todos los demás tipos internos al ensamblado de pruebas. Elige la clase parcial salvo que tengas una razón de política para no hacerlo.

Un fallo relacionado se ve así en tiempo de ejecución:

```
System.InvalidOperationException: The entry point exited without ever building an IHost.
```

Significa que el resolver ejecutó tu `Program.cs` hasta el final sin ver nunca que se construyera un host. Las causas habituales son un `return` temprano en alguna rama de argumentos, un `Main` que llama a `Environment.Exit`, o una excepción lanzada durante el arranque que queda silenciada. Ten en cuenta que el código de arranque de la aplicación realmente se ejecuta durante la prueba, así que un `Program.cs` que lee una cadena de conexión y lanza cuando falta también lanzará aquí. La configuración de la que dependes al arrancar tiene que estar disponible para el proceso de pruebas.

## La primera prueba

Con el punto de entrada expuesto, la factory por defecto no necesita ninguna subclase:

```csharp
// .NET 11, xUnit v3
using System.Net;
using Microsoft.AspNetCore.Mvc.Testing;

public sealed class OrdersEndpointTests
    : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly HttpClient _client;

    public OrdersEndpointTests(WebApplicationFactory<Program> factory)
        => _client = factory.CreateClient();

    [Fact]
    public async Task Unknown_order_returns_404()
    {
        var response = await _client.GetAsync("/orders/does-not-exist");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Theory]
    [InlineData("/health")]
    [InlineData("/orders")]
    public async Task Endpoint_returns_json(string url)
    {
        var response = await _client.GetAsync(url);

        response.EnsureSuccessStatusCode();
        Assert.Equal("application/json; charset=utf-8",
            response.Content.Headers.ContentType?.ToString());
    }
}
```

`IClassFixture<T>` construye la factory una vez por clase de pruebas y la libera después de la última prueba de esa clase. `CreateClient` se puede llamar repetidamente; cada llamada devuelve un `HttpClient` nuevo ligado al mismo host, con su propio contenedor de cookies.

## Reemplazar servicios con ConfigureTestServices

En cuanto necesitas una pasarela de pagos falsa o una base de datos distinta, creas una subclase de la factory y sobrescribes `ConfigureWebHost`. Usa `ConfigureTestServices`, no `ConfigureServices`:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

public sealed class OrdersApiFactory : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");

        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<IPaymentGateway>();
            services.AddSingleton<IPaymentGateway, StubPaymentGateway>();
        });
    }
}
```

La distinción importa. Los callbacks de `ConfigureServices` se ejecutan en orden de registro junto con los de la propia aplicación, así que el tuyo puede ejecutarse antes de que `Program.cs` agregue su implementación. `ConfigureTestServices` se difiere deliberadamente hasta después de que el registro de servicios de la aplicación haya terminado, y eso es lo que hace fiable la sustitución por "gana el último".

"Gana el último" solo aplica cuando se resuelve un único servicio. `GetRequiredService<IPaymentGateway>()` devuelve el último registro, pero `GetRequiredService<IEnumerable<IPaymentGateway>>()` devuelve ambos, y todo lo que se inyecte como `IEnumerable<T>` (validadores, health checks, servicios hospedados, `IStartupFilter`) también verá el original. Por eso `RemoveAll<T>` aparece antes del `Add`. Para servicios registrados por clave, la inyección de dependencias de .NET 11 tiene `RemoveAllKeyed<T>`, que se combina con [el registro y la resolución de servicios por clave](/es/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/).

Para una sustitución puntual que no debe afectar al resto de la clase, usa `WithWebHostBuilder`. Devuelve una factory nueva que no comparte nada salvo la configuración que le pases:

```csharp
[Fact]
public async Task Gateway_timeout_maps_to_502()
{
    var client = _factory.WithWebHostBuilder(builder =>
    {
        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<IPaymentGateway>();
            services.AddSingleton<IPaymentGateway, TimingOutGateway>();
        });
    }).CreateClient();

    var response = await client.PostAsJsonAsync("/orders",
        new { customerId = "C-1", amount = 10m });

    Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
}
```

## La trampa del registro de EF Core

Los tutoriales escritos antes de EF Core 9 te dicen que busques y elimines el descriptor de `DbContextOptions<TContext>` antes de agregar tu propio proveedor. Ese fragmento ya no hace lo que dice. Desde EF Core 9, `AddDbContext` registra la configuración del proveedor a través de `IDbContextOptionsConfiguration<TContext>` en `Microsoft.EntityFrameworkCore.Infrastructure`, y eliminar solo `DbContextOptions<TContext>` deja intacta la configuración original de SQL Server. Entonces agregas un segundo proveedor y EF lanza:

```
System.InvalidOperationException: Only a single database provider can be registered
in a service provider. If possible, ensure that Entity Framework is managing its
service provider by removing the call to UseInternalServiceProvider.
```

El registro que hay que eliminar en EF Core 9, 10 y 11 es este:

```csharp
// .NET 11, EF Core 11
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;

builder.ConfigureTestServices(services =>
{
    var registrations = services
        .Where(d => d.ServiceType ==
            typeof(IDbContextOptionsConfiguration<OrdersDbContext>))
        .ToList();

    foreach (var registration in registrations)
    {
        services.Remove(registration);
    }

    services.AddDbContext<OrdersDbContext>(options =>
        options.UseSqlite(_connection));
});
```

Fíjate en que la conexión de SQLite es un campo de la factory, abierto una vez y mantenido abierto, porque una base de datos SQLite en memoria se destruye cuando se cierra su última conexión. No recurras aquí al proveedor en memoria de EF Core: no tiene semántica relacional, así que las claves foráneas, las restricciones de unicidad y los tipos de columna quedan sin aplicar. Si la prueba necesita demostrar que una restricción se dispara, ejecútala contra el motor real como se describe en [pruebas de integración contra un SQL Server real con Testcontainers](/es/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/), y consulta [cómo simular DbContext sin romper el seguimiento de cambios](/es/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) para los casos en que una base de datos es realmente excesiva.

## Configuración y entorno

`UseEnvironment("Testing")` es la palanca más barata: hace que `IWebHostEnvironment.EnvironmentName` devuelva `Testing`, carga `appsettings.Testing.json` si existe y permite que el código de producción se bifurque con `env.IsProduction()` sin casos especiales para pruebas.

Para ajustes individuales, la parte delicada es el momento de la sustitución. `ConfigureAppConfiguration` dentro de `ConfigureWebHost` se ejecuta después de que `WebApplication.CreateBuilder` ya retornó, así que un valor que agregues ahí es invisible para cualquier código de `Program.cs` que lea `builder.Configuration` durante el arranque, lo que incluye la mayoría de las llamadas a `AddOptions` y `Bind`. .NET 11 preview 6 agrega un hook que se ejecuta lo bastante temprano:

```csharp
// .NET 11 preview 6 and later
private static readonly KeyValuePair<string, string?>[] s_settings =
[
    new("Payments:Endpoint", "https://localhost/stub"),
    new("Features:UseNewPricing", "true"),
];

protected override void ConfigureHostApplicationBuilder(
    IHostApplicationBuilder hostApplicationBuilder)
{
    hostApplicationBuilder.Configuration.AddInMemoryCollection(s_settings);
    base.ConfigureHostApplicationBuilder(hostApplicationBuilder);
}
```

La fuente de configuración queda en su lugar antes de que `CreateBuilder` retorne, así que el código de arranque la ve. En .NET 10 y anteriores el equivalente es sobrescribir `CreateHost` y llamar a `builder.ConfigureHostConfiguration(...)` antes de `base.CreateHost(builder)`, o simplemente establecer variables de entorno en el proceso de pruebas antes de que se construya el host.

## Simular un usuario autenticado

No intentes obtener un token real en una prueba. Registra un esquema de autenticación de prueba que siempre tenga éxito y hazlo el predeterminado:

```csharp
// .NET 11, C# 14
public sealed class TestAuthHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string Scheme = "Test";

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        Claim[] claims =
        [
            new(ClaimTypes.NameIdentifier, "user-1"),
            new(ClaimTypes.Name, "Test User"),
            new("scope", "orders:write"),
        ];

        var principal = new ClaimsPrincipal(new ClaimsIdentity(claims, Scheme));
        var ticket = new AuthenticationTicket(principal, Scheme);
        return Task.FromResult(AuthenticateResult.Success(ticket));
    }
}

// in ConfigureTestServices
services.AddAuthentication(options =>
{
    options.DefaultAuthenticateScheme = TestAuthHandler.Scheme;
    options.DefaultChallengeScheme = TestAuthHandler.Scheme;
})
.AddScheme<AuthenticationSchemeOptions, TestAuthHandler>(
    TestAuthHandler.Scheme, _ => { });
```

Luego establece `client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue(TestAuthHandler.Scheme)` y la solicitud llega autenticada. Tus políticas de autorización siguen ejecutándose de verdad, y ese es el punto: esto prueba la política, no el formato del token. Si lo que realmente quieres verificar es la validación del token, esa es otra prueba, y los parámetros involucrados se cubren en [cómo configurar autenticación JWT bearer en una minimal API](/es/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/).

## Opciones del cliente que cambian la respuesta

`CreateClient` acepta un `WebApplicationFactoryClientOptions`, y dos de sus propiedades deciden habitualmente si una prueba pasa:

```csharp
var client = factory.CreateClient(new WebApplicationFactoryClientOptions
{
    AllowAutoRedirect = false,          // default true
    BaseAddress = new Uri("https://localhost"),
    HandleCookies = true,               // default true
    MaxAutomaticRedirections = 7,
});
```

`AllowAutoRedirect` vale `true` por defecto, así que un handler que devuelve `302` se sigue silenciosamente y tu aserción sobre `HttpStatusCode.Redirect` falla con `200 OK`. Desactívalo siempre que la redirección en sí sea el comportamiento bajo prueba. El `BaseAddress` de `https://localhost` importa si el pipeline incluye `UseHttpsRedirection`, porque una solicitud a `http://localhost` se responde con una redirección en lugar del recurso.

## Cuando necesitas un puerto real

`TestServer` no puede servir a un navegador. Desde .NET 10, `WebApplicationFactory` puede ejecutarse sobre Kestrel, enlazando un puerto real de loopback:

```csharp
// .NET 10 and .NET 11
var factory = new OrdersApiFactory();
factory.UseKestrel(0);      // 0 means "pick a free port"
factory.StartServer();

var client = factory.CreateClient();
// client.BaseAddress is now the real bound address, for example
// http://127.0.0.1:53127/, taken from IServerAddressesFeature
await page.GotoAsync(client.BaseAddress!.ToString());
```

`UseKestrel` debe llamarse antes de que la factory se inicialice, es decir, antes de cualquier llamada a `CreateClient` o `StartServer`, o lanza `InvalidOperationException`. Una vez que Kestrel entra en juego, `CreateClient` devuelve un `HttpClient` normal cuyo `BaseAddress` se extrajo del `IServerAddressesFeature` del servidor, de modo que Playwright o Selenium pueden manejar el mismo host que tus otras pruebas ejercitan en memoria. También hay sobrecargas `UseKestrel()` y `UseKestrel(Action<KestrelServerOptions>)` para cuando necesitas configurar límites o HTTPS.

## Ciclo de vida, liberación y estado compartido

`WebApplicationFactory<T>` es liberable, y xUnit libera el fixture por ti. Si tu factory posee recursos adicionales (una conexión SQLite, un contenedor, un directorio temporal), implementa `IAsyncLifetime` en ella. En xUnit v3 la interfaz deriva de `IAsyncDisposable` y ambos métodos devuelven `ValueTask`, así que las firmas de v2 que devolvían `Task` ya no compilan tras una migración:

```csharp
// xUnit v3
public sealed class OrdersApiFactory : WebApplicationFactory<Program>, IAsyncLifetime
{
    private readonly SqliteConnection _connection = new("DataSource=:memory:");

    public async ValueTask InitializeAsync() => await _connection.OpenAsync();

    public override async ValueTask DisposeAsync()
    {
        await _connection.DisposeAsync();
        await base.DisposeAsync();
    }
}
```

La elección del alcance es un compromiso: `IClassFixture<T>` arranca un host por clase de pruebas, `ICollectionFixture<T>` comparte un host entre todas las clases de la colección (y las serializa), y un fixture de ensamblado comparte uno para toda la ejecución. El arranque del host suele tardar entre 200 y 500 ms, así que por clase es un valor predeterminado razonable, pero recuerda que todos los singletons de la aplicación se comparten durante ese tiempo. Una caché, un contador `static`, un `IMemoryCache` o un outbox en proceso arrastrarán estado de una prueba a la siguiente. Reinícialo explícitamente en la prueba, o reduce el alcance del fixture.

Para cualquier cosa que dependa del reloj, no duermas. Registra `TimeProvider` en la aplicación y sustitúyelo por `FakeTimeProvider` en `ConfigureTestServices`, como se describe en [cómo probar código dependiente del tiempo con TimeProvider y FakeTimeProvider](/es/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/). Y cuando la aplicación hace llamadas HTTP hacia afuera, reemplaza el handler en lugar del cliente, siguiendo el patrón de [cómo hacer pruebas unitarias de código que usa HttpClient](/es/2026/04/how-to-unit-test-code-that-uses-httpclient/).

Una última trampa: `xunit.runner.visualstudio` hace shadow copy de los ensamblados de prueba por defecto en algunas configuraciones, lo que rompe el descubrimiento del content root del que dependen los archivos estáticos y las vistas de Razor. Si una página se renderiza en producción pero da 404 en una prueba, agrega `xunit.runner.json` con `"shadowCopy": false` y configúralo para que se copie al directorio de salida.

El modelo mental que mantiene todo esto ordenado es que `WebApplicationFactory` es tu host de producción con exactamente dos cosas cambiadas: la implementación del servidor y lo que sustituyas deliberadamente en `ConfigureTestServices`. Cada sorpresa que produce se remonta a algo de tu ruta de arranque real que olvidaste que iba a ejecutarse.

## Relacionado

- [Cómo escribir pruebas de integración contra un SQL Server real con Testcontainers](/es/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/)
- [Cómo probar código dependiente del tiempo con TimeProvider y FakeTimeProvider en .NET 11](/es/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/)
- [Cómo hacer pruebas unitarias de código que usa HttpClient](/es/2026/04/how-to-unit-test-code-that-uses-httpclient/)
- [Cómo configurar autenticación JWT bearer en una minimal API en ASP.NET Core 11](/es/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/)
- [Cómo registrar y resolver servicios por clave en la inyección de dependencias de .NET 11](/es/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/)
- [WebApplication.CreateBuilder frente a CreateSlimBuilder y CreateEmptyBuilder en ASP.NET Core 11](/es/2026/07/webapplication-createbuilder-vs-createslimbuilder-vs-createemptybuilder-in-aspnetcore-11/)

## Fuentes

- [Pruebas de integración en ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/test/integration-tests)
- [WebApplicationFactory&lt;TEntryPoint&gt;.UseKestrel (referencia de API)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.testing.webapplicationfactory-1.usekestrel)
- [Código fuente de WebApplicationFactory.cs (dotnet/aspnetcore)](https://github.com/dotnet/aspnetcore/blob/main/src/Mvc/Mvc.Testing/src/WebApplicationFactory.cs)
- [IDbContextOptionsConfiguration&lt;TContext&gt; (referencia de API de EF Core)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.infrastructure.idbcontextoptionsconfiguration-1)
- [Migrar pruebas unitarias de xUnit v2 a v3](https://xunit.net/docs/getting-started/v3/migration)
