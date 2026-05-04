---
title: "How to target multiple Flutter versions from one CI pipeline"
description: "Practical guide to running one Flutter project against multiple SDK versions in CI: a GitHub Actions matrix with subosito/flutter-action v2, FVM 3 .fvmrc as the source of truth, channel pinning, caching, and the gotchas that bite when the matrix grows past three versions."
pubDate: 2026-05-04
template: how-to
tags:
  - "flutter"
  - "dart"
  - "ci"
  - "github-actions"
  - "fvm"
  - "how-to"
---

Short answer: pin the project's primary Flutter version in `.fvmrc` (FVM 3 style) and use that file as the truth source for local development. In CI, run a `strategy.matrix` job over the extra Flutter versions you care about, install each with `subosito/flutter-action@v2` (it reads `flutter-version-file: .fvmrc` for the primary build and accepts an explicit `flutter-version: ${{ matrix.flutter-version }}` for the matrix entries), enable both `cache: true` and `pub-cache: true`, and gate the matrix with `fail-fast: false` so a single broken version does not hide the others. Treat the primary version as required and the matrix versions as informational until you have stabilized them.

This guide is for Flutter 3.x projects in May 2026, validated against `subosito/flutter-action@v2` (latest v2.x), FVM 3.2.x, and Flutter SDK 3.27.x and 3.32.x on GitHub-hosted Ubuntu and macOS runners. It assumes one repo, one `pubspec.yaml`, and the goal of catching regressions across Flutter versions before they reach a release branch. The patterns translate to GitLab CI and Bitbucket Pipelines with small syntax changes; the matrix concepts are identical.

## Why one repo against multiple Flutter versions is even a thing

Flutter has two release channels, `stable` and `beta`, and only `stable` is supported in production. The Flutter docs recommend stable for new users and for production releases, which is correct, and it would be lovely if every team could pick one stable patch and stay there. In practice three pressures push teams off that path:

1. A package you depend on bumps its `environment.flutter` lower bound, and the new bound is one minor ahead of where you sit.
2. A new stable lands with an Impeller fix or an iOS build fix you need, but a transitive package has not certified against it yet.
3. You ship a library or template (a starter kit, an in-house design system) that downstream apps consume on whatever Flutter their team has standardized on, and you need to know it does not break under any of `stable - 1`, `stable`, or `beta`.

In all three cases the answer is the same boring discipline: pick one version as the contract for your developer machines, and treat every other version you care about as a CI matrix entry. That is the model the rest of this post builds.

