---
title: "Bucle con ref T vs indexación de Span<T> en C#: por qué la versión con span es igual de rápida o más en .NET 10"
description: "En .NET 10, un bucle for normal sobre span[i] acotado por span.Length se compila a un bucle sin comprobación de límites, con reducción de intensidad y cuenta regresiva. Un bucle escrito a mano con Unsafe.Add(ref r, i) y un índice int conserva una extensión de signo y una comparación con cuenta progresiva, y midió entre 2 y 5% más lento. Benchmarks y desensamblado del JIT para arm64 y x64 en .NET 10.0.10."
pubDate: 2026-10-30
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "performance"
  - "span"
  - "jit"
lang: "es"
translationOf: "2026/10/ref-t-loop-vs-span-t-indexing-in-csharp"
translatedBy: "claude"
translationDate: 2026-10-30
---

En .NET 10, escribe el bucle como `for (int i = 0; i < span.Length; i++) sum += span[i];` y quédate ahí. El JIT demuestra que cada índice está dentro del rango, elimina la comprobación de límites, reescribe el índice como un desplazamiento en bytes que incrementa de 4 en 4 (reducción de intensidad) y convierte el bucle en un contador regresivo que termina en un único `dec`/`jne` (o `sub`/`cbnz` en Arm64). La versión "más rápida" escrita a mano, `sum += Unsafe.Add(ref r, i)` con un índice `int`, no recibe ese tratamiento. Conserva el contador `int`, lo extiende con signo a un desplazamiento de tamaño nativo en cada iteración y compara contra la longitud al final del bucle. En mis mediciones con .NET 10.0.10, eso hizo que el bucle con `Unsafe.Add` fuera **2.4% más lento con 4 096 elementos y 3.6% más lento con 1 000 000 de elementos** que el bucle seguro con span. Cambiar el contador del bucle con `ref` a `nint` cierra la brecha por completo, y un recorrido `ref` que avanza el puntero empata con el bucle con span. Así que el código con `ref T` solo puede empatar con el bucle con span en .NET 10. Nunca gana, y renuncia a la seguridad de memoria para llegar ahí.

Todo lo que sigue se midió con BenchmarkDotNet 0.15.8 en .NET 10.0.10 (SDK 10.0.302), C# 14, en un Apple M4 con macOS 27.0.1. Los listados de Arm64 son el código Tier1 real de esa ejecución, capturado con `DOTNET_JitDisasm`. Los listados de x64 provienen de crossgen2 10.0.10 con destino `win-x64`, que ejecuta el mismo RyuJIT con todas las optimizaciones pero sin Dynamic PGO. Las optimizaciones de bucles que explican el resultado llegaron en [.NET 9](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-9/runtime#loop-optimizations), así que todo aquí aplica también a .NET 9.

## La comparación de un vistazo

| Forma del bucle | Comprobación de límites en el bucle | Aritmética de índice por iteración | 4 096 ints | 1 000 000 ints |
| --- | --- | --- | ---: | ---: |
| `for` sobre `array[i]` | Eliminada | Desplazamiento con reducción de intensidad, cuenta regresiva | 1 035.6 ns | 251.9 us |
| `for` sobre `span[i]`, límite `span.Length` | Eliminada | Desplazamiento con reducción de intensidad, cuenta regresiva | 1 035.9 ns | 254.4 us |
| `foreach (ref readonly int x in span)` | Eliminada | Igual que arriba | 1 035.6 ns | 254.5 us |
| `for` sobre `span[i]`, el límite es un parámetro `n` | Sacada del bucle por la clonación de bucles | Igual que arriba en el clon rápido | 1 035.4 ns | 254.5 us |
| `Unsafe.Add(ref r, i)`, `int i` | Ninguna (nunca la tuvo) | Extensión de signo + comparación con cuenta progresiva | 1 060.1 ns | 263.7 us |
| `Unsafe.Add(ref r, i)`, `nint i` | Ninguna | Reducción de intensidad, cuenta regresiva | 1 036.1 ns | 254.7 us |
| Recorrido `ref` con `Unsafe.IsAddressLessThan` | Ninguna | Puntero con post-incremento | 1 035.3 ns | 251.4 us |
| `Enumerable.Sum(int[])` | n/a | Vectorizado | 506.9 ns | 128.6 us |

