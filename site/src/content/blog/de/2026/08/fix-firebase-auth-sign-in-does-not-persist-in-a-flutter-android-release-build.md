---
title: "Fix: Firebase-Auth-Anmeldung bleibt in einem Flutter-Android-Release-Build nicht erhalten"
description: "Firebase Auth stellt die Android-Sitzung aus einer privaten SharedPreferences-Datei ohne Netzwerkaufruf wieder her. Eine Abmeldung, die nur im Release auftritt, ist daher nie ein Persistenzfehler. Es ist eine andere google-services.json, eine abgelehnte Token-Erneuerung, App Check oder Ihr eigener catch-Block."
pubDate: 2026-08-31
template: how-to
tags:
  - "errors"
  - "flutter"
  - "android"
  - "firebase"
  - "dart"
lang: "de"
translationOf: "2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build"
translatedBy: "claude"
translationDate: 2026-08-31
---

Sie melden sich an, beenden die App, öffnen sie erneut, und der Benutzer ist weg. Nur im Release. Im Debug überlebt die Sitzung jeden Neustart. Wichtig zu wissen, bevor Sie irgendetwas ändern: Firebase Auth stellt den angemeldeten Benutzer unter Android aus einer privaten `SharedPreferences`-Datei wieder her, ganz ohne Netzwerkaufruf. "Die Persistenz ist im Release kaputt" ist deshalb so gut wie nie die Erklärung. Entweder öffnet der Release-Build eine andere Speicherdatei, oder etwas hat den Speicher geleert: eine Token-Erneuerung, die abgelehnt und nicht bloß fehlgeschlagen zurückkam, eine App-Check-Erzwingung, die nur Ihrem Debug-Zertifikat vertraut, oder Ihr eigener Startcode, der `signOut()` in einem catch-Block aufruft. Verifiziert gegen `firebase_auth` 6.6.1 und `firebase_core` 4.14.0 unter Flutter 3.47.1 mit Dart 3.13.1, aufgelöst auf `com.google.firebase:firebase-auth:24.2.0` unter Android.

## Wo die Android-Sitzung tatsächlich liegt

Das Flutter-Plugin implementiert die Persistenz nicht. Es reicht sie an das Android-SDK weiter, und das Android-SDK schreibt den Benutzer in eine `SharedPreferences`-Datei. In `firebase-auth` 24.2.0 ist der Speicher `com.google.firebase.auth.internal.zzce`, dessen Konstruktor sich so auflöst:

```java
// Decompiled from com.google.firebase:firebase-auth:24.2.0
// zzce(Context, String persistenceKey)
this.zzc = context.getSharedPreferences(
    String.format("com.google.firebase.auth.api.Store.%s", persistenceKey),
    Context.MODE_PRIVATE);
```

Der Persistenzschlüssel stammt aus `FirebaseApp.getPersistenceKey()` und besteht aus zwei URL-sicheren Base64-Werten, verbunden durch ein Pluszeichen:

```java
// com.google.firebase:firebase-common
// getPersistenceKey() == base64Url(appName) + "+" + base64Url(options.getApplicationId())
```

Für die Standard-App wird `[DEFAULT]` zu `W0RFRkFVTFRd` kodiert, ein echter Gerätepfad sieht also so aus:

```
/data/data/<applicationId>/shared_prefs/com.google.firebase.auth.api.Store.W0RFRkFVTFRd+<base64url of mobilesdk_app_id>.xml
```

Aus diesem Konstruktor folgen zwei Tatsachen, die die gesamte Untersuchung lenken. Erstens ist das Wiederherstellen des Benutzers ein Lesezugriff auf die Festplatte. Der Konstruktor von `FirebaseAuth` erzeugt `zzce` und holt den gespeicherten Benutzer daraus, ein Gerät ohne Netz startet also weiterhin angemeldet. Zweitens leitet sich der Dateiname aus der Google-App-ID in Ihrer `google-services.json` ab. Ändern Sie diesen Wert zwischen Varianten, haben Sie keine Sitzung verloren, sondern nur aufgehört, die Datei zu öffnen, in die sie geschrieben wurde.

