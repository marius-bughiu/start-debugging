---
title: "AutoMapper 16.3 and 15.1.4: MaxDepth Did Not Protect Records, Derived Maps, or Dictionary Sources"
description: "AutoMapper 16.3.0 and 15.1.4 fix two high-severity advisories where deeply nested input bypassed MaxDepth and crashed the process with an uncatchable StackOverflowException. Here is which mapping paths were exposed and what changes when you upgrade."
pubDate: 2026-11-06
tags:
  - "automapper"
  - "dotnet"
  - "security"
  - "csharp"
---

AutoMapper shipped [16.3.0](https://github.com/LuckyPennySoftware/AutoMapper/releases/tag/v16.3.0) and [15.1.4](https://github.com/LuckyPennySoftware/AutoMapper/releases/tag/v15.1.4) on November 5, 2026, together with two high-severity advisories. Both describe the same failure: deeply nested input slips past `MaxDepth`, recursion runs until the stack is gone, and the resulting `StackOverflowException` takes the whole process down. You cannot catch it, so a single request with a crafted payload is enough to kill an ASP.NET Core worker.

If you set `MaxDepth` (or relied on the default limit of 64 for self-referential maps) as the mitigation for the earlier CVE-2026-32933, these releases are the ones that make that mitigation actually hold.

## Constructor mapping counted depth too late

[GHSA-6vhm-j9h7-f9gh](https://github.com/LuckyPennySoftware/AutoMapper/security/advisories/GHSA-6vhm-j9h7-f9gh) covers destinations built through their constructor, which includes every positional `record`. The type depth that `MaxDepth` checks was incremented only after the destination object existed. Constructor arguments, including children of the same type, are mapped while that object is being created, so each level recursed before its parent was counted and the check never fired.

```csharp
public record Node(Node? Next);

var mapper = new MapperConfiguration(cfg =>
    cfg.CreateMap<Node, Node>().MaxDepth(10))
    .CreateMapper();

// Before 16.3.0 / 15.1.4 this mapped every level, ignoring MaxDepth(10).
// A few thousand levels overflow a 1 MB stack and end the process.
var copy = mapper.Map<Node>(deeplyNestedNode);
```

The advisory reports that with `MaxDepth(10)` a 100-level chain was mapped all the way down, and that a 1 MB stack (the Windows default) crashed somewhere between 1,000 and 2,000 levels. `ConstructUsing` lambdas that recurse through `context.Mapper` had the same hole.

## Four more paths that ignored the limit

[GHSA-gpwp-5797-mjff](https://github.com/LuckyPennySoftware/AutoMapper/security/advisories/GHSA-gpwp-5797-mjff) lists the rest:

- **Derived maps**: `Include` / `IncludeBase` maps did not inherit the base map's `MaxDepth`, and the default limit of 64 was applied only to the base.
- **`object` and interface members**: self-reference detection does not see through them, so no default limit was applied.
- **`Dictionary<string, object>` and `ExpandoObject` sources**: no depth tracking at all. This is the one to worry about if you map deserialized JSON straight onto typed models.
- **Recursive `ConvertUsing`** converters that call `context.Mapper.Map`.

## What changes when you upgrade

Derived maps now inherit `MaxDepth` and receive the default limit. Constructor mapping stops at the same depth as property mapping. For recursion `MaxDepth` cannot limit, every runtime map call now checks for sufficient stack and throws `InsufficientExecutionStackException`, which is catchable, instead of overflowing.

Two behavior changes can surface in tests. Polymorphic graphs that legitimately go deeper than 64 levels now stop at 64, so set `MaxDepth` explicitly on those maps. And in 16.3.0 only, a `Condition` whose member parameter is `object` or a base type (including `ForAllMembers` conditions) now receives the raw source value rather than the value converted to the destination type, so a `null` nullable source is seen as `null` instead of `0` or `false` ([#4655](https://github.com/LuckyPennySoftware/AutoMapper/pull/4655)).

## If you cannot upgrade today

For classes with a parameterless constructor and settable properties, `cfg.DisableConstructorMapping()` routes mapping through properties, where `MaxDepth` is enforced. Set `MaxDepth` explicitly on derived maps and on maps reached through `object` or interface members. Positional records, dictionary and dynamic sources, and recursive converters have no configuration workaround: cap input depth before it reaches the mapper, for example with `JsonSerializerOptions.MaxDepth` on the deserializer.

Affected ranges are `>= 16.0.0, < 16.3.0` and everything below `15.1.4`. CVE IDs have been requested and will be added to the release notes once assigned.

```bash
dotnet add package AutoMapper --version 16.3.0
```
