---
title: "Rendimiento en .NET 10: SearchValues"
description: "Usa SearchValues en .NET 10 para búsqueda multi-cadena de alto rendimiento. Reemplaza bucles foreach con coincidencias aceleradas por SIMD usando los algoritmos Aho-Corasick y Teddy."
pubDate: 2026-01-04
tags:
  - "dotnet"
  - "dotnet-10"
lang: "es"
translationOf: "2026/01/net-10-performance-searchvalues"
translatedBy: "claude"
translationDate: 2026-05-01
---
En .NET 8, Microsoft introdujo `SearchValues<T>`, un tipo especializado que optimizaba la búsqueda de un _conjunto_ de valores (como bytes o chars) dentro de un span. Vectorizaba la búsqueda, haciéndola significativamente más rápida que `IndexOfAny`.

En .NET 10, este poder se ha extendido a las cadenas. `SearchValues<string>` te permite buscar múltiples subcadenas de forma simultánea con un rendimiento increíble.

## El caso de uso: análisis y filtrado

Imagina que estás escribiendo un parser o un sanitizador que necesita verificar si un texto contiene alguna palabra o token de una lista específica de prohibidos.

**La forma antigua (lenta)**

```cs
private static readonly string[] Forbidden = { "drop", "delete", "truncate" };

public bool ContainsSqlInjection(ReadOnlySpan<char> input)
{
    foreach (var word in Forbidden)
    {
        if (input.Contains(word, StringComparison.OrdinalIgnoreCase))
            return true;
    }
    return false;
}
```

Esto es O(N \* M), donde N es la longitud de entrada y M es el número de palabras. Escanea la cadena repetidamente.

## La forma nueva: SearchValues

Con .NET 10, puedes precalcular la estrategia de búsqueda.

```cs
using System.Buffers;

// 1. Create the optimized searcher (do this once, statically)
private static readonly SearchValues<string> SqlTokens = 
    SearchValues.Create(["drop", "delete", "truncate"], StringComparison.OrdinalIgnoreCase);

public bool ContainsSqlInjection(ReadOnlySpan<char> input)
{
    // 2. Search for ANY of them in one pass
    return input.ContainsAny(SqlTokens);
}
```

## Impacto en el rendimiento

Bajo el capó, `SearchValues.Create` analiza los patrones.

-   Si comparten prefijos comunes, construye una estructura tipo trie.
-   Usa los algoritmos Aho-Corasick o Teddy según la densidad del patrón.
-   Aprovecha SIMD (AVX-512) para coincidir múltiples caracteres en paralelo.

Para un conjunto de 10 a 20 palabras clave, `SearchValues` puede ser **50 veces más rápido** que un bucle o una Regex.

## Encontrar la ubicación

No estás limitado a una comprobación booleana. Puedes encontrar _dónde_ ocurrió la coincidencia:

```cs
int index = input.IndexOfAny(SqlTokens);
if (index >= 0)
{
    Console.WriteLine($"Found distinct token at index {index}");
}
```

## Resumen

`SearchValues<string>` en .NET 10 trae búsqueda de texto de alto rendimiento al alcance de todos sin requerir bibliotecas externas. Si estás haciendo cualquier tipo de procesamiento de texto, análisis de registros o filtrado de seguridad, reemplaza tus bucles `foreach` por `SearchValues` de inmediato.
