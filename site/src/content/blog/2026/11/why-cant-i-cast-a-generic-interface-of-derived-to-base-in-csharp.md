---
title: "Why can't I cast IDisplayVM<Derived> to IDisplayVM<Base> in C#, and when does out variance fix it?"
description: "A class that implements IDisplayVM<DiseaseDTO> does not implement IDisplayVM<IDTO>, so the assignment fails with CS0266, 'as' returns null and an explicit cast throws InvalidCastException. Marking T as 'out' fixes it only if T never appears in an input position; with ICollection<T> or a setter you get CS1961. Reproduced on .NET 11 with the four designs that actually work, benchmarked."
pubDate: 2026-11-26
tags:
  - "dotnet"
  - "csharp"
  - "dotnet-11"
  - "generics"
  - "variance"
---

**Short answer:** `IDisplayVM<DiseaseDTO>` and `IDisplayVM<IDTO>` are two unrelated types. The fact that `DiseaseDTO` implements `IDTO` does not carry over to the generic interface unless the interface declares its type parameter covariant with `out T`, so the compiler reports CS0266, `as` returns `null`, and an explicit cast compiles but throws `InvalidCastException` at runtime. `out T` is only legal when `T` appears exclusively in output positions (return types, getter-only properties, other covariant interfaces such as `IEnumerable<T>` or `IReadOnlyList<T>`). An `ICollection<T> Data { get; set; }` property or a `void Add(T item)` method makes the compiler reject `out` with CS1961. For a view model, the usual fix is to split the interface: a non-generic `IDisplayVM` for members that do not mention `T` (`PushData()`), an optional covariant `IDisplayVMRead<out T>` for reading items, and the invariant `IDisplayVM<T>` for editing. Everything below was compiled with SDK 11.0.100 (C# 14) and run on .NET 11.0.0, macOS arm64.

The question comes from a [Stack Overflow post](https://stackoverflow.com/questions/80012592) about a WPF app: a navigation store hands back the current view model as a `BaseVM`, every table has its own `XxxDisplayVM : BaseVM, IDisplayVM<XxxDTO>`, and the author wants to treat all of them as `IDisplayVM<IDTO>` to call `PushData()` and read `Data` without writing one branch per table.

## The repro: CS0266 at compile time, null or InvalidCastException at runtime

```csharp
// .NET 11, C# 14
using System.Collections.ObjectModel;

public interface IDTO { int Id { get; } }
public sealed class DiseaseDTO : IDTO { public int Id { get; init; } public string Name { get; init; } = ""; }
public abstract class BaseVM { }

public interface IDisplayVM<T> where T : class, IDTO
{
    ICollection<T> Data { get; set; }
    void PushData();
}

public class DiseasesDisplayVM : BaseVM, IDisplayVM<DiseaseDTO>
{
    public ICollection<DiseaseDTO> Data { get; set; } = new ObservableCollection<DiseaseDTO>();
    public void PushData() { }
}

BaseVM current = new DiseasesDisplayVM();
IDisplayVM<IDTO> a = current as DiseasesDisplayVM;                      // CS0266
ObservableCollection<IDTO> b = new ObservableCollection<DiseaseDTO>();  // CS0029
```

`dotnet build` output:

```text
error CS0266: Cannot implicitly convert type 'DiseasesDisplayVM' to 'IDisplayVM<IDTO>'. An explicit conversion exists (are you missing a cast?)
error CS0029: Cannot implicitly convert type 'System.Collections.ObjectModel.ObservableCollection<DiseaseDTO>' to 'System.Collections.ObjectModel.ObservableCollection<IDTO>'
```

The "explicit conversion exists" hint in CS0266 is a trap. It exists only because `DiseasesDisplayVM` is not sealed, so in theory some subclass could also implement `IDisplayVM<IDTO>`. Following the hint moves the failure to runtime:

```csharp
// .NET 11, C# 14
Console.WriteLine(current as IDisplayVM<IDTO>);        // null
Console.WriteLine(current is IDisplayVM<DiseaseDTO>);  // True
var x = (IDisplayVM<IDTO>)current;                     // throws
```

```text
current as IDisplayVM<IDTO>       -> null
current is IDisplayVM<DiseaseDTO> -> True
(IDisplayVM<IDTO>)current         -> InvalidCastException: Unable to cast object of type 'DiseasesDisplayVM' to type 'IDisplayVM`1[IDTO]'.
```

The second error, CS0029 for `ObservableCollection<IDTO>`, has no "explicit conversion exists" hint, because `ObservableCollection<T>` is a class, and classes can never be variant. No modifier, cast or pattern will turn one into the other.

## Why the relationship between DiseaseDTO and IDTO does not carry over

A generic type instantiation is its own type. `IDisplayVM<DiseaseDTO>` and `IDisplayVM<IDTO>` are as unrelated to the runtime as `IFoo` and `IBar`, unless the interface says otherwise.

The reason C# cannot assume a relationship is that it would be unsafe. If `DiseasesDisplayVM` could be viewed as `IDisplayVM<IDTO>`, this would compile:

```csharp
// .NET 11, C# 14 - hypothetical, does not compile
IDisplayVM<IDTO> vm = new DiseasesDisplayVM();
vm.Data.Add(new PatientDTO());   // a PatientDTO inside an ICollection<DiseaseDTO>
vm.Data = new List<PatientDTO>(); // and a setter that accepts the wrong list
```

Reading a `DiseaseDTO` through an `IDTO`-typed reference is always fine. Writing an arbitrary `IDTO` into something that only holds `DiseaseDTO` is not. This is the same reason `List<string>` is not a `List<object>`, while `IEnumerable<string>` is an `IEnumerable<object>`: `IEnumerable<T>` only ever hands values out.

C# 4.0 added a way for an interface to promise that direction. That promise is the `out` modifier on the type parameter, documented in [Covariance and contravariance in generics](https://learn.microsoft.com/en-us/dotnet/standard/generics/covariance-and-contravariance).

## When `out T` fixes it, and the CS1961 errors when it cannot

Adding `out` to the original interface does not compile, and the errors tell you exactly which members are the problem:

```csharp
// .NET 11, C# 14
public interface IDTO { int Id { get; } }

public interface IDisplayVM<out T> where T : class, IDTO
{
    ICollection<T> Data { get; set; }   // invariant use of T
    void Select(T item);                // T as input
    T Current { get; set; }             // setter is an input
    void PushData();
}

// Classes cannot declare variance at all
public class Box<out T> { }
```

```text
Program.cs(6,5): error CS1961: Invalid variance: The type parameter 'T' must be invariantly valid on 'IDisplayVM<T>.Data'. 'T' is covariant.
Program.cs(7,17): error CS1961: Invalid variance: The type parameter 'T' must be contravariantly valid on 'IDisplayVM<T>.Select(T)'. 'T' is covariant.
Program.cs(8,5): error CS1961: Invalid variance: The type parameter 'T' must be invariantly valid on 'IDisplayVM<T>.Current'. 'T' is covariant.
Program.cs(13,18): error CS1960: Invalid variance modifier. Only interface and delegate type parameters can be specified as variant.
```

The rules, from [Creating variant generic interfaces](https://learn.microsoft.com/en-us/dotnet/csharp/programming-guide/concepts/covariance-contravariance/creating-variant-generic-interfaces):

- A covariant `T` may appear as a method return type, a getter-only property type, or as the type argument of another covariant position (`IEnumerable<T>`, `IReadOnlyList<T>`, `IReadOnlyCollection<T>`, `Func<T>`).
- It may not appear as a method parameter, a property setter, or the type argument of an invariant interface or any class (`ICollection<T>`, `IList<T>`, `List<T>`, `ObservableCollection<T>`).
- `ICollection<T> Data { get; }` without the setter is still an error, because `ICollection<T>` itself is invariant. The getter-only rule is about the property, the invariance of the property's type is a separate check.

So the question "can I just add `out`?" has a mechanical answer: delete or move every member where `T` flows in, and replace every invariant collection type with a read-only covariant one. If the result is still the interface you need, you are done. For a view model that the user edits, it usually is not, which leads to the split below.

## Fix 1: pull the members that do not mention T into a non-generic interface

In the original question, the member that is actually needed through the base type is `PushData()`, and it has nothing to do with `T`. Generic interfaces should not carry members that do not use their type parameter:

```csharp
// .NET 11, C# 14
public interface IDisplayVM
{
    void PushData();
}

public interface IDisplayVM<T> : IDisplayVM where T : class, IDTO
{
    ObservableCollection<T> Data { get; }
}

if (navStore.CurrentViewModel is IDisplayVM display)
    display.PushData();
```

This needs no variance at all, works for value-type `T` as well, and is the cheapest option in the benchmark below. Anything else that is the same for every table, such as `int Count`, `bool IsDirty`, `Task SaveAsync()` or `object? SelectedItem`, belongs here too.

## Fix 2: a covariant read-only projection next to the invariant edit interface

When code needs to read the items without knowing the concrete DTO type, add a covariant interface that exposes them through `IReadOnlyList<T>`, and have the invariant interface inherit it:

```csharp
// .NET 11, C# 14
public interface IDisplayVMRead<out T> : IDisplayVM where T : class, IDTO
{
    IReadOnlyList<T> Items { get; }
}

public interface IDisplayVMEdit<T> : IDisplayVMRead<T> where T : class, IDTO
{
    void Add(T item);
}

public class PatientsDisplayVM : BaseVM, IDisplayVMEdit<PatientDTO>
{
    private readonly ObservableCollection<PatientDTO> _items = new() { new() { Id = 7 } };
    public IReadOnlyList<PatientDTO> Items => _items;
    public void Add(PatientDTO item) => _items.Add(item);
    public void PushData() { }
}
```

What the runtime does with it:

```text
p is IDisplayVMRead<IDTO> -> True, Items.Count=1, first Id=7
Items runtime type: ObservableCollection`1, INotifyCollectionChanged: True
ReferenceEquals(read, p): True
p is IDisplayVMEdit<IDTO> -> False
```

Three things worth noticing:

1. **A variant conversion is a reference conversion.** `read` is the same object as `p`. Nothing is wrapped or copied, and the cast does not allocate.
2. **The collection is still an `ObservableCollection<PatientDTO>`.** Only the static type changed. A WPF `ItemsSource` binding checks the runtime object for `INotifyCollectionChanged`, so binding to `Items` still receives change notifications. Exposing `IReadOnlyList<T>` costs the view nothing.
3. **The edit interface stays invariant.** `p is IDisplayVMEdit<IDTO>` is `False`, by design. Code that adds items must know the real `T`, which is exactly the type safety the compiler was protecting in the first place.

## Fix 3: recover T with a generic visitor

Sometimes the code operating on "any display view model" really does need to write, for example a shared "import rows from CSV" command. A type switch over every DTO type works but grows with every table. A generic visitor lets the view model hand its own `T` back to the caller:

```csharp
// .NET 11, C# 14
public interface IDisplayVM
{
    void PushData();
    void Accept(IDisplayVisitor visitor);
}

public interface IDisplayVisitor
{
    void Visit<T>(IDisplayVM<T> vm) where T : class, IDTO;
}

public interface IDisplayVM<T> : IDisplayVM where T : class, IDTO
{
    ObservableCollection<T> Data { get; }
}

public abstract class DisplayVM<T> : BaseVM, IDisplayVM<T> where T : class, IDTO, new()
{
    public ObservableCollection<T> Data { get; } = new();
    public void PushData() { }
    public void Accept(IDisplayVisitor visitor) => visitor.Visit(this); // T is known here
}

public sealed class AddBlankRow : IDisplayVisitor
{
    public void Visit<T>(IDisplayVM<T> vm) where T : class, IDTO
        => vm.Data.Add(Activator.CreateInstance<T>()); // fully typed, read and write
}

if (navStore.CurrentViewModel is IDisplayVM display)
    display.Accept(new AddBlankRow());
```

Inside `Visit<T>`, `vm.Data` is an `ObservableCollection<T>` with the real `T`, so adding to it is type-safe. The cost is one interface call plus one generic virtual method call, historically the slowest dispatch shape in .NET. The [.NET 11 JIT can now devirtualize generic virtual methods](/2026/09/dotnet-11-jit-devirtualizes-generic-virtual-methods/) when it can prove the receiver type; in a visitor the receiver arrives as an interface parameter, so measure rather than assume. The benchmark below does exactly that.

## Fix 4: the non-generic IList escape hatch

`ObservableCollection<T>` (through `Collection<T>`) also implements the non-generic `System.Collections.IList`. If you need to add an item through a base-typed reference and are fine with a runtime type check instead of a compile-time one, this works without any interface changes:

```csharp
// .NET 11, C# 14
if (vm.Data is IList list)
{
    list.Add(new DiseaseDTO { Id = 2 });  // fine
    list.Add(new PatientDTO { Id = 3 });  // throws
}
```

```text
IList.Add(DiseaseDTO) ok, Count=2
IList.Add(PatientDTO) -> ArgumentException: The value "PatientDTO" is not of type "DiseaseDTO" and cannot be used in this generic collection. (Parameter 'value')
```

That `ArgumentException` is precisely the bug that invariance prevents at compile time, moved to runtime. Use it at a boundary (a generic import routine, a DataGrid's `NewItemPlaceholder` handling) rather than as the main design.

## What each option costs: measured on .NET 11

The benchmark iterates 300 view models of three concrete types (`DiseasesDisplayVM`, `PatientsDisplayVM`, `DoctorsDisplayVM`, interleaved) held as `BaseVM`, and sums the item count through each mechanism. BenchmarkDotNet 0.16.0-preview.2, .NET 11.0.0, Apple M4, macOS 27, `Release`. The full source is the `CastBench` class below.

| Method              | Mean (300 VMs) | Per view model | Ratio | Allocated |
|---------------------|---------------:|---------------:|------:|----------:|
| NonGenericInterface |       1.410 us |         4.7 ns |  1.00 |         - |
| TypeSwitch          |       1.501 us |         5.0 ns |  1.07 |         - |
| CovariantInterface  |       2.181 us |         7.3 ns |  1.56 |         - |
| GenericVisitor      |       2.300 us |         7.7 ns |  1.64 |         - |
| Dynamic             |      14.688 us |        49.0 ns | 10.50 |    7200 B |

Error margins were 0.03 to 0.07 us for the first four rows, so the gaps between the non-generic interface and the type switch, and between the covariant interface and the visitor, are within noise. The "per view model" column is the mean divided by 300.

What the numbers say:

- **The non-generic interface and the type switch are effectively free.** Casting to a non-variant interface, generic or not, is a cast-cache hit, under 5 ns per object including the property read.
- **The covariant cast costs a few nanoseconds more.** About 2.6 ns extra per object, and part of that is not the cast: `r.Items.Count` is two interface calls (`Items`, then `IReadOnlyCollection<T>.Count`) where the baseline makes one interface call plus a direct `ObservableCollection<T>.Count`. Either way, the variant check does not allocate and is nowhere near anything a UI will notice.
- **The generic visitor is in the same range as the covariant cast**, while giving you full read/write access with the real `T`. That is the trade to remember: for 3 ns per call you get type safety without a branch per table.
- **`dynamic` is the outlier.** Ten times slower and 24 bytes per call, and it moves every typo in a member name to runtime. It is the answer people reach for when the compiler says no; it is the wrong one.

For a navigation event that fires once per click, none of these differences matter. Pick by design: non-generic interface for `T`-free members, covariant read interface for listing, visitor when you must write.

The benchmark body, trimmed to the five methods:

```csharp
// .NET 11, C# 14, BenchmarkDotNet 0.16.0-preview.2
[Benchmark(Baseline = true)]
public int NonGenericInterface()
{
    int sum = 0;
    foreach (var vm in _vms)
        if (vm is IDisplayVM d) sum += d.Count;
    return sum;
}

[Benchmark]
public int CovariantInterface()
{
    int sum = 0;
    foreach (var vm in _vms)
        if (vm is IDisplayVMRead<IDTO> r) sum += r.Items.Count;
    return sum;
}

[Benchmark]
public int TypeSwitch()
{
    int sum = 0;
    foreach (var vm in _vms)
        sum += vm switch
        {
            IDisplayVM<DiseaseDTO> d => d.Data.Count,
            IDisplayVM<PatientDTO> p => p.Data.Count,
            IDisplayVM<DoctorDTO> o => o.Data.Count,
            _ => 0
        };
    return sum;
}

[Benchmark]
public int GenericVisitor()
{
    int sum = 0;
    foreach (var vm in _vms)
        if (vm is IDisplayVM d) { d.Accept(_visitor); sum += _visitor.Result; }
    return sum;
}

[Benchmark]
public int Dynamic()
{
    int sum = 0;
    foreach (var vm in _vms)
        sum += (int)((dynamic)vm).Data.Count;
    return sum;
}
```

## Gotchas and edge cases

**Value types never vary.** Variance is only defined for reference type arguments, because the conversion has to be a pure reference reinterpretation. On .NET 11:

```text
List<int> is IEnumerable<object>    -> False
List<string> is IEnumerable<object> -> True
```

If your DTOs are `record struct` types, `out T` compiles but `IDisplayVMRead<SomeStructDto>` will never convert to `IDisplayVMRead<IDTO>`. The `where T : class, IDTO` constraint in the question rules this out, which is a good reason to keep it.

**Ambiguous variant conversions do not warn and do not throw.** A class that implements both `IReader<DiseaseDTO>` and `IReader<PatientDTO>` (with `IReader<out T>`) is convertible to `IReader<IDTO>` in two ways. SDK 11.0.100 compiles it with no warning, and at runtime the cast succeeded and `Read()` returned a `DiseaseDTO`. Swapping the order in the base list made it return the other type, so on .NET 11.0.0 the first interface listed wins. The [variance documentation](https://learn.microsoft.com/en-us/dotnet/standard/generics/covariance-and-contravariance) does not promise which implementation wins, so do not let one class implement the same variant interface twice with related type arguments.

**`as` against an unrelated generic interface is silent.** `current as IDisplayVM<IDTO>` compiles because of the "explicit conversion exists" rule and returns `null` every time, with no analyzer warning. If a navigation-based view model suddenly "has no data", check every `as` that targets a generic interface with a base-type argument.

**Contravariance is the mirror image.** `in T` lets `IHandler<IDTO>` be used where `IHandler<DiseaseDTO>` is expected, as long as `T` only flows in. Command handlers and validators often fit `in`. A view model, which both shows and edits the same items, fits neither direction, which is why the split interface is the normal answer.

**Adding `out` to a published interface is not free.** Existing implementers keep compiling, but behaviour can change: an `is IDisplayVMRead<IDTO>` check that returned `false` yesterday returns `true` today, and overload resolution can pick a different overload once a new implicit conversion exists. Removing members to make `out` legal is a plain breaking change. If the interface is public in a library, ship a new covariant read interface alongside the old one instead of rewriting it.

## Read next

- When the compiler blocks a generic call for a different reason, a stronger constraint rather than a different type argument, [the CS0314 dispatch options for INumber code](/2026/11/how-to-call-an-ibinaryinteger-method-from-generic-inumber-code-in-csharp/) use the same type-switch and cached-delegate techniques.
- `IEnumerable<T>` is the variant interface most people meet first; [IEnumerable vs IAsyncEnumerable vs IQueryable](/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/) covers what each one promises.
- Exposing `IReadOnlyList<T>` instead of a concrete collection raises the question of what the caller is holding: [how to tell whether an IEnumerable has already been materialized](/2026/08/how-to-tell-whether-an-ienumerable-has-already-been-materialized-in-csharp/).
- Interface design trade-offs in a different corner: [using an interface's default property implementation from the implementing class](/2026/11/how-to-call-a-default-interface-property-from-the-implementing-class-in-csharp/).

## Sources

- [Covariance and contravariance in generics](https://learn.microsoft.com/en-us/dotnet/standard/generics/covariance-and-contravariance), .NET docs.
- [Variance in generic interfaces (C#)](https://learn.microsoft.com/en-us/dotnet/csharp/programming-guide/concepts/covariance-contravariance/variance-in-generic-interfaces), list of BCL variant interfaces.
- [Creating variant generic interfaces (C#)](https://learn.microsoft.com/en-us/dotnet/csharp/programming-guide/concepts/covariance-contravariance/creating-variant-generic-interfaces), the input/output position rules behind CS1961.
- [`out` (generic modifier)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/out-generic-modifier), C# language reference.
- [C# specification, Interfaces: variance safety](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/interfaces).
- [Stack Overflow question 80012592](https://stackoverflow.com/questions/80012592), the WPF view model scenario this post reproduces.
