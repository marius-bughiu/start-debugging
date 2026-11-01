---
title: "Migrate a Flutter App from MaterialStateProperty to WidgetStateProperty (Flutter 3.22+)"
description: "Rename MaterialState, MaterialStateProperty, MaterialStateColor and the rest of the family to their WidgetState equivalents. What dart fix rewrites, the input border subclasses it cannot touch, why a fromMap with & or | keys cannot be const, and how fromMap throws where resolveWith quietly fell back. Measured on Flutter 3.44.8 with Dart 3.12.2."
pubDate: 2026-10-23
updatedDate: 2026-10-23
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "material-3"
---

`MaterialState`, `MaterialStateProperty` and the rest of the `MaterialState*` family moved to the widgets layer as `WidgetState`, `WidgetStateProperty` and friends in Flutter 3.22.0 (the deprecation messages say "deprecated after v3.19.0-0.3.pre"). The old names are now plain `typedef` aliases of the new ones, so the migration is a rename with identical runtime behavior, and `dart fix --apply --code=deprecated_member_use` performs almost all of it. The two exceptions are classes that **extend** `MaterialStateOutlineInputBorder` or `MaterialStateUnderlineInputBorder` (their replacement, `WidgetStateInputBorder`, is an `abstract interface class` you cannot extend) and anything you want to modernize to the newer `fromMap` API, which has two traps of its own. A typical app takes 15 to 30 minutes. Everything below was run on Flutter 3.44.8 (Dart 3.12.2).

## Why rename something that already works

- **The aliases are on a removal path.** Flutter removes deprecated APIs after they have shipped through enough stable releases. When `MaterialStateProperty` goes, every remaining reference becomes a compile error at the same moment you are trying to upgrade Flutter for some other reason.
- **The state logic is no longer Material-specific.** Since 3.22, `WidgetState` lives in `package:flutter/widgets.dart`, so a custom widget or a Cupertino-only package can resolve per-state values without importing Material.
- **Noise.** One button theme can produce a dozen `deprecated_member_use` infos, because every `Set<MaterialState>` and every `MaterialState.pressed` is a separate hit. My three-file sample project produced 35 of them.
- **The new API is better.** `WidgetStateProperty.fromMap` (added in 3.27.0) replaces chains of `if (states.contains(...))` with a declarative map and supports `&`, `|` and `~` on states.

## What changes in the app

| Area | Change | Severity |
| --- | --- | --- |
| `MaterialState`, `MaterialStateProperty`, `MaterialStatePropertyAll` | Renamed to `WidgetState*`, applied by `dart fix` | low |
| `MaterialStateColor`, `...BorderSide`, `...OutlinedBorder`, `...TextStyle`, `...MouseCursor` | Renamed to `WidgetState*`, applied by `dart fix`, subclasses included | low |
| `MaterialPropertyResolver`, `MaterialStatesController` | Become `WidgetPropertyResolver`, `WidgetStatesController` | low |
| `MaterialStateOutlineInputBorder.resolveWith` / `MaterialStateUnderlineInputBorder.resolveWith` | Become `WidgetStateInputBorder.resolveWith` (3.27+) | low |
| Classes that `extends MaterialStateUnderlineInputBorder` / `...OutlineInputBorder` | Not migrated by `dart fix`, need a rewrite | medium |
| `show MaterialState, ...` import combinators | Rewritten by `dart fix` | low |
| `MaterialStateMixin` | Not deprecated, no rename needed | none |

## Pre-flight checklist

- Flutter 3.22.0 or newer for the core rename. If you have input borders built with `MaterialStateOutlineInputBorder` or `MaterialStateUnderlineInputBorder`, you need 3.27.0 or newer, because `WidgetStateInputBorder` and `fromMap` did not exist before that.
- A clean `git status`, so the `dart fix` output is one reviewable diff.
- A passing test suite. Since this migration is a pure rename, any test failure afterwards means something other than the rename changed.
- If you publish a package, check your `environment: flutter:` lower bound. Code using `WidgetState` does not compile on Flutter 3.19 or older.

## Migration steps

