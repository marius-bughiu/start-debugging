---
title: "Fix: Version solving failed in pubspec.yaml"
description: "The fix in 30 seconds: read the 'because' chain in the error, find the one constraint that boxes pub in, and either widen it or add a dependency_overrides entry. Do not start with flutter clean."
pubDate: 2026-05-17
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "pub"
  - "pubspec"
---

The fix in one breath: `Version solving failed` is not a bug, it is `dart pub` telling you that the constraints you wrote in `pubspec.yaml` cannot all be satisfied at the same time. Read the chain of `because ... depends on ...` lines from bottom to top, find the single constraint that is impossible to satisfy (usually a Dart SDK lower bound or a package pinned to a version older than what one of its consumers needs), then either widen that constraint or add a `dependency_overrides` entry to force a specific version. `flutter clean` and deleting `pubspec.lock` will not fix this.

```text
Resolving dependencies...
Because every version of flutter_test from sdk depends on collection 1.19.0
        and my_app depends on collection ^1.18.0, flutter_test from sdk is forbidden.
So, because my_app depends on flutter_test any from sdk, version solving failed.

pub get failed (1; So, because my_app depends on flutter_test any from sdk,
version solving failed.)
exit code 1
```

This guide is written against Dart 3.11 and Flutter 3.41.5, the stable channel as of May 2026. The resolver behaviour described below is the same `PubGrub` algorithm that has shipped in `dart pub` since Dart 2.10, so everything here applies cleanly to any Flutter 3.x or Dart 3.x project. The relevant source lives in [dart-lang/pub](https://github.com/dart-lang/pub) under `lib/src/solver/`.

## What the error actually means

`dart pub get` runs a SAT-style solver called [PubGrub](https://github.com/dart-lang/pub/blob/master/doc/solver.md). It walks every constraint in your `pubspec.yaml`, including transitive constraints pulled from each dependency's own `pubspec.yaml`, and tries to find a single set of package versions where every constraint is satisfied at once. When no such set exists, it does not give up after one attempt. It backtracks, learns a fact about which combinations are impossible, and retries. The output you see is the **explanation** of the proof that no solution exists.

Each line is one fact. Read from bottom to top: the bottom line is the conclusion (`version solving failed`), and the lines above it are the chain of facts that forced that conclusion. The fact at the top of the chain is the constraint you actually wrote and probably the one you need to change.

The error message is structured. Pub names every relevant package, prints the exact constraint, and tells you who is asking for it. There is no guessing once you slow down and read it.

## A minimal repro that demonstrates the failure

Create a fresh package and pin two dependencies whose transitive constraints contradict each other:

```yaml
# pubspec.yaml, Flutter 3.41.5, Dart 3.11
name: my_app
environment:
  sdk: '>=2.17.0 <3.0.0'

dependencies:
  flutter:
    sdk: flutter
  http: ^1.5.0
  some_legacy_package: 0.4.2
```

Run `flutter pub get` and you get:

```text
Because http >=1.0.0 requires SDK version >=3.0.0 <4.0.0
        and my_app requires SDK version >=2.17.0 <3.0.0, http >=1.0.0 is forbidden.
So, because my_app depends on http ^1.5.0, version solving failed.
```

This is the most common shape of the error in real projects. The constraint that breaks the resolution is your own SDK lower bound. The package you asked for is fine; the SDK you said you support is the impossible part.

A second common shape is a transitive collision:

```text
Because flutter_test from sdk depends on collection 1.19.0
        and riverpod 3.0.0 depends on collection ^1.18.0,
        flutter_test from sdk is incompatible with riverpod 3.0.0.
So, because my_app depends on both flutter_test from sdk and riverpod ^3.0.0,
version solving failed.
```

Same algorithm, different cause. Here the SDK pin from `flutter_test` is exact (`1.19.0`), and `riverpod` will accept anything from `1.18.0` up to but not including `2.0.0`. Both can be satisfied if you upgrade `riverpod` to a version whose `collection` lower bound is `1.19.0` or higher. The fix is in the version you pick, not in the constraint syntax.

## Fix, in order of how often it is the answer

Run the steps below in order. Do not skip ahead. Each step assumes the previous one did not resolve the error.

### 1. Read the error and identify the choke point

Open the terminal output. Find the first `Because ...` line and the constraint named at the very top of the chain. That is the impossible fact. In the SDK example above it is `my_app requires SDK version >=2.17.0 <3.0.0`. In the transitive example it is `flutter_test from sdk depends on collection 1.19.0`.

Write down two things:

1. The package whose constraint cannot be satisfied (the **victim**).
2. The constraint that boxes it in (the **culprit**).

If you cannot identify both, you have not read the chain carefully enough. Re-read it.

### 2. Upgrade your SDK lower bound

In 2026, the most common cause is a stale SDK constraint. Any package published in the last 18 months that uses Dart 3 features (records, patterns, sealed classes, the new `switch` expressions) will set its SDK constraint to `^3.0.0`. If your `pubspec.yaml` still says `>=2.17.0 <3.0.0`, you cannot install that package. Update to caret syntax against the Dart version you actually have:

```yaml
# pubspec.yaml, after running `dart --version`
environment:
  sdk: ^3.0.0
  flutter: '>=3.10.0'
```

Use `^3.0.0` (everything from 3.0.0 up to but not including 4.0.0), not `^3.11.0`. The lower bound communicates "this is the oldest Dart I tested against"; setting it equal to the version on your laptop forces every contributor to upgrade for no reason. See the [pubspec docs](https://dart.dev/tools/pub/pubspec) for the syntax.

### 3. Upgrade the conflicting dependency

If the culprit is a third-party package, the second-most-common fix is that you are pinned to an old major version. `flutter pub outdated` shows you every dependency, what version is resolved, and what the latest is:

```bash
# Flutter 3.41.5
flutter pub outdated
```

Look for the package named in step 1. If its **latest** column is higher than what you have, run:

```bash
flutter pub upgrade --major-versions <package_name>
```

This rewrites the constraint in `pubspec.yaml` to the latest compatible major version, then re-runs the solver. If the package follows semver, you may have to fix breaking changes in your code, but the resolver error goes away.

### 4. Loosen an over-tight constraint

If you wrote a constraint by hand and pinned it tighter than needed, widen it. The two most common over-pinning mistakes:

```yaml
# Too tight: exact pin
some_package: 1.5.3

# Too tight: caret on a pre-1.0 version
some_package: ^0.4.2  # allows >=0.4.2 <0.5.0, often too narrow
```

Replace with a caret on the major version (`^1.5.3` allows `>=1.5.3 <2.0.0`) or with an explicit range that covers the versions you are willing to accept (`'>=0.4.0 <0.6.0'`). The [Dart docs on dependency constraints](https://dart.dev/tools/pub/dependencies) explain caret syntax for both pre-1.0 and post-1.0 packages.

### 5. Use `dependency_overrides` for transitive conflicts you cannot fix

When the culprit is a transitive dependency that two of your direct dependencies disagree on, and neither has a release that resolves the conflict, override it explicitly. This belongs in the root package's `pubspec.yaml` only; overrides in a dependency you consume are ignored by the resolver.

```yaml
# pubspec.yaml, Flutter 3.41.5, Dart 3.11
name: my_app
environment:
  sdk: ^3.0.0

dependencies:
  flutter:
    sdk: flutter
  riverpod: ^3.0.0
  some_other_package: ^2.0.0

dependency_overrides:
  collection: ^1.19.0
```

`dependency_overrides` is a sledgehammer. The resolver stops enforcing constraints on the overridden package and uses your version everywhere it appears in the graph. If a consumer of `collection` relied on a removed API in `1.19.0`, it will compile but fail at runtime. Use this only after you have verified that the version you are forcing is actually compatible, and remove the override the moment the upstream dependency catches up.

### 6. Last resort: regenerate `pubspec.lock`

The lockfile is downstream of resolution, not upstream. Deleting it cannot fix a constraint problem and most blog posts that recommend it as the first step are wrong. The only time deleting `pubspec.lock` helps is if you already changed `pubspec.yaml` and the lockfile is now blocking the resolver from picking a new compatible version:

```bash
# Flutter 3.41.5
rm pubspec.lock
flutter pub get
```

Do this only after step 1 through step 5. If `pub get` still fails after regenerating the lockfile, the constraints are still impossible and you have not actually fixed anything.

## Gotchas and lookalikes

A few cases that produce a similar error or look like version solving but are not:

- **`pub get failed (server unavailable)`**: this is a network or registry problem, not a resolution problem. Check `PUB_HOSTED_URL` if you set it; an incorrect mirror URL will return 404s and the failure surfaces close to but not as `version solving failed`.
- **`The current Dart SDK version is X.Y.Z. Because my_app requires SDK version ^A.B.C, version solving failed.`**: this is the most direct form of the error. You ran `flutter pub get` with a Dart SDK older than what your own `pubspec.yaml` declares. Either upgrade Flutter (`flutter upgrade`) or lower the constraint.
- **`pub get` succeeds locally but fails on CI**: your CI Flutter version is older than your local one. Pin the Flutter version in CI to match. The [how to target multiple Flutter versions from one CI pipeline](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) post covers the matrix pattern.
- **`Gradle build failed to produce an .apk file` right after a `pub get`**: not a resolver error at all. The native build stage is failing. See [Gradle build failed to produce an apk file](/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/) (the same fix applies to Flutter Android).
- **Pre-release versions are silently ignored**: by default the resolver will not pick `2.0.0-beta.1` when you ask for `^1.0.0`, even if there is no stable `2.0.0`. To opt in, use the explicit version: `some_package: ^2.0.0-beta.1`.
- **A package with `git:` or `path:` dependencies**: the resolver still applies version constraints but the source is the git ref or path you wrote, not pub.dev. A failing version solve on a git dependency is almost always because the referenced branch's `pubspec.yaml` is itself broken; clone the package locally and run `dart pub get` inside it to see.

If you are reaching `dependency_overrides` more than once a quarter, your dependency tree has structural problems. Either you are using too many packages from the same micro-domain (three HTTP clients, two state managers), or your direct dependencies are not keeping up with their own transitive ones. Trimming the tree fixes more resolver errors than any single constraint edit.

## Related

- [Fix: FormatException: Unexpected character when parsing JSON in Dart](/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/)
- [Fix: A RenderFlex overflowed by N pixels in Flutter](/2026/05/fix-renderflex-overflowed-in-flutter/)
- [How to target multiple Flutter versions from one CI pipeline](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)
- [How to write a Dart isolate for CPU-bound work](/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/)
- [How to profile jank in a Flutter app with DevTools](/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/)

## Sources

- [The pubspec file](https://dart.dev/tools/pub/pubspec) (dart.dev)
- [Package dependencies](https://dart.dev/tools/pub/dependencies) (dart.dev)
- [PubGrub solver design doc](https://github.com/dart-lang/pub/blob/master/doc/solver.md) (dart-lang/pub)
- [dart-lang/pub issue 2470: "version solving failed"](https://github.com/dart-lang/pub/issues/2470) (canonical bug report thread)
- [dart-lang/pub issue 3755: SDK version constraint edge cases](https://github.com/dart-lang/pub/issues/3755)
