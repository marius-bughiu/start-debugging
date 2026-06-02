---
title: "解決: Flutter で setState() or markNeedsBuild() called during build"
description: "このエラーは、Flutter のビルド中に状態を変更したことを意味します。setState を build の外に移すか、addPostFrameCallback で遅延させてください。原因と正しい解決方法を説明します。"
pubDate: 2026-06-02
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
lang: "ja"
translationOf: "2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-02
---

Flutter がビルドフェーズの途中にあるときに、`setState()`(または `notifyListeners()`、`markNeedsBuild()`、`Navigator.push` を呼び出す何か)を呼び出しました。解決方法は、`build` 中に状態を変更しないことです。トリガーが本当にビルドの途中で実行される同期コールバックである場合は、`WidgetsBinding.instance.addPostFrameCallback((_) => setState(...))` で変更を次のフレームに遅延させてください。このガイドでは Flutter 3.44(安定版、2026年5月)と Dart 3.x を使用します。

このエラーは不具合ではなく、安全装置です。Flutter は単一の同期パスで子より先に親をビルドします。パスの途中でウィジェットをダーティとしてマークすると、すでに訪問済みかもしれないものに対して再ビルドをスケジュールするようフレームワークに求めることになり、これは現在のフレームでは実行できません。そのため、更新を黙って破棄する代わりに例外をスローします。

## コンテキストにおけるエラー

Flutter がコンソールに出力する完全なメッセージは次のようになります。

```
======== Exception caught by widgets library =======================
The following assertion was thrown while dispatching notifications for ProductModel:
setState() or markNeedsBuild() called during build.

This _MyHomePageState widget cannot be marked as needing to build because the
framework is already in the process of building widgets. A widget can be marked
as needing to be built during the build phase only if one of its ancestors is
currently building. This exception is allowed because the framework builds parent
widgets before children, which means a dirty descendant will always be built.
Otherwise, the framework might not visit this widget during this build phase.

The widget on which setState() or markNeedsBuild() was called was: _MyHomePageState
The widget which was currently being built when the offending call was made was: Consumer<ProductModel>
====================================================================
```

重要なのは末尾の2行です。"The widget on which setState() ... was called" は再ビルドしようとしているものです。"The widget which was currently being built" は問題のある呼び出しが発生した場所です。この2つのウィジェットの間のギャップがバグです。

## なぜこれが起こるのか

よくあるトリガーは4つあり、おおよそ発生頻度の高い順に並べます。

リスナーがビルド中に通知します。`ChangeNotifier`、`ValueNotifier`、または provider が、`build` で読み取りながら呼び出したメソッドの中から `notifyListeners()` を呼び出します。この通知はリスニングしている各ウィジェットに同期的に再ビルドを要求しますが、あなたはすでにそのうちの1つをビルドしている最中です。

`build` の中で直接 `setState` を呼び出しました。たいていは誤ってです。値を計算するメソッドがフラグも切り替えて `setState` を呼び出し、あなたはそのメソッドを `build` から呼び出しています。

それを変更もするビルド中に、`listen: true` で provider を読み取りました。`Provider.of<T>(context)`(リスニングあり)は依存関係を登録します。同じフレームがその provider に書き込むと、書き込みはまだビルド中の依存先を再ビルドしようとします。

`build` からナビゲートまたはダイアログを表示しました。`Navigator.push`、`showDialog`、`Scaffold.of(context).showSnackBar` は祖先をダーティとしてマークします。これらをイベントハンドラーからではなく `build` から呼び出すと、同じアサーションが発生します。

Flutter チームの統一されたルールはシンプルです。`build` はウィジェットの構成と状態の純粋な関数でなければなりません。ウィジェットツリーを返すだけで、他には何もしません。状態を変更する副作用は、ライフサイクルメソッド(`initState`、`didChangeDependencies`)またはイベントハンドラー(`onPressed`、`onTap`)に属するべきであり、決して `build` には属しません。

## 問題のある呼び出しの見つけ方

コンソールメッセージは2つのウィジェットを名指ししますが、変更が必要な行はたいていそのどちらにもありません。それは両者の間で同期的に実行されたものの中にあります。メッセージを下から上へ読んでください。

