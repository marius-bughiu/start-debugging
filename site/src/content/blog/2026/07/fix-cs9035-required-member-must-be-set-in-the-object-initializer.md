---
title: "Fix: CS9035 \"Required member 'X' must be set in the object initializer\" in C#"
description: "CS9035 means a member marked required was not assigned. Set it in the object initializer, or add a constructor annotated with [SetsRequiredMembers] that assigns every required member."
pubDate: 2026-07-06
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-14"
  - "dotnet"
  - "dotnet-11"
---

`CS9035` fires at compile time when you create an instance of a type that has a `required` member, but that member is not assigned. The compiler wants every `required` field or property set before the object escapes construction. Fix it the direct way: add the member to the object initializer, for example `new Person { Name = "Ada" }`. If a constructor already assigns the member, tell the compiler by putting `[SetsRequiredMembers]` on that constructor so it stops demanding the initializer. This is verified against C# 14 on .NET 11; the `required` modifier and this diagnostic have behaved the same way since C# 11 on .NET 7.

## The error in context

The full message names the exact member the compiler is missing:

```
error CS9035: Required member 'Person.Name' must be set in the object initializer or attribute constructor.
```

You will see one `CS9035` per unset required member, so a type with three required properties and a bare `new Person()` produces three errors at once. It is a compile-time diagnostic, not a runtime exception: the build fails, nothing runs. That is the whole point of `required`, the check moved from a `NullReferenceException` you hit in production to a red squiggle you see in the editor.

## Why this happens

The `required` modifier, introduced in C# 11, marks a field or property as mandatory at initialization time. When any expression constructs a new instance of the type, the compiler verifies that every `required` member is assigned, either through an object initializer or through a constructor that promises to set them. If it cannot prove that, it emits `CS9035`.

The key word is "prove." The compiler does not run your code. It only trusts two things: a member you assign directly in the object initializer, and a constructor explicitly annotated with `[SetsRequiredMembers]`. A constructor that happens to assign the member in its body but lacks the attribute counts for nothing, the compiler will not read the body to figure that out. This is why the error survives even when your constructor clearly sets the value: you have to tell the compiler, not show it.

Three situations produce the error:

- You call `new T()` or `new T { ... }` without assigning every `required` member.
- You wrote a constructor that sets the required members but forgot `[SetsRequiredMembers]`, so the compiler still demands an initializer.
- You added `required` to a member of a base type, and a derived type's construction path no longer satisfies it.

## Minimal repro

The smallest type that triggers `CS9035`:

```csharp
// .NET 11, C# 14
public class Person
{
    public required string Name { get; init; }
    public required string Email { get; init; }
    public int Age { get; init; }   // not required, optional
}
```

Every one of these constructions fails to compile:

```csharp
// .NET 11, C# 14
var a = new Person();                        // CS9035 x2 (Name and Email)
var b = new Person { Name = "Ada" };         // CS9035 x1 (Email still missing)
var c = new Person { Age = 36 };             // CS9035 x2 (Name and Email)
```

Only when both required members are present does it build:

```csharp
// .NET 11, C# 14 -- compiles
var ok = new Person { Name = "Ada", Email = "ada@example.com" };
```

Note that `Age` is left out and that is fine. `required` is per-member; optional members stay optional. The compiler cares only that the members carrying the `required` modifier are assigned.

## Fix, in detail

Work through these in order. The first one is the answer in the vast majority of cases; the rest cover the situations where an initializer is not what you want.

### 1. Assign the required members in the object initializer

The intended fix is to set every required member at the call site:

```csharp
// .NET 11, C# 14
var person = new Person
{
    Name = "Ada Lovelace",
    Email = "ada@example.com",
    // Age is optional, omit it freely
};
```

This is what `required` is for: the type's contract says these fields are mandatory, and the initializer honours it. If you find yourself repeating the same values, that is a signal the type wants a constructor, which is the next fix.

### 2. Add a constructor annotated with [SetsRequiredMembers]

When a constructor already takes the values and assigns them, decorate it with `System.Diagnostics.CodeAnalysis.SetsRequiredMembers`. This attribute asserts to the compiler that the constructor initializes every required member, so callers no longer need an object initializer:

```csharp
// .NET 11, C# 14
using System.Diagnostics.CodeAnalysis;

public class Person
{
    public required string Name { get; init; }
    public required string Email { get; init; }
    public int Age { get; init; }

    [SetsRequiredMembers]
    public Person(string name, string email)
    {
        Name = name;
        Email = email;
    }
}

// now this compiles, no initializer needed
var person = new Person("Ada", "ada@example.com");
```

One sharp edge: `[SetsRequiredMembers]` is an assertion, not a verified guarantee. The compiler takes your word for it and does not check that the constructor actually assigns every required member. If you add the attribute but forget to set `Email` in the body, you get no `CS9035` and no warning, just a `null` where you promised a value. Keep the attribute honest.

If you keep a parameterless constructor alongside the annotated one, callers of the parameterless version still need the initializer. The attribute only exempts the specific constructor it sits on.

### 3. Drop `required` if the member is not actually mandatory

If the member has a sensible default or is genuinely optional, it should not be `required` in the first place. Removing the modifier removes the obligation:

```csharp
// .NET 11, C# 14
public class Person
{
    public required string Name { get; init; }
    public string Email { get; init; } = "";   // was required, now optional with a default
}
```

This is the right call surprisingly often. Reach for `required` only when there is no reasonable default and construction without the value would leave the object in an invalid state. Giving a property a default and dropping `required` is cleaner than forcing every call site to pass an empty string.

