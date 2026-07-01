---
title: "Cómo implementar y consumir IAsyncDisposable con await using en C#"
description: "Una guía completa de IAsyncDisposable en C#: cuándo usar await using, cómo escribir DisposeAsync y DisposeAsyncCore correctamente, y los detalles de apilado y ConfigureAwait que provocan fugas de recursos."
pubDate: 2026-07-01
tags:
  - "csharp"
  - "dotnet"
  - "async"
  - "idisposable"
lang: "es"
translationOf: "2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp"
translatedBy: "claude"
translationDate: 2026-07-01
---

Cuando un tipo mantiene un recurso que solo puede liberarse de forma asíncrona (un stream de red que tiene que vaciarse, una transacción de base de datos que tiene que confirmarse o revertirse, un escritor de canal que tiene que drenarse), `IDisposable` es el contrato equivocado. Su método `Dispose()` es síncrono, así que la única manera de ejecutar limpieza asíncrona desde él es bloquear sobre una `Task`, lo que arriesga interbloqueos y agotamiento del grupo de subprocesos. C# 8.0 (lanzado con .NET Core 3.0) agregó `IAsyncDisposable` y la instrucción `await using` precisamente para este caso. Este artículo cubre ambos lados: cómo consumir un tipo async-disposable con `await using`, y cómo implementar `DisposeAsync` correctamente, incluyendo el patrón `DisposeAsyncCore` y los dos detalles (el apilado y `ConfigureAwait`) que provocan fugas de recursos de forma silenciosa. Todos los ejemplos apuntan a .NET 11 y C# 14, pero la API y la semántica no han cambiado desde C# 8.0.

## Por qué un Dispose síncrono no basta

`IDisposable.Dispose()` devuelve `void`. Si tu limpieza necesita `await` (vaciar un búfer a un socket, enviar un frame final, confirmar una transacción), tienes tres malas opciones dentro de un `Dispose` síncrono: bloquear con `.GetAwaiter().GetResult()`, bloquear con `.Wait()`, o disparar y olvidar y esperar que termine. Las dos primeras pueden provocar interbloqueos en contextos con un contexto de sincronización de un solo hilo y mantendrán ocupado un hilo del grupo de subprocesos durante toda la operación de E/S; la tercera pierde errores y puede liberar el handle subyacente antes de que el trabajo asíncrono se complete.

`IAsyncDisposable` soluciona esto al hacer que la limpieza en sí sea esperable:

```csharp
// System namespace, available since .NET Core 3.0 / C# 8.0
public interface IAsyncDisposable
{
    ValueTask DisposeAsync();
}
```

Observa que el tipo de retorno es `ValueTask`, no `Task`. La liberación con frecuencia se completa de forma síncrona (no hay nada que vaciar), y `ValueTask` evita asignar un objeto `Task` en ese camino común. Casi nunca haces `await` sobre una llamada `DisposeAsync()` pura tú mismo; el compilador lo hace por ti a través de `await using`.

## Consumir un async-disposable con await using

El lado del consumidor es la parte que escribirás con más frecuencia, porque el framework ya implementa `IAsyncDisposable` en los tipos que te importan: `Stream`, `FileStream`, `DbConnection`, `DbTransaction`, `Utf8JsonWriter`, los envoltorios de `ChannelWriter<T>`, `ServiceProvider` y más.

Hay dos formas. La instrucción `await using` limita la limpieza a un bloque explícito:

```csharp
// .NET 11, C# 14
await using (var stream = new FileStream("data.bin", FileMode.Open))
{
    await stream.ReadAsync(buffer);
} // DisposeAsync() is awaited here, at the closing brace
```

La declaración `await using` limita la limpieza al final del bloque contenedor, sin anidamiento extra:

```csharp
// .NET 11, C# 14
static async Task ProcessAsync()
{
    await using var stream = new FileStream("data.bin", FileMode.Open);

    await stream.ReadAsync(buffer);

    // DisposeAsync() is awaited when ProcessAsync's body exits,
    // whether by return or by an exception.
}
```

