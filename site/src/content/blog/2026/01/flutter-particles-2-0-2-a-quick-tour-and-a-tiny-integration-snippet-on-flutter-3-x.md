---
title: "Flutter Particles 2.0.2: a quick tour (and a tiny integration snippet) on Flutter 3.x"
description: "particles_flutter 2.0.2 adds particle shapes, rotation, boundary modes, and emitters. A quick tour of what changed and a tiny integration snippet for Flutter 3.x projects."
pubDate: 2026-01-23
tags:
  - "flutter"
---
If you build Flutter UIs that need “life” (ambient background motion, subtle celebration effects, loading screens that are not boring), particle systems are one of the highest leverage tools you can add. A release thread from the last 48 hours announces `particles_flutter` 2.0.2 with a real feature bump: shapes, rotation, boundary behaviors, and emitters: [https://www.reddit.com/r/FlutterDev/comments/1qfjp1g/just_released_flutter_particles_200_major/](https://www.reddit.com/r/FlutterDev/comments/1qfjp1g/just_released_flutter_particles_200_major/).

Upstream:

-   pub.dev: [https://pub.dev/packages/particles_flutter](https://pub.dev/packages/particles_flutter)
-   GitHub: [https://github.com/rajajain08/particles_flutter](https://github.com/rajajain08/particles_flutter)

## What actually changed in 2.0.x (and why it matters)

The interesting part of this release is not “new version number”. It is that the library moved from a basic “dots on a canvas” helper toward a small particle engine you can shape:

-   **Multiple particle shapes**: circles are fine, but triangles/rectangles/images get you closer to “confetti”, “snow”, or “spark” without custom drawing code.
-   **Rotation**: rotation makes particles feel physical, especially with non-circular sprites.
-   **Boundary modes**: bounce, wrap, and pass-through cover most real UI use cases.
-   **Emitters**: spawning behavior is where most homegrown particle systems get messy. Having it built-in is a big deal.

This is all very compatible with Flutter 3.x and Dart 3.x projects where you want the effect, not a weekend spent writing a renderer.

## Add the package, then make it boringly testable

Start with a pinned version in `pubspec.yaml`:

```yaml
dependencies:
  flutter:
    sdk: flutter
  particles_flutter: ^2.0.2
```

Then keep the particle effect isolated behind a widget boundary. That way, if you later swap implementation (custom `CustomPainter`, Rive, a shader), the rest of the UI does not care.

## A tiny integration snippet you can paste into a demo screen

Exact APIs vary by package version, so treat this as the “shape” of the integration: keep it in a `Stack`, make it non-interactive, and drive it with a controller you can start/stop.

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

When you wire the real particle widget in, aim for predictable defaults:

-   Limit max particle count.
-   Prefer preloaded images over runtime decoding.
-   Pause effects when the screen is not visible.

If you want the authoritative API surface, use the upstream docs and examples as the source of truth: [pub.dev](https://pub.dev/packages/particles_flutter) and [GitHub](https://github.com/rajajain08/particles_flutter).
