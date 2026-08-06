---
title: "Solución: flutter doctor informa cmdline-tools component is missing"
description: "Instala Android SDK Command-line Tools de modo que los binarios queden en <sdk>/cmdline-tools/latest/bin, apunta ANDROID_HOME a la raíz del SDK y vuelve a ejecutar flutter doctor."
pubDate: 2026-08-06
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "dart"
  - "tooling"
lang: "es"
translationOf: "2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing"
translatedBy: "claude"
translationDate: 2026-08-06
---

La solución en una frase: `flutter doctor` está verificando si existe un directorio llamado `cmdline-tools` directamente bajo la raíz de tu Android SDK, y no existe. En Android Studio abre **Tools > SDK Manager > SDK Tools**, marca **Android SDK Command-line Tools (latest)** y haz clic en Apply. Sin Android Studio, descomprime el archivo de command-line tools de forma que los binarios terminen en `<sdk-root>/cmdline-tools/latest/bin`, define `ANDROID_HOME` apuntando a `<sdk-root>` (no a la carpeta `cmdline-tools`) y luego ejecuta `flutter doctor --android-licenses`. La línea "Android license status unknown" que aparece debajo es una consecuencia, no un segundo error: la herramienta de licencias es `sdkmanager`, y `sdkmanager` viene dentro del paquete que te falta.

```text
[!] Android toolchain - develop for Android devices (Android SDK version 36.0.0)
    • Android SDK at C:\Users\mariu\AppData\Local\Android\Sdk
    ✗ cmdline-tools component is missing.
      Try installing or updating Android Studio.
      Alternatively, download the tools from https://developer.android.com/studio#command-line-tools-only and make sure to set the ANDROID_HOME environment variable.
      See https://developer.android.com/studio/command-line for more details.
    ✗ Android license status unknown.
      Run `flutter doctor --android-licenses` to accept the SDK licenses.
```

Todo lo que sigue está verificado con Flutter 3.44.7 stable (Dart 3.12.x), el canal stable al 2026-08-06, con un Android SDK que tiene `cmdline-tools;19.0`, Build-Tools 36.0.0, Platform-Tools 37.0.0 y OpenJDK 21.0.11. La revisión más alta de command-line tools en el canal stable hoy es la 22.0.

## La verificación es una simple prueba de existencia de directorio

Vale la pena saber lo poco que hace el doctor aquí, porque eso explica la mayoría de los casos confusos. En `packages/flutter_tools/lib/src/android/android_workflow.dart` el validador hace esto:

```dart
// flutter_tools, stable channel, Flutter 3.44.7
_task = 'Validating Android SDK command line tools are available';
if (!androidSdk.cmdlineToolsAvailable) {
  messages.add(
    const ValidationMessage.error(
      'cmdline-tools component is missing.\n'
      'Try installing or updating Android Studio.\n'
      ...
    ),
  );
  return ValidationResult(ValidationType.missing, messages);
}
```

Y `cmdlineToolsAvailable` en `android_sdk.dart` es una sola línea:

```dart
// flutter_tools, stable channel, Flutter 3.44.7
bool get cmdlineToolsAvailable =>
    directory.childDirectory('cmdline-tools').existsSync();
```

No se ejecuta ningún binario. No se analiza ninguna versión. Flutter toma la raíz del SDK que resolvió, le agrega `cmdline-tools` y llama a `existsSync()`. Eso significa que solo hay dos formas de ver este mensaje: la carpeta realmente no está, o Flutter resolvió una raíz de SDK distinta de la que tú estás mirando.

El segundo caso es lo bastante común como para detallar el orden de resolución que usa Flutter, tomado de `locateAndroidSdk()`:

1. La clave `android-sdk` en la configuración propia de Flutter, definida con `flutter config --android-sdk <path>`.
2. La variable de entorno `ANDROID_HOME`.
3. La variable de entorno `ANDROID_SDK_ROOT`, que Google marcó como obsoleta pero Flutter todavía lee.
4. La ruta por defecto de la plataforma: `~/Android/Sdk` en Linux, `~/Library/Android/sdk` en macOS, `%LOCALAPPDATA%\Android\sdk` en Windows.
5. Un último recurso: escanear el PATH buscando `aapt` (bajo `build-tools/<version>/`) o `adb` (bajo `platform-tools/`), e inferir la raíz a partir de donde estén.

