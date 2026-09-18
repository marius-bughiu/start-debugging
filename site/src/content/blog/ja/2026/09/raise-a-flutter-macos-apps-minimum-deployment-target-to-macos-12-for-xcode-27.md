---
title: "Xcode 27 に向けて Flutter macOS アプリの最小デプロイメントターゲットを macOS 12 に引き上げる"
description: "Xcode 27 は macOS 12 未満を対象にしたビルドを拒否し、Flutter 3.47 は自身の下限を 10.15 から 12.0 に引き上げました。自動マイグレーションが書き換える内容、黙ってスキップされる 3 つの箇所 (独自の値、Podfile の post_install による上書き、プラグインの podspec)、そして Flutter 3.44 に留まるチーム向けの Podfile の修正を解説します。"
pubDate: 2026-09-18
updatedDate: 2026-09-18
template: migration
tags:
  - "migration"
  - "flutter"
  - "macos"
  - "xcode"
  - "cocoapods"
lang: "ja"
translationOf: "2026/09/raise-a-flutter-macos-apps-minimum-deployment-target-to-macos-12-for-xcode-27"
translatedBy: "claude"
translationDate: 2026-09-18
---

ほとんどの Flutter macOS アプリでは、これは 5 分で終わる作業です。Flutter 3.47 以降にアップグレードし (現在の stable は 3.47.4、Dart 3.13.3)、`flutter build macos` を一度実行して、ツールが `macos/Runner.xcodeproj/project.pbxproj` で書き換える 3 行と、`macos/Podfile` の `platform :osx` の行をコミットするだけです。ただしマイグレーションが認識するのは、Flutter がこれまでに生成してきた標準の値 (10.11、10.13、10.14、10.15、11.0) と完全に一致するものだけです。そのため、誰かが手作業で `11.5` や `10.14.6` に書き換えたプロジェクト、Pod を古いバージョンに固定する Podfile の `post_install` ブロック、古いままのプラグイン podspec はマイグレーションをすり抜け、Xcode 27 で `The macOS deployment target 'MACOSX_DEPLOYMENT_TARGET' is set to ..., but the range of supported deployment target versions is 12.0 to 27.0.x` というエラーで失敗します。以下の内容はすべて、Xcode 26.6、Flutter 3.44.8 と 3.47.4、CocoaPods 1.17.0 を入れた Mac で検証しました。

## 下限が引き上げられた理由

Apple は Xcode 27 で macOS の最小デプロイメントターゲットを macOS 11 から macOS 12 に引き上げました (iOS は 15 のまま、watchOS は 8 から 9 になります)。Xcode 27 は 2026 年 9 月中旬に一般提供が始まったため、CI イメージや開発マシンはまさに今切り替わりつつあります。下限を下回った場合、Xcode 27 は以前のバージョンのように警告を出して値を補正することはしません。ターゲットの整合性エラーでビルドを止めます。

