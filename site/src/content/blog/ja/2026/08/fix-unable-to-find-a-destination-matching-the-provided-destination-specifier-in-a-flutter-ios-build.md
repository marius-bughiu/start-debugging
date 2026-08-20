---
title: "解決: Flutter の iOS ビルドで発生する Unable to find a destination matching the provided destination specifier"
description: "iOS 26 のシミュレータランタイムは arm64 のみです。残っている EXCLUDED_ARCHS arm64 の行があると、どのシミュレータでも実行できない Intel 専用の Runner ができあがります。"
pubDate: 2026-08-20
template: error-page
tags:
  - "errors"
  - "flutter"
  - "ios"
  - "xcode"
  - "cocoapods"
lang: "ja"
translationOf: "2026/08/fix-unable-to-find-a-destination-matching-the-provided-destination-specifier-in-a-flutter-ios-build"
translatedBy: "claude"
translationDate: 2026-08-20
---

`ios/Podfile` から `EXCLUDED_ARCHS[sdk=iphonesimulator*] = arm64` の行を削除し、`flutter clean` のあとにクリーンな `pod install` を実行してください。この行は 2020 年の Apple Silicon 移行期の名残ですが、Xcode 26 では致命的です。iOS 26 のシミュレータランタイムは arm64 だけを同梱するため、arm64 を除外すると `Runner` にシミュレータが実行できるアーキテクチャが 1 つも残らず、`xcodebuild` はそれをアーキテクチャの不一致ではなく「宛先が見つからない」として報告します。除外が自分で管理していないプラグイン由来であれば、代わりに `xcodebuild -downloadPlatform iOS -architectureVariant universal` でユニバーサルランタイムを導入してください。

## エラーの全文

Flutter は `xcodebuild` の生のエラーをそのまま表示します。シミュレータの UDID を挙げたうえで、一見まったく正常に見える宛先を並べます。

```
Uncategorized (Xcode): Unable to find a destination matching the provided destination specifier:
                { id:6B4F9D28-C76C-4146-9527-E844395B4434 }

        Available destinations for the "Runner" scheme:
                { platform:macOS, arch:arm64, variant:Designed for [iPad,iPhone], id:00006020-000221002EE8C01E, name:My Mac }
                { platform:iOS, id:dvtdevice-DVTiPhonePlaceholder-iphoneos:placeholder, name:Any iOS Device }
                { platform:iOS Simulator, id:dvtdevice-DVTiOSDeviceSimulatorPlaceholder-iphonesimulator:placeholder, name:Any iOS Simulator Device }
```

同じスキームを Xcode の画面から実行すると、Flutter の出力が埋もれさせていた診断が現れます。

```
iPhone 17 cannot run Runner.
Domain: IDEFoundationErrorDomain
Code: 3
Recovery Suggestion: Runner's architectures (Intel 64-bit) include none that iPhone 17 can execute (arm64).
```

この 2 つ目のメッセージが本当のエラーです。シミュレータは存在し、起動していて、UDID も正しいのです。足りていないのは、いまビルドした成果物と実行先に指定した端末とで共通するアーキテクチャです。

## iOS 26 のシミュレータに一致する宛先が存在しない理由

`xcodebuild -destination` は「この UDID を持つ端末」に解決されるのではなく、「この UDID を持ち、かつこのスキームの成果物を実行できる端末」に解決されます。アーキテクチャは照合条件の一部なので、アーキテクチャの不一致は宛先が見つからないという形で表面化します。

iOS 26 より前は、この区別が問題になることはほとんどありませんでした。シミュレータランタイムは `x86_64` と `arm64` の両方のスライスを含むユニバーサルバイナリとして配布されていたため、Intel 専用のビルドでも Apple Silicon 上の Rosetta で動かせるスライスが見つかったのです。Xcode 26 はそれを終わらせました。ランタイムを導入すると、Apple は Apple Silicon 上でアーキテクチャバリアントを `arm64` に解決し、そのスライスだけをダウンロードします。その際に `Automatically resolved architecture variant for platform iOS as 'arm64'` と出力されます。

つまり iOS 26 のシミュレータが実行できるアーキテクチャはちょうど 1 つであり、シミュレータ向けビルドから `arm64` を取り除くビルド設定はどれも、使えるスライスがゼロの成果物を生みます。

その設定はほぼ必ず Podfile から来ます。2020 年当時、Apple Silicon 向けの回避策を説明する記事はどれも、Intel 専用の pod をリンクさせるために arm64 の除外を追加するよう指示していました。そしてその助言が何千ものプロジェクトにコピーされました。Flutter 自身の CocoaPods ヘルパーもそれを温存します。`packages/flutter_tools/bin/podhelper.rb` はシミュレータ向けの除外を `$(inherited)` 付きで書き込むため、プロジェクト側の値は置き換えられずに保持されます。

