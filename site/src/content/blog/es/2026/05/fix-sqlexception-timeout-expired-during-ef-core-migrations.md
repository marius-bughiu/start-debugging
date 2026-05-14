---
title: "Solución: SqlException: Timeout expired durante migraciones de EF Core"
description: "Las migraciones usan el DbContext de diseño, no tu CommandTimeout de ejecución. Configura el tiempo de espera con UseSqlServer(o => o.CommandTimeout(...)), con Command Timeout en la cadena de conexión, o con Database.SetCommandTimeout antes de Migrate()."
pubDate: 2026-05-14
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "migrations"
lang: "es"
translationOf: "2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations"
translatedBy: "claude"
translationDate: 2026-05-14
---

La solución: `dotnet ef database update` se conecta a través del `DbContext` de diseño, ejecuta cada paso de la migración como un solo comando y hereda el `CommandTimeout` predeterminado del proveedor de SQL Server, que es de 30 segundos. Las migraciones largas (`AlterColumn` grandes, reconstrucciones de índices, rellenos de datos) superan los 30 segundos y SqlClient lanza `Microsoft.Data.SqlClient.SqlException (0x80131904): Execution Timeout Expired`. Configura el tiempo de espera en tres lugares, en este orden de preferencia: un `o.CommandTimeout(600)` a nivel del proveedor en `UseSqlServer`, un `Command Timeout=600` en la cadena de conexión usada en tiempo de diseño, o aplica las migraciones desde tu aplicación con `context.Database.SetCommandTimeout(TimeSpan.FromMinutes(10))` antes de llamar a `Migrate()`. La CLI `dotnet ef database update` no tiene ninguna opción `--command-timeout` en EF Core 11, y este es el dato que más tiempo hace perder al perseguir este error.

```text
Microsoft.Data.SqlClient.SqlException (0x80131904): Execution Timeout Expired.
The timeout period elapsed prior to completion of the operation or the server is not responding.
 ---> System.ComponentModel.Win32Exception (258): The wait operation timed out.
   at Microsoft.Data.SqlClient.SqlCommand.<>c.<ExecuteDbDataReaderAsync>b__214_0(Task`1 result)
   at Microsoft.EntityFrameworkCore.Storage.RelationalCommand.ExecuteReader(RelationalCommandParameterObject parameterObject)
   at Microsoft.EntityFrameworkCore.Migrations.MigrationCommandExecutor.ExecuteNonQuery(IEnumerable`1 migrationCommands, IRelationalConnection connection, MigrationExecutionState executionState, Boolean commitTransaction, Nullable`1 isolationLevel)
   at Microsoft.EntityFrameworkCore.Migrations.Internal.Migrator.Migrate(String targetMigration)
   at Microsoft.EntityFrameworkCore.Design.Internal.MigrationsOperations.UpdateDatabase(String targetMigration, String connectionString, String contextType)
ClientConnectionId:7c2f9aa3-...
Error Number:-2,State:0,Class:11
```

Esta guía está escrita contra .NET 11 preview 4, `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0-preview.4, `Microsoft.Data.SqlClient` 6.0.x y `dotnet-ef` 11.0.0-preview.4. El mensaje de error ha sido estable a través de las versiones de SqlClient, solo cambió el espacio de nombres de `System.Data.SqlClient` a `Microsoft.Data.SqlClient` cuando el proveedor cambió en EF Core 3.0. El `Error Number:-2` es la señal canónica: un valor de `-2` en `SqlException.Number` es el tiempo de espera del comando del lado del cliente, no un fallo del lado del servidor. Si ves `Error Number:1222` u otro código positivo, estás ante un problema distinto (espera de bloqueo, fallo de inicio de sesión) que el resto de este artículo no resuelve.

## Por qué las migraciones expiran cuando las consultas en tiempo de ejecución no lo hacen

