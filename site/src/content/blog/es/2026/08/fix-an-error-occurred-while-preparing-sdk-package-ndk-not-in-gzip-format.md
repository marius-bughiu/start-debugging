---
title: "Solución: An error occurred while preparing SDK package NDK (Side by side): Not in GZIP format"
description: "El SDK Manager vuelve a descomprimir un archivo corrupto que guardó en .downloadIntermediates. Borra esa carpeta y el directorio ndk/<version> a medio extraer, y vuelve a compilar."
pubDate: 2026-08-14
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "ndk"
lang: "es"
translationOf: "2026/08/fix-an-error-occurred-while-preparing-sdk-package-ndk-not-in-gzip-format"
translatedBy: "claude"
translationDate: 2026-08-14
---

Borra la caché de descargas del SDK Manager y el directorio del NDK parcialmente extraído, y vuelve a compilar. El archivo que está descomprimiendo está corrupto y, como lo guarda en caché, fallará de forma idéntica en cada reintento hasta que lo elimines. En Windows eso es `%LOCALAPPDATA%\Android\Sdk\.downloadIntermediates` más `%LOCALAPPDATA%\Android\Sdk\ndk\28.2.13676358`. Si vuelve a fallar con la caché limpia, estás detrás de un proxy o de un antivirus que intercepta TLS y reescribe una descarga de 750 MB, y la respuesta es instalar el NDK a mano desde `dl.google.com`.

## El error, completo

El mensaje aparece a mitad de la compilación, normalmente durante la fase de configuración de Gradle, y es una línea de advertencia en lugar del fallo de nivel superior:

```
Preparing "Install NDK (Side by side) 28.2.13676358 v.28.2.13676358".
Warning: An error occurred while preparing SDK package NDK (Side by side) 28.2.13676358: Not in GZIP format.

FAILURE: Build failed with an exception.
```

Debajo hay un `java.util.zip.ZipException: Not in GZIP format` lanzado desde `GZIPInputStream`, y el número de versión varía según lo que fije tu proyecto. Las dos cosas que identifican este fallo concreto son el nombre del paquete `NDK (Side by side)` y el hecho de que se reproduce byte por byte en cada reintento, incluso después de reiniciar la máquina, de un `flutter clean` y de reiniciar Android Studio. Una red realmente inestable produce un error distinto cada vez. Este no.

## ¿Qué hace que una compilación de Flutter descargue el NDK?

Esta es la parte que sorprende a mucha gente: una aplicación Flutter sin código nativo, sin C++ y sin bloque `externalNativeBuild` igualmente descarga un NDK de 750 MB en la primera compilación. Es deliberado, y es cosa de Flutter más que del Android Gradle Plugin.

AGP necesita el NDK para eliminar los símbolos de depuración de las bibliotecas nativas, pero solo lo descarga cuando cree que está compilando código nativo. Flutter siempre distribuye bibliotecas nativas (el motor y tu Dart compilado con AOT), así que necesita esa limpieza de símbolos y por eso engaña a AGP para que descargue el toolchain. Verificado contra una instalación local de Flutter 3.44.2 stable, `FlutterPlugin.kt` llama a esto sin condiciones en la línea 228:

```kotlin
// Flutter 3.44.2, packages/flutter_tools/gradle/src/main/kotlin/FlutterPluginUtils.kt
internal fun forceNdkDownload(gradleProject: Project, flutterSdkRootPath: String) {
    val gradleProjectAndroidExtension = getLegacyAndroidExtension(gradleProject)
    val forcingNotRequired: Boolean =
        gradleProjectAndroidExtension.externalNativeBuild.cmake.path != null
    if (forcingNotRequired) {
        return
    }

    // Otherwise, point to an empty CMakeLists.txt, and ignore associated warnings.
    gradleProjectAndroidExtension.externalNativeBuild.cmake.path(
        "$flutterSdkRootPath/packages/flutter_tools/gradle/src/main/scripts/CMakeLists.txt"
    )
    // ...
}
```

El `CMakeLists.txt` al que apunta es un archivo vacío cuyo único propósito es hacerle creer a AGP que hay código nativo por compilar. Así que la descarga del NDK no es opcional, no se puede omitir, y toda máquina nueva o todo runner de CI nuevo se topa con ella. Una descarga de tres cuartos de gigabyte que se ejecuta una vez por entorno es exactamente el perfil que produce archivos truncados.

La versión que se descarga viene de Flutter, no de ti. En la misma instalación, `packages/flutter_tools/lib/src/android/gradle_utils.dart` línea 68:

```dart
// Flutter 3.44.2, packages/flutter_tools/lib/src/android/gradle_utils.dart
const ndkVersion = '28.2.13676358';
```

Ese es el NDK r28c. Revisé la copia instalada en esta máquina y `ndk/28.2.13676358/source.properties` dice `Pkg.ReleaseName = r28c`, así que la correspondencia entre revisión y versión no es una suposición.

## ¿Por qué el archivo no pasa la comprobación de GZIP?

Ordenadas según la frecuencia con la que cada una es la causa real.

**Un archivo corrupto en caché en `.downloadIntermediates`.** El SDK Manager prepara la descarga de un paquete en `<sdk>/.downloadIntermediates` antes de descomprimirlo. Si la conexión se cortó, el disco se llenó o el proceso murió a mitad de camino, queda un archivo truncado en ese directorio. El descargador trata el archivo en caché como una descarga reanudable y se lo pasa directamente al descompresor en el siguiente intento, así que reintentar reproduce la misma excepción para siempre. Es el caso en la gran mayoría de los reportes, y por eso "ya lo intenté cinco veces" no es prueba en contra.

**Un proxy o un antivirus que inspecciona TLS y reescribe la respuesta.** `GZIPInputStream` lanza exactamente esta cadena cuando los dos primeros bytes no son el número mágico de gzip `1f 8b`. Un proxy corporativo que responde con una página HTML de bloqueo, un portal cautivo que intercepta la solicitud o un escáner que pone `Content-Encoding: gzip` en un cuerpo que en realidad no comprimió producen un flujo que falla la comprobación del número mágico en el primer byte. La señal es que limpiar la caché no ayuda: obtienes una descarga nueva e igual de inválida.

**Un disco lleno.** Una descarga de 750 MB más una extracción de 4 GB necesita un margen que el SDK Manager no comprueba de antemano. Escribe lo que puede y el resultado truncado falla de la misma manera.

## ¿Cómo limpio la caché de descargas y el NDK a medio extraer?

Cierra Android Studio primero, porque en Windows mantiene abiertos manejadores sobre estos directorios. La raíz del SDK es `%LOCALAPPDATA%\Android\Sdk` en Windows, `~/Library/Android/sdk` en macOS y `~/Android/Sdk` en Linux.

```bash
# macOS / Linux. Adjust SDK for your platform.
SDK="$HOME/Library/Android/sdk"
rm -rf "$SDK/.downloadIntermediates" "$SDK/.temp" "$SDK/temp" "$SDK/downloadIntermediates"
rm -rf "$SDK/ndk/28.2.13676358"
```

```powershell
# Windows PowerShell
$sdk = "$env:LOCALAPPDATA\Android\Sdk"
Remove-Item -Recurse -Force "$sdk\.downloadIntermediates","$sdk\.temp","$sdk\temp","$sdk\downloadIntermediates" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$sdk\ndk\28.2.13676358" -ErrorAction SilentlyContinue
```

Ambas grafías, con y sin punto inicial, aparecen según la versión de Android Studio, así que borra las que existan e ignora las que no. En la instalación que inspeccioné para este artículo el SDK trae `.temp` con punto inicial.

Borrar el directorio `ndk/<version>` importa tanto como limpiar la caché, y es el paso que casi todas las guías se saltan. Sigue leyendo para ver por qué.

## ¿Y si la siguiente compilación falla con CXX1101?

Eso ocurre porque la descompresión fallida dejó atrás un directorio parcial, y ahora otra ruta de código lo encuentra.

```
> [CXX1101] NDK at /Users/you/Library/Android/sdk/ndk/28.2.13676358
  did not have a source.properties file
```

AGP resuelve un NDK instalado leyendo `source.properties` dentro de `ndk/<revision>/`. El SDK Manager escribe ese archivo al final, después de que el archivo comprimido se extrae por completo, precisamente para que una instalación a medias no se confunda con una buena. Cuando la descompresión muere por el error de gzip te quedas con un directorio lleno de archivos del toolchain y sin `source.properties`, que no es ni ausente ni válido.

A partir de ahí el SDK Manager ve un directorio en la ruta esperada y no vuelve a descargar, mientras que AGP no ve `source.properties` y se niega a usarlo. La compilación queda atrapada entre dos componentes que no se ponen de acuerdo sobre si el paquete existe, y el mensaje de error cambia a algo que parece no tener relación. Por eso muchos hilos sobre esto terminan con gente poniendo `ndk.dir` en `local.properties` o fijando una versión anterior del NDK: están sorteando el segundo error sin haber limpiado nunca el primero. Borra el directorio y ambos desaparecen juntos.

