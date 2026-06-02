---
title: "Flutter Riverpod で AsyncValue を使ってローディングとエラーの状態を表示する方法"
description: "Riverpod 3 で単一の AsyncValue からローディング、データ、エラーの状態をレンダリングします。ミューテーションには AsyncNotifier と AsyncValue.guard を、UI には .when() と switch のパターンマッチングを使い、更新時に以前のデータを保持し、レガシーな StateNotifier パターンを移行します。flutter_riverpod 3.x、Flutter 3.44、Dart 3.x でテスト済みです。"
pubDate: 2026-06-02
template: how-to
tags:
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
  - "how-to"
lang: "ja"
translationOf: "2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod"
translatedBy: "claude"
translationDate: 2026-06-02
---

短くまとめると、Riverpod の非同期 provider は `AsyncValue<T>` を渡してきます。これは常に 3 つの状態（データ、ローディング、エラー）のうちちょうど 1 つにある単一のオブジェクトです。これら 3 つを一箇所から `value.when(data: ..., loading: ..., error: ...)`、または `AsyncData` / `AsyncLoading` / `AsyncError` に対する Dart 3 の `switch` でレンダリングします。これらの状態は、`build` が `Future` を返す `AsyncNotifier` から生み出し、`AsyncValue.guard` で安全に変更します。`AsyncValue.guard` は、スローされた例外をクラッシュさせる代わりに `AsyncError` に変換します。古い `StateNotifier` を使っている場合でも、`AsyncValue` を状態として公開すれば、レンダリング側はまったく同じです。このガイドは `flutter_riverpod` 3.x（3.0 系列は 2026 年初頭にリリース）、Flutter 3.44、Dart 3.x でテストしています。

このパターンが重要なのは、実際のアプリのほぼすべての画面が非同期だからです。何かを取得し、その取得は進行中になりうるし、失敗もしうる。これを手作業で組むチームは、3 つの別々のフィールド（`isLoading`、`data`、`errorMessage`）と `if` 分岐のもつれ、そして `isLoading` が `false` なのに早期リターンがフラグの切り替えを忘れたせいで `data` がまだ `null` という典型的なバグに行き着きます。`AsyncValue` は不正な状態を表現不可能にします。型が封印されたユニオンなので、「ローディング中で、しかもエラーがあって、しかもデータがある」という状態は存在しません。コンパイラが扱うよう強制する 3 つのケースを扱えば、それで完了です。

## 3 つの状態と、なぜユニオンが 3 つの真偽値に勝るのか

`AsyncValue<T>` は 3 つの具体的なサブタイプを持つ封印された (sealed) クラスです。

- `AsyncData<T>` は型 `T` の `value` を保持します。
- `AsyncLoading<T>` はローディングが進行中であることを意味します。
- `AsyncError<T>` は `error`（`Object`）と `stackTrace` を保持します。

クラスが封印されているため、アナライザーはサブタイプのリストが閉じていることを把握します。したがって、これらに対する `switch` はデフォルトケースなしで網羅的になります。これが設計のすべてです。リビルドのたびに null 許容フィールドの寄せ集めから「自分はどの状態にいるのか」を再構築する代わりに、型が答えをすでにエンコードしている値に対してパターンマッチングを行うのです。

また、頻繁に手を伸ばすことになる便利なゲッターもあります。

- `isLoading`、`hasValue`、`hasError` は真偽値です。
- `value` は null 許容の `T?` です（`isLoading` が true の間でも非 null になりうる点が更新時に重要です。下記参照）。
- `valueOrNull` は決してスローしない安全なアクセサーです。
- `requireValue` は値を返すか、`AsyncValueIsLoadingException` をスローするか、エラーを再スローします。データ状態にいることをすでに証明した場合にのみ使ってください。
- `isRefreshing` と `isReloading` は、強制的な更新と依存関係による再計算を区別します。

## 具体的な画面: ローディングと失敗が起こりうる記事一覧

最小限の現実的なセットアップを示します。一覧を取得するリポジトリ、それを公開する provider、そして 3 つの状態すべてをレンダリングするウィジェットです。ここでは `riverpod_annotation` を使ったコード生成版を使っています。これは 3.x 系列で provider を宣言する推奨方法です。

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

`build` メソッドは `Future<List<Article>>` を返します。Riverpod がその future をあなたの代わりにラップします。保留中の間は `ref.watch(articlesProvider)` は `AsyncLoading` であり、完了すると `AsyncData`、スローすると `AsyncError` になります。初期ローディングのためにこれらの状態を手作業で構築することは決してありません。データを返すか、例外を伝播させるだけです。

コード生成を使わない場合、手書きの形はアノテーションなしの同じクラス構造です。

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

## `.when()` で 3 つの状態すべてをレンダリングする

