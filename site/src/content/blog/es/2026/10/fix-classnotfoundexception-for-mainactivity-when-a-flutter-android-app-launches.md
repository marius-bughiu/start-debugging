---
title: "Solución: ClassNotFoundException para MainActivity al iniciar una app Flutter en Android"
description: "El .MainActivity del manifiesto se resuelve contra el namespace de Gradle, y no hay ninguna clase con ese nombre en el APK. Haz que namespace, la línea package de Kotlin y el manifiesto coincidan."
pubDate: 2026-10-06
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
lang: "es"
translationOf: "2026/10/fix-classnotfoundexception-for-mainactivity-when-a-flutter-android-app-launches"
translatedBy: "claude"
translationDate: 2026-10-06
---

La clase de actividad indicada en tu `AndroidManifest.xml` fusionado no existe en los archivos dex del APK. En una app Flutter eso casi siempre significa que uno de tres valores se desincronizó durante un cambio de nombre: `namespace` en `android/app/build.gradle.kts` (contra el cual se resuelve `.MainActivity` en el manifiesto), la línea `package` al inicio de `MainActivity.kt`, o el source set de flavor en el que vive el archivo. Haz que la línea `package` sea igual a `namespace`, no toques `applicationId` a menos que realmente quieras una nueva identidad en la tienda, luego ejecuta `flutter clean` y vuelve a compilar. La carpeta en la que está el archivo `.kt` no importa.

Todo lo que sigue se reprodujo en macOS con Flutter 3.44.8 (Dart 3.12.2), cuya plantilla de `flutter create` fija AGP 9.0.1, Kotlin 2.3.20 y Gradle 9.1.0, ejecutándose en un emulador arm64 con Android 16 (API 36). Cada escenario se compiló con `flutter build apk`, se inspeccionó con `aapt2` y `dexdump` de build-tools 36.1.0, y se lanzó con `adb shell am start`.

## El error en contexto

Este es el crash de mi reproducción después de cambiar solo `namespace` (rutas acortadas):

```text
E AndroidRuntime: FATAL EXCEPTION: main
E AndroidRuntime: java.lang.RuntimeException: Unable to instantiate activity ComponentInfo{com.example.clsrepro/com.acme.shop.MainActivity}: java.lang.ClassNotFoundException: Didn't find class "com.acme.shop.MainActivity" on path: DexPathList[[zip file "/data/app/~~.../com.example.clsrepro-.../base.apk"],nativeLibraryDirectories=[/data/app/~~.../lib/arm64, /system/lib64, /system_ext/lib64]]
E AndroidRuntime: Caused by: java.lang.ClassNotFoundException: Didn't find class "com.acme.shop.MainActivity" on path: DexPathList[...]
```

Lee con atención la parte `ComponentInfo{A/B}`, porque te dice qué valor está mal. `A` es el application ID con el que se instaló la app. `B` es la clase completamente calificada que el sistema intentó instanciar. Si `B` no es una clase que exista en tu código Kotlin, el manifiesto y el código no coinciden. La compilación funciona, el APK se instala y la app muere antes de que arranque el motor de Flutter, así que nada de tu código Dart ni de tu registro se ejecuta. La traza de pila está en `adb logcat -b crash`.

## Por qué falta la clase

Android inicia tu app leyendo el `android:name` de la actividad launcher desde el manifiesto fusionado y cargando exactamente ese nombre de clase desde los `classes*.dex` del APK. La plantilla de Flutter lo escribe en forma abreviada:

```xml
<!-- android/app/src/main/AndroidManifest.xml, Flutter 3.44.8 template -->
<activity
    android:name=".MainActivity"
    android:exported="true"
    ... >
```

Un nombre que empieza con un punto se añade al `namespace` del módulo definido en `build.gradle.kts`, no al `applicationId` ni a cualquier paquete que declare tu archivo Kotlin. La clase que termina en el dex recibe su nombre de la línea `package` de `MainActivity.kt`. Nada en la compilación verifica que esos dos coincidan, así que hay tres formas de provocar el crash:

1. **`namespace` cambió, la línea `package` de Kotlin no.** El manifiesto ahora apunta a `<new namespace>.MainActivity`, el dex todavía tiene `<old package>.MainActivity`.
2. **La línea `package` de Kotlin cambió, `namespace` no.** La imagen espejo del caso 1.
3. **La clase no se compila en esta variante en absoluto.** Normalmente `MainActivity.kt` se movió a un source set de flavor (`src/free/kotlin`) y compilaste otro flavor, o el archivo se borró cuando alguien regeneró la carpeta `android/`.

No es R8. El paso de recursos (AAPT2) genera una regla keep para cada clase referenciada en el manifiesto, así que una compilación release no puede eliminar `MainActivity` al reducir el código. Más sobre eso abajo.

## Reproducción mínima

Parte de una plantilla limpia y cambia una línea:

```bash
# Flutter 3.44.8, AGP 9.0.1
flutter create --org com.example --platforms android clsrepro
cd clsrepro
```

```kotlin
// android/app/build.gradle.kts, Flutter 3.44.8 template, AGP 9.0.1
android {
    namespace = "com.acme.shop"          // was "com.example.clsrepro"
    // ...
    defaultConfig {
        applicationId = "com.example.clsrepro"
        // ...
    }
}
```

```kotlin
// android/app/src/main/kotlin/com/example/clsrepro/MainActivity.kt, unchanged
package com.example.clsrepro

import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity()
```

`flutter build apk --debug` funciona. Esto es lo que realmente hay dentro del APK, y lo que pasó al lanzarlo, para cada variante que probé:

| Escenario | `android:name` del manifiesto (fusionado) | Clase en el dex | Resultado |
|---|---|---|---|
| Plantilla base | `com.example.clsrepro.MainActivity` | `com.example.clsrepro.MainActivity` | funciona |
| Solo cambió `namespace` | `com.acme.shop.MainActivity` | `com.example.clsrepro.MainActivity` | **ClassNotFoundException** |
| Solo cambió `applicationId` | `com.example.clsrepro.MainActivity` | `com.example.clsrepro.MainActivity` | funciona (instalada como `com.acme.shop`) |
| Solo cambió la línea `package` de Kotlin | `com.example.clsrepro.MainActivity` | `com.acme.shop.MainActivity` | **ClassNotFoundException** |
| Cambiaron `namespace` y la línea `package`, archivo en la carpeta vieja | `com.acme.shop.MainActivity` | `com.acme.shop.MainActivity` | funciona |
| `MainActivity.kt` en `src/free/kotlin`, flavor `free` | `com.example.clsrepro.MainActivity` | `com.example.clsrepro.MainActivity` | funciona |
| lo mismo, flavor `paid` | `com.example.clsrepro.MainActivity` | (ninguna) | **ClassNotFoundException** |
| Plantilla base, `--release` (R8 activo) | `com.example.clsrepro.MainActivity` | `com.example.clsrepro.MainActivity` | funciona |

Vale la pena mirar con detenimiento dos filas. Cambiar solo `applicationId` es inofensivo, porque el nombre de la clase nunca dependió de él. Y mover el archivo para que coincida con el nuevo paquete no es obligatorio: Kotlin no exige que el directorio coincida con la declaración `package`, así que la fila con el archivo todavía bajo `com/example/clsrepro/` funciona sin problemas. La mayoría de las guías para "renombrar tu paquete de Flutter" te dicen que muevas carpetas primero, y ese es el paso que menos importa.

## La solución, paso a paso

### 1. Lee los tres valores del APK compilado, no de tu código fuente

Los archivos fuente pueden mentir (un editor sin guardar, un override de flavor, un placeholder del manifiesto). El APK no. Con las build-tools del Android SDK en tu `PATH`:

```bash
# Android SDK build-tools 36.1.0, after flutter build apk --debug
APK=build/app/outputs/flutter-apk/app-debug.apk

# 1. The application ID it installs as
aapt2 dump packagename $APK

# 2. The activity class the manifest asks for
aapt2 dump xmltree --file AndroidManifest.xml $APK | grep -A2 "E: activity" | grep android:name

# 3. The MainActivity classes that actually exist
unzip -o -q $APK 'classes*.dex' -d /tmp/dex
for d in /tmp/dex/classes*.dex; do dexdump $d | grep "Class descriptor" | grep MainActivity; done
```

