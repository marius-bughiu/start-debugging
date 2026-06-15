---
title: "Flutter の FutureBuilder/StreamBuilder と Riverpod の AsyncValue: どちらを使うべきか"
description: "自己完結した使い捨ての非同期ウィジェットには FutureBuilder または StreamBuilder を使います。結果が共有され、キャッシュされ、ミューテートされるようになったら Riverpod の AsyncValue に切り替えます。ここに判断基準、落とし穴、両方の実行可能なコードがあります。Flutter 3.44 と flutter_riverpod 3.3.1 で検証済みです。"
pubDate: 2026-06-15
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "riverpod"
  - "futurebuilder"
lang: "ja"
translationOf: "2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-15
---

Flutter 組み込みの `FutureBuilder` / `StreamBuilder` と Riverpod の `AsyncValue` のどちらを選ぶか迷っている場合、短い答えはこうです。使い捨ての非同期結果を所有する単一の自己完結したウィジェットにはビルダーを使い続け、その結果が画面間で共有され、キャッシュされ、リフレッシュされ、ミューテートされるようになった瞬間に Riverpod の `AsyncValue` に移行してください。ビルダーは同じものの「初心者版」ではありません。1 つの非同期オブジェクトを購読する UI プリミティブです。`AsyncValue` はウィジェットツリーの外側に存在する状態モデルです。本ガイドは Flutter 3.44 (安定版、2026-05-18)、Dart 3.12、`flutter_riverpod` 3.3.1 (3.0 系は 2025-09-10 にリリース) で検証しています。

## それぞれ異なるレイヤーで重なり合う問題を解決します

`FutureBuilder` と `StreamBuilder` はウィジェットです。それぞれに `Future` または `Stream` を渡すと、現在の接続状態 (waiting、active、done) と最新のデータまたはエラーを記述する `AsyncSnapshot<T>` を `builder` コールバックに渡します。ウィジェットは挿入時に購読し、削除時に購読解除し、異なる `Future`/`Stream` インスタンスを渡すと再購読します。これが契約のすべてです。キャッシュも、共有も、ウィジェットがツリーを離れた後の結果の記憶もありません。

Riverpod の `AsyncValue<T>` はウィジェットではまったくありません。プロバイダーが値として公開する 3 つのサブタイプ (`AsyncData`、`AsyncLoading`、`AsyncError`) を持つシールドされた union です。非同期処理はウィジェットツリーの外側に存在するプロバイダー内で実行されるため、どのウィジェットからも読み取れ、複数のウィジェットが同じインスタンスを読み取れ、結果は再ビルドやナビゲーションを生き延びます。`AsyncSnapshot` をレンダリングするのと同じように `value.when(...)` または Dart 3 の `switch` でレンダリングしますが、真実の源はウィジェットのフィールドではなくプロバイダーです。

つまり本当の問いは「どちらが 3 つの状態をよりよくレンダリングするか」ではありません。どちらも 3 つの状態を問題なくレンダリングします。問いは、非同期結果がどこに存在すべきか、そしていくつのものがそれを見る必要があるかです。

## 機能マトリクス

| 観点 | FutureBuilder / StreamBuilder (Flutter 3.44) | Riverpod の AsyncValue (flutter_riverpod 3.3.1) |
| --- | --- | --- |
| 何であるか | 1 つの Future/Stream を購読するウィジェット | プロバイダーが公開するシールドされた状態型 |
| 結果がどこに存在するか | ウィジェット内、ウィジェットのアンマウントで消える | プロバイダー内、ツリーの外側、ナビゲーションを生き延びる |
| 画面間の共有 | なし、各ビルダーが自身の処理を再実行 | あり、1 つのプロバイダーを多数のウィジェットから読み取る |
| キャッシュ / 重複排除 | なし、Future を自分でメモ化する | 組み込み、プロバイダーが無効化まで キャッシュ |
| 再ビルドごとのトリガー | あり、Future を `build` 内で作成した場合 | なし、プロバイダーの `build` は無効化まで一度実行 |
| ローディング + 以前のデータ | 手動、待機中に snapshot が `data` を失う | `value.isLoading` がリフレッシュ中に `value` を保持 |
| ミューテーション / リフレッシュ | Future を再代入して `setState` | notifier 内の `ref.invalidate` または `AsyncValue.guard` |
| ウィジェットなしのテスト | 困難、`pumpWidget` が必要 | 容易、素の `ProviderContainer` でプロバイダーを読み取る |
| 依存関係 | ゼロ、SDK に同梱 | `flutter_riverpod` パッケージ |
| 1 回限りのボイラープレート行数 | 最小限 | 1 つの使い捨て呼び出しにより多くのセットアップ |

