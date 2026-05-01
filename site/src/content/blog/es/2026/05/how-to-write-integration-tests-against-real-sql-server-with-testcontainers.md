---
title: "Cómo escribir pruebas de integración contra un SQL Server real con Testcontainers"
description: "Una guía completa para ejecutar pruebas de integración de ASP.NET Core contra un SQL Server 2022 real usando Testcontainers 4.11 y EF Core 11: cableado de WebApplicationFactory, IAsyncLifetime, sustitución del registro del DbContext, aplicación de migraciones, paralelismo, limpieza con Ryuk y trampas de CI."
pubDate: 2026-05-01
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "testing"
  - "integration-tests"
  - "testcontainers"
  - "sql-server"
lang: "es"
translationOf: "2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers"
translatedBy: "claude"
translationDate: 2026-05-01
---

Para ejecutar pruebas de integración contra un SQL Server real desde un proyecto de pruebas en .NET 11, instala `Testcontainers.MsSql` 4.11.0, construye un `WebApplicationFactory<Program>` que sea dueño de un `MsSqlContainer`, arranca el contenedor en `IAsyncLifetime.InitializeAsync`, sobrescribe el registro del `DbContext` en `ConfigureWebHost` para que apunte a `container.GetConnectionString()` y aplica las migraciones una sola vez antes de la primera prueba. Usa `IClassFixture<T>` para que xUnit comparta un mismo contenedor entre las pruebas de una clase. Fija la imagen de SQL Server a una etiqueta específica, por defecto `mcr.microsoft.com/mssql/server:2022-CU14-ubuntu-22.04`, y deja que Ryuk se encargue de eliminar el contenedor si tu proceso falla. Esta guía está escrita contra .NET 11 preview 3, C# 14, EF Core 11, xUnit 2.9 y Testcontainers 4.11. El patrón no cambia en .NET 8, 9 ni 10; solo se mueven las versiones de los paquetes.

## Por qué un SQL Server real y no el proveedor en memoria

EF Core trae un proveedor en memoria y una opción SQLite en memoria que se parecen a SQL Server hasta que dejan de hacerlo. El proveedor en memoria no tiene comportamiento relacional alguno: nada de transacciones, nada de aplicación de claves foráneas, nada de tokens de concurrencia `RowVersion`, nada de traducción a SQL. SQLite sí es un motor relacional real, pero usa un dialecto SQL distinto, otra forma de citar identificadores y un tipo decimal diferente. Los problemas concretos que quieres que tus pruebas de integración detecten, como un índice ausente, una violación de restricción única, un truncamiento de `nvarchar` o una pérdida de precisión en `DateTime2`, quedan silenciosamente enmascarados.

