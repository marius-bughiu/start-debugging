---
title: "Flutter でアダプティブ AdMob バナーの領域を確保してレイアウトシフトを防ぐ方法"
description: "google_mobile_ads の公式サンプルは onAdLoaded まで何も描画しないため、画面が表示された数秒後にコンテンツが 150 dp 跳ねます。先にアンカー型アダプティブのサイズを取得し、SizedBox で領域を確保し、高さを起動をまたいで保存してから、広告を読み込みます。Flutter 3.44.8 と google_mobile_ads 9.1.0 で計測しました。"
pubDate: 2026-10-05
template: how-to
tags:
  - "flutter"
  - "dart"
  - "admob"
  - "android"
  - "layout"
lang: "ja"
translationOf: "2026/10/how-to-reserve-space-for-an-adaptive-admob-banner-in-flutter-to-avoid-layout-shift"
translatedBy: "claude"
translationDate: 2026-10-05
---

**結論:** アンカー型アダプティブバナーの高さは広告を読み込む前に分かるので、その分の領域を確保してください。幅が 0 でなくなった時点で `AdSize.getLargeAnchoredAdaptiveBannerAdSize(width)` を呼び、その高さちょうどの `SizedBox` をバナー用のスロットにすぐ配置し、`onAdLoaded` が呼ばれたらボックスの中に `AdWidget` を入れ替えます。高さは `shared_preferences` に保存しておくと、次回のコールドスタートの最初のフレームからスロットが存在します。読み込みに失敗してもスロットを畳まずに残してください。以下はすべて、Android 16 (API 36) のエミュレーター上で Flutter 3.44.8 (Dart 3.12.2) と `google_mobile_ads` 9.1.0 を使って計測した結果です。

## バナーが到着すると画面が跳ねる理由

Google の Flutter プラグイン向けバナーガイドでは、広告を読み込み、`onAdLoaded` で初めてツリーに追加します。表示用のスニペットは `if (_bannerAd != null)` でガードされ、ボックスのサイズは `_bannerAd!.size` から決まります。ネットワークの往復が終わるまで、バナーのスロットの高さは 0 ピクセルです。広告が届くとスロットが伸び、`Scaffold` の body が同じ量だけ縮み、ユーザーが画面下部付近で見ていたものが動いてしまいます。

このシフトは以前より深刻で、理由は 2 つあります。

1. **大きなアンカー型アダプティブバナーは高さがあります。** `google_mobile_ads` 8.0.0 以降、`getCurrentOrientationAnchoredAdaptiveBannerAdSize` は非推奨となり、`getLargeAnchoredAdaptiveBannerAdSize` が推奨されています。Google のガイドは、この large 版を "up to 20% of screen height, between 50 and 150 dp" と説明しています。一般的なスマートフォンでは、従来の 50 から 64 dp の帯のおよそ 2 倍です。
2. **広告の到着が遅いです。** リクエストは `MobileAds.instance.initialize()` の後に送られ、広告オークションとクリエイティブのダウンロードが続きます。コールドスタートでは数フレームではなく数秒かかり、これはちょうどユーザーが読み始めたりタップしたりする時間帯です。

## シフトの計測

実際の数値を得るために、プローブ用のアプリを作りました。body が `LayoutBuilder` で包まれた `ListView` の `Scaffold` で、body の高さが変わるたびにログを出し、バナーは `bottomNavigationBar` に置いています。エミュレーターは 420 dpi の 1080x2400 画面で、Flutter からは 411.43 x 914.29 論理ピクセルに見えます。公式のアダプティブバナー用テストユニット `ca-app-pub-3940256099942544/9214589741` とリリースビルドを使いました。

まず、幅ごとに SDK が返す高さです (単位はすべて dp)。

| 要求した幅 | Large アンカー型 (現在の向き) | Large、横向き | 標準アンカー型 (非推奨) |
|---|---|---|---|
| 320 | 100 | 82 | 50 |
| 360 | 113 | 82 | 56 |
| 411 | 128 | 82 | 64 |
| 412 | 129 | 82 | 64 |
| 600 | 150 | 82 | 77 |
| 800 | 150 | 82 | 90 |

縦向きでは、large サイズは 320x50 のアスペクト比を 320x100 に拡大した値に追従し、150 で頭打ちになります。横向きでは 82 に固定されており、これは横向き時の高さ 411 dp の 20% です。いずれもネットワーク呼び出しは不要で、サイズは端末上で計算され、数ミリ秒で解決します。

次に、チュートリアルのパターンと領域を確保したパターンでの body の高さの推移です。

