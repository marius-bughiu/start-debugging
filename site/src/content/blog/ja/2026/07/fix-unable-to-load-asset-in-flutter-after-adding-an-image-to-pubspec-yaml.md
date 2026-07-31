---
title: "解決: pubspec.yaml に画像を追加した後に Flutter で Unable to load asset が出る"
description: "アセットのキーがディスクではなくコンパイル済みバンドルに存在しません。pubspec のインデント、末尾のスラッシュ、キーの一致を直して完全に再起動します。"
pubDate: 2026-07-31
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "pubspec"
  - "assets"
lang: "ja"
translationOf: "2026/07/fix-unable-to-load-asset-in-flutter-after-adding-an-image-to-pubspec-yaml"
translatedBy: "claude"
translationDate: 2026-07-31
---

ファイルはディスク上にあり、パスも正しく見えるのに、Flutter は読み込めないと言い続けます。これはメッセージがディスクの話をしていないからです。渡したキーが、コンパイル済みのアセットバンドルに存在しません。頻度の高い順に、原因は `assets:` ブロックが `flutter:` の下にインデントされていない、ディレクトリのエントリに末尾の `/` がない、宣言していないサブディレクトリにファイルがある、キーの大文字小文字がファイル名と違う、完全な再起動が必要な場面でホットリロードした、のいずれかです。`pubspec.yaml` を直し、アプリを停止して、もう一度実行してください。

```text
======== Exception caught by image resource service ================================================
The following assertion was thrown resolving an image codec:
Unable to load asset: "assets/images/logo.png".
The asset does not exist or has empty data.

When the exception was thrown, this was the stack:
#0      PlatformAssetBundle.load (package:flutter/src/services/asset_bundle.dart:271:7)
<asynchronous suspension>
#1      AssetBundleImageProvider._loadAsync (package:flutter/src/painting/image_provider.dart:951:14)
```

この記事は Flutter 3.44.7 と Dart 3.12.2、2026-07-20 時点の stable チャネルを対象としています。ここで説明する挙動は Flutter 3.16 がアセットマニフェストの形式を変更して以来安定しており、pubspec のルールは何年も変わっていません。

## このエラーが実際に意味すること

`Image.asset('assets/images/logo.png')` はファイルを開きません。文字列のキーをフレームワークに渡し、フレームワークはアプリのアセットバンドル内でそのキーに登録されたバイト列をエンジンに要求します。エンジンが null または長さ 0 のバッファーを返した瞬間に、`PlatformAssetBundle.load` が例外をスローします。

```dart
// flutter/lib/src/services/asset_bundle.dart, Flutter 3.44.7
throw FlutterError.fromParts(<DiagnosticsNode>[
  _errorSummaryWithKey(key),
  ErrorDescription('The asset does not exist or has empty data.'),
]);
```

このバンドルは、`flutter` ツールが `pubspec.yaml` の `flutter: assets:` セクションから一度だけ生成します。そこに列挙されたものはすべて `build/flutter_assets/` にコピーされ、`AssetManifest.bin` というマニフェストにインデックスされ、エンジンが起動時に読み込みます。実行中のアプリにとって、ファイルシステム上のそれ以外のものは存在しません。

つまり独立した 2 つの条件がそろう必要があり、エラーはどちらが誤っているかを教えてくれません。

1. pubspec の宣言がファイルをバンドルに入れていること。
2. Dart コードのキーがバンドルのキーとバイト単位で一致していること。

以下の原因はすべて、このどちらかが崩れたものです。

## 最小の再現コード

```
my_app/
  pubspec.yaml
  assets/
    images/
      logo.png
  lib/
    main.dart
```

```yaml
# pubspec.yaml, Flutter 3.44.7
name: my_app

flutter:
  uses-material-design: true
  assets:
    - assets/images/logo.png
```

```dart
// lib/main.dart, Flutter 3.44.7, Dart 3.12.2
import 'package:flutter/material.dart';

void main() => runApp(
      const MaterialApp(
        home: Scaffold(
          body: Center(child: Image.asset('assets/images/logo.png')),
        ),
      ),
    );
```

これは動きます。以下に挙げるやり方でどれか 1 行を壊せば、ほかに何の手がかりもないまま同じエラーが出ます。

