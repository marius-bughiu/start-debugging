---
title: "Как использовать System.Threading.Lock в .NET"
description: "System.Threading.Lock для синхронных критических секций начиная с .NET 9: работа компилятора, ограничения await и отличие от Monitor."
pubDate: 2026-04-30
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "concurrency"
template: "how-to"
lang: "ru"
translationOf: "2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-04-30
---

`System.Threading.Lock` появился в .NET 9. Начиная с C# 13, оператор `lock`, выражение которого имеет этот статический тип, использует `EnterScope()` вместо механизма `Monitor`. Это вариант синхронного взаимного исключения внутри процесса; существующий код `lock(object)` автоматически не меняется.

**Исправление — 2 ноября 2026 года:** прежняя версия ошибочно утверждала, что SyncBlock никогда не освобождаются, а `EnterScope()` может охватывать `await`. Преимущества по памяти и производительности также были преувеличены. Примеры компиляции проверены с SDK 10.0.302 и C# 14; выполнение на .NET 11 не заявляется.

## Закрытый объект блокировки с явным типом

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

Компилятор создаёт область, освобождающую блокировку даже при исключении. `Lock.Scope` — это `ref struct`, а не выделяемая в куче оболочка с `Dispose`. Сам `Lock` является ссылочным типом и допускает повторный вход владеющего потока. Каждому успешному `Enter()` или `TryEnter()` должен соответствовать `Exit()` в том же потоке; для этих ручных API используйте `try/finally`.

## Не смешивайте Lock и Monitor

`lock (_gate)` и `Monitor.Enter(_gate)` используют разные механизмы синхронизации. Для выражения типа `object` или `dynamic` оператор `lock` использует Monitor, если явно не привести выражение обратно к `Lock`. Смешение этих путей может оставить общие данные без защиты.

CS9216 предупреждает о некоторых статически видимых преобразованиях в выражении блокировки, например `lock ((object)gate)`. Это не гарантирует обнаружение всех косвенных обращений или явных вызовов `Monitor`. Храните объект блокировки в закрытом поле и сохраняйте его явный тип. Используйте `using System.Threading;` или полное имя типа: `using static System.Threading;` недопустим, поскольку `System.Threading` — пространство имён.

## Для await нужен другой подход

Компилятор отклоняет `await` внутри `lock`. `Lock.Scope` также нельзя сохранять через `await`; замена синтаксиса на `using` не обходит это ограничение:

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

Делайте синхронные критические секции короткими. Если требуется последовательное выполнение асинхронных операций, одним из подходящих вариантов служит общий `SemaphoreSlim(1, 1)`:

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

Не используйте ручные `Lock.Enter()`/`Exit()` через `await`: блокировкой владеет поток, а продолжение может выполняться в другом. В проверенном примере C# 14 синхронный блок, заканчивающийся до последующего await, компилировался.

## SyncBlock и производительность

Monitor может использовать заголовок объекта и при необходимости связанный SyncBlock. Конкуренция не означает, что каждый объект немедленно получает постоянный SyncBlock. В CoreCLR есть пути очистки, пул свободных SyncBlock и список свободных записей таблицы. Повторное использование записей не означает возврат всей ёмкости таблицы операционной системе.

Для собственного захвата `Lock` не использует тот же механизм монитора объекта. Однако это не доказывает фиксированную экономию на объект или универсальное ускорение. Измеряйте фактический runtime, конкуренцию и защищаемую работу. Обе API допускают повторный вход; общей гарантии справедливости нет.

Для старых целевых платформ без `System.Threading.Lock` сохраняйте блокировку на `object` либо используйте условную компиляцию для .NET 9 и новее. Ни `Lock`, ни локальный семафор не координируют разные процессы. Изменяемый builder, например `ImmutableArray<T>.Builder`, также не становится безопасным для параллельных изменений лишь потому, что его результат неизменяем.

Для асинхронного producer/consumer-взаимодействия см. [Channels и BlockingCollection](/ru/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/).

## Источники

- [System.Threading.Lock API](https://learn.microsoft.com/en-us/dotnet/api/system.threading.lock?view=net-10.0)
- [C# lock statement](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/statements/lock)
- [CoreCLR SyncBlock implementation, .NET 10](https://github.com/dotnet/runtime/blob/v10.0.0/src/coreclr/vm/syncblk.cpp)
- [C# 13 lock-object proposal](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-13.0/lock-object.md)
