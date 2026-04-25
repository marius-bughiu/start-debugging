---
title: "Fluorite: Toyota construiu um motor de jogos com qualidade de console em Flutter e Dart"
description: "Fluorite é um motor de jogos 3D de código aberto que incorpora a renderização do Google Filament dentro de widgets Flutter e permite escrever a lógica do jogo em Dart."
pubDate: 2026-04-13
tags:
  - "flutter"
  - "dart"
  - "game-development"
  - "fluorite"
  - "open-source"
lang: "pt-br"
translationOf: "2026/04/fluorite-toyota-console-grade-game-engine-flutter-dart"
translatedBy: "claude"
translationDate: 2026-04-25
---

A Toyota Connected North America abriu o código do [Fluorite](https://fluorite.game/), um motor de jogos 3D que roda inteiramente dentro do Flutter. Ele foi apresentado no [FOSDEM 2026](https://fosdem.org/2026/schedule/event/7ZJJWW-fluorite-game-engine-flutter/) em Bruxelas e desde então tem chamado a atenção no [Hacker News](https://news.ycombinator.com/item?id=46976911). A proposta: renderização com qualidade de console, um core ECS em C++, e lógica de jogo escrita em Dart usando o tooling padrão do Flutter.

## Por que Flutter para um motor de jogos

A Toyota precisava de experiências 3D interativas para cockpits digitais e painéis em veículos. Unity e Unreal carregam custos de licenciamento e peso de recursos que não cabem em hardware automotivo embarcado. O overhead de inicialização do Godot era outra preocupação. O Flutter já estava no stack deles para trabalho de UI, então construíram uma camada de renderização sobre ele em vez de introduzir um segundo framework.

O resultado é o Fluorite: um core ECS (Entity-Component-System) enxuto em C++ para trabalho crítico em desempenho, com o [Google Filament](https://github.com/google/filament) cuidando da renderização PBR via Vulkan, e Dart como linguagem de scripting para a lógica do jogo.

## FluoriteView e integração com Flutter

O ponto chave de integração é o widget `FluoriteView`. Você o solta dentro da sua árvore de widgets Flutter e ele renderiza uma cena 3D ao vivo:

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

Múltiplos widgets `FluoriteView` podem renderizar a mesma cena de diferentes ângulos de câmera simultaneamente. O estado flui entre as entidades do jogo e os widgets Flutter usando os mesmos padrões que você já usa: `setState`, providers, ou qualquer abordagem de gerenciamento de estado em que sua aplicação se apoie.

## Zonas de toque definidas pelo modelo

Um recurso que se destaca para uso automotivo são as zonas de toque definidas pelo modelo. Artistas 3D marcam regiões clicáveis diretamente no Blender. Em tempo de execução, o Fluorite expõe essas marcações como fontes de evento, assim um desenvolvedor pode escutar um `onClick` em um botão giratório ou controle específico do painel sem definir manualmente geometria de hit-test no código.

## Hot reload funciona

Como o Fluorite roda dentro do Flutter, o hot reload do `flutter run` também se aplica a mudanças de cena. Modifique um layout de widget, ajuste um parâmetro de fonte de luz, ou troque uma referência de modelo, e a atualização se reflete em questão de quadros. Essa é uma vantagem de fluxo de trabalho significativa sobre motores onde você precisa de uma recompilação completa para ver as mudanças.

## Além do painel

O motor mira plataformas móveis, desktop, embarcadas, e potencialmente de console. A Toyota o construiu para carros, mas a arquitetura não o limita a esse domínio. Qualquer projeto Flutter que precise de 3D acelerado por hardware, pense em configuradores de produtos, passeios arquitetônicos, ou jogos simples, poderia usar o Fluorite sem deixar o ecossistema Dart.

O projeto está disponível em [fluorite.game](https://fluorite.game/) sob uma licença de código aberto. Se você já está entregando Flutter e precisa de 3D sem enxertar um segundo runtime de motor, o Fluorite vale a pena avaliar.
