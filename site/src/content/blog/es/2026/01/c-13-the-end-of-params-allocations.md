---
title: "C# 13: el fin de las asignaciones de `params`"
description: "C# 13 finalmente elimina la asignación oculta de arrays detrás de params. Ahora puedes usar params con Span, ReadOnlySpan, List y otros tipos de colección para métodos variádicos sin asignaciones."
pubDate: 2026-01-02
tags:
  - "csharp-13"
  - "csharp"
  - "dotnet"
  - "dotnet-9"
lang: "es"
translationOf: "2026/01/c-13-the-end-of-params-allocations"
translatedBy: "claude"
translationDate: 2026-05-01
---
Durante más de dos décadas, la palabra clave `params` en C# ha venido con un impuesto oculto: asignaciones implícitas de arrays. Cada vez que llamabas a un método como `string.Format` o a tu propio helper con un número variable de argumentos, el compilador creaba silenciosamente un nuevo array. En escenarios de alto rendimiento (rutas calientes), estas asignaciones se acumulaban, generando presión innecesaria sobre el recolector de basura (GC).

Con C# 13 y .NET 9, ese impuesto finalmente se deroga. Ahora puedes usar `params` con tipos de colección distintos a los arrays, incluyendo `Span<T>` y `ReadOnlySpan<T>`.

## El impuesto del array

Considera un método de logging típico antes de C# 13.

```cs
// Old C# way
public void Log(string message, params object[] args)
{
    // ... logic
}

// Usage
Log("User {0} logged in", userId); // Allocates new object[] { userId }
```

Incluso si pasabas un solo entero, el runtime tenía que asignar un array en el heap. Para bibliotecas como Serilog o el logging de ASP.NET Core, esto significaba inventar soluciones creativas o sobrecargar métodos con 1, 2, 3... argumentos para evitar el array.

## Cero asignaciones con `params ReadOnlySpan<T>`

C# 13 permite el modificador `params` sobre cualquier tipo que admita expresiones de colección. El cambio de mayor impacto es el soporte para `ReadOnlySpan<T>`.

```cs
// C# 13 way
public void Log(string message, params ReadOnlySpan<object> args)
{
    // ... logic using span
}

// Usage
// Compiler uses stack allocation or shared buffers!
Log("User {0} logged in", userId);
```

Cuando llamas a este nuevo método, el compilador es lo bastante inteligente como para pasar los argumentos usando un buffer asignado en la pila (vía `stackalloc`) u otras optimizaciones, evitando por completo el heap.

## Más allá de los arrays

No es solo cuestión de rendimiento. `params` ahora admite `List<T>`, `HashSet<T>` e `IEnumerable<T>`. Esto mejora la flexibilidad de la API, permitiéndote definir la _intención_ de la estructura de datos en lugar de forzar un array.

```cs
public void ProcessTags(params HashSet<string> tags) 
{
    // O(1) lookups immediately available
}

ProcessTags("admin", "editor", "viewer");
```

## Cuándo migrar

Si mantienes una biblioteca o una aplicación sensible al rendimiento sobre .NET 9, audita tus métodos `params`.

1.  Cambia `params T[]` por `params ReadOnlySpan<T>` si solo necesitas leer los datos.
2.  Cambia a `params IEnumerable<T>` si necesitas ejecución diferida o flexibilidad genérica.

Este pequeño cambio en la firma puede reducir significativamente el tráfico de memoria a lo largo del ciclo de vida de tu aplicación.
