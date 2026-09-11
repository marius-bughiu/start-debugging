---
title: "解決: ブラウザのタブをリロードしても Flutter web が古いキャッシュ済みビルドを返す"
description: "リロードで再検証されるのは index.html だけなので、ハッシュの付かない main.dart.js はブラウザキャッシュから読み込まれ続けます。Flutter のビルド出力には Cache-Control: no-cache を付け、ヘッダーを設定できないホストではビルド ID を埋め込み、3.41 より前のキャッシュは自己削除型の service worker に片付けさせます。"
pubDate: 2026-09-11
template: how-to
tags:
  - "flutter"
  - "flutter-web"
  - "deployment"
  - "caching"
  - "how-to"
lang: "ja"
translationOf: "2026/09/fix-flutter-web-serves-a-stale-cached-build-after-reload"
translatedBy: "claude"
translationDate: 2026-09-11
---

**結論:** Flutter web はエントリーポイントを固定のファイル名 (`flutter_bootstrap.js`、`main.dart.js`、`main.dart.wasm`、`canvaskit/...`) で出力し、ブラウザの通常のリロードで再検証されるのは HTML ドキュメントだけです。ホストがこれらのファイルに何らかの鮮度の有効期間を付けていると (Firebase Hosting は `max-age=3600`、GitHub Pages は `max-age=600` を送ります)、リロードしたページは新しい `index.html` とキャッシュされた古い `main.dart.js` の組み合わせになります。対処法は、`build/web` フォルダー全体を `Cache-Control: no-cache` で配信することです。ヘッダーを設定できないホストでは、`flutter build web` の後に `flutter_bootstrap.js` と `main.dart.js` へビルド ID を埋め込みます。Flutter 3.38 以前のオフラインファースト service worker をまだ持っているユーザーがいるなら、デフォルトの `flutter_service_worker.js` をデプロイし続けてください。Flutter 3.41 以降、これは古い worker の登録を解除してタブをリロードする自己削除型の worker になっています。

以下の内容はすべて Flutter 3.44.8 (Dart 3.12.2) で再現し、3.47.3 のツールとエンジンのソースでも確認しました。この問題に関しては両者の挙動は同じです。ブラウザでのテストは、`Cache-Control` のポリシーを切り替えられる小さな Node サーバーに対して Chromium ベースのブラウザで実行しました。

## 最初にリリースした時期によって異なる 2 種類のキャッシュ

この問題の検索結果には 2 つの時代の情報が混在しており、対処法も異なります。

