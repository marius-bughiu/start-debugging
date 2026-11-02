---
title: "Fix: LateInitializationError: Field '...' has not been initialized in Flutter"
description: "Fix reads of uninitialized late fields in Flutter. Choose synchronous initialization or explicit loading/error/data state, with tested lifecycle-safe code."
pubDate: 2026-06-24
updatedDate: 2026-11-02
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
---

A read of an unassigned `late` field causes `LateInitializationError`. Follow the first frame in your own code to find the read, then check which path should have assigned the field. `late` does not wait for an asynchronous operation to finish. The examples below were checked with Flutter 3.44.8 and Dart 3.12.2.

## Reproduce the error

This program compiles, then fails when `name` is read:

```dart
class Profile {
  late String name;
}

void main() {
  print(Profile().name);
}
```

The Dart VM reports `LateInitializationError: Field 'name' has not been initialized.` Treat the wording as a diagnostic, not as the name of a public `dart:core` class you must import or catch. Fix the missing initialization instead of hiding the error.

## Represent loading, failure, and data

A network request started from `initState()` can still be pending at the first `build()`. This complete widget uses nullable state and handles both success and failure. Pass your asynchronous function as `loadName`:

```dart
import 'package:flutter/material.dart';

class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key, required this.loadName});
  final Future<String> Function() loadName;

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  String? _name;
  Object? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final name = await widget.loadName();
      if (!mounted) return;
      setState(() => _name = name);
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = error);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null) return Text('Failed: $_error');
    final name = _name;
    if (name == null) return const CircularProgressIndicator();
    return Text(name);
  }
}
```

This example loads once for each `State` instance. If the request depends on changing widget inputs, also handle those changes in `didUpdateWidget`, or use a keyed widget/provider. The `mounted` checks prevent a completion from updating disposed state; they do not cancel the request. A `FutureBuilder` with a stored Future or an `AsyncValue` is also valid. A field holding a Future can itself be `late final` if assigned before it is read; the Future's result may arrive later.

## Choose initialization by dependency

- **Synchronous value:** assign it before the first read, usually in `initState()` when it needs `widget`. For a `TextEditingController`, also dispose it in `dispose()`.
- **Lazy value:** `late final value = compute();` runs its initializer on first access. A late instance initializer can access instance members, including `widget` in a `State`; ensure the first access occurs at an appropriate lifecycle stage. An initializer can still throw or recurse, so adding one is not a general guarantee against failure.
- **Inherited dependency:** calls that register an inherited dependency, such as `Theme.of(context)`, belong in `build()` or `didChangeDependencies()`, not `initState()`. The latter hook runs before the first build and again when dependencies change. This restriction is about dependency registration, not every possible use of `context`.

## Similar errors and misleading fixes

Assigning a `late final` field twice produces the already-initialized variant. Use a mutable field only if reassignment is intended; otherwise remove the duplicate assignment. `late` does not disable every analyzer check: Dart diagnoses a definitely unassigned late local variable and some repeated assignments to late final locals. Runtime checks still matter where static analysis cannot prove the flow. They are not debug-only assertions, and exact messages can vary by backend/build mode.

The rule is to establish readiness before a read, or represent the pending state explicitly. An `await` alone does not make `late` wrong if all consumers await readiness first; a widget that reads the value before that point is the bug.

**Correction, 2 November 2026:** corrected the claims about analyzer checks, lazy access to instance members, inherited dependencies, and release-mode diagnostics; removed the nonexistent public error-class API reference. The revised loading widget was analyzed and widget-tested for success, error, and disposal.

## Sources and related reading

- [Dart: late variables](https://dart.dev/language/variables#late-variables)
- [Dart: definitely_unassigned_late_local_variable](https://dart.dev/tools/diagnostics/definitely_unassigned_late_local_variable)
- [Flutter: initState](https://api.flutter.dev/flutter/widgets/State/initState.html)
- [Flutter: didChangeDependencies](https://api.flutter.dev/flutter/widgets/State/didChangeDependencies.html)
- [Dart: null safety](https://dart.dev/null-safety/understanding-null-safety#late-variables)

- [BuildContext / await](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/)
- [AsyncValue](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)
- [TextEditingController / dispose](/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/)
- [Controllers / dispose](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)
- [Flutter 2 → 3.x / null safety](/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/)
