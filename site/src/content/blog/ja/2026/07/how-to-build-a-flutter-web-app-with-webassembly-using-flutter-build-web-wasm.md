---
title: "flutter build web --wasm で Flutter Web アプリを WebAssembly にビルドする方法"
description: "Flutter 3.44 で WebAssembly にコンパイルした Flutter Web アプリを公開するための完全ガイドです。出力される 2 つのビルドの中身、ローダーの wasmAllowList が原因で Firefox と Safari が今も JavaScript を受け取る理由、dart2wasm のための dart:html からの移行、skwasm がマルチスレッドで動くかを決める COOP/COEP ヘッダー、そしてブラウザーが実際にどちらのビルドを読み込んだかをランタイムで確認する方法を扱います。"
pubDate: 2026-07-28
template: how-to
tags:
  - "flutter"
  - "dart"
  - "webassembly"
  - "flutter-web"
  - "performance"
  - "how-to"
lang: "ja"
translationOf: "2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm"
translatedBy: "claude"
translationDate: 2026-07-28
---

Flutter Web アプリを WebAssembly でビルドするには、`--wasm` フラグを付けます。つまり `flutter build web --wasm` です。このフラグ 1 つで、ツールは `build/web` に *2 つの* ビルドを出力します。`dart2wasm` がコンパイルし `skwasm` レンダラーを使う WasmGC ビルドと、`canvaskit` をフォールバックとして使う通常の `dart2js` ビルドです。生成された `flutter_bootstrap.js` がページ読み込み時にどちらかを選びます。実際のユーザーが Wasm ビルドを受け取れるかどうかは、その後 2 つの条件で決まります。依存関係グラフのどこも `dart:html`、`dart:js`、`dart:js_util`、`package:js` をインポートしていないこと、そしてサーバーが `Cross-Origin-Opener-Policy: same-origin` と `Cross-Origin-Embedder-Policy: credentialless` を送っていることです。後者がないと `skwasm` は黙って 1 スレッドに落ちます。この記事は [Flutter 3.44](/ja/2026/07/flutter-3-44-read-the-screen-corner-radius-from-mediaquery/) stable (2026-05-18 リリース、Dart 3.10 を同梱) を対象にしており、以下の内容はすべて `flutter/flutter` の `stable` ブランチで確認しています。先に重要な注意点を述べます。3.44 の時点でローダーは Blink 系ブラウザーでしか Wasm ビルドを有効にしないため、Firefox、Safari、そして iOS 上のすべてのブラウザーは、何をコンパイルしても JavaScript ビルドを受け取ります。

## `--wasm` が build/web に実際に置くもの

多くの人が持っているイメージは、有益な形で間違っています。`--wasm` はビルドを JavaScript から WebAssembly に切り替えるものではありません。JavaScript ビルドの *隣に* WebAssembly ビルドを追加します。`packages/flutter_tools/lib/src/commands/build_web.dart` では、このフラグを渡すと `WasmCompilerConfig` と `JsCompilerConfig` という 2 要素のコンパイラー設定リストが作られ、ツールは両方のコンパイラーを実行します。フラグなしの場合は、本物の `JsCompilerConfig` に加えて `dryRun: true` が付いた `WasmCompilerConfig` が作られ、コンパイルはするものの出力は破棄されます (これについては後述します)。

コンパイルされた各ターゲットは、生成される `flutter_bootstrap.js` にビルド記述を 1 つ追加します。Flutter 3.44 で `flutter build web --wasm` を実行した後、その記述は次のようになります。

```javascript
// Excerpt from build/web/flutter_bootstrap.js, Flutter 3.44 stable
if (!window._flutter) {
  window._flutter = {};
}
_flutter.buildConfig = {
  "engineRevision": "...",
  "builds": [
    {
      "compileTarget": "dart2wasm",
      "renderer": "skwasm",
      "mainWasmPath": "main.dart.wasm",
      "jsSupportRuntimePath": "main.dart.mjs"
    },
    {
      "compileTarget": "dart2js",
      "renderer": "canvaskit",
      "mainJsPath": "main.dart.js"
    }
  ]
};
```

