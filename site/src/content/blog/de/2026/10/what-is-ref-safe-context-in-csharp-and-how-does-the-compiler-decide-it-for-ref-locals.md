---
title: "Was ist ref-safe-context in C#, und wie legt der Compiler sie für ref-Locals fest?"
description: "ref-safe-context ist der Gültigkeitsbereich, in dem ein Verweis auf eine Variable gültig bleibt. Hier sind die vier Contexts, die Regel, die den Context eines ref-Locals bei seinem Initialisierer festlegt, der Grund, warum eine ref-Neuzuweisung ihn nie erweitern oder einengen kann, und die daraus folgenden Fehler CS8157, CS8168, CS8374 und CS9079, mit Compiler-Ausgabe von C# 14 auf .NET 10 und .NET 11 RC1."
pubDate: 2026-10-15
template: how-to
tags:
  - "csharp"
  - "csharp-14"
  - "dotnet-11"
  - "ref-locals"
  - "span"
  - "compiler-errors"
lang: "de"
translationOf: "2026/10/what-is-ref-safe-context-in-csharp-and-how-does-the-compiler-decide-it-for-ref-locals"
translatedBy: "claude"
translationDate: 2026-10-15
---

Kurze Antwort: ref-safe-context (Gültigkeitsbereich für Referenzen) ist der Codebereich, in dem ein Verweis (ein `ref`-Local, ein `ref`-Rückgabewert, ein `ref`-Feld) auf eine bestimmte Variable garantiert auf lebenden Speicher zeigt. Der C#-Compiler weist jeder Variable einen von vier Contexts zu, vom engsten zum weitesten: declaration-block, function-member, return-only und caller-context. Ein `ref`-Local bekommt keinen eigenen Context. Es übernimmt die ref-safe-context des Ausdrucks, mit dem es initialisiert wurde, dieser Context bleibt für seine gesamte Lebensdauer fest, und jedes spätere `r = ref other;` muss auf etwas zeigen, dessen Context mindestens so weit ist. Diese eine Regel erklärt, warum ein `ref`-Local, das aus einer Stack-Variablen initialisiert wurde, nie zurückgegeben werden kann, selbst wenn Sie es später auf ein Array-Element umbiegen.

Jedes Ergebnis in diesem Beitrag stammt aus echten Builds: dem .NET 10 SDK 10.0.302 mit `<LangVersion>14</LangVersion>` und denselben Dateien, neu kompiliert mit dem .NET 11 RC1 SDK (11.0.100-rc.1.26425.128). Die Diagnosen sind auf beiden identisch und stammen direkt aus der Compiler-Ausgabe, nicht aus einer Paraphrase.

## Warum der Compiler überhaupt einen "Context" verfolgt

Ein `ref` in C# ist ein verwalteter Zeiger. Er kann in den Heap zeigen (ein Array-Element, ein Feld einer Klasseninstanz), in statischen Speicher oder in einen Stack-Frame (ein Local, ein Parameter). Heap und statischer Speicher überdauern jeden Methodenaufruf. Ein Stack-Frame endet, wenn seine Methode zurückkehrt. Könnte eine Methode ein `ref` auf eines ihrer eigenen Locals herausgeben, hielte der Aufrufer einen Zeiger in einen toten Frame, genau der Use-after-free-Fehler, den `ref` gerade nicht haben sollte.

C# löst das nicht mit einer Laufzeitprüfung, sondern statisch: Jede Variable erhält eine ref-safe-context, die beschreibt, wie weit ein Verweis auf sie wandern darf, und jede Stelle, die einen Verweis speichert oder zurückgibt, prüft, dass der Context des Referenten mindestens so weit ist wie der des Verweises selbst. Der C#-Standard fasst es in einem Satz zusammen, in [Abschnitt 9.7.2](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/variables#972-ref-safe-contexts): "The referent of a reference variable shall have a ref-safe-context that is at least as wide as the ref-safe-context of the reference variable itself."