## 原因 1: assets ブロックが flutter の下にネストされていない

最も多く、最も厄介な失敗です。何も文句を言わないからです。`flutter pub get` は成功し、ビルドも成功し、アプリは空のバンドルで起動します。

```yaml
# Wrong. Valid YAML, silently ignored.
flutter:
  uses-material-design: true
assets:
  - assets/images/logo.png
```

トップレベルの `assets:` は、Flutter ツールが読まないキーです。エラーではなく、パーサーにとっては単に他人の設定にすぎません。正しい書き方は、`assets:` を `flutter:` の下にちょうど 2 スペースでインデントし、リスト項目をさらに 2 スペース内側に置きます。

```yaml
# Right.
flutter:
  uses-material-design: true
  assets:
    - assets/images/logo.png
```

これに関連する形として、ファイルの後方にもう 1 つ `flutter:` キーがあるケースがあります。YAML のマッピングは重複キーを持てず、パーサー次第でどちらかが黙って勝ちます。pubspec が場当たり的に育ってきたなら、ほかを調べる前に 0 桁目にある `flutter:` の出現箇所をすべて検索してください。

## 原因 2: 末尾のスラッシュがないディレクトリエントリ、または宣言していないサブディレクトリ

ディレクトリのエントリはディレクトリごとの明示指定であり、再帰的ではありません。アセット追加に関する Flutter のドキュメントより: "Only files located directly in the directory are included. Resolution-aware asset image variants are the only exception. To add files located in subdirectories, create an entry per directory."

したがって画像が `assets/images/icons/` にある場合、これは何の役にも立ちません。

```yaml
flutter:
  assets:
    - assets/images/
```

必要なのはこちらです。

```yaml
flutter:
  assets:
    - assets/images/
    - assets/images/icons/
    - assets/images/illustrations/
```

エントリをディレクトリにするのは末尾のスラッシュです。それがない `- assets/images` は `images` という名前の単一ファイルとして読まれ、そんなファイルは存在しないのでツールのレベルでビルドが失敗します。このメッセージは実際に役に立ちます。

```text
Error: unable to find directory entry in pubspec.yaml: /path/to/my_app/assets/images/
```

これは逆向きにも使えます。ビルドが成功していて、それでも実行時に `Unable to load asset` が出るなら、エントリは何かにマッチしています。その場合の問題は宣言漏れではなくキーの不一致です。

非再帰ルールの唯一の例外は解像度別のバリアントです。`assets/images/logo.png` を宣言すれば、`assets/images/2.0x/logo.png` と `assets/images/3.0x/logo.png` は自動的にバンドルされ、`AssetImage` がデバイスピクセル比に応じて適切なものを選びます。バリアントのディレクトリを自分で宣言することはありません。

## 原因 3: コードのキーとバンドルのキーが一致しない

バンドルのキーは厳密な文字列です。入力からずれる経路は 3 つあります。

**大文字小文字**。開発マシンのファイルシステムは、ほぼ確実に大文字小文字を区別しません (macOS の既定の APFS、Windows の NTFS)。`Image.asset('assets/images/Logo.png')` はローカルでは `logo.png` を解決しますが、Android の実機、iOS、web、Linux の CI ランナーではすべて失敗します。ノート PC ではビルドが通り、それ以外の環境で失敗するなら、まず大文字小文字を確認してください。同じコードなのにマシンによって結果が分かれる現象の説明として、これが最も有力です。

**先頭の `./` や紛れ込んだ空白**。`'./assets/images/logo.png'` は `'assets/images/logo.png'` とは別の文字列で、バンドルには後者しか入っていません。引用符付き YAML 値の末尾の空白も同じ結果になります。

**`packages/` プレフィックス**。依存しているパッケージに同梱されたアセットのキーは `packages/<package_name>/<path>` で、パッケージの `lib/` ディレクトリは暗黙であり決して書きません。`fancy_backgrounds` というパッケージから `lib/assets/bg.png` を読み込むには次のようにします。

```dart
// Flutter 3.44.7. Either form works; they produce the same key.
Image.asset('packages/fancy_backgrounds/assets/bg.png');
Image.asset('assets/bg.png', package: 'fancy_backgrounds');
```

