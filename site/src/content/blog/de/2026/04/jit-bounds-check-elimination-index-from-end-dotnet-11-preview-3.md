---
title: "RyuJIT trimmt mehr Bounds Checks in .NET 11 Preview 3: Index-from-end und i + Konstante"
description: ".NET 11 Preview 3 bringt RyuJIT bei, redundante Bounds Checks bei aufeinanderfolgendem Index-from-end-Zugriff und bei i + Konstante < length-Mustern zu eliminieren, was Branch-Druck in engen Schleifen senkt."
pubDate: 2026-04-19
tags:
  - "dotnet"
  - "dotnet-11"
  - "jit"
  - "performance"
  - "csharp"
lang: "de"
translationOf: "2026/04/jit-bounds-check-elimination-index-from-end-dotnet-11-preview-3"
translatedBy: "claude"
translationDate: 2026-04-24
---

Bounds-Check-Elimination ist die JIT-Optimierung, die leise entscheidet, wie schnell viel .NET-Code ist. Jedes `array[i]` und `span[i]` in Managed Code trägt einen impliziten Compare-and-Branch, und wenn RyuJIT beweisen kann, dass der Index im Bereich ist, verschwindet dieser Branch. .NET 11 Preview 3 erweitert diesen Beweis auf zwei gebräuchliche Muster, die vorher den Check trotzdem zahlten.

Beide Änderungen sind in den [Runtime-Release-Notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/runtime.md) dokumentiert und werden im [.NET 11 Preview 3 Announcement](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/) vom 14. April 2026 hervorgehoben.

## Hintereinanderliegender Index-from-end-Zugriff

Der Index-from-end-Operator `^1`, `^2`, eingeführt mit C# 8, ist syntaktischer Zucker für `Length - 1`, `Length - 2`. Der JIT konnte den Bounds Check beim ersten solchen Zugriff schon eine Weile eliminieren, aber ein zweiter Zugriff direkt danach wurde oft unabhängig behandelt und erzwang einen redundanten Compare-and-Branch.

In .NET 11 Preview 3 wiederverwendet die Range-Analyse den Length-Beweis über aufeinanderfolgende Index-from-end-Zugriffe:

```csharp
static int TailSum(int[] values)
{
    // .NET 10: two bounds checks, one per access.
    // .NET 11 Preview 3: the JIT proves both are in range from a single length test.
    return values[^1] + values[^2];
}
```

Wenn Sie `TailSum` im [ASM-Viewer von Rider 2026.1](https://blog.jetbrains.com/dotnet/) disassemblieren, sehen Sie, dass das zweite `cmp`/`ja`-Paar einfach verschwindet. Code, der durch das Tail eines Buffers läuft, Ring-Buffer-Accessoren, Parser, die auf das letzte Token spähen, oder Fixed-Window-Komparatoren - alle profitieren ohne Quelländerung.

## `i + Konstante < length`-Schleifen

Die zweite Verbesserung zielt auf ein Muster, das ständig in numerischem und Parsing-Code auftaucht. Eine Stride-2-Schleife sah auf Papier gut aus, zahlte aber beim zweiten Zugriff immer noch einen Bounds Check:

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

Die Schleifenbedingung `i + 1 < buffer.Length` beweist bereits, dass `buffer[i + 1]` im Bereich ist, aber RyuJIT behandelte die beiden Zugriffe früher unabhängig. Preview 3 bringt der Analyse bei, über einen Index plus eine kleine Konstante gegen ein Length zu argumentieren, sodass sowohl `buffer[i]` als auch `buffer[i + 1]` zu einem einfachen Load kompilieren.

Dieselbe Umschreibung gilt für `i + 2`, `i + 3` und so weiter, solange der konstante Offset zu dem passt, was die Schleifenbedingung garantiert. Verbreitern Sie die Schleifenbedingung zu `i + 3 < buffer.Length`, und eine Stride-4-Inner-Schleife wird über alle vier Zugriffe bounds-check-frei.

## Warum kleine Branches sich summieren

Ein einzelner Bounds Check kostet auf modernen CPUs unter einer Nanosekunde. Der eigentliche Druck ist zweiter Ordnung: der Branch-Slot, den er verbraucht, die Loop-Unrolling-Entscheidungen, die er blockiert, die Vektorisierungs-Chancen, die er zunichtemacht. Wenn RyuJIT beweist, dass eine ganze Inner-Schleife bounds-safe ist, ist er frei, aggressiver abzurollen und den Block dem Auto-Vektorisierer zu übergeben. Da wird aus einem 1%-Mikro-Gewinn auf Papier eine 10- bis 20%-Verbesserung auf einem echten numerischen Kernel.

## Heute ausprobieren

Keine der Optimierungen braucht ein Feature-Flag. Laufen Sie irgendein .NET 11 Preview 3 SDK, und sie greifen automatisch. Setzen Sie `DOTNET_JitDisasm=TailSum`, um den generierten Code zu dumpen, laufen Sie einmal auf .NET 10 und einmal auf Preview 3, und diffen. Wenn Sie Hot Loops über Arrays oder Spans pflegen, besonders etwas, das auf das Ende eines Buffers späht oder mit fixem Stride läuft, ist das ein kostenloser Speedup, der in Preview 3 wartet.
