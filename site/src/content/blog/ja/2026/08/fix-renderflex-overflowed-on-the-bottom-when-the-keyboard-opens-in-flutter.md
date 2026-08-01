---
title: "修正: Flutter でキーボードを開くと A RenderFlex overflowed by N pixels on the bottom が出る"
description: "キーボードは Scaffold の body の最大高さを縮めるため、ぎりぎり収まっていた Column があふれます。resizeToAvoidBottomInset を切るのではなく、body をスクロール可能にしてください。"
pubDate: 2026-08-01
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "layout"
  - "keyboard"
lang: "ja"
translationOf: "2026/08/fix-renderflex-overflowed-on-the-bottom-when-the-keyboard-opens-in-flutter"
translatedBy: "claude"
translationDate: 2026-08-01
---

`Scaffold` の body を `SingleChildScrollView` で包んでください（あるいは `Column` を `ListView` に変えてください）。キーボードはレイアウトの上に重なるのではなく、レイアウトを縮めます。`Scaffold` は body に渡す最大高さから `MediaQuery.viewInsets.bottom` を差し引くため、画面をちょうど埋めていた `Column` がキーボードの高さのぶんだけ予算を超えます。`resizeToAvoidBottomInset: false` でも縞模様は消えますが、それはキーボードがテキストフィールドを覆うことで消えているだけで、望ましい結果になることはほとんどありません。この記事は Flutter 3.x（3.44 で検証）と Dart 3.x を対象にしています。

```text
The following assertion was thrown during layout:
A RenderFlex overflowed by 291 pixels on the bottom.

The relevant error-causing widget was:
  Column  Column:file:///Users/me/app/lib/screens/login_screen.dart:37:18

The overflowing RenderFlex has an orientation of Axis.vertical.
The edge of the RenderFlex that is overflowing has been marked in the
rendering with a yellow and black striped pattern.
```

[一般的な RenderFlex のオーバーフロー](/ja/2026/05/fix-renderflex-overflowed-in-flutter/)ではなくキーボード版だと判断できるのは、発生するタイミングです。`TextField` をタップするまでレイアウトは正常で、あふれたピクセル数はキーボードの高さ（多くの端末で 250 から 350 論理ピクセル）に不自然なほど近く、キーボードを閉じた瞬間に消えます。

## キーボードが body を覆わずに縮める理由

Android では Flutter のプロジェクトテンプレートが `MainActivity` に `android:windowSoftInputMode="adjustResize"` を指定しているため、プラットフォームは Flutter のビューをパンさせるのではなくリサイズします。エンジンは覆われた領域を `MediaQueryData.viewInsets` として Dart に伝えます。API ドキュメントの定義は明確で、モバイル端末のキーボードが表示されているとき `viewInsets.bottom` はキーボードの上端に対応します。

計算するのは `Scaffold` です。`_ScaffoldState.build` では、空けておく必要のある最小のインセットを求めます。

```dart
// packages/flutter/lib/src/material/scaffold.dart, Flutter 3.x
final EdgeInsets minInsets = MediaQuery.paddingOf(
  context,
).copyWith(bottom: _resizeToAvoidBottomInset ? MediaQuery.viewInsetsOf(context).bottom : 0.0);
```

そして `_ScaffoldLayout.performLayout` で、それを body の高さの予算に変換します。

```dart
// packages/flutter/lib/src/material/scaffold.dart, Flutter 3.x
final double contentBottom = math.max(
  0.0,
  bottom - math.max(minInsets.bottom, bottomWidgetsHeight),
);

if (hasChild(_ScaffoldSlot.body)) {
  double bodyMaxHeight = math.max(0.0, contentBottom - contentTop);
  // ...
```

`_resizeToAvoidBottomInset` は `widget.resizeToAvoidBottomInset ?? true` なので、これが既定の経路です。高さ 852 ピクセルの画面で app bar が 56 ピクセル、キーボードが 291 ピクセルなら、body の `maxHeight` は 796 から 505 に下がります。`Column` は依然として 796 を要求します。`RenderFlex` はクリップもスクロールもしないので、縞模様の警告を描いて差分を報告します。それがメッセージにある 291 ピクセルそのものです。この数値がキーボードの高さと一致するのは、以前のレイアウトが余裕ゼロでちょうど収まっていたからです。

