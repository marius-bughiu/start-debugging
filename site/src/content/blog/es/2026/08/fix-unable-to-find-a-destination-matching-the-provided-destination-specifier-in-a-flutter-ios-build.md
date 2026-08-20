---
title: "Solución: Unable to find a destination matching the provided destination specifier en una compilación iOS de Flutter"
description: "Los runtimes del simulador de iOS 26 son solo arm64, así que una línea EXCLUDED_ARCHS arm64 olvidada compila un Runner solo Intel que ningún simulador puede ejecutar."
pubDate: 2026-08-20
template: error-page
tags:
  - "errors"
  - "flutter"
  - "ios"
  - "xcode"
  - "cocoapods"
lang: "es"
translationOf: "2026/08/fix-unable-to-find-a-destination-matching-the-provided-destination-specifier-in-a-flutter-ios-build"
translatedBy: "claude"
translationDate: 2026-08-20
---

Borra la línea `EXCLUDED_ARCHS[sdk=iphonesimulator*] = arm64` de tu `ios/Podfile` y luego ejecuta `flutter clean` seguido de un `pod install` limpio. Esa línea es un resto de la era Apple Silicon de 2020, y en Xcode 26 es fatal: los runtimes del simulador de iOS 26 vienen solo con arm64, así que excluir arm64 deja a `Runner` sin ninguna arquitectura que el simulador pueda ejecutar, y `xcodebuild` lo reporta como un destino faltante en vez de como una incompatibilidad de arquitectura. Si la exclusión viene de un plugin que no controlas, instala el runtime universal con `xcodebuild -downloadPlatform iOS -architectureVariant universal`.

## El error, completo

Flutter muestra el fallo crudo de `xcodebuild`, que nombra el UDID de tu simulador y luego lista destinos que parecen perfectamente válidos:

```
Uncategorized (Xcode): Unable to find a destination matching the provided destination specifier:
                { id:6B4F9D28-C76C-4146-9527-E844395B4434 }

        Available destinations for the "Runner" scheme:
                { platform:macOS, arch:arm64, variant:Designed for [iPad,iPhone], id:00006020-000221002EE8C01E, name:My Mac }
                { platform:iOS, id:dvtdevice-DVTiPhonePlaceholder-iphoneos:placeholder, name:Any iOS Device }
                { platform:iOS Simulator, id:dvtdevice-DVTiOSDeviceSimulatorPlaceholder-iphonesimulator:placeholder, name:Any iOS Simulator Device }
```

Ejecutar el mismo esquema desde la interfaz de Xcode da el diagnóstico que la salida de Flutter entierra:

```
iPhone 17 cannot run Runner.
Domain: IDEFoundationErrorDomain
Code: 3
Recovery Suggestion: Runner's architectures (Intel 64-bit) include none that iPhone 17 can execute (arm64).
```

Ese segundo mensaje es el error real. El simulador existe, está arrancado y su UDID es correcto. Lo que falta es una arquitectura en común entre el producto que acabas de compilar y el dispositivo en el que pediste ejecutarlo.

## Por qué un simulador de iOS 26 no tiene ningún destino compatible

`xcodebuild -destination` no resuelve a "un dispositivo con este UDID". Resuelve a "un dispositivo con este UDID que pueda ejecutar el producto de este esquema". La arquitectura forma parte de la coincidencia, así que una incompatibilidad de arquitectura aparece como un destino faltante.

Antes de iOS 26 esa distinción rara vez importaba. Los runtimes del simulador venían como binarios universales que contenían tanto la porción `x86_64` como la `arm64`, así que una compilación solo Intel todavía encontraba una porción que ejecutar bajo Rosetta en Apple Silicon. Xcode 26 acabó con eso. Cuando instalas un runtime, Apple resuelve la variante de arquitectura a `arm64` en Apple Silicon y descarga solo esa porción, imprimiendo `Automatically resolved architecture variant for platform iOS as 'arm64'` por el camino.

Entonces un simulador de iOS 26 puede ejecutar exactamente una arquitectura, y cualquier ajuste de compilación que quite `arm64` de la compilación para simulador produce un producto sin ninguna porción utilizable.

Ese ajuste casi siempre viene de un Podfile. En 2020, todas las guías de soluciones para Apple Silicon te decían que agregaras una exclusión de arm64 para que los pods solo Intel enlazaran, y ese consejo se copió a miles de proyectos. El propio ayudante de CocoaPods de Flutter lo preserva: `packages/flutter_tools/bin/podhelper.rb` escribe la exclusión del simulador con `$(inherited)` delante, lo que conserva tu valor a nivel de proyecto en vez de reemplazarlo.

