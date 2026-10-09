---
title: "Migrate a Flutter iOS App from CocoaPods to Swift Package Manager (Flutter 3.44 to 3.47)"
description: "Flutter 3.44 made Swift Package Manager the default for iOS and macOS, but an existing app keeps CocoaPods until you remove it. How to check which plugins are SwiftPM-ready, let the tool migrate the Xcode project, delete the Podfile safely, handle pods-only plugins and custom Podfile logic, and roll back if you need to."
pubDate: 2026-10-09
updatedDate: 2026-10-09
template: migration
tags:
  - "migration"
  - "flutter"
  - "ios"
  - "swiftpm"
  - "cocoapods"
  - "xcode"
---

If your Flutter app was created before Flutter 3.44, it still has a `Podfile`, a `Pods/` directory and `#include` lines for CocoaPods in its xcconfig files, even though Swift Package Manager (SwiftPM) has been the default since 3.44. Upgrading Flutter does only half of the migration. The first `flutter build ios` or `flutter run` adds the SwiftPM package to your Xcode project, but it does not remove CocoaPods. You do that yourself, and only once every plugin you use ships a `Package.swift`. For a typical app with 5 to 15 plugins, this takes about 30 minutes. The parts that break are a hand-edited `Podfile` (custom `post_install` logic, preprocessor macros, extra pods) and plugins that are still pods-only. Do it now: the CocoaPods trunk goes read-only on 2 December 2026. Everything below was tested on Flutter 3.44.8 with Xcode 27.0 and CocoaPods 1.17.0, and checked against the current stable, Flutter 3.47.6.

## Why remove CocoaPods instead of leaving it around

- **No more Ruby on the build machine.** Once no pod is left, `flutter build ios` stops running `pod install`, so CI no longer needs Ruby, the `cocoapods` gem, or the `LANG=en_US.UTF-8` workaround.
- **Faster builds.** `flutter_tools` prints this directly: "Removing CocoaPods integration will improve the project's build time." The `[CP] Embed Pods Frameworks` and `[CP] Copy Pods Resources` script phases disappear from every build.
- **The CocoaPods trunk freezes.** It becomes permanently read-only on 2 December 2026. Pods that already exist keep resolving, but no plugin can publish a fixed podspec after that. Any plugin still on CocoaPods is a plugin whose iOS side is frozen.
- **Pods-only plugins are on notice.** Flutter 3.44+ prints that a pods-only plugin "will become an error in a future version of Flutter", and pub.dev now lowers the score of packages without SwiftPM support.

## What changes in the project

| Area | Change | Severity |
| --- | --- | --- |
| `ios/Runner.xcodeproj/project.pbxproj` | `FlutterGeneratedPluginSwiftPackage` added as a local package dependency of `Runner` (automatic) | low |
| `Runner.xcscheme` | Build pre-action "Run Prepare Flutter Framework Script" added (automatic, per scheme) | low |
| `ios/Podfile`, `Podfile.lock`, `Pods/`, `.symlinks/` | Deleted by you | medium |
| `ios/Flutter/Debug.xcconfig`, `Release.xcconfig` | `#include? "Pods/..."` lines removed by you | medium |
| Custom `Podfile` logic | `post_install` hooks, `GCC_PREPROCESSOR_DEFINITIONS`, non-Flutter pods must move elsewhere | high |
| Pods-only plugins | Force CocoaPods to stay; the `Podfile` is regenerated if you delete it | high |
| Minimum iOS version | SwiftPM plugins can declare a higher minimum than your `Runner` target | medium |

## Pre-flight checklist

1. Flutter 3.44 or newer (`flutter --version`). SwiftPM was opt-in since 3.24, but 3.44 is where the automatic migration and the warnings below are on by default.
2. Xcode 15 or newer. `flutter_tools` refuses SwiftPM on older Xcode.
3. A clean working tree, so the diff of `project.pbxproj` and the scheme is reviewable and revertible.
4. SwiftPM not disabled. Check that `flutter config --list` does not show `enable-swift-package-manager: false` and that `pubspec.yaml` has no `config: enable-swift-package-manager: false` under `flutter:`. Earlier releases, when SwiftPM was still opt-in, documented a different key, `disable-swift-package-manager: true`, directly under `flutter:`. Remove it if a teammate added it back then.
5. If you build flavors, write down every scheme name. The pre-action is added per scheme.

## Migration steps

