---
title: "Was ist ein Source Generator und wann brauche ich einen?"
description: "Ein verständlicher Leitfaden zu C# Source Generators: was sie tatsächlich tun, wie das IIncrementalGenerator-Pipeline funktioniert, wann sie Reflexion oder T4 schlagen und in welchen Fällen Sie nicht zu einem greifen sollten. Mit lauffähigen Beispielen auf .NET 11 und C# 14."
pubDate: 2026-06-19
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "source-generators"
  - "roslyn"
lang: "de"
translationOf: "2026/06/what-is-a-source-generator-and-when-do-i-need-one"
translatedBy: "claude"
translationDate: 2026-06-19
---

Ein Source Generator ist ein Stück Code, das der C#-Compiler ausführt, während er Ihr Projekt kompiliert, und das Ihren Code lesen und derselben Kompilierung neue C#-Dateien hinzufügen kann. Er läuft zur Kompilierzeit, erzeugt gewöhnlichen Quellcode, den der Compiler anschließend kompiliert, als hätten Sie ihn selbst geschrieben, und verursacht außer dem ausgegebenen Code keine Laufzeitkosten. Sie brauchen einen, wenn Sie andernfalls zur Laufzeit für Reflexion bezahlen, repetitiven Boilerplate von Hand schreiben oder einen separaten Code-Generierungsschritt außerhalb des Builds ausführen würden, und Sie möchten, dass der generierte Code stark typisiert, debugbar, trim-fähig und Native-AOT-tauglich ist. Wenn Sie keines dieser Probleme haben, brauchen Sie mit ziemlicher Sicherheit keinen Generator zu schreiben. Dieser Leitfaden behandelt .NET 11 (preview 5) und C# 14, doch die Mechanik gilt für jedes Projekt ab .NET 6.

## Was "läuft im Compiler" tatsächlich bedeutet

Der meiste Code, den Sie schreiben, läuft nach dem Build, wenn die Anwendung startet. Ein Source Generator ist anders: Er ist eine Roslyn-Komponente, die der Compiler als Analyzer lädt und während der Kompilierung aufruft. Er erhält eine schreibgeschützte Sicht auf alles, was Roslyn bis dahin über Ihr Projekt weiß (Syntaxbäume, semantische Symbole, Referenzen, zusätzliche Dateien), und seine einzige Ausgabe ist weiterer Quellcode. Er kann Ihre vorhandenen Dateien nicht umschreiben, keinen Code löschen und nichts ändern, was Sie bereits geschrieben haben. Er kann nur hinzufügen.

Diese "Nur-Hinzufügen"-Einschränkung ist das gesamte Design. Der generierte Code geht als zusätzliche Dateien in die Kompilierung ein, und das vorherrschende Muster ist das `partial`-Element: Sie schreiben die Hälfte einer Klasse von Hand, markieren sie als `partial`, und der Generator gibt die andere Hälfte aus. Beide Hälften werden zu einem einzigen Typ kompiliert. Da die Ausgabe echtes C# ist, das zu echtem IL wird, behandelt alles Nachgelagerte sie wie von Ihnen geschriebenen Code: IntelliSense sieht ihn, der Debugger springt hinein, der Linker kann ihn trimmen, und Native AOT kann ihn vorab kompilieren. Es gibt keine Laufzeit-Reflexion, kein `Reflection.Emit`, keinen dynamischen Proxy.

Das ist das zentrale mentale Modell. Ein Source Generator ist kein Makrosystem und kein Post-Build-Skript. Er ist eine Funktion zur Kompilierzeit von "Ihrem Code" zu "mehr von Ihrem Code".

## Warum er die Alternativen schlägt, die er ersetzt

Vor Source Generators (eingeführt in .NET 5, Roslyn 3.8) waren die drei Wege, das Schreiben von Boilerplate von Hand zu vermeiden, Reflexion, IL-Emission und externe Codegeneratoren wie T4-Templates. Jeder davon hat reale Kosten, die ein Source Generator beseitigt.

