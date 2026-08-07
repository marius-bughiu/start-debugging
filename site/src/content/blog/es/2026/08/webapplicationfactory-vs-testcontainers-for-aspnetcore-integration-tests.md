---
title: "WebApplicationFactory vs Testcontainers para pruebas de integración en ASP.NET Core"
description: "No son alternativas. WebApplicationFactory arranca tu aplicación, Testcontainers arranca sus dependencias. Medido en .NET SDK 10.0.201: un fixture con contenedor cuesta 1,7 s por clase frente a 10 ms con SQLite, y una violación de HasMaxLength(16) que Postgres rechaza con 22001 SQLite la acepta en silencio."
pubDate: 2026-08-07
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "aspnetcore"
  - "testing"
  - "integration-tests"
  - "testcontainers"
  - "ef-core"
lang: "es"
translationOf: "2026/08/webapplicationfactory-vs-testcontainers-for-aspnetcore-integration-tests"
translatedBy: "claude"
translationDate: 2026-08-07
---

Usa ambos. `WebApplicationFactory<T>` arranca tu aplicación; Testcontainers arranca aquello con lo que tu aplicación habla. La única decisión que realmente tienes que tomar es qué respalda tu capa de datos, y la respuesta es: si la prueba verifica algo que la base de datos impone, necesitas una base de datos real en un contenedor. Si verifica enrutamiento, enlace de modelos, autorización o la forma del JSON, sáltate Docker y paga 10 ms en lugar de 1,7 segundos.

Todo lo que sigue se midió en .NET SDK 10.0.201 con `Microsoft.AspNetCore.Mvc.Testing` 10.0.1, `Testcontainers.PostgreSql` 4.13.0, EF Core 10.0.1 y `postgres:17.6-alpine`, sobre Docker Desktop 29.5.3 (backend WSL2, 20 CPU asignadas) en un Intel Core Ultra 7 265KF con 32 GB de RAM, Windows 11 26200. Las API no cambian en .NET 11 preview.

## Las tres configuraciones que la gente realmente quiere decir

"WebApplicationFactory vs Testcontainers" es una pregunta mal planteada, porque ambos viven en capas distintas. Entre lo que la gente elige es entre una de estas tres configuraciones:

| | A. WAF + fake en proceso | B. WAF + Testcontainers | C. Testcontainers de punta a punta |
| --- | --- | --- | --- |
| Dónde corre la app | En tu proceso de pruebas | En tu proceso de pruebas | En un contenedor que compilaste |
| Transporte | `TestServer`, sin socket | `TestServer`, sin socket | Socket real, Kestrel real |
| Base de datos | SQLite / en memoria / mock | Motor real en un contenedor | Motor real en un contenedor |
| Requiere Docker | No | Sí | Sí |
| Costo del fixture (medido) | ~10 ms | ~1,7 s | ~1,7 s más compilar la imagen |
| Permite poner un punto de interrupción en el código de la app | Sí | Sí | No |
| Permite reemplazar un servicio por un fake | Sí | Sí | No |
| Prueba tu Dockerfile / entrypoint | No | No | Sí |
| Prueba HTTPS, HTTP/2, límites de Kestrel | No | No | Sí |
| Detecta violaciones de restricciones en la base de datos | No (ver abajo) | Sí | Sí |

A y B son el mismo código con una cadena de conexión distinta. C es algo genuinamente diferente y es la única fila donde el "vs" es una disyuntiva real, porque en C pierdes `ConfigureTestServices` por completo: la aplicación es un artefacto sellado y solo puedes hablarle por HTTP.

La mayoría de los equipos quiere B, recurre a A porque Docker le pareció lento, y nunca evalúa C en serio. Los números de abajo dicen que A es más barato de lo que crees que es caro, que B es más barato de lo que crees, y que la razón para elegir B no tiene nada que ver con el rendimiento.

## La medición

