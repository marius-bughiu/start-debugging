---
title: "Flutter で FutureBuilder が再ビルドのたびに Future を再生成しないように初期化する方法"
description: "FutureBuilder は親が再ビルドされるたびに非同期処理を再実行します。これは Future を build の中で生成しているためです。Future を State.initState に移す（あるいはメモ化する）と、FutureBuilder は同じ Future を再利用します。ここではその理由、再現例、そして噛みついてくるあらゆるバリエーションを説明します。"
pubDate: 2026-06-09
template: how-to
tags:
  - "flutter"
  - "dart"
  - "futurebuilder"
  - "how-to"
lang: "ja"
translationOf: "2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-09
---

`FutureBuilder` がローディングインジケーターに点滅して戻ったり、データを再取得したり、同じネットワーク呼び出しを何度も発火したりする場合、その原因はほぼ常に `Future` を `build` の中で生成していることです。周囲のウィジェットが再ビルドされるたびに `build` が再び呼ばれ、まったく新しい `Future` を構築し、`FutureBuilder` は律儀にそれを再起動します。解決策は、`Future` をちょうど一度だけ生成し、それを `State` のフィールドに保存し、その保存したフィールドを `FutureBuilder` に渡すことです。このガイドは Flutter 3.44（安定版、2026 年 5 月）と Dart 3.x を使用します。

