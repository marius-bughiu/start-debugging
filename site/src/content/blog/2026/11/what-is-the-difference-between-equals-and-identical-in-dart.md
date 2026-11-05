---
title: "What is the difference between == and identical in Dart, and what does == fall back to?"
description: "In Dart, identical(a, b) asks whether two references point to the same object, while a == b calls the left operand's operator == method, which falls back to Object.== (identity) unless the class overrides it. Null checks, const canonicalization, numbers, NaN, records, hashCode, and the places where the VM and dart2js disagree, verified on Dart 3.12.2."
pubDate: 2026-11-05
tags:
  - "dart"
  - "flutter"
  - "equality"
  - "dart-3"
---

In Dart, `identical(a, b)` is a fixed, top-level function that answers one question: do these two references point to the same object? `a == b` is an operator call: after a null check that the language does for you, it calls `a.operator ==(b)`, which is an ordinary instance method that any class can override. If the class does not override it, `==` falls back to `Object.==`, which is defined as identity, so for a plain class `a == b` and `identical(a, b)` give the same answer. Everything below was run on Dart 3.12.2 (stable, macOS arm64) on the Dart VM and compiled with `dart compile js -O2` under Node 26.4.0, because a few results differ between the two.

## What `==` actually evaluates

The [operators page of the Dart language tour](https://dart.dev/language/operators) spells out the algorithm for `x == y`:

1. If `x` or `y` is `null`, return `true` if both are `null` and `false` if only one is.
2. Otherwise, return the result of invoking `x.==(y)`.

Two consequences fall out of that. First, your override of `operator ==` is never called with `null`, which is why its parameter is `Object` and not `Object?` (Effective Dart has a rule for this: "DON'T make the parameter to == nullable"). Second, `==` is dispatched on the left operand only. `a == b` runs `a`'s implementation; `b`'s override is irrelevant.

You can watch both rules happen with a class that logs every call:

```dart
// Dart 3.12.2
class Spy {
  @override
  bool operator ==(Object other) {
    print('  Spy.== called with $other');
    return true;
  }

  @override
  int get hashCode => 0;
}

void main() {
  final Spy? s = Spy();
  Spy? nothing;
  print('s == null: ${s == null}');
  print('nothing == s: ${nothing == s}');
  print('s == 1: ${s == 1}');
}
```

Output on the VM:

```text
s == null: false
nothing == s: false
  Spy.== called with 1
s == 1: true
```

The first two lines never reach `Spy.==`, even though this `Spy` claims to equal everything. The null check happens before dispatch. The third line shows that nothing stops a badly written `==` from returning `true` for an `int`; the `unrelated_type_equality_checks` lint from `package:lints` flags that comparison at analysis time ("The type of the right operand ('int') isn't a subtype or a supertype of the left operand ('Spy?')").

`identical`, on the other hand, is not overridable and never calls your code. That makes it the right tool when you need to know whether you are holding the same instance, for example a cache that must not return a structurally equal but different object, or a guard that skips work when a value has not been replaced.

## The fallback: `Object.==` is identity

The [API docs for `Object.operator ==`](https://api.dart.dev/stable/dart-core/Object/operator_equals.html) say the default implementation returns true "if and only if this object and other are the same object". So a class without an override compares by reference:

```dart
// Dart 3.12.2
class Plain {
  final int x;
  Plain(this.x);
}

void main() {
  final a = Plain(1), b = Plain(1);
  print(a == b);            // false
  print(identical(a, b));   // false
  print(a == a);            // true
}
```

The same is true for the core collections. `List`, `Map`, and `Set` do not override `==` to compare contents, so `[1] == [1]` is `false`. If you want element-wise comparison, use `ListEquality` / `DeepCollectionEquality` from `package:collection`, or Flutter's `listEquals` in `foundation.dart`.

## Where `identical` returns true for "different" objects: const canonicalization

`const` expressions are canonicalized. Two const expressions that evaluate to the same constant state produce one instance, so they are identical, not merely equal. The [`identical` docs](https://api.dart.dev/stable/dart-core/identical.html) use `identical(const [1], const [1])` as their example.

```dart
// Dart 3.12.2
class ConstPoint {
  final int x;
  const ConstPoint(this.x);
}

void main() {
  const c1 = ConstPoint(1), c2 = ConstPoint(1);
  print('${c1 == c2} ${identical(c1, c2)}');   // true true

  final n1 = ConstPoint(1), n2 = ConstPoint(1);
  print('${n1 == n2} ${identical(n1, n2)}');   // false false

  print(identical(const [1], const [1]));      // true
}
```

`ConstPoint` does not override `==`, yet `c1 == c2` is `true`, because the fallback is identity and canonicalization made them the same object. Call the very same constructor without `const` and you get two fresh instances. A const constructor does not guarantee a constant; only a const context does.

This is the mechanism behind the Flutter advice to mark widgets `const`. `Widget` declares `operator ==` as `@nonVirtual` and implements it as `super == other`, so widget equality is always identity (checked against the Flutter 3.44.8 source in `packages/flutter/lib/src/widgets/framework.dart`). `Element.updateChild` short-circuits when `child.widget == newWidget`. A `const` widget instance is the same object on every build, so that check passes and the subtree is not rebuilt. A non-const widget with identical arguments is a new object every time, and no override can change that.

## Overriding `==` correctly, and why `hashCode` is not optional

When you want value semantics, override `==` and `hashCode` together:

```dart
// Dart 3.12.2
class Money {
  final int cents;
  final String currency;
  const Money(this.cents, this.currency);

  @override
  bool operator ==(Object other) =>
      other is Money && other.cents == cents && other.currency == currency;

  @override
  int get hashCode => Object.hash(cents, currency);
}

void main() {
  final m1 = Money(500, 'EUR'), m2 = Money(500, 'EUR');
  print('${m1 == m2} ${identical(m1, m2)}');   // true false
  print({m1, m2}.length);                      // 1
}
```

The `Object.==` docs list the contract an override must keep: total (never throws, always returns a `bool`), reflexive, symmetric, transitive, and consistent over time unless the object is modified. They also say an override "should override the hashCode method as well." The reason is hashed collections. Here is what happens when you skip it:

```dart
// Dart 3.12.2
class NoHash {
  final int v;
  NoHash(this.v);

  @override
  bool operator ==(Object other) => other is NoHash && other.v == v;
}

void main() {
  final h1 = NoHash(1), h2 = NoHash(1);
  print(h1 == h2);              // true
  print({h1, h2}.length);       // 2
  print([h1].contains(h2));     // true
  print({h1}.contains(h2));     // false
}
```

`List.contains` walks the elements with `==`, so it finds the match. `Set.contains` (the default `LinkedHashSet`) first buckets by `hashCode`, which still comes from `Object.hashCode` and differs per instance, so it never reaches `==`. The same object is "in" the list and "not in" the set. The `hash_and_equals` lint in `package:lints/core.yaml` (lints 6.1.0) catches this: "Missing a corresponding override of 'hashCode'."

Two more rules from [Effective Dart's equality section](https://dart.dev/effective-dart/design#equality) are worth taking seriously:

- **Avoid custom equality on mutable classes.** If a field used by `hashCode` changes while the object is in a `Set` or is a `Map` key, the object sits in the wrong bucket and lookups fail.
- **Use `is` checks, not `runtimeType ==`, unless you need exact-type equality.** `other is Money` lets subclasses compare equal to their parent, which can break symmetry if the subclass adds fields. If you have a hierarchy, either make the class `final` or compare `runtimeType` deliberately.

If writing this by hand feels tedious, Dart records and generated classes do it for you; see [the comparison of Dart records and Freezed classes](/2026/05/dart-records-vs-freezed-classes/) for how each one generates `==` and `hashCode`.

## Numbers: `==` and `identical` are not the same relation

Numbers are where people get surprised, because `num.==` is not identity and `identical` on numbers is not object identity in the usual sense. The [`num.operator ==` docs](https://api.dart.dev/stable/dart-core/num/operator_equals.html) say an `int` and a `double` are equal when the double has an integer value with the same numerical value, that `0.0` and `-0.0` are equal, and that NaN "is not equal to anything, including NaN". The `identical` docs add that integers and doubles "do not allow creating new instances at all", so equal integers are always identical, and doubles with the same bit pattern are identical, "with caveats around double.nan and -0.0 on web platforms."

Running the same code on both compilers makes the caveats concrete:

```dart
// Dart 3.12.2
void main() {
  const nan = double.nan;
  print('1 == 1.0: ${1 == 1.0}, identical: ${identical(1, 1.0)}');
  print('0.0 == -0.0: ${0.0 == -0.0}, identical: ${identical(0.0, -0.0)}');
  print('nan == nan: ${nan == nan}, identical: ${identical(nan, nan)}');
  print('[nan].contains(nan): ${[nan].contains(nan)}');
  print('{nan}.contains(nan): ${{nan}.contains(nan)}');
  print('nan.compareTo(nan): ${nan.compareTo(nan)}');
  final big1 = 1 << 40, big2 = 1 << 40;
  print('identical(big ints): ${identical(big1, big2)}');
}
```

| Expression | Dart VM | dart2js (`-O2`, Node 26.4.0) |
| --- | --- | --- |
| `1 == 1.0` | `true` | `true` |
| `identical(1, 1.0)` | `false` | `true` |
| `0.0 == -0.0` | `true` | `true` |
| `identical(0.0, -0.0)` | `false` | `true` |
| `nan == nan` | `false` | `false` |
| `identical(nan, nan)` | `true` | `false` |
| `[nan].contains(nan)` | `false` | `false` |
| `{nan}.contains(nan)` | `false` | `false` |
| `nan.compareTo(nan)` | `0` | `0` |
| `identical(1 << 40, 1 << 40)` | `true` | `true` |

On the VM, `identical` on doubles compares the bit pattern: `1` (an `int`) and `1.0` are different, `0.0` and `-0.0` have different sign bits, and NaN is identical to itself. On the web every Dart number is a JavaScript number and `identical` compiles to `===`, so `1` and `1.0` are the same value, `0.0 === -0.0` is `true`, and `NaN === NaN` is `false`. If you write code that depends on `identical` for doubles, it will behave differently in a Flutter web build than on Android or iOS.

The one constant across both: NaN breaks `==`. `[nan].contains(nan)` and `{nan}.contains(nan)` are `false` on both platforms, which is exactly what the `num` docs warn about ("Using NaN in, e.g., a HashSet will fail to work."). If you need an ordering that treats NaN as equal to itself and separates `-0.0` from `0.0`, use `compareTo`, which returned `0` for NaN against NaN on both targets.

## Strings and records: equal by value, identity is unspecified

`String` overrides `==` to compare code units, so a string built at runtime equals a literal. Whether they are also identical is an implementation detail:

```dart
// Dart 3.12.2
void main() {
  final sa = 'ab', sb = ['a', 'b'].join();
  print('${sa == sb} ${identical(sa, sb)}');
  print(identical('ab', 'ab'));
}
```

The VM printed `true false` and `true`: equal literals are canonicalized constants, but the joined string is a separate object. Under dart2js both lines printed `true`, because JavaScript strings are primitives and `===` compares their contents.

Records follow the same pattern. The [records docs](https://dart.dev/language/records) say two records are equal when they have the same shape and their corresponding fields are equal, and that records "automatically define hashCode and == methods" from their fields. The `identical` docs deliberately leave record identity open: a record may or may not be identical to another with the same shape and values.

```dart
// Dart 3.12.2
void main() {
  final r1 = (1, 'a'), r2 = (1, 'a');
  print('${r1 == r2} ${identical(r1, r2)}');   // VM: true false, dart2js: true true
  final l1 = ([1],), l2 = ([1],);
  print(l1 == l2);                              // false on both
}
```

The last line is the trap. Record equality delegates to each field's `==`, and `List` has identity equality, so two records that each wrap a new `[1]` are not equal. Value semantics are only as deep as the fields' own `==`.

## Which one to reach for

- Use `==` for "do these represent the same value?" This is almost always what application code means, and it respects whatever the type defines.
- Use `identical` for "is this the same instance?" Typical cases: skipping a rebuild or a recomputation when a reference has not changed, detecting reentrancy on a specific object, or writing your own `==` with a fast path (`if (identical(this, other)) return true;`).
- Do not use `identical` on numbers, strings, or records for anything that must behave the same on native and web. The results above show that the VM and dart2js disagree on several of them.
- If you override `==`, override `hashCode`, keep the fields immutable, and enable `package:lints` so `hash_and_equals` and `unrelated_type_equality_checks` catch the mistakes.

State management libraries make this choice for you, and it matters when they do. Riverpod 3.0 switched every provider to filtering updates with `==`, which is why [a `StreamProvider` that re-emits the same mutable object stops rebuilding](/2026/07/fix-riverpod-3-0-streamprovider-stops-emitting-filtered-by-equality/). Flutter's `Theme` decides whether to notify dependents with `theme.data != old.theme.data`, and `ThemeData.==` compares its extensions with `mapEquals`, so [custom `ThemeExtension` tokens](/2026/10/how-to-define-custom-design-tokens-with-themeextension-in-flutter/) that fall back to identity make every freshly built theme look different. And `FutureBuilder.didUpdateWidget` checks `oldWidget.future == widget.future`; `Future` has identity equality, which is why [a future created inside `build` restarts on every rebuild](/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/) and has to be stored once instead.

## Sources

- [Operators: equality and relational operators](https://dart.dev/language/operators), Dart language tour
- [`Object.operator ==`](https://api.dart.dev/stable/dart-core/Object/operator_equals.html), dart:core API reference
- [`identical`](https://api.dart.dev/stable/dart-core/identical.html), dart:core API reference
- [`num.operator ==`](https://api.dart.dev/stable/dart-core/num/operator_equals.html), dart:core API reference
- [Records: record equality](https://dart.dev/language/records), Dart language tour
- [Effective Dart: Design, equality](https://dart.dev/effective-dart/design#equality)
- [`hash_and_equals`](https://dart.dev/tools/linter-rules/hash_and_equals) and [`unrelated_type_equality_checks`](https://dart.dev/tools/linter-rules/unrelated_type_equality_checks) lint rules
