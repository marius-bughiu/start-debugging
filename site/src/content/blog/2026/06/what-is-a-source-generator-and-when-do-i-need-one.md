---
title: "What is a source generator and when do I need one?"
description: "A plain-language guide to C# source generators: what they actually do, how the IIncrementalGenerator pipeline works, when they beat reflection or T4, and the cases where you should not reach for one. With runnable examples on .NET 11 and C# 14."
pubDate: 2026-06-19
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "source-generators"
  - "roslyn"
---

A source generator is a piece of code that the C# compiler runs while it compiles your project, and that can read your code and add new C# files to the same compilation. It runs at build time, produces ordinary source that the compiler then compiles as if you had typed it, and adds zero runtime cost beyond the code it emits. You need one when you would otherwise pay for reflection at runtime, hand-write repetitive boilerplate, or run a separate code-gen step out of band, and you want the generated code to be strongly typed, debuggable, trim-safe, and Native AOT-friendly. If you do not have one of those problems, you almost certainly do not need to write a generator. This guide covers .NET 11 (preview 5) and C# 14, but the mechanics apply to any project on .NET 6 or newer.

## What "runs inside the compiler" actually means

Most code you write runs after the build, when the app starts. A source generator is different: it is a Roslyn component that the compiler loads as an analyzer and invokes during compilation. It gets a read-only view of everything Roslyn knows about your project so far (syntax trees, semantic symbols, references, additional files) and its only output is more source code. It cannot rewrite your existing files, delete code, or change what you already wrote. It can only add.

That "only add" constraint is the whole design. Generated code goes into the compilation as extra files, and the dominant pattern is the `partial` member: you write half a class by hand, mark it `partial`, and the generator emits the other half. The two halves are compiled together into one type. Because the output is real C# that becomes real IL, everything downstream treats it like code you wrote: IntelliSense sees it, the debugger steps into it, the linker can trim it, and Native AOT can compile it ahead of time. There is no runtime reflection, no `Reflection.Emit`, no dynamic proxy.

This is the key mental model. A source generator is not a macro system and not a post-build script. It is a compile-time function from "your code" to "more of your code".

## Why this beats the alternatives it replaces

Before source generators (introduced in .NET 5, Roslyn 3.8), the three ways to avoid writing boilerplate by hand were reflection, IL emit, and external code generators like T4 templates. Each has a real cost that a source generator removes.

Runtime reflection (think classic JSON serializers, dependency-injection containers, object mappers) inspects types at startup and either interprets them every call or builds a dynamic method once and caches it. It works, but it pays a startup tax, it is invisible to the trimmer (so it bloats trimmed and AOT builds or breaks them outright), and the cost lands on your users, not your build. A `System.InvalidOperationException` or `System.PlatformNotSupportedException` from reflection only shows up at runtime, often in production. We covered exactly that failure mode in [why reflection-heavy code throws under Native AOT](/2026/05/fix-platformnotsupportedexception-in-native-aot/).

T4 and other external generators run as a separate step, usually wired into the build with their own tooling. They cannot see the semantic model (they parse text, not symbols), the generated files sit on disk and drift out of sync, and they are awkward in CI. Source generators run inside the same compilation, see fully-resolved symbols, and never write a stale file to your repo.

A source generator moves all of that work to build time and emits plain, statically-compiled C#. The serializer does not reflect over your type at startup; it already has the exact code to read and write it. That is why the in-box `System.Text.Json` source generator is the only JSON path that works under Native AOT, a point we made in [System.Text.Json vs Newtonsoft.Json in 2026](/2026/05/system-text-json-vs-newtonsoft-json-in-2026/).

## The generators you already use

You do not have to write one to benefit from the concept. Modern .NET ships several, and recognizing them tells you what kind of problem generators are good at:

- `System.Text.Json` source generation (`[JsonSerializable]` + a `JsonSerializerContext`) emits serialization code so STJ never reflects at runtime.
- `LoggerMessage` source generation (`[LoggerMessage]`) turns a partial method into a zero-allocation, strongly-typed logging call.
- `GeneratedRegex` (`[GeneratedRegex]`) compiles your regex pattern to C# at build time instead of building a state machine at first use.
- `System.Text.Json`, `Microsoft.Extensions.Configuration`, and the options binder all have generators that replace reflection-based binding.
- `CommunityToolkit.Mvvm` generates `INotifyPropertyChanged` plumbing from `[ObservableProperty]`.
- `Mapperly` generates object-to-object mapping at compile time, the basis for our [AutoMapper to source-generated mapping migration](/2026/05/migrate-from-automapper-to-source-generated-mapping/).

The shared shape: take a declarative marker (an attribute, a partial method, a partial class), and emit the tedious, error-prone, reflection-shaped code that would otherwise be written by hand or discovered at runtime.

## How a generator is built: the incremental pipeline