Daneben gibt es ein verwandtes Konzept, die safe-context, die für Werte von `ref struct`-Typen wie `Span<T>` gilt. Die ref-safe-context beantwortet "Wie lange ist ein Verweis auf diese Variable gültig?" Die safe-context beantwortet "Wie lange ist der in dieser Variable gespeicherte Wert (der selbst Verweise enthält) gültig?" Der Großteil dieses Beitrags handelt von der ersten, aber beide treffen sich bei den Indexern von `Span<T>`, was weiter unten behandelt wird.

## Die vier Contexts, vom engsten zum weitesten

| Context | Was ihn hat | Per ref zurückgebbar? |
| --- | --- | --- |
| declaration-block | Gewöhnliche Locals, beschränkt auf den Block, in dem sie deklariert sind | Nein |
| function-member | Wertparameter, `out`-Parameter, `this` in einer Struct-Methode, `scoped ref`-Locals und -Parameter | Nein |
| return-only | `ref`- und `in`-Parameter | Ja, nur über `return ref` |
| caller-context | Array-Elemente, Felder von Klasseninstanzen, statische Felder, Felder, die über `ref`-Parameter erreicht werden | Ja |

Zwei Details gehen leicht unter. Erstens gilt declaration-block wirklich pro Block: Ein Local, das im Rumpf eines `if` deklariert wird, hat einen engeren Context als eines am Anfang der Methode. Zweitens existiert return-only, damit ein `ref`-Parameter zurückgegeben werden kann (`return ref p;` ist erlaubt), aber nicht an einer Stelle gespeichert werden kann, die den Aufruf überdauert, etwa in einem `ref`-Feld eines vom Aufrufer übergebenen `ref struct`. Diese Stufe kam in C# 11 als Teil der [Low-Level-Struct-Verbesserungen](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-11.0/low-level-struct-improvements) hinzu.

Hier die Ausgangslage im Code, jede Methode kompiliert unter C# 14:

```csharp
// .NET 10 SDK 10.0.302, C# 14 (same result on .NET 11 RC1)
class Contexts
{
    int[] _arr = new int[10];
    static int s_counter;

    // declaration-block: error CS8168
    static ref int FromLocal() { int v = 5; return ref v; }

    // function-member (value parameter): error CS8157 once aliased
    static ref int FromValueParam(int p) { ref int r = ref p; return ref r; }

    // return-only (ref parameter): OK
    static ref int FromRefParam(ref int p) { ref int r = ref p; return ref r; }

    // caller-context (array element): OK
    ref int FromArray() { ref int r = ref _arr[3]; return ref r; }

    // caller-context (static field): OK
    static ref int FromStatic() { ref int r = ref s_counter; return ref r; }
}
```

Die zwei Fehler:

```text
error CS8168: Cannot return local 'v' by reference because it is not a ref local
error CS8157: Cannot return 'r' by reference because it was initialized to a value that cannot be returned by reference
```

Lesen Sie die Formulierung von CS8157 genau: "because it was initialized to". Der Compiler schaut nicht darauf, worauf `r` beim `return` zeigt. Er schaut darauf, womit `r` initialisiert wurde.

## Wie ein ref-Local seinen Context bekommt

