---
title: "Fix: [firebase_messaging/apns-token-not-set] APNS token has not been set unter Flutter iOS"
description: "getToken() läuft, bevor APNs iOS das Gerätetoken übergibt. Fragen Sie getAPNSToken() ab, bis es einen Wert ungleich null liefert, und rufen Sie dann getToken() auf."
pubDate: 2026-08-21
template: error-page
tags:
  - "errors"
  - "flutter"
  - "ios"
  - "firebase"
  - "dart"
lang: "de"
translationOf: "2026/08/fix-firebase-messaging-apns-token-not-set-on-flutter-ios"
translatedBy: "claude"
translationDate: 2026-08-21
---

Sie haben `FirebaseMessaging.instance.getToken()` aufgerufen, bevor APNs das Gerätetoken an iOS geliefert hat, und das Plugin verweigert die Weiterarbeit. Fragen Sie `getAPNSToken()` in einer Schleife ab, bis es einen Wert ungleich null zurückgibt, und rufen Sie dann `getToken()` auf. Bleibt es nach zehn Sekunden null, liegt ein Konfigurationsproblem vor und keine Race Condition: Die Fähigkeit Push Notifications fehlt, die automatische Initialisierung ist deaktiviert, oder Sie arbeiten auf einem Simulator, der sich nicht registrieren kann. Geprüft wurde dies gegen `firebase_messaging` 16.5.0 und `firebase_core` 4.13.0 unter Flutter 3.44.2.

## Der Fehler im Kontext

Aktuelle Versionen des Plugins werfen dies:

```
[firebase_messaging/apns-token-not-set] APNS token has not been received on the device yet. Please ensure the APNS token is available before calling `getAPNSToken()`.
```

Ältere Versionen formulierten es anders, weshalb sich die Suchergebnisse zu diesem Problem auf zwei Zeichenketten verteilen:

```
[firebase_messaging/apns-token-not-set] APNS token has not been set yet. Please ensure the APNS token is available by calling `getAPNSToken()`.
```

Beides ist dieselbe `FirebaseException`, beide tragen `code: 'apns-token-not-set'`, und beide stammen aus derselben Quelle. Die Meldung führt auf eine sehr bestimmte Weise in die Irre: Sie fordert dazu auf, `getAPNSToken()` aufzurufen, aber genau `getAPNSToken()` ist soeben fehlgeschlagen. Gemeint ist "warten Sie, bis `getAPNSToken()` etwas zurückgibt".

## Warum das Token fehlt, wenn getToken läuft

Die Prüfung liegt in Dart, nicht im nativen Code. In `firebase_messaging_platform_interface` 4.9.3 definiert `method_channel_messaging.dart` eine private Schutzfunktion:

```dart
// firebase_messaging_platform_interface 4.9.3
Future<void> _APNSTokenCheck() async {
  if (defaultTargetPlatform == TargetPlatform.macOS ||
      defaultTargetPlatform == TargetPlatform.iOS) {
    String? token = await getAPNSToken();

    if (token == null) {
      throw FirebaseException(
        plugin: 'firebase_messaging',
        code: 'apns-token-not-set',
        message:
            'APNS token has not been received on the device yet. Please ensure the APNS token is available before calling `getAPNSToken()`.',
      );
    }
  }
}
```

Auf der nativen Seite ist `getAPNSToken` ein direkter Lesezugriff ohne Warten und ohne Wiederholung:

```objc
// FLTFirebaseMessagingPlugin.m, firebase_messaging 16.5.0
- (void)messagingGetAPNSToken:(id)arguments
         withMethodCallResult:(FLTFirebaseMethodCallResult *)result {
  NSData *apnsToken = [FIRMessaging messaging].APNSToken;
  if (apnsToken) {
    result.success(@{@"token" : [FLTFirebaseMessagingPlugin APNSTokenFromNSData:apnsToken]});
  } else {
    result.success(@{@"token" : [NSNull null]});
  }
}
```

