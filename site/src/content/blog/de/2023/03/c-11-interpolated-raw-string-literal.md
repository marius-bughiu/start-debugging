---
title: "C# 11 - Interpolierte Raw-String-Literale"
description: "Erfahren Sie, wie Sie interpolierte Raw-String-Literale in C# 11 einsetzen, einschließlich Escapen von geschweiften Klammern, mehreren $-Zeichen und bedingten Operatoren."
pubDate: 2023-03-17
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "de"
translationOf: "2023/03/c-11-interpolated-raw-string-literal"
translatedBy: "claude"
translationDate: 2026-05-01
---
C# 11 führt das Konzept der [Raw-String-Literale](/2023/03/c-raw-string-literals/) in die Sprache ein und damit auch eine Reihe neuer Möglichkeiten für die String-Interpolation.

Zunächst können Sie die Interpolations-Syntax wie gewohnt in Kombination mit Raw-String-Literalen verwenden:

```cs
var x = 5, y = 4;
var interpolatedRaw = $"""The sum of "{x}" and "{y}" is "{ x + y }".""";
```

Die Ausgabe lautet:

```plaintext
The sum of "5" and "4" is "9".
```

## Geschweifte Klammern { und } escapen

Sie escapen geschweifte Klammern, indem Sie sie verdoppeln. Greifen wir das obige Beispiel auf und verdoppeln die Klammern:

```cs
var interpolatedRaw= $"""The sum of "{{x}}" and "{{y}}" is "{{ x + y }}".""";
```

Die Ausgabe lautet:

```plaintext
The sum of "{x}" and "{y}" is "{ x + y }".
```

Wie Sie sehen, übernehmen die Klammern keine Interpolationsrolle mehr, und jedes Klammerpaar landet als einzelne Klammer in der Ausgabe.

## Mehrere $-Zeichen in interpolierten Raw-String-Literalen

Sie können mehrere **$**-Zeichen in einem interpolierten Raw-String-Literal verwenden, ähnlich der **"""**-Sequenz. Die Anzahl der $-Zeichen am Anfang der Zeichenfolge bestimmt, wie viele { und } Sie für die String-Interpolation benötigen.

Beispielsweise erzeugen die beiden folgenden Zeichenfolgen genau dieselbe Ausgabe wie unser Ausgangsbeispiel:

```cs
var interpolatedRaw2 = $$"""The sum of "{{x}}" and "{{y}}" is "{{ x + y }}".""";
var interpolatedRaw3 = $$$"""The sum of "{{{x}}}" and "{{{y}}}" is "{{{ x + y }}}".""";
```

## Bedingter Operator in interpolierter Zeichenfolge

Der Doppelpunkt (:) hat in interpolierten Zeichenfolgen eine besondere Bedeutung. Daher benötigen bedingte Ausdrücke ein zusätzliches Paar runder Klammern ( ), um zu funktionieren. Zum Beispiel:

```cs
var conditionalInterpolated = $"I am {x} year{(x == 1 ? "" : "s")} old.";
```

## Fehler

> Error CS9006 The interpolated raw string literal does not start with enough '$' characters to allow this many consecutive opening braces as content.

Dieser Compilerfehler tritt auf, wenn Ihre Zeichenfolge eine Folge von Klammerzeichen enthält, deren Länge mindestens doppelt so groß ist wie die Folge der $-Zeichen am Anfang der Zeichenfolge.
