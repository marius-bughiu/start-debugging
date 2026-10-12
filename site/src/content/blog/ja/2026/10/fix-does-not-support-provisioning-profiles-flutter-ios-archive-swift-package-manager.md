---
title: "Fix: Swift Package Manager へ移行した Flutter iOS アプリのアーカイブで \"does not support provisioning profiles\" エラーが出る"
description: "xcodebuild のコマンドラインで渡したプロビジョニングプロファイルは、すべての SwiftPM リソースバンドルターゲットに適用されます。代わりに Runner ターゲットに手動署名を設定してください。"
pubDate: 2026-10-12
template: error-page
tags:
  - "errors"
  - "flutter"
  - "ios"
  - "swiftpm"
  - "xcode"
  - "ci"
lang: "ja"
translationOf: "2026/10/fix-does-not-support-provisioning-profiles-flutter-ios-archive-swift-package-manager"
translatedBy: "claude"
translationDate: 2026-10-12
---

`PROVISIONING_PROFILE_SPECIFIER` (通常は `CODE_SIGN_STYLE`、`DEVELOPMENT_TEAM`、`CODE_SIGN_IDENTITY` も一緒に) を `xcodebuild` のコマンドライン引数や fastlane の `xcargs` として渡すのをやめてください。コマンドラインのビルド設定は、ビルド内の**すべての**ターゲットでその設定を上書きします。SwiftPM への移行後は、Xcode がプラグインごとに生成するリソースバンドルターゲット (たとえば `url_launcher_ios_url_launcher_ios`) もその対象に含まれ、リソースバンドルにはプロビジョニングプロファイルを持たせられません。代わりに `Runner` ターゲットの Release 構成に手動署名を設定し、`flutter build ipa` でアーカイブしてください。CocoaPods では、`post_install` フックがすべての Pod に `CODE_SIGNING_ALLOWED = NO` を設定していたため、同じ引数でも動いていました。SwiftPM にはそのようなフックがないので、移行によってエラーが表面化します。以下はすべて Flutter 3.44.8、Xcode 27.0、CocoaPods 1.17.0 で再現を確認しています。

## エラーの全文

リソースを含むプラグイン (実質的には `PrivacyInfo.xcprivacy` マニフェストを持つすべてのプラグイン) ごとに 1 件のエラーが出て、その後に通常のアーカイブ失敗が続きます。

```
.../ios/Flutter/ephemeral/Packages/.packages/url_launcher_ios-6.4.2/Package.swift: error: url_launcher_ios_url_launcher_ios does not support provisioning profiles. url_launcher_ios_url_launcher_ios does not support provisioning profiles, but provisioning profile MyApp AppStore has been manually specified. Set the provisioning profile value to "Automatic" in the build settings editor. (in target 'url_launcher_ios_url_launcher_ios' from project 'url_launcher_ios')
.../ios/Flutter/ephemeral/Packages/.packages/shared_preferences_foundation-2.5.7/Package.swift: error: shared_preferences_foundation_shared_preferences_foundation does not support provisioning profiles. shared_preferences_foundation_shared_preferences_foundation does not support provisioning profiles, but provisioning profile MyApp AppStore has been manually specified. Set the provisioning profile value to "Automatic" in the build settings editor. (in target 'shared_preferences_foundation_shared_preferences_foundation' from project 'shared_preferences_foundation')
** ARCHIVE FAILED **
```

注目すべき点は 2 つあります。`Flutter/ephemeral/Packages/.packages/` を指すパスと、SwiftPM の `<package>_<target>` パターンに従うターゲット名です。どちらも、失敗しているターゲットがアプリ本体でもプラグインのコードでもなく、Swift パッケージのリソースバンドルであることを示しています。

メッセージ中のアドバイス "Set the provisioning profile value to Automatic in the build settings editor" は、ここでは役に立ちません。`Package.swift` から Xcode が合成したターゲットのビルド設定は開けませんし、そのターゲット自身はプロファイルを要求していません。プロファイルは外部から強制されているのです。

## 設定していないターゲットにプロファイルが届く理由

Xcode はビルド設定を複数のレイヤーで解決します。優先度の低い順に、プラットフォームの既定値、プロジェクトレベルの設定、xcconfig ファイル、ターゲットレベルの設定、そして最後に `xcodebuild` へ `NAME=value` として渡す上書きです。最上位のレイヤーはターゲットごとに範囲を絞れません。CI スクリプトで次のように実行すると、

```bash
# Xcode 27.0, Flutter 3.44.8 - the pattern that breaks
xcodebuild -workspace Runner.xcworkspace -scheme Runner \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath build/Runner.xcarchive archive \
  CODE_SIGN_STYLE=Manual \
  DEVELOPMENT_TEAM=ABCDE12345 \
  CODE_SIGN_IDENTITY="Apple Distribution" \
  PROVISIONING_PROFILE_SPECIFIER="MyApp AppStore"
```

