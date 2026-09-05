---
title: "¿Qué es un interceptor de EF Core y cuándo necesitas uno?"
description: "Un interceptor de EF Core es una clase que EF llama antes y después de operaciones como ejecutar un comando o SaveChanges, y que puede modificarlas o suprimirlas, no solo observarlas. Aquí están los siete puntos de intercepción de EF Core 11, las reglas de registro y ciclo de vida, y los casos en los que un filtro de consulta o el registro de eventos son la mejor respuesta."
pubDate: 2026-09-05
tags:
  - "ef-core"
  - "dotnet-11"
  - "csharp"
  - "aspnetcore"
lang: "es"
translationOf: "2026/09/what-is-an-ef-core-interceptor-and-when-do-i-need-one"
translatedBy: "claude"
translationDate: 2026-09-05
---

Un interceptor de EF Core es una clase que registras en un `DbContext` y que EF llama antes y después de una operación concreta: crear o ejecutar un comando, abrir una conexión, iniciar una transacción, llamar a `SaveChanges`, materializar una entidad a partir de los resultados de una consulta, compilar una consulta LINQ o resolver un conflicto de identidad. Lo que importa, y lo que separa a los interceptores del registro de eventos, es que la mayoría de los puntos de intercepción te dejan **cambiar o suprimir** la operación en lugar de solo mirarla. Necesitas uno cuando una preocupación debe aplicarse a todos los contextos de la aplicación, no se puede expresar en el modelo y tiene que alterar el comportamiento: estampar columnas de auditoría, agregar una sugerencia a la consulta, resolver una cadena de conexión por tenant o tragarte una excepción de concurrencia que has decidido que es benigna. Si lo único que quieres es ver el SQL, quieres registro de eventos, y un interceptor es la herramienta equivocada.

Todo lo que sigue apunta a EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0, .NET 11, C# 14). La superficie de intercepción en sí no cambió en EF Core 11: las siete interfaces son estables desde que EF Core 7 agregó `IIdentityResolutionInterceptor`. Lo que sí cambió a su alrededor vale la pena conocerlo, y lo cubro en los detalles finales.

## Los siete puntos de intercepción

Todo interceptor implementa una o más interfaces derivadas de `IInterceptor`, todas en el espacio de nombres `Microsoft.EntityFrameworkCore.Diagnostics`:

| Interfaz | Qué intercepta | Singleton |
| --- | --- | --- |
| `IDbCommandInterceptor` | Creación y ejecución de comandos, fallos, liberación del `DbDataReader` | No |
| `IDbConnectionInterceptor` | Crear, abrir y cerrar conexiones; fallos de conexión | No |
| `IDbTransactionInterceptor` | Crear, usar, confirmar y revertir transacciones; puntos de guardado | No |
| `ISaveChangesInterceptor` | `SavingChanges` / `SavedChanges` / `SaveChangesFailed`, concurrencia optimista | No |
| `IMaterializationInterceptor` | Crear, inicializar y finalizar instancias de entidad a partir de resultados de consulta | Sí |
| `IQueryExpressionInterceptor` | El árbol de expresiones LINQ, antes de compilar la consulta | Sí |
| `IIdentityResolutionInterceptor` | Conflictos de identidad cuando el contexto empieza a rastrear una instancia nueva | Sí |

Las tres primeras son solo relacionales; la intercepción de base de datos no está disponible en proveedores no relacionales como el proveedor de Azure Cosmos DB. La columna `Singleton` no es decorativa, y vuelvo a ella más abajo porque equivocarse ahí es la forma más común de hacer que un interceptor destroce el rendimiento en silencio.

Para las cuatro interfaces que no son singleton existen clases base sin lógica: `DbCommandInterceptor`, `DbConnectionInterceptor`, `DbTransactionInterceptor` y `SaveChangesInterceptor`. Hereda de ellas y sobrescribe solo los dos o tres métodos que te interesan, en vez de implementar 20 miembros de interfaz a mano.

## La forma de un par de métodos, y qué significa "suprimir"

Cada punto de intercepción viene en un par antes/después, y cada mitad viene en variantes síncronas y asíncronas. `ReaderExecuting` se ejecuta antes de enviar la consulta a la base de datos; `ReaderExecuted` se ejecuta después de que vuelve. `SavingChanges` se ejecuta antes del guardado; `SavedChanges` después de uno exitoso.

