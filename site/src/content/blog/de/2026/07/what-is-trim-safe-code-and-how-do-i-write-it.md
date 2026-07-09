---
title: "Was ist trim-sicherer Code und wie schreibe ich ihn?"
description: "Trim-sicherer Code ist Code, dessen Erreichbarkeit der .NET-Trimmer statisch beweisen kann, sodass er erhalten bleibt, wenn ungenutzter Code aus einer eigenständigen App entfernt wird. Dies ist die praktische Anleitung: Aktivieren Sie den Analyzer, treiben Sie jede IL2xxx-Warnung auf null, annotieren Sie Reflection mit DynamicallyAccessedMembers, propagieren Sie RequiresUnreferencedCode an öffentliche APIs und ersetzen Sie nicht analysierbare Muster durch Source Generatoren."
pubDate: 2026-07-09
tags:
  - "dotnet"
  - "trimming"
  - "native-aot"
  - "csharp"
  - "dotnet-11"
lang: "de"
translationOf: "2026/07/what-is-trim-safe-code-and-how-do-i-write-it"
translatedBy: "claude"
translationDate: 2026-07-09
---

Trim-sicherer Code ist Code, dessen Erreichbarkeit der .NET-Trimmer statisch beweisen kann, sodass er nicht gelöscht wird, wenn Sie eine getrimmte, eigenständige App veröffentlichen, und Code, der die App nicht stillschweigend beschädigt, wenn ungenutzte Member in seiner Umgebung entfernt werden. Konkret bedeutet es, dass Ihr Projekt unter Trim-Analyse sauber kompiliert: null `IL2026`, `IL3050`, `IL2070` und Konsorten. Sie machen Code trim-sicher, indem Sie den Analyzer aktivieren und dann die Warnungsliste auf null abarbeiten: annotieren Sie Reflection, die Sie ausdrücken können (`[DynamicallyAccessedMembers]`), stellen Sie Reflection, die Sie nicht ausdrücken können, hinter `[RequiresUnreferencedCode]` unter Quarantäne und schieben Sie sie bis zu einer öffentlichen API hoch, und ersetzen Sie Muster, die sich beidem widersetzen, durch einen Source Generator. Ein sauberer Analyse-Build ist der Vertrag; wenn Sie nicht auf null kommen, ist die App nicht trim-sicher, und das Trimming erzeugt Abstürze, die nur in der Produktion auftreten und die in `dotnet run` nie aufgetaucht sind.

Alles hier zielt auf das .NET 11 SDK (`11.0.100`) und C# 14 ab, aber Trim-Analyse-Warnungen gibt es seit .NET 6, also gelten die Mechanismen ab `net6.0` aufwärts. Das .NET 8 SDK oder neuer ist das praktische Minimum für Bibliotheksarbeit, denn dort haben sich der Analyzer und die AOT-Kompatibilität stabilisiert.

## Warum der Trimmer die Mitarbeit Ihres Codes braucht

Trimming funktioniert über Erreichbarkeitsanalyse. Der Trimmer (intern `ILLink`) startet an Ihrem Einstiegspunkt, durchläuft jeden Methodenaufruf, jeden Feldzugriff und jede Typreferenz, die er statisch sehen kann, markiert alles, was er berührt, als erhalten und löscht den Rest. So schrumpft eine eigenständige App von zig Megabyte auf einen Bruchteil: das Framework ist riesig, Ihre App nutzt einen Splitter davon, und der Rest fällt weg. Seit .NET 6 ist die Standard-Granularität Member-genau (`TrimMode=full`) und nicht mehr das alte Assembly-genaue `copyused`-Verhalten, sodass der Trimmer einzelne ungenutzte Methoden und Typen entfernt und nicht nur ganze, nicht referenzierte Assemblies. Das ist aggressiver und entfernt eher etwas, das Sie tatsächlich erreichen, auf eine Weise, die die Analyse nicht erkennen konnte.