```ruby
# Flutter 3.44.2, packages/flutter_tools/bin/podhelper.rb
build_configuration.build_settings['VALID_ARCHS[sdk=iphonesimulator*]'] = '$(ARCHS_STANDARD)'
build_configuration.build_settings['EXCLUDED_ARCHS[sdk=iphonesimulator*]'] = '$(inherited) i386'
build_configuration.build_settings['EXCLUDED_ARCHS[sdk=iphoneos*]'] = '$(inherited) armv7'
```

La exclusión de fábrica es solo `i386`, que es inofensiva. Lo que mata la compilación es el `arm64` heredado.

Hay una segunda fuente. Si algún target de pod excluye `arm64`, Flutter propaga la exclusión a la propia app. `packages/flutter_tools/lib/src/ios/xcode_build_settings.dart` lo decide mientras genera `Generated.xcconfig`:

```dart
// Flutter 3.44.2, packages/flutter_tools/lib/src/ios/xcode_build_settings.dart
var excludedSimulatorArchs = 'i386';
if (!(await project.ios.pluginsSupportArmSimulator(printWarnings: printWarnings))) {
  excludedSimulatorArchs += ' arm64';
}
xcodeBuildSettings.add(
  'EXCLUDED_ARCHS[sdk=${XcodeSdk.IPhoneSimulator.platformName}*]=$excludedSimulatorArchs',
);
```

`pluginsSupportArmSimulator` ejecuta `xcodebuild -showBuildSettings` sobre `Pods/Pods.xcodeproj` y devuelve false si el `EXCLUDED_ARCHS` de algún target menciona `arm64`. Basta con una dependencia transitiva mal configurada para dejar toda la app solo Intel.

## Reproducción mínima: la línea del Podfile que rompe la compilación para simulador

Agrega la solución clásica a una app Flutter de fábrica y ejecútala en un simulador de iOS 26:

```ruby
# ios/Podfile, Flutter 3.44.2, CocoaPods 1.16.2, Xcode 26.0.1
post_install do |installer|
  installer.pods_project.build_configurations.each do |config|
    config.build_settings['EXCLUDED_ARCHS[sdk=iphonesimulator*]'] = 'arm64'
  end
end
```

```bash
# Flutter 3.44.2 (stable, 11 June 2026), Dart 3.12.2
flutter run -d 6B4F9D28-C76C-4146-9527-E844395B4434
```

Flutter construye el argumento `-destination` a partir del dispositivo que seleccionaste, en `packages/flutter_tools/lib/src/ios/mac.dart`:

```dart
// Flutter 3.44.2, packages/flutter_tools/lib/src/ios/mac.dart
buildCommands.add('-destination');
if (deviceID != null) {
  buildCommands.add('id=$deviceID');
} else if (environmentType == EnvironmentType.physical) {
  buildCommands.add(XcodeSdk.IPhoneOS.genericPlatform);
} else {
  buildCommands.add(XcodeSdk.IPhoneSimulator.genericPlatform);
}
```

`genericPlatform` se expande a `generic/platform=iOS Simulator`. Cualquiera de las dos formas falla igual una vez que el producto es solo Intel, y por eso `flutter build ios --simulator` lo reproduce sin ningún dispositivo seleccionado.

## ¿Cómo elimino la exclusión de arm64?

Trabaja hacia afuera, desde tu propio proyecto hacia tus dependencias.

Primero, borra la exclusión de `ios/Podfile`. Quita toda la asignación de `EXCLUDED_ARCHS[sdk=iphonesimulator*]` en vez de dejarla como cadena vacía, para que el valor `i386` por defecto de Flutter se aplique limpio.

Segundo, revisa el propio proyecto de Xcode, porque la misma línea suele pegarse en los ajustes de compilación en lugar del Podfile:

```bash
# Xcode 26.0.1
cd ios
xcodebuild -showBuildSettings -project Runner.xcodeproj -scheme Runner \
  -sdk iphonesimulator | grep -i EXCLUDED_ARCHS
```

Cualquier cosa que mencione `arm64` en el SDK del simulador tiene que irse. Límpialo en Xcode bajo Build Settings, Excluded Architectures, tanto para Debug como para Release.

Tercero, reconstruye los pods desde cero. Un `Pods` y un `DerivedData` obsoletos mantienen vivos los ajustes viejos y hacen parecer que la solución no sirvió:

```bash
# Flutter 3.44.2, CocoaPods 1.16.2
flutter clean
rm -rf ios/Pods ios/Podfile.lock ~/Library/Developer/Xcode/DerivedData
flutter pub get
cd ios && pod install
```

