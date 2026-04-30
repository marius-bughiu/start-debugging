---
title: "Wie Sie einen Source Generator für INotifyPropertyChanged schreiben"
description: "Eine vollständige Anleitung zum Bau eines eigenen inkrementellen Source Generators für INotifyPropertyChanged in C# 14 und .NET 11: die IIncrementalGenerator-Pipeline, Marker-Attribute, partial class-Ausgabe, das SetProperty-Muster und wie Sie AOT-freundlich bleiben."
pubDate: 2026-04-30
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "source-generators"
  - "mvvm"
lang: "de"
translationOf: "2026/04/how-to-write-a-source-generator-for-inotifypropertychanged"
translatedBy: "claude"
translationDate: 2026-04-30
---

Um `INotifyPropertyChanged` (INPC) selbst zu generieren, schreiben Sie einen `IIncrementalGenerator`, der Klassen findet, die mit einem benutzerdefinierten Attribut markiert sind, deren mit `[ObservableProperty]` annotierte Felder liest und eine `partial class` ausgibt, die die Schnittstelle implementiert, Wrapper-Eigenschaften bereitstellt und `PropertyChanged` über einen `SetProperty`-Helper auslöst. Der Generator läuft zur Compile-Zeit, verursacht keinerlei Laufzeitkosten über die standardmäßige INPC-Verdrahtung hinaus und entfernt jede Zeile handgeschriebenen Boilerplates aus Backing-Field und Setter. Diese Anleitung baut den Generator von Anfang bis Ende auf .NET 11 (preview 3) und C# 14, aber derselbe Code funktioniert für jeden Konsumenten, der den Analyzer auf `netstandard2.0` ausrichtet, da das immer noch der Vertrag ist, den Roslyn für Source Generators verlangt.

## Warum Sie einen eigenen schreiben, wenn CommunityToolkit.Mvvm existiert

Die bekannte Antwort lautet `CommunityToolkit.Mvvm`, das `[ObservableObject]`, `[ObservableProperty]`, `[NotifyPropertyChangedFor]` und einen kleinen Berg gut getesteter Generatoren liefert. Für die meisten Apps nehmen Sie das. Diese Anleitung ist für die Fälle, in denen Sie es nicht können:

- Sie benötigen einen Generator, der eine andere Schnittstelle ausgibt, etwa `IObservableObject` aus einem hauseigenen Framework oder einen herstellerspezifischen Benachrichtigungsvertrag.
- Sie möchten INPC mit zusätzlichem Verhalten kombinieren, das das Toolkit nicht abdeckt (Audit-Logging, Dirty Tracking, Coercion durch eine Domänenregel).
- Sie bauen ein Lernartefakt, ein internes Hausframework oder einen Generator, der neben `CommunityToolkit.Mvvm` leben muss, ohne bei den Attributnamen zu kollidieren.
- Sie möchten das Toolkit verstehen, bevor Sie ihm vertrauen.

Source Generators sind außerdem einer der saubersten Orte, um Roslyn-APIs aus erster Hand zu berühren, und INPC ist das kanonische Ziel "klein, gut definiert, hohe Hebelwirkung". Wenn Sie noch nie einen geschrieben haben, ist dies ein besserer Ausgangspunkt, als zu versuchen, Code für die Registrierung von Dependency Injection oder EF Core-Konfiguration zu generieren.

## Die Teile, die Sie liefern müssen

Ein vollständiger INPC-Generator hat drei Teile, jeder in seinem eigenen Projekt oder seiner `<None>`-Injektion:

1. Ein **Marker-Attribut**, das Konsumenten auf eine `partial class` anwenden. Konvention: `[Observable]` oder `[GenerateInpc]`.
2. Ein **Attribut auf Feldebene**, das den zugrunde liegenden Zustand markiert, den der Generator als Eigenschaft bereitstellen soll. Konvention: `[ObservableProperty]`.
3. Den **inkrementellen Generator** selbst, so verpackt, dass MSBuild ihn als Analyzer lädt.