Un `flutter config --android-sdk` obsoleto de hace dos computadoras gana sobre un `ANDROID_HOME` perfectamente correcto. `flutter doctor -v` imprime la ruta que eligió, y esa es la primera línea que hay que leer.

Una vez que la carpeta existe, una búsqueda aparte localiza el ejecutable real. `getCmdlineToolsPath` prueba, en orden:

1. `cmdline-tools/latest/bin/sdkmanager[.bat]`
2. la carpeta `cmdline-tools/<version>/bin/sdkmanager[.bat]` con el número más alto
3. `tools/bin/sdkmanager[.bat]`, el layout anterior a 2020, que se omite para `sdkmanager` porque se solicita con `skipOldTools: true`

Así que `latest` tiene prioridad, pero una carpeta con número de versión también funciona. Esa distinción importa en uno de los detalles finos de más abajo.

## Reproducirlo en diez segundos

En una máquina que funciona, el error está a un renombrado de distancia:

```bash
# Flutter 3.44.7 stable, Windows, Android SDK at %LOCALAPPDATA%\Android\Sdk
mv "$LOCALAPPDATA/Android/Sdk/cmdline-tools" "$LOCALAPPDATA/Android/Sdk/cmdline-tools.bak"
flutter doctor
```

Ese es todo el modo de fallo. También es la razón por la que el consejo de "reinstala Android Studio" suele funcionar por el motivo equivocado: una instalación nueva de Studio marca la casilla de command-line tools, así que la carpeta aparece.

## Solución 1: instalarlo desde el SDK Manager de Android Studio

Este es el camino recomendado si tienes Android Studio, porque Studio además mantiene el paquete actualizado.

1. **Tools > SDK Manager** (o el ícono de SDK Manager en la barra de herramientas).
2. Selecciona la pestaña **SDK Tools**.
3. Marca **Android SDK Command-line Tools (latest)**. Ya que estás ahí, confirma que **Android SDK Build-Tools** y **Android SDK Platform-Tools** también estén marcados, porque Flutter los necesita.
4. Haz clic en **Apply**, acepta la licencia y espera la descarga.
5. Ejecuta `flutter doctor --android-licenses` y acepta todo, luego `flutter doctor` otra vez.

Fíjate en el sufijo "(latest)" en la etiqueta de la casilla. No es decorativo: es lo que hace que Studio instale en `cmdline-tools/latest/` en vez de en una carpeta numerada.

## Solución 2: instalarlo con sdkmanager, si ya tienes alguna versión

Si tienes cualquier command-line tools, incluso una vieja, úsala para instalar el paquete actual:

```bash
# Android SDK Command-line Tools 19.0, JDK 21
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --install "cmdline-tools;latest"
```

En Windows el binario es `sdkmanager.bat`. Si quieres un pin reproducible para CI en vez de un objetivo móvil, nombra la revisión de forma explícita:

```bash
# Pin for CI. 22.0 is the newest on the stable channel as of 2026-08-06.
sdkmanager --install "cmdline-tools;22.0"
```

Aquí hay una circularidad evidente: `sdkmanager` vive dentro de `cmdline-tools`, así que si el paquete falta no puedes usar `sdkmanager` para instalarlo. Para eso está la Solución 3.

## Solución 3: preparar el paquete a mano

Este es el camino para máquinas Linux sin interfaz gráfica, contenedores y cualquiera que no quiera Android Studio. Descarga el archivo "Command line tools only" desde la página de descarga de Android Studio y luego arma el layout que espera el tooling de Google. El archivo se descomprime en una carpeta que se llama literalmente `cmdline-tools`, lo cual está un nivel corto de lo correcto.

```bash
# Android SDK Command-line Tools, Linux, 2026-08
export ANDROID_HOME="$HOME/Android/Sdk"
mkdir -p "$ANDROID_HOME/cmdline-tools"
unzip -q commandlinetools-linux-*.zip -d /tmp/clt
mv /tmp/clt/cmdline-tools "$ANDROID_HOME/cmdline-tools/latest"
```

El layout de destino, que es el que especifica la documentación del SDK Manager:

```text
$ANDROID_HOME/
└── cmdline-tools/
    └── latest/
        ├── bin/
        ├── lib/
        ├── NOTICE.txt
        └── source.properties
```

Como referencia, `bin/` en una instalación real de 19.0 (Windows, por eso los wrappers `.bat`) contiene:

```text
apkanalyzer.bat  avdmanager.bat  d8.bat     lint.bat      profgen.bat
r8.bat           resourceshrinker.bat  retrace.bat  screenshot2.bat  sdkmanager.bat
```

