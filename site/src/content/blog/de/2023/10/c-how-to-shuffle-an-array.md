---
title: "C# Wie mischt man ein Array?"
description: "Der einfachste Weg, ein Array in C# zu mischen, ist Random.Shuffle, eingeführt in .NET 8. Es arbeitet in-place und funktioniert sowohl mit Arrays als auch mit Spans."
pubDate: 2023-10-26
updatedDate: 2023-11-01
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "de"
translationOf: "2023/10/c-how-to-shuffle-an-array"
translatedBy: "claude"
translationDate: 2026-05-01
---
Der einfachste Weg, ein Array in C# zu mischen, ist `Random.Shuffle`. Diese Methode wurde mit .NET 8 eingeführt und funktioniert sowohl mit Arrays als auch mit Spans.

Das Mischen erfolgt in-place, das bestehende Array bzw. der Span wird verändert, statt ein neues Objekt anzulegen und die Quelle unangetastet zu lassen.

Die Signaturen sehen so aus:

```cs
public void Shuffle<T> (Span<T> values);
public void Shuffle<T> (T[] values);
```

Und ein einfaches Anwendungsbeispiel:

```cs
int[] foo = [1, 2, 3];
Random.Shared.Shuffle(foo); // [2, 1, 3]
```
