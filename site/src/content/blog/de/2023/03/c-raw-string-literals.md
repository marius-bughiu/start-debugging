---
title: "Raw-String-Literale in C# 11 (Dreifach-Anführungszeichen-Syntax)"
description: "Verwenden Sie Raw-String-Literale in C# 11 (Dreifach-Anführungszeichen-Syntax `\"\"\"`), um Leerzeichen, Zeilenumbrüche und Anführungszeichen ohne Escape-Sequenzen einzubetten. Regeln und Beispiele."
pubDate: 2023-03-15
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "de"
translationOf: "2023/03/c-raw-string-literals"
translatedBy: "claude"
translationDate: 2026-05-01
---
Raw-String-Literale sind ein neues Format, mit dem Sie Leerzeichen, Zeilenumbrüche, eingebettete Anführungszeichen und andere Sonderzeichen in Ihrer Zeichenfolge unterbringen können, ohne Escape-Sequenzen verwenden zu müssen.

So funktioniert es:

-   ein Raw-String-Literal beginnt mit drei oder mehr doppelten Anführungszeichen (**"""**). Sie entscheiden, wie viele doppelte Anführungszeichen Sie zum Umschließen Ihres Literals verwenden.
-   es endet mit derselben Anzahl an doppelten Anführungszeichen, die Sie am Anfang verwendet haben
-   bei mehrzeiligen Raw-String-Literalen müssen die Eröffnungs- und Schluss-Sequenzen auf separaten Zeilen stehen. Die Zeilenumbrüche nach dem öffnenden und vor dem schließenden Anführungszeichen werden im endgültigen Inhalt nicht berücksichtigt.
-   sämtliche Leerzeichen links neben den schließenden doppelten Anführungszeichen werden aus dem String-Literal entfernt (aus allen Zeilen; darauf gehen wir weiter unten genauer ein)
-   Zeilen müssen mit derselben Anzahl an Leerzeichen (oder mehr) beginnen wie die Schluss-Sequenz
-   in mehrzeiligen Raw-Literalen werden Leerzeichen, die in derselben Zeile auf die Eröffnungs-Sequenz folgen, ignoriert

Ein kurzes Beispiel:

```cs
string rawString = """
    Lorem ipsum "dolor" sit amet,
        consectetur adipiscing elit.
    """;
```

Die Ausgabe lautet:

```plaintext
Lorem ipsum "dolor" sit amet,
    consectetur adipiscing elit.
```

## Leerzeichen vor der Schluss-Sequenz

Die Leerzeichen vor den schließenden doppelten Anführungszeichen steuern, welche Leerzeichen aus Ihrem Raw-String-Ausdruck entfernt werden. Im obigen Beispiel hatten wir 4 Leerzeichen vor der **"""**-Sequenz, daher wurden vier Leerzeichen aus jeder Zeile des Ausdrucks entfernt. Hätten wir nur 2 Leerzeichen vor der Schluss-Sequenz, wären nur 2 Leerzeichen aus jeder Zeile des Raw-Strings entfernt worden.

### Beispiel: keine Leerzeichen vor der Schluss-Sequenz

Im vorherigen Beispiel würde die resultierende Zeichenfolge die Einrückung exakt so beibehalten, wie sie war, falls wir keinerlei Leerzeichen vor der Schluss-Sequenz angegeben hätten.

**Ausdruck:**

```cs
string rawString = """
    Lorem ipsum "dolor" sit amet,
        consectetur adipiscing elit.
""";
```

**Ausgabe:**

```plaintext
    Lorem ipsum "dolor" sit amet,
        consectetur adipiscing elit.
```

## Mehr als 3 doppelte Anführungszeichen in der Eröffnungs- / Schluss-Sequenz verwenden

Das ist nützlich, wenn der Raw-String selbst eine Sequenz aus 3 doppelten Anführungszeichen enthält. Im folgenden Beispiel verwenden wir eine Sequenz aus 5 doppelten Anführungszeichen zum Beginn und Ende des Raw-String-Literals, sodass wir im Inhalt Sequenzen aus 3 und 4 doppelten Anführungszeichen unterbringen können.

```cs
string rawString = """""
    3 double-quotes: """
    4 double-quotes: """"
    """"";
```

**Ausgabe:**

```plaintext
3 double-quotes: """
4 double-quotes: """"
```

## Zugehörige Fehler

> CS8997: Unterminated raw string literal.

```cs
string rawString = """Lorem ipsum "dolor" sit amet,
        consectetur adipiscing elit. 
    """;
```

> CS9000: Raw string literal delimiter must be on its own line.

```cs
var rawString = """
    Lorem ipsum "dolor" sit amet,
        consectetur adipiscing elit.""";
```

> CS8999: Line does not start with the same whitespace as the closing line of the raw string literal.

```cs
var rawString = """
    Lorem ipsum "dolor" sit amet,
consectetur adipiscing elit.
    """;
```
