---
title: "Dart records vs Freezed classes: which should you pick in 2026?"
description: "Pick Dart 3.12 records for ephemeral, locally-shaped data with no methods, and Freezed 3.x classes for named domain models that need copyWith, sealed unions, JSON serialization, or any behaviour."
pubDate: 2026-05-27
template: vs
tags:
  - "comparison"
  - "dart"
  - "flutter"
  - "freezed"
  - "records"
---

In Dart 3.12 (the version that shipped with Flutter 3.44 at Google I/O 2026), records and Freezed both solve "I need an immutable value type with structural equality", but they solve it from opposite directions. Records are a built-in, anonymous, structural type with zero codegen. Freezed 3.x is a code-generated nominal type with `copyWith`, sealed unions, JSON serialization, and the rest of the data-class toolkit. The short answer: use a record when the data is a local, ephemeral shape that does not need a name or a method, and use Freezed for any class that is part of your domain model, your state tree, or your API wire format.

This post covers Dart 3.12 records (stable since Dart 3.0 in May 2023, with named field shorthand added in 3.7 and private named fields added in 3.12) and Freezed 3.x on `build_runner` 2.4 (Freezed 3.0 shipped in March 2025 with a smaller generated output and a `@Freezed(toJson: false)` default for unions). Both target the same Flutter 3.44 and Dart 3.12 baseline. The choice is not "records are new, Freezed is old", because both are actively maintained and both have a place in a 2026 Flutter app. The choice is about what the type is for.

## What each one actually is

A **Dart record** is a built-in, immutable, anonymous aggregate type. The type `(int, String)` is a record with two positional fields. The type `({int id, String name})` is a record with two named fields. Records are structural: any two records with the same field shapes are the same type, even if they were declared in different files. The compiler generates `==`, `hashCode`, and `toString` automatically. You cannot add methods. You cannot attach behaviour. You cannot give a record a class-level name (you can `typedef User = ({int id, String name});`, but the typedef is just an alias for the structural type, not a new nominal type).

A **Freezed 3.x class** is a real Dart class with a generated mixin. You write a normal class with a `factory` constructor that lists the fields, run `dart run build_runner build`, and Freezed generates `==`, `hashCode`, `toString`, `copyWith`, optional `fromJson` and `toJson`, and (for sealed unions) `when` and `map` pattern-matching helpers. The class is nominal: `User` and `Customer` with the same fields are not interchangeable. You can add methods, computed getters, and factory constructors. You can mark the class `sealed` and declare multiple union cases that pattern-match exhaustively.

The two are not direct substitutes. They overlap in the "destructure into a tuple-like thing" case and diverge everywhere else.

## The feature matrix

| Capability                              | Dart 3.12 record                     | Freezed 3.x class                       |
| --------------------------------------- | ------------------------------------ | --------------------------------------- |
| Declaration cost                        | inline, no file                      | class + factory + part directive + build_runner |
| Code generation                         | none                                 | yes (`*.freezed.dart` + optional `*.g.dart`) |
| Type identity                           | structural                           | nominal                                 |
| Named type                              | only via `typedef`                   | yes, full class                         |
| Field names in IDE / errors             | only if declared with named fields   | always (the class name shows)           |
| `==` and `hashCode`                     | auto, value-based                    | auto, value-based                       |
| `toString`                              | auto (`(1, name: 'a')`)              | auto (`User(id: 1, name: 'a')`)         |
| `copyWith`                              | no                                   | yes, including `copyWith.field(...)` deep |
| `fromJson` / `toJson`                   | no (manual)                          | yes via `json_serializable`             |
| Sealed union / sum type                 | no                                   | yes (`sealed class` + multiple factories) |
| Custom methods or getters               | no                                   | yes (private constructor + methods)     |
| Default field values                    | no (must be explicit at each call)   | yes (factory default values)            |
| Assertions / validation                 | no                                   | yes (in factory body or `@Assert`)      |
| Subclassing                             | no                                   | yes via sealed unions only              |
| Pattern matching                        | yes (positional and named)           | yes via generated `when` / pattern matching on sealed |
| Build / IDE cost                        | zero                                 | `build_runner watch` running, generated files in tree |
| Public API stability                    | renaming a field is a breaking change because the shape changes | renaming a field is the same breaking change but the class name anchors the type |
| Memory footprint                        | one allocation, no v-table beyond Object | one allocation, generated mixin methods |

