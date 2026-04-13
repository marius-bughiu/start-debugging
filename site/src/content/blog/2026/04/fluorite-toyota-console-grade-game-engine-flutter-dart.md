---
title: "Fluorite: Toyota Built a Console-Grade Game Engine on Flutter and Dart"
description: "Fluorite is an open-source 3D game engine that embeds Google Filament rendering inside Flutter widgets and lets you write game logic in Dart."
pubDate: 2026-04-13
tags:
  - "Flutter"
  - "Dart"
  - "Game Development"
  - "Fluorite"
  - "Open Source"
---

Toyota Connected North America open-sourced [Fluorite](https://fluorite.game/), a 3D game engine that runs entirely inside Flutter. It was introduced at [FOSDEM 2026](https://fosdem.org/2026/schedule/event/7ZJJWW-fluorite-game-engine-flutter/) in Brussels and has been picking up attention on [Hacker News](https://news.ycombinator.com/item?id=46976911) since. The pitch: console-grade rendering, a C++ ECS core, and game logic written in Dart using Flutter's standard tooling.

## Why Flutter for a game engine

Toyota needed interactive 3D experiences for in-vehicle digital cockpits and dashboards. Unity and Unreal carry licensing costs and resource weight that do not fit embedded automotive hardware. Godot's startup overhead was another concern. Flutter was already in their stack for UI work, so they built a rendering layer on top of it rather than introducing a second framework.

The result is Fluorite: a thin C++ ECS (Entity-Component-System) core for performance-critical work, with [Google Filament](https://github.com/google/filament) handling PBR rendering through Vulkan, and Dart as the scripting language for game logic.

## FluoriteView and Flutter integration

The key integration point is the `FluoriteView` widget. You drop it into your Flutter widget tree and it renders a live 3D scene:

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

Multiple `FluoriteView` widgets can render the same scene from different camera angles simultaneously. State flows between game entities and Flutter widgets using the same patterns you already use: `setState`, providers, or whatever state management approach your app relies on.

## Model-defined touch zones

One feature that stands out for automotive use is model-defined touch zones. 3D artists tag clickable regions directly in Blender. At runtime, Fluorite exposes those tags as event sources, so a developer can listen for an `onClick` on a specific dashboard knob or control without manually defining hit-test geometry in code.

## Hot reload works

Because Fluorite runs inside Flutter, `flutter run` hot reload applies to scene changes too. Modify a widget layout, adjust a light source parameter, or swap a model reference, and the update reflects within frames. That is a significant workflow advantage over engines where you need a full recompile to see changes.

## Beyond the dashboard

The engine targets mobile, desktop, embedded, and potentially console platforms. Toyota built it for cars, but the architecture does not limit it to that domain. Any Flutter project that needs hardware-accelerated 3D, think product configurators, architectural walkthroughs, or simple games, could use Fluorite without leaving the Dart ecosystem.

The project is available on [fluorite.game](https://fluorite.game/) under an open-source license. If you are already shipping Flutter and need 3D without grafting in a second engine runtime, Fluorite is worth evaluating.
