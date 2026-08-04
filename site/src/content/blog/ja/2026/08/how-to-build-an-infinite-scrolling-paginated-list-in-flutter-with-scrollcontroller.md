---
title: "Flutter で ScrollController を使って無限スクロールのページネーションリストを作る方法"
description: "ScrollController を ListView.builder に取り付け、position.extentAfter がプリフェッチのしきい値を下回ったら次のページを要求し、そのリクエストを isLoading / hasMore / error のフラグでガードします。完全な実装と、最初のページが短すぎる場合の落とし穴も解説します。"
pubDate: 2026-08-04
template: how-to
tags:
  - "flutter"
  - "dart"
  - "listview"
  - "scrollcontroller"
  - "pagination"
  - "how-to"
lang: "ja"
translationOf: "2026/08/how-to-build-an-infinite-scrolling-paginated-list-in-flutter-with-scrollcontroller"
translatedBy: "claude"
translationDate: 2026-08-04
---

Flutter で無限スクロールのリストを作るには、`ScrollController` を `ListView.builder` に取り付け、スクロールの変化を監視し、`position.extentAfter` が数百ピクセルのプリフェッチしきい値を下回った時点で次のページを要求します。リスナー自体は冪等でなければなりません。リスナーはスクロールのフレームごとに発火するため、実際の取得処理は `isLoading` / `hasMore` / `error` のガードの後ろに置く必要があります。そうしないと、一度のフリックで同じリクエストを十数回投げることになります。この記事では Flutter 3.44.8 (Dart 3.12.2) 上で全体を組み立て、そのうえで本番環境で実際に起きる 2 つの失敗パターン、つまりスクロールできないほど短い最初のページと、停止した API を叩き続けるリトライループを扱います。

## `pixels >= maxScrollExtent` が誤ったトリガーである理由

ほとんどのチュートリアルはここから始まります。

```dart
// Flutter 3.44.8, Dart 3.12.2 -- do not ship this
_controller.addListener(() {
  if (_controller.position.pixels >= _controller.position.maxScrollExtent) {
    _loadMore();
  }
});
```

これには 3 つの問題があります。

第一に、`ScrollController` はスクロール位置が変わるたびにリスナーへ通知します。フリック中であれば 60Hz または 120Hz でフレームごとに 1 回です。`_loadMore()` がガードのない `await api.fetch(...)` であれば、リストが最下部に張り付いている間ずっと条件が真のままになり、最初のレスポンスが返るまでフレームごとに新しいリクエストを投げ続けます。往復 300ms のネットワークで 120Hz の端末なら、およそ 36 回の重複リクエストになります。

第二に、`maxScrollExtent` はちょうど最下部です。そこに到達するのを待つということは、追加の要求を始める前にユーザーのコンテンツが尽きているということであり、ネットワークの往復時間のあいだ空白を眺めることになります。Flutter の viewport は可視領域の外側に `RenderAbstractViewport.defaultCacheExtent`、つまり `250.0` 論理ピクセルの `cacheExtent` を構築します。この帯にまだコンテンツが残っているうちに発火させれば、取得処理はスクロールの後追いではなく、スクロールと重なって進みます。

第三に、`ScrollController.position` は無条件に触ってよいものではありません。このゲッターは 2 つのアサーションの奥にあります。

```dart
ScrollPosition get position {
  assert(_positions.isNotEmpty, 'ScrollController not attached to any scroll views.');
  assert(_positions.length == 1, 'ScrollController attached to multiple scroll views.');
  return _positions.single;
}
```

どちらもデバッグビルドで発火し、どちらもごく普通のコードから到達可能です。詳しくは後述の落とし穴を参照してください。

最初の 2 点に対する修正は、`extentAfter` で発火させることです。`ScrollPosition` のドキュメントはこれを、viewport の概念上の下側にあるコンテンツの量と定義しています。`extentAfter` が 400 のとき、ユーザーの手元にはまだ構築済みの行が 400 論理ピクセル分残っており、通常はこれだけあれば取得処理を完全に隠せます。

## 4 つのステップで組み立てる

このパターン全体は 4 つの可動部からできています。それ以外はすべて表示の問題です。

1. **ページネーションの状態はビルダーではなく `State` に持たせます。** 蓄積された `List<T>`、次のリクエスト用のカーソルまたはページ番号、そして `_isLoading`、`_hasMore`、`_error` の 3 つのフラグが必要です。この 3 つのフラグこそが、スクロールリスナーをフレームごとに呼んでも安全にしている要素です。
2. **`ScrollController` は `initState` で取り付け、`dispose` で取り外します。** コントローラーの `dispose()` の前に `removeListener` を呼び、最初のページは `initState` から開始して、最初のフレームでローディング表示のない空のリストが出ないようにします。
3. **`pixels` ではなく `extentAfter` で発火させます。** リスナーの中では、コントローラーにクライアントがない場合、すでに取得処理が進行中の場合、サーバーが次のページはないと答えた場合、直前の試行が失敗した場合には、すぐに抜けます。そのうえで初めて `extentAfter` をプリフェッチのしきい値と比較します。
4. **末尾の状態のために 1 行だけ余分に描画します。** 読み込むものが残っているか表示すべきエラーがあるあいだは `itemCount` を `items.length + 1` にし、`itemBuilder` はその最後のインデックスに対してローディング表示、リトライ用の行、または何も返さないようにします。これによってローディング状態が、ユーザーに見えて操作できるものになります。

