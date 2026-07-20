---
title: "Fix: CS8618 \"Non-nullable property must contain a non-null value when exiting constructor\" in C#"
description: "CS8618 means a non-nullable field or property was not initialized by the time the constructor finished. Set it in the constructor, give it a default, mark it required, or make it nullable."
pubDate: 2026-07-20
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-14"
  - "dotnet"
  - "dotnet-11"
  - "nullable"
---

`CS8618` fires when a non-nullable reference member (a field or an auto-property) is not guaranteed to hold a non-null value by the time a constructor finishes. The compiler cannot prove the member was assigned, so it warns that a `null` may leak out. Fix it one of four ways, in rough order of preference: assign it in the constructor, give it a field initializer, mark it `required` so the caller must set it, or make the member nullable (`string?`) if `null` is genuinely valid. This is verified against C# 14 on .NET 11; the diagnostic has behaved this way since nullable reference types shipped in C# 8, and .NET 6 was the release that turned the nullable context on by default in new projects.

## The error in context

The current compiler emits a single unified message for both fields and properties:

```
warning CS8618: Non-nullable variable must contain a non-null value when exiting constructor. Consider declaring it as nullable.
```

Older SDKs (and plenty of still-open StackOverflow threads) show the field- and property-specific phrasings, which is what many people actually type into search:

```
warning CS8618: Non-nullable property 'Name' must contain a non-null value when exiting constructor.
warning CS8618: Non-nullable field '_name' must contain a non-null value when exiting constructor.
```

All three are the same diagnostic with the same cause. Note the word *warning*, not *error*: `CS8618` does not stop the build by default. It becomes a build-breaking error only if you have `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>` or `<WarningsAsErrors>CS8618</WarningsAsErrors>` in your project, which many teams do precisely so that null-safety gaps cannot be ignored.

## Why this happens

Nullable reference types, introduced in C# 8 and enabled by default in the templates since .NET 6 (`<Nullable>enable</Nullable>` in the `.csproj`), split every reference type into two states: non-nullable (`string`) and nullable (`string?`). A non-nullable member is a promise: "this will never be null." The compiler's job is to hold you to that promise, and the one place it can most easily check is construction. When a constructor returns, every non-nullable field and auto-property must be provably not-null. If the compiler cannot prove it, you get `CS8618`.

The critical phrase is "provably." The compiler does static analysis; it does not run your code. It trusts exactly three things: a field or property initializer, a direct assignment inside the constructor, and a helper method annotated to say it assigns the member. A constructor that assigns the value through some path the compiler cannot follow, or a member set only later by a framework, counts for nothing. This is the same "prove, don't show" model behind the [required member diagnostic CS9035](/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/): the compiler will not read intent out of your method bodies.

A subtle trap: guarding with a null check inside the constructor does not help. Code like `if (name is null) throw new ArgumentNullException(nameof(name));` proves the *parameter* is not null, but the compiler still sees the *member* as unassigned unless you actually assign it. This surprises people often enough that it has its own long-running Roslyn issue.

## Minimal repro

The smallest type that triggers `CS8618`, in a project with the nullable context enabled:

```csharp
// .NET 11, C# 14, <Nullable>enable</Nullable>
public class Person
{
    public string Name { get; set; }    // CS8618: never assigned
    public string Email { get; set; }   // CS8618: never assigned
    public int Age { get; set; }        // fine, value type has a default
}
```

Two warnings, one per non-nullable reference property. `Age` is silent because value types always have a default (`0`); nullability warnings are about reference types. Add a constructor that only sets one member and you still get one warning:

```csharp
// .NET 11, C# 14
public class Person
{
    public Person(string name)
    {
        Name = name;      // Name is proven
    }

    public string Name { get; set; }
    public string Email { get; set; }   // CS8618: still not assigned on this path
}
```

The compiler checks every constructor independently. If any constructor leaves a non-nullable member unassigned, that constructor produces the warning.

## Fix, in detail

Work through these in order. The first three are the ones you want most of the time; the last two are escape hatches for when the member really is initialized somewhere the compiler cannot see.

### 1. Initialize the member in a constructor

If the value is required to build a valid object, take it as a constructor parameter and assign it. This is the design the warning is nudging you toward:

