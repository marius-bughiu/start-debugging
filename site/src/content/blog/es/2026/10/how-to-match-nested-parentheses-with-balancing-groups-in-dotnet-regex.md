---
title: "Cómo hacer coincidir paréntesis anidados y etiquetas balanceadas con grupos de equilibrio en regex de .NET"
description: "Los grupos de equilibrio (?<name>) y (?<-name>) convierten un grupo de captura de regex de .NET en una pila, de modo que un solo patrón puede coincidir con paréntesis o etiquetas <div> anidados a cualquier profundidad. El patrón completo, cómo funciona la pila, la captura del contenido interno con (?<inner-open>) y las trampas verificadas en .NET 11 RC1: la comprobación de pila vacía, el backtracking catastrófico, NonBacktracking y los tipos de corchetes mezclados."
pubDate: 2026-10-10
template: how-to
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "regex"
  - "how-to"
lang: "es"
translationOf: "2026/10/how-to-match-nested-parentheses-with-balancing-groups-in-dotnet-regex"
translatedBy: "claude"
translationDate: 2026-10-10
---

**Respuesta corta:** en .NET, cada grupo de captura mantiene una pila de sus capturas, y un grupo de equilibrio te permite hacer push y pop sobre esa pila desde dentro del patrón. `(?<depth>)` hace push al encontrar un paréntesis de apertura, `(?<-depth>)` hace pop al encontrar uno de cierre, y el condicional `(?(depth)(?!))` al final hace fallar la coincidencia si queda algo en la pila. En conjunto, `\((?>[^()]+|\((?<depth>)|\)(?<-depth>))*(?(depth)(?!))\)` coincide con un grupo entre paréntesis completo y anidado a cualquier profundidad. Todos los ejemplos de abajo se ejecutaron en .NET 11 RC1 (`11.0.100-rc.1.26425.128`), pero la característica está en `System.Text.RegularExpressions` sin cambios desde .NET Framework 1.0, así que los patrones funcionan también en .NET 8, 9 y 10.

La mayoría de los motores de regex no pueden hacer esto en absoluto. Las expresiones regulares clásicas describen lenguajes regulares, y los "paréntesis balanceados" son el ejemplo de manual de un lenguaje que no es regular: necesitas un contador, y un autómata finito no tiene ninguno. PCRE y Perl lo resuelven con recursión (`(?R)`). .NET tomó otro camino y te da la pila directamente. Una vez que ves la pila, la sintaxis deja de parecer ruido de línea.

## Por qué `\(.*\)` y `\(.*?\)` dan la respuesta incorrecta

Toma la entrada `f(a(b)c) + g(d)` y prueba los dos patrones a los que todos recurren primero:

```csharp
// .NET 11, C# 14
using System.Text.RegularExpressions;

var input = "f(a(b)c) + g(d)";

Console.WriteLine(Regex.Match(input, @"\(.*\)").Value);
// (a(b)c) + g(d)    greedy: runs to the LAST ')'

Console.WriteLine(Regex.Match(input, @"\(.*?\)").Value);
// (a(b)             lazy: stops at the FIRST ')'
```

Ninguno es "el `)` que corresponde". El voraz se traga dos grupos separados, el perezoso corta el grupo anidado por la mitad. Lo que realmente quieres es "el `)` en el que la cantidad de aperturas menos la de cierres vuelve a cero", y eso requiere contar. Ese contador es lo que te dan los grupos de equilibrio.

## Cómo un grupo de captura de .NET se convierte en una pila

Cuando un grupo con nombre participa en una coincidencia más de una vez (por ejemplo, dentro de un bucle `*`), .NET no descarta las capturas anteriores. `Match.Groups["name"].Captures` las contiene todas, en orden, y el motor trata la más reciente como la cima de una pila. Por eso las referencias inversas como `\k<name>` siempre ven la última captura.

La sintaxis de los grupos de equilibrio manipula esa pila:

