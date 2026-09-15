---
title: "Solución: flutter doctor --android-licenses dice 'The --licenses option is no longer needed' con cmdline-tools 23"
description: "cmdline-tools 23.0 retiró sdkmanager --licenses, así que Flutter anterior a 3.47.3 informa que el estado de las licencias es desconocido. Actualiza Flutter o fija cmdline-tools 22.0."
pubDate: 2026-09-15
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "android-sdk"
  - "flutter-doctor"
lang: "es"
translationOf: "2026/09/fix-flutter-doctor-android-licenses-fails-with-cmdline-tools-23"
translatedBy: "claude"
translationDate: 2026-09-15
---

Lo más probable es que tus licencias estén bien. Android SDK Command-line Tools 23.0 marcó `sdkmanager` como obsoleto, y `sdkmanager --licenses` ahora imprime un aviso de obsolescencia más "Warning: The --licenses option is no longer needed." y termina con código 0 sin preguntar nada. Flutter hasta la 3.47.2 analiza esa salida buscando un conteo de licencias, no encuentra ninguno e informa "Android license status unknown" sin importar lo que haya en disco. Actualiza a Flutter 3.47.3 o posterior (la corrección también está en la beta 3.48), que lee `<sdk>/licenses/` directamente. Si no puedes actualizar, instala cmdline-tools 22.0 y asegúrate de que no quede ninguna copia más nueva en `cmdline-tools/`.

Todo lo que sigue se reprodujo en macOS con Flutter 3.44.8 y Flutter 3.47.3, cmdline-tools 22.0 y 23.0 lado a lado en un SDK de pruebas, y OpenJDK 17.0.20.1.

## El error tal como lo imprime flutter doctor

`flutter doctor -v` marca la cadena de herramientas de Android aunque todo lo demás esté en verde:

```text
[!] Android toolchain - develop for Android devices (Android SDK version 36.1.0)
    • Android SDK at /Users/you/Library/Android/sdk
    • Platform android-36, build-tools 36.1.0
    • Java version OpenJDK Runtime Environment Homebrew (build 17.0.20.1+0)
    ✗ Android license status unknown.
      Run `flutter doctor --android-licenses` to accept the SDK licenses.
      See https://flutter.dev/to/macos-android-setup for more details.
```

Haces lo que te dice y, en lugar del conocido mensaje "Review licenses that have not been accepted (y/N)?", obtienes esto, seguido de una salida inmediata con código 0:

```text
WARNING: The SDK Manager CLI tool (sdkmanager) is deprecated. Android CLI will be used instead.
The 'android' binary can also be found in the cmdline-tools directory, and 'android sdk' is the replacement for 'sdkmanager'.
To learn more about the Android CLI and how to use it, see the documentation (https://d.android.com/tools/agents/android-cli)

Warning: The --licenses option is no longer needed.
```