## FutureBuilder または StreamBuilder が正しい選択である場合

非同期結果が本当に 1 つのウィジェットに属し、他の誰もそれを必要としない場合は、組み込みのビルダーを使ってください。

- **自己完結したリーフウィジェット。** 1 件のレコードを読み込むダイアログ、画像の寸法を解決するタイル、単一の設定を読む設定行。処理はウィジェットが現れたときに始まり、消えたら無関係になります。それをプロバイダーで包むのは見返りのない儀式です。
- **すでに所有していて直接レンダリングしたいストリーム。** プラグインから `Stream` (`Geolocator` の位置ストリーム、`connectivity_plus` のステータスストリーム) を保持していて 1 か所だけで表示する場合、`StreamBuilder` が最も直接的な道です。Flutter 3.44 の `StreamBuilder` は購読/購読解除のライフサイクルを代わりに処理します。
- **追加依存関係ゼロ。** 小さなアプリ、コードサンプル、パッケージのサンプル、または状態管理ライブラリを意図的に避けたコードベースの画面。ビルダーは SDK の一部なので、追加するものは何もありません。
- **教えているか、プロトタイピングしている。** ビルダーは非同期から UI へのマッピングを 1 か所で見えるようにします。目的が機能を出荷することではなくライフサイクルを理解することである場合、その明快さには大きな価値があります。

正しい形がこちらです。`Future` は `build` ではなく `initState` で一度だけ作成されるため、ウィジェットは親の再ビルドごとに再フェッチしません。

```dart
// Flutter 3.44, Dart 3.12
class UserCard extends StatefulWidget {
  const UserCard({super.key, required this.id});
  final String id;

  @override
  State<UserCard> createState() => _UserCardState();
}

class _UserCardState extends State<UserCard> {
  late Future<User> _user;

  @override
  void initState() {
    super.initState();
    _user = api.fetchUser(widget.id); // created ONCE, not in build
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<User>(
      future: _user,
      builder: (context, snapshot) {
        return switch (snapshot) {
          AsyncSnapshot(connectionState: ConnectionState.waiting) =>
            const CircularProgressIndicator(),
          AsyncSnapshot(hasError: true, :final error) =>
            Text('Failed: $error'),
          AsyncSnapshot(hasData: true, :final data?) =>
            Text(data.name),
          _ => const SizedBox.shrink(),
        };
      },
    );
  }
}
```

このウィジェットで最もよくあるバグは、`future: api.fetchUser(widget.id)` のように `Future` を `build` 内でインラインに作成することです。すると再ビルドのたびに新しい `Future` を割り当て、`FutureBuilder` は新しいアイデンティティを見てローディング状態から再開します。この失敗モードは独自の記事を持つほど一般的です。完全な再現とそれをトリガーするすべてのバリアントについては [なぜ FutureBuilder は再ビルドごとに Future を再作成するのか](/ja/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/) を参照してください。

## Riverpod の AsyncValue が正しい選択である場合

非同期結果が 1 つのウィジェットのプライベートな詳細でなくなったら `AsyncValue` に移行してください。

