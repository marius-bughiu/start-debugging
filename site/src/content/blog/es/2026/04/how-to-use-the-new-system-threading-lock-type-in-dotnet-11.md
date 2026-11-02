---
title: "Cómo usar System.Threading.Lock en .NET"
description: "Usa System.Threading.Lock para secciones críticas síncronas desde .NET 9. Conoce su compilación, los límites de await y la diferencia con Monitor."
pubDate: 2026-04-30
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "concurrency"
template: "how-to"
lang: "es"
translationOf: "2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-04-30
---

`System.Threading.Lock` apareció en .NET 9. Desde C# 13, una instrucción `lock` cuya expresión tiene ese tipo estático usa `EnterScope()` en lugar de la ruta basada en `Monitor`. Sirve para exclusión mutua síncrona dentro de un proceso; el código `lock(object)` existente no se migra automáticamente.

**Corrección — 2 de noviembre de 2026:** la versión anterior afirmaba erróneamente que los SyncBlocks nunca se recuperan y que `EnterScope()` puede abarcar un `await`. También exageraba las ventajas de memoria y rendimiento. Los ejemplos del compilador se comprobaron con el SDK 10.0.302 y C# 14; no se afirma haberlos ejecutado en .NET 11.

## Un bloqueo privado con tipo explícito

```csharp
using System.Threading;

public sealed class Counter
{
    private readonly Lock _gate = new();
    private int _value;

    public int Next()
    {
        lock (_gate)
        {
            return ++_value;
        }
    }
}
```

El compilador genera un ámbito que libera el bloqueo incluso si el cuerpo lanza una excepción. `Lock.Scope` es un `ref struct`, no un objeto desechable asignado en el heap. `Lock` sí es un tipo por referencia y permite entradas recursivas del mismo hilo. Cada `Enter()` o `TryEnter()` exitoso requiere un `Exit()` en ese hilo; usa `try/finally` con esas API manuales.

## No mezcles Lock y Monitor

`lock (_gate)` y `Monitor.Enter(_gate)` usan mecanismos de sincronización diferentes. Una expresión de tipo `object` o `dynamic` usa el bloqueo de Monitor, salvo que se convierta explícitamente a `Lock`. Mezclar ambas rutas puede dejar los datos compartidos sin sincronización.

CS9216 advierte sobre algunas conversiones visibles estáticamente en la expresión, como `lock ((object)gate)`. No garantiza detectar todas las rutas indirectas ni las llamadas explícitas a `Monitor`. Mantén el bloqueo privado y su tipo visible. Usa `using System.Threading;` o el nombre completo; `using static System.Threading;` es inválido porque `System.Threading` es un espacio de nombres.

## Await necesita otro enfoque

El compilador rechaza un `await` dentro de `lock`. Tampoco permite conservar un `Lock.Scope` a través de un `await`; cambiar a `using` no evita esa restricción:

```csharp
// Does not compile: CS4007 on .NET SDK 10.0.302, C# 14.
using System.Threading;
using System.Threading.Tasks;

public static class InvalidExample
{
    public static async Task InvalidAsync()
    {
        Lock gate = new();
        using (gate.EnterScope())
        {
            await Task.Delay(10);
        }
    }
}
```

Mantén breve la sección crítica síncrona. Si necesitas serializar trabajo asíncrono, un `SemaphoreSlim(1, 1)` compartido es una opción adecuada:

```csharp
using System;
using System.Threading;
using System.Threading.Tasks;

public static class AsyncOperations
{
    public static async Task RunExclusiveAsync(
        SemaphoreSlim gate, Func<Task> work, CancellationToken cancellationToken)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            await work();
        }
        finally
        {
            gate.Release();
        }
    }
}
// Share a SemaphoreSlim(1, 1) between callers of this operation.
```

Tampoco combines `Lock.Enter()`/`Exit()` manualmente a través de un `await`: el bloqueo pertenece al hilo y la continuación puede ejecutarse en otro. En el ejemplo comprobado con C# 14 sí compiló un bloque síncrono que terminaba antes de un await posterior.

## SyncBlocks y rendimiento

Monitor puede usar la cabecera del objeto y, cuando hace falta, un SyncBlock asociado. La contención no implica que cada objeto obtenga inmediatamente un SyncBlock permanente. CoreCLR tiene rutas de limpieza, un conjunto de SyncBlocks libres y una lista de entradas de tabla reutilizables. Reutilizar entradas no equivale a devolver toda la capacidad de la tabla al sistema operativo.

`Lock` no usa ese mismo mecanismo de monitor de objeto para sus propias adquisiciones, pero eso no demuestra un ahorro fijo por objeto ni un multiplicador universal de rendimiento. Mide tu runtime, la contención y el trabajo protegido. Ambas API son reentrantes; ninguna ofrece una garantía general de equidad.

En destinos anteriores sin `System.Threading.Lock`, conserva un bloqueo `object` o usa compilación condicional para .NET 9 y posteriores. Ni `Lock` ni un semáforo local coordinan procesos distintos. Además, un constructor mutable como `ImmutableArray<T>.Builder` no admite modificaciones concurrentes automáticamente solo porque produce un resultado inmutable.

Para coordinación asíncrona entre productores y consumidores, consulta [Channels frente a BlockingCollection](/es/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/).

## Fuentes

- [System.Threading.Lock API](https://learn.microsoft.com/en-us/dotnet/api/system.threading.lock?view=net-10.0)
- [C# lock statement](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/statements/lock)
- [CoreCLR SyncBlock implementation, .NET 10](https://github.com/dotnet/runtime/blob/v10.0.0/src/coreclr/vm/syncblk.cpp)
- [C# 13 lock-object proposal](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-13.0/lock-object.md)
