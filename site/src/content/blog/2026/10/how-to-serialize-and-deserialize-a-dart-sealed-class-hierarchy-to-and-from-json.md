---
title: "How to serialize and deserialize a Dart sealed class hierarchy to and from JSON"
description: "Put a discriminator field in the JSON, switch on it in a factory on the sealed base, and switch on the subtype to write it back. Three working versions on Dart 3.13.7: hand-written pattern matching, json_serializable 6.15.2, and Freezed 4.0.3 with unionKey and fallbackUnion, plus the gotchas each one hides."
pubDate: 2026-10-25
template: how-to
tags:
  - "dart"
  - "flutter"
  - "json"
  - "freezed"
  - "json-serializable"
  - "sealed-classes"
---

**Short answer:** JSON has no idea which Dart subclass an object came from, so you have to write that information into the payload yourself, usually as a discriminator field such as `"type": "circle"`. Deserialize with a `factory Shape.fromJson` on the sealed base that switches on that field and delegates to the right subclass, and serialize with a `toJson` that switches on `this` (exhaustively, thanks to `sealed`) and adds the discriminator back. You can write that by hand with Dart 3 map patterns, let json_serializable generate the per-subclass bodies while you write the dispatch, or let Freezed generate everything with `@Freezed(unionKey: 'type')`. Everything below was compiled and run on Dart 3.13.7 (the SDK in Flutter 3.47.8) with json_serializable 6.15.2, json_annotation 4.12.0, Freezed 4.0.3, freezed_annotation 3.1.0 and build_runner 2.17.1.

## Why a sealed hierarchy does not round-trip on its own

A `sealed class Shape` with `Circle` and `Rect` subclasses gives you exhaustive `switch` checking inside Dart, but `jsonDecode` only ever hands you `Map<String, dynamic>`, `List<dynamic>`, `String`, `num`, `bool` and `null`. Nothing in `{"radius": 2}` says "this was a `Circle`". So the work splits into two directions that need different tools:

- **Dart to JSON** is easy because you have a real object. A `switch (this)` over a sealed type is checked by the compiler, so if you add a `Triangle` later, every `toJson` that forgot it becomes a compile error.
- **JSON to Dart** is the hard direction. You are switching on a *string* from the wire, and no compiler can check that every possible string maps to a subclass. You need a policy for unknown or missing discriminators.

The discriminator does not have to be called `type`. Freezed defaults to `runtimeType`, many APIs use `kind` or `@type`, and some APIs have no discriminator at all and you have to infer the subtype from which keys are present. All three approaches below handle those cases.

## The minimal hierarchy and wire format

This is the shape used in every example:

```json
[
  { "type": "circle", "radius": 2 },
  { "type": "rect", "width": 3, "height": 4.5 }
]
```

Note `"radius": 2`. `jsonDecode` turns that into an `int`, not a `double`, which matters the moment your field is declared `double`.

## Option 1: hand-written with Dart 3 map patterns

No packages, no code generation. Map patterns check the key exists *and* the value has the right type in one step:

```dart
// Dart 3.13.7, no packages
sealed class Shape {
  const Shape();

  factory Shape.fromJson(Map<String, dynamic> json) => switch (json) {
        {'type': 'circle', 'radius': num radius} => Circle(radius.toDouble()),
        {'type': 'rect', 'width': num w, 'height': num h} =>
          Rect(w.toDouble(), h.toDouble()),
        {'type': String type} =>
          throw FormatException('Unknown or malformed Shape "$type"', json),
        _ => throw FormatException('Missing "type" discriminator', json),
      };

  Map<String, dynamic> toJson() => switch (this) {
        Circle(:final radius) => {'type': 'circle', 'radius': radius},
        Rect(:final width, :final height) =>
          {'type': 'rect', 'width': width, 'height': height},
      };
}

final class Circle extends Shape {
  const Circle(this.radius);
  final double radius;
}

final class Rect extends Shape {
  const Rect(this.width, this.height);
  final double width;
  final double height;
}
```

Running it against the payload above:

```text
[Circle, Rect]
[{"type":"circle","radius":2.0},{"type":"rect","width":3.0,"height":4.5}]
manual unknown THREW FormatException: Unknown or malformed Shape "hexagon"
manual missing type THREW FormatException: Missing "type" discriminator
manual circle missing radius THREW FormatException: Unknown or malformed Shape "circle"
manual radius as string THREW FormatException: Unknown or malformed Shape "circle"
```

Three details make this version better than the usual `json['radius'] as double` snippet:

