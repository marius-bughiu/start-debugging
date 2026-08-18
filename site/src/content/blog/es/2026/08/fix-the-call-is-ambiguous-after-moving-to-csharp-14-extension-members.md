---
title: "Fix: The call is ambiguous between the following methods or properties tras migrar a miembros de extensión de C# 14"
description: "CS0121 tras mover un método de extensión a un bloque extension de C# 14: el compilador sigue emitiendo la forma estática antigua. Borra el duplicado o califica la llamada."
pubDate: 2026-08-18
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-14"
  - "dotnet-10"
  - "extension-members"
lang: "es"
translationOf: "2026/08/fix-the-call-is-ambiguous-after-moving-to-csharp-14-extension-members"
translatedBy: "claude"
translationDate: 2026-08-18
---

Moviste un método de extensión con parámetro `this` a un bloque `extension` de C# 14, dejaste el original "por si acaso", y ahora cada punto de llamada falla con CS0121. El arreglo es borrar una de las dos declaraciones, porque no son dos cosas distintas: el compilador reduce un método de bloque de extensión exactamente al mismo método estático con parámetro `this` que ya tenías. Si no puedes borrar ninguna de las dos (la otra vive en un paquete NuGet), califica la llamada con la clase estática contenedora: `MyExtensions.WordCount(s)` en lugar de `s.WordCount()`.

```
error CS0121: The call is ambiguous between the following methods or properties:
'New.StringExtensions2.extension(string).WordCount()' and 'Old.StringExtensions.WordCount(string)'
```

Fíjate en la forma del mensaje. Un candidato se imprime como `extension(string).WordCount()` y el otro como `WordCount(string)`. Esa asimetría es todo el diagnóstico: Roslyn te está diciendo que un candidato vino de un bloque de extensión y el otro de un método clásico con parámetro `this`, y no puede elegir entre ellos. Todo lo que sigue fue verificado en el SDK de .NET 10.0.201 con `<LangVersion>14.0</LangVersion>`.

## ¿Por qué se dispara CS0121 cuando ambas sintaxis están en ámbito?

C# 14 no introdujo un segundo mecanismo de búsqueda separado para los miembros de extensión. Un bloque de extensión es una sintaxis de declaración, y el compilador lo reduce a un miembro de clase estática indistinguible de lo que produce `this string s`. Cuando dos directivas `using` traen cada una una clase al ámbito y ambas clases aportan un candidato `WordCount(string)` con aplicabilidad idéntica, la resolución de sobrecarga se queda sin criterio de desempate, así que reporta CS0121.

Esta no es una regla nueva. El mismo error siempre se ha disparado cuando dos bibliotecas definen el mismo método de extensión sobre el mismo tipo. Lo nuevo es que migrar tu propio código ahora crea la colisión, porque una migración a medias deja ambas formas vivas al mismo tiempo.

## ¿Qué emite realmente el compilador para un bloque de extensión?

Esta es la parte que vale la pena interiorizar, porque explica todos los síntomas de esta página. Toma un solo bloque con un método y una propiedad:

```csharp
// .NET 10.0.201, C# 14
namespace Lib;

public static class StringExtensions
{
    extension(string s)
    {
        public int WordCount() => s.Split(' ').Length;
        public bool IsBlank => string.IsNullOrWhiteSpace(s);
    }
}
```

Usar reflexión sobre el `Lib.StringExtensions` compilado en la misma solución imprime:

```
METHOD Int32 WordCount(String s) [Extension]
METHOD Boolean get_IsBlank(String s)
NESTED <G>$34505F560D9EACF86A87F3ED1F85E448 ext-attr=True
CLASS ext-attr=True
```

De ese volcado salen tres cosas:

1. `WordCount` se emite como un método estático público que toma el receptor como primer parámetro, con `[ExtensionAttribute]`. *Es* un método de extensión clásico en los metadatos. Por eso choca con un método `this` escrito a mano, y por eso escribir ambos es un duplicado y no una capa de compatibilidad.
2. La propiedad se reduce a `get_IsBlank(String s)`, un método estático público **sin** `[ExtensionAttribute]`. Las propiedades no son métodos de extensión clásicos, así que se encuentran por una ruta de búsqueda distinta y fallan con un diagnóstico diferente (ver más abajo).
3. El tipo anidado `<G>$<hash>` es el tipo marcador basado en contenido que el compilador genera por cada bloque de extensión. El hash deriva del contenido del bloque, y por eso dos bloques con receptores y miembros idénticos en la misma clase chocan con CS9329.

