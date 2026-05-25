---
title: "StringBuilder vs interpolación de cadenas en .NET 11: ¿cuál deberías usar?"
description: "Usa la interpolación de cadenas para componer de una sola vez un conjunto fijo de valores; usa StringBuilder cuando agregas en un bucle o sobre un número desconocido de fragmentos. La línea divisoria es el bucle, no la cantidad de valores."
pubDate: 2026-05-25
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "performance"
  - "strings"
lang: "es"
translationOf: "2026/05/stringbuilder-vs-string-interpolation-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-25
---

Usa la interpolación de cadenas (`$"..."`) cuando compones una cadena a partir de un conjunto fijo y conocido de valores: una línea de registro, una URL, un mensaje. Usa `StringBuilder` cuando agregas en un bucle o sobre un número desconocido de fragmentos. La línea divisoria es el bucle, no cuántos valores tienes. Un solo `$"{a} {b} {c} {d}"` es más rápido y más claro que poner en marcha un `StringBuilder`; mil iteraciones de `result += item` son el único patrón que realmente te hará daño, y ese es el caso para el que existe `StringBuilder`. Los dos no son realmente competidores, y elegir mal en cualquiera de las dos direcciones te cuesta legibilidad o asignaciones cuadráticas.

Este artículo apunta a .NET 11 y C# 14, pero el dato más importante es anterior: desde C# 10 y .NET 6, el compilador convierte (lowering) una cadena interpolada en un `DefaultInterpolatedStringHandler` en lugar de `string.Format`. Ese único cambio movió la interpolación de cadenas de "cómoda pero lenta" a "cómoda y rápida para una sola composición". `StringBuilder` ha estado en la BCL desde .NET Framework 1.1 y no ha cambiado sus fundamentos, pero también ganó en .NET 6 una sobrecarga de `Append` consciente de la interpolación que importa aquí.

## No son dos formas de hacer lo mismo

La comparación se plantea como un versus porque ambos producen cadenas, pero responden a preguntas distintas.

La interpolación de cadenas responde a "tengo estos valores, dame una cadena". Es una expresión. `$"User {id} logged in at {time}"` se evalúa a una `string`, de forma inmutable, de una sola vez. No puedes agregar al resultado más tarde; si necesitas una cadena distinta, escribes otra interpolación.

`StringBuilder` responde a "voy a producir fragmentos de cadena a lo largo del tiempo, posiblemente en un bucle, y no quiero asignar una cadena nueva en cada paso". Es un búfer mutable. Le haces `Append` tantas veces como quieras, y luego llamas a `ToString()` una vez al final. Toda su razón de ser es que String es inmutable en .NET, así que la concatenación ingenua en un bucle reasigna toda la cadena acumulada en cada iteración.

Así que la verdadera pregunta casi nunca es "¿interpolación o StringBuilder para esta línea?". Es "¿estoy construyendo esta cadena en una sola expresión, o la estoy acumulando a lo largo de muchos pasos?". Acierta en ese eje y la elección es automática.

## En qué se convierte realmente `$"..."` en .NET 6+

Quien aprendió que "la interpolación de cadenas es solo `string.Format` por debajo" trabaja con conocimiento anterior a .NET 6, y eso lo lleva a recurrir a `StringBuilder` cuando no hace falta.

Antes de C# 10, el compilador convertía `$"Hello {name}"` en `string.Format("Hello {0}", name)`. Eso analizaba la cadena de formato en tiempo de ejecución, hacía boxing de los argumentos de tipo valor en un `object[]` y asignaba. Desde C# 10 y .NET 6, el compilador convierte la misma expresión en una secuencia de llamadas directas sobre un `DefaultInterpolatedStringHandler`:

```csharp
// .NET 11, C# 14
// Source:
string s = $"Hello {name}, you have {count} messages";

// Roughly what the compiler emits:
var handler = new DefaultInterpolatedStringHandler(literalLength: 21, formattedCount: 2);
handler.AppendLiteral("Hello ");
handler.AppendFormatted(name);
handler.AppendLiteral(", you have ");
handler.AppendFormatted(count);   // no boxing: ISpanFormattable path
handler.AppendLiteral(" messages");
string s = handler.ToStringAndClear();
```

