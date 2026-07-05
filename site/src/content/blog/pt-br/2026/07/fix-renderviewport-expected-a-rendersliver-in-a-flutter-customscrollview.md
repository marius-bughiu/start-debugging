---
title: "Correção: A RenderViewport expected a child of type RenderSliver but received a child of type RenderBox (Flutter CustomScrollView)"
description: "A lista slivers de um CustomScrollView aceita apenas slivers. Envolva widgets box em SliverToBoxAdapter, ou troque ListView/Padding/Column por SliverList e SliverPadding."
pubDate: 2026-07-05
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "slivers"
  - "layout"
lang: "pt-br"
translationOf: "2026/07/fix-renderviewport-expected-a-rendersliver-in-a-flutter-customscrollview"
translatedBy: "claude"
translationDate: 2026-07-05
---

`A RenderViewport expected a child of type RenderSliver but received a child of type RenderParagraph` (ou `RenderFlex`, ou `RenderErrorBox`, ou qualquer outro `RenderBox`) significa que você colocou um widget comum diretamente dentro da lista `slivers` de um `CustomScrollView`. Tudo dentro de `slivers` precisa ser um sliver. A correção mais rápida é envolver o widget box problemático em um `SliverToBoxAdapter`; a correção melhor, para uma lista, é substituir `ListView` por `SliverList.builder` e `Padding` por `SliverPadding`. Testado no Flutter 3.x (3.44), Dart 3.x.

## O erro em contexto

O Flutter lança isso em tempo de layout, antes de pintar qualquer coisa. O tipo concreto depois de "received a child of type" muda dependendo do que você colocou na lista -- `RenderParagraph` para um `Text`, `RenderFlex` para um `Column` ou `Row`, `RenderErrorBox` quando um builder dentro da lista lançou uma exceção -- mas o formato é sempre o mesmo:

```
FlutterError (A RenderViewport expected a child of type RenderSliver but received a
child of type RenderParagraph.
RenderObjects expect specific types of children because they coordinate with their
children during layout and paint. For example, a RenderSliver cannot be the child of
a RenderBox because a RenderSliver does not understand the RenderBox layout protocol.

The RenderViewport that expected a RenderSliver child was created by:
  Viewport ← IgnorePointer ← Semantics ← Listener ← _GestureSemantics ←
    Scrollable ← PrimaryScrollController ← CustomScrollView ← ...

The RenderParagraph that did not match the expected child type was created by:
  Text ← ...)
```

Os dois blocos "created by" são a parte útil. O primeiro nomeia o widget de rolagem que esperava um sliver (quase sempre o seu `CustomScrollView`). O segundo nomeia o widget exato que não era um sliver. Leia o segundo bloco primeiro: ele aponta diretamente para a linha que você precisa mudar.

## Por que um viewport recusa um filho box

O Flutter tem dois protocolos de layout, não um só. Widgets comuns como `Container`, `Text`, `Row` e `Column` são dispostos como boxes: o pai passa restrições de largura e altura para baixo, o filho retorna um `Size` concreto, pronto. Seus render objects são subclasses de `RenderBox` (`RenderParagraph`, `RenderFlex`, e assim por diante).

Slivers usam um protocolo diferente e mais rico, feito para rolagem. Um sliver não apenas informa um tamanho. Durante o layout ele recebe um `SliverConstraints` descrevendo quanto dele está atualmente rolado para fora da tela, quanto espaço resta no viewport, o deslocamento de rolagem, a direção do eixo, e mais. Ele retorna um `SliverGeometry` descrevendo quanto espaço pintou, quanto consumiu no eixo de rolagem, sua extensão de hit-test, e se quer estar visível. Esse vai-e-vem é o que permite a um `SliverAppBar` encolher conforme você rola e a um `SliverList` construir apenas as linhas que estão atualmente na tela. Seus render objects são subclasses de `RenderSliver`.