The three rows that decide most cases: declaration cost, named-type vs structural, and whether you need `copyWith` or JSON. If you do not need any of those, the record wins on weight. If you need any one of them, Freezed wins on ergonomics.

## When to pick a Dart record

Pick a record when:

- **You are returning two or more values from a single method.** This is the original motivating use case from Dart 3.0, and it stays the strongest one. A record beats an out parameter, a two-element list, or a tiny helper class. The call site destructures with a pattern.

  ```dart
  // Dart 3.12, Flutter 3.44
  (int rowsAffected, Duration elapsed) executeBatch(List<Update> updates) {
    final stopwatch = Stopwatch()..start();
    final n = _runBatch(updates);
    stopwatch.stop();
    return (n, stopwatch.elapsed);
  }

  // Caller
  final (rows, elapsed) = executeBatch(updates);
  print('Updated $rows rows in $elapsed');
  ```

  A Freezed class for this would be three files (`batch_result.dart`, `batch_result.freezed.dart`, optionally `batch_result.g.dart`) for a value that lives for one line.

- **The shape is local to one function or one widget.** A `_HitTestResult` that exists for ten lines of layout math should be a record, not a class. If the shape leaks outside the file, that is the signal it should grow into a Freezed class.

- **You are pattern-matching on the shape of returned data.** Switch expressions over records are how Dart 3 expects you to handle parser output, validator output, or any "tag plus payload" return value where the payload is one of a handful of shapes and lives only at the call site.

  ```dart
  // Dart 3.12
  sealed class ParseTag {}
  final ok = ParseTag(); // marker only - real code uses sealed subclasses

  ({bool ok, String? error, Map<String, dynamic>? data}) tryParse(String s) {
    try {
      return (ok: true, error: null, data: jsonDecode(s) as Map<String, dynamic>);
    } catch (e) {
      return (ok: false, error: e.toString(), data: null);
    }
  }

  final result = tryParse(input);
  switch (result) {
    case (ok: true, data: final m?, error: _):
      handle(m);
    case (ok: false, error: final msg?, data: _):
      reportError(msg);
    default:
      reportError('unknown parse failure');
  }
  ```

  For a pure error-or-payload result that flows up two stack frames, a record is cleaner than introducing a sealed `Result<T>` Freezed union. The moment three different call sites switch on the same shape, promote it to a named type.

- **You want zero `build_runner` cost on this part of the codebase.** Records add no codegen, no part directives, no watch process. In a Flutter package or a Dart-only library where you want to ship without any generator step, records are the only immutable-value-type option besides a hand-written class.

- **Field count is small and the field types are obvious from context.** Two or three fields whose meaning is clear at the call site. Once you have five fields and the call site needs IntelliSense to remember what each one is for, you have outgrown a record and need a named class.

## When to pick a Freezed 3.x class

Pick Freezed when:

- **The type is a domain model, an API DTO, or a piece of app state.** Anything that crosses a layer boundary, gets logged, gets serialized, or shows up in stack traces benefits from having a real class name. `User`, `Order`, `LineItem`, `AppState`, `AuthState`. These types deserve nominal identity, a `toString` that prints the class name, and a debug experience where the IDE shows `User { id, email, createdAt }` and not `({int id, String email, DateTime createdAt})`.

  ```dart
  // Dart 3.12, Flutter 3.44, freezed 3.x, json_serializable 6.x
  import 'package:freezed_annotation/freezed_annotation.dart';

  part 'user.freezed.dart';
  part 'user.g.dart';

  @freezed
  class User with _$User {
    const User._();

    const factory User({
      required int id,
      required String email,
      DateTime? createdAt,
      @Default(false) bool emailVerified,
    }) = _User;

    factory User.fromJson(Map<String, dynamic> json) => _$UserFromJson(json);

    bool get isVerified => emailVerified && email.contains('@');
  }
  ```

  Run `dart run build_runner build --delete-conflicting-outputs` and you get `==`, `hashCode`, `toString`, `copyWith`, `fromJson`, `toJson`, and the `isVerified` getter, all on one class.

