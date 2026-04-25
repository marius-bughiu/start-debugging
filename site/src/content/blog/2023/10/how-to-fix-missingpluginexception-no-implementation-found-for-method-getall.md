---
title: "How to fix: MissingPluginException – No implementation found for method getAll"
description: "Fix Flutter `MissingPluginException` 'No implementation found for method getAll' on shared_preferences and similar plugins (package_info_plus, etc.) — ProGuard, plugin registration, minSdkVersion, hot restart fixes."
pubDate: 2023-10-30
updatedDate: 2023-11-01
tags:
  - "flutter"
---
This is quite a common issue that usually occurs in flutter release builds. More often than not the issue is caused by ProGuard stripping away some required APIs at build time, leading to missing implementation exceptions such as the one below.

```plaintext
Unhandled exception:
MissingPluginException(No implementation found for method getAll on channel plugins.flutter.io/shared_preferences)
      MethodChannel.invokeMethod (package:flutter/src/services/platform_channel.dart:278:7)
<asynchronous suspension>
      SharedPreferences.getInstance (package:shared_preferences/shared_preferences.dart:25:27)
<asynchronous suspension>
      main (file:///lib/main.dart)
<asynchronous suspension>
      _startIsolate.<anonymous closure> (dart:isolate/runtime/libisolate_patch.dart:279:19)
      _RawReceivePortImpl._handleMessage (dart:isolate/runtime/libisolate_patch.dart:165:12)
```

That being said, there are actually multiple possible causes to this issue, as such there are multiple possible solutions. Below we explore all of them.

## Disable minifying and shrinking

If ProGuard is indeed the culprit, we should be able to solve this quickly with a few slight modifications to the configuration. Go to your `/android/app/build.gradle` file and change your `release` build configuration from:

```gradle
buildTypes {
    release {
        signingConfig signingConfigs.release
    }
}
```

To this:

```gradle
buildTypes {
        release {
            signingConfig signingConfigs.release
            
            minifyEnabled false
            shrinkResources false
        }
}
```

## Update ProGuard configuration

If the above didn’t work, we can go one step further by changing the ProGuard configuration. To do so, add the following two lines inside your `build.gradle` file, right after the `shrinkResources false` line

```gradle
useProguard true
proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
```

Next, create a new `proguard-rules.pro` file in the same folder as your `build.gradle` (`android/app/proguard-rules.pro`), with the following content:

```gradle
-keep class androidx.lifecycle.DefaultLifecycleObserver
```

## Hard-reference the plugin in `main.dart`

If you don’t want to disable ProGuard’s minifying or shrinking, you could try explicitly referencing the plugin in your `main.dart` file. This should help ProGuard root any necessary dependencies and not strip them out during build.

Simply try calling any plugin method directly inside your `main.dart` file and then run the app again.

## Plugin was not registered

Make sure your plugin is registered by calling the `registerWith` method in `main.dart`.

```dart
if (Platform.isAndroid) {
    SharedPreferencesAndroid.registerWith();
} else if (Platform.isIOS) {
    SharedPreferencesIOS.registerWith();
}
```

## Working with `background_fetch`

When working with `background_fetch` it’s important to re-register your plugins inside of the headless task. Simply take the registration code above and add it at the top of your task function.

```dart
void backgroundFetchTask(HeadlessTask task) async {
    if (Platform.isAndroid) {
        SharedPreferencesAndroid.registerWith();
    } else if (Platform.isIOS) {
        SharedPreferencesIOS.registerWith();
    }
}
```

## `minSdkVersion` is too low

You might be targeting an SDK version which is lower than the minimum required by the plugin. In this case, after a cold start of the app, you should be receiving an error similar to the one below.

```gradle
The plugin shared_preferences requires a higher Android SDK version.
Fix this issue by adding the following to the file android\app\build.gradle:

android {
  defaultConfig {
    minSdkVersion 21
  }
}
```

Just follow the instructions in the error message and the issue should be solved.

## Build might be in an invalid state

Maybe there’s nothing wrong with your code or project dependencies. The project might have run into some invalid state while installing the plugin. To attempt and solve that, try running the `flutter clean` command, followed by a `flutter pub get`. This will do a clean restore of your project’s dependency. Now run your app again and check if the issue is still there or not.

## Conflicts with other packages

There are a few known conflicting packages which can lead to this issue. Try removing them one by one to see if the issue goes away, and once you have identified the culprit, have a go at updating the package as the conflicts might be resolved in newer versions.

Here’s a list of packages which might trigger the `MissingPluginException`:

-   admob\_flutter
-   flutter\_webrtc
-   flutter\_facebook\_login
