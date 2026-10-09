---
title: "Migra una app iOS de Flutter de CocoaPods a Swift Package Manager (Flutter 3.44 a 3.47)"
description: "Flutter 3.44 convirtió Swift Package Manager en la opción predeterminada para iOS y macOS, pero una app existente conserva CocoaPods hasta que lo eliminas. Cómo comprobar qué plugins ya son compatibles con SwiftPM, dejar que la herramienta migre el proyecto de Xcode, borrar el Podfile sin riesgos, manejar plugins que solo usan pods y la lógica personalizada del Podfile, y revertir si lo necesitas."
pubDate: 2026-10-09
updatedDate: 2026-10-09
template: migration
tags:
  - "migration"
  - "flutter"
  - "ios"
  - "swiftpm"
  - "cocoapods"
  - "xcode"
lang: "es"
translationOf: "2026/10/migrate-a-flutter-ios-app-from-cocoapods-to-swift-package-manager"
translatedBy: "claude"
translationDate: 2026-10-09
---

Si tu app de Flutter se creó antes de Flutter 3.44, todavía tiene un `Podfile`, un directorio `Pods/` y líneas `#include` de CocoaPods en sus archivos xcconfig, aunque Swift Package Manager (SwiftPM) sea el valor predeterminado desde la 3.44. Actualizar Flutter solo hace la mitad de la migración. El primer `flutter build ios` o `flutter run` agrega el paquete SwiftPM a tu proyecto de Xcode, pero no elimina CocoaPods. Eso lo haces tú, y solo cuando todos los plugins que usas incluyan un `Package.swift`. Para una app típica con 5 a 15 plugins, toma unos 30 minutos. Lo que se rompe es un `Podfile` editado a mano (lógica `post_install` personalizada, macros del preprocesador, pods adicionales) y los plugins que todavía solo usan pods. Hazlo ahora: el trunk de CocoaPods pasa a solo lectura el 2 de diciembre de 2026. Todo lo siguiente se probó con Flutter 3.44.8, Xcode 27.0 y CocoaPods 1.17.0, y se contrastó con la versión estable actual, Flutter 3.47.6.

## Por qué eliminar CocoaPods en lugar de dejarlo

- **Se acaba Ruby en la máquina de compilación.** Cuando ya no queda ningún pod, `flutter build ios` deja de ejecutar `pod install`, así que el CI ya no necesita Ruby, la gema `cocoapods` ni el workaround de `LANG=en_US.UTF-8`.
- **Compilaciones más rápidas.** `flutter_tools` lo dice directamente: "Removing CocoaPods integration will improve the project's build time." Las fases de script `[CP] Embed Pods Frameworks` y `[CP] Copy Pods Resources` desaparecen de cada compilación.
- **El trunk de CocoaPods se congela.** Pasa a ser de solo lectura de forma permanente el 2 de diciembre de 2026. Los pods que ya existen se siguen resolviendo, pero después de esa fecha ningún plugin puede publicar un podspec corregido. Cualquier plugin que siga en CocoaPods es un plugin cuyo lado iOS está congelado.
- **Los plugins que solo usan pods están avisados.** Flutter 3.44+ imprime que un plugin que solo usa pods "will become an error in a future version of Flutter", y pub.dev ahora reduce la puntuación de los paquetes sin soporte de SwiftPM.

## Qué cambia en el proyecto

| Área | Cambio | Severidad |
| --- | --- | --- |
| `ios/Runner.xcodeproj/project.pbxproj` | `FlutterGeneratedPluginSwiftPackage` se agrega como dependencia de paquete local de `Runner` (automático) | baja |
| `Runner.xcscheme` | Se agrega la acción previa de compilación "Run Prepare Flutter Framework Script" (automático, por esquema) | baja |
| `ios/Podfile`, `Podfile.lock`, `Pods/`, `.symlinks/` | Los borras tú | media |
| `ios/Flutter/Debug.xcconfig`, `Release.xcconfig` | Las líneas `#include? "Pods/..."` las quitas tú | media |
| Lógica personalizada del `Podfile` | Los hooks `post_install`, `GCC_PREPROCESSOR_DEFINITIONS` y los pods que no son de Flutter deben moverse a otro lugar | alta |
| Plugins que solo usan pods | Obligan a CocoaPods a quedarse; el `Podfile` se regenera si lo borras | alta |
| Versión mínima de iOS | Los plugins de SwiftPM pueden declarar un mínimo más alto que el de tu target `Runner` | media |

