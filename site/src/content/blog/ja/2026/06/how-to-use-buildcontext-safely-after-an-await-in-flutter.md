---
title: "Flutter で await の後に BuildContext を安全に使う方法"
description: "await の前に context から必要なものを取得し、再開時に if (context.mounted) return で保護します。完全なパターン、それを強制する linter ルール、そしてそれが見逃すエッジケースを解説します。"
pubDate: 2026-06-22
tags:
  - "flutter"
  - "dart"
  - "async"
lang: "ja"
translationOf: "2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-22
---

ルールは短いです。`BuildContext` はそのウィジェットがマウントされている間だけ有効であり、`await` はコードが再開する前にウィジェットをアンマウントしてしまう可能性があります。ですから、最初の `await` の前に context から必要なものをすべて取得し（`NavigatorState`、`ScaffoldMessengerState`、テーマの値など）、非同期処理を行い、それから context に再び触れる前に `if (!context.mounted) return;` で再開を保護してください。この一つの習慣だけで、「context がツリーから外れた後に使ってしまった」という種類のクラッシュ一族すべてを防げます。このガイドでは Flutter 3.44（stable、2026 年 5 月）と Dart 3.x を使用します。

`BuildContext` は、しまっておいて再利用できるデータの袋ではありません。それはウィジェットツリー内の `Element` への生きた handle です。ユーザーが別の画面へ移動した瞬間、親があなたを存在ごと再構築した瞬間、あるいはルートがポップされた瞬間に、その element は非アクティブ化され、その後破棄されます。死んだ element から祖先を読み取ること（`Navigator.of`、`Theme.of`、`Provider.of`）は未定義です。デバッグでは assertion が出ますが、release では古い値が返るか、ずっと後で null の逆参照が起こります。非同期のケースが最も痛いのは、「context が有効だった」と「context が使われる」の間の隙間がソースコード上では見えないからです。それは `await` の中に隠れています。

## なぜ await が危険な部分なのか

Flutter は `build` を同期的に呼び出し、他の何かがツリーに触れる前にそれが完了することを期待します。コードがイベントハンドラーから同期的に実行されている間は、context はずっと有効なままです。`await` を呼び出した瞬間、制御をイベントループに返します。他のフレームが実行されます。ユーザーは戻るボタンをタップできますし、親の `StreamBuilder` が再構築されることもありますし、タイムアウトがルートのポップを引き起こすこともあります。継続が再開されるとき、あなたは後のフレームにいて、`context` を所有していたウィジェットは消えているかもしれません。

```dart
// Flutter 3.44, Dart 3.x -- the gap is invisible but real
Future<void> _onSave() async {
  await api.save(form);            // <-- control leaves here, frames run
  Navigator.of(context).pop();     // <-- may execute on a dead context
}
```

`_onSave` の中には間違って見えるものは何もありません。バグは構造的なものです。`context` は呼び出し箇所で暗黙的にキャプチャされ、サスペンドポイントをまたいで再利用されています。これはまさに、[非アクティブ化されたウィジェットの祖先の検索が安全でないというクラッシュ](/ja/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/) がエラーメッセージの側から説明している状況です。ここでは予防の側から見ています。

## 安全なパターン、ステップごとに

非同期メソッドがサスペンド後に context を必要とするときは、必ず次の 4 つのステップに従ってください。最初の 2 つが要であり、残りはそれらを誠実に保つための手段です。

1. **最初の `await` の前に context からすべてを読み取る。** ウィジェットがまだマウントされている間に、`Navigator.of(context)`、`ScaffoldMessenger.of(context)`、`Theme.of(context)`、そして `Provider.of`/`context.read` の呼び出しをローカル変数へ解決します。これらは長寿命の state オブジェクトを返し、元の element が死んだ後でも有効なままです。
2. **非同期処理を行う。** これで `await` はいくらでも時間をかけてかまいません。あなたは context をそれをまたいで保持しているのではなく、element より長生きする、解決済みの state オブジェクトを保持しているのです。
3. **mounted チェックで再開を保護する。** `await` の直後に `if (!context.mounted) return;` を書きます（`State` の中であれば `if (!mounted) return;`）。await の間にウィジェットがツリーから外れていたら、ここで止まり、死んだ context には決して触れません。
4. **隙間の後はキャプチャしたオブジェクトだけを使う。** `navigator.pop()` や `messenger.showSnackBar(...)` は、ステップ 1 でキャプチャしたローカル変数に対して呼び出します。再び `Navigator.of(context)` を呼ばないでください。

