---
title: "Fix: CA1070 \"Do not declare event fields as virtual\""
description: "CA1070 fires on virtual field-like events. Drop the virtual, keep the event non-virtual, and let derived classes override a protected virtual OnXxx raiser instead."
pubDate: 2026-08-29
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "csharp"
  - "analyzers"
  - "events"
---

CA1070 fires when a field-like event carries the `virtual` modifier. The fix is to remove `virtual` and give derived classes a `protected virtual void OnThresholdReached(...)` raiser method to override instead. This is not a style nit: if anything ever overrides that virtual event, the compiler hands the base class and the derived class two separate private backing fields, and the base class's raise silently fires nothing.

The diagnostic text you are searching for:

```text
warning CA1070: Event 'ThresholdReached' should not be declared virtual
```

Everything below was verified on SDK `10.0.302` (.NET 10, C# 14) with the analyzers that ship in the SDK box, and against the `DoNotDeclareEventFieldsAsVirtual` source in `dotnet/sdk`.

## Does dotnet build report CA1070 at all?

No. Its default severity is suggestion, not warning, because the analyzer is declared with `RuleLevel.IdeSuggestion`:

```csharp
// dotnet/sdk, Microsoft.CodeQuality.Analyzers/QualityGuidelines/DoNotDeclareEventFieldsAsVirtual.cs
internal static readonly DiagnosticDescriptor Rule = DiagnosticDescriptorHelper.Create(
    RuleId,
    CreateLocalizableResourceString(nameof(DoNotDeclareEventFieldsAsVirtualTitle)),
    CreateLocalizableResourceString(nameof(DoNotDeclareEventFieldsAsVirtualMessage)),
    DiagnosticCategory.Design,
    RuleLevel.IdeSuggestion,
    ...
```

Suggestion-level diagnostics show up in Visual Studio, Rider, and `dotnet format`, but `dotnet build` does not print them and `TreatWarningsAsErrors` does not touch them. A project full of virtual events builds like this:

```text
    0 Warning(s)
    0 Error(s)
```

Two ways to make it real:

```xml
<!-- .NET 10 SDK 10.0.302: promotes the All-mode analyzers, CA1070 included -->
<PropertyGroup>
  <AnalysisMode>All</AnalysisMode>
</PropertyGroup>
```

```ini
# .editorconfig, just this rule
[*.{cs,vb}]
dotnet_diagnostic.CA1070.severity = warning
```

This is the same invisibility trap as [CA1873 and expensive logging arguments](/2026/08/fix-ca1873-evaluation-of-this-argument-may-be-expensive-and-unnecessary-if-logging-is-disabled/), and the tradeoffs of promoting suggestions in CI are covered in [TreatWarningsAsErrors without sabotaging dev builds](/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/).

## What makes people mark an event virtual in the first place?

Almost always because of CS0070. A derived class cannot raise a base class event:

```csharp
// .NET 10, C# 14
public class Sensor
{
    public event EventHandler? ThresholdReached;
}

public class LoggingSensor : Sensor
{
    public void Raise() => ThresholdReached?.Invoke(this, EventArgs.Empty);
}
```

```text
error CS0070: The event 'Sensor.ThresholdReached' can only appear on the left hand side
of += or -= (except when used from within the type 'Sensor')
```

The compiler is telling you that outside the declaring type, an event is only an add/remove pair, never the delegate behind it. The obvious-looking escape is to mark the event `virtual` and override it in `LoggingSensor` so the name resolves to something the derived class owns. That compiles. It also breaks the event.

## Why does overriding a virtual field-like event break the event?

The base class stops firing. Here is the whole failure in one file:

```csharp
// .NET 10 (SDK 10.0.302), C# 14
using System;

public class Sensor
{
    public virtual event EventHandler? ThresholdReached;   // CA1070
    public void Raise() => ThresholdReached?.Invoke(this, EventArgs.Empty);
}

public class LoggingSensor : Sensor
{
    public override event EventHandler? ThresholdReached;
    public void RaiseFromDerived() => ThresholdReached?.Invoke(this, EventArgs.Empty);
}

public static class Program
{
    public static void Main()
    {
        LoggingSensor derived = new();
        Sensor asBase = derived;
        asBase.ThresholdReached += (_, _) => Console.WriteLine("handler ran");

        Console.WriteLine("Sensor.Raise():");
        asBase.Raise();                 // fires nothing
        Console.WriteLine("LoggingSensor.RaiseFromDerived():");
        derived.RaiseFromDerived();     // fires the handler
    }
}
```

Actual output on .NET 10:

```text
Sensor.Raise():
LoggingSensor.RaiseFromDerived():
handler ran
```

Same object, same handler, one raise works and the other is a no-op.

The reason is that a field-like event is two different things at once, and only one of them is virtual. The `add` and `remove` accessors are real methods and they do get the `virtual` modifier. The backing delegate field does not, because fields cannot be virtual. Reflecting over the compiled assembly shows exactly what the compiler emitted:

```text
Sensor: field ThresholdReached, IsPrivate=True, type=EventHandler
Sensor: add_ThresholdReached IsVirtual=True, IsFinal=False, DeclaringType=Sensor
LoggingSensor: field ThresholdReached, IsPrivate=True, type=EventHandler
LoggingSensor: add_ThresholdReached IsVirtual=True, IsFinal=False, DeclaringType=LoggingSensor
```

Two private fields, one per type. So:

- `asBase.ThresholdReached += handler` goes through the virtual add accessor, dispatches to `LoggingSensor.add_ThresholdReached`, and lands in `LoggingSensor`'s field.
- `Sensor.Raise()` does not go through any accessor. Inside the declaring type, `ThresholdReached?.Invoke(...)` compiles to a plain read of `Sensor`'s own private field, which is still null.

The C# specification allows this. A virtual event declaration makes the accessors virtual, and an overriding event declaration "does not declare a new event, it simply specializes the implementations of the accessors". The spec language implies the derived accessors should specialize access to one shared field, which would require the compiler to promote the base backing field from private to protected. It never did. Microsoft documented this as a known compiler bug back in 2007 and decided not to fix it, because fixing it would resurrect handler invocations in code that had silently relied on them never running.

What has changed since 2007 is that the failure got quieter. The original repro used `myEvent(this, null)` and threw `NullReferenceException`, which at least pointed at the problem. Modern null-conditional invocation, which every analyzer and code fix will push you toward, turns it into a silent no-op.

## How does this show up in an MVVM base class?

The shape people reach for when writing `INotifyPropertyChanged` on a base view model is exactly the broken case:

```csharp
// .NET 10, C# 14
public class ViewModelBase : INotifyPropertyChanged
{
    public virtual event PropertyChangedEventHandler? PropertyChanged;   // CA1070
    protected void Notify(string n) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(n));
}

public class OrderViewModel : ViewModelBase
{
    public override event PropertyChangedEventHandler? PropertyChanged;
}
```

The binding engine subscribes through the `INotifyPropertyChanged` interface, which routes to the virtual add accessor, which stores the handler on `OrderViewModel`. `Notify` runs inside `ViewModelBase` and reads `ViewModelBase`'s field. I confirmed on .NET 10 that the handler is never called: the UI simply never updates, with no exception and no binding error in the output window.

The `override` in the derived view model is usually vestigial, added by someone chasing CS0070 or copied from a template. Deleting it fixes the binding instantly, because then there is only one backing field. That is worth checking before you rewrite anything. If you are building the notification plumbing from scratch, [a source generator for INotifyPropertyChanged](/2026/04/how-to-write-a-source-generator-for-inotifypropertychanged/) emits the correct non-virtual shape and never gets this wrong.

## How do I fix CA1070?

In order of preference.

**1. Non-virtual event plus a protected virtual raiser.** This is the pattern the .NET design guidelines prescribe, and it is what CA1070 is steering you toward. Derived classes get the extensibility point they actually wanted, and there is exactly one backing field.

```csharp
// .NET 10, C# 14. Builds clean under AnalysisMode=All.
public class Sensor
{
    public event EventHandler? ThresholdReached;

    protected virtual void OnThresholdReached(EventArgs e)
        => ThresholdReached?.Invoke(this, e);

    public void Raise() => OnThresholdReached(EventArgs.Empty);
}

public class LoggingSensor : Sensor
{
    protected override void OnThresholdReached(EventArgs e)
    {
        Console.WriteLine("[derived saw the raise]");
        base.OnThresholdReached(e);
    }
}
```

Note that the raiser reads the field, so it must live in the declaring type. Derived overrides call `base.OnThresholdReached(e)` to actually fire. Forget the `base` call and you have suppressed the event, which is sometimes the point.

**2. Keep the event virtual, but write explicit accessors over a protected field.** Use this when the derived class genuinely needs to intercept subscription, for example to lazily wire up an OS-level hook on the first subscriber. CA1070 does not fire here, because the rule only targets field-like events.

```csharp
// .NET 10, C# 14
public class Sensor
{
    protected EventHandler? _thresholdReached;

    public virtual event EventHandler? ThresholdReached
    {
        add => _thresholdReached += value;
        remove => _thresholdReached -= value;
    }

    public void Raise() => _thresholdReached?.Invoke(this, EventArgs.Empty);
}

public class LoggingSensor : Sensor
{
    public override event EventHandler? ThresholdReached
    {
        add { Console.WriteLine("[derived add]"); _thresholdReached += value; }
        remove => _thresholdReached -= value;
    }
}
```

The `+=` on a delegate field is not atomic, so use `Interlocked.CompareExchange` or a lock in the accessors if subscribers can arrive from multiple threads. Both handlers fired correctly in my run, because both accessors now target the same protected field.

**3. Make the base event abstract.** An abstract field-like event cannot be used like a field, so the base class physically cannot raise it and the split-field bug cannot happen. CA1070 does not fire, because the analyzer checks `IsVirtual`, which is false for abstract members.

```csharp
// .NET 10, C# 14
public abstract class Sensor
{
    public abstract event EventHandler? ThresholdReached;
    public abstract void Raise();
}
```

This is correct but rarely what you want, since every derived class now has to reimplement the event and the raise.

## Which declarations does CA1070 actually flag?

Only the base `virtual` declaration, which surprises people who run the analyzer expecting it to point at the line that is actually broken. The check is a single symbol action:

```csharp
// dotnet/sdk, DoNotDeclareEventFieldsAsVirtual.cs
if (!eventSymbol.IsVirtual ||
    eventSymbol.AddMethod?.IsImplicitlyDeclared == false ||
    eventSymbol.RemoveMethod?.IsImplicitlyDeclared == false)
{
    return;
}
```

`IEventSymbol.IsVirtual` is true only for members declared with the `virtual` keyword. An `override` member reports `IsOverride`, not `IsVirtual`, and an `abstract` member reports `IsAbstract`. So the diagnostic lands on the base declaration and nowhere else. The `IsImplicitlyDeclared` checks are what restrict the rule to field-like events: if you wrote the accessors yourself, they are not implicit and the rule bails.

Here is the full matrix I built and ran against SDK 10.0.302 with `dotnet_diagnostic.CA1070.severity = warning`:

| Declaration | CA1070? |
| --- | :---: |
| `public virtual event EventHandler A;` | yes |
| `protected virtual event EventHandler B;` in a public unsealed class | yes |
| `internal virtual event EventHandler C;` | no |
| `public virtual event EventHandler D { add {} remove {} }` | no |
| `public override event EventHandler A;` in the derived class | no |
| `public abstract event EventHandler E;` | no |
| `public virtual event EventHandler F;` inside an `internal` class | no |
| `public event EventHandler G;` (not virtual) | no |

The two rows that catch people out are the internal ones, and they are configurable.

## How do I make CA1070 cover internal and private events?

By default the rule only analyzes externally visible symbols, matching the old FxCop behaviour. Set `api_surface` to widen it:

```ini
[*.{cs,vb}]
dotnet_diagnostic.CA1070.severity = warning
dotnet_code_quality.CA1070.api_surface = all
```

On the same matrix, `api_surface = all` reports A, B, C, and F. `api_surface = private, internal` reports only C and F. For an application assembly rather than a shipped library, `all` is the right setting: nothing there is a public API contract, and the bug does not care about accessibility.

One documentation discrepancy worth knowing: the MS Learn page lists the applicable languages as "C# and Visual Basic", but the analyzer is attributed `[DiagnosticAnalyzer(LanguageNames.CSharp)]`, with a suppression comment reading "Construct is invalid in VB.NET". VB has no `Overridable` field-like event to begin with, so there is nothing to analyze; the docs table is simply stale.

## When is it safe to suppress CA1070?

When the virtual event is already part of a shipped public API. Removing `virtual` is a binary breaking change for anyone who overrode it, so the rule's own guidance is to suppress rather than break consumers. Suppress it at the declaration, not project-wide, and leave a note:

```csharp
// Public since v2.0. Removing 'virtual' is a binary break for derived types.
#pragma warning disable CA1070
public virtual event EventHandler? ThresholdReached;
#pragma warning restore CA1070
```

Then add the protected raiser anyway, so new derived types have a correct extensibility point and stop reaching for `override`. In a new or internal codebase, do not suppress it. Fix it.

## Gotchas and lookalikes that land here by mistake

**CS0070** ("The event 'X' can only appear on the left hand side of += or -=") is the compile error that leads people to write `virtual`, covered above. The fix is a protected raiser, never a virtual event.

**CS0067** ("The event 'X' is never used") shows up on the derived `override` once you follow this article and stop raising it from the derived class. That warning is the analyzer-visible ghost of a backing field nothing writes to; deleting the override clears it.

**CA1030** ("Use events where appropriate") and **CA1003** ("Use generic event handler instances") are Design rules about event shape, not virtuality, and neither has anything to do with the split-field bug.

**"I marked it virtual so Moq or Castle DynamicProxy could intercept it."** Proxy-based mocking libraries do need virtual members, and event interception is the one case where obliging them plants a real bug. Mock the interface instead: extract `IThresholdSource` with a plain `event EventHandler ThresholdReached` and let the mock implement it, so nothing needs `virtual` at all. The same applies to a base class made virtual wholesale for EF Core lazy-loading proxies, where only navigation properties actually need it.

If a virtual event has already been shipped and you are hunting the fallout, the symptom is usually a handler that stays subscribed forever while never being invoked, which shows up as a rooted delegate in a heap dump. [Diagnosing a managed memory leak with dotnet-gcdump and dotnet-dump](/2026/07/how-to-diagnose-a-managed-memory-leak-with-dotnet-gcdump-and-dotnet-dump/) walks through finding the surviving handler chain.

CA1070 has been in the box since the .NET 5 analyzers, at Info severity, and it has never been promoted. That is a fair call for a rule whose payload only detonates when someone writes `override`, but it does mean the warning most likely to save you an afternoon of "why isn't my binding updating" is one your build never prints. Turning it into a warning costs one `.editorconfig` line.

## Related

- [Fix: CA1873 "Evaluation of this argument may be expensive and unnecessary if logging is disabled"](/2026/08/fix-ca1873-evaluation-of-this-argument-may-be-expensive-and-unnecessary-if-logging-is-disabled/)
- [How to write a source generator for INotifyPropertyChanged](/2026/04/how-to-write-a-source-generator-for-inotifypropertychanged/)
- [TreatWarningsAsErrors without sabotaging dev builds (.NET 10)](/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/)
- [What is a source generator and when do I need one?](/2026/06/what-is-a-source-generator-and-when-do-i-need-one/)
- [How to diagnose a managed memory leak with dotnet-gcdump and dotnet-dump](/2026/07/how-to-diagnose-a-managed-memory-leak-with-dotnet-gcdump-and-dotnet-dump/)

## Sources

- [CA1070: Do not declare event fields as virtual](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1070) on MS Learn
- [DoNotDeclareEventFieldsAsVirtual.cs](https://github.com/dotnet/sdk/blob/main/src/Microsoft.CodeAnalysis.NetAnalyzers/src/Microsoft.CodeAnalysis.NetAnalyzers/Microsoft.CodeQuality.Analyzers/QualityGuidelines/DoNotDeclareEventFieldsAsVirtual.cs), the analyzer source
- [Virtual events in C#](https://learn.microsoft.com/en-us/archive/blogs/samng/virtual-events-in-c), the 2007 C# team post that documented the compiler bug and the decision not to fix it
- [How to raise base class events in derived classes](https://learn.microsoft.com/en-us/dotnet/csharp/programming-guide/events/how-to-raise-base-class-events-in-derived-classes) on MS Learn
- [Handle and raise events](https://learn.microsoft.com/en-us/dotnet/standard/events/), the .NET event design guidelines
- [Compiler Error CS0070](https://learn.microsoft.com/en-us/dotnet/csharp/misc/cs0070) on MS Learn
- [api_surface configuration option](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/code-quality-rule-options#api_surface) for code quality rules
