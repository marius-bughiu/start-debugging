---
title: "Conversiones implícitas de Span en C# 14: soporte de primera clase para Span y ReadOnlySpan"
description: "C# 14 añade conversiones implícitas integradas entre Span, ReadOnlySpan, arreglos y strings, permitiendo APIs más limpias, mejor inferencia de tipos y menos llamadas manuales a AsSpan()."
pubDate: 2025-04-06
tags:
  - "csharp-14"
  - "csharp"
  - "dotnet"
  - "dotnet-10"
lang: "es"
translationOf: "2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan"
translatedBy: "claude"
translationDate: 2026-05-01
---
**C# 14** introduce una mejora significativa para el código de alto rendimiento: soporte de primera clase a nivel de lenguaje para los spans. En particular, añade nuevas **conversiones implícitas** entre **`Span<T>`**, **`ReadOnlySpan<T>`** y arreglos (`T[]`). Este cambio facilita mucho trabajar con estos tipos que representan secciones contiguas y seguras de memoria sin asignaciones adicionales. En este artículo veremos qué son las conversiones de span, cómo C# 14 cambió las reglas y por qué es importante para tu código.

## Contexto: qué son `Span<T>` y `ReadOnlySpan<T>`

`Span<T>` y `ReadOnlySpan<T>` son estructuras de solo pila (por referencia) que te permiten referirte a una región contigua de memoria (por ejemplo, un segmento de un arreglo, string o memoria no administrada) de forma segura. Se introdujeron en C# 7.2 y se han vuelto muy comunes en .NET para escenarios de **alto rendimiento y cero asignaciones**. Como son tipos **`ref struct`**, los spans solo pueden existir en la pila (o dentro de otro ref struct), lo que garantiza que **no pueden sobrevivir a la memoria a la que apuntan**, preservando la seguridad. En la práctica, `Span<T>` se usa para secciones de memoria mutables, mientras que `ReadOnlySpan<T>` se usa para secciones de solo lectura.

**¿Por qué usar spans?** Te permiten trabajar con subarreglos, subcadenas o búferes **sin copiar datos ni asignar memoria nueva**. Esto se traduce en mejor rendimiento y menor presión sobre el GC, manteniendo a la vez la **seguridad de tipos y la verificación de límites** (a diferencia de los punteros sin procesar). Por ejemplo, analizar un texto grande o un búfer binario puede hacerse con spans para evitar crear muchas cadenas pequeñas o arreglos de bytes. Muchas APIs de .NET (E/S de archivos, parsers, serializadores, etc.) ahora ofrecen sobrecargas basadas en spans por eficiencia. Sin embargo, hasta C# 14, el lenguaje en sí no entendía completamente la relación entre spans y arreglos, lo que generaba algo de código repetitivo.

## Antes de C# 14: conversiones manuales y sobrecargas

En versiones anteriores de C#, los spans tenían operadores de conversión definidos por el usuario hacia y desde arreglos. Por ejemplo, podías **convertir implícitamente** un arreglo `T[]` a un `Span<T>` o a un `ReadOnlySpan<T>` usando las sobrecargas definidas en el runtime de .NET. De igual forma, un `Span<T>` podía convertirse implícitamente en un `ReadOnlySpan<T>`. _¿Y entonces dónde estaba el problema?_ El problema es que esas eran conversiones definidas en la biblioteca, no conversiones integradas en el lenguaje. El compilador de C# **no** trataba a `Span<T>`, `ReadOnlySpan<T>` y `T[]` como tipos relacionados en ciertos escenarios. Esto provocaba algunos puntos dolorosos para los desarrolladores antes de C# 14:

-   **Métodos de extensión sobre Spans/arreglos:** Si escribías un método de extensión que tomaba un `ReadOnlySpan<T>` como parámetro `this`, no podías llamarlo directamente sobre un arreglo o sobre una variable `Span<T>`. El compilador no consideraba la conversión arreglo a span al enlazar el receptor del método de extensión. En la práctica, esto significaba que a menudo necesitabas proporcionar **sobrecargas duplicadas** para arreglos y spans, o llamar a una extensión convirtiendo el arreglo manualmente antes. Por ejemplo, la BCL (Base Class Library) tenía que ofrecer ciertos métodos utilitarios (como los de `MemoryExtensions`) en varias formas, una para `ReadOnlySpan<T>`, otra para `Span<T>` y otra para `T[]`, para asegurar que se pudieran usar en todos los casos.
-   **Métodos genéricos e inferencia de tipos:** Existía una fricción similar con los métodos genéricos. Si tenías un método genérico `Foo<T>(Span<T> data)` y tratabas de pasarle un arreglo (digamos `int[]`), el compilador no podía inferir `T` porque no veía un `Span<T>` exacto en el sitio de la llamada: tenías que especificar el parámetro de tipo explícitamente o llamar a `.AsSpan()` sobre el arreglo. La conversión implícita definida por el usuario de `T[]` a `Span<T>` no se consideraba durante la **inferencia de tipos**, lo que hacía el código menos ergonómico.
-   **Conversiones explícitas necesarias:** En muchos casos los desarrolladores tenían que insertar conversiones manuales como llamar a `myArray.AsSpan()` o `new ReadOnlySpan<char>(myString)` para obtener un span a partir de un arreglo o string. Aunque no son terriblemente complicadas, añaden ruido al código y dependen de que el desarrollador sepa cuándo convertir. Los IDE no siempre lo sugerían, ya que las relaciones de tipo no eran conocidas por las reglas de conversión del compilador.

## Conversiones implícitas de Span en C# 14

C# 14 aborda estos problemas introduciendo **conversiones implícitas de span integradas** a nivel del lenguaje. Ahora el compilador reconoce directamente ciertas conversiones entre arreglos y tipos span, lo que suele llamarse **"soporte de span de primera clase"**. En términos prácticos, esto significa que puedes pasar libremente arreglos o incluso strings a APIs que esperan spans, y viceversa, sin casts explícitos ni sobrecargas. La especificación del lenguaje describe la nueva _conversión implícita de span_ permitiendo que `T[]`, `Span<T>`, `ReadOnlySpan<T>` e incluso `string` se conviertan entre sí de formas específicas. Las conversiones implícitas admitidas incluyen:

-   **Arreglo a Span:** Cualquier arreglo unidimensional `T[]` puede convertirse implícitamente a `Span<T>`. Por ejemplo, un `int[]` será aceptado donde se espere un `Span<int>`, sin sintaxis adicional.
-   **Arreglo a ReadOnlySpan:** Cualquier `T[]` también puede convertirse implícitamente a `ReadOnlySpan<T>` (o a un equivalente covariante `ReadOnlySpan<U>` si `T` es convertible a `U`). Esto significa que puedes proporcionar un arreglo a un método que quiera un span de solo lectura del mismo tipo de elemento. (La covarianza aquí es similar a la covarianza de arreglos, por ejemplo, un `String[]` puede convertirse a `ReadOnlySpan<object>` porque `string` es un `object`, pero este es un escenario más avanzado.)
-   **Span a ReadOnlySpan:** Un `Span<T>` puede tratarse implícitamente como un `ReadOnlySpan<T>` (o `ReadOnlySpan<U>` para tipos de referencia compatibles). En otras palabras, puedes pasar un span mutable a algo que solo lo lee. Esta conversión ya era posible, pero ahora es una conversión estándar que el compilador considerará en más contextos (no solo a través de un operador definido por el usuario).
-   **String a ReadOnlySpan:** Un `string` ahora puede convertirse implícitamente a `ReadOnlySpan<char>`. Esto es muy útil para tratar los datos de string como spans de solo lectura de caracteres. (Internamente esto es seguro porque el span apunta a la memoria interna del string, y los strings son inmutables en C#.) Antes tenías que llamar a `.AsSpan()` sobre un string o usar `MemoryExtensions` para lograrlo; ahora ocurre automáticamente cuando se necesita.

Estas conversiones forman ahora parte de las **reglas de conversión integradas del compilador** (añadidas al conjunto de _conversiones implícitas estándar_ en la especificación del lenguaje). Crucialmente, como el compilador entiende estas relaciones, las considerará durante la **resolución de sobrecargas**, el **enlace de métodos de extensión** y la **inferencia de tipos**. En resumen, C# 14 "sabe" que `T[]`, `Span<T>` y `ReadOnlySpan<T>` son intercambiables hasta cierto punto, lo que se traduce en código más intuitivo. Como dice la documentación oficial: C# 14 reconoce la relación entre estos tipos y permite una programación más natural con ellos, haciendo que los tipos span sean utilizables como receptores de métodos de extensión y mejorando la inferencia genérica.

## Antes y después de C# 14

Veamos cómo el código se vuelve más limpio con las conversiones implícitas de span en comparación con versiones anteriores de C#.

### 1\. Métodos de extensión sobre Span vs Arreglo

Considera un método de extensión definido para `ReadOnlySpan<T>` (por ejemplo, una verificación simple para ver si un span comienza con un elemento dado). En C# 13 o anteriores, **no podías llamar** ese método de extensión directamente sobre un arreglo, aunque un arreglo se pueda ver como un span, porque el compilador no aplicaba la conversión para el receptor de la extensión. Tenías que llamar a `.AsSpan()` o escribir una sobrecarga separada. En C# 14, funciona de forma natural:

```cs
// Extension method defined on ReadOnlySpan<T>
public static class SpanExtensions {
    public static bool StartsWith<T>(this ReadOnlySpan<T> span, T value) 
        where T : IEquatable<T>
    {
        return span.Length != 0 && EqualityComparer<T>.Default.Equals(span[0], value);
    }
}

int[] arr = { 1, 2, 3 };
Span<int> span = arr;        // Array to Span<T> (always allowed)
// C# 13 and earlier:
// bool result1 = arr.StartsWith(1);    // Compile-time error (not recognized)
// bool result2 = span.StartsWith(1);   // Compile-time error for Span<T> receiver
// (Had to call arr.AsSpan() or define another overload for arrays/spans)
bool result = arr.StartsWith(1);       // C# 14: OK - arr converts to ReadOnlySpan<int> implicitly
Console.WriteLine(result);            // True, since 1 is the first element
```

En el fragmento de arriba, `arr.StartsWith(1)` no compilaría en C# antiguo (error CS8773) porque el método de extensión espera un **receptor** `ReadOnlySpan<int>`. C# 14 permite que el compilador convierta implícitamente el `int[]` (`arr`) a un `ReadOnlySpan<int>` para coincidir con el parámetro receptor de la extensión. Lo mismo ocurre con una variable `Span<int>` que llama a una extensión `ReadOnlySpan<T>`: el `Span<T>` puede convertirse a `ReadOnlySpan<T>` al vuelo. Esto significa que ya no necesitamos escribir métodos de extensión duplicados (uno para `T[]`, otro para `Span<T>`, etc.) ni convertir manualmente para llamarlos. El código es más claro y conciso.

### 2\. Inferencia de tipos en métodos genéricos con Spans

Las conversiones implícitas de span también ayudan con los **métodos genéricos**. Supón que tenemos un método genérico que opera sobre un span de cualquier tipo:

```cs
// A generic method that prints the first element of a span
void PrintFirstElement<T>(Span<T> data) {
    if (data.Length > 0)
        Console.WriteLine($"First: {data[0]}");
}

// Before C# 14:
int[] numbers = { 10, 20, 30 };
// PrintFirstElement(numbers);        // ❌ Cannot infer T in C# 13 (array isn't Span<T>)
PrintFirstElement<int>(numbers);      // ✅ Had to explicitly specify <int>, or do PrintFirstElement(numbers.AsSpan())

// In C# 14:
PrintFirstElement(numbers);           // ✅ Implicit conversion allows T to be inferred as int
```

Antes de C# 14, la llamada `PrintFirstElement(numbers)` no compilaba porque el argumento de tipo `T` no podía inferirse: el parámetro es `Span<T>` y un `int[]` no es directamente un `Span<T>`. Tenías que proporcionar el parámetro de tipo `<int>` o convertir el arreglo a `Span<int>` por tu cuenta. Con C# 14, el compilador ve que `int[]` puede convertirse a `Span<int>` y, por lo tanto, infiere `T` = `int` automáticamente. Esto hace que las utilidades genéricas que trabajan con spans sean mucho más cómodas de usar, especialmente al tratar con entradas de tipo arreglo.

### 3\. Pasar strings a APIs de Span

Otro escenario común es trabajar con strings como spans de solo lectura de caracteres. Muchas APIs de parsing y procesamiento de texto usan `ReadOnlySpan<char>` por eficiencia. En versiones anteriores de C#, si querías llamar a una API así con un `string`, tenías que llamar a `.AsSpan()` sobre el string. C# 14 elimina ese requisito:

```cs
void ProcessText(ReadOnlySpan<char> text)
{
    // Imagine this method parses or examines the text without allocating.
    Console.WriteLine(text.Length);
}

string title = "Hello, World!";
// Before C# 14:
ProcessText(title.AsSpan());   // Had to convert explicitly.
// C# 14 and later:
ProcessText(title);            // Now implicit: string -> ReadOnlySpan<char>

ReadOnlySpan<char> span = title;         // Implicit conversion on assignment
ReadOnlySpan<char> subSpan = title[7..]; // Slicing still yields a ReadOnlySpan<char>
Console.WriteLine(span[0]);   // 'H'
```

La capacidad de tratar implícitamente un `string` como un `ReadOnlySpan<char>` es parte del nuevo soporte de conversiones de span. Esto es especialmente útil en código del mundo real: por ejemplo, métodos como `int.TryParse(ReadOnlySpan<char>, ...)` o `Span<char>.IndexOf` ahora pueden llamarse directamente con un argumento de string. Mejora la legibilidad del código eliminando ruido (llamadas a `AsSpan()`) y asegura que no ocurran asignaciones ni copias innecesarias de strings. La conversión es de costo cero: simplemente proporciona una vista de la memoria del string original.

## Casos de uso reales que se benefician de las conversiones de Span

Las conversiones implícitas de span en C# 14 no son solo un retoque teórico del lenguaje: tienen impacto práctico en varios escenarios de programación:

-   **Parsing de alto rendimiento y procesamiento de texto:** Las bibliotecas o aplicaciones que parsean texto (por ejemplo, parsers de CSV/JSON, compiladores) suelen usar `ReadOnlySpan<char>` para evitar crear subcadenas. Con la conversión implícita, esas APIs pueden aceptar entrada `string` sin fricciones. Por ejemplo, un parser JSON puede tener un único método `Parse(ReadOnlySpan<char> json)` que ahora puedes alimentar con un `string`, un `char[]` o un fragmento de un búfer mayor, todo sin sobrecargas adicionales ni copias.
-   **APIs eficientes en memoria:** En .NET es común encontrar APIs que procesan datos por bloques, por ejemplo, leyendo de un archivo o red hacia un búfer. Estas APIs pueden usar `Span<byte>` para entrada/salida y evitar asignaciones. Gracias a C# 14, si tienes datos existentes en un `byte[]`, puedes pasárselos directamente a una API basada en spans. A la inversa, si una API devuelve un `Span<T>` o `ReadOnlySpan<T>`, puedes pasarlo fácilmente a otro componente que espera un arreglo o un span de solo lectura. La **ergonomía** anima a los desarrolladores a usar spans, lo que reduce el churn de memoria. En resumen, puedes diseñar una única API centrada en spans que funcione naturalmente con arreglos y strings, dejando tu base de código más limpia.
-   **Interoperabilidad y escenarios unsafe:** Al interactuar con código no administrado o interfaces de hardware, sueles trabajar con búferes en bruto. Los spans son una forma segura de representarlos en C#. Por ejemplo, podrías llamar a un método nativo que llena un arreglo de bytes; con conversiones implícitas, tu firma P/Invoke puede usar `Span<byte>` y aun así llamarse con un `byte[]` normal. Esto aporta la seguridad de los spans (evitando desbordamientos de búfer, etc.) sin perder comodidad. En escenarios de bajo nivel (como parsing de protocolos binarios o datos de imagen), poder tratar diferentes fuentes de memoria uniformemente como spans simplifica el código.
-   **Uso general de la biblioteca .NET:** La propia BCL de .NET se beneficiará. Ahora el equipo puede ofrecer una sola sobrecarga para métodos que tratan con spans, en lugar de múltiples sobrecargas para arreglos, spans y spans de solo lectura. Por ejemplo, la extensión `.StartsWith()` para spans (como vimos) o los métodos de `System.MemoryExtensions` pueden definirse una vez sobre `ReadOnlySpan<T>` y funcionar automáticamente para entradas `T[]` y `Span<T>`. Esto reduce la superficie de la API y la posibilidad de inconsistencias. Como desarrollador, cuando ves una firma como `public void Foo(ReadOnlySpan<byte> data)`, ya no tienes que preguntarte si existe una versión de `Foo` para arreglos: en C# 14 simplemente puedes pasarle un `byte[]` y funcionará.

## Beneficios de las conversiones implícitas de Span

**Mejor legibilidad:** El beneficio más inmediato es un código más limpio. Escribes lo que se siente natural, pasar un arreglo o string a una API que consume spans, y simplemente funciona. Hay menos carga cognitiva porque no necesitas recordar llamar a helpers de conversión ni incluir múltiples sobrecargas. El encadenamiento de métodos de extensión se vuelve más intuitivo. En general, el código que usa spans es más fácil de leer y escribir, y se parece más al C# "normal". Esto fomenta las buenas prácticas (usar spans por rendimiento) al reducir la fricción para hacerlo.

**Menos errores:** Al dejar que el compilador maneje las conversiones, hay menos margen para errores. Por ejemplo, un desarrollador podría olvidarse de llamar a `.AsSpan()` y acabar invocando accidentalmente una sobrecarga menos eficiente; en C# 14 se elige automáticamente la sobrecarga de span correcta cuando aplica. También significa comportamiento consistente: la conversión está garantizada como segura (sin copia de datos, sin problemas con null salvo donde corresponda). Las herramientas y los IDE ahora pueden sugerir adecuadamente sobrecargas basadas en spans porque los tipos son compatibles. Todas las conversiones implícitas están diseñadas para ser inocuas: no cambian los datos ni incurren en costo en tiempo de ejecución, simplemente reinterpretan un búfer de memoria existente dentro de un envoltorio span.

**Seguridad y rendimiento:** Los spans se crearon para mejorar el rendimiento **de forma segura**, y la actualización de C# 14 continúa esa filosofía. Las conversiones implícitas no socavan la seguridad de tipos: sigues sin poder convertir implícitamente tipos incompatibles (por ejemplo, `int[]` a `Span<long>` solo se permitiría explícitamente, si acaso, ya que requiere reinterpretación real). Los propios tipos span aseguran que no puedas mutar accidentalmente algo que debería ser de solo lectura (si conviertes un arreglo a `ReadOnlySpan<T>`, la API que llamas no puede modificar tu arreglo). Además, como los spans son de solo pila, el compilador hace cumplir que no los almacenes en variables de larga vida (como campos) que puedan sobrevivir a los datos. Al hacer que los spans sean más fáciles de usar, C# 14 promueve escribir código de alto rendimiento sin recurrir a punteros unsafe, manteniendo las garantías de seguridad de memoria que los desarrolladores de C# esperan.

**Métodos de extensión y genéricos:** Como destacamos, los spans ahora pueden participar plenamente en la resolución de métodos de extensión y la inferencia de tipos genéricos. Esto significa que las APIs fluidas y los patrones tipo LINQ que pueden usar métodos de extensión funcionan directamente con spans/arreglos de forma intercambiable. Los algoritmos genéricos (para ordenar, buscar, etc.) pueden escribirse con spans y aún así invocarse con argumentos de arreglo sin alboroto. El resultado final es que puedes unificar las rutas de código: no necesitas una ruta para arreglos y otra para spans; una sola implementación basada en span lo cubre todo, lo cual es a la vez más seguro (menos código que pueda fallar) y más rápido (una única ruta de código optimizada).

## Lo que significa para tu código

La introducción de las conversiones implícitas de span en C# 14 es un regalo para los desarrolladores que escriben código sensible al rendimiento. **Cierra la brecha** entre arreglos, strings y tipos span enseñando al compilador a entender sus relaciones. Comparado con versiones anteriores, ya no tienes que salpicar tu código con llamadas manuales a `.AsSpan()` ni mantener sobrecargas paralelas para spans y arreglos. En su lugar, escribes una única API clara y confías en que el lenguaje haga lo correcto cuando le pases distintos tipos de datos.

En la práctica, esto significa código más expresivo y conciso al manipular secciones de memoria. Ya sea que estés parseando texto, procesando datos binarios o tratando de evitar asignaciones innecesarias en código cotidiano, el soporte de span de primera clase en C# 14 hace que la programación basada en Span se sienta más _natural_. Es un gran ejemplo de una característica del lenguaje que mejora tanto la productividad del desarrollador como el rendimiento en tiempo de ejecución, manteniendo el código seguro y robusto. Con los spans convirtiéndose ahora sin fricción desde arreglos y strings, puedes adoptar estos tipos de alto rendimiento en toda tu base de código con aún menos fricción que antes.

**Fuentes:**

-   [C# 14 Feature Specification – _First-class Span types_](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-14.0/first-class-span-types#:~:text=recognize%20the%20relationship%20between%20%60ReadOnlySpan,a%20lot%20of%20duplicate%20surface)
-   [_What's new in C# 14: More implicit conversions for Span<T>_](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/csharp-14#implicit-span-conversions#:~:text=%60Span,with%20generic%20type%20inference%20scenarios)
-   [What's new in C# 14](/2024/12/csharp-14/)
