---
title: "unawaited_futures vs discarded_futures in Dart: which lint catches which un-awaited call"
description: "unawaited_futures only looks inside async bodies, discarded_futures only inside sync bodies, and both miss arrow functions, tear-offs, and collection literals. Measured case by case on Dart 3.12.2 and Flutter 3.44.8, with the analysis_options.yaml I recommend."
pubDate: 2026-10-22
template: vs
tags:
  - "comparison"
  - "dart"
  - "flutter"
  - "lints"
  - "async"
---

**Short answer:** the two lints split the work by the kind of function body the call sits in. `unawaited_futures` reports a `Future` that is dropped inside an `async` body. `discarded_futures` reports a `Future` (or `FutureOr`) that is dropped inside a synchronous body, which in Flutter means `initState`, `dispose`, and every `onPressed: () { ... }` block. They never fire on the same line. If you only enable one, enable `unawaited_futures`: it is cheap and every hit is a likely bug. Add `discarded_futures` when you are willing to write `unawaited(...)` at every intentional fire-and-forget call in widget code. Everything below was measured with `dart analyze` on Dart 3.12.2 (Flutter 3.44.8, `meta` 1.19.0).

Neither rule is in `package:lints` core or recommended, nor in `package:flutter_lints` 6.0.0, so a fresh `flutter create` project reports neither until you opt in.

## The comparison at a glance

| | `unawaited_futures` | `discarded_futures` |
| --- | --- | --- |
| Where it looks | statements inside `async` / `async*` bodies | statements inside synchronous bodies |
| Types it reports | `Future` and subtypes (incl. `TickerFuture`) | `Future`, subtypes, and `FutureOr` |
| Available since | long-standing, pre-Dart 2.18 | Dart 2.18 |
| In `lints` / `flutter_lints` | no / no | no / no |
| Typical hit in Flutter | `Navigator.pushNamed(...)` inside `onPressed: () async { ... }` | `_load();` in `initState`, `_controller.forward();` |
| Silenced by `unawaited(...)` | yes | yes |
| Silenced by `@awaitNotRequired` (`meta` 1.17.0+) | yes | yes |
| Bulk fix with `dart fix --apply` | no (IDE quick fix only) | no (IDE quick fix only) |
| Noise level in a Flutter app | low | medium to high |

## Why there are two rules instead of one

Both rules are thin wrappers around the same visitor, `UnusedFuturesVisitor` in `pkg/linter/lib/src/util/unused_futures.dart`. The visitor walks three kinds of nodes: expression statements, cascade sections, and string interpolations. For each expression it asks the rule whether the expression is "interesting", and that filter is the entire difference between the two lints. Here is the filter from `unawaited_futures.dart` at the `3.12.2` tag:

```dart
// dart-lang/sdk, tag 3.12.2, pkg/linter/lib/src/rules/unawaited_futures.dart
isInteresting: (node) {
  var type = node.staticType;
  // This rule is not currently concerned with `FutureOr`.
  if (type == null || !type.isOrImplementsFuture) {
    return false;
  }
  // This rule is only concerned with code in async functions.
  return node.thisOrAncestorOfType<FunctionBody>()?.isAsynchronous ?? false;
},
```

And from `discarded_futures.dart`:

```dart
// dart-lang/sdk, tag 3.12.2, pkg/linter/lib/src/rules/discarded_futures.dart
isInteresting: (node) {
  var type = node.staticType;
  // This rule does concern itself with `FutureOr`.
  if (type == null || !type.isOrImplementsFutureOrFutureOr) {
    return false;
  }
  // This rule is only concerned with code in sync functions.
  return node.thisOrAncestorOfType<FunctionBody>()?.isSynchronous ?? false;
},
```

Two consequences fall straight out of that code. First, the nearest enclosing `FunctionBody` decides, not the outer method. A block closure `() { save(); }` written inside an `async` method is a synchronous body, so it belongs to `discarded_futures`. Second, `FutureOr` is only covered on the synchronous side. A `FutureOr<int>` dropped inside an `async` method is reported by neither rule.

The motivation differs too. `unawaited_futures` targets the forgotten `await`: you are already in an `async` function, so the fix is one keyword. `discarded_futures` targets the forgotten `async`: a synchronous function that kicks off asynchronous work usually means the function itself should have been `async` and its callers should wait for it. The official docs for `discarded_futures` say exactly that, and point to `unawaited_futures` as the rule that takes over once the function is `async`.

## The case file: what fires where

