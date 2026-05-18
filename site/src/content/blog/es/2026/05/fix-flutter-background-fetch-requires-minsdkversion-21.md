---
title: "Solución: el plugin background_fetch de Flutter requiere minSdkVersion 21"
description: "La solución en 30 segundos: establece minSdkVersion en 21 (o superior) en android/app/build.gradle. background_fetch se apoya en el JobScheduler de Android, que solo existe desde la API 21."
pubDate: 2026-05-18
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "background_fetch"
lang: "es"
translationOf: "2026/05/fix-flutter-background-fetch-requires-minsdkversion-21"
translatedBy: "claude"
translationDate: 2026-05-18
---

La solución en una frase: el plugin `background_fetch` (Transistor Software) incluye un `AndroidManifest.xml` y código Kotlin que conectan el `JobScheduler` de Android, introducido en la API 21 (Android 5.0 Lollipop). Si el `android/app/build.gradle` de tu app Flutter todavía usa `minSdkVersion 19` (o `16`, en apps generadas con un SDK de Flutter anterior a 2023), el manifest merger rechaza la compilación con `uses-sdk:minSdkVersion 19 cannot be smaller than version 21 declared in library [:background_fetch]`. Abre `android/app/build.gradle`, cambia `minSdkVersion` a por lo menos `21`, ejecuta `flutter clean`, luego `flutter pub get` y `flutter build apk`. Si estás en un SDK de Flutter reciente que usa `minSdk flutter.minSdkVersion`, sobrescribe el valor por defecto de Flutter en lugar de poner un literal, o el plugin Gradle de Flutter sobrescribirá silenciosamente tu edición en la próxima compilación.

```text
> Manifest merger failed : uses-sdk:minSdkVersion 19 cannot be smaller than version 21 declared in library [:background_fetch]
    /Users/me/myapp/build/background_fetch/intermediates/merged_manifest/debug/AndroidManifest.xml as the library might be using APIs not available in 19
    Suggestion: use a compatible library with a minSdk of at most 19,
        or increase this project's minSdk version to at least 21,
        or use tools:overrideLibrary="com.transistorsoft.flutter.backgroundfetch" to force usage (may lead to runtime failures)

FAILURE: Build failed with an exception.
BUILD FAILED in 14s
```

Esta guía se escribe contra Flutter 3.41.5, Dart 3.11, `background_fetch` 1.6.2, Android Gradle Plugin 8.7 y Gradle 8.11, el canal estable a mayo de 2026. El error en sí ha sido estable desde `background_fetch` 1.0.0; solo se ha movido el `minSdkVersion` por defecto que viene en un proyecto Flutter recién generado, y por eso algunos equipos lo encuentran al primer build de una app actualizada hace poco y otros nunca lo han visto.

## Qué dice realmente el error

