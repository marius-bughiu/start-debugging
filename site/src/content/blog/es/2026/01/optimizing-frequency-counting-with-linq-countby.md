---
title: "Optimizando el conteo de frecuencias con LINQ CountBy"
description: "Reemplaza GroupBy por CountBy en .NET 9 para un conteo de frecuencias más limpio y eficiente. Reduce las asignaciones de O(N) a O(K) al saltarse las estructuras intermedias de agrupación."
pubDate: 2026-01-01
tags:
  - "dotnet"
  - "dotnet-9"
lang: "es"
translationOf: "2026/01/optimizing-frequency-counting-with-linq-countby"
translatedBy: "claude"
translationDate: 2026-05-01
---
Una de las operaciones más comunes en el procesamiento de datos es calcular la frecuencia de los elementos en una colección. Durante años, los desarrolladores de C# se han apoyado en el patrón `GroupBy` para lograrlo. Aunque funcional, suele incurrir en sobrecarga innecesaria al asignar objetos de buckets para grupos que se descartan inmediatamente después de contar.

Con .NET 9, el namespace System.Linq introduce `CountBy`, un método especializado que agiliza significativamente esta operación.

## La sobrecarga heredada

Antes de .NET 9, contar ocurrencias normalmente requería una cadena verbosa de llamadas LINQ. Tenías que agrupar los elementos y luego proyectarlos a un tipo nuevo que contuviera la clave y el conteo.

```cs
// Before: Verbose and allocates group buckets
var logLevels = new[] { "INFO", "ERROR", "INFO", "WARN", "ERROR", "INFO" };

var frequency = logLevels
    .GroupBy(level => level)
    .Select(group => new { Level = group.Key, Count = group.Count() })
    .ToDictionary(x => x.Level, x => x.Count);
```

Este enfoque funciona, pero es pesado. El iterador `GroupBy` construye estructuras de datos internas para guardar los elementos de cada grupo, aunque solo nos importe el conteo. Para conjuntos grandes, esto pone presión innecesaria sobre el recolector de basura.

## Simplificando con CountBy

.NET 9 añade `CountBy` directamente a `IEnumerable<T>`. Este método devuelve una colección de `KeyValuePair<TKey, int>`, eliminando la necesidad de estructuras intermedias de agrupación.

```cs
// After: Clean, intent-revealing, and efficient
var logLevels = new[] { "INFO", "ERROR", "INFO", "WARN", "ERROR", "INFO" };

foreach (var (level, count) in logLevels.CountBy(level => level))
{
    Console.WriteLine($"{level}: {count}");
}
```

La sintaxis no solo es más limpia; también declara explícitamente la intención: estamos contando por una clave.

## Implicaciones de rendimiento

Bajo el capó, `CountBy` está optimizado para evitar asignar los buckets de agrupación que `GroupBy` requiere. En un escenario tradicional de `GroupBy`, el runtime suele crear un objeto `Grouping<TKey, TElement>` por cada clave única y mantiene internamente una colección de elementos para esa clave. Si tienes 1 millón de elementos y 100 claves únicas, `GroupBy` puede hacer un trabajo significativo organizando esos 1 millón de elementos en listas.

`CountBy`, en cambio, solo necesita rastrear el contador. Se comporta efectivamente como un acumulador `Dictionary<TKey, int>`. Itera el origen una vez, incrementa el contador para la clave y descarta el elemento. Esto convierte una operación con espacio O(N) (en términos de mantener elementos) en algo más cercano a espacio O(K), donde K es el número de claves únicas.

Para escenarios de alto rendimiento, como analizar logs de servidor, procesar flujos de transacciones o agregar datos de sensores, esta diferencia no es trivial. Reduce la presión sobre el GC al descartar de inmediato los pesados objetos "bucket".

### Casos límite y claves

Como `GroupBy`, `CountBy` se apoya en el comparador de igualdad por defecto del tipo de clave salvo que se especifique otro. Si cuentas con una clave de objeto personalizada, asegúrate de sobrescribir correctamente `GetHashCode` y `Equals`, o proporciona un `IEqualityComparer<TKey>` propio.

```cs
// Handling case-insensitivity explicitly
var frequency = logLevels.CountBy(level => level, StringComparer.OrdinalIgnoreCase);
```

### Cuándo seguir con GroupBy

Vale la pena destacar que `CountBy` es estrictamente para contar. Si necesitas los elementos reales (por ejemplo, "dame los primeros 5 errores"), aún necesitas `GroupBy`. Pero para histogramas, mapas de frecuencia y analítica, `CountBy` en .NET 9 es la herramienta superior.

Al adoptar `CountBy`, reduces verbosidad y mejoras los patrones de asignación en tus pipelines de LINQ, convirtiéndolo en la elección por defecto para análisis de frecuencia en bases de código modernas de C#.
