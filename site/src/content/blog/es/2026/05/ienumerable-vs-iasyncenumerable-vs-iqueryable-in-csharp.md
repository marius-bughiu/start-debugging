---
title: "IEnumerable vs IAsyncEnumerable vs IQueryable en C#: ¿cuál debe devolver el método?"
description: "Tres interfaces de secuencia, tres modelos de ejecución. Usa IQueryable cuando una base de datos pueda traducir la consulta, IAsyncEnumerable cuando el productor es asíncrono y quieres transmitir, IEnumerable para todo lo demás en memoria."
pubDate: 2026-05-21
template: vs
tags:
  - "comparison"
  - "csharp"
  - "linq"
  - "ef-core"
  - "async"
  - "dotnet-11"
lang: "es"
translationOf: "2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp"
translatedBy: "claude"
translationDate: 2026-05-21
---

Si estás eligiendo entre `IEnumerable<T>`, `IAsyncEnumerable<T>` e `IQueryable<T>` para la firma de un método en C# 14 / .NET 11, la regla es casi mecánica. Devuelve `IQueryable<T>` solo cuando el consumidor pueda componer más llamadas `Where`/`Select`/`OrderBy` y el proveedor subyacente (EF Core 11, LINQ to SQL, un cliente OData) pueda traducirlas a la consulta remota. Devuelve `IAsyncEnumerable<T>` cuando el productor hace E/S por elemento o por lote y quieres que el consumidor empiece a procesar antes de que el productor termine. Devuelve `IEnumerable<T>` para todo lo que ya está en memoria o que has decidido materializar completamente en la frontera. El error a evitar es filtrar `IQueryable<T>` fuera de un repositorio: cada `.Where(...)` posterior pasa a formar parte del SQL, lo quieras o no, y "dónde se ejecuta realmente esta consulta" se convierte en una pregunta que tienes que responder con el depurador.

Esta publicación es la versión larga. Todos los ejemplos apuntan a `<TargetFramework>net11.0</TargetFramework>` con `<LangVersion>14.0</LangVersion>` y, donde aplica, `Microsoft.EntityFrameworkCore 11.0.0`.

## Tres interfaces, tres modelos de ejecución

Las tres interfaces se parecen sobre el papel. Todas exponen una única secuencia de `T`. La diferencia es dónde se hace el trabajo y cuándo.

- `IEnumerable<T>` es una secuencia síncrona basada en pull. `MoveNext` se ejecuta en el hilo que llama. El productor es un método que entrega elementos, un `List<T>`, un `T[]` o una cadena LINQ to Objects. El productor no puede esperar nada con `await`.
- `IAsyncEnumerable<T>` es una secuencia asíncrona basada en pull. `MoveNextAsync` devuelve un `ValueTask<bool>`, lo que permite al productor esperar entre elementos. El consumidor itera con `await foreach`. Introducida en C# 8 / .NET Core 3.0; de primera clase en LINQ moderno vía el paquete `System.Linq.Async` y el `AsAsyncEnumerable` de EF Core.
- `IQueryable<T>` es un constructor de árbol de expresiones. Cada `Where`, `Select` u `OrderBy` que encadenas a un `IQueryable<T>` añade un nodo al árbol de expresiones. El árbol solo se traduce a algo ejecutable (una sentencia SQL, una URL OData, una consulta de Cosmos) cuando llamas a un operador terminal (`ToList`, `FirstOrDefault`, `Count`, `ToListAsync`). Hasta entonces, no ha ocurrido ninguna E/S.

La consecuencia más importante: un `IEnumerable<T>` devuelto por una llamada a EF Core ya ha salido de la base de datos. Un `IQueryable<T>` devuelto por la misma llamada no. Ese único hecho es responsable de más tickets de "por qué es lenta esta consulta" que cualquier otra causa única en código de EF Core.

## Matriz de características

