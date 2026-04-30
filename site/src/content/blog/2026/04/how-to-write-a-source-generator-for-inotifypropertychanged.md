---
title: "How to write a source generator for INotifyPropertyChanged"
description: "A complete guide to building your own incremental source generator for INotifyPropertyChanged in C# 14 and .NET 11: the IIncrementalGenerator pipeline, marker attributes, partial-class output, the SetProperty pattern, and how to stay AOT-friendly."
pubDate: 2026-04-30
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "source-generators"
  - "mvvm"
---

To source-generate `INotifyPropertyChanged` (INPC) yourself, write an `IIncrementalGenerator` that finds classes marked with a custom attribute, reads their `[ObservableProperty]`-annotated fields, and emits a `partial class` that implements the interface, exposes wrapper properties, and raises `PropertyChanged` through a `SetProperty` helper. The generator runs at compile time, contributes zero runtime cost beyond the standard INPC plumbing, and removes every line of hand-written backing-field-and-setter boilerplate. This guide builds the generator end to end on .NET 11 (preview 3) and C# 14, but the same code works against any consumer targeting `netstandard2.0` for the analyzer, since that is still the contract Roslyn requires for source generators.

## Why write your own when CommunityToolkit.Mvvm exists

The well-known answer is `CommunityToolkit.Mvvm`, which ships `[ObservableObject]`, `[ObservableProperty]`, `[NotifyPropertyChangedFor]`, and a small mountain of well-tested generators. For most apps, take that. This guide is for the cases where you cannot:

- You need a generator that emits a different interface, such as `IObservableObject` from a domestic framework, or a vendor-specific notification contract.
- You want to combine INPC with extra behaviour the toolkit does not cover (audit logging, dirty tracking, coercion through a domain rule).
- You are building a learning artifact, an internal house framework, or a generator that has to live alongside `CommunityToolkit.Mvvm` without colliding on attribute names.
- You want to understand the toolkit before you trust it.

Source generators are also one of the cleanest places to hit Roslyn APIs first-hand, and INPC is the canonical "small, well-defined, high-leverage" target. If you have not written one before, this is a better starting point than trying to generate dependency-injection registration code or EF Core configuration.

## The pieces you need to deliver

A complete INPC generator has three parts, each in its own project or `<None>` injection:

1. A **marker attribute** that consumers apply to a `partial class`. Convention: `[Observable]` or `[GenerateInpc]`.
2. A **field-level attribute** that marks the underlying state the generator should expose as a property. Convention: `[ObservableProperty]`.
3. The **incremental generator** itself, packaged so MSBuild loads it as an analyzer.

The marker attribute is most easily delivered via `RegisterPostInitializationOutput`, which lets the generator inject the attribute source into the consumer's compilation. That way, consumers add a `<ProjectReference>` (or `<PackageReference>` with `OutputItemType="Analyzer"`) and immediately have the attributes available, no separate runtime DLL needed.

## Project layout

The analyzer project must target `netstandard2.0`, because that is the only TFM Roslyn loads in the IDE and on the .NET Framework MSBuild that older Visual Studio installs use:

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

`IsRoslynComponent` makes Visual Studio treat it as a generator for design-time loading. `EnforceExtendedAnalyzerRules` is the analyzer-style ruleset that flags mistakes like `string.Format` with culture issues inside generators, where reproducibility matters.

The consumer project references it as an analyzer:

```xml
<!-- consumer .csproj -->
<ItemGroup>
  <ProjectReference Include="..\Inpc.SourceGenerator\Inpc.SourceGenerator.csproj"
                    OutputItemType="Analyzer"
                    ReferenceOutputAssembly="false" />
</ItemGroup>
```

`ReferenceOutputAssembly="false"` is critical: you do **not** want the analyzer DLL on the consumer's runtime path. If you forget this, the consumer ships Roslyn at runtime, which is several megabytes of dead weight and breaks Native AOT.

## The marker attribute, injected at post-init

Inside the generator, register the attribute source before any analysis runs. This guarantees consumers can use the attributes without a separate package:

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

A few non-obvious choices:

- The attributes are `internal`. Each consuming assembly gets its own copy via post-init. That means two assemblies can both use `[Observable]` without `TypeForwardedTo` games or version conflicts. The cost is that the attributes do not survive across assembly boundaries, which is fine because the generator only needs them at compile time.
- Every type reference uses the `global::` prefix. Generated code lands in arbitrary namespaces, including ones that happen to be named `System` or `Inpc`. Without `global::`, name resolution can pick the wrong type and the generated file will not compile.
- The header comment `// <auto-generated/>` suppresses analyzer warnings from `EditorConfig` rules and StyleCop.

## The incremental pipeline

Now wire the actual analysis. Roslyn's incremental generator API has two halves: a `SyntaxProvider` that does cheap syntactic filtering on every keystroke, and a transform that does the expensive semantic work only when the syntactic snapshot changes:

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

`ForAttributeWithMetadataName` is the right entry point for any attribute-driven generator since Roslyn 4.3. It uses the compiler's attribute index, so the `predicate` runs only on syntax that already has the matching attribute name. That is dramatically cheaper than the older `CreateSyntaxProvider` plus `Where` pattern, and it is the single biggest performance win available.

The `predicate` enforces `partial` at the syntax level, before any semantic model exists. This catches the most common consumer mistake (forgetting `partial`) with the cheapest possible check.

## Extracting a stable model

