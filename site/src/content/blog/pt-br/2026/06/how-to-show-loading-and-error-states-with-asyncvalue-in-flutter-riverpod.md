---
title: "Como mostrar estados de carregamento e erro com AsyncValue no Flutter Riverpod"
description: "Renderize estados de carregamento, dados e erro a partir de um único AsyncValue no Riverpod 3. Use AsyncNotifier e AsyncValue.guard para as mutações, .when() e correspondência de padrões com switch para a UI, mantenha os dados anteriores ao atualizar e migre o padrão legado StateNotifier. Testado em flutter_riverpod 3.x, Flutter 3.44, Dart 3.x."
pubDate: 2026-06-02
template: how-to
tags:
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
  - "how-to"
lang: "pt-br"
translationOf: "2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod"
translatedBy: "claude"
translationDate: 2026-06-02
---

A versão curta: um provider assíncrono no Riverpod te entrega um `AsyncValue<T>`, que é um único objeto sempre em exatamente um de três estados (dados, carregamento ou erro). Você renderiza os três a partir de um só lugar com `value.when(data: ..., loading: ..., error: ...)` ou com um `switch` do Dart 3 sobre `AsyncData` / `AsyncLoading` / `AsyncError`. Você produz esses estados a partir de um `AsyncNotifier` cujo `build` retorna um `Future`, e os altera com segurança usando `AsyncValue.guard`, que converte uma exceção lançada em um `AsyncError` em vez de causar uma falha. Se você está no antigo `StateNotifier`, o lado da renderização é idêntico depois que você expõe um `AsyncValue` como estado. Este guia foi testado em `flutter_riverpod` 3.x (a linha 3.0 saiu no início de 2026), Flutter 3.44 e Dart 3.x.

A razão pela qual esse padrão importa é que quase toda tela de um app real é assíncrona: ela busca algo, a busca pode estar em andamento e a busca pode falhar. Os times que escrevem isso na mão acabam com três campos separados (`isLoading`, `data`, `errorMessage`), um emaranhado de ramos `if` e o clássico bug em que `isLoading` é `false` mas `data` continua `null` porque um retorno antecipado esqueceu de virar uma flag. `AsyncValue` torna os estados ilegais irrepresentáveis: não existe "carregando e também tem um erro e também tem dados" porque o tipo é uma união selada. Você trata os três casos que o compilador te obriga a tratar, e pronto.

## Os três estados, e por que uma união vence três booleanos

`AsyncValue<T>` é uma classe selada com três subtipos concretos:

- `AsyncData<T>` carrega um `value` do tipo `T`.
- `AsyncLoading<T>` significa que há um carregamento em andamento.
- `AsyncError<T>` carrega um `error` (`Object`) e um `stackTrace`.

Como a classe é selada, o analisador sabe que a lista de subtipos é fechada, então um `switch` sobre eles é exaustivo sem caso padrão. Esse é todo o design: em vez de reconstruir "em qual estado estou" a partir de um saco de campos anuláveis a cada rebuild, você faz correspondência de padrões sobre um valor cujo tipo já codifica a resposta.

Ele também tem getters de conveniência aos quais você vai recorrer constantemente:

- `isLoading`, `hasValue`, `hasError` são booleanos.
- `value` é um `T?` anulável (pode ser não nulo mesmo enquanto `isLoading` é true, o que importa para a atualização, veja abaixo).
- `valueOrNull` é o acessador seguro que nunca lança.
- `requireValue` retorna o valor ou lança `AsyncValueIsLoadingException` / relança o erro. Use-o apenas quando você já provou que está no estado de dados.
- `isRefreshing` e `isReloading` distinguem uma atualização forçada de um recálculo dirigido por dependências.

## Uma tela concreta: uma lista de artigos que pode carregar e falhar

Aqui está a configuração realista mais enxuta: um repositório que busca uma lista, um provider que a expõe e um widget que renderiza os três estados. Estou usando a variante com geração de código e `riverpod_annotation`, que é a forma recomendada de declarar providers na linha 3.x.

```dart
// flutter_riverpod 3.x, riverpod_annotation 3.x, Dart 3.x
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

part 'articles_provider.g.dart';

class Article {
  const Article(this.id, this.title);
  final String id;
  final String title;
}

@riverpod
class Articles extends _$Articles {
  @override
  Future<List<Article>> build() async {
    final repo = ref.watch(articleRepositoryProvider);
    return repo.fetchAll(); // may throw on a network failure
  }
}
```

