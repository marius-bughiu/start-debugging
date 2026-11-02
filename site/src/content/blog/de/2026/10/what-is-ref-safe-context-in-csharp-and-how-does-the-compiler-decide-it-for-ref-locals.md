---
title: "Was ist ref-safe-context in C#, und wie bestimmt der Compiler ihn für ref-Lokalvariablen?"
description: "C#-Escape-Regeln für Referenzen verstehen: compilergeprüfte Beispiele zu ref-Lokalvariablen, Neuzuweisung, scoped und Heap- gegenüber Stack-Spans."
pubDate: 2026-10-15
updatedDate: 2026-11-02
template: how-to
tags:
  - "csharp"
  - "csharp-14"
  - "dotnet-11"
  - "ref-locals"
  - "span"
  - "compiler-errors"
lang: "de"
translationOf: "2026/10/what-is-ref-safe-context-in-csharp-and-how-does-the-compiler-decide-it-for-ref-locals"
translatedBy: "claude"
translationDate: 2026-10-15
---
Eine Referenz darf die Lebensdauer des Speichers, auf den sie zeigt, nicht überschreiten. C# prüft diesen Zusammenhang zur Kompilierzeit. Eine mit einer lokalen Methodenvariablen initialisierte `ref`-Lokalvariable lässt sich nicht allein deshalb zurückgeben, weil sie später auf ein Arrayelement umgebogen wird.

**Korrektur — 2. November 2026:** Für die frühere Behauptung eines Tests mit .NET 11 RC1 gab es keine erhaltenen Belege; sie wurde entfernt. Die hier beschriebenen positiven und negativen Beispiele wurden mit SDK 10.0.302, `net10.0` und `LangVersion` 14 kompiliert. Die Fehlercodes beziehen sich auf genau diese Codeformen; verwandte Ausdrücke können andere Diagnosen auslösen.

## Ref-safe-context und safe-context

`ref-safe-context` betrifft eine Referenz auf Speicher. Der verwandte `safe-context` betrifft einen Wert, der selbst Referenzen enthalten kann, etwa `Span<T>`. Die lokale Span-Variable und der durch den Span beschriebene Speicher sind verschiedene Dinge.

Die Sprachspezifikation beschreibt vier ineinander geschachtelte Kontexte:

| Kontext | Typisches Beispiel |
| --- | --- |
| declaration-block | Referenz auf eine gewöhnliche lokale Variable |
| function-member | Wertparameter oder scoped-Parameter |
| return-only | Gewöhnlicher `ref`-Parameter, der zurückgegeben werden darf |
| caller-context | Arrayelement oder geeignetes Klassenfeld |