| Sintaxis | Efecto |
|---|---|
| `(?<open>...)` | Captura con nombre normal. Hace push de una captura en la pila de `open`. `(?<open>)` con cuerpo vacío hace push de una captura de ancho cero, que funciona como un simple incremento de contador. |
| `(?<-open>...)` | Hace pop de la captura superior de la pila de `open`. Si la pila está vacía, esta alternativa **falla** y el motor retrocede. |
| `(?<inner-open>...)` | Hace pop de `open` y hace push en `inner` de una captura que abarca desde el final de la captura extraída hasta el inicio de la posición actual. Así se obtiene el contenido entre un par que coincide. |
| `(?(open)yes\|no)` | Condicional: toma la rama `yes` si `open` tiene al menos una captura en su pila. |
| `(?!)` | Un lookahead negativo vacío. Nunca puede tener éxito, así que significa "falla aquí". |

Las formas con comilla simple `(?'open')`, `(?'-open')` y `(?'inner-open')` son idénticas; existen para que puedas escribir patrones dentro de atributos XML sin escapar los corchetes angulares. Los grupos numerados también funcionan: `(?<-1>\))` hace pop del grupo 1.

Una regla de análisis: el grupo del que haces pop debe existir en alguna parte del patrón. `^\)(?<-d>)` por sí solo lanza `RegexParseException: Reference to undefined group name 'd'` desde el constructor de `Regex`, no una coincidencia fallida.

## Coincidir con un grupo de paréntesis balanceado, paso a paso

Este es el patrón canónico, escrito con `RegexOptions.IgnorePatternWhitespace` para poder incluir comentarios:

```csharp
// .NET 11, C# 14
using System.Text.RegularExpressions;

var balanced = new Regex(@"
    \(                      # the outer opening paren
    (?>
        [^()]+              # a run of anything that is not a paren
      | \( (?<depth>)       # an inner '(' pushes onto 'depth'
      | \) (?<-depth>)      # an inner ')' pops 'depth' (fails if empty)
    )*
    (?(depth)(?!))          # if 'depth' is not empty, fail
    \)                      # the outer closing paren
", RegexOptions.IgnorePatternWhitespace);

foreach (Match m in balanced.Matches("f(a(b)c) + g(d) + h((x)"))
    Console.WriteLine($"{m.Value} @{m.Index}");

// (a(b)c) @1
// (d) @12
// (x) @20
```

Recorramos `(a(b)c)`:

1. El literal `\(` consume el `(` exterior. La pila `depth` está vacía.
2. `[^()]+` consume `a`.
3. El `(` interior cae en la segunda alternativa, y `(?<depth>)` hace push de una captura. La profundidad es 1.
4. `[^()]+` consume `b`.
5. El `)` cae en la tercera alternativa, y `(?<-depth>)` hace pop. La profundidad es 0.
6. `[^()]+` consume `c`.
7. El `)` final sería extraído por la tercera alternativa, pero la pila está vacía, así que `(?<-depth>)` falla. El bucle termina y devuelve ese `)`.
8. `(?(depth)(?!))` ve una pila vacía y no toma ninguna rama, así que tiene éxito.
9. El literal `\)` consume el `)` exterior. Coincidencia.

El paso 7 es el sutil. Que el pop falle con la pila vacía es lo que impide que el bucle se coma el paréntesis de cierre exterior, así que el patrón se detiene de forma natural en el `)` correcto.

Fíjate en la última entrada, `h((x)`. El primer `(` nunca se cierra, así que ninguna coincidencia puede empezar ahí. El motor avanza, empieza en el segundo `(` y devuelve el `(x)` bien formado en el índice 20. Eso suele ser lo que quieres cuando buscas grupos completos en un texto.

## Por qué la comprobación `(?(depth)(?!))` no es opcional

Es tentador quitar el condicional porque el `\(...\)` exterior parece delimitar todo. No es así. Compara los dos patrones con `((a)`:

```csharp
// .NET 11, C# 14
var noCheck   = new Regex(@"\((?>[^()]+|\((?<d>)|\)(?<-d>))*\)");
var withCheck = new Regex(@"\((?>[^()]+|\((?<d>)|\)(?<-d>))*(?(d)(?!))\)");

Console.WriteLine(noCheck.Match("((a)").Value);    // ((a)   unbalanced!
Console.WriteLine(withCheck.Match("((a)").Value);  // (a)
```

