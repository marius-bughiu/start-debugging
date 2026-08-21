---
title: "Solución: [firebase_messaging/apns-token-not-set] APNS token has not been set en Flutter iOS"
description: "getToken() se ejecuta antes de que APNs entregue el token del dispositivo a iOS. Consulta getAPNSToken() hasta que devuelva un valor no nulo y luego llama a getToken()."
pubDate: 2026-08-21
template: error-page
tags:
  - "errors"
  - "flutter"
  - "ios"
  - "firebase"
  - "dart"
lang: "es"
translationOf: "2026/08/fix-firebase-messaging-apns-token-not-set-on-flutter-ios"
translatedBy: "claude"
translationDate: 2026-08-21
---

Llamaste a `FirebaseMessaging.instance.getToken()` antes de que APNs entregara el token del dispositivo a iOS, y el plugin se niega a continuar. Consulta `getAPNSToken()` en un bucle hasta que devuelva un valor no nulo y luego llama a `getToken()`. Si sigue siendo nulo pasados diez segundos, tienes un problema de configuración, no una condición de carrera: falta la capacidad Push Notifications, la inicialización automática está desactivada o estás en un simulador que no puede registrarse. Esto está verificado contra `firebase_messaging` 16.5.0 y `firebase_core` 4.13.0 en Flutter 3.44.2.

## El error en contexto

Las versiones actuales del plugin lanzan esto:

```
[firebase_messaging/apns-token-not-set] APNS token has not been received on the device yet. Please ensure the APNS token is available before calling `getAPNSToken()`.
```

Las versiones anteriores lo redactaban de otra forma, y por eso los resultados de búsqueda para este problema están repartidos entre dos cadenas:

```
[firebase_messaging/apns-token-not-set] APNS token has not been set yet. Please ensure the APNS token is available by calling `getAPNSToken()`.
```

Ambas son la misma `FirebaseException`, ambas llevan `code: 'apns-token-not-set'` y ambas provienen del mismo lugar. El mensaje es engañoso de una forma muy concreta: te dice que llames a `getAPNSToken()`, pero `getAPNSToken()` es exactamente lo que acaba de fallar. Lo que quiere decir es "espera hasta que `getAPNSToken()` devuelva algo".

## Por qué falta el token cuando se ejecuta getToken

La comprobación vive en Dart, no en el código nativo. En `firebase_messaging_platform_interface` 4.9.3, `method_channel_messaging.dart` define una guarda privada:

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

Del lado nativo, `getAPNSToken` es una lectura directa sin espera y sin reintentos:

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

Ese es todo el mecanismo. `FIRMessaging.APNSToken` es nil hasta que iOS llama a `application:didRegisterForRemoteNotificationsWithDeviceToken:`, y ese callback se dispara según los tiempos de Apple, después de una ida y vuelta de red hacia APNs. Normalmente llega en uno o dos segundos tras el arranque, pero nada en tu aplicación controla cuándo. La propia documentación de Firebase enuncia la restricción con claridad: en el SDK de iOS 10.4.0 y superiores, el token de APNs debe estar disponible antes de realizar solicitudes a la API.

Así que el error no significa "algo está roto". En el caso habitual significa "preguntaste demasiado pronto".

## Qué llamadas aplican realmente la comprobación

Exactamente cuatro métodos esperan a `_APNSTokenCheck()` en 4.9.3: `deleteToken()`, `getToken()`, `subscribeToTopic()` y `unsubscribeFromTopic()`. Todo lo demás, incluidos `requestPermission()`, `getInitialMessage()` y el stream `onMessage`, se ejecuta sin ella.

Esto explica un patrón reportado que de otro modo parece contradictorio: las solicitudes de permiso aparecen con normalidad y los mensajes en primer plano llegan, pero `subscribeToTopic()` lanza la excepción. La suscripción a temas está protegida por la guarda; la entrega de mensajes no.

`getAPNSToken()` en sí no está protegido. Devuelve nulo en lugar de lanzar una excepción, que es lo que hace seguro consultarlo en un bucle.

## ¿Cómo es una reproducción mínima?

Cualquier aplicación que obtenga el token durante el arranque se topará con esto en un inicio en frío:

```dart
// Flutter 3.44.2, firebase_core 4.13.0, firebase_messaging 16.5.0
Future<String?> brokenRegisterForPush() async {
  await Firebase.initializeApp();
  return FirebaseMessaging.instance.getToken();
}
```

Falla de forma intermitente, que es la peor propiedad que tiene este error. En un arranque en caliente, o en un dispositivo que ya se registró hace poco, el token suele estar ya en caché dentro de `FIRMessaging` y la llamada funciona. En una instalación limpia, con una red lenta o en el primer arranque tras reinstalar la aplicación, falla. Prueba en una instalación limpia antes de dar por hecho que lo solucionaste.

## ¿Cómo espero el token de APNs antes de llamar a getToken?

