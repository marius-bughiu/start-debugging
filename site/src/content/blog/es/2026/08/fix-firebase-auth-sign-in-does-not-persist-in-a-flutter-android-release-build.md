---
title: "Fix: el inicio de sesión de Firebase Auth no persiste en una compilación release de Flutter para Android"
description: "Firebase Auth restaura la sesión de Android desde un archivo SharedPreferences privado sin ninguna llamada de red, así que un cierre de sesión que solo ocurre en release nunca es un fallo de persistencia. Es otro google-services.json, una renovación de token rechazada, App Check o tu propio bloque catch."
pubDate: 2026-08-31
template: how-to
tags:
  - "errors"
  - "flutter"
  - "android"
  - "firebase"
  - "dart"
lang: "es"
translationOf: "2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build"
translatedBy: "claude"
translationDate: 2026-08-31
---

Inicias sesión, cierras la app, la vuelves a abrir y el usuario ya no está. Solo en release. En debug la sesión sobrevive a cada reinicio. Lo importante que debes saber antes de tocar nada es que Firebase Auth en Android restaura al usuario autenticado desde un archivo `SharedPreferences` privado sin ninguna llamada de red, así que "la persistencia está rota en release" casi nunca es lo que está pasando. O la compilación release abre otro archivo de almacenamiento, o algo borró ese almacenamiento: una renovación de token que volvió rechazada en lugar de simplemente fallida, App Check aplicando reglas que solo confían en tu certificado de depuración, o tu propio código de arranque llamando a `signOut()` dentro de un bloque catch. Esto está verificado contra `firebase_auth` 6.6.1 y `firebase_core` 4.14.0 en Flutter 3.47.1 con Dart 3.13.1, resolviendo `com.google.firebase:firebase-auth:24.2.0` en Android.

## Dónde vive realmente la sesión de Android

El plugin de Flutter no implementa la persistencia. La delega al SDK de Android, y el SDK de Android escribe al usuario en un archivo `SharedPreferences`. En `firebase-auth` 24.2.0 el almacenamiento es `com.google.firebase.auth.internal.zzce`, cuyo constructor se resuelve así:

```java
// Decompiled from com.google.firebase:firebase-auth:24.2.0
// zzce(Context, String persistenceKey)
this.zzc = context.getSharedPreferences(
    String.format("com.google.firebase.auth.api.Store.%s", persistenceKey),
    Context.MODE_PRIVATE);
```

La clave de persistencia viene de `FirebaseApp.getPersistenceKey()`, que son dos valores base64 seguros para URL unidos por un signo más:

```java
// com.google.firebase:firebase-common
// getPersistenceKey() == base64Url(appName) + "+" + base64Url(options.getApplicationId())
```

Para la app por defecto, `[DEFAULT]` se codifica como `W0RFRkFVTFRd`, así que una ruta real en el dispositivo se ve así:

```
/data/data/<applicationId>/shared_prefs/com.google.firebase.auth.api.Store.W0RFRkFVTFRd+<base64url of mobilesdk_app_id>.xml
```

De ese constructor se desprenden dos hechos que dirigen toda la investigación. Primero, restaurar al usuario es una lectura de disco. El constructor de `FirebaseAuth` crea `zzce` y saca de ahí al usuario guardado, así que un dispositivo sin red sigue arrancando con la sesión iniciada. Segundo, el nombre del archivo se deriva del ID de app de Google que hay en tu `google-services.json`. Cambia ese valor entre variantes y no habrás perdido una sesión: habrás dejado de abrir el archivo en el que se escribió.

## Por qué `currentUser` no tiene condición de carrera en Android

Hay una afirmación muy repetida según la cual `FirebaseAuth.instance.currentUser` es null durante un instante después del arranque y hay que esperar a `authStateChanges()`. Eso es cierto en web y en los embedders de escritorio. No es cierto en Android, y saberlo te ahorra "arreglar" una condición de carrera que no existe.

El plugin de Android publica al usuario restaurado como constante del plugin durante `Firebase.initializeApp()`:

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

Esas constantes alimentan `MethodChannelFirebaseAuth.setInitialValues`, y los streams reemiten ese valor antes de que llegue nada desde el canal de eventos nativo:

```dart
// firebase_auth_platform_interface, method_channel_firebase_auth.dart
@override
Stream<UserPlatform?> authStateChanges() async* {
  yield currentUser;
  yield* _authStateChangesListeners[app.name]!.stream.map((event) => event.value);
}
```

Así que en Android, una vez que `await Firebase.initializeApp()` ha retornado, `currentUser` ya es correcto y el primer evento de `authStateChanges()` es ese mismo valor. Si es null en release, el almacenamiento estaba realmente vacío. Cambiar `currentUser` por un `StreamBuilder` no cambiará la respuesta, aunque sigue siendo la forma correcta de construir una puerta de autenticación por otros motivos, algo que vale la pena leer junto con [las diferencias entre StreamBuilder y AsyncValue de Riverpod](/es/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/).

