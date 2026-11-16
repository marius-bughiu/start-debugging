---
title: "Fix: \"Error loading or parsing pubspec.yaml\" in flutter build ios with Swift Package Manager when the project path has a space"
description: "FlutterFire Package.swift files before April 2026 turn a space in your path into %20 and then cannot find pubspec.yaml. Upgrade to firebase_core 4.7.0+ and its matching plugins, or move the project."
pubDate: 2026-11-16
template: error-page
tags:
  - "errors"
  - "flutter"
  - "ios"
  - "swift-package-manager"
  - "firebase"
---

If `flutter build ios` stops at "Adding Swift Package Manager integration" with `Fatal error: Failed to load configuration: fileNotFound("Error loading or parsing pubspec.yaml ...")`, and the `NSFilePath` in the message contains `%20` (or `Work%2520Drive`), the problem is not your pubspec. An old FlutterFire plugin's `Package.swift` builds its own path with `URL(string: #file)`. That call percent-encodes the space in your project folder, so the file it then opens does not exist. Upgrade every FlutterFire package to the release from 2026-04-13 or later (`firebase_core` 4.7.0, `firebase_messaging` 16.2.0, `firebase_analytics` 12.3.0, `firebase_crashlytics` 5.2.0, `firebase_auth` 6.4.0, `cloud_firestore` 6.3.0). If you cannot upgrade yet, move the project to a path with no spaces. A symlink does not work.

Everything below was reproduced on an Apple Silicon Mac with Flutter 3.44.8 (stable), Dart 3.12.2, Xcode 27.2 (27B52), Swift 6.4.2, and a `flutter create` app in a folder named `Work Drive`. The only dependency added was `firebase_core`. The builds were `flutter build ios --simulator --debug`.

## The error in context

