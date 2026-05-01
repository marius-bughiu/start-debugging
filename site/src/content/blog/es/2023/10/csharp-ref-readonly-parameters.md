---
title: "C# parámetros ref readonly"
description: "El modificador ref readonly en C# ofrece una forma más transparente de pasar referencias de solo lectura. Aprende cómo mejora al modificador in con mejores restricciones y visibilidad para quien llama."
pubDate: 2023-10-28
updatedDate: 2023-11-01
tags:
  - "csharp"
  - "dotnet"
lang: "es"
translationOf: "2023/10/csharp-ref-readonly-parameters"
translatedBy: "claude"
translationDate: 2026-05-01
---
El modificador `ref readonly` permite una forma más transparente de pasar referencias de solo lectura a un método. En C# ya era posible pasar referencias readonly usando el modificador `in` desde la versión 7.2, pero esa sintaxis tenía algunas limitaciones, o más bien pocas restricciones.

¿Cómo funciona el nuevo modificador? Supongamos la siguiente firma de método:

```cs
void FooRef(ref readonly int bar) { }
```

Llamar al método pasando simplemente una variable entera o un valor producirá una **advertencia** del compilador. Ten en cuenta que solo es una advertencia: señala una ambigüedad en tu implementación, pero te permitirá ejecutar el código si insistes.

```cs
var x = 42;

FooRef(x);
FooRef(42);
```

-   `FooRef(x)` disparará la advertencia CS9192: Argument 1 should be passed with 'ref' or 'in' keyword
-   `FooRef(42)` disparará la advertencia CS9193: Argument 1 should be a variable because it is passed to a 'ref readonly' parameter

Vamos uno por uno.

## `FooRef(x)`: usando `ref` o `in`

Esta es una de las mejoras sobre el uso del modificador `in`. `ref readonly` deja explícito para quien llama que el valor se pasa por referencia. Con `in`, esto no era transparente para quien llamaba y podía generar confusión.

Para arreglar CS9192, simplemente cambia la llamada para especificar explícitamente `FooRef(ref x)` o `FooRef(in x)`. Las dos anotaciones son en su mayoría equivalentes; la principal diferencia es que `in` es más permisivo y permite pasar valores no asignables, mientras que `ref` requiere una variable asignable.

Por ejemplo:

```cs
readonly int y = 43;

FooRef(in y);
FooRef(ref y);
```

`FooRef(in y)` funcionará sin problemas, mientras que `FooRef(ref y)` disparará un error del compilador diciendo que el valor ref debe ser una variable asignable.

## `FooRef(42)`: solo se permiten variables

Esta es la otra mejora que `ref readonly` aporta sobre `in`: empezará a quejarse cuando intentes pasarle un rvalue, es decir, un valor sin ubicación. Esto va de la mano con la advertencia anterior, porque si intentas usar `FooRef(ref 42)` recibirás de inmediato un error del compilador que dice CS1510: A ref or out value must be an assignable variable.
