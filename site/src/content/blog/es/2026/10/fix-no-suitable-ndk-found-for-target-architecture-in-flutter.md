---
title: "Solución: Bad state: No suitable NDK found for target architecture arm64 en una compilación de Flutter"
description: "El hook de compilación de android_libcpp_shared (0.2.0 y anteriores) no encuentra tu NDK, o tu minSdk es mayor que la API más reciente del NDK. Actualiza a 0.2.1 o posterior, o instala un NDK que cubra tu minSdk."
pubDate: 2026-10-07
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "ndk"
  - "native-assets"
lang: "es"
translationOf: "2026/10/fix-no-suitable-ndk-found-for-target-architecture-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-07
---

Este error no viene de Gradle ni de Flutter. Lo lanza el hook de compilación de Dart del paquete `android_libcpp_shared` (versiones 0.1.0 a 0.2.0), que algunos paquetes FFI como `croppy` incorporan de forma transitiva. Hay dos causas. O bien la búsqueda de NDK del propio hook no encuentra el NDK que Gradle usa sin problemas, o bien todos los NDK que encuentra se quedan en un nivel de API inferior al `minSdk` de tu app. Para la primera, actualiza el paquete a 0.2.1 o posterior (con `dependency_overrides` si es transitivo). Para la segunda, instala un NDK cuyo sysroot cubra tu `minSdk`: NDK r28c y r29 llegan solo hasta la API 35, así que `minSdk = 36` requiere r30.

Todo lo que sigue se reprodujo en macOS con Flutter 3.44.8 (Dart 3.12.2), el Gradle 9.1.0 de la plantilla de Flutter, OpenJDK 17 y NDK r28c (`28.2.13676358`) en un Android SDK ubicado en `/opt/homebrew/share/android-commandlinetools`. Leí el código fuente del hook de `android_libcpp_shared` 0.1.0 a 0.3.1 directamente de los archivos de pub.dev.

## El error en contexto

Esta es la salida de `flutter build apk --debug --target-platform android-arm64` en una app recién creada con `android_libcpp_shared: 0.2.0` agregado y nada más cambiado (las rutas largas de `--packages` están abreviadas):

```text
Unhandled exception:
Bad state: No suitable NDK found for target architecture arm64.
#0      main.<anonymous closure> (file:///Users/marius/.pub-cache/hosted/pub.dev/android_libcpp_shared-0.2.0/hook/build.dart:31:7)
<asynchronous suspension>
#1      build (package:hooks/src/api/build_and_link.dart:250:5)
<asynchronous suspension>
#2      main (file:///Users/marius/.pub-cache/hosted/pub.dev/android_libcpp_shared-0.2.0/hook/build.dart:12:3)
<asynchronous suspension>

  Building assets for package:android_libcpp_shared failed.
  build.dart returned with exit code: 255.
  To reproduce run:
  (cd .../android_libcpp_shared-0.2.0/; .../dart-sdk/bin/dart --packages=.../package_config.json .../hooks_runner/android_libcpp_shared/cbb4418675/hook.dill --config=.../input.json )
  stdout:
  INFO: Searching for android NDK...

Target dart_build failed: Error: Building native assets failed. See the logs for more details.

FAILURE: Build failed with an exception.

* What went wrong:
Execution failed for task ':app:compileFlutterBuildDebug'.
```

La arquitectura al final cambia según tu destino: `arm64`, `arm` o `x64`. Una compilación de release sin `--target-platform` compila las tres, así que ves la ABI que el ejecutor de hooks pruebe primero.

El detalle que confunde a todos: Gradle ya había resuelto el NDK `28.2.13676358` en esta máquina. El plugin de Gradle de Flutter fuerza la descarga de ese NDK en cada compilación de Android, así que el NDK estaba instalado, era válido y estaba en uso. Simplemente, el hook no miró donde estaba.

## Por qué un hook de compilación busca un NDK

