---
title: "C# 11 – file access modifier & file-scoped types"
description: "The file modifier restricts a type’s scope and visibility to the file in which it is declared. This is especially useful in situations where you want to avoid name collisions among types – like in the case of generated types using source generators. A quick example: In terms of restrictions we have the following: On…"
pubDate: 2023-03-18
updatedDate: 2023-11-05
tags:
  - "c-sharp"
---
The **file** modifier restricts a type’s scope and visibility to the file in which it is declared. This is especially useful in situations where you want to avoid name collisions among types – like in the case of generated types using source generators.

A quick example:

```cs
file class MyLocalType { }
```

In terms of restrictions we have the following:

-   types nested inside a file-scoped type will only be visible withing the file in which they are declared
-   other types in the assembly may use the same fully qualified name as the file-scoped type without creating a name collision
-   file-local types can’t be used as the return type or parameter of any member that is more visible than the `file` scope
-   similarly, a file-scoped type can’t be a field member of a type that is more visible than the `file` scope

On the other hand:

-   A more visible type can implicitly implement a file-scoped interface
-   A more visible type can also explicitly implement a file-scoped interface with the condition that explicit implementations can only be used within the file scope

## Implementing a file-scoped interface implicitly

A public class can implement a file-scoped interface as long as they are defined in the same file. In the example below you have the file-scoped interface `ICalculator` which is implemented by a public class `Calculator`.

```cs
file interface ICalculator
{
    int Sum(int x, int y);
}

public class Calculator : ICalculator
{
    public int Sum(int x, int y) => x + y;
}
```