1. **`num` then `.toDouble()`.** Matching `'radius': double r` would fail on `2` because the decoded value is an `int`. Matching `num` accepts both.
2. **Bad payloads fail with your message, not a `TypeError`.** A circle without a radius, or with `"radius": "2"`, does not match the first case, falls through to the `{'type': String type}` case, and throws a `FormatException` that carries the offending map.
3. **`toJson` is compiler-checked.** If you add `final class Triangle extends Shape` and forget it, the analyzer stops you:

```text
error - The type 'Shape' isn't exhaustively matched by the switch cases since it doesn't match the pattern 'Triangle()'. Try adding a wildcard pattern or cases that match 'Triangle()'. - non_exhaustive_switch_expression
```

`fromJson` gets no such check, because it switches on map contents. Keep the two switches next to each other on the base class so a reviewer sees both when a subclass is added.

### When the API has no discriminator

If you do not control the payload and it looks like `{"radius": 2}` or `{"width": 3, "height": 4.5}`, the same map patterns dispatch on the *presence* of keys instead:

```dart
// Dart 3.13.7: dispatch on key presence, no "type" field on the wire
factory Shape.fromJson(Map<String, dynamic> json) => switch (json) {
      {'radius': num r} => Circle(r.toDouble()),
      {'width': num w, 'height': num h} => Rect(w.toDouble(), h.toDouble()),
      _ => throw FormatException('Not a Shape', json),
    };
```

Order matters here: map patterns ignore extra keys, so put the most specific case first. A `RoundedRect` with `width`, `height` and `cornerRadius` must be matched before `Rect`, or every rounded rectangle becomes a plain one.

The hand-written version is the right call for three to five subclasses with a handful of fields each. Past that, the per-field boilerplate is where bugs live, and code generation pays for itself.

## Option 2: json_serializable for the subclasses, your own dispatch on the base

