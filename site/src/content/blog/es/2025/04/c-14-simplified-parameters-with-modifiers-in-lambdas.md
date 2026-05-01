---
title: "C# 14: Parámetros simplificados con modificadores en lambdas"
description: "C# 14 permite usar los modificadores ref, out, in, scoped y ref readonly en parámetros de lambda con tipo implícito, eliminando la necesidad de declarar explícitamente los tipos de los parámetros."
pubDate: 2025-04-09
tags:
  - "csharp-14"
  - "csharp"
  - "dotnet"
  - "dotnet-10"
lang: "es"
translationOf: "2025/04/c-14-simplified-parameters-with-modifiers-in-lambdas"
translatedBy: "claude"
translationDate: 2026-05-01
---
Las expresiones lambda han sido una característica clave de C# durante muchos años, permitiendo escribir funciones inline o callbacks de forma concisa. En C#, una lambda puede tener **parámetros con tipo explícito** (donde especificas el tipo de cada parámetro) o **parámetros con tipo implícito** (donde los tipos se infieren del contexto). Antes de C# 14, si querías usar ciertos modificadores de parámetro en una lambda (como pasar por referencia o parámetros de salida), te veías obligado a declarar explícitamente los tipos de los parámetros. Esto solía generar una sintaxis más verbosa cuando se necesitaban esos modificadores.

C# 14 introduce una nueva característica que aborda esta limitación: **parámetros simples de lambda con modificadores**. Esta característica permite usar modificadores de parámetro como `ref`, `in`, `out`, `scoped` y `ref readonly` en una expresión lambda **sin** tener que escribir explícitamente los tipos de los parámetros. Dicho de manera más sencilla, ahora puedes añadir estos modificadores a parámetros de lambda "sin tipo" (parámetros cuyos tipos se infieren), lo que hace que las lambdas con modos especiales de paso de parámetros sean más fáciles de escribir y leer.

## Lambdas en C# 13 y versiones anteriores

En C# 13 y todas las versiones anteriores, los parámetros de lambda podían tener tipo explícito o implícito, pero había una trampa al usar modificadores de parámetro. Si algún parámetro de la lambda necesitaba un modificador (por ejemplo, un parámetro `out` o un parámetro `ref`), el compilador de C# requería que **todos** los parámetros de esa lambda tuvieran un tipo explícito declarado. No podías aplicar `ref`, `in`, `out`, `scoped` o `ref readonly` a un parámetro de lambda a menos que también escribieras el tipo de ese parámetro.

Por ejemplo, imagina un tipo de delegado que tiene un parámetro `out`:

```cs
// A delegate that tries to parse a string into T, returning true on success.
delegate bool TryParse<T>(string text, out T result);
```

Si querías asignar una lambda a este delegado en C# 13, tenías que incluir explícitamente los tipos de ambos parámetros porque uno de ellos usa el modificador `out`. Una asignación válida de lambda en C# 13 se vería así:

```cs
// C# 13 and earlier: must explicitly specify types when using 'out'
TryParse<int> parseOld = (string text, out int result) => Int32.TryParse(text, out result);
```

Aquí escribimos explícitamente `string` para el parámetro `text` e `int` para el parámetro `result`. Si intentaras omitir los tipos, el código no compilaría. En otras palabras, algo como `(text, out result) => ...` **no** estaba permitido en C# 13, porque la presencia de `out` en `result` exigía que el tipo de `result` (`int` en este caso) se indicara explícitamente. Este requisito se aplicaba a cualquiera de los modificadores `ref`, `in`, `out`, `ref readonly` y `scoped` en las listas de parámetros de lambda.

## Modificadores de parámetros lambda en C# 14

C# 14 elimina esa restricción y hace que las lambdas sean más flexibles. Ahora puedes añadir modificadores de parámetros a los parámetros de la lambda sin proporcionar el tipo del parámetro de forma explícita. El compilador inferirá los tipos a partir del contexto (como el tipo del delegado o del árbol de expresiones al que se está convirtiendo la lambda) sin dejar de admitir los modificadores de parámetro. Esta mejora se traduce en menos texto repetitivo y código más legible cuando se trabaja con delegados o expresiones que involucran parámetros por referencia o scoped.

**Modificadores admitidos:** Puedes usar los siguientes modificadores en parámetros de lambda con tipo implícito a partir de C# 14:

-   `ref` -- pasa el argumento por referencia, permitiendo que la lambda lea o modifique la variable de quien la invoca.
-   `out` -- pasa el argumento por referencia, designado para salida; la lambda debe asignar un valor a este parámetro antes de retornar.
-   `in` -- pasa el argumento por referencia como solo lectura; la lambda puede leer el valor pero no puede modificarlo.
-   `ref readonly` -- pasa por referencia de manera de solo lectura (esencialmente similar a `in`, introducido para soportar ciertos escenarios con tipos por valor).
-   `scoped` -- indica que un parámetro (típicamente un ref struct como `Span<T>`) está delimitado al llamador, evitando que sea capturado o almacenado más allá de la llamada.

Estos modificadores antes solo se podían usar si declarabas explícitamente los tipos de los parámetros en la lambda. Ahora puedes escribirlos en la lista de parámetros de una lambda sin tipos.