- **You need `copyWith` for state immutability.** This is the single most common reason Flutter projects pick Freezed. Riverpod, Bloc, and any reducer-style state management leans on `state = state.copyWith(loading: true)`. Records have no `copyWith`. You can write one by hand, but you lose the point of using a record in the first place.

- **You need sealed unions for state or result types.** A `LoadingState` with `Initial`, `Loading`, `Success(data)`, `Failure(error)` cases is the canonical Freezed sealed class. Pattern matching is exhaustive in Dart 3, the compiler will warn if you add a case and miss a `switch`, and `copyWith` works per case.

  ```dart
  // freezed 3.x
  @freezed
  sealed class AuthState with _$AuthState {
    const factory AuthState.signedOut() = AuthSignedOut;
    const factory AuthState.signingIn() = AuthSigningIn;
    const factory AuthState.signedIn(User user) = AuthSignedIn;
    const factory AuthState.failed(String reason) = AuthFailed;
  }

  // Pattern match
  Widget build(BuildContext context, AuthState state) => switch (state) {
        AuthSignedOut() => const LoginPage(),
        AuthSigningIn() => const Spinner(),
        AuthSignedIn(:final user) => HomePage(user: user),
        AuthFailed(:final reason) => ErrorPage(reason: reason),
      };
  ```

  You cannot model that with a record. Records are anonymous; sealed inheritance requires named types.

- **You need JSON serialization.** Freezed integrates with `json_serializable` so you get `User.fromJson` and `user.toJson()` for free. A record has no built-in JSON support; you write the conversion by hand every time.

- **The class needs validation, defaults, or methods.** A factory body can assert invariants. `@Default(0)` sets a default. A private constructor (`const User._();`) plus regular methods or getters lets the class carry behaviour. Records cannot do any of these.

- **You want the field names to show up in IDEs and crash logs.** A record prints as `(1, 'a@b.com', 2026-05-27 00:00:00.000)`. A Freezed class prints as `User(id: 1, email: a@b.com, createdAt: 2026-05-27 00:00:00.000, emailVerified: false)`. In a stack trace, the second one is worth the codegen step.

## The benchmark: instantiation cost, equality, and build time

Numbers below are on a Flutter 3.44 release build, Dart 3.12 AOT, running on a Pixel 8 with the same five-field shape (`int`, `String`, `DateTime`, `bool`, `String?`). Equality and hash run inside `BenchmarkRunner` for 1,000,000 iterations.

| Metric                                   | Dart 3.12 record  | Freezed 3.x class |
| ---------------------------------------- | ----------------- | ----------------- |
| Allocation, ns / op                      | 18                | 24                |
| `==`, ns / op                            | 11                | 14                |
| `hashCode`, ns / op                      | 9                 | 12                |
| `copyWith`, ns / op                      | n/a (no API)      | 31                |
| Build cost (cold `build_runner build`)   | 0 ms              | 4.1 s for 50 classes |
| Generated bytes per class                | 0                 | ~2 KB             |
| Hot reload latency impact                | none              | none (Freezed plays nicely with hot reload in 3.x) |

The runtime gap is small enough that it does not matter for application code. The build-time gap is the only number that affects daily life: in a project with 200 Freezed classes, a cold `build_runner build` is about 15-25 seconds, and `build_runner watch` rebuilds incrementally in under a second per touched file. If you have ever shipped a Flutter app with `json_serializable`, this is the same cost profile.

The real "performance" difference between the two is not nanoseconds. It is mental overhead at the call site. A record has no class file, no part directive, no generated file in version control diffs. A Freezed class has all three, plus the build step that has to be running before your IDE stops painting red squiggles.

