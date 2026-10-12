---
title: "Fix: \"does not support provisioning profiles\" when archiving a Flutter iOS app after migrating to Swift Package Manager"
description: "A provisioning profile passed to xcodebuild on the command line applies to every SwiftPM resource bundle target. Set manual signing on the Runner target instead."
pubDate: 2026-10-12
template: error-page
tags:
  - "errors"
  - "flutter"
  - "ios"
  - "swiftpm"
  - "xcode"
  - "ci"
---

Stop passing `PROVISIONING_PROFILE_SPECIFIER` (and usually `CODE_SIGN_STYLE`, `DEVELOPMENT_TEAM` and `CODE_SIGN_IDENTITY` along with it) as `xcodebuild` command-line arguments or fastlane `xcargs`. A command-line build setting overrides that setting for **every** target in the build. After the SwiftPM migration, that includes the resource bundle target Xcode generates for each plugin, such as `url_launcher_ios_url_launcher_ios`, and a resource bundle cannot carry a provisioning profile. Put manual signing on the `Runner` target's Release configuration instead, then archive with `flutter build ipa`. With CocoaPods, the same arguments only worked because a `post_install` hook set `CODE_SIGNING_ALLOWED = NO` on every pod. SwiftPM has no such hook, so the migration surfaces the error. Everything below was reproduced on Flutter 3.44.8, Xcode 27.0 and CocoaPods 1.17.0.

## The error, in full

You get one error per plugin that ships resources (in practice, every plugin with a `PrivacyInfo.xcprivacy` manifest), followed by the usual archive failure:

```
.../ios/Flutter/ephemeral/Packages/.packages/url_launcher_ios-6.4.2/Package.swift: error: url_launcher_ios_url_launcher_ios does not support provisioning profiles. url_launcher_ios_url_launcher_ios does not support provisioning profiles, but provisioning profile MyApp AppStore has been manually specified. Set the provisioning profile value to "Automatic" in the build settings editor. (in target 'url_launcher_ios_url_launcher_ios' from project 'url_launcher_ios')
.../ios/Flutter/ephemeral/Packages/.packages/shared_preferences_foundation-2.5.7/Package.swift: error: shared_preferences_foundation_shared_preferences_foundation does not support provisioning profiles. shared_preferences_foundation_shared_preferences_foundation does not support provisioning profiles, but provisioning profile MyApp AppStore has been manually specified. Set the provisioning profile value to "Automatic" in the build settings editor. (in target 'shared_preferences_foundation_shared_preferences_foundation' from project 'shared_preferences_foundation')
** ARCHIVE FAILED **
```

The two things to notice are the path, which points into `Flutter/ephemeral/Packages/.packages/`, and the target name, which follows the SwiftPM `<package>_<target>` pattern. Both tell you that the failing target is a Swift package's resource bundle, not your app and not a plugin's code.

The advice in the message, "Set the provisioning profile value to Automatic in the build settings editor", does not help here. You cannot open the build settings of a target that Xcode synthesizes from a `Package.swift`, and nothing in that target asks for a profile. The profile is being forced on it from outside.

## Why the profile reaches targets you never configured

Xcode resolves a build setting through several layers, from lowest to highest priority: platform defaults, project-level settings, xcconfig files, target-level settings, and finally the overrides you pass to `xcodebuild` as `NAME=value`. The highest layer is not scoped to a target. When a CI script runs:

```bash
# Xcode 27.0, Flutter 3.44.8 - the pattern that breaks
xcodebuild -workspace Runner.xcworkspace -scheme Runner \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath build/Runner.xcarchive archive \
  CODE_SIGN_STYLE=Manual \
  DEVELOPMENT_TEAM=ABCDE12345 \
  CODE_SIGN_IDENTITY="Apple Distribution" \
  PROVISIONING_PROFILE_SPECIFIER="MyApp AppStore"
```