Was die Analyse nicht erkennen kann, ist Reflection. Wenn Sie `type.GetMethods()` oder `Activator.CreateInstance(someType)` schreiben, hat der Trimmer keine Ahnung, welcher konkrete Typ zur Laufzeit hineinfließt, also kann er nicht wissen, welche Member er behalten muss. Er hat zwei schlechte Optionen: alles behalten, was möglicherweise dorthin fließen könnte (was Trimming zunichtemacht), oder nichts behalten und Sie zur Laufzeit mit einer `MissingMethodException` überraschen. Er tut keins von beidem. Stattdessen verlangt er, dass der reflektierende Code Annotationen trägt, die genau beschreiben, was er berührt, und er warnt überall dort, wo ein nicht annotierter Wert in einen Reflection-Aufruf fließt. Trim-sicherer Code ist Code, der diese Anforderungen erfüllt. Dieselben Regeln gelten für den [Native-AOT-Build, der Trimming verpflichtend macht](/de/2026/06/what-is-native-aot-and-what-does-it-cost-you/), also ist alles Folgende auch der Eintrittspreis für AOT.

## Schritt eins: Aktivieren Sie den Analyzer

Sie können keine Warnungen beheben, die Sie nicht sehen, und standardmäßig zeigt ein normaler Build keine an. Es gibt zwei Wege, sie sichtbar zu machen, und die Dokumentation empfiehlt beide, weil sie Unterschiedliches erfassen.

Für eine Anwendung, die Sie getrimmt veröffentlichen wollen, setzen Sie `PublishTrimmed` in der Projektdatei (nicht nur auf der Kommandozeile, damit es auch während `dotnet build` gilt):

```xml
<!-- .NET 11, C# 14. App project. Turns on the trimmer at publish and
     the trim-compat Roslyn analyzer during every build. -->
<PropertyGroup>
  <PublishTrimmed>true</PublishTrimmed>
</PropertyGroup>
```

Eine Bibliothek veröffentlichen Sie nicht, also aktivieren Sie stattdessen projektbezogene Analyse. `<IsTrimmable>true</IsTrimmable>` markiert die Assembly als trim-kompatibel und aktiviert Warnungen für dieses Projekt:

```xml
<!-- .NET 11, C# 14. Library project. Marks the assembly trimmable and
     emits trim warnings for this project's own code. -->
<PropertyGroup>
  <IsTrimmable>true</IsTrimmable>
</PropertyGroup>
```

Zwei Feinheiten sind hier wichtig. Erstens: Wenn Sie die Warnungen wollen, ohne zu versprechen, dass die Assembly trim-sicher ist (etwa, solange Sie sie noch abarbeiten), verwenden Sie `<EnableTrimAnalyzer>true</EnableTrimAnalyzer>` statt `IsTrimmable`. Es liefert dieselbe Analyse, ohne die Assembly als trimmbar zu stempeln. Zweitens: `IsTrimmable` ist standardmäßig `true`, wenn Sie `<IsAotCompatible>true</IsAotCompatible>` setzen, sodass eine AOT-kompatible Bibliothek Trim-Analyse erhält, egal ob Sie sie separat angefordert haben oder nicht.

Der Haken an der projektbezogenen Bibliotheksanalyse ist, dass sie nur Ihren Code plus die Reference Assemblies Ihrer Abhängigkeiten sieht, und Reference Assemblies tragen nicht genug Informationen, damit der Trimmer sie beurteilen kann. Um jede Warnung zu sehen, auch die, die daraus entstehen, wie Ihre Bibliothek ihre Abhängigkeiten nutzt, bauen Sie eine kleine Trimming-Test-App: ein Konsolenprojekt, das Ihre Bibliothek referenziert, `<PublishTrimmed>true</PublishTrimmed>` setzt und Ihre Bibliothek verankert, sodass das Ganze analysiert wird:

```xml
<!-- .NET 11. Trimming test app. Roots the library so ILLink walks every
     code path in it, not just the ones the console Main reaches. -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net11.0</TargetFramework>
    <PublishTrimmed>true</PublishTrimmed>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\MyLibrary\MyLibrary.csproj" />
    <TrimmerRootAssembly Include="MyLibrary" />
  </ItemGroup>
</Project>
```

Dann `dotnet publish -c Release -r linux-x64` und lesen Sie die Warnungen. `TrimmerRootAssembly` macht den Unterschied: ohne es analysiert der Trimmer nur die Aufrufe, die Ihr `Main` tatsächlich erreicht; mit ihm behandelt er die gesamte Bibliothek als Wurzel und durchläuft jeden Pfad.

## Die Warnungen lesen, die "noch nicht trim-sicher" bedeuten

Vier Warnungsfamilien decken fast alles ab, was Ihnen begegnet. Zu wissen, welche welche ist, verrät Ihnen die Lösung.

`IL2026` (`RequiresUnreferencedCode`) bedeutet, dass Sie eine Methode aufgerufen haben, die jemand bereits als trim-inkompatibel deklariert hat. `IL3050` (`RequiresDynamicCode`) ist das AOT-exklusive Geschwister: die Methode benötigt Laufzeit-Codegenerierung, die der JIT bereitstellen würde, AOT aber nicht kann. `IL2070`, `IL2075`, `IL2077` und der Rest der `IL207x`-Bande sind Datenfluss-Warnungen: ein nicht annotierter `Type` (aus einem Parameter, einem Feld, einem Rückgabewert) floss in einen Reflection-Aufruf, der ein `[DynamicallyAccessedMembers]`-Versprechen verlangt, und niemand hat das Versprechen gegeben. Behandeln Sie jede davon als echten Defekt, nicht als Analyzer-Rauschen. Der ganze Zweck des Analyzers ist es, eine stille, nur beim Veröffentlichen und manchmal nur in der Produktion auftretende `MissingMethodException` in eine Build-Zeit-Warnung zu verwandeln, die auf die exakte Zeile zeigt.

Ein Lesetipp. In .NET 6+ fasst der Trimmer alle internen Warnungen aus einer `PackageReference`-Assembly zu einer einzigen Warnung pro Assembly zusammen, damit Sie nicht in Rauschen aus einer Abhängigkeit ertrinken, die Sie nicht kontrollieren. Wenn Sie sie tatsächlich alle sehen wollen (Sie versuchen zu entscheiden, ob eine Abhängigkeit reparierbar ist), setzen Sie `<TrimmerSingleWarn>false</TrimmerSingleWarn>`, um sie aufzuklappen.

## IL207x beheben: annotieren Sie die Reflection, die Sie ausdrücken können

Die Datenfluss-Warnungen beheben Sie in Ihrem eigenen Code, und die Lösung hat immer dieselbe Form: geben Sie die Anforderung an der Stelle an, von der der `Type` kommt, sodass das Versprechen im Typsystem lebt. Nehmen Sie diesen Helfer, der warnt, weil `GetMethods()` verlangt, dass der Typ seine öffentlichen Methoden behält, der Parameter aber nichts verspricht:

```csharp
// .NET 11, C# 14. Warns IL2070: 'type' has no matching annotation.
using System.Diagnostics.CodeAnalysis;

static void UseMethods(Type type)
{
    foreach (var m in type.GetMethods()) { /* ... */ }
}
```

Kopieren Sie die Anforderung auf den Parameter:

```csharp
// .NET 11, C# 14. Clean: the parameter now carries the promise.
static void UseMethods(
    [DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.PublicMethods)] Type type)
{
    foreach (var m in type.GetMethods()) { /* ... */ }
}
```