## 1 画面に収まっていたものが収まらなくなる再現コード

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
import 'package:flutter/material.dart';

void main() => runApp(const MaterialApp(home: LoginScreen()));

class LoginScreen extends StatelessWidget {
  const LoginScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Sign in')),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            const FlutterLogo(size: 160),
            const TextField(decoration: InputDecoration(labelText: 'Email')),
            const TextField(
              obscureText: true,
              decoration: InputDecoration(labelText: 'Password'),
            ),
            FilledButton(onPressed: () {}, child: const Text('Sign in')),
          ],
        ),
      ),
    );
  }
}
```

これは問題なく描画されます。どちらかのフィールドをタップするとオーバーフローが現れます。ウィジェットツリーは何も変わっていません。変わったのは渡ってくる `maxHeight` だけです。

## 試すべき順番に並べた解決策

### 1. body をスクロール可能にする

ほぼすべてのフォームにとってこれが正しい解決策で、[Flutter の一般的なエラーのドキュメント](https://docs.flutter.dev/testing/common-errors)も下方向のオーバーフローに対してこれを勧めています。viewport は子に主軸方向の無制限のスペースを与えるので、`Column` はキーボードが `Scaffold` に何をしたかを気にしなくなります。

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
body: SingleChildScrollView(
  padding: const EdgeInsets.all(24),
  child: Column(
    children: [
      const FlutterLogo(size: 160),
      const SizedBox(height: 24),
      const TextField(decoration: InputDecoration(labelText: 'Email')),
      const SizedBox(height: 12),
      const TextField(
        obscureText: true,
        decoration: InputDecoration(labelText: 'Password'),
      ),
      const SizedBox(height: 24),
      FilledButton(onPressed: () {}, child: const Text('Sign in')),
    ],
  ),
),
```

ついでに 2 点変更してください。`mainAxisAlignment: MainAxisAlignment.spaceBetween` は外します。viewport の中では利用可能なスペースが無限なので、主軸の配置には分配するものがなく、何も起きないまま無視されます。間隔は明示的な `SizedBox` に置き換えてください。またリストが長い場合やデータから組み立てる場合は `ListView` や `ListView.builder` を使い、子を遅延生成させてください。そのトレードオフは[長いリストにおける shrinkWrap と Expanded と slivers の比較](/ja/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/)で扱っているものと同じです。

この修正にはおまけがあります。`EditableText` は最も近い `Scrollable` の祖先を通じてフォーカス中のフィールドを表示範囲までスクロールし、そのときの余白は `TextField.scrollPadding`（既定値は `EdgeInsets.all(20.0)`）で決まります。スクロール可能な祖先がなければスクロールするものがありません。オーバーフローが見えていないのに指の下のフィールドが隠れたままになるのは、これが理由です。

### 2. 余裕があれば画面を埋め、足りなければスクロールする

scroll view による修正には見た目の代償が 1 つあります。キーボードを閉じた縦長の画面では、内容が広がらずに上に固まります。[SingleChildScrollView の API ドキュメント](https://api.flutter.dev/flutter/widgets/SingleChildScrollView-class.html)にあるパターンは、`Column` に viewport と同じ最小高さを与え、内容のほうが大きいときはちょうど内容の高さになるよう強制することで、これを解決します。

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
body: LayoutBuilder(
  builder: (context, viewportConstraints) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: ConstrainedBox(
        constraints: BoxConstraints(minHeight: viewportConstraints.maxHeight - 48),
        child: IntrinsicHeight(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: const [
              FlutterLogo(size: 160),
              TextField(decoration: InputDecoration(labelText: 'Email')),
              TextField(
                obscureText: true,
                decoration: InputDecoration(labelText: 'Password'),
              ),
            ],
          ),
        ),
      ),
    );
  },
),
```

どちらのラッパーも必須です。`ConstrainedBox` がないと Column は内容に合わせて縮み、縦長の画面を埋められません。`IntrinsicHeight` がないと子がそれ以上を必要としていても最小高さを取ってしまい、またオーバーフローに戻ります。`LayoutBuilder` は body スロットの内側にあるためキーボード適用後の制約を見ます。つまり `viewportConstraints.maxHeight` からはすでにキーボード分が引かれています。

ドキュメントはコストについても率直です。この方法はサブツリーのレイアウトを 2 回行います（1 回は intrinsic 寸法のため、もう 1 回は本番のため）。ログイン画面なら問題ありませんが、50 行ある設定画面では避けるべきです。

### 3. IntrinsicHeight の代わりに SliverFillRemaining を使う

intrinsic のパスがフレーム時間に現れるようなら、同じ意図を slivers で表現してください。`SliverFillRemaining(hasScrollBody: false)` は子に viewport の残りを埋めさせますが、API の契約どおり、子の範囲が viewport を超える場合は sliver 側が上書きせず子のサイズに従います。これはキーボードが現れたときにまさに欲しい挙動です。

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
body: CustomScrollView(
  slivers: [
    SliverFillRemaining(
      hasScrollBody: false,
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: const [
            FlutterLogo(size: 160),
            TextField(decoration: InputDecoration(labelText: 'Email')),
            TextField(
              obscureText: true,
              decoration: InputDecoration(labelText: 'Password'),
            ),
          ],
        ),
      ),
    ),
  ],
),
```

