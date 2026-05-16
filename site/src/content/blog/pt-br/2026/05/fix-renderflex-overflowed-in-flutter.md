---
title: "Correção: A RenderFlex overflowed by N pixels no Flutter"
description: "A correção em 30 segundos: envolva o filho que estourou em Expanded ou Flexible. Depois leia o resto para entender por que Row e Column não recortam, o que constraints sem limite significam e qual correção serve para cada layout."
pubDate: 2026-05-16
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "layout"
  - "renderflex"
lang: "pt-br"
translationOf: "2026/05/fix-renderflex-overflowed-in-flutter"
translatedBy: "claude"
translationDate: 2026-05-16
---

A correção em uma frase: envolva o filho que cresceu demais em largura (ou altura) em um `Expanded` ou `Flexible`, defina `mainAxisSize: MainAxisSize.min` no `Row` ou `Column` ao redor, ou envolva tudo em um `SingleChildScrollView` se o conteúdo realmente deve rolar. A faixa amarela e preta não é um bug de renderização, é o Flutter avisando que um filho sem limites dentro de um `Row`, `Column` ou `Flex` pediu mais espaço do que o pai conseguia dar.

```text
A RenderFlex overflowed by 124 pixels on the right.

The overflowing RenderFlex has an orientation of Axis.horizontal.
The edge of the RenderFlex that is overflowing has been marked in the rendering
with a yellow and black striped pattern. This is usually caused by the contents
being too big for the RenderFlex.

The relevant error-causing widget was:
  Row  lib/widgets/profile_header.dart:42
```

Este guia foi escrito contra o Flutter 3.27.1, Dart 3.11 e os widgets Material 3 conforme publicados no canal estável. Tudo aqui aplica-se sem mudanças desde o Flutter 3.10 e ao longo de toda a linha 3.x. A API de `Row`, `Column`, `Expanded`, `Flexible` e `Flex` não muda há anos; o `RenderFlex` subjacente está em `package:flutter/src/rendering/flex.dart` e é lá que a assertion é lançada.

## Por que Row e Column se recusam a recortar em silêncio

O Flutter faz layout em uma única passagem. Cada pai passa um objeto `BoxConstraints` para seus filhos, os filhos escolhem um tamanho que satisfaça essas constraints, e o pai os posiciona. A maioria dos widgets aceita o tamanho que o filho escolher, mas `Row`, `Column` e o widget `Flex` subjacente são diferentes: primeiro fazem o layout dos filhos não flexíveis usando seus tamanhos intrínsecos, depois dividem o espaço restante entre os filhos `Expanded` e `Flexible`. Se os filhos não flexíveis juntos excederem o espaço no eixo principal que o pai deu ao flex, não há nada a dividir e o layout está acima do orçamento.

