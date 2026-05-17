---
title: "Solución: Failed to build iOS app con Xcode 16 y Flutter 3.x"
description: "La solución en 60 segundos: actualiza Flutter a 3.24.4 o posterior, sube la plataforma del Podfile a iOS 13, borra Pods y DerivedData, luego pod install. El error casi nunca está en tu código Dart."
pubDate: 2026-05-17
tags:
  - "errors"
  - "flutter"
  - "ios"
  - "xcode"
  - "cocoapods"
lang: "es"
translationOf: "2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x"
translatedBy: "claude"
translationDate: 2026-05-17
---

La solución en una frase: `Failed to build iOS app` tras actualizar a Xcode 16 casi nunca es tu código Dart. Es una de cuatro causas, en este orden de frecuencia: un SDK de Flutter anterior a 3.24.4 que no conoce el nuevo verificador de módulos de Xcode 16, un `Podfile` que aún fija `platform :ios, '11.0'` (Xcode 16 dejó de soportar el simulador de iOS 11), una caché obsoleta de `ios/Pods` y `~/Library/Developer/Xcode/DerivedData/ModuleCache.noindex` del Xcode anterior, o un plugin que aún no ha publicado una versión compatible con Swift 6 / Xcode 16. Actualiza Flutter, sube el Podfile a iOS 13, borra ambas cachés, ejecuta `pod install`, recompila. Deja de recurrir a `flutter clean` como primer paso; no toca las cachés de iOS que están realmente rotas.

```text
Launching lib/main.dart on iPhone 16 Pro in debug mode...
Running Xcode build...
Xcode build done.                                           38.4s
Failed to build iOS app
Error (Xcode): Swift Compiler Error (Xcode): No such module 'Flutter'
/Users/me/MyApp/ios/Runner/AppDelegate.swift:2:8

Could not build the application for the simulator.
Error launching application on iPhone 16 Pro.
```

