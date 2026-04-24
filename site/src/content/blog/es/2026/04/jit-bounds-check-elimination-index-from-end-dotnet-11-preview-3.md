---
title: "RyuJIT poda más bounds checks en .NET 11 Preview 3: index-from-end y i + constante"
description: ".NET 11 Preview 3 enseña a RyuJIT a eliminar bounds checks redundantes en accesos consecutivos index-from-end y en patrones i + constante < length, reduciendo presión de branches en loops apretados."
pubDate: 2026-04-19
tags:
  - "dotnet"
  - "dotnet-11"
  - "jit"
  - "performance"
  - "csharp"
lang: "es"
translationOf: "2026/04/jit-bounds-check-elimination-index-from-end-dotnet-11-preview-3"
translatedBy: "claude"
translationDate: 2026-04-24
---

La eliminación de bounds check es la optimización del JIT que decide silenciosamente cuán rápido es mucho del código .NET. Cada `array[i]` y `span[i]` en código managed lleva un compare-and-branch implícito, y cuando RyuJIT puede probar que el índice está en rango, ese branch desaparece. .NET 11 Preview 3 extiende esa prueba a dos patrones comunes que antes pagaban el check igual.

Ambos cambios están documentados en las [release notes del runtime](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/runtime.md) y destacados en el [anuncio de .NET 11 Preview 3](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/) del 14 de abril de 2026.

## Acceso back-to-back index-from-end

El operador index-from-end `^1`, `^2`, introducido con C# 8, es syntactic sugar para `Length - 1`, `Length - 2`. El JIT ha podido elidir el bounds check en el primer acceso por un tiempo, pero un segundo acceso justo después era a menudo tratado independientemente y forzaba un compare-and-branch redundante.

En .NET 11 Preview 3, el análisis de rango reusa la prueba de length a través de accesos consecutivos index-from-end:

```csharp
static int TailSum(int[] values)
{
    // .NET 10: two bounds checks, one per access.
    // .NET 11 Preview 3: the JIT proves both are in range from a single length test.
    return values[^1] + values[^2];
}
```

Si desensamblas `TailSum` en el [ASM viewer de Rider 2026.1](https://blog.jetbrains.com/dotnet/), puedes ver que el segundo par `cmp`/`ja` simplemente desaparece. Código que recorre la cola de un buffer, accessors de ring-buffer, parsers que espían el último token, o comparadores de ventana fija, todos se benefician sin cambio de source.

## Loops `i + constante < length`

La segunda mejora apunta a un patrón que aparece constantemente en código numérico y de parsing. Un loop de stride-2 solía lucir bien en papel pero seguía pagando un bounds check en el segundo acceso:

```csharp
static int SumPairs(ReadOnlySpan<int> buffer)
{
    int sum = 0;
    for (int i = 0; i + 1 < buffer.Length; i += 2)
    {
        // buffer[i] is trivially safe, but buffer[i + 1] used to
        // get its own bounds check, even though the loop condition
        // already proved it.
        sum += buffer[i] + buffer[i + 1];
    }
    return sum;
}
```

La condición de loop `i + 1 < buffer.Length` ya prueba que `buffer[i + 1]` está en rango, pero RyuJIT solía tratar los dos accesos independientemente. Preview 3 enseña al análisis a razonar sobre un índice más una constante pequeña contra un length, así que ambos `buffer[i]` y `buffer[i + 1]` compilan a un load plano.

La misma reescritura aplica a `i + 2`, `i + 3`, y así, mientras el offset constante coincida con lo que garantiza la condición de loop. Ensancha la condición de loop a `i + 3 < buffer.Length`, y un inner loop stride-4 se vuelve bounds-check-free en los cuatro accesos.

## Por qué branches pequeños suman

Un único bounds check cuesta menos de un nanosegundo en CPUs modernas. La presión real es de segundo orden: el slot de branch que consume, las decisiones de loop-unrolling que bloquea, las oportunidades de vectorización que derrota. Cuando RyuJIT prueba que un inner loop completo es bounds-safe, es libre de desenrollar más agresivamente y entregar el bloque al auto-vectorizador. Ahí es donde una micro-ganancia de 1% en papel se convierte en una mejora de 10 a 20% en un kernel numérico real.

## Probándolo hoy

Ninguna optimización necesita un feature flag. Corre cualquier SDK de .NET 11 Preview 3 y se activan automáticamente. Setea `DOTNET_JitDisasm=TailSum` para dumpear el código generado, corre una vez en .NET 10 y una en Preview 3, y diff. Si mantienes hot loops sobre arrays o spans, especialmente cualquier cosa que espíe el final de un buffer o camine con un stride fijo, este es un speedup gratis esperando en Preview 3.
