---
title: "修正: Flutter の youtube_player_iframe で YouTube 埋め込みに \"Video unavailable\" (Error 152 / 153) が表示される"
description: "Error 153 は YouTube に Referer が届いていないこと、152 はページが youtube.com を名乗っていることを意味します。youtube_player_iframe を 6.0.2 にアップグレードして origin を https://<アプリ ID> に設定するか、5.x では youtube-nocookie を使います。"
pubDate: 2026-09-26
template: error-page
tags:
  - "errors"
  - "flutter"
  - "webview"
  - "ios"
  - "android"
lang: "ja"
translationOf: "2026/09/fix-youtube-embed-video-unavailable-error-152-153-in-flutter-youtube-player-iframe"
translatedBy: "claude"
translationDate: 2026-09-26
---

YouTube は現在、誰が埋め込んでいるのかを識別できない限り埋め込み動画の再生を拒否します。Flutter アプリでは、その識別情報は `youtube_player_iframe` が WebView に読み込む HTML ページの origin です。Error 153 はページに origin がまったくなく、`Referer` が送信されなかったことを意味します。Error 152 はページが `https://www.youtube.com` を名乗っていたことを意味し、これはまさに `youtube_player_iframe` 5.2.2 以前がデフォルトで行っている動作です。修正方法は `youtube_player_iframe` 6.0.2 にアップグレードし、`YoutubePlayerParams(origin: 'https://com.yourcompany.yourapp')` を設定することです。5.x から移行できない場合は、代わりに `origin: 'https://www.youtube-nocookie.com'` を設定してください。アプリ ID は決して設定しないでください。

以下の内容はすべて、iOS 26.5 シミュレーター (iPhone 17 Pro Max、Xcode 27.0) 上で Flutter 3.44.8 / Dart 3.12.2、`webview_flutter` 4.14.1、`webview_flutter_wkwebview` 3.26.1 を使って計測し、`youtube_player_iframe` 5.2.2 と 6.0.2 のソースと照合したものです。Android ではこのマトリクスを実行していないため、Android に関する記述は実機ではなく YouTube のドキュメントとパッケージのソースに基づいています。

## エラーの状況

プレーヤー領域には動画の代わりに YouTube 自身のエラーカードが表示されます。

```text
Video unavailable
Error 153
Video player configuration error
```

