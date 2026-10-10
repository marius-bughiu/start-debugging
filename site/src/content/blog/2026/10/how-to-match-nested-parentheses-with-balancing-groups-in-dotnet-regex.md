---
title: "How to Match Nested Parentheses and Balanced Tags with Balancing Groups in .NET Regex"
description: "Balancing groups (?<name>) and (?<-name>) turn a .NET regex capture group into a stack, so one pattern can match arbitrarily nested parentheses or <div> tags. The full pattern, how the stack works, inner-content capture with (?<inner-open>), and the gotchas verified on .NET 11 RC1: the empty-stack check, catastrophic backtracking, NonBacktracking, and mixed bracket types."
pubDate: 2026-10-10
template: how-to
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "regex"
  - "how-to"
---

**Short answer:** in .NET, every capture group keeps a stack of its captures, and a balancing group lets you push and pop that stack from inside the pattern. `(?<depth>)` pushes on an opening bracket, `(?<-depth>)` pops on a closing one, and the conditional `(?(depth)(?!))` at the end fails the match if anything is still on the stack. Put together, `\((?>[^()]+|\((?<depth>)|\)(?<-depth>))*(?(depth)(?!))\)` matches one complete, arbitrarily nested parenthesized group. Every example below was run on .NET 11 RC1 (`11.0.100-rc.1.26425.128`), but the feature has been in `System.Text.RegularExpressions` unchanged since .NET Framework 1.0, so the patterns work on .NET 8, 9 and 10 too.

Most regex engines cannot do this at all. Classic regular expressions describe regular languages, and "balanced parentheses" is the textbook example of a language that is not regular: you need a counter, and a finite automaton has none. PCRE and Perl solve it with recursion (`(?R)`). .NET took a different route and gave you the stack directly. Once you see the stack, the syntax stops looking like line noise.

## Why `\(.*\)` and `\(.*?\)` both give the wrong answer

Take the input `f(a(b)c) + g(d)` and try the two patterns everyone reaches for first:

```csharp
// .NET 11, C# 14
using System.Text.RegularExpressions;

var input = "f(a(b)c) + g(d)";

Console.WriteLine(Regex.Match(input, @"\(.*\)").Value);
// (a(b)c) + g(d)    greedy: runs to the LAST ')'

Console.WriteLine(Regex.Match(input, @"\(.*?\)").Value);
// (a(b)             lazy: stops at the FIRST ')'
```

Neither is "the matching `)`". The greedy one swallows two separate groups, the lazy one cuts the nested group in half. What you actually want is "the `)` at which the number of opens minus the number of closes drops back to zero", and that requires counting. That counter is what balancing groups give you.

## How a .NET capture group becomes a stack

When a named group participates in a match more than once (say, inside a `*` loop), .NET does not throw the earlier captures away. `Match.Groups["name"].Captures` holds all of them, in order, and the engine treats the most recent one as the top of a stack. That is why backreferences like `\k<name>` always see the last capture.

The balancing group syntax manipulates that stack:

| Syntax | Effect |
|---|---|
| `(?<open>...)` | Normal named capture. Pushes a capture onto `open`'s stack. `(?<open>)` with an empty body pushes a zero-width capture, which works as a pure counter increment. |
| `(?<-open>...)` | Pops the top capture off `open`'s stack. If the stack is empty, this alternative **fails** and the engine backtracks. |
| `(?<inner-open>...)` | Pops `open` and pushes onto `inner` a capture spanning from the end of the popped capture to the start of the current position. This is how you grab the content between a matched pair. |
| `(?(open)yes\|no)` | Conditional: takes the `yes` branch if `open` has at least one capture on its stack. |
| `(?!)` | An empty negative lookahead. It can never succeed, so it means "fail here". |

The single-quote forms `(?'open')`, `(?'-open')` and `(?'inner-open')` are identical; they exist so you can write patterns inside XML attributes without escaping angle brackets. Numbered groups work as well: `(?<-1>\))` pops group 1.

One parse-time rule: the group you pop must exist somewhere in the pattern. `^\)(?<-d>)` on its own throws `RegexParseException: Reference to undefined group name 'd'` from the `Regex` constructor, not a failed match.

## Match one balanced group of parentheses, step by step

Here is the canonical pattern, written with `RegexOptions.IgnorePatternWhitespace` so it can carry comments:

