---
title: "C# 14 – The field keyword and field-backed properties"
description: "C# 14 introduces the field contextual keyword for property accessors, letting you add custom logic to auto-properties without declaring a separate backing field."
pubDate: 2025-04-05
tags:
  - "csharp-14"
  - "csharp"
  - "dotnet"
  - "dotnet-10"
---
C# 14 introduces a new contextual keyword, **`field`**, that can be used inside a property’s accessors (the `get`, `set`, or `init` blocks) to refer to the property’s backing storage​. In simpler terms, `field` is a placeholder representing the hidden variable where a property’s value is stored. This keyword lets you add custom logic to automatically implemented properties without manually declaring a separate private field. It was first made available as a preview in C# 13 (requiring .NET 9 with the language version set to preview)​, and is officially part of the language in C# 14.

**Why is this useful?** Before C# 14, if you wanted to add logic (like validation or change notification) to a property, you had to turn it into a full property with a private backing field. That meant more boilerplate code and the risk of other class members accidentally using that field directly, bypassing your property logic​. The new `field` keyword addresses these issues by letting the compiler generate and manage the backing field for you, while you simply use `field` in your property code. This results in cleaner, more maintainable property declarations and prevents the backing storage from “leaking” into the rest of your class’s scope​.

## `field` benefits & use cases

The `field` keyword was introduced to make property declarations more concise and less error-prone. Here are the key benefits and scenarios where it’s useful:

-   **Eliminating manual backing fields:** You no longer need to write a private member field for each property just to add custom behavior. The compiler provides a hidden backing field automatically, accessed via the `field` keyword​. This reduces boilerplate code and keeps your class definition cleaner.
-   **Keeping property state encapsulated:** The backing field created by the compiler is only accessible through the property’s accessors (via `field`), not elsewhere in your class. This prevents accidental misuse of the field from other methods or properties, ensuring that any invariants or validations in the property accessor can’t be bypassed​.
-   **Easier property logic (validation, lazy initialization, etc.):** It provides a smooth path to add logic to auto-properties. Common scenarios include:
    
    -   _Validation or range checking:_ e.g. ensuring a value is non-negative or within a range before accepting it.
    -   _Change notification:_ e.g. raising `INotifyPropertyChanged` events after setting a new value.
    -   _Lazy initialization or defaulting:_ e.g. in a getter, initialize `field` on first access or return a default if it's not set.


    In earlier C# versions, these scenarios required writing a full property with a separate field. With `field`, you can implement them directly in the property’s `get`/`set` logic without extra fields​.
-   **Mixing auto and custom accessors:** C# 14 allows you to have one accessor auto-implemented and the other with a body using `field`. For example, you can provide a custom `set` and leave `get` as automatic, or vice versa​. The compiler generates whatever is needed for the accessor you don’t write. This was not possible before – previously, adding a body to one accessor meant you had to provide an explicit implementation for both.

Overall, `field` improves readability and maintainability by removing redundant code and focusing only on the custom behavior you need​. It’s conceptually similar to how the `value` keyword works in a setter (representing the value being assigned); here `field` represents the underlying storage for the property​.

## Before vs. After: manual backing field vs. `field` keyword

To see the difference, let’s compare how you would declare a property that enforces some rule **before** C# 14 and **after** using the new `field` keyword.

**Scenario:** Suppose we want a property `Hours` that must never be set to a negative number. In older C# versions, we’d do the following:

**Before C# 14 – using a manual backing field:**

```cs
public class TimePeriodBefore
{
    private double _hours;  // backing field

    public double Hours
    {
        get { return _hours; }
        set 
        {
            if (value < 0)
                throw new ArgumentOutOfRangeException(nameof(value), "Value must not be negative");
            _hours = value;
        }
    }
}
```

In this pre-C#14 code, we had to introduce a private field `_hours` to store the value. The property’s getter returns this field, and the setter performs a check before assigning to `_hours`. This approach works, but it’s verbose: we have extra code to declare and manage `_hours`, and `_hours` is accessible anywhere in the class (meaning other methods **could** write to `_hours` and bypass the validation logic if one isn’t careful).

**Starting with C# 14 – using the `field` keyword:**

```cs
public class TimePeriod
{
    public double Hours
    {
        get;  // auto-implemented getter (compiler provides it)
        set => field = (value >= 0) 
            ? value 
            : throw new ArgumentOutOfRangeException(nameof(value), "Value must not be negative");
    }
}
```

