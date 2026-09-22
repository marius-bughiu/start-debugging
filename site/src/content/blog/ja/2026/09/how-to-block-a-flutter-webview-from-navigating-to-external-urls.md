---
title: "NavigationDelegate で Flutter の WebView が外部 URL へ遷移するのをブロックする方法"
description: "webview_flutter 4.14.1 で Flutter の WebView を自分のドメインに留める方法です。URL をパースし、startsWith ではなく Uri.host を比較し、mailto: と tel: は url_launcher に渡し、Android と iOS が onNavigationRequest に実際に何を送るのかを把握します。"
pubDate: 2026-09-22
template: how-to
tags:
  - "flutter"
  - "dart"
  - "webview"
  - "security"
  - "android"
  - "ios"
lang: "ja"
translationOf: "2026/09/how-to-block-a-flutter-webview-from-navigating-to-external-urls"
translatedBy: "claude"
translationDate: 2026-09-22
---

**要点:** Flutter 3.44 上の `webview_flutter` 4.14.1 では、`WebViewController` に `NavigationDelegate` を設定し、その `onNavigationRequest` で `request.url` を `Uri.tryParse` でパースします。`uri.scheme == 'https'` かつ `uri.host` が許可リストに含まれる場合にだけ `NavigationDecision.navigate` を返し、それ以外はすべて `NavigationDecision.prevent` を返します。必要であれば、ブロックしたリンクを `url_launcher` でシステムのブラウザーで開きます。`url.startsWith('https://example.com')` は使わないでください。これでは `https://example.com.evil.net` や `https://example.com@evil.net` が通ってしまいます。また限界も知っておく必要があります。Android では、サブフレームの遷移や POST のフォーム送信はこのコールバックに一切届きません。

この記事の残りでは、このポリシーを段階的に組み立て、素朴なチェックが誤っていることを示すテスト表を紹介し、コールバックで何をブロックでき何をブロックできないかを決めるプラットフォームごとの違いを解説します。以下の内容はすべて、Flutter 3.44.8 / Dart 3.12.2 上で `webview_flutter` 4.14.1、`webview_flutter_android` 4.14.1、`webview_flutter_wkwebview` 3.26.1、`url_launcher` 6.3.2 を使ってコンパイルとテストを行っています。

## WebView がサイトの外へさまよい出る理由

埋め込みのヘルプセンター、決済ページ、利用規約の画面は、たいてい 1 つのサイトだけを表示するためのものです。しかしページ側はそれを知りません。フッターには Twitter へのリンクがあり、"powered by" のバッジ、OAuth のボタン、`mailto:` のサポート用アドレス、さらには任意のリンクを含むユーザー投稿コンテンツがあるかもしれません。そのどれかをタップすると、WebView はそれをアプリ内でそのまま読み込みます。アドレスバーはなく、自分で作らない限り戻るボタンもなく、画面上部にはアプリの名前が表示されたままです。これは UX の問題 (ユーザーがサードパーティのサイトで立ち往生する) であり、信頼の問題 (アプリ内に表示されたフィッシングページがアプリの信用をそのまま引き継ぐ) でもあります。

`webview_flutter` はこのためのフックを 1 つだけ公開しています。`NavigationDelegate.onNavigationRequest` です。4.14.1 でのシグネチャは次のとおりです。

```dart
// webview_flutter 4.14.1
FutureOr<NavigationDecision> Function(NavigationRequest request)? onNavigationRequest
```

`NavigationRequest` が持つフィールドはちょうど 2 つ、`url` (`String`) と `isMainFrame` (`bool`) で、`NavigationDecision` の値は `navigate` と `prevent` の 2 つです。それ以外はすべて自分で実装します。

## README の例こそがバグ

公式パッケージの README には次のスニペットが載っています。

```dart
// From the webview_flutter 4.14.1 README
onNavigationRequest: (NavigationRequest request) {
  if (request.url.startsWith('https://www.youtube.com/')) {
    return NavigationDecision.prevent;
  }
  return NavigationDecision.navigate;
},
```

