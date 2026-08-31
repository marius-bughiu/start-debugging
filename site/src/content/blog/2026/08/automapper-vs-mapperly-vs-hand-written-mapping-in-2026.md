---
title: "AutoMapper vs Mapperly vs hand-written mapping in 2026"
description: "Mapperly is the default for new .NET code: it matches hand-written speed, survives Native AOT, and catches unmapped members at build time. AutoMapper still wins on ProjectTo. Benchmarks and license thresholds included."
pubDate: 2026-08-31
template: vs
tags:
  - "comparison"
  - "automapper"
  - "mapperly"
  - "source-generators"
  - "dotnet"
  - "performance"
---

For new .NET code in 2026, use **Mapperly**. It generates plain C# at build time, runs within 3% of hand-written mapping, publishes clean under Native AOT, and turns a forgotten property into a compiler diagnostic instead of a silently empty string. Write mapping **by hand** when a project has fewer than about twenty maps or the source and destination shapes genuinely diverge. Keep **AutoMapper** only when `ProjectTo` is load-bearing across a large EF Core codebase and you qualify for the free Community tier, because above $5,000,000 in annual revenue the license turns the decision into a purchase order.

Every number below was measured on an Apple M4 (10 cores) with .NET SDK 10.0.302 targeting `net10.0`, using AutoMapper 16.2.0 (released 2026-07-02), Riok.Mapperly 4.3.1 (released 2025-12-22), and BenchmarkDotNet 0.15.8.

## The matrix

| | AutoMapper 16.2.0 | Mapperly 4.3.1 | Hand-written |
| --- | --- | --- | --- |
| License | RPL-1.5 copyleft or paid commercial | Apache 2.0 | none |
| Cost above $5M revenue | $799 to $6,399 per year | free | free |
| How mapping is produced | reflection plus compiled expression trees at first use | Roslyn source generator at build time | you |
| Unmapped destination member | silent, only `AssertConfigurationIsValid()` catches it | `RMG012` warning, escalatable to error | compiler tells you nothing either |
| Unmapped source member | not reported at all | `RMG020` warning | not reported |
| Native AOT publish | `IL2104` plus `IL3053`, crashes at startup | zero warnings, runs | zero warnings, runs |
| Cold cost of the first map | ~33 ms for 3 maps | ~1 ms | 0 |
| Single object map | 105.79 ns | 60.44 ns | 58.48 ns |
| EF Core projection | `ProjectTo` with explicit expansion, parameters, recursion depth | generated `IQueryable` projection, several unsupported features | write the `Select` |
| Runtime `Map(object, type)` | yes | no | no |
| Debuggable output | compiled expression tree | readable `.g.cs` you can step into | your own code |

## The license is the axis everything else hangs off