順序が重要です。`FlutterLoader.load()` は `buildConfig.builds.find(buildIsCompatible)` を呼び、*最初に* 互換性のあるエントリーを採用するため、環境が許す限り Wasm ビルドが勝ちます。レンダラーの組み合わせは設定できません。`WebRendererMode.defaultForWasm` は `skwasm`、`defaultForJs` は `canvaskit` であり、ツールは両者を混在させることを許しません。これが後述する最初の落とし穴です。

ディスク上には `main.dart.wasm` (モジュール本体)、`main.dart.mjs` (それをインスタンス化する JS サポートランタイム)、`main.dart.js` (フォールバック) が出力され、さらに各レンダラーのペイロードとして Wasm 側に `skwasm.js` と `skwasm.wasm`、フォールバック側に CanvasKit のバンドルが置かれます。

## 実際に重要な 5 つのステップ

1. **Flutter 3.24 以降にする。** Wasm コンパイルは 3.24 で stable に入りました。ここで検証したのは 3.44 です。プロジェクトごとに SDK バージョンを使い分けている場合、[1 つの Flutter プロジェクトを CI で複数の SDK バージョンに対して動かす](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) 話はそのまま Wasm ビルドにも当てはまります。
2. **`web/index.html` が Flutter 3.22 より古いなら作り直す。** Wasm の経路は `flutter_bootstrap.js` ローダーに完全に依存するため、古い `serviceWorkerVersion` 方式の bootstrap では動きません。`web/` を削除してから `flutter create . --platforms web` を実行すれば現在のテンプレートが得られます。
3. **依存関係グラフから `dart2wasm` 非互換を取り除く。** まず `--wasm` なしの `flutter build web` を実行し、dry run の指摘を読みます。
4. **ビルドする:** `flutter build web --wasm`。
5. **クロスオリジン分離ヘッダー付きで配信する。** これがなくてもアプリは動きますが 1 スレッドになり、Wasm を使う理由の大半が失われます。

## Firefox と Safari で今も JavaScript が実行される理由

ここが多くの人を驚かせる部分であり、公式の Wasm サポートページは古すぎて (frontmatter の `last-update` は Nov 6, 2024) 読んでも現在の挙動が分かりません。もはや WasmGC が制約ではありません。WasmGC は Chrome 119、Firefox 120、Safari 18.2 にわたって Baseline に到達しています。制約はエンジンのローダーにハードコードされた許可リストです。

`stable` ブランチの `engine/src/flutter/lib/web_ui/flutter_js/src/browser_environment.js` には、まさに次の内容があります。

```javascript
// engine/src/flutter/lib/web_ui/flutter_js/src/browser_environment.js
export const defaultWasmSupport = {
  "blink": true,
  "gecko": false,
  "webkit": false,
  "unknown": false,
}
```

そして `loader.js` が `skwasm` ビルドをこの値でゲートしています。

```javascript
// engine/src/flutter/lib/web_ui/flutter_js/src/loader.js
const supportsDart2Wasm = browserEnvironment.supportsWasmGC;
const supportsSkwasm = supportsDart2Wasm && browserEnvironment.webGLVersion > 0;

const enableWasm = config.wasmAllowList?.[browserEnvironment.browserEngine]
  ?? defaultWasmSupport[browserEnvironment.browserEngine];
```

したがって Firefox では `supportsWasmGC()` は `true` を返します (検出器はごく小さな WasmGC モジュールを検証し、Firefox はこれを通過します) が、`enableWasm` は `gecko` のエントリーから `false` になり、`skwasm` ビルドは非互換として却下され、ローダーは `dart2js` + `canvaskit` に落ちます。Safari も `webkit` 経由で同じです。理由は WasmGC ではなくレンダラーにあります。Flutter のマルチスレッド `skwasm` は `OffscreenCanvas.transferToImageBitmap` に依存しており、そのコストを追跡している Firefox 側のバグ (Bugzilla 1788206) と WebKit 側のバグ (267291) は、2026 年 7 月に確認した時点でどちらも未解決でした。

