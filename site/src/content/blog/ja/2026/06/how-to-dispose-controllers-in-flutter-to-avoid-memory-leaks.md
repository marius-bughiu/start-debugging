---
title: "Flutter でコントローラーを dispose してメモリリークを防ぐ方法"
description: "AnimationController、TextEditingController、ScrollController は、dispose するまで Dart の GC が回収できないリソースを保持します。正しいパターン、順序のルール、公開前にリークを検出する方法を解説します。"
pubDate: 2026-06-01
template: how-to
tags:
  - "flutter"
  - "dart"
  - "memory"
lang: "ja"
translationOf: "2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks"
translatedBy: "claude"
translationDate: 2026-06-01
---

コントローラーが `dispose()` メソッドを公開している場合、`State.dispose()` から必ず呼び出す必要があり、しかも `super.dispose()` より前に呼び出す必要があります。具体的には、コントローラーを `initState`（または `late final` フィールド）で作成し、`dispose()` で `controller.dispose()` を呼び出し、`AnimationController` には `SingleTickerProviderStateMixin` を追加して、ウィジェットがツリーから外れたときにティッカーが停止するようにします。これらのいずれかを怠ると、`Ticker`、リスナーリスト、ストリームの購読が生存したまま到達可能なまま残り、ウィジェットのサブツリー全体がメモリに固定されます。本ガイドでは Flutter 3.44（stable、2026 年 5 月）と Dart 3.x を使用します。

ガベージコレクションはここでは助けになりません。Dart の GC は到達不可能になったオブジェクトを回収しますが、実行中の `AnimationController` は `SchedulerBinding` のティッカーリストから到達可能であり、`TextField` に渡した `TextEditingController` は、何かがそのコントローラーを保持している限りリスナーグラフから到達可能です。リークは GC のバグではありません。所有権のバグです。リソースを作成して、決して解放しなかったのです。

## なぜコントローラーはウィジェットより長く生き残るのか

`StatefulWidget` は安価で使い捨てです。Flutter はウィジェットオブジェクトを絶えず再構築します。ライフサイクルを持つのは `State` オブジェクトであり、作成するコントローラーはその `State` に属します。ウィジェットがツリーから削除されると、Flutter は `State.dispose()` をちょうど一度だけ呼び出します。その呼び出しが、ネイティブおよびフレームワークのリソースを解放する唯一の機会です。

3 つのカテゴリのコントローラーは、それぞれ異なる形でリークします。

`AnimationController` は `SchedulerBinding` に `Ticker` を登録します。ティッカーはアニメーションの実行中、毎フレームでコールバックを発火します。コントローラーを dispose する（それによってティッカーが dispose される）まで、`SchedulerBinding` はティッカーへの参照を保持し、ティッカーはあなたのコールバックへの参照を保持し、コールバックは `this`、あなたの `State`、そしてそれを通じてサブツリー全体をクロージャに取り込みます。デバッグビルドでは Flutter は実際にこれについて assertion を発します。`dispose` を忘れると、ウィジェットの破棄時に `AnimationController.dispose() called more than once` や、ティッカーがまだアクティブだという assertion が出ます。

`TextEditingController`、`ScrollController`、`FocusNode` は `ChangeNotifier`（またはそれを保持するもの）です。これらはリスナーのリストを保持します。`TextField` はテキストが変わったときに再描画できるよう、自身をリスナーとして追加します。あなたも `controller.addListener(...)` を呼び出して決して dispose しなければ、コントローラー、そのリスナーリスト、そしてそのリスト内のすべてのクロージャが生存し続けます。コントローラーがリスナーを保持するのであって、その逆ではないため、GC はそのいずれも回収できません。

`StreamSubscription` と `Timer` は `dispose()` という名前こそ持ちませんが同じ形です。`subscription.cancel()` と `timer.cancel()` を呼び出します。生きている購読はストリームから参照され、ストリームがあなたの `onData` コールバックを生かし続けます。