1. **Inventory the deprecated names.** Run the analyzer and count the hits, so you know what the fix should clear:

    ```bash
    # Flutter 3.44.8
    flutter analyze 2>&1 | grep deprecated_member_use | grep -E "'Material(State|PropertyResolver|StatesController)"
    ```

    This is the sample file I migrated. It covers every member of the family, including a subclass of `MaterialStateColor` and a subclass of `MaterialStateUnderlineInputBorder`:

    ```dart
    // Flutter 3.44.8, Dart 3.12.2 (before)
    import 'package:flutter/material.dart';

    final ButtonStyle primaryButton = ButtonStyle(
      backgroundColor: MaterialStateProperty.resolveWith<Color?>((Set<MaterialState> states) {
        if (states.contains(MaterialState.disabled)) return Colors.grey;
        if (states.contains(MaterialState.pressed)) return Colors.indigo.shade700;
        return Colors.indigo;
      }),
      foregroundColor: const MaterialStatePropertyAll<Color>(Colors.white),
      elevation: MaterialStateProperty.all<double>(2),
      side: MaterialStateBorderSide.resolveWith(
        (states) => states.contains(MaterialState.focused)
            ? const BorderSide(color: Colors.amber, width: 2)
            : null,
      ),
      mouseCursor: MaterialStateMouseCursor.clickable,
    );

    final MaterialPropertyResolver<Color?> overlay = (Set<MaterialState> states) =>
        states.contains(MaterialState.pressed) ? Colors.white24 : null;

    class BrandColor extends MaterialStateColor {
      const BrandColor() : super(0xFF3F51B5);

      @override
      Color resolve(Set<MaterialState> states) =>
          states.contains(MaterialState.selected) ? const Color(0xFF1A237E) : const Color(0xFF3F51B5);
    }

    final InputDecoration field = InputDecoration(
      border: MaterialStateOutlineInputBorder.resolveWith(
        (states) => OutlineInputBorder(
          borderSide: BorderSide(color: states.contains(MaterialState.error) ? Colors.red : Colors.grey),
        ),
      ),
    );

    class ErrorAwareBorder extends MaterialStateUnderlineInputBorder {
      const ErrorAwareBorder();

      @override
      InputBorder resolve(Set<MaterialState> states) => UnderlineInputBorder(
            borderSide: BorderSide(color: states.contains(MaterialState.error) ? Colors.red : Colors.black),
          );
    }

    final MaterialStatesController controller = MaterialStatesController();
    ```

    Verify: the analyzer reports `'MaterialState' is deprecated and shouldn't be used. Use WidgetState instead.` and siblings for each reference.

2. **Apply the rename with a scoped `dart fix`.** Limit the run to the deprecation code instead of a bare `dart fix --apply`:

    ```bash
    # Flutter 3.44.8, Dart 3.12.2
    dart fix --apply --code=deprecated_member_use
    ```

    On my project this reported `31 fixes made in 3 files`. The rename rules come from `packages/flutter/lib/fix_data/fix_material/fix_widget_state.yaml` in the SDK, and they cover type annotations, constructor calls, static members (`MaterialStateMouseCursor.clickable` becomes `WidgetStateMouseCursor.clickable`), `extends` clauses, `Set<MaterialState>` parameters, `show` combinators and test files. The `MaterialStateColor` subclass came out as `class BrandColor extends WidgetStateColor` with its `const` super constructor intact. The scoping matters, and the gotchas section shows what an unscoped run did to `overlay`.

    Verify: `git diff --stat` shows only renames, and `flutter analyze` drops to the input border subclass hits.

3. **Rewrite input border subclasses.** This is what `dart fix` leaves behind:

    ```text
    info • 'MaterialStateUnderlineInputBorder' is deprecated and shouldn't be used. Use WidgetStateInputBorder instead. • lib/styles.dart:42:32 • deprecated_member_use
    ```

    The obvious edit, `extends WidgetStateInputBorder`, does not compile. `WidgetStateInputBorder` is declared as `abstract interface class WidgetStateInputBorder implements InputBorder, WidgetStateProperty<InputBorder>` with only factory constructors, so the analyzer reports `no_generative_constructors_in_superclass` plus a missing-implementations error for `copyWith`, `paint` and 12 more members. Move the `resolve` body into a top-level function and pass the tear-off to the `const` factory instead:

    ```dart
    // Flutter 3.44.8, Dart 3.12.2 (after)
    import 'package:flutter/material.dart';

    InputBorder _errorAwareBorder(Set<WidgetState> states) => UnderlineInputBorder(
          borderSide: BorderSide(color: states.contains(WidgetState.error) ? Colors.red : Colors.black),
        );

    const InputBorder errorAwareBorder = WidgetStateInputBorder.resolveWith(_errorAwareBorder);
    ```

    A top-level or static function tear-off is a constant, so `errorAwareBorder` stays `const` and works anywhere `const ErrorAwareBorder()` did. Replace each `const ErrorAwareBorder()` with `errorAwareBorder`.

    Verify: `flutter analyze` reports no `Material*` deprecations.

