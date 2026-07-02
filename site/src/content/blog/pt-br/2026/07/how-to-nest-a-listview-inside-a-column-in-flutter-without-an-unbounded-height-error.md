---
title: "Como aninhar um ListView dentro de um Column no Flutter sem o erro de altura sem limites"
description: "Por que um ListView dentro de um Column lança 'Vertical viewport was given unbounded height', e as quatro soluções (Expanded, Flexible, shrinkWrap, SizedBox) com os trade-offs de desempenho que decidem qual você quer."
pubDate: 2026-07-02
tags:
  - "flutter"
  - "dart"
  - "layout"
  - "listview"
  - "constraints"
lang: "pt-br"
translationOf: "2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error"
translatedBy: "claude"
translationDate: 2026-07-02
---

Coloque um `ListView` diretamente dentro de um `Column` e o Flutter lança o erro antes de desenhar um único pixel: `Vertical viewport was given unbounded height`, geralmente seguido de uma parede de diagnósticos de `RenderBox`. A resposta curta: um `Column` entrega aos seus filhos um espaço vertical sem limites, e um `ListView` rolável se recusa a renderizar dentro de uma altura infinita porque não teria ideia de quão alto ser. Você resolve dando à lista uma altura limitada, e a ferramenta certa é quase sempre `Expanded` (preencher o espaço restante) quando a lista é a única rolável, ou `shrinkWrap: true` quando a lista é curta e finita. Este post explica por que o erro acontece, mostra a reprodução mínima e percorre as quatro soluções no Flutter 3.x (testado no 3.44) para que você escolha a que encaixa, não apenas a que silencia a exceção.

## Por que um Column dá altura sem limites aos seus filhos

O layout do Flutter funciona sobre uma única regra: as constraints descem, os tamanhos sobem. Um pai diz a cada filho a largura e a altura mínimas e máximas que ele pode ocupar, o filho escolhe um tamanho dentro desses limites, e o pai o posiciona. O framework inteiro é esse aperto de mãos repetido árvore abaixo.

Um `Column` é um widget `Flex` disposto ao longo do eixo vertical. Ao longo do seu eixo principal (vertical) ele **não** impõe uma altura máxima aos seus filhos não flexíveis. Ele diz a cada filho, com efeito, "seja tão alto quanto quiser, vou empilhá-lo e medir o total depois". Em termos de constraints o filho recebe `maxHeight: double.infinity`. É isso que "sem limites" (unbounded) significa: a constraint de altura recebida não tem um máximo finito.

A maioria dos widgets fica bem com isso. Um `Text`, um `Row`, um `Icon`, um `Container` com filhos: todos se dimensionam ao seu conteúdo, então um teto infinito nunca importa. Eles reportam de volta uma altura concreta e o `Column` a soma.

Um `ListView` é diferente. Ele é um viewport rolável, e o trabalho inteiro de um viewport é ser uma janela fixa sobre conteúdo que pode ser muito maior do que ele mesmo. Para isso ele precisa saber quão alta é a janela. Ao longo do seu eixo de rolagem (vertical) um `ListView` tenta se expandir para preencher toda a altura que lhe é oferecida. Ofereça a ele infinito e ele tentaria se tornar infinitamente alto, o que anula o propósito da rolagem e não pode ser disposto. Então, em vez de produzir silenciosamente um layout quebrado, o framework lança a asserção:

```
The following assertion was thrown during performResize():
Vertical viewport was given unbounded height.
Viewports expand in the scrolling direction to fill their container. In this
case, a vertical viewport was given an unlimited amount of vertical space in
which to expand.
```

Dito claramente: um `Column` diz "pegue toda a altura que quiser", um `ListView` diz "eu só funciono se você me disser exatamente quanta altura recebo", e os dois são incompatíveis até você inserir um widget que resolva a altura. Essa é a mesma família de falha que [RenderBox was not laid out](/pt-br/2026/06/fix-renderbox-was-not-laid-out-in-flutter/), onde uma constraint de tamanho ausente para o layout antes de pintar.