Cada bucle suma un `int[]`. Las barras de error son todas menores a 1.5 ns con 4 096 elementos y menores a 0.8 us con un millón. Volví a ejecutar las filas de span y `ref` en una segunda sesión separada de BenchmarkDotNet, y cada media quedó a menos de 0.6 ns (4 096) y 0.1 us (un millón) de la primera ejecución. La última fila está ahí para mantener el resultado en proporción: el bucle escalar más rápido sigue teniendo la mitad de la velocidad de uno vectorizado.

## Los dos bucles que la gente realmente compara

La pregunta suele surgir después de que alguien lee el código fuente de la BCL, ve `ref T` y `Unsafe.Add` por todas partes y reescribe un bucle crítico para imitarlo. Aquí están las dos formas lado a lado:

```csharp
// .NET 10.0.10, C# 14
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

static int SpanFor(ReadOnlySpan<int> s)
{
    int sum = 0;
    for (int i = 0; i < s.Length; i++) sum += s[i];
    return sum;
}

static int RefAdd(ReadOnlySpan<int> s)
{
    int sum = 0;
    ref int r = ref MemoryMarshal.GetReference(s);
    for (int i = 0; i < s.Length; i++) sum += Unsafe.Add(ref r, i);
    return sum;
}
```

La intuición detrás de `RefAdd` es que `s[i]` tiene una comprobación de límites y `Unsafe.Add` no, así que la versión con `ref` debe ser más rápida. En .NET Core 2.1 esa intuición solía ser correcta. Desde entonces, el JIT aprendió a eliminar la comprobación de límites de exactamente esta forma de bucle, y en .NET 9 aprendió tres trucos más que solo se aplican cuando entiende por completo la variable de índice. El bucle con span recibe todos. El bucle con `Unsafe.Add` queda fuera del patrón.

## Qué hace el JIT con el bucle con span

Este es el código Tier1 de Arm64 para `SpanFor`, directo de `DOTNET_JitDisasm` en .NET 10.0.10:

```asm
; Kernels:SpanFor(System.ReadOnlySpan`1[int]):int (Tier1), .NET 10.0.10 Arm64
            mov     w2, wzr            ; sum = 0
            cmp     w1, #0             ; length <= 0 ?
            ble     G_M000_IG05
            mov     x3, xzr            ; byte offset = 0
G_M000_IG04:
            ldr     w4, [x0, x3]       ; load s[i]
            add     w2, w4, w2         ; sum += ...
            add     x3, x3, #4         ; offset += 4
            sub     w1, w1, #1         ; remaining--
            cbnz    w1, G_M000_IG04    ; loop while remaining != 0
```

En ese bucle se ven tres optimizaciones distintas:

1. **Eliminación de la comprobación de límites.** No hay comparación contra la longitud ni llamada a `CORINFO_HELP_RNGCHKFAIL`. Como `i` empieza en 0, solo incrementa y está protegido por `i < s.Length`, el análisis de rangos del JIT demuestra que `s[i]` siempre es válido. Esta es la parte que todos conocen, y funciona con spans desde .NET Core 2.1.
2. **Reducción de intensidad.** El código fuente multiplica `i` por 4 para obtener una dirección. El bucle, en cambio, mantiene un desplazamiento en bytes en `x3` y le suma 4. Las notas del runtime de .NET 9 describen esto como que el JIT convierte "automáticamente" el acceso indexado a esta forma.
3. **Dirección del contador del bucle.** El `i` original desaparece. Una vez que la dirección ya no depende de `i`, el contador solo controla el número de iteraciones, así que el JIT cuenta la longitud hacia atrás hasta cero y termina el bucle con `cbnz` en lugar de una comparación y un salto separados.

En x64 el mismo método se compila a cuatro instrucciones en el cuerpo del bucle:

```asm
; Kernels:SpanFor, crossgen2 10.0.10, win-x64, full opts
G_M000_IG04:
       add      edx, dword ptr [rax+r8]
       add      r8, 4
       dec      ecx
       jne      SHORT G_M000_IG04
