---
title: "Cómo establecer parámetros de sesión de PostgreSQL como search_path o statement_timeout en cada conexión de EF Core con Npgsql"
description: "Un SET ejecutado una sola vez se borra con DISCARD ALL en cuanto Npgsql devuelve la conexión a su pool. Pon search_path y statement_timeout en el paquete de inicio con las palabras clave Search Path y Options de la cadena de conexión, recurre a ALTER ROLE o a un interceptor ConnectionOpened, y entiende por qué UsePhysicalConnectionInitializer pierde su SET sin avisar."
pubDate: 2026-10-04
template: how-to
tags:
  - "ef-core"
  - "ef-core-10"
  - "postgresql"
  - "npgsql"
  - "dotnet-10"
  - "how-to"
lang: "es"
translationOf: "2026/10/how-to-set-postgresql-session-parameters-on-every-ef-core-connection-with-npgsql"
translatedBy: "claude"
translationDate: 2026-10-04
---

Respuesta corta: no ejecutes `SET statement_timeout = ...` una sola vez esperando que se mantenga. Npgsql envía `DISCARD ALL` cada vez que se reutiliza una conexión del pool, lo que devuelve todos los ajustes de sesión a sus valores por defecto. Pon los ajustes en el paquete de inicio de la conexión: `Search Path=tenant_a,public` para el search path de esquemas y `Options=-c statement_timeout=5s -c lock_timeout=1s` para cualquier otro parámetro. PostgreSQL trata los parámetros de inicio como los valores por defecto de la sesión, así que `DISCARD ALL` vuelve a *tus* valores, y EF Core no necesita ningún código adicional. Si no puedes tocar la cadena de conexión, usa `ALTER ROLE app_user SET ...` en el servidor, o un `DbConnectionInterceptor` que ejecute `SET` en `ConnectionOpenedAsync` (un viaje de ida y vuelta extra por cada apertura).

Todo lo que sigue se ejecutó en .NET 10 (SDK 10.0.302) con `Npgsql.EntityFrameworkCore.PostgreSQL` 10.0.3 (EF Core 10.0.4, Npgsql 10.0.3) contra PostgreSQL 18.4, con `log_statement=all` activado para que cada sentencia enviada por Npgsql aparezca en el registro del servidor. Las salidas citadas provienen de esas ejecuciones.

## Por qué desaparece un SET aislado

Npgsql mantiene un pool de conexiones físicas. Cuando haces dispose de un `NpgsqlConnection` (o EF Core cierra uno después de una consulta), la conexión física vuelve al pool y Npgsql la marca para un reinicio. Ese reinicio es un `DISCARD ALL`, que PostgreSQL define como `CLOSE ALL; SET SESSION AUTHORIZATION DEFAULT; RESET ALL; DEALLOCATE ALL; UNLISTEN *; ...`. `RESET ALL` es la parte que importa aquí: cada `SET` que ejecutaste en esa sesión desaparece.

Este es el caso mínimo para reproducirlo. El pool está limitado a una conexión, así que la segunda apertura obtiene con seguridad la misma sesión física:

```csharp
// .NET 10, Npgsql 10.0.3
var ds = NpgsqlDataSource.Create(
    "Host=localhost;Port=55432;Username=postgres;Database=postgres;Maximum Pool Size=1");

int pid1, pid2;
await using (var c = await ds.OpenConnectionAsync())
{
    pid1 = c.ProcessID;
    await new NpgsqlCommand("SET search_path = tenant_a; SET statement_timeout = '1s'", c)
        .ExecuteNonQueryAsync();
}
await using (var c = await ds.OpenConnectionAsync())
{
    pid2 = c.ProcessID;
    // same physical=True search_path="$user", public statement_timeout=0
}
```

Es el mismo proceso de backend, y ambos ajustes han vuelto a los valores por defecto del servidor. El registro del servidor muestra por qué:

```text
[95652] execute <unnamed>: SET search_path = tenant_a
[95652] execute <unnamed>: SET statement_timeout = '1s'
[95652] statement: DISCARD ALL
[95652] execute <unnamed>: SHOW search_path
```