`.when()` は `AsyncValue` をウィジェットにマッピングする最も直接的な方法です。3 つの必須コールバックを受け取ります。

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

3 つの点に注目してください。第一に、`ref.invalidate(articlesProvider)` は再試行ボタンが `build` を再実行する方法です。キャッシュされた状態を破棄して再計算します。`ref.refresh` は同じことを行い、必要なら新しい値を返します。第二に、`error` コールバックはエラーオブジェクトとそのスタックトレースの両方を受け取るので、トレースをログに記録し、ユーザーには分かりやすいメッセージを表示できます。`err.toString()` を画面にそのまま出してはいけません。第三に、`_humanMessage` は例外の型を文言に翻訳する場所であり、これは失敗を適切に分類することと噛み合います。そこに属する例外からメッセージへのマッピングについては、[Flutter アプリでネットワークエラーを適切に処理する方法](/ja/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/)を参照してください。

## Dart 3 の代替案: `switch` パターンマッチング

`AsyncValue` は封印されているため、それに対して直接パターンマッチングできます。自然に読め、1 行で分解できるため、多くのチームが Riverpod 3 でこれを好みます。

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

`_` のアームは `AsyncLoading` を捕捉します。機能的にはこれは `.when()` と等価ですが、ガードを追加したいときによく合成できます（例: `AsyncData(:final value) when value.isEmpty => const EmptyState()`）。チームが読みやすいと感じる方を使ってください。どちらも同じ UI を生み出します。

## ミューテーション: なぜ `AsyncValue.guard` が必要なのか

初期ローディングは自動ですが、記事を作成または削除するボタンは手動の状態遷移であり、まさにそこで保護されていないコードがクラッシュします。誤った方法は、リポジトリを直接呼び出して例外をウィジェットツリーに逃がすことです。正しい方法は、状態をローディングに設定し、`AsyncValue.guard` の内部で処理を実行して、結果を代入することです。

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

`AsyncValue.guard` は `build` での自動ラップに対応するものです。コールバックを実行し、成功時には `AsyncData`、失敗時には（捕捉したスタックトレース付きの）`AsyncError` を返します。したがって `add` の最中のネットワーク断は、未処理の例外をスローする代わりに、画面をエラー UI に切り替えます。`copyWithPrevious(state)` の呼び出しは、ミューテーションの間に全画面スピナーをちらつかせる代わりに一覧を画面に残すためのものです。新しい `AsyncLoading` が古い値を保持するので、`value` は依然として埋まっています。

## 更新中もデータを画面に残す

これは誰もがつまずく細部です。非同期 provider を `ref.refresh` すると、状態は一時的にローディングに戻ります。すべてのローディング状態に対して素朴にスピナーを表示すると、プルして更新する操作で 1 フレームのあいだ画面全体が空白になります。Riverpod 3 はこれを `.when()` の 2 つのフラグで処理します。

- `skipLoadingOnRefresh` はデフォルトで `true` です。`ref.refresh`（明示的でユーザー起点の更新）の間、`.when()` は `loading` の代わりに以前の値で `data` コールバックを呼び続けます。
- `skipLoadingOnReload` はデフォルトで `false` です。依存関係が変わったために provider が再ロードされると、デフォルトで `loading` コールバックを受け取ります。

つまりそのままで、プルして更新する操作は新しい一覧をロードする間も古い一覧を表示したままにします。これがあなたの望むものです。代わりに更新時にスピナーを出したい場合は、オプトアウトします。

```dart
articles.when(
  skipLoadingOnRefresh: false, // show the loading callback even on refresh
  data: (list) => ArticleList(items: list),
  loading: () => const Center(child: CircularProgressIndicator()),
  error: (err, _) => ErrorView(message: _humanMessage(err)),
);
```

プルして更新するコントロールに特化して言えば、慣用的な組み合わせは `skipLoadingOnRefresh: true` を保ち（一覧をその場に留め）、返される future から `RefreshIndicator` を駆動することです。

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

`articlesProvider.future` を `await` で待つと、`RefreshIndicator` 自体のスピナーは新しいデータが届くまで回り続け、その間も本体は下に古いデータを表示し続けます。これがユーザーの期待する挙動です。

