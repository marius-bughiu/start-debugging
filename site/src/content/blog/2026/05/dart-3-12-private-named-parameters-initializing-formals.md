---
title: "Dart 3.12 Drops the Initializer List for Private Fields"
description: "Dart 3.12 lets constructors initialize private fields directly with named parameters, killing one of the language's most persistent boilerplate patterns."
pubDate: 2026-05-25
tags:
  - "dart"
  - "flutter"
---

Dart 3.12 shipped at Google I/O 2026 alongside Flutter 3.44, and buried in the release is a small language change that removes a chunk of boilerplate every Dart developer has written a hundred times. You can now use private named parameters as initializing formals. In plain terms: a constructor can take a named argument and assign it straight to a private field, no initializer list required.

## The underscore problem Dart carried for years

Dart marks a field private by prefixing it with an underscore. That convention collided with named constructor parameters, because the language refused to let a named parameter start with `_`. The result was a familiar dance: accept a public-named parameter, then manually copy it into the private field in the initializer list.

```dart
class Hummingbird {
  final String _petName;
  final int _wingbeatsPerSecond;

  Hummingbird({required String petName, required int wingbeatsPerSecond})
    : _petName = petName,
      _wingbeatsPerSecond = wingbeatsPerSecond;
}
```

Every private field meant a parameter declaration plus an initializer entry. For a class with eight private fields, that is sixteen lines of pure plumbing. Initializing formals (`this.field`) solved this for public fields years ago, but private fields were stuck on the slow path.

## What 3.12 actually changes

Dart 3.12 makes the obvious thing work. Write `this._field` as a named parameter and the compiler handles the rest:

```dart
class Hummingbird {
  final String _petName;
  final int _wingbeatsPerSecond;

  Hummingbird({required this._petName, required this._wingbeatsPerSecond});
}
```

The field stays private, but the parameter name exposed to callers is the public version with the underscore stripped off. So the call site reads exactly as before:

```dart
void main() {
  print(Hummingbird(petName: 'Dash', wingbeatsPerSecond: 75));
}
```

This is purely a constructor-side change. The public API is identical, callers do not touch anything, and the private fields stay private. You are deleting the initializer list, nothing more.

## The constraints worth knowing

This exception applies only to initializing formals. A regular named parameter still cannot start with an underscore, because that would leak a private name into the public signature with no public counterpart to fall back on. The underscore name also has to map to a legal public identifier: `this._` and `this._2x` are rejected, because stripping the underscore leaves `` and `2x`, neither of which is a valid parameter name.

The feature also pairs with primary constructors, which landed as an experiment in the same cycle and require a language version of at least 3.13. With both in play you can declare a private field directly in the constructor header and let the compiler publish the public-facing name automatically.

If you are already on Flutter 3.44, you have Dart 3.12 and can use this today. Bump your `pubspec.yaml` SDK constraint to `^3.12.0`, run `dart fix`, and start deleting initializer lists. See the [Dart 3.12 announcement](https://dart.dev/blog/announcing-dart-3-12) for the full release notes.
