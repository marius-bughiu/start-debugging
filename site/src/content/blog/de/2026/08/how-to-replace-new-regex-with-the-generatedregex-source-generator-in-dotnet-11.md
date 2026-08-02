---
title: "new Regex(...) durch den [GeneratedRegex] Source Generator in .NET 11 ersetzen"
description: "Ein vollständiger Leitfaden zur Umstellung von new Regex(pattern, RegexOptions.Compiled) auf [GeneratedRegex] in .NET 11: die mechanische Umschreibung, partielle Methoden gegenüber partiellen Eigenschaften, gemessene Startzeit- und Durchsatzwerte, die Diagnosen SYSLIB1040-1045 und die zwei Muster, bei denen der Generator stillschweigend auf eine zwischengespeicherte Regex zurückfällt."
pubDate: 2026-08-02
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "regex"
  - "source-generators"
  - "performance"
  - "native-aot"
lang: "de"
translationOf: "2026/08/how-to-replace-new-regex-with-the-generatedregex-source-generator-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-08-02
---

Wenn Ihr Muster eine Konstante zur Compile-Zeit ist, löschen Sie `new Regex(pattern, RegexOptions.Compiled)` und setzen Sie `[GeneratedRegex(pattern)]` auf eine partielle Methode oder eine partielle Eigenschaft, die `Regex` zurückgibt. Der Source Generator gibt zur Build-Zeit einen von `Regex` abgeleiteten Typ aus, also zahlen Sie zur Laufzeit keinerlei Kosten für Parsing, Analyse und Reflection-Emit, der Code ist trimmbar und Native-AOT-tauglich, und Sie können im Debugger in die Matching-Logik hineinspringen. In meinen Messungen auf .NET 10.0.201 war die generierte Matching-Logik im eingeschwungenen Zustand geringfügig schneller als `RegexOptions.Compiled` (35 ns gegenüber 37 ns pro `IsMatch`) und erreichte ihren ersten Treffer in etwa der Hälfte der Zeit (5,8 ms gegenüber 12,2 ms in einem kalten Prozess).

Alles Folgende zielt auf .NET 11 (Preview 6 zum Zeitpunkt des Schreibens, SDK `11.0.100-preview.6`) mit C# 14 ab, aber das Attribut und der Generator sind seit .NET 7 stabil, und die Zahlen in diesem Artikel wurden auf dem SDK .NET 10.0.201 gemessen, weil das die neueste Version ist, für die ich eine vollständige Laufzeit habe. An der API-Oberfläche hat sich zwischen beiden nichts geändert.

## Die Umstellung von Anfang bis Ende

1. Prüfen Sie, ob das Muster eine Konstante zur Compile-Zeit ist. Wird es aus Benutzereingaben oder Konfiguration zusammengesetzt, hört es hier auf: der Generator kann Ihnen nicht helfen.
2. Markieren Sie den enthaltenden Typ als `partial`, ebenso jeden Typ, in den er verschachtelt ist.
3. Ersetzen Sie das Feld `static readonly Regex` durch eine Methode `static partial Regex` (oder ab .NET 9 durch eine schreibgeschützte Eigenschaft `static partial Regex`).
4. Verschieben Sie Muster, Optionen und ein etwaiges Zeitlimit in ein `[GeneratedRegex]` Attribut auf diesem Member.
5. Entfernen Sie `RegexOptions.Compiled` aus den Optionen. Der Generator ignoriert dieses Flag.
6. Schreiben Sie die Aufrufstellen von `s_myRegex.IsMatch(text)` auf `MyRegex().IsMatch(text)` um.
7. Öffnen Sie die generierte Datei und prüfen Sie den XML-Kommentar der ausgegebenen Klasse. Steht dort "Caches a `Regex` instance", hat der Generator aufgegeben und Sie haben nichts gewonnen.

Schritt 7 überspringen alle, und er entscheidet darüber, ob sich die ganze Übung gelohnt hat.

## Warum der Interpreter und RegexOptions.Compiled Sie beide etwas kosten