every target that takes part in the archive gets `PROVISIONING_PROFILE_SPECIFIER = MyApp AppStore`. Xcode's signing validation then rejects the setting on any product type that cannot be provisioned, such as resource bundles, static libraries and frameworks. Apple has not always enforced this consistently: a [developer forums thread](https://developer.apple.com/forums/thread/700327) tracks the same error for native Swift package dependencies appearing in Xcode 13.3 betas, disappearing in the 13.3 GM, and coming back in Xcode 14. On Xcode 27.0 it is enforced.

After the migration, the targets in an archive are `Runner`, the `FlutterGeneratedPluginSwiftPackage` aggregate, each plugin's library product, and one `.bundle` target per plugin that declares `resources:` in its `Package.swift`. Most first-party plugins now ship a privacy manifest that way, so almost every real app has several of these bundles.

### Why it worked under CocoaPods

I ran the same command against the same app with SwiftPM turned off (`enable-swift-package-manager: false` under `flutter: config:` in `pubspec.yaml`). It fails too, just with different target names:

```
ios/Pods/Pods.xcodeproj: error: Pods-Runner does not support provisioning profiles. ...
ios/Pods/Pods.xcodeproj: error: url_launcher_ios does not support provisioning profiles. ...
ios/Pods/Pods.xcodeproj: error: shared_preferences_foundation does not support provisioning profiles. ...
```

So the command line was never correct. Projects that built with it had a `post_install` block in the `Podfile` similar to this one, usually copied from a Stack Overflow answer years ago:

```ruby
# ios/Podfile, CocoaPods 1.17.0
post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_ios_build_settings(target)
    target.build_configurations.each do |config|
      config.build_settings['CODE_SIGNING_ALLOWED'] = 'NO'
    end
  end
end
```

With that hook in place, the archive gets past every pod target and only `Runner` is validated against the profile. The hook works because Xcode skips signing validation for a target that is not allowed to sign, even though the forced profile is still in its settings. When you delete the `Podfile` as the last step of the migration, the hook goes with it, and SwiftPM gives you no equivalent. There is no `post_install` for packages, and the generated `Package.swift` under `Flutter/ephemeral` is rewritten on every build.

## Minimal repro

```bash
# Flutter 3.44.8, Xcode 27.0, SwiftPM enabled (the default since 3.44)
flutter create --platforms=ios -e --org com.example myapp
cd myapp
flutter pub add url_launcher shared_preferences
# Xcode 27 rejects the template's 13.0 deployment target
sed -i '' 's/IPHONEOS_DEPLOYMENT_TARGET = 13.0/IPHONEOS_DEPLOYMENT_TARGET = 15.0/g' \
  ios/Runner.xcodeproj/project.pbxproj
flutter build ios --simulator --debug   # applies the SwiftPM project migration
cd ios
xcodebuild -workspace Runner.xcworkspace -scheme Runner -configuration Release \
  -destination 'generic/platform=iOS' -archivePath ../build/Runner.xcarchive archive \
  CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=ABCDE12345 \
  PROVISIONING_PROFILE_SPECIFIER="MyApp AppStore" CODE_SIGN_IDENTITY="Apple Distribution"
```

You do not need a real certificate or profile to see it. Xcode reports the "does not support provisioning profiles" errors for the two bundle targets during build planning, next to the expected "No profile for team" error for `Runner`.

## Fix 1: put manual signing on the Runner target and use `flutter build ipa`

Signing belongs to the targets that produce something signable: `Runner`, plus any app extensions you have (share extension, notification service extension, widget). Set it there and nowhere else.

In Xcode, open `ios/Runner.xcworkspace`, select the `Runner` target, go to **Signing & Capabilities**, choose the **Release** tab, turn off **Automatically manage signing**, and pick your team and profile. If you prefer to see the result, this is what ends up in the `Runner` target's Release configuration in `ios/Runner.xcodeproj/project.pbxproj`:

```
/* Flutter 3.44.8, Xcode 27.0 - Runner target, Release configuration */
CODE_SIGN_STYLE = Manual;
DEVELOPMENT_TEAM = ABCDE12345;
"CODE_SIGN_IDENTITY[sdk=iphoneos*]" = "Apple Distribution";
"PROVISIONING_PROFILE_SPECIFIER[sdk=iphoneos*]" = "MyApp AppStore";
```

Repeat for the `Profile` configuration if you archive profile builds. Then drop every signing argument from the command and archive normally:

```bash
# Flutter 3.44.8
flutter build ipa --release
```

When I moved the same four settings from the command line into the `Runner` target, the package errors disappeared and only the expected "No profile ... found" error for `Runner` remained. My test machine has no distribution profile, so that is as far as the repro goes, but that remaining error is the normal one you get for `Runner` alone when the named profile is not installed.

`flutter build ipa` does not add signing overrides of its own. In Flutter 3.44.8, `build_ios.dart` reads `Runner`'s resolved build settings after the archive. If `CODE_SIGN_STYLE` is `Manual` and both `PROVISIONING_PROFILE_SPECIFIER` and `DEVELOPMENT_TEAM` are set, it finds the matching installed profile and generates an `ExportOptions.plist` with `signingStyle` `manual` and a `provisioningProfiles` entry for your bundle ID. If you need full control, for example for an app with extensions, pass your own file:

```bash
# Flutter 3.44.8
flutter build ipa --release --export-options-plist=ios/ExportOptions.plist
```

```xml
<!-- ios/ExportOptions.plist, Xcode 27.0 -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store-connect</string>
  <key>signingStyle</key>
  <string>manual</string>
  <key>teamID</key>
  <string>ABCDE12345</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>com.example.myapp</key>
    <string>MyApp AppStore</string>
  </dict>
</dict>
</plist>
```

List only app and app extension bundle IDs in `provisioningProfiles`. Plugin frameworks and bundles never get an entry.

## Fix 2: in fastlane, change the project, not the command line

The fastlane version of the bad pattern is `build_app(xcargs: "PROVISIONING_PROFILE_SPECIFIER=...")`, and `xcargs` is exactly the command-line layer. Use `update_code_signing_settings` with `targets:` so the setting is written into `Runner` only, then build without signing `xcargs`:

```ruby
# fastlane 2.x, Flutter 3.44.8, Xcode 27.0
lane :release do
  update_code_signing_settings(
    path: "ios/Runner.xcodeproj",
    use_automatic_signing: false,
    targets: ["Runner"],
    build_configurations: ["Release"],
    team_id: "ABCDE12345",
    code_sign_identity: "Apple Distribution",
    sdk: "iphoneos*",
    profile_name: "MyApp AppStore"
  )
  build_app(
    workspace: "ios/Runner.xcworkspace",
    scheme: "Runner",
    configuration: "Release",
    export_method: "app-store",
    export_options: {
      provisioningProfiles: { "com.example.myapp" => "MyApp AppStore" }
    }
  )
end
```

The `targets` parameter defaults to all targets in the project. The plugin bundles are not in `Runner.xcodeproj`, so leaving it out would not reproduce the error, but naming the target keeps a future extension or test target from getting the wrong profile.

## Fix 3: switch the archive to automatic signing

If you do not need a specific profile, let Xcode manage it. Keep `CODE_SIGN_STYLE = Automatic` on `Runner` and let `xcodebuild` fetch or create profiles with an App Store Connect API key:

```bash
# Xcode 27.0
xcodebuild -workspace ios/Runner.xcworkspace -scheme Runner -configuration Release \
  -destination 'generic/platform=iOS' -archivePath build/Runner.xcarchive archive \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$ASC_KEY_PATH" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID"
```

Package bundle targets need no signing in this mode, so they pass validation with no extra work. The cost is that the CI machine needs the API key and creates profiles on its own, which some release processes do not allow.

