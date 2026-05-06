---
title: "DevTools で Flutter アプリの jank をプロファイルする方法"
description: "Flutter 3.27 で jank を発見して修正するための手順ガイド: profile mode、Performance overlay、Frame Analysis タブ、CPU Profiler、raster と UI スレッド、シェーダーのウォームアップ、Impeller 固有の落とし穴。Flutter 3.27.1、Dart 3.11、DevTools 2.40 で検証済み。"
pubDate: 2026-05-06
template: how-to
tags:
  - "flutter"
  - "dart"
  - "devtools"
  - "performance"
  - "jank"
  - "how-to"
lang: "ja"
translationOf: "2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools"
translatedBy: "claude"
translationDate: 2026-05-06
---

短い答え: `flutter run --profile` でビルドし(debug は使わない)、DevTools を開いて Performance タブに切り替え、jank を再現してから Frame Analysis チャートを読みます。予算(60 Hz なら 16.67 ms、120 Hz なら 8.33 ms)を超えたフレームは色付きで表示されます。予算超過のバーが UI スレッドで赤いなら、CPU Profiler に飛んで Dart コードを確認します。raster スレッドで赤いなら GPU がボトルネックで、対処は通常シェーダーのウォームアップ、画像の縮小、コストの高いエフェクトの削減のいずれかです。本ガイドは Flutter 3.27.1、Dart 3.11、DevTools 2.40 でこれらの判断を順に説明します。

## なぜ debug モードでは jank をプロファイルできないのか

debug ビルドはわざと遅く作られています。最適化されていない JIT コードを実行し、すべての assert を含み、AOT パイプラインをスキップします。フレームワーク自体がアプリの上に `"This is a debug build"` と表示してそれを思い出させます。debug で取った数値は通常 release よりも 2 倍から 10 倍悪く、debug で「見つけた」 jank が本番にはまったく存在しないこともあります。さらに悪いことに、Android の一部端末では debug のデフォルトのフレームレートが低いため、本物の jank を見逃すこともあります。

