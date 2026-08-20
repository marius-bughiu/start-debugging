---
title: "Lösung: The class 'GoogleSignIn' doesn't have an unnamed constructor"
description: "google_sign_in 7.0.0 hat GoogleSignIn zum Singleton gemacht. Ersetzen Sie GoogleSignIn(scopes: ...) durch GoogleSignIn.instance, warten Sie einmal auf initialize() und rufen Sie authenticate() auf."
pubDate: 2026-08-20
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "google-sign-in"
  - "firebase"
lang: "de"
translationOf: "2026/08/fix-the-class-googlesignin-doesnt-have-an-unnamed-constructor-in-flutter"
translatedBy: "claude"
translationDate: 2026-08-20
---

`GoogleSignIn` wurde in `google_sign_in` 7.0.0 (veröffentlicht am 2025-06-24) zu einem Singleton, deshalb kompiliert `GoogleSignIn(...)` nicht mehr. Verwenden Sie `GoogleSignIn.instance`, warten Sie beim Start genau einmal auf die neue Methode `initialize()` und rufen Sie `authenticate()` statt `signIn()` auf. Für das Argument `scopes:`, das Sie früher an den Konstruktor übergeben haben, gibt es keinen direkten Ersatz: Autorisierung ist jetzt ein eigener Schritt über `user.authorizationClient`. Eine automatische Migration existiert nicht, planen Sie also echte Zeit für eine echte Anwendung ein.

## Der vollständige Fehler

Der Analyzer meldet dies gegen eine `pubspec.yaml`, die `google_sign_in` 7.x auflöst, auf jeder Plattform:

```
error - The class 'GoogleSignIn' doesn't have an unnamed constructor. Try using one
        of the named constructors defined in 'GoogleSignIn' - lib\auth.dart:5:36 -
        new_with_undefined_constructor_default
```

Der Hinweis führt ins Leere. Der einzige benannte Konstruktor der Klasse ist `GoogleSignIn._()`, und der ist paketprivat, es gibt also nichts aufzurufen. Die Diagnose stammt aus der generischen Analyzer-Regel für "kein Standardkonstruktor" und weiß nicht, dass das Paket den Weg über ein statisches Feld vorsieht.

Sie kommt nie allein. `flutter analyze` über eine typische 6.x-Anmeldedatei gegen `google_sign_in` 7.2.0 unter Flutter 3.44.2 erzeugt die vollständige Kaskade:

```
error - The class 'GoogleSignIn' doesn't have an unnamed constructor
error - The method 'signIn' isn't defined for the type 'GoogleSignIn'
error - The method 'isSignedIn' isn't defined for the type 'GoogleSignIn'
error - The method 'signInSilently' isn't defined for the type 'GoogleSignIn'
error - The getter 'accessToken' isn't defined for the type 'GoogleSignInAuthentication'
 info - Uses 'await' on an instance of 'GoogleSignInAuthentication', which is not a
        subtype of 'Future'
```

Das letzte `info` lohnt genaues Lesen. `GoogleSignInAccount.authentication` ist jetzt ein synchroner Getter, jedes `await account.authentication` in Ihrem Code ist damit wirkungslos, und der Analyzer meldet das nur als Lint, nicht als Fehler.

## Warum der Konstruktor in google_sign_in 7.0.0 verschwunden ist

