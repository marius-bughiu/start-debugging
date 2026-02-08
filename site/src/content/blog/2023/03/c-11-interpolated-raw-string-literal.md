---
title: "C# 11 – Interpolated raw string literal"
description: "C# 11 introduces the concept of raw string literals to the language and with that come a set of new features for string interpolation as well. First of all, you can continue to use the interpolation syntax as you know it in combination with raw string literals like this: The output will be: Escaping braces…"
pubDate: 2023-03-17
updatedDate: 2023-11-05
tags:
  - "c-sharp"
---
C# 11 introduces the concept of [raw string literals](/2023/03/c-raw-string-literals/) to the language and with that come a set of new features for string interpolation as well.

First of all, you can continue to use the interpolation syntax as you know it in combination with raw string literals like this:

```cs
var x = 5, y = 4;
var interpolatedRaw = $"""The sum of "{x}" and "{y}" is "{ x + y }".""";
```

The output will be:

```plaintext
The sum of "5" and "4" is "9".
```

## Escaping braces { and }

You can escape braces by doubling them. If we take the example above and double the braces:

```cs
var interpolatedRaw= $"""The sum of "{{x}}" and "{{y}}" is "{{ x + y }}".""";
```

The output will be:

```plaintext
The sum of "{x}" and "{y}" is "{ x + y }".
```

As you can see, the braces no longer play an interpolation role, and each double brace ends up as a single brace in the output.

## Multiple $ characters in interpolated raw string literals

You can use multiple **$** characters in an interpolated raw string literal in a similar manner to the **“””** sequence. The number of $ characters that you use at the start of the string determines the number of { and } you need for string interpolation.  
  
For example, the two strings below will output the exact same thing as our initial example:

```cs
var interpolatedRaw2 = $$"""The sum of "{{x}}" and "{{y}}" is "{{ x + y }}".""";
var interpolatedRaw3 = $$$"""The sum of "{{{x}}}" and "{{{y}}}" is "{{{ x + y }}}".""";
```

## Conditional operator in interpolated string

The colon (:) has special meaning in interpolated strings, and as a result, conditional expressions need an additional set of round brackets ( ) to work. For example:

```cs
var conditionalInterpolated = $"I am "{x}" year{(age == 1 ? "" : "s")} old.";
```

## Errors

> Error CS9006 The interpolated raw string literal does not start with enough ‘$’ characters to allow this many consecutive opening braces as content.

This compiler error occurs when your string contains a sequence of brace characters which is equal to or greater than double the lenght of the sequence of the $ characters found at the start of your string.
