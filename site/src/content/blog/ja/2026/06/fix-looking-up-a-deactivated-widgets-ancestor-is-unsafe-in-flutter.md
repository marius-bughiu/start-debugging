---
title: "解決: Flutter の Looking up a deactivated widget's ancestor is unsafe"
description: "このクラッシュは、ウィジェットがツリーから外れた後に context.of() を呼び出したことを意味します。通常は非同期コールバックや dispose() の中です。await の前か didChangeDependencies() で値を取得してください。"
pubDate: 2026-06-14
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
lang: "ja"
translationOf: "2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-14
---

そのコンテキストを所有するウィジェットがツリーから取り除かれた後に、`BuildContext` を使って祖先を検索しました（`Navigator.of`、`Theme.of`、`ScaffoldMessenger.of`、`MediaQuery.of`、`Provider.of`、`InheritedWidget`）。よくある引き金は2つあります。ユーザーが別の画面へ遷移した後に完了する非同期コールバックと、`dispose()` 内での検索です。修正方法は、`await` の前（または `didChangeDependencies` 内）でコンテキストから必要なものを取得しておき、await 後の処理を `if (!mounted) return;` でガードすることです。このガイドでは Flutter 3.44（安定版、2026年5月）と Dart 3.x を使用します。

`BuildContext` はツリー内の `Element` へのハンドルにすぎません。その要素がいったん非アクティブ化されると、そこから上に向かってたどると古い祖先や、まさに移動しようとしているノードを返す可能性があるため、フレームワークは誤った答えを返す代わりに検索を拒否します。これは[破棄された後に使用されたコントローラー](/ja/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/)と同じライフサイクルのバグの仲間です。オブジェクトはまだ存在しますが、触れることはもはや有効ではありません。

## コンテキストの中でのエラー

Flutter が出力する完全なメッセージは次のようになります。

```
FlutterError (Looking up a deactivated widget's ancestor is unsafe.
At this point the state of the widget's element tree is no longer stable.
To safely refer to a widget's ancestor in its dispose() method, save a reference
to the ancestor by calling dependOnInheritedWidgetOfExactType() in the widget's
didChangeDependencies() method.)
```

release ビルドではアサーションのテキストが取り除かれ、代わりにそのままのクラッシュ、またはスタックのさらに下で `Null check operator used on a null value` が表示されます。検索が `null` を返したからです。このアサーションは `package:flutter/src/widgets/framework.dart` の `Element._debugCheckStateIsActiveForAncestorLookup` から発生し、すべての `dependOnInheritedWidgetOfExactType` と `findAncestorStateOfType` の呼び出しが debug モードで最初に実行します。

## なぜ「deactivated」は「disposed」と異なるのか

Flutter はウィジェットを2つのフェーズで解体します。まず `deactivate()` が実行されます。要素は親から切り離され、非アクティブのリストに移されます。そこで `GlobalKey` を使って親付け替えされていれば、同じフレーム内で再アクティブ化される可能性があります。フレームの終わりまでに回収されなかった場合にのみ `dispose()` が実行され、状態は最終的に死にます。

`State` の `mounted` ゲッターは両方のフェーズで `false` です。これが鍵となる洞察です。`mounted` は「まだ破棄されていない」という意味ではなく、「現在ツリーに接続されている」という意味です。だからこそ、メッセージ内の語が「disposed」ではなく「deactivated」であっても、`mounted` はこのエラーに対する正しいガードなのです。

```dart
// Flutter 3.44, Dart 3.x
@override
void deactivate() {
  // mounted is already false by the time your async callback resumes here
  super.deactivate();
}
```

## 最小再現: await の後の検索

最もよくある形です。ボタンをタップし、非同期処理を行い、それからコンテキストに触れます。await の途中でユーザーが戻ると、コールバックが再開されるときにはコンテキストは非アクティブ化されています。

```dart
// Flutter 3.44, Dart 3.x -- crashes if the user leaves mid-await
class SaveButton extends StatefulWidget {
  const SaveButton({super.key});
  @override
  State<SaveButton> createState() => _SaveButtonState();
}

class _SaveButtonState extends State<SaveButton> {
  Future<void> _save() async {
    await Future<void>.delayed(const Duration(seconds: 2)); // network call
    // If the widget was popped during those 2s, this throws:
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Saved')),
    );
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    return ElevatedButton(onPressed: _save, child: const Text('Save'));
  }
}
```

