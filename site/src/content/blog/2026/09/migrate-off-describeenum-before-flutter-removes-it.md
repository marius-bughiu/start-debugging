---
title: "Migrate off describeEnum in Flutter before it is removed"
description: "describeEnum has been deprecated since Flutter 3.16 and its removal PR is approved. How to replace every call with Enum.name (Flutter 3.47.4, Dart 3.13), handle enum-like classes and diagnostics, find the calls hiding in dependencies like flutter_svg 1.x, and what the build error looks like once it is gone."
pubDate: 2026-09-18
updatedDate: 2026-09-18
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "enums"
---

For almost every codebase this is a 30-minute search-and-replace: `describeEnum(x)` becomes `x.name`, `describeEnum` passed as a tear-off becomes `(e) => e.name`, and the "string back to enum" loops that paired with it become `MyEnum.values.byName(s)`. `dart fix` does not do it for you, and the only call sites that need thought are the ones passing something that is not a real Dart `Enum`. The part that actually costs time is your dependency graph: an old package such as `flutter_svg` 1.1.6 still calls `describeEnum`, and on the day it is removed your app stops compiling in a file you do not own. Everything below was verified on Flutter 3.47.4 (Dart 3.13.3), the current stable, and against a local build of Flutter with the pending removal applied.

## Where the removal actually stands

The timeline is confusing enough that it is worth pinning down before touching code, because the official docs and the SDK disagree today.