O método `build` retorna um `Future<List<Article>>`. O Riverpod envolve esse future para você: enquanto está pendente, `ref.watch(articlesProvider)` é `AsyncLoading`; quando completa, `AsyncData`; se lança, `AsyncError`. Você nunca constrói esses estados na mão para o carregamento inicial. Você apenas retorna dados ou deixa uma exceção se propagar.

Se você não usa geração de código, a forma manual é a mesma estrutura de classe sem a anotação:

```dart
// Manual (no code-gen) equivalent. flutter_riverpod 3.x
final articlesProvider =
    AsyncNotifierProvider<Articles, List<Article>>(Articles.new);

class Articles extends AsyncNotifier<List<Article>> {
  @override
  Future<List<Article>> build() async {
    final repo = ref.watch(articleRepositoryProvider);
    return repo.fetchAll();
  }
}
```

## Renderizar os três estados com `.when()`

`.when()` é a forma mais direta de mapear um `AsyncValue` para widgets. Ele recebe três callbacks obrigatórios:

```dart
// flutter_riverpod 3.x
class ArticleListView extends ConsumerWidget {
  const ArticleListView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final articles = ref.watch(articlesProvider);

    return articles.when(
      data: (list) => ListView.builder(
        itemCount: list.length,
        itemBuilder: (_, i) => ListTile(title: Text(list[i].title)),
      ),
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (err, stack) => ErrorView(
        message: _humanMessage(err),
        onRetry: () => ref.invalidate(articlesProvider),
      ),
    );
  }
}
```

Repare em três coisas. Primeiro, `ref.invalidate(articlesProvider)` é como o botão de tentar de novo reexecuta o `build`; ele descarta o estado em cache e recalcula. `ref.refresh` faz o mesmo e retorna o novo valor se você precisar. Segundo, o callback `error` recebe tanto o objeto de erro quanto seu stack trace, então você pode registrar o trace e mostrar ao usuário uma mensagem amigável: nunca coloque `err.toString()` direto na tela. Terceiro, `_humanMessage` é onde você traduz os tipos de exceção em texto, o que se encaixa com classificar a falha corretamente; veja [como tratar erros de rede com elegância em um app Flutter](/pt-br/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) para o mapeamento de exceção para mensagem que pertence ali.

## A alternativa do Dart 3: correspondência de padrões com `switch`

Como `AsyncValue` é selado, você pode fazer correspondência de padrões diretamente sobre ele. Muitos times preferem isso no Riverpod 3 porque lê de forma natural e permite desestruturar em uma linha:

```dart
// Dart 3.x switch expression over the sealed AsyncValue
Widget build(BuildContext context, WidgetRef ref) {
  final articles = ref.watch(articlesProvider);

  return switch (articles) {
    AsyncData(:final value) => ArticleList(items: value),
    AsyncError(:final error) => ErrorView(message: _humanMessage(error)),
    _ => const Center(child: CircularProgressIndicator()),
  };
}
```

O ramo `_` captura `AsyncLoading`. Funcionalmente isso é equivalente a `.when()`, mas compõe melhor quando você quer adicionar guardas (por exemplo `AsyncData(:final value) when value.isEmpty => const EmptyState()`). Use o que seu time achar mais legível; eles produzem a mesma UI.

## Mutações: por que você precisa do `AsyncValue.guard`

O carregamento inicial é automático, mas um botão que cria ou exclui um artigo é uma transição de estado manual, e é aí que o código sem proteção falha. A forma errada é chamar o repositório diretamente e deixar a exceção escapar para a árvore de widgets. A forma certa coloca o estado em carregamento, executa o trabalho dentro de `AsyncValue.guard` e atribui o resultado:

```dart
// flutter_riverpod 3.x
@riverpod
class Articles extends _$Articles {
  @override
  Future<List<Article>> build() => ref.watch(articleRepositoryProvider).fetchAll();

  Future<void> add(String title) async {
    final repo = ref.read(articleRepositoryProvider);

    // Show loading while keeping the current list visible (see "refresh" below).
    state = const AsyncLoading<List<Article>>().copyWithPrevious(state);

    // guard converts a thrown exception into AsyncError instead of crashing.
    state = await AsyncValue.guard(() async {
      await repo.create(title);
      return repo.fetchAll();
    });
  }
}
```

