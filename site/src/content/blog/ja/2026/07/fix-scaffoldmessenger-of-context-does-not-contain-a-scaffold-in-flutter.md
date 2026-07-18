---
title: "解決: ScaffoldMessenger.of() was called with a context that does not contain a Scaffold (Flutter)"
description: "このエラーは、渡した BuildContext が Scaffold や ScaffoldMessenger の下ではなく上にあることを意味します。呼び出しを Builder で包むか、独立したウィジェットに切り出すか、GlobalKey を使ってください。"
pubDate: 2026-07-18
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "snackbar"
lang: "ja"
translationOf: "2026/07/fix-scaffoldmessenger-of-context-does-not-contain-a-scaffold-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-18
---

`ScaffoldMessenger.of() was called with a context that does not contain a Scaffold`（およびその古い双子である `Scaffold.of() called with a context that does not contain a Scaffold`）は、`.of()` に渡した `BuildContext` が、探そうとしている `Scaffold` や `ScaffoldMessenger` の *下* ではなく *上* にあることを意味します。ほとんどの場合、`Scaffold` を返すのと同じ `build` メソッドの中からそれを呼び出したときに起こります。呼び出しを `Builder` で包む、独立したウィジェットに切り出す、または `GlobalKey` 経由で messenger に到達することで解決します。Flutter 3.x（3.44）、Dart 3.x で検証しました。

## エラーの全体像

密接に関連する 2 つのメッセージがあり、どちらが出るかは呼び出した API によって決まります。まずは、多くの古い Stack Overflow の回答がいまだに使っている 2.0 以前の `Scaffold.of()` API による古典的なもの:

```
Scaffold.of() called with a context that does not contain a Scaffold.
No Scaffold ancestor could be found starting from the context that was passed
to Scaffold.of(). This usually happens when the context provided is from the
same StatefulWidget as that whose build function actually creates the Scaffold
widget being sought.
```

次に、`SnackBar` を表示するために使うべき API である `ScaffoldMessenger.of()` による現代的なもの:

```
No ScaffoldMessenger widget found.
Scaffold widgets require a ScaffoldMessenger widget ancestor.
Typically, the ScaffoldMessenger widget is introduced by the MaterialApp at
the top of your application widget tree.
```

どちらも装いが違うだけで同じバグです。ツリーの中で高すぎる位置から始まり、間違った方向に進む祖先探索です。探索が *なぜ* 失敗するのかを理解することが、`Builder` を当てずっぽうに貼り付けるのと、自分の状況にどの解決策が必要かを正確に知るのとの違いになります。

## なぜ探索が間違った場所から始まるのか

`ScaffoldMessenger.of(context)` と `Scaffold.of(context)` はどちらも祖先の走査を行います。内部では（継承された `_ScaffoldMessengerScope` を通じて）`context.dependOnInheritedWidgetOfExactType` を呼び出し、`context` の要素から始まってルートに向かって *上へ* 登り、最も近い一致する祖先を探します。決して下は見ません。

さて、失敗するウィジェットを思い浮かべてください。あなたは `Scaffold` を返す `build` メソッドを書き、そのメソッドのどこかで、同じ `build` の `context` パラメーターを使って `Scaffold.of(context)` または `ScaffoldMessenger.of(context)` を呼び出しています。その `context` は *あなたの* ウィジェットの要素に属します。あなたのウィジェットは、それが返す `Scaffold` の **親** です。したがって探索があなたの要素から登るとき、たった今作成した `Scaffold` は開始点より下にあり、走査は決してそこに到達しません。走査はあなたのウィジェットを通り過ぎ、あなたの上にある何かへと登り、適切なものを見つけられずにアサーションを投げます。

これはまさに古典的なメッセージが指摘するシナリオです: "the context provided is from the same StatefulWidget as that whose build function actually creates the Scaffold widget being sought"。