## Lista de verificación previa

1. Flutter 3.44 o más reciente (`flutter --version`). SwiftPM era opcional desde la 3.24, pero la 3.44 es la versión donde la migración automática y las advertencias de abajo están activadas de forma predeterminada.
2. Xcode 15 o más reciente. `flutter_tools` rechaza SwiftPM en versiones anteriores de Xcode.
3. Un árbol de trabajo limpio, para que el diff de `project.pbxproj` y del esquema sea revisable y reversible.
4. SwiftPM no deshabilitado. Comprueba que `flutter config --list` no muestre `enable-swift-package-manager: false` y que `pubspec.yaml` no tenga `config: enable-swift-package-manager: false` bajo `flutter:`. Las versiones anteriores, cuando SwiftPM todavía era opcional, documentaban otra clave, `disable-swift-package-manager: true`, directamente bajo `flutter:`. Quítala si un compañero la agregó en aquel entonces.
5. Si compilas flavors, anota el nombre de cada esquema. La acción previa se agrega por esquema.

## Pasos de la migración

1. **Actualiza primero los plugins.** Muchos plugins agregaron `Package.swift` en una versión menor, y un lockfile antiguo te mantiene en la versión que solo usa pods. Ejecuta `flutter pub upgrade` y, para todo lo que esté fijado en `pubspec.yaml`, `flutter pub outdated`. Verifica con `git diff pubspec.lock` que las implementaciones iOS de los plugins (`*_ios`, `*_darwin`, `*_foundation`, `*_apple`) hayan avanzado.

2. **Lista qué plugins usan SwiftPM y cuáles no.** `flutter_tools` lo decide con una comprobación de archivos: un plugin es compatible con SwiftPM si existe `ios/<plugin_name>/Package.swift` en su paquete (o `darwin/<plugin_name>/Package.swift` para los plugins que comparten código de iOS y macOS). La herramienta lee las rutas de los plugins desde `.flutter-plugins-dependencies`, así que puedes ejecutar la misma comprobación tú mismo antes de tocar el proyecto de Xcode:

   ```bash
   #!/usr/bin/env bash
   # Flutter 3.44+, run from the app root after `flutter pub get`. Needs jq.
   jq -r '.plugins.ios[] | [.name, .path, (if .shared_darwin_source then "darwin" else "ios" end)] | @tsv' \
     .flutter-plugins-dependencies |
   while IFS=$'\t' read -r name path dir; do
     base="${path%/}/$dir"
     if [ -f "$base/$name/Package.swift" ]; then echo "swiftpm    $name"
     elif [ -f "$base/$name.podspec" ];     then echo "pods-only  $name"
     else                                       echo "dart-only  $name"
     fi
   done
   ```

   En una app de prueba con diez plugins comunes, esto fue lo que imprimió:

   ```text
   swiftpm    audioplayers_darwin
   swiftpm    device_info_plus
   swiftpm    flutter_contacts
   swiftpm    flutter_secure_storage_darwin
   pods-only  flutter_tts
   swiftpm    geolocator_apple
   swiftpm    image_gallery_saver_plus
   swiftpm    package_info_plus
   dart-only  path_provider_foundation
   swiftpm    vibration
   ```

   `dart-only` significa que el plugin no tiene código nativo de iOS en absoluto (`path_provider_foundation` 2.6.0 habla con Foundation mediante FFI), así que no interviene ningún administrador de dependencias. Cualquier línea `pods-only` significa que puedes migrar el proyecto de Xcode, pero todavía no puedes borrar CocoaPods. Salta a la sección "Los plugins que solo usan pods hacen volver el Podfile" más abajo.

