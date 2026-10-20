---
title: "Solución: PlatformException(sign_in_failed, com.google.android.gms.common.api.ApiException: 10) con Google Sign-In en Flutter"
description: "ApiException: 10 es DEVELOPER_ERROR: Google no reconoce el nombre de paquete más el SHA-1 del certificado de firma del APK instalado. Registra el SHA-1 de la clave que realmente firmó la compilación y pasa el ID de cliente Web como serverClientId."
pubDate: 2026-10-20
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "google-sign-in"
  - "firebase"
lang: "es"
translationOf: "2026/10/fix-platformexception-sign-in-failed-apiexception-10-google-sign-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-20
---

`ApiException: 10` es `CommonStatusCodes.DEVELOPER_ERROR`: Google Play services rechazó el inicio de sesión porque el par "nombre de paquete Android + SHA-1 del certificado que firmó el APK instalado" no coincide con ningún cliente OAuth de Android en el proyecto de Google Cloud que está detrás de tu `serverClientId`. Tu código Dart está bien. Ejecuta `./gradlew signingReport` (o `apksigner verify --print-certs` sobre el APK exacto que instalaste), registra ese SHA-1 para ese `applicationId` exacto y agrega el SHA-1 de Play App Signing para las compilaciones de la tienda. Después comprueba que `serverClientId` sea el ID de cliente **Web**, no el de Android. Verificado con `google_sign_in` 6.3.0 (`google_sign_in_android` 6.2.1) y `google_sign_in` 7.2.0 (`google_sign_in_android` 7.2.18, `play-services-auth` 21.6.0, `androidx.credentials` 1.6.0) en Flutter 3.44.8 con AGP 9.0.1.

## El error completo

En `google_sign_in` 6.x, `GoogleSignIn().signIn()` lanza esto en Android:

```
PlatformException(sign_in_failed, com.google.android.gms.common.api.ApiException: 10: , null, null)
```

En `google_sign_in` 7.x la misma configuración incorrecta ya no te llega como un `PlatformException`. El plugin de Android 7.x informa los fallos como resultados estructurados y el lado Dart los convierte en una `GoogleSignInException`. Según el paso que falle, verás uno de estos:

```
GoogleSignInException(code GoogleSignInExceptionCode.unknownError, [28444] Developer console is not set up correctly., null)
GoogleSignInException(code GoogleSignInExceptionCode.canceled, ...)
GoogleSignInException(code GoogleSignInExceptionCode.unknownError, Authorization failed: 10: ..., null)
```

El primero viene de Credential Manager durante `authenticate()`. El segundo es el más molesto: el README del propio plugin advierte que algunos errores de configuración hacen que Credential Manager devuelva "canceled" después de que el usuario elige una cuenta, y el plugin no puede distinguirlo de una cancelación real. El tercero viene de `authorizationClient.authorizeScopes()`, que todavía pasa por el `AuthorizationClient` de Play services y expone el mismo código de estado 10. Si migraste de 6.x a 7.x y el error "cambió", probablemente no arreglaste nada: la misma causa raíz simplemente se reporta de otra forma.

## Por qué Google devuelve DEVELOPER_ERROR

Los números son constantes en Play services, no magia. Los volqué de los jars que Gradle resolvió para este repro:

```bash
# play-services-basement 18.1.0, play-services-auth 21.6.0
javap -constants -cp classes.jar com.google.android.gms.common.api.CommonStatusCodes
#   public static final int DEVELOPER_ERROR = 10;
javap -constants -cp classes.jar com.google.android.gms.auth.api.signin.GoogleSignInStatusCodes
#   public static final int SIGN_IN_FAILED = 12500;
#   public static final int SIGN_IN_CANCELLED = 12501;
```

En `google_sign_in_android` 6.2.1, `errorCodeForStatus` asigna 12501 a `sign_in_canceled`, 4 a `sign_in_required`, 7 a `network_error`, y deja que todo lo demás, incluido el 10, caiga en `sign_in_failed` con `e.toString()` como mensaje. Por eso la cadena que buscas siempre lleva el nombre completo de la clase `ApiException`.

