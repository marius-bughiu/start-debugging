---
title: "Flutter 3.47 で Impeller が Windows、Linux、macOS の既定レンダラーになりました"
description: "Flutter 3.47.0 stable は、runner のコードを 1 行も変えないままデスクトップアプリを Skia から Impeller に切り替えます。何が変わるのか、各プラットフォームでの無効化方法、そしてその無効化が一時的な理由を解説します。"
pubDate: 2026-08-16
tags:
  - "flutter"
  - "dart"
  - "impeller"
  - "windows"
lang: "ja"
translationOf: "2026/08/flutter-3-47-impeller-default-renderer-on-desktop"
translatedBy: "claude"
translationDate: 2026-08-16
---

Flutter 3.47.0 は 2026-08-12 に stable チャネルへ到達し、Dart 3.13.0 を同梱しています。注目の多くは独立パッケージ `material_ui` と `cupertino_ui` のバージョン 1.0 に集まっており、これは [Flutter 3.44](/ja/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/) で始まった分離の続きです。しかし、アプリの描画そのものを実際に変える変更はもっと静かに入っています。Impeller が Windows、Linux、macOS で既定のレンダラーになりました。

## プロジェクト側は何も変わらず、それこそが問題です

デスクトップの runner はリポジトリ内に置かれる生成コードなので、レンダラーの切り替えはレビューできるテンプレートの差分として届くはずだと考えたくなります。実際には届きません。Flutter 3.44 の Windows のエントリーポイントは次のとおりで、レンダラーを選択する記述はどこにもありません。

```cpp
flutter::DartProject project(L"data");

std::vector<std::string> command_line_arguments = GetCommandLineArguments();
project.set_dart_entrypoint_arguments(std::move(command_line_arguments));
```

`ImpellerSwitch` は 3.44 の SDK のどこにも存在しません。3.47 へ更新しても `windows\runner\main.cpp` はバイト単位で同一のまま残り、その下で既定値だけが変わります。更新後に Windows や Linux のビルドで表示の劣化が出たときは、ウィジェットツリーではなくレンダラーを最初に確認してください。

## プラットフォームごとの無効化方法

ローカルでのデバッグなら、1 つのフラグで 3 つのデスクトッププラットフォームすべてに対応できます。

```bash
flutter run --no-enable-impeller
```

デプロイするビルドでは runner を編集する必要があります。Windows は `windows\runner\main.cpp` です。

```cpp
flutter::DartProject project(L"data");
project.set_impeller_switch(flutter::ImpellerSwitch::Disabled);
```

Linux は `linux/runner/my_application.cc` です。

```c
g_autoptr(FlDartProject) project = fl_dart_project_new();
fl_dart_project_set_enable_impeller(project, FALSE);
```

macOS は `Info.plist` の最上位の `<dict>` に追加します。

```xml
<key>FLTEnableImpeller</key>
<false />
```

3 つとも一時しのぎと考えてください。[Impeller のドキュメント](https://docs.flutter.dev/perf/impeller)には、無効化する手段は将来のリリースで削除されると明記されています。iOS と Android がすでに通ってきたのと同じ流れです。リリースを通すためにスイッチを使い、そのうえで描画のバグを報告してください。

## 切り替えで得られるもの

Impeller は Skia の OpenGL 経路を通らず、macOS では Metal、Windows と Linux では Vulkan を対象にします。具体的な利点はシェーダーの扱いにあります。Impeller はシェーダーを初回使用時ではなくビルド時に事前コンパイルするため、デスクトップでもモバイルでもユーザーが何年も不満を述べてきた初回実行時のカクつきが解消されます。Flutter 3.47 では macOS、Linux、Windows でテキストとベクター曲線に符号付き距離場レンダリングも有効になり、グリフの輪郭と曲線がより鮮明になります。macOS では広色域カラーが既定で有効です。

## 更新前に読んでおきたい 3.47 のその他の変更

- 最小デプロイターゲットが Xcode 27 対応のため iOS 15 と macOS 12 に上がります。
- Widget Previews が stable に到達します。
- Win32 と Linux がポップアップウィンドウをサポートし、ウィンドウ API では `preferredSize` が `size` に、`preferredConstraints` が `constraints` に改名されます。
- 新規の Android プロジェクトは AGP 9 以降と Kotlin 組み込みサポートのテンプレートを使います。

全体の一覧は [Flutter 3.47.0 のリリースノート](https://docs.flutter.dev/release/release-notes/release-notes-3.47.0)と[発表記事](https://flutter.dev/blog/whats-new-in-flutter-3-47)にあります。デスクトップ向けの Flutter アプリを配布しているなら、SDK のバージョン更新をマージする前に視覚回帰テストを実行してください。