Ten en cuenta que `DISCARD ALL` no se envía al cerrar la conexión. Npgsql lo difiere y lo escribe delante del siguiente comando en esa conexión física, así que no cuesta un viaje de ida y vuelta adicional. Además se ejecuta aunque no hayas cambiado nada, por lo que no puedes evitarlo siendo cuidadoso.

Con EF Core esto duele más que con ADO.NET puro, porque EF Core abre y cierra la conexión alrededor de cada operación. Un `DbContext` que ejecuta una consulta y después una llamada a `SqlQueryRaw` abre la conexión dos veces, y cada apertura puede caer en una sesión recién reiniciada.

## Opción 1: la palabra clave Search Path de la cadena de conexión

Para el search path de esquemas en concreto, Npgsql tiene una palabra clave dedicada. Se envía como parámetro de inicio, no como un `SET`:

```csharp
// .NET 10, Npgsql 10.0.3
var ds = NpgsqlDataSource.Create(
    "Host=localhost;Port=55432;Username=postgres;Database=postgres;Search Path=tenant_a,public");

await using var c = await ds.OpenConnectionAsync();
// SHOW search_path            -> tenant_a,public
// SELECT count(*) FROM orders -> 1 (resolves to tenant_a.orders)
```

En el registro del servidor no hay ningún `SET` para esta conexión. El valor viaja en el paquete de inicio y PostgreSQL lo usa como valor por defecto de la sesión.

## Opción 2: Options=-c para cualquier otro parámetro

La palabra clave `Options` se pasa tal cual como el parámetro de inicio `options` de PostgreSQL, que acepta la misma sintaxis `-c name=value` que la línea de comandos de `postgres`. Eso cubre `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`, `work_mem`, `search_path` y cualquier otro parámetro que un usuario normal tenga permitido cambiar con `SET`:

```csharp
// .NET 10, Npgsql 10.0.3
var cs = "Host=localhost;Port=55432;Username=postgres;Database=postgres;" +
         "Options=-c statement_timeout=2s -c search_path=tenant_a,public -c lock_timeout=500ms";
var ds = NpgsqlDataSource.Create(cs);

await using (var c = await ds.OpenConnectionAsync())
{
    // statement_timeout=2s search_path=tenant_a,public lock_timeout=500ms
    await new NpgsqlCommand("SET statement_timeout = '9s'", c).ExecuteNonQueryAsync();
    // statement_timeout=9s
}
await using (var c = await ds.OpenConnectionAsync())
{
    // statement_timeout=2s   <- DISCARD ALL reset it to the startup value, not to 0
}
```

Esta es la propiedad que convierte al paquete de inicio en el lugar correcto. `RESET ALL` devuelve cada parámetro al valor que habría tenido si no se hubiera ejecutado ningún `SET` en esta sesión, y para un parámetro de inicio ese valor es el que tú pasaste. Así, una solicitud que sube temporalmente el timeout no puede filtrarlo a la siguiente solicitud, y la siguiente sigue recibiendo tu valor por defecto en lugar del del servidor.

Si construyes cadenas de conexión en código, usa `NpgsqlConnectionStringBuilder` para que las comillas se gestionen por ti. El valor de `Options`, separado por espacios, se entrecomilla:

```csharp
// .NET 10, Npgsql 10.0.3
var csb = new NpgsqlConnectionStringBuilder("Host=localhost;Port=55432;Username=postgres;Database=sp_demo")
{
    SearchPath = "tenant_b,public",
    Options = "-c statement_timeout=5s -c lock_timeout=1s",
    ApplicationName = "orders-api",
};
// Host=localhost;Port=55432;Username=postgres;Database=sp_demo;Search Path=tenant_b,public;
// Options="-c statement_timeout=5s -c lock_timeout=1s";Application Name=orders-api
```

## Conectarlo a EF Core

Como los ajustes viven en la cadena de conexión, EF Core no necesita nada especial. Pasa la cadena a `UseNpgsql`, o registra un `NpgsqlDataSource` y pasa ese:

```csharp
// .NET 10, EF Core 10.0.4, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
builder.Services.AddDbContext<AppDbContext>(o => o.UseNpgsql(
    builder.Configuration.GetConnectionString("Orders")));

// appsettings.json
// "ConnectionStrings": {
//   "Orders": "Host=db;Database=orders;Username=app;Search Path=tenant_b,public;Options=-c statement_timeout=5s -c lock_timeout=1s"
// }
```

Ejecutar una consulta a través de ese contexto confirma que el timeout está en vigor en cada conexión que abre EF Core:

```csharp
var st = await db.Database
    .SqlQueryRaw<string>("SELECT current_setting('statement_timeout') AS \"Value\"")
    .SingleAsync();
// 5s
```

Cuando el timeout se dispara, PostgreSQL cancela la sentencia en el servidor y obtienes una `PostgresException` con `SqlState` `57014` y el mensaje `canceling statement due to statement timeout`. La conexión sigue abierta y utilizable. Eso es distinto del `Command Timeout` propio de Npgsql (30 segundos por defecto), que se aplica en el cliente: cuando expira, Npgsql cancela la consulta y lanza una `NpgsqlException` que envuelve una `TimeoutException`, sin `SqlState`. Mantén `Command Timeout` un poco por encima de `statement_timeout` para que el límite del lado del servidor, que da un error limpio y no depende de que el cliente se dé cuenta, sea el que salte.

## Opción 3: ALTER ROLE o ALTER DATABASE en el servidor

Si la cadena de conexión es de otra persona (un equipo de plataforma, un almacén de secretos que no puedes cambiar por aplicación), lleva los valores por defecto al servidor:

```sql
-- PostgreSQL 18
ALTER ROLE app_user SET search_path = tenant_a, public;
ALTER ROLE app_user SET statement_timeout = '15s';

-- or scoped to one database
ALTER ROLE app_user IN DATABASE orders SET statement_timeout = '15s';
```

Una conexión nueva como `app_user` devolvió `search_path=tenant_a, public` y `statement_timeout=15s`, sin ninguna configuración en el cliente. Estos valores por defecto del rol también sobreviven a `DISCARD ALL`, ya que forman parte del estado inicial de la sesión.

La precedencia importa cuando combinas enfoques. El mismo rol conectándose con `Options=-c statement_timeout=3s` obtuvo `3s`: los parámetros de inicio anulan los valores por defecto del rol y de la base de datos, que a su vez anulan `postgresql.conf`. Eso te da una capa útil: un valor por defecto conservador en el rol y una sobrescritura por aplicación en la cadena de conexión cuando un servicio necesita legítimamente consultas más largas (un trabajo de reportes, un ejecutor de migraciones).

Evita establecer `statement_timeout` de forma global en `postgresql.conf`. La documentación de PostgreSQL lo desaconseja porque también se aplica a sesiones de mantenimiento, a `pg_dump` y a tus propias sesiones de `psql`.

## Opción 4: un DbConnectionInterceptor que ejecute SET en cada apertura

A veces el valor no es estático. Una aplicación multi-tenant que elige el esquema por solicitud, o un ajuste derivado del usuario actual, no puede vivir en una cadena de conexión fija. Los [interceptores](/es/2026/09/what-is-an-ef-core-interceptor-and-when-do-i-need-one/) de EF Core te dan un gancho que se ejecuta justo después de cada apertura:

```csharp
// .NET 10, EF Core 10.0.4
using System.Data.Common;
using Microsoft.EntityFrameworkCore.Diagnostics;

public sealed class SessionSettingsInterceptor : DbConnectionInterceptor
{
    const string Sql = "SET statement_timeout = '5s'; SET lock_timeout = '1s'";

    public override void ConnectionOpened(DbConnection connection, ConnectionEndEventData eventData)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = Sql;
        cmd.ExecuteNonQuery();
    }

    public override async Task ConnectionOpenedAsync(
        DbConnection connection, ConnectionEndEventData eventData, CancellationToken cancellationToken = default)
    {
        await using var cmd = connection.CreateCommand();
        cmd.CommandText = Sql;
        await cmd.ExecuteNonQueryAsync(cancellationToken);
    }
}

// registration
builder.Services.AddDbContext<AppDbContext>(o => o
    .UseNpgsql(connectionString)
    .AddInterceptors(new SessionSettingsInterceptor()));
```

