---
title: "修正: Xcode 16 と Flutter 3.x で Failed to build iOS app"
description: "60 秒で直す方法: Flutter を 3.24.4 以降にアップグレードし、Podfile のプラットフォームを iOS 13 に上げ、Pods と DerivedData を消してから pod install を実行します。エラーが Dart コードにあることはまれです。"
pubDate: 2026-05-17
tags:
  - "errors"
  - "flutter"
  - "ios"
  - "xcode"
  - "cocoapods"
lang: "ja"
translationOf: "2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x"
translatedBy: "claude"
translationDate: 2026-05-17
---

ひとことで言うと: Xcode 16 へのアップグレード後の `Failed to build iOS app` は、ほとんどの場合あなたの Dart コードが原因ではありません。頻度順に 4 つの原因のいずれかです。Xcode 16 の新しいモジュール検証器を知らない 3.24.4 より古い Flutter SDK、まだ `platform :ios, '11.0'` を固定している `Podfile` (Xcode 16 は iOS 11 シミュレーターのサポートを廃止しました)、前の Xcode で残った `ios/Pods` と `~/Library/Developer/Xcode/DerivedData/ModuleCache.noindex` の古いキャッシュ、または Swift 6 / Xcode 16 互換のリリースをまだ出していないプラグインです。Flutter をアップグレードし、Podfile を iOS 13 に上げ、両方のキャッシュを消して、`pod install` を実行し、ビルドし直してください。`flutter clean` を最初のステップとして頼るのはやめましょう。実際に壊れている iOS のキャッシュには触れません。

```text
Launching lib/main.dart on iPhone 16 Pro in debug mode...
Running Xcode build...
Xcode build done.                                           38.4s
Failed to build iOS app
Error (Xcode): Swift Compiler Error (Xcode): No such module 'Flutter'
/Users/me/MyApp/ios/Runner/AppDelegate.swift:2:8

Could not build the application for the simulator.
Error launching application on iPhone 16 Pro.
```