Como el método reducido realmente es un método de extensión normal, un proyecto fijado a `<LangVersion>13.0</LangVersion>` todavía puede consumirlo. Verifiqué esto con una referencia de proyecto desde una app en C# 13 hacia una biblioteca en C# 14: `"a b c".WordCount()` y `StringExtensions.WordCount("a b c")` compilan e imprimen `3`. Añadir `"a b c".IsBlank` al mismo archivo falla con `error CS9260: Feature 'extensions' is not available in C# 13.0`. Los *métodos* de extensión declarados en un bloque se pueden consumir desde versiones de lenguaje antiguas; las *propiedades* de extensión no.

## Reproducción mínima: dos clases estáticas, un nombre de método

```csharp
// Old.cs -- .NET 10.0.201, C# 14
namespace Old;

public static class StringExtensions
{
    public static int WordCount(this string s) => s.Split(' ').Length;
}
```

```csharp
// New.cs -- .NET 10.0.201, C# 14
namespace New;

public static class StringExtensions2
{
    extension(string s)
    {
        public int WordCount() => s.Split(' ').Length;
    }
}
```

```csharp
// Use.cs -- .NET 10.0.201, C# 14
using Old;
using New;

System.Console.WriteLine("a b c".WordCount()); // CS0121
```

`dotnet build` falla en el punto de llamada, no en ninguna de las declaraciones. Eso importa: las declaraciones son legales por separado, así que el error solo aparece en archivos que importan ambos espacios de nombres. Por eso una solución migrada parcialmente compilará en algunos proyectos y fallará en otros, lo que parece una compilación inestable hasta que miras las listas de `using`.

Lo mismo pasa entre ensamblados, que es la versión que la mayoría de la gente encuentra de verdad. Una biblioteca publica bloques de extensión, tú conservas un adaptador local con método `this` que escribiste antes de la actualización, y cualquier archivo que importe ambos espacios de nombres se rompe:

```
error CS0121: The call is ambiguous between the following methods or properties:
'Lib.StringExtensions.extension(string).WordCount()' and 'App.Compat.MyStringExtensions.WordCount(string)'
```

## ¿Cómo arreglo CS0121 cuando soy dueño de ambas declaraciones?

Borra la versión con parámetro `this`. Ese es todo el arreglo, y no es una concesión: como se mostró arriba, el bloque de extensión sigue emitiendo un método estático marcado con `[ExtensionAttribute]` con la firma idéntica, así que todos los puntos de llamada existentes siguen funcionando, incluida la forma completamente calificada `MyExtensions.WordCount(s)` y los consumidores en versiones de lenguaje antiguas.

```csharp
// .NET 10.0.201, C# 14 -- one declaration, both call shapes still work
namespace Lib;

public static class StringExtensions
{
    extension(string s)
    {
        public int WordCount() => s.Split(' ').Length;
    }
}

// both of these compile:
// "a b c".WordCount()
// StringExtensions.WordCount("a b c")
```

La regla de migración para escribir en la pizarra: **un bloque de extensión reemplaza al método antiguo, no convive con él.** Todo instinto de "conservar el viejo por compatibilidad" está equivocado aquí, porque la compatibilidad binaria y de código fuente ya la preserva la reducción.

## ¿Cómo desambiguo cuando el duplicado vive en un paquete NuGet?

No puedes borrar una declaración que no te pertenece, así que elige una de estas, en orden de preferencia.

**Llama al método estático directamente.** Ambos candidatos exponen una forma estática, así que nombra la clase que quieres:

```csharp
// .NET 10.0.201, C# 14
System.Console.WriteLine(New.StringExtensions2.WordCount("a b c")); // extension block version
System.Console.WriteLine(Old.StringExtensions.WordCount("a b c"));  // this-parameter version
```

Esto compila limpio. Es verboso en el punto de llamada pero no es ambiguo, se puede buscar con grep y sobrevive a futuras actualizaciones de paquetes.

**Quita el `using` y cambia a un alias de espacio de nombres.** Los miembros de extensión solo entran en ámbito por un `using` simple del espacio de nombres. Un alias de espacio de nombres importa los *nombres* sin aportar candidatos de extensión:

```csharp
// .NET 10.0.201, C# 14
using OldAlias = Old; // types reachable as OldAlias.StringExtensions, but no extension candidates
using New;

System.Console.WriteLine("x".WordCount()); // binds to New, prints 2
```

Ejecuté este archivo exacto e imprime `2`. Esta es la opción más limpia cuando un archivo necesita tipos de un espacio de nombres pero no sus extensiones. Cuidado con las directivas `global using` en `GlobalUsings.cs` o los elementos `<Using Include="..."/>` en el csproj, porque esas importan extensiones en cada archivo del proyecto y son la razón habitual de que la ambigüedad aparezca en un archivo cuya propia lista de `using` parece inocente.

**Dales nombres distintos a los dos miembros.** Si eres dueño del más nuevo y aún no está publicado, renombrar sale más barato que enseñarle a todo el equipo una regla de desambiguación.

## ¿Puedo marcar el método antiguo con `[Obsolete]` para romper el empate?

