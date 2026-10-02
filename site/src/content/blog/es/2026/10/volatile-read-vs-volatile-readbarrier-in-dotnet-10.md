---
title: "Volatile.Read vs Volatile.ReadBarrier en .NET 10"
description: "Volatile.Read es una carga acquire de una sola ubicación. Volatile.ReadBarrier, nuevo en .NET 10, es una barrera que da semántica acquire a todas las lecturas anteriores. Usa Volatile.Read para flags y referencias publicadas, y ReadBarrier cuando necesites que un lote de lecturas simples o no atómicas termine antes del siguiente acceso a memoria, como en un seqlock."
pubDate: 2026-10-02
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "concurrency"
  - "performance"
lang: "es"
translationOf: "2026/10/volatile-read-vs-volatile-readbarrier-in-dotnet-10"
translatedBy: "claude"
translationDate: 2026-10-02
---

`Volatile.Read(ref x)` lee una ubicación con semántica acquire: nada posterior en tu código puede moverse por encima de esa lectura. `Volatile.ReadBarrier()`, añadido en .NET 10, no lee nada. Es una barrera que da semántica acquire a **todas las lecturas anteriores**, de modo que todo un lote de lecturas simples (incluso no atómicas) debe terminar antes de cualquier acceso a memoria posterior a la barrera. Usa `Volatile.Read` para el caso común de un flag, un contador o una referencia publicada. Recurre a `ReadBarrier` cuando necesites que varias lecturas ordinarias, o una lectura demasiado grande para ser atómica, terminen antes de una nueva comprobación. El caso de manual es el lado lector de un seqlock.

Todo lo que sigue se midió en .NET 10.0.10 (SDK 10.0.302), C# 14, en un Apple M4 (arm64). Las APIs de barrera existen en `System.Threading.Volatile` desde .NET 10; en .NET 9 y anteriores no hay un equivalente público salvo `Interlocked.MemoryBarrier()`.

## La comparación de un vistazo

| | `Volatile.Read(ref x)` | `Volatile.ReadBarrier()` |
| --- | --- | --- |
| Disponible desde | .NET Framework 4.5 | .NET 10 |
| Lee un valor | Sí, una ubicación | No |
| Qué recibe semántica acquire | Esa única lectura | Todas las lecturas anteriores a la llamada |
| Impide que lecturas y escrituras posteriores suban | Sí | Sí |
| Hace atómica la lectura | Sí, para los tipos admitidos (incluidos `long`/`double` en 32 bits) | No, la atomicidad es problema tuyo |
| Funciona con cualquier `T`, structs, memoria nativa | No, conjunto fijo de sobrecargas | Sí, ordena cualquier lectura que la preceda |
| Código generado en arm64 (medido, .NET 10.0.10) | `ldapur` (load-acquire) | `dmb ishld` (barrera de carga) |
| Código generado en x64 | `mov` simple, solo ordenación del compilador | sin instrucción, solo ordenación del compilador |
| Uso típico | flags, inicialización con doble comprobación, referencias publicadas | seqlocks, cachés validadas por versión, lecturas por lotes |

## Qué prometen las dos APIs

La especificación del modelo de memoria de .NET (`docs/design/specs/Memory-model.md` en dotnet/runtime) lista ambas bajo "volatile reads have acquire semantics", con una nota reveladora sobre la barrera: "applies to all prior reads". Acquire significa que ninguna lectura ni escritura posterior en el orden del programa puede ejecutarse antes de la lectura acquire.

Con `Volatile.Read(ref _version)`, el acquire se asocia a la carga de `_version` y a nada más. Las lecturas que ocurrieron *antes* en el orden del programa no tienen ninguna restricción. Todavía pueden desplazarse por debajo de ella.

