---
title: "Fluorite: Toyota baut eine Konsolen-Klasse-Game-Engine auf Flutter und Dart"
description: "Fluorite ist eine quelloffene 3D-Game-Engine, die Google Filament-Rendering in Flutter-Widgets einbettet und Spielelogik in Dart schreiben lässt."
pubDate: 2026-04-13
tags:
  - "flutter"
  - "dart"
  - "game-development"
  - "fluorite"
  - "open-source"
lang: "de"
translationOf: "2026/04/fluorite-toyota-console-grade-game-engine-flutter-dart"
translatedBy: "claude"
translationDate: 2026-04-25
---

Toyota Connected North America hat [Fluorite](https://fluorite.game/) als Open Source veröffentlicht, eine 3D-Game-Engine, die vollständig innerhalb von Flutter läuft. Sie wurde auf der [FOSDEM 2026](https://fosdem.org/2026/schedule/event/7ZJJWW-fluorite-game-engine-flutter/) in Brüssel vorgestellt und gewinnt seitdem auf [Hacker News](https://news.ycombinator.com/item?id=46976911) an Aufmerksamkeit. Das Versprechen: Konsolen-Klasse-Rendering, ein C++ ECS-Kern und Spielelogik, geschrieben in Dart mit dem Standard-Tooling von Flutter.

## Warum Flutter für eine Game-Engine

Toyota brauchte interaktive 3D-Erlebnisse für digitale Cockpits und Armaturenbretter im Fahrzeug. Unity und Unreal bringen Lizenzkosten und Ressourcengewicht mit sich, die nicht zu eingebetteter Automotive-Hardware passen. Der Startup-Overhead von Godot war ein weiteres Anliegen. Flutter war bereits in ihrem Stack für UI-Arbeit, also bauten sie eine Rendering-Schicht darauf, statt ein zweites Framework einzuführen.

Das Ergebnis ist Fluorite: ein dünner C++ ECS (Entity-Component-System)-Kern für performance-kritische Arbeit, mit [Google Filament](https://github.com/google/filament), das PBR-Rendering über Vulkan handhabt, und Dart als Skriptsprache für Spielelogik.

## FluoriteView und Flutter-Integration

Der Schlüssel-Integrationspunkt ist das `FluoriteView`-Widget. Sie lassen es in Ihren Flutter-Widget-Baum fallen, und es rendert eine lebende 3D-Szene:

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

Mehrere `FluoriteView`-Widgets können dieselbe Szene gleichzeitig aus verschiedenen Kamerawinkeln rendern. Zustand fließt zwischen Spielentitäten und Flutter-Widgets mit denselben Mustern, die Sie bereits verwenden: `setState`, Provider oder welcher State-Management-Ansatz auch immer in Ihrer App zum Einsatz kommt.

## Modell-definierte Touch-Zonen

Ein Feature, das für den Automotive-Einsatz herausragt, sind modell-definierte Touch-Zonen. 3D-Künstler taggen klickbare Regionen direkt in Blender. Zur Laufzeit stellt Fluorite diese Tags als Ereignisquellen bereit, sodass ein Entwickler ein `onClick` auf einem bestimmten Armaturenbrett-Knopf oder -Bedienelement abhören kann, ohne Hit-Test-Geometrie manuell im Code definieren zu müssen.

## Hot Reload funktioniert

Da Fluorite innerhalb von Flutter läuft, gilt der Hot Reload von `flutter run` auch für Szenenänderungen. Ändern Sie ein Widget-Layout, passen Sie einen Lichtquellen-Parameter an oder tauschen Sie eine Modellreferenz, und das Update spiegelt sich innerhalb von Frames wider. Das ist ein erheblicher Workflow-Vorteil gegenüber Engines, bei denen Sie eine vollständige Neukompilierung brauchen, um Änderungen zu sehen.

## Über das Armaturenbrett hinaus

Die Engine zielt auf mobile, Desktop-, eingebettete und potenziell Konsolenplattformen ab. Toyota hat sie für Autos gebaut, aber die Architektur beschränkt sie nicht auf diese Domäne. Jedes Flutter-Projekt, das hardwarebeschleunigtes 3D braucht, denken Sie an Produktkonfiguratoren, architektonische Rundgänge oder einfache Spiele, könnte Fluorite verwenden, ohne das Dart-Ökosystem zu verlassen.

Das Projekt ist auf [fluorite.game](https://fluorite.game/) unter einer Open-Source-Lizenz verfügbar. Wenn Sie bereits Flutter ausliefern und 3D ohne Aufpfropfen einer zweiten Engine-Laufzeit brauchen, ist Fluorite eine Bewertung wert.