Um `RenderViewport` -- o render object por trás do `CustomScrollView` -- fala apenas o protocolo sliver com seus filhos. Ele entrega a cada filho um `SliverConstraints` e espera um `SliverGeometry` de volta. Se você lhe der um `RenderBox`, esse box não faz ideia do que fazer com `SliverConstraints`; ele não implementa o método que o viewport está prestes a chamar. Em vez de quebrar lá no fundo do layout com um null confuso, o framework verifica o tipo do filho antecipadamente e lança essa asserção. A mensagem deixa a regra explícita: "a RenderSliver cannot be the child of a RenderBox because a RenderSliver does not understand the RenderBox layout protocol," e o mesmo vale no sentido inverso, que é exatamente a incompatibilidade em que você esbarrou.

Então isso não é um bug sutil de restrição como [RenderBox was not laid out](/pt-br/2026/06/fix-renderbox-was-not-laid-out-in-flutter/) ou um [overflow de RenderFlex](/pt-br/2026/05/fix-renderflex-overflowed-in-flutter/). É uma incompatibilidade de tipos: um widget box no lugar onde um sliver deveria estar.

## O repro mínimo

Qualquer widget não-sliver na lista `slivers` dispara isso. Aqui está a menor versão -- um `Text` cru onde deveria haver um sliver:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
class Feed extends StatelessWidget {
  const Feed({super.key});

