---
title: "Solución: System.InvalidOperationException: Sequence contains no elements"
description: "Esta excepción significa que llamaste a .First() o .Single() sobre una secuencia vacía. Usa FirstOrDefault/SingleOrDefault y comprueba el null, protege la consulta o corrige por qué la fuente está vacía."
pubDate: 2026-07-21
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "linq"
  - "ef-core"
lang: "es"
translationOf: "2026/07/fix-invalidoperationexception-sequence-contains-no-elements"
translatedBy: "claude"
translationDate: 2026-07-21
---

`System.InvalidOperationException: Sequence contains no elements` significa que llamaste a `.First()`, `.Single()`, `.Last()` o a alguno de sus primos de agregación (`.Average()`, `.Max()`, `.Min()`) sobre una secuencia que resultó estar vacía. El operador prometió devolver un elemento y no había ninguno, así que lanzó la excepción. La solución es decidir qué debe significar "vacío" para esa llamada: si estar vacío es un resultado normal, cambia a `.FirstOrDefault()` / `.SingleOrDefault()` y maneja el `null` (o el valor por defecto) que recibes de vuelta; si estar vacío es un error, corrige la consulta o los datos para que la secuencia nunca esté vacía en ese punto. Esto se verificó con .NET 11, C# 14 y EF Core 11.0.0, pero el mensaje y el comportamiento han sido estables desde que LINQ llegó en .NET Framework 3.5, así que la guía aplica a cualquier versión.

## El error en contexto

La excepción completa, lanzada desde dentro de `System.Linq`, se ve así:

```
System.InvalidOperationException: Sequence contains no elements
   at System.Linq.ThrowHelper.ThrowNoElementsException()
   at System.Linq.Enumerable.First[TSource](IEnumerable`1 source)
   at MyApp.OrderService.GetLatest() in /src/OrderService.cs:line 42
```

La pista está en el frame superior: `System.Linq.ThrowHelper.ThrowNoElementsException`. Si lo ves en la traza de pila, un operador de LINQ que devuelve elementos se ejecutó sobre una fuente vacía. La redacción exacta importa para la búsqueda, porque LINQ lanza cuatro mensajes estrechamente relacionados desde la misma clase y significan cosas distintas:

- `Sequence contains no elements` -- `.First()`, `.Single()`, `.Last()` (sin predicado) sobre una fuente vacía.
- `Sequence contains no matching element` -- `.First(predicate)`, `.Single(predicate)`, `.Last(predicate)` cuando nada coincidió.
- `Sequence contains more than one element` -- `.Single()` sobre una fuente con dos o más elementos.
- `Sequence contains more than one matching element` -- `.Single(predicate)` cuando más de un elemento coincidió.

Este artículo trata del primero. Los demás se cubren en la sección de variantes, porque caer en el equivocado te hace perder tiempo.

## Por qué ocurre

`.First()` y `.Single()` son operadores con contrato: su tipo de retorno es un `TSource` no anulable, así que no tienen forma de señalar "no hay nada aquí" salvo lanzando una excepción. Cuando la fuente está vacía, no hay ningún elemento que devolver, y retornar `default(TSource)` sería una mentira para un tipo de referencia (recibirías `null` donde la firma prometía un valor). Por eso el runtime lanza `InvalidOperationException` en su lugar. Es una decisión de diseño deliberada, no un error: las variantes `*OrDefault` existen precisamente para el caso en que estar vacío es aceptable.

La parte confusa es que la secuencia suele estar vacía por razones invisibles en el sitio de la llamada. Un filtro `Where` anterior eliminó todas las filas. Una tabla de base de datos aún no tiene ningún registro coincidente. Una colección fue vaciada, o nunca se pobló porque un `await` anterior falló en silencio. La excepción se dispara en la línea del `.First()`, pero la causa real está tres líneas (o tres llamadas de método) antes. Por eso "simplemente envuélvelo en try/catch" rara vez es el instinto correcto: quieres saber por qué la secuencia está vacía, no solo tragarte el síntoma.

## Reproducción mínima

El código más pequeño que la lanza:

```csharp
// .NET 11, C# 14
var numbers = new List<int>();     // empty
int first = numbers.First();       // System.InvalidOperationException: Sequence contains no elements
```

Lo mismo ocurre cuando un filtro elimina todo, que es la forma real mucho más común:

```csharp
// .NET 11, C# 14
var orders = new List<Order>
{
    new(Id: 1, Status: "shipped"),
    new(Id: 2, Status: "shipped"),
};

