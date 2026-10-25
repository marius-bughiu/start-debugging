---
title: "Bildschirmausrichtung für einen einzelnen Screen in Flutter sperren (und warum iPad-Multitasking sie ignoriert)"
description: "Sperren Sie eine Flutter-Route mit SystemChrome.setPreferredOrientations auf Quer- oder Hochformat, ohne den Rest der App zu stören: eine stapelbasierte Sperre, die pushReplacement übersteht und beim Pop zurückgesetzt wird, warum die leere Liste das falsche Zurücksetzen ist, warum iPad-Multitasking und große Android-16-Bildschirme die Sperre ignorieren und was UIRequiresFullScreen nach iPadOS 26 und dem iOS-27-SDK bedeutet. Getestet mit Flutter 3.47.8, Dart 3.13.7 und Xcode 27.1."
pubDate: 2026-10-25
template: how-to
tags:
  - "flutter"
  - "dart"
  - "ios"
  - "android"
  - "how-to"
lang: "de"
translationOf: "2026/10/how-to-lock-screen-orientation-for-a-single-screen-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-25
---

Um einen Screen in Flutter zu sperren, rufen Sie `SystemChrome.setPreferredOrientations` auf, sobald die Route erscheint, und stellen die normalen Ausrichtungen der App wieder her, wenn die Route verlassen wird. Schreiben Sie nicht die naive Variante, bei der `initState` auf Querformat setzt und `dispose` auf Hochformat zurücksetzt. In einem Widget-Test mit Flutter 3.47.8 (Dart 3.13.7) stellt diese Variante das Hochformat erst wieder her, nachdem die Pop-Animation beendet ist. Schlimmer noch: `pushReplacement` zwischen zwei gesperrten Screens lässt den neuen Screen im Hochformat zurück. Verwenden Sie die kleine stapelbasierte Sperre unten und geben Sie sie in `PopScope.onPopInvokedWithResult` frei. Selbst dann ist die Sperre nur eine Anfrage und keine Garantie. iPadOS ignoriert sie, solange die App Multitasking unterstützt (Split View, Slide Over und das Fenstersystem von iPadOS 26). Android 16 ignoriert sie auf Displays ab 600 dp Breite, sobald Sie API 36 anvisieren, und Flutter 3.47.8 visiert standardmäßig API 36 an. Der alte iPad-Ausweg `UIRequiresFullScreen` ist seit iPadOS 26 veraltet und verhindert das Anpassen der Fenstergröße nicht mehr, wenn Sie mit dem iOS-27-SDK kompilieren.

## Was setPreferredOrientations auf jeder Plattform tatsächlich bewirkt

`SystemChrome.setPreferredOrientations(List<DeviceOrientation>)` ist ein einzelner Platform-Channel-Aufruf, `SystemChrome.setPreferredOrientations`, der eine Liste von Enum-Namen übermittelt. Er verändert einen App-weiten Zustand. Nichts daran ist auf ein Widget oder eine Route begrenzt. Was zuletzt gesetzt wurde, bleibt in Kraft, bis etwas anderes es erneut setzt. Das gilt auch für einen Hot Restart, weil die Einstellung im nativen View Controller bzw. in der Activity liegt und nicht in Dart.

Die Plattformen behandeln sie unterschiedlich, und diese Unterschiede zählen, sobald Sie eine Sperre "rückgängig machen" wollen:

- **Android**: Die `PlatformChannel.decodeOrientations` der Engine wandelt die Liste in eine Bitmaske um, ordnet sie einer `ActivityInfo.SCREEN_ORIENTATION_*`-Konstante zu und ruft `activity.setRequestedOrientation(...)` auf. `[portraitUp]` wird zu `SCREEN_ORIENTATION_PORTRAIT`, `[landscapeLeft, landscapeRight]` zu `SCREEN_ORIENTATION_USER_LANDSCAPE` und die leere Liste zu `SCREEN_ORIENTATION_UNSPECIFIED`. Eine Anfrage zur Laufzeit überschreibt das Attribut `android:screenOrientation` in Ihrem Manifest. Steht im Manifest also `portrait` und Sie setzen mit `[]` zurück, kann sich die Activity danach frei drehen.
- **iOS**: `FlutterPlatformPlugin` baut eine `UIInterfaceOrientationMask` und sendet eine Benachrichtigung. Jeder `FlutterViewController` speichert die Maske und gibt sie aus `supportedInterfaceOrientations` zurück. Ab iOS 16 ruft er auf jeder verbundenen `UIWindowScene` `requestGeometryUpdateWithPreferences:` auf und danach `setNeedsUpdateOfSupportedInterfaceOrientations`. Die leere Liste wird zu `UIInterfaceOrientationMaskAll`, das UIKit anschließend mit den Ausrichtungen in der `Info.plist` schneidet. Eine fehlgeschlagene Geometrieanfrage wird nur protokolliert ("Failed to change device orientation"). Das Dart-Future wird trotzdem normal abgeschlossen.

