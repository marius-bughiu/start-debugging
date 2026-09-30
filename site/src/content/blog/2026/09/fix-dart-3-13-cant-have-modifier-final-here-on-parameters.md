---
title: "Fix: Can't have modifier 'final' here on parameters after upgrading to Dart 3.13"
description: "Dart 3.13 reserves final and var in parameter lists for primary constructors. Run dart fix --apply --code=extraneous_modifier to strip them, and use parameter_assignments instead."
pubDate: 2026-09-30
template: error-page
tags:
  - "errors"
  - "dart"
  - "flutter"
  - "dart-3-13"
---

Dart 3.13 (the SDK in Flutter 3.47) no longer lets you write `final` or `var` on the parameters of ordinary functions, methods, closures and in-body constructors. Both keywords are now reserved for declaring parameters in primary constructors, so `int add(int a, final int b)` fails with `extraneous_modifier` as soon as your `pubspec.yaml` says `sdk: ^3.13.0`. Run `dart fix --apply --code=extraneous_modifier` to remove every offending modifier in one pass. If you used `final` to stop parameters from being reassigned, enable the `parameter_assignments` lint instead.

Everything below was reproduced on Dart 3.13.3 (Flutter 3.47.4) and Dart 3.12.2 (Flutter 3.44.8) on macOS arm64, and checked against the 3.13.0 changelog, the accepted primary constructors specification, and the triage of [dart-lang/sdk#64151](https://github.com/dart-lang/sdk/issues/64151), where the Dart team confirmed the restriction is intentional.

## The error in context

`dart analyze` and the IDE report it as an analyzer error:

```text
error - lib/a.dart:2:16 - Can't have modifier 'final' here. Try removing 'final'. - extraneous_modifier
```

`dart run`, `flutter run` and `flutter build` go through the front-end compiler instead, which prints the same text with a caret under the keyword:

```text
lib/a.dart:2:16: Error: Can't have modifier 'final' here.
Try removing 'final'.
int add(int a, final int b) => a + b;
               ^^^^^
```

For `var` the message swaps the keyword: `Can't have modifier 'var' here. Try removing 'var'.` A typed `var int n` parameter additionally reports `var_and_type`, but that one was already an error before 3.13.

The confusing part is the trigger. Nobody touched the file. What changed is the SDK constraint: someone bumped `environment: sdk:` to `^3.13.0` to try primary constructors, or a template generated a new package with the 3.13 lower bound, and code that compiled for years started failing. A typical CI failure looks like the one in #64151: a private helper method written months earlier with `final int precision` in its parameter list, in a class that has no primary constructor anywhere.

## Why Dart 3.13 rejects final on parameters

Dart 3.13.0 shipped [primary constructors](https://dart.dev/language/primary-constructors) on 2026-08-12. A primary constructor lives in the class header, and a parameter marked `final` or `var` there is a *declaring parameter*: it declares an instance field as well as a constructor parameter.

```dart
// Dart 3.13.3
class Point(final int x, final int y); // declares fields x and y
```

To keep that meaning unambiguous, the [feature specification](https://github.com/dart-lang/language/blob/main/accepted/3.13/primary-constructors/feature-specification.md) disallows `var x`, `final x` and `final T x` as formal parameter declarations in every function that is not a primary constructor. The Dart team chose consistency over a narrower rule: in #64151 Leaf Petersen answered the question "was this meant to be narrower?" with a plain yes, it is intended.

Two details make it feel like a regression rather than a language change:

1. **It is language-versioned.** The restriction applies only to libraries whose language version is 3.13 or later. The language version comes from the lower bound of `sdk:` in `pubspec.yaml`, so the same code with `sdk: ^3.12.0` still compiles on the 3.13 SDK. That is also why the Dart team did not treat it as a breaking change in the formal sense.
2. **It was barely documented at release.** The original 3.13.0 changelog described primary constructors but did not flag the effect on ordinary functions. After #64151 the changelog gained a "**Breaking change**: You can no longer use `final` or `var` on non-declaring parameters" entry under Language, and the primary constructors page got a "Constraints and breaking changes" section. The only earlier signal was the deprecation of the `prefer_final_parameters` lint in Dart 3.11.

## Minimal repro

Two files are enough. The pubspec sets the language version:

```yaml
# Dart 3.13.3
name: fp
environment:
  sdk: ^3.13.0
```

And a library that uses `final` and `var` in every common parameter position:

```dart
// Dart 3.13.3, language version 3.13
int add(int a, final int b) => a + b;                   // error

void named({required final String id, final int retries = 3}) {} // 2 errors

void positional([final int? x]) {}                      // error

void callback(final void Function(int) onTap) {}        // error

void untypedVar(var x) {}                               // error

class Money {
  final int cents;
  Money(final int c) : cents = c;                       // error, in-body constructor
  Money operator +(final Money other) => Money(cents + other.cents); // error
  set value(final int v) {}                             // error
  static Money zero(final int unused) => Money(0);      // error
}

void loops(List<int> xs) {
  for (final x in xs) {                                 // fine, not a parameter
    print(x);
  }
  final local = xs.length;                              // fine, local variable
  xs.forEach((final v) => print(v + local));            // error, closure parameter
}

class Point(final int x, final int y);                  // fine, declaring parameters
```

`dart analyze` on 3.13.3 reports one `extraneous_modifier` error for every parameter marked above. Changing the pubspec to `sdk: ^3.12.0` makes all of them disappear, and the only remaining errors are on the `Point` line, which now says `This requires the 'primary-constructors' language feature to be enabled`.

Field formals and super parameters are caught too. `T2(final this.x)` and `C(final super.y)` both produce `extraneous_modifier` on 3.13, plus an `unnecessary_final` warning, because those parameters were always implicitly final.

What is *not* affected: local variables, `for (final ... in ...)`, pattern variables, fields, and plain `this.x` / `super.x` parameters.

## Fix, in detail

Pick one of these, in order of preference.

### 1. Let dart fix remove the modifiers

The analyzer ships a fix for `extraneous_modifier`, so the migration is mechanical:

```bash
dart fix --dry-run
```

On the repro package that reports `extraneous_modifier - 11 fixes` in `lib/a.dart`, one per error. Apply only that code so nothing else in the project gets rewritten:

```bash
dart fix --apply --code=extraneous_modifier
```

The resulting diff is exactly what you would write by hand:

```dart
// Dart 3.13.3, after dart fix
int add(int a, int b) => a + b;
void named({required String id, int retries = 3}) {}
void positional([int? x]) {}
void callback(void Function(int) onTap) {}
void untypedVar(x) {}

class Money {
  final int cents;
  Money(int c) : cents = c;
  Money operator +(Money other) => Money(cents + other.cents);
  set value(int v) {}
  static Money zero(int unused) => Money(0);
}
```

After the fix, `dart analyze` reports no issues and the program runs. In a Flutter app the command is the same; `flutter` just uses the Dart SDK it bundles, so run `dart fix` from the project root with Flutter 3.47 on the path.

Note that `var x` becomes a bare `x`, which is an implicitly `dynamic` parameter. That compiles, but if you have `strict-raw-types` or similar analyzer settings, give it a real type while you are there.

### 2. Keep the "don't reassign parameters" rule with a lint

Most people wrote `final` on parameters to make reassignment a compile error. That guarantee now comes from the linter:

```yaml
# analysis_options.yaml, Dart 3.13.3
linter:
  rules:
    - parameter_assignments
```

```dart
// Dart 3.13.3
int clamp(int value, int max) {
  if (value > max) value = max; // info: Invalid assignment to the parameter 'value'.
  return value;
}
```

Do not reach for `prefer_final_parameters` to get the old behaviour back. It has been deprecated since Dart 3.11, and on 3.13 enabling it produces `The lint rule 'prefer_final_parameters' is deprecated and shouldn't be enabled`. Its advice would now point you at code that does not compile. If your team's shared lint package still enables it, that package needs an update too.

### 3. Pin a single file to the old language version

When you cannot touch a file today, for example generated code or a vendored library, a language version comment at the top of the file opts that one library out:

```dart
// @dart=3.12
// Dart 3.13.3 SDK, this library uses language version 3.12
int legacyAdd(int a, final int b) => a + b; // compiles
```

The rest of the package can use primary constructors. This is a stopgap: a file pinned to 3.12 cannot use any 3.13 feature, and you will want to delete the comment once the file is cleaned up.

### 4. Leave the SDK constraint at 3.12 until you are ready

Because the check is keyed on your package's language version, not the SDK you run, the 3.13 SDK happily compiles a package whose constraint is `sdk: ^3.12.0`. If you bumped the constraint only because a template or a `pub upgrade --major-versions` did it for you, reverting the lower bound is a valid short-term fix. Dependencies are unaffected either way: in my repro a path dependency with `sdk: ^3.12.0` and `final` on a parameter compiled and ran fine inside a 3.13 app, because each package is compiled at its own language version.

## Prepare a 3.12 codebase before the upgrade

If you are still on Flutter 3.44 / Dart 3.12, you can find and fix everything before bumping the constraint. The primary constructors page recommends two lints that exist on 3.12.2:

```yaml
# analysis_options.yaml, Dart 3.12.2
linter:
  rules:
    - avoid_final_parameters
    - var_with_no_type_annotation
```

On 3.12.2 these report `Parameters should not be marked as 'final'` and `Avoid declaring parameters with var and no type annotation`, and both have `dart fix` support (`--code=avoid_final_parameters` and `--code=var_with_no_type_annotation`). Fix the warnings, then bump `sdk:` to `^3.13.0`, and the upgrade produces no `extraneous_modifier` errors at all.

## Gotchas and lookalikes

- **Code generators emit it too.** freezed 3.x generated constructors such as `const _Example({required final List<String> someField})` for collection fields, which breaks on a 3.13 package ([rrousselGit/freezed#1365](https://github.com/rrousselGit/freezed/issues/1365)). freezed 4.0.0 (2026-08-22) dropped `final` inside generated constructor parameters, and 4.0.2 is the current release. Upgrade the generator and rerun `dart run build_runner build`. Running `dart fix` on `.freezed.dart` files is pointless because the next build regenerates them. If you use another generator, check its changelog for "Dart 3.13" or "primary constructors" before blaming your own code.
- **Tools that parse your code can hit it even at 3.12.** In #64151 the failure came from a tool calling the analyzer's `parseString()` without a `featureSet`. That defaults to the newest language version the analyzer knows, so analyzer 13.1.0 and later rejected `final` parameters in a package that was still on an older language version. If a custom builder, a documentation tool or a code-metrics script fails while `dart analyze` passes, that is the cause, and the fix belongs in the tool.
- **The message never mentions primary constructors.** The Dart team discussed a longer message in #64151 and decided against it, so `Try removing 'final'` is what you get. If you land here from that exact string, this page is the explanation.
- **`var` without a type becomes `dynamic`.** `dart fix` turns `(var x)` into `(x)`, not `(Object? x)`. Add a type if you care.
- **Flutter version mapping.** Flutter 3.47.0 through 3.47.5 bundle Dart 3.13.0 through 3.13.4. Upgrading Flutter alone changes nothing; the errors appear only once a package's `sdk:` lower bound reaches 3.13, so after that bump, copy-pasted snippets from older answers that use `final` parameters fail right away.
- **Not the same as `final` fields in a primary constructor.** `class User(final String name);` is valid 3.13 code and declares a field. If you get `extraneous_modifier` on a primary constructor parameter, check that the parameter list really is in the class header and not an in-body constructor.

## Related

- The feature that caused this, from its experimental days: [primary constructors in Dart 3.12](/2026/06/dart-3-12-experimental-primary-constructors/).
- Another 3.13 upgrade surprise that is not visible in your diff: [CERTIFICATE_VERIFY_FAILED in the Dart 3.13 Docker image](/2026/09/fix-certificate-verify-failed-in-dart-3-13-docker-image/).
- If bumping the SDK constraint also broke dependency resolution, see [how to fix version solving failed in pubspec.yaml](/2026/05/fix-version-solving-failed-in-pubspec-yaml/).
- Choosing between generated data classes and built-in types after the freezed 4.0 upgrade: [Dart records vs freezed classes](/2026/05/dart-records-vs-freezed-classes/).
- If `dart fix` and the analyzer are slow on a large repo, [speed up the Dart analysis server in VS Code](/2026/09/how-to-speed-up-a-slow-dart-analysis-server-in-vs-code-for-a-large-flutter-monorepo/).

## Sources

- [dart-lang/sdk#64151: `final` no longer allowed on parameters of normal functions/methods](https://github.com/dart-lang/sdk/issues/64151)
- [Dart SDK CHANGELOG, 3.13.0 Language section](https://github.com/dart-lang/sdk/blob/main/CHANGELOG.md)
- [Primary constructors feature specification (accepted/3.13)](https://github.com/dart-lang/language/blob/main/accepted/3.13/primary-constructors/feature-specification.md)
- [Primary constructors, dart.dev](https://dart.dev/language/primary-constructors)
- [`parameter_assignments` lint rule](https://dart.dev/tools/linter-rules/parameter_assignments)
- [`avoid_final_parameters` lint rule](https://dart.dev/tools/linter-rules/avoid_final_parameters)
- [rrousselGit/freezed#1365: invalid `final` keyword in generated constructor parameters](https://github.com/rrousselGit/freezed/issues/1365)
- [freezed CHANGELOG (4.0.0, 4.0.2)](https://github.com/rrousselGit/freezed/blob/master/packages/freezed/CHANGELOG.md)