This is the failure from the [Stack Overflow question](https://stackoverflow.com/questions/79956093). The asker was on Flutter 3.44.1 with `firebase_messaging` 16.1.3:

```
Adding Swift Package Manager integration...                        16.6s
An error occurred when adding Swift Package Manager integration:
  Error: Unable to get Xcode project information:
xcodebuild: error: Could not resolve package dependencies:
  main/Package.swift:78: Fatal error: Failed to load configuration: fileNotFound("Error loading or parsing pubspec.yaml:
  Error Domain=NSCocoaErrorDomain Code=260 "The file "pubspec.yaml" couldn't be opened because there is no such file."
  UserInfo={NSFilePath=/Users/me/Desktop/Work%20Drive/my_project/ios/Flutter/ephemeral/Packages/.packages/firebase_messaging-16.1.3/../../pubspec.yaml,
  NSURL=file:///Users/me/Desktop/Work%2520Drive/my_project/...")
```

The repro for this post produced the same failure with `firebase_core` 4.6.0, about five seconds into the build:

```
Xcode failed to resolve Swift Package Manager dependencies:
xcodebuild: error: Could not resolve package dependencies:
  main/Package.swift:77: Fatal error: Failed to load configuration: fileNotFound("Error loading or parsing pubspec.yaml: Error Domain=NSCocoaErrorDomain Code=260 \"The file “pubspec.yaml” couldn’t be opened because there is no such file.\" UserInfo={NSFilePath=/tmp/.../Work%20Drive/spm_space_repro/ios/Flutter/ephemeral/Packages/.packages/firebase_core-4.6.0/../../pubspec.yaml, NSURL=file:///tmp/.../Work%2520Drive/spm_space_repro/...
```

Three details tell you which bug this is:

- `main/Package.swift:77` (or `:78`) is a line in a **plugin's** manifest, not in your app. The `.packages/<plugin>-<version>` part of the path names the plugin.
- `Fatal error: Failed to load configuration` is the plugin's own `fatalError(...)` call. SwiftPM runs the manifest as a Swift program, and the program crashed.
- `Work%20Drive` in `NSFilePath` is the smoking gun. `Work%2520Drive` in `NSURL` is the same string encoded a second time, because Foundation turned the literal `%` into `%25` when it built a file URL for the error.

The only answer on the question explains that some plugins "do not support Swift Package Manager". That warning is real, but it is unrelated. Those plugins fall back to CocoaPods. The crash comes from a plugin that does support SwiftPM.

## Why a space breaks the FlutterFire manifest

Every FlutterFire `Package.swift` up to and including the 2026-03-23 release read the plugin version from `pubspec.yaml` at manifest evaluation time. This is `firebase_core` 4.6.0, trimmed:

```swift
// firebase_core 4.6.0, ios/firebase_core/Package.swift (excerpt)
let firebaseCoreDirectory = String(URL(string: #file)!.deletingLastPathComponent().absoluteString
  .dropLast())

func loadPubspecVersion() throws -> String {
  let pubspecPath = NSString.path(withComponents: [
    firebaseCoreDirectory, "..", "..", "pubspec.yaml",
  ])
  do {
    let yamlString = try String(contentsOfFile: pubspecPath, encoding: .utf8)
    // ... find the "version:" line ...
  } catch {
    throw ConfigurationError.fileNotFound("Error loading or parsing pubspec.yaml: \(error)")
  }
}

do {
  library_version_string = try loadPubspecVersion()
  firebase_sdk_version_string = try loadFirebaseSDKVersion()
} catch {
  fatalError("Failed to load configuration: \(error)")
}
```

`#file` is a plain file system path. `URL(string:)` expects a URL string, not a path. On current Foundation it does not return `nil` for a space. It percent-encodes the space instead, and `absoluteString` hands back the encoded form. `String(contentsOfFile:)` takes a path, not a URL, so it looks for a folder literally named `Work%20Drive`. That folder does not exist.

You can see this outside Flutter with a few lines of Swift:

```swift
// Swift 6.4.2, macOS, Xcode 27.2: run with `swift main.swift`
import Foundation

let file = "/Users/me/Work Drive/app/ios/Flutter/ephemeral/Packages/.packages/firebase_core-4.6.0/Package.swift"

let broken = String(URL(string: file)!.deletingLastPathComponent().absoluteString.dropLast())
print("URL(string:)          ->", broken)

let fixed = URL(fileURLWithPath: file).deletingLastPathComponent().path
print("URL(fileURLWithPath:) ->", fixed)
```

Output:

```
URL(string:)          -> /Users/me/Work%20Drive/app/ios/Flutter/ephemeral/Packages/.packages/firebase_core-4.6.0
URL(fileURLWithPath:) -> /Users/me/Work Drive/app/ios/Flutter/ephemeral/Packages/.packages/firebase_core-4.6.0
```

Spaces are not the only problem. The same script with other folder names gave:

| Folder in the path | What `URL(string:)` produced | Result |
| --- | --- | --- |
| `Projets clients` | `Projets%20clients` | file not found |
| `Développement` | `D%C3%A9veloppement` | file not found |
| `C#` | everything after `#` parsed as a URL fragment | wrong path |
| `dev` | `dev` | works |

So a path with any non-ASCII character or a `#` fails in the same way. People who keep projects in synced folders such as "Google Drive", "OneDrive - Company", or "iCloud Drive" hit it most often, because those names come with spaces.

### Why it "worked before"

Two things often change together. Flutter 3.44 [turned Swift Package Manager on by default](https://docs.flutter.dev/packages-and-plugins/swift-package-manager/for-app-developers). Before that, the same FlutterFire plugins went through CocoaPods, and their `Package.swift` never ran. So a project that built fine on Flutter 3.41 in a spaced folder starts failing right after `flutter upgrade`, even though nothing in `ios/` changed. `flutter clean`, deleting `Pods`, and `pod install` cannot help. The failing code is in the pub cache, and a SwiftPM build does not run CocoaPods for these plugins.

### How FlutterFire fixed it (by accident)

[firebase/flutterfire#18136](https://github.com/firebase/flutterfire/pull/18136), merged on 2026-03-24, replaced the dynamic version loading in all 28 plugin manifests (iOS and macOS) with hard-coded strings. Its goal was a different bug. SwiftPM caches manifest evaluation, so reading versions from other files led to stale, conflicting `flutterfire` versions after upgrades. Removing the file read also removed the path bug. The first release with the change shipped on pub.dev on 2026-04-13. The `firebase_core` 4.7.0 manifest is now just:

```swift
// firebase_core 4.7.0, ios/firebase_core/Package.swift (excerpt)
let library_version_string = "4.7.0"
let firebase_sdk_version: Version = "12.12.0"
```

## Minimal repro

```bash
# Flutter 3.44.8, Xcode 27.2, macOS on Apple Silicon
mkdir -p "$HOME/tmp/Work Drive" && cd "$HOME/tmp/Work Drive"
flutter create --platforms=ios spm_space_repro
cd spm_space_repro
flutter pub add firebase_core:4.6.0
flutter build ios --simulator --debug
```

The build fails with the `Package.swift:77` fatal error shown above. You do not need to configure Firebase or add a `GoogleService-Info.plist`. The failure happens while SwiftPM evaluates the manifest, before it fetches `firebase-ios-sdk` and before any compiling.

## The fix: upgrade the FlutterFire packages together

Check which plugins in your project still have the bad pattern. Flutter links each SwiftPM plugin into `ios/Flutter/ephemeral/Packages/.packages/`, so after one failed build you can grep there:

```bash
# Run from the Flutter project root after a failed build
grep -lE 'URL\(string: *#(file|filePath)' ios/Flutter/ephemeral/Packages/.packages/*/Package.swift
```

In the repro this printed `ios/Flutter/ephemeral/Packages/.packages/firebase_core-4.6.0/Package.swift`. After the upgrade it printed nothing. For macOS apps, check `macos/Flutter/ephemeral/Packages/.packages/` the same way.

Then upgrade all FlutterFire packages in one step. They pin each other's versions, so upgrading only `firebase_core` usually fails to resolve, or leaves `firebase_messaging` on the old manifest. These are the last versions with the path-reading code (all published on 2026-03-23) and the first versions without it (all published on 2026-04-13), checked against the `Package.swift` in each pub.dev archive:

| Package | Last affected | First fixed |
| --- | --- | --- |
| `firebase_core` | 4.6.0 | 4.7.0 |
| `firebase_messaging` | 16.1.3 | 16.2.0 |
| `firebase_analytics` | 12.2.0 | 12.3.0 |
| `firebase_crashlytics` | 5.1.0 | 5.2.0 |
| `firebase_auth` | 6.3.0 | 6.4.0 |
| `cloud_firestore` | 6.2.0 | 6.3.0 |

```yaml
# pubspec.yaml, Flutter 3.44+: any FlutterFire set from 2026-04-13 or later
dependencies:
  firebase_core: ^4.7.0
  firebase_messaging: ^16.2.0
  firebase_analytics: ^12.3.0
```

```bash
flutter pub upgrade firebase_core firebase_messaging firebase_analytics
flutter build ios --simulator --debug
```

If your constraints already allow the newer versions (for example `^16.1.3` allows 16.2.0), `pubspec.lock` is the only thing holding you back, and `flutter pub upgrade <packages>` is enough. If the resolver refuses, run `flutter pub outdated` to see which other package caps a FlutterFire version.

The fix was checked in the repro folder, which still had the space. With `firebase_core` 4.7.0, SwiftPM resolved `firebase-ios-sdk` and the build went past the manifest stage. The build then failed for an unrelated reason: the `flutter create` template sets `IPHONEOS_DEPLOYMENT_TARGET = 13.0`, and Xcode 27.2 supports iOS 15.0 to 27.2 only. After raising the Runner target to 15.0, the build finished with `✓ Built build/ios/iphonesimulator/Runner.app` in 34 seconds. Current FlutterFire versions need iOS 15 anyway, as `.iOS("15.0")` in their manifests shows.

## Workarounds when you cannot upgrade yet

**Move the project to a path without spaces.** In the repro, the same project with `firebase_core` 4.6.0, copied to `WorkDrive` (no space), built cleanly in 63 seconds with `build` and `ios/Flutter/ephemeral` deleted first. This is the quickest fix for a release branch that is frozen on old dependencies. On CI, check the checkout directory as well, since that is the path the build sees.

**Do not use a symlink.** A no-space symlink pointing at the spaced folder did not help. The build was run from the symlink, but the error still showed `Work%20Drive` in `NSFilePath`. The path that reaches `#file` is the resolved real path, so the space comes back.

**Turning SwiftPM off is a short-term option only.** The Flutter docs describe a per-project opt-out:

```yaml
# pubspec.yaml, Flutter 3.44+
flutter:
  config:
    enable-swift-package-manager: false
```

The global form is `flutter config --no-enable-swift-package-manager`. This post did not test that route with Firebase. The docs also warn against it: the CocoaPods registry becomes read-only on December 2, 2026, and a later Flutter version will remove the opt-out. Use it to unblock a build today, not as the fix.

**Patching the pub cache** (replacing `URL(string: #file)` with `URL(fileURLWithPath: #file)` in the cached manifest) also works in principle. The table above shows that `URL(fileURLWithPath:)` keeps the space. But `flutter pub cache repair` or a new machine undoes the patch, and SwiftPM may reuse a cached evaluation of the old manifest. Upgrading is cheaper.

## Lookalike errors that are not this bug

- **`Could not resolve package dependencies: Couldn't get revision '...^{commit}'`** with no `pubspec.yaml` in the message. This one appeared when running from VS Code because an extension host set `GIT_CONFIG_*` variables. See [flutter/flutter#187676](https://github.com/flutter/flutter/issues/187676). The Dart extension 3.136.1 added a workaround. Older versions can set `"dart.env": { "GIT_CONFIG_COUNT": "0" }`.
- **`'firebase_core' depends on 'flutterfire' 4.3.0-firebase-core-swift and 'firebase_analytics' depends on 'flutterfire' 4.4.0-firebase-core-swift`**. This is the stale manifest cache that PR #18136 set out to fix ([flutterfire#17980](https://github.com/firebase/flutterfire/issues/17980), [#18114](https://github.com/firebase/flutterfire/issues/18114)). The same upgrade fixes it.
- **`The following plugins do not support Swift Package Manager`**. This is a warning, not the failure. Those plugins keep using CocoaPods next to SwiftPM, as [the CocoaPods to SwiftPM migration guide](/2026/10/migrate-a-flutter-ios-app-from-cocoapods-to-swift-package-manager/) explains.
- **`CocoaPods could not find compatible versions for pod`**. This one comes from `pod install`, not SwiftPM, and has its own [fix for CocoaPods version conflicts](/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/).

## Related

- [Flutter 3.44 splits Material and Cupertino out of the SDK and defaults to SwiftPM](/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/) covers the release that made this manifest code run for everyone.
- [Migrate a Flutter iOS app from CocoaPods to Swift Package Manager](/2026/10/migrate-a-flutter-ios-app-from-cocoapods-to-swift-package-manager/) shows how to finish the move cleanly once your plugins resolve.
- [Fix: does not support provisioning profiles when archiving a Flutter iOS app with Swift Package Manager](/2026/10/fix-does-not-support-provisioning-profiles-flutter-ios-archive-swift-package-manager/) is the next SwiftPM error people hit at archive time.
- [Fix: Failed to build iOS app with Xcode 16 and Flutter 3.x](/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/) is the general checklist for reading what Xcode actually failed on.

## Sources

- [Stack Overflow 79956093: flutter build ios fails at Swift Package Manager integration with pubspec.yaml not found](https://stackoverflow.com/questions/79956093)
- [firebase/flutterfire#18136: hard-code versions in Package.swift instead of reading pubspec.yaml](https://github.com/firebase/flutterfire/pull/18136)
- [firebase_core versions on pub.dev](https://pub.dev/packages/firebase_core/versions)
- [Flutter docs: Swift Package Manager for app developers](https://docs.flutter.dev/packages-and-plugins/swift-package-manager/for-app-developers)
- [Apple documentation: URL(fileURLWithPath:)](https://developer.apple.com/documentation/foundation/url/init(fileurlwithpath:))
- [flutter/flutter#187676: Swift Package Manager "Could not resolve package dependencies" when running inside VS Code](https://github.com/flutter/flutter/issues/187676)