Ejecutas `flutter doctor` de nuevo y la línea "license status unknown" sigue ahí. Ese ciclo es todo el bug, reportado como [flutter/flutter#191487](https://github.com/flutter/flutter/issues/191487) (macOS, Flutter 3.47.1) y otra vez como [#191558](https://github.com/flutter/flutter/issues/191558) (Windows 11) y [#191963](https://github.com/flutter/flutter/issues/191963) (Windows 10, Flutter 3.47.2).

## Por qué Flutter no puede saber si tus licencias están aceptadas

El `AndroidLicenseValidator` de Flutter no lee los archivos de licencia por sí mismo. Ejecuta `sdkmanager --licenses`, lee stdout línea por línea y compara contra tres expresiones regulares. Este es el código de `packages/flutter_tools/lib/src/android/android_workflow.dart` en la etiqueta 3.44.8:

```dart
// Flutter 3.44.8, packages/flutter_tools/lib/src/android/android_workflow.dart
final licenseCounts = RegExp(r'(\d+) of (\d+) SDK package licenses? not accepted.');
final licenseNotAccepted = RegExp(r'licenses? not accepted', caseSensitive: false);
final licenseAccepted = RegExp(r'All SDK package licenses accepted.');
```

Si alguna coincide, el estado pasa a ser `some`, `none` o `all`. Si ninguna coincide, el validador devuelve `LicensesAccepted.unknown`, que es la línea que estás mirando.

cmdline-tools 22.0 ya imprime el aviso de obsolescencia, pero después sigue haciendo el trabajo de licencias, así que las expresiones regulares todavía encuentran su línea. Con mi SDK de pruebas, donde solo estaba presente `android-sdk-license`, la 22.0 imprimió:

```text
Loading local repository...

6 of 7 SDK package licenses not accepted.
Review licenses that have not been accepted (y/N)?
```

cmdline-tools 23.0 elimina esa parte por completo. Ejecuté `sdkmanager --licenses` de la 23.0 dos veces, una con la carpeta `licenses/` presente y otra con la carpeta renombrada. La salida fue idéntica en ambos casos: el aviso, la advertencia "no longer needed", código de salida 0. La herramienta ya no informa el estado de las licencias de ninguna forma, así que Flutter no tiene nada que analizar. El autor del PR de la corrección llegó a la misma conclusión y tampoco encontró un subcomando de estado de licencias en la nueva CLI `android`.

La segunda mitad del ciclo viene del mismo lugar. `flutter doctor --android-licenses` es solo un envoltorio que ejecuta `sdkmanager --licenses` de forma interactiva y le pasa tus pulsaciones de teclado. Cuando la 23.0 imprime la advertencia y termina, no hay nada que aceptar, y Flutter no tiene nada nuevo que leer en la siguiente ejecución de `flutter doctor`.

## Reproducirlo: la matriz de versiones

Para asegurarme de que esa era toda la historia, armé una raíz de SDK de pruebas con `cmdline-tools/22.0` y `cmdline-tools/23.0`, apunté `ANDROID_HOME` hacia ella y ejecuté `flutter doctor -v` con cada combinación. Flutter busca primero `cmdline-tools/latest/bin/sdkmanager` y luego recurre a la carpeta versionada con el número más alto, así que ocultar la carpeta `23.0` basta para cambiar.

| Flutter | cmdline-tools | `licenses/` en disco | `flutter doctor` dice |
| --- | --- | --- | --- |
| 3.44.8 | 22.0 | solo `android-sdk-license` | Some Android licenses not accepted |
| 3.44.8 | 22.0 | ausente | Android licenses not accepted |
| 3.44.8 | 23.0 | solo `android-sdk-license` | Android license status unknown |
| 3.44.8 | 23.0 | ausente | Android license status unknown |
| 3.47.3 | 23.0 | solo `android-sdk-license` | All Android licenses accepted |
| 3.47.3 | 23.0 | ausente | Android licenses not accepted |
| 3.47.3 | 23.0 | `android-sdk-license` presente pero vacío | Android licenses not accepted |

En un Flutter sin corregir, la 23.0 convierte cualquier estado en "unknown". En la 3.47.3 la respuesta vuelve a depender de los archivos.

## Solución 1: actualizar Flutter a 3.47.3 o posterior

La corrección es [flutter/flutter#191554](https://github.com/flutter/flutter/pull/191554), fusionada en master el 2026-08-29 y aplicada con cherry-pick a stable ([#192133](https://github.com/flutter/flutter/pull/192133)) y beta ([#192132](https://github.com/flutter/flutter/pull/192132)) el 2026-09-02. Las primeras versiones que la contienen son stable 3.47.3 y beta 3.48.0-0.4.pre. La entrada del hotfix 3.47.3 en `CHANGELOG.md` menciona #191487 por nombre.

```bash
# Flutter 3.47.x stable channel
flutter channel stable
flutter upgrade
flutter --version   # expect 3.47.3 or later
flutter doctor -v
```

Lo que hace el parche es acotado. Agrega una expresión regular más, `--licenses option is no longer needed`. Cuando aparece esa línea y ninguno de los patrones anteriores coincidió, Flutter deja de confiar en stdout y lista `<sdk>/licenses/`. Cualquier archivo no oculto y no vacío ahí significa `all`. Si no hay ningún archivo utilizable, significa `none`. Si no se puede listar el directorio, el resultado es `unknown`. Las versiones anteriores de `sdkmanager` siguen pasando por el análisis original, sin cambios.

Si estás atado a una línea anterior de Flutter (3.44.x, 3.41.x), no hay backport. Los cherry-picks solo llegaron a las ramas candidatas 3.47 y 3.48, así que en esas líneas usa la Solución 3 o convive con la advertencia cosmética.

## Solución 2: confirmar que las licencias realmente están en disco

Antes de suponer que la línea de doctor miente, compruébalo. La aceptación de licencias siempre se ha registrado como archivos de hash bajo la raíz del SDK, y eso es lo que lee Gradle cuando decide si puede descargar automáticamente un paquete de plataforma o de build-tools que falta:

```bash
# any OS with a POSIX shell; ANDROID_HOME points at the SDK root
ls -la "$ANDROID_HOME/licenses"
cat "$ANDROID_HOME/licenses/android-sdk-license"
```

En una máquina que funciona verás al menos `android-sdk-license`, con uno o más hashes de 40 caracteres como `24333f8a63b6825ea9c5514f83c2829b004d1fee`. Si el archivo está ahí, `flutter build apk` funciona sin importar lo que diga un `flutter doctor` sin corregir. Quien reportó el problema notó lo mismo: las compilaciones de APK seguían saliendo bien.

Si la carpeta no existe, por ejemplo en una imagen de CI recién creada, cmdline-tools 23.0 cambió la forma de obtenerla. Ya no hay ninguna pregunta interactiva. Instalar cualquier paquete escribe el archivo de licencia por ti. Lo probé en dos raíces de SDK vacías con solo cmdline-tools 23.0 copiado como `latest`:

```bash
# cmdline-tools 23.0, fresh SDK root with no licenses/ folder
"$ANDROID_HOME/cmdline-tools/latest/bin/android" --no-metrics --sdk="$ANDROID_HOME" sdk install platform-tools

# or, the deprecated spelling, which forwards to the same code
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$ANDROID_HOME" --install platform-tools
```

Ambos comandos terminaron con código 0 con stdin cerrado, descargaron `platform-tools_r37.0.1` y dejaron `licenses/android-sdk-license` con el hash `24333f8a...`. Eso basta para que Flutter 3.47.3 informe "All Android licenses accepted". Fíjate en los nombres de los paquetes: el nuevo `android sdk install` usa barras (`platforms/android-36`, `build-tools/36.0.0`), no los punto y coma que usaba `sdkmanager`.

## Solución 3: fijar cmdline-tools 22.0 en Flutter anterior

Si estás atascado en una versión de Flutter sin la corrección y quieres la línea de doctor limpia, dale a Flutter un `sdkmanager` que todavía imprima conteos de licencias. Flutter elige primero `cmdline-tools/latest`, así que instalar la 22.0 junto a una 23.0 en `latest` no cambia nada. Tienes que quitar la 23.0 del camino.

En Android Studio, abre **Settings > Languages & Frameworks > Android SDK > SDK Tools**, marca **Show Package Details**, desmarca **Android SDK Command-line Tools (latest)**, marca **22.0** y aplica. Este es el workaround que confirmó quien reportó #191558.

Desde una terminal:

```bash
# macOS/Linux, cmdline-tools 23.0 currently installed as cmdline-tools/latest
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --install "cmdline-tools;22.0"
mv "$ANDROID_HOME/cmdline-tools/latest" "$HOME/cmdline-tools-23.0-backup"
ls "$ANDROID_HOME/cmdline-tools"   # only 22.0 should remain
flutter doctor --android-licenses
```

La instalación queda en `cmdline-tools/22.0`, y sin `latest` Flutter recurre a esa carpeta versionada. `flutter doctor --android-licenses` vuelve a mostrar la pregunta interactiva real, y puedes aceptar las que faltan. En un shell no interactivo, `yes | flutter doctor --android-licenses` sigue funcionando con la 22.0.

Dos advertencias sobre esta vía. Primero, es una fijación, y el próximo "update all" en Android Studio volverá a poner la 23.0 como `latest`. Segundo, algunas herramientas tienen `cmdline-tools/latest/bin` escrito a fuego (la descarga automática del SDK de Gradle, muchos scripts de CI). Una vez aceptadas las licencias, es más limpio actualizar Flutter y dejar que vuelva la 23.0 que mantener la 22.0 para siempre.

## Trampas y casos parecidos

**"All Android licenses accepted" en la 3.47.3 es más generoso que antes.** El respaldo basado en disco no puede distinguir `some` de `all`. Con solo `android-sdk-license` presente, la 22.0 decía "6 of 7 SDK package licenses not accepted" y el Flutter anterior decía "Some Android licenses not accepted". La 3.47.3 con la 23.0 dice "All Android licenses accepted". Para compilaciones normales eso es correcto, ya que `android-sdk-license` cubre plataformas, build-tools, platform-tools y el NDK. Las imágenes de sistema preview, TV y XR tienen sus propios archivos de licencia (son las otras seis del conteo de la 22.0), así que si instalas alguna de ellas, busca su archivo en `licenses/` en lugar de confiar en la línea de doctor.

**Un archivo de licencia vacío cuenta como no aceptado.** Algunas recetas de CI hacen `touch` al archivo para simular la aceptación. En la 3.47.3, un `android-sdk-license` de cero bytes da "Android licenses not accepted". Escribe el hash real o, mejor aún, deja que `android sdk install` lo cree.

**Scripts de CI que hacen grep sobre la salida de doctor.** Un paso como `flutter doctor -v | grep "All Android licenses accepted"` falla en cualquier Flutter sin corregir con la 23.0. `yes | flutter doctor --android-licenses` ya no falla, pero tampoco hace nada. Comprueba el archivo en su lugar: `test -s "$ANDROID_HOME/licenses/android-sdk-license"`. Si pruebas varias versiones de Flutter en un solo pipeline, como en [apuntar a varias versiones de Flutter desde un solo pipeline de CI](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/), espera que las ramas más antiguas de la matriz impriman "unknown" mientras la 3.47.3 y posteriores pasan.

**El binario `android` se instala a sí mismo en el primer uso.** La primera vez que ejecuté `cmdline-tools/23.0/bin/android`, imprimió "Downloading Android CLI...", se desempaquetó en `~/.android/cli` y mostró los términos de servicio del SDK y un aviso sobre métricas de uso. Agrega `--no-metrics` en CI. `android --version` informó `1.0.16261425` con cmdline-tools 23.0. El binario también existe en la 22.0.

**"Unable to locate Android SDK" es otro problema.** Mientras armaba el SDK de pruebas, mi primera ejecución de doctor falló antes de llegar siquiera a la verificación de licencias, porque la raíz tenía cmdline-tools pero no `platforms` ni `build-tools`. Si ves esa línea, o "cmdline-tools component is missing", la solución está en [el artículo sobre cmdline-tools component is missing](/es/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/), no aquí.

**`flutter config --android-sdk` tiene prioridad sobre `ANDROID_HOME`.** Si en algún momento configuraste una ruta con `flutter config`, Flutter ignora `ANDROID_HOME` y puede estar revisando un SDK distinto del que estás inspeccionando. `flutter config --list` muestra la ruta guardada, y `flutter doctor -v` imprime la ruta que realmente usó en la línea "Android SDK at".

**La nueva CLI todavía no está integrada en Flutter.** Un PR abierto, [#191826](https://github.com/flutter/flutter/pull/191826), también mueve el aprovisionamiento del NDK de Flutter a `android sdk install`. Al 2026-09-15 no está fusionado, así que Flutter 3.47.3 sigue invocando el `sdkmanager` obsoleto para las licencias y depende de que mantenga vivas las opciones antiguas.

## Relacionado

- [Solución: flutter doctor informa cmdline-tools component is missing](/es/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/) cubre el orden de búsqueda del SDK en Flutter y los requisitos de Java de `sdkmanager` que también aplican aquí.
- Si quien se queja de tu JDK es Gradle y no doctor, consulta [Toolchain installation does not provide the required capabilities](/es/2026/08/fix-toolchain-installation-does-not-provide-the-required-capabilities-in-flutter/).
- Una descarga corrupta del SDK se manifiesta de otra forma: [NDK (Side by side): Not in GZIP format](/es/2026/08/fix-an-error-occurred-while-preparing-sdk-package-ndk-not-in-gzip-format/).
- Otro caso en el que una versión hotfix es la verdadera solución: [Could not create Dart VM instance después de flutter upgrade](/es/2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build/).

## Fuentes

- [flutter/flutter#191487](https://github.com/flutter/flutter/issues/191487), el issue de seguimiento P1, con los duplicados [#191558](https://github.com/flutter/flutter/issues/191558) y [#191963](https://github.com/flutter/flutter/issues/191963).
- [flutter/flutter#191554](https://github.com/flutter/flutter/pull/191554), la corrección, con los cherry-picks a stable y beta [#192133](https://github.com/flutter/flutter/pull/192133) y [#192132](https://github.com/flutter/flutter/pull/192132).
- [flutter/flutter#191826](https://github.com/flutter/flutter/pull/191826), el PR abierto para el soporte completo de Android CLI.
- [CHANGELOG de Flutter en 3.47.3](https://github.com/flutter/flutter/blob/3.47.3/CHANGELOG.md) y [`android_workflow.dart` en 3.47.3](https://github.com/flutter/flutter/blob/3.47.3/packages/flutter_tools/lib/src/android/android_workflow.dart).
- [Documentación de Android CLI](https://developer.android.com/tools/agents/android-cli) para la sintaxis de `android sdk install`, `list`, `update` y `remove`.
- [Documentación de sdkmanager](https://developer.android.com/tools/sdkmanager).
