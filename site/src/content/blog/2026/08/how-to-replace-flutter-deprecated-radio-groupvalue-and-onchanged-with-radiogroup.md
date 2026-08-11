---
title: "How to replace Flutter's deprecated Radio groupValue and onChanged with RadioGroup"
description: "Radio.groupValue and Radio.onChanged were deprecated after Flutter 3.32 and RadioGroup shipped in 3.35. A step-by-step migration for Radio, RadioListTile and CupertinoRadio, why dart fix cannot do it for you, and the generic type-inference trap that silently renders a migrated radio disabled. Verified on Flutter 3.44.2 stable."
pubDate: 2026-08-11
updatedDate: 2026-08-11
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "material"
  - "accessibility"
---

If `flutter analyze` is telling you that `groupValue` and `onChanged` are deprecated on `Radio`, `RadioListTile` or `CupertinoRadio`, the fix is to lift both properties out of the individual radios and into a single `RadioGroup<T>` ancestor that wraps them. Budget about ten minutes per screen: it is mechanical, but `dart fix` cannot do it for you (I checked, see below), and there is one trap that produces no error at all, just a radio that quietly stops responding to taps. The deprecation landed after `v3.32.0-0.0.pre`, `RadioGroup` shipped in Flutter 3.35, and the old properties are still present on stable 3.44. Everything here is verified against Flutter 3.44.2 stable with Dart 3.12.

## Why Flutter moved group state out of the radio

The old API had no concept of a group. Every `Radio` independently compared its own `value` to a `groupValue` you passed to each one, which meant the framework itself never knew which radios belonged together. That is fine for painting a dot, and useless for accessibility.

