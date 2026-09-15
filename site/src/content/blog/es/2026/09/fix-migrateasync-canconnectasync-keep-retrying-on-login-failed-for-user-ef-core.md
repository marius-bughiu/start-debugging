---
title: "Solución: MigrateAsync y CanConnectAsync de EF Core siguen reintentando 'Login failed for user' durante 60 segundos"
description: "La comprobación de existencia de EF Core para SQL Server reintenta el error 18456 durante un minuto completo, con o sin EnableRetryOnFailure. Falla rápido, limita RetryTimeout o espera a EF Core 12."
pubDate: 2026-09-15
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "dotnet-10"
  - "csharp"
lang: "es"
translationOf: "2026/09/fix-migrateasync-canconnectasync-keep-retrying-on-login-failed-for-user-ef-core"
translatedBy: "claude"
translationDate: 2026-09-15
---

Si `Database.MigrateAsync()`, `EnsureCreatedAsync()` o `CanConnectAsync()` se quedan colgados cerca de un minuto antes de lanzar `Login failed for user` (o antes de devolver `false`), los reintentos vienen del propio EF Core, no de `EnableRetryOnFailure`. `SqlServerDatabaseCreator` trata el error de SQL 18456 como reintentable en su comprobación de existencia y vuelve a conectarse cada 500 ms hasta que vence su `RetryTimeout` de un minuto. Desactivar los reintentos no cambia nada. Hay tres alternativas: abrir la conexión tú mismo antes de migrar para que una contraseña incorrecta falle en el primer intento, reducir `RetryTimeout` o darles un timeout a los health checks. La solución real ([dotnet/efcore#38927](https://github.com/dotnet/efcore/pull/38927)) solo llega en EF Core 12. Medí todo esto en EF Core 10.0.12 y 11.0.0-rc.1, y ambos se comportan de forma idéntica.

## El error en contexto

La excepción es el fallo de inicio de sesión de SQL Server de siempre. Lo que lo delata es lo que tarda en llegar:

```text
Microsoft.Data.SqlClient.SqlException (0x80131904): Login failed for user 'app'.
Error Number:18456,State:1,Class:14
```

Síntomas típicos:

- Un contenedor que ejecuta las migraciones al arrancar con una contraseña incorrecta en su cadena de conexión se queda en silencio 60 segundos antes de caerse, así que la sonda de arranque del orquestador suele matarlo antes y nunca llegas a ver la excepción.
- Un `/health` respaldado por `AddDbContextCheck<T>()` tarda un minuto entero en reportar `Unhealthy` cuando las credenciales son incorrectas, y la sonda del balanceador de carga agota su tiempo mucho antes.
- El registro de errores de SQL Server (o la auditoría de Azure SQL) muestra una ráfaga de más de cien entradas `Login failed for user` provenientes de un solo arranque del proceso.
- Las pruebas de integración que verifican que "unas credenciales incorrectas hacen que `CanConnectAsync` devuelva `false`" pasan, pero cada una tarda un minuto.

Una consulta normal con la misma cadena de conexión falla en el primer intento. El camino lento se limita a las APIs que preguntan "¿existe esta base de datos?"

## Por qué EF Core reintenta un fallo de inicio de sesión

`CanConnectAsync`, `MigrateAsync`, `EnsureCreatedAsync` y `EnsureDeletedAsync` empiezan todos llamando a `IRelationalDatabaseCreator.ExistsAsync()`. Para SQL Server eso es [`SqlServerDatabaseCreator`](https://github.com/dotnet/efcore/blob/v10.0.12/src/EFCore.SqlServer/Storage/Internal/SqlServerDatabaseCreator.cs), y su comprobación de existencia es un bucle propio:

```csharp
// EF Core 10.0.12 and 11.0.0-rc.1, SqlServerDatabaseCreator (abridged)
public virtual TimeSpan RetryDelay { get; set; } = TimeSpan.FromMilliseconds(500);
public virtual TimeSpan RetryTimeout { get; set; } = TimeSpan.FromMinutes(1);

// inside ExistsAsync: open the connection, run SELECT 1, and on SqlException:
if (!retryOnNotExists && IsDoesNotExist(e)) // 4060, 1832, 5120
    return false;
if (DateTime.UtcNow > giveUp || !RetryOnExistsFailure(e))
    throw;
await Task.Delay(RetryDelay, ct);

private bool RetryOnExistsFailure(SqlException exception)
    => (exception.Number is 203 && exception.InnerException is Win32Exception)
       || exception.Number is 233 or -2 or 4060 or 1832 or 5120 or 18456;
```

El error 18456 se agregó a esa lista en EF Core 6.0 mediante [dotnet/efcore#25832](https://github.com/dotnet/efcore/pull/25832). Era un parche para [dotnet/efcore#15644](https://github.com/dotnet/efcore/issues/15644): Azure SQL puede responder brevemente `Login failed` justo después de `CREATE DATABASE`, así que `EnsureCreated` y el primer `Migrate` contra una base de datos nueva fallaban al azar. El parche solo hacía falta en la comprobación posterior a la creación (`CreateAsync` llama a `ExistsAsync(retryOnNotExists: true)`), pero el mismo método se usa para todas las comprobaciones de existencia. Así, una contraseña que simplemente es incorrecta se trata como "la base de datos todavía se está calentando" y se reintenta durante un minuto completo. [dotnet/efcore#38886](https://github.com/dotnet/efcore/issues/38886), abierto el 2026-08-31, reportó exactamente eso.

Esto también explica por qué `EnableRetryOnFailure` parece culpable pero no lo es. El bucle se ejecuta dentro de una sola operación de la estrategia de ejecución. Cuando se cumple el minuto, la estrategia pregunta a `SqlServerTransientExceptionDetector.ShouldRetryOn(18456)`, obtiene `false` (18456 no está en esa lista) y vuelve a lanzar la excepción. Con los reintentos activados o desactivados, los tiempos son los mismos. `errorNumbersToAdd` tampoco importa, salvo que le agregues 18456, lo que empeoraría las cosas.

Después, `CanConnectAsync` envuelve todo en un `try/catch` que convierte cualquier excepción, salvo la cancelación, en `false`. Por eso la variante del health check nunca lanza: simplemente tarda un minuto en decir que no.

## Reproducción mínima sin SQL Server

No necesitas un servidor para verlo. Un `DbConnectionInterceptor` que lanza una `SqlException` con número 18456 en cada apertura física hace las veces de un servidor con credenciales incorrectas. La `SqlException` se construye por reflexión, porque sus constructores son internos. La prueba cuenta los intentos de apertura y mide el tiempo de cada llamada:

```csharp
// .NET 10, EF Core 10.0.12 (also run on .NET 11 RC 1 with EF Core 11.0.0-rc.1.26425.128)
public class FailingOpen(int number) : DbConnectionInterceptor
{
    int _attempts;
    public int Attempts => _attempts;

    public override ValueTask<InterceptionResult> ConnectionOpeningAsync(
        DbConnection c, ConnectionEventData e, InterceptionResult r, CancellationToken ct = default)
    {
        Interlocked.Increment(ref _attempts);
        throw FakeSql.Create(number, "Login failed for user 'app'.");
    }
}

public class Shop(FailingOpen interceptor, bool retry) : DbContext
{
    public DbSet<Product> Products => Set<Product>();

    protected override void OnConfiguring(DbContextOptionsBuilder o)
        => o.UseSqlServer(
                "Server=db.invalid;Database=Shop;User Id=app;Password=wrong;Encrypt=False",
                sql => { if (retry) sql.EnableRetryOnFailure(); })
            .AddInterceptors(interceptor);
}
```

Resultados, idénticos en EF Core 10.0.12 (SqlClient 6.0) y EF Core 11.0.0-rc.1 (SqlClient 7.0):

| Llamada | Error | `EnableRetryOnFailure` | Intentos de apertura | Tiempo | Resultado |
|---|---|---|---|---|---|
| `CanConnectAsync()` | 18456 | desactivado | 121 | 60.4 s | `false` |
| `CanConnectAsync()` | 18456 | activado | 121 | 60.2 s | `false` |
| `MigrateAsync()` | 18456 | activado | 121 | 60.2 s | `SqlException` 18456 |
| `EnsureCreatedAsync()` | 18456 | activado | 121 | 60.2 s | `SqlException` 18456 |
| `Products.ToListAsync()` | 18456 | activado | 1 | 0.1 s | `SqlException` 18456 |
| `CanConnectAsync()` | 4060 | activado | 1 | 0.0 s | `false` |

El interceptor falla al instante, así que 121 intentos es el techo: uno cada 500 ms durante 60 segundos. Contra un servidor real, cada intento además paga una conexión TCP, TLS y el viaje de ida y vuelta del inicio de sesión, así que verás menos intentos, pero el minuto es el mismo. La última fila muestra la asimetría: una *base de datos inexistente* (4060) corta de inmediato con `false`, mientras que una *contraseña incorrecta* es el caso que se reintenta.

## La solución, en detalle

En orden de preferencia.

### 1. Corrige las credenciales usando el código de estado del servidor

El minuto de reintentos solo hace que el problema real tarde más en encontrarse. El cliente siempre reporta `State:1`. El servidor escribe la razón real en su registro de errores como código de estado (en Azure SQL, lo registra la auditoría):

| Estado | Significado |
|---|---|
| 2, 5 | El inicio de sesión no existe |
| 6 | Se usó un nombre de inicio de sesión de Windows con autenticación de SQL |
| 7 | El inicio de sesión está deshabilitado (y la contraseña es incorrecta) |
| 8 | Contraseña incorrecta |
| 18 | Hay que cambiar la contraseña |
| 38, 40 | El inicio de sesión es válido, pero no puede abrir la base de datos solicitada |
| 58 | Autenticación de SQL contra un servidor en modo solo Windows |

La lista completa está en la página [MSSQLSERVER_18456](https://learn.microsoft.com/en-us/sql/relational-databases/errors-events/mssqlserver-18456-database-engine-error). Conviene conocer los estados 38 y 40, porque parecen un problema de credenciales pero en realidad son un problema de permisos o de nombre de base de datos. Son primos del caso 4060 que cubro en [el artículo sobre CREATE DATABASE permission denied](/es/2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update/).

### 2. Falla rápido antes de migrar

Si ejecutas las migraciones al arrancar, abre tú mismo la conexión primero. `OpenConnectionAsync` no pasa por el bucle de existencia, así que una contraseña incorrecta lanza en el primer intento. Cuando la conexión ya está abierta, `MigrateAsync` la reutiliza:

```csharp
// .NET 10, EF Core 10.0.12 / 11.0.0-rc.1
static async Task MigrateFailFastAsync(DbContext db, CancellationToken ct = default)
{
    var opened = false;
    try
    {
        await db.Database.OpenConnectionAsync(ct);
        opened = true;
    }
    catch (SqlException ex) when (ex.Number == 4060)
    {
        // Database missing (or no user for this login in it): let MigrateAsync decide.
    }

    try
    {
        await db.Database.MigrateAsync(ct);
    }
    finally
    {
        if (opened) await db.Database.CloseConnectionAsync();
    }
}
```

La prueba midió 1 intento y 0.0 s hasta la `SqlException` 18456, con `EnableRetryOnFailure` activado. El `catch` para 4060 importa. Si se espera que tus migraciones *creen* la base de datos (desarrollo local, una primera implementación), la apertura previa falla con 4060 porque la base de datos todavía no existe. Tragarse esa excepción deja que `MigrateAsync` tome el camino normal de creación, incluido el reintento posterior a la creación que Azure SQL sí necesita. Si tus bases de datos siempre se aprovisionan por separado, quita el `catch` y deja que 4060 también haga fallar el arranque.

Para pipelines de producción, lo mejor a largo plazo es sacar por completo las migraciones del arranque de la aplicación y ejecutar un [migrations bundle](/es/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) como paso de implementación. Pasa por el mismo bucle, pero un paso del pipeline que falla después de un minuto es mucho menos doloroso que un pod en un bucle de caídas.

### 3. Limita `RetryTimeout`

`RetryTimeout` y `RetryDelay` son propiedades públicas con setter en `SqlServerDatabaseCreator`, que vive en un namespace `.Internal`. Usarlo dispara la advertencia del analizador EF1001, y su forma puede cambiar entre versiones:

```csharp
// .NET 10, EF Core 10.0.12 / 11.0.0-rc.1
#pragma warning disable EF1001 // Internal EF Core API usage.
using Microsoft.EntityFrameworkCore.SqlServer.Storage.Internal;
using Microsoft.EntityFrameworkCore.Storage;

var creator = (SqlServerDatabaseCreator)db.GetService<IRelationalDatabaseCreator>();
creator.RetryTimeout = TimeSpan.FromSeconds(5);
await db.Database.MigrateAsync();
#pragma warning restore EF1001
```

Con esto aplicado, la prueba midió 11 intentos y 5.0 s para `MigrateAsync`. El mismo timeout limita la comprobación posterior a la creación, así que en Azure SQL no lo pongas en cero si `EnsureCreated` o `Migrate` crean la base de datos. Unos pocos segundos mantienen vivo el parche de #15644 y eliminan el minuto. El creator es un servicio scoped, así que configúralo en cada instancia de contexto que ejecute migraciones, no una sola vez al arrancar.

### 4. Dales un timeout a los health checks de la base de datos

`AddDbContextCheck<T>()` ejecuta `CanConnectAsync` por defecto, y [`HealthCheckRegistration.Timeout`](https://github.com/dotnet/aspnetcore/blob/main/src/HealthChecks/Abstractions/src/HealthCheckRegistration.cs) tiene como valor por defecto `Timeout.InfiniteTimeSpan`. A diferencia de `AddCheck`, `AddDbContextCheck` no tiene un parámetro `timeout`, así que haz dos cosas: reemplaza la prueba por una que se salte el bucle de existencia y configura el timeout del registro mediante `HealthCheckServiceOptions`:

```csharp
// .NET 10, ASP.NET Core 10.0, Microsoft.Extensions.Diagnostics.HealthChecks.EntityFrameworkCore 10.0.12
builder.Services.AddHealthChecks()
    .AddDbContextCheck<Shop>(customTestQuery: async (db, ct) =>
    {
        await db.Database.OpenConnectionAsync(ct);
        await db.Database.CloseConnectionAsync();
        return true;
    });

// The registration is named after the context type unless you pass a name.
builder.Services.Configure<HealthCheckServiceOptions>(o =>
    o.Registrations.Single(r => r.Name == nameof(Shop)).Timeout = TimeSpan.FromSeconds(5));
```

`DbContextHealthCheck` captura lo que lance la prueba y reporta `Unhealthy` con la excepción adjunta, así que una contraseña incorrecta ahora aparece como `Login failed for user 'app'.` en el reporte de salud en lugar de un fallo sin detalles un minuto después. El timeout es la red de seguridad para todo lo demás, como un servidor que acepta la conexión TCP y nunca responde. La configuración general está en [agregar un endpoint de health check a una minimal API](/es/2026/07/how-to-add-a-health-check-endpoint-to-a-minimal-api-in-aspnetcore-11/).

### 5. Actualiza cuando salga EF Core 12

[dotnet/efcore#38927](https://github.com/dotnet/efcore/pull/38927), fusionado el 2026-09-10 con el milestone 12.0.0, pasa `retryOnNotExists` hasta `RetryOnExistsFailure` para que 18456 solo se reintente justo después de que el proveedor haya creado la base de datos:

```csharp
// EF Core main (12.0), after dotnet/efcore#38927
|| (exception.Number is 233 or -2 or 4060 or 1832 or 5120)
|| (retryOnLoginFailure && exception.Number is 18456))
```

A día de hoy, el cambio no está en `release/10.0` ni en `release/11.0` (ambas siguen teniendo la comprobación antigua de una línea), así que lo más probable es que EF Core 11.0 GA salga con el reintento de un minuto. No ejecuté una compilación diaria de EF Core 12. El PR agrega pruebas de regresión síncronas y asíncronas para ambos caminos, así que en 10 y 11 lo que tienes son las alternativas de arriba.

## Trampas y casos parecidos

**Un token de cancelación cambia el resultado, no solo los tiempos.** `CanConnectAsync(ct)` vuelve a lanzar la cancelación, así que con un `CancellationTokenSource` de 5 segundos la prueba obtuvo una `TaskCanceledException` después de 10 intentos, no `false`. El código que solo revisa el booleano necesita un `catch (OperationCanceledException)`.

**El camino síncrono bloquea un hilo.** `Database.Migrate()` y `CanConnect()` usan `Thread.Sleep(RetryDelay)` en el mismo bucle, así que el minuto se pasa ocupando un hilo del thread pool. Es otra razón para ejecutar las migraciones fuera del código que atiende solicitudes.

**`EnableRetryOnFailure` sí reintenta el error 4060, solo que aquí no.** 4060 (`Cannot open database "Shop" requested by the login`) *sí* está en la lista de errores transitorios. `CanConnectAsync` devuelve `false` de inmediato para él, pero una consulta normal con el `EnableRetryOnFailure()` por defecto (6 reintentos, 30 s de espera máxima) hizo 7 intentos a lo largo de 57.9 s antes de lanzar `RetryLimitExceededException`. Si un "login failed" en tiempo de consulta tarda cerca de un minuto, mira el número de la excepción interna antes de culpar al bucle del creator. Y si de todos modos estás ajustando la estrategia, [el artículo sobre la estrategia de ejecución y las transacciones de usuario](/es/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/) cubre la otra trampa que tiende.

**El ruido de inicios de sesión fallidos tiene efectos secundarios.** Cada reintento es un inicio de sesión fallido real en el servidor. Con `CHECK_POLICY = ON`, los inicios de sesión de SQL siguen la política de bloqueo de cuentas de Windows, y la auditoría de Azure SQL registra cada intento. Un minuto de reintentos puede bloquear la cuenta, y a partir de ahí incluso la contraseña correcta falla, con el error 18486 ("the account is currently locked out") en lugar de 18456.

**Los timeouts son otro problema.** Si el minuto termina en `Timeout expired` en lugar de `Login failed`, lo que tienes son timeouts de comando o de gateway durante una migración larga, algo que cubro en [SqlException timeout expired durante las migraciones de EF Core](/es/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/).

## Relacionados

- [Solución: CREATE DATABASE permission denied in database 'master' durante dotnet ef database update](/es/2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update/)
- [Cómo aplicar migraciones de EF Core 11 en producción con un migrations bundle](/es/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)
- [Solución: SqlException timeout expired durante las migraciones de EF Core](/es/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/)
- [Solución: The configured execution strategy does not support user-initiated transactions](/es/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/)
- [Cómo agregar un endpoint de health check a una minimal API en ASP.NET Core 11](/es/2026/07/how-to-add-a-health-check-endpoint-to-a-minimal-api-in-aspnetcore-11/)

## Fuentes

- [dotnet/efcore#38886: CanConnectAsync / MigrateAsync retries on authentication failure instead of throwing](https://github.com/dotnet/efcore/issues/38886) y la solución, [dotnet/efcore#38927: Restrict SQL Server login failure retries to post-creation checks](https://github.com/dotnet/efcore/pull/38927).
- [dotnet/efcore#25832: Update SQL Server transient error list](https://github.com/dotnet/efcore/pull/25832), que agregó 18456 por [dotnet/efcore#15644](https://github.com/dotnet/efcore/issues/15644).
- [`SqlServerDatabaseCreator.cs` en v10.0.12](https://github.com/dotnet/efcore/blob/v10.0.12/src/EFCore.SqlServer/Storage/Internal/SqlServerDatabaseCreator.cs), [en v11.0.0-rc.1](https://github.com/dotnet/efcore/blob/v11.0.0-rc.1.26425.128/src/EFCore.SqlServer/Storage/Internal/SqlServerDatabaseCreator.cs) y [`SqlServerTransientExceptionDetector.cs`](https://github.com/dotnet/efcore/blob/v10.0.12/src/EFCore.SqlServer/Storage/Internal/SqlServerTransientExceptionDetector.cs).
- [Connection resiliency](https://learn.microsoft.com/en-us/ef/core/miscellaneous/connection-resiliency) (Microsoft Learn, EF Core).
- [MSSQLSERVER_18456](https://learn.microsoft.com/en-us/sql/relational-databases/errors-events/mssqlserver-18456-database-engine-error) (Microsoft Learn, SQL Server).
- [`DbContextHealthCheck.cs`](https://github.com/dotnet/aspnetcore/blob/main/src/Middleware/HealthChecks.EntityFrameworkCore/src/DbContextHealthCheck.cs) en dotnet/aspnetcore.