No. La obsolescencia no es un criterio de desempate de la resolución de sobrecarga. El candidato sigue siendo aplicable y el error es idéntico:

```csharp
// .NET 10.0.201, C# 14 -- still CS0121
[System.Obsolete("Use Lib")]
public static int WordCount(this string s) => 1;
```

`[Obsolete]` sirve para decirle a los consumidores que dejen de llamar a algo, pero no hace nada por el conjunto de candidatos del compilador. Lo mismo vale para `[EditorBrowsable(EditorBrowsableState.Never)]`, que solo oculta miembros de IntelliSense.

## ¿Cuándo obtengo CS0111 en lugar de CS0121?

Porque ambas declaraciones están en la *misma* clase estática. Entonces no es una llamada ambigua, es un miembro duplicado:

```csharp
// .NET 10.0.201, C# 14
namespace A;

public static class E1
{
    public static int WordCount(this string s) => 1;

    extension(string s)
    {
        public int WordCount() => 2; // CS0111
    }
}
```

```
error CS0111: Type 'E1' already defines a member called 'WordCount' with the same parameter types
```

CS0111 se reporta en la declaración, antes de que exista ningún punto de llamada. Es el más amable de los dos errores porque prueba la equivalencia directamente: el compilador considera que `WordCount(this string)` y el `WordCount()` del bloque tienen los mismos tipos de parámetros. Si estás migrando una clase un método a la vez, este es el error que verás primero.

## ¿Y si la ambigüedad está en una propiedad de extensión (CS9339)?

Las propiedades de extensión tienen su propio diagnóstico, porque no son métodos con `[ExtensionAttribute]` en los metadatos y se resuelven mediante la búsqueda de miembros de extensión en lugar de la resolución de sobrecarga normal:

```csharp
// N1.cs -- .NET 10.0.201, C# 14
namespace N1;

public static class E
{
    extension(System.Text.StringBuilder b)
    {
        public int Cap { get => b.Capacity; set => b.Capacity = value; }
    }
}
```

```csharp
// N2.cs -- .NET 10.0.201, C# 14
namespace N2;

public static class E
{
    extension(System.Text.StringBuilder b)
    {
        public int Cap { get => b.Capacity; set => b.Capacity = value; }
    }
}
```

```csharp
// Use.cs -- .NET 10.0.201, C# 14
using N1;
using N2;

var sb = new System.Text.StringBuilder();
sb.Cap = 64; // CS9339
```

```
error CS9339: The extension resolution is ambiguous between the following members:
'N1.E.extension(System.Text.StringBuilder).Cap' and 'N2.E.extension(System.Text.StringBuilder).Cap'
```

El arreglo tiene la misma forma pero tienes que nombrar el descriptor de acceso, ya que no hay sintaxis de propiedad que lleve el nombre de la clase:

```csharp
// .NET 10.0.201, C# 14 -- disambiguated, prints 64
N1.E.set_Cap(sb, 64);
System.Console.WriteLine(N1.E.get_Cap(sb));
```