知っておく価値のある微妙な点が 1 つあります。エラーが見えたり見えなかったりする理由を説明するからです。`MaterialApp` はあなたの代わりにツリーの上部付近に `ScaffoldMessenger` を挿入します。つまり `ScaffoldMessenger.of(context)` は、*上に Scaffold がまったくない context からでも* 通常は成功します。アプリレベルの messenger を見つけるからです。したがって "No ScaffoldMessenger widget found" のバリアントは、祖先の messenger が本当に存在しないときにのみ発火します。`MaterialApp` より上にいる、messenger のない素の `WidgetsApp` でアプリを構築した、あるいはカスタムの `ScaffoldMessenger` スコープを作成してその外側から呼び出している、といった場合です。実際のコードではるかに多い失敗は `Scaffold.of()` の失敗か、間違った messenger を解決したために `SnackBar` が間違った場所に表示されるケースです。

## 最小再現

最も小さく確実なトリガーは、`Scaffold` を返す `build` メソッドの中に直接置かれたボタンが、そのメソッドの `context` で `.of()` を呼び出すものです:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
class HomePage extends StatelessWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Home')),
      body: Center(
        child: ElevatedButton(
          onPressed: () {
            // context here is HomePage's context, which is ABOVE the Scaffold.
            Scaffold.of(context).showSnackBar(   // throws
              const SnackBar(content: Text('Saved')),
            );
          },
          child: const Text('Save'),
        ),
      ),
    );
  }
}
```

`Scaffold.of` を `ScaffoldMessenger.of` に置き換えると、`MaterialApp` が messenger を提供するためクラッシュは消えますが、`SnackBar` はこの画面の `Scaffold` ではなくルートの messenger によって管理されるようになります。ほとんどのアプリではこれで問題なく、まさにこれが `ScaffoldMessenger` への移行が行われた理由です。ただし、入れ子になった `ScaffoldMessenger` スコープがある場合は、依然として間違った context から間違ったものを解決してしまう可能性があります。

## 解決策 1: Scaffold.of ではなく ScaffoldMessenger.of を使う

エラーが `Scaffold.of()` のバリアントで、`SnackBar` の表示・非表示・削除をしたいだけなら、最初かつ最良の解決策は単に `Scaffold.of()` の使用をやめることです。`Scaffold.of().showSnackBar()` は Flutter 2.0 で非推奨になり削除されました。現行の API は `ScaffoldMessenger` にあります:

```dart
// Flutter 3.x (tested 3.44)
// Before (deprecated, throws from the same build context):
Scaffold.of(context).showSnackBar(mySnackBar);
Scaffold.of(context).hideCurrentSnackBar();
Scaffold.of(context).removeCurrentSnackBar();

// After (current API):
ScaffoldMessenger.of(context).showSnackBar(mySnackBar);
ScaffoldMessenger.of(context).hideCurrentSnackBar();
ScaffoldMessenger.of(context).removeCurrentSnackBar();
```

messenger は画面の `Scaffold` より上（通常は `MaterialApp` レベル）に存在するため、上方向への探索はあなたの `build` の context から成功します。おまけに、`SnackBar` はナビゲーション時に消えるのではなく、ルート遷移をまたいで保持されてアニメーションするようになりました。これこそ `ScaffoldMessenger` の再設計の目的でした。`showSnackBar` は `ScaffoldFeatureController` も返し、これを使って閉じられた理由を待つことができます:

```dart
// Flutter 3.x (tested 3.44)
final controller = ScaffoldMessenger.of(context).showSnackBar(
  SnackBar(
    content: const Text('Item deleted'),
    action: SnackBarAction(label: 'Undo', onPressed: _undo),
  ),
);
final reason = await controller.closed; // SnackBarClosedReason.action, .timeout, ...
```

## 解決策 2: Builder で Scaffold の下の context を得る

`Scaffold` の子孫である context が本当に必要なこともあります。`SnackBar` 以外のために `Scaffold.of(context)` を呼び出している場合（`Scaffold.of(context).openDrawer()` で drawer を開く、`Scaffold.of(context).hasAppBar` を読む）、あるいはローカルの `ScaffoldMessenger` を設定してその *それ* を解決する必要がある場合です。最も安価な解決策は `Builder` で、ツリー内の位置が `Scaffold` より下にある新しい context を導入します:

```dart
// Flutter 3.x (tested 3.44)
@override
Widget build(BuildContext context) {
  return Scaffold(
    body: Builder(
      builder: (innerContext) {          // innerContext is BELOW the Scaffold
        return ElevatedButton(
          onPressed: () {
            ScaffoldMessenger.of(innerContext).showSnackBar(
              const SnackBar(content: Text('Saved')),
            );
          },
          child: const Text('Save'),
        );
      },
    ),
  );
}
```

`Builder` は自身の `builder` 関数を呼び出す以外に何もしませんが、渡す `innerContext` は `Scaffold` の子である要素に属します。これで上方向の走査は即座に `Scaffold`（および messenger のスコープ）に到達します。外側ではなく内側の context を使ってください。それがトリックのすべてです。

## 解決策 3: 呼び出し側を独立したウィジェットに切り出す

`Builder` は構造的な修正への近道です。ボタンを別の `StatelessWidget` または `StatefulWidget` に分離してください。その `build` メソッドは自然に `Scaffold` より下にある context を受け取るため、`.of()` は正しく解決され、二度と気にする必要がなくなります:

```dart
// Flutter 3.x (tested 3.44)
class HomePage extends StatelessWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Home')),
      body: const Center(child: SaveButton()),
    );
  }
}