Después, persiste el entorno y pon las herramientas en el PATH:

```bash
# ~/.bashrc or ~/.zshrc
export ANDROID_HOME="$HOME/Android/Sdk"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
```

`ANDROID_HOME` tiene que ser la raíz del SDK. Apuntarlo a `$HOME/Android/Sdk/cmdline-tools` o a `.../cmdline-tools/latest/bin` es la versión autoinfligida más común de este error, y produce exactamente el mismo mensaje porque `<esa ruta>/cmdline-tools` no existe.

Por último, instala el resto de lo que Flutter necesita y verifica:

```bash
sdkmanager --install "platform-tools" "platforms;android-36" "build-tools;36.0.0"
sdkmanager --version
sdkmanager --list_installed
flutter doctor --android-licenses
flutter doctor -v
```

`sdkmanager --list_installed` es la verificación honesta. En la máquina con la que se escribió este artículo imprime:

```text
Installed packages:
  Path                  | Version       | Description                             | Location
  cmdline-tools;19.0    | 19.0          | Android SDK Command-line Tools (latest) | cmdline-tools\latest
  build-tools;36.0.0    | 36.0.0        | Android SDK Build-Tools 36              | build-tools\36.0.0
  platform-tools        | 37.0.0        | Android SDK Platform-Tools              | platform-tools
  platforms;android-36  | 2             | Android SDK Platform 36, rev 2          | platforms\android-36
```

## Solución 4: decirle a Flutter dónde está realmente el SDK

Si la carpeta existe y `sdkmanager --version` funciona pero `flutter doctor` sigue quejándose, Flutter está mirando en otra parte. Sobrescribe el orden de resolución en el primer paso:

```bash
flutter config --android-sdk "$HOME/Android/Sdk"
flutter doctor -v
```

Dos trampas aquí. `flutter config --android-studio-dir` es una opción distinta, para la instalación de Studio y no para el SDK, y apuntarla a `.../cmdline-tools/latest/bin` es una forma documentada de acabar de nuevo en este error. Y `flutter config` escribe en un archivo de configuración a nivel de usuario, así que un valor definido una vez te acompaña en todos los proyectos hasta que lo borres con `flutter config --android-sdk ""`.

## Detalles finos que parecen el mismo error

**"Observed package id 'cmdline-tools;19.0' in inconsistent location"**. Cada invocación de `sdkmanager` en mi máquina imprime esto:

```text
Warning: Observed package id 'cmdline-tools;19.0' in inconsistent location
'C:\Users\mariu\AppData\Local\Android\Sdk\cmdline-tools\latest'
(Expected 'C:\Users\mariu\AppData\Local\Android\Sdk\cmdline-tools\19.0')
```

Es cosmético. El paquete instalado registra `Pkg.Path=cmdline-tools;19.0` en su `source.properties`, pero el SDK Manager lo colocó en `latest` porque eso es lo que significa el paquete "(latest)". `sdkmanager` sigue funcionando, `flutter doctor` sigue pasando. No lo "arregles" renombrando `latest` a `19.0`: Flutter igual lo encontraría por la búsqueda con número de versión, pero la descarga automática del SDK de Gradle y la mayoría de los scripts de CI tienen `cmdline-tools/latest/bin` escrito a mano y se romperían.

**Dos carpetas `latest`**. Si ves `latest` junto a `latest-2`, el SDK Manager instaló encima de un directorio que no pudo reemplazar, normalmente porque un proceso `sdkmanager` o `adb` mantenía abierto un archivo. Borra `latest`, renombra `latest-2` a `latest` y vuelve a ejecutar `flutter doctor`.

**`ANDROID_SDK_ROOT` definida pero `ANDROID_HOME` vacía**. Flutter lee ambas y prefiere `ANDROID_HOME`. Gradle y el Android Gradle Plugin llevan años moviéndose en la dirección contraria, y algunas herramientas de terceros ahora solo leen `ANDROID_HOME`. Define `ANDROID_HOME`; define `ANDROID_SDK_ROOT` con el mismo valor solo si algo de tu toolchain todavía lo necesita.

**Un mensaje distinto: "Android sdkmanager not found."** Completo: `Android sdkmanager not found. Update to the latest Android SDK and ensure that the cmdline-tools are installed to resolve this.` Esta es una verificación posterior, y significa que la carpeta pasó la prueba de existencia pero no se encontró ningún binario `sdkmanager` bajo `latest/bin` ni bajo ningún `bin` con número de versión. La causa habitual es un descomprimido anidado, `cmdline-tools/latest/cmdline-tools/bin/`, por mover la carpeta del archivo en vez de su contenido.

