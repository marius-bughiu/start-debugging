---
title: "What is a Flutter Key and when does omitting it cause bugs?"
description: "A Key is the identity half of Widget.canUpdate, the one line of framework code that decides whether an Element and its State are reused or thrown away. Here is what that means in practice, the exact list edits that corrupt state without keys, which key type to reach for, and where the key has to sit to work."
pubDate: 2026-09-04
tags:
  - "flutter"
  - "dart"
  - "state-management"
  - "listview"
---

A `Key` is the identity half of the only comparison Flutter uses to decide whether an existing `Element` (and the `State` hanging off it) can be reused for a new `Widget`. That comparison is `oldWidget.runtimeType == newWidget.runtimeType && oldWidget.key == newWidget.key`. With no key, children of the same type match purely by position in the child list, so any edit that moves an item (a reorder, a removal from the middle, a filter) leaves state attached to the old slot while the data slides to a different one. You need a key exactly when a widget with state can change position among its siblings. Everything below targets the current stable channel, Flutter 3.47.2 with Dart 3.13.2, but the reconciliation rules have been unchanged since Flutter 1.

## Keys are an input to canUpdate, and nothing else

The framework keeps three parallel trees: your immutable `Widget` configuration, the `Element` tree that persists across rebuilds, and the `RenderObject` tree that lays out and paints. `State` objects belong to elements, not to widgets. When a parent rebuilds, every child position is resolved through `Element.updateChild`, which asks one question:

```dart
// package:flutter/src/widgets/framework.dart, Flutter 3.47.2
static bool canUpdate(Widget oldWidget, Widget newWidget) {
  return oldWidget.runtimeType == newWidget.runtimeType &&
      oldWidget.key == newWidget.key;
}
```

If that returns `true`, the existing element is kept and reconfigured: its `State` survives, `didUpdateWidget` runs, `initState` does not. If it returns `false`, the old element is deactivated and a brand new element is inflated, which means `dispose` on the way out and `initState` on the way in. If the new widget is null the child is removed outright.

Two consequences fall straight out of that signature. First, a null key is a perfectly valid key value, and `null == null` is `true`, so two unkeyed widgets of the same type always match. Second, keys never compare across parents: they are only ever consulted among the children of one element. The docs put the constraint plainly, that keys must be unique among the elements with the same parent.

## The reconciliation pass that decides which child is which

