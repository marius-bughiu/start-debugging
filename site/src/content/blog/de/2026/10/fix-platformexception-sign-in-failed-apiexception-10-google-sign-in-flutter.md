---
title: "Fix: PlatformException(sign_in_failed, com.google.android.gms.common.api.ApiException: 10) bei Google Sign-In in Flutter"
description: "ApiException: 10 ist DEVELOPER_ERROR: Google erkennt die Kombination aus Paketname und SHA-1 des Signaturzertifikats der installierten APK nicht. Registrieren Sie den SHA-1 des Schlüssels, der den Build tatsächlich signiert hat, und übergeben Sie die Web-Client-ID als serverClientId."
pubDate: 2026-10-20
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "google-sign-in"
  - "firebase"
lang: "de"
translationOf: "2026/10/fix-platformexception-sign-in-failed-apiexception-10-google-sign-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-20
---

`ApiException: 10` ist `CommonStatusCodes.DEVELOPER_ERROR`: Google Play services hat die Anmeldung abgelehnt, weil das Paar "Android-Paketname + SHA-1 des Zertifikats, mit dem die installierte APK signiert wurde" zu keinem Android-OAuth-Client im Google-Cloud-Projekt hinter Ihrer `serverClientId` passt. Ihr Dart-Code ist in Ordnung. Führen Sie `./gradlew signingReport` aus (oder `apksigner verify --print-certs` für die exakt installierte APK), registrieren Sie diesen SHA-1 für genau diese `applicationId` und fügen Sie für Store-Builds den SHA-1 von Play App Signing hinzu. Prüfen Sie anschließend, ob `serverClientId` die **Web**-Client-ID ist und nicht die Android-ID. Verifiziert mit `google_sign_in` 6.3.0 (`google_sign_in_android` 6.2.1) und `google_sign_in` 7.2.0 (`google_sign_in_android` 7.2.18, `play-services-auth` 21.6.0, `androidx.credentials` 1.6.0) unter Flutter 3.44.8 mit AGP 9.0.1.

## Der Fehler im Wortlaut

Unter `google_sign_in` 6.x wirft `GoogleSignIn().signIn()` auf Android Folgendes:

```
PlatformException(sign_in_failed, com.google.android.gms.common.api.ApiException: 10: , null, null)
```

Unter `google_sign_in` 7.x erreicht dieselbe Fehlkonfiguration Sie nicht mehr als `PlatformException`. Das Android-Plugin der 7.x-Reihe meldet Fehler als strukturierte Ergebnisse, und die Dart-Seite macht daraus eine `GoogleSignInException`. Je nachdem, welcher Schritt scheitert, sehen Sie eine dieser Meldungen:

```
GoogleSignInException(code GoogleSignInExceptionCode.unknownError, [28444] Developer console is not set up correctly., null)
GoogleSignInException(code GoogleSignInExceptionCode.canceled, ...)
GoogleSignInException(code GoogleSignInExceptionCode.unknownError, Authorization failed: 10: ..., null)
```

Die erste stammt von Credential Manager während `authenticate()`. Die zweite ist die tückische: Die README des Plugins warnt selbst, dass manche Konfigurationsfehler dazu führen, dass Credential Manager nach der Kontoauswahl "canceled" zurückgibt, und das Plugin kann das nicht von einem echten Abbruch unterscheiden. Die dritte kommt von `authorizationClient.authorizeScopes()`, das weiterhin über den Play-services-`AuthorizationClient` läuft und denselben Statuscode 10 meldet. Wenn Sie von 6.x auf 7.x migriert haben und sich der Fehler "geändert" hat, haben Sie vermutlich nichts behoben, die gleiche Ursache wird nur anders gemeldet.

## Warum Google DEVELOPER_ERROR zurückgibt

Die Zahlen sind Konstanten in Play services, keine Magie. Ich habe sie aus den JARs ausgelesen, die Gradle für diese Reproduktion aufgelöst hat:

```bash
# play-services-basement 18.1.0, play-services-auth 21.6.0
javap -constants -cp classes.jar com.google.android.gms.common.api.CommonStatusCodes
#   public static final int DEVELOPER_ERROR = 10;
javap -constants -cp classes.jar com.google.android.gms.auth.api.signin.GoogleSignInStatusCodes
#   public static final int SIGN_IN_FAILED = 12500;
#   public static final int SIGN_IN_CANCELLED = 12501;
```

