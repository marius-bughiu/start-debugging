---
title: "C# 11 – Raw string literals"
description: "Learn how to use C# 11 raw string literals to include whitespace, new lines, and embedded quotes without escape sequences."
pubDate: 2023-03-15
updatedDate: 2023-11-05
tags:
  - "csharp"
---
Raw string literals are a new format which enables you to include whitespace, new lines, embedded quotes, and other special characters in your string, without requiring escape sequences.

How does it work:

-   a raw string literal starts with three or more double-quote (**“””**) characters. It’s up to you how many double-quote characters you use to wrap your literal.
-   it ends with the same number of double-quote characters that you used at the start
-   multi-line raw string literals require the opening and closing sequences to be placed on separate lines. The newlines following the opening quote and preceding the closing quote aren’t included in the final content.
-   any whitespace to the left of the closing double quotes will be removed from the string literal (from all the lines – we touch on this in more detail a bit lower)
-   lines must start with the same amount of whitespace (or more) as the closing sequence
-   in multi-line raw literals, whitespace following the opening sequence, on the same line, is ignored

A quick example:

```cs
string rawString = """
    Lorem ipsum "dolor" sit amet,
        consectetur adipiscing elit.
    """;
```

This will output the following:

```plaintext
Lorem ipsum "dolor" sit amet,
    consectetur adipiscing elit.
```

## Whitespace before the closing sequence

The whitespace before the closing double-quotes controls the whitespace which is removed from your raw string expression. In the example above, we had 4 white spaces before the **“””** sequence, so four spaces were removed from each line of the expression. If we only had 2 white spaces before the end sequence, only 2 white space characters would have been removed from each line of the raw string.

### Example: No whitespace before the end sequence

In the previous example – if we didn’t specify any whitespace before the end sequence, the resulting string would maintain the indentation exactly as it was.

**Expression:**

```cs
string rawString = """
    Lorem ipsum "dolor" sit amet,
        consectetur adipiscing elit.
""";
```

**Output:**

```plaintext
    Lorem ipsum "dolor" sit amet,
        consectetur adipiscing elit.
```

## Using more than 3 double-quotes in your opening / closing sequence

This is useful when you have a 3 double-quote sequence in the raw string itself. In the example below we use a 5 double-quote sequence to start and end the raw string literal, so we’re able to include in the content double-quote sequences of 3 and 4.

```cs
string rawString = """""
    3 double-quotes: """
    4 double-quotes: """"
    """"";
```

**Output:**

```plaintext
3 double-quotes: """
4 double-quotes: """"
```

## Associated errors

> CS8997: Unterminated raw string literal.

```cs
string rawString = """Lorem ipsum "dolor" sit amet,
        consectetur adipiscing elit. 
    """;
```

> CS9000: Raw string literal delimiter must be on its own line.

```cs
var rawString = """
    Lorem ipsum "dolor" sit amet,
        consectetur adipiscing elit.""";
```

> CS8999: Line does not start with the same whitespace as the closing line of the raw string literal.

```cs
var rawString = """
    Lorem ipsum "dolor" sit amet,
consectetur adipiscing elit.
    """;
```