O `RenderFlex` poderia recortar o estouro em silêncio, mas isso esconderia bugs de layout que só apareceriam no menor dispositivo da sua frota. Por isso, em modo debug o Flutter imprime a assertion, pinta o retângulo de aviso listrado sobre a borda que estourou, e continua renderizando. Em modo release a faixa some, mas o layout continua errado: texto é cortado, alvos de toque ficam fora da tela e leitores de tela leem conteúdo que o usuário não pode ver. Isso está documentado na [página de erros comuns do Flutter](https://docs.flutter.dev/testing/common-errors) e bate com o comentário no topo de [flex.dart no SDK do Flutter](https://github.com/flutter/flutter/blob/3.27.1/packages/flutter/lib/src/rendering/flex.dart).

## Uma reprodução mínima para colar em um app novo

```dart
// Flutter 3.27.1, Dart 3.11
import 'package:flutter/material.dart';

void main() => runApp(const MaterialApp(home: OverflowDemo()));

class OverflowDemo extends StatelessWidget {
  const OverflowDemo({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          children: [
            const Icon(Icons.message),
            const SizedBox(width: 8),
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text('Title', style: Theme.of(context).textTheme.headlineMedium),
                const Text(
                  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, '
                  'sed do eiusmod tempor incididunt ut labore et dolore '
                  'magna aliqua.',
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
```

Este é o caso canônico. O `Row` externo tem largura limitada pelo `Scaffold`, o `Icon` e o `SizedBox` são não flexíveis e pequenos, mas o `Column` interno também é não flexível e envolve um `Text` que quer ser tão largo quanto todo o parágrafo em uma única linha. Rode em qualquer layout de tamanho de celular e você vê o estouro na borda direita.

## Escolha a correção certa: Expanded, Flexible ou rolável

Há três correções corretas e elas não são intercambiáveis.

### Correção 1: envolva o filho voraz em `Expanded`

Use quando o filho deve consumir todo o espaço restante no eixo principal. Na reprodução, o filho voraz é o `Column`:

```dart
// Flutter 3.27.1, Dart 3.11
Row(
  children: [
    const Icon(Icons.message),
    const SizedBox(width: 8),
    Expanded(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text('Title', style: Theme.of(context).textTheme.headlineMedium),
          const Text(
            'Lorem ipsum dolor sit amet, consectetur adipiscing elit, '
            'sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
          ),
        ],
      ),
    ),
  ],
)
```

`Expanded` é `Flexible` com `flex: 1` e `fit: FlexFit.tight`. "Tight" significa que o filho deve preencher exatamente o espaço atribuído. Dentro de um `Row`, isso dá ao `Text` interno uma largura limitada, o que permite ao engine de texto quebrar em várias linhas. O estouro vai embora porque a largura intrínseca do `Text` não alimenta mais o cálculo de largura do `Row`.

Essa é a correção certa 80% das vezes. Use sempre que tiver um ícone inicial mais um corpo de texto em uma linha, ou um cabeçalho mais um corpo rolável em uma coluna. Veja a [referência da classe Expanded](https://api.flutter.dev/flutter/widgets/Expanded-class.html) para o contrato formal.

### Correção 2: envolva um filho em `Flexible` quando ele puder ser menor do que sua parte

`Flexible` usa por padrão `fit: FlexFit.loose`, que significa "você pode usar até este espaço, mas não é obrigado a preencher." Use quando tiver dois filhos que devem dividir o espaço restante proporcionalmente, mas nenhum precisa preencher sua alocação. O caso clássico são dois `TextField` igualmente importantes lado a lado, cada um ocupando metade da linha:

```dart
// Flutter 3.27.1, Dart 3.11
Row(
  children: [
    Flexible(child: TextField(decoration: const InputDecoration(labelText: 'First'))),
    const SizedBox(width: 8),
    Flexible(child: TextField(decoration: const InputDecoration(labelText: 'Last'))),
  ],
)
```

Se você usasse `Expanded` aqui, os campos ainda dividiriam a linha 50/50, mas se um deles fosse um `Chip` em vez de um `TextField`, `Expanded` esticaria a área do chip para preencher toda a largura, o que fica quebrado. `Flexible` com a largura natural do chip mantém o tamanho visual correto e ainda resolve o estouro.

A regra prática: `Expanded` para "preencha o que sobrou", `Flexible` para "você pode crescer até o que sobrou". Escolher errado entre os dois normalmente não causa estouro, só um widget feio e esticado.

### Correção 3: torne o eixo rolável quando o conteúdo realmente não couber

Estouros na parte inferior de um `Column` dentro da tela de um celular são quase sempre um sinal de que o usuário deve rolar. A correção não é `Expanded`, é colocar o `Column` dentro de um `SingleChildScrollView` (ou substituí-lo por um `ListView`):

```dart
// Flutter 3.27.1, Dart 3.11
Scaffold(
  body: SingleChildScrollView(
    padding: const EdgeInsets.all(16),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final section in sections) SectionCard(section),
      ],
    ),
  ),
)
```

Para uma lista longa com contagem de itens conhecida e filhos homogêneos, prefira `ListView.builder`, que constrói preguiçosamente apenas os itens na tela. Um `SingleChildScrollView` com um `Column` constrói cada filho a cada frame, o que é tudo bem para uma página de configurações com oito linhas mas é ruinoso para um feed de mil linhas. A [documentação de scrolling do Flutter](https://docs.flutter.dev/ui/layout/scrolling) traça essa linha claramente.

## Causa por causa: as quatro formas em que esse erro se infiltra

### Um widget `Text` dentro de um `Row` sem largura limitada

A causa mais comum, mostrada na reprodução acima. Strings longas, nomes de produto longos e strings de UI traduzidas (o alemão é notoriamente mais largo que o inglês) explodem `Row`s que funcionavam na máquina do desenvolvedor. Sempre envolva texto fornecido pelo usuário ou traduzido em `Expanded` ou `Flexible` quando estiver dentro de um `Row`. Se o texto deve ser truncado em vez de quebrar, adicione `overflow: TextOverflow.ellipsis` e `maxLines: 1` no próprio widget `Text`:

```dart
// Flutter 3.27.1, Dart 3.11
Row(
  children: [
    const Icon(Icons.person),
    const SizedBox(width: 8),
    Expanded(
      child: Text(
        user.fullName,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
    ),
  ],
)
```

### Eixo principal sem limites: um `Column` dentro de um `Column`, ou um `Row` dentro de um `Row`

Se um `Column` for filho de outro `Column`, o interno recebe altura sem limites. Qualquer coisa dentro dele que peça "o quanto eu quiser" recebe infinito, e o RenderFlex então reclama. A correção é envolver o `Column` interno em `Expanded`, ou definir `mainAxisSize: MainAxisSize.min` e colocar tudo dentro de um rolável.

O mesmo vale para um `Row` dentro de um `Row`, um `ListView` dentro de um `Column`, ou qualquer combinação em que o eixo principal não esteja limitado. Leia [Understanding constraints](https://docs.flutter.dev/ui/layout/constraints) uma vez e o resto deixa de ser surpreendente; explica o mantra "constraints go down, sizes go up, parent sets position" sobre o qual todo o sistema de layout funciona. A mesma propagação de constraints também causa jank em tempestades de redimensionamento, algo coberto em [como fazer profile de jank em um app Flutter com DevTools](/pt-br/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/).

### `width` ou `height` chumbado por um SizedBox ou Container

Um `SizedBox(width: 400)` dentro de um `Row` com largura de celular vai estourar à direita por `400 - rowWidth + remaining children` pixels. Esse é o único caso em que a correção não é `Expanded` e sim "pare de chumbar a largura". Use um layout adaptável: `Expanded`, `Flexible`, `FractionallySizedBox(widthFactor: 0.5)`, ou calcule o tamanho a partir de `MediaQuery.sizeOf(context)`.

O mesmo vale para imagens. Um `Image.network` sem constraint de largura reporta seu tamanho intrínseco, que pode ser 2000 pixels para um asset servido remotamente. Ou dê ao `Image` uma largura limitada (`Image.network(url, width: 64)`), ou envolva em um `Expanded`.

### Localização, escalonamento de fonte e tamanhos de texto de acessibilidade

Um `Row` que cabe perfeitamente na escala de fonte padrão vai estourar em 1.4x ou 2.0x. Esse é o bug que vai parar na App Store e ganha uma avaliação de uma estrela de um usuário com fontes grandes ativadas. Teste cada tela com overrides de `MediaQuery` nas escalas acessíveis:

```dart
// Flutter 3.27.1, Dart 3.11
MaterialApp(
  builder: (context, child) => MediaQuery(
    data: MediaQuery.of(context).copyWith(textScaler: const TextScaler.linear(1.5)),
    child: child!,
  ),
  home: const MyHomePage(),
)
```

`TextScaler` substitui a API mais antiga `textScaleFactor` a partir do Flutter 3.16 e é a forma suportada de testar o escalonamento de texto. Se o layout estourar sob esse wrapper de `MediaQuery`, vai estourar em dispositivos reais e a correção é a mesma: `Expanded`, `Flexible` ou rolável.

## Depurando qual widget está estourando

A assertion sempre nomeia um widget e uma localização no código fonte, mas a localização aponta para o `Row` ou `Column` que estourou, não para o filho que causou o problema. Três ferramentas ajudam a estreitar:

1. A faixa amarela e preta em modo debug diz a borda (direita, inferior, etc.), o que já restringe a busca.
2. Ative "Debug Paint" no Flutter Inspector (também disponível como `debugPaintSizeEnabled = true;` definido em `main`) para ver o contorno de cada render box. O filho voraz costuma se estender visivelmente para além do pai.
3. Use o modo de seleção de widgets do Inspector e clique na área culpada no simulador. O painel `RenderObject` do widget selecionado mostra seu tamanho e constraints. Compare com os do pai.

Para ferramentas mais a fundo, a mesma sessão do DevTools que você usa para trabalho de desempenho suporta depuração de layout na aba Layout Explorer. Se você não conhece esse fluxo, o post sobre [como fazer profile de jank em um app Flutter com DevTools](/pt-br/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) percorre como abrir o DevTools em modo profile contra um dispositivo real.

## Armadilhas e erros parecidos

- `Vertical viewport was given unbounded height` é o erro irmão quando um `ListView` vive dentro de um `Column` sem um `Expanded`. A correção tem a mesma forma: limite o filho ou torne o pai rolável. Não "corrija" definindo `shrinkWrap: true` no `ListView`; isso desliga a renderização preguiçosa e recria o estouro original em posições mais altas de rolagem.
- `RenderBox was not laid out` significa que uma assertion anterior de estouro do `RenderFlex` foi lançada e o pipeline de layout nunca chegou a calcular a geometria de paint. Suba no log de erros até a primeira mensagem de estouro; é ali que está o bug real.
- `BoxConstraints forces an infinite width` lançado pelo `Text` significa que o `Text` está dentro de algo que dá um eixo principal sem limite, normalmente um `Row` dentro de um `ListView` horizontal. Envolva o `Text` em um container de largura fixa ou use `Flexible`.
- `A RenderFlex overflowed by Infinity pixels` é a variante de constraint sem limite. A correção nunca é "diminuir o número", é "dar ao pai uma constraint limitada", tipicamente adicionando `Expanded` mais acima na árvore.
- Silenciar o aviso com `clipBehavior: Clip.hardEdge` no `Row` ou `Column` faz a faixa sumir mas deixa o bug de layout subjacente. Recorra ao recorte só quando provar que o estouro é intencional (por exemplo, uma marquise deliberadamente cortada).

## Relacionados

- [Como fazer profile de jank em um app Flutter com DevTools](/pt-br/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) cobre o setup do DevTools, que também é o seu depurador de layout mais rápido.
- [Como definir a cor de destaque em um app Flutter com Material 3 ColorScheme](/pt-br/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/) é onde a maior parte dos problemas de estouro de iniciantes começa, já que migrar para widgets M3 muda tamanhos intrínsecos.
- [Como adicionar código específico de plataforma no Flutter sem plugins](/pt-br/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) fica relevante quando você começa a esconder linhas em fatores de forma menores.
- [Como mirar em várias versões do Flutter a partir de um único pipeline de CI](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) importa porque a contagem exata de pixels na mensagem de estouro muda entre versões do SDK quando as métricas de texto mudam.

## Fontes

- [Erros comuns do Flutter -- A RenderFlex overflowed](https://docs.flutter.dev/testing/common-errors), a seção oficial dos docs do Flutter que define o erro e a correção canônica.
- [Understanding constraints](https://docs.flutter.dev/ui/layout/constraints), a explicação do protocolo de layout por trás de cada decisão de flex layout neste post.
- [Referência da classe Expanded](https://api.flutter.dev/flutter/widgets/Expanded-class.html), o doc de API que fixa `Expanded` como `Flexible(flex: 1, fit: FlexFit.tight)`.
- [Referência da classe Flexible](https://api.flutter.dev/flutter/widgets/Flexible-class.html), o doc de API que explica `FlexFit.loose` vs `FlexFit.tight`.
- [Referência da classe Row](https://api.flutter.dev/flutter/widgets/Row-class.html) e [referência da classe Column](https://api.flutter.dev/flutter/widgets/Column-class.html), que descrevem literalmente o algoritmo de dimensionamento no eixo principal.
- [flex.dart no tag 3.27.1](https://github.com/flutter/flutter/blob/3.27.1/packages/flutter/lib/src/rendering/flex.dart), a fonte onde a assertion de estouro é lançada.
