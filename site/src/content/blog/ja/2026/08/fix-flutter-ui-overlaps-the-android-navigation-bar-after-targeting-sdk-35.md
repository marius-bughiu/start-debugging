---
title: "修正: SDK 35 をターゲットにすると Flutter の UI が Android のシステムナビゲーションバーと重なる"
description: "Android SDK 35 をターゲットにすると Flutter アプリは edge-to-edge モードになり、Scaffold の body がナビゲーションバーの背後に描画されます。オプトアウトするのではなく SafeArea と MediaQuery の padding でインセットを処理してください。そのオプトアウトは Android 16 ではすでに無効です。"
pubDate: 2026-08-21
template: how-to
tags:
  - "flutter"
  - "dart"
  - "android"
  - "layout"
lang: "ja"
translationOf: "2026/08/fix-flutter-ui-overlaps-the-android-navigation-bar-after-targeting-sdk-35"
translatedBy: "claude"
translationDate: 2026-08-21
---

前回のリリースではボタンが動いていました。ところが今は `Scaffold` の最下段が Android のナビゲーションバーの下に潜り込み、半分だけ見えて半分だけタップできる状態になっています。レイアウトのコードは何も変えていません。変わったのはターゲット SDK です。Flutter アプリが Android SDK 35 (API 35、Android 15) をターゲットにした時点で、Android はそのアプリを edge-to-edge で実行し、アプリのウィンドウはシステムバーが占める帯を含めたディスプレイの全高に広がります。修正すべきはその帯を取り戻すことではなく、Android が報告するインセットを読み取って自分のコンテンツをその分だけずらすことです。下端に固定したコンテンツは `SafeArea` で包み、スクロール可能なウィジェットには `MediaQuery.paddingOf(context).bottom` を padding として与えて、リストがバーの下までスクロールしつつ手前で止まるようにします。`android:windowOptOutEdgeToEdgeEnforcement` に手を伸ばしてはいけません。Flutter のデフォルトの `targetSdkVersion` は現在の安定版よりかなり前から 36 であり、API 36 ではそのオプトアウトは非推奨かつ無効化されています。

以下の内容はすべて Flutter 3.44.2 (Dart 3.12.2) で検証し、SDK のデフォルト値については現在の安定版である Flutter 3.47.1 (2026-08-19 リリース、Dart 3.13.1) とも突き合わせています。

## なぜアプリの下端から 48 論理ピクセルが消えたのか

Android 15 より前は、明示的に edge-to-edge にしていないアプリはシステムバーが始まる位置で終わるウィンドウを受け取っていました。ナビゲーションバーは不透明でシステムのものであり、`Scaffold` はそのピクセルを一度も見ることがありませんでした。OS が代わりにインセットを処理してくれていたので、レイアウトは簡単でした。

Android 15 はこのデフォルトを反転させました。Android の edge-to-edge のガイドには次のように書かれています。"Edge-to-edge is enforced on Android 15 (API level 35) and higher once your app targets SDK 35." 今やウィンドウはディスプレイ全体に広がります。ステータスバーは透明になり、ジェスチャーナビゲーションバーも透明になり、3 ボタンのナビゲーションバーは半透明になります。Android はウィンドウインセットを通じてそれらのバーが覆う領域の大きさを正確に伝え続けますが、その分を代わりに差し引いてはくれません。

Flutter はデフォルトのターゲットが動いた瞬間にこれを引き継ぎました。フレームワーク自身の移行ノートは、その順序をはっきり述べています。"Prior to Flutter 3.27, Flutter apps targeted Android 14 by default and didn't opt into edge-to-edge mode automatically." Flutter 3.27 以降、`flutter.targetSdkVersion` を使うアプリは Android 15 をターゲットにし、自動的に edge-to-edge に組み込まれます。この変更は `3.26.0-0.0.pre` で入り、3.27 で安定版になりました。

そのデフォルトはその後さらに動いており、この点こそ、このエラーに関するほとんどの記事が古くなっている部分です。Flutter 3.44.2 に同梱される Gradle プラグイン、そして 3.47.1 のタグでも同一の内容で、デフォルト値は次のとおりです。