不具合のある例に適用すると、次のようになります。

```dart
// Flutter 3.44, Dart 3.x -- safe
Future<void> _onSave() async {
  final navigator = Navigator.of(context);          // 1. capture
  final messenger = ScaffoldMessenger.of(context);

  await api.save(form);                              // 2. async work

  if (!context.mounted) return;                      // 3. guard

  messenger.showSnackBar(                            // 4. use captures
    const SnackBar(content: Text('Saved')),
  );
  navigator.pop();
}
```

これを正しくしているのは、2 つの独立した要素です。await の前に `navigator` と `messenger` をキャプチャすることで、非アクティブ化された element に対して `.of(context)` を呼ぶことが決してなくなります。そして `context.mounted` チェックは、ユーザーがすでに離れている場合に UI 処理を丸ごとスキップします。これはほとんどの場合まさに望ましい挙動です。誰も見ていない画面に snackbar を表示しても意味がありません。

## State の mounted と BuildContext の mounted

`mounted` のゲッターは 2 つあり、同じ問いに答えるとはいえ、どこで使うかという点で互換ではありません。

`State.mounted` は昔から存在します。`StatefulWidget` の state クラスの中では `if (!mounted) return;` と書きます。これは `initState` と `dispose` の間で `true` であり、重要なことに、`deactivate` の間にはすでに `false` です。そのため、「ウィジェットが完全に死んだ」ケースだけでなく、「ウィジェットが去ろうとしている」ケースも正しく捉えます。

`BuildContext.mounted` は、`State` ではなく context しか手元にないケースのために Flutter 3.7（Dart 2.19）で登場しました。ヘルパー関数、`StatelessWidget` 内のコールバック、拡張メソッドなどです。基盤となる element がまだマウントされているかどうかを返します。

```dart
// Flutter 3.44, Dart 3.x
// Inside a State subclass:
if (!mounted) return;          // State.mounted

// In a helper that only has a context:
if (!context.mounted) return;  // BuildContext.mounted
```

state クラスの中にいるときは `State.mounted` を優先してください。実際に自分が所有しているウィジェットのライフサイクルを読み取るからです。context しか持っていないときは `context.mounted` を使います。どちらも await の*後*にチェックしなければならず、決して前ではありません。隙間とは await のことなので、その前に走るチェックは後の状態について何も教えてくれません。

## なぜキャプチャだけでは足りず、保護だけでも足りないのか

人はしばしば 2 つの半分のうち片方だけを行い、これで安全だと思い込みます。安全ではありません。

**キャプチャ**だけして保護を省くと、非アクティブ化された context のクラッシュは避けられますが、ユーザーがすでに離れた画面に対して UI の副作用を実行してしまう可能性は残ります。間違ったルート上で点滅する snackbar や、もう自分のものではないルートをポップする `pop()` などです。キャプチャは呼び出しを合法にし、保護はそれを*正しく*します。

**保護**だけして キャプチャを省くと、微妙な順序のバグが生じます。次を見てください。

```dart
// Flutter 3.44, Dart 3.x -- still wrong despite the guard
Future<void> _onSave() async {
  await api.save(form);
  if (!context.mounted) return;
  Navigator.of(context).pop();   // re-reads context AFTER the gap
}
```

これは通常は動きます。`context.mounted` のチェックが `Navigator.of` の呼び出しと同じ同期 tick で通過したからです。しかし脆弱です。チェックと検索の間に 2 つ目の `await` を追加すると、窓が再び開きます。先にキャプチャするパターンは、await 後のパスから検索そのものを取り除くので、古くなりうるものが何も残りません。「前にキャプチャ、後に保護、キャプチャしたものを使う」を、不可分な一つの動作として扱ってください。

## それを強制する linter ルール: use_build_context_synchronously

Dart には `use_build_context_synchronously` という linter ルールが付属しており、await と使用の間に `mounted` の保護なしで非同期の隙間の後に使われた `BuildContext` を指摘します。これは `flutter_lints` パッケージでデフォルトで有効になっており、新しい Flutter プロジェクトは `analysis_options.yaml` 経由でこれを取り込みます。