Die Anforderung verschwindet nicht, sie wandert zu den Aufrufern und propagiert weiter nach außen, bis sie auf einem `typeof(Customer)` oder einem konkreten Typargument landet, wo der Trimmer schließlich genau weiß, was er behalten muss. Fordern Sie das Minimum an: wenn Sie nur `Activator.CreateInstance(type)` machen, verlangen Sie `PublicParameterlessConstructor`, nicht `All`. Jedes Flag, das Sie hinzufügen, sind Member, die der Trimmer nicht löschen darf, also Binärgröße, die Sie bezahlen. Das vollständige Flussmodell, samt der Annotation von Feldern, generischen Typparametern und Rückgabewerten, ist im [Tiefgang zu DynamicallyAccessedMembers](/de/2026/06/what-is-the-dynamicallyaccessedmembers-attribute/) behandelt; die Zusammenfassung in einem Satz lautet, dass das Attribut von sich aus nichts bewahrt, es propagiert eine Verpflichtung dorthin, wo der konkrete Typ entsteht.

## IL2026 beheben: stellen Sie die Reflection, die Sie nicht ausdrücken können, unter Quarantäne

Manchmal ist die Reflection tatsächlich nicht analysierbar. Sie laden einen Typ per Zeichenkette aus der Konfiguration, oder Sie durchlaufen `GetProperties()` über ein Objekt, dessen Typ erst zur Laufzeit bekannt ist. Da können Sie sich nicht heraus-annotieren, also deklarieren Sie die Methode mit `[RequiresUnreferencedCode]` als trim-inkompatibel und lassen die Warnung propagieren:

```csharp
// .NET 11, C# 14. Honest: this method reflects in a way trimming can break.
[RequiresUnreferencedCode("Serializes arbitrary types via reflection over their properties.")]
static string Serialize(object value)
{
    var sb = new StringBuilder();
    foreach (var p in value.GetType().GetProperties())
        sb.Append(p.Name).Append('=').Append(p.GetValue(value)).Append(';');
    return sb.ToString();
}
```

Das Attribut behebt nichts. Es verschiebt die `IL2026`-Warnung zu jedem Aufrufer von `Serialize`, genauso wie `[DynamicallyAccessedMembers]` seine Anforderung verschiebt, bis sie eine öffentliche API-Grenze erreicht, an der der Bibliotheksautor die Einschränkung dokumentiert und die Propagation stoppt. Das ist das korrekte Ergebnis für Code, der wirklich nicht trim-sicher ist: statt eines stillen Laufzeitfehlers erhält der Aufrufer eine Warnung zur Kompilierzeit, die ihm sagt, dass dieser Pfad unter Trimming unsicher ist, und er kann entscheiden, ob er ihn vermeidet. Das ist auch der Grund, warum sauberes Propagieren an öffentliche APIs wichtig ist, denn es unterdrückt die pauschale `IL2104: Assembly produced trim warnings` und gibt den Konsumenten präzise, methoden-genaue Signale.

Wenn das Muster überwiegend Reflection ist, annotieren Sie sich nicht Aufruf für Aufruf darum herum. Das ist das Signal, es durch Codegenerierung zur Kompilierzeit zu ersetzen. Reflection-basierte Serializer und Mapper sind das kanonische Beispiel: statt einen `GetProperties()`-Durchlauf zu annotieren, greifen Sie zu einem [Source Generator](/de/2026/06/what-is-a-source-generator-and-when-do-i-need-one/), der den Zugriffscode zur Build-Zeit erzeugt, was genau der Grund ist, warum es das Source-generierte `System.Text.Json` gibt und warum es der empfohlene Weg für AOT ist.

## Die Notausgänge und wann sie eine Falle sind

Zwei Attribute lassen Sie Warnungen zum Schweigen bringen, ohne den Code zu ändern, und beide sind scharf.

`[UnconditionalSuppressMessage]` bringt eine bestimmte Warnung zum Schweigen und wird, anders als das schlichte `[SuppressMessage]`, im IL persistiert, sodass die Trim-Analyse es respektiert. Verwenden Sie es nur, wenn der Datenfluss echt und korrekt ist, der Analyzer ihm aber nicht folgen kann, zum Beispiel ein `Type[]`, dessen jedes Element bauartbedingt seinen Konstruktor behält:

