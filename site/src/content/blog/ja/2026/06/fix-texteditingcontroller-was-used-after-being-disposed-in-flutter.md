---
title: "解決: Flutter で A TextEditingController was used after being disposed"
description: "このクラッシュは、dispose() の実行後にコントローラーへアクセスしたことを意味します。非同期コールバックは mounted チェックで保護し、自分が所有していないコントローラーは決して破棄しないでください。"
pubDate: 2026-06-03
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
lang: "ja"
translationOf: "2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-03
---

`dispose()` がすでに実行された後に、何かが `TextEditingController` を読み書きしました。よくある原因は、ユーザーが画面を離れて `State` が破棄された後に完了する非同期コールバック（`Future.then`、`await`、`Timer`、stream のリスナー）です。コントローラーにアクセスする前に、await 後のコードを `if (!mounted) return;` で保護してください。もう 1 つのよくある原因は所有権の混乱です。子ウィジェットが、渡されたものの自分のものではないコントローラーを破棄したケースです。このガイドでは Flutter 3.44（安定版、2026 年 5 月）と Dart 3.x を使用します。

このエラーは `TextEditingController` 固有のものではありません。同じメッセージは任意の `ChangeNotifier`（`ScrollController`、`FocusNode`、`AnimationController`、`ValueNotifier`、Provider のモデル）で発生します。アサーションが `ChangeNotifier` 自体にあるためです。メッセージのランタイム型は、どれに遅すぎるタイミングでアクセスしたかを示しているだけです。

## エラーの全体像

Flutter がスローするメッセージ全体は次のようになります。

```
A TextEditingController was used after being disposed.
Once you have called dispose() on a TextEditingController, it can no longer be used.

When the exception was thrown, this was the stack:
#0      ChangeNotifier._debugAssertNotDisposed.<anonymous closure> (package:flutter/src/foundation/change_notifier.dart)
#1      ChangeNotifier._debugAssertNotDisposed (package:flutter/src/foundation/change_notifier.dart)
#2      ChangeNotifier.addListener (package:flutter/src/foundation/change_notifier.dart)
#3      TextEditingController.text= (package:flutter/src/widgets/editable_text.dart)
...
```

`ChangeNotifier` のフレームのすぐ下にあるスタックフレームが、あなたのコードの行です。それは、破棄済みのコントローラーにアクセスした操作（`text=`、`.text`、`addListener`、`clear()`、`.selection`）を示します。そのフレームが修正する場所ですが、発生した理由はもっと前、つまり `dispose()` がその行より先に実行された時点にあります。

## なぜこれが起こるのか

原因は 4 つあり、おおよそ頻度の高い順に並べます。

非同期コールバックがウィジェットより長く生き残った。画面が生きている間に `await`、`Future.then`、`Timer`、`stream.listen` を開始し、ユーザーが画面から離れ（これにより `State` とコントローラーが解放される）、その後コールバックが完了してコントローラーにアクセスしました。これが圧倒的に最も多い原因です。タイミングが噛み合ったときだけクラッシュするためです。レスポンスが速ければ常に通り、ユーザーが素早いかネットワークが遅いとクラッシュします。

子が、自分のものではないコントローラーを破棄した。親がコントローラーを作成して下に渡し、子が自身の `dispose()` でそれに対して `dispose()` を呼びました。今や親（あるいは兄弟、または次の再ビルド）は、子がすでに殺したコントローラーを使います。所有権はリーク問題の逆です。自分のものでないコントローラーを破棄するとこのクラッシュになり、自分のものを破棄し忘れるとメモリリークになります。

状態管理レイヤーがそれを破棄した。コントローラーが Riverpod の `autoDispose` プロバイダー、GetX のコントローラー、またはフレームワークが解体した `ChangeNotifier` の中に存在する場合、まだ参照を保持しているウィジェットは破棄済みのインスタンスに突き当たります。Riverpod の `autoDispose` は頻繁な引き金です。誰も監視しなくなるとプロバイダーが再計算または破棄され、コントローラーを道連れにする一方で、古いクロージャがまだ古いものを指しています。

