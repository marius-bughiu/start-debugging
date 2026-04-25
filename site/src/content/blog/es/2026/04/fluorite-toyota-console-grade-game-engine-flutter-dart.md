---
title: "Fluorite: Toyota construyó un motor de juegos de calidad consola sobre Flutter y Dart"
description: "Fluorite es un motor de juegos 3D de código abierto que embebe el renderizado de Google Filament dentro de widgets Flutter y te deja escribir la lógica del juego en Dart."
pubDate: 2026-04-13
tags:
  - "flutter"
  - "dart"
  - "game-development"
  - "fluorite"
  - "open-source"
lang: "es"
translationOf: "2026/04/fluorite-toyota-console-grade-game-engine-flutter-dart"
translatedBy: "claude"
translationDate: 2026-04-25
---

Toyota Connected North America abrió el código de [Fluorite](https://fluorite.game/), un motor de juegos 3D que corre enteramente dentro de Flutter. Fue presentado en [FOSDEM 2026](https://fosdem.org/2026/schedule/event/7ZJJWW-fluorite-game-engine-flutter/) en Bruselas y desde entonces ha estado captando atención en [Hacker News](https://news.ycombinator.com/item?id=46976911). La propuesta: renderizado de calidad consola, un core ECS en C++, y lógica de juego escrita en Dart usando el tooling estándar de Flutter.

## Por qué Flutter para un motor de juegos

Toyota necesitaba experiencias 3D interactivas para cockpits digitales y tableros en vehículos. Unity y Unreal cargan costos de licencia y peso de recursos que no encajan en hardware automotriz embebido. La sobrecarga de arranque de Godot era otra preocupación. Flutter ya estaba en su stack para trabajo de UI, así que construyeron una capa de renderizado sobre él en lugar de introducir un segundo framework.

El resultado es Fluorite: un core ECS (Entity-Component-System) delgado en C++ para trabajo crítico en rendimiento, con [Google Filament](https://github.com/google/filament) manejando el renderizado PBR a través de Vulkan, y Dart como lenguaje de scripting para la lógica del juego.

## FluoriteView e integración con Flutter

El punto clave de integración es el widget `FluoriteView`. Lo dejas caer dentro de tu árbol de widgets Flutter y renderiza una escena 3D en vivo:

```dart
@override
Widget build(BuildContext context) {
  return Scaffold(
    body: Stack(
      children: [
        FluoriteView(
          scene: myScene,
          onReady: (controller) {
            controller.loadModel('assets/car_interior.glb');
          },
        ),
        Positioned(
          bottom: 16,
          right: 16,
          child: ElevatedButton(
            onPressed: () => setState(() => _lightsOn = !_lightsOn),
            child: Text(_lightsOn ? 'Lights Off' : 'Lights On'),
          ),
        ),
      ],
    ),
  );
}
```

Múltiples widgets `FluoriteView` pueden renderizar la misma escena desde diferentes ángulos de cámara simultáneamente. El estado fluye entre las entidades del juego y los widgets Flutter usando los mismos patrones que ya usas: `setState`, providers, o cualquier enfoque de gestión de estado en el que se apoye tu aplicación.

## Zonas táctiles definidas por el modelo

Una característica que destaca para uso automotriz son las zonas táctiles definidas por el modelo. Los artistas 3D etiquetan regiones clicables directamente en Blender. En tiempo de ejecución, Fluorite expone esas etiquetas como fuentes de eventos, así un desarrollador puede escuchar un `onClick` en una perilla o control específico del tablero sin definir manualmente geometría de hit-test en código.

## Hot reload funciona

Como Fluorite corre dentro de Flutter, el hot reload de `flutter run` también aplica a los cambios de escena. Modifica un layout de widget, ajusta un parámetro de fuente de luz, o intercambia una referencia de modelo, y la actualización se refleja en cuestión de fotogramas. Esa es una ventaja significativa de flujo de trabajo sobre motores donde necesitas una recompilación completa para ver cambios.

## Más allá del tablero

El motor apunta a plataformas móviles, de escritorio, embebidas y potencialmente de consola. Toyota lo construyó para coches, pero la arquitectura no lo limita a ese dominio. Cualquier proyecto Flutter que necesite 3D acelerado por hardware, piensa en configuradores de productos, recorridos arquitectónicos, o juegos simples, podría usar Fluorite sin abandonar el ecosistema Dart.

El proyecto está disponible en [fluorite.game](https://fluorite.game/) bajo una licencia de código abierto. Si ya estás distribuyendo Flutter y necesitas 3D sin injertar un segundo runtime de motor, Fluorite vale la pena evaluarlo.