Esta guía está escrita contra Flutter 3.41.5 (canal stable, mayo de 2026), la línea Xcode 16.x (16.0 a 16.4 al momento de escribir), CocoaPods 1.16.2 y macOS Sequoia 15.3 en Apple Silicon. Las mismas soluciones aplican a Flutter 3.24.4 y posteriores; si estás en Flutter 3.19 o anterior, mira primero el paso de actualización porque ninguna cantidad de retoques en los pods te salvará en esa rama. Los cambios relevantes de Flutter que hicieron que Xcode 16 funcionara limpiamente llegaron en [flutter/flutter#155438](https://github.com/flutter/flutter/issues/155438) y los arreglos posteriores de modulemap en [flutter/flutter#157461](https://github.com/flutter/flutter/issues/157461).

## Qué te dice realmente `Failed to build iOS app`

`Failed to build iOS app` es el mensaje paraguas de la herramienta de Flutter. Solo significa "xcodebuild devolvió un código de salida distinto de cero". El diagnóstico real es la línea justo encima o debajo, prefijada con `Error (Xcode):`. Hay aproximadamente seis errores subyacentes distintos que afloran todos bajo el mismo paraguas:

1. `No such module 'Flutter'` -- el compilador de Swift no encuentra el módulo del framework Flutter. Casi siempre un problema de Podfile o de pod install tras la actualización a Xcode 16.
2. `no such file or directory: '.../ModuleCache.noindex/Session.modulevalidation'` -- el nuevo verificador de módulos de Xcode 16 no puede leer un archivo de caché escrito por Xcode 15. Ver [issue #157461](https://github.com/flutter/flutter/issues/157461).
3. `Using bridging headers with module interfaces is unsupported` -- un patrón de `module.modulemap` más bridging header de un plugin que funcionaba en Xcode 15 ahora es un error duro.
4. `type 'UIApplication' does not conform to protocol 'Launcher'` -- un error de conformidad estricta de Swift 6 en un plugin desactualizado (habitualmente `url_launcher_ios` antes de 6.3.0).
5. `Undefined symbol: _swift_FORCE_LOAD$_swiftCompatibility56` -- desajuste de ABI del runtime de Swift, casi siempre una caché de CocoaPods de un SDK de Xcode anterior.
6. `The iOS deployment target 'IPHONEOS_DEPLOYMENT_TARGET' is set to 11.0, but the range of supported deployment target versions is 12.0 to 18.4` -- tu `Podfile` aún fija iOS 11, que Xcode 16 eliminó.

Cada uno es un bug diferente con una causa raíz diferente. La primera tarea es identificar cuál de ellos golpeó realmente la herramienta. Desplázate hacia arriba en la terminal hasta encontrar la línea `error:` que tiene una ruta de archivo y un número de línea. Esa es la verdad; `Failed to build iOS app` es el síntoma.

## Leer el error real desde `flutter build`

Ejecuta con logging detallado para que la salida subyacente de `xcodebuild` no se resuma:

```bash
# Flutter 3.41.5
flutter build ios --verbose 2>&1 | tee build.log
```

Luego busca en el log el primer `error:` (en minúscula, ese es el prefijo de Xcode), no `Error (Xcode)` (que es el reformateo de Flutter):

```bash
grep -n "error:" build.log | head -20
```

La primera coincidencia es la que hay que arreglar. Los errores siguientes suelen ser cascadas del primero. Si no tienes la salida verbosa, estás adivinando.

## Una reproducción mínima que demuestra una de las formas comunes

La forma más común en 2026 es la combinación del pin de plataforma del `Podfile` con un directorio `Pods` obsoleto. Crea un proyecto Flutter nuevo y fija el deployment target de iOS a 11.0:

```ruby
# ios/Podfile, Flutter 3.41.5, CocoaPods 1.16.2
platform :ios, '11.0'

# CocoaPods analytics sends network stats synchronously affecting flutter build latency.
ENV['COCOAPODS_DISABLE_STATS'] = 'true'

project 'Runner', {
  'Debug' => :debug,
  'Profile' => :release,
  'Release' => :release,
}

# ... rest of the default Podfile ...
```

Ejecuta `flutter build ios --no-codesign` bajo Xcode 16 y la compilación falla con:

```text
[!] Automatically assigning platform `iOS` with version `11.0` on target `Runner`
    because no platform was specified. Please specify a platform for this target
    in your Podfile.
...
error: The iOS deployment target 'IPHONEOS_DEPLOYMENT_TARGET' is set to 11.0,
       but the range of supported deployment target versions is 12.0 to 18.4.
       (in target 'firebase_core' from project 'Pods')
Failed to build iOS app
```

El mismo Podfile bajo Xcode 15.4 compila sin quejarse. El bug es el nuevo piso de deployment target en Xcode 16, no tu código.

## Solución, en orden de cuán a menudo es la respuesta

Aplica estos pasos en orden. Cada paso asume que el anterior no funcionó.

### 1. Actualiza Flutter a 3.24.4 o posterior

Flutter 3.24.4 (octubre de 2024) es la primera versión stable que incluye los arreglos para Xcode 16 en `xcode_backend.sh` y la plantilla de Generated.xcconfig. Cualquier versión de la línea 3.41.x en 2026 está al día. Verifica qué tienes y actualiza:

```bash
flutter --version
flutter upgrade
```

Si `flutter upgrade` se niega porque tu canal está en `master` o tienes modificaciones locales del motor, vuelve a `stable`:

```bash
flutter channel stable
flutter upgrade
```

Este único paso resuelve la mayoría de los reportes de `No such module 'Flutter'` presentados contra Xcode 16 en 2024 y 2025. El equipo de Flutter cerró el [issue #155438](https://github.com/flutter/flutter/issues/155438) como arreglado en 3.24.4 exactamente por esta razón.

### 2. Sube la plataforma del Podfile a iOS 13

Xcode 16 aún soporta iOS 12 como deployment target, pero la mayoría de los plugins modernos (Firebase, Google Maps, cualquier cosa que toque SwiftUI) ahora requieren iOS 13. Establecer iOS 13 como piso es la opción segura por defecto en 2026:

```ruby
# ios/Podfile, Flutter 3.41.5
platform :ios, '13.0'
```

También necesitas reflejar esto en el proyecto del runner. Abre `ios/Runner.xcworkspace`, selecciona el target `Runner`, ve a `Build Settings` y establece `iOS Deployment Target` en `13.0` para debug y release. Las build settings del workspace ganan sobre el `Podfile` para el target Runner; la línea del `Podfile` solo afecta a los targets de los pods.

Si tienes un bloque `post_install` en el Podfile, fuerza a cada pod a heredar el mismo mínimo (este es el snippet de la plantilla moderna de Flutter):

```ruby
post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_ios_build_settings(target)
    target.build_configurations.each do |config|
      config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '13.0'
    end
  end
end
```

### 3. Borra Pods, el lockfile y la caché de módulos

Este es el paso que arregla el error de `ModuleCache.noindex` y la mayoría de los reportes de `Undefined symbol: _swift_FORCE_LOAD$_swiftCompatibility56`. La caché de ABI de Swift de tu Xcode anterior es incompatible con el `swiftc` de Xcode 16, y `flutter clean` no la toca. Desde la raíz del proyecto:

```bash
# Flutter 3.41.5, CocoaPods 1.16.2
flutter clean
cd ios
rm -rf Pods Podfile.lock .symlinks
rm -rf ~/Library/Developer/Xcode/DerivedData
pod cache clean --all
pod install --repo-update
cd ..
flutter pub get
```

`pod install --repo-update` (ojo: no `pod install` solo) refresca el repositorio de specs de CocoaPods para que recojas cualquier podspec de plugin publicado desde tu última compilación. Sáltatelo e instalarás el `firebase_core.podspec` de ayer que aún fija iOS 11.

### 4. Actualiza los plugins, especialmente los que aparecen en el error

Si el error es `type 'UIApplication' does not conform to protocol 'Launcher'`, el plugin está desactualizado. Los dos infractores más comunes son `url_launcher_ios` y `webview_flutter_wkwebview`. Sube a la última versión menor:

```bash
flutter pub upgrade --major-versions
```

Si no puedes hacer una actualización global porque alguna dependencia te ancla, actualiza solo el plugin nombrado en el error:

```bash
flutter pub upgrade --major-versions url_launcher_ios
```

Luego repite el paso 3 (los pods se cachean por versión; un cambio en `pubspec.yaml` no vuelve a ejecutar `pod install` automáticamente). Para una guía más profunda sobre cómo leer las quejas del resolutor de `pubspec` si `pub upgrade` falla, ver [por qué "Version solving failed" es una prueba y no un bug](/es/2026/05/fix-version-solving-failed-in-pubspec-yaml/).

### 5. Fuerza una sola versión de Swift en todos los pods

Un subconjunto de fallos de compilación viene de pods que no declararon un `SWIFT_VERSION`, lo que bajo Xcode 16 por defecto usa el modo estricto de Swift 6 y luego explota sobre código Swift 5 perfectamente legal. La solución es fijar cada pod a Swift 5 en el mismo bloque `post_install`:

```ruby
post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_ios_build_settings(target)
    target.build_configurations.each do |config|
      config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '13.0'
      config.build_settings['SWIFT_VERSION'] = '5.0'
    end
  end
end
```

Esto es un workaround, no una solución. La solución correcta a largo plazo es abrir un issue contra el plugin para que declare su propia versión de Swift, pero la fijación te desbloqueará hoy.

### 6. Borra y regenera la configuración de `ios/Runner.xcodeproj` solo como último recurso

Si has editado a mano el `project.pbxproj` (agregaste targets nativos, fases de compilación personalizadas, extensiones App Clip) y nada de lo anterior funcionó, el target Runner puede tener build settings obsoletas anteriores a Xcode 16. Haz una copia de seguridad de `ios/Runner.xcodeproj` y luego compáralo con uno recién generado:

```bash
# Flutter 3.41.5
flutter create --platforms=ios --project-name=runner /tmp/scratch
diff -r ios/Runner.xcodeproj /tmp/scratch/ios/Runner.xcodeproj
```

Lleva las build settings relevantes (`IPHONEOS_DEPLOYMENT_TARGET`, `SWIFT_VERSION`, `ENABLE_USER_SCRIPT_SANDBOXING`, `STRING_CATALOG_GENERATE_SYMBOLS`) del proyecto scratch al tuyo, una a una, recompilando entre cada cambio. Es tedioso pero también es la única forma fiable de recuperar un proyecto que ha acumulado cinco años de detritus de actualizaciones de Xcode.

## Trampas y casos parecidos

Algunos casos que se parecen a este error pero no lo son:

- **`Sandbox: rsync deny file-write-create`**: Xcode 16 activó `ENABLE_USER_SCRIPT_SANDBOXING=YES` por defecto en proyectos nuevos. El `xcode_backend.sh` de Flutter escribe fuera del sandbox. Establece `ENABLE_USER_SCRIPT_SANDBOXING=NO` en las Build Settings del target Runner. La plantilla del instalador de Flutter desde 3.24.4 ya lo establece, pero los proyectos creados antes no.
- **`Provisioning profile doesn't include the currently selected device`**: no es un fallo de compilación de Flutter para nada. El binario nativo compiló bien; falló el paso de instalación. Ver [Provisioning profile doesn't include the currently selected device](/es/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/) -- el artículo de MAUI cubre la misma causa raíz del lado de Apple.
- **`Unable to find a valid iOS Simulator runtime`**: Xcode 15 dejó de empaquetar los runtimes del Simulador; Xcode 16 sigue sin empaquetarlos. Ejecuta `xcodebuild -downloadPlatform iOS`. El artículo detallado está en [Unable to find a valid iOS Simulator runtime during MAUI build](/es/2026/05/fix-unable-to-find-a-valid-ios-simulator-runtime-during-maui-build/) y aplica idénticamente a Flutter.
- **`Xcode 26 update -- Clang dependency scanning failure: module 'Flutter' not found`**: esta es la variante de Xcode 26 (vista previa para desarrolladores) rastreada en [flutter/flutter#185210](https://github.com/flutter/flutter/issues/185210). No envíes builds de release contra Xcode 26 todavía; quédate en la línea 16.x hasta que Flutter publique una nota de compatibilidad.
- **CI falla pero las compilaciones locales pasan**: tu CI está en una imagen de Xcode anterior. La imagen `macos-14` de GitHub Actions trae Xcode 15.4; necesitas `macos-15` (o explícitamente `macos-15-large`) para Xcode 16. Fija la imagen del runner y selecciona la versión de Xcode con `sudo xcode-select -s /Applications/Xcode_16.app`. Si también estás manejando múltiples versiones de Flutter en CI, el [patrón de matriz para Flutter en subosito/flutter-action](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) muestra cómo mantener el build verde en varias versiones.
- **`No such module 'Flutter'` solo en un target de watchOS o App Clip**: el framework de Flutter no se embebe en targets compañeros por defecto. Tienes que agregar una fase Run Script que copie `Flutter.framework` a los binarios embebidos, o usar la configuración del proyecto [add-to-app](https://docs.flutter.dev/add-to-app/ios/project-setup). Esto está documentado en [flutter/flutter#164597](https://github.com/flutter/flutter/issues/164597) para el caso del Apple Watch.
- **`flutter clean` borró el `ios/Flutter/Generated.xcconfig` y ahora nada compila**: es esperado. Ejecuta `flutter pub get` para regenerarlo. Si `flutter pub get` tiene éxito pero el archivo no se regenera, tu `pubspec.yaml` no declara iOS como plataforma; agrega `flutter:` `plugin:` `platforms:` `ios:` o ejecuta `flutter create --platforms=ios .`.

Si ya has iterado por los pasos 1 a 5 dos veces y sigues viendo el mismo error, el siguiente paso es bisectar plugins. Comenta cada dependencia directa en `pubspec.yaml` excepto `flutter` y `cupertino_icons`, ejecuta el ciclo de borrar y compilar, y confirma que el proyecto vacío compila. Luego descomenta dependencias en grupos de tres. El primer grupo que reintroduzca el fallo contiene el plugin culpable. Es lento pero determinista y te da un reporte de bug listo para abrir.

## Relacionados

- [Solución: Version solving failed en pubspec.yaml](/es/2026/05/fix-version-solving-failed-in-pubspec-yaml/)
- [Solución: Provisioning profile doesn't include the currently selected device (MAUI iOS)](/es/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/)
- [Solución: Unable to find a valid iOS Simulator runtime during MAUI build](/es/2026/05/fix-unable-to-find-a-valid-ios-simulator-runtime-during-maui-build/)
- [Cómo apuntar a varias versiones de Flutter desde un solo pipeline de CI](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)
- [Depurar Flutter iOS desde Windows: flujo de trabajo con dispositivo real](/es/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/)

## Fuentes

- [flutter/flutter#155438: After updating to xCode 16, Failed to build iOS app in Flutter 3.19.5](https://github.com/flutter/flutter/issues/155438)
- [flutter/flutter#157461: Xcode 16 and iOS 18 project not compiling: ModuleCache.noindex error](https://github.com/flutter/flutter/issues/157461)
- [flutter/flutter#155873: No such module 'Flutter' after updating to Xcode 16](https://github.com/flutter/flutter/issues/155873)
- [flutter/flutter#164597: Flutter 3.29.0 + Xcode 16 build failure with Apple Watch target](https://github.com/flutter/flutter/issues/164597)
- [flutter/flutter#185210: Xcode 26 update -- Clang dependency scanning failure](https://github.com/flutter/flutter/issues/185210)
- [Flutter add-to-app iOS project setup](https://docs.flutter.dev/add-to-app/ios/project-setup) (docs.flutter.dev)
- [CocoaPods 1.16.x changelog](https://github.com/CocoaPods/CocoaPods/releases) (CocoaPods/CocoaPods)
