---
title: "Was ist das DynamicallyAccessedMembers-Attribut?"
description: "DynamicallyAccessedMembers teilt dem .NET-Trimmer und dem AOT-Compiler mit, welche Member eines Type Sie per Reflection erreichen, damit diese erhalten bleiben statt weggetrimmt zu werden. Es verwandelt eine stille MissingMethodException zur Laufzeit in eine IL2070-Warnung zur Build-Zeit. Hier erfahren Sie, was das Attribut tut, wie die zugrunde liegende Datenflussanalyse funktioniert und wie Sie Parameter, Felder und generische Typparameter korrekt annotieren."
pubDate: 2026-06-20
tags:
  - "dotnet"
  - "trimming"
  - "native-aot"
  - "csharp"
  - "dotnet-11"
lang: "de"
translationOf: "2026/06/what-is-the-dynamicallyaccessedmembers-attribute"
translatedBy: "claude"
translationDate: 2026-06-20
---

`[DynamicallyAccessedMembers]` ist das Attribut, das Sie an einen `Type` (oder einen Typnamen als `string`) setzen, um dem .NET-Trimmer und dem Native-AOT-Compiler mitzuteilen: "Ich werde diese Member per Reflection erreichen, also lösche sie nicht." Es ist der Vertrag, der es der statischen Analyse erlaubt, Reflection zu folgen, die sie sonst nicht sehen kann. Ohne es entfernt der Trimmer jeden Member, dessen Erreichbarkeit er nicht beweisen kann, und Ihr `type.GetMethod("Run").Invoke(...)` wirft zur Laufzeit in der veröffentlichten App eine `MissingMethodException`, obwohl es in `dotnet run` funktioniert hat. Mit ihm kompiliert derselbe Code entweder sauber oder liefert Ihnen eine präzise Warnung zur Build-Zeit (`IL2070`, `IL2075`, `IL2077` und Verwandte), die genau auf die Stelle zeigt, an der ein nicht annotierter `Type` in einen Reflection-Aufruf fließt. Das Attribut liegt in `System.Diagnostics.CodeAnalysis`, ausgeliefert in `System.Runtime.dll`, und ist seit .NET 5 stabil. Alles Folgende zielt auf das .NET 11 SDK (`11.0.100`) und C# 14, aber die Mechanik gilt ab .NET 6, wo Trim-Analyse-Warnungen erstmals ausgegeben wurden.

## Warum der Trimmer überhaupt einen Hinweis braucht

Trimming und der [Native AOT](/2026/06/what-is-native-aot-and-what-does-it-cost-you/)-Build, der es voraussetzt, arbeiten über Erreichbarkeitsanalyse. Der Trimmer startet an Ihrem Einstiegspunkt, durchläuft jeden Methodenaufruf, jeden Feldzugriff und jede Typreferenz, die er statisch sehen kann, markiert alles Berührte als "erhalten" und löscht den Rest. So schrumpft eine eigenständige App von 70 MB auf 15 MB: Das Framework ist riesig und Ihre App nutzt nur einen Bruchteil davon.

Reflection durchbricht diesen Durchlauf. Wenn Sie `type.GetMethods()` schreiben, hat der Trimmer keine Ahnung, welchen Typ `type` zur Laufzeit hält, also kann er nicht wissen, welche Methoden er erhalten muss. Er hat zwei Optionen: jede Methode jedes Typs erhalten, der möglicherweise in diesen Aufruf fließen könnte (was Trimming vollständig zunichtemacht), oder nichts erhalten und Sie es zur Laufzeit herausfinden lassen. Er tut keines von beidem. Stattdessen sind die BCL-Methoden, die per Reflection arbeiten, selbst annotiert, und der Trimmer verlangt, dass der `Type`, den Sie ihnen übergeben, ein passendes Versprechen trägt. `[DynamicallyAccessedMembers]` ist die Art, wie Sie dieses Versprechen geben.

