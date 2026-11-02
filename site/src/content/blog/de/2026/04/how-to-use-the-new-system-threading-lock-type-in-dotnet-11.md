---
title: "System.Threading.Lock in .NET verwenden"
description: "System.Threading.Lock für synchrone kritische Abschnitte ab .NET 9: Compilerverhalten, await-Grenzen und Unterschiede zu Monitor."
pubDate: 2026-04-30
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "concurrency"
template: "how-to"
lang: "de"
translationOf: "2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-04-30
---

`System.Threading.Lock` wurde mit .NET 9 eingeführt. Seit C# 13 verwendet eine `lock`-Anweisung mit diesem statischen Typ `EnterScope()` statt des `Monitor`-Pfads. Der Typ dient dem synchronen gegenseitigen Ausschluss innerhalb eines Prozesses. Bestehendes `lock(object)` wird nicht automatisch umgestellt.

**Korrektur — 2. November 2026:** Die frühere Fassung behauptete fälschlich, SyncBlocks würden niemals freigegeben und `EnterScope()` könne ein `await` überspannen. Auch Speicher- und Leistungsvorteile wurden übertrieben dargestellt. Die Compilerbeispiele wurden mit SDK 10.0.302 und C# 14 geprüft, nicht unter .NET 11 ausgeführt.

## Ein privates, eindeutig typisiertes Sperrobjekt

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

Der Compiler erzeugt einen Scope, der die Sperre auch bei einer Ausnahme freigibt. `Lock.Scope` ist ein `ref struct`, kein auf dem Heap angelegter Disposable-Wrapper. `Lock` selbst ist ein Referenztyp und erlaubt rekursives Betreten durch denselben Thread. Auf jedes erfolgreiche `Enter()` oder `TryEnter()` muss auf diesem Thread ein `Exit()` folgen; verwenden Sie für diese manuellen APIs `try/finally`.

## Lock und Monitor nicht mischen

`lock (_gate)` und `Monitor.Enter(_gate)` verwenden unterschiedliche Synchronisationsmechanismen. Bei einem Ausdruck vom Typ `object` oder `dynamic` verwendet `lock` den Monitor-Pfad, sofern Sie nicht ausdrücklich zurück nach `Lock` casten. Werden beide Pfade gemischt, ist der gemeinsame Zustand möglicherweise nicht geschützt.

CS9216 warnt bei manchen statisch erkennbaren Konvertierungen im Sperrausdruck, etwa `lock ((object)gate)`. Die Warnung erfasst nicht jeden indirekten Zugriff oder expliziten `Monitor`-Aufruf. Halten Sie das Sperrobjekt privat und seinen Typ sichtbar. Verwenden Sie `using System.Threading;` oder den vollständigen Typnamen; `using static System.Threading;` ist ungültig, weil `System.Threading` ein Namespace ist.

## Await benötigt einen anderen Ansatz

Ein `await` innerhalb von `lock` wird abgelehnt. Auch ein `Lock.Scope` darf nicht über ein `await` hinweg erhalten bleiben; `using` umgeht diese Einschränkung nicht:

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

Halten Sie synchrone kritische Abschnitte kurz. Muss tatsächlich asynchrone Arbeit serialisiert werden, ist ein gemeinsam verwendetes `SemaphoreSlim(1, 1)` eine geeignete Möglichkeit:

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

Verwenden Sie auch manuelles `Lock.Enter()`/`Exit()` nicht über ein `await` hinweg: Die Sperre gehört dem Thread, während eine Fortsetzung auf einem anderen Thread laufen kann. Ein synchroner Sperrblock, der vor einem späteren await endet, ließ sich im geprüften C#-14-Beispiel kompilieren.

## SyncBlocks und Leistung

Monitor kann den Objektheader und bei Bedarf einen zugeordneten SyncBlock verwenden. Konkurrenz bedeutet nicht, dass jedes Objekt sofort einen dauerhaften SyncBlock erhält. CoreCLR besitzt Bereinigungspfade, einen Pool freier SyncBlocks und eine Freiliste für Tabelleneinträge. Wiederverwendung von Einträgen ist nicht dasselbe wie die Rückgabe der gesamten Tabellenkapazität an das Betriebssystem.

Für seine eigene Sperre verwendet `Lock` nicht denselben Objekt-Monitor-Mechanismus. Daraus folgt jedoch weder eine feste Einsparung pro Objekt noch ein allgemeiner Durchsatzfaktor. Messen Sie die tatsächliche Laufzeit, Konkurrenz und kritische Arbeit. Beide APIs sind reentrant; keine bietet eine allgemeine Fairnessgarantie.

Behalten Sie auf älteren Zielplattformen ohne `System.Threading.Lock` ein `object`-Sperrobjekt bei oder verwenden Sie bedingte Kompilierung ab .NET 9. Weder `Lock` noch ein prozesslokales Semaphor koordiniert getrennte Prozesse. Ein veränderlicher Builder wie `ImmutableArray<T>.Builder` erlaubt außerdem nicht automatisch nebenläufige Änderungen, nur weil sein Ergebnis unveränderlich ist.

Für asynchrone Producer/Consumer-Koordination: [Channels und BlockingCollection](/de/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/).

## Quellen

- [System.Threading.Lock API](https://learn.microsoft.com/en-us/dotnet/api/system.threading.lock?view=net-10.0)
- [C# lock statement](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/statements/lock)
- [CoreCLR SyncBlock implementation, .NET 10](https://github.com/dotnet/runtime/blob/v10.0.0/src/coreclr/vm/syncblk.cpp)
- [C# 13 lock-object proposal](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-13.0/lock-object.md)