Daraus folgen zwei Dinge. Erstens bedeutet `[]` "was auch immer das Betriebssystem erlaubt" und nicht "der Standard der App". Stellen Sie immer auf eine explizite Liste zurück. Zweitens ist der Aufruf Fire-and-forget. Das Warten auf das Future sagt Ihnen, dass die Nachricht zugestellt wurde, nicht, dass sich der Bildschirm gedreht hat.

## Die naive Sperre pro Screen und wie sie scheitert

Das ist die Variante, die die meisten Antworten vorschlagen:

```dart
// Flutter 3.47.8, Dart 3.13.7 -- naive, do not ship
class _VideoPageState extends State<VideoPage> {
  @override
  void initState() {
    super.initState();
    SystemChrome.setPreferredOrientations([
      DeviceOrientation.landscapeLeft,
      DeviceOrientation.landscapeRight,
    ]);
  }

  @override
  void dispose() {
    SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);
    super.dispose();
  }
}
```

Ich habe sie in einem Widget-Test ausgeführt, der `SystemChannels.platform` abfängt und jeden Ausrichtungsaufruf zwischen den Navigationsereignissen protokolliert. Hier ist das Log unter Flutter 3.47.8:

```text
naive push/pop: [landscapeLeft,landscapeRight] -- pop -- first frame of pop animation [portraitUp] -- pop animation done
naive replace:  [landscapeLeft,landscapeRight] -- replace [landscapeLeft,landscapeRight] [portraitUp]  => final [portraitUp]
```

Die erste Zeile zeigt den Timing-Fehler. `dispose` läuft erst, nachdem die Exit-Transition der Route abgeschlossen ist. Der vorherige Screen gleitet also zurück ins Bild, während das Gerät noch auf Querformat gesperrt ist, und springt erst dann ins Hochformat. Auf einem echten Telefon sieht der Nutzer den vorherigen Screen während der gesamten Pop-Transition in einem Querformat-Layout einfahren, und erst danach dreht er sich.

Die zweite Zeile ist der Korrektheitsfehler. Bei `pushReplacement` (oder `replace` / `go` von `go_router` zu einer Schwesterroute) läuft das `initState` der neuen Route vor dem `dispose` der alten Route. Die eingehende Videoseite fordert Querformat an. Dann "räumt" die ausgehende Videoseite "auf" und erzwingt Hochformat. Der Endzustand ist Hochformat auf einem Screen, der Querformat wollte. Dasselbe passiert immer, wenn sich die Lebenszeiten zweier gesperrter Screens überlappen, etwa in einer `TabBarView` oder einer `PageView`, die Nachbarn am Leben hält.

## Eine Sperre mit Besitzer, Stapel und Freigabe beim Pop

Die Lösung besteht darin, die Ausrichtung nicht mehr als etwas zu behandeln, das jeder Screen setzt und zurücksetzt. Halten Sie stattdessen einen App-weiten Stapel von Anfragen. Jeder Screen legt seinen eigenen Eintrag ab und entfernt nur diesen Eintrag, und der oberste Eintrag des Stapels (oder der App-Standard) wird an die Plattform gesendet:

```dart
// Flutter 3.47.8, Dart 3.13.7
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

/// App-wide orientation stack. The top entry wins; when it is empty the
/// app default applies.
class OrientationLocks {
  OrientationLocks._();

  static List<DeviceOrientation> appDefault = const [DeviceOrientation.portraitUp];
  static final List<(Object, List<DeviceOrientation>)> _stack = [];

  static void push(Object owner, List<DeviceOrientation> orientations) {
    _stack.removeWhere((e) => identical(e.$1, owner));
    _stack.add((owner, orientations));
    _apply();
  }

  static void remove(Object owner) {
    final before = _stack.length;
    _stack.removeWhere((e) => identical(e.$1, owner));
    if (_stack.length != before) _apply();
  }

  static void _apply() {
    final target = _stack.isEmpty ? appDefault : _stack.last.$2;
    SystemChrome.setPreferredOrientations(target);
  }
}
```

