---
title: "Fix: pubspec.lock shows as modified after flutter upgrade or switching Flutter versions"
description: "The Flutter SDK pins versions of meta, vector_math, test_api and matcher, so every SDK change re-resolves your lockfile, and flutter upgrade runs pub upgrade on the project you stand in. Pin one Flutter version per repo and enforce the lockfile in CI."
pubDate: 2026-10-13
template: error-page
tags:
  - "errors"
  - "flutter"
  - "flutter-3-47"
  - "dart"
  - "pub"
---

Your `pubspec.lock` changes because the Flutter SDK is itself a dependency with its own version pins. `flutter` and `flutter_test` require exact versions of packages like `meta`, `vector_math`, `test_api` and `matcher`, so a different SDK forces pub to re-resolve them, and the `flutter run` or `flutter build` that follows an SDK switch runs `pub get` for you. On top of that, `flutter upgrade` runs `pub upgrade` on whatever project you are standing in. The fix: pin one Flutter version per repo (FVM plus an `environment: flutter:` constraint), commit the lockfile change from an SDK bump on its own, and run `flutter pub get --enforce-lockfile` in CI. Everything below was measured on Flutter 3.44.8 (Dart 3.12.2) and Flutter 3.47.7 (Dart 3.13.5) on 2026-10-13.

## The symptom in context

You did not touch `pubspec.yaml`. You ran `flutter upgrade`, switched channels, or a teammate on a different Flutter version pushed, and now `git status` shows this:

```text
 M pubspec.lock
```

The diff only touches transitive packages you never added yourself:

```diff
   meta:
     dependency: transitive
     description:
       name: meta
-      sha256: "1741988757a65eb6b36abe716829688cf01910bbf91c34354ff7ec1c3de2b349"
+      sha256: "307249ce4ff29d58a18e97f6345f539382eb9c9c29ecda628900f31de0443dd9"
       url: "https://pub.dev"
     source: hosted
-    version: "1.18.0"
+    version: "1.19.0"
```

Switch back to the old SDK and run anything that triggers `pub get`, and the diff flips the other way. On a team with mixed Flutter versions, the lockfile ping-pongs in every pull request.

## Why this happens

There are three separate mechanisms, and most teams hit all three.

**1. The Flutter SDK pins its own dependencies.** `packages/flutter/pubspec.yaml` and `packages/flutter_test/pubspec.yaml` in the SDK list exact versions. Your app depends on both through `sdk: flutter`, so their pins become constraints on your resolution. When the SDK changes, the pins change, the versions in your lockfile no longer satisfy them, and pub has to pick new ones. Here are the relevant lines from the two SDKs I tested:

| Package | Flutter 3.44.8 | Flutter 3.47.7 |
| --- | --- | --- |
| `meta` | `1.18.0` | `^1.18.3` |
| `vector_math` | `2.2.0` | `^2.4.0` |
| `test_api` | `0.7.11` | `0.7.12` |
| `matcher` | `0.12.19` | `0.12.20` |
| `material_color_utilities` | `0.13.0` | `0.13.0` |
| `collection` | `1.19.1` | `^1.19.1` |

