---
title: "How to keep Flutter location tracking running in the background on Android 15"
description: "Run a Flutter location tracker that survives the Home button, a swipe from recents and a reboot on Android 15 and 16: a location-typed foreground service in its own Flutter engine, the exact permissions, and the SecurityException you get when the while-in-use rules bite. Tested with geolocator 14.0.3 and flutter_foreground_task 11.0.3."
pubDate: 2026-09-22
template: how-to
tags:
  - "flutter"
  - "dart"
  - "android"
  - "location"
  - "foreground-service"
---

**Short answer:** on Android 15 (and 16), a Flutter location tracker only keeps running when the location updates come from a **foreground service of type `location`** that runs **its own Flutter engine**, not from a stream in your UI isolate. Declare `FOREGROUND_SERVICE` and `FOREGROUND_SERVICE_LOCATION` plus `ACCESS_FINE_LOCATION`, give the service `android:foregroundServiceType="location"`, start it from a button tap while your activity is visible, and listen to `Geolocator.getPositionStream` inside that service. `geolocator`'s own `foregroundNotificationConfig` is enough for "keep tracking while the app is in the background", but it dies when the user swipes the app away. If the tracker must also come back after a reboot or a system restart, the user has to grant "Allow all the time" (`ACCESS_BACKGROUND_LOCATION`), or Android throws a `SecurityException` the moment the service calls `startForeground`.

Everything below was built with Flutter 3.44.8 (which defaults to `targetSdkVersion` 36), `geolocator` 14.0.3 (`geolocator_android` 5.0.3) and `flutter_foreground_task` 11.0.3, and run on an Android 16 (API 36) emulator. Android 16 enforces every Android 14 and Android 15 foreground service rule described here, and since Google Play requires `targetSdkVersion` 36 for new apps and updates from August 31, 2026, these are the rules your app runs under whichever Android version your users have.

## What Android 15 actually changed, and what it did not

Most "my tracker stops on Android 15" reports are not caused by Android 15 itself. The rules that kill location trackers are older:

- **Android 12 (API 31)** forbids starting a foreground service while the app is in the background, apart from a list of [exemptions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start) (boot, a notification tap, an exact alarm, and so on).
- **Android 14 (API 34)** requires every foreground service to declare a [type](https://developer.android.com/develop/background-work/services/fg-service-types) and hold the matching permission. For `location` that is `FOREGROUND_SERVICE_LOCATION`, plus a granted `ACCESS_COARSE_LOCATION` or `ACCESS_FINE_LOCATION` at the moment the service goes to the foreground.
- **While-in-use permissions**: fine and coarse location only count while your app is visible. A `location` service started from the background fails unless the app holds `ACCESS_BACKGROUND_LOCATION`, even when the start itself is one of the allowed exemptions.

What [Android 15](https://developer.android.com/about/versions/15/behavior-changes-15) added is a 6-hour daily limit for `dataSync` and `mediaProcessing` services, a list of types that a `BOOT_COMPLETED` receiver may no longer start (`dataSync`, `camera`, `mediaPlayback`, `phoneCall`, `mediaProjection`, and `microphone` from Android 14), and a stricter `SYSTEM_ALERT_WINDOW` exemption. `location` is not on either list. That matters because a lot of Flutter tracking code copies a `flutter_foreground_task` example that declares `dataSync`. On Android 15 that tracker gets killed after 6 hours and can no longer come back after a reboot. Declaring the correct type fixes both problems.

## Why the stream in your widget stops

The naive tracker is a `StreamSubscription<Position>` in a `State` object. Its callbacks run in the UI isolate of the Flutter engine that belongs to your `FlutterActivity`. When Android decides that process is idle, or the user swipes the app out of recents, that engine goes away and so does your Dart code. No foreground notification can keep code running in an engine that no longer exists.

`geolocator` has a half-step for this. Pass an `AndroidSettings` with a `foregroundNotificationConfig` and `geolocator_android` promotes its own `GeolocatorLocationService` to a foreground service:

```dart
// Flutter 3.44.8, geolocator 14.0.3
final sub = Geolocator.getPositionStream(
  locationSettings: AndroidSettings(
    accuracy: LocationAccuracy.high,
    distanceFilter: 10,
    intervalDuration: const Duration(seconds: 5),
    foregroundNotificationConfig: const ForegroundNotificationConfig(
      notificationTitle: 'Recording trip',
      notificationText: 'Tracking in the background',
      enableWakeLock: true,
    ),
  ),
).listen((p) => debugPrint('GEO_ONLY ${p.latitude},${p.longitude}'));
```

The plugin's own manifest already declares that service with `android:foregroundServiceType="location"`. But `GeolocatorPlugin` connects to it with `bindService`, never `startService`, and unbinds it when the engine detaches. The plugin's doc comment says as much: the notification "does not run your service in the background". I measured it on the API 36 emulator:

| Scenario | `geolocator` with `foregroundNotificationConfig` | `flutter_foreground_task` service + `geolocator` inside it |
| --- | --- | --- |
| App visible | Positions delivered | Positions delivered |
| Home button pressed | Positions delivered, FGS type `0x8` | Positions delivered, FGS type `0x8` |
| Swiped out of recents | Service destroyed, no more positions | Same process keeps running, positions delivered |
| Reboot, while-in-use only | n/a | `SecurityException` on `startForeground` |
| Reboot, "Allow all the time" | n/a | Service restarted, positions delivered |

After the swipe, the geolocator-only log ended with "Unbinding from location service" and "Destroying location service". In the other build, the service's engine stayed connected ("There is still another flutter engine connected, not stopping location service") and the notification kept updating with new coordinates.

So `foregroundNotificationConfig` is the right tool when "background" means "the user switched to another app for a while during a run". For a trip recorder, delivery tracker or fitness app that must keep going until the user presses Stop, the updates have to live in a service that owns its own engine.

## Build the tracker in a separate service engine

`flutter_foreground_task` starts a real, started (not just bound) foreground service, spins up a second Flutter engine inside it, and calls a top-level Dart entry point there. You can run any plugin from that engine, including `geolocator`. The steps:

1. Add the packages.

   ```yaml
   # pubspec.yaml -- Flutter 3.44.8
   dependencies:
     geolocator: ^14.0.3
     flutter_foreground_task: ^11.0.3
   ```

   `flutter_foreground_task` 11.x requires Flutter 3.44+, Kotlin 2.2.20+ and Gradle 8.11.1+. A project created with Flutter 3.44.8 already uses AGP 9.0.1, Kotlin 2.3.20 and Gradle 9.1.0. If yours is older, see [migrating a Flutter Android project to AGP 9 with built-in Kotlin](/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/) first.

2. Declare permissions and the service in `android/app/src/main/AndroidManifest.xml`.

   ```xml
   <!-- targetSdkVersion 36, flutter_foreground_task 11.0.3 -->
   <manifest xmlns:android="http://schemas.android.com/apk/res/android">
       <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
       <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
       <!-- Only if the tracker must restart after boot or a system kill -->
       <uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />
       <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
       <uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />
       <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />

       <application ...>
           <!-- ... your activity ... -->
           <service
               android:name="com.pravera.flutter_foreground_task.service.ForegroundService"
               android:foregroundServiceType="location"
               android:exported="false" />
       </application>
   </manifest>
   ```

   Do not rename the service: the plugin starts it by this class name. `FOREGROUND_SERVICE`, `WAKE_LOCK`, `RECEIVE_BOOT_COMPLETED` and `POST_NOTIFICATIONS` also come from the plugin's own manifest. `FOREGROUND_SERVICE_LOCATION` does not come from either plugin, so you have to add it yourself. `aapt2 dump xmltree` on the built APK shows both services, the plugin's and geolocator's, with `foregroundServiceType=0x00000008` (location).

3. Write the task handler that runs in the service engine.

   ```dart
   // lib/location_task.dart -- Flutter 3.44.8, geolocator 14.0.3, flutter_foreground_task 11.0.3
   import 'dart:async';

   import 'package:flutter_foreground_task/flutter_foreground_task.dart';
   import 'package:geolocator/geolocator.dart';

   // Runs in the service's own Flutter engine, not in the UI isolate.
   @pragma('vm:entry-point')
   void startLocationTask() {
     FlutterForegroundTask.setTaskHandler(LocationTaskHandler());
   }

   // Shared by the UI (settings check) and the service (tracking).
   AndroidSettings trackingSettings() => AndroidSettings(
     accuracy: LocationAccuracy.high,
     distanceFilter: 10,
     intervalDuration: const Duration(seconds: 5),
     // No foregroundNotificationConfig: the flutter_foreground_task service
     // already is the location foreground service.
   );

   class LocationTaskHandler extends TaskHandler {
     StreamSubscription<Position>? _sub;

     @override
     Future<void> onStart(DateTime timestamp, TaskStarter starter) async {
       _sub = Geolocator.getPositionStream(locationSettings: trackingSettings())
           .listen(
             (p) {
               FlutterForegroundTask.updateService(
                 notificationText:
                     '${p.latitude.toStringAsFixed(5)}, ${p.longitude.toStringAsFixed(5)}',
               );
               FlutterForegroundTask.sendDataToMain(<String, Object>{
                 'lat': p.latitude,
                 'lng': p.longitude,
                 'ts': p.timestamp.millisecondsSinceEpoch,
               });
             },
             onError: (Object e) =>
                 FlutterForegroundTask.sendDataToMain('error: $e'),
           );
     }

     @override
     void onRepeatEvent(DateTime timestamp) {}

     @override
     Future<void> onDestroy(DateTime timestamp, bool isTimeout) async {
       await _sub?.cancel();
     }
   }
   ```

   `@pragma('vm:entry-point')` is not optional. In release builds the tree shaker otherwise removes a function that only native code calls. Persist positions here (to SQLite, a file, or an HTTP batch) rather than relying on `sendDataToMain`: after a swipe or a reboot there is no UI isolate listening. Cancel the subscription in `onDestroy`, for the same reasons covered in [cancelling a StreamSubscription in dispose](/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/).

4. Ask for permissions, resolve the location settings, and start the service from the UI.

   ```dart
   // lib/main.dart (excerpt) -- Flutter 3.44.8, geolocator 14.0.3, flutter_foreground_task 11.0.3
   void main() {
     FlutterForegroundTask.initCommunicationPort();
     runApp(const MaterialApp(home: TrackerPage()));
   }

   // In the State's initState:
   FlutterForegroundTask.init(
     androidNotificationOptions: AndroidNotificationOptions(
       channelId: 'tracking',
       channelName: 'Trip tracking',
       channelDescription: 'Shown while a trip is being recorded.',
       onlyAlertOnce: true,
     ),
     iosNotificationOptions: const IOSNotificationOptions(),
     foregroundTaskOptions: ForegroundTaskOptions(
       eventAction: ForegroundTaskEventAction.nothing(),
       autoRunOnBoot: true,
       allowWakeLock: true,
     ),
   );

   Future<bool> _ensurePermissions() async {
     if (!await Geolocator.isLocationServiceEnabled()) return false;

     var perm = await Geolocator.checkPermission();
     if (perm == LocationPermission.denied) {
       perm = await Geolocator.requestPermission();
     }
     if (perm == LocationPermission.denied ||
         perm == LocationPermission.deniedForever) {
       return false;
     }

     // Resolve the "improve location accuracy" prompt here, while there is an
     // Activity. The service engine has none, so geolocator would report
     // "location service disabled" instead of showing the dialog.
     try {
       await Geolocator.getCurrentPosition(
         locationSettings: trackingSettings(),
       ).timeout(const Duration(seconds: 20));
     } on TimeoutException {
       // A slow first fix is fine; the settings check already ran.
     } on LocationServiceDisabledException {
       return false;
     }

     if (await FlutterForegroundTask.checkNotificationPermission() !=
         NotificationPermission.granted) {
       await FlutterForegroundTask.requestNotificationPermission();
     }
     return true;
   }

   Future<void> _start() async {
     if (!await _ensurePermissions()) return;
     // Called from a button tap: the activity is visible, so the
     // while-in-use location permission counts.
     final result = await FlutterForegroundTask.isRunningService
         ? await FlutterForegroundTask.restartService()
         : await FlutterForegroundTask.startService(
             serviceId: 4242,
             serviceTypes: [ForegroundServiceTypes.location],
             notificationTitle: 'Recording trip',
             notificationText: 'Waiting for GPS fix',
             callback: startLocationTask,
           );
     if (result is ServiceRequestFailure) {
       debugPrint('start failed: ${result.error}');
     }
   }
   ```

   Pass `serviceTypes: [ForegroundServiceTypes.location]` explicitly. Without it, the plugin calls `startForeground` with `FOREGROUND_SERVICE_TYPE_MANIFEST`, which means every type in the manifest attribute, and a stray `dataSync` there pulls in the Android 15 time limit. Wrap your `Scaffold` in `WithForegroundTask` if you want the system back button to minimize the app instead of closing the activity.

5. Decide whether you need "Allow all the time". If tracking only has to survive while the user keeps the trip running, stop here: fine location plus a service started from a visible activity is enough, and it survived both Home and the swipe in my test. If it has to come back on its own after a reboot (`autoRunOnBoot`), after an app update, or after the system kills the process, request background location as a separate, second step. Once fine location is granted, calling `Geolocator.requestPermission()` again asks for `ACCESS_BACKGROUND_LOCATION`, because `geolocator_android` adds it to the request when the manifest declares it and the current status is `whileInUse`. On Android 11+ this sends the user to the system settings page instead of showing a dialog, so explain why before you call it.

## The SecurityException you get without background location

This is the log from the reboot test with only while-in-use location granted, `targetSdkVersion` 36, API 36 emulator:

```text
I ActivityManager: Background started FGS: Allowed [callingPackage: net.startdebugging.tracker; ... code:BOOT_COMPLETED; ... allowWiu:-1; targetSdkVersion:36 ...]
W ActivityManager: Foreground service started from background can not have location/camera/microphone access: service net.startdebugging.tracker/com.pravera.flutter_foreground_task.service.ForegroundService
E ForegroundService: java.lang.SecurityException: Starting FGS with type location callerApp=ProcessRecord{b79ac40 3076:net.startdebugging.tracker/u0a214} targetSDK=36 requires permissions: all of the permissions allOf=true [android.permission.FOREGROUND_SERVICE_LOCATION] any of the permissions allOf=false [android.permission.ACCESS_COARSE_LOCATION, android.permission.ACCESS_FINE_LOCATION]  and the app must be in the eligible state/exemptions to access the foreground only permission
E ForegroundService: 	at android.app.Service.startForeground(Service.java:863)
E ForegroundService: 	at com.pravera.flutter_foreground_task.service.ForegroundService.startForegroundService(ForegroundService.kt:283)
```

Read it in two halves. The first line says the *start* was allowed: `BOOT_COMPLETED` is a background-start exemption, and Android 15 does not block `location` from boot. The rest says the *location access* was not: `allowWiu:-1` means the while-in-use exemption did not apply, so the fine location permission did not count and `startForeground` threw. After `pm grant ... ACCESS_BACKGROUND_LOCATION` and another reboot, the same receiver started the service, `geolocator` logged "position updates started", and the notification showed fresh coordinates.

The message is misleading in one way: it lists `FOREGROUND_SERVICE_LOCATION` and the fine/coarse permissions even when all of them are granted. When you see it, check *where* the service was started from before you check the manifest. If `FOREGROUND_SERVICE_LOCATION` really is missing, you get the exact same text, this time even from a button tap in the foreground.

## Gotchas that cost me time

**The service engine has no Activity.** `geolocator`'s fused client first calls `SettingsClient.checkLocationSettings`. When Google's "Location Accuracy" setting is off, that call needs a resolution dialog, and with no Activity `geolocator_android` reports `locationServicesDisabled` instead. In my first run the task handler received "The location service on the device is disabled." while location was on. Running `getCurrentPosition` with the same settings from the UI before starting the service shows the dialog once. After the user accepts it, the check passes inside the service too. `forceLocationManager: true` avoids Play services entirely if you would rather not depend on that setting.

**`startService` can report success while the service is crash-looping.** With `FOREGROUND_SERVICE_LOCATION` removed, `FlutterForegroundTask.startService` did not return a `ServiceRequestFailure`. The plugin catches the `SecurityException` inside `onStartCommand` and stops the service, then its `allowAutoRestart` logic ("The service will be restarted after 5 seconds because it wasn't properly stopped.") schedules another attempt. That gave 8 identical exceptions in about 25 seconds. Check `adb logcat | grep ForegroundService` after the first start on every new manifest.

**Start only from visible UI or an allowed trigger.** A tap in your app, a notification action, or a widget works. A `Timer` that fires after the user left the app, an FCM data message, or a `WorkManager` job does not start a `location` service unless the app holds background location, and even the start itself needs one of the Android 12 exemptions.

**OEM task killers are a separate problem.** On a Pixel or an emulator, a `location` foreground service with a visible notification survives indefinitely. Some OEM builds still kill it. `FlutterForegroundTask.requestIgnoreBatteryOptimization()` helps on some of them and is itself one of the background-start exemptions. Asking every user for it is a Play policy question, so only request it when your tracker's core purpose depends on it.

**Notifications can be hidden, but the service still runs.** On Android 13+, a denied `POST_NOTIFICATIONS` hides the notification from the shade. The service still starts and still shows up in the Task Manager. Ask for the permission anyway: users who cannot see the notification have no idea why their battery drains.

**Play Console wants two declarations.** Apps targeting Android 14+ must declare each foreground service type in the Play Console with a description and a video. `ACCESS_BACKGROUND_LOCATION` additionally needs the permissions declaration form, a prominent in-app disclosure and a privacy policy. Google's [background location guidance](https://support.google.com/googleplay/android-developer/answer/9799150) says to prefer foreground access where possible. That is one more reason to ship step 5 only if you really need automatic restarts.

**iOS is a different model.** `flutter_foreground_task` on iOS is a `BGTaskScheduler` fetch that runs about 30 seconds every 15 minutes. It is not continuous tracking. On iOS, continuous tracking means `UIBackgroundModes` `location` plus `AppleSettings(allowBackgroundLocationUpdates: true, showBackgroundLocationIndicator: true)` in `geolocator`. Keep the two platforms behind separate code paths.

## Related reading

- If you end up writing the service yourself in Kotlin instead of using a plugin, [adding platform-specific code in Flutter without plugins](/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) covers the channel plumbing.
- Targeting SDK 35 and up changes more than services. See [fixing Flutter UI that overlaps the Android navigation bar after targeting SDK 35](/2026/08/fix-flutter-ui-overlaps-the-android-navigation-bar-after-targeting-sdk-35/).
- For periodic, non-continuous background work, [the background_fetch minSdkVersion fix](/2026/05/fix-flutter-background-fetch-requires-minsdkversion-21/) is a good starting point.

## Sources

- Android Developers: [Foreground service types](https://developer.android.com/develop/background-work/services/fg-service-types) (location type, while-in-use note)
- Android Developers: [Restrictions on starting a foreground service from the background](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)
- Android Developers: [Android 15 behavior changes](https://developer.android.com/about/versions/15/behavior-changes-15) (FGS hardening, `BOOT_COMPLETED` list, `dataSync` timeout)
- Play Console Help: [Foreground service requirements](https://support.google.com/googleplay/android-developer/answer/13392821) and [target API level requirements](https://support.google.com/googleplay/android-developer/answer/11926878)
- [`geolocator` 14.0.3](https://pub.dev/packages/geolocator) and [`geolocator_android` 5.0.3 source](https://github.com/baseflow/flutter-geolocator/tree/main/geolocator_android) (`GeolocatorLocationService`, `StreamHandlerImpl`, `FusedLocationClient`)
- [`flutter_foreground_task` 11.0.3](https://pub.dev/packages/flutter_foreground_task) (`ForegroundService.kt`, `RebootReceiver.kt`)
