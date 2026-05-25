---
title: "Dart 3.12 dispensa a lista de inicialização para campos privados"
description: "Dart 3.12 permite que construtores inicializem campos privados diretamente com parâmetros nomeados, eliminando um dos padrões de código repetitivo mais persistentes da linguagem."
pubDate: 2026-05-25
tags:
  - "dart"
  - "flutter"
lang: "pt-br"
translationOf: "2026/05/dart-3-12-private-named-parameters-initializing-formals"
translatedBy: "claude"
translationDate: 2026-05-25
---

O Dart 3.12 chegou no Google I/O 2026 junto com o Flutter 3.44, e enterrada na versão está uma pequena mudança na linguagem que remove um trecho de código repetitivo que todo desenvolvedor Dart já escreveu uma centena de vezes. Agora você pode usar parâmetros nomeados privados como initializing formals. Em termos simples: um construtor pode receber um argumento nomeado e atribuí-lo diretamente a um campo privado, sem precisar de uma lista de inicialização.

## O problema do underscore que o Dart carregou por anos

O Dart marca um campo como privado prefixando-o com um underscore. Essa convenção entrava em conflito com os parâmetros nomeados do construtor, porque a linguagem se recusava a deixar um parâmetro nomeado começar com `_`. O resultado era uma dança familiar: aceitar um parâmetro de nome público e depois copiá-lo manualmente para o campo privado na lista de inicialização.

```dart
class Hummingbird {
  final String _petName;
  final int _wingbeatsPerSecond;

  Hummingbird({required String petName, required int wingbeatsPerSecond})
    : _petName = petName,
      _wingbeatsPerSecond = wingbeatsPerSecond;
}
```

Cada campo privado significava uma declaração de parâmetro mais uma entrada na inicialização. Para uma classe com oito campos privados, são dezesseis linhas de pura tubulação. Os initializing formals (`this.field`) resolveram isso para os campos públicos anos atrás, mas os campos privados ficaram no caminho lento.

## O que o 3.12 realmente muda

O Dart 3.12 faz o óbvio funcionar. Escreva `this._field` como parâmetro nomeado e o compilador cuida do resto:

```dart
class Hummingbird {
  final String _petName;
  final int _wingbeatsPerSecond;

  Hummingbird({required this._petName, required this._wingbeatsPerSecond});
}
```

O campo continua privado, mas o nome do parâmetro exposto a quem chama é a versão pública com o underscore removido. Então o local da chamada é lido exatamente como antes:

```dart
void main() {
  print(Hummingbird(petName: 'Dash', wingbeatsPerSecond: 75));
}
```

Essa é uma mudança puramente do lado do construtor. A API pública é idêntica, quem chama não toca em nada e os campos privados continuam privados. Você está apenas apagando a lista de inicialização, nada mais.

## As restrições que vale a pena conhecer

Essa exceção se aplica apenas aos initializing formals. Um parâmetro nomeado comum ainda não pode começar com um underscore, porque isso vazaria um nome privado para a assinatura pública sem um nome público para recorrer. O nome com underscore também precisa corresponder a um identificador público legal: `this._` e `this._2x` são rejeitados, porque ao remover o underscore sobra `` e `2x`, nenhum dos quais é um nome de parâmetro válido.

O recurso também se combina com os primary constructors, que chegaram como experimento no mesmo ciclo e exigem uma versão da linguagem de pelo menos 3.13. Com os dois em jogo, você pode declarar um campo privado diretamente no cabeçalho do construtor e deixar o compilador publicar automaticamente o nome voltado para o público.

Se você já está no Flutter 3.44, você tem o Dart 3.12 e pode usar isso hoje. Aumente a restrição de SDK no seu `pubspec.yaml` para `^3.12.0`, execute `dart fix` e comece a apagar listas de inicialização. Veja o [anúncio do Dart 3.12](https://dart.dev/blog/announcing-dart-3-12) para as notas de versão completas.