ここで覚えておくべき規則が 1 つあります。`CustomScrollView.slivers` の直下に置くものはすべて sliver でなければなりません。包まずに `Column` を置くと [RenderViewport expected a RenderSliver child](/ja/2026/07/fix-renderviewport-expected-a-rendersliver-in-a-flutter-customscrollview/) が発生します。

### 4. resizeToAvoidBottomInset: false は意図がある場合だけ

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
Scaffold(
  resizeToAvoidBottomInset: false,
  body: /* ... */,
)
```

先ほどのソースをもう一度読んでください。これは `minInsets.bottom` を `0.0` にするので、body は高さを保ったままになり、キーボードはその下にあるものの上に描かれます。何も直っておらず、オーバーフロー警告が警告する対象を失っただけです。入力欄が画面上部 3 分の 1 にある画面、リサイズが不自然になる全画面の地図やカメラビュー、インセットを自前で扱うチャット画面であれば正当な選択です。フォームには誤った答えです。ユーザーが入力しているフィールドこそがキーボードの裏に回るからです。

## 堂々巡りの原因になる落とし穴

**Scaffold の body の中では `viewInsets.bottom` が `0` になります。** これがこの領域で最も紛らわしい点です。`Scaffold` は body に加工した `MediaQuery` を渡します。

```dart
// packages/flutter/lib/src/material/scaffold.dart, Flutter 3.x
if (removeBottomInset) {
  data = data.removeViewInsets(removeBottom: true);
}
```

そして body スロットは `removeBottomInset: _resizeToAvoidBottomInset` で登録されます。したがって既定設定では、`Scaffold.body` の内側で `MediaQuery.viewInsetsOf(context).bottom` を読むウィジェットは、キーボードが出ていても `0.0` を受け取ります。`Scaffold` が body を縮めることでそのインセットをすでに消費しているからです。そこに手作業で `Padding(padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom))` を足しても何も起きません。実際の値を読むには `Scaffold` より上で読むか、`resizeToAvoidBottomInset: false` にしてインセットの処理を自分で引き受けてください。

**モーダルの bottom sheet は例外です。** `showModalBottomSheet` のルートは `Scaffold` の body ではないので、そこでは `viewInsets` がそのまま残り、padding を使う手が正解になります。`isScrollControlled: true` と組み合わせてください。そうしないとシートの高さが画面の半分に制限されます。

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
showModalBottomSheet(
  context: context,
  isScrollControlled: true,
  builder: (context) => Padding(
    padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
    child: const ComposeForm(),
  ),
);
```

**bottomNavigationBar はキーボードと足し算されません。** `contentBottom` は合計ではなく `math.max(minInsets.bottom, bottomWidgetsHeight)` を使います。キーボードがナビゲーションバーより高くなると、body はキーボードの高さぶんだけ縮み、バー自体は scaffold の最下部にある自分の場所をキーボードの下で保ち続けます。入力中に消したい場合は自分で隠してください。`Scaffold` より上に置いた `Builder` から `MediaQuery.viewInsetsOf(context).bottom` を読み、`bottomNavigationBar: inset > 0 ? null : const MyNavBar()` を渡します。