class SaveButton extends StatelessWidget {
  const SaveButton({super.key});

  @override
  Widget build(BuildContext context) {
    // This context is a descendant of the Scaffold above.
    return ElevatedButton(
      onPressed: () => ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Saved')),
      ),
      child: const Text('Save'),
    );
  }
}
```

使い捨てのコールバックを超えるものには、これが好ましい選択肢です。入れ子の `Builder` より読みやすく、画面ウィジェットを薄く保ち、ボタンを独立してテスト可能にします。

## 解決策 4: 使える context がないときは GlobalKey を使う

context ベースの解決策は、メッセージを表示する時点でウィジェットツリーの中にいることを前提とします。そうでないとき（`bloc`、リポジトリ、バックグラウンドのコールバック、あるいは `BuildContext` を持たないエラーハンドラーから発火する `SnackBar`）は、`MaterialApp` に接続した `GlobalKey<ScaffoldMessengerState>` 経由で messenger に到達します:

```dart
// Flutter 3.x (tested 3.44)
final rootScaffoldMessengerKey = GlobalKey<ScaffoldMessengerState>();

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      scaffoldMessengerKey: rootScaffoldMessengerKey,
      home: const HomePage(),
    );
  }
}

// Anywhere, with no BuildContext at all:
void notifySaved() {
  rootScaffoldMessengerKey.currentState?.showSnackBar(
    const SnackBar(content: Text('Saved')),
  );
}
```

`currentState` はアプリがマウントされるまで null なので、`?.` で守ってください。これはウィジェットの外から `SnackBar` を表示するための公式に推奨されるパターンで、context がまったく関与しないため「どの context か?」という問いを完全に回避します。

## 落とし穴とよく似たケース

**`maybeOf` は投げる代わりに null を返します。** メッセージの表示を *試み* つつ、messenger がないときは静かに何もしたくない場合（まれですが、Material ツリーの外で動く可能性のある共有コードで有用）は、`ScaffoldMessenger.maybeOf(context)?.showSnackBar(...)` を使ってください。同じ探索を行いますが、アサーションを投げる代わりに `null` を返します。本当の構造的バグを覆い隠すために使ってはいけません。messenger がそこにあると期待しているなら、アサーションはあなたに親切をしているのです。

**`initState` で `.of()` を呼ぶ。** よくあるバリアントは `initState` で `SnackBar` を表示しようとすることです。context は存在しますが、フレームがまだレイアウトされておらず、あなたはまだ build/mount の中にいます。遅延させてください: `WidgetsBinding.instance.addPostFrameCallback((_) => ScaffoldMessenger.of(context).showSnackBar(...))`。さらに良いのは、`context` のタイミングにまったく依存しないように解決策 4 の `GlobalKey` を使うことです。

**`await` の後で context を使う。** 非同期の間に widget が破棄された場合、非同期ギャップの後で `ScaffoldMessenger.of(context)` を取得すると、投げるか、古くなった messenger を解決する可能性があります。await の *前* に messenger を取得するか、`mounted` で守ってください。これは [await の後で BuildContext を安全に使う](/ja/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) や [mounted チェックで setState を守る](/ja/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/) と同じ規律です。

**`SnackBar` が間違った画面に表示される。** クラッシュはしませんが、メッセージが期待とは違うルートに現れます。これは *messenger がない* 問題ではなく *どの messenger か* の問題です。サブツリーを包んだ入れ子の `ScaffoldMessenger` を使いたかったのに、`MaterialApp` のルート messenger を解決してしまったのです。その入れ子スコープの内側の context から解決する（解決策 2 または解決策 3）か、特定の messenger への key を保持してください。

**`showModalBottomSheet` と `openDrawer` も同じ壁にぶつかります。** 画面自身の `build` context からの `Scaffold.of(context)` 呼び出しは、`showSnackBar` に限らず同じように失敗します。`Scaffold.of(context).openDrawer()` と `showModalBottomSheet(context: context, ...)` はどちらも `Scaffold` より下の context を必要とします。`Builder` とウィジェット切り出しの解決策はそのまま適用できます。

**これはアサーションなので、release ビルドでは挙動が異なります。** `of()` の失敗は debug ではアサーションを投げ、release では例外を投げます。「テストでクラッシュしなかった」release ビルドが安全だと思い込まないでください。messenger が本当に欠けているなら、release も例外を投げます。debug で解決してください。

実際の失敗が、祖先を見つけられないと訴える別の Material ウィジェット（`No MaterialLocalizations found`、`No Directionality widget found`、`No MediaQuery widget ancestor found`）である場合、仕組みは同じ上方向探索のミスであり、解決策も同じ形です。呼び出し側に、それが必要とするウィジェットより下にある context を与えるか、欠けている祖先を追加してください。Flutter の [無効化されたウィジェットの祖先の参照は安全でない](/ja/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/) は、この構造的エラーのタイミングに基づくいとこです。

## 関連

- [Flutter で await の後に BuildContext を安全に使う方法](/ja/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) -- `SnackBar` が発火するときに有効なままであるよう、非同期ギャップの前に messenger を取得する。
- [Flutter で非同期ギャップの後に mounted チェックで setState を守る方法](/ja/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/) -- await の後の `.of()` 呼び出しを安全に保つ、同じライフサイクルの規律。
- [解決: Flutter で無効化されたウィジェットの祖先の参照は安全でない](/ja/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/) -- この構造的なものに対する、タイミングに基づく祖先探索の失敗。
- [解決: Incorrect use of ParentDataWidget. Expanded widgets must be placed inside Flex widgets](/ja/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/) -- フレームワークが build 時に捕捉する、もう 1 つの「ウィジェットツリー内の間違った場所」エラー。

## 出典

- [SnackBars managed by the ScaffoldMessenger, Flutter の破壊的変更](https://docs.flutter.dev/release/breaking-changes/scaffold-messenger) -- `Scaffold.of().showSnackBar` から `ScaffoldMessenger.of().showSnackBar` への移行、`scaffoldMessengerKey`、および正確な "No ScaffoldMessenger widget found" アサーション。
- [ScaffoldMessenger.of, Flutter API リファレンス](https://api.flutter.dev/flutter/material/ScaffoldMessenger/of.html) -- スコープに messenger がないとき `of()` が debug ではアサーション、release では例外を投げることを文書化し、`maybeOf` と `GlobalKey` パターンを指し示す。
- [ScaffoldMessenger.maybeOf, Flutter API リファレンス](https://api.flutter.dev/flutter/material/ScaffoldMessenger/maybeOf.html) -- messenger が正当に不在でありうる場合のための、null を返す探索。
- [Scaffold.of, Flutter API リファレンス](https://api.flutter.dev/flutter/material/Scaffold/of.html) -- 古典的な "context that does not contain a Scaffold" メッセージと `Builder` による対処。