Cuarto, confirma que la exclusión desapareció del archivo que genera Flutter. `ios/Flutter/Generated.xcconfig` debería mostrar `EXCLUDED_ARCHS[sdk=iphonesimulator*]=i386` sin `arm64`. Si `arm64` sobrevive a un `pod install` limpio, la fuente es una dependencia, no tú.

## ¿Qué pasa si un plugin sigue excluyendo arm64?

En Xcode 26 y posteriores, Flutter 3.41.0 (11 de febrero de 2026) y superiores nombran los targets culpables durante la compilación, desde `packages/flutter_tools/lib/src/xcode_project.dart`:

```
The following target(s) do not support arm64 architecture, which is a requirement for Apple Silicon iOS 26+ simulators:
  - SomePlugin (Flutter plugin)
  - SomeVendorSDK (transitive dependency of Flutter plugin SomePlugin)

Please contact plugin maintainers to request arm64 support to continue to be able to use the plugin on a simulator.
```

Ese aviso llegó en el [PR #177065](https://github.com/flutter/flutter/pull/177065), fusionado el 5 de noviembre de 2025. Comparar el commit de fusión con las etiquetas de versión lo deja fuera de 3.38.10 y dentro de 3.41.0, así que quien siga en la línea 3.38 recibe el fallo sin ninguna explicación.

Si el target es un framework binario de un proveedor sin porción arm64 para simulador, no puedes quitar la exclusión. Instala un runtime universal en su lugar, para que un producto solo Intel siga teniendo algo donde ejecutarse:

```bash
# Xcode 26.0.1
xcrun simctl delete unavailable
xcodebuild -downloadPlatform iOS -architectureVariant universal
```

Borra primero el runtime de iOS 26 solo arm64 que ya tienes, desde el panel Settings, Components de Xcode. Si no, la descarga resuelve al runtime que ya está instalado y termina sin traer la variante universal. Verifica después:

```bash
# Xcode 26.0.1
xcrun simctl list runtimes --json | grep -i x86_64
```

Esta es la solución que el propio Flutter recomienda. Desde 3.41.4 (4 de marzo de 2026), la herramienta imprime la sugerencia tras una compilación fallida para simulador, condicionada a Xcode 26 o posterior y a que al runtime seleccionado realmente le falte la porción `x86_64`:

```
The selected simulator is incompatible with the current build settings.
Please use a simulator that supports x86_64, such as a simulator prior to iOS 26 or download the universal variant of the iOS 26 simulator using "xcodebuild -downloadPlatform iOS -architectureVariant universal".
```

Trátalo como un parche temporal. Un runtime universal es una descarga más grande, ejecuta tu app bajo Rosetta y no hace nada por el siguiente compañero de equipo que instale el runtime de la forma predeterminada. Quitar la exclusión es la solución duradera.

## ¿Qué pasa si el error dice que la plataforma no está instalada?

Otro modo de fallo imprime el mismo encabezado con un bloque `Ineligible destinations` debajo:

```
Unable to find a destination matching the provided destination specifier:
                { id:1234D567-890C-1DA2-34E5-F6789A0123C4 }

        Ineligible destinations for the "Runner" scheme:
                { platform:iOS, id:dvtdevice-DVTiPhonePlaceholder-iphoneos:placeholder, name:Any iOS Device, error:iOS 17.0 is not installed. To use with Xcode, first download and install the platform }
```

Esto no es un problema de arquitectura. Tu deployment target o tu esquema hacen referencia a un runtime que no está en la máquina, algo común justo después de actualizar Xcode, porque Xcode 26 no arrastra los runtimes antiguos. Flutter extrae la frase `is not installed` de ese mensaje e imprime instrucciones de instalación que apuntan al panel Components de Xcode. Instala el runtime que falta, o sube el deployment target a uno que sí tengas.

## ¿Qué pasa si el destino es un UDID de simulador obsoleto?

Si el UDID del error ya no existe, `xcodebuild` agrega una línea distinta:

```
The requested device could not be found because no available devices matched the request.
```

Flutter excluye explícitamente este caso de su diagnóstico de arquitectura, así que esa frase significa que estás persiguiendo un dispositivo fantasma, no una incompatibilidad de arquitectura. Suele ocurrir tras una actualización de iOS o Xcode que regeneró el conjunto de simuladores mientras una configuración del IDE, un `launch.json` o un alias del shell seguían fijando el identificador viejo:

```bash
# Xcode 26.0.1, Flutter 3.44.2
xcrun simctl list devices available
xcrun simctl delete unavailable
flutter devices
```

Después pasa un UDID que `flutter devices` reporte de verdad, o quita `-d` y deja que Flutter elija.

## ¿Qué rompe esto en CI cuando funciona localmente?

En un servidor de compilación, el mismo mensaje suele significar que la plataforma iOS no está instalada en absoluto. En el [issue #163011](https://github.com/flutter/flutter/issues/163011) la lista de destinos contenía solo entradas de macOS, que es como se ve una imagen macOS con un conjunto incompleto de componentes de Xcode. `flutter build ipa` pasa `generic/platform=iOS`, y sin plataforma iOS presente no hay nada con qué coincidir.

Revisa la imagen antes de culpar al proyecto:

```bash
# Xcode 26.0.1 on a CI runner
xcodebuild -showsdks
xcrun simctl list runtimes
```

Si falta iOS, agrega `xcodebuild -downloadPlatform iOS` como paso previo a la compilación, y fija la versión de Xcode para que un refresco de la imagen no cambie la respuesta en silencio. Es la misma disciplina que mantiene predecible [un pipeline de CI que compila contra varias versiones de Flutter](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).

## Trampas y variantes parecidas

`ONLY_ACTIVE_ARCH` no es un sustituto. Flutter ya pasa `ONLY_ACTIVE_ARCH` y `ARCHS` explícitamente cuando conoce la arquitectura activa, y ponerlo a mano no devuelve una porción que `EXCLUDED_ARCHS` eliminó.

Vigila también la forma heredada `VALID_ARCHS[sdk=iphonesimulator*] = x86_64`. Es anterior a `EXCLUDED_ARCHS` y produce un producto solo Intel idéntico. El podhelper de Flutter lo restablece a `$(ARCHS_STANDARD)` para los targets de pods, pero no para el target de tu app.

Una compilación para dispositivo físico que falla con la misma cadena es otro problema. Ahí el destino es `generic/platform=iOS`, y la causa habitual es la firma de código, más cercana a [un perfil de aprovisionamiento que no incluye el dispositivo seleccionado](/es/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/).

Por último, si la compilación pasa la comprobación de destino y luego muere al arrancar, estás en otro terreno. Una compilación debug que arranca y se cae de inmediato en la Dart VM es [el fallo de mprotect permission denied](/es/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/), y una que nunca enlaza es más probablemente [un conflicto de resolución de versiones en CocoaPods](/es/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/).

## Qué versión de Flutter reporta la causa real

La incompatibilidad de fondo es de Apple, así que actualizar Flutter no hace que un producto solo Intel corra en un runtime solo arm64. Lo que compras al actualizar es un diagnóstico en vez de un acertijo. Flutter 3.41.0 agrega el aviso que nombra cada target que excluye arm64, y 3.41.4 agrega la pista posterior al fallo sobre el runtime universal. Ambos están en la versión stable actual, 3.47.1, publicada el 19 de agosto de 2026.

Si estás en 3.38 o anterior y no puedes actualizar, ejecuta a mano el grep de `-showBuildSettings` de más arriba. Es exactamente la comprobación que Flutter ahora hace por ti. Para un barrido más amplio de fallos de compilación iOS tras actualizar Xcode, sigue valiendo el orden de triaje de [la guía del fallo de compilación con Xcode 16](/es/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/).

## Relacionado

- [Solución: mprotect failed: 13 (Permission denied) en una compilación debug de Flutter para iOS](/es/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/)
- [Solución: CocoaPods could not find compatible versions for pod en una compilación iOS de Flutter](/es/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/)
- [Solución: Failed to build iOS app con Xcode 16 y Flutter 3.x](/es/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/)
- [Flutter 3.44 hace de Swift Package Manager el valor predeterminado](/es/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/)
- [Cómo apuntar a varias versiones de Flutter desde un solo pipeline de CI](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)

## Fuentes

- [flutter/flutter issue #176188, flutter run no funciona en el simulador de iOS 26](https://github.com/flutter/flutter/issues/176188)
- [flutter/flutter PR #177065, se elimina la exclusión de arm64 para soportar simuladores de Xcode 26](https://github.com/flutter/flutter/pull/177065)
- [flutter/flutter issue #163011, fallo de destination specifier con una plataforma iOS genérica](https://github.com/flutter/flutter/issues/163011)
- [Foros de Apple Developer, instalación de runtimes del simulador de iOS 26 y variantes de arquitectura](https://developer.apple.com/forums/thread/801106)
- [Apple, descarga e instalación de componentes adicionales de Xcode](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components)
- [Apple, instalación de runtimes adicionales del simulador](https://developer.apple.com/documentation/xcode/installing-additional-simulator-runtimes)
