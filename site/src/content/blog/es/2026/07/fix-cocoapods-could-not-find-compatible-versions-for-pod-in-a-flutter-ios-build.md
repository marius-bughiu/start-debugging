---
title: "Solución: CocoaPods could not find compatible versions for pod durante una compilación iOS de Flutter"
description: "Lee la segunda línea del error, no la primera. Ahí está la causa: un Podfile.lock desactualizado, un deployment target demasiado bajo o dos plugins fijando el mismo pod transitivo."
pubDate: 2026-07-31
template: error-page
tags:
  - "errors"
  - "flutter"
  - "ios"
  - "cocoapods"
lang: "es"
translationOf: "2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build"
translatedBy: "claude"
translationDate: 2026-07-31
---

La solución depende por completo de la línea que aparece justo debajo del error, y solo hay cuatro posibilidades. Si dice `In snapshot (Podfile.lock)`, borra `ios/Podfile.lock` y ejecuta `pod install`. Si dice que las specs `required a higher minimum deployment target`, sube `platform :ios` en tu `Podfile`. Si lista dos plugins que resuelven cada uno a una versión exacta distinta del mismo pod, es un conflicto real y se arregla en `pubspec.yaml`, no en el `Podfile`. Solo el cuarto caso, un repositorio de specs genuinamente desactualizado, se arregla con `pod repo update`. Ejecutar `pod repo update` primero, que es lo que hace casi todo el mundo, desperdicia dos minutos en los tres casos donde no puede ayudar.

Este artículo está escrito contra Flutter 3.44.7 (stable, julio de 2026), CocoaPods 1.17.0 (publicado el 2026-07-06), Dart 3.12 y Xcode 16.x en macOS Sequoia.

## El error en contexto

La forma más común, que aparece justo después de un `flutter pub upgrade` que subió un plugin de Firebase:

```text
[!] CocoaPods could not find compatible versions for pod "Firebase/CoreOnly":
  In snapshot (Podfile.lock):
    Firebase/CoreOnly (= 10.28.0)

  In Podfile:
    firebase_core (from `.symlinks/plugins/firebase_core/ios`) was resolved to 3.4.0, which depends on
      Firebase/CoreOnly (= 11.0.0)

You have either:
 * out-of-date source repos which you can update with `pod repo update` or with `pod install --repo-update`.
 * changed the constraints of dependency `Firebase/CoreOnly` inside your development pod `firebase_core`.
   You should run `pod update Firebase/CoreOnly` to apply changes you've made.

Error running pod install
Error launching application on iPhone 16 Pro.
```

La segunda forma, que parece el mismo error pero no lo es:

```text
[!] CocoaPods could not find compatible versions for pod "sqflite_darwin":
  In Podfile:
    sqflite_darwin (from `.symlinks/plugins/sqflite_darwin/darwin`)

Specs satisfying the `sqflite_darwin (from `.symlinks/plugins/sqflite_darwin/darwin`)` dependency were
found, but they required a higher minimum deployment target.
```

Ambas empiezan con la misma cadena de titular, y por eso los resultados de búsqueda para este error son un caos de consejos contradictorios. No tienen nada en común más allá de la primera línea.

## Por qué CocoaPods reporta esto en vez de simplemente elegir una versión

CocoaPods resuelve dependencias con Molinillo, un resolutor con backtracking de estilo SAT. Recibe un conjunto de restricciones y se le pide encontrar una versión de cada pod que las satisfaga todas simultáneamente. Cuando agota el espacio de búsqueda sin solución, no adivina. Imprime las restricciones que seguían en conflicto cuando se rindió, más una lista genérica de cosas que a veces causan conflictos.

Esa lista genérica es exactamente eso: genérica. Se imprime tanto si aplica como si no. El contenido de diagnóstico es el bloque indentado que aparece encima, que nombra cada restricción y de dónde vino. Cuatro cosas meten una restricción insatisfacible en ese conjunto:

1. **`Podfile.lock` fija una versión exacta antigua.** El archivo de bloqueo participa en la resolución como una restricción etiquetada `In snapshot (Podfile.lock)`. Una actualización de plugin del lado de Dart cambió lo que requiere el podspec, y el bloqueo sigue insistiendo en el número anterior. La causa más común con diferencia.
2. **Todas las versiones candidatas necesitan un deployment target más alto que el que declara tu `Podfile`.** Molinillo filtra las specs cuyo `deployment_target` supera tu línea de plataforma y luego reporta un conjunto de candidatas vacío. Esta es la variante `required a higher minimum deployment target`.
3. **Dos plugins fijan versiones exactas incompatibles de un mismo pod transitivo.** Un diamante genuino. Ninguna edición del `Podfile` lo resuelve, porque la restricción se origina en dos podspecs que Flutter generó a partir de tu `pubspec.yaml`.
4. **El repositorio de specs es anterior a la versión solicitada.** Solo relevante si usas un repositorio de specs respaldado por git. La fuente CDN que usa el `Podfile` por defecto de Flutter no necesita `pod repo update`.

## Reproducción mínima

El caso 1 se reproduce en tres comandos en cualquier proyecto con un plugin que tenga una dependencia nativa fijada:

```bash
# Flutter 3.44.7, CocoaPods 1.17.0
flutter create podconflict && cd podconflict
flutter pub add firebase_core:3.1.0 && (cd ios && pod install)
flutter pub add firebase_core:3.4.0 && (cd ios && pod install)   # boom
```

El primer `pod install` escribe `Firebase/CoreOnly (= 11.0.0)` en `ios/Podfile.lock`. El segundo `flutter pub add` cambia el plugin por uno cuyo podspec requiere una versión exacta distinta, y la restricción del archivo de bloqueo ya es insatisfacible contra el nuevo podspec.

El caso 2 se reproduce bajando la línea de plataforma por debajo de lo que un plugin necesita:

```ruby
# ios/Podfile -- Flutter 3.44.7, CocoaPods 1.17.0
platform :ios, '12.0'
```

con un plugin cuyo podspec declara:

```ruby
# .symlinks/plugins/sqflite_darwin/darwin/sqflite_darwin.podspec
s.platform = :ios, '13.0'
```

## La solución, ordenada por prioridad

### 1. Si el error dice `In snapshot (Podfile.lock)`, elimina el bloqueo

El archivo de bloqueo es una caché de una resolución anterior, no una fuente de verdad. Flutter regenera todo el grafo de pods a partir de `pubspec.lock` en cada compilación, así que un `ios/Podfile.lock` que no coincide con él está desactualizado por definición, no es autoritativo.

```bash
# Flutter 3.44.7, CocoaPods 1.17.0 -- run from the repo root
flutter pub get
cd ios
rm Podfile.lock
pod install
```

Fíjate en el orden. `flutter pub get` tiene que ejecutarse primero, porque es lo que reescribe `ios/.symlinks/plugins/` para que apunte a las versiones de plugin resueltas en la caché de pub. Ejecutar `pod install` antes resuelve los podspecs de las versiones de plugin que estuvieran ahí la última vez, lo que produce el mismo error con números distintos y te manda de vuelta al principio.

Si el plugin es uno que controlas o uno donde quieres un cambio quirúrgico en lugar de una re-resolución completa:

```bash
# CocoaPods 1.17.0 -- surgical alternative, keeps other pins intact
cd ios && pod update Firebase/CoreOnly
```

En una app Flutter, prefiere borrar el bloqueo. `pod update <pod>` es la opción correcta en un proyecto iOS escrito a mano donde el archivo de bloqueo codifica fijaciones deliberadas; en una app Flutter esas fijaciones vinieron de `pubspec.lock`, y ahí es donde quieres que sigan viniendo.

### 2. Si el error dice `higher minimum deployment target`, sube la plataforma en dos lugares

Tanto el `Podfile` como el proyecto Xcode lo necesitan. Editar solo el `Podfile` arregla la resolución de pods y luego falla más tarde en el enlazado, porque el propio ajuste de compilación del target `Runner` sigue declarando el piso antiguo.

```ruby
# ios/Podfile -- Flutter 3.44.7
platform :ios, '15.0'
```

```ruby
# ios/Podfile -- force every pod target to inherit the same floor
post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_ios_build_settings(target)
    target.build_configurations.each do |config|
      config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '15.0'
    end
  end
end
```