- **結果が共有される。** 2 つの画面が同じユーザープロフィールを表示する、またはヘッダーとボディが両方とも現在のカートを読む。ビルダーでは各購読者がフェッチを再実行します。プロバイダーでは処理が一度実行され、両方のウィジェットが同じ `AsyncValue` を読みます。
- **キャッシュと重複排除が必要。** Riverpod は何かが無効化するまでプロバイダーの値をキャッシュします。ナビゲーションで離れて戻ると、スピナーがちらつくのではなくデータがまだそこにあります。3.0 系はさらに `AsyncValue.isFromCache` を追加しており、UI はサーバーのデータとオフライン永続化されたデータを区別できます。
- **ミューテートしてリフレッシュする。** pull-to-refresh、楽観的更新、リトライ。`ref.invalidate(provider)` は読み込みを再実行し、その再読み込み中は `value.hasValue` が `true` のまま `value.isLoading` が `true` になるため、画面を空白にせずに古いデータを表示し続けます。これを `FutureBuilder` で行うには、保存した `Future`、`setState`、そして独自の「以前のデータを保持する」ロジックを操ることになります。
- **ウィジェットを立ち上げずにテストしたい。** プロバイダーのロジックは `WidgetTester` なし、`pumpWidget` なし、偽の `BuildContext` なしで素の `ProviderContainer` で実行できます。

同じ 3 状態のレンダリングを、今度はプロバイダーから取得します。

```dart
// Flutter 3.44, Dart 3.12, flutter_riverpod 3.3.1
final userProvider = FutureProvider.family<User, String>((ref, id) {
  return api.fetchUser(id); // runs once, cached per id, shared everywhere
});

class UserCard extends ConsumerWidget {
  const UserCard({super.key, required this.id});
  final String id;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = ref.watch(userProvider(id));
    return switch (user) {
      AsyncData(:final value) => Text(value.name),
      AsyncError(:final error) => Text('Failed: $error'),
      _ => const CircularProgressIndicator(),
    };
  }
}
```

`ref.watch(userProvider('42'))` を呼ぶ 2 つのウィジェットは 1 つのフェッチと 1 つのキャッシュされた結果を共有します。プロバイダーは無効化されるまで引数ごとに `build` をちょうど一度実行するため、`initState` も、保存フィールドも、覚えておくべき「Future を一度だけ作成する」という規律もありません。状態の完全なセット、`AsyncValue.guard` でのミューテーション、リフレッシュ時の以前のデータの保持については [AsyncValue でローディングとエラーの状態を表示する方法](/ja/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) を参照してください。

## 実際に決め手となる再ビルドと再フェッチの挙動

ここでパフォーマンスは軸ではありません。どちらのアプローチも同じフレームレートでレンダリングします。異なるのは非同期処理が何回実行されるかであり、これは生の速度ではなく正しさとコストの問題です。

非同期呼び出しの中にカウンターを置き、周囲のウィジェットが再ビルドされるとき (テーマの切り替え、キーボードが開く、親の `setState`) に何が起こるかを観察してください。

- **FutureBuilder で `build` 内に作成された Future**: フェッチは再ビルドのたびに発火します。スクロール中に 10 回再ビルドされる画面は 10 回のネットワーク呼び出しを行います。これはエッジケースではなくデフォルトの間違いです。
- **FutureBuilder で `initState` に引き上げられた Future**: フェッチはウィジェットインスタンスごとに一度発火します。ナビゲーションで離れて戻ると、古い `State` がなくなっているためウィジェットはゼロから再ビルドされ、再びフェッチします。
- **AsyncValue を持つ FutureProvider**: フェッチはプロバイダー引数ごとに一度発火し、キャッシュされます。再ビルドはそれを再実行しません。ナビゲーションで離れて戻るとキャッシュを読みます。無効化するか依存関係が変わったときにだけ再実行されます。

非同期処理が安価なローカル読み取りであれば、これらは何も問題にならず、ビルダーが単純さで勝ちます。ネットワーク呼び出し、データベースクエリ、あるいはコストやレート制限のある何かであれば、キャッシュこそが `AsyncValue` が存在する理由そのものであり、同じ挙動を `FutureBuilder` の周りで手作業で再実装するのは Riverpod のプロバイダーキャッシュの劣化版を再実装することになります。

## あなたの代わりに決めてしまう落とし穴

いくつかの制約は好みに関係なく判断を決めてしまいます。

**すでに Riverpod を使っている。** アプリにプロバイダーがあるなら、それらを読む画面に `FutureBuilder` を混ぜないでください。プロバイダーのデータを読み、その後別の非同期呼び出しを 2 つ目の `FutureBuilder` で包むと、1 つの画面に無関係な 2 つのライフサイクルと、「loading」が true になりうる 2 か所が生まれます。2 つ目の呼び出しもプロバイダーとして公開し、両方を `AsyncValue` でレンダリングしてください。ここでの一貫性は、画面の半分が古くなるクラスのバグを防ぎます。

