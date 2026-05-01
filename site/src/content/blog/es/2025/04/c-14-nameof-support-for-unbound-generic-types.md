---
title: "C# 14: soporte de nameof para tipos genéricos no enlazados"
description: "C# 14 mejora la expresión nameof para admitir tipos genéricos no enlazados como List<> y Dictionary<,>, eliminando la necesidad de argumentos de tipo de relleno."
pubDate: 2025-04-07
tags:
  - "csharp-14"
  - "csharp"
  - "dotnet"
  - "dotnet-10"
lang: "es"
translationOf: "2025/04/c-14-nameof-support-for-unbound-generic-types"
translatedBy: "claude"
translationDate: 2026-05-01
---
C# 14 introduce varias mejoras pequeñas pero útiles al lenguaje. Una de estas nuevas características es una mejora a la expresión `nameof`: ahora admite _tipos genéricos no enlazados_. En términos sencillos, ya no necesitas insertar un argumento de tipo de relleno solo para obtener el nombre de un tipo genérico. Esta actualización elimina una pequeña molestia que los desarrolladores de C# enfrentaban desde hace años y hace que el código que usa `nameof` sea más limpio y fácil de mantener.

## Qué son los tipos genéricos no enlazados

En C#, un _tipo genérico_ es una clase o struct que tiene parámetros de tipo (por ejemplo, `List<T>` o `Dictionary<TKey, TValue>`). Un **tipo genérico no enlazado** es la propia definición del tipo genérico, sin argumentos de tipo específicos suministrados. Puedes reconocer un genérico no enlazado por los corchetes angulares vacíos (como `List<>`) o por las comas dentro de los corchetes angulares que indican el número de parámetros de tipo (como `Dictionary<,>` para dos parámetros de tipo). Representa el tipo genérico _en general_, sin decir cuáles son `T` o `TKey`/`TValue`. No podemos instanciar un tipo genérico no enlazado directamente porque no está totalmente especificado, pero sí podemos usarlo en ciertos contextos (como reflection a través de `typeof`). Por ejemplo, `typeof(List<>)` devuelve un objeto `System.Type` para el tipo genérico abierto `List`.

Antes de C# 14, el lenguaje **no** permitía usar tipos genéricos no enlazados en la mayoría de las expresiones. Aparecían principalmente en escenarios de reflection o atributos. Si querías referirte a un tipo genérico por nombre en el código, normalmente tenías que suministrar argumentos de tipo concretos, convirtiéndolo así en un tipo genérico _cerrado_. Por ejemplo, `List<int>` o `Dictionary<string, int>` son _tipos genéricos cerrados_ porque todos sus parámetros de tipo están especificados. Hasta ahora, los desarrolladores de C# a menudo elegían un tipo arbitrario (como `object` o `int`) solo para satisfacer la sintaxis cuando lo único que querían era el nombre del tipo genérico.

## Cómo funcionaba `nameof` antes de C# 14

La expresión `nameof` es una característica de tiempo de compilación que produce el nombre de una variable, tipo o miembro como una cadena. Se usa habitualmente para evitar codificar identificadores en cadenas (por ejemplo, para validación de argumentos o notificaciones de cambio de propiedad). Antes de C# 14, `nameof` tenía una limitación al trabajar con genéricos: **no** podías usar un tipo genérico no enlazado como argumento. El argumento de `nameof` debía ser una expresión válida o un identificador de tipo en el código, lo que significaba que los tipos genéricos necesitaban argumentos de tipo concretos. En la práctica, esto significaba que para obtener el nombre de un tipo genérico tenías que proveer un parámetro de tipo ficticio.

Por ejemplo, supón que quieres obtener la cadena `"List"` (el nombre de la clase genérica `List<T>`). En C# 13 o anteriores, tendrías que escribir algo como:

```cs
string typeName = nameof(List<int>);  // evaluates to "List"
```