```kotlin
// packages/flutter_tools/gradle/src/main/kotlin/FlutterExtension.kt
// Identical in Flutter 3.44.2 and 3.47.1
val compileSdkVersion: Int = 36
val minSdkVersion: Int = 24
val targetSdkVersion: Int = 36
```

つまり今日 `flutter create` で作ったアプリは、edge-to-edge がデフォルトである SDK をターゲットにしているだけではありません。edge-to-edge が唯一の選択肢である SDK をターゲットにしています。

## 重なりを数値で見るとどうなるか

これはスクリーンショットではなく実測で押さえておく価値があります。「自分の Pixel では表示が崩れる」というのはデバッグ可能な主張ではないからです。widget テストなら端末を正確にモデル化できます。view の `viewPadding` に 24dp のステータスバーと 48dp の 3 ボタンナビゲーションバーを設定し、`devicePixelRatio` を 1 にして論理ピクセルと物理ピクセルを一致させ、高さ 800dp のウィンドウ内でウィジェットがどこに配置されるかを測ります。

```dart
// Flutter 3.44.2 / Dart 3.12.2
void setNavBarView(WidgetTester tester) {
  tester.view.devicePixelRatio = 1.0;
  tester.view.physicalSize = const Size(400, 800);
  tester.view.viewInsets = FakeViewPadding.zero;
  tester.view.viewPadding = const FakeViewPadding(top: 24, bottom: 48);
  tester.view.padding = const FakeViewPadding(top: 24, bottom: 48);
  addTearDown(tester.view.reset);
}

testWidgets('bare Scaffold body is not inset from the nav bar', (t) async {
  setNavBarView(t);
  await t.pumpWidget(MaterialApp(
    home: Scaffold(
      body: Align(
        alignment: Alignment.bottomCenter,
        child: SizedBox(key: const Key('marker'), height: 10, width: 10),
      ),
    ),
  ));
  print('BODY_BOTTOM=${t.getRect(find.byKey(const Key('marker'))).bottom}');
});
```

これは `BODY_BOTTOM=800.0` を出力します。マーカーの下端はディスプレイの最下部である 800 にあり、つまり下側 48 論理ピクセルがナビゲーションバーの下に隠れています。`Scaffold.body` はウィンドウ全体を受け取り、子を守るための処理は何もしません。バグの正体はこれだけであり、設計どおりの動作です。

## 4 ステップでの修正

1. edge-to-edge は有効なままにし、無効化するスイッチを探すのをやめてください。API 36 ではサポートされた無効化手段は存在しないため、オプトアウトに費やす時間は、後で取り除くものを作る時間になります。

    ```dart
    // Flutter 3.44.2: nothing to add. edgeToEdge is already the default.
    ```

2. 上端および下端に固定するコンテンツは `SafeArea` で包んでください。バーの下に絶対に入ってはいけないコンテンツ、つまり下部のボタン列、独自のツールバー、フローティングパネル、`Align` や `Positioned` で配置したものには、これが正しい道具です。

    ```dart
    // Flutter 3.44.2
    Scaffold(
      body: SafeArea(
        child: Align(
          alignment: Alignment.bottomCenter,
          child: ElevatedButton(onPressed: _submit, child: const Text('Save')),
        ),
      ),
    )
    ```

3. スクロール可能なウィジェットは包むのではなく padding を与えてください。`SafeArea` の内側の `ListView` はナビゲーションバーの手前で終わるビューポートを受け取るため、コンテンツが硬い境界で切られ、半透明のバーの下には空の背景が見えてしまいます。代わりにインセットをリストの padding として渡せば、ビューポートは全面のままで、コンテンツはバーの下までスクロールしつつ、それでもその手前で止まります。

    ```dart
    // Flutter 3.44.2
    ListView(
      padding: EdgeInsets.only(bottom: MediaQuery.paddingOf(context).bottom),
      children: rows,
    )
    ```

4. 目視ではなく widget テストで検証し、上の `setNavBarView` ヘルパーを再利用してください。端末ごとに異なるバーの高さは、手元にない端末で静かにデグレする典型例です。

