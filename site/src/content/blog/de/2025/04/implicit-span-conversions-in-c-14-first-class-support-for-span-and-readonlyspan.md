---
title: "Implizite Span-Konvertierungen in C# 14: Erstklassige Unterstützung für Span und ReadOnlySpan"
description: "C# 14 fügt eingebaute implizite Konvertierungen zwischen Span, ReadOnlySpan, Arrays und Strings hinzu. Das ermöglicht sauberere APIs, bessere Typinferenz und weniger manuelle AsSpan()-Aufrufe."
pubDate: 2025-04-06
tags:
  - "csharp-14"
  - "csharp"
  - "dotnet"
  - "dotnet-10"
lang: "de"
translationOf: "2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan"
translatedBy: "claude"
translationDate: 2026-05-01
---
**C# 14** bringt eine bedeutende Verbesserung für leistungskritischen Code: erstklassige Sprachunterstützung für Spans. Insbesondere werden neue **implizite Konvertierungen** zwischen **`Span<T>`**, **`ReadOnlySpan<T>`** und Arrays (`T[]`) eingeführt. Diese Änderung erleichtert die Arbeit mit diesen Typen, die sichere, zusammenhängende Speicherausschnitte ohne zusätzliche Allokationen darstellen. In diesem Artikel werfen wir einen Blick darauf, was Span-Konvertierungen sind, wie C# 14 die Regeln geändert hat und warum das für Ihren Code wichtig ist.

## Hintergrund: Was sind `Span<T>` und `ReadOnlySpan<T>`?

`Span<T>` und `ReadOnlySpan<T>` sind reine Stack-Strukturen (per Referenz), mit denen Sie sicher auf einen zusammenhängenden Speicherbereich verweisen können (zum Beispiel ein Segment eines Arrays, eines Strings oder unverwalteten Speichers). Sie wurden in C# 7.2 eingeführt und werden in .NET breit für Szenarien mit **hoher Performance und null Allokationen** eingesetzt. Da sie als **`ref struct`**-Typen implementiert sind, können Spans nur auf dem Stack (oder innerhalb eines anderen ref struct) existieren. Damit ist sichergestellt, dass sie **nicht länger leben können als der Speicher, auf den sie zeigen**, was die Sicherheit wahrt. In der Praxis wird `Span<T>` für veränderbare Speicherausschnitte verwendet, `ReadOnlySpan<T>` für nur lesbare.

**Warum Spans verwenden?** Sie ermöglichen das Arbeiten mit Teil-Arrays, Teilstrings oder Puffern **ohne Daten zu kopieren oder neuen Speicher zu allozieren**. Das bringt bessere Performance und weniger GC-Druck und behält gleichzeitig **Typsicherheit und Bereichsprüfung** bei (im Gegensatz zu rohen Pointern). Beispielsweise kann das Parsen eines großen Textes oder eines Binärpuffers mit Spans erfolgen, um zahlreiche kleine Strings oder Byte-Arrays zu vermeiden. Viele .NET-APIs (Datei-I/O, Parser, Serializer usw.) bieten inzwischen Span-basierte Überladungen aus Effizienzgründen. Bis C# 14 verstand die Sprache jedoch die Beziehung zwischen Spans und Arrays nicht vollständig, was zu etwas Boilerplate-Code führte.

## Vor C# 14: Manuelle Konvertierungen und Überladungen

In früheren C#-Versionen verfügten Spans über benutzerdefinierte Konvertierungsoperatoren von und nach Arrays. So konnten Sie ein `T[]`-Array beispielsweise **implizit konvertieren** in ein `Span<T>` oder ein `ReadOnlySpan<T>` über die in der .NET-Laufzeit definierten Überladungen. Ebenso konnte ein `Span<T>` implizit in ein `ReadOnlySpan<T>` konvertiert werden. _Wo lag also das Problem?_ Das Problem war, dass dies bibliotheksdefinierte Konvertierungen waren, keine integrierten Sprachkonvertierungen. Der C#-Compiler behandelte `Span<T>`, `ReadOnlySpan<T>` und `T[]` in bestimmten Szenarien **nicht** als verwandte Typen. Das führte vor C# 14 zu mehreren Schmerzpunkten:

-   **Erweiterungsmethoden auf Spans/Arrays:** Wenn Sie eine Erweiterungsmethode geschrieben haben, die einen `ReadOnlySpan<T>` als `this`-Parameter nimmt, konnten Sie sie nicht direkt auf einem Array oder einer `Span<T>`-Variable aufrufen. Der Compiler berücksichtigte die Konvertierung von Array zu Span beim Binden des Erweiterungsempfängers nicht. In der Praxis bedeutete das, dass Sie häufig **doppelte Überladungen** für Arrays und Spans bereitstellen oder eine Erweiterung aufrufen mussten, indem Sie das Array zuvor manuell konvertiert haben. Beispielsweise musste die BCL (Base Class Library) bestimmte Hilfsmethoden (etwa in `MemoryExtensions`) in mehreren Formen anbieten, eine für `ReadOnlySpan<T>`, eine für `Span<T>` und eine für `T[]`, damit sie in allen Fällen nutzbar waren.
-   **Generische Methoden und Typinferenz:** Ähnliche Reibung gab es bei generischen Methoden. Hatten Sie eine generische Methode `Foo<T>(Span<T> data)` und versuchten, ihr ein Array (etwa `int[]`) zu übergeben, konnte der Compiler `T` nicht ableiten, weil er an der Aufrufstelle keinen exakten `Span<T>` sah; Sie mussten den Typparameter explizit angeben oder `.AsSpan()` auf dem Array aufrufen. Die benutzerdefinierte implizite Konvertierung von `T[]` zu `Span<T>` wurde bei der **Typinferenz** nicht berücksichtigt, was den Code weniger ergonomisch machte.
-   **Notwendige explizite Konvertierungen:** In vielen Fällen mussten Entwickler manuelle Konvertierungen einfügen, etwa `myArray.AsSpan()` oder `new ReadOnlySpan<char>(myString)`, um aus einem Array oder String einen Span zu erhalten. Das ist zwar nicht furchtbar kompliziert, fügt dem Code aber Rauschen hinzu und setzt voraus, dass der Entwickler weiß, wann zu konvertieren ist. IDEs schlugen das nicht immer vor, da die Typbeziehungen den Konvertierungsregeln des Compilers nicht bekannt waren.

## Implizite Span-Konvertierungen in C# 14

C# 14 löst diese Probleme, indem **eingebaute implizite Span-Konvertierungen** auf Sprachebene eingeführt werden. Der Compiler erkennt jetzt direkt bestimmte Konvertierungen zwischen Arrays und Span-Typen, oft als **"erstklassige Span-Unterstützung"** bezeichnet. Praktisch heißt das: Sie können Arrays oder sogar Strings frei an APIs übergeben, die Spans erwarten, und umgekehrt, ohne explizite Casts oder Überladungen. Die Sprachspezifikation beschreibt die neue _implizite Span-Konvertierung_ so, dass `T[]`, `Span<T>`, `ReadOnlySpan<T>` und sogar `string` auf bestimmte Weise zwischen einander konvertiert werden können. Die unterstützten impliziten Konvertierungen umfassen:

-   **Array zu Span:** Jedes eindimensionale Array `T[]` kann implizit in `Span<T>` konvertiert werden. Beispielsweise wird ein `int[]` überall dort akzeptiert, wo ein `Span<int>` erwartet wird, ohne zusätzliche Syntax.
-   **Array zu ReadOnlySpan:** Jedes `T[]` kann auch implizit in `ReadOnlySpan<T>` konvertiert werden (oder in ein kovariantes Äquivalent `ReadOnlySpan<U>`, wenn `T` in `U` konvertierbar ist). Damit können Sie einer Methode, die einen schreibgeschützten Span desselben Elementtyps erwartet, ein Array übergeben. (Die Kovarianz hier ähnelt der Array-Kovarianz, etwa kann ein `String[]` in `ReadOnlySpan<object>` konvertiert werden, weil `string` ein `object` ist; dies ist jedoch ein fortgeschritteneres Szenario.)
-   **Span zu ReadOnlySpan:** Ein `Span<T>` kann implizit als `ReadOnlySpan<T>` (oder `ReadOnlySpan<U>` für kompatible Referenztypen) behandelt werden. Anders gesagt: Sie können einen veränderbaren Span an etwas übergeben, das ihn nur liest. Diese Konvertierung war auch vorher möglich, ist jetzt aber eine Standardkonvertierung, die der Compiler in mehr Kontexten berücksichtigt (nicht nur über einen benutzerdefinierten Operator).
-   **String zu ReadOnlySpan:** Ein `string` kann jetzt implizit in `ReadOnlySpan<char>` konvertiert werden. Das ist äußerst praktisch, um String-Daten als schreibgeschützte Zeichen-Spans zu behandeln. (Intern ist das sicher, weil der Span auf den internen Speicher des Strings zeigt und Strings in C# unveränderlich sind.) Früher mussten Sie `.AsSpan()` auf einem String oder `MemoryExtensions` verwenden, um das zu erreichen; jetzt geschieht es bei Bedarf automatisch.

Diese Konvertierungen sind nun Teil der **eingebauten Konvertierungsregeln des Compilers** (zur Menge der _Standard-implizit-Konvertierungen_ in der Sprachspezifikation hinzugefügt). Entscheidend: Da der Compiler diese Beziehungen versteht, berücksichtigt er sie bei der **Überladungsauflösung**, beim **Binden von Erweiterungsmethoden** und bei der **Typinferenz**. Kurz gesagt: C# 14 "weiß", dass `T[]`, `Span<T>` und `ReadOnlySpan<T>` bis zu einem gewissen Grad austauschbar sind, was zu intuitiverem Code führt. Wie es die offizielle Dokumentation formuliert: C# 14 erkennt die Beziehung zwischen diesen Typen und ermöglicht eine natürlichere Programmierung mit ihnen, sodass Span-Typen als Empfänger von Erweiterungsmethoden nutzbar sind und die generische Inferenz besser wird.

## Vorher und nachher in C# 14

Sehen wir uns an, wie der Code mit impliziten Span-Konvertierungen sauberer wird im Vergleich zu älteren C#-Versionen.

### 1\. Erweiterungsmethoden auf Span vs. Array

Betrachten Sie eine Erweiterungsmethode, die für `ReadOnlySpan<T>` definiert ist (zum Beispiel eine einfache Prüfung, ob ein Span mit einem bestimmten Element beginnt). In C# 13 oder früher **konnten Sie diese Erweiterung nicht direkt** auf einem Array aufrufen, obwohl ein Array als Span betrachtet werden kann, weil der Compiler die Konvertierung für den Erweiterungsempfänger nicht anwandte. Sie mussten `.AsSpan()` aufrufen oder eine separate Überladung schreiben. In C# 14 funktioniert es ganz natürlich:

```cs
// Extension method defined on ReadOnlySpan<T>
public static class SpanExtensions {
    public static bool StartsWith<T>(this ReadOnlySpan<T> span, T value) 
        where T : IEquatable<T>
    {
        return span.Length != 0 && EqualityComparer<T>.Default.Equals(span[0], value);
    }
}

int[] arr = { 1, 2, 3 };
Span<int> span = arr;        // Array to Span<T> (always allowed)
// C# 13 and earlier:
// bool result1 = arr.StartsWith(1);    // Compile-time error (not recognized)
// bool result2 = span.StartsWith(1);   // Compile-time error for Span<T> receiver
// (Had to call arr.AsSpan() or define another overload for arrays/spans)
bool result = arr.StartsWith(1);       // C# 14: OK - arr converts to ReadOnlySpan<int> implicitly
Console.WriteLine(result);            // True, since 1 is the first element
```

Im Snippet oben würde `arr.StartsWith(1)` in altem C# nicht kompilieren (Fehler CS8773), weil die Erweiterungsmethode einen `ReadOnlySpan<int>`-**Empfänger** erwartet. C# 14 erlaubt dem Compiler, das `int[]` (`arr`) implizit in `ReadOnlySpan<int>` zu konvertieren, um den Empfängerparameter der Erweiterung zu bedienen. Dasselbe gilt für eine `Span<int>`-Variable, die eine `ReadOnlySpan<T>`-Erweiterung aufruft: Der `Span<T>` kann zur Laufzeit in `ReadOnlySpan<T>` konvertiert werden. Wir müssen also keine doppelten Erweiterungsmethoden mehr schreiben (eine für `T[]`, eine für `Span<T>` usw.) oder sie manuell konvertieren, um sie aufzurufen. Der Code wird klarer und schlanker.

### 2\. Typinferenz für generische Methoden mit Spans

Implizite Span-Konvertierungen helfen auch bei **generischen Methoden**. Angenommen, wir haben eine generische Methode, die auf einem Span beliebigen Typs arbeitet:

```cs
// A generic method that prints the first element of a span
void PrintFirstElement<T>(Span<T> data) {
    if (data.Length > 0)
        Console.WriteLine($"First: {data[0]}");
}

// Before C# 14:
int[] numbers = { 10, 20, 30 };
// PrintFirstElement(numbers);        // ❌ Cannot infer T in C# 13 (array isn't Span<T>)
PrintFirstElement<int>(numbers);      // ✅ Had to explicitly specify <int>, or do PrintFirstElement(numbers.AsSpan())

// In C# 14:
PrintFirstElement(numbers);           // ✅ Implicit conversion allows T to be inferred as int
```

Vor C# 14 ließ sich der Aufruf `PrintFirstElement(numbers)` nicht kompilieren, weil das Typargument `T` nicht abgeleitet werden konnte: Der Parameter ist `Span<T>`, und ein `int[]` ist nicht direkt ein `Span<T>`. Sie mussten entweder den Typparameter `<int>` angeben oder das Array selbst in einen `Span<int>` umwandeln. Mit C# 14 erkennt der Compiler, dass `int[]` in `Span<int>` konvertierbar ist, und leitet `T` = `int` automatisch ab. Damit wird der Einsatz generischer Hilfsmittel, die mit Spans arbeiten, deutlich angenehmer, vor allem bei Array-Eingaben.

### 3\. Strings an Span-APIs übergeben

Ein weiteres häufiges Szenario ist der Umgang mit Strings als schreibgeschützten Zeichen-Spans. Viele Parsing- und Textverarbeitungs-APIs nutzen `ReadOnlySpan<char>` aus Effizienzgründen. In früheren C#-Versionen mussten Sie `.AsSpan()` auf dem String aufrufen, wenn Sie eine solche API mit einem `string` aufrufen wollten. C# 14 entfernt diese Anforderung:

```cs
void ProcessText(ReadOnlySpan<char> text)
{
    // Imagine this method parses or examines the text without allocating.
    Console.WriteLine(text.Length);
}

string title = "Hello, World!";
// Before C# 14:
ProcessText(title.AsSpan());   // Had to convert explicitly.
// C# 14 and later:
ProcessText(title);            // Now implicit: string -> ReadOnlySpan<char>

ReadOnlySpan<char> span = title;         // Implicit conversion on assignment
ReadOnlySpan<char> subSpan = title[7..]; // Slicing still yields a ReadOnlySpan<char>
Console.WriteLine(span[0]);   // 'H'
```

Die Möglichkeit, einen `string` implizit als `ReadOnlySpan<char>` zu behandeln, ist Teil der neuen Span-Konvertierungsunterstützung. Das ist besonders praktisch in echtem Code: Methoden wie `int.TryParse(ReadOnlySpan<char>, ...)` oder `Span<char>.IndexOf` lassen sich nun direkt mit einem String-Argument aufrufen. Es verbessert die Lesbarkeit, indem Rauschen (`AsSpan()`-Aufrufe) entfernt wird, und stellt sicher, dass keine unnötigen String-Allokationen oder Kopien entstehen. Die Konvertierung erfolgt kostenfrei: Sie liefert einfach einen Blick in den Speicher des ursprünglichen Strings.

## Praxisszenarien, die von Span-Konvertierungen profitieren

Die impliziten Span-Konvertierungen in C# 14 sind nicht nur eine theoretische Sprachoptimierung; sie haben praktische Auswirkungen auf verschiedene Programmierszenarien:

-   **Hochleistungs-Parsing und Textverarbeitung:** Bibliotheken oder Anwendungen, die Text parsen (z. B. CSV/JSON-Parser, Compiler), nutzen häufig `ReadOnlySpan<char>`, um Substrings zu vermeiden. Mit der impliziten Konvertierung können solche APIs `string`-Eingaben nahtlos akzeptieren. Ein JSON-Parser kann beispielsweise eine einzige Methode `Parse(ReadOnlySpan<char> json)` haben, die Aufrufer nun mit einem `string`, einem `char[]` oder einem Ausschnitt eines größeren Puffers füttern können, ganz ohne zusätzliche Überladungen oder Kopien.
-   **Speichereffiziente APIs:** In .NET sind APIs verbreitet, die Daten in Blöcken verarbeiten, etwa beim Einlesen einer Datei oder eines Netzwerks in einen Puffer. Diese APIs nutzen ggf. `Span<byte>` für Ein-/Ausgabe, um Allokationen zu vermeiden. Dank C# 14 können Sie vorhandene Daten in einem `byte[]` direkt an eine Span-basierte API übergeben. Umgekehrt können Sie einen von einer API zurückgegebenen `Span<T>` oder `ReadOnlySpan<T>` einfach an eine andere Komponente weitergeben, die ein Array oder einen schreibgeschützten Span erwartet. Die **Ergonomie** ermutigt Entwickler, Spans einzusetzen, was zu weniger Speicherbewegung führt. Sie können also eine einzige Span-zentrierte API entwerfen, die natürlich mit Arrays und Strings arbeitet, was Ihre Codebasis sauberer hält.
-   **Interop und unsafe-Szenarien:** Bei der Interaktion mit unverwaltetem Code oder Hardware-Schnittstellen arbeiten Sie oft mit rohen Puffern. Spans sind eine sichere Möglichkeit, diese in C# darzustellen. Beispielsweise könnten Sie eine native Methode aufrufen, die ein Byte-Array füllt; mit impliziten Konvertierungen kann Ihre P/Invoke-Signatur `Span<byte>` verwenden und trotzdem mit einem regulären `byte[]` aufgerufen werden. Das bietet die Sicherheit von Spans (Vermeidung von Pufferüberläufen usw.) und bleibt dabei bequem. In Low-Level-Szenarien (etwa beim Parsen binärer Protokolle oder Bilddaten) vereinfacht es den Code, verschiedene Speicherquellen einheitlich als Spans behandeln zu können.
-   **Allgemeine Nutzung der .NET-Bibliothek:** Die .NET-BCL selbst profitiert. Das Team kann jetzt eine einzige Überladung für Span-Methoden bereitstellen, statt mehrerer Überladungen für Arrays, Spans und schreibgeschützte Spans. Die `.StartsWith()`-Erweiterung für Spans (wie gezeigt) oder Methoden in `System.MemoryExtensions` lassen sich einmal auf `ReadOnlySpan<T>` definieren und funktionieren automatisch für `T[]`- und `Span<T>`-Eingaben. Das verkleinert die API-Oberfläche und reduziert das Inkonsistenzrisiko. Sehen Sie als Entwickler eine Signatur wie `public void Foo(ReadOnlySpan<byte> data)`, müssen Sie sich nicht mehr fragen, ob es eine Array-Version von `Foo` gibt; in C# 14 übergeben Sie einfach ein `byte[]`, und es funktioniert.

## Vorteile der impliziten Span-Konvertierungen

**Bessere Lesbarkeit:** Der unmittelbarste Nutzen ist saubererer Code. Sie schreiben das, was sich natürlich anfühlt, nämlich ein Array oder einen String an eine Span-konsumierende API zu übergeben, und es funktioniert einfach. Es gibt weniger kognitive Belastung, weil Sie sich nicht merken müssen, Konvertierungs-Helfer aufzurufen oder mehrere Überladungen einzubauen. Verkettungen von Erweiterungsmethoden werden intuitiver. Insgesamt wird Code, der Spans nutzt, leichter lesbar und schreibbar und sieht eher nach "normalem" C# aus. Das fördert bewährte Praktiken (Spans für Performance) durch geringere Reibung.

**Weniger Fehler:** Lässt man den Compiler die Konvertierungen übernehmen, gibt es weniger Fehlerquellen. Ein Entwickler vergisst etwa, `.AsSpan()` aufzurufen, und ruft versehentlich eine weniger effiziente Überladung auf; in C# 14 wird die gewünschte Span-Überladung automatisch ausgewählt, wo möglich. Das bedeutet auch konsistentes Verhalten: Die Konvertierung ist garantiert sicher (keine Datenkopie, keine Null-Probleme, außer wo angebracht). Werkzeuge und IDEs können nun korrekt Span-basierte Überladungen vorschlagen, weil die Typen kompatibel sind. Alle impliziten Konvertierungen sind so ausgelegt, dass sie unschädlich sind: Sie verändern keine Daten und verursachen keine Laufzeitkosten, sondern interpretieren lediglich einen vorhandenen Speicherpuffer in einem Span-Wrapper neu.

**Sicherheit und Performance:** Spans wurden geschaffen, um Performance **sicher** zu verbessern, und das C# 14-Update setzt diese Philosophie fort. Die impliziten Konvertierungen unterminieren die Typsicherheit nicht: Sie können weiterhin keine inkompatiblen Typen implizit konvertieren (z. B. `int[]` zu `Span<long>` wäre, wenn überhaupt, nur explizit erlaubt, da es eine echte Reinterpretation erfordert). Die Span-Typen selbst stellen sicher, dass Sie nichts versehentlich verändern, was schreibgeschützt sein sollte (wenn Sie ein Array in `ReadOnlySpan<T>` konvertieren, kann die aufgerufene API Ihr Array nicht verändern). Da Spans außerdem stack-only sind, erzwingt der Compiler, dass Sie sie nicht in langlebigen Variablen (etwa Feldern) speichern, die die Daten überleben könnten. Indem Spans einfacher zu verwenden sind, fördert C# 14 effektiv das Schreiben von Hochleistungscode ohne unsafe-Pointer und behält die Speichersicherheitsgarantien bei, die C#-Entwickler erwarten.

**Erweiterungsmethoden und Generics:** Wie hervorgehoben, können Spans nun vollständig an der Auflösung von Erweiterungsmethoden und der generischen Typinferenz teilnehmen. Das bedeutet, dass fließende APIs und LINQ-ähnliche Muster, die Erweiterungsmethoden nutzen, direkt austauschbar mit Spans/Arrays funktionieren. Generische Algorithmen (zum Sortieren, Suchen usw.) können mit Spans geschrieben und dennoch problemlos mit Array-Argumenten aufgerufen werden. Das Ergebnis: Sie vereinheitlichen Code-Pfade; Sie brauchen nicht einen Pfad für Arrays und einen für Spans, eine Span-basierte Implementierung deckt alles ab, was zugleich sicherer (weniger fehleranfälliger Code) und schneller (ein einziger optimierter Codepfad) ist.

## Was sich für Ihren Code ergibt

Die Einführung impliziter Span-Konvertierungen in C# 14 ist ein Segen für Entwickler, die leistungssensiblen Code schreiben. Sie **schließt die Lücke** zwischen Arrays, Strings und Span-Typen, indem dem Compiler die Beziehungen beigebracht werden. Anders als in früheren Versionen müssen Sie Ihren Code nicht mehr mit manuellen `.AsSpan()`-Aufrufen versehen oder parallele Methodenüberladungen für Spans und Arrays pflegen. Stattdessen schreiben Sie eine einzige klare API und verlassen sich darauf, dass die Sprache das Richtige tut, wenn Sie unterschiedliche Datentypen übergeben.

In der Praxis bedeutet das ausdrucksstärkeren und prägnanteren Code beim Umgang mit Speicherausschnitten. Ob Sie Text parsen, Binärdaten verarbeiten oder einfach unnötige Allokationen im Alltag vermeiden möchten, mit der erstklassigen Span-Unterstützung von C# 14 fühlt sich Span-basierte Programmierung _natürlicher_ an. Es ist ein gutes Beispiel für ein Sprachfeature, das sowohl die Entwicklerproduktivität als auch die Laufzeit-Performance verbessert und den Code dabei sicher und robust hält. Da Spans nun nahtlos aus Arrays und Strings konvertieren, können Sie diese Hochleistungstypen mit noch weniger Reibung als bisher in Ihrer gesamten Codebasis einsetzen.

**Quellen:**

-   [C# 14 Feature Specification – _First-class Span types_](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-14.0/first-class-span-types#:~:text=recognize%20the%20relationship%20between%20%60ReadOnlySpan,a%20lot%20of%20duplicate%20surface)
-   [_What's new in C# 14: More implicit conversions for Span<T>_](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/csharp-14#implicit-span-conversions#:~:text=%60Span,with%20generic%20type%20inference%20scenarios)
-   [What's new in C# 14](/2024/12/csharp-14/)
