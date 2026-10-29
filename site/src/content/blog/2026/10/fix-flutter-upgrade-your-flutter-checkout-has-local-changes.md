---
title: "Fix: flutter upgrade says \"Your flutter checkout has local changes that would be erased by upgrading\""
description: "flutter upgrade aborts if git status in the SDK folder prints anything. Inspect it, restore pubspec.lock or git stash -u, and use --force only as a last resort."
pubDate: 2026-10-29
template: error-page
tags:
  - "errors"
  - "flutter"
  - "flutter-3-47"
  - "git"
---

`flutter upgrade` runs `git status -s` inside the Flutter SDK folder and refuses to continue if it prints a single line, including untracked files you never meant to keep. Find the SDK with `flutter --version --machine` (the `flutterRoot` field), run `git status --short` there, then either restore the file (usually `pubspec.lock`), park your edits with `git stash push -u`, or, if nothing in the SDK matters to you, run `flutter upgrade --force`. Everything below was checked on Flutter 3.44.8 and 3.47.7/3.47.8 (stable, Dart 3.12.2) on 2026-10-29.

## The error in context

You run `flutter upgrade` on a machine where you are sure you never touched Flutter itself, and you get this:

```text
$ flutter upgrade
Your flutter checkout has local changes that would be erased by upgrading. If you want to keep these changes, it is recommended that you stash them via "git stash" or else commit the changes to a local branch. If it is okay to remove local changes, then re-run this command with "--force".
```

The exit code is 1 and nothing has changed. The message is about the **SDK's** git checkout, not your app's repository. Your app's `git status` can be completely clean and you will still see it.

## Why this happens

The Flutter SDK is a git clone of `flutter/flutter`, and `flutter upgrade` is essentially `git fetch` plus `git reset --hard <new revision>` with some safety checks around it. The relevant code lives in `packages/flutter_tools/lib/src/commands/upgrade.dart`, and the order of operations matters:

1. `git fetch --tags`, then resolve the upstream revision of your branch (`stable`, `beta`, `main`).
2. If you are already on that revision, print "Flutter is already up to date" and exit 0. **No local-changes check happens.**
3. If `--verify-only` was passed, print the available version and exit.
4. If the current commit has no recognizable release tag and you did not pass `--force`, abort with "Unknown flutter tag".
5. If you did not pass `--force` and `hasUncommittedChanges()` returns true, abort with the error above.
6. `git reset --hard <upstream revision>`, then re-launch the new tool with `flutter upgrade --continue` to precache artifacts, run `pub upgrade` on your project and run `flutter doctor`.