許可リストは自分で上書きできます。意見ではなく実測値が欲しいなら、クエリーパラメーターの後ろに置いて試す価値があります。

```javascript
// web/flutter_bootstrap.js, Flutter 3.44
{{flutter_js}}
{{flutter_build_config}}

const params = new URLSearchParams(window.location.search);
_flutter.loader.load({
  config: {
    // Only opt gecko/webkit in deliberately. Expect rendering artifacts.
    wasmAllowList: params.has('force_wasm')
      ? { blink: true, gecko: true, webkit: true, unknown: false }
      : undefined,
  },
});
```

勘で本番に出さないでください。まず [DevTools で Flutter アプリの jank をプロファイルする](/ja/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) 手順で計測してください。対象のエンジンでの失敗の現れ方は、きれいなエラーではなくフレーム時間の悪化です。

上書きがまったく効かない制限が 1 つあります。iOS 上のすべてのブラウザーは WebKit の使用を義務付けられているため、Wasm にコンパイルした Flutter アプリは iOS Safari、iOS Chrome、そのプラットフォームの他のどのブラウザーでも動きません。

## 依存関係をコンパイルできる状態にする

`dart2wasm` がサポートするのは Dart の静的 JS interop だけです。`dart:html`、`dart:js`、`dart:js_util`、`package:js` を推移的にインポートしていると、次のようなメッセージでコンパイルが失敗します。

```output
Dart library 'dart:html' is not available on this platform.
JS interop library 'dart:js_util' can't be imported when compiling to Wasm.
Try using 'dart:js_interop' or 'dart:js_interop_unsafe' instead.
```

良い知らせは、試してから気付く必要はないという点です。`--wasm-dry-run` は既定で `true` なので、素の `flutter build web` でもすでに `dart2wasm` が dry run モードで走り、見つかった内容を報告します。

```output
Wasm dry run findings:
...
Consider addressing these issues to enable wasm builds. See docs for more info:
https://docs.flutter.dev/platform-integration/web/wasm
```

アプリがすでにクリーンな場合、同じ仕組みが逆方向に押してきて `Wasm dry run succeeded. Consider building and testing your application with the --wasm flag.` と表示します。いずれにしても、判断が済んだあとは `flutter build web --no-wasm-dry-run` で抑制できます。

自分が所有するコードでは、`dart:html` の代わりに `package:web`、`package:js` の代わりに `dart:js_interop` を使うのが移行の中身です。

```dart
// Dart 3.10, Flutter 3.44 -- wasm-compatible
import 'dart:js_interop';
import 'package:web/web.dart' as web;

@JS('navigator.clipboard.writeText')
external JSPromise<JSAny?> _writeText(String text);

Future<void> copy(String text) async {
  await _writeText(text).toDart;
  web.document.querySelector('#status')?.textContent = 'Copied';
}
```

移行時に効いてくる違いは 3 つあります。名前はブラウザーの IDL に従うため、`HtmlElement` は `HTMLElement` になり、`innerHtml` は `innerHTML` になります。`querySelectorAll` は `List` ではない iterable を返します。そして interop の型は extension type なので、`is` と `as` は期待どおりに動きません。代わりに `isA<T>()` を使ってください。条件付きインポートも変わります。判定は `dart.library.html` ではなく `dart.library.js_interop` になりました。プラグインを使わず interop を自分で書いている場合は、[プラグインなしで Flutter にプラットフォーム固有コードを追加する](/ja/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) のパターンがそのまま応用できます。

自分が所有していないコードについては、pub.dev を `is:wasm-ready` で絞り込みます。依存関係が原因のときは、それを上げるだけで解決することが多く、いつもの制約解決の苦労も付いてきます。リゾルバー地獄に落ちた場合の抜け道は [修正: pubspec.yaml の Version solving failed](/ja/2026/05/fix-version-solving-failed-in-pubspec-yaml/) で扱っています。

