---
title: "C# 12 – Alias any type"
description: "The using alias directive has been relaxed in C# 12 to allow aliasing any sort of type, not just named types. This means that you can now alias tuples, pointers, array types, generic types, etc. So instead of using the full structural form of a tuple, you can now alias it with a short descriptive…"
pubDate: 2023-08-06
updatedDate: 2023-11-05
tags:
  - "c-sharp"
---
The using alias directive has been relaxed in C# 12 to allow aliasing any sort of type, not just named types. This means that you can now alias tuples, pointers, array types, generic types, etc. So instead of using the full structural form of a tuple, you can now alias it with a short descriptive name which you can use everywhere.

Let’s take a quick example of aliasing a tuple. First, declare the alias:

```cs
using Point = (int x, int y);
```

Then use it like any other type. You can use it as a return type, in the parameters list of a method, or even for constructing new instances of that type. There’s virtually no limits around it.

An example of using the tuple alias declared above:

```cs
Point Copy(Point source)
{
    return new Point(source.x, source.y);
}
```

Like until now, the type aliases are only valid in the file in which they are defined.

### Restrictions

At least for the moment, you will need to specify the fully qualified type name of the types for anything that’s a non-primitive. For example:

```cs
using CarDictionary = System.Collections.Generic.Dictionary<string, ConsoleApp8.Car<System.Guid>>;
```

At most, you can get rid of your app’s namespace by defining the alias within the namespace itself.

```cs
namespace ConsoleApp8
{
    using CarDictionary = System.Collections.Generic.Dictionary<string, Car<System.Guid>>;
}
```

### Error CS8652

> The feature ‘using type alias’ is currently in Preview and _unsupported_. To use Preview features, use the ‘preview’ language version.

This error means that your project does not use C# 12 yet, so you cannot use the new language features. If you wish to switch to C# 12 and don’t know how, check out [our guide to switching your project to C# 12](/2023/06/how-to-switch-to-c-12/).
