---
title: "Dart 3.12 traz construtores primários atrás de um flag experimental"
description: "Dart 3.12 adiciona uma sintaxe experimental de construtores primários que declara os campos e um construtor no cabeçalho da classe, reduzindo a clássica classe de dados de três linhas para apenas uma."
pubDate: 2026-06-04
tags:
  - "dart"
  - "flutter"
lang: "pt-br"
translationOf: "2026/06/dart-3-12-experimental-primary-constructors"
translatedBy: "claude"
translationDate: 2026-06-04
---

O Dart 3.12 (lançado em 2026-05-20) trouxe um dos recursos mais pedidos da linguagem como uma versão prévia experimental: os construtores primários. Se você já escreveu o mesmo campo, mais o parâmetro de construtor `this.field`, mais a atribuição três vezes para uma classe de dados simples, esta é a sintaxe que elimina esse padrão. Por enquanto ela fica atrás de `--enable-experiment=primary-constructors`, mas vale a pena conectá-la em uma branch hoje, porque muda como boa parte do código Dart do dia a dia é lido.

Isso dá sequência ao outro corte de código repetitivo do Dart 3.12, os [parâmetros nomeados privados como formais de inicialização](/pt-br/2026/05/dart-3-12-private-named-parameters-initializing-formals/). Os construtores primários vão além: movem toda a declaração para o cabeçalho da classe.

## Uma linha em vez de quatro

Esta é a classe de dados que todo mundo escreve, a parte que o compilador deveria ter gerado desde sempre:

```dart
class Point {
  final int x;
  final int y;
  Point(this.x, this.y);
}
```

Com um construtor primário, as declarações de campos e o construtor se colapsam no cabeçalho. Um corpo de classe vazio vira um ponto e vírgula:

```dart
class Point(final int x, final int y);
```

A regra é simples: um parâmetro marcado como `final` ou `var` no cabeçalho vira um campo de instância. Tire o modificador e ele continua sendo um parâmetro de construtor comum, não um campo. Assim, `class User(String name);` recebe `name` como argumento sem armazená-lo, enquanto `class User(final String name);` o armazena.

## Os campos podem depender dos parâmetros do cabeçalho

Os parâmetros do cabeçalho estão no escopo dentro do corpo da classe, então você pode inicializar outros campos não `late` a partir deles sem uma lista de inicialização:

```dart
class DeltaPoint(final int x, int delta) {
  final int y = x + delta;
}
```

Aqui `delta` é um parâmetro de construtor (sem `final`, então não é um campo) e `y` é calculado a partir dele.

## Adicionando validação com um corpo

Quando você precisa de um assert ou de alguma configuração, escreve um corpo de construtor introduzido por `this`. A forma só com lista de inicialização termina em ponto e vírgula:

```dart
class Point(var int x, var int y) {
  this : assert(x >= 0 && y >= 0) {
    print('Point initialized at ($x, $y)');
  }
}
```

Os construtores nomeados também ganham uma forma mais enxuta, usando `new` no corpo:

```dart
class Pet {
  String name;

  new() : name = 'Fluffy';
  new withName(this.name);
}
```

## Como ativar

O recurso é experimental, então você ativa por execução:

```bash
dart run --enable-experiment=primary-constructors bin/main.dart
```

Como é experimental, trate-o como uma versão prévia: a sintaxe ainda pode mudar antes de estabilizar, e `final` e `var` agora carregam um significado especial em uma lista de parâmetros, então não leve isso ainda para código de produção compartilhado. Mas para uma branch lateral, os construtores primários deixam muito mais curtos os modelos de widgets do Flutter, os objetos de valor e os contêineres de configuração. A especificação completa, incluindo os parâmetros super e as regras dos construtores nomeados, está na [documentação de construtores primários do Dart](https://dart.dev/language/primary-constructors).
