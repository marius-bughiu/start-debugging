---
title: "How to remove items from a Dart List while iterating over it without a ConcurrentModificationError"
description: "Calling remove inside a for-in loop or forEach throws ConcurrentModificationError. Use removeWhere for in-place filtering, build a new list with where or a collection-for, or loop backwards by index. Verified on Dart 3.13.7, with a benchmark of why removeAt in a loop is the slow option."
pubDate: 2026-10-25
template: how-to
tags:
  - "dart"
  - "flutter"
  - "collections"
  - "errors"
---

**Short answer:** you cannot call `remove`, `removeAt`, or `add` on a `List` while a `for (final x in list)` loop or `list.forEach` is walking it, because the iterator checks the list's length on every step and throws `ConcurrentModificationError` the moment it changes. Replace the loop with `list.removeWhere((x) => condition)` to filter in place, or build a new list with `list.where((x) => !condition).toList()` (or a collection-for) when you want an immutable update. If you genuinely need an index loop, walk it backwards from `list.length - 1` to `0`. Everything below was run on Dart 3.13.7 (the SDK that ships with Flutter 3.47.8), on the VM, as AOT, and compiled to JavaScript.

## The error in context

This is the code almost everyone writes first:

```dart
// Dart 3.13.7
void main() {
  final numbers = [1, 2, 3];
  for (final n in numbers) {
    if (n == 1) numbers.remove(n);
  }
}
```

And this is what the VM prints:

```
Unhandled exception:
Concurrent modification during iteration: Instance(length:2) of '_GrowableList'.
#0      ListIterator.moveNext (dart:_internal/iterable.dart:366:7)
#1      main (file:///.../main.dart:4:19)
```

The `length:2` in the message is the list's length *after* your modification, and `_GrowableList` is the VM's implementation class for a normal `[]` literal. On the web the same code fails with `Concurrent modification during iteration: Instance of 'JSArray<int>'.`, so do not grep your logs for `_GrowableList` if the bug report came from a Flutter web build. Maps and sets produce their own variants, `_Map len:2.` and `_Set len:2.`, with the same root cause.

## Why the iterator throws instead of just skipping ahead

A `for-in` loop over a `List` is sugar for grabbing `list.iterator` and calling `moveNext()` until it returns `false`. The iterator Dart uses for lists, `ListIterator` in `dart:_internal`, records the list's length when it is created and compares it on every `moveNext()`:

```dart
// dart:_internal, sdk/lib/internal/iterable.dart (Dart 3.13.7)
bool moveNext() {
  int length = _iterable.length;
  if (_length != length) {
    throw ConcurrentModificationError(_iterable);
  }
  if (_index >= length) {
    _current = null;
    return false;
  }
  _current = _iterable.elementAt(_index);
  _index++;
  return true;
}
```

`List.forEach` does the same check after each callback, `removeWhere` checks inside its own loop, and the error is thrown on the *next* step, not at the line that mutated the list. That is why the stack trace points at `moveNext` and not at `remove`.