`AsyncValue.guard` é a contraparte do envolvimento automático no `build`. Ele executa seu callback, retorna `AsyncData` em caso de sucesso e `AsyncError` (com o stack trace capturado) em caso de falha, então uma queda de rede durante o `add` vira a tela para sua UI de erro em vez de lançar uma exceção não tratada. A chamada `copyWithPrevious(state)` é o que deixa a lista permanecer na tela durante a mutação em vez de piscar um spinner em tela cheia; o novo `AsyncLoading` carrega o valor antigo, então `value` continua preenchido.

## Manter os dados na tela durante a atualização

Esse é o detalhe que faz todo mundo tropeçar. Quando você faz `ref.refresh` de um provider assíncrono, o estado volta brevemente para carregamento. Se você ingenuamente mostra um spinner para cada estado de carregamento, um "pull-to-refresh" deixa a tela inteira em branco por um frame. O Riverpod 3 lida com isso com duas flags no `.when()`:

- `skipLoadingOnRefresh` tem `true` por padrão. Durante um `ref.refresh` (uma atualização explícita, dirigida pelo usuário), `.when()` continua chamando seu callback `data` com o valor anterior em vez de `loading`.
- `skipLoadingOnReload` tem `false` por padrão. Quando o provider recarrega porque uma dependência mudou, você recebe o callback `loading` por padrão.

Então, de fábrica, um "pull-to-refresh" mantém a lista antiga visível enquanto a nova carrega, que é o que você quer. Se em vez disso você quiser que o spinner apareça ao atualizar, desative:

```dart
articles.when(
  skipLoadingOnRefresh: false, // show the loading callback even on refresh
  data: (list) => ArticleList(items: list),
  loading: () => const Center(child: CircularProgressIndicator()),
  error: (err, _) => ErrorView(message: _humanMessage(err)),
);
```

Para um controle de "pull-to-refresh" especificamente, a combinação idiomática é manter `skipLoadingOnRefresh: true` (para que a lista fique no lugar) e dirigir o `RefreshIndicator` a partir do future retornado:

```dart
RefreshIndicator(
  onRefresh: () => ref.refresh(articlesProvider.future),
  child: articles.when(
    data: (list) => ListView(/* ... */),
    loading: () => const Center(child: CircularProgressIndicator()),
    error: (err, _) => ErrorView(message: _humanMessage(err)),
  ),
);
```

Aguardar com `await` o `articlesProvider.future` faz o spinner do próprio `RefreshIndicator` girar até os novos dados chegarem, enquanto o corpo continua mostrando os dados antigos por baixo. Esse é o comportamento que os usuários esperam.

