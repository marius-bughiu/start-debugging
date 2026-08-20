---
title: "Solución: The class 'GoogleSignIn' doesn't have an unnamed constructor"
description: "google_sign_in 7.0.0 convirtió GoogleSignIn en un singleton. Reemplaza GoogleSignIn(scopes: ...) por GoogleSignIn.instance, espera initialize() una vez y llama a authenticate()."
pubDate: 2026-08-20
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "google-sign-in"
  - "firebase"
lang: "es"
translationOf: "2026/08/fix-the-class-googlesignin-doesnt-have-an-unnamed-constructor-in-flutter"
translatedBy: "claude"
translationDate: 2026-08-20
---

`GoogleSignIn` pasó a ser un singleton en `google_sign_in` 7.0.0 (publicado el 2025-06-24), así que `GoogleSignIn(...)` ya no compila. Usa `GoogleSignIn.instance`, espera su nuevo método `initialize()` exactamente una vez al arrancar la aplicación, y llama a `authenticate()` en lugar de `signIn()`. El argumento `scopes:` que antes pasabas al constructor no tiene reemplazo directo: la autorización ahora es un paso aparte, a través de `user.authorizationClient`. No hay migración automática, así que reserva tiempo real para una aplicación real.

## El error, completo

El analizador reporta esto contra un `pubspec.yaml` que resuelve `google_sign_in` 7.x, en cualquier plataforma:

```
error - The class 'GoogleSignIn' doesn't have an unnamed constructor. Try using one
        of the named constructors defined in 'GoogleSignIn' - lib\auth.dart:5:36 -
        new_with_undefined_constructor_default
```

La sugerencia no lleva a ninguna parte. El único constructor con nombre de la clase es `GoogleSignIn._()`, que es privado del paquete, así que no hay nada que puedas llamar. El diagnóstico viene de la regla genérica del analizador para "no hay constructor por defecto" y no sabe que el paquete espera que pases por un campo estático.

Nunca llega solo. Ejecutar `flutter analyze` sobre un archivo de inicio de sesión típico de 6.x contra `google_sign_in` 7.2.0 en Flutter 3.44.2 produce la cascada completa:

```
error - The class 'GoogleSignIn' doesn't have an unnamed constructor
error - The method 'signIn' isn't defined for the type 'GoogleSignIn'
error - The method 'isSignedIn' isn't defined for the type 'GoogleSignIn'
error - The method 'signInSilently' isn't defined for the type 'GoogleSignIn'
error - The getter 'accessToken' isn't defined for the type 'GoogleSignInAuthentication'
 info - Uses 'await' on an instance of 'GoogleSignInAuthentication', which is not a
        subtype of 'Future'
```

Vale la pena leer con atención ese último `info`. `GoogleSignInAccount.authentication` ahora es un getter síncrono, así que cada `await account.authentication` en tu código es una operación sin efecto que el analizador solo marca como advertencia de estilo, no como error.

## Por qué desapareció el constructor en google_sign_in 7.0.0

