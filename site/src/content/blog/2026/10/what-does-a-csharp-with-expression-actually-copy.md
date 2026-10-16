---
title: "What Does a C# `with` Expression Actually Copy, and Why Don't Computed Record Properties Recalculate?"
description: "A with expression calls the record's compiler-generated <Clone>$ method, which runs a copy constructor that copies every instance field and skips all initializers. That is why properties initialized from other properties, cached values, and Guid IDs come out stale. Measured on .NET 10 with C# 14, with the fixes that actually work."
pubDate: 2026-10-16
tags:
  - "csharp"
  - "csharp-14"
  - "records"
  - "dotnet-10"
  - "immutability"
---

**Short answer:** in C# 14 on .NET 10 (and every version since records arrived in C# 9), `a with { X = 1 }` on a record class does two things: it calls the compiler-generated `<Clone>$` method, which calls the record's copy constructor, and then it runs the `init` accessors you listed, in order. The copy constructor copies **every instance field** byte for byte (a shallow copy) and does **not** run any field or property initializers. So a property like `public string FullName { get; } = $"{First} {Last}";` is computed once in the original constructor, copied as a stored value, and never recalculated. Make derived values expression-bodied (`=> $"{First} {Last}"`), or reset caches inside the `init` accessors of the properties they depend on.

The rest of this post shows exactly what the compiler generates, which kinds of "computed" members survive a `with` and which do not, a nasty equality side effect of caching inside a record, and the patterns that hold up. Every output below comes from file-based apps (`dotnet run probe.cs`) on SDK 10.0.302, runtime 10.0.10.

## What the compiler generates for a record

Take a plain positional record:

```csharp
// .NET 10, C# 14
record Person(string First, string Last);
```

