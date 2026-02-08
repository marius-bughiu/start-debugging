---
title: "C# – How to mark features as experimental"
description: "Starting with C# 12, a new ExperimentalAttribute lets you mark types, methods, properties, or assemblies as experimental. Learn how to use it with diagnosticId, pragma tags, and UrlFormat."
pubDate: 2023-10-29
updatedDate: 2023-11-01
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
---
Starting with C# 12, a new `ExperimentalAttribute` is introduced allowing you to mark types, methods, properties or assemblies as being experimental features. This will trigger a compiler warning during usage which can be disabled using a `#pragma` tag.

The `Experimental` attribute requires a `diagnosticId` parameter to be passed in the constructor. That diagnostic ID will be part of the compiler error message that gets generated whenever the experimental feature is used. Note – you can use the same diagnostic-id in multiple attributes if you wish to.

**Important to note:** Do not use dashes (`-`) or other special characters in your `diagnosticId` as it might break the `#pragma` syntax and prevent users from disabling the warning. For example, using `BAR-001` as a diagnostic id will not allow the warning to be suppressed and will trigger a compiler warning in the pragma tag.

> CS1696 Single-line comment or end-of-line expected.

[![](/wp-content/uploads/2023/10/image-3.png)](/wp-content/uploads/2023/10/image-3.png)

You can also specify a `UrlFormat` within the attribute to guide developers to documentation related to the experimental feature. You can specify either an absolute url, such as `https://acme.com/warnings/BAR001`, or a generic string-formatter URL (`https://acme.com/warnings/{0}`) and let the framework do its magic.

Let’s look at some examples.

## Marking a method as experimental

```cs
using System.Diagnostics.CodeAnalysis;

[Experimental("BAR001")]
void Foo() { }
```

You simply annotate the method with the `Experimental` attribute and provide it with a `diagnosticId`. When a call to `Foo()` is made, the following compiler warning will be generated:

> BAR001 ‘Foo()’ is for evaluation purposes only and is subject to change or removal in future updates. Suppress this diagnostic to proceed.

You can work around this warning using pragma tags:

```cs
#pragma warning disable BAR001
Foo();
#pragma warning restore BAR001
```

## Specifying a link to documentation

As mentioned above, you can specify a link to the documentation using the `UrlFormat` property of the attribute. This is entirely optional.

```cs
[Experimental("BAR001", UrlFormat = "https://acme.com/warnings/{0}")]
void Foo() { }
```

Doing so, will make clicking the error codes in Visual Studio take you to the documentation page provided. And in addition to that it will also output the URL part of the diagnostic error message:

> BAR001 'Foo()' is for evaluation purposes only and is subject to change or removal in future updates. Suppress this diagnostic to proceed. (https://acme.com/warnings/BAR001)

## Other usages

The attribute can be used in almost any place that you can imagine. On assemblies, modules, classes, structs, enums, properties, fields, events, you name it. For a complete list of allowed usages we can check its definition:

```cs
[AttributeUsage(AttributeTargets.Assembly |
                AttributeTargets.Module |
                AttributeTargets.Class |
                AttributeTargets.Struct |
                AttributeTargets.Enum |
                AttributeTargets.Constructor |
                AttributeTargets.Method |
                AttributeTargets.Property |
                AttributeTargets.Field |
                AttributeTargets.Event |
                AttributeTargets.Interface |
                AttributeTargets.Delegate, Inherited = false)]
public sealed class ExperimentalAttribute : Attribute { ... }
```