Das Marker-Attribut wird am einfachsten über `RegisterPostInitializationOutput` geliefert, das es dem Generator erlaubt, den Attribut-Quellcode in die Compilation des Konsumenten zu injizieren. So fügen Konsumenten eine `<ProjectReference>` (oder eine `<PackageReference>` mit `OutputItemType="Analyzer"`) hinzu und haben sofort die Attribute verfügbar, ohne separate Runtime-DLL.

## Projekt-Layout

Das Analyzer-Projekt muss `netstandard2.0` ansprechen, denn das ist das einzige TFM, das Roslyn in der IDE und im .NET Framework-MSBuild lädt, das ältere Visual Studio-Installationen verwenden:

```xml
<!-- src/Inpc.SourceGenerator/Inpc.SourceGenerator.csproj -->
<!-- .NET 11 SDK, generator targets netstandard2.0 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>netstandard2.0</TargetFramework>
    <LangVersion>latest</LangVersion>
    <Nullable>enable</Nullable>
    <IsRoslynComponent>true</IsRoslynComponent>
    <EnforceExtendedAnalyzerRules>true</EnforceExtendedAnalyzerRules>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Microsoft.CodeAnalysis.CSharp"
                      Version="4.13.0"
                      PrivateAssets="all" />
  </ItemGroup>
</Project>
```

`IsRoslynComponent` veranlasst Visual Studio, ihn als Generator für das Laden zur Designzeit zu behandeln. `EnforceExtendedAnalyzerRules` ist das Analyzer-Regelwerk, das Fehler wie `string.Format` mit Kulturproblemen innerhalb von Generatoren markiert, wo Reproduzierbarkeit zählt.

Das Konsumentenprojekt referenziert ihn als Analyzer:

```xml
<!-- consumer .csproj -->
<ItemGroup>
  <ProjectReference Include="..\Inpc.SourceGenerator\Inpc.SourceGenerator.csproj"
                    OutputItemType="Analyzer"
                    ReferenceOutputAssembly="false" />
</ItemGroup>
```

`ReferenceOutputAssembly="false"` ist kritisch: Sie wollen die Analyzer-DLL **nicht** auf dem Laufzeit-Pfad des Konsumenten haben. Wenn Sie das vergessen, liefert der Konsument Roslyn zur Laufzeit aus, das mehrere Megabyte Totlast bedeutet und Native AOT bricht.

## Das Marker-Attribut, in Post-Init injiziert

Registrieren Sie innerhalb des Generators die Attributquelle, bevor irgendeine Analyse läuft. Das garantiert, dass Konsumenten die Attribute ohne separates Paket nutzen können:

```csharp
// .NET 11, C# 14, generator-side code (netstandard2.0)
using Microsoft.CodeAnalysis;

[Generator]
public sealed class InpcGenerator : IIncrementalGenerator
{
    private const string AttributeSource = """
        // <auto-generated/>
        #nullable enable
        namespace Inpc;

        [global::System.AttributeUsage(
            global::System.AttributeTargets.Class, Inherited = false)]
        internal sealed class ObservableAttribute : global::System.Attribute { }

        [global::System.AttributeUsage(
            global::System.AttributeTargets.Field, Inherited = false)]
        internal sealed class ObservablePropertyAttribute : global::System.Attribute
        {
            public string? PropertyName { get; init; }
        }
        """;

    public void Initialize(IncrementalGeneratorInitializationContext context)
    {
        context.RegisterPostInitializationOutput(ctx =>
            ctx.AddSource("Inpc.Attributes.g.cs", AttributeSource));

        // pipeline registration follows in the next section
    }
}
```

Einige nicht offensichtliche Entscheidungen:

- Die Attribute sind `internal`. Jedes konsumierende Assembly bekommt seine eigene Kopie über Post-Init. Das heißt, zwei Assemblies können beide `[Observable]` verwenden ohne `TypeForwardedTo`-Spielereien oder Versionskonflikte. Der Preis: Die Attribute überleben keine Assembly-Grenzen, was in Ordnung ist, weil der Generator sie nur zur Compile-Zeit braucht.
- Jede Typreferenz verwendet das Präfix `global::`. Generierter Code landet in beliebigen Namespaces, einschließlich solcher, die zufällig `System` oder `Inpc` heißen. Ohne `global::` kann die Namensauflösung den falschen Typ wählen, und die generierte Datei wird nicht kompiliert.
- Der Header-Kommentar `// <auto-generated/>` unterdrückt Analyzer-Warnungen aus `EditorConfig`-Regeln und StyleCop.

## Die inkrementelle Pipeline

Verdrahten Sie nun die eigentliche Analyse. Roslyns Incremental Generator-API hat zwei Hälften: einen `SyntaxProvider`, der bei jedem Tastendruck billiges syntaktisches Filtern durchführt, und eine Transformation, die die teure semantische Arbeit nur dann erledigt, wenn sich der syntaktische Snapshot ändert:

```csharp
// .NET 11, C# 14, generator-side
public void Initialize(IncrementalGeneratorInitializationContext context)
{
    context.RegisterPostInitializationOutput(ctx =>
        ctx.AddSource("Inpc.Attributes.g.cs", AttributeSource));

    var classes = context.SyntaxProvider
        .ForAttributeWithMetadataName(
            "Inpc.ObservableAttribute",
            predicate: static (node, _) => node is ClassDeclarationSyntax c
                && c.Modifiers.Any(SyntaxKind.PartialKeyword),
            transform: static (ctx, ct) => Extract(ctx, ct))
        .Where(static x => x is not null)
        .Select(static (x, _) => x!.Value);

    context.RegisterSourceOutput(classes,
        static (spc, model) => Emit(spc, model));
}
```

`ForAttributeWithMetadataName` ist seit Roslyn 4.3 der richtige Einstiegspunkt für jeden attributgesteuerten Generator. Er nutzt den Attribut-Index des Compilers, sodass das `predicate` nur auf Syntax läuft, die bereits den passenden Attributnamen hat. Das ist dramatisch billiger als das ältere `CreateSyntaxProvider`-plus-`Where`-Muster und ist der größte einzelne Performance-Gewinn, der verfügbar ist.

Das `predicate` erzwingt `partial` auf Syntaxebene, bevor irgendein semantisches Modell existiert. Das fängt den häufigsten Konsumentenfehler (`partial` vergessen) mit der billigstmöglichen Prüfung ab.

## Ein stabiles Modell extrahieren

Die Transformation muss einen Wert zurückgeben, der strukturell vergleichbar ist. Roslyns Caching-Schicht vergleicht Modellwerte zwischen Läufen, um Re-Emits zu überspringen, wenn sich nichts geändert hat. Wenn Sie Symbole zurückgeben (`INamedTypeSymbol`, `IFieldSymbol`), invalidiert jeder Tastendruck den Cache, weil Symbole nur innerhalb einer einzelnen Compilation referenz-gleich sind.

Verwenden Sie ein `record` (oder `readonly record struct`) aus einfachen Strings:

```csharp
// .NET 11, C# 14, generator-side
internal readonly record struct ClassModel(
    string Namespace,
    string ClassName,
    EquatableArray<PropertyModel> Properties);

internal readonly record struct PropertyModel(
    string FieldName,
    string PropertyName,
    string TypeName);
```

`EquatableArray<T>` ist ein dünner Wrapper um `ImmutableArray<T>`, der strukturelles `Equals` implementiert. Roslyn liefert keinen, aber jedes Generator-Projekt kopiert dieselben sechs Zeilen aus dem Toolkit:

```csharp
// .NET 11, C# 14, generator-side
internal readonly record struct EquatableArray<T>(ImmutableArray<T> Items)
    : IEnumerable<T> where T : IEquatable<T>
{
    public bool Equals(EquatableArray<T> other) =>
        Items.AsSpan().SequenceEqual(other.Items.AsSpan());

    public override int GetHashCode()
    {
        var hash = new HashCode();
        foreach (var item in Items) hash.Add(item);
        return hash.ToHashCode();
    }

    public IEnumerator<T> GetEnumerator() =>
        ((IEnumerable<T>)Items).GetEnumerator();
    IEnumerator IEnumerable.GetEnumerator() =>
        ((IEnumerable)Items).GetEnumerator();
}
```

Das zu vergessen und ein rohes `ImmutableArray<T>` zurückzugeben, ist der zweithäufigste Generator-Performance-Bug nach dem Missbrauch von `CreateSyntaxProvider`. `ImmutableArray<T>.Equals` ist referenzbasiert, sodass jeder Snapshot neu aussieht.

Die eigentliche `Extract`-Funktion zieht Felder vom Symbol:

```csharp
// .NET 11, C# 14, generator-side
private static ClassModel? Extract(
    GeneratorAttributeSyntaxContext ctx,
    CancellationToken ct)
{
    if (ctx.TargetSymbol is not INamedTypeSymbol type) return null;

    var properties = ImmutableArray.CreateBuilder<PropertyModel>();
    foreach (var member in type.GetMembers())
    {
        ct.ThrowIfCancellationRequested();
        if (member is not IFieldSymbol field) continue;

        var attr = field.GetAttributes().FirstOrDefault(a =>
            a.AttributeClass?.ToDisplayString() == "Inpc.ObservablePropertyAttribute");
        if (attr is null) continue;

        string property = attr.NamedArguments
            .FirstOrDefault(kv => kv.Key == "PropertyName")
            .Value.Value as string
            ?? Capitalize(field.Name.TrimStart('_'));

        properties.Add(new PropertyModel(
            FieldName: field.Name,
            PropertyName: property,
            TypeName: field.Type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat)));
    }

    return new ClassModel(
        Namespace: type.ContainingNamespace.IsGlobalNamespace
            ? string.Empty
            : type.ContainingNamespace.ToDisplayString(),
        ClassName: type.Name,
        Properties: new EquatableArray<PropertyModel>(properties.ToImmutable()));
}

private static string Capitalize(string name) =>
    name.Length == 0 ? name : char.ToUpperInvariant(name[0]) + name[1..];
```

`SymbolDisplayFormat.FullyQualifiedFormat` erzeugt Namen im Stil `global::System.Collections.Generic.List<global::Foo.Bar>`, was jedes Namespace-Auflösungsproblem umgeht, auf das die emittierte Datei sonst stoßen könnte.

`ct.ThrowIfCancellationRequested()` innerhalb der Schleife zählt mehr, als Sie erwarten würden. Die IDE bricht Generator-Läufe aggressiv ab, während der Benutzer tippt; ein Generator, der das Token ignoriert, blockiert IntelliSense.

## Die partial class emittieren

Der Emit-Schritt ist ein einziger `StringBuilder`-Durchgang. Generatoren neigen dazu, auf `Roslyn.SyntaxFactory` basierende Builder wachsen zu lassen, die schön aussehen und langsam laufen; eine String-Vorlage ist für so regelmäßigen Code in Ordnung und viel einfacher zu debuggen:

```csharp
// .NET 11, C# 14, generator-side
private static void Emit(SourceProductionContext ctx, ClassModel model)
{
    var sb = new StringBuilder(1024);
    sb.AppendLine("// <auto-generated/>");
    sb.AppendLine("#nullable enable");
    if (model.Namespace.Length > 0)
    {
        sb.Append("namespace ").Append(model.Namespace).AppendLine(";");
        sb.AppendLine();
    }

    sb.Append("partial class ").Append(model.ClassName)
      .AppendLine(" : global::System.ComponentModel.INotifyPropertyChanged");
    sb.AppendLine("{");
    sb.AppendLine("    public event global::System.ComponentModel.PropertyChangedEventHandler? PropertyChanged;");
    sb.AppendLine();
    sb.AppendLine("    private bool SetProperty<T>(ref T storage, T value, string propertyName)");
    sb.AppendLine("    {");
    sb.AppendLine("        if (global::System.Collections.Generic.EqualityComparer<T>.Default.Equals(storage, value))");
    sb.AppendLine("            return false;");
    sb.AppendLine("        storage = value;");
    sb.AppendLine("        PropertyChanged?.Invoke(this,");
    sb.AppendLine("            new global::System.ComponentModel.PropertyChangedEventArgs(propertyName));");
    sb.AppendLine("        return true;");
    sb.AppendLine("    }");
    sb.AppendLine();

    foreach (var p in model.Properties)
    {
        sb.Append("    public ").Append(p.TypeName).Append(' ').Append(p.PropertyName)
          .AppendLine();
        sb.AppendLine("    {");
        sb.Append("        get => this.").Append(p.FieldName).AppendLine(";");
        sb.Append("        set => SetProperty(ref this.").Append(p.FieldName)
          .Append(", value, nameof(").Append(p.PropertyName).AppendLine("));");
        sb.AppendLine("    }");
        sb.AppendLine();
    }

    sb.AppendLine("}");

    string hint = string.IsNullOrEmpty(model.Namespace)
        ? $"{model.ClassName}.Inpc.g.cs"
        : $"{model.Namespace}.{model.ClassName}.Inpc.g.cs";
    ctx.AddSource(hint, sb.ToString());
}
```

Bemerkenswert:

- `SetProperty` allokiert pro Änderung ein frisches `PropertyChangedEventArgs`. Das ist für typische UI-Workloads akzeptabel. Wenn Sie einen hochfrequenten Stream (Spielzustand, Sensordaten) an INPC binden, cachen Sie pro Eigenschaft ein `PropertyChangedEventArgs` in einem statischen Feld; das `[ObservableProperty]` des Toolkits tut dies, wenn Sie es einschalten.
- Der Hint-Name (erstes Argument von `AddSource`) muss innerhalb der Compilation eindeutig sein. Das Einbinden des Namespaces verhindert Kollisionen, wenn zwei Klassen in verschiedenen Namespaces denselben Namen tragen.
- `EqualityComparer<T>.Default` behandelt `null` für Referenztypen korrekt und ist auch für Werttyp-Eigenschaften der richtige Vergleicher. `==` zu verwenden würde benutzerdefinierte Gleichheit kurzschließen.

## Konsumenten-Code

Der Sinn der ganzen Übung:

```csharp
// .NET 11, C# 14, consumer code
using Inpc;

[Observable]
public partial class PersonViewModel
{
    [ObservableProperty]
    private string _firstName = "";

    [ObservableProperty]
    private string _lastName = "";

    [ObservableProperty(PropertyName = "Age")]
    private int _ageYears;
}
```

Der Generator emittiert die öffentlichen Eigenschaften `FirstName`, `LastName` und `Age`, das Ereignis `PropertyChanged` und den `SetProperty`-Helper. Die Konsumentendatei bleibt genau wie oben sichtbar, ohne `OnPropertyChanged`-Verdrahtung und ohne im Gleichschritt geführte Backing-Felder.

## Native AOT und Trimming

Generatoren laufen zur Build-Zeit, sie zahlen also zur Laufzeit nichts. Die interessante Frage ist, was der *generierte* Code in einer AOT- oder getrimmten App kostet:

- `INotifyPropertyChanged` wird vom Trimmer als Teil des Datenbindungsvertrags erkannt. Die Schnittstelle und das `PropertyChanged`-Ereignis werden bei beobachtbaren Typen nicht weggetrimmt.
- `EqualityComparer<T>.Default` ist vollständig trim-sicher und AOT-sicher; keine Reflexion.
- Der Konstruktor von `PropertyChangedEventArgs` wird nicht getrimmt, weil die Signatur des Events ihn verwurzelt.

