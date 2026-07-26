---
title: "Flutter で 2 つの画面間に Hero アニメーションを追加する方法"
description: "両方のルートで同じウィジェットを同一の tag を持つ Hero でラップすると、Flutter がナビゲーション中にその位置とサイズをアニメーションします。完全ガイド：画像、flightShuttleBuilder、createRectTween、RectTween の弧、ジェスチャー遷移、そしてすべてを壊す tag の衝突。Flutter 3.44、Dart 3.12 で検証。"
pubDate: 2026-07-14
tags:
  - "flutter"
  - "dart"
  - "animation"
  - "navigation"
  - "how-to"
lang: "ja"
translationOf: "2026/07/how-to-add-a-hero-animation-between-two-screens-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-14
---

短い答え：最初の画面でアニメーションさせたいウィジェットを `Hero` でラップし、遷移先のウィジェットを**同じ `tag`** を持つ 2 つ目の `Hero` でラップして、通常の `Navigator` で遷移先ルートをプッシュします。Flutter の `HeroController`（`MaterialApp` と `CupertinoApp` にデフォルトでインストールされます）が、ルート遷移中に一致する tag を持つ 2 つの hero を見つけ、元の hero を overlay に持ち上げ、遷移先に着地するまでその位置とサイズを補間します。基本的なケースでは `AnimationController` も `Tween` も明示的な duration も書きません。[Flutter 3.44](/ja/2026/07/flutter-3-44-read-the-screen-corner-radius-from-mediaquery/)、Dart 3.12 で検証済みです。

これがトリックのすべてであり、本当に 2 つの `Hero` ウィジェットと 1 つの `Navigator.push` です。このガイドの残りは、人がつまずく部分です。tag のルール、画面間で形が変わる画像や `Icon` のアニメーション、テーマ間でちらつかないように飛行ウィジェットをカスタマイズすること、飛行の軌道を曲げること、そして滑らかな遷移を耳障りなジャンプに変える一握りのエラーです。

## 最小限の動作する例

2 つの画面です。最初の画面には色付きのボックス、2 つ目の画面には同じボックスがより大きく表示されます。ボックスは両者の間を飛びます。

```dart
// Flutter 3.44, Dart 3.12
import 'package:flutter/material.dart';

void main() => runApp(const MyApp());

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(home: FirstScreen());
  }
}

class FirstScreen extends StatelessWidget {
  const FirstScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('First')),
      body: Center(
        child: GestureDetector(
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute(builder: (_) => const SecondScreen()),
          ),
          child: Hero(
            tag: 'box-hero',
            child: Container(width: 80, height: 80, color: Colors.indigo),
          ),
        ),
      ),
    );
  }
}

class SecondScreen extends StatelessWidget {
  const SecondScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Second')),
      body: Center(
        child: Hero(
          tag: 'box-hero',
          child: Container(width: 240, height: 240, color: Colors.indigo),
        ),
      ),
    );
  }
}
```

小さなボックスをタップすると、それが大きくなり 2 つ目の画面の中央へスライドします。戻るをタップすると、逆再生されます。`tag` の文字列 `'box-hero'` が 2 つのウィジェット間の結び付きのすべてです。tag が 1 文字でも異なれば、何もアニメーションせず、両方のボックスは単に通常どおり現れて消えるだけです。

## 一致する tag がメカニズムのすべてである理由

`Hero` は相手への参照を保持しません。代わりに、ルート遷移が始まる瞬間に、`HeroController` が出ていくルートと入ってくるルートのウィジェットツリーを走査し、tag から hero へのマップを構築します。**両方の**ルートに存在するすべての tag について、「飛行」を開始します。元の hero は通常の位置から取り除かれ（`placeholderBuilder` が隙間を埋めます。デフォルトでは空です）、コピーが `Navigator` の overlay `Stack` に配置され、そのコピーがルート自身の遷移アニメーションを時計として、元の `Rect` から遷移先の `Rect` へアニメーションされます。

この設計から 2 つの帰結が生じ、その両方が Hero のバグの大半の原因です。