```ruby
# Flutter 3.44.2, packages/flutter_tools/bin/podhelper.rb
build_configuration.build_settings['VALID_ARCHS[sdk=iphonesimulator*]'] = '$(ARCHS_STANDARD)'
build_configuration.build_settings['EXCLUDED_ARCHS[sdk=iphonesimulator*]'] = '$(inherited) i386'
build_configuration.build_settings['EXCLUDED_ARCHS[sdk=iphoneos*]'] = '$(inherited) armv7'
```

標準の除外は `i386` だけで、これは無害です。ビルドを殺すのは継承された `arm64` のほうです。

原因はもう 1 つあります。いずれかの pod ターゲットが `arm64` を除外していると、Flutter はその除外をアプリ本体にも波及させます。`packages/flutter_tools/lib/src/ios/xcode_build_settings.dart` が `Generated.xcconfig` を生成する際にこれを判断します。

```dart
// Flutter 3.44.2, packages/flutter_tools/lib/src/ios/xcode_build_settings.dart
var excludedSimulatorArchs = 'i386';
if (!(await project.ios.pluginsSupportArmSimulator(printWarnings: printWarnings))) {
  excludedSimulatorArchs += ' arm64';
}
xcodeBuildSettings.add(
  'EXCLUDED_ARCHS[sdk=${XcodeSdk.IPhoneSimulator.platformName}*]=$excludedSimulatorArchs',
);
```

`pluginsSupportArmSimulator` は `Pods/Pods.xcodeproj` に対して `xcodebuild -showBuildSettings` を実行し、いずれかのターゲットの `EXCLUDED_ARCHS` が `arm64` に言及していれば false を返します。設定の悪い推移的依存が 1 つあるだけで、アプリ全体が Intel 専用になります。

## 最小再現: シミュレータビルドを壊す Podfile の 1 行

素の Flutter アプリに例の定番の回避策を加え、iOS 26 のシミュレータで実行してみます。

```ruby
# ios/Podfile, Flutter 3.44.2, CocoaPods 1.16.2, Xcode 26.0.1
post_install do |installer|
  installer.pods_project.build_configurations.each do |config|
    config.build_settings['EXCLUDED_ARCHS[sdk=iphonesimulator*]'] = 'arm64'
  end
end
```

```bash
# Flutter 3.44.2 (stable, 11 June 2026), Dart 3.12.2
flutter run -d 6B4F9D28-C76C-4146-9527-E844395B4434
```

Flutter は `packages/flutter_tools/lib/src/ios/mac.dart` で、選択された端末から `-destination` 引数を組み立てます。

```dart
// Flutter 3.44.2, packages/flutter_tools/lib/src/ios/mac.dart
buildCommands.add('-destination');
if (deviceID != null) {
  buildCommands.add('id=$deviceID');
} else if (environmentType == EnvironmentType.physical) {
  buildCommands.add(XcodeSdk.IPhoneOS.genericPlatform);
} else {
  buildCommands.add(XcodeSdk.IPhoneSimulator.genericPlatform);
}
```

`genericPlatform` は `generic/platform=iOS Simulator` に展開されます。成果物が Intel 専用になってしまえばどちらの形式でも同じように失敗するので、`flutter build ios --simulator` は端末を 1 つも選ばなくても同じ現象を再現します。

## arm64 の除外はどうやって取り除きますか?

自分のプロジェクトから依存関係へ、内側から外側へと進めます。

第 1 に、`ios/Podfile` から除外を削除します。空文字列に設定するのではなく `EXCLUDED_ARCHS[sdk=iphonesimulator*]` の代入そのものを削除し、Flutter 標準の `i386` がきれいに適用されるようにします。

第 2 に、Xcode プロジェクト本体を確認します。同じ行は Podfile ではなくビルド設定に貼り付けられていることも多いためです。

```bash
# Xcode 26.0.1
cd ios
xcodebuild -showBuildSettings -project Runner.xcodeproj -scheme Runner \
  -sdk iphonesimulator | grep -i EXCLUDED_ARCHS
```

シミュレータ SDK 側で `arm64` に言及しているものはすべて削除が必要です。Xcode の Build Settings にある Excluded Architectures で、Debug と Release の両方をクリアしてください。

第 3 に、pod をゼロから作り直します。古い `Pods` と `DerivedData` が残っていると設定が生き続け、修正が効いていないように見えてしまいます。

```bash
# Flutter 3.44.2, CocoaPods 1.16.2
flutter clean
rm -rf ios/Pods ios/Podfile.lock ~/Library/Developer/Xcode/DerivedData
flutter pub get
cd ios && pod install
```

