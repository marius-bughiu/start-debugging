---
title: "Flutter – NoSuchMethod: the method was called on null"
description: "This error occurs when attempting to call a method on a null object reference. No such method exists because the call target is null or unassigned. For instance: will fail with a NoSuchMethod error whenever foo is null. The error will say: NoSuchMethod: the method ‘bar’ was called on null. This is the equivalent of…"
pubDate: 2023-10-09
updatedDate: 2023-11-05
tags:
  - "flutter"
---
This error occurs when attempting to call a method on a `null` object reference. No such method exists because the call target is `null` or unassigned. For instance:

```dart
foo.bar()
```

will fail with a `NoSuchMethod` error whenever `foo` is `null`. The error will say: `` NoSuchMethod: the method `'bar'` `` `was called on null`.

This is the equivalent of a `NullReferenceException` in C#.

## How do I fix it?

Use the call stack to determine the line on which the error occured. Since the name of the method is in the error message, this is usually enough. If not, set a breakpoint on that line and when you reach it, inspect the variable values looking for a `null`. When you find it, try to understand what led to this state and address it.
