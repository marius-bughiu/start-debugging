---
title: "record vs class vs struct en C#: una matriz de decisión"
description: "C# 14 te da cuatro formas de tipo de datos -- class, record class, struct y record struct. Esta es la matriz de decisión: cuándo cada uno es correcto, qué cuesta cada uno, y las reglas que deciden por ti."
pubDate: 2026-05-20
template: vs
tags:
  - "comparison"
  - "csharp"
  - "records"
  - "structs"
  - "dotnet-10"
lang: "es"
translationOf: "2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix"
translatedBy: "claude"
translationDate: 2026-05-20
---

Si estás eligiendo entre `class`, `record` y `struct` para un nuevo tipo en C# 14 / .NET 10, el valor por defecto es `class`. Recurre a `record class` (el `record` estándar) cuando el tipo es datos inmutables y la igualdad por valor es el contrato. Recurre a `readonly record struct` cuando el tipo es pequeño (16 bytes o menos), inmutable, y se copia a través de rutas calientes donde una asignación en el heap por instancia dolería. Usa un `struct` simple solo para interoperabilidad no administrada o cuando genuinamente necesitas mutar un tipo de valor de tamaño fijo en el sitio. Usa un `record` simple (que es `record class`) cuando quieres inmutabilidad e igualdad por valor sin pelear con el GC.

Esta publicación es la versión larga. Todos los ejemplos apuntan a `<TargetFramework>net10.0</TargetFramework>` con `<LangVersion>14.0</LangVersion>`.

## Las cuatro formas que realmente tienes

C# tiene dos tipos de almacenamiento (tipo de referencia, tipo de valor) y un modificador `record` ortogonal que añade igualdad por valor, un constructor primario, soporte para expresiones `with` y un `ToString` generado por el compilador. Eso da cuatro formas:

- `class`: tipo de referencia, igualdad por referencia por defecto.
- `record class` (la palabra clave simple `record`): tipo de referencia, igualdad por valor.
- `struct`: tipo de valor, igualdad por valor campo a campo (vía `ValueType.Equals` con reflexión) -- lento a menos que lo sobrescribas.
- `record struct`: tipo de valor, igualdad por valor (generada por el compilador, sin reflexión).

`readonly record struct` es la forma de struct más común que realmente escribirás. Marca cada campo como `readonly` y hace que toda la instancia sea inmutable, que es lo que quieres el 90 por ciento de las veces que recurres a un struct.

## Matriz de características

| Característica                              | `class`             | `record class`         | `struct`             | `record struct`           |
| ------------------------------------------ | ------------------- | ---------------------- | -------------------- | ------------------------- |
| Almacenamiento                              | heap                | heap                   | inline / pila        | inline / pila             |
| Igualdad por defecto                        | referencia          | valor (gen. por compilador) | valor (reflexión) | valor (gen. por compilador) |
| Expresión `with`                            | no                  | sí                     | no                   | sí                        |
| `ToString` generado por el compilador       | no                  | sí                     | no                   | sí                        |
| Herencia                                    | sí                  | sí (solo entre records)| no                   | no                        |
| Mutabilidad por defecto                     | mutable             | init-only (inmutable)  | mutable              | mutable; `readonly record struct` es inmutable |
| Hace boxing al convertir a `object` / interfaz | no               | no                     | sí                   | sí                        |
| Costo de copia                              | copia de puntero    | copia de puntero       | copia bit a bit completa | copia bit a bit completa |
| `null` permitido (NRT desactivado)          | sí                  | sí                     | no (usa `T?`)        | no (usa `T?`)             |
| Asigna en el heap                           | cada instancia      | cada instancia         | solo cuando hay boxing | solo cuando hay boxing  |
| Buena como clave de diccionario             | solo si implementas `Equals`/`GetHashCode` | sí, de serie | no -- la igualdad por reflexión es lenta | sí, de serie |
| Buena como entidad de EF Core               | sí                  | sí (con cuidado)       | no                   | no                        |