1. "The widget which was currently being built" は実行中のビルドを示します。コード内でそのウィジェットの `build` メソッド、または `Consumer`、`Builder`、`LayoutBuilder`、`ValueListenableBuilder` の場合は `builder` コールバックを探してください。
2. そのビルドの中で、純粋な読み取りではないメソッド呼び出しをすべて見つけてください。カウンターをインクリメントするゲッター、`load`、`refresh`、`fetch`、`update` という名前のメソッド、`ChangeNotifier` に触れるものすべてです。その呼び出しが容疑者です。
3. ビルドの中に不純なものが何もないように見える場合、トリガーはリスナーです。最上部の "dispatching notifications for X" の行を見てください。`X` は発火した通知元です。`X.notifyListeners()` が呼び出される場所を見つけ、このフレーム中に何がそれを呼び出したかを遡ってください。

デバッグビルドでは、メッセージの下のスタックトレースが `notifyListeners` または `setState` の呼び出し箇所を直接指し示します。リリースビルドではアサーションがコンパイル時に除去されるため、バグはクラッシュではなく、破棄された更新や古いフレームとして現れます。だからこそ症状を抑えるのではなく原因を修正したいのです。症状はデバッグでのみ存在します。

## 最小限の再現

このウィジェットは最初のフレームで例外をスローします。モデルは、`Consumer` がビルド中に実行されるメソッドからリスナーに通知します。

```dart
// Flutter 3.44, Dart 3.x -- throws "setState() or markNeedsBuild() called during build".
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

class ProductModel extends ChangeNotifier {
  int _count = 0;
  int get count => _count;

  // Looks like a harmless getter-with-side-effect. It is not.
  int countAndTrack() {
    _count++;
    notifyListeners(); // fires synchronously, during build
    return _count;
  }
}

class CounterText extends StatelessWidget {
  const CounterText({super.key});

  @override
  Widget build(BuildContext context) {
    return Consumer<ProductModel>(
      builder: (context, model, _) {
        // Calling a method that notifies, from inside build:
        return Text('Seen ${model.countAndTrack()} times');
      },
    );
  }
}
```

`Consumer` がビルド中です。その `builder` が `countAndTrack()` を呼び出し、それが `notifyListeners()` を呼び出し、それがまだビルド中の `Consumer` に再ビルドを要求します。Flutter は例外をスローします。

同じ形は Provider なしでも現れます。親のビルド中に同期的に `setState` を呼び出してしまう `addListener` コールバックは、どれでもこれを引き起こします。

## 解決方法の詳細

解決方法は、私が推奨する度合いの順に並べています。最初のものがほぼ常に本当の答えです。

### 1. 状態変更を build の外に移す(推奨)

ビルド中に変更しないでください。派生値は `build` で計算しますが、実際の状態変更はライフサイクルメソッドまたはイベントハンドラーで行います。再現コードでは、変更は `builder` ではなく `initState` に属します。

```dart
// Flutter 3.44, Dart 3.x -- correct: mutate once, off the build path.
class CounterText extends StatefulWidget {
  const CounterText({super.key});

  @override
  State<CounterText> createState() => _CounterTextState();
}

class _CounterTextState extends State<CounterText> {
  @override
  void initState() {
    super.initState();
    // Mutate here, before the first build, not during it.
    context.read<ProductModel>().countAndTrack();
  }

  @override
  Widget build(BuildContext context) {
    // build only reads; it does not write.
    final count = context.watch<ProductModel>().count;
    return Text('Seen $count times');
  }
}
```

`context.read<T>()` は購読せずにモデルを取得するため、`initState` で安全です。`context.watch<T>()` は購読し、読み取りのみを行うため `build` で安全です。書き込みはフレームの前に一度だけ発生し、その後は読み取りが再ビルドを駆動します。

### 2. addPostFrameCallback で変更を遅延させる

これは、トリガーが本当に自分の制御外にある場合に使用します。サードパーティのコールバック、ビルドの途中で届くストリームイベント、または同じフレームで測定されたサイズに反応する必要がある `LayoutBuilder` などです。`WidgetsBinding.instance.addPostFrameCallback` は、現在のフレームが完全にビルドされ描画された後にクロージャを実行するため、`setState` が再び合法になります。

```dart
// Flutter 3.44, Dart 3.x -- defer the rebuild to after this frame.
@override
Widget build(BuildContext context) {
  if (_needsRefresh) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return; // the widget may have been disposed
      setState(() => _needsRefresh = false);
    });
  }
  return Text(_label);
}
```

2つの安全策がこれを安全にします。`mounted` チェックは、コールバックが実行される前にウィジェットがツリーを離れた場合の `setState after dispose` クラッシュを防ぎます。そしてコールバックは条件付きでなければなりません(ここでは `_needsRefresh` でゲートされています)。さもないと毎フレーム新しい再ビルドをスケジュールし、無限ループで CPU を消費します。`addPostFrameCallback` は遅延であり、毎回の描画で再ビルドする許可ではありません。