| Capacidad                                       | `IEnumerable<T>`         | `IAsyncEnumerable<T>`        | `IQueryable<T>`                     |
| ----------------------------------------------- | ------------------------ | ---------------------------- | ----------------------------------- |
| Modelo de ejecución                             | pull síncrono            | pull asíncrono               | diferido, traducido por un proveedor|
| Dónde se ejecuta el trabajo                     | hilo que llama, en memoria| lado del productor, esperable| proveedor remoto (BD, OData, Cosmos)|
| Puede usar `await` entre elementos              | no                       | sí                           | n/a (sin trabajo por elemento)      |
| Operadores LINQ disponibles                     | LINQ to Objects          | LINQ to Objects (Async)      | subconjunto específico del proveedor|
| Componible después de retornar                  | sí (en memoria)          | sí (en memoria)              | sí (traducido remotamente)          |
| Transmite sin búfer                             | sí (`yield return` lazy) | sí                           | depende del proveedor               |
| Cancelación                                     | ninguna, el bucle es sync| `CancellationToken` por elemento | por consulta vía `ToListAsync(token)` |
| Riesgo al devolverlo desde un repositorio       | bajo                     | medio (vida del proveedor)   | alto (el llamador puede añadir SQL) |
| Mejor encaje                                    | colecciones en memoria   | streams remotos, server-sent | objetos de consulta internos al repo|
| Se materializa cuando                           | en cada `MoveNext`       | en cada `await MoveNextAsync`| en el operador terminal             |

La matriz es la publicación. Todo lo de abajo es el razonamiento.

## Cuándo `IEnumerable<T>` es el tipo de retorno correcto

`IEnumerable<T>` es el valor por defecto para "tengo elementos, dame una secuencia". Es síncrono, tiene todos los operadores LINQ to Objects y compone barato. Úsalo para:

- Un método que entrega desde una colección en memoria o una computación pura.
- Un método que ya ha materializado los datos y ahora devuelve una vista sobre ellos (`return list.Where(x => x.IsActive);`).
- Un método que recorre una fuente síncrona como un archivo que lees con `File.ReadLines` o un DOM deserializado.

La trampa es usar `IEnumerable<T>` como tipo de retorno de un método de repositorio que envuelve una llamada de E/S asíncrona. Eso obliga al repositorio a hacer `.ToList()` internamente y perder la propiedad de streaming, o fuerza al llamador a usar `.Result` y un bloqueo del thread pool. Ambas son incorrectas. Si la fuente es asíncrona, la firma debe ser `IAsyncEnumerable<T>` o `Task<List<T>>`, no `IEnumerable<T>`.

```csharp
// .NET 11, C# 14
public static IEnumerable<string> ReadLowercaseLines(string path)
{
    foreach (var line in File.ReadLines(path))
    {
        yield return line.ToLowerInvariant();
    }
}
```

`File.ReadLines` devuelve un `IEnumerable<string>` que lee el archivo de forma lazy. La transformación permanece lazy. Nada obliga a que el archivo se cargue por completo antes de que el primer elemento llegue al llamador.

La palabra clave `yield return` es lo que hace que esto funcione. Le indica al compilador que genere una máquina de estados que devuelva los elementos uno a uno, suspendiendo el método entre yields. Es el espejo síncrono de `await foreach` más `yield return` juntos.

## Cuándo `IAsyncEnumerable<T>` es el tipo de retorno correcto

`IAsyncEnumerable<T>` es lo que usas cuando el productor necesita esperar con `await` entre elementos. El ejemplo cardinal es un endpoint HTTP paginado: traes la página 1, entregas cada elemento, traes la página 2, entregas cada elemento. Quieres que el consumidor empiece a trabajar sobre la página 1 mientras la página 2 sigue en vuelo. También quieres un `CancellationToken` conectado para que el consumidor pueda detener al productor de forma limpia.

Úsalo para:

- Fuentes remotas paginadas (APIs HTTP que devuelven páginas, Server-Sent Events, consumidores de cola de mensajes).
- Consultas de EF Core 11 que transmiten resultados a un CSV o a otra respuesta HTTP sin materializar en memoria.
- Cualquier productor donde importe la contrapresión: el consumidor lee, procesa y solo entonces pide el siguiente elemento.

