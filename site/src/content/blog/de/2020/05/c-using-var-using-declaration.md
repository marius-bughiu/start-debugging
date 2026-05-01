---
title: "C# using var (using-Deklaration)"
description: "Verwenden Sie die using-Deklarationen in C# 8 (`using var`), um IDisposable-Objekte ohne verschachtelte geschweifte Klammern freizugeben. Syntax, Geltungsbereichsregeln und wann `using`-Blöcke vorzuziehen sind."
pubDate: 2020-05-01
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "de"
translationOf: "2020/05/c-using-var-using-declaration"
translatedBy: "claude"
translationDate: 2026-05-01
---
Haben Sie sich schon einmal gewünscht, etwas deklarieren zu können, das beim Verlassen seines umgebenden Geltungsbereichs automatisch freigegeben wird, ohne dass weitere geschweifte Klammern und Einrückung in Ihrem Code nötig sind? Sie sind nicht allein. Sagen Sie hallo zu den using-Deklarationen in C# 8 🥰.

Mit using var können Sie nun schreiben:

```cs
void Foo()
{
    using var file = new System.IO.StreamWriter("myFile.txt");
    // code using file
}
```

statt:

```cs
void Foo()
{
    using (var file = new System.IO.StreamWriter("myFile.txt"))
    {
        // code using file
    }
}
```

Keine überflüssigen geschweiften Klammern mehr, keine zusätzliche Einrückung. Der Geltungsbereich des Disposables entspricht dem seines übergeordneten Geltungsbereichs.

Nun ein vollständigeres using-var-Beispiel:

```cs
static int SplitFile(string filePath)
{
    var dir = Path.GetDirectoryName(filePath);
    using var sourceFile = new StreamReader(filePath);

    int count = 0;
    while(!sourceFile.EndOfStream)
    {
        count++;

        var line = sourceFile.ReadLine();

        var linePath = Path.Combine(dir, $"{count}.txt");
        using var lineFile = new StreamWriter(linePath);

        lineFile.WriteLine(line);

    } // lineFile is disposed here, at the end of each individual while loop

    return count;

} // sourceFile is disposed here, at the end of its enclosing scope
```

Wie Sie im obigen Beispiel sehen, muss der umgebende Geltungsbereich keine Methode sein. Es kann zum Beispiel auch das Innere einer `for`-, `foreach`- oder `while`-Anweisung sein oder sogar ein `using`-Block, falls Sie ganz mutig sind. In all diesen Fällen wird das Objekt am Ende des umgebenden Geltungsbereichs freigegeben.

## Fehler CS1674

using-var-Deklarationen liefern auch Compile-Time-Fehler, wenn der Ausdruck nach `using` kein `IDisposable` ist.

> Error CS1674 'string': type used in a using statement must be implicitly convertible to 'System.IDisposable'.

## Best Practices

In puncto Best Practices für `using var` gelten weitgehend dieselben Richtlinien wie für using-Anweisungen. Zusätzlich können Sie:

-   Ihre Disposable-Variablen am Anfang des Geltungsbereichs deklarieren, getrennt von den übrigen Variablen, damit sie hervorstechen und beim Lesen des Codes leicht zu erkennen sind
-   darauf achten, in welchem Geltungsbereich Sie sie erstellen, denn sie leben während des gesamten Geltungsbereichs. Wenn der Disposable-Wert nur in einem kurzlebigeren untergeordneten Geltungsbereich benötigt wird, kann es sinnvoll sein, ihn dort zu erzeugen.