1. **Upgrade the plugins first.** Many plugins added `Package.swift` in a minor release, and an old lockfile keeps you on the pods-only version. Run `flutter pub upgrade` and, for anything pinned in `pubspec.yaml`, `flutter pub outdated`. Verify with `git diff pubspec.lock` that the iOS plugin implementations (`*_ios`, `*_darwin`, `*_foundation`, `*_apple`) moved.

2. **List which plugins are on SwiftPM and which are not.** `flutter_tools` decides this with a file check: a plugin supports SwiftPM if `ios/<plugin_name>/Package.swift` exists in its package (or `darwin/<plugin_name>/Package.swift` for plugins that share iOS and macOS code). The tool reads plugin paths from `.flutter-plugins-dependencies`, so you can run the same check yourself before touching the Xcode project:

   ```bash
   #!/usr/bin/env bash
   # Flutter 3.44+, run from the app root after `flutter pub get`. Needs jq.
   jq -r '.plugins.ios[] | [.name, .path, (if .shared_darwin_source then "darwin" else "ios" end)] | @tsv' \
     .flutter-plugins-dependencies |
   while IFS=$'\t' read -r name path dir; do
     base="${path%/}/$dir"
     if [ -f "$base/$name/Package.swift" ]; then echo "swiftpm    $name"
     elif [ -f "$base/$name.podspec" ];     then echo "pods-only  $name"
     else                                       echo "dart-only  $name"
     fi
   done
   ```

   On a test app with ten common plugins, this is what it printed:

   ```text
   swiftpm    audioplayers_darwin
   swiftpm    device_info_plus
   swiftpm    flutter_contacts
   swiftpm    flutter_secure_storage_darwin
   pods-only  flutter_tts
   swiftpm    geolocator_apple
   swiftpm    image_gallery_saver_plus
   swiftpm    package_info_plus
   dart-only  path_provider_foundation
   swiftpm    vibration
   ```

   `dart-only` means the plugin has no native iOS code at all (`path_provider_foundation` 2.6.0 talks to Foundation through FFI), so neither dependency manager is involved. Any `pods-only` line means you can migrate the Xcode project, but you cannot delete CocoaPods yet. Skip to the "pods-only plugins" gotcha below.

3. **Let Flutter migrate the Xcode project.** Run a real build, not a config-only one:

   ```bash
   # Flutter 3.44.8, Xcode 27.0
   flutter build ios --simulator --debug
   ```

   In my test, `flutter build ios --config-only` did run `pod install` and regenerated the SwiftPM package under `ios/Flutter/ephemeral/Packages/`, but it did not touch `project.pbxproj` or the scheme. The Xcode project integration happens just before `xcodebuild` runs. Verify:

   ```bash
   grep -c FlutterGeneratedPluginSwiftPackage ios/Runner.xcodeproj/project.pbxproj   # > 0
   grep "Run Prepare Flutter Framework Script" ios/Runner.xcodeproj/xcshareddata/xcschemes/*.xcscheme
   ```

   If every plugin is on SwiftPM, the build output now ends with a checklist that is tailored to your project:

   ```text
   All plugins found for ios are Swift Packages, but your project still has CocoaPods integration. To remove CocoaPods integration, complete the following steps:
     * In the ios/ directory run "pod deintegrate"
     * Also in the ios/ directory, delete the Podfile
     * Remove the include to "Pods/Target Support Files/Pods-Runner/Pods-Runner.debug.xcconfig" in your ios/Flutter/Debug.xcconfig
     * Remove the include to "Pods/Target Support Files/Pods-Runner/Pods-Runner.release.xcconfig" in your ios/Flutter/Release.xcconfig

   Removing CocoaPods integration will improve the project's build time.
   ```

   If you get a different message, "Your project uses a non-standard Podfile and will need to be migrated to Swift Package Manager manually", Flutter compared your `Podfile` byte for byte with its template and found edits. Go through the "custom Podfile" gotcha before you continue. Commit at this point: the project now builds with both managers, and this is your rollback anchor.

4. **Deintegrate CocoaPods.**

   ```bash
   # CocoaPods 1.17.0
   cd ios
   pod deintegrate
   rm -rf Podfile Podfile.lock Pods .symlinks
   cd ..
   ```

   `pod deintegrate` removes the `[CP]` build phases, the `Pods_Runner.framework` link and the Pods xcconfig references from `project.pbxproj`. Verify with `grep -c "\[CP\]" ios/Runner.xcodeproj/project.pbxproj`, which should print `0`.

