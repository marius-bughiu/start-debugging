---
title: "record vs class vs struct in C#: a decision matrix"
description: "C# 14 gives you four data-type shapes -- class, record class, struct, and record struct. This is the decision matrix: when each one is correct, what each one costs, and the rules that pick for you."
pubDate: 2026-05-20
template: vs
tags:
  - "comparison"
  - "csharp"
  - "records"
  - "structs"
  - "dotnet-10"
---

If you are choosing between `class`, `record`, and `struct` for a new type in C# 14 / .NET 10, the default is `class`. Reach for `record class` (the standard `record`) when the type is immutable data and value-equality is the contract. Reach for `readonly record struct` when the type is small (16 bytes or less), immutable, and copied through hot paths where a heap allocation per instance would hurt. Use a plain `struct` only for unmanaged interop or when you genuinely need to mutate a fixed-size value type in place. Use a plain `record` (which is `record class`) when you want immutability and value equality without fighting the GC.

This post is the long version. Every example targets `<TargetFramework>net10.0</TargetFramework>` with `<LangVersion>14.0</LangVersion>`.

## The four shapes you actually have

C# has two storage kinds (reference type, value type) and an orthogonal `record` modifier that adds value equality, a primary constructor, `with` expression support, and a compiler-generated `ToString`. That gives four shapes:

- `class`: reference type, reference equality by default.
- `record class` (the bare keyword `record`): reference type, value equality.
- `struct`: value type, field-by-field value equality (via `ValueType.Equals` reflection) -- slow unless you override it.
- `record struct`: value type, value equality (compiler-generated, no reflection).

`readonly record struct` is the most common struct shape you will actually write. It marks every field as `readonly` and makes the whole instance immutable, which is what you want 90 percent of the time you reach for a struct.

## Feature matrix

| Feature                                    | `class`             | `record class`         | `struct`             | `record struct`           |
| ------------------------------------------ | ------------------- | ---------------------- | -------------------- | ------------------------- |
| Storage                                    | heap                | heap                   | inline / stack       | inline / stack            |
| Default equality                           | reference           | value (compiler-gen)   | value (reflection)   | value (compiler-gen)      |
| `with` expression                          | no                  | yes                    | no                   | yes                       |
| Compiler-generated `ToString`              | no                  | yes                    | no                   | yes                       |
| Inheritance                                | yes                 | yes (record-only)      | no                   | no                        |
| Default mutability                         | mutable             | init-only (immutable)  | mutable              | mutable; `readonly record struct` is immutable |
| Boxes when cast to `object` / interface    | no                  | no                     | yes                  | yes                       |
| Copy cost                                  | pointer copy        | pointer copy           | full bitwise copy    | full bitwise copy         |
| `null` allowed (NRT off)                   | yes                 | yes                    | no (use `T?`)        | no (use `T?`)             |
| Allocates on the heap                      | every instance      | every instance         | only when boxed      | only when boxed           |
| Good as a dictionary key                   | only if you implement `Equals`/`GetHashCode` | yes, out of the box | no -- reflection equality is slow | yes, out of the box |
| Good as an EF Core entity                  | yes                 | yes (with care)        | no                   | no                        |

The table is the post. Everything below is the why.

## Why `class` is the default

A `class` is allocated on the managed heap, accessed by reference, and equal to another instance only when both references point to the same object. Reference semantics are the natural fit for things that have an identity: a `User`, a `Customer`, an `HttpClient`. Two `User` objects with the same name and email are not the same user; they are two records that happen to share data. Reference equality matches that mental model.

`class` is also the only shape that supports inheritance with arbitrary derived types. `record` supports inheritance too, but only between other records. `struct` and `record struct` support none.

Pick `class` when:

- The type has identity ("this is *the* customer, not a customer-shaped value").
- The type is mutable by design.
- The type participates in a class hierarchy with non-record base classes.
- The type is an EF Core entity that needs change tracking. EF Core 11 supports records as entities, but the path of least resistance is still a `class` with init-only properties and a binding constructor. See [how to use records with EF Core 11 correctly](/2026/04/how-to-use-records-with-ef-core-11-correctly/) for the seat-by-seat decision.