En las versiones estables actuales de Flutter, los paquetes pueden incluir un `hook/build.dart` que se ejecuta durante `flutter build` para compilar o empaquetar código nativo (la funcionalidad de "native assets" o "build hooks", construida sobre `package:hooks` y `package:code_assets`). Flutter ejecuta estos hooks en el target `dart_build`, antes de que Gradle compile nada, y le pasa a cada hook una configuración JSON con el sistema operativo de destino, la arquitectura, el compilador de C que Flutter encontró y `targetNdkApi`.

`android_libcpp_shared` existe para empaquetar `libc++_shared.so`, el runtime compartido de C++ que las bibliotecas FFI compiladas con `-stl=c++_shared` necesitan al cargarse. Para ello tiene que encontrar un NDK en disco, y en 0.2.0 y anteriores ejecutaba su propia búsqueda en lugar de confiar en el que Flutter le pasaba. Dos cosas dentro de esa búsqueda pueden devolver nada, y ambas terminan en el mismo `StateError`.

### Causa 1: el hook busca en menos lugares que Gradle

En 0.2.0 `NDKLocator.locate()` reúne candidatos de exactamente cuatro fuentes:

1. `ndk-build` en el `PATH`, pero resuelve el directorio padre del directorio del NDK en lugar del directorio mismo, así que esta fuente nunca coincidía (el changelog de 0.2.1 lo señala como una corrección).
2. Las variables de entorno `ANDROID_NDK`, `ANDROID_NDK_HOME`, `ANDROID_NDK_LATEST_HOME` y `ANDROID_NDK_ROOT`.
3. Un glob fijo por sistema operativo: `$HOME/Library/Android/sdk/ndk/*/` en macOS, `$HOME/Android/Sdk/ndk/*/` en Linux, `$HOME/AppData/Local/Android/Sdk/ndk/*/` en Windows.
4. `ndk/*/` dentro de `ANDROID_HOME`, `ANDROID_SDK_ROOT` o `ANDROID_SDK_HOME`.

Lo que no lee es `sdk.dir` en `android/local.properties`, que es de donde Gradle obtiene realmente el SDK, ni el valor `android-sdk` que defines con `flutter config --android-sdk`. Flutter respeta ambos. Por eso cualquier SDK fuera de la ubicación predeterminada de Android Studio, sin un `ANDROID_HOME` exportado, es invisible para el hook: el `android-commandlinetools` de Homebrew, una unidad personalizada en Windows y una imagen de CI que solo escribe `local.properties`. En Windows hay una segunda trampa: el glob expande `$HOME` con `Platform.environment['HOME']!`, y `HOME` no está definida en una sesión normal de `cmd.exe`.

### Causa 2: tu minSdk es mayor que la API más reciente de cualquier NDK encontrado

Incluso cuando se encuentra un NDK, el hook solo lo acepta si su sysroot tiene un directorio de nivel de API igual o superior al SDK mínimo de tu app:

```dart
// android_libcpp_shared 0.2.0, lib/src/locate_ndk.dart
NDKApiLevel? highestMatching(int minApiLevel) {
  final suitableApiLevels =
      _apiLevels.where((api) => api.level >= minApiLevel).toList()
        ..sort((a, b) => b.level.compareTo(a.level));
  return suitableApiLevels.isNotEmpty ? suitableApiLevels.first : null;
}
```

`minApiLevel` es `targetNdkApi` de la configuración del hook, y Flutter lo rellena a partir del `minSdk` combinado de tu app: `FlutterPlugin.kt` lee `variant.mergedFlavor.minSdkVersion` y lo pasa a `flutter assemble` como `-dMinSdkVersion`. Los directorios de API provienen de `toolchains/llvm/prebuilt/<host>/sysroot/usr/lib/aarch64-linux-android/`. Los listé para los tres NDK actuales:

| NDK | Revisión | Niveles de API del sysroot |
|-----|----------|----------------------------|
| r28c | `28.2.13676358` (`ndkVersion` predeterminado de Flutter 3.44) | 21 a 35 |
| r29 | `29.0.14206865` | 21 a 35 |
| r30 | `30.0.16248370` | 21 a 37 |

