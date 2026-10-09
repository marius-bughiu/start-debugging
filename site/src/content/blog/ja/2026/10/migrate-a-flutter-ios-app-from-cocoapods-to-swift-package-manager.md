---
title: "Flutter iOS アプリを CocoaPods から Swift Package Manager へ移行する (Flutter 3.44 から 3.47)"
description: "Flutter 3.44 で iOS と macOS の既定が Swift Package Manager になりましたが、既存アプリは CocoaPods を取り除くまで CocoaPods を使い続けます。SwiftPM 対応済みのプラグインの確認方法、Xcode プロジェクトの自動移行、Podfile の安全な削除、Pods のみのプラグインや独自の Podfile ロジックへの対処、そして元に戻す方法を解説します。"
pubDate: 2026-10-09
updatedDate: 2026-10-09
template: migration
tags:
  - "migration"
  - "flutter"
  - "ios"
  - "swiftpm"
  - "cocoapods"
  - "xcode"
lang: "ja"
translationOf: "2026/10/migrate-a-flutter-ios-app-from-cocoapods-to-swift-package-manager"
translatedBy: "claude"
translationDate: 2026-10-09
---

Flutter 3.44 より前に作成した Flutter アプリには、3.44 以降 Swift Package Manager (SwiftPM) が既定になっているにもかかわらず、`Podfile`、`Pods/` ディレクトリ、そして xcconfig ファイル内の CocoaPods 用の `#include` 行が残っています。Flutter をアップグレードしても、移行の半分しか完了しません。最初の `flutter build ios` または `flutter run` で SwiftPM パッケージが Xcode プロジェクトに追加されますが、CocoaPods は削除されません。削除は自分で行う必要があり、しかも使用しているすべてのプラグインが `Package.swift` を提供している場合に限られます。プラグインが 5 から 15 個程度の一般的なアプリであれば、作業時間は 30 分ほどです。つまずきやすいのは、手作業で編集した `Podfile` (独自の `post_install` ロジック、プリプロセッサマクロ、追加の pod) と、まだ Pods のみに対応しているプラグインです。早めに対応してください。CocoaPods trunk は 2026 年 12 月 2 日に読み取り専用になります。以下の内容はすべて Flutter 3.44.8、Xcode 27.0、CocoaPods 1.17.0 でテストし、現在の安定版である Flutter 3.47.6 でも確認しています。

## CocoaPods を残さずに削除する理由

- **ビルドマシンに Ruby が不要になります。** pod がなくなると `flutter build ios` は `pod install` を実行しなくなるため、CI に Ruby、`cocoapods` gem、`LANG=en_US.UTF-8` の回避策が不要になります。
- **ビルドが速くなります。** `flutter_tools` が直接次のように表示します。"Removing CocoaPods integration will improve the project's build time." `[CP] Embed Pods Frameworks` と `[CP] Copy Pods Resources` のスクリプトフェーズが、毎回のビルドからなくなります。
- **CocoaPods trunk が凍結されます。** 2026 年 12 月 2 日に完全に読み取り専用になります。既存の pod は引き続き解決されますが、それ以降はプラグインが修正版の podspec を公開できません。CocoaPods に残っているプラグインは、iOS 側が凍結されたプラグインということです。
- **Pods のみのプラグインには警告が出ています。** Flutter 3.44 以降では、Pods のみのプラグインに対して "will become an error in a future version of Flutter" と表示され、pub.dev でも SwiftPM 非対応のパッケージはスコアが下がるようになりました。

## プロジェクトで何が変わるか

| 領域 | 変更内容 | 重要度 |
| --- | --- | --- |
| `ios/Runner.xcodeproj/project.pbxproj` | `FlutterGeneratedPluginSwiftPackage` が `Runner` のローカルパッケージ依存として追加される (自動) | 低 |
| `Runner.xcscheme` | ビルド前アクション "Run Prepare Flutter Framework Script" が追加される (自動、スキームごと) | 低 |
| `ios/Podfile`, `Podfile.lock`, `Pods/`, `.symlinks/` | 手動で削除する | 中 |
| `ios/Flutter/Debug.xcconfig`, `Release.xcconfig` | `#include? "Pods/..."` の行を手動で削除する | 中 |
| 独自の `Podfile` ロジック | `post_install` フック、`GCC_PREPROCESSOR_DEFINITIONS`、Flutter 以外の pod は別の場所へ移す必要がある | 高 |
| Pods のみのプラグイン | CocoaPods が残り続ける。`Podfile` を削除しても再生成される | 高 |
| 最低 iOS バージョン | SwiftPM プラグインが `Runner` ターゲットより高い最低バージョンを宣言することがある | 中 |