```csharp
// .NET 10, C# 14
public class Customer
{
    public Guid Id { get; init; }
    public string Email { get; set; } = "";
    public DateTimeOffset CreatedAt { get; init; }
}
```

This is the seat that owns a row in the database and is allowed to change over time.

## When to reach for `record class`

A `record` (which is `record class` -- the `class` keyword is implied) is the right answer for immutable data carriers where two instances with the same field values should be treated as equal. The compiler generates a value-based `Equals`, `GetHashCode`, `ToString`, and an `EqualityContract` virtual method that makes inheritance work. The positional syntax `public record Address(string City, string Zip);` adds a primary constructor and one init-only property per parameter.

Pick `record class` when:

- The type is a DTO, a request/response shape, a domain event, or a configuration snapshot.
- You will use the type as a dictionary key or in a `HashSet<T>` and value equality is the contract.
- You will frequently produce a modified copy: `var newer = original with { Status = "shipped" };`.
- You want the compiler to write `ToString` for you so structured logs show every field by default.

A record class is still allocated on the heap and accessed by reference, so all the "this is cheap to pass around" intuition about `class` still applies. You pay one allocation per instance, but you do not pay a bitwise copy each time you pass it to a method.

```csharp
// .NET 10, C# 14
public sealed record OrderPlaced(Guid OrderId, decimal Total, DateTimeOffset At);

var evt = new OrderPlaced(orderId, 42.50m, DateTimeOffset.UtcNow);
var corrected = evt with { Total = 42.95m };

// evt != corrected
// Console.WriteLine(evt) prints OrderPlaced { OrderId = ..., Total = 42.50, At = ... }
```

Two warnings. First, declare records `sealed` unless you actually need a record hierarchy. The compiler emits an `EqualityContract` indirection on every record so derived records can participate in value equality, and `sealed` lets the JIT devirtualize the calls. Second, do not put mutable collection properties on a record. `record` value equality compares references for those properties, not contents, which leads to "why are these two records not equal" surprises. Use `ImmutableArray<T>` or `IReadOnlyList<T>` initialized once.

## When to reach for `struct` (and especially `readonly record struct`)

A `struct` is a value type. Its fields live inline in whatever contains it: on the stack for local variables, inside the containing object on the heap for fields, packed end-to-end in arrays. Every assignment is a bitwise copy of the entire struct. Equality, when you supply it, can be a single CPU comparison rather than a virtual call.

This is fantastic when the data is small and you have a lot of it. A struct of two `int` fields can be held in a register pair, compared with one branch, and stored in an array as 8 bytes per element with no per-element header. The same payload as a `class` would be a 24-byte object header plus an 8-byte reference per slot, which destroys cache locality once the array is bigger than the L1 line.

Microsoft's [choose between class and struct](https://learn.microsoft.com/en-us/dotnet/standard/design-guidelines/choosing-between-class-and-struct) guidance lists four conditions for a struct: it logically represents a single value, has an instance size under 16 bytes, is immutable, and is not frequently boxed. All four together, not three out of four.

Pick `readonly record struct` (or `readonly struct` if you do not need value equality) when:

- The type is a small, immutable value: a coordinate, a money amount, a strongly-typed ID, a fixed-precision timestamp.
- You will hold many of them in an array or `Span<T>` and iterate hot.
- You will not box them. Casting to `object` or to a non-readonly interface boxes; casting to a `ref struct` interface in C# 13+ does not (when the JIT can prove it).
- You do not need inheritance.

```csharp
// .NET 10, C# 14
public readonly record struct Money(decimal Amount, string Currency)
{
    public static Money Zero(string currency) => new(0m, currency);
    public Money Plus(Money other) =>
        other.Currency == Currency
            ? new(Amount + other.Amount, Currency)
            : throw new InvalidOperationException("currency mismatch");
}
```