El sistema bajo prueba es una minimal API con un `POST /orders` que escribe a través de EF Core y un `GET /orders` que lee de vuelta. `Order.Sku` está configurado con `HasMaxLength(16)` y un índice único. El banco de pruebas arranca un factory nuevo tres veces por configuración, en el mismo proceso, de modo que la ronda 1 incluye el JIT y la construcción del modelo de EF, y las rondas 2 y 3 muestran el estado estacionario.

```csharp
// .NET 10.0.201, C# 14, Mvc.Testing 10.0.1, Testcontainers.PostgreSql 4.13.0
var sw = Stopwatch.StartNew();
var pg = new PostgreSqlBuilder("postgres:17.6-alpine").Build();
await pg.StartAsync();
var containerStart = sw.ElapsedMilliseconds;

sw.Restart();
await using var factory = new PostgresFactory(pg.GetConnectionString());
var client = factory.CreateClient();
var boot = sw.ElapsedMilliseconds;
```

Configuración A, `WebApplicationFactory<T>` sobre una conexión SQLite en memoria, sin Docker:

| Ronda | Arranque del factory | Creación del esquema | Primera solicitud | 100 escrituras | 100 lecturas |
| --- | --- | --- | --- | --- | --- |
| 1 | 129 ms | 309 ms | 64 ms | 205 ms | 193 ms |
| 2 | 11 ms | 2 ms | 4 ms | 49 ms | 70 ms |
| 3 | 4 ms | 7 ms | 3 ms | 49 ms | 67 ms |

Configuración B, el mismo factory apuntando a una instancia de PostgreSQL levantada con Testcontainers, con la imagen ya descargada:

| Ronda | Arranque del contenedor | Arranque del factory | Creación del esquema | Primera solicitud | 100 escrituras | 100 lecturas | Apagado |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 2 933 ms | 5 ms | 198 ms | 4 ms | 210 ms | 191 ms | 321 ms |
| 2 | 1 403 ms | 5 ms | 42 ms | 6 ms | 131 ms | 197 ms | 300 ms |
| 3 | 1 424 ms | 4 ms | 32 ms | 5 ms | 81 ms | 81 ms | 306 ms |

De aquí salen dos cosas que contradicen el saber popular.

**El factory en sí es gratis en ambos casos.** Arrancar `WebApplicationFactory<T>` cuesta de 4 a 5 ms una vez que el proceso está caliente, sea cual sea la base de datos detrás. Cuando alguien dice "las pruebas de integración son lentas", casi nunca está hablando de `TestServer`.

**El costo por solicitud es prácticamente el mismo.** 100 idas y vueltas a través de todo el pipeline de middleware, el enlace de modelos, EF Core y de regreso cuestan 49 ms contra SQLite y 81 ms contra un Postgres en contenedor en estado estacionario. Eso es 0,3 ms de diferencia por solicitud, sobre un socket de loopback hacia WSL2. Que la base de datos sea real no es lo que hace lenta a tu suite.

Lo caro es el fixture: alrededor de 1,7 segundos entre arrancar y apagar el contenedor, por fixture, frente a unos 10 ms de la opción en proceso. Multiplícalo por la cantidad de clases de prueba que tienen cada una su propio contenedor y ahí está tu respuesta. Una suite con 40 fixtures con contenedor propio gasta 68 segundos sin hacer otra cosa que arrancar y apagar Postgres.

Vale la pena mencionar el costo en frío por separado, porque es lo que paga tu primera ejecución de CI: descargar `postgres:17.6-alpine` desde cero tomó 11,3 segundos para una imagen de 106 MB. Ese es el extremo barato. Una imagen de desarrollo de SQL Server es más de un orden de magnitud mayor, y por eso la [guía de Testcontainers con SQL Server](/es/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) dedica una sección a cachear esa capa en CI.

## El resultado que decide la cuestión

El rendimiento no es el eje. Este sí lo es:

```csharp
// .NET 10.0.201, EF Core 10.0.1
// Order.Sku is configured HasMaxLength(16)
db.Orders.Add(new Order { Sku = "TOOLONGSKU-0123456789", Total = 1m });
await db.SaveChangesAsync();
```