Worauf zu achten ist, ist XAML-Binding. WPF und Avalonia verwenden Reflexion, um INPC-Eigenschaften zu entdecken, sodass Trim-Konfigurationen für diese Frameworks beobachtbare View-Model-Typen über Deskriptoren bereits aus dem Trimming herausnehmen. MAUIs kompilierte Bindings beseitigen diesen Bedarf vollständig, und ein Generator wie dieser fügt sich natürlich mit Codegen im `[BindableProperty]`-Stil zusammen, falls Sie beide Welten möchten.

## Stolpersteine, in der Reihenfolge der Häufigkeit

- **`partial` an der Klasse vergessen**: das `predicate` filtert sie heraus, und nichts wird generiert. Der Konsument sieht einen Fehler "Definition nicht gefunden" oder eine nicht implementierte Schnittstelle und nimmt an, der Generator sei kaputt. Fügen Sie eine Diagnose im Predicate-Pfad hinzu, die eine freundliche Meldung über `RegisterSourceOutput` auf einem `Where(x => x is null)`-Zweig sichtbar macht.
- **Symbole aus der Transformation zurückgeben**: tötet die Inkrementalität. Jeder Tastendruck transformiert und emittiert neu. Der Generator sieht in einem Ein-Klassen-Repro "schnell genug" aus und kriecht dann in einer echten Solution.
- **`global::` in emittierten Typnamen vergessen**: ein Konsumenten-Namespace namens `System.Foo` überschattet `System`, und die generierte Datei kompiliert in genau diesem einen Projekt nicht, ohne Fehler im Generator-Projekt selbst. Immer voll qualifizieren.
- **Attribute in einer separaten Runtime-DLL emittieren**: machbar, aber Post-Init-Injektion ist einfacher und vermeidet jedes Risiko von NuGet-Versionsdrift zwischen Analyzer und Runtime-Vertrag.
- **Die `_`-Präfix-Konvention nicht behandeln**: `string _firstName` sollte `FirstName` ergeben, nicht `_FirstName`. Der Schritt `Capitalize(name.TrimStart('_'))` behandelt die Standardkonvention; dokumentieren Sie, welche Konvention Sie wählen.
- **Doppelte Hint-Namen erzeugen**: `AddSource("Class.g.cs", ...)` aus zwei Namespaces kollidiert. Beziehen Sie immer den Namespace in den Hint ein.

Ein so gebauter Generator umfasst rund 200 Zeilen Code, läuft pro Änderung in Mikrosekunden und ersetzt Hunderte von Zeilen handgeschriebenen Boilerplates pro Konsumenten. Sobald Sie einen ausgeliefert haben, ist der nächste (Befehle, Dependency-Injection-Registrierung, Zustandsmaschinen) eine Kopie desselben Skeletts.

## Verwandt

- [Wie Sie einen benutzerdefinierten JsonConverter in System.Text.Json schreiben](/de/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) -- ein weiterer kleiner Roslyn-naher Erweiterungspunkt mit ähnlichen Stolpersteinen.
- [Wie Sie Channels statt BlockingCollection in C# verwenden](/de/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) -- asynchrone Muster, die mit View-Models zusammenspielen.
- [Wie Sie Native AOT mit ASP.NET Core Minimal APIs verwenden](/de/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) -- wie Trim und AOT Ihren generierten Code sehen.
- [Wie Sie einen globalen Ausnahmefilter in ASP.NET Core 11 hinzufügen](/de/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) -- ein weiteres Muster, das oft mit generiertem Boilerplate gepaart wird.

## Quellen

- MS Learn: [Source generators overview](https://learn.microsoft.com/en-us/dotnet/csharp/roslyn-sdk/source-generators-overview)
- Roslyn cookbook: [Incremental generators](https://github.com/dotnet/roslyn/blob/main/docs/features/incremental-generators.md)
- Roslyn API: [`IIncrementalGenerator`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.iincrementalgenerator), [`ForAttributeWithMetadataName`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.csharpgeneratorextensions.forattributewithmetadataname)
- CommunityToolkit.Mvvm reference implementation: [CommunityToolkit/dotnet on GitHub](https://github.com/CommunityToolkit/dotnet)