2つ目の再現は `dispose()` 内での検索で、要素がその時点ですでに切り離されているため、常に安全ではありません。

```dart
// Flutter 3.44, Dart 3.x -- always throws in debug
@override
void dispose() {
  // The element is detached; this ancestor lookup is the exact thing the
  // assertion forbids.
  final messenger = ScaffoldMessenger.of(context);
  messenger.clearSnackBars();
  super.dispose();
}
```

## 修正 1: await の前に取得し、後でガードする

これは非同期のケースに対する正しい修正であり、最初に手を伸ばすべきものです。`BuildContext` はウィジェットがマウントされている間だけ読み取りが安全なので、最初の `await` の前に、そこから必要なものをすべて同期的に読み取ってください。その後は、取得したオブジェクト（`NavigatorState`、`ScaffoldMessengerState`）は、ウィジェットがツリーから外れても有効なままです。これらの状態オブジェクトは個々の要素検索よりも長く存続するからです。

```dart
// Flutter 3.44, Dart 3.x -- safe
Future<void> _save() async {
  // Capture the ancestor state objects while still mounted.
  final messenger = ScaffoldMessenger.of(context);
  final navigator = Navigator.of(context);

  await Future<void>.delayed(const Duration(seconds: 2));

  if (!mounted) return; // the widget left the tree; stop here

  messenger.showSnackBar(const SnackBar(content: Text('Saved')));
  navigator.pop();
}
```

ここでは2つのことが働いています。`await` の前に `messenger` と `navigator` を取得しておくことは、非アクティブ化されたコンテキストに対して `.of(context)` を決して呼ばないことを意味します。次に `if (!mounted) return;` は、ユーザーがすでに離れていれば UI の更新を完全にスキップします。これはいずれにせよほとんどの場合に望ましい動作です。`mounted` は `await` の前ではなく後でチェックしなければならない点に注意してください。await こそが隙間が開く場所だからです。

Flutter 3.7 以降には `BuildContext.mounted` ゲッターもあるので、（`State` ではなく）コンテキストしか持っていない場合は `if (!context.mounted) return;` と書けます。`flutter_lints` でデフォルトで有効になっている lint ルール `use_build_context_synchronously` は、この再現で欠けているガードをまさに指摘するので、有効にして、実行時の前にアナライザーにこうしたケースを捕まえさせてください。

## 修正 2: inherited widget を didChangeDependencies で読む

`.of(context)` 経由で見つけた何かから登録解除するためなど、`dispose()` の間に継承された値が本当に必要な場合、dispose 時に検索することはできません。もっと早く取得してください。`didChangeDependencies()` は `initState` の直後と、継承された依存関係が変わるたびに実行され、そこではコンテキストは完全に有効です。

```dart
// Flutter 3.44, Dart 3.x -- safe dispose-time access
class _MyWidgetState extends State<MyWidget> {
  late MyModel _model;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Captured while mounted; survives into dispose().
    _model = MyModelScope.of(context);
  }

  @override
  void dispose() {
    _model.removeListener(_onChange); // no context lookup needed
    super.dispose();
  }
}
```

これはまさにエラーメッセージが指示していることを現代化したものです。テキストはいまだに `dependOnInheritedWidgetOfExactType()` と言っており、これは `Theme.of`、`MediaQuery.of` などがラップする低レベルの呼び出しです。直接呼ぶことはまれで、`didChangeDependencies` で型付きの `.of` アクセサーを呼ぶことが同じことをします。

## 修正 3: 自分で制御していないコールバック内でコンテキストを検索しない

微妙なバリエーションです。検索はあなたの `dispose()` の中ではなく、dispose の後に発火するコールバックの中にあります。たとえば `Timer`、ストリームのリスナー、アニメーションのステータスリスナー、`Future.then` です。修正は同じガードですが、コールバックがそもそも発火しなくなるように `dispose()` でソースをキャンセルすることも望ましいです。

```dart
// Flutter 3.44, Dart 3.x
StreamSubscription<int>? _sub;

@override
void initState() {
  super.initState();
  _sub = someStream.listen((value) {
    if (!mounted) return;          // guard
    Navigator.of(context).pushNamed('/next');
  });
}

@override
void dispose() {
  _sub?.cancel();                  // stop the source
  super.dispose();
}
```