Sin la comprobación, el `\(` exterior toma el primer `(`, el bucle hace push del segundo `(`, consume `a` y hace pop con el `)`. Ahora el `\)` final no tiene nada que coincidir, así que el motor retrocede: el bucle devuelve su última iteración (deshaciendo el pop), y el `\)` final toma ese `)` en su lugar. La coincidencia tiene éxito con un `(` todavía en la pila. La pila solo impone "nunca cierres más de lo que abriste". "Cierra todo lo que abriste" es trabajo del condicional.

## Validar que una cadena completa está balanceada

Para responder "¿está balanceada esta cadena?" en lugar de "encuentra grupos balanceados en ella", ancla ambos extremos y quita los paréntesis literales exteriores:

```csharp
// .NET 11, C# 14
var valid = new Regex(@"^(?>[^()]+|\((?<d>)|\)(?<-d>))*(?(d)(?!))$");

foreach (var s in new[] { "a(b(c)d)e", "a(b(c)d", "a)b(c", "", "())(" })
    Console.WriteLine($"'{s}': {valid.IsMatch(s)}");

// 'a(b(c)d)e': True
// 'a(b(c)d': False    one '(' left on the stack
// 'a)b(c': False      ')' with an empty stack
// '': True
// '())(': False
```

## Capturar el contenido entre cada par que coincide

La forma de dos nombres `(?<inner-open>\))` hace pop de `open` y registra el texto entre el `(` extraído y el `)` actual como una captura de `inner`. Obtienes el contenido de cada nivel anidado, empezando por el más interno:

```csharp
// .NET 11, C# 14
var inner = new Regex(@"(?>[^()]+|(?<open>\()|(?<inner-open>\)))*(?(open)(?!))");

Match m = inner.Match("x(a(b)c)(d)");
foreach (Capture c in m.Groups["inner"].Captures)
    Console.WriteLine($"{c.Value} @{c.Index}");

// b @4
// a(b)c @2
// d @9
```

El orden es el orden en que los pares se **cierran**, por eso `b` viene antes que `a(b)c`. Si solo necesitas los grupos más externos, filtra comprobando que ninguna otra captura contenga el rango de esta, o vuelve al patrón de un solo grupo de la sección anterior y usa `Matches`.

## Coincidir con etiquetas `<div>` anidadas

La misma estructura sirve para cualquier par de delimitadores, incluidos los de varios caracteres. El único cambio es la rama de "cualquier otra cosa": en lugar de una clase de caracteres, usa `(?!</?div\b).` para que consuma un carácter a la vez pero nunca el inicio de una etiqueta `div` de apertura o de cierre.

```csharp
// .NET 11, C# 14
var divs = new Regex(@"
    <div\b[^>]*>
    (?>
        <div\b[^>]*>  (?<depth>)
      | </div>        (?<-depth>)
      | (?!</?div\b) .
    )*
    (?(depth)(?!))
    </div>",
    RegexOptions.IgnorePatternWhitespace | RegexOptions.Singleline | RegexOptions.IgnoreCase);

var html = "<p>x</p><div class=\"a\">1<div>2</div>3</div><div>4</div>";
foreach (Match m in divs.Matches(html))
    Console.WriteLine(m.Value);

// <div class="a">1<div>2</div>3</div>
// <div>4</div>
```

`RegexOptions.Singleline` importa aquí: sin ella, `.` no coincide con `\n` y el patrón falla en silencio con cualquier `div` que abarque varias líneas.

Esto sirve para fragmentos de plantillas, salida de registros o marcado que generas tú mismo. No es un analizador de HTML. Los comentarios que contienen `<div>`, los atributos que contienen `>`, CDATA y los elementos void sin cerrar lo engañarán. Para HTML del mundo real, usa AngleSharp o HtmlAgilityPack.

## Trampas con las que te vas a topar

### Olvidar el grupo atómico causa backtracking catastrófico

