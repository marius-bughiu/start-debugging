---
title: "Dot Shorthands in Dart 3.12: Drop the Type Name in Flutter Code"
description: "Dot shorthands went stable in Dart 3.12.2. Write .center or .new and let the compiler infer the type from context. Here is how they work across enums, static members, and constructors."
pubDate: 2026-07-05
tags:
  - "dart"
  - "flutter"
---

If your Flutter widget tree is a wall of `MainAxisAlignment.center`, `CrossAxisAlignment.start`, and `EdgeInsets.all`, Dart just gave you a way to delete a lot of that repetition. Dot shorthands, the feature that lets you write `.center` and have the compiler figure out the type, went stable in Dart 3.12.2. Flutter 3.44 already ships Dart 3.12, so if you are on the current stable channel you can use this today.

## What the leading dot actually does

A dot shorthand is an expression that starts with a bare `.`. When the surrounding context makes the target type unambiguous, Dart resolves the member against that type instead of making you spell it out. The classic case is an enum in an assignment:

```dart
Status currentStatus = .running; // Instead of Status.running
```

The variable is declared as `Status`, so `.running` can only mean `Status.running`. The same inference kicks in inside a `switch`, where the value being matched already pins down the type:

```dart
return switch (level) {
  .debug => 'gray',
  .info => 'blue',
  .warning => 'orange',
  .error => 'red',
};
```

## It is not just enums

The mechanism is general: any static member reachable through the context type is fair game. That includes static methods, static getters, named constructors, and factory constructors.

```dart
int port = .parse('8080');      // int.parse('8080')
BigInt zero = .zero;            // BigInt.zero
Point origin = .origin();       // Point.origin() named constructor
Point p = .fromList([1.0, 2.0]); // Point.fromList(...) factory
```

The unnamed constructor gets a name for this purpose: `.new`. That single detail is what makes the feature pay off in real Flutter code, where you constantly assign freshly constructed objects to typed fields:

```dart
final ScrollController _scrollController = .new();
final GlobalKey<ScaffoldMessengerState> scaffoldKey = .new();
```

## The one rule that trips people up

Equality has a special case. When you use a shorthand on the right-hand side of `==` or `!=`, Dart takes the static type of the left operand as the context:

```dart
if (myColor == .green) {
  print('The color is green.');
}
```

Here `myColor` is typed `Color`, so `.green` resolves to `Color.green`. The shorthand has to sit on the right side. Flip it to `.green == myColor` and there is no left operand type to infer from, so it will not compile.

## Turning it on

Dot shorthands require a language version of at least 3.10, and the feature reached stable in Dart 3.12.2. If you are already on Flutter 3.44 you have it. Bump the SDK constraint in `pubspec.yaml` to `^3.12.0`, and the analyzer stops flagging the leading dot. There is no runtime cost and no change to the generated code: this is pure syntax that resolves at compile time to the fully qualified member you would have typed anyway.

The win is not shorter code for its own sake. It is that the type only appears once, in the declaration, instead of being echoed on every value. See the [dot shorthands language page](https://dart.dev/language/dot-shorthands) for the full resolution rules.