```csharp
// .NET 11, C# 14
public class Person
{
    public Person(string name, string email)
    {
        Name = name;
        Email = email;
    }

    public string Name { get; set; }
    public string Email { get; set; }
}
```

Both members are now provably assigned on every construction path, so both warnings disappear. If you have several constructors, funnel them through one so the assignment lives in a single place: `public Person() : this("John", "Doe") { }` satisfies the compiler because the chained constructor does the work.

### 2. Give the member a default with a field initializer

When there is a sensible default and you do not want to force every caller to pass the value, initialize the member where it is declared:

```csharp
// .NET 11, C# 14
public class Person
{
    public string Name { get; set; } = string.Empty;
    public string Email { get; set; } = string.Empty;
}
```

A field initializer runs before any constructor body, so the member is not-null on every path automatically. This is the cleanest fix for optional-ish values like empty strings or `new List<string>()` collections. It is also better than making the type nullable if the member should never actually be null at runtime, because it keeps the not-null contract for everyone who reads the property.

### 3. Mark the member `required` (C# 11 and later)

If the member is mandatory but you do not want a constructor parameter for it, use the `required` modifier. It moves the obligation to the caller's object initializer and, as a bonus, silences `CS8618`, because the compiler now knows the member must be set before the object escapes:

```csharp
// .NET 11, C# 14
public class Person
{
    public required string Name { get; set; }
    public required string Email { get; set; }
}

// the caller is now forced to set both
var p = new Person { Name = "Ada", Email = "ada@example.com" };
```

This is often the best modern answer for DTOs and configuration objects: no boilerplate constructor, no fake default, and the not-null guarantee is enforced at every call site. The trade-off is that omitting a value becomes a compile error (`CS9035`) at the call site instead of a warning on the type. If you reach for this, read the companion post on [CS9035 and required members](/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/) so you know what the caller-side error looks like.

### 4. Make the member nullable if `null` is a valid state

If the member genuinely can be absent, it should be `string?`, not `string`. Adding the `?` tells the compiler and every reader that this value might be null, which is honest and moves the null-checking to where the value is consumed:

```csharp
// .NET 11, C# 14
public class Person
{
    public string Name { get; set; } = string.Empty;
    public string? MiddleName { get; set; }   // legitimately optional
}
```

Do not reach for this just to silence the warning on a member that is never really null. Marking a member nullable when it is always set in practice pushes phantom null checks (or null-forgiving `!` operators) onto every consumer. Reserve `?` for values that are actually optional.

### 5. Annotate a helper method with `[MemberNotNull]`, or use `null!` for framework-initialized members

Sometimes the member is initialized, just not somewhere the compiler follows. Two tools cover this.

If a shared private method does the initialization, tell the compiler with `[MemberNotNull]`:

```csharp
// .NET 11, C# 14
using System.Diagnostics.CodeAnalysis;

public class Student
{
    public string Major { get; set; }

    public Student() => SetMajor();

    [MemberNotNull(nameof(Major))]
    private void SetMajor(string? major = null) => Major = major ?? "Undeclared";
}
```

`[MemberNotNull]` asserts that after the method returns, the named member is not-null, so a constructor that calls it is considered to have assigned the member. Like `[SetsRequiredMembers]`, this is a promise the compiler trusts without verifying, so keep it honest.

The other case is a member a framework sets by reflection, the classic being an EF Core `DbSet`. The base `DbContext` populates these, but the compiler cannot see that, so the idiom is to initialize to `null!`:

```csharp
// .NET 11, EF Core 11
public class TodoContext : DbContext
{
    public TodoContext(DbContextOptions<TodoContext> options) : base(options) { }

    public DbSet<TodoItem> TodoItems { get; set; } = null!;
}
```

The `null!` says "assume this is not-null; I know it is set elsewhere." It is a targeted suppression, not a fix, so use it only when something outside your constructor really does the initialization. This pattern shows up throughout EF Core code; the same reasoning applies to entities the ORM materializes, covered in [how to use records with EF Core 11 correctly](/2026/04/how-to-use-records-with-ef-core-11-correctly/).

## Gotchas and variants

