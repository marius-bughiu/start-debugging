---
title: "What is pubspec_overrides.yaml and when should I use it in a Flutter monorepo?"
description: "pubspec_overrides.yaml is a file next to pubspec.yaml that pub reads on top of it, limited to dependency_overrides, resolution and workspace. It replaces the whole dependency_overrides section, applies workspace-wide, and is left out of published archives. What it does, when to use it in a monorepo, and every edge case, verified on Dart 3.12.2."
pubDate: 2026-11-03
tags:
  - "dart"
  - "flutter"
  - "pub"
  - "pubspec"
  - "monorepo"
---

**Short answer:** `pubspec_overrides.yaml` is an optional file you place next to a `pubspec.yaml`. When pub (`dart pub get` or `flutter pub get`) resolves that package, it reads the file and lets its fields win over the same fields in `pubspec.yaml`. Only three fields are allowed: `dependency_overrides`, `resolution` and `workspace`. In a Flutter monorepo, use it for **local, temporary** changes you do not want in the committed pubspec: pointing a dependency at a local checkout or fork while you debug it, or detaching one package from a pub workspace for a standalone resolution. Do not use it for overrides the whole team needs; those belong in the root `pubspec.yaml`, and since Dart 3.6 a pub workspace removes the main reason monorepos used to generate these files at all. Everything below was checked on Dart 3.12.2 (stable, macOS arm64).

