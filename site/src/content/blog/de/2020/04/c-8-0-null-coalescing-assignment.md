---
title: "C# 8.0 Null-Coalescing-Zuweisung ??="
description: "Erfahren Sie, wie der Null-Coalescing-Zuweisungsoperator (??=) in C# 8.0 funktioniert, mit praktischen Beispielen wie Caching und bedingten Zuweisungen."
pubDate: 2020-04-05
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "de"
translationOf: "2020/04/c-8-0-null-coalescing-assignment"
translatedBy: "claude"
translationDate: 2026-05-01
---
Mit diesem Operator können Sie dem linken Operanden den Wert des rechten Operanden nur dann zuweisen, wenn der Wert des linken Operanden null ergibt.

Ein sehr einfaches Beispiel:

```cs
int? i = null;

i ??= 1;
i ??= 2;
```

Im obigen Beispiel deklarieren wir eine nullbare `int`-Variable `i` und nehmen zwei Null-Coalescing-Zuweisungen darauf vor. Bei der ersten Zuweisung ergibt `i` den Wert `null`, das bedeutet, dass `i` der Wert `1` zugewiesen wird. Bei der nächsten Zuweisung ist `i` gleich `1` -- also nicht `null` -- daher wird die Zuweisung übersprungen.

Wie zu erwarten, wird der Wert des rechten Operanden nur dann ausgewertet, wenn der linke Operand `null` ist.

```cs
int? i = null;

i ??= Method1();
i ??= Method2(); // Method2 is never called because i != null
```

## Anwendungsfälle

Der Operator hilft dabei, den Code zu vereinfachen und lesbarer zu machen, wenn Sie normalerweise verschiedene `if`-Zweige durchlaufen würden, bis der Wert einer bestimmten Variable gesetzt ist.

Ein Beispiel dafür ist Caching. Im folgenden Beispiel würde der Aufruf von `GetUserFromServer` nur dann erfolgen, wenn `user` nach dem Versuch, ihn aus dem Cache zu laden, noch immer null ist.

```cs
var user = GetUserFromCache(userId);
user ??= GetUserFromServer(userId);
```
