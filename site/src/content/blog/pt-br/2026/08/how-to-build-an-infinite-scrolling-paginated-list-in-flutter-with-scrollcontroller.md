---
title: "Como criar uma lista paginada com scroll infinito em Flutter com ScrollController"
description: "Conecte um ScrollController a um ListView.builder, peça a próxima página quando position.extentAfter cair abaixo do limite de pré-carregamento e proteja a requisição com flags isLoading, hasMore e error. Implementação completa mais a armadilha da primeira página curta."
pubDate: 2026-08-04
template: how-to
tags:
  - "flutter"
  - "dart"
  - "listview"
  - "scrollcontroller"
  - "pagination"
  - "how-to"
lang: "pt-br"
translationOf: "2026/08/how-to-build-an-infinite-scrolling-paginated-list-in-flutter-with-scrollcontroller"
translatedBy: "claude"
translationDate: 2026-08-04
---

Para montar uma lista com scroll infinito em Flutter, conecte um `ScrollController` a um `ListView.builder`, escute as mudanças de scroll e peça a próxima página quando `position.extentAfter` cair abaixo de um limite de pré-carregamento de algumas centenas de pixels. O listener em si precisa ser idempotente: ele dispara a cada frame de scroll, então a busca de verdade tem que ficar atrás de uma guarda de `isLoading`/`hasMore`/`error` ou você vai disparar uma dúzia de requisições idênticas durante um único movimento de arrasto. Este artigo constrói tudo em cima do Flutter 3.44.8 (Dart 3.12.2) e depois cobre os dois modos de falha que aparecem em produção: a primeira página curta demais para rolar e o loop de retentativas que castiga uma API fora do ar.

## Por que `pixels >= maxScrollExtent` é o gatilho errado

Quase todo tutorial começa aqui:

```dart
// Flutter 3.44.8, Dart 3.12.2 -- do not ship this
_controller.addListener(() {
  if (_controller.position.pixels >= _controller.position.maxScrollExtent) {
    _loadMore();
  }
});
```

Três coisas estão erradas nisso.

Primeiro, um `ScrollController` notifica seus listeners a cada mudança de posição de scroll, o que durante um arrasto significa uma vez por frame a 60Hz ou 120Hz. Se `_loadMore()` for um `await api.fetch(...)` sem proteção, a condição continua verdadeira durante todo o tempo em que a lista fica presa no fim, e você dispara uma requisição nova a cada frame até a primeira resposta chegar. Num aparelho de 120Hz com 300ms de ida e volta, isso dá aproximadamente 36 requisições duplicadas.

Segundo, `maxScrollExtent` é exatamente o fim. Esperar por ele significa que a pessoa já ficou sem conteúdo antes de você começar a pedir mais, então ela encara um espaço vazio pelo tempo de uma ida e volta de rede. O viewport do Flutter constrói um `cacheExtent` de `RenderAbstractViewport.defaultCacheExtent`, que são `250.0` pixels lógicos, além da borda visível. Disparar enquanto ainda há conteúdo nessa faixa faz a busca se sobrepor ao scroll em vez de vir atrás dele.

Terceiro, `ScrollController.position` não é seguro de acessar sem condições. O getter tem dois asserts:

```dart
ScrollPosition get position {
  assert(_positions.isNotEmpty, 'ScrollController not attached to any scroll views.');
  assert(_positions.length == 1, 'ScrollController attached to multiple scroll views.');
  return _positions.single;
}
```

Os dois disparam em builds de debug e os dois são alcançáveis a partir de código comum, como mostram as armadilhas mais abaixo.

A correção para os dois primeiros pontos é disparar por `extentAfter`, que a documentação de `ScrollPosition` define como a quantidade de conteúdo conceitualmente abaixo do viewport. Quando `extentAfter` vale 400, ainda restam 400 pixels lógicos de linhas já construídas para rolar, o que normalmente é pista suficiente para esconder a busca por completo.

## Montando em quatro passos

O padrão inteiro são quatro peças móveis. Todo o resto é apresentação.