Lo que significa DEVELOPER_ERROR en la práctica: Google identifica una app Android por su nombre de paquete y la huella SHA-1 de su certificado de firma, como se describe en la guía [Authenticating Your Client](https://developers.google.com/android/guides/client-auth) de Google. Cuando la app pide un ID token para un ID de cliente Web, Google busca un cliente OAuth de Android en el **mismo proyecto** con ese nombre de paquete y esa huella. Si no hay coincidencia, error 10. Ordenadas por la frecuencia con la que las veo, las causas son:

1. **El SHA-1 de la clave que firmó esta compilación no está registrado.** Normalmente es la clave de release o la clave de Play App Signing, a veces la clave de debug en otra máquina o en CI.
2. **El nombre de paquete no coincide.** Un flavor con `applicationIdSuffix` instala `com.example.app.dev`, pero solo está registrado `com.example.app`.
3. **Se pasa el ID de cliente equivocado como `serverClientId`.** El ID de cliente de Android en lugar del Web, o un cliente Web de otro proyecto de Google Cloud.
4. **Un `google-services.json` desactualizado** sin una entrada de cliente OAuth Web, de modo que el plugin no recoge nada o recoge un `default_web_client_id` equivocado.

## Repro mínimo

La configuración más pequeña que produce el error es un lado Dart correcto con un proyecto de Google Cloud que no conoce la clave de firma. Este es el código de 7.x. Nada de aquí está mal, y ese es el punto:

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

El proyecto que lo rodea es la plantilla estándar de `flutter create` con un cambio que tienen la mayoría de las apps reales: un flavor `dev` con `applicationIdSuffix = ".dev"` y una compilación de release firmada con un keystore de subida. Registra solo el SHA-1 de debug para el paquete base y todas las variantes excepto `prodDebug` fallan con el error 10. No ejecuté un inicio de sesión real contra un proyecto de Google Cloud para este artículo (eso requiere una cuenta real en un dispositivo con Play); la salida de compilación, firma y nombre de paquete que aparece abajo está medida en este proyecto exacto.

## Solución 1: registra el SHA-1 de la clave que realmente firmó la compilación

No adivines cuál es esa clave. Pregúntale a Gradle. Desde la carpeta `android/` del proyecto Flutter:

```bash
# Flutter 3.44.8, AGP 9.0.1, OpenJDK 17
cd android
./gradlew signingReport
```

La salida lista cada variante con su keystore y sus huellas. En el proyecto del repro, recortada:

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

De aquí se leen dos cosas. Primero, debug y release son claves distintas, así que necesitan dos huellas. Segundo, el keystore de debug vive en `~/.android/debug.keystore` en **cada máquina**. El portátil de tu compañero y tu runner de CI generan cada uno el suyo en la primera compilación, con huellas diferentes. "En mi máquina funciona, en la tuya da error 10" es exactamente esto.

Después agrega la huella donde se administre tu proyecto:

- **Firebase**: Project settings, Your apps, elige la app Android, Add fingerprint. Firebase crea por ti el cliente OAuth de Android correspondiente en el proyecto de Google Cloud subyacente.
- **Solo Google Cloud**: Google Auth Platform, Clients, Create client, tipo Android, ingresa el nombre de paquete y el SHA-1. Un cliente Android por cada par (nombre de paquete, SHA-1).

Si necesitas la huella de una compilación que ya tienes, léela del artefacto en lugar del keystore que crees que se usó. Para un APK, usa `apksigner` de las build-tools de Android:

```bash
# Android build-tools 36.1.0
apksigner verify --print-certs build/app/outputs/flutter-apk/app-dev-release.apk
# Signer #1 certificate DN: CN=Repro
# Signer #1 certificate SHA-256 digest: af3cbfe5...cc071a0a
# Signer #1 certificate SHA-1 digest: 16af74412946e25b13bba5a429c5ccd8368306e9
```

No uses `keytool -printcert -jarfile` sobre un APK de Flutter. En este proyecto imprime `Not a signed jar file`, porque el `minSdk` de la plantilla es 24 y AGP solo firma con APK Signature Scheme v2 (`apksigner verify -v` informa `Verified using v1 scheme (JAR signing): false`). `keytool -printcert -jarfile` sí funciona con el `.aab`, que está firmado como jar con la clave de subida.

### Compilaciones de la tienda: agrega también la clave de Play App Signing

Esta es la causa detrás de la mayoría de los reportes de "funciona en mi APK de release, falla al instalarlo desde Google Play". Con Play App Signing, que es obligatorio para las apps nuevas, Google elimina tu firma de subida y vuelve a firmar los APK que entrega con su propia clave de firma de la app. El SHA-1 que presentan los dispositivos de tus usuarios es el de **esa** clave, que nunca tuviste en local. Cópialo desde Play Console, en Test and release, App integrity, App signing, "App signing key certificate", y regístralo junto a la clave de subida. Las pistas de pruebas internas se vuelven a firmar de la misma manera, así que detectan esto antes que producción.

La plantilla estándar de Flutter lo empeora: su tipo de compilación `release` firma con la clave de debug ("Signing with the debug keys for now, so `flutter run --release` works"). Una compilación de release que funciona en local puede ser simplemente una compilación firmada con debug, lo cual no prueba nada sobre la clave que usará Play.

## Solución 2: registra el nombre de paquete que realmente está instalado

`signingReport` no imprime nombres de paquete. Lee el instalado desde el APK:

```bash
# Android build-tools 36.1.0
aapt2 dump badging build/app/outputs/flutter-apk/app-dev-release.apk | head -1
# package: name='net.startdebugging.gsiapp.dev' versionCode='1' versionName='0.1.0' ...
```

El `applicationIdSuffix` del flavor `dev` convirtió `net.startdebugging.gsiapp` en `net.startdebugging.gsiapp.dev`, que para Google es una app distinta. Cada flavor necesita su propio cliente OAuth de Android (Firebase: su propia app Android con su propio `google-services.json` en `android/app/src/<flavor>/`). Ten en cuenta que el `namespace` de `build.gradle.kts` es irrelevante aquí: solo `applicationId` (más los sufijos) es lo que reporta el dispositivo. Si los flavors son nuevos para ti, [qué es un flavor de Flutter y en qué se diferencia de un modo de compilación](/es/2026/10/what-is-a-flutter-flavor-and-how-is-it-different-from-a-build-mode/) explica dónde entra `applicationIdSuffix`.

## Solución 3: pasa el ID de cliente Web como serverClientId

El ID token se emite para tu **servidor**, así que el ID de cliente que le das al plugin es el cliente de aplicación Web (Firebase lo llama `client_type: 3` en `google-services.json`). El cliente de Android nunca se pasa en el código: Google lo encuentra por nombre de paquete y SHA-1. Pasar el ID de cliente de Android como `serverClientId`, o un cliente Web de otro proyecto, produce el mismo error 10.

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

Si omites `serverClientId`, ambas versiones del plugin recurren al recurso de cadena `default_web_client_id` que el plugin de Gradle `google-services` genera a partir de `google-services.json`. En 7.x, si ese recurso también falta, obtienes un error distinto y explícito: `GoogleSignInExceptionCode.clientConfigurationError` con "serverClientId must be provided on Android". Si lo ves, tu `google-services.json` no tiene ninguna entrada `oauth_client` con `client_type: 3`. Habilita Google como proveedor de inicio de sesión en Firebase (o agrega una app web al proyecto) y descarga el archivo de nuevo.

## Solución 4: vuelve a descargar google-services.json y espera

Después de agregar huellas en Firebase, descarga `google-services.json` otra vez y reemplaza `android/app/google-services.json`. En rigor, el cliente de Android se compara del lado del servidor, así que el archivo importa sobre todo por `default_web_client_id`, pero un archivo anterior al cambio es una fuente común de una entrada de cliente Web desactualizada o ausente. Luego ejecuta `flutter clean` para que se regeneren los recursos generados. Los cambios en Google Cloud tampoco siempre son instantáneos; dale unos minutos a una huella recién agregada (y es común leer reportes de que tarda más) antes de concluir que no funcionó.

## Casos especiales y errores parecidos

**`ApiException: 12500` no es el mismo error.** 12500 es `SIGN_IN_FAILED`. Aparece por problemas como una pantalla de consentimiento OAuth incompleta (falta el correo de soporte o el nombre de la app) y no por un paquete y una huella desconocidos. Arregla primero la configuración de la pantalla de consentimiento.

**`ApiException: 12501` es una cancelación**, y el plugin 6.x la asigna a `sign_in_canceled`. Si un usuario no canceló en realidad, vuelve a revisar la configuración, sobre todo en 7.x, donde Credential Manager puede disfrazar una mala configuración de cancelación.

**`ApiException: 7` es un error de red** (`network_error` en 6.x). Lo producen los emuladores sin conectividad, no una mala configuración.

**No hay ninguna cuenta en el dispositivo.** En 7.x, un emulador sin una cuenta de Google iniciada, o con los avisos de "Sign in with Google" desactivados en los ajustes de la cuenta de Google, produce `NoCredentialException`, que el plugin reporta como "No credential available". Eso es el estado del dispositivo, no el error 10. Usa una imagen de emulador con Google Play.

**Migrar a 7.x no elimina el requisito del SHA.** Credential Manager usa la misma búsqueda del cliente OAuth de Android. Si estás a mitad de la migración y atascado con el cambio del constructor, [el artículo sobre la migración al singleton de GoogleSignIn](/es/2026/08/fix-the-class-googlesignin-doesnt-have-an-unnamed-constructor-in-flutter/) cubre el lado de la API.

**Firebase Auth encima.** Si pasas el ID token de Google a `FirebaseAuth.signInWithCredential`, una configuración correcta de Google aún puede dejar problemas de release del lado de Firebase, como restricciones de la clave de API ligadas al SHA-1 de debug. Esos se tratan en [el inicio de sesión de Firebase Auth que no persiste en una compilación de release](/es/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/).

**Los fallos solo en release pueden no estar relacionados.** Si la compilación de release se bloquea antes de llegar siquiera al inicio de sesión, es un problema distinto, consulta [la solución de "Could not create Dart VM instance" en una compilación de release](/es/2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build/).

## Una lista de comprobación que lo resuelve

1. Compila la variante exacta que falla y ejecuta `apksigner verify --print-certs` y `aapt2 dump badging` sobre ese APK.
2. En el proyecto de Google Cloud que es dueño de tu ID de cliente Web, confirma que existe un cliente Android con exactamente ese nombre de paquete y ese SHA-1.
3. Para las compilaciones instaladas desde Play, agrega el SHA-1 del certificado de la App signing key desde Play Console.
4. Confirma que `serverClientId` (o `default_web_client_id`) sea el cliente Web de ese mismo proyecto.
5. Vuelve a descargar `google-services.json`, ejecuta `flutter clean`, compila de nuevo y dale a Google unos minutos.

Si las cinco comprobaciones pasan y aun así obtienes el error 10, casi seguro estás mirando un proyecto distinto del que se usa para pedir el token. Compara el prefijo numérico del ID de cliente Web con el número de proyecto en la consola.

## Relacionado

- [Solución: The class 'GoogleSignIn' doesn't have an unnamed constructor](/es/2026/08/fix-the-class-googlesignin-doesnt-have-an-unnamed-constructor-in-flutter/)
- [Solución: el inicio de sesión de Firebase Auth no persiste en una compilación de release de Flutter para Android](/es/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/)
- [¿Qué es un flavor de Flutter y en qué se diferencia de un modo de compilación?](/es/2026/10/what-is-a-flutter-flavor-and-how-is-it-different-from-a-build-mode/)
- [Solución: Could not create Dart VM instance en una compilación de release de Flutter](/es/2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build/)

## Fuentes

- [google_sign_in_android README: Integration and Troubleshooting](https://pub.dev/packages/google_sign_in_android)
- [google_sign_in on pub.dev](https://pub.dev/packages/google_sign_in)
- [Authenticating Your Client (SHA-1 fingerprints, signingReport)](https://developers.google.com/android/guides/client-auth)
- [CommonStatusCodes reference](https://developers.google.com/android/reference/com/google/android/gms/common/api/CommonStatusCodes)
- [Credential Manager troubleshooting guide](https://developer.android.com/identity/sign-in/credential-manager-troubleshooting-guide)
- [Use Play App Signing](https://support.google.com/googleplay/android-developer/answer/9842756)
- [FlutterFire discussion #18477: ApiException 10 only in the Google Play version](https://github.com/firebase/flutterfire/discussions/18477)