El `(?>...)` alrededor de la alternancia no es decoración. Si escribes `(?:...)` y `[^()]*` en lugar de `[^()]+`, el motor puede dividir una serie de caracteres simples de un número exponencial de maneras cuando la coincidencia falla, y las probará todas antes de rendirse. Lo medí en .NET 11 RC1 con un timeout de coincidencia de 2 segundos y una entrada de 29 caracteres:

```csharp
// .NET 11, C# 14
var input = "(" + new string('a', 25) + "(((";
var timeout = TimeSpan.FromSeconds(2);

var bad  = new Regex(@"^\((?:[^()]*|\((?<d>)|\)(?<-d>))*(?(d)(?!))\)$", RegexOptions.None, timeout);
var good = new Regex(@"^\((?>[^()]+|\((?<d>)|\)(?<-d>))*(?(d)(?!))\)$", RegexOptions.None, timeout);

// bad.IsMatch(input)  -> RegexMatchTimeoutException after 2000 ms
// good.IsMatch(input) -> False in 0 ms
```

Dos correcciones, usa ambas: envuelve la alternancia en `(?>...)` para que cada iteración se comprometa con lo que consumió, y usa `+` en lugar de `*` dentro de un bucle para que una iteración nunca pueda coincidir vacía. Si el patrón se ejecuta sobre entrada no confiable, pasa también un timeout de coincidencia o define `REGEX_DEFAULT_MATCH_TIMEOUT` para el dominio de la aplicación.

### `RegexOptions.NonBacktracking` rechaza los grupos de equilibrio

El motor de tiempo lineal añadido en .NET 7 no tiene pilas, así que rechaza estos patrones en el constructor:

```text
System.NotSupportedException: RegexOptions.NonBacktracking is not supported in
conjunction with expressions containing: 'balancing group (?<name1-name2>subexpression)
or (?'name1-name2' subexpression)'.
```

Rechaza los grupos atómicos `(?>...)` y los condicionales sobre grupos de captura `(?(name)...)` con la misma excepción, así que no puedes esquivarlo reescribiendo. Si necesitas tiempo lineal garantizado con entrada hostil, escribe en su lugar el bucle de pila de 15 líneas que se muestra más abajo. El equipo de OpenTelemetry cayó en una trampa relacionada con este motor, que se cubre en [el análisis de la excepción NotSupportedException con comodines en OpenTelemetry .NET 1.19.1](/es/2026/09/opentelemetry-dotnet-1-19-1-fixes-wildcard-notsupportedexception-on-net-8/).

### `[GeneratedRegex]` funciona sin problemas

El generador de código fuente admite grupos de equilibrio, grupos atómicos y condicionales, así que puedes mover estos patrones a tiempo de compilación sin cambios:

```csharp
// .NET 11, C# 14
using System.Text.RegularExpressions;

Console.WriteLine(Patterns.Call().Match("call(foo(1, bar(2)), 3);").Value);
// call(foo(1, bar(2)), 3)

static partial class Patterns
{
    [GeneratedRegex(@"\w+\((?>[^()]+|\((?<d>)|\)(?<-d>))*(?(d)(?!))\)")]
    public static partial Regex Call();
}
```

Si todavía no has migrado, [la guía para reemplazar new Regex(...) por [GeneratedRegex]](/es/2026/08/how-to-replace-new-regex-with-the-generatedregex-source-generator-in-dotnet-11/) cubre el analizador y la corrección de código que lo hacen por ti.

### Pilas separadas no imponen el orden de los corchetes

La extensión obvia a `()`, `[]` y `{}` es una pila por cada tipo de corchete:

```csharp
// .NET 11, C# 14
var multi = new Regex(@"^(?>
      [^()\[\]{}]+
    | (?<p>\() | (?<-p>\))
    | (?<b>\[) | (?<-b>\])
    | (?<c>\{) | (?<-c>\})
  )*(?(p)(?!))(?(b)(?!))(?(c)(?!))$", RegexOptions.IgnorePatternWhitespace);

Console.WriteLine(multi.IsMatch("{[()]}"));  // True
Console.WriteLine(multi.IsMatch("(]"));      // False
Console.WriteLine(multi.IsMatch("{[(])}"));  // True   <- wrong
```