知っておく価値のある注意点が 1 つあります。更新が再ロードも引き起こしうるため、`skipLoadingOnRefresh` と `skipLoadingOnReload` がドキュメントどおりに常に振る舞うわけではないという[未解決の issue](https://github.com/rrousselGit/riverpod/issues/4670) があります。更新が予期せずスピナーをちらつかせる場合、まず確認すべきはこの相互作用です。

## レガシーな `StateNotifier` の位置づけ

ここに人々を連れてくる検索クエリは、`AsyncValue` と `StateNotifier` を組み合わせることが多いので、2026 年時点の状況を正確にしておく価値があります。Riverpod 2.0 以降、`Notifier` と `AsyncNotifier` が `StateNotifier` を置き換え、Riverpod 3 では古い型 `StateNotifier` と `StateNotifierProvider` がメインのバレルファイルから `package:flutter_riverpod/legacy.dart` へ移されました。これらは依然として動作しますが、もはや推奨 API ではありません。

非同期データを公開する `StateNotifier` がある場合、レンダリングを上記すべてと同一にするコツは、その状態を自分で `AsyncValue` にすることです。

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

`state` が `AsyncValue<List<Article>>` なので、ウィジェットのコードはまったく変わりません。`ref.watch(articlesProvider).when(...)` は以前とまったく同じように動作します。教訓は、`AsyncValue` が UI の契約であり、`AsyncNotifier` か `StateNotifier` かは、それをどう生み出すかだけの違いだということです。実際に移行すると、`build` が代わりにやってくれるため、`AsyncNotifier` はボイラープレート（手書きのコンストラクタ `_load` も、コンストラクタ内の手書きの `AsyncLoading` も）を取り除きます。[StateNotifier からの公式移行ガイド](https://riverpod.dev/docs/migration/from_state_notifier)が機械的な置き換えを順を追って説明しており、より広範なガイド [Flutter アプリを GetX から Riverpod へ移行する方法](/ja/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/)は、完全な移行という文脈で同じ `Notifier` / `AsyncNotifier` への翻訳を扱っています。

## よくある落とし穴

**ローディング状態で `requireValue` を読まないこと。** これは `AsyncValueIsLoadingException` をスローします。`data` 分岐の内側か、`hasValue` を確認した後にのみ使ってください。単にフォールバックが欲しいだけなら、`valueOrNull ?? const []` を使ってください。

**`isLoading` は初期ローディングだけでなく更新時にも true になります。** `hasValue` を確認する前に `if (value.isLoading) return Spinner()` と書くと、更新のたびに画面を空白にしてしまいます。`.when()`（`skipLoadingOnRefresh` を尊重します）を優先するか、「初回ロード」と「データがすでにあるなかでの更新中」を区別するために `value.isLoading && !value.hasValue` を確認してください。

**空のリストはデータであって、ローディングではありません。** `[]` を返す成功した取得は `AsyncData([])` です。したがって空を依然としてローディング中として扱うのではなく、空のケースは `data` 分岐の内側で扱ってください（「最初の記事を追加してください」というビューなど）。

**ミューテーション中のエラーには `guard` が必要ですが、`build` 内のエラーには不要です。** `build` の内側では単に `throw` する（あるいはリポジトリにスローさせる）だけで、Riverpod が捕捉します。`add` のような命令的メソッドの内側では `AsyncValue.guard` でラップしなければならず、そうしないと例外が notifier から逃げて未処理エラーになります。

**`toString()` ではなく型付きのエラーモデルを使うこと。** 例外の型をユーザー向けの文言に 1 つのヘルパーでマッピングしてください。データモデルが封印クラスや `Freezed` を使っているなら、`AsyncValue` から得られるのと同じ網羅性の利点がドメインのエラーにも当てはまります。それぞれをモデリングするのにどちらが適切な道具かについては、[Dart records と Freezed クラス](/ja/2026/05/dart-records-vs-freezed-classes/)を参照してください。

## 3 つの状態をテストする

状態はただの値なので、テストは素直です。`ProviderContainer` を構築し、リポジトリをフェイクでオーバーライドして、`AsyncValue` についてアサートします。

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

リポジトリをデータ、エラー、あるいは決して完了しない future を返すようにオーバーライドすれば、UI がレンダリングするすべての分岐についてアサートできます。これが、3 つの状態すべてを 1 つの型付きの値に押し込むことの実践的な見返りです。provider、ウィジェット、テストがみな同じ言葉を話します。状態遷移が誤っているのではなくカクついている理由を追っているときは、DevTools のフレームタイムラインがリビルドがコストかどうかを教えてくれます。その読み方については、[DevTools で Flutter アプリのジャンクをプロファイリングする方法](/ja/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/)を参照してください。

## 出典

- [AsyncValue クラスリファレンス](https://pub.dev/documentation/riverpod/latest/riverpod/AsyncValue-class.html)、Riverpod API ドキュメント（`when`、`guard`、`requireValue`、`copyWithPrevious`）。
- [Riverpod 3.0 の新機能](https://riverpod.dev/docs/whats_new) と [2.0 から 3.0 への移行ガイド](https://riverpod.dev/docs/3.0_migration)、riverpod.dev。
- [StateNotifier からの移行](https://riverpod.dev/docs/migration/from_state_notifier)、riverpod.dev。
- [skipLoadingOnRefresh / skipLoadingOnReload の挙動に関する issue #4670](https://github.com/rrousselGit/riverpod/issues/4670)、rrousselGit/riverpod。