## Pasos de diagnóstico que aíslan la causa

Ejecútalos en orden. Cada uno elimina toda una clase de explicación, y los dos primeros toman unos cinco minutos.

1. **Haz depurable la compilación release para poder inspeccionarla.**
   `adb shell run-as` se niega a tocar un paquete que no esté marcado como depurable, y por eso no puedes leer el almacenamiento de un APK release normal. Agrega un build type desechable en `android/app/build.gradle.kts`, compílalo y bórralo cuando termines.

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

2. **Confirma si el archivo de almacenamiento existe y cuál es.**
   Inicia sesión, fuerza la detención y lista el directorio de preferencias de la app. Si el archivo está ahí y no está vacío pero la app sigue arrancando sin sesión, tienes un problema de código, no de almacenamiento. Si el archivo falta, algo lo borró.

   ```bash
   adb shell run-as com.example.app ls -l shared_prefs/
   adb shell run-as com.example.app cat 'shared_prefs/com.google.firebase.auth.api.Store.W0RFRkFVTFRd+...xml'
   ```

3. **Compara el ID de app de Google que cada variante compila de verdad.**
   El plugin de Gradle `google-services` escribe los valores analizados en un archivo de recursos generado por variante. Compáralos. Una diferencia aquí explica el síntoma por completo y no hace falta investigar nada más.

   ```bash
   grep google_app_id android/app/build/generated/res/google-services/debug/values/values.xml
   grep google_app_id android/app/build/generated/res/google-services/release/values/values.xml
   ```

4. **Descarta R8 con el reporte de uso en vez de adivinar.**
   La reducción de código está activada en las compilaciones release de Flutter, así que es un sospechoso legítimo, pero es barato descartarlo. Agrega `-printusage build/r8-usage.txt` a `android/app/proguard-rules.pro`, recompila y busca `com.google.firebase.auth` en el reporte.

5. **Observa la renovación del token.**
   Activa el registro detallado de Firebase Auth y arranca la app en frío con la red encendida. Una renovación que falla con un error de transporte deja la sesión intacta. Una renovación que es rechazada es la que la borra.

   ```bash
   adb shell setprop log.tag.FirebaseAuth VERBOSE
   adb logcat -s FirebaseAuth:V FirebaseApp:V
   ```

6. **Revisa las huellas de certificado registradas en el proyecto.**
   Imprime las huellas con las que tu variante release está firmada realmente y compáralas con la configuración del proyecto en Firebase, las restricciones de la clave de API en Google Cloud y la página de App Signing en Play Console.

   ```bash
   cd android && ./gradlew signingReport
   ```

## Causa 1: la variante release lee otro `google-services.json`

Esta es la respuesta más común y la más fácil de pasar por alto, porque nada en ella parece un problema de autenticación.

Los source sets de Android te dejan poner un `google-services.json` en `android/app/src/debug/`, `android/app/src/prod/` o cualquier directorio de flavor, y el plugin de Gradle elige el más específico para la variante que se está compilando. La CLI de FlutterFire fomenta el mismo esquema con `--android-out`. Si tu variante debug resuelve un archivo de un proyecto de Firebase de desarrollo y tu variante release resuelve uno de producción, entonces `options.getApplicationId()` difiere, la clave de persistencia difiere y el nombre del archivo de almacenamiento difiere.

La consecuencia es precisa: una sesión escrita por una variante es invisible para la otra, y una sesión escrita por la variante release antes de que cambiaras su configuración es invisible después. El paso 3 de arriba lo detecta con un solo comando. El arreglo no es código: es asegurarte de que la variante que publicas inicia sesión y la lee de vuelta contra el mismo proyecto siempre, y de que quien haga pruebas sepa que cambiar la configuración equivale a cerrar sesión.

Un `applicationIdSuffix` en debug produce una situación relacionada pero más simple: dos instalaciones separadas con sandboxes separados. Ese comportamiento es el esperado y normalmente no es lo que la gente reporta.

## Causa 2: R8 está activo en release, pero la configuración de fábrica es segura

Flutter activa la reducción de código para las compilaciones release por su cuenta. Del plugin de Gradle de Flutter, verificado contra un SDK local 3.44.8 donde esta lógica no ha cambiado desde 3.44:

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

`shouldShrinkResources` devuelve true salvo que la propiedad de Gradle `shrink` sea explícitamente false, y la opción de línea de comandos `--shrink` es hoy un no-op documentado: su texto de ayuda dice "This flag has no effect. Code shrinking is always enabled in release builds." Así que sí, R8 corre sobre tu compilación release diga lo que diga tu `build.gradle.kts`.