Die 6.x-API war ein Dart-Wrapper über das Google-Sign-In-SDK, das Google sowohl unter Android als auch im Web abgekündigt hat. Unter Android ist der Ersatz Credential Manager zusammen mit `AuthorizationClient`, und Google [weist Entwickler seit September 2024 darauf hin](https://android-developers.googleblog.com/2024/09/streamlining-android-authentication-credential-manager-replaces-legacy-apis.html), dass die alten Anmelde-APIs aus `play-services-auth` verschwinden. Diese SDKs haben eine grundlegend andere Form, entsprechend hat sich auch die Oberfläche des Flutter-Plugins geändert.

Drei dieser Änderungen erklären fast jeden Kompilierfehler, den Sie sehen werden.

Das Plugin modelliert kein "Objekt, das Sie konfigurieren und dann verwenden" mehr. Die zugrunde liegenden SDKs arbeiten prozessweit, und zwei `GoogleSignIn`-Objekte zu erzeugen hat in 6.x ohnehin nie korrekt funktioniert. Der Migrationsleitfaden des Pakets formuliert es deutlich: Die Klasse zum Singleton zu machen erzwingt nur eine bereits bestehende Einschränkung.

Die Konfiguration wanderte vom Konstruktor in einen expliziten asynchronen Aufruf von `initialize()`. Im Web hat dieser Aufruf echte Arbeit zu erledigen und kann spürbar dauern, was ein Konstruktor nicht ausdrücken kann.

Authentifizierung und Autorisierung sind jetzt getrennt. In 6.x bündelte `GoogleSignIn(scopes: [...])` die Frage "wer ist dieser Benutzer" mit "lass mich seine Kontakte lesen" in einem einzigen Einwilligungsdialog. In 7.x authentifizieren Sie zuerst und fragen Scopes erst in dem Moment an, in dem Sie die Daten tatsächlich brauchen.

## Minimales Repro: der 6.x-Code, der nicht mehr kompiliert

```dart
// Flutter 3.44.2, Dart 3.12.2, google_sign_in 7.2.0
// Every line of this compiled fine on google_sign_in 6.3.0.
import 'package:google_sign_in/google_sign_in.dart';

final GoogleSignIn _googleSignIn = GoogleSignIn(
  scopes: <String>['email', 'https://www.googleapis.com/auth/contacts.readonly'],
);

Future<void> signIn() async {
  final GoogleSignInAccount? account = await _googleSignIn.signIn();
  if (account == null) return;
  final GoogleSignInAuthentication auth = await account.authentication;
  print(auth.accessToken);
  print(auth.idToken);
}
```

Greifen Sie hier nicht zu `dart fix`. `dart fix --dry-run` über diese Datei mit installiertem `google_sign_in` 7.2.0 meldet `Nothing to fix!`, weil das Paket keine Kompatibilitätsschichten für die entfernten Member mitliefert. Jede Aufrufstelle ist Handarbeit.

## Wie ersetze ich GoogleSignIn(...) durch das Singleton?

Rufen Sie `initialize()` einmal auf, bevor irgendetwas anderes das Plugin berührt. In einer Flutter-Anwendung heißt das `main()` oder ein einmaliger Bootstrap, nicht `initState` auf einem Anmeldebildschirm, der zweimal auf den Stack gelegt werden kann.

```dart
// Flutter 3.44.2, google_sign_in 7.2.0
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  await GoogleSignIn.instance.initialize(
    // Both are optional. Omit them if your Info.plist GIDClientID or your
    // google-services.json already supplies the values.
    clientId: 'IOS_OR_WEB_CLIENT_ID.apps.googleusercontent.com',
    serverClientId: 'SERVER_CLIENT_ID.apps.googleusercontent.com',
  );

  runApp(const MyApp());
}
```

`initialize()` nimmt `clientId`, `serverClientId`, `nonce` und `hostedDomain` entgegen. Hier übergebene Werte haben Vorrang vor denen in Ihren Plattform-Konfigurationsdateien. Es gibt weder einen `scopes`-Parameter noch `signInOption`: `SignInOption.games` wurde vollständig aus dem Platform Interface entfernt.

Der interaktive Anmeldeaufruf sieht so aus:

```dart
// Flutter 3.44.2, google_sign_in 7.2.0
Future<void> onSignInPressed() async {
  if (!GoogleSignIn.instance.supportsAuthenticate()) {
    return; // Web. See the renderButton section below.
  }
  try {
    final GoogleSignInAccount user = await GoogleSignIn.instance.authenticate();
    final String? idToken = user.authentication.idToken; // no await
  } on GoogleSignInException catch (e) {
    if (e.code == GoogleSignInExceptionCode.canceled) return;
    debugPrint('${e.code}: ${e.description}');
  }
}
```

Zwei Unterschiede auf Typebene sind wichtig. `authenticate()` liefert ein nicht-nullbares `GoogleSignInAccount`, die Prüfung `if (account == null)` aus 6.x ist damit toter Code. Und ein Abbruch ist jetzt eine Exception statt eines null: Bricht der Benutzer ab, wird `GoogleSignInException` mit einem `code` von `GoogleSignInExceptionCode.canceled` geworfen. Wenn Sie die alte null-Prüfung entfernen und das try/catch vergessen, wird jede abgebrochene Anmeldung zu einer unbehandelten Exception in Ihren Logs.

`GoogleSignInExceptionCode` enthält außerdem `interrupted`, `clientConfigurationError`, `providerConfigurationError`, `uiUnavailable`, `userMismatch` und `unknownError`. In 7.0.0 war der Typ versehentlich nicht exportiert und kam in 7.1.0 zurück, fordern Sie also mindestens 7.1.0, wenn Sie darauf switchen wollen.

## Was ersetzt signIn, signInSilently und currentUser?

Jedes entfernte Member und sein 7.x-Äquivalent, geprüft gegen `google_sign_in` 7.2.0:

| google_sign_in 6.x | google_sign_in 7.x |
| --- | --- |
| `GoogleSignIn(...)` | `GoogleSignIn.instance` plus `await initialize(...)` |
| `signIn()` | `authenticate({scopeHint})` |
| `signInSilently()` | `attemptLightweightAuthentication()` |
| `isSignedIn()` | selbst über `authenticationEvents` nachhalten |
| `currentUser` | selbst über `authenticationEvents` nachhalten |
| `onCurrentUserChanged` | `authenticationEvents` |
| `canAccessScopes(scopes)` | `authorizationClient.authorizationForScopes(scopes)` |
| `requestScopes(scopes)` | `authorizationClient.authorizeScopes(scopes)` |
| `account.authHeaders` | `authorizationClient.authorizationHeaders(scopes)` |
| `account.serverAuthCode` | `authorizationClient.authorizeServer(scopes)` |
| `clearAuthCache(token:)` | `clearAuthorizationToken(accessToken:)`, ergänzt in 7.2.0 |
| `signOut()`, `disconnect()` | unverändert |

Die beiden Überlebenden verdienen Beachtung: `signOut()` und `disconnect()` haben Namen und Signatur behalten, und genau deshalb kann eine halb fertige Migration in einer Datei kompilieren und in der nächsten scheitern.

`attemptLightweightAuthentication()` hat einen Rückgabetyp, der wie ein Tippfehler aussieht und keiner ist. Er lautet `Future<GoogleSignInAccount?>?`, also ein nullbares Future. Ein null-Future bedeutet, dass die Plattform nicht schnell antworten kann (das Paket nennt Web mit FedCM als Beispiel). Zeigen Sie dann eine abgemeldete Oberfläche und warten Sie auf `authenticationEvents`, statt auf irgendetwas zu warten.

```dart
// Flutter 3.44.2, google_sign_in 7.2.0
final Future<GoogleSignInAccount?>? attempt =
    GoogleSignIn.instance.attemptLightweightAuthentication();
if (attempt != null) {
  final GoogleSignInAccount? user = await attempt;
}
```

Beachten Sie auch: "leichtgewichtig" ist nicht "still". Die Umbenennung ist Absicht: Im Web kann dabei eine schwebende Anmeldekarte erscheinen, unter Android ein Auswahl-Sheet für das Konto. Standardmäßig schluckt der Aufruf `canceled`, `interrupted` und `uiUnavailable` und liefert dafür null; übergeben Sie `reportAllExceptions: true`, wenn Sie diese Fälle als Exception haben wollen.

## Wohin ist das Argument scopes gewandert?

In einen zweiten, separaten Schritt. `GoogleSignInAccount` stellt einen `authorizationClient` bereit, und dort liegen jetzt die Access Tokens. Die empfohlene Form ist, zuerst eine bestehende Freigabe zu versuchen und die Oberfläche nur dann zu zeigen, wenn das fehlschlägt:

```dart
// Flutter 3.44.2, google_sign_in 7.2.0
const List<String> scopes = <String>[
  'https://www.googleapis.com/auth/contacts.readonly',
];

Future<String> accessTokenFor(GoogleSignInAccount user) async {
  // Returns null instead of prompting if the scopes are not yet granted.
  final GoogleSignInClientAuthorization? existing =
      await user.authorizationClient.authorizationForScopes(scopes);
  if (existing != null) return existing.accessToken;

  // Shows consent UI. Call it from a button press, not from initState.
  final GoogleSignInClientAuthorization granted =
      await user.authorizationClient.authorizeScopes(scopes);
  return granted.accessToken;
}
```

Beide Methoden erreichen denselben Plattform-Einstiegspunkt mit einem einzigen umgelegten Schalter. Der Ablauf gegen ein gefälschtes `GoogleSignInPlatform` in einem Test protokolliert exakt diese Aufruffolge:

```
init
authenticate scopeHint=[]
clientAuth prompt=false     <- authorizationForScopes
clientAuth prompt=true      <- authorizeScopes
```

Wenn Sie den alten kombinierten Einwilligungsdialog wollen, übergeben Sie `scopeHint` an `authenticate()`. Das ist ein Hinweis und mehr nicht: Plattformen, die die Abläufe nicht zusammenlegen können, ignorieren ihn, und das Paket warnt ausdrücklich, dass `authorizationForScopes` danach trotzdem null liefern kann. Schreiben Sie den Ausweichpfad trotzdem.

Für einen Server-Austausch liefert `authorizeServer(scopes)` ein `GoogleSignInServerAuthorization` mit einem `serverAuthCode`. Das ist ein eigener Umlauf zusätzlich zur Client-Autorisierung und die mit Abstand häufigste Überraschung für Anwendungen, die `account.serverAuthCode` bisher direkt aus dem Anmeldeergebnis gelesen haben.

## Wohin ist authentication.accessToken gewandert?

In einen anderen Typ, denn ein Access Token ist ein Autorisierungsartefakt, und `authentication` trägt jetzt nur noch Authentifizierungsartefakte. In 7.x hat `GoogleSignInAuthentication` genau ein Feld:

```dart
// google_sign_in 7.2.0, lib/src/token_types.dart
class GoogleSignInAuthentication {
  const GoogleSignInAuthentication({required this.idToken});
  final String? idToken;
}
```

Das Access Token ist nach `GoogleSignInClientAuthorization.accessToken` gewandert, das nicht nullbar ist, und der Server-Auth-Code nach `GoogleSignInServerAuthorization.serverAuthCode`.

Das ist die Änderung, die Firebase-Auth-Integrationen zerlegt, und die Lösung ist kleiner, als die meisten Migrationsthreads vermuten lassen. `GoogleAuthProvider.credential` in `firebase_auth` 6.5.7 ist als `credential({String? idToken, String? accessToken})` deklariert, mit einem assert, das mindestens einen der beiden Werte verlangt. Ein ID Token allein genügt:

```dart
// Flutter 3.44.2, google_sign_in 7.2.0, firebase_auth 6.5.7
Future<UserCredential> signInWithGoogle() async {
  final GoogleSignInAccount user = await GoogleSignIn.instance.authenticate();

  final AuthCredential credential = GoogleAuthProvider.credential(
    idToken: user.authentication.idToken,
  );
  return FirebaseAuth.instance.signInWithCredential(credential);
}
```

Rufen Sie `authorizeScopes` nicht auf, nur um für diesen Aufruf ein `accessToken` zu erzeugen. Das löst einen Einwilligungsdialog aus, den Ihre Benutzer nicht brauchen, für Scopes, die Sie gar nicht verwenden.

## Was passiert mit authenticate im Flutter-Web?

Es wirft. `google_sign_in_web` 1.1.3 liefert aus `supportsAuthenticate()` `false`, und `authenticate()` wirft:

```
UnimplementedError: authenticate is not supported on the web.
Instead, use renderButton to create a sign-in widget.
```

Google Identity Services verlangt, dass der Anmeldebutton vom eigenen SDK gerendert wird, Ihr eigener `ElevatedButton` kann den Ablauf also nicht auslösen. Sichern Sie mit `supportsAuthenticate()` ab und rendern Sie im Web das Widget aus `package:google_sign_in_web/web_only.dart`, das Ergebnis nehmen Sie über `authenticationEvents` entgegen. Beachten Sie, dass der Migrationsleitfaden dies als `UnsupportedError` beschreibt, während die Implementierung tatsächlich `UnimplementedError` wirft, prüfen Sie also nicht auf den exakten Typ.

Verwandte Web-Falle: `authorizationRequiresUserInteraction()` liefert dort `true`, weil der Autorisierungsablauf ein Popup nutzt, das Browser außerhalb einer Benutzergeste blockieren. `authorizeScopes` aus einem `FutureBuilder` oder aus `initState` aufzurufen funktioniert mobil und scheitert im Web.

## Kann ich einfach google_sign_in 6.x festnageln?

Für kurze Zeit ja. `google_sign_in: 6.3.0` löst unter Flutter 3.44.2 weiterhin sauber auf und zieht `google_sign_in_android` 6.2.1 sowie `google_sign_in_ios` 5.9.0 mit. Nichts im aktuellen stabilen Flutter-SDK blockiert das.

Behandeln Sie es als Überbrückung und nicht als Plan. Die Android-Seite von 6.x sitzt auf den abgekündigten Anmelde-APIs aus `play-services-auth`, von denen [Googles eigene Migrationsseite](https://developer.android.com/identity/sign-in/legacy-gsi-migration) sagt, dass sie entfernt werden. Sie entscheiden über den Zeitpunkt dieser Migration, nicht über das Ob.

## Fallstricke, die eine saubere Kompilierung überleben

**Ein übersprungenes `initialize()` legt den Event-Stream lautlos still.** Das anwendungsseitige Paket erzeugt nur dann Events auf `authenticationEvents`, wenn `initialize()` festgestellt hat, dass die Plattformimplementierung keinen eigenen Event-Stream hat. Ein Test mit einer gefälschten Plattform bestätigt das Fehlerbild: ohne Initialisierung authentifizieren, und der Stream bleibt leer, ohne dass eine Exception fliegt. Die Anmeldung funktioniert, die Oberfläche aktualisiert sich nie.

**`initialize()` mehr als einmal aufzurufen ist undefiniertes Verhalten.** Das Paket dokumentiert es mit genau diesen Worten. Ein Bootstrap, der beim Neuaufbau eines Providers erneut läuft, trifft genau das.

**Unter Android kann ein Konfigurationsfehler als `canceled` ankommen.** Das Credential-Manager-SDK liefert für einige Fehlkonfigurationen einen Abbruch zurück, und das Plugin kann den Unterschied nicht erkennen. Wirft `authenticate()` direkt nach der Kontoauswahl `canceled`, prüfen Sie den Signatur-SHA für diese Build-Variante und ob Ihre `google-services.json` einen `oauth_client`-Eintrag mit `client_type: 3` enthält.

**Ihre Flutter-Version kann die Android-Implementierung deckeln.** `google_sign_in` 7.2.0 selbst verlangt Flutter 3.29 und Dart 3.7, `google_sign_in_android` 7.2.16 dagegen Flutter 3.44 und Dart 3.12. Unter älterem Flutter löst pub ein älteres Implementierungspaket auf, statt zu scheitern, die Plugin-Version in `pubspec.lock` erzählt also nicht die ganze Geschichte. Das ist dieselbe Art Falle wie [das Festnageln der Flutter-Engine-Version für reproduzierbare Builds](/de/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/).

**Die paketeigene `testing.dart` dokumentiert weiterhin die 6.x-API.** `FakeSignInBackend` trägt einen Dokumentationskommentar mit `GoogleSignIn()` und `setMockMethodCallHandler`. Er wurde für 7.x nicht aktualisiert, und die Method-Channel-Namen passen nicht mehr zum Plugin. Schreiben Sie stattdessen ein gefälschtes `GoogleSignInPlatform` und weisen Sie es `GoogleSignInPlatform.instance` zu.

## Verwandt

- Dieselbe Form von Upgrade zeigt sich bei der [Migration von Riverpod 2.x auf Riverpod 3.0](/de/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/), wo die Kompilierfehler der leichte Teil sind und die Verhaltensänderungen nicht.
- Ein Plugin-Upgrade, das Fehlerwerte statt APIs umbenennt: [biometric_signature 10.0.0 und seine neuen BiometricError-Werte](/de/2026/02/biometric_signature-10-0-0-simpleprompt-is-the-feature-new-biometricerror-values-are-the-real-breaking-change-flutter-3-x/).
- Anmeldung ist eine lange asynchrone Lücke, deshalb gilt [setState nach einer asynchronen Lücke mit der mounted-Prüfung absichern](/de/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/) direkt für den Code, den Sie gerade umschreiben.
- Wenn das Plugin-Update auch Ihren iOS-Build zerlegt hat, beginnen Sie bei [CocoaPods could not find compatible versions for pod](/de/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/).
- Um eine Anwendung während einer solchen Migration auf mehr als einem SDK baubar zu halten, siehe [mehrere Flutter-Versionen aus einer CI-Pipeline ansprechen](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).

## Quellen

- [google_sign_in auf pub.dev](https://pub.dev/packages/google_sign_in), Version 7.2.0, veröffentlicht am 2025-09-17. Die im Paket mitgelieferte `MIGRATION.md` ist die maßgebliche Zuordnung von 6.x zu 7.x.
- [google_sign_in Changelog](https://pub.dev/packages/google_sign_in/changelog), für die Liste der Breaking Changes in 7.0.0 und die korrigierte `GoogleSignInExceptionCode`-Exportierung in 7.1.0.
- [google_sign_in_android auf pub.dev](https://pub.dev/packages/google_sign_in_android), dessen README die `serverClientId`-Anforderung und das Verhalten dokumentiert, dass `canceled` eine Fehlkonfiguration bedeuten kann.
- [About the migration from legacy Google Sign-In](https://developer.android.com/identity/sign-in/legacy-gsi-migration) bei Android Developers.
- [Streamlining Android authentication: Credential Manager replaces legacy APIs](https://android-developers.googleblog.com/2024/09/streamlining-android-authentication-credential-manager-replaces-legacy-apis.html), die Ankündigung vom September 2024 hinter der Neufassung des Plugins.

Jede Fehlermeldung, Versionsauflösung und Aufruffolge oben wurde lokal unter Flutter 3.44.2 mit Dart 3.12.2 reproduziert.