統一的なルールは、Flutter チームの [State.dispose API ドキュメント](https://api.flutter.dev/flutter/widgets/State/dispose.html) からそのまま引用すると次のとおりです。「State の build メソッドが、それ自身の状態を変えうるオブジェクトに依存する場合、... initState の間にそのオブジェクトを購読し ... dispose で購読を解除しなさい」。

## リークする最小再現コード

以下は 3 種類のリソースすべてをリークさせるウィジェットです。コンパイルされ、実行されます。ただ、決して手放さないだけです。

```dart
// Flutter 3.44, Dart 3.x -- DO NOT COPY, this leaks on purpose.
import 'dart:async';
import 'package:flutter/material.dart';

class LeakyScreen extends StatefulWidget {
  const LeakyScreen({super.key});

  @override
  State<LeakyScreen> createState() => _LeakyScreenState();
}

class _LeakyScreenState extends State<LeakyScreen>
    with SingleTickerProviderStateMixin {
  late final AnimationController _anim =
      AnimationController(vsync: this, duration: const Duration(seconds: 1))
        ..repeat();
  final TextEditingController _text = TextEditingController();
  final ScrollController _scroll = ScrollController();
  late final StreamSubscription<int> _ticks =
      Stream.periodic(const Duration(seconds: 1), (i) => i).listen((_) {});

  // No dispose() override. Every push/pop of this screen leaks
  // one AnimationController, one ticker, one TextEditingController,
  // one ScrollController, and one live StreamSubscription.

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: ListView(
        controller: _scroll,
        children: [
          TextField(controller: _text),
          RotationTransition(turns: _anim, child: const FlutterLogo()),
        ],
      ),
    );
  }
}
```

この画面を 50 回 push/pop すると、毎フレームで発火する 50 個のティッカー、イベントを配信する 50 個のストリーム購読、そして GC が決して触れない 50 個の切り離されたウィジェットサブツリーが生まれます。アニメーションのティッカーだけでも、それぞれが依然として毎 vsync で実行されようとするため、フレーム時間が目に見えて悪化します。

## dispose のパターン、その全体像

この修正は、いったん身につければ機械的です。作成する各リソースを、`dispose()` 内の解放呼び出しで鏡写しにし、`super.dispose()` を最後に置きます。

```dart
// Flutter 3.44, Dart 3.x
import 'dart:async';
import 'package:flutter/material.dart';

class StableScreen extends StatefulWidget {
  const StableScreen({super.key});

  @override
  State<StableScreen> createState() => _StableScreenState();
}

class _StableScreenState extends State<StableScreen>
    with SingleTickerProviderStateMixin {
  late final AnimationController _anim;
  late final TextEditingController _text;
  late final ScrollController _scroll;
  late final FocusNode _focus;
  StreamSubscription<int>? _ticks;

  @override
  void initState() {
    super.initState();
    _anim = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 1),
    )..repeat();
    _text = TextEditingController();
    _scroll = ScrollController()..addListener(_onScroll);
    _focus = FocusNode();
    _ticks = Stream.periodic(const Duration(seconds: 1), (i) => i)
        .listen(_onTick);
  }

  void _onScroll() {/* react to scroll offset */}
  void _onTick(int value) {/* react to each tick */}

  @override
  void dispose() {
    // Cancel subscriptions and remove listeners first.
    _ticks?.cancel();
    _scroll.removeListener(_onScroll);
    // Then dispose every controller you own.
    _anim.dispose();
    _text.dispose();
    _scroll.dispose();
    _focus.dispose();
    // super.dispose() LAST, always.
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: ListView(
        controller: _scroll,
        children: [
          TextField(controller: _text, focusNode: _focus),
          RotationTransition(turns: _anim, child: const FlutterLogo()),
        ],
      ),
    );
  }
}
```

このコードのいくつかの箇所は要となるため、それぞれ明示しておく価値があります。

### build ではなく initState で作成する

`build` は何度も実行されます。`final _text = TextEditingController()` を `late` なしの値を持つフィールド初期化子として書く場合、フィールド初期化子は一度だけ実行されるので問題ありません。しかし `build` の内部でコントローラーを構築すると、再構築のたびに新しいものを割り当て、前のものを即座に孤立させてしまいます。コントローラーは `initState` または `late final` フィールドで構築し、決して `build` では構築しないでください。

### なぜ super.dispose() が最後に来るのか

この慣習は `initState` の逆です。`initState` ではまず `super.initState()` を呼び出し、それから状態をセットアップします。`dispose` ではまず状態を解体し、それから `super.dispose()` を最後に呼び出します。基底クラスの `State.dispose()` はオブジェクトを廃止済みとしてマークします。その後に自分のフィールドに触れるのはバグであり、フレームワークのデバッグビルドは、すでに dispose された `State` に対して呼ばれた `dispose` を検出します。基底クラスに制御を返す前に自分のリソースを解体することで、順序が整合します。

### dispose の前に removeListener、あるいは単に dispose

コントローラーで `addListener` を呼び出した場合、`dispose` の前に同じコールバックで `removeListener` を呼び出すか、`dispose()` がリスナーリスト全体を破棄するのに任せるか、どちらかができます。`ChangeNotifier` を dispose するとそのリスナーがクリアされるため、同じオブジェクトの `dispose` の直前の明示的な `removeListener` は冗長です。明示的な `removeListener` を残す理由は、自分が所有していないコントローラー（親から渡されたもの）に自分をリスナーとして追加した場合です。そのコントローラーを dispose するのは自分ではないため、`dispose` でそのコントローラーから自分のリスナーを必ず削除する必要があります。

## AnimationController には TickerProvider が必要

`AnimationController` は、`dispose` の呼び出し以上を必要とする唯一のコントローラーです。`vsync` 引数を必要とし、それは `TickerProvider` です。`TickerProvider` は、コントローラーのティッカーを画面のリフレッシュレートに、そして決定的にはウィジェットのライフサイクルに結びつけるものです。

`State` がちょうど 1 つの `AnimationController` を所有する場合は `SingleTickerProviderStateMixin` を使います。複数を所有する場合は `TickerProviderStateMixin` を使います。シングルティッカーの mixin はわずかな最適化であり、誤ってそれに対して 2 つのコントローラーを作成すると assertion を発するので、有用なガードになります。

```dart
// Flutter 3.44 -- one controller
class _OneAnim extends State<OneAnim>
    with SingleTickerProviderStateMixin {
  late final _c = AnimationController(vsync: this, duration: ...);
  @override
  void dispose() { _c.dispose(); super.dispose(); }
}

// Flutter 3.44 -- multiple controllers
class _ManyAnim extends State<ManyAnim>
    with TickerProviderStateMixin {
  late final _a = AnimationController(vsync: this, duration: ...);
  late final _b = AnimationController(vsync: this, duration: ...);
  @override
  void dispose() { _a.dispose(); _b.dispose(); super.dispose(); }
}
```

アニメーションが単純なら、コントローラーを決してリークしない最もクリーンな方法は、そもそも所有しないことです。`AnimatedContainer`、`AnimatedOpacity`、`TweenAnimationBuilder` といった暗黙的アニメーションウィジェットは、内部で自身のコントローラーを管理し、あなたの代わりに dispose します。明示的な `AnimationController` に手を伸ばすのは、自分でアニメーションを駆動、反転、繰り返し、あるいは連結する必要がある場合だけにしてください。アニメーションのジャンクをプロファイルするのは別のスキルです。アニメーションは滑らかなのにアプリがそれでもカクつく場合、原因は通常 UI スレッド上の処理であり、これは [Flutter アプリのジャンクを DevTools でプロファイルするガイド](/ja/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) で扱っています。

## コントローラーを所有する者が、それを dispose する者を決める

実際の世界で最も多いリーク（そして最も多い二重 dispose のクラッシュ）は、所有権の不明瞭さから来ます。ルールは、コントローラーを作成した者がそれを dispose する、です。コントローラーがウィジェット A で作成され、ウィジェット B に渡された場合、A がそれを dispose し、B はしてはいけません。

これが重要なのは、Flutter のウィジェットが、まさに親が制御できるようにコントローラーをコンストラクタ引数として受け取ることが多いからです。`TextField`、`ListView`、`PageView`、`TabBar` はいずれもオプションのコントローラーを取ります。1 つを渡すとき、あなたはそれを dispose する責任を保持し続けます。

```dart
// Flutter 3.44, Dart 3.x
class FormSection extends StatefulWidget {
  // This widget OWNS the controller, so it disposes it.
  const FormSection({super.key});
  @override
  State<FormSection> createState() => _FormSectionState();
}

class _FormSectionState extends State<FormSection> {
  final _name = TextEditingController();

  @override
  void dispose() {
    _name.dispose(); // owner disposes
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // The child widget receives the controller but must NOT dispose it.
    return NameField(controller: _name);
  }
}

class NameField extends StatelessWidget {
  final TextEditingController controller;
  const NameField({super.key, required this.controller});

  @override
  Widget build(BuildContext context) =>
      TextField(controller: controller); // no dispose here
}
```

`NameField` が自分で作成していないコントローラーを dispose した場合、親は後で dispose 済みのコントローラーを使おうとして `A TextEditingController was used after being disposed` でクラッシュします。この厳密なエラーには独自の診断がありますが、根本原因はほぼ常に、1 つのコントローラーのライフサイクルを巡って争う 2 つのウィジェットです。

逆の誤りは、コントローラーを状態管理レイヤー（`ChangeNotifier`、Riverpod の `Notifier`、GetX のコントローラー）に引き上げておきながら、今やそのレイヤーが dispose を所有していることを忘れるものです。`TextEditingController` を `State` の外に出して Riverpod のプロバイダーに移すと、`controller.dispose()` の呼び出しが今や置かれる場所はプロバイダーの `onDispose`/`dispose` であって、ウィジェットではありません。状態管理の移行中にライフサイクルの所有権を再構成しているとき、これはまさに静かに壊れる類のものであり、これが [Flutter アプリを GetX から Riverpod へ移行する](/ja/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) を、検索と置換ではなく慎重で段階的な移行として書いた理由の一部です。

## 噛みついてくるエッジケース

**条件付き作成。** コントローラーが一部のコードパスでのみ作成される場合、そのフィールドを null 許容にして dispose をガードします。`_optional?.dispose();` です。`late final` のコントローラーを未初期化のまま放置してその上で `dispose` を呼ばないでください。`LateInitializationError` を投げます。

**ウィジェット更新時のコントローラーの再作成。** コントローラーが `widget` のプロパティに依存する場合、`didUpdateWidget` で古いものを dispose して新しいものを作成する必要があるかもしれません。パターンは、`didUpdateWidget` で `oldWidget.x` と `widget.x` を比較し、異なれば `_controller.dispose()` してから新しいものを代入する、です。`didUpdateWidget` での dispose を忘れると、関連するプロパティ変更ごとにコントローラーを 1 つリークします。

**GlobalKey とコントローラーは別物です。** `GlobalKey` は dispose を必要としませんが、key を通じて到達するコントローラーは必要とします。この 2 つを混同しないでください。

**ホットリロードはリークを隠します。** ホットリロードは `State` を保持するため、忘れた `dispose` は開発中には表面化しないことがあります。実際に画面が push/pop されたとき、あるいはリークトラッカーの下でしか気づきません。ホットリロードだけでなく、実際のナビゲーションパスをテストしてください。

**コントローラーのコールバック内の重い処理は UI スレッドの外に属します。** `ScrollController` や `AnimationController` のリスナーが意味のある計算をする場合、その処理は UI アイソレートで実行され、レンダリングと競合します。バックグラウンドのアイソレートに移してください。これは [CPU バウンドな処理のための Dart アイソレートを書く](/ja/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) で順を追って説明しています。

## 公開前にリークを検出する

コードを読んでこれらを見つける必要はありません。Flutter は `leak_tracker` を同梱しており、Flutter 3.x 以降、テストフレームワークがそれと統合され、リーク追跡が有効なとき dispose のリークがウィジェットテストを自動的に失敗させます。Flutter チームはそのワークフローを [公式のリーク追跡ガイド](https://github.com/dart-lang/leak_tracker/blob/main/doc/leak_tracking/OVERVIEW.md) で文書化しています。メンタルモデルは、すべての disposable なオブジェクトは dispose されることが期待される、というものです。GC が一度も dispose されなかったオブジェクトを回収すれば、それは「not disposed」リークであり、dispose されたが決して回収されなければ、それは「not GCed」リークです。どちらも割り当て時のスタックトレース付きで報告されるので、孤児を作成した `initState` に直接導かれます。

実行中のアプリでは、DevTools を開いて Memory ビューを使います。疑わしい画面を数回 push/pop し、GC を強制し、`AnimationController`、`TextEditingController`、または自分の `State` クラスのインスタンス数を観察します。数が増えて決して減らないなら、リークがあります。保持パスのビューが、何がまだそのオブジェクトを指しているかを示してくれます。同じ DevTools のセッションは、フレームのタイミングを調査する場所でもあり、ジャンクのプロファイリングのワークフローと重なります。

この規律は一行で述べられるほど単純で、コードレビューの反射にする価値があります。`State` で作成するすべての `Controller`、`FocusNode`、`StreamSubscription`、`Timer` に対して、`dispose()` 内に対応する解放呼び出しがちょうど 1 つあり、`super.dispose()` がメソッドの最後の文である、ということです。`leak_tracker` をウィジェットテストに組み込めば、フレームワークがあなたにそれを守らせます。

## 関連記事

- [Flutter アプリのジャンクを DevTools でプロファイルする方法](/ja/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) は、リークを確認するために使う Memory と Performance のビューを扱います。
- [CPU バウンドな処理のための Dart アイソレートを書く方法](/ja/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) は、実際の処理をするコントローラーのコールバックが実行されるべき場所です。
- [Flutter アプリを GetX から Riverpod へ移行する方法](/ja/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) は、状態管理レイヤーを変えるときに dispose の所有権がどう移るかを示します。
- [解決: Flutter で RenderFlex overflowed](/ja/2026/05/fix-renderflex-overflowed-in-flutter/) は、同じ画面を作る際に出くわすもう 1 つの古典的な Flutter のバグです。

## 出典

- [State.dispose、Flutter API リファレンス](https://api.flutter.dev/flutter/widgets/State/dispose.html)
- [AnimationController、Flutter API リファレンス](https://api.flutter.dev/flutter/animation/AnimationController-class.html)
- [TextEditingController、Flutter API リファレンス](https://api.flutter.dev/flutter/widgets/TextEditingController-class.html)
- [leak_tracker の概要、dart-lang/leak_tracker](https://github.com/dart-lang/leak_tracker/blob/main/doc/leak_tracking/OVERVIEW.md)
- [Memory ビューを使う、Flutter DevTools ドキュメント](https://docs.flutter.dev/tools/devtools/memory)