Como referencia, una copia correctamente instalada contiene los dos archivos:

```
ndk/28.2.13676358/source.properties   # Pkg.Revision = 28.2.13676358, Pkg.ReleaseName = r28c
ndk/28.2.13676358/package.xml         # written by the SDK Manager, not present in the standalone zip
```

## ¿Cómo instalo el NDK desde la línea de comandos?

Sacar a Gradle y a Android Studio de la ecuación hace que el fallo sea mucho más fácil de leer, y `sdkmanager` imprime la traza de pila subyacente en lugar de una advertencia de una sola línea. El binario vive en `<sdk>/cmdline-tools/latest/bin`. Si no está ahí, [instalar las Android SDK Command-line Tools](/es/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/) es el requisito previo.

```bash
# Android SDK Command-line Tools 19.0, NDK r28c
cd "$HOME/Library/Android/sdk/cmdline-tools/latest/bin"
./sdkmanager --install "ndk;28.2.13676358" --verbose
```

Si estás detrás de un proxy, pásalo de forma explícita en vez de confiar en la configuración de Studio, que `sdkmanager` no lee:

```bash
./sdkmanager --install "ndk;28.2.13676358" \
  --proxy=http --proxy_host=proxy.corp.example --proxy_port=8080
```

No recurras a `--no_https` como solución. Degrada la transferencia a HTTP simple, lo que hace que un proxy que intercepta tenga más probabilidades de estropear el cuerpo, no menos. Existe para entornos que bloquean CONNECT por completo.

## ¿Cómo instalo el NDK a mano cuando el descargador sigue fallando?

Esta es la salida de emergencia fiable en una red restringida, porque mueve la descarga a una herramienta que tú controlas y te deja verificar los bytes.

1. Descarga el archivo independiente desde `https://dl.google.com/android/repository/android-ndk-r28c-linux.zip`, sustituyendo por `windows` en Windows. macOS entrega un `.dmg` en lugar de un zip en esa URL, así que móntalo y copia el contenido.

2. Verifica el SHA-1 contra el valor publicado en la página de descargas del NDK antes de confiar en él. Para r28c el zip de Linux pesa 722 261 334 bytes con SHA-1 `a7b54a5de87fecd125a17d54f73c446199e72a64`, y el de Windows pesa 748 118 221 bytes con SHA-1 `086bba43ff2f5eb0e387b15c8278bb4e0d89ba1d`. Si el hash no coincide, tu proxy queda confirmado como culpable y ninguna limpieza de caché va a ayudar.

```bash
# Verify, then unpack. NDK r28c.
sha1sum android-ndk-r28c-linux.zip
unzip -q android-ndk-r28c-linux.zip
```

3. Renombra el directorio extraído `android-ndk-r28c` al número de revisión y muévelo dentro del SDK. La revisión, no el nombre de la versión, es lo que AGP busca:

```bash
mv android-ndk-r28c "$HOME/Android/Sdk/ndk/28.2.13676358"
cat "$HOME/Android/Sdk/ndk/28.2.13676358/source.properties"
# Pkg.Revision = 28.2.13676358
```

4. Compila. AGP lee `source.properties` y acepta el toolchain. La única diferencia frente a una instalación gestionada es el `package.xml` que falta, así que `sdkmanager --list_installed` no reportará el paquete. Eso es cosmético para la compilación, pero importa si tu CI valida el listado de paquetes en lugar del directorio.

## ¿Qué versión del NDK necesita realmente mi proyecto?

La que fije tu proyecto y, por defecto, Flutter la fija por ti. A agosto de 2026:

| Rol | Versión del NDK | Cadena de revisión |
| --- | --- | --- |
| Predeterminada en Flutter 3.44 | r28c | `28.2.13676358` |
| Última estable | r29 | `29.0.14206865` |
| Última LTS | r27d | `27.3.13750724` |

No "arregles" este error bajando a un NDK que por casualidad esté en caché en tu máquina. NDK r28 es la primera versión que compila bibliotecas compartidas alineadas para páginas de memoria de 16 KB, que Google Play ahora exige, así que bajar a r27 para esquivar un problema de descarga cambia un fallo de compilación por [un rechazo en la tienda](/es/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/).

A veces sí necesitas subir la versión, cuando un plugin requiere un toolchain más nuevo que el predeterminado de Flutter. Flutter lo detecta y te dice exactamente qué escribir:

```
Your project is configured with Android NDK 28.2.13676358, but the following
plugin(s) depend on a different Android NDK version:
- some_plugin requires Android NDK 29.0.14206865
Fix this issue by using the highest Android NDK version (they are backward compatible).
```

```kotlin
// android/app/build.gradle.kts, AGP 8.x
android {
    ndkVersion = "29.0.14206865"
}
```

Cambiar esa cadena inicia una descarga nueva de un paquete distinto, así que si sigues en una red que corrompe transferencias grandes, instala a mano la nueva revisión antes de cambiar el valor fijado. De lo contrario verás el mismo error mudarse a un número de versión nuevo.

## Trampas que producen el mismo mensaje por otra razón

**Imágenes de Docker y de CI con poco presupuesto de capa.** Un contenedor de compilación que se queda sin espacio de escritura a mitad de la extracción falla igual que una descarga truncada. Revisa el espacio libre en el volumen del SDK antes de culpar a la red. Precocinar el NDK dentro de la imagen es la solución duradera, y elimina una descarga de 750 MB de cada job.

**Dos compilaciones compitiendo por un mismo SDK.** Jobs de CI en paralelo que comparten un directorio de SDK montado intercalan escrituras en `.downloadIntermediates` y corrompen los archivos del otro. Dale a cada job su propio `ANDROID_SDK_ROOT`, o serializa la instalación de la primera ejecución.

**`Failed to install the following Android SDK packages as some licences have not been accepted`.** Error distinto, misma fase de compilación. Ese se arregla con `sdkmanager --licenses`, no limpiando cachés.

**Un genérico `Gradle task assembleDebug failed with exit code 1`.** Esa línea es un envoltorio, y la advertencia de gzip puede haber quedado mucho más arriba. Si no ves la causa real, [vuelve a compilar en modo detallado primero](/es/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) en lugar de adivinar.

**Un fallo de `.gz` en la propia descarga de un plugin.** Algunos plugins descargan sus propios binarios precompilados en tiempo de configuración. Si el nombre del paquete que falla no es `NDK (Side by side)`, este artículo no es la página correcta.

## Relacionados

Si la compilación ya estaba enferma antes de que apareciera la descarga del NDK, [los conflictos de AndroidX durante una compilación de Flutter para Android](/es/2026/05/fix-androidx-conflict-during-flutter-android-build/) y [los desajustes de minSdkVersion provocados por plugins](/es/2026/05/fix-flutter-background-fetch-requires-minsdkversion-21/) son los dos que más a menudo están debajo de un fallo de primera ejecución en una máquina nueva. Para equipos donde cada runner paga esta descarga una vez, [apuntar a varias versiones de Flutter desde un solo pipeline de CI](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) cubre cómo cachear el SDK correctamente para que ocurra una vez por imagen y no una vez por job.

## Fuentes

- [NDK Downloads](https://developer.android.com/ndk/downloads), para las cadenas de revisión de r29, r28c y r27d, los tamaños de archivo y las sumas SHA-1 citadas arriba.
- [Referencia de línea de comandos de sdkmanager](https://developer.android.com/studio/command-line/sdkmanager), para `--install`, `--sdk_root`, `--verbose` y el trío `--proxy`, `--proxy_host`, `--proxy_port`.
- [NDK does not have Source properties file in my project](https://github.com/flutter/flutter/issues/164085) y [New, default Flutter Projects fail on build with NDK...did not have a source.properties file](https://github.com/flutter/flutter/issues/102831), para el fallo posterior CXX1101 y los rodeos a los que recurre la gente en lugar de limpiar la caché.
- [Android NDK version doesn't seem to be right for new projects](https://github.com/flutter/flutter/issues/163945), para saber cómo se elige la revisión predeterminada de Flutter y cuándo un plugin te obliga a subir.
- Código citado de una instalación local de Flutter 3.44.2 stable: `packages/flutter_tools/gradle/src/main/kotlin/FlutterPlugin.kt`, `FlutterPluginUtils.kt`, `FlutterExtension.kt`, `packages/flutter_tools/gradle/src/main/scripts/CMakeLists.txt` y `packages/flutter_tools/lib/src/android/gradle_utils.dart`.
- Detalles de la estructura del SDK verificados contra un Android SDK en esta máquina: `ndk/28.2.13676358/source.properties` (`Pkg.ReleaseName = r28c`), `ndk/28.2.13676358/package.xml` y el directorio de caché `.temp` con punto inicial.
