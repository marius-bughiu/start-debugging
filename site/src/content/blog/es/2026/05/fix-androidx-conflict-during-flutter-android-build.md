---
title: "Solución: conflicto de AndroidX durante la compilación Android de Flutter"
description: "La solución en 30 segundos: pon android.useAndroidX=true y android.enableJetifier=true en android/gradle.properties, luego encuentra cualquier plugin que siga en la antigua support library y actualízalo o reemplázalo."
pubDate: 2026-05-18
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "androidx"
lang: "es"
translationOf: "2026/05/fix-androidx-conflict-during-flutter-android-build"
translatedBy: "claude"
translationDate: 2026-05-18
---

La solución en una frase: un `AndroidX conflict` durante una compilación Android de Flutter significa que dos mitades del grafo de dependencias no se ponen de acuerdo sobre cuál Android support library usan. El motor de Flutter y cualquier plugin publicado en los últimos cinco años usan `androidx.*`. Un solo plugin (o una biblioteca Java transitiva) que aún haga referencia a `android.support.*` basta para romper la compilación. Pon `android.useAndroidX=true` y `android.enableJetifier=true` en `android/gradle.properties`, ejecuta `flutter clean`, luego `flutter pub get` y `flutter build apk` de nuevo. Si Gradle aún se niega, encuentra el plugin culpable con `./gradlew app:dependencies` y actualízalo o reemplázalo. Todavía no toques nada en `android/app/build.gradle`.

```text
* What went wrong:
Execution failed for task ':app:checkDebugDuplicateClasses'.
> Duplicate class android.support.v4.app.INotificationSideChannel found in modules
    core-1.6.0-runtime (androidx.core:core:1.6.0) and
    support-compat-28.0.0-runtime (com.android.support:support-compat:28.0.0)

  Go to the documentation to learn how to <a href="d.android.com/r/tools/classpath-sync-errors">Fix dependency resolution errors</a>.

FAILURE: Build failed with an exception.
BUILD FAILED in 12s
```

