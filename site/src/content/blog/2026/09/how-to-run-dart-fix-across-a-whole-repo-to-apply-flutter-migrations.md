---
title: "How to run dart fix across a whole repo to apply Flutter breaking-change migrations"
description: "dart fix takes one target directory and it can be the repo root: the analyzer opens a context per nested pubspec.yaml and migrates every package in one pass. Here is the full flag surface, the four things that silently suppress fixes and make a dirty repo report Nothing to fix, why the exit code is useless in CI, and a case where a Flutter transform emits code that does not compile."
pubDate: 2026-09-08
template: how-to
tags:
  - "flutter"
  - "dart"
  - "migration"
  - "tooling"
  - "how-to"
---

`dart fix --apply` accepts a single target directory, and that directory can be your repository root. The analyzer opens one analysis context per nested `pubspec.yaml` underneath it, so a monorepo with a dozen packages migrates in one command, honouring each package's own `analysis_options.yaml`. The reason a whole-repo run so often prints `Nothing to fix!` on a codebase that is visibly full of deprecation warnings is not that the tool is broken: four unrelated things suppress fixes silently, and `dart fix` exits 0 in every one of those cases. There is also no `flutter fix` command, despite the docs page called Flutter fix. Everything below was run on Flutter 3.44.8 with Dart 3.12.2; the command surface and the internals quoted here are unchanged on the Dart SDK main branch that feeds the current stable Flutter 3.47 line.

## The entire command surface is four flags

Before designing a repo-wide workflow around this tool it helps to know how little of it there is:

```console
$ dart fix --help
Apply automated fixes to Dart source code.

This tool looks for and fixes analysis issues that have associated automated fixes.

To use the tool, run either 'dart fix --dry-run' for a preview of the proposed changes for a project, or 'dart fix --apply' to apply the changes.

Usage: dart fix [arguments]
-h, --help                      Print this usage information.
-n, --dry-run                   Preview the proposed changes but make no changes.
    --apply                     Apply the proposed changes.
    --code=<code1,code2,...>    Apply fixes for one (or more) diagnostic codes.
```