```csharp
// .NET 11, C# 14
using System.Text.RegularExpressions;

var balanced = new Regex(@"
    \(                      # the outer opening paren
    (?>
        [^()]+              # a run of anything that is not a paren
      | \( (?<depth>)       # an inner '(' pushes onto 'depth'
      | \) (?<-depth>)      # an inner ')' pops 'depth' (fails if empty)
    )*
    (?(depth)(?!))          # if 'depth' is not empty, fail
    \)                      # the outer closing paren
", RegexOptions.IgnorePatternWhitespace);

foreach (Match m in balanced.Matches("f(a(b)c) + g(d) + h((x)"))
    Console.WriteLine($"{m.Value} @{m.Index}");

// (a(b)c) @1
// (d) @12
// (x) @20
```

Walk through `(a(b)c)`:

1. The literal `\(` consumes the outer `(`. The `depth` stack is empty.
2. `[^()]+` consumes `a`.
3. The inner `(` hits the second alternative, and `(?<depth>)` pushes a capture. Depth is 1.
4. `[^()]+` consumes `b`.
5. The `)` hits the third alternative, and `(?<-depth>)` pops. Depth is 0.
6. `[^()]+` consumes `c`.
7. The final `)` would be popped by the third alternative, but the stack is empty, so `(?<-depth>)` fails. The loop ends and gives that `)` back.
8. `(?(depth)(?!))` sees an empty stack and takes no branch, so it succeeds.
9. The literal `\)` consumes the outer `)`. Match.

Step 7 is the subtle one. The pop failing on an empty stack is what stops the loop from eating the outer closing paren, so the pattern naturally stops at the correct `)`.

Note the last input, `h((x)`. The first `(` never gets closed, so no match can start there. The engine moves on, starts at the second `(`, and returns the well-formed `(x)` at index 20. That is usually what you want when you are scanning text for complete groups.

## Why the `(?(depth)(?!))` check is not optional

It is tempting to drop the conditional because the outer `\(...\)` seems to bracket things. It doesn't. Compare the two patterns on `((a)`:

```csharp
// .NET 11, C# 14
var noCheck   = new Regex(@"\((?>[^()]+|\((?<d>)|\)(?<-d>))*\)");
var withCheck = new Regex(@"\((?>[^()]+|\((?<d>)|\)(?<-d>))*(?(d)(?!))\)");

Console.WriteLine(noCheck.Match("((a)").Value);    // ((a)   unbalanced!
Console.WriteLine(withCheck.Match("((a)").Value);  // (a)
```

Without the check, the outer `\(` takes the first `(`, the loop pushes the second `(`, consumes `a`, and pops on the `)`. Now the trailing `\)` has nothing left to match, so the engine backtracks: the loop gives back its last iteration (undoing the pop), and the trailing `\)` takes that `)` instead. The match succeeds with one `(` still on the stack. The stack only enforces "never close more than you opened". "Close everything you opened" is the conditional's job.

## Validate that a whole string is balanced

To answer "is this string balanced?" rather than "find balanced groups in it", anchor both ends and drop the outer literal parens:

```csharp
// .NET 11, C# 14
var valid = new Regex(@"^(?>[^()]+|\((?<d>)|\)(?<-d>))*(?(d)(?!))$");

foreach (var s in new[] { "a(b(c)d)e", "a(b(c)d", "a)b(c", "", "())(" })
    Console.WriteLine($"'{s}': {valid.IsMatch(s)}");

// 'a(b(c)d)e': True
// 'a(b(c)d': False    one '(' left on the stack
// 'a)b(c': False      ')' with an empty stack
// '': True
// '())(': False
```

## Capture the content between each matched pair

The two-name form `(?<inner-open>\))` pops `open` and records the text between the popped `(` and the current `)` as a capture of `inner`. You get every nested level's content, innermost first:

```csharp
// .NET 11, C# 14
var inner = new Regex(@"(?>[^()]+|(?<open>\()|(?<inner-open>\)))*(?(open)(?!))");

Match m = inner.Match("x(a(b)c)(d)");
foreach (Capture c in m.Groups["inner"].Captures)
    Console.WriteLine($"{c.Value} @{c.Index}");

// b @4
// a(b)c @2
// d @9
```

