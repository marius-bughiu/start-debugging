---
title: "What is [ModuleInitializer] in C# and when should a library use it?"
description: "[ModuleInitializer] makes the C# compiler emit a <Module> static constructor that calls your method once per assembly. When it runs is looser than most people think: on the JIT it can fire before a branch that never executes, under Native AOT it runs eagerly at startup or not at all. Why CA2255 warns libraries off it, the few cases where a library should still use it, and measured behaviour on .NET 10."
pubDate: 2026-11-03
tags:
  - "csharp"
  - "dotnet"
  - "native-aot"
  - "source-generators"
  - "runtime"
---

**Short answer:** `[ModuleInitializer]` (C# 9, .NET 5 and later) marks a static, parameterless, `void` method that the compiler calls from the assembly's module initializer, the static constructor of the hidden `<Module>` type. The runtime promises it runs exactly once, at or before the first access to anything in that assembly. A library should almost never use it: analyzer CA2255 warns by default because it runs code the application never asked for, at a time the application does not control, and it is hostile to trimming and Native AOT. The legitimate uses are code a source generator emits into the *consuming* project, test projects that configure a framework like Verify, and internal libraries that exist only to split one application into projects. Everything below was measured on .NET SDK 10.0.302, runtime 10.0.10, ILCompiler 10.0.10, macOS 27 on arm64.

## What the compiler actually emits

Every .NET module has a special type named `<Module>` that holds global members. C# never let you write members on it, but the CLR has always supported a static constructor there: the [Ecma-335 augments](https://github.com/dotnet/runtime/blob/main/docs/design/specs/Ecma-335-Augments.md) define the module initializer as "the type initializer of the `<Module>` type". C# 9 exposed it through an attribute instead of new syntax:

```csharp
// .NET 10, C# 14
using System.Runtime.CompilerServices;

internal static class Init
{
    [ModuleInitializer]
    internal static void Register()
    {
        Console.WriteLine($"  [Lib] module initializer ran (thread {Environment.CurrentManagedThreadId})");
        Registry.Names.Add("from-initializer");
    }
}
```

The compiler collects every method with the attribute in the compilation and emits `<Module>..cctor`, which calls them one after another. That is the whole feature. There is no runtime discovery, no reflection, and no registration step: the call sites are baked into IL at build time. You can see it in a stack trace when one throws:

```text
Unhandled exception. System.InvalidOperationException: config missing
   at Startup.Init() in .../Boom/Program.cs:line 9
   at .cctor()
```

The `.cctor()` with no type name in front is `<Module>`'s static constructor.

## The signature rules and the errors they produce

The [ModuleInitializerAttribute docs](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.moduleinitializerattribute) list the requirements: static, an ordinary method, parameterless, returns `void`, not generic and not inside a generic type, and accessible at module level (`internal` or `public` all the way up the nesting chain). Breaking each one gives a specific error. This file compiled against SDK 10.0.302:

```csharp
// .NET 10, C# 14 -- every line is an error
using System.Runtime.CompilerServices;

public class Bad
{
    [ModuleInitializer] private static void PrivateInit() { }          // CS8814
    [ModuleInitializer] internal void InstanceInit() { }               // CS8815
    [ModuleInitializer] internal static int ReturnsValue() => 0;       // CS8815
    [ModuleInitializer] internal static void TakesArg(int x) { }       // CS8815
    [ModuleInitializer] internal static void GenericInit<T>() { }      // CS8816
    private class Hidden { [ModuleInitializer] internal static void Init() { } } // CS8814
}
public class Gen<T> { [ModuleInitializer] internal static void Init() { } }     // CS8816
```

The messages are "must be accessible at the module level" (CS8814), "must be static, and non-virtual, must have no parameters, and must return 'void'" (CS8815), and "must not be generic and must not be contained in a generic type" (CS8816). The `Hidden` case catches people: the method is `internal`, but its containing class is `private`, so its effective accessibility is too narrow.

## When it runs: the guarantee is loose on purpose

The language reference says the attributed method runs "when the assembly loads". That is not what the runtime promises. The Ecma augment says the module initializer runs "at, or sometime before, first access to any static field or first invocation of any method defined in the module", and exactly once unless user code calls it explicitly. "Sometime before" is the part that matters, and the two .NET code generators use that freedom very differently.

The test setup: a class library `Lib` with the initializer above plus a `Registry` class, and a console app that references it.

```csharp
// Lib, .NET 10, C# 14
public static class Registry
{
    public static readonly List<string> Names = new();
    public static void Touch() => Console.WriteLine("  [Lib] Registry.Touch called");
}
public class Marker { }
```

### Loading and reflecting do not trigger it

```csharp
// App, .NET 10, C# 14
using System.Reflection;
using System.Runtime.CompilerServices;

Console.WriteLine("1. Main started");
var asm = Assembly.Load("Lib");
Console.WriteLine($"2. Assembly.Load done: {asm.GetName().Name}");
_ = asm.GetTypes();
Console.WriteLine("3. GetTypes() done");
var t = asm.GetType("Lib.Marker")!;
Console.WriteLine("4. GetType done");
UseLib();

[MethodImpl(MethodImplOptions.NoInlining)]
static void UseLib()
{
    Console.WriteLine("5. UseLib entered");
    Lib.Registry.Touch();
}
```

Output on the JIT:

```text
1. Main started
2. Assembly.Load done: Lib
3. GetTypes() done
4. GetType done
  [Lib] module initializer ran (thread 1)
5. UseLib entered
  [Lib] Registry.Touch called
```

So "when the assembly loads" is wrong in practice: the assembly was loaded and fully enumerated by reflection at step 2 and 3, and nothing ran. Notice also *where* it ran: before the first line of `UseLib`, not before the call to `Touch`. The JIT triggers the module constructor while compiling a method that references the module, so the initializer runs before the method that needs it starts executing.

### On the JIT, an untaken branch is enough

That compile-time trigger has a surprising consequence:

```csharp
// App, .NET 10, C# 14
Console.WriteLine("1. Main started");
if (args.Length > 5)
    Lib.Registry.Touch();   // never executes
Console.WriteLine("2. Main finished");
```

```text
  [Lib] module initializer ran (thread 1)
1. Main started
2. Main finished
```

Same result in Debug and Release. The initializer ran before `Main` printed anything, because compiling `Main` saw a reference to `Lib` and ran `Lib`'s module constructor. Any code that relies on "this only runs if the feature is used" is relying on something the JIT does not give you.

If you need it to run at a specific point, force it: `RuntimeHelpers.RunModuleConstructor(typeof(SomeTypeInLib).Module.ModuleHandle)` runs it immediately if it has not run yet, and is a no-op afterwards.

### Under Native AOT it runs at startup, or never

The same untaken-branch program published with `-p:PublishAot=true` prints:

```text
1. Main started
2. Main finished
```

No initializer at all. Then it gets stranger: change the condition to `args.Length > 0` and pass an argument, so `Touch()` really executes, and the AOT binary *still* never runs `Lib`'s initializer. The ILC map file (`-p:IlcGenerateMapFile=true`) shows why: `Registry.Touch` was inlined into `Main`, no other method from `Lib` survived, and `Lib`'s `<Module>..cctor` was never compiled into the image.

Native AOT does not trigger module initializers lazily per access. The compiler's [`ModuleInitializerListNode`](https://github.com/dotnet/runtime/blob/release/10.0/src/coreclr/tools/aot/ILCompiler.Compiler/Compiler/DependencyAnalysis/ModuleInitializerListNode.cs) builds a list of every module whose `<Module>` static constructor ended up in the compiled method bodies, sorts it so referenced assemblies come before the assemblies that reference them ("best effort", per the source comment), and the startup code runs that list before `Main`. Whether a module makes the list depends on what the dependency analysis kept:

| Access to `Lib` in the app (AOT publish) | `Lib` initializer |
| --- | --- |
| Inlined call to a static method, nothing else | never runs, even when the call executes |
| Same method marked `NoInlining` | runs before `Main`, even when the call is never reached |
| Static field read (`Registry.Names.Count`) | runs before `Main`, reached or not |
| Constructor call (`new Marker()`) | runs before `Main`, reached or not |
| App has its own `[ModuleInitializer]` | both run before `Main`, `Lib` first |

On the JIT, every row of that table ran `Lib`'s initializer before `Main` too, but for a different reason (compiling `Main` touched it). The practical rule for both: assume a module initializer runs early, possibly before any of your code, and do not assume it runs at all under AOT unless something in the module is clearly kept. This is the trimming problem CA2255 hints at: a library cannot know whether its initializer will survive the consumer's publish settings. If AOT is new to you, [what Native AOT costs you](/2026/06/what-is-native-aot-and-what-does-it-cost-you/) covers the dependency-analysis model that causes this.

## Ordering between several initializers

Inside one assembly, the compiler calls initializers in a "deterministic but not specified" order, per the [C# attributes reference](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/attributes/general). In practice, the C# compiler in SDK 10.0.302 follows the order of source files passed to `csc`, then declaration order inside a file:

```csharp
// Program.cs, .NET 10, C# 14
Console.WriteLine($"Main: {string.Join(" -> ", Log.Steps)}");

static class Log { public static readonly List<string> Steps = new(); }

static class Zeta
{
    [ModuleInitializer] internal static void B() => Log.Steps.Add("Zeta.B");
    [ModuleInitializer] internal static void A() => Log.Steps.Add("Zeta.A");
}

// Alpha.cs
static class Alpha
{
    static Alpha() => Log.Steps.Add("Alpha..cctor");
    [ModuleInitializer] internal static void Init() => Log.Steps.Add("Alpha.Init");
}
```

With default globbing (alphabetical, so `Alpha.cs` first):

```text
Main: Alpha..cctor -> Alpha.Init -> Zeta.B -> Zeta.A
```

With an explicit `<Compile Include="Program.cs" /><Compile Include="Alpha.cs" />` order in the project file:

```text
Main: Zeta.B -> Zeta.A -> Alpha..cctor -> Alpha.Init
```

Renaming a file reorders your initializers. If two of them depend on each other, call one from the other or merge them into a single initializer that calls helpers in the order you need. Note also that `Alpha`'s own static constructor ran before `Alpha.Init`: calling a static method on a type triggers that type's static constructor as usual.

Across assemblies there is no order you can rely on on the JIT; it depends on which methods get compiled first. Native AOT orders by assembly reference, dependencies first.

## What happens when one throws

In the entry assembly, an exception from a module initializer kills the process before `Main` with the raw exception, as shown in the stack trace earlier. In a library it surfaces as a `TypeInitializationException` at whatever caller first triggered it, and it is permanent:

```csharp
// BoomLib, .NET 10, C# 14
static class Startup
{
    static int attempts;
    [ModuleInitializer]
    internal static void Init()
    {
        Console.WriteLine($"  initializer attempt {++attempts}");
        throw new InvalidOperationException("config missing");
    }
}
```

Calling into `BoomLib` twice from a `try`/`catch`:

```text
  initializer attempt 1
call 1: TypeInitializationException: The type initializer for '<Module>' threw an exception.
  inner: InvalidOperationException: config missing
call 2: TypeInitializationException: The type initializer for '<Module>' threw an exception.
  inner: InvalidOperationException: config missing
```

One attempt, then every later access to anything in that assembly fails with the same cached exception. The error names `<Module>`, not your class, which makes it hard to trace in a production log. A failing initializer in a library takes the whole library down for the life of the process.

## Why CA2255 warns libraries off it

Build a class library with a `[ModuleInitializer]` and you get, by default, as a warning:

```text
warning CA2255: The 'ModuleInitializer' attribute is only intended to be used in application code or advanced source generator scenarios
```

The [CA2255 docs](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2255) give the reasons: it "can interfere with application initialization" and limits trimming. Put concretely, using the measurements above:

- The application did not ask for it and cannot opt out. Your code runs on their startup path, possibly before their logging, configuration, or DI container exist.
- Timing differs between JIT and AOT, and AOT can drop it entirely.
- A failure poisons every type in your assembly with an exception that names `<Module>`.
- Startup cost is paid even by applications that only reference your package for one small helper.

The fix the docs recommend is to expose a method the application calls during its own initialization. That is the pattern every well-behaved .NET library already follows: `services.AddMyLibrary()`, `MyLibrary.Configure(...)`, or a builder extension. If the state is only needed by one type, a static constructor on that type is narrower: it runs only when that type is used, and its exception names the type. If you need lazy, thread-safe, retryable setup, use [`Lazy<T>` or `LazyInitializer`](/2026/10/lazy-t-vs-lazyinitializer-vs-double-checked-locking-in-csharp/) instead of a type initializer, because a type initializer that fails never retries.

## When a library legitimately uses it

The C# proposal lists the motivations: one-time eager initialization, avoiding the per-access checks that static constructors cost, and letting source generators run global setup. Three cases hold up in practice.

**Source generators that emit into the consuming project.** A generator runs inside the application's compilation, so a `[ModuleInitializer]` it emits lives in the app's assembly, not the library's. The app opted in by referencing the generator, CA2255 does not fire on an `Exe`, and the generator knows every type it needs to register at build time, which is exactly the problem a reflection scan solves badly under AOT. If you are writing one, [what a source generator is and when you need one](/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) covers the model, and emitting a registration initializer is a common last step after you [write the generator itself](/2026/04/how-to-write-a-source-generator-for-inotifypropertychanged/).

**Test projects.** Test projects are where `[ModuleInitializer]` is most common, because it is a "before anything in this test assembly" hook that works the same under xUnit, NUnit, and MSTest, without each framework's own assembly-setup attribute. Snapshot testing with [Verify](https://github.com/VerifyTests/Verify) is the best-known example: its docs put plugin initialization and global settings in a module initializer. This does not trip CA2255 either: `Microsoft.NET.Test.Sdk` 17.14.1 sets `<OutputType>Exe</OutputType>` for test projects, so an xUnit 2.9.3 test project with a module initializer built with zero warnings and the test that depends on it passed.

```csharp
// xUnit test project, .NET 10, C# 14
using System.Runtime.CompilerServices;

static class TestSetup
{
    [ModuleInitializer]
    internal static void Init() => Environment.SetEnvironmentVariable("FROM_INIT", "yes");
}

public class UnitTest1
{
    [Fact]
    public void InitRan() => Assert.Equal("yes", Environment.GetEnvironmentVariable("FROM_INIT"));
}
```

**Libraries that are really part of one application.** CA2255's own suppression guidance: it is safe when the class library exists "for code factoring purposes" and is not shipped as a shared package. Suppress it in that project's `.editorconfig` with `dotnet_diagnostic.CA2255.severity = none`, and keep the initializer trivial.

What does not qualify: a NuGet package that wants to register a codec, a JSON converter, an `AppContext` switch, or a diagnostic listener "automatically". All of those should be an explicit call. The few seconds a consumer spends adding `AddMyLibrary()` buy them control over order, failure handling, and AOT behaviour, and they buy you a stack trace with your type name in it.

## Gotchas worth remembering

- **It is not "on load".** Loading the assembly and reflecting over it does not run it. Compiling (JIT) or keeping (AOT) code that touches the assembly does.
- **JIT can run it for code that never executes.** An untaken `if` that mentions a type from the assembly was enough on .NET 10.
- **AOT can skip it for code that does execute,** if the only use was inlined away. Do not put correctness-critical registration in a library initializer and assume AOT keeps it.
- **File order is initializer order** within one assembly. Renames reorder them.
- **One failure is forever.** `TypeInitializationException` for `<Module>`, cached, no retry.
- **One attribute per method, many methods per assembly.** The attribute has `AllowMultiple = false`, but any number of methods can carry it; they all end up in the same `<Module>..cctor`.
- **Calling it twice is possible.** `RuntimeHelpers.RunModuleConstructor` runs it if it has not run; the Ecma text says "exactly once ... unless explicitly called by user code", so do not call the attributed method directly from elsewhere unless it is idempotent.

For a wider view of how the JIT and Native AOT differ on startup work like this, see [Native AOT vs ReadyToRun vs JIT in .NET 11](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/).

## Related reading

- [What is a source generator and when do I need one?](/2026/06/what-is-a-source-generator-and-when-do-i-need-one/)
- [How to write a source generator for INotifyPropertyChanged](/2026/04/how-to-write-a-source-generator-for-inotifypropertychanged/)
- [What is Native AOT and what does it cost you?](/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [Native AOT vs ReadyToRun vs JIT in .NET 11](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [Lazy<T> vs LazyInitializer vs double-checked locking in C#](/2026/10/lazy-t-vs-lazyinitializer-vs-double-checked-locking-in-csharp/)

## Sources

- [ModuleInitializerAttribute class, MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.moduleinitializerattribute)
- [CA2255: The ModuleInitializer attribute should not be used in libraries, MS Learn](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2255)
- [Miscellaneous attributes: ModuleInitializer, C# language reference](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/attributes/general)
- [Module initializers proposal, C# 9.0, dotnet/csharplang](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-9.0/module-initializers.md)
- [Ecma-335 augments: module initializer, dotnet/runtime](https://github.com/dotnet/runtime/blob/main/docs/design/specs/Ecma-335-Augments.md)
- [ModuleInitializerListNode.cs, ILCompiler, dotnet/runtime release/10.0](https://github.com/dotnet/runtime/blob/release/10.0/src/coreclr/tools/aot/ILCompiler.Compiler/Compiler/DependencyAnalysis/ModuleInitializerListNode.cs)
- [Verify, VerifyTests on GitHub](https://github.com/VerifyTests/Verify)