**Un tercer mensaje: "Android sdkmanager tool was found, but failed to run."** Completo: `Android sdkmanager tool was found, but failed to run ($sdkManagerPath): "$error".` El binario existe y se está ejecutando; algo dentro está lanzando una excepción. Ejecútalo directamente para ver la traza de pila real. El culpable clásico es `JAVA_HOME` apuntando a un runtime viejo, lo que aparece como `UnsupportedClassVersionError` con "class file version 61.0" (Java 17) contra un runtime que "recognizes class file versions up to 55.0" (Java 11). Las command-line tools 11.0 y posteriores están compiladas para Java 17. Los JDK más nuevos no dan problema en la dirección contraria: la 19.0 corre sin quejas sobre OpenJDK 21.0.11, verificado para este artículo.

**WSL y contenedores**. No apuntes un `ANDROID_HOME` de Linux a un SDK de Windows a través de `/mnt/c`. Los binarios de Linux no están ahí, los bits de ejecución están mal y vas a terminar persiguiendo la variante "sdkmanager not found". Instala un SDK nativo dentro del entorno Linux.

**Runners de CI**. En GitHub Actions, `android-actions/setup-android` instala las command-line tools y las pone en el PATH antes de que corra nada más, lo cual elimina por completo esta clase de fallo del pipeline. Fija la revisión en vez de seguir a `latest` si quieres que las compilaciones de hace seis meses sigan siendo reproducibles, el mismo razonamiento que aplica cuando [apuntas a varias versiones de Flutter desde un solo pipeline de CI](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).

**La línea de licencias no se limpia sola**. Después de instalar el paquete, `flutter doctor` seguirá informando `Android license status unknown` hasta que ejecutes `flutter doctor --android-licenses` y aceptes cada una. En una shell no interactiva, `yes | flutter doctor --android-licenses` hace el trabajo.

## Relacionados

- [Solución: Gradle task assembleDebug failed with exit code 1 en una compilación Android de Flutter](/es/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) -- el siguiente muro contra el que chocas una vez que el toolchain valida y la compilación arranca de verdad.
- [Solución: conflicto de AndroidX durante una compilación Android de Flutter](/es/2026/05/fix-androidx-conflict-during-flutter-android-build/) -- un fallo de Android a nivel de dependencias en vez de a nivel de SDK.
- [Cómo apuntar a varias versiones de Flutter desde un solo pipeline de CI](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) -- donde fijar la versión del SDK deja de ser opcional.
- [Solución: Version solving failed en pubspec.yaml](/es/2026/05/fix-version-solving-failed-in-pubspec-yaml/) -- el equivalente del lado de Dart a un entorno roto, con un diagnóstico muy distinto.
- [Solución: Gradle build failed to produce an .apk file en MAUI Android](/es/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/) -- la misma plomería del Android SDK vista desde el lado de .NET.

## Fuentes

- [Troubleshooting installation](https://docs.flutter.dev/install/troubleshoot), documentación de Flutter, que muestra el camino del SDK Manager para exactamente esta salida del doctor.
- [sdkmanager](https://developer.android.com/tools/sdkmanager), documentación de Android Studio, para el layout `cmdline-tools/latest` requerido y las banderas `--install`, `--list_installed`, `--sdk_root` y `--channel`.
- [Android SDK Command-Line Tools release notes](https://developer.android.com/tools/releases/cmdline-tools).
- `packages/flutter_tools/lib/src/android/android_workflow.dart` y `android_sdk.dart` en la rama stable de [flutter/flutter](https://github.com/flutter/flutter), para el texto del validador y el orden de resolución del SDK.
- [flutter/flutter#139288](https://github.com/flutter/flutter/issues/139288), donde quien reportó había apuntado una ruta de configuración de Flutter a `cmdline-tools/latest/bin` en lugar de a la raíz del SDK.
- [flutter/flutter#167413](https://github.com/flutter/flutter/issues/167413), un reporte todavía abierto de que el doctor no detecta un SDK correctamente estructurado en Debian 12 con `ANDROID_SDK_ROOT` definida y `ANDROID_HOME` vacía.
- [android-actions/setup-android](https://github.com/android-actions/setup-android), para el enfoque de CI.
