---
title: "Solución: CS8509 o CS0161 en un switch exhaustivo sobre un tipo union de C# 15"
description: "Haz el switch sobre el valor union, no sobre .Value, y usa una expresión switch o añade case null a una sentencia switch. Las sentencias exigen cubrir null, mientras que las expresiones solo emiten una advertencia."
pubDate: 2026-10-01
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-15"
  - "dotnet-11"
  - "pattern-matching"
lang: "es"
translationOf: "2026/10/fix-cs8509-cs0161-switch-exhaustive-over-csharp-15-union-type"
translatedBy: "claude"
translationDate: 2026-10-01
---

Haz el switch sobre el propio valor union, no sobre su propiedad `.Value`, y prefiere una expresión switch. Si necesitas una sentencia switch en un método que devuelve un valor, añade una rama `case null:` (o un `throw` después del switch): el compilador solo considera completa una sentencia switch sobre un union cuando se cubre el `Value` nulo de un union `default`. Todo el comportamiento descrito abajo se midió con el SDK de .NET 11 RC1 (`11.0.100-rc.1.26425.128`, C# 15, sin necesidad de sobrescribir `LangVersion`).

## El error en contexto

Declaraste un union, cubriste todos los tipos de caso y el compilador sigue diciendo que no:

```text
warning CS8509: The switch expression does not handle all possible values of its input type (it is not exhaustive). For example, the pattern '_' is not covered.
error CS0161: 'Pets.Describe(Pet)': not all code paths return a value
error CS0165: Use of unassigned local variable 's'
warning CS8655: The switch expression does not handle some null inputs (it is not exhaustive). For example, the pattern 'null' is not covered.
error CS8780: A variable may not be declared within a 'not' or an 'or' pattern or a union matching involving matching against either the instance, or its underlying value.
```

Son cinco síntomas distintos de la misma confusión: la exhaustividad de los union en C# 15 es una propiedad de la **coincidencia de union**, y esta solo se activa bajo condiciones específicas. Si te sales de esas condiciones, vuelves a la coincidencia de patrones normal sobre `object`, donde dos patrones de tipo nunca son exhaustivos.

## Por qué el compilador no ve tu switch como exhaustivo

La [especificación de unions](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-15.0/unions.md#union-exhaustiveness) de C# 15 lo dice en una línea: se asume que un tipo union queda "agotado" por sus tipos de caso, así que una expresión `switch` es exhaustiva si maneja todos los tipos de caso del union. Todo lo demás se deduce de la letra pequeña.

1. **La entrada debe ser el valor union.** La coincidencia de union solo ocurre "when the input value of a pattern is of a union type or of a nullable of a union type". Si haces el switch sobre `pet.Value` (de tipo `object?`) o sobre un union que se empaquetó (boxing) en `object`, el compilador no tiene lista de casos, así que pide `_`.
2. **Las sentencias switch son más estrictas que las expresiones switch.** Una expresión switch con un `null` sin manejar compila con una advertencia CS8655. Una sentencia switch usada para el análisis de asignación definitiva o de rutas de retorno solo cuenta como completa cuando también se cubre `null`, así que el final del `switch` sigue siendo alcanzable y obtienes CS0161 o CS0165.
3. **El `Value` de un union siempre puede ser null.** `public union Pet(Cat, Dog)` se reduce a un struct con un `public object? Value { get; }`. `default(Pet)` contiene `null`, y también `new Pet((Cat)null!)`. La especificación lo menciona en [well-formedness](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-15.0/unions.md#well-formedness): `Value` es "null or a value of a case type".
4. **Los parámetros de tipo no se desenvuelven.** Un tipo de caso `T` en `union Result<T>(T, Exception)` no se puede comparar con un patrón que tenga designación, porque el compilador no puede demostrar si `T v` debe probar la instancia del union o su contenido. Eso es CS8780.

## Reproducción mínima

```csharp
// .NET 11 RC1 SDK 11.0.100-rc.1.26425.128, C# 15, <Nullable>enable</Nullable>
public record Cat(string Name);
public record Dog(string Name);
public union Pet(Cat, Dog);
public union MaybePet(Cat?, Dog);
public union Result<T>(T, Exception);

static class Pets
{
    // OK: no diagnostics
    static string A(Pet p) => p switch { Cat c => c.Name, Dog d => d.Name };

    // CS8509: pattern '_' is not covered
    static string B(Pet p) => p.Value switch { Cat c => c.Name, Dog d => d.Name };

    // CS0161: not all code paths return a value
    static string Describe(Pet p)
    {
        switch (p)
        {
            case Cat c: return c.Name;
            case Dog d: return d.Name;
        }
    }

    // CS8655: pattern 'null' is not covered (Cat? is a nullable case type)
    static string D(MaybePet p) => p switch { Cat c => c.Name, Dog d => d.Name };

    // CS8509: a union boxed into object is just an object
    static string E(object o) => o switch { Cat c => c.Name, Dog d => d.Name };

    // CS8655: Nullable<Pet> can be null
    static string F(Pet? p) => p switch { Cat c => c.Name, Dog d => d.Name };

    // CS8780 on 'TV v'
    static string I<TV>(Result<TV> r) => r switch { TV v => v!.ToString()!, Exception e => e.Message };
}
```

El método `A` es el punto de referencia: el valor union entra directamente en una expresión switch, cada tipo de caso tiene su rama y el compilador no dice nada. Todos los demás métodos rompen una de las cuatro reglas anteriores.

## La solución, en detalle

Recórrelas en orden. La primera resuelve la mayoría de los casos reales.

### 1. Haz la coincidencia sobre el union, no sobre `.Value`

`Value` está declarado como `object?`. En el momento en que lo desreferencias, descartas el tipo union y su lista de casos. La coincidencia de patrones sobre el union ya desenvuelve el contenido por ti: `p is Cat c` se compila como una prueba sobre `p.Value`, así que no hay motivo para recurrir a `.Value` tú mismo.

```csharp
// .NET 11 RC1, C# 15
// Before: CS8509
static string Name(Pet p) => p.Value switch { Cat c => c.Name, Dog d => d.Name };

// After: exhaustive, no default arm
static string Name(Pet p) => p switch { Cat c => c.Name, Dog d => d.Name };
```

Lo mismo aplica a un union que viaja a través de un `object`, un `IUnion` o un parámetro genérico `T`. Según la [pregunta resuelta](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-15.0/unions.md#resolved-confirm-that-a-type-parameter-is-never-a-union-type-even-when-constrained-to-one) de la especificación, un parámetro de tipo nunca es un tipo union, ni siquiera cuando está restringido a uno. En RC1, `static string L<TU>(TU u) where TU : struct, IUnion => u switch { Cat c => ..., Dog d => ... }` ni siquiera llega a la exhaustividad: falla con CS8121, "An expression of type 'TU' cannot be handled by a pattern of type 'Cat'". Mantén el tipo union concreto en la firma.

Una excepción parcial: los patrones de propiedad sobre `Value` sí aprovechan el conocimiento del union en RC1. `r switch { { Value: TV v } => ..., { Value: Exception e } => ... }` produjo solo CS8655, no CS8509. La especificación aún lista "Should direct Value property matching follow Union rules?" como pregunta abierta, así que no construyas sobre esto.

### 2. Prefiere una expresión switch; dale un `case null` a la sentencia switch

Este es el caso de CS0161 / CS0165 y el más sorprendente, porque las mismas ramas funcionan como expresión. Medí tres variantes en RC1:

```csharp
// .NET 11 RC1, C# 15
public union Pet(Cat, Dog);
public closed class Shape;
public sealed class Sq : Shape;
public sealed class Ci : Shape;

// error CS0161
static string S1(Pet p) { switch (p) { case Cat c: return c.Name; case Dog d: return d.Name; } }

// compiles
static string S2(Pet p) { switch (p) { case Cat c: return c.Name; case Dog d: return d.Name; case null: return "none"; } }

// compiles: bool is exhaustive for statements
static int S3(bool b) { switch (b) { case true: return 1; case false: return 0; } }

// error CS0161: closed hierarchies behave like unions here
static int S4(Shape s) { switch (s) { case Sq: return 1; case Ci: return 0; } }
```

`S3` demuestra que el compilador sí hace análisis de exhaustividad en las sentencias switch. Lo que no hace es ignorar un `null` sin cubrir. Una expresión switch degrada el `null` faltante a una advertencia de nulabilidad (y, para un union cuyos tipos de caso son todos no anulables, a nada en absoluto). Una sentencia switch usa la respuesta completa de exhaustividad para la alcanzabilidad, y esa respuesta incluye `null`. Activar `#nullable disable` no cambia nada: el compilador de RC1 sigue reportando CS0161 tanto para el union como para la clase cerrada.

Tienes tres soluciones limpias, en orden de preferencia:

```csharp
// .NET 11 RC1, C# 15
using System.Diagnostics;

// a) Use an expression. Most switch statements that only return can be one.
static string Describe(Pet p) => p switch { Cat c => c.Name, Dog d => d.Name };

// b) Cover null explicitly. Use this when a default union is a legitimate state.
static string Describe2(Pet p)
{
    switch (p)
    {
        case Cat c: return c.Name;
        case Dog d: return d.Name;
        case null: return "no pet";
    }
}

// c) Keep the statement and declare the end unreachable.
static string Describe3(Pet p)
{
    switch (p)
    {
        case Cat c: return c.Name;
        case Dog d: return d.Name;
    }
    throw new UnreachableException();
}
```

Evita `default:` como solución. Compila, pero también se traga el próximo tipo de caso que añadas al union, que es justo el diagnóstico que querías conservar.

La variante CS0165 es el mismo problema en forma de asignación: `string s; switch (p) { case Cat c: s = ...; break; case Dog d: s = ...; break; } return s;` falla porque el final del switch es alcanzable con `s` sin asignar. Se aplican las mismas tres soluciones.

### 3. Maneja null donde el tipo dice que puede ser null

CS8655 es el compilador teniendo razón. Aparece en dos situaciones:

- Uno de los tipos de caso es anulable, como en `union MaybePet(Cat?, Dog)`. La regla de la especificación: el estado de nulabilidad por defecto de `Value` es "maybe null" si algún tipo de caso es "maybe null".
- La entrada es `Pet?` (un `Nullable<Pet>`), que puede ser `null` por sí mismo.

Añade una rama `null`. En un union, `null` coincide tanto con una instancia nula como con un union cuyo `Value` es null:

```csharp
// .NET 11 RC1, C# 15
static string D(MaybePet p) => p switch
{
    Cat c => c.Name,
    Dog d => d.Name,
    null => "none",
};
```

Si el tipo de caso anulable fue accidental, quita el `?` de la declaración del union.

### 4. Quita la designación en los tipos de caso con parámetro de tipo

Para `union Result<T>(T, Exception)`, la rama `T v` falla con CS8780 sin importar la restricción. Probé sin restricción, `where T : notnull`, `where T : class` y `where T : struct`: los cuatro reportan CS8780 en RC1. Lo que funciona es un patrón de tipo sin variable, o capturar el caso genérico al final con `var`:

```csharp
// .NET 11 RC1, C# 15
public union Result<T>(T, Exception);

// Exhaustive and clean with notnull: prints "v:5" for new Result<int>(5)
static string W4<TV>(Result<TV> r) where TV : notnull =>
    r switch { TV => "v:" + r.Value, Exception => "e" };

// Match the concrete case first, let var take the rest
static string W3<TV>(Result<TV> r) =>
    r switch { Exception e => e.Message, var other => other.Value!.ToString()! };
```

Sin la restricción `notnull`, la forma `TV =>` sigue compilando pero añade CS8655, porque `TV` podría ser un tipo anulable. Ten en cuenta que `var` no desenvuelve un union: `other` es el `Result<TV>`, no su contenido, y por eso lees `.Value` de él.

## La mitad del runtime: un union por defecto sigue lanzando excepción

Silenciar al compilador no es lo mismo que manejar todos los valores. Un union cuyos tipos de caso son todos no anulables no genera advertencia cuando haces switch sobre `default`:

```csharp
// .NET 11 RC1, C# 15
public union Result2(int, Exception);

static string Show(Result2 r) => r switch { int v => v.ToString(), Exception e => e.Message };

Show(default); // System.Runtime.CompilerServices.SwitchExpressionException at runtime
```

La pregunta resuelta de la especificación "Default nullable state of `Value` property" reconoce que `default(U).Value` es `null` mientras que el análisis de nulabilidad solo mira los tipos de caso. En la práctica, un union por defecto aparece cuando es un campo que nunca se asignó, un elemento de un arreglo, un retorno `default` en código genérico o una carga deserializada que no pobló el union. Si existe alguna de esas rutas, añade la rama `null` aunque el compilador no la pida, o valida en el límite. El mismo razonamiento aplica a las [propiedades no anulables que nunca se asignan en un constructor](/es/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/): la anotación describe una intención, no una garantía en runtime.

## Trampas y casos parecidos

- **CS8846** ("However, a pattern with a 'when' clause might successfully match this value") significa que un tipo de caso solo está cubierto bajo una guarda `when`. Añade una rama sin guarda para ese tipo. No es un error de los union.
- **CS8509 que nombra un tipo concreto**, como "the pattern 'Dog' is not covered", es la versión honesta del error: de verdad te falta un tipo de caso. Este es el diagnóstico que salta por todas partes cuando alguien añade un caso a un union compartido, y la razón para evitar las ramas `default` y `_`.
- **Los tipos de caso que son interfaces o clases base** quedan agotados por ese tipo, no por sus subtipos. Para `union Shape(IShape, string)`, las ramas para `Circle` y `Square` no cubren `IShape`. Si quieres exhaustividad por subtipos, convierte la base en una [jerarquía de clases cerrada](/es/2026/06/csharp-15-closed-class-hierarchies-dotnet-11-preview-5/) y añádela como tipo de caso.
- **Versiones preliminares anteriores.** Si todavía estás en .NET 11 Preview 2 con tipos `UnionAttribute` e `IUnion` declarados a mano, como se describe en el [anuncio original de los tipos union](/es/2026/04/csharp-15-union-types-dotnet-11-preview-2/), los diagnósticos de exhaustividad cambiaron entre versiones preliminares. Actualiza a RC1 antes de perseguir cualquiera de los errores anteriores.
- **Analizadores y código generado.** El código que recibe unions como `object`, como un convertidor JSON o un model binder, cae bajo la regla 1. El comportamiento de la serialización y el enlace se cubre en [serializar tipos union de C# con System.Text.Json](/es/2026/07/serialize-csharp-union-types-with-system-text-json-dotnet-11-preview-6/) y [dónde funciona el enlace de unions en ASP.NET Core 11](/es/2026/09/csharp-unions-in-aspnetcore-11-where-binding-works/).

## Relacionado

- [Los tipos union de C# 15 ya están aquí](/es/2026/04/csharp-15-union-types-dotnet-11-preview-2/) para la sintaxis de declaración y las conversiones implícitas.
- [Jerarquías de clases cerradas de C# 15](/es/2026/06/csharp-15-closed-class-hierarchies-dotnet-11-preview-5/), que comparten el comportamiento de las sentencias switch medido arriba.
- [Serializar tipos union de C# con System.Text.Json](/es/2026/07/serialize-csharp-union-types-with-system-text-json-dotnet-11-preview-6/) para unions que cruzan un límite de red.
- [Devolver varios valores desde un método en C#](/es/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/) si estás comparando un union `Result<T>` con tuplas o parámetros out.
- [Solución de CS8618 para propiedades no anulables](/es/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/) para el lado del análisis de nulabilidad de la misma historia.

## Fuentes

- [Especificación de unions de C# 15 (csharplang)](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-15.0/unions.md): coincidencia de union, exhaustividad, nulabilidad, reducción y las preguntas resueltas citadas arriba.
- [Referencia de tipos union en Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/union).
- [Advertencias de coincidencia de patrones, incluidas CS8509, CS8655 y CS8846](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/pattern-matching-warnings).
- Todos los diagnósticos y resultados en runtime se reprodujeron localmente con el SDK de .NET 11 RC1 `11.0.100-rc.1.26425.128` en macOS, `net11.0`, `<Nullable>enable</Nullable>`.
