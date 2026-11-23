---
title: "How to find Dart async functions that never await (and why unnecessary_async skips Future methods)"
description: "unnecessary_async only fires when deleting the async keyword alone keeps the code valid, so Future<T> methods that return plain values are skipped by design. A 90-line analyzer plugin rule lists every async body without an await. Measured on Dart 3.12.2."
pubDate: 2026-11-23
template: how-to
tags:
  - "dart"
  - "flutter"
  - "async"
  - "static-analysis"
  - "lints"
---

**Short answer:** `unnecessary_async` is not a "this function never awaits" lint. It only reports `async` when you can delete that one keyword and the code still compiles with the same meaning: `void` bodies, `FutureOr` return types, closures in a `void` or `FutureOr` context, and `Future<T>` functions whose every `return` already hands back a `Future`. A `Future<String> f() async { return 'x'; }` is skipped on purpose, because removing `async` alone would turn `return 'x'` into a type error. To list every `async` body with no `await` (which is what most people actually want), add a small analyzer plugin rule; the full source is below and it plugs into `dart analyze` and the IDE. Everything here was measured with `dart analyze` on Dart 3.12.2 (Flutter 3.44.8), with the plugin built against `analyzer` 14.5.0 and `analysis_server_plugin` 0.3.24.

## The question: unnecessary_async is on, but nothing gets flagged

The setup that trips people up looks like this. You enable the rule, expecting it to find leftover `async` keywords after a refactor:

```yaml
# analysis_options.yaml - Dart 3.12.2
linter:
  rules:
    - unnecessary_async
    - avoid_void_async
```

And this function, which plainly does not need to be asynchronous, produces no diagnostic:

```dart
// Dart 3.12.2
Future<String> todaysDate() async {
  return DateTime.now().toString();
}
```