No existe ningún callback ni stream para "el token de APNs ya está disponible", así que consultarlo en bucle es el enfoque admitido. Este helper pasa el análisis limpio contra `firebase_messaging` 16.5.0:

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

El retorno nulo en Android y web importa. Si escribes la guarda como un simple bucle `while (token == null)` sin la comprobación de plataforma, `getAPNSToken()` devuelve nulo para siempre en Android y giras en vacío hasta agotar el tiempo en cada arranque de Android. La implementación de la platform interface cortocircuita a nulo para cualquier plataforma que no sea de Apple antes incluso de tocar el method channel.

Conéctalo al registro:

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

Haz lo mismo antes de las llamadas a temas, ya que también están protegidas:

```dart
// Flutter 3.44.2, firebase_messaging 16.5.0
Future<void> subscribeSafely(String topic) async {
  await waitForAPNSToken();
  await FirebaseMessaging.instance.subscribeToTopic(topic);
}
```

Si prefieres no reestructurar el código de arranque existente, captura la excepción y reintenta una vez. Esto es estrictamente peor que esperar desde el principio, porque desperdicia una ida y vuelta fallida primero, pero es un cambio pequeño:

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

Ten en cuenta que el permiso es un asunto distinto de la disponibilidad del token. Registrarse para notificaciones remotas es lo que produce el token de dispositivo de APNs, y el plugin hace eso durante el registro, no como respuesta a la solicitud de permiso. Un usuario que rechace el aviso de notificaciones puede seguir teniendo un token de APNs válido, que es lo que permite que funcione el push silencioso en segundo plano.

## ¿Qué ocurre cuando la inicialización automática está desactivada?

Esta es la causa que se le escapa a la gente, y vale la pena entenderla porque el síntoma es un token que nunca llega por mucho que esperes en el bucle.

Si `FirebaseMessagingAutoInitEnabled` está en `NO` en tu `Info.plist`, o llamaste a `setAutoInitEnabled(false)` y quedó persistido, el plugin ni siquiera se registra para notificaciones remotas al arrancar:

```objc
// FLTFirebaseMessagingPlugin.m, firebase_messaging 16.5.0
if ([FIRMessaging messaging].isAutoInitEnabled) {
  [self registerForRemoteNotifications];
}
```

Y aunque otra parte de tu aplicación se registre, el callback del delegado guarda el token y retorna sin entregarlo a `FIRMessaging`:

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

`FIRMessaging.APNSToken` sigue siendo nil, así que `getAPNSToken()` continúa devolviendo nulo y tu bucle agota el tiempo, aunque iOS sí le haya dado a la aplicación un token de dispositivo.

La vía de recuperación existe, pero tienes que activarla. `setAutoInitEnabled(true)` llama a `registerForRemoteNotifications` y luego vuelca el token guardado, y ese volcado también se ejecuta al principio de cada llamada de método que atiende el plugin:

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

Si retrasas deliberadamente el registro de FCM por motivos de consentimiento, está bien, pero `await messaging.setAutoInitEnabled(true)` tiene que ir antes de esperar el token. Por eso aparece en `registerForPush()` más arriba.

## Qué revisar cuando el token nunca llega

Recorre esta lista en orden. Los dos primeros puntos explican la mayoría de los casos en los que el bucle agota el tiempo en un dispositivo físico.

1. **Capacidad Push Notifications.** En Xcode, abre el target Runner, ve a Signing and Capabilities y confirma que Push Notifications aparece en la lista. Sin ella, la aplicación no tiene el entitlement `aps-environment`, `registerForRemoteNotifications` falla e iOS llama a `didFailToRegisterForRemoteNotificationsWithError:` en su lugar. El plugin registra ese error con `NSLog` y nada más, así que es fácil pasarlo por alto. Revisa la consola de Xcode buscando una línea sobre que la aplicación no tiene derecho a usar push.
2. **Background Modes.** Activa Background fetch y Remote notifications. La guía de configuración de FlutterFire exige ambos, y APNs es necesario tanto para la mensajería en primer plano como en segundo plano.
3. **Clave de APNs subida a Firebase.** Firebase Console, Project Settings, pestaña Cloud Messaging. Se requiere al menos una clave. Que falte la clave no bloquea el token de APNs en sí, pero rompe todo lo que viene después, así que resuélvelo ya que estás.
4. **Method swizzling.** La guía de cliente de Firebase para Flutter es explícita en que el swizzling es obligatorio y en que sin él la gestión del token de FCM no funcionará. Si pusiste `FirebaseAppDelegateProxyEnabled` en `NO` en `Info.plist`, tienes que reenviar tú mismo los callbacks del delegado de APNs. La solución más simple es eliminar esa clave.
5. **Bundle ID que no coincide.** El identificador de paquete en Xcode debe coincidir con el de `GoogleService-Info.plist`. Una discrepancia aquí produce fallos confusos más adelante en lugar de un error claro.