3. **Deja que Flutter migre el proyecto de Xcode.** Ejecuta una compilación real, no una que solo genere la configuración:

   ```bash
   # Flutter 3.44.8, Xcode 27.0
   flutter build ios --simulator --debug
   ```

   En mi prueba, `flutter build ios --config-only` sí ejecutó `pod install` y regeneró el paquete SwiftPM bajo `ios/Flutter/ephemeral/Packages/`, pero no tocó `project.pbxproj` ni el esquema. La integración con el proyecto de Xcode ocurre justo antes de que se ejecute `xcodebuild`. Verifica:

   ```bash
   grep -c FlutterGeneratedPluginSwiftPackage ios/Runner.xcodeproj/project.pbxproj   # > 0
   grep "Run Prepare Flutter Framework Script" ios/Runner.xcodeproj/xcshareddata/xcschemes/*.xcscheme
   ```

   Si todos los plugins usan SwiftPM, la salida de la compilación ahora termina con una lista de verificación adaptada a tu proyecto:

   ```text
   All plugins found for ios are Swift Packages, but your project still has CocoaPods integration. To remove CocoaPods integration, complete the following steps:
     * In the ios/ directory run "pod deintegrate"
     * Also in the ios/ directory, delete the Podfile
     * Remove the include to "Pods/Target Support Files/Pods-Runner/Pods-Runner.debug.xcconfig" in your ios/Flutter/Debug.xcconfig
     * Remove the include to "Pods/Target Support Files/Pods-Runner/Pods-Runner.release.xcconfig" in your ios/Flutter/Release.xcconfig

   Removing CocoaPods integration will improve the project's build time.
   ```

   Si obtienes un mensaje distinto, "Your project uses a non-standard Podfile and will need to be migrated to Swift Package Manager manually", Flutter comparó tu `Podfile` byte por byte con su plantilla y encontró ediciones. Revisa la sección sobre el Podfile personalizado antes de continuar. Haz un commit en este punto: el proyecto ahora compila con ambos administradores, y este es tu ancla de reversión.

4. **Desintegra CocoaPods.**

   ```bash
   # CocoaPods 1.17.0
   cd ios
   pod deintegrate
   rm -rf Podfile Podfile.lock Pods .symlinks
   cd ..
   ```

   `pod deintegrate` elimina de `project.pbxproj` las fases de compilación `[CP]`, el enlace a `Pods_Runner.framework` y las referencias xcconfig de Pods. Verifica con `grep -c "\[CP\]" ios/Runner.xcodeproj/project.pbxproj`, que debería imprimir `0`.

5. **Quita los includes de Pods de los archivos xcconfig.** Ambos archivos empiezan con un include opcional que `pod deintegrate` no toca:

   ```text
   // ios/Flutter/Debug.xcconfig, before
   #include? "Pods/Target Support Files/Pods-Runner/Pods-Runner.debug.xcconfig"
   #include "Generated.xcconfig"

   // after
   #include "Generated.xcconfig"
   ```

   Haz lo mismo en `Release.xcconfig` y en cualquier xcconfig por flavor que hayas creado (`Debug-dev.xcconfig` y así). La forma `#include?` significa que un archivo faltante se ignora en silencio, así que dejarla no romperá la compilación. Pero `flutter_tools` busca esa línea y sigue imprimiendo la lista de verificación de eliminación mientras exista. Verifica con `grep -rn "Pods" ios/Flutter/*.xcconfig`, que no debería imprimir nada.

6. **Limpia la referencia del workspace.** `pod deintegrate` termina con "The workspace referencing the Pods project still remains." Abre `ios/Runner.xcworkspace/contents.xcworkspacedata` y borra el elemento `<FileRef location = "group:Pods/Pods.xcodeproj">`, para que Xcode deje de mostrar un proyecto faltante en rojo. Conserva `Runner.xcworkspace`; Flutter y Xcode todavía abren la app a través de él.

7. **Vuelve a compilar desde cero.**

   ```bash
   # Flutter 3.44.8 / 3.47.6
   flutter clean
   flutter pub get
   flutter build ios --simulator --debug
   ```

   Verifica dos cosas en la salida: que no haya una línea `Running pod install...` y que `ios/Podfile` no se haya vuelto a crear. Si el `Podfile` volvió, todavía hay un plugin que solo usa pods en el grafo.

8. **Actualiza el CI.** Quita `pod install`, `pod repo update`, la configuración de Ruby y los pasos de caché de CocoaPods. Almacena en caché `~/Library/Developer/Xcode/DerivedData/<project>/SourcePackages` o pasa `-clonedSourcePackagesDirPath` a `xcodebuild` si compilas directamente desde Xcode. Verifica ejecutando el pipeline en una imagen de runner sin la gema `cocoapods` instalada.