Aun así, eso no convierte a R8 en el culpable probable, porque `firebase-auth` incluye reglas de consumidor que AGP aplica automáticamente. El `proguard.txt` completo dentro del AAR 24.2.0 es:

```proguard
-keepclassmembers class * extends com.google.android.gms.internal.firebase-auth-api.zzalt {
  <fields>;
}
-dontwarn rx.**
-dontwarn android.crypto.hpke.**
```

Recurre al paso 4 en vez de agregar reglas especulativas como `-keep class com.google.firebase.** { *; }`. Una regla de keep general esconde la pregunta en lugar de responderla, y si el reporte de uso muestra que no se eliminó nada de `com.google.firebase.auth`, habrás descartado esta rama definitivamente.

## Causa 3: la renovación es rechazada, y solo en release

En un arranque en frío el SDK restaura al usuario desde disco y luego renueva el ID token, que vive una hora, contra `securetoken.googleapis.com`. El SDK trata de forma distinta un fallo de transporte y un rechazo. Un fallo de transporte deja al usuario guardado en su sitio, y por eso un dispositivo sin conexión sigue con la sesión iniciada. Un rechazo que trae un código definitivo de la tabla de errores del SDK, valores como `TOKEN_EXPIRED`, `USER_DISABLED` y `USER_NOT_FOUND`, borra al usuario guardado y dispara el listener de estado de autenticación con null. Por eso el síntoma es un cierre de sesión limpio y no un bloqueo.

Dos configuraciones convierten una renovación que funciona en una rechazada solo para compilaciones release.

**Restricciones de la clave de API limitadas al certificado de depuración.** Si la clave de API de Firebase lleva una restricción de aplicación del tipo Android apps, cada solicitud tiene que presentar un nombre de paquete y una huella SHA-1 de certificado que aparezcan en la lista. Una clave restringida al SHA-1 del keystore de depuración funciona perfectamente con `flutter run` y devuelve `403 PERMISSION_DENIED` con "Requests from this Android client application are blocked" en cuanto la app se firma para release. Hay una segunda variante, más desagradable. Firebase documenta que Authentication necesita dos APIs en la lista de permitidos de restricciones de API de la clave: la Identity Toolkit API (`identitytoolkit.googleapis.com`) y la Token Service API (`securetoken.googleapis.com`). Permite solo la primera y obtienes exactamente el cuadro reportado: iniciar sesión funciona, y la renovación del siguiente arranque no.

**Aplicación de App Check.** Si App Check se aplica a Authentication, el cliente debe adjuntar un token de atestación. La configuración habitual en Flutter cambia de proveedor según el modo de compilación:

```dart
// firebase_app_check, called after Firebase.initializeApp()
await FirebaseAppCheck.instance.activate(
  androidProvider: kDebugMode ? AndroidProvider.debug : AndroidProvider.playIntegrity,
);
```

El proveedor de depuración se registra a mano en la consola de Firebase y siempre te funciona. Play Integrity necesita la huella SHA-256 del certificado con el que la app instalada está firmada de verdad, y si usas Play App Signing esa es la clave de Google, no tu clave de subida. Si te la saltas, App Check falla solo en producción. Firebase también señala que las compilaciones que no se distribuyen por Google Play no pueden obtener el veredicto `PLAY_RECOGNIZED`, así que un APK release distribuido internamente necesita que se relaje el ajuste avanzado correspondiente o fallará la atestación en un dispositivo perfectamente sano.

Ambos son problemas de huellas, y la misma trampa atrapa a la gente dos veces: `flutter run --release` firma con la configuración de depuración, porque la propia plantilla de Flutter lo hace a propósito. El comentario del `android/app/build.gradle.kts` generado lo dice: "Signing with the debug keys for now, so `flutter run --release` works." Una compilación release que funciona desde tu máquina y falla desde Play es una diferencia de huella, no una diferencia de modo de compilación.

## Causa 4: tu propio código cierra la sesión

Una vez que el almacenamiento, la configuración y las huellas están en orden, la posibilidad que queda es que lo haya hecho la app. La forma habitual es una llamada de arranque que intercambia el ID token de Firebase por una sesión en tu propio backend:

```dart
// The bug: any failure is treated as an invalid session.
try {
  final token = await FirebaseAuth.instance.currentUser!.getIdToken();
  await api.exchange(token);
} catch (_) {
  await FirebaseAuth.instance.signOut(); // wipes a perfectly good session
}
```

En debug ese bloque catch nunca se ejecuta. En release, un rechazo de App Check o de la clave de API aterriza ahí y tu propio código cierra la sesión del usuario, lo cual persiste porque el almacenamiento realmente queda vacío para el siguiente arranque. Distingue los casos por código:

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