```yaml
# analysis_options.yaml -- on by default in flutter_lints
include: package:flutter_lints/flutter.yaml
```

プロジェクトがデフォルトより古い場合や include を外してしまった場合は、ルールを明示的に追加してください。

```yaml
# analysis_options.yaml
linter:
  rules:
    use_build_context_synchronously: true
```

このルールは保護を理解します。await の後に `if (!context.mounted) return;`（または `if (context.mounted) { ... }`）と書くと警告が消えます。アナライザーが、それを使うパス上で context が生きていることを証明できるからです。これが、自分で手書きした同等物ではなく `if (context.mounted)` が正準形である理由です。linter は既知の安全な形をパターンマッチします。以前のバージョンのアナライザーは、`BuildContext.mounted` を `if (context.mounted) {}` という字義どおりの形以外で使うと誤検出を出していたほどで、これは Dart SDK の issue リストに記録されています。現在のバージョンは一般的な形を扱いますが、慣用的な保護にこだわるもう一つの理由になります。

linter が**捉えない**ものも同じくらい重要です。これは構文的なチェックなので、関数の境界をまたいで見ることはできません。`BuildContext` をヘルパー関数に渡し、その関数の中で `await` すると、アナライザーは隙間と後の使用を結びつけられないことがよくあります。また、context をフィールドにキャプチャしてずっと後で再利用するロジックからもあなたを救いません。linter は強力な第一防衛線ではありますが、証明ではありません。

## ヘルパー関数に context を渡す

linter から逃れるよくある方法は、await を `BuildContext` をパラメーターに取るヘルパー関数へ移すことです。このパターン自体は問題ありませんが、ヘルパー関数は今や保護の責任を引き受けており、呼び出し側を信頼するのではなく、自分自身で `mounted` を再チェックすべきです。

```dart
// Flutter 3.44, Dart 3.x -- the helper guards its own context use
Future<void> confirmAndDelete(BuildContext context, Item item) async {
  final messenger = ScaffoldMessenger.of(context);

  final ok = await showDialog<bool>(
    context: context,
    builder: (_) => const ConfirmDialog(),
  );

  if (ok != true) return;
  if (!context.mounted) return;   // guard inside the helper

  await repository.delete(item);
  if (!context.mounted) return;   // second await, second guard

  messenger.showSnackBar(const SnackBar(content: Text('Deleted')));
}
```

2 つの await は 2 つの保護を意味します。各サスペンドポイントが窓を再び開くので、`mounted` チェックは、context の使用に先立つそれぞれの await の後に置くべきであり、最初の一つだけではありません。`messenger` を前もってキャプチャしておけば、最後の行が context を読み直すことは決してありません。

## ループ、リトライ、複数の await

context の使用が複数の可能なサスペンドの後に位置する場所では、どこでも各パスを点検してください。リトライループは教科書的なケースです。

```dart
// Flutter 3.44, Dart 3.x
Future<void> _uploadWithRetry() async {
  final messenger = ScaffoldMessenger.of(context);

  for (var attempt = 1; attempt <= 3; attempt++) {
    try {
      await api.upload(file);     // suspension point inside the loop
      break;
    } catch (_) {
      if (attempt == 3) rethrow;
      await Future<void>.delayed(const Duration(seconds: 1)); // another one
    }
  }

  if (!context.mounted) return;   // single guard after the loop is enough
  messenger.showSnackBar(const SnackBar(content: Text('Uploaded')));
}
```

ここではループ内に保護は不要です。ループ内のどこも context に触れていないからです。context の唯一の使用はループの後なので、一つの保護がすべての出口パスをカバーします。原則は一般化できます。保護は、それに先立ちうる最後の await の後、各 context の使用の直前に置いてください。[エラーとローディングの丁寧な処理](/ja/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) のような構造化されたアプローチに頼ると、これらのフローは読みやすく保たれます。リトライとエラーの状態が、await の後に散らばった命令的な UI 呼び出しではなく、ウィジェットがレンダリングするデータになるからです。

## StatelessWidget には mounted がないので context を使う

