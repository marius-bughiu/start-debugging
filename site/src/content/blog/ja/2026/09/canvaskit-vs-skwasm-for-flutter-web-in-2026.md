---
title: "2026 年の Flutter web における CanvasKit と skwasm: どちらのレンダラーを出荷すべきか"
description: "依存関係が Wasm にコンパイルできるなら、flutter build web --wasm で skwasm を出荷しましょう。ダウンロード量が少なく、重いシーンでは CanvasKit より 36% 多くのフレームを描画しました。Flutter 3.47.x では、マルチスレッド時のテキストのクラッシュ修正がベータを抜けるまでシングルスレッドにしておきます。"
pubDate: 2026-09-17
template: vs
tags:
  - "comparison"
  - "flutter"
  - "flutter-web"
  - "webassembly"
  - "performance"
lang: "ja"
translationOf: "2026/09/canvaskit-vs-skwasm-for-flutter-web-in-2026"
translatedBy: "claude"
translationDate: 2026-09-17
---

skwasm を出荷しましょう。Flutter 3.47.4 (現在の stable、Dart 3.13.3) では、`flutter build web --wasm` によって Chromium のユーザーはより小さなダウンロード (後述のベンチマークアプリで brotli 1.65 MB 対 1.98 MB) を受け取り、重いシーンでは CanvasKit の 24.0 fps に対して 32.7 fps になります。Firefox、Safari、そしてすべての iOS ブラウザーは、同じビルドから引き続き CanvasKit を受け取ります。CanvasKit のみのビルドにとどまるべきなのは、依存関係がまだ `dart:html` や `package:js` をインポートしている場合だけです。3.47.x には 1 つ注意点があります。マルチスレッドの skwasm はテキストの多いフレームでクラッシュすることがあるため、3.48 が stable になるまではシングルスレッドモードを強制してください。

ここでの "レンダラー" という言葉は少し誤解を招きます。CanvasKit や skwasm を単独で選ぶわけではないからです。Flutter 3.29 で HTML レンダラーと `--web-renderer` フラグが削除されて以降、レンダラーはコンパイルターゲットから決まります。`dart2js` の出力は常に CanvasKit で動き、`dart2wasm` の出力は常に skwasm で動きます。ツールもこれを強制しており、`flutter build web --wasm --dart-define=FLUTTER_WEB_USE_SKIA=true --dart-define=FLUTTER_WEB_USE_SKWASM=false` は `Do not attempt to set a web renderer when using "--wasm"` を出して終了します。つまり本当の問いは "JavaScript ビルドか Wasm ビルドか" であり、その答えによって下で動く Skia が決まります。

## 機能比較表

| 項目 (Flutter 3.47.4)              | CanvasKit                                           | skwasm                                                        |
| ---------------------------------- | --------------------------------------------------- | ------------------------------------------------------------- |
| コンパイルターゲット               | `dart2js`                                           | `dart2wasm` (WasmGC が必要)                                   |
| ビルドコマンド                     | `flutter build web`                                 | `flutter build web --wasm` (CanvasKit ビルドも出力)           |
| 既定で読み込むブラウザー           | すべて                                              | Blink のみ (Chrome、Edge、Opera、Android の Chrome)           |
| エンジンのダウンロード量、brotli   | 1.54 MB (Chromium バリアント)、2.26 MB (フルバリアント) | 1.21 MB (`skwasm.wasm`)、1.86 MB (`skwasm_heavy.wasm`)      |
| ラスタライズの実行場所             | メインスレッド                                      | ページが cross-origin isolated のときは Web Worker             |
| 最適なモードに必要なヘッダー       | なし                                                | `Cross-Origin-Opener-Policy` + `Cross-Origin-Embedder-Policy` |
| 依存グラフ内の `dart:html`、`package:js` | 問題なし                                      | コンパイルエラー                                              |
| `flutter run -d chrome` でのデバッグ | DevTools をフルに利用可能、ステートフルなホットリロード (DDC) | サービスプロトコルなし、ホットリロードは再起動になる |
| 遅延読み込み                       | あり                                                | 既定で無効、実験的フラグは 3.50 で予定                        |
| stable チャネルの既知の問題        | ブロッカーなし                                      | テキストの頻繁な変化でマルチスレッド時にクラッシュ、#190039   |

