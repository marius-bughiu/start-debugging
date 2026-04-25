---
title: "Los tipos de unión de C# 15 están aquí: las uniones de tipo llegan en .NET 11 Preview 2"
description: "C# 15 introduce la palabra clave union para uniones de tipo con coincidencia de patrones exhaustiva y conversiones implícitas. Disponible ahora en .NET 11 Preview 2."
pubDate: 2026-04-08
tags:
  - "csharp"
  - "dotnet"
  - "csharp-15"
  - "dotnet-11"
lang: "es"
translationOf: "2026/04/csharp-15-union-types-dotnet-11-preview-2"
translatedBy: "claude"
translationDate: 2026-04-25
---

Después de años de propuestas, workarounds, y bibliotecas de terceros como `OneOf`, C# 15 entrega la palabra clave `union` en [.NET 11 Preview 2](https://devblogs.microsoft.com/dotnet/csharp-15-union-types/). Estas son **uniones de tipo**: componen tipos existentes en un único tipo cerrado con coincidencia de patrones exhaustiva forzada por el compilador. Sin clases base, sin patrón visitor, sin adivinanzas en runtime.

## Cómo se ven las uniones de tipo

Una unión declara que un valor es exactamente uno de un conjunto fijo de tipos:

```csharp
public union Shape(Circle, Rectangle, Triangle);
```

`Shape` puede contener un `Circle`, un `Rectangle`, o un `Triangle`, y nada más. El compilador genera conversiones implícitas desde cada tipo caso, así que la asignación es directa:

```csharp
Shape shape = new Circle(Radius: 5.0);
```

Sin cast explícito, sin método factory. La conversión simplemente funciona.

## Coincidencia de patrones exhaustiva

La verdadera recompensa llega en el consumo. Una expresión `switch` sobre una unión debe manejar cada caso, o el compilador da error:

```csharp
double Area(Shape shape) => shape switch
{
    Circle c    => Math.PI * c.Radius * c.Radius,
    Rectangle r => r.Width * r.Height,
    Triangle t  => 0.5 * t.Base * t.Height,
};
```

Sin rama default necesaria. Si luego agregas `Polygon` a la unión, cada `switch` que no lo maneje se romperá en tiempo de compilación. Esa es la garantía de seguridad que las jerarquías de clase y `OneOf<T1, T2>` no pueden proporcionar a nivel de lenguaje.

## Las uniones pueden llevar lógica

No estás limitado a una declaración de una sola línea. Las uniones soportan métodos, propiedades, y genéricos:

```csharp
public union Result<T>(T, ErrorInfo)
{
    public string Describe() => Value switch
    {
        T val       => $"Success: {val}",
        ErrorInfo e => $"Error {e.Code}: {e.Message}",
    };
}
```

La propiedad `Value` da acceso a la instancia subyacente. Combinado con genéricos, esto hace que los patrones `Result<T>` sean de primera clase sin dependencias externas.

## Cómo difiere de la propuesta anterior

En enero de 2026, [cubrimos la propuesta de uniones discriminadas](/2026/01/csharp-proposal-discriminated-unions/) que definía miembros dentro de la unión misma (más cercano a los enums de F# o Rust). El diseño entregado de C# 15 toma una dirección diferente: **las uniones de tipo componen tipos existentes** en lugar de declarar nuevos inline. Esto significa que tus `Circle`, `Rectangle`, y `Triangle` son clases o records regulares que ya tienes. La unión simplemente los agrupa.

## Comenzando

Instala el [SDK de .NET 11 Preview 2](https://dotnet.microsoft.com/download/dotnet/11.0), apunta a `net11.0`, y establece `<LangVersion>preview</LangVersion>` en tu archivo de proyecto. Nota que en Preview 2, el `UnionAttribute` y la interfaz `IUnion<T>` aún no están en el runtime: necesitas declararlos en tu proyecto. Las preview posteriores los incluirán de fábrica.

Las uniones de tipo son la mayor adición al sistema de tipos de C# desde los tipos de referencia anulables. Si has estado modelando relaciones "uno-de" con árboles de herencia o trucos de tupla, ahora es un buen momento para hacer prototipos con la cosa real.
