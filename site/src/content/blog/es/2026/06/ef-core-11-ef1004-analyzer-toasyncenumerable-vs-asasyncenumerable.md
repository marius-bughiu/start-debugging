---
title: "El nuevo analizador EF1004 de EF Core 11 detecta un error asíncrono silencioso"
description: "EF Core 11 Preview 5 incluye el analizador EF1004. Marca ToAsyncEnumerable() sobre un IQueryable para que no enumeres una consulta de base de datos de forma síncrona dentro de un await foreach."
pubDate: 2026-06-14
tags:
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "ef-core-11"
  - "csharp"
lang: "es"
translationOf: "2026/06/ef-core-11-ef1004-analyzer-toasyncenumerable-vs-asasyncenumerable"
translatedBy: "claude"
translationDate: 2026-06-14
---

.NET 11 Preview 5, publicado el 2026-06-09, añade un nuevo analizador de EF Core con el identificador de diagnóstico `EF1004`. Detecta un error que se ha vuelto mucho más fácil de cometer desde que `System.Linq.AsyncEnumerable` pasó a formar parte de la BCL en .NET 10: llamar a `ToAsyncEnumerable()` sobre una consulta de EF Core y ejecutarla de forma síncrona sin darte cuenta.

## Cómo se coló la llamada incorrecta

Ahora que `System.Linq.AsyncEnumerable` se incluye en el runtime, sus métodos de extensión están disponibles casi en todas partes. Uno de ellos es `ToAsyncEnumerable()`, que adapta cualquier `IEnumerable<T>` a un `IAsyncEnumerable<T>`. Un `IQueryable<T>` de EF Core también es un `IEnumerable<T>`, por lo que la llamada compila sin problemas y parece correcta junto a un `await foreach`:

```csharp
// Looks async. Is not.
await foreach (var blog in db.Blogs.ToAsyncEnumerable())
{
    Console.WriteLine(blog.Name);
}
```

El problema es que `ToAsyncEnumerable()` envuelve una enumeración síncrona. Recorre el `IQueryable` usando el enumerador bloqueante, por lo que el viaje de ida y vuelta a la base de datos se ejecuta en el hilo que hace la llamada. El `await foreach` te da la sintaxis del streaming sin nada del comportamiento asíncrono. Bajo carga, esta es justamente la forma que agota el pool de hilos y produce interbloqueos que solo aparecen en producción.

## Qué espera EF1004 en su lugar

EF Core expone su propio método `AsAsyncEnumerable()`. Ese sí enruta la consulta a través del pipeline asíncrono de EF Core, de modo que cada fila se materializa a medida que sale del `DbDataReader` sin bloquear un hilo:

```csharp
// Runs through EF Core's async query pipeline.
await foreach (var blog in db.Blogs.AsAsyncEnumerable())
{
    Console.WriteLine(blog.Name);
}
```

Los dos nombres de método se diferencian por tres caracteres, ambos devuelven `IAsyncEnumerable<T>` y ambos compilan. Antes de Preview 5 nada te indicaba cuál habías elegido. `EF1004` se dispara en tiempo de compilación en cuanto llamas a `ToAsyncEnumerable()` sobre un `IQueryable<T>`, apuntándote a `AsAsyncEnumerable()`.

## Convertirlo en un error

El analizador se incluye en el paquete de analizadores de EF Core y se ejecuta durante una compilación normal, así que obtienes la advertencia sin configuración adicional en un proyecto que referencia `Microsoft.EntityFrameworkCore` 11.0.0. Si quieres garantizar que nadie publique la versión síncrona, promuévela en tu archivo de proyecto:

```xml
<PropertyGroup>
  <WarningsAsErrors>$(WarningsAsErrors);EF1004</WarningsAsErrors>
</PropertyGroup>
```

Esto encaja de forma natural con los patrones de streaming que se cubren en [Cómo usar IAsyncEnumerable&lt;T&gt; con EF Core 11](/es/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/): `AsAsyncEnumerable()` es la llamada que hace que `await foreach` realmente transmita. EF1004 es simplemente la barrera que impide que el método parecido se cuele en la revisión de código.

Fuente: las [notas de la versión de EF Core para .NET 11 Preview 5](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/efcore.md) y el [anuncio de .NET 11 Preview 5](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/).
