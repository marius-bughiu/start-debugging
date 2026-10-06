---
title: "Correção: BoxConstraints forces an infinite height no Flutter"
description: "Um widget pediu height: double.infinity dentro de um pai sem limite de altura, como um Column ou ListView. Use Expanded, uma altura finita, LimitedBox ou SliverFillRemaining no lugar."
pubDate: 2026-10-06
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "layout"
  - "constraints"
lang: "pt-br"
translationOf: "2026/10/fix-boxconstraints-forces-an-infinite-height-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-06
---

`BoxConstraints forces an infinite height` significa que algum widget pediu para ter exatamente `double.infinity` pixels de altura, e o pai dele não tinha um limite de altura para restringir esse pedido. Os culpados de sempre são `SizedBox(height: double.infinity)`, `Container(height: double.infinity)`, `SizedBox.expand` ou `BoxConstraints.expand()` colocados diretamente dentro de um `Column`, `ListView` ou `SingleChildScrollView`. A correção é parar de pedir "infinito" onde nada é finito: use `Expanded` dentro de um `Column`, dê à caixa um número real, envolva-a em um `LimitedBox` ou troque para `SliverFillRemaining` quando você quiser "preencher o resto da tela, mas ainda assim rolar". Tudo abaixo foi reproduzido com Flutter 3.44.8 (stable) e Dart 3.12.2.

O que confunde é que `height: double.infinity` é um idioma perfeitamente normal. Funciona na maioria das vezes. Ele só explode quando o ancestral mais próximo que define a restrição de altura diz "escolha a altura que quiser", e é exatamente isso que colunas e scroll views dizem.

## O erro em contexto

Este é o primeiro bloco que o Flutter imprime. Eu reduzi o stack trace, que tem cerca de 100 frames de `RenderProxyBoxMixin.performLayout`:

```
══╡ EXCEPTION CAUGHT BY RENDERING LIBRARY ╞═══════════════════════════════
The following assertion was thrown during performLayout():
BoxConstraints forces an infinite height.
These invalid constraints were provided to _RenderColoredBox's layout() function by the following
function, which probably computed the invalid constraints in question:
  RenderConstrainedBox.performLayout (package:flutter/src/rendering/proxy_box.dart:296:14)
The offending constraints were:
  BoxConstraints(0.0<=w<=800.0, h=Infinity)
The relevant error-causing widget was:
  SizedBox
```

Três linhas trazem toda a informação de que você precisa:

- **`h=Infinity`** nas restrições problemáticas. Essa é uma altura infinita *tight* (rígida): mínimo e máximo são ambos infinito. Nada consegue satisfazer isso.
- **`RenderConstrainedBox.performLayout`** é a função que calculou isso. `RenderConstrainedBox` é o render object por trás de `SizedBox`, `ConstrainedBox` e da parte de dimensionamento do `Container`. Então o culpado é quase sempre um desses três.
- **"The relevant error-causing widget was"** informa o arquivo e a linha desse widget. Clique nela na sua IDE.

Abaixo desse bloco você verá uma cascata de assertions `RenderBox was not laid out`, uma por ancestral, mais uma do `Scaffold`. Isso é consequência. Corrija o primeiro erro e todas elas desaparecem. Se você chegou aqui por essa cascata, o [passo a passo de RenderBox was not laid out](/pt-br/2026/06/fix-renderbox-was-not-laid-out-in-flutter/) explica por que ela se acumula assim.

A mensagem irmã `BoxConstraints forces an infinite width.` é o mesmo bug girado em 90 graus, e `BoxConstraints forces an infinite width and infinite height.` são os dois ao mesmo tempo. Tudo neste post vale para elas, trocando largura e altura.

## Por que isso acontece

O layout do Flutter segue uma regra: as restrições descem, os tamanhos sobem, o pai define a posição. Todo pai entrega ao filho um `BoxConstraints` com mínimo e máximo para largura e altura.

Quando você escreve `SizedBox(height: double.infinity)`, você não está definindo a altura como infinito. Você está pedindo restrições tight de `minHeight: infinity, maxHeight: infinity`, e o `RenderConstrainedBox` então concilia esse pedido com o que o próprio pai dele permitiu, usando `BoxConstraints.enforce`:

```dart
// Flutter 3.44.8, package:flutter/src/rendering/box.dart (simplified)
BoxConstraints enforce(BoxConstraints constraints) {
  return BoxConstraints(
    minHeight: clampDouble(minHeight, constraints.minHeight, constraints.maxHeight),
    maxHeight: clampDouble(maxHeight, constraints.minHeight, constraints.maxHeight),
    // width is clamped the same way
  );
}
```