  @override
  Widget build(BuildContext context) {
    return CustomScrollView(
      slivers: [
        const Text('Recent activity'), // RenderParagraph, not a sliver
        SliverList.builder(
          itemCount: 20,
          itemBuilder: (context, i) => ListTile(title: Text('Item $i')),
        ),
      ],
    );
  }
}
```

O `SliverList.builder` está correto. O `Text` é o problema: ele vira um `RenderParagraph`, o viewport esperava um `RenderSliver`, e o layout lança a exceção. A mesma coisa acontece se você jogar um `Column`, um `Padding`, um `Center`, um `ListView`, ou um widget de página customizado inteiro dentro de `slivers`. Se não for um sliver, o viewport rejeita.

## Correção 1: envolva um único widget box em SliverToBoxAdapter

Para um widget box pontual -- um título, um banner, um card, uma linha de botões -- envolva-o em `SliverToBoxAdapter`. Esse widget é um sliver cuja única função é hospedar um filho `RenderBox` e traduzir entre os dois protocolos: ele mede o box, e então informa o `SliverGeometry` apropriado ao viewport.

```dart
// Flutter 3.x (tested 3.44)
CustomScrollView(
  slivers: [
    const SliverToBoxAdapter(
      child: Text('Recent activity'),
    ),
    SliverList.builder(
      itemCount: 20,
      itemBuilder: (context, i) => ListTile(title: Text('Item $i')),
    ),
  ],
)
```

Esta é a correção direta e a correta quando o conteúdo box é genuinamente um único bloco de tamanho fixo. É o sliver ao qual você recorre primeiro quando um cabeçalho, um espaçador ou um card de resumo precisa ficar acima das suas listas em uma única scroll view.

A única coisa a saber: o `SliverToBoxAdapter` constrói seu filho imediatamente e o mantém vivo esteja ele na tela ou não, porque um box não tem noção de preguiça. Isso é aceitável para um cabeçalho. É errado para uma lista longa, que é a Correção 2.

## Correção 2: use SliverList / SliverGrid para listas, não um ListView envolvido

O erro mais comum é jogar um `ListView` dentro de `slivers` e então, quando este erro aparece, envolver o `ListView` em `SliverToBoxAdapter`. Isso silencia a asserção, mas é o formato errado. Agora você tem um scrollable dentro de um scrollable, e o `ListView` interno recebe altura ilimitada do adapter -- a mesma família de falha que [aninhar um ListView em um Column](/pt-br/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/). Mesmo se você forçá-lo a funcionar com `shrinkWrap`, você joga fora a construção preguiçosa: cada linha é construída de antemão.

O objetivo inteiro de um `CustomScrollView` é que suas seções sejam slivers compartilhando um único viewport. Então use a lista sliver, não um `ListView` encaixotado:

```dart
// Flutter 3.x (tested 3.44)
CustomScrollView(
  slivers: [
    const SliverToBoxAdapter(child: Text('Recent activity')),

    // Lazy: only builds rows near the viewport. Direct replacement for ListView.builder.
    SliverList.builder(
      itemCount: items.length,
      itemBuilder: (context, i) => ListTile(title: Text(items[i])),
    ),

    // Grid section in the same scroll view.
    SliverGrid.builder(
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(crossAxisCount: 2),
      itemCount: photos.length,
      itemBuilder: (context, i) => Image.network(photos[i]),
    ),
  ],
)
```

`SliverList.builder`, `SliverList.separated`, `SliverFixedExtentList` e `SliverGrid.builder` são os equivalentes sliver dos builders de `ListView`/`GridView`. Eles mantêm a construção preguiçosa que torna listas longas baratas, e encaixam direto em `slivers`. Se você quer uma lista e uma grade fluindo em uma única rolagem contínua, este é o layout para isso -- veja [misturar um ListView e um GridView com slivers](/pt-br/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/) para o padrão completo.

## Correção 3: SliverPadding em vez de Padding, SliverFillRemaining em vez de um box

A regra box-versus-sliver pega os widgets envoltórios também. Se você envolve um sliver em `Padding` para recuá-lo, o `Padding` é um `RenderBox` e o viewport o rejeita. A versão ciente de sliver é o `SliverPadding`, que dá padding a um filho sliver e continua sendo um sliver:

```dart
// Flutter 3.x (tested 3.44)
CustomScrollView(
  slivers: [
    SliverPadding(
      padding: const EdgeInsets.all(16),
      sliver: SliverList.builder(       // note: 'sliver:', not 'child:'
        itemCount: items.length,
        itemBuilder: (context, i) => Text(items[i]),
      ),
    ),
  ],
)
```

Preste atenção no nome do parâmetro: o `SliverPadding` recebe `sliver:`, não `child:`, porque seu filho precisa ser ele próprio um sliver. A mesma ideia cobre algumas outras necessidades comuns:

- **Um box que deve preencher o viewport restante** (uma mensagem de estado-vazio centralizada em qualquer espaço que sobre): `SliverFillRemaining(child: ...)`.
- **Um box que deve ter exatamente a altura de uma tela**: `SliverFillViewport`.
- **Um cabeçalho fixo ou flutuante que encolhe ao rolar**: `SliverAppBar`, que já é um sliver, então vai em `slivers` diretamente.
- **Agrupar vários slivers para aplicar um único clip ou decoração**: `SliverMainAxisGroup` / `SliverCrossAxisGroup`.

O modelo mental: para cada widget box que você normalmente usaria, ou envolva-o (`SliverToBoxAdapter`, `SliverFillRemaining`) ou encontre seu gêmeo sliver (`SliverList`, `SliverGrid`, `SliverPadding`, `SliverAppBar`).

## Pegadinhas e semelhantes

**Um builder dentro de slivers que lança uma exceção mostra este mesmo erro.** Quando o tipo recebido é `RenderErrorBox`, o filho era um `ErrorWidget`: algo dentro de um `StreamBuilder` ou `FutureBuilder` posicionado nos seus `slivers` lançou uma exceção durante o build, o Flutter substituiu pela sua caixa de erro vermelha (um `RenderBox`), e o viewport rejeitou isso. A correção tem duas partes: faça o builder retornar um sliver em todo caminho, e trate o caso de erro. Um `StreamBuilder` em `slivers` precisa retornar um sliver do seu `builder`, incluindo os ramos de erro e de carregamento:

```dart
// Flutter 3.x (tested 3.44)
StreamBuilder<List<String>>(
  stream: feed,
  builder: (context, snapshot) {
    if (snapshot.hasError) {
      return const SliverToBoxAdapter(child: Text('Could not load feed'));
    }
    if (!snapshot.hasData) {
      return const SliverToBoxAdapter(child: Center(child: CircularProgressIndicator()));
    }
    final items = snapshot.data!;
    return SliverList.builder(
      itemCount: items.length,
      itemBuilder: (context, i) => ListTile(title: Text(items[i])),
    );
  },
)
```

Se você retornar um `Text` cru ou um `CircularProgressIndicator` de qualquer ramo, você volta ao erro original. (Já que você está por aqui, se um `FutureBuilder` reexecuta seu future a cada rebuild, isso é um bug separado que vale a pena corrigir -- veja [como impedir o FutureBuilder de recriar seu Future](/pt-br/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/).)

**A incompatibilidade inversa se lê quase igual.** Se você colocar um sliver onde um box deveria estar -- digamos um `SliverList` dentro de um `Column` -- você recebe "A RenderObjectWithChildMixin expected a child of type RenderBox but received a child of type RenderSliverList" ou "expected a RenderBox but received a RenderSliverPadding." Mesma regra, direção oposta: slivers só vivem dentro de um viewport (`CustomScrollView`, ou a área de slivers de um `NestedScrollView`), nunca diretamente dentro de um `Column`, `Center` ou `Padding`. Para transformar um sliver de volta em algo que um pai box aceite, você geralmente não transforma: você reestrutura para que o sliver fique dentro de um `CustomScrollView`.

**`SliverToBoxAdapter` não é um lugar para esconder uma lista longa.** Funciona, então é tentador, mas anula a preguiça: o adapter constrói toda a sua subárvore de filhos imediatamente. Envolver um `ListView` de 5.000 linhas (ou um `Column` de 5.000 filhos) em um significa construir todos os 5.000 no primeiro frame, o que dispara o tempo de layout e aparece como travamento na timeline. Use-o para cabeçalhos e cards únicos; use `SliverList.builder` para qualquer coisa que role.

**O hot reload às vezes não consegue se recuperar disso.** Como a asserção dispara durante o layout, um hot reload depois de corrigir o código pode ocasionalmente deixar a árvore de render travada. Se o erro persistir depois que você claramente corrigiu a linha problemática, faça um hot restart (`R`), não um hot reload (`r`).

## Relacionados

- [Como misturar um ListView e um GridView em uma única scroll view com slivers](/pt-br/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/) -- o layout multi-seção correto de `CustomScrollView` para o qual este erro está te empurrando.
- [Como aninhar um ListView dentro de um Column sem um erro de altura ilimitada](/pt-br/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/) -- a falha em que você esbarra se "corrigir" isso encaixotando um ListView.
- [Correção: RenderBox was not laid out no Flutter](/pt-br/2026/06/fix-renderbox-was-not-laid-out-in-flutter/) -- a outra asserção de tempo de layout que você encontra ao montar scroll views.
- [Correção: A RenderFlex overflowed no Flutter](/pt-br/2026/05/fix-renderflex-overflowed-in-flutter/) -- problema de restrição em `Row`/`Column`, o primo do lado box deste problema.

## Fontes

- [Classe RenderViewport, referência da API do Flutter](https://api.flutter.dev/flutter/rendering/RenderViewport-class.html) -- o render object que fala o protocolo sliver e rejeita filhos box.
- [Classe SliverToBoxAdapter, referência da API do Flutter](https://api.flutter.dev/flutter/widgets/SliverToBoxAdapter-class.html) -- envolvendo um único widget box como um sliver.
- [Classe SliverList, referência da API do Flutter](https://api.flutter.dev/flutter/widgets/SliverList-class.html) -- o sliver de lista preguiçosa e seus construtores `.builder` / `.separated`.
- [issue 126064 do flutter/flutter](https://github.com/flutter/flutter/issues/126064) -- a variante `RenderErrorBox`, onde um builder que lança exceção dentro de `slivers` produz esta mesma asserção.
