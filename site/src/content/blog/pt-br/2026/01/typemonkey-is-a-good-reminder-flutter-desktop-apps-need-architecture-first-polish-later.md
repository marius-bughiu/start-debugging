---
title: "TypeMonkey é um bom lembrete: apps Flutter desktop precisam de arquitetura primeiro, polimento depois"
description: "TypeMonkey, um app de digitação Flutter desktop, mostra por que projetos desktop precisam de arquitetura limpa desde o primeiro dia: estados sealed, fronteiras por interface e lógica testável."
pubDate: 2026-01-18
tags:
  - "dart"
  - "flutter"
lang: "pt-br"
translationOf: "2026/01/typemonkey-is-a-good-reminder-flutter-desktop-apps-need-architecture-first-polish-later"
translatedBy: "claude"
translationDate: 2026-04-29
---
Apareceu hoje no r/FlutterDev um pequeno projeto Flutter desktop: **TypeMonkey**, um app de digitação no estilo MonkeyType que se posiciona explicitamente como "ainda no começo, mas estruturado".

Fonte: o post original e o repositório: [thread no r/FlutterDev](https://www.reddit.com/r/FlutterDev/comments/1qgc72p/typemonkey_yet_another_typing_app_available_on/) e [BaldGhost-git/typemonkey](https://github.com/BaldGhost-git/typemonkey).

## Desktop é onde "só lança a UI" deixa de funcionar

No mobile, às vezes dá para sobreviver com um único objeto de estado e uma pilha de widgets. No desktop (Flutter **3.x** + Dart **3.x**) você bate em pressões diferentes rapidinho:

-   **Fluxos centrados em teclado**: atalhos, gerenciamento de foco, tratamento previsível de teclas.
-   **Sensibilidade a latência**: sua UI não pode travar quando atualiza stats, carrega histórico ou calcula WPM.
-   **Inchaço de recursos**: perfis, modos de prática, listas de palavras, temas, persistência offline.

Por isso eu gosto de projetos que já nascem com estrutura. Arquitetura limpa não é religião, é um jeito de fazer com que o seu segundo e terceiro recurso doam menos do que o primeiro.

## Modele o loop de digitação como estados explícitos

Dart 3 te dá classes `sealed`. Para o estado da app, isso é uma forma prática de evitar "sopa de nulos" e flags booleanas espalhadas.

Aqui está uma forma mínima de estado para uma sessão de digitação que continua testável e amigável à UI:

```dart
sealed class TypingState {
  const TypingState();
}

final class Idle extends TypingState {
  const Idle();
}

final class Running extends TypingState {
  final DateTime startedAt;
  final int typedChars;
  final int errorChars;

  const Running({
    required this.startedAt,
    required this.typedChars,
    required this.errorChars,
  });
}

final class Finished extends TypingState {
  final Duration duration;
  final double wpm;

  const Finished({required this.duration, required this.wpm});
}
```

No Flutter 3.x você pode pendurar isso na solução de estado que preferir (`ValueNotifier` puro, Provider, Riverpod, BLoC). O ponto-chave é que sua UI renderiza um estado, não um monte de condicionais espalhadas pelos widgets.

## Mantenha a "lista de palavras" e os "stats" atrás de uma interface

Apps desktop costumam ganhar persistência mais tarde. Se você já começa com uma fronteira como:

-   `WordSource` (em memória agora, baseada em arquivo depois)
-   `SessionRepository` (no-op agora, SQLite depois)

dá para manter a lógica de digitação determinística e testável por unidade enquanto ainda solta UI cedo.

Se você está construindo um app desktop em Flutter 3.x e quer um repo real para usar como referência de estrutura, esse vale o acompanhamento. Mesmo que nunca clone, a ideia central é simples: no desktop, arquitetura não é exagero, é como você continua avançando.