1. **Guarde o estado de paginação no `State`, não no builder.** Você precisa da `List<T>` acumulada, do cursor ou número de página para a próxima requisição, e de três flags: `_isLoading`, `_hasMore` e `_error`. Essas três flags são o que torna seguro chamar o listener de scroll a cada frame.
2. **Conecte um `ScrollController` no `initState` e desconecte no `dispose`.** Chame `removeListener` antes de `dispose()` no controller, e dispare a primeira página a partir do `initState` para que a lista nunca fique vazia no primeiro frame sem um indicador de carregamento.
3. **Dispare por `extentAfter`, não por `pixels`.** No listener, saia logo de cara se o controller não tiver clients, se já houver uma busca em andamento, se o servidor disse que não há mais páginas, ou se a última tentativa falhou. Só então compare `extentAfter` com o seu limite de pré-carregamento.
4. **Renderize uma linha extra para o estado final.** Defina `itemCount` como `items.length + 1` enquanto houver mais para carregar ou um erro a exibir, e faça o `itemBuilder` devolver um indicador de carregamento, uma linha de retentativa, ou nada para esse índice final. É isso que transforma o estado de carregamento em algo que a pessoa consegue ver e sobre o qual pode agir.

## A implementação completa

```dart
// Flutter 3.44.8, Dart 3.12.2
class FeedPage extends StatefulWidget {
  const FeedPage({super.key});

  @override
  State<FeedPage> createState() => _FeedPageState();
}

class _FeedPageState extends State<FeedPage> {
  // Default viewport cacheExtent is 250.0 px, so 400 leaves runway.
  static const double _prefetchExtent = 400;
  static const int _pageSize = 20;

  final ScrollController _controller = ScrollController();
  final List<Post> _items = [];

  String? _cursor;
  bool _isLoading = false;
  bool _hasMore = true;
  Object? _error;

  @override
  void initState() {
    super.initState();
    _controller.addListener(_onScroll);
    _loadMore();
  }

  @override
  void dispose() {
    _controller.removeListener(_onScroll);
    _controller.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (!_controller.hasClients) return;
    if (_isLoading || !_hasMore || _error != null) return;
    if (_controller.position.extentAfter > _prefetchExtent) return;
    _loadMore();
  }

  Future<void> _loadMore() async {
    if (_isLoading || !_hasMore) return;

    setState(() {
      _isLoading = true;
      _error = null;
    });

    try {
      final page = await api.fetchFeed(after: _cursor, limit: _pageSize);
      if (!mounted) return;
      setState(() {
        _items.addAll(page.items);
        _cursor = page.nextCursor;
        _hasMore = page.nextCursor != null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e);
    } finally {
      _isLoading = false;
      if (mounted) setState(() {});
    }
  }

  @override
  Widget build(BuildContext context) {
    final bool showTail = _hasMore || _error != null;

    return ListView.builder(
      controller: _controller,
      itemCount: _items.length + (showTail ? 1 : 0),
      itemBuilder: (context, index) {
        if (index < _items.length) {
          return PostTile(post: _items[index]);
        }
        if (_error != null) {
          return _RetryTile(error: _error!, onRetry: _retry);
        }
        return const Padding(
          padding: EdgeInsets.all(16),
          child: Center(child: CircularProgressIndicator()),
        );
      },
    );
  }

  void _retry() {
    setState(() => _error = null);
    _loadMore();
  }
}
```

Repare na separação entre `_onScroll` e `_loadMore`. `_onScroll` se recusa a rodar quando `_error != null`; `_loadMore` não. Essa assimetria é proposital e é o que corta o loop de retentativas descrito adiante. O listener de scroll nunca vai retentar automaticamente uma página que falhou, mas o botão de retentativa pode, porque ele limpa `_error` antes.

O bloco `finally` atribui `_isLoading = false` como atribuição simples antes de checar `mounted`. Se você colocar a atribuição dentro de um `setState` que só roda quando montado, uma desmontagem durante a requisição deixa a flag presa em true; inofensivo para um widget já destruído, mas dificulta raciocinar sobre a máquina de estados quando essa mesma lógica de controller for movida depois para um notifier do Riverpod.

## A primeira página curta que nunca rola

Esse é o bug que mais chega em produção, porque só aparece em telas altas. Se a página um devolve 20 linhas e cabem 30 no viewport, `maxScrollExtent` vale `0.0`, não dá para rolar, o `ScrollController` nunca notifica, e a lista fica permanentemente em 20 itens. Funciona perfeitamente num celular em retrato e parece quebrada num tablet, no desktop e na web com a janela maximizada.

