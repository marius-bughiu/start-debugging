---
title: "Depurar Flutter iOS desde Windows: un flujo de trabajo con dispositivo real (Flutter 3.x)"
description: "Un flujo de trabajo pragmático para depurar apps de Flutter iOS desde Windows: delega la compilación a macOS en GitHub Actions, instala el IPA en un iPhone real y usa flutter attach para hot reload y DevTools."
pubDate: 2026-01-23
tags:
  - "flutter"
lang: "es"
translationOf: "2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x"
translatedBy: "claude"
translationDate: 2026-04-29
---
Cada pocas semanas vuelve el mismo punto de dolor: "Estoy en Windows. Quiero depurar mi app de Flutter iOS en un iPhone real. ¿Necesito de verdad un Mac?". Un post reciente en r/FlutterDev propone una solución pragmática: delegar la compilación de iOS a macOS en GitHub Actions, y luego instalar y adjuntar para depurar desde Windows: [https://www.reddit.com/r/FlutterDev/comments/1qkm5pd/develop_flutter_ios_apps_on_windows_with_a_real/](https://www.reddit.com/r/FlutterDev/comments/1qkm5pd/develop_flutter_ios_apps_on_windows_with_a_real/)

El proyecto open source detrás es [https://github.com/MobAI-App/ios-builder](https://github.com/MobAI-App/ios-builder).

## Divide el problema: compila en macOS, depura desde Windows

iOS tiene dos restricciones duras:

-   Las herramientas de Xcode se ejecutan en macOS.
-   La instalación en dispositivo real y la firma tienen reglas que no puedes saltarte desde Windows.

Pero la depuración de Flutter consiste, sobre todo, en "adjuntarse a una app en ejecución y hablar con el VM service". Eso significa que puedes desacoplar build/install del ciclo del desarrollador, siempre que puedas meter en el dispositivo una app capaz de depurarse.

El flujo descrito en el post es:

-   Disparar un job de CI en macOS que produzca un `.ipa`.
-   Descargar el artefacto a Windows.
-   Instalarlo en un iPhone conectado físicamente (mediante una app puente).
-   Ejecutar `flutter attach` desde Windows para tener hot reload y DevTools.

## Una compilación mínima en GitHub Actions que produce un IPA

Esto no es la historia completa (la firma es un agujero de conejo aparte), pero muestra la idea clave: un runner de macOS compila y sube un artefacto.

```yaml
name: ios-ipa
on:
  workflow_dispatch:
jobs:
  build:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: subosito/flutter-action@v2
        with:
          channel: stable
      - run: flutter pub get
      - run: flutter build ipa --debug --no-codesign
      - uses: actions/upload-artifact@v4
        with:
          name: ios-ipa
          path: build/ios/ipa/*.ipa
```

Que `--no-codesign` sea aceptable depende de cómo planees instalar. Muchos caminos hacia un dispositivo real siguen requiriendo firma en alguna etapa, incluso para flujos de debug.

## El ciclo del lado Windows: instala y luego adjunta

Una vez que la app está instalada y ejecutándose en el iPhone, la parte de Flutter se vuelve normal:

```bash
# From Windows
flutter devices
flutter attach -d <device-id>
```

Hot reload funciona porque te estás adjuntando a una sesión de depuración, no porque hayas compilado en la misma máquina.

## Conoce los tradeoffs desde el principio

Este flujo es útil, pero no es magia:

-   **La firma sigue siendo real**: tendrás que tratar con certificados, perfiles o el camino de un instalador de terceros.
-   **Sigues necesitando un dispositivo**: los simuladores no corren en Windows.
-   **Tu job de CI se vuelve parte de tu ciclo de desarrollo**: optimiza los tiempos de compilación y cachea dependencias.

Si quieres el escrito original y el repo que disparó esto, empieza aquí: [https://github.com/MobAI-App/ios-builder](https://github.com/MobAI-App/ios-builder). Para la guía oficial de Flutter sobre depuración en iOS, ten cerca también la documentación de la plataforma: [https://docs.flutter.dev/platform-integration/ios/ios-debugging](https://docs.flutter.dev/platform-integration/ios/ios-debugging).