Los métodos "antes" devuelven un `InterceptionResult` o un `InterceptionResult<T>`, y ese valor de retorno es el canal de control:

- Devuelve el argumento `result` sin tocarlo y EF continúa normalmente. Este es el caso de solo observar.
- Devuelve `InterceptionResult.Suppress()` y EF omite la operación por completo. Se usa en operaciones sin valor de retorno, por ejemplo el punto de intercepción `ThrowingConcurrencyException`, donde suprimir significa "no lances `DbUpdateConcurrencyException`".
- Devuelve `InterceptionResult<T>.SuppressWithResult(value)` y EF omite la operación y usa tu valor en su lugar. Se usa en operaciones que producen algo, por ejemplo devolver un `DbDataReader` fabricado desde una caché en vez de ejecutar SQL.

Ese es todo el modelo mental. El registro de eventos te dice qué hizo EF; un interceptor tiene derecho a veto.

Aquí hay un interceptor de comandos mínimo y realmente útil: registrar cualquier comando que tarde más de un umbral, junto con la parte de EF que lo emitió.

```csharp
// .NET 11, C# 14 -- Microsoft.EntityFrameworkCore.Relational 11.0
using System.Data.Common;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Logging;

public sealed class SlowCommandInterceptor(ILogger<SlowCommandInterceptor> logger)
    : DbCommandInterceptor
{
    private static readonly TimeSpan Threshold = TimeSpan.FromMilliseconds(200);

    public override DbDataReader ReaderExecuted(
        DbCommand command,
        CommandExecutedEventData eventData,
        DbDataReader result)
    {
        Report(command, eventData);
        return result;
    }

    public override ValueTask<DbDataReader> ReaderExecutedAsync(
        DbCommand command,
        CommandExecutedEventData eventData,
        DbDataReader result,
        CancellationToken cancellationToken = default)
    {
        Report(command, eventData);
        return new ValueTask<DbDataReader>(result);
    }

    private void Report(DbCommand command, CommandExecutedEventData eventData)
    {
        if (eventData.Duration < Threshold)
        {
            return;
        }

        logger.LogWarning(
            "Slow command ({DurationMs} ms, source {Source}): {Sql}",
            (int)eventData.Duration.TotalMilliseconds,
            eventData.CommandSource,
            command.CommandText);
    }
}
```

Hay dos detalles que la gente pasa por alto. Primero, se implementan tanto la sobrescritura síncrona como la asíncrona. EF llama a la que corresponde a la llamada que hizo la aplicación, así que implementar solo `ReaderExecuted` significa que tu interceptor no hace nada en una base de código asíncrona. Segundo, `eventData.CommandSource` te dice si el comando vino de una consulta, de `SaveChanges`, de `ExecuteUpdate` o de una migración, que suele ser el filtro que de verdad quieres.

## Registrar un interceptor

El registro ocurre cuando se configura el contexto, mediante `DbContextOptionsBuilder.AddInterceptors`:

```csharp
// .NET 11, C# 14 -- Microsoft.EntityFrameworkCore 11.0
builder.Services.AddDbContext<AppDbContext>((sp, options) =>
    options
        .UseSqlServer(builder.Configuration.GetConnectionString("Default"))
        .AddInterceptors(sp.GetRequiredService<SlowCommandInterceptor>()));
```

Resolver el interceptor desde el proveedor de servicios es lo que le permite tomar dependencias por constructor, que es como obtiene el `ILogger` de arriba. Registra primero el interceptor en sí (`builder.Services.AddSingleton<SlowCommandInterceptor>()` aquí, ya que no guarda estado por solicitud).

`OnConfiguring` también funciona, y se sigue ejecutando incluso cuando se usa `AddDbContext`, así que es un lugar razonable para adjuntar interceptores que deben aplicarse sin importar cómo se construya el contexto. Una misma instancia de interceptor puede implementar varias de las interfaces a la vez; regístrala una sola vez y EF enruta cada evento a la interfaz correcta.

## Un interceptor de SaveChanges, de principio a fin

