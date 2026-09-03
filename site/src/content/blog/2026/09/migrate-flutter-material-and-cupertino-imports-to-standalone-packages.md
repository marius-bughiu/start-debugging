---
title: "Migrate Flutter Material and Cupertino imports to the material_ui and cupertino_ui packages"
description: "The full migration off package:flutter/material.dart and package:flutter/cupertino.dart onto material_ui 1.1.1 and cupertino_ui 1.0.2: what dart fix --code=migrate_design_widgets rewrites, why third-party widgets start throwing ancestor-lookup errors, what MaterialUiCompatibilityBridge actually fixes, and how the flutter_localizations dependency changes."
pubDate: 2026-09-03
updatedDate: 2026-09-03
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "material-design"
  - "cupertino"
---

For an app whose only Material surface is its own code, this is a one-command, one-afternoon migration: `flutter pub add material_ui`, then `dart fix --apply --code=migrate_design_widgets`, then run the tests. The widget APIs are an identical copy of what was in the SDK, so nothing renders differently and no golden should move. What costs real time is the dependency graph. Every package that still imports `package:flutter/material.dart` drags a second, type-incompatible copy of `Theme`, `Material`, and `MaterialLocalizations` into your program, and its widgets will throw ancestor-lookup failures inside your migrated tree until you wrap the app in `MaterialUiCompatibilityBridge`. This guide targets the current stable channel, Flutter 3.47.2 with Dart 3.13.2, plus [`material_ui`](https://pub.dev/packages/material_ui) 1.1.1 and [`cupertino_ui`](https://pub.dev/packages/cupertino_ui) 1.0.2.

The clock matters here. The in-SDK libraries are already frozen, and formal deprecation is scheduled for the November 2026 stable release.

## Why this is not an optional cleanup

- **The in-SDK copies receive no fixes.** Flutter closed the Material and Cupertino directories in `flutter/flutter` to all contributions on April 7, 2026. Every bug fix since then has landed in `flutter/packages` instead. `material_ui` 1.1.1 already carries fixes the SDK copy will never get, including the `SearchAnchor` race where a stale async suggestion set replaced a newer one, and `Slider` value indicator labels being clipped instead of ellipsized at the screen edge.
- **Design updates stop waiting on the SDK train.** Material and Cupertino used to ship on Flutter's quarterly cadence, so a token tweak or a new `MenuAnchor` argument waited for the next stable cut. Pinning `material_ui: ^1.1.1` decouples that: 1.1.0 and 1.1.1 both landed between the 3.47 stable and today.
- **You can finally drop a design system you never used.** Once the SDK copies are deleted, a Cupertino-only app stops carrying Material's theming, typography, and icon metadata through tree-shaking, and vice versa.
- **Localizations move with the widgets.** The Material and Cupertino translated strings and delegates now live inside the packages, which is why `flutter_localizations` stops being something you list yourself.
- **If you publish a package, you are a blocker.** One un-migrated leaf package forces the compatibility bridge on everyone downstream.

## What breaks

| Area | Change | Severity |
| ---- | ------ | -------- |
| Imports | `package:flutter/material.dart` becomes `package:material_ui/material_ui.dart`; `package:flutter/cupertino.dart` becomes `package:cupertino_ui/cupertino_ui.dart` | high, fully automatable |
| Type identity | The SDK `Material` and the `material_ui` `Material` are different runtime types, so ancestor lookups do not cross the boundary | high, needs the bridge |
| Localization delegates | `GlobalMaterialLocalizations` and `GlobalCupertinoLocalizations` come from the packages, not from `flutter_localizations` | medium |
| `pubspec.yaml` | Two new direct dependencies; `flutter_localizations` is no longer a direct dependency you need | medium |
| Generated code | Anything emitting `package:flutter/material.dart` into a `.g.dart` or `.freezed.dart` file needs a regenerate after the source pass | medium |
| Published packages | Migrating your own package is a breaking change for consumers, so it needs a major version bump | medium |
| Widget APIs | None. Constructors, parameters, and rendering are unchanged | none |

That last row is the whole reason this migration is tractable. `material_ui` 1.0.0 is a copy of the bundled library as of the April 2026 freeze, not a redesign.

## Pre-flight checklist

- Flutter 3.44 or newer. `material_ui` raised its floor to Flutter 3.44 / Dart 3.12 when the code moved out of `flutter/flutter`, and 3.47.2 is the current stable. Check with `flutter --version`.
- A clean `flutter analyze` before you start. You want the post-migration run to be comparable.
- A branch. `dart fix --apply` rewrites every matching file in one pass and there is no undo flag.
- An inventory of dependencies that render Material or Cupertino widgets. `flutter pub deps --style=compact` plus `flutter pub outdated` gives you the list; anything last published before August 2026 has not migrated.
- If you have golden tests, run them first and commit the baseline. They should not change, and that is the assertion.

## Migration steps

1. **Add the packages before you touch a single import.** The `dart fix` rule rewrites import strings; it does not edit `pubspec.yaml`. Run it in the wrong order and you get a file full of unresolvable imports.

   ```sh
   # Flutter 3.47.2, Dart 3.13.2
   flutter pub add material_ui
   flutter pub add cupertino_ui
   ```

   That resolves to `material_ui: ^1.1.1` and `cupertino_ui: ^1.0.2` today. If your app is Material-only you still get `cupertino_ui` transitively, because `material_ui` has depended on `cupertino_ui: ^1.0.0` since its 1.0.1 release, but list it explicitly if you import it directly. Verify with `flutter pub deps --style=compact | grep -E 'material_ui|cupertino_ui'` and confirm both resolve.

2. **Rewrite the imports with the shipped fix.** Both packages register the same analyzer fix, so one command handles Material and Cupertino together.

   ```sh
   dart fix --dry-run --code=migrate_design_widgets   # review first
   dart fix --apply  --code=migrate_design_widgets
   ```

   The result is a one-line diff per file:

   ```dart
   // Before: Flutter 3.43 and earlier
   import 'package:flutter/material.dart';

   // After: material_ui 1.1.1
   import 'package:material_ui/material_ui.dart';
   ```

   Nothing below the import line changes. `MaterialApp`, `Scaffold`, `ThemeData`, `Colors`, `showDialog`, and every other name is exported under the same identifier. Verify with `grep -rn "package:flutter/material.dart\|package:flutter/cupertino.dart" lib test` returning nothing, then `flutter analyze`.

3. **Point the localization delegates at the packages.** The delegates and the translated strings moved into `material_ui` and `cupertino_ui`, and the packages expose an aggregate getter that saves you listing three delegates by hand.

   ```dart
   // Before: flutter_localizations, Flutter 3.43
   import 'package:flutter_localizations/flutter_localizations.dart';

   localizationsDelegates: const <LocalizationsDelegate<Object>>[
     GlobalMaterialLocalizations.delegate,
     GlobalCupertinoLocalizations.delegate,
     GlobalWidgetsLocalizations.delegate,
   ],
   ```

   ```dart
   // After: material_ui 1.1.1
   import 'package:material_ui/material_ui.dart';

   localizationsDelegates: GlobalMaterialLocalizations.delegates,
   ```

   `GlobalMaterialLocalizations.delegates` already includes the Cupertino and Widgets delegates. If you also run `gen-l10n`, your generated `AppLocalizations.delegate` is unaffected and gets appended to that list as before. You can now drop `flutter_localizations` from your own `dependencies`, though it will stay in `pubspec.lock`: `cupertino_ui` 1.0.2 still depends on it, alongside `collection: ^1.19.1` and `intl: ^0.20.2`. Verify by launching with a non-English locale and checking a built-in string, for example long-pressing a `TextField` and confirming the paste affordance is translated.

4. **Bridge the dependencies that have not migrated.** This is the step people skip and then debug for an hour. Wrap at the app level with `MaterialApp.builder`:

   ```dart
   // material_ui 1.1.1
   MaterialApp(
     theme: ThemeData(useMaterial3: true),
     builder: (BuildContext context, Widget? child) {
       return MaterialUiCompatibilityBridge(child: child!);
     },
     home: const HomeScreen(),
   )
   ```

   The Cupertino side is symmetric:

   ```dart
   // cupertino_ui 1.0.2
   CupertinoApp(
     builder: (BuildContext context, Widget? child) {
       return CupertinoUiCompatibilityBridge(child: child!);
     },
     home: const HomeScreen(),
   )
   ```

   You can also wrap a narrower subtree if only one screen embeds legacy widgets, which keeps the extra inherited widgets out of the rest of the tree. Verify by navigating to every screen that hosts a third-party widget. The bridge is temporary scaffolding: delete it once `flutter pub outdated` shows nothing left on the old imports.

5. **Regenerate anything a code generator wrote.** `dart fix` sees your source, not the templates that produced it. Re-run the generator after step 2 so emitted files stop importing the SDK library:

   ```sh
   dart run build_runner build --delete-conflicting-outputs
   ```

   Then check the leftovers `dart fix` cannot reach: `export` barrels that re-export Material for consumers, conditional imports that select a Material implementation per platform, and any generator template of your own with the import path hardcoded as a string. Verify with the same `grep` from step 2, widened to the whole repo rather than just `lib` and `test`.

6. **If you publish a package, bump the major version.** Switching a published package to `material_ui` changes what its consumers must have in their own `pubspec.yaml`. Shipping that as a minor release breaks apps silently: their widget tree ends up mixing sources with no compile error to point at it. Bump to the next major, note the required `material_ui` constraint in the changelog, and keep the previous major on a maintenance branch if you support older Flutter versions. Verify with `dart pub publish --dry-run`.

## Verification

- `flutter analyze` reports the same count as your pre-migration baseline, with no `uri_does_not_exist` and no `deprecated_member_use` on an import line.
- `grep -rn "package:flutter/material.dart\|package:flutter/cupertino.dart" .` finds nothing outside `.dart_tool` and `pubspec.lock`.
- `flutter test` passes, golden tests included and unchanged. A moved golden means two copies of the library are rendering in the same tree, not that Material changed.
- The app runs on a device and every screen that embeds a third-party widget renders with your theme, not with defaults.
- A non-English locale still shows translated built-in strings after step 3.
- `flutter build apk --release --analyze-size` (or the iOS equivalent) as a size baseline for later, once the SDK copies are deleted and tree-shaking can actually drop the design system you do not use.

## Rollback

Fully reversible today. The changes are a `pubspec.yaml` diff, one import line per file, a delegates list, and an optional bridge widget, so `git revert` of the migration commit puts you back on the SDK libraries with no data or build artifact to unwind. Two caveats: there is no reverse `dart fix`, so a manual rollback means editing every import back by hand, which is why step 0 is a branch. And after the November 2026 stable, reverting parks you on formally deprecated APIs that will be deleted, so treat rollback as a way to unblock a release, not as a decision.

## Gotchas

**"Could not find an ancestor of type MaterialLocalizations" from code you did not write.** This is the type-identity problem showing up at runtime. A widget compiled against the SDK library calls `MaterialLocalizations.of(context)`, which walks the tree looking for the inherited widget of *its* `MaterialLocalizations` type. Your `material_ui` `MaterialApp` inserted a different type with the same name, the lookup misses, and the assert fires. `Theme.of(context)` fails the same way, with "Could not find an ancestor of type Theme". The bridge in step 4 exists specifically to insert the legacy inherited widgets alongside the new ones so both lookups resolve. It is not a workaround for a missing `Scaffold`: if the error comes from your own migrated code, you have the ordinary problem described in [no Material widget found in Flutter](/2026/08/fix-no-material-widget-found-in-flutter/), and the bridge will not help.

**Unresolvable import right after running the fix.** You ran `dart fix` before `flutter pub add`. Add the package, then re-run `dart fix --apply --code=migrate_design_widgets`; the rule is idempotent.

**Do not leave both imports in one file.** `package:flutter/material.dart` and `package:material_ui/material_ui.dart` export the same identifiers, so any file with both gets ambiguous-import errors on `Material`, `Theme`, `Colors`, and friends. Prefixing one of them compiles but gives you two design systems in one file, which is worse than the error. Pick one per file.

**The freeze date and the deprecation date are not the same thing.** The [code freeze announcement](https://flutter.dev/blog/flutters-material-and-cupertino-code-freeze) said the SDK libraries would be deprecated in the stable release *after* 3.44. That slipped: 3.47 shipped on August 12, 2026 without the deprecation, and [the 3.47 release notes](https://flutter.dev/blog/whats-new-in-flutter-3-47) now put formal deprecation in the November stable. Frozen since April, deprecated in November, deleted later. Plan against November, not against whatever your analyzer is quiet about today.

**Asset manifests can shift even though widgets do not.** `material_ui` 1.1.0 exposed the `ink_sparkle` shader asset through its own `pubspec.yaml` and dropped the `stretch_effect` shader. If you assert on the asset manifest or strip unused assets in a build step, that is a real diff to review.

**Migrate imports and Flutter versions in separate commits.** If you jump SDK versions during the same pass, any visual regression has two candidate causes. Land the SDK upgrade, confirm the app is clean, then migrate imports.

## Related

- The announcement this migration follows up on, including the SwiftPM default that landed in the same release, is in [Flutter 3.44 splits Material and Cupertino out of the SDK](/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).
- Structurally this is the same shape of wide mechanical pass as [migrating a Flutter web app from dart:html to package:web](/2026/09/migrate-a-flutter-web-app-from-dart-html-to-package-web/), including the part where `dart fix` handles the easy 95% and the dependency graph handles you.
- For a deprecation that `dart fix` explicitly cannot automate, compare [replacing Radio.groupValue and onChanged with RadioGroup](/2026/08/how-to-replace-flutter-deprecated-radio-groupvalue-and-onchanged-with-radiogroup/).
- If you are also moving to the current stable in this cycle, read [what Flutter 3.47 changed for desktop rendering](/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/) before you attribute a visual regression to the package swap.
- Ancestor-lookup failures are a family, not a one-off. [ScaffoldMessenger.of(context) does not contain a Scaffold](/2026/07/fix-scaffoldmessenger-of-context-does-not-contain-a-scaffold-in-flutter/) is the same debugging method applied to a different inherited widget.

## Sources

- [material_ui on pub.dev](https://pub.dev/packages/material_ui), version 1.1.1, and its [changelog](https://pub.dev/packages/material_ui/changelog)
- [cupertino_ui on pub.dev](https://pub.dev/packages/cupertino_ui), version 1.0.2
- [Flutter's Material and Cupertino code freeze](https://flutter.dev/blog/flutters-material-and-cupertino-code-freeze), the Flutter blog
- [What's new in Flutter 3.44](https://flutter.dev/blog/whats-new-in-flutter-3-44), the Flutter blog
- [What's new in Flutter 3.47](https://flutter.dev/blog/whats-new-in-flutter-3-47), the Flutter blog
- [Design system decoupling tracking issue](https://github.com/flutter/flutter/issues/172932), flutter/flutter
- [Flutter 3.47.0 release notes](https://docs.flutter.dev/release/release-notes/release-notes-3.47.0), docs.flutter.dev
