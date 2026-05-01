---
title: "C# 14: Vereinfachte Parameter mit Modifizierern in Lambdas"
description: "C# 14 erlaubt die Verwendung der Modifizierer ref, out, in, scoped und ref readonly an implizit typisierten Lambda-Parametern und macht die explizite Angabe der Parametertypen überflüssig."
pubDate: 2025-04-09
tags:
  - "csharp-14"
  - "csharp"
  - "dotnet"
  - "dotnet-10"
lang: "de"
translationOf: "2025/04/c-14-simplified-parameters-with-modifiers-in-lambdas"
translatedBy: "claude"
translationDate: 2026-05-01
---
Lambda-Ausdrücke sind seit vielen Jahren ein zentrales Sprachmerkmal von C# und erlauben es, Inline-Funktionen oder Callbacks knapp zu formulieren. In C# kann eine Lambda **explizit typisierte Parameter** (bei denen Sie den Typ jedes Parameters angeben) oder **implizit typisierte Parameter** (deren Typen aus dem Kontext abgeleitet werden) haben. Vor C# 14 mussten Sie die Parametertypen explizit deklarieren, sobald Sie bestimmte Parameter-Modifizierer in einer Lambda nutzen wollten (etwa Übergabe per Referenz oder Out-Parameter). Das führte oft zu einer ausführlicheren Lambda-Syntax, wenn diese Modifizierer benötigt wurden.

C# 14 führt eine neue Funktion ein, die diese Einschränkung beseitigt: **einfache Lambda-Parameter mit Modifizierern**. Damit können Sie Modifizierer wie `ref`, `in`, `out`, `scoped` und `ref readonly` in einem Lambda-Ausdruck verwenden, **ohne** die Parametertypen explizit ausschreiben zu müssen. Vereinfacht gesagt, können Sie diese Modifizierer jetzt an "untypisierten" Lambda-Parametern (Parameter, deren Typen abgeleitet werden) anbringen, was Lambdas mit besonderen Übergabearten leichter zu schreiben und zu lesen macht.

## Lambdas in C# 13 und früher

In C# 13 und allen früheren Versionen konnten Lambda-Parameter explizit oder implizit typisiert sein, allerdings mit einem Haken bei Parameter-Modifizierern. Sobald irgendein Lambda-Parameter einen Modifizierer benötigte (zum Beispiel einen `out`- oder `ref`-Parameter), verlangte der C#-Compiler, dass **alle** Parameter dieser Lambda einen explizit deklarierten Typ besaßen. Sie konnten `ref`, `in`, `out`, `scoped` oder `ref readonly` nur dann auf einen Lambda-Parameter anwenden, wenn Sie auch den Typ dieses Parameters ausschrieben.

Stellen Sie sich zum Beispiel einen Delegate-Typ mit einem `out`-Parameter vor:

```cs
// A delegate that tries to parse a string into T, returning true on success.
delegate bool TryParse<T>(string text, out T result);
```

Wollten Sie in C# 13 eine Lambda diesem Delegate zuweisen, mussten Sie die Typen beider Parameter explizit angeben, weil einer von ihnen den Modifizierer `out` verwendet. Eine gültige Lambda-Zuweisung in C# 13 sah so aus:

```cs
// C# 13 and earlier: must explicitly specify types when using 'out'
TryParse<int> parseOld = (string text, out int result) => Int32.TryParse(text, out result);
```

Hier haben wir `string` für den Parameter `text` und `int` für den Parameter `result` ausgeschrieben. Wenn Sie versuchten, die Typen wegzulassen, wurde der Code nicht kompiliert. Anders gesagt: `(text, out result) => ...` war in C# 13 **nicht** erlaubt, weil das `out` an `result` verlangte, dass der Typ von `result` (in diesem Fall `int`) explizit angegeben wird. Das galt für alle Modifizierer `ref`, `in`, `out`, `ref readonly` und `scoped` in Lambda-Parameterlisten.