| パターン | 最初の実フレーム | body の高さの変化 | タイミング |
|---|---|---|---|
| `onAdLoaded` まで何も描画しない | 302 ms | 914.29 -> 762.29 | 5,338 ms、広告の読み込み時 |
| サイズを確保し、`didChangeDependencies` で取得 | 439 ms | 914.29 -> 762.29 | 448 ms、1 フレーム後 |
| サイズを確保し、高さを `shared_preferences` から復元 | 546 ms | 0 -> 762.29 に直接変化 | シフトなし |

152 dp の減少は、128 dp のバナーと、その下で `SafeArea` が加える 24 dp のジェスチャーナビゲーションのインセットの合計です。素朴な実装では、画面が表示されてから 5 秒以上後に発生します。サイズを確保すると最初のフレームの直後のフレームに移り、高さを保存するとシフトはなくなります。

## ステップ 1: 何かを読み込む前にサイズを取得する

`AdSize` のサイズ取得メソッドは static で、プラットフォームチャネルを介するため非同期ですが、広告が読み込まれているかどうかには依存しません。`MediaQuery` から幅が得られたらすぐに呼び出します。

```dart
// Flutter 3.44.8, google_mobile_ads 9.1.0
@override
void didChangeDependencies() {
  super.didChangeDependencies();
  final size = MediaQuery.sizeOf(context);
  final padding = MediaQuery.paddingOf(context);
  final width = (size.width - padding.left - padding.right).truncate();
  // Android can report a 0x0 window on the very first frame.
  if (width <= 0 || width == _width) return;
  _width = width;
  unawaited(_load(width));
}
```

`width <= 0` のガードは飾りではありません。リリースビルドでは、最初の `build` が 0x0 の `MediaQuery` サイズで実行されました。Android がまだウィンドウのメトリクスを渡していなかったのです。`main()` 内の `platformDispatcher.implicitView` でさえ、`runApp` の前は `physicalSize` が 0、`devicePixelRatio` が 1.0 でした。幅 0 で large アンカー型バナーを要求すると `0x100` が返り、そのサイズで読み込むと `LoadAdError(code: 3, ... "Ad request doesn't meet size requirements")` で失敗しました。チュートリアルのコードは幅 0 のフレームで最初のリクエストを発行しており、1 フレーム後に実際のメトリクスで `didChangeDependencies` が再び呼ばれるおかげでようやく成功しています。

要求する前に、水平方向のセーフエリアのパディングを差し引いてください。Google のインラインアダプティブのガイドは、幅が "should take into account the device width and any safe areas that are applicable" と明記しており、ディスプレイにカットアウトがあるスマートフォンの横向きでは `MediaQuery.paddingOf(context).left` は 0 ではありません。

## ステップ 2: 自分の高さを管理するスロットを作る

スロットは、確保した高さを持つ `SizedBox` で、常にツリー内にあります。`AdWidget` は広告の読み込み後にのみ中に入れます。そうしないと `AdWidget` が "AdWidget requires Ad.load to be called before AdWidget is inserted into the tree" をスローするためです。

```dart
// Flutter 3.44.8, google_mobile_ads 9.1.0, shared_preferences 2.5.5
class AnchoredBannerSlot extends StatefulWidget {
  const AnchoredBannerSlot({super.key, required this.adUnitId});

  final String adUnitId;

  @override
  State<AnchoredBannerSlot> createState() => _AnchoredBannerSlotState();
}

class _AnchoredBannerSlotState extends State<AnchoredBannerSlot> {
  BannerAd? _ad;
  bool _loaded = false;
  int? _width;
  int? _height;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final size = MediaQuery.sizeOf(context);
    final padding = MediaQuery.paddingOf(context);
    final width = (size.width - padding.left - padding.right).truncate();
    // Android can report a 0x0 window on the very first frame.
    if (width <= 0 || width == _width) return;
    _width = width;
    _height = BannerHeightCache.lookup(width);
    unawaited(_load(width));
  }

  Future<void> _load(int width) async {
    final size = await AdSize.getLargeAnchoredAdaptiveBannerAdSize(width);
    if (!mounted || width != _width || size == null) return;
    BannerHeightCache.remember(width, size.height);

    final previous = _ad;
    setState(() {
      _height = size.height;
      _ad = null;
      _loaded = false;
    });
    await previous?.dispose();
    if (!mounted || width != _width) return;

    final ad = BannerAd(
      adUnitId: widget.adUnitId,
      request: const AdRequest(),
      size: size,
      listener: BannerAdListener(
        onAdLoaded: (ad) {
          if (!mounted || ad != _ad) {
            ad.dispose();
            return;
          }
          setState(() => _loaded = true);
        },
        onAdFailedToLoad: (ad, error) {
          ad.dispose();
          // Keep the reserved height: collapsing now would be a layout shift.
          if (mounted && ad == _ad) setState(() => _ad = null);
        },
      ),
    );
    _ad = ad;
    await ad.load();
  }

  @override
  void dispose() {
    _ad?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final height = _height;
    if (height == null) return const SizedBox.shrink();
    final ad = _ad;
    return SafeArea(
      top: false,
      child: SizedBox(
        height: height.toDouble(),
        child: Center(
          child: _loaded && ad != null
              ? SizedBox(
                  width: ad.size.width.toDouble(),
                  height: ad.size.height.toDouble(),
                  child: AdWidget(ad: ad),
                )
              : null,
        ),
      ),
    );
  }
}
```

