---
title: "LINQ incorpora FullJoin y joins sin selector en .NET 11 Preview 5"
description: ".NET 11 Preview 5 agrega un operador FullJoin completamente nuevo a LINQ, además de sobrecargas que devuelven tuplas para Join, LeftJoin, RightJoin y GroupJoin que eliminan por completo el selector de resultado."
pubDate: 2026-06-12
tags:
  - "dotnet-11"
  - "csharp"
  - "linq"
  - "performance"
lang: "es"
translationOf: "2026/06/linq-fulljoin-tuple-returning-joins-dotnet-11-preview-5"
translatedBy: "claude"
translationDate: 2026-06-12
---

Las [notas de las bibliotecas de .NET 11 Preview 5](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/libraries.md) completan una historia que empezó en .NET 10. Esa versión le dio a LINQ `LeftJoin` y `RightJoin`, así que ya no había que falsear un outer join con `GroupJoin` más `SelectMany` más `DefaultIfEmpty`. Preview 5 agrega la cuarta esquina que faltaba, `FullJoin`, y de paso corrige la parte más molesta de cada join: el selector de resultado.

## El selector de resultado siempre fue código de relleno

Cada sobrecarga de join anterior tomaba cuatro argumentos: la secuencia interna, la clave externa, la clave interna y un selector de resultado que le indicaba a LINQ cómo combinar un par coincidente. Nueve de cada diez veces ese selector solo unía los dos elementos en un tipo anónimo o una tupla:

```csharp
var pairs = catalog.Join(
    sales,
    p => p.Sku,
    s => s.Sku,
    (product, sale) => (product, sale));

foreach (var (product, sale) in pairs)
    Console.WriteLine($"{product.Name}: sold {sale.Quantity}");
```

Esa última lambda no aporta ninguna lógica. Existe solo para satisfacer la firma. Preview 5 agrega sobrecargas que devuelven tuplas para `Join`, `LeftJoin`, `RightJoin` y `GroupJoin` que infieren la forma obvia y te dejan eliminarla:

```csharp
foreach (var (product, sale) in catalog.Join(sales, p => p.Sku, s => s.Sku))
    Console.WriteLine($"{product.Name}: sold {sale.Quantity}");
```

`Join` ahora devuelve `IEnumerable<(TOuter, TInner)>`. `GroupJoin` devuelve `IEnumerable<(TOuter, IEnumerable<TInner>)>`. Las variantes izquierda y derecha devuelven el lado externo o interno como anulable, exactamente como lo haría SQL. Las sobrecargas existen en `Enumerable`, `Queryable` y `AsyncEnumerable`, así que la misma forma de llamada funciona sobre colecciones en memoria, árboles de consulta de EF Core y flujos asíncronos.

## FullJoin completa el conjunto

El operador genuinamente nuevo es `FullJoin` ([dotnet/runtime #127236](https://github.com/dotnet/runtime/pull/127236)). Un full outer join devuelve cada elemento de ambas secuencias, emparejando los que tienen claves coincidentes y dejando a los no coincidentes con una pareja `null`. Reconciliar dos listas, por ejemplo un catálogo de productos contra un feed de ventas, antes implicaba dos pasadas o una búsqueda en un diccionario construido a mano. Ahora es una sola llamada:

```csharp
foreach (var (product, sale) in catalog.FullJoin(sales, p => p.Sku, s => s.Sku))
{
    if (product is null)
        Console.WriteLine($"Sale for unknown SKU {sale!.Sku}");
    else if (sale is null)
        Console.WriteLine($"No sales for {product.Name}");
    else
        Console.WriteLine($"{product.Name}: sold {sale.Quantity}");
}
```

Aquí ambos lados de la tupla son anulables porque cualquiera puede faltar, y las anotaciones de tipos anulables de C# hacen que el compilador te empuje a manejar ambos huecos.

## Lo que conviene saber antes de apoyarte en esto

Estas son adiciones solo a la sintaxis de métodos de LINQ. No hay una palabra clave `full join` de consulta, y las formas existentes de comprensión de consultas quedan intactas. Para los proveedores de EF Core, que `FullJoin` se traduzca a un `FULL OUTER JOIN` o recurra a evaluación en el cliente depende de que el proveedor se ponga al día, así que revisa tu SQL generado antes de asumir que se ejecuta en la base de datos. Como con el resto de Preview 5, incluido el nuevo [soporte de System.Text.Json para JSON Lines](/es/2026/06/system-text-json-json-lines-serialization-dotnet-11-preview-5/), las firmas todavía pueden cambiar antes de la versión estable de noviembre. Pero la forma es lo bastante limpia como para que empieces a borrar lambdas de selector de resultado hoy mismo.