## Warum `currentUser` unter Android keine Race Condition hat

Häufig wird behauptet, `FirebaseAuth.instance.currentUser` sei nach dem Start kurz null und man müsse auf `authStateChanges()` warten. Für Web und die Desktop-Embedder stimmt das. Für Android stimmt es nicht, und dieses Wissen erspart Ihnen, eine Race Condition zu "reparieren", die es nicht gibt.

Das Android-Plugin veröffentlicht den wiederhergestellten Benutzer während `Firebase.initializeApp()` als Plugin-Konstante:

```kotlin
// firebase_auth 6.6.1, android/.../FlutterFirebaseAuthPlugin.kt
override fun getPluginConstantsForFirebaseApp(
    firebaseApp: FirebaseApp?
): Task<MutableMap<String, Any>> {
  // ...
  val firebaseAuth = FirebaseAuth.getInstance(firebaseApp!!)
  val firebaseUser = firebaseAuth.currentUser
  val user = PigeonParser.parseFirebaseUser(firebaseUser)
  if (user != null) {
    constants["APP_CURRENT_USER"] = PigeonParser.manuallyToList(user)
  }
  // ...
}
```

Diese Konstanten fließen in `MethodChannelFirebaseAuth.setInitialValues`, und die Streams geben den Wert erneut aus, bevor irgendetwas vom nativen Event-Kanal eintrifft:

```dart
// firebase_auth_platform_interface, method_channel_firebase_auth.dart
@override
Stream<UserPlatform?> authStateChanges() async* {
  yield currentUser;
  yield* _authStateChangesListeners[app.name]!.stream.map((event) => event.value);
}
```

Unter Android ist `currentUser` also bereits korrekt, sobald `await Firebase.initializeApp()` zurückgekehrt ist, und das erste Ereignis aus `authStateChanges()` ist derselbe Wert. Ist er im Release null, war der Speicher tatsächlich leer. Ein Wechsel von `currentUser` zu einem `StreamBuilder` ändert die Antwort nicht, auch wenn das aus anderen Gründen weiterhin die richtige Form für ein Auth-Gate ist. Dazu lohnt sich [der Vergleich zwischen StreamBuilder und AsyncValue in Riverpod](/de/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/).

## Diagnoseschritte, die die Ursache eingrenzen

Führen Sie sie der Reihe nach aus. Jeder Schritt schließt eine ganze Klasse von Erklärungen aus, und die ersten beiden dauern etwa fünf Minuten.

1. **Machen Sie den Release-Build debuggbar, um ihn inspizieren zu können.**
   `adb shell run-as` verweigert den Zugriff auf ein Paket, das nicht als debuggbar markiert ist. Deshalb können Sie den Speicher eines normalen Release-APK nicht auslesen. Fügen Sie in `android/app/build.gradle.kts` einen Wegwerf-Build-Type hinzu, bauen Sie damit und löschen Sie ihn danach wieder.

   ```kotlin
   // android/app/build.gradle.kts, temporary
   buildTypes {
       create("releaseProbe") {
           initWith(getByName("release"))
           isDebuggable = true
           matchingFallbacks += listOf("release")
       }
   }
   ```

2. **Prüfen Sie, ob die Speicherdatei existiert und welche es ist.**
   Melden Sie sich an, erzwingen Sie das Beenden und listen Sie das Preferences-Verzeichnis der App auf. Ist die Datei vorhanden und nicht leer, die App startet aber trotzdem abgemeldet, haben Sie ein Code-Problem und kein Speicherproblem. Fehlt die Datei, hat etwas sie gelöscht.

   ```bash
   adb shell run-as com.example.app ls -l shared_prefs/
   adb shell run-as com.example.app cat 'shared_prefs/com.google.firebase.auth.api.Store.W0RFRkFVTFRd+...xml'
   ```

3. **Vergleichen Sie die Google-App-ID, die jede Variante tatsächlich einkompiliert.**
   Das Gradle-Plugin `google-services` schreibt die gelesenen Werte pro Variante in eine generierte Ressourcendatei. Vergleichen Sie beide. Ein Unterschied hier erklärt das Symptom vollständig, und mehr muss nicht untersucht werden.

   ```bash
   grep google_app_id android/app/build/generated/res/google-services/debug/values/values.xml
   grep google_app_id android/app/build/generated/res/google-services/release/values/values.xml
   ```