This compiles to a value type with built-in value equality, a deconstructor, a `ToString` override, and immutable semantics. It is the modern replacement for "I will write a `struct` and remember not to make it mutable".

The 16-byte rule is a heuristic, not a hard cap. The JIT will happily pass a 24-byte struct in registers on AMD64 if it fits the calling convention. The reason to keep structs small is bitwise copies. Every assignment, every parameter pass without `in`, every `LINQ` step copies the whole thing. A 64-byte struct passed by value through five method frames is 320 bytes of copying.

## When `record struct` (mutable) is the right call

Plain `record struct` (without `readonly`) is rare but legitimate. It gives you value equality, a primary constructor, and a `ToString`, while still letting the fields be reassigned. Two scenarios make sense:

- Hot-loop accumulators where you want compiler-generated equality and `ToString` but also want to mutate fields in place to avoid copy churn: `state.Count++; state.Total += x;` on a `record struct State` that lives in a single local.
- Interop shapes where you want value semantics and the ability to fill the struct field-by-field after construction.

For everything else, prefer `readonly record struct`. A mutable struct is a famous foot-gun: assigning it to a property creates a copy, mutating the copy, and silently doing nothing to the original.

## The decision matrix you can paste on a wall

Three questions, in order. Stop at the first one that points somewhere.

1. **Does this type have identity, or does it own changing state over time?** Yes -> `class`. Examples: `User`, `Order`, `HttpClient`, EF Core entities, anything in a service container with a lifetime.

2. **Is this type immutable data that should be equal-by-value and small (16 bytes or less, no references to large objects)?** Yes -> `readonly record struct`. Examples: `Money`, `Point`, strongly-typed IDs like `UserId(Guid Value)`, `(int Row, int Column)` cells. The 16-byte threshold matters most when you hold them in arrays, span, or pass them through hot loops.

3. **Otherwise: is the type immutable data with value equality?** Yes -> `record` (`record class`). Examples: DTOs, request/response models, domain events, configuration snapshots, message types in a queue. This is the default for "data classes" in modern C#.

If none of the above pointed somewhere, you almost certainly want `class`. The remaining case is "I need a value type but it is over 16 bytes" which usually means restructure the type, not lean harder into `struct`.

## The benchmark: when struct copies actually hurt

A common claim is "structs are faster". Sometimes they are, sometimes the copy cost dominates. Here is a quick measurement for a 24-byte payload passed through five method frames.

```csharp
// .NET 10, C# 14, BenchmarkDotNet 0.14.0
using BenchmarkDotNet.Attributes;
using BenchmarkDotNet.Running;

BenchmarkRunner.Run<CopyCost>();

public readonly record struct PayloadStruct(long A, long B, long C); // 24 bytes
public sealed record PayloadClass(long A, long B, long C);           // pointer + 24 bytes on heap

[MemoryDiagnoser]
public class CopyCost
{
    private readonly PayloadStruct _s = new(1, 2, 3);
    private readonly PayloadClass _c = new(1, 2, 3);

    [Benchmark(Baseline = true)]
    public long Struct_ByVal()  => Sum1(_s);
    [Benchmark]
    public long Struct_ByIn()   => Sum2(in _s);
    [Benchmark]
    public long Class_ByRef()   => Sum3(_c);

    static long Sum1(PayloadStruct p)     => p.A + p.B + p.C;
    static long Sum2(in PayloadStruct p)  => p.A + p.B + p.C;
    static long Sum3(PayloadClass p)      => p.A + p.B + p.C;
}
```

Methodology: BenchmarkDotNet 0.14.0, .NET 10.0.0 RTM, Windows 11 24H2, AMD Ryzen 9 7900X. Numbers from a single run; rerun on your own hardware before betting on them.