Sobrescribe tanto el método síncrono como el asíncrono. EF Core llama al que corresponda a la API que usaste, y olvidar el síncrono significa que `db.Orders.Count()` se ejecuta sin tus ajustes y sin avisar.

Esto funciona, y el registro muestra exactamente lo que cuesta. Dos instancias de `DbContext`, cada una ejecutando una consulta LINQ y una consulta SQL sin procesar, produjeron cuatro aperturas y cuatro pares de `SET`:

```text
[95655] execute <unnamed>: SET statement_timeout = '5s'
[95655] execute <unnamed>: SET lock_timeout = '1s'
[95655] execute <unnamed>: SELECT count(*)::int ...
[95655] statement: DISCARD ALL
[95655] execute <unnamed>: SET statement_timeout = '5s'
[95655] execute <unnamed>: SET lock_timeout = '1s'
[95655] execute <unnamed>: SELECT s."Value" ...
```

Cada apertura paga un viaje de ida y vuelta extra. En un socket local es ruido; contra una base de datos administrada en otra zona de disponibilidad puede ser del mismo orden de magnitud que la propia consulta. Para valores estáticos, las opciones 1 a 3 son estrictamente mejores. Para valores por solicitud, considera si el parámetro realmente necesita abarcar toda la sesión, o si basta con un `SET LOCAL` dentro de la transacción que ya estás ejecutando.

## La trampa: UsePhysicalConnectionInitializer

`NpgsqlDataSourceBuilder.UsePhysicalConnectionInitializer` parece la opción obvia. Ejecuta un callback una vez, cuando se crea por primera vez una conexión física, lo que suena a "una vez por sesión, sin sobrecarga por apertura". Esto es lo que ocurre en realidad:

```csharp
// .NET 10, Npgsql 10.0.3
var b = new NpgsqlDataSourceBuilder(
    "Host=localhost;Port=55432;Username=postgres;Database=postgres;Maximum Pool Size=1");
b.UsePhysicalConnectionInitializer(
    conn => { using var cmd = new NpgsqlCommand("SET statement_timeout = '4s'", conn); cmd.ExecuteNonQuery(); },
    async conn => { await using var cmd = new NpgsqlCommand("SET statement_timeout = '4s'", conn); await cmd.ExecuteNonQueryAsync(); });
var ds = b.Build();

// open 0: statement_timeout=4s inits=1
// open 1: statement_timeout=0  inits=1
// open 2: statement_timeout=0  inits=1
```

El inicializador se ejecuta una vez, como se promete, y la primera apertura ve `4s`. Después la conexión vuelve al pool, `DISCARD ALL` borra el `SET`, y el inicializador nunca vuelve a ejecutarse porque la conexión física sigue existiendo. Cada solicitud posterior a la primera se ejecuta sin timeout. La propia documentación XML de Npgsql sobre el método advierte de esto: los ajustes aplicados ahí son revertidos por `DISCARD ALL` a menos que desactives el reinicio.

La solución es combinarlo con `No Reset On Close=true`. En EF Core, `ConfigureDataSource` te permite llegar al builder sin salir de `UseNpgsql`:

```csharp
// .NET 10, EF Core 10.0.4, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
options.UseNpgsql(
    "Host=localhost;Port=55432;Username=postgres;Database=sp_demo;No Reset On Close=true",
    o => o.ConfigureDataSource(ds => ds.UsePhysicalConnectionInitializer(
        conn => { using var cmd = new NpgsqlCommand("SET search_path = tenant_b, public", conn); cmd.ExecuteNonQuery(); },
        async conn => { await using var cmd = new NpgsqlCommand("SET search_path = tenant_b, public", conn); await cmd.ExecuteNonQueryAsync(); })));

// ctx 0: widgets=1 search_path=tenant_b, public inits=1
// ctx 1: widgets=1 search_path=tenant_b, public inits=1
// ctx 2: widgets=1 search_path=tenant_b, public inits=1
```

