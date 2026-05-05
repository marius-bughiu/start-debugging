---
title: "Plattformspezifischen Code in Flutter ohne Plugins hinzufügen"
description: "Nativen Android- (Kotlin) und iOS-Code (Swift) aus einer Flutter-3.x-App aufrufen, ohne ein Plugin zu schreiben: MethodChannel, EventChannel, BasicMessageChannel, die Typtabelle des StandardMessageCodec, Threading-Regeln und die Fälle, in denen sich ein Plugin trotzdem lohnt."
pubDate: 2026-05-05
template: how-to
tags:
  - "flutter"
  - "dart"
  - "android"
  - "ios"
  - "platform-channels"
  - "how-to"
lang: "de"
translationOf: "2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins"
translatedBy: "claude"
translationDate: 2026-05-05
---

Kurzantwort: Legen Sie einen `MethodChannel` in Ihrer `main.dart` an, registrieren Sie denselben Kanalnamen im Android-`FlutterActivity` und im iOS-`AppDelegate`, und rufen Sie ihn mit `await channel.invokeMethod(...)` auf. Verwenden Sie `EventChannel` für Streams von nativ zu Dart (Sensoren, Broadcasts) und `BasicMessageChannel` für rohe Bytes oder Strings. Ein föderiertes Plugin brauchen Sie erst, wenn Sie die Integration über mehrere Apps hinweg wiederverwenden oder auf pub.dev veröffentlichen wollen. Getestet mit Flutter 3.27.1, Android Gradle Plugin 8.7.3 und Xcode 16.2 (Swift 5.10).

Der Begriff "plattformspezifischer Code" bedeutet in der Flutter-Doku üblicherweise eine Sache: einen Method Channel, der die Dart-nativ-Grenze überquert. Diese Brücke existiert in jeder Flutter-App, mit oder ohne Plugin. Ein Plugin ist nur ein verpackter Kanal mit einer Dart-Fassade und einer Build-Zeit-Registrierung in zwei `Podfile`- / Gradle-Dateien. Wenn Sie die Integration nur in einer App brauchen, ist das Verpacken Overhead. Dieser Beitrag zeigt, wie Sie das überspringen und den Code dennoch wartbar halten.

## Warum das Plugin-Gerüst überspringen

`flutter create --template plugin` erzeugt ein föderiertes Plugin: `my_plugin`, `my_plugin_android`, `my_plugin_ios`, `my_plugin_platform_interface`, plus eine Beispiel-App. Das ist die richtige Form, wenn mehrere Apps die Integration teilen oder Sie sie veröffentlichen wollen. Für eine einzige App kostet sie:

- Sechs zusätzliche `pubspec.yaml`-Dateien und eine `melos.yaml`, falls Sie One-Shot-CI wollen.
- Ein Platform Interface, das pro Methode eine Indirektion ergänzt.
- Eine separate Paketversion, die Sie hochziehen müssen, sobald Ihr App-Code eine neue native Methode aufrufen soll.
- Eine zweite Test-Umgebung (das `example/`-App des Plugins), die sich von Ihrer echten App entfernt.

In einer Single-App-Codebasis kann der Kanal neben dem Feature liegen, das ihn nutzt. Ein Knopf, der den Taschenlampenzustand umschaltet, und ein `FlashlightService`, der den Kanal kapselt, sind zwanzig Zeilen Dart und zwanzig Zeilen Kotlin / Swift.

## Die drei Kanäle, die Sie tatsächlich brauchen

Flutter liefert drei Kanaltypen in `package:flutter/services.dart`. Wählen Sie nach Aufrufform, nicht nach Feature.