Sehen Sie sich die Signatur von `Type.GetMethods()` im .NET-Quellcode an, und Sie werden feststellen, dass die Instanzmethode effektiv so annotiert ist, dass sie `PublicMethods` auf `this` verlangt. Diese harmlose Hilfsmethode erzeugt also eine Warnung:

```csharp
// .NET 11, C# 14. Compiled with <PublishTrimmed>true</PublishTrimmed>.
static void UseMethods(Type type)
{
    // warning IL2070: 'this' argument does not satisfy
    // 'DynamicallyAccessedMemberTypes.PublicMethods' in call to
    // 'System.Type.GetMethods()'. The parameter 'type' of method
    // 'UseMethods(Type)' does not have matching annotations.
    foreach (var method in type.GetMethods())
    {
        // ...
    }
}
```

Der Trimmer sagt damit: Ich erlaube dir gleich, die öffentlichen Methoden von was auch immer `type` ist aufzuzählen, aber niemand hat versprochen, dass diese Methoden das Trimming überleben. Annotiere die Quelle des `Type`, damit das Versprechen im Typsystem verankert ist.

## Die Lösung: die Anforderung am Parameter angeben

Die Lösung besteht darin, die Anforderung auf den Parameter zu übertragen, der den `Type` liefert:

```csharp
// .NET 11, C# 14.
using System.Diagnostics.CodeAnalysis;

static void UseMethods(
    [DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.PublicMethods)] Type type)
{
    foreach (var method in type.GetMethods()) // no warning
    {
        // ...
    }
}
```

Jetzt ist `UseMethods` intern erfüllt, aber die Anforderung verschwindet nicht. Sie wandert zu den Aufrufern. Wer auch immer `UseMethods` aufruft, muss ihm einen `Type` übergeben, von dem selbst bekannt ist, dass er seine öffentlichen Methoden erhält. Das ist das gesamte Modell: Das Attribut bewahrt von sich aus nichts. Es ist eine Flussannotation, die die Verpflichtung die Aufrufkette hinaufschiebt, bis sie einen Punkt erreicht, an dem der konkrete Typ bekannt ist.

## Wo die Verpflichtung tatsächlich endet

Die Anforderung hört an einer von zwei Stellen auf, sich fortzupflanzen. Die erste ist `typeof`. Wenn Sie `typeof(Customer)` schreiben, kennt der Trimmer den genauen Typ und kann erhalten, was das Ziel auch immer verlangt:

```csharp
// .NET 11. typeof gives the trimmer a concrete type, so it keeps
// Customer's public methods and the call is clean.
UseMethods(typeof(Customer));
```

Die zweite ist eine öffentliche API-Grenze. Wenn der `Type` aus einem Parameter, einem Feld oder einem Methodenrückgabewert stammt, annotieren Sie auch diese Stelle, und die Kette setzt sich nach außen fort. Hier ist der Feld-Fall, den die Leute übersehen:

```csharp
// .NET 11, C# 14.
static Type _type = typeof(Customer);

static void UseMethodsHelper()
{
    // warning IL2077: 'type' argument does not satisfy
    // 'DynamicallyAccessedMemberTypes.PublicMethods' in call to 'UseMethods(Type)'.
    // The field '_type' does not have matching annotations.
    UseMethods(_type);
}
```

Das Feld trägt kein Versprechen, daher warnt das Übergeben an einen annotierten Parameter. Annotieren Sie das Feld, und nun erzwingt der Trimmer das Versprechen stattdessen bei jeder Zuweisung in dieses Feld:

```csharp
// .NET 11, C# 14.
[DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.PublicMethods)]
static Type _type = typeof(Customer); // assignment of a concrete type: clean

static void UseMethodsHelper() => UseMethods(_type); // clean
```

Weisen Sie etwas, das der Trimmer nicht nachvollziehen kann (einen nicht annotierten `Type`-Parameter, ein `Type.GetType("…")` aus einem Laufzeit-String), in dieses annotierte Feld zu, dann erhalten Sie eine Warnung an der Zuweisung. Das Versprechen ist jetzt in beiden Richtungen tragend.

