---
title: "Flutter の Windows / Linux デスクトップアプリを Impeller に移行する (Flutter 3.47)"
description: "Flutter 3.47 では Windows と Linux の既定レンダラーが Impeller になります。内部で実際に何が変わるのか (依然として Vulkan ではなく OpenGL ES です)、ビルド済みバイナリで Skia と A/B テストする方法、リリースビルド向けのマシン単位のキルスイッチ、そしてゴールデンテストが変化に気づかない理由を解説します。"
pubDate: 2026-10-08
updatedDate: 2026-10-08
template: migration
tags:
  - "migration"
  - "flutter"
  - "impeller"
  - "windows"
  - "linux"
lang: "ja"
translationOf: "2026/10/migrate-a-flutter-windows-or-linux-desktop-app-to-impeller"
translatedBy: "claude"
translationDate: 2026-10-08
---

Flutter 3.47.0 (2026 年 8 月 12 日から stable、Dart 3.13) では、ランナーのコードを 1 行も変更しなくても、Windows と Linux のデスクトップアプリのレンダラーが Skia から Impeller に切り替わります。ほとんどのアプリでは、移行は半日で終わります。アップグレードし、エンジンのログに `Using the Impeller rendering backend (OpenGLESSDF)` と出ていることを確認し、`--no-enable-impeller` で実行した場合とスクリーンショットやフレーム時間を比較します。そのうえで、Impeller のまま出荷するか、`windows/runner/main.cpp` または `linux/runner/my_application.cc` で一時的に Skia に固定するかを決めます。壊れるのは主に見た目です。テキストのラスタライズ (Impeller はデスクトップで符号付き距離フィールド (SDF) テキストを強制し、さらに新しいガンマ補正が加わります)、暗黙の MSAA を持たない GPU でのアンチエイリアス、そして一部のカスタムシェーダーです。以下の内容はすべて、Flutter 3.47.0 のエンジンと `flutter_tools` のソースで確認しています。

## アプリの下で実際に何が変わるのか

まず知っておくべきなのは、何が変わらないかです。それはグラフィックス API です。Windows 向けエンベッダーは、今も ANGLE 経由で OpenGL ES を使って描画し、ANGLE がそれを Direct3D 11 に変換します。3.47.0 の `flutter_windows_engine.cc` は、レンダラーに関係なく `egl::Manager` と `CompositorOpenGL` を作成します。また Linux 向けエンベッダーが認識するレンダラーの種類は `opengl` と `software` の 2 つだけです。どちらのデスクトップ向けエンベッダーにも Vulkan のパスはありません。デスクトップ上の Impeller は、以前 Skia が使っていたのと同じ GL コンテキスト上で動く、Impeller の GLES バックエンドです。macOS では Impeller の Metal バックエンドになります。

変わるのは、GL 呼び出しより上のすべてです。