La tabla es la publicación. Todo lo siguiente es el porqué.

## Por qué `class` es el valor por defecto

Una `class` se asigna en el heap administrado, se accede por referencia, y es igual a otra instancia solo cuando ambas referencias apuntan al mismo objeto. La semántica de referencia es el ajuste natural para cosas que tienen una identidad: un `User`, un `Customer`, un `HttpClient`. Dos objetos `User` con el mismo nombre y correo no son el mismo usuario; son dos registros que casualmente comparten datos. La igualdad por referencia coincide con ese modelo mental.

`class` también es la única forma que admite herencia con tipos derivados arbitrarios. `record` también admite herencia, pero solo entre otros records. `struct` y `record struct` no admiten ninguna.

Elige `class` cuando:

- El tipo tiene identidad ("este es *el* cliente, no un valor con forma de cliente").
- El tipo es mutable por diseño.
- El tipo participa en una jerarquía de clases con clases base que no son records.
- El tipo es una entidad de EF Core que necesita seguimiento de cambios. EF Core 11 admite records como entidades, pero el camino de menor resistencia sigue siendo una `class` con propiedades init-only y un constructor de binding. Consulta [cómo usar records con EF Core 11 correctamente](/es/2026/04/how-to-use-records-with-ef-core-11-correctly/) para la decisión asiento por asiento.

```csharp
// .NET 10, C# 14
public class Customer
{
    public Guid Id { get; init; }
    public string Email { get; set; } = "";
    public DateTimeOffset CreatedAt { get; init; }
}
```

Este es el asiento que posee una fila en la base de datos y se le permite cambiar con el tiempo.

## Cuándo recurrir a `record class`

Un `record` (que es `record class` -- la palabra clave `class` está implícita) es la respuesta correcta para portadores de datos inmutables donde dos instancias con los mismos valores de campo deberían tratarse como iguales. El compilador genera un `Equals`, `GetHashCode`, `ToString` basados en valor, y un método virtual `EqualityContract` que hace que la herencia funcione. La sintaxis posicional `public record Address(string City, string Zip);` añade un constructor primario y una propiedad init-only por parámetro.

Elige `record class` cuando:

- El tipo es un DTO, una forma de solicitud/respuesta, un evento de dominio, o una instantánea de configuración.
- Usarás el tipo como clave de diccionario o en un `HashSet<T>` y la igualdad por valor es el contrato.
- Producirás con frecuencia una copia modificada: `var newer = original with { Status = "shipped" };`.
- Quieres que el compilador escriba `ToString` por ti para que los registros estructurados muestren cada campo por defecto.

Una record class se sigue asignando en el heap y se accede por referencia, así que toda la intuición de "esto es barato de pasar" sobre `class` sigue aplicando. Pagas una asignación por instancia, pero no pagas una copia bit a bit cada vez que la pasas a un método.

```csharp
// .NET 10, C# 14
public sealed record OrderPlaced(Guid OrderId, decimal Total, DateTimeOffset At);

var evt = new OrderPlaced(orderId, 42.50m, DateTimeOffset.UtcNow);
var corrected = evt with { Total = 42.95m };

// evt != corrected
// Console.WriteLine(evt) prints OrderPlaced { OrderId = ..., Total = 42.50, At = ... }
```

Dos advertencias. Primera, declara los records como `sealed` a menos que realmente necesites una jerarquía de records. El compilador emite una indirección `EqualityContract` en cada record para que los records derivados puedan participar en la igualdad por valor, y `sealed` permite al JIT desvirtualizar las llamadas. Segunda, no pongas propiedades de colección mutables en un record. La igualdad por valor de `record` compara referencias para esas propiedades, no contenidos, lo que lleva a sorpresas del estilo "por qué estos dos records no son iguales". Usa `ImmutableArray<T>` o `IReadOnlyList<T>` inicializado una vez.

## Cuándo recurrir a `struct` (y especialmente `readonly record struct`)