`hasUncommittedChanges()` is a thin wrapper around `git status -s`. On the stable channel, any non-empty output is a change. Since Flutter 3.47.0 ([PR #184997](https://github.com/flutter/flutter/pull/184997)), the beta and main channels skip lines ending in `pubspec.lock`, because main writes dev SDK constraints into that file on its own. Stable gets no such exemption.

Two consequences follow directly from using `git status -s`:

- **Untracked files count.** A stray `notes.txt` in the SDK folder blocks the upgrade, even though `git reset --hard` would never delete it.
- **Gitignored files do not count.** The SDK's `.gitignore` already covers `.idea/`, `.vscode/*`, `.pub-cache/`, `.dart_tool/`, `bin/cache/`, `*.log` and every `*.lock` except the root `/pubspec.lock`. `.pub-cache/` was added after [issue #128635](https://github.com/flutter/flutter/issues/128635), where a snap install kept its pub cache inside the SDK.

So the real question is never "do I have local changes" but "what does `git status --short` print in the SDK folder, and who put it there".

## Minimal repro

I reproduced every case on a scratch clone of `flutter/flutter` reset to the `3.47.7` tag, one release behind `stable` (3.47.8). To avoid running freshly cloned code, I drove the upgrade logic from my installed Flutter 3.44.8 with the tool's hidden `--working-directory` flag, which points the command at another checkout and skips the re-entrant second half. The stable-channel check is byte-identical between 3.44.8 and 3.47.8.

```bash
# Flutter 3.44.8 tool, scratch checkout at 3.47.7, upstream stable = 3.47.8
C=~/scratch/flutter
git -C "$C" reset -q --hard 3.47.7

echo hi > "$C/notes.txt"                       # untracked file only
flutter upgrade --working-directory="$C"
# Your flutter checkout has local changes that would be erased by upgrading. ...
# exit=1
```

Here is what each scenario did:

| State of the SDK checkout | `git status -s` | `flutter upgrade` result |
| --- | --- | --- |
| Clean, one release behind | (empty) | Upgrades |
| Untracked `notes.txt` | `?? notes.txt` | Blocked |
| Files in `.idea/`, `.pub-cache/`, `debug.log` | (empty, shown only with `--ignored`) | Not blocked |
| Edited root `pubspec.lock` | ` M pubspec.lock` | Blocked |
| Edited framework source + untracked file, `--force` | ` M packages/flutter/...`, `?? notes.txt` | Upgrades; framework edit gone, `notes.txt` still there |
| Already on 3.47.8 with `?? notes.txt` | `?? notes.txt` | "Flutter is already up to date", exit 0 |

The last row explains a confusing pattern: the stray file sits there for months without complaint, and the error only appears on release day, when there is finally something to upgrade to.

## The most common cause: the SDK's own `pubspec.lock`

If `git status --short` shows ` M pubspec.lock` and nothing else, Flutter modified its own lockfile. The Flutter repo is a pub workspace, and its root `pubspec.lock` is the only tracked lockfile in the tree. Anything that runs `pub upgrade` with the SDK root as the project rewrites it, because packages published after the release (for example a newer `objective_c`) satisfy the same constraints.

Up to and including Flutter 3.44.x, `flutter upgrade` did exactly that to itself. The re-entrant `flutter upgrade --continue` was spawned with the SDK root as its working directory, so the "update your project's packages" step called `findProjectRoot()`, which walks up from the current directory looking for a `pubspec.yaml`, found the SDK's own, and ran `pub upgrade` on it. The upgrade succeeded, left a dirty lockfile behind, and the *next* upgrade failed. That is [issue #187977](https://github.com/flutter/flutter/issues/187977), and it matches the reports of "it only happens on installs that have already been upgraded once".

You can see the drift yourself. On a clean checkout of the `3.44.0` tag, running `pub upgrade` at the SDK root with Dart 3.12.2 (the Dart line 3.44 ships with) rewrote the lockfile (14 insertions, 6 deletions):

```bash
# Flutter 3.44.0 checkout, Dart 3.12.2, 2026-10-29
cd ~/scratch/flutter && dart pub upgrade
git diff --stat
#  pubspec.lock | 20 ++++++++++++++------
```

```diff
       name: jni
-    version: "1.0.0"
+    version: "1.1.1"
       name: jni_flutter
-    version: "1.0.1"
+    version: "1.0.4+1"
       name: objective_c
-    version: "9.2.3"
+    version: "9.3.0"
```

`objective_c` 9.2.3 to 9.3.0 is the exact diff from the issue report. [PR #188794](https://github.com/flutter/flutter/pull/188794) fixed it by spawning the second half in your original working directory, and it shipped in Flutter 3.47.0. So if you are on 3.44.x, expect this error once more on the way to 3.47, and then it should stop.

There is a catch in that fix. The second half now runs `pub upgrade` on whatever project `findProjectRoot()` finds from **your** current directory, and that function walks upwards. If you run `flutter upgrade` from inside the SDK tree, say `~/development/flutter/bin`, it finds the SDK's `pubspec.yaml` again and dirties the lockfile on 3.47 too. Run upgrades from your home directory or from an app folder, never from inside the SDK. (Running it from an app folder upgrades that app's dependencies, which is its own topic, covered in [why `pubspec.lock` changes after `flutter upgrade`](/2026/10/fix-pubspec-lock-modified-after-flutter-upgrade-or-switching-flutter-versions/).)

## Fix, in detail

### 1. Find the SDK and look before you force

Do not reach for `--force` first. Find out what is actually there.

```bash
# Flutter 3.44+ on macOS / Linux (needs jq)
SDK="$(flutter --version --machine | jq -r .flutterRoot)"
git -C "$SDK" status --short
git -C "$SDK" diff --stat
```

```powershell
# Flutter 3.44+ on Windows PowerShell
$sdk = (flutter --version --machine | ConvertFrom-Json).flutterRoot
git -C $sdk status --short
git -C $sdk diff --stat
```

`flutter doctor -v` prints the same path on the "Flutter version X on channel Y at <path>" line if you prefer not to parse JSON. For a Homebrew cask install, `flutterRoot` is the real checkout (`/opt/homebrew/share/flutter` on my machine), not the `bin/flutter` symlink.

### 2a. Only `pubspec.lock` is modified: restore it

This is the Flutter-wrote-it case from above. The file is regenerated anyway, so discard the change and upgrade normally:

```bash
# Flutter 3.44.x -> 3.47.x, stable channel
git -C "$SDK" checkout -- pubspec.lock
cd ~ && flutter upgrade
```

Running the upgrade from `~` keeps the second half from finding a `pubspec.yaml` inside the SDK.

### 2b. You changed framework files on purpose: stash them

Maybe you patched a widget while chasing a bug, or added a `debugPrint` inside `packages/flutter`. If you want those edits back after the upgrade, stash them, including untracked files:

```bash
# Flutter 3.47.7 -> 3.47.8, verified 2026-10-29
git -C "$SDK" stash push -u -m "before flutter upgrade"
flutter upgrade
git -C "$SDK" stash pop
```

In my repro this upgraded cleanly to 3.47.8 and `stash pop` restored both the modified `text.dart` and the untracked `notes.txt`. If the files you touched changed upstream between the two versions, `stash pop` can conflict, which is the honest outcome: your patch was written against a different framework version.

If you maintain long-lived patches to the framework, a stash is the wrong tool. Commit them to a local branch, or better, keep a fork and point a project-specific SDK at it with a version manager, so the SDK you upgrade is not the one you patch.

### 2c. Nothing in there matters: `--force`

When `git status --short` shows only noise you do not care about, force it:

```bash
# Flutter 3.47.x, stable channel
flutter upgrade --force    # or: flutter upgrade -f
```

Know what `--force` does, because it is not what most people assume:

- It skips the "Unknown flutter tag" check and the local-changes check. That is all.
- It then runs `git reset --hard <upstream revision>`. Tracked edits are discarded with no backup, and any commits you made on your local `stable` branch drop off the branch, recoverable only through `git reflog`.
- It does **not** delete untracked files. In my repro, `notes.txt` survived `--force` and was still listed by `git status` afterwards. It did not block the next run only because the next run hit "already up to date" first. On the next release it blocks again.

To clear untracked files for good, preview and then delete them:

```bash
# Run inside the SDK folder; -n is a dry run
git -C "$SDK" clean -n -d
git -C "$SDK" clean -f -d
```

`git clean` deletes files permanently and respects `.gitignore`, so it will not touch `bin/cache/` or `.pub-cache/`. Read the `-n` output before running the real thing.

### 3. Stop it from coming back

- Get to Flutter 3.47.0 or later, which contains the re-entrant working-directory fix.
- Never run `flutter upgrade` from inside the SDK tree.
- Do not keep scratch files, notes or experiment projects inside the SDK folder. Create apps next to it, not in it.
- On Windows, do not install the SDK by extracting the archive with File Explorer's "Extract all". Explorer cannot create some deep paths in the SDK (the iOS scenario app goldens exceed `MAX_PATH`), skips them, and those missing tracked files show up as deleted in `git status`, which blocks every future upgrade ([issue #193197](https://github.com/flutter/flutter/issues/193197), tracked in [#183172](https://github.com/flutter/flutter/issues/183172)). Install with `git clone` instead, after enabling long paths in Git (`core.longpaths`) and in Windows as the [Flutter upgrade docs](https://docs.flutter.dev/install/upgrade) describe. If you already have such an install, `git -C $sdk checkout -- .` after enabling long paths restores the missing files.

## Gotchas and lookalikes

**"Unknown flutter tag. Abandoning upgrade to avoid destroying local changes."** Different check, same family. It fires when `git describe` cannot find a release tag near your commit, typically after a shallow clone without tags or after checking out an arbitrary commit. On an official channel the message tells you to use git directly; elsewhere it suggests `--force`. Fetch tags (`git -C "$SDK" fetch --tags`) before forcing.

**"Your Flutter checkout is currently not on a release branch."** You are on a detached HEAD, usually because you followed the docs' `git checkout <version>` advice to pin a version. Run `flutter channel stable` to get back on a branch, then upgrade.

**"The current Flutter branch/channel is not tracking any remote repository."** Your local branch has no upstream. Reinstalling is the documented fix; `git -C "$SDK" branch -u origin/stable` works too if `origin` is the official remote.

**File-mode or line-ending noise.** If `git diff` in the SDK shows only `old mode 100755` / `new mode 100644` lines, something (a `chmod -R`, a copy across file systems, a synced folder) changed permissions. If every file shows as modified on Windows, the checkout was copied with different line endings. In both cases nothing you care about changed; `git -C "$SDK" checkout -- .` or `--force` is the right call. The SDK's `.gitattributes` uses `* text=auto`, so a fresh clone is the cleanest way out if the copy is badly mangled.

**The error appears in CI.** If a CI image caches the SDK between runs and an earlier job ran `flutter upgrade` on a 3.44.x SDK (or from inside the SDK tree), the cached checkout carries the dirty lockfile and every later upgrade step fails. Pin the version instead of upgrading in CI; see [targeting multiple Flutter versions from one CI pipeline](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).

**`flutter upgrade` worked, but your project now fails to resolve.** That is the second half running `pub upgrade` on your app with the new SDK pins, not this error. Start with [fixing "version solving failed" in pubspec.yaml](/2026/05/fix-version-solving-failed-in-pubspec-yaml/).

## Related

- [Fix: pubspec.lock shows as modified after flutter upgrade or switching Flutter versions](/2026/10/fix-pubspec-lock-modified-after-flutter-upgrade-or-switching-flutter-versions/) covers the same drift in your app's lockfile instead of the SDK's.
- [How to target multiple Flutter versions from one CI pipeline](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) for pinning SDKs instead of upgrading them in place.
- [Fix: "version solving failed" in pubspec.yaml](/2026/05/fix-version-solving-failed-in-pubspec-yaml/) for what can break right after an upgrade.
- [Fix: flutter doctor --android-licenses fails with cmdline-tools 23](/2026/09/fix-flutter-doctor-android-licenses-fails-with-cmdline-tools-23/), another tooling error where the fix depends on which Flutter release you are on.

## Sources

- [`upgrade.dart` on the stable branch](https://github.com/flutter/flutter/blob/stable/packages/flutter_tools/lib/src/commands/upgrade.dart), the check order and the `git status -s` call.
- [`findProjectRoot` in `os.dart`](https://github.com/flutter/flutter/blob/stable/packages/flutter_tools/lib/src/base/os.dart), the upward search for `pubspec.yaml`.
- [PR #188794: Run re-entrant upgrade in original CWD](https://github.com/flutter/flutter/pull/188794), shipped in 3.47.0.
- [PR #184997: Ignore pubspec.lock dirty checkout modifications on non-stable channels](https://github.com/flutter/flutter/pull/184997), shipped in 3.47.0.
- [Issue #187977](https://github.com/flutter/flutter/issues/187977) (`objective_c` drift on stable), [issue #178777](https://github.com/flutter/flutter/issues/178777) (drift on main), [issue #128635](https://github.com/flutter/flutter/issues/128635) (`.pub-cache` inside the SDK), [issue #193197](https://github.com/flutter/flutter/issues/193197) (Windows Explorer extraction).
- [Upgrading Flutter](https://docs.flutter.dev/install/upgrade) on docs.flutter.dev, including the Windows "Filename too long" section.
