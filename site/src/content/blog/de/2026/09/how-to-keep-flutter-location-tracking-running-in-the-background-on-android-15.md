---
title: "Flutter-Standortverfolgung unter Android 15 im Hintergrund am Laufen halten"
description: "Ein Flutter-Standort-Tracker, der unter Android 15 und 16 den Home-Button, das Wegwischen aus den letzten Apps und einen Neustart übersteht: ein Foreground Service vom Typ location in einer eigenen Flutter-Engine, die genauen Berechtigungen und die SecurityException, die auftritt, wenn die While-in-use-Regeln greifen. Getestet mit geolocator 14.0.3 und flutter_foreground_task 11.0.3."
pubDate: 2026-09-22
template: how-to
tags:
  - "flutter"
  - "dart"
  - "android"
  - "location"
  - "foreground-service"
lang: "de"
translationOf: "2026/09/how-to-keep-flutter-location-tracking-running-in-the-background-on-android-15"
translatedBy: "claude"
translationDate: 2026-09-22
---

**Kurze Antwort:** Unter Android 15 (und 16) läuft ein Flutter-Standort-Tracker nur dann weiter, wenn die Standortaktualisierungen von einem **Foreground Service vom Typ `location`** kommen, der **seine eigene Flutter-Engine** betreibt, und nicht von einem Stream in Ihrem UI-Isolate. Deklarieren Sie `FOREGROUND_SERVICE` und `FOREGROUND_SERVICE_LOCATION` sowie `ACCESS_FINE_LOCATION`, geben Sie dem Service `android:foregroundServiceType="location"`, starten Sie ihn per Button-Tipp, während Ihre Activity sichtbar ist, und hören Sie innerhalb dieses Service auf `Geolocator.getPositionStream`. Die eigene `foregroundNotificationConfig` von `geolocator` genügt für "weiter tracken, während die App im Hintergrund ist", stirbt aber, sobald der Nutzer die App wegwischt. Muss der Tracker auch nach einem Neustart des Geräts oder einem Neustart durch das System zurückkommen, muss der Nutzer "Immer zulassen" (`ACCESS_BACKGROUND_LOCATION`) erteilen, sonst wirft Android eine `SecurityException`, sobald der Service `startForeground` aufruft.

Alles Folgende wurde mit Flutter 3.44.8 (standardmäßig `targetSdkVersion` 36), `geolocator` 14.0.3 (`geolocator_android` 5.0.3) und `flutter_foreground_task` 11.0.3 gebaut und auf einem Android-16-Emulator (API 36) ausgeführt. Android 16 setzt jede hier beschriebene Foreground-Service-Regel aus Android 14 und Android 15 durch, und da Google Play ab dem 2026-08-31 für neue Apps und Updates `targetSdkVersion` 36 verlangt, gelten diese Regeln für Ihre App unabhängig davon, welche Android-Version Ihre Nutzer haben.

## Was Android 15 tatsächlich geändert hat und was nicht

Die meisten Meldungen der Art "mein Tracker stoppt unter Android 15" werden nicht von Android 15 selbst verursacht. Die Regeln, die Standort-Tracker beenden, sind älter:

- **Android 12 (API 31)** verbietet das Starten eines Foreground Service, während die App im Hintergrund ist, abgesehen von einer Liste von [Ausnahmen](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start) (Boot, ein Tipp auf eine Benachrichtigung, ein exakter Alarm und so weiter).
- **Android 14 (API 34)** verlangt, dass jeder Foreground Service einen [Typ](https://developer.android.com/develop/background-work/services/fg-service-types) deklariert und die passende Berechtigung besitzt. Für `location` ist das `FOREGROUND_SERVICE_LOCATION`, plus eine erteilte `ACCESS_COARSE_LOCATION` oder `ACCESS_FINE_LOCATION` in dem Moment, in dem der Service in den Vordergrund wechselt.
- **While-in-use-Berechtigungen**: Genauer und ungefährer Standort zählen nur, solange Ihre App sichtbar ist. Ein aus dem Hintergrund gestarteter `location`-Service schlägt fehl, sofern die App nicht `ACCESS_BACKGROUND_LOCATION` besitzt, selbst wenn der Start selbst unter eine der erlaubten Ausnahmen fällt.

Was [Android 15](https://developer.android.com/about/versions/15/behavior-changes-15) hinzugefügt hat, ist ein tägliches Limit von 6 Stunden für `dataSync`- und `mediaProcessing`-Services, eine Liste von Typen, die ein `BOOT_COMPLETED`-Receiver nicht mehr starten darf (`dataSync`, `camera`, `mediaPlayback`, `phoneCall`, `mediaProjection` sowie `microphone` seit Android 14), und eine strengere `SYSTEM_ALERT_WINDOW`-Ausnahme. `location` steht auf keiner der beiden Listen. Das ist wichtig, weil viel Flutter-Tracking-Code ein `flutter_foreground_task`-Beispiel kopiert, das `dataSync` deklariert. Unter Android 15 wird dieser Tracker nach 6 Stunden beendet und kann nach einem Neustart nicht mehr zurückkommen. Der korrekte Typ behebt beide Probleme.

## Warum der Stream in Ihrem Widget stoppt

Der naive Tracker ist eine `StreamSubscription<Position>` in einem `State`-Objekt. Seine Callbacks laufen im UI-Isolate der Flutter-Engine, die zu Ihrer `FlutterActivity` gehört. Wenn Android entscheidet, dass dieser Prozess untätig ist, oder der Nutzer die App aus den letzten Apps wischt, verschwindet diese Engine und mit ihr Ihr Dart-Code. Keine Foreground-Benachrichtigung kann Code in einer Engine am Laufen halten, die nicht mehr existiert.

`geolocator` bietet dafür einen halben Schritt. Übergeben Sie `AndroidSettings` mit einer `foregroundNotificationConfig`, und `geolocator_android` stuft seinen eigenen `GeolocatorLocationService` zu einem Foreground Service hoch:

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

Das eigene Manifest des Plugins deklariert diesen Service bereits mit `android:foregroundServiceType="location"`. Aber `GeolocatorPlugin` verbindet sich über `bindService` mit ihm, nie über `startService`, und löst die Bindung, wenn sich die Engine trennt. Der Doc-Kommentar des Plugins sagt das auch: Die Benachrichtigung "does not run your service in the background". Ich habe es auf dem API-36-Emulator gemessen:

| Szenario | `geolocator` mit `foregroundNotificationConfig` | `flutter_foreground_task`-Service + `geolocator` darin |
| --- | --- | --- |
| App sichtbar | Positionen geliefert | Positionen geliefert |
| Home-Button gedrückt | Positionen geliefert, FGS-Typ `0x8` | Positionen geliefert, FGS-Typ `0x8` |
| Aus den letzten Apps gewischt | Service zerstört, keine Positionen mehr | Derselbe Prozess läuft weiter, Positionen geliefert |
| Neustart, nur While-in-use | n/a | `SecurityException` bei `startForeground` |
| Neustart, "Immer zulassen" | n/a | Service neu gestartet, Positionen geliefert |

Nach dem Wischen endete das Log der reinen geolocator-Variante mit "Unbinding from location service" und "Destroying location service". Im anderen Build blieb die Engine des Service verbunden ("There is still another flutter engine connected, not stopping location service"), und die Benachrichtigung zeigte weiterhin neue Koordinaten an.

`foregroundNotificationConfig` ist also das richtige Werkzeug, wenn "Hintergrund" bedeutet "der Nutzer ist während einer Tour eine Weile zu einer anderen App gewechselt". Für einen Fahrtenrecorder, einen Liefer-Tracker oder eine Fitness-App, die weiterlaufen muss, bis der Nutzer auf Stopp drückt, müssen die Aktualisierungen in einem Service leben, der seine eigene Engine besitzt.

## Den Tracker in einer separaten Service-Engine bauen

`flutter_foreground_task` startet einen echten, gestarteten (nicht nur gebundenen) Foreground Service, fährt darin eine zweite Flutter-Engine hoch und ruft dort einen Top-Level-Einstiegspunkt in Dart auf. Aus dieser Engine heraus können Sie jedes Plugin verwenden, auch `geolocator`. Die Schritte:

1. Fügen Sie die Pakete hinzu.

   ```yaml
   # pubspec.yaml -- Flutter 3.44.8
   dependencies:
     geolocator: ^14.0.3
     flutter_foreground_task: ^11.0.3
   ```

   `flutter_foreground_task` 11.x benötigt Flutter 3.44+, Kotlin 2.2.20+ und Gradle 8.11.1+. Ein mit Flutter 3.44.8 erstelltes Projekt verwendet bereits AGP 9.0.1, Kotlin 2.3.20 und Gradle 9.1.0. Ist Ihres älter, lesen Sie zuerst [die Migration eines Flutter-Android-Projekts auf AGP 9 mit integriertem Kotlin](/de/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/).

2. Deklarieren Sie die Berechtigungen und den Service in `android/app/src/main/AndroidManifest.xml`.

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

   Benennen Sie den Service nicht um: Das Plugin startet ihn über diesen Klassennamen. `FOREGROUND_SERVICE`, `WAKE_LOCK`, `RECEIVE_BOOT_COMPLETED` und `POST_NOTIFICATIONS` kommen außerdem aus dem eigenen Manifest des Plugins. `FOREGROUND_SERVICE_LOCATION` kommt aus keinem der beiden Plugins, Sie müssen es also selbst hinzufügen. `aapt2 dump xmltree` auf dem gebauten APK zeigt beide Services, den des Plugins und den von geolocator, mit `foregroundServiceType=0x00000008` (location).

3. Schreiben Sie den Task-Handler, der in der Service-Engine läuft.

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

   `@pragma('vm:entry-point')` ist nicht optional. In Release-Builds entfernt der Tree Shaker sonst eine Funktion, die nur von nativem Code aufgerufen wird. Speichern Sie Positionen hier (in SQLite, eine Datei oder einen HTTP-Batch), statt sich auf `sendDataToMain` zu verlassen: Nach einem Wischen oder einem Neustart hört kein UI-Isolate mehr zu. Kündigen Sie das Abonnement in `onDestroy`, aus denselben Gründen, die unter [eine StreamSubscription in dispose kündigen](/de/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/) behandelt werden.

4. Fragen Sie die Berechtigungen an, klären Sie die Standorteinstellungen und starten Sie den Service aus der UI.

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

   Übergeben Sie `serviceTypes: [ForegroundServiceTypes.location]` explizit. Ohne diese Angabe ruft das Plugin `startForeground` mit `FOREGROUND_SERVICE_TYPE_MANIFEST` auf, was jeden Typ im Manifest-Attribut bedeutet, und ein verirrtes `dataSync` dort zieht das Zeitlimit von Android 15 mit hinein. Umschließen Sie Ihr `Scaffold` mit `WithForegroundTask`, wenn die System-Zurück-Taste die App minimieren soll, statt die Activity zu schließen.

5. Entscheiden Sie, ob Sie "Immer zulassen" brauchen. Muss das Tracking nur so lange überleben, wie der Nutzer die Tour laufen lässt, hören Sie hier auf: Genauer Standort plus ein aus einer sichtbaren Activity gestarteter Service genügt, und in meinem Test überstand das sowohl Home als auch das Wegwischen. Muss es nach einem Neustart (`autoRunOnBoot`), nach einem App-Update oder nachdem das System den Prozess beendet hat, von selbst zurückkommen, fordern Sie den Hintergrundstandort als separaten, zweiten Schritt an. Sobald der genaue Standort erteilt ist, fragt ein erneuter Aufruf von `Geolocator.requestPermission()` nach `ACCESS_BACKGROUND_LOCATION`, weil `geolocator_android` die Berechtigung der Anfrage hinzufügt, wenn das Manifest sie deklariert und der aktuelle Status `whileInUse` ist. Ab Android 11 schickt das den Nutzer auf die Seite der Systemeinstellungen, statt einen Dialog anzuzeigen, erklären Sie also vor dem Aufruf, warum.

## Die SecurityException ohne Hintergrundstandort

Dies ist das Log aus dem Neustart-Test, bei dem nur der While-in-use-Standort erteilt war, `targetSdkVersion` 36, API-36-Emulator:

```text
I ActivityManager: Background started FGS: Allowed [callingPackage: net.startdebugging.tracker; ... code:BOOT_COMPLETED; ... allowWiu:-1; targetSdkVersion:36 ...]
W ActivityManager: Foreground service started from background can not have location/camera/microphone access: service net.startdebugging.tracker/com.pravera.flutter_foreground_task.service.ForegroundService
E ForegroundService: java.lang.SecurityException: Starting FGS with type location callerApp=ProcessRecord{b79ac40 3076:net.startdebugging.tracker/u0a214} targetSDK=36 requires permissions: all of the permissions allOf=true [android.permission.FOREGROUND_SERVICE_LOCATION] any of the permissions allOf=false [android.permission.ACCESS_COARSE_LOCATION, android.permission.ACCESS_FINE_LOCATION]  and the app must be in the eligible state/exemptions to access the foreground only permission
E ForegroundService: 	at android.app.Service.startForeground(Service.java:863)
E ForegroundService: 	at com.pravera.flutter_foreground_task.service.ForegroundService.startForegroundService(ForegroundService.kt:283)
```

Lesen Sie es in zwei Hälften. Die erste Zeile sagt, dass der *Start* erlaubt war: `BOOT_COMPLETED` ist eine Ausnahme für Starts aus dem Hintergrund, und Android 15 blockiert `location` beim Boot nicht. Der Rest sagt, dass der *Standortzugriff* nicht erlaubt war: `allowWiu:-1` bedeutet, dass die While-in-use-Ausnahme nicht griff, die Berechtigung für den genauen Standort also nicht zählte und `startForeground` eine Exception warf. Nach `pm grant ... ACCESS_BACKGROUND_LOCATION` und einem weiteren Neustart startete derselbe Receiver den Service, `geolocator` protokollierte "position updates started", und die Benachrichtigung zeigte frische Koordinaten.

Die Meldung ist in einer Hinsicht irreführend: Sie listet `FOREGROUND_SERVICE_LOCATION` und die Berechtigungen für genauen und ungefähren Standort auch dann auf, wenn alle erteilt sind. Wenn Sie sie sehen, prüfen Sie zuerst, *von wo* der Service gestartet wurde, bevor Sie das Manifest prüfen. Fehlt `FOREGROUND_SERVICE_LOCATION` tatsächlich, erhalten Sie exakt denselben Text, diesmal sogar bei einem Button-Tipp im Vordergrund.

## Stolperfallen, die mich Zeit gekostet haben

**Die Service-Engine hat keine Activity.** Der Fused Client von `geolocator` ruft zuerst `SettingsClient.checkLocationSettings` auf. Ist Googles Einstellung "Standortgenauigkeit" ausgeschaltet, braucht dieser Aufruf einen Auflösungsdialog, und ohne Activity meldet `geolocator_android` stattdessen `locationServicesDisabled`. In meinem ersten Durchlauf erhielt der Task-Handler "The location service on the device is disabled.", obwohl der Standort eingeschaltet war. Wenn Sie `getCurrentPosition` mit denselben Einstellungen vor dem Start des Service aus der UI ausführen, erscheint der Dialog einmal. Nachdem der Nutzer ihn akzeptiert hat, besteht die Prüfung auch innerhalb des Service. `forceLocationManager: true` umgeht die Play-Dienste vollständig, falls Sie nicht von dieser Einstellung abhängen möchten.

**`startService` kann Erfolg melden, während der Service in einer Absturzschleife steckt.** Mit entferntem `FOREGROUND_SERVICE_LOCATION` gab `FlutterForegroundTask.startService` kein `ServiceRequestFailure` zurück. Das Plugin fängt die `SecurityException` in `onStartCommand` ab und stoppt den Service, dann plant seine `allowAutoRestart`-Logik ("The service will be restarted after 5 seconds because it wasn't properly stopped.") einen weiteren Versuch. Das ergab 8 identische Exceptions in etwa 25 Sekunden. Prüfen Sie `adb logcat | grep ForegroundService` nach dem ersten Start bei jedem neuen Manifest.

**Starten Sie nur aus sichtbarer UI oder über einen erlaubten Auslöser.** Ein Tipp in Ihrer App, eine Benachrichtigungsaktion oder ein Widget funktioniert. Ein `Timer`, der feuert, nachdem der Nutzer die App verlassen hat, eine FCM-Datennachricht oder ein `WorkManager`-Job starten keinen `location`-Service, sofern die App keinen Hintergrundstandort besitzt, und selbst der Start an sich braucht eine der Ausnahmen aus Android 12.

**OEM-Task-Killer sind ein eigenes Problem.** Auf einem Pixel oder einem Emulator überlebt ein `location`-Foreground-Service mit sichtbarer Benachrichtigung unbegrenzt. Manche OEM-Builds beenden ihn trotzdem. `FlutterForegroundTask.requestIgnoreBatteryOptimization()` hilft bei einigen davon und ist selbst eine der Ausnahmen für Starts aus dem Hintergrund. Jeden Nutzer danach zu fragen, ist eine Frage der Play-Richtlinien, fordern Sie es also nur an, wenn der Kernzweck Ihres Trackers davon abhängt.

**Benachrichtigungen können ausgeblendet sein, der Service läuft trotzdem.** Ab Android 13 blendet ein verweigertes `POST_NOTIFICATIONS` die Benachrichtigung aus der Leiste aus. Der Service startet dennoch und erscheint weiterhin im Task-Manager. Fragen Sie die Berechtigung trotzdem an: Nutzer, die die Benachrichtigung nicht sehen, haben keine Ahnung, warum ihr Akku leer wird.

**Die Play Console will zwei Deklarationen.** Apps, die auf Android 14+ abzielen, müssen jeden Foreground-Service-Typ in der Play Console mit einer Beschreibung und einem Video deklarieren. `ACCESS_BACKGROUND_LOCATION` braucht zusätzlich das Formular zur Berechtigungsdeklaration, einen gut sichtbaren Hinweis in der App und eine Datenschutzerklärung. Googles [Leitfaden zum Hintergrundstandort](https://support.google.com/googleplay/android-developer/answer/9799150) empfiehlt, wo möglich den Zugriff im Vordergrund zu bevorzugen. Ein Grund mehr, Schritt 5 nur auszuliefern, wenn Sie automatische Neustarts wirklich brauchen.

**iOS folgt einem anderen Modell.** `flutter_foreground_task` ist unter iOS ein `BGTaskScheduler`-Fetch, der etwa 30 Sekunden alle 15 Minuten läuft. Das ist kein kontinuierliches Tracking. Unter iOS bedeutet kontinuierliches Tracking `UIBackgroundModes` `location` plus `AppleSettings(allowBackgroundLocationUpdates: true, showBackgroundLocationIndicator: true)` in `geolocator`. Halten Sie die beiden Plattformen in getrennten Codepfaden.

## Weiterführende Artikel

- Wenn Sie den Service am Ende selbst in Kotlin schreiben, statt ein Plugin zu verwenden, behandelt [plattformspezifischen Code in Flutter ohne Plugins hinzufügen](/de/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) die Channel-Anbindung.
- Das Targeting von SDK 35 und höher ändert mehr als nur Services. Siehe [Flutter-UI korrigieren, die nach dem Targeting von SDK 35 die Android-Navigationsleiste überlappt](/de/2026/08/fix-flutter-ui-overlaps-the-android-navigation-bar-after-targeting-sdk-35/).
- Für periodische, nicht kontinuierliche Hintergrundarbeit ist [der minSdkVersion-Fix für background_fetch](/de/2026/05/fix-flutter-background-fetch-requires-minsdkversion-21/) ein guter Ausgangspunkt.

## Quellen

- Android Developers: [Foreground service types](https://developer.android.com/develop/background-work/services/fg-service-types) (Typ location, Hinweis zu While-in-use)
- Android Developers: [Restrictions on starting a foreground service from the background](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)
- Android Developers: [Android 15 behavior changes](https://developer.android.com/about/versions/15/behavior-changes-15) (FGS-Härtung, `BOOT_COMPLETED`-Liste, `dataSync`-Timeout)
- Play Console Help: [Foreground service requirements](https://support.google.com/googleplay/android-developer/answer/13392821) und [target API level requirements](https://support.google.com/googleplay/android-developer/answer/11926878)
- [`geolocator` 14.0.3](https://pub.dev/packages/geolocator) und [`geolocator_android` 5.0.3 Quellcode](https://github.com/baseflow/flutter-geolocator/tree/main/geolocator_android) (`GeolocatorLocationService`, `StreamHandlerImpl`, `FusedLocationClient`)
- [`flutter_foreground_task` 11.0.3](https://pub.dev/packages/flutter_foreground_task) (`ForegroundService.kt`, `RebootReceiver.kt`)
