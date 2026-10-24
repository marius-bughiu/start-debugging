---
title: "What is the depend_on_referenced_packages lint in Dart and why does it fire on transitive imports?"
description: "depend_on_referenced_packages fires when a file imports or exports a package that is not listed in your own pubspec.yaml, even if it resolves through another dependency. Here is exactly what the rule checks on Dart 3.12.2 and Flutter 3.44.8, why transitive imports are a real bug, and how to fix each variant."
pubDate: 2026-10-24
tags:
  - "dart"
  - "flutter"
  - "lints"
  - "pub"
  - "pubspec"
---

**Short answer:** `depend_on_referenced_packages` reports any `import` or `export` of `package:foo/...` where `foo` is not listed in the importing package's own `pubspec.yaml`. It does not care that `foo` resolves fine because one of your dependencies pulls it in: a transitive package is something you are borrowing, with a version you do not control and a presence you cannot guarantee. Fix it by declaring the package yourself (`dart pub add foo` or `flutter pub add foo`), under `dependencies` if the import lives in `lib/`, `bin/`, `hook/build.dart` or `hook/link.dart`, and under `dev_dependencies` only if it lives anywhere else, such as `test/` or `tool/`. Everything below was measured on Dart 3.12.2 and Flutter 3.44.8 with `lints` 6.1.0 and `flutter_lints` 6.0.0.