- `describeEnum` was deprecated in [flutter/flutter#125016](https://github.com/flutter/flutter/pull/125016), which landed in 3.14.0-2.0.pre and shipped in the 3.16 stable. The deprecation message reads "Use the `name` getter on enums instead. This feature was deprecated after v3.14.0-2.0.pre."
- The removal is [flutter/flutter#190076](https://github.com/flutter/flutter/pull/190076), opened on 2026-07-27. It deletes the function from `packages/flutter/lib/src/foundation/diagnostics.dart` and its tests. It has three approvals but, as of 2026-09-18, it is still open: the "Google testing" check fails because Google's internal monorepo has to roll `flutter_svg` past 2.0.0 first.
- The breaking-change guide for the removal ([flutter/website#13682](https://github.com/flutter/website/pull/13682)) was merged on 2026-08-18, and the breaking-changes index already lists "Removal of `describeEnum`" under **Released in Flutter 3.47**. That is ahead of reality. I checked `diagnostics.dart` at the `3.47.4` tag, the `3.48.0-0.5.pre` beta tag, and `master`: `describeEnum` is still defined in all three.

So nothing breaks on the stable channel today. What you get is an `info`-level `deprecated_member_use` hint that most teams have been ignoring since 2023. The moment #190076 merges, `master` breaks immediately and the next beta after that breaks for everyone on beta. Migrating now costs the same as migrating later, except later it happens during an upgrade you wanted for some other reason.

## What breaks

| Area | Change | Severity |
| ---- | ------ | -------- |
| `describeEnum(value)` in your code | Compile error: function no longer exists | high, but trivial to fix |
| `describeEnum` in a dependency | Compile error in the package's file, app will not build | high, needs a package upgrade |
| `describeEnum` on non-`Enum` classes | No `.name` getter to switch to | medium, needs a local helper |
| `describeEnum` used as a tear-off (`.map(describeEnum)`) | Same compile error | low |
| `StringProperty(name, describeEnum(v))` in `debugFillProperties` | Works if rewritten to `.name`, but `EnumProperty` is the better replacement | low |
| `dart fix` support | None. The Flutter guide says so explicitly, and `dart fix --dry-run` reports "Nothing to fix!" | informational |

## Pre-flight checklist

- Flutter 3.16 or newer. Every stable since then carries the deprecation, so the analyzer can find your call sites for you. Code on 3.47.4 is the baseline here.
- Dart 2.15 or newer for the `name` getter and `values.byName`. Both came with the `dart:core` enum helpers in Dart 2.15.0 (the Flutter guide says 2.14, but the Dart changelog lists them under 2.15.0). Any Flutter 3.x project already satisfies this.
- A clean `flutter analyze` baseline, so the deprecation hints are not buried under unrelated warnings.
- `flutter pub outdated` output for your app, because the dependency step below may force a major version bump.

## What the failure looks like after removal

To get the real error text instead of guessing, I applied the diff from #190076 to a scratch checkout of Flutter 3.47.4 and ran a probe project against it. The analyzer reports:

```text
error • The function 'describeEnum' isn't defined. Try importing the library that defines 'describeEnum', correcting the name to the name of an existing function, or defining a function named 'describeEnum' • lib/legacy.dart:27:20 • undefined_function
```

`flutter run`, `flutter test`, and `flutter build` go through the front-end compiler instead, which prints:

```text
lib/legacy.dart:27:20: Error: Method not found: 'describeEnum'.
String simple() => describeEnum(ThemeChoice.dark);
                   ^^^^^^^^^^^^
```

And a project depending on `flutter_svg: 1.1.6` fails before any of your code runs, with the error pointing into the pub cache:

```text
/Users/marius/.pub-cache/hosted/pub.dev/flutter_svg-1.1.6/lib/src/picture_provider.dart:196:33: Error: The method 'describeEnum' isn't defined for the type 'PictureConfiguration'.
      result.write('platform: ${describeEnum(platform!)}');
                                ^^^^^^^^^^^^
```

If you land on this post from that last message, skip straight to step 5.

## Migration steps

1. **List every call site with the analyzer.**
   Run `flutter analyze` and filter for the deprecation. On 3.47.4 each hit is an `info` line ending in `deprecated_member_use`:

   ```bash
   # Flutter 3.47.4
   flutter analyze --no-fatal-infos | grep "'describeEnum' is deprecated"
   ```

   A plain `grep -rn "describeEnum" lib test` catches the same sites, plus mentions in doc comments and in any files your `analysis_options.yaml` excludes. Verify: you have a list of files and line numbers, and you know which ones are in generated files (regenerate those, do not hand-edit them).

2. **Replace calls on real enums with `.name`.**
   For any value whose static type is an `enum`, the rewrite is mechanical. This covers plain enums, enhanced enums, nullable enums, and tear-offs:

   ```dart
   // Flutter 3.47.4, Dart 3.13
   enum ThemeChoice { light, dark }

   // Before
   String simple() => describeEnum(ThemeChoice.dark);
   String? nullable(ThemeChoice? c) => c == null ? null : describeEnum(c);
   List<String> tearOff() => ThemeChoice.values.map(describeEnum).toList();

   // After
   String simple() => ThemeChoice.dark.name;
   String? nullable(ThemeChoice? c) => c?.name;
   List<String> tearOff() => ThemeChoice.values.map((e) => e.name).toList();
   ```

   Behaviour is identical: since Flutter 3.0, `describeEnum` has started with `if (enumEntry is Enum) return enumEntry.name;`, so for real enums it was already just a wrapper around `.name`. That includes enhanced enums that override `toString()`. An enum whose `toString()` returns `Level(H)` still gave `high` from `describeEnum`, and gives `high` from `.name`. Verify: `flutter analyze` shows no remaining hints for these files.

3. **Replace the reverse lookup with `values.byName`.**
   Most `describeEnum` code sits next to a hand-rolled parser that loops over `values` comparing strings. Replace both halves together:

   ```dart
   // Flutter 3.47.4, Dart 3.13
   // Before
   Map<String, Object?> toJson(ThemeChoice c) => {'theme': describeEnum(c)};
   ThemeChoice fromJson(Map<String, Object?> json) =>
       ThemeChoice.values.firstWhere((e) => describeEnum(e) == json['theme']);

   // After
   Map<String, Object?> toJson(ThemeChoice c) => {'theme': c.name};
   ThemeChoice fromJson(Map<String, Object?> json) =>
       ThemeChoice.values.byName(json['theme']! as String);
   ```

   The serialized strings do not change, so stored JSON, shared preferences, and analytics events keep working. The failure mode does change: for an unknown value the old loop threw `StateError: Bad state: No element`, while `byName` throws `ArgumentError: Invalid argument (name): No enum value with that name: "blue"`. If you catch `StateError` around that parse, update the `catch`. Verify: a test that round-trips every value in `ThemeChoice.values` through `toJson`/`fromJson`, plus one test with an unknown string.

4. **Give enum-like classes a local helper.**
   `describeEnum` accepted `Object`, and for anything that was not an `Enum` it took `toString()` and returned everything after the first dot. That was aimed at pre-Dart-2.17 "enum-like" classes such as this one, which still exist in older codebases and in some packages:

   ```dart
   // Flutter 3.47.4, Dart 3.13
   class Channel {
     const Channel._(this._value);
     final String _value;
     static const Channel stable = Channel._('stable');
     static const Channel beta = Channel._('beta');
     @override
     String toString() => 'Channel.$_value';
   }
   ```

   `Channel.beta.name` does not compile, because there is no `name`. You have two options. The better one is converting `Channel` into a real `enum`, which is usually possible now that enhanced enums support fields and constructors. When that is not possible (the class comes from a package, or has non-const instances), copy the fallback branch into your own code:

   ```dart
   // Flutter 3.47.4, Dart 3.13
   /// Local copy of the only describeEnum behaviour `.name` cannot replace.
   String enumLikeName(Object value) {
     final String description = value.toString();
     final int indexOfDot = description.indexOf('.');
     assert(
       indexOfDot != -1 && indexOfDot < description.length - 1,
       'The provided object "$value" is not an enum.',
     );
     return description.substring(indexOfDot + 1);
   }

   String fromObject(Object value) =>
       value is Enum ? value.name : enumLikeName(value);
   ```

   The `value is Enum` check matters for call sites typed as `Object` or `dynamic`, which is exactly where people passed `describeEnum` a mix of enums and enum-likes. Note that the `assert` only runs in debug builds. In release, `describeEnum(42)` never threw: `indexOf` returned -1, `substring(0)` returned `"42"`, and your code carried on. The helper keeps that behaviour on purpose, so that nothing changes in production. Verify: debug-mode tests for each enum-like type return the same strings as before.

5. **Fix the calls in your dependencies.**
   Your own code is the easy part. A package that calls `describeEnum` breaks your build the day the function disappears, and you cannot patch it with a search-and-replace. Grepping the pub cache is noisy because it holds every version you ever downloaded, so scan only the package versions your app actually resolves, using `.dart_tool/package_config.json`:

   ```dart
   // Dart 3.13: list every describeEnum call in the packages your app resolves.
   // Save as tool/find_describe_enum.dart, run: dart run tool/find_describe_enum.dart
   import 'dart:convert';
   import 'dart:io';

   void main() {
     final config = File('.dart_tool/package_config.json');
     final json = jsonDecode(config.readAsStringSync()) as Map<String, dynamic>;
     final call = RegExp(r'\bdescribeEnum\s*[(),;]');
     for (final pkg in (json['packages'] as List).cast<Map<String, dynamic>>()) {
       if (pkg['name'] == 'flutter') continue; // defines it
       var rootUri = pkg['rootUri'] as String;
       if (!rootUri.endsWith('/')) rootUri += '/';
       final root = config.parent.uri.resolve(rootUri);
       final lib = Directory.fromUri(root.resolve(pkg['packageUri'] as String));
       if (!lib.existsSync()) continue;
       for (final f in lib.listSync(recursive: true).whereType<File>()) {
         if (!f.path.endsWith('.dart')) continue;
         final lines = f.readAsLinesSync();
         for (var i = 0; i < lines.length; i++) {
           if (call.hasMatch(lines[i]) && !lines[i].trimLeft().startsWith('//')) {
             print('${pkg['name']}: ${f.path}:${i + 1}');
           }
         }
       }
     }
   }
   ```

   The trailing-slash fix is not decoration. `package_config.json` stores hosted packages as `file:///.../flutter_svg-1.1.6` without a trailing slash, and resolving `lib/` against that silently points at the parent folder. My first version of this script had that bug and reported zero hits for `flutter_svg` 1.1.6. The fixed version prints:

   ```text
   flutter_svg: /Users/marius/.pub-cache/hosted/pub.dev/flutter_svg-1.1.6/lib/src/picture_provider.dart:196
   ```

   For every package it reports, check whether a newer release dropped the call. For `flutter_svg` the answer is any 2.x: I grepped 2.0.0 and 2.2.1 and neither references `describeEnum` (the latest release is 2.3.0). The 1.x to 2.x jump is a real migration of its own, because 2.0 moved to `vector_graphics` and changed the loader APIs, but it is the same jump Google's internal code has to make before #190076 can land. If a package is abandoned, fork it, apply step 2 to the fork, and point a `dependency_overrides` entry at your fork. Verify: the script prints no lines for third-party packages.

6. **Rewrite diagnostics to use `EnumProperty`.**
   A common use inside widgets and render objects was `debugFillProperties`. A mechanical `.name` rewrite compiles, but the typed property is better:

   ```dart
   // Flutter 3.47.4, Dart 3.13
   // Before
   properties.add(StringProperty('choice', describeEnum(choice)));

   // After
   properties.add(EnumProperty<ThemeChoice>('choice', choice));
   ```

   The output is slightly different. `StringProperty` quotes its value, so DevTools and `toStringDeep()` showed `choice: "dark"`, while `EnumProperty` prints `choice: dark`. If you have golden tests over `toStringDeep()` or `debugDescribeChildren`, update them. Since Flutter 3.16, `EnumProperty<T>` requires `T extends Enum?`, so for an enum-like class use `DiagnosticsProperty<Channel>` instead. Verify: diagnostics tests pass after regenerating their expected strings.

7. **Stop the deprecation from coming back.**
   `deprecated_member_use` is `info` by default, which is why these calls survived three years of deprecation. Promote it in `analysis_options.yaml`:

   ```yaml
   # Flutter 3.47.4
   include: package:flutter_lints/flutter.yaml

   analyzer:
     exclude:
       - build/**
       - android/**
     errors:
       deprecated_member_use: error
   ```

   Merge `errors:` into your existing `analyzer:` block. When I appended a second top-level `analyzer:` key instead, the analyzer did not complain and kept reporting `info`, so the promotion looked applied and was not. With the merged block, `flutter analyze --no-fatal-infos` reports `error` and exits with code 1. Be aware this promotes every deprecation, not only `describeEnum`. If that is too much for one PR, keep it at `warning` and fail CI with `--fatal-warnings`. Verify: add a `describeEnum` call to a scratch file and confirm CI fails.

## Verification

I ran the before and after versions of every pattern above side by side in one `flutter test` on Flutter 3.47.4:

| Pattern | `describeEnum` result | Migrated result |
| ------- | --------------------- | --------------- |
| Plain enum | `dark` | `dark` |
| Enhanced enum with `toString()` override | `high` | `high` |
| Enum-like class | `beta` | `beta` |
| Nullable, value `null` | `null` | `null` |
| Tear-off over `values` | `[light, dark]` | `[light, dark]` |
| `Object`-typed enum value | `light` | `light` |
| JSON round trip | `ThemeChoice.dark` | `ThemeChoice.dark` |
| Unknown JSON value | `StateError` | `ArgumentError` |
| `debugFillProperties` | `choice: "dark"` | `choice: dark` |

After the migration, the checklist is short: `flutter analyze` is clean with `deprecated_member_use: error`, the dependency scan prints nothing for third-party packages, and the test suite passes. For extra certainty, check out a Flutter branch with #190076 applied and run `flutter test`. That is how the error messages above were captured.

## Rollback plan

There is nothing to roll back in your own code: `.name` and `values.byName` work on every Flutter version since 3.0, so the migrated code runs on the SDK you have today and on every SDK after the removal. The only step that can hurt is a major package upgrade in step 5. Do it in its own commit, so you can revert the `pubspec.yaml` and `pubspec.lock` change on its own while keeping your `describeEnum` cleanup.

## Gotchas

- **`dart fix` will not help.** Unlike most Flutter deprecations, `describeEnum` has no data-driven fix in `packages/flutter/lib/fix_data`, and the removal guide states that the migration is not supported by `dart fix`. If you run a repo-wide `dart fix` pass for other migrations, this one stays manual.
- **Do not replace `describeEnum(e)` with `e.toString().split('.').last`.** It is the most common Stack Overflow answer, and it is wrong for enhanced enums that override `toString()`: `Level.high.toString().split('.').last` returns `Level(H)`.
- **Generated code.** If a hit from step 1 lives in a `.g.dart` or `.freezed.dart` file, fix the generator (upgrade it, or change your template) and regenerate. Editing the output by hand only lasts until the next `build_runner` run.
- **The docs say 3.47, the SDK does not.** If a reviewer points at the breaking-changes index and asks why 3.47.4 still compiles, it is because the guide was merged before the code change. Track #190076 for the real date. The guide's own "Landed in version" field still says TBD.

## Related

- If you have a stack of Flutter deprecations to clear at once, [running `dart fix` across a whole repo](/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/) handles everything that does have a data-driven fix.
- Another deprecation that needs a manual rewrite: [replacing the deprecated `Radio` `groupValue` and `onChanged` with `RadioGroup`](/2026/08/how-to-replace-flutter-deprecated-radio-groupvalue-and-onchanged-with-radiogroup/).
- The bigger dependency-graph migration coming to every Flutter app: [moving to the standalone `material_ui` and `cupertino_ui` packages](/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/).
- If your enum parsing sits inside JSON decoding, [fixing `FormatException: Unexpected character` in Dart](/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/) covers the other half of that code path.

## Sources

- [flutter/flutter#190076: Remove deprecated `describeEnum` from framework](https://github.com/flutter/flutter/pull/190076)
- [flutter/flutter#125016: Deprecate `describeEnum`](https://github.com/flutter/flutter/pull/125016)
- [Flutter breaking change: Remove describeEnum](https://docs.flutter.dev/release/breaking-changes/remove-describeEnum)
- [Flutter breaking change: Migration guide for describeEnum and EnumProperty](https://docs.flutter.dev/release/breaking-changes/describe-enum)
- [`describeEnum` API reference](https://api.flutter.dev/flutter/foundation/describeEnum.html)
- [`EnumProperty` API reference](https://api.flutter.dev/flutter/foundation/EnumProperty-class.html)
- [Dart language: Enumerated types](https://dart.dev/language/enums)
- [Dart SDK changelog, 2.15.0](https://github.com/dart-lang/sdk/blob/main/CHANGELOG.md)
- [flutter_svg on pub.dev](https://pub.dev/packages/flutter_svg)
