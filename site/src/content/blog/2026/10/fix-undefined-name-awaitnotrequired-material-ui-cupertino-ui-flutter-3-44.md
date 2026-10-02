---
title: "Fix: Undefined name 'awaitNotRequired' from material_ui or cupertino_ui on Flutter 3.44"
description: "material_ui 1.3.0 and cupertino_ui 1.1.0 use an annotation Flutter 3.44 does not export. Both are retracted, but a lockfile keeps them. Downgrade, then upgrade, to land on 1.2.0 and 1.0.2."
pubDate: 2026-10-02
template: error-page
tags:
  - "errors"
  - "flutter"
  - "flutter-3-44"
  - "dart"
  - "pub"
---

Your `pubspec.lock` pins `material_ui` 1.3.0 and/or `cupertino_ui` 1.1.0, two releases that use `@awaitNotRequired`, which `package:flutter/foundation.dart` only exports from Flutter 3.47.0 onward. Both versions are now retracted on pub.dev, but pub keeps a retracted version you have already locked, and on Flutter 3.44 even `flutter pub upgrade` will not move off it. Run `flutter pub downgrade material_ui cupertino_ui` followed by `flutter pub upgrade` (you end up on `material_ui` 1.2.0 and `cupertino_ui` 1.0.2), or upgrade Flutter to 3.47. Everything below was measured on Flutter 3.44.8 (Dart 3.12.2) and Flutter 3.47.6 (Dart 3.13.5) on 2026-10-02.

## The error in context

The analyzer stays quiet, `flutter pub get` succeeds, and then the first real compile fails inside the pub cache. This is `flutter build web` on 3.44.8; every other target runs the same Dart frontend over the same sources, so `flutter run` fails on the same lines:

```text
Target dart2js failed: ProcessException: Process exited abnormally with exit code 1:
/Users/marius/.pub-cache/hosted/pub.dev/material_ui-1.3.0/lib/src/bottom_sheet.dart:1304:2:
Error: Undefined name 'awaitNotRequired'.
@awaitNotRequired
 ^^^^^^^^^^^^^^^^
/Users/marius/.pub-cache/hosted/pub.dev/material_ui-1.3.0/lib/src/carousel.dart:1982:4:
Error: Not a constant expression.
  @awaitNotRequired
   ^^^^^^^^^^^^^^^^
/Users/marius/.pub-cache/hosted/pub.dev/material_ui-1.3.0/lib/src/dialog.dart:1672:2:
Error: Undefined name 'awaitNotRequired'.
@awaitNotRequired
 ^^^^^^^^^^^^^^^^
...
/Users/marius/.pub-cache/hosted/pub.dev/cupertino_ui-1.1.0/lib/src/route.dart:1347:2:
Error: Undefined name 'awaitNotRequired'.
@awaitNotRequired
 ^^^^^^^^^^^^^^^^
```

`material_ui` 1.3.0 produces eight of these (`showModalBottomSheet`, `CarouselController.animateToItem`, `showDatePicker`, `showDateRangePicker`, `showDialog`, `showAdaptiveDialog`, `showMenu`, `showTimePicker`) and `cupertino_ui` 1.1.0 adds two more (`showCupertinoModalPopup`, `showCupertinoDialog`). The `Not a constant expression` variant is the same bug: the annotation on an instance method gets reported differently by the frontend. Note that `flutter analyze` on your project reports nothing, because the analyzer does not surface errors inside dependencies. Only a compile step does.