Das ist der gesamte Mechanismus. `FIRMessaging.APNSToken` ist nil, bis iOS `application:didRegisterForRemoteNotificationsWithDeviceToken:` aufruft, und dieser Callback feuert nach Apples Zeitplan, nach einem Netzwerk-Roundtrip zu APNs. Üblicherweise trifft er ein bis zwei Sekunden nach dem Start ein, aber nichts in Ihrer App steuert den Zeitpunkt. Firebases eigene Dokumentation nennt die Einschränkung deutlich: Ab iOS SDK 10.4.0 muss das APNs-Token verfügbar sein, bevor Sie API-Anfragen stellen.

Der Fehler bedeutet also nicht "etwas ist kaputt". Im Normalfall bedeutet er "Sie haben zu früh gefragt".

## Welche Aufrufe die Prüfung tatsächlich erzwingen

Genau vier Methoden warten in 4.9.3 auf `_APNSTokenCheck()`: `deleteToken()`, `getToken()`, `subscribeToTopic()` und `unsubscribeFromTopic()`. Alles andere, einschließlich `requestPermission()`, `getInitialMessage()` und des `onMessage`-Streams, läuft ohne sie.

Das erklärt ein berichtetes Muster, das sonst widersprüchlich wirkt: Berechtigungsdialoge erscheinen normal und Nachrichten im Vordergrund kommen an, aber `subscribeToTopic()` wirft eine Exception. Das Abonnieren von Topics ist geschützt, die Nachrichtenzustellung nicht.

`getAPNSToken()` selbst ist nicht geschützt. Es gibt null zurück, statt zu werfen, und genau das macht das Abfragen in einer Schleife sicher.

## Wie sieht eine minimale Reproduktion aus?

Jede App, die das Token während des Starts abholt, trifft bei einem Kaltstart darauf:

```dart
// Flutter 3.44.2, firebase_core 4.13.0, firebase_messaging 16.5.0
Future<String?> brokenRegisterForPush() async {
  await Firebase.initializeApp();
  return FirebaseMessaging.instance.getToken();
}
```

Der Fehler tritt sporadisch auf, was die unangenehmste Eigenschaft dieses Problems ist. Bei einem Warmstart oder auf einem Gerät, das sich kürzlich registriert hat, liegt das Token oft bereits im Cache von `FIRMessaging` und der Aufruf gelingt. Bei einer frischen Installation, einem langsamen Netzwerk oder dem ersten Start nach einer Neuinstallation schlägt er fehl. Testen Sie mit einer sauberen Installation, bevor Sie davon ausgehen, das Problem behoben zu haben.

## Wie warte ich auf das APNs-Token, bevor ich getToken aufrufe?

Es gibt weder einen Callback noch einen Stream für "das APNs-Token ist jetzt verfügbar", daher ist das Abfragen in einer Schleife der unterstützte Weg. Diese Hilfsfunktion durchläuft die Analyse gegen `firebase_messaging` 16.5.0 fehlerfrei:

```dart
// Flutter 3.44.2, firebase_messaging 16.5.0
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';

/// Polls `getAPNSToken()` until APNs hands the token to the Firebase iOS SDK.
/// Returns null on non-Apple platforms and on timeout.
Future<String?> waitForAPNSToken({
  Duration timeout = const Duration(seconds: 10),
  Duration interval = const Duration(milliseconds: 250),
}) async {
  if (kIsWeb ||
      (defaultTargetPlatform != TargetPlatform.iOS &&
          defaultTargetPlatform != TargetPlatform.macOS)) {
    return null;
  }

  final stopwatch = Stopwatch()..start();
  while (stopwatch.elapsed < timeout) {
    final token = await FirebaseMessaging.instance.getAPNSToken();
    if (token != null) return token;
    await Future<void>.delayed(interval);
  }
  return null;
}
```

Die Rückgabe von null unter Android und im Web ist wichtig. Schreiben Sie die Absicherung als reine `while (token == null)`-Schleife ohne Plattformprüfung, gibt `getAPNSToken()` unter Android dauerhaft null zurück, und Sie drehen bei jedem Android-Start bis zum Timeout leer. Die Implementierung der Platform Interface springt für jede Nicht-Apple-Plattform sofort auf null, bevor sie überhaupt den Method Channel berührt.

Binden Sie das in die Registrierung ein:

```dart
// Flutter 3.44.2, firebase_messaging 16.5.0
Future<String?> registerForPush() async {
  await Firebase.initializeApp();

  final messaging = FirebaseMessaging.instance;
  await messaging.setAutoInitEnabled(true);

  final settings = await messaging.requestPermission();
  debugPrint('authorizationStatus: ${settings.authorizationStatus}');

  final apnsToken = await waitForAPNSToken();
  if (apnsToken == null && !kIsWeb) {
    debugPrint('No APNs token: check Push Notifications capability.');
    return null;
  }

  return messaging.getToken();
}
```

Verfahren Sie vor Topic-Aufrufen genauso, denn diese sind ebenfalls geschützt:

```dart
// Flutter 3.44.2, firebase_messaging 16.5.0
Future<void> subscribeSafely(String topic) async {
  await waitForAPNSToken();
  await FirebaseMessaging.instance.subscribeToTopic(topic);
}
```

Wenn Sie bestehenden Startcode nicht umbauen möchten, fangen Sie die Exception ab und wiederholen den Aufruf einmal. Das ist strikt schlechter, als von vornherein zu warten, weil zuerst ein fehlgeschlagener Roundtrip verbraucht wird, aber es ist ein kleiner Diff:

```dart
// Flutter 3.44.2, firebase_messaging 16.5.0
Future<String?> registerForPushHandled() async {
  try {
    return await FirebaseMessaging.instance.getToken();
  } on FirebaseException catch (e) {
    if (e.code == 'apns-token-not-set') {
      final token = await waitForAPNSToken();
      if (token == null) return null;
      return FirebaseMessaging.instance.getToken();
    }
    rethrow;
  }
}
```

Beachten Sie, dass die Berechtigung eine andere Frage ist als die Verfügbarkeit des Tokens. Die Registrierung für Remote-Benachrichtigungen erzeugt das APNs-Gerätetoken, und das Plugin erledigt dies während der Registrierung, nicht als Reaktion auf den Berechtigungsdialog. Eine Person, die den Benachrichtigungsdialog ablehnt, kann trotzdem ein gültiges APNs-Token besitzen, und genau das lässt stille Push-Nachrichten im Hintergrund funktionieren.

## Was passiert bei deaktivierter automatischer Initialisierung?

Dies ist die Ursache, die übersehen wird, und sie lohnt das Verständnis, weil das Symptom ein Token ist, das niemals eintrifft, egal wie lange Sie abfragen.

Steht `FirebaseMessagingAutoInitEnabled` in Ihrer `Info.plist` auf `NO`, oder haben Sie `setAutoInitEnabled(false)` aufgerufen und der Wert wurde persistiert, registriert sich das Plugin beim Start überhaupt nicht für Remote-Benachrichtigungen:

```objc
// FLTFirebaseMessagingPlugin.m, firebase_messaging 16.5.0
if ([FIRMessaging messaging].isAutoInitEnabled) {
  [self registerForRemoteNotifications];
}
```

Und selbst wenn sich etwas anderes in Ihrer App registriert, legt der Delegate-Callback das Token beiseite und kehrt zurück, ohne es an `FIRMessaging` zu übergeben:

```objc
// FLTFirebaseMessagingPlugin.m, firebase_messaging 16.5.0
- (void)application:(UIApplication *)application
    didRegisterForRemoteNotificationsWithDeviceToken:(NSData *)deviceToken {
  FIRMessaging *messaging = [FIRMessaging messaging];
  if (!messaging.isAutoInitEnabled) {
    _apnsToken = deviceToken;
    return;
  }
  // ... setAPNSToken happens only past this point
}
```

`FIRMessaging.APNSToken` bleibt nil, also liefert `getAPNSToken()` weiterhin null und Ihre Abfrageschleife läuft in den Timeout, obwohl iOS der App erfolgreich ein Gerätetoken übergeben hat.

Der Weg zurück existiert, aber Sie müssen ihn auslösen. `setAutoInitEnabled(true)` ruft `registerForRemoteNotifications` auf und übergibt anschließend das zwischengespeicherte Token, und diese Übergabe läuft zusätzlich zu Beginn jedes Methodenaufrufs, den das Plugin verarbeitet:

```objc
// FLTFirebaseMessagingPlugin.m, firebase_messaging 16.5.0
- (void)ensureAPNSTokenSetting {
  FIRMessaging *messaging = [FIRMessaging messaging];

  if (messaging.isAutoInitEnabled && messaging.APNSToken == nil && _apnsToken != nil) {
    [messaging setAPNSToken:_apnsToken type:FIRMessagingAPNSTokenTypeSandbox];
    _apnsToken = nil;
  }
}
```

Wenn Sie die FCM-Registrierung aus Gründen der Einwilligung bewusst verzögern, ist das in Ordnung, aber `await messaging.setAutoInitEnabled(true)` muss vor dem Warten auf das Token stehen. Deshalb taucht es oben in `registerForPush()` auf.

## Was zu prüfen ist, wenn das Token nie eintrifft

Arbeiten Sie diese Liste der Reihe nach ab. Die ersten beiden Punkte erklären die meisten Fälle, in denen die Abfrage auf einem physischen Gerät in den Timeout läuft.

1. **Fähigkeit Push Notifications.** Öffnen Sie in Xcode das Runner-Target, gehen Sie zu Signing and Capabilities und prüfen Sie, ob Push Notifications aufgeführt ist. Ohne diese Fähigkeit besitzt die App kein `aps-environment`-Entitlement, `registerForRemoteNotifications` schlägt fehl, und iOS ruft stattdessen `didFailToRegisterForRemoteNotificationsWithError:` auf. Das Plugin protokolliert diesen Fehler mit `NSLog` und sonst nichts, weshalb er leicht übersehen wird. Prüfen Sie die Xcode-Konsole auf eine Zeile darüber, dass die App nicht für Push berechtigt ist.
2. **Background Modes.** Aktivieren Sie Background fetch und Remote notifications. Der Einrichtungsleitfaden von FlutterFire verlangt beide, und APNs wird für Messaging im Vordergrund wie im Hintergrund benötigt.
3. **APNs-Schlüssel bei Firebase hochgeladen.** Firebase Console, Project Settings, Reiter Cloud Messaging. Mindestens ein Schlüssel ist erforderlich. Ein fehlender Schlüssel blockiert zwar nicht das APNs-Token selbst, bricht aber alles Nachgelagerte, also erledigen Sie es gleich mit.
4. **Method Swizzling.** Firebases Flutter-Client-Leitfaden stellt ausdrücklich fest, dass Swizzling erforderlich ist und die Verwaltung des FCM-Tokens ohne es nicht funktioniert. Haben Sie `FirebaseAppDelegateProxyEnabled` in der `Info.plist` auf `NO` gesetzt, müssen Sie die APNs-Delegate-Callbacks selbst weiterleiten. Die einfachste Lösung besteht darin, diesen Schlüssel zu entfernen.
5. **Abweichende Bundle-ID.** Der Bundle-Identifier in Xcode muss mit dem in `GoogleService-Info.plist` übereinstimmen. Eine Abweichung führt hier zu verwirrenden Folgefehlern statt zu einer klaren Fehlermeldung.

## Liefert der iOS-Simulator ein APNs-Token?

Manchmal, und die Bedingungen sind eng genug, um sie exakt zu benennen. Der Simulator unterstützt echte Remote-Benachrichtigungen und echte Gerätetoken nur ab iOS 16, unter macOS 13 oder neuer, auf einem Mac mit Apple Silicon oder T2-Chip. Die Token sind für die Kombination aus jenem Simulator und jenem Mac eindeutig, und der Simulator registriert sich gegen die APNs-Sandbox-Umgebung.

Außerhalb dieser Kombination kann sich der Simulator nicht für Remote-Benachrichtigungen registrieren, `getAPNSToken()` gibt dauerhaft null zurück, und keine Konfiguration behebt das. Vor Xcode 14 konnte kein Simulator überhaupt ein Gerätetoken erzeugen. Wenn Sie diesem Fehler auf einem älteren Simulator, einem Intel-Mac oder einer iOS-15-Laufzeit nachgehen, wechseln Sie auf ein physisches Gerät, bevor Sie Code ändern.

## Fallstricke und Verwechslungen