I put every call shape I could think of into one file and ran `dart analyze` with both rules enabled on top of `package:lints/recommended.yaml`:

```yaml
# analysis_options.yaml, Dart 3.12.2
include: package:lints/recommended.yaml
linter:
  rules:
    - unawaited_futures
    - discarded_futures
```

```dart
// Dart 3.12.2, meta 1.19.0
import 'dart:async';
import 'package:meta/meta.dart';

Future<void> save() async {}
FutureOr<int> maybeAsync() => 1;
@awaitNotRequired
Future<void> log(String m) async {}

class Repo {
  Future<void> flush() async {}
}

Future<void> asyncCaller() async {
  save(); // A1
  maybeAsync(); // A2 FutureOr in async
  final f = save(); // A3 assigned
  unawaited(save()); // A4
  log('x'); // A5 awaitNotRequired
  Repo()..flush(); // A6 cascade
  print('${save()}'); // A7 interpolation
  var list = [save()]; // A8 collection
  Future.delayed(Duration.zero, () => 1); // A9
  <String, Future<void>>{}.putIfAbsent('k', save); // A10
  void inner() {
    save(); // A11 sync closure inside async
  }
  [1].forEach((_) async {
    save(); // A12 async closure
  });
  save().then((_) {}); // A13 .then chain
  save().ignore(); // A14 ignore()
  await f;
  inner();
  list.length;
}

void syncCaller() {
  save(); // S1
  maybeAsync(); // S2 FutureOr in sync
  final f = save(); // S3 assigned
  unawaited(save()); // S4
  log('x'); // S5 awaitNotRequired
  Repo()..flush(); // S6 cascade
  takesFuture(save()); // S7 argument
  f.ignore();
}

Future<void> syncReturn() {
  return save(); // S8 returned
}

void takesFuture(Future<void> f) {}

void Function() handler = () => save(); // S9 arrow in sync closure
void Function() handler2 = () {
  save(); // S10 block sync closure
};
Future<void> Function() handler3 = () async {
  save(); // S11 async closure
};
```

The results, read off the `dart analyze` output:

| Case | Code | `unawaited_futures` | `discarded_futures` |
| --- | --- | --- | --- |
| A1 | `save();` in `async` | reported | - |
| A2 | `maybeAsync();` (`FutureOr`) in `async` | - | - |
| A3, S3 | `final f = save();` | - | - |
| A4, S4 | `unawaited(save());` | - | - |
| A5, S5 | `@awaitNotRequired` callee | - | - |
| A6 | `Repo()..flush();` in `async` | reported | - |
| A7 | `'${save()}'` in `async` | reported | - |
| A8 | `[save()]` collection literal | - | - |
| A9 | `Future.delayed(d, computation)` | - | - |
| A10 | `Map.putIfAbsent` | - | - |
| A11 | block closure inside an `async` method | - | reported |
| A12 | `async` closure | reported | - |
| A13 | `save().then((_) {});` | reported (on `then`) | - |
| A14 | `save().ignore();` | - | - |
| S1 | `save();` in sync | - | reported |
| S2 | `maybeAsync();` in sync | - | reported |
| S6 | `Repo()..flush();` in sync | - | reported |
| S7 | `takesFuture(save());` | - | - |
| S8 | `return save();` | - | - |
| S9 | `() => save()` arrow closure | - | - |
| S10 | `() { save(); }` | - | reported |
| S11 | `() async { save(); }` | reported | - |

A few rows deserve a sentence each.

- **A9 and A10 are hard-coded exceptions.** The visitor skips `Future.delayed` when it is called with a computation argument, and `Map.putIfAbsent`, because both return values people routinely ignore on purpose.
- **A13 is reported on `then`, not `save`.** `save().then(...)` returns a new `Future`, and that one is dropped. Chaining a `.then` is not a substitute for handling the result.
- **A14 is clean because `Future.ignore()` returns `void`.** It is the method-call alternative to `unawaited(...)`, available since Dart 2.14. Unlike `unawaited`, it also swallows any error the future completes with, so use it only when you truly do not care.
- **S7 is clean on purpose.** Passing the future to a parameter typed `Future<void>` hands responsibility to the callee.

## The blind spots both rules share

Two rows in that table are real false negatives, and both are tracked upstream.