Cada pila cuenta correctamente su propio tipo, pero nada las une, así que `{[(])}` pasa: el `]` hace pop de la pila `b` aunque el último abridor fuera `(`. Imponer un entrelazado correcto requiere saber qué tipo está en la cima de una única pila compartida, y ahí es donde la regex deja de ser la herramienta adecuada. Un `Stack<char>` simple lo resuelve en una sola pasada, y cualquiera puede leerlo:

```csharp
// .NET 11, C# 14
static bool IsBalanced(ReadOnlySpan<char> s)
{
    var stack = new Stack<char>();
    foreach (char ch in s)
    {
        switch (ch)
        {
            case '(' or '[' or '{': stack.Push(ch); break;
            case ')': if (!stack.TryPop(out var a) || a != '(') return false; break;
            case ']': if (!stack.TryPop(out var b) || b != '[') return false; break;
            case '}': if (!stack.TryPop(out var c) || c != '{') return false; break;
        }
    }
    return stack.Count == 0;
}

// IsBalanced("{[()]}") -> True
// IsBalanced("{[(])}") -> False
```

Si la ruta crítica solo necesita encontrar el siguiente corchete en una cadena larga, [SearchValues<char> con IndexOfAny](/es/2026/04/how-to-use-searchvalues-correctly-in-dotnet-11/) es la forma rápida de saltar los tramos de texto plano entre ellos.

### Comillas y escapes dentro de los corchetes

`f("(", x)` contiene un `(` sin balancear dentro de un literal de cadena. Para saltar las cadenas entre comillas, añade una alternativa antes de las demás que consuma una cadena completa, por ejemplo `"(?:[^"\\]|\\.)*"`, y excluye `"` de la clase "cualquier otra cosa": `[^()"]+`. Cada regla léxica adicional (comentarios, literales de carácter, cadenas verbatim) es otra alternativa, y pasadas dos o tres de ellas un tokenizador escrito a mano es más fácil de mantener.

### Anclas basadas en líneas

Si validas entrada de varias líneas con `^...$` y `RegexOptions.Multiline`, recuerda que `$` solo reconoce `\n` por defecto. [RegexOptions.AnyNewLine de .NET 11](/es/2026/04/regex-anynewline-dotnet-11-preview-3/) resuelve los casos de `\r\n` y de separadores de línea Unicode sin trucos con `\r?`.

## Cuándo recurrir a los grupos de equilibrio

Los grupos de equilibrio son la herramienta adecuada cuando ya estás en un problema con forma de regex: una búsqueda y reemplazo sobre archivos de código fuente, un filtro de registros, un atributo de validación, el diálogo de búsqueda de un editor que acepta patrones de .NET. Permiten que una sola expresión maneje un anidamiento que de otro modo te obligaría a escribir un analizador. Cuando necesites orden entre varios tipos de corchetes, manejo de escapes o posiciones de error ("`)` inesperado en la columna 14"), escribe el bucle. La pila que estabas simulando dentro de la regex es una línea en C#.

## Fuentes

- [Grouping constructs: balancing group definitions](https://learn.microsoft.com/en-us/dotnet/standard/base-types/grouping-constructs-in-regular-expressions#balancing-group-definitions), MS Learn
- [Alternation constructs: conditional matching with a named group](https://learn.microsoft.com/en-us/dotnet/standard/base-types/alternation-constructs-in-regular-expressions), MS Learn
- [Regular expression options: NonBacktracking mode](https://learn.microsoft.com/en-us/dotnet/standard/base-types/regular-expression-options#nonbacktracking-mode), MS Learn
- [Backtracking in regular expressions](https://learn.microsoft.com/en-us/dotnet/standard/base-types/backtracking-in-regular-expressions), MS Learn
- [.NET regular expression source generators](https://learn.microsoft.com/en-us/dotnet/standard/base-types/regular-expression-source-generators), MS Learn