拒否リストのデモとしては問題ありません。しかし多くの人がやるように許可リストへ反転させると、`if (request.url.startsWith('https://example.com')) navigate else prevent` になります。URL は文字列のプレフィックスで判断できるものではありません。16 個の URL を、素朴なプレフィックスチェックと後で組み立てるポリシークラスの両方に通してみました。

```text
URL                                                  naive     policy
https://example.com/pricing                          internal  allowInWebView
https://help.example.com/articles/42                 external  allowInWebView
https://EXAMPLE.com/Pricing                          external  allowInWebView
https://example.com:8443/admin                       internal  allowInWebView
https://example.com.evil.net/login                   internal  openExternally
https://example.com@evil.net/login                   internal  openExternally
https://notexample.com/                              external  openExternally
https://evil.net/?next=https://example.com           external  openExternally
http://example.com/                                  external  openExternally
mailto:support@example.com                           external  openExternally
tel:+15550100                                        external  openExternally
about:blank                                          external  allowInWebView
about:srcdoc                                         external  block
javascript:alert(1)                                  external  block
intent://scan/#Intent;scheme=zxing;end               external  block
file:///data/data/com.example/shared_prefs/x.xml     external  block
```

危険なのは 2 行です。`https://example.com.evil.net/login` は、`evil.net` を登録した人が所有するホストです。`https://example.com@evil.net/login` は `example.com` を URL の userinfo 部分に置いているので、ブラウザーは `evil.net` に接続します。どちらもプレフィックスチェックを通過し、アプリ内に表示されます。その他の不一致は偽陰性です。大文字のホストやサブドメインが、理由もなく WebView から追い出されます。

解決策は、パースを `Uri` に任せることです。`Uri.parse('https://EXAMPLE.com@evil.net:8443/x').host` は `evil.net` を返します。小文字化され、userinfo とポートは取り除かれています。生の文字列ではなく、必ずこちらを比較してください。

## 許可リストのポリシーを組み立てる

判定ロジックは、Flutter やプラグインを import しない素の Dart クラスに置きます。こうすると `flutter test` で単体テストができます。ウィジェットテストでは本物の WebView を動かせないので、これは重要です。

```dart
// Flutter 3.44, Dart 3.12, webview_flutter 4.14.1
enum LinkAction { allowInWebView, openExternally, block }

class LinkPolicy {
  const LinkPolicy({
    required this.allowedHosts,
    this.allowSubdomains = true,
    this.externalSchemes = const {'mailto', 'tel', 'sms'},
  });

  /// Hosts that may load inside the WebView, lower case, no scheme, no port.
  final Set<String> allowedHosts;
  final bool allowSubdomains;

  /// Schemes handed to the OS instead of the WebView.
  final Set<String> externalSchemes;

  LinkAction decide(String url) {
    final uri = Uri.tryParse(url);
    if (uri == null) return LinkAction.block;

    switch (uri.scheme) {
      case 'https':
        return _isAllowedHost(uri.host)
            ? LinkAction.allowInWebView
            : LinkAction.openExternally;
      case 'http':
        // Never load cleartext in-app, even for your own host.
        return LinkAction.openExternally;
      case 'about':
        return url == 'about:blank'
            ? LinkAction.allowInWebView
            : LinkAction.block;
      default:
        return externalSchemes.contains(uri.scheme)
            ? LinkAction.openExternally
            : LinkAction.block; // javascript:, file:, intent:, data:, ...
    }
  }

  bool _isAllowedHost(String host) {
    // Uri.host is already lower case and has userinfo and port stripped.
    if (allowedHosts.contains(host)) return true;
    if (!allowSubdomains) return false;
    return allowedHosts.any((allowed) => host.endsWith('.$allowed'));
  }
}
```

ここでのいくつかの選択は意図的なものです。