1. **tag は 1 つのルート内で一意でなければなりません。** 1 つの画面に `tag: 'box-hero'` を持つ 2 つの `Hero` ウィジェットがあると、Flutter はどちらを飛ばすか決められず、`There are multiple heroes that share the same tag within a subtree` をスローします。これは `ListView` の項目の中に `Hero` を置き、各項目に同じリテラルの tag を与えたときに最も強く噛みつきます。項目の id を使ってください：`tag: 'photo-${photo.id}'`。
2. **hero は遷移先ルートの最初のフレームに存在しなければなりません。** controller は遷移先ルートが構築される最中にそれを検査します。遷移先の hero がまだ解決していない `FutureBuilder` の背後にある、`Offstage` の中にある、または最初のビルドで false になる `if` でゲートされている場合、飛んでいく先の `Rect` が存在せず、アニメーションは静かにスキップされます。

## 形が変わる画像やアイコンをアニメーションする

最も一般的な実際の用途は、フルスクリーンのヘッダーへと拡大するサムネイルです。child は両方のルートで同一である必要はなく、同一の tag が付いていればよいだけです。ここでは元は 80x80 の角丸サムネイル、遷移先は全幅の画像です。

```dart
// Flutter 3.44, Dart 3.12
// Source: a grid thumbnail
Hero(
  tag: 'photo-${photo.id}',
  child: ClipRRect(
    borderRadius: BorderRadius.circular(12),
    child: Image.network(photo.url, width: 80, height: 80, fit: BoxFit.cover),
  ),
);

// Destination: a full-width header
Hero(
  tag: 'photo-${photo.id}',
  child: Image.network(
    photo.url,
    width: double.infinity,
    height: 300,
    fit: BoxFit.cover,
  ),
);
```

child が `Image` のときに注意すべきことが 2 つあります。第一に、両方のルートで同じ画像 `url`（理想的にはメモリ上の同じ `ImageProvider`）を使い、ネットワーク取得が既にキャッシュされていて飛行が半分だけ読み込まれたフレームを見せないようにします。第二に、片側だけで `BoxFit` が食い違ったり `ClipRRect` があると、飛行の最後に角の半径や切り抜きが急に確定して、目に見えるポップが生じます。角丸が重要なら、両側を同じ `ClipRRect` でラップするか、（後述の）`flightShuttleBuilder` を使って半径を補間してください。

`Icon` やスタイル付きの `Text` にも同じルールが当てはまります。framework は境界の `Rect` を補間し、飛行中はその rect に収まるように元の child の描画をスケールします。24px のアイコンが 96px のアイコンへ飛ぶのが正しく見えるのは、child がスケールされ、飛行の途中でレイアウトし直されないからです。

## flightShuttleBuilder で飛行ウィジェットをカスタマイズする

デフォルトでは、飛行は遷移先 hero の child をスケールして表示します。このデフォルトは 2 つの状況で壊れます。child が 2 つのルート間で異なる `InheritedWidget`（`Theme`、`DefaultTextStyle`、`MediaQuery`）を読む場合と、飛行中にウィジェットを単にスケールするのではなく目に見えて変形させたい場合です。`flightShuttleBuilder` は、hero が空中にある間に何を描画するかを完全に制御できます。

```dart
// Flutter 3.44, Dart 3.12
Hero(
  tag: 'photo-${photo.id}',
  flightShuttleBuilder: (
    flightContext,
    animation,
    flightDirection,
    fromHeroContext,
    toHeroContext,
  ) {
    // Render the destination hero's widget, but wrapped in the
    // destination route's Material so text/icon theming is stable.
    return DefaultTextStyle(
      style: DefaultTextStyle.of(toHeroContext).style,
      child: toHeroContext.widget as Hero,
    );
  },
  child: Text(photo.title, style: Theme.of(context).textTheme.titleLarge),
);
```

`flightDirection` 引数は `HeroFlightDirection.push` または `HeroFlightDirection.pop` なので、行きと帰りで異なる shuttle を描画できます。`animation` は飛行の 0 から 1 までの `Animation<double>` です。角がジャンプするのではなく滑らかに丸くなってほしい場合は、これを使ってクロスフェードしたり `BorderRadius` を補間したりします。これが「角丸が最後にポップする」問題の正しい修正方法です。shuttle の中で `animation.value` から半径を駆動してください。

## createRectTween で飛行の軌道を曲げる

デフォルトでは、hero は 2 つの rect の間を直線で移動し、そのサイズは線形に補間されます。Material 自身の詳細遷移はしばしば**弧**を使います。ウィジェットは曲線の軌道をたどり、これはカードがページへ拡大するときにより自然に読み取れます。Flutter はまさにこのために `MaterialRectArcTween` を同梱しており、`createRectTween` で hero ごとにオプトインします。