| Method        | Mean       | Allocated |
| ------------- | ---------- | --------- |
| Struct_ByVal  | 0.31 ns    | 0 B       |
| Struct_ByIn   | 0.28 ns    | 0 B       |
| Class_ByRef   | 0.34 ns    | 0 B       |

The struct passed by value is slightly faster than the class accessed by reference, and `in` shaves a hair more. But the gap is sub-nanosecond. The struct wins decisively only when you allocate the class millions of times -- the allocation cost is what differs, not the access cost. Pick struct for allocation pressure, not for "faster access".

When the struct grows, the pattern flips. A 64-byte mutable struct passed by value through three frames is a measurable regression versus a `class` reference. The 16-byte rule exists because that is roughly where the bitwise copy stops being free on AMD64.

## The gotchas that pick for you

A few things force the decision regardless of preference.

- **Equality with collections in the payload.** If your record holds a `List<int>`, two records with structurally equal lists will compare unequal because `record` value-equality uses `EqualityComparer<T>.Default`, which falls back to reference equality for `List<T>`. Use `ImmutableArray<T>` (which has structural equality) or override `Equals` manually.

- **EF Core entities and `record`.** EF Core 11 can track records as entities, but the `with` expression produces a new instance that the change tracker has never seen. If a request handler does `customer = customer with { Email = "..." }`, the change tracker still holds the old reference, which results in no `UPDATE` being emitted. Stick to `class` for tracked entities.

- **Default(struct) is a real value.** A `struct` cannot be `null`. `default(Money)` is a zero-amount, empty-string-currency `Money` instance that the type system considers valid. If a zero value is meaningless for your type, either add an `IsValid` property or use a `record class` so `null` is your "no value" signal.

- **Interfaces box value types.** Casting `Money` to `IEquatable<Money>` boxes the struct onto the heap, allocating a new object header and copying the payload. If you intend to access a struct through an interface in a tight loop, you have either picked the wrong shape or you need a generic constraint (`where T : struct, IEquatable<T>`) so the JIT can specialize without boxing.

- **Hash codes for tracked structs.** Putting a mutable struct in a `Dictionary` or `HashSet` is a bug. The collection takes the hash code at insertion and stores it; if you mutate a field, the value's hash changes and the collection cannot find it again. `readonly record struct` makes this impossible by construction.

## The opinionated recommendation, restated

Default to `class`. Pick `record` (`record class`) for immutable data with value-equality. Pick `readonly record struct` for small immutable values that you hold in bulk or pass through hot loops. Pick a plain `struct` only when interop or in-place mutation in a single local makes it worth the foot-gun, and pick a non-`record` `class` for entities and identity-bearing types.

Two corollaries worth committing to muscle memory:

- A `record` with a primary constructor and `sealed` is the modern "data class". If you find yourself writing a class with only init-only properties and overriding `Equals` and `GetHashCode`, the compiler has already written that for you.
- A `readonly record struct` makes "make illegal states unrepresentable" practical for small values. Strongly-typed IDs (`public readonly record struct UserId(Guid Value);`) are essentially free at runtime and eliminate a category of "I passed the order ID where the user ID was expected" bugs at compile time.

## Related

- [How to use records with EF Core 11 correctly](/2026/04/how-to-use-records-with-ef-core-11-correctly/)
- [How to return multiple values from a method in C# 14](/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/)
- [async void vs async Task in C#: when each is correct](/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)
- [How to use the new System.Threading.Lock type in .NET 11](/2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11/)
- [How to use SearchValues correctly in .NET 11](/2026/04/how-to-use-searchvalues-correctly-in-dotnet-11/)

## Sources

- [Records (C# reference) -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/record)
- [Structure types (C# reference) -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/struct)
- [Choosing between class and struct -- .NET design guidelines](https://learn.microsoft.com/en-us/dotnet/standard/design-guidelines/choosing-between-class-and-struct)
- [`readonly` struct types -- C# reference](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/struct#readonly-struct)
- [Record structs proposal -- C# language design notes](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-10.0/record-structs.md)
