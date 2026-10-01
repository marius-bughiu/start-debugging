---
title: "Fix: CS8509 oder CS0161 bei einem switch, der über einen C# 15 Union-Typ exhaustiv ist"
description: "Schalten Sie auf den Union-Wert statt auf .Value und verwenden Sie einen switch-Ausdruck oder ergänzen Sie in einer switch-Anweisung case null. Anweisungen brauchen Null-Abdeckung, bei Ausdrücken gibt es nur eine Warnung."
pubDate: 2026-10-01
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-15"
  - "dotnet-11"
  - "pattern-matching"
lang: "de"
translationOf: "2026/10/fix-cs8509-cs0161-switch-exhaustive-over-csharp-15-union-type"
translatedBy: "claude"
translationDate: 2026-10-01
---

Schalten Sie auf den Union-Wert selbst, nicht auf seine Eigenschaft `.Value`, und bevorzugen Sie einen switch-Ausdruck. Brauchen Sie in einer Methode mit Rückgabewert eine switch-Anweisung, ergänzen Sie einen `case null:`-Zweig (oder ein `throw` nach dem switch): Der Compiler betrachtet eine switch-Anweisung über eine Union nur dann als vollständig, wenn auch das null-`Value` einer `default`-Union abgedeckt ist. Das gesamte Verhalten unten wurde mit dem .NET 11 RC1 SDK (`11.0.100-rc.1.26425.128`, C# 15, kein `LangVersion`-Override nötig) gemessen.

## Der Fehler im Kontext

Sie haben eine Union deklariert, jeden Case-Typ abgedeckt, und der Compiler behauptet trotzdem, Sie hätten es nicht getan:

```text
warning CS8509: The switch expression does not handle all possible values of its input type (it is not exhaustive). For example, the pattern '_' is not covered.
error CS0161: 'Pets.Describe(Pet)': not all code paths return a value
error CS0165: Use of unassigned local variable 's'
warning CS8655: The switch expression does not handle some null inputs (it is not exhaustive). For example, the pattern 'null' is not covered.
error CS8780: A variable may not be declared within a 'not' or an 'or' pattern or a union matching involving matching against either the instance, or its underlying value.
```

Das sind fünf verschiedene Symptome desselben Missverständnisses: Exhaustivität bei Unions in C# 15 ist eine Eigenschaft des **Union-Matchings**, und Union-Matching greift nur unter bestimmten Bedingungen. Verlassen Sie diese Bedingungen, sind Sie zurück beim gewöhnlichen Mustervergleich auf `object`, bei dem zwei Typmuster nie exhaustiv sind.

## Warum der Compiler Ihren switch nicht als exhaustiv ansieht

Die [Unions-Spezifikation](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-15.0/unions.md#union-exhaustiveness) von C# 15 sagt es in einem Satz: Ein Union-Typ gilt als durch seine Case-Typen "exhausted", ein `switch`-Ausdruck ist also exhaustiv, wenn er alle Case-Typen der Union behandelt. Alles andere ergibt sich aus dem Kleingedruckten.

1. **Die Eingabe muss der Union-Wert sein.** Union-Matching findet nur statt, "when the input value of a pattern is of a union type or of a nullable of a union type". Wenn Sie auf `pet.Value` (Typ `object?`) schalten oder auf eine Union, die in `object` geboxt wurde, bekommt der Compiler keine Case-Liste und verlangt `_`.
2. **switch-Anweisungen sind strenger als switch-Ausdrücke.** Ein switch-Ausdruck mit unbehandeltem `null` kompiliert mit einer CS8655-Warnung. Eine switch-Anweisung, die für die Definite-Assignment- oder Rückgabepfad-Analyse herangezogen wird, gilt nur als vollständig, wenn auch `null` abgedeckt ist. Das Ende des `switch` bleibt dann erreichbar, und Sie erhalten CS0161 oder CS0165.
3. **Das `Value` einer Union kann immer null sein.** `public union Pet(Cat, Dog)` wird zu einem Struct mit `public object? Value { get; }` heruntergebrochen. `default(Pet)` enthält `null`, ebenso `new Pet((Cat)null!)`. Die Spezifikation führt das unter [Well-formedness](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-15.0/unions.md#well-formedness) auf: `Value` ist "null or a value of a case type".
4. **Typparameter werden nicht entpackt.** Ein Case-Typ `T` in `union Result<T>(T, Exception)` lässt sich nicht mit einer Variablenbezeichnung per Mustervergleich abgleichen, weil der Compiler nicht beweisen kann, ob `T v` die Union-Instanz oder deren Inhalt prüfen soll. Das ist CS8780.

## Minimales Beispiel zur Reproduktion

```csharp
// .NET 11 RC1 SDK 11.0.100-rc.1.26425.128, C# 15, <Nullable>enable</Nullable>
public record Cat(string Name);
public record Dog(string Name);
public union Pet(Cat, Dog);
public union MaybePet(Cat?, Dog);
public union Result<T>(T, Exception);

static class Pets
{
    // OK: no diagnostics
    static string A(Pet p) => p switch { Cat c => c.Name, Dog d => d.Name };

    // CS8509: pattern '_' is not covered
    static string B(Pet p) => p.Value switch { Cat c => c.Name, Dog d => d.Name };

    // CS0161: not all code paths return a value
    static string Describe(Pet p)
    {
        switch (p)
        {
            case Cat c: return c.Name;
            case Dog d: return d.Name;
        }
    }

    // CS8655: pattern 'null' is not covered (Cat? is a nullable case type)
    static string D(MaybePet p) => p switch { Cat c => c.Name, Dog d => d.Name };

    // CS8509: a union boxed into object is just an object
    static string E(object o) => o switch { Cat c => c.Name, Dog d => d.Name };

    // CS8655: Nullable<Pet> can be null
    static string F(Pet? p) => p switch { Cat c => c.Name, Dog d => d.Name };

    // CS8780 on 'TV v'
    static string I<TV>(Result<TV> r) => r switch { TV v => v!.ToString()!, Exception e => e.Message };
}
```

Methode `A` ist der Referenzpunkt: Der Union-Wert geht direkt in einen switch-Ausdruck, jeder Case-Typ hat einen Zweig, und der Compiler schweigt. Jede andere Methode verletzt eine der vier obigen Regeln.

## Die Lösung im Detail

Gehen Sie diese Schritte der Reihe nach durch. Der erste behebt die meisten Fälle aus der Praxis.

### 1. Die Union abgleichen, nicht `.Value`

`Value` ist als `object?` deklariert. Sobald Sie darauf zugreifen, haben Sie den Union-Typ und seine Case-Liste weggeworfen. Der Mustervergleich auf der Union entpackt den Inhalt bereits für Sie: `p is Cat c` wird als Test auf `p.Value` kompiliert, es gibt also keinen Grund, selbst auf `.Value` zuzugreifen.

```csharp
// .NET 11 RC1, C# 15
// Before: CS8509
static string Name(Pet p) => p.Value switch { Cat c => c.Name, Dog d => d.Name };

// After: exhaustive, no default arm
static string Name(Pet p) => p switch { Cat c => c.Name, Dog d => d.Name };
```

Dasselbe gilt für eine Union, die über ein `object`, `IUnion` oder einen generischen `T`-Parameter weitergereicht wird. Laut der [geklärten Frage](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-15.0/unions.md#resolved-confirm-that-a-type-parameter-is-never-a-union-type-even-when-constrained-to-one) in der Spezifikation ist ein Typparameter nie ein Union-Typ, auch nicht mit entsprechender Einschränkung. In RC1 kommt `static string L<TU>(TU u) where TU : struct, IUnion => u switch { Cat c => ..., Dog d => ... }` gar nicht erst bis zur Exhaustivitätsprüfung: Es scheitert mit CS8121, "An expression of type 'TU' cannot be handled by a pattern of type 'Cat'". Behalten Sie den konkreten Union-Typ in der Signatur.

Eine teilweise Ausnahme: Eigenschaftsmuster auf `Value` übernehmen in RC1 durchaus das Union-Wissen. `r switch { { Value: TV v } => ..., { Value: Exception e } => ... }` erzeugte nur CS8655, nicht CS8509. Die Spezifikation führt "Should direct Value property matching follow Union rules?" weiterhin als offene Frage, bauen Sie also nicht darauf auf.

### 2. Einen switch-Ausdruck bevorzugen; einer switch-Anweisung ein `case null` geben

Das ist der Fall CS0161 / CS0165 und der überraschendste, weil dieselben Zweige als Ausdruck funktionieren. Ich habe drei Varianten mit RC1 gemessen:

```csharp
// .NET 11 RC1, C# 15
public union Pet(Cat, Dog);
public closed class Shape;
public sealed class Sq : Shape;
public sealed class Ci : Shape;

// error CS0161
static string S1(Pet p) { switch (p) { case Cat c: return c.Name; case Dog d: return d.Name; } }

// compiles
static string S2(Pet p) { switch (p) { case Cat c: return c.Name; case Dog d: return d.Name; case null: return "none"; } }

// compiles: bool is exhaustive for statements
static int S3(bool b) { switch (b) { case true: return 1; case false: return 0; } }

// error CS0161: closed hierarchies behave like unions here
static int S4(Shape s) { switch (s) { case Sq: return 1; case Ci: return 0; } }
```

`S3` beweist, dass der Compiler für switch-Anweisungen durchaus Exhaustivität prüft. Was er nicht tut, ist ein nicht abgedecktes `null` zu ignorieren. Ein switch-Ausdruck stuft das fehlende `null` zu einer Nullable-Warnung herab (und bei einer Union, deren Case-Typen alle nicht nullbar sind, zu gar nichts). Eine switch-Anweisung verwendet für die Erreichbarkeit die vollständige Exhaustivitätsantwort, und diese schließt `null` ein. Auch `#nullable disable` ändert daran nichts: Der RC1-Compiler meldet CS0161 weiterhin sowohl für die Union als auch für die geschlossene Klasse.

Es gibt drei saubere Lösungen, nach Präferenz geordnet:

```csharp
// .NET 11 RC1, C# 15
using System.Diagnostics;

// a) Use an expression. Most switch statements that only return can be one.
static string Describe(Pet p) => p switch { Cat c => c.Name, Dog d => d.Name };

// b) Cover null explicitly. Use this when a default union is a legitimate state.
static string Describe2(Pet p)
{
    switch (p)
    {
        case Cat c: return c.Name;
        case Dog d: return d.Name;
        case null: return "no pet";
    }
}

// c) Keep the statement and declare the end unreachable.
static string Describe3(Pet p)
{
    switch (p)
    {
        case Cat c: return c.Name;
        case Dog d: return d.Name;
    }
    throw new UnreachableException();
}
```

Vermeiden Sie `default:` als Lösung. Es kompiliert zwar, verschluckt aber auch den nächsten Case-Typ, den Sie der Union hinzufügen, und genau diese Diagnose wollten Sie eigentlich behalten.

Die CS0165-Variante ist dasselbe Problem in Zuweisungsform: `string s; switch (p) { case Cat c: s = ...; break; case Dog d: s = ...; break; } return s;` scheitert, weil das Ende des switch erreichbar ist, während `s` nicht zugewiesen ist. Es gelten dieselben drei Lösungen.

### 3. null behandeln, wo der Typ null erlaubt

CS8655 ist der Compiler, der recht hat. Sie erhalten es in zwei Situationen:

- Einer der Case-Typen ist nullbar, wie in `union MaybePet(Cat?, Dog)`. Die Regel der Spezifikation: Der Standard-Null-Zustand von `Value` ist "maybe null", wenn ein Case-Typ "maybe null" ist.
- Die Eingabe ist `Pet?` (ein `Nullable<Pet>`), das von sich aus `null` sein kann.

Ergänzen Sie einen `null`-Zweig. Bei einer Union passt `null` sowohl auf eine null-Instanz als auch auf eine Union, deren `Value` null ist:

```csharp
// .NET 11 RC1, C# 15
static string D(MaybePet p) => p switch
{
    Cat c => c.Name,
    Dog d => d.Name,
    null => "none",
};
```

War der nullbare Case-Typ unbeabsichtigt, entfernen Sie stattdessen das `?` aus der Union-Deklaration.

### 4. Die Variablenbezeichnung bei Case-Typen mit Typparametern weglassen

Für `union Result<T>(T, Exception)` scheitert der Zweig `T v` mit CS8780, unabhängig von der Einschränkung. Ich habe es uneingeschränkt, mit `where T : notnull`, `where T : class` und `where T : struct` versucht: Alle vier melden in RC1 CS8780. Es funktioniert ein Typmuster ohne Variable, oder den generischen Fall zuletzt mit `var` abzufangen:

```csharp
// .NET 11 RC1, C# 15
public union Result<T>(T, Exception);

// Exhaustive and clean with notnull: prints "v:5" for new Result<int>(5)
static string W4<TV>(Result<TV> r) where TV : notnull =>
    r switch { TV => "v:" + r.Value, Exception => "e" };

// Match the concrete case first, let var take the rest
static string W3<TV>(Result<TV> r) =>
    r switch { Exception e => e.Message, var other => other.Value!.ToString()! };
```

Ohne die Einschränkung `notnull` kompiliert die Form `TV =>` weiterhin, fügt aber CS8655 hinzu, weil `TV` ein nullbarer Typ sein könnte. Beachten Sie, dass `var` eine Union nicht entpackt: `other` ist das `Result<TV>`, nicht dessen Inhalt, weshalb Sie `.Value` daraus lesen.

## Die Laufzeitseite: Eine default-Union wirft weiterhin

Den Compiler zum Schweigen zu bringen heißt nicht, jeden Wert zu behandeln. Eine Union, deren Case-Typen alle nicht nullbar sind, löst keine Warnung aus, wenn Sie über `default` schalten:

```csharp
// .NET 11 RC1, C# 15
public union Result2(int, Exception);

static string Show(Result2 r) => r switch { int v => v.ToString(), Exception e => e.Message };

Show(default); // System.Runtime.CompilerServices.SwitchExpressionException at runtime
```

Die geklärte Frage "Default nullable state of `Value` property" in der Spezifikation räumt ein, dass `default(U).Value` gleich `null` ist, während die Nullable-Analyse nur die Case-Typen betrachtet. In der Praxis taucht eine default-Union als nie zugewiesenes Feld, als Array-Element, als `default`-Rückgabe in generischem Code oder als deserialisierte Nutzlast auf, die die Union nicht befüllt hat. Falls einer dieser Pfade existiert, ergänzen Sie den `null`-Zweig, obwohl der Compiler keinen verlangt, oder validieren Sie an der Grenze. Dasselbe Prinzip gilt für [nicht nullbare Eigenschaften, die im Konstruktor nie gesetzt werden](/de/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/): Die Annotation beschreibt die Absicht, keine Laufzeitgarantie.

## Stolperfallen und Verwechslungen

- **CS8846** ("However, a pattern with a 'when' clause might successfully match this value") bedeutet, dass ein Case-Typ nur unter einer `when`-Bedingung abgedeckt ist. Ergänzen Sie für diesen Typ einen Zweig ohne Bedingung. Das ist kein Union-Fehler.
- **CS8509 mit Nennung eines konkreten Typs**, etwa "the pattern 'Dog' is not covered", ist die ehrliche Variante des Fehlers: Es fehlt tatsächlich ein Case-Typ. Diese Diagnose schlägt überall an, wenn jemand einer gemeinsam genutzten Union einen Case hinzufügt, und ist der Grund, `default`- und `_`-Zweige zu vermeiden.
- **Case-Typen, die Interfaces oder Basisklassen sind**, werden durch diesen Typ ausgeschöpft, nicht durch seine Untertypen. Bei `union Shape(IShape, string)` decken Zweige für `Circle` und `Square` `IShape` nicht ab. Wenn Sie Exhaustivität über Untertypen wollen, machen Sie die Basis zu einer [geschlossenen Klassenhierarchie](/de/2026/06/csharp-15-closed-class-hierarchies-dotnet-11-preview-5/) und fügen sie als Case-Typ hinzu.
- **Ältere Previews.** Wenn Sie noch auf .NET 11 Preview 2 mit selbst deklarierten `UnionAttribute`- und `IUnion`-Typen arbeiten, wie in der [ursprünglichen Ankündigung der Union-Typen](/de/2026/04/csharp-15-union-types-dotnet-11-preview-2/) beschrieben, haben sich die Exhaustivitäts-Diagnosen zwischen den Previews geändert. Aktualisieren Sie auf RC1, bevor Sie einem der obigen Fehler nachgehen.
- **Analyzer und generierter Code.** Code, der Unions als `object` erhält, etwa ein JSON-Converter oder ein Model Binder, fällt unter Regel 1. Das Verhalten von Serialisierung und Binding ist in [Serialisieren von C# Union-Typen mit System.Text.Json](/de/2026/07/serialize-csharp-union-types-with-system-text-json-dotnet-11-preview-6/) und [wo Union-Binding in ASP.NET Core 11 funktioniert](/de/2026/09/csharp-unions-in-aspnetcore-11-where-binding-works/) beschrieben.

## Verwandte Themen

- [C# 15 Union-Typen sind da](/de/2026/04/csharp-15-union-types-dotnet-11-preview-2/) für die Deklarationssyntax und implizite Konvertierungen.
- [C# 15 geschlossene Klassenhierarchien](/de/2026/06/csharp-15-closed-class-hierarchies-dotnet-11-preview-5/), die das oben gemessene switch-Anweisungs-Verhalten teilen.
- [Serialisieren von C# Union-Typen mit System.Text.Json](/de/2026/07/serialize-csharp-union-types-with-system-text-json-dotnet-11-preview-6/) für Unions, die eine Übertragungsgrenze überqueren.
- [Mehrere Werte aus einer Methode in C# zurückgeben](/de/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/), wenn Sie eine `Result<T>`-Union gegen Tupel oder out-Parameter abwägen.
- [CS8618 bei nicht nullbaren Eigenschaften beheben](/de/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/) für die Nullable-Analyse-Seite derselben Geschichte.

## Quellen

- [C# 15 unions specification (csharplang)](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-15.0/unions.md): Union-Matching, Exhaustivität, Nullbarkeit, Lowering und die oben zitierten geklärten Fragen.
- [Union types reference on Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/union).
- [Pattern matching warnings, including CS8509, CS8655 and CS8846](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/pattern-matching-warnings).
- Alle Diagnosen und Laufzeitergebnisse lokal mit dem .NET 11 RC1 SDK `11.0.100-rc.1.26425.128` unter macOS reproduziert, `net11.0`, `<Nullable>enable</Nullable>`.