**結果がウィジェットより長生きする必要がある。** `initState` でフェッチされたものはすべて `State` とともに消えます。ユーザーが前に進んで戻り、毎回新しいスピナーと新しいネットワーク呼び出しを望まないなら、ウィジェットの上に存在するキャッシュが必要です。それがプロバイダーです。`FutureBuilder` はどう配置してもルート間の永続性を与えられません。

**await の後で `ref` に触れる。** これは Riverpod 固有の罠であり、避ける理由ではありません。notifier 内で `await` し、それをトリガーしたウィジェットが消えた後に `ref` を読むと、`Cannot use "ref" after the widget was disposed` に遭遇します。修正は await の前に必要なものを取得することです。採用する前に知っておく価値があり、[破棄後に ref を使う問題の修正](/ja/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/) で扱っています。

**明示的に依存関係ゼロを望む。** pub パッケージのサンプル、再現ケース、または状態管理ライブラリに反対するチームポリシーはビルダーを強制します。これは正当な制約であり、ビルダーは自己完結した非同期 UI には十分に有能です。

## StreamBuilder にはもう 1 つの注意点があります

上記すべては `Future` の処理に当てはまります。ストリームは購読のライフサイクルを追加し、それは非自明なものすべてについて判断をもう少し Riverpod 寄りに傾けます。`StreamBuilder` は新しい `Stream` インスタンスを渡すと再購読し、ツリーを離れると購読解除しますが、マルチキャストはしません。同じ単一購読ストリームに対する 2 つの `StreamBuilder` はエラーをスローします。単一購読の `Stream` は 1 つのリスナーしか許さないからです。Riverpod の `StreamProvider` はストリームの前に位置するため、複数のウィジェットが購読を奪い合うことなく 1 つの `AsyncValue` を読み、最新の値は遅れて来た購読者のためにキャッシュされます。ストリームがちょうど 1 か所で表示されるなら `StreamBuilder` で問題ありません。複数のウィジェットがそれを必要とするなら、`StreamProvider` が単一リスナーの問題を完全に取り除きます。

## 背後の完全な文脈とともに、推奨事項

共有され、キャッシュされ、リフレッシュされ、ミューテートされる非同期結果には、デフォルトで Riverpod の `AsyncValue` を使ってください。実際のアプリではそのほとんどがそうです。N 回ではなく 1 回のフェッチ、ナビゲーションをまたぐ無料のキャッシュ、リフレッシュ時に以前のデータを保持する `isLoading`、そしてウィジェットなしでテストできるロジックが得られます。`FutureBuilder` と `StreamBuilder` は、本当に自己完結した使い捨ての非同期 UI のために取っておいてください。1 つのものを読み込み、表示し、アンマウントで忘れるリーフウィジェット、特に状態管理の依存関係を持たないアプリでです。ビルダーは卒業する補助輪ではありません。非同期結果の観客が 1 人のときには正しいツールであり、観客が 2 人になった瞬間に間違ったツールになります。慣れ親しみではなく所有によって選んでください。

より広く状態管理のアプローチをまだ選んでいる場合、パッケージ間のトレードオフは [2026 年の Flutter 状態管理における Provider と Riverpod と Bloc](/ja/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) にあります。そして非同期 UI が失敗を露呈し続けるなら、[Flutter アプリでネットワークエラーを優雅に処理する方法](/ja/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) が、スローされた例外を両方のモデルでクリーンなエラー状態に変える方法を扱っています。

## 出典

- [FutureBuilder クラス、Flutter API ドキュメント](https://api.flutter.dev/flutter/widgets/FutureBuilder-class.html)
- [StreamBuilder クラス、Flutter API ドキュメント](https://api.flutter.dev/flutter/widgets/StreamBuilder-class.html)
- [AsyncValue クラス、flutter_riverpod API ドキュメント](https://pub.dev/documentation/flutter_riverpod/latest/flutter_riverpod/AsyncValue-class.html)
- [Riverpod 3.0 の新機能](https://riverpod.dev/docs/whats_new)
- [pub.dev の riverpod changelog](https://pub.dev/packages/riverpod/changelog)