```csharp
// .NET 11, C# 14. Valid only because the setter guarantees the invariant.
[UnconditionalSuppressMessage("ReflectionAnalysis", "IL2063",
    Justification = "The array only holds types stored through the annotated setter.")]
get => _types[i];
```

Die Dokumentation ist unverblümt beim Fehlermodus: eine Unterdrückung ist nur gültig, wenn die reflektierten Member anderswo im Programm echte Reflection-Ziele sind. Ein Member, der nicht-reflektiv genutzt wird (ein normaler Methodenaufruf), ist kein gültiges Unterdrückungsziel, denn der Optimierer darf ihn inlinen, umbenennen oder verschieben, und Ihre unterdrückte Reflection bricht dann ohne Warnung, die Sie warnen könnte. Das Unterdrücken nach dem Motto "die Eigenschaft wird von der App genutzt, also muss sie da sein" ist genau das ungültige Muster, das die Dokumentation anprangert.

`[DynamicDependency]` ist das letzte Mittel. Es behält benannte Member, informiert aber die Analyse nicht, also bringt es von sich aus keine Warnungen zum Schweigen und wird zusammen mit einer Unterdrückung verwendet. Greifen Sie nur dann dazu, wenn selbst `[DynamicallyAccessedMembers]` das Muster nicht ausdrücken kann, etwa das Laden eines Members per Zeichenkette aus einer separaten Assembly:

```csharp
// .NET 11, C# 14. Last resort. Keeps Helper so the reflection below finds it.
[DynamicDependency("Helper", "MyType", "MyAssembly")]
static void RunHelper()
{
    var helper = Assembly.Load("MyAssembly").GetType("MyType").GetMethod("Helper");
    helper.Invoke(null, null);
}
```

Wenn Sie feststellen, dass Sie eines der beiden Attribute über viele Aufrufstellen verstreuen, ist das keine Trim-Sicherheits-Lösung, es ist ein Design-Geruch, der Ihnen sagt, dass die API grundlegend Reflection-förmig ist und stattdessen zur Build-Zeit generiert werden sollte.

## Framework-Feature-Switches: Code trimmen, den Sie nie aufrufen

Nicht alles an Trim-Sicherheit dreht sich um Ihre Reflection. Ein Teil des Frameworks wird mit Trimmer-Direktiven hinter Feature-Switches ausgeliefert, sodass Sie dem Trimmer sagen können, ganze Feature-Bereiche zu entfernen, die Sie nicht nutzen. Diese dienen doppelt als Laufzeitkonfiguration und als Trimming-Anweisungen. Ein paar, die man kennen sollte: `<EventSourceSupport>false</EventSourceSupport>` verwirft die EventSource-Verkabelung, `<UseSystemResourceKeys>true</UseSystemResourceKeys>` reduziert vollständige Ausnahme-Meldungstexte aus `System.*`-Assemblies auf Ressourcen-IDs, `<InvariantGlobalization>true</InvariantGlobalization>` entfernt Globalisierungsdaten, und `<StackTraceSupport>false</StackTraceSupport>` (.NET 8+) entfernt die Laufzeit-Stack-Trace-Generierung. .NET 10 fügte `<UseSizeOptimizedLinq>true</UseSizeOptimizedLinq>` hinzu, was etwas LINQ-Durchsatz gegen kleinere Ausgabe tauscht und unter `PublishAot` der Standard ist. Diese machen Ihren Code nicht analysierbar; es geht darum, nicht in Binärgröße für Framework-Funktionen zu bezahlen, die Sie nie anfassen. Aktivieren Sie sie bewusst, denn jede davon entfernt echtes Verhalten.

## Der Arbeitsablauf, der Sie tatsächlich zur Trim-Sicherheit bringt