En la reproducción rota de `namespace` esto imprimió `com.acme.shop.MainActivity` en el paso 2 y `Lcom/example/clsrepro/MainActivity;` en el paso 3. Si el paso 3 no imprime nada, estás en el caso "no se compila en esta variante"; salta al paso 4.

### 2. Haz que la línea `package` de Kotlin coincida con `namespace`

Decide en qué nombre quieres que viva tu código y luego asigna ambos a ese nombre:

```kotlin
// android/app/build.gradle.kts, AGP 9.0.1
android {
    namespace = "com.acme.shop"
    defaultConfig {
        applicationId = "com.acme.shop"   // only if you want a new store identity, see below
    }
}
```

```kotlin
// android/app/src/main/kotlin/com/acme/shop/MainActivity.kt, Flutter 3.44.8
package com.acme.shop

import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity()
```

Mueve el archivo a `kotlin/com/acme/shop/` por orden si quieres. Para Kotlin es opcional. Si tu actividad es un archivo Java (`MainActivity.java`, común en proyectos Flutter antiguos) muévelo también: la convención de Java y las refactorizaciones del IDE esperan que el directorio coincida con el paquete.

Si prefieres no tocar `namespace`, puedes escribir el nombre completamente calificado en el manifiesto (`android:name="com.example.clsrepro.MainActivity"`). Eso funciona, pero oculta la discrepancia en lugar de eliminarla, y el próximo cambio de `namespace` no lo moverá contigo.

### 3. Busca restos del nombre viejo con grep

Un cambio de nombre que se salta un archivo produce exactamente este crash. Busca en todo el árbol `android/`, incluidos los manifiestos de otros source sets (`src/debug/AndroidManifest.xml`, `src/profile/AndroidManifest.xml`) y cualquier otro archivo Kotlin o Java que declare el paquete viejo:

```bash
# from the Flutter project root
grep -rn "com.example.clsrepro" android/ --include='*.kt' --include='*.java' --include='*.xml' --include='*.kts' --include='*.gradle'
```

Las subclases personalizadas de `Application`, los `BroadcastReceiver`s y los `Service`s declarados con un punto inicial se resuelven contra `namespace` de la misma forma, así que fallan con la misma excepción (el mensaje solo nombra otra clase, y para una `Application` dice "Unable to instantiate application").

### 4. Si la clase falta por completo, corrige el source set

Cuando `dexdump` no muestra ninguna `MainActivity`, averigua dónde vive el archivo:

```bash
find android/app/src -name 'MainActivity.*'
```

Todo lo que está bajo `src/main/` se compila en todas las variantes. Todo lo que está bajo `src/<flavor>/` o `src/<buildType>/` solo se compila para esa variante. En mi reproducción, poner `MainActivity.kt` en `src/free/kotlin` y ejecutar `flutter run --flavor paid` produjo `Didn't find class "com.example.clsrepro.MainActivity"` bajo el application ID `com.example.clsrepro.paid`. Mueve el archivo de vuelta a `src/main/kotlin`, o dale a cada flavor su propia copia con el mismo paquete. Si el archivo simplemente desapareció (una carpeta `android/` regenerada), vuelve a crearlo a partir de la plantilla de arriba.

### 5. Limpia y reinstala

```bash
# Flutter 3.44.8
flutter clean
flutter pub get
flutter run
```

Los artefactos intermedios obsoletos pueden conservar un dex viejo después de un cambio de nombre, y una instalación vieja bajo el application ID anterior todavía puede ser dueña del ícono del launcher que estás tocando. Si cambiaste `applicationId`, desinstala el paquete viejo (`adb uninstall com.example.clsrepro`) para no seguir probando la compilación anterior.

## Cambiar applicationId frente a namespace

Estos dos valores responden a preguntas distintas, y la mayoría de los crashes vienen de tratarlos como uno solo:

- `applicationId` es la identidad en el dispositivo y en Google Play. Cambiarlo después de publicar crea una app diferente desde el punto de vista de Play. Nunca afecta a los nombres de clase.
- `namespace` es el paquete de las clases generadas `R` y `BuildConfig` y la base de cada nombre de clase abreviado en el manifiesto. Es solo un asunto de código.

