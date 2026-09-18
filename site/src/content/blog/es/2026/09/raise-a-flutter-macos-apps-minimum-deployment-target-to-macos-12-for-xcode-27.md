---
title: "Sube el deployment target mínimo de una app Flutter para macOS a macOS 12 para Xcode 27"
description: "Xcode 27 se niega a compilar cualquier cosa por debajo de macOS 12, y Flutter 3.47 movió su propio mínimo de 10.15 a 12.0. Qué reescribe la migración automática, los tres lugares que omite en silencio (valores personalizados, overrides en post_install del Podfile, podspecs de plugins) y un arreglo en el Podfile para equipos que siguen en Flutter 3.44."
pubDate: 2026-09-18
updatedDate: 2026-09-18
template: migration
tags:
  - "migration"
  - "flutter"
  - "macos"
  - "xcode"
  - "cocoapods"
lang: "es"
translationOf: "2026/09/raise-a-flutter-macos-apps-minimum-deployment-target-to-macos-12-for-xcode-27"
translatedBy: "claude"
translationDate: 2026-09-18
---

Para la mayoría de las apps Flutter para macOS esto es un trabajo de cinco minutos: actualiza a Flutter 3.47 o posterior (3.47.4 es la versión estable actual, Dart 3.13.3), ejecuta `flutter build macos` una vez y haz commit de las tres líneas que la herramienta reescribe en `macos/Runner.xcodeproj/project.pbxproj` más la línea `platform :osx` en `macos/Podfile`. La migración solo reconoce los valores exactos que Flutter ha generado alguna vez de fábrica (10.11, 10.13, 10.14, 10.15, 11.0), así que un proyecto que alguien editó a mano a `11.5` o `10.14.6`, un bloque `post_install` del Podfile que fija los pods a una versión antigua o un podspec de plugin desactualizado sobrevivirán a ella y luego fallarán en Xcode 27 con `The macOS deployment target 'MACOSX_DEPLOYMENT_TARGET' is set to ..., but the range of supported deployment target versions is 12.0 to 27.0.x`. Todo lo que sigue se verificó en una Mac con Xcode 26.6, Flutter 3.44.8 y 3.47.4, y CocoaPods 1.17.0.

## Por qué se movió el mínimo

Apple subió el deployment target mínimo de macOS en Xcode 27 de macOS 11 a macOS 12 (iOS se queda en 15, watchOS pasa de 8 a 9). Xcode 27 llegó a disponibilidad general a mediados de septiembre de 2026, así que las imágenes de CI y las máquinas de desarrollo se están cambiando ahora mismo. Por debajo del mínimo, Xcode 27 no advierte y ajusta el valor como hacían las versiones anteriores: detiene la compilación con un error de integridad del target.