Así que `minSdk = 36` con el NDK predeterminado de Flutter falla, sin importar cómo se descubra el NDK. Esta comprobación sigue en 0.2.1 y 0.3.x también, solo que con un mejor mensaje. También es algo extraña, porque `libc++_shared.so` vive un nivel más arriba, en `sysroot/usr/lib/<triple>/`, y no depende de la API en absoluto. Pero esa es la regla que el paquete impone, así que hay que cumplirla.

## Reproducción mínima

Ambas causas se reproducen con una app de plantilla. Para la causa 1 necesitas un SDK fuera de la ubicación predeterminada y ningún `ANDROID_HOME`; para la causa 2 sirve cualquier máquina.

```bash
# Flutter 3.44.8, android_libcpp_shared 0.2.0, NDK r28c
flutter create --platforms=android -e ndkapp
cd ndkapp
flutter pub add android_libcpp_shared:0.2.0
flutter build apk --debug --target-platform android-arm64
```

Para comprobar cómo ve el hook tu máquina sin una compilación completa de Gradle, llama a su localizador desde un paquete de consola desechable. Esto es lo que usé para separar las dos causas:

```dart
// Dart 3.12.2, android_libcpp_shared 0.2.0
// bin/repro.dart  -  dart run bin/repro.dart 36
import 'package:android_libcpp_shared/src/locate_ndk.dart';

Future<void> main(List<String> args) async {
  final minSdk = int.parse(args.first);
  final ndks = await NDKLocator.locate();
  print('NDKs found: ${ndks.length}');
  for (final ndk in ndks) {
    final target = ndk.hostArchitectures.first.findTarget(LibArch.arm64);
    print('${ndk.path.toFilePath()} '
        'match(minSdk=$minSdk): ${target?.highestMatching(minSdk)}');
  }
}
```

En mi máquina, sin `ANDROID_HOME` imprime `NDKs found: 0` (causa 1). Con `ANDROID_HOME` definido y el argumento `24` imprime `android-35`; con `36` imprime `null` (causa 2).

## La solución, paso a paso

### 1. Averigua quién depende de android_libcpp_shared

Probablemente nunca lo agregaste tú:

```bash
# Flutter 3.44.8
flutter pub deps --style=compact | grep android_libcpp_shared
flutter pub deps --style=tree | grep -B5 android_libcpp_shared
```

Al momento de escribir esto, los paquetes de pub.dev que dependen de él son `croppy` (1.5.3 fija exactamente `0.1.0`), `flutter_piper_tts` (`^0.1.1`), `mecab_for_dart` y `than_audiotag` (`^0.2.1`), y `liblsl` (`^0.3.0`). Si el tuyo resuelve 0.2.0 o anterior, el paso 2 corrige la causa 1.

### 2. Actualiza a 0.2.1 o posterior

0.2.1 (publicada el 2026-08-12) reescribió el descubrimiento. Agrega a los candidatos el NDK con el que la herramienta de Flutter está compilando, derivado de la ruta del compilador de C en la configuración del hook, además de `sdk.dir` y `ndk.dir` de `local.properties`, `flutter config --android-sdk`, una lista más larga de directorios conocidos y la búsqueda corregida en `PATH`. También lee `USERPROFILE` en Windows.

Si la dependencia es directa, súbela de versión. Si es transitiva y está fijada, sobrescríbela:

```yaml
# pubspec.yaml, Flutter 3.44.8
dependency_overrides:
  android_libcpp_shared: ^0.2.1
```

Qué línea elegir depende de tu versión de Flutter. 0.2.x depende de `code_assets ^1.0.0` y `hooks ^2.0.2`. 0.3.0 y 0.3.1 pasan a `code_assets ^2.0.0`. El propio `flutter_tools` de Flutter 3.44.8 fija `code_assets 1.0.0`, así que en 3.44 recomiendo `^0.2.1`, que es lo que verifiqué. Con 0.2.1 y sin `ANDROID_HOME`, la misma app de plantilla compila y el APK contiene `lib/arm64-v8a/libc++_shared.so`.

Las sobrescrituras se aplican a todo el grafo, así que comprueba que el paquete que fijaba la versión antigua siga funcionando con la nueva. En el caso de `croppy`, que usa `android_libcpp_shared` solo por el efecto secundario de su hook, no hay ninguna API que se pueda romper.