Hay dos instancias de `DbContext` involucradas durante una migración. La que tu aplicación ASP.NET Core usa en tiempo de ejecución, configurada con `AddDbContext`, y la que `dotnet ef` construye en tiempo de diseño. No son la misma instancia y no necesariamente comparten configuración. Las herramientas de migración de EF Core descubren un `DbContext` mediante uno de los tres mecanismos documentados en la [referencia de la CLI de EF Core](https://learn.microsoft.com/en-us/ef/core/cli/dotnet): llama a un `CreateHostBuilder(string[])` público estático en tu clase `Program`, busca un `IDesignTimeDbContextFactory<TContext>`, o recurre a ejecutar el host de tu aplicación para que `AddDbContext` registre el contexto. En todos los caminos construye un `DbContext` nuevo y lo usa para las migraciones.

El `CommandTimeout` predeterminado del proveedor de SQL Server es el predeterminado de `SqlCommand` subyacente, que es de 30 segundos. Un `SetCommandTimeout` que llames en algún lugar de un pipeline de solicitud se ejecuta en la instancia de tiempo de ejecución, no en la de tiempo de diseño. Un `AlterColumn` que tarda 90 segundos porque la tabla tiene 8 millones de filas termina enviado como un solo comando sobre un `DbCommand` cuyo `CommandTimeout` es 30, y SqlClient lo cancela tras 30 segundos.

Dos cosas hacen que esto falle peor de lo que debería. Primero, una migración solo registra su fila en `__EFMigrationsHistory` cuando tiene éxito. Si el comando expira a mitad de camino, puedes acabar con un esquema parcialmente aplicado, la fila de la migración ausente y la siguiente `dotnet ef database update` reintentando la misma operación larga desde cero. Segundo, EF Core 9 y posteriores envuelven cada migración en una transacción de forma predeterminada salvo que lo desactives. Cuando salta el tiempo de espera del comando, SQL Server revierte toda la migración, que es el resultado más seguro pero también el que te cuesta otros 30 segundos de tiempo real en el siguiente intento.

El lado de la CLI es sencillo. `dotnet ef database update` acepta `--connection`, `--context`, `--project`, `--startup-project` y las opciones comunes. No existe `--command-timeout`. El equipo de EF Core ha llevado el seguimiento en [dotnet/efcore#6613](https://github.com/dotnet/efcore/issues/6613) durante años; la respuesta canónica sigue siendo "configúralo en el `DbContext`".

## Reproducción mínima

Basta con una tabla con suficientes filas para que cualquier `AlterColumn` tarde más de 30 segundos.

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4
public class Order
{
    public int Id { get; set; }
    public string Reference { get; set; } = "";
    public decimal Total { get; set; }
}

public class OrdersContext : DbContext
{
    public DbSet<Order> Orders => Set<Order>();

    protected override void OnConfiguring(DbContextOptionsBuilder options)
        => options.UseSqlServer(
            "Server=localhost;Database=Orders;Integrated Security=true;Encrypt=false");
}
```

Añade una migración que amplíe `Reference` de `nvarchar(50)` a `nvarchar(450)` para que SQL Server tenga que reescribir cada fila en vez de hacer un cambio solo de metadatos:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4
public partial class WidenReference : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AlterColumn<string>(
            name: "Reference",
            table: "Orders",
            type: "nvarchar(450)",
            maxLength: 450,
            nullable: false,
            oldClrType: typeof(string),
            oldType: "nvarchar(50)",
            oldMaxLength: 50);
    }
}
```

Ejecuta `dotnet ef database update` contra una tabla `Orders` con unos cuantos millones de filas. Con el tiempo de espera predeterminado de 30 segundos, el comando lanza exactamente la traza de pila del inicio de este artículo.

## La solución, en detalle

Elige la opción que coincida con cómo se aplican las migraciones en tu proyecto. La clasificación de abajo es por mantenibilidad, no por facilidad.

### 1. Configurar CommandTimeout en el proveedor de tu DbContext

Es la solución canónica. Vincula el tiempo de espera al `DbContext` de modo que todas las rutas, tanto en tiempo de diseño como en tiempo de ejecución, obtengan el mismo valor.

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4
public class OrdersContext : DbContext
{
    public OrdersContext(DbContextOptions<OrdersContext> options) : base(options) { }
}

// Program.cs
builder.Services.AddDbContext<OrdersContext>(options =>
    options.UseSqlServer(
        builder.Configuration.GetConnectionString("Orders"),
        sql => sql.CommandTimeout(600))); // 10 minutos
```

El segundo argumento de `UseSqlServer` es un `Action<SqlServerDbContextOptionsBuilder>`. `CommandTimeout(int seconds)` vive en [SqlServerDbContextOptionsBuilder](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.infrastructure.sqlserverdbcontextoptionsbuilder.commandtimeout). Configura el `CommandTimeout` para cada `DbCommand` que EF Core construya sobre este contexto, incluidos los que envía el ejecutor de migraciones.

Si tienes un `IDesignTimeDbContextFactory<OrdersContext>` para las herramientas, configúralo también ahí. `dotnet ef` prefiere `IDesignTimeDbContextFactory<T>` sobre `CreateHostBuilder` cuando ambos están presentes, así que esta sobrescritura entra en vigor para las ejecuciones de tiempo de diseño:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4
public class OrdersContextFactory : IDesignTimeDbContextFactory<OrdersContext>
{
    public OrdersContext CreateDbContext(string[] args)
    {
        var connectionString = Environment.GetEnvironmentVariable("ORDERS_CONNECTION")
            ?? "Server=localhost;Database=Orders;Integrated Security=true;Encrypt=false";

        var options = new DbContextOptionsBuilder<OrdersContext>()
            .UseSqlServer(connectionString, sql => sql.CommandTimeout(600))
            .Options;

        return new OrdersContext(options);
    }
}
```

### 2. Poner `Command Timeout` en la cadena de conexión

Si no puedes editar el `DbContext` (estás migrando el paquete de otra persona, o tu descubrimiento de tiempo de diseño usa una cadena de conexión pasada por CI), configura el tiempo de espera en la cadena de conexión y SqlClient lo aplica a cada comando:

```text
Server=tcp:prod-sql.contoso.com;Database=Orders;Authentication=Active Directory Default;Encrypt=true;Command Timeout=600
```

La palabra clave `Command Timeout` la admite `Microsoft.Data.SqlClient` y se propaga a `SqlCommand.CommandTimeout`. Los pipelines de CI que envían un paquete de migración y pasan `--connection` lo reciben gratis:

```bash
./efbundle --connection "Server=...;Command Timeout=600"
```

El ejecutable del paquete no tiene su propia opción `--timeout` (consulta [la referencia de `dotnet ef migrations bundle`](https://learn.microsoft.com/en-us/ef/core/cli/dotnet#dotnet-ef-migrations-bundle)). La cadena de conexión es el único control que expone el paquete.

### 3. Aplicar migraciones desde código con `SetCommandTimeout`

Si llamas a `context.Database.Migrate()` desde tu app (un patrón habitual en servicios autohospedados y en pruebas de integración), configura el tiempo de espera en la fachada `Database` viva justo antes de la llamada. `SetCommandTimeout` muta el tiempo de espera de comando de tiempo de ejecución sobre la conexión del contexto:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4
using var scope = app.Services.CreateScope();
var db = scope.ServiceProvider.GetRequiredService<OrdersContext>();

db.Database.SetCommandTimeout(TimeSpan.FromMinutes(10));
await db.Database.MigrateAsync();
```

`Database.SetCommandTimeout` está documentado en [RelationalDatabaseFacadeExtensions](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.relationaldatabasefacadeextensions.setcommandtimeout). Acepta un `int` (segundos) o un `TimeSpan`. El valor persiste durante toda la vida del contexto, así que una sola asignación basta para cubrir una llamada completa a `MigrateAsync`. Es el patrón adecuado para [pruebas de integración que levantan un SQL Server real con Testcontainers](/es/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/), ya que el orquestador de pruebas se encarga de aplicar la migración.

## Trampas y variantes que el tráfico de búsqueda mezcla

### "Timeout expired" con `Error Number != -2`

Si `SqlException.Number` no es `-2`, tu problema no es un tiempo de espera de comando del lado del cliente. Los dos alternativos más comunes con el mismo texto son:

- `Error Number:1222` es un tiempo de espera de bloqueo. Otra sesión mantiene un bloqueo sobre el objeto que intentas alterar y se ha disparado el `LOCK_TIMEOUT` de SQL Server. Subir `CommandTimeout` chocará contra la misma pared; la solución es encontrar al bloqueador (`sp_who2`, `sys.dm_exec_requests`).
- `Error Number:-2` con `State:0,Class:11` y un `ClientConnectionId` es el tiempo de espera de comando canónico del lado del cliente de SqlClient, el que arregla este artículo.

### Connection Timeout vs Command Timeout

`Connection Timeout=30` (también escrito `Connect Timeout`) en la cadena de conexión es el tiempo que SqlClient espera para abrir la conexión TCP. No afecta a cuánto puede tardar un solo comando. Si solo cambiaste `Connection Timeout` y no `Command Timeout`, has tocado el mando equivocado. La documentación anterior a EF Core 11 a veces los usa de forma intercambiable en prosa; los nombres reales de las propiedades son inequívocos.

### Migraciones que envuelven varias llamadas a `AlterColumn`

EF Core agrupa las operaciones en un mismo método `Up` en una sola transacción de forma predeterminada. El temporizador de 30 segundos es por `DbCommand`, no por migración, pero un solo `AlterColumn` sobre una tabla caliente es fácilmente un comando largo. Si tienes varias operaciones largas en una sola migración, basta con subir `CommandTimeout` una vez; no necesitas partir la migración. Cuando sí quieras partirla, los [comandos de migración de un solo paso en EF Core 11 como `dotnet ef migrations update --add`](/es/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/) te permiten escalonar el trabajo de manera más limpia.

### Azure SQL estrangula la migración larga

Si subes el tiempo de espera a 30 minutos y la migración sigue fallando hacia los 60 segundos con el mismo mensaje, no estás chocando con el tiempo de espera del cliente, sino con el gateway de Azure SQL. El gateway mantiene sesiones TCP inactivas pero puede cerrarlas durante conmutaciones por error, estrangulamiento o actualizaciones del servicio. Dos mitigaciones: convierte la operación en una reconstrucción de índice en línea con `WITH (ONLINE = ON)` para que el bloqueo largo se rompa en bloqueos más cortos, y activa [`EnableRetryOnFailure`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.infrastructure.sqlserverdbcontextoptionsbuilder.enableretryonfailure) para que el ejecutor de migraciones reintente la operación bajo la misma política de fallos transitorios que ya usa tu app:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4
options.UseSqlServer(connectionString, sql =>
{
    sql.CommandTimeout(1800);              // 30 minutos
    sql.EnableRetryOnFailure(
        maxRetryCount: 3,
        maxRetryDelay: TimeSpan.FromSeconds(30),
        errorNumbersToAdd: null);
});
```

### "Funciona en mi máquina, falla en CI"

Dos causas específicas. Primera: tu SQL Server local es pequeño y la tabla tiene 200 filas, así que el `AlterColumn` termina en 200 ms. CI corre contra una base de datos de staging con el recuento real de filas, donde el mismo comando tarda minutos. Segunda: tu app local usa la configuración del `DbContext` en tiempo de ejecución con un `CommandTimeout` generoso, mientras que CI ejecuta `dotnet ef database update` y descubre un `DbContext` de tiempo de diseño distinto que no tiene tu sobrescritura. Las [reglas de descubrimiento del `DbContext` de tiempo de diseño](/es/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/) explican por qué CI acaba con un contexto distinto del que usa tu app en tiempo de ejecución.

### Comportamiento de timeout async vs sync

`SqlException.Number == -2` se dispara igual para `ExecuteNonQuery` y `ExecuteNonQueryAsync`. Cambiar a `MigrateAsync` no te salva, solo libera el hilo que llama. `SetCommandTimeout` es el único mando que importa aquí.

### La tabla del historial de migraciones está a medio escribir

Si el comando mató la conexión a mitad de camino y te quedas atascado en la siguiente ejecución porque EF Core cree que la migración se aplicó, mira `__EFMigrationsHistory`. Si la fila falta pero el cambio de columna está parcialmente aplicado, puedes revertir la DDL parcial a mano con un solo `ALTER` y reejecutar la migración, o insertar la fila en `__EFMigrationsHistory` y escribir una migración posterior que termine el trabajo. No borres filas no relacionadas de esa tabla, EF Core las usa para averiguar qué operaciones `Down()` ejecutar.

## Relacionado

- [Solución: dotnet ef migrations add falla con "Unable to create an object of type DbContext"](/es/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/) para el problema de descubrimiento de tiempo de diseño aguas arriba.
- [Migraciones de un solo paso en EF Core 11 con dotnet ef migrations update --add](/es/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/) si es más fácil partir una migración larga que subirle el tiempo de espera.
- [Escribe pruebas de integración contra un SQL Server real con Testcontainers](/es/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/), ya que `Database.SetCommandTimeout` más `MigrateAsync` es el patrón estándar de preparación de pruebas.
- [Solución: A second operation was started on this context instance](/es/2026/05/fix-second-operation-was-started-on-this-context-instance/) para otra excepción con forma de problema de temporización que se busca a menudo junto a esta.
- [Cómo detectar consultas N+1 en EF Core 11](/es/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) para el tipo de regresión en tiempo de ejecución que carga tanto la base de datos que incluso las migraciones pequeñas empiezan a expirar.

## Fuentes

- [Referencia de la CLI de EF Core](https://learn.microsoft.com/en-us/ef/core/cli/dotnet) - la lista canónica de opciones de `dotnet ef`.
- API de [SqlServerDbContextOptionsBuilder.CommandTimeout](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.infrastructure.sqlserverdbcontextoptionsbuilder.commandtimeout).
- API de [RelationalDatabaseFacadeExtensions.SetCommandTimeout](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.relationaldatabasefacadeextensions.setcommandtimeout).
- [dotnet/efcore#6613](https://github.com/dotnet/efcore/issues/6613) "Allow customizing migration commands timeout" registra por qué no existe una opción CLI.
- [dotnet/efcore#22887](https://github.com/dotnet/efcore/issues/22887) cubre el caso del paquete de migración y la alternativa de la cadena de conexión.