プロファイルは必ず `flutter run --profile` で実機に対して行ってください。シミュレーターと iOS Simulator は実際の GPU の挙動、特にシェーダーコンパイルを再現しません。profile mode は DevTools のフック(タイムラインイベント、アロケーション追跡、observatory)を維持しつつ、Dart コードを AOT パイプラインでコンパイルするので、数値は release と数パーセント以内の差に収まります。[Flutter のアプリパフォーマンスに関するドキュメント](https://docs.flutter.dev/perf/ui-performance)はこの点を明言しています。

```bash
# Flutter 3.27.1
flutter run --profile -d <your-device-id>
```

USB で繋がっている端末なら、`--profile --trace-startup` を使ってスタートアップタイムラインを `build/start_up_info.json` にキャプチャできます。コールドスタートの jank を測るのに特に便利です。

## DevTools を開いて適切なタブを選ぶ

`flutter run --profile` が起動すると、コンソールに `http://127.0.0.1:9100/?uri=...` のような DevTools の URL が表示されます。Chrome で開いてください。jank に関連するタブは、優先度順に次のとおりです:

1. **Performance**: フレームのタイムライン、Frame Analysis、raster cache、enhance tracing のスイッチ。
2. **CPU Profiler**: bottom-up、top-down、コールツリーのビューを備えたサンプリング profiler。
3. **Memory**: アロケーション追跡と GC イベント。jank が GC と相関する場合に有用。
4. **Inspector**: ウィジェットツリー。リビルドの嵐を確認するのに有用。

実行中のアプリ内から切り替えられる "Performance overlay" (ターミナルで `P`、もしくはコード中の `WidgetsApp.showPerformanceOverlay = true`) は同じデータの小型版を UI の上に重ねて描画します。実機でリアルタイムに jank を見つけるには優れていますが、特定のフレームに掘り下げることはできません。overlay で jank が起きるシナリオを見つけ、それを DevTools で取り込みましょう。

## Frame Analysis チャートの読み方

Performance では、上部のチャートが描画された各フレームを 1 本のバーで表します。各バーには 2 つの区画が水平に積まれます。下の区画が UI スレッド(Dart の `build`、`layout`、`paint` の経路)で、上の区画が raster スレッド(エンジンがレイヤツリーを GPU でラスタライズする場所)です。いずれかの区画がフレームの予算を超えるとバーは赤くなります。

フレームの予算は `1000 ms / refresh_rate` です。60 Hz の端末なら合計 16.67 ms ですが、各スレッドに 16.67 ms ずつ使えるわけではありません。フレームが間に合うのは UI と raster の両方が予算内に終わったときだけで、実際には各スレッド 8 ms 弱が目安です(残りはエンジンのオーバーヘッドと vsync との整合)。120 Hz の端末ではすべて半分にします。

赤いフレームをクリックすると、下のパネルが "Frame Analysis" に切り替わります。これは DevTools 2.40 で最も有用なビューです。次の情報が表示されます:

- そのフレームのタイムラインイベント。
- 主なコストが `Build`、`Layout`、`Paint`、`Raster` のどれか。
- シェーダーコンパイル、画像デコード、platform channel 呼び出しが関与したか。
- "This frame's UI work was dominated by a single Build phase" のようなテキストヒント。推測しなくて済みます。

ヒントが UI スレッドの問題と告げるなら、修正は Dart コード側です。raster スレッドを指しているなら、修正はウィジェットツリーの形、シェーダー、画像、エフェクトのいずれかにあります。

## UI スレッドがボトルネックのとき

UI スレッドの jank は、コードが 1 フレームの中で長く走りすぎていることを意味します。主な原因は次のとおりです:

- 実作業を行う `build` メソッド(JSON のパース、1 万件のリストの走査、長い文字列に対する regex)。
- 必要以上に大きいサブツリーを再構築する `setState`。
- 同期的な `File.readAsStringSync` や、その他のブロッキング I/O。
- 多数のリスナーへ波及する重い `Listenable` 変更。

jank の操作が起きている最中に CPU Profiler タブへ移ります。短いバースト用に "Profile granularity" を "high" に設定して記録を開始します。jank フレームの後で記録を停止します。bottom-up ビュー("Heaviest frames at the top")は数秒で犯人を示してくれることが多いです。

```dart
// Flutter 3.27.1, Dart 3.11
class ProductList extends StatelessWidget {
  const ProductList({super.key, required this.json});
  final String json;

  @override
  Widget build(BuildContext context) {
    // Bad: parses a 4 MB JSON blob on every rebuild on the UI thread.
    final products = (jsonDecode(json) as List)
        .map((e) => Product.fromJson(e as Map<String, dynamic>))
        .toList();

    return ListView.builder(
      itemCount: products.length,
      itemBuilder: (_, i) => ProductTile(product: products[i]),
    );
  }
}
```

修正は作業を UI スレッドから外すことです。単発なら `compute(...)` の呼び出し、繰り返し走る CPU バウンドの作業なら長寿命の isolate を使います。両者の詳細な手順は [CPU バウンド作業のための Dart isolate を書く専用ガイド](/ja/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) にあります。

UI スレッドのもう一つの目立たないコストはリビルドのしすぎです。実際に変化する部分を小さなウィジェットに包み、`setState` で走る `build` をその小さなウィジェットだけに限定します。Inspector の "Highlight Repaints" スイッチ(Performance > More options 内)は再描画される各レイヤに色付きの枠を描き、ルート近くの `Container` が画面全体をリビルドしているのを発見する最速の手段です。

## raster スレッドがボトルネックのとき

raster スレッドの jank は、ウィジェットが生成したレイヤツリーに対してエンジンが GPU 作業をやりすぎていることを意味します。修正はめったに「速い端末を使え」ではありません。たいていは次のいずれかです:

1. **シェーダーコンパイルによる jank**: 初回のエフェクト(ページ遷移、グラデーション、ブラー、custom painter)はフレームの途中でシェーダーをコンパイルし、raster 時間を跳ね上げます。画面を初めて開くときに 1 〜 2 フレーム極端に遅くなる形で現れます。
2. **オフスクリーンレイヤ**: `Opacity`、`ShaderMask`、`BackdropFilter`、`antiAlias: true` の `ClipRRect` は、サブツリーをテクスチャにレンダリングして合成するようエンジンを強制します。1 要素なら問題ありませんが、リストにすると高コストです。
3. **大きすぎる画像**: 4k JPEG を `Image.asset` にデコードすると、画面に見えるピクセル数をはるかに超える画像が貼られます。`cacheWidth` / `cacheHeight` でデコード時に縮小しましょう。
4. **`saveLayer` 呼び出し**: エンジンのタイムラインに現れる典型的な兆候。`saveLayer` は `Opacity` が内部で使うものです。`Opacity(opacity: 0.5, child: ...)` を `AnimatedOpacity` に置き換えるか、子側で alpha を焼き込んで描画すれば回避できます。

DevTools 2.40 はこれを直接可視化します。Performance > "Enhance Tracing" で "Track widget builds"、"Track layouts"、"Track paints" を有効にすると、タイムラインの詳細が増えます。Frame Analysis は "Raster cache" パネルも点灯させ、"raster cache hits / misses" の比率が高い場合は、キャッシュできるはずのレイヤがキャッシュされていないと分かります。

## Impeller と Skia でのシェーダーウォームアップ

Flutter のパフォーマンスで最も多い質問はこれです: 「この画面を初めて開くとカクつく」。原因はシェーダーコンパイルです。修正方法はレンダリングバックエンドによって異なります。

Impeller はエンジンのモダンなレンダラーです。Flutter 3.27 時点で iOS では Impeller がデフォルトで有効、Android でもデフォルトです(古い端末向けには Skia がフォールバックとして用意されています)。Impeller はすべてのシェーダーを事前にコンパイルするので、Impeller のみの端末ではシェーダーコンパイルによる jank は本来発生しないはずです。Impeller でも初回フレームの jank が見えるなら、それは画像デコードかレイヤのセットアップであり、シェーダーではありません。

Skia 経路(古い Android、web、デスクトップ)ではシェーダーコンパイルは依然としてランタイムに行われます。従来の `flutter build --bundle-sksl-path` ワークフローは SkSL キャッシュを使っていましたが、Flutter 3.7 以降、Impeller のおかげで不要になり、エンジンはこの経路を非推奨にしました。今でも Skia 端末向けに出荷する必要があるなら、推奨の手順は次のとおりです:

- 珍しいエフェクトを使う各ページをスプラッシュ画面の間に一度レンダリングする。
- アプリ起動時にグラデーション、ブラー、アニメーション遷移をオフスクリーンでマウントしてウォームアップする。
- フラッグシップではなくローエンドの Android 端末でテストする。

どのレンダラーが有効かは、実行中のアプリのログ(`flutter run` が `Using the Impeller rendering backend` を出力する)か DevTools の "Diagnostics" タブで確認できます。

## 実際にうまくいく繰り返し可能なワークフロー

私が使っているループはこの順番です:

1. `flutter run --profile -d <real-device>`。シミュレーターからの jank 計測は却下。
2. jank を再現する。アプリ内の Performance overlay (ターミナルで `P`) を切り替え、UI と raster のバーをリアルタイムで見ます。jank が本物で再現可能か確認します。
3. DevTools > Performance を開く。jank の前に "Record" を押して再現し、"Stop" を押す。
4. もっとも酷い赤いフレームをクリック。Frame Analysis を読む。UI か raster かを判定する。
5. UI なら: CPU Profiler タブを開いて同じシナリオを記録し、bottom-up でもっとも重い関数まで掘り下げる。作業を UI スレッドから移すか、リビルド範囲を縮小する。
6. raster なら: "Track paints" と "Highlight Repaints" を有効にし、`saveLayer`、大きすぎる画像、シェーダーコンパイルイベントを探す。置き換え、縮小、ウォームアップする。
7. 同じ端末で修正を確認する。回帰しないように予算をベンチマークに固定する。

ステップ 7 では、`package:flutter_driver` は Flutter 3.13 以降非推奨で、`package:integration_test` と `IntegrationTestWidgetsFlutterBinding.framework.allReportedDurations` の組み合わせが代替です。Flutter チームの[パフォーマンステストガイド](https://docs.flutter.dev/cookbook/testing/integration/profiling)が、配線方法と CI で比較できる JSON ファイルの出力方法を示しています。Flutter SDK の複数バージョンを CI マトリクスで動かすなら、同じハーネスは [Flutter のマルチバージョン CI パイプライン](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)にそのまま組み込めます。

## 難しいケース向けのカスタムタイムラインイベント

エンジンのイベントだけでは足りず、自分のコードをタイムラインで見たくなることがあります。`dart:developer` ライブラリが提供する同期トレース API は DevTools が自動で取り込みます:

```dart
// Flutter 3.27.1, Dart 3.11
import 'dart:developer' as developer;

List<Product> parseCatalog(String json) {
  developer.Timeline.startSync('parseCatalog');
  try {
    return (jsonDecode(json) as List)
        .map((e) => Product.fromJson(e as Map<String, dynamic>))
        .toList();
  } finally {
    developer.Timeline.finishSync();
  }
}
```

これで `parseCatalog` が UI スレッドのタイムラインにラベル付き span として現れ、Frame Analysis が直接そこに時間を割り当てられます。使いすぎは禁物です。`Timeline.startSync` ごとに小さくともゼロではないコストがあるので、ホットな内側のループを包んではいけません。粒度の粗い境界(パース、ネットワーク応答ハンドラ、コントローラのメソッドなど、計測対象の作業に比べてコストが無視できる場所)で使いましょう。

非同期作業では、async 関数の中の同期セクションには `Timeline.timeSync` を、関連するイベントをスレッド横断でつなぎたいときは `Timeline.startSync('name', flow: Flow.begin())` を `Flow.step` と `Flow.end` と組み合わせて、フローラインを描きます。Frame Analysis パネルはフレームを選択したときにこのフローを表示できます。

## メモリの圧迫は jank に見えることがある

50 〜 100 ms 程度のしゃっくりが UI スレッドに周期的に現れるのに、コールスタックのどのコードとも一致しない場合、原因は大きめのガベージコレクションであることが多いです。Memory タブを開き、GC マーカーの線を見ましょう。古い世代の GC が頻発するなら、フレームごとに短命なオブジェクトを大量にアロケートしているという相関があります。

よくある原因:

- `build` の中で新しい `TextStyle` や `Paint` をアロケートする。
- `ListView` のためにフレームごとに不変リスト(`List.from`、`[...spread]`)を再構築する。
- 再入の回避策として `Future.delayed(Duration.zero, () => setState(...))` を使い、フレームごとに microtask をスケジュールする。

定数は `build` の外に出し(`const TextStyle(...)` をファイルスコープで定義するのが定石)、再構築する代わりに変更可能なリストをミューテートするほうを選びます。Memory タブの "Profile Memory" 機能はヒープアロケーションプロファイルを取得し、どのクラスがゴミを生んでいるかを正確に指し示します。

## ネイティブコード呼び出しは独自のプロファイル問題

アプリが platform channel(`MethodChannel`、`EventChannel`)を使っている場合、Dart からは普通の `Future` に見えますが、実際の作業はプラットフォーム側のスレッドで行われます。DevTools は Dart 側の待機は表示しますが、ネイティブハンドラの内部は見られません。フレームが Kotlin や Swift の遅い実装で jank になっているなら、同じプロセスにネイティブ profiler(Android Studio の CPU Profiler や Xcode Instruments)をアタッチする必要があります。

もう一つの落とし穴: モダンな Flutter では platform channel の同期呼び出しは違法で(`Synchronous platform messages are not allowed` でクラッシュします)、ブロッキングはすべて Dart 側の async ブロッキングになります。`MethodChannel.invokeMethod` に 200 ms かかるなら、その 200 ms の間 `await` は戻り、フレームは完了できますが、結果に連なる処理は後のフレームに押し出され、フレーム飛びのように見えます。修正は、UI が単一のラウンドトリップに依存して描画しないようにチャネルを設計することです。詳しくは [platform channel ガイド](/ja/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) にあります。

## よくある誤検知

長いだけのフレームを「janky」と決めつけてはいけません。jank に見えてそうでないパターンをいくつか挙げます:

- hot reload の直後の最初のフレーム。hot reload はウィジェットを再解決し、意図的に最適化されていません。reload 後の最初のフレームは無視してください。
- アプリがバックグラウンド遷移中に走るフレーム。OS はフレームの途中でレンダラーを一時停止できます。
- バックグラウンドの再コンパイル中のファントムフレーム。

迷うときは、新しい `flutter run --profile` で jank を 2 回再現し、両方の実行で一致したものだけを信じてください。

## 関連

- [CPU バウンド作業のための Dart isolate を書く](/ja/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/)では、重いパースや計算を UI スレッドから外す方法を扱っています。
- [プラグインなしで Flutter にプラットフォーム固有コードを追加する](/ja/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/)は `MethodChannel` とスレッドモデルをより深く掘り下げます。
- [単一の CI パイプラインから複数の Flutter バージョンをターゲットにする](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)は、回帰ベンチマークが用意できたときに欲しくなるハーネスです。
- [Flutter アプリを GetX から Riverpod に移行する](/ja/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/)はリビルド範囲を扱っており、これは UI スレッド jank の最大級の原因の一つです。
- [Windows から Flutter iOS をデバッグする: 実機ワークフロー](/ja/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/)では、Xcode をローカルで動かせないときにリモートビルドした iOS 端末へ DevTools をアタッチする方法を示します。

## 参照リンク

- [Flutter アプリパフォーマンスの概要](https://docs.flutter.dev/perf/ui-performance) (docs.flutter.dev)
- [DevTools の Performance ビュー](https://docs.flutter.dev/tools/devtools/performance) (docs.flutter.dev)
- [DevTools の CPU Profiler](https://docs.flutter.dev/tools/devtools/cpu-profiler) (docs.flutter.dev)
- [統合テストでのアプリパフォーマンスのプロファイリング](https://docs.flutter.dev/cookbook/testing/integration/profiling) (docs.flutter.dev)
- [Impeller レンダリングエンジン](https://docs.flutter.dev/perf/impeller) (docs.flutter.dev)
- [`dart:developer` の Timeline API](https://api.dart.dev/stable/dart-developer/Timeline-class.html) (api.dart.dev)