4. **Schließen Sie R8 mit dem Usage-Report aus, statt zu raten.**
   Code-Shrinking ist in Flutter-Release-Builds aktiv, R8 ist also ein berechtigter Verdächtiger, lässt sich aber günstig ausschließen. Fügen Sie `-printusage build/r8-usage.txt` zu `android/app/proguard-rules.pro` hinzu, bauen Sie neu und suchen Sie im Report nach `com.google.firebase.auth`.

5. **Beobachten Sie die Token-Erneuerung.**
   Aktivieren Sie ausführliches Firebase-Auth-Logging und starten Sie die App kalt mit aktivem Netz. Eine Erneuerung, die an einem Transportfehler scheitert, lässt die Sitzung unangetastet. Eine abgelehnte Erneuerung ist diejenige, die sie löscht.

   ```bash
   adb shell setprop log.tag.FirebaseAuth VERBOSE
   adb logcat -s FirebaseAuth:V FirebaseApp:V
   ```

6. **Prüfen Sie die im Projekt registrierten Zertifikat-Fingerabdrücke.**
   Geben Sie die Fingerabdrücke aus, mit denen Ihre Release-Variante tatsächlich signiert ist, und vergleichen Sie sie mit den Firebase-Projekteinstellungen, den API-Key-Einschränkungen in Google Cloud und der App-Signing-Seite der Play Console.

   ```bash
   cd android && ./gradlew signingReport
   ```

## Ursache 1: Die Release-Variante liest eine andere `google-services.json`

Das ist die häufigste Antwort und die am leichtesten zu übersehende, weil daran nichts nach einem Authentifizierungsproblem aussieht.

Android-Source-Sets erlauben es, eine `google-services.json` in `android/app/src/debug/`, `android/app/src/prod/` oder ein beliebiges Flavor-Verzeichnis zu legen, und das Gradle-Plugin wählt die spezifischste für die gerade gebaute Variante. Die FlutterFire-CLI fördert dieselbe Aufteilung über `--android-out`. Löst Ihre Debug-Variante eine Datei aus einem Entwicklungs-Firebase-Projekt auf und Ihre Release-Variante eine aus der Produktion, dann unterscheiden sich `options.getApplicationId()`, der Persistenzschlüssel und damit der Name der Speicherdatei.

Die Folge ist eindeutig: Eine von einer Variante geschriebene Sitzung ist für die andere unsichtbar, und eine von der Release-Variante vor dem Konfigurationswechsel geschriebene Sitzung ist danach unsichtbar. Schritt 3 oben findet das mit einem einzigen Befehl. Die Lösung ist kein Code, sondern die Gewissheit, dass die ausgelieferte Variante sich immer gegen dasselbe Projekt anmeldet und wieder ausliest, und dass alle Testenden wissen: Ein Konfigurationswechsel entspricht einer Abmeldung.

Ein `applicationIdSuffix` im Debug erzeugt eine verwandte, aber einfachere Lage: zwei getrennte Installationen mit getrennten Sandboxes. Das ist erwartetes Verhalten und meist nicht das, was gemeldet wird.

## Ursache 2: R8 ist im Release aktiv, die Standardkonfiguration ist aber sicher

Flutter aktiviert Code-Shrinking für Release-Builds selbst. Aus dem Flutter-Gradle-Plugin, verifiziert gegen ein lokales SDK 3.44.8, in dem diese Logik seit 3.44 unverändert ist:

```kotlin
// packages/flutter_tools/gradle/src/main/kotlin/FlutterPlugin.kt
if (FlutterPluginUtils.shouldShrinkResources(project)) {
    val releaseBuildType: BuildType = ...buildTypes.getByName("release")
    releaseBuildType.isMinifyEnabled = true
    releaseBuildType.isShrinkResources = FlutterPluginUtils.isBuiltAsApp(project)
    releaseBuildType.proguardFiles.add(...getDefaultProguardFile("proguard-android-optimize.txt"))
    releaseBuildType.proguardFiles.add(flutterProguardRules)
    // plus android/app/proguard-rules.pro if it exists
}
```

