---
title: "Eine Datenbank-Engine mit Mikrosekunden-Latenz in C# bauen"
description: "Loic Baumanns Typhon-Projekt zielt auf ACID-Commits in 1-2 Mikrosekunden mittels ref structs, Hardware-Intrinsics und gepinntem Speicher und zeigt, dass C# auf Systemprogrammier-Niveau mithalten kann."
pubDate: 2026-04-14
tags:
  - "csharp"
  - "dotnet"
  - "performance"
  - "database"
lang: "de"
translationOf: "2026/04/building-a-microsecond-database-engine-in-csharp"
translatedBy: "claude"
translationDate: 2026-04-25
---

Die Annahme, dass Hochleistungs-Datenbank-Engines C, C++ oder Rust erfordern, ist tief verwurzelt. Loic Baumanns [Typhon-Projekt](https://nockawa.github.io/blog/why-building-database-engine-in-csharp/) stellt das direkt in Frage: eine eingebettete ACID-Datenbank-Engine in C# geschrieben, die auf Transaktions-Commits in 1-2 Mikrosekunden abzielt. Das Projekt hat kürzlich [die Titelseite von Hacker News erreicht](https://news.ycombinator.com/item?id=47720060) und eine lebhafte Debatte darüber ausgelöst, was modernes .NET tatsächlich leisten kann.

## Das Performance-Toolkit in modernem C#

Baumanns Kernargument ist, dass der Engpass beim Design von Datenbank-Engines das Speicherlayout ist, nicht die Sprachwahl. Modernes C# bietet die Werkzeuge, um Speicher auf einer Ebene zu kontrollieren, die vor einem Jahrzehnt unmöglich gewesen wäre.

`ref struct`-Typen leben ausschließlich auf dem Stack und eliminieren Heap-Allokationen auf heißen Pfaden:

```csharp
ref struct TransactionContext
{
    public Span<byte> WriteBuffer;
    public int PageIndex;
    public bool IsDirty;
}
```

Für Speicherbereiche, die sich niemals bewegen dürfen, hält `GCHandle.Alloc` mit `GCHandleType.Pinned` die Garbage Collection aus kritischen Abschnitten heraus. Kombiniert mit `[StructLayout(LayoutKind.Explicit)]` erhalten Sie C-Niveau-Kontrolle über jeden Byte-Offset:

```csharp
[StructLayout(LayoutKind.Explicit, Size = 64)]
struct PageHeader
{
    [FieldOffset(0)]  public long PageId;
    [FieldOffset(8)]  public long TransactionId;
    [FieldOffset(16)] public int RecordCount;
    [FieldOffset(20)] public PageFlags Flags;
}
```

## Hardware-Intrinsics für heiße Pfade

Der Namespace `System.Runtime.Intrinsics` gibt direkten Zugriff auf SIMD-Befehle. Für eine Datenbank-Engine, die Seiten scannt oder Prüfsummen berechnet, ist das der Unterschied zwischen "schnell genug" und "konkurrenzfähig mit C":

```csharp
using System.Runtime.Intrinsics;
using System.Runtime.Intrinsics.X86;

static unsafe uint Crc32Page(byte* data, int length)
{
    uint crc = 0;
    int i = 0;
    for (; i + 8 <= length; i += 8)
        crc = Sse42.Crc32(crc, *(ulong*)(data + i));
    for (; i < length; i++)
        crc = Sse42.Crc32(crc, data[i]);
    return crc;
}
```

## Disziplin zur Compilezeit erzwingen

Einer der interessanteren Aspekte von Typhons Ansatz ist die Verwendung von Roslyn-Analyzern als Sicherheitsschienen. Benutzerdefinierte Analyzer erzwingen domänenspezifische Regeln (keine versehentlichen Heap-Allokationen in Transaktionscode, keine ungeprüfte Pointer-Arithmetik außerhalb genehmigter Module) zur Compilezeit, anstatt sich auf Code-Reviews zu verlassen.

Eingeschränkte Generics mit `where T : unmanaged` bieten eine weitere Schicht und stellen sicher, dass generische Datenstrukturen nur mit blittable Typen funktionieren, die vorhersehbare Speicherlayouts haben.

## Was das für .NET bedeutet

Typhon ist noch keine Produktionsdatenbank. Aber das Projekt zeigt, dass sich die Lücke zwischen C# und traditionellen Systemsprachen deutlich verringert hat. Zwischen `Span<T>`, Hardware-Intrinsics, `ref struct` und expliziter Speicherlayout-Kontrolle gibt Ihnen .NET 10 die Bausteine für performance-kritische Systemarbeit, ohne das verwaltete Ökosystem zu verlassen.

Der [vollständige Artikel](https://nockawa.github.io/blog/why-building-database-engine-in-csharp/) ist wegen der architektonischen Details und Benchmarks lesenswert.