Das Widget, das ihn verwendet, legt seine Sperre ab, sobald seine Route die aktuelle wird. Es gibt die Sperre an zwei Stellen frei: wenn ein Pop beginnt (über `PopScope`) und in `dispose` als Rückfallebene für Routen, die ohne Pop entfernt werden, etwa die alte Route bei einem `pushReplacement`:

```dart
// Flutter 3.47.8, Dart 3.13.7
/// Locks orientation while this widget's route is the current route.
class OrientationLock extends StatefulWidget {
  const OrientationLock({
    super.key,
    required this.orientations,
    required this.child,
  });

  final List<DeviceOrientation> orientations;
  final Widget child;

  @override
  State<OrientationLock> createState() => _OrientationLockState();
}

class _OrientationLockState extends State<OrientationLock> {
  ModalRoute<Object?>? _route;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final route = ModalRoute.of(context);
    if (route != _route) {
      _route = route;
      // isCurrent is false while another route covers this one.
      if (route == null || route.isCurrent) {
        OrientationLocks.push(this, widget.orientations);
      }
    }
  }

  @override
  void didUpdateWidget(OrientationLock oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!listEquals(oldWidget.orientations, widget.orientations)) {
      OrientationLocks.push(this, widget.orientations);
    }
  }

  @override
  void dispose() {
    OrientationLocks.remove(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return PopScope<Object?>(
      onPopInvokedWithResult: (didPop, result) {
        // Release the lock when the pop starts, not when the exit
        // animation ends, so the previous screen does not animate in
        // under the wrong orientation.
        if (didPop) OrientationLocks.remove(this);
      },
      child: widget.child,
    );
  }
}
```

Auf einer Route verwenden Sie es mit einem einzigen Wrapper:

```dart
// Flutter 3.47.8, Dart 3.13.7
Navigator.of(context).push(MaterialPageRoute<void>(
  builder: (_) => const OrientationLock(
    orientations: [DeviceOrientation.landscapeLeft, DeviceOrientation.landscapeRight],
    child: VideoPage(),
  ),
));
```

Derselbe Test-Harness, ausgeführt gegen diese Version:

```text
stack push/pop: [landscapeLeft,landscapeRight] -- pop [portraitUp] -- first frame of pop animation -- pop animation done
stack replace:  [landscapeLeft,landscapeRight] -- replace [landscapeLeft,landscapeRight] [landscapeLeft,landscapeRight]  => final [landscapeLeft,landscapeRight]
```

Das Hochformat wird im selben Frame angefordert, in dem der Pop beginnt, sodass Drehung und Rückwärts-Transition gemeinsam ablaufen. Nach dem Ersetzen bleibt das Video im Querformat, weil das Entfernen des Eintrags der ausgehenden Seite den Eintrag der eingehenden Seite erneut anwendet und nicht den Standard.

Hier steckt eine Designentscheidung drin. Eine Route ohne eigene `OrientationLock` erbt die nächste Sperre darunter im Stapel. Wenn ein Querformat-Player ein schlichtes Einstellungs-Sheet öffnet, ist auch das Sheet im Querformat. Wenn Sie möchten, dass "alles ohne Sperre im Hochformat ist", umschließen Sie diese Routen mit einer expliziten `OrientationLock(orientations: [DeviceOrientation.portraitUp])`. Bei `go_router` setzen Sie den Wrapper in den `builder` oder `pageBuilder` der Route. `ModalRoute.of` und `PopScope` funktionieren im verschachtelten Navigator einer `ShellRoute` genauso, was der Beitrag [verschachtelte Routen und Deep Links mit go_router](/de/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/) durchgeht.

## Den App-Standard im nativen Projekt setzen, nicht nur in Dart

Wenn die ganze App bis auf einen Screen im Hochformat läuft, deklarieren Sie das Hochformat auch nativ, damit der Startbildschirm und der erste Frame bereits stimmen:

1. Fügen Sie in `android/app/src/main/AndroidManifest.xml` dem Element `MainActivity` das Attribut `android:screenOrientation="portrait"` hinzu.
2. Lassen Sie in `ios/Runner/Info.plist` `UISupportedInterfaceOrientations` (iPhone) und `UISupportedInterfaceOrientations~ipad` jede Ausrichtung auflisten, die irgendein Screen jemals braucht. Flutter kann nur einschränken, was die `Info.plist` erlaubt. Es kann nichts hinzufügen. Die Vorlage von 3.47.8 listet für das iPhone Hochformat und beide Querformate und für das iPad alle vier Ausrichtungen auf.
3. Setzen Sie in `main` den Wert `OrientationLocks.appDefault` und wenden Sie ihn vor `runApp` an:

```dart
// Flutter 3.47.8, Dart 3.13.7
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  OrientationLocks.appDefault = const [DeviceOrientation.portraitUp];
  await SystemChrome.setPreferredOrientations(OrientationLocks.appDefault);
  runApp(const MyApp());
}
```

Beschränken Sie die `Info.plist` des iPhones nicht auf Hochformat, um dann aus Dart Querformat anzufordern. Unter iOS 16+ schlägt die Geometrieanfrage fehl, weil die Scene keine der angeforderten Ausrichtungen unterstützt. Sie schlägt stillschweigend fehl, abgesehen von einer Logzeile in Xcode.

## Warum iPad-Multitasking die Sperre ignoriert

Der Doc-Kommentar zu `setPreferredOrientations` in Flutter 3.47.8 sagt es deutlich: "This setting will only be respected on iPad if multitasking is disabled." Der Grund liegt in UIKit, nicht in Flutter. Wenn eine App den Bildschirm teilen kann (Split View, Slide Over, Stage Manager und die frei skalierbaren Fenster, die mit iPadOS 26 kamen), gehören Größe und Ausrichtung der Scene dem System. Der Nutzer kann das iPad drehen, während Ihre App in einem Side-by-side-Layout läuft. Das System dreht nicht den ganzen Bildschirm für eine einzelne App, daher wird `supportedInterfaceOrientations` nicht mehr beachtet. Flutter sendet die Anfrage weiterhin, UIKit reagiert nur nicht darauf.