`shouldShrinkResources` liefert true, solange die Gradle-Property `shrink` nicht ausdrücklich false ist, und das Kommandozeilen-Flag `--shrink` ist inzwischen ein dokumentierter No-Op: Sein Hilfetext lautet "This flag has no effect. Code shrinking is always enabled in release builds." R8 läuft also über Ihren Release-Build, egal was in Ihrer `build.gradle.kts` steht.

Damit ist R8 trotzdem nicht der wahrscheinliche Schuldige, denn `firebase-auth` liefert Consumer-Regeln mit, die AGP automatisch anwendet. Die gesamte `proguard.txt` im AAR 24.2.0 lautet:

```proguard
-keepclassmembers class * extends com.google.android.gms.internal.firebase-auth-api.zzalt {
  <fields>;
}
-dontwarn rx.**
-dontwarn android.crypto.hpke.**
```

Greifen Sie zu Schritt 4, statt spekulative Regeln wie `-keep class com.google.firebase.** { *; }` hinzuzufügen. Eine pauschale Keep-Regel verdeckt die Frage, statt sie zu beantworten, und wenn der Usage-Report zeigt, dass aus `com.google.firebase.auth` nichts entfernt wurde, ist dieser Zweig dauerhaft ausgeschlossen.

## Ursache 3: Die Erneuerung wird abgelehnt, und nur im Release

Beim Kaltstart stellt das SDK den Benutzer von der Festplatte wieder her und erneuert dann das ID-Token, das eine Stunde gültig ist, gegen `securetoken.googleapis.com`. Das SDK behandelt einen Transportfehler und eine Ablehnung unterschiedlich. Ein Transportfehler lässt den gespeicherten Benutzer stehen, weshalb ein Gerät ohne Verbindung angemeldet bleibt. Eine Ablehnung mit einem eindeutigen Code aus der Fehlertabelle des SDK, etwa `TOKEN_EXPIRED`, `USER_DISABLED` und `USER_NOT_FOUND`, löscht den gespeicherten Benutzer und feuert den Auth-State-Listener mit null. Deshalb ist das Symptom eine saubere Abmeldung und kein Hängenbleiben.

Zwei Konfigurationen machen aus einer funktionierenden Erneuerung eine abgelehnte, und zwar nur für Release-Builds.

**API-Key-Einschränkungen, die auf das Debug-Zertifikat begrenzt sind.** Trägt der Firebase-API-Key eine Anwendungseinschränkung vom Typ Android apps, muss jede Anfrage einen Paketnamen und einen SHA-1-Zertifikat-Fingerabdruck vorlegen, die auf der Liste stehen. Ein auf den SHA-1 des Debug-Keystores beschränkter Key funktioniert unter `flutter run` einwandfrei und liefert `403 PERMISSION_DENIED` mit "Requests from this Android client application are blocked", sobald die App für das Release signiert ist. Es gibt eine zweite, unangenehmere Variante davon. Firebase dokumentiert, dass Authentication zwei APIs in der API-Einschränkungsliste des Keys braucht: die Identity Toolkit API (`identitytoolkit.googleapis.com`) und die Token Service API (`securetoken.googleapis.com`). Erlauben Sie nur die erste, erhalten Sie genau das gemeldete Bild: Das Anmelden gelingt, die Erneuerung beim nächsten Start nicht.

**App-Check-Erzwingung.** Wird App Check für Authentication erzwungen, muss der Client ein Attestierungstoken mitschicken. Die übliche Flutter-Konfiguration wechselt den Provider je nach Build-Modus:

```dart
// firebase_app_check, called after Firebase.initializeApp()
await FirebaseAppCheck.instance.activate(
  androidProvider: kDebugMode ? AndroidProvider.debug : AndroidProvider.playIntegrity,
);
```