Uma ressalva que vale conhecer: existe um [issue aberto](https://github.com/rrousselGit/riverpod/issues/4670) em que `skipLoadingOnRefresh` e `skipLoadingOnReload` nem sempre se comportam como documentado porque uma atualização também pode disparar uma recarga. Se sua atualização piscar um spinner de forma inesperada, essa interação é a primeira coisa a verificar.

## Onde o `StateNotifier` legado se encaixa

A consulta de busca que traz as pessoas até aqui frequentemente combina `AsyncValue` com `StateNotifier`, então vale ser preciso sobre como estão as coisas em 2026. A partir do Riverpod 2.0, `Notifier` e `AsyncNotifier` substituíram o `StateNotifier`, e no Riverpod 3 os antigos tipos `StateNotifier` e `StateNotifierProvider` foram movidos para fora do arquivo barril principal, para `package:flutter_riverpod/legacy.dart`. Eles ainda funcionam, mas não são mais a API recomendada.

Se você tem um `StateNotifier` que expõe dados assíncronos, o truque que torna a renderização idêntica a tudo acima é fazer com que seu estado seja um `AsyncValue` você mesmo:

```dart
// Legacy pattern. Import from the legacy barrel in flutter_riverpod 3.x.
import 'package:flutter_riverpod/legacy.dart';

class ArticlesNotifier extends StateNotifier<AsyncValue<List<Article>>> {
  ArticlesNotifier(this._repo) : super(const AsyncLoading()) {
    _load();
  }
  final ArticleRepository _repo;

  Future<void> _load() async {
    state = const AsyncLoading();
    state = await AsyncValue.guard(_repo.fetchAll);
  }
}

final articlesProvider =
    StateNotifierProvider<ArticlesNotifier, AsyncValue<List<Article>>>(
  (ref) => ArticlesNotifier(ref.watch(articleRepositoryProvider)),
);
```

Como `state` é um `AsyncValue<List<Article>>`, o código do widget não muda em nada: `ref.watch(articlesProvider).when(...)` funciona exatamente como antes. A lição é que `AsyncValue` é o contrato da UI; `AsyncNotifier` versus `StateNotifier` é só sobre como você o produz. Quando você de fato migrar, o `AsyncNotifier` elimina o boilerplate (sem construtor manual `_load`, sem `AsyncLoading` manual no construtor) porque o `build` faz isso por você. O [guia oficial de migração a partir do StateNotifier](https://riverpod.dev/docs/migration/from_state_notifier) percorre a substituição mecânica, e o guia mais amplo [como migrar um app Flutter de GetX para Riverpod](/pt-br/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) cobre a mesma tradução de `Notifier` / `AsyncNotifier` no contexto de uma migração completa.

## Erros comuns

**Não leia `requireValue` em um estado de carregamento.** Ele lança `AsyncValueIsLoadingException`. Use-o apenas dentro do ramo `data` ou depois de verificar `hasValue`. Quando você só quer um valor padrão, use `valueOrNull ?? const []`.

**`isLoading` é true ao atualizar, não só no carregamento inicial.** Se você escrever `if (value.isLoading) return Spinner()` antes de verificar `hasValue`, vai deixar a tela em branco a cada atualização. Prefira `.when()` (que respeita `skipLoadingOnRefresh`) ou verifique `value.isLoading && !value.hasValue` para distinguir "primeiro carregamento" de "atualizando com dados já presentes".

**Uma lista vazia é dados, não carregamento.** Uma busca bem-sucedida que retorna `[]` é `AsyncData([])`, então trate o caso vazio dentro do seu ramo `data` (uma view de "Adicione seu primeiro artigo"), não tratando o vazio como ainda-carregando.

**Erros durante uma mutação precisam de `guard`, mas erros no `build` não.** Dentro do `build`, apenas `throw` (ou deixe o repositório lançar); o Riverpod captura. Dentro de um método imperativo como `add`, você deve envolver com `AsyncValue.guard`, caso contrário a exceção escapa do notifier e vira um erro não tratado.

**Use um modelo de erro tipado, não `toString()`.** Mapeie os tipos de exceção para texto voltado ao usuário em um único helper. Se seu modelo de dados usa classes seladas ou `Freezed`, o mesmo benefício de exaustividade que você obtém de `AsyncValue` se aplica aos seus erros de domínio; veja [Dart records vs classes Freezed](/pt-br/2026/05/dart-records-vs-freezed-classes/) para saber quando cada um é a ferramenta certa para modelá-los.

## Testar os três estados

Como o estado é apenas um valor, os testes são diretos: construa um `ProviderContainer`, sobrescreva o repositório com um fake e faça asserções sobre o `AsyncValue`.

```dart
// flutter_test + flutter_riverpod 3.x
test('emits AsyncError when the repository throws', () async {
  final container = ProviderContainer(overrides: [
    articleRepositoryProvider.overrideWithValue(ThrowingRepository()),
  ]);
  addTearDown(container.dispose);

  // Wait for the first build to settle.
  await container.read(articlesProvider.future).catchError((_) => <Article>[]);

  final state = container.read(articlesProvider);
  expect(state, isA<AsyncError>());
});
```

Sobrescreva o repositório para retornar dados, um erro ou um future que nunca completa, e você poderá fazer asserções sobre cada ramo que sua UI renderiza. Esse é o ganho prático de empurrar os três estados para um único valor tipado: o provider, o widget e o teste falam todos a mesma língua. Quando você estiver investigando por que uma transição de estado está travada em vez de errada, a linha do tempo de frames no DevTools te diz se um rebuild é o custo; veja [como fazer profiling de jank em um app Flutter com o DevTools](/pt-br/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) para lê-la.

## Fontes

- [Referência da classe AsyncValue](https://pub.dev/documentation/riverpod/latest/riverpod/AsyncValue-class.html), docs da API do Riverpod (`when`, `guard`, `requireValue`, `copyWithPrevious`).
- [Novidades no Riverpod 3.0](https://riverpod.dev/docs/whats_new) e o [guia de migração de 2.0 para 3.0](https://riverpod.dev/docs/3.0_migration), riverpod.dev.
- [Migrar a partir do StateNotifier](https://riverpod.dev/docs/migration/from_state_notifier), riverpod.dev.
- [Issue #4670 sobre o comportamento de skipLoadingOnRefresh / skipLoadingOnReload](https://github.com/rrousselGit/riverpod/issues/4670), rrousselGit/riverpod.