`didUpdateWidget` が古いものを早すぎるタイミングで破棄した。コントローラーが `widget` のプロパティに依存している場合、更新時に古いコントローラーを破棄して新しいものを作成します。保留中のコールバックが古いコントローラーをキャプチャしていると、それは今や破棄済みのインスタンスにアクセスします。

根底にある契約は、[Flutter の ChangeNotifier API ドキュメント](https://api.flutter.dev/flutter/foundation/ChangeNotifier-class.html)によれば次のとおりです。`dispose()` が呼ばれると、そのオブジェクトは使用不能になり、それ以降の使用はデバッグビルドでスローします。アサーションはリリースビルドから除去されるため、リリースでは同じコードはクラッシュせず、代わりに古い、または null の状態を読みます。だからこそ、アサーションを黙らせるのではなく原因を修正するのです。

## 最小再現

このウィジェットは、fetch が返る前に画面を離れるとクラッシュします。コンパイルして動作し、ネットワークが速ければ通ります。

```dart
// Flutter 3.44, Dart 3.x -- throws "A TextEditingController was used after being disposed".
import 'package:flutter/material.dart';

class SearchBox extends StatefulWidget {
  const SearchBox({super.key});

  @override
  State<SearchBox> createState() => _SearchBoxState();
}

class _SearchBoxState extends State<SearchBox> {
  final _controller = TextEditingController();

  @override
  void initState() {
    super.initState();
    _prefill();
  }

  Future<void> _prefill() async {
    // Pretend this hits the network and takes ~500ms.
    final lastQuery = await Future.delayed(
      const Duration(milliseconds: 500),
      () => 'flutter dispose error',
    );
    // If the user popped this screen during those 500ms, the State and the
    // controller are already disposed. This line then throws.
    _controller.text = lastQuery;
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return TextField(controller: _controller);
  }
}
```

この画面を開き、0.5 秒以内に閉じてください。`dispose()` が実行され、`_controller.dispose()` がコントローラーを殺し、`Future` が完了し、`_controller.text = ...` がスローします。このクラッシュはタイミング依存であり、まさにそれがコードレビューを生き延びて本番に出てしまう理由です。

## 修正の詳細

修正は、私がどれだけ推奨するかの順に並べています。自分の原因に合うものを選んでください。

### 1. 非同期コールバックを mounted で保護する（推奨）

`await`（または遅延コールバック）の後にコントローラーへアクセスしたり `setState` を呼んだりするコードが続くすべての箇所で、まず `mounted` をチェックします。`State` が解放されると `mounted` は `false` になるため、コントローラーにアクセスする前にガードが短絡します。

```dart
// Flutter 3.44, Dart 3.x -- correct: bail out if the widget is gone.
Future<void> _prefill() async {
  final lastQuery = await Future.delayed(
    const Duration(milliseconds: 500),
    () => 'flutter dispose error',
  );
  if (!mounted) return; // the State (and the controller) may be disposed
  _controller.text = lastQuery;
}
```

ルールはこうです。`State` メソッド内のすべての `await` の後、`this`、コントローラー、または `setState` にアクセスする次の行の前には `mounted` チェックを置かなければなりません。ここでは `await` が 1 つなのでガードは 1 つです。メソッドに 2 つの await があり、それぞれの後でコントローラーにアクセスするなら、2 つのガードが必要です。Dart アナライザーの `use_build_context_synchronously` リントは、この誤りの `BuildContext` 版を捕捉します。コントローラーもまったく同じように扱ってください。

`Timer` や `stream.listen` の場合、ガードはコールバックの内側に置きます。

```dart
// Flutter 3.44, Dart 3.x
_sub = someStream.listen((value) {
  if (!mounted) return;
  _controller.text = value;
});
```

さらに良いのは、`dispose()` でサブスクリプションやタイマーをキャンセルし、コールバックが解体後に決して発火しないようにすることです。キャンセルはガードより clean です。ガードされていてもキャンセルされていないサブスクリプションは、ユーザーがすでに離れた画面のイベントごとに目を覚まし、メモリを確保し、ガードを実行するからです。解放の順序については[コントローラーの破棄に関するガイド](/ja/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)を参照してください。

### 2. 所有権を正す: 自分のものでないものを破棄しない

クラッシュが非同期でない場合、ほぼ常に所有権の問題です。ルールは 1 行です。コントローラーを作成した者がそれを破棄し、他の誰も破棄しない。コンストラクタ経由でコントローラーを受け取るウィジェットは、決してそれを破棄してはいけません。

```dart
// Flutter 3.44, Dart 3.x
class ParentForm extends StatefulWidget {
  const ParentForm({super.key});
  @override
  State<ParentForm> createState() => _ParentFormState();
}

class _ParentFormState extends State<ParentForm> {
  final _email = TextEditingController(); // parent creates -> parent owns

  @override
  void dispose() {
    _email.dispose(); // owner disposes, exactly once
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => EmailField(controller: _email);
}

class EmailField extends StatelessWidget {
  final TextEditingController controller;
  const EmailField({super.key, required this.controller});

  // Receives the controller. Does NOT dispose it. No dispose() here at all.
  @override
  Widget build(BuildContext context) => TextField(controller: controller);
}
```

もし `EmailField` が `StatefulWidget` で `widget.controller` を破棄していたら、親による後の `_email` の使用がまさにこのエラーをスローします。修正は、子からその `dispose()` 呼び出しを削除することです。鏡像のバグ（親が破棄を忘れる）はリークであり、上記の破棄ガイドで扱っています。

### 3. 状態管理レイヤーに破棄を所有させる

コントローラーが Riverpod のプロバイダー、GetX のコントローラー、またはウィジェットの外側の任意のオブジェクトに引き上げられると、破棄もそれとともに移動します。ウィジェットは、プロバイダーから借りたコントローラーを破棄してはならず、プロバイダーの `onDispose`（Riverpod）または `onClose`（GetX）が、今や `dispose()` 呼び出しの存在する場所です。Riverpod の `autoDispose` では、画面がそれを必要とする間プロバイダーを生かしておき（`ref.keepAlive()` または `autoDispose` でないプロバイダーを使う）、コントローラーをまだ保持しているウィジェットの下で再計算されないようにします。状態管理の移行中にライフサイクルの所有権を移すことは、これが静かに壊れるまさにその場所です。私が[Flutter アプリを GetX から Riverpod へ移行する](/ja/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/)を、まさにこの理由から、意図的かつ段階的な移行として書き上げたのはそのためです。

### 4. didUpdateWidget では慎重に再作成する

コントローラーが `widget` のプロパティに依存していて、`didUpdateWidget` でそれを差し替える場合、古いものを破棄して新しいものを割り当て、保留中のコールバックが古いインスタンスを参照し続けていないことを確認してください。

```dart
// Flutter 3.44, Dart 3.x
@override
void didUpdateWidget(covariant MyField oldWidget) {
  super.didUpdateWidget(oldWidget);
  if (oldWidget.initialText != widget.initialText) {
    _controller.dispose();
    _controller = TextEditingController(text: widget.initialText);
  }
}
```

古いコントローラーに対して開始された非同期処理は、着地する前に `mounted` をチェック（そして理想的にはキャンセル）しなければなりません。さもないと、たった今差し替えた破棄済みのインスタンスに書き込んでしまいます。

## 落とし穴とバリエーション

`setState() called after dispose()`。同じ根本原因、異なるアサーションです。解体後に `setState` を呼ぶ非同期コールバックは、`setState` が内部的に `mounted` 相当の状態をチェックするため、コントローラーのメッセージではなくこちらをスローします。修正は同一です。`if (!mounted) return;` で保護します。同じコールバックがたいていコントローラーへの書き込みと `setState` の両方を行うため、しばしばコントローラーのクラッシュと一緒に現れます。このファミリーのビルドフェーズの親戚については[setState または markNeedsBuild called during build](/ja/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/)を参照してください。

`A ScrollController was used after being disposed`、`A FocusNode was used after being disposed`、`An AnimationController was used after being disposed`。同じアサーション、同じ修正です。メッセージはあなたがアクセスした `ChangeNotifier` の名前を示しますが、診断（dispose 後の非同期、または所有者の誤り）は変わりません。

クラッシュは時々しか起きない。それは非同期原因の特徴であり、不安定なフレームワークの兆候ではありません。速いネットワークはそれを隠し、遅いネットワークや素早いユーザーがそれを露わにします。このエラーの断続的な版をノイズとして片付けないでください。コントローラーへの書き込みの前に人工的な遅延を追加し、その遅延の間に画面を閉じることで再現してください。

テストではスローするがアプリではしない。ウィジェットテストはウィジェットを積極的に解体し、フレームを決定論的にポンプするため、実際のアプリでは隠れている `mounted` ガードの欠落が `testWidgets` の下では即座に表面化します。それはテストが仕事をしているのです。Flutter チームはこの 1 つのバリエーションを[flutter/flutter の issue 98965](https://github.com/flutter/flutter/issues/98965)で追跡しています。テスト内の保留中のタイマーが破棄済みのコントローラーにアクセスするもので、そこでの修正もやはり `dispose()` でタイマーをキャンセルすることです。

異なるルート上の 2 つの `TextField` で 1 つのコントローラーを再利用する。コントローラーは単一所有者です。`TextEditingController` を長命のシングルトンに格納し、それを画面 A のフィールドと画面 B のフィールドに渡すと、一方の画面の解放がもう一方の下でコントローラーを解放します。各フィールドに独自のコントローラーを与えるか、テキストを共有状態に移し、各フィールドがローカルのコントローラーを所有するようにしてください。

このバグのクラス全体を取り除く唯一の規律はこうです。コントローラーにはちょうど 1 人の所有者があり、その所有者がちょうど 1 回それを破棄し、それにアクセスするすべての非同期パスは `mounted` チェックで保護されるか、解体前にキャンセルされる。これを `dispose()` の反射として組み込めば、エラーは現れなくなります。逆の失敗（まったく破棄されないコントローラー）も捕まえたい場合は、[破棄ガイドの leak_tracker ワークフロー](/ja/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)が契約の両側を守らせてくれます。そして、非同期データを状態としてモデル化し[優雅なローディングとエラーの状態](/ja/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)で扱えば、await 後の危険な書き込みをコントローラーから完全に遠ざけられます。

## 関連記事

- [Flutter でメモリリークを避けるためにコントローラーを破棄する方法](/ja/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)は鏡像です。このクラッシュは破棄済みのコントローラーを使うこと、あのガイドは破棄を忘れることです。
- [解決: Flutter で setState() または markNeedsBuild() called during build](/ja/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/)は、非同期コールバックに対する `mounted` ガードの修正を共有します。
- [Flutter アプリでネットワークエラーを優雅に処理する方法](/ja/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/)は、このクラッシュを引き起こす遅いレスポンスの出どころです。
- [Flutter Riverpod で AsyncValue を使ってローディングとエラーの状態を表示する方法](/ja/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)は、非同期結果を await 後にコントローラーへ直接書き込むのではなく、状態として保持します。

## 出典

- [ChangeNotifier, Flutter API リファレンス](https://api.flutter.dev/flutter/foundation/ChangeNotifier-class.html) -- "used after being disposed" アサーションが定義されている場所。
- [TextEditingController, Flutter API リファレンス](https://api.flutter.dev/flutter/widgets/TextEditingController-class.html) -- コントローラーのライフサイクルと `dispose()` の契約。
- [State.mounted, Flutter API リファレンス](https://api.flutter.dev/flutter/widgets/State/mounted.html) -- コントローラーがまだ生きているかどうかを教えるフラグ。
- [flutter/flutter issue 98965](https://github.com/flutter/flutter/issues/98965) -- 保留中のタイマーによってウィジェットテストで表面化するエラー。
