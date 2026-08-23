---
title: "C# 14 features"
description: "All C# 14 language features with runnable examples: union types, partial members, extensions, and the smaller ergonomic wins."
tagline: "What actually shipped in C# 14, with code."
pubDate: 2026-04-18
updatedDate: 2026-08-23
indexTags:
  - "c# 14"
  - "csharp 14"
  - "csharp-14"
  - "c#"
  - "csharp"
  - "c# language"
---

This pillar indexes everything I've written about **C# 14** language features: extension members, partial constructors and events, the `field` keyword, user-defined compound assignment, and the smaller ergonomic wins that are easy to miss in the official release notes.

## What to read first

For the headline 14.0 features, [C# 14 Extension Members](/2026/02/csharp-14-extension-members/) and [Partial constructors and events in C# 14](/2025/04/csharp-14-partial-constructors-and-events/) are the biggest behavioural changes from C# 12. The newest addition is [How to declare extension properties in C# 14](/2026/06/how-to-declare-extension-properties-in-csharp-14/), carrying that story over to computed properties. Moving existing extension methods into an extension block? [CS0121, the call is ambiguous](/2026/08/fix-the-call-is-ambiguous-after-moving-to-csharp-14-extension-members/) is the error you'll hit. After that, [C# 14 user-defined compound assignment operators](/2026/04/csharp-14-user-defined-compound-assignment-operators/) and [the field keyword](/2025/04/c-14-the-field-keyword-and-field-backed-properties/) cover the perf-sensitive bits. The breaking change to know before upgrading is [C# 14 overload resolution with Span and ReadOnlySpan](/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/), which can silently bind a different overload.

The index below is broader than the 14.0 feature set - the `c#` and `csharp` tags pull in general C# posts too. If that's what brought you here, [.Result vs .Wait() vs GetAwaiter().GetResult() vs await](/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/) is the async decision most people need, with [the deadlock it prevents](/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/) as the follow-up. When you await more than one task, [the AggregateException Task.WhenAll throws](/2026/08/fix-aggregateexception-one-or-more-errors-occurred-when-awaiting-task-whenall/) explains why only the first error surfaces, and [CS1998](/2026/08/fix-cs1998-this-async-method-lacks-await-operators-and-will-run-synchronously/) is the warning that catches an `async` method with nothing to await.

## What's on this page

The list below auto-collects posts tagged with any of: `c# 14`, `csharp 14`, `csharp-14`, `c#`, `csharp`, `c# language`. Newest first.