// No pending orders exist, so the filtered sequence is empty.
Order next = orders.First(o => o.Status == "pending");
// System.InvalidOperationException: Sequence contains no matching element
```

Fíjate en que el segundo mensaje es la variante `no matching element`, porque se pasó un predicado. Ambos vienen de la misma familia de errores: asumiste que al menos un elemento estaría ahí, y no lo estaba.

## La solución, en detalle

Recorre estas opciones en orden. Las dos primeras cubren casi todos los casos reales.

### 1. Usa FirstOrDefault / SingleOrDefault y maneja el caso vacío

Si una secuencia vacía es un resultado legítimo (aún no hay filas, una búsqueda opcional, una consulta que puede no encontrar nada), cambia a la sobrecarga `*OrDefault` y comprueba lo que recibes:

```csharp
// .NET 11, C# 14
Order? next = orders.FirstOrDefault(o => o.Status == "pending");
if (next is null)
{
    // No pending order. Handle it: return early, use a fallback, log, whatever fits.
    return;
}
Process(next);
```

`FirstOrDefault` devuelve `default(TSource)` cuando la secuencia está vacía: `null` para un tipo de referencia, `0` para `int`, `default` para un struct. En una base de código con anotaciones anulables (`<Nullable>enable</Nullable>`, lo predeterminado en las nuevas plantillas de .NET 11), el compilador tipa el resultado como `Order?` y te insistirá hasta que compruebes el null, que es exactamente la seguridad que quieres. No omitas la comprobación: reemplazar `First` por `FirstOrDefault` y luego desreferenciar el resultado de inmediato solo cambia `InvalidOperationException` por un `NullReferenceException` una línea después. Si las advertencias de anulabilidad te parecen ruido, es el compilador señalando el trabajo real, y conecta directamente con [CS8618 y las propiedades no anulables](/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/).

Desde .NET 6 también existe una sobrecarga que te permite proporcionar tu propio valor por defecto, que es más limpia que una comprobación de null aparte cuando tienes un valor alternativo sensato:

```csharp
// .NET 11, C# 14 -- FirstOrDefault(predicate, defaultValue) added in .NET 6
Order next = orders.FirstOrDefault(o => o.Status == "pending", Order.None);
```

### 2. Protege la secuencia antes de llamar a First

Cuando realmente necesitas el primer elemento pero solo si existe, comprueba primero si está vacía. Para una colección en memoria, `Count` o `Any()` basta:

```csharp
// .NET 11, C# 14
if (orders.Count > 0)
{
    Order first = orders.First();   // safe: we know it is non-empty
    Process(first);
}
```

Prefiere `Count` (o `Count > 0`) para cualquier cosa que implemente `ICollection<T>`, como `List<T>` o un arreglo, porque es O(1). Usa `.Any()` para un `IEnumerable<T>` de evaluación diferida donde no puedes obtener un conteo de forma barata. No escribas `if (orders.Count() > 0)` sobre una secuencia diferida: `Count()` la enumera entera, mientras que `Any()` se detiene después del primer elemento.

### 3. Corrige por qué la secuencia está vacía

A veces estar vacío es el error, no un estado válido. Si `orders.First(o => o.Status == "pending")` siempre debería encontrar una fila y no lo hace, la solución real está aguas arriba: un filtro demasiado estricto, una discrepancia de mayúsculas y minúsculas (`"Pending"` vs `"pending"`), una unión que descartó filas, o datos que nunca se insertaron. Recurre aquí a un `*OrDefault` solo después de haber confirmado que se permite que la secuencia esté vacía. Ocultar un caso de "esto nunca debería estar vacío" con `FirstOrDefault` esconde un error genuino de datos o de lógica y mueve el fallo a un lugar más difícil de diagnosticar.

### 4. Para las agregaciones, usa una sobrecarga anulable o DefaultIfEmpty

`.Average()`, `.Max()`, `.Min()` y `.Sum()` comparten la misma trampa. `.Average()` y las versiones de tipo de valor de `.Max()`/`.Min()` lanzan `Sequence contains no elements` sobre una fuente vacía (`.Sum()` devuelve 0, que es su propia sorpresa). Dos soluciones limpias:

```csharp
// .NET 11, C# 14
var prices = new List<int>();

// Option A: project to a nullable so the aggregate returns null instead of throwing.
double? avg = prices.Average(p => (int?)p);   // null when empty, no exception