El interceptor real más común es el que estampa columnas de auditoría. Vale la pena escribirlo completo porque el emparejamiento síncrono/asíncrono y la llamada al rastreador de cambios son fáciles de equivocar.

```csharp
// .NET 11, C# 14 -- Microsoft.EntityFrameworkCore 11.0
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;

public interface IAuditable
{
    DateTimeOffset CreatedUtc { get; set; }
    DateTimeOffset ModifiedUtc { get; set; }
}

public sealed class TimestampInterceptor(TimeProvider clock) : SaveChangesInterceptor
{
    public override InterceptionResult<int> SavingChanges(
        DbContextEventData eventData,
        InterceptionResult<int> result)
    {
        Stamp(eventData.Context);
        return result;
    }

    public override ValueTask<InterceptionResult<int>> SavingChangesAsync(
        DbContextEventData eventData,
        InterceptionResult<int> result,
        CancellationToken cancellationToken = default)
    {
        Stamp(eventData.Context);
        return new ValueTask<InterceptionResult<int>>(result);
    }

    private void Stamp(DbContext? context)
    {
        if (context is null)
        {
            return;
        }

        // The docs' own auditing sample calls DetectChanges here rather than
        // assuming the states are already current. Do the same.
        context.ChangeTracker.DetectChanges();

        var now = clock.GetUtcNow();

        foreach (var entry in context.ChangeTracker.Entries<IAuditable>())
        {
            switch (entry.State)
            {
                case EntityState.Added:
                    entry.Entity.CreatedUtc = now;
                    entry.Entity.ModifiedUtc = now;
                    break;
                case EntityState.Modified:
                    entry.Entity.ModifiedUtc = now;
                    break;
            }
        }
    }
}
```

Tomar `TimeProvider` en vez de leer `DateTimeOffset.UtcNow` directamente es lo que hace esto testeable; el mismo razonamiento aplica en cualquier parte de una base de código .NET 11, y encaja con [probar código dependiente del tiempo con FakeTimeProvider](/es/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/). Si quieres la versión completa de este patrón, incluyendo escribir un rastro de cambios y manejar el usuario actual, lo desarrollé aparte en [usar interceptores de EF Core 11 para auditoría](/es/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/).

## Suprimir una operación: el caso de la concurrencia

La demostración más clara del veto es `ISaveChangesInterceptor.ThrowingConcurrencyException`. EF lo llama justo antes de lanzar `DbUpdateConcurrencyException`. Si dos solicitudes compiten por borrar la misma fila, la perdedora ve cero filas afectadas y recibe una excepción, aunque el estado final deseado (la fila ya no está) se haya alcanzado:

```csharp
// .NET 11, C# 14 -- Microsoft.EntityFrameworkCore 11.0
public sealed class SuppressDeleteConcurrencyInterceptor : ISaveChangesInterceptor
{
    public InterceptionResult ThrowingConcurrencyException(
        ConcurrencyExceptionEventData eventData,
        InterceptionResult result)
        => eventData.Entries.All(e => e.State == EntityState.Deleted)
            ? InterceptionResult.Suppress()
            : result;

    public ValueTask<InterceptionResult> ThrowingConcurrencyExceptionAsync(
        ConcurrencyExceptionEventData eventData,
        InterceptionResult result,
        CancellationToken cancellationToken = default)
        => new(ThrowingConcurrencyException(eventData, result));
}
```

`eventData.Entries` te da los objetos `EntityEntry` involucrados, así que la decisión se toma sobre estado real y no sobre una coincidencia de texto contra el mensaje de una excepción. En un proveedor relacional puedes convertir `eventData` a `RelationalConcurrencyExceptionEventData` y leer también el `Command` culpable.

## Cuándo no necesitas un interceptor

Los interceptores son el gancho más pesado que ofrece EF, y recurrir a ellos primero es un error común. Antes de escribir uno, revisa si un mecanismo más liviano cubre el caso.

**Quieres ver el SQL.** Usa `Microsoft.Extensions.Logging` o el registro simple con `LogTo`. La documentación es explícita en que los interceptores no son el mecanismo de registro, y una tubería de registro te da niveles, filtros y destinos gratis. Si persigues la cantidad de consultas más que su texto, el enfoque de [detectar consultas N+1 en EF Core 11](/es/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) se acerca más a lo que quieres, y la configuración general de registro estructurado está en [Serilog y Seq en .NET 11](/es/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/).