Wenn Sie `new Regex("somepattern")` schreiben, wird das Muster zu einem Baum geparst, der Baum wird optimiert, und das Ergebnis wird als Opcodes für den Regex-Interpreter ausgegeben. Jeder Treffer läuft dann durch diese Opcodes. Das funktioniert überall und ist billig in der Konstruktion, aber jeder Opcode-Dispatch ist eine Verzweigung, die die CPU vorhersagen muss.

`RegexOptions.Compiled` zahlt eine deutlich höhere Konstruktionsrechnung, um diesen Dispatch zu beseitigen. Es erledigt alles, was der Interpreter erledigt, und schickt den resultierenden Knotenbaum dann durch einen auf `System.Reflection.Emit` basierenden Compiler, der IL in eine Handvoll `DynamicMethod` Objekte schreibt. Dieses IL muss bei der ersten Verwendung immer noch vom JIT kompiliert werden. Wie [die Microsoft-Dokumentation es formuliert](https://learn.microsoft.com/en-us/dotnet/standard/base-types/regular-expression-source-generators), stellt `RegexOptions.Compiled` "einen grundlegenden Kompromiss zwischen dem Overhead bei der ersten Verwendung und dem Overhead bei jeder weiteren Verwendung" dar. Schlimmer noch, es hängt von Codegenerierung zur Laufzeit ab. Auf Plattformen, die dynamisch generierten Code verbieten, und unter Native AOT wird `Compiled` daher stillschweigend zu einer Nulloperation, und Sie landen ohne jede Warnung wieder beim Interpreter.

Der Source Generator beseitigt den Kompromiss, statt sich innerhalb davon zu bewegen. Dieselbe Analyse- und Optimierungsarbeit findet statt, aber sie findet auf der Build-Maschine statt, und was in Ihrer Assembly landet, ist gewöhnliches C#, das der Compiler in gewöhnliches IL übersetzt.

## Die Umschreibung

So sieht es in fast jeder Codebasis aus:

```csharp
// .NET 11, C# 14 - the pattern you are replacing
private static readonly Regex s_email = new(
    @"^(?<user>[A-Za-z0-9._%+-]+)@(?<host>[A-Za-z0-9.-]+)\.(?<tld>[A-Za-z]{2,})$",
    RegexOptions.Compiled);

public static bool IsEmail(string s) => s_email.IsMatch(s);
```

Und das quellcodegenerierte Äquivalent:

```csharp
// .NET 11, C# 14
internal static partial class EmailRules
{
    [GeneratedRegex(@"^(?<user>[A-Za-z0-9._%+-]+)@(?<host>[A-Za-z0-9.-]+)\.(?<tld>[A-Za-z]{2,})$")]
    private static partial Regex Email();

    public static bool IsEmail(string s) => Email().IsMatch(s);
}
```

Drei Dinge fallen auf. Die Klasse ist `partial` geworden. `RegexOptions.Compiled` ist verschwunden, weil der Generator das Flag ignoriert und seine Anwesenheit nur den nächsten Leser in die Irre führt. Und die Methode hat keinen Rumpf: Sie deklarieren sie, der Generator implementiert sie.

Sie müssen nichts selbst zwischenspeichern. Die generierte Implementierung gibt ein `static readonly` Singleton zurück, was Sie im ausgegebenen Quellcode selbst nachsehen können.

### Partielle Eigenschaften, falls sich ein Methodenaufruf falsch liest

Seit .NET 9 und C# 13 gilt `[GeneratedRegex]` auch für schreibgeschützte partielle Eigenschaften, was sich besser liest, wenn die Regex konzeptionell ein Wert und keine Operation ist:

```csharp
// .NET 11, C# 14 - requires C# 13 or later for partial properties
internal static partial class PhoneRules
{
    [GeneratedRegex(@"^\d{3}-\d{4}$")]
    internal static partial Regex Phone { get; }
}
```

Die Eigenschaft muss schreibgeschützt sein. Geben Sie ihr einen Setter, lehnt der Generator sie ab. Zwischen beiden Formen gibt es keinen Verhaltensunterschied; wählen Sie eine und bleiben Sie konsistent.

### Optionen, Kultur und Zeitlimits

Das Attribut hat fünf Konstruktorüberladungen, die Optionen, einen Kulturnamen und ein Match-Zeitlimit in Millisekunden ergänzen:

```csharp
// .NET 11, C# 14
[GeneratedRegex(
    pattern: "abc|def",
    options: RegexOptions.IgnoreCase | RegexOptions.Multiline,
    cultureName: "en-US",
    matchTimeoutMilliseconds: 1000)]
private static partial Regex AbcOrDef();
```

`cultureName` spielt nur beim Matching ohne Beachtung der Groß- und Kleinschreibung eine Rolle. Wenn Sie `RegexOptions.CultureInvariant` übergeben, dürfen Sie nicht zusätzlich einen Kulturnamen übergeben, und der Fehlermodus ist dort wirklich verwirrend. Siehe die Fallstricke weiter unten.

## Wie die Zahlen tatsächlich aussehen

Ich habe das gemessen, statt die Folklore zu wiederholen. Der Aufbau: eine Konsolenanwendung auf .NET 10.0.201, Windows 11 x64, Release-Build, die das verankerte E-Mail-Muster von oben gegen 1.000 Zeichenketten prüft, von denen ein Drittel nicht passt. Drei Engines: der Interpreter, `RegexOptions.Compiled` und `[GeneratedRegex]`.

Durchsatz im eingeschwungenen Zustand, 200.000 `IsMatch` Aufrufe pro Runde, beste von zehn Runden nach drei vollständigen Aufwärmrunden jeder Engine:

| Engine | Zeit | Pro Aufruf |
| --- | --- | --- |
| Interpreter | 22,1 ms | 111 ns |
| `RegexOptions.Compiled` | 7,4 ms | 37 ns |
| `[GeneratedRegex]` | 7,0 ms | 35 ns |

Erster Treffer im kalten Prozess, jede Engine in einem eigenen Prozess gemessen, damit nichts vorgewärmt ist, vier Durchläufe:

| Engine | Konstruktion plus erster `IsMatch` |
| --- | --- |
| Interpreter | 3,7 bis 4,0 ms |
| `RegexOptions.Compiled` | 12,0 bis 12,7 ms |
| `[GeneratedRegex]` | 5,7 bis 6,1 ms |

Lesen Sie beide Tabellen zusammen. Gegenüber `Compiled` ist der Generator ein kleiner Durchsatzgewinn und ein großer Startzeitgewinn: derselbe eingeschwungene Zustand, weniger als die halbe Zeit bis dorthin. Gegenüber dem Interpreter ist es ein Durchsatzgewinn um Faktor 3,2, der etwa 2 ms zusätzliche Startzeit in einem kalten Prozess kostet, größtenteils JIT-Zeit für die ausgegebene Matching-Logik, und der unter Native AOT vollständig verschwindet, weil kein JIT mehr zu bezahlen ist.

Eine Warnung, falls Sie das selbst messen: mein erster Versuch ließ den Interpreter doppelt so schnell aussehen wie `Compiled`, was Unsinn ist. Die Ursache war, dass alle drei Engines eine gemeinsame Messmethode nutzten, sodass die zuerst laufende Engine die gestufte JIT-Kompilierung des Messgerüsts selbst absorbierte. Wärmen Sie jede Engine durch das Gerüst auf, bevor Sie eine davon messen.

## Der Analyzer weiß es bereits

Sie müssen diese Aufrufstellen nicht von Hand suchen. Das .NET SDK liefert `SYSLIB1045` mit, einen Analyzer auf Info-Ebene, der jede zur Quellcodegenerierung konvertierbare `Regex` Verwendung markiert, zusammen mit einer Codekorrektur, die die Umstellung für Sie durchführt. Info-Schweregrad bedeutet, dass er als Glühbirne in der IDE auftaucht und sonst nirgends, also stufen Sie ihn hoch:

```ini
# .editorconfig
[*.cs]
dotnet_diagnostic.SYSLIB1045.severity = warning
```

Jetzt listet `dotnet build` jede verbleibende Aufrufstelle auf, und `dotnet format analyzers` kann die Korrektur in großem Umfang anwenden. Setzen Sie den Schweregrad auf `error`, sobald die Codebasis sauber ist, damit niemand eine neue Stelle hinzufügt.

## Wenn der Generator stillschweigend aufgibt

Das ist der Teil, der weh tut, denn es ist weder ein Fehler noch eine Warnung. Zwei Konstrukte bringen den Generator dazu, die Ausgabe einer eigenen Matching-Logik zu verweigern, und in beiden Fällen fällt er darauf zurück, eine zwischengespeicherte einfache `Regex` Instanz auszugeben. Ihr Code kompiliert, Ihre Tests laufen durch, und Sie haben nichts von dem Nutzen bekommen.

Das erste ist `RegexOptions.NonBacktracking`, das weder der Source Generator noch `RegexCompiler` unterstützt. Das zweite sind Rückwärtsverweise ohne Beachtung der Groß- und Kleinschreibung: das Matching von `IgnoreCase` Rückwärtsverweisen benötigt eine interne Groß-Klein-Tabelle, die innerhalb von `System.Text.RegularExpressions.dll` liegt und für generierten Code nicht zugänglich ist. Das ist das einzige Konstrukt, das `RegexCompiler` beherrscht und der Source Generator nicht.

Sie können beides direkt sehen. Fügen Sie dies Ihrer Projektdatei hinzu:

```xml
<PropertyGroup>
  <EmitCompilerGeneratedFiles>true</EmitCompilerGeneratedFiles>
  <CompilerGeneratedFilesOutputPath>generated</CompilerGeneratedFilesOutputPath>
</PropertyGroup>
```

Kompilieren Sie dann diese drei Member und lesen Sie `generated/System.Text.RegularExpressions.Generator/.../RegexGenerator.g.cs`:

```csharp
// .NET 11, C# 14
internal static partial class NonBt
{
    [GeneratedRegex(@"\d+", RegexOptions.NonBacktracking)]
    internal static partial Regex Digits();
}

internal static partial class IgnoreCaseBackref
{
    [GeneratedRegex(@"(\w)\1", RegexOptions.IgnoreCase)]
    internal static partial Regex Doubled();
}

internal static partial class Fine
{
    [GeneratedRegex(@"^\d{3}-\d{4}$")]
    internal static partial Regex Phone { get; }
}
```

Die ausgegebene Datei ist eindeutig darin, welcher der drei Fälle funktioniert hat:

```csharp
/// <summary>Caches a <see cref="Regex"/> instance for the Digits method.</summary>
/// <remarks>A custom Regex-derived type could not be generated because RegexOptions.NonBacktracking isn't supported.</remarks>
file sealed class Digits_0 : Regex
{
    internal static readonly Regex Instance = new("\\d+", RegexOptions.NonBacktracking);
}

/// <summary>Caches a <see cref="Regex"/> instance for the Doubled method.</summary>
/// <remarks>A custom Regex-derived type could not be generated because the expression contains case-insensitive backreferences which are not supported by the source generator.</remarks>
file sealed class Doubled_1 : Regex
{
    internal static readonly Regex Instance = new("(\\w)\\1", RegexOptions.IgnoreCase);
}

/// <summary>Custom <see cref="Regex"/>-derived type for the Phone method.</summary>
file sealed class Phone_2 : Regex
{
    internal static readonly Phone_2 Instance = new();
    // ... RunnerFactory, Runner, TryMatchAtCurrentPosition, and so on
}
```

"Caches a `Regex` instance" ist der Rückfall. "Custom `Regex`-derived type" ist die echte Sache. Der Generator meldet für die Rückfälle zusätzlich `SYSLIB1044`, dessen Schweregrad aber **Info** ist, sodass es weder in einem normalen Build-Log auftaucht noch die CI zum Scheitern bringt. Wenn es Ihnen wichtig ist, heben Sie es in der `.editorconfig` an:

```ini
dotnet_diagnostic.SYSLIB1044.severity = warning
```

Der Rückfall ist nicht wertlos. Sie bekommen weiterhin das Zwischenspeichern und die beschreibenden XML-Kommentare. Aber wenn Sie einen heißen Pfad umgestellt haben und einen Geschwindigkeitsgewinn erwarteten, müssen Sie wissen, dass Sie keinen bekommen haben.

## Die Diagnosen mit ihren echten Meldungen

Dies sind die exakten Zeichenketten, die das .NET 10 SDK ausgibt, keine Umschreibungen:

| ID | Schweregrad | Meldung |
| --- | --- | --- |
| `SYSLIB1040` | Error | Invalid `GeneratedRegexAttribute` usage. |
| `SYSLIB1041` | Error | Multiple `GeneratedRegexAttribute` attributes were applied to the same method, but only one is allowed. |
| `SYSLIB1042` | Error | The specified regex is invalid. |
| `SYSLIB1043` | Error | `GeneratedRegexAttribute` method or property must be partial, parameterless, non-generic, non-abstract, and return `Regex`. If a property, it must also be get-only. |
| `SYSLIB1044` | Info | The regex generator couldn't generate a complete source implementation for the specified regular expression due to an internal limitation. |
| `SYSLIB1045` | Info | Use `GeneratedRegexAttribute` to generate the regular expression implementation at compile time. |

## Fallstricke, die echte Zeit kosten

**Ein nicht partieller enthaltender Typ liefert Ihnen keinen SYSLIB-Fehler.** Der Generator gibt seine Hälfte des partiellen Typs trotzdem aus, und der C#-Compiler ist derjenige, der sich beschwert, mit `CS0260: Missing partial modifier on declaration of type 'NotPartial'; another partial declaration of this type exists`. Wenn Sie drei Typen tief verschachtelt sind, brauchen alle drei `partial`.

**`CultureInvariant` plus ein expliziter Kulturname erzeugt eine irreführende Meldung.** Diese Kombination:

```csharp
[GeneratedRegex(@"abc", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, "en-US")]
internal static partial Regex Abc();
```

scheitert mit `error SYSLIB1042: The specified regex is invalid. 'cultureName'`. Das Muster `abc` ist offensichtlich in Ordnung. Das Problem ist, dass `CultureInvariant` und eine benannte Kultur sich gegenseitig ausschließen, und die Diagnose verwendet die Meldung für ein ungültiges Muster wieder, mit dem Namen des störenden Arguments als Nutzlast. Lassen Sie den Kulturnamen weg oder lassen Sie `CultureInvariant` weg.

**Eine festgesetzte `LangVersion` bricht den Build in der generierten Datei, nicht in Ihrer.** Der Generator gibt Typen mit `file` Gültigkeitsbereich aus, ein C# 11 Feature. Erzwingen Sie `LangVersion` 10, erhalten Sie `CS8936: Feature 'file types' is not available in C# 10.0. Please use language version 11.0 or greater`, mit Verweis auf `RegexGenerator.g.cs`. Partielle Eigenschaften heben die Untergrenze auf C# 13: `CS8703: The modifier 'partial' is not valid for this item in C# 10.0. Please use language version '13.0' or greater`. Moderne SDKs setzen `LangVersion` standardmäßig passend zum Target Framework, das trifft also nur Codebasen, die den Wert explizit festsetzen.

**Das Matching ohne Beachtung der Groß- und Kleinschreibung ist zur Build-Zeit eingefroren.** Für eine Regex ohne Beachtung der Groß- und Kleinschreibung erweitern die Engines das Muster anhand einer internen Unicode-Groß-Klein-Tabelle, sodass `abc` zum Äquivalent von `[Aa][Bb][Cc]` wird. Die anderen Engines nehmen diese Erweiterung zur Laufzeit vor und nutzen dabei die Tabelle der Laufzeit, auf der Sie sich befinden. Der Source Generator nimmt sie zur Compile-Zeit vor und nutzt die Tabelle des Target Frameworks, gegen das Sie kompiliert haben. Ändert eine künftige Unicode-Revision eine Äquivalenz, behält eine quellcodegenerierte Regex das alte Verhalten, bis Sie neu bauen. Das ist in den [Anmerkungen zu `GeneratedRegexAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.text.regularexpressions.generatedregexattribute) dokumentiert und fast nie ein Problem, aber "fast nie" ist nicht "nie".

**Zeitlimitprüfungen werden global ein- oder auskompiliert.** Der generierte Code liest den Umgebungsstandard genau einmal:

```csharp
internal static readonly TimeSpan s_defaultTimeout =
    AppContext.GetData("REGEX_DEFAULT_MATCH_TIMEOUT") is TimeSpan timeout
        ? timeout
        : Regex.InfiniteMatchTimeout;

internal static readonly bool s_hasTimeout = s_defaultTimeout != Regex.InfiniteMatchTimeout;
```

und schützt jeden `base.CheckTimeout()` Aufruf in Backtracking-Schleifen hinter `s_hasTimeout`. Das ist gut für den Durchsatz auf dem Standardpfad, und es bedeutet, dass ein Muster mit katastrophalem Backtracking gegen feindliche Eingaben bis zum Wärmetod Ihrer Request-Pipeline läuft, wenn Sie `REGEX_DEFAULT_MATCH_TIMEOUT` nie setzen und `matchTimeoutMilliseconds` nie übergeben. Berührt ein Muster nicht vertrauenswürdige Eingaben, setzen Sie `matchTimeoutMilliseconds` im Attribut, oder stellen Sie genau dieses Muster auf `RegexOptions.NonBacktracking` um und nehmen Sie den Rückfall in Kauf.

**Die Codegröße wächst.** Der Generator gibt pro Muster echtes C# aus, und ein großes Muster erzeugt viel davon. Wenn Sie Hunderte von Regexes haben und nur eine Handvoll heiß ist, tauschen Sie mit einer Komplettumstellung Binärgröße gegen Durchsatz ein, den Sie nicht beobachten werden. Der Interpreter ist die richtige Antwort für ein Muster, das beim Start zweimal läuft.

## Wo das am meisten zählt: Trimming und Native AOT

Das stärkste Argument für den Generator sind nicht die 2 ns pro Aufruf. Es ist, dass `RegexOptions.Compiled` von `System.Reflection.Emit` abhängt, also genau der Art von Abhängigkeit, die [trim-sicherer Code](/de/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) vermeidet und die [Native AOT](/de/2026/06/what-is-native-aot-and-what-does-it-cost-you/) vollständig entfernt. Unter AOT ist `Compiled` eine stille Nulloperation, und Ihr sorgfältig optimierter heißer Pfad läuft auf dem Interpreter.

Die Quellcodegenerierung dreht das um. Weil die Matching-Logik gewöhnliches C# ist, das der Linker sieht, kann der Trimmer `RegexCompiler` und möglicherweise Reflection-Emit selbst aus der veröffentlichten Ausgabe entfernen, und die generierte Matching-Logik wird zusammen mit allem anderen vorab kompiliert. Wenn Sie mit AOT veröffentlichen, ist die Umstellung jedes konstanten Musters keine Optimierung, sondern die Korrektur einer Annahme, die Ihr Code stillschweigend trifft.

## Verwandt

- [Was ist ein Source Generator und wann brauche ich einen?](/de/2026/06/what-is-a-source-generator-and-when-do-i-need-one/)
- [RegexOptions.AnyNewLine landet in .NET 11 Preview 3](/de/2026/04/regex-anynewline-dotnet-11-preview-3/)
- [SearchValues in .NET 11 richtig verwenden](/de/2026/04/how-to-use-searchvalues-correctly-in-dotnet-11/)
- [Was ist Native AOT und was kostet es Sie?](/de/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [Was ist trim-sicherer Code und wie schreibe ich ihn?](/de/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/)

## Quellen

- [.NET regular expression source generators](https://learn.microsoft.com/en-us/dotnet/standard/base-types/regular-expression-source-generators) auf Microsoft Learn
- [API-Referenz zu `GeneratedRegexAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.text.regularexpressions.generatedregexattribute), einschließlich der Anmerkungen zur Groß-Klein-Tabelle zur Compile-Zeit
- [SYSLIB-Diagnosen für die Quellcodegenerierung regulärer Ausdrücke](https://learn.microsoft.com/en-us/dotnet/fundamentals/syslib-diagnostics/syslib1040-1049)
- [Regular Expression Improvements in .NET 7](https://devblogs.microsoft.com/dotnet/regular-expression-improvements-in-dotnet-7/) im .NET Blog
- [`DiagnosticDescriptors.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Text.RegularExpressions/gen/DiagnosticDescriptors.cs) in dotnet/runtime, für den Schweregrad jeder Diagnose

Die Messwerte und der Diagnosetext in diesem Artikel entstanden lokal auf dem SDK .NET 10.0.201, Windows 11 x64, Konfiguration Release.