Proteger ese camino también significa que no navegas fuera del shell mientras una llamada asíncrona sigue en vuelo, que es la misma disciplina que [cancelar suscripciones a streams en dispose](/es/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/).

## Trampas que se parecen a esto pero no lo son

**La respuesta del permiso INTERNET faltante es incorrecta para Firebase Auth.** La plantilla `src/main/AndroidManifest.xml` de Flutter no declara ningún permiso, mientras que los manifiestos generados en `src/debug/` y `src/profile/` sí declaran `android.permission.INTERNET`, con el comentario de que la herramienta lo necesita para hot reload. Eso sí rompe de verdad las llamadas simples con `http` o `dio` en compilaciones release. No rompe Firebase Auth, porque el manifiesto de la biblioteca `firebase-auth` 24.2.0 declara el permiso por sí mismo y el fusionador de manifiestos lo incorpora a tu APK:

```xml
<!-- com.google.firebase:firebase-auth:24.2.0, AndroidManifest.xml -->
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
```

Confírmalo para tu propia compilación en vez de creerle a cualquiera de las dos afirmaciones: `build/app/outputs/logs/manifest-merger-release-report.txt` registra qué biblioteca aportó cada nodo.

**Android Auto Backup puede entregarle a un dispositivo una sesión obsoleta.** `android:allowBackup` es true por defecto y los archivos `SharedPreferences` se incluyen, así que el almacenamiento de autenticación viaja por la copia de seguridad en la nube y por la transferencia entre dispositivos. Ni la plantilla de Flutter ni el manifiesto de `firebase-auth` lo excluyen. Si tus reportes se concentran en dispositivos nuevos restaurados desde una copia de seguridad, exclúyelo explícitamente:

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

**Desinstalar borra el almacenamiento, y borrar los datos de la app también.** Firebase lo documenta como la única forma soportada de limpiar la persistencia nativa. Un tester que instala un APK nuevo sobre una desinstalación no está reproduciendo tu bug.

## Relacionado

Si estás resolviendo problemas de release en Android y de Firebase en una app Flutter, estos cubren los fallos vecinos: la [migración al singleton de `google_sign_in` 7.x](/es/2026/08/fix-the-class-googlesignin-doesnt-have-an-unnamed-constructor-in-flutter/) que cambia cómo obtienes credenciales antes de pasárselas a Firebase Auth, el [problema de orden del token de APNs](/es/2026/08/fix-firebase-messaging-apns-token-not-set-on-flutter-ios/) que produce el mismo cuadro de "funciona en debug, silencio en release" en iOS, el [rechazo por tamaño de página de 16 KB](/es/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/) que bloquea la subida del release en sí, y el [cambio de diseño edge-to-edge al apuntar al SDK 35](/es/2026/08/fix-flutter-ui-overlaps-the-android-navigation-bar-after-targeting-sdk-35/) que llega en la misma ventana de actualización.

## Fuentes

- [Get Started with Firebase Authentication on Flutter](https://firebase.google.com/docs/auth/flutter/start) - la afirmación de que la persistencia nativa no es configurable, y la diferencia entre `authStateChanges`, `idTokenChanges` y `userChanges`.
- [Learn about and manage API keys for Firebase](https://firebase.google.com/docs/projects/api-keys) - Authentication requiere tanto la Identity Toolkit API como la Token Service API en la lista de permitidos de una clave de API.
- [Get started using App Check with Play Integrity on Android](https://firebase.google.com/docs/app-check/android/play-integrity-provider) - el requisito de registrar el SHA-256 y la salvedad de `PLAY_RECOGNIZED` para compilaciones distribuidas fuera de Google Play.
- [flutterfire issue #12727](https://github.com/firebase/flutterfire/issues/12727) - el 403 "Requests from this Android client application are blocked" que producen las restricciones de aplicación Android sobre la clave de API.
- `com.google.firebase:firebase-auth:24.2.0` - `com/google/firebase/auth/internal/zzce` para el nombre del almacenamiento `SharedPreferences`, `com/google/firebase/auth/internal/zzaq` para la tabla de códigos de error del servidor, y el `proguard.txt` y el `AndroidManifest.xml` incluidos.
- `firebase_auth` 6.6.1 - `android/.../FlutterFirebaseAuthPlugin.kt` para `getPluginConstantsForFirebaseApp`, y `firebase_auth_platform_interface` `method_channel_firebase_auth.dart` para los streams que reemiten `currentUser`.
- Flutter SDK 3.44.8 - `packages/flutter_tools/gradle/src/main/kotlin/FlutterPlugin.kt` para los valores por defecto de reducción en release, `runner/flutter_command.dart` para la opción no-op `--shrink`, y las plantillas de manifiesto y Gradle de `android.tmpl`.