La API de 6.x era una envoltura en Dart sobre el SDK de Google Sign-In, que Google marcó como obsoleto tanto en Android como en Web. En Android el reemplazo es Credential Manager más `AuthorizationClient`, y Google [lleva avisando a los desarrolladores desde septiembre de 2024](https://android-developers.googleblog.com/2024/09/streamlining-android-authentication-credential-manager-replaces-legacy-apis.html) de que las APIs heredadas de inicio de sesión de `play-services-auth` van a desaparecer. Esos SDKs tienen una forma fundamentalmente distinta, así que la superficie del plugin de Flutter cambió con ellos.

Tres de esos cambios explican casi todos los errores de compilación con los que te vas a encontrar.

El plugin ya no modela "un objeto que configuras y luego usas". Los SDKs subyacentes operan a nivel de proceso, y crear dos objetos `GoogleSignIn` en 6.x nunca funcionó realmente. La guía de migración del paquete es directa al respecto: convertir la clase en un singleton solo impone una restricción que ya existía.

La configuración se movió del constructor a una llamada asíncrona explícita a `initialize()`. En web esa llamada tiene trabajo real que hacer y puede tardar un tiempo apreciable, algo que un constructor no puede expresar.

La autenticación y la autorización ahora están separadas. En 6.x, `GoogleSignIn(scopes: [...])` juntaba "quién es este usuario" con "déjame leer sus contactos" en un solo diálogo de consentimiento. En 7.x primero te autenticas y luego pides los scopes en el momento en que realmente necesitas los datos.

## Reproducción mínima: el código 6.x que deja de compilar

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

No recurras a `dart fix` aquí. Ejecutar `dart fix --dry-run` sobre este archivo con `google_sign_in` 7.2.0 instalado reporta `Nothing to fix!`, porque el paquete no incluye ningún adaptador de compatibilidad para los miembros eliminados. Cada punto de llamada es una edición manual.

## Cómo reemplazo GoogleSignIn(...) por el singleton

Llama a `initialize()` una vez, antes de que cualquier otra cosa toque el plugin. En una aplicación Flutter eso significa `main()` o un arranque de una sola ejecución, no `initState` en una pantalla de inicio de sesión que puede apilarse dos veces.

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

`initialize()` acepta `clientId`, `serverClientId`, `nonce` y `hostedDomain`. Los valores que pases aquí tienen prioridad sobre los de tus archivos de configuración de plataforma. No hay parámetro `scopes` ni `signInOption`: `SignInOption.games` se eliminó por completo de la interfaz de plataforma.

La llamada interactiva de inicio de sesión queda así:

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

Hay dos diferencias a nivel de tipos que importan. `authenticate()` devuelve un `GoogleSignInAccount` no anulable, así que la guarda `if (account == null)` de 6.x ahora es código muerto. Y la cancelación es una excepción en lugar de un null: si el usuario se echa atrás se lanza `GoogleSignInException` con un `code` igual a `GoogleSignInExceptionCode.canceled`. Si borras la vieja comprobación de null y olvidas el try/catch, cada inicio de sesión cancelado se convierte en una excepción no controlada en tus registros.

`GoogleSignInExceptionCode` también incluye `interrupted`, `clientConfigurationError`, `providerConfigurationError`, `uiUnavailable`, `userMismatch` y `unknownError`. Por accidente quedó sin exportar en 7.0.0 y se restauró en 7.1.0, así que exige al menos la 7.1.0 si quieres hacer un switch sobre él.

## Qué reemplaza a signIn, signInSilently y currentUser

Cada miembro eliminado y su equivalente en 7.x, verificado contra `google_sign_in` 7.2.0:

| google_sign_in 6.x | google_sign_in 7.x |
| --- | --- |
| `GoogleSignIn(...)` | `GoogleSignIn.instance` más `await initialize(...)` |
| `signIn()` | `authenticate({scopeHint})` |
| `signInSilently()` | `attemptLightweightAuthentication()` |
| `isSignedIn()` | lo rastreas tú desde `authenticationEvents` |
| `currentUser` | lo rastreas tú desde `authenticationEvents` |
| `onCurrentUserChanged` | `authenticationEvents` |
| `canAccessScopes(scopes)` | `authorizationClient.authorizationForScopes(scopes)` |
| `requestScopes(scopes)` | `authorizationClient.authorizeScopes(scopes)` |
| `account.authHeaders` | `authorizationClient.authorizationHeaders(scopes)` |
| `account.serverAuthCode` | `authorizationClient.authorizeServer(scopes)` |
| `clearAuthCache(token:)` | `clearAuthorizationToken(accessToken:)`, añadido en 7.2.0 |
| `signOut()`, `disconnect()` | sin cambios |

Vale la pena señalar los dos supervivientes: `signOut()` y `disconnect()` conservaron nombres y firmas, y por eso una migración a medias puede compilar en un archivo y fallar en el siguiente.

`attemptLightweightAuthentication()` tiene un tipo de retorno que parece una errata y no lo es. Devuelve `Future<GoogleSignInAccount?>?`, un future anulable. Un future nulo significa que la plataforma no puede responder rápido (el ejemplo que da el paquete es web con FedCM), así que deberías mostrar una interfaz de sesión cerrada y esperar a `authenticationEvents` en lugar de esperar nada con `await`.

```dart
// Flutter 3.44.2, google_sign_in 7.2.0
final Future<GoogleSignInAccount?>? attempt =
    GoogleSignIn.instance.attemptLightweightAuthentication();
if (attempt != null) {
  final GoogleSignInAccount? user = await attempt;
}
```

Ten en cuenta también que "ligero" no es "silencioso". El cambio de nombre es deliberado: en web esto puede mostrar una tarjeta flotante de inicio de sesión, y en Android una hoja de selección de cuenta. Por defecto la llamada se traga `canceled`, `interrupted` y `uiUnavailable` y devuelve null en esos casos; pasa `reportAllExceptions: true` si quieres que se lancen.

## A dónde se fue el argumento scopes

A un segundo paso, separado. `GoogleSignInAccount` expone un `authorizationClient`, y ahí es donde viven ahora los tokens de acceso. La forma recomendada es intentar primero con una concesión existente y solo mostrar la interfaz si eso falla:

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

Esos dos métodos llegan al mismo punto de entrada de la plataforma con un solo indicador cambiado. Ejecutar el flujo contra un `GoogleSignInPlatform` falso en una prueba registra exactamente esta secuencia de llamadas:

```
init
authenticate scopeHint=[]
clientAuth prompt=false     <- authorizationForScopes
clientAuth prompt=true      <- authorizeScopes
```

Si quieres el antiguo diálogo de consentimiento combinado, pasa `scopeHint` a `authenticate()`. Es una pista y nada más: las plataformas que no pueden combinar los flujos lo ignoran, y el paquete advierte explícitamente de que `authorizationForScopes` puede seguir devolviendo null después. Escribe la ruta alternativa de todos modos.

Para un intercambio con el servidor, `authorizeServer(scopes)` devuelve un `GoogleSignInServerAuthorization` que lleva un `serverAuthCode`. Es un viaje de ida y vuelta distinto del de la autorización de cliente, y esa es la sorpresa más común para las aplicaciones que antes leían `account.serverAuthCode` directamente del resultado del inicio de sesión.

## A dónde se fue authentication.accessToken

Se mudó a otro tipo, porque un token de acceso es un artefacto de autorización y `authentication` ahora solo lleva artefactos de autenticación. En 7.x, `GoogleSignInAuthentication` tiene exactamente un campo:

```dart
// google_sign_in 7.2.0, lib/src/token_types.dart
class GoogleSignInAuthentication {
  const GoogleSignInAuthentication({required this.idToken});
  final String? idToken;
}
```

El token de acceso se mudó a `GoogleSignInClientAuthorization.accessToken`, que no es anulable, y el código de autorización de servidor a `GoogleSignInServerAuthorization.serverAuthCode`.

Este es el cambio que rompe las integraciones con Firebase Auth, y la solución es más pequeña de lo que sugieren la mayoría de los hilos sobre la migración. `GoogleAuthProvider.credential` en `firebase_auth` 6.5.7 está declarado como `credential({String? idToken, String? accessToken})` con un assert que exige al menos uno de los dos. Un token de ID por sí solo basta:

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

No llames a `authorizeScopes` solo para producir un `accessToken` para esta llamada. Eso dispara un diálogo de consentimiento que tus usuarios no necesitan, para scopes que no vas a usar.

## Qué pasa con authenticate en Flutter web

Lanza una excepción. `google_sign_in_web` 1.1.3 devuelve `false` desde `supportsAuthenticate()`, y `authenticate()` lanza:

```
UnimplementedError: authenticate is not supported on the web.
Instead, use renderButton to create a sign-in widget.
```

Google Identity Services exige que el botón de inicio de sesión lo dibuje su propio SDK, así que tu `ElevatedButton` personalizado no puede disparar el flujo. Protégete con `supportsAuthenticate()` y, en web, dibuja el widget de `package:google_sign_in_web/web_only.dart` y recoge el resultado en `authenticationEvents`. Fíjate en que la guía de migración describe esto como un `UnsupportedError` mientras que la implementación en realidad lanza `UnimplementedError`, así que no hagas coincidir el tipo exacto.

Trampa relacionada, solo en web: `authorizationRequiresUserInteraction()` devuelve `true` ahí, porque el flujo de autorización usa una ventana emergente que los navegadores bloquean fuera de un gesto del usuario. Llamar a `authorizeScopes` desde un `FutureBuilder` o desde `initState` funciona en móvil y falla en web.

## Puedo simplemente fijar google_sign_in 6.x

Por un tiempo corto, sí. `google_sign_in: 6.3.0` todavía se resuelve limpiamente en Flutter 3.44.2, arrastrando `google_sign_in_android` 6.2.1 y `google_sign_in_ios` 5.9.0. Nada en el SDK estable actual de Flutter lo bloquea.

Trátalo como un parche temporal y no como un plan. El lado Android de 6.x se apoya en las APIs obsoletas de inicio de sesión de `play-services-auth` que [la propia página de migración de Google](https://developer.android.com/identity/sign-in/legacy-gsi-migration) dice que se eliminarán. Estás eligiendo cuándo hacer esta migración, no si la haces.

## Trampas que sobreviven a una compilación limpia

**Saltarte `initialize()` mata el flujo de eventos en silencio.** El paquete de cara a la aplicación solo sintetiza eventos en `authenticationEvents` si `initialize()` determinó que la implementación de plataforma no tiene un flujo de eventos propio. Una prueba con una plataforma falsa confirma el modo de fallo: autentícate sin inicializar y el flujo se queda vacío sin lanzar ninguna excepción. El inicio de sesión funciona, la interfaz nunca se actualiza.

**Llamar a `initialize()` más de una vez es comportamiento indefinido.** El paquete lo documenta con esas palabras. Un arranque que se vuelve a ejecutar al reconstruirse un proveedor caerá en esto.

**En Android, un error de configuración puede llegar como `canceled`.** El SDK de Credential Manager devuelve una cancelación ante ciertas configuraciones incorrectas, y el plugin no tiene forma de distinguirlas. Si `authenticate()` lanza `canceled` justo después del selector de cuenta, revisa el SHA de firma de esa variante de compilación y confirma que tu `google-services.json` contiene una entrada `oauth_client` con `client_type: 3`.

**Tu versión de Flutter puede limitar la implementación de Android.** `google_sign_in` 7.2.0 en sí requiere Flutter 3.29 y Dart 3.7, pero `google_sign_in_android` 7.2.16 requiere Flutter 3.44 y Dart 3.12. En versiones más antiguas de Flutter, pub resuelve un paquete de implementación más viejo en vez de fallar, así que la versión del plugin en `pubspec.lock` no cuenta toda la historia. Es la misma clase de trampa que [fijar la versión del motor de Flutter para compilaciones reproducibles](/es/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/).

**El propio `testing.dart` del paquete todavía documenta la API de 6.x.** `FakeSignInBackend` lleva un comentario de documentación que muestra `GoogleSignIn()` y `setMockMethodCallHandler`. No se actualizó para 7.x, y sus nombres de canal de métodos ya no coinciden con el plugin. Escribe un `GoogleSignInPlatform` falso y asígnalo a `GoogleSignInPlatform.instance` en su lugar.

## Relacionado

- La misma forma de actualización aparece al [migrar de Riverpod 2.x a Riverpod 3.0](/es/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/), donde los errores de compilación son la parte fácil y los cambios de comportamiento no lo son.
- Una actualización de plugin que renombra valores de error en lugar de APIs: [biometric_signature 10.0.0 y sus nuevos valores BiometricError](/es/2026/02/biometric_signature-10-0-0-simpleprompt-is-the-feature-new-biometricerror-values-are-the-real-breaking-change-flutter-3-x/).
- El inicio de sesión es un largo hueco asíncrono, así que [proteger setState con la comprobación mounted tras un hueco asíncrono](/es/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/) aplica directamente al código que estás reescribiendo.
- Si subir el plugin también rompió tu compilación de iOS, empieza por [CocoaPods could not find compatible versions for pod](/es/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/).
- Para mantener una aplicación compilable en más de un SDK mientras aterriza una migración así, mira [cómo apuntar a varias versiones de Flutter desde un solo pipeline de CI](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).

## Fuentes

- [google_sign_in en pub.dev](https://pub.dev/packages/google_sign_in), versión 7.2.0, publicada el 2025-09-17. El `MIGRATION.md` que viene dentro del paquete es el mapeo autoritativo de 6.x a 7.x.
- [Registro de cambios de google_sign_in](https://pub.dev/packages/google_sign_in/changelog), para la lista de cambios que rompen compatibilidad de 7.0.0 y la corrección de la exportación de `GoogleSignInExceptionCode` en 7.1.0.
- [google_sign_in_android en pub.dev](https://pub.dev/packages/google_sign_in_android), cuyo README documenta el requisito de `serverClientId` y el comportamiento de `canceled` como señal de mala configuración.
- [About the migration from legacy Google Sign-In](https://developer.android.com/identity/sign-in/legacy-gsi-migration) en Android Developers.
- [Streamlining Android authentication: Credential Manager replaces legacy APIs](https://android-developers.googleblog.com/2024/09/streamlining-android-authentication-credential-manager-replaces-legacy-apis.html), el anuncio de septiembre de 2024 detrás de la reescritura del plugin.

Cada cadena de error, resolución de versiones y secuencia de llamadas de este artículo se reprodujo localmente en Flutter 3.44.2 con Dart 3.12.2.
