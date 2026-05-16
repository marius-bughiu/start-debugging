---
title: "Flutter 3.44 separa Material y Cupertino del SDK y adopta SwiftPM por defecto"
description: "Flutter 3.44 estable congela Material y Cupertino dentro del SDK y dirige el trabajo nuevo a los paquetes material_ui y cupertino_ui en pub.dev. SwiftPM también se vuelve el predeterminado para iOS y macOS, retirando por fin a CocoaPods."
pubDate: 2026-05-16
tags:
  - "flutter"
  - "dart"
  - "swiftpm"
  - "material-design"
lang: "es"
translationOf: "2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default"
translatedBy: "claude"
translationDate: 2026-05-16
---

Flutter 3.44 llegó al canal estable esta semana, y el titular es estructural más que visual. Las librerías Material y Cupertino ya no están atadas al tren de releases del SDK. A partir de ahora, el hogar canónico de `package:flutter/material.dart` y `package:flutter/cupertino.dart` son dos paquetes nuevos en pub.dev, `material_ui` y `cupertino_ui`, y las copias dentro del SDK entran en una ventana de deprecación larga. Al mismo tiempo, `flutter config --enable-swift-package-manager` es el nuevo predeterminado para compilaciones iOS y macOS, lo que por fin te permite quitar Ruby y CocoaPods de una instalación nueva de Flutter.

## Por qué las librerías de UI se están yendo del SDK

Material y Cupertino siempre se han enviado con la cadencia trimestral del propio Flutter. Eso significaba que cada ajuste de token de Material 3, cada arreglo de teclado de Cupertino y cada nuevo argumento de `MenuAnchor` esperaba al siguiente corte trimestral. Con el cambio a paquetes independientes, esos equipos son dueños de su propio ritmo de releases. Fija `material_ui: ^1.0.0` en `pubspec.yaml` y obtendrás actualizaciones de Material en cuanto aterricen en pub.dev, desacopladas de la versión de Dart SDK en la que esté tu CI.

La migración es intencionalmente de baja fricción. En 3.44 los imports actuales siguen funcionando, pero verás una advertencia de deprecación en `package:flutter/material.dart`. El intercambio recomendado es mecánico:

```dart
// Before (still works in 3.44, deprecated)
import 'package:flutter/material.dart';

// After (new home on pub.dev)
import 'package:material_ui/material_ui.dart';
```

Agrega el paquete de la forma habitual:

```yaml
dependencies:
  flutter:
    sdk: flutter
  material_ui: ^1.0.0
  cupertino_ui: ^1.0.0
```

El beneficio de segundo orden es el tamaño binario. Las apps que solo usan Cupertino pueden dejar de arrastrar el theming, la tipografía y el set de iconos de Material dentro del bundle tree-shaken una vez que las copias del SDK se eliminen en una versión futura. Las propias [notas de la versión 3.44.0](https://docs.flutter.dev/release/release-notes/release-notes-3.44.0) llaman a esto el "code freeze" de las librerías empaquetadas: solo correcciones de bugs, sin APIs nuevas.

## SwiftPM ahora es el predeterminado en iOS y macOS

El otro gran cambio es que `flutter config --enable-swift-package-manager` viene activado por defecto en proyectos nuevos. `flutter create` ya no genera un `Podfile`. Los plugins resueltos vía pub siguen recibiendo un shim de `Package.swift`, y Xcode abre el proyecto como un grafo de paquetes Swift directamente. Para apps existentes, la ruta de actualización es corta:

```sh
flutter upgrade
flutter config --enable-swift-package-manager
cd ios && rm -rf Pods Podfile.lock
flutter run -d ios
```

CocoaPods no desaparece; se queda como fallback cuando optas por salir, o cuando un plugin no ha publicado un `Package.swift`. Las advertencias de deprecación ahora marcan a los plugins que aún solo envían Pods.

## Qué más llegó en 3.44

La release también introduce `Form.clearError()` para resetear el estado de validación sin reconstruir el formulario, `RoundedSuperellipseInputBorder` para campos de entrada al estilo iOS, ventanas de tooltip en Win32, macOS y Linux, y soporte para predictive back en `FlutterFragment` y `FlutterFragmentActivity` en Android. Hay mucho que explorar, pero el split de paquetes es el cambio que va a reformar primero los archivos `pubspec.yaml` del ecosistema.

Si mantienes un paquete de Flutter que reexporta widgets de Material o Cupertino, ahora es el momento de agregar `material_ui` a tus dev dependencies y empezar a publicar imports dobles. Las advertencias de deprecación se van a volver más fuertes rápido.