## 事前チェックリスト

1. Flutter 3.44 以降 (`flutter --version`)。SwiftPM は 3.24 からオプトインで利用できましたが、自動移行と以下の警告が既定で有効になるのは 3.44 からです。
2. Xcode 15 以降。`flutter_tools` は、それより古い Xcode では SwiftPM を拒否します。
3. 作業ツリーがクリーンであること。これにより `project.pbxproj` とスキームの差分を確認でき、元に戻すこともできます。
4. SwiftPM が無効になっていないこと。`flutter config --list` に `enable-swift-package-manager: false` が表示されないこと、そして `pubspec.yaml` の `flutter:` 配下に `config: enable-swift-package-manager: false` がないことを確認してください。SwiftPM がまだオプトインだった以前のリリースでは、別のキーである `disable-swift-package-manager: true` を `flutter:` 直下に置く方法が文書化されていました。当時チームメンバーが追加していた場合は削除してください。
5. フレーバーをビルドしている場合は、すべてのスキーム名を控えておいてください。ビルド前アクションはスキームごとに追加されます。

## 移行手順

1. **まずプラグインをアップグレードします。** 多くのプラグインはマイナーリリースで `Package.swift` を追加しており、古いロックファイルのままだと Pods のみのバージョンに留まってしまいます。`flutter pub upgrade` を実行し、`pubspec.yaml` で固定しているものについては `flutter pub outdated` を実行してください。`git diff pubspec.lock` で、iOS のプラグイン実装 (`*_ios`、`*_darwin`、`*_foundation`、`*_apple`) が更新されたことを確認します。

2. **どのプラグインが SwiftPM 対応で、どれが非対応かを一覧にします。** `flutter_tools` はファイルの有無でこれを判定します。パッケージ内に `ios/<plugin_name>/Package.swift` (iOS と macOS でコードを共有するプラグインの場合は `darwin/<plugin_name>/Package.swift`) があれば、そのプラグインは SwiftPM に対応しています。ツールはプラグインのパスを `.flutter-plugins-dependencies` から読み取るので、Xcode プロジェクトに触れる前に同じチェックを自分で実行できます。

   ```bash
   #!/usr/bin/env bash
   # Flutter 3.44+, run from the app root after `flutter pub get`. Needs jq.
   jq -r '.plugins.ios[] | [.name, .path, (if .shared_darwin_source then "darwin" else "ios" end)] | @tsv' \
     .flutter-plugins-dependencies |
   while IFS=$'\t' read -r name path dir; do
     base="${path%/}/$dir"
     if [ -f "$base/$name/Package.swift" ]; then echo "swiftpm    $name"
     elif [ -f "$base/$name.podspec" ];     then echo "pods-only  $name"
     else                                       echo "dart-only  $name"
     fi
   done
   ```

   一般的なプラグイン 10 個を入れたテストアプリでは、次のように出力されました。

   ```text
   swiftpm    audioplayers_darwin
   swiftpm    device_info_plus
   swiftpm    flutter_contacts
   swiftpm    flutter_secure_storage_darwin
   pods-only  flutter_tts
   swiftpm    geolocator_apple
   swiftpm    image_gallery_saver_plus
   swiftpm    package_info_plus
   dart-only  path_provider_foundation
   swiftpm    vibration
   ```

   `dart-only` は、そのプラグインにネイティブの iOS コードがまったくないことを意味します (`path_provider_foundation` 2.6.0 は FFI 経由で Foundation を呼び出します)。そのためどちらの依存関係マネージャーも関係しません。`pods-only` の行が 1 つでもある場合、Xcode プロジェクトの移行はできますが、CocoaPods はまだ削除できません。後述の"Pods のみのプラグイン"のゴッチャに進んでください。