Flutter には [現在の Xcode のデプロイメント範囲に合わせる](https://flutter.dev/go/match-xcode-deployment-range) という方針があるため、チームは [flutter/flutter#187762](https://github.com/flutter/flutter/issues/187762) を起票し、[flutter/flutter#188520](https://github.com/flutter/flutter/pull/188520) (2026-06-29 にマージ) を取り込みました。これは 3.47.0 に含まれています。この変更は次の 3 つを行います。

- `flutter_tools` の `FlutterDarwinPlatform.macos.deploymentTarget()` が `10.15` ではなく `12.0` を返すようになりました。この値は SwiftPM で生成されるパッケージ、プラグインのテンプレート、そして `FlutterMacOS` の podspec に使われます。
- エンジンの `FlutterMacOS.framework` は macOS 12 向けにビルドされています。私の 3.44.8 のビルドでは `LC_BUILD_VERSION` が `minos 11.0` を示し、3.47.4 のビルドでは `minos 12.0` を示しました。
- `MacOSDeploymentTargetMigration` と `podhelper.rb` が更新され、既存のプロジェクトを `12.0` に移行するようになりました。

2 点目は、Xcode 27 をインストールしない場合でも重要です。macOS 11 のサポートをうたったままの Flutter 3.47 アプリは、エンジンのバイナリが守れない約束をしていることになります。

## 何が壊れるか

| 領域 | 変更 | 深刻度 |
| ---- | ------ | -------- |
| `Runner` の `MACOSX_DEPLOYMENT_TARGET` が 12.0 未満 | Xcode 27 でビルドエラー | 高、標準の値なら自動で移行 |
| `macos/Podfile` の `platform :osx` が 12.0 未満 | Pod が古いバージョン向けにビルドされ、Xcode 27 でエラー | 高、標準の値なら自動で移行 |
| Pod に `MACOSX_DEPLOYMENT_TARGET` を設定する Podfile の `post_install` | 上書きがマイグレーション後も残り、Xcode 27 でエラー | 高、手動で修正 |
| 12.0 未満を宣言しているプラグインの podspec または `Package.swift` | `podhelper.rb` (3.47 以降) と生成される SwiftPM パッケージが対処 | アプリ開発者には低、プラグイン作者には整理作業 |
| macOS 10.15 と 11 のユーザー | 新しいビルドをインストールできない (`LSMinimumSystemVersion` が 12.0 になる) | プロダクト上の判断 |

最後の行だけはビルドの問題ではありません。`macos/Runner/Info.plist` は `LSMinimumSystemVersion` を `$(MACOSX_DEPLOYMENT_TARGET)` に設定しているため、ビルド設定が変わった瞬間に、App Store や Sparkle のようなアップデーターは Catalina や Big Sur のマシンに新しいバージョンを提供しなくなります。リリース前にアナリティクスを確認し、サポート担当にも伝えておいてください。

## 事前チェックリスト

- macOS ターゲットをビルドするすべてのマシンと CI ランナーで Flutter 3.47.0 以降を使うこと。`flutter --version` が `3.47.x` 以降を表示するはずです。
- `macos/` の作業ツリーがクリーンであること。そうすればマイグレーションの差分を単独でレビューできます。
- macOS のプラグインでまだ CocoaPods を使っているなら CocoaPods 1.16 以降 (ここでは 1.17.0 を使用)。
- リポジトリ内で macOS のバージョンを設定しているすべての箇所の一覧。次のワンライナーで見つけられます。

```bash
# Flutter 3.47.4, run from the project root
grep -rnE "MACOSX_DEPLOYMENT_TARGET|platform :osx|osx.deployment_target|\.macOS\(" \
  macos/ --include='*.pbxproj' --include='Podfile' --include='*.xcconfig' \
  --include='*.podspec' --include='Package.swift'
```

## 移行手順

1. `flutter upgrade` で SDK をアップグレードし (または FVM や CI の設定で 3.47.4 に固定し)、`flutter clean` を実行します。`flutter --version` でツールが 3.47.x 以降を報告することを確認します。
2. `flutter build macos --debug` を一度実行します。ツールは `pod install` の前に `MacOSDeploymentTargetMigration` を実行し、`Updating minimum macOS deployment target to 12.0.` をちょうど一度だけ表示します。`git diff --stat macos/` で `project.pbxproj` と `Podfile` が変更されたことを確認します。
3. 事前チェックリストの grep をもう一度実行し、`Runner`、`RunnerTests`、追加のターゲット、`.xcconfig` ファイル、Podfile のいずれにも 12.0 未満の値が残っていないことを確かめます。マイグレーションがスキップしたものは手作業で修正します (詳細は後述)。
4. Pod のターゲットに `MACOSX_DEPLOYMENT_TARGET` を書き込む Podfile の `post_install` ブロックを削除または更新し、`flutter build macos --debug` を再度実行します。`grep MACOSX_DEPLOYMENT_TARGET macos/Pods/Pods.xcodeproj/project.pbxproj | sort | uniq -c` で、すべてのエントリが 12.0 以上であることを確認します。
5. 出荷するバイナリを確認します。ビルドしたアプリの `Contents/Info.plist` に対する `plutil -p` は `LSMinimumSystemVersion => 12.0` を表示し、実行ファイルに対する `otool -l` は `minos 12.0` を表示するはずです。
6. CI を Xcode 27 のイメージに切り替えて、リリースビルド (`flutter build macos --release`) を実行します。プロジェクトが Xcode 27 でビルドできることを証明できるのはこの手順だけです。

## マイグレーションが実際に書き換えるもの

Flutter 3.44.8 で作成したプロジェクト (どこでも 10.15 を生成します) に `url_launcher` を追加し CocoaPods を有効にした状態で、3.47.4 での最初のビルドはステータス行を表示し、自身が管理する 2 つのファイルにちょうど次の差分を生成しました。

```diff
# macos/Podfile (Flutter 3.47.4 migration)
-platform :osx, '10.15'
+platform :osx, '12.0'

# macos/Runner.xcodeproj/project.pbxproj (Debug, Release, Profile)
-				MACOSX_DEPLOYMENT_TARGET = 10.15;
+				MACOSX_DEPLOYMENT_TARGET = 12.0;
```

その後ビルドは成功し、`Pods.xcodeproj` 内の `MACOSX_DEPLOYMENT_TARGET` はすべて 12.0 になっていました。`url_launcher_macos` 3.2.6 は podspec でまだ `s.platform = :osx, '10.15'` を宣言しているにもかかわらずです。これは `podhelper.rb` の働きです。`flutter_additional_macos_build_settings` は、Pod 自身のデプロイメントターゲットのメジャーバージョンが 12 未満の場合にそれを削除するため、Pod は代わりに Podfile の platform を継承します。3.47 より前はこの境界が 10.15 だったので、10.15 を宣言している Pod はその値を保持していました。これが、Runner ターゲットを編集した後でも Flutter 3.44 のプロジェクトが Xcode 27 で失敗する理由です (最後のセクションを参照)。

SwiftPM (オプトアウトしていないプロジェクトでは Flutter 3.44 以降のデフォルト) では、マイグレーションが Runner ターゲットも移行し、ツールは Runner の `MACOSX_DEPLOYMENT_TARGET` から `macos/Flutter/ephemeral/Packages/FlutterGeneratedPluginSwiftPackage/Package.swift` を再生成します。私の環境では、3.47.4 での最初のビルドで `.macOS("10.15")` から `.macOS("12.0")` に変わりました。`url_launcher_macos` 内の `Package.swift` はまだ `.macOS("10.15")` のままですが、Xcode 26.6 では問題なくビルドできました。このマシンでは Xcode 27 を実行できなかったため、12.0 未満のプラグインマニフェストが Xcode 27 でも問題なくビルドできるかは検証していません。

## 落とし穴 1: 手作業で編集した値はマイグレーションから見えない

マイグレーターは行単位の文字列置換です。`3.47.4` タグ時点の `macos_deployment_target_migration.dart` を見ると、次のリテラル文字列だけを探しています。

```dart
// flutter_tools 3.47.4, lib/src/macos/migrations/macos_deployment_target_migration.dart
const deploymentTargetOriginal1015 = 'MACOSX_DEPLOYMENT_TARGET = 10.15;';
const deploymentTargetOriginal110 = 'MACOSX_DEPLOYMENT_TARGET = 11.0;';
const podfilePlatformVersionOriginal1015 = "platform :osx, '10.15'";
const podfilePlatformVersionOriginal110 = "platform :osx, '11.0'";
// ...plus 10.11, 10.13 and 10.14 in both forms
```

そのため、`11.5`、`10.14.6`、`11.0.1`、`.xcconfig` で設定された値、ダブルクォートを使った `platform :osx, "10.15"` は、何のメッセージもなくすべてそのまま残ります。Runner ターゲットと Podfile を 11.5 に設定して 3.47.4 でビルドしてみました。`Updating minimum macOS deployment target` の行は表示されず、`git status` ではどちらのファイルにも変更がなく、ビルドは Xcode 26.6 で成功しました。ただし、読み流しやすいリンカーの警告が出ていました。

```text
ld: warning: building for macOS-11.5, but linking with dylib
'@rpath/FlutterMacOS.framework/Versions/A/FlutterMacOS' which was built for newer version 12.0
```

できあがったアプリは `LSMinimumSystemVersion` が 11.5、`minos 11.5` でありながら、12.0 向けにビルドされたエンジンを同梱しています。Xcode 27 では同じプロジェクトがそのまま失敗します。修正方法は、Xcode (Runner プロジェクト、Runner ターゲット、General、Minimum Deployments) で値を手作業で設定するか、ファイルを直接書き換えることです。

```bash
# Flutter 3.47.4 project, replace any leftover value below 12.0
sed -i '' -E 's/MACOSX_DEPLOYMENT_TARGET = (10\.[0-9.]+|11\.[0-9.]+);/MACOSX_DEPLOYMENT_TARGET = 12.0;/' \
  macos/Runner.xcodeproj/project.pbxproj
sed -i '' -E "s/platform :osx, ['\"][0-9.]+['\"]/platform :osx, '12.0'/" macos/Podfile
```

Podfile の platform を引き上げることは、Runner ターゲットと同じくらい重要です。Runner を 10.14.6、Podfile を 11.5 のままにしたところ、Xcode 26.6 でさえ `GeneratedPluginRegistrant.swift` で `compiling for macOS 10.14.6, but module 'url_launcher_macos' has a minimum deployment target of macOS 11.5` を出して止まりました。この 2 つは常に揃えておいてください。

## 落とし穴 2: Podfile の post_install による上書きは残る

Xcode 14 の時代によくコピー&ペーストされた、すべての Pod を 1 つのバージョンに強制するコードがあります。

```ruby
# macos/Podfile, a pattern that breaks on Xcode 27
post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_macos_build_settings(target)
    target.build_configurations.each do |config|
      config.build_settings['MACOSX_DEPLOYMENT_TARGET'] = '10.14'
    end
  end
end
```

マイグレーションはこの Podfile の `platform :osx` の行を書き換えてステータスメッセージを表示したので、作業は完了したように見えます。しかしビルド後の `Pods.xcodeproj` には `MACOSX_DEPLOYMENT_TARGET = 10.14;` のエントリが 15 個あり、12.0 のものは 3 個だけでした。上書きは `flutter_additional_macos_build_settings` の後に実行されるため、そちらが勝つのです。Xcode 26.6 はそれらの Pod を黙って macOS 11.0 (Xcode 26.6 自身の下限) 向けにビルドしていたので、誰も気づきません。Xcode 27 では代わりにそれぞれの Pod でエラーになります。

内側のループを削除してください。本当にバージョンを固定する必要がある Pod があるなら、`12.0` 以上に固定し、Podfile の platform より低くしないでください。

## 落とし穴 3: ガイド付きのエラーは 3.47 以降にしかない

Xcode がターゲットを拒否すると、Flutter 3.47 はその行を認識し (照合ロジックは [flutter/flutter#187855](https://github.com/flutter/flutter/issues/187855) を受けて [flutter/flutter#188812](https://github.com/flutter/flutter/pull/188812) で追加されました)、枠で囲まれたメッセージを表示します。

```text
The macOS deployment target is too low. Xcode requires at least 12.0.

To upgrade your macOS deployment target, follow these steps:
  1. Open the project in Xcode:
     open macos/Runner.xcworkspace
  2. Select the "Runner" project in the project navigator.
  3. Select the "Runner" TARGET, and in the "General" tab:
     Update "Minimum Deployments" to at least 12.0.
```

注意点が 2 つあります。このメッセージは失敗した行が `MACOSX_DEPLOYMENT_TARGET` とサポート範囲に言及している場合にのみ表示され、アドバイスは Runner ターゲットしか扱っていません。そのため Pod ターゲットの失敗 (落とし穴 2) では、提案される修正は必要な修正ではありません。また Flutter 3.44 以前にはこのような処理はまったくありません。表示されるのは `Build process failed` と Xcode の生の行だけで、その PR のテストフィクスチャでは `error: The macOS deployment target 'MACOSX_DEPLOYMENT_TARGET' is set to 10.11, but the range of supported deployment target versions is 12.0 to 27.0.x. (in target 'Runner' from project 'Runner')` となっています。`(in target '...')` という末尾の部分が、どのターゲットを修正すべきかを示しています。

## Xcode 27 で Flutter 3.44 に留まる場合

今週は Flutter をアップグレードできないのに、CI イメージはすでに Xcode 27 に移行している、ということもあります。プロジェクトは手作業で引き上げられますが、3.44 の `podhelper.rb` は 10.15 未満の Pod のデプロイメントターゲットしか削除しないため、10.15 から 11.x を宣言している Pod はその値を保持します。Runner と Podfile を 12.0 に編集した 3.44.8 のプロジェクトでも、`Pods.xcodeproj` にはまだ `10.15` のエントリが 9 個ありました。次の `post_install` の追加でそれらはすべて削除され、すべての Pod が継承した 12.0 になりました。

```ruby
# macos/Podfile, Flutter 3.44.x workaround for Xcode 27
post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_macos_build_settings(target)
    target.build_configurations.each do |config|
      pod_target = config.build_settings['MACOSX_DEPLOYMENT_TARGET']
      if pod_target && Gem::Version.new(pod_target) < Gem::Version.new('12.0')
        config.build_settings.delete 'MACOSX_DEPLOYMENT_TARGET'
      end
    end
  end
end
```

上書きではなく削除するのは、Flutter 3.47 が使っているのと同じテクニックです。Pod はプロジェクトからより高い値を継承し、12.0 より新しいバージョンを本当に必要とする Pod は自身の要件を保持します。3.44 のエンジンフレームワークは macOS 11 向けにビルドされているので、これでバイナリが動作する OS が変わるわけではなく、Xcode 27 の要件を満たすだけです。3.47 に移行したらこのブロックは不要になるので削除してください。

## プラグイン作者向け

macOS プラグインを公開しているなら、次のリリースで podspec (`s.platform = :osx, '12.0'` または `s.osx.deployment_target = '12.0'`) と `Package.swift` の platform (`.macOS("12.0")`) を引き上げてください。また、そのリリースの機能に依存する場合は `environment: flutter:` の制約を `>=3.47.0` に上げてください。3.47 のアプリはすでに `podhelper.rb` で守られているので、これは緊急対応ではなく衛生管理ですが、誰かの `grep` であなたのプラグインが誤検知として表示されるのを防げますし、3.47 のプラグインテンプレートはいずれにせよ 12.0 を生成します。

## 検証

- Xcode 27 のランナーで `flutter build macos --release` が成功する。
- `grep -rn MACOSX_DEPLOYMENT_TARGET macos/ --include='*.pbxproj' --include='*.xcconfig'` が、`macos/Pods/Pods.xcodeproj/project.pbxproj` を含めて 12.0 未満の値を何も表示しない。
- `plutil -p build/macos/Build/Products/Release/<App>.app/Contents/Info.plist | grep LSMinimumSystemVersion` が `12.0` を表示する。
- ビルドログに `building for macOS-11.x, but linking with dylib ... built for newer version 12.0` の警告がない。
- まだテスト対象にしている最も古い macOS でアプリが起動する (マシンや VM があれば 12.x)。

## ロールバック計画

ソースの変更は `git revert` で元に戻せますが、Flutter SDK はそうはいきません。3.47 以降ではエンジンが macOS 12 向けにビルドされており、ツールは 12.0 未満の標準の値を見つけるたびに次のビルドでマイグレーションを再実行します。macOS 10.15 や 11 のサポートに戻すには Flutter 3.44.x と Xcode 26 に留まる必要がありますが、Apple が macOS 27 SDK を必須にすれば、その構成は App Store への提出で受け付けられなくなります。これは一方通行の変更として扱い、マージする前に macOS 11 のサポートについて明確に判断してください。

## 関連記事

- 同じ 3.47 アップグレードの Android 側: [Flutter Android プロジェクトを組み込み Kotlin 付きの AGP 9 に移行する](/ja/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/)。
- 同じリリースでデスクトップ向けに変わったその他の点: [Flutter 3.47 はデスクトップで Impeller をデフォルトのレンダラーにする](/ja/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/)。
- 自分で選んでいないのにプロジェクトが SwiftPM を使っている理由: [Flutter 3.44 は SwiftPM をデフォルトにする](/ja/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/)。
- Podfile の問題がデプロイメントターゲットではなくバージョン解決にある場合: ["CocoaPods could not find compatible versions for pod" の修正](/ja/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/)。
- iOS で前回起きた同様の問題: [Xcode 16 と Flutter 3.x での "Failed to build iOS app" の修正](/ja/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/)。

## 出典

- [flutter/flutter#187762: Xcode 27 をサポートするため macOS の最小サポートバージョンを 10.15 から 12 に引き上げる](https://github.com/flutter/flutter/issues/187762)
- [flutter/flutter#188520: SDK、テンプレート、podhelper、マイグレーションの変更](https://github.com/flutter/flutter/pull/188520)
- [flutter/flutter#188812: 最小バージョンが低すぎる場合のガイド付きメッセージ](https://github.com/flutter/flutter/pull/188812)
- [3.47.4 時点の `macos_deployment_target_migration.dart`](https://github.com/flutter/flutter/blob/3.47.4/packages/flutter_tools/lib/src/macos/migrations/macos_deployment_target_migration.dart)
- [3.47.4 時点の `podhelper.rb`](https://github.com/flutter/flutter/blob/3.47.4/packages/flutter_tools/bin/podhelper.rb)
- [Flutter 3.47.0 リリースノート](https://docs.flutter.dev/release/release-notes/release-notes-3.47.0)
- [Xcode 27 リリースノート](https://developer.apple.com/go/?id=xcode-27-sdk-rn)