Here, the `Hours` property is declared with no explicit backing field. We use `get;` with no body, indicating an automatic getter, and we provide a body for `set` that uses `field`. The expression `field = ...` inside the setter tells the compiler to assign to the property’s backing field. The compiler will automatically generate a private field behind the scenes and implement the `get` accessor to return that field. In the setter above, if the `value` is negative, we throw an exception; otherwise, we assign it to `field` (which stores it). We did **not** have to declare `_hours` ourselves, and there’s no need to write the getter’s body either – the compiler does those for us​. The result is a more concise property definition with the same behavior.

Notice how much cleaner the C# 14 version is:

-   we removed the explicit `_hours` field; the compiler handles it.
-   the `get` accessor remains a simple auto-implemented one (`get;`), which the compiler will turn into “return the backing field”.
-   the `set` accessor contains only the logic we care about (the non-negative check); the actual storage assignment is handled by `field = value`.

You can also use `field` in a `get` accessor if needed. For example, to implement lazy initialization, you might do something like:

```cs
public string Name 
{
    get => field ??= "Unknown";
    set => field = value;
}
```

In this case, the first time `Name` is accessed, if it wasn’t set, the getter assigns a default `"Unknown"` to the backing field and returns it. Subsequent gets or any set will use the same `field`. Without this feature, you would have needed a private field and more code in the getter to accomplish the same behavior.

## How does the compiler handle the `field` keyword?

When you use `field` inside a property accessor, the compiler quietly generates a hidden backing field for that property (very similar to how it does for an auto-implemented property). You never see this field in your source code, but the compiler gives it an internal name (for example, something like `<Hours>k__BackingField`) and uses it to store the property’s value. Here’s what happens under the hood:

-   **Backing field generation:** If at least one accessor of a property uses `field` (or if you have an auto-implemented property with no bodies), the compiler creates a private field to hold the value​. You do not need to declare this field yourself. In our `TimePeriod.Hours` example above, the compiler would generate a field to store the hour value, and both the `get` and `set` accessors will operate on that field (either implicitly or via the `field` keyword).
-   **Getter/setter implementation:**
    -   For an auto-implemented accessor (like `get;` or `set;` with no body), the compiler automatically generates the simple logic to return or set the backing field.
    -   For an accessor where you provided a body using `field`, the compiler inlines your logic and treats `field` as a reference to the backing field in that generated code. For instance, `set => field = value;` becomes something akin to `set { backingField = value; }` in the compiled output, with any additional logic you wrote preserved around it.
    -   You can mix and match auto and custom accessors​. For example, if you write a body for `set` (using `field`) and leave `get` as `get;`, the compiler generates the `get` for you. Conversely, you could write a custom `get` (e.g. `get => ComputeSomething(field)`) and have an auto-implemented `set;` in which case the compiler generates the setter to simply assign the backing field.
-   **Behavior is equivalent to manual fields:** the compiled result using `field` is essentially the same as if you had manually written a private field and used it in your property. There’s no performance penalty or magic beyond saving you from writing boilerplate. It’s purely a compile-time convenience feature. For example, the two `Hours` implementations above (with and without `field`) compile down to very similar IL code – both have a private field to store the value and property accessors that manipulate that field. The difference is the C# 14 compiler wrote one of them for you.
-   **Property initializers:** if you use an initializer on a property that uses `field` (for example, `public int X { get; set => field = value; } = 42;`), the initializer will directly initialize the backing field _before_ the constructor runs, just as it does for traditional auto-properties. It will **not** call the setter logic during object construction​. (This is important to note if your setter has side effects, those won’t happen for the initial value set via an initializer. If you need the setter logic to run for initialization, you should assign the property in the constructor instead of using an initializer.)
-   **Attributes on the backing field:** If you need to apply attributes to the generated backing field, C# allows _field-targeted attributes_ using `[field: ...]` syntax. This was already possible with auto-properties, and it works here too. For example, you can do `[field: NonSerialized] public int Id { get; set => field = value; }` to mark the auto-generated field as non-serialized​. (This only works if a backing field actually exists for the property, i.e. you have at least one accessor using `field` or an auto property.)

TLDR; the compiler generates a private backing field and wires up your property accessors to use it. You get the functionality of a full property with a fraction of the code. The property remains a true automatic property from an implementation standpoint – you just got a hook to inject logic into it.

## Syntax and usage rules for `field`

When using the `field` keyword, keep in mind the following rules and limitations:

-   **Only inside property/indexer accessors:** `field` can **only** be used within the body of a property or indexer accessor (the code block or expression for `get`, `set`, or `init`). It is a _contextual_ keyword, meaning that outside of a property’s accessor, `field` has no special meaning (it would just be considered an identifier). If you try to use `field` in a regular method or outside a property, you’ll get a compile error – the compiler won’t know what backing field you’re referring to.
-   **Contextual keyword (not fully reserved):** because `field` is not a globally reserved keyword, you technically could have variables or members named `field` in other parts of your code. However, within a property’s accessor, `field` is treated as a keyword and will refer to the backing field, not to any variable named `field`​. See “naming conflicts” below for how to handle that scenario.
-   **Use in get/set/init accessors:** you can use `field` inside a `get`, `set`, or `init` accessor. In a setter or init accessor, `field` is typically assigned to (e.g. `field = value;`). In a getter, you might return or modify `field` (e.g. `return field;` or `field ??= defaultValue;`). You can use `field` in one accessor, or both, depending on your needs:
    -   If you use `field` in **only one accessor**, you can leave the other accessor as auto-implemented (`get;` or `set;` without a body) and the compiler will still create the backing field and hook everything up​.
    -   If you use `field` in **both** accessors, that’s fine too – you’re effectively writing out both get and set logic (but still without manually declaring the field). This might be done if both reading and writing need special handling. For example, a setter might enforce a condition and a getter might do some transformation or lazy load on first access, both utilizing the same `field`.
-   **Cannot refer to `field` outside the accessor:** you cannot store the `field` reference and use it elsewhere, nor can you directly access the compiler-generated backing field outside the property. For all intents and purposes, that backing field is anonymous in your source code (though the compiler gives it an internal name). If you need to interact with the value, do so through the property or within its accessors using `field`.
-   **Not for events:** The `field` keyword is designed for properties (and indexers). It is **not** available for event add/remove accessors. (Events in C# can also have backing fields for the delegate, but the language team decided not to extend `field` to event accessors​.)
-   **No mixing with explicit field declarations:** if you choose to declare your own backing field for a property, you shouldn’t use `field` in that property’s accessors. In such a case, you would just refer to your explicit field by name as you traditionally would. The `field` keyword is intended to replace the need for an explicit field in those scenarios. In other words, a property either has an implicit compiler-managed field (when you use `field` or auto accessors), or you manage it yourself – but not both.

To put it simply: use `field` inside your property accessors to refer to that property’s hidden storage, and nowhere else. Follow normal C# scoping rules for everything outside of properties.

## Handling naming conflicts (when you have your own `field` variable)

Because `field` wasn’t a reserved word in older C# versions, it’s possible (though uncommon) that some code might have used “field” as a variable name or field name. With the introduction of the `field` contextual keyword in accessors, such code could become ambiguous or break. The language design takes this into account:

-   **`field` in an accessor shadows identifiers:** inside property accessors, the new `field` keyword will **shadow** any identifier named `field` that you might have in that scope​. For instance, if you had a local variable or parameter called `field` inside a setter (perhaps from older code), the compiler will now interpret `field` as the backing field keyword, not your variable. In C# 14, this results in a compile error if you attempt to declare or use a variable named `field` in an accessor, because `field` is expected to be the keyword now​.
-   **Use `@field` or `this.field` to refer to the actual field:** if you _do_ have a member field literally named “field” in your class (not recommended, but possible), or a variable in scope named “field,” you can still reference that by escaping the name. C# allows you to prefix an identifier with `@` to use it even if it’s a keyword. For example, if your class has `private int field;` and you need to refer to it in an accessor, you can write `@field` to access it as an identifier​. Similarly, you could use `this.field` to explicitly refer to the member field. Using `@` or a qualifier bypasses the contextual keyword interpretation and lets you access the actual variable.

```cs
private int field = 10; // a field unfortunately named "field" 
public int Example
{
    get { return @field; } // use @field to return the actual field 
    set { @field = value; } // or this.field = value; either works 
}
```

-   However, if you are in a position to do so, it’s better to just rename the member to avoid confusion. In modern C#, `field` by itself in an accessor should be reserved for the compiler’s backing field. In fact, if you upgrade an older codebase to C# 14, the compiler will warn you if it finds usages of `field` that would have referred to something else before – indicating that you should disambiguate them​.
-   **Avoiding the name altogether:** as a general best practice, try not to use `field` as an identifier name in your code. Now that it’s a keyword (in context), treating it as a normal name will confuse readers and could lead to errors. If you had been using `field` as a variable name, consider renaming it when moving to C# 14. Common naming conventions (like prefixing private fields with `_` or similar) would naturally prevent this conflict in most cases.

## References

1.  [`field` – Field backed property declarations](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/field#:~:text=The%20,contextual%20keyword)​
2.  ​[C# Feature Proposal Notes – _“`field` keyword in properties”_](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-14.0/field-keyword#:~:text=Auto%20properties%20only%20allow%20for,accessors%20from%20within%20the%20class)
3.  ​[What’s new in C# 14](/2024/12/csharp-14/)
