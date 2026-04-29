---
title: "Flutter Text: o detalhe `leadingDistribution` que muda como sua UI \"respira\""
description: "A propriedade leadingDistribution dentro de TextHeightBehavior no Flutter controla como o leading extra é distribuído acima e abaixo dos glifos. Aqui está quando isso importa e como consertar texto que parece desalinhado verticalmente."
pubDate: 2026-01-18
tags:
  - "dart"
  - "flutter"
lang: "pt-br"
translationOf: "2026/01/flutter-text-the-leadingdistribution-detail-that-changes-how-your-ui-breathes"
translatedBy: "claude"
translationDate: 2026-04-29
---
Um vídeo tutorial de Flutter publicado em 2026-01-16 me lembrou de uma fonte sutil, mas bem real, de bugs do tipo "por que isso parece estranho?": o widget `Text` é simples até você começar a combinar fontes customizadas, alturas de linha apertadas e layouts em várias linhas.

Fonte: [Vídeo](https://www.youtube.com/watch?v=xen-Al9H-4k) e o [post original no r/FlutterDev](https://www.reddit.com/r/FlutterDev/comments/1qfhug1/how_well_do_you_really_know_the_text_widget/).

## Altura de linha não é só `TextStyle.height`

No Flutter 3.x, desenvolvedores costumam ajustar:

-   `TextStyle(height: ...)` para apertar ou afrouxar as linhas
-   `TextHeightBehavior(...)` para controlar como o leading é aplicado

Se você configurar só o `height`, ainda dá para acabar com texto que parece verticalmente "descentralizado" dentro de uma `Row`, ou com títulos que parecem largos demais comparados ao corpo do texto. É aí que entra `leadingDistribution`.

`leadingDistribution` controla como o leading extra (o espaço adicionado pela altura de linha) é distribuído acima e abaixo dos glifos. O valor padrão nem sempre é o que você quer para tipografia de UI.

## Um pequeno widget que deixa a diferença óbvia

Aqui está um snippet mínimo que você pode jogar numa tela para comparar visualmente:

```dart
import 'package:flutter/material.dart';

class LeadingDistributionDemo extends StatelessWidget {
  const LeadingDistributionDemo({super.key});

  @override
  Widget build(BuildContext context) {
    const style = TextStyle(
      fontSize: 20,
      height: 1.1, // intentionally tight so leading behavior is visible
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: const [
        Text('Default leadingDistribution', style: style),
        SizedBox(height: 8),
        Text(
          'Even leadingDistribution\n(two lines to show it)',
          style: style,
          textHeightBehavior: TextHeightBehavior(
            leadingDistribution: TextLeadingDistribution.even,
          ),
        ),
      ],
    );
  }
}
```

Quando você vê os dois blocos lado a lado, em fontes reais costuma dar para notar na hora: um bloco fica "melhor encaixado" no espaço vertical, principalmente quando você alinha com ícones ou quando limita a altura de um container.

## Onde isso morde em apps reais

Esse detalhe tende a aparecer nas partes de apps Flutter que são mais difíceis de manter pixel perfect:

-   **Botões e chips**: o texto do label parece baixo demais ou alto demais em relação ao container.
-   **Cards com conteúdo misto**: uma pilha de título + subtítulo não parece bem espaçada.
-   **Fontes customizadas**: as métricas de ascent/descent variam bastante entre tipos.
-   **Internacionalização**: scripts com métricas de glifo diferentes expõem suas suposições de espaçamento.

A correção não é "sempre configurar `leadingDistribution`". A correção é: quando você fizer limpeza de tipografia, inclua `TextHeightBehavior` no seu modelo mental, não só `fontSize` e `height`.

Se sua UI no Flutter 3.x está 95% pronta mas ainda parece um pouquinho estranha, essa é uma das primeiras chaves que eu verifico.