Laufzeit-Reflexion (denken Sie an klassische JSON-Serializer, Dependency-Injection-Container, Objekt-Mapper) inspiziert Typen beim Start und interpretiert sie entweder bei jedem Aufruf oder baut einmal eine dynamische Methode und legt sie im Cache ab. Das funktioniert, kostet aber eine Startabgabe, ist für den Trimmer unsichtbar (bläht also getrimmte und AOT-Builds auf oder bricht sie ganz) und die Kosten landen bei Ihren Nutzern, nicht bei Ihrem Build. Eine `System.InvalidOperationException` oder eine `System.PlatformNotSupportedException` aus der Reflexion taucht erst zur Laufzeit auf, oft in der Produktion. Genau diesen Fehlermodus haben wir in [warum reflexionslastiger Code unter Native AOT bricht](/de/2026/05/fix-platformnotsupportedexception-in-native-aot/) behandelt.

T4 und andere externe Generatoren laufen als separater Schritt, meist über ihr eigenes Tooling in den Build eingebunden. Sie können das semantische Modell nicht sehen (sie parsen Text, keine Symbole), die generierten Dateien liegen auf der Festplatte und geraten außer Takt, und in CI sind sie umständlich. Source Generators laufen innerhalb derselben Kompilierung, sehen vollständig aufgelöste Symbole und schreiben niemals eine veraltete Datei in Ihr Repository.

Ein Source Generator verlagert all diese Arbeit auf die Kompilierzeit und gibt schlichtes, statisch kompiliertes C# aus. Der Serializer reflektiert beim Start nicht über Ihren Typ; er hat bereits den exakten Code, um ihn zu lesen und zu schreiben. Deshalb ist der eingebaute Source Generator von `System.Text.Json` der einzige JSON-Weg, der unter Native AOT funktioniert, ein Punkt, den wir in [System.Text.Json vs Newtonsoft.Json im Jahr 2026](/de/2026/05/system-text-json-vs-newtonsoft-json-in-2026/) gemacht haben.

## Die Generatoren, die Sie bereits nutzen

Sie müssen keinen schreiben, um vom Konzept zu profitieren. Modernes .NET bringt mehrere mit, und sie zu erkennen sagt Ihnen, für welche Art von Problem Generatoren gut sind:

- Die Source-Generierung von `System.Text.Json` (`[JsonSerializable]` + ein `JsonSerializerContext`) gibt Serialisierungscode aus, sodass STJ zur Laufzeit nie reflektiert.
- Die Source-Generierung von `LoggerMessage` (`[LoggerMessage]`) verwandelt eine partielle Methode in einen allokationsfreien, stark typisierten Logging-Aufruf.
- `GeneratedRegex` (`[GeneratedRegex]`) kompiliert Ihr Regex-Muster zur Kompilierzeit nach C#, statt beim ersten Einsatz eine Zustandsmaschine zu bauen.
- `System.Text.Json`, `Microsoft.Extensions.Configuration` und der Options-Binder haben Generatoren, die das reflexionsbasierte Binding ersetzen.
- `CommunityToolkit.Mvvm` generiert die `INotifyPropertyChanged`-Verkabelung aus `[ObservableProperty]`.
- `Mapperly` generiert das Objekt-zu-Objekt-Mapping zur Kompilierzeit, die Grundlage unserer [Migration von AutoMapper zu source-generiertem Mapping](/de/2026/05/migrate-from-automapper-to-source-generated-mapping/).

Die gemeinsame Form: Nimm einen deklarativen Marker (ein Attribut, eine partielle Methode, eine partielle Klasse) und gib den mühsamen, fehleranfälligen, reflexionsförmigen Code aus, der sonst von Hand geschrieben oder zur Laufzeit ermittelt würde.

## Wie ein Generator gebaut wird: die inkrementelle Pipeline