The rule has been around since Dart 2.14 and is part of the **core** set in [`package:lints`](https://pub.dev/packages/lints), which means `lints/recommended.yaml` and `flutter_lints` both turn it on. Most people meet it the first time they type `import 'package:collection/collection.dart';` in a fresh Flutter app and get a blue squiggle on a line that compiles and runs perfectly.

## Why a working import still gets flagged

When you run `flutter pub get`, pub resolves the whole dependency graph and writes every package in it to `.dart_tool/package_config.json`. The compiler and the analyzer resolve `package:` URIs through that file, and it contains your transitive dependencies too. That is why `package:http_parser` resolves in a project that only depends on `http`: `http` depends on `http_parser`, so it is in the package config.

The import works today by accident. Three things can break it later, and none of them show up in your diff:

1. **The intermediary drops it.** If `http` 2.0 stops depending on `http_parser`, your next `pub upgrade` removes it from the graph and your build fails with `Target of URI doesn't exist`. Nothing in your `pubspec.yaml` changed.
2. **You never chose the version.** Your code is written against whatever `http_parser` version `http`'s constraint happened to allow. A major bump in the transitive package that `http` tolerates is a breaking change for you with no constraint of yours to stop it.
3. **Your consumers do not get it.** If you publish a package, users resolve their own graph. Dev dependencies are never transitive, so anything your `lib/` code imports from a dev dependency simply does not exist for them.

The lint turns those three latent failures into one visible info diagnostic at the import site. The [official rule page](https://dart.dev/tools/linter-rules/depend_on_referenced_packages) summarizes it as "Depend on referenced packages", and the reasoning is that an explicit dependency is the only way to both guarantee the package is there and put your own version constraint on it.

## What the rule actually checks

The implementation is short and worth reading: [`pkg/linter/lib/src/rules/pub/depend_on_referenced_packages.dart`](https://github.com/dart-lang/sdk/blob/main/pkg/linter/lib/src/rules/pub/depend_on_referenced_packages.dart) in the Dart SDK. For each library it builds a list of allowed package names:

- the package's own `name` (so `package:my_app/...` self-imports are always fine),
- every key under `dependencies`,
- every key under `dev_dependencies`, **but only if the file is not in a public location**.

A file counts as public when it is inside `lib/` or `bin/`, or is exactly `hook/build.dart` or `hook/link.dart` (the native-assets build hooks, added after [dart-lang/sdk#54334](https://github.com/dart-lang/sdk/issues/54334)). Then it visits every `import` and `export` directive, takes the first path segment after `package:`, and reports it if the name is not in the allowed list.

A few consequences fall straight out of that code:

- `dependency_overrides` are not consulted. A package that only appears there is still "not a dependency".
- `export` directives are checked exactly like imports.
- Only the main URI of a directive is checked, not the URIs inside conditional `if (dart.library.io) ...` clauses.
- The only hard-coded exemption is `flutter_gen`, the old synthetic localization package (see [dart-lang/linter#3308](https://github.com/dart-lang/linter/issues/3308)).
- There is no root-package or workspace inheritance. Each package is checked against its own pubspec.

## A repro that triggers every variant

Here is a small pure-Dart package that depends only on `http` and keeps `meta` as a dev dependency:

```yaml
# pubspec.yaml -- Dart 3.12.2
name: repro
version: 1.0.0

environment:
  sdk: ^3.12.0

dependencies:
  http: ^1.6.0

dev_dependencies:
  lints: ^6.1.0
  meta: ^1.18.0

dependency_overrides:
  path: ^1.9.1
```

```yaml
# analysis_options.yaml
include: package:lints/recommended.yaml
```

```dart
// lib/repro.dart -- Dart 3.12.2
import 'package:http/http.dart' as http;          // declared: OK
import 'package:http_parser/http_parser.dart';   // transitive via http: LINT
import 'package:meta/meta.dart';                 // dev_dependency in lib/: LINT
import 'package:repro/src/helpers.dart';         // self package: OK
export 'package:async/async.dart' show Result;   // transitive export: LINT

@immutable
class Probe {
  const Probe();

  Future<MediaType> contentType(Uri uri) async {
    final response = await http.head(uri);
    return MediaType.parse(response.headers['content-type'] ?? 'text/plain');
  }
}

final helper = helperValue;
```

Add the same `import 'package:meta/meta.dart';` to `bin/repro.dart`, `hook/build.dart`, `tool/gen.dart` and `test/repro_test.dart`, import `package:http_parser` from the test too, and import `package:path` (override only) from `lib/src/over.dart`. `dart analyze` reports:

```text
info - bin/repro.dart:1:8 - The imported package 'meta' isn't a dependency of the importing package. ... - depend_on_referenced_packages
info - hook/build.dart:1:8 - The imported package 'meta' isn't a dependency of the importing package. ... - depend_on_referenced_packages
info - lib/repro.dart:2:8 - The imported package 'http_parser' isn't a dependency of the importing package. ... - depend_on_referenced_packages
info - lib/repro.dart:3:8 - The imported package 'meta' isn't a dependency of the importing package. ... - depend_on_referenced_packages
info - lib/repro.dart:5:8 - The imported package 'async' isn't a dependency of the importing package. ... - depend_on_referenced_packages
info - lib/src/over.dart:1:8 - The imported package 'path' isn't a dependency of the importing package. ... - depend_on_referenced_packages
info - test/repro_test.dart:2:8 - The imported package 'http_parser' isn't a dependency of the importing package. ... - depend_on_referenced_packages
```

Note what is missing: `tool/gen.dart` and the `meta` import in `test/` are clean, because dev dependencies are allowed outside public locations. Note also that the message is the same whether the package is absent or merely in the wrong section. "Isn't a dependency" can mean "it is a dev dependency, and this file is public".

## The Flutter version of the same thing

In a Flutter app the transitive packages you are most likely to import by accident are the ones the SDK itself depends on: `collection`, `meta`, `vector_math`, `characters`, `material_color_utilities`. They are always in the graph because `flutter` needs them. A new `flutter create --empty` app with this file:

```dart
// lib/probe.dart -- Flutter 3.44.8
import 'package:collection/collection.dart';
import 'package:meta/meta.dart';
import 'package:vector_math/vector_math_64.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
```

gets four `depend_on_referenced_packages` infos. `flutter_localizations` also gets a hard `uri_does_not_exist` error, because it is a separate SDK package that is not in the graph until you ask for it. The lint is the friendlier of the two diagnostics, but the underlying problem is identical.

## How to fix it, case by case

1. **Transitive package imported from `lib/`.** Declare it as a regular dependency. Let pub pick the constraint instead of guessing:

   ```bash
   # Flutter 3.44.8
   flutter pub add collection meta vector_math
   ```

   ```yaml
   dependencies:
     collection: ^1.19.1
     flutter:
       sdk: flutter
     meta: ^1.18.0
     vector_math: ^2.2.0
   ```

2. **SDK package such as `flutter_localizations`.** These need the `sdk: flutter` form, which `pub add` accepts as a JSON descriptor:

   ```bash
   flutter pub add 'flutter_localizations:{"sdk":"flutter"}'
   ```

3. **Dev dependency imported from `lib/`, `bin/` or a build hook.** Either move it to `dependencies` (`dart pub add meta` moves it for you), or move the importing code out of the public directory. For annotation-only packages like `meta`, moving it to `dependencies` is the right call: a published package with `@immutable` in `lib/` does not compile for consumers otherwise.

4. **Package that only exists in `dependency_overrides`.** An override changes the version of something that is already in the graph; it does not declare a dependency. Add a normal entry as well, and keep the override if you still need it.

5. **Package exported from your library.** Same fix as an import. If you re-export `package:async`'s `Result`, your public API now depends on `async`'s version, which is exactly why you want your own constraint on it.

There is no `dart fix` for this rule; on the repro, `dart fix --dry-run` reports "Nothing to fix!". The IDE quick fix adds the package to `pubspec.yaml`, and `pub add` does the same thing from the terminal.

## Gotchas and edge cases

### The Flutter SDK pins your constraint

Packages like `meta` and `collection` are pinned to exact versions by `flutter` and `flutter_test`. If you write a constraint above the pinned version, resolution fails:

```text
Note: meta is pinned to version 1.18.0 by flutter_test from the flutter SDK.

Because every version of flutter_test from sdk depends on meta 1.18.0 and fapp depends on meta ^1.19.0, flutter_test from sdk is forbidden.
So, because fapp depends on flutter_test from sdk, version solving failed.
```

That is why `flutter pub add` is better than typing the constraint by hand: it picks the version that satisfies the pin. If you already hit this error, the walkthrough in [fixing "version solving failed" in pubspec.yaml](/2026/05/fix-version-solving-failed-in-pubspec-yaml/) covers how to read the solver output. Expect your `pubspec.lock` to churn when you later change Flutter versions, since the pins move with the SDK; [this pubspec.lock explainer](/2026/10/fix-pubspec-lock-modified-after-flutter-upgrade-or-switching-flutter-versions/) covers why.

### Pub workspaces do not inherit dependencies

With a Dart 3.6+ pub workspace, all members share one resolution and one `package_config.json`, so a member can import anything any other member depends on. The lint does not allow that. A root `pubspec.yaml` with `http` in its `dependencies` and a member `pkgs/app` with `resolution: workspace` and no dependencies still produces:

```text
info - pkgs/app/lib/app.dart:1:8 - The imported package 'http' isn't a dependency of the importing package. ... - depend_on_referenced_packages
```

This is the behavior you want in a monorepo. Shared resolution makes accidental cross-package borrowing easy, and the lint is the thing that stops a package from silently relying on a sibling's dependency list. If the analysis server is slow in a big workspace, that is a separate problem, see [speeding up the Dart analysis server in a large Flutter monorepo](/2026/09/how-to-speed-up-a-slow-dart-analysis-server-in-vs-code-for-a-large-flutter-monorepo/).

### Conditional imports slip through

The rule only checks a directive's primary URI. This passes the lint even though `path` is not declared:

```dart
// lib/src/cond.dart -- Dart 3.12.2
import 'package:repro/src/helpers.dart'
    if (dart.library.io) 'package:path/path.dart';
```

`dart pub publish --dry-run` did not flag it either on Dart 3.12.2. Treat platform-conditional imports as something to check by hand in review.

### `dart pub publish` enforces the same rule as an error

For published packages, pub's own validator runs a stricter version of this check. On the repro, `dart pub publish --dry-run` turned the lib, bin and hook findings into hard errors:

```text
* line 3, column 1 of lib/repro.dart: meta is in the `dev_dependencies` section of `pubspec.yaml`. Packages used in lib/ must be declared in the `dependencies` section.
* line 2, column 1 of lib/repro.dart: This package does not have http_parser in the `dependencies` section of `pubspec.yaml`.
```

The `test/` finding comes back only as a warning. So ignoring the lint in a package you publish just moves the failure to release day.

### `flutter_gen` is exempt, but it is going away

The `flutter_gen` exemption exists because `flutter gen-l10n` used to generate a synthetic package that could not appear in any pubspec. Flutter has deprecated that synthetic package (see the [breaking-change notice](https://docs.flutter.dev/release/breaking-changes/flutter-generate-i10n-source)); the generated localizations now live in your own source tree and are imported through your own package name, which the lint already allows.

### Do not silence it for "just one dev package"

A common request is to whitelist a dev-only annotation package in `analysis_options.yaml`. [dart-lang/sdk#60026](https://github.com/dart-lang/sdk/issues/60026) asked for exactly that and was closed without the feature. The maintainer's answer was that a package imported from `lib/` is a real dependency, and `// ignore:` comments are available if you insist. If you really must, scope the suppression to the line rather than the project:

```dart
// ignore: depend_on_referenced_packages
import 'package:meta/meta.dart';
```

Turning the rule off globally (`depend_on_referenced_packages: false` under `linter: rules:`) also turns off the only early warning you get before pub or a consumer's build fails. Lint configuration in general is easier to reason about once you know exactly where each rule looks; the [unawaited_futures vs discarded_futures comparison](/2026/10/unawaited-futures-vs-discarded-futures-lint-in-dart/) is a good example of two rules whose scopes are narrower than their names suggest.

## Read next

- [Fix: Version solving failed in pubspec.yaml](/2026/05/fix-version-solving-failed-in-pubspec-yaml/)
- [Fix: pubspec.lock shows as modified after flutter upgrade or switching Flutter versions](/2026/10/fix-pubspec-lock-modified-after-flutter-upgrade-or-switching-flutter-versions/)
- [unawaited_futures vs discarded_futures in Dart](/2026/10/unawaited-futures-vs-discarded-futures-lint-in-dart/)
- [How to run dart fix across a whole repo to apply Flutter breaking-change migrations](/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/)
- [How to speed up a slow Dart analysis server in VS Code for a large Flutter monorepo](/2026/09/how-to-speed-up-a-slow-dart-analysis-server-in-vs-code-for-a-large-flutter-monorepo/)

## Sources

- [depend_on_referenced_packages rule page](https://dart.dev/tools/linter-rules/depend_on_referenced_packages) and [diagnostic page](https://dart.dev/tools/diagnostics/depend_on_referenced_packages)
- [Rule implementation in dart-lang/sdk](https://github.com/dart-lang/sdk/blob/main/pkg/linter/lib/src/rules/pub/depend_on_referenced_packages.dart) and [its tests](https://github.com/dart-lang/sdk/blob/main/pkg/linter/test/rules/depend_on_referenced_packages_test.dart)
- [package:lints core rule set](https://pub.dev/packages/lints)
- [dart-lang/sdk#60026: exempting dev dependencies](https://github.com/dart-lang/sdk/issues/60026)
- [dart-lang/linter#3308: flutter_gen exemption](https://github.com/dart-lang/linter/issues/3308)
- [SDK version pinning](https://dart.dev/go/sdk-version-pinning)
- [Flutter breaking change: flutter generate l10n source](https://docs.flutter.dev/release/breaking-changes/flutter-generate-i10n-source)