3. **Flutter に Xcode プロジェクトを移行させます。** config のみではなく、実際のビルドを実行します。

   ```bash
   # Flutter 3.44.8, Xcode 27.0
   flutter build ios --simulator --debug
   ```

   私のテストでは、`flutter build ios --config-only` は `pod install` を実行し、`ios/Flutter/ephemeral/Packages/` 配下の SwiftPM パッケージを再生成しましたが、`project.pbxproj` とスキームには触れませんでした。Xcode プロジェクトへの統合は、`xcodebuild` が実行される直前に行われます。次のコマンドで確認します。

   ```bash
   grep -c FlutterGeneratedPluginSwiftPackage ios/Runner.xcodeproj/project.pbxproj   # > 0
   grep "Run Prepare Flutter Framework Script" ios/Runner.xcodeproj/xcshareddata/xcschemes/*.xcscheme
   ```

   すべてのプラグインが SwiftPM に対応している場合、ビルド出力の末尾に、プロジェクトに合わせたチェックリストが表示されます。

   ```text
   All plugins found for ios are Swift Packages, but your project still has CocoaPods integration. To remove CocoaPods integration, complete the following steps:
     * In the ios/ directory run "pod deintegrate"
     * Also in the ios/ directory, delete the Podfile
     * Remove the include to "Pods/Target Support Files/Pods-Runner/Pods-Runner.debug.xcconfig" in your ios/Flutter/Debug.xcconfig
     * Remove the include to "Pods/Target Support Files/Pods-Runner/Pods-Runner.release.xcconfig" in your ios/Flutter/Release.xcconfig

   Removing CocoaPods integration will improve the project's build time.
   ```

   別のメッセージ "Your project uses a non-standard Podfile and will need to be migrated to Swift Package Manager manually" が表示された場合、Flutter が `Podfile` をテンプレートとバイト単位で比較し、編集が加えられていることを検出したということです。先に進む前に、"独自の Podfile"のゴッチャを確認してください。この時点でコミットしておきましょう。プロジェクトは両方のマネージャーでビルドでき、ここがロールバックの基点になります。

4. **CocoaPods を統合解除します。**

   ```bash
   # CocoaPods 1.17.0
   cd ios
   pod deintegrate
   rm -rf Podfile Podfile.lock Pods .symlinks
   cd ..
   ```

   `pod deintegrate` は、`[CP]` ビルドフェーズ、`Pods_Runner.framework` のリンク、Pods の xcconfig 参照を `project.pbxproj` から取り除きます。`grep -c "\[CP\]" ios/Runner.xcodeproj/project.pbxproj` で確認してください。`0` と表示されるはずです。

5. **xcconfig ファイルから Pods の include を削除します。** どちらのファイルの先頭にも、`pod deintegrate` が触れないオプションの include があります。

   ```text
   // ios/Flutter/Debug.xcconfig, before
   #include? "Pods/Target Support Files/Pods-Runner/Pods-Runner.debug.xcconfig"
   #include "Generated.xcconfig"

   // after
   #include "Generated.xcconfig"
   ```

   `Release.xcconfig` と、自分で作成したフレーバーごとの xcconfig (`Debug-dev.xcconfig` など) でも同じ作業を行ってください。`#include?` 形式はファイルが存在しなくても無視されるため、残しておいてもビルドは壊れません。ただし `flutter_tools` はこの行の有無を確認しており、残っている間は削除のチェックリストを表示し続けます。`grep -rn "Pods" ios/Flutter/*.xcconfig` で確認してください。何も出力されないはずです。

6. **ワークスペースの参照を整理します。** `pod deintegrate` の最後には "The workspace referencing the Pods project still remains." と表示されます。`ios/Runner.xcworkspace/contents.xcworkspacedata` を開き、`<FileRef location = "group:Pods/Pods.xcodeproj">` 要素を削除してください。これで Xcode に赤字の見つからないプロジェクトが表示されなくなります。`Runner.xcworkspace` 自体は残してください。Flutter と Xcode は引き続きこれを通してアプリを開きます。

7. **クリーンな状態から再ビルドします。**

   ```bash
   # Flutter 3.44.8 / 3.47.6
   flutter clean
   flutter pub get
   flutter build ios --simulator --debug
   ```

   出力で 2 点を確認します。`Running pod install...` の行がないこと、そして `ios/Podfile` が再作成されていないことです。`Podfile` が戻ってきた場合は、Pods のみのプラグインがまだ依存関係に含まれています。

8. **CI を更新します。** `pod install`、`pod repo update`、Ruby のセットアップ、CocoaPods のキャッシュに関するステップを削除してください。`~/Library/Developer/Xcode/DerivedData/<project>/SourcePackages` をキャッシュするか、Xcode から直接ビルドする場合は `xcodebuild` に `-clonedSourcePackagesDirPath` を渡します。`cocoapods` gem がインストールされていないランナーイメージでパイプラインを実行して確認してください。