5. **Remove the Pods includes from the xcconfig files.** Both files start with an optional include that `pod deintegrate` does not touch:

   ```text
   // ios/Flutter/Debug.xcconfig, before
   #include? "Pods/Target Support Files/Pods-Runner/Pods-Runner.debug.xcconfig"
   #include "Generated.xcconfig"

   // after
   #include "Generated.xcconfig"
   ```

   Do the same in `Release.xcconfig`, and in any per-flavor xcconfig you created (`Debug-dev.xcconfig` and so on). The `#include?` form means a missing file is silently ignored, so leaving it there will not break the build. But `flutter_tools` checks for that line and keeps printing the removal checklist while it exists. Verify with `grep -rn "Pods" ios/Flutter/*.xcconfig`, which should print nothing.

6. **Clean up the workspace reference.** `pod deintegrate` ends with "The workspace referencing the Pods project still remains." Open `ios/Runner.xcworkspace/contents.xcworkspacedata` and delete the `<FileRef location = "group:Pods/Pods.xcodeproj">` element, so Xcode stops showing a red, missing project. Keep `Runner.xcworkspace` itself; Flutter and Xcode still open the app through it.

7. **Rebuild from clean.**

   ```bash
   # Flutter 3.44.8 / 3.47.6
   flutter clean
   flutter pub get
   flutter build ios --simulator --debug
   ```

   Verify two things in the output: there is no `Running pod install...` line, and `ios/Podfile` was not recreated. If the `Podfile` came back, a pods-only plugin is still in the graph.

8. **Update CI.** Remove `pod install`, `pod repo update`, Ruby setup and CocoaPods cache steps. Cache `~/Library/Developer/Xcode/DerivedData/<project>/SourcePackages` or pass `-clonedSourcePackagesDirPath` to `xcodebuild` if you build from Xcode directly. Verify by running the pipeline on a runner image without the `cocoapods` gem installed.

## Verification

- `flutter build ios --release --no-codesign` succeeds and prints no `pod install` line.
- `flutter run` on a real device works, including hot reload. That proves the pre-action prepared `Flutter.framework` correctly.
- In Xcode, every scheme you ship has the "Run Prepare Flutter Framework Script" pre-action under Edit Scheme, Build, Pre-actions. Flavor schemes created by hand are the ones most often missing it.
- Each plugin with native code works at runtime: request one permission, open one URL, read one secure storage value. A plugin that compiled but lost its configuration fails here, not at build time (see the `permission_handler` gotcha).
- The archive builds: `flutter build ipa` succeeds and the upload passes App Store Connect validation, which is the first place a missing plugin resource or privacy manifest would surface.

## Rolling back

This migration is reversible. If you committed after step 3, `git revert` of the deintegration commit plus `cd ios && pod install` restores the mixed setup. To leave SwiftPM entirely, opt out for the whole project in `pubspec.yaml`:

```yaml
# pubspec.yaml, Flutter 3.44+
flutter:
  config:
    enable-swift-package-manager: false
```

Then remove `FlutterGeneratedPluginSwiftPackage` from Package Dependencies and from the `Runner` target's Frameworks, Libraries, and Embedded Content, and delete the pre-action from each scheme. The opt-out alone leaves the SwiftPM integration in the project file, and Flutter keeps generating an empty package for it. Treat the opt-out as temporary, because CocoaPods support is in maintenance mode and will eventually go away.

## Gotchas from a real migration

### Pods-only plugins bring the Podfile back

If even one plugin lacks a `Package.swift`, Flutter runs in mixed mode. I added `flutter_tts` 4.2.5 to a fully migrated app with no `Podfile`, and the next build printed:

```text
The following plugins do not support Swift Package Manager for ios:
  - flutter_tts
This will become an error in a future version of Flutter. Please contact the plugin maintainers to request Swift Package Manager adoption.
Running pod install...
```

Flutter regenerated `ios/Podfile` from its template and put the `#include?` lines back into both xcconfig files. Mixed mode builds fine, so this is not an emergency. Your options are to replace the plugin, vendor its iOS code into a local package with a `Package.swift`, or keep the mixed setup and check the plugin again later. Do not delete the regenerated `Podfile` in a loop; it will keep coming back as long as that plugin is in `pubspec.lock`.

### permission_handler ignores your Podfile macros under SwiftPM