La política de Flutter es [igualar el rango de despliegue del Xcode actual](https://flutter.dev/go/match-xcode-deployment-range), así que el equipo abrió [flutter/flutter#187762](https://github.com/flutter/flutter/issues/187762) e integró [flutter/flutter#188520](https://github.com/flutter/flutter/pull/188520) (fusionado el 2026-06-29), que se incluye en 3.47.0. Hace tres cosas:

- `FlutterDarwinPlatform.macos.deploymentTarget()` en `flutter_tools` ahora devuelve `12.0` en lugar de `10.15`. Ese valor alimenta el paquete SwiftPM generado, las plantillas de plugins y el podspec de `FlutterMacOS`.
- El `FlutterMacOS.framework` del engine se compila para macOS 12. En mi compilación con 3.44.8 su `LC_BUILD_VERSION` dice `minos 11.0`; en la compilación con 3.47.4 dice `minos 12.0`.
- `MacOSDeploymentTargetMigration` y `podhelper.rb` se actualizaron para mover los proyectos existentes a `12.0`.

El segundo punto importa aunque nunca instales Xcode 27. Una app con Flutter 3.47 que todavía dice soportar macOS 11 está haciendo una promesa que el binario del engine no puede cumplir.

## Qué se rompe

| Área | Cambio | Severidad |
| ---- | ------ | -------- |
| `MACOSX_DEPLOYMENT_TARGET` por debajo de 12.0 en `Runner` | Error de compilación en Xcode 27 | alta, migrado automáticamente para valores de fábrica |
| `platform :osx` por debajo de 12.0 en `macos/Podfile` | Los pods se compilan para la versión antigua, error en Xcode 27 | alta, migrado automáticamente para valores de fábrica |
| `post_install` del Podfile que establece `MACOSX_DEPLOYMENT_TARGET` en los pods | Los overrides sobreviven a la migración, error en Xcode 27 | alta, arreglo manual |
| Podspec o `Package.swift` de un plugin que declara menos de 12.0 | Lo maneja `podhelper.rb` (3.47+) y el paquete SwiftPM generado | baja para autores de apps, limpieza para autores de plugins |
| Usuarios en macOS 10.15 y 11 | No pueden instalar compilaciones nuevas (`LSMinimumSystemVersion` pasa a 12.0) | decisión de producto |

La última fila es la única que no es un problema de compilación. `macos/Runner/Info.plist` establece `LSMinimumSystemVersion` a `$(MACOSX_DEPLOYMENT_TARGET)`, así que en el momento en que cambia la configuración de compilación, la App Store y los actualizadores estilo Sparkle dejan de ofrecer tu nueva versión a las máquinas con Catalina y Big Sur. Revisa tus analíticas antes de publicar y avisa a soporte.

## Lista de verificación previa

- Flutter 3.47.0 o posterior en cada máquina y runner de CI que compile el target de macOS. `flutter --version` debería imprimir `3.47.x` o más reciente.
- Un árbol de trabajo limpio en `macos/`, para que el diff de la migración se pueda revisar por separado.
- CocoaPods 1.16 o posterior si todavía usas CocoaPods para los plugins de macOS (aquí se usó 1.17.0).
- Una lista de cada lugar donde tu repo establece una versión de macOS. Este comando de una línea los encuentra:

```bash
# Flutter 3.47.4, run from the project root
grep -rnE "MACOSX_DEPLOYMENT_TARGET|platform :osx|osx.deployment_target|\.macOS\(" \
  macos/ --include='*.pbxproj' --include='Podfile' --include='*.xcconfig' \
  --include='*.podspec' --include='Package.swift'
```

## Pasos de migración

1. Actualiza el SDK con `flutter upgrade` (o fija 3.47.4 en tu configuración de FVM o CI) y luego ejecuta `flutter clean`. Verifica con `flutter --version` que la herramienta reporta 3.47.x o más reciente.
2. Ejecuta `flutter build macos --debug` una vez. La herramienta ejecuta `MacOSDeploymentTargetMigration` antes de `pod install` e imprime `Updating minimum macOS deployment target to 12.0.` exactamente una vez. Verifica con `git diff --stat macos/` que `project.pbxproj` y `Podfile` cambiaron.
3. Vuelve a ejecutar el grep de la lista de verificación previa y confirma que no queda nada por debajo de 12.0 en `Runner`, `RunnerTests`, cualquier target adicional, los archivos `.xcconfig` o el Podfile. Arregla a mano lo que la migración haya omitido (detalles más abajo).
4. Elimina o actualiza cualquier bloque `post_install` del Podfile que escriba `MACOSX_DEPLOYMENT_TARGET` en los targets de los pods y luego ejecuta `flutter build macos --debug` otra vez. Verifica con `grep MACOSX_DEPLOYMENT_TARGET macos/Pods/Pods.xcodeproj/project.pbxproj | sort | uniq -c` que cada entrada sea 12.0 o superior.
5. Revisa el binario entregado: `plutil -p` sobre el `Contents/Info.plist` de la app compilada debería mostrar `LSMinimumSystemVersion => 12.0`, y `otool -l` sobre el ejecutable debería mostrar `minos 12.0`.
6. Cambia la CI a una imagen con Xcode 27 y ejecuta una compilación release (`flutter build macos --release`). Este es el único paso que demuestra que el proyecto compila en Xcode 27.

## Qué reescribe realmente la migración

En un proyecto creado con Flutter 3.44.8 (que genera 10.15 en todas partes), con `url_launcher` añadido y CocoaPods habilitado, la primera compilación con 3.47.4 imprimió la línea de estado y produjo exactamente este diff en los dos archivos que le pertenecen:

```diff
# macos/Podfile (Flutter 3.47.4 migration)
-platform :osx, '10.15'
+platform :osx, '12.0'

# macos/Runner.xcodeproj/project.pbxproj (Debug, Release, Profile)
-				MACOSX_DEPLOYMENT_TARGET = 10.15;
+				MACOSX_DEPLOYMENT_TARGET = 12.0;
```

Luego la compilación tuvo éxito y cada `MACOSX_DEPLOYMENT_TARGET` en `Pods.xcodeproj` era 12.0, aunque `url_launcher_macos` 3.2.6 todavía declara `s.platform = :osx, '10.15'` en su podspec. Eso es obra de `podhelper.rb`: `flutter_additional_macos_build_settings` borra el deployment target propio del pod cuando su versión mayor está por debajo de 12, así que el pod hereda en su lugar la plataforma del Podfile. Antes de 3.47 el corte era 10.15, así que un pod que declaraba 10.15 conservaba su valor, y eso es lo que hace fallar a los proyectos con Flutter 3.44 en Xcode 27 incluso después de editar el target Runner (ver la última sección).

Con SwiftPM (el valor predeterminado desde Flutter 3.44 para proyectos sin la exclusión), la migración también mueve el target Runner, y la herramienta regenera `macos/Flutter/ephemeral/Packages/FlutterGeneratedPluginSwiftPackage/Package.swift` a partir del `MACOSX_DEPLOYMENT_TARGET` del Runner. En mi ejecución pasó de `.macOS("10.15")` a `.macOS("12.0")` en la primera compilación con 3.47.4. El `Package.swift` dentro de `url_launcher_macos` todavía dice `.macOS("10.15")`; en Xcode 26.6 eso compiló sin problemas. No pude ejecutar Xcode 27 en esta máquina, así que no he verificado que los manifiestos de plugins por debajo de 12.0 también compilen sin problemas allí.

## Trampa 1: una versión editada a mano es invisible para la migración

El migrador es un reemplazo de cadenas línea por línea. Según `macos_deployment_target_migration.dart` en el tag `3.47.4`, busca estas cadenas literales y nada más:

```dart
// flutter_tools 3.47.4, lib/src/macos/migrations/macos_deployment_target_migration.dart
const deploymentTargetOriginal1015 = 'MACOSX_DEPLOYMENT_TARGET = 10.15;';
const deploymentTargetOriginal110 = 'MACOSX_DEPLOYMENT_TARGET = 11.0;';
const podfilePlatformVersionOriginal1015 = "platform :osx, '10.15'";
const podfilePlatformVersionOriginal110 = "platform :osx, '11.0'";
// ...plus 10.11, 10.13 and 10.14 in both forms
```

Así que `11.5`, `10.14.6`, `11.0.1`, un valor establecido en un `.xcconfig` o `platform :osx, "10.15"` con comillas dobles se quedan tal cual, sin ningún mensaje. Puse el target Runner y el Podfile en 11.5 y compilé con 3.47.4. No apareció ninguna línea `Updating minimum macOS deployment target`, `git status` no mostró cambios en ninguno de los dos archivos y la compilación igual tuvo éxito en Xcode 26.6, con advertencias del linker fáciles de pasar por alto:

```text
ld: warning: building for macOS-11.5, but linking with dylib
'@rpath/FlutterMacOS.framework/Versions/A/FlutterMacOS' which was built for newer version 12.0
```

La app resultante tiene `LSMinimumSystemVersion` 11.5 y `minos 11.5` mientras incluye un engine compilado para 12.0. En Xcode 27 el mismo proyecto falla directamente. El arreglo es establecer el valor a mano en Xcode (proyecto Runner, target Runner, General, Minimum Deployments) o en el archivo:

```bash
# Flutter 3.47.4 project, replace any leftover value below 12.0
sed -i '' -E 's/MACOSX_DEPLOYMENT_TARGET = (10\.[0-9.]+|11\.[0-9.]+);/MACOSX_DEPLOYMENT_TARGET = 12.0;/' \
  macos/Runner.xcodeproj/project.pbxproj
sed -i '' -E "s/platform :osx, ['\"][0-9.]+['\"]/platform :osx, '12.0'/" macos/Podfile
```

Subir la plataforma del Podfile importa tanto como el target Runner. Cuando dejé el Runner en 10.14.6 y el Podfile en 11.5, incluso Xcode 26.6 se detuvo con `compiling for macOS 10.14.6, but module 'url_launcher_macos' has a minimum deployment target of macOS 11.5` en `GeneratedPluginRegistrant.swift`. Mantén los dos sincronizados.

## Trampa 2: los overrides en post_install del Podfile sobreviven

Un copiar y pegar común de la era de Xcode 14 fuerza todos los pods a una sola versión:

```ruby
# macos/Podfile, a pattern that breaks on Xcode 27
post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_macos_build_settings(target)
    target.build_configurations.each do |config|
      config.build_settings['MACOSX_DEPLOYMENT_TARGET'] = '10.14'
    end
  end
end
```

La migración tocó la línea `platform :osx` de ese Podfile e imprimió su mensaje de estado, así que parece terminada. Después de la compilación, `Pods.xcodeproj` contenía 15 entradas `MACOSX_DEPLOYMENT_TARGET = 10.14;` y solo 3 en 12.0: el override se ejecuta después de `flutter_additional_macos_build_settings` y gana. Xcode 26.6 compiló esos pods en silencio para macOS 11.0 (su propio mínimo), y por eso nadie lo nota. Xcode 27, en cambio, da error en cada uno de ellos.

Elimina el bucle interno. Si un pod realmente necesita una versión fija, fíjala en `12.0` o superior, nunca por debajo de la plataforma del Podfile.

## Trampa 3: el error guiado solo existe desde 3.47

Cuando Xcode rechaza el target, Flutter 3.47 reconoce la línea (la lógica de coincidencia llegó en [flutter/flutter#188812](https://github.com/flutter/flutter/pull/188812), a partir de [flutter/flutter#187855](https://github.com/flutter/flutter/issues/187855)) e imprime un mensaje en un recuadro:

```text
The macOS deployment target is too low. Xcode requires at least 12.0.

To upgrade your macOS deployment target, follow these steps:
  1. Open the project in Xcode:
     open macos/Runner.xcworkspace
  2. Select the "Runner" project in the project navigator.
  3. Select the "Runner" TARGET, and in the "General" tab:
     Update "Minimum Deployments" to at least 12.0.
```

Dos salvedades. El mensaje solo aparece cuando la línea que falla menciona `MACOSX_DEPLOYMENT_TARGET` y el rango soportado, y el consejo solo cubre el target Runner, así que para un fallo en el target de un pod (Trampa 2) el arreglo que sugiere no es el que necesitas. Y Flutter 3.44 y anteriores no tienen ese manejo: obtienes `Build process failed` más la línea cruda de Xcode, que en los fixtures de prueba de ese PR dice `error: The macOS deployment target 'MACOSX_DEPLOYMENT_TARGET' is set to 10.11, but the range of supported deployment target versions is 12.0 to 27.0.x. (in target 'Runner' from project 'Runner')`. El sufijo `(in target '...')` te dice qué target arreglar.

## Quedarse en Flutter 3.44 con Xcode 27

A veces no puedes actualizar Flutter esta semana, pero tu imagen de CI ya pasó a Xcode 27. Puedes subir la versión del proyecto a mano, pero el `podhelper.rb` de 3.44 solo quita los deployment targets de pods por debajo de 10.15, así que los pods que declaran de 10.15 a 11.x conservan sus valores. En un proyecto con 3.44.8 con el Runner y el Podfile editados a 12.0, `Pods.xcodeproj` todavía tenía 9 entradas en `10.15`. Esta adición en `post_install` las eliminó todas, dejando cada pod en el 12.0 heredado:

```ruby
# macos/Podfile, Flutter 3.44.x workaround for Xcode 27
post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_macos_build_settings(target)
    target.build_configurations.each do |config|
      pod_target = config.build_settings['MACOSX_DEPLOYMENT_TARGET']
      if pod_target && Gem::Version.new(pod_target) < Gem::Version.new('12.0')
        config.build_settings.delete 'MACOSX_DEPLOYMENT_TARGET'
      end
    end
  end
end
```

Borrar en lugar de sobrescribir es el mismo truco que usa Flutter 3.47: el pod hereda el valor más alto del proyecto, y un pod que de verdad requiere algo más nuevo que 12.0 conserva su propio requisito. El framework del engine en 3.44 está compilado para macOS 11, así que esto no cambia en qué puede ejecutarse tu binario, solo satisface a Xcode 27. Quita el bloque cuando estés en 3.47, porque se vuelve redundante.

## Para autores de plugins

Si publicas un plugin para macOS, sube el podspec (`s.platform = :osx, '12.0'` o `s.osx.deployment_target = '12.0'`) y la plataforma de `Package.swift` (`.macOS("12.0")`) en tu próxima versión, y sube tu restricción `environment: flutter:` a `>=3.47.0` si dependes de algo de esa versión. Las apps en 3.47 ya están protegidas por `podhelper.rb`, así que esto es higiene más que una emergencia, pero evita que tu plugin aparezca como falso positivo en el `grep` de alguien, y las plantillas de plugins de 3.47 generan 12.0 de todos modos.

## Verificación

- `flutter build macos --release` tiene éxito en un runner con Xcode 27.
- `grep -rn MACOSX_DEPLOYMENT_TARGET macos/ --include='*.pbxproj' --include='*.xcconfig'` no muestra nada por debajo de 12.0, incluido `macos/Pods/Pods.xcodeproj/project.pbxproj`.
- `plutil -p build/macos/Build/Products/Release/<App>.app/Contents/Info.plist | grep LSMinimumSystemVersion` imprime `12.0`.
- El registro de compilación no tiene advertencias `building for macOS-11.x, but linking with dylib ... built for newer version 12.0`.
- La app se abre en el macOS más antiguo en el que todavía pruebas (12.x si tienes una máquina o VM para ello).

## Plan de reversión

El cambio en el código fuente se puede revertir con `git revert`, pero el SDK de Flutter no: en 3.47 y posteriores el engine está compilado para macOS 12, y la herramienta volverá a ejecutar la migración en la siguiente compilación cada vez que vea un valor de fábrica por debajo de 12.0. Volver a soportar macOS 10.15 u 11 significa quedarse en Flutter 3.44.x y Xcode 26, que Apple dejará de aceptar para envíos a la App Store en cuanto exija el SDK de macOS 27. Trátalo como un camino de un solo sentido y toma la decisión sobre el soporte de macOS 11 de forma explícita antes de fusionar.

## Relacionado

- El lado Android de la misma actualización a 3.47: [migrar un proyecto Flutter para Android a AGP 9 con Kotlin integrado](/es/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/).
- Qué más cambió para escritorio en esa versión: [Flutter 3.47 convierte a Impeller en el renderizador predeterminado en escritorio](/es/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/).
- Por qué tu proyecto podría estar en SwiftPM sin que lo hayas elegido: [Flutter 3.44 usa SwiftPM por defecto](/es/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).
- Cuando el problema del Podfile es la resolución de versiones y no los deployment targets: [cómo arreglar "CocoaPods could not find compatible versions for pod"](/es/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/).
- La ronda anterior de esto en iOS: [cómo arreglar "Failed to build iOS app" con Xcode 16 y Flutter 3.x](/es/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/).

## Fuentes

- [flutter/flutter#187762: Increase macOS minimum supported version from 10.15 to 12 to support Xcode 27](https://github.com/flutter/flutter/issues/187762)
- [flutter/flutter#188520: el cambio del SDK, las plantillas, podhelper y la migración](https://github.com/flutter/flutter/pull/188520)
- [flutter/flutter#188812: mensaje guiado cuando la versión mínima es demasiado baja](https://github.com/flutter/flutter/pull/188812)
- [`macos_deployment_target_migration.dart` en 3.47.4](https://github.com/flutter/flutter/blob/3.47.4/packages/flutter_tools/lib/src/macos/migrations/macos_deployment_target_migration.dart)
- [`podhelper.rb` en 3.47.4](https://github.com/flutter/flutter/blob/3.47.4/packages/flutter_tools/bin/podhelper.rb)
- [Notas de la versión de Flutter 3.47.0](https://docs.flutter.dev/release/release-notes/release-notes-3.47.0)
- [Notas de la versión de Xcode 27](https://developer.apple.com/go/?id=xcode-27-sdk-rn)