A handful of situations produce `CS8618`, or something adjacent, for reasons the message does not spell out:

- **A null check on the parameter does not assign the member.** Throwing `ArgumentNullException` when a parameter is null proves the parameter is not-null but leaves the member unassigned in the compiler's model. You still have to write `Name = name;`. Validate and assign; validation alone is not enough.

- **`struct` default construction bypasses your constructor.** For a `struct`, the parameterless default (`default(MyStruct)` or `new MyStruct()` when no explicit parameterless constructor runs) zero-initializes every field, leaving non-nullable reference fields as `null` with no warning at the `default` site. The compiler warns on your struct's declared constructors, but it cannot stop a caller from getting a zeroed instance. Do not rely on `required` or a constructor to guarantee non-null fields on a struct; a `default` value sidesteps both.

- **Reflection and serializers construct objects without your constructor.** `Activator.CreateInstance`, `System.Text.Json`, and ORMs can build an object without running the constructor that would have assigned your members, so a member the compiler proved non-null can still be `null` at runtime. If you use `required`, note that `System.Text.Json` has honored required members since .NET 8 and will throw a `JsonException` when the JSON omits one, which is the runtime half of the same contract. When you need full control over how a type is built from JSON, [a custom JsonConverter](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) takes over construction entirely.

- **Field-backed properties and the `field` keyword.** With a normal auto-property the backing field is what the analysis tracks. If you use C# 14's `field` keyword to add logic to an accessor, the same rule applies to the compiler-synthesized backing field: it must be non-null when the constructor exits, so initialize it the same way you would any other member.

- **`= default!` versus `= null!`.** For reference members they mean the same thing (`default` for a reference type is `null`), and both suppress the warning. Prefer `null!` for reference members because it reads as "intentionally null for now," and reserve `default!` for generic members where the type parameter might be a value type.

- **Turning the whole thing off is almost never the fix.** You can scope the nullable context down with `#nullable disable` around a file or region, but that discards the null-safety analysis for everything inside, not just the one member. If you want to silence a single member you know is fine, `null!` on that member is far more targeted than disabling the context. Whole-file `#nullable disable` is a migration tool, not a fix.

The mental model to keep: `CS8618` is the compiler enforcing the promise that a non-nullable member makes. When you see it, decide which is actually true, then act on it. The member is mandatory (assign it in a constructor, or mark it `required`), it has a reasonable default (give it a field initializer), it is genuinely optional (make it `string?`), or it is initialized by code the compiler cannot see (`[MemberNotNull]` or `null!`). Reaching for `null!` on a member that a caller is supposed to set just moves a compile-time warning into a runtime `NullReferenceException`, which is the exact bug nullable reference types exist to prevent.

## Related

- [Fix: CS9035 "Required member 'X' must be set in the object initializer"](/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/) for the caller-side error you get once you mark a member `required`.
- [record vs class vs struct in C#: a decision matrix](/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) for picking the type shape before you decide how members get initialized.
- [How to use records with EF Core 11 correctly](/2026/04/how-to-use-records-with-ef-core-11-correctly/) for the `null!` DbSet idiom and members the ORM materializes by reflection.
- [How to write a custom JsonConverter in System.Text.Json](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) for taking over construction when serialization bypasses your constructor.
- [C# 14 null-conditional assignment](/2026/02/csharp-14-null-conditional-assignment/) for more of how C# reasons about null in everyday code.

## Sources

- Microsoft Learn, [Nullable reference type warnings (C# reference)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/nullable-warnings) (exact `CS8618` text, the "nonnullable reference not initialized" section, and the four fix techniques including `[MemberNotNull]` and `null!`).
- Microsoft Learn, [required modifier (C# reference)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/required) (how `required` moves the obligation to the caller and satisfies the non-null check).
- Microsoft Learn, [Working with nullable reference types in EF Core](https://learn.microsoft.com/en-us/ef/core/miscellaneous/nullable-reference-types) (the `DbSet` = `null!` pattern and why the compiler cannot see the base-class initialization).
- GitHub, [dotnet/roslyn Issue #60283](https://github.com/dotnet/roslyn/issues/60283) (why a null check in the constructor does not clear `CS8618`).
