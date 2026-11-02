---
title: "What is a Flutter Key and when does omitting it cause bugs?"
description: "Flutter keys identify stateful rows through a reorder. See when ValueKey is enough, when a lazy builder needs an index callback, and how GlobalKey reparenting works."
pubDate: 2026-09-04
updatedDate: 2026-11-02
tags:
  - "flutter"
  - "dart"
  - "state-management"
  - "listview"
---

A Flutter key helps a parent match a new widget configuration to an existing element. `Widget.canUpdate` checks whether the old and new widgets have the same `runtimeType` and equal keys. An unkeyed row can keep its old state when different data moves into its slot. That matters when the row owns a text controller, focus node or animation associated with a particular item.

**Correction, November 2, 2026.** A stable key alone may be insufficient when a lazy builder changes order, and deactivation does not mean immediate disposal. Five widget tests checked ordinary rows, lazy rows and a `GlobalKey` move on Flutter 3.44.8 / Dart 3.12.2. The examples use the Flutter widgets library.

## Ordinary siblings: key the item, not the position

```dart
import 'package:flutter/widgets.dart';

class RowLabel extends StatefulWidget {
  const RowLabel(this.id, {super.key});
  final String id;

  @override
  State<RowLabel> createState() => _RowLabelState();
}

class _RowLabelState extends State<RowLabel> {
  late final String createdFor = widget.id;

  @override
  Widget build(BuildContext context) => SizedBox(
    height: 48,
    child: Text('row=${widget.id}, state=$createdFor'),
  );
}

Widget rows(List<String> ids, {required bool stableKeys}) => Column(
  children: [
    for (final id in ids)
      RowLabel(id, key: stableKeys ? ValueKey<String>(id) : null),
  ],
);
```

Render `rows(['A', 'B'], stableKeys: false)` under a `Directionality`, then rebuild with `['B', 'A']`. The first row displays `row=B, state=A`: the configuration changed but the state at that position survived. With `stableKeys: true`, the state created for A moves with A. `ValueKey(index)` would identify the old slot rather than the item. IDs must be stable and unique among siblings.

Put the key on the direct child that the parent reorders. If `Padding` wraps each row, key the `Padding`, not only its descendant. A key can also deliberately reset a single-child subtree when switching records. When the effect you need is an animation between two versions of the same widget type, see [AnimatedSwitcher and child keys](/2026/10/how-to-make-animatedswitcher-animate-when-the-child-type-does-not-change/).

## Lazy builders: map keys back to the new indices

`ListView.builder` creates children on demand. When the order changes, provide `findChildIndexCallback` so its delegate can locate the current index of a previously built child. Build the lookup from the same ordered data used by `itemBuilder`, and return `null` for removed IDs:

```dart
Widget lazyRows(List<String> ids, {bool remap = true}) {
  final indexById = {for (var i = 0; i < ids.length; i++) ids[i]: i};
  int? indexForKey(Key key) => key is ValueKey<String> ? indexById[key.value] : null;

  return ListView.builder(
    itemCount: ids.length,
    findChildIndexCallback: remap ? indexForKey : null,
    itemBuilder: (_, index) {
      final id = ids[index];
      return RowLabel(id, key: ValueKey<String>(id));
    },
  );
}
```

The test reordered `[A, B, C]` to `[C, B, A]` while all rows were visible. With the callback, A retained the same `State` object. With `remap: false`, A received a new state in this fixture. Flutter documents that missing index mapping **can** cause state loss. A key also does not guarantee that an offscreen child remains alive. Store durable item data in the model and choose keep-alive behavior for the rows that need it.

## Deactivate, reinsert or dispose

A compatible stateful element can receive a new widget configuration without creating a new `State`. Removing an element first deactivates it. A subtree with a `GlobalKey` can be reinserted under a different parent in the same frame and activated with its state intact. If removal is permanent, Flutter disposes the state after deactivation.

In the test, moving a globally keyed child between two parents produced `init → deactivate → activate` with the same state object. Removing it on the next frame produced `deactivate → dispose`. Release owned controllers in `dispose`; do not assume every `deactivate` is final. See [controller disposal](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) and [accessing ancestors after deactivation](/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/).

## Choose the smallest identity you need

| Key | What it identifies |
| --- | --- |
| `ValueKey(id)` | Equal type and value. Use a stable domain ID for ordinary rows. |
| `ObjectKey(object)` | The same object instance. Recreating the model can change identity. |
| `UniqueKey()` | One particular key instance. A fresh key in every build causes repeated replacement. |
| `PageStorageKey(value)` | A storage location within `PageStorage`, commonly for saved scroll positions. It does not preserve a whole state object. |
| `GlobalKey` | A unique identity across the tree, suitable for same-frame reparenting or access to an associated state. Keep the key instance outside `build`. |

For fixed stateless children, or an append-only sequence where state should follow its slot, an explicit key may add no benefit. Use an item key when state must follow the item through edits.

## Sources

- [Widget.canUpdate](https://api.flutter.dev/flutter/widgets/Widget/canUpdate.html)
- [Inside Flutter: linear reconciliation](https://docs.flutter.dev/resources/inside-flutter)
- [SliverChildBuilderDelegate.findChildIndexCallback](https://api.flutter.dev/flutter/widgets/SliverChildBuilderDelegate/findChildIndexCallback.html)
- [State.deactivate](https://api.flutter.dev/flutter/widgets/State/deactivate.html) · [GlobalKey](https://api.flutter.dev/flutter/widgets/GlobalKey-class.html)
- [PageStorageKey](https://api.flutter.dev/flutter/widgets/PageStorageKey-class.html)