La documentación de Android recomienda definir siempre `applicationId` explícitamente, porque si falta se usa `namespace` como respaldo, y entonces un cambio de nombre a nivel de código cambia silenciosamente también tu identidad en la tienda. La plantilla de Flutter ya define ambos. Si lo único que quieres es un nuevo bundle ID para una nueva ficha en la tienda, cambia `applicationId` y nada más: es el único cambio de nombre de la tabla de arriba que no puede producir este crash.

También hay un costo en renombrar la propia clase de la actividad después de publicar. La documentación de `<activity>` dice que no cambies el `android:name` de una actividad exportada una vez que la app está publicada. La `MainActivity` de Flutter es exportada, y los accesos directos del launcher y los íconos fijados en la pantalla de inicio de los usuarios hacen referencia al componente por su nombre de clase. Si tienes que moverla, un `<activity-alias>` con el nombre viejo que apunte a la nueva clase mantiene funcionando los accesos directos existentes.

## Compilaciones release y R8

Una suposición común es que R8 eliminó `MainActivity` en una compilación release. No lo hace, siempre que el manifiesto la nombre. Durante el procesamiento de recursos, AAPT2 escribe una regla keep para cada componente que encuentra en el manifiesto. En mi compilación release, `build/app/intermediates/aapt_proguard_file/release/processReleaseResources/aapt_rules.txt` contenía:

```text
-keep class com.example.clsrepro.MainActivity { <init>(); }
```

y `mapping.txt` mapeaba la clase a sí misma, sin renombrar. El APK release se lanzó sin problemas. Así que si una compilación release falla con este error mientras que debug funciona, busca una diferencia entre las variantes (un manifiesto solo para release en `src/release/`, un source set de flavor) antes de empezar a escribir reglas de ProGuard. Una clase que R8 realmente elimina es una a la que solo llegas por reflexión y que nunca mencionas en un manifiesto, y eso suele aparecer más tarde como una `ClassNotFoundException` para esa clase, no para `MainActivity`.

## Errores parecidos

- **Un error de compilación sobre `io.flutter.app.FlutterActivity` o `FlutterApplication`**: una app que todavía usa el embedding v1 de Android. Ese es un problema de migración, cubierto en la [lista de verificación para migrar de Flutter 2 a 3.x](/es/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/).
- **La compilación falla antes de que exista un APK** (errores del daemon de Kotlin o de Gradle): nunca llegas al lanzamiento. Consulta [Daemon compilation failed: null](/es/2026/09/fix-daemon-compilation-failed-null-in-a-flutter-android-gradle-build/) y [Timeout waiting to lock journal cache](/es/2026/10/fix-timeout-waiting-to-lock-journal-cache-in-a-flutter-android-build/).
- **`MissingPluginException` en un method channel**: la actividad arrancó bien, pero un handler se registró en el lugar equivocado. El patrón de registro del canal está en [agregar código específico de plataforma sin plugins](/es/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/).

## Relacionado

- [Migrar un proyecto Flutter Android a AGP 9 con Kotlin integrado](/es/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/), incluido cómo confirmar que tu `MainActivity` llegó al dex después de la migración.
- [Solución: e: Daemon compilation failed: null en una compilación Gradle de Flutter Android](/es/2026/09/fix-daemon-compilation-failed-null-in-a-flutter-android-gradle-build/)
- [Cómo agregar código específico de plataforma en Flutter sin plugins](/es/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/)
- [Solución: Timeout waiting to lock journal cache en una compilación de Flutter Android](/es/2026/10/fix-timeout-waiting-to-lock-journal-cache-in-a-flutter-android-build/)

## Fuentes

- [Configure the app module: namespace and application ID](https://developer.android.com/build/configure-app-module), Android Developers.
- [`<activity>` element, `android:name`](https://developer.android.com/guide/topics/manifest/activity-element#nm), Android Developers.
- [Set the application ID](https://developer.android.com/build/configure-app-module#set-application-id), Android Developers.
- [Shrink, obfuscate, and optimize your app](https://developer.android.com/build/shrink-code), Android Developers.
- [Build and release an Android app](https://docs.flutter.dev/deployment/android), Flutter docs.
