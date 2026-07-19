---
title: "Cómo registrar el SQL que genera EF Core 11"
description: "Observa el SQL exacto que Entity Framework Core 11 envía a tu base de datos, con valores de parámetros, usando LogTo, Microsoft.Extensions.Logging y ToQueryString."
pubDate: 2026-07-19
tags:
  - "ef-core"
  - "dotnet"
  - "csharp"
  - "logging"
lang: "es"
translationOf: "2026/07/how-to-log-the-sql-that-ef-core-11-generates"
translatedBy: "claude"
translationDate: 2026-07-19
---

La forma más rápida de ver el SQL que genera Entity Framework Core 11 es llamar a `LogTo(Console.WriteLine)` en tu `DbContextOptionsBuilder`. Eso imprime cada comando que EF Core envía a la base de datos, a nivel `Information`, bajo la categoría `Microsoft.EntityFrameworkCore.Database.Command`. En una aplicación ASP.NET Core normalmente ni siquiera lo necesitas: establece `Microsoft.EntityFrameworkCore.Database.Command` en `Information` en `appsettings.json` y el SQL fluye a través del registro que ya tienes. Para ver los valores reales de los parámetros en lugar de `?`, agrega `EnableSensitiveDataLogging()`. Para obtener el SQL de una sola consulta sin ejecutarla, llama a `.ToQueryString()`.

Este artículo cubre todas esas opciones, cuándo cada una es la herramienta correcta y los detalles que hacen tropezar a la gente: por qué no ves nada por defecto, por qué se ocultan los parámetros y por qué nunca debes llevar `EnableSensitiveDataLogging` a producción. Todo lo aquí descrito es válido para EF Core 11 y C# 14 en .NET 11.

## Por qué no ves SQL por defecto

EF Core no registra nada a menos que le indiques a dónde enviar los registros. Esto es intencional. Construir un mensaje de registro tiene un costo, así que EF Core omite el trabajo por completo cuando no hay ningún destino configurado. Es un cambio de mentalidad respecto a EF6, donde `Database.Log` podía adjuntarse en cualquier momento. En EF Core, el registro se configura una vez, en la inicialización del contexto, y el framework genera mensajes solo cuando hay un destino presente.

Cada comando SQL que EF Core ejecuta se registra como un único evento: `RelationalEventId.CommandExecuted`, evento con ID `20101`, en la categoría `Microsoft.EntityFrameworkCore.Database.Command`, a nivel `LogLevel.Information`. Ese último detalle importa. Si tu registro está filtrado a `Warning` o superior, que es un valor predeterminado común en producción, el SQL se genera internamente pero nunca llega a tu destino. Ver el SQL casi siempre es cuestión de bajar el nivel para esa única categoría, no de activar algún interruptor especial.

## La línea única: LogTo

`LogTo` es el "registro simple" incorporado de EF Core. No necesita paquete NuGet ni inyección de dependencias. Recibe un `Action<string>` que EF Core llama una vez por cada mensaje de registro.

```csharp
// EF Core 11, C# 14, .NET 11
public sealed class AppDbContext : DbContext
{
    protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
        => optionsBuilder
            .UseSqlServer("Server=(localdb)\\mssqllocaldb;Database=Shop;Trusted_Connection=True")
            .LogTo(Console.WriteLine);

    public DbSet<Order> Orders => Set<Order>();
}
```

Ejecuta una consulta y obtienes el comando, sus parámetros, el tiempo y el texto SQL:

```output
info: RelationalEventId.CommandExecuted[20101] (Microsoft.EntityFrameworkCore.Database.Command)
      Executed DbCommand (3ms) [Parameters=[@__customerId_0='?' (DbType = Int32)], CommandType='Text', CommandTimeout='30']
      SELECT [o].[Id], [o].[CustomerId], [o].[Total]
      FROM [Orders] AS [o]
      WHERE [o].[CustomerId] = @__customerId_0
```