Der Debug-Provider wird von Hand in der Firebase-Konsole registriert und funktioniert bei Ihnen immer. Play Integrity braucht den SHA-256-Fingerabdruck des Zertifikats, mit dem die installierte App tatsächlich signiert ist, und bei Play App Signing ist das Googles Schlüssel, nicht Ihr Upload-Schlüssel. Fehlt er, scheitert App Check nur in der Produktion. Firebase weist außerdem darauf hin, dass Builds, die nicht über Google Play verteilt werden, das Urteil `PLAY_RECOGNIZED` nicht erhalten können. Ein intern verteiltes Release-APK braucht daher die entsprechend gelockerte erweiterte Einstellung, sonst scheitert die Attestierung auf einem völlig gesunden Gerät.

Beides sind Fingerabdruck-Probleme, und dieselbe Falle erwischt Entwickelnde zweimal: `flutter run --release` signiert mit der Debug-Konfiguration, weil Flutters eigenes Template das absichtlich so macht. Der Kommentar in der generierten `android/app/build.gradle.kts` sagt es: "Signing with the debug keys for now, so `flutter run --release` works." Ein Release-Build, der von Ihrem Rechner funktioniert und aus Play heraus scheitert, ist ein Fingerabdruck-Unterschied, kein Build-Modus-Unterschied.

## Ursache 4: Ihr eigener Code meldet ab

Wenn Speicher, Konfiguration und Fingerabdrücke stimmen, bleibt nur, dass die App es selbst getan hat. Die übliche Form ist ein Startaufruf, der das Firebase-ID-Token gegen eine Sitzung in Ihrem eigenen Backend tauscht:

```dart
// The bug: any failure is treated as an invalid session.
try {
  final token = await FirebaseAuth.instance.currentUser!.getIdToken();
  await api.exchange(token);
} catch (_) {
  await FirebaseAuth.instance.signOut(); // wipes a perfectly good session
}
```

Im Debug läuft dieser catch-Block nie. Im Release landet dort eine Ablehnung von App Check oder vom API-Key, und Ihr eigener Code meldet den Benutzer ab. Das bleibt bestehen, weil der Speicher beim nächsten Start wirklich leer ist. Unterscheiden Sie die Fälle am Code:

```dart
try {
  final token = await FirebaseAuth.instance.currentUser!.getIdToken();
  await api.exchange(token);
} on FirebaseAuthException catch (e) {
  const fatal = {'user-token-expired', 'user-disabled', 'user-not-found', 'invalid-user-token'};
  if (fatal.contains(e.code)) {
    await FirebaseAuth.instance.signOut();
  } else {
    // network-request-failed, too-many-requests, and anything unexpected:
    // keep the session and retry later.
  }
}
```

Diesen Pfad abzusichern bedeutet auch, dass Sie die Shell nicht verlassen, während ein asynchroner Aufruf noch läuft. Das ist dieselbe Disziplin wie [das Abbrechen von Stream-Subscriptions in dispose](/de/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/).

## Stolperfallen, die so aussehen, es aber nicht sind

**Die Antwort mit der fehlenden INTERNET-Berechtigung ist für Firebase Auth falsch.** Flutters Template `src/main/AndroidManifest.xml` deklariert keine Berechtigungen, während die generierten Manifeste in `src/debug/` und `src/profile/` beide `android.permission.INTERNET` deklarieren, mit dem Hinweis, dass das Tool sie für Hot Reload braucht. Das bricht tatsächlich einfache Aufrufe mit `http` oder `dio` in Release-Builds. Firebase Auth bricht es nicht, denn das Bibliotheks-Manifest von `firebase-auth` 24.2.0 deklariert die Berechtigung selbst, und der Manifest-Merger übernimmt sie in Ihr APK:

```xml
<!-- com.google.firebase:firebase-auth:24.2.0, AndroidManifest.xml -->
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
```

Prüfen Sie es für Ihren eigenen Build, statt einer der beiden Behauptungen zu glauben: `build/app/outputs/logs/manifest-merger-release-report.txt` hält fest, welche Bibliothek welchen Knoten beigesteuert hat.

