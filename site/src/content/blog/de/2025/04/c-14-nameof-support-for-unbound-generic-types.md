---
title: "C# 14: nameof-Unterstützung für ungebundene generische Typen"
description: "C# 14 erweitert den nameof-Ausdruck um Unterstützung für ungebundene generische Typen wie List<> und Dictionary<,>, sodass Platzhalter-Typargumente entfallen."
pubDate: 2025-04-07
tags:
  - "csharp-14"
  - "csharp"
  - "dotnet"
  - "dotnet-10"
lang: "de"
translationOf: "2025/04/c-14-nameof-support-for-unbound-generic-types"
translatedBy: "claude"
translationDate: 2026-05-01
---
C# 14 bringt mehrere kleine, aber hilfreiche Verbesserungen in die Sprache. Eine dieser neuen Funktionen ist eine Erweiterung des `nameof`-Ausdrucks: Er unterstützt jetzt _ungebundene generische Typen_. Einfach gesagt, müssen Sie kein Platzhalter-Typargument mehr einsetzen, nur um den Namen eines generischen Typs zu erhalten. Diese Aktualisierung beseitigt eine kleine Unannehmlichkeit, mit der C#-Entwickler seit Jahren konfrontiert waren, und macht Code, der `nameof` verwendet, sauberer und besser wartbar.

## Was sind ungebundene generische Typen

In C# ist ein _generischer Typ_ eine Klasse oder ein Struct mit Typparametern (zum Beispiel `List<T>` oder `Dictionary<TKey, TValue>`). Ein **ungebundener generischer Typ** ist die Definition des generischen Typs selbst, ohne dass spezifische Typargumente angegeben werden. Sie erkennen einen ungebundenen Generic an den leeren spitzen Klammern (wie `List<>`) oder an Kommas innerhalb der spitzen Klammern, die die Anzahl der Typparameter angeben (wie `Dictionary<,>` für zwei Typparameter). Er stellt den generischen Typ _allgemein_ dar, ohne festzulegen, was `T` oder `TKey`/`TValue` sind. Wir können einen ungebundenen generischen Typ nicht direkt instanziieren, weil er nicht vollständig spezifiziert ist, aber wir können ihn in bestimmten Kontexten verwenden (etwa für Reflection über `typeof`). Beispielsweise gibt `typeof(List<>)` ein `System.Type`-Objekt für den offenen generischen Typ `List` zurück.

Vor C# 14 erlaubte die Sprache **nicht**, ungebundene generische Typen in den meisten Ausdrücken zu verwenden. Sie traten hauptsächlich in Reflection- oder Attributszenarien auf. Wollten Sie im Code auf einen generischen Typ namentlich verweisen, mussten Sie typischerweise konkrete Typargumente liefern, was ihn zu einem _geschlossenen_ generischen Typ machte. Beispielsweise sind `List<int>` oder `Dictionary<string, int>` _geschlossene generische Typen_, weil alle ihre Typparameter spezifiziert sind. Bisher haben C#-Entwickler oft einen beliebigen Typ (wie `object` oder `int`) gewählt, nur um die Syntax zu erfüllen, obwohl sie eigentlich nur den Namen des generischen Typs selbst wollten.

## Wie `nameof` vor C# 14 funktionierte

Der `nameof`-Ausdruck ist eine Funktion zur Kompilierzeit, die den Namen einer Variable, eines Typs oder eines Mitglieds als Zeichenfolge erzeugt. Er wird häufig verwendet, um zu vermeiden, Bezeichner als feste Strings zu schreiben (etwa für Argumentvalidierung oder Eigenschaftsänderungs-Benachrichtigungen). Vor C# 14 hatte `nameof` eine Einschränkung im Umgang mit Generics: Sie **konnten** keinen ungebundenen generischen Typ als Argument verwenden. Das Argument von `nameof` musste ein gültiger Ausdruck oder Typbezeichner im Code sein, was bedeutete, dass generische Typen konkrete Typargumente brauchten. In der Praxis hieß das: Um den Namen eines generischen Typs zu erhalten, mussten Sie einen Dummy-Typparameter angeben.

Angenommen, Sie wollten die Zeichenfolge `"List"` (den Namen der generischen Klasse `List<T>`). In C# 13 oder früher hätten Sie etwa Folgendes schreiben müssen:

```cs
string typeName = nameof(List<int>);  // evaluates to "List"
```