La documentación oficial de EF Core llegó a añadir hace años un aviso de "no pruebes contra in-memory", y el patrón recomendado por el equipo en la página [testing without your production database system](https://learn.microsoft.com/en-us/ef/core/testing/choosing-a-testing-strategy) es "levanta uno real en un contenedor". Testcontainers convierte eso en una sola llamada de método. La contrapartida es el coste de arranque en frío de descargar y arrancar una imagen de SQL Server (entre 8 y 12 segundos con un demonio Docker en caliente), pero cada aserción que hagas a partir de ahí la evalúa el motor que corre en producción.

## Fija la imagen, no la dejes flotando

Antes de escribir código, decide la etiqueta de imagen. La documentación de Testcontainers usa por defecto `mcr.microsoft.com/mssql/server:2022-CU14-ubuntu-22.04`, que es la opción correcta por la misma razón por la que no usas `:latest` en producción: una pipeline de CI que funcionaba ayer tiene que funcionar hoy. Una nueva actualización acumulativa no es una mejora gratuita en tu pipeline de pruebas porque cada CU puede cambiar el optimizador, modificar los esquemas de `sys.dm_*` y subir el nivel mínimo de parche para herramientas como `sqlpackage`.

La imagen `2022-CU14-ubuntu-22.04` pesa aproximadamente 1,6 GB comprimida, y la primera descarga en un runner de CI nuevo es la parte más lenta de la suite. Cachea esa capa en tu CI: GitHub Actions tiene `docker/setup-buildx-action` con `cache-from`, y Azure DevOps cachea `~/.docker` con el mismo efecto. Tras la primera caché caliente, las descargas tardan unos 2 segundos.

Si necesitas características de SQL Server 2025 (búsqueda vectorial, `JSON_CONTAINS`, ver [SQL Server 2025 JSON contains in EF Core 11](/es/2026/04/efcore-11-json-contains-sql-server-2025/)), sube la etiqueta a `2025-CU2-ubuntu-22.04`. En caso contrario quédate en 2022, porque la imagen developer de 2022 es la más probada por los mantenedores de Testcontainers.

## Los paquetes que necesitas

Tres paquetes cubren el camino feliz:

```xml
<!-- .NET 11, xUnit-based test project -->
<ItemGroup>
  <PackageReference Include="Testcontainers.MsSql" Version="4.11.0" />
  <PackageReference Include="Microsoft.AspNetCore.Mvc.Testing" Version="9.0.0" />
  <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0" />
</ItemGroup>
```

`Testcontainers.MsSql` arrastra el paquete `Testcontainers` base y el `MsSqlBuilder`. `Microsoft.AspNetCore.Mvc.Testing` aporta `WebApplicationFactory<TEntryPoint>`, que arranca todo tu contenedor de DI y la pipeline HTTP contra un `TestServer`. `Microsoft.EntityFrameworkCore.SqlServer` es lo que tu código de producción ya referencia; el proyecto de pruebas lo añade para que el fixture pueda aplicar migraciones.

Si tus pruebas corren en xUnit, añade además `xunit` 2.9.x y `xunit.runner.visualstudio` 2.8.x. Si trabajas con NUnit o MSTest el mismo patrón de fábrica funciona, solo cambian los nombres de los hooks de ciclo de vida.

## La clase fábrica

La fábrica de pruebas de integración hace tres cosas: posee el ciclo de vida del contenedor, expone la cadena de conexión a la DI del host y aplica el esquema antes de que se ejecute cualquier prueba. Aquí tienes la implementación completa contra un hipotético `OrdersDbContext`:

```csharp
// .NET 11, C# 14, EF Core 11, Testcontainers 4.11
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Testcontainers.MsSql;
using Xunit;

public sealed class OrdersApiFactory
    : WebApplicationFactory<Program>, IAsyncLifetime
{
    private readonly MsSqlContainer _sql = new MsSqlBuilder()
        .WithImage("mcr.microsoft.com/mssql/server:2022-CU14-ubuntu-22.04")
        .WithPassword("Strong!Passw0rd_for_tests")
        .Build();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<DbContextOptions<OrdersDbContext>>();
            services.AddDbContext<OrdersDbContext>(opts =>
                opts.UseSqlServer(_sql.GetConnectionString()));
        });
    }

    public async Task InitializeAsync()
    {
        await _sql.StartAsync();

        using var scope = Services.CreateScope();
        var db = scope.ServiceProvider
            .GetRequiredService<OrdersDbContext>();
        await db.Database.MigrateAsync();
    }

    public new async Task DisposeAsync()
    {
        await _sql.DisposeAsync();
        await base.DisposeAsync();
    }
}
```

Hay tres detalles que merecen una pausa. El contenedor se construye en el inicializador de campo, pero solo se arranca en `InitializeAsync` porque xUnit invoca ese método exactamente una vez por fixture. El host (y por tanto el contenedor de DI) lo construye `WebApplicationFactory` de forma perezosa la primera vez que lees `Services` o llamas a `CreateClient`, así que cuando `InitializeAsync` ejecuta `Services.CreateScope()` el contenedor de SQL ya está arriba y la cadena de conexión está cableada. La línea `RemoveAll<DbContextOptions<OrdersDbContext>>` no es negociable: si la omites acabas con dos registros, y `services.AddDbContext` se convierte en el segundo, lo que en silencio mantiene los dos según el orden del resolutor.

La llamada a `WithPassword` define la contraseña de SA. La política de contraseñas de SQL Server exige al menos ocho caracteres y una mezcla de mayúsculas, minúsculas, dígitos y símbolos; si pones una más débil el contenedor arranca pero el motor falla los chequeos de salud. La contraseña por defecto de SA en Testcontainers es `yourStrong(!)Password`, que ya cumple la política, así que omitir `.WithPassword` también funciona.

## Usar la fábrica en una clase de pruebas

`IClassFixture<T>` de xUnit es el ámbito adecuado para la mayoría de los casos. Construye el fixture una vez, ejecuta cada método de prueba de la clase contra el mismo contenedor SQL y luego lo libera:

```csharp
// .NET 11, xUnit 2.9
public sealed class OrdersApiTests : IClassFixture<OrdersApiFactory>
{
    private readonly OrdersApiFactory _factory;
    private readonly HttpClient _client;

    public OrdersApiTests(OrdersApiFactory factory)
    {
        _factory = factory;
        _client = factory.CreateClient();
    }

    [Fact]
    public async Task Post_creates_order_and_returns_201()
    {
        var response = await _client.PostAsJsonAsync("/orders",
            new { customerId = "C-101", amount = 49.99m });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
    }

    [Fact]
    public async Task Get_returns_persisted_order()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<OrdersDbContext>();
        db.Orders.Add(new Order { Id = "O-1", CustomerId = "C-101" });
        await db.SaveChangesAsync();

        var response = await _client.GetAsync("/orders/O-1");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }
}
```

Si necesitas un contenedor nuevo para cada prueba (por ejemplo, cuando una prueba reescribe el esquema), usa `IAsyncLifetime` directamente en la clase de pruebas en lugar de `IClassFixture`. Es raro: en nueve casos de cada diez quieres pagar el coste de arranque en frío una vez por clase, y restableces el estado truncando tablas, no reiniciando.

## Restablece el estado entre pruebas, no reinicies el contenedor

El coste honesto de las pruebas con "SQL Server real" es la fuga de estado: la prueba A inserta filas, la prueba B asegura un conteo y obtiene un resultado equivocado. Hay tres soluciones, ordenadas por velocidad:

1. **Truncar al inicio de cada prueba.** Lo más barato. Mantén un `static readonly string[] TablesInTruncationOrder` y ejecuta `TRUNCATE TABLE` contra cada una. Es lo que recomiendan los mantenedores de Testcontainers en su ejemplo de ASP.NET Core.
2. **Envuelve cada prueba en una transacción y haz rollback al final.** Funciona si tu código bajo prueba no llama por sí mismo a `BeginTransaction`. EF Core 11 sigue sin permitir transacciones anidadas en SQL Server sin una llamada a `EnlistTransaction`.
3. **Usa `Respawn`** ([paquete en NuGet](https://www.nuget.org/packages/Respawn)). Genera el script de truncado una vez leyendo el information schema, lo cachea y lo ejecuta antes de cada prueba. Es lo que la mayoría de equipos grandes acaba adoptando tras unos cientos de pruebas.

Elijas lo que elijas, **no** llames a `EnsureDeletedAsync` y `MigrateAsync` entre pruebas. El runner de migraciones de EF Core tarda algunos segundos incluso para un esquema pequeño; multiplícalo por 200 pruebas y tu suite pasa de 30 segundos a 30 minutos. Para los compromisos sobre el ciclo de vida del DbContext en pruebas, ver [removing pooled DbContextFactory in EF Core 11 test swaps](/es/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/) y las notas relacionadas sobre [warming up the EF Core model](/es/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/).

## Ejecución paralela de pruebas

xUnit ejecuta clases de prueba en paralelo por defecto. Con un contenedor por fixture de clase eso significa N clases encendiendo M contenedores a la vez, donde M está limitado por la memoria de tu host Docker. Un SQL Server consume alrededor de 1,5 GB de RAM por instancia en reposo, así que un runner de GitHub Actions de 16 GB se queda en torno a ocho clases paralelas antes de empezar a hacer swap.

Dos perillas habituales:

```xml
<!-- xunit.runner.json in the test project, copy to output -->
{
  "parallelizeTestCollections": true,
  "maxParallelThreads": 4
}
```

```csharp
// or, opt-out per assembly
[assembly: CollectionBehavior(MaxParallelThreads = 4)]
```

Si usas un atributo `[Collection]` para compartir un contenedor entre varias clases, esas clases se serializan. A veces es la decisión correcta: un contenedor caliente, peor reloj de pared por prueba, mucha menos presión de RAM.

## Qué hace Ryuk y por qué deberías dejarlo activado

Testcontainers despliega un sidecar llamado Ryuk (imagen `testcontainers/ryuk`). Cuando arranca el proceso .NET, Ryuk se conecta al demonio de Docker y vigila al proceso padre. Si tu test runner cae, entra en pánico o recibe `kill -9`, Ryuk detecta que el padre ha desaparecido y elimina los contenedores etiquetados. Sin Ryuk, una ejecución de pruebas que casca deja contenedores SQL Server huérfanos y la siguiente ejecución choca con conflictos de puerto o se queda sin RAM.

Ryuk está activo por defecto. A veces se recomienda desactivarlo (`TESTCONTAINERS_RYUK_DISABLED=true`) en entornos de CI restringidos, pero entonces la carga de limpieza recae en tu CI. Si tienes que desactivarlo, añade un paso post-job que ejecute `docker container prune -f --filter "label=org.testcontainers=true"`.

## Trampas de CI

Los runners de GitHub Actions traen Docker preinstalado en runners Linux (`ubuntu-latest`) pero no en macOS ni Windows. Fíjate en Linux para el contenedor SQL o paga el coste de `docker/setup-docker-action`. Los agentes Linux hospedados por Microsoft en Azure DevOps funcionan igual; en agentes Windows autohospedados necesitas Docker Desktop con backend WSL2 y una imagen de SQL Server que coincida con la arquitectura del host.

La otra cosa que muerde a los equipos son la zona horaria y la cultura. La imagen base de Ubuntu está en UTC; si tus pruebas comparan contra `DateTime.Now` pasarán localmente y fallarán en CI. Usa `DateTime.UtcNow` en todas partes o inyecta `TimeProvider` (incluido en .NET 8 y posteriores) y siembra una hora determinista.

## Verificar que el contenedor arrancó de verdad

Si una prueba falla con `A network-related or instance-specific error occurred`, el contenedor no terminó de arrancar antes de que EF Core abriera una conexión. El módulo MsSql de Testcontainers trae una estrategia de espera incorporada que hace polling hasta que el motor responde, así que esto solo ocurre si la has reemplazado. Confírmalo con:

```csharp
// peek at the dynamic host port
var port = _sql.GetMappedPublicPort(MsSqlBuilder.MsSqlPort);
Console.WriteLine($"SQL is listening on localhost:{port}");
```

La estrategia de espera usa `sqlcmd` dentro del contenedor; si tu imagen de SQL Server no incluye `sqlcmd` (imágenes más antiguas), pasa `.WithWaitStrategy(Wait.ForUnixContainer().UntilCommandIsCompleted("/opt/mssql-tools18/bin/sqlcmd", "-Q", "SELECT 1"))` para sobrescribirla.

## Dónde deja de bastar este enfoque

Testcontainers te da un SQL Server real. No te da Always On, enrutado por sharding ni búsqueda full-text repartida en varios archivos. Si tu base de datos en producción es un clúster configurado, tus pruebas de integración corren contra un solo nodo y tu suite tiene una laguna de cobertura conocida. Documéntala y escribe pruebas más pequeñas y dirigidas contra un entorno de staging para el comportamiento específico del clúster, ver [unit testing code that uses HttpClient](/es/2026/04/how-to-unit-test-code-that-uses-httpclient/) para el patrón que gestiona las llamadas a la API de staging.

Lo que el proveedor en memoria le enseñó a una generación de equipos .NET es que "pasa en local" no es una señal de despliegue. Base de datos real, puerto real, bytes reales en el cable, pagados con 10 segundos de arranque en frío. Un seguro barato.

## Relacionado

- [How to mock DbContext without breaking change tracking](/es/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/)
- [Removing pooled DbContextFactory for cleaner test swaps in EF Core 11](/es/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/)
- [Warm up the EF Core model before the first query](/es/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/)
- [Single-step migrations with `dotnet ef update --add` in EF Core 11](/es/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/)
- [Unit-testing code that uses HttpClient](/es/2026/04/how-to-unit-test-code-that-uses-httpclient/)

## Fuentes

- [Microsoft SQL Server module (Testcontainers for .NET docs)](https://dotnet.testcontainers.org/modules/mssql/)
- [ASP.NET Core example (Testcontainers for .NET docs)](https://dotnet.testcontainers.org/examples/aspnet/)
- [Testcontainers.MsSql 4.11.0 on NuGet](https://www.nuget.org/packages/Testcontainers.MsSql)
- [Choosing a testing strategy (EF Core docs)](https://learn.microsoft.com/en-us/ef/core/testing/choosing-a-testing-strategy)
- [Respawn package on NuGet](https://www.nuget.org/packages/Respawn)