## Die DynamicallyAccessedMemberTypes-Flags

Das einzelne Konstruktorargument ist ein `[Flags]`-Enum, sodass Sie Werte mit `|` kombinieren, um genau das zu erhalten, was Ihre Reflection berührt, und nichts mehr. Die Kernwerte und ihre numerischen Flags:

| Wert | Was es erhält |
| --- | --- |
| `None` | Nichts. |
| `PublicParameterlessConstructor` | Den öffentlichen Standardkonstruktor (was `Activator.CreateInstance(type)` benötigt). |
| `PublicConstructors` | Alle öffentlichen Konstruktoren. |
| `NonPublicConstructors` | Alle nicht-öffentlichen Konstruktoren. |
| `PublicMethods` / `NonPublicMethods` | Öffentliche / nicht-öffentliche Methoden. |
| `PublicFields` / `NonPublicFields` | Öffentliche / nicht-öffentliche Felder. |
| `PublicProperties` / `NonPublicProperties` | Öffentliche / nicht-öffentliche Eigenschaften. |
| `PublicEvents` / `NonPublicEvents` | Öffentliche / nicht-öffentliche Events. |
| `PublicNestedTypes` / `NonPublicNestedTypes` | Verschachtelte Typen. |
| `Interfaces` | Schnittstellen, die der Typ implementiert. |
| `All` | Alles (Wert `-1`). |

Die Regel lautet, das Minimum anzufordern. Wenn Sie nur `Activator.CreateInstance(type)` aufrufen, fordern Sie `PublicParameterlessConstructor` an, nicht `All`. Jedes Flag, das Sie hinzufügen, sind Member, die der Trimmer nicht löschen darf, was sich als Binärgröße in der finalen App niederschlägt. `All` ist die bequeme Antwort, die den größten Teil des Trimming-Nutzens für diesen Typ stillschweigend zunichtemacht.

.NET 9 und 10 fügten eine zweite Familie von `...WithInherited`- und `All...`-Flags hinzu, zum Beispiel `AllMethods`, `AllConstructors` und `NonPublicMethodsWithInherited`. Das einfache `PublicMethods`-Flag schließt geerbte öffentliche Methoden bereits ein, weil sie Teil der öffentlichen Oberfläche des Typs sind, aber die nicht-öffentlichen Varianten durchliefen Basisklassen historisch nicht. Die `WithInherited`-Flags schließen diese Lücke, wenn Sie über geerbte private oder geschützte Member reflektieren. Greifen Sie nur dann zu ihnen, wenn Ihre Reflection tatsächlich die Vererbungsgrenze überschreitet.

## Generische Typparameter und Rückgabewerte annotieren

Das Attribut ist nicht auf Parameter und Felder beschränkt. Sein `AttributeUsage` deckt Parameter, Felder, Eigenschaften, Rückgabewerte, generische Parameter, Klassen, Schnittstellen, Strukturen und Methoden ab. Zwei davon sind hervorzuheben.

Ein generischer Typparameter kann die Anforderung tragen, und so schreiben Sie eine Reflection-gestützte Factory, die trim-sicher bleibt:

```csharp
// .NET 11, C# 14.
using System.Diagnostics.CodeAnalysis;

static T Create<[DynamicallyAccessedMembers(
    DynamicallyAccessedMemberTypes.PublicParameterlessConstructor)] T>()
{
    return Activator.CreateInstance<T>(); // clean
}

// The constraint flows to the call site. typeof is implicit in the type argument.
var c = Create<Customer>(); // trimmer keeps Customer's parameterless ctor
```

Das Anwenden des Attributs auf eine Methode ist ein dokumentierter Sonderfall: Es wird so behandelt, als würde es auf den `this`-Parameter angewendet, ergibt also nur bei Instanzmethoden eines Typs Sinn, der `Type` zuweisbar ist. Das Rückgabewert-Ziel erlaubt es einer Methode, etwas über den `Type` zu versprechen, den sie zurückgibt:

```csharp
// .NET 11, C# 14. The caller can reflect over public methods of the returned Type.
[return: DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.PublicMethods)]
static Type ResolveHandler(string name) =>
    name == "customer" ? typeof(Customer) : typeof(Order);
```

## Wenn das Muster sich wirklich nicht annotieren lässt

Manchmal ist der Datenfluss real und korrekt, aber der Analyzer kann ihm nicht folgen, zum Beispiel ein `Type[]`, bei dem Sie konstruktionsbedingt wissen, dass jedes Element seinen Konstruktor erhält, aber der Trimmer diese Invariante nicht sehen kann. Für diese Fälle bringt `[UnconditionalSuppressMessage]` eine bestimmte Warnung zum Schweigen und wird, anders als `[SuppressMessage]`, im IL persistiert, sodass die Trim-Analyse es respektiert:

```csharp
// .NET 11, C# 14.
[UnconditionalSuppressMessage("ReflectionAnalysis", "IL2063",
    Justification = "The array only ever holds types stored through the annotated setter.")]
get => _types[i];
```

Das ist ein Versprechen, das Sie auf Ihr Ehrenwort geben. Die Dokumentation ist deutlich, dass es nur dann zulässig ist zu unterdrücken, wenn die per Reflection angesprochenen Member anderswo im Programm echte Reflection-Ziele sind, denn Member, die keine sichtbaren Reflection-Ziele sind, können vom Optimizer inlineerweitert, umbenannt oder verschoben werden, und Ihr unterdrückter Code bricht dann auf eine Weise, die keine Warnung vorhergesagt hat.

Die andere Notausstiegsmöglichkeit ist `[DynamicDependency]`, das benannte Member erhält, die Analyse aber nicht informiert. Es ist ein letztes Mittel für Muster, die nicht einmal `[DynamicallyAccessedMembers]` ausdrücken kann, etwa das Laden eines Members per String aus einer separaten Assembly:

```csharp
// .NET 11, C# 14.
[DynamicDependency("Helper", "MyType", "MyAssembly")]
static void RunHelper()
{
    var helper = Assembly.Load("MyAssembly").GetType("MyType").GetMethod("Helper");
    helper.Invoke(null, null);
}
```

Wenn Sie zu einer der beiden Notausstiegsmöglichkeiten über viele Aufrufstellen hinweg greifen, ist das das Signal, dass die API grundlegend Reflection-förmig ist und durch Codegenerierung zur Kompilierzeit ersetzt werden sollte. Reflection-basierte Serializer und Mapper sind das klassische Beispiel: Statt sich um `GetProperties()`-Durchläufe herum zu annotieren, setzen Sie einen Source Generator ein, der den Zugriffscode zur Build-Zeit emittiert. Falls Ihnen dieser Begriff neu ist, ist [was ein Source Generator ist und wann Sie einen brauchen](/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) die Einführung, und es ist der Grund, warum es das per Source Generator erzeugte `System.Text.Json` gibt.

## Wie das mit RequiresUnreferencedCode zusammenhängt

Es ist leicht, `[DynamicallyAccessedMembers]` mit `[RequiresUnreferencedCode]` zu verwechseln. Sie lösen benachbarte Probleme. `[DynamicallyAccessedMembers]` ist für analysierbare Reflection: Sie wissen genau, welche Member eines `Type` Sie berühren, also geben Sie es an und der Trimmer erhält sie. `[RequiresUnreferencedCode]` ist für Reflection, die sich überhaupt nicht trim-sicher machen lässt, ein Eingeständnis, dass die Methode etwas tut, das der Trimmer nicht modellieren kann. Eine Methode damit zu annotieren behebt nichts; es pflanzt eine `IL2026`-Warnung zu jedem Aufrufer fort, genauso wie `[DynamicallyAccessedMembers]` seine Anforderung fortpflanzt, bis die Warnung eine öffentliche API erreicht, wo der Autor der Bibliothek die Einschränkung dokumentieren kann. Verwenden Sie `[DynamicallyAccessedMembers]`, wenn Sie die Anforderung ausdrücken können, und greifen Sie nur dann auf `[RequiresUnreferencedCode]` zurück, wenn Sie es wirklich nicht können.

