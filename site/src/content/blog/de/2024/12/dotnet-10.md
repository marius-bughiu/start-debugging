---
title: "Was ist neu in .NET 10"
description: "Was ist neu in .NET 10: LTS-Release mit 3 Jahren Support, neue JIT-Optimierungen, Array-Devirtualisierung, Verbesserungen bei der Stack-Allokation und mehr."
pubDate: 2024-12-01
updatedDate: 2026-01-04
tags:
  - "dotnet"
  - "dotnet-10"
lang: "de"
translationOf: "2024/12/dotnet-10"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 10 wird im November 2025 veröffentlicht. .NET 10 ist eine Long-Term-Support-Version (LTS), die ab dem Veröffentlichungsdatum 3 Jahre lang kostenlosen Support und Patches erhält, bis November 2028.

.NET 10 wird zusammen mit C# 14 veröffentlicht. Siehe [Was ist neu in C# 14](/2024/12/csharp-14/).

In der .NET-10-Laufzeit gibt es mehrere neue Funktionen und Verbesserungen:

-   [Devirtualisierung von Array-Interface-Methoden und Deabstraktion der Array-Enumeration](/de/2025/04/net-10-array-ennumeration-performance-improvements-jit-array-de-abstraction/)
-   Inlining von spät devirtualisierten Methoden
-   Devirtualisierung auf Basis von Inlining-Beobachtungen
-   [Stack-Allokation von Arrays von Werttypen](/de/2025/04/net-10-stack-allocation-of-arrays-of-value-types/)
-   Verbesserte Code-Anordnung, um Sprunginstruktionen zu vermeiden und die Wahrscheinlichkeit zu erhöhen, dass eine Instruction-Cache-Zeile gemeinsam genutzt wird
-   [SearchValues unterstützt jetzt Strings](/de/2026/01/net-10-performance-searchvalues/)

## Support-Ende

.NET 10 ist eine Long-Term-Support-Version (LTS) und wird im November 2028 aus dem Support genommen.