```csharp
// .NET 11, C# 14
public static async IAsyncEnumerable<Order> FetchAllAsync(
    HttpClient http,
    [EnumeratorCancellation] CancellationToken cancellationToken = default)
{
    string? next = "/api/orders?page=1";
    while (next is not null)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var page = await http.GetFromJsonAsync<PageOf<Order>>(next, cancellationToken)
                   ?? throw new InvalidOperationException("page was null");
        foreach (var order in page.Items)
        {
            yield return order;
        }
        next = page.NextLink;
    }
}
```

Dos detalles que pillan a la gente. Primero, `[EnumeratorCancellation]` es obligatorio para conectar el token desde `WithCancellation(...)` en el sitio de la llamada al iterador. Sin él, llamar a `await foreach (var x in source.WithCancellation(token))` descarta silenciosamente el token. Segundo, un método iterador asíncrono no puede usar `try/catch` alrededor de un `yield return` para una excepción que viene de un operador downstream; la excepción fluye por el consumidor, no por el productor. Envuelve las llamadas de E/S explícitamente cuando necesites lógica de reintentos.

Para EF Core 11, el equivalente en un `DbSet<T>` es `AsAsyncEnumerable`:

```csharp
// .NET 11, C# 14, EF Core 11.0.0
await foreach (var order in db.Orders
    .Where(o => o.Status == "shipped")
    .AsAsyncEnumerable()
    .WithCancellation(cancellationToken))
{
    await sink.WriteAsync(order, cancellationToken);
}
```

Eso mantiene abierto el lector de datos SQL y trae filas bajo demanda. El conjunto completo nunca se sienta en `List<Order>`. Para los detalles específicos de EF Core, ver [cómo usar IAsyncEnumerable con EF Core 11](/es/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/).

## Cuándo `IQueryable<T>` es el tipo de retorno correcto

`IQueryable<T>` es la forma correcta dentro de un repositorio o un helper de construcción de consultas, donde todavía se espera que el llamador componga. Es la forma incorrecta a través de una frontera de red o fuera de una capa que el siguiente llamador podría no entender.

Úsalo para:

- Una extensión `Queryable` que toma un `IQueryable<T>` existente y añade una cláusula `Where`: `q.WhereActive()`. El proveedor traduce el predicado; nunca corres sobre datos materializados.
- Un método de repositorio que expone una consulta estrecha y específica del proyecto que el llamador filtrará, paginará o contará más adelante: `IQueryable<Invoice> Unpaid(int customerId)`.
- Una API de biblioteca donde se espera que el consumidor construya expresiones, como un controlador OData o un DSL de búsqueda personalizado.

El patrón que muerde es exponer `IQueryable<T>` desde una capa de servicio que el llamador asume que devuelve datos en memoria:

```csharp
// Antipatrón: no devuelvas IQueryable<T> desde un servicio público
public IQueryable<Order> GetRecentOrders() => _db.Orders.Where(o => o.At > _start);

// Llamador, a kilómetros de distancia
var bad = service.GetRecentOrders()
                 .Where(o => SomeLocalMethod(o))   // EF Core lanza: no traducible
                 .OrderBy(o => o.Total)
                 .Take(50)
                 .ToList();
```

`SomeLocalMethod` es un método de C# que EF Core no puede traducir. La llamada a `Where` añade una expresión que el proveedor no puede bajar a SQL, y en la materialización obtienes una excepción. O peor, en un proveedor que cae silenciosamente a evaluación en cliente, accidentalmente jalas todas las filas por el cable para filtrar en proceso. EF Core 11 lanza por defecto; código más antiguo con cambios `AsEnumerable` insertados en medio de una cadena es aún más difícil de leer.

La solución es materializar en la frontera:

```csharp
// .NET 11, C# 14
public async Task<IReadOnlyList<Order>> GetRecentOrdersAsync(
    int count, CancellationToken ct)
{
    return await _db.Orders
        .Where(o => o.At > _start)
        .OrderByDescending(o => o.At)
        .Take(count)
        .ToListAsync(ct);
}
```

El método ahora devuelve una colección concreta y materializada. El llamador no puede añadir SQL accidentalmente. Si el llamador quiere un filtro diferente, lo pide explícitamente vía un parámetro o un método nuevo. Esta es la misma razón que impulsa [cómo detectar consultas N+1 en EF Core 11](/es/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/): sé explícito sobre dónde está la frontera de la consulta.

## El benchmark: transmitir un millón de filas de tres formas