On 2025-07-02 Jimmy Bogard moved AutoMapper and MediatR to Lucky Penny Software and relicensed both. AutoMapper 15.0.0 and later ship under a dual model: the [Reciprocal Public License 1.5](https://github.com/LuckyPennySoftware/AutoMapper/blob/main/LICENSE.md) for open-source use, or a paid commercial license. Version 14.x and earlier stay MIT forever.

RPL-1.5 is not MIT with extra steps. It is a strong reciprocal copyleft that reaches deployed software, not just distributed software, so closed-source commercial products cannot realistically ship on the RPL build. That leaves the commercial agreement, whose free Community tier covers organizations with less than $5,000,000 USD gross annual revenue that have also taken less than $10,000,000 USD in outside capital, and that are not government, quasi-government, or higher-education entities. Above that line the [published tiers](https://automapper.io/) are Standard at $799 a year for 1 to 10 developers, Professional at $1,499 a year for 11 to 50, and Enterprise at $6,399 a year for unlimited developers. Only developers actively writing or maintaining code that calls the library count, which excludes QA, designers, and front-end work.

Enforcement is deliberately soft. There is no license server, no network call, and no feature lockout. A missing or expired key produces a log message and nothing else, and since 16.2.0 the key can also come from the `AUTOMAPPER_LICENSE_KEY` or `LUCKYPENNY_LICENSE_KEY` environment variables instead of `cfg.LicenseKey`. Soft enforcement is not the same as permission, though, and "we did not notice a warning in the logs" is not a license position anyone wants to defend in a procurement review.

This is the same fork as the mediator libraries, and the reasoning transfers directly: see [MediatR vs plain service classes in 2026](/2026/05/mediatr-vs-plain-service-classes-in-2026/) for the full breakdown of the Community tier and the RPL-1.5 obligations.

## When to pick Mapperly

- **Anything that publishes with trimming or Native AOT.** This is not a preference, it is a hard gate. See the AOT section below.
- **Serverless and short-lived processes.** Mapperly costs nothing at startup because there is no configuration object to build.
- **Codebases where DTO drift is a real risk.** A new column on the entity that nobody added to the DTO produces `RMG020` at build time. AutoMapper will not mention it at all.
- **Teams that want to read the mapping.** Mapperly writes a `.g.cs` file you can open, diff, and step through in the debugger.

## When to pick hand-written mapping

- **Small surface area.** Under roughly twenty maps, a static `ToDto` method per type is less machinery than a generator plus its attribute vocabulary, and it never surprises anyone.
- **Shapes that genuinely differ.** When most members need `MapFrom`, `IValueResolver`, or conditional logic, both libraries degrade into a worse spelling of the method you were going to write anyway.
- **Public API contracts.** DTOs that are a versioned wire format deserve an explicit, reviewable mapping where every field assignment shows up in the diff.
- **Any layer you want zero build-time dependencies in.** Mapperly is a source generator, so it participates in your build; a static method does not.

## When to keep AutoMapper

- **A large EF Core codebase built on `ProjectTo`.** AutoMapper's queryable extensions support explicit expansion, runtime parameterization via anonymous objects, `RecursiveQueriesMaxDepth` for self-referencing models, and polymorphic mapping. Mapperly's projections cover the common case but explicitly do not support object factories, `ByName` enum strategies, reference handling, or deep cloning, and will report `RMG068` when it cannot inline a user-defined method.
- **You are under the Community threshold and the maps already work.** Rewriting 200 working maps to save 45 ns per call is not a business case.
- **Dynamic, untyped mapping.** `mapper.Map(source, sourceType, destType)` has no source-generated equivalent. If you have a plugin system that discovers types at runtime, AutoMapper is doing something Mapperly structurally cannot.

If you decide to leave, the mechanics are covered step by step in [migrate from AutoMapper to source-generated mapping with Mapperly](/2026/05/migrate-from-automapper-to-source-generated-mapping/).

## The benchmark

The model is an `Order` with five scalar members, a nested `Customer`, five `OrderLine` children, and an enum mapped to its string name. `[MemoryDiagnoser]`, default job, AutoMapper's expression compilation warmed in `[GlobalSetup]` so the measurement is steady-state throughput rather than first-call cost.

```csharp
// .NET SDK 10.0.302, net10.0, C# 14
// AutoMapper 16.2.0, Riok.Mapperly 4.3.1, BenchmarkDotNet 0.15.8
[MemoryDiagnoser]
public class MappingBenchmarks
{
    private Order _order = null!;
    private List<Order> _orders = null!;
    private IMapper _autoMapper = null!;
    private OrderMapper _mapperly = null!;

    [GlobalSetup]
    public void Setup()
    {
        _order = MakeOrder(1);
        _orders = Enumerable.Range(1, 1000).Select(MakeOrder).ToList();

        var config = new MapperConfiguration(
            cfg => cfg.AddProfile<OrderProfile>(),
            NullLoggerFactory.Instance);
        _autoMapper = config.CreateMapper();
        _mapperly = new OrderMapper();

        _autoMapper.Map<OrderDto>(_order); // warm the expression compilation
    }

    [Benchmark(Baseline = true)]
    public OrderDto HandWritten_Single() => HandMapper.ToDto(_order);

    [Benchmark]
    public OrderDto Mapperly_Single() => _mapperly.ToDto(_order);

    [Benchmark]
    public OrderDto AutoMapper_Single() => _autoMapper.Map<OrderDto>(_order);
}
```

Results on an Apple M4, 10 physical cores, .NET 10.0.10 Arm64 RyuJIT:

| Method | Mean | Ratio | Allocated | Alloc Ratio |
| --- | ---: | ---: | ---: | ---: |
| HandWritten_Single | 58.48 ns | 1.00 | 624 B | 1.00 |
| Mapperly_Single | 60.44 ns | 1.03 | 624 B | 1.00 |
| AutoMapper_Single | 105.79 ns | 1.81 | 704 B | 1.13 |
| HandWritten_1000 | 72,696 ns | 1.00 | 632,091 B | 1.00 |
| Mapperly_1000 | 77,334 ns | 1.06 | 672,093 B | 1.06 |
| AutoMapper_1000 | 103,376 ns | 1.42 | 720,640 B | 1.14 |

Read this honestly: 45 nanoseconds per object is not why you should switch. On a request that maps 1,000 orders the whole difference is 31 microseconds, which will not show up next to a single database round trip. The performance argument only becomes load-bearing at very high object counts, and it is the weakest of the three reasons to prefer Mapperly.

The 40,000-byte gap between Mapperly and hand-written in the 1,000-object case is a real artifact worth understanding. Mapperly widens the parameter of a generated nested-collection mapper to `IReadOnlyCollection<T>`:

```csharp
// Riok.Mapperly 4.3.1 generated output, trimmed
private List<OrderLineDto> MapToListOfOrderLineDto(IReadOnlyCollection<OrderLine> source)
{
    var target = new List<OrderLineDto>(source.Count);
    foreach (var item in source)
        target.Add(MapToOrderLineDto(item));
    return target;
}
```

Enumerating a `List<T>` through an interface boxes its struct enumerator: 40 bytes per order, 40,000 bytes across the batch. Declaring the nested collection mapper yourself with a concrete `List<OrderLine>` parameter removes it. This is exactly the kind of thing you can find and fix because the generated code is on disk, which is the practical difference between a source generator and a compiled expression tree.

## The gotcha that picks for you: Native AOT

Publish a console app that calls AutoMapper 16.2.0 with `<PublishAot>true</PublishAot>` on `net10.0` and the build warns:

```text
AutoMapper.dll : warning IL2104: Assembly 'AutoMapper' produced trim warnings.
AutoMapper.dll : warning IL3053: Assembly 'AutoMapper' produced AOT analysis warnings.
```

Warnings are easy to ignore. The resulting binary is not:

```text
Unhandled exception. System.TypeInitializationException: A type initializer threw an exception.
 ---> System.ArgumentNullException: Value cannot be null. (Parameter 'method')
   at System.Linq.Expressions.Expression.Call(MethodInfo, Expression)
   at AutoMapper.Execution.ExpressionBuilder..cctor()
   at AutoMapper.MapperConfiguration..ctor(MapperConfigurationExpression, ILoggerFactory)
```

The trimmer removed a method that `ExpressionBuilder` looks up reflectively, so the static constructor dies before your first map. The equivalent Mapperly app published with the same settings emits zero IL warnings, produces a 1.1 MB native binary, and runs. That is not a tuning problem you can solve with `DynamicDependency` attributes at the call site; it is a property of building maps from expression trees at runtime, which is the same trap described in [what is trim-safe code and how do I write it](/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/). If Native AOT is on your roadmap, the decision is already made.

The softer version of the same effect is cold start. Building the configuration and running the first map for three types took 33 milliseconds on this machine, versus 1 millisecond for `new OrderMapper()` plus its first call. In a long-lived web app that is invisible. In a Lambda it is a measurable slice of a cold invocation, which is why it shows up in [reducing cold-start time for a .NET AWS Lambda](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/).

## Where the safety difference actually shows up

Add a `Slug` property to a DTO and forget to map it. AutoMapper 16.2.0 maps the object anyway:

```text
map ok: Id=1 Name=n Slug=''
```

`AssertConfigurationIsValid()` does catch it, throwing `AutoMapperConfigurationException` with "Unmapped members were found" - but only if you remembered to call it, and only for unmapped *destination* members. A source property that no longer reaches any DTO is not reported at all.

Mapperly reports both directions at build time, with the real message text:

```text
warning RMG020: The member InternalNote on the mapping source type Diag.Source
                is not mapped to any member on the mapping target type Diag.Target
warning RMG012: The member Slug on the mapping target type Diag.Target
                was not found on the mapping source type Diag.Source
```

They are warnings by default, which means they will drown in a noisy build. Escalate them in `.editorconfig` and the build fails outright:

```ini
[*.cs]
dotnet_diagnostic.RMG012.severity = error
dotnet_diagnostic.RMG020.severity = error
```

That is the setting that turns Mapperly from "a faster AutoMapper" into a different category of tool: mapping bugs stop being production incidents and become build failures. It is also the clearest illustration of why [source generators](/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) are worth the build-time dependency.

Hand-written mapping, for the record, offers no such check. A forgotten assignment in a `ToDto` method is exactly as silent as AutoMapper. Its safety comes from being visible in code review, not from tooling.

## The call

Default to Mapperly for new code, and escalate `RMG012` and `RMG020` to errors on day one so you actually get the benefit. Write mapping by hand when the project is small or the shapes are irregular, and accept that you are trading tooling checks for reviewability. Keep AutoMapper when a mature `ProjectTo`-heavy codebase already works, you are under the Community threshold, and Native AOT is not on the roadmap - and if any one of those three stops being true, start the migration rather than budgeting for the license. The performance table is the least interesting part of this comparison. Trim safety and build-time diagnostics are what actually change how a codebase behaves.

## Related

- [Migrate from AutoMapper to source-generated mapping with Mapperly](/2026/05/migrate-from-automapper-to-source-generated-mapping/)
- [Fix: 'MapperConfiguration' does not contain a constructor that takes 1 arguments](/2026/08/fix-mapperconfiguration-does-not-contain-a-constructor-that-takes-1-arguments/)
- [MediatR vs plain service classes in 2026](/2026/05/mediatr-vs-plain-service-classes-in-2026/)
- [What is a source generator and when do I need one?](/2026/06/what-is-a-source-generator-and-when-do-i-need-one/)
- [What is Native AOT and what does it cost you?](/2026/06/what-is-native-aot-and-what-does-it-cost-you/)

## Sources

- [Licensing FAQ - Lucky Penny Software](https://luckypennysoftware.com/faq) - the 15.0.0 boundary, the $5,000,000 revenue and $10,000,000 capital Community thresholds, and how developers are counted.
- [AutoMapper LICENSE.md](https://github.com/LuckyPennySoftware/AutoMapper/blob/main/LICENSE.md) - the RPL-1.5 or commercial dual-license text.
- [AutoMapper license configuration docs](https://docs.automapper.io/en/latest/License-configuration.html) - `AUTOMAPPER_LICENSE_KEY` and `LUCKYPENNY_LICENSE_KEY` discovery, and the log-only enforcement model.
- [AutoMapper Queryable Extensions](https://docs.automapper.io/en/latest/Queryable-Extensions.html) - `ProjectTo` explicit expansion, parameterization, and the "must be the last call in the chain" constraint.
- [Mapperly queryable projections](https://mapperly.riok.app/docs/configuration/queryable-projections/) - the unsupported-feature list and the `RMG068` inlining diagnostic.
- [Mapperly analyzer diagnostics](https://mapperly.riok.app/docs/configuration/analyzer-diagnostics/) - `RMG012`, `RMG020`, and `.editorconfig` severity escalation.
- [Riok.Mapperly on NuGet](https://www.nuget.org/packages/Riok.Mapperly) - 4.3.1 release date and Apache 2.0 license.
- [AutoMapper on NuGet](https://www.nuget.org/packages/AutoMapper) - 16.2.0 release date and version history.