Los métodos de acceso `get_` y `set_` son exactamente a lo que se reduce el bloque, así que llamarlos no es un truco sucio, es llamar al miembro real. Es lo bastante feo como para que lo trates como un desbloqueo temporal mientras eliminas uno de los duplicados. Si todavía estás decidiendo cómo dar forma a estas declaraciones, las reglas para [declarar propiedades de extensión en C# 14](/es/2026/06/how-to-declare-extension-properties-in-csharp-14/) cubren por qué se rechazan las propiedades automáticas y qué pueden hacer los descriptores de acceso.

## ¿Un tipo de receptor más específico rompe el empate?

Sí, y por eso solo algunos de tus puntos de llamada se rompen. La resolución de sobrecarga sigue prefiriendo la mejor conversión desde el receptor, y esa comparación ocurre entre ambas sintaxis. Un bloque de extensión sobre `string` le gana a un método con parámetro `this` sobre `IEnumerable<char>`:

```csharp
// Old.cs -- .NET 10.0.201, C# 14
namespace Old;

public static class E
{
    public static string Describe(this System.Collections.Generic.IEnumerable<char> s) => "IEnumerable<char>";
}
```

```csharp
// New.cs -- .NET 10.0.201, C# 14
namespace New;

public static class E
{
    extension(string s)
    {
        public string Describe() => "string";
    }
}
```

```csharp
// Use.cs -- .NET 10.0.201, C# 14
using Old;
using New;

System.Console.WriteLine("x".Describe()); // prints: string
```

Un método genérico con parámetro `this` pierde frente a un bloque de extensión concreto sobre el mismo receptor, y sigue ganando para cualquier otro tipo de receptor:

```csharp
// .NET 10.0.201, C# 14
// G1.E: public static string Kind<T>(this T value) => "generic this-method";
// G2.E: extension(string s) { public string Kind() => "extension block on string"; }

System.Console.WriteLine("x".Kind()); // extension block on string
System.Console.WriteLine(42.Kind());  // generic this-method
```

Así que una migración que cambia un receptor de `IEnumerable<T>` a un tipo concreto moverá silenciosamente algunos puntos de llamada a la nueva implementación sin ningún error. Eso es un cambio de comportamiento escondido dentro de lo que parece una refactorización de sintaxis, y merece una prueba en vez de una compilación.

## ¿Un método de instancia rompe el empate?

Un miembro de instancia siempre le gana a cualquier miembro de extensión, en cualquiera de las dos sintaxis, sin diagnóstico. Si un tipo gana un método de instancia con una firma coincidente en una versión posterior de una dependencia, ambas de tus declaraciones de extensión quedan inalcanzables y nada te avisa:

```csharp
// .NET 10.0.201, C# 14
public class Order { public decimal Total() => 10m; }
public static class E1 { public static decimal Total(this Order o) => 20m; }
public static class E2 { extension(Order o) { public decimal Total() => 30m; } }

// new Order().Total() prints 10
```

Ese programa compila sin advertencias e imprime `10`. Es la imagen espejo de CS0121: dos miembros de extensión ambiguos hacen ruido, dos ensombrecidos son silenciosos. Es la misma clase de peligro de actualización que el [cambio disruptivo de resolución de sobrecarga en C# 14 con spans](/es/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/), donde una nueva conversión implícita reasigna calladamente las llamadas existentes.

## ¿Qué orden de migración evita el error por completo?

1. Mueve las declaraciones, no las copies. Corta el método `this` de la clase estática y pega el cuerpo en un bloque `extension` en la misma clase. CS0111 te atrapará de inmediato si fallas en ese paso, y por eso hacer la migración dentro de una sola clase es más seguro que empezar una nueva.
2. Migra una clase estática completa a la vez. Las clases migradas a medias están bien; los *espacios de nombres* migrados a medias con una clase "V2" paralela son de donde viene CS0121.
3. Nunca crees una clase de extensión `New` o `V2` junto a la antigua. No hay nada que mantener compatible, así que la clase paralela solo te compra una ambigüedad.
4. Después de mover, compila la solución con `dotnet build` antes de tocar los puntos de llamada. Cada punto de llamada que sigue compilando es prueba de que la reducción coincidió.
5. Ejecuta las pruebas, no solo el compilador. Las reglas de especificidad del receptor de arriba significan que una migración puede cambiar qué implementación se ejecuta sin romper la compilación.

Si estás haciendo esto como parte de un salto mayor, la [lista de verificación de migración de .NET 8 a .NET 11](/es/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) secuencia el aumento de versión del lenguaje frente a las actualizaciones del runtime y los paquetes, que es el orden que evita que este error llegue junto con otros veinte.

## Relacionado

- [Miembros de extensión de C# 14: propiedades de extensión, operadores y extensiones estáticas](/es/2026/02/csharp-14-extension-members/) para la superficie completa de la característica, incluidas las formas de operador y miembro estático que este artículo no cubre.
- [Cómo declarar propiedades de extensión en C# 14](/es/2026/06/how-to-declare-extension-properties-in-csharp-14/) para las reglas de descriptores de acceso detrás del truco de desambiguación con `get_` y `set_`.
- [Indexadores de extensión de C# 15 en .NET 11 Preview 6](/es/2026/07/csharp-15-extension-indexers-dotnet-11-preview-6/) para saber hacia dónde va la sintaxis de bloque de extensión.
- [Fix: cambio disruptivo de resolución de sobrecarga en C# 14 con Span y ReadOnlySpan](/es/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/) para el otro cambio de C# 14 que reasigna puntos de llamada existentes.
- [Migrar de .NET 8 a .NET 11: lista de verificación completa](/es/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) para secuenciar el aumento de versión del lenguaje.

## Fuentes

- [Resolve errors and warnings related to extension declarations](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/extension-declarations) en MS Learn, que lista CS9339 y la familia CS93xx de diagnósticos de bloques de extensión.
- [Extension methods](https://learn.microsoft.com/en-us/dotnet/csharp/programming-guide/classes-and-structs/extension-methods) en MS Learn, para las dos sintaxis de declaración y la guía de desambiguación.
- [C# 14: exploring extension members](https://devblogs.microsoft.com/dotnet/csharp-exploring-extension-members/) en el .NET Blog, que documenta la reducción a métodos estáticos con prefijo `get_` y confirma el objetivo de diseño de que convertir un método de extensión a la nueva sintaxis no rompa a sus consumidores.
- [Extensions discussion](https://github.com/dotnet/csharplang/discussions/8696) en dotnet/csharplang, el hilo de diseño de la característica.