There are two generator interfaces, and only one is current. The original `ISourceGenerator` (an `Initialize`/`Execute` pair that received the entire compilation and ran on every keystroke) is deprecated. The Roslyn source explicitly says so: "ISourceGenerator is deprecated and should not be implemented. Please implement IIncrementalGenerator instead." (see the [ISourceGenerator deprecation note in dotnet/roslyn](https://github.com/dotnet/roslyn/blob/main/src/Compilers/Core/Portable/SourceGeneration/ISourceGenerator.cs)). For anything new, use `IIncrementalGenerator`.

The reason is performance in the IDE. An incremental generator does not compute everything from scratch each run. You declare a pipeline, a graph of transformation steps, and Roslyn caches the output of each step. If the inputs to a step have not changed since the last keystroke, Roslyn skips that step and reuses the cached result. That is what makes a generator safe to re-run hundreds of times a minute while you type.

Here is a minimal but complete generator. It finds classes marked `[AutoToString]` and emits a `ToString()` override that lists the public properties.

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

The consumer side is just an attribute and a `partial class`:

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

Two details carry most of the weight. First, `ForAttributeWithMetadataName` is the fast entry point added in Roslyn 4.3: it lets Roslyn pre-filter to nodes that actually carry your attribute instead of walking every syntax node, which is the single biggest performance lever in a real generator. Second, the `transform` returns a small `record` (`Model`), not the `INamedTypeSymbol`. This matters more than it looks: incrementality depends on value equality. As the Roslyn cookbook puts it, you want value-equatable types such as `record`, `struct`, tuples, and `ImmutableArray<T>` flowing through the pipeline, because the moment a step returns a value equal to its previous output, Roslyn stops and reuses the cached downstream result. Pass a `Symbol` or a `Compilation` down the pipeline and you defeat caching entirely, because those types are large, reference-equal, and change every keystroke.

## When you should reach for one

Write or adopt a source generator when all of these are true:

1. The code is mechanical and derivable from something already in the source (a type's shape, an attribute, a method signature). If a human writing it would just be transcribing, a generator can do it.
2. You are currently paying for it with runtime reflection, and that cost is real: startup latency, allocations on a hot path, or a trimming/AOT incompatibility.
3. You want the result to be debuggable and statically typed, not a dynamic method you cannot step into.

The clearest wins: serialization, DTO mapping, dependency-injection registration, `INotifyPropertyChanged`, strongly-typed configuration binding, generating clients from a contract, and replacing any `Activator.CreateInstance` or `Expression.Compile` hot path. If you are targeting Native AOT, the calculus tips further toward generators, since reflection-based approaches are exactly what break there. We walked through that constraint in [using Native AOT with ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/).

## When you do not need one (and should not write one)

Generators are not free to build or maintain. Skip writing your own when:

- A well-tested generator already exists. Do not reimplement `CommunityToolkit.Mvvm`, Mapperly, or the STJ context generator for fun. Use them. The [INotifyPropertyChanged generator walkthrough](/2026/04/how-to-write-a-source-generator-for-inotifypropertychanged/) exists to teach the Roslyn API, not to argue you should ship your own MVVM toolkit.
- The repetition is small or one-off. A handful of similar classes is not a reason to take on a `netstandard2.0` analyzer project, a separate test harness, and a debugging story that involves attaching a second compiler.
- You actually need to transform or rewrite existing code. Generators can only add. If you want to inject behavior into methods you did not write, that is interceptors (a separate C# 14 feature) or a post-compile IL weaver like Fody, not a source generator.
- The shape is genuinely dynamic, decided at runtime from data the compiler cannot see (a config file read at startup, a plugin loaded from disk). The compiler knows nothing about runtime state, so a generator cannot help.
- A simple `T` generic, a base class, or a plain helper method would do. Reach for the language first. Generators are for the cases where the language cannot express the abstraction without per-type boilerplate.

The honest default for most teams is: consume generators liberally, write your own rarely.

## The gotchas that bite first

A few things trip up everyone the first time:

- The generator project must target `netstandard2.0`. That is still the contract Roslyn requires for analyzers, regardless of what your app targets. You will be writing the generator in an older language surface than the code it emits.
- Reference it as an analyzer, not a normal dependency: `<ProjectReference Include="..\Gen.csproj" OutputItemType="Analyzer" ReferenceOutputAssembly="false" />`. Get this wrong and the generator either does not run or leaks into your runtime output.
- Generated code is additive and you cannot see it by default. Set `<EmitCompilerGeneratedFiles>true</EmitCompilerGeneratedFiles>` in the consuming project to dump the `.g.cs` files under `obj/` so you can read what was actually emitted. This is the first thing to do when output looks wrong.
- Do not put `Compilation`, `ISymbol`, or `SyntaxNode` into the pipeline data model. They are not value-equatable and they kill incrementality, which turns your generator back into the slow `ISourceGenerator` behavior you were trying to avoid. Project them into records early.
- Never throw from a generator. An exception becomes a build warning (`CS8785`) and your code silently does not get generated. Handle the "attribute present but type is malformed" case by emitting a diagnostic, not by crashing.
- A generator runs on every build of the consuming project, including in the IDE on every edit. A slow or non-incremental generator makes the whole editor feel laggy. This is not theoretical; it is the reason the incremental API exists.

The mental shortcut that keeps you out of trouble: a source generator is a pure, cached function from immutable inputs to source text. Keep the inputs small and value-equatable, keep the function fast, never let it throw, and only write one when reflection or hand-written boilerplate is costing you something you can measure.

## Sources and further reading

- [Incremental generators, dotnet/roslyn docs](https://github.com/dotnet/roslyn/blob/main/docs/features/incremental-generators.md)
- [Incremental generators cookbook, dotnet/roslyn](https://github.com/dotnet/roslyn/blob/main/docs/features/incremental-generators.cookbook.md)
- [ISourceGenerator deprecation note, dotnet/roslyn source](https://github.com/dotnet/roslyn/blob/main/src/Compilers/Core/Portable/SourceGeneration/ISourceGenerator.cs)
- [Source generators overview, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/roslyn-sdk/source-generators-overview)