Una advertencia importante es que el modificador `params` **no** está incluido en esta nueva capacidad. Si una lambda tiene un parámetro `params` (para un número variable de argumentos), todavía necesitas especificar explícitamente el tipo del parámetro. En resumen, `params` aún requiere una lista de parámetros con tipo explícito en las lambdas.

Volvamos al ejemplo anterior usando el delegado `TryParse<T>` para ver cómo C# 14 simplifica la sintaxis. Ahora podemos omitir los nombres de los tipos y seguir usando el modificador `out`:

```cs
// C# 14: type inference with 'out' parameter
TryParse<int> parseNew = (text, out result) => Int32.TryParse(text, out result);
```

Esta lambda se asigna a `TryParse<int>`, así que el compilador sabe que `text` es un `string` y que `result` es un `int` a partir de la definición del delegado. Pudimos escribir `(text, out result) => ...` sin especificar los tipos explícitamente, y compila y funciona correctamente. El modificador `out` se aplica a `result` aunque no escribimos `int`. C# 14 lo infiere por nosotros, lo que hace que la declaración de la lambda sea más corta y evita repetir información que el compilador ya conoce.

El mismo principio se aplica a otros modificadores. Considera un delegado que toma un parámetro por referencia:

```cs
// A delegate that doubles an integer in place.
delegate void Doubler(ref int number);
```

En C# 13, para crear una lambda que coincida con este delegado, tenías que incluir el tipo junto con el modificador `ref`:

```cs
// C# 13: explicit type needed for 'ref' parameter
Doubler makeDoubleOld = (ref int number) => number *= 2;
```

Con C# 14 puedes omitir el tipo y escribir solo el modificador y el nombre del parámetro:

```cs
// C# 14: implicit type with 'ref' parameter
Doubler makeDoubleNew = (ref number) => number *= 2;
```

Aquí, el contexto (el delegado `Doubler`, que recibe un `ref int` y devuelve void) le dice al compilador que `number` es un `int`, así que no necesitamos detallarlo. Simplemente usamos `ref number` en la lista de parámetros de la lambda.

También puedes usar varios modificadores juntos u otras formas de estos modificadores de la misma manera. Por ejemplo, si tienes un delegado con un parámetro `ref readonly` o un parámetro `scoped`, C# 14 te permite escribirlos sin tipos explícitos también. Por ejemplo:

```cs
// A delegate with an 'in' (readonly ref) parameter
delegate void PrintReadOnly(in DateTime value);

// C# 14: using 'in' without explicit type
PrintReadOnly printDate = (in value) => Console.WriteLine(value);
```

De forma similar, si tenemos un delegado con un parámetro `scoped`:

```cs
// A delegate that takes a scoped Span<int>
delegate int SumElements(scoped Span<int> data);

// C# 14: using 'scoped' without explicit type
SumElements sum = (scoped data) =>
{
    int total = 0;
    foreach (int x in data)
        total += x;
    return total;
};
```

Aquí, `data` se sabe que es un `Span<int>` (un tipo solo de pila) gracias al delegado, y lo marcamos como `scoped` sin escribir el nombre del tipo. Esto garantiza que `data` no pueda ser capturado fuera de la lambda (siguiendo la semántica de `scoped`), tal como ocurriría si hubiéramos escrito `(scoped Span<int> data)`.

## Qué beneficios aporta

Permitir parámetros simples de lambda con modificadores hace que el código sea más limpio y reduce la repetición. En versiones anteriores de C#, usar parámetros por referencia o scoped en lambdas significaba escribir tipos que el compilador ya podía deducir. Ahora puedes dejar que el compilador maneje los tipos mientras tú expresas la intención (por ejemplo, que un parámetro se pasa por referencia o es de salida). Esto lleva a lambdas más concisas y fáciles de leer, especialmente cuando las firmas de los delegados son complejas o usan tipos genéricos.

Vale la pena señalar que esta característica no cambia el comportamiento en tiempo de ejecución de las lambdas ni cómo funcionan esos modificadores; solo cambia la sintaxis que usas para declarar los parámetros de la lambda. La lambda seguirá las mismas reglas para `ref`, `out`, `in`, etc., como si los hubieras escrito con tipos explícitos. El modificador `scoped` sigue obligando a que el valor no se capture más allá de la ejecución de la lambda. La mejora clave es simplemente que tu código fuente queda menos saturado de nombres de tipos.

Esta característica en C# 14 alinea la sintaxis de las lambdas con la comodidad de la inferencia de tipos presente en otras partes del lenguaje. Ahora puedes escribir lambdas con `ref` y otros modificadores de una forma más natural, similar a cómo has podido omitir tipos en lambdas durante años cuando no había modificadores de por medio. Solo recuerda que si necesitas un arreglo `params` en una lambda, todavía tendrás que escribir el tipo como antes.

## Referencias

-   [Novedades en C# 14 | Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/csharp-14)
-   [Parámetros simples de lambda con modificadores | Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-14.0/simple-lambda-parameters-with-modifiers)
-   [Novedades en C# 14 | StartDebugging.NET](/2024/12/csharp-14/)