このガイドは Flutter 3.41.5 (stable チャンネル、2026 年 5 月)、Xcode 16.x ライン (執筆時点で 16.0 から 16.4)、CocoaPods 1.16.2、Apple Silicon 上の macOS Sequoia 15.3 を対象に書かれています。同じ修正は Flutter 3.24.4 以降にも当てはまります。Flutter 3.19 以前を使っている場合は、まずアップグレードのステップを見てください。そのブランチではポッドをいじっても救われません。Xcode 16 をきれいに動かす関連の Flutter の変更は [flutter/flutter#155438](https://github.com/flutter/flutter/issues/155438) に入り、続く modulemap の修正は [flutter/flutter#157461](https://github.com/flutter/flutter/issues/157461) に入りました。

## `Failed to build iOS app` が実際に伝えていること

`Failed to build iOS app` は Flutter ツールの傘メッセージです。これが意味するのは「xcodebuild が非ゼロの終了コードを返した」ということだけです。実際の診断はその直上または直下の `Error (Xcode):` で始まる行です。同じ傘の下に表面化する根本的なエラーはおよそ 6 種類あります。

1. `No such module 'Flutter'` -- Swift コンパイラーが Flutter フレームワークモジュールを見つけられません。ほぼ常に Xcode 16 へのアップグレード後の Podfile または pod install の問題です。
2. `no such file or directory: '.../ModuleCache.noindex/Session.modulevalidation'` -- Xcode 16 の新しいモジュール検証器が Xcode 15 によって書かれたキャッシュファイルを読めません。[issue #157461](https://github.com/flutter/flutter/issues/157461) を参照してください。
3. `Using bridging headers with module interfaces is unsupported` -- Xcode 15 で動いていたプラグインの `module.modulemap` とブリッジングヘッダーのパターンが、今やハードエラーになっています。
4. `type 'UIApplication' does not conform to protocol 'Launcher'` -- 古いプラグイン (一般的に 6.3.0 より前の `url_launcher_ios`) における Swift 6 の厳密適合エラーです。
5. `Undefined symbol: _swift_FORCE_LOAD$_swiftCompatibility56` -- Swift ランタイム ABI の不一致、ほぼ常に以前の Xcode SDK からの CocoaPods キャッシュです。
6. `The iOS deployment target 'IPHONEOS_DEPLOYMENT_TARGET' is set to 11.0, but the range of supported deployment target versions is 12.0 to 18.4` -- `Podfile` がまだ Xcode 16 が削除した iOS 11 を固定しています。

これらはそれぞれ異なる根本原因を持つ別々のバグです。最初の仕事は、ツールが実際にどれにヒットしたかを特定することです。ターミナルを上にスクロールし、ファイルパスと行番号を持つ `error:` の行を見つけてください。それが真実であり、`Failed to build iOS app` は症状です。

## `flutter build` から実際のエラーを読む

`xcodebuild` の下層出力が要約されないように、詳細ログ付きで実行してください。

```bash
# Flutter 3.41.5
flutter build ios --verbose 2>&1 | tee build.log
```

そして最初の `error:` (小文字、これが Xcode のプレフィックスです) をログから探してください。`Error (Xcode)` (これは Flutter による再フォーマット) ではありません。

```bash
grep -n "error:" build.log | head -20
```

最初の一致が修正すべきものです。後続のエラーは通常、最初のものから連鎖したものです。詳細出力がなければ、推測しているだけです。

## 一般的な形態の 1 つを示す最小再現

2026 年に最も一般的な形態は、`Podfile` のプラットフォーム固定と古い `Pods` ディレクトリの組み合わせです。新しい Flutter プロジェクトを作り、iOS deployment target を 11.0 に固定してください。

```ruby
# ios/Podfile, Flutter 3.41.5, CocoaPods 1.16.2
platform :ios, '11.0'

# CocoaPods analytics sends network stats synchronously affecting flutter build latency.
ENV['COCOAPODS_DISABLE_STATS'] = 'true'

project 'Runner', {
  'Debug' => :debug,
  'Profile' => :release,
  'Release' => :release,
}

# ... rest of the default Podfile ...
```

Xcode 16 で `flutter build ios --no-codesign` を実行すると、ビルドは次のエラーで失敗します。

```text
[!] Automatically assigning platform `iOS` with version `11.0` on target `Runner`
    because no platform was specified. Please specify a platform for this target
    in your Podfile.
...
error: The iOS deployment target 'IPHONEOS_DEPLOYMENT_TARGET' is set to 11.0,
       but the range of supported deployment target versions is 12.0 to 18.4.
       (in target 'firebase_core' from project 'Pods')
Failed to build iOS app
```

同じ Podfile が Xcode 15.4 では文句なくビルドされます。バグは Xcode 16 の新しい deployment target の下限であり、あなたのコードではありません。

## 修正、頻度の高い順

これらのステップを順番に適用してください。各ステップは前のステップが効かなかったことを前提としています。

### 1. Flutter を 3.24.4 以降にアップグレードする

Flutter 3.24.4 (2024 年 10 月) は `xcode_backend.sh` と Generated.xcconfig テンプレートへの Xcode 16 修正を出荷した最初の stable リリースです。2026 年の 3.41.x ラインのどのリリースも最新です。何を持っているか確認してアップグレードしてください。

```bash
flutter --version
flutter upgrade
```

チャンネルが `master` であるか、ローカルでエンジンを変更しているために `flutter upgrade` が拒否される場合は、`stable` に戻してください。

```bash
flutter channel stable
flutter upgrade
```

この単一のステップで、2024 年と 2025 年に Xcode 16 に対して提出された `No such module 'Flutter'` の報告の大部分が解決します。Flutter チームはまさにこの理由で [issue #155438](https://github.com/flutter/flutter/issues/155438) を 3.24.4 で修正済みとしてクローズしました。

### 2. Podfile のプラットフォームを iOS 13 に上げる

Xcode 16 は依然として iOS 12 を deployment target としてサポートしますが、最近のプラグインのほとんど (Firebase、Google Maps、SwiftUI を扱う何でも) は今では iOS 13 を要求します。下限を iOS 13 に設定するのが 2026 年の安全なデフォルトです。

```ruby
# ios/Podfile, Flutter 3.41.5
platform :ios, '13.0'
```

これを runner プロジェクトにも反映する必要があります。`ios/Runner.xcworkspace` を開き、`Runner` ターゲットを選び、`Build Settings` に行き、debug と release の両方について `iOS Deployment Target` を `13.0` に設定してください。ワークスペースのビルド設定は Runner ターゲットでは `Podfile` に勝ちます。`Podfile` の行はポッドターゲットのみに影響します。

Podfile に `post_install` ブロックがある場合、すべてのポッドに同じ最小値を継承させてください (これは最新の Flutter テンプレートのスニペットです)。

```ruby
post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_ios_build_settings(target)
    target.build_configurations.each do |config|
      config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '13.0'
    end
  end
end
```

### 3. Pods、ロックファイル、モジュールキャッシュを消す

このステップが `ModuleCache.noindex` のエラーと、ほとんどの `Undefined symbol: _swift_FORCE_LOAD$_swiftCompatibility56` の報告を修正します。以前の Xcode の Swift ABI キャッシュは Xcode 16 の `swiftc` と互換性がなく、`flutter clean` は触れません。プロジェクトのルートから:

```bash
# Flutter 3.41.5, CocoaPods 1.16.2
flutter clean
cd ios
rm -rf Pods Podfile.lock .symlinks
rm -rf ~/Library/Developer/Xcode/DerivedData
pod cache clean --all
pod install --repo-update
cd ..
flutter pub get
```

`pod install --repo-update` (注意: 単なる `pod install` ではない) は CocoaPods specs リポジトリを更新し、前回のビルド以降に公開されたプラグインの podspec を取得できるようにします。これをスキップすると、まだ iOS 11 を固定している昨日の `firebase_core.podspec` をインストールすることになります。

### 4. プラグイン、特にエラーに名前が挙がっているものを更新する

エラーが `type 'UIApplication' does not conform to protocol 'Launcher'` の場合、プラグインが古くなっています。最も一般的な 2 つの違反者は `url_launcher_ios` と `webview_flutter_wkwebview` です。最新の minor バージョンに上げてください。

```bash
flutter pub upgrade --major-versions
```

何らかの依存関係が固定しているために全体のアップグレードができない場合、エラーに名前が挙がっているプラグインだけを更新してください。

```bash
flutter pub upgrade --major-versions url_launcher_ios
```

それからステップ 3 をやり直してください (ポッドはバージョンごとにキャッシュされます。`pubspec.yaml` の変更で `pod install` が自動的に再実行されることはありません)。`pub upgrade` 自体が失敗する場合の `pubspec` リゾルバーの不満を読むためのより深いガイドについては、[「Version solving failed」 がバグではなく証明である理由](/ja/2026/05/fix-version-solving-failed-in-pubspec-yaml/) を参照してください。

### 5. すべてのポッドで Swift のバージョンを単一に強制する

ビルド失敗のサブセットは、`SWIFT_VERSION` を宣言しなかったポッドから来ます。Xcode 16 ではデフォルトで Swift 6 厳密モードになり、完全に合法な Swift 5 コードで爆発します。修正は、同じ `post_install` ブロックですべてのポッドを Swift 5 に固定することです。

```ruby
post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_ios_build_settings(target)
    target.build_configurations.each do |config|
      config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '13.0'
      config.build_settings['SWIFT_VERSION'] = '5.0'
    end
  end
end
```

これは回避策であり、修正ではありません。正しい長期的な解決策は、プラグインに対して自身の Swift バージョンを宣言するように issue を立てることですが、この固定は今日あなたのブロックを解除します。

### 6. 最後の手段としてのみ、`ios/Runner.xcodeproj` の設定を削除して再生成する

`project.pbxproj` を手動で編集した (ネイティブターゲットを追加した、カスタムビルドフェーズを入れた、App Clip エクステンションを追加した) ことがあり、上記のどれも効かなかった場合、Runner ターゲットには Xcode 16 以前の古いビルド設定が残っている可能性があります。`ios/Runner.xcodeproj` をバックアップし、新たに生成したものと差分を取ってください。

```bash
# Flutter 3.41.5
flutter create --platforms=ios --project-name=runner /tmp/scratch
diff -r ios/Runner.xcodeproj /tmp/scratch/ios/Runner.xcodeproj
```

関連するビルド設定 (`IPHONEOS_DEPLOYMENT_TARGET`、`SWIFT_VERSION`、`ENABLE_USER_SCRIPT_SANDBOXING`、`STRING_CATALOG_GENERATE_SYMBOLS`) を scratch プロジェクトから自分のものへ 1 つずつ移植し、その都度ビルドし直してください。面倒ですが、5 年分の Xcode アップグレードの残骸を蓄積したプロジェクトを回復する唯一の信頼できる方法です。

## 落とし穴と似た事例

このエラーに似ているがそうではないいくつかの事例:

- **`Sandbox: rsync deny file-write-create`**: Xcode 16 は新規プロジェクトについて `ENABLE_USER_SCRIPT_SANDBOXING=YES` をデフォルトで有効にしました。Flutter の `xcode_backend.sh` はサンドボックスの外に書き込みます。Runner ターゲットのビルド設定で `ENABLE_USER_SCRIPT_SANDBOXING=NO` を設定してください。3.24.4 以降の Flutter インストーラーテンプレートはこれを設定していますが、それ以前に作成されたプロジェクトはしていません。
- **`Provisioning profile doesn't include the currently selected device`**: これはまったく Flutter のビルド失敗ではありません。ネイティブのバイナリは正常にビルドされ、インストールステップが失敗しました。[Provisioning profile doesn't include the currently selected device](/ja/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/) を参照してください -- MAUI の記事が Apple 側の同じ根本原因をカバーしています。
- **`Unable to find a valid iOS Simulator runtime`**: Xcode 15 は Simulator ランタイムの同梱をやめ、Xcode 16 もまだ同梱していません。`xcodebuild -downloadPlatform iOS` を実行してください。詳しい記事は [Unable to find a valid iOS Simulator runtime during MAUI build](/ja/2026/05/fix-unable-to-find-a-valid-ios-simulator-runtime-during-maui-build/) にあり、Flutter にも同じく当てはまります。
- **`Xcode 26 update -- Clang dependency scanning failure: module 'Flutter' not found`**: これは [flutter/flutter#185210](https://github.com/flutter/flutter/issues/185210) で追跡されている Xcode 26 (デベロッパープレビュー) のバリアントです。Xcode 26 に対してリリースビルドをまだ出荷しないでください。Flutter が互換性ノートを公開するまで 16.x ラインに留まってください。
- **CI は失敗するがローカルビルドは通る**: あなたの CI が古い Xcode イメージにいます。GitHub Actions の `macos-14` イメージは Xcode 15.4 を同梱しています。Xcode 16 のためには `macos-15` (または明示的に `macos-15-large`) が必要です。runner イメージを固定し、`sudo xcode-select -s /Applications/Xcode_16.app` で Xcode のバージョンを選択してください。CI でも複数の Flutter バージョンをやりくりしている場合、[subosito/flutter-action 上の Flutter のマトリックスパターン](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) がバージョンを跨いでビルドを緑に保つ方法を示しています。
- **`No such module 'Flutter'` が watchOS ターゲットや App Clip でのみ発生する**: Flutter フレームワークはデフォルトでコンパニオンターゲットに埋め込まれません。`Flutter.framework` を埋め込みバイナリにコピーする Run Script フェーズを追加するか、[add-to-app](https://docs.flutter.dev/add-to-app/ios/project-setup) プロジェクトセットアップを使う必要があります。これは Apple Watch の場合について [flutter/flutter#164597](https://github.com/flutter/flutter/issues/164597) に文書化されています。
- **`flutter clean` が `ios/Flutter/Generated.xcconfig` を消して、今や何もビルドできない**: 期待通りです。`flutter pub get` を実行して再生成してください。`flutter pub get` が成功してもファイルが再生成されない場合、あなたの `pubspec.yaml` が iOS をプラットフォームとして宣言していません。`flutter:` `plugin:` `platforms:` `ios:` を追加するか、`flutter create --platforms=ios .` を実行してください。

ステップ 1 から 5 を 2 度繰り返してもまだ同じエラーが出る場合、次の手はプラグインの二分探索です。`pubspec.yaml` の `flutter` と `cupertino_icons` 以外のすべての直接依存をコメントアウトし、消去とビルドのサイクルを実行し、空のプロジェクトがビルドされることを確認してください。それから依存関係を 3 つずつのグループでコメントを外していきます。失敗を再導入する最初のグループに犯人のプラグインが含まれています。遅いですが決定論的で、提出可能なバグレポートを与えてくれます。

## 関連

- [修正: Version solving failed in pubspec.yaml](/ja/2026/05/fix-version-solving-failed-in-pubspec-yaml/)
- [修正: Provisioning profile doesn't include the currently selected device (MAUI iOS)](/ja/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/)
- [修正: Unable to find a valid iOS Simulator runtime during MAUI build](/ja/2026/05/fix-unable-to-find-a-valid-ios-simulator-runtime-during-maui-build/)
- [1 つの CI パイプラインから複数の Flutter バージョンをターゲットにする方法](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)
- [Windows から Flutter iOS をデバッグする: 実機ワークフロー](/ja/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/)

## 参考資料

- [flutter/flutter#155438: After updating to xCode 16, Failed to build iOS app in Flutter 3.19.5](https://github.com/flutter/flutter/issues/155438)
- [flutter/flutter#157461: Xcode 16 and iOS 18 project not compiling: ModuleCache.noindex error](https://github.com/flutter/flutter/issues/157461)
- [flutter/flutter#155873: No such module 'Flutter' after updating to Xcode 16](https://github.com/flutter/flutter/issues/155873)
- [flutter/flutter#164597: Flutter 3.29.0 + Xcode 16 build failure with Apple Watch target](https://github.com/flutter/flutter/issues/164597)
- [flutter/flutter#185210: Xcode 26 update -- Clang dependency scanning failure](https://github.com/flutter/flutter/issues/185210)
- [Flutter add-to-app iOS project setup](https://docs.flutter.dev/add-to-app/ios/project-setup) (docs.flutter.dev)
- [CocoaPods 1.16.x changelog](https://github.com/CocoaPods/CocoaPods/releases) (CocoaPods/CocoaPods)
