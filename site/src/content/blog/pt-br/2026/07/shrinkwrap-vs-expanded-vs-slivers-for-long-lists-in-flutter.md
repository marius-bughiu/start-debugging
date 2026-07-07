---
title: "shrinkWrap vs Expanded vs slivers para listas longas no Flutter: qual escolher?"
description: "Para uma lista longa, nunca use shrinkWrap. Use Expanded quando a lista for o único scrollable, e slivers (CustomScrollView) quando ela compartilhar o scroll com outras seções. Aqui está o porquê, com um benchmark de contagem de builds."
pubDate: 2026-07-07
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "layout"
  - "listview"
  - "slivers"
lang: "pt-br"
translationOf: "2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-07
---

Para uma lista longa no Flutter, a classificação não é disputada: use `Expanded` quando a lista for o único scrollable sob um cabeçalho, e mude para slivers (um `CustomScrollView`) assim que a lista compartilhar o scroll com outras seções. Nunca recorra a `shrinkWrap: true` em uma lista longa. É o diff mais curto e silencia o erro de layout, mas também obriga a lista a construir cada item no primeiro frame, descartando a reciclagem preguiçosa que mantém um scroll a 60fps. Este artigo coloca as três em confronto no Flutter 3.x (testado no 3.44, Dart 3.x), com uma matriz de recursos, um benchmark de contagem de builds que mostra o custo exato, e o único detalhe que decide por você.

As três não são botões intercambiáveis do mesmo widget. `Expanded` e `shrinkWrap` são duas formas de responder "qual a altura deste `ListView` dentro de um `Column`?", enquanto os slivers substituem por completo o formato `Column` mais `ListView`. Elas colidem porque são as três respostas que as pessoas tentam quando um `ListView` dentro de um `Column` lança `Vertical viewport was given unbounded height`. Se essa asserção foi o que te trouxe aqui, a análise completa da causa raiz está em [como aninhar um ListView dentro de um Column sem um erro de altura não delimitada](/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/); este artigo é a pergunta mais afiada de qual solução manter depois que a tela vermelha some.

## A matriz de recursos

| Propriedade                                | `shrinkWrap: true` | `Expanded`          | Slivers (`CustomScrollView`) |
| ------------------------------------------ | ------------------ | ------------------- | ---------------------------- |
| Constrói só itens visíveis (lazy)          | Não, constrói tudo | Sim                 | Sim                          |
| Custo do primeiro frame para N itens       | O(N)               | O(viewport)         | O(viewport)                  |
| A memória escala com                       | contagem de itens  | tamanho do viewport | tamanho do viewport          |
| Funciona para lista não delimitada / que cresce | Não           | Sim                 | Sim                          |
| Precisa de altura de pai delimitada        | Não                | Sim (o pai precisa) | Sim (Scaffold dá)            |
| Várias seções scrollables em uma           | Briga consigo mesmo| Só uma lista        | Sim, nativo                  |
| Cabeçalho colapsável (`SliverAppBar`)      | Não                | Não                 | Sim                          |
| Linhas de boilerplate                      | 1                  | 3                   | ~6 por seção                 |

Leia primeiro as três linhas de cima. Elas são o argumento inteiro. `shrinkWrap` é a única das três cujo custo cresce com o número de itens, e "lista longa" é exatamente o caso onde esse custo morde.

## Por que shrinkWrap é O(N) e as outras duas não

Um `ListView` normal é um viewport preguiçoso: ele constrói e faz o layout só dos itens visíveis na sua janela mais uma pequena extensão de cache, e depois recicla esses widgets conforme você rola. Construa uma lista de 10.000 linhas e só ~15 linhas existem a qualquer momento. Essa preguiça é toda a história de desempenho das listas no Flutter.

`shrinkWrap: true` desliga isso. Para se dimensionar de acordo com o conteúdo (em vez de preencher o eixo), o viewport precisa saber sua altura total, e a única forma de saber isso é construir e medir cada filho antecipadamente. Então `shrinkWrap` converte uma lista preguiçosa em uma ansiosa: N itens significam N chamadas a build no primeiro frame, N layouts de `RenderBox`, e memória proporcional a N. Para as três linhas de configurações em que as pessoas costumam testá-lo, isso não é nada. Para um feed, é um travamento no primeiro frame que você pode ver na linha do tempo (veja [como perfilar o jank em um app Flutter com o DevTools](/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/)).

`Expanded` mantém a lista preguiçosa. É um filho de `Flex` que força uma altura ajustada igual ao espaço que sobra depois que o `Column` mede seus outros filhos. O `ListView` recebe um `maxHeight` delimitado, preenche exatamente essa janela e recicla linhas dentro dela. O custo é O(viewport), independente da contagem de itens.

Os slivers também mantêm a lista preguiçosa, por um mecanismo diferente: um `SliverList` nunca precisa saber sua altura total. Ele negocia diretamente com o viewport pai ("você está rolado até o offset X, vou pintar os filhos nessa faixa"), então não há handshake de altura não delimitada e nenhuma razão para construir filhos fora da tela. O custo é de novo O(viewport).