Es gibt zwei Generator-Schnittstellen, und nur eine ist aktuell. Die ursprüngliche `ISourceGenerator` (ein `Initialize`/`Execute`-Paar, das die gesamte Kompilierung erhielt und bei jedem Tastendruck lief) ist veraltet. Der Roslyn-Quellcode sagt das ausdrücklich: "ISourceGenerator is deprecated and should not be implemented. Please implement IIncrementalGenerator instead." (siehe den [Veraltungshinweis zu ISourceGenerator in dotnet/roslyn](https://github.com/dotnet/roslyn/blob/main/src/Compilers/Core/Portable/SourceGeneration/ISourceGenerator.cs)). Für alles Neue verwenden Sie `IIncrementalGenerator`.

Der Grund ist die Leistung in der IDE. Ein inkrementeller Generator berechnet nicht bei jedem Lauf alles von Grund auf neu. Sie deklarieren eine Pipeline, einen Graphen von Transformationsschritten, und Roslyn legt die Ausgabe jedes Schritts im Cache ab. Wenn sich die Eingaben eines Schritts seit dem letzten Tastendruck nicht geändert haben, überspringt Roslyn diesen Schritt und verwendet das im Cache liegende Ergebnis wieder. Das macht es sicher, einen Generator hunderte Male pro Minute neu laufen zu lassen, während Sie tippen.

Hier ist ein minimaler, aber vollständiger Generator. Er findet Klassen, die mit `[AutoToString]` markiert sind, und gibt einen `ToString()`-Override aus, der die öffentlichen Eigenschaften auflistet.

```csharp
// Generator project: netstandard2.0, references Microsoft.CodeAnalysis.CSharp
// .NET 11 preview 5, Roslyn 4.x, C# 14
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

[Generator]
public sealed class AutoToStringGenerator : IIncrementalGenerator
{
    public void Initialize(IncrementalGeneratorInitializationContext context)
    {
        // 1. Cheap syntactic filter, then a semantic transform into a small,
        //    value-equatable model. Returning a record (not a symbol) is what
        //    lets Roslyn cache this step and skip work when nothing changed.
        var classes = context.SyntaxProvider.ForAttributeWithMetadataName(
            "AutoToStringAttribute",
            predicate: static (node, _) => node is ClassDeclarationSyntax,
            transform: static (ctx, _) =>
            {
                var symbol = (INamedTypeSymbol)ctx.TargetSymbol;
                var props = symbol.GetMembers()
                    .OfType<IPropertySymbol>()
                    .Where(p => p.DeclaredAccessibility == Accessibility.Public)
                    .Select(p => p.Name)
                    .ToImmutableArray();
                return new Model(symbol.ContainingNamespace.ToDisplayString(),
                                 symbol.Name, props);
            });

        // 2. Emit one source file per matched class.
        context.RegisterSourceOutput(classes, static (spc, model) =>
        {
            var sb = new StringBuilder();
            sb.AppendLine($"namespace {model.Namespace};");
            sb.AppendLine($"partial class {model.Name}");
            sb.AppendLine("{");
            sb.AppendLine("    public override string ToString() =>");
            var body = string.Join(" + \", \" + ",
                model.Properties.Select(p => $"\"{p}=\" + {p}"));
            sb.AppendLine($"        {body};");
            sb.AppendLine("}");
            spc.AddSource($"{model.Name}.AutoToString.g.cs", sb.ToString());
        });
    }

    private record Model(string Namespace, string Name,
                         ImmutableArray<string> Properties);
}
```

Die Verbraucherseite ist nur ein Attribut und eine `partial class`:

```csharp
// Consumer project, C# 14
[AutoToString]
public partial class Order
{
    public int Id { get; set; }
    public string Customer { get; set; } = "";
}

// Elsewhere: new Order { Id = 7, Customer = "Acme" }.ToString()
// => "Id=7, Customer=Acme"   (the ToString override is generated)
```

Zwei Details tragen den Großteil des Gewichts. Erstens ist `ForAttributeWithMetadataName` der schnelle Einstiegspunkt, der in Roslyn 4.3 hinzugefügt wurde: Er lässt Roslyn auf die Knoten vorfiltern, die Ihr Attribut tatsächlich tragen, statt jeden Syntaxknoten zu durchlaufen, was der größte Leistungshebel in einem echten Generator ist. Zweitens gibt das `transform` einen kleinen `record` (`Model`) zurück, nicht das `INamedTypeSymbol`. Das ist wichtiger, als es aussieht: Inkrementalität hängt von Wertgleichheit ab. Wie das Roslyn-Cookbook sagt, sollen wertgleichheitsfähige Typen wie `record`, `struct`, Tupel und `ImmutableArray<T>` durch die Pipeline fließen, denn sobald ein Schritt einen Wert zurückgibt, der seiner vorherigen Ausgabe gleicht, hält Roslyn an und verwendet das nachgelagerte, im Cache liegende Ergebnis wieder. Geben Sie ein `Symbol` oder eine `Compilation` durch die Pipeline weiter, hebeln Sie das Caching vollständig aus, denn diese Typen sind groß, referenzgleich und ändern sich bei jedem Tastendruck.

## Wann Sie zu einem greifen sollten

Schreiben oder übernehmen Sie einen Source Generator, wenn all dies zutrifft:

1. Der Code ist mechanisch und aus etwas ableitbar, das bereits im Quellcode steht (die Form eines Typs, ein Attribut, eine Methodensignatur). Wenn ein Mensch, der ihn schriebe, nur abschreiben würde, kann ein Generator es übernehmen.
2. Sie zahlen derzeit mit Laufzeit-Reflexion dafür, und diese Kosten sind real: Startlatenz, Allokationen auf einem heißen Pfad oder eine Trimming-/AOT-Inkompatibilität.
3. Sie möchten, dass das Ergebnis debugbar und statisch typisiert ist, nicht eine dynamische Methode, in die Sie nicht hineinspringen können.

Die klarsten Gewinne: Serialisierung, DTO-Mapping, Dependency-Injection-Registrierung, `INotifyPropertyChanged`, stark typisiertes Konfigurations-Binding, Generierung von Clients aus einem Vertrag und das Ersetzen jedes heißen Pfads mit `Activator.CreateInstance` oder `Expression.Compile`. Wenn Sie Native AOT anvisieren, kippt die Rechnung noch stärker zu Generatoren, denn reflexionsbasierte Ansätze sind genau das, was dort bricht. Diese Einschränkung haben wir in [Native AOT mit ASP.NET Core Minimal APIs verwenden](/de/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) durchgegangen.

## Wann Sie keinen brauchen (und keinen schreiben sollten)

Generatoren sind weder im Bau noch in der Wartung kostenlos. Verzichten Sie darauf, einen eigenen zu schreiben, wenn:

- Bereits ein gut getesteter Generator existiert. Implementieren Sie `CommunityToolkit.Mvvm`, Mapperly oder den STJ-Kontext-Generator nicht zum Spaß neu. Nutzen Sie sie. Die [Anleitung zum INotifyPropertyChanged-Generator](/de/2026/04/how-to-write-a-source-generator-for-inotifypropertychanged/) existiert, um die Roslyn-API zu lehren, nicht um dafür zu plädieren, dass Sie Ihr eigenes MVVM-Toolkit veröffentlichen.
- Die Wiederholung klein oder einmalig ist. Eine Handvoll ähnlicher Klassen ist kein Grund, ein `netstandard2.0`-Analyzer-Projekt, einen separaten Test-Harness und eine Debugging-Geschichte auf sich zu nehmen, die das Anhängen eines zweiten Compilers umfasst.
- Sie tatsächlich vorhandenen Code transformieren oder umschreiben müssen. Generatoren können nur hinzufügen. Wenn Sie Verhalten in Methoden einschleusen wollen, die Sie nicht geschrieben haben, sind das Interceptors (ein eigenständiges C#-14-Feature) oder ein Post-Compile-IL-Weaver wie Fody, kein Source Generator.
- Die Form wirklich dynamisch ist, zur Laufzeit aus Daten entschieden, die der Compiler nicht sehen kann (eine beim Start gelesene Konfigurationsdatei, ein von der Festplatte geladenes Plugin). Der Compiler weiß nichts vom Laufzeitzustand, also kann ein Generator nicht helfen.
- Ein einfacher generischer Typ `T`, eine Basisklasse oder eine schlichte Hilfsmethode ausreichen würde. Greifen Sie zuerst zur Sprache. Generatoren sind für die Fälle, in denen die Sprache die Abstraktion nicht ohne typweisen Boilerplate ausdrücken kann.

Der ehrliche Standard für die meisten Teams lautet: Generatoren großzügig konsumieren, eigene selten schreiben.

## Die Fallstricke, die zuerst zuschlagen

Ein paar Dinge bringen beim ersten Mal jeden ins Stolpern:

- Das Generator-Projekt muss auf `netstandard2.0` zielen. Das ist nach wie vor der Vertrag, den Roslyn für Analyzer verlangt, ganz gleich, worauf Ihre Anwendung zielt. Sie schreiben den Generator auf einer älteren Sprachoberfläche als den Code, den er ausgibt.
- Referenzieren Sie ihn als Analyzer, nicht als normale Abhängigkeit: `<ProjectReference Include="..\Gen.csproj" OutputItemType="Analyzer" ReferenceOutputAssembly="false" />`. Machen Sie das falsch, läuft der Generator entweder nicht oder gelangt in Ihre Laufzeitausgabe.
- Generierter Code ist additiv, und Sie sehen ihn standardmäßig nicht. Setzen Sie `<EmitCompilerGeneratedFiles>true</EmitCompilerGeneratedFiles>` im verbrauchenden Projekt, um die `.g.cs`-Dateien unter `obj/` abzulegen, damit Sie lesen können, was tatsächlich ausgegeben wurde. Das ist das Erste, was zu tun ist, wenn die Ausgabe falsch aussieht.
- Legen Sie weder `Compilation`, `ISymbol` noch `SyntaxNode` in das Datenmodell der Pipeline. Sie sind nicht wertgleichheitsfähig und töten die Inkrementalität, was Ihren Generator wieder in das langsame `ISourceGenerator`-Verhalten verwandelt, das Sie vermeiden wollten. Projizieren Sie sie früh in Records.
- Werfen Sie niemals eine Ausnahme aus einem Generator. Eine Ausnahme wird zu einer Build-Warnung (`CS8785`), und Ihr Code wird stillschweigend nicht generiert. Behandeln Sie den Fall "Attribut vorhanden, aber Typ fehlerhaft", indem Sie eine Diagnose ausgeben, nicht indem Sie abstürzen.
- Ein Generator läuft bei jedem Build des verbrauchenden Projekts, auch in der IDE bei jeder Bearbeitung. Ein langsamer oder nicht inkrementeller Generator lässt den gesamten Editor träge wirken. Das ist nicht theoretisch; es ist der Grund, warum die inkrementelle API existiert.

Die mentale Abkürzung, die Sie aus dem Schlamassel hält: Ein Source Generator ist eine reine, im Cache liegende Funktion von unveränderlichen Eingaben zu Quelltext. Halten Sie die Eingaben klein und wertgleichheitsfähig, halten Sie die Funktion schnell, lassen Sie sie niemals werfen, und schreiben Sie nur dann einen, wenn Reflexion oder von Hand geschriebener Boilerplate Sie etwas Messbares kostet.

## Quellen und weiterführende Literatur

- [Inkrementelle Generatoren, dotnet/roslyn-Dokumentation](https://github.com/dotnet/roslyn/blob/main/docs/features/incremental-generators.md)
- [Cookbook zu inkrementellen Generatoren, dotnet/roslyn](https://github.com/dotnet/roslyn/blob/main/docs/features/incremental-generators.cookbook.md)
- [Veraltungshinweis zu ISourceGenerator, dotnet/roslyn-Quellcode](https://github.com/dotnet/roslyn/blob/main/src/Compilers/Core/Portable/SourceGeneration/ISourceGenerator.cs)
- [Überblick über Source Generators, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/roslyn-sdk/source-generators-overview)