- **結果は 2 つではなく 3 つ。** `NavigationDecision` は二値ですが、"WebView では開かない" は "別の場所で開く" と "捨てる" に分かれます。自社の Twitter ページへのリンクはブラウザーで開くべきです。`javascript:` や `file:` の URL はどこにも行かせるべきではありません。
- **サブドメインのチェックには先頭にドットを付けた `'.$allowed'` を使います。** `host.endsWith('example.com')` だと `notexample.com` を受け入れてしまい、プレフィックスチェックと同じ種類のバグになります。
- **`http` はアプリ内では決して許可しません。** 自分のサイトがまだ `http` のリンクを出していても、TLS なしで読み込むのではなくアプリの外に出ます。本当に必要な場合にだけ変更してください。なお Android は API 28 以降、ネットワークセキュリティ構成で許可しない限り、いずれにせよ平文通信をデフォルトでブロックします。
- **`about:blank` は許可します。** iOS では、`baseUrl` なしの `loadHtmlString` と、新しく開かれた空のフレームの両方が `about:blank` として現れます。これをブロックすると、そうしたフローが壊れます。
- **未知のスキームは起動せずブロックします。** Android の `intent://` は、デバイス上でエクスポートされた任意のアクティビティを対象にできます。特定のカスタムスキーム (自前の `myapp://` や `market://`) が必要なら、`externalSchemes` に明示的に追加してください。

上の表は、次のテストファイルの出力です。`flutter test` で約 1 秒で実行できます。

```dart
// Flutter 3.44, Dart 3.12
import 'package:flutter_test/flutter_test.dart';
import 'package:wvguard/link_policy.dart';

void main() {
  const policy = LinkPolicy(allowedHosts: {'example.com'});

  final cases = <String, LinkAction>{
    'https://help.example.com/articles/42': LinkAction.allowInWebView,
    'https://EXAMPLE.com/Pricing': LinkAction.allowInWebView,
    'https://example.com.evil.net/login': LinkAction.openExternally,
    'https://example.com@evil.net/login': LinkAction.openExternally,
    'https://notexample.com/': LinkAction.openExternally,
    'http://example.com/': LinkAction.openExternally,
    'mailto:support@example.com': LinkAction.openExternally,
    'javascript:alert(1)': LinkAction.block,
    'intent://scan/#Intent;scheme=zxing;end': LinkAction.block,
  };

  for (final entry in cases.entries) {
    test(entry.key, () => expect(policy.decide(entry.key), entry.value));
  }
}
```

## ポリシーを NavigationDelegate に組み込む

手順は次の順番です。

1. パッケージを追加します: `flutter pub add webview_flutter url_launcher`。`webview_flutter` 4.14.1 には Flutter 3.38 以降、Android SDK 24+、iOS 13+ が必要です。
2. `WebViewController` は `build` ではなく `initState` で一度だけ作成します。
3. 各 `LinkAction` を `NavigationDecision` に対応付ける `onNavigationRequest` を指定して `setNavigationDelegate` を呼び出します。
4. `openExternally` の場合は、`LaunchMode.externalApplication` を指定して `launchUrl` を発行し、すぐに `prevent` を返します。
5. デリゲートを設定し終えてから、最後に `loadRequest` を呼び出します。

```dart
// Flutter 3.44, Dart 3.12, webview_flutter 4.14.1, url_launcher 6.3.2
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';

import 'link_policy.dart';

class HelpCenterPage extends StatefulWidget {
  const HelpCenterPage({super.key});

  @override
  State<HelpCenterPage> createState() => _HelpCenterPageState();
}

class _HelpCenterPageState extends State<HelpCenterPage> {
  static final Uri _home = Uri.parse('https://help.example.com/');
  static const LinkPolicy _policy = LinkPolicy(allowedHosts: {'example.com'});

  late final WebViewController _controller;

  @override
  void initState() {
    super.initState();
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setNavigationDelegate(
        NavigationDelegate(onNavigationRequest: _onNavigationRequest),
      )
      ..loadRequest(_home);
  }

  NavigationDecision _onNavigationRequest(NavigationRequest request) {
    // Android never asks about subframes; iOS does. Leave iframes alone here.
    if (!request.isMainFrame) return NavigationDecision.navigate;

    switch (_policy.decide(request.url)) {
      case LinkAction.allowInWebView:
        return NavigationDecision.navigate;
      case LinkAction.openExternally:
        unawaited(_openExternally(Uri.parse(request.url)));
        return NavigationDecision.prevent;
      case LinkAction.block:
        debugPrint('Blocked navigation to ${request.url}');
        return NavigationDecision.prevent;
    }
  }

  Future<void> _openExternally(Uri uri) async {
    final opened = await launchUrl(uri, mode: LaunchMode.externalApplication);
    if (!opened && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('No app can open $uri')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Help')),
      body: WebViewWidget(controller: _controller),
    );
  }
}
```