4. **Optionally convert `.all` to `const WidgetStatePropertyAll`.** `dart fix` turns `MaterialStateProperty.all<double>(2)` into `WidgetStateProperty.all<double>(2)`, which is not deprecated. A source comment in `WidgetStateProperty` says it will be deprecated once a fix can rewrite it to `WidgetStatePropertyAll`, so do it now where the value is a constant: `const WidgetStatePropertyAll<double>(2)`. Both forms compare equal, because `WidgetStateProperty.all` returns a `WidgetStatePropertyAll`.

    Verify: `flutter test` passes, with no assertions changed.

5. **Optionally move long `resolveWith` chains to `fromMap`.** Read the next section first. Done right, it reads better:

    ```dart
    // Flutter 3.44.8, Dart 3.12.2: fromMap needs Flutter 3.27.0+
    final WidgetStateProperty<Color> fill = WidgetStateProperty<Color>.fromMap(<WidgetStatesConstraint, Color>{
      WidgetState.disabled: Colors.grey,
      WidgetState.pressed | WidgetState.hovered: Color(0xFF303F9F),
      WidgetState.selected & ~WidgetState.focused: Color(0xFF1A237E),
      WidgetState.any: Colors.indigo,
    });
    ```

    The first key satisfied by the current states wins, so order matters exactly as it did in the `if` chain. In my tests, `{disabled, pressed}` resolved to grey, `{hovered}` to `0xFF303F9F`, `{selected}` to `0xFF1A237E`, and `{selected, focused}` and the empty set both fell through to `WidgetState.any`.

    Verify: write one `resolve` assertion per map entry plus one for the empty set.

## Verification

- `flutter analyze` reports zero `deprecated_member_use` hits mentioning `MaterialState`, `MaterialPropertyResolver` or `MaterialStatesController`.
- `flutter test` passes without changes to expected values. Tests that call `style.backgroundColor!.resolve(<WidgetState>{WidgetState.pressed})` keep working, because only the type name changed.
- Tap through each custom button and text field once in disabled, hovered, pressed and error states. That takes one minute and catches a `fromMap` conversion with entries in the wrong order.
- `grep -rn "MaterialState" lib test` returns only `MaterialStateMixin`, which is fine.

## Rolling back

The rename is fully reversible: the old names are aliases of the new types, so `git revert` of the migration commit restores the deprecated code with identical behavior. The only one-way part is raising your minimum Flutter version. Once `WidgetStateInputBorder` or `fromMap` is in the code, Flutter 3.22 to 3.26 can no longer build it.

## Gotchas from a real migration

### An unscoped `dart fix --apply` retyped a resolver as `Object?`

My first run used a bare `dart fix --apply`. Alongside the 31 renames, it applied a fix for the `prefer_function_declarations_over_variables` lint from `flutter_lints` to the `overlay` variable, and produced this:

```dart
// Flutter 3.44.8, Dart 3.12.2: output of an unscoped dart fix --apply
Object? overlay(Set<WidgetState> states) =>
    states.contains(WidgetState.pressed) ? Colors.white24 : null;
```

The `Color?` return type from `MaterialPropertyResolver<Color?>` is gone. Running only `--code=prefer_function_declarations_over_variables` on the original file produces the same `Object?`, so this is that lint fix, not the rename. Pass `overlay` to `WidgetStateProperty.resolveWith` afterwards and you get a `WidgetStateProperty<Object?>` that no `overlayColor` parameter accepts. Run the rename with `--code=deprecated_member_use`, then handle lint fixes in a separate, reviewed pass. The variable form with `WidgetPropertyResolver<Color?>` is fine to keep.

### `&`, `|` and `~` keys make a `fromMap` non-constant

`WidgetStatesConstraint` defines `&`, `|` and `~` as ordinary operator methods, and Dart only evaluates `&` and `|` in constant expressions on `bool` and `int`. Declaring the `fill` map above as `const` fails:

```text
error • In constant expressions, operands of this operator must be of type 'bool' or 'int' • const_eval_type_bool_int
```

The compiler phrases it as `The method '|' can't be invoked on 'WidgetState {}' in a constant expression.` Use `final` for any map with combined keys. A map whose keys are single states and `WidgetState.any` can stay `const`.

### `fromMap` throws where `resolveWith` returned something

Two behaviors change when you switch APIs, and neither one shows up in the analyzer.

First, a non-nullable `fromMap` with no matching key throws instead of returning a default:

```text
Invalid argument(s): The current set of widget states is {}.
None of the provided map keys matched this set, and the type "Color" is non-nullable.
Consider using "WidgetStateMapper<Color?>()", or adding the "WidgetState.any" key to this map.
```

End every non-nullable map with `WidgetState.any`, or make the type nullable when the widget accepts `null` to mean "use the theme default".

Second, `WidgetStateColor`, `WidgetStateBorderSide` and the other dual-type classes behave differently when they land in a slot that only accepts the plain type. A `WidgetStateColor.resolveWith` passed to `Container(color: ...)` behaves as the color it resolves to for the empty state set: mine rendered as `0xFF2196F3`. A `WidgetStateColor.fromMap` in the same slot throws a `FlutterError` the moment anything reads a `Color` member. The message is "There was an attempt to access the "Symbol("toARGB32")" field of a WidgetStateMapper<Color> object." If a shared color constant is passed both to state-aware and plain slots, keep it on `resolveWith`.

### Equality depends on which constructor you used

`fromMap` mappers compare by map contents, so two identical maps are `==`. `resolveWith` wraps a closure, and two separately created closures are never equal, so `WidgetStateProperty.resolveWith((_) => Colors.red) == WidgetStateProperty.resolveWith((_) => Colors.red)` is `false`. This matters for `ButtonStyle` and theme `==` checks in tests, and for `updateShouldNotify`-style comparisons. Moving to `fromMap` or `WidgetStatePropertyAll` makes those comparisons meaningful. Staying on inline `resolveWith` keeps them always-different, exactly as before.

### The breaking-change page is out of date on input borders

The official "Rename MaterialState to WidgetState" page says `MaterialStateOutlineInputBorder` and `MaterialStateUnderlineInputBorder` have no `WidgetState` equivalent. That was true at 3.22. Since 3.27 (flutter/flutter#154972), both are deprecated in favor of `WidgetStateInputBorder`, which still lives in `material.dart`, not `widgets.dart`. The page's table also lists names that do not exist, `WidgetStatePropertyResolver` and `WidgetStateColorMouseCursor`. The real ones are `WidgetPropertyResolver` and `WidgetStateMouseCursor`.

### `material_ui` still ships the aliases, for now

If you have moved to the decoupled `material_ui` package, version 1.8.0 (published 2026-10-20) still contains `typedef MaterialState = WidgetState;` and its own copy of the fix data, so neither the deprecations nor `dart fix` behave differently there. The migration is the same whichever package your Material import comes from.

## Related

- The same "deprecated typedef plus `dart fix`" pattern with real behavior changes underneath is in [migrating from Color.withOpacity to Color.withValues](/2026/10/migrate-a-flutter-app-from-color-withopacity-to-color-withvalues/).
- For running this fix across a monorepo with many packages, see [how to run dart fix across a whole repo](/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/).
- Another `dart fix` migration where the tool covers the easy cases and leaves the rest to you: [replacing `WidgetsBindingObserver.didChangeAppLifecycleState` with `AppLifecycleListener`](/2026/10/migrate-a-flutter-app-from-widgetsbindingobserver-to-applifecyclelistener/).
- Navigation bar icons are themed through a `WidgetStateProperty<IconThemeData>`, which comes up in [stopping `ImageIcon` from picking up the `IconTheme` color](/2026/09/how-to-stop-imageicon-from-tinting-an-icon-with-the-icontheme-color-in-flutter/).
- If your per-state colors come from brand tokens, [defining custom design tokens with `ThemeExtension`](/2026/10/how-to-define-custom-design-tokens-with-themeextension-in-flutter/) shows where to keep them.

## Sources

- [Rename MaterialState to WidgetState](https://docs.flutter.dev/release/breaking-changes/material-state), Flutter breaking-change notes (landed in 3.21.0-11.0.pre, stable in 3.22.0).
- [flutter/flutter#142151](https://github.com/flutter/flutter/pull/142151), "Widget State Properties", the rename PR.
- [flutter/flutter#154972](https://github.com/flutter/flutter/pull/154972), "Monomorphic Mapper", which made `WidgetStateMapper` public with working equality and is the PR the SDK fix data cites for the `WidgetStateInputBorder` rename.
- [`WidgetStateProperty<T>` API reference](https://api.flutter.dev/flutter/widgets/WidgetStateProperty-class.html) and [`WidgetState` enum](https://api.flutter.dev/flutter/widgets/WidgetState.html).
- [Flutter fix](https://docs.flutter.dev/tools/flutter-fix) and the SDK's `packages/flutter/lib/fix_data/fix_material/fix_widget_state.yaml`.