## ¿El simulador de iOS te da un token de APNs?

A veces, y las condiciones son lo bastante estrictas como para enunciarlas con exactitud. El simulador admite notificaciones remotas reales y tokens de dispositivo reales solo en iOS 16 y posteriores, ejecutándose en macOS 13 o posterior, en un Mac con Apple silicon o un chip T2. Los tokens son únicos para la combinación de ese simulador y ese Mac, y el simulador se registra contra el entorno sandbox de APNs.

Fuera de esa combinación, el simulador no puede registrarse para notificaciones remotas, `getAPNSToken()` devuelve nulo para siempre y ninguna configuración lo arregla. Antes de Xcode 14 ningún simulador podía producir un token de dispositivo. Si persigues este error en un simulador antiguo, en un Mac Intel o en un runtime de iOS 15, cambia a un dispositivo físico antes de tocar el código.

## Trampas y casos parecidos

**Tipo de token sandbox frente a producción.** El plugin elige el tipo de token de APNs a partir de la macro de preprocesador `DEBUG` en tiempo de compilación, usando `FIRMessagingAPNSTokenTypeSandbox` en compilaciones de depuración y `FIRMessagingAPNSTokenTypeProd` en el resto. Esto nunca provoca `apns-token-not-set`, pero sí causa el clásico reporte de "funciona en debug, silencio en TestFlight". Si las notificaciones dejan de llegar en una compilación de release, mira ahí, no aquí.

**Las reinstalaciones invalidan los tokens.** Borrar y reinstalar la aplicación produce un nuevo token de APNs y un nuevo token de FCM. Los registros de tokens del lado del servidor para la instalación anterior están muertos. Escucha `FirebaseMessaging.instance.onTokenRefresh` y vuelve a subirlo, en lugar de obtenerlo una vez en el primer arranque y guardarlo en caché para siempre.

**Que `getAPNSToken()` devuelva nulo no es esta excepción.** Si ves un token de APNs nulo pero ningún error lanzado, es que llamaste a `getAPNSToken()` directamente. Devuelve nulo por diseño; solo los cuatro métodos protegidos convierten ese nulo en una `FirebaseException`.

**Un timeout de diez segundos es una suposición, no una garantía.** En un dispositivo sin red el callback simplemente nunca se dispara. Trata el timeout como un fallo suave: devuelve nulo, deja que la aplicación siga y reintenta el registro más tarde, en lugar de bloquear tu pantalla de inicio para siempre.

## Relacionado

Si estás lidiando con problemas de compilación e integración de iOS en una aplicación Flutter, estos cubren los fallos vecinos: los [fallos de resolución de versiones de CocoaPods](/es/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/) que aparecen justo después de añadir plugins de Firebase, la [ruptura de la compilación de iOS con Xcode 16](/es/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/) y sus cuatro causas distintas, el [error de destino no encontrado](/es/2026/08/fix-unable-to-find-a-destination-matching-the-provided-destination-specifier-in-a-flutter-ios-build/) provocado por una exclusión de arquitectura obsoleta en el Podfile, el [fallo de la VM de Dart en compilaciones de depuración de iOS](/es/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/) que ningún entitlement puede arreglar, y la [migración al singleton de google_sign_in 7.0](/es/2026/08/fix-the-class-googlesignin-doesnt-have-an-unnamed-constructor-in-flutter/) si estás cableando Firebase Auth al mismo tiempo.

## Fuentes

- [Configurar una aplicación cliente de Firebase Cloud Messaging en Flutter](https://firebase.google.com/docs/cloud-messaging/flutter/client) - el requisito del token de APNs desde el SDK de iOS 10.4.0 en adelante, y el requisito de method swizzling.
- [Guía de integración con Apple de FlutterFire](https://firebase.flutter.dev/docs/messaging/apple-integration/) - capacidad Push Notifications, Background Modes, subida de la clave de APNs.
- `firebase_messaging_platform_interface` 4.9.3, `lib/src/method_channel/method_channel_messaging.dart` - la guarda `_APNSTokenCheck()` y los cuatro métodos que la esperan.
- `firebase_messaging` 16.5.0, `ios/firebase_messaging/Sources/firebase_messaging/FLTFirebaseMessagingPlugin.m` - `messagingGetAPNSToken`, `ensureAPNSTokenSetting` y la condición de inicialización automática en el registro.
- [Issue #10625 de flutterfire](https://github.com/firebase/flutterfire/issues/10625) - el issue que el comentario del código fuente de `_APNSTokenCheck` cita como la razón de que exista la guarda.
- [Soporte de notificaciones push en el simulador con Xcode 14](https://github.com/firebase/firebase-ios-sdk/pull/10503) - el cambio en firebase-ios-sdk que hizo utilizables los tokens de dispositivo del simulador.