第 4 に、Flutter が生成するファイルから除外が消えたことを確認します。`ios/Flutter/Generated.xcconfig` には `arm64` を含まない `EXCLUDED_ARCHS[sdk=iphonesimulator*]=i386` が出ているはずです。クリーンな `pod install` のあとでも `arm64` が残るなら、原因はあなたではなく依存関係です。

## プラグインがまだ arm64 を除外している場合はどうしますか?

Xcode 26 以降では、Flutter 3.41.0 (2026 年 2 月 11 日) 以降がビルド中に問題のターゲット名を挙げてくれます。出力元は `packages/flutter_tools/lib/src/xcode_project.dart` です。

```
The following target(s) do not support arm64 architecture, which is a requirement for Apple Silicon iOS 26+ simulators:
  - SomePlugin (Flutter plugin)
  - SomeVendorSDK (transitive dependency of Flutter plugin SomePlugin)

Please contact plugin maintainers to request arm64 support to continue to be able to use the plugin on a simulator.
```

この警告は 2025 年 11 月 5 日にマージされた [PR #177065](https://github.com/flutter/flutter/pull/177065) で入りました。マージコミットをリリースタグと比較すると 3.38.10 には含まれず 3.41.0 には含まれるため、3.41 系より前に留まっている場合は何の説明もないまま失敗を受け取ることになります。

対象がベンダー提供のバイナリフレームワークで、シミュレータ向け arm64 スライスを持たない場合、除外は外せません。その場合はユニバーサルランタイムを導入し、Intel 専用の成果物にも動かせる先を用意します。

```bash
# Xcode 26.0.1
xcrun simctl delete unavailable
xcodebuild -downloadPlatform iOS -architectureVariant universal
```

先に、いま入っている arm64 のみの iOS 26 ランタイムを Xcode の Settings の Components から削除してください。そうしないとダウンロードは既存のランタイムに解決され、ユニバーサル版を取得しないまま終了します。実行後に確認します。

```bash
# Xcode 26.0.1
xcrun simctl list runtimes --json | grep -i x86_64
```

これは Flutter 自身が勧める回避策でもあります。3.41.4 (2026 年 3 月 4 日) 以降、シミュレータ向けビルドが失敗したあとにこの提案が出力されます。条件は Xcode 26 以降であること、そして選択中のランタイムに実際に `x86_64` スライスがないことです。

```
The selected simulator is incompatible with the current build settings.
Please use a simulator that supports x86_64, such as a simulator prior to iOS 26 or download the universal variant of the iOS 26 simulator using "xcodebuild -downloadPlatform iOS -architectureVariant universal".
```

ただし応急処置として扱ってください。ユニバーサルランタイムはダウンロードが大きく、アプリは Rosetta 上で動き、標準の手順でランタイムを入れる次のチームメンバーには何の効果もありません。除外を取り除くほうが恒久的な解決です。

## プラットフォームが未インストールだと表示される場合はどうしますか?

別の失敗パターンでは、同じ見出しの下に `Ineligible destinations` のブロックが続きます。

```
Unable to find a destination matching the provided destination specifier:
                { id:1234D567-890C-1DA2-34E5-F6789A0123C4 }

        Ineligible destinations for the "Runner" scheme:
                { platform:iOS, id:dvtdevice-DVTiPhonePlaceholder-iphoneos:placeholder, name:Any iOS Device, error:iOS 17.0 is not installed. To use with Xcode, first download and install the platform }
```

これはアーキテクチャの問題ではありません。deployment target またはスキームが、そのマシンに存在しないランタイムを参照しています。Xcode 26 は古いランタイムを引き継がないため、Xcode をアップグレードした直後によく起こります。Flutter はこのメッセージから `is not installed` という語句を抜き出し、Xcode の Components を案内するインストール手順を表示します。不足しているランタイムを導入するか、手元にあるバージョンまで deployment target を引き上げてください。

## 宛先が古いシミュレータの UDID の場合はどうしますか?

エラーに出ている UDID がすでに存在しない場合、`xcodebuild` は別の 1 行を追加します。

```
The requested device could not be found because no available devices matched the request.
```

Flutter はこのケースをアーキテクチャ診断から明示的に除外しています。したがってこの文が出ているなら、追いかけているのはアーキテクチャの不一致ではなく幻の端末です。たいていは iOS や Xcode の更新でシミュレータ一式が再生成された一方、IDE の設定や `launch.json`、シェルのエイリアスが古い識別子を固定し続けている場合に起こります。

```bash
# Xcode 26.0.1, Flutter 3.44.2
xcrun simctl list devices available
xcrun simctl delete unavailable
flutter devices
```

そのうえで `flutter devices` が実際に返す UDID を渡すか、`-d` 自体を外して Flutter に選ばせてください。

## ローカルでは通るのに CI で壊れる原因は何ですか?

ビルドサーバーで同じメッセージが出る場合、たいていは iOS プラットフォームがそもそも入っていません。[issue #163011](https://github.com/flutter/flutter/issues/163011) では宛先一覧が macOS のエントリだけになっていました。これは Xcode のコンポーネントが揃っていない macOS イメージの典型的な姿です。`flutter build ipa` は `generic/platform=iOS` を渡すので、iOS プラットフォームがなければ照合する対象が存在しません。

プロジェクトを疑う前にイメージを確認してください。

```bash
# Xcode 26.0.1 on a CI runner
xcodebuild -showsdks
xcrun simctl list runtimes
```

iOS が欠けているなら、ビルド前のステップとして `xcodebuild -downloadPlatform iOS` を追加し、イメージの更新で結果が黙って変わらないように Xcode のバージョンを固定します。これは [1 本の CI パイプラインから複数の Flutter バージョンを対象にする](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) 際に予測可能性を保つのと同じ規律です。

## 落とし穴と紛らわしい類似ケース

`ONLY_ACTIVE_ARCH` は代替になりません。Flutter はアクティブなアーキテクチャがわかっている場合に `ONLY_ACTIVE_ARCH` と `ARCHS` をすでに明示的に渡していますし、手で設定しても `EXCLUDED_ARCHS` が取り除いたスライスは戻りません。

古い書き方である `VALID_ARCHS[sdk=iphonesimulator*] = x86_64` にも注意してください。これは `EXCLUDED_ARCHS` より前の形式で、まったく同じ Intel 専用の成果物を生みます。Flutter の podhelper は pod ターゲットについてはこれを `$(ARCHS_STANDARD)` に戻しますが、あなたのアプリターゲットには手を出しません。

同じ文字列で実機向けビルドが失敗する場合は別の問題です。そちらの宛先は `generic/platform=iOS` であり、原因はたいていコード署名で、[選択中の端末を含まないプロビジョニングプロファイル](/ja/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/) に近い話になります。

最後に、宛先の照合は通ったのに起動時に落ちるのであれば、まったく別の領域です。起動直後に Dart VM の中で落ちるデバッグビルドは [mprotect permission denied の失敗](/ja/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/) であり、そもそもリンクが通らないビルドは [CocoaPods のバージョン解決の衝突](/ja/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/) である可能性が高いです。

## 本当の原因を報告してくれる Flutter のバージョン

根本的な非互換は Apple 側の事情なので、Flutter を上げても Intel 専用の成果物が arm64 のみのランタイムで動くようにはなりません。アップグレードで手に入るのは、謎ではなく診断です。Flutter 3.41.0 は arm64 を除外しているターゲットをすべて挙げる警告を追加し、3.41.4 は失敗後にユニバーサルランタイムの案内を追加しました。どちらも 2026 年 8 月 19 日にリリースされた現行 stable の 3.47.1 に入っています。

3.38 以前でアップグレードできない場合は、前掲の `-showBuildSettings` の grep を手作業で実行してください。それこそが、いま Flutter が代わりに行っている検査そのものです。Xcode を上げたあとの iOS ビルド失敗をより広く洗い出すなら、[Xcode 16 でのビルド失敗の解説](/ja/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/) の切り分け順が今も有効です。

## 関連記事

- [解決: Flutter の iOS デバッグビルドで発生する mprotect failed: 13 (Permission denied)](/ja/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/)
- [解決: Flutter の iOS ビルドで発生する CocoaPods could not find compatible versions for pod](/ja/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/)
- [解決: Xcode 16 と Flutter 3.x で発生する Failed to build iOS app](/ja/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/)
- [Flutter 3.44 で Swift Package Manager が既定になります](/ja/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/)
- [1 本の CI パイプラインから複数の Flutter バージョンを対象にする方法](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)

## 参考資料

- [flutter/flutter issue #176188, iOS 26 シミュレータで flutter run が動作しない](https://github.com/flutter/flutter/issues/176188)
- [flutter/flutter PR #177065, Xcode 26 のシミュレータに対応するため arm64 の除外を削除](https://github.com/flutter/flutter/pull/177065)
- [flutter/flutter issue #163011, 汎用 iOS プラットフォームでの destination specifier 失敗](https://github.com/flutter/flutter/issues/163011)
- [Apple Developer Forums, iOS 26 シミュレータランタイムの導入とアーキテクチャバリアント](https://developer.apple.com/forums/thread/801106)
- [Apple, Xcode の追加コンポーネントのダウンロードとインストール](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components)
- [Apple, 追加のシミュレータランタイムのインストール](https://developer.apple.com/documentation/xcode/installing-additional-simulator-runtimes)
