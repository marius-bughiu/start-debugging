---
title: "Debugging Flutter iOS from Windows: a real device workflow (Flutter 3.x)"
description: "A pragmatic workflow for debugging Flutter iOS apps from Windows: offload the build to macOS in GitHub Actions, install the IPA on a real iPhone, and use flutter attach for hot reload and DevTools."
pubDate: 2026-01-23
tags:
  - "flutter"
---
Every few weeks, the same pain point resurfaces: “I’m on Windows. I want to debug my Flutter iOS app on a real iPhone. Do I really need a Mac?” A fresh r/FlutterDev post proposes a pragmatic workaround: offload the iOS build to macOS in GitHub Actions, then install and attach for debugging from Windows: [https://www.reddit.com/r/FlutterDev/comments/1qkm5pd/develop_flutter_ios_apps_on_windows_with_a_real/](https://www.reddit.com/r/FlutterDev/comments/1qkm5pd/develop_flutter_ios_apps_on_windows_with_a_real/)

The open-source project behind it is [https://github.com/MobAI-App/ios-builder](https://github.com/MobAI-App/ios-builder).

## Split the problem: build on macOS, debug from Windows

iOS has two hard constraints:

-   Xcode tooling runs on macOS.
-   Real device install and signing have rules that you cannot bypass from Windows.

But Flutter debugging is mostly “attach to a running app and talk to the VM service”. That means you can decouple build/install from the developer loop, as long as you can get a debug-capable app onto the device.

The flow described in the post is:

-   Trigger a macOS CI job that produces an `.ipa`.
-   Download the artifact to Windows.
-   Install it on a physically connected iPhone (via a bridge app).
-   Run `flutter attach` from Windows to get hot reload and DevTools.

## A minimal GitHub Actions build that produces an IPA

This is not the whole story (signing is its own rabbit hole), but it shows the key idea: a macOS runner builds and uploads an artifact.

```yaml
name: ios-ipa
on:
  workflow_dispatch:
jobs:
  build:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: subosito/flutter-action@v2
        with:
          channel: stable
      - run: flutter pub get
      - run: flutter build ipa --debug --no-codesign
      - uses: actions/upload-artifact@v4
        with:
          name: ios-ipa
          path: build/ios/ipa/*.ipa
```

Whether `--no-codesign` is acceptable depends on how you plan to install. Many real device paths still require signing at some stage, even for debug flows.

## The Windows-side loop: install, then attach

Once the app is installed and running on the iPhone, the Flutter part becomes normal:

```bash
# From Windows
flutter devices
flutter attach -d <device-id>
```

Hot reload works because you are attaching to a debug session, not because you built on the same machine.

## Know the tradeoffs up front

This workflow is useful, but it is not magic:

-   **Signing is still real**: you will deal with certificates, profiles, or a third-party installer path.
-   **You still need a device**: simulators do not run on Windows.
-   **Your CI job becomes part of your dev loop**: optimize build times and cache dependencies.

If you want the original write-up and the repo that triggered this, start here: [https://github.com/MobAI-App/ios-builder](https://github.com/MobAI-App/ios-builder). For official Flutter guidance on iOS debugging, keep the platform docs nearby too: [https://docs.flutter.dev/platform-integration/ios/ios-debugging](https://docs.flutter.dev/platform-integration/ios/ios-debugging).