Hier haben wir `List<int>` mit einem beliebigen Typargument (`int`) verwendet, obwohl die Wahl des Typs für das Ergebnis irrelevant ist. Wenn Sie versucht hätten, eine ungebundene Form wie `List<>` ohne Typargument zu verwenden, hätte der Code nicht kompiliert. Der Compiler hätte sich mit einer Fehlermeldung über einen "ungebundenen generischen Namen" oder Ähnliches beschwert, weil dies in einem Kontext, der einen Ausdruck erwartet, nicht erlaubt war. Mit anderen Worten: Sie _mussten_ einen Typparameter angeben, damit es ein gültiger Ausdruck für `nameof` war, obwohl `nameof` letztlich das Typargument ignoriert und sich nur für den Namen `"List"` interessiert.

Diese Anforderung war einfach eine Eigenheit der Sprachregeln. Sie konnte zu unbeholfenem oder fragilem Code führen. Beispielsweise verwendeten Entwickler oft einen Platzhalter wie `object` oder `int` für den Typparameter, nur um `nameof` zu nutzen. Bekam der generische Typ später eine neue Constraint (etwa dass `T` ein Referenztyp sein oder von einer bestimmten Klasse erben musste), konnte die `nameof`-Verwendung brechen, weil der Dummy-Typ die Constraints nicht mehr erfüllte. In manchen fortgeschrittenen Fällen war es nicht trivial, einen passenden Typ zu finden (etwa wenn `T` auf eine interne Klasse oder ein Interface beschränkt war, das kein vorhandener Typ implementierte; dann musste man eine Dummy-Klasse erstellen, nur um den Generic-Parameter zu erfüllen, um `nameof` verwenden zu können). All das war zusätzlicher Aufwand für etwas, das das Ergebnis von `nameof` gar nicht beeinflusst.

## `nameof` mit ungebundenen Generics in C# 14

C# 14 behebt dieses Problem, indem es erlaubt, ungebundene generische Typen direkt in `nameof`-Ausdrücken zu verwenden. Das Argument von `nameof` kann nun eine generische Typdefinition ohne Angabe ihrer Typparameter sein. Das Ergebnis ist genau das, was Sie erwarten würden: `nameof` gibt den Namen des generischen Typs zurück. Das bedeutet, Sie können endlich `nameof(List<>)` schreiben und die Zeichenfolge `"List"` erhalten, ohne ein Dummy-Typargument zu benötigen.

Um die Änderung zu veranschaulichen, vergleichen wir, wie wir den Namen eines generischen Typs vor und nach C# 14 erhalten:

**Vor C# 14:**

```cs
// Using a closed generic type (with a type argument) to get the name:
Console.WriteLine(nameof(List<int>));    // Output: "List"

// The following was not allowed in C# 13 and earlier – it would cause a compile error:
// Console.WriteLine(nameof(List<>));    // Error: Unbound generic type not allowed
```

**In C# 14 und später:**

```cs
// We can use an unbound generic type directly:
Console.WriteLine(nameof(List<>));       // Output: "List"
Console.WriteLine(nameof(Dictionary<,>)); // Output: "Dictionary"
```

Wie oben gezeigt, ergibt `nameof(List<>)` jetzt `"List"`, und entsprechend liefert `nameof(Dictionary<,>)` `"Dictionary"`. Wir müssen kein gefälschtes Typargument mehr angeben, nur um `nameof` mit einem generischen Typ zu verwenden.

Diese Verbesserung beschränkt sich nicht darauf, nur den Namen des Typs selbst zu bekommen. Sie können sie auch nutzen, um die Namen von Mitgliedern eines ungebundenen generischen Typs zu erhalten, genauso wie bei einem normalen Typ. Beispielsweise ist `nameof(List<>.Count)` in C# 14 jetzt ein gültiger Ausdruck und liefert die Zeichenfolge `"Count"`. In früheren Versionen hätten Sie `nameof(List<int>.Count)` oder einen anderen konkreten Typ statt `<int>` schreiben müssen, um dasselbe Ergebnis zu erzielen. C# 14 lässt Sie die Typargumente auch in solchen Kontexten weglassen. Generell können Sie überall dort, wo Sie `nameof(SomeGenericType<...>.MemberName)` verwenden würden, den generischen Typ jetzt ungebunden lassen, wenn Sie keinen spezifischen Typ haben oder sich nicht festlegen wollen.

Es ist erwähnenswert, dass diese Funktion rein der Bequemlichkeit und der Codeklarheit dient. Die Ausgabe des `nameof`-Ausdrucks hat sich nicht geändert: Es ist immer noch nur der Bezeichnername. Geändert haben sich die Sprachregeln, die jetzt eine breitere Menge an Eingaben für `nameof` zulassen. Das bringt `nameof` in Einklang mit `typeof`, das offene generische Typen bereits zuließ. Im Wesentlichen erkennt die C#-Sprache an, dass die Angabe eines Typparameters in diesen Fällen von Anfang an eine unnötige Anforderung war.

## Warum das nützlich ist