Aquí usamos `List<int>` con un argumento de tipo arbitrario (`int`), aunque la elección del tipo es irrelevante para el resultado. Si intentabas usar una forma no enlazada como `List<>` sin un argumento de tipo, el código no compilaba. El compilador se quejaba con un error sobre "nombre genérico no enlazado" o similar, porque no se permitía en un contexto que esperaba una expresión. En otras palabras, _tenías_ que especificar un parámetro de tipo para que fuera una expresión válida para `nameof`, aunque `nameof` finalmente ignora el argumento de tipo y solo se preocupa por el nombre `"List"`.

Este requisito era simplemente una peculiaridad de las reglas del lenguaje. Podía conducir a código incómodo o frágil. Por ejemplo, los desarrolladores a menudo usaban un marcador de posición como `object` o `int` para el parámetro de tipo solo para usar `nameof`. Si más adelante el tipo genérico recibía una nueva restricción (por ejemplo, que `T` tuviera que ser un tipo de referencia o heredar de cierta clase), el uso de `nameof` podía romperse porque el tipo ficticio ya no satisfacía las restricciones. En algunos casos avanzados, encontrar un tipo adecuado para insertar no era trivial (por ejemplo, si `T` estaba restringido a una clase interna o a una interfaz que ningún tipo existente implementaba, tenías que crear una clase ficticia solo para satisfacer el parámetro genérico y poder usar `nameof`). Todo esto era una molestia adicional para algo que en realidad no afecta al resultado de `nameof`.

## `nameof` con genéricos no enlazados en C# 14

C# 14 corrige este problema permitiendo que los tipos genéricos no enlazados se usen directamente en expresiones `nameof`. Ahora, el argumento de `nameof` puede ser una definición de tipo genérico sin especificar sus parámetros de tipo. El resultado es exactamente el que esperarías: `nameof` devuelve el nombre del tipo genérico. Esto significa que por fin puedes escribir `nameof(List<>)` y obtener la cadena `"List"` sin necesidad de ningún argumento de tipo ficticio.

Para ilustrar el cambio, comparemos cómo obtendríamos el nombre de un tipo genérico antes y después de C# 14:

**Antes de C# 14:**

```cs
// Using a closed generic type (with a type argument) to get the name:
Console.WriteLine(nameof(List<int>));    // Output: "List"

// The following was not allowed in C# 13 and earlier – it would cause a compile error:
// Console.WriteLine(nameof(List<>));    // Error: Unbound generic type not allowed
```

**En C# 14 y posteriores:**

```cs
// We can use an unbound generic type directly:
Console.WriteLine(nameof(List<>));       // Output: "List"
Console.WriteLine(nameof(Dictionary<,>)); // Output: "Dictionary"
```

Como se muestra arriba, `nameof(List<>)` ahora se evalúa como `"List"`, y de manera similar `nameof(Dictionary<,>)` da `"Dictionary"`. Ya no necesitamos proveer un argumento de tipo falso solo para usar `nameof` con un tipo genérico.

Esta mejora no se limita solo a obtener el nombre del tipo en sí. También puedes usarla para obtener los nombres de los miembros de un tipo genérico no enlazado, igual que harías sobre un tipo normal. Por ejemplo, `nameof(List<>.Count)` ahora es una expresión válida en C# 14, y producirá la cadena `"Count"`. En versiones anteriores habrías tenido que escribir `nameof(List<int>.Count)` u otro tipo concreto en lugar de `<int>` para lograr el mismo resultado. C# 14 te permite omitir los argumentos de tipo también en estos contextos. En general, en cualquier lugar donde uses `nameof(SomeGenericType<...>.MemberName)`, ahora puedes dejar el tipo genérico sin enlazar si no tienes un tipo específico que usar o no quieres comprometerte con uno.

Vale la pena destacar que esta característica trata puramente de comodidad y claridad del código. La salida de la expresión `nameof` no ha cambiado: sigue siendo solo el nombre del identificador. Lo que cambió es que las reglas del lenguaje ahora permiten un conjunto más amplio de entradas para `nameof`. Esto pone a `nameof` en línea con `typeof`, que ya admitía tipos genéricos abiertos. En esencia, el lenguaje C# está reconociendo que especificar un parámetro de tipo en estos casos era un requisito innecesario desde el principio.

## Por qué es útil