Besides the primary constructor, properties, equality, and `ToString`, the compiler emits two copying members. The [records specification](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-9.0/records.md#copy-and-clone-members) calls them the "copy constructor" and the "clone" method. You can see both with reflection:

```csharp
// .NET 10, C# 14
using System.Reflection;

foreach (var m in typeof(Person).GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly)
                                .Where(m => m.Name.Contains("Clone")))
    Console.WriteLine($"method: {m.Name} virtual={m.IsVirtual} returns {m.ReturnType.Name}");

foreach (var c in typeof(Person).GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
    Console.WriteLine($"ctor: ({string.Join(",", c.GetParameters().Select(p => p.ParameterType.Name))}) protected={c.IsFamily}");
```

Output:

```text
method: <Clone>$ virtual=True returns Person
ctor: (String,String) protected=False
ctor: (Person) protected=True
```

`<Clone>$` is a name you cannot type in C#, so only the compiler can call it. Its body is simply `return new Person(this);`. The protected `Person(Person original)` constructor is where the copy happens, and the spec is precise about what it does: after calling the base copy constructor (or `object()`), it "copies values for all instance fields implicitly or explicitly declared within the record type", and it "doesn't run any instance field/property initializers present in the record declaration."

So this:

```csharp
var b = a with { First = "Grace" };
```

is lowered to roughly:

```csharp
var tmp = a.<Clone>$();   // new Person(a): field-by-field copy, no initializers
tmp.First = "Grace";       // the init accessor, legal here because the compiler emits it
var b = tmp;
```

Two consequences fall straight out of that lowering. First, nothing you wrote in the record body runs during the copy except the `init` accessors of the members you name. Second, those `init` accessors run after the copy, against an instance that already holds every field of the original.

## Four ways to write a "computed" property, four different results

Here is a record with four members that all look like they derive from `First` and `Last`:

```csharp
// .NET 10, C# 14
record Name(string First, string Last)
{
    public string Init { get; } = $"{First} {Last}";   // property initializer
    public string Expr => $"{First} {Last}";            // expression-bodied
    private string? _cached;
    public string Cached => _cached ??= $"{First} {Last}"; // lazy cache in a field
}
```

And a run that touches the cache before copying:

```csharp
var a = new Name("Ada", "Lovelace");
Console.WriteLine(a.Cached);              // fills the cache on a
var b = a with { First = "Grace" };
Console.WriteLine($"{b.Init} | {b.Expr} | {b.Cached}");
Console.WriteLine(b);
```

Output:

```text
Ada Lovelace
Ada Lovelace | Grace Lovelace | Ada Lovelace
Name { First = Grace, Last = Lovelace, Init = Ada Lovelace, Expr = Grace Lovelace, Cached = Ada Lovelace }
```

Only the expression-bodied property is correct. The reasons map one to one onto the lowering above:

- **`Init { get; } = ...`** is backed by a hidden `<Init>k__BackingField`. The initializer ran once, inside `a`'s primary constructor. The copy constructor copied the backing field as a string and did not rerun the initializer. `First` changed afterwards, but nothing ever reassigns `Init`.
- **`Expr => ...`** has no backing field. It is a method that reads `First` and `Last` on every call, so it reflects whatever the copy holds now.
- **`Cached => _cached ??= ...`** is the subtle one. If you call `with` *before* anyone reads `Cached` on the original, `_cached` is still `null`, gets copied as `null`, and the copy computes the correct value. If the original's cache is already filled, the copy inherits `"Ada Lovelace"` and the `??=` never fires. The bug depends on whether some unrelated code path happened to read the property first, which makes it miserable to reproduce.

The same thing happens to anything a field initializer produces. A record with `public Guid Id { get; } = Guid.NewGuid();` keeps the **same** `Id` in every `with` copy. I confirmed the initializer simply does not execute with a counter:

```csharp
// .NET 10, C# 14
var t = new Tracked("x");
var t2 = t with { Value = "y" };
Console.WriteLine($"initializer runs: {Counter.Count}, stamp same: {t.Stamp == t2.Stamp}");

static class Counter { public static int Count; }
record Tracked(string Value)
{
    public long Stamp { get; } = ++Counter.Count;
}
```

```text
initializer runs: 1, stamp same: True
```

One construction, one initializer run, two instances. If you use records for events or commands with a generated ID or timestamp, `with` gives you a second object claiming to be the same event.

## The equality trap: hidden fields participate in `==`

Record equality is also synthesized from instance fields, and that includes private ones. The stale copy above is therefore not equal to a freshly built record with the same visible data:

```csharp
var c = new Name("Grace", "Lovelace");
Console.WriteLine(b == c); // False: b.Init and b._cached still say "Ada Lovelace"
```

Worse, a lazy cache makes equality depend on *read history*, even without any `with`:

```csharp
// .NET 10, C# 14
var x = new Name2("Ada", "Lovelace");
var y = new Name2("Ada", "Lovelace");
Console.WriteLine(x == y);   // True
_ = x.FullName;              // only reads a property
Console.WriteLine(x == y);   // False

record Name2(string First, string Last)
{
    private string? _fullName;
    public string FullName => _fullName ??= $"{First} {Last}";
}
```

```text
True
False
```

Reading a getter changed the result of `==`. If those records are dictionary keys, set members, or are compared in a test assertion, you get failures that disappear when you add a `Console.WriteLine` to debug them. This is the strongest argument against caching in a record at all.

## It is a shallow copy, all the way down

The copy constructor copies field values. For reference-type fields, the value is a reference, so both records point at the same object:

```csharp
// .NET 10, C# 14
var o = new Order(1, new List<string> { "apple" });
var o2 = o with { Id = 2 };
o2.Items.Add("pear");
Console.WriteLine($"o.Items: {string.Join(",", o.Items)} same list: {ReferenceEquals(o.Items, o2.Items)}");

record Order(int Id, List<string> Items);
```

```text
o.Items: apple,pear same list: True
```

The same holds for a `Lazy<T>` field (both copies share the already-evaluated `Lazy`), a `StringBuilder`, or a nested mutable class. A record is only as immutable as its least immutable field. Prefer `ImmutableArray<T>` or `IReadOnlyList<T>` backed by an array you never mutate, and treat `with` as "copy the top level".

## Inheritance: `with` keeps the runtime type

`<Clone>$` is virtual, and each derived record overrides it with a covariant return type. A `with` through a base-typed variable produces the derived type:

```csharp
// .NET 10, C# 14
Person p = new Student("Alan", "Turing", "King's");
var q = p with { First = "Alonzo" };
Console.WriteLine(q.GetType().Name); // Student

record Person(string First, string Last);
record Student(string First, string Last, string College) : Person(First, Last);
```

Reflection on `Student` shows `<Clone>$ returns Student`. That is usually what you want, but it means `with` on a base reference copies derived-only state (here `College`) that the calling code cannot even see, including any stale cached fields declared in the derived record.

For a `sealed record`, the compiler makes the copy constructor `private` and `<Clone>$` non-virtual (the probe printed `sealed copy ctor private: True; clone virtual: False`).

## What a `with` expression is allowed to assign

Because `with` runs accessors after the clone, it can only set members that have a `set` or `init` accessor and are accessible at the call site. Trying to "fix" a stale computed property by assigning it fails:

```csharp
// .NET 10, C# 14
record A(int X) { public int Computed { get; } = X * 2; }

var b = new A(1) with { Computed = 3 };
// error CS0200: Property or indexer 'A.Computed' cannot be assigned to -- it is read only
```

`with` on an ordinary class is rejected outright, because a class has no `<Clone>$`:

```text
error CS8858: The receiver type 'Svc' is not a valid record type and is not a struct type.
```

Since C# 10, `with` also works on structs (including `record struct`), tuples, and anonymous types. For those there is no clone method and no copy constructor: the value is copied the way any struct assignment copies it, then the listed members are assigned. The [`with` expression docs](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/operators/with-expression) state plainly that you cannot customize copy semantics for structure types.

`required` members do not force you to repeat themselves in a `with`. The synthesized copy constructor is marked `[SetsRequiredMembers]`, so `r with { }` on a record with `required string Name` compiles and copies `Name`. If `required` members confuse you in initializers, the [CS9035 walkthrough](/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/) covers the object-initializer side.

## Fixes that actually hold up

### 1. Compute on access (the default answer)

```csharp
// .NET 10, C# 14
record Name(string First, string Last)
{
    public string FullName => $"{First} {Last}";
}
```

No backing field, nothing to copy, nothing to go stale, and nothing extra in `Equals`/`GetHashCode`. Microsoft's own guidance on the `with` page says the same: computed properties in records "should be computed on access, not initialized when the instance is created." Interpolating two strings is cheap; measure before you decide it is not.

### 2. Validate or recompute in `init` accessors

`init` accessors are the one piece of your code that does run during a `with`. C# 14's [`field` keyword](/2025/04/c-14-the-field-keyword-and-field-backed-properties/) makes it easy to put logic there without declaring a backing field. Validation works as you would hope:

```csharp
// .NET 10, C# 14
record Person(string First, string Last)
{
    public string Last { get; init => field = string.IsNullOrEmpty(value)
        ? throw new ArgumentException("Last required")
        : value; } = Last;
}

var bad = new Person("Ada", "Lovelace") with { Last = "" }; // throws ArgumentException: Last required
```

If a value really is expensive and you must cache it, invalidate the cache from the inputs' `init` accessors, and take the cache out of equality:

```csharp
// .NET 10, C# 14
record Name(string First, string Last)
{
    private string? _fullName;
    public string First { get; init { field = value; _fullName = null; } } = First;
    public string Last  { get; init { field = value; _fullName = null; } } = Last;
    public string FullName => _fullName ??= $"{First} {Last}";

    public virtual bool Equals(Name? other) =>
        other is not null && EqualityContract == other.EqualityContract
        && First == other.First && Last == other.Last;
    public override int GetHashCode() => HashCode.Combine(First, Last);
}
```

With this version, `a with { First = "Grace" }` prints `Grace Lovelace` even when `a.FullName` was read first, and `b == new Name("Grace", "Lovelace")` is `True`. The cost is that you now maintain `Equals` and `GetHashCode` by hand, and the compiler will not warn you when you add a property and forget to include it.

### 3. Write your own copy constructor

You can declare the copy constructor yourself and copy only what should survive:

```csharp
// .NET 10, C# 14
record Fixed(string First, string Last)
{
    private string? _full;
    public string FullName => _full ??= $"{First} {Last}";

    protected Fixed(Fixed original)
    {
        First = original.First;
        Last = original.Last;
        // _full deliberately not copied
    }
}
```

This works (`f with { First = "Grace" }` gives `Grace Lovelace` after the original's cache was filled), and it is the documented way to deep-copy a list. It also has the sharpest edges:

- You now own the copying of **every** field. Add a property next month, forget this constructor, and `with` silently resets it to `default`.
- In a derived record you must chain to the base copy constructor. Leave it out and you get two errors, `CS1729: 'Base' does not contain a constructor that takes 0 arguments` and `CS8868: A copy constructor in a record must call a copy constructor of the base, or a parameterless object constructor if the record inherits from object.` The fix is `protected Derived(Derived other) : base(other) { ... }`.
- It must be `public` or `protected` unless the record is sealed.
- It does nothing for `Equals`: a cache field still makes `==` depend on read history.

Use it for deep copies of collections, not as a cache-invalidation mechanism.

### 4. Do not put identity in an initializer

For IDs and timestamps that must be unique per instance, do not generate them in a property initializer on a record you intend to `with`. Either pass them in explicitly (`evt with { Id = Guid.NewGuid() }`) or create new events through a factory instead of `with`. Copying an event and keeping its ID is exactly what `with` is designed to do.

## A checklist for record types you `with`

- Every derived value is expression-bodied, or recomputed from `init` accessors.
- No private cache fields, unless you also override `Equals` and `GetHashCode`.
- No mutable collections, or a custom copy constructor that clones them.
- No `= Guid.NewGuid()` or `= DateTime.UtcNow` initializers on types that get copied.
- Derived records that declare a copy constructor chain to `base(original)`.

If you are deciding whether a type should be a record at all, the [record vs class vs struct decision matrix](/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) covers the trade-offs, and the EF Core angle (a `with` copy is an instance the change tracker has never seen) is in [how to use records with EF Core 11 correctly](/2026/04/how-to-use-records-with-ef-core-11-correctly/). Dart developers hit the same shallow-copy question with `copyWith`, discussed in [Dart records vs Freezed classes](/2026/05/dart-records-vs-freezed-classes/).

## Related

- [Record vs class vs struct in C#: a decision matrix](/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/)
- [How to use records with EF Core 11 correctly](/2026/04/how-to-use-records-with-ef-core-11-correctly/)
- [C# 14: the `field` keyword and field-backed properties](/2025/04/c-14-the-field-keyword-and-field-backed-properties/)
- [Fix CS9035: required member must be set in the object initializer](/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/)

## Sources

- [The `with` expression, C# reference (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/operators/with-expression)
- [Records, nondestructive mutation (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/record#nondestructive-mutation)
- [Records proposal, "Copy and Clone members" (dotnet/csharplang)](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-9.0/records.md#copy-and-clone-members)
- [The `field` keyword (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/field)