The [`Iterable` documentation](https://api.dart.dev/dart-core/Iterable-class.html) states the contract plainly: changing a collection while it is being iterated is generally not allowed, and the break is "typically signalled by throwing a ConcurrentModificationError the next time Iterator.moveNext is called." The check exists because the alternative is worse. Removing element `i` shifts everything after it one slot left, so an index-based iterator would silently skip the element that slid into slot `i`. Dart chooses to fail loudly.

Two consequences of "the next `moveNext()`" surprise people:

- **Removing the last element still throws.** You might expect that removing `4` from `[1, 2, 3, 4]` on the final iteration is safe because there is nothing left to visit. It is not. The loop calls `moveNext()` one more time to discover it is finished, sees the length changed, and throws.
- **Adding throws too.** `numbers.add(x)` inside the loop changes the length just like `remove` does. Dart has no `Iterator.remove()` like Java's, so there is no "safe" way to mutate through the iterator itself.

## Pick the right fix

Here is the decision order I use. Each option is covered in detail below.

1. If you want to drop elements from the existing list in place, call `removeWhere` (or `retainWhere` for the inverse).
2. If the list is part of immutable state (Riverpod, Bloc, `ValueNotifier`, a `final` field passed to widgets), build a new list with `where(...).toList()` or a collection-for and assign it.
3. If the removal decision depends on the index or on neighbouring elements, loop backwards by index and use `removeAt`.
4. If the loop body does a lot of work and only some of it removes items, iterate a copy (`for (final x in list.toList())`) and remove from the original.

## Fix 1: `removeWhere` for in-place filtering

This is the canonical answer and it should be your default:

```dart
// Dart 3.13.7
void main() {
  final numbers = [1, 2, 2, 3];
  numbers.removeWhere((n) => n == 2);
  print(numbers); // [1, 3]

  final tasks = <({String title, bool done})>[
    (title: 'write post', done: true),
    (title: 'review PR', done: false),
  ];
  tasks.retainWhere((t) => !t.done);
  print(tasks); // [(done: false, title: review PR)]
}
```

`removeWhere` is a single pass. In the shared `ListBase` implementation it walks the list once, collects the survivors, then writes them back with one `setRange` and truncates the length. It removes every match, unlike `remove`, which only removes the first element equal to its argument. It is also the fastest option by a wide margin, see the benchmark further down.

Maps and sets have the same method. `map.removeWhere((key, value) => value == 2)` and `set.removeWhere((x) => x.isEven)` are the fixes for the `_Map` and `_Set` versions of this error.

One rule still applies inside the predicate: do not mutate the list from within `test`. A predicate that calls `numbers.add(...)` throws `ConcurrentModificationError` from inside `removeWhere`, for the same reason the `for-in` loop did.

## Fix 2: build a new list instead of mutating

If the list belongs to state that other code holds a reference to, mutating it in place is the real bug, and the `ConcurrentModificationError` is just the symptom that happened to surface. Build a new list:

```dart
// Dart 3.13.7
void main() {
  final numbers = [1, 2, 3, 4];

  final odds = numbers.where((n) => n.isOdd).toList();
  final alsoOdds = [for (final n in numbers) if (n.isOdd) n];

  print(odds);     // [1, 3]
  print(alsoOdds); // [1, 3]
  print(numbers);  // [1, 2, 3, 4], untouched
}
```

In Flutter this is the shape you want for anything that drives a rebuild:

```dart
// Flutter 3.47.8, Dart 3.13.7, flutter_riverpod 3.x
class TodoList extends Notifier<List<Todo>> {
  @override
  List<Todo> build() => const [];

  void clearCompleted() {
    state = [for (final t in state) if (!t.done) t];
  }
}
```

Riverpod, Bloc, and `ValueNotifier` only notify listeners when a new value is assigned and it differs from the old one. Calling `state.removeWhere(...)` mutates the same list instance without assigning anything, so nothing rebuilds, and if `state` was created with `const []` or `List.unmodifiable`, it throws `UnsupportedError: Cannot remove from an unmodifiable list` instead. If you are moving a `setState` widget toward that model, the [setState to Riverpod Notifier migration](/2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter/) walks through the rest of the conversion.

Watch out for laziness. `where` returns a lazy `Iterable` that reads from the original list as you consume it, so this still throws:

```dart
// Dart 3.13.7: throws ConcurrentModificationError
for (final n in numbers.where((n) => n.isEven)) {
  numbers.remove(n);
}
```

The `.toList()` is what materializes the result and breaks the link to the source.

## Fix 3: loop backwards by index

Sometimes the decision depends on the position: "remove an item if it equals the previous one", or "remove every entry after the first error". An index loop is fine here, as long as it runs backwards:

```dart
// Dart 3.13.7
void main() {
  final values = [1, 2, 2, 3, 3, 3, 4];

  // Remove consecutive duplicates.
  for (var i = values.length - 1; i > 0; i--) {
    if (values[i] == values[i - 1]) values.removeAt(i);
  }
  print(values); // [1, 2, 3, 4]
}
```

Index loops never touch the iterator, so they never throw `ConcurrentModificationError`. That does not make a forward loop correct:

```dart
// Dart 3.13.7: no exception, wrong answer for adjacent matches
final numbers = [1, 2, 2, 3];
for (var i = 0; i < numbers.length; i++) {
  if (numbers[i] == 2) numbers.removeAt(i);
}
print(numbers); // [1, 2, 3]  (one 2 survived)
```

When `removeAt(1)` runs, the second `2` slides into index 1, then `i++` moves past it. Walking backwards avoids this because removing index `i` only shifts elements you have already visited. If you insist on a forward loop, only increment `i` when you did not remove, but the backwards loop is harder to get wrong.

## Fix 4: iterate over a copy

When the loop body is doing real work (logging, firing callbacks, updating other structures) and removal is a side effect of some iterations, iterating a snapshot keeps the code readable:

```dart
// Dart 3.13.7
void main() {
  final pending = [1, 2, 2, 3];
  for (final job in pending.toList()) {
    final ok = job != 2; // pretend this ran the job
    if (ok) pending.remove(job);
  }
  print(pending); // [2, 2]
}
```

`toList()` costs one allocation and one copy of the references, which is negligible for UI-sized lists. Keep in mind that `remove(job)` removes the *first* element equal to `job`, which is fine for unique objects and surprising for duplicated values. For a `Map`, the equivalent is `for (final key in map.keys.toList())`.

## Why `removeAt` in a loop is the slow option

Every `removeAt(i)` shifts all elements after `i` one slot to the left, so removing `k` items from a list of `n` costs roughly `O(n * k)` element moves. `removeWhere` and `where(...).toList()` are a single `O(n)` pass. I measured all three on a 200,000-element `List<int>`, removing the 100,000 even numbers, compiled with `dart compile exe` on an Apple Silicon Mac:

```dart
// Dart 3.13.7, dart compile exe, macOS arm64
void main() {
  const n = 200000;
  var a = List<int>.generate(n, (i) => i);
  var sw = Stopwatch()..start();
  for (var i = a.length - 1; i >= 0; i--) {
    if (a[i].isEven) a.removeAt(i);
  }
  print('removeAt backwards: ${sw.elapsedMilliseconds} ms');

  var b = List<int>.generate(n, (i) => i);
  sw = Stopwatch()..start();
  b.removeWhere((x) => x.isEven);
  print('removeWhere: ${sw.elapsedMicroseconds} us');

  var c = List<int>.generate(n, (i) => i);
  sw = Stopwatch()..start();
  final d = c.where((x) => x.isOdd).toList();
  print('where.toList: ${sw.elapsedMicroseconds} us (${d.length})');
}
```

| Approach | Time (median of 3 runs) |
| --- | --- |
| backwards `removeAt` loop | ~3,720 ms |
| `removeWhere` | ~1.0 ms |
| `where(...).toList()` | ~1.45 ms |

That is three and a half orders of magnitude. For a 20-item list of todos, none of this matters and you should pick whichever version reads best. For anything that processes data (parsed CSV rows, log entries, a cache sweep), use `removeWhere` and save the index loop for logic that truly needs positions. If you do need to process a very large list off the UI thread, [running the work in a Dart isolate](/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) keeps frames smooth, but it does not fix an `O(n^2)` loop.

## When you also need the removed items

`removeWhere` returns `void`, so you cannot see what it dropped. The tempting fix calls the predicate twice:

```dart
final removed = items.where(isExpired).toList();
items.removeWhere(isExpired);
```

That is correct only if `isExpired` is deterministic. If it reads `DateTime.now()`, an item can expire between the two calls and vanish without appearing in `removed`. Partition in a single pass instead:

```dart
// Dart 3.13.7
extension RemoveAndCollect<E> on List<E> {
  List<E> removeWhereAndCollect(bool Function(E element) test) {
    final removed = <E>[];
    final kept = <E>[];
    for (final e in this) {
      (test(e) ? removed : kept).add(e);
    }
    if (removed.isNotEmpty) {
      setRange(0, kept.length, kept);
      length = kept.length;
    }
    return removed;
  }
}

void main() {
  final items = [1, 2, 3, 4, 5];
  final evens = items.removeWhereAndCollect((x) => x.isEven);
  print(items); // [1, 3, 5]
  print(evens); // [2, 4]
}
```

The `for-in` here is safe because nothing mutates `this` until the loop has finished.

## Gotchas that hide the error or change it

**Remove-then-add in the same iteration silently corrupts the loop.** The iterator only compares lengths. If one iteration removes an element and adds another, the length is unchanged and nothing throws:

```dart
// Dart 3.13.7: no exception, element 3 is never visited
final l = [1, 2, 3, 4];
for (final x in l) {
  print('visit $x'); // visit 1, visit 2, visit 4, visit 20
  if (x == 2) {
    l.remove(x);
    l.add(20);
  }
}
```

`3` slid into the slot that was already visited and was skipped. The absence of a `ConcurrentModificationError` is not proof the code is correct. Replacing an element in place, `l[i] = newValue`, is legitimately fine, because it never changes the length and never shifts anything.

**An `await` inside the loop opens the door to other code.** This is the version that shows up in Flutter apps as an intermittent crash:

```dart
// Dart 3.13.7
import 'dart:async';

Future<void> main() async {
  final items = [1, 2, 3];
  Timer(const Duration(milliseconds: 5), () => items.removeAt(0));

  for (final x in items) {
    await Future<void>.delayed(const Duration(milliseconds: 10));
    print('processed $x');
  }
  // processed 1, then ConcurrentModificationError
}
```

Nothing inside the loop body touches `items`. A timer, a stream listener, or a button tap handler that runs during the `await` does. The fix is the same as Fix 4: iterate `items.toList()`, or make the shared list immutable and replace it. If the async loop lives in a `State`, the same gap is where you also need the [mounted check before calling setState](/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/), and an un-awaited call in the loop is exactly what the [`unawaited_futures` and `discarded_futures` lints](/2026/10/unawaited-futures-vs-discarded-futures-lint-in-dart/) are there to catch.

**Maps tolerate value updates, not key changes.** `for (final k in map.keys) map[k] = 0;` is fine because updating an existing key does not change the map's structure. `map.remove(k)` or adding a new key throws. Removing a key that is not present is a no-op and does not throw.

**`addAll` on itself throws immediately.** `list.addAll(list)` on a VM growable list throws `ConcurrentModificationError` without any loop in sight. Use `list.addAll(list.toList())` or `[...list, ...list]`.

**Fixed-length and unmodifiable lists throw `UnsupportedError`, not this error.** `List.filled(3, 0).removeWhere(...)` throws `Unsupported operation: Cannot remove from a fixed-length list`, and a `const` list or `List.unmodifiable` throws `Cannot remove from an unmodifiable list`. The [`removeWhere` docs](https://api.dart.dev/dart-core/List/removeWhere.html) call this out: the list must be growable. Use Fix 2 for those.

**Removing from a list that backs a `ListView` needs keys.** After `setState(() => _items.removeWhere(...))`, Flutter matches the old and new children by position unless you give them keys, so per-item state (a checkbox, a text field, an animation) can jump to the wrong row. The [post on Flutter keys](/2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs/) covers the `ValueKey(item.id)` fix.

### Read next

- [How to guard setState with the mounted check after an async gap in Flutter](/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/)
- [What is a Flutter Key and when does omitting it cause bugs?](/2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs/)
- [Migrate a setState StatefulWidget to a Riverpod Notifier](/2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter/)
- [unawaited_futures vs discarded_futures lint in Dart](/2026/10/unawaited-futures-vs-discarded-futures-lint-in-dart/)

### Sources

- [`Iterable` class documentation](https://api.dart.dev/dart-core/Iterable-class.html), section on changing a collection during iteration
- [`ConcurrentModificationError` class](https://api.dart.dev/dart-core/ConcurrentModificationError-class.html)
- [`List.removeWhere`](https://api.dart.dev/dart-core/List/removeWhere.html) and [`List.retainWhere`](https://api.dart.dev/dart-core/List/retainWhere.html)
- Dart SDK source: [`ListIterator.moveNext` in `sdk/lib/internal/iterable.dart`](https://github.com/dart-lang/sdk/blob/main/sdk/lib/internal/iterable.dart) and [`ListBase._filter` in `sdk/lib/collection/list.dart`](https://github.com/dart-lang/sdk/blob/main/sdk/lib/collection/list.dart)