## COOP と COEP がスレッドの有無を決める

Flutter は `skwasm` を共有メモリー付きでコンパイルします。`build_system/targets/web.dart` のコンパイラー呼び出しを見ると、`skwasm` レンダラーに対して `--import-shared-memory` と `--shared-memory-max-pages=32768` を追加していることが分かります。ブラウザーでの共有メモリーはクロスオリジン分離を必要とし、それには 2 つのレスポンスヘッダーが必要です。ツールは必要な組み合わせをハードコードしています。

```dart
// packages/flutter_tools/lib/src/web/web_constants.dart, Flutter 3.44
const kCrossOriginIsolationHeaders = <String, String>{
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};
```

`flutter run -d chrome --wasm` は自身の開発サーバーでこれらを設定します。だからこそ、この問題はローカルではまったく現れず、本番で現れます。ヘッダーが欠けていてもエラーは出ません。`skwasm_loader.js` は `skwasmSingleThreaded: ... || !browserEnvironment.crossOriginIsolated || ...` を計算し、黙ってシングルスレッドのエンジンを起動します。

nginx の場合:

```nginx
# nginx, serving build/web
location / {
    add_header Cross-Origin-Opener-Policy   same-origin   always;
    add_header Cross-Origin-Embedder-Policy credentialless always;
    try_files $uri $uri/ /index.html;
}
```

Firebase Hosting の場合:

```json
{
  "hosting": {
    "public": "build/web",
    "headers": [
      {
        "source": "**",
        "headers": [
          { "key": "Cross-Origin-Opener-Policy",   "value": "same-origin" },
          { "key": "Cross-Origin-Embedder-Policy", "value": "credentialless" }
        ]
      }
    ]
  }
}
```

ブラウザーのコンソールで `window.crossOriginIsolated` を確認してください。`true` である必要があります。なお GitHub Pages はカスタムヘッダーをまったく送れないため、そこにホストした Wasm ビルドは常にシングルスレッドで動きます。

クロスオリジン分離は無料ではありません。`require-corp` は `Cross-Origin-Resource-Policy` で明示的にオプトインしていないクロスオリジンのサブリソースをすべて壊します。実際にはサードパーティーの画像、フォント、アナリティクスの beacon、埋め込み iframe が該当します。`credentialless` は 2 つのうち緩やかな方で、クロスオリジンのサブリソースをブロックせずに認証情報なしで読み込みます。まず `credentialless` から始め、次にネットワークパネルで cookie を失ったリクエストを洗い出してください。

## ブラウザーがどちらのビルドを読み込んだかを確認する

ストップウォッチで推測しないでください。コンパイラーが設定する環境変数を読めます。

```dart
// Flutter 3.44, Dart 3.10
const isRunningWithWasm = bool.fromEnvironment('dart.tool.dart2wasm');
```

Wasm がネイティブの数値表現を使うことを利用した、再ビルドなしで使える挙動ベースの判定もあります。

```dart
final isRunningWithWasm = identical(double.nan, double.nan);
```

3 つ目の確認方法はネットワークパネルです。`main.dart.wasm` へのリクエストがあれば Wasm ビルド、`main.dart.js` ならフォールバックです。

## 公開前に知っておきたい落とし穴

**`--wasm` と一緒にレンダラーを指定するとハードエラーになります。** 解決されたレンダラーが `skwasm` でない場合、`build_web.dart` は `throwToolExit('Do not attempt to set a web renderer when using "--wasm"')` を呼びます。つまり `--wasm` と `--dart-define=FLUTTER_WEB_USE_SKIA=true` の組み合わせは、設計上 CLI の段階で失敗します。