```dart
// Flutter 3.44, Dart 3.12
Hero(
  tag: 'box-hero',
  createRectTween: (begin, end) {
    return MaterialRectArcTween(begin: begin, end: end);
  },
  child: const SizedBox(width: 80, height: 80),
);
```

`createRectTween` は飛行の遷移先である hero で実行されます。push と pop の両方で弧が欲しい場合は、両方のルートの hero に設定します。デフォルトは素の `RectTween`（線形）です。`MaterialRectArcTween` は左上と右下の角を弧に沿って曲げるので、拡大するカードは対角線に射出されるのではなく、所定の位置へ「スイープする」ように見えます。[Flutter 3.44](/ja/2026/07/flutter-3-44-read-the-screen-corner-radius-from-mediaquery/) 以降、ルート経由で遷移にカーブを直接渡すこともできますが、`createRectTween` はタイミングではなく幾何学的な軌道を形作る方法であり続けます。

## iOS の戻るスワイプで hero をアニメーションさせる

`CupertinoPageRoute`（または iOS 上の `MaterialPageRoute`）では、ユーザーは左端からドラッグしてルートを pop できます。デフォルトでは、その対話的なドラッグ中に hero は飛び**ません**。確定した pop のときだけ飛びます。共有要素がドラッグを追従するよう、両方の hero で `transitionOnUserGestures: true` を設定します。

```dart
// Flutter 3.44, Dart 3.12
Hero(
  tag: 'box-hero',
  transitionOnUserGestures: true,
  child: Container(width: 80, height: 80, color: Colors.indigo),
);
```

これは元の hero と遷移先の hero の両方に設定します。片方だけに設定すると、push はアニメーションしますが対話的な pop はしないため、一貫性がないと感じられます。これは追加のコストが低く、本物の共有要素のペアでこれをオフのままにする理由はまずありません。

## go_router やその他のルーターでの Hero アニメーション

`Hero` は命令的な `Navigator.push` に縛られていません。アニメーションはルート遷移によって駆動されるため、遷移先ページが遷移可能なページ（`MaterialPage`、`CupertinoPage`、または `CustomTransitionPage`）を使う限り、`go_router`、`auto_route`、あるいは `Navigator` 2.0 の上に構築されたどのルーターでも同じように動作します。2 つのウィジェットに同じ tag を与え、アプリが通常どおりナビゲートするだけです。

```dart
// Flutter 3.44, Dart 3.12, go_router 14.x
GoRoute(
  path: '/photo/:id',
  builder: (context, state) => PhotoDetailScreen(id: state.pathParameters['id']!),
);

// Trigger it from the grid:
onTap: () => context.go('/photo/${photo.id}'),
```

宣言的ルーターでの 1 つの注意点：継続時間ゼロの `CustomTransitionPage` や `NoTransitionPage` を使うと、`HeroController` が駆動する遷移アニメーションが存在しないため、hero は飛びません。共有要素のアニメーションが欲しいルートには、（短いフェードであっても）本物の遷移を残してください。ルーター自体のより深い比較については、[go_router によるネストされたルートとディープリンク](/ja/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/)のノートと、[go_router vs auto_route vs Navigator 2.0](/ja/2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter/) の内訳を参照してください。

## Hero アニメーションを壊すエラー

これらはバグレポートに現れる失敗で、それらが引き寄せる検索トラフィックの多さで並べています。