Ungebundene generische Typen in `nameof` zuzulassen, mag wie eine kleine Anpassung wirken, hat aber einige praktische Vorteile:

-   **Sauberer und klarer Code:** Sie müssen keine irrelevanten Typargumente mehr in Ihren Code einfügen, nur um den Compiler zufriedenzustellen. `nameof(List<>)` drückt klar aus: "Ich möchte den Namen des generischen Typs `List`", während `nameof(List<int>)` einen Leser kurz fragen lassen könnte: "Warum `int`?". Das Entfernen des Rauschens macht die Absicht des Codes deutlicher.
-   **Keine Dummy-Typen oder Workarounds mehr:** In Code vor C# 14 verwendeten Entwickler oft Platzhalter-Typen wie `object` oder erstellten Dummy-Implementierungen, um `nameof` mit Generics zu nutzen. Das ist nicht mehr nötig. Ihr Code kann den Namen des generischen Typs direkt referenzieren, ohne Workaround, was Unordnung und seltsame Abhängigkeiten reduziert.
-   **Bessere Wartbarkeit:** Ungebundene Generics in `nameof` zu verwenden, macht Ihren Code weniger anfällig für Änderungen. Wenn der generische Typ neue Typparameter-Constraints oder andere Modifikationen bekommt, müssen Sie nicht jede `nameof`-Verwendung erneut prüfen, um sicherzustellen, dass Ihr gewähltes Typargument noch passt. Wenn Sie zum Beispiel `nameof(MyGeneric<object>)` hatten und `MyGeneric<T>` später eine `where T : struct`-Constraint erhält, würde dieser Code nicht mehr kompilieren. Mit `nameof(MyGeneric<>)` funktioniert er trotz solcher Änderungen weiter, da er nicht von einem bestimmten Typargument abhängt.
-   **Konsistenz mit anderen Sprachfunktionen:** Diese Änderung macht `nameof` konsistenter mit der Funktionsweise anderer Metaprogrammierungs-Features wie `typeof`. Da Sie bereits `typeof(GenericType<>)` machen konnten, um einen offenen generischen Typ per Reflection zu erhalten, ist es naheliegend, dass Sie auch `nameof(GenericType<>)` schreiben können, um seinen Namen zu erhalten. Die Sprache wirkt jetzt konsistenter und logischer.
-   **Kleine Erleichterung in Reflection- oder Code-Generation-Szenarien:** Wenn Sie Bibliotheken oder Frameworks schreiben, die mit Typen und Namen arbeiten (etwa Dokumentation, Fehlermeldungen erzeugen oder Modellbindung mit Logging von Typnamen), können Sie Namen generischer Typen jetzt direkter abrufen. Eine kleine Bequemlichkeit, die aber Code vereinfachen kann, der Typ-Namens-Strings aufbaut oder `nameof` für Logging und Exceptions mit generischen Klassen verwendet.

## Was sich für Ihren Code ändert

Die Unterstützung ungebundener generischer Typen im `nameof`-Ausdruck ist eine willkommene Verbesserung in C# 14, die die Sprache etwas entwicklerfreundlicher macht. Indem Konstrukte wie `nameof(List<>)` zugelassen werden, beseitigt C# eine alte Unannehmlichkeit und lässt Entwickler ihre Absicht ohne unnötigen Boilerplate-Code ausdrücken. Diese Änderung kommt allen C#-Nutzern zugute: Anfänger entgehen Verwirrung beim Einsatz von `nameof` mit Generics, und erfahrene Entwickler erhalten schlankeren Code, der gegenüber zukünftigen Änderungen robuster ist. Es ist ein gutes Beispiel dafür, wie das C#-Team einen "Papercut" der Sprache angeht und die Konsistenz verbessert. Wenn Sie auf C# 14 umsteigen, behalten Sie diese Funktion im Hinterkopf, wenn Sie den Namen eines generischen Typs benötigen, und genießen Sie es, saubereren und prägnanteren Code zu schreiben.

## Referenzen

1.  [What's new in C# 14 | Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/csharp-14#:~:text=Beginning%20with%20C,name)
2.  [Generics and attributes – C# | Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/advanced-topics/reflection-and-attributes/generics-and-attributes#:~:text=constructed%20generic%20types%2C%20not%20on,Dictionary)
3.  [The nameof expression – evaluate the text name of a symbol – C# reference | Microsoft Learn](https://msdn.microsoft.com/en-us/library/dn986596.aspx#:~:text=Console.WriteLine%28nameof%28List,%2F%2F%20output%3A%20List)
4.  [Unbound generic types in `nameof` – C# feature specifications (preview) | Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-14.0/unbound-generic-types-in-nameof#:~:text=Motivation)
5.  [What's new in C# 14 | StartDebugging.NET](/2024/12/csharp-14/)