## 完全な実装

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

`_onScroll` と `_loadMore` の分離に注目してください。`_onScroll` は `_error != null` のときは実行を拒否しますが、`_loadMore` は拒否しません。この非対称性は意図的なもので、後述するリトライループを止めているのがこれです。スクロールリスナーが失敗したページを自動で再試行することは決してありませんが、リトライボタンは先に `_error` をクリアするので再試行できます。

`finally` ブロックでは、`mounted` を確認する前に `_isLoading = false` を素の代入として実行しています。この代入を、マウント済みのときだけ動く `setState` の中に入れてしまうと、リクエスト中にアンマウントされたときにフラグが true のまま残ります。破棄済みのウィジェットにとっては無害ですが、同じコントローラーのロジックを後から Riverpod の notifier に持ち上げたときに、状態機械の見通しが悪くなります。

## スクロールできない短い最初のページ

これは本番環境に到達することがもっとも多いバグです。背の高い画面でしか現れないからです。1 ページ目が 20 行を返し、viewport には 30 行入るとすると、`maxScrollExtent` は `0.0` になり、スクロール自体ができず、`ScrollController` は一度も通知せず、リストは 20 件のまま固定されます。縦向きのスマートフォンでは完璧に動き、タブレット、デスクトップ、ウィンドウを最大化した Web では壊れて見えます。

何もスクロールしていないので、ここでは `ScrollController` は役に立ちません。もっとも安価な修正は、新しい行をレイアウトしたフレームの後に再チェックすることです。

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

これを `_loadMore` の成功分岐の末尾で呼びます。この処理は必ず終了します。各パスは、コンテンツを viewport より高くするか (この場合 `maxScrollExtent > 0` になります)、フィードを使い切るか (この場合 `_hasMore` が false になります) のどちらかだからです。

より網羅的な修正は `ScrollMetricsNotification` です。これはスクロール可能領域の `ScrollMetrics` がスクロールなしで変化したときに Flutter が送出するもので、コンテンツが増減したときや、親ウィンドウのサイズが変わったときも含まれます。リストをこれで包むと、タブレットのケース、デスクトップでのウィンドウリサイズのケース、そしてソフトウェアキーボードが閉じて viewport が突然高くなるケースをまとめて拾えます。

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

`onNotification` からは `false` を返してください。`true` を返すと通知がツリーを上っていくのを打ち切ってしまい、それに依存している祖先、たとえば `Scrollbar` や `RefreshIndicator` を静かに壊します。

## 停止した API を叩き続けるリトライループ

`_onScroll` のガードが `if (_isLoading || !_hasMore) return;` だけだったとしましょう。ユーザーは最下部にいて、リクエストが失敗し、`_isLoading` は false になり、`_hasMore` はまだ true、そして位置は動いていません。次のスクロール通知は、ユーザーの指がわずかに動いた瞬間に届き、再び `_loadMore` を呼びます。失敗するたびに即座に次のリクエストが生まれるので、ネットワーク障害はそのままリクエストの洪水になり、無線を起こし続けてバッテリーを消耗させます。

スクロール側のガードに `_error != null` を加えると、失敗は明示的なユーザー操作でしか解除されない終端状態になります。自動復帰が欲しい場合は、スクロールリスナーの後ろではなくバックオフの後ろに置き、試行回数に上限を設けてください。その一般形と、どの例外なら再試行する価値があるかについては、[Flutter アプリでネットワークエラーを丁寧に扱う方法](/ja/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/)を参照してください。

## 踏むことになる落とし穴