The [rule's documentation](https://dart.dev/tools/linter-rules/unnecessary_async) says "No await no async" and shows a `void f() async` example, so it is reasonable to expect a hit here. There is none, and it is not a bug.

## What the rule actually checks

The rule is small enough to read in full: [`pkg/linter/lib/src/rules/unnecessary_async.dart`](https://github.com/dart-lang/sdk/blob/3.12.2/pkg/linter/lib/src/rules/unnecessary_async.dart) in the Dart SDK. It is marked **experimental** and was released in Dart 3.7. For each `async` (not `async*`) body without an `await` or `await for`, it looks at the declared return type and reports only in these cases:

1. **No imposed return type** (a closure with no context type): report.
2. **`void`**: report. Nobody can observe the `Future`, so dropping it changes nothing.
3. **`FutureOr<T>`**: report. A plain value is already a valid `FutureOr<T>`.
4. **`Future<T>`**: report only if the body cannot complete normally (it always ends in `return` or `throw`) **and** every `return` expression already has a non-nullable `Future` type.
5. **Anything else** (`dynamic`, `Object`, a custom type): skip on Dart 3.12.

Case 4 is the one that matters. The rule's quick fix is "remove the `async` keyword", nothing more. So it only fires when removing that keyword leaves a correct program. In `todaysDate()` above, deleting `async` gives `Future<String> todaysDate() { return DateTime.now().toString(); }`, which is a compile error: a `String` is not a `Future<String>`. Fixing that requires changing the return type or wrapping the value, which changes the function's signature and every caller. The rule deliberately stays out of that decision.

The same logic explains `Future<void> f() async { print('x'); }`. Without `async`, a body that falls off the end of a function returning non-nullable `Future<void>` does not compile, so the rule skips it too.

## Every case, measured on Dart 3.12.2

I wrote 23 small functions covering the shapes that show up in real Flutter code and ran `dart analyze` with `unnecessary_async` and `avoid_void_async` enabled. These are the ones without an `await`:

| Declaration | `unnecessary_async` on 3.12.2 |
| --- | --- |
| `Future todaysDate() async { return '...'; }` | not reported |
| `dynamic todaysDateString() async { return '...'; }` | not reported |
| `Future<String> greeting() async { return 'hi'; }` | not reported |
| `Future<String> greetingArrow() async => 'hi';` | not reported |
| `Future<void> logIt() async { print('x'); }` | not reported |
| `Future<void> early(bool b) async { if (b) return; print('x'); }` | not reported |
| `noType() async { return 1; }` (no return type, so `dynamic`) | not reported |
| `Future<int?> nullableForward(Future<int?>? f) async { return f; }` | not reported |
| `Future<List<int>> load() async { return [1, 2, 3]; }` (method) | not reported |
| `Future<int> get size async => 3;` (getter) | not reported |
| `Future<int> nested() async { final f = () async => await g(); return 2; }` | not reported |
| `Future<int> Function() f = () async => 1;` (closure) | not reported |
| `void fireAndForget() async { print('x'); }` | **reported** (plus `avoid_void_async`) |
| `FutureOr<int> maybe() async { return 1; }` | **reported** |
| `Future<int> forward() async { return Future.value(1); }` | **reported** |
| `Future<int> forwardArrow() async => Future.value(1);` | **reported** |
| `Future<int> fails() async { throw StateError('nope'); }` | **reported** |
| `[1].forEach((x) async { print(x); });` | **reported** |
| `Future.value(1).then((v) async => v + 1);` | **reported** |

Twelve of the nineteen await-free bodies in the table are invisible to the rule, and they are exactly the common ones: a `Future<T>` method that returns a plain value. `async*` generators are never considered, and an `await` inside a nested closure counts for the closure, not for the outer function (the `nested()` row is skipped only because it returns a plain `int`).

### The dynamic case changed in Dart 3.13

If you have seen `unnecessary_async` flag a `dynamic`-returning function, you were on a newer SDK. Commit [95613f5](https://github.com/dart-lang/sdk/commit/95613f5d07b078875985cfe4e1c1e77e1b3255d9) ("Report unnecessary_async for dynamic- and Object-returning functions", April 2026) added two branches: a `dynamic` or `Object` return type is now reported, since any value is valid there. The [3.13.0](https://github.com/dart-lang/sdk/blob/3.13.0/pkg/linter/lib/src/rules/unnecessary_async.dart) and [3.14.0](https://github.com/dart-lang/sdk/blob/3.14.0/pkg/linter/lib/src/rules/unnecessary_async.dart) tags both contain it; 3.12.2 does not, which matches the table above. I read the change in the source but did not run 3.13 or 3.14 for this post. The `Future<T>` logic is unchanged in both tags, so `Future<String> greeting() async { return 'hi'; }` is still skipped on current stable.

## A plugin rule that lists every async body without await

Since Dart 3.10 you can ship your own rules as an [analyzer plugin](https://dart.dev/tools/analyzer-plugins) using `package:analysis_server_plugin`. The rule below reuses the same "does this body contain an await" walk that `unnecessary_async` uses, but reports regardless of the return type. It skips `@override` members, because an override has to keep the inherited `Future`-returning signature, and it skips closures, because a closure's `async` is almost always dictated by the callback type it is passed to.

Set it up in four steps:

1. Create a plugin package next to your app, for example `await_lints/`, with this `pubspec.yaml`:

   ```yaml
   # await_lints/pubspec.yaml - Dart 3.12.2, analysis_server_plugin 0.3.24
   name: await_lints
   version: 0.0.1
   publish_to: none

   environment:
     sdk: ^3.10.0

   dependencies:
     analysis_server_plugin: any
     analyzer: any
   ```

2. Add the plugin entry point at `await_lints/lib/main.dart`. The server looks for a top-level `plugin` variable in exactly this file:

   ```dart
   // await_lints/lib/main.dart - Dart 3.12.2, analysis_server_plugin 0.3.24
   import 'package:analysis_server_plugin/plugin.dart';
   import 'package:analysis_server_plugin/registry.dart';

   import 'src/async_without_await.dart';

   final plugin = AwaitLintsPlugin();

   class AwaitLintsPlugin extends Plugin {
     @override
     String get name => 'await_lints';

     @override
     void register(PluginRegistry registry) {
       // Warning rules are on by default; lint rules need opting in.
       registry.registerWarningRule(AsyncWithoutAwait());
     }
   }
   ```

3. Add the rule at `await_lints/lib/src/async_without_await.dart`:

   ```dart
   // await_lints/lib/src/async_without_await.dart - Dart 3.12.2, analyzer 14.5.0
   import 'package:analyzer/analysis_rule/analysis_rule.dart';
   import 'package:analyzer/analysis_rule/rule_context.dart';
   import 'package:analyzer/analysis_rule/rule_visitor_registry.dart';
   import 'package:analyzer/dart/ast/ast.dart';
   import 'package:analyzer/dart/ast/visitor.dart';
   import 'package:analyzer/error/error.dart';

   class AsyncWithoutAwait extends AnalysisRule {
     static const LintCode code = LintCode(
       'async_without_await',
       "'{0}' is marked 'async' but never awaits anything.",
       correctionMessage:
           "Remove 'async' and return a plain value or the Future directly.",
       severity: DiagnosticSeverity.INFO,
     );

     AsyncWithoutAwait()
         : super(
             name: 'async_without_await',
             description: 'Flags async functions and methods with no await.',
           );

     @override
     LintCode get diagnosticCode => code;

     @override
     void registerNodeProcessors(
       RuleVisitorRegistry registry,
       RuleContext context,
     ) {
       final visitor = _Visitor(this);
       registry.addFunctionDeclaration(this, visitor);
       registry.addMethodDeclaration(this, visitor);
     }
   }

   class _Visitor extends SimpleAstVisitor<void> {
     _Visitor(this.rule);

     final AnalysisRule rule;

     @override
     void visitFunctionDeclaration(FunctionDeclaration node) {
       _check(node.name.lexeme, node.functionExpression.body);
     }

     @override
     void visitMethodDeclaration(MethodDeclaration node) {
       // An override has to keep the inherited Future-returning signature.
       final isOverride = node.metadata.any((a) => a.name.name == 'override');
       if (isOverride) return;
       _check(node.name.lexeme, node.body);
     }

     void _check(String name, FunctionBody body) {
       // Only `async`, not `async*` (generators) and not sync bodies.
       if (!body.isAsynchronous || body.isGenerator) return;

       final finder = _AwaitFinder();
       body.accept(finder);
       if (finder.found) return;

       final keyword = body.keyword;
       if (keyword != null) {
         rule.reportAtToken(keyword, arguments: [name]);
       }
     }
   }

   /// Looks for `await` and `await for` in one body, without descending
   /// into nested closures (an await in a closure belongs to the closure).
   class _AwaitFinder extends RecursiveAstVisitor<void> {
     bool found = false;

     @override
     void visitAwaitExpression(AwaitExpression node) => found = true;

     @override
     void visitForStatement(ForStatement node) {
       if (node.awaitKeyword != null) found = true;
       super.visitForStatement(node);
     }

     @override
     void visitForElement(ForElement node) {
       if (node.awaitKeyword != null) found = true;
       super.visitForElement(node);
     }

     @override
     void visitFunctionExpression(FunctionExpression node) {
       // Stop: a nested closure has its own body.
     }
   }
   ```

4. Enable it in the app's `analysis_options.yaml` under the top-level `plugins:` key (not `analyzer: plugins:`, which is the old `custom_lint` style mechanism), run `dart pub get` in the plugin folder, then analyze:

   ```yaml
   # analysis_options.yaml - Dart 3.12.2
   plugins:
     await_lints:
       path: ../await_lints
   ```

   ```bash
   (cd ../await_lints && dart pub get)
   dart analyze
   ```

On the 23-case file, the first `dart analyze` with the plugin took 11.5 seconds of wall time on an Apple Silicon Mac, most of it the server resolving and compiling the plugin. It reported `async_without_await` on all 16 named functions, methods and getters without an `await`, including every row the built-in rule skipped, and stayed quiet on the `@override` method, the `async*` generator and the functions that do await:

```text
info - lib/cases.dart:5:21 - 'todaysDate' is marked 'async' but never awaits anything. Remove 'async' and return a plain value or the Future directly. - async_without_await
info - lib/cases.dart:15:27 - 'greeting' is marked 'async' but never awaits anything. Remove 'async' and return a plain value or the Future directly. - async_without_await
info - lib/cases.dart:23:22 - 'logIt' is marked 'async' but never awaits anything. Remove 'async' and return a plain value or the Future directly. - async_without_await
info - lib/cases.dart:93:28 - 'load' is marked 'async' but never awaits anything. Remove 'async' and return a plain value or the Future directly. - async_without_await
info - lib/cases.dart:102:24 - 'size' is marked 'async' but never awaits anything. Remove 'async' and return a plain value or the Future directly. - async_without_await
```

(Excerpt; the full run listed all 16.) One oddity worth knowing: on Dart 3.12.2, with any plugin enabled, `dart analyze` printed each built-in diagnostic twice (the `unnecessary_async` and `unused_local_variable` lines appeared in pairs), while the plugin's own diagnostics appeared once. The issue count at the bottom includes the duplicates, so do not compare it against a run without the plugin.

If you only need a one-off audit, run it once, fix what you want to fix, and remove the `plugins:` entry again. If you want to keep it, the rule ships at `INFO` severity, so it only fails CI with `dart analyze --fatal-infos`. Note that `flutter analyze` before Flutter 3.50 silently drops plugin diagnostics; see [why flutter analyze misses analyzer plugin diagnostics](/2026/11/fix-flutter-analyze-not-reporting-analyzer-plugin-diagnostics/) for the details and the CI workaround.

## Removing async safely, one hit at a time

The plugin finds candidates. Deciding what to do with each one is where the built-in rule's caution makes sense, because there are three different fixes and they are not equivalent.

**Make it synchronous.** If nothing about the function is asynchronous, change the type: `String greeting() => 'hi';`. This is the cleanest result, but it is a signature change. Callers that do `greeting().then(...)` stop compiling, and callers that `await greeting()` keep compiling but now trip `await_only_futures`. For a public package API, it is a breaking change.

**Keep the `Future`, drop `async`.** If the function must stay `Future`-returning (it implements an interface, or other implementations really are asynchronous), you can write `Future<String> greeting() => Future.value('hi');`. This avoids the async state machine but buys you little else, and it changes how errors are delivered.

**Leave it alone.** For a method that exists to satisfy an asynchronous contract, `async` without `await` is often the most honest code. That is why the plugin skips `@override` members. Enable `annotate_overrides` so implementations of abstract members carry the annotation and get skipped too.

The error-delivery difference is the one that bites. In an `async` function, a `throw` becomes an error on the returned `Future`. Without `async`, it is thrown synchronously at the call site, before any `Future` exists. This program shows the difference:

```dart
// Dart 3.12.2 - dart run bin/throws.dart
Future<int> failsAsync() async {
  throw StateError('async');
}

Future<int> failsSync() {
  throw StateError('sync');
}

void main() {
  failsAsync().catchError((Object e) {
    print('caught via Future: $e');
    return 0;
  });
  try {
    failsSync().catchError((Object e) {
      print('caught via Future: $e');
      return 0;
    });
  } on StateError catch (e) {
    print('thrown synchronously: $e');
  }
}
```

```text
thrown synchronously: Bad state: sync
caught via Future: Bad state: async
```

Note the `catchError` on `failsSync()` never runs: the exception escapes before `catchError` is attached. This is also why the built-in rule's case 4 is less safe than it looks. It reports `Future<int> fails() async { throw StateError('nope'); }` (every exit is a `throw`, so the "every return is a Future" check passes vacuously), yet removing `async` there changes where the error surfaces. If a caller relies on `.catchError` or on a surrounding zone, review those hits by hand rather than applying the quick fix in bulk. Errors that escape this way end up in the paths covered in [catching uncaught async errors in Flutter](/2026/10/how-to-catch-uncaught-async-errors-in-flutter-with-runzonedguarded-and-platformdispatcher/).

## Suppressing a hit you want to keep

Plugin diagnostics use the plugin name as a prefix in `ignore` comments. Verified on 3.12.2:

```dart
// Dart 3.12.2
// ignore: await_lints/async_without_await
Future<int> kept() async => 1;
```

A plain `// ignore: async_without_await` without the prefix does not match; the diagnostic is still reported. To turn the rule off for a whole package without deleting the plugin, use the [`diagnostics:` map under the plugin entry](https://dart.dev/tools/analyzer-plugins), which also worked on 3.12.2:

```yaml
# analysis_options.yaml - Dart 3.12.2
plugins:
  await_lints:
    path: ../await_lints
    diagnostics:
      async_without_await: false
```

## Variants and edge cases

- **Closures are left out on purpose.** `onPressed: () async { setState(...); }` is a closure in a `void` context; `unnecessary_async` already catches those, as the `forEach` row shows. Closures passed to `Future<T> Function()` parameters must stay `Future`-returning anyway. If you want them too, add `registry.addFunctionExpression` and skip nodes whose parent is a `FunctionDeclaration`, which is exactly what the built-in rule does.
- **`await` in a nested closure does not count.** Both the built-in rule and the plugin stop at nested `FunctionExpression` nodes, so a function whose only `await` lives in a callback it creates is reported. That is correct: the outer body never suspends.
- **`async*` generators are a different thing.** A `Stream` generator with no `await` still needs `async*` to `yield`. Neither rule looks at them.
- **Dropped futures are a separate problem.** Finding missing `await`s (as opposed to unnecessary `async`) is the job of [`unawaited_futures` and `discarded_futures`](/2026/10/unawaited-futures-vs-discarded-futures-lint-in-dart/), which have their own blind spots.
- **"Synchronous" is not the same as "immediate".** Removing `async` makes the function run to completion before returning; it does not change how timers or microtasks are scheduled elsewhere. If you are chasing latency rather than code hygiene, [why `Future.delayed` fires late](/2026/11/why-does-future-delayed-or-a-timer-fire-late-in-dart/) covers the event loop side.
- **The rule is experimental.** `unnecessary_async` is marked experimental on dart.dev, and its behavior has already changed once (Dart 3.13). Re-check the table above after an SDK upgrade before you rely on it as a gate.

## Related

- [unawaited_futures vs discarded_futures in Dart: which lint catches which un-awaited call](/2026/10/unawaited-futures-vs-discarded-futures-lint-in-dart/)
- [Fix: flutter analyze says "No issues found!" but dart analyze reports analyzer plugin diagnostics](/2026/11/fix-flutter-analyze-not-reporting-analyzer-plugin-diagnostics/)
- [How to catch uncaught async errors in Flutter with runZonedGuarded and PlatformDispatcher](/2026/10/how-to-catch-uncaught-async-errors-in-flutter-with-runzonedguarded-and-platformdispatcher/)
- [Why does Future.delayed or a Timer fire later than the requested Duration in Dart?](/2026/11/why-does-future-delayed-or-a-timer-fire-late-in-dart/)

## Sources

- [unnecessary_async](https://dart.dev/tools/linter-rules/unnecessary_async) and [avoid_void_async](https://dart.dev/tools/linter-rules/avoid_void_async) on dart.dev
- [`unnecessary_async.dart` at the 3.12.2 tag](https://github.com/dart-lang/sdk/blob/3.12.2/pkg/linter/lib/src/rules/unnecessary_async.dart) and at [3.14.0](https://github.com/dart-lang/sdk/blob/3.14.0/pkg/linter/lib/src/rules/unnecessary_async.dart)
- [dart-lang/sdk commit 95613f5: report unnecessary_async for dynamic- and Object-returning functions](https://github.com/dart-lang/sdk/commit/95613f5d07b078875985cfe4e1c1e77e1b3255d9)
- [Analyzer plugins](https://dart.dev/tools/analyzer-plugins) on dart.dev
- [The original Stack Overflow question](https://stackoverflow.com/questions/79996882)
