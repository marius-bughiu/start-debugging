---
title: "Dot shorthands no Dart 3.12: elimine o nome do tipo no seu código Flutter"
description: "Os dot shorthands ficaram estáveis no Dart 3.12.2. Escreva .center ou .new e deixe o compilador inferir o tipo a partir do contexto. Veja como eles funcionam com enums, membros estáticos e construtores."
pubDate: 2026-07-05
tags:
  - "dart"
  - "flutter"
lang: "pt-br"
translationOf: "2026/07/dart-dot-shorthands-drop-the-type-name-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-05
---

Se a sua árvore de widgets do Flutter é uma parede de `MainAxisAlignment.center`, `CrossAxisAlignment.start` e `EdgeInsets.all`, o Dart acabou de te dar uma forma de apagar boa parte dessa repetição. Os dot shorthands, o recurso que deixa você escrever `.center` e o compilador descobrir o tipo, ficaram estáveis no Dart 3.12.2. O Flutter 3.44 já traz o Dart 3.12, então, se você está no canal stable atual, pode usar isso hoje.

## O que o ponto inicial realmente faz

Um dot shorthand é uma expressão que começa com um `.` isolado. Quando o contexto ao redor torna o tipo alvo inequívoco, o Dart resolve o membro em relação a esse tipo em vez de obrigar você a escrevê-lo por completo. O caso clássico é um enum em uma atribuição:

```dart
Status currentStatus = .running; // Instead of Status.running
```

A variável é declarada como `Status`, então `.running` só pode significar `Status.running`. A mesma inferência entra em ação dentro de um `switch`, onde o valor comparado já fixa o tipo:

```dart
return switch (level) {
  .debug => 'gray',
  .info => 'blue',
  .warning => 'orange',
  .error => 'red',
};
```

## Não é só para enums

O mecanismo é geral: qualquer membro estático acessível pelo tipo de contexto é válido. Isso inclui métodos estáticos, getters estáticos, construtores nomeados e construtores de fábrica.

```dart
int port = .parse('8080');      // int.parse('8080')
BigInt zero = .zero;            // BigInt.zero
Point origin = .origin();       // Point.origin() named constructor
Point p = .fromList([1.0, 2.0]); // Point.fromList(...) factory
```

O construtor sem nome ganha um nome para esse propósito: `.new`. Esse único detalhe é o que faz o recurso valer a pena em código Flutter real, onde você atribui constantemente objetos recém-construídos a campos tipados:

```dart
final ScrollController _scrollController = .new();
final GlobalKey<ScaffoldMessengerState> scaffoldKey = .new();
```

## A única regra que faz as pessoas tropeçarem

A igualdade tem um caso especial. Quando você usa um shorthand no lado direito de `==` ou `!=`, o Dart toma o tipo estático do operando esquerdo como contexto:

```dart
if (myColor == .green) {
  print('The color is green.');
}
```

Aqui `myColor` é tipado como `Color`, então `.green` se resolve para `Color.green`. O shorthand precisa ficar no lado direito. Inverta para `.green == myColor` e não há tipo de operando esquerdo para inferir, então não vai compilar.

## Como ligar isso

Os dot shorthands exigem uma versão de linguagem de pelo menos 3.10, e o recurso chegou ao stable no Dart 3.12.2. Se você já está no Flutter 3.44, tem ele. Suba a restrição do SDK no `pubspec.yaml` para `^3.12.0` e o analisador para de sinalizar o ponto inicial. Não há custo em runtime nem mudança no código gerado: isso é pura sintaxe que se resolve em tempo de compilação para o membro totalmente qualificado que você teria escrito de qualquer forma.

O ganho não é código mais curto por si só. É que o tipo aparece uma única vez, na declaração, em vez de ser repetido em cada valor. Veja a [página de linguagem sobre dot shorthands](https://dart.dev/language/dot-shorthands) para todas as regras de resolução.
