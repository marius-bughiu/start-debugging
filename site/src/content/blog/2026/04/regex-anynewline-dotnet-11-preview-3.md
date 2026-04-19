---
title: "RegexOptions.AnyNewLine lands in .NET 11 Preview 3: Unicode-aware anchors without the \\r? hacks"
description: ".NET 11 Preview 3 adds RegexOptions.AnyNewLine so ^, $, \\Z, and . recognize every Unicode newline sequence, including \\r\\n, NEL, LS, and PS, with \\r\\n treated as one atomic break."
pubDate: 2026-04-19
tags:
  - "dotnet"
  - "dotnet-11"
  - "regex"
  - "csharp"
---

If you have ever written a multiline regex in .NET and reached for `\r?$` to be safe across Windows and Unix files, the workaround is finally going away. .NET 11 Preview 3 introduces `RegexOptions.AnyNewLine`, which teaches the engine about the full set of Unicode line terminators without forcing you to spell each one out by hand.

The option was requested back in dotnet/runtime issue [25598](https://github.com/dotnet/runtime/issues/25598) and shipped with the Preview 3 drop on April 14, 2026. Details are in the [.NET 11 Preview 3 announcement](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/).

## What the option actually changes

With `RegexOptions.AnyNewLine` set, the anchors `^`, `$`, and `\Z`, plus `.` when `Singleline` is not active, recognize every common newline sequence defined by Unicode TR18 RL1.6:

- `\r\n` (CR+LF)
- `\r` (CR)
- `\n` (LF)
- `\u0085` (NEL, Next Line)
- `\u2028` (Line Separator)
- `\u2029` (Paragraph Separator)

Critically, `\r\n` is treated as an atomic sequence. That means `^` will not fire between the `\r` and the `\n`, and `.` does not consume just the `\r` and leave the `\n` dangling. That single behavior deletes a class of cross-platform bugs that regex-heavy parsers have been carrying for years.

## Before vs after

Imagine you want every non-empty line from a mixed file that was edited on Windows, then Linux, then shipped through an old Mac tool. In .NET 10 you compensate for each newline flavor:

```csharp
// .NET 10 style: opt in to every flavor manually
var legacy = new Regex(
    @"^(?<line>.+?)(?:\r?\n|\u2028|\u2029|\u0085|\z)",
    RegexOptions.Multiline);
```

In .NET 11 Preview 3 the same intent compresses to:

```csharp
using System.Text.RegularExpressions;

var modern = new Regex(
    @"^(?<line>.+)$",
    RegexOptions.Multiline | RegexOptions.AnyNewLine);

string input = "first\r\nsecond\nthird\u2028fourth\u2029fifth\u0085sixth";

foreach (Match m in modern.Matches(input))
{
    Console.WriteLine(m.Groups["line"].Value);
}
```

Every line prints cleanly, no manual compensation, and `\r` never leaks into the captured group on Windows input.

## What it refuses to combine with

Two combinations are rejected at construction time. Both throw `ArgumentOutOfRangeException`:

```csharp
// Both throw at construction
new Regex(@"^line$",
    RegexOptions.AnyNewLine | RegexOptions.NonBacktracking);

new Regex(@"^line$",
    RegexOptions.AnyNewLine | RegexOptions.ECMAScript);
```

The `NonBacktracking` engine bakes its own newline model into the DFA, and the `ECMAScript` flavor is intentionally locked to ECMA-262 semantics. Letting either silently inherit the Unicode set would change matching behavior in ways callers cannot easily detect, so the runtime fails loudly at construction instead of producing surprising matches at runtime.

`RegexOptions.Singleline` is the friendly combination. With both `Singleline` and `AnyNewLine` set, `.` matches every character including newlines, and `^`, `$`, and `\Z` keep the full Unicode anchor behavior.

## Why this matters for log and content parsers

Most of the home-grown `\r?\n` shims in .NET codebases exist because the default regex behavior treats only `\n` as a line break. Logs, CSVs, RFC 822 headers, and content pasted from terminals all hit this the moment a `\r\n` or a stray `\u2028` shows up. Every defensive split, every "is this a Windows file" check, every off-by-one when a Unicode separator slips into the buffer, has been paying that tax.

`RegexOptions.AnyNewLine` is a small API, but it removes a long-standing source of cross-platform regex bugs. If you maintain a parser, log shipper, or text indexer in .NET, Preview 3 is the release where you can finally start trimming those workarounds.