このファイルに対して `flutter analyze` は問題を報告しません。ここで取り上げておきたい細部が 2 つあります。

コールバックは同期的に値を返します。`onNavigationRequest` は `Future<NavigationDecision>` も受け付けますが、iOS ではプラグインが WebKit の `decidePolicyForNavigationAction` の中でコールバックを `await` するため、そこで費やした 1 ミリ秒ごとにページが固まります。`launchUrl` を待機する (OS がアプリを切り替えるのを待つ) のは、そこでは最もやってはいけないことです。同期的に判定して値を返し、起動は `unawaited` でバックグラウンドに回してください。

`await launchUrl` の後の `mounted` チェックは、OS が応答するまでにユーザーがページを閉じている可能性があるために入れています。このパターンに馴染みがなければ、[await の後で BuildContext を安全に使う方法](/ja/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) で詳しく解説しています。

## Android と iOS が onNavigationRequest に実際に送るもの

ここはドキュメントが "some platforms may also trigger this callback from calls to `loadRequest`" という一文で済ませている部分です。`webview_flutter_android` 4.14.1 と `webview_flutter_wkwebview` 3.26.1 のプラットフォーム実装を読んだところ、両者の挙動は大きく異なっていました。

### Android: ネイティブ側が先にキャンセルし、Dart が再発行する

Android では、コールバックは `WebViewClient.shouldOverrideUrlLoading` によって駆動されます。`onNavigationRequest` を設定すると、プラグインは `setSynchronousReturnValueForShouldOverrideUrlLoading(true)` を呼び出します。それ以降、ネイティブの `WebViewClientProxyApi` はすべての遷移に対して `request.isForMainFrame() && true` を返します。つまりメインフレームの遷移はすべて、Dart に問い合わせる前に即座にキャンセルされます。その後 Dart がコールバックを実行し、`navigate` が返されると、プラグインは同じ URL と元のリクエストヘッダーで `loadUrl` を呼び出します。

その結果、次のようになります。

- **サブフレームについては一切問い合わせがありません。** `loadUrl` は iframe に URL を読み込めないため、`isForMainFrame` が false のとき `_handleNavigation` は早期リターンします。ページ上の iframe はどこへでも遷移でき、コールバックは実行されません。上のコードが `isMainFrame == false` をわざわざ取り締まらないのはこのためです。
- **POST による遷移はコールバックを迂回します。** Android 自身のドキュメントに、`shouldOverrideUrlLoading` は POST リクエストでは呼ばれないと書かれています。許可したページ上の `<form method="post" action="https://evil.net/collect">` は送信され、WebView に `evil.net` を読み込みます。
- **`loadRequest` はチェックされません。** コントローラー経由で自分で読み込む URL は `shouldOverrideUrlLoading` を通りません。
- **戻る、進む、再読み込みはチェックされません。** これらは新しい遷移ではなく履歴の操作です。
- **ダウンロードは同じコールバックを経由します。** プラグインの `DownloadListener` はダウンロード URL に対して `_handleNavigation` を呼び出すので、許可リストは他のホストからのダウンロードも止めます。

### iOS と macOS: WebKit は応答を待つ

WebKit では、コールバックは `WKNavigationDelegate.webView(_:decidePolicyFor:decisionHandler:)` によって駆動されます。プラグインはコールバックを待機し、`navigate` を `.allow` に、`prevent` を `.cancel` に対応付けます。再発行は行われないので、POST のボディとヘッダーはそのまま保たれます。