Esse clamp é o motivo de o idioma normalmente funcionar. Dentro do body de um `Scaffold`, o pai diz `0 <= h <= 600`, então o infinito é limitado a 600 e a caixa preenche a tela. Mas um `Column` entrega a cada filho não flex `0 <= h <= Infinity` no eixo principal, e um `ListView` vertical ou `SingleChildScrollView` faz o mesmo. Limitar o infinito a um máximo de infinito resulta em infinito. As restrições resultantes são passadas ao `layout()` do filho, que executa `debugAssertIsValid(isAppliedConstraint: true)`, encontra um mínimo infinito e lança o erro.

Então a regra para lembrar: **`double.infinity` significa "tão grande quanto meu pai permitir". Só é seguro quando o pai permite algo finito.**

## Um repro mínimo para colar em um app novo

Cada um destes três bodies lança o erro no Flutter 3.44.8. Eu os executei como widget tests dentro de `MaterialApp(home: Scaffold(body: ...))`:

```dart
// Flutter 3.44.8, Dart 3.12.2
import 'package:flutter/material.dart';

// 1. A Column gives children unbounded height.
const columnRepro = Column(
  children: [
    Text('Header'),
    SizedBox(
      height: double.infinity,
      child: ColoredBox(color: Colors.red),
    ),
  ],
);

// 2. A vertical ListView gives children unbounded height.
final listRepro = ListView(
  children: [
    Container(height: double.infinity, color: Colors.red),
  ],
);

// 3. SizedBox.expand and BoxConstraints.expand() are the same request in disguise.
const scrollRepro = SingleChildScrollView(
  child: Column(
    children: [
      SizedBox.expand(child: ColoredBox(color: Colors.red)),
    ],
  ),
);
```

As restrições problemáticas diferem um pouco: o repro do `Column` reporta `BoxConstraints(0.0<=w<=800.0, h=Infinity)` porque o eixo transversal de uma coluna é loose, enquanto os repros de `ListView` e `SizedBox.expand` reportam `BoxConstraints(w=800.0, h=Infinity)`. Mesmo bug, mesma correção.

Um detalhe que induz ao erro: se o `SizedBox` **não tem filho**, você não recebe essa mensagem. Você recebe `RenderConstrainedBox object was given an infinite size during layout`, porque não há filho em que chamar `layout()` e a caixa tenta dimensionar a si mesma para infinito. Mesma causa, texto diferente.

## Correção, em detalhe

Escolha a correção perguntando o que você realmente queria que a altura infinita fizesse.

### 1. "Preencher o espaço restante no Column": use Expanded

Esta é a intenção mais comum. Dentro de um `Column`, a forma de dizer "pegue o que sobrou" é um filho flex, não um tamanho infinito:

```dart
// Flutter 3.44.8, Dart 3.12.2
Column(
  children: [
    const Text('Header'),
    Expanded(
      child: Container(color: Colors.red), // no height at all
    ),
  ],
)
```

No meu teste com uma superfície de 800x600, a caixa vermelha ficou com `Size(800.0, 580.0)`: a altura total menos a linha do cabeçalho. `Expanded` funciona porque o `Column` faz o layout dos filhos flex por último, depois de saber quanto espaço os filhos fixos usaram, e passa a eles uma altura tight e finita.

Isso só funciona quando o próprio `Column` tem altura limitada. Se esse `Column` estiver dentro de um `SingleChildScrollView`, o `Expanded` troca este erro por `RenderFlex children have non-zero flex but incoming height constraints are unbounded`. É o mesmo problema um nível acima, e as correções 3 e 4 resolvem isso.

### 2. "Eu só quero que seja alto": dê a ele um número finito

Se a caixa está dentro de uma scroll view, ela vai rolar, então "preencher a tela" geralmente não é o que você queria dizer. Dê uma altura real ou derive uma da tela:

```dart
// Flutter 3.44.8, Dart 3.12.2
Builder(
  builder: (context) => ListView(
    children: [
      SizedBox(
        height: MediaQuery.sizeOf(context).height * 0.5,
        child: const ColoredBox(color: Colors.red),
      ),
      // ... more children
    ],
  ),
)
```

Isso produziu uma caixa `Size(800.0, 300.0)` em uma superfície de 600 pixels de altura. Prefira `MediaQuery.sizeOf(context)` a `MediaQuery.of(context).size`: ele só reconstrói quando o tamanho muda, não a cada mudança de `MediaQuery`, como os insets do teclado.

Se o widget é reutilizável e você não sabe se ele vai parar em um pai limitado ou ilimitado, use `LimitedBox`. Ele não faz nada quando o pai é limitado e define um teto para o máximo quando o pai não é:

```dart
// Flutter 3.44.8, Dart 3.12.2
ListView(
  children: [
    LimitedBox(
      maxHeight: 200,
      child: Container(height: double.infinity, color: Colors.red),
    ),
  ],
)
```

Dentro do `ListView`, esse container fez o layout com `Size(800.0, 200.0)` sem erro. Coloque o mesmo widget em um pai limitado e ele preenche o pai. Esse é o padrão que o guia oficial "Understanding constraints" recomenda para exatamente esta situação.

### 3. "Preencher a tela, mas rolar se o conteúdo for mais alto": SliverFillRemaining

Este é o caso do formulário de login: uma coluna que deve se esticar até o fim do viewport para que um botão fique embaixo, mas que role em celulares pequenos ou quando o teclado está aberto. `SliverFillRemaining` com `hasScrollBody: false` é o widget feito para isso:

```dart
// Flutter 3.44.8, Dart 3.12.2
CustomScrollView(
  slivers: [
    const SliverToBoxAdapter(child: SizedBox(height: 100)),
    SliverFillRemaining(
      hasScrollBody: false,
      child: Container(color: Colors.red),
    ),
  ],
)
```

A caixa vermelha recebeu `Size(800.0, 500.0)`: exatamente o viewport menos o cabeçalho de 100 pixels. `hasScrollBody: false` diz ao sliver que o filho dele não é um scrollable, então ele dimensiona o filho para pelo menos a extensão restante, e para a altura do próprio filho se ela for maior. Se o filho for um `ListView` ou outra scroll view, deixe `hasScrollBody` no valor padrão `true`.

### 4. A mesma coisa sem slivers: LayoutBuilder mais ConstrainedBox

Se você não está pronto para migrar uma tela para `CustomScrollView`, a documentação de `SingleChildScrollView` descreve um padrão que lê a altura do viewport uma vez e a transforma em um *mínimo* em vez de um tamanho infinito tight:

```dart
// Flutter 3.44.8, Dart 3.12.2
LayoutBuilder(
  builder: (context, viewport) => SingleChildScrollView(
    child: ConstrainedBox(
      constraints: BoxConstraints(minHeight: viewport.maxHeight),
      child: IntrinsicHeight(
        child: Column(
          children: [
            const Text('top'),
            Expanded(child: Container(color: Colors.red)),
            const Text('bottom'),
          ],
        ),
      ),
    ),
  ),
)
```

O `LayoutBuilder` fica fora da scroll view, então `viewport.maxHeight` é finito (600 aqui). O `ConstrainedBox` dá à coluna um piso de 600, mas nenhum teto, e o `IntrinsicHeight` dá ao `Column` uma altura limitada, tornando o `Expanded` válido. Meu teste produziu uma caixa vermelha de 560 pixels entre as duas linhas de texto. `IntrinsicHeight` custa uma passada extra de layout sobre a subárvore, o que é aceitável para um formulário e errado para uma lista longa. Para conteúdo longo, use a correção 3 ou as opções em [shrinkWrap vs Expanded vs slivers](/pt-br/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/).

### 5. "Igualar a altura da linha": IntrinsicHeight mais stretch

Uma fonte muito comum desse erro dentro de listas é uma barra lateral colorida ou um divisor vertical que deveria ter a mesma altura do vizinho:

```dart
// Flutter 3.44.8, Dart 3.12.2
// Throws: BoxConstraints(w=4.0, h=Infinity)
ListView(
  children: const [
    Row(
      children: [
        SizedBox(width: 4, height: double.infinity, child: ColoredBox(color: Colors.blue)),
        Text('item'),
      ],
    ),
  ],
)
```

O `Row` passa a própria restrição vertical ilimitada para a barra. Peça à linha para medir primeiro o filho mais alto e depois estique tudo para igualar:

```dart
// Flutter 3.44.8, Dart 3.12.2
ListView(
  children: const [
    IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(width: 4, child: ColoredBox(color: Colors.blue)),
          Text('item\nline2'),
        ],
      ),
    ),
  ],
)
```

Nenhum `height` na barra: `CrossAxisAlignment.stretch` dá a ela uma altura tight igual à da linha, e `IntrinsicHeight` torna essa altura finita. Um `IntrinsicHeight` por item de lista é barato o bastante para listas típicas.

## Pegadinhas e erros parecidos