## 動作確認

- `flutter build ios --release --no-codesign` が成功し、`pod install` の行が表示されないこと。
- 実機での `flutter run` が、ホットリロードを含めて動作すること。これにより、ビルド前アクションが `Flutter.framework` を正しく準備したことが確認できます。
- Xcode で、出荷するすべてのスキームの Edit Scheme、Build、Pre-actions に "Run Prepare Flutter Framework Script" のビルド前アクションがあること。手作業で作成したフレーバーのスキームでは、これが欠けていることが最も多いです。
- ネイティブコードを持つ各プラグインが実行時に動作すること。権限を 1 つリクエストし、URL を 1 つ開き、セキュアストレージの値を 1 つ読み取ってください。コンパイルは通ったが設定が失われたプラグインは、ビルド時ではなくここで失敗します (`permission_handler` のゴッチャを参照)。
- アーカイブがビルドできること。`flutter build ipa` が成功し、アップロードが App Store Connect の検証を通過することを確認します。プラグインのリソースやプライバシーマニフェストの欠落が最初に表面化するのはここです。

## 元に戻す方法

この移行は元に戻せます。ステップ 3 の後にコミットしていれば、統合解除のコミットを `git revert` し、`cd ios && pod install` を実行することで、両方を併用する構成に戻ります。SwiftPM を完全に使わないようにするには、`pubspec.yaml` でプロジェクト全体についてオプトアウトします。

```yaml
# pubspec.yaml, Flutter 3.44+
flutter:
  config:
    enable-swift-package-manager: false
```

その後、Package Dependencies と `Runner` ターゲットの Frameworks, Libraries, and Embedded Content から `FlutterGeneratedPluginSwiftPackage` を削除し、各スキームからビルド前アクションを削除します。オプトアウトだけではプロジェクトファイルに SwiftPM の統合が残り、Flutter はそのために空のパッケージを生成し続けます。CocoaPods のサポートはメンテナンスモードにあり、いずれ終了するため、オプトアウトは一時的な措置と考えてください。

## 実際の移行で見つかったゴッチャ

### Pods のみのプラグインで Podfile が復活する

`Package.swift` を持たないプラグインが 1 つでもあると、Flutter は混在モードで動作します。`Podfile` のない完全に移行済みのアプリに `flutter_tts` 4.2.5 を追加したところ、次のビルドで以下が表示されました。

```text
The following plugins do not support Swift Package Manager for ios:
  - flutter_tts
This will become an error in a future version of Flutter. Please contact the plugin maintainers to request Swift Package Manager adoption.
Running pod install...
```

Flutter はテンプレートから `ios/Podfile` を再生成し、両方の xcconfig ファイルに `#include?` の行を戻しました。混在モードでも問題なくビルドできるため、緊急事態ではありません。選択肢は、プラグインを置き換えるか、その iOS コードを `Package.swift` を持つローカルパッケージに取り込むか、混在構成のままにして後でそのプラグインを再確認するかです。再生成された `Podfile` を繰り返し削除するのはやめてください。そのプラグインが `pubspec.lock` にある限り、何度でも戻ってきます。

### SwiftPM では permission_handler が Podfile のマクロを無視する

従来の `permission_handler` のセットアップでは、`Podfile` の `post_install` ブロック内で `GCC_PREPROCESSOR_DEFINITIONS` に `PERMISSION_CAMERA=1` などを追加します。SwiftPM ではこのブロックは実行されません。`permission_handler_apple` 9.4.8 以降では、対応する `NS*UsageDescription` キーが `Info.plist` にある場合に、パッケージのマニフェストがその権限を有効にします。9.5.1 でビルド構成やフレーバー固有の plist に対する検出が修正され、9.6.0 でフレーバーごとの権限を指定する `permission_handler.yaml` が追加されたため、ロックファイルが 9.6.x に解決されることを確認してください。結果として 2 点に注意が必要です。使用目的の説明がない権限はコンパイル対象から外れ、ビルドが失敗するのではなく、実行時に `denied` を返します。また、マニフェストはキャッシュされるため、`Info.plist` を変更した後は一度だけ `rm -rf ~/Library/Developer/Xcode/DerivedData` を実行する必要があります。動作確認のリストで実行時チェックが重要なのはこのためです。

### 独自の Podfile は削除ではなく移し替えが必要

