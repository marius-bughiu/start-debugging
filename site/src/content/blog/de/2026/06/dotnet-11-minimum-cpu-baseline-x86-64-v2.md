---
title: ".NET 11 hebt die minimale CPU-Baseline auf x86-64-v2 an"
description: ".NET 11 Preview 4 stellt die Unterstuetzung fuer x86/x64-Chips vor 2013 ein und hebt die JIT-Baseline auf x86-64-v2 an. Das bricht, warum es passiert und wie Sie Ihre Hardware vor dem Upgrade pruefen."
pubDate: 2026-06-03
tags:
  - "dotnet"
  - "performance"
  - "native-aot"
lang: "de"
translationOf: "2026/06/dotnet-11-minimum-cpu-baseline-x86-64-v2"
translatedBy: "claude"
translationDate: 2026-06-03
---

Wenn Sie CI-Runner, Docker-Basisimages oder irgendetwas auf aelterer Hardware betreiben, bringt .NET 11 eine Breaking Change mit, die nicht als Compilerfehler auftaucht. Sie zeigt sich beim Start, auf der Zielmaschine, als Weigerung zu laufen. Ab .NET 11 Preview 4 hebt die Laufzeit den garantierten minimalen Befehlssatz auf x86/x64 von `x86-64-v1` auf `x86-64-v2` an, und auch Arm64 erhaelt eine kleinere Anhebung.

## Was die neue Baseline tatsaechlich verlangt

`x86-64-v1` garantierte nur `CMOV`, `CX8`, `SSE` und `SSE2`. `x86-64-v2` ergaenzt `CX16`, `POPCNT`, `SSE3`, `SSSE3`, `SSE4.1` und `SSE4.2`. Das gilt fuer das JIT- und AOT-Minimum auf allen drei Betriebssystemen (Apple, Linux, Windows). In der Praxis sind die letzten Chips, die diese Huerde nicht nehmen, um 2013 aus dem Support gefallen, und das Niveau wird bereits von Windows 11 und von jeder offiziell unter Windows 10 unterstuetzten x86/x64-CPU verlangt.

Auf Arm64 verschiebt sich das JIT/AOT-Minimum unter Windows von `armv8.0-a` auf `armv8.0-a + LSE`. Linux und Apple behalten ihre bisherigen JIT-Minima, sodass ein Raspberry Pi, der nur `AdvSimd` bereitstellt, weiterhin laeuft.

Die ReadyToRun-Ziele (R2R) gehen weiter. Unter Windows und Linux ist das R2R-Ziel jetzt `x86-64-v3`, das `AVX`, `AVX2`, `BMI1`, `BMI2`, `F16C`, `FMA`, `LZCNT` und `MOVBE` voraussetzt. Das R2R-Ziel von Apple bleibt unveraendert. R2R ist ein Codegenerierungsziel, keine harte Anforderung: Eine CPU unterhalb von `x86-64-v3`, aber auf oder oberhalb von `x86-64-v2`, laeuft weiterhin, zahlt nur zusaetzlichen Jitting-Aufwand beim Start, weil der vorkompilierte Code nicht verwendet werden kann.

## Der Fehlerfall

Wenn die CPU unter dem neuen Mindestwert liegt, startet die Anwendung nicht. Stattdessen erhalten Sie eine Meldung wie diese:

```text
The current CPU is missing one or more of the baseline instruction sets.
```

Es gibt keinen Schalter auf Projektebene, um den Mindestwert zu senken. Das JIT/AOT-Minimum ist das Minimum.

## Pruefen Sie vor der Auslieferung

Unter Linux mit glibc koennen Sie den dynamischen Loader fragen, welche Mikroarchitektur-Stufen die Maschine unterstuetzt:

```bash
/lib64/ld-linux-x86-64.so.2 --help | grep -A4 "Subdirectories"
```

Die Ausgabe markiert jede Stufe als `(supported)` oder nicht:

```text
  x86-64-v4 (not searched)
  x86-64-v3 (supported, searched)
  x86-64-v2 (supported, searched)
```

Wenn `x86-64-v2` in der Liste der unterstuetzten Stufen fehlt, laeuft .NET 11 auf diesem Host nicht. Die ueblichen Verdaechtigen sind alte Build-Agents, guenstige VPS-Instanzen, die an uralte Host-CPUs gebunden sind, und emulierte Umgebungen. Die AOT-Veroeffentlichung zielt auf dieselbe Baseline, sodass ein Native-AOT-Binary, das fuer `linux-x64` erstellt wurde, dieselbe Anforderung mit sich traegt.

## Warum Microsoft die Untergrenze angehoben hat

Hardware unterhalb dessen zu unterstuetzen, was das Host-Betriebssystem selbst verlangt, verursacht echten Wartungsaufwand in der Laufzeit und zwingt die AOT-Codegenerierung zu einem kleinsten gemeinsamen Nenner, der Leistung verschenkt. Das Anheben der Baseline erlaubt es dem JIT und crossgen2, davon auszugehen, dass `POPCNT`, `SSE4.2` und Aehnliches immer vorhanden sind, sodass der generierte Code ohne eine Funktionspruefung zur Laufzeit schlanker ist. Fuer die ueberwaeltigende Mehrheit der Maschinen, einschliesslich jedes Windows-11-Rechners, aendert sich nichts ausser schnellerem Code.

Die einzige Gruppe, die handeln muss, sind diejenigen, die noch auf wirklich alte Chips zielen. Pruefen Sie Ihre Runner und Basisimages jetzt, solange .NET 11 in der Preview ist, statt die Meldung im November in der Produktion zu entdecken. Wenn Sie den Sprung planen, nehmen Sie dies in Ihre [Migrations-Checkliste von .NET 8 auf .NET 11](/de/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) auf.

Quelle: [Neuerungen in der .NET 11-Laufzeit](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/runtime) und der [Kompatibilitaetshinweis zu den minimalen Hardwareanforderungen](https://learn.microsoft.com/en-us/dotnet/core/compatibility/jit/11/minimum-hardware-requirements).