Ambas requieren que el método contenedor sea `async`, porque `await using` inserta un `await` en el punto de liberación. Si escribes `await using` en un método que no es async obtienes un error de compilación, y si accidentalmente omites el `await` y escribes un `using` normal sobre un `IAsyncDisposable`, el compilador llama al `Dispose()` síncrono si el tipo también implementa `IDisposable`, o no compila si solo implementa `IAsyncDisposable`. Ese repliegue silencioso a la liberación síncrona es una fuente real de errores: usa siempre `await using` cuando el tipo sea async-disposable.

Un modismo común que verás con las pilas de EF Core y ADO.NET apila dos `await` en una línea, uno para la llamada de fábrica y otro oculto en la liberación:

```csharp
// .NET 11, C# 14 -- EF Core 11
await using var transaction = await context.Database.BeginTransactionAsync(token);

await context.SaveChangesAsync(token);
await transaction.CommitAsync(token);
// If CommitAsync is not reached (exception), DisposeAsync rolls back.
```

El primer `await` desenvuelve la `Task<IDbContextTransaction>` de `BeginTransactionAsync`; el `await using` dispone que `DisposeAsync` se espere cuando el bloque salga. Si una excepción salta `CommitAsync`, el `DisposeAsync` de la transacción revierte por ti.

## Implementar IAsyncDisposable cuando la clase es sealed

Si tu tipo es `sealed` (o tienes la certeza de que nunca tendrá subclases), la implementación es corta. Simplemente libera tus recursos en `DisposeAsync`:

```csharp
// .NET 11, C# 14
public sealed class MetricsFlusher : IAsyncDisposable
{
    private readonly Channel<Metric> _channel = Channel.CreateUnbounded<Metric>();
    private readonly HttpClient _http;

    public MetricsFlusher(HttpClient http) => _http = http;

    public async ValueTask DisposeAsync()
    {
        _channel.Writer.Complete();

        // Drain and ship whatever is buffered before we go away.
        await foreach (var metric in _channel.Reader.ReadAllAsync())
        {
            await _http.PostAsJsonAsync("/metrics", metric);
        }
    }
}
```

Como la clase es `sealed`, no hay ningún tipo derivado al que encadenar la limpieza, así que no necesitas la división `DisposeAsyncCore` que se describe a continuación, y no necesitas `GC.SuppressFinalize` a menos que la clase también declare un finalizador (una clase sealed que solo posee recursos asíncronos administrados rara vez lo hace).

## Implementar el patrón completo de liberación asíncrona para una clase base

En el momento en que tu clase *no* es sealed, la guía de Microsoft cambia. Cualquier clase no sealed es una clase base potencial, y una clase derivada necesita un enganche para agregar su propia limpieza asíncrona y componerla con la limpieza de la clase base. Ese enganche es un método `protected virtual ValueTask DisposeAsyncCore()`. `DisposeAsync` se vuelve código repetitivo que llama a `DisposeAsyncCore`, suprime la finalización y retorna:

```csharp
// .NET 11, C# 14
public class ExampleAsyncDisposable : IAsyncDisposable
{
    private IAsyncDisposable? _inner = new SomeAsyncResource();

    public async ValueTask DisposeAsync()
    {
        await DisposeAsyncCore().ConfigureAwait(false);
        GC.SuppressFinalize(this);
    }

    protected virtual async ValueTask DisposeAsyncCore()
    {
        if (_inner is not null)
        {
            await _inner.DisposeAsync().ConfigureAwait(false);
        }
        _inner = null;
    }
}
```

Una clase derivada sobreescribe `DisposeAsyncCore`, limpia sus propios recursos y encadena a `base.DisposeAsyncCore()`. Nunca toca `DisposeAsync`, así que la llamada `GC.SuppressFinalize(this)` se ejecuta exactamente una vez, en el nivel más derivado. Esto refleja el patrón síncrono `Dispose()` / `protected virtual void Dispose(bool)`, solo que con tipos de retorno `ValueTask` y sin el parámetro `bool disposing` (no hay camino de finalizador que distinguir en el caso puramente asíncrono).