重要な点がいくつかあります。

- **すべての `await` の後で `width != _width` を確認します。** サイズの取得や `dispose()` が進行中にも、回転によって幅が変わります。このチェックがないと、古い縦向きのリクエストが横向きのスロットを上書きしてしまうことがあります。
- **`onAdLoaded` で `ad != _ad` を確認します。** ウィジェットがすでに新しいリクエストに移っている場合、遅れて届いた広告は表示されずに破棄されます。
- **確保したボックスの外側に `SafeArea(top: false)` を置きます。** スロットは `bottomNavigationBar` に置かれるため、下部のインセットを自分で吸収する必要があります。Android 15 以降をターゲットにするアプリでは edge-to-edge が強制されるので、そのインセットは自動では差し引かれません。
- **`AdWidget` を `Center` で包みます。** iOS では、プラグインのドキュメントによると、ウィジェットの親が "with a specified width and height" である必要があり、そうでないと広告が表示されないことがあります。内側の `SizedBox` が、要求したサイズちょうどを与えます。

使い方は `Scaffold` に 1 行追加するだけです。

```dart
// Flutter 3.44.8, google_mobile_ads 9.1.0
Scaffold(
  body: const ArticleList(),
  bottomNavigationBar: const AnchoredBannerSlot(
    adUnitId: 'ca-app-pub-3940256099942544/9214589741', // test unit
  ),
);
```

## ステップ 3: 高さを保存して最初のフレームを正しくする

ステップ 2 だけでは、コールドスタート時に 1 フレームの隙間が残ります。実際の幅を持つ最初のフレームが、プラットフォームチャネルの応答より先に描画されるためです。計測では、この隙間は 9 から 70 ms で、通常は最初のコンテンツがまだ描画されている最中に収まりますが、それでもシフトであり、画面録画には映ります。

対策として、アンカー型の高さは端末と幅だけで決まる純粋関数であることを利用します。Google 自身のドキュメントも、最適な高さは "remains constant across different ad requests" と述べています。つまり、SDK が前回返した答えは、次回の起動時の最初の推測として申し分ありません。

```dart
// Flutter 3.44.8, shared_preferences 2.5.5
class BannerHeightCache {
  static const _prefix = 'admob.anchoredHeight.';
  static final Map<int, int> _heights = {};

  static Future<void> restore() async {
    final prefs = await SharedPreferences.getInstance();
    for (final key in prefs.getKeys().where((k) => k.startsWith(_prefix))) {
      final width = int.tryParse(key.substring(_prefix.length));
      final height = prefs.getInt(key);
      if (width != null && height != null) _heights[width] = height;
    }
  }

  static int? lookup(int width) => _heights[width];

  static void remember(int width, int height) {
    if (_heights[width] == height) return;
    _heights[width] = height;
    unawaited(
      SharedPreferences.getInstance()
          .then((prefs) => prefs.setInt('$_prefix$width', height)),
    );
  }
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await BannerHeightCache.restore();
  unawaited(MobileAds.instance.initialize());
  runApp(const MyApp());
}
```

スロットはすでに `didChangeDependencies` で `BannerHeightCache.lookup(width)` を読んでいるため、2 回目の起動では、最初の実フレームが 128 dp のボックスで構築され、body は 0 から最終的な 762.29 dp に直接変わります。実際の取得も引き続き実行され、キャッシュ値を上書きします。そのため推測が外れても (OS のバージョンが変わった、ディスプレイサイズの設定が異なるなど)、シフトは 1 回で済み、その後は自動で修正されます。メモリ上のマップは同一セッション内でも役立ちます。バナーを持つ 2 番目の画面は、高さを同期的に取得できます。