Das mentale Modell, das all dies zusammenhält: Trim-Sicherheit ist kein Schalter, sie ist ein Build-Zustand, den Sie verteidigen. Aktivieren Sie den Analyzer (`PublishTrimmed` für Apps, `IsTrimmable` plus eine verankerte Test-App für Bibliotheken). Lesen Sie die Warnungen und sortieren Sie sie: `IL207x` beheben Sie, indem Sie die Quelle des `Type` mit den minimalen `DynamicallyAccessedMembers`-Flags annotieren; `IL2026`/`IL3050` annotieren Sie entweder mit `[RequiresUnreferencedCode]` und propagieren an eine öffentliche API, oder Sie ersetzen die Reflection durch einen Source Generator; die beiden Notausgänge verwenden Sie nur, wenn eine Invariante echt ist und der Analyzer sie wirklich nicht sehen kann. Treiben Sie die Zahl auf null und halten Sie sie dort, denn das Einführen einer neuen Trim-Warnung ist eine Breaking Change für jeden, der Ihre Bibliothek getrimmt veröffentlicht, und ein Abhängigkeits-Update kann eine wieder einschleusen, ohne API-Änderung auf Ihrer Seite. Wenn ein unsicherer Aufruf am Analyzer vorbeirutscht und erst zur Laufzeit fehlschlägt, sind Sie zurück beim Debuggen einer [PlatformNotSupportedException in Native AOT](/de/2026/05/fix-platformnotsupportedexception-in-native-aot/), was genau der Fehler ist, den der warnungsfreie Build verhindern soll. Und wenn das Ziel ein echter Webdienst ist, zeigt die [Anleitung zu Native AOT mit ASP.NET Core Minimal APIs](/de/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) das Sauber-Build-Rezept von Anfang bis Ende. Trim-sicherer Code ist kein spezieller C#-Dialekt; er ist gewöhnliches C#, das die Erreichbarkeitsanalyse des Trimmers ehrlich hält, und der Analyzer ist das Werkzeug, das Ihnen zur Build-Zeit sagt, ob Sie das getan haben.

## Verwandt

- [Was ist Native AOT und was kostet es Sie?](/de/2026/06/what-is-native-aot-and-what-does-it-cost-you/) erklärt, warum Trimming unter AOT verpflichtend ist und was Sie sonst noch eintauschen.
- [Was ist das DynamicallyAccessedMembers-Attribut?](/de/2026/06/what-is-the-dynamicallyaccessedmembers-attribute/) ist der Tiefgang zur Annotation, die die IL207x-Datenfluss-Warnungen behebt.
- [Was ist ein Source Generator und wann brauche ich einen?](/de/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) behandelt die Codegenerierung zur Kompilierzeit, die Reflection ersetzt, die Sie nicht annotieren können.
- [Native AOT mit ASP.NET Core Minimal APIs verwenden](/de/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) ist die Sauber-Build-Anleitung, in der diese Warnungen in einer echten App auftauchen.
- [Beheben: PlatformNotSupportedException in Native AOT](/de/2026/05/fix-platformnotsupportedexception-in-native-aot/) ist der Laufzeitfehler, den ein warnungsfreier Trim-Build verhindert.

## Quellen

- [Prepare .NET libraries for trimming](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/prepare-libraries-for-trimming), MS Learn (IsTrimmable, EnableTrimAnalyzer, das Test-App-Muster, RequiresUnreferencedCode, DynamicallyAccessedMembers, UnconditionalSuppressMessage, DynamicDependency).
- [Trimming options](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/trimming-options), MS Learn (PublishTrimmed, TrimmerSingleWarn, ILLinkTreatWarningsAsErrors, die Feature-Switch-Tabelle).
- [Trim self-contained deployments and executables](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/trim-self-contained), MS Learn (TrimMode-Granularität und wie Erreichbarkeits-Trimming funktioniert).
- [Introduction to trim warnings](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/fixing-warnings), MS Learn (der IL2026/IL3050/IL207x-Warnungskatalog und das Datenfluss-Modell).