// Option B: supply a fallback element before aggregating.
int max = prices.DefaultIfEmpty(0).Max();     // 0 when empty
```

`DefaultIfEmpty` es la escotilla de escape de propósito general: produce un único elemento por defecto cuando la fuente está vacía, de modo que cualquier operador posterior, incluido `.First()`, ve al menos un elemento.

## Trampas y variantes

Algunas situaciones producen esta excepción, o una pariente cercana, por razones que el mensaje no deletrea:

- **`no matching element` es un mensaje distinto con la misma causa.** `.First()` sobre una fuente vacía dice `Sequence contains no elements`; `.First(predicate)` que no coincide con nada dice `Sequence contains no matching element`. Los lanzan ayudantes distintos, pero la solución es idéntica: `FirstOrDefault(predicate)` y una comprobación de null. Si tu fuente tiene filas pero el predicado nunca coincide, la secuencia entregada a `First` está efectivamente vacía.

- **`.Single()` lanza dos mensajes distintos.** `.Single()` garantiza *exactamente un* elemento, así que puede fallar de dos formas: `Sequence contains no elements` cuando hay cero, y `Sequence contains more than one element` cuando hay dos o más. Si ves la variante "more than one", `FirstOrDefault` no es la solución; o tu suposición de unicidad está mal (una cláusula `WHERE` faltante, una clave duplicada) o deberías usar `First` porque solo quieres uno de varios. Usa `Single` solo cuando una segunda coincidencia sea en sí misma un error que merezca lanzar una excepción.

- **EF Core lanza lo mismo desde `First`/`Single`, y también sus versiones asíncronas.** `dbContext.Orders.First(o => o.Id == id)` se traduce a `SELECT TOP(1)` y lanza `Sequence contains no elements` cuando ninguna fila coincide. `FirstAsync` y `SingleAsync` lanzan de forma idéntica. La solución es `FirstOrDefaultAsync` / `SingleOrDefaultAsync` más una comprobación de null. Como estas se ejecutan contra la base de datos, un resultado vacío suele ser normal (la fila fue eliminada, el id es incorrecto), así que las sobrecargas asíncronas `*OrDefault` suelen ser lo que quieres. Consulta [IEnumerable vs IAsyncEnumerable vs IQueryable](/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/) para ver por qué el operador de LINQ se comporta igual tanto si se ejecuta en memoria como en forma de SQL.

- **`FirstOrDefault` sobre una secuencia de tipo de valor devuelve 0, no null.** Para `List<int>`, `FirstOrDefault()` sobre una lista vacía devuelve `0`, que es un `int` válido e indistinguible de un primer elemento real igual a `0`. Si necesitas distinguir "vacío" de "el primer valor resulta ser el predeterminado", proyecta a un anulable (`.Select(x => (int?)x).FirstOrDefault()`) o protege con `.Any()` en lugar de confiar en el valor centinela predeterminado.

- **La secuencia vacía puede venir de una consulta mal traducida, no de datos faltantes.** En EF Core, una consulta que evalúa parte de un filtro en el cliente de forma silenciosa, o una que no se pudo traducir en absoluto, puede devolver un conjunto de resultados distinto (a menudo vacío) del que esperabas. Si un `First` contra la base de datos lanza la excepción y estás seguro de que la fila existe, comprueba si la consulta se tradujo como pretendías. Ese modo de fallo se cubre en [la expresión de LINQ no se pudo traducir](/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/).

- **Envolver en try/catch oculta la verdadera pregunta.** Capturar `InvalidOperationException` alrededor de una llamada a `First` técnicamente detiene el crash, pero también captura otras `InvalidOperationException` no relacionadas (un error de colección-modificada-durante-la-enumeración, por ejemplo) y no te dice nada sobre por qué la secuencia estaba vacía. Prefiere `*OrDefault` más una rama explícita: es más rápido (sin maquinaria de excepciones), más acotado y auto-documentado.

El modelo mental que hay que retener: `.First()` y `.Single()` son afirmaciones de que un elemento existe. `Sequence contains no elements` es esa afirmación fallando. Decide si el caso vacío es legal. Si lo es, exprésalo con `FirstOrDefault`/`SingleOrDefault` y maneja el valor por defecto que recibes. Si no lo es, corrige la consulta o los datos aguas arriba para que la secuencia nunca esté vacía en ese punto, en lugar de disimularlo en el sitio de la llamada.

## Relacionados

- [Solución: la expresión de LINQ no se pudo traducir en EF Core 11](/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) para cuando el resultado vacío viene de una consulta que no se ejecutó como esperabas.
- [IEnumerable vs IAsyncEnumerable vs IQueryable en C#](/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/) para entender por qué `First` se comporta igual en memoria y contra una base de datos, y cuándo se ejecuta realmente la consulta.
- [Solución: CS8618 la propiedad no anulable debe contener un valor no nulo](/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/) para manejar el resultado anulable que devuelve `FirstOrDefault`.
- [LINQ FullJoin y uniones que devuelven tuplas en .NET 11](/2026/06/linq-fulljoin-tuple-returning-joins-dotnet-11-preview-5/) para dar forma a resultados de uniones sin descartar filas que dejarían una secuencia vacía.

## Fuentes

- Microsoft Learn, [Enumerable.First Method](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.first) (lanza `InvalidOperationException` cuando la secuencia fuente está vacía o ningún elemento coincide con el predicado; usa `FirstOrDefault` para devolver un valor por defecto en su lugar).
- Microsoft Learn, [Enumerable.Single Method](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.single) (lanza cuando la secuencia está vacía, contiene más de un elemento o ningún elemento coincide).
- Microsoft Learn, [Enumerable.FirstOrDefault Method](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.firstordefault) (devuelve `default(TSource)` para una secuencia vacía, además de la sobrecarga de .NET 6 que acepta un valor por defecto explícito).
- Microsoft Learn, [Enumerable.DefaultIfEmpty Method](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.defaultifempty) (produce un único elemento por defecto cuando la fuente está vacía).