The [WAI-ARIA radio group pattern](https://www.w3.org/WAI/ARIA/apg/patterns/radio) requires a group to behave as a single stop in the tab order, with arrow keys moving the selection inside it. You cannot implement that without a widget that owns the set. `RadioGroup` is that widget, and it is why the redesign happened rather than a cosmetic API cleanup.

The behaviour you get for free after migrating, which I confirmed in a widget test on 3.44.2:

- **Tab and Shift+Tab** move focus into and out of the whole group, not through each radio one at a time.
- **Arrow keys** move the selection between radios in reading order and wrap at the ends. Starting on `Flavor.vanilla` and pressing arrow-down twice went `vanilla` to `chocolate` and back to `vanilla`.
- **Space** toggles the focused radio.

There is also a smaller win: the radios themselves get shorter. A `Radio<int>` in a migrated tree is `Radio<int>(value: 0)` and nothing else.

## What breaks

| Area | Change | Severity |
| --- | --- | --- |
| `Radio.groupValue` / `Radio.onChanged` | Deprecated; move to a `RadioGroup<T>` ancestor | high |
| `RadioListTile.groupValue` / `.onChanged` | Same deprecation, same fix | high |
| `CupertinoRadio.groupValue` / `.onChanged` | Same deprecation, same fix | high |
| Disabling one radio | `onChanged: null` replaced by `enabled: false` | medium |
| Generic type inference | `RadioGroup<T>` is matched by exact type, and `T` is inferred differently than on the radio | high |
| Tab order | The group is now one tab stop instead of N | medium |
| `RadioListTile.selected` | Still does not auto-coordinate with the checked state | low |
| Automated migration | No `dart fix` rule exists; this is a hand edit | medium |

## Pre-flight checklist

- Flutter 3.35 or newer. `RadioGroup` landed in `3.34.0-0.0.pre` and reached stable in 3.35, so on anything older the class does not exist. Check with `flutter --version`.
- Find every call site: `flutter analyze` reports each one as `deprecated_member_use`. On a sample file it emitted `'groupValue' is deprecated and shouldn't be used. Use a RadioGroup ancestor to manage group value instead. This feature was deprecated after v3.32.0-0.0.pre.`
- Do not expect `dart fix` to help. I ran `dart fix --dry-run` against a project full of deprecated `Radio` usages on 3.44.2 and got `Nothing to fix!`. There is no `fix_radio*.yaml` in the framework's `lib/fix_data/fix_material` directory, which makes sense: wrapping widgets in a new ancestor is a structural edit, not a parameter rename.
- Check your dependencies. Some pub.dev packages still ship the old API internally ([flutter/flutter#170915](https://github.com/flutter/flutter/issues/170915) tracks this for first-party packages). You cannot migrate a widget you do not own, and you do not need to: the deprecated properties still work.

## Migration steps

1. **Wrap the group in `RadioGroup<T>` and move `groupValue` and `onChanged` onto it.** This is the whole migration in one edit. The state variable and `setState` call do not move; only the properties do.

   Before, on Flutter 3.44:

   ```dart
   // Flutter 3.44, Dart 3.12 - deprecated API
   Widget build(BuildContext context) {
     return Column(
       children: <Widget>[
         Radio<Flavor>(
           value: Flavor.vanilla,
           groupValue: _flavor,
           onChanged: (Flavor? v) => setState(() => _flavor = v),
         ),
         Radio<Flavor>(
           value: Flavor.chocolate,
           groupValue: _flavor,
           onChanged: (Flavor? v) => setState(() => _flavor = v),
         ),
       ],
     );
   }
   ```

   After:

   ```dart
   // Flutter 3.44, Dart 3.12 - RadioGroup API
   Widget build(BuildContext context) {
     return RadioGroup<Flavor>(
       groupValue: _flavor,
       onChanged: (Flavor? v) => setState(() => _flavor = v),
       child: const Column(
         children: <Widget>[
           Radio<Flavor>(value: Flavor.vanilla),
           Radio<Flavor>(value: Flavor.chocolate),
         ],
       ),
     );
   }
   ```

   Verify: `flutter analyze` on that file drops from four `deprecated_member_use` infos to zero, and tapping the second radio still updates state.

2. **Always write the type argument explicitly on both the group and the radios.** Type inference will not give you what you expect when the value type is nullable. Write `RadioGroup<Flavor?>` and `Radio<Flavor?>`, never bare `RadioGroup(...)`. The next section explains why this one matters more than it looks.

   Verify: search the diff for `RadioGroup(` with no `<`. Every hit is a latent bug.

3. **Replace `onChanged: null` with `enabled: false` on any radio you were disabling.** In the old API, a null callback was how you greyed out one option. `RadioGroup.onChanged` is `required` and non-nullable, so that lever is gone at the group level and moved onto each radio.

   ```dart
   // Flutter 3.44 - one disabled option inside an otherwise live group
   RadioGroup<int>(
     groupValue: _value,
     onChanged: (int? v) => setState(() => _value = v),
     child: const Column(
       children: <Widget>[
         Radio<int>(value: 0),
         Radio<int>(value: 2, enabled: false),
       ],
     ),
   )
   ```

   Verify: the disabled radio renders grey and its semantics node has `hasEnabledState` without `isEnabled`.

4. **Do the same edit for `RadioListTile` and `CupertinoRadio`.** They take the same `RadioGroup` ancestor. `RadioListTile` also keeps its own `enabled` property, resolved as `widget.enabled ?? (widget.onChanged != null || registry != null)`.

   ```dart
   // Flutter 3.44 - RadioListTile inside a lazy list
   RadioGroup<int>(
     groupValue: _value,
     onChanged: (int? v) => setState(() => _value = v),
     child: ListView.builder(
       itemCount: options.length,
       itemBuilder: (BuildContext context, int i) =>
           RadioListTile<int>(value: i, title: Text(options[i])),
     ),
   )
   ```

   Verify: this works with lazy building. In a 200-item `ListView.builder` with only 11 tiles actually built, tapping item 3 set the group value to 3.

5. **Split mixed groups by type, or nest them.** If one column contains radios of two different value types, wrap the inner set in its own `RadioGroup`. Nesting works because the lookup is by type and, for identical types, the nearest ancestor wins. I confirmed that a `RadioGroup<String>` nested inside another `RadioGroup<String>` routes taps only to the inner group's `onChanged`.

   Verify: tap one radio from each subgroup and confirm each callback fires exactly once.

6. **Run the analyzer and the widget tests.** `flutter analyze` must report zero `deprecated_member_use` hits for radio members, and any test that taps a radio must still pass. Tests are where the silent failure below gets caught.

## Verification

After the migration, run these four checks before you call the screen done:

- `flutter analyze` reports no radio-related `deprecated_member_use` info.
- Every radio still visibly responds to a tap. A migrated radio that renders grey is the failure mode described below, not a styling issue.
- Keyboard: tab into the group, press arrow-down, confirm the selection moves. This is the feature you migrated for, so it is worth actually exercising once per screen.
- Screen reader or `debugDumpSemanticsTree`: a working radio's semantics node carries `isEnabled` and a `tap` action. A dead one carries `hasEnabledState` but not `isEnabled`.

## Rollback plan

This one is genuinely reversible. The deprecated properties still exist on stable 3.44 and are not scheduled for removal in any announced release, so a `git revert` of the migration commit compiles and runs exactly as before. Do the work on a branch anyway, because the failure mode here is silent and you want a clean diff to bisect against.

## The trap: a migrated radio that silently stops working

This is the part the official migration guide does not cover, and it is behind [flutter/flutter#175705](https://github.com/flutter/flutter/issues/175705), an issue that was closed without a diagnosis.

Two facts combine badly.

First, a `Radio` with no `RadioGroup` ancestor and no `onChanged` does not throw. Look at how `_RadioState` resolves it:

```dart
// packages/flutter/lib/src/material/radio.dart, Flutter 3.44 stable
bool get _enabled =>
    widget.enabled ??
    (widget.onChanged != null ||
        widget.groupRegistry != null ||
        RadioGroup.maybeOf<T>(context) != null);
```

With all three null, `_enabled` is `false` and the radio renders as a disabled control. The assertion `'Radio is enabled but has no Radio.onChange or registry above'` only fires if you explicitly pass `enabled: true`. I pumped two `Radio<Flavor>` widgets with no group at all: no exception, and the semantics node came back as `flags: [hasCheckedState, hasEnabledState, isInMutuallyExclusiveGroup]`. Note what is missing: `isEnabled`, and any tap action.

Second, `RadioGroup` is found by exact generic type:

```dart
// packages/flutter/lib/src/widgets/radio_group.dart, Flutter 3.44 stable
static RadioGroupRegistry<T>? maybeOf<T>(BuildContext context) {
  return context.dependOnInheritedWidgetOfExactType<_RadioGroupStateScope<T>>()?.state;
}
```

`dependOnInheritedWidgetOfExactType` means `_RadioGroupStateScope<Flavor>` does not satisfy a lookup for `_RadioGroupStateScope<Flavor?>`. Covariance does not help you here.

Now put those together with Dart's inference. `RadioGroup` declares `T? groupValue`, while `Radio` and `RadioListTile` declare `T value`. Feed both a nullable variable and they infer different type arguments:

```dart
// Flutter 3.44, Dart 3.12
String? selected;
final group = RadioGroup(groupValue: selected, onChanged: (v) {}, child: const SizedBox());
final tile = RadioListTile(value: selected, title: const Text('x'));
// group.runtimeType -> RadioGroup<String>
// tile.runtimeType  -> RadioListTile<String?>
```

Those are the printed runtime types from an actual test run. The group is `RadioGroup<String>`; the tile is `RadioListTile<String?>`. The tile looks up `_RadioGroupStateScope<String?>`, finds nothing, resolves `_enabled` to `false`, and renders dead. No exception, no analyzer warning.

The reproduction is exactly the shape people hit when migrating a "System default" option, where `null` is a legitimate choice. In a group where one tile got `Flavor?` and its sibling got `Flavor`, the semantics came back as:

```text
System  -> flags: [hasEnabledState, hasSelectedState]
Vanilla -> actions: [focus, tap], flags: [hasEnabledState, isEnabled, isFocusable, hasSelectedState]
```

Tapping "System" fired the group's `onChanged` zero times. Tapping "Vanilla" fired it once.

The fix is to pin the type argument on both sides:

```dart
// Flutter 3.44 - explicit nullable type argument on group and tiles
RadioGroup<Flavor?>(
  groupValue: _flavor,
  onChanged: (Flavor? v) => setState(() => _flavor = v),
  child: const Column(
    children: <Widget>[
      RadioListTile<Flavor?>(value: null, title: Text('System')),
      RadioListTile<Flavor?>(value: Flavor.vanilla, title: Text('Vanilla')),
    ],
  ),
)
```

With `RadioGroup<Flavor?>` written out, tapping "System" sets the group value to `null` correctly. That is the answer to the closed issue: nullable values are not disabled by design, the inferred type arguments simply did not match.

## Smaller gotchas worth knowing

**`toggleable` stayed on the radio.** It is not a group-level property. A `Radio<Flavor>(value: Flavor.vanilla, toggleable: true)` inside a `RadioGroup<Flavor>` still calls the group's `onChanged` with `null` when you tap the already-selected option. Verified on 3.44.2. Your `groupValue` therefore has to be nullable if you use it, which loops straight back into the inference trap above.

**There is no group-level disable.** `RadioGroup.onChanged` is required and non-nullable, so you cannot grey out a whole group by nulling one callback the way you used to. Set `enabled: false` on each radio, or map over your options and pass a flag.

**`RadioListTile.selected` is still manual.** The framework documents that "no effort is made to automatically coordinate the selected state and the checked state" and tells you to set `selected: true` when `value` matches `RadioGroup.groupValue`. Migrating does not change that; you still compare by hand.

**Keyboard navigation only reaches built radios.** In a `ListView.builder`, arrow keys can only move through the tiles currently in the widget tree. In my 200-item probe, 11 were built. For a long options list this is a real accessibility limit, and it is a good reason to prefer a bounded `Column` inside a scroll view over lazy building for radio groups. If you need the lazy list anyway, the [infinite-scrolling list patterns](/2026/08/how-to-build-an-infinite-scrolling-paginated-list-in-flutter-with-scrollcontroller/) still apply.

**`Radio.adaptive` is fine.** It forwards `groupRegistry: _effectiveRegistry` and `enabled: _enabled` down to `CupertinoRadio`, so an adaptive radio inside a `RadioGroup` picks up the registry on iOS and macOS without extra work.

**For custom radio-like widgets, implement the registry.** `RadioGroupRegistry<T>` is a small public interface (`groupValue`, `onChanged`, `registerClient`, `unregisterClient`) and `RawRadio` takes a `groupRegistry` directly. That is the supported path if you are building a themed control that should participate in group keyboard navigation. `RawRadio` asserts `'an enabled raw radio must have a registry'`, so wire it before you enable it.

The migration is not urgent, since the deprecated properties still compile on 3.44. It is worth doing anyway, because the accessibility behaviour is not something you can retrofit yourself, and because every screen you leave on the old API is a screen you will migrate later under time pressure. Do it now, write the type arguments out, and let the analyzer tell you when you are done.

## Related

- [Fix: No Material widget found in Flutter](/2026/08/fix-no-material-widget-found-in-flutter/)
- [How to guard setState with the mounted check after an async gap in Flutter](/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/)
- [Migrate from Riverpod 2.x to Riverpod 3.0 in Flutter](/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/)
- [How to dispose controllers in Flutter to avoid memory leaks](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)
- [How to build an infinite-scrolling paginated list in Flutter with ScrollController](/2026/08/how-to-build-an-infinite-scrolling-paginated-list-in-flutter-with-scrollcontroller/)

## Sources

- [Redesigned the Radio widget, Flutter breaking changes](https://docs.flutter.dev/release/breaking-changes/radio-api-redesign)
- [RadioGroup class, Flutter API docs](https://api.flutter.dev/flutter/widgets/RadioGroup-class.html)
- [Radio class, Flutter API docs](https://api.flutter.dev/flutter/material/Radio-class.html)
- [RadioListTile class, Flutter API docs](https://api.flutter.dev/flutter/material/RadioListTile-class.html)
- [Issue 113562: radio button group semantics](https://github.com/flutter/flutter/issues/113562)
- [PR 168161: introduce RadioGroup](https://github.com/flutter/flutter/pull/168161)
- [Issue 175705: RadioGroup null value](https://github.com/flutter/flutter/issues/175705)
- [WAI-ARIA Authoring Practices: radio group pattern](https://www.w3.org/WAI/ARIA/apg/patterns/radio)