Diese Bezeichnungen bedeuten nicht, dass jeder Speicher bis zur Methodenrückkehr lebt. Verschachtelte Blöcke und `scoped`-Beschränkungen bleiben relevant. Die [Sprachspezifikation](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/variables#972-ref-safe-contexts) enthält die vollständigen Regeln einschließlich Parametern und Aufrufen.

## Der Initialisierer begrenzt eine ref-Lokalvariable ohne scoped

Dieses negative Beispiel erzeugt im geprüften Build CS8157:

```csharp
class Example
{
    static ref int CannotReturn(int[] array)
    {
        int local = 1;
        ref int reference = ref local;
        reference = ref array[0];
        return ref reference; // CS8157
    }
}
```

Die spätere Neuzuweisung ist erlaubt, macht aus der lokal abgeleiteten Referenz aber keine zurückgebbare Referenz. Eine gewöhnliche lokale Variable direkt zurückzugeben, führt dagegen zu CS8168:

```csharp
class Example
{
    static ref int CannotReturn()
    {
        int local = 1;
        return ref local; // CS8168
    }
}
```

## Neuzuweisung darf keine kürzer lebende Referenz übernehmen

Eine Arrayelement-Referenz zunächst zu speichern und anschließend eine lokale Referenz zuzuweisen, erzeugt CS8374:

```csharp
class Example
{
    static void CannotNarrow(int[] array)
    {
        ref int reference = ref array[0];
        int local = 1;
        reference = ref local; // CS8374
    }
}
```

Ein `ref`-Parameter hat einen anderen Escape-Vertrag als ein Arrayelement. Initialisierung mit dem Array und anschließende Zuweisung des Parameters erzeugt CS9079:

```csharp
class Example
{
    static ref int CannotAssign(int[] array, ref int parameter)
    {
        ref int reference = ref array[0];
        reference = ref parameter; // CS9079
        return ref reference;
    }
}
```

Die umgekehrte Reihenfolge kompilierte in derselben Prüfung erfolgreich:

```csharp
class Example
{
    static ref int CanReturn(int[] array, ref int parameter)
    {
        ref int reference = ref parameter;
        reference = ref array[0];
        return ref reference;
    }
}
```

Wähle einen Initialisierer, dessen Vertrag zu jeder beabsichtigten Verwendung passt. Deklarationen zu verschieben oder `scoped` hinzuzufügen ist keine allgemeine Lösung für jeden Escape-Fehler.

## Scoped-Referenzen bleiben lokal

Diese Änderung innerhalb desselben Blocks kompilierte erfolgreich:

```csharp
class Example
{
    static void LocalUse(int[] array)
    {
        scoped ref int reference = ref array[0];
        int local = 1;
        reference = ref local;
        reference = 5;
    }
}
```

Die Rückgabe dieser scoped-Referenz wird abgelehnt. Eine zusätzliche Prüfung mit `local` in einem engeren, verschachtelten Block lehnte auch die Neuzuweisung mit CS8374 ab. `scoped` beseitigt weder Block-Lebensdauergrenzen noch erlaubt es die Rückgabe.

Ein scoped-Parameter kann außerdem ausdrücken, dass ein Argument nicht über das Methodenergebnis entweicht. Das ist ein Signaturvertrag; der Compiler muss dafür nicht die Implementierung eines beliebigen Helpers untersuchen. Der [C#-11-Entwurf](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-11.0/low-level-struct-improvements.md) erklärt die Details und Fälle mit `[UnscopedRef]`.

## Ein Span liegt nicht zwangsläufig auf dem Stack

Beide Beispiele deklarieren einen lokalen Span, doch nur das erste Ergebnis darf entweichen:

```csharp
using System;

class Example
{
    static ref int HeapBacked()
    {
        Span<int> values = new int[2];
        return ref values[0]; // Compiles in the verified probe
    }

    static ref int StackBacked()
    {
        Span<int> values = stackalloc int[2];
        return ref values[0]; // CS8352 in this exact probe
    }
}
```

Der arraybasierte Span beschreibt verwalteten Heap-Speicher. Eine Referenz darauf zurückzugeben ist etwas anderes als eine Referenz auf die lokale Span-Variable selbst zurückzugeben. Verwaltete Referenzen halten ihre referenzierten Objekte erreichbar; Heap-Objekte leben deshalb nicht unbegrenzt.

Ein praktischer Algorithmus mit ref-Rückgabe kann einen Span des Aufrufers verwenden und leere Eingaben behandeln:

```csharp
using System;

static ref int MaxRef(Span<int> values)
{
    if (values.IsEmpty)
        throw new ArgumentException("At least one element is required", nameof(values));

    ref int best = ref values[0];
    for (int i = 1; i < values.Length; i++)
        if (values[i] > best) best = ref values[i];
    return ref best;
}

int[] data = { 3, 9, 4 };
MaxRef(data) = 0;
Console.WriteLine(string.Join(",", data)); // 3,0,4
```

## Die Diagnose im Kontext lesen

Die geprüften Beispiele unterscheiden direkte Rückgabe lokaler Variablen (CS8168), nicht zurückgebbare ref-Lokalvariablen (CS8157), engere Referenzzuweisungen (CS8374) und einen return-only-Parameter, der einer weiter reichenden Referenz zugewiesen wird (CS9079). Der direkte Stack-Span-Ausdruck oben erzeugte CS8352. Ein weiterer Alias oder Helper-Aufruf kann die Diagnose ändern, ohne das Lebensdauerproblem zu ändern.

Async-/Iterator-Einschränkungen sind ein separates Thema: Eine Referenz darf nicht über einen Suspendierungspunkt erhalten bleiben, wenn die Sprache dies verbietet. Nicht jede Ablehnung lässt sich allein über den Initialisierer erklären.

Verwandt: [Span<T> und sein Speicher](/de/2026/06/what-is-span-and-when-does-it-make-my-code-faster/), [List, Span und ReadOnlySpan](/de/2026/05/list-vs-span-vs-readonlyspan-in-csharp/) und [Deklarationen von Referenzvariablen](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/statements/declarations#reference-variables).