That is it. Two hidden flags exist in `pkg/dartdev/lib/src/commands/fix.dart` (`--compare-to-golden` for the SDK's own tests and `--use-aot-snapshot`), and neither is useful to you. There is no `--exclude`, no glob support, no multi-path argument. Exactly one positional target, a file or a directory, defaulting to the current directory. If you pass neither `--apply` nor `--dry-run`, or pass both, the command prints usage and returns 0 without doing anything.

The other thing worth checking early:

```console
$ flutter fix --dry-run
Could not find a command named "fix".
```

The [Flutter fix](https://docs.flutter.dev/tools/flutter-fix) documentation page describes a feature, not a command. You run `dart fix`, and as long as the `dart` on your `PATH` is the one bundled in the Flutter SDK (`$FLUTTER_ROOT/bin/dart`), it resolves the framework's migration data automatically.

## One run at the repo root covers every nested package

This is the part most teams get wrong, usually by writing a `find` loop before checking whether they need one. Take a pub workspace with three members:

```yaml
# pubspec.yaml at the repo root, Dart 3.12.2
name: mono_root
environment:
  sdk: ^3.12.0
workspace:
  - packages/pkg_a
  - packages/pkg_b
  - apps/app
```

One command at the root, one report covering all three:

```console
$ dart fix --dry-run
Computing fixes in mono (dry run)...

6 proposed fixes in 3 files.

apps/app/lib/main.dart
  prefer_const_constructors - 1 fix
  prefer_final_locals - 1 fix

packages/pkg_a/lib/a.dart
  prefer_const_constructors - 1 fix
  prefer_final_locals - 1 fix

packages/pkg_b/lib/b.dart
  prefer_const_constructors - 1 fix
  prefer_final_locals - 1 fix
```

This is not a workspace feature. Two sibling packages with no root `pubspec.yaml` at all get the same treatment, because the analyzer discovers context roots by walking the directory tree for `pubspec.yaml` and `analysis_options.yaml` files. Each package keeps its own lint configuration during that single run, so a package that opts into `prefer_final_locals` gets those fixes while its neighbour does not.

`dart fix` also loops. `FixCommand.maxPasses` is 4, and it re-runs the whole computation until no more edits are produced or it hits that ceiling. You can see the effect in a single statement: `var b = Box(1);` becomes `final b = const Box(1);`, which needs `prefer_final_locals` and `prefer_const_constructors` to fire in separate passes over the same line.

## Why a package reports "Nothing to fix!" when it is full of deprecations

Four distinct mechanisms produce the same output and the same exit code. Rule them out in this order.

**The package is not resolved.** `dart fix` needs a `.dart_tool/package_config.json` to know what `package:lib_pkg/api.dart` means, and without it there is no `deprecated_member_use` diagnostic to attach a fix to. Same repository, same file, before and after a `pub get`:

```console
$ dart fix --dry-run          # no pub get yet
Computing fixes in app (dry run)...
Nothing to fix!

$ dart pub get && dart fix --dry-run
Computing fixes in app (dry run)...

1 proposed fix in 1 file.

lib/main.dart
  deprecated_member_use - 1 fix
```

In a monorepo this is the usual culprit: CI resolved the app but not the six leaf packages, so the migration quietly covers a fraction of the tree.

**The files are excluded from analysis.** An `exclude` list, typically added years ago to keep generated code out of the lint report, also removes those files from the fix set:

```yaml
# analysis_options.yaml
analyzer:
  exclude:
    - lib/main.dart
```

```console
$ dart fix --dry-run
Nothing to fix!
```

**The diagnostic is downgraded to `ignore`.** This one is the most damaging, because it is the standard move when a Flutter upgrade floods CI with deprecation warnings:

```yaml
analyzer:
  errors:
    deprecated_member_use: ignore
```

Silencing the warning also disables the automated migration for it. If your repo has this line, remove it before running `dart fix`, not after.

**The line carries an `// ignore:` comment.** Same effect, at file or line granularity. A `// ignore_for_file: deprecated_member_use` at the top of a large widget file makes `dart fix` skip the entire file without a word.

For lint-driven fixes there is a fifth case that is by design rather than a trap: a fix only exists if the lint is enabled. `--code` does not override that.

```console
$ dart fix --dry-run --code=prefer_final_locals   # lint not in analysis_options.yaml
Nothing to fix!
```

Add the rule and the same command finds the fix. That makes a useful one-shot pattern: enable a cleanup lint temporarily, run `dart fix --apply --code=<that lint>`, then decide whether to keep the rule enabled.

None of these five cases changes the exit status. Every run above returned 0. The only invocation that returns non-zero is an unknown diagnostic code:

```console
$ dart fix --apply --code=this_is_not_a_real_code
Computing fixes in app...
Unable to compute fixes: The diagnostic 'this_is_not_a_real_code' is not defined by the analyzer.
$ echo $?
3
```

Which is worth knowing, because it means a typo in a CI script fails loudly rather than skipping the migration.

## Running it across the repo, in order

1. **Upgrade the SDK, then remove the suppressors.** Deprecation transforms only exist for APIs the analyzer can see as deprecated, so `flutter upgrade` comes first. Then grep for `deprecated_member_use: ignore` in every `analysis_options.yaml` and for `ignore_for_file: deprecated_member_use` in `lib/`, and delete them. Skip this and steps 3 and 4 will report a clean repo.

2. **Resolve every package.** Inside a pub workspace, one `dart pub get` anywhere resolves the whole thing (running it in a member package prints `Resolving dependencies in /path/to/root` and writes the root's `.dart_tool`). Outside a workspace, every package with its own resolution needs its own `pub get`.

3. **Run once at the root and read the report.** `dart fix --dry-run` from the repository root, and check that the file list mentions every package you expect. A package missing from the report is a package that failed step 2 or is excluded from analysis, not a clean one.

4. **Fall back to a per-package loop only if step 3 came up short.** For repos where packages cannot be resolved from one place, this covers everything and is idempotent:

   ```bash
   #!/usr/bin/env bash
   # tool/dart_fix_repo.sh - Flutter 3.44.8, Dart 3.12.2
   set -euo pipefail

   find . -name pubspec.yaml \
     -not -path '*/.*' \
     -not -path '*/build/*' \
     -not -path '*/ephemeral/*' \
     -print | while read -r manifest; do
       pkg=$(dirname "$manifest")
       echo "==> $pkg"
       ( cd "$pkg" && dart pub get >/dev/null && dart fix --apply "$@" )
     done

   dart format .
   ```

   The `-not -path` filters matter: `build/` and the `ephemeral/` directories under `windows/`, `linux/`, and `macos/` contain generated `pubspec.yaml` files you do not want to touch. If you already run [Melos](https://melos.invertase.dev/), `melos exec -- "dart pub get && dart fix --apply"` does the same thing with the filtering flags you already have configured.

5. **Format, then analyze, then run the tests.** In that order, and do not skip the last one. Details below.

## One diagnostic per commit

A 400-file `dart fix --apply` diff is unreviewable. `--code` takes a comma-separated list, so split the run into commits that a human can actually read:

```bash
dart fix --apply --code=deprecated_member_use
git commit -am "chore: apply Flutter deprecation migrations via dart fix"

dart fix --apply --code=prefer_const_constructors,prefer_const_literals_to_create_immutables
git commit -am "chore: const cleanup via dart fix"
```

The dry-run report prints the exact commands for the codes it found, which makes this cheap to plan.

## Where the migrations come from

Deprecation fixes are data, not compiler logic. A package declares them in `lib/fix_data.yaml`, and the analyzer picks them up from any resolved dependency. In Flutter 3.44.8 the framework ships 30 such files under `packages/flutter/lib/fix_data/`, holding 381 transforms, plus 8 in `flutter_test`, 2 in `flutter_driver`, and 1 in `integration_test`. The change kinds, by frequency in `package:flutter`: 418 `removeParameter`, 228 `addParameter`, 204 `fragment`, 158 `rename`, 90 `renameParameter`, 16 `import`, 12 `addTypeParameter`, 11 `replacedBy`, 1 `changeParameterType`.

The same mechanism is available to your own internal packages, which is the highest-leverage thing in this post if you maintain a shared design system. Deprecate the old member, then describe the rewrite:

```dart
// lib_pkg/lib/api.dart
class Report {
  @Deprecated('Use render() instead. Removed in lib_pkg 3.0.0.')
  String toHtml() => render();
  String render() => '<html/>';
}
```

```yaml
# lib_pkg/lib/fix_data.yaml - Dart 3.12.2
version: 1
transforms:
  - title: "Rename to 'render'"
    date: 2026-09-01
    element:
      uris: ['api.dart']
      method: 'toHtml'
      inClass: 'Report'
    changes:
      - kind: 'rename'
        newName: 'render'
```

Every consumer that runs `dart fix --apply` after bumping the dependency gets `r.toHtml()` rewritten to `r.render()`. The `uris` list must contain the public library path consumers import, not the `src/` file the class is declared in. That single detail is the most common reason a hand-written `fix_data.yaml` does nothing.

## dart fix is not a compiler, and it will hand you code that does not build

This is why step 5 above ends with analyze and test rather than commit. A minimal widget using two deprecated Flutter APIs:

```dart
// Flutter 3.44.8, Dart 3.12.2
import 'package:flutter/material.dart';

class Card1 extends StatelessWidget {
  const Card1({super.key});

  @override
  Widget build(BuildContext context) {
    return Container(
      color: Colors.black.withOpacity(0.5),
      child: ListView(
        cacheExtent: 250.0,
        children: const [Text('hi')],
      ),
    );
  }
}
```

`dart fix --apply` reports `deprecated_member_use - 2 fixes` and rewrites both. The `withOpacity` transform is correct. The `cacheExtent` one is not:

```dart
color: Colors.black.withValues(alpha: 0.5),
child: ListView(
  scrollCacheExtent: ScrollCacheExtent.pixels(250.0), children: const [Text('hi')],
),
```

```console
$ flutter analyze
error - Undefined name 'ScrollCacheExtent'. Try correcting the name to one that is defined,
        or defining the name - lib/main.dart:11:28 - undefined_identifier
```

`ScrollCacheExtent` is declared in `packages/flutter/lib/src/rendering/viewport.dart` and exported only from `package:flutter/rendering.dart`. Neither `material.dart` nor `widgets.dart` re-exports it, and the transform in `fix_widgets.yaml` uses `addParameter` without a companion `import` change. The rewrite is semantically right and the file no longer compiles. Adding `import 'package:flutter/rendering.dart';` fixes it, and `flutter analyze` goes green.

That failure mode generalises. `dart fix` edits token ranges described in YAML; it does not typecheck the result, and it has no idea whether the symbol it just wrote is in scope. Behaviour changes are worse than compile errors here, because nothing catches them, which is the same reason the [Material and Cupertino package split](/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/) and the [Radio to RadioGroup rewrite](/2026/08/how-to-replace-flutter-deprecated-radio-groupvalue-and-onchanged-with-radiogroup/) both need a test run after the automated pass, not just an analyze.

One consolation: a file with a syntax error does not poison the run. `dart fix` still computes and applies fixes in every other file of the same package.

## Always follow with dart format

The tool applies edits, it does not reflow the result. Note where `children` ended up above. `dart format .` restores it:

```dart
child: ListView(
  scrollCacheExtent: ScrollCacheExtent.pixels(250.0),
  children: const [Text('hi')],
),
```

Put the format step in the same commit as the fix, otherwise the next person's editor does it and the blame is worse.

## Gating it in CI

Because the exit code is always 0, a CI check has to look at the working tree instead. Apply the fixes and let git decide:

```yaml
# .github/workflows/analyze.yml
- run: dart pub get
- run: dart fix --apply
- run: git diff --exit-code
```

Verified locally: with a pending fix committed to the branch, `git diff --exit-code` returns 1 and the job fails; with nothing to fix, it returns 0. Combine it with a matrix if you [build against more than one Flutter version](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/), since the available transforms differ per SDK and a fix that is pending on 3.47 may not exist on 3.44.

The workflow that actually holds up over a multi-year codebase is boring: upgrade the SDK, delete the suppressors, resolve everything, dry-run at the root, apply one diagnostic code at a time, format, analyze, test, commit. The 392 transforms in the framework will do most of the typing. The part they cannot do is the part where you read the diff.

## Related

- [Migrate Flutter Material and Cupertino imports to the material_ui and cupertino_ui packages](/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/)
- [Migrate a Flutter web app from dart:html to package:web and dart:js_interop](/2026/09/migrate-a-flutter-web-app-from-dart-html-to-package-web/)
- [How to replace Flutter's deprecated Radio groupValue and onChanged with RadioGroup](/2026/08/how-to-replace-flutter-deprecated-radio-groupvalue-and-onchanged-with-radiogroup/)
- [Migrate a Flutter 2 app to Flutter 3.x: the null safety checklist](/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/)
- [How to target multiple Flutter versions from one CI pipeline](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)

## Sources

- [dart fix](https://dart.dev/tools/dart-fix), Dart tool documentation
- [Flutter fix](https://docs.flutter.dev/tools/flutter-fix), Flutter tool documentation
- [Breaking changes and migration guides](https://docs.flutter.dev/release/breaking-changes), Flutter release documentation
- [`pkg/dartdev/lib/src/commands/fix.dart`](https://github.com/dart-lang/sdk/blob/main/pkg/dartdev/lib/src/commands/fix.dart), Dart SDK
- [`pkg/dartdev/doc/dart-fix.md`](https://github.com/dart-lang/sdk/blob/main/pkg/dartdev/doc/dart-fix.md), Dart SDK
- [Data driven fixes](https://dart.dev/go/data-driven-fixes), Dart specification for `fix_data.yaml`
- [Pub workspaces](https://dart.dev/tools/pub/workspaces), Dart package management documentation
- [Customizing static analysis](https://dart.dev/tools/analysis), Dart analyzer documentation