Un solo `SET`, ningún `DISCARD ALL` en el registro, y el ajuste se mantiene entre contextos. El precio es que ya *nada* se reinicia. Si cualquier ruta de código ejecuta un `SET` (un auxiliar de migraciones, una consulta de diagnóstico, una biblioteca), ese valor se filtra a todos los usuarios posteriores de esa conexión física, junto con las tablas temporales y los registros de `LISTEN`. Usa esta combinación solo cuando controles todas las sentencias que se ejecutan en el pool. Si lo único que necesitas es un valor estático, la cadena de conexión es más simple y más segura.

## Sobrescrituras por consulta con SET LOCAL

Subir el timeout para una operación lenta conocida no requiere ningún cambio de sesión. `SET LOCAL` dura hasta el final de la transacción actual:

```csharp
// .NET 10, EF Core 10.0.4
await using var tx = await db.Database.BeginTransactionAsync();
await db.Database.ExecuteSqlRawAsync("SET LOCAL statement_timeout = '60s'");
await db.Database.ExecuteSqlRawAsync("REFRESH MATERIALIZED VIEW sales_summary");
await tx.CommitAsync();
// after commit: statement_timeout is back to the session default
```

En la prueba, `SHOW statement_timeout` devolvió `100ms` dentro de la transacción y `0` justo después del commit, en la misma conexión, sin necesidad de `DISCARD ALL`. Este es también el único enfoque que funciona a través de PgBouncer en modo transaction, que se trata a continuación.

## Problemas con pools de conexiones externos, migraciones y timeouts

**PgBouncer rechaza los parámetros de inicio desconocidos.** Por defecto PgBouncer solo acepta los parámetros de inicio que rastrea, y lanza un error para todo lo demás, incluido `options`. O bien añades `options` a `ignore_startup_parameters` (y entonces PgBouncer descarta tus ajustes en silencio) o llevas los valores por defecto a `ALTER ROLE`. PostgreSQL 18 informa de `search_path` de vuelta al cliente, así que PgBouncer lo rastrea de fábrica en la 18. En modo transaction o statement, la documentación de Npgsql también indica establecer `No Reset On Close=true`, porque `DISCARD ALL` no tiene sentido cuando PgBouncer puede entregar la siguiente transacción a un backend distinto. En ese modo, cualquier `SET` fuera de una transacción es prácticamente aleatorio, así que usa `SET LOCAL` o valores por defecto del rol.

**search_path decide dónde se crean las tablas sin calificar.** Con `Search Path=tenant_b,public` y sin `HasDefaultSchema`, `EnsureCreatedAsync` creó `Widgets` en `tenant_b`. El proveedor de Npgsql también crea `__EFMigrationsHistory` con `CREATE TABLE IF NOT EXISTS` sin calificar, así que un ejecutor de migraciones cuya cadena de conexión lleve un `search_path` distinto al de la aplicación creará una segunda tabla de historial e intentará volver a ejecutar todas las migraciones. O bien fijas el esquema en el modelo (`modelBuilder.HasDefaultSchema("tenant_b")` y `MigrationsHistoryTable("__EFMigrationsHistory", "tenant_b")`) o te aseguras de que el ejecutor use exactamente la misma cadena de conexión. Ten en cuenta también que `EnsureCreated` comprueba si la base de datos tiene *alguna* tabla de usuario, no solo las de tu search path: en una base de datos que ya tenía `tenant_a.orders`, omitió la creación por completo y el primer insert falló con `42P01: relation "Widgets" does not exist`.

**Las migraciones necesitan su propio timeout.** Un `statement_timeout` de 5 segundos en la cadena de conexión compartida matará un `CREATE INDEX` largo durante la implementación. Dale al ejecutor de migraciones su propia cadena de conexión con `Options=-c statement_timeout=0` (los parámetros de inicio ganan a los valores por defecto del rol), y consulta [la guía sobre timeouts de migraciones de EF Core](/es/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/) para la mitad del problema que corresponde al cliente.