Jahrelang bestand der dokumentierte Workaround, den auch die Flutter-Dokumentation noch erwähnt, darin, Multitasking abzuwählen. Dazu haben Sie in Xcode "Requires full screen" angehakt, was `UIRequiresFullScreen = YES` in die `Info.plist` schreibt. Das ist keine langfristige Antwort mehr. Apples [TN3192](https://developer.apple.com/documentation/technotes/tn3192-migrating-your-app-from-the-deprecated-uirequiresfullscreen-key) sagt:

- Ab iPadOS 26 sind `UIRequiresFullScreen` und sein Kompatibilitätsmodus veraltet und werden in einem zukünftigen Release ignoriert.
- Ab iOS 27 und iPadOS 27 werden Apps, die mit dem iOS-27-SDK gebaut wurden und den Schlüssel setzen, diskret in der Größe angepasst, statt im Vollbild gehalten zu werden. Die einzige Ausnahme gilt, wenn `UIRequiresFullScreenIgnoredStartingWithVersion` die Version 27 oder früher nennt.
- Um skalierbare Scenes zu unterstützen, sollte eine App alle Interface-Ausrichtungen unterstützen.

Xcode 27.1 liefert das iOS-27-SDK mit. Bei einer Flutter-App, die Sie heute kompilieren, wählt das Anhaken von "Requires full screen" die App unter iOS 27 also nicht mehr vom Skalieren ab, und Apple hat Entwicklern gesagt, sich nicht mehr darauf zu verlassen. Threads in den Entwicklerforen aus dem iPadOS-26.x-Zyklus berichten außerdem, dass reine Querformat-Apps im Hochformat erscheinen, wenn die Rotationssperre des Geräts aus ist. Behandeln Sie jede iPad-Ausrichtungssperre als Best Effort.

Apple bietet stattdessen eine *temporäre* Sperre an. Ein View Controller kann `prefersInterfaceOrientationLocked` überschreiben und `setNeedsUpdateOfPrefersInterfaceOrientationLocked()` aufrufen. Das bittet das System, die aktuelle Ausrichtung der Scene beizubehalten, solange dieser Controller sichtbar ist, zum Beispiel bei einer Kameraaufnahme oder einer Lenkgeste in einem Spiel. TN3192 stellt klar, dass das System die Beachtung der Einstellung "does not guarantee". Der `FlutterViewController` von Flutter 3.47.8 überschreibt diese Eigenschaft nicht. Sie können das in einer Unterklasse tun und per Method Channel steuern:

```swift
// Flutter 3.47.8, Xcode 27.1, iOS 26+ for prefersInterfaceOrientationLocked
import Flutter
import UIKit

class LockableFlutterViewController: FlutterViewController {
  private var locked = false
  private var channel: FlutterMethodChannel?

  override func viewDidLoad() {
    super.viewDidLoad()
    channel = FlutterMethodChannel(
      name: "app/orientation_lock", binaryMessenger: engine.binaryMessenger)
    channel?.setMethodCallHandler { [weak self] call, result in
      guard let self, call.method == "setLocked", let value = call.arguments as? Bool else {
        result(FlutterMethodNotImplemented)
        return
      }
      self.locked = value
      if #available(iOS 26.0, *) {
        self.setNeedsUpdateOfPrefersInterfaceOrientationLocked()
      }
      result(nil)
    }
  }

  override var prefersInterfaceOrientationLocked: Bool {
    locked
  }
}
```

Ändern Sie in `ios/Runner/Base.lproj/Main.storyboard` die `customClass` des Root View Controllers von `FlutterViewController` zu `LockableFlutterViewController` (mit `customModuleProvider="target"`). Rufen Sie sie dann aus Dart auf:

```dart
// Flutter 3.47.8, Dart 3.13.7
const _lockChannel = MethodChannel('app/orientation_lock');

Future<void> setIpadOrientationLocked(bool locked) =>
    _lockChannel.invokeMethod<void>('setLocked', locked);
```

Das behält die Ausrichtung bei, die die Scene bereits hat. Es dreht nicht ins Querformat, ergänzt also `setPreferredOrientations`, ersetzt es aber nicht. Ich habe diese Unterklasse mit `flutter build ios --simulator` unter Xcode 27.1 in eine Flutter-3.47.8-App kompiliert (Deployment Target iOS 15, daher die `#available`-Prüfung). Das Multitasking-Verhalten habe ich nicht auf einem physischen iPad getestet, prüfen Sie es also auf echter Hardware, bevor Sie sich darauf verlassen.

## Android 16 verhält sich auf großen Bildschirmen genauso

Android ist denselben Weg gegangen. Laut den [Verhaltensänderungen von Android 16](https://developer.android.com/about/versions/16/behavior-changes-16#ignore-orientation) ignorieren Apps, die API 36 anvisieren, `screenOrientation`, `resizableActivity`, `minAspectRatio`, `maxAspectRatio`, `setRequestedOrientation()` und `getRequestedOrientation()` auf Displays mit einer kleinsten Breite von mindestens 600 dp. Das umfasst Tablets, aufgeklappte Foldables und Desktop-Fenster. `setPreferredOrientations` von Flutter ist ein `setRequestedOrientation()`-Aufruf, und das Gradle-Plugin von Flutter 3.47.8 setzt `flutter.targetSdkVersion` auf 36. Eine frisch erstellte Flutter-App sperrt die Ausrichtung auf einem Tablet also nicht. Die Dokumentation von Flutter nennt diese Einschränkung inzwischen selbst.

Die Ausnahmen sind Spiele (deklariert mit `android:appCategory="game"`), Nutzer, die in den Seitenverhältnis-Einstellungen des Geräts das Standardverhalten der App wählen, und Bildschirme unter 600 dp Breite. Telefone sind nicht betroffen. Es gibt ein temporäres Opt-out:

```xml
<!-- android/app/src/main/AndroidManifest.xml, targetSdk 36 only -->
<activity android:name=".MainActivity" ...>
    <property
        android:name="android.window.PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY"
        android:value="true" />
</activity>
```

Google gibt an, dass das Opt-out nicht mehr gilt, sobald Sie API-Level 37 anvisieren. Betrachten Sie es als Zeit, Ihr Tablet-Layout zu korrigieren, nicht als Lösung. Dieselbe Regel traf MAUI-Apps, und der Beitrag zur [MAUI-Migration auf API-Level 36](/de/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/) behandelt die Manifest-Seite ausführlicher.

## Stolperfallen, wenn sich der Screen tatsächlich dreht

- **Layout aus Constraints, nicht aus der Sperre.** Die Drehung kommt einen Frame oder mehr nach Ihrem Aufruf an, und auf dem iPad oder auf Android-16-Tablets kommt sie womöglich nie. Bauen Sie den gesperrten Screen mit `OrientationBuilder` oder `LayoutBuilder`, damit er in jeder Größe, die er tatsächlich bekommt, korrekt dargestellt wird.
- **Entscheiden Sie anhand des Displays, nicht anhand von `MediaQuery.size`, ob gesperrt wird.** Unter Android meldet `MediaQueryData.size` wegen Letterboxing nur den Bereich mit Letterbox. Die Dokumentation von Flutter empfiehlt `View.of(context).display.size / display.devicePixelRatio` gegen einen Breakpoint von 600 logischen Pixeln. Sperren Sie nur Telefone und senden Sie auf Tablets `[]`.
- **`landscapeLeft` bedeutet, dass das Gerät gegen den Uhrzeigersinn gedreht ist.** `DeviceOrientation.landscapeLeft` ist "90 degrees counterclockwise from portraitUp". Fordern Sie beide Querformate an, sofern Sie keinen Grund haben, eines festzulegen. Sonst sieht ein Nutzer, der das Telefon in die andere Richtung gedreht hat, den Screen auf dem Kopf stehen.
- **iPhones ohne Home-Taste bekommen nie `portraitDown`.** TN3192 merkt an, dass das System `portraitUpsideDown` bei diesen Modellen aus der unterstützten Menge entfernt, was auch immer Sie deklarieren.
- **Fortsetzen aus dem Hintergrund.** Die native Einstellung übersteht den Wechsel in den Hintergrund, Sie müssen sie beim Fortsetzen also nicht erneut anwenden. Falls Sie anderen Lifecycle-Code haben, ist die [Migration auf AppLifecycleListener](/de/2026/10/migrate-a-flutter-app-from-widgetsbindingobserver-to-applifecyclelistener/) der sauberere Ort dafür als ein `WidgetsBindingObserver`.
- **Rufen Sie es nicht nach einem `await` auf, ohne `mounted` zu prüfen.** Das Sperren nach einem asynchronen Laden des Videos ist üblich. Hat der Nutzer die Route bereits verlassen, hinterlässt ein verspätetes `OrientationLocks.push` aus einem toten `State` eine Sperre, die niemand entfernt. Die Regeln aus [BuildContext sicher nach einem await verwenden](/de/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) gelten auch hier.

## Weiterführende Lektüre

- [Verschachtelte Routen und Deep Links mit go_router](/de/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/), dazu, wo der `OrientationLock`-Wrapper in einem Routenbaum hingehört.
- [go_router vs auto_route vs Navigator 2.0](/de/2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter/), falls Sie einen Router auswählen und es Ihnen darauf ankommt, wie ersetzte Routen entsorgt werden.
- [Von WidgetsBindingObserver zu AppLifecycleListener migrieren](/de/2026/10/migrate-a-flutter-app-from-widgetsbindingobserver-to-applifecyclelistener/).
- [Eine .NET-MAUI-Android-App auf API-Level 36 migrieren](/de/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/), für dieselbe Android-16-Regel für große Bildschirme aus MAUI-Sicht.

## Quellen

- [`SystemChrome.setPreferredOrientations` API docs](https://api.flutter.dev/flutter/services/SystemChrome/setPreferredOrientations.html) und der [3.47.8-Quellcode](https://github.com/flutter/flutter/blob/3.47.8/packages/flutter/lib/src/services/system_chrome.dart).
- Flutter-Engine in 3.47.8: [`FlutterViewController.mm`](https://github.com/flutter/flutter/blob/3.47.8/engine/src/flutter/shell/platform/darwin/ios/framework/Source/FlutterViewController.mm), [`FlutterPlatformPlugin.mm`](https://github.com/flutter/flutter/blob/3.47.8/engine/src/flutter/shell/platform/darwin/ios/framework/Source/FlutterPlatformPlugin.mm), [`PlatformChannel.java`](https://github.com/flutter/flutter/blob/3.47.8/engine/src/flutter/shell/platform/android/io/flutter/embedding/engine/systemchannels/PlatformChannel.java).
- [TN3192: Migrating your app from the deprecated UIRequiresFullScreen key](https://developer.apple.com/documentation/technotes/tn3192-migrating-your-app-from-the-deprecated-uirequiresfullscreen-key).
- [Android 16 behavior changes: ignore orientation, resizability, and aspect ratio restrictions](https://developer.android.com/about/versions/16/behavior-changes-16#ignore-orientation).
- Apple Developer Forums: [iPadOS 26.x ignores supportedInterfaceOrientations when orientation lock is off](https://developer.apple.com/forums/thread/811216).