## Lambda-Parameter-Modifizierer in C# 14

C# 14 hebt diese Einschränkung auf und macht Lambdas flexibler. Sie können Parameter-Modifizierer jetzt an Lambda-Parameter anhängen, ohne den Parametertyp explizit anzugeben. Der Compiler leitet die Typen aus dem Kontext ab (etwa aus dem Delegate- oder Expression-Tree-Typ, in den die Lambda konvertiert wird) und erlaubt zugleich die Modifizierer. Diese Verbesserung bedeutet weniger Boilerplate und besser lesbaren Code beim Umgang mit Delegates oder Expressions, die Parameter per Referenz oder mit `scoped` verwenden.

**Unterstützte Modifizierer:** Ab C# 14 können Sie die folgenden Modifizierer an implizit typisierten Lambda-Parametern verwenden:

-   `ref` -- übergibt das Argument per Referenz, sodass die Lambda die Variable des Aufrufers lesen oder ändern kann.
-   `out` -- übergibt das Argument per Referenz, vorgesehen für Ausgabe; die Lambda muss diesem Parameter vor der Rückkehr einen Wert zuweisen.
-   `in` -- übergibt das Argument schreibgeschützt per Referenz; die Lambda darf den Wert lesen, aber nicht verändern.
-   `ref readonly` -- übergibt schreibgeschützt per Referenz (im Wesentlichen ähnlich zu `in`, eingeführt für bestimmte Szenarien mit Werttypen).
-   `scoped` -- gibt an, dass ein Parameter (typischerweise eine ref struct wie `Span<T>`) auf den Aufrufer beschränkt ist und nicht über den Aufruf hinaus erfasst oder gespeichert werden darf.

Diese Modifizierer waren bisher nur einsetzbar, wenn Sie die Parameter in der Lambda explizit typisierten. Jetzt können Sie sie in der Parameterliste einer Lambda ohne Typen schreiben.

Eine wichtige Einschränkung: Der `params`-Modifizierer ist in dieser neuen Möglichkeit **nicht** enthalten. Hat eine Lambda einen `params`-Parameter (für eine variable Anzahl von Argumenten), müssen Sie den Typ weiterhin explizit angeben. Kurz: `params` benötigt in Lambdas nach wie vor eine explizit typisierte Parameterliste.

Greifen wir das frühere Beispiel mit dem `TryParse<T>`-Delegate auf, um zu sehen, wie C# 14 die Syntax vereinfacht. Wir können die Typnamen jetzt weglassen und trotzdem den `out`-Modifizierer verwenden:

```cs
// C# 14: type inference with 'out' parameter
TryParse<int> parseNew = (text, out result) => Int32.TryParse(text, out result);
```

Diese Lambda wird `TryParse<int>` zugewiesen, daher weiß der Compiler aus der Delegate-Definition, dass `text` ein `string` und `result` ein `int` ist. Wir konnten `(text, out result) => ...` ohne explizite Typen schreiben, und der Code kompiliert und funktioniert korrekt. Der `out`-Modifizierer wird auf `result` angewendet, obwohl wir `int` nicht ausgeschrieben haben. C# 14 leitet das für uns ab, was die Lambda-Deklaration kürzer macht und Wiederholungen vermeidet, die der Compiler ohnehin kennt.

Dasselbe Prinzip gilt für andere Modifizierer. Betrachten Sie einen Delegate mit einem Referenzparameter:

```cs
// A delegate that doubles an integer in place.
delegate void Doubler(ref int number);
```

In C# 13 mussten Sie für eine zu diesem Delegate passende Lambda den Typ zusammen mit dem `ref`-Modifizierer angeben:

```cs
// C# 13: explicit type needed for 'ref' parameter
Doubler makeDoubleOld = (ref int number) => number *= 2;
```

In C# 14 können Sie den Typ weglassen und nur den Modifizierer und den Parameternamen schreiben:

```cs
// C# 14: implicit type with 'ref' parameter
Doubler makeDoubleNew = (ref number) => number *= 2;
```