Contra el contenedor:

```
postgres: 22001: value too long for type character varying(16)
```

Contra SQLite en memoria:

```
sqlite:   ACCEPTED, stored 21 chars
```

SQLite no impone longitud en `varchar`. EF Core emite fielmente `TEXT` para una cadena con `HasMaxLength(16)`, SQLite guarda los 21 caracteres sin protestar, y la prueba que debía demostrar que tu validación funciona pasa. En producción esa misma escritura lanza una excepción. Esa única divergencia es todo el argumento, y se generaliza: SQLite difiere de Postgres y de SQL Server en la precisión de los decimales, en la sensibilidad a mayúsculas de los identificadores, en la precisión de `DateTime`, en el comportamiento de escrituras concurrentes y en casi cualquier consulta `FromSql` que llegues a escribir. El proveedor en memoria de EF Core es todavía peor, porque no impone ninguna semántica relacional.

Así que la regla no es "usa siempre Testcontainers" ni es "Testcontainers es demasiado lento". Es: **en el momento en que lo que verifica una prueba depende de algo que impone el motor de base de datos, una base de datos falsa convierte esa prueba en una mentira.** Violaciones de restricciones, borrados en cascada, tokens de concurrencia `rowversion` (ver [concurrencia optimista con un token rowversion](/es/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/)), SQL crudo, migraciones y todo lo que toque el traductor de consultas pertenecen a la configuración B.

## Cuándo elegir cada una

**Elige A (WAF, sin Docker) cuando** la prueba trata sobre la superficie HTTP. ¿`/orders/{id:int}` rechaza `abc` con un 400? ¿El atributo `[Authorize(Policy = "Admin")]` devuelve 403 para alguien que no es administrador? ¿La respuesta serializa `total` como número y no como cadena? ¿El manejador de excepciones produce un cuerpo `ProblemDetails`? A nada de eso le importa si la base de datos es real, y muchas de esas pruebas ni siquiera necesitan una base de datos: registra un repositorio de mentira mediante `ConfigureTestServices` y sáltate la persistencia por completo. Estas son las pruebas que quieres correr con cada tecla que pulsas, y con 10 ms de preparación pueden hacerlo.

**Elige B (WAF + Testcontainers) cuando** lo que verificas llega al motor de almacenamiento. Esta es la opción por defecto para pruebas de repositorios, pruebas de consultas de EF Core, verificación de migraciones y cualquier endpoint cuyo comportamiento interesante sea una ruta de error de la base de datos. También es la única forma honesta de comprobar que tus migraciones realmente se aplican sobre una base de datos vacía, que es una clase de falla que ningún fake detecta y que tumba producción.

**Elige C (todo en contenedores) cuando** el artefacto es lo que está bajo prueba. Estás verificando que el Dockerfile produce una imagen ejecutable, que el entrypoint lee las variables de entorno que define tu chart de Helm, que TLS termina correctamente o que la negociación de HTTP/2 funciona. `TestServer` no puede decirte nada de esto porque nunca abre un socket. C es un puñado de pruebas de humo al final del pipeline, no una estrategia de pruebas.

## Cómo abaratar B: reutilización

Los 1,7 segundos por fixture no son un costo fijo. Testcontainers admite reutilización de contenedores desde hace tiempo, y eso convierte el costo del fixture en un detalle irrelevante durante el desarrollo local:

```csharp
// Testcontainers 4.13.0
var pg = new PostgreSqlBuilder("postgres:17.6-alpine")
    .WithReuse(true)
    .Build();
await pg.StartAsync();
// deliberately not disposed: reuse keeps the container alive between runs
```

Medido en tres arranques consecutivos dentro del mismo proceso:

| Arranque | Duración | ID del contenedor |
| --- | --- | --- |
| 1 | 1 812 ms | `81ae62b0f2b4` |
| 2 | 103 ms | `81ae62b0f2b4` |
| 3 | 81 ms | `81ae62b0f2b4` |

