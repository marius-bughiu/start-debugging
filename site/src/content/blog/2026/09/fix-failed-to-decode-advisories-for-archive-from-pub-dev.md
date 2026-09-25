---
title: "Fix: Failed to decode advisories for archive from https://pub.dev in flutter pub get"
description: "The advisories warning in pub get is harmless: pub get exits 0. pub.dev fixed the bad response on 2026-05-04. If you still see it, the cause is a mirror or proxy."
pubDate: 2026-09-25
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "pub"
  - "ci"
---

Your packages are fine. The message comes from pub's security-advisory check, which runs after resolution, and `flutter pub get` still exits with code 0. The mass outbreak (every project that depends on `archive`, `http`, `dio`, `shared_preferences_android`, and so on) was a pub.dev server bug. Between 2026-05-02 and 2026-05-04 the advisories API returned `"advisoriesUpdated": null`, and pub.dev fixed it on 2026-05-04. If you still see it today, the response is coming from a package mirror (`PUB_HOSTED_URL`, Artifactory, Nexus, a private pub server) or a proxy. Fix that server, or upgrade to Flutter 3.47.0 / Dart 3.13.0 or later, where the stack trace is reduced to a one-line warning. If CI fails on it, the real problem is a step that treats stderr as failure.

I reproduced every variant below on macOS with Dart 3.12.2 (the SDK in Flutter 3.44.x) and Dart 3.13.4 (the SDK in Flutter 3.47.5). Both ran against a 40-line local pub repository that implements the [hosted repository spec v2](https://github.com/dart-lang/pub/blob/master/doc/repository-spec-v2.md) and lets me choose what the advisories endpoint returns.

## The error in context

On Flutter 3.44.x and older (Dart 3.12.x and older), `flutter pub get` or `dart pub get` prints this for one package after another:

```text
Resolving dependencies...
Downloading packages...
Failed to decode advisories for archive from https://pub.dev.
FormatException: advisoriesUpdated must be a String
package:pub/src/source/hosted.dart 670                        HostedSource._extractAdvisoryDetailsForPackage
package:pub/src/source/hosted.dart 622                        HostedSource._fetchAdvisories
===== asynchronous gap ===========================
package:pub/src/source/hosted.dart 839                        HostedSource._getAdvisories
===== asynchronous gap ===========================
package:pub/src/source/hosted.dart 1120                       HostedSource.getAdvisoriesForPackageVersion
===== asynchronous gap ===========================
package:pub/src/solver/report.dart 425                        SolveReport._reportPackage
===== asynchronous gap ===========================
package:pub/src/solver/report.dart 221                        SolveReport._reportChanges
===== asynchronous gap ===========================
package:pub/src/solver/report.dart 76                         SolveReport.show
===== asynchronous gap ===========================
package:pub/src/entrypoint.dart 642                           Entrypoint.acquireDependencies
...
Failed to decode advisories for http from https://pub.dev.
FormatException: advisoriesUpdated must be a String
...
```

On Flutter 3.47.0 and later (Dart 3.13.0 and later) the same condition produces one line per package:

```text
Failed to decode advisories for archive from https://pub.dev: advisoriesUpdated must be a String
```

`archive` tends to be the first name you see. The report walks packages alphabetically, and `archive` is a transitive dependency of `image` and of a lot of build tooling, so it shows up early in most Flutter lock files. Only packages that have ever had a security advisory trigger the fetch, which is why `http` and `dio` were in every report and `path` never was.

## Why pub fetches advisories at all

Since Dart 3.4 ([dart-lang/pub#4062](https://github.com/dart-lang/pub/pull/4062)), `pub get`, `pub upgrade`, and `pub add` report known security advisories for the versions you resolved. The data comes from [osv.dev](https://osv.dev), and pub.dev re-exports it through two fields in its API:

1. The version listing, `GET /api/packages/<name>`, has an optional `advisoriesUpdated` timestamp. If it is present, the client assumes the server supports the advisories endpoint for that package.
2. The advisories endpoint, `GET /api/packages/<name>/advisories`, returns `{"advisories": [...], "advisoriesUpdated": "<date-time>"}`.

The client caches the second response under `$PUB_CACHE/hosted/<host>/.cache/<name>-advisories.json`, and uses the timestamp to decide whether that cache is stale. In `_extractAdvisoryDetailsForPackage` in [`hosted.dart`](https://github.com/dart-lang/pub/blob/master/lib/src/source/hosted.dart), the parser is strict about the timestamp:

```dart
// dart-lang/pub, lib/src/source/hosted.dart (Dart 3.12 and 3.13)
final advisoriesUpdated = body['advisoriesUpdated'];
if (advisoriesUpdated is! String) {
  throw const FormatException('advisoriesUpdated must be a String');
}
```

That `FormatException` is caught in `_fetchAdvisories`, logged as a warning, and the method returns `null`, meaning "no advisory data for this package". Resolution has already finished by then, and nothing in `pubspec.lock` depends on it. The only thing lost is the advisory report for that package.

## What broke on pub.dev in May 2026

The pub.dev team's [post mortem](https://github.com/dart-lang/pub-dev/issues/9372) explains the sequence. On 2026-04-23 a slimmer `FROM scratch` Docker image removed `unzip`, so the job that downloads the osv.dev export stopped working. On 2026-05-01 it was replaced by a Dart unzip implementation with a missing `init()` call. That implementation extracted zero files, so the next sync on 2026-05-02 "found" no advisories and deleted them all from the datastore.

The advisories endpoint derived `advisoriesUpdated` from the newest stored advisory, and none were left, so it returned `null`. The version listing still carried the old timestamp from the package entity. Every client therefore saw "this package has advisories", fetched them, and choked on:

```json
{"advisories": [], "advisoriesUpdated": null}
```

[dart-lang/pub-dev#9368](https://github.com/dart-lang/pub-dev/pull/9368) ("Fix advisoriesUpdated") shipped on 2026-05-04. The advisories were reloaded, and the issue was closed on 2026-05-05. Today a package without advisories returns the Unix epoch instead of `null`:

```bash
# pub.dev, checked 2026-09-25
curl -s https://pub.dev/api/packages/path/advisories
# {"advisories":[],"advisoriesUpdated":"1970-01-01T00:00:00.000"}
```

On the client side, [dart-lang/pub#4817](https://github.com/dart-lang/pub/pull/4817) ("Quiet warning instead of stack trace when failing to parse advisories") replaced the stack trace with a one-line message. I checked the `pub_rev` pinned in the Dart SDK's `DEPS` file for each release tag. The change is not in 3.12.0 through 3.12.2, and it is in every 3.13.x release. In Flutter terms, 3.44.0 through 3.44.9 still print the full trace, and 3.47.0 is the first stable that does not.

## Minimal repro with a local pub server

You do not need pub.dev to be broken to see this. A tiny Node server that follows the repository spec, with a switch for the advisories response, reproduces every variant. This is the relevant part:

```js
// Node 24, server.mjs: minimal pub repository (spec v2)
if (req.url === '/api/packages/fakepkg') {
  res.writeHead(200, { 'content-type': 'application/vnd.pub.v2+json' });
  return res.end(JSON.stringify({
    name: 'fakepkg',
    advisoriesUpdated: '2026-04-20T10:00:00.000Z', // tells pub to fetch advisories
    latest: { version: '1.0.0', archive_url: `${base}/pkg/fakepkg-1.0.0.tar.gz`, pubspec },
    versions: [{ version: '1.0.0', archive_url: `${base}/pkg/fakepkg-1.0.0.tar.gz`, pubspec }],
  }));
}
if (req.url === '/api/packages/fakepkg/advisories') {
  res.writeHead(200, { 'content-type': 'application/json' });
  return res.end(JSON.stringify({ advisories: [], advisoriesUpdated: null }));
}
```

The app points one dependency at it:

```yaml
# pubspec.yaml, Dart 3.12.2 / 3.13.4
name: app
publish_to: none
environment:
  sdk: ^3.0.0
dependencies:
  fakepkg:
    hosted: http://localhost:8123
    version: ^1.0.0
```

Running it on both SDKs, with a fresh `PUB_CACHE` each time:

```bash
# Dart 3.12.2
dart pub get > out.txt 2> err.txt; echo "exit=$?"
# exit=0
# out.txt: Resolving dependencies... Downloading packages... + fakepkg 1.0.0  Changed 1 dependency!
# err.txt: Failed to decode advisories for fakepkg from http://localhost:8123.
#          FormatException: advisoriesUpdated must be a String
#          package:pub/src/source/hosted.dart 648  HostedSource._extractAdvisoryDetailsForPackage
#          ... (full async stack trace)

# Dart 3.13.4
dart pub get > out.txt 2> err.txt; echo "exit=$?"
# exit=0
# err.txt: Failed to decode advisories for fakepkg from http://localhost:8123: advisoriesUpdated must be a String
```

Three things the repro makes concrete:

- **Exit code is 0 on both versions.** The package is downloaded and `pubspec.lock` is written.
- **Everything goes to stderr.** stdout is clean.
- **The bad response is never cached.** Afterwards, `$PUB_CACHE/hosted/localhost%588123/.cache/` contains `fakepkg-versions.json` but no `fakepkg-advisories.json`. The cache write happens after a successful parse, so pub asks again on every run, including a `pub get` where nothing changed. Deleting the pub cache does not help, because the cache was never the problem. That matches the reports on the pub-dev issue from people who ran `flutter pub cache clean` and still got the error.

## Fixing it, in order of likelihood

### 1. Confirm where the response comes from

Run a verbose get and look for the advisories request:

```bash
# Flutter 3.47.5 / Dart 3.13.4
dart pub get --verbose 2>&1 | grep -A3 "Fetching security advisories"
# IO  : Fetching security advisories from https://pub.dev/api/packages/archive/advisories.
# IO  : HTTP GET https://pub.dev/api/packages/archive/advisories
```

Then fetch that exact URL yourself:

```bash
curl -s https://pub.dev/api/packages/archive/advisories | head -c 300
```

If the host is `pub.dev` and the body has a string `advisoriesUpdated`, the server side is healthy. Any remaining message comes from something between you and pub.dev, usually a TLS-inspecting proxy that rewrites responses. If the host is not pub.dev, check `echo $PUB_HOSTED_URL` and any `hosted:` URLs in `pubspec.yaml`. That server is your culprit.

### 2. Stop CI from treating the warning as a failure

pub exits 0, so if a pipeline went red on this message, some step is failing on stderr output. The usual suspects are Azure Pipelines script tasks with `failOnStderr: true`, and Windows PowerShell 5.1 scripts that run `flutter pub get 2>&1` under `$ErrorActionPreference = 'Stop'`. PowerShell 5.1 turns each redirected stderr line into an `ErrorRecord`, and with `Stop` the first one ends the script. Gate on the exit code instead:

```yaml
# Azure Pipelines, Flutter 3.47.5
- script: flutter pub get
  displayName: Restore packages
  failOnStderr: false   # pub prints advisory warnings to stderr and still exits 0
```

```powershell
# Windows PowerShell 5.1, Flutter 3.47.5
$ErrorActionPreference = 'Continue'
flutter pub get
if ($LASTEXITCODE -ne 0) { throw "flutter pub get failed ($LASTEXITCODE)" }
```

Wrappers that grep the log for `Exception` or `Error` hit the same problem. A real resolution failure such as [`version solving failed`](/2026/05/fix-version-solving-failed-in-pubspec-yaml/) sets a non-zero exit code, so the exit code is enough.

### 3. Upgrade to Flutter 3.47.0 or later

This does not stop the warning, but the one-line form is much less alarming in logs and does not bury the output you care about. If your CI pins Flutter per branch, the approach in [targeting multiple Flutter versions from one CI pipeline](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) lets you move the default job to 3.47.x without touching the others.

### 4. Fix the mirror or private pub server

The spec gives a mirror two valid options, and it must pick one:

- Proxy `/api/packages/<name>/advisories` faithfully, with `advisoriesUpdated` always a string.
- Or strip `advisoriesUpdated` from the version listing it serves. The spec makes the field optional, and when it is absent, the client does not call the advisories endpoint at all. You lose the advisory report, but pub stops asking.

Remote repositories in Artifactory and similar products cache upstream metadata. One Artifactory user on the pub-dev issue hit a different failure: the proxy's own parser threw a `NullPointerException` on the `null` field. If your proxy cached a response from the May 2026 window, clearing that remote repository's metadata cache (Artifactory calls this "zap cache") makes it fetch the corrected response. Whoever runs the proxy has to do this. Nothing on the client side will change it.

### 5. Skip the check where it truly does not matter

`dart pub get --offline` / `flutter pub get --offline` never fetches advisories. The code returns early in offline mode. This only works when every package is already in the local pub cache, so it fits hermetic build agents with a pre-warmed cache, not a general fix. Do not use it to hide a broken mirror on developer machines, because you also lose the security report the check exists for.

## Variants that look similar

**`Failed to decode advisories for X from ...: Unexpected character (at character 1)`** followed by a line of HTML. The advisories request got an HTML page, typically a captive portal, a proxy login, or an error page that returns HTTP 200. I reproduced it by returning `<html>proxy login</html>`. The exit code is still 0 and the fix is the network path, not pub.

**`Warning: Unable to fetch advisories for "X" from "https://my-mirror/"`**. The advisories endpoint returned a non-2xx status from a host that is not pub.dev. That is a warning, exit code 0. This behaviour dates back to [dart-lang/pub#4275](https://github.com/dart-lang/pub/pull/4275) in 2024. Before that, a mirror without the endpoint crashed `pub get`.

**`Failed to fetch advisories for "X" from "https://pub.dev"`**. Same situation, but the host is pub.dev. pub treats that one as fatal (`fail(...)`) and exits non-zero, since pub.dev is supposed to always serve the endpoint. If you see this one, it really is a pub.dev outage or something blocking that path. Check [the pub.dev issue tracker](https://github.com/dart-lang/pub-dev/issues) before you change anything locally.

**`FormatException: advisories must be a list`** or **`advisory must be a map`**. Same code path, different malformed field. A home-grown pub server is returning the wrong shape. Compare its response against the OSV format section of the spec.

## Related

- [Fix: version solving failed in pubspec.yaml](/2026/05/fix-version-solving-failed-in-pubspec-yaml/) covers the pub error that really does stop a build, and how to read its output.
- [How to target multiple Flutter versions from one CI pipeline](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/), useful when moving CI to a 3.47.x SDK.
- [Pinning the Flutter engine version for reproducible builds](/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/), since knowing exactly which SDK your agents run is how you tell 3.44 output from 3.47 output.
- [Fix: Unexpected failure parsing device information from adb output](/2026/09/fix-unexpected-failure-parsing-device-information-from-adb-output-in-flutter/) is another loud Flutter tooling message where the right move is a specific SDK version.
- [What else shipped in the Flutter 3.47.1 hotfix](/2026/08/flutter-3-47-1-blocks-plugin-registrant-code-injection/).

## Sources

- [dart-lang/pub-dev#9372](https://github.com/dart-lang/pub-dev/issues/9372), the original report and the post mortem, plus the duplicates [dart-lang/sdk#63308](https://github.com/dart-lang/sdk/issues/63308) and [flutter/flutter#185943](https://github.com/flutter/flutter/issues/185943).
- [dart-lang/pub-dev#9368](https://github.com/dart-lang/pub-dev/pull/9368), the server fix.
- [dart-lang/pub#4817](https://github.com/dart-lang/pub/pull/4817), the quieter client warning, and [dart-lang/pub#4275](https://github.com/dart-lang/pub/pull/4275), graceful handling of a missing advisories endpoint.
- [`lib/src/source/hosted.dart`](https://github.com/dart-lang/pub/blob/master/lib/src/source/hosted.dart) in dart-lang/pub (`_fetchAdvisories`, `_extractAdvisoryDetailsForPackage`, `_getAdvisories`).
- [Hosted Pub Repository Specification v2](https://github.com/dart-lang/pub/blob/master/doc/repository-spec-v2.md), sections on `advisoriesUpdated` and "List security advisories for a package".
- [Dart SDK `DEPS`](https://github.com/dart-lang/sdk/blob/3.13.0/DEPS) (`pub_rev`) at the 3.12.x and 3.13.x tags, and the [Flutter releases manifest](https://storage.googleapis.com/flutter_infra_release/releases/releases_macos.json) for the Flutter to Dart mapping.
- [Troubleshooting pub](https://dart.dev/tools/pub/troubleshoot) on dart.dev.