Permitir tipos genéricos no enlazados en `nameof` puede parecer un ajuste pequeño, pero tiene varios beneficios prácticos:

-   **Código más limpio y claro:** Ya no tienes que insertar argumentos de tipo irrelevantes en tu código solo para satisfacer al compilador. `nameof(List<>)` expresa con claridad "quiero el nombre del tipo genérico `List`", mientras que `nameof(List<int>)` podría hacer que un lector se pregunte por un momento "¿por qué `int`?". Eliminar el ruido hace que la intención del código sea más evidente.
-   **Sin tipos ficticios ni soluciones improvisadas:** En el código previo a C# 14, los desarrolladores a menudo usaban tipos de relleno como `object` o creaban implementaciones ficticias para usar `nameof` con genéricos. Eso ya no es necesario. Tu código puede referirse directamente al nombre del tipo genérico sin ninguna solución improvisada, reduciendo el desorden y las dependencias raras.
-   **Mejor mantenibilidad:** Usar genéricos no enlazados en `nameof` hace que tu código sea menos frágil ante los cambios. Si el tipo genérico gana nuevas restricciones de parámetro de tipo u otras modificaciones, no tendrás que revisar cada uso de `nameof` para asegurarte de que el argumento de tipo elegido siga encajando. Por ejemplo, si tenías `nameof(MyGeneric<object>)` y luego `MyGeneric<T>` añade una restricción `where T : struct`, ese código ya no compilaría. Con `nameof(MyGeneric<>)`, seguirá funcionando independientemente de tales cambios, ya que no depende de ningún argumento de tipo específico.
-   **Consistencia con otras características del lenguaje:** Este cambio hace que `nameof` sea más consistente con cómo funcionan otras características de metaprogramación como `typeof`. Como ya podías hacer `typeof(GenericType<>)` para obtener por reflection un tipo genérico abierto, es intuitivo que también puedas hacer `nameof(GenericType<>)` para obtener su nombre. Ahora el lenguaje se siente más consistente y lógico.
-   **Comodidad menor en escenarios de reflection o generación de código:** Si escribes bibliotecas o frameworks que manejan tipos y nombres (por ejemplo, generando documentación, mensajes de error o haciendo binding de modelos donde registras nombres de tipo), ahora puedes recuperar los nombres de tipos genéricos de forma más directa. Es una comodidad menor, pero puede simplificar código que construye cadenas de nombres de tipo o usa `nameof` para registro y excepciones que involucran clases genéricas.

## Lo que cambia para tu código

El soporte para tipos genéricos no enlazados en la expresión `nameof` es una mejora bienvenida en C# 14 que hace que el lenguaje sea un poco más amigable para el desarrollador. Al permitir construcciones como `nameof(List<>)`, C# elimina una vieja molestia y deja que los desarrolladores expresen su intención sin código innecesario. Este cambio beneficia a todos los usuarios de C#: los principiantes pueden evitar la confusión al usar `nameof` con genéricos, y los desarrolladores experimentados obtienen un código más optimizado y resistente a futuros cambios. Es un gran ejemplo del equipo de C# abordando un "papercut" del lenguaje y mejorando la consistencia. A medida que adoptes C# 14, ten esta característica en mente cuando necesites el nombre de un tipo genérico, y disfruta escribiendo código más limpio y conciso.

## Referencias

1.  [What's new in C# 14 | Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/csharp-14#:~:text=Beginning%20with%20C,name)
2.  [Generics and attributes – C# | Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/advanced-topics/reflection-and-attributes/generics-and-attributes#:~:text=constructed%20generic%20types%2C%20not%20on,Dictionary)
3.  [The nameof expression – evaluate the text name of a symbol – C# reference | Microsoft Learn](https://msdn.microsoft.com/en-us/library/dn986596.aspx#:~:text=Console.WriteLine%28nameof%28List,%2F%2F%20output%3A%20List)
4.  [Unbound generic types in `nameof` – C# feature specifications (preview) | Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-14.0/unbound-generic-types-in-nameof#:~:text=Motivation)
5.  [What's new in C# 14 | StartDebugging.NET](/2024/12/csharp-14/)