Flutter 3.47 is the first stable release with [PR #185268, "Unpin sdk package dependencies"](https://github.com/flutter/flutter/pull/185268), which closed the long-standing issue [#158050, "Stop pinning dependencies"](https://github.com/flutter/flutter/issues/158050). Most pins became caret ranges. `test_api` and `matcher` stay exact because the SDK imports their `src/` libraries, and `material_color_utilities` is still pinned too (the PR description explains both). So even on 3.47 and later, every Flutter release that bumps `test_api` or `matcher` rewrites those lockfile entries.

**2. Flutter runs `pub get` behind your back after an SDK switch.** `flutter run`, `flutter build`, `flutter test` and friends call `pub get` before doing anything else. The Flutter tool only skips it when `.dart_tool/version` matches the current framework version and `pubspec.yaml` is older than both `pubspec.lock` and `.dart_tool/package_config.json`. The check is in `packages/flutter_tools/lib/src/dart/pub.dart`. So the first `flutter run` after switching SDKs always re-resolves, and the lockfile changes even though you never typed `pub`.

**3. `flutter upgrade` runs `pub upgrade` on your project.** This is the one most people miss. After upgrading the SDK, `UpgradeCommand.updatePackages` looks for a `pubspec.yaml` in the current directory or any parent, and if it finds one it calls `pub.get(..., upgrade: true)` on that project. That is `pub upgrade`, not `pub get`, so it moves *every* dependency to the newest version your constraints allow, including packages that have nothing to do with the SDK. The code has done this since at least Flutter 3.0.0.

## Minimal repro

Create a project on the older SDK, commit it, then resolve it with the newer one. I kept both SDKs side by side: Homebrew's Flutter 3.44.8 and the 3.47.7 stable zip unpacked into a scratch folder.

```bash
# Flutter 3.44.8 (Dart 3.12.2) creates and locks the project
flutter create -e --platforms=android app
cd app
flutter pub add http shared_preferences intl
git init -q && git add -A && git commit -qm base

# Same project, Flutter 3.47.7 (Dart 3.13.5)
~/sdks/flutter-3.47.7/bin/flutter pub get
git diff --stat
```

Output on 3.47.7:

```text
Resolving dependencies...
Downloading packages...
  clock 1.1.2 (1.1.3 available)
> matcher 0.12.20 (was 0.12.19)
  material_color_utilities 0.13.0 (0.13.1 available)
> meta 1.19.0 (was 1.18.0)
  stack_trace 1.12.1 (1.12.2 available)
> test_api 0.7.12 (was 0.7.11) (0.7.15 available)
> vector_math 2.4.3 (was 2.2.0)
Changed 4 dependencies!
Upgrading analysis_options.yaml to exclude build and platform directories.
 analysis_options.yaml |  4 ++++
 pubspec.lock          | 16 ++++++++--------
 2 files changed, 12 insertions(+), 8 deletions(-)
```

Four packages moved, all of them SDK pins or former SDK pins. `http`, `shared_preferences` and `intl` stayed exactly where they were: plain `pub get` keeps every locked version it can. Note the bonus file change. Flutter 3.47 ships an `AnalysisOptionsMigration` that adds `build/**` and one `<platform>/**` exclude per platform folder to `analysis_options.yaml` the first time it runs `pub get` in your project. That is a one-time edit, and you should commit it with the lockfile.

Now go back to 3.44.8:

```text
< matcher 0.12.19 (was 0.12.20) (0.12.20 available)
< meta 1.18.0 (was 1.19.0) (1.19.0 available)
< test_api 0.7.11 (was 0.7.12) (0.7.15 available)
< vector_math 2.2.0 (was 2.4.3) (2.4.3 available)
Changed 4 dependencies!
```

That is the ping-pong. Neither SDK accepts the other's lockfile, so whoever ran last wins.

For comparison, `pub upgrade` on 3.47.7 from the same 3.44 lockfile (which is what `flutter upgrade` does for you) changed six packages instead of four, because it also moved `clock` and `stack_trace` to their latest versions. In a real app with a few dozen dependencies, that number is usually much larger.

## Fix, in detail

The goal is not to stop the lockfile from ever changing. It has to change when the SDK changes, because the old resolution is no longer valid. The goal is to make it change once, on purpose, in a commit you can review.

### 1. Commit `pubspec.lock` for apps, and only for apps

The [Dart docs for `pub get`](https://dart.dev/tools/pub/cmd/pub-get) say application packages should check in the lockfile, so every developer and every deployment uses the same versions, while reusable packages should not. If you are looking at churn in a *package* repo, the simplest fix is to stop committing the lockfile there. Everything below assumes an app.

### 2. Pin one Flutter version per repo

The ping-pong only happens when people run different SDKs against the same lockfile. Make the version part of the repo.

With [FVM](https://fvm.app/), `fvm use` writes the version to `.fvmrc` in the project root, and everyone runs `fvm flutter ...` against it:

```bash
# FVM 3.x, Flutter 3.47.7
fvm install 3.47.7
fvm use 3.47.7
git add .fvmrc
```

Then back it up with a Flutter constraint in `pubspec.yaml`, which pub enforces for everyone, FVM or not:

```yaml
# pubspec.yaml, Flutter 3.47.7 / Dart 3.13.5
environment:
  sdk: ^3.13.5
  flutter: ">=3.47.0 <3.48.0"
```

Pub checks both bounds. With the range set to `<3.45.0`, Flutter 3.47.7 refused to resolve at all:

```text
The current Flutter SDK version is 3.47.7.

Because app2 requires Flutter SDK version >=3.0.0 <3.45.0, version solving failed.
Failed to update packages.
```

That error is much better than a silently rewritten lockfile: the teammate on the wrong SDK finds out right away instead of in code review. Expect the `sdks:` block at the bottom of `pubspec.lock` to echo your constraint (`flutter: ">=3.47.0 <3.48.0"`), because pub records the intersection of every SDK constraint in the graph there. That line changes whenever you edit the constraint, which is fine.

If you want CI to follow the same file, the [multi-version CI setup](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) reads the version from `.fvmrc`.

### 3. Upgrade Flutter as its own change, outside the project directory

Because `flutter upgrade` runs `pub upgrade` on the project it finds from your working directory, upgrading from inside a repo mixes two very different changes into one diff: the SDK-driven re-resolution and a full dependency upgrade. Split them:

```bash
# Flutter 3.44.8 -> 3.47.7
cd ~                # no pubspec.yaml here or in any parent directory
flutter upgrade     # upgrades only the SDK

cd ~/src/my_app
flutter pub get     # re-resolves only what the new SDK forces
git add pubspec.lock analysis_options.yaml
git commit -m "Flutter 3.47.7: re-resolve SDK-pinned packages"
```

If you use FVM, you get the same effect for free: `fvm install` and `fvm use` never call `pub upgrade` on your app. When you do want newer packages, run `flutter pub upgrade` deliberately in a second commit, so a regression bisects to either "new SDK" or "new packages", not both. This is the same split I recommend for [the `awaitNotRequired` breakage](/2026/10/fix-undefined-name-awaitnotrequired-material-ui-cupertino-ui-flutter-3-44/), where a retracted package and an SDK mismatch looked like one problem.

### 4. Enforce the lockfile in CI

`--enforce-lockfile` makes `pub get` fail instead of rewriting the lockfile when the committed resolution is not valid for the current SDK. The docs recommend it for CI and production deployments. Here is the 3.44 lockfile under Flutter 3.47.7:

```text
> matcher 0.12.20 (was 0.12.19)
> meta 1.19.0 (was 1.18.0)
> test_api 0.7.12 (was 0.7.11) (0.7.15 available)
> vector_math 2.4.3 (was 2.2.0)
Would change 4 dependencies.
Unable to satisfy `pubspec.yaml` using `pubspec.lock`.

To update `pubspec.lock` run `flutter pub get` without
`--enforce-lockfile`.
Failed to update packages.
```

The command exits with code 65 and leaves `pubspec.lock` untouched. Put it in front of every build:

```yaml
# GitHub Actions, subosito/flutter-action v2, Flutter 3.47.7
- uses: subosito/flutter-action@v2
  with:
    flutter-version-file: .fvmrc
- run: flutter pub get --enforce-lockfile
- run: flutter build apk --release
```

Now a CI runner on the wrong SDK, or a lockfile that someone forgot to commit after an SDK bump, is a red build with a clear message instead of a green build on versions nobody reviewed. `--enforce-lockfile` also fails if a hosted package's content hash no longer matches the `sha256` recorded in the lockfile, which is a nice supply-chain check on the side.

### 5. Do not fight the diff with `--no-pub`

`flutter run --no-pub` skips the implicit `pub get`, and it does stop the lockfile from changing. It also means you are running the new SDK against a `package_config.json` resolved for the old one. That works until it doesn't, usually as a compile error inside `flutter_test` or a `meta` annotation the new framework expects. Use `--no-pub` for quick experiments, never as the fix.

## Gotchas and lookalikes

**New projects on 3.47+ start at the lower bounds.** Since [PR #175352](https://github.com/flutter/flutter/pull/175352), `flutter create` writes a `pubspec.lock` that locks the SDK's dependencies at the lower end of their new ranges. A fresh 3.47.7 project locks `meta` 1.18.3 and `vector_math` 2.4.0; the first `flutter pub upgrade` moves them to 1.19.0 and 2.4.3. That diff is expected, and it is your choice when to take it.

**Patch releases rarely move the pins.** `flutter_test`'s pubspec is identical across 3.47.0, 3.47.6 and 3.47.7, so a patch upgrade within one minor usually leaves the lockfile alone. Minor releases (3.44 to 3.47) almost always change it. Plan for the diff when you cross a minor version.

**The `sha256` quoting is not churn.** In the diffs above, some hashes are quoted and some are not. Pub quotes any hash that starts with a digit so YAML does not read it as a number. If a hash line changes, it is because the version changed, not the formatting.

**Monorepos with a pub workspace.** With Dart workspaces there is one `pubspec.lock` at the workspace root, and `flutter upgrade` from any member folder walks up and finds a `pubspec.yaml` too. Same rules apply, with a bigger blast radius. If your editor slows down after a re-resolve, see [speeding up the Dart analysis server in a large monorepo](/2026/09/how-to-speed-up-a-slow-dart-analysis-server-in-vs-code-for-a-large-flutter-monorepo/).

**"version solving failed" instead of a diff.** If a package you depend on pins the same package the SDK pins, an SDK switch fails resolution outright instead of quietly rewriting the lockfile. That is a different problem with its own walkthrough: [fixing "version solving failed" in pubspec.yaml](/2026/05/fix-version-solving-failed-in-pubspec-yaml/).

**Engine artifacts are a separate pin.** Pinning the framework version also pins the engine, which matters for reproducible release builds. The background is in [the Flutter 3.38.6 engine version post](/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/).

## Related

- [How to fix "version solving failed" in pubspec.yaml](/2026/05/fix-version-solving-failed-in-pubspec-yaml/)
- [How to target multiple Flutter versions from one CI pipeline](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)
- [Fix: Undefined name 'awaitNotRequired' from material_ui or cupertino_ui on Flutter 3.44](/2026/10/fix-undefined-name-awaitnotrequired-material-ui-cupertino-ui-flutter-3-44/)
- [Flutter 3.38.6 and the engine version bump: reproducible builds get easier if you pin it](/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/)
- [How to speed up a slow Dart analysis server in VS Code for a large Flutter monorepo](/2026/09/how-to-speed-up-a-slow-dart-analysis-server-in-vs-code-for-a-large-flutter-monorepo/)

## Sources

- [dart.dev: `dart pub get`](https://dart.dev/tools/pub/cmd/pub-get), on locked versions, `--enforce-lockfile`, and committing the lockfile.
- [flutter/flutter#158050: Stop pinning dependencies](https://github.com/flutter/flutter/issues/158050) and the [design doc](https://flutter.dev/go/unpin-flutter-sdk-dependencies).
- [flutter/flutter#184821: Unpin sdk package dependencies](https://github.com/flutter/flutter/pull/184821) and its reland [#185268](https://github.com/flutter/flutter/pull/185268).
- [flutter/flutter#175352: Have `flutter create` create a pubspec.lock](https://github.com/flutter/flutter/pull/175352).
- Flutter tool source at the [3.47.7 tag](https://github.com/flutter/flutter/tree/3.47.7/packages/flutter_tools/lib/src): `commands/upgrade.dart` (`updatePackages`), `dart/pub.dart` (the skip-pub-get check), `migrations/analysis_options_migration.dart`.