**Android Auto Backup kann einem Gerät eine veraltete Sitzung unterschieben.** `android:allowBackup` ist standardmäßig true und `SharedPreferences`-Dateien sind eingeschlossen, der Auth-Speicher reist also über Cloud-Backup und Gerät-zu-Gerät-Übertragung mit. Weder Flutters Template noch das `firebase-auth`-Manifest schließen ihn aus. Häufen sich Ihre Meldungen bei neuen, aus einem Backup wiederhergestellten Geräten, schließen Sie ihn ausdrücklich aus:

```xml
<!-- android/app/src/main/res/xml/data_extraction_rules.xml, API 31+ -->
<data-extraction-rules>
  <cloud-backup>
    <exclude domain="sharedpref" />
  </cloud-backup>
  <device-transfer>
    <exclude domain="sharedpref" />
  </device-transfer>
</data-extraction-rules>
```

**Deinstallieren löscht den Speicher, und das Löschen der App-Daten ebenso.** Firebase dokumentiert das als einzigen unterstützten Weg, die native Persistenz zu leeren. Wer als Testperson ein frisches APK nach einer Deinstallation aufspielt, reproduziert Ihren Fehler nicht.

## Verwandt

Wenn Sie sich durch Android-Release- und Firebase-Probleme in einer Flutter-App arbeiten, decken diese Beiträge die benachbarten Fehler ab: die [Singleton-Migration von `google_sign_in` 7.x](/de/2026/08/fix-the-class-googlesignin-doesnt-have-an-unnamed-constructor-in-flutter/), die ändert, wie Sie Credentials beschaffen, bevor Sie sie an Firebase Auth übergeben, das [Reihenfolgeproblem beim APNs-Token](/de/2026/08/fix-firebase-messaging-apns-token-not-set-on-flutter-ios/), das unter iOS dasselbe Bild von "funktioniert im Debug, still im Release" erzeugt, die [Ablehnung wegen 16-KB-Speicherseitengröße](/de/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/), die schon den Release-Upload blockiert, und die [Edge-to-Edge-Layoutänderung beim Targeting von SDK 35](/de/2026/08/fix-flutter-ui-overlaps-the-android-navigation-bar-after-targeting-sdk-35/), die im selben Upgrade-Fenster ankommt.

## Quellen

- [Get Started with Firebase Authentication on Flutter](https://firebase.google.com/docs/auth/flutter/start) - die Aussage, dass native Persistenz nicht konfigurierbar ist, und der Unterschied zwischen `authStateChanges`, `idTokenChanges` und `userChanges`.
- [Learn about and manage API keys for Firebase](https://firebase.google.com/docs/projects/api-keys) - Authentication benötigt sowohl die Identity Toolkit API als auch die Token Service API in der Zulassungsliste eines API-Keys.
- [Get started using App Check with Play Integrity on Android](https://firebase.google.com/docs/app-check/android/play-integrity-provider) - die Pflicht zur SHA-256-Registrierung und der `PLAY_RECOGNIZED`-Vorbehalt für Builds, die außerhalb von Google Play verteilt werden.
- [flutterfire issue #12727](https://github.com/firebase/flutterfire/issues/12727) - der 403 "Requests from this Android client application are blocked", den Android-Anwendungseinschränkungen auf dem API-Key erzeugen.
- `com.google.firebase:firebase-auth:24.2.0` - `com/google/firebase/auth/internal/zzce` für den Namen des `SharedPreferences`-Speichers, `com/google/firebase/auth/internal/zzaq` für die Tabelle der Server-Fehlercodes sowie die mitgelieferten `proguard.txt` und `AndroidManifest.xml`.
- `firebase_auth` 6.6.1 - `android/.../FlutterFirebaseAuthPlugin.kt` für `getPluginConstantsForFirebaseApp` und `firebase_auth_platform_interface` `method_channel_firebase_auth.dart` für die Streams, die `currentUser` erneut ausgeben.
- Flutter SDK 3.44.8 - `packages/flutter_tools/gradle/src/main/kotlin/FlutterPlugin.kt` für die Shrinking-Standardwerte im Release, `runner/flutter_command.dart` für das No-Op-Flag `--shrink` sowie die Manifest- und Gradle-Templates in `android.tmpl`.
