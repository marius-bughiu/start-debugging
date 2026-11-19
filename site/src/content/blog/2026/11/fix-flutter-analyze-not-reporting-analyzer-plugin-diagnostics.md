---
title: "Fix: flutter analyze says \"No issues found!\" but dart analyze reports analyzer plugin diagnostics"
description: "Before Flutter 3.50, flutter analyze exits before analyzer plugins report anything. Upgrade to 3.50.0, or run dart analyze --fatal-infos in CI on older SDKs."
pubDate: 2026-11-19
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "static-analysis"
  - "ci"
---

On every Flutter stable release up to and including 3.47.9, `flutter analyze` stops listening to the analysis server as soon as core analysis goes idle, which happens before the analyzer plugins listed under `plugins:` in `analysis_options.yaml` have reported anything. Plugin diagnostics are silently dropped and the command prints `No issues found!` with exit code 0. Flutter 3.50.0 (Dart 3.14.0) fixes it by waiting on the server's `dart/workspace/analysis/complete` request. If you cannot upgrade yet, replace `flutter analyze` with `dart analyze --fatal-infos` in CI. It reports plugin diagnostics on every Dart 3.10+ SDK and fails the build on the same severities `flutter analyze` does.

## What the mismatch looks like

The same package, the same `analysis_options.yaml`, two commands, run back to back:

```text
$ dart analyze
Analyzing clock_app...

warning - lib/session.dart:3:10 - Use the injected Clock instead of DateTime.now(). Call clock.now() so tests can control time. - avoid_datetime_now

1 issue found.
$ echo $?
2

$ flutter analyze
Analyzing clock_app...
No issues found! (ran in 0.8s)
$ echo $?
0
```

Single-file mode behaves the same way: `flutter analyze lib/session.dart` also prints `No issues found!`. The plugin is loaded, its rule is enabled, and the IDE shows the squiggle. Only `flutter analyze` misses it, which means a CI step or pre-commit hook built on it passes code the plugin is supposed to block.

