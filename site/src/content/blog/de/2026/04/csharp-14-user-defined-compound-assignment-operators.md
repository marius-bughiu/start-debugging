---
title: "Benutzerdefinierte Compound-Assignment-Operatoren in C# 14: in-place += ohne die zusätzliche Allokation"
description: "C# 14 erlaubt das Überladen von +=, -=, *= und Kollegen als void-Instanzmethoden, die den Empfänger in-place mutieren, was Allokationen für große Werthalter wie BigInteger-artige Buffer und Tensoren reduziert."
pubDate: 2026-04-14
tags:
  - "csharp"
  - "csharp-14"
  - "dotnet-10"
  - "performance"
  - "operators"
lang: "de"
translationOf: "2026/04/csharp-14-user-defined-compound-assignment-operators"
translatedBy: "claude"
translationDate: 2026-04-24
---

Eine der ruhigeren Ergänzungen in C# 14 wird endlich in die Sprachreferenz gegossen: benutzerdefinierte Compound-Assignment-Operatoren. Bis zu .NET 10 kompilierte das Schreiben von `x += y` auf einem benutzerdefinierten Typ immer zu `x = x + y`, was bedeutete, dass Ihr `operator +` selbst dann eine brandneue Instanz allokieren und zurückgeben musste, wenn der Aufrufer die alte gleich wegwerfen wollte. Mit C# 14 können Sie jetzt `+=` direkt als `void`-Instanzmethode überladen, die den Empfänger in-place mutiert.

Die Motivation ist einfach: für Typen, die viele Daten tragen (ein Buffer im `BigInteger`-Stil, ein Tensor, ein gepoolter Byte-Akkumulator), ist das Erzeugen eines frischen Ziels, das Durchlaufen und Kopieren von Speicher der teure Teil jedes `+=`. Wenn der Originalwert nach der Zuweisung nicht verwendet wird, ist diese Kopie reine Verschwendung. Die [Feature-Spezifikation](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-14.0/user-defined-compound-assignment) buchstabiert das ausdrücklich.

## Wie der neue Operator deklariert wird

Ein Compound-Assignment-Operator in C# 14 ist nicht statisch. Er nimmt einen einzigen Parameter, gibt `void` zurück und lebt auf der Instanz:

```csharp
public sealed class Accumulator
{
    private readonly List<int> _values = new();

    public int Sum { get; private set; }

    // Classic binary operator, still required if you want x + y to work.
    public static Accumulator operator +(Accumulator left, int value)
    {
        var result = new Accumulator();
        result._values.AddRange(left._values);
        result._values.Add(value);
        result.Sum = left.Sum + value;
        return result;
    }

    // New in C# 14: instance operator, no allocation, no static modifier.
    public void operator +=(int value)
    {
        _values.Add(value);
        Sum += value;
    }
}
```

Der Compiler emittiert die Instanzmethode unter dem Namen `op_AdditionAssignment`. Wenn der Aufrufer `acc += 5` schreibt, bevorzugt die Sprache jetzt den Instanzoperator, falls einer verfügbar ist; falls nicht, ist das alte `x = x + y`-Rewrite weiterhin der Fallback. Das bedeutet, bestehender Code kompiliert weiterhin, und Sie können später eine `+=`-Überladung hinzufügen, ohne die `+`-Überladung zu brechen.

## Wann es zählt

Der Payoff zeigt sich bei Referenztypen, die interne Buffer besitzen, und bei Struct-Typen, die durch eine veränderbare Speicherposition verwendet werden. Ein naives `Matrix operator +(Matrix, Matrix)` muss für jeden `m += other`-Aufruf in einer heißen Schleife eine ganze neue Matrix allokieren. Die Instanzversion kann in `this` addieren und nichts zurückgeben:

```csharp
public sealed class Matrix
{
    private readonly double[] _data;
    public int Rows { get; }
    public int Cols { get; }

    public void operator +=(Matrix other)
    {
        if (other.Rows != Rows || other.Cols != Cols)
            throw new ArgumentException("Shape mismatch.");

        var span = _data.AsSpan();
        var otherSpan = other._data.AsSpan();
        for (int i = 0; i < span.Length; i++)
            span[i] += otherSpan[i];
    }
}
```

Präfix-`++` und `--` folgen demselben Muster mit `public void operator ++()`. Postfix-`x++` geht weiterhin durch die statische Version, wenn das Ergebnis verwendet wird, weil der Pre-Increment-Wert nach einer In-place-Mutation nicht erzeugt werden kann.

## Wissenswertes

Die Sprache erzwingt keine Konsistenz zwischen `+` und `+=`, also können Sie das eine ohne das andere ausliefern. Das LDM [hat sich das im April 2025 angesehen](https://github.com/dotnet/csharplang/blob/main/meetings/2025/LDM-2025-04-02.md) und sich gegen verpflichtendes Pairing entschieden. `checked`-Varianten funktionieren genauso: Deklarieren Sie `public void operator checked +=(int y)` neben der regulären. `readonly` ist auf Structs erlaubt, aber wie die Spezifikation anmerkt, ergibt es selten Sinn, da der ganze Punkt der Methode ist, die Instanz zu mutieren.

Das Feature wird mit C# 14 auf .NET 10 ausgeliefert, heute im Visual Studio 2026 oder im .NET 10 SDK nutzbar. Für bestehende Bibliotheken, die Big-Data-Werttypen exponieren, ist das nachträgliche Einbauen eines Instanz-`+=` einer der billigsten Performance-Gewinne in diesem Release. Sehen Sie den vollständigen Überblick in [Was ist neu in C# 14](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/csharp-14).