Contrary to the usual assumption, Flutter does not run a general tree diff. Each element reconciles its own child list with a linear, `O(N)` pass described in [Inside Flutter](https://docs.flutter.dev/resources/inside-flutter):

1. Walk both lists from the top, matching while `runtimeType` and `key` agree.
2. Walk both lists from the bottom, doing the same.
3. Whatever unmatched range is left in the middle: put the old children into a hash table keyed by their `key`, then walk the new middle range and look each one up.
4. Old children with no match are unmounted; new widgets with no match get fresh elements.

Step 3 is where keys earn their keep. An unkeyed child has nothing to put in the hash table, so it can only ever be matched by the positional scans in steps 1 and 2. That is why unkeyed lists survive appending to the end (step 1 matches everything, then the tail is new) and quietly break on anything else.

## The minimal repro: state that stays behind

Two tiles, each picking a color once in its own `State`, plus a button that reverses the list. Nothing here is exotic. Since Flutter 3.47 the Material widgets live in the standalone package, so the import differs from older samples; see the walkthrough of [moving your imports onto material_ui](/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/) if yours still point at the SDK copy.

```dart
// Flutter 3.47.2, Dart 3.13.2
import 'dart:math';
import 'package:material_ui/material_ui.dart';

class ColorTile extends StatefulWidget {
  const ColorTile({super.key, required this.label});

  final String label;

  @override
  State<ColorTile> createState() => _ColorTileState();
}

class _ColorTileState extends State<ColorTile> {
  // Chosen once when the State is created, and never again.
  late final Color color = Color(0xFF000000 | Random().nextInt(0xFFFFFF));

  @override
  Widget build(BuildContext context) => Container(
        width: 120,
        height: 120,
        color: color,
        alignment: Alignment.center,
        child: Text(widget.label),
      );
}
```

```dart
// Flutter 3.47.2, Dart 3.13.2
class _TileSwapperState extends State<TileSwapper> {
  List<String> labels = ['A', 'B'];

  @override
  Widget build(BuildContext context) => Column(
        children: [
          Row(
            // No keys.
            children: [for (final l in labels) ColorTile(label: l)],
          ),
          TextButton(
            onPressed: () => setState(() => labels = labels.reversed.toList()),
            child: const Text('Swap'),
          ),
        ],
      );
}
```

Press Swap and the letters trade places but the colors do not move. Slot 0 held a `ColorTile` with a null key, the new slot 0 is a `ColorTile` with a null key, `canUpdate` returns `true`, so the element and its `_ColorTileState` are reused and only `widget.label` changes. The color is state, and state stayed where it was.

Adding an identity fixes it:

```dart
// Flutter 3.47.2, Dart 3.13.2
children: [for (final l in labels) ColorTile(key: ValueKey(l), label: l)],
```

Now the positional scans fail at both ends, both children fall into the middle range, the hash table maps `ValueKey('A')` to the element that was at slot 0, and that element is reparented to slot 1 with its color intact.

## The version of this bug that reaches production

A random color is a toy. The same mechanism corrupts real data whenever the state lives inside a row widget:

```dart
// Flutter 3.47.2, Dart 3.13.2
// Each row owns a TextEditingController in its State.
Column(
  children: [
    for (final task in tasks) TaskRow(task: task), // no key
  ],
)
```

Delete the task at index 0. The list shrinks by one and every remaining task shifts up. Reconciliation matches old slot 0 to new slot 0, so the controller holding the half-typed note for the deleted task is now sitting in the row rendering the *next* task. `didUpdateWidget` fires with a different `widget.task`, but the controller text, the scroll offset, the checkbox, the expanded flag, the focus node, none of that is derived from `widget` so none of it moves. The user sees their text against someone else's record, and when they hit save you write it there. The same shape shows up with expansion tiles keeping the wrong panel open, animations restarting on the wrong row, and form validation errors attached to a field the user never touched. Controllers created per row also need the usual lifecycle discipline, which is a separate and equally common leak: see [disposing controllers in Flutter](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).

`ValueKey(task.id)` on `TaskRow` fixes all of it at once.

## Put the key on the outermost widget in the list

Keys are matched among siblings under one parent. If you wrap the row, the wrapper is the sibling, so the wrapper is what needs the key:

```dart
// Wrong: Padding is unkeyed, so Paddings match positionally. The TaskRows
// inside then get compared slot-for-slot, their keys disagree, canUpdate
// returns false, and every row's State is destroyed and rebuilt.
for (final task in tasks)
  Padding(
    padding: const EdgeInsets.all(8),
    child: TaskRow(key: ValueKey(task.id), task: task),
  ),

// Right: the key sits on the widget that is directly a child of the list.
for (final task in tasks)
  Padding(
    key: ValueKey(task.id),
    padding: const EdgeInsets.all(8),
    child: TaskRow(task: task),
  ),
```

The wrong version is worse than no key at all: instead of misassigning state it throws it away on every reorder, which reads as flicker, restarted animations, and cleared text fields.

The other guaranteed way to write a key that does nothing is `ValueKey(index)`. The index *is* the positional identity you already had, so keying on it reproduces the unkeyed behaviour exactly while looking like a fix. Key on something the item owns: a database id, a UUID, a slug.

## Which key type

| Type | Identity | Reach for it when |
| ---- | -------- | ----------------- |
| `ValueKey<T>(v)` | `runtimeType` and `v ==` | The item has a stable domain value: id, slug, ISO date string. The default choice. |
| `ObjectKey(o)` | `identical(o, other.value)` | The model overrides `==` by value (records, Freezed classes) but two equal instances must stay distinct. |
| `UniqueKey()` | Equal only to itself | You want to force one fresh subtree, once. Never construct one inside `build`; a new instance every frame means `canUpdate` is false every frame and the subtree is rebuilt from zero forever. |
| `PageStorageKey<T>(v)` | A `ValueKey` that also names a slot in the enclosing `PageStorage` | Preserving a scroll offset across a route push or tab switch, where the element itself is destroyed. |
| `GlobalKey` | Unique across the whole app; exposes `currentState`, `currentContext`, `currentWidget` | Moving a subtree to a different parent with its state, or reaching a `FormState` from outside its subtree. |

`Key('some string')` is a factory that returns `ValueKey<String>`, so it is the same thing with fewer characters.

## GlobalKey is a different tool with a real price

A `GlobalKey` is the only key that works across parents, which is what makes reparenting a subtree possible, and it is the only one that hands you the child's `State`:

```dart
// Flutter 3.47.2, Dart 3.13.2
class _CheckoutFormState extends State<CheckoutForm> {
  // Long-lived: a field on the State, not a local in build().
  final _formKey = GlobalKey<FormState>();

  void _submit() {
    if (_formKey.currentState?.validate() ?? false) {
      _formKey.currentState!.save();
    }
  }

  @override
  Widget build(BuildContext context) => Form(key: _formKey, child: /* ... */);
}
```

Three things bite here. Reparenting through a `GlobalKey` is documented as relatively expensive: it triggers `State.deactivate` and forces every widget that depends on an `InheritedWidget` in that subtree to rebuild, which is also the fastest route to [looking up a deactivated widget's ancestor](/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/). Constructing the key inside `build` destroys the subtree's state on every frame, and does it silently: a `GestureDetector` under a regenerated `GlobalKey` simply stops tracking gestures mid-drag. And two live widgets carrying the same `GlobalKey` is an assertion, "Multiple widgets used the same GlobalKey", which is why a shared widget instance reused in two branches of a `TabBarView` or under nested `Navigator`s crashes rather than degrading.

Use a `LocalKey` unless you specifically need cross-parent identity or `currentState`.

## Keys also work in reverse: forcing a reset

Because `canUpdate` returning false means dispose-then-initState, changing a key on purpose is the cleanest way to reset a subtree. A detail pane that switches records inside the same route is the standard case:

```dart
// Flutter 3.47.2, Dart 3.13.2
// Without the key, switching selectedOrderId reuses the same State, so the
// TextEditingController inside OrderEditor still holds the previous order's
// notes and any AnimationController keeps its current value.
OrderEditor(
  key: ValueKey(selectedOrderId),
  orderId: selectedOrderId,
)
```

This is the same failure that makes a `Future` created in `build` re-fire on unrelated rebuilds, from the other direction: sometimes you want the reset, sometimes you want to prevent it, and the deciding question is always whether the identity changed. The [FutureBuilder version of that problem](/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/) is worth reading alongside this.

Two widgets make the key mandatory rather than advisory: `Dismissible` asserts on a null key, because a swipe-to-remove that matched positionally would animate away the wrong row, and `ReorderableListView` requires a key on every child for exactly the same reason.

## When you can leave the key out

- **The subtree has no state.** If everything below the child is stateless and every pixel is derived from the widget's own fields, positional matching produces correct output. Reordering unkeyed stateless children costs some extra rebuild work but is not a correctness bug.
- **The list only ever grows at the end.** Append-only feeds are fully covered by the top-down scan.
- **Adjacent children already differ in `runtimeType`.** `canUpdate` is false regardless, so a key changes nothing.
- **You are keying a single child that never has siblings.** A `Scaffold`'s `body` has one slot; there is nothing to disambiguate.

The `super.key` parameter on every widget constructor is a convention for callers, not a hint that you should be passing something.

## Two limits worth knowing before you trust keys

Keys do not defeat viewport recycling. `ListView.builder` and the sliver family destroy elements once an item scrolls past the cache extent, key or no key, and rebuild them on the way back. If a row must remember something across that boundary, either lift the state into your model or opt into `AutomaticKeepAliveClientMixin`, at the cost of the memory the recycling was saving. This is the same budget question that shows up when you [combine list and grid sections under one scroll view with slivers](/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/).

And duplicate `LocalKey`s among siblings are a debug-mode assertion, "Duplicate keys found. If multiple keyed widgets exist as children of another widget, they must have unique keys", raised by `debugChildrenHaveDuplicateKeys`. It usually means the field you keyed on is not as unique as you assumed, which is a data bug wearing a framework error's clothes.

The deeper point is that a key is a repair for reconciliation, not for architecture. Every one of the bugs above exists because per-item state lives inside a widget's `State`, where its identity is positional by default. State that belongs to a task should live with the task, and once it does, the reordering question stops being a question. That is most of the argument for [moving setState state into a Riverpod notifier](/2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter/). Keys are still the right answer for genuinely ephemeral, per-element state such as scroll offsets, focus, and animation controllers, and for those you should place them deliberately rather than sprinkling them.

## Related

- [How to dispose controllers in Flutter to avoid memory leaks](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)
- [Fix: Looking up a deactivated widget's ancestor is unsafe in Flutter](/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/)
- [How to initialize a Future so FutureBuilder does not recreate it on every rebuild](/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/)
- [How to mix a ListView and a GridView in one scroll view with slivers](/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/)
- [Migrate a setState StatefulWidget to a Riverpod Notifier in Flutter](/2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter/)

## Sources

- [Inside Flutter: linear reconciliation](https://docs.flutter.dev/resources/inside-flutter)
- [Widget.canUpdate, Flutter API docs](https://api.flutter.dev/flutter/widgets/Widget/canUpdate.html)
- [Element.updateChild, Flutter API docs](https://api.flutter.dev/flutter/widgets/Element/updateChild.html)
- [Key class, Flutter API docs](https://api.flutter.dev/flutter/foundation/Key-class.html)
- [GlobalKey class, Flutter API docs](https://api.flutter.dev/flutter/widgets/GlobalKey-class.html)
- [PageStorageKey class, Flutter API docs](https://api.flutter.dev/flutter/widgets/PageStorageKey-class.html)
- [debugChildrenHaveDuplicateKeys, Flutter API docs](https://api.flutter.dev/flutter/widgets/debugChildrenHaveDuplicateKeys.html)
- [AutomaticKeepAliveClientMixin, Flutter API docs](https://api.flutter.dev/flutter/widgets/AutomaticKeepAliveClientMixin-mixin.html)
- [What's new in Flutter 3.47, Flutter blog](https://flutter.dev/blog/whats-new-in-flutter-3-47)
