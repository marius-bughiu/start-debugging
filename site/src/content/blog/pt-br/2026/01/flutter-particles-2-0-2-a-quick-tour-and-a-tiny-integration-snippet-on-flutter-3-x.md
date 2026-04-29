---
title: "Flutter Particles 2.0.2: um tour rápido (e um pequeno snippet de integração) no Flutter 3.x"
description: "particles_flutter 2.0.2 adiciona formas de partículas, rotação, modos de borda e emissores. Um tour rápido pelo que mudou e um pequeno snippet de integração para projetos Flutter 3.x."
pubDate: 2026-01-23
tags:
  - "flutter"
lang: "pt-br"
translationOf: "2026/01/flutter-particles-2-0-2-a-quick-tour-and-a-tiny-integration-snippet-on-flutter-3-x"
translatedBy: "claude"
translationDate: 2026-04-29
---
Se você constrói UIs em Flutter que precisam de "vida" (movimento ambiente no fundo, efeitos sutis de celebração, telas de carregamento que não são chatas), sistemas de partículas são uma das ferramentas de maior alavancagem que você pode adicionar. Uma thread de release das últimas 48 horas anuncia `particles_flutter` 2.0.2 com um salto real de recursos: formas, rotação, comportamentos de borda e emissores: [https://www.reddit.com/r/FlutterDev/comments/1qfjp1g/just_released_flutter_particles_200_major/](https://www.reddit.com/r/FlutterDev/comments/1qfjp1g/just_released_flutter_particles_200_major/).

Upstream:

-   pub.dev: [https://pub.dev/packages/particles_flutter](https://pub.dev/packages/particles_flutter)
-   GitHub: [https://github.com/rajajain08/particles_flutter](https://github.com/rajajain08/particles_flutter)

## O que mudou de verdade na 2.0.x (e por que importa)

A parte interessante desse release não é "novo número de versão". É que a biblioteca saiu de um helper básico de "pontos num canvas" para um pequeno motor de partículas que você pode moldar:

-   **Múltiplas formas de partícula**: círculos resolvem, mas triângulos, retângulos e imagens te aproximam de "confete", "neve" ou "faísca" sem código de desenho customizado.
-   **Rotação**: a rotação faz as partículas parecerem físicas, especialmente com sprites não circulares.
-   **Modos de borda**: bounce, wrap e pass-through cobrem a maioria dos casos de uso reais em UI.
-   **Emissores**: o comportamento de spawn é onde a maioria dos sistemas de partículas caseiros vira bagunça. Tê-lo embutido faz uma diferença real.

Tudo isso é bem compatível com projetos Flutter 3.x e Dart 3.x em que você quer o efeito, não um fim de semana escrevendo um renderer.

## Adicione o pacote e depois deixe ele chatinho de testar

Comece com uma versão fixada no `pubspec.yaml`:

```yaml
dependencies:
  flutter:
    sdk: flutter
  particles_flutter: ^2.0.2
```

Depois mantenha o efeito de partículas isolado atrás de um limite de widget. Assim, se você mais tarde trocar a implementação (um `CustomPainter` próprio, Rive, um shader), o resto da UI nem se importa.

## Um pequeno snippet de integração que você pode colar numa tela de demo

As APIs exatas variam conforme a versão do pacote, então trate isso como a "forma" da integração: mantenha num `Stack`, deixe não interativo e dirija com um controller que você possa iniciar e parar.

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

Quando você conectar o widget de partículas real, mire em padrões previsíveis:

-   Limite a contagem máxima de partículas.
-   Prefira imagens pré-carregadas em vez de decodificação em runtime.
-   Pause efeitos quando a tela não estiver visível.

Se quiser a superfície de API autoritativa, use os docs e exemplos upstream como fonte da verdade: [pub.dev](https://pub.dev/packages/particles_flutter) e [GitHub](https://github.com/rajajain08/particles_flutter).
