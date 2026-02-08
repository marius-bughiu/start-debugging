---
title: "C# using var (using declaration)"
description: "Ever wished you’d declare something which gets disposed automatically when it’s enclosing scope finishes executing without adding yet another set of curly braces and indentation to your code? You are not alone. Say hello to C# 8 using declarations 🥰. With using var you can now do: instead of: No more unecesary curly brackets, no…"
pubDate: 2020-05-01
updatedDate: 2023-11-05
tags:
  - "c-sharp"
---
Ever wished you’d declare something which gets disposed automatically when it’s enclosing scope finishes executing without adding yet another set of curly braces and indentation to your code? You are not alone. Say hello to C# 8 using declarations 🥰.

With using var you can now do:

```cs
void Foo()
{
    using var file = new System.IO.StreamWriter("myFile.txt");
    // code using file
}
```

instead of:

```cs
void Foo()
{
    using (var file = new System.IO.StreamWriter("myFile.txt"))
    {
        // code using file
    }
}
```

No more unecesary curly brackets, no more indentation. The scope of the disposable matches the scope of it’s parent.

Now for a more complete using var example:

```cs
static int SplitFile(string filePath)
{
    var dir = Path.GetDirectoryName(filePath);
    using var sourceFile = new StreamReader(filePath);

    int count = 0;
    while(!sourceFile.EndOfStream)
    {
        count++;

        var line = sourceFile.ReadLine();

        var linePath = Path.Combine(dir, $"{count}.txt");
        using var lineFile = new StreamWriter(linePath);

        lineFile.WriteLine(line);

    } // lineFile is disposed here, at the end of each individual while loop

    return count;

} // sourceFile is disposed here, at the end of it's enclosing scope
```

As you can notice in the example above, the containing scope doesn’t have to be a method. It can also be the inside of a `for`, `foreach` or `while` statement for example, or even a `using` block if you are that savage. In each of these cases the object will be disposed at the end of the enclosing scope.

## Error CS1674

Using var declarations also come with compile-time errors in case the expression following `using` isn’t an `IDisposable`.

> Error CS1674 ‘string’: type used in a using statement must be implicitly convertible to ‘System.IDisposable’.

## Best practices

In terms of best practices for `using var`, pretty much follow the same guidelines as you would when working with using statements. In addition to those you might want to:

-   declare your disposable variables at the start of the scope, separate of the other variables, so that they stand out and are easy to spot when browsing the code
-   pay attention in which scope you create them because they will live for the duration of that entire scope. If the disposable value is only needed inside a shorter-lived child scope, it might make sense to create it there.