Hier sagt der Kontext (der Delegate `Doubler`, der ein `ref int` annimmt und void zurückgibt) dem Compiler, dass `number` ein `int` ist; wir müssen das also nicht ausbuchstabieren. Wir verwenden in der Parameterliste der Lambda einfach `ref number`.

Sie können auch mehrere Modifizierer kombinieren oder andere Formen dieser Modifizierer auf die gleiche Weise nutzen. Hat beispielsweise ein Delegate einen `ref readonly`- oder `scoped`-Parameter, dürfen Sie diese in C# 14 ebenfalls ohne explizite Typen schreiben. Zum Beispiel:

```cs
// A delegate with an 'in' (readonly ref) parameter
delegate void PrintReadOnly(in DateTime value);

// C# 14: using 'in' without explicit type
PrintReadOnly printDate = (in value) => Console.WriteLine(value);
```

Analog für einen Delegate mit `scoped`-Parameter:

```cs
// A delegate that takes a scoped Span<int>
delegate int SumElements(scoped Span<int> data);

// C# 14: using 'scoped' without explicit type
SumElements sum = (scoped data) =>
{
    int total = 0;
    foreach (int x in data)
        total += x;
    return total;
};
```

Hier ist `data` durch den Delegate als `Span<int>` (ein nur auf dem Stack lebender Typ) bekannt, und wir markieren ihn als `scoped`, ohne den Typnamen zu schreiben. Damit ist sichergestellt, dass `data` nicht außerhalb der Lambda erfasst werden kann (gemäß der Semantik von `scoped`), genauso, als hätten wir `(scoped Span<int> data)` geschrieben.

## Welche Vorteile bringt das?

Einfache Lambda-Parameter mit Modifizierern machen den Code sauberer und reduzieren Wiederholungen. In früheren C#-Versionen bedeutete der Einsatz von Per-Referenz- oder `scoped`-Parametern in Lambdas, dass Sie Typen ausschreiben mussten, die der Compiler ohnehin kennt. Jetzt können Sie die Typermittlung dem Compiler überlassen und gleichzeitig die Absicht ausdrücken (zum Beispiel, dass ein Parameter per Referenz übergeben wird oder ein Ausgabeparameter ist). Das ergibt knappere Lambdas, die leichter zu lesen sind, besonders wenn Delegate-Signaturen komplex sind oder generische Typen verwenden.

Hinzu kommt: Diese Funktion ändert weder das Laufzeitverhalten von Lambdas noch die Funktionsweise der Modifizierer; nur die Syntax zur Deklaration der Lambda-Parameter wird angepasst. Die Lambda folgt weiterhin denselben Regeln für `ref`, `out`, `in` usw., als hätten Sie sie mit expliziten Typen geschrieben. Der `scoped`-Modifizierer stellt nach wie vor sicher, dass der Wert nicht über die Ausführung der Lambda hinaus erfasst wird. Der entscheidende Fortschritt ist schlicht, dass Ihr Quellcode weniger Typnamen mit sich herumträgt.

Diese Funktion in C# 14 bringt die Lambda-Syntax in Einklang mit der Bequemlichkeit der Typinferenz, die es an anderer Stelle in der Sprache schon lange gibt. Sie können Lambdas mit `ref` und anderen Modifizierern nun auf natürlichere Weise schreiben, ähnlich wie Sie seit Jahren Typen in Lambdas weglassen konnten, wenn keine Modifizierer im Spiel waren. Bedenken Sie nur: Wenn Sie ein `params`-Array in einer Lambda benötigen, müssen Sie den Typ weiterhin wie zuvor ausschreiben.

## Referenzen

-   [Neuerungen in C# 14 | Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/csharp-14)
-   [Einfache Lambda-Parameter mit Modifizierern | Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-14.0/simple-lambda-parameters-with-modifiers)
-   [Neuerungen in C# 14 | StartDebugging.NET](/2024/12/csharp-14/)