`OnConfiguring` se ejecuta igualmente incluso cuando construyes el contexto mediante `AddDbContext` o pasas un `DbContextOptions` ya creado, así que este es el único lugar donde poner la configuración de registro sin importar cómo se construya el contexto. Si ya registras las opciones en `Program.cs`, puedes encadenar `LogTo` ahí en su lugar:

```csharp
// EF Core 11, .NET 11 - Program.cs
builder.Services.AddDbContext<AppDbContext>(options =>
    options
        .UseSqlServer(connectionString)
        .LogTo(Console.WriteLine, LogLevel.Information));
```

El segundo argumento eleva el nivel mínimo. Por defecto `LogTo` emite todo a nivel `Debug` y superior, lo cual es ruidoso. Pasar `LogLevel.Information` lo reduce al acceso a la base de datos más algunos mensajes de mantenimiento, que suele ser lo que realmente quieres cuando persigues una consulta.

## Mostrar los valores de los parámetros en lugar de signos de interrogación

Fíjate en el `@__customerId_0='?'` de la salida anterior. EF Core oculta los valores de los parámetros por defecto porque pueden ser datos personales o sensibles que no deben terminar en un archivo de registro. Cuando depuras localmente y necesitas ver qué valor se envió realmente, activa el registro de datos sensibles:

```csharp
// EF Core 11 - only ever do this in Development
optionsBuilder
    .UseSqlServer(connectionString)
    .LogTo(Console.WriteLine, LogLevel.Information)
    .EnableSensitiveDataLogging();
```

Ahora el parámetro se materializa:

```output
Executed DbCommand (2ms) [Parameters=[@__customerId_0='42' (DbType = Int32)], ...]
SELECT [o].[Id], [o].[CustomerId], [o].[Total]
FROM [Orders] AS [o]
WHERE [o].[CustomerId] = @__customerId_0
```

Protégelo detrás de una comprobación de entorno para que nunca se active en producción. Un registro de consultas filtrado con valores de clave reales es un riesgo genuino de exposición de datos:

```csharp
// EF Core 11, .NET 11
optionsBuilder.UseSqlServer(connectionString);
if (builder.Environment.IsDevelopment())
{
    optionsBuilder
        .LogTo(Console.WriteLine, LogLevel.Information)
        .EnableSensitiveDataLogging();
}
```

Ya que estás aquí, `EnableDetailedErrors()` es un buen complemento. EF Core omite los bloques try-catch por cada valor por rendimiento, lo que hace que algunos errores (por ejemplo, un `NULL` que regresa para una propiedad no anulable) sean difíciles de asociar a un campo concreto. `EnableDetailedErrors()` reintroduce esas comprobaciones y te da un mensaje que nombra la propiedad culpable. Es una ayuda para depurar, no una configuración de producción.

## La forma de ASP.NET Core: Microsoft.Extensions.Logging

En una aplicación ASP.NET Core rara vez necesitas `LogTo` en absoluto. `AddDbContext` y `AddDbContextPool` conectan automáticamente EF Core a la canalización de `Microsoft.Extensions.Logging` de la aplicación, así que el SQL de EF Core fluye por el mismo registrador, proveedores y filtros que el resto de tu aplicación. Lo controlas por completo desde `appsettings.json` estableciendo el nivel para la categoría del comando:

```json
{
  "Logging": {
    "LogLevel": {
      "Default": "Information",
      "Microsoft.AspNetCore": "Warning",
      "Microsoft.EntityFrameworkCore.Database.Command": "Information"
    }
  }
}
```

Esa única línea es todo el truco. La categoría es jerárquica, así que `Microsoft.EntityFrameworkCore.Database.Command` apunta exactamente a los eventos de comandos ejecutados y a nada más. Ponlo en `appsettings.Development.json` para ver el SQL localmente mientras mantienes producción en silencio, y luego actívalo sin un redespliegue cuando necesites diagnosticar algo en un entorno en ejecución.

Si prefieres mantener todo en código, o estás en una aplicación de consola que usa el host genérico, registra un `ILoggerFactory` y entrégalo a EF Core con `UseLoggerFactory`. Almacena la factoría como una única instancia compartida; crear una por contexto provoca fugas de memoria y anula el almacenamiento en caché interno.