1. **`ScrollController not attached to any scroll views.`** 最初のレイアウト前、あるいは `ListView` がすでに消えた後に `.position` を読むと、このアサーションが発火します。`Navigator.pop` を生き延びた post-frame コールバックから踏むのが典型です。すべてのアクセスを `hasClients` でガードしてください。中身は単に `_positions.isNotEmpty` です。
2. **`ScrollController attached to multiple scroll views.`** コントローラーが位置を報告できるのは、ちょうど 1 つのスクロール可能領域がそれを使っている場合だけです。`TabBarView` の中にある 2 つの `ListView` に同じ `_controller` を渡すのが、ここに踏み込む典型的な経路です。各タブにはそれぞれのコントローラーと、それぞれのページネーション状態が必要です。
3. **オフセット方式のページネーションは生きたフィードではずれます。** ユーザーが 2 ページ目と 3 ページ目のあいだにいるときにサーバーが行を挿入すると、`?page=3&size=20` は 2 ページ目と重なる範囲を返すので、ユーザーには重複が見え、1 件が抜け落ちます。カーソル方式にはこの失敗パターンがありません。上の例がページ番号ではなく `nextCursor` を引き回しているのはそのためです。サーバー側の話は、必要な SQL とインデックスも含めて [EF Core 11 での keyset (カーソル) ページネーション](/ja/2026/06/how-to-do-keyset-cursor-pagination-in-ef-core-11/)にあります。
4. **`dispose` 後の `setState`。** `_loadMore` にある `await` はすべて、ユーザーが戻るを押せる地点です。各 await の後の `if (!mounted) return;` は省略可能ではありません。これがないと `setState() called after dispose()` が出ます。先頭で一度だけではなく、なぜ中断のたびに `mounted` を確認し直す必要があるのかを含む完全なルールは、[非同期の中断後に mounted チェックで setState を守る方法](/ja/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/)にあります。
5. **コントローラーは自分が所有する破棄対象です。** `ScrollController` は `ChangeNotifier` を継承しています。生成した `State` が破棄しなければ、リスナーのクロージャがその `State` とそこで捕捉したすべてを生かし続けます。これは破棄し忘れた `TextEditingController` や `AnimationController` と同じ種類のメモリリークで、[Flutter でメモリリークを避けるためにコントローラーを破棄する方法](/ja/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)で扱っています。
6. **`shrinkWrap: true` は目的そのものを壊します。** shrink wrap されたリストは自分のサイズを測るために最初のフレームですべての子を構築するので、無限リストは無限に膨らむ初回フレームコストになります。高さが未確定というエラーを黙らせるためにこれに手を伸ばしたのであれば、正しい代替案は [長いリストにおける shrinkWrap と Expanded と sliver の比較](/ja/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/)で整理しています。

## コントローラーの代わりに `NotificationListener` を使う場面

スクロールのメトリクスを読む方法は `ScrollController` だけではありません。`NotificationListener<ScrollNotification>` は、コントローラーをまったく所有せずに `notification.metrics` から同じ数値を得られます。

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

スクロール可能領域が自分のものではない場合はこちらを選んでください。`NestedScrollView` の中、`PrimaryScrollController` の下、あるいはリストが複数の sliver セクションを持つ `CustomScrollView` で、コントローラー 1 つではどれを指しているのか曖昧になる場合です。`ScrollEndNotification` はコントローラーのリスナーよりはるかに発火回数が少ないので、フレームごとのコストという懸念も消えます。ただし、フリックの途中でプリフェッチできないという代償があります。

スクロールを*操作*する必要があるときはコントローラーを選んでください。`jumpTo`、`animateTo`、オフセットの復元、挿入したばかりの項目までのスクロールなどです。リストが他のコンテンツと viewport を共有している場合も、sliver 版がそのまま当てはまります。ページネーションのロジックは同一で、変わるのは包むウィジェットだけです。詳しくは [sliver で ListView と GridView を 1 つのスクロールに混在させる方法](/ja/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/)を参照してください。

## パッケージを使うべきかどうか

`infinite_scroll_pagination` 5.1.1 は、この状態機械を `PagingController` と `PagedListView`、`PagingListener` としてまとめ、末尾の状態、最初のページが短いケース、pull to refresh との統合まで面倒を見てくれます。ページネーションのある画面が多いアプリなら妥当な依存関係です。代替手段は上の `State` を 5 回コピーすることだからです。

手書きにするのは、ページネーションのあるリストが 1 つか 2 つのとき、ページネーション状態がすでに Riverpod や Bloc にあるとき (この場合コントローラーは単なるトリガーであり、パッケージ側のコントローラーは余分です)、あるいは API のページング契約が特殊すぎて抽象と戦うことになるときです。これを Riverpod に組み込む場合、ローディングとエラーの分岐は `AsyncValue` にきれいに対応します。これは [Flutter Riverpod で AsyncValue を使ってローディングとエラーの状態を表示する方法](/ja/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)で扱っています。

## 参考資料

- [ScrollPosition class](https://api.flutter.dev/flutter/widgets/ScrollPosition-class.html)、Flutter API ドキュメント (`extentAfter`、`maxScrollExtent`、`atEdge`)
- [ScrollController class](https://api.flutter.dev/flutter/widgets/ScrollController-class.html)、Flutter API ドキュメント (`hasClients`、`position`、`keepScrollOffset`)
- [ScrollMetricsNotification class](https://api.flutter.dev/flutter/widgets/ScrollMetricsNotification-class.html)、Flutter API ドキュメント
- [RenderAbstractViewport.defaultCacheExtent](https://api.flutter.dev/flutter/rendering/RenderAbstractViewport/defaultCacheExtent-constant.html)、Flutter API ドキュメント
- [Flutter 3.44.0 リリースノート](https://docs.flutter.dev/release/release-notes/release-notes-3.44.0)、Flutter ドキュメント
- [pub.dev の infinite_scroll_pagination](https://pub.dev/packages/infinite_scroll_pagination)