- **`double.maxFinite` não é uma correção.** Trocar `double.infinity` por `double.maxFinite` silencia a assertion, mas no meu teste a caixa fez o layout com `Size(0.0, 1.7976931348623157e+308)`. Você construiu uma caixa mais alta que o universo, e tudo abaixo dela fica inalcançável. Se você encontrar essa "correção" em um code review, é o mesmo bug, disfarçado.
- **A verificação existe só em debug.** `debugAssertIsValid` roda dentro de um `assert`, então builds de release a ignoram e você recebe uma área cinza ou conteúdo ausente em vez de uma tela vermelha. Sempre reproduza bugs de layout em modo debug.
- **Um `ListView` horizontal funciona.** `ListView(scrollDirection: Axis.horizontal)` dá aos filhos uma *altura* limitada (a dele própria), então `height: double.infinity` dentro dele é limitado corretamente: meu teste resultou em `Size(100.0, 600.0)`. Nessa lista, quem quebra é `width: double.infinity`.
- **`Vertical viewport was given unbounded height`** é a situação inversa: um scrollable colocado dentro de um `Column`, em vez de uma caixa infinita colocada dentro de um scrollable. As correções se sobrepõem, e o [guia de ListView dentro de um Column](/pt-br/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/) cobre esse caso em profundidade.
- **`TextField` dentro de um `Row`** produz `An InputDecorator, which is typically created by a TextField, cannot have an unbounded width` como primeiro erro no Flutter 3.44.8, não a mensagem de `BoxConstraints`. Envolva o campo em um `Expanded` ou em um `SizedBox` de largura fixa.
- **`IntrinsicHeight` em volta de um `ListView`** não lança este erro. Ele lança `RenderViewport does not support returning intrinsic dimensions`, porque um viewport preguiçoso se recusa a medir todos os seus filhos. Nunca envolva um scrollable em um widget intrinsic.
- **`UnconstrainedBox`** remove por completo as restrições do pai, então qualquer filho infinito dentro dele lança este erro mesmo em uma tela limitada. Coloque um `LimitedBox` entre eles ou remova o `UnconstrainedBox`.
- **Um `Column` que estoura em vez de lançar erro** é um problema diferente: o conteúdo é finito, mas alto demais. Veja o [guia de RenderFlex overflowed](/pt-br/2026/05/fix-renderflex-overflowed-in-flutter/).

## Encontrando o culpado em uma árvore de widgets grande

Quando o "relevant error-causing widget" aponta para um componente compartilhado, abra o Flutter DevTools, selecione o widget no Widget Inspector e observe as restrições mostradas no Layout Explorer. Suba pela árvore até encontrar o primeiro ancestral cuja restrição de altura é `Infinity`: esse é o `Column`, `ListView`, `Row` ou `UnconstrainedBox` que removeu o limite. A correção vai ou nesse ancestral (limitá-lo) ou no filho (parar de pedir infinito). Buscar no seu código por `double.infinity`, `.expand(` e `BoxConstraints.expand` normalmente encontra o candidato em menos de um minuto.

## Relacionados

- [Correção: RenderBox was not laid out no Flutter](/pt-br/2026/06/fix-renderbox-was-not-laid-out-in-flutter/), a cascata que vem depois deste erro.
- [Como aninhar um ListView dentro de um Column sem erro de altura ilimitada](/pt-br/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/).
- [shrinkWrap vs Expanded vs slivers para listas longas no Flutter](/pt-br/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/).
- [Correção: A RenderFlex overflowed no Flutter](/pt-br/2026/05/fix-renderflex-overflowed-in-flutter/).
- [Correção: RenderViewport expected a RenderSliver em um CustomScrollView](/pt-br/2026/07/fix-renderviewport-expected-a-rendersliver-in-a-flutter-customscrollview/), se você esbarrar nele ao migrar para `SliverFillRemaining`.

## Fontes

- [Understanding constraints](https://docs.flutter.dev/ui/layout/constraints) (documentação do Flutter), incluindo os exemplos de `LimitedBox` e `UnconstrainedBox`.
- [Common Flutter errors](https://docs.flutter.dev/testing/common-errors) (documentação do Flutter).
- [BoxConstraints.enforce](https://api.flutter.dev/flutter/rendering/BoxConstraints/enforce.html) e [BoxConstraints.debugAssertIsValid](https://api.flutter.dev/flutter/rendering/BoxConstraints/debugAssertIsValid.html) (referência da API).
- [SingleChildScrollView](https://api.flutter.dev/flutter/widgets/SingleChildScrollView-class.html), a seção "Centering, spacing, or aligning fixed-height content".
- [SliverFillRemaining](https://api.flutter.dev/flutter/widgets/SliverFillRemaining-class.html) e [LimitedBox](https://api.flutter.dev/flutter/widgets/LimitedBox-class.html) (referência da API).
- `packages/flutter/lib/src/rendering/box.dart` e `proxy_box.dart` no SDK do Flutter 3.44.8, lidos localmente.