その結果、次のようになります。

- **最初の `loadRequest` もコールバックに届きます。** `initState` で読み込む URL が許可リストに含まれていないと、エラーなしで空白ページになります。ポリシーにある `about:blank` のルールは、`loadHtmlString` を使う場合の同じ理由によるものです。
- **サブフレームについても問い合わせがあります。** 埋め込みの YouTube プレーヤー、Stripe elements、reCAPTCHA を含むすべての iframe の読み込みが `isMainFrame: false` で届きます。これをメインフレームの遷移と同じように扱うと、ページ上のすべての埋め込みが壊れます。
- **`target="_blank"` のリンクは 2 回届きます。** 新しいウィンドウのリクエストは最初はターゲットフレームが null なので、`isMainFrame` は `false` です。その後、プラグインの `WKUIDelegate` の `onCreateWebView` がそのリクエストを同じ WebView に読み込み、それがメインフレームの遷移としてコールバックに戻ってきます。ポリシーが適用されるのは 2 回目の呼び出しなので、これも `isMainFrame == false` を通過させるもう 1 つの理由です。

両プラットフォームで一貫して iframe を取り締まる必要があるなら、ナビゲーションデリゲートは適切な道具ではありません。自分のサーバーから `frame-src` を含む `Content-Security-Policy` ヘッダーを送ってください。両方の WebView がこれを適用します。

## トラフィックが許可リストをすり抜ける落とし穴

ナビゲーションデリゲートが制御するのはページの遷移です。次のものは見えません。

- **サブリソース。** 他のホストへの画像、スクリプト、`fetch` や `XMLHttpRequest` の呼び出しは通常どおり読み込まれます。`onNavigationRequest` はファイアウォールではありません。許可したページで攻撃者のスクリプトを実行させられるなら、そのスクリプトは `fetch` でデータを持ち出せ、コールバックは一度も発火しません。WebView ではなくページ側を修正してください (CSP の `connect-src`)。
- **シングルページアプリのルート変更。** `history.pushState` は遷移なしで URL を変更します。追跡が必要なら `onUrlChange` をリッスンしてください。これはブロックできませんが、オリジンを変えることもできないので、抜け道にはなりません。
- **Android での POST。** 上で説明したとおりです。埋め込みサイトでユーザーがフォームを送信できるなら、`action` の URL をサーバー側で検証してください。
- **リダイレクトの連鎖。** 許可された URL から別のホストへのサーバーリダイレクトは、Android では `shouldOverrideUrlLoading` に (`WebResourceRequest.isRedirect()` のケースとして)、WebKit ではナビゲーションポリシーのチェックに報告されるので、許可リストは引き続き適用されます。それでも実際のログインフローでテストしてください。OAuth プロバイダーは 4 段階のリダイレクトが大好きです。

実際にハマりやすいものがさらに 3 つあります。

- **OAuth と SSO。** サイトが `accounts.google.com` や Entra ID テナント経由でユーザーをサインインさせる場合、それらのホストを許可リストに入れないと、フローがブラウザーへ飛び出して二度と戻ってきません。さらに Google は埋め込み WebView ではサインインページの表示自体を拒否するので、Google サインインの本当の解決策は許可リストを長くすることではなく、`flutter_web_auth_2` やネイティブ SDK です。
- **Android の `intent://` リンク。** アプリへディープリンクするサイトは `intent://...#Intent;...;end` 形式の URL を使います。Chrome はこれを理解しますが、`url_launcher` は intent の構文をパースしません。ポリシーのようにブロックするのが安全なデフォルトです。必要なら `S.browser_fallback_url` パラメーターをパースして、代わりにそちらを開いてください。
- **国際化ドメイン名。** Dart の `Uri` は IDNA 変換を行いません。`Uri.parse('https://bücher.example/x').host` は `b%C3%BCcher.example` になり、`https://xn--bcher-kva.example/x` は `xn--bcher-kva.example` のままです。WebView は一般に punycode 形式を報告するので、許可リストには `xn--` の表記を入れてください。