**Wasm ビルドで `config.renderer: 'canvaskit'` を指定するとランタイムで失敗します。** `buildIsCompatible` は `renderer` が設定値と一致しないビルドをすべて却下しますが、`--wasm` ビルドには `dart2wasm` + `canvaskit` のエントリーが存在しません。候補がすべて除外され、ローダーは `FlutterLoader could not find a build compatible with configuration and environment.` を投げます。これは flutter/flutter#183265 として追跡されています。`renderer` キーを削除するか、`skwasm` に設定してください。

**Chromium 以外のエンジンはより重いレンダラーペイロードを読み込みます。** `loadSkwasm` は、ブラウザーに `ImageDecoder` または Chromium の break iterator がない場合、`skwasm` ではなく `skwasm_heavy` を選びます。したがって許可リストを強制的に開けると、ダウンロードサイズの増加も負担することになります。

**Chrome 拡張機能は強制的にシングルスレッドになります。** ローダーは `chrome.runtime.id` を検出してスレッドを無効化します。拡張機能の CSP が、ワーカーに必要な動的スクリプト読み込みをブロックするためです。

**シンボル名は既定で除去されます。** `--strip-wasm` の既定値は `true` です。プロファイルビルドから読めるスタックトレースが必要なときは `--no-strip-wasm` を渡し、`main.dart.wasm.map` を出力するには `--source-maps` を渡します。

**Wasm は SEO を解決しません。** どちらのビルドも canvas に描画するため、クローラーが見る意味的な HTML はほぼないままです。Wasm は Flutter Web アプリを速くしますが、ドキュメントに変えるわけではありません。

**ツール自身がまだ新機能扱いしています。** `flutter build web --wasm` は `WebAssembly compilation is new. Understand the details before deploying to production.` と書かれたボックスを表示します。これは定型文ではなく正確な記述として扱ってください。Flutter のバージョンを固定し、JavaScript フォールバックの経路をテストマトリクスに残しておきましょう。現在の許可リストでは、そちらがユーザーの大半が通る経路なのです。

## 関連記事

- [DevTools で Flutter アプリの jank をプロファイルする方法](/ja/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/)
- [プラグインなしで Flutter にプラットフォーム固有コードを追加する方法](/ja/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/)
- [1 つの CI パイプラインから複数の Flutter バージョンをターゲットにする方法](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)
- [修正: pubspec.yaml の Version solving failed](/ja/2026/05/fix-version-solving-failed-in-pubspec-yaml/)
- [Flutter 2 アプリを Flutter 3.x に移行する: null safety チェックリスト](/ja/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/)

## 参考資料

- Flutter ドキュメント、[Support for WebAssembly (Wasm)](https://docs.flutter.dev/platform-integration/web/wasm)
- Flutter ドキュメント、[Flutter web app initialization](https://docs.flutter.dev/platform-integration/web/initialization)
- Flutter ドキュメント、[Build and release a web app](https://docs.flutter.dev/deployment/web)
- Flutter のソース、[`packages/flutter_tools/lib/src/commands/build_web.dart`](https://github.com/flutter/flutter/blob/stable/packages/flutter_tools/lib/src/commands/build_web.dart)
- Flutter のソース、[`engine/src/flutter/lib/web_ui/flutter_js/src/loader.js`](https://github.com/flutter/flutter/blob/stable/engine/src/flutter/lib/web_ui/flutter_js/src/loader.js) および [`browser_environment.js`](https://github.com/flutter/flutter/blob/stable/engine/src/flutter/lib/web_ui/flutter_js/src/browser_environment.js)
- Flutter の issue [#183265, FlutterLoader could not find a build compatible with configuration and environment](https://github.com/flutter/flutter/issues/183265)
- Dart ドキュメント、[Migrate to package:web](https://dart.dev/interop/js-interop/package-web) および [WebAssembly (Wasm) compilation](https://dart.dev/web/wasm)
- web.dev、[WasmGC and Wasm tail call optimizations are now Baseline Newly available](https://web.dev/blog/wasmgc-wasm-tail-call-optimizations-baseline)
- Chrome for Developers、[COEP: credentialless](https://developer.chrome.com/blog/coep-credentialless-origin-trial)