- `MethodChannel`: Anfrage / Antwort. Dart ruft eine benannte Methode auf der nativen Seite auf, wartet auf ein Ergebnis, die native Seite kann einen typisierten Fehler werfen. Geeignet für "Dateiauswahl öffnen", "Gerätemodell auslesen", "200 ms vibrieren".
- `EventChannel`: Push-Stream von nativ nach Dart. Die native Seite öffnet einen `StreamSink`; Dart abonniert und hört zu. Geeignet für Sensoren, System-Broadcast-Receiver (Ladezustand, Netzwerkwechsel), oder jedes Callback, das Ihnen das Betriebssystem reicht.
- `BasicMessageChannel`: rohe, untypisierte Nachrichten mit einem Codec Ihrer Wahl (`StandardMessageCodec`, `JSONMessageCodec`, `StringCodec`, `BinaryCodec`). Geeignet, wenn Sie beide Enden kontrollieren und den Methodennamen-Overhead vermeiden wollen, oder wenn Sie Bytes verschicken (Audio-Frames, Bildpuffer).

Alle drei sind auf der Dart-Seite asynchron. Alle drei serialisieren ihre Nutzlast über einen `MessageCodec`. Der Standard-Codec ist `StandardMessageCodec`, der einen kleinen festen Satz an Typen versteht. Wenn Ihre Nutzlast nicht in diesen Satz passt, serialisieren Sie selbst.

## Typtabelle des StandardMessageCodec

Diese Tabelle sollten Sie offen halten, während Sie Kanal-Code schreiben. Alles außerhalb landet je nach Plattform als `null` oder wirft eine Exception.

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

`DateTime`, eigene Klassen und `BigInt` stehen nicht auf der Liste. Konvertieren Sie an der Grenze zu `int` (Epoch ms), `Map` oder `String`.

## Vollständiges MethodChannel-Beispiel: Akkustand

Das ist das kanonische Flutter-Beispiel, erweitert um die Dateistruktur, die Sie tatsächlich ausliefern würden.

### 1. Dart-Seite (`lib/services/battery_service.dart`)

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

Drei Punkte sind erwähnenswert. Erstens: Der Kanalname ist Reverse-DNS plus Feature-Suffix; das ist die Konvention jedes Flutter-Plugins und vermeidet Kollisionen mit zukünftigen Paketen. Zweitens: `invokeMethod<int>` ist generisch und liefert ein Compile-Time-Signal darüber, was der Codec zurückgeben muss. Drittens: `MissingPluginException` wird geworfen, wenn der Kanalname auf der laufenden Plattform nicht registriert ist. Fangen Sie sie und wandeln Sie sie in einen sinnvollen Fehler um, sonst bekommt der Nutzer einen Stack Trace aus `package:flutter`.

### 2. Android-Seite (`android/app/src/main/kotlin/.../MainActivity.kt`)

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

`configureFlutterEngine` läuft einmal pro Engine, nicht einmal pro Activity-Recreation, also ist das der sichere Ort, um den Handler anzuhängen. Registrieren Sie den Kanal nicht in `onCreate`, wenn Ihre `MainActivity` von `FlutterFragmentActivity` erbt, sonst leaken Sie Handler bei Konfigurationsänderungen.

### 3. iOS-Seite (`ios/Runner/AppDelegate.swift`)

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

Drei plattformspezifische Punkte. Erstens muss `isBatteryMonitoringEnabled` auf `true` stehen, bevor Sie `batteryLevel` lesen, sonst erhalten Sie `-1.0`. Zweitens ist `FlutterError` das iOS-Pendant zu `result.error(...)` auf Android; in Dart erscheint es als `PlatformException`. Drittens bleibt `GeneratedPluginRegistrant.register(with: self)` stehen, obwohl Sie kein Plugin geschrieben haben: Der Build emittiert weiterhin einen Registranten für jedes transitive Plugin in `pubspec.yaml`.

## EventChannel für Streams

`MethodChannel` ist falsch für "sag mir, wann sich der Akkuzustand ändert". Sie würden Polling betreiben. `EventChannel` lässt die native Seite pushen.

### Dart-Subscriber

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

`receiveBroadcastStream()` liefert einen einzelnen Broadcast-Stream, den sich alle Listener teilen. Das Abbestellen des letzten Abonnements teilt der nativen Seite mit, ihren Broadcast-Receiver bzw. Observer abzubauen, also halten Sie keine Referenz auf ein Abonnement, das Sie nicht nutzen.