The order is the order in which the pairs **close**, which is why `b` comes before `a(b)c`. If you need the outermost groups only, filter by checking that no other capture's span contains this one, or switch back to the single-group pattern from the previous section and use `Matches`.

## Match nested `<div>` tags

The same structure works for any pair of delimiters, including multi-character ones. The only change is the "anything else" branch: instead of a character class, use `(?!</?div\b).` so that it consumes one character at a time but never the start of an opening or closing `div` tag.

```csharp
// .NET 11, C# 14
var divs = new Regex(@"
    <div\b[^>]*>
    (?>
        <div\b[^>]*>  (?<depth>)
      | </div>        (?<-depth>)
      | (?!</?div\b) .
    )*
    (?(depth)(?!))
    </div>",
    RegexOptions.IgnorePatternWhitespace | RegexOptions.Singleline | RegexOptions.IgnoreCase);

var html = "<p>x</p><div class=\"a\">1<div>2</div>3</div><div>4</div>";
foreach (Match m in divs.Matches(html))
    Console.WriteLine(m.Value);

// <div class="a">1<div>2</div>3</div>
// <div>4</div>
```

`RegexOptions.Singleline` matters here: without it, `.` does not match `\n` and the pattern silently fails on any `div` that spans lines.

This is fine for templated snippets, log output, or markup you generate yourself. It is not an HTML parser. Comments containing `<div>`, attributes containing `>`, CDATA, and unclosed void elements will all fool it. For real-world HTML, use AngleSharp or HtmlAgilityPack.

## Gotchas you will hit

### Forgetting the atomic group causes catastrophic backtracking

The `(?>...)` around the alternation is not decoration. If you write `(?:...)` and `[^()]*` instead of `[^()]+`, the engine can split a run of plain characters into an exponential number of ways when the match fails, and it will try all of them before giving up. I measured this on .NET 11 RC1 with a 2-second match timeout and a 29-character input:

```csharp
// .NET 11, C# 14
var input = "(" + new string('a', 25) + "(((";
var timeout = TimeSpan.FromSeconds(2);

var bad  = new Regex(@"^\((?:[^()]*|\((?<d>)|\)(?<-d>))*(?(d)(?!))\)$", RegexOptions.None, timeout);
var good = new Regex(@"^\((?>[^()]+|\((?<d>)|\)(?<-d>))*(?(d)(?!))\)$", RegexOptions.None, timeout);

// bad.IsMatch(input)  -> RegexMatchTimeoutException after 2000 ms
// good.IsMatch(input) -> False in 0 ms
```

Two fixes, use both: wrap the alternation in `(?>...)` so each iteration commits to what it consumed, and use `+` rather than `*` inside a loop so an iteration can never match empty. If the pattern runs on untrusted input, also pass a match timeout or set `REGEX_DEFAULT_MATCH_TIMEOUT` for the app domain.

### `RegexOptions.NonBacktracking` refuses balancing groups

The linear-time engine added in .NET 7 has no stacks, so it rejects these patterns in the constructor:

```text
System.NotSupportedException: RegexOptions.NonBacktracking is not supported in
conjunction with expressions containing: 'balancing group (?<name1-name2>subexpression)
or (?'name1-name2' subexpression)'.
```

It rejects atomic groups `(?>...)` and capture-group conditionals `(?(name)...)` with the same exception, so you cannot work around it by rewriting. If you need guaranteed linear time on hostile input, write the 15-line stack loop shown below instead. The OpenTelemetry team hit a related trap with this engine, covered in [the OpenTelemetry .NET 1.19.1 wildcard NotSupportedException write-up](/2026/09/opentelemetry-dotnet-1-19-1-fixes-wildcard-notsupportedexception-on-net-8/).

### `[GeneratedRegex]` works fine

The source generator supports balancing groups, atomic groups and conditionals, so you can move these patterns to compile time without changes:

```csharp
// .NET 11, C# 14
using System.Text.RegularExpressions;

Console.WriteLine(Patterns.Call().Match("call(foo(1, bar(2)), 3);").Value);
// call(foo(1, bar(2)), 3)

static partial class Patterns
{
    [GeneratedRegex(@"\w+\((?>[^()]+|\((?<d>)|\)(?<-d>))*(?(d)(?!))\)")]
    public static partial Regex Call();
}
```

