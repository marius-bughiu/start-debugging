---
title: "Flutter 3.38.6 y el bump de `engine.version`: las builds reproducibles se vuelven más fáciles (si lo fijas)"
description: "Flutter 3.38.6 subió engine.version, y eso importa para builds reproducibles. Aprende a fijar el SDK en CI, evitar drift del engine y diagnosticar 'qué cambió' cuando las builds se rompen sin cambios de código."
pubDate: 2026-01-08
tags:
  - "flutter"
lang: "es"
translationOf: "2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it"
translatedBy: "claude"
translationDate: 2026-04-30
---
Flutter 3.38.6 aterrizó con una entrada de release "engine.version bump", y esa pequeña frase importa más de lo que parece. Si tus builds de CI alguna vez derivaron porque una máquina escogió un artefacto de engine ligeramente distinto, fijar la versión es la diferencia entre "funciona" y "podemos reproducir esta build la próxima semana".

Entrada del release: [https://github.com/flutter/flutter/releases/tag/3.38.6](https://github.com/flutter/flutter/releases/tag/3.38.6)

## `engine.version` es el pin oculto detrás del SDK

Cuando ejecutas `flutter --version`, no estás solo escogiendo una versión del framework. Estás eligiendo implícitamente una revisión específica del engine, y esa revisión controla:

-   **Comportamiento de Skia y renderizado**
-   **Cambios del embedder de plataforma**
-   **Comportamiento de las herramientas que dependen de artefactos del engine**

Una actualización a `engine.version` es Flutter diciendo: "este tag de SDK mapea a esta revisión de engine". En otras palabras, es una señal de reproducibilidad, no solo una tarea del proceso de release.

## Fijar Flutter 3.38.6 en CI a la manera aburrida

La manera aburrida es la mejor manera: usa un gestor de versiones y commitea la versión que quieres.

Si usas FVM, fija Flutter explícitamente y haz que CI falle si deriva:

```bash
# One-time on your machine
fvm install 3.38.6
fvm use 3.38.6 --force

# In CI (example: verify the version)
fvm flutter --version
```

Si no usas FVM, la idea importante es la misma: no dejes que "lo que esté instalado en el runner" decida tu engine. Instala Flutter 3.38.6 como parte del pipeline, cachéalo e imprime `flutter --version` en los logs para que puedas diagnosticar el drift.

## La checklist de "por qué cambió mi build"

Cuando una build de Flutter cambia sin cambios de código, reviso este orden:

-   **Tag del SDK de Flutter**: ¿seguimos en 3.38.6?
-   **Revisión del engine**: ¿`flutter --version -v` muestra el mismo commit del engine?
-   **Versión de Dart**: el drift del SDK puede cambiar el comportamiento del analyzer y del runtime.
-   **Entorno de build**: las versiones de Xcode/Android Gradle Plugin pueden crear diferencias.

La razón por la que me gusta resaltar `engine.version` es que vuelve accionable la segunda viñeta. Una vez que tratas el SDK de Flutter como una entrada inmutable, el resto del pipeline se vuelve más fácil de razonar.

Si mantienes múltiples apps, haz visible el pin. Un snippet en `README` o un check de CI que verifique Flutter 3.38.6 es barato y te ahorra horas la primera vez que alguien pregunte: "¿qué cambió?".