**誰かが `windowSoftInputMode` を `adjustPan` に変えた場合。** Android でオーバーフローがまったく出ないのにフィールドが覆われる、あるいは `viewInsets.bottom` がいつまでも `0` のままなら、`android/app/src/main/AndroidManifest.xml` を確認してください。Flutter のテンプレートは `android:windowSoftInputMode="adjustResize"` を出荷しています。どこかで Stack Overflow の回答に説得されて `adjustPan` に変えられ、プラットフォームがインセットを報告する代わりにウィンドウをパンさせている状態です。

**ここで犯人を `Expanded` で包むのは誤った反射です。** `Expanded` は、貪欲な子が `Row` を食い尽くす水平方向のケースのための解決策です。キーボードのケースでは、すべての子がすでに自然なサイズであり、単純に合計が予算を超えているだけなので、`Expanded` はスペースを必要としていたウィジェットから奪うか、オーバーフローを兄弟に移すだけです。さらに `Flex` の外に出てしまった `Expanded` は、代わりに [Incorrect use of ParentDataWidget](/ja/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/) を発生させます。

**ドラッグでキーボードを閉じる。** body がスクロールするようになったら、scroll view に `keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag` を追加してください。1 行で済み、フォーム画面に対する最も多い不満を解消できます。

**よく似たエラー。** `Vertical viewport was given unbounded height` はちょうど鏡像で、制約のない親の中にスクロール可能なウィジェットがある場合です。[Column の中に ListView を入れる方法](/ja/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/)で扱っています。`RenderBox was not laid out` は通常、本当のレイアウト失敗の後に出る 2 番目の例外です。最初の例外までログをさかのぼってください。またオーバーフローがキーボードではなくテキストスケール 1.5 倍で出るなら、同じ形のバグで引き金が違うだけです。それは[一般的な RenderFlex オーバーフローの記事](/ja/2026/05/fix-renderflex-overflowed-in-flutter/)で詳しく扱っています。

## 関連記事

- [修正: Flutter の A RenderFlex overflowed by N pixels](/ja/2026/05/fix-renderflex-overflowed-in-flutter/) は、同じアサーションの水平方向版とテキストスケール版を扱う親記事です。
- [unbounded height エラーを出さずに Column の中に ListView を入れる方法](/ja/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/) は、フォーム自体がリストを含む場合を扱います。
- [Flutter の長いリストにおける shrinkWrap と Expanded と slivers](/ja/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/) は、内容が増えたときに `ListView.builder` が `SingleChildScrollView` に勝つ理由を説明します。
- [修正: RenderViewport expected a RenderSliver child](/ja/2026/07/fix-renderviewport-expected-a-rendersliver-in-a-flutter-customscrollview/) は、slivers の道を選んだときに待ち構えているエラーです。
- [修正: Incorrect use of ParentDataWidget、Expanded は Flex の中に置く](/ja/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/) は、`Expanded` に早まって手を出したときの失敗パターンを扱います。

## 参考資料

- [Common Flutter errors](https://docs.flutter.dev/testing/common-errors) は、RenderFlex オーバーフローのアサーションと定石の解決策を定義する公式ページです。
- [Scaffold.resizeToAvoidBottomInset](https://api.flutter.dev/flutter/material/Scaffold/resizeToAvoidBottomInset.html) は、既定値 `true` と `MediaQueryData.viewInsets` への依存を記載しています。
- [MediaQueryData.viewInsets](https://api.flutter.dev/flutter/widgets/MediaQueryData/viewInsets.html) は、「viewInsets.bottom はキーボードの上端に対応する」という定義と、`padding` および `viewPadding` との違いの出典です。
- [stable ブランチの scaffold.dart](https://github.com/flutter/flutter/blob/stable/packages/flutter/lib/src/material/scaffold.dart) には、`minInsets`、`contentBottom`、body に対する `removeViewInsets` の呼び出しがあります。
- [SingleChildScrollView クラスリファレンス](https://api.flutter.dev/flutter/widgets/SingleChildScrollView-class.html) は、`LayoutBuilder` と `ConstrainedBox` と `IntrinsicHeight` を組み合わせるレシピとそのコストを記載しています。
- [SliverFillRemaining クラスリファレンス](https://api.flutter.dev/flutter/widgets/SliverFillRemaining-class.html) は、`hasScrollBody: false` の正確な意味を示します。
- [EditableText.scrollPadding](https://api.flutter.dev/flutter/widgets/EditableText/scrollPadding.html) は、表示範囲への自動スクロールの挙動と既定値 `EdgeInsets.all(20.0)` を説明しています。