## Verificación

- `flutter build ios --release --no-codesign` termina bien y no imprime ninguna línea `pod install`.
- `flutter run` en un dispositivo real funciona, incluido el hot reload. Eso demuestra que la acción previa preparó `Flutter.framework` correctamente.
- En Xcode, cada esquema que publicas tiene la acción previa "Run Prepare Flutter Framework Script" en Edit Scheme, Build, Pre-actions. Los esquemas de flavor creados a mano son los que más a menudo no la tienen.
- Cada plugin con código nativo funciona en tiempo de ejecución: solicita un permiso, abre una URL, lee un valor del almacenamiento seguro. Un plugin que compiló pero perdió su configuración falla aquí, no en tiempo de compilación (consulta la sección sobre `permission_handler`).
- El archivo se genera: `flutter build ipa` termina bien y la subida pasa la validación de App Store Connect, que es el primer lugar donde saldría un recurso de plugin o un manifiesto de privacidad faltante.

## Cómo revertir

Esta migración es reversible. Si hiciste un commit después del paso 3, un `git revert` del commit de desintegración más `cd ios && pod install` restaura la configuración mixta. Para abandonar SwiftPM por completo, desactívalo para todo el proyecto en `pubspec.yaml`:

```yaml
# pubspec.yaml, Flutter 3.44+
flutter:
  config:
    enable-swift-package-manager: false
```

Luego quita `FlutterGeneratedPluginSwiftPackage` de Package Dependencies y de Frameworks, Libraries, and Embedded Content del target `Runner`, y borra la acción previa de cada esquema. Solo desactivarlo deja la integración de SwiftPM en el archivo del proyecto, y Flutter sigue generando un paquete vacío para ella. Trata la desactivación como algo temporal, porque el soporte de CocoaPods está en modo de mantenimiento y con el tiempo desaparecerá.

## Problemas encontrados en una migración real

### Los plugins que solo usan pods hacen volver el Podfile

Si aunque sea un plugin carece de `Package.swift`, Flutter funciona en modo mixto. Agregué `flutter_tts` 4.2.5 a una app totalmente migrada y sin `Podfile`, y la siguiente compilación imprimió:

```text
The following plugins do not support Swift Package Manager for ios:
  - flutter_tts
This will become an error in a future version of Flutter. Please contact the plugin maintainers to request Swift Package Manager adoption.
Running pod install...
```

Flutter regeneró `ios/Podfile` a partir de su plantilla y volvió a poner las líneas `#include?` en ambos archivos xcconfig. El modo mixto compila bien, así que no es una emergencia. Tus opciones son reemplazar el plugin, incorporar su código iOS a un paquete local con un `Package.swift`, o mantener la configuración mixta y revisar el plugin de nuevo más adelante. No borres el `Podfile` regenerado en bucle; seguirá volviendo mientras ese plugin esté en `pubspec.lock`.

### permission_handler ignora las macros de tu Podfile bajo SwiftPM

La configuración clásica de `permission_handler` pone `PERMISSION_CAMERA=1` y similares en `GCC_PREPROCESSOR_DEFINITIONS` dentro del bloque `post_install` del `Podfile`. Bajo SwiftPM ese bloque ya no se ejecuta. Desde `permission_handler_apple` 9.4.8, el manifiesto del paquete habilita un permiso cuando existe la clave `NS*UsageDescription` correspondiente en tu `Info.plist`. La 9.5.1 corrigió la detección para plists específicos de la configuración de compilación y del flavor, y la 9.6.0 agregó un `permission_handler.yaml` para permisos por flavor, así que asegúrate de que tu lockfile resuelva 9.6.x. Dos consecuencias: un permiso sin descripción de uso se excluye de la compilación y reporta `denied` en tiempo de ejecución en lugar de hacer fallar la compilación, y el manifiesto se guarda en caché, así que después de cambiar `Info.plist` necesitas ejecutar `rm -rf ~/Library/Developer/Xcode/DerivedData` una vez. Por eso importa la comprobación en tiempo de ejecución de la lista de verificación.

### Un Podfile personalizado hay que traducirlo, no borrarlo