ステップ 3 の違いは実測できます。`SafeArea` の内側に `ListView` を置くと、スクロール可能領域のビューポート下端は 752.0 になり、ビューポート自体がウィンドウより 48 短くなります。padding を使う方法ではビューポート下端は 800.0 (全面で、コンテンツが半透明のバーの下を実際にスクロールします) となり、最終行の下端は 752.0 に収まって、ちょうど 48 論理ピクセルの余白が確保されます。コンテンツの余白は同じで、スクロールの挙動は正しくなります。

## Material 自身の下部ウィジェットはすでに対応済みですが、自作のものは違います

ここで最もよくある 1 時間の浪費は、Material がすでに追加した padding をもう一度足してしまい、なぜ隙間が倍に見えるのかと悩むことです。`Scaffold` は確かに一部のスロットにインセットを適用しますが、それを要求するウィジェットに対してだけです。同じ 48dp のナビゲーションバーを想定して各スロットを測ると、次のようになります。

| ウィジェット | 描画された高さ | 上端 | 結果 |
| --- | --- | --- | --- |
| `bottomNavigationBar` としての `SizedBox(height: 56)` | 56.0 | 744.0 | 重なり、余白ゼロ |
| `NavigationBar` (デスティネーション 2 個) | 128.0 | 672.0 | アイコンはバーから 86.0 離れる |
| `BottomAppBar` | 128.0 | 672.0 | 48dp のインセットを吸収 |
| `FloatingActionButton` | デフォルト | | 下端 736.0、余白 64.0 |
| `AppBar` | 80.0 | 0.0 | タイトル上端 38.0 |

最初の 2 行は合わせて読んでください。ここに要点のすべてがあります。高さ 56 の素の `SizedBox` を `bottomNavigationBar` スロットに置くと、ちょうど高さ 56 で描画されて y=800 まで届くため、下側 48 ピクセルがバーの下に入ります。公称高さ 80 の本物の `NavigationBar` は 128 で描画されます。これは 80 に、自ら吸収した 48dp のインセットを足した値です。`BottomAppBar` も同じ挙動です。`FloatingActionButton` は 736 で終わり、余白は 64 になります。48dp のインセットに Scaffold の通常のマージン 16dp を足した値です。`AppBar` は高さ 80 で描画され、これは 56dp のツールバーに 24dp のステータスバーを足したもので、画面上端についてはこの一連の変更よりずっと前から処理されていました。

そこから導かれるルールはこうです。Material の下部ウィジェットはインセットの分だけ大きくなりますが、同じスロットに置いた自作ウィジェットはそうなりません。独自の下部バーを作ったなら、その padding は自分の責任です。すでに `NavigationBar` を使っているのにそれを `SafeArea` で包むと、96dp の死んだ余白と、壊れて見えるバーが手に入ります。

## SafeArea が不安定に見える原因、キーボードの罠

「SafeArea は効くけれど、ときどきしか効かない」というバグ報告を生むのがこの部分です。不安定なわけではありません。`MediaQueryData.padding` がドキュメントどおりに振る舞っているだけです。

Android は関連する 2 つの値を報告します。`viewPadding` はシステムバーが占める生のインセットです。`padding` は同じインセットから `viewInsets` (キーボード) をすでに引き、0 で下限を切ったものです。ソフトウェアキーボードが開くとナビゲーションバーを覆うため、レイアウト上意味を持っていた下側のインセットは消えます。高さ 300dp のキーボードを開いた状態で測ると、次のようになります。

```text
KEYBOARD_UP padding.bottom=0.0 viewPadding.bottom=48.0
```

`SafeArea` はデフォルトで `padding` を読むため、キーボードが現れた瞬間に下側インセットが 0 に潰れ、下端に固定していたものが 48 論理ピクセル分だけ下がります。バーが実際に覆われているのですから、それが正しい場合もあります。正しくない場合のために `SafeArea` にはフラグがあり、フレームワークの実装は 2 行の差し替えです。

```dart
// packages/flutter/lib/src/widgets/safe_area.dart, Flutter 3.44.2
EdgeInsets padding = MediaQuery.paddingOf(context);
// Bottom padding has been consumed - i.e. by the keyboard
if (maintainBottomViewPadding) {
  padding = padding.copyWith(bottom: MediaQuery.viewPaddingOf(context).bottom);
}
```

