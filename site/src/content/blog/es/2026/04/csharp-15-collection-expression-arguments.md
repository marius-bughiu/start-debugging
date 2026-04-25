---
title: "Argumentos en expresiones de colección de C# 15: pasa constructores en línea con with(...)"
description: "C# 15 agrega el elemento with(...) a las expresiones de colección, dejándote pasar capacidad, comparadores, y otros argumentos del constructor directamente en el inicializador."
pubDate: 2026-04-13
tags:
  - "csharp-15"
  - "dotnet-11"
  - "collection-expressions"
lang: "es"
translationOf: "2026/04/csharp-15-collection-expression-arguments"
translatedBy: "claude"
translationDate: 2026-04-25
---

Las expresiones de colección llegaron en C# 12 y han estado absorbiendo nuevas capacidades desde entonces. C# 15, que se entrega con [.NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/overview), agrega una pieza faltante: ahora puedes pasar argumentos al constructor o método de fábrica de la colección con un elemento `with(...)` colocado al inicio de la expresión.

## Por qué esto importa

Antes de C# 15, las expresiones de colección inferían el tipo objetivo y llamaban a su constructor predeterminado. Si necesitabas un `HashSet<string>` insensible a mayúsculas o un `List<T>` pre-dimensionado para una capacidad conocida, tenías que recurrir a un inicializador tradicional o a una configuración de dos pasos:

```csharp
// C# 14 and earlier: no way to pass a comparer via collection expression
var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "Hello", "HELLO" };

// Or the awkward two-step
List<string> names = new(capacity: 100);
names.AddRange(source);
```

Ambos patrones rompen el flujo conciso para el cual fueron diseñadas las expresiones de colección.

## Argumentos del constructor en línea con `with(...)`

C# 15 te deja escribir esto en su lugar:

```csharp
string[] values = ["one", "two", "three"];

// Pre-allocate capacity
List<string> names = [with(capacity: values.Length * 2), .. values];

// Case-insensitive set in a single expression
HashSet<string> set = [with(StringComparer.OrdinalIgnoreCase), "Hello", "HELLO", "hello"];
// set.Count == 1
```

El elemento `with(...)` debe aparecer primero. Después de él, el resto de la expresión funciona exactamente como cualquier otra expresión de colección: literales, spreads, y expresiones anidadas se componen todas normalmente.

## Los diccionarios reciben el mismo tratamiento

La característica realmente brilla con `Dictionary<TKey, TValue>`, donde los comparadores son comunes pero anteriormente te forzaban a abandonar las expresiones de colección por completo:

```csharp
Dictionary<string, int> headers = [
    with(StringComparer.OrdinalIgnoreCase),
    KeyValuePair.Create("Content-Length", 512),
    KeyValuePair.Create("content-length", 1024)  // overwrites the first entry
];
// headers.Count == 1
```

Sin `with(...)`, no podías pasar un comparador a través de una expresión de colección en absoluto. La única opción era una llamada al constructor seguida de adiciones manuales.

## Restricciones a tener en cuenta

Algunas reglas para tener en mente:

- `with(...)` debe ser el **primer** elemento en la expresión.
- No es soportado en arrays o tipos span (`Span<T>`, `ReadOnlySpan<T>`), ya que esos no tienen constructores con parámetros de configuración.
- Los argumentos no pueden tener tipo `dynamic`.

## Una evolución natural

C# 12 nos dio la sintaxis. C# 13 extendió `params` para aceptar expresiones de colección. C# 14 amplió las conversiones implícitas de span. Ahora C# 15 elimina la última razón común para abandonar las expresiones de colección: configuración del constructor. Si ya estás en [.NET 11 Preview 2](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-2/) o posterior, puedes probar esto hoy con `<LangVersion>preview</LangVersion>` en tu archivo de proyecto.

Spec completa: [Propuesta de argumentos en expresiones de colección](https://github.com/dotnet/csharplang/blob/main/proposals/collection-expression-arguments.md).