Después configúralo también en el target de la app. Abre `ios/Runner.xcworkspace`, selecciona el target `Runner`, ve a `Build Settings` y pon `iOS Deployment Target` en el mismo valor tanto para Debug como para Release. El ajuste del workspace gana sobre el `Podfile` para `Runner` en sí; la línea del `Podfile` solo gobierna los targets de pods.

No elijas el número por ensayo y error. Léelo del podspec que falló:

```bash
# Flutter 3.44.7 -- print the floor the failing plugin actually declares
grep -r "s.platform\|deployment_target" ios/.symlinks/plugins/sqflite_darwin/darwin/*.podspec
```

Subir el piso deja fuera dispositivos más antiguos, así que súbelo exactamente a lo que el podspec necesita, no a la versión de iOS más nueva que tengas instalada.

### 3. Si dos plugins fijan el mismo pod a versiones exactas distintas, arregla `pubspec.yaml`

Este es el caso donde toda edición del `Podfile` y todo borrado de caché fallan, porque el conflicto está río arriba de CocoaPods. La señal son dos líneas `was resolved to` que nombran dos plugins distintos:

```text
[!] CocoaPods could not find compatible versions for pod "GTMSessionFetcher/Core":
  In Podfile:
    firebase_auth (from `.symlinks/plugins/firebase_auth/ios`) was resolved to 5.1.0, which depends on
      GTMSessionFetcher/Core (~> 3.3)
    google_sign_in_ios (from `.symlinks/plugins/google_sign_in_ios/darwin`) was resolved to 5.7.6, which depends on
      GTMSessionFetcher/Core (< 3.0, >= 1.1)
```

`~> 3.3` y `< 3.0` no se solapan. Encuentra las versiones de plugin cuyos podspecs sí concuerdan y fíjalas en `pubspec.yaml`:

```yaml
# pubspec.yaml -- Flutter 3.44.7, Dart 3.12
dependencies:
  firebase_auth: ^5.1.0
  google_sign_in: ^6.2.2   # 6.2.2 ships google_sign_in_ios 5.7.7+, which allows GTMSessionFetcher 3.x
```

Luego vuelve a resolver ambas capas:

```bash
# Flutter 3.44.7, CocoaPods 1.17.0
flutter pub get
cd ios && rm Podfile.lock && pod install
```

Puedes forzar una versión de un pod transitivo desde el `Podfile` en su lugar:

```ruby
# ios/Podfile -- last resort, use only to unblock while waiting on a plugin release
pod 'GTMSessionFetcher/Core', '3.4.1'
```

Trata eso como un parche temporal con fecha de caducidad. Anula una restricción que el autor del plugin escribió deliberadamente, y compilará limpiamente justo hasta que falle en tiempo de ejecución por un selector inexistente.

Si `flutter pub get` falla antes de que siquiera llegues a CocoaPods, tienes un problema de resolución del lado de Dart y no uno nativo, y las restricciones a leer son otras: ve [por qué "Version solving failed" es una prueba y no un bug](/es/2026/05/fix-version-solving-failed-in-pubspec-yaml/).

### 4. Solo entonces, actualiza el repositorio de specs

```bash
# CocoaPods 1.17.0
cd ios && pod install --repo-update
```

Esto ayuda exactamente en una situación: usas un repositorio de specs respaldado por git (`source 'https://github.com/CocoaPods/Specs.git'` en tu `Podfile`) y tu clon local es anterior a la versión solicitada. El `Podfile` generado por Flutter usa la fuente CDN por defecto, que consulta versiones por HTTP pod a pod y nunca está desactualizada en ese sentido. Si no has cambiado la línea `source`, `--repo-update` es una operación nula que te cuesta un clon completo de las specs.

## Trampas y errores parecidos

**`flutter clean` no toca `Podfile.lock`.** Limpia `build/` y `.dart_tool/`. `ios/Podfile.lock` e `ios/Pods/` sobreviven intactos, y por eso "ya ejecuté flutter clean" es la pista falsa más común con este error. La opción nuclear que sí limpia el estado de iOS:

```bash
# Flutter 3.44.7, CocoaPods 1.17.0
flutter clean
cd ios && pod deintegrate && rm -rf Pods Podfile.lock .symlinks
cd .. && flutter pub get
cd ios && pod install
```

**`arch -x86_64 pod install` está obsoleto.** Ese truco es de 2021, cuando la gema `ffi` no tenía binario arm64. CocoaPods 1.17.0 sobre Ruby 3.x corre nativo en Apple Silicon. Anteponer `arch -x86_64` hoy fuerza un Ruby bajo Rosetta que puede no tener tus gemas instaladas y produce un fallo sin relación.

**Un plugin que migró a SwiftPM no aparecerá en el grafo de pods en absoluto.** Desde que [Flutter 3.44 convirtió Swift Package Manager en el valor por defecto](/es/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/), los plugins que publican un `Package.swift` los resuelve SwiftPM y CocoaPods nunca los ve. Eso suele ser lo que hace que este error desaparezca al actualizar. También significa que un conflicto sobre el que estás leyendo en una respuesta de StackOverflow de 2024 puede que ya no se reproduzca, y que fijar un pod en tu `Podfile` para arreglar un plugin que ya migró no hará nada en silencio. Comprueba qué resolutor es dueño de un plugin antes de parchear a su alrededor:

```bash
# Flutter 3.44.7 -- if this file exists, the plugin is on SwiftPM, not CocoaPods
ls ios/Flutter/ephemeral/Packages/FlutterGeneratedPluginSwiftPackage/Package.swift
```

**`Error running pod install` sin bloque de restricciones debajo es otro error distinto.** Si no hay una sección indentada `In Podfile:`, CocoaPods falló antes de la resolución, normalmente por un problema de cadena de herramientas de Ruby o Xcode y no por un conflicto de versiones. Eso pertenece a [la lista de verificación de compilación iOS con Xcode 16](/es/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/), no a este artículo.

**Reproducibilidad en CI.** Versionar `ios/Podfile.lock` es lo correcto por defecto, pero hace que el caso 1 salte en CI la primera vez que alguien del equipo sube un plugin sin volver a ejecutar `pod install` en local. O bien impones que ambos archivos de bloqueo se muevan en el mismo commit, o fijas la cadena de herramientas para que al menos el fallo sea determinista: ve [cómo apuntar a varias versiones de Flutter desde un solo pipeline de CI](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/). El lado Android del mismo tipo de problema está cubierto en [assembleDebug fallando con exit code 1](/es/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).

## La fecha límite que conviene tener presente

El repositorio de specs de CocoaPods Trunk pasa a ser permanentemente de solo lectura el 2026-12-02, con un ensayo de corte entre el 2026-11-01 y el 2026-11-07. Los pods existentes se siguen resolviendo y el CDN sigue sirviendo, así que las compilaciones no se rompen, pero ningún pod volverá a publicar una versión nueva jamás. En la práctica: después de esa fecha, el caso 3 de arriba deja de arreglarse esperando. Si dos plugins fijan versiones incompatibles de un pod compartido y ninguno publica un podspec corregido antes de diciembre, no llegará ninguna versión río arriba a rescatarte, y las únicas salidas son una anulación en el `Podfile` o mover el plugin a SwiftPM. Vale la pena presupuestar ambas ahora y no en el primer trimestre.

## Fuentes

- [CocoaPods Trunk read-only plan](https://blog.cocoapods.org/CocoaPods-Specs-Repo/) (blog de CocoaPods)
- [Swift Package Manager for Flutter app developers](https://docs.flutter.dev/packages-and-plugins/swift-package-manager/for-app-developers) (docs.flutter.dev)
- [Notas de versión de Flutter](https://docs.flutter.dev/release/release-notes) (docs.flutter.dev)
- [Versiones de CocoaPods](https://github.com/CocoaPods/CocoaPods/releases) (CocoaPods/CocoaPods)
- [flutter/flutter#168660: could not find compatible versions for pod Firebase/CoreOnly](https://github.com/flutter/flutter/issues/168660) (flutter/flutter)
- [flutter/flutter#148116: could not find compatible versions for pod GTMSessionFetcher/Core](https://github.com/flutter/flutter/issues/148116) (flutter/flutter)