上の表から高さを自分で計算しようとはしないでください。100/320 の比率や上限値は、観測された SDK の挙動であって、文書化された契約ではなく、Google はこれまでにもアダプティブサイズを変更したことがあります。SDK の答えをキャッシュすれば、数式に賭けることなく、同じ最初のフレームの精度が得られます。

## ステップ 4: 広告が返ってこなかった場合の動作を決める

領域を確保していると、読み込みに失敗したとき、下部に空の帯が残ります。取れる選択肢は 2 つあります。

1. **帯を残す。** レイアウトは一切動かず、次のリクエスト (画面遷移時、タイマー、または設定していれば AdMob の自動更新) で埋まります。上のウィジェットはこの方式です。
2. **帯を畳む。** 領域は戻りますが、代償としてレイアウトシフトがちょうど 1 回発生し、次の試行の前に再び確保し直す必要があります。

下部アンカーのバナーでは、私は前者を選びます。ユーザーは、空白の 128 dp の帯を "欠落" として認識しなくなるのがとても早い一方で、親指の下でリストが跳ねることには決して慣れません。畳む場合は、変化が意図的に見えるように `AnimatedSize` でアニメーションさせてください。

## テスト広告はスロットより小さかった

プローブで見つかったことがもう 1 つあります。`onAdLoaded` の後、`BannerAd.getPlatformAdSize()` は、`411x128` で要求した広告に対して `411x64` を返しました。テスト用クリエイティブは標準の高さのバナーだったのです。ネイティブビューはそれを 128 dp のリクエスト領域の中央に配置し、`AdWidget` を 128 dp で描画してもプラットフォームのサイズで描画しても、見た目は同じでした。読み込み後にスロットをプラットフォームのサイズまで縮めないでください。それは逆方向のレイアウトシフトであり、次の更新ではフル高さのクリエイティブが返ってくる可能性も十分あります。

## スクロールするコンテンツ内のインラインアダプティブバナー

インラインアダプティブバナーは、もう 1 つのアダプティブ系統で、フィードの中への配置を想定しています。高さはサーバー側で決まるため、`AdSize.getCurrentOrientationInlineAdaptiveBannerAdSize(width)` は高さ 0 のサイズを返し、実際の高さは読み込み後の `getPlatformAdSize()` で初めて分かります。Google のサンプルは、読み込みまで空の `Container()` を描画し、その後でボックスのサイズを設定する方式で対処していますが、これでは下にあるすべてのアイテムがずれます。

未知の高さを確保することはできませんが、上限を設けることはできます。`AdSize.getInlineAdaptiveBannerAdSize(width, maxHeight)` を使い、`maxHeight` を確保します。

```dart
// Flutter 3.44.8, google_mobile_ads 9.1.0
class InlineBannerSlot extends StatefulWidget {
  const InlineBannerSlot({super.key, required this.adUnitId, this.maxHeight = 250});

  final String adUnitId;
  final int maxHeight;

  @override
  State<InlineBannerSlot> createState() => _InlineBannerSlotState();
}

class _InlineBannerSlotState extends State<InlineBannerSlot> {
  BannerAd? _ad;
  AdSize? _platformSize;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_ad != null) return;
    final width = MediaQuery.sizeOf(context).width.truncate();
    if (width <= 0) return;
    _ad = BannerAd(
      adUnitId: widget.adUnitId,
      request: const AdRequest(),
      size: AdSize.getInlineAdaptiveBannerAdSize(width, widget.maxHeight),
      listener: BannerAdListener(
        onAdLoaded: (ad) async {
          final size = await (ad as BannerAd).getPlatformAdSize();
          if (mounted) setState(() => _platformSize = size);
        },
        onAdFailedToLoad: (ad, error) => ad.dispose(),
      ),
    )..load();
  }

  @override
  void dispose() {
    _ad?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ad = _ad;
    final size = _platformSize;
    return SizedBox(
      height: widget.maxHeight.toDouble(),
      child: Center(
        child: ad != null && size != null
            ? SizedBox(
                width: size.width.toDouble(),
                height: size.height.toDouble(),
                child: AdWidget(ad: ad),
              )
            : null,
      ),
    );
  }
}
```