- **シェーダーは事前コンパイルされます。** Impeller は、初回使用時にシェーダーを生成してコンパイルする代わりに、あらかじめビルドされた固定のシェーダーセットを同梱しています。Skia の初回実行時のジャンクの原因は、この初回コンパイルでした。
- **テキストは SDF で描画されます。** Windows では、Impeller が有効な場合、自分でスイッチを渡していない限り、エンベッダーが `--impeller-use-sdfs=true` を付加します。Linux では `--impeller-use-sdfs` を無条件に付加します。3.47 のリリースノートでは、両プラットフォームにグリフのガンマ補正も追加されています ([#187122](https://github.com/flutter/flutter/pull/187122)、[#187871](https://github.com/flutter/flutter/pull/187871))。
- **既定値はプロジェクトではなくエンジンのコードの中にあります。** `ImpellerSwitch::Default` は "エンジンが決めた通りにする" という意味で、3.47 では Windows で `true` ([#188140](https://github.com/flutter/flutter/pull/188140))、Linux では `fl_dart_project_init` 内の `TRUE` ([#187573](https://github.com/flutter/flutter/pull/187573)) になります。生成されるランナーは 3.44 とバイト単位で同一です。

最後の点が、意図的な移行作業が必要な理由です。レンダラーが変わったことは、差分のどこにも表れないため、レビュアーは気づけません。

## 何が壊れるのか

| 領域 | 3.47 での変更 | 深刻度 |
| --- | --- | --- |
| テキストレンダリング | SDF グリフとガンマ補正。グリフの輪郭や太さがわずかに変わります | 中 |
| アンチエイリアス | 暗黙の MSAA を持たない Windows の GPU ではオフスクリーン MSAA パスが必要です ([#190374](https://github.com/flutter/flutter/pull/190374)、3.47 にチェリーピック済み) | 中 |
| 統合テストのスクリーンショット | Skia で取得したベースラインとのピクセル差分が出ます | 中 |
| カスタムフラグメントシェーダー | `impellerc` が GLES ターゲット向けにコンパイルします。ドライバー固有のバグの現れ方が変わります | 低から中 |
| `flutter test` のゴールデン | 既定では影響なし (注意点を参照) | なし |
| ランナーのコード | テンプレートの変更なし。オプトアウトには手動での編集が必要です | 低 |

## 事前チェックリスト

- Skia のベースラインをビルドできるよう、Flutter 3.44.x がどこかにインストールされていること (FVM、2 つ目のチェックアウト、CI イメージなど)。すでに[1 つの CI パイプラインから複数の Flutter バージョンを実行している](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)場合は、古いものを置き換えるのではなく、3.47 を新しい系統として追加してください。
- 実際にサポートするマシンの一覧。最低でも、Intel 内蔵 GPU を搭載した Windows マシン 1 台、NVIDIA または AMD の独立 GPU を搭載したマシン 1 台、Mesa ドライバーを使う Linux マシン 1 台を含めてください。VM と RDP セッションは、それぞれ別の行として扱う価値があります。
- 描画に負荷をかける画面をいくつか。文字が密集した画面、回転または拡大縮小されたテキスト、カスタムペインター、ぼかしと影、`FragmentProgram` シェーダーなどです。
- 同じコードベースから macOS も出荷している場合は、3.47 で最低要件が macOS 12 に引き上げられる点に注意してください。これは同じ SDK 更新で遭遇する[別の移行](/ja/2026/09/raise-a-flutter-macos-apps-minimum-deployment-target-to-macos-12-for-xcode-27/)です。

## 移行手順

1. **3.44 で Skia のベースラインを取得します。** プロファイルバイナリをビルドし、各対象マシンで負荷の高い画面のスクリーンショットを撮ります。

   ```bash
   # Flutter 3.44.x
   flutter build windows --profile
   flutter build linux --profile
   ```

   フレーム時間も記録してください。起動後 10 秒間と、最も重いスクロールの[DevTools パフォーマンストレース](/ja/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/)があれば十分です。確認: マシンごとにトレース 1 つとスクリーンショット一式がそろっていること。

2. **3.47 にアップグレードして再ビルドします。**

   ```bash
   flutter upgrade
   flutter --version   # expect Flutter 3.47.x, Dart 3.13.x
   flutter clean
   flutter build windows --profile
   ```

   確認: `git status` で `windows/runner/` や `linux/runner/` 配下に変更が出ていないこと。変更がある場合は、誰かが `flutter create .` を実行したということなので、その差分は別途レビューしてください。

3. **エンジンがどのバックエンドを選んだか確認します。** `flutter run -d windows` (または `-d linux`) でアプリを実行し、エンジンの起動ログを探します。

   ```text
   [IMPORTANT:flutter/shell/platform/embedder/embedder_surface_gl_impeller.cc(126)] Using the Impeller rendering backend (OpenGLESSDF).
   ```

   `OpenGLESSDF` は SDF テキスト付きの Impeller を意味し、両プラットフォームで期待される結果です。代わりに `Could not create Impeller context.` と出た場合は、GL コンテキストが Impeller の要件を満たせなかったということで、何よりも先にドライバーの問題を調べる必要があります。エンベッダーのサーフェスには Skia への暗黙のフォールバックがなく、Impeller サーフェスは単に無効になるだけである点に注意してください。確認: この行がウィンドウごとに 1 回だけ表示されること。

4. **同じバイナリで Skia と A/B 比較します。** `flutter run` では、このフラグがすべてのデスクトッププラットフォームで使えます。

   ```bash
   flutter run -d windows --profile --no-enable-impeller
   ```

   ビルド済みのデバッグまたはプロファイルのバイナリでは、エンジンスイッチの環境変数でレンダラーを切り替えられます。どちらのデスクトップ向けエンベッダーも `GetSwitchesFromEnvironment()` を通じてこれを読み取ります。

   ```powershell
   # Flutter 3.47, Windows, debug or profile build only
   $env:FLUTTER_ENGINE_SWITCHES = "1"
   $env:FLUTTER_ENGINE_SWITCH_1 = "enable-impeller=false"
   .\build\windows\x64\runner\Profile\my_app.exe
   ```

   ```bash
   # Flutter 3.47, Linux, debug or profile build only
   FLUTTER_ENGINE_SWITCHES=1 FLUTTER_ENGINE_SWITCH_1=enable-impeller=false \
     ./build/linux/x64/profile/bundle/my_app
   ```

   これは、テスターに 1 つのビルドと 2 つのショートカットを渡すいちばん手早い方法です。確認: スイッチを設定すると起動ログの行が消え、設定しないと戻ってくること。

5. **スクリーンショットとトレースを比較します。** 3.44 の Skia、3.47 の Skia、3.47 の Impeller のスクリーンショットを並べます。有用なのは 3.47 の Skia と 3.47 の Impeller の比較です。リリースに含まれる他のあらゆる変更からレンダラーだけを切り分けられるからです。テキストはどこでも少し違って見えるはずです。見るべきは、違いではなく誤りです。欠けたグリフ、消えた影、角丸四角形のギザギザしたエッジ、黒い領域などです。確認: すべての違いが、許容されたか、最小の再現コードを持っているかのどちらかであること。

6. **判断し、必要ならランナーで Skia に固定します。** 実際のリグレッションを見つけた場合は、デプロイするビルドで Impeller を無効にします。Windows では `windows/runner/main.cpp` に次のように書きます。

   ```cpp
   // Flutter 3.47, windows/runner/main.cpp
   flutter::DartProject project(L"data");
   project.set_impeller_switch(flutter::ImpellerSwitch::Disabled);
   ```

   Linux では `linux/runner/my_application.cc` の `fl_view_new(project)` より前に書きます。

   ```c
   // Flutter 3.47, linux/runner/my_application.cc
   g_autoptr(FlDartProject) project = fl_dart_project_new();
   fl_dart_project_set_enable_impeller(project, FALSE);
   ```

   確認: 再ビルドして実行し、`Using the Impeller rendering backend` の行が消えていること。

7. **その日のうちにバグを報告します。** [Impeller のドキュメント](https://docs.flutter.dev/perf/impeller)によると、iOS と同様に、オプトアウトは将来のリリースで削除される予定です。タイトルに `[Impeller]` の接頭辞を付け、最小の再現コード、GPU とドライバーのバージョン、スクリーンショット、zip 化したパフォーマンストレースを添えて issue を作成してください。確認: issue へのリンクが、オプトアウト行の隣のコメントに入っていること。後でそれを削除する人が、なぜそこにあるのか分かるようにするためです。

## リリースビルド向けのマシン単位のキルスイッチ

手順 4 の `FLUTTER_ENGINE_SWITCHES` の方法は、リリースビルドでは機能しません。`engine_switches.cc` が参照処理全体を `#ifndef FLUTTER_RELEASE` で囲んでいるため、出荷されたアプリはこれを無視します。Impeller で出荷しつつ、2017 年のノート PC で黒いウィンドウが表示される特定の顧客のために逃げ道を残しておきたい場合は、ランナー内で独自の環境変数を読み取ってください。

```cpp
// Flutter 3.47, windows/runner/main.cpp
#include <cwchar>

flutter::DartProject project(L"data");

wchar_t value[8];
DWORD length = ::GetEnvironmentVariableW(L"MYAPP_DISABLE_IMPELLER", value, 8);
if (length > 0 && length < 8 && std::wcscmp(value, L"1") == 0) {
  project.set_impeller_switch(flutter::ImpellerSwitch::Disabled);
}
```

```c
// Flutter 3.47, linux/runner/my_application.cc
g_autoptr(FlDartProject) project = fl_dart_project_new();
if (g_strcmp0(g_getenv("MYAPP_DISABLE_IMPELLER"), "1") == 0) {
  fl_dart_project_set_enable_impeller(project, FALSE);
}
```

これでサポート担当は、新しいビルドを待たずに、影響を受けたユーザーに変数を 1 つ設定してもらうだけで済みます。ユーザーにとって環境変数が扱いにくい場合は、レジストリ値や実行ファイルの隣にある設定ファイルの 1 行でも同じように機能します。これは、エンジンのオプトアウトと同じ寿命を持つ一時的な足場として扱ってください。

## 検証

移行後、マトリクス内のすべてのマシンで次を確認します。

- アプリが起動し、ログに `OpenGLESSDF` が表示されること (Skia に固定した場合は Impeller の行がまったく表示されないこと)。
- 統合テストが通ること。スクリーンショットベースのテストには新しいベースラインが必要です。一括の "update goldens" 実行で実際のリグレッションを覆い隠してしまわないよう、3.47 上で意図的に再生成してください。
- 新規インストール後の初回起動で、タイムラインにシェーダーコンパイルによるジャンクがないこと。これは対価を払って得る改善なので、必ず計測してください。
- 最も重い画面での定常状態のフレーム時間が、予算内に収まっていること。Impeller がすべてのフレームで一様に速いわけではなく、より予測しやすいということです。
- Linux でウィンドウを素早くリサイズしてもクラッシュしないこと (リサイズ時のクラッシュは 3.47 の開発サイクル中に [#187626](https://github.com/flutter/flutter/pull/187626) で修正されており、古いベータ版をチェリーピックしないほうがよい理由の 1 つです)。

## ロールバック計画

ロールバックは安価で、どちらの方向にも元に戻せます。Windows と Linux で Impeller を既定で有効にしたことがない 3.44.x にダウングレードするか、3.47 にとどまって手順 6 のランナーのオプトアウトを追加するかのどちらかです。後者のほうが優れています。3.47 の他の修正をすべて維持でき、1 行を削除するだけで元に戻せるからです。ただし、オプトアウトが永久に存在することを前提にした計画は立てないでください。

## 注意点

**Windows では、環境スイッチがプロジェクトのスイッチより優先されます。** `FlutterWindowsEngine` のコンストラクターでは、まずプロジェクトの `ImpellerSwitch` が読み込まれ、その後の環境スイッチのループがそれを上書きします。シェルのプロファイルに `FLUTTER_ENGINE_SWITCH_1=enable-impeller=true` を残している開発者は、`Disabled` に固定したブランチでも Impeller が使われます。他の何かをデバッグする前に、まず `env` を確認してください。

**`ImpellerSwitch::Default` は `Enabled` ではありません。** 将来のリリースがどう決めようと Impeller を常に有効にしたい場合は、`ImpellerSwitch::Enabled` を明示的に設定してください。`Default` はエンジンに従うもので、これこそが 3.47 で足元から切り替わったものです。

**`flutter test` のゴールデンは Impeller を見ていません。** `flutter_tester_device.dart` は、`--enable-impeller` を渡さない限り、`--enable-software-rendering --skia-deterministic-rendering` でテストシェルを起動します。ウィジェットテストのゴールデンはアップグレード後も通り続けますが、それはデスクトップのレンダラーについて何も教えてくれません。Impeller を実際に動かすのは、本物の `.exe` や Linux バンドルを実行する統合テストだけです。

**Linux のオプトアウトは、ビューが存在する前に行う必要があります。** `fl_dart_project_set_enable_impeller` は、`FlEngine` が起動時に読み取るフィールドを設定します。`my_application_activate` の後ろのほうではなく、`fl_dart_project_new()` の直後、`fl_view_new(project)` の前に呼び出してください。

**ハイブリッド GPU のノート PC では、レンダラーより先に GPU が選ばれます。** Windows では、`DartProject::set_gpu_preference` に `flutter::GpuPreference::HighPerformancePreference` または `LowPowerPreference` を指定することで、ANGLE がどのアダプターを使うかが決まります。Intel と NVIDIA の両方の GPU を搭載したノート PC でしか再現しないリグレッションがある場合は、Impeller のせいにする前に、両方の設定でテストしてください。

**VM とリモートセッション。** 暗黙の MSAA に対応していないマシンでは、3.47 の開発サイクルの序盤に Windows で黒い画面が発生していました。[#187288](https://github.com/flutter/flutter/pull/187288) と、[#190374](https://github.com/flutter/flutter/pull/190374) のオフスクリーン MSAA フォールバックで対処されています。VM で黒いウィンドウが表示される場合は、新しい issue を報告する前に、最新の 3.47 パッチを使っていることを確認してください。

**カスタムシェーダー。** `FragmentProgram` シェーダーは引き続き動作しますが、今後は ANGLE や Mesa が公開しているドライバー上で、Impeller の GLES バックエンドによって実行されます。サポートする最も古い GPU で、すべての `.frag` ファイルを再テストし、Skia では偶然うまく動いていた精度の挙動に依存しないようにしてください。

**オプトアウトにはタイマーが付いています。** 追加するオプトアウトはどれも、期限を自分では決められない負債です。issue へのリンクを隣に置き、Flutter をアップグレードするたびに見直してください。

## 関連記事

- この変更の公開日のまとめ: [Flutter 3.47 makes Impeller the default renderer on Windows, Linux, and macOS](/ja/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/)。
- 移行前後の計測: [how to profile jank in a Flutter app with DevTools](/ja/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/)。
- 3.44 と 3.47 を並行して実行する: [targeting multiple Flutter versions from one CI pipeline](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)。
- 同じリリースにおけるもう 1 つのデスクトップ移行: [raising a Flutter macOS app's deployment target to macOS 12](/ja/2026/09/raise-a-flutter-macos-apps-minimum-deployment-target-to-macos-12-for-xcode-27/)。
- Web における同等のレンダラー選択: [CanvasKit vs skwasm for Flutter web in 2026](/ja/2026/09/canvaskit-vs-skwasm-for-flutter-web-in-2026/)。

## 参考資料

- docs.flutter.dev の [Impeller rendering engine](https://docs.flutter.dev/perf/impeller) (デスクトップの状況、オプトアウトのスニペット、バグ報告のチェックリスト)。
- [Flutter 3.47.0 release notes](https://docs.flutter.dev/release/release-notes/release-notes-3.47.0)。
- [flutter/flutter#188140](https://github.com/flutter/flutter/pull/188140): Windows で Impeller を既定のレンダラーにします。
- [flutter/flutter#187573](https://github.com/flutter/flutter/pull/187573): Linux で Impeller を既定で有効にします。
- [flutter/flutter#188044](https://github.com/flutter/flutter/pull/188044): Windows のプロジェクトスイッチを追加します。
- [flutter/flutter#187288](https://github.com/flutter/flutter/pull/187288): Windows の OpenGL パスでの黒い画面を修正します。
- Flutter 3.47.0 のソース: `engine/src/flutter/shell/platform/windows/flutter_windows_engine.cc`、`engine/src/flutter/shell/platform/linux/fl_engine.cc`、`engine/src/flutter/shell/platform/common/engine_switches.cc`、`packages/flutter_tools/lib/src/test/flutter_tester_device.dart`。