## Soportar tanto IDisposable como IAsyncDisposable

Es común implementar ambas interfaces, de modo que tanto quienes usan `using` síncrono como quienes usan `await using` obtengan una limpieza correcta. El detalle crítico: si implementas solo `IAsyncDisposable` y quien llama envuelve tu objeto en un `using` normal (o lo entrega a un contenedor que solo conoce `IDisposable`), tu `DisposeAsync` nunca se ejecuta y filtras el recurso. Microsoft lo señala explícitamente como una advertencia.

El patrón dual enruta ambos puntos de entrada a través de lógica compartida y usa `Dispose(false)` desde el camino asíncrono para que los recursos administrados no se liberen dos veces:

```csharp
// .NET 11, C# 14
public class DualDisposable : IDisposable, IAsyncDisposable
{
    private Stream? _managed = new MemoryStream();
    private IAsyncDisposable? _asyncOnly = new SomeAsyncResource();

    public void Dispose()
    {
        Dispose(disposing: true);
        GC.SuppressFinalize(this);
    }

    public async ValueTask DisposeAsync()
    {
        await DisposeAsyncCore().ConfigureAwait(false);
        Dispose(disposing: false); // false: async path already handled managed async resources
        GC.SuppressFinalize(this);
    }

    protected virtual void Dispose(bool disposing)
    {
        if (disposing)
        {
            _managed?.Dispose();
            _managed = null;

            if (_asyncOnly is IDisposable d)
            {
                d.Dispose();
                _asyncOnly = null;
            }
        }
    }

    protected virtual async ValueTask DisposeAsyncCore()
    {
        if (_asyncOnly is not null)
        {
            await _asyncOnly.DisposeAsync().ConfigureAwait(false);
        }

        if (_managed is IAsyncDisposable ad)
        {
            await ad.DisposeAsync().ConfigureAwait(false);
        }
        else
        {
            _managed?.Dispose();
        }

        _asyncOnly = null;
        _managed = null;
    }
}
```

El camino de `DisposeAsync` pasa `false` a `Dispose(bool)` porque `DisposeAsyncCore` ya liberó los recursos administrados de forma asíncrona; pasar `true` intentaría liberarlos por segunda vez. Esto mantiene ambos caminos funcionalmente equivalentes sin doble liberación.

## El detalle de apilado que se salta DisposeAsync

Este muerde a quienes intentan ser ordenados. No puedes "apilar" instrucciones `await using` como sí puedes apilar instrucciones `using` síncronas, porque si un constructor posterior al primero lanza una excepción, los objetos creados antes nunca se liberan:

```csharp
// .NET 11, C# 14 -- DO NOT DO THIS
var one = new ExampleAsyncDisposable();
var two = new AnotherAsyncDisposable(); // if this constructor throws...

await using (one.ConfigureAwait(false))
await using (two.ConfigureAwait(false))
{
    // ...neither one nor two has DisposeAsync called.
}
```

El problema es que los objetos se construyen *antes* de entrar a los bloques `await using`, así que una excepción entre la construcción y el bloque los deja sin liberar. La solución es construir y delimitar el alcance en el mismo paso. Cualquiera de estas tres formas es segura:

```csharp
// .NET 11, C# 14 -- nested blocks
var one = new ExampleAsyncDisposable();
await using (one.ConfigureAwait(false))
{
    var two = new AnotherAsyncDisposable();
    await using (two.ConfigureAwait(false))
    {
        // two is disposed first, then one
    }
}

// .NET 11, C# 14 -- sequential declarations (cleanest)
await using var a = new ExampleAsyncDisposable();
await using var b = new AnotherAsyncDisposable();
// b is disposed before a at the end of the method
```