Esta guía está escrita contra Flutter 3.41.5, Dart 3.11, Android Gradle Plugin 8.7 y Gradle 8.11, el canal stable a fecha de mayo de 2026. El comportamiento descrito aquí es el mismo desde que el equipo de tooling de Android congeló el namespace `android.support.*` en 2018 y publicó Jetifier como el puente para el bytecode heredado. El proyecto Flutter habilitó AndroidX por defecto para apps nuevas en [Flutter 1.12](https://docs.flutter.dev/release/breaking-changes/androidx-migration) (diciembre de 2019); todo lo generado desde entonces se distribuye con `useAndroidX=true` de fábrica. Si estás viendo este error, la app casi seguro se creó con una versión de Flutter anterior a 1.12 y nunca se le aplicó la migración.

## Lo que significa realmente el error

`androidx.*` es la segunda generación de la Android support library. Google reescribió el namespace de paquetes una vez y se comprometió a no renombrarlo nunca más. Las clases bajo `android.support.v4.*`, `android.support.v7.*`, `android.support.design.*`, etc., son las support libraries originales y han estado congeladas desde la 28.0.0 en septiembre de 2018.

El sistema de compilación de Android se niega a compilar un APK que contenga ambas mitades a la vez porque los nombres de clase duplicados chocan en el classpath. El error aparece en una de tres formas concretas:

```text
> Duplicate class android.support.v4.app.INotificationSideChannel found in modules ...
```

```text
This app is using AndroidX dependencies, but the project does not have
the property android.useAndroidX set to true. Configure your project for
AndroidX. See https://goo.gle/flutter-androidx-migration
```

```text
Cannot fit requested classes in a single dex file (# methods: 73512 > 65536)
```

El primero es una colisión literal de classpath. El segundo es la verificación previa de la herramienta Flutter notando que el proyecto aún tiene el valor por defecto heredado. El tercero es el mismo conflicto expresado más abajo: arrastrar ambas bibliotecas supera el límite de 64K métodos de Dalvik porque cada clase de support tiene una gemela en AndroidX.

Jetifier es el workaround que viene con AGP. En tiempo de compilación reescribe cada referencia a `android.support.*` dentro de cualquier JAR o AAR que provenga de una dependencia de terceros, transformándola en la referencia equivalente de `androidx.*`. Con Jetifier activado, un plugin que aún distribuya bytecode de support library se traduce silenciosamente y la colisión de clases duplicadas desaparece. Con Jetifier desactivado, el duplicado queda expuesto y la compilación falla. AGP 8 y posteriores ponen `enableJetifier` en `false` por defecto por razones de velocidad de compilación, y por eso este error está de vuelta en la portada para proyectos que vivieron años sin que nadie notara el plugin heredado en su árbol.

## Una reproducción mínima

Crea una app Flutter nueva con un SDK reciente, luego agrega un plugin que aún haga referencia a la support library a través de una dependencia Java transitiva:

```bash
# Flutter 3.41.5
flutter create androidx_repro
cd androidx_repro
flutter pub add some_old_plugin:^1.2.0  # any plugin whose Android side
                                        # depends on com.android.support:*
```

Luego desactiva deliberadamente el workaround:

```properties
# android/gradle.properties, Flutter 3.41.5, AGP 8.7
org.gradle.jvmargs=-Xmx4G -XX:MaxMetaspaceSize=2G
android.useAndroidX=true
android.enableJetifier=false
```

Ejecuta la compilación:

```bash
flutter build apk --debug
```

Gradle imprime el fallo de clases duplicadas de arriba y sale con código distinto de cero. La única línea que dispara la regresión es `enableJetifier=false` combinada con una dependencia transitiva de `com.android.support:*`. Vuelve a activar Jetifier y la misma compilación tiene éxito, aunque nada del árbol de plugins haya cambiado.

## Solución, en orden de cuán seguido es la respuesta

Ejecuta los pasos en orden. Cada paso asume que el anterior no resolvió el error.

### 1. Activa ambas flags de AndroidX

Abre `android/gradle.properties` (no el archivo Gradle del SDK de Flutter, no el `build.gradle` del proyecto raíz) y confirma que ambas líneas estén presentes:

```properties
# android/gradle.properties, Flutter 3.41.5
android.useAndroidX=true
android.enableJetifier=true
```

`useAndroidX=true` le dice a AGP que tu propio código y el motor de Flutter son AndroidX. `enableJetifier=true` le dice a AGP que reescriba cualquier bytecode de terceros que aún haga referencia a la support library. Necesitas ambas. Activar solo `useAndroidX=true` mientras un plugin aún distribuye clases de support es exactamente la configuración que produce el error de clases duplicadas.

Si el archivo no existe (raro en un proyecto Flutter 1.12+, común en apps migradas desde Android nativo), créalo. Luego ejecuta:

```bash
flutter clean
flutter pub get
flutter build apk --debug
```

`flutter clean` es obligatorio aquí porque Gradle cachea el grafo de resolución de dependencias; sin él la compilación reutilizará el grafo fallido y reportará el mismo error.

### 2. Encuentra y actualiza el plugin heredado

Si Jetifier está activado y la compilación aún falla, el duplicado no es la support library en sí, sino un plugin cuyo `android/build.gradle` declara `com.android.support:*` directamente y usa algo que Jetifier no puede reescribir (los procesadores de anotaciones son el infractor más común, ya que Jetifier solo opera sobre JARs del classpath de runtime por defecto).

Lista el árbol de dependencias Android:

```bash
# from android/ directory, Flutter 3.41.5
./gradlew app:dependencies --configuration releaseRuntimeClasspath | grep -i "com.android.support"
```

La salida nombra el plugin y la coordenada de support library. Cruza la referencia con tu `pubspec.yaml`. Tres resoluciones, en orden de preferencia:

1. **Actualiza el plugin** si existe una versión más nueva. Ejecuta `flutter pub outdated` y busca al culpable. Una versión publicada después de finales de 2019 será AndroidX nativa y el conflicto desaparece.
2. **Reemplaza el plugin** si está sin mantenimiento. La comunidad Flutter ha reconstruido la mayoría de los plugins pre-1.12 bajo un nombre diferente; busca en [pub.dev](https://pub.dev) el mismo dominio (notificaciones, image picker, etc.) y elige la opción mantenida más reciente.
3. **Forkea y parchea** si nada de lo anterior ayuda. Clona el repo del plugin, cambia cada línea `com.android.support:appcompat-v7:28.0.0` en `android/build.gradle` por `androidx.appcompat:appcompat:1.6.1` (el [mapeo de clases de AndroidX](https://developer.android.com/jetpack/androidx/migrate/class-mappings) traduce los nombres viejos a los nuevos), actualiza tu `pubspec.yaml` para apuntar al fork vía `git:` y ejecuta `flutter pub get`.

### 3. Sube `compileSdk` a una versión que incluya AndroidX

Si migraste esta app desde Android nativo, el `android/app/build.gradle` puede tener `compileSdkVersion` fijado en 28 o menor. AndroidX requiere `compileSdk` 28 o superior y funciona mejor con la versión estable más reciente. Flutter 3.41.5 establece `flutter.compileSdkVersion` en 35 por defecto; si lo sobrescribiste, restaura el valor por defecto o ponlo explícitamente:

```groovy
// android/app/build.gradle, Flutter 3.41.5, AGP 8.7
android {
    namespace "com.example.androidx_repro"
    compileSdk 35
    ndkVersion flutter.ndkVersion

    defaultConfig {
        applicationId "com.example.androidx_repro"
        minSdkVersion 21      // AndroidX requires at least 19; pick 21 unless you have a reason
        targetSdkVersion 35
    }
}
```

`minSdkVersion 21` es el piso práctico para una app AndroidX en 2026. Ir más bajo funciona en principio pero arrastra shims de compatibilidad que producen errores de classpath distintos pero igualmente confusos durante el paso de merge.

### 4. Habilita multidex si el duplicado desapareció pero queda el error del límite dex

El límite de 64K métodos es anterior a AndroidX y AGP activa multidex automáticamente cuando `minSdkVersion >= 21`. Si sigues viendo el error "cannot fit requested classes", tienes un `minSdk` menor a 21 y necesitas optar explícitamente:

```groovy
// android/app/build.gradle
android {
    defaultConfig {
        multiDexEnabled true
    }
}

dependencies {
    implementation "androidx.multidex:multidex:2.0.1"
}
```

Esto no es una solución para el conflicto de AndroidX en sí, es la pasada de limpieza cuando ya resolviste las clases duplicadas pero la cantidad de métodos residuales aún desborda.

### 5. Último recurso: desactivar Jetifier solo después de auditar cada dependencia

Una vez que confirmaste vía `./gradlew app:dependencies` que ningún plugin del árbol sigue haciendo referencia a `com.android.support:*`, pon `android.enableJetifier=false` para ganar velocidad de compilación. La reescritura de classpath de Jetifier es el paso más caro en una compilación Android en frío de una app Flutter grande (15-30 segundos en un proyecto típico según nuestras mediciones). Desactivarlo no requiere cambios en tu código ni en las dependencias de pub, pero si lo haces sin auditar primero, el conflicto vuelve la próxima vez que una actualización transitiva arrastre una biblioteca heredada y vas a pensar que el error no tiene nada que ver con Jetifier porque lo quitaste hace semanas.

## Gotchas y casos parecidos

Unos cuantos casos que producen un error similar o parecen un conflicto de AndroidX pero no lo son:

- **`Could not find com.android.tools.build:gradle:X.Y.Z`**: no es un problema de AndroidX. El repositorio Google Maven es inalcanzable, o tu `settings.gradle` perdió la entrada del repositorio `google()`. Agrega `google()` a `pluginManagement.repositories` y `dependencyResolutionManagement.repositories`.
- **`Manifest merger failed : Attribute application@appComponentFactory ...`**: esta es la firma histórica de un choque AndroidX/support específicamente en el manifest, antes de que existiera la verificación a nivel de bytecode de AGP. La misma solución (activar ambas flags) lo resuelve, pero el disparador es el `AndroidManifest.xml` de un plugin declarando un nombre de componente `android.support.*` en lugar de su código Java haciendo referencia a una clase de support.
- **`Class not found: com.android.support.FileProvider`**: el `AndroidManifest.xml` de un plugin hardcodea la ruta de la support library. Jetifier no reescribe XML del manifest por defecto. O actualizas el plugin o sobrescribes el elemento `<provider>` en tu propio `AndroidManifest.xml` con el equivalente de AndroidX (`androidx.core.content.FileProvider`).
- **`Execution failed for task ':app:processDebugMainManifest'`** durante un `flutter run` en una compilación de release: usualmente un desajuste de `targetSdkVersion` entre plugins. AndroidX está bien; el merge falla porque dos plugins no se ponen de acuerdo sobre `android:exported` para una activity. No tiene relación, aunque aparezca en el mismo paso de Gradle.
- **La compilación funciona en macOS pero falla en Linux CI**: la causa raíz más común es un `~/.gradle/caches` viejo en la máquina del desarrollador que enmascara la flag de AndroidX faltante. El runner de Linux tiene cache limpia y resuelve el grafo de dependencias desde cero. La solución es la misma (las flags), pero el síntoma parece un problema solo de CI.
- **Un proyecto `flutter create` recién hecho cae en esto**: no debería. Si una app nueva tiene un conflicto de AndroidX antes de que agregues ningún plugin, tu SDK de Flutter es anterior a 1.12 y necesitas actualizarlo. Ejecuta `flutter upgrade` y vuelve a ejecutar `flutter create` contra el nuevo SDK; copia tu `lib/` en lugar de editar el proyecto roto.

Si estás recurriendo a `enableJetifier=true` más de una vez al año en el mismo proyecto, tienes al menos un plugin cuyo mantenedor dejó de seguir la plataforma Android. Reemplázalo. Jetifier está oficialmente designado como un shim transitorio, y el equipo de AGP ha declarado públicamente que será eliminado en un futuro lanzamiento mayor.

## Relacionados

- [Solución: Version solving failed en pubspec.yaml](/es/2026/05/fix-version-solving-failed-in-pubspec-yaml/)
- [Solución: Gradle build failed to produce an .apk file en MAUI Android](/es/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/)
- [Solución: Failed to build iOS app con Xcode 16 y Flutter 3.x](/es/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/)
- [Cómo apuntar a múltiples versiones de Flutter desde un solo pipeline de CI](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)
- [Solución: A RenderFlex overflowed by N pixels en Flutter](/es/2026/05/fix-renderflex-overflowed-in-flutter/)

## Fuentes

- [Migración a AndroidX para Flutter](https://docs.flutter.dev/release/breaking-changes/androidx-migration) (docs.flutter.dev)
- [Migrate to AndroidX](https://developer.android.com/jetpack/androidx/migrate) (developer.android.com)
- [Mapeo de clases de AndroidX](https://developer.android.com/jetpack/androidx/migrate/class-mappings) (developer.android.com)
- [Notas de versión del Android Gradle Plugin: default de enableJetifier](https://developer.android.com/build/releases/gradle-plugin) (developer.android.com)
- [flutter/flutter issue 25325: seguimiento del soporte AndroidX](https://github.com/flutter/flutter/issues/25325) (hilo canónico de la migración original)