### Android-Handler

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

Hängen Sie ihn in `configureFlutterEngine` an:

```kotlin
EventChannel(flutterEngine.dartExecutor.binaryMessenger, "com.example.app/battery_state")
    .setStreamHandler(BatteryStateStreamHandler(applicationContext))
```

Verwenden Sie `applicationContext`, nicht die Activity, sonst leaken Sie die Activity für die gesamte Lebensdauer des Broadcast-Receivers.

### iOS-Handler

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

Und im `AppDelegate`:

```swift
let stateChannel = FlutterEventChannel(
    name: "com.example.app/battery_state",
    binaryMessenger: controller.binaryMessenger
)
stateChannel.setStreamHandler(BatteryStateStreamHandler())
```

Schicken Sie in `onListen` einen Initialwert, damit das erste `await for (final s in service.watch())` nicht auf den ersten OS-Broadcast wartet.

## BasicMessageChannel für rohe Nutzlasten

`BasicMessageChannel` überspringt den Methodennamen-Dispatcher und verwendet den Codec, den Sie ihm geben. Nützlich, wenn beide Seiten Ihnen gehören und die Nutzlast einheitlich ist.

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

Für Binärnutzlasten verwenden Sie `BinaryCodec` auf beiden Seiten und erhalten `ByteData` in Dart, `ByteBuffer` in Kotlin, `FlutterStandardTypedData` in Swift.

## Threading-Modell und die Fallstricke

Der Kanal selbst ist asynchron, aber das Handler-Callback läuft auf dem Plattform-Thread, nicht auf einem Hintergrund-Thread.

- **Android**: Handler laufen auf dem Android-Main-Thread. Lange Arbeit blockiert den UI-Thread und löst ein ANR aus. Verlagern Sie die Arbeit in eine Coroutine oder einen `Executors.newSingleThreadExecutor()` und rufen Sie `result.success(...)` dann zurück auf dem Main-Thread auf (`Handler(Looper.getMainLooper()).post { ... }`).
- **iOS**: Handler laufen auf der Main-`DispatchQueue`. Gleiche Regel: Arbeit auf einer Hintergrundwarteschlange erledigen, den `result(...)`-Aufruf auf den Main-Thread zurück dispatchen.
- **Hintergrund-Isolates**: `MethodChannel` erforderte historisch das Root-Isolate. Ab Flutter 3.7+ können Sie aus einem Hintergrund-Isolate einen eigenen `binaryMessenger` mittels `BackgroundIsolateBinaryMessenger.ensureInitialized(token)` übergeben, aber nur für Kanäle, die Sie selbst erzeugen, und nur für Codecs, die keinen isolate-lokalen Zustand einfangen.
- **Hot Restart**: Hot Restart führt `main()` erneut aus, aber nicht `configureFlutterEngine`. Handler, die in `configureFlutterEngine` registriert sind, überleben einen Hot Restart, was Sie wollen. Handler, die im `initState` eines Flutter-Widgets registriert werden, hingegen nicht, weil die Engine die vorherige Registrierung behält und Sie am Ende zwei Handler haben.

Die Falle "zwei Handler" ist die häufigste Ursache für `MissingPluginException` nach einem Hot Reload: Jemand hat den Handler aus einem Widget registriert, das Widget wurde neu gebaut, der alte Handler ist noch da, der neue streitet sich um den Kanal. Registrieren Sie Kanäle genau einmal, in `MainActivity.configureFlutterEngine` oder `AppDelegate.application(_:didFinishLaunchingWithOptions:)`.

## Fehler, Typen und Codecs in der Praxis

Drei Regeln halten Kanal-Code langweilig:

1. **Typisieren Sie immer die Dart-Seite**: `invokeMethod<int>`, `invokeMethod<String>`, `invokeMethod<Map<Object?, Object?>>`. Der Codec ist zur Laufzeit dynamisch; Sie wollen die statische Prüfung.
2. **Senden Sie immer `result.error(code, message, details)` von nativ**: `code` wird zu `PlatformException.code`, und genau darauf macht Ihr Dart-Code das Switch. Werfen Sie nie aus dem Handler heraus; `MethodChannel` kann eine Kotlin-Exception nicht in eine `PlatformException` verwandeln, es sei denn, Sie wickeln sie ein.
3. **Konvertieren Sie an der Grenze**: Schicken Sie keine `Map<String, Object>` mit gemischten Typen und parsen Sie sie auf der anderen Seite. Definieren Sie ein kleines DTO (`{level: int, charging: bool}`) und schreiben Sie auf jeder Seite einen `fromMap`-Konstruktor. Wächst das DTO über vier Felder hinaus, verwenden Sie [Pigeon](https://pub.dev/packages/pigeon), um das Marshalling zu generieren, aber die Kanäle selbst bleiben Ihnen.

## Wann ein Plugin trotzdem gewinnt

Verzichten Sie auf das Plugin, bis eines davon zutrifft:

- Sie wollen auf pub.dev veröffentlichen. Plugins haben einen festen Vertrag für das Platform Interface.
- Dieselbe Integration wird in drei oder mehr Apps gebraucht. Bei der dritten Kopie unterschreiten die Kosten eines privaten Pakets die Kosten dafür, die Kanäle synchron zu halten.
- Sie brauchen Conditional Imports für `web`, `windows` oder `linux`, damit der Dart-Code nicht versucht, eine nicht existierende native Seite anzurufen. Das föderierte Plugin-Muster löst das mit einer leeren Default-Implementierung; in einer einzelnen App replizieren Sie dieselbe Idee von Hand mit einer Stub-Klasse.
- Sie müssen mehrere Kanäle registrieren und wollen sie verzögert anhängen. `FlutterPlugin.onAttachedToEngine` ist der unterstützte Lifecycle-Hook; eine eigene Lösung lässt sich auf Android leicht falsch machen, sobald Sie Activity-Attach- / -Detach-Ereignisse behandeln.

Für den Long Tail (ein Kanal, eine App, ein Plattformpaar) ist der oben gezeigte Inline-Ansatz das, was produktive Flutter-Codebasen tatsächlich machen.

## Verwandte Artikel

- Die [Lösung zu MissingPluginException 'No implementation found for method getAll'](/de/2023/10/how-to-fix-missingpluginexception-no-implementation-found-for-method-getall/) deckt ab, was zu tun ist, wenn ein registrierter Kanal in Release-Builds trotzdem wirft (ProGuard, Plugin-Registrierung, Hot Restart).
- Für ein Multi-Versions-CI-Setup, das Ihren Kanal-Code gegen mehrere Flutter-SDKs ausführt, siehe [mehrere Flutter-Versionen aus einer CI-Pipeline ansprechen](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).
- Liegt Ihr Plattform-Code auf der .NET-Seite und ist die Integration MAUI statt Flutter, zeigt der [Leitfaden zu MAUI nur für Windows und macOS](/de/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) das Pendant über Target-Framework-Gating.

## Quellen

- Flutter-Dokumentation, [Writing custom platform-specific code](https://docs.flutter.dev/platform-integration/platform-channels).
- Flutter API-Referenz, [MethodChannel](https://api.flutter.dev/flutter/services/MethodChannel-class.html), [EventChannel](https://api.flutter.dev/flutter/services/EventChannel-class.html), [BasicMessageChannel](https://api.flutter.dev/flutter/services/BasicMessageChannel-class.html).
- Flutter API-Referenz, [StandardMessageCodec](https://api.flutter.dev/flutter/services/StandardMessageCodec-class.html) für die Tabelle der unterstützten Typen.
- Android-Dokumentation, [BatteryManager](https://developer.android.com/reference/android/os/BatteryManager).
- Apple-Dokumentation, [UIDevice batteryLevel](https://developer.apple.com/documentation/uikit/uidevice/1620042-batterylevel).
- Flutter Background-Isolate-Channels, [BackgroundIsolateBinaryMessenger](https://api.flutter.dev/flutter/services/BackgroundIsolateBinaryMessenger-class.html) (Flutter 3.7+).