json_serializable does not understand sealed hierarchies. The feature request, [google/json_serializable.dart#1342 "Support dart3 sealed class"](https://github.com/google/json_serializable.dart/issues/1342), has been open since August 2023 and is still open as of 6.15.2. What it does well is generate the field-by-field code for each concrete class, so the pattern is: annotate the subclasses, hand-write the two switches on the base.

```dart
// Dart 3.13.7, json_serializable 6.15.2, json_annotation 4.12.0
import 'package:json_annotation/json_annotation.dart';

part 'shape.g.dart';

sealed class Shape {
  const Shape();

  factory Shape.fromJson(Map<String, dynamic> json) => switch (json['type']) {
        'circle' => Circle.fromJson(json),
        'rect' => Rect.fromJson(json),
        final type => throw CheckedFromJsonException(
            json, 'type', 'Shape', 'Unknown Shape type "$type"'),
      };

  Map<String, dynamic> toJson();
}

@JsonSerializable()
final class Circle extends Shape {
  const Circle(this.radius);
  final double radius;

  factory Circle.fromJson(Map<String, dynamic> json) => _$CircleFromJson(json);

  @override
  Map<String, dynamic> toJson() => {'type': 'circle', ..._$CircleToJson(this)};
}

@JsonSerializable()
final class Rect extends Shape {
  const Rect(this.width, this.height);
  final double width;
  final double height;

  factory Rect.fromJson(Map<String, dynamic> json) => _$RectFromJson(json);

  @override
  Map<String, dynamic> toJson() => {'type': 'rect', ..._$RectToJson(this)};
}
```

Run `dart run build_runner build`. The generated `_$CircleToJson` only contains `radius`; it knows nothing about the discriminator, which is why each override spreads it into a map that starts with `'type'`. Throwing `CheckedFromJsonException` for unknown types keeps the error shape identical to what generated code throws elsewhere, so one `on CheckedFromJsonException` handler covers both.

Because `Shape` now has a `fromJson` factory and a `toJson` method, json_serializable treats it like any other serializable type when it appears as a field. A container class just works for decoding:

```dart
// Dart 3.13.7, json_serializable 6.15.2
@JsonSerializable(explicitToJson: true)
class Drawing {
  Drawing(this.name, this.shapes);
  final String name;
  final List<Shape> shapes;

  factory Drawing.fromJson(Map<String, dynamic> json) => _$DrawingFromJson(json);
  Map<String, dynamic> toJson() => _$DrawingToJson(this);
}
```

The generated decoder calls `Shape.fromJson(e as Map<String, dynamic>)` for every element, so the dispatch you wrote is reused. Keep `explicitToJson: true`; the reason is in the gotchas below.

The one weakness: when a payload is missing a field, the generated code does not tell you which one. `Shape.fromJson({'type': 'circle'})` throws `type 'Null' is not a subtype of type 'num' in type cast`. Add `@JsonSerializable(checked: true)` to the subclasses if you want a `CheckedFromJsonException` naming the key.

## Option 3: Freezed generates the whole union

Freezed models a sealed hierarchy as a class with several factory constructors, and when json_serializable is also a dev dependency it generates the dispatch, the discriminator and the per-case code:

```dart
// Dart 3.13.7, freezed 4.0.3, freezed_annotation 3.1.0, json_serializable 6.15.2
import 'package:freezed_annotation/freezed_annotation.dart';

part 'shape.freezed.dart';
part 'shape.g.dart';

@Freezed(unionKey: 'type', unionValueCase: FreezedUnionCase.snake)
sealed class Shape with _$Shape {
  const factory Shape.circle({required double radius}) = Circle;
  const factory Shape.rect({required double width, required double height}) =
      Rect;
  const factory Shape.roundedRect({
    required double width,
    required double height,
    required double cornerRadius,
  }) = RoundedRect;

  factory Shape.fromJson(Map<String, dynamic> json) => _$ShapeFromJson(json);
}
```

The dev dependencies are `build_runner`, `freezed` and `json_serializable`; the regular dependencies are `freezed_annotation` and `json_annotation`. Freezed 4.0.3 requires Dart 3.13, so on Flutter 3.44 (Dart 3.12) you stay on Freezed 3.2.x, where the same annotations work.

What the generated code does:

```text
[{"radius":2.0,"type":"circle"},{"width":3.0,"height":4.5,"type":"rect"},{"width":1.0,"height":2.0,"cornerRadius":0.5,"type":"rounded_rect"}]
fz unknown THREW CheckedFromJsonException: Could not create `Shape`. There is a problem with "type". Invalid union type "hexagon"!
fz missing type THREW CheckedFromJsonException: Could not create `Shape`. There is a problem with "type". Invalid union type "null"!
```

- `unionKey: 'type'` renames the discriminator. Without it Freezed writes and reads `runtimeType`, so a plain `@freezed` union produces `{"n": 1, "runtimeType": "a"}`. That is almost never what a backend expects.
- `unionValueCase` controls how constructor names become values: `roundedRect` becomes `rounded_rect` with `FreezedUnionCase.snake`, `rounded-rect` with `kebab`, `RoundedRect` with `pascal`, and stays `roundedRect` with the default `none`.
- `@FreezedUnionValue('rounded-rect')` on one constructor overrides the value for that case only, which is how you match a wire format that does not follow any single casing rule.
- The generated classes are real subtypes, so an exhaustive `switch (shape) { Circle(:final radius) => ..., Rect() => ..., RoundedRect() => ... }` works exactly as in option 1.

If you want the settings everywhere instead of per class, put them in `build.yaml`:

```yaml
# build.yaml, freezed 4.0.3
targets:
  $default:
    builders:
      freezed:
        options:
          union_key: type
          union_value_case: snake
```

### Unknown types: `fallbackUnion`

Clients outlive server deploys. When the backend adds a new event type, an app that throws on unknown discriminators crashes on a list it could otherwise have rendered. Freezed's `fallbackUnion` routes every unrecognised value to one constructor:

```dart
// Dart 3.13.7, freezed 4.0.3
@Freezed(unionKey: 'type', fallbackUnion: 'unknown')
sealed class Event with _$Event {
  const factory Event.click({required int x, required int y}) = ClickEvent;
  const factory Event.unknown() = UnknownEvent;

  factory Event.fromJson(Map<String, dynamic> json) => _$EventFromJson(json);
}
```

Decoding `{"type": "scroll", "dy": 120}` gives `Event.unknown()`, and its `toJson()` returns `{type: scroll}`: Freezed keeps the original discriminator in the hidden `$type` field, but the payload (`dy`) is gone. A missing `type` key also lands in the fallback. If you need to re-send or log unknown events faithfully, give the fallback constructor a `Map<String, dynamic>` field and populate it with a custom `fromJson`, or use the hand-written version where the `_` case can keep the whole map.

## Gotchas that bite in every approach

1. **Nested `toJson` returns objects, not maps, unless you ask.** Without `explicitToJson: true`, json_serializable writes `'shapes': instance.shapes`. The result of `Drawing.toJson()` is `{name: d, shapes: [Instance of 'Circle', Instance of 'Rect']}`. `jsonEncode` hides the problem because it calls `toJson()` on anything it cannot encode, so the string looks correct. Anything that consumes the *map* (Firestore, `shared_preferences` via a map, `Isolate` messages, a test that compares maps) gets Dart objects. Freezed has the same default; the fix there is annotating the factory constructor:

   ```dart
   // Dart 3.13.7, freezed 4.0.3
   @freezed
   abstract class FzDrawing with _$FzDrawing {
     @JsonSerializable(explicitToJson: true)
     const factory FzDrawing({required String name, required List<Shape> shapes}) =
         _FzDrawing;

     factory FzDrawing.fromJson(Map<String, dynamic> json) =>
         _$FzDrawingFromJson(json);
   }
   ```

   After that change `toJson()` produced `{name: d, shapes: [{radius: 2.0, type: circle}, ...]}` and the decode-encode-decode round trip compared equal.

2. **`int` versus `double`.** Generated code already does `(json['radius'] as num).toDouble()`. Hand-written code that casts `as double` throws on `2`, and Dart's `jsonEncode` writes `2.0` back, so a byte-for-byte comparison with the original payload fails even when the value round-tripped correctly. Compare decoded objects, not strings.

3. **The discriminator must not collide with a field.** If a case already has a field called `type`, Freezed does not complain. With `unionKey: 'type'` and `const factory Note.email({required String type, required String to})`, `toJson()` returned `{type: urgent, to: a}`: the field silently replaced the discriminator, so decoding that output throws `Invalid union type "urgent"!`. In the other direction, `Note.fromJson({'type': 'email', 'to': 'a'})` stuffs the discriminator into the field (`Note.email(type: email, ...)`). Pick a `unionKey` that no field uses, such as `kind`. The hand-written and json_serializable versions have the same trap if a subclass `toJson` contains a `type` key, because the spread overwrites the literal.

4. **Renaming a constructor is a wire-format change.** With Freezed, the discriminator value is derived from the constructor name. Renaming `Shape.rect` to `Shape.rectangle` silently changes what you send and breaks every stored document and older client. Pin values with `@FreezedUnionValue('rect')` on anything that is persisted or shared with another service.

5. **`build_runner` flags have moved.** On build_runner 2.17.1, `dart run build_runner build --delete-conflicting-outputs` prints `These options have been removed and were ignored: --delete-conflicting-outputs` and still builds. Old READMEs and CI scripts still pass it; the warning is harmless, but remove it so it does not hide a real one.

6. **Generics need `genericArgumentFactories`.** A `sealed class Result<T>` with `Ok<T>` and `Err<T>` cases needs `@JsonSerializable(genericArgumentFactories: true)` (or `@Freezed(genericArgumentFactories: true)`), and `fromJson` then takes an extra `T Function(Object?) fromJsonT` parameter. Plan for that signature before you spread `Result.fromJson` across the codebase.

## Which one to pick

- **Hand-written** for small, stable hierarchies, or when the payload has no discriminator and you must infer the type from its keys. Zero dependencies, best error messages, but every field is code you maintain.
- **json_serializable on the subclasses** when you already use it for plain DTOs and want to keep subclasses as normal classes with their own methods. You write about ten lines of dispatch per hierarchy.
- **Freezed** when you also want `copyWith`, value equality and `toString`, or the hierarchy is large. Set `unionKey` explicitly, pin values with `@FreezedUnionValue` for persisted data, and decide up front whether unknown types throw or go to `fallbackUnion`. The [records vs Freezed comparison](/2026/05/dart-records-vs-freezed-classes/) covers when Freezed's codegen is worth having at all.

### Read next

- [Fix FormatException: Unexpected character when parsing JSON in Dart](/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/) for the step before `fromJson` even runs.
- [Fix "type 'Null' is not a subtype of type" in Dart](/2026/07/fix-type-null-is-not-a-subtype-of-type-in-dart/), the error a missing field produces in generated `fromJson` code.
- [How to handle network errors gracefully in a Flutter app](/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/), including where a decoding failure should surface in the UI.
- The C# equivalent, [serializing a polymorphic hierarchy with JsonDerivedType in System.Text.Json](/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/), solves the same discriminator problem with attributes.

### Sources

- [Dart language: patterns, map patterns](https://dart.dev/language/pattern-types#map) and [class modifiers: sealed](https://dart.dev/language/class-modifiers#sealed)
- [Freezed README: fromJSON for classes with multiple constructors](https://pub.dev/packages/freezed#fromjson---classes-with-multiple-constructors) and the [Freezed changelog](https://pub.dev/packages/freezed/changelog)
- [json_serializable on pub.dev](https://pub.dev/packages/json_serializable) and [issue #1342, sealed class support](https://github.com/google/json_serializable.dart/issues/1342)
- [build_runner changelog](https://pub.dev/packages/build_runner/changelog)
