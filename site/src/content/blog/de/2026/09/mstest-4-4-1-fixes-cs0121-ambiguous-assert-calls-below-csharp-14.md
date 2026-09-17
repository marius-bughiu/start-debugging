---
title: "MSTest 4.4.1 behebt die mehrdeutigen CS0121-Assert-Aufrufe, die 4.4.0 unterhalb von C# 14 kaputt gemacht hat"
description: "MSTest 4.4.0 hat Assert.Contains und Assert.DoesNotContain Span<T>- und ReadOnlySpan<T>-Überladungen hinzugefügt, wodurch gewöhnliche Array- und String-Assertions unter net8.0, net9.0 oder in jedem Projekt unterhalb von C# 14 mit CS0121 fehlschlagen. MSTest 4.4.1, veröffentlicht am 2026-09-16, ergänzt exakte Array-Überladungen und eingeschränkte Weiterleitungen. Zwei Aufrufformen mit expliziten generischen Argumenten schlagen weiterhin fehl."
pubDate: 2026-09-17
tags:
  - "mstest"
  - "testing"
  - "csharp"
  - "dotnet"
  - "breaking-changes"
lang: "de"
translationOf: "2026/09/mstest-4-4-1-fixes-cs0121-ambiguous-assert-calls-below-csharp-14"
translatedBy: "claude"
translationDate: 2026-09-17
---

Wer MSTest in einem Projekt mit Ziel `net8.0` oder `net9.0` auf 4.4.0 angehoben hat, dessen Testprojekt kompiliert womöglich nicht mehr, und zwar in Zeilen, die sich seit Jahren nicht geändert haben. [MSTest 4.4.1](https://github.com/microsoft/testfx/releases/tag/v4.4.1), am 2026-09-16 auf NuGet veröffentlicht, behebt das. Hier steht, was kaputtging, welche Versionsmatrix ich gemessen habe und welche zwei Aufrufformen 4.4.1 weiterhin nicht abdeckt.

## Span-Überladungen, die nur C# 14 einordnen kann

MSTest 4.4.0 hat `Span<T>`- und `ReadOnlySpan<T>`-Überladungen neben den bestehenden `IEnumerable<T>`-Überladungen von `Assert.Contains` und `Assert.DoesNotContain` hinzugefügt. Unter C# 14 liefern die First-Class-Span-Konvertierungen dem Compiler Regeln zur Auflösung von Gleichständen für Arrays und Strings, sodass er eine Überladung auswählt. Unterhalb von C# 14 ist `T[]` nach `Span<T>` nur ein benutzerdefinierter `op_Implicit`, und keine der beiden Überladungen ist besser. [Issue #11022](https://github.com/microsoft/testfx/issues/11022) meldete das am Tag nach dem Release von 4.4.0:

```text
error CS0121: The call is ambiguous between the following methods or properties:
'Assert.Contains<T>(T, System.Collections.Generic.IEnumerable<T>, string?, string, string)' and
'Assert.Contains<T>(T, System.Span<T>, string?, string, string)'
```

Da `net8.0` standardmäßig C# 12 und `net9.0` C# 13 verwendet, brechen diese TFMs ohne weiteres Zutun. Dasselbe gilt für ein `net10.0`-Projekt, das auf eine ältere `LangVersion` festgelegt ist.

## Die Versionsmatrix

Ich habe dieselbe Datei mit SDK 10.0.302 gegen jede Version kompiliert:

```csharp
int[] ids = [1, 2, 3];
string name = "Marius";

Assert.Contains(2, ids);
Assert.DoesNotContain(4, ids);
Assert.DoesNotContain('z', name);
Assert.Contains<int>(2, ids);
```

| MSTest | Ziel / Sprache | Ergebnis |
| --- | --- | --- |
| 4.3.3 | `net8.0`, `net10.0` | kompiliert |
| 4.4.0 | `net10.0` (C# 14) | kompiliert |
| 4.4.0 | `net8.0`, `net9.0` oder `net10.0` mit `LangVersion` 12 | 4 x `CS0121` |
| 4.4.0 | `net8.0` mit `LangVersion` 14 | kompiliert |
| 4.4.1 | `net8.0`, `net10.0` | kompiliert |

Alle vier Aufrufe schlagen unter 4.4.0 fehl, einschließlich des expliziten `Contains<int>` und des `string`-Falls. Der einzige Workaround für 4.4.0 ist, `LangVersion` bei einem älteren TFM auf 14 anzuheben, und das ist keine unterstützte Kombination. Die eigentliche Lösung ist das Upgrade:

```xml
<PackageReference Include="MSTest" Version="4.4.1" />
```

Wer `MSTest.Sdk` verwendet, hebt stattdessen die Version in `global.json` oder im Attribut `Sdk="MSTest.Sdk/4.4.1"` an.

## Wie 4.4.1 das Problem behebt und was offen bleibt

[PR #11038](https://github.com/microsoft/testfx/pull/11038) fügt jeder betroffenen `Assert`-Familie exakte `T[]`-Überladungen hinzu. Eine exakte Übereinstimmung schlägt beide Konvertierungen, sodass abgeleitete und explizite Aufrufe auf Arrays wieder aufgelöst werden. Außerdem kommen eingeschränkte Weiterleitungen hinzu, die abgeleitete Aufrufe für andere Typen funktionsfähig halten, die sich in einen Span konvertieren lassen, etwa `string`, `ArraySegment<T>` und eigene Collections. Sie leiten an den bestehenden `IEnumerable<T>`-Code weiter, das Verhalten entspricht also 4.3.3.

Laut PR liegen explizite `<T>`-Aufrufe auf Nicht-Array-Typen außerhalb des Umfangs, und mein Test mit 4.4.1 unter `net8.0` bestätigt das:

```csharp
var seg = new ArraySegment<int>(ids);
Assert.Contains(2, seg);           // OK
Assert.Contains(2, ids.AsSpan());  // OK
Assert.Contains<int>(2, seg);      // CS0121
Assert.Contains<char>('M', name);  // CS0121
```

Lassen Sie das Typargument weg, damit die Typinferenz die Weiterleitung auswählt, oder casten Sie nach `IEnumerable<T>`.

Dasselbe Release schränkt außerdem ein, was der MSTest Source Generator für Trimming und Native AOT verwurzelt, und korrigiert quellgenerierte Literale für Enums, schmale ganzzahlige Typen, `NaN` und Steuerzeichen. Wer den Generator eingeschaltet hat, nachdem [MSTest 4.4 ihn zur stabilen Funktion gemacht hat](/de/2026/09/mstest-4-4-native-aot-source-generation/), hat damit einen zweiten Grund, auf 4.4.1 zu wechseln.