トレードオフは、クリエイティブが `maxHeight` より低い場合にレターボックスになることです。デザイン上それが不自然な場合の代替策は、アイテムがスクロールで表示される十分前にリクエストを開始しておくことです (`ListView` は、ビューポートから `cacheExtent` の範囲内、デフォルトでは 250 ピクセルのアイテムを構築します)。ただし、ビューポートより上でシフトが起きるとスクロール位置が動くことは受け入れる必要があります。また Google は、スクロールビュー内のインラインバナーは Android 9 以前でパフォーマンスが低下することがあり、アンカー型バナーは影響を受けないと警告しています。

## 注意点

- **1 つの `BannerAd` に対して 1 つの `AdWidget`。** 広告オブジェクトを 2 か所で再利用すると "This AdWidget is already in the Widget tree" がスローされます。各スロットが自分の広告を持ってください。
- **`getLargeAnchoredAdaptiveBannerAdSize` は `null` を返すことがあります。** SDK がウィンドウに対する高さを見つけられないとき、プラグインは `null` を返します。その場合スロットは何も描画せず、広告を表示しないのと同じ結果になります。
- **非推奨のサイズを "領域の節約" のために使わないでください。** `getCurrentOrientationAnchoredAdaptiveBannerAdSize` は 9.1.0 でもまだ動作し、幅 411 dp で 128 ではなく 64 dp を返しますが、非推奨であり、Google が最適化の対象にしているのは large 形式です。
- **向きの変更は新しいリクエストです。** 幅が変わると、スロットは新しい高さをすぐに再確保し (この端末では横向きが 82 dp)、それに対して新しい広告を読み込みます。このシフトは回転自体が原因なので、想定内の動作です。
- **ホットリロードは最初のフレームのバグを隠します。** 幅 0 の最初のフレームは、コールドスタート時にしか現れません。確保したスロットのテストは、ホットリスタートの後ではなく、強制停止の後の `flutter run --release` で行ってください。
- **リリースビルドは、広告のコードが動く前にクラッシュすることがあります。** プローブでは、R8 が広告 SDK が WorkManager 経由で取り込む `androidx.work.impl.WorkDatabase` を削除し、アプリは "Failed to create an instance of androidx.work.impl.WorkDatabase" で終了しました。最小化を無効にする (`isMinifyEnabled = false`) とプローブでは直りました。より範囲の狭い対策は、WorkManager のデータベースクラスに対する ProGuard の keep ルールです。リリースビルドだけがクラッシュしてデバッグビルドはしない場合は、バナーのコードを疑う前に `adb logcat` を確認してください。

.NET MAUI からもバナーを運用している場合、同じ考え方がそのまま当てはまります。[MAUI AdMob ガイド (バナー、インタースティシャル、リワード広告)](/2026/07/monetize-a-net-maui-app-with-admob-banner-interstitial-rewarded/) はネイティブビューを使っており、そこにも読み込み前のサイズ取得 API があります。

## 関連記事

- [Fix: Flutter UI overlaps the Android system navigation bar after targeting SDK 35](/ja/2026/08/fix-flutter-ui-overlaps-the-android-navigation-bar-after-targeting-sdk-35/) は、バナーのスロットが吸収しなければならない下部インセットを説明しています。
- [How to use BuildContext safely after an await in Flutter](/ja/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) は、スロットがすべての非同期処理の後で行っている `mounted` チェックを扱っています。
- [How to profile jank in a Flutter app with DevTools](/ja/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) は、バナーを配置した後にプラットフォームビューがフレームを消費していないかを確認するのに役立ちます。
- [Monetize a .NET MAUI app with AdMob banners, interstitials and rewarded ads](/2026/07/monetize-a-net-maui-app-with-admob-banner-interstitial-rewarded/) は、同じ AdMob 構成の MAUI 側です。

## 参考資料

- [Set up banner ads (Flutter)](https://developers.google.com/admob/flutter/banner) は、large アンカー型アダプティブサイズ、テスト広告ユニット ID、iOS のサイズに関する注意が載っています。
- [Use inline adaptive for scrolling banners (Flutter)](https://developers.google.com/admob/flutter/banner/inline-adaptive) は、`getInlineAdaptiveBannerAdSize` と `getPlatformAdSize` の出典です。
- [Set up banner ads (Android)](https://developers.google.com/admob/android/banner/anchored-adaptive) は、large アダプティブバナーの 50 から 150 dp、画面高さの 20% という範囲の出典です。
- [google_mobile_ads on pub.dev](https://pub.dev/packages/google_mobile_ads) とその [changelog](https://pub.dev/packages/google_mobile_ads/changelog) には、8.0.0 での非推奨化が含まれています。
- [shared_preferences on pub.dev](https://pub.dev/packages/shared_preferences)。