`maintainBottomViewPadding: true` を設定すると隙間が一定に保たれます。キーボードを開いた状態で並べて測ると、素の `SafeArea` は下側の隙間が 0.0、フラグを付けたものは 48.0 になります。下部のコントロールがキーボードと連動してアニメーションし、目に見えて跳ねてほしくないときに使ってください。これは [キーボードが開いたときに RenderFlex が下方向にオーバーフローする問題](/ja/2026/08/fix-renderflex-overflowed-on-the-bottom-when-the-keyboard-opens-in-flutter/) と同じ系統の問題で、あちらではキーボードが padding ではなく制約を変えています。

## SafeArea をネストしても padding は二重になりません

幻の隙間を探し始める前に知っておく価値があります。`SafeArea` は、自分が吸収した padding を、サブツリーに渡す `MediaQuery` から取り除きます。`SafeArea` の中の `SafeArea` が生む下側の隙間は 96.0 ではなく 48.0 です。内側は padding が 0 に見えるので何も追加しません。

これはコンポジションにとっては良い知らせです。共通のページ用 scaffold に `SafeArea` を置き、各画面がそれぞれ自分の `SafeArea` を足しても、ツリー全体を点検する必要はありません。デバッグにとっては悪い知らせです。隙間の誤りが二重ネストによって起きることは決してないため、隙間がおかしいなら原因は別の場所、たいていは上で述べた `Scaffold` スロット内の自作ウィジェットにあります。

## オプトアウトは存在し、期限切れになり、クラッシュを招くこともあります

この症状に関するほとんどの検索で最上位に出てくるので、念のため触れておきます。Flutter は SDK 35 をターゲットにするアプリ向けのオプトアウトを文書化しています。`android/app/src/main/res/values/styles.xml` の `LaunchTheme` と `NormalTheme` の両方、そして対応する `values-night/styles.xml` に `android:windowOptOutEdgeToEdgeEnforcement` を追加する方法です。

```xml
<!-- android/app/src/main/res/values/styles.xml -->
<style name="NormalTheme" parent="@android:style/Theme.Light.NoTitleBar">
    <item name="android:windowOptOutEdgeToEdgeEnforcement">true</item>
</style>
```

これを土台にすべきでない理由が 3 つあります。1 つ目、Android 16 がこれを廃止しました。動作変更のページには、API 36 をターゲットにするアプリでは `R.attr#windowOptOutEdgeToEdgeEnforcement` が "is deprecated and disabled, and your app can't opt-out of going edge-to-edge." と記されています。2 つ目、Flutter はすでにデフォルトで `targetSdkVersion = 36` にしているため、この属性に意味を持たせるにはターゲットを自分から下げる必要があります。3 つ目、Flutter 自身の移行ノートが、Android 16 以降でオプトアウトを使うと "might cause your app to crash," と警告しており、推奨される緩和策は、この属性を含まないスタイルを置いたバージョン固有のリソースディレクトリ `your_app/android/app/src/main/res/values-35` を作ることです。現行端末ではすでに失われている挙動と引き換えにするには、なかなかの量のリソース配線です。

同じ理屈が `SystemChrome.setEnabledSystemUIMode` にも当てはまります。API 36 では他のモードは単に尊重されず、フレームワークも `SystemUiMode` の API ドキュメントでそう述べています。アプリが SDK 36 以降をターゲットにする場合、Android では既定で `edgeToEdge` が使われ、"There is no way to opt out." とあります。そのターゲットでは `leanBack`、`immersive`、`immersiveSticky` は Android システムに無視されます。

## システムバーの色は今や無視され、コントラストは自動です

もう 1 つ挙げておく価値のある犠牲があります。症状が異なるからです。クラッシュはせず、単に指定した色が反映されません。edge-to-edge では `SystemUiOverlayStyle.statusBarColor` と `SystemUiOverlayStyle.systemNavigationBarColor` は機能しません。API 35 ではオプトアウトすれば戻りますが、API 36 では恒久的に失われます。

依然として機能するのはアイコンの明度です。`statusBarIconBrightness` と `systemNavigationBarIconBrightness` はシステム自身のグリフを明るく描画するか暗く描画するかを制御します。バーの背後のコンテンツの明暗が変わるときに本当に必要なのはこちらです。