Die Regel des Standards für Locals ([Abschnitt 9.7.2.2](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/variables#9722-local-variable-ref-safe-context)) umfasst zwei Zeilen:

- Ist `v` eine Referenzvariable, entspricht ihre ref-safe-context der ref-safe-context ihres Initialisierungsausdrucks.
- Andernfalls ist ihre ref-safe-context declaration-block.

Der Compiler legt den Context eines `ref`-Locals also an genau einer Stelle fest: bei der Deklaration. Der Initialisierungsausdruck wird mit diesen Regeln auf seinen Context hin ausgewertet:

1. Ein Local oder ein Wertparameter: sein eigener Context (declaration-block oder function-member).
2. Ein `ref`- oder `in`-Parameter: return-only.
3. Ein Feld `e.F` einer Klasseninstanz, ein Array-Element, ein statisches Feld: caller-context.
4. Ein Feld `e.F` eines Structs: der Context von `e`. Ein Feld eines Struct-Locals ist declaration-block; ein Feld von `this` in einer Struct-Methode ist function-member.
5. Ein bedingter Ausdruck `c ? ref a : ref b`: der engere von `a` und `b`.
6. Der Aufruf einer `ref`-zurückgebenden Methode, Eigenschaft oder eines Indexers: der engste Wert aus caller-context und der ref-safe-context jedes `ref`-Arguments (plus der safe-context jedes Arguments, den Empfänger eingeschlossen), wobei Argumente übersprungen werden, die an `scoped`- und `out`-Parameter gebunden sind.

Regel 6 überrascht die Leute am meisten, denn sie bedeutet, dass ein völlig harmloser Helfer ein `ref`-Local vergiften kann:

```csharp
// .NET 10 SDK 10.0.302, C# 14
static ref int Pick(ref int a) => ref a;

static ref int ThroughHelper()
{
    int v = 5;
    ref int r = ref Pick(ref v); // r inherits v's declaration-block context
    return ref r;                // error CS8157
}
```

`Pick` selbst ist in Ordnung, es gibt seinen eigenen `ref`-Parameter zurück. Aber der Compiler schaut nicht in `Pick` hinein. Er sieht nur die Signatur: "gibt ein `ref` zurück, das jedes meiner `ref`-Argumente sein kann". Der Context des Ergebnisses ist also der des engsten Arguments, und dieses Argument ist ein Local. So verhindert die Spezifikation, dass eine Stack-Referenz über einen Methodenaufruf gewaschen wird.

Der Ausweg, wenn der Helfer dieses Argument tatsächlich nie zurückgibt, ist, das mit `scoped` zu sagen:

```csharp
// .NET 10 SDK 10.0.302, C# 14
static ref int PickSecond(scoped ref int a, ref int b) => ref b;

static ref int Fine(ref int b)
{
    int v = 5;
    ref int r = ref PickSecond(ref v, ref b); // only b contributes: return-only
    return ref r;                             // OK
}
```

Ein `scoped ref`-Parameter kann vom Aufgerufenen weder zurückgegeben noch erfasst werden und trägt daher nicht mehr zum Context des Ergebnisses bei. Der Bedingungsoperator hat keinen solchen Ausweg:

```csharp
// .NET 10 SDK 10.0.302, C# 14
ref int Either(bool f)
{
    int v = 1;
    ref int r = ref f ? ref _arr[0] : ref v; // narrowest wins: declaration-block
    return ref r;                            // error CS8157
}
```

## Eine ref-Neuzuweisung kann den Context weder erweitern noch einengen

Seit C# 7.3 kann ein `ref`-Local mit `r = ref other;` auf etwas anderes gerichtet werden. Die Regel aus [Abschnitt 9.7.2.9](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/variables#9729-limitations-on-reference-variables) lautet: "For a ref reassignment `e1 = ref e2`, the ref-safe-context of `e2` shall be at least as wide a context as the ref-safe-context of `e1`." Der Context des Locals ändert sich dadurch nicht. Das hat Folgen in beide Richtungen.

**Einengen ist ein Fehler.** Initialisieren Sie aus einem Array-Element und versuchen Sie dann, auf ein Local zu zeigen:

```csharp
// .NET 10 SDK 10.0.302, C# 14
ref int Narrowing()
{
    ref int r = ref _arr[0]; // caller-context
    int v = 1;
    r = ref v;               // error CS8374
    return ref r;
}
```

```text
error CS8374: Cannot ref-assign 'v' to 'r' because 'v' has a narrower escape scope than 'r'.
```

Dasselbe passiert zwischen verschachtelten Blöcken, und das ist die Variante, auf die man in echten Schleifen stößt:

```csharp
// .NET 10 SDK 10.0.302, C# 14
static void NestedBlock()
{
    int outer = 1;
    ref int r = ref outer;   // declaration-block of the method body
    {
        int inner = 2;
        r = ref inner;       // error CS8374: inner's block is narrower
    }
}
```

**Erweitern ist erlaubt, hilft aber nicht.** Initialisieren Sie aus einem Local und zeigen Sie dann auf ein Array-Element. Die Neuzuweisung kompiliert. Die Rückgabe nicht:

```csharp
// .NET 10 SDK 10.0.302, C# 14
ref int Widening()
{
    int v = 1;
    ref int r = ref v;   // declaration-block, fixed forever
    r = ref _arr[0];     // OK: caller-context is wider
    return ref r;        // error CS8157: r was *initialized* to a local
}
```

Das ist absichtlich flussunabhängig. Der Compiler verfolgt nicht, dass `r` gerade zufällig auf den Heap zeigt. Er kennt nur den deklarierten Context, und der ist declaration-block.

**Die return-only-Falle.** Ein `ref`-Parameter ist return-only, was enger ist als caller-context. Das scheitert daher, mit einem anderen Fehlercode:

```csharp
// .NET 10 SDK 10.0.302, C# 14
ref int FieldThenParam(ref int p)
{
    ref int r = ref _arr[0]; // caller-context
    r = ref p;               // error CS9079
    return ref r;
}
```

```text
error CS9079: Cannot ref-assign 'p' to 'r' because 'p' can only escape the current method through a return statement.
```

Sowohl `_arr[0]` als auch `p` sind einzeln zurückgebbar, und doch wird die Kombination abgelehnt. Die Lösung ist in all diesen Fällen dieselbe: Initialisieren Sie das `ref`-Local mit dem **engsten** Referenten, den es je halten wird, und weisen Sie danach weiteren zu.

```csharp
// .NET 10 SDK 10.0.302, C# 14
ref int ParamThenField(ref int p, bool useField)
{
    ref int r = ref p;               // return-only
    if (useField) r = ref _arr[0];   // caller-context is wider: OK
    return ref r;                    // OK: return-only is returnable
}
```

## `scoped ref`-Locals: bewusst einen engeren Context wählen

Sie können ein `ref`-Local auch gezielt einengen. Deklarieren Sie es als `scoped ref`, erhält es unabhängig vom Initialisierer den Context function-member:

```csharp
// .NET 10 SDK 10.0.302, C# 14
ref int ScopedLocal()
{
    scoped ref int r = ref _arr[0]; // function-member, despite caller-context initializer
    return ref r;                   // error CS8157
}
```

Für sich genommen wirkt das sinnlos. Es lohnt sich, wenn das Local später auf etwas Engeres umgebogen wird. Vergleichen Sie die beiden Methoden unten, die sich nur im Schlüsselwort `scoped` unterscheiden:

```csharp
// .NET 10 SDK 10.0.302, C# 14
void Unscoped()
{
    ref int r = ref _arr[0]; // caller-context
    int v = 1;
    r = ref v;               // error CS8374
    r = 5;
}

void Scoped()
{
    scoped ref int r = ref _arr[0]; // function-member
    int v = 1;
    r = ref v;                      // OK: v's block is the method body
    r = 5;
}
```

Verstehen Sie `scoped` als den dokumentierten Weg zu sagen: "Dieser Verweis verlässt die Methode nie", was Neuzuweisungen freischaltet, die der abgeleitete Context verbieten würde. Dasselbe Schlüsselwort an einem `ref struct`-Local (`scoped Span<int> s`) engt stattdessen dessen safe-context ein, wodurch sein Inhalt nicht entweichen kann.

## Structs, `this` und `[UnscopedRef]`

In einer Struct-Instanzmethode ist `this` ein impliziter `scoped ref`-Parameter, sein Context ist also function-member, und das gilt auch für alle seine Felder (Regel 4). Deshalb kann ein Struct sein eigenes Feld nicht per ref zurückgeben:

```csharp
// .NET 10 SDK 10.0.302, C# 14
using System.Diagnostics.CodeAnalysis;

struct Counter
{
    int _n;

    public ref int Bad() => ref _n;                 // error CS8170
    [UnscopedRef] public ref int Good() => ref _n;  // OK: this widened to return-only

    static ref int UseGood()
    {
        Counter c = default;
        ref int r = ref c.Good(); // receiver c is a local: declaration-block
        return ref r;             // error CS8157
    }
}
```

```text
error CS8170: Struct members cannot return 'this' or other instance members by reference
```

`[UnscopedRef]` erweitert `this` um eine Stufe, von function-member auf return-only, was für `return ref _n` genügt. Das Ergebnis wird dadurch aber nicht heap-sicher. An der Aufrufstelle ist `c.Good()` ein `ref`-zurückgebender Aufruf, dessen Empfänger per `ref` übergeben wird; Regel 6 greift also, und das Ergebnis erbt den declaration-block-Context des Locals `c`. Der zurückgegebene Verweis lebt nur so lange wie das Struct, in das er zeigt, und genau das ist korrekt.

## Spans: wo ref-safe-context auf safe-context trifft

`Span<T>` hat einen `ref`-zurückgebenden Indexer, daher folgt `ref span[i]` ebenfalls Regel 6. Der Empfänger steuert seine **safe-context** bei, und die safe-context eines Spans hängt davon ab, woher sein Speicher stammt:

```csharp
// .NET 10 SDK 10.0.302, C# 14
static ref int FromStackSpan()
{
    Span<int> local = stackalloc int[4]; // safe-context: function-member
    ref int r = ref local[0];
    return ref r;                        // error CS8157
}

static ref int FromHeapSpan()
{
    Span<int> local = new int[4];        // safe-context: caller-context
    ref int r = ref local[0];
    return ref r;                        // OK
}
```

Die beiden Methoden sind bis auf den Initialisierer von `local` identisch, und nur eine kompiliert. Ein Span-Parameter hat die safe-context caller-context, wodurch das klassische Muster "Element per Referenz finden" ohne Annotationen erlaubt ist:

```csharp
// .NET 10 SDK 10.0.302, C# 14
static ref int MaxRef(Span<int> values)
{
    ref int best = ref values[0];        // caller-context via the span parameter
    for (int i = 1; i < values.Length; i++)
        if (values[i] > best) best = ref values[i]; // same context: OK
    return ref best;
}

int[] data = { 3, 9, 4 };
MaxRef(data) = 0;
Console.WriteLine(string.Join(",", data)); // 3,0,4
```

Jede Neuzuweisung in der Schleife stammt aus demselben Span, der Context gerät also nie in Konflikt. Das ist die Form, die Sie anstreben sollten: eine Quelle, ein Context, beliebig neu zuweisen.

## So lesen Sie die Fehlercodes

Wenn Sie auf einen dieser Fehler stoßen, verrät der Code, welche Seite der Regel verletzt wurde:

1. **CS8168** ("not a ref local"): Sie haben `return ref` auf ein einfaches Local oder einen Wertparameter angewendet. Geben Sie den Wert zurück oder verlagern Sie den Speicher auf den Heap.
2. **CS8157** ("was initialized to a value that cannot be returned"): Der Initialisierer des `ref`-Locals hatte einen engeren Context als return-only. Schauen Sie auf den Initialisierer, nicht auf die letzte Neuzuweisung. Prüfen Sie Helferaufrufe auf lokale `ref`-Argumente und markieren Sie nicht entweichende Parameter als `scoped`.
3. **CS8374** ("narrower escape scope"): Eine Neuzuweisung wollte das Local einengen. Initialisieren Sie zuerst mit dem engsten Referenten oder deklarieren Sie das Local im selben Block wie den Referenten.
4. **CS9079** ("can only escape the current method through a return statement"): der Sonderfall von CS8374, bei dem der neue Referent ein `ref`- oder `in`-Parameter (return-only) ist und das Local caller-context hatte. Initialisieren Sie stattdessen aus dem Parameter.
5. **CS8170**: Ein Struct gibt einen Verweis auf sein eigenes Feld zurück. Fügen Sie `[UnscopedRef]` hinzu, wenn Aufrufer damit leben können, dass das Ergebnis an die Lebensdauer des Structs gebunden ist.

## Stolperfallen, die man kennen sollte

- `ref`-Locals können nicht von Lambdas oder lokalen Funktionen erfasst werden und dürfen nicht über ein `await` oder `yield return` hinweg leben. Das ist eine separate Einschränkung in Abschnitt 9.7.2.9, kein Context-Fehler, taucht aber oft im selben Refactoring auf.
- `out`-Parameter sind nach den Ref-Safety-Regeln von C# 11 implizit `scoped ref`, daher scheitert `return ref outParam;` mit `error CS9075: Cannot return a parameter by reference 'o' because it is scoped to the current method`, obwohl `return ref refParam;` funktioniert. Das Absenken von `<LangVersion>` bringt das alte Verhalten nicht zurück: Mit `<LangVersion>10</LangVersion>` in einem `net10.0`-Projekt erhielt ich dasselbe CS9075, weil der Compiler die neuen Regeln immer anwendet, wenn die Ziellaufzeit `ref`-Felder unterstützt. Markieren Sie den Parameter als `[UnscopedRef] out int o`, wenn Sie es wirklich brauchen.
- `in`-Parameter sind wie `ref`-Parameter return-only, aber nur als `ref readonly`. Der [Beitrag zu `ref readonly`-Parametern](/de/2023/10/csharp-ref-readonly-parameters/) behandelt, wann man welchen wählt.
- Der Compiler ist konservativ. Regel 6 geht davon aus, dass eine `ref`-zurückgebende Methode jedes ihrer `ref`-Argumente zurückgeben kann. Tut Ihre Methode das nicht, ist `scoped` kein Workaround, sondern der korrekte, dokumentierte Vertrag.
- Unsicherer Code verabschiedet sich aus der Prüfung. In `unsafe`-Blöcken können Sie Zeiger auf Locals nehmen, und der Compiler verfolgt deren Lebensdauer nicht. Beim [C# 16-Redesign von `unsafe` als Vertrag des Aufrufers](/de/2026/05/csharp-16-unsafe-keyword-caller-contract/) geht es darum, diese Grenze explizit zu machen.

## Verwandte Beiträge

- Wenn Spans selbst neu für Sie sind, beginnen Sie mit [was `Span<T>` ist und wann es Code tatsächlich schneller macht](/de/2026/06/what-is-span-and-when-does-it-make-my-code-faster/).
- Zur Wahl einer Collection-Form, bevor Sie sich um Lebensdauern sorgen, siehe [List vs Span vs ReadOnlySpan in C#](/de/2026/05/list-vs-span-vs-readonlyspan-in-csharp/).
- C# 14 hat auch geändert, wie Spans gebunden werden; [die Breaking Change bei der Überladungsauflösung mit Spans](/de/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/) erklärt die Überraschungen bei `MemoryExtensions`.
- [Implizite Span-Konvertierungen in C# 14](/de/2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan/) behandelt die neueren Konvertierungen auf Sprachebene, durch die Arrays an mehr Stellen in Span-Parameter wie `MaxRef` oben fließen, einschließlich Empfängern von Erweiterungsmethoden.

## Quellen

- [C# standard, section 9.7.2 Ref safe contexts](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/variables#972-ref-safe-contexts), einschließlich 9.7.2.2 (Locals), 9.7.2.6 (Funktionsaufruf) und 9.7.2.9 (ref-Neuzuweisung).
- [C# standard, section 9.7.3 The scoped modifier](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/variables#973-the-scoped-modifier).
- [Low-level struct improvements](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-11.0/low-level-struct-improvements), der C# 11-Vorschlag, der return-only, `scoped` und `[UnscopedRef]` eingeführt hat.
- [Reference variables](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/statements/declarations#reference-variables) und [`ref` structure types](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/ref-struct) in der C#-Sprachreferenz.