**Quieres una devolución de llamada al guardar o al rastrear, y síncrona te sirve.** `DbContext` expone eventos .NET normales: `SavingChanges`, `SavedChanges`, `SaveChangesFailed`, `ChangeTracker.Tracked` y `ChangeTracker.StateChanged`. Se registran por instancia de contexto y se pueden adjuntar en cualquier momento, lo que los hace más simples que un interceptor. La trampa es que los eventos son solo síncronos, así que no pueden hacer E/S sin bloqueo. Los interceptores sí pueden, porque las mitades asíncronas devuelven `ValueTask`.

**Quieres la misma información para todos los contextos del proceso.** Eso es una suscripción de `DiagnosticListener` a la fuente `"Microsoft.EntityFrameworkCore"`, no un interceptor. Los diagnostic listeners son de todo el proceso y solo observan; los interceptores son por contexto y pueden modificar. Elige según ambos ejes, no solo uno.

**Quieres filtrar cada consulta por borrado lógico o por tenant.** Eso es un filtro de consulta, no un `IQueryExpressionInterceptor`. Escribir un `ExpressionVisitor` para inyectar una cláusula `Where` es una cantidad enorme de código frágil para reimplementar algo que el modelo ya hace, y EF Core 10 y 11 admiten varios filtros por entidad que se pueden desactivar de forma independiente, que es justo el caso que la gente solía resolver a mano. Ver [filtros de consulta con nombre para borrado lógico y multi-tenancy](/es/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/).

**Quieres transformar el valor de una propiedad a la entrada y a la salida.** Eso es un convertidor de valores.

**El comportamiento aplica a exactamente una subclase de `DbContext` y solo al guardar.** Sobrescribir `SaveChangesAsync` es más simple, más fácil de leer en una traza de pila y más fácil de probar. Recurre a `ISaveChangesInterceptor` cuando la lógica deba aplicarse a varios tipos de contexto, o cuando tenga que vivir en una biblioteca compartida que no es dueña de la clase del contexto.

## Detalles que cuestan tiempo real

**Interceptores singleton y `ManyServiceProvidersCreatedWarning`.** `IMaterializationInterceptor`, `IQueryExpressionInterceptor` e `IIdentityResolutionInterceptor` se registran en el proveedor de servicios *interno* de EF. Cada instancia distinta que pases a `AddInterceptors` provoca la construcción de un proveedor interno nuevo, así que pasar `new MyMaterializationInterceptor()` dentro de una lambda de `AddDbContext` que corre por scope terminará disparando `ManyServiceProvidersCreatedWarning` y hundiendo el rendimiento. Guarda una sola instancia en un campo estático o resuelve un singleton desde la inyección de dependencias. Como son compartidos, estos interceptores deben ser seguros para hilos y no deberían guardar estado mutable; accede a lo que sea de ámbito reducido mediante la propiedad `Context` de los datos del evento.

**Dependencias de ámbito reducido en un interceptor de `SaveChanges`.** Los interceptores que no son singleton se libran de la restricción anterior, pero si el tuyo depende de algo con ámbito reducido (un accesor del usuario actual, un resolutor de tenant), el propio interceptor debe tener ese ámbito y resolverse mediante la sobrecarga `(sp, options)` de `AddDbContext`. Registrarlo como singleton e inyectarle un servicio de ámbito reducido es la ruta clásica a [cannot consume scoped service from singleton](/es/2026/05/fix-cannot-consume-scoped-service-from-singleton/).

**`ExecuteUpdate` y `ExecuteDelete` nunca llegan a un interceptor de `SaveChanges`.** Las operaciones basadas en conjuntos esquivan el rastreador de cambios y van directas al SQL, así que el estampado de auditoría, la reescritura de borrado lógico y el despacho de eventos de dominio colgados de `SavingChanges` se omiten todos. Es por diseño y es la forma más común de que un rastro de auditoría desarrolle agujeros silenciosos. El compromiso está explicado en [ExecuteUpdate y ExecuteDelete para escrituras masivas](/es/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/). Un `IDbCommandInterceptor` sí ve estos comandos, porque al final todo se convierte en un `DbCommand`.