- **Flutter 3.38.x 以前** はオフラインファーストの service worker を生成していました。この worker は `RESOURCES` マップに列挙されたすべてのファイルを Cache Storage から直接返し、`index.html` だけをオンライン優先で取得し、新しいデプロイが反映されるまでに 2 回目の読み込みを必要としました。定番の「2 回リロードしないといけない」というアドバイスはここから来ています。
- **Flutter 3.41.0 以降** は、新しい訪問者に対してキャッシュ用の service worker をインストールしなくなりました。[PR #176834](https://github.com/flutter/flutter/pull/176834) (2025 年 10 月にマージ、最初の stable は 3.41.0) で 6 KB の worker が 784 バイトのクリーンアップ用 worker に置き換えられ、`flutter.js` のローダーはオリジンにすでに登録がある場合にのみそれを登録します。3.41 以降で新規に作ったアプリでは、関係するキャッシュは通常の HTTP キャッシュだけで、この記事で主に扱うのもそれです。

どちらの状況かは、DevTools の Application、Service workers を開けば確認できます。登録がなければ、原因は HTTP キャッシュです。

## リロードで新しい main.dart.js が取得されない理由

3.44.8 で `flutter build web` が `build/web` に出力するものを見てみましょう。

```text
# flutter build web, Flutter 3.44.8
index.html
flutter_bootstrap.js
flutter.js
flutter_service_worker.js
main.dart.js
version.json
manifest.json
assets/AssetManifest.bin
assets/FontManifest.json
assets/fonts/MaterialIcons-Regular.otf
canvaskit/canvaskit.js
canvaskit/canvaskit.wasm
```

どのファイル名にもコンテンツハッシュは含まれていません。`index.html` は `flutter_bootstrap.js` を読み込み、そこには `mainJsPath` がリテラル文字列 `"main.dart.js"` である `_flutter.buildConfig` が含まれています。どのデプロイでも同じ URL が使い回されるため、ブラウザは URL だけでは新しいビルドと古いビルドを区別できません。

これにリロードの仕組みが組み合わさります。Chrome のリロードはメインリソースを再検証し、その後は通常のページ読み込みを行います。Chromium チームの 2017 年の記事によると、ブラウザは "only validate the main resource and continue with a regular page load" という方式を選びました ([Chromium blog](https://blog.chromium.org/2017/01/reload-reloaded-faster-and-leaner-page_26.html))。`Cache-Control` 上まだ新鮮なサブリソースは、リクエストを送らずにディスクキャッシュから直接読み込まれます。通常のナビゲーション (ブックマーク、URL の直接入力、リンク) では、どのブラウザも `index.html` 自体を含めて新鮮なコピーを再利用します。

つまり、リロードで新しいビルドが表示されるかどうかは、ホストがこれらのファイルに何を送るかだけで決まります。

| ホスト | 静的ファイルに対するデフォルトの `Cache-Control` | デプロイ後に古いビルドが残る期間 |
| --- | --- | --- |
| Firebase Hosting | `max-age=3600` (`*.firebaseapp.com` で確認) | 最大 1 時間 |
| GitHub Pages | `max-age=600`、変更不可 | 最大 10 分 |
| Netlify, Vercel, Cloudflare Pages | `public, max-age=0, must-revalidate` | なし |
| 設定なしの Nginx, Apache, `python -m http.server` | ヘッダーなし、ただし `Last-Modified` は送信される | ヒューリスティック、後述 |

最後の行が落とし穴です。`Cache-Control` ヘッダーがないことは「キャッシュするな」という意味ではありません。`Last-Modified` ヘッダーがあれば、[RFC 9111 section 4.2.2](https://www.rfc-editor.org/rfc/rfc9111#section-4.2.2) によりブラウザはヒューリスティックな鮮度の有効期間を選べます。一般的には最終更新からの経過時間の 10% です。10 日前に最後にデプロイされた `main.dart.js` は、丸 1 日のあいだ新鮮なものとして扱われる可能性があります。

Firebase はデプロイのたびに CDN をパージするので、エッジはすぐに新しいファイルを返します。しかしブラウザ自身のキャッシュはパージされず、リロードで使われるのはそちらのコピーです。

## 最小限の再現手順

このサーバーは、切り替え可能なポリシーで `build/web` を配信します。`firebase` は Firebase Hosting のデフォルトを模倣し、`fixed` が修正版です。

```js
// server.mjs, Node 22. Usage: MODE=firebase node server.mjs build/web
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.wasm': 'application/wasm', '.json': 'application/json' };

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, p);
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  const stat = fs.statSync(file);
  const headers = {
    'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
    'ETag': `"${stat.size}-${stat.mtimeMs}"`,
    'Cache-Control': process.env.MODE === 'fixed' ? 'no-cache' : 'max-age=3600',
  };
  if (req.headers['if-none-match'] === headers.ETag) { res.writeHead(304, headers); return res.end(); }
  console.log(200, p);
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}).listen(8765);
```

そして、どのビルドが動いているかを表示するだけのアプリです。

```dart
// lib/main.dart, Flutter 3.44.8, Dart 3.12.2
import 'package:flutter/material.dart';

const build = 'A';

void main() => runApp(
  const MaterialApp(home: Scaffold(body: Center(child: Text('Build $build')))),
);
```

手順: `build = 'A'` でビルドし、`MODE=firebase` でサーバーを起動して `http://localhost:8765/` を開きます。定数を `'B'` に変更し、もう一度 `flutter build web` を実行してタブをリロードします。ページには "Build A" と表示されたままです。このリロードに対するサーバーログには、リクエストが 1 件だけ記録されています。

```text
200 /index.html
```

`flutter_bootstrap.js`、`main.dart.js`、CanvasKit、フォントはすべてブラウザキャッシュから読み込まれました。新しいオリジンで `MODE=fixed` にして同じ手順を繰り返すと、リロードで "Build B" が表示されます。新しいデプロイなしで 2 回目のリロードをすると、ファイルごとに条件付きリクエストが 1 回ずつ発生し、それぞれボディなしの `304` が返されます。

## 修正手順

1. **Flutter のビルド出力を `Cache-Control: no-cache` で配信します。** `no-cache` はキャッシュを無効にするものではありません。ブラウザにファイルを保持させつつ、使用するたびに `If-None-Match` または `If-Modified-Since` で再検証するよう指示します。変更のないファイルは往復 1 回と `304` で済み、変更されたファイルはダウンロードされます。対象は `index.html`、`flutter_bootstrap.js`、`flutter.js`、`flutter_service_worker.js`、`main.dart.js`、`main.dart.mjs`、`main.dart.wasm`、`version.json`、`manifest.json`、`assets/` 以下のすべて、そしてローカルの `canvaskit/` フォルダーです。最もシンプルで正しいルールは「`build/web` のすべて」です。
2. **ルールをホストの設定に書きます。** Firebase Hosting、Nginx、そして Netlify と Cloudflare Pages で使われる `_headers` ファイルの例を後述します。
3. **古い有効期間が切れるのを 1 回待ちます。** 新しいヘッダーは変更後に取得したレスポンスにしか適用されません。`max-age=3600` の下で `main.dart.js` をキャッシュしたブラウザは、その 1 時間が過ぎるまでそれを使い続けます。ヘッダーの変更は必要になる 1 デプロイ前に出しておくか、最初の展開ではビルド ID (手順 4) と組み合わせてください。
4. **ヘッダーを設定できない場合は、ビルド ID を埋め込みます。** よくあるのは GitHub Pages です。ビルドのたびにエントリーポイントの URL を書き換え、デプロイごとに新しい URL になるようにします。
5. **すでに開いているタブに知らせます。** ヘッダーが効くのは次の読み込みからです。長時間開いたままのタブはユーザーがリロードするまで古いビルドを実行し続けるので、小さなビルド ID ファイルをポーリングしてリロードを促します。

### Firebase Hosting

[Flutter web FAQ](https://docs.flutter.dev/platform-integration/web/faq) は、`js`、`mjs`、`wasm`、`json` に対して `max-age=0,s-maxage=604800` を推奨しています。これは CDN を温めたまま、ブラウザに再検証を強制する設定です。ただしこのパターンは HTML と `.bin` を対象外にしており、画像とフォントには `max-age=3600` を付けるため、`index.html`、`assets/AssetManifest.bin`、同じ名前で差し替えた画像は 1 時間古いまま残ります。次の `firebase.json` はビルド全体をカバーします。

```json
{
  "hosting": {
    "public": "build/web",
    "headers": [
      {
        "source": "**",
        "headers": [
          { "key": "Cache-Control", "value": "no-cache" }
        ]
      }
    ]
  }
}
```

Firebase はデプロイ時に CDN をパージするので、エッジを正しく保つために `s-maxage` は必要ありません。レイテンシの問題を実際に計測した場合にだけ戻してください。

### Nginx

```nginx
# nginx 1.27, serving the output of flutter build web
server {
    listen 80;
    root /var/www/app/build/web;

    location / {
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-cache" always;
        etag on;
    }
}
```

`etag on` (デフォルト) は維持してください。バリデーターがないとブラウザは再検証の手段を持たず、毎回ファイル全体をダウンロードします。

### Netlify と Cloudflare Pages

どちらもデフォルトで `max-age=0, must-revalidate` になっており、正しく動作します。以前の設定やフレームワークのプリセットがより長い有効期間を追加している場合は、`web/` に `_headers` ファイルを置いて上書きします。`flutter build web` がそれを `build/web` にコピーします。

```text
# web/_headers, copied to build/web by flutter build web (Flutter 3.44)
/*
  Cache-Control: no-cache
```

### GitHub Pages などヘッダーを設定できないホスト

ビルド後に小さなスクリプトを実行します。このスクリプトは bootstrap の script タグと `_flutter.buildConfig` 内のビルドパスに `?v=<id>` を付け加え、手順 5 のために ID を `build_id.txt` に書き出します。

```bash
#!/usr/bin/env bash
# bust.sh, run after `flutter build web` (Flutter 3.44 output layout)
set -euo pipefail
ID="${1:-$(git rev-parse --short HEAD 2>/dev/null || date +%s)}"
OUT=build/web
sed -i.bak "s|src=\"flutter_bootstrap.js\"|src=\"flutter_bootstrap.js?v=$ID\"|" "$OUT/index.html"
sed -i.bak -E "s#\"(main\.dart\.(js|wasm|mjs))\"#\"\1?v=$ID\"#g" "$OUT/flutter_bootstrap.js"
rm "$OUT"/*.bak
echo "$ID" > "$OUT/build_id.txt"
```

`max-age=600` のポリシーの下で ID を埋め込んだビルドをデプロイした後にリロードすると、リクエストされたのはちょうど 3 ファイル (`index.html`、`flutter_bootstrap.js?v=...`、`main.dart.js?v=...`) で、新しいビルドが表示されました。CanvasKit とフォントは引き続きキャッシュから読み込まれました。これは Flutter FAQ が説明している方法で、FAQ は Flutter がビルド ID を自動では付けないことにも触れています。`index.html` 自体は通常のナビゲーションでは依然として 10 分の有効期間の影響を受けます (リロードでは常に再検証されます)。また同じ名前で差し替えたアセットは対象外なので、変更した画像は上書きせず名前を変えてください。

### 開いているタブにリロードを促す

同じ ID をコンパイル時にアプリへ渡し、デプロイされた `build_id.txt` と比較します。`cache: 'no-store'` により、このチェック自体が HTTP キャッシュに入らないようにします。

```dart
// lib/update_check.dart, Flutter 3.44.8, Dart 3.12.2, package:web 1.1.1
import 'dart:async';
import 'dart:js_interop';

import 'package:flutter/material.dart';
import 'package:web/web.dart' as web;

/// flutter build web --dart-define=BUILD_ID=$(git rev-parse --short HEAD)
const buildId = String.fromEnvironment('BUILD_ID', defaultValue: 'dev');

Future<bool> newBuildAvailable() async {
  try {
    final response = await web.window
        .fetch('build_id.txt'.toJS, web.RequestInit(cache: 'no-store'))
        .toDart;
    if (!response.ok) return false;
    final deployed = (await response.text().toDart).toDart.trim();
    return deployed.isNotEmpty && deployed != buildId;
  } catch (_) {
    return false; // offline or blocked: keep running the current build
  }
}

void startUpdateCheck(GlobalKey<ScaffoldMessengerState> messenger) {
  if (buildId == 'dev') return;
  Timer.periodic(const Duration(minutes: 5), (timer) async {
    if (!await newBuildAvailable()) return;
    timer.cancel();
    messenger.currentState?.showSnackBar(
      SnackBar(
        duration: const Duration(days: 1),
        content: const Text('A new version is available.'),
        action: SnackBarAction(
          label: 'Reload',
          onPressed: () => web.window.location.reload(),
        ),
      ),
    );
  });
}
```

`MaterialApp` に `scaffoldMessengerKey` を渡し、それを引数にして `main` から `startUpdateCheck` を呼び出します。`--dart-define=BUILD_ID=A` でビルドし、`B` を含む `build_id.txt` をデプロイしたところ、`newBuildAvailable()` は最初のチェックで `true` を返しました。`bust.sh` を使わない場合は、CI で同じ ID を使って `build_id.txt` を書き出してください。これが最も重要になるのは、バックエンド API がフロントエンドと同時に変わる場合です。古いタブが新しい API を呼び出すのは、古い UI よりも深刻なバグだからです。

## Flutter 3.41 より前に service worker をリリースしていた場合

アプリが 3.38.x 以前でビルドされていた頃に初めて開いたユーザーのブラウザには、オフラインファーストの worker とその `flutter-app-cache` がまだ残っています。3.44.8 と 3.47.3 のソースによると、そうしたユーザーが 3.41 以降でビルドされたデプロイを初めて読み込むと、次のことが起こります。

1. 古い worker がまだ制御しているので、ナビゲーションにはオンライン優先で応答します (新しい `index.html`)。しかし `flutter_bootstrap.js` と `main.dart.js` は Cache Storage から返します。ユーザーには一瞬古いビルドが見える可能性があります。
2. ブラウザの service worker 更新チェックが、ネットワークから `flutter_service_worker.js` を取得します。ファイルはバイト単位で異なる (今は 784 バイトのクリーンアップ用 worker) ので、インストールされます。
3. クリーンアップ用 worker は `skipWaiting()` を呼び出し、次に `activate` で `self.registration.unregister()` を呼び出して、制御しているすべてのウィンドウを現在の URL へナビゲートします。
4. そのナビゲーションは service worker なしで行われるので、ページは HTTP キャッシュ経由で現在のビルドを読み込みます。前のセクションのヘッダーを設定していれば、それは新しいビルドです。

クリーンアップ用 worker は `flutter-app-cache`、`flutter-temp-cache`、`flutter-app-manifest` を削除しません。worker がなければそれらを読むものはありませんが、ストレージは占有し続けます。気になる場合は、起動時に一度だけ Cache Storage API で削除してください (`package:web` 経由で `caches.delete('flutter-app-cache')` など)。

この引き継ぎを妨げるデプロイ上のミスが 2 つあります。

- **デプロイから `flutter_service_worker.js` を削除すること。** 更新チェックが `404` を受け取ると、ブラウザは既存の worker を維持し、古い worker は Cache Storage から古い `main.dart.js` を返し続けます。古い訪問者がいる可能性がある限り、このファイルはリリースし続けてください。
- **早すぎる段階で `--pwa-strategy=none` を付けてビルドすること。** このフラグは 3.44 では非表示かつ非推奨で、[flutter/flutter#156910](https://github.com/flutter/flutter/issues/156910) への案内を出力します。`none` を指定すると、ツールは空の `flutter_service_worker.js` を書き出し、`flutter_bootstrap.js` から `serviceWorkerSettings` を削除するので、古い worker の登録を解除するものがなくなります。ブラウザはいずれ空のスクリプトをインストールしますが、それが制御を引き継ぐのはアプリのタブがすべて閉じられた後で、しかも登録は消えません。クリーンアップの経路を含んでいるのはデフォルトのビルドです。

本当にオフライン対応が必要なら、[Flutter FAQ](https://docs.flutter.dev/platform-integration/web/faq) は現在、独自の worker を用意するよう案内しています。たとえば Workbox を使う方法です。キャッシュ名にバージョンを付け、`index.html` と `flutter_bootstrap.js` にはネットワーク優先の戦略を使ってください。そうしないと同じ問題を作り直すことになります。

## 注意点と似た症状

- **ハードリロードではバグが見えません。** Ctrl+Shift+R (macOS では Cmd+Shift+R) はその読み込みで HTTP キャッシュと service worker をバイパスするので、開発者自身がこの問題に気づくことはあまりありません。通常のリロードで、または DevTools の "Disable cache" をオフにした状態でテストしてください。
- **CDN の CanvasKit は安全ですが、ローカルの CanvasKit はそうではありません。** デフォルトでは、ローダーはエンジンのリビジョンを含む URL で `gstatic.com` から CanvasKit を取得するので、Flutter をアップグレードすると URL が変わります。`--no-web-resources-cdn` を使うと、CanvasKit はどのリリースでも同じ名前で `canvaskit/` から配信されます。そこに長い有効期間を付けると、Flutter のアップグレード後に新しい `main.dart.js` と古い CanvasKit が組み合わさることがあります。
- **「静的」アセットの長い有効期間。** ホストや CDN のプリセットの中には、ハッシュ付きのファイル名を前提に `.js` ファイルへ 30 日の `max-age` を付けるものがあります。Flutter の出力ではその前提は成り立ちません。実際のレスポンスヘッダーを `curl -I https://your.app/main.dart.js` で確認してください。
- **Wasm ビルドにはエントリーポイントが多くあります。** `--wasm` ビルドは `main.dart.mjs` と `main.dart.wasm` も読み込み、ローダーの許可リスト外のブラウザでは `main.dart.js` にフォールバックします。3 つとも同じ扱いが必要で、`bust.sh` がそのすべてを書き換えるのはそのためです。
- **キャッシュが原因ではない古い挙動。** 新しいビルドは読み込まれるのに、リフレッシュ時にルートが 404 になる場合は、SPA のリライト (`try_files ... /index.html` または `firebase.json` の `"rewrites"`) が欠けています。サブパスの下でだけアセットが 404 になる場合は、`--base-href` を確認してください。

## 関連記事

- [WebAssembly で Flutter web アプリをビルドする方法](/ja/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/): Wasm の追加エントリーポイントと、同じホスト設定で `Cache-Control` の隣に置く COOP/COEP ヘッダーを扱っています。
- [Flutter web アプリを `dart:html` から `package:web` へ移行する](/ja/2026/09/migrate-a-flutter-web-app-from-dart-html-to-package-web/): 更新チェックで使っている interop のスタイルについて。
- [解決: Android WebView で Flutter の Text が画面外に描画される](/ja/2026/09/fix-flutter-text-renders-off-screen-in-an-android-webview-with-font-scaling/): デプロイ後にしか現れない、もう 1 つの Flutter web の問題です。
- [ASP.NET Core 11 の出力キャッシュとレスポンスキャッシュの比較](/ja/2026/07/output-caching-vs-response-caching-in-aspnetcore-11/): Flutter web のビルドを ASP.NET Core バックエンドから配信し、そこで `Cache-Control` ヘッダーを設定する場合に。

## 参考資料

- [Flutter web FAQ](https://docs.flutter.dev/platform-integration/web/faq): service worker の削除、`Cache-Control` のガイダンス、ビルド ID の手法。
- [Flutter web app initialization](https://docs.flutter.dev/platform-integration/web/initialization): `flutter_bootstrap.js` のテンプレートトークン。
- [flutter/flutter#156910](https://github.com/flutter/flutter/issues/156910): `flutter_service_worker.js` の非推奨化と削除。
- [flutter/flutter PR #176834](https://github.com/flutter/flutter/pull/176834): 3.41.0 で初めてリリースされた自己削除型の service worker。
- [3.47.3 の `service_worker_loader.js`](https://github.com/flutter/flutter/blob/3.47.3/engine/src/flutter/lib/web_ui/flutter_js/src/service_worker_loader.js) と [3.38.10 の `flutter_service_worker.js`](https://github.com/flutter/flutter/blob/3.38.10/packages/flutter_tools/lib/src/web/file_generators/js/flutter_service_worker.js): 新旧の worker の挙動について。
- [Chromium blog: Reload, reloaded](https://blog.chromium.org/2017/01/reload-reloaded-faster-and-leaner-page_26.html): リロードはメインリソースだけを再検証します。
- [RFC 9111, section 4.2.2](https://www.rfc-editor.org/rfc/rfc9111#section-4.2.2): 明示的な有効期間が送られない場合のヒューリスティックな鮮度。
- [Firebase Hosting cache behavior](https://firebase.google.com/docs/hosting/manage-cache): 再デプロイ時の CDN パージ。