`ScrollController` não ajuda aqui, porque nada rolou. A correção mais barata é checar de novo depois do frame que posicionou as linhas novas:

```dart
// Flutter 3.44.8: run after layout so maxScrollExtent is real.
void _fillViewportIfNeeded() {
  WidgetsBinding.instance.addPostFrameCallback((_) {
    if (!mounted || !_controller.hasClients) return;
    if (_error != null || !_hasMore) return;
    if (_controller.position.maxScrollExtent == 0) _loadMore();
  });
}
```

Chame isso no fim do ramo de sucesso de `_loadMore`. Ela sempre termina: cada passada ou deixa o conteúdo mais alto que o viewport (então `maxScrollExtent > 0`) ou esgota o feed (então `_hasMore` vira false).

A correção mais completa é `ScrollMetricsNotification`, que o Flutter despacha quando as `ScrollMetrics` de um scrollable mudam sem que nenhum scroll tenha acontecido, incluindo quando o conteúdo cresce ou encolhe e quando a janela pai é redimensionada. Envolver a lista em um deles cobre o caso do tablet, o do redimensionamento de janela no desktop, e o caso em que o teclado da tela fecha e o viewport de repente fica mais alto:

```dart
// Flutter 3.44.8, Dart 3.12.2
NotificationListener<ScrollMetricsNotification>(
  onNotification: (notification) {
    if (notification.metrics.maxScrollExtent == 0 && _error == null) {
      _loadMore();
    }
    return false; // let it keep bubbling
  },
  child: ListView.builder(/* ... */),
)
```

Devolva `false` do `onNotification`. Devolver `true` cancela a subida da notificação pela árvore, o que quebra silenciosamente qualquer ancestral que dependa dela, como um `Scrollbar` ou um `RefreshIndicator`.

## O loop de retentativas que castiga uma API fora do ar

Suponha que a guarda em `_onScroll` fosse apenas `if (_isLoading || !_hasMore) return;`. A pessoa está no fim, a requisição falha, `_isLoading` vira false, `_hasMore` continua true, e a posição não se moveu. A próxima notificação de scroll, que chega no micromovimento seguinte do dedo, chama `_loadMore` de novo. Cada falha produz imediatamente outra requisição, então uma queda de rede vira uma enxurrada de requisições que mantém o rádio acordado e drena a bateria.

Adicionar `_error != null` à guarda de scroll transforma a falha num estado terminal que só uma ação explícita da pessoa limpa. Se você quer recuperação automática, coloque-a atrás de um backoff em vez de atrás do listener de scroll, e limite as tentativas. O formato geral disso, incluindo quais exceções vale a pena retentar, está em [como tratar erros de rede com elegância num app Flutter](/pt-br/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/).

## Armadilhas que vão te pegar

1. **`ScrollController not attached to any scroll views.`** Ler `.position` antes do primeiro layout, ou depois que o `ListView` já sumiu, dispara esse assert. É fácil cair nisso a partir de um callback pós-frame que sobrevive a um `Navigator.pop`. Proteja todo acesso com `hasClients`, que é apenas `_positions.isNotEmpty`.
2. **`ScrollController attached to multiple scroll views.`** Um controller só consegue reportar uma posição se exatamente um scrollable estiver usando ele. Passar o mesmo `_controller` para dois `ListView` dentro de um `TabBarView` é o jeito clássico de cair nessa. Cada aba precisa do próprio controller e do próprio estado de paginação.
3. **A paginação por offset se desloca num feed vivo.** Se o servidor insere uma linha enquanto a pessoa está entre a página 2 e a 3, `?page=3&size=20` devolve uma janela que se sobrepõe à página 2, então ela vê um item duplicado e perde outro. A paginação por cursor não tem esse modo de falha, e é por isso que o exemplo acima carrega um `nextCursor` em vez de um índice de página. A metade do lado do servidor, com o SQL e o índice que ela exige, está em [paginação keyset (por cursor) no EF Core 11](/pt-br/2026/06/how-to-do-keyset-cursor-pagination-in-ef-core-11/).
4. **`setState` depois do `dispose`.** Cada `await` em `_loadMore` é um ponto onde a pessoa pode tocar em voltar. O `if (!mounted) return;` depois de cada await não é opcional; sem ele você recebe `setState() called after dispose()`. A regra completa, incluindo por que `mounted` precisa ser rechecado depois de cada intervalo em vez de uma única vez no topo, está em [proteger setState com a checagem de mounted após um intervalo assíncrono](/pt-br/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/).
5. **O controller é um descartável que pertence a você.** `ScrollController` estende `ChangeNotifier`; se o `State` que o criou não o descartar, o closure do listener mantém vivo o `State` e tudo que ele capturou. É a mesma classe de vazamento de memória de um `TextEditingController` ou `AnimationController` não descartado, coberta em [como descartar controllers em Flutter para evitar vazamentos de memória](/pt-br/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).
6. **`shrinkWrap: true` destrói o propósito inteiro.** Uma lista com shrink wrap constrói todos os filhos no primeiro frame para conseguir se medir, então uma lista infinita vira um custo de primeiro frame que cresce sem limite. Se você recorreu a ele para silenciar um erro de altura não delimitada, as alternativas corretas estão detalhadas em [shrinkWrap vs Expanded vs slivers para listas longas](/pt-br/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/).