**`ConnectionCreating` y `ConnectionCreated` solo se disparan cuando EF crea la conexión.** Si tu aplicación construye el `DbConnection` y se lo entrega a EF, esos dos puntos de intercepción nunca se ejecutan. `ConnectionOpening` sí lo hace.

**`IIdentityResolutionInterceptor` no se dispara para resultados de consulta.** A partir de EF Core 11 solo se invoca desde `Update`, `Attach` y llamadas de rastreo similares, no para entidades que vuelven de una consulta. Eso se sigue en [dotnet/efcore #37574](https://github.com/dotnet/efcore/issues/37574) y puede cambiar. Si solo quieres "gana la última escritura" al adjuntar, el `UpdatingIdentityResolutionInterceptor` integrado te ahorra escribir uno.

**Interceptar el árbol de expresiones es el último recurso.** `IQueryExpressionInterceptor` es potente, y el propio ejemplo de la documentación, agregar un orden secundario estable, termina con la observación de que agregar `.ThenBy(e => e.Id)` directamente a la consulta es más simple, más fácil de entender y siempre funciona. Ese es el instinto correcto. Un `ExpressionVisitor` que reescribe en silencio todas las consultas de la aplicación es un problema de depuración que heredas para siempre.

**Los interceptores se ejecutan en orden y pueden ver las decisiones de los demás.** Los interceptores inyectados por extensiones se ejecutan primero, en el orden de resolución del proveedor de servicios, y luego los de la aplicación. Un interceptor posterior puede consultar `InterceptionResult<T>.HasResult` para ver si uno anterior ya suprimió la operación, lo que importa si los apilas.

**Una adición de EF Core 11 que conviene conocer.** `ChangeTracker.GetEntriesForState(added, modified, deleted, unchanged)` es un enumerador filtrado por estado que se salta la pasada implícita de `DetectChanges` que hace `Entries()`. Existe precisamente para rutas calientes como los interceptores de `SaveChanges` y los ganchos de auditoría, donde el mismo recorrido se repite dos veces por guardado. Los detalles y el compromiso están en [EF Core 11 agrega GetEntriesForState](/es/2026/04/efcore-11-changetracker-getentriesforstate/).

## La versión corta

Escribe un interceptor cuando necesites *cambiar* lo que hace EF, en todos los contextos, en un punto que el modelo no puede expresar. Usa el registro de eventos cuando necesites ver qué hizo, eventos .NET cuando necesites una devolución de llamada síncrona simple en un contexto, un diagnostic listener cuando necesites observación en todo el proceso, y un filtro de consulta o un convertidor de valores cuando la preocupación sea en realidad del modelo. Implementa las dos mitades, síncrona y asíncrona, de cualquier par que sobrescribas, mantén los interceptores singleton sin estado y compartidos, y recuerda que todo lo que rodea a `SaveChanges` también rodea a tu `ISaveChangesInterceptor`.

## Relacionado

- [Cómo usar interceptores de EF Core 11 para auditoría](/es/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/)
- [EF Core 11 agrega GetEntriesForState para saltarse DetectChanges](/es/2026/04/efcore-11-changetracker-getentriesforstate/)
- [Cómo usar filtros de consulta con nombre para borrado lógico y multi-tenancy en EF Core 11](/es/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/)
- [Cómo usar ExecuteUpdate y ExecuteDelete para escrituras masivas en EF Core 11](/es/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/)
- [Fix: cannot consume scoped service from singleton](/es/2026/05/fix-cannot-consume-scoped-service-from-singleton/)

## Fuentes

- [Interceptors -- EF Core, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/interceptors)
- [.NET events -- EF Core, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/events)
- [Using diagnostic listeners -- EF Core, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/diagnostic-listeners)
- [IIdentityResolutionInterceptor Interface -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.diagnostics.iidentityresolutioninterceptor)
- [CommandExecutedEventData Class -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.diagnostics.commandexecutedeventdata)
- [What's New in EF Core 11 -- Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [Identity resolution interceptor is not called for query results -- dotnet/efcore #37574](https://github.com/dotnet/efcore/issues/37574)