```dart
// Flutter 3.44.2
AppBar(
  systemOverlayStyle: SystemUiOverlayStyle(
    statusBarIconBrightness:
        MediaQuery.platformBrightnessOf(context) == Brightness.dark
            ? Brightness.light
            : Brightness.dark,
  ),
)
```

`SystemChrome.setSystemUIOverlayStyle` を直接呼ぶよりも、`AppBar.systemOverlayStyle` を設定するか、app bar がない場合は `AnnotatedRegion<SystemUiOverlayStyle>` を使うほうが望ましいです。アノテーション付き領域はフレームごとに、ステータスバーとナビゲーションバーの下に実際にあるものに対してヒットテストされるため、ユーザーがスクロールしても画面遷移しても正しさが保たれます。`AppBar` はこれを自動的に作るので、`AppBar` をさらに別の `AnnotatedRegion` で包まないでください。

最後に、API 29 以降の Android は、任意のコンテンツの上でも 3 つのボタンが読み取れるように、透明なナビゲーションバーの背後に半透明のスクリムを描画します。デザイン側ですでにコントラストを保証していて、スクリムがそれを濁らせているなら、`systemNavigationBarContrastEnforced: false` (上部については `systemStatusBarContrastEnforced`) で無効にできます。API 28 以下の端末ではそもそも適用されていませんでした。

修理ではなく意図的に全面表示のデザインを作っているなら、次に必要になるのはディスプレイの物理的な曲率です。Flutter は現在それを [MediaQuery から物理的な角の半径として読み取れる](/ja/2026/07/flutter-3-44-read-the-screen-corner-radius-from-mediaquery/) ので、当てずっぽうの半径ではなくガラスの形に合わせてコンテンツをクリップできます。

## 関連記事

- [修正: Flutter でキーボードを開くと A RenderFlex overflowed by N pixels on the bottom が出る](/ja/2026/08/fix-renderflex-overflowed-on-the-bottom-when-the-keyboard-opens-in-flutter/) -- 下部インセットの話のもう半分で、こちらはキーボードが padding ではなく制約を変えます。
- [Flutter 3.44: MediaQuery から画面の物理的な角の半径を読み取る](/ja/2026/07/flutter-3-44-read-the-screen-corner-radius-from-mediaquery/) -- 角の丸いディスプレイで全面レイアウトを作るための対になる API です。
- [Flutter で ListView と GridView を sliver で 1 つのスクロールビューにまとめる方法](/ja/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/) -- スクロールビューが `ListView` ではなく `CustomScrollView` の場合に下部インセットをどこへ適用するか。
- [Flutter の長いリストにおける shrinkWrap vs Expanded vs sliver: どれを選ぶべきか](/ja/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/) -- padding を足し始める前に、正しいスクロール方式を選ぶために。
- [解決: Google Play が Flutter または .NET MAUI アプリを 16 KB メモリページサイズ未対応で却下する](/ja/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/) -- ビルド時に不意打ちとして現れる、ストア起因の別の Android 要件です。

## 参考資料

- [Set default of SystemUiMode to edge-to-edge](https://docs.flutter.dev/release/breaking-changes/default-systemuimode-edge-to-edge) -- Flutter の移行ガイド。オプトアウト用のスタイルと `values-35` に関する注記を含みます。
- [Display content edge-to-edge in your app](https://developer.android.com/develop/ui/views/layout/edge-to-edge) -- API 35 以降での強制適用に関する Android の記述です。
- [Behavior changes: Apps targeting Android 16 or higher](https://developer.android.com/about/versions/16/behavior-changes-16) -- `windowOptOutEdgeToEdgeEnforcement` の非推奨化と無効化について。
- [SystemUiMode API documentation](https://api.flutter.dev/flutter/services/SystemUiMode.html) -- API 35 と API 36 が何を尊重するかについてのモードごとの注記です。
- [Issue 168635: App UI overlaps with 3-button navigation bar on Samsung One UI 7 / Android 15](https://github.com/flutter/flutter/issues/168635) -- Flutter 自身のドキュメントが指し示す追跡用の議論です。