## Quando usar `NotificationListener` em vez de um controller

`ScrollController` não é o único jeito de ler as métricas de scroll. Um `NotificationListener<ScrollNotification>` pega os mesmos números via `notification.metrics` sem possuir nenhum controller:

```dart
// Flutter 3.44.8, Dart 3.12.2
NotificationListener<ScrollEndNotification>(
  onNotification: (notification) {
    if (notification.metrics.extentAfter < 400) _loadMore();
    return false;
  },
  child: ListView.builder(/* ... */),
)
```

Prefira isso quando você não é dono do scrollable: dentro de um `NestedScrollView`, sob um `PrimaryScrollController`, ou quando a lista é um `CustomScrollView` com várias seções de slivers e um único controller seria ambíguo sobre qual delas você quis dizer. `ScrollEndNotification` também dispara bem menos que um listener de controller, o que elimina a preocupação por frame, ao custo de não pré-carregar no meio do arrasto.

Prefira o controller quando você também precisar *dirigir* o scroll: `jumpTo`, `animateTo`, restaurar um offset, ou rolar até um item recém-inserido. E se a sua lista dividir o viewport com outro conteúdo, os equivalentes em slivers valem sem mudanças; a lógica de paginação é idêntica, só muda o widget que envolve, como em [misturar um ListView e um GridView num único scroll com slivers](/pt-br/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/).

## Se vale a pena só usar o pacote

`infinite_scroll_pagination` 5.1.1 empacota essa máquina de estados como um `PagingController` mais um `PagedListView` e um `PagingListener`, e cuida dos estados finais, do caso da primeira página curta e da integração com pull to refresh. É uma dependência razoável para um app com muitas telas paginadas, já que a alternativa é copiar e colar o `State` acima cinco vezes.

Escreva à mão quando você tiver uma ou duas listas paginadas, quando o seu estado de paginação já morar no Riverpod ou no Bloc (momento em que o controller é só um gatilho e o controller do próprio pacote fica sobrando), ou quando o contrato de paginação da sua API for incomum o bastante para você acabar brigando com a abstração. Se for ligar isso ao Riverpod, os ramos de carregamento e erro se encaixam direitinho em `AsyncValue`, coberto em [exibir estados de carregamento e erro com AsyncValue no Flutter Riverpod](/pt-br/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/).

## Fontes

- [ScrollPosition class](https://api.flutter.dev/flutter/widgets/ScrollPosition-class.html), documentação da API do Flutter (`extentAfter`, `maxScrollExtent`, `atEdge`)
- [ScrollController class](https://api.flutter.dev/flutter/widgets/ScrollController-class.html), documentação da API do Flutter (`hasClients`, `position`, `keepScrollOffset`)
- [ScrollMetricsNotification class](https://api.flutter.dev/flutter/widgets/ScrollMetricsNotification-class.html), documentação da API do Flutter
- [RenderAbstractViewport.defaultCacheExtent](https://api.flutter.dev/flutter/rendering/RenderAbstractViewport/defaultCacheExtent-constant.html), documentação da API do Flutter
- [Notas de versão do Flutter 3.44.0](https://docs.flutter.dev/release/release-notes/release-notes-3.44.0), documentação do Flutter
- [infinite_scroll_pagination no pub.dev](https://pub.dev/packages/infinite_scroll_pagination)
