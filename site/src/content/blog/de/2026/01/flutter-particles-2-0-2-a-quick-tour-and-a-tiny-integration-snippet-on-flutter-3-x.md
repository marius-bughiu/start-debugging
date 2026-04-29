---
title: "Flutter Particles 2.0.2: ein kurzer Rundgang (und ein kleines Integrations-Snippet) für Flutter 3.x"
description: "particles_flutter 2.0.2 bringt Partikelformen, Rotation, Randmodi und Emitter. Ein kurzer Rundgang durch die Änderungen plus ein kleines Integrations-Snippet für Flutter-3.x-Projekte."
pubDate: 2026-01-23
tags:
  - "flutter"
lang: "de"
translationOf: "2026/01/flutter-particles-2-0-2-a-quick-tour-and-a-tiny-integration-snippet-on-flutter-3-x"
translatedBy: "claude"
translationDate: 2026-04-29
---
Wenn Sie Flutter-UIs bauen, die "Leben" brauchen (Hintergrundbewegung, dezente Feier-Effekte, Ladebildschirme, die nicht langweilig sind), gehören Partikelsysteme zu den wirkungsvollsten Werkzeugen, die Sie hinzufügen können. Ein Release-Thread aus den letzten 48 Stunden kündigt `particles_flutter` 2.0.2 mit einem echten Funktionssprung an: Formen, Rotation, Randverhalten und Emitter: [https://www.reddit.com/r/FlutterDev/comments/1qfjp1g/just_released_flutter_particles_200_major/](https://www.reddit.com/r/FlutterDev/comments/1qfjp1g/just_released_flutter_particles_200_major/).

Upstream:

-   pub.dev: [https://pub.dev/packages/particles_flutter](https://pub.dev/packages/particles_flutter)
-   GitHub: [https://github.com/rajajain08/particles_flutter](https://github.com/rajajain08/particles_flutter)

## Was sich in 2.0.x wirklich geändert hat (und warum es zählt)

Das Interessante an diesem Release ist nicht "neue Versionsnummer". Es ist, dass die Bibliothek von einem einfachen "Punkte auf einem Canvas"-Helfer zu einer kleinen Partikel-Engine wurde, die Sie formen können:

-   **Mehrere Partikelformen**: Kreise sind in Ordnung, aber Dreiecke, Rechtecke oder Bilder bringen Sie näher an "Konfetti", "Schnee" oder "Funken", ohne eigenen Zeichencode.
-   **Rotation**: Rotation lässt Partikel physisch wirken, besonders bei nicht runden Sprites.
-   **Randmodi**: Bounce, Wrap und Pass-through decken die meisten realen UI-Anwendungsfälle ab.
-   **Emitter**: Spawn-Verhalten ist der Punkt, an dem die meisten selbstgebauten Partikelsysteme unübersichtlich werden. Es eingebaut zu haben, ist ein großer Vorteil.

Das alles ist sehr gut kompatibel mit Flutter-3.x- und Dart-3.x-Projekten, in denen Sie den Effekt wollen und nicht ein Wochenende voller Renderer-Code.

## Paket hinzufügen, dann langweilig testbar machen

Starten Sie mit einer fixierten Version in `pubspec.yaml`:

```yaml
dependencies:
  flutter:
    sdk: flutter
  particles_flutter: ^2.0.2
```

Halten Sie den Partikel-Effekt anschließend hinter einer Widget-Grenze isoliert. So bleibt der Rest der UI unbeeinflusst, wenn Sie die Implementierung später austauschen (einen eigenen `CustomPainter`, Rive, einen Shader).

## Ein kleines Integrations-Snippet, das Sie in einen Demo-Screen einfügen können

Die genauen APIs variieren je nach Paketversion, betrachten Sie das also als "Form" der Integration: in einem `Stack` halten, nicht interaktiv machen und mit einem Controller steuern, den Sie starten und stoppen können.

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

Wenn Sie das echte Partikel-Widget anbinden, zielen Sie auf vorhersagbare Defaults:

-   Begrenzen Sie die maximale Partikelanzahl.
-   Bevorzugen Sie vorgeladene Bilder statt Dekodierung zur Laufzeit.
-   Pausieren Sie Effekte, wenn der Bildschirm nicht sichtbar ist.

Wenn Sie die maßgebliche API-Oberfläche möchten, nutzen Sie die Upstream-Docs und -Beispiele als Quelle der Wahrheit: [pub.dev](https://pub.dev/packages/particles_flutter) und [GitHub](https://github.com/rajajain08/particles_flutter).