The classic `permission_handler` setup puts `PERMISSION_CAMERA=1` and friends into `GCC_PREPROCESSOR_DEFINITIONS` in the `Podfile`'s `post_install` block. Under SwiftPM that block no longer runs. Starting with `permission_handler_apple` 9.4.8, the package manifest enables a permission when the matching `NS*UsageDescription` key exists in your `Info.plist`. 9.5.1 fixed the detection for build-configuration and flavor specific plists, and 9.6.0 added a `permission_handler.yaml` for per-flavor permissions, so make sure your lockfile resolves 9.6.x. Two consequences: a permission without a usage description is compiled out and reports `denied` at runtime instead of failing the build, and the manifest is cached, so after changing `Info.plist` you need `rm -rf ~/Library/Developer/Xcode/DerivedData` once. This is why the runtime check in the verification list matters.

### A custom Podfile has to be translated, not deleted

Look for three things in your `Podfile` before you delete it. Non-Flutter pods (`pod 'GoogleMLKit/...'`, analytics SDKs) need to become Swift package dependencies added through Xcode's Package Dependencies tab on the `Runner` project. Build setting overrides in `post_install` (`ENABLE_BITCODE`, `EXCLUDED_ARCHS`, deployment targets) only affected pod targets, so most of them can just go away. Preprocessor macros consumed by plugins need the plugin's SwiftPM equivalent, as with `permission_handler` above. If you skip this, the build usually still succeeds and the feature silently disappears.

### Minimum iOS version mismatches

A SwiftPM plugin can declare a higher platform than your app, which fails with "The package product 'plugin_name_ios' requires minimum platform version 14.0 for the iOS platform, but this target supports 12.0". Raise Minimum Deployments on the `Runner` target and run `flutter build ios --config-only` to regenerate the config. On Xcode 27 there is a second floor: it rejects any iOS deployment target below 15.0, and a project created by Flutter 3.44.8 still says 13.0. That error hits the `Runner` project and, in mixed mode, every pod target. For pods, add an override to the `post_install` block after `flutter_additional_ios_build_settings(target)`:

```ruby
# ios/Podfile, Flutter 3.44.8 + Xcode 27.0, mixed mode only
target.build_configurations.each do |config|
  config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '15.0'
end
```

macOS has its own version of this problem, covered in [raising a Flutter macOS app's minimum deployment target to macOS 12 for Xcode 27](/2026/09/raise-a-flutter-macos-apps-minimum-deployment-target-to-macos-12-for-xcode-27/).

### Old StackOverflow fixes stop applying

Pinning a pod version in the `Podfile` to resolve a conflict does nothing once that plugin resolves through SwiftPM, because CocoaPods never sees it. If you previously fought [CocoaPods "could not find compatible versions for pod"](/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/), delete those pins when you migrate rather than carrying them forward.

### Add-to-app modules are different

A Flutter module embedded in a native iOS app uses its own module `Podfile`, which `flutter_tools` deliberately does not touch. Follow the add-to-app project setup guide instead of the steps above.

## Related

- The release that flipped the default: [Flutter 3.44 makes Swift Package Manager the default](/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).
- If Xcode itself is the problem rather than the dependency manager, start with [failed to build an iOS app with Xcode 16 and Flutter 3.x](/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/).
- To roll the migration out across several Flutter versions in CI without breaking older branches, see [targeting multiple Flutter versions from one CI pipeline](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).

## Sources

- [Swift Package Manager for app developers](https://docs.flutter.dev/packages-and-plugins/swift-package-manager/for-app-developers) (docs.flutter.dev)
- [Swift Package Manager for plugin authors](https://docs.flutter.dev/packages-and-plugins/swift-package-manager/for-plugin-authors) (docs.flutter.dev)
- [Saying goodbye to CocoaPods](https://flutter.dev/blog/saying-goodbye-to-cocoapods-swift-package-manager-is-soon-the-default-in-flutter) (flutter.dev blog)
- [`darwin_dependency_management.dart`](https://github.com/flutter/flutter/blob/master/packages/flutter_tools/lib/src/macos/darwin_dependency_management.dart), the source of the warnings quoted above (flutter/flutter)
- [`permission_handler_apple` changelog](https://github.com/Baseflow/flutter-permission-handler/blob/main/permission_handler_apple/CHANGELOG.md) (Baseflow/flutter-permission-handler)
- [CocoaPods Specs repo read-only plan](https://blog.cocoapods.org/CocoaPods-Specs-Repo/) (CocoaPods blog)