Busca tres cosas en tu `Podfile` antes de borrarlo. Los pods que no son de Flutter (`pod 'GoogleMLKit/...'`, SDK de analítica) deben convertirse en dependencias de paquetes Swift agregadas mediante la pestaña Package Dependencies de Xcode en el proyecto `Runner`. Las sobrescrituras de build settings en `post_install` (`ENABLE_BITCODE`, `EXCLUDED_ARCHS`, deployment targets) solo afectaban a los targets de los pods, así que la mayoría puede simplemente desaparecer. Las macros del preprocesador que consumen los plugins necesitan el equivalente de SwiftPM del plugin, como con `permission_handler` arriba. Si te saltas esto, la compilación normalmente sigue funcionando y la funcionalidad desaparece en silencio.

### Versiones mínimas de iOS que no coinciden

Un plugin de SwiftPM puede declarar una plataforma más alta que tu app, lo que falla con "The package product 'plugin_name_ios' requires minimum platform version 14.0 for the iOS platform, but this target supports 12.0". Sube Minimum Deployments en el target `Runner` y ejecuta `flutter build ios --config-only` para regenerar la configuración. En Xcode 27 hay un segundo piso: rechaza cualquier deployment target de iOS por debajo de 15.0, y un proyecto creado con Flutter 3.44.8 todavía dice 13.0. Ese error afecta al proyecto `Runner` y, en modo mixto, a cada target de pod. Para los pods, agrega una sobrescritura al bloque `post_install` después de `flutter_additional_ios_build_settings(target)`:

```ruby
# ios/Podfile, Flutter 3.44.8 + Xcode 27.0, mixed mode only
target.build_configurations.each do |config|
  config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '15.0'
end
```

macOS tiene su propia versión de este problema, que se trata en [subir el deployment target mínimo de una app de Flutter para macOS a macOS 12 por Xcode 27](/es/2026/09/raise-a-flutter-macos-apps-minimum-deployment-target-to-macos-12-for-xcode-27/).

### Las viejas soluciones de StackOverflow dejan de aplicar

Fijar la versión de un pod en el `Podfile` para resolver un conflicto no hace nada cuando ese plugin se resuelve mediante SwiftPM, porque CocoaPods nunca lo ve. Si antes peleaste con [el error de CocoaPods "could not find compatible versions for pod"](/es/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/), borra esas fijaciones al migrar en lugar de arrastrarlas.

### Los módulos add-to-app son distintos

Un módulo de Flutter incrustado en una app nativa de iOS usa su propio `Podfile` de módulo, que `flutter_tools` deliberadamente no toca. Sigue la guía de configuración de proyectos add-to-app en lugar de los pasos anteriores.

## Relacionado

- La versión que cambió el valor predeterminado: [Flutter 3.44 convierte Swift Package Manager en la opción predeterminada](/es/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).
- Si el problema es Xcode en sí y no el administrador de dependencias, empieza por [failed to build an iOS app with Xcode 16 and Flutter 3.x](/es/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/).
- Para desplegar la migración en varias versiones de Flutter en el CI sin romper las ramas antiguas, consulta [apuntar a varias versiones de Flutter desde un solo pipeline de CI](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).

## Fuentes

- [Swift Package Manager for app developers](https://docs.flutter.dev/packages-and-plugins/swift-package-manager/for-app-developers) (docs.flutter.dev)
- [Swift Package Manager for plugin authors](https://docs.flutter.dev/packages-and-plugins/swift-package-manager/for-plugin-authors) (docs.flutter.dev)
- [Saying goodbye to CocoaPods](https://flutter.dev/blog/saying-goodbye-to-cocoapods-swift-package-manager-is-soon-the-default-in-flutter) (blog de flutter.dev)
- [`darwin_dependency_management.dart`](https://github.com/flutter/flutter/blob/master/packages/flutter_tools/lib/src/macos/darwin_dependency_management.dart), la fuente de las advertencias citadas arriba (flutter/flutter)
- [Changelog de `permission_handler_apple`](https://github.com/Baseflow/flutter-permission-handler/blob/main/permission_handler_apple/CHANGELOG.md) (Baseflow/flutter-permission-handler)
- [Plan de solo lectura del repositorio de Specs de CocoaPods](https://blog.cocoapods.org/CocoaPods-Specs-Repo/) (blog de CocoaPods)