You do not need to depend on `material_ui` directly to hit this. `shimmer` 4.0.0, for example, depends on `material_ui: ^1.0.1`, so running `flutter pub add shimmer` on Flutter 3.44 between 2026-09-15 and the retraction pulled 1.3.0 in transitively. That is exactly how the reporter in [flutter/flutter#192839](https://github.com/flutter/flutter/issues/192839) ran into it.

## Why Flutter 3.44 cannot see an annotation that exists in its own meta package

`awaitNotRequired` is not new. It has lived in `package:meta` since 1.17.0, and Flutter 3.44.8 pins `meta` 1.18.0, which already contains it. The constant is right there in your pub cache. What 3.44 lacks is the re-export.

`material_ui` and `cupertino_ui` never import `package:meta`. Their library files import `package:flutter/foundation.dart` and rely on what it re-exports from `meta`. On Flutter 3.44 that list is closed:

```dart
// packages/flutter/lib/foundation.dart, Flutter 3.44.8
export 'package:meta/meta.dart'
    show
        factory,
        immutable,
        internal,
        // ignore: experimental_member_use
        mustBeConst,
        mustCallSuper,
        nonVirtual,
        optionalTypeArgs,
        protected,
        required,
        visibleForOverriding,
        visibleForTesting;
```

[flutter/flutter#181513](https://github.com/flutter/flutter/pull/181513) ("Add @awaitNotRequired annotation to flutter sdk") added `awaitNotRequired` to that `show` list on 2026-04-25. It missed the 3.44 branch and shipped in Flutter 3.47.0 on 2026-08-12. On any 3.44.x release (3.44.0 through 3.44.9), the identifier is simply not in scope for code that only imports `foundation.dart`.

The packages, meanwhile, are developed against the Flutter main channel. [flutter/packages#12622](https://github.com/flutter/packages/pull/12622) and [#12817](https://github.com/flutter/packages/pull/12817) added the annotations, and `material_ui` 1.3.0 and `cupertino_ui` 1.1.0 went out on 2026-09-15 with the annotations but with the same `environment` they had before:

```yaml
# material_ui 1.3.0 pubspec.yaml
environment:
  sdk: ^3.12.0
  flutter: ">=3.44.0"
```

Pub trusts that constraint, so on Flutter 3.44 it picked 1.3.0 as the newest compatible version. The fix upstream was twofold: `material_ui` 1.4.0 and `cupertino_ui` 1.1.1 (both 2026-09-21/22) raised the floor to `flutter: ">=3.47.0"` and `sdk: ^3.13.0`, and 1.3.0 and 1.1.0 were retracted. The issue was closed on 2026-09-21.

## Minimal repro

Retracted versions can still be forced with a `dependency_overrides` pin, which is the easiest way to reproduce the build failure on purpose:

```yaml
# pubspec.yaml, Flutter 3.44.8 / Dart 3.12.2
name: repro
publish_to: 'none'
environment:
  sdk: ^3.12.0
dependencies:
  flutter:
    sdk: flutter
  material_ui: ^1.0.0
dependency_overrides:
  material_ui: 1.3.0
  cupertino_ui: 1.1.0
```

```dart
// lib/main.dart, Flutter 3.44.8, material_ui 1.3.0
import 'package:material_ui/material_ui.dart';

void main() => runApp(
  const MaterialApp(home: Scaffold(body: Center(child: Text('hi')))),
);
```

`flutter pub get` succeeds, `flutter analyze` reports no errors, and `flutter build web` fails with the output above. Without the override, `flutter pub add material_ui:1.3.0` now refuses outright with `Because repro depends on material_ui 1.3.0 which doesn't match any versions, version solving failed.`, since the solver hides retracted versions unless they are pinned or already locked.

## Why the retraction did not fix your project

If you ran `pub get` while 1.3.0 was live, your `pubspec.lock` says `version: "1.3.0"`, and a retraction does not touch lockfiles. The [pub docs](https://dart.dev/tools/pub/publishing#retract) are explicit that a locked retracted version keeps working. `flutter pub outdated` is the quickest way to confirm you are in this state:

```text
Package Name              Current             Upgradable          Resolvable          Latest

direct dependencies:
material_ui               *1.3.0 (retracted)  *1.3.0 (retracted)  *1.3.0 (retracted)  1.5.0

transitive dependencies:
cupertino_ui              *1.1.0 (retracted)  *1.1.0 (retracted)  *1.1.0 (retracted)  1.1.1
...
material_ui
    Version 1.3.0 is retracted. See https://dart.dev/go/package-retraction
cupertino_ui
    Version 1.1.0 is retracted. See https://dart.dev/go/package-retraction
```

Look at the Upgradable and Resolvable columns: pub itself says it will not move you. The same pub docs recommend `dart pub upgrade <package>` to leave a retracted version, and on Flutter 3.44 that does nothing:

```text
$ flutter pub upgrade material_ui cupertino_ui
  cupertino_ui 1.1.0 (retracted, 1.1.1 available)
  material_ui 1.3.0 (retracted, 1.5.0 available)
No dependencies changed.
```

The reason is in the solver. In `lib/src/solver/version_solver.dart`, `_getAllowedRetracted` returns `_lockFile.packages[package]?.version` regardless of whether the package was unlocked for upgrade. So during `upgrade`, the locked retracted version is still a legal candidate. Every newer release (1.4.0, 1.5.0, 1.1.1) needs Flutter 3.47, so the highest version the solver can pick on 3.44 is the retracted one you already have. The docs' advice works only when a newer *compatible* release exists, and on 3.44 none does.

## Fix 1: stay on Flutter 3.44 and step back to material_ui 1.2.0

You want the lockfile to stop mentioning 1.3.0 and 1.1.0. The cleanest way is to downgrade and then upgrade, so the retracted version drops out of the lock before the upgrade runs:

```bash
# Flutter 3.44.8: escape the retracted versions
flutter pub downgrade material_ui cupertino_ui
flutter pub upgrade
```

The first command moves both packages to the lowest versions your constraints allow (`material_ui` 1.0.0 and `cupertino_ui` 0.0.2 with `^1.0.0`), which also clears the retracted entries from `pubspec.lock`. The second climbs back to the newest non-retracted versions that 3.44 accepts:

```text
> cupertino_ui 1.0.2 (was 0.0.2) (1.1.1 available)
> material_ui 1.2.0 (was 1.0.0) (1.5.0 available)
```

After that, `flutter build web` on 3.44.8 succeeds. Deleting the `material_ui` and `cupertino_ui` entries from `pubspec.lock` by hand and running `flutter pub get` gives the same result (1.2.0 and 1.0.2), and so does deleting the whole lockfile, though that also re-resolves everything else in your graph. Do not skip `cupertino_ui`: it is usually a transitive dependency, and naming only `material_ui` leaves 1.1.0 locked and still broken.

Commit the new `pubspec.lock`. If your CI runs `flutter pub get --enforce-lockfile`, it installs exactly what the committed lockfile says, so the build keeps failing there until the new lockfile lands.

## Fix 2: move to Flutter 3.47, which is what the packages expect now

`material_ui` 1.4.0 and later require Flutter 3.47, and new fixes land only there. If you can upgrade, this is the long-term answer:

```bash
# Flutter 3.47.6 / Dart 3.13.5
flutter upgrade
flutter pub upgrade
```

On 3.47.6 the upgrade works the way the pub docs describe, because newer compatible versions now exist:

```text
> cupertino_ui 1.1.1 (was 1.1.0)
> material_ui 1.5.0 (was 1.3.0)
```

Strictly speaking you do not even need the package upgrade: the retracted 1.3.0 compiles fine on Flutter 3.47.6, because `foundation.dart` now re-exports the annotation. I still recommend running `flutter pub upgrade` so the lockfile stops pointing at a retracted release, which `flutter pub outdated` will otherwise keep flagging.


Moving to 3.47 is a bigger change than the package bump. It brings Dart 3.13 (which, among other things, [rejects `final` on ordinary parameters](/2026/09/fix-dart-3-13-cant-have-modifier-final-here-on-parameters/)) and makes Impeller the default renderer on desktop, so treat it as a planned upgrade rather than a hotfix.

## Fix 3: keep a constraint in pubspec.yaml so this cannot recur on 3.44

If you are staying on 3.44 for a while, cap the packages explicitly. That documents the decision and stops a teammate's `pub upgrade` from wandering if another release ships with a wrong `environment`:

```yaml
# pubspec.yaml, Flutter 3.44.x
dependencies:
  material_ui: ">=1.0.0 <1.3.0"
  cupertino_ui: ">=1.0.0 <1.1.0"
```

Add `cupertino_ui` even if you do not import it. When I capped only `material_ui` and ran `flutter pub get` against the broken lockfile, pub moved `material_ui` to 1.2.0 but left the transitive `cupertino_ui` at the retracted 1.1.0, because nothing forced it to change. With both caps in place, the same `flutter pub get` moved them to 1.2.0 and 1.0.2.

## Things that look like fixes but are not

- **Bumping `meta`.** `meta` 1.18.0 already declares `awaitNotRequired`, and the Flutter 3.44 framework pins `meta` to exactly 1.18.0 in its own `pubspec.yaml`, so you could not bump it anyway. The problem is the `show` list in `foundation.dart`, not the version of `meta`.
- **Declaring your own `awaitNotRequired`.** Name resolution happens inside `material_ui`'s libraries. A top-level constant in your app is not in their scope.
- **`flutter clean` or wiping the pub cache.** The bad version is selected by your lockfile, not by stale build output, so it is downloaded again on the next `pub get`.
- **Pinning `material_ui: 1.3.0` in `dependencies`.** A retracted version cannot be selected that way at all. Only `dependency_overrides` can force it, and that just reproduces the bug.

If you hit `Undefined name` for a different Flutter identifier after migrating to the standalone packages, the cause is usually the same pattern in another direction: code compiled against a newer framework than the one installed. `flutter --version` and the `environment` block of the package named in the error path will tell you quickly which side is ahead.

## Related

- The background on why Material and Cupertino moved out of the SDK is in [Flutter 3.44 splitting Material and Cupertino into packages](/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).
- For the full import migration, including `dart fix --code=migrate_design_widgets` and the compatibility bridges, see [migrating to the material_ui and cupertino_ui packages](/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/).
- Another type-level mismatch between the two Material worlds is covered in [the google_fonts TextTheme error with material_ui](/2026/09/fix-textheme-cant-be-assigned-to-textheme-google-fonts-material-ui/).
- When pub refuses to resolve at all instead of resolving to something broken, start with [fixing "version solving failed" in pubspec.yaml](/2026/05/fix-version-solving-failed-in-pubspec-yaml/).
- Before moving to 3.47, read about [Impeller becoming the default desktop renderer in Flutter 3.47](/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/).

## Sources

- [flutter/flutter#192839: material_ui 1.3.0 & cupertino_ui 1.1.0 on Flutter 3.44 Error: Undefined name 'awaitNotRequired'](https://github.com/flutter/flutter/issues/192839)
- [flutter/flutter#181513: Add @awaitNotRequired annotation to flutter sdk](https://github.com/flutter/flutter/pull/181513)
- [flutter/packages#12622: Add awaitNotRequired annotation to material_ui](https://github.com/flutter/packages/pull/12622) and the unmerged revert [#12942](https://github.com/flutter/packages/pull/12942)
- [material_ui changelog](https://pub.dev/packages/material_ui/changelog) and [cupertino_ui changelog](https://pub.dev/packages/cupertino_ui/changelog)
- [Retract a package version](https://dart.dev/tools/pub/publishing#retract), Dart documentation
- [`version_solver.dart` in dart-lang/pub](https://github.com/dart-lang/pub/blob/master/lib/src/solver/version_solver.dart)
- [`awaitNotRequired` API docs in package:meta](https://pub.dev/documentation/meta/latest/meta/awaitNotRequired-constant.html)