Un número real. La configuración: 1,000,000 de filas estrechas (un `Guid Id`, un `int Status`, un `DateTime At`) en SQL Server 2022. El consumidor cuenta filas que pasan un filtro (`Status == 1`) y escribe una suma de timestamps. Lo hacemos de tres formas:

- `IEnumerable<T>` producido por `ToList()` y luego enumerado.
- `IAsyncEnumerable<T>` producido por `AsAsyncEnumerable()`.
- `IQueryable<T>` consumido dentro del mismo método vía `await Where(...).CountAsync()`.

```csharp
// .NET 11, C# 14, EF Core 11.0.0, BenchmarkDotNet 0.14.0
[MemoryDiagnoser]
public class SequenceShapes
{
    private AppDb _db = null!;

    [GlobalSetup] public void Setup() => _db = AppDb.Connect();

    [Benchmark]
    public long Materialize_Then_Enumerate()
    {
        var rows = _db.Events.ToList();              // pull all 1,000,000
        long sum = 0; long count = 0;
        foreach (var r in rows)
            if (r.Status == 1) { sum += r.At.Ticks; count++; }
        return sum + count;
    }

    [Benchmark]
    public async Task<long> StreamAsync()
    {
        long sum = 0; long count = 0;
        await foreach (var r in _db.Events.AsAsyncEnumerable())
            if (r.Status == 1) { sum += r.At.Ticks; count++; }
        return sum + count;
    }

    [Benchmark(Baseline = true)]
    public async Task<long> Queryable_Aggregate()
    {
        var count = await _db.Events.Where(e => e.Status == 1).CountAsync();
        var sum   = await _db.Events.Where(e => e.Status == 1)
                                    .SumAsync(e => (long)e.At.Ticks);
        return sum + count;
    }
}
```

Metodología: BenchmarkDotNet 0.14.0, .NET 11.0.0 RTM, EF Core 11.0.0, SQL Server 2022 16.0.4135 en la misma máquina sobre loopback. Windows 11 24H2, AMD Ryzen 9 7900X, 64 GB DDR5. Los números son una ejecución representativa.

| Método                          | Media        | Asignado    |
| ------------------------------- | ------------ | ----------- |
| Queryable_Aggregate (baseline)  | 38 ms        | 1.4 KB      |
| StreamAsync                     | 1,210 ms     | 410 MB      |
| Materialize_Then_Enumerate      | 1,380 ms     | 432 MB      |

El patrón es consistente con cómo funcionan las tres interfaces. `IQueryable<T>` deja que la base de datos haga el conteo y la suma y envíe dos escalares de vuelta. `IAsyncEnumerable<T>` te ahorra alrededor del 12 por ciento del tiempo total frente a `ToList` y bucle, y te ahorra el perfil de memoria en forma de pico (la asignación de `List<Event>` en `Materialize_Then_Enumerate` es visible en `dotnet-counters` como un único pico `gen2`). Pero ambas pierden frente a la forma queryable por 30x porque el trabajo pertenecía a la base de datos, no al cliente.

La conclusión no es "usa siempre IQueryable". Es: si la operación se puede expresar en el lenguaje de consulta del proveedor, no saques las filas. Si tienes que sacar las filas (exportación CSV, una transformación que no se traduce, un servicio downstream que quiere elementos individuales), prefiere `IAsyncEnumerable<T>` sobre un `IEnumerable<T>` materializado.

## Las trampas que deciden por ti

Algunas cosas toman la decisión por ti más allá de la preferencia.

- **`IQueryable<T>` requiere un proveedor vivo.** Devolver `IQueryable<T>` desde un método cuyo `DbContext` está liberado cuando el método retorna es un use-after-free disfrazado. El árbol de expresiones sigue existiendo, pero en el momento en que el llamador lo materialice, vuela un `ObjectDisposedException`. O mantén vivo el contexto durante la vida del queryable, o materializa antes de devolver.

- **`IAsyncEnumerable<T>` requiere `[EnumeratorCancellation]`.** Sin él, el token de cancelación que un llamador pasa vía `.WithCancellation(token)` nunca llega al productor. El compilador no te avisará; el bug es silencioso y el token se ignora. El analizador de Roslyn `CA1068` detecta el parámetro faltante; `CA2016` detecta la falta de propagación del token a las llamadas asíncronas internas.

