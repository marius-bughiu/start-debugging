---
title: "¿Qué es ref-safe-context en C# y cómo lo decide el compilador para locales ref?"
description: "Reglas de escape de referencias C# con ejemplos comprobados por el compilador: locales ref, reasignación, scoped y spans respaldados por heap o stack."
pubDate: 2026-10-15
updatedDate: 2026-11-02
template: how-to
tags:
  - "csharp"
  - "csharp-14"
  - "dotnet-11"
  - "ref-locals"
  - "span"
  - "compiler-errors"
lang: "es"
translationOf: "2026/10/what-is-ref-safe-context-in-csharp-and-how-does-the-compiler-decide-it-for-ref-locals"
translatedBy: "claude"
translationDate: 2026-10-15
---
Una referencia no debe escapar de la vida útil del almacenamiento al que apunta. C# comprueba esa relación al compilar. Una variable local `ref` inicializada desde una variable local del método no puede devolverse solo porque después se reasigne a un elemento de array.

**Corrección — 2 de noviembre de 2026:** se eliminó la afirmación anterior de pruebas con .NET 11 RC1 porque no había evidencia conservada. Los ejemplos positivos y negativos de aquí se compilaron con SDK 10.0.302, `net10.0` y `LangVersion` 14. Los códigos de error corresponden a estas formas exactas; expresiones parecidas pueden producir otros diagnósticos.

## Ref-safe-context y safe-context

`ref-safe-context` trata de una referencia al almacenamiento. El concepto relacionado `safe-context` trata de un valor que puede contener referencias, como `Span<T>`. La variable local que contiene el span y el almacenamiento que este describe son cosas distintas.

La especificación describe cuatro contextos anidados:

| Contexto | Ejemplo típico |
| --- | --- |
| declaration-block | Referencia a una variable local ordinaria |
| function-member | Parámetro por valor o parámetro scoped |
| return-only | Parámetro `ref` ordinario que puede devolverse |
| caller-context | Elemento de array o campo de clase apropiado |

Estos nombres no indican que todo almacenamiento dure hasta que termine el método. Los bloques anidados y las restricciones `scoped` siguen importando. La [especificación](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/variables#972-ref-safe-contexts) contiene las reglas completas, incluidos parámetros e invocaciones.

## El inicializador limita un local ref sin scoped

Este ejemplo negativo produce CS8157 en la compilación verificada:

```csharp
class Example
{
    static ref int CannotReturn(int[] array)
    {
        int local = 1;
        ref int reference = ref local;
        reference = ref array[0];
        return ref reference; // CS8157
    }
}
```

La reasignación posterior es válida, pero no convierte una referencia derivada de un local en una referencia retornable. Devolver directamente un local ordinario produce CS8168:

```csharp
class Example
{
    static ref int CannotReturn()
    {
        int local = 1;
        return ref local; // CS8168
    }
}
```

## La reasignación no puede aceptar un referente más limitado

Empezar con una referencia a un elemento de array y después asignar una referencia local produce CS8374:

```csharp
class Example
{
    static void CannotNarrow(int[] array)
    {
        ref int reference = ref array[0];
        int local = 1;
        reference = ref local; // CS8374
    }
}
```

Un parámetro `ref` tiene un contrato de escape distinto de un elemento de array. Inicializar desde el array y asignar después el parámetro produce CS9079:

```csharp
class Example
{
    static ref int CannotAssign(int[] array, ref int parameter)
    {
        ref int reference = ref array[0];
        reference = ref parameter; // CS9079
        return ref reference;
    }
}
```

El orden inverso sí compiló en la misma comprobación:

```csharp
class Example
{
    static ref int CanReturn(int[] array, ref int parameter)
    {
        ref int reference = ref parameter;
        reference = ref array[0];
        return ref reference;
    }
}
```

Elige un inicializador cuyo contrato sirva para todos los usos previstos. Mover declaraciones o añadir `scoped` no resuelve universalmente todos los errores de escape.

## Las referencias scoped permanecen locales

Esta modificación dentro del mismo bloque compiló correctamente:

```csharp
class Example
{
    static void LocalUse(int[] array)
    {
        scoped ref int reference = ref array[0];
        int local = 1;
        reference = ref local;
        reference = 5;
    }
}
```

Devolver esa referencia scoped se rechaza. Otra prueba declaró `local` en un bloque anidado más estrecho y también rechazó la reasignación con CS8374. `scoped` no elimina las restricciones de vida de los bloques ni hace retornable la referencia.

Un parámetro scoped también puede comunicar que el argumento no escapa por el resultado del método. Es un contrato de firma; el compilador no necesita inspeccionar la implementación de un helper arbitrario. La [propuesta de C# 11](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-11.0/low-level-struct-improvements.md) detalla las reglas y los casos `[UnscopedRef]`.

## Un span no está necesariamente respaldado por el stack

Ambos ejemplos declaran un span local, pero solo el primer resultado puede escapar:

```csharp
using System;

class Example
{
    static ref int HeapBacked()
    {
        Span<int> values = new int[2];
        return ref values[0]; // Compiles in the verified probe
    }

    static ref int StackBacked()
    {
        Span<int> values = stackalloc int[2];
        return ref values[0]; // CS8352 in this exact probe
    }
}
```

El span basado en array describe almacenamiento del heap administrado. Devolver una referencia a ese almacenamiento es distinto de devolver una referencia a la propia variable local span. Las referencias administradas mantienen alcanzables sus objetos; eso no vuelve inmortales a los objetos del heap.

Para un algoritmo práctico con retorno ref, usa un span aportado por el llamador y trata la entrada vacía:

```csharp
using System;

static ref int MaxRef(Span<int> values)
{
    if (values.IsEmpty)
        throw new ArgumentException("At least one element is required", nameof(values));

    ref int best = ref values[0];
    for (int i = 1; i < values.Length; i++)
        if (values[i] > best) best = ref values[i];
    return ref best;
}

int[] data = { 3, 9, 4 };
MaxRef(data) = 0;
Console.WriteLine(string.Join(",", data)); // 3,0,4
```

## Leer el diagnóstico en contexto

Las pruebas distinguen retorno directo de un local (CS8168), local ref no retornable (CS8157), asignación de referencia más estrecha (CS8374) y parámetro return-only asignado a una referencia más amplia (CS9079). La expresión directa del span de stack anterior produjo CS8352. Un alias o helper adicional puede cambiar el diagnóstico sin cambiar el problema de vida útil.

Las restricciones async/iterador son otra cuestión: no se puede conservar una referencia a través de un punto de suspensión cuando el lenguaje lo prohíbe. No expliques todo rechazo únicamente por la regla del inicializador.

Relacionado: [Span<T> y su almacenamiento](/es/2026/06/what-is-span-and-when-does-it-make-my-code-faster/), [List frente a Span y ReadOnlySpan](/es/2026/05/list-vs-span-vs-readonlyspan-in-csharp/) y [declaraciones de variables de referencia](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/statements/declarations#reference-variables).