### 3. 同期的な notify をマイクロタスクに分割する

通知元が自分のもので、メソッドが正当に通知する必要があるものの、ビルド中に決して呼び出されないと保証できない場合は、通知を同期パスの外に押し出してください。

```dart
// Flutter 3.44, Dart 3.x -- notify after the current synchronous work unwinds.
int countAndTrack() {
  _count++;
  // scheduleMicrotask runs after the current build call stack returns,
  // but before the next frame -- so the UI updates without a frame of lag.
  scheduleMicrotask(notifyListeners);
  return _count;
}
```

これは最後の手段です。設計の臭い(副作用のあるゲッター)を取り除くのではなく隠すだけであり、マイクロタスクは依然として破棄と競合する可能性があります。解決方法1を優先してください。

## 落とし穴とバリエーション

`setState() called after dispose()`。別のアサーションですが、関連する原因です。ウィジェットがツリーから削除された後に完了した非同期コールバック(`Future.then`、`Timer`、ストリームリスナー)から `setState` を呼び出しました。すべての非同期 `setState` を `if (!mounted) return;` で保護してください。破棄のパターンについては[コントローラーの破棄ガイド](/ja/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)を参照してください。

`initState` での `setState`。`initState` で `setState` を同期的に呼び出すのはエラーではありませんが、無意味です。最初のビルドはまだ起きていないため、状態はいずれにせよ読み取られます。フィールドに直接代入してください。Flutter はビルドフェーズのケースとは異なり、ここでは例外をスローしません。

`build` からの `Navigator.push`。このエラーの頻出するバリエーションです。状態の副作用としてナビゲートしたい場合(たとえばユーザーがログアウトしたときにリダイレクトするなど)は、`addPostFrameCallback` で行うか、より良くはリダイレクトを `build` から命令的にではなく宣言的にモデル化するルーティングパッケージで行ってください。

永遠に再ビルドする `FutureBuilder` / `StreamBuilder`。`future` または `stream` が `build` 内で作成されると、各再ビルドが新しいものを作成し、それが完了し、内部で `setState` を呼び出し、再ビルドします。future または stream は `initState` で一度だけ作成し、フィールドに保存してください。これは厳密には同じ例外ではありませんが、「再ビルド中に再ビルドしている」という同じ領域に陥り、[DevTools で発見できる Flutter のジャンク](/ja/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/)のよくある原因です。

Riverpod ユーザーへ。ビルド中に実行されるコールバック内で `ref.watch` を使って provider を読み取り、同じ同期パスでそれに書き込むと、同じ壁にぶつかります。Riverpod の `AsyncValue` と `Notifier` は読み取りと書き込みを別々のパスに保ちます。パターンについては [AsyncValue によるローディングとエラー状態](/ja/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)を参照してください。

より深いポイント: `build` は頻繁に、予測不能に、そしておそらくフレームごとに何度も呼び出されます。そこに置いたものは何でも、あなたのスケジュールではなく Flutter のスケジュールで実行されます。読み取りは冪等なので問題ありません。書き込みは次の読み取りが返すものを変えてしまい、Flutter にはその変更をビルドの途中で吸収する安全な場所がないため、問題になります。`build` を純粋に保てば、このエラーは永遠に消えます。同じ規律により、[RenderFlex のオーバーフロー](/ja/2026/05/fix-renderflex-overflowed-in-flutter/)のような無関係なバグも推論しやすくなります。レイアウトが動く標的ではなく状態の純粋な関数になるからです。ウィジェットが本当に非同期データに反応する必要がある場合は、そのデータを状態としてモデル化し、[エレガントなエラーとローディングの処理](/ja/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/)に再ビルドを駆動させてください。

## 出典

- [State.setState API docs](https://api.flutter.dev/flutter/widgets/State/setState.html) -- setState が合法となる条件の契約。
- [State.build API docs](https://api.flutter.dev/flutter/widgets/State/build.html) -- "build should be a pure function of the widget's configuration and the State."
- [WidgetsBinding.addPostFrameCallback API docs](https://api.flutter.dev/flutter/scheduler/SchedulerBinding/addPostFrameCallback.html) -- 現在のフレームの後に作業をスケジュールする。
- [ChangeNotifier.notifyListeners API docs](https://api.flutter.dev/flutter/foundation/ChangeNotifier/notifyListeners.html) -- リスナーが同期的に呼び出されるタイミング。