## Workarounds that look right but are not

- **`CODE_SIGNING_ALLOWED=NO` on the command line.** It reaches `Runner` as well, so you get an unsigned archive that `-exportArchive` cannot turn into an uploadable IPA.
- **Conditional settings on the command line.** `"PROVISIONING_PROFILE_SPECIFIER[sdk=iphoneos*]=MyApp AppStore"` is not parsed as a conditional. On Xcode 27.0 the value came out as `iphoneos*]=MyApp AppStore` and `Runner` failed with "No profile ... matching 'iphoneos*]=MyApp AppStore' found". Conditions only work in project files and xcconfig files.
- **`-xcconfig` or `XCODE_XCCONFIG_FILE`.** Both apply their file as an override to the whole build, so a profile in that file reaches the package targets just like a `NAME=value` argument.
- **Turning SwiftPM back off.** `enable-swift-package-manager: false` plus the old `post_install` hook makes the error go away, but only by bringing CocoaPods back. That buys time, not a fix, and the CocoaPods trunk goes read-only on 2 December 2026.

## Lookalike errors from the same command line

Leaving out the profile but keeping the other overrides only changes the error. With `CODE_SIGN_STYLE=Manual` and `CODE_SIGN_IDENTITY` on the command line and no team, Xcode 27.0 reports `Signing for "url_launcher_ios_url_launcher_ios" requires a development team` for each bundle. Add `DEVELOPMENT_TEAM` and it becomes `No signing certificate "iOS Distribution" found` on the same bundle targets. All three have the same cause and the same fix: no signing settings on the command line.

A different message, `exportArchive: SomeKit.framework does not support provisioning profiles`, comes from the export step, not the archive. It means your `ExportOptions.plist` (or fastlane's `export_options`) maps a framework's bundle ID to a profile. Remove that entry. Only the app and its extensions belong there.

If the archive gets past signing and then fails on deployment targets, that is the Xcode 27 minimum of iOS 15, not a signing problem. The CocoaPods-side version of that failure is covered in [the post on CocoaPods version conflicts in Flutter iOS builds](/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/).

## Related

- [Migrate a Flutter iOS app from CocoaPods to Swift Package Manager](/2026/10/migrate-a-flutter-ios-app-from-cocoapods-to-swift-package-manager/) covers the migration that removes the `Podfile` hook, including how to move other custom `post_install` logic.
- [Flutter 3.44 makes SwiftPM the default](/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/) explains why apps upgraded to 3.44 switched without any change on your side.
- [Fix: Unable to find a destination matching the provided destination specifier](/2026/08/fix-unable-to-find-a-destination-matching-the-provided-destination-specifier-in-a-flutter-ios-build/) is another iOS build failure caused by leftover CocoaPods-era settings.
- [Fix: the provisioning profile doesn't include the currently selected device](/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/) covers the device-registration side of provisioning, from the .NET MAUI angle.

## Sources

- [Swift Package Manager for app developers](https://docs.flutter.dev/packages-and-plugins/swift-package-manager/for-app-developers), Flutter docs.
- [Build and release an iOS app](https://docs.flutter.dev/deployment/ios), Flutter docs (`flutter build ipa` and `--export-options-plist`).
- [`build_ios.dart` in flutter_tools](https://github.com/flutter/flutter/blob/stable/packages/flutter_tools/lib/src/commands/build_ios.dart), the ExportOptions generation for manual signing.
- [update_code_signing_settings](https://docs.fastlane.tools/actions/update_code_signing_settings/), fastlane docs.
- [Apple Developer Forums thread 700327](https://developer.apple.com/forums/thread/700327), the same error for native Swift package dependencies in a manually signed CI archive, and how its enforcement changed between Xcode 13 and 14.
- [Apple Developer Forums thread 726714](https://developer.apple.com/forums/thread/726714), the CocoaPods variant, raised for every target in the `Pods` project.