2 つの行には補足が必要です。"Blink のみ" の行は WasmGC のサポートとは関係ありません。Firefox と Safari はどちらも現在 WasmGC を検証できます。Flutter のローダーは `browser_environment.js` にハードコードされた許可リスト (`blink: true, gecko: false, webkit: false`) によって、これらを skwasm から外しています。理由は、マルチスレッドの skwasm が `OffscreenCanvas.transferToImageBitmap` を使って worker からページへフレームを渡しており、これが両エンジンで遅いためです。追跡用のバグである [Mozilla 1788206](https://bugzilla.mozilla.org/show_bug.cgi?id=1788206) と [WebKit 267291](https://bugs.webkit.org/show_bug.cgi?id=267291) は、2026 年 9 月の時点でどちらもまだ `NEW` でした。

デバッグの行は 3.47.4 の `resident_web_runner.dart` をそのまま反映しています。`supportsServiceProtocol` は `!debuggingOptions.webUseWasm && isRunningDebug && ...` であり、`reloadIsRestart` は `webUseWasm` が設定されていると必ず `true` を返します。したがって、Wasm を出荷するチームであっても、日々の開発は JavaScript のパスで行うことになります。

## 各ビルドが実際にダウンロードするもの

`--wasm` ビルドは両方のパイプラインを `build/web` に書き出し、`flutter_bootstrap.js` にはそれらを優先順に並べた `buildConfig` が含まれます。

```jsonc
// flutter build web --wasm, Flutter 3.47.4
"builds": [
  {"compileTarget": "dart2wasm", "renderer": "skwasm", "mainWasmPath": "main.dart.wasm", "jsSupportRuntimePath": "main.dart.mjs"},
  {"compileTarget": "dart2js", "renderer": "canvaskit", "mainJsPath": "main.dart.js"}
]
```

ローダーは最初に互換性のあるエントリを採用します。そのうえで、各レンダラーの中でブラウザーの機能に応じてバリアントを選びます。`canvaskit_loader.js` は、ブラウザーに `ImageDecoder` と `Intl.v8BreakIterator` の両方がある場合に `canvaskit/chromium/canvaskit.wasm` を読み込みます。このバリアントは画像コーデックと ICU データをブラウザーに任せており、Flutter 3.47.0 では残っていたコーデックもそこから削除されました ([#178133](https://github.com/flutter/flutter/pull/178133))。それ以外のブラウザーはすべてフルの `canvaskit.wasm` を受け取ります。`skwasm_loader.js` にも同じ分岐があり、Chromium では `skwasm.wasm`、これら 2 つの API がない環境ではより大きな `skwasm_heavy.wasm` を使います。実際には、許可リストを上書きして Firefox や Safari を Wasm に載せない限り、`skwasm_heavy` を目にすることはありません。

後述のベンチマークアプリ (約 180 行の Material アプリ) のリリースビルドを使って、各パスで初回訪問にかかるコストを測定しました。サイズは各パスが取得するファイルの `brotli -q 11` と `gzip -9` の値です。`flutter.js`、`flutter_bootstrap.js`、フォント、アセットはどのパスでも同じなので除外しています。

| パス (Flutter 3.47.4)       | アプリコード                          | レンダラーの JS + Wasm | brotli 合計 | gzip 合計 |
| --------------------------- | ------------------------------------- | ------------------ | ------------ | ---------- |
| CanvasKit、Chromium バリアント | `main.dart.js` 413 KB              | 1,564 KB           | **1,977 KB** | 2,612 KB   |
| CanvasKit、フルバリアント   | `main.dart.js` 413 KB                 | 2,281 KB           | **2,695 KB** | 3,465 KB   |
| skwasm                      | `main.dart.wasm` 416 KB + `.mjs` 6 KB | 1,225 KB           | **1,647 KB** | 2,083 KB   |

このサイズではアプリコードに差はほとんどありません。未圧縮で 1.42 MB の Wasm と 1.79 MB の minify 済み JavaScript は、brotli で圧縮するとほぼ同じサイズになります。差はエンジンから生まれており、`skwasm.wasm` は Chromium 向け CanvasKit より約 330 KB 小さくなっています。大規模なアプリについて注意点が 1 つあります。`dart2wasm` は既定では遅延インポートを分割しないため、初回読み込みを小さく保つために `deferred as` に頼っているアプリでは、Wasm パスがその優位性を失う可能性があります。

## ベンチマーク

ダウンロードサイズは話の半分にすぎません。残りの半分はフレーム時間なので、すべての構成で同じシーンを描画しました。

**環境。** Apple M4、16 GB RAM、macOS 26。Google Chrome 153.0.8010.48 を `--headless=new --use-angle=metal` で起動 (WebGL の報告は `ANGLE Metal Renderer: Apple M4`)、ウィンドウは 1280x800、DPR 1、実行ごとに新しいプロファイルを使用しました。アプリは Flutter 3.47.4 と 3.48.0-0.5.pre で `flutter build web --wasm --no-web-resources-cdn` を使ってリリースモードでビルドし、`Cache-Control: no-store` 付きで localhost から配信しました。一方のポートは `Cross-Origin-Opener-Policy: same-origin` と `Cross-Origin-Embedder-Policy: require-corp` を送信し、もう一方はどちらも送信しませんでした。

**方法。** すべての構成を 1 つの `--wasm` ビルドから配信しました。カスタムの `flutter_bootstrap.js` がクエリ文字列からレンダラーを読み取るため、CanvasKit での実行には、実際の Firefox ユーザーがダウンロードするものとまったく同じ `main.dart.js` フォールバックが使われています。

```js
// web/flutter_bootstrap.js, Flutter 3.47.4
{{flutter_js}}
{{flutter_build_config}}
const q = new URLSearchParams(location.search);
const config = {suppressMultithreadingWarning: true};
if (q.get('renderer')) config.renderer = q.get('renderer');   // 'skwasm' or 'canvaskit'
if (q.get('st')) config.forceSingleThreadedSkwasm = true;
if (q.get('variant')) config.canvasKitVariant = q.get('variant'); // 'full' to skip the Chromium variant
_flutter.loader.load({config});
```

アプリ内では、3 秒のウォームアップの後、`SchedulerBinding.instance.addTimingsCallback` で 10 秒間 `FrameTiming` を収集しました。web では、これらはエンジンの `FrameTimingRecorder` によってラスタライザーの各 `draw` 呼び出しの前後で記録されます。"Presented fps" は 1 秒あたりのタイミング数 (ラスタライズを完了したフレーム数) で、各セルは 3 回の実行の中央値です (3.48 のマルチスレッド skwasm は 5 回)。3.48.0-0.5.pre では、CanvasKit (24.0 fps) とシングルスレッドの skwasm (32.3 fps) は 3.47.4 の数値との差が 2% 以内に収まったため、表では 3.47.4 で問題なく動いた箇所はすべて 3.47.4 の値を示しています。"tiles" シーンは、グラデーション、角丸、`BoxShadow`、毎フレーム内容が変わる `Text` を持つ回転する 600 個の `Container` で構成されています。"paths" シーンは、アニメーションする 40 セグメントのパス 400 本を `CustomPainter` でストロークするものです。

**tiles シーン (重い):**

| 構成                                   | Presented fps | Build p50 | Raster p50 | Frame span p90 | 最初のフレーム |
| -------------------------------------- | ------------- | --------- | ---------- | -------------- | ----------- |
| CanvasKit、Chromium バリアント (3.47.4) | 24.0         | 24.2 ms   | 17.1 ms    | 44.0 ms        | 285 ms      |
| CanvasKit、フルバリアント (3.47.4)     | 24.3          | 23.7 ms   | 17.2 ms    | 42.9 ms        | 286 ms      |
| skwasm、シングルスレッド (3.47.4)      | **32.7**      | 13.6 ms   | 16.0 ms    | 31.4 ms        | 193 ms      |
| skwasm、マルチスレッド (3.47.4)        | 停止          | n/a       | n/a        | n/a            | 245 ms      |
| skwasm、マルチスレッド (3.48.0-0.5.pre) | **39.3**     | 14.7 ms   | 22.5 ms    | 48.0 ms        | 238 ms      |

**paths シーン (軽い):**

| 構成 (3.47.4)               | Presented fps | Build p50 | Raster p50 |
| --------------------------- | ------------- | --------- | ---------- |
| CanvasKit、Chromium バリアント | 60.4       | 3.3 ms    | 3.0 ms     |
| skwasm、シングルスレッド    | 60.0          | 1.2 ms    | 3.9 ms     |
| skwasm、マルチスレッド      | 59.9          | 1.1 ms    | 4.1 ms     |

目立つ点が 4 つあります。

1. **改善の大部分は Skia ではなく `dart2wasm` によるものです。** ラスタライズ時間はほぼ同じです (tiles では 17.1 ms 対 16.0 ms、paths では CanvasKit のほうがむしろ速い)。ビルドフェーズ、つまり Dart のウィジェット、レイアウト、ペイントのコードは、WasmGC にコンパイルするとおよそ 2 倍速く動きます。フレームあたりのフレームワークの処理が多いほど、差は大きくなります。
2. **マルチスレッドはレイテンシと引き換えにスループットを得ます。** 3.48 ベータでは、マルチスレッドのビルドはシングルスレッドより 22% 多くのフレームを表示しました (39.3 対 32.3 fps) が、raster p50 は 22.5 ms に上がりました。worker が前のフレームをまだラスタライズしている間に、UI スレッドが次のフレームをビルドします。`Renderer.renderScene` は保留中のシーンのうち最新のものだけを残し、残りは破棄します。その結果、全体のフレーム数は増え、フレームごとの時間は長くなります。
3. **軽いシーンはどちらでも vsync で頭打ちになります。** アプリがフォームやリスト中心なら、フレームレートでレンダラーの違いを感じることはありません。感じるのはダウンロードと起動の違いです。
4. **localhost での最初のフレームはシングルスレッドの skwasm が約 90 ms 有利です** (193 ms 対 285 ms。マルチスレッドモードでは、レンダー worker の起動でその一部が相殺されます)。ネットワークの影響を除いているので、この差はコンパイルとインスタンス化のコストです。実際の回線では、brotli で 330 KB の差がこれに加わります。

絶対値は Metal で動作する M4 に固有のものとして扱ってください。他の環境にも当てはまるのは比率です。

## skwasm を選ぶべき場合

- **利用者の大半がデスクトップの Chrome や Edge、または Android の Chrome である。** 実際に Wasm ビルドを受け取るのはこれらのユーザーで、より小さなダウンロードと速いビルドフェーズをそのまま享受できます。それ以外のユーザーは透過的に CanvasKit にフォールバックします。
- **フレームの処理がフレームワーク中心である。** ダッシュボード、データグリッド、アニメーションするリストはビルドとレイアウトに時間を使っており、そこはまさにベンチマークで `dart2wasm` がリードした部分です。
- **レスポンスヘッダーを制御できる。** マルチスレッドモードには `Cross-Origin-Opener-Policy: same-origin` と `Cross-Origin-Embedder-Policy: credentialless` (または `require-corp`) が必要です。これらがなくても skwasm はシングルスレッドで動作し、`suppressMultithreadingWarning: true` で抑制できる警告をログに出します。
- **依存グラフ全体が `package:web` と `dart:js_interop` に移行済みである。** 通常の `flutter build web` は毎回のビルドで Wasm のドライランを実行し、"Wasm dry run succeeded" または問題のあるインポートを表示するので、すでに把握できているはずです。

## CanvasKit を選ぶべき場合

- **依存関係がまだ `dart:html`、`dart:js`、`package:js` をインポートしている。** `dart2wasm` はそれをコンパイルしないため、そのパッケージが移行するまでは選択の余地がありません。
- **トラフィックの大半が iOS または Safari である。** これらのユーザーは `--wasm` ビルドからでも CanvasKit を受け取ります。Wasm ビルドはビルド時間とテストすべき 2 つ目のパイプラインを増やすだけで、彼らには何の利点もありません。
- **クロスオリジンのコンテンツを埋め込んでおり、COEP を導入できない。** サードパーティの iframe、広告スクリプト、CORS ヘッダーのない画像は `require-corp` の下で壊れることがあり、`credentialless` はそれらのリクエストから Cookie を取り除きます。シングルスレッドの skwasm はヘッダーを必要としませんが、スループットの向上は失われます。
- **初回読み込みサイズのために遅延読み込みが必要である。** Wasm の遅延読み込みが実験的フラグを外れるまでは、`deferred as` インポートを使った JavaScript ビルドのほうが、一枚岩の `main.dart.wasm` より小さく始められる場合があります。

## 3.47.x で選択を決めてしまう落とし穴

tiles シーンでは、Flutter 3.47.4 のマルチスレッド skwasm が 7 回中 6 回停止しました。そのうち 4 回は、`requestAnimationFrame` が発火し続け、フレームワークも 60 fps でビルドし続けていましたが、最初のフレーム以降 `FrameTiming` が届かず、画面には何も新しく表示されませんでした。残りの 2 回では、ページが Dart のタイマーの実行を完全に停止しました。Chrome のコンソールには、ある実行では `skwasm.wasm` から `Uncaught RuntimeError: null function` と `table index is out of bounds` が表示され、別の実行では何も表示されませんでした。同じシーンをシングルスレッドで動かした場合と、テキストのない paths シーンをマルチスレッドで動かした場合は、毎回問題なく動作しました。

これは [flutter/flutter#190039](https://github.com/flutter/flutter/issues/190039) と一致します。修正の説明によると、マルチスレッドの skwasm は `-sWASM_WORKERS` 付きで、しかし `-pthread` なしでビルドされているため、ミューテックスが何もしない emscripten のシングルスレッド用システムライブラリがリンクされます。その結果、メインスレッドでのテキストレイアウトとラスター worker が Skia のグローバルな `SkStrikeCache` を共有し、テキストが毎フレーム変わるとヒープを破壊します。修正である [PR #190048](https://github.com/flutter/flutter/pull/190048) ("Use thread local strike caches in skwasm") は 2026-08-05 にマージされ、3.48.0-0.5.pre に含まれています。同じアプリをそのベータで再ビルドしたところ、5 回中 5 回が `RuntimeError` なしで安定していました。stable への cherry-pick リクエスト ([#192115](https://github.com/flutter/flutter/pull/192115)) は 2026-09-01 にマージされずにクローズされ、3.47.4 までのどの 3.47.x リリースにもこの修正は含まれていません。

3.48 stable に移行するまでは、Wasm ビルドを維持したまま `web/flutter_bootstrap.js` でスレッドを無効にしてください。

```js
// web/flutter_bootstrap.js, Flutter 3.47.x: avoid #190039
{{flutter_js}}
{{flutter_build_config}}
_flutter.loader.load({
  config: {
    forceSingleThreadedSkwasm: true,
    suppressMultithreadingWarning: true,
  },
});
```

シングルスレッドの skwasm でも、表示フレーム数で CanvasKit を 36% 上回りました。つまり、これで失うのはマルチスレッドのボーナスであって、Wasm による改善ではありません。COOP/COEP ヘッダーを外しても同じ効果がありますが、後で元に戻すには config のフラグのほうが簡単です。

同じ config には、知っておくと役立つ逃げ道が 2 つあります。`renderer: 'canvaskit'` を指定すると、ローダーは Wasm のエントリをスキップして `dart2js` ビルドを読み込みます。3.47.4 での私の実行では、これは `--wasm` ビルドからでも機能し、`dart.tool.dart2wasm == false` が報告されたので、上のようなクエリ文字列による切り替えは本番環境のキルスイッチになります。また、`verboseBuildSelection: true` (3.47.0 で追加) は各候補ビルドがスキップされた理由をログに出すので、"なぜこのユーザーは CanvasKit なのか" に答える最速の方法です。

## 推奨のまとめ

`flutter build web --wasm` でビルドし、ローダーに Chromium には skwasm、それ以外には CanvasKit を渡させましょう。3.47.x では `forceSingleThreadedSkwasm: true` を追加し、COOP/COEP ヘッダーを整えた状態で 3.48 stable に移行したら削除します。通常の CanvasKit ビルドに戻すのは、依存関係が `dart2wasm` を妨げる場合だけにしてください。エンジン同士のラスタライズ速度はほぼ同じです。本当に選んでいるのは自分の Dart コードに対する `dart2wasm` であり、2026 年においては、ブラウザーが許す限りそれがより速く、より小さい選択肢です。

## 関連記事

- [WebAssembly で Flutter web アプリをビルドする方法](/ja/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/) では、ブラウザーがどのビルドを読み込んだかを確認する方法も含めて、`--wasm` ビルドを最初から最後まで解説しています。
- [Flutter web アプリを `dart:html` から `package:web` へ移行する](/ja/2026/09/migrate-a-flutter-web-app-from-dart-html-to-package-web/) は、Wasm のドライランでコードが指摘された場合の前提となる作業です。
- [修正: Flutter web がリロード後に古いキャッシュ済みビルドを配信する](/ja/2026/09/fix-flutter-web-serves-a-stale-cached-build-after-reload/) では、同じホスト設定の中で COOP/COEP と並んで置かれる `Cache-Control` ヘッダーを扱っています。
- [Flutter 3.47 でデスクトップの既定レンダラーが Impeller になりました](/ja/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/) では、同じリリースでのもう 1 つのレンダラー切り替えを扱っています。

## 参考資料

- [Support for WebAssembly (Wasm)](https://docs.flutter.dev/platform-integration/web/wasm): ブラウザーのサポート、必要なヘッダー、遅延読み込みのフラグ。
- [Flutter web app initialization](https://docs.flutter.dev/platform-integration/web/initialization): `canvasKitVariant`、`forceSingleThreadedSkwasm`、その他のローダーの config オプション。
- 3.47.4 時点のローダーとエンジンのソース: [`browser_environment.js`](https://github.com/flutter/flutter/blob/3.47.4/engine/src/flutter/lib/web_ui/flutter_js/src/browser_environment.js)、[`loader.js`](https://github.com/flutter/flutter/blob/3.47.4/engine/src/flutter/lib/web_ui/flutter_js/src/loader.js)、[`skwasm_loader.js`](https://github.com/flutter/flutter/blob/3.47.4/engine/src/flutter/lib/web_ui/flutter_js/src/skwasm_loader.js)、[`canvaskit_loader.js`](https://github.com/flutter/flutter/blob/3.47.4/engine/src/flutter/lib/web_ui/flutter_js/src/canvaskit_loader.js)。
- 3.47.4 時点のツールのソース: [`build_web.dart`](https://github.com/flutter/flutter/blob/3.47.4/packages/flutter_tools/lib/src/commands/build_web.dart)、[`compile.dart`](https://github.com/flutter/flutter/blob/3.47.4/packages/flutter_tools/lib/src/web/compile.dart)、[`resident_web_runner.dart`](https://github.com/flutter/flutter/blob/3.47.4/packages/flutter_tools/lib/src/isolated/resident_web_runner.dart)。
- [flutter/flutter#190039](https://github.com/flutter/flutter/issues/190039)、[PR #190048](https://github.com/flutter/flutter/pull/190048)、[PR #192115](https://github.com/flutter/flutter/pull/192115): マルチスレッド skwasm のクラッシュ、その修正、クローズされた stable への cherry-pick。
- [Flutter 3.47.0 release notes](https://docs.flutter.dev/release/release-notes/release-notes-3.47.0): `verboseBuildSelection`、CanvasKit の Chromium バリアントからのコーデック削除。
- [PR #159314](https://github.com/flutter/flutter/pull/159314): `--web-renderer` フラグの削除。
- [Mozilla bug 1788206](https://bugzilla.mozilla.org/show_bug.cgi?id=1788206) と [WebKit bug 267291](https://bugs.webkit.org/show_bug.cgi?id=267291): Firefox と Safari が Wasm の許可リストに含まれていない理由。