If you have not migrated yet, [the guide to replacing new Regex(...) with [GeneratedRegex]](/2026/08/how-to-replace-new-regex-with-the-generatedregex-source-generator-in-dotnet-11/) covers the analyzer and code fix that do it for you.

### Separate stacks do not enforce bracket ordering

The obvious extension to `()`, `[]` and `{}` is one stack per bracket type:

```csharp
// .NET 11, C# 14
var multi = new Regex(@"^(?>
      [^()\[\]{}]+
    | (?<p>\() | (?<-p>\))
    | (?<b>\[) | (?<-b>\])
    | (?<c>\{) | (?<-c>\})
  )*(?(p)(?!))(?(b)(?!))(?(c)(?!))$", RegexOptions.IgnorePatternWhitespace);

Console.WriteLine(multi.IsMatch("{[()]}"));  // True
Console.WriteLine(multi.IsMatch("(]"));      // False
Console.WriteLine(multi.IsMatch("{[(])}"));  // True   <- wrong
```

Each stack counts its own type correctly, but nothing ties them together, so `{[(])}` passes: the `]` pops the `b` stack even though the most recent opener was `(`. Enforcing proper interleaving requires knowing which type is on top of a single shared stack, and that is where the regex stops being the right tool. A plain `Stack<char>` does it in one pass, and anyone can read it:

```csharp
// .NET 11, C# 14
static bool IsBalanced(ReadOnlySpan<char> s)
{
    var stack = new Stack<char>();
    foreach (char ch in s)
    {
        switch (ch)
        {
            case '(' or '[' or '{': stack.Push(ch); break;
            case ')': if (!stack.TryPop(out var a) || a != '(') return false; break;
            case ']': if (!stack.TryPop(out var b) || b != '[') return false; break;
            case '}': if (!stack.TryPop(out var c) || c != '{') return false; break;
        }
    }
    return stack.Count == 0;
}

// IsBalanced("{[()]}") -> True
// IsBalanced("{[(])}") -> False
```

If the hot path only needs to find the next bracket in a long string, [SearchValues<char> with IndexOfAny](/2026/04/how-to-use-searchvalues-correctly-in-dotnet-11/) is the fast way to skip the plain-text runs between them.

### Quotes and escapes inside the brackets

`f("(", x)` contains an unbalanced `(` inside a string literal. To skip quoted strings, add an alternative ahead of the others that consumes a whole string, for example `"(?:[^"\\]|\\.)*"`, and exclude `"` from the "anything else" class: `[^()"]+`. Each extra lexical rule (comments, char literals, verbatim strings) is another alternative, and past two or three of them a hand-written tokenizer is easier to maintain.

### Line-based anchors

If you validate multi-line input with `^...$` and `RegexOptions.Multiline`, remember that `$` only recognizes `\n` by default. [.NET 11's RegexOptions.AnyNewLine](/2026/04/regex-anynewline-dotnet-11-preview-3/) fixes the `\r\n` and Unicode line separator cases without `\r?` hacks.

## When to reach for balancing groups at all

Balancing groups are the right tool when you are already in a regex-shaped problem: a search-and-replace over source files, a log filter, a validation attribute, an editor's find dialog that accepts .NET patterns. They let one expression handle nesting that would otherwise force you into a parser. Once you need ordering across several bracket types, escape handling, or error positions ("unexpected `)` at column 14"), write the loop. The stack you were simulating inside the regex is a one-liner in C#.

## Sources

- [Grouping constructs: balancing group definitions](https://learn.microsoft.com/en-us/dotnet/standard/base-types/grouping-constructs-in-regular-expressions#balancing-group-definitions), MS Learn
- [Alternation constructs: conditional matching with a named group](https://learn.microsoft.com/en-us/dotnet/standard/base-types/alternation-constructs-in-regular-expressions), MS Learn
- [Regular expression options: NonBacktracking mode](https://learn.microsoft.com/en-us/dotnet/standard/base-types/regular-expression-options#nonbacktracking-mode), MS Learn
- [Backtracking in regular expressions](https://learn.microsoft.com/en-us/dotnet/standard/base-types/backtracking-in-regular-expressions), MS Learn
- [.NET regular expression source generators](https://learn.microsoft.com/en-us/dotnet/standard/base-types/regular-expression-source-generators), MS Learn