そのパッケージを自分で書いたのなら、パッケージ側の `pubspec.yaml` でもそれらのファイルを宣言する必要があります。依存パッケージのアセットは、ファイルが `.pub-cache` に存在するというだけでバンドルされることはありません。

## 原因 4: 再起動が必要なところでホットリロードした

ホットリロードは実行中の isolate に Dart コードを差し替えます。アセットバンドルとそのマニフェストは、アプリの起動時にツールが生成します。`pubspec.yaml` を編集して新しいエントリを足すとマニフェストが変わりますが、実行中のアプリは起動時のマニフェストを持ち続けます。

セッションを止めて起動し直してください。`r` でも `R` でもありません。

```bash
# Flutter 3.44.7
# Ctrl-C to end the current run, then:
flutter run
```

すでに宣言済みのアセットの*バイト列*を変えた場合はリロード時に再バンドルされるので、これは不要です。宣言済みアセットの*集合*を変えた場合は必要です。

## 原因 5: ディスク上の古い成果物

原因であることは稀で、確認は安く、ネット上のどの回答も最初に勧めるため、実際に引き起こす件数よりもはるかに多く責任を負わされています。iOS では実在する原因で、中途半端に更新された `.app` バンドルがリビルドを生き延びることがあります。

```bash
# Flutter 3.44.7
flutter clean
flutter pub get
flutter run
```

その途中で `flutter pub get` 自体が失敗するなら、それはアセットではなく依存解決の問題で、制約ソルバーの出力を読むのは別の作業です。[pubspec.yaml の version solving failed エラーの読み方](/ja/2026/05/fix-version-solving-failed-in-pubspec-yaml/)を参照してください。

## 推測をやめて、バンドルに実際にあるキーを出力する

これまでの各節はすべて仮説です。1 回の計測でそれらをまとめて置き換えられます。`AssetManifest` は実行時にマニフェストを読むためのサポートされた API で、`AssetManifest.json` が `AssetManifest.bin` に置き換わったときに追加されました。

```dart
// Flutter 3.44.7, Dart 3.12.2
import 'package:flutter/services.dart';

Future<void> dumpAssetKeys() async {
  final manifest = await AssetManifest.loadFromAssetBundle(rootBundle);
  for (final key in manifest.listAssets()..sort()) {
    debugPrint(key);
  }
}
```

`kDebugMode` の判定の内側で `main` から呼び出し、コンソールを読んでください。出力されたものが、エンジンが提供できるすべてです。自分のパスが無ければ原因 1 か 2、自分のパスに酷似したものがあれば原因 3 で、2 つの文字列の差分がそのまま修正内容になります。

`AssetManifest.bin` を自分で解析してはいけません。Flutter はこれを実装の詳細と明記しており、形式は予告なく変わり得ます。また `AssetManifest.json` はもう生成されないため、いまだに `rootBundle.loadString('AssetManifest.json')` を呼ぶコードは、キーが `AssetManifest.json` のまさにこのエラーをスローします。

何も実行せずにバンドルを調べることもできます。

```bash
# Flutter 3.44.7. Writes the bundle the engine would load.
flutter build bundle
ls build/flutter_assets/assets/images/

# Or check what shipped inside a built APK:
unzip -l build/app/outputs/flutter-apk/app-debug.apk | grep flutter_assets
```

## このページにたどり着く類似ケース