The file arrived in Dart 2.16 (February 2022). The SDK changelog describes it as a separate file "that can contain `dependency_overrides`", added to make it "easier to avoid checking the local overrides into version control." The `resolution` and `workspace` keys came later with [pub workspaces](https://dart.dev/tools/pub/workspaces) in Dart 3.6.

## What pub actually does with the file

The official documentation in the [dependencies guide](https://dart.dev/tools/pub/dependencies#pubspec-overrides-yaml) is two paragraphs long, so it is worth knowing the exact behaviour. The tests for this post use a small set of path packages: `greeter_v1` (version 1.0.0, prints "hello from v1"), `greeter_fork` (1.0.1, prints "hello from fork"), and an `app` that depends on the first one.

```yaml
# app/pubspec.yaml  (Dart 3.12.2)
name: app
publish_to: none
environment:
  sdk: ^3.6.0
dependencies:
  greeter:
    path: ../greeter_v1
```

Then a `pubspec_overrides.yaml` in the same folder:

```yaml
# app/pubspec_overrides.yaml
dependency_overrides:
  greeter:
    path: ../greeter_fork
```

`dart pub get --offline` now prints:

```text
Resolving dependencies...
Downloading packages...
! greeter 1.0.1 from path ../greeter_fork (overridden in ./pubspec_overrides.yaml)
Got dependencies!
```

The `!` marker and the `(overridden in ./pubspec_overrides.yaml)` suffix are the only visible signs. `dart run` prints "hello from fork". Relative paths inside the file are resolved from the folder that holds it, which is the same folder as `pubspec.yaml`, so you write them exactly as you would in the pubspec.

That is the core mechanic: the overrides file is a patch on top of `pubspec.yaml`, applied at resolution time, that never touches the file you commit.

## The three keys, and the error you get for anything else

The file is not a general-purpose pubspec layer. Trying to add a dependency through it fails hard:

```yaml
# app/pubspec_overrides.yaml -- invalid
dependencies:
  greeter:
    path: ../greeter_fork
```

```text
Error on line 1, column 1 of pubspec_overrides.yaml: pubspec_overrides.yaml only supports the `dependency_overrides`, `resolution` and `workspace` fields.
  ╷
1 │ dependencies:
  │ ^^^^^^^^^^^^
  ╵
```

The exit code is 65, the same one pub uses for any invalid pubspec. `name: something` fails the same way. You cannot change the package name, version, SDK constraint, `flutter:` section, assets, or regular dependencies from this file.

What each allowed key does:

- **`dependency_overrides`**: forces a package to a specific version or source (path, git, hosted) for the whole resolution, ignoring every constraint on it. This is the key you will use almost every time.
- **`resolution`**: in a pub workspace member, overrides `resolution: workspace`. Setting it to an empty value makes the member resolve on its own.
- **`workspace`**: in a workspace root, overrides the list of member packages.

## It replaces `dependency_overrides`, it does not merge

This is the behaviour most likely to surprise you. If your committed `pubspec.yaml` already has a `dependency_overrides` section, the one in `pubspec_overrides.yaml` replaces it entirely. Pub does not merge the two maps.

Add a second dependency, `other`, with a committed override pointing at `other_fork`:

```yaml
# app/pubspec.yaml  (Dart 3.12.2)
dependencies:
  greeter:
    path: ../greeter_v1
  other:
    path: ../other_v1
dependency_overrides:
  other:
    path: ../other_fork
```

With the overrides file from earlier (which only mentions `greeter`), `dart pub get` printed:

```text
! greeter 1.0.1 from path ../greeter_fork (overridden in ./pubspec_overrides.yaml)
+ other 1.0.0 from path ../other_v1
```

The committed override of `other` silently disappeared: it resolved to `other_v1` with no `!` and no warning. If you want both, copy the committed overrides into `pubspec_overrides.yaml` as well.

Two more cases follow from the same rule:

- An **empty** `pubspec_overrides.yaml` (zero bytes) is ignored. The committed `other` override came back.
- A file containing just `dependency_overrides:` with no entries **clears all overrides**, including the committed ones. Pub printed `* other 1.0.0 from path ../other_v1 (was 1.0.1 from path ../other_fork)`. That is a handy way to test your package without the team's overrides, and an easy way to break your build by accident.

## Overrides only apply to the root of the resolution

Like `dependency_overrides` in `pubspec.yaml`, the overrides file is only read for the package (or workspace) you are running `pub get` in. The docs say it plainly: "Dependency overrides inside any depended-on packages are ignored."

To confirm, a `mid` package got its own `pubspec_overrides.yaml` pointing `greeter` at the fork, and a `top` package depended on `mid` by path. Running `pub get` in `top`:

```text
+ greeter 1.0.0 from path ../greeter_v1
+ mid 1.0.0 from path ../mid
```

`mid`'s overrides file had no effect. This matters in monorepos that are **not** workspaces: if `apps/customer` depends on `packages/core` by path, the overrides file in `packages/core` only applies when you run `pub get` inside `packages/core`. When you build the app, the app's own overrides (or lack of them) decide.

## How it behaves inside a pub workspace

A pub workspace (Dart 3.6+) resolves all members together into one `pubspec.lock` at the root. Overrides follow the workspace, not the folder. The [workspaces page](https://dart.dev/tools/pub/workspaces#dependency-overrides-in-a-workspace) says all `dependency_overrides` sections in members are respected, that you can put a `pubspec_overrides.yaml` next to any member's pubspec, and that "You can only override a package once in the workspace."

The workspace test used a root with two members, `pkg_a` and `pkg_b`, both depending on `greeter_v1`:

```yaml
# ws/pubspec.yaml  (Dart 3.12.2)
name: ws_root
publish_to: none
environment:
  sdk: ^3.6.0
workspace:
  - packages/pkg_a
  - packages/pkg_b
```

Adding a `pubspec_overrides.yaml` to `packages/pkg_a` only, then running `dart pub get` at the root:

```text
! greeter 1.0.1 from path ../greeter_fork (overridden)
```

Running `pkg_b`'s entry point printed "hello from fork". An override in **one member changes the version for every member**, because there is only one resolution. That is the correct mental model: in a workspace, an override anywhere is an override everywhere.

Overriding the same package a second time, in the root's own `pubspec_overrides.yaml`, is an error:

```text
The package `greeter` is overridden in both:
package `ws_root` at `.` and 'pkg_a' at `./packages/pkg_a`.

Consider removing one of the overrides.
```

Exit code 1. Because of that, keep workspace overrides in one place. The docs recommend the root `pubspec.yaml` for shared overrides, and the simplest rule is to put the local, uncommitted ones in the root `pubspec_overrides.yaml` too, so there is exactly one file to look at.

### Detaching one member with `resolution:`

The documented trick for testing one member against its own dependency graph (for example, to check that a package you publish still resolves outside the monorepo) is a `pubspec_overrides.yaml` in that member containing only:

```yaml
# packages/pkg_b/pubspec_overrides.yaml
resolution:
```

Running `dart pub get` inside `packages/pkg_b` then creates a separate `pubspec.lock` and `.dart_tool/` in that folder. The catch: while the file exists, `dart pub get` **at the workspace root fails**:

```text
packages/pkg_b/pubspec.yaml is included in the workspace from ./pubspec.yaml, but does not have `resolution: workspace`.
```

So this is strictly a temporary state. Delete the file (and the member's local `pubspec.lock` and `.dart_tool/`) before going back to the workspace. If you need the member out for longer, override the root's `workspace:` list in the root `pubspec_overrides.yaml` instead, so the root stops expecting it.

## When to use it in a Flutter monorepo

Good uses, all of them local and short-lived:

1. **Debugging a dependency from source.** Clone the package, point `dependency_overrides` at the clone with `path:`, add a `print` or fix the bug, and run your app. Nothing in the committed pubspec changes, so there is nothing to forget to revert in review.
2. **Testing an unreleased fix from a fork or branch.** A `git:` override with a `ref:` lets you try a pull request before it is published, without asking the whole team to depend on a git URL.
3. **Checking a package against what consumers get.** Use `dependency_overrides:` with no entries to drop the team's committed overrides, or `resolution:` to pull one member out of the workspace, and see whether it still resolves.
4. **Machine-specific paths.** If two developers keep a shared package at different locations on disk, each can have their own overrides file pointing at their checkout.

Bad uses:

- **Anything CI must also see.** If the override is needed for the build to pass, it belongs in `pubspec.yaml` where reviewers and CI can see it.
- **Linking local packages in a monorepo, on Dart 3.6 or later.** That used to be the main use. Melos added support for "bootstrapping with pubspec overrides" in 1.6.0/2.0.0 and, from Melos 3.0.0, generated a `pubspec_overrides.yaml` in every package so local packages pointed at each other by path ("only support bootstrapping with `pubspec_overrides.yaml`" in its [changelog](https://github.com/invertase/melos/blob/main/packages/melos/CHANGELOG.md)). Melos 7.0.0 migrated to pub workspaces, which link members natively. If you see a pile of generated `pubspec_overrides.yaml` files in an old monorepo, converting to a workspace removes the need for them. The [workspace conversion steps](/2026/09/how-to-speed-up-a-slow-dart-analysis-server-in-vs-code-for-a-large-flutter-monorepo/) also make the analysis server much faster. Melos 7 still writes to these files for its `dependencyOverridePaths` setting, so a Melos 7 repo may legitimately still have them.
- **Papering over a resolution failure.** An override ignores every constraint. If you are adding one to make `version solving failed` go away, read [how to diagnose that error](/2026/05/fix-version-solving-failed-in-pubspec-yaml/) first, because an override that compiles today can still crash at runtime against an incompatible API.

## Keep it out of git, and watch `pubspec.lock`

Add the file to your root `.gitignore`:

```text
# Local-only pub overrides
pubspec_overrides.yaml
```

The overrides file is local, but `pubspec.lock` is not, and nothing in the lock file says a dependency was overridden. After the override in the first example, the lock entry looked like any normal path dependency:

```yaml
  greeter:
    dependency: "direct main"
    description:
      path: "../greeter_fork"
      relative: true
    source: path
    version: "1.0.1"
```

If you commit that lock file for an app, CI checks out the repo without your overrides file and the lock no longer matches. With `--enforce-lockfile` (a good flag for CI), that is a hard failure:

```text
* greeter 1.0.0 from path ../greeter_v1 (was 1.0.1 from path ../greeter_fork)
Would change 1 dependency.
Unable to satisfy `pubspec.yaml` using `pubspec.lock`.
```

Exit code 65. Without the flag, CI quietly re-resolves and builds with different versions than you tested. Before committing, delete or rename the overrides file, run `flutter pub get`, and commit the lock file it produces. If the lock file keeps showing up as modified for other reasons, see [why pubspec.lock changes after a Flutter upgrade](/2026/10/fix-pubspec-lock-modified-after-flutter-upgrade-or-switching-flutter-versions/).

## What happens when you publish

Publishing is safe by design but loud. With an overrides file present in a package, `dart pub publish --dry-run` resolved using the override and then reported:

```text
Package validation found the following hint:
* Non-dev dependencies are overridden in pubspec_overrides.yaml.

  This indicates you are not testing your package against the same versions of its
  dependencies that users will have when they use it.
```

It was a hint, not a warning or error (`Package has 0 warnings and 1 hint.`), and the file was **not** included in the archive listing: only `CHANGELOG.md`, `LICENSE`, `README.md`, `lib/` and `pubspec.yaml` were. Consumers never see your overrides. The real risk is the one the hint names: your tests ran against the fork, and your users will get whatever their own resolution picks.

## Checklist before you rely on one

1. Confirm pub picked it up: look for `!` and `(overridden in ./pubspec_overrides.yaml)` in the `pub get` output.
2. If `pubspec.yaml` has its own `dependency_overrides`, copy them into the overrides file, or they are gone.
3. In a workspace, remember the override applies to every member, and a package can be overridden only once.
4. Keep `pubspec_overrides.yaml` in `.gitignore`.
5. Delete it and run `flutter pub get` before committing `pubspec.lock`.

Related reading on this site: [what the `depend_on_referenced_packages` lint checks](/2026/10/what-is-the-depend-on-referenced-packages-lint-in-dart/), which is the lint that fires when an override tempts you to import a package you never declared, and [running `dart fix` across a whole repo](/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/) for the other half of keeping a large monorepo healthy.

## How these results were produced

All outputs above came from local path packages (no network, `--offline`) on Dart SDK 3.12.2 stable, macOS arm64, using `dart pub get`, `dart run` and `dart pub publish --dry-run`. `flutter pub get` runs the same pub solver, but the Flutter command itself was not exercised for this post.

Sources:

- [Dart docs: Package dependencies, Dependency overrides and `pubspec_overrides.yaml`](https://dart.dev/tools/pub/dependencies)
- [Dart docs: Pub workspaces](https://dart.dev/tools/pub/workspaces)
- [Dart SDK CHANGELOG, 2.16.0 Pub section](https://github.com/dart-lang/sdk/blob/main/CHANGELOG.md)
- [Melos CHANGELOG](https://github.com/invertase/melos/blob/main/packages/melos/CHANGELOG.md)