**lock_timeout suele ser el que realmente quieres.** Una consulta atascada detrás de un bloqueo es el incidente de producción habitual, y `statement_timeout` solo lo detecta una vez agotado todo el presupuesto. `lock_timeout=1s` falla rápido con `55P03` y deja correr las consultas legítimamente largas. PostgreSQL 17 añadió además `transaction_timeout`, que limita la transacción completa en lugar de cada sentencia.

**Algunos parámetros no se pueden establecer de esta forma.** Los parámetros de todo el servidor se rechazan en `options`: `-c shared_buffers=1GB` falla con `55P02 parameter "shared_buffers" cannot be changed without restarting the server`, y un parámetro `sighup` como `log_checkpoints` falla con `55P02 ... cannot be changed now`. Los parámetros solo para superusuario fallan para un rol normal: `-c log_statement=none` como `app_user` dio `42501 permission denied to set parameter "log_statement"`. En todos los casos `OpenAsync` lanza una excepción, así que te enteras en la primera solicitud en lugar de ejecutar en silencio con los ajustes equivocados.

## Elegir el enfoque

Para un valor fijo, usa la cadena de conexión: `Search Path` para esquemas, `Options=-c ...` para todo lo demás. No cuesta nada por apertura, sobrevive al reinicio del pool y funciona igual para EF Core, Dapper y Npgsql directo. Usa `ALTER ROLE ... SET` cuando la cadena de conexión no sea tuya, o como red de seguridad por debajo. Recurre a un interceptor `ConnectionOpened` solo cuando el valor dependa del estado en tiempo de ejecución, y acepta el viaje de ida y vuelta extra. `UsePhysicalConnectionInitializer` con `No Reset On Close=true` es una herramienta de nicho para pools cuyas sentencias controlas todas.

### Sigue leyendo

- [What is an EF Core interceptor and when do I need one?](/es/2026/09/what-is-an-ef-core-interceptor-and-when-do-i-need-one/) explica el pipeline de interceptores al que se engancha el enfoque de `ConnectionOpened`.
- [How to use EF Core 11 interceptors for auditing](/es/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/) muestra un interceptor de `SaveChanges` de principio a fin.
- [How to use named query filters for soft delete and multi-tenancy in EF Core 11](/es/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/) es la alternativa a nivel de fila al cambio de `search_path` con un esquema por tenant.
- [How to log the SQL that EF Core 11 generates](/es/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) ayuda a confirmar desde el lado del cliente lo que llega al servidor.
- [How to atomically append to a PostgreSQL jsonb array with EF Core and Npgsql](/es/2026/09/how-to-atomically-append-to-a-postgresql-jsonb-array-with-ef-core-and-npgsql/) es otro patrón específico de Npgsql probado contra PostgreSQL 18.

### Fuentes

- [Connection String Parameters](https://www.npgsql.org/doc/connection-string-parameters.html), documentación de Npgsql (`Search Path`, `Options`, `No Reset On Close`, `Command Timeout`)
- [Compatibility notes: pgbouncer](https://www.npgsql.org/doc/compatibility.html), documentación de Npgsql
- [`NpgsqlDataSourceBuilder.UsePhysicalConnectionInitializer`](https://github.com/npgsql/npgsql/blob/main/src/Npgsql/NpgsqlDataSourceBuilder.cs), npgsql/npgsql (comentarios XML sobre `DISCARD ALL`)
- [`NpgsqlHistoryRepository.cs` at `v10.0.3`](https://github.com/npgsql/efcore.pg/blob/v10.0.3/src/EFCore.PG/Migrations/Internal/NpgsqlHistoryRepository.cs), npgsql/efcore.pg
- [DISCARD](https://www.postgresql.org/docs/current/sql-discard.html), documentación de PostgreSQL
- [Client Connection Defaults](https://www.postgresql.org/docs/current/runtime-config-client.html), documentación de PostgreSQL (`statement_timeout`, `lock_timeout`, `transaction_timeout`, `search_path`)
- [ALTER ROLE](https://www.postgresql.org/docs/current/sql-alterrole.html), documentación de PostgreSQL
- [Connection interception](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/interceptors#connection-interception), documentación de EF Core
- [PgBouncer configuration](https://www.pgbouncer.org/config.html) (`track_extra_parameters`, `ignore_startup_parameters`)
