---
title: "Lösung: Breaking Change bei der Überladungsauflösung in C# 14 mit Span und ReadOnlySpan"
description: "Nach dem Upgrade auf C# 14 / .NET 10 binden Aufrufe wie array.Contains, x.Reverse() und MemoryMarshal.Cast plötzlich an andere Überladungen oder kompilieren nicht mehr. Hier ist, was sich geändert hat und wie Sie das alte Verhalten dort festhalten, wo es darauf ankommt."
pubDate: 2026-05-19
tags:
  - "csharp-14"
  - "csharp"
  - "dotnet-10"
  - "spans"
  - "breaking-changes"
lang: "de"
translationOf: "2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans"
translatedBy: "claude"
translationDate: 2026-05-19
---

Sie aktualisieren ein Projekt auf C# 14 (ausgeliefert mit .NET 10, Roslyn 4.13, Visual Studio 17.13) und eines von drei Dingen passiert: Eine `Expression<Func<int[], int, bool>>`, die zuvor kompilierte und lief, wirft jetzt zur Laufzeit, ein Aufruf von `MemoryMarshal.Cast(array)` kompiliert nicht mehr mit einem Mehrdeutigkeitsfehler, oder ein xUnit-`Assert.Equal([2], myArray)` wechselt von "besteht" zu "mehrdeutige Übereinstimmung zwischen Assert.Equal-Überladungen". Es ist alles derselbe Breaking Change. Die First-Class-Span-Typen von C# 14 machen `T[]` implizit konvertierbar in `Span<T>` und `ReadOnlySpan<T>` während der Überladungsauflösung, der Typinferenz und der Bindung von Erweiterungsmethoden, und das dreht um, welche Überladung gewinnt in Code, der zuvor eindeutig war.

Dieser Beitrag geht die vier Szenarien durch, die ich tatsächlich in echten .NET-10-Upgrades getroffen habe, zeigt das minimale Reproduktionsbeispiel für jedes und gibt die empfohlene Lösung. Alle Beispiele zielen auf `<LangVersion>14.0</LangVersion>` und `<TargetFramework>net10.0</TargetFramework>` ab, sofern nicht anders angegeben.

## Warum C# 14 jetzt andere Überladungen wählt

In C# 13 und früher wurden die benutzerdefinierten impliziten Konvertierungen von `T[]` zu `Span<T>` und `ReadOnlySpan<T>` (in der Laufzeit über `op_Implicit` deklariert) als bibliotheksdefiniert behandelt, nicht als sprachdefiniert. Der Compiler berücksichtigte sie nicht während der Überladungsauflösung, der Typinferenz oder der Bindung von Erweiterungsmethoden. Deshalb mussten Sie vor .NET 10 `myArray.AsSpan().BinarySearch(...)` schreiben, wenn Sie die Span-Überladung einer Methode wollten, die auch eine `IEnumerable<T>`-Überladung hatte. Der Compiler wählte stillschweigend die Nicht-Span-Überladung, weil er die Konvertierung nicht sah.

Der [Vorschlag zu First-Class-Span-Typen](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-14.0/first-class-span-types.md) von C# 14 erhebt diese Konvertierungen auf die Sprachebene. Konkret berücksichtigt der Compiler nach dem Upgrade diese Konvertierungen während der Überladungsauflösung:

- `T[]` zu `Span<T>`
- `T[]` zu `ReadOnlySpan<T>`
- `T[]` zu `ReadOnlySpan<U>`, sofern `T` referenzkonvertierbar zu `U` ist
- `Span<T>` zu `ReadOnlySpan<T>`
- `string` zu `ReadOnlySpan<char>`

Es fügt auch Tie-Breaking-Regeln hinzu: Wenn sowohl eine `Span<T>`- als auch eine `ReadOnlySpan<T>`-Überladung für dasselbe Argument anwendbar sind, wird `ReadOnlySpan<T>` bevorzugt. Der Grund für diese Bevorzugung kommt später (kovariante Arrays), also behalten Sie ihn im Hinterkopf.