アーカイブに含まれるすべてのターゲットに `PROVISIONING_PROFILE_SPECIFIER = MyApp AppStore` が設定されます。その後、Xcode の署名検証は、リソースバンドル、スタティックライブラリ、フレームワークなど、プロビジョニングできないプロダクトタイプでこの設定を拒否します。Apple がこの検証を常に一貫して適用してきたわけではありません。[developer forums のスレッド](https://developer.apple.com/forums/thread/700327)には、ネイティブの Swift パッケージ依存関係で同じエラーが Xcode 13.3 ベータで現れ、13.3 GM で消え、Xcode 14 で再発した経緯が記録されています。Xcode 27.0 では適用されます。

移行後、アーカイブに含まれるターゲットは `Runner`、`FlutterGeneratedPluginSwiftPackage` の集約ターゲット、各プラグインのライブラリプロダクト、そして `Package.swift` で `resources:` を宣言しているプラグインごとの `.bundle` ターゲットです。ファーストパーティのプラグインの多くは、現在この方法でプライバシーマニフェストを同梱しているため、実際のアプリのほとんどにはこうしたバンドルがいくつも存在します。

### CocoaPods で動いていた理由

同じアプリで SwiftPM を無効にして (`pubspec.yaml` の `flutter: config:` 配下で `enable-swift-package-manager: false`)、同じコマンドを実行してみました。こちらも失敗しますが、ターゲット名が違います。

```
ios/Pods/Pods.xcodeproj: error: Pods-Runner does not support provisioning profiles. ...
ios/Pods/Pods.xcodeproj: error: url_launcher_ios does not support provisioning profiles. ...
ios/Pods/Pods.xcodeproj: error: shared_preferences_foundation does not support provisioning profiles. ...
```

つまり、このコマンドラインは最初から正しくなかったのです。これでビルドできていたプロジェクトには、`Podfile` に次のような `post_install` ブロックがありました。多くは何年も前の Stack Overflow の回答からコピーされたものです。

```ruby
# ios/Podfile, CocoaPods 1.17.0
post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_ios_build_settings(target)
    target.build_configurations.each do |config|
      config.build_settings['CODE_SIGNING_ALLOWED'] = 'NO'
    end
  end
end
```

このフックがあると、アーカイブはすべての Pod ターゲットを通過し、プロファイルに対して検証されるのは `Runner` だけになります。このフックが機能するのは、署名が許可されていないターゲットに対して Xcode が署名検証をスキップするためで、強制されたプロファイルが設定に残っていても関係ありません。移行の最後の手順で `Podfile` を削除すると、フックも一緒に消えますが、SwiftPM には同等の仕組みがありません。パッケージ向けの `post_install` はなく、`Flutter/ephemeral` 配下に生成される `Package.swift` はビルドのたびに書き換えられます。

## 最小再現

```bash
# Flutter 3.44.8, Xcode 27.0, SwiftPM enabled (the default since 3.44)
flutter create --platforms=ios -e --org com.example myapp
cd myapp
flutter pub add url_launcher shared_preferences
# Xcode 27 rejects the template's 13.0 deployment target
sed -i '' 's/IPHONEOS_DEPLOYMENT_TARGET = 13.0/IPHONEOS_DEPLOYMENT_TARGET = 15.0/g' \
  ios/Runner.xcodeproj/project.pbxproj
flutter build ios --simulator --debug   # applies the SwiftPM project migration
cd ios
xcodebuild -workspace Runner.xcworkspace -scheme Runner -configuration Release \
  -destination 'generic/platform=iOS' -archivePath ../build/Runner.xcarchive archive \
  CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=ABCDE12345 \
  PROVISIONING_PROFILE_SPECIFIER="MyApp AppStore" CODE_SIGN_IDENTITY="Apple Distribution"
```

エラーを確認するのに、本物の証明書やプロファイルは必要ありません。Xcode はビルド計画の段階で、2 つのバンドルターゲットについて "does not support provisioning profiles" エラーを報告し、その隣に `Runner` 向けの想定どおりの "No profile for team" エラーも出します。

## 修正 1: Runner ターゲットに手動署名を設定し、`flutter build ipa` を使う

署名は、署名可能なものを生成するターゲットのものです。具体的には `Runner` と、あれば App Extension (共有拡張、通知サービス拡張、ウィジェット) です。署名の設定はそこだけに行い、他の場所には置きません。

Xcode で `ios/Runner.xcworkspace` を開き、`Runner` ターゲットを選択して **Signing & Capabilities** に移動し、**Release** タブを選び、**Automatically manage signing** をオフにして、チームとプロファイルを選択します。結果を直接確認したい場合、`ios/Runner.xcodeproj/project.pbxproj` の `Runner` ターゲットの Release 構成には次のように記録されます。

```
/* Flutter 3.44.8, Xcode 27.0 - Runner target, Release configuration */
CODE_SIGN_STYLE = Manual;
DEVELOPMENT_TEAM = ABCDE12345;
"CODE_SIGN_IDENTITY[sdk=iphoneos*]" = "Apple Distribution";
"PROVISIONING_PROFILE_SPECIFIER[sdk=iphoneos*]" = "MyApp AppStore";
```

Profile ビルドをアーカイブする場合は、`Profile` 構成でも同じ設定を繰り返してください。その後、コマンドからすべての署名引数を外し、通常どおりアーカイブします。

```bash
# Flutter 3.44.8
flutter build ipa --release
```

同じ 4 つの設定をコマンドラインから `Runner` ターゲットに移したところ、パッケージのエラーは消え、`Runner` に対する想定どおりの "No profile ... found" エラーだけが残りました。私のテストマシンには配布用プロファイルがないため、再現はここまでですが、残ったエラーは、指定したプロファイルがインストールされていないときに `Runner` 単体で出る通常のエラーです。

`flutter build ipa` は独自の署名上書きを追加しません。Flutter 3.44.8 では、`build_ios.dart` がアーカイブ後に `Runner` の解決済みビルド設定を読み取ります。`CODE_SIGN_STYLE` が `Manual` で、`PROVISIONING_PROFILE_SPECIFIER` と `DEVELOPMENT_TEAM` の両方が設定されていれば、一致するインストール済みプロファイルを見つけ、`signingStyle` を `manual` にし、バンドル ID に対する `provisioningProfiles` エントリを持つ `ExportOptions.plist` を生成します。拡張機能を持つアプリなど、細かく制御したい場合は、自分のファイルを渡します。

```bash
# Flutter 3.44.8
flutter build ipa --release --export-options-plist=ios/ExportOptions.plist
```

```xml
<!-- ios/ExportOptions.plist, Xcode 27.0 -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store-connect</string>
  <key>signingStyle</key>
  <string>manual</string>
  <key>teamID</key>
  <string>ABCDE12345</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>com.example.myapp</key>
    <string>MyApp AppStore</string>
  </dict>
</dict>
</plist>
```

`provisioningProfiles` に載せるのは、アプリと App Extension のバンドル ID だけです。プラグインのフレームワークやバンドルにはエントリを作りません。

## 修正 2: fastlane では、コマンドラインではなくプロジェクトを変更する

fastlane での悪いパターンは `build_app(xcargs: "PROVISIONING_PROFILE_SPECIFIER=...")` で、`xcargs` はまさにコマンドラインのレイヤーです。`update_code_signing_settings` に `targets:` を指定して設定を `Runner` だけに書き込み、署名用の `xcargs` なしでビルドします。

```ruby
# fastlane 2.x, Flutter 3.44.8, Xcode 27.0
lane :release do
  update_code_signing_settings(
    path: "ios/Runner.xcodeproj",
    use_automatic_signing: false,
    targets: ["Runner"],
    build_configurations: ["Release"],
    team_id: "ABCDE12345",
    code_sign_identity: "Apple Distribution",
    sdk: "iphoneos*",
    profile_name: "MyApp AppStore"
  )
  build_app(
    workspace: "ios/Runner.xcworkspace",
    scheme: "Runner",
    configuration: "Release",
    export_method: "app-store",
    export_options: {
      provisioningProfiles: { "com.example.myapp" => "MyApp AppStore" }
    }
  )
end
```

`targets` パラメーターの既定値はプロジェクト内のすべてのターゲットです。プラグインのバンドルは `Runner.xcodeproj` に含まれないため、省略してもエラーは再現しませんが、ターゲットを明示しておけば、将来追加される拡張機能やテストターゲットに誤ったプロファイルが設定されるのを防げます。

## 修正 3: アーカイブを自動署名に切り替える

特定のプロファイルが不要なら、Xcode に管理させます。`Runner` の `CODE_SIGN_STYLE = Automatic` を維持し、App Store Connect API キーを使って `xcodebuild` にプロファイルの取得や作成を任せます。

```bash
# Xcode 27.0
xcodebuild -workspace ios/Runner.xcworkspace -scheme Runner -configuration Release \
  -destination 'generic/platform=iOS' -archivePath build/Runner.xcarchive archive \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$ASC_KEY_PATH" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID"
```

このモードではパッケージのバンドルターゲットに署名は不要なので、追加の作業なしに検証を通過します。代償として、CI マシンに API キーが必要になり、プロファイルが自動的に作成されます。リリースプロセスによってはこれが許されない場合があります。

## 正しそうに見えて実はそうでない回避策

- **コマンドラインでの `CODE_SIGNING_ALLOWED=NO`。** `Runner` にも適用されるため、署名なしのアーカイブになり、`-exportArchive` ではアップロード可能な IPA に変換できません。
- **コマンドラインでの条件付き設定。** `"PROVISIONING_PROFILE_SPECIFIER[sdk=iphoneos*]=MyApp AppStore"` は条件付き設定として解釈されません。Xcode 27.0 では値が `iphoneos*]=MyApp AppStore` になり、`Runner` が "No profile ... matching 'iphoneos*]=MyApp AppStore' found" で失敗しました。条件が使えるのはプロジェクトファイルと xcconfig ファイルだけです。
- **`-xcconfig` や `XCODE_XCCONFIG_FILE`。** どちらも指定ファイルをビルド全体への上書きとして適用するので、そのファイルにプロファイルを書くと、`NAME=value` 引数と同様にパッケージのターゲットにも届きます。
- **SwiftPM をもう一度オフにする。** `enable-swift-package-manager: false` と古い `post_install` フックの組み合わせでエラーは消えますが、それは CocoaPods を呼び戻しているだけです。時間稼ぎにはなっても修正にはならず、CocoaPods trunk は 2026-12-02 に読み取り専用になります。

## 同じコマンドラインから出る似たエラー

プロファイルを外して他の上書きを残しても、エラーが変わるだけです。コマンドラインに `CODE_SIGN_STYLE=Manual` と `CODE_SIGN_IDENTITY` があってチームがない場合、Xcode 27.0 は各バンドルに対して `Signing for "url_launcher_ios_url_launcher_ios" requires a development team` と報告します。`DEVELOPMENT_TEAM` を追加すると、同じバンドルターゲットで `No signing certificate "iOS Distribution" found` に変わります。3 つとも原因と修正は同じで、コマンドラインに署名設定を置かないことです。

別のメッセージ `exportArchive: SomeKit.framework does not support provisioning profiles` は、アーカイブではなくエクスポートの手順で出ます。これは `ExportOptions.plist` (または fastlane の `export_options`) が、フレームワークのバンドル ID をプロファイルに対応付けていることを意味します。そのエントリを削除してください。ここに載せてよいのはアプリとその拡張機能だけです。

アーカイブが署名を通過した後でデプロイメントターゲットのエラーになる場合、それは署名の問題ではなく、Xcode 27 の最小値である iOS 15 によるものです。その失敗の CocoaPods 側のバージョンは、[Flutter iOS ビルドにおける CocoaPods のバージョン競合の記事](/ja/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/)で扱っています。

## 関連記事

- [Flutter iOS アプリを CocoaPods から Swift Package Manager へ移行する](/ja/2026/10/migrate-a-flutter-ios-app-from-cocoapods-to-swift-package-manager/)では、`Podfile` のフックを取り除く移行について、他のカスタム `post_install` ロジックの移し方も含めて説明しています。
- [Flutter 3.44 で SwiftPM が既定になる](/ja/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/)では、3.44 にアップグレードしたアプリが、何もしなくても切り替わった理由を説明しています。
- [Fix: Unable to find a destination matching the provided destination specifier](/ja/2026/08/fix-unable-to-find-a-destination-matching-the-provided-destination-specifier-in-a-flutter-ios-build/)は、CocoaPods 時代の設定が残っていることが原因の、別の iOS ビルド失敗です。
- [Fix: the provisioning profile doesn't include the currently selected device](/ja/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/)では、.NET MAUI の観点から、プロビジョニングのデバイス登録側を扱っています。

## 参考資料

- [Swift Package Manager for app developers](https://docs.flutter.dev/packages-and-plugins/swift-package-manager/for-app-developers), Flutter ドキュメント。
- [Build and release an iOS app](https://docs.flutter.dev/deployment/ios), Flutter ドキュメント (`flutter build ipa` と `--export-options-plist`)。
- [`build_ios.dart` in flutter_tools](https://github.com/flutter/flutter/blob/stable/packages/flutter_tools/lib/src/commands/build_ios.dart), 手動署名用の ExportOptions 生成。
- [update_code_signing_settings](https://docs.fastlane.tools/actions/update_code_signing_settings/), fastlane ドキュメント。
- [Apple Developer Forums thread 700327](https://developer.apple.com/forums/thread/700327), 手動署名の CI アーカイブにおけるネイティブ Swift パッケージ依存関係の同じエラーと、Xcode 13 から 14 での適用状況の変化。
- [Apple Developer Forums thread 726714](https://developer.apple.com/forums/thread/726714), `Pods` プロジェクトのすべてのターゲットで発生した CocoaPods 版。