- **Los operadores LINQ difieren.** `Skip`, `Take`, `OrderBy`, `Select`, `Where`, `First`, `Count` existen en las tres. Pero `IAsyncEnumerable<T>` necesita el paquete `System.Linq.Async` para `WhereAsync`, `SelectAwait`, `SelectMany`, `GroupBy` y compañía. `IQueryable<T>` solo soporta el subconjunto que su proveedor pueda traducir; todo lo demás o lanza (EF Core 11) o cae silenciosamente a evaluación en cliente (algunos proveedores antiguos).

- **`IQueryable<T>` filtra el modelo de persistencia.** Si el llamador puede escribir `.Where(...)`, el llamador está escribiendo SQL. Refactorizar el nombre de una columna en la entidad se vuelve un cambio de buscar-en-todo-el-código porque todo consumidor queryable está tocando esa columna. Un repositorio que devuelve DTOs materializados oculta el esquema; uno que devuelve `IQueryable<Entity>` no.

- **Mezclarlos dentro de una cadena.** Llamar a `.AsEnumerable()` o `.AsAsyncEnumerable()` en medio de una cadena `IQueryable<T>` convierte el resto a evaluación en memoria. Cada `Where` después de ese punto corre en el cliente. A veces es lo que quieres (un predicado complejo que no se traduce); a menudo es un bug de rendimiento. Haz el cambio explícito y pon un comentario al lado.

- **`yield return` dentro de `using` está bien, pero el recurso vive tanto como el iterador.** Un iterador síncrono que abre un `FileStream` y entrega líneas mantiene el archivo abierto hasta que el consumidor libere el enumerador o termine de iterar. Lo mismo aplica, con peores modos de fallo, a iteradores asíncronos que sostienen un `DbDataReader`. Itera siempre hasta el final o llama a `await foreach` dentro de un bloque using/awaiting.

## La recomendación opinionada, reformulada

Por defecto, usa `IEnumerable<T>` para trabajo en memoria. Recurre a `IAsyncEnumerable<T>` en el momento en que el productor necesita usar `await`, y conecta `[EnumeratorCancellation]` desde el primer día. Mantén `IQueryable<T>` dentro de la capa de repositorio o constructor de consultas; conviértelo a un `IReadOnlyList<T>` materializado o a `IAsyncEnumerable<T>` antes de cruzar una frontera de servicio.

Dos corolarios que vale la pena memorizar:

- "Devuelve el menor poder que el llamador necesite". Un método que conceptualmente devuelve una lista debe devolver `IReadOnlyList<T>`, no `IQueryable<T>`. Poder que el llamador no necesita es poder que el llamador puede usar mal.
- "La materialización es una frontera". Decide dónde ocurre una vez, en un solo sitio, y escribe el resto de la capa a ese contrato. Las bases de código donde cada método devuelve `IQueryable<T>` "por si acaso" terminan con llamadas `.ToList()` salpicadas al azar y un presupuesto de consultas lentas que nadie posee.

## Relacionados

- [Cómo usar IAsyncEnumerable con EF Core 11](/es/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/)
- [EF Core 11 vs Dapper para inserciones masivas: un benchmark real](/es/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/)
- [Cómo detectar consultas N+1 en EF Core 11](/es/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [Cómo usar consultas compiladas con EF Core para rutas calientes](/es/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [Cómo transmitir un archivo desde un endpoint de ASP.NET Core sin búfer](/es/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/)

## Fuentes

- [IQueryable Interface -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.linq.iqueryable-1)
- [IAsyncEnumerable Interface -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.collections.generic.iasyncenumerable-1)
- [Generate asynchronous streams (async iterators) -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/asynchronous-programming/generate-consume-asynchronous-stream)
- [EnumeratorCancellationAttribute -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.enumeratorcancellationattribute)
- [Client vs server evaluation -- EF Core docs](https://learn.microsoft.com/en-us/ef/core/querying/client-eval)
- [System.Linq.Async on NuGet](https://www.nuget.org/packages/System.Linq.Async)