`Podfile` を削除する前に、次の 3 点を確認してください。Flutter 以外の pod (`pod 'GoogleMLKit/...'`、分析 SDK など) は、`Runner` プロジェクトの Xcode の Package Dependencies タブから追加する Swift パッケージ依存に置き換える必要があります。`post_install` 内のビルド設定のオーバーライド (`ENABLE_BITCODE`、`EXCLUDED_ARCHS`、デプロイメントターゲット) は pod ターゲットにのみ影響していたため、ほとんどはそのまま不要になります。プラグインが参照するプリプロセッサマクロには、上記の `permission_handler` のように、そのプラグインの SwiftPM での対応方法が必要です。これを怠ってもビルドは通ることが多く、機能だけが静かに消えます。

### 最低 iOS バージョンの不一致

SwiftPM プラグインがアプリより高いプラットフォームを宣言することがあり、その場合 "The package product 'plugin_name_ios' requires minimum platform version 14.0 for the iOS platform, but this target supports 12.0" というエラーで失敗します。`Runner` ターゲットの Minimum Deployments を引き上げ、`flutter build ios --config-only` を実行して設定を再生成してください。Xcode 27 にはもう 1 つの下限があります。iOS のデプロイメントターゲットが 15.0 未満の場合は拒否されますが、Flutter 3.44.8 で作成したプロジェクトは 13.0 のままです。このエラーは `Runner` プロジェクトに発生し、混在モードではすべての pod ターゲットにも発生します。pod については、`post_install` ブロックの `flutter_additional_ios_build_settings(target)` の後にオーバーライドを追加します。

```ruby
# ios/Podfile, Flutter 3.44.8 + Xcode 27.0, mixed mode only
target.build_configurations.each do |config|
  config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '15.0'
end
```

macOS にも同様の問題があります。詳しくは [Xcode 27 に向けて Flutter macOS アプリの最低デプロイメントターゲットを macOS 12 に引き上げる](/ja/2026/09/raise-a-flutter-macos-apps-minimum-deployment-target-to-macos-12-for-xcode-27/)を参照してください。

### 古い StackOverflow の解決策は通用しなくなる

競合を解消するために `Podfile` で pod のバージョンを固定しても、そのプラグインが SwiftPM で解決されるようになると、CocoaPods はそれを認識しないため効果がありません。以前 [CocoaPods の "could not find compatible versions for pod"](/ja/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/) に悩まされたことがある場合は、移行時にそれらの固定を引き継がずに削除してください。

### Add-to-app モジュールは別扱い

ネイティブ iOS アプリに組み込まれた Flutter モジュールは、独自のモジュール用 `Podfile` を使用し、`flutter_tools` は意図的にこれに触れません。上記の手順ではなく、add-to-app のプロジェクトセットアップガイドに従ってください。

## 関連記事

- 既定を切り替えたリリース: [Flutter 3.44 で Swift Package Manager が既定に](/ja/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/)。
- 問題が依存関係マネージャーではなく Xcode 自体にある場合は、[Xcode 16 と Flutter 3.x での iOS アプリのビルド失敗](/ja/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/)から始めてください。
- 古いブランチを壊さずに、複数の Flutter バージョンにまたがってこの移行を CI で展開するには、[1 つの CI パイプラインで複数の Flutter バージョンを対象にする](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)を参照してください。

## 参考資料

- [Swift Package Manager for app developers](https://docs.flutter.dev/packages-and-plugins/swift-package-manager/for-app-developers) (docs.flutter.dev)
- [Swift Package Manager for plugin authors](https://docs.flutter.dev/packages-and-plugins/swift-package-manager/for-plugin-authors) (docs.flutter.dev)
- [Saying goodbye to CocoaPods](https://flutter.dev/blog/saying-goodbye-to-cocoapods-swift-package-manager-is-soon-the-default-in-flutter) (flutter.dev blog)
- [`darwin_dependency_management.dart`](https://github.com/flutter/flutter/blob/master/packages/flutter_tools/lib/src/macos/darwin_dependency_management.dart)、上記で引用した警告の出典 (flutter/flutter)
- [`permission_handler_apple` changelog](https://github.com/Baseflow/flutter-permission-handler/blob/main/permission_handler_apple/CHANGELOG.md) (Baseflow/flutter-permission-handler)
- [CocoaPods Specs repo read-only plan](https://blog.cocoapods.org/CocoaPods-Specs-Repo/) (CocoaPods blog)
