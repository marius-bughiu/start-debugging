---
title: "Como misturar um ListView e um GridView em uma única área de rolagem com slivers no Flutter"
description: "Coloque uma lista e uma grade em uma única rolagem contínua sem scrollables aninhados. Use CustomScrollView com SliverList e SliverGrid, e evite a armadilha do shrinkWrap que arruína o desempenho silenciosamente."
pubDate: 2026-07-02
tags:
  - "flutter"
  - "dart"
  - "layout"
  - "slivers"
  - "listview"
lang: "pt-br"
translationOf: "2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-02
---

Você quer uma tela onde uma lista flui direto para uma grade (ou o contrário) e o conjunto todo rola como um só. O instinto errado é empilhar um `ListView` e um `GridView` em uma `Column` e recorrer a `shrinkWrap: true` para fazê-los caber. Isso compila, mas constrói cada item de antemão e deixa você com duas posições de rolagem brigando uma com a outra. A resposta certa é um único `CustomScrollView` cujas seções são slivers: `SliverList` para a parte da lista, `SliverGrid` para a parte da grade, `SliverToBoxAdapter` para qualquer widget comum no meio. Um viewport, uma física de rolagem, preguiça total. Este post mostra o layout funcional no Flutter 3.x (testado no 3.44, Dart 3.x), explica por que a versão ingênua é lenta, e cobre os detalhes de espaçamento, padding e cross-axis-count que costumam tropeçar as pessoas.

## Por que você não pode simplesmente empilhar dois scrollables

Um `ListView` e um `GridView` são ambos viewports roláveis. Cada um tem sua própria posição de rolagem e espera receber uma altura limitada para saber quão alta é a sua janela. Coloque os dois em uma `Column` e você bate na mesma parede descrita em [como aninhar um ListView dentro de uma Column sem erro de altura ilimitada](/pt-br/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/): a `Column` oferece a cada filho espaço vertical ilimitado, e um scrollable se recusa a fazer layout no infinito.

O remendo habitual é `shrinkWrap: true` em ambos, envoltos em um `SingleChildScrollView`:

```dart
// Flutter 3.x (tested 3.44) -- the anti-pattern, do not ship this
SingleChildScrollView(
  child: Column(
    children: [
      ListView.builder(
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        itemCount: posts.length,
        itemBuilder: (context, i) => PostTile(posts[i]),
      ),
      GridView.builder(
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
          crossAxisCount: 2,
        ),
        itemCount: photos.length,
        itemBuilder: (context, i) => PhotoTile(photos[i]),
      ),
    ],
  ),
)
```

Isso renderiza, e para uma dúzia de itens está tudo bem. Mas `shrinkWrap: true` força cada scrollable a construir e medir cada um dos seus filhos no primeiro frame para poder reportar uma altura finita. Você jogou fora a reciclagem preguiçosa que mantém as listas do Flutter suaves. Em um feed de algumas centenas de fotos, isso são centenas de widgets construídos antes da primeira pintura, um pico que você consegue ver na timeline (veja [como fazer profiling de jank em um app Flutter com o DevTools](/pt-br/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/)). Pior, agora você tem três scroll views (o `SingleChildScrollView` externo mais os dois internos que você teve que desativar com `NeverScrollableScrollPhysics`) todos presentes só para que um deles possa de fato rolar. É o formato errado para o problema.

## O que é um sliver, em um parágrafo

Um sliver é uma região rolável que conversa diretamente com um viewport pai sobre quanto de si mesma está visível no momento e quanto pintar. Em vez de "aqui está minha altura total, me dê uma janela", um sliver diz "você rolou até o offset X com um viewport de altura H, então vou fazer o layout de exatamente os filhos que caem nesse intervalo". Esse protocolo é o que torna um `SliverList` preguiçoso: ele nunca precisa saber sua própria altura total, então não há aperto de mão de altura ilimitada para falhar e nenhuma necessidade de construir filhos fora da tela. Um `CustomScrollView` é um viewport que hospeda uma lista desses slivers e rola por todos eles como uma única superfície contínua. Como cada seção é um sliver, elas compartilham a única posição de rolagem do seu pai, que é exatamente o comportamento que você queria.

