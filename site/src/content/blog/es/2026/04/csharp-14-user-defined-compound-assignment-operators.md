---
title: "Operadores de asignación compuesta definidos por el usuario en C# 14: += in-place sin la asignación extra"
description: "C# 14 te deja sobrecargar +=, -=, *= y compañía como métodos de instancia void que mutan al receptor in-place, recortando asignaciones para holders de valores grandes como buffers tipo BigInteger y tensores."
pubDate: 2026-04-14
tags:
  - "csharp"
  - "csharp-14"
  - "dotnet-10"
  - "performance"
  - "operators"
lang: "es"
translationOf: "2026/04/csharp-14-user-defined-compound-assignment-operators"
translatedBy: "claude"
translationDate: 2026-04-24
---

Una de las adiciones más silenciosas en C# 14 finalmente está siendo asfaltada en la referencia del lenguaje: operadores de asignación compuesta definidos por el usuario. Hasta .NET 10, escribir `x += y` sobre un tipo personalizado siempre compilaba a `x = x + y`, lo que significaba que tu `operator +` tenía que asignar y devolver una instancia nueva incluso cuando el llamador estaba a punto de tirar la vieja. Con C# 14 ahora puedes sobrecargar `+=` directamente como un método de instancia `void` que muta al receptor in-place.

La motivación es simple: para tipos que cargan muchos datos (un buffer tipo `BigInteger`, un tensor, un acumulador de bytes con pool), producir un destino fresco, recorrerlo y copiar memoria es la parte cara de cada `+=`. Si el valor original no se usa después de la asignación, esa copia es puro desperdicio. La [especificación de la característica](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-14.0/user-defined-compound-assignment) lo deja explícito.

## Cómo se declara el nuevo operador

Un operador de asignación compuesta en C# 14 no es estático. Toma un solo parámetro, devuelve `void` y vive en la instancia:

```csharp
public sealed class Accumulator
{
    private readonly List<int> _values = new();

    public int Sum { get; private set; }

    // Classic binary operator, still required if you want x + y to work.
    public static Accumulator operator +(Accumulator left, int value)
    {
        var result = new Accumulator();
        result._values.AddRange(left._values);
        result._values.Add(value);
        result.Sum = left.Sum + value;
        return result;
    }

    // New in C# 14: instance operator, no allocation, no static modifier.
    public void operator +=(int value)
    {
        _values.Add(value);
        Sum += value;
    }
}
```

El compilador emite el método de instancia bajo el nombre `op_AdditionAssignment`. Cuando el llamador escribe `acc += 5`, el lenguaje ahora prefiere el operador de instancia si hay uno disponible; si no, el viejo reescritura `x = x + y` sigue siendo el fallback. Eso significa que el código existente continúa compilando, y puedes añadir una sobrecarga de `+=` más tarde sin romper la sobrecarga de `+`.

## Cuándo importa

El beneficio aparece en tipos por referencia que poseen buffers internos y en tipos struct usados a través de una ubicación de almacenamiento mutable. Un `Matrix operator +(Matrix, Matrix)` ingenuo tiene que asignar una matriz nueva por cada llamada `m += other` en un bucle caliente. La versión de instancia puede sumar en `this` y no devolver nada:

```csharp
public sealed class Matrix
{
    private readonly double[] _data;
    public int Rows { get; }
    public int Cols { get; }

    public void operator +=(Matrix other)
    {
        if (other.Rows != Rows || other.Cols != Cols)
            throw new ArgumentException("Shape mismatch.");

        var span = _data.AsSpan();
        var otherSpan = other._data.AsSpan();
        for (int i = 0; i < span.Length; i++)
            span[i] += otherSpan[i];
    }
}
```

`++` y `--` prefijos siguen el mismo patrón con `public void operator ++()`. `x++` postfijo todavía pasa por la versión estática cuando el resultado se usa, porque el valor pre-incremento no se puede producir tras una mutación in-place.

## Cosas que vale saber

El lenguaje no fuerza consistencia entre `+` y `+=`, así que puedes enviar uno sin el otro. El LDM [lo miró en abril de 2025](https://github.com/dotnet/csharplang/blob/main/meetings/2025/LDM-2025-04-02.md) y decidió contra el emparejamiento obligatorio. Las variantes `checked` funcionan igual: declara `public void operator checked +=(int y)` junto al regular. `readonly` se permite en structs pero, como nota la spec, raramente tiene sentido dado que el punto entero del método es mutar la instancia.

La característica viene con C# 14 sobre .NET 10, usable hoy en Visual Studio 2026 o el SDK de .NET 10. Para librerías existentes que exponen tipos por valor con muchos datos, retroadaptar un `+=` de instancia es uno de los wins de rendimiento más baratos disponibles en este release. Ver el resumen completo en [Novedades de C# 14](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/csharp-14).