The transform must return a value that is structurally comparable. Roslyn's caching layer compares model values across runs to skip re-emit when nothing changed. If you return symbols (`INamedTypeSymbol`, `IFieldSymbol`), every keystroke invalidates the cache, because symbols are reference-equal only within a single compilation.

Use a `record` (or `readonly record struct`) of plain strings:

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

`EquatableArray<T>` is a thin wrapper around `ImmutableArray<T>` that implements structural `Equals`. Roslyn does not ship one, but every generator project copies the same six lines from the toolkit:

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

Forgetting this and returning a raw `ImmutableArray<T>` is the second-most-common generator perf bug after misusing `CreateSyntaxProvider`. `ImmutableArray<T>.Equals` is reference-based, so every snapshot looks new.

The actual `Extract` function pulls fields off the symbol:

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

`SymbolDisplayFormat.FullyQualifiedFormat` produces `global::System.Collections.Generic.List<global::Foo.Bar>` style names, which sidesteps every namespace-resolution problem the emitted file might otherwise hit.

`ct.ThrowIfCancellationRequested()` inside the loop matters more than you would expect. The IDE cancels generator runs aggressively as the user types; a generator that ignores the token blocks IntelliSense.

## Emitting the partial class

The emit step is a single `StringBuilder` walk. Generators tend to grow `Roslyn.SyntaxFactory`-based builders that look beautiful and run slowly; a string template is fine for code this regular and is much easier to debug:

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

Things worth noticing:

- `SetProperty` allocates a fresh `PropertyChangedEventArgs` per change. That is acceptable for typical UI workloads. If you bind a high-frequency stream (game state, sensor data) to INPC, cache one `PropertyChangedEventArgs` per property in a static field; the toolkit's `[ObservableProperty]` does this when you opt in.
- The hint name (`AddSource` first argument) must be unique within the compilation. Including the namespace prevents collisions when two classes in different namespaces share a name.
- `EqualityComparer<T>.Default` handles `null` correctly for reference types and is the right comparator for value-type properties too. Using `==` would short-circuit user-defined equality.

## Consumer code

The point of the whole exercise:

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

The generator emits the public `FirstName`, `LastName`, and `Age` properties, the `PropertyChanged` event, and the `SetProperty` helper. The consumer file remains exactly what you see above, with no `OnPropertyChanged` plumbing and no lock-step backing fields.

## Native AOT and trimming

Generators run at build time, so they pay nothing at runtime. The interesting question is what the *generated* code costs in an AOT or trimmed app:

- `INotifyPropertyChanged` is recognised by the trimmer as part of the data binding contract. The interface and `PropertyChanged` event will not be trimmed away from observable types.
- `EqualityComparer<T>.Default` is fully trim-safe and AOT-safe; no reflection.
- `PropertyChangedEventArgs` constructor is not trimmed because the event's signature roots it.

The thing to watch is XAML binding. WPF and Avalonia use reflection to discover INPC properties, so trim configurations for those frameworks already opt observable view-model types out of trimming via descriptors. MAUI's compiled bindings remove that need entirely, and a generator like this one composes naturally with `[BindableProperty]`-style codegen if you want both worlds.

## Gotchas, in order of frequency

- **Forgetting `partial` on the class**: the `predicate` filters it out and nothing is generated. The consumer sees a "definition not found" or unimplemented-interface error and assumes the generator is broken. Add a diagnostic in the predicate path that surfaces a friendly message via `RegisterSourceOutput` on a `Where(x => x is null)` branch.
- **Returning symbols from the transform**: kills incrementality. Every keystroke retransforms and re-emits. The generator looks "fast enough" on a one-class repro, then crawls on a real solution.
- **Forgetting `global::` in emitted type names**: a consumer namespace named `System.Foo` shadows `System` and the generated file fails to compile in that one project, with no error in the generator project itself. Always fully qualify.
- **Emitting attributes in a separate runtime DLL**: doable, but post-init injection is simpler and avoids any risk of NuGet version drift between the analyzer and the runtime contract.
- **Not handling the `_` prefix convention**: `string _firstName` should produce `FirstName`, not `_FirstName`. The `Capitalize(name.TrimStart('_'))` step handles the standard convention; document whatever convention you pick.
- **Generating duplicate hint names**: `AddSource("Class.g.cs", ...)` from two namespaces collides. Always include the namespace in the hint.

A generator built this way is around 200 lines of code, runs in microseconds per change, and replaces hundreds of lines of hand-written boilerplate per consumer. Once you have shipped one, the next one (commands, dependency-injection registration, state machines) is a copy of the same skeleton.

## Related

- [How to write a custom JsonConverter in System.Text.Json](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) -- another "small Roslyn-adjacent extension point" with similar gotchas.
- [How to use Channels instead of BlockingCollection in C#](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) -- async patterns that compose with view-models.
- [How to use Native AOT with ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) -- how trim and AOT see your generated code.
- [How to add a global exception filter in ASP.NET Core 11](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) -- another pattern often paired with generated boilerplate.

## Sources

- MS Learn: [Source generators overview](https://learn.microsoft.com/en-us/dotnet/csharp/roslyn-sdk/source-generators-overview)
- Roslyn cookbook: [Incremental generators](https://github.com/dotnet/roslyn/blob/main/docs/features/incremental-generators.md)
- Roslyn API: [`IIncrementalGenerator`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.iincrementalgenerator), [`ForAttributeWithMetadataName`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.csharpgeneratorextensions.forattributewithmetadataname)
- CommunityToolkit.Mvvm reference implementation: [CommunityToolkit/dotnet on GitHub](https://github.com/CommunityToolkit/dotnet)
