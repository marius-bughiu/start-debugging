---
title: "Flutter 3.47.1 は推移的なパッケージがアプリにネイティブコードを注入するのを防ぎます"
description: "3.47.1 のホットフィックスは、プラグインのクラス名とパッケージ識別子が GeneratedPluginRegistrant に到達する前に検証します。塞がれた穴、それを塞ぐ正規表現、そしてこのリリースに含まれる他の 11 件の修正を解説します。"
pubDate: 2026-08-21
tags:
  - "flutter"
  - "dart"
  - "security"
  - "flutter-tools"
lang: "ja"
translationOf: "2026/08/flutter-3-47-1-blocks-plugin-registrant-code-injection"
translatedBy: "claude"
translationDate: 2026-08-21
---

Flutter 3.47.1 は 2026-08-19 に stable チャンネルへ到着し、Dart 3.13.1 を同梱しています。[3.47.0 が Impeller をデスクトップのデフォルトレンダラーにしてから](/ja/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/)ちょうど 1 週間後です。12 件という規模は Flutter のホットフィックスとしては大きく、そのうち 1 件はクラッシュ修正ですらありません。`flutter_tools` に存在するビルド時のサプライチェーンの穴です。

## プラグイン識別子がエスケープされずに生成ネイティブコードへ入っていました

`flutter pub get` や `flutter build` を実行すると、ツールは推移的な依存グラフをたどり、プラットフォームごとに `GeneratedPluginRegistrant` を書き出します。各プラグインの `pubspec.yaml` にある `pluginClass` と Android の `package` の値は、そのファイルへそのまま補間されます。Java なら `new {{package}}.{{class}}()`、Swift なら `{{prefix}}{{class}}.register(...)`、Objective-C なら `#import <{{name}}/{{class}}.h>` といったテンプレートの中です。テンプレートレンダラーは `htmlEscapeValues` を `false` にして動作するため、途中で何もエスケープされません。

検証はこれらのフィールドが文字列かどうかしか見ていませんでした。ローカルの 3.44.2 SDK で確認したところ、`AndroidPlugin.validate` は今なお型チェックだけです。

```dart
static bool validate(YamlMap yaml) {
  return (yaml['package'] is String && yaml[kPluginClass] is String) ||
      yaml[kDartPluginClass] is String ||
      yaml[kFfiPlugin] == true ||
      yaml[kDefaultPackage] is String;
}
```

セミコロン、波かっこ、改行を含む文字列でもこのチェックは通ります。したがって次のような宣言を持つ依存パッケージは、それに依存するあらゆるアプリへ任意のネイティブコードをコンパイルさせられます。

```yaml
flutter:
  plugin:
    platforms:
      macos:
        pluginClass: "SomePlugin(); evilInjectedCall(); if (false) { SomePlugin"
```

急いでパッチを当てる価値があるのは、その到達範囲のためです。プラグインは `computeTransitiveDependencies` によって収集され、利用側のアプリによるオプトインは一切ありません。依存ツリーの 3 階層下にあるパッケージでも発動でき、ペイロードはアプリの実行時ではなく、開発マシンや CI ランナー上のビルド時に走ります。レビューで捕まえられる場所ではありません。

## 3.47.1 が代わりに課すもの

[PR 191294](https://github.com/flutter/flutter/pull/191294) は識別子のパターンを追加し、宣言を有効にしたフィールドだけでなく、存在するすべての識別子フィールドへ適用します。

```dart
final RegExp _pluginIdentifierPattern = RegExp(
  r'^[a-zA-Z_$][a-zA-Z0-9_$]*(\.[a-zA-Z_$][a-zA-Z0-9_$]*)*$',
);
```

Dart のソースパスには別のルールがあります。`fileName` と `dartFileName` は `import` 文の中へ補間されるためです。`RegExp(r'^\w[\w./-]*\.dart$')` に加えて、`..` を含む値は明示的に拒否されます。

失敗の現れ方はプラットフォームごとに異なります。Android、iOS、macOS、Linux、Windows で不正な識別子があると `validate` が false を返し、`Invalid plugin specification <name>` が出ます。Web プラグインはより具体的なツール終了で失敗し、`The plugin <name> has an invalid pluginClass in its web plugin declaration.` となります。プラグインをメンテナンスしていて 3.47.1 で突然ビルドが失敗するようになった場合は、宣言したクラスがドット区切りの素の識別子になっているか確認してください。

## 残りの 11 件

ホットフィックスの残りはほとんどがツールまわりの細かな不便ですが、2 件はそれだけでアップグレードの理由になります。WASM の Web ビルドで hot restart が修正され ([flutter/186445](https://github.com/flutter/flutter/issues/186445))、ルートパッケージの `lib/` 配下に置かれた pub workspace メンバーパッケージへの編集を hot reload が無視しなくなりました ([flutter/190284](https://github.com/flutter/flutter/issues/190284))。ほかにも、iOS と macOS のマルチターゲット並列ビルド中に `FileSystemException` を投げていた SwiftPM の競合状態、Unicode 文字を含むパスでの Windows における `impellerc` のクラッシュ、VM service が接続する前に対象プロセスが終了したときのデバッグアダプターのデッドロック、そして Linux と Windows の release ビルドにおける Flutter GPU のプロジェクト単位のオプトインが含まれます。

```bash
flutter channel stable
flutter upgrade
```

完全な一覧は [Flutter のホットフィックス changelog](https://github.com/flutter/flutter/blob/main/CHANGELOG.md) にあります。