In `google_sign_in_android` 6.2.1 bildet `errorCodeForStatus` 12501 auf `sign_in_canceled` ab, 4 auf `sign_in_required`, 7 auf `network_error` und lässt alles andere, einschließlich 10, zu `sign_in_failed` durchfallen, mit `e.toString()` als Meldung. Deshalb enthält der Text, nach dem Sie suchen, immer den voll qualifizierten Klassennamen `ApiException`.

Was DEVELOPER_ERROR in der Praxis bedeutet: Google identifiziert eine Android-App anhand ihres Paketnamens und des SHA-1-Fingerabdrucks ihres Signaturzertifikats, wie in Googles Leitfaden [Authenticating Your Client](https://developers.google.com/android/guides/client-auth) beschrieben. Fordert die App ein ID-Token für eine Web-Client-ID an, sucht Google im **selben Projekt** nach einem Android-OAuth-Client mit diesem Paketnamen und diesem Fingerabdruck. Ohne Treffer gibt es Fehler 10. Nach Häufigkeit sortiert sind die Ursachen:

1. **Der SHA-1 des Schlüssels, der diesen Build signiert hat, ist nicht registriert.** Meist ist es der Release-Schlüssel oder der Play-App-Signing-Schlüssel, manchmal der Debug-Schlüssel auf einem anderen Rechner oder in der CI.
2. **Der Paketname stimmt nicht überein.** Ein Flavor mit `applicationIdSuffix` installiert `com.example.app.dev`, registriert ist aber nur `com.example.app`.
3. **Als `serverClientId` wird die falsche Client-ID übergeben.** Die Android-Client-ID statt der Web-ID oder ein Web-Client aus einem anderen Google-Cloud-Projekt.
4. **Eine veraltete `google-services.json`** ohne Web-OAuth-Client-Eintrag, sodass das Plugin nichts oder die falsche `default_web_client_id` übernimmt.

## Minimale Reproduktion

Das kleinste Setup, das den Fehler erzeugt, ist eine korrekte Dart-Seite mit einem Google-Cloud-Projekt, das den Signaturschlüssel nicht kennt. Dies ist der 7.x-Code. Nichts daran ist falsch, und genau das ist der Punkt:

```dart
// Flutter 3.44.8, google_sign_in 7.2.0 (google_sign_in_android 7.2.18)
import 'package:flutter/material.dart';
import 'package:google_sign_in/google_sign_in.dart';

// Web OAuth client ID (client_type 3), NOT the Android one.
const String kWebClientId = '1234567890-abc.apps.googleusercontent.com';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await GoogleSignIn.instance.initialize(serverClientId: kWebClientId);
  runApp(const MaterialApp(home: SignInPage()));
}

class SignInPage extends StatelessWidget {
  const SignInPage({super.key});

  Future<void> _signIn() async {
    try {
      final GoogleSignInAccount user = await GoogleSignIn.instance.authenticate();
      debugPrint('Signed in as ${user.email}');
    } on GoogleSignInException catch (e) {
      // e.code is a GoogleSignInExceptionCode, e.description holds the
      // platform message, for example "[28444] Developer console is not set up correctly".
      debugPrint('Google Sign-In failed: ${e.code.name} / ${e.description}');
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        body: Center(
          child: FilledButton(onPressed: _signIn, child: const Text('Sign in')),
        ),
      );
}
```

Das Projekt drumherum ist die Standardvorlage von `flutter create` mit einer Änderung, die die meisten echten Apps haben: ein `dev`-Flavor mit `applicationIdSuffix = ".dev"` und ein Release-Build, der mit einem Upload-Keystore signiert ist. Wenn nur der Debug-SHA-1 für das Basispaket registriert ist, scheitert jede Variante außer `prodDebug` mit Fehler 10. Ich habe für diesen Beitrag keine echte Anmeldung gegen ein Google-Cloud-Projekt durchgeführt (dafür braucht es ein echtes Konto auf einem Gerät mit Play); die Ausgaben zu Build, Signatur und Paketname unten sind an genau diesem Projekt gemessen.

## Fix 1: den SHA-1 des Schlüssels registrieren, der den Build tatsächlich signiert hat

Raten Sie nicht, welcher Schlüssel das ist. Fragen Sie Gradle. Aus dem Ordner `android/` des Flutter-Projekts:

```bash
# Flutter 3.44.8, AGP 9.0.1, OpenJDK 17
cd android
./gradlew signingReport
```

Die Ausgabe listet jede Variante mit Keystore und Fingerabdrücken auf. Im Reproduktionsprojekt, gekürzt:

```
Variant: devDebug
Config: debug
Store: /Users/<you>/.android/debug.keystore
SHA1: <debug-sha1>
Variant: devRelease
Config: upload
Store: .../android/app/upload-keystore.jks
SHA1: 16:AF:74:41:29:46:E2:5B:13:BB:A5:A4:29:C5:CC:D8:36:83:06:E9
Variant: prodRelease
Config: upload
Store: .../android/app/upload-keystore.jks
SHA1: 16:AF:74:41:29:46:E2:5B:13:BB:A5:A4:29:C5:CC:D8:36:83:06:E9
```

Zwei Dinge lassen sich daraus ablesen. Erstens sind Debug und Release verschiedene Schlüssel, sie brauchen also zwei Fingerabdrücke. Zweitens liegt der Debug-Keystore in `~/.android/debug.keystore` auf **jedem Rechner**. Der Laptop Ihres Kollegen und Ihr CI-Runner erzeugen beim ersten Build jeweils ihren eigenen, mit unterschiedlichen Fingerabdrücken. "Bei mir funktioniert es, bei dir Fehler 10" ist genau das.

Tragen Sie den Fingerabdruck dann dort ein, wo Ihr Projekt verwaltet wird:

- **Firebase**: Project settings, Your apps, die Android-App auswählen, Add fingerprint. Firebase legt den passenden Android-OAuth-Client im zugrunde liegenden Google-Cloud-Projekt für Sie an.
- **Nur Google Cloud**: Google Auth Platform, Clients, Create client, Typ Android, Paketname und SHA-1 eingeben. Ein Android-Client pro Paar aus (Paketname, SHA-1).

Brauchen Sie den Fingerabdruck eines bereits vorhandenen Builds, lesen Sie ihn aus dem Artefakt und nicht aus dem Keystore, von dem Sie glauben, er sei verwendet worden. Für eine APK nutzen Sie `apksigner` aus den Android build-tools:

```bash
# Android build-tools 36.1.0
apksigner verify --print-certs build/app/outputs/flutter-apk/app-dev-release.apk
# Signer #1 certificate DN: CN=Repro
# Signer #1 certificate SHA-256 digest: af3cbfe5...cc071a0a
# Signer #1 certificate SHA-1 digest: 16af74412946e25b13bba5a429c5ccd8368306e9
```

Verwenden Sie `keytool -printcert -jarfile` nicht für eine Flutter-APK. In diesem Projekt gibt es `Not a signed jar file` aus, weil `minSdk` der Vorlage 24 ist und AGP nur mit APK Signature Scheme v2 signiert (`apksigner verify -v` meldet `Verified using v1 scheme (JAR signing): false`). `keytool -printcert -jarfile` funktioniert dagegen mit der `.aab`, die mit dem Upload-Schlüssel jar-signiert ist.

### Store-Builds: auch den Play-App-Signing-Schlüssel hinzufügen

Das ist die Ursache hinter den meisten Meldungen der Art "funktioniert in meiner Release-APK, scheitert bei Installation aus Google Play". Bei Play App Signing, das für neue Apps verpflichtend ist, entfernt Google Ihre Upload-Signatur und signiert die ausgelieferten APKs mit seinem eigenen App-Signing-Schlüssel neu. Der SHA-1, den die Geräte Ihrer Nutzer vorlegen, gehört zu **diesem** Schlüssel, den Sie lokal nie hatten. Kopieren Sie ihn aus der Play Console unter Test and release, App integrity, App signing, "App signing key certificate" und registrieren Sie ihn neben dem Upload-Schlüssel. Interne Testtracks werden auf dieselbe Weise neu signiert, sie decken das Problem also auf, bevor es die Produktion tut.

Die Standardvorlage von Flutter verschärft das: Ihr `release`-Build-Typ signiert mit dem Debug-Schlüssel ("Signing with the debug keys for now, so `flutter run --release` works"). Ein Release-Build, der lokal funktioniert, ist unter Umständen schlicht ein mit Debug-Schlüssel signierter Build und beweist nichts über den Schlüssel, den Play verwenden wird.

## Fix 2: den Paketnamen registrieren, der tatsächlich installiert ist

`signingReport` gibt keine Paketnamen aus. Lesen Sie den installierten aus der APK:

```bash
# Android build-tools 36.1.0
aapt2 dump badging build/app/outputs/flutter-apk/app-dev-release.apk | head -1
# package: name='net.startdebugging.gsiapp.dev' versionCode='1' versionName='0.1.0' ...
```

Das `applicationIdSuffix` des `dev`-Flavors hat aus `net.startdebugging.gsiapp` die ID `net.startdebugging.gsiapp.dev` gemacht, und das ist aus Googles Sicht eine andere App. Jeder Flavor braucht seinen eigenen Android-OAuth-Client (Firebase: eine eigene Android-App mit eigener `google-services.json` unter `android/app/src/<flavor>/`). Beachten Sie, dass der `namespace` in `build.gradle.kts` hier keine Rolle spielt: Nur die `applicationId` (plus Suffixe) wird vom Gerät gemeldet. Wenn Flavors neu für Sie sind, erklärt [was ein Flutter-Flavor ist und wie er sich von einem Build-Modus unterscheidet](/de/2026/10/what-is-a-flutter-flavor-and-how-is-it-different-from-a-build-mode/), wo `applicationIdSuffix` ins Spiel kommt.

## Fix 3: die Web-Client-ID als serverClientId übergeben

Das ID-Token wird für Ihren **Server** ausgestellt, daher ist die Client-ID, die Sie dem Plugin geben, der Web-Application-Client (Firebase nennt ihn in `google-services.json` `client_type: 3`). Die Android-Client-ID wird nie im Code übergeben, Google findet sie über Paketname und SHA-1. Wird die Android-Client-ID als `serverClientId` übergeben, oder ein Web-Client aus einem anderen Projekt, entsteht derselbe Fehler 10.

```dart
// google_sign_in 7.2.0
await GoogleSignIn.instance.initialize(
  // From Google Auth Platform > Clients, type "Web application",
  // in the SAME project as the Android client.
  serverClientId: '1234567890-web.apps.googleusercontent.com',
);
```

```dart
// google_sign_in 6.3.0 (legacy API)
final googleSignIn = GoogleSignIn(
  serverClientId: '1234567890-web.apps.googleusercontent.com',
  scopes: ['email'],
);
```

Lassen Sie `serverClientId` weg, greifen beide Plugin-Versionen auf die String-Ressource `default_web_client_id` zurück, die das Gradle-Plugin `google-services` aus `google-services.json` erzeugt. Fehlt diese Ressource in 7.x ebenfalls, erhalten Sie einen anderen, expliziten Fehler: `GoogleSignInExceptionCode.clientConfigurationError` mit "serverClientId must be provided on Android". Sehen Sie diesen, enthält Ihre `google-services.json` keinen `oauth_client`-Eintrag mit `client_type: 3`. Aktivieren Sie Google als Anmeldeanbieter in Firebase (oder fügen Sie dem Projekt eine Web-App hinzu) und laden Sie die Datei erneut herunter.

## Fix 4: google-services.json neu herunterladen und warten

Nachdem Sie Fingerabdrücke in Firebase hinzugefügt haben, laden Sie `google-services.json` erneut herunter und ersetzen Sie `android/app/google-services.json`. Streng genommen wird der Android-Client serverseitig zugeordnet, die Datei ist also vor allem für `default_web_client_id` relevant, aber eine Datei aus der Zeit vor der Änderung ist eine häufige Quelle für einen veralteten oder fehlenden Web-Client-Eintrag. Führen Sie dann `flutter clean` aus, damit die generierten Ressourcen neu erstellt werden. Änderungen in Google Cloud wirken auch nicht immer sofort; geben Sie einem frisch hinzugefügten Fingerabdruck ein paar Minuten (Berichte, dass es länger dauert, sind häufig), bevor Sie schließen, dass es nicht geklappt hat.

## Fallstricke und ähnliche Fehler

**`ApiException: 12500` ist nicht derselbe Fehler.** 12500 ist `SIGN_IN_FAILED`. Er tritt bei Problemen wie einem unvollständigen OAuth-Zustimmungsbildschirm auf (fehlende Support-E-Mail, fehlender App-Name), nicht bei unbekanntem Paket und Fingerabdruck. Korrigieren Sie zuerst die Konfiguration des Zustimmungsbildschirms.

**`ApiException: 12501` ist ein Abbruch**, und das 6.x-Plugin bildet ihn auf `sign_in_canceled` ab. Hat der Nutzer nicht wirklich abgebrochen, prüfen Sie erneut die Konfiguration, besonders unter 7.x, wo Credential Manager eine Fehlkonfiguration als Abbruch tarnen kann.

**`ApiException: 7` ist ein Netzwerkfehler** (`network_error` in 6.x). Emulatoren ohne Konnektivität erzeugen ihn, nicht eine Fehlkonfiguration.

**Kein Konto auf dem Gerät.** Unter 7.x führt ein Emulator ohne angemeldetes Google-Konto, oder mit deaktivierten "Sign in with Google"-Aufforderungen in den Google-Kontoeinstellungen, zu `NoCredentialException`, die das Plugin als "No credential available" meldet. Das ist Gerätezustand, nicht Fehler 10. Verwenden Sie ein Emulator-Image mit Google Play.

**Die Migration auf 7.x ändert nichts an der SHA-Anforderung.** Credential Manager nutzt dieselbe Android-OAuth-Client-Suche. Stecken Sie mitten in der Migration und hängen an der Änderung des Konstruktors, behandelt [der Beitrag zur GoogleSignIn-Singleton-Migration](/de/2026/08/fix-the-class-googlesignin-doesnt-have-an-unnamed-constructor-in-flutter/) die API-Seite.

**Firebase Auth obendrauf.** Geben Sie das Google-ID-Token an `FirebaseAuth.signInWithCredential` weiter, bleiben auch bei korrekter Google-Konfiguration Release-Probleme auf Firebase-Seite möglich, etwa API-Key-Einschränkungen, die an den Debug-SHA-1 gebunden sind. Diese werden in [Firebase-Auth-Anmeldung, die in einem Release-Build nicht bestehen bleibt](/de/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/) behandelt.

**Fehler nur im Release können andere Ursachen haben.** Stürzt der Release-Build ab, bevor die Anmeldung überhaupt erreicht wird, ist das ein anderes Problem, siehe [die Lösung für "Could not create Dart VM instance" im Release-Build](/de/2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build/).

## Eine Checkliste, die es klärt

1. Bauen Sie die exakte Variante, die scheitert, und führen Sie `apksigner verify --print-certs` und `aapt2 dump badging` für diese APK aus.
2. Prüfen Sie im Google-Cloud-Projekt, dem Ihre Web-Client-ID gehört, ob ein Android-Client mit genau diesem Paketnamen und SHA-1 existiert.
3. Fügen Sie für aus Play installierte Builds den SHA-1 des App-signing-key-Zertifikats aus der Play Console hinzu.
4. Stellen Sie sicher, dass `serverClientId` (oder `default_web_client_id`) der Web-Client desselben Projekts ist.
5. Laden Sie `google-services.json` neu herunter, führen Sie `flutter clean` aus, bauen Sie neu und geben Sie Google ein paar Minuten.

Stimmen alle fünf Punkte und Sie erhalten dennoch Fehler 10, betrachten Sie mit hoher Wahrscheinlichkeit ein anderes Projekt als dasjenige, bei dem das Token angefordert wird. Vergleichen Sie das numerische Präfix der Web-Client-ID mit der Projektnummer in der Console.

## Verwandte Beiträge

- [Fix: The class 'GoogleSignIn' doesn't have an unnamed constructor](/de/2026/08/fix-the-class-googlesignin-doesnt-have-an-unnamed-constructor-in-flutter/)
- [Fix: Firebase Auth sign-in does not persist in a Flutter Android release build](/de/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/)
- [What is a Flutter flavor and how is it different from a build mode?](/de/2026/10/what-is-a-flutter-flavor-and-how-is-it-different-from-a-build-mode/)
- [Fix: Could not create Dart VM instance in a Flutter release build](/de/2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build/)

## Quellen

- [google_sign_in_android README: Integration and Troubleshooting](https://pub.dev/packages/google_sign_in_android)
- [google_sign_in on pub.dev](https://pub.dev/packages/google_sign_in)
- [Authenticating Your Client (SHA-1 fingerprints, signingReport)](https://developers.google.com/android/guides/client-auth)
- [CommonStatusCodes reference](https://developers.google.com/android/reference/com/google/android/gms/common/api/CommonStatusCodes)
- [Credential Manager troubleshooting guide](https://developer.android.com/identity/sign-in/credential-manager-troubleshooting-guide)
- [Use Play App Signing](https://support.google.com/googleplay/android-developer/answer/9842756)
- [FlutterFire discussion #18477: ApiException 10 only in the Google Play version](https://github.com/firebase/flutterfire/discussions/18477)