1. **`There are multiple heroes that share the same tag within a subtree`。** 同じルート上の 2 つの hero が 1 つの tag を共有しています。ほぼ常に、各項目が定数の tag を使ったリストです。修正：`'item-${item.id}'` のような一意なキーから tag を導出します。同じ見た目を画面に本当に 2 回出す必要がある場合、飛行に参加できるのはそのうち 1 つだけです。残りには別々の tag を与えるか、`Hero` をまったく付けません。
2. **hero が飛ばずにただ現れる。** 遷移先の hero が最初のフレームに存在しません。解決していない `FutureBuilder` の背後、`Offstage` の中、または最初のビルドで false になるフラグでゲートされています。データが後で読み込まれるとしても、飛んでいく先の rect があるように、tag の付いたウィジェットがツリーに直ちに存在することを確認してください。関連する落とし穴は、その `Future` を `build` の中で初期化してリビルドのたびに作り直すことです。[FutureBuilder が Future を作り直さないように Future を初期化する](/ja/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/)を参照してください。
3. **飛行の最後で child がジャンプまたはちらつく。** 2 つのルート間で `BoxFit`、`ClipRRect` の半径、または `InheritedWidget` に依存するスタイルが食い違っています。安定したウィジェットを描画し、食い違うプロパティを `animation.value` から補間する `flightShuttleBuilder` で修正します。
4. **`Navigator.pop` が例外をスローする、または戻る矢印が何もしない。** これは Hero の問題ではありませんが、hero のある画面で起きるため、そのように見えます。ルートが `HeroController` を所有する `Navigator` でプッシュされたことを確認してください。カスタムのネストされた `Navigator` には `observers` に独自の `HeroController` が必要で、そうでないと hero はそれらの間を飛びません。
5. **hero が非有界のサイズを持つためレイアウトがジャンプする。** `Column` の中で `Text` や `Row` をラップする `Hero` は、overlay `Stack` に持ち上げられる飛行中に非有界の幅の状況に陥ることがあります。hero の child を `type: MaterialType.transparency` の `Material` でラップするか、明示的な制約を与えます。より一般的に非有界の高さのエラーに遭遇している場合、そのパターンは[Column の中に ListView をネストする](/ja/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/)で扱われているのと同じ系統のレイアウトバグです。

## テキストは飛行中に Material の祖先を必要とする

独立したノートに値する微妙な点です。hero が飛行中の間、それは `Navigator` の overlay に住み、`Scaffold` とその `Material` から切り離されています。`Text` と `Ink` ベースのウィジェットは、デフォルトのテキストスタイルと ink のスプラッシュのために `Material` の祖先を探します。飛行中はそれが見つからないことがあり、スタイル付きのテキストが 1 フレームだけデフォルトのデバッグスタイル（黒い下線）で描画されることがあります。飛行の child を `Material` でラップしてください。

```dart
// Flutter 3.44, Dart 3.12
Hero(
  tag: 'title-hero',
  flightShuttleBuilder: (ctx, anim, dir, fromCtx, toCtx) {
    return Material(
      type: MaterialType.transparency,
      child: toCtx.widget,
    );
  },
  child: Material(
    type: MaterialType.transparency,
    child: Text('Details', style: Theme.of(context).textTheme.headlineSmall),
  ),
);
```

`MaterialType.transparency` は背景を描かずにテキストにスタイルを解決するための `Material` の祖先を与え、飛行を視覚的にきれいに保ちます。

## Hero を使うべきでないとき

`Hero` は、*同じ概念上の要素*が両方の画面に存在するときの正しいツールです。ヘッダーになるサムネイル、プロフィール写真になるアバター、詳細ページになるカードです。何も共有されない装飾的な動きには誤ったツールです。ページ全体をスライド、フェード、スケールさせたい場合、それはルートの `transitionsBuilder`（または `PageRouteBuilder`）であり、`Hero` ではありません。ウィジェットを 1 つの画面の*中で*アニメーションさせたい場合は、`AnimatedContainer`、`AnimatedPositioned`、または明示的な `AnimationController` に手を伸ばします。Hero はルートをまたぐ共有要素のケースを特に受け持っており、それ以外の用途に使うのは framework と戦うことになります。

遷移の追加と一緒に現れがちな、より広範な Flutter のパフォーマンスと UI の作業については、[DevTools でジャンクをプロファイルする](/ja/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/)ガイドと、[Material 3 ColorScheme でアクセントカラーを設定する](/ja/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/)ガイドが、ナビゲーションの感触が良くなった直後に人がよく磨く 2 つのこと、つまりフレーム予算とテーマ設定をカバーしています。

## 出典

- Flutter API: [`Hero` クラス](https://api.flutter.dev/flutter/widgets/Hero-class.html)
- Flutter ドキュメント: [Hero animations](https://docs.flutter.dev/ui/animations/hero-animations)
- Flutter クックブック: [Animate a widget across screens](https://docs.flutter.dev/cookbook/navigation/hero-animations)
- Flutter API: [`MaterialRectArcTween`](https://api.flutter.dev/flutter/material/MaterialRectArcTween-class.html)
- Flutter API: [`HeroController`](https://api.flutter.dev/flutter/widgets/HeroController-class.html)