Prefiere la forma de declaración. Si un constructor lanza una excepción, la limpieza generada por el compilador para las variables ya declaradas aún se ejecuta, y evitas toda esa clase de errores de apilado.

## ConfigureAwait sobre await using

Dentro del código de una biblioteca a menudo quieres `ConfigureAwait(false)` para que la continuación de la liberación no capture el contexto de sincronización original. No puedes simplemente agregarlo al objeto; existe una extensión dedicada, `ConfigureAwait(IAsyncDisposable, bool)`, que devuelve un `ConfiguredAsyncDisposable`:

```csharp
// .NET 11, C# 14
await using (stream.ConfigureAwait(false))
{
    await stream.ReadAsync(buffer);
}
```

En el código de aplicación sin ningún contexto de sincronización que capturar (ASP.NET Core, aplicaciones de consola, servicios de trabajo), puedes omitirlo; allí no tiene efecto. En una biblioteca que podría ser llamada desde una interfaz de usuario o un contexto de ASP.NET heredado, agrégalo, siguiendo el mismo razonamiento que usas para `ConfigureAwait(false)` en los await ordinarios.

## Dónde no tienes que liberar en absoluto

La inyección de dependencias se encarga de esto por ti. Cuando registras un servicio en un `IServiceCollection`, el contenedor rastrea si la instancia resuelta implementa `IDisposable` o `IAsyncDisposable` y la libera al final de su ámbito. Un servicio con ámbito (scoped) que implementa `IAsyncDisposable` tiene su `DisposeAsync` esperado cuando el ámbito de la solicitud finaliza, siempre que el ámbito en sí se haya creado y liberado de forma asíncrona (ASP.NET Core hace esto). No escribes `await using` sobre los servicios inyectados; dejas que el contenedor posea su ciclo de vida. Liberar manualmente un servicio inyectado es un error que puede liberarlo por debajo de otros consumidores.

## Cuándo recurrir a IAsyncDisposable

Úsalo cuando la liberación realmente tenga que hacer E/S: vaciar un escritor con búfer a un socket o archivo, confirmar o revertir una transacción, completar y drenar un [Channel](/es/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/), o cerrar con elegancia una conexión de larga duración. No lo agregues a un tipo cuya limpieza sea puramente síncrona (liberar un handle, limpiar un campo); un `IDisposable` normal es más simple y no obliga a cada llamador a entrar en un método async. Y si tu tipo produce un stream asíncrono, combínalo con [IAsyncEnumerable&lt;T&gt;](/es/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) en lugar de intentar acoplar el streaming a la liberación.

La liberación asíncrona es una pieza de la historia más amplia de la corrección asíncrona. Si tu `DisposeAsync` hace trabajo real, propaga por él un tiempo de espera consciente de la cancelación de la misma manera en que [aplicarías un tiempo de espera a cualquier operación asíncrona con CancellationTokenSource.CancelAfter](/es/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/), y asegúrate de [propagar un CancellationToken a través de tus métodos async](/es/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/) para que la limpieza pueda acotarse. Cuando la limpieza implica detener trabajo en curso, aplica aquí la misma disciplina que te permite [cancelar una Task de larga duración sin interbloqueos](/es/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/).

Haz bien las dos reglas y la liberación asíncrona se vuelve aburrida en el mejor sentido: usa `await using` en el lado consumidor, y en el lado de la implementación divide `DisposeAsync` de `DisposeAsyncCore` para tipos no sealed, implementa también `IDisposable` si un llamador síncrono podría liberarte, y nunca apiles bloques `await using`.

## Fuentes

- [Implementar un método DisposeAsync (MS Learn)](https://learn.microsoft.com/en-us/dotnet/standard/garbage-collection/implementing-disposeasync)
- [Interfaz IAsyncDisposable (referencia de la API en MS Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.iasyncdisposable)
- [Instrucción y declaración using (referencia del lenguaje C#)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/statements/using)
- [Preguntas frecuentes sobre ConfigureAwait (.NET Blog)](https://devblogs.microsoft.com/dotnet/configureawait-faq/)