## O layout funcional: SliverList e depois SliverGrid

Aqui está tudo. Um cabeçalho, uma seção de lista e uma seção de grade, em uma única rolagem:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
class FeedPage extends StatelessWidget {
  const FeedPage({super.key, required this.posts, required this.photos});

  final List<Post> posts;
  final List<Photo> photos;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: CustomScrollView(
        slivers: [
          const SliverToBoxAdapter(
            child: Padding(
              padding: EdgeInsets.all(16),
              child: Text('Latest posts',
                  style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
            ),
          ),
          SliverList.builder(
            itemCount: posts.length,
            itemBuilder: (context, index) => PostTile(posts[index]),
          ),
          const SliverToBoxAdapter(
            child: Padding(
              padding: EdgeInsets.all(16),
              child: Text('Photos',
                  style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
            ),
          ),
          SliverGrid.builder(
            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: 3,
              mainAxisSpacing: 8,
              crossAxisSpacing: 8,
              childAspectRatio: 1,
            ),
            itemCount: photos.length,
            itemBuilder: (context, index) => PhotoTile(photos[index]),
          ),
        ],
      ),
    );
  }
}
```

Role a tela e a lista flui para a grade como uma única superfície. Ambas as seções são preguiçosas: apenas os tiles dentro do viewport (mais um pequeno cache) são construídos, não importa quantos posts ou fotos você tenha. Há uma única posição de rolagem, então um arremesso iniciado na lista atravessa até a grade sem emenda.

Três tipos de sliver estão fazendo o trabalho aqui, e são os três que você vai usar para quase tudo:

1. **`SliverToBoxAdapter`** envolve qualquer widget de caixa comum (um cabeçalho, um banner, um divisor) para que ele possa ficar em uma lista de slivers. Ele constrói seu filho de forma ansiosa, o que é correto para um único widget pequeno mas errado para uma lista longa, então nunca coloque um `ListView` ou uma `Column` grande dentro de um. Use-o para widgets avulsos entre suas seções preguiçosas.
2. **`SliverList.builder`** é a lista preguiçosa. A mesma API `itemCount` / `itemBuilder` que você conhece do `ListView.builder`, menos o viewport, porque o `CustomScrollView` que o envolve é o viewport agora.
3. **`SliverGrid.builder`** é a grade preguiçosa. Ela recebe um `gridDelegate` que controla as colunas, exatamente como o `GridView.builder`.

## Controlando as colunas da grade

O `gridDelegate` é onde você decide quantas colunas a grade tem e como os tiles são espaçados. Dois delegates cobrem quase todos os casos.

`SliverGridDelegateWithFixedCrossAxisCount` fixa um número fixo de colunas. Use-o quando a quantidade é uma decisão de design ("sempre 3 por linha"):

```dart
// Flutter 3.x (tested 3.44)
gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
  crossAxisCount: 3,   // exactly 3 columns
  mainAxisSpacing: 8,  // vertical gap between rows
  crossAxisSpacing: 8, // horizontal gap between columns
  childAspectRatio: 1, // width / height of each tile; 1 = square
),
```

`SliverGridDelegateWithMaxCrossAxisExtent`, em vez disso, limita a largura de cada tile e deixa o Flutter calcular a quantidade de colunas a partir da largura disponível. Esta é a escolha responsiva: um celular recebe 2 colunas, um tablet recebe 5, sem um `LayoutBuilder`:

```dart
// Flutter 3.x (tested 3.44)
gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
  maxCrossAxisExtent: 180, // each tile is at most 180px wide
  mainAxisSpacing: 8,
  crossAxisSpacing: 8,
  childAspectRatio: 1,
),
```

A frustração mais comum com grades são tiles que parecem esticados ou espremidos, e a causa é quase sempre o `childAspectRatio`. É a largura dividida pela altura. O padrão é `1.0` (quadrado). Se os seus tiles de foto são mais altos do que largos, reduza a proporção para abaixo de 1 (por exemplo `0.75` para um card retrato 3:4); se são mais largos, aumente para acima de 1. Um descompasso de `childAspectRatio` não lança erro, ele apenas distorce silenciosamente cada tile, então vale a pena defini-lo deliberadamente em vez de deixar no padrão.

## Adicionando padding sem quebrar a preguiça

Envolver um sliver em um widget `Padding` comum não funciona, porque `Padding` espera um filho de caixa, não um sliver. O equivalente em sliver é `SliverPadding`:

```dart
// Flutter 3.x (tested 3.44)
SliverPadding(
  padding: const EdgeInsets.symmetric(horizontal: 16),
  sliver: SliverGrid.builder(
    gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
      crossAxisCount: 3,
      mainAxisSpacing: 8,
      crossAxisSpacing: 8,
    ),
    itemCount: photos.length,
    itemBuilder: (context, index) => PhotoTile(photos[index]),
  ),
)
```

Note o parâmetro `sliver:`, não `child:`. `SliverPadding` insere um recuo em um sliver e permanece preguiçoso. Recorra a ele sempre que uma seção precisa de espaço em relação às bordas da tela; envolver todo o corpo do `CustomScrollView` em um único `Padding` grande cortaria a matemática de espaçamento da grade e é a camada errada para adicionar margens.

## Um cabeçalho de rolagem que recolhe

Como você já tem um `CustomScrollView`, adicionar um `SliverAppBar` que expande e recolhe conforme você rola é praticamente de graça. Este é o motivo clássico pelo qual as pessoas migram para slivers em primeiro lugar:

```dart
// Flutter 3.x (tested 3.44)
CustomScrollView(
  slivers: [
    const SliverAppBar(
      title: Text('Explore'),
      floating: true,      // reappears as soon as you scroll up
      expandedHeight: 160,
      flexibleSpace: FlexibleSpaceBar(
        background: ColoredBox(color: Colors.indigo),
      ),
    ),
    SliverList.builder(
      itemCount: posts.length,
      itemBuilder: (context, i) => PostTile(posts[i]),
    ),
    SliverGrid.builder(
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 2,
      ),
      itemCount: photos.length,
      itemBuilder: (context, i) => PhotoTile(photos[i]),
    ),
  ],
)
```

Defina `pinned: true` para manter a barra fixa no topo, `floating: true` para fazê-la deslizar de volta em qualquer rolagem para cima, e `expandedHeight` com um `flexibleSpace` para obter o recolhimento de grande para pequeno. Nada disso é possível com uma `Column` simples de scrollables, que é o retorno concreto de mudar para slivers.

## As pegadinhas que realmente pegam

**Não aninhe um scrollable dentro de um sliver.** O ponto todo é um único viewport. Colocar um `ListView` dentro de um `SliverToBoxAdapter` reintroduz o erro de altura ilimitada e uma segunda posição de rolagem. Se você tem uma linha com rolagem horizontal dentro de um `CustomScrollView` vertical, isso é aceitável (eixo diferente, dê a ela uma altura fixa via um `SliverToBoxAdapter` envolvendo um `SizedBox`), mas nunca aninhe um scrollable do mesmo eixo.

**Keys importam quando os itens são reordenados.** Se os itens da lista ou da grade podem ser inseridos, removidos ou reordenados, dê a cada tile uma `ValueKey` atrelada aos seus dados para que o Flutter associe o estado certo ao widget certo entre reconstruções. Sem keys, uma linha removida pode deixar seu estado anexado ao tile errado.

**Fique atento ao caso da seção vazia.** Um `SliverList` ou `SliverGrid` com `itemCount: 0` simplesmente não pinta nada, que é o que você quer, mas se você também quer um placeholder de "nenhuma foto ainda", use `SliverToBoxAdapter` ou `SliverFillRemaining` para mostrá-lo, não uma grade vazia.

**`SliverFillRemaining` preenche o viewport restante.** Se a lista mais a grade não preenchem a tela e você quer um rodapé ou estado vazio fixado na parte inferior da área visível, `SliverFillRemaining(hasScrollBody: false, child: ...)` ocupa exatamente a altura restante. É a versão em sliver do `Expanded` para a última seção.

**Agrupando slivers.** Se você constrói vários pares de lista-e-grade e quer tratar cada par como uma unidade (por exemplo para aplicar um fundo), `SliverMainAxisGroup` (Flutter 3.16+) empilha slivers filhos ao longo do eixo de rolagem para que eles se comportem como um único sliver. Você raramente precisa disso para uma simples lista-mais-grade, mas é a ferramenta quando uma seção tem estrutura interna.

## Quando um GridView ou ListView simples ainda é o certo

Slivers são a resposta quando você está combinando seções em uma única rolagem. Eles são exagero quando você tem uma única lista ou uma única grade e nada mais rolando junto com ela. Um `GridView.builder` solitário dentro de um corpo de `Scaffold` já é preguiçoso e já é o viewport; envolvê-lo em um `CustomScrollView` com um único `SliverGrid` adiciona cerimônia sem benefício. Recorra a slivers no momento em que você tem duas ou mais seções roláveis, um cabeçalho que recolhe, ou um cabeçalho que precisa rolar para fora junto com o conteúdo. Para todo o resto, os widgets simples estão bem, e se o seu único problema é uma única lista se recusando a caber em uma `Column`, as quatro soluções em [o post sobre altura ilimitada](/pt-br/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/) são o caminho mais curto.

Mais um hábito que vale manter: se qualquer seção usa um `ScrollController` (por exemplo para saltar a visão combinada até uma seção), anexe-o ao `CustomScrollView`, não aos slivers individuais (slivers não recebem um controller), e [descarte-o](/pt-br/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) no seu `State.dispose` para não vazá-lo. E se um tile dentro da grade em algum momento transbordar sua célula, isso aparece como um aviso de [RenderFlex overflowed](/pt-br/2026/05/fix-renderflex-overflowed-in-flutter/) dentro do tile, sem relação com o encanamento de slivers, resolvido no nível do tile.

## O modelo mental para guardar

Um `CustomScrollView` é um único viewport; cada seção que você coloca nele é um sliver, e slivers compartilham essa única posição de rolagem enquanto cada um permanece preguiçoso. `SliverList` e `SliverGrid` são a lista e a grade preguiçosas, `SliverToBoxAdapter` é a saída de emergência para widgets de caixa avulsos, `SliverPadding` adiciona margens, e `SliverAppBar` é o cabeçalho que recolhe que você obtém quase de graça. Assim que você para de pensar "empilhar dois scrollables" e começa a pensar "uma única rolagem feita de slivers", misturar uma lista e uma grade deixa de ser uma briga com o motor de layout e passa a ser quatro linhas de composição.

## Fontes

- [CustomScrollView class, Flutter API reference](https://api.flutter.dev/flutter/widgets/CustomScrollView-class.html) -- hospedando múltiplos slivers em um único viewport, incluindo o exemplo SliverAppBar + SliverList + SliverGrid.
- [SliverGrid class, Flutter API reference](https://api.flutter.dev/flutter/widgets/SliverGrid-class.html) -- os construtores builder/count/extent e os dois grid delegates.
- [SliverList class, Flutter API reference](https://api.flutter.dev/flutter/widgets/SliverList-class.html) -- comportamento de lista preguiçosa e a nota sobre SliverFixedExtentList.
- [Using slivers to achieve fancy scrolling, Flutter docs](https://docs.flutter.dev/ui/layout/scrolling/slivers) -- o protocolo de slivers e como viewports negociam o paint extent.