## A reprodução mínima

Aqui está o menor widget que reproduz isso. Nada exótico, apenas um cabeçalho empilhado sobre uma lista:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
class ProfilePage extends StatelessWidget {
  const ProfilePage({super.key});

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        const Text('Recent activity'),
        ListView(
          children: const [
            ListTile(title: Text('Item 1')),
            ListTile(title: Text('Item 2')),
            ListTile(title: Text('Item 3')),
          ],
        ),
      ],
    );
  }
}
```

Execute e você recebe a asserção de altura sem limites no momento em que essa subárvore faz o seu layout. O `Column` ofereceu ao `ListView` altura infinita; o `ListView` desistiu. Tudo o que segue é uma maneira de mudar qual altura o `ListView` recebe.

## Solução 1: Expanded, quando a lista deve preencher o espaço restante

Essa é a solução que você quer na maioria das vezes. `Expanded` é um filho flex que diz ao `Column` para dar a ele todo o espaço vertical que sobra depois que os filhos não flexíveis são medidos. Como "todo o espaço restante" é um número concreto assim que o `Column` conhece a sua própria altura, o `ListView` agora recebe um `maxHeight` limitado e faz o seu layout normalmente, mantendo a rolagem preguiçosa completa.

```dart
// Flutter 3.x (tested 3.44)
Column(
  children: [
    const Text('Recent activity'),
    Expanded(
      child: ListView(
        children: const [
          ListTile(title: Text('Item 1')),
          ListTile(title: Text('Item 2')),
          ListTile(title: Text('Item 3')),
        ],
      ),
    ),
  ],
)
```

A mecânica: `Expanded` define o fator flex do seu filho e força uma altura ajustada igual à sua parcela do espaço livre. O `Column` mede o `Text` primeiro, subtrai isso da sua própria altura, e entrega o resto ao `Expanded`, que o passa para baixo como uma constraint limitada. O `ListView` preenche exatamente essa janela e rola os seus filhos dentro dela. Essa é a escolha correta sempre que a lista for a região rolável principal da tela e você quiser que ela cresça e encolha com a altura disponível, que é o caso esmagadoramente comum (um cabeçalho sobre um feed, um campo de formulário sobre resultados, um título sobre um registro de chat).

Um requisito: o próprio `Column` precisa ter uma altura limitada para que `Expanded` tenha algo para dividir. Dentro do body de um `Scaffold`, um `SizedBox` com uma altura, ou qualquer pai que já limite o espaço vertical, ele tem. Se o `Column` estiver por sua vez dentro de outro contexto sem limites, você empurrou o mesmo problema um nível para cima e precisa limitar primeiro a caixa externa.

Se você quiser que a lista pegue o espaço restante mas também tenha permissão para encolher abaixo da sua parcela quando o conteúdo é pequeno, use `Flexible` em vez de `Expanded`. `Expanded` é `Flexible` com `fit: FlexFit.tight`; um `Flexible` puro usa `FlexFit.loose`, que significa "até isso, mas não mais do que o seu conteúdo precisa". Para um `ListView`, que quer preencher o seu eixo, os dois se comportam igual na prática, então prefira `Expanded` a menos que você tenha um layout misto onde a folga importe.

## Solução 2: shrinkWrap, quando a lista é curta e finita

Se a lista tem um número pequeno e mais ou menos conhecido de itens e você quer que ela seja exatamente tão alta quanto o seu conteúdo (para que o `Column` possa empilhar mais widgets abaixo dela), defina `shrinkWrap: true`:

```dart
// Flutter 3.x (tested 3.44)
Column(
  children: [
    const Text('Recent activity'),
    ListView(
      shrinkWrap: true,
      children: const [
        ListTile(title: Text('Item 1')),
        ListTile(title: Text('Item 2')),
        ListTile(title: Text('Item 3')),
      ],
    ),
    const Text('End of list'),
  ],
)
```

`shrinkWrap: true` inverte o comportamento do viewport: em vez de se expandir para preencher o seu eixo, ele mede todos os seus filhos, soma as suas alturas e se dimensiona a esse total. Agora ele reporta uma altura finita para cima ao `Column`, a asserção desaparece, e você pode colocar widgets tanto acima quanto abaixo dela.

O custo é real e vale a pena entender. Um `ListView` normal é preguiçoso: ele só constrói e faz o layout dos itens atualmente visíveis no viewport mais um pequeno cache. É isso que mantém uma lista de 10.000 linhas a 60fps. `shrinkWrap: true` descarta isso, porque para saber a sua altura total o viewport precisa construir e medir **todos** os seus filhos antecipadamente. Para um punhado de itens isso não é nada. Para uma lista longa ou sem limites significa construir milhares de widgets no primeiro frame, o que dispara o tempo de layout e causa o jank que você pode observar na timeline (veja [como perfilar o jank em um app Flutter com o DevTools](/pt-br/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/)). Uma lista com `shrinkWrap` também não rola independentemente no sentido usual; ela cresce para caber, e se o `Column` inteiro transbordar você está de volta a um aviso de [RenderFlex overflowed](/pt-br/2026/05/fix-renderflex-overflowed-in-flutter/). A regra prática: `shrinkWrap` é para listas curtas e limitadas (algumas linhas de configurações, um menu fixo), não para feeds.

Se você usar `shrinkWrap` e ainda assim quiser que o `Column` externo role quando tudo junto for alto demais, envolva o `Column` em um `SingleChildScrollView` e defina o `ListView` interno com `physics: const NeverScrollableScrollPhysics()` para que os dois roláveis não briguem:

```dart
// Flutter 3.x (tested 3.44)
SingleChildScrollView(
  child: Column(
    children: [
      const Text('Recent activity'),
      ListView(
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        children: const [
          ListTile(title: Text('Item 1')),
          ListTile(title: Text('Item 2')),
        ],
      ),
    ],
  ),
)
```

## Solução 3: SizedBox, quando você conhece a altura exata

Se a lista ocupa uma fatia fixa da tela, envolva-a em um `SizedBox` com uma altura concreta. Essa é a resposta mais direta ao erro: o `ListView` perguntou quão alto ele deveria ser, e você disse a ele.

```dart
// Flutter 3.x (tested 3.44)
Column(
  children: [
    const Text('Recent activity'),
    SizedBox(
      height: 240,
      child: ListView(
        children: const [
          ListTile(title: Text('Item 1')),
          ListTile(title: Text('Item 2')),
          ListTile(title: Text('Item 3')),
        ],
      ),
    ),
  ],
)
```

O `SizedBox` impõe `maxHeight: 240` sobre o `ListView`, que preenche esses 240 pixels lógicos e rola o seu conteúdo preguiçosamente dentro deles, mantendo o ganho de desempenho que `shrinkWrap` abre mão. Isso é correto para carrosséis horizontais (uma linha de cartões de altura fixa dentro de um `Column` vertical) e qualquer design onde a altura da lista seja uma constante deliberada. A desvantagem é o número mágico: alturas fixas não se adaptam a diferentes tamanhos de tela nem às configurações de escala de texto, então evite isso para uma lista que deve preencher o espaço que sobra. Para isso, `Expanded` é a versão adaptável da mesma ideia.

## Solução 4: troque o Column por um CustomScrollView com slivers

Quando o "column" é na verdade uma página que rola e que por acaso contém uma lista, a estrutura mais limpa não é um `Column` com um `ListView` aninhado de forma alguma. É um único `CustomScrollView` cujas seções são slivers. Um viewport, uma physics de rolagem, preguiça completa, sem conflitos de aninhamento:

```dart
// Flutter 3.x (tested 3.44)
CustomScrollView(
  slivers: [
    const SliverToBoxAdapter(
      child: Text('Recent activity'),
    ),
    SliverList.builder(
      itemCount: 3,
      itemBuilder: (context, index) => ListTile(
        title: Text('Item ${index + 1}'),
      ),
    ),
  ],
)
```

Um sliver é uma região rolável que negocia diretamente com o viewport pai sobre quanto ele pinta, então não há nenhum aperto de mãos de "altura sem limites" que possa falhar. `SliverToBoxAdapter` envolve widgets de caixa comuns (o seu cabeçalho) e `SliverList.builder` é a lista preguiçosa. Prefira isso quando uma tela tiver várias seções roláveis empilhadas, um cabeçalho que deva rolar para fora de vista, ou uma lista mais uma grade em uma rolagem contínua. É mais verboso do que um `Column`, mas é o layout que o Flutter realmente quer para essa forma, e nunca obriga você a escolher entre correção e preguiça.

## Qual solução eu uso de verdade

- **A lista é o conteúdo principal sob um cabeçalho, deve preencher a tela:** `Expanded`. Mantém a preguiça, se adapta a qualquer altura.
- **Alguns itens fixos, você quer widgets acima e abaixo no mesmo `Column`:** `shrinkWrap: true`. Barato porque a lista é curta.
- **A lista precisa de uma altura fixa específica (carrossel, mini-lista):** `SizedBox(height: ...)`. Mantém a preguiça, explícito e simples.
- **A tela inteira é uma rolagem com várias seções:** `CustomScrollView` com slivers. A resposta estruturalmente correta.

A armadilha a evitar é recorrer a `shrinkWrap: true` de forma reflexa porque é o diff mais curto. Ele faz o erro vermelho desaparecer, mas em uma lista longa ele troca silenciosamente uma asserção de layout barulhenta por uma regressão de desempenho silenciosa: cada linha construída no primeiro frame, frames perdidos ao carregar, e memória que escala com a quantidade de itens em vez do tamanho do viewport. Se a lista pode crescer, use `Expanded` ou slivers para que o framework possa continuar reciclando linhas. Notas de depuração relacionadas vivem em [Fix: RenderBox was not laid out](/pt-br/2026/06/fix-renderbox-was-not-laid-out-in-flutter/) e [Fix: A RenderFlex overflowed](/pt-br/2026/05/fix-renderflex-overflowed-in-flutter/), que são os dois erros que você mais provavelmente vai encontrar em seguida enquanto monta isso. E se a lista usa um `ScrollController`, lembre-se de [descartá-lo](/pt-br/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) para não vazá-lo quando o widget é desmontado.

## O modelo mental de uma linha para reter

Um `Column` dá altura sem limites; um `ListView` exige altura limitada. Cada solução acima é apenas uma maneira diferente de responder "quão alto?" -- `Expanded` diz "o que sobra", `SizedBox` diz "exatamente isto", `shrinkWrap` diz "tão alto quanto meus filhos", e os slivers dizem "deixe o viewport externo decidir". Assim que você lê o erro como "você esqueceu de dizer ao rolável a sua altura", a solução é óbvia toda vez.

## Fontes

- [Documentação do Flutter: Understanding constraints](https://docs.flutter.dev/ui/layout/constraints) -- o modelo "as constraints descem, os tamanhos sobem" e a caixa que decide limitado vs sem limites.
- [Classe ListView, referência da API do Flutter](https://api.flutter.dev/flutter/widgets/ListView-class.html) -- `shrinkWrap`, o comportamento do viewport, e a nota de desempenho sobre construir todos os filhos.
- [Classe Expanded, referência da API do Flutter](https://api.flutter.dev/flutter/widgets/Expanded-class.html) -- o fit flex e como o espaço restante é dividido em um `Column` ou `Row`.
- [Classe CustomScrollView, referência da API do Flutter](https://api.flutter.dev/flutter/widgets/CustomScrollView-class.html) -- combinar slivers em um único viewport.
