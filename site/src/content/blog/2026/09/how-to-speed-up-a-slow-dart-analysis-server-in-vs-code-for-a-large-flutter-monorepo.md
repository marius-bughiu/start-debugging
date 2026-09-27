---
title: "How to speed up a slow Dart analysis server in VS Code for a large Flutter monorepo"
description: "A monorepo with dozens of pubspec.yaml files makes the Dart analysis server build one analysis context per package, which is where the memory and the minute-long startup go. Convert to a pub workspace, exclude generated code in analysis_options.yaml, drop legacy analyzer plugins, and use the Insights page to prove it. Measured on Dart 3.12.2: 2.3x less peak memory and half the cold analysis time."
pubDate: 2026-09-27
template: "how-to"
tags:
  - "dart"
  - "flutter"
  - "vs-code"
  - "performance"
  - "monorepo"
  - "how-to"
---

**Short answer:** in a Flutter monorepo the Dart analysis server is slow mostly because it creates a separate analysis context for every package that has its own `pubspec.yaml` and `.dart_tool/package_config.json`, and each context loads its own copy of the SDK, Flutter and every shared dependency. Turn the repo into a [pub workspace](https://dart.dev/tools/pub/workspaces) (Dart 3.6+) so every package resolves into one shared context, exclude generated code with `analyzer: exclude:` in the root `analysis_options.yaml`, remove legacy analyzer plugins such as `custom_lint`, and open the workspace root in VS Code. On a synthetic 40-package, 3,240-file repo that cut peak memory from about 1.2 GB to 0.5 GB and cold analysis from 17-22 s to 11-12 s, before touching generated code at all.

Everything below was measured with Dart 3.12.2 (Flutter 3.44.8) on an Apple Silicon Mac. The current stable is Dart 3.13.3, shipped with the Flutter 3.47 line; the configuration keys and the behaviour described here are unchanged there, and 3.13.2 additionally deprecates the legacy plugin system that section 4 tells you to leave.

## Why one repo turns into forty analyzers

The analysis server (the process behind `dart language-server`, which the Dart-Code extension starts, and behind `dart analyze`) organizes work into analysis contexts. A context is a set of files that share one package resolution and one set of analysis options. Every context keeps its own resolved element model of everything it can see, which for a Flutter package means the Dart SDK, the whole `flutter` package, and every transitive dependency.

When you open a monorepo root that contains `apps/customer`, `apps/driver` and 38 packages under `packages/`, each with its own `pubspec.lock` and `.dart_tool/package_config.json`, the server has no choice: those packages might resolve `collection` or `riverpod` to different versions, so it builds 40 contexts, and it resolves `package:flutter` 40 times. The Dart team says exactly this on the workspaces page: opening the root without workspaces would "create separate analysis contexts for each package, increasing memory usage." The long-running tracking issue for the fix, [dart-lang/sdk#53874](https://github.com/dart-lang/sdk/issues/53874), puts reducing the number of contexts at the center of server performance work.

The symptoms in VS Code are familiar: "Analyzing..." spinning for a minute after opening the folder, completions that take seconds, auto-import suggestions that lag behind typing, and on 16 GB machines the server getting killed and restarted.

## Measure before you change anything

Guessing is expensive here, so get two numbers first.

In VS Code, run **Dart: Open Analyzer Diagnostics / Insights** from the command palette. It opens the server's diagnostics web page. The Contexts page lists every analysis context with its location, its workspace root, and counts of "added" files (yours) and "implicit" files (the SDK and dependency files that context had to pull in). If you see one context per package, each with thousands of implicit files, you have found the problem. The "Memory and CPU usage" page shows what the process is holding, and the "Legacy Plugins" page lists any plugin isolates. **Dart: Capture Analysis Server Timings** records which requests are slow if completions, not startup, are the complaint.

For a repeatable number you can run in CI or before and after a change, use the command line. `dart analyze` runs the same analysis server, and two hidden flags (visible with `dart analyze -h -v`) make it useful as a benchmark:

```bash
# Dart 3.12.2. --cache points at an empty dir so every run is cold.
rm -rf /tmp/dart-cache
/usr/bin/time -l dart analyze --cache=/tmp/dart-cache .
# "maximum resident set size" in the time output is peak memory (macOS, bytes).
# On Linux use: /usr/bin/time -v dart analyze --cache=/tmp/dart-cache .

# Server-reported heap, printed only with JSON output:
dart analyze --cache=/tmp/dart-cache --memory --format=json . | jq .memory
```

The `--cache` flag matters. Without it the run reuses `~/.dartServer`, and warm runs hide most of the difference you are trying to measure.

## The repo I measured

To get numbers that are not tied to one company's codebase, I generated a monorepo of 40 pure-Dart packages, each with 80 library files, a barrel file, and path dependencies on the two previous packages, so the dependency graph is a chain like a real layered app (`core` -> `data` -> `features`). That is 3,240 files. Flutter packages behave the same way for this purpose; they just make each extra context more expensive because `package:flutter` is large.

Two variants: `separate`, where each package ran its own `dart pub get`, and `workspace`, the same code converted to a pub workspace. Three cold runs each:

| Variant | Package configs | Cold `dart analyze` | Peak RSS |
| --- | --- | --- | --- |
| separate | 40 | 16.5 s / 20.7 s / 22.4 s | 1,225 / 1,291 / 1,067 MB |
| workspace | 1 | 11.1 s / 11.6 s / 11.7 s | 499 / 495 / 490 MB |

Same diagnostics, same code, less than half the memory. In the IDE the gap is worse than in a one-shot CLI run, because the server lives for your whole session and every context stays resident.

## Step by step: make the analyzer fast again

1. Upgrade the SDK past known regressions.
2. Convert the repo to a pub workspace.
3. Exclude generated and vendored code in `analysis_options.yaml`.
4. Remove legacy analyzer plugins.
5. Open the workspace root in VS Code and trim what the IDE sees.

### 1. Upgrade past known regressions

Dart 3.11.0 shipped with a performance problem in workspaces with many files and many directories, fixed in 3.11.1 ([dart-lang/sdk#62456](https://github.com/dart-lang/sdk/issues/62456)). There is also an open report, [dart-lang/sdk#62704](https://github.com/dart-lang/sdk/issues/62704), of an 18-package workspace going from about 10 s to over 6 minutes after moving to 3.11.0. If you are on 3.11.0 exactly, upgrade first and re-measure. Dart 3.12 also improved startup with better caching of analysis options files, which helps most when every package has its own `analysis_options.yaml` that `include:`s a shared one.

### 2. Convert to a pub workspace

A workspace needs every member to declare `resolution: workspace` and an SDK lower bound of at least 3.6. The root `pubspec.yaml` lists the members:

```yaml
# pubspec.yaml at the repo root. Dart 3.6+ (measured on 3.12.2).
name: _
publish_to: none
environment:
  sdk: ^3.12.0
workspace:
  - apps/customer
  - apps/driver
  - packages/core
  - packages/data
  - packages/design_system
```

```yaml
# packages/data/pubspec.yaml
name: data
publish_to: none
environment:
  sdk: ^3.12.0
  flutter: ">=3.44.0"
resolution: workspace
dependencies:
  flutter:
    sdk: flutter
  core:
    path: ../core
```

Then clean up the per-package resolution artifacts and resolve once from the root:

```bash
# Remove stale per-package lockfiles and package configs, then resolve the workspace.
find . -name pubspec.lock -not -path './pubspec.lock' -delete
find . -path '*/.dart_tool/package_config.json' -not -path './.dart_tool/*' -delete
flutter pub get   # or: dart pub get
```

After this there is one `pubspec.lock` and one `.dart_tool/package_config.json`, both at the root. Restart the analysis server (**Dart: Restart Analysis Server**) and check the Contexts page again: you should see one context for the workspace.

The trade-off is that the workspace has a single version solve. If `apps/driver` pins `intl` to one major and `apps/customer` needs another, `pub get` fails until you align them. That failure is the migration work; most repos discover two or three such conflicts. If you use Melos, version 7.0.0 moved to pub workspaces and replaced `melos.yaml` with a `melos:` section in the root `pubspec.yaml`, so upgrading Melos and converting to a workspace are the same job.

### 3. Exclude generated and vendored code

Generated Dart is often as large as the code you wrote. `freezed`, `json_serializable`, `mockito`, `drift` and `intl` output sits next to your sources as `*.g.dart`, `*.freezed.dart` and `*.mocks.dart`, and the server resolves and lints every line. (If code generation is itself failing, see [the source_gen and analyzer version mismatch that breaks build_runner](/2026/08/fix-the-method-getinvocation-isnt-defined-for-the-type-dartobjectimpl/); if you are choosing between generated models and built-in ones, [Dart records vs freezed classes](/2026/05/dart-records-vs-freezed-classes/) is the relevant comparison.)

```yaml
# analysis_options.yaml at the workspace root. Dart 3.12.2.
include: package:flutter_lints/flutter.yaml

analyzer:
  exclude:
    - "**/*.g.dart"
    - "**/*.freezed.dart"
    - "**/*.mocks.dart"
    - "**/build/**"
    - "third_party/**"
```

I added 10 generated-style files (about 1,000 lines) to each of the 40 packages and measured again in the workspace variant:

| Workspace + generated code | Cold `dart analyze` | Peak RSS |
| --- | --- | --- |
| generated files analyzed | 19.4 s / 14.7 s | 1,148 / 1,185 MB |
| `**/*.g.dart` excluded | 6.9 s / 6.9 s | 523 / 523 MB |

Four details about `exclude` that the docs do not spell out, all verified on 3.12.2:

- **Globs are relative to the options file.** The [analysis docs](https://dart.dev/tools/analysis) say so explicitly. `**/*.g.dart` works from anywhere; `lib/**` in the root file means the root's `lib`, not every package's.
- **In a workspace, the root file's exclude covers members that have their own `analysis_options.yaml`.** In my test every package kept its own options file, and a root-only `exclude` still removed their generated files from analysis. Without a workspace it does not: each package is its own context root, the root file is ignored for them, and you need the exclude in every package, or an `include: ../../analysis_options.yaml` line in each package's file, which does carry the exclude over.
- **Excluding a file does not stop it from being resolved when something imports it.** I excluded a library that other files import and put a warning in it. The warning disappeared, the importers still type-checked. So exclusion saves the lint and diagnostic work, and it saves everything for files nobody imports (mocks, test fixtures, stale output), but a `*.g.dart` `part` of a model you use will still be read.
- **`build/` is not skipped by default.** Folders whose name starts with a dot (`.dart_tool`, `.git`) are ignored, but a `build/` or `ios/Pods/` directory that happens to contain `.dart` files is analyzed. Nested `example/` apps with their own `pubspec.yaml` that are not workspace members become extra contexts, too. Either add them to the workspace or exclude them.

### 4. Remove legacy analyzer plugins

Legacy analyzer plugins, the `analyzer: plugins:` kind that `custom_lint` and older tools use, run in separate isolates attached to analysis contexts. The Dart docs warn that enabling one "increases how much memory the analyzer uses" and recommend avoiding them entirely if you have less than 16 GB of RAM or a monorepo with 10 or more `pubspec.yaml` or `analysis_options.yaml` files. Dart 3.13.2 formally deprecated the legacy system.

Check for them:

```bash
grep -rn --include=analysis_options.yaml -A3 'plugins:' .
```

If the lints matter, move to the [new plugin system](https://dart.dev/tools/analyzer-plugins) added in Dart 3.10, configured with a top-level `plugins:` key and supported by both the IDE and `dart analyze`. Dart 3.11 made it reuse an AOT snapshot of the plugin entrypoint, which the changelog says saves on the order of 10 seconds at the start of every IDE session. If the lints do not matter enough to port, delete the plugin and measure the difference; it is usually the single largest drop after the workspace conversion.

### 5. Open the right folder and trim what the IDE sees

With a workspace, open the repo root in VS Code rather than a single app folder, so one server session covers every member and cross-package navigation, rename and find-references work across the whole repo.

Two Dart-Code settings are worth knowing, and one is worth avoiding:

```jsonc
// .vscode/settings.json (Dart-Code extension)
{
  // Folders the IDE analysis server ignores entirely, including for project detection.
  "dart.analysisExcludedFolders": [
    "tools/legacy_scripts",
    "third_party"
  ],
  // Keep SDK and dependency symbols out of Ctrl+T if workspace symbol search is slow.
  "dart.includeDependenciesInWorkspaceSymbols": false
}
```

`dart.analysisExcludedFolders` only affects the editor, so prefer `analyzer: exclude:` for anything that should also be skipped by `dart analyze` in CI. Reach for the VS Code setting when a folder should stay analyzed in CI but not locally, such as a large archived app nobody on your team edits.

Avoid `dart.onlyAnalyzeProjectsWithOpenFiles`. It is deprecated, and its own description warns it "can make performance significantly worse when moving around a project", because the server keeps tearing down and rebuilding contexts as you switch files.

## When it is still slow

If the Contexts page shows one context and generated code is excluded, the remaining cost is real code. A few things to check:

- **Circular or very wide barrel exports.** A barrel file that re-exports an entire package makes every importer depend on every file in it, so an edit invalidates far more than it needs to. Import from `src/` paths inside a package and keep barrels for the public API.
- **One mega-package.** Splitting a 3,000-file `app` package into features does not reduce total work, but it does let the server skip re-analysis of unaffected libraries after an edit.
- **A server restart after big git operations.** Switching branches that touch hundreds of files queues a lot of work. **Dart: Restart Analysis Server** is faster than waiting for incremental invalidation in some cases.
- **Instrumentation for a bug report.** Set `dart.analyzerInstrumentationLogFile` to a path, reproduce, and attach it to an issue on [dart-lang/sdk](https://github.com/dart-lang/sdk/issues). The regressions above were found this way.

These are the same contexts `dart fix` walks, which is why [running dart fix across the whole repo](/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/) also gets faster after the workspace conversion. And if you run an AI agent against the repo through [the Dart and Flutter MCP server](/2026/05/dart-flutter-mcp-server-claude-code-cursor/), it is talking to an analysis server too, so a leaner context layout helps there as much as it does in your editor.

## Sources

- [Pub workspaces (monorepo support)](https://dart.dev/tools/pub/workspaces), dart.dev
- [Customizing static analysis](https://dart.dev/tools/analysis), dart.dev
- [Analyzer plugins](https://dart.dev/tools/analyzer-plugins), dart.dev
- [Dart SDK CHANGELOG](https://github.com/dart-lang/sdk/blob/main/CHANGELOG.md), entries for 3.10.0, 3.11.0, 3.11.1, 3.12.0 and 3.13.2
- [Dart-Code settings reference](https://dartcode.org/docs/settings/)
- [dart-lang/sdk#53874: reduce the number of analysis contexts](https://github.com/dart-lang/sdk/issues/53874)
- [Melos changelog, 7.0.0](https://pub.dev/packages/melos/changelog)