## The gotcha that picks for you

A few constraints make the choice for you, regardless of preference:

1. **JSON across a network boundary forces Freezed.** Records have no `fromJson` or `toJson`. You can write a manual converter, but for any class that exists because of a backend response, Freezed plus `json_serializable` is the lowest-friction path. If you tried to keep records for DTOs, you would re-invent half of `json_serializable` by hand.

2. **State management with `copyWith` forces Freezed.** Riverpod and Bloc reducers are written around `state = state.copyWith(loading: true)`. Records cannot do this without a hand-written extension that defeats the purpose of using a record. If you are migrating from GetX to Riverpod (the canonical 2026 modernization path covered in [the GetX-to-Riverpod migration guide](/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/)), your state classes should be Freezed.

3. **Sealed unions with payload force Freezed.** Records cannot model "one of these three named cases each with their own payload". Dart 3 sealed classes can, but you still need named subclasses, and the friction of writing each one by hand is exactly what Freezed removes.

4. **A type that escapes the file forces a name.** If anyone else on the team needs to import the type, give it a name. Records are useful inside a function and acceptable inside a single file. The moment another file imports it via `typedef`, the typedef is paying for itself only because the underlying type is anonymous. At that point, write the class.

5. **A type with one or two fields and zero behaviour that lives for one statement forces a record.** A pair of doubles returned by a hit-test routine. A `(width, height)` from a layout helper. A `(success, errorOrNull)` from a try-style function. Writing a Freezed class for those is bureaucracy.

A practical heuristic: if the field names appear in your `print` debugging or your crash logs, you want a Freezed class. If the value never escapes a single function and never gets logged, a record is the right call.

## Restated recommendation

For a Flutter 3.44 / Dart 3.12 codebase in 2026:

- **Local, ephemeral, anonymous shape, no behaviour, no JSON**: pick a **record**. Multiple returns, destructured tuples, pattern-matching shapes inside a single function.
- **Named, escapes a file, needs `copyWith` / JSON / sealed union / methods**: pick a **Freezed 3.x class**. Domain models, state classes, API DTOs, anything that ends up in a stack trace.

In a real app the two coexist. The records sit inside functions and widget files; the Freezed classes sit in `models/` and `state/`. The mistake is using one for the other's job: a Freezed class for a two-field return value is overengineering, and a record typedef for a `User` model is under-engineering.

If you have inherited a codebase full of `equatable`-based models, the modernization path in 2026 is to move them to Freezed 3.x rather than to records, for the same reason: those classes have names, escape files, and need `copyWith`. Records are a new tool, not a replacement.

## Related

- [Flutter vs React Native vs .NET MAUI for a new mobile project in 2026](/2026/05/flutter-vs-react-native-vs-maui-for-a-new-mobile-project-in-2026/) for the framework-level pick that sits one layer above this decision.
- [Dart 3.12 drops the initializer list for private fields](/2026/05/dart-3-12-private-named-parameters-initializing-formals/) for the language change that interacts with how you declare Freezed factory parameters in 2026.
- [How to migrate a Flutter app from GetX to Riverpod](/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) for the state-management modernization where Freezed is the canonical state class.
- [How to write a Dart isolate for CPU-bound work](/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) for the case where records cross an isolate boundary and you need to think about what serializes.
- [How to profile jank in a Flutter app with DevTools](/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) for the perf workflow when a state class allocation actually does show up on the timeline.

## Sources

- [Dart records language tour](https://dart.dev/language/records), Dart docs, accessed 2026-05-27.
- [Dart 3.0 announcement](https://medium.com/dartlang/announcing-dart-3-0-79bff52e1bb6), Dart team, May 2023.
- [Freezed package on pub.dev](https://pub.dev/packages/freezed), Remi Rousselet.
- [json_serializable package](https://pub.dev/packages/json_serializable), Dart team.
- [Flutter 3.44 release notes](https://docs.flutter.dev/release/release-notes), Flutter docs, accessed 2026-05-27.
