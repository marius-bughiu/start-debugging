---
title: "Flutter 3.47.1 impide que un paquete transitivo inyecte código nativo en tu app"
description: "El hotfix 3.47.1 valida los identificadores de clase y paquete de los plugins antes de que lleguen a GeneratedPluginRegistrant. Este es el agujero que cierra, la expresión regular que lo cierra y las otras 11 correcciones de la versión."
pubDate: 2026-08-21
tags:
  - "flutter"
  - "dart"
  - "security"
  - "flutter-tools"
lang: "es"
translationOf: "2026/08/flutter-3-47-1-blocks-plugin-registrant-code-injection"
translatedBy: "claude"
translationDate: 2026-08-21
---

Flutter 3.47.1 llegó al canal stable el 2026-08-19 con Dart 3.13.1, exactamente una semana después de que [3.47.0 convirtiera a Impeller en el renderizador predeterminado de escritorio](/es/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/). Doce incidencias es un hotfix grande para los estándares de Flutter, y una de ellas no es una corrección de fallo. Es un agujero de cadena de suministro en tiempo de compilación dentro de `flutter_tools`.

## Los identificadores de plugin llegaban al código nativo generado sin escapar

Cuando ejecutas `flutter pub get` o `flutter build`, la herramienta recorre tu grafo de dependencias transitivas y escribe un `GeneratedPluginRegistrant` para cada plataforma. Los valores `pluginClass` y el `package` de Android que trae el `pubspec.yaml` de cada plugin se interpolan textualmente en ese archivo, dentro de plantillas como `new {{package}}.{{class}}()` para Java, `{{prefix}}{{class}}.register(...)` para Swift e `#import <{{name}}/{{class}}.h>` para Objective-C. El renderizador de plantillas corre con `htmlEscapeValues` en `false`, así que nada se escapa por el camino.

La validación solo comprobaba que esos campos fueran cadenas. Lo confirmé contra un SDK 3.44.2 local, donde `AndroidPlugin.validate` sigue siendo apenas una comprobación de tipo:

```dart
static bool validate(YamlMap yaml) {
  return (yaml['package'] is String && yaml[kPluginClass] is String) ||
      yaml[kDartPluginClass] is String ||
      yaml[kFfiPlugin] == true ||
      yaml[kDefaultPackage] is String;
}
```

Una cadena con punto y coma, llaves y saltos de línea pasa esa comprobación. Así que una dependencia que declare esto compila código nativo arbitrario dentro de cualquier app que dependa de ella:

```yaml
flutter:
  plugin:
    platforms:
      macos:
        pluginClass: "SomePlugin(); evilInjectedCall(); if (false) { SomePlugin"
```

Lo que hace que valga la pena parchear esto rápido es su alcance. Los plugins se recopilan mediante `computeTransitiveDependencies`, sin ninguna aceptación explícita por parte de la app consumidora. Un paquete tres niveles más abajo en tu árbol de dependencias puede disparar esto, y la carga se ejecuta en tiempo de compilación en una máquina de desarrollo o en un runner de CI, no en tiempo de ejecución de la app, donde una revisión podría detectarla.

## Qué exige 3.47.1 en su lugar

El [PR 191294](https://github.com/flutter/flutter/pull/191294) agrega un patrón de identificador y lo aplica a cada campo de identificador presente, no solo a los que hacían válida la declaración:

```dart
final RegExp _pluginIdentifierPattern = RegExp(
  r'^[a-zA-Z_$][a-zA-Z0-9_$]*(\.[a-zA-Z_$][a-zA-Z0-9_$]*)*$',
);
```

Las rutas de código Dart tienen una regla aparte, porque `fileName` y `dartFileName` se interpolan dentro de una sentencia `import`: `RegExp(r'^\w[\w./-]*\.dart$')`, más un rechazo explícito de cualquier valor que contenga `..`.

Los modos de fallo cambian según la plataforma. Un identificador incorrecto de Android, iOS, macOS, Linux o Windows hace que `validate` devuelva false, y obtienes `Invalid plugin specification <name>`. Los plugins web fallan con una salida de herramienta más específica: `The plugin <name> has an invalid pluginClass in its web plugin declaration.` Si mantienes un plugin y tu compilación empieza a fallar de golpe en 3.47.1, revisa que la clase declarada sea un identificador con puntos simple.

## Las otras once

El resto del hotfix son sobre todo molestias de tooling, y dos justifican la actualización por sí solas: se arregló el hot restart para compilaciones web WASM ([flutter/186445](https://github.com/flutter/flutter/issues/186445)), y el hot reload ya no ignora las ediciones en paquetes miembro de un pub workspace que viven bajo el `lib/` del paquete raíz ([flutter/190284](https://github.com/flutter/flutter/issues/190284)). También entran: una condición de carrera de SwiftPM que lanzaba `FileSystemException` durante compilaciones multi-target paralelas de iOS y macOS, un fallo de `impellerc` en Windows con rutas que contienen caracteres Unicode, un interbloqueo del adaptador de depuración cuando el proceso objetivo termina antes de que se conecte el VM service, y la aceptación a nivel de proyecto de Flutter GPU en compilaciones release en Linux y Windows.

```bash
flutter channel stable
flutter upgrade
```

La lista completa está en el [changelog de hotfixes de Flutter](https://github.com/flutter/flutter/blob/main/CHANGELOG.md).
