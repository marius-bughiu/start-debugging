---
title: "Dart 3.12 Ships Primary Constructors Behind an Experiment Flag"
description: "Dart 3.12 adds an experimental primary constructors syntax that declares fields and a constructor in the class header, collapsing the classic three-line data class to one."
pubDate: 2026-06-04
tags:
  - "dart"
  - "flutter"
---

Dart 3.12 (released 2026-05-20) shipped one of the language's most-requested features as an experimental preview: primary constructors. If you have ever written the same field, plus `this.field` constructor parameter, plus assignment three times for a simple data class, this is the syntax that kills that pattern. It is gated behind `--enable-experiment=primary-constructors` for now, but it is worth wiring into a branch today because it changes how a lot of everyday Dart code reads.

This follows the other Dart 3.12 boilerplate cut, [private named parameters as initializing formals](/2026/05/dart-3-12-private-named-parameters-initializing-formals/). Primary constructors go further: they move the whole declaration into the class header.

## One line instead of four

Here is the data class everyone writes, the part the compiler should have been generating all along:

```dart
class Point {
  final int x;
  final int y;
  Point(this.x, this.y);
}
```

With a primary constructor, the field declarations and the constructor collapse into the header. An empty class body becomes a semicolon:

```dart
class Point(final int x, final int y);
```

The rule is simple: a parameter marked `final` or `var` in the header becomes an instance field. Drop the modifier and it stays a plain constructor parameter, not a field. So `class User(String name);` takes `name` as an argument without storing it, while `class User(final String name);` stores it.

## Fields can depend on header parameters

Header parameters are in scope inside the class body, so you can initialize other non-late fields from them without an initializer list:

```dart
class DeltaPoint(final int x, int delta) {
  final int y = x + delta;
}
```

Here `delta` is a constructor parameter (no `final`, so not a field) and `y` is computed from it.

## Adding validation with a body

When you need an assert or some setup, you write a constructor body introduced by `this`. An initializer-list-only form ends in a semicolon:

```dart
class Point(var int x, var int y) {
  this : assert(x >= 0 && y >= 0) {
    print('Point initialized at ($x, $y)');
  }
}
```

Named constructors get a tighter form too, using `new` in the body:

```dart
class Pet {
  String name;

  new() : name = 'Fluffy';
  new withName(this.name);
}
```

## Turning it on

The feature is experimental, so you opt in per run:

```bash
dart run --enable-experiment=primary-constructors bin/main.dart
```

Because it is experimental, treat it as a preview: the syntax can still shift before it stabilizes, and `final` and `var` now carry special meaning in a parameter list, so do not roll it into shared production code yet. But for a side branch, primary constructors make Flutter widget models, value objects, and config holders dramatically shorter. The full spec, including super parameters and the named-constructor rules, lives in the [Dart primary constructors docs](https://dart.dev/language/primary-constructors).