El mismo contenedor, 81 ms en lugar de 1 812. La reutilización se resuelve por un hash de la configuración del contenedor, así que cambiar la etiqueta de la imagen, el entorno o el mapeo de puertos produce correctamente un contenedor nuevo.

El detalle a cuidar es la limpieza. La documentación de Testcontainers es explícita en que activar la reutilización desactiva el resource reaper, así que Ryuk no va a eliminar el contenedor por ti, y llamar a `DisposeAsync()` sobre un contenedor reutilizable lo detiene en vez de borrarlo. Un contenedor rancio que arrastra el esquema de la semana pasada seguirá atendiendo tus pruebas tan campante hasta que lo elimines a mano. Esa propiedad de conservar estado entre ejecuciones es lo que hace de la reutilización una optimización para desarrollo local y no para CI: ponla detrás de una comprobación de variables de entorno para que tu pipeline siempre reciba un motor limpio.

Ten en cuenta que, a diferencia de la implementación en Java, Testcontainers para .NET no requiere ninguna activación en `~/.testcontainers.properties`. `WithReuse(true)` basta por sí solo, lo cual es cómodo y también la razón por la que el control queda de tu lado.

La otra palanca, que importa más en CI, es compartir un contenedor entre muchas clases de prueba en lugar de uno por clase. En xUnit eso es un collection fixture o un assembly fixture en vez de `IClassFixture<T>`; las diferencias entre frameworks están cubiertas en la [comparación entre xUnit v3, NUnit y MSTest](/es/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/). Comparte el contenedor, aísla los datos: dale a cada clase de prueba su propio esquema o su propia base de datos en el servidor compartido, o limpia con un truncate entre pruebas.

## Tres errores con los que te vas a topar al montar esto

Los tres salieron de construir el banco de pruebas de este artículo, con las versiones actuales de los paquetes.

**`Solution root could not be located using application root`.** `WebApplicationFactory<T>` localiza el content root de la aplicación subiendo por el árbol de directorios desde el ensamblado de pruebas en busca de un archivo `.sln` o `.slnx`, a menos que el target de MSBuild de `Microsoft.AspNetCore.Mvc.Testing` haya estampado un `WebApplicationFactoryContentRootAttribute` en tu ensamblado de pruebas. Un proyecto de pruebas que no forma parte de un archivo de solución, algo cada vez más común con las estructuras de la era `dotnet run app.cs`, falla en el primer `CreateClient()`. O agregas los proyectos a una solución, o sobrescribes `CreateHost` y defines el content root explícitamente.

**`Services for database providers 'Npgsql.EntityFrameworkCore.PostgreSQL', 'Microsoft.EntityFrameworkCore.Sqlite' have been registered in the service provider. Only a single database provider can be registered in a service provider.`** Este es el clásico fallo al reemplazar el `DbContext`, y el consejo que vas a encontrar en Stack Overflow está desactualizado. Quitar `DbContextOptions<TContext>` ya no basta, porque `AddDbContext` en EF Core 9 y posteriores también registra un `IDbContextOptionsConfiguration<TContext>` que sigue arrastrando el proveedor de producción. Quita los tres:

```csharp
// .NET 10.0.201, EF Core 10.0.1
protected override void ConfigureWebHost(IWebHostBuilder builder)
{
    builder.ConfigureTestServices(services =>
    {
        services.RemoveAll(typeof(IDbContextOptionsConfiguration<OrdersDbContext>));
        services.RemoveAll(typeof(DbContextOptions<OrdersDbContext>));
        services.RemoveAll(typeof(DbContextOptions));
        services.AddDbContext<OrdersDbContext>(o => o.UseNpgsql(_connectionString));
    });
}
```

La alternativa más limpia, si tú controlas `Program.cs`, es no registrar un proveedor que piensas reemplazar: lee la cadena de conexión desde la configuración y deja que el factory de pruebas la provea mediante `ConfigureAppConfiguration`. Así no hay nada que quitar.