### 3. Si no puedes actualizar: dale al hook antiguo una ruta que sí busque

En 0.2.0 o anterior, exporta una de las variables que lee antes de compilar:

```bash
# macOS / Linux, android_libcpp_shared 0.2.0
export ANDROID_HOME="$HOME/path/to/your/android/sdk"
flutter clean
flutter build apk
```

```powershell
# Windows PowerShell, android_libcpp_shared 0.2.0
$env:ANDROID_HOME = "D:\Android\Sdk"
$env:HOME = $env:USERPROFILE
flutter clean
flutter build apk
```

Esa variable tiene que estar en el entorno de lo que lance la compilación. En mis pruebas con `flutter build` y Gradle 9.1.0, un daemon de Gradle ya iniciado tomó el nuevo valor en la siguiente compilación, en ambos sentidos. Donde falla es en Android Studio iniciado desde el Dock, el menú Inicio o un lanzador: las aplicaciones gráficas no leen `~/.zshrc`, así que `flutter run` desde el IDE falla mientras que el mismo comando en tu terminal funciona. Inicia el IDE desde un shell que tenga la variable, o usa el paso 2.

No te saltes `flutter clean` al probar esto. Flutter guarda en caché los resultados del hook en `.dart_tool/`, y en mi reproducción una compilación sin `ANDROID_HOME` seguía pasando porque reutilizaba la salida exitosa del hook de la compilación anterior. Creerías que tu solución funciona hasta que un runner de CI limpio demuestre lo contrario.

### 4. Si tu minSdk es mayor que 35: instala un NDK que lo cubra

Para la causa 2 la única solución correcta es un NDK cuyo sysroot llegue hasta tu `minSdk`. Defínelo de forma explícita para que Gradle lo descargue en todas las máquinas y runners de CI:

```kotlin
// android/app/build.gradle.kts, Flutter 3.44.8, AGP 9.0.1
android {
    ndkVersion = "30.0.16248370" // NDK r30: sysroot API levels 21 to 37
    defaultConfig {
        minSdk = 36
    }
}
```

0.2.1 y posteriores ordenan todos los NDK que encuentran por versión y toman el más reciente que pase la comprobación de API, así que tener r30 instalado junto a r28c es suficiente. Antes de cambiar nada, revisa tú mismo tus NDK instalados:

```bash
# any NDK r23 or later; the host folder is darwin-x86_64 even on Apple silicon
ls "$ANDROID_HOME"/ndk/*/toolchains/llvm/prebuilt/*/sysroot/usr/lib/aarch64-linux-android/
```

El número más alto de ese listado es el `minSdk` más alto que ese NDK puede satisfacer para este hook.

## La sobrescritura libcpp_shared_path y la trampa de múltiples ABI

0.2.1 también agregó una vía de escape: un user define que apunta directamente a la biblioteca. El mensaje de error resultante en 0.2.1 y posteriores incluso la sugiere:

```yaml
# pubspec.yaml, android_libcpp_shared 0.2.1
hooks:
  user_defines:
    android_libcpp_shared:
      libcpp_shared_path: /path/to/ndk/toolchains/llvm/prebuilt/darwin-x86_64/sysroot/usr/lib/aarch64-linux-android/libc++_shared.so
```

Cuando el valor es un archivo, se salta por completo el descubrimiento de NDK y la comprobación de API, así que sí consigue que una compilación con `minSdk = 36` pase. Pero es una sola ruta para todas las arquitecturas. Compilé un APK de release con esta sobrescritura y lo inspeccioné:

```text
lib/arm64-v8a/libc++_shared.so:   ELF 64-bit LSB shared object, ARM aarch64
lib/armeabi-v7a/libc++_shared.so: ELF 64-bit LSB shared object, ARM aarch64
lib/x86_64/libc++_shared.so:      ELF 64-bit LSB shared object, ARM aarch64
```