サブスクリプションをキャンセルするのがベルトで、`mounted` のチェックがサスペンダーです。キャンセルだけでたいてい直りますが、`cancel()` が実行されたときにすでに実行中だったコールバックは、もう一度だけ再開する可能性があるので、ガードは残しておいてください。[コントローラーやその他のリソースを破棄する](/ja/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)ときにも同じ組み合わせが当てはまります。ソースを解放し、遅れて発火しうるものをガードしてください。

## 落とし穴とよく似たケース

**`initState` は inherited widget での `.of(context)` には早すぎます。** `initState` でいくつかのことのために `context` を読むことはできますが、`dependOnInheritedWidgetOfExactType`（したがって `Theme.of`、`MediaQuery.of`）はそこでは許可されていません。要素がまだ継承された依存関係に配線されていないからです。それらの読み取りを `didChangeDependencies` に移してください。これは別のアサーション（"dependOnInheritedWidgetOfExactType was called before initState completed"）を投げるので、メッセージが `initState` に言及していれば、非アクティブ化のバリアントではなく、早すぎる検索のバリアントを見ていることになります。

**`Navigator.pop` の後にコンテキストを使う。** FlutterFlow や手書きのフォームでよくあるパターンは、`Navigator.pop(context)` のあと、次の行で別の `.of(context)` 呼び出しを行うことです。pop の後、ルートの要素は非アクティブ化を始めるので、2つ目の検索がエラーを投げる可能性があります。pop の前に navigator または messenger を取得してください。

**`GlobalKey` での親付け替え。** `GlobalKey` を使ってサブツリーを移動し、その中の何かが付け替えのフレーム中に祖先検索を行うと、一時的にこれに当たる可能性があります。これはまれです。修正は `WidgetsBinding.instance.addPostFrameCallback` で検索をフレームの後に延期し、それから `mounted` を再チェックすることです。

**release ビルドはこれを隠します。** メッセージは `assert` から来るので、debug でしか出力されません。profile と release では検索は静かに `null` を返し、後で null の参照外しでクラッシュします。release でだけ、しかも遷移の後でだけ `Null check operator used on a null value` が出る場合は、これを疑ってください。[`setState() called during build` のガード](/ja/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/)も同じように振る舞います。release モードで null を隠す debug 専用のアサーションです。

**これの Riverpod 版。** `BuildContext` の代わりに `WidgetRef` を使う場合、同等のクラッシュは [`Cannot use "ref" after the widget was disposed`](/ja/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/) です。同じ根本原因、同じ修正です。await の前に読み、後でガードします。[読み込みとエラーの状態のための `AsyncValue`](/ja/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) のような構造化された非同期パターンに手を伸ばすと、フレームワークがウィジェットのライフサイクルを代わりに追跡してくれるので、こうした手動のガードのほとんどを回避できます。

## これらすべてのケースを防ぐただ1つのルール

`BuildContext` は `build` から次の中断ポイントまでの間だけ有効だと考えてください。`await` した瞬間、戻ってきたときにはコンテキストは消えているかもしれないので、必要なものを先に取得して `mounted` でガードするか、検索が決して非同期境界を越えないように構造を変えてください。その習慣が身につけば、「deactivated widget's ancestor」のクラッシュ、破棄されたコントローラーのクラッシュ、破棄された ref のクラッシュは、すべて同じ理由で現れなくなります。

## Sources

- [State.mounted property](https://api.flutter.dev/flutter/widgets/State/mounted.html) と [State.didChangeDependencies](https://api.flutter.dev/flutter/widgets/State/didChangeDependencies.html)、Flutter API ドキュメント。
- [BuildContext.dependOnInheritedWidgetOfExactType](https://api.flutter.dev/flutter/widgets/BuildContext/dependOnInheritedWidgetOfExactType.html)、Flutter API ドキュメント（エラーメッセージで名指しされている呼び出し）。
- [flutter/flutter#19462: "Looking up a deactivated widget's ancestor is unsafe"](https://github.com/flutter/flutter/issues/19462)、非同期コールバック内の `Navigator.push` までこれをたどる正典的な issue。
- [use_build_context_synchronously lint](https://dart.dev/tools/linter-rules/use_build_context_synchronously)、欠けているガードを静的に指摘する Dart linter ルール。