This is tracked in [flutter/flutter#187999](https://github.com/flutter/flutter/issues/187999) (reported on Flutter 3.44.1, closed as fixed on 3.50.0) and the earlier [flutter/flutter#184190](https://github.com/flutter/flutter/issues/184190), where directory mode failed but single-file mode sometimes worked. Which mode wins depends on timing, which is a hint about the cause.

## Why flutter analyze exits before the plugins report

`flutter analyze` does not run its own analyzer. On Flutter 3.44.8 (`flutter analyze -v` shows the command line) it starts `dart language-server`, sends `initialize`, and waits until the server says it is done. Before 3.50, "done" meant the LSP `$/progress` notification with `kind: end` for the `ANALYZING` token. Analyzer plugins under the new system (the top-level `plugins:` key, available since Dart 3.10) run in a separate isolate, and their results arrive later as their own diagnostics. The server's progress token only tracks core analysis, so `end` fires while the plugin isolate is still starting up.

You can see the race in the protocol log. This is the tail of `flutter analyze --protocol-traffic-log=traffic.log` on Flutter 3.44.8, with paths shortened and lines truncated:

```text
...:Info:Adding 1 analyzer plugins for context root:: '<repro>/clock_app'
...:Info:Using existing plugin AOT snapshot at '~/.dartServer/.plugin_manager/6ea6.../bin/plugin.aot'
...:Info:Starting plugin "Instance of 'PluginIsolate'"
1795122510013:PluginReq:{"id"::"1","method"::"analysis.setContextRoots",...}
1795122510013:Res:{"jsonrpc"::"2.0","method"::"$/progress","params"::{"token"::"ANALYZING","value"::{"kind"::"begin",...}}}
1795122510014:Res:{"jsonrpc"::"2.0","method"::"$/progress","params"::{"token"::"ANALYZING","value"::{"kind"::"end"}}}
```

The plugin has just received its context roots when the server reports `begin` and then `end` one millisecond later. `flutter analyze` treats `end` as completion, prints whatever diagnostics it has, and shuts the server down. Nothing from the plugin ever appears in the log. `dart analyze` on the same SDK waits for the plugin's results before printing, which is why it reports them.

The fix landed in [flutter/flutter#190843](https://github.com/flutter/flutter/pull/190843), merged on 2026-08-11. It changes `AnalysisServer.waitForAnalysis()` in `packages/flutter_tools/lib/src/dart/analysis.dart` from watching progress notifications to sending a request that only returns once both the server and its plugins are idle:

```dart
// flutter_tools at tag 3.50.0, packages/flutter_tools/lib/src/dart/analysis.dart
Future<void> waitForAnalysis({Duration delay = const Duration(milliseconds: 100)}) async {
  await Future<void>.delayed(delay);

  await sendRequest('dart/workspace/analysis/complete', {});
}
```

At tag 3.47.9 the same method still waits on the `onAnalyzing` stream fed by `$/progress`, so every 3.47.x hotfix has the bug. The first stable release with the fix is 3.50.0, published on 2026-11-11. A parallel SDK-side fix that delays the progress `end` until plugins finish ([dart-lang/sdk#63805](https://github.com/dart-lang/sdk/pull/63805)) was closed without merging, so the fix is in the Flutter tool, not in the Dart SDK.

## Minimal repro with a local analyzer plugin

The repro below was run on macOS (Apple Silicon) with Flutter 3.44.8 (framework revision 058e0af2c2) and its bundled Dart 3.12.2. The plugin resolved `analysis_server_plugin` 0.3.24 and `analyzer` 14.5.0 from pub.dev. Two sibling folders: a plugin package and a Flutter app.

The plugin flags direct `DateTime.now()` calls:

```yaml
# clock_lints/pubspec.yaml - Dart 3.12.2, analysis_server_plugin 0.3.24
name: clock_lints
version: 0.0.1
publish_to: none

environment:
  sdk: ^3.10.0

dependencies:
  analysis_server_plugin: any
  analyzer: any
```

```dart
// clock_lints/lib/main.dart - Dart 3.12.2, analysis_server_plugin 0.3.24
import 'package:analysis_server_plugin/plugin.dart';
import 'package:analysis_server_plugin/registry.dart';

import 'src/avoid_datetime_now.dart';

final plugin = ClockLintsPlugin();

class ClockLintsPlugin extends Plugin {
  @override
  String get name => 'clock_lints';

  @override
  void register(PluginRegistry registry) {
    // Warning rules are on by default. Rules registered with
    // registerLintRule must be enabled under plugins > clock_lints > diagnostics.
    registry.registerWarningRule(AvoidDateTimeNow());
  }
}
```

```dart
// clock_lints/lib/src/avoid_datetime_now.dart - Dart 3.12.2, analyzer 14.5.0
import 'package:analyzer/analysis_rule/analysis_rule.dart';
import 'package:analyzer/analysis_rule/rule_context.dart';
import 'package:analyzer/analysis_rule/rule_visitor_registry.dart';
import 'package:analyzer/dart/ast/ast.dart';
import 'package:analyzer/dart/ast/visitor.dart';
import 'package:analyzer/error/error.dart';

class AvoidDateTimeNow extends AnalysisRule {
  static const LintCode code = LintCode(
    'avoid_datetime_now',
    'Use the injected Clock instead of DateTime.now().',
    correctionMessage: 'Call clock.now() so tests can control time.',
    severity: DiagnosticSeverity.WARNING,
  );

  AvoidDateTimeNow()
      : super(
          name: 'avoid_datetime_now',
          description: 'Flags direct calls to DateTime.now().',
        );

  @override
  LintCode get diagnosticCode => code;

  @override
  void registerNodeProcessors(
    RuleVisitorRegistry registry,
    RuleContext context,
  ) {
    registry.addInstanceCreationExpression(this, _Visitor(this));
  }
}

class _Visitor extends SimpleAstVisitor<void> {
  _Visitor(this.rule);

  final AnalysisRule rule;

  @override
  void visitInstanceCreationExpression(InstanceCreationExpression node) {
    final constructor = node.constructorName;
    if (constructor.type.name.lexeme == 'DateTime' &&
        constructor.name?.name == 'now') {
      rule.reportAtNode(node);
    }
  }
}
```

The app is `flutter create --empty clock_app`, with the plugin appended to the generated `analysis_options.yaml` and one file that trips the rule:

```yaml
# clock_app/analysis_options.yaml - Flutter 3.44.8
include: package:flutter_lints/flutter.yaml

plugins:
  clock_lints:
    path: ../clock_lints
```

```dart
// clock_app/lib/session.dart - Flutter 3.44.8, Dart 3.12.2
bool isExpired(DateTime issuedAt) {
  return DateTime.now().difference(issuedAt) > const Duration(hours: 1);
}
```

Then, from `clock_app`:

```bash
(cd ../clock_lints && dart pub get)
flutter pub get
dart analyze            # warning - avoid_datetime_now, exit 2
flutter analyze         # No issues found!, exit 0
```

The first `dart analyze` took about 17 seconds of wall time because the server ran `pub upgrade` for the plugin and compiled it to an AOT snapshot under `~/.dartServer/.plugin_manager/`. Later runs reuse that snapshot and took about 3.6 seconds. `flutter analyze` misses the diagnostic on both cold and warm runs, so this is not a "plugin still compiling" problem you can wait out.

## Fix 1: upgrade to Flutter 3.50.0 or later

```bash
flutter upgrade
flutter --version   # Flutter 3.50.0 or later, Dart 3.14.0 or later
flutter analyze
```

After the upgrade, `flutter analyze` waits for `dart/workspace/analysis/complete` and reports plugin diagnostics in both whole-package and single-file mode. The original reporter confirmed this on 3.50.0 stable on Windows, and another contributor confirmed it on the 3.50.0-0.4.pre beta with a local plugin like the one above. This post's repro was only run on 3.44.8, so the 3.50 behaviour here comes from those reports and from the tool source at the 3.50.0 tag.

3.50.0 also adds a `--[no-]plugins` flag to `flutter analyze` (default on) that passes `--no-plugins` to the language server. Use it when you want a fast core-only pass, for example in a pre-commit hook, and keep a full run with plugins in CI.

If your project pins Flutter (FVM, `.flutter-version`, a CI image tag), bump the pin. A team where developers run 3.50 locally and CI runs 3.47 gets the worst of both: plugin warnings show up on laptops and are ignored by the gate. The pattern in [targeting multiple Flutter versions from one CI pipeline](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) helps if you have to keep both for a while.

## Fix 2: run dart analyze --fatal-infos on older SDKs

When an upgrade is not possible yet, switch the CI step to the `dart` that ships inside the same Flutter SDK:

```yaml
# .github/workflows/analyze.yml - Flutter 3.44.8 to 3.47.9
- run: flutter pub get
- run: dart analyze --fatal-infos
```

This is a drop-in replacement, not just "the other command":

- **Same SDK**: `flutter/bin/dart` resolves to `flutter/bin/cache/dart-sdk`, so the analyzer version matches what `flutter analyze` would have used. Do not point CI at a separately installed Dart SDK. It will not match Flutter's package resolution and may be a different analyzer version.
- **Same failure threshold**: `flutter analyze` treats infos as fatal by default (`--fatal-infos` defaults to on). `dart analyze` only fails on warnings and errors unless you pass `--fatal-infos`. Without the flag, a Flutter project with an `avoid_print` info passes `dart analyze` (exit 0) where `flutter analyze` exits 1.
- **Different exit codes**: `dart analyze` exits 3 for errors, 2 for warnings and 1 for fatal infos. `flutter analyze` exits 1 for all of them. Any non-zero code fails a CI step, but a wrapper script that checks for `== 1` needs to check `!= 0` instead.
- **Different text format**: `dart analyze` prints `warning - lib/x.dart:3:10 - message - code`, `flutter analyze` prints `warning • message • lib/x.dart:3:10 • code`. If something parses the output, use `dart analyze --format=json` instead of matching either text format.

Run `flutter pub get` first. `dart analyze` does not resolve dependencies on its own, and without `.dart_tool/package_config.json` every `package:` import is an error.

## Gotchas when you move plugin lints into CI

**Plugin severity is set in the plugin, not in `analyzer: errors:`.** On Dart 3.12.2, both `avoid_datetime_now: warning` and `clock_lints/avoid_datetime_now: warning` under `analyzer: errors:` are rejected with `isn't a recognized diagnostic code` (an `unrecognized_error_code` warning that itself fails `dart analyze`). The severity comes from the `severity` argument of the plugin's `LintCode`, which defaults to `DiagnosticSeverity.INFO`. An info-level plugin rule only fails CI with `--fatal-infos`. The [analyzer plugin docs](https://dart.dev/tools/analyzer-plugins) only cover enabling and disabling rules under `plugins: <name>: diagnostics:`.

**Warning rules are on by default, lint rules are off.** A rule registered with `registerLintRule` reports nothing until it is set to `true` under the plugin's `diagnostics:` map. If `dart analyze` is also silent, check this before blaming the tool.

**Ignore comments need the plugin prefix.** `// ignore: avoid_datetime_now` does not suppress the plugin's diagnostic. `// ignore: clock_lints/avoid_datetime_now` does, and so does `// ignore_for_file: clock_lints/avoid_datetime_now`.

**Built-in diagnostics are printed twice on Dart 3.12.** With any plugin enabled, `dart analyze` on Dart 3.12.2 printed each `flutter_lints` diagnostic twice (one `print` call produced two identical `avoid_print` lines). Removing the `plugins:` block brought it back to one. This is [dart-lang/sdk#63497](https://github.com/dart-lang/sdk/issues/63497), closed in June 2026. It inflates the issue count but does not change the exit code.

**This is not about `custom_lint`.** Packages built on `custom_lint` use the older `analyzer: plugins:` mechanism and are run in CI with `dart run custom_lint`. The issue in this post only applies to plugins listed under the top-level `plugins:` key. If you move a lint package from `custom_lint` to the new system (check its changelog; `riverpod_lint` is a common one in a [Riverpod 3.0 migration](/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/)), update the CI command at the same time.

**Plugins cost editor time too.** Every plugin is another isolate per context root. If the IDE gets slow after adding one, the measurements in [speeding up a slow Dart analysis server in a large Flutter monorepo](/2026/09/how-to-speed-up-a-slow-dart-analysis-server-in-vs-code-for-a-large-flutter-monorepo/) apply.

## Related

- [How to target multiple Flutter versions from one CI pipeline](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)
- [How to speed up a slow Dart analysis server in VS Code for a large Flutter monorepo](/2026/09/how-to-speed-up-a-slow-dart-analysis-server-in-vs-code-for-a-large-flutter-monorepo/)
- [unawaited_futures vs discarded_futures in Dart: which lint catches which un-awaited call](/2026/10/unawaited-futures-vs-discarded-futures-lint-in-dart/)
- [What is the depend_on_referenced_packages lint in Dart?](/2026/10/what-is-the-depend-on-referenced-packages-lint-in-dart/)
- [Migrate from Riverpod 2.x to Riverpod 3.0 in Flutter](/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/)

## Sources

- [flutter/flutter#187999: flutter analyze does not report analyzer plugin diagnostics](https://github.com/flutter/flutter/issues/187999)
- [flutter/flutter#184190: flutter analyze lib exits before analyzer plugin diagnostics are reported](https://github.com/flutter/flutter/issues/184190)
- [flutter/flutter#190843: Switch flutter analyze to use dart/workspace/analysis/complete](https://github.com/flutter/flutter/pull/190843)
- [dart-lang/sdk#63805: Defer analysis-complete notification until plugins finish (closed)](https://github.com/dart-lang/sdk/pull/63805)
- [dart-lang/sdk#63497: base diagnostics duplicated with analyzer plugins on the command line](https://github.com/dart-lang/sdk/issues/63497)
- [Dart docs: Analyzer plugins](https://dart.dev/tools/analyzer-plugins)
- [flutter_tools `analysis.dart` at tag 3.50.0](https://github.com/flutter/flutter/blob/3.50.0/packages/flutter_tools/lib/src/dart/analysis.dart)