```csharp
// EF Core 11, .NET 11
public static readonly ILoggerFactory DbLoggerFactory =
    LoggerFactory.Create(b => b.AddConsole().AddFilter(
        "Microsoft.EntityFrameworkCore.Database.Command", LogLevel.Information));

protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
    => optionsBuilder
        .UseSqlServer(connectionString)
        .UseLoggerFactory(DbLoggerFactory);
```

Como esta ruta es `Microsoft.Extensions.Logging` estándar, cualquier proveedor se conecta de la misma manera. Si diriges los registros a través de Serilog, el SQL de EF Core aterriza en tus destinos sin configuración específica de EF adicional. Esa es la misma canalización que se cubre en [registro estructurado con Serilog y Seq](/es/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/); EF Core es simplemente otra categoría que la alimenta.

## Filtrar hasta dejar solo el SQL

`LogTo` te ofrece tres formas de acotar el flujo a solo los comandos que te interesan. La más legible es por categoría. Usa los nombres fuertemente tipados de `DbLoggerCategory` para no codificar cadenas a mano:

```csharp
// EF Core 11 - only database interactions
optionsBuilder.LogTo(
    Console.WriteLine,
    new[] { DbLoggerCategory.Database.Command.Name },
    LogLevel.Information);
```

También puedes filtrar por ID de evento cuando quieres un evento preciso y nada más. Para solo el SQL en bruto, ese es `RelationalEventId.CommandExecuted`:

```csharp
// EF Core 11 - only the executed-command event
optionsBuilder.LogTo(
    Console.WriteLine,
    new[] { RelationalEventId.CommandExecuted });
```

Y para cualquier cosa que las opciones incorporadas no puedan expresar, pasa un predicado sobre `(eventId, logLevel)`. Esto filtra en la ruta caliente de EF Core, antes de que se construya la cadena del mensaje, así que es más barato que filtrar dentro de tu delegado:

```csharp
// EF Core 11 - custom filter
optionsBuilder.LogTo(
    Console.WriteLine,
    (eventId, level) => eventId == RelationalEventId.CommandExecuted);
```

Filtrar aquí es la manera de mantener legibles los registros de consultas cuando persigues un problema concreto, como detectar el `SELECT` idéntico y repetido que delata un bucle de carga diferida. Si eso es lo que persigues, el filtro por categoría más una revisión de la salida es exactamente la versión manual de [detectar consultas N+1 en EF Core 11](/es/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/).

## Enviar los registros a un archivo

`LogTo` recibe cualquier `Action<string>`, así que escribir en un archivo es solo cuestión de apuntarlo a un `StreamWriter`. Libera el escritor cuando se libere el contexto para que el archivo se cierre limpiamente:

```csharp
// EF Core 11, .NET 11
public sealed class AppDbContext : DbContext
{
    private readonly StreamWriter _log = new("ef-sql.log", append: true);

    protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
        => optionsBuilder
            .UseSqlServer(connectionString)
            .LogTo(_log.WriteLine, LogLevel.Information);

    public override void Dispose()
    {
        base.Dispose();
        _log.Dispose();
    }

    public override async ValueTask DisposeAsync()
    {
        await base.DisposeAsync();
        await _log.DisposeAsync();
    }
}
```

Para un archivo más compacto, pide salida de una sola línea y marcas de tiempo UTC mediante `DbContextLoggerOptions`:

```csharp
// EF Core 11 - compact one-line-per-message format
optionsBuilder.LogTo(
    _log.WriteLine,
    LogLevel.Information,
    DbContextLoggerOptions.UtcTime | DbContextLoggerOptions.SingleLine);
```

Para cualquier cosa más allá de un archivo de depuración desechable, prefiere enrutar a través de `Microsoft.Extensions.Logging` y un destino de archivo real. `LogTo` hacia un `StreamWriter` está bien para un vistazo rápido; no es una estrategia de registro para producción.

## Obtener el SQL de una consulta sin ejecutarla