```

Es todo lo ajustado que puede ser un bucle de suma escalar. No queda ninguna instrucción que una reescritura con `ref` pueda eliminar.

## Qué hace el JIT con el bucle con `Unsafe.Add`

Ahora `RefAdd`, en la misma máquina, en la misma ejecución:

```asm
; Kernels:RefAdd(System.ReadOnlySpan`1[int]):int (Tier1), .NET 10.0.10 Arm64
G_M000_IG03:
            ldr     w4, [x0, w3, SXTW #2]   ; load r[(nint)i * 4]
            add     w2, w4, w2
            add     w3, w3, #1              ; i++
            cmp     w3, w1                  ; i < length ?
            blt     G_M000_IG03
```

```asm
; Kernels:RefAdd, crossgen2 10.0.10, win-x64, full opts
G_M000_IG05:
       movsxd   r8, ecx                     ; sign-extend i to 64 bits
       add      esi, dword ptr [rax+4*r8]
       inc      ecx
       cmp      ecx, edx
       jl       SHORT G_M000_IG05
```

El bucle no tiene comprobación de límites, pero el bucle con span tampoco la tenía, así que eso no aporta nada. Lo que perdió es la reducción de intensidad y la cuenta regresiva. `Unsafe.Add<T>(ref T source, int elementOffset)` convierte el desplazamiento `int` a un entero nativo antes de escalarlo. Esa extensión de signo queda entre la variable de inducción y la dirección, y el JIT no reescribe a través de ella. Así que el bucle conserva `i` como contador de 32 bits, vuelve a derivar la dirección a partir de él en cada iteración (`SXTW #2` en Arm64, un `movsxd` explícito en x64) y necesita una comparación real contra la longitud al final.

En Arm64 la extensión de signo se integra en el modo de direccionamiento de la carga, así que el número de instrucciones coincide con el del bucle con span. Aun así midió más lento, de forma consistente, en ambas ejecuciones. La diferencia visible es la salida del bucle: un `cmp` explícito del contador incrementado contra la longitud, en lugar del `cbnz` fusionado del contador regresivo. No perfilé por debajo del nivel de instrucciones, así que toma eso como la causa probable, no como una demostrada. En x64 simplemente hay una instrucción extra por elemento. Ninguna de las dos diferencias es grande, y ese es el punto: la versión escrita a mano te cuesta seguridad y aun así pierde unos pocos puntos porcentuales.

## Cómo arreglar el bucle con `ref`, si de verdad necesitas uno

Hay dos formas de escribir un bucle con `ref` que iguale al bucle con span. La primera es hacer el índice de tamaño nativo, para que no haya nada que extender con signo:

```csharp
// .NET 10.0.10, C# 14
static int RefAddNint(ReadOnlySpan<int> s)
{
    int sum = 0;
    ref int r = ref MemoryMarshal.GetReference(s);
    for (nint i = 0; i < s.Length; i++) sum += Unsafe.Add(ref r, i);
    return sum;
}
```

El código Tier1 de Arm64 para esto es instrucción por instrucción el mismo que `SpanFor` (`ldr w4, [x0, x3]`, `add x3, x3, #4`, `sub x1, x1, #1`, `cbnz`), y midió 1 036.1 ns contra los 1 035.7 ns del bucle con span. La salida de crossgen2 para x64 también es el mismo cuerpo de cuatro instrucciones.

La segunda es el recorrido que avanza el puntero, que usa mucho código de alto rendimiento más antiguo:

```csharp
// .NET 10.0.10, C# 14
static int RefWalk(ReadOnlySpan<int> s)
{
    int sum = 0;
    ref int p = ref MemoryMarshal.GetReference(s);
    ref int end = ref Unsafe.Add(ref p, s.Length);
    while (Unsafe.IsAddressLessThan(ref p, ref end))
    {
        sum += p;
        p = ref Unsafe.Add(ref p, 1);
    }
    return sum;
}
```

En Arm64 este usa direccionamiento post-indexado (`ldr w3, [x0], #0x04`, carga y avance en una sola instrucción), así que el cuerpo del bucle tiene cuatro instrucciones en lugar de cinco. Fue la fila más rápida con un millón de elementos por cerca de 1%, que está dentro del ruido que verías entre dos máquinas distintas. Ese es el mejor caso para el código `ref` escrito a mano en .NET 10: un empate de 1%, a cambio de código donde un error de uno lee o escribe memoria fuera del span sin ninguna excepción. Ten en cuenta también que `end` es una referencia administrada un elemento más allá del final del búfer. Las [mejores prácticas de código unsafe](https://learn.microsoft.com/en-us/dotnet/standard/unsafe-code/best-practices) dicen que no se deben crear punteros administrados inválidos aunque nunca se desreferencien, y dejan las reglas exactas de validez a ECMA-335. Ese no es un terreno donde quieras estar por una ganancia de 1%.

Si escribes `foreach (ref readonly int x in span)` porque oíste que es el "bucle ref", se compila al mismo código que el bucle indexado con span. El compilador de C# convierte un `foreach` sobre un span en un `for` indexado sobre el span, así que el JIT ve la misma forma.

## Dónde el bucle con span pierde su ventaja

El bucle con span es rápido porque el JIT puede demostrar cosas sobre él. Rompe la demostración y el bucle cambia de forma. La manera más común es acotar el bucle con algo distinto de `span.Length`:

```csharp
// .NET 10.0.10, C# 14
static int SpanForN(ReadOnlySpan<int> s, int n)
{
    int sum = 0;
    for (int i = 0; i < n; i++) sum += s[i];   // n is not s.Length
    return sum;
}
```

Ahora `s[i]` realmente puede estar fuera de rango. El JIT de Tier1 lo maneja con **clonación de bucles**: emite una comprobación `n <= s.Length` antes del bucle, un clon rápido sin comprobación de límites para cuando se cumple, y un clon lento que comprueba en cada iteración y lanza `IndexOutOfRangeException` en el primer índice inválido. El clon rápido en mi listado de Arm64 es idéntico a `SpanFor`, por eso la fila del benchmark empata. La salida de crossgen2 para x64 del mismo método no clonó y mantuvo un `cmp`/`jae` en el bucle. Así que si un método como este se ejecuta desde código ReadyToRun antes de que la compilación por niveles lo reemplace, paga la comprobación. La solución es darle tú mismo la demostración al JIT: `s = s[..n];` antes del bucle, y luego iterar hasta `s.Length`. El slice hace una sola comprobación de límites al inicio, y cada iteración posterior es gratis.

El mismo truco importa cuando hay dos spans:

```csharp
// .NET 10.0.10, C# 14
static void CopyX2(ReadOnlySpan<int> src, Span<int> dst)
{
    dst = dst[..src.Length];                    // one check here...
    for (int i = 0; i < src.Length; i++)
        dst[i] = src[i] * 2;                    // ...none in the loop
}
```

Sin el slice, `dst[i]` no está cubierto por la guarda `i < src.Length`. Tier1 también clonó ese bucle (un `cmp w1, w3` / `bgt` antes de la entrada selecciona la copia con o sin comprobación), así que las tres variantes (sin slice, con slice y una versión con `Unsafe.Add` con una comprobación manual de longitud) midieron dentro de 1% entre sí con 4 096 elementos. Con 64 elementos, la versión con `Unsafe.Add` y su comprobación inicial de `ArgumentException` fue la más lenta de las tres, con 20.1 ns contra 16.8 ns del bucle con span con slice. Aun así, el slice es la versión que conviene escribir, porque no depende de heurísticas de clonación y dice lo que el método requiere.

Si quieres ver las comprobaciones por ti mismo, el post anterior sobre [la eliminación de comprobaciones de límites para el acceso desde el final en .NET 11](/es/2026/04/jit-bounds-check-elimination-index-from-end-dotnet-11-preview-3/) explica cómo leer `CORINFO_HELP_RNGCHKFAIL` en un listado, y [el visor de ASM de Rider](/es/2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly/) muestra el mismo código sin variables de entorno.

## Cómo verificar esto en tu propio código

La propia guía de Microsoft en las [mejores prácticas de código unsafe](https://learn.microsoft.com/en-us/dotnet/standard/unsafe-code/best-practices) es directa: los beneficios de eliminar comprobaciones de límites de forma unsafe "are often transient", así que verifica si el JIT actual todavía lo necesita y reescribe en código seguro si no. Bastan dos comandos para comprobarlo:

```bash
# .NET 10 SDK, any OS
DOTNET_JitDisasm="SpanFor RefAdd" DOTNET_JitStdOutFile=jit.txt dotnet run -c Release
dotnet run -c Release -- --filter '*SpanFor*' '*RefAdd*'   # BenchmarkDotNet
```

Cosas que te engañarán mientras lo haces:

- **Código Tier0.** El primer listado que se imprime para un método es código Tier0 sin optimizar, donde `s[i]` es una llamada real con una comprobación real. Busca el listado marcado como `Tier1`. El post sobre [cómo funciona la compilación por niveles](/es/2026/07/what-is-tiered-compilation-and-how-do-i-reason-about-it/) explica cuándo se ejecuta cada nivel y qué hace OSR con los bucles de larga duración.
- **Listados de ReadyToRun y crossgen2.** El código precompilado no tiene PGO y puede conservar llamadas que Tier1 integra. Mis listados de x64 llaman a `MemoryMarshal.GetReference` fuera de línea, muy probablemente porque crossgen2 no integra a través de la burbuja de versiones hacia `System.Private.CoreLib`. Los cuerpos de los bucles siguen siendo representativos, pero el prólogo no.
- **Microbenchmarks que ocultan el bucle.** Marca el kernel con `[MethodImpl(MethodImplOptions.NoInlining)]` para que el JIT lo compile como su propio método, y lee el listado de ese método, no el del wrapper del benchmark.
- **Línea base equivocada.** Si el objetivo real es el throughput, compara contra una versión vectorizada. `Enumerable.Sum` sobre un `int[]` corrió al doble de velocidad que todos los bucles escalares aquí, y `Vector<T>` o `TensorPrimitives` te llevan ahí para operaciones personalizadas.

## Cómo elegir entre ellos

Usa el bucle indexado sobre span (o array) acotado por `.Length` como opción por defecto. Es seguro, es para lo que está afinado el optimizador de bucles del JIT, y en .NET 10 nunca es más lento que las alternativas con `ref` en ninguna de estas mediciones. Cuando el límite es otra cosa, haz un slice primero para que el límite pase a ser `.Length`.

Recurre a `ref T` y `Unsafe.Add` solo cuando tengas un listado que muestre una comprobación de límites que el JIT no puede eliminar, y un benchmark que muestre que la comprobación importa. Cuando lo hagas, usa un índice `nint` o un recorrido con puntero, no un índice `int`, o perderás la reducción de intensidad que el bucle con span obtuvo gratis. Si estás tomando decisiones de `ref` y slicing para toda una API, [`List<T>` vs `Span<T>` vs `ReadOnlySpan<T>`](/es/2026/05/list-vs-span-vs-readonlyspan-in-csharp/) cubre qué tipo aceptar en primer lugar, [qué es `Span<T>` y cuándo hace más rápido el código](/es/2026/06/what-is-span-and-when-does-it-make-my-code-faster/) cubre los otros dos lugares donde los spans realmente rinden, e [iterar dos colecciones en paralelo sin asignaciones](/es/2026/10/how-to-iterate-over-two-collections-in-lockstep-without-heap-allocations-in-csharp/) aplica el patrón de hacer slice para demostrar los límites a un bucle con dos entradas.

## Fuentes

- [What's new in the .NET 9 runtime: loop optimizations](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-9/runtime#loop-optimizations) (ampliación de variables de inducción, direccionamiento post-indexado, reducción de intensidad, dirección del contador del bucle)
- [What's new in the .NET 10 runtime](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-10/runtime) (inversión de bucles mejorada, de la que dependen la clonación de bucles y las optimizaciones de variables de inducción)
- [Unsafe code best practices](https://learn.microsoft.com/en-us/dotnet/standard/unsafe-code/best-practices) (sección 9, eliminación unsafe de comprobaciones de límites; sección 4, punteros administrados inválidos)
- [Referencia de API de la clase `Unsafe`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.unsafe)
- [BenchmarkDotNet](https://benchmarkdotnet.org/)