WebView が通常のサイトではなく自分の Flutter web ビルドを表示しているなら、アプリ内のルーティングは WebView ではなくルーターが担っており、[go_router でネストしたルートとディープリンクを設定する方法](/ja/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/) のほうが関連の深い記事です。その埋め込み Flutter web ビルド内のフォントスケーリングは別の落とし穴で、[Android の WebView で Flutter の Text が画面外に描画される問題](/ja/2026/09/fix-flutter-text-renders-off-screen-in-an-android-webview-with-font-scaling/) にまとめています。

## 非同期の判定はプラットフォームごとに挙動が異なる

Android は先にキャンセルして後から再発行するため、Android の `async` コールバックはページを決してブロックしません。`Future` が完了してプラグインが `loadUrl` を呼び出すまで、古いページは完全に操作可能な状態で画面に残ります。その間にユーザーが 2 つ目のリンクをタップすると、両方の判定が実行され、最後に実行された `loadUrl` が勝ちます。iOS では同じ `async` コールバックが WebKit の decision handler を開いたままにするので、ページは待たされます。ポリシーが本当に I/O を必要とする場合 (たとえばリモートの許可リストを取得する場合) は、ページを開く前に一度だけ読み込み、上の例のように `onNavigationRequest` を同期的に保ってください。そうすれば両プラットフォームで同じ挙動になります。

`shouldInterceptRequest` によるサブリソースリクエストの横取りのように、クロスプラットフォーム API が公開していない制御が必要な場合、4.14.1 にはそのための Dart のフックはありません。ネイティブコードが必要になり、[プラグインなしで Flutter にプラットフォーム固有のコードを追加する方法](/ja/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) のアプローチが使えます。まずは許可リストを試してください。埋め込みページの大多数はそれで十分です。

最後に、許可リストを含め、アプリのバイナリに同梱したものはすべて、APK や IPA を展開すれば誰でも読めることを忘れないでください。ホスト名のリストならそれで問題ありませんが、[攻撃者が Flutter アプリから何を抽出できるか](/ja/2026/01/flutterguard-cli-a-fast-what-can-an-attacker-extract-check-for-flutter-3-x-apps/) を思い出すよいきっかけになります。許可リストはユーザーがさまよい出るのを防ぐためのものであり、秘密ではありません。

## 参考資料

- [pub.dev の webview_flutter 4.14.1](https://pub.dev/packages/webview_flutter)。README の `onNavigationRequest` の例とプラットフォーム対応表を含みます。
- [`NavigationDelegate` API リファレンス](https://pub.dev/documentation/webview_flutter/latest/webview_flutter/NavigationDelegate-class.html)。
- [webview_flutter_android のソース](https://github.com/flutter/packages/tree/main/packages/webview_flutter/webview_flutter_android): `android_webview_controller.dart` (`_handleNavigation`) と `WebViewClientProxyApi.java` (`shouldOverrideUrlLoading`)。
- [webview_flutter_wkwebview のソース](https://github.com/flutter/packages/tree/main/packages/webview_flutter/webview_flutter_wkwebview): `webkit_webview_controller.dart` (`decidePolicyForNavigationAction`、`onCreateWebView`)。
- [Android `WebViewClient.shouldOverrideUrlLoading`](https://developer.android.com/reference/android/webkit/WebViewClient#shouldOverrideUrlLoading(android.webkit.WebView,%20android.webkit.WebResourceRequest))。
- [Apple `webView(_:decidePolicyFor:decisionHandler:)`](https://developer.apple.com/documentation/webkit/wknavigationdelegate/webview(_:decidepolicyfor:decisionhandler:)-2ni62)。
- [pub.dev の url_launcher 6.3.2](https://pub.dev/packages/url_launcher) と [`LaunchMode`](https://pub.dev/documentation/url_launcher/latest/url_launcher/LaunchMode.html)。
- [Dart `Uri.host`](https://api.dart.dev/stable/dart-core/Uri/host.html)。
