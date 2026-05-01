---
title: "C# Was ist eine NullReferenceException und wie behebt man sie?"
description: "Erfahren Sie, was eine NullReferenceException in C# auslöst, wie Sie sie debuggen und mit Null-Prüfungen, dem null-conditional Operator und nullbaren Referenztypen vermeiden."
pubDate: 2023-10-20
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "de"
translationOf: "2023/10/c-what-is-a-nullreferenceexception-and-how-to-fix-it"
translatedBy: "claude"
translationDate: 2026-05-01
---
Eine `NullReferenceException` ist ein häufiger Laufzeitfehler, der auftritt, wenn Ihr Code versucht, auf ein Objekt oder einen Member eines Objekts zuzugreifen oder ihn zu manipulieren, die Objekt-Referenz aber gerade auf `null` zeigt (also kein gültiges Objekt im Speicher referenziert). Anders gesagt: Sie versuchen, eine Operation auf etwas auszuführen, das gar nicht existiert.

Hier ein sehr einfaches Beispiel:

```cs
string myString = null;
int length = myString.Length;
```

In diesem Beispiel haben wir eine String-Variable `myString`, die mit `null` belegt ist. Beim Zugriff auf ihre `Length`-Eigenschaft wird eine `NullReferenceException` geworfen, weil Sie die Länge eines Strings, der nicht existiert, nicht ermitteln können.

## Wie debuggen?

Ihr Hauptaugenmerk sollte darauf liegen, die Quelle der null-Referenz zu finden. Mit dem Debugger können Sie den Ort des Problems genau lokalisieren.

Sehen Sie sich zunächst die Exception-Details des Debuggers genau an. Sie zeigen die Codezeile, in der die Exception aufgetreten ist. Diese Zeile ist entscheidend, um die Variable oder das Objekt zu identifizieren, die für die null-Referenz verantwortlich sind.

Inspizieren Sie als Nächstes Variablen und Objekte, indem Sie mit der Maus darüberfahren oder die Fenster `Locals` und `Watch` Ihres Editors nutzen. Damit können Sie den Zustand der Anwendung zum Zeitpunkt der Exception untersuchen. Achten Sie besonders auf Variablen, die in der auslösenden Zeile verwendet werden. Ist eine davon null, obwohl sie es nicht sein sollte, haben Sie sehr wahrscheinlich die Ursache gefunden.

Schauen Sie zusätzlich in den Call-Stack im gleichnamigen Fenster, um die Methodenaufrufe nachzuverfolgen, die zur Exception geführt haben. So verstehen Sie den Kontext der null-Referenz und kommen leichter an die eigentliche Ursache. Sobald die verantwortliche Variable oder das Objekt feststeht, können Sie das Problem beheben, indem Sie auf null-Werte prüfen und geeignete Null-Checks einbauen, um zukünftige Exceptions zu verhindern.

## Wie vermeiden?

Um `NullReferenceException`s zu verhindern, ist es entscheidend, vor dem Zugriff auf Properties oder Methoden eines Objekts auf `null` zu prüfen. Sie können bedingte Anweisungen wie `if` nutzen, um vor dem Zugriff `null` auszuschließen. Zum Beispiel:

```cs
string myString = null; 

if (myString != null) 
{ 
    int length = myString.Length; // This will only execute if 'myString' is not null. 
}
```

Oder Sie verwenden den null-conditional Operator (eingeführt mit C# 6.0), um sicher auf Member von potenziell null-Objekten zuzugreifen:

```cs
string myString = null; 
int? length = myString?.Length; // 'length' will be null if 'myString' is null.
```

### Nullbare Referenztypen

Eine weitere Möglichkeit, `NullReferenceException`s zu vermeiden, sind nullbare Referenztypen, ein Feature aus C# 8.0. Es hilft Entwicklerinnen und Entwicklern, sichereren und zuverlässigeren Code zu schreiben, indem es eine Möglichkeit bietet auszudrücken, ob ein Referenztyp (z. B. Klassen und Interfaces) null sein darf oder nicht. Das ermöglicht, mögliche null-Reference-Exceptions schon zur Compile-Zeit zu erkennen, und verbessert Lesbarkeit und Wartbarkeit des Codes.

Wenn Sie nullbare Referenztypen aktivieren, erzeugt der Compiler Warnungen für potenzielle null-Probleme. Sie ergänzen Annotationen, um Ihre Absichten klarzumachen, was hilft, diese Warnungen zu reduzieren oder zu beseitigen.

Nullbare Referenztypen verwenden Annotationen, um zu kennzeichnen, ob ein Referenztyp `null` sein darf:

-   `T?`: zeigt an, dass ein Referenztyp `T` `null` sein darf.
-   `T`: zeigt an, dass ein Referenztyp `T` nicht nullbar ist.