- **`Unable to load asset: "fonts/Inter-Regular.ttf"`**。フォントは `assets:` ではなく `flutter: fonts:` の下で宣言し、`TextStyle` のファミリー名はファイル名ではなく `family:` の値と一致させる必要があります。失敗の仕組みと修正の考え方は同じです。
- **`SvgPicture.asset` から出る `Unable to load asset`**。`flutter_svg` は同じ `AssetBundle` を経由して読み込むので、これはパッケージではなくフレームワークのエラーです。上記はすべてそのまま当てはまります。
- **アセットは存在するのに "has empty data"**。この一文は文字どおりに読んでください。よくある犯人は Git LFS です。画像を LFS で管理しているリポジトリを `lfs: true` なしで CI ランナーにチェックアウトすると、PNG のあるべき場所に 130 バイトのテキストポインターが残ります。ビルドは成功し、バンドルにはキーがあり、デコードだけが失敗します。何よりも先にファイルサイズを確認してください。`assets/` を除外する `.gitignore` や `.dockerignore` のルールも同じ「ローカルは通るが CI で落ちる」形になるので、[1 つのパイプラインで複数の Flutter バージョンのビルドを回している](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)ときは除外候補として確認する価値があります。
- **Flutter web でのみ、しかもデプロイ後にだけ壊れる**。アプリをサブパスでホストしているなら、`build/web/index.html` に `<base href="/my-app/">` が必要で、ビルドには `flutter build web --base-href /my-app/` が必要です。これがないとエンジンはドメイン直下から `/assets/...` を要求して 404 を受け取り、それがこのエラーとして表面化します。同じ罠は [`flutter build web --wasm` による WebAssembly ビルド](/ja/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/)にも当てはまります。
- **`flutter test` でのみ壊れる**。`pubspec.yaml` で宣言したアセットはウィジェットテストでも動きます。ツールが `build/unit_test_assets/` を生成し、そのパスを `UNIT_TEST_ASSETS` としてエクスポートし、`mockFlutterAssets()` がそこからキーを提供します。それでも 2 点は壊れます。flavor ごとに条件付きでバンドルされるアセットはこのディレクトリに入りません。また `Image.asset` を描画するゴールデンテストは読み込みの完了を必要とするので、pump を `tester.runAsync` で包むか、比較の前に `precacheImage` を呼んでください。
- **release でのみ壊れ、debug では壊れない**。これはアセットの問題ではありません。キーを組み立てるコードパスがそもそも到達しているか、`const` 文字列がビルドモードによって変わる何かから組み立てられていないかを確認してください。
- **Android のビルドがそもそもバンドル段階まで到達していない**。失敗が実行時ではなくビルド時なら、それは [exit code 1 で失敗した Gradle タスク](/ja/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/)であり、pubspec をいくら直しても解決しません。

一貫した見方はこうです。このエラーは、自分のビルドが生成したデータ構造での検索ミスです。そう扱ってください。`listAssets()` を出力し、渡した文字列と存在する文字列を比べれば、修正は必ずその比較のどちらかの側にあります。

## 関連記事

- [解決: pubspec.yaml の Version solving failed](/ja/2026/05/fix-version-solving-failed-in-pubspec-yaml/)：クリーンリビルドの手順に含まれる `flutter pub get` そのものが失敗する場合の対処。
- [解決: Flutter の Android ビルドで Gradle task assembleDebug failed with exit code 1](/ja/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/)：バンドルが生成されるところまで到達しない、ビルド時側の対応物。
- [WebAssembly で Flutter web アプリをビルドする方法](/ja/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/)：web のアセット URL を壊す base href とホスティングパスの設定を扱っています。
- [1 つの CI パイプラインから複数の Flutter バージョンを対象にする方法](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)：ローカルは通るが CI で落ちるというアセット報告の大半の背後にある、チェックアウトとキャッシュの詳細。
- [解決: Flutter の Container で Cannot provide both a color and a decoration](/ja/2026/07/fix-cannot-provide-both-a-color-and-a-decoration-in-a-flutter-container/)：装飾したボックスの背後に画像を置いた最初のときに出る、もう 1 つのエラー。

## 参考資料

- [Adding assets and images](https://docs.flutter.dev/ui/assets/assets-and-images), Flutter ドキュメント
- [Removal of AssetManifest.json](https://docs.flutter.dev/release/breaking-changes/asset-manifest-dot-json), Flutter ドキュメント
- [`AssetManifest` クラス](https://api.flutter.dev/flutter/services/AssetManifest-class.html), Flutter API リファレンス
- [`asset_bundle.dart`](https://github.com/flutter/flutter/blob/stable/packages/flutter/lib/src/services/asset_bundle.dart), flutter/flutter
- [`_binding_io.dart` と `mockFlutterAssets`](https://github.com/flutter/flutter/blob/stable/packages/flutter_test/lib/src/_binding_io.dart), flutter/flutter
- [Conditionally bundling assets based on flavor makes tests fail](https://github.com/flutter/flutter/issues/150296), flutter/flutter