Un `struct` es un tipo de valor. Sus campos viven inline en lo que sea que lo contenga: en la pila para variables locales, dentro del objeto contenedor en el heap para campos, empaquetados de extremo a extremo en arreglos. Cada asignación es una copia bit a bit del struct completo. La igualdad, cuando la suministras, puede ser una sola comparación de CPU en lugar de una llamada virtual.

Esto es fantástico cuando los datos son pequeños y tienes muchos. Un struct de dos campos `int` puede mantenerse en un par de registros, compararse con una rama, y almacenarse en un arreglo como 8 bytes por elemento sin encabezado por elemento. La misma carga útil como `class` sería un encabezado de objeto de 24 bytes más una referencia de 8 bytes por slot, lo que destruye la localidad de caché una vez que el arreglo es mayor que la línea de L1.

La guía de Microsoft [choose between class and struct](https://learn.microsoft.com/en-us/dotnet/standard/design-guidelines/choosing-between-class-and-struct) lista cuatro condiciones para un struct: representa lógicamente un solo valor, tiene un tamaño de instancia por debajo de 16 bytes, es inmutable, y no sufre boxing con frecuencia. Las cuatro juntas, no tres de cuatro.

Elige `readonly record struct` (o `readonly struct` si no necesitas igualdad por valor) cuando:

- El tipo es un valor pequeño e inmutable: una coordenada, un monto monetario, un ID con tipo fuerte, una marca de tiempo de precisión fija.
- Mantendrás muchos en un arreglo o `Span<T>` e iterarás caliente.
- No les harás boxing. Convertir a `object` o a una interfaz no readonly hace boxing; convertir a una interfaz `ref struct` en C# 13+ no lo hace (cuando el JIT puede probarlo).
- No necesitas herencia.

```csharp
// .NET 10, C# 14
public readonly record struct Money(decimal Amount, string Currency)
{
    public static Money Zero(string currency) => new(0m, currency);
    public Money Plus(Money other) =>
        other.Currency == Currency
            ? new(Amount + other.Amount, Currency)
            : throw new InvalidOperationException("currency mismatch");
}
```

Esto compila a un tipo de valor con igualdad por valor integrada, un deconstructor, una sobrescritura de `ToString`, y semántica inmutable. Es el reemplazo moderno de "escribiré un `struct` y recordaré no hacerlo mutable".

La regla de 16 bytes es una heurística, no un tope rígido. El JIT pasará felizmente un struct de 24 bytes en registros en AMD64 si encaja en la convención de llamada. La razón para mantener los structs pequeños son las copias bit a bit. Cada asignación, cada paso de parámetro sin `in`, cada paso de `LINQ` copia todo. Un struct de 64 bytes pasado por valor a través de cinco marcos de método son 320 bytes de copia.

## Cuándo `record struct` (mutable) es la elección correcta

Un `record struct` simple (sin `readonly`) es raro pero legítimo. Te da igualdad por valor, un constructor primario y un `ToString`, mientras sigue permitiendo que los campos sean reasignados. Dos escenarios tienen sentido:

- Acumuladores de bucle caliente donde quieres igualdad y `ToString` generados por el compilador pero también quieres mutar campos en el sitio para evitar agitación de copias: `state.Count++; state.Total += x;` en un `record struct State` que vive en una sola local.
- Formas de interoperabilidad donde quieres semántica de valor y la capacidad de llenar el struct campo a campo después de la construcción.

Para todo lo demás, prefiere `readonly record struct`. Un struct mutable es un famoso disparate: asignarlo a una propiedad crea una copia, mutando la copia, y silenciosamente no hace nada al original.

## La matriz de decisión que puedes pegar en una pared

Tres preguntas, en orden. Detente en la primera que apunte a algún lugar.

1. **¿Tiene este tipo identidad, o posee estado cambiante a lo largo del tiempo?** Sí -> `class`. Ejemplos: `User`, `Order`, `HttpClient`, entidades de EF Core, cualquier cosa en un contenedor de servicios con un tiempo de vida.

2. **¿Es este tipo datos inmutables que deberían ser iguales por valor y pequeños (16 bytes o menos, sin referencias a objetos grandes)?** Sí -> `readonly record struct`. Ejemplos: `Money`, `Point`, IDs con tipo fuerte como `UserId(Guid Value)`, celdas `(int Row, int Column)`. El umbral de 16 bytes importa más cuando los mantienes en arreglos, span, o los pasas a través de bucles calientes.

3. **De lo contrario: ¿es el tipo datos inmutables con igualdad por valor?** Sí -> `record` (`record class`). Ejemplos: DTOs, modelos de solicitud/respuesta, eventos de dominio, instantáneas de configuración, tipos de mensaje en una cola. Este es el valor por defecto para "clases de datos" en C# moderno.

Si nada de lo anterior apunta a algún lugar, casi seguro quieres `class`. El caso restante es "necesito un tipo de valor pero tiene más de 16 bytes", lo que generalmente significa reestructurar el tipo, no inclinarse más hacia `struct`.

## El benchmark: cuándo las copias de struct realmente duelen

Una afirmación común es "los structs son más rápidos". A veces lo son, a veces el costo de copia domina. Aquí hay una medición rápida para una carga útil de 24 bytes pasada a través de cinco marcos de método.

```csharp
// .NET 10, C# 14, BenchmarkDotNet 0.14.0
using BenchmarkDotNet.Attributes;
using BenchmarkDotNet.Running;

BenchmarkRunner.Run<CopyCost>();

public readonly record struct PayloadStruct(long A, long B, long C); // 24 bytes
public sealed record PayloadClass(long A, long B, long C);           // pointer + 24 bytes on heap

[MemoryDiagnoser]
public class CopyCost
{
    private readonly PayloadStruct _s = new(1, 2, 3);
    private readonly PayloadClass _c = new(1, 2, 3);

    [Benchmark(Baseline = true)]
    public long Struct_ByVal()  => Sum1(_s);
    [Benchmark]
    public long Struct_ByIn()   => Sum2(in _s);
    [Benchmark]
    public long Class_ByRef()   => Sum3(_c);

    static long Sum1(PayloadStruct p)     => p.A + p.B + p.C;
    static long Sum2(in PayloadStruct p)  => p.A + p.B + p.C;
    static long Sum3(PayloadClass p)      => p.A + p.B + p.C;
}
```

Metodología: BenchmarkDotNet 0.14.0, .NET 10.0.0 RTM, Windows 11 24H2, AMD Ryzen 9 7900X. Números de una sola ejecución; vuelve a ejecutar en tu propio hardware antes de apostar por ellos.

| Método        | Media      | Asignado  |
| ------------- | ---------- | --------- |
| Struct_ByVal  | 0.31 ns    | 0 B       |
| Struct_ByIn   | 0.28 ns    | 0 B       |
| Class_ByRef   | 0.34 ns    | 0 B       |

El struct pasado por valor es ligeramente más rápido que la clase accedida por referencia, e `in` ahorra un pelo más. Pero la brecha es de subnanosegundos. El struct gana decisivamente solo cuando asignas la clase millones de veces -- el costo de asignación es lo que difiere, no el costo de acceso. Elige struct por presión de asignación, no por "acceso más rápido".

Cuando el struct crece, el patrón se invierte. Un struct mutable de 64 bytes pasado por valor a través de tres marcos es una regresión medible frente a una referencia de `class`. La regla de 16 bytes existe porque ahí es aproximadamente donde la copia bit a bit deja de ser gratis en AMD64.

## Las trampas que deciden por ti

Algunas cosas fuerzan la decisión sin importar la preferencia.

- **Igualdad con colecciones en la carga útil.** Si tu record contiene un `List<int>`, dos records con listas estructuralmente iguales se compararán como desiguales porque la igualdad por valor de `record` usa `EqualityComparer<T>.Default`, que recurre a la igualdad por referencia para `List<T>`. Usa `ImmutableArray<T>` (que tiene igualdad estructural) o sobrescribe `Equals` manualmente.

- **Entidades de EF Core y `record`.** EF Core 11 puede rastrear records como entidades, pero la expresión `with` produce una nueva instancia que el rastreador de cambios nunca ha visto. Si un manejador de solicitud hace `customer = customer with { Email = "..." }`, el rastreador de cambios sigue manteniendo la referencia antigua, lo que resulta en que no se emite ningún `UPDATE`. Quédate con `class` para entidades rastreadas.

- **Default(struct) es un valor real.** Un `struct` no puede ser `null`. `default(Money)` es una instancia `Money` con monto cero y moneda de cadena vacía que el sistema de tipos considera válida. Si un valor cero no tiene sentido para tu tipo, agrega una propiedad `IsValid` o usa una `record class` para que `null` sea tu señal de "sin valor".

- **Las interfaces hacen boxing de tipos de valor.** Convertir `Money` a `IEquatable<Money>` hace boxing del struct al heap, asignando un nuevo encabezado de objeto y copiando la carga útil. Si pretendes acceder a un struct a través de una interfaz en un bucle apretado, o has elegido la forma incorrecta o necesitas una restricción genérica (`where T : struct, IEquatable<T>`) para que el JIT pueda especializar sin boxing.

- **Códigos hash para structs rastreados.** Poner un struct mutable en un `Dictionary` o `HashSet` es un bug. La colección toma el código hash en la inserción y lo almacena; si mutas un campo, el hash del valor cambia y la colección no puede encontrarlo de nuevo. `readonly record struct` hace que esto sea imposible por construcción.

## La recomendación opinada, reformulada

Por defecto, `class`. Elige `record` (`record class`) para datos inmutables con igualdad por valor. Elige `readonly record struct` para valores pequeños inmutables que mantienes en masa o pasas a través de bucles calientes. Elige un `struct` simple solo cuando la interoperabilidad o la mutación en el sitio en una sola local hagan que valga la pena el disparate, y elige un `class` no-`record` para entidades y tipos que llevan identidad.

Dos corolarios que vale la pena comprometer en memoria muscular:

- Un `record` con un constructor primario y `sealed` es la "clase de datos" moderna. Si te encuentras escribiendo una clase con solo propiedades init-only y sobrescribiendo `Equals` y `GetHashCode`, el compilador ya escribió eso por ti.
- Un `readonly record struct` hace que "hacer que los estados ilegales sean irrepresentables" sea práctico para valores pequeños. Los IDs con tipo fuerte (`public readonly record struct UserId(Guid Value);`) son esencialmente gratis en tiempo de ejecución y eliminan una categoría de bugs del tipo "pasé el ID de pedido donde se esperaba el ID de usuario" en tiempo de compilación.

## Relacionado

- [Cómo usar records con EF Core 11 correctamente](/es/2026/04/how-to-use-records-with-ef-core-11-correctly/)
- [Cómo retornar múltiples valores desde un método en C# 14](/es/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/)
- [async void vs async Task en C#: cuándo cada uno es correcto](/es/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)
- [Cómo usar el nuevo tipo System.Threading.Lock en .NET 11](/es/2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11/)
- [Cómo usar SearchValues correctamente en .NET 11](/es/2026/04/how-to-use-searchvalues-correctly-in-dotnet-11/)

## Fuentes

- [Records (referencia de C#) -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/record)
- [Tipos struct (referencia de C#) -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/struct)
- [Elegir entre class y struct -- guías de diseño de .NET](https://learn.microsoft.com/en-us/dotnet/standard/design-guidelines/choosing-between-class-and-struct)
- [Tipos struct `readonly` -- referencia de C#](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/struct#readonly-struct)
- [Propuesta de record structs -- notas de diseño del lenguaje C#](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-10.0/record-structs.md)