Los espacios de ARM de 32 bits y x86_64 ahora contienen una biblioteca arm64. La compilación tiene éxito, la app se publica y falla al cargar la biblioteca en cualquier dispositivo o emulador que no sea arm64. Usa una ruta a archivo solo cuando compiles una única ABI (`--target-platform android-arm64`). Si apuntas el user define, o la variable de entorno `ANDROID_LIBCPP_SHARED_PATH`, a un directorio raíz del NDK, el hook resuelve cada arquitectura correctamente, pero esa ruta vuelve a pasar por la comprobación de API, así que no esquiva la causa 2.

## Lo que imprimen las versiones nuevas

Si estás en 0.2.1 o posterior y aun así falla, no verás el texto "No suitable NDK". El hook ahora lanza un `StateError` más largo que lista cada NDK que consideró. Mi reproducción con `minSdk = 36` en 0.2.1 produjo:

```text
Could not find libc++_shared.so for target architecture arm64 (minimum NDK API level 36).
NDK installations considered:
  - 1 NDK installation(s) found, but none support arm64 at API level 36
```

"Found, but none support ... at API level" es la causa 2, y se aplica el paso 4. "No Android NDK installation was found" es la causa 1 en una máquina donde ni siquiera la búsqueda extendida funciona, lo que normalmente significa que el NDK nunca se descargó: ejecuta primero una compilación de Gradle de cualquier proyecto Android, o instálalo con `sdkmanager "ndk;28.2.13676358"`.

## Errores parecidos

- `NDK at .../ndk/<version> did not have a source.properties file` es un NDK extraído a medias, y la solución es borrar ese directorio. Eso y otras discrepancias de versión del NDK se tratan en [el recorrido del exit code 1 de assembleDebug](/es/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).
- `An error occurred while preparing SDK package NDK (Side by side): Not in GZIP format` significa que la descarga del NDK en sí está corrupta. Consulta [cómo limpiar la caché de descargas del SDK Manager](/es/2026/08/fix-an-error-occurred-while-preparing-sdk-package-ndk-not-in-gzip-format/).
- `No toolchains found in the NDK toolchains folder for ABI with prefix: mips64el-linux-android` es un Android Gradle Plugin antiguo hablando con un NDK nuevo. No tiene nada que ver con los hooks de compilación.
- `Building native assets failed` con una excepción distinta encima es el hook de otro paquete. Lee la línea `Building assets for package:<name> failed` para ver cuál.

## Relacionado

- [Google Play rechazando una app de Flutter por el tamaño de página de 16 KB](/es/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/) es el otro lugar donde la versión del NDK que fijas decide si una versión de release se publica.
- [El timeout del bloqueo de la caché de journal de Gradle](/es/2026/10/fix-timeout-waiting-to-lock-journal-cache-in-a-flutter-android-build/) explica cómo los daemons de Gradle sobreviven a la compilación que los inició.
- [Resolver conflictos de AndroidX en una compilación Android de Flutter](/es/2026/05/fix-androidx-conflict-during-flutter-android-build/) recorre los ajustes de `android/app/build.gradle`, incluido `ndkVersion`.

## Fuentes

- [android_libcpp_shared en pub.dev](https://pub.dev/packages/android_libcpp_shared), incluido el [changelog](https://pub.dev/packages/android_libcpp_shared/changelog) de 0.2.1 y 0.3.x.
- [NexusDynamic/android_libcpp_shared en GitHub](https://github.com/NexusDynamic/android_libcpp_shared), el hook y el código fuente de `locate_ndk.dart`.
- [Documentación de Flutter: hooks y native assets](https://docs.flutter.dev/platform-integration/bind-native-code).
- [package:hooks](https://pub.dev/packages/hooks) y [package:code_assets](https://pub.dev/packages/code_assets), el protocolo de los hooks de compilación.
- [Historial de revisiones del Android NDK](https://developer.android.com/ndk/downloads/revision_history) para r28c, r29 y r30.
- Código fuente de `flutter_tools` de Flutter 3.44.8: `lib/src/android/gradle_utils.dart` (`ndkVersion` predeterminado), `lib/src/android/android_sdk.dart` (`getNdkBinaryPath`) y `gradle/src/main/kotlin/FlutterPlugin.kt` (`-dMinSdkVersion`).
