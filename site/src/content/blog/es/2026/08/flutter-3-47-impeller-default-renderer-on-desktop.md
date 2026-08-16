---
title: "Flutter 3.47 convierte a Impeller en el renderizador predeterminado en Windows, Linux y macOS"
description: "Flutter 3.47.0 estable cambia las aplicaciones de escritorio de Skia a Impeller sin tocar una sola línea del código de tu runner. Esto es lo que cambia, cómo desactivarlo en cada plataforma y por qué esa opción es temporal."
pubDate: 2026-08-16
tags:
  - "flutter"
  - "dart"
  - "impeller"
  - "windows"
lang: "es"
translationOf: "2026/08/flutter-3-47-impeller-default-renderer-on-desktop"
translatedBy: "claude"
translationDate: 2026-08-16
---

Flutter 3.47.0 llegó al canal estable el 2026-08-12 e incluye Dart 3.13.0. Casi toda la atención se la llevan los paquetes independientes `material_ui` y `cupertino_ui` en su versión 1.0, que continúan la separación iniciada en [Flutter 3.44](/es/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/). El cambio que de verdad altera cómo dibuja tu aplicación es más silencioso: Impeller ahora es el renderizador predeterminado en Windows, Linux y macOS.

## Nada cambia en tu proyecto, y ese es justamente el problema

El runner de escritorio es código generado que vive en tu repositorio, así que es tentador suponer que un cambio de renderizador llegaría como una diferencia de plantilla que puedes revisar. No es así. En Flutter 3.44, el punto de entrada de Windows se ve así, y no hay ninguna selección de renderizador en él:

```cpp
flutter::DartProject project(L"data");

std::vector<std::string> command_line_arguments = GetCommandLineArguments();
project.set_dart_entrypoint_arguments(std::move(command_line_arguments));
```

`ImpellerSwitch` no existe en ninguna parte del SDK 3.44. Actualizar a 3.47 deja `windows\runner\main.cpp` idéntico byte a byte y cambia el valor predeterminado por debajo. Si una compilación de Windows o Linux empieza a mostrar regresiones visuales después de la actualización, lo primero que debes revisar es el renderizador, no tu árbol de widgets.

## Cómo desactivarlo en cada plataforma

Para depurar en local, una sola bandera cubre las tres plataformas de escritorio:

```bash
flutter run --no-enable-impeller
```

Para una compilación desplegada tienes que editar el runner. En Windows, en `windows\runner\main.cpp`:

```cpp
flutter::DartProject project(L"data");
project.set_impeller_switch(flutter::ImpellerSwitch::Disabled);
```

En Linux, en `linux/runner/my_application.cc`:

```c
g_autoptr(FlDartProject) project = fl_dart_project_new();
fl_dart_project_set_enable_impeller(project, FALSE);
```

En macOS, en el `<dict>` de nivel superior de `Info.plist`:

```xml
<key>FLTEnableImpeller</key>
<false />
```

Trata las tres opciones como una solución temporal. La [documentación de Impeller](https://docs.flutter.dev/perf/impeller) indica que la posibilidad de desactivarlo se eliminará en una versión futura, la misma secuencia que ya recorrieron iOS y Android. Usa el interruptor para desbloquear una versión y luego reporta el error de renderizado.

## Qué ganas con el cambio

Impeller apunta a Metal en macOS y a Vulkan en Windows y Linux en lugar de pasar por la ruta de OpenGL de Skia. La ganancia concreta está en el manejo de shaders: Impeller los compila con anticipación durante la compilación en lugar de hacerlo en el primer uso, que es lo que elimina el tirón de la primera ejecución del que los usuarios de escritorio y móvil llevan años quejándose. Flutter 3.47 también activa el renderizado por campos de distancia con signo para texto y curvas vectoriales en macOS, Linux y Windows, así que los bordes de los glifos y las curvas salen más nítidos, y el color de gama amplia viene activado por defecto en macOS.

## El resto de 3.47 que conviene leer antes de actualizar

- Los objetivos mínimos de despliegue suben a iOS 15 y macOS 12 por compatibilidad con Xcode 27.
- Widget Previews pasa a estable.
- Win32 y Linux reciben soporte para ventanas emergentes, y la API de ventanas renombra `preferredSize` a `size` y `preferredConstraints` a `constraints`.
- Los proyectos nuevos de Android usan plantillas con AGP 9 o posterior y soporte integrado de Kotlin.

La lista completa está en las [notas de la versión Flutter 3.47.0](https://docs.flutter.dev/release/release-notes/release-notes-3.47.0) y en el [anuncio oficial](https://flutter.dev/blog/whats-new-in-flutter-3-47). Si publicas una aplicación Flutter de escritorio, ejecuta tu suite de regresión visual antes de integrar la actualización del SDK.