Das Roslyn-Team hat dies als [Verhaltens-Breaking-Change](https://learn.microsoft.com/en-us/dotnet/core/compatibility/core-libraries/10.0/csharp-overload-resolution) dokumentiert und als weiteren Eintrag in der Liste der [Compiler-Breaking-Changes seit C# 13](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/breaking-changes/compiler%20breaking%20changes%20-%20dotnet%2010). Es gibt keinen einzelnen Compiler-Fehlercode, der für "diese Auflösung hat sich geändert" feuert. Einige Szenarien kompilieren weiterhin stillschweigend, binden aber anders, einige produzieren jetzt `CS0121` "Der Aufruf ist mehrdeutig", und einige werfen zur Laufzeit. Die Lösungen hängen davon ab, in welchem Eimer Sie sich befinden.

## Eimer 1: Expression-Lambdas rufen jetzt `MemoryExtensions` statt `Enumerable` auf

Dieser ist der bösartigste, weil er problemlos kompiliert und erst zur Laufzeit bricht, wenn der Expression Tree interpretiert statt zu IL kompiliert wird.

```csharp
// C# 14, .NET 10
using System;
using System.Collections.Generic;
using System.Linq;
using System.Linq.Expressions;

Expression<Func<int[], int, bool>> e = (array, num) => array.Contains(num);
var fn = e.Compile(preferInterpretation: true);
fn(new[] { 1, 2, 3 }, 2); // throws at runtime
```

In C# 13 band `array.Contains(num)` innerhalb des Expression Tree an `System.Linq.Enumerable.Contains<T>(IEnumerable<T>, T)`. In C# 14 sieht der Compiler jetzt, dass `int[]` implizit zu `ReadOnlySpan<int>` konvertiert, also ist die bessere Übereinstimmung `System.MemoryExtensions.Contains<T>(ReadOnlySpan<T>, T)`. Der Expression Tree wird um `MemoryExtensions.Contains` herum gebaut. Wenn Sie Interpretation anfordern (`preferInterpretation: true`), kann der LINQ-Expression-Interpreter keine `ReadOnlySpan<T>`-Parameter in beliebigen Methodenaufrufen verarbeiten und wirft entweder eine `NotSupportedException` oder, in einigen älteren EF-Core-Providern, die den Baum übersetzen, eine `System.InvalidOperationException` über eine nicht unterstützte Methode.

Die Lösung ist, die Nicht-Span-Überladung innerhalb der Lambda explizit zu binden. Es gibt drei Idiome, die funktionieren:

```csharp
// .NET 10, C# 14
M((array, num) => ((IEnumerable<int>)array).Contains(num)); // cast forces Enumerable.Contains
M((array, num) => array.AsEnumerable().Contains(num));      // ditto, slightly less ugly
M((array, num) => Enumerable.Contains(array, num));         // explicit static call, no extension lookup

void M(Expression<Func<int[], int, bool>> e) => e.Compile(preferInterpretation: true);
```

Alle drei zwingen den Compiler, `Enumerable.Contains` statt `MemoryExtensions.Contains` zu binden. Die Cast-Variante ist zur Laufzeit am günstigsten (der Expression Tree enthält nur einen Cast-Knoten) und ist diejenige, zu der ich zuerst greife.

Wenn Sie eine Bibliothek pflegen, die Expression Trees im Auftrag von Aufrufern baut, prüfen Sie alle `IQueryable.Provider.Execute`-Pfade und jeden Code, der `Compile(preferInterpretation: true)` verwendet. EF Core 9 und höher kompilieren zu IL, also sind die meisten EF-Core-Abfragen nicht betroffen, aber jeder Drittanbieter-Expression-Interpreter schon.

## Eimer 2: xUnits Assert.Equal wird mehrdeutig

Wenn Sie dies jemals in einem xUnit-Test geschrieben haben, haben Sie eine Stolperfalle:

```csharp
// .NET 10, C# 14, xUnit 2.9+
var x = new long[] { 1 };
Assert.Equal([2], x);
// CS0121: The call is ambiguous between the following methods or properties:
// 'Assert.Equal<T>(T[], T[])' and 'Assert.Equal<T>(ReadOnlySpan<T>, Span<T>)'
```

Beide Überladungen sind anwendbar. Der Sammelausdruck `[2]` kann Ziel-Typisierung zu `long[]` oder zu `Span<long>` machen. Die Variable `x` ist `long[]`, was implizit zu entweder `T[]` oder `Span<T>` konvertiert. Es gibt keine einzige beste Überladung, also bekommen Sie `CS0121`.

Die empfohlene Lösung ist, eines der Argumente eindeutig zu machen:

```csharp
// .NET 10, C# 14
var x = new long[] { 1 };
Assert.Equal([2], x.AsSpan());   // binds to (ReadOnlySpan<T>, Span<T>)
// or
Assert.Equal<long>([2], x);      // generic argument disambiguates to (T[], T[]) when no Span overload matches T
```

Eine subtilere Variante stolpert, wenn Sie `T[]` und `ArraySegment<T>` mischen:

```csharp
// .NET 10, C# 14
var y = new int[] { 1, 2 };
var s = new ArraySegment<int>(y, 1, 1);
Assert.Equal(y, s); // previously bound to Assert.Equal<T>(T, T), now ambiguous with Assert.Equal<T>(Span<T>, Span<T>)
Assert.Equal(y.AsSpan(), s); // workaround
```

`ArraySegment<int>` hat eine implizite Konvertierung sowohl zu `Span<int>` als auch zu `ReadOnlySpan<int>`, und jetzt hat sie `int[]` auch, also wird die Span-Überladung anwendbar und konkurriert mit der generischen `T, T`.

Wenn Sie die API-Oberfläche kontrollieren (Sie haben `Assert.Equal` geschrieben), ist die richtige Lösung, [`OverloadResolutionPriorityAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.overloadresolutionpriorityattribute) auf eine der Überladungen anzuwenden, um die Auflösung zu lenken. xUnit hat dies in 2.9.x genau aus diesem Grund ausgeliefert. Wenn Sie die API nicht neu kompilieren können, müssen Sie an der Aufrufstelle eindeutig machen.

## Eimer 3: Kovariante Arrays werfen `ArrayTypeMismatchException`

Das ist der Bug, der tatsächlich Daten löscht, und der Grund, warum das Sprachkomitee in C# 14 `ReadOnlySpan<T>` über `Span<T>` gewinnen ließ.

```csharp
// .NET 10, C# 14
using System;
using System.Collections.Generic;
using System.Linq;

string[] s = new[] { "a" };
object[] o = s; // array variance: legal since C# 1

C.R(o);             // C# 13: prints 1 (IEnumerable overload). C# 14: ArrayTypeMismatchException
C.R(o.AsEnumerable()); // workaround

static class C
{
    public static void R<T>(IEnumerable<T> e) => Console.Write(1);
    public static void R<T>(Span<T> s)        => Console.Write(2);
}
```

Was passiert: `object[] o` ist unter der Haube tatsächlich ein `string[]`. In C# 13 war die einzige anwendbare Überladung `R<T>(IEnumerable<T>)`, also wurde `1` ausgegeben. In C# 14 ist `R<T>(Span<T>)` ebenfalls anwendbar, weil `T[]` jetzt implizit zu `Span<T>` konvertiert. Der Compiler wählt die Span-Überladung (sie ist "spezifischer"), fügt einen `Span<object>(o)`-Konstruktoraufruf ein, und der Konstruktor wirft zur Laufzeit `System.ArrayTypeMismatchException`, weil Sie `object` nicht in ein zugrundeliegendes `string[]` schreiben können.

Deshalb bevorzugen die Tie-Breaking-Regeln von C# 14 `ReadOnlySpan<T>` gegenüber `Span<T>`: Ein `ReadOnlySpan<T>` kann nicht in das zugrundeliegende Array schreiben, also ist es mit kovarianten Arrays sicher. Die empfohlene Lösung, wenn Sie die API kontrollieren, ist, eine `ReadOnlySpan<T>`-Überladung hinzuzufügen:

```csharp
// .NET 10, C# 14
static class C
{
    public static void R<T>(IEnumerable<T> e)    => Console.Write(1);
    public static void R<T>(Span<T> s)           => Console.Write(2);
    public static void R<T>(ReadOnlySpan<T> s)   => Console.Write(3); // wins over Span<T> in C# 14
}
```

Jetzt gibt `C.R(o)` `3` aus (keine Ausnahme). Wenn Sie keine Überladung hinzufügen können, ist die Lösung an der Aufrufstelle `o.AsEnumerable()` oder `((IEnumerable<object>)o)`.

## Eimer 4: `MemoryMarshal.Cast` und der ReadOnlySpan-Tie-Break

Die Bevorzugung von `ReadOnlySpan<T>` bricht auch einige Bibliotheksmuster, bei denen der Autor beabsichtigte, dass Sie sich durch Übergabe eines `Span<T>` für eine Überladung entscheiden:

```csharp
// .NET 10, C# 14
using System.Runtime.InteropServices;

double[] x = new double[0];
Span<ulong> y = MemoryMarshal.Cast<double, ulong>(x);
// CS0029: Cannot implicitly convert type 'ReadOnlySpan<ulong>' to 'Span<ulong>'
Span<ulong> z = MemoryMarshal.Cast<double, ulong>(x.AsSpan()); // workaround
```

`MemoryMarshal.Cast` hat sowohl `Cast<TFrom, TTo>(Span<TFrom>)` als auch `Cast<TFrom, TTo>(ReadOnlySpan<TFrom>)`. In C# 13 wurde die Übergabe eines `double[]` über die benutzerdefinierte Konvertierung zu `Span<TFrom>` aufgelöst, weil es keinen Tie-Break gab und `Span<T>` das "direkte" Ziel war. In C# 14 sind beide Überladungen über die neuen eingebauten Konvertierungen anwendbar, die `ReadOnlySpan<T>`-Überladung gewinnt den Tie-Break, und das Ergebnis ist nicht mehr einer `Span<ulong>`-Lokalen zuweisbar. Sie rufen entweder `.AsSpan()` explizit auf, um die Array-zu-Span-Konvertierung zu überspringen (sie produziert direkt einen `Span<double>`, der nur zur `Span`-Überladung passt), oder ändern den Typ der Lokalen zu `ReadOnlySpan<ulong>`, falls Sie keine Veränderbarkeit benötigen.

## Der `Enumerable.Reverse`-Sonderfall für ältere Ziele

Es gibt eine zusätzliche Falle, die nur eine nicht unterstützte Konfiguration betrifft, aber es lohnt sich zu erwähnen, weil sie in Legacy-Migrationsprojekten auftaucht. Wenn Sie `<LangVersion>14.0</LangVersion>` setzen, aber auf ein älteres TFM wie `net8.0` mit einer `System.Memory`-Referenz zielen, passiert dies:

```csharp
// LangVersion 14, TargetFramework net8.0 (unsupported)
int[] x = new[] { 1, 2, 3 };
var y = x.Reverse(); // C# 13: Enumerable.Reverse, returns IEnumerable<int>
                     // C# 14: MemoryExtensions.Reverse, void in-place reverse
```

`MemoryExtensions.Reverse(Span<T>)` kehrt in-place um und gibt `void` zurück, während `Enumerable.Reverse(IEnumerable<T>)` die umgekehrte Sequenz zurückgibt. Die Semantik dreht sich, und `y` ist nicht mehr iterierbar. Auf `net10.0` wird dies durch eine neue `Enumerable.Reverse(this T[])`-Überladung gepatcht, die Vorrang hat, also taucht der Bruch nur auf, wenn Sie neuen Compiler mit alter BCL mischen. Die richtige Lösung ist, das TFM zu aktualisieren, aber wenn Sie das nicht können, rufen Sie `Enumerable.Reverse(x)` explizit auf oder definieren Sie Ihre eigene `Reverse(this T[])`-Erweiterung in Ihrem Namespace.

## Vor der Laufzeit erkennen

Einige praktische Abhilfen für ein laufendes Upgrade:

- Setzen Sie `<LangVersion>13.0</LangVersion>` für einzelne Projekte, während Sie triagieren. C#-14-Features, die nicht mit Spans zusammenhängen (Lambda-Parameter-Modifikatoren, partielle Konstruktoren, `field`-Schlüsselwort), werden deaktiviert, aber die Auflösung bleibt vorhersehbar.
- Aktivieren Sie den Roslyn-Analyzer [CA1872](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1872) und die ReSharper/Rider-Inspektion ["C# 14 breaking change in overload resolution with span parameters"](https://www.jetbrains.com/help/resharper/CSharp14OverloadResolutionWithSpanBreakingChange.html). Die Rider-Inspektion hebt insbesondere Aufrufstellen hervor, an denen die neuen Konvertierungen ändern, welche Überladung ausgewählt wird.
- Prüfen Sie `Compile(preferInterpretation: true)` und jeden Drittanbieter-Expression-Tree-Konsumenten (z. B. ältere EF6-Provider, Marten 6.x, Linq2DB vor 5.x). Sie sind die risikoreichsten Stellen, weil die Änderung zur Kompilierzeit stillschweigend ist.
- Suchen Sie nach `Assert.Equal(`, `Assert.Contains(` und ähnlichen sammlungstypisierten Assertions in Ihrer Test-Suite. Aktualisieren Sie xUnit auf eine Version mit `OverloadResolutionPriorityAttribute`-Annotationen (xUnit 2.9.x oder neuer).

Wenn Sie API-Autor sind, ist die sauberste langfristige Lösung, `ReadOnlySpan<T>`-Überladungen neben jeder vorhandenen `Span<T>`-Überladung hinzuzufügen und `[OverloadResolutionPriority(1)]` auf diejenige anzuwenden, an die Aufrufer binden sollen. Das Attribut wird von den C#-13- und C#-14-Compilern beachtet (es wird in älteren `LangVersion`-Einstellungen ignoriert, das ist der eine Haken), also deckt es die meisten Migrationsszenarien ab.

## Verwandtes

Wenn Sie den Hintergrund wollen, warum diese Konvertierungen überhaupt existieren, deckt der Deep Dive zu [impliziten Span-Konvertierungen in C# 14 und First-Class-Unterstützung für Span und ReadOnlySpan](/de/2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan/) die vollständige Konvertierungstabelle und die Motivation ab. Der breitere Beitrag [Was ist neu in C# 14](/de/2024/12/csharp-14/) listet die anderen Breaking Changes auf, die Sie beim gleichen Upgrade erwarten sollten, einschließlich des `scoped`-Lambda-Parameter-Modifikators und des kontextuellen `field`-Schlüsselworts. Für eine Vorschau auf die kommende Sprache baut [C# 15 Sammelausdruck-Argumente](/de/2026/04/csharp-15-collection-expression-arguments/) auf diesen Span-Regeln auf und ist lesenswert, sobald Sie damit vertraut sind, wie der Compiler zwischen Span- und Nicht-Span-Zielen wählt.

## Quellen

- [Breaking change: C# 14 overload resolution with span parameters (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/core/compatibility/core-libraries/10.0/csharp-overload-resolution)
- [C# compiler breaking changes since C# 13 (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/breaking-changes/compiler%20breaking%20changes%20-%20dotnet%2010)
- [First-class span types proposal (dotnet/csharplang)](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-14.0/first-class-span-types.md)
- [Issue dotnet/docs#43952: covariant array overload selection](https://github.com/dotnet/docs/issues/43952)
- [OverloadResolutionPriorityAttribute (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.overloadresolutionpriorityattribute)
- [Rider inspection: C# 14 overload resolution with span parameters (JetBrains)](https://www.jetbrains.com/help/rider/CSharp14OverloadResolutionWithSpanBreakingChange.html)