**Token-Typ Sandbox gegenüber Produktion.** Das Plugin wählt den APNs-Token-Typ zur Kompilierzeit anhand des Präprozessor-Makros `DEBUG` und verwendet `FIRMessagingAPNSTokenTypeSandbox` in Debug-Builds sowie `FIRMessagingAPNSTokenTypeProd` sonst. Das verursacht nie `apns-token-not-set`, wohl aber den klassischen Bericht "funktioniert im Debug, still in TestFlight". Bleiben Benachrichtigungen in einem Release-Build aus, ist dort zu suchen, nicht hier.

**Neuinstallationen entwerten Token.** Löschen und Neuinstallieren der App erzeugt ein neues APNs-Token und ein neues FCM-Token. Serverseitige Token-Einträge der vorherigen Installation sind tot. Hören Sie auf `FirebaseMessaging.instance.onTokenRefresh` und laden Sie erneut hoch, statt das Token einmal beim ersten Start abzuholen und dauerhaft zwischenzuspeichern.

**Ein null-Rückgabewert von `getAPNSToken()` ist nicht diese Exception.** Sehen Sie ein null-APNs-Token, aber keinen geworfenen Fehler, haben Sie `getAPNSToken()` direkt aufgerufen. Es gibt null zurück, so ist es vorgesehen; nur die vier geschützten Methoden verwandeln dieses null in eine `FirebaseException`.

**Ein Timeout von zehn Sekunden ist eine Annahme, keine Garantie.** Auf einem Gerät ohne Netzwerk feuert der Callback schlicht nie. Behandeln Sie einen Timeout als weichen Fehlschlag: null zurückgeben, die App weiterlaufen lassen und die Registrierung später erneut versuchen, statt den Startbildschirm dauerhaft zu blockieren.

## Verwandte Beiträge

Wenn Sie sich durch Build- und Integrationsprobleme unter iOS in einer Flutter-App arbeiten, decken diese Beiträge die benachbarten Fehler ab: die [Versionsauflösungsfehler von CocoaPods](/de/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/), die direkt nach dem Hinzufügen von Firebase-Plugins auftreten, der [defekte iOS-Build unter Xcode 16](/de/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/) mit seinen vier verschiedenen Ursachen, der [Fehler über ein fehlendes Ziel](/de/2026/08/fix-unable-to-find-a-destination-matching-the-provided-destination-specifier-in-a-flutter-ios-build/) durch einen veralteten Architekturausschluss im Podfile, der [Absturz der Dart-VM in iOS-Debug-Builds](/de/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/), den kein Entitlement behebt, und die [Migration auf das Singleton von google_sign_in 7.0](/de/2026/08/fix-the-class-googlesignin-doesnt-have-an-unnamed-constructor-in-flutter/), falls Sie gleichzeitig Firebase Auth einrichten.

## Quellen

- [Firebase Cloud Messaging Client-App unter Flutter einrichten](https://firebase.google.com/docs/cloud-messaging/flutter/client) - die Anforderung an das APNs-Token ab iOS SDK 10.4.0 und die Anforderung an Method Swizzling.
- [FlutterFire Apple Integration Guide](https://firebase.flutter.dev/docs/messaging/apple-integration/) - Fähigkeit Push Notifications, Background Modes, Upload des APNs-Schlüssels.
- `firebase_messaging_platform_interface` 4.9.3, `lib/src/method_channel/method_channel_messaging.dart` - die Schutzfunktion `_APNSTokenCheck()` und die vier Methoden, die auf sie warten.
- `firebase_messaging` 16.5.0, `ios/firebase_messaging/Sources/firebase_messaging/FLTFirebaseMessagingPlugin.m` - `messagingGetAPNSToken`, `ensureAPNSTokenSetting` und die Auto-Init-Bedingung bei der Registrierung.
- [flutterfire Issue #10625](https://github.com/firebase/flutterfire/issues/10625) - das Issue, das der Quellcodekommentar von `_APNSTokenCheck` als Grund für die Existenz der Schutzfunktion nennt.
- [Unterstützung von Push-Benachrichtigungen im Simulator mit Xcode 14](https://github.com/firebase/firebase-ios-sdk/pull/10503) - die Änderung im firebase-ios-sdk, die Gerätetoken im Simulator nutzbar machte.