A quick reminder on what `pubspec.yaml` actually enforces. The `environment.flutter` constraint is checked by `pub` only as a lower bound. As covered in [flutter/flutter#107364](https://github.com/flutter/flutter/issues/107364) and [#113169](https://github.com/flutter/flutter/issues/113169), the SDK does not enforce the upper bound on the `flutter:` constraint, so writing `flutter: ">=3.27.0 <3.33.0"` will not stop a developer on Flutter 3.40 from installing your package. You need an external mechanism. That mechanism is FVM for humans and `flutter-action` for CI.

## Step 1: Make `.fvmrc` the project's source of truth

Install [FVM 3](https://fvm.app/) once per workstation, then pin the project from the repo root:

```bash
# FVM 3.2.x, May 2026
dart pub global activate fvm
fvm install 3.32.0
fvm use 3.32.0
```

`fvm use` writes `.fvmrc` and updates `.gitignore` so the heavy `.fvm/` directory is not committed. Per the [FVM configuration docs](https://fvm.app/documentation/getting-started/configuration), only `.fvmrc` (and the legacy `fvm_config.json` if you have one from FVM 2) belongs in version control. Commit it and the file becomes the contract every developer and every CI job reads.

A minimal `.fvmrc` looks like this:

```json
{
  "flutter": "3.32.0",
  "flavors": {
    "next": "3.33.0-1.0.pre",
    "edge": "beta"
  },
  "updateVscodeSettings": true,
  "updateGitIgnore": true
}
```

The `flavors` map is the FVM concept that maps perfectly onto a CI matrix: each entry is a named Flutter version your project tolerates. `next` is the upcoming stable you want a green light on, `edge` is the live beta channel for early-warning signal. Locally, a developer can run `fvm use next` to sanity-check before opening a PR. In CI, you will iterate the same flavor names from the matrix, so the names stay aligned.

## Step 2: One workflow, one primary build, one matrix job

The trap most teams fall into on the first attempt is putting every Flutter version into the same matrix and treating them all as required. That makes the runtime balloon and turns one flaky beta into a red main branch. The pattern that scales is two jobs in the same workflow file:

- A **primary** job that installs only the version from `.fvmrc` and runs the full test, build, and ship pipeline. It is required by branch protection.
- A **compatibility** matrix job that installs each extra version, runs the analyzer and tests, and is informational until you trust it.

Here is the workflow, with the v6 of `actions/checkout` (current as of May 2026) and `subosito/flutter-action@v2`:

```yaml
# .github/workflows/flutter-ci.yml
name: Flutter CI

on:
  push:
    branches: [main]
  pull_request:

concurrency:
  group: flutter-ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  primary:
    name: Primary (.fvmrc)
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v6
      - uses: subosito/flutter-action@v2
        with:
          flutter-version-file: .fvmrc
          channel: stable
          cache: true
          pub-cache: true
      - run: flutter --version
      - run: flutter pub get
      - run: dart format --output=none --set-exit-if-changed .
      - run: flutter analyze
      - run: flutter test --coverage

  compat:
    name: Compat (Flutter ${{ matrix.flutter-version }})
    needs: primary
    runs-on: ${{ matrix.os }}
    timeout-minutes: 20
    continue-on-error: ${{ matrix.experimental }}
    strategy:
      fail-fast: false
      matrix:
        include:
          - flutter-version: "3.27.4"
            channel: stable
            os: ubuntu-latest
            experimental: false
          - flutter-version: "3.32.0"
            channel: stable
            os: macos-latest
            experimental: false
          - flutter-version: "3.33.0-1.0.pre"
            channel: beta
            os: ubuntu-latest
            experimental: true
    steps:
      - uses: actions/checkout@v6
      - uses: subosito/flutter-action@v2
        with:
          flutter-version: ${{ matrix.flutter-version }}
          channel: ${{ matrix.channel }}
          cache: true
          pub-cache: true
      - run: flutter pub get
      - run: flutter analyze
      - run: flutter test
```

A few things in that file are deliberate and worth calling out before you copy it.

**`fail-fast: false`** is mandatory for a compat matrix. Without it, the first version that fails cancels the others, which defeats the purpose. You want to see, in one CI run, that 3.27 passes, 3.32 fails, and beta passes, not just "something failed".

**`continue-on-error` per matrix entry** lets you mark beta as tolerated red. Branch protection should require the `Primary (.fvmrc)` check name and any compat entries you have classified as required. Beta and "next" stay green-ish on the dashboard but never block a merge.

**`needs: primary`** is a small but important sequencing detail. It means CI minutes are not burned on the matrix until the primary build proves the change is at least syntactically sane. On a 30-job matrix this matters. On a 3-job matrix it is still a free win.

**`concurrency`** cancels in-progress runs on the same ref when a new commit lands. Without it, a developer who pushes three times in a minute pays for three full matrix runs.

## Step 3: Caching that actually hits across versions

`subosito/flutter-action@v2` caches the Flutter SDK install with `actions/cache@v5` under the hood. Each unique combination of `(os, channel, version, arch)` produces a separate cache entry, which is exactly what you want. The default cache key is a function of those tokens, so a 3-version matrix produces 3 SDK caches and a 2-OS by 3-version matrix produces 6. This is fine until you start customizing.

The two knobs worth knowing:

- `cache: true` caches the SDK itself. Saves about 90 seconds per run on Ubuntu, more on macOS where the install pulls Xcode-related artifacts.
- `pub-cache: true` caches `~/.pub-cache`. This is the bigger win for incremental change. A typical Flutter app with 80 transitive packages takes 25-40 seconds for `pub get` cold, under 5 seconds warm.

If you have a monorepo with multiple Flutter projects sharing dependencies, set a `cache-key` and `pub-cache-key` that include the hash of all relevant `pubspec.lock` files, not just the default. Otherwise each subproject overwrites the others' cache. The action exposes `:hash:` and `:sha256:` tokens for exactly this; see the [README](https://github.com/subosito/flutter-action) for the syntax.

What does **not** belong in your matrix cache key is the Flutter SDK channel name when you are pinning to a `*-pre` build. Beta tags get rebuilt occasionally, so a cache hit on a `*-pre` version can serve a stale binary. The simplest fix is to skip caching for the `experimental: true` entries:

```yaml
- uses: subosito/flutter-action@v2
  with:
    flutter-version: ${{ matrix.flutter-version }}
    channel: ${{ matrix.channel }}
    cache: ${{ !matrix.experimental }}
    pub-cache: ${{ !matrix.experimental }}
```

You give up a minute of install time on the beta entry and gain confidence that the beta build is reproducible.

## Step 4: Wire `.fvmrc` and the matrix together

The point of FVM flavors plus a matrix is that the names line up. Adding a new compat target should be a one-line change in `.fvmrc` and a one-line change in the workflow. To keep them in sync without manual coordination, generate the matrix from the file at job time. GitHub Actions can do this with a small bootstrap job that emits a JSON matrix:

```yaml
  matrix-builder:
    name: Build matrix from .fvmrc
    runs-on: ubuntu-latest
    outputs:
      matrix: ${{ steps.build.outputs.matrix }}
    steps:
      - uses: actions/checkout@v6
      - id: build
        run: |
          MATRIX=$(jq -c '
            {
              include: (
                .flavors // {} | to_entries
                | map({
                    "flutter-version": .value,
                    "channel": (if (.value | test("pre|dev")) then "beta" else "stable" end),
                    "os": "ubuntu-latest",
                    "experimental": (.key == "edge")
                  })
              )
            }' .fvmrc)
          echo "matrix=$MATRIX" >> "$GITHUB_OUTPUT"

  compat:
    needs: [primary, matrix-builder]
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix: ${{ fromJson(needs.matrix-builder.outputs.matrix) }}
    # ... same steps as before
```

Now adding `"perf-investigation": "3.31.2"` to `.fvmrc` automatically adds a compat job on the next CI run. No second source of truth, no drift between what local FVM tries and what CI verifies. The `flutter-actions/pubspec-matrix-action` GitHub Action does a similar thing if you would rather use a maintained dependency than the inline `jq`; both approaches work.

## Gotchas that show up after the second matrix entry

Once the matrix is more than three versions, you will hit at least one of these.

**Pub cache poisoning.** A package that uses conditional imports for newer Flutter symbols may resolve differently on 3.27 versus 3.32. If both versions share a `pub-cache`, the lock file written by 3.32 can be served back to 3.27 and produce a build that "works" with the wrong code path. Use a `pub-cache-key` that includes the Flutter version token (`:version:`) to keep them separate. The cost is a colder cache; the benefit is reproducibility.

**`pubspec.lock` churn.** If you commit `pubspec.lock` (recommended for application repos, not for libraries), the matrix will regenerate it differently per Flutter version, and a developer running on `.fvmrc`'s version will see a different lock than CI's matrix entries see. The fix is to skip lock writeback in the matrix: pass `--enforce-lockfile` to `flutter pub get`, which fails on resolution divergence instead of mutating the lock. Apply this only in the matrix job; the primary job should still allow updates so Renovate or Dependabot PRs can reach green.

**iOS builds and beta channel.** `subosito/flutter-action@v2` installs the Flutter SDK but it does not change the Xcode version on `macos-latest`. The runner's Xcode is upgraded on a different cadence than Flutter's beta channel, and Flutter beta will sometimes require an Xcode that the runner does not yet ship. When the iOS build step (`flutter build ipa --no-codesign`) starts failing on beta only, check the runner's Xcode against the [`flutter doctor`](https://docs.flutter.dev/get-started/install) requirements before you assume your code is broken. Pinning the runner with `runs-on: macos-15` instead of `macos-latest` gives you control over that variable.

**Architecture defaults.** As of May 2026 GitHub-hosted runners are ARM64 by default on macOS and x64 on Ubuntu. If you build native plugins, the architecture token in the cache key matters; otherwise an Apple Silicon cache can be served to an x64 runner on a future migration. The action's default `cache-key` includes `:arch:` for this reason; do not strip it when you customize.

**Dart SDK skew.** Each Flutter version ships a specific Dart SDK. A `dart format` run on Flutter 3.32 (Dart 3.7) produces different formatting in a few edge cases than Flutter 3.27 (Dart 3.5). Run formatting in the primary job only, not in the matrix, to avoid spurious "format check failed" reports on older versions. The same logic applies to lints: a new lint introduced in Dart 3.7 will fire on 3.32 and not on 3.27. Use a project-level `analysis_options.yaml` and only enable new lints once the oldest matrix version supports them.

## When to stop adding versions

The point of all this is to catch regressions early, not to test exhaustively. A matrix of more than three or four versions usually means the team is afraid to upgrade rather than confident in upgrading. If your matrix has grown to five, ask which entry has not caught a regression in six months. That entry probably should be retired. The right cadence for most apps is `current stable`, `next stable when announced`, and `beta`, which means the matrix-builder script in Step 4 keeps it bounded by what `.fvmrc` declares.

The discipline that pays off is the same one that makes [pinning the Flutter SDK reproducibly](/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/) work in the first place: declare the versions you care about, install only those versions, and treat anything outside that set as out of contract. The matrix is the enforcement.

## Related

- [Flutter 3.38.6 and the engine.version bump: reproducible builds get easier if you pin it](/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/) covers why pinning the SDK matters even within a single channel.
- [Dart 3.12 dev tags are moving fast](/2026/01/dart-3-12-dev-tags-are-moving-fast-how-to-read-them-and-what-to-do-as-a-flutter-3-x-developer/) explains how Dart's dev tag cadence interacts with Flutter channel choices.
- [Debugging Flutter iOS from Windows](/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/) is the companion piece for teams whose CI matrix needs to cover macOS but whose developers do not run Macs daily.
- [FlutterGuard CLI: a fast "what can an attacker extract" check for Flutter 3.x apps](/2026/01/flutterguard-cli-a-fast-what-can-an-attacker-extract-check-for-flutter-3-x-apps/) is a useful additional step to add to the primary job once your matrix is stable.

## Source links

- [subosito/flutter-action README](https://github.com/subosito/flutter-action)
- [flutter-actions/setup-flutter](https://github.com/flutter-actions/setup-flutter) (the maintained alternative if v2 ever lags)
- [FVM 3 documentation](https://fvm.app/documentation/getting-started/configuration)
- [Flutter pubspec options](https://docs.flutter.dev/tools/pubspec)
- [Upgrade Flutter](https://docs.flutter.dev/install/upgrade)
- [flutter/flutter#107364: SDK constraint upper bound is not enforced](https://github.com/flutter/flutter/issues/107364)
- [flutter/flutter#113169: Setting exact Flutter version in pubspec.yaml does not work](https://github.com/flutter/flutter/issues/113169)