Flutter チームは [FutureBuilder API ドキュメント](https://api.flutter.dev/flutter/widgets/FutureBuilder-class.html)でこれについて明確に述べています。"The future must have been obtained earlier, e.g. during State.initState, State.didUpdateWidget, or State.didChangeDependencies. It must not be created during the State.build or StatelessWidget.build method call when constructing the FutureBuilder." 理由はすぐ後に続きます。"If the future is created at the same time as the FutureBuilder, then every time the FutureBuilder's parent is rebuilt, the asynchronous task will be restarted." これがバグのすべてであり、フレームワーク自身によって述べられています。

## なぜ新しい Future が全体を再起動するのか

`FutureBuilder` は「あなたが実行したかった処理」を追跡しているのではありません。特定の `Future` オブジェクトを同一性で追跡しています。`didUpdateWidget` の中で、`oldWidget.future` を新しい `widget.future` と比較します。同じインスタンスでなければ、古いサブスクリプションを破棄し、`AsyncSnapshot` を `ConnectionState.waiting`（または `none`）にリセットし、新しいものをサブスクライブします。値ベースの重複排除も、組み込みのメモ化もありません。同一性が唯一のシグナルです。

ここで `build` が何をするかを考えてみてください。`Future` を返す `something()` を呼ぶと、たとえ根底にある処理が同一でも、呼び出しのたびに新しい `Future` インスタンスが生成されます。`Future.delayed(...)`、`http.get(...)`、`repository.load()` のいずれも、呼び出しごとに別個のオブジェクトを確保します。したがって `future:` 引数が `build` の中で評価される式であれば、`FutureBuilder` はフレームごとに異なる同一性を見て、自身のルールに従って正しく、あなたが新しいタスクを渡したと結論づけます。

そして `build` は人々が予想するよりもはるかに頻繁に実行されます。親の `setState`、変化する継承ウィジェット（回転時の `MediaQuery`、明るさ切り替え時の `Theme`）、キーボードを開く `Scaffold`、祖先のアニメーション、ホットリロード。これらのいずれもあなたのウィジェットを再ビルドし、`future:` 式を再評価します。非同期処理は遅くも壊れてもいません。毎回破棄され、ゼロから再起動されているのです。

## 再ビルドのたびに再取得する最小の再現例

これがアンチパターンの最も純粋な形です。`Future` は `build` の中でインラインに構築され、カウンターが再ビルドを強制するので、誤動作を観察できます。

```dart
// Flutter 3.44, Dart 3.x
// BROKEN: future is created inside build()
class ProfilePage extends StatefulWidget {
  const ProfilePage({super.key});
  @override
  State<ProfilePage> createState() => _ProfilePageState();
}

class _ProfilePageState extends State<ProfilePage> {
  int _counter = 0;

  Future<String> _loadName() async {
    // Pretend this is a network call.
    await Future<void>.delayed(const Duration(seconds: 2));
    return 'Marius';
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        FutureBuilder<String>(
          // New Future every build -> restarts every rebuild.
          future: _loadName(),
          builder: (context, snapshot) {
            if (snapshot.connectionState != ConnectionState.done) {
              return const CircularProgressIndicator();
            }
            return Text('Hello, ${snapshot.data}');
          },
        ),
        ElevatedButton(
          onPressed: () => setState(() => _counter++),
          child: Text('Rebuilt $_counter times'),
        ),
      ],
    );
  }
}
```

ボタンをタップしてください。タップのたびに `setState` が呼ばれ、それが `build` を呼び、それが `_loadName()` を再び呼び、それが新しい 2 秒の `Future` を返します。インジケーターはタップのたびに戻ってきます。`_loadName()` が HTTP リクエストである実際のアプリでは、あなたは 1 回の取得を 1 再ビルドあたり 1 回の取得に変えてしまい、ユーザーは画面が繰り返し白く点滅するのを見ます。これは [build 中に setState を呼ぶ](/ja/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/)のと同じ種類の誤りです。`build` が所有を許されていない処理を `build` の中で行っているのです。

## 解決策、ステップバイステップ

`Future` を `build` の外に移し、ちょうど一度だけ初期化されるフィールドに置きます。

1. **ウィジェットをまだ `StatefulWidget` でなければ `StatefulWidget` に変換します。** `StatelessWidget` には `initState` も、`Future` を永続的に保持する場所もないため、「先に取得した」というルールを満たせません。（ステートレスの場合については後述します。）
2. **`State` クラスに `late final Future<T>` フィールドを宣言します。** `late final` は `initState` での代入を可能にし、ちょうど一度だけ書き込まれることを保証します。
3. **`initState` でフィールドを代入します。** 非同期メソッドを `build` ではなくそこで呼び出します。`initState` はウィジェットが何度再ビルドされても、`State` の生存期間中に一度だけ実行されます。
4. **保存したフィールドを `FutureBuilder` に渡します。** 決してインライン呼び出しを渡しません。`future:` 引数は括弧のない単純なフィールド参照になります。
5. **強制再ビルドで検証します。** `setState` を繰り返し発火し、インジケーターが戻らず、処理が再実行されないことを確認します。

再現例に適用すると次のようになります。

```dart
// Flutter 3.44, Dart 3.x
// FIXED: future is created once in initState
class _ProfilePageState extends State<ProfilePage> {
  late final Future<String> _nameFuture;
  int _counter = 0;

  @override
  void initState() {
    super.initState();
    _nameFuture = _loadName(); // created exactly once
  }

  Future<String> _loadName() async {
    await Future<void>.delayed(const Duration(seconds: 2));
    return 'Marius';
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        FutureBuilder<String>(
          future: _nameFuture, // same instance every build
          builder: (context, snapshot) {
            if (snapshot.connectionState != ConnectionState.done) {
              return const CircularProgressIndicator();
            }
            return Text('Hello, ${snapshot.data}');
          },
        ),
        ElevatedButton(
          onPressed: () => setState(() => _counter++),
          child: Text('Rebuilt $_counter times'),
        ),
      ],
    );
  }
}
```

これでボタンはカウンターを増やし、`build` は再び実行されますが、`future: _nameFuture` は先ほど `initState` で生成された同一の `Future` インスタンスを指します。`FutureBuilder.didUpdateWidget` は `oldWidget.future == widget.future` を見て、既存のサブスクリプションを保ち、スナップショットを決してリセットしません。取得は一度だけ起こります。これが正統なパターンであり、実際のケースの大多数をカバーします。

## Future がウィジェットのパラメーターに依存する場合

`initState` のアプローチには鋭い角が一つあります。`initState` は `widget` の新しい値を見ることができません。`Future` が親によって変更されうる `widget.userId` に依存している場合、`initState` でのみ初期化すると、親が異なる id を渡したときにデータが古くなります。`State` オブジェクトがその変更をまたいで再利用されるためです。

フレームワーク自身の承認された場所のリストは、すでに答えを挙げています。`State.didUpdateWidget` です。そこで `Future` を再生成しますが、関連する入力が実際に変わったときだけにして、再ビルドごとの再起動を再び持ち込まないようにします。

```dart
// Flutter 3.44, Dart 3.x
class _UserPageState extends State<UserPage> {
  late Future<User> _userFuture;

  @override
  void initState() {
    super.initState();
    _userFuture = _fetchUser(widget.userId);
  }

  @override
  void didUpdateWidget(covariant UserPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Only refetch when the id genuinely changed.
    if (oldWidget.userId != widget.userId) {
      _userFuture = _fetchUser(widget.userId);
    }
  }

  Future<User> _fetchUser(String id) async {
    // ...network call keyed by id...
    return User(id: id);
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<User>(
      future: _userFuture,
      builder: (context, snapshot) {
        // ...render data / loading / error...
        return const SizedBox.shrink();
      },
    );
  }
}
```

ガード `if (oldWidget.userId != widget.userId)` がすべての肝です。それなしでは、元のエラーから一層離れただけで、再び親の再ビルドのたびに再取得することになります。`Future` が `InheritedWidget`（`context.dependOnInheritedWidgetOfExactType` 経由で読まれる値、たとえば `Locale` やプロバイダーのスコープ）に依存する場合は、同じ変更検出ガードを伴う `didChangeDependencies` を使います。これは継承された依存が変わったときに Flutter が発火するコールバックだからです。

## 意図的なリロードを強制する

`Future` をフィールドに移すと、明らかな疑問が生じます。たとえばプルトゥリフレッシュで、意図的にリロードするにはどうするのか。`setState` の中でフィールドを再代入します。これは、あなたが意図したまさにそのときに `FutureBuilder` へ新しい同一性を与えます。

```dart
// Flutter 3.44, Dart 3.x
void _refresh() {
  setState(() {
    _nameFuture = _loadName(); // new instance, intentional restart
  });
}
```

これは壊れたパターンの制御されたバージョンです。新しい `Future` は無関係な再ビルドの副作用としてではなく、ユーザーの操作に応じて生成されます。`onRefresh` が新しい future を返す `RefreshIndicator` と組み合わせ、取得が解決するまでインジケーターが残るようにします。リロードを配線するついでに、builder が失敗したリロードをどう表示するかを決めましょう。[Flutter アプリでネットワークエラーを優雅に扱う](/ja/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/)のパターンが `snapshot.hasError` の分岐に直接適用できます。

## initState のボイラープレートを書かずにメモ化する

これらを多く保守していて `initState` プラス `didUpdateWidget` の儀式が煩わしい場合、`async` パッケージの `AsyncMemoizer` がそれを畳み込みます。コールバックを最大一度だけ実行し、以降の呼び出しでは同じ `Future` を返すので、`build` の中のインライン呼び出しでさえ単一の根底にある処理に解決します。

```dart
// Flutter 3.44, Dart 3.x
// package: async ^2.11
import 'package:async/async.dart';

class _CatalogPageState extends State<CatalogPage> {
  final _memoizer = AsyncMemoizer<List<Item>>();

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<List<Item>>(
      // runOnce returns the SAME future after the first call.
      future: _memoizer.runOnce(() => _repository.loadItems()),
      builder: (context, snapshot) => const SizedBox.shrink(),
    );
  }
}
```

`runOnce` は最初の一度だけコールバックを実行し、結果の `Future` をキャッシュします。以降の呼び出しは新しいコールバックを無視してキャッシュされたものを返します。メモ化オブジェクトは依然として `State` に生きるので、`late final` フィールドと同じ生存期間保証を共有します。パラメーター依存のケースでは id ごとに新しいメモ化オブジェクトをキー付けする必要があり、これは `didUpdateWidget` よりも管理が増えるので、`AsyncMemoizer` は主に処理に入力がない場合に使ってください。

## なぜ StatelessWidget ではこれを直せないのか

`StatelessWidget` には `initState` も `State` も、`Future` をしまう安定した場所もありません。あなたが追加したどんなフィールドも、親がウィジェットを再ビルドするたびに再生成されます。Flutter は `StatelessWidget` インスタンスを自由に破棄して再構築するからです。したがって「先に生成せよ」というルールは `StatelessWidget` では満たせません。`Future` を生成できる最も早いタイミングは `build` であり、それはまさにドキュメントが禁じる場所です。`StatelessWidget` の中で長寿命の `Future` が欲しくなったら、それは `StatefulWidget` に昇格させるか、`Future` をウィジェットを完全に超えて生き残る状態管理レイヤーへ持ち上げる合図です。

その二つ目の選択肢はますます慣用的になっています。Riverpod の `FutureProvider` や `AsyncNotifier` はあなたの代わりに `Future` をキャッシュし、依存が変わったときだけ再計算します。これは手動の `initState` の踊りを取り除き、ウィジェットの再ビルドやルートの変更すら生き残ります。一つの画面にパッチを当てるのではなく長期的なアプローチを選んでいるなら、トレードオフは [2026 年の Flutter 状態管理における Provider 対 Riverpod 対 Bloc](/ja/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) で説明されており、プロバイダーの `AsyncValue` から得られる三状態の表示は [Flutter Riverpod で AsyncValue を使ってローディングとエラーの状態を表示する](/ja/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) で扱われています。

## フィールドパターンが解決しない二つの関連した落とし穴

`Future` を移すことは再起動を直しますが、隣接する二つの問題は生き残ります。第一に、`AutomaticKeepAliveClientMixin` を不正に使うスクロール可能なリスト内の `FutureBuilder` は、行が表示に戻ってスクロールされたときに依然として再ビルドされることがあります。`Future` フィールドはデータを守りますが、再ビルドのちらつきを避けたいなら行の状態そのものが生かされていることを確認してください。第二に、ウィジェットが消えた後に完了する `Future` は、すでに破棄された `State` に届けようとします。`FutureBuilder` 自体は内部で `setState`-破棄後 を防いでいますが、非同期メソッドが解決時に他のコントローラーに触れる場合、依然としてライフサイクルエラーに遭遇しうります。[メモリリークを避けるために Flutter でコントローラーを破棄する](/ja/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)の破棄の規律は、その付随する習慣です。生成したすべてのリソースを所有し、`dispose` で解放してください。

保持すべきメンタルモデルはこうです。`FutureBuilder` は一つの `Future` を同一性で観察する薄いアダプターです。その同一性を安定させるのはあなたの仕事です。`Future` を `initState` で生成し、入力が変わったときだけ `didUpdateWidget` か `didChangeDependencies` で更新し、ユーザーが新しいデータを要求したときだけ `setState` で再代入します。そうすれば、インジケーターはちょうど一度だけ表示され、ネットワークはちょうど一度だけ叩かれ、画面はちらつくのをやめます。

## 出典

- [FutureBuilder class - widgets library](https://api.flutter.dev/flutter/widgets/FutureBuilder-class.html): 上で引用した "must have been obtained earlier" のルールと再起動の警告。
- [State.initState method](https://api.flutter.dev/flutter/widgets/State/initState.html): State の生存期間ごとに一度実行されます。
- [State.didUpdateWidget method](https://api.flutter.dev/flutter/widgets/State/didUpdateWidget.html): 変更されたウィジェット構成に反応するためのフック。
- [AsyncMemoizer class - async package](https://pub.dev/documentation/async/latest/async/AsyncMemoizer-class.html): コールバックを最大一度だけ実行します。