A veces no quieres una manguera con cada comando. Tienes una consulta LINQ y quieres ver el SQL que producirá. `ToQueryString()` genera el SQL de un `IQueryable` sin ejecutarlo contra la base de datos:

```csharp
// EF Core 11, C# 14
var query = db.Orders
    .Where(o => o.Total > 100)
    .OrderByDescending(o => o.Total);

Console.WriteLine(query.ToQueryString());
```

```output
SELECT [o].[Id], [o].[CustomerId], [o].[Total]
FROM [Orders] AS [o]
WHERE [o].[Total] > 100.0
ORDER BY [o].[Total] DESC
```

Esta es la herramienta a la que recurrir cuando estás refinando una consulta en una prueba o un endpoint de borrador, porque no hay configuración de registro que preparar ni otro ruido. Solo funciona para consultas (`IQueryable`), no para `SaveChanges`, `ExecuteUpdate` o `ExecuteDelete`; para esos, recurre a `LogTo` o a la categoría del comando. Si estás razonando sobre el SQL que emiten las operaciones masivas, las formas mostradas en [ExecuteUpdate y ExecuteDelete para escrituras masivas](/es/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) son lo que verás en el registro de comandos.

## Detalles que conviene conocer

**`CommandExecuted` se dispara después del viaje de ida y vuelta.** El evento `20101` lleva el tiempo, así que se registra una vez que el comando regresa. Si una consulta se cuelga, no verás su SQL en el registro de ejecución porque nunca se completó. Presta atención a `CommandExecuting` (`20100`) si necesitas el SQL antes de la ejecución, o usa `ToQueryString()` para inspeccionarlo estáticamente.

**La configuración se fija en la inicialización.** No puedes adjuntar ni desacoplar `LogTo` después de construir el contexto. Si quieres un interruptor en tiempo de ejecución, captura el delegado y comprueba si es nulo: `optionsBuilder.LogTo(s => _sink?.Invoke(s))`, y luego establece `_sink` bajo demanda. Esto refleja el antiguo comportamiento de `Database.Log` de EF6.

**No llames a `LogTo` dos veces con la intención de agregar destinos.** Una segunda llamada reemplaza la configuración en lugar de sumarse a ella. Para repartir a varios destinos, escribe un delegado que reenvíe a cada uno.

**El registro de datos sensibles y los errores detallados son ambos solo para desarrollo.** `EnableSensitiveDataLogging` pone valores reales de parámetros, incluidas claves y datos personales, en tus registros. `EnableDetailedErrors` agrega sobrecarga por cada lectura. Protege ambos detrás de una comprobación de entorno. Aquí también es donde un registro inesperadamente ruidoso puede filtrar más de lo que pretendes, así que revisa qué retienen tus destinos.

**La categoría, no un interruptor, es tu control de producción.** En una aplicación desplegada, deja EF Core conectado a `Microsoft.Extensions.Logging` y dirige la visibilidad puramente a través del nivel de `Microsoft.EntityFrameworkCore.Database.Command`. Obtienes SQL bajo demanda cambiando un único valor de configuración, y nunca envías un `LogTo(Console.WriteLine)` que olvidaste quitar.

Leer el SQL generado es el primer movimiento en casi toda investigación de rendimiento de EF Core, desde una consulta que se evalúa silenciosamente en el cliente hasta una migración que emite más de lo que esperabas. Una vez que puedes verlo, las soluciones de [la expresión LINQ no se pudo traducir](/es/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) y las notas de cambios importantes en [migrar de EF Core 6 a EF Core 11](/es/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) resultan mucho más fáciles de aplicar, porque estás depurando el SQL real en lugar de adivinarlo.

## Fuentes

- [EF Core simple logging (LogTo) - Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/simple-logging)
- [Using Microsoft.Extensions.Logging with EF Core - Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/extensions-logging)
- [ToQueryString / viewing generated SQL - Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/querying/#viewing-generated-sql)
- [RelationalEventId.CommandExecuted - .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.diagnostics.relationaleventid.commandexecuted)
