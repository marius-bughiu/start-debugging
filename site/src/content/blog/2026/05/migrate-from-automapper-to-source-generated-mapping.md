---
title: "Migrate from AutoMapper to source-generated mapping with Mapperly"
description: "A step-by-step checklist to replace AutoMapper 15 Profiles, IMapper, ForMember, and ProjectTo with Riok.Mapperly 4.3 source-generated mappers in .NET 11."
pubDate: 2026-05-30
updatedDate: 2026-05-30
template: migration
tags:
  - "migration"
  - "automapper"
  - "mapperly"
  - "source-generators"
  - "dotnet-11"
---

Replacing AutoMapper with a source generator is a mechanical, file-by-file refactor, not a rewrite. For a typical service with 30-80 maps spread across a handful of `Profile` classes, budget half a day to a day: each `CreateMap<Source, Dest>()` becomes a `partial` method on a `[Mapper]` class, `IMapper.Map<T>` calls become direct method calls, and `ProjectTo<T>()` becomes a generated `IQueryable` extension. What breaks is anything that leaned on AutoMapper's runtime flexibility: dynamic `Map(object)` calls, `IValueResolver` with injected services, and the assembly-scanning registration. It is worth doing if you are above AutoMapper's $5,000,000 revenue line and do not want to buy a license, if you want Native AOT and trimming to work, or if you want unmapped properties to fail the build instead of silently dropping at runtime.

Versions referenced: this guide covers leaving AutoMapper 14.x (the last MIT release) and 15.0 (the first dual Reciprocal Public License 1.5 / commercial release from Lucky Penny Software). The replacement targets `<TargetFramework>net11.0</TargetFramework>` with the .NET 11 SDK, C# 14, and Riok.Mapperly 4.3.1 (released 2025-12-22). If you are still deciding whether to leave at all, this is the same vendor story as MediatR, so read [migrate from MediatR to plain dependency injection](/2026/05/migrate-from-mediatr-to-plain-dependency-injection/) for the parallel case; this post assumes the decision is made.

## Why teams are leaving AutoMapper specifically now

- **The license forces a decision above $5M.** AutoMapper 15.0 ships under the RPL-1.5 reciprocal copyleft license plus a paid commercial tier. Free use covers companies under $5,000,000 gross annual revenue and non-production environments. Above that line, closed-source commercial software cannot use the RPL build, so it is buy-or-leave. Everything published under MIT (14.x and earlier) stays usable under MIT forever, but you stop getting fixes.
- **Mapping errors move from runtime to build time.** AutoMapper validates configuration only when you call `AssertConfigurationIsValid()` or hit the map at runtime. Mapperly reports an unmapped property as a compile-time `RMG` diagnostic, so a forgotten field is a build warning, not a production `NullReferenceException`.
- **Startup gets cheaper and AOT gets easier.** AutoMapper builds and compiles mapping expressions at first use via reflection. Mapperly emits plain C# at build time, so there is zero startup cost and no reflection to fight the trimmer, which matters when [reducing cold-start time for a .NET 11 AWS Lambda](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) or shipping [Native AOT](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/).
- **You can read the generated code.** Mapperly writes a readable partial method body you can step into, instead of an opaque compiled expression tree.

## What breaks

| Area | Change | Severity |
| --- | --- | --- |
| `IMapper` injection | Replaced by the concrete generated mapper class injected directly | high |
| `Profile` + `CreateMap<,>()` | Collapse into a `[Mapper]` partial class with one `partial` method per direction | high |
| `ForMember(... MapFrom ...)` | Replaced by `[MapProperty]` or a private user-mapping method | high |
| `ReverseMap()` | No auto-reverse; you declare the return-direction method explicitly | medium |
| `IValueResolver` / `ITypeConverter` with DI | Replaced by a constructor on the mapper plus a private method | medium |
| `ProjectTo<T>(config)` | Replaced by a generated `IQueryable<T>` projection extension | medium |
| `AddAutoMapper(assembly)` scan | Replaced by explicit `AddSingleton<TMapper>()` registration | medium |
| `mapper.Map(object, type)` (dynamic) | No untyped runtime entry point; every map is a typed method | high |
| `AssertConfigurationIsValid()` test | Redundant; the build is the assertion | low |

## Pre-flight checklist

1. **Install the .NET 11 SDK** and confirm `dotnet --version` reports `11.0.x`.
2. **Inventory your maps.** Run a grep for `CreateMap<` to count configurations and for `\.Map<` and `ProjectTo<` to count call sites. This is your migration scope.
3. **Find the dynamic maps.** Grep for `Map(` calls that pass a `Type` argument or an `object` source. These have no direct Mapperly equivalent and need a typed method or a manual switch; deal with them first.
4. **Find the resolvers.** Grep for `IValueResolver`, `ITypeConverter`, and `IMappingAction`. Each needs a private method on the mapper.
5. **Back up nothing special, branch normally.** This change is reversible per file (see Rollback), so a feature branch is enough.

## Migration steps

### 1. Add Mapperly alongside AutoMapper

Install both packages so you can migrate one profile at a time:

```bash
# .NET 11 SDK, run from the project directory
dotnet add package Riok.Mapperly --version 4.3.1
```

Mapperly ships only an analyzer and the `Riok.Mapperly.Abstractions` attributes, so it adds no runtime dependency. Verify the build still succeeds: `dotnet build` with zero new errors. Leave the AutoMapper package referenced until the last profile is gone.

### 2. Convert a simple profile to a `[Mapper]` class

Take the smallest profile first. The before:

```csharp
// AutoMapper 15.0
public class CarProfile : Profile
{
    public CarProfile()
    {
        CreateMap<Car, CarDto>();
    }
}
```

The after is a partial class with one partial method. Mapperly fills in the body:

```csharp
// .NET 11, C# 14, Riok.Mapperly 4.3.1
using Riok.Mapperly.Abstractions;

[Mapper]
public partial class CarMapper
{
    public partial CarDto ToDto(Car car);
}
```

Verify: build the project and open the generated file (it appears under the analyzer output, or set `<EmitCompilerGeneratedFiles>true</EmitCompilerGeneratedFiles>` in the `.csproj` to write it to disk). Confirm every `CarDto` property is assigned. If one is not, Mapperly emits a diagnostic such as `RMG020` for an unmapped target member; that is the feature, not a failure.

### 3. Translate `ForMember` to `[MapProperty]`

AutoMapper's per-member customization maps onto Mapperly attributes. A rename:

```csharp
// AutoMapper 15.0
CreateMap<Car, CarDto>()
    .ForMember(d => d.ModelName, o => o.MapFrom(s => s.Model));
```

becomes a `[MapProperty]` attribute naming the source and target members:

```csharp
// .NET 11, C# 14, Riok.Mapperly 4.3.1
[MapProperty(nameof(Car.Model), nameof(CarDto.ModelName))]
public partial CarDto ToDto(Car car);
```

For a computed value, AutoMapper's inline `MapFrom` lambda becomes a private user-mapping method referenced by `Use`:

```csharp
// .NET 11, C# 14, Riok.Mapperly 4.3.1
[Mapper]
public partial class CarMapper
{
    [MapProperty(nameof(Car.Price), nameof(CarDto.Price), Use = nameof(FormatPrice))]
    public partial CarDto ToDto(Car car);

    private string FormatPrice(decimal price) => price.ToString("C");
}
```

To drop a property deliberately, replace AutoMapper's `Ignore()` with `[MapperIgnoreTarget(nameof(CarDto.Internal))]` or `[MapperIgnoreSource(nameof(Car.Secret))]`. Verify each conversion by checking the generated body assigns exactly the members you expect.

### 4. Replace `ReverseMap()` with an explicit method

AutoMapper's `ReverseMap()` is one call. Mapperly has no auto-reverse, so declare the return direction as its own method on the same mapper:

```csharp
// .NET 11, C# 14, Riok.Mapperly 4.3.1
[Mapper]
public partial class CarMapper
{
    public partial CarDto ToDto(Car car);
    public partial Car ToEntity(CarDto dto);
}
```

This is more code, but it is honest: the reverse map is no longer implied, so an asymmetric property (a target field with no source) surfaces as its own diagnostic instead of being silently ignored. Verify both generated bodies.

### 5. Move resolvers with dependencies onto the mapper's constructor

An AutoMapper `IValueResolver` that needs an injected service:

```csharp
// AutoMapper 15.0
public class PriceResolver : IValueResolver<Car, CarDto, string>
{
    private readonly ICurrencyService _currency;
    public PriceResolver(ICurrencyService currency) => _currency = currency;
    public string Resolve(Car s, CarDto d, string m, ResolutionContext ctx)
        => _currency.Format(s.Price);
}
```

becomes a constructor on the mapper plus a private method. Mapperly generates a constructor that forwards your declared parameters, so the mapper participates in normal constructor injection:

```csharp
// .NET 11, C# 14, Riok.Mapperly 4.3.1
[Mapper]
public partial class CarMapper
{
    private readonly ICurrencyService _currency;
    public CarMapper(ICurrencyService currency) => _currency = currency;

    [MapProperty(nameof(Car.Price), nameof(CarDto.Price), Use = nameof(FormatPrice))]
    public partial CarDto ToDto(Car car);

    private string FormatPrice(decimal price) => _currency.Format(price);
}
```

Verify by resolving the mapper from the container in a test and asserting the formatted price.

### 6. Convert `ProjectTo<T>` to a generated projection

AutoMapper's `ProjectTo<T>()` builds an `Expression` tree so EF Core can translate the map into SQL. Mapperly generates the same kind of `IQueryable` extension when you declare a method that takes and returns `IQueryable<T>`:

```csharp
// .NET 11, C# 14, Riok.Mapperly 4.3.1
[Mapper]
public static partial class CarQueryMapper
{
    public static partial IQueryable<CarDto> ProjectToDto(this IQueryable<Car> q);
}
```

The call site changes from `.ProjectTo<CarDto>(_config)` to `.ProjectToDto()`:

```csharp
// .NET 11, EF Core 11
var dtos = await db.Cars
    .Where(c => c.NumberOfSeats > 4)
    .ProjectToDto()
    .ToListAsync();
```

Verify by capturing the generated SQL (`db.Cars...ToQueryString()` or EF Core logging) and confirming the projection runs in the database, not in memory. Note Mapperly's projection path does not run object factories or custom object-creating methods, because it must produce a translatable expression tree.

### 7. Replace DI registration

Delete the AutoMapper registration and the assembly scan:

```csharp
// AutoMapper 15.0 - remove this
builder.Services.AddAutoMapper(typeof(CarProfile).Assembly);
```

Register each mapper explicitly. A mapper with no injected dependencies is stateless and thread-safe, so register it as a singleton; one with a scoped dependency must match that lifetime:

```csharp
// .NET 11
builder.Services.AddSingleton<CarMapper>();        // no dependencies
builder.Services.AddScoped<InvoiceMapper>();       // depends on a scoped service
```

Then change consumers from `IMapper` to the concrete mapper. `_mapper.Map<CarDto>(car)` becomes `_carMapper.ToDto(car)`. Static mappers need no registration at all; call `CarQueryMapper.ProjectToDto(query)` directly. Verify the app boots: a missing registration is now a startup `InvalidOperationException`, which is exactly the early failure you want.

### 8. Remove AutoMapper

Once `grep` for `using AutoMapper` and `CreateMap<` returns nothing, drop the package:

```bash
dotnet remove package AutoMapper
```

Verify with a clean `dotnet build` and a full `dotnet test` run.

## Verification

Run this checklist after the last profile is gone:

- `dotnet build` produces zero errors and you have reviewed every `RMG` diagnostic, treating unmapped-member warnings as intentional or fixing them.
- `dotnet test` passes with zero failures, including any test that previously called `AssertConfigurationIsValid()` (delete those; the build is now the assertion).
- The projection queries still translate to SQL: confirm with `ToQueryString()` that no `ProjectToDto()` falls back to client evaluation.
- For an AOT or trimmed build, `dotnet publish -c Release` produces no `IL2xxx` trim warnings that previously came from AutoMapper's reflection.
- A cold-start-sensitive workload starts measurably faster; the first map no longer pays an expression-compilation cost.

## Rollback plan

This migration is reversible per file, which is its main safety property. Because you kept AutoMapper referenced through step 7, any single mapper that misbehaves can be reverted by restoring its `Profile` and switching that one consumer back to `IMapper`; the two systems coexist with no conflict. The only one-way moment is step 8, removing the package. Do not delete AutoMapper until every consumer is converted and the full test suite is green. If you are nervous, ship the mapper conversions in one release and the package removal in the next.

## Gotchas we hit

- **`RMG020` on properties you did mean to drop.** Mapperly warns when a source member maps to nothing. Silence it deliberately with `[MapperIgnoreSource(...)]` rather than suppressing the diagnostic globally, so the next unintended drop still warns.
- **Flattening is not automatic the way you expect.** AutoMapper flattens `Order.Customer.Name` into `OrderDto.CustomerName` by naming convention. Mapperly supports nested-member flattening, but if your DTO name does not match the dotted source path, you must spell it out with `[MapProperty([nameof(Order.Customer), nameof(Customer.Name)], nameof(OrderDto.CustomerName))]`.
- **No untyped `Map(object, Type)`.** If you had a generic pipeline that mapped `object` to a runtime `Type`, there is no source-generated equivalent. Replace it with a typed method per pair, or keep a tiny hand-written switch. This is the one place a clean swap is impossible.
- **Record `init` and primary-constructor targets.** Mapperly maps through the constructor when a target is a `record` or has only `init` setters, which is usually what you want; if it picks the wrong constructor, disambiguate with `[MapperConstructor]`. AutoMapper's behavior here was looser, so a previously-working map can surface a real ambiguity. For background on the target shapes, see [record vs class vs struct in C#](/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/).
- **Enum mapping is stricter by name.** Mapperly maps enums by value by default and can warn on unmapped enum members, where AutoMapper silently passed through the integer. Decide explicitly between by-value and by-name with the `[MapEnum]` strategy.

If you want to understand how the generator does this at compile time before you trust it in production, the mechanics are the same ones covered in [how to write a source generator for INotifyPropertyChanged](/2026/04/how-to-write-a-source-generator-for-inotifypropertychanged/).

## Sources

- [AutoMapper and MediatR Commercial Editions Launch Today](https://www.jimmybogard.com/automapper-and-mediatr-commercial-editions-launch-today/), Jimmy Bogard
- [AutoMapper and MediatR Licensing Update](https://www.jimmybogard.com/automapper-and-mediatr-licensing-update/), Jimmy Bogard
- [Mapperly documentation: configuration and queryable projections](https://mapperly.riok.app/docs/configuration/mapper/)
- [riok/mapperly on GitHub](https://github.com/riok/mapperly) and [Riok.Mapperly 4.3.1 on NuGet](https://www.nuget.org/packages/Riok.Mapperly)