### 4. For records, use a positional or [SetsRequiredMembers] constructor

A positional record generates an `init` property per parameter, but those are not `required` by default. If you explicitly add a `required` property to a record with a primary constructor, the primary constructor does not automatically satisfy it, and you get `CS9035` when you use the positional form. This trips people up because it looks like the constructor should count. See the design discussion in [dotnet/csharplang #6780](https://github.com/dotnet/csharplang/discussions/6780) for the reasoning. The fix is to either set the property in an initializer on top of the positional call, or add `[SetsRequiredMembers]` to a constructor that assigns it:

```csharp
// .NET 11, C# 14
using System.Diagnostics.CodeAnalysis;

public record Product(string Sku)
{
    public required string Name { get; init; }

    [SetsRequiredMembers]
    public Product(string sku, string name) : this(sku) => Name = name;
}

// both work now
var withInit = new Product("A-100") { Name = "Widget" };
var withCtor = new Product("A-100", "Widget");
```

If you want the whole record's construction to be enforced through the positional parameters, prefer plain `init` properties over `required` ones. Mixing positional records and `required` members is a source of confusion; decide which model the type uses. For a broader take on when a record earns its keep, see [record vs class vs struct in C#](/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/).

## Gotchas and variants

A handful of situations produce `CS9035`, or something that looks like it, for reasons that are not obvious from the message:

- **`[SetsRequiredMembers]` is trust, not proof.** As covered above, the compiler does not verify the constructor. A constructor with the attribute that skips a required member compiles clean and hands you a `null`. Treat the attribute as a contract you are responsible for keeping.

- **System.Text.Json respects `required`.** Since .NET 8, the JSON deserializer enforces required members: if the incoming JSON omits a required property, deserialization throws a `JsonException` at runtime rather than producing a half-built object. This is a runtime error, not `CS9035`, but it is the same contract showing up on the deserialization path. If you see a deserialization failure mentioning a required member, the JSON is missing a field the type demands. For the general shape of that error, see [the JSON value could not be converted](/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/), and if you need custom construction logic, [how to write a custom JsonConverter in System.Text.Json](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/). A converter that constructs the object itself sidesteps the required-member check, so it is also an escape hatch when a type you do not own is fighting you.

- **Reflection and `Activator.CreateInstance` bypass the check entirely.** `required` is enforced by the C# compiler, not the runtime. `Activator.CreateInstance(typeof(Person))` compiles and runs, leaving required reference members as `null`. If a framework builds your objects through reflection without honouring `[SetsRequiredMembers]`, you can end up with an "impossible" object that the compiler would never have let you write by hand. ORMs and serializers that materialize objects are the usual suspects; check whether they support required members before relying on the modifier for those types. This matters for entities in particular, see [how to use records with EF Core 11 correctly](/2026/04/how-to-use-records-with-ef-core-11-correctly/).

- **Inheritance carries the obligation down.** If a base class has a `required` member, every derived type must also satisfy it at construction, and a derived constructor that does not set it needs `[SetsRequiredMembers]` or leaves the requirement to the caller's initializer. Adding `required` to a base member is a source-breaking change for all constructors in the hierarchy that were relying on the member being optional.

- **`init` vs `set` does not matter to `required`.** `required` is orthogonal to the setter's accessibility. You can mark a `required` member with `init` (settable only during construction) or a normal `set`. The modifier controls whether the member must be assigned; the accessor controls when it can be assigned. A common pattern is `public required string Name { get; init; }`, mandatory to set, and only at construction.

- **The member must be at least as accessible as the type.** A `required` member has to be settable by any code that can construct the type. A `public` type with a `required` member that has an `internal` init accessor produces a different diagnostic (`CS9032`/`CS9033`), because external callers could construct the type but not satisfy its requirement. If you narrow a required member's accessor, narrow the constructor or type too.

The mental model to keep: `required` moves a "you must provide this" rule from a runtime hope into a compile-time guarantee, and `CS9035` is that guarantee doing its job. When you see it, the fix is always one of "provide the value at the call site" or "tell the compiler a constructor already provides it." Decide which is true for the type, then either fill in the initializer or add `[SetsRequiredMembers]`, and never reach for the attribute as a way to silence the error without actually setting the member.

## Related

- [record vs class vs struct in C#: a decision matrix](/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) for choosing the right type shape before you sprinkle `required` on it.
- [How to use records with EF Core 11 correctly](/2026/04/how-to-use-records-with-ef-core-11-correctly/) for how required members interact with entities the ORM materializes by reflection.
- [How to write a custom JsonConverter in System.Text.Json](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) for taking over construction when the default serializer fights your required members.
- [Fix: The JSON value could not be converted](/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/) for the runtime side of the same contract during deserialization.
- [How to declare extension properties in C# 14](/2026/06/how-to-declare-extension-properties-in-csharp-14/) for more of what C# 14's property model can and cannot express.

## Sources

- Microsoft Learn, [required modifier (C# reference)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/required) (semantics of `required`, the `SetsRequiredMembers` attribute, and the rule that the compiler does not verify the constructor body).
- Microsoft Learn, [Object and collection initializers](https://learn.microsoft.com/en-us/dotnet/csharp/programming-guide/classes-and-structs/object-and-collection-initializers) (how required members must be set through an initializer or attribute constructor).
- GitHub, [dotnet/csharplang Discussion #6780](https://github.com/dotnet/csharplang/discussions/6780) (why `CS9035` is raised for records that combine a primary constructor with explicit `required` properties).