Con `Volatile.ReadBarrier()`, el acquire se asocia a toda carga que precede a la llamada. La propuesta de la API ([dotnet/runtime#98837](https://github.com/dotnet/runtime/issues/98837)) la llama una barrera `Read-ReadWrite`: todas las lecturas anteriores deben completarse antes de cualquier operación de memoria posterior. Su contraparte, `Volatile.WriteBarrier()`, es una barrera `ReadWrite-Write`: todas las operaciones de memoria anteriores se completan antes de cualquier escritura posterior.

Así que las dos APIs no son dos intensidades de lo mismo. Responden a preguntas distintas:

- `Volatile.Read`: "lee este valor y asegura que todo lo posterior vea una memoria al menos igual de reciente."
- `Volatile.ReadBarrier`: "asegura que todo lo que ya he leído esté terminado antes de volver a tocar la memoria."

Ninguna es una barrera completa. Una `ReadBarrier` no hace nada para evitar que una *escritura* anterior se reordene con una lectura posterior (el caso store-load). Si necesitas eso, sigues necesitando `Interlocked.MemoryBarrier()` o una operación `Interlocked`.

## Qué emite realmente el JIT

El JIT trata ambos métodos como intrínsecos. El código fuente de `Volatile.cs` es simplemente `[Intrinsic] public static void ReadBarrier() => ReadBarrier();`, y el importador reemplaza la llamada por un nodo de barrera de memoria marcado como solo de carga ([PR #107843](https://github.com/dotnet/runtime/pull/107843)). Para ver en qué se convierte, compilé una clase pequeña con todas las optimizaciones y volqué el resultado con `DOTNET_JitDisasm`:

```csharp
// .NET 10.0.10, C# 14
// DOTNET_TieredCompilation=0 DOTNET_JitDisasm='Codegen:*' dotnet vb.dll
sealed class Codegen
{
    private int _x;
    private long _a, _b, _c, _d;

    [MethodImpl(MethodImplOptions.NoInlining)]
    public long AcquireFour() =>
        Volatile.Read(ref _a) + Volatile.Read(ref _b) +
        Volatile.Read(ref _c) + Volatile.Read(ref _d);

    [MethodImpl(MethodImplOptions.NoInlining)]
    public long PlainFourThenBarrier()
    {
        long sum = _a + _b + _c + _d;
        Volatile.ReadBarrier();
        return sum;
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    public void BarrierThenPlainFour(long v)
    {
        Volatile.WriteBarrier();
        _a = v; _b = v; _c = v; _d = v;
    }
}
```

En el M4, las instrucciones interesantes fueron:

```text
; AcquireFour: four separate load-acquire instructions
ldapur  x1, [x0, #0x08]
ldapur  x2, [x0, #0x10]
ldapur  x2, [x0, #0x18]
ldapur  x0, [x0, #0x20]

; PlainFourThenBarrier: two paired loads, then one load fence
ldp     x1, x2, [x0, #0x08]
ldp     x2, x0, [x0, #0x18]
dmb     ishld

; BarrierThenPlainFour: a full fence, then two paired stores
dmb     ish
stp     x1, x1, [x0, #0x08]
stp     x1, x1, [x0, #0x18]
```

Destacan tres cosas.

Primero, `Volatile.Read` se compila a `ldapur`, una carga load-acquire RCpc (las extensiones RCpc llegaron con ARMv8.3 y v8.4), que el M4 admite. Los núcleos sin RCpc usan en su lugar el más antiguo `ldar`. En cualquier caso, no hay una instrucción de barrera separada.

Segundo, las lecturas simples antes de `ReadBarrier` siguen siendo simples, así que el JIT es libre de emparejarlas en `ldp` (y, para una copia de struct de 32 bytes, en un par de cargas `ldp q` de 128 bits). Con cuatro cargas acquire pierdes esa libertad. Ese es el argumento de eficiencia de la propuesta: una barrera para N lecturas en lugar de N lecturas ordenadas.

Tercero, `Volatile.WriteBarrier()` es un `dmb ish` completo en arm64, exactamente lo que emite `Interlocked.MemoryBarrier()`. El JIT tiene un comentario que dice que actualmente no puede emitir una barrera solo de almacenamiento mejor que una completa en arm64, así que no esperes que `WriteBarrier` sea más barata que una barrera completa ahí.

En x64, ambas barreras no emiten ninguna instrucción. El comentario de codegen del PR es explícito: las barreras solo de carga y solo de almacenamiento "are no-ops on xarch", porque el modelo TSO de x86 ya mantiene las cargas ordenadas respecto a las cargas y almacenamientos posteriores, y los almacenamientos ordenados respecto a las operaciones de memoria anteriores. Aun así importan en x64: impiden que el propio JIT reordene, almacene en caché o elimine accesos a memoria a través de la barrera. No tenía una máquina x64 para esta prueba, así que la fila de x64 de la tabla sale del código fuente del JIT, no de un desensamblado.

## Un seqlock: el caso para el que se creó ReadBarrier

El propio runtime fue el primer cliente. `GenericCache` y `CastCache` en CoreLib usaban un `Interlocked.ReadMemoryBarrier()` interno y se cambiaron a `Volatile.ReadBarrier()` en el mismo PR. Su comentario describe el patrón: "we must read in this order: version -> [entry parts] -> version".

Eso es un seqlock. Un único escritor incrementa una versión a un número impar, escribe los datos y luego la incrementa al siguiente número par. Los lectores leen la versión, copian los datos con cargas ordinarias y vuelven a leer la versión. Si ambas lecturas coinciden y son pares, la copia es consistente. Los datos pueden ser de cualquier tamaño: un struct de 32 bytes no es atómico en ninguna plataforma, y no pasa nada, porque la comprobación de versión detecta las copias rotas.

Esta es la versión mínima, con ambas barreras en los lugares que les corresponden:

```csharp
// .NET 10, C# 14
struct Snapshot { public long A, B, C, D; }

sealed class SeqLockBox
{
    private int _version;          // even = stable, odd = write in progress
    private Snapshot _data;

    // Single writer only.
    public void Write(long n)
    {
        int v = _version;
        _version = v + 1;          // mark "writing" (odd)
        Volatile.WriteBarrier();   // odd version is published before any data write below
        _data.A = n; _data.B = n; _data.C = n; _data.D = n;
        Volatile.Write(ref _version, v + 2); // release: data writes complete before the even version
    }

    public bool TryRead(out Snapshot snapshot)
    {
        int v1 = Volatile.Read(ref _version); // acquire: the data reads below cannot move above this
        snapshot = _data;                     // plain, non-atomic 32-byte copy
        Volatile.ReadBarrier();               // every read above completes before the re-check
        return (v1 & 1) == 0 && _version == v1;
    }
}
```

Fíjate en cómo usa el lector ambas APIs. La primera lectura de la versión es un `Volatile.Read`, porque necesitamos que las lecturas de datos se queden *por debajo* de ella. La copia de datos es simple. Después `ReadBarrier` mantiene las lecturas de datos *por encima* de la segunda lectura de la versión. Ningún `Volatile.Read` por sí solo puede expresar esa segunda restricción, porque `Volatile.Read` solo restringe lo que viene después de la ubicación que lee, y aquí lo que necesitamos ordenar es lo que vino antes.

El escritor es el reflejo. `Volatile.Write` sobre la versión par final es un release, así que las escrituras de datos no pueden hundirse por debajo de él. Pero un release no hace nada para impedir que las escrituras de datos suban por encima del almacenamiento anterior de la versión impar. `WriteBarrier` cubre ese lado.

## Demostrar que cada mitad es necesaria

Ejecuté el lector y el escritor en dos hilos durante cinco segundos por escenario y conté cuántos snapshots aceptados tenían `A`, `B`, `C`, `D` en desacuerdo. Cada escenario elimina una pieza de la ordenación:

```csharp
// .NET 10, C# 14: the reader variants in the stress test
public bool TryReadAcquireOnly(out Snapshot snapshot)   // no ReadBarrier
{
    int v1 = Volatile.Read(ref _version);
    snapshot = _data;
    return (v1 & 1) == 0 && _version == v1;
}

public bool TryReadBarrierOnly(out Snapshot snapshot)   // no acquire on the first read
{
    int v1 = _version;
    snapshot = _data;
    Volatile.ReadBarrier();
    return (v1 & 1) == 0 && _version == v1;
}
```

Resultados en el M4, .NET 10.0.10, compilación Release, dos ejecuciones:

| Escenario | Snapshots aceptados (ejecución 1 / ejecución 2) | Rotos y aceptados (ejecución 1 / ejecución 2) |
| --- | --- | --- |
| Sin ordenación alguna (lecturas simples) | 1,014,876,206 / 1,003,303,309 | 547,804 / 515,135 |
| Solo `Volatile.Read`, sin `ReadBarrier` | 164,358,676 / 152,032,561 | 99 / 357 |
| Solo `ReadBarrier`, primera lectura simple | 34,543,735 / 27,982,884 | 54 / 62 |
| Escritor sin `WriteBarrier`, lector correcto | 354,942,744 / 384,287,324 | 66,155,404 / 54,597,163 |
| Ambas barreras (el código de arriba) | 62,659,697 / 66,048,738 | 0 / 0 |

Cada medida a medias produjo datos rotos que pasaron la validación. Los casos raros son los peligrosos: 99 lecturas erróneas de 164 millones es el tipo de bug que sobrevive a todas las pruebas y aparece en producción en una máquina Graviton o Ampere. La falta de `WriteBarrier` fue el fallo más ruidoso, y el desensamblado muestra por qué: los dos métodos del escritor se compilan a código idéntico salvo por el único `dmb ish`, así que cada una de esas más de 54 millones de roturas es el núcleo arm64 haciendo visibles los almacenamientos de datos antes del almacenamiento de la versión impar.

En x64 muy probablemente verías cero roturas en la mayoría de estas filas, porque el hardware no reordena en esas direcciones. Precisamente por eso estos bugs llegan a producción. El código sigue siendo incorrecto en x64, ya que el JIT puede reordenar accesos simples, y se vuelve visiblemente incorrecto en cuanto se ejecuta en arm64.

## El JIT también reordena, no solo la CPU

La primera versión de mi arnés de estrés se colgó para siempre, y vale la pena mostrar por qué. El lector roto hacía un bucle hasta ver una versión par:

```csharp
// .NET 10, C# 14: do not do this
public void WaitForEvenBroken()
{
    while ((_version & 1) != 0) { }
}
```

El JIT compiló eso a una carga y un salto a sí mismo:

```text
ldr     w0, [x0, #0x08]
and     w0, w0, #1
G_M000_IG03:
cbnz    w0, G_M000_IG03
```

La carga de `_version` se sacó del bucle, lo cual es legal para una lectura de campo ordinaria sin sincronización intermedia. Si la primera lectura caía en una versión impar, el hilo gira para siempre. Un `Volatile.Read(ref _version)` dentro de la condición lo arregla, y también lo haría un `ReadBarrier` dentro del cuerpo del bucle. Esta es la parte de "volatile" que los desarrolladores de x64 sí experimentan, y es la razón por la que las barreras no son llamadas vacías incluso donde no emiten ninguna instrucción.

## Cuándo elegir Volatile.Read

- **Un flag o una señal de parada.** `while (!Volatile.Read(ref _stop))` es el caso canónico. Una ubicación, un valor, y quieres que las lecturas posteriores vean lo que el escritor publicó antes de activarlo.
- **Publicar una referencia.** El escritor construye un objeto y luego hace `Volatile.Write(ref _instance, obj)`; el lector hace `Volatile.Read(ref _instance)` y después lee campos a través de ella. El acquire sobre la lectura de la referencia es todo lo que necesitas.
- **Inicialización diferida con doble comprobación.** Misma forma que publicar, y la razón por la que `LazyInitializer` usa lecturas volatile internamente.
- **Apuntas a .NET 9 o anterior.** `ReadBarrier` no existe ahí.

En todos estos casos, la ordenación está anclada a una sola lectura, así que `Volatile.Read` dice exactamente lo que quieres decir y no genera ninguna barrera en ninguna de las dos arquitecturas.

## Cuándo elegir Volatile.ReadBarrier

- **Lectores de seqlock y cachés validadas por versión.** El patrón de arriba, y el que usan `CastCache` y `GenericCache` de CoreLib.
- **Datos que no se pueden leer de forma atómica.** Structs mayores que un puntero, `Int128`, spans de bytes o un struct con varios campos. No hay sobrecarga de `Volatile.Read` para ellos, y `ReadBarrier` te permite copiarlos con cargas ordinarias y validar después.
- **Lecturas de memoria nativa o a través de `Unsafe`.** Si lees mediante un puntero o un `ref` a un búfer no administrado, puede que no haya un campo administrado que pasar a `Volatile.Read`. La barrera ordena esas cargas igualmente.
- **Muchas lecturas que necesitan un único punto de ordenación.** Un `dmb ishld` después de N cargas simples en lugar de N cargas acquire, dejando que el JIT empareje las cargas simples.

## El costo, medido

Hay dos formas correctas de escribir el lector del seqlock sin `ReadBarrier`: hacer que cada lectura de datos sea un `Volatile.Read`, o usar un `Interlocked.MemoryBarrier()` completo donde va la barrera. Los comparé todos contra el lector sin ordenación (roto) con BenchmarkDotNet 0.15.8. Cada invocación hace 1 024 lecturas en un solo hilo del snapshot de 32 bytes, y la tabla informa el costo por lectura:

```csharp
// .NET 10.0.10, C# 14, BenchmarkDotNet 0.15.8, Apple M4 (arm64)
[Benchmark(OperationsPerInvoke = N)]
public long VolatileReadPlusReadBarrier()
{
    long sum = 0;
    for (int i = 0; i < N; i++)
    {
        int v1 = Volatile.Read(ref _version);
        Snapshot s = _data;
        Volatile.ReadBarrier();
        if ((v1 & 1) == 0 && _version == v1) sum += s.A + s.B + s.C + s.D;
    }
    return sum;
}
```

| Lector (por lectura de snapshot) | Media | Ratio |
| --- | --- | --- |
| Sin ordenación (roto) | 0.916 ns | 1.00 |
| `Volatile.Read` en la versión y en los cuatro campos | 1.135 ns | 1.24 |
| `Volatile.Read` + `Volatile.ReadBarrier` | 0.929 ns | 1.01 |
| `Volatile.Read` + `Interlocked.MemoryBarrier` | 0.930 ns | 1.02 |

La versión con barrera cuesta casi lo mismo que la rota. La versión con todo volatile es aproximadamente un 24% más lenta, sobre todo porque cuatro cargas `ldapur` ordenadas no se pueden fusionar en dos cargas anchas como sí puede la copia simple. Si lo escalas a un struct mayor, la diferencia crece con el número de campos, mientras que la barrera sigue siendo una instrucción.

Dos salvedades honestas. Este es un bucle sin contención y de un solo hilo: un `dmb` es barato cuando el núcleo no tiene tráfico de memoria pendiente que esperar, y por eso la barrera completa también parece gratis aquí. Bajo contención de escritura real, una barrera completa suele costar más que una solo de carga, pero no ejecuté un benchmark con contención, así que no pongo una cifra a eso. Y todo esto es arm64. En x64 ambas barreras no emiten ninguna instrucción, así que solo estás comparando lo que el JIT puede hacer a su alrededor.

## Trampas que muerden

**La ubicación lo es todo.** `ReadBarrier` ordena las lecturas *anteriores* a ella respecto a los accesos *posteriores*. Ponerla al inicio de un lector, donde por instinto se pone una lectura "volatile", no ordena nada que te importe. En un seqlock va después de la copia de datos y antes de la segunda lectura de la versión.

**No es una barrera completa.** Un almacenamiento seguido de `ReadBarrier` seguido de una carga aún puede reordenarse. El código estilo Dekker, donde cada hilo escribe su propio flag y luego lee el del otro, necesita `Interlocked.MemoryBarrier()` o una operación `Interlocked`.

**No hace nada atómico.** La especificación del modelo de memoria es tajante: la semántica volatile no implica atomicidad. Si omites la validación de la versión, una barrera ordenará felizmente una lectura rota.

**No es un lock.** Un seqlock como el escrito admite exactamente un escritor. Dos escritores necesitan serializarse con un `Interlocked.CompareExchange` sobre la versión (que es lo que hace `GenericCache`) o con un lock de verdad. Si recurres a barreras porque un lock te pareció lento, mide primero: el artículo sobre [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock](/es/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) muestra lo barato que ya es un lock sin contención.

**Los campos `volatile` de C# no son la misma herramienta.** Un campo `volatile` hace que el compilador de C# emita cada acceso con el prefijo IL `volatile.`, de modo que cada lectura es un acquire y cada escritura es un release. Esa es semántica de `Volatile.Read`/`Volatile.Write` por acceso, nunca una barrera sobre un lote, y desactiva el emparejamiento de cargas mostrado arriba.

## El veredicto

Usa `Volatile.Read` por defecto. Es la herramienta correcta para casi todo patrón lock-free de flag, publicación e inicialización diferida, no cuesta nada en x64 y en arm64 moderno es una sola instrucción load-acquire. Usa `Volatile.ReadBarrier` (en .NET 10 y posterior) solo cuando lo que necesitas ordenar es un lote de lecturas anteriores, normalmente una copia no atómica que validas después. Cuando lo hagas, combínala con `Volatile.WriteBarrier` en el lado del escritor, prueba en arm64 y recuerda que en arm64 `WriteBarrier` es tan cara como una barrera completa.

## Relacionado

- [Cómo usar el nuevo tipo System.Threading.Lock](/es/2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11/), la respuesta correcta cuando en realidad no necesitas código lock-free.
- [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock en C#](/es/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) para elegir una primitiva de sincronización.
- [Cómo cancelar una Task de larga duración sin interbloqueos](/es/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/), donde un `Volatile.Read` está detrás de cada comprobación de cancelación.
- [record vs class vs struct en C#](/es/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/), relevante cuando tu estado compartido es un struct de varios campos que no se puede leer de forma atómica.

## Fuentes

- [Volatile.ReadBarrier method](https://learn.microsoft.com/en-us/dotnet/api/system.threading.volatile.readbarrier?view=net-10.0) y [Volatile class](https://learn.microsoft.com/en-us/dotnet/api/system.threading.volatile?view=net-10.0) en MS Learn.
- [API proposal: Volatile barrier APIs, dotnet/runtime#98837](https://github.com/dotnet/runtime/issues/98837).
- [Implement volatile barrier APIs, dotnet/runtime#107843](https://github.com/dotnet/runtime/pull/107843), incluido el codegen del JIT y los cambios en las cachés de CoreLib.
- [.NET memory model specification](https://github.com/dotnet/runtime/blob/main/docs/design/specs/Memory-model.md).
- [GenericCache.cs on release/10.0](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/Runtime/CompilerServices/GenericCache.cs), un lector de seqlock de producción que usa `Volatile.ReadBarrier`.