Der praktische Arbeitsablauf ist derselbe, der die gesamte Trimming- und AOT-Geschichte bestimmt: Schalten Sie den Analyzer ein, behandeln Sie jede `IL2xxx`-Warnung als echten Defekt statt als Rauschen und treiben Sie die Anzahl auf null, bevor Sie ausliefern. Setzen Sie `<IsTrimmable>true</IsTrimmable>` an einer Bibliothek, um auf dieses Projekt beschränkte Warnungen zu erhalten, oder bauen Sie eine kleine Trimming-Test-App mit `<PublishTrimmed>true</PublishTrimmed>` und einem `TrimmerRootAssembly`-Eintrag, um jede Warnung über den gesamten Abhängigkeitsgraphen hinweg zu sehen. Ein sauberer Build ist der Vertrag. Wenn ein AOT-inkompatibler Aufruf am Analyzer vorbeischlüpft und erst zur Laufzeit fehlschlägt, sind Sie zurück beim Debuggen einer [PlatformNotSupportedException in Native AOT](/2026/05/fix-platformnotsupportedexception-in-native-aot/), was genau das stille Versagen ist, das diese Annotationen verhindern sollen. Und wenn Sie das für einen echten Webdienst verdrahten, führt [wie man Native AOT mit ASP.NET Core Minimal APIs verwendet](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) das Rezept für den sauberen Build von Anfang bis Ende durch.

Das mentale Modell, das all dies einleuchten lässt: `[DynamicallyAccessedMembers]` bewahrt keinen Code. Es pflanzt eine Anforderung entlang des Flusses eines `Type`-Werts fort, vom Reflection-Aufruf zurück bis dorthin, wo dieser `Type` entstand, und die Bewahrung geschieht erst am `typeof` oder an der konkreten Zuweisung, wo die Anforderung schließlich landet. Bekommen Sie diesen Fluss richtig hin, dann hört Trimming auf, eine Quelle mysteriöser Abstürze nur in Produktion zu sein, und wird zu einer Compiler-Funktion, der Sie tatsächlich vertrauen können.

## Verwandt

- [Was ist Native AOT und was kostet es Sie?](/2026/06/what-is-native-aot-and-what-does-it-cost-you/) erklärt, warum Trimming unter AOT zwingend ist und was Sie sonst noch aufgeben.
- [Was ist ein Source Generator und wann brauche ich einen?](/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) behandelt die Codegenerierung zur Kompilierzeit, die Reflection ersetzt, die Sie nicht annotieren können.
- [Wie man Native AOT mit ASP.NET Core Minimal APIs verwendet](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) ist die Schritt-für-Schritt-Anleitung für den sauberen Build, bei der diese Warnungen in der Praxis auftauchen.
- [Fix: PlatformNotSupportedException in Native AOT](/2026/05/fix-platformnotsupportedexception-in-native-aot/) ist das Laufzeitversagen, das ein annotierter, warnungsfreier Build verhindert.

## Quellen

- [DynamicallyAccessedMembersAttribute Class](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.codeanalysis.dynamicallyaccessedmembersattribute), MS Learn (Definition, AttributeUsage-Ziele, der Methode-ist-this-Sonderfall).
- [DynamicallyAccessedMemberTypes Enum](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.codeanalysis.dynamicallyaccessedmembertypes), MS Learn (die vollständige Flags-Liste einschließlich der WithInherited-Ergänzungen aus .NET 9/10).
- [Prepare .NET libraries for trimming](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/prepare-libraries-for-trimming), MS Learn (IL2070/IL2077-Beispiele, UnconditionalSuppressMessage, DynamicDependency, Empfehlungen).
- [Introduction to trim warnings](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/fixing-warnings), MS Learn (Warnungskatalog und das Datenflussmodell).