**`'PostgreSqlBuilder.PostgreSqlBuilder()' is obsolete`.** A partir de Testcontainers 4.13.0 los constructores sin parámetros de los módulos están obsoletos y la imagen debe pasarse al constructor: `new PostgreSqlBuilder("postgres:17.6-alpine")`. Es el remate del cambio de la 4.10 que dejó de hacer que los módulos usaran por defecto una etiqueta elegida por los mantenedores. Hoy es una advertencia y más adelante será un error, y es la decisión correcta: una etiqueta de imagen flotante significa que un pipeline de CI que pasó ayer puede fallar hoy por razones que no tienen nada que ver con tu commit.

## Qué haría yo

Por defecto, configuración B para cualquier cosa que tenga un repositorio en la pila de llamadas, y configuración A para todo lo demás. En concreto: un contenedor compartido por ensamblado, `WithReuse(true)` en local, un reinicio con truncate entre pruebas en lugar de un contenedor por clase, y un proyecto de pruebas rápido aparte, sin dependencia de Docker, para las pruebas de superficie HTTP, de modo que `dotnet test` sobre ese proyecto siga bajando del segundo.

No uses SQLite ni el proveedor en memoria como sustituto de tu motor de producción. Úsalos cuando la base de datos sea genuinamente incidental a lo que estás verificando, y sé honesto en que a esa altura estás escribiendo una prueba HTTP que además necesita que exista una capa de persistencia. Los 30 ms por cada cien solicitudes que ahorras no valen una prueba en verde que en producción estaría en rojo. Si de todos modos quieres un fake, [simular `DbContext` sin romper el seguimiento de cambios](/es/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) es un fake más honesto que un dialecto de SQL distinto.

Y recurre a la configuración C con moderación. Es una capacidad real, no una versión mejorada de B: prueba el artefacto en lugar del código, así que su lugar está junto a tus pruebas de humo de despliegue y no en la suite que la gente corre antes de hacer push.

## Relacionado

- La mecánica completa del factory, incluido `ConfigureTestServices` frente a `ConfigureWebHost` y cómo falsear la autenticación: [pruebas de integración con `WebApplicationFactory<T>` en ASP.NET Core 11](/es/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/).
- El lado de los contenedores en profundidad, con `IAsyncLifetime`, migraciones y Ryuk: [pruebas de integración contra un SQL Server real con Testcontainers](/es/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/).
- Compartir fixtures, los valores por defecto de paralelismo y el ciclo de vida difieren según el framework: [xUnit v3 vs NUnit vs MSTest en 2026](/es/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/).
- La otra fuente habitual de pruebas poco confiables: [probar código dependiente del tiempo con `TimeProvider` y `FakeTimeProvider`](/es/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/).
- Un comportamiento de concurrencia que ninguna base de datos falsa reproduce: [concurrencia optimista con un token `rowversion` en EF Core 11](/es/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/).

## Fuentes

- [Pruebas de integración en ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/test/integration-tests) sobre `WebApplicationFactory<TEntryPoint>` y el atributo de content root
- [Elegir una estrategia de pruebas](https://learn.microsoft.com/en-us/ef/core/testing/choosing-a-testing-strategy) en la documentación de EF Core, sobre por qué el proveedor en memoria no es una base de datos
- Documentación de [Testcontainers for .NET](https://dotnet.testcontainers.org/) y las [versiones 4.10.0 a 4.13.0](https://github.com/testcontainers/testcontainers-dotnet/releases), que introdujeron el anclaje obligatorio de la imagen y las API del hash de reutilización
- [Discusión sobre reutilización de contenedores en Testcontainers](https://github.com/testcontainers/testcontainers-dotnet/discussions/1470) que cubre los constructores sin parámetros obsoletos
- Versiones de los paquetes en NuGet: [Microsoft.AspNetCore.Mvc.Testing 10.0.1](https://www.nuget.org/packages/Microsoft.AspNetCore.Mvc.Testing), [Testcontainers.PostgreSql 4.13.0](https://www.nuget.org/packages/Testcontainers.PostgreSql)