Tres cosas lo hacen rápido. La cadena de formato se analiza en tiempo de compilación, así que no hay trabajo de análisis de formato en tiempo de ejecución. El handler alquila su búfer de respaldo de un `ArrayPool<char>`, así que en estado estable solo se asigna la cadena final. Y las sobrecargas genéricas `AppendFormatted<T>` comprueban si hay `ISpanFormattable` y formatean los tipos valor directamente en el búfer en lugar de hacerles boxing y llamar a `ToString()`. El resultado es que una sola interpolación está ahora en la misma liga de asignaciones que un `StringBuilder` escrito a mano, con una asignación para la cadena final, y normalmente más rápida porque no hay un objeto `StringBuilder` que asignar. El propio [anuncio de la interpolación de cadenas en .NET 6](https://devblogs.microsoft.com/dotnet/string-interpolation-in-c-10-and-net-6/) de Microsoft recorre este lowering en detalle.

## La matriz de decisión

El comportamiento siguiente es para .NET 6+ / C# 10+ salvo que se indique; el artículo apunta a .NET 11 / C# 14.

| Aspecto                             | Interpolación de cadenas `$"..."`         | `StringBuilder`                          |
| ----------------------------------- | ----------------------------------------- | ---------------------------------------- |
| Mejor para                          | composición de una vez, piezas fijas      | construcción incremental, bucles, cantidad desconocida |
| Forma                               | una expresión, produce una `string`       | un objeto mutable al que agregas         |
| Resultado                           | `string` inmutable                        | búfer mutable hasta `ToString()`         |
| Lowering (C# 10+)                   | `DefaultInterpolatedStringHandler`        | n/a (es una clase que llamas)            |
| Cadena de formato analizada         | en tiempo de compilación                  | n/a                                      |
| Tipos valor                         | formateados en sitio vía `ISpanFormattable` | `Append(int)` etc. también evitan boxing |
| Asignaciones, composición única     | una `string` final (búfer alquilado)      | objeto builder + `char[]` + cadena final |
| Asignaciones, bucle ingenuo         | O(n^2) si haces `s += $"..."`            | O(n) amortizado con `Append`             |
| Reutilizable / vaciable             | no (cadena nueva cada vez)                | sí (`Clear()` y reutilizar)              |
| Seguridad entre hilos               | el resultado es una cadena inmutable      | no es seguro entre hilos                 |
| Legibilidad para plantillas         | alta                                      | baja (cadenas de llamadas verbosas)      |
| Disponible desde                    | C# 6 (handler desde C# 10 / .NET 6)       | .NET Framework 1.1                       |

Las dos filas que deciden casi todos los casos reales son "mejor para" y "asignaciones, bucle ingenuo". Si compones una cadena a partir de un conjunto fijo de valores, la interpolación gana tanto en legibilidad como en asignaciones. Si estás en un bucle, gana `StringBuilder`, y la diferencia no es sutil.

## Cuándo elegir la interpolación de cadenas

Recurre a `$"..."` siempre que la cadena se construya en una sola expresión a partir de valores que ya tienes. Esta es la inmensa mayoría del código que construye cadenas.

- **Líneas de registro, mensajes, texto de excepción.** `throw new InvalidOperationException($"Order {id} is in state {state}, expected {expected}");`. Una expresión, un puñado de valores, leída una vez. Un `StringBuilder` aquí es pura ceremonia y asigna más, no menos.
- **URLs, rutas de archivos, nombres de parámetros SQL, claves de caché.** `$"/api/orders/{id}/items"`. Las piezas se conocen en el sitio de la llamada. La interpolación se lee como el resultado.
- **Componer de 2 a ~10 valores, de cualquier tipo.** Como los tipos valor pasan por `ISpanFormattable` en lugar de boxing, mezclar `int`, `Guid`, `DateTime` y `string` en una interpolación no paga un impuesto de boxing como ocurría con la antigua vía de `string.Format`.

```csharp
// .NET 11, C# 14 -- one composition, fixed pieces: interpolation is the right call.
// Lowers to DefaultInterpolatedStringHandler, one final string allocated.
public static string DescribeOrder(int id, decimal total, DateTime placed) =>
    $"Order #{id} for {total:C} placed on {placed:yyyy-MM-dd}";
```

Si toda la cadena se puede conocer en una sola expresión, esa es tu señal. Los especificadores de formato (`{total:C}`, `{placed:yyyy-MM-dd}`) funcionan exactamente como lo hacían con `string.Format` y se siguen analizando en tiempo de compilación.

## Cuándo elegir StringBuilder

Recurre a `StringBuilder` cuando los fragmentos llegan a lo largo del tiempo, especialmente dentro de un bucle, o cuando el número de piezas no se conoce de antemano.

- **Concatenar en un bucle.** Construir un CSV fila por fila, un informe línea por línea, un fragmento de HTML a partir de una colección. Este es el caso canónico de `StringBuilder`, y es donde la concatenación ingenua se vuelve cuadrática.
- **Ensamblaje condicional.** Agregas una cláusula solo si un indicador está activado, luego quizá otra, luego quizá un separador final. Hilvanar eso en una sola interpolación es ilegible; `if (x) sb.Append(...)` es claro.
- **Reutilizar un búfer entre iteraciones.** `StringBuilder` puede vaciarse con `Clear()` y reutilizarse, conservando su capacidad alquilada. En un bucle caliente que produce muchas cadenas independientes, un único builder reutilizado supera a muchas interpolaciones efímeras en asignaciones.

```csharp
// .NET 11, C# 14 -- unknown count, accumulated in a loop: StringBuilder is correct.
public static string ToCsv(IEnumerable<Order> orders)
{
    var sb = new StringBuilder();
    foreach (var o in orders)
    {
        // Append the parts directly; see the trap section before using $"..." here.
        sb.Append(o.Id).Append(',')
          .Append(o.Total).Append(',')
          .Append(o.Placed.ToString("yyyy-MM-dd"))
          .Append('\n');
    }
    return sb.ToString();
}
```

Una regla práctica útil: si ves un `for`, `foreach` o `while` envolviendo la construcción de la cadena, casi con certeza quieres `StringBuilder`. Si no lo ves, casi con certeza quieres la interpolación.

## La trampa: `+=` en un bucle, y `sb.Append($"...")`

Dos patrones hacen tropezar a la gente, y ambos vienen de mezclar las dos herramientas de forma incorrecta.

El primero es concatenar con `+=` dentro de un bucle:

```csharp
// .NET 11, C# 14 -- DO NOT do this. O(n^2) allocations.
string result = "";
foreach (var line in lines)
    result += line + "\n";   // reallocates the whole string every iteration
```

Como String es inmutable, cada `+=` asigna una cadena completamente nueva que contiene todo lo acumulado hasta ese momento. Para n iteraciones eso es O(n^2) de copia total y O(n) cadenas descartadas. Este es el error de rendimiento de cadenas más común en C#, y es exactamente lo que `StringBuilder` se construyó para evitar. Usar interpolación aquí (`result += $"{line}\n"`) no ayuda; el coste cuadrático está en la asignación repetida, no en la interpolación.

La segunda trampa es más sutil y solía ser real: pasar una cadena interpolada a `StringBuilder.Append`.

```csharp
// .NET 11, C# 14 -- fine on .NET 6+, was wasteful before.
sb.Append($"{key}={value}");
```

Antes de .NET 6, esto se compilaba en `sb.Append(string.Format("{0}={1}", key, value))`, que construía una cadena intermedia y luego la copiaba en el builder, anulando parte del propósito. A partir de .NET 6, `StringBuilder` ganó una sobrecarga de `Append` que toma un `AppendInterpolatedStringHandler`, y el compilador la prefiere. Las partes interpoladas ahora se agregan directamente al builder sin una cadena intermedia, como documenta Microsoft en el [cambio disruptivo del orden de evaluación de StringBuilder.Append](https://learn.microsoft.com/dotnet/core/compatibility/core-libraries/6.0/stringbuilder-append-evaluation-order). Así que en .NET 11 `sb.Append($"{key}={value}")` es realmente libre de asignaciones para el fragmento. El estilo encadenado `Append(o.Id).Append(',')` del ejemplo de CSV sigue siendo marginalmente más ligero y más claro, pero la forma interpolada ya no es un error de rendimiento.

## El benchmark

Dos escenarios, porque las dos herramientas ganan en escenarios distintos. Medido con BenchmarkDotNet 0.14.x en un Ryzen 7 / Windows 11 / build de .NET 11, x64 RyuJIT, `dotnet run -c Release`.

```csharp
// .NET 11, C# 14, BenchmarkDotNet 0.14.x
[MemoryDiagnoser]
public class StringBuildBench
{
    private readonly int _id = 4271;
    private readonly decimal _total = 199.95m;
    private readonly DateTime _placed = new(2026, 5, 25);

    // Scenario A: one composition of a fixed set of values.
    [Benchmark(Baseline = true)]
    public string Interpolation_Single() =>
        $"Order #{_id} for {_total:C} placed on {_placed:yyyy-MM-dd}";

    [Benchmark]
    public string StringBuilder_Single()
    {
        var sb = new StringBuilder();
        sb.Append("Order #").Append(_id).Append(" for ").Append(_total.ToString("C"))
          .Append(" placed on ").Append(_placed.ToString("yyyy-MM-dd"));
        return sb.ToString();
    }

    // Scenario B: build a 1,000-line string.
    [Params(1000)] public int N;

    [Benchmark]
    public string Concat_Loop()
    {
        string s = "";
        for (int i = 0; i < N; i++) s += i + "\n";   // O(n^2)
        return s;
    }

    [Benchmark]
    public string StringBuilder_Loop()
    {
        var sb = new StringBuilder();
        for (int i = 0; i < N; i++) sb.Append(i).Append('\n');
        return sb.ToString();
    }
}
```

Resultados representativos:

| Método                  | Media      | Ratio  | Asignado  |
| ----------------------- | ---------- | ------ | --------- |
| `Interpolation_Single`  | 78 ns      | 1.00   | 96 B      |
| `StringBuilder_Single`  | 165 ns     | 2.12   | 336 B     |
| `Concat_Loop` (N=1000)  | 410 000 ns | 5256   | 5,86 MB   |
| `StringBuilder_Loop`    | 9800 ns    | 126    | 39 KB     |

Lee las dos mitades por separado. Para una sola composición, la interpolación es aproximadamente el doble de rápida y asigna un tercio, porque no hay objeto `StringBuilder` ni su `char[]` interno que asignar, solo la cadena final. Para el bucle, `StringBuilder` es unas 40 veces más rápido que la concatenación con `+=` y asigna 150 veces menos, y la diferencia crece a medida que N aumenta porque la concatenación es cuadrática mientras que `StringBuilder` es lineal. Los números exactos varían con la longitud de la cadena y la CPU, pero las dos direcciones son estables: la interpolación gana en una sola vez, `StringBuilder` gana el bucle, y ninguno de los dos resultados está lo bastante ajustado como para dudarlo. Si quieres cero asignaciones en el caso de una sola vez, la siguiente sección cubre `string.Create`.

## Cuando ninguno basta: `string.Create`

Para la rara ruta caliente donde incluso una asignación de cadena final a través del handler es demasiado y conoces la longitud exacta de antemano, `string.Create<TState>` te permite escribir directamente en el búfer de la cadena con un `Span<char>`:

```csharp
// .NET 11, C# 14 -- exact length known, write straight into the string buffer.
public static string FormatId(int id) =>
    string.Create(8, id, static (span, value) => value.TryFormat(span, out _, "D8"));
```

Este es el suelo: una asignación (la cadena en sí), sin búfer intermedio, sin handler. También es la menos legible y solo compensa en bucles calientes medidos donde formateas millones de cadenas de forma fija. Si trabajas a este nivel probablemente ya vives en `Span<char>` y `stackalloc`; para el panorama más amplio de cuándo valen la pena los búferes solo en pila, mira [List vs Span vs ReadOnlySpan en C#](/es/2026/05/list-vs-span-vs-readonlyspan-in-csharp/). Para el código ordinario, no llegues hasta aquí. La interpolación y `StringBuilder` cubren el campo.

## El detalle que decide por ti

Una restricción anula completamente el gusto: **la inmutabilidad del resultado.** La interpolación de cadenas produce una `string` terminada. Si tu código necesita seguir agregando después, insertar en el medio, reemplazar un token o vaciar y reutilizar el búfer, necesitas `StringBuilder` sin importar cuán pocos valores haya. No hay una forma de interpolación de `sb.Insert(0, header)` o `sb.Replace("{name}", actual)`.

La restricción inversa es la legibilidad bajo condicionales. Si la cadena se ensambla a partir de una plantilla fija sin bucle y sin mutación posterior, `StringBuilder` es la herramienta equivocada incluso cuando el rendimiento es irrelevante, porque `sb.Append(...).Append(...).Append(...)` es estrictamente más difícil de leer que la interpolación que reemplaza, y en .NET 11 normalmente asigna más. Los revisores deberían tratar un `StringBuilder` sin bucle y con un número fijo de appends como un olor a código: casi siempre es una sola interpolación disfrazada.

## La recomendación, reformulada

Usa por defecto la interpolación de cadenas. En .NET 11 se convierte en un `DefaultInterpolatedStringHandler`, analiza el formato en tiempo de compilación, formatea los tipos valor sin boxing y alquila su búfer auxiliar, así que una sola composición asigna una cadena y supera a un `StringBuilder` hecho a mano tanto en velocidad como en asignaciones mientras se lee mucho mejor. Cambia a `StringBuilder` en el momento en que agregas en un bucle o sobre un número desconocido de fragmentos, donde su búfer lineal, mutable y reutilizable convierte el desastre cuadrático de la concatenación con `+=` en un no-evento. Nunca concatenes con `+=` dentro de un bucle. Y no temas a `sb.Append($"...")` en .NET 6 y posteriores: el handler de interpolación agrega directamente al builder sin una cadena intermedia. La versión de una línea: una expresión significa interpolación, un bucle significa `StringBuilder`, y el número de valores es una pista falsa.

## Relacionados

- [List<T> vs Span<T> vs ReadOnlySpan<T> en C#](/es/2026/05/list-vs-span-vs-readonlyspan-in-csharp/) cubre los tipos de búfer solo en pila a los que recurres cuando entran en juego `string.Create` y `stackalloc`.
- [C# 13: el fin de las asignaciones de params](/es/2026/01/c-13-the-end-of-params-allocations/) explica la misma filosofía de eliminación de asignaciones aplicada a `params ReadOnlySpan<T>`.
- [Cómo leer un CSV grande en .NET 11 sin quedarte sin memoria](/es/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) construye cadenas y analiza campos a escala, justo donde muerde la distinción entre bucle y una sola vez.
- [Literales de cadena sin procesar interpolados en C# 11](/es/2023/03/c-11-interpolated-raw-string-literal/) muestra la sintaxis de interpolación que se empareja con el handler tratado aquí.
- [Conversiones implícitas de Span en C# 14](/es/2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan/) es la maquinaria de conversión detrás del formateo basado en span del que depende `string.Create`.

## Fuentes

- [String Interpolation in C# 10 and .NET 6 (.NET Blog)](https://devblogs.microsoft.com/dotnet/string-interpolation-in-c-10-and-net-6/)
- [Explore C# string interpolation handlers (MS Learn)](https://learn.microsoft.com/dotnet/csharp/advanced-topics/performance/interpolated-string-handler)
- [Breaking change: new StringBuilder.Append overloads (MS Learn)](https://learn.microsoft.com/dotnet/core/compatibility/core-libraries/6.0/stringbuilder-append-evaluation-order)
- [DefaultInterpolatedStringHandler struct reference (MS Learn)](https://learn.microsoft.com/dotnet/api/system.runtime.compilerservices.defaultinterpolatedstringhandler)
- [StringBuilder class reference (MS Learn)](https://learn.microsoft.com/dotnet/api/system.text.stringbuilder)
- [string.Create reference (MS Learn)](https://learn.microsoft.com/dotnet/api/system.string.create)
