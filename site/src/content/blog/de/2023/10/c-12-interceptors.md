---
title: "C# 12 Interceptors"
description: "Lernen Sie C# 12 Interceptors kennen, ein experimentelles Compiler-Feature in .NET 8, mit dem Sie Methodenaufrufe zur Compile-Zeit über das InterceptsLocation-Attribut ersetzen können."
pubDate: 2023-10-12
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
lang: "de"
translationOf: "2023/10/c-12-interceptors"
translatedBy: "claude"
translationDate: 2026-05-01
---
Interceptors sind ein experimentelles Compiler-Feature, das mit .NET 8 eingeführt wurde, was bedeutet, dass es sich in zukünftigen Releases des Frameworks ändern oder ganz entfallen kann. Was es sonst noch Neues in .NET 8 gibt, sehen Sie auf unserer Seite [What's new in .NET 8](/2023/06/whats-new-in-net-8/).

Um das Feature zu aktivieren, müssen Sie ein Feature Flag setzen, indem Sie `<Features>InterceptorsPreview</Features>` in Ihre `.csproj` eintragen.

## Was ist ein Interceptor?

Ein Interceptor ist eine Methode, die einen Aufruf einer interceptable Methode durch einen Aufruf von sich selbst ersetzen kann. Die Verbindung zwischen den beiden Methoden wird deklarativ über das `InterceptsLocation`-Attribut hergestellt, und die Ersetzung erfolgt während der Kompilierung, ohne dass die Laufzeitumgebung etwas davon weiß.

Interceptors lassen sich gut mit Source Generators kombinieren, um vorhandenen Code zu verändern: Der Generator fügt der Compilation neuen Code hinzu, der die abgefangene Methode komplett ersetzt.

## Erste Schritte

Bevor Sie Interceptors einsetzen können, müssen Sie das `InterceptsLocationAttribute` zunächst in dem Projekt deklarieren, in dem das Intercepting stattfinden soll. Das Feature befindet sich noch in der Preview, und das Attribut wird mit .NET 8 noch nicht ausgeliefert.

Hier die Referenzimplementierung:

```cs
namespace System.Runtime.CompilerServices
{
    [AttributeUsage(AttributeTargets.Method, AllowMultiple = true)]
    sealed class InterceptsLocationAttribute : Attribute
    {
        public InterceptsLocationAttribute(string filePath, int line, int column)
        {
            
        }
    }
}
```

Sehen wir uns jetzt ein kurzes Beispiel an. Wir starten mit einem sehr einfachen Setup: einer Klasse `Foo` mit einer Methode `Interceptable` und ein paar Aufrufen dieser Methode, die wir später abfangen möchten.

```cs
var foo = new Foo();

foo.Interceptable(1); // "interceptable 1"
foo.Interceptable(1); // "interceptable 1"
foo.Interceptable(2); // "interceptable 2"
foo.Interceptable(1); // "interceptable 1"

class Foo
{
    public void Interceptable(int param)
    {
        Console.WriteLine($"interceptable {param}");
    }
}
```

Als Nächstes folgt das eigentliche Intercepting:

```cs
static class MyInterceptor
{
    [InterceptsLocation(@"C:\test\Program.cs", line: 5, column: 5)]
    public static void InterceptorA(this Foo foo, int param)
    {
        Console.WriteLine($"interceptor A: {param}");
    }

    [InterceptsLocation(@"C:\test\Program.cs", line: 6, column: 5)]
    [InterceptsLocation(@"C:\test\Program.cs", line: 7, column: 5)]
    public static void InterceptorB(this Foo foo, int param)
    {
        Console.WriteLine($"interceptor B: {param}");
    }
}
```

Passen Sie den Dateipfad (`C:\test\Program.cs`) an den Pfad Ihrer interceptable Quelldatei an. Wenn Sie alles erneut ausführen, sollte sich die Ausgabe der `Interceptable(...)`-Aufrufe folgendermaßen ändern:

```plaintext
interceptable 1
interceptor A: 1
interceptor B: 2
interceptor B: 1
```

Welche schwarze Magie haben wir hier eigentlich gerade gemacht? Schauen wir uns ein paar Details an.

### Signatur der Interceptor-Methode

Auffällig ist die Signatur der Interceptor-Methode: Es handelt sich um eine Erweiterungsmethode, deren `this`-Parameter denselben Typ hat wie der Besitzer der interceptable Methode.

```cs
public static void InterceptorA(this Foo foo, int param)
```

Das ist eine Preview-Einschränkung, die entfernt wird, bevor das Feature die Preview verlässt.

### Der Parameter `filePath`

Steht für den Pfad zur Quelldatei, die abgefangen werden soll.

Wenn Sie das Attribut in Source Generators verwenden, sollten Sie den Dateipfad genauso normalisieren, wie der Compiler es tut:

```cs
string GetInterceptorFilePath(SyntaxTree tree, Compilation compilation)
{
    return compilation.Options.SourceReferenceResolver?.NormalizePath(tree.FilePath, baseFilePath: null) ?? tree.FilePath;
}
```

### `line` und `column`

Sind 1-indizierte Positionen, die exakt auf die Stelle zeigen, an der die interceptable Methode aufgerufen wird.

Bei `column` zeigt die Aufrufposition auf den ersten Buchstaben des Methodennamens. Beispiele:

-   Für `foo.Interceptable(...)` wäre das die Position des `I`. Ohne führende Leerzeichen also `5`.
-   Für `System.Console.WriteLine(...)` wäre es die Position des `W`. Ohne führende Leerzeichen wäre `column` gleich `16`.

### Einschränkungen

Interceptors funktionieren nur mit gewöhnlichen Methoden. Konstruktoren, Properties oder lokale Funktionen lassen sich derzeit nicht abfangen, allerdings kann sich die Liste der unterstützten Member in Zukunft noch ändern.
