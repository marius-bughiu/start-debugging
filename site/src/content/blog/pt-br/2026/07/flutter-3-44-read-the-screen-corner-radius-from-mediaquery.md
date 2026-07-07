---
title: "Flutter 3.44: Leia o raio dos cantos físicos da tela pelo MediaQuery"
description: "O Flutter 3.44 expõe os cantos arredondados do dispositivo por meio de MediaQuery.displayCornerRadiiOf. Pare de adivinhar um raio mágico e recorte sua UI na curva exata do hardware no Android API 31+."
pubDate: 2026-07-07
tags:
  - "flutter"
  - "dart"
lang: "pt-br"
translationOf: "2026/07/flutter-3-44-read-the-screen-corner-radius-from-mediaquery"
translatedBy: "claude"
translationDate: 2026-07-07
---

Os celulares deixaram de ter telas quadradas anos atrás, mas o Flutter nunca contava para você o quão arredondados os cantos realmente eram. Se você queria que um card ou uma folha em tela cheia acompanhasse a curva física da tela, você fixava no código um `BorderRadius.circular(24)` que ajustava a olho contra um dispositivo e torcia para ficar bom no resto. O Flutter 3.44, a versão estável atual, finalmente lê esse valor direto do hardware e o entrega para você por meio do `MediaQuery`.

## O valor que o sistema operacional já conhecia

O Android expõe os raios por canto por meio da sua API `RoundedCorner` desde o nível de API 31, mas o framework nunca os revelava. O [PR #179219](https://github.com/flutter/flutter/pull/179219) encaminha esses raios das métricas de janela do engine até o `MediaQueryData`. Você os lê da mesma forma que lê o padding ou os view insets:

```dart
final BorderRadius? corners = MediaQuery.displayCornerRadiiOf(context);
```

O tipo de retorno é um `BorderRadius` anulável. Cada canto é um `Radius` em pixels lógicos, então ele se compõe diretamente com os widgets que você já usa. No Android abaixo da API 31, no iOS e em qualquer outra plataforma, o valor é `null`, então uma verificação de null é o seu caminho alternativo, não algo secundário.

## Recortando na curva do hardware

O uso óbvio é uma superfície em tela cheia cujo arredondamento combine com o vidro. Antes, você inventava um número. Agora, você pergunta à tela:

```dart
@override
Widget build(BuildContext context) {
  final BorderRadius radius =
      MediaQuery.displayCornerRadiiOf(context) ?? BorderRadius.circular(16);

  return ClipRRect(
    borderRadius: radius,
    child: ColoredBox(
      color: Theme.of(context).colorScheme.surface,
      child: content,
    ),
  );
}
```

Como `displayCornerRadii` é um `BorderRadius` de verdade, seus quatro cantos podem ser diferentes. Isso importa em dispositivos onde a curva inferior é mais fechada que a superior, ou onde uma dobradiça dá a uma borda um perfil diferente. Você também pode pegar um único canto quando precisa de apenas um:

```dart
final Radius topLeft =
    (MediaQuery.displayCornerRadiiOf(context) ?? BorderRadius.zero).topLeft;
```

## Pixels físicos quando você precisa

O `MediaQuery` fornece pixels lógicos, que é o que o código de layout quer. Se você trabalha no nível de pixel puro, por exemplo dentro de um `RenderObject` personalizado ou um shader, os mesmos dados ficam na view: `FlutterView.displayCornerRadii` retorna os valores em pixels físicos. Escolha o que combina com o espaço de coordenadas em que você está desenhando e evita uma multiplicação por `devicePixelRatio` que é fácil de inverter.

## Onde isso realmente compensa

A maioria dos aplicativos não precisa de correspondência de cantos perfeita ao pixel, e o `SafeArea` ainda cuida do caso comum de manter o conteúdo fora do notch. Isso é para as superfícies que se leem como parte do próprio dispositivo: bottom sheets que sobem até a borda do vidro, reprodutores de mídia imersivos, layouts de quiosque e as novas transições de retorno preditivo, que o Flutter 3.44 já conecta ao `displayCornerRadii` para que a tela que sai encolha em um retângulo corretamente arredondado.

O recurso é pequeno, mas fecha uma lacuna que forçava cada repasse de designer para desenvolvedor a terminar em um número adivinhado. Trate `null` como "assuma quadrado, recorra à sua própria constante" e o resto é só ler um valor que o sistema operacional guardava o tempo todo. Veja a [documentação de MediaQueryData.displayCornerRadii](https://api.flutter.dev/flutter/widgets/MediaQueryData/displayCornerRadii.html) para o contrato completo.
