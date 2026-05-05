---
title: "How to add platform-specific code in Flutter without plugins"
description: "Call native Android (Kotlin) and iOS (Swift) code from a Flutter 3.x app without writing a plugin: MethodChannel, EventChannel, BasicMessageChannel, the StandardMessageCodec type table, threading rules, and the cases where a plugin still wins."
pubDate: 2026-05-05
template: how-to
tags:
  - "flutter"
  - "dart"
  - "android"
  - "ios"
  - "platform-channels"
  - "how-to"
---

Short answer: drop a `MethodChannel` into your `main.dart`, register the same channel name on the Android `FlutterActivity` and the iOS `AppDelegate`, and call it with `await channel.invokeMethod(...)`. Use `EventChannel` for native-to-Dart streams (sensors, broadcasts) and `BasicMessageChannel` for raw bytes or strings. You only need a federated plugin once you want to reuse the integration across apps or publish it to pub.dev. Tested on Flutter 3.27.1 with Android Gradle Plugin 8.7.3 and Xcode 16.2 (Swift 5.10).

The phrase "platform-specific code" usually means one thing in Flutter docs: a method channel that crosses the Dart-native boundary. That bridge exists in every Flutter app already, plugin or not. A plugin is just a packaged channel with a Dart facade and a build-time registration in two `Podfile` / Gradle files. If you only need the integration in one app, the packaging is overhead. This post shows how to skip it and still keep the code maintainable.

## Why skip the plugin scaffolding

`flutter create --template plugin` generates a federated plugin: `my_plugin`, `my_plugin_android`, `my_plugin_ios`, `my_plugin_platform_interface`, plus an example app. That is the right shape if multiple apps will share the integration or if you intend to publish it. For a single app it costs you:

- Six extra `pubspec.yaml` files and a `melos.yaml` if you want one-shot CI.
- A platform interface that adds an indirection for every method.
- A separate package version to bump when your app code wants to call a new native method.
- A second test harness (the plugin's `example/` app) that drifts from your real app.

In a single-app codebase the channel can live next to the feature that uses it. A button that toggles flashlight state and a `FlashlightService` that wraps the channel is twenty lines of Dart and twenty lines of Kotlin / Swift.

## The three channels you actually need

Flutter ships three channel types in `package:flutter/services.dart`. Pick by call shape, not by feature.

- `MethodChannel`: request / response. Dart calls a named method on the native side, awaits a result, native side can throw a typed error. Use this for "open a file picker", "get the device model", "vibrate for 200 ms".
- `EventChannel`: push stream from native to Dart. Native side opens a `StreamSink`; Dart subscribes and listens. Use this for sensors, system broadcast receivers (charging state, network change), or any callback the OS gives you.
- `BasicMessageChannel`: raw, untyped messages with a codec you choose (`StandardMessageCodec`, `JSONMessageCodec`, `StringCodec`, `BinaryCodec`). Use this when you control both ends and want to avoid the method-name overhead, or when you are sending bytes (audio frames, image buffers).

All three are async on the Dart side. All three serialise their payload through a `MessageCodec`. Default codec is `StandardMessageCodec`, which understands a small fixed set of types. If your payload does not fit that set, you serialise it yourself.

## StandardMessageCodec type table

This is the table to keep open while writing channel code. Anything outside it round-trips as `null` or throws, depending on the platform.

| Dart                                | Android (Java/Kotlin)               | iOS (Swift)                                  |
| ----------------------------------- | ----------------------------------- | -------------------------------------------- |
| `null`                              | `null`                              | `nil` / `NSNull`                             |
| `bool`                              | `Boolean`                           | `Bool` / `NSNumber(value: Bool)`             |
| `int` (32 or 64 bit)                | `Integer` / `Long`                  | `Int32` / `Int64` / `NSNumber`               |
| `double`                            | `Double`                            | `Double` / `NSNumber(value: Double)`         |
| `String`                            | `String`                            | `String`                                     |
| `Uint8List`                         | `byte[]`                            | `FlutterStandardTypedData(bytes:)`           |
| `Int32List` / `Int64List` / `Float64List` | `int[]` / `long[]` / `double[]` | `FlutterStandardTypedData(int32:)` etc.      |
| `List<dynamic>`                     | `List<Object?>`                     | `[Any?]`                                     |
| `Map<dynamic, dynamic>`             | `Map<Object?, Object?>`             | `[AnyHashable: Any?]`                        |

`DateTime`, custom classes, and `BigInt` are not on the list. Convert to `int` (epoch ms), `Map`, or `String` at the boundary.

## A complete MethodChannel example: battery level

This is the canonical Flutter sample, expanded to show the file layout you would actually ship.

### 1. Dart side (`lib/services/battery_service.dart`)

```dart
// Flutter 3.27.1, Dart 3.6
import 'package:flutter/services.dart';

class BatteryUnavailable implements Exception {
  final String message;
  BatteryUnavailable(this.message);
  @override
  String toString() => 'BatteryUnavailable: $message';
}

class BatteryService {
  static const _channel = MethodChannel('com.example.app/battery');

  Future<int> getBatteryLevel() async {
    try {
      final level = await _channel.invokeMethod<int>('getBatteryLevel');
      if (level == null) throw BatteryUnavailable('null result');
      return level;
    } on PlatformException catch (e) {
      throw BatteryUnavailable(e.message ?? e.code);
    } on MissingPluginException {
      throw BatteryUnavailable('handler not registered on this platform');
    }
  }
}
```

Three things worth noticing. First, the channel name is reverse-DNS plus a feature suffix; this is the convention every Flutter plugin follows and it stops you from colliding with a future package. Second, `invokeMethod<int>` is generic, which gives you a compile-time signal about what the codec must produce. Third, `MissingPluginException` is thrown when the channel name is not registered on the running platform. Catch it and turn it into a sensible error, otherwise the user gets a stack trace from `package:flutter`.

### 2. Android side (`android/app/src/main/kotlin/.../MainActivity.kt`)

```kotlin
// AGP 8.7.3, Kotlin 2.0, Flutter 3.27.1
package com.example.app

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private val channelName = "com.example.app/battery"

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "getBatteryLevel" -> {
                        val level = readBatteryLevel()
                        if (level >= 0) result.success(level)
                        else result.error("UNAVAILABLE", "Battery level not available", null)
                    }
                    else -> result.notImplemented()
                }
            }
    }

    private fun readBatteryLevel(): Int {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            val bm = getSystemService(Context.BATTERY_SERVICE) as BatteryManager
            bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        } else {
            val intent = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            val l = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
            val s = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
            if (l >= 0 && s > 0) (l * 100) / s else -1
        }
    }
}
```

`configureFlutterEngine` runs once per engine, not once per activity recreation, so this is the safe place to wire the handler. Do not register the channel inside `onCreate` if your `MainActivity` extends `FlutterFragmentActivity` or you will leak handlers across configuration changes.

### 3. iOS side (`ios/Runner/AppDelegate.swift`)

```swift
// Xcode 16.2, Swift 5.10, iOS 13+ deployment target, Flutter 3.27.1
import UIKit
import Flutter

@main
@objc class AppDelegate: FlutterAppDelegate {
    override func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        let controller = window?.rootViewController as! FlutterViewController
        let channel = FlutterMethodChannel(
            name: "com.example.app/battery",
            binaryMessenger: controller.binaryMessenger
        )

        channel.setMethodCallHandler { [weak self] call, result in
            guard call.method == "getBatteryLevel" else {
                result(FlutterMethodNotImplemented)
                return
            }
            self?.readBatteryLevel(result: result)
        }

        GeneratedPluginRegistrant.register(with: self)
        return super.application(application, didFinishLaunchingWithOptions: launchOptions)
    }

    private func readBatteryLevel(result: FlutterResult) {
        let device = UIDevice.current
        device.isBatteryMonitoringEnabled = true
        if device.batteryState == .unknown {
            result(FlutterError(code: "UNAVAILABLE", message: "Battery info unavailable", details: nil))
        } else {
            result(Int(device.batteryLevel * 100))
        }
    }
}
```

Three platform-specific points. First, `isBatteryMonitoringEnabled` must be `true` before reading `batteryLevel`, otherwise you get `-1.0`. Second, `FlutterError` is the iOS analogue of Android's `result.error(...)`; it surfaces in Dart as `PlatformException`. Third, `GeneratedPluginRegistrant.register(with: self)` stays even though you wrote no plugin: the build still emits a registrant for any transitive plugin in `pubspec.yaml`.

## EventChannel for streams

`MethodChannel` is wrong for "tell me when battery state changes". You would end up polling. `EventChannel` lets the native side push.

### Dart subscriber

```dart
// Flutter 3.27.1
import 'package:flutter/services.dart';

class BatteryStateService {
  static const _events = EventChannel('com.example.app/battery_state');

  Stream<String> watch() => _events
      .receiveBroadcastStream()
      .map((dynamic event) => event as String);
}
```

`receiveBroadcastStream()` returns a single broadcast stream shared by all listeners. Cancelling the last subscription tells the native side to tear down its broadcast receiver / observer, so do not hold a reference to a subscription you do not use.

### Android handler

```kotlin
// AGP 8.7.3, Kotlin 2.0
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import io.flutter.plugin.common.EventChannel

class BatteryStateStreamHandler(private val context: Context) : EventChannel.StreamHandler {
    private var receiver: BroadcastReceiver? = null

    override fun onListen(arguments: Any?, events: EventChannel.EventSink) {
        receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
                val charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
                               status == BatteryManager.BATTERY_STATUS_FULL
                events.success(if (charging) "charging" else "discharging")
            }
        }
        context.registerReceiver(receiver, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
    }

    override fun onCancel(arguments: Any?) {
        if (receiver != null) {
            context.unregisterReceiver(receiver)
            receiver = null
        }
    }
}
```

Wire it inside `configureFlutterEngine`:

```kotlin
EventChannel(flutterEngine.dartExecutor.binaryMessenger, "com.example.app/battery_state")
    .setStreamHandler(BatteryStateStreamHandler(applicationContext))
```

Use `applicationContext`, not the activity, or you leak the activity for the lifetime of the broadcast receiver.

### iOS handler

```swift
// Swift 5.10
import Flutter
import UIKit

class BatteryStateStreamHandler: NSObject, FlutterStreamHandler {
    private var sink: FlutterEventSink?

    func onListen(withArguments arguments: Any?, eventSink events: @escaping FlutterEventSink) -> FlutterError? {
        sink = events
        UIDevice.current.isBatteryMonitoringEnabled = true
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(stateChanged),
            name: UIDevice.batteryStateDidChangeNotification,
            object: nil
        )
        stateChanged()
        return nil
    }

    func onCancel(withArguments arguments: Any?) -> FlutterError? {
        NotificationCenter.default.removeObserver(self)
        sink = nil
        return nil
    }

    @objc private func stateChanged() {
        let s = UIDevice.current.batteryState
        sink?(s == .charging || s == .full ? "charging" : "discharging")
    }
}
```

Then in `AppDelegate`:

```swift
let stateChannel = FlutterEventChannel(
    name: "com.example.app/battery_state",
    binaryMessenger: controller.binaryMessenger
)
stateChannel.setStreamHandler(BatteryStateStreamHandler())
```

Send an initial value in `onListen` so the first `await for (final s in service.watch())` does not stall waiting for the first OS broadcast.

## BasicMessageChannel for raw payloads

`BasicMessageChannel` skips the method-name dispatcher and uses whatever codec you give it. Useful when both ends are yours and the payload is uniform.

```dart
// Flutter 3.27.1
import 'package:flutter/services.dart';

final _logChannel = BasicMessageChannel<String>(
  'com.example.app/log',
  StringCodec(),
);

Future<void> sendLog(String line) => _logChannel.send(line) as Future<void>;
```

```kotlin
// AGP 8.7.3, Kotlin 2.0
import io.flutter.plugin.common.BasicMessageChannel
import io.flutter.plugin.common.StringCodec

BasicMessageChannel(flutterEngine.dartExecutor.binaryMessenger, "com.example.app/log", StringCodec.INSTANCE)
    .setMessageHandler { message, reply ->
        android.util.Log.i("flutter", message ?: "")
        reply.reply(null)
    }
```

For binary payloads use `BinaryCodec` on both sides and you get `ByteData` in Dart, `ByteBuffer` in Kotlin, `FlutterStandardTypedData` in Swift.

## Threading model and the pitfalls that bite

The channel itself is asynchronous, but the handler callback runs on the platform thread, not a background thread.

- **Android**: handlers run on the Android main thread. Long work blocks the UI thread and will trigger ANR. Move work to a coroutine or `Executors.newSingleThreadExecutor()`, then call `result.success(...)` back on the main thread (`Handler(Looper.getMainLooper()).post { ... }`).
- **iOS**: handlers run on the main `DispatchQueue`. Same rule: do work on a background queue, dispatch the `result(...)` call back to main.
- **Background isolates**: `MethodChannel` has historically required the root isolate. As of Flutter 3.7+ you can pass a custom `binaryMessenger` from a background isolate using `BackgroundIsolateBinaryMessenger.ensureInitialized(token)`, but only for channels you create yourself, and only for codecs that do not capture isolate-local state.
- **Hot restart**: hot restart re-runs `main()` but does not re-run `configureFlutterEngine`. Handlers registered in `configureFlutterEngine` survive a hot restart, which is what you want. Handlers registered inside a Flutter widget's `initState` do not, because the engine retains the previous registration and you end up with two handlers.

The "two handlers" trap is the single most common cause of `MissingPluginException` after a hot reload: a developer registered the handler from a widget, the widget rebuilt, the old handler is still there, the new one fights for the channel. Register channels exactly once, in `MainActivity.configureFlutterEngine` or `AppDelegate.application(_:didFinishLaunchingWithOptions:)`.

## Errors, types, and codecs in practice

Three rules keep channel code boring:

1. **Always type the Dart side**: `invokeMethod<int>`, `invokeMethod<String>`, `invokeMethod<Map<Object?, Object?>>`. The codec is dynamic at runtime; you want the static check.
2. **Always send `result.error(code, message, details)` from native**: `code` becomes `PlatformException.code`, which is what your Dart code switches on. Never throw from inside the handler; `MethodChannel` cannot turn a Kotlin exception into a `PlatformException` unless you wrap it.
3. **Convert at the boundary**: do not send a `Map<String, Object>` of mixed types and parse on the other side. Define a tiny DTO ("`{level: int, charging: bool}`") and write a `fromMap` constructor on each side. If the DTO grows past four fields, use [Pigeon](https://pub.dev/packages/pigeon) to generate the marshalling, but the channels themselves stay yours.

## When a plugin still wins

Skip the plugin until one of these is true:

- You want to publish to pub.dev. Plugins have a hard contract for the platform interface.
- The same integration is needed in three or more apps. The third copy is when the cost of a private package drops below the cost of keeping the channels in sync.
- You need conditional imports for `web`, `windows`, or `linux` so the Dart code does not try to call into a non-existent native side. The federated plugin pattern handles this with a no-op default implementation; in a single app you replicate the same idea by hand with a stub class.
- You need to register multiple channels and you want them lazily attached. `FlutterPlugin.onAttachedToEngine` is the supported lifecycle hook; rolling your own is easy to get wrong on Android once you start handling activity attach / detach.

For the long tail (one channel, one app, one platform pair), the inline approach above is what shipping Flutter codebases actually do.

## Related

- The [MissingPluginException 'No implementation found for method getAll' fix](/2023/10/how-to-fix-missingpluginexception-no-implementation-found-for-method-getall/) covers what to do when a registered channel still throws on release builds (ProGuard, plugin registration, hot restart).
- For a multi-version CI setup that exercises your channel code against several Flutter SDKs, see [targeting multiple Flutter versions from one CI pipeline](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).
- If your platform code is on the .NET side and the integration is MAUI rather than Flutter, the [Windows and macOS only MAUI guide](/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) shows the equivalent target-framework gating.

## Sources

- Flutter docs, [Writing custom platform-specific code](https://docs.flutter.dev/platform-integration/platform-channels).
- Flutter API reference, [MethodChannel](https://api.flutter.dev/flutter/services/MethodChannel-class.html), [EventChannel](https://api.flutter.dev/flutter/services/EventChannel-class.html), [BasicMessageChannel](https://api.flutter.dev/flutter/services/BasicMessageChannel-class.html).
- Flutter API reference, [StandardMessageCodec](https://api.flutter.dev/flutter/services/StandardMessageCodec-class.html) for the supported type table.
- Android docs, [BatteryManager](https://developer.android.com/reference/android/os/BatteryManager).
- Apple docs, [UIDevice batteryLevel](https://developer.apple.com/documentation/uikit/uidevice/1620042-batterylevel).
- Flutter background isolate channels, [BackgroundIsolateBinaryMessenger](https://api.flutter.dev/flutter/services/BackgroundIsolateBinaryMessenger-class.html) (Flutter 3.7+).