もう一方のバリエーション (`youtube_player_iframe` ^5.2.1 で [youtube_player_flutter#1155](https://github.com/sarbagyastha/youtube_player_flutter/issues/1155) に報告されたもの) では次のようになります。

```text
This video is unavailable
Error 152-4
Watch on YouTube
```

2025 年 8 月以降、何か月も変更していなかったアプリが、ある日突然同じ動画を再生できなくなりました。そのため [#1084 "Working App Broke In prod, Youtube Changed Something"](https://github.com/sarbagyastha/youtube_player_flutter/issues/1084) や [#1124 "Error code 153"](https://github.com/sarbagyastha/youtube_player_flutter/issues/1124) といった issue には "same here" のコメントが何十件も集まりました。動画は公開済みで埋め込み可能であり、モバイル版 Chrome では再生でき、アプリ内でだけ失敗します。

## YouTube が埋め込みを拒否する理由

[YouTube API Services Required Minimum Functionality](https://developers.google.com/youtube/terms/required-minimum-functionality) のページには、IFrame Player API を含む埋め込みプレーヤーを使うクライアントは "HTTP Referer リクエストヘッダーによって識別情報を提供しなければならない" と書かれています。ブラウザーはこれを自動的に行います。`youtube.com/embed/...` を指す `<iframe>` は、推奨される `strict-origin-when-cross-origin` ポリシーのもとで、それを含むページから導出された `Referer` 付きでリクエストされます。モバイルの WebView には、こちらから与えない限り導出元となるページがありません。ローカル HTML の場合、ドキュメントに記載された方法はベース URL を使うことです。Android では `loadDataWithBaseURL`、iOS では `loadHTMLString:baseURL:` を使い、`https://<app-id>` の形式の値、たとえば `https://com.google.android.youtube` を指定します。

[IFrame API リファレンス](https://developers.google.com/youtube/iframe_api_reference) では現在、error 153 を "リクエストに HTTP Referer ヘッダーまたは同等の API クライアント識別情報が含まれていない" と説明しています。Error 152 はドキュメント化されていません。`youtube_player_iframe` はこれを別の "埋め込み不可" コードとして扱いますが、私の計測では、埋め込みページの origin が `https://www.youtube.com` のときには完全に埋め込み可能な動画でも発生します。YouTube は埋め込み元を YouTube 自身と識別し、拒否するのです。

では、パッケージが何をしているかを見てみましょう。`youtube_player_iframe` は YouTube の URL を読み込むのではなく、同梱された `assets/player.html` を `WebViewController.loadHtmlString` で読み込み、そのページが IFrame API を通じてプレーヤーを作成します。5.2.2 の該当コードは次のとおりです。

```dart
// youtube_player_iframe 5.2.2, lib/src/player_params.dart
this.origin = 'https://www.youtube.com',

// youtube_player_iframe 5.2.2, lib/src/controller/youtube_player_controller.dart
baseUrl: kIsWeb ? Uri.base.origin : params.origin,
// ...
'host': params.origin ?? 'https://www.youtube.com',
```

つまりデフォルトでは、ローカル HTML ページの origin は `https://www.youtube.com` になり、プレーヤーは `host: 'https://www.youtube.com'` で作成され、`origin` と `widget_referrer` のプレーヤー変数も `https://www.youtube.com` になります。これが error 152 です。しかも 1 つのパラメーターがページの origin と iframe の host の両方に使われるため、`origin` にアプリ ID を入れても修正できません。その場合プレーヤーは存在しない `https://com.yourcompany.yourapp` から iframe を読み込もうとします。

バージョン 6.0.0 (2026 年 5 月 16 日) でこの 2 つが分離されました。`origin` のデフォルトは `null` になり、新しい `privacyEnhancedMode` (デフォルトは `true`) が host を選び、ベース URL はその host にフォールバックします。

```dart
// youtube_player_iframe 6.0.2, lib/src/player_params.dart
String get host => privacyEnhancedMode
    ? 'https://www.youtube-nocookie.com'
    : 'https://www.youtube.com';

// youtube_player_iframe 6.0.2, lib/src/controller/youtube_player_controller.dart
baseUrl: kIsWeb ? Uri.base.origin : (params.origin ?? params.host),
```

メンテナーは [#1155](https://github.com/sarbagyastha/youtube_player_flutter/issues/1155) を "Fixed with v6.0.0" としてクローズし、153 の報告 ([#1124](https://github.com/sarbagyastha/youtube_player_flutter/issues/1124)、[#1150](https://github.com/sarbagyastha/youtube_player_flutter/issues/1150)) も 6.0.1 のリリースに合わせて 2026 年 5 月 30 日にクローズされました。

## 最小の再現: ページ origin のマトリクス

YouTube がどの組み合わせを受け入れるのかを確かめるため、パッケージを実際に行っている処理だけに削ぎ落としました。`WebViewController` が小さな HTML ページを `loadHtmlString` で読み込み、指定した `host` で `YT.Player` を作成し、`onReady` で `playVideo()` を呼び出し、すべての `onStateChange` と `onError` を JavaScript チャネル経由で Dart に報告します。動画は YouTube 自身の IFrame API デモである `M7lc1UVf-VE` で、埋め込み可能です。

```dart
// Flutter 3.44.8, webview_flutter 4.14.1, webview_flutter_wkwebview 3.26.1
String playerHtml({required String host, String? origin}) => '''
<!DOCTYPE html><html><body style="margin:0"><div id="p"></div>
<script>
function send(m) { Log.postMessage(m); }
var tag = document.createElement('script');
tag.src = 'https://www.youtube.com/iframe_api';
document.body.appendChild(tag);
function onYouTubeIframeAPIReady() {
  new YT.Player('p', {
    host: '$host', videoId: 'M7lc1UVf-VE',
    playerVars: {autoplay: 1, mute: 1, playsinline: 1, enablejsapi: 1
      ${origin == null ? '' : ", origin: '$origin', widget_referrer: '$origin'"}},
    events: {
      onReady: function (e) { send('onReady'); e.target.playVideo(); },
      onStateChange: function (e) { send('state=' + e.data); },
      onError: function (e) { send('ERROR=' + e.data); }
    }
  });
}
</script></body></html>''';

final controller = WebViewController.fromPlatformCreationParams(
  WebKitWebViewControllerCreationParams(
    allowsInlineMediaPlayback: true,
    mediaTypesRequiringUserAction: const <PlaybackMediaTypes>{},
  ),
)
  ..setJavaScriptMode(JavaScriptMode.unrestricted)
  ..addJavaScriptChannel('Log', onMessageReceived: (m) => debugPrint(m.message))
  ..loadHtmlString(
    playerHtml(host: 'https://www.youtube.com', origin: 'https://www.youtube.com'),
    baseUrl: 'https://www.youtube.com', // the 5.2.2 default
  );
```

結果は次のとおりです。各ケースをシミュレーター上で 25 秒間実行しました (`state=1` は "再生中" です)。

| ケース | ページ origin (`baseUrl`) | プレーヤー `host` | 結果 |
| --- | --- | --- | --- |
| `youtube_player_iframe` 5.2.2 のデフォルト | `https://www.youtube.com` | `https://www.youtube.com` | `ERROR=152` |
| 6.0.x で `privacyEnhancedMode: false` | `https://www.youtube.com` | `https://www.youtube.com` | `ERROR=152` |
| ベース URL なし (`about:blank`、origin `null`) | なし | `https://www.youtube.com` | `ERROR=153` |
| 5.x の回避策、6.0.x のデフォルト | `https://www.youtube-nocookie.com` | `https://www.youtube-nocookie.com` | `state=1`、再生される |
| アプリ ID + nocookie host | `https://com.example.ytrepro` | `https://www.youtube-nocookie.com` | `state=1`、再生される |
| アプリ ID + youtube.com host | `https://com.example.ytrepro` | `https://www.youtube.com` | `state=1`、再生される |
| 5.x の `origin` にアプリ ID (host にもなる) | `https://com.example.ytrepro` | `https://com.example.ytrepro` | `onReady` に到達しない |

この表から 2 つのルールが導かれます。origin のないページは 153 になり、`youtube.com` を装ったページは 152 になり、それ以外の実在する `https://` origin を持つページは再生されます。そして iframe の host は実在する YouTube の host でなければなりません。5.x の `origin` パラメーターにアプリ ID を入れると、修正にはならず、何も表示されない無言のプレーヤーになるのはこのためです。

## 修正 1: youtube_player_iframe 6.0.2 にアップグレードし、origin にアプリ ID を設定する

これが推奨される修正です。6.0.0 の新しい最小要件である Flutter 3.38 以降と Dart 3.10 以降が必要です。

```yaml
# pubspec.yaml, Flutter 3.38+ (tested on 3.44.8)
dependencies:
  youtube_player_iframe: ^6.0.2
```

```dart
// youtube_player_iframe 6.0.2, Flutter 3.44.8
final controller = YoutubePlayerController.fromVideoId(
  videoId: 'M7lc1UVf-VE',
  autoPlay: false,
  params: const YoutubePlayerParams(
    // Your Android applicationId / iOS bundle identifier, as an https URL.
    origin: 'https://com.yourcompany.yourapp',
    showFullscreenButton: true,
  ),
);
```

`origin` を設定すると、6.0.2 はそれを `loadHtmlString` のベース URL として、また `origin` と `widget_referrer` のプレーヤー変数として使い、iframe は引き続き `youtube-nocookie.com` から (`privacyEnhancedMode` をオフにした場合は `youtube.com` から) 読み込まれます。これは上の表の "アプリ ID + nocookie host" の行にあたり、YouTube がドキュメント化している `https://<app-id>` の形式に一致します。また、6.0.0 がこの origin と host の分離を取り入れる前に、まさにそれを提案した [PR #1126](https://github.com/sarbagyastha/youtube_player_flutter/pull/1126) でコントリビューターたちがたどり着いた方法でもあります。

`origin` を設定しなくても 6.0.2 は動作します。ページの origin は `https://www.youtube-nocookie.com` にフォールバックします (表の "6.0.x のデフォルト" の行)。それでもアプリ ID を設定するほうが望ましいです。YouTube の規約が求めているのはそれであり、YouTube が今後も `youtube-nocookie.com` を許容される埋め込み元として扱い続けることに依存しないからです。

5.x からのアップグレードでは、すぐに直面する破壊的変更が 1 つあります。`YoutubePlayerScaffold` が削除されました。代わりに、フルスクリーンを自分で処理するようになった `YoutubePlayer` を使います。

```dart
// youtube_player_iframe 6.0.2 (was YoutubePlayerScaffold in 5.x)
@override
Widget build(BuildContext context) {
  return Scaffold(
    body: YoutubePlayer(
      controller: controller,
      aspectRatio: 16 / 9,
    ),
  );
}
```

6.0.1 では `modestbranding` パラメーターも削除されたため、渡している場合は削除してください。

## 修正 2: 5.x から移行できない場合は youtube-nocookie を origin に使う

まだ Flutter 3.38 に移行できない場合、`youtube_player_iframe` 5.2.2 (Flutter 3.24+) は 1 行の変更で修正できます。これは [#1112](https://github.com/sarbagyastha/youtube_player_flutter/issues/1112) と [#1155](https://github.com/sarbagyastha/youtube_player_flutter/issues/1155) で複数の人が確認しています。

```dart
// youtube_player_iframe 5.2.2, Flutter 3.24+
final controller = YoutubePlayerController(
  params: const YoutubePlayerParams(
    origin: 'https://www.youtube-nocookie.com',
  ),
);
```

5.x ではこの 1 つの値がページの origin、iframe の host、プレーヤー変数を同時に兼ねます。これは表の "5.x の回避策" の行にあたり、実在する YouTube の host であり、かつ `youtube.com` ではないページ origin になります。5.x ではここにアプリ ID を入れないでください。iframe の host にもなってしまい、プレーヤーが読み込まれなくなります。

## 修正 3: 独自の WebView ではページにベース URL を与える

パッケージを使わず `webview_flutter` や `flutter_inappwebview` で YouTube を自分で埋め込んでいる場合も、ルールは同じです。ローカル HTML を読み込むときは必ずベース URL を渡し、それをアプリ ID にします。

```dart
// webview_flutter 4.14.1
await controller.loadHtmlString(
  html,
  baseUrl: 'https://com.yourcompany.yourapp', // never omit: null gives Error 153
);
```

ローカル HTML ではなく埋め込み URL を直接読み込む場合は、ヘッダーを自分で追加します。`loadRequest` はどちらのプラットフォームでもヘッダーを受け取れます。これは YouTube のドキュメントが説明している `loadUrl(url, additionalHttpHeaders)` / `loadRequest:` の方法にあたります。

```dart
// webview_flutter 4.14.1
await controller.loadRequest(
  Uri.parse('https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?playsinline=1'),
  headers: const {'Referer': 'https://com.yourcompany.yourapp/'},
);
```

`youtube_player_flutter` が内部で使っている `flutter_inappwebview` でも同じです。`loadData` に `baseUrl: WebUri('https://com.yourcompany.yourapp')` を渡してください。[#1150](https://github.com/sarbagyastha/youtube_player_flutter/issues/1150) は、そのパッケージにおけるこのエラーの Windows (WebView2) 版です。

## 注意点と紛らわしいエラー

**エラーハンドラーが 152 や 153 を正しく認識しない場合があります。** `youtube_player_iframe` 6.0.2 は生のコードを `YoutubeError.fromCode` でマッピングしますが、これは `152` (`sameAsNotEmbeddable2`) は知っていても `153` は知らないため、153 は `YoutubeError.unknown` として届きます。5.2.2 では 152 と 153 の両方が `unknown` にマッピングされます。enum に基づいて "この動画は埋め込めません" というメッセージを表示していると、誤った内容を表示することになります。この問題をデバッグしている間は生のコードをログに出力してください。

**6.x で `privacyEnhancedMode` をオフにすると 152 が再発します**。ただし `origin` も設定している場合は別です。`privacyEnhancedMode: false` で `origin` がないと、ベース URL は `https://www.youtube.com` にフォールバックし、表の 2 行目と同じ状態になります。`origin` をアプリ ID に設定すれば、youtube.com の host でも問題なく再生されます。

**Error 150 と 101 は別の問題です。** これらは所有者がその動画の埋め込みを無効にしていることを意味します。origin や Referer を変更しても修正できません。代わりに `url_launcher` で YouTube アプリで動画を開いてください。

2025 年 9 月の **"This video is unavailable, Error code: 15"** ([#1112](https://github.com/sarbagyastha/youtube_player_flutter/issues/1112)、[#1125](https://github.com/sarbagyastha/youtube_player_flutter/issues/1125)) は、5.x における同じ系統の識別チェックであり、同じ origin の修正で解決します。

**Flutter web は事情が異なります。** web ではパッケージは `origin` を無視し、サイトの実際の origin である `Uri.base.origin` を使います。ブラウザーが自分で `Referer` を送信するためです。web で 153 が出る場合、ほぼ確実にサーバーが `Referrer-Policy: no-referrer` か `same-origin` を送信しており、クロスオリジンの iframe リクエストからヘッダーが削除されています。YouTube が推奨するとおり `strict-origin-when-cross-origin` に切り替えるか、`web/index.html` に `<meta name="referrer" content="strict-origin-when-cross-origin">` を追加してください。Simon Willison も Django のデフォルトである `same-origin` で同じ問題に遭遇し、[記事にまとめています](https://til.simonwillison.net/youtube/fixing-153-embed)。Flutter web のビルドを強いキャッシュの背後で配信している場合は、新しい `index.html` が実際にユーザーに届くことも確認してください。[リロード後に古いキャッシュ済みビルドが配信される問題](/ja/2026/09/fix-flutter-web-serves-a-stale-cached-build-after-reload/) はそれ自体が落とし穴です。

**ナビゲーションデリゲートが修正を打ち消すことがあります。** プレーヤーを独自の `NavigationDelegate` で包み、自分のドメイン以外へのナビゲーションをすべて阻止していると、埋め込み自身のフレームまでブロックしてしまう可能性があります。YouTube の host を明示的に許可してください。[Flutter の WebView が外部 URL に遷移するのをブロックする方法](/ja/2026/09/how-to-block-a-flutter-webview-from-navigating-to-external-urls/) の host マッチングの手法は、`www.youtube.com`、`www.youtube-nocookie.com`、`m.youtube.com` の許可リストで機能します。

**動画の URL を起動するのは別のバグです。** [flutter/flutter#178705](https://github.com/flutter/flutter/issues/178705) は、`launchUrl` でリンクを開いたときに 153 が出ると報告していますが、これはアプリから完全に離れる操作です。この issue は invalid としてクローズされており、対象はデバイス上のブラウザーや YouTube アプリであって、あなたの WebView ではありません。

## 関連記事

- [Flutter の WebView が外部 URL に遷移するのをブロックする方法](/ja/2026/09/how-to-block-a-flutter-webview-from-navigating-to-external-urls/) では、`webview_flutter` 4.14.1 での `NavigationDelegate` の host マッチングを扱っています。
- [システムのフォントスケーリング使用時に Android WebView で Flutter の Text が画面外に描画される問題の修正](/ja/2026/09/fix-flutter-text-renders-off-screen-in-an-android-webview-with-font-scaling/) も、パラメーター 1 つで直る WebView 埋め込みのバグです。
- [リロード後に Flutter web が古いキャッシュ済みビルドを配信する問題の修正](/ja/2026/09/fix-flutter-web-serves-a-stale-cached-build-after-reload/) は、上記の web の `index.html` の変更をリリースする場合に重要です。
- [Flutter 3.44 で Material と Cupertino が SDK から分離](/ja/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/) は、`youtube_player_iframe` 6.x が必要とする Flutter 3.38+ へのアップグレード前に読んでおく価値があります。

## 出典

- [YouTube API Services: Required Minimum Functionality、API クライアントの識別と Referer の形式](https://developers.google.com/youtube/terms/required-minimum-functionality)
- [YouTube IFrame Player API リファレンス、onError のコード](https://developers.google.com/youtube/iframe_api_reference)
- [youtube_player_iframe の changelog (5.2.2、6.0.0、6.0.1、6.0.2)](https://pub.dev/packages/youtube_player_iframe/changelog)
- [sarbagyastha/youtube_player_flutter#1155: 5.2.1 での Error 152-4、6.0.0 で修正](https://github.com/sarbagyastha/youtube_player_flutter/issues/1155)
- [sarbagyastha/youtube_player_flutter#1124: Error code 153](https://github.com/sarbagyastha/youtube_player_flutter/issues/1124)
- [sarbagyastha/youtube_player_flutter#1112: Error code 15 と youtube-nocookie の origin による回避策](https://github.com/sarbagyastha/youtube_player_flutter/issues/1112)
- [sarbagyastha/youtube_player_flutter#1126: origin を host とは別に送信する](https://github.com/sarbagyastha/youtube_player_flutter/pull/1126)
- [Simon Willison: YouTube 埋め込みでの Error 153 Video player configuration error](https://til.simonwillison.net/youtube/fixing-153-embed)
