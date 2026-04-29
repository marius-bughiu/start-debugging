---
title: "Flutter Particles 2.0.2: un recorrido rápido (y un pequeño fragmento de integración) en Flutter 3.x"
description: "particles_flutter 2.0.2 añade formas de partículas, rotación, modos de límite y emisores. Un recorrido rápido por lo que cambió y un pequeño fragmento de integración para proyectos Flutter 3.x."
pubDate: 2026-01-23
tags:
  - "flutter"
lang: "es"
translationOf: "2026/01/flutter-particles-2-0-2-a-quick-tour-and-a-tiny-integration-snippet-on-flutter-3-x"
translatedBy: "claude"
translationDate: 2026-04-29
---
Si construyes UIs de Flutter que necesitan "vida" (movimiento ambiente de fondo, efectos sutiles de celebración, pantallas de carga que no son aburridas), los sistemas de partículas son una de las herramientas de mayor apalancamiento que puedes añadir. Un hilo de release de las últimas 48 horas anuncia `particles_flutter` 2.0.2 con un salto real de funcionalidades: formas, rotación, comportamientos de límite y emisores: [https://www.reddit.com/r/FlutterDev/comments/1qfjp1g/just_released_flutter_particles_200_major/](https://www.reddit.com/r/FlutterDev/comments/1qfjp1g/just_released_flutter_particles_200_major/).

Upstream:

-   pub.dev: [https://pub.dev/packages/particles_flutter](https://pub.dev/packages/particles_flutter)
-   GitHub: [https://github.com/rajajain08/particles_flutter](https://github.com/rajajain08/particles_flutter)

## Qué cambió de verdad en 2.0.x (y por qué importa)

La parte interesante de este release no es "número de versión nuevo". Es que la biblioteca pasó de ser una ayuda básica de "puntos en un canvas" a un pequeño motor de partículas al que puedes dar forma:

-   **Múltiples formas de partícula**: los círculos están bien, pero triángulos, rectángulos e imágenes te acercan a "confeti", "nieve" o "chispa" sin código de dibujo personalizado.
-   **Rotación**: la rotación hace que las partículas se sientan físicas, especialmente con sprites no circulares.
-   **Modos de límite**: rebote, envoltura y paso libre cubren la mayoría de los casos de uso reales en UI.
-   **Emisores**: el comportamiento de spawn es donde la mayoría de los sistemas de partículas caseros se vuelven un lío. Tenerlo integrado es importante.

Todo esto es muy compatible con proyectos Flutter 3.x y Dart 3.x donde quieres el efecto, no un fin de semana escribiendo un renderizador.

## Añade el paquete y luego hazlo aburridamente testeable

Empieza con una versión fijada en `pubspec.yaml`:

```yaml
dependencies:
  flutter:
    sdk: flutter
  particles_flutter: ^2.0.2
```

Luego mantén el efecto de partículas aislado detrás de un límite de widget. De esa forma, si más adelante cambias la implementación (un `CustomPainter` propio, Rive, un shader), al resto de la UI no le importa.

## Un pequeño fragmento de integración que puedes pegar en una pantalla de demo

Las APIs exactas varían según la versión del paquete, así que trata esto como la "forma" de la integración: mantenlo en un `Stack`, hazlo no interactivo y manéjalo con un controlador que puedas iniciar y detener.

```dart
import 'package:flutter/material.dart';

class ParticlesDemoScreen extends StatelessWidget {
  const ParticlesDemoScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Stack(
        children: [
          // Replace this with the actual particles_flutter widget from the docs.
          // The key point is: keep it behind everything else and keep it cheap.
          const Positioned.fill(
            child: IgnorePointer(
              child: ColoredBox(color: Colors.black),
            ),
          ),
          Center(
            child: ElevatedButton(
              onPressed: () {},
              child: const Text('Ship it'),
            ),
          ),
        ],
      ),
    );
  }
}
```

Cuando conectes el widget de partículas real, apunta a valores predeterminados predecibles:

-   Limita el conteo máximo de partículas.
-   Prefiere imágenes precargadas en vez de decodificación en tiempo de ejecución.
-   Pausa los efectos cuando la pantalla no está visible.

Si quieres la superficie de API autoritativa, usa los docs y ejemplos upstream como fuente de la verdad: [pub.dev](https://pub.dev/packages/particles_flutter) y [GitHub](https://github.com/rajajain08/particles_flutter).