## O benchmark de contagem de builds

A forma mais limpa de medir isso não são milissegundos (que variam por máquina) mas o número de builds de itens no primeiro frame, que é determinístico e baseado no mecanismo. Instrumente cada item com um contador:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
int buildCount = 0;

Widget itemBuilder(BuildContext context, int index) {
  buildCount++;                 // increment on every item build
  return ListTile(title: Text('Row $index'));
}
```

Renderize uma lista de 5.000 itens de três formas e leia `buildCount` depois do primeiro frame (`WidgetsBinding.instance.addPostFrameCallback`). Os resultados não são disputados:

| Layout para 5.000 itens            | Builds de itens no primeiro frame | Escala com          |
| ---------------------------------- | --------------------------------- | ------------------- |
| `ListView(shrinkWrap: true)`       | 5.000                             | contagem de itens   |
| `Expanded(child: ListView)`        | ~12 a 15                          | só viewport         |
| `SliverList` em `CustomScrollView` | ~12 a 15                          | só viewport         |

O número exato no modo preguiçoso depende da altura da linha e do `cacheExtent` padrão (250 pixels lógicos além do viewport de cada lado), mas o formato é fixo: `shrinkWrap` constrói os 5.000, as outras duas constroem só o que cabe mais o cache. Em um Pixel 7 em modo profile o primeiro frame do `shrinkWrap` ultrapassou de longe o orçamento de 16ms construindo esses 5.000 tiles, enquanto as versões com `Expanded` e com slivers renderizaram o primeiro frame dentro do orçamento e ficaram lá durante a rolagem. O número que importa é a proporção: ~5.000 builds contra ~15, uma diferença que cresce toda vez que a lista cresce.

Para reproduzir isso você mesmo, execute em modo profile (`flutter run --profile`), não em debug, porque as medições em modo debug são dominadas por asserções e não são representativas. A proporção de contagem de builds é idêntica em todos os modos; só o tempo de relógio difere.

## Quando escolher Expanded

`Expanded` é a resposta certa quando a lista é a única região scrollable da tela, situada abaixo (ou acima) de algum chrome fixo.

- **Um cabeçalho sobre um feed, testado no Flutter 3.44.** Um título ou uma barra de busca em um `Column`, depois a lista preenche o resto. `Expanded` dá à lista toda a altura que sobra e a mantém preguiçosa.
- **Uma lista que cresce e encolhe com a tela.** Como `Expanded` divide o espaço disponível em vez de fixá-lo no código, a lista se adapta a diferentes alturas de dispositivo e configurações de escala de texto, ao contrário de um `SizedBox(height: ...)`.
- **Você quer o menor código que continue correto.** Três linhas, sem vocabulário de widget novo, preguiça completa. Para uma única lista isso ganha de recorrer a slivers.

O único requisito: o próprio `Column` precisa ter uma altura delimitada para que `Expanded` tenha algo para dividir. Dentro do body de um `Scaffold` ele tem. Se o `Column` estiver, por sua vez, em um contexto não delimitado, você só moveu o problema um nível acima.

```dart
// Flutter 3.x (tested 3.44)
Column(
  children: [
    const SearchBar(),
    Expanded(
      child: ListView.builder(       // stays lazy
        itemCount: items.length,
        itemBuilder: (context, i) => ItemTile(items[i]),
      ),
    ),
  ],
)
```

## Quando escolher slivers

Recorra a um `CustomScrollView` com slivers quando a lista longa não estiver sozinha: ela compartilha um scroll com outras seções, ou a tela precisa de um cabeçalho que role para fora de vista.

- **Duas ou mais seções scrollables em um scroll**, por exemplo uma lista que flui para uma grade. Esse caso é coberto de ponta a ponta em [como misturar um ListView e um GridView em um só scroll com slivers](/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/). Empilhar dois `ListView` em um `Column` e desativar seu physics é o antipadrão que os slivers existem para substituir.
- **Um cabeçalho colapsável ou flutuante.** `SliverAppBar` com `pinned`, `floating` ou `expandedHeight` é quase de graça uma vez que você já tem um `CustomScrollView`. Não há equivalente baseado em `Column`.
- **Um cabeçalho que deve rolar para fora junto com o conteúdo.** `SliverToBoxAdapter` envolve um widget de caixa isolado entre seções preguiçosas para que ele role para fora de forma natural.

```dart
// Flutter 3.x (tested 3.44)
CustomScrollView(
  slivers: [
    const SliverAppBar(title: Text('Explore'), floating: true),
    SliverList.builder(              // lazy, shares the one scroll position
      itemCount: items.length,
      itemBuilder: (context, i) => ItemTile(items[i]),
    ),
  ],
)
```

Os slivers são mais verbosos, cerca de seis linhas por seção em vez de três, e essa verbosidade é a única razão para não usá-los em uma lista solitária. Quando há exatamente um scrollable, `Expanded` dá a mesma preguiça com menos cerimônia.

## Quando shrinkWrap está realmente ok

`shrinkWrap: true` não é um bug, é uma ferramenta com um uso correto estreito: uma lista **curta e delimitada** cuja contagem de itens você controla e que precisa se dimensionar de acordo com o conteúdo para que outros widgets possam ficar acima e abaixo dela no mesmo `Column`.

- Uma tela de configurações com um punhado fixo de linhas.
- Um dropdown ou menu com um conjunto pequeno e conhecido de opções.
- Qualquer lista onde N é pequeno (um único dígito, dezenas baixas) e fixo por design, não por dados.

No momento em que N for impulsionado por dados que podem crescer (posts, fotos, resultados de busca, mensagens), `shrinkWrap` é a ferramenta errada, porque seu custo cresce com esses dados. Se você usá-lo para uma lista curta dentro de um `Column` scrollable, defina também `physics: const NeverScrollableScrollPhysics()` para que a lista interna não brigue com o `SingleChildScrollView` externo pelo gesto de scroll.

```dart
// Flutter 3.x (tested 3.44) -- fine ONLY because this list is short and fixed
Column(
  children: [
    const Text('Settings'),
    ListView(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      children: const [
        SwitchListTile(title: Text('Notifications'), value: true, onChanged: null),
        SwitchListTile(title: Text('Dark mode'), value: false, onChanged: null),
      ],
    ),
  ],
)
```

## O detalhe que decide por você

Duas restrições anulam a preferência por completo.

**Se a lista pode crescer sem limite, `shrinkWrap` está fora de cogitação.** Não é questão de gosto nem de alguns frames perdidos que você poderia tolerar. Um build ansioso não delimitado é um problema de correção e de memória: o tempo de build e a memória ambos escalam com a contagem de itens, então uma lista que está bem em testes com 20 linhas pode travar o primeiro frame por centenas de milissegundos em produção com 2.000. O framework não vai avisar você, porque `shrinkWrap` fez exatamente o que você pediu. Essa é a forma mais comum de uma lista Flutter regredir silenciosamente.

**Se você tem mais de uma seção scrollable, os slivers são a única resposta limpa.** `Expanded` cuida de exatamente uma lista. Duas listas com `Expanded` em um `Column` dividem a altura entre elas em dois scroll views separados, o que quase nunca é o que você quer. No instante em que você tem uma lista mais uma grade, ou uma lista mais outra lista, ou qualquer seção que deva rolar como uma única superfície com a lista, um `CustomScrollView` é o formato estruturalmente correto e todo o resto é um remendo.

Todo o resto, adaptabilidade de tela, boilerplate, um cabeçalho colapsável, é um desempate dentro dessas duas regras rígidas.

## A recomendação, reafirmada

Para uma lista longa, classifique-as: **slivers se a lista compartilha scroll com qualquer outra coisa, `Expanded` se é o único scrollable, e `shrinkWrap` nunca.** Mantenha `shrinkWrap: true` na sua caixa de ferramentas só para listas curtas e fixas que precisam se dimensionar de acordo com o conteúdo dentro de um `Column`. A armadilha é que as três fazem o erro de altura não delimitada desaparecer, então é fácil enviar aquela que também troca silenciosamente uma ruidosa asserção de layout por uma regressão de desempenho que só aparece sob dados reais. Leia a escolha como "como eu mantenho a lista preguiçosa?", e a resposta é sempre `Expanded` ou slivers, nunca `shrinkWrap`.

Se uma linha dentro de qualquer um desses um dia estourar a própria largura, esse é um problema à parte de [RenderFlex overflowed](/2026/05/fix-renderflex-overflowed-in-flutter/) no nível do tile, não relacionado à escolha de layout externa. E seja qual for o layout que você escolher, se ele usa um `ScrollController`, lembre-se de [liberá-lo](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) para não vazá-lo quando o widget for desmontado.

## Fontes

- [ListView class, Flutter API reference](https://api.flutter.dev/flutter/widgets/ListView-class.html) -- `shrinkWrap`, comportamento do viewport, e a nota explícita de que uma lista com shrink-wrap constrói todos os seus filhos.
- [Expanded class, Flutter API reference](https://api.flutter.dev/flutter/widgets/Expanded-class.html) -- fit de flex e como um `Column` divide o espaço restante.
- [CustomScrollView class, Flutter API reference](https://api.flutter.dev/flutter/widgets/CustomScrollView-class.html) -- hospedar vários slivers em um único viewport preguiçoso.
- [Using slivers to achieve fancy scrolling, Flutter docs](https://docs.flutter.dev/ui/layout/scrolling/slivers) -- o protocolo de slivers e como um viewport negocia a extensão de pintura.
- [Flutter docs: Understanding constraints](https://docs.flutter.dev/ui/layout/constraints) -- o modelo de altura delimitada vs não delimitada por trás de toda a comparação.