El sistema de compilación de Android ejecuta una fase de manifest merger que combina el `AndroidManifest.xml` de la aplicación con los manifiestos de cada AAR en el classpath. Cada manifiesto declara una etiqueta `<uses-sdk android:minSdkVersion="X"/>`. El merger elige el valor más alto y rechaza una build cuyo `minSdkVersion` a nivel de aplicación sea inferior al que declara cualquiera de las bibliotecas. `background_fetch` declara `minSdkVersion 21` en [el manifiesto de su plugin](https://github.com/transistorsoft/flutter_background_fetch/blob/master/android/src/main/AndroidManifest.xml), y la única forma de satisfacer al merger es elevar la aplicación para que coincida.

El error aparece en tres formas concretas según la versión del Android Gradle Plugin y la generación de la plantilla Flutter:

```text
Manifest merger failed : uses-sdk:minSdkVersion 19 cannot be smaller than version 21
declared in library [:background_fetch]
```

```text
The plugin background_fetch requires a higher Android SDK version.
Fix this issue by adding the following to /Users/me/myapp/android/app/build.gradle:
android {
  defaultConfig {
    minSdkVersion 21
  }
}
```

```text
A problem occurred evaluating project ':background_fetch'.
> com.transistorsoft.flutter.backgroundfetch requires Android SDK 21 or above
```

El primero es la salida cruda del manifest merger. El segundo es una pista pre-vuelo de la CLI `flutter`, que solo se dispara para plugins que anuncian su `minSdkVersion` a través del descriptor de plugin de Flutter. El tercero es una aserción de Gradle horneada en el `android/build.gradle` del plugin. Las tres se remontan a la misma restricción: `JobScheduler` y las clases `android.app.job.JobInfo`, `JobService` y `JobParameters` que `background_fetch` invoca se añadieron en la API 21. En la API 19 no existen en absoluto; en la API 20 (Android Wear 4.4W) solo se envió un subconjunto de `JobService`. El plugin no se ejecutará en nada por debajo de 21, así que el manifest merger bloquea la compilación antes de que puedas publicar un APK roto.

## Por qué API 21 en particular

`JobScheduler` existe por una razón: antes de él, programar trabajo en segundo plano repetitivo en Android significaba `AlarmManager` con un wake lock, un `IntentService` y un bucle de reintentos hecho a mano. Ese enfoque agotaba baterías, esquivaba el modo Doze a partir de Android 6.0 y se deprecó por partes en Android 8.0, 9.0 y 10. `JobScheduler` permite al SO unir el trabajo en segundo plano entre apps, aplazarlo según el estado de carga o el tipo de red, y sobrevivir a la muerte del proceso. `background_fetch` es, internamente, un envoltorio Dart-friendly sobre `JobScheduler` (y su equivalente iOS, `BGTaskScheduler`). No puede, por construcción, apuntar a una API inferior a 21 sin reescribir todo el backend.

El [README](https://pub.dev/packages/background_fetch) del plugin y su `CHANGELOG.md` han enunciado este requisito desde la 1.0.0 en 2018, pero el error volvió a ser común en 2025 cuando Google Play empezó a rechazar apps que apuntaban a `targetSdkVersion 33` o inferior, lo que provocó recompilaciones masivas de bases de código Flutter de larga data que no habían tocado su `android/app/build.gradle` desde 2019.

## Una reproducción mínima

Crea una app Flutter con un SDK que aún use `minSdkVersion 19` por defecto, añade el plugin y ejecuta una compilación de depuración:

```bash
# Flutter 3.7.0 (December 2022), the last template before the 19 -> 21 bump
flutter create background_fetch_repro
cd background_fetch_repro
flutter pub add background_fetch
flutter build apk --debug
```

`flutter pub add background_fetch` resuelve a `^1.6.2` y escribe una dependencia transitiva sobre el manifest del plugin Android. La siguiente compilación fallará con `Manifest merger failed`. El mismo error se reproduce en un proyecto Flutter 3.41.5 recién generado si has bajado manualmente `minSdkVersion` porque un plugin distinto (`flutter_blue_classic`, por ejemplo) parecía necesitar un valor más bajo.

## La solución, en detalle

Hay tres rutas viables según qué SDK de Flutter generó el proyecto. Elige la que coincida con tu `android/app/build.gradle`.

### Ruta A: build.gradle Groovy con números literales

Si `android/app/build.gradle` contiene un literal `minSdkVersion 19`, cambia el literal:

```groovy
// android/app/build.gradle
// Flutter 3.0 through 3.15 era template
android {
    compileSdkVersion 34

    defaultConfig {
        applicationId "com.example.myapp"
        minSdkVersion 21        // was 19
        targetSdkVersion 34
        versionCode flutterVersionCode.toInteger()
        versionName flutterVersionName
    }
}
```

Guarda y ejecuta `flutter clean && flutter pub get && flutter build apk`. El merger ahora elige 21 desde la app y acepta el 21 del plugin.

### Ruta B: build.gradle Groovy usando flutter.minSdkVersion

Flutter 3.16 y posteriores reemplazan el literal por una referencia a una propiedad fijada por el plugin Gradle de Flutter:

```groovy
// android/app/build.gradle
// Flutter 3.16 through 3.27 era template
android {
    defaultConfig {
        minSdkVersion flutter.minSdkVersion
    }
}
```

`flutter.minSdkVersion` quedó en 21 por defecto desde Flutter 3.16 en adelante, así que esta rama ya pasa. Si tu proyecto está en esta plantilla y aún falla el manifest merger, algo ha sobrescrito la propiedad. Revisa `android/local.properties` por una línea obsoleta `flutter.minSdkVersion=19` y bórrala, o pasa `-Pflutter.minSdkVersion=21` en la línea de comandos de Gradle si tu CI inyecta un valor antiguo. No reemplaces la referencia a la propiedad con un literal; el plugin Gradle de Flutter en 3.41 reescribe `android/app/build.gradle` en cada `flutter run` bajo ciertas condiciones ([flutter/flutter#177141](https://github.com/flutter/flutter/issues/177141)) y deshará tu edición.

### Ruta C: build.gradle.kts en Kotlin DSL

Flutter 3.29 cambió la plantilla a Kotlin DSL. La forma es la misma con sintaxis Kotlin:

```kotlin
// android/app/build.gradle.kts
// Flutter 3.29 and later
android {
    defaultConfig {
        applicationId = "com.example.myapp"
        minSdk = flutter.minSdkVersion       // resolves to 21 on Flutter 3.29+
        targetSdk = flutter.targetSdkVersion
    }
}
```

Si necesitas fijar un valor explícito (por ejemplo, porque otro plugin requiere 23), pon `minSdk = 23` en su lugar. El plugin Gradle de Flutter respeta literales explícitos en la plantilla Kotlin DSL; solo la plantilla Groovy tiene actualmente el bug de sobreescritura.

Después de cualquiera de las tres, ejecuta:

```bash
flutter clean
flutter pub get
flutter build apk --release
```

`flutter clean` importa aquí porque el manifest merger cachea su decisión en `build/app/intermediates/merged_manifest/`. Una compilación posterior sin paso de limpieza reproducirá el merge fallido desde disco y creerás que la edición no hizo nada.

## Lo que realmente cuesta subir minSdkVersion a 21

API 21 significa Android 5.0 Lollipop, lanzado en octubre de 2014. El propio [panel de distribución](https://developer.android.com/about/dashboards) de Google (última actualización significativa antes de que Google lo moviera dentro de Android Studio) sitúa la cuota de dispositivos por debajo de API 21 muy por debajo del 0,3 por ciento en 2026, casi todos Kindle Fire viejos y terminales sin actualizar de mercados emergentes. Play Store ya no acepta nuevas versiones que apunten a menos de API 24, así que para una app distribuida por Play esto es irrelevante. Si distribuyes APK por sideload o por tiendas alternativas puedes tener un público de cola larga en API 19 o 20, en cuyo caso `background_fetch` simplemente no es una opción: no hay shim. Usa `WorkManager` directamente a través de un canal [Pigeon](https://pub.dev/packages/pigeon) o acepta un servicio en primer plano con una notificación persistente.

## Errores después de que el merger pasa

Varios errores derivados se parecen al primero pero tienen otras causas. Reconócelos para no seguir subiendo `minSdkVersion` y romper la compatibilidad sin necesidad.

**Otro plugin necesita más de 21.** Si tras la solución ves `cannot be smaller than version 23 declared in library [:flutter_blue_plus]`, ese es otro plugin pidiendo API 23. Sube `minSdkVersion` al más alto declarado por cualquier plugin en tu árbol. Ejecuta `./gradlew app:dependencies` desde `android/` para enumerarlos.

**Falta la etiqueta de manifest para tareas headless.** Si usas `BackgroundFetch.registerHeadlessTask` para recibir callbacks mientras la app está terminada, el manifiesto debe declarar el receiver. El manifiesto del plugin ya lo incluye, pero las apps que ponen `tools:replace="android:label"` manualmente sobre la etiqueta `<application>` (un arreglo de la era de migración a AndroidX) pueden sobrescribir accidentalmente también `android:name` o eliminar el receiver. Lee [la guía de conflicto AndroidX](/es/2026/05/fix-androidx-conflict-during-flutter-android-build/) si sospechas esto; el síntoma es silencioso (ningún callback se dispara), no un error de build.

**Falta el identificador BGTaskScheduler en iOS.** El error de Android es el más ruidoso, pero se requiere una configuración paralela en iOS. `Info.plist` necesita un arreglo `BGTaskSchedulerPermittedIdentifiers` con `com.transistorsoft.fetch`, y el proyecto Xcode debe tener la capability `background-fetch` activada bajo Signing and Capabilities. La solución de Android arriba dejará pasar la build en Android, pero la build de iOS sigue fallando o, peor, compila y nunca dispara un callback en producción.

**El daemon de Gradle cachea el manifest fusionado.** En CI, `flutter clean` no siempre es suficiente. El daemon de Gradle guarda las salidas de `:app:processDebugManifest` en `~/.gradle/caches/`. Si una ejecución de CI falló una vez con el `minSdkVersion` antiguo, la siguiente puede repetir el fallo a menos que llames `./gradlew --stop` antes de la siguiente build o borres el directorio de caché.

**Jetifier con un AGP reciente cambia el aspecto del error.** AGP 8.7 desactiva Jetifier por defecto. Si lo has reactivado explícitamente en `gradle.properties` (`android.enableJetifier=true`), el manifest merger corre después de que Jetifier reescriba el AAR de la biblioteca, y el mensaje de error cambia `com.transistorsoft.flutter.backgroundfetch` por un nombre reescrito a `androidx.*`. La misma causa raíz, distinto texto en superficie. La solución es idéntica.

**NDK o buildToolsVersion fijados por debajo de 30.** Un número muy reducido de proyectos antiguos fija `buildToolsVersion "29.0.3"` en `android/app/build.gradle`. `background_fetch` 1.6 se compiló contra Android 14 build tools y no enlazará contra símbolos de `JobService` por debajo de 30. Elimina el pin o súbelo a `34.0.0`.

## Lecturas relacionadas

La migración a AndroidX es la otra mitad de por qué las builds de Flutter Android rompen en proyectos viejos: ver [conflicto AndroidX durante la compilación Flutter Android](/es/2026/05/fix-androidx-conflict-during-flutter-android-build/) para el comportamiento detallado del manifest merger y Jetifier. Si lo que falla es `flutter pub get`, [version solving failed en pubspec.yaml](/es/2026/05/fix-version-solving-failed-in-pubspec-yaml/) recorre la cadena de "because" del resolvedor. El paralelo iOS para muchos síntomas similares vive en [Failed to build iOS app con Xcode 16 y Flutter 3.x](/es/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/). Y si el fallo real de Android es la línea de comandos de Gradle, no el manifest merger, [Gradle build failed to produce an .apk file en MAUI Android](/es/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/) tiene los mismos pasos de triage con rutas específicas de MAUI, pero las notas sobre la caché de AGP aplican igual.

## Fuentes

- [Paquete `background_fetch` en pub.dev](https://pub.dev/packages/background_fetch)
- [Guía de instalación Android de `flutter_background_fetch`](https://github.com/transistorsoft/flutter_background_fetch/blob/master/help/INSTALL-ANDROID.md)
- [Referencia de la API `JobScheduler` de Android (añadida en API 21)](https://developer.android.com/reference/android/app/job/JobScheduler)
- [Documentación del manifest merger del Android Gradle Plugin](https://developer.android.com/build/manage-manifests)
- [flutter/flutter#177141: el plugin Gradle de Flutter sobrescribe `minSdk` explícito](https://github.com/flutter/flutter/issues/177141)
- [Notas de versión de Flutter 3.16: `minSdkVersion` por defecto elevado a 21](https://docs.flutter.dev/release/release-notes/release-notes-3.16.0)