**Arrow bodies (S9).** `() => save()` is a synchronous expression body that returns the `Future`. The visitor only looks at statements, so nothing fires, even when the closure is assigned to a `void Function()` and the future is thrown away by the caller. This is [dart-lang/sdk#61155](https://github.com/dart-lang/sdk/issues/61155).

**Tear-offs into `void` callbacks.** I also ran this:

```dart
// Dart 3.12.2
void execute(void Function() cb) => cb();

void tearoffs() {
  execute(save); // Future<void> Function() passed as void Function()
}
```

Neither rule reported it. Dart allows a `Future<void> Function()` where a `void Function()` is expected, so the future is discarded inside `execute` and no lint sees it. [dart-lang/sdk#56921](https://github.com/dart-lang/sdk/issues/56921) covers this. The related lint is `avoid_void_async`, which only catches `async` functions declared as returning `void`, not tear-offs.

Add collection literals (A8) and `FutureOr` inside `async` bodies (A2) and you have the full list of shapes where a dropped future goes unreported. `unawaited` also does not accept a `FutureOr` today ([dart-lang/sdk#63818](https://github.com/dart-lang/sdk/issues/63818)), so for S2 the clean fix is `final _ = maybeAsync();` or awaiting it.

## What it looks like in a Flutter widget

The same split is what decides the noise level in a Flutter app, because most widget callbacks are synchronous. On Flutter 3.44.8 with both rules on top of `package:flutter_lints/flutter.yaml`:

```dart
// Flutter 3.44.8, Dart 3.12.2
class _HomeState extends State<Home> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this);

  Future<void> _load() async {}

  @override
  void initState() {
    super.initState();
    _load(); // F1: discarded_futures
    _c.forward(); // F2: discarded_futures (TickerFuture implements Future)
  }

  @override
  Widget build(BuildContext context) {
    return Column(children: [
      TextButton(
        onPressed: () => Navigator.of(context).push(
            MaterialPageRoute<void>(builder: (_) => const Home())), // F3: nothing
        child: const Text('a'),
      ),
      TextButton(
        onPressed: () {
          Navigator.of(context).pushNamed('/x'); // F4: discarded_futures
        },
        child: const Text('b'),
      ),
      TextButton(
        onPressed: () async {
          await _load();
          if (!context.mounted) return;
          Navigator.of(context).pushNamed('/x'); // F5: unawaited_futures
        },
        child: const Text('c'),
      ),
    ]);
  }
}
```

F2 is the one that annoys people. `AnimationController.forward()`, `reverse()`, `repeat()`, and `animateTo()` all return a `TickerFuture`, and almost nobody awaits them. With `discarded_futures` on, every one of them needs `unawaited(...)`. F1, on the other hand, is exactly the bug the rule exists for: `_load()` in `initState` throws its error into the zone instead of into a `try`/`catch` you wrote, and if it calls `setState` after the widget is gone you are in [mounted-check territory](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/).

F3 and F4 do the same thing. Only the block form is reported, which means switching a callback from `{ ... }` to `=>` silences `discarded_futures` without fixing anything.

## When to pick unawaited_futures

- **You want one rule with a near-zero false positive rate.** Inside an `async` function, a dropped `Future` is almost always a forgotten `await`, and the error it carries will skip your `try`/`catch` and land in [`PlatformDispatcher.onError` or your guarded zone](/2026/10/how-to-catch-uncaught-async-errors-in-flutter-with-runzonedguarded-and-platformdispatcher/).
- **You are writing server or CLI Dart.** `main` is usually `async`, so most of your code is covered, and the remaining sync code rarely starts async work.
- **Your team already uses `async` callbacks.** If your handlers are `onPressed: () async { ... }`, this rule covers them (F5).

## When to add discarded_futures

- **You publish a package.** A synchronous public method that silently starts async work is an API smell, and this rule finds every one of them.
- **You want fire-and-forget to be visible in review.** With the rule on, every intentional drop reads as `unawaited(...)` or carries `@awaitNotRequired` on the callee, which is the whole point.
- **You have had a bug from `initState` work that nobody awaited.** That is the F1 case, and only this rule sees it.

If you add it to an existing Flutter app, expect most hits to be `AnimationController` calls and navigation in block callbacks. Neither rule has a `dart fix` bulk fix in Dart 3.12.2 (`dart fix --dry-run` proposed nothing for them in my repro), so unlike the [migrations you can apply repo-wide with `dart fix`](/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/), this cleanup is one IDE quick fix at a time.

## Marking APIs as safe to drop with @awaitNotRequired

For your own APIs that are designed to be fire-and-forget (logging, analytics, cache warming), annotate the declaration instead of wrapping every call site:

```dart
// Dart 3.12.2, meta 1.19.0
import 'package:meta/meta.dart';

@awaitNotRequired
Future<void> track(String event) async {
  // send to analytics, errors handled inside
}

void onTap() {
  track('tap'); // neither rule reports this
}
```

`@awaitNotRequired` shipped in `package:meta` 1.17.0, and 1.18.1 allowed it on typedefs, so a callback parameter typed with an annotated typedef is exempt as well. Both lints honour it (A5 and S5 above), and the check also walks overridden members, so an override of an annotated method stays exempt. Only use it when the function handles its own errors: the annotation tells the analyzer that dropping the future is safe, and it is your job to make that true. Flutter 3.47 re-exports the annotation from `package:flutter/foundation.dart`; if a package using it breaks your 3.44 build, see [the `awaitNotRequired` undefined-name fix](/2026/10/fix-undefined-name-awaitnotrequired-material-ui-cupertino-ui-flutter-3-44/).

## The gotcha that picks for you

If your code base relies on arrow callbacks (`onPressed: () => doThing()`), `discarded_futures` buys you less than its noise suggests, because the arrow form is invisible to it (S9, F3). In that code base, `unawaited_futures` alone plus a team rule of "async work goes in `async` callbacks" gets you most of the value. If your code base uses block callbacks and `initState` loaders, `discarded_futures` is the only rule that sees those calls at all, and it is worth the `unawaited` churn.

C# developers will recognise the shape of the problem: it is the Dart version of [CS4014, "this call is not awaited"](/2026/07/fix-cs4014-because-this-call-is-not-awaited-execution-continues-in-csharp/), except that C# reports it only in `async` methods, which is the `unawaited_futures` half. Dart lets you opt into the other half.

## My recommendation

Turn on `unawaited_futures` in every Dart and Flutter project today. Add `discarded_futures` in packages and in apps where you want fire-and-forget to be explicit, and accept writing `unawaited(_controller.forward())`. This is the configuration I use:

```yaml
# analysis_options.yaml, Flutter 3.44.8 / Dart 3.12.2
include: package:flutter_lints/flutter.yaml

linter:
  rules:
    - unawaited_futures
    - discarded_futures
    - avoid_void_async
```

`avoid_void_async` is the companion: it reports `void bad() async {}` and makes you declare `Future<void>`, so the future exists in the type system where the other two rules (and your callers) can see it. It does not fix the tear-off gap, but it stops you from creating new `async` functions whose futures nobody can await.

## Related

- [How to catch uncaught async errors in Flutter with runZonedGuarded and PlatformDispatcher](/2026/10/how-to-catch-uncaught-async-errors-in-flutter-with-runzonedguarded-and-platformdispatcher/)
- [How to use BuildContext safely after an await in Flutter](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/)
- [How to run dart fix across a whole repo to apply Flutter migrations](/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/)
- [Fix: Undefined name 'awaitNotRequired' from material_ui or cupertino_ui on Flutter 3.44](/2026/10/fix-undefined-name-awaitnotrequired-material-ui-cupertino-ui-flutter-3-44/)
- [Fix CS4014: because this call is not awaited, execution continues](/2026/07/fix-cs4014-because-this-call-is-not-awaited-execution-continues-in-csharp/)

## Sources

- [unawaited_futures](https://dart.dev/tools/linter-rules/unawaited_futures) and [discarded_futures](https://dart.dev/tools/linter-rules/discarded_futures) on dart.dev.
- Rule sources at tag 3.12.2: [unawaited_futures.dart](https://github.com/dart-lang/sdk/blob/3.12.2/pkg/linter/lib/src/rules/unawaited_futures.dart), [discarded_futures.dart](https://github.com/dart-lang/sdk/blob/3.12.2/pkg/linter/lib/src/rules/discarded_futures.dart), [unused_futures.dart](https://github.com/dart-lang/sdk/blob/3.12.2/pkg/linter/lib/src/util/unused_futures.dart).
- [`awaitNotRequired` in package:meta](https://pub.dev/documentation/meta/latest/meta/awaitNotRequired-constant.html) and the [meta changelog](https://pub.dev/packages/meta/changelog).
- Upstream issues: [#61155](https://github.com/dart-lang/sdk/issues/61155) (arrow bodies), [#56921](https://github.com/dart-lang/sdk/issues/56921) (tear-offs), [#63818](https://github.com/dart-lang/sdk/issues/63818) (`unawaited` and `FutureOr`).