`StatelessWidget` には `State` がないので、`mounted` フィールドもありません。まさにそのために存在する `context.mounted` を使ってください。

```dart
// Flutter 3.44, Dart 3.x -- StatelessWidget callback
ElevatedButton(
  onPressed: () async {
    final navigator = Navigator.of(context);
    await Future<void>.delayed(const Duration(seconds: 1));
    if (!context.mounted) return;
    navigator.pop();
  },
  child: const Text('Close'),
);
```

ステートレスウィジェットのコールバックで複数の保護が必要になっていると気づいたら、それはしばしば、そのウィジェットが stateful であるべきだという合図か、あるいは非同期処理がボタンハンドラーにインラインで書かれるのではなくコントローラーや notifier に属するべきだという合図です。

## 落とし穴とよく似たケース

**`Navigator.pop` の後に context を使う。** 古典的な 2 行です。`Navigator.pop(context)` に続いてもう一つの `.of(context)` 呼び出し。pop はルートの element の非アクティブ化を始めるので、await が見当たらなくても 2 つ目の検索が失敗することがあります。ポップする前に navigator（とその他必要なもの）をキャプチャしてください。

**`initState` では inherited の検索ができない。** `Theme.of`、`MediaQuery.of`、そしてあらゆる `dependOnInheritedWidgetOfExactType` は `initState` では不正です。element がまだ継承された依存関係に配線されていないからです。これらの読み取りは、context が完全に有効な `didChangeDependencies` へ移してください。これは非同期のものとは別の assertion ですが、「context は今この瞬間有効か?」という同じ問いから生じています。

**release ビルドはクラッシュを隠す。** 非アクティブ化された context の assertion はデバッグでしか発火しません。profile と release では検索が null を返し、スタックのどこか下の方で `Null check operator used on a null value` が出ます。クラッシュが release でのみ、しかもナビゲーションの後にだけ現れるなら、保護されていない await 後の context 使用を疑ってください。[build 中に呼ばれた setState の保護](/ja/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) も、デバッグでのみ有効な assertion という同じ性質を持っています。

**Riverpod での同等物。** `BuildContext` の代わりに `WidgetRef` を保持している場合、対応するクラッシュは [Cannot use "ref" after the widget was disposed](/ja/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/) です。同じ根本原因、同じ修正です。await の前に読み、後で保護します。非同期処理を [AsyncValue によるローディングとエラー状態](/ja/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) としてモデル化すると、ほとんどの手動の保護を回避できます。フレームワークがウィジェットのライフサイクルを代わりに追跡してくれて、手作業で context をいじるのをやめられるからです。

**タイマーとストリームのリスナー。** `Timer`、`Stream.listen`、アニメーションステータスのリスナーで使われた context は、ウィジェットが消えた後に発火することがあります。`mounted` で保護し、さらに `dispose` でソースをキャンセルしてコールバックがそもそも発火しないようにしてください。これは [リークを避けるためにコントローラーを破棄する](/ja/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) ときに適用するのと同じ規律です。

## このエラー一族すべてを引退させる一つの習慣

`BuildContext` は、同期実行の開始から次の `await` までの間だけ有効だと考えてください。サスペンドする前に、必要になる state オブジェクトを読み出します。再開した後は、ツリーに結びついた何かに触れる前に `mounted` をチェックします。これを機械的に行えば、非アクティブ化された祖先のクラッシュ、破棄されたコントローラーのクラッシュ、await 後の null 逆参照は現れなくなります。それらは決して 3 つのバグではなかったからです。一つのルールが、3 通りに破られていただけなのです。

## 出典

- [use_build_context_synchronously linter ルール](https://dart.dev/tools/linter-rules/use_build_context_synchronously)、Dart の linter ルール。アナライザーが何を指摘し、どの保護の形を認識するかを定義しています。
- [BuildContext.mounted プロパティ](https://api.flutter.dev/flutter/widgets/BuildContext/mounted.html)、Flutter API ドキュメント（Flutter 3.7 で追加）。
- [State.mounted プロパティ](https://api.flutter.dev/flutter/widgets/State/mounted.html)、Flutter API ドキュメント。
- [flutter/flutter#19462](https://github.com/flutter/flutter/issues/19462)、非アクティブ化された context のクラッシュを非同期コールバックまでたどる正準的な issue。
