---
title: "Dart 3.14 Brings Back dart migrate, This Time for Language Version Upgrades"
description: "Dart 3.14 (November 11, 2026) adds a new dart migrate command that raises your pubspec SDK constraint one minor version at a time and applies the prepare, bump, and cleanup fixes each language version needs."
pubDate: 2026-11-14
tags:
  - "dart"
  - "flutter"
  - "dart-3-14"
  - "tooling"
---

Dart 3.14 shipped on November 11, 2026, alongside Flutter 3.50. The [language evolution page](https://dart.dev/resources/language/evolution) is blunt about it: no new language features this time. The interesting part is a CLI command with a familiar name. `dart migrate` is back, but it has nothing to do with the null safety tool that was removed in Dart 3 (the one covered in our [Flutter 2 to Flutter 3 null safety checklist](/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/)). The new command upgrades a package to a newer **language version**.

## Why bumping the SDK constraint was never just a one-line change

In Dart, the lower bound of `environment.sdk` in `pubspec.yaml` selects the language version your code is analyzed under. Raise `^3.12.0` to `^3.13.0` and any feature that changes meaning in 3.13 suddenly applies to you. The [dart migrate guide](https://dart.dev/tools/dart-migrate) uses a concrete example: `final` on non-declaring parameters, which is an error under the 3.13 language version. Bump the constraint by hand and the analyzer turns red; fix the code first and you are guessing which lints catch what.

`dart migrate` orders that work for you, per the guide:

1. **Dependency check**: verifies every dependency supports the target SDK, and stops with a list of packages to update if not.
2. **`prepare`**: applies fixes for code that breaks or changes behavior under the target version.
3. **`bump`**: raises the lower `environment.sdk` bound and re-analyzes.
4. **`cleanup`**: optional fixes that adopt the new version's features. Not applied by default.

It runs its own migration lints even when your `analysis_options.yaml` does not enable them, and if any step fails, both `pubspec.yaml` and your sources are left untouched.

## Running it

Start with a dry run from the package root:

```bash
dart migrate --dry-run
```

The guide's sample output for a package on `^3.12.0`:

```
my_pkg:
  3.12.0 -> 3.13.0:
    Preparatory changes:
      2 changes would be made in 1 file.
      my_pkg/lib/greeter.dart
        avoid_final_parameters • 2 changes
    SDK constraint:
      Would bump ^3.12.0 -> ^3.13.0
Optional cleanup fixes can modernize your code further:
  my_pkg: 1 change in 1 file
    empty_container_bodies • 1 change
```

Then apply. The default `--step` is `prepare,bump`, so cleanup only runs if you ask:

```bash
# prepare + bump (default)
dart migrate --apply

# everything, including the optional modernizations
dart migrate --apply --step=all

# jump several minor versions; it still walks them one at a time
dart migrate --apply --target-sdk=3.14.0

# monorepo: pub workspaces are not expanded, list packages explicitly
dart migrate --apply my_app packages/my_pkg
```

In the guide's example, `--step=all` removes the `final` modifiers, sets `sdk: ^3.13.0`, and rewrites an empty class body `{}` to `;`, giving `class EmptyNameException implements Exception;`.

## The limits worth knowing

- It only handles packages whose SDK constraint is already Dart 3.0 or later.
- Without `--target-sdk`, it moves exactly one minor version. The target cannot be newer than your installed SDK, and it does not upgrade the Dart or Flutter SDK itself.
- It does not check for uncommitted changes. Commit or stash first so the diff is reviewable.
- `--step=bump` refuses to run while required `prepare` fixes are still pending.
- The [3.14.0 changelog](https://dart.googlesource.com/sdk/+/stable/CHANGELOG.md) adds that dependent packages are migrated in lockstep so constraints stay solvable at every intermediate version.

## The one soundness fix in 3.14

The other change that can touch existing code is a flow analysis fix that is not language-versioned, so it applies regardless of your constraint: a subpattern inside a list, map, or record pattern no longer promotes the entire matched property to the subpattern's type ([dart-lang/sdk#64269](https://github.com/dart-lang/sdk/issues/64269)). If code that compiled on 3.13 relied on that wider promotion after a pattern match, expect the analyzer to flag it on 3.14; an explicit type test on the property restores the narrowing.

The full rundown, including the new `dart run -e` snippet runner and the DartPad beta, is in the [Dart 3.14 announcement](https://dart.dev/blog/announcing-dart-3-14).
