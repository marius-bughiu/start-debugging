---
title: "解決: Flutter の iOS ビルドで CocoaPods could not find compatible versions for pod が出る"
description: "エラーの1行目ではなく2行目を読んでください。原因はそこに書かれています。古い Podfile.lock、低すぎる deployment target、あるいは同じ推移的 pod を固定している2つのプラグインです。"
pubDate: 2026-07-31
template: error-page
tags:
  - "errors"
  - "flutter"
  - "ios"
  - "cocoapods"
lang: "ja"
translationOf: "2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build"
translatedBy: "claude"
translationDate: 2026-07-31
---

対処法はエラーの直下にある行だけで決まり、可能性は4つしかありません。`In snapshot (Podfile.lock)` と書かれていれば、`ios/Podfile.lock` を削除して `pod install` を実行します。spec が `required a higher minimum deployment target` と書かれていれば、`Podfile` の `platform :ios` を引き上げます。同じ pod に対して異なる正確なバージョンへ解決された2つのプラグインが列挙されていれば、それは本物の衝突であり、修正するのは `Podfile` ではなく `pubspec.yaml` です。`pod repo update` で直るのは4つ目のケース、spec リポジトリが本当に古い場合だけです。ほとんどの人が真っ先に実行する `pod repo update` は、それが効かない残り3つのケースで2分を無駄にします。

この記事は Flutter 3.44.7 (stable、2026年7月)、CocoaPods 1.17.0 (2026-07-06 リリース)、Dart 3.12、macOS Sequoia 上の Xcode 16.x を前提に書かれています。

## エラーの実際の姿

Firebase プラグインを引き上げた `flutter pub upgrade` の直後に出る、最も一般的な形です。

```text
[!] CocoaPods could not find compatible versions for pod "Firebase/CoreOnly":
  In snapshot (Podfile.lock):
    Firebase/CoreOnly (= 10.28.0)

  In Podfile:
    firebase_core (from `.symlinks/plugins/firebase_core/ios`) was resolved to 3.4.0, which depends on
      Firebase/CoreOnly (= 11.0.0)

You have either:
 * out-of-date source repos which you can update with `pod repo update` or with `pod install --repo-update`.
 * changed the constraints of dependency `Firebase/CoreOnly` inside your development pod `firebase_core`.
   You should run `pod update Firebase/CoreOnly` to apply changes you've made.

Error running pod install
Error launching application on iPhone 16 Pro.
```

2つ目の形です。同じエラーに見えますが、別物です。

```text
[!] CocoaPods could not find compatible versions for pod "sqflite_darwin":
  In Podfile:
    sqflite_darwin (from `.symlinks/plugins/sqflite_darwin/darwin`)

Specs satisfying the `sqflite_darwin (from `.symlinks/plugins/sqflite_darwin/darwin`)` dependency were
found, but they required a higher minimum deployment target.
```

どちらも同じ見出し文字列で始まります。このエラーの検索結果が矛盾したアドバイスの寄せ集めになっているのはそのためです。1行目より先は何ひとつ共通していません。

## CocoaPods が単にバージョンを選ばずにこれを報告する理由

CocoaPods は Molinillo という SAT 風のバックトラック型リゾルバーで依存関係を解決します。制約の集合を渡され、それらすべてを同時に満たす各 pod のバージョンをひとつずつ見つけるよう求められます。解が見つからないまま探索空間を使い切ったとき、リゾルバーは推測しません。あきらめた時点でまだ衝突していた制約と、衝突の原因になり得るものの定型リストを出力します。

その定型リストは文字どおり定型です。当てはまるかどうかに関係なく出力されます。診断情報はその上にあるインデントされたブロックであり、各制約とその出所が書かれています。満たせない制約がこの集合に入る原因は4つです。

1. **`Podfile.lock` が古い正確なバージョンを固定している。** ロックファイルは `In snapshot (Podfile.lock)` というラベルの制約として解決に参加します。Dart 側のプラグイン更新で podspec の要求が変わったのに、ロックは古い番号を主張し続けています。圧倒的に多い原因です。
2. **候補となるどのバージョンも `Podfile` が宣言するより高い deployment target を必要としている。** Molinillo は `deployment_target` がプラットフォーム行を超える spec を除外し、その結果として候補集合が空になったと報告します。これが `required a higher minimum deployment target` のパターンです。
3. **2つのプラグインが共有する推移的 pod を互いに非互換な正確なバージョンで固定している。** 本物のダイヤモンド依存です。`Podfile` をどう編集しても解決しません。制約の出所は Flutter が `pubspec.yaml` から生成した2つの podspec だからです。
4. **spec リポジトリが要求されているバージョンより古い。** git ベースの spec リポジトリを使っている場合にのみ該当します。Flutter の既定の `Podfile` が使う CDN ソースに `pod repo update` は不要です。

## 最小限の再現

ケース1は、ネイティブ依存が固定されたプラグインを持つプロジェクトなら3コマンドで再現できます。

```bash
# Flutter 3.44.7, CocoaPods 1.17.0
flutter create podconflict && cd podconflict
flutter pub add firebase_core:3.1.0 && (cd ios && pod install)
flutter pub add firebase_core:3.4.0 && (cd ios && pod install)   # boom
```

最初の `pod install` が `ios/Podfile.lock` に `Firebase/CoreOnly (= 11.0.0)` を書き込みます。2回目の `flutter pub add` が、podspec の要求する正確なバージョンが異なるプラグインへ差し替えるため、ロックファイルの制約は新しい podspec に対して満たせなくなります。

ケース2は、プラットフォーム行をプラグインの要求より下げると再現します。

```ruby
# ios/Podfile -- Flutter 3.44.7, CocoaPods 1.17.0
platform :ios, '12.0'
```

podspec が次のように宣言しているプラグインと組み合わせます。

```ruby
# .symlinks/plugins/sqflite_darwin/darwin/sqflite_darwin.podspec
s.platform = :ios, '13.0'
```

## 対処法、優先度順

### 1. エラーに `In snapshot (Podfile.lock)` があるならロックを捨てる

ロックファイルは以前の解決結果のキャッシュであって、真実の源ではありません。Flutter はビルドのたびに `pubspec.lock` から pod グラフ全体を再生成するので、それと食い違う `ios/Podfile.lock` は定義上すでに古く、権威ではありません。

```bash
# Flutter 3.44.7, CocoaPods 1.17.0 -- run from the repo root
flutter pub get
cd ios
rm Podfile.lock
pod install
```

順序に注意してください。`flutter pub get` を先に実行する必要があります。pub キャッシュ内の解決済みプラグインバージョンを指すように `ios/.symlinks/plugins/` を書き換えるのはこのコマンドだからです。先に `pod install` を実行すると、前回そこにあったプラグインバージョンの podspec を解決してしまい、数字だけが違う同じエラーが出て堂々巡りになります。

自分が管理しているプラグインの場合や、全体の再解決ではなく限定的な変更を望む場合は次のようにします。

```bash
# CocoaPods 1.17.0 -- surgical alternative, keeps other pins intact
cd ios && pod update Firebase/CoreOnly
```

Flutter アプリではロックの削除を選んでください。`pod update <pod>` が正解なのは、ロックファイルが意図的な固定を表現している手書きの iOS プロジェクトです。Flutter アプリではその固定は `pubspec.lock` から来ており、これからもそこから来るべきものです。

### 2. エラーに `higher minimum deployment target` があるなら2か所でプラットフォームを引き上げる

`Podfile` と Xcode プロジェクトの両方が必要です。`Podfile` だけを編集すると pod の解決は通りますが、その後リンク時に失敗します。`Runner` ターゲット自身のビルド設定が古い下限を宣言したままだからです。

```ruby
# ios/Podfile -- Flutter 3.44.7
platform :ios, '15.0'
```

```ruby
# ios/Podfile -- force every pod target to inherit the same floor
post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_ios_build_settings(target)
    target.build_configurations.each do |config|
      config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '15.0'
    end
  end
end
```

続いてアプリターゲットにも設定します。`ios/Runner.xcworkspace` を開き、`Runner` ターゲットを選択し、`Build Settings` へ移動して、Debug と Release の両方で `iOS Deployment Target` を同じ値にします。`Runner` 自身については workspace の設定が `Podfile` に優先します。`Podfile` の行が支配するのは pod ターゲットだけです。

数字を試行錯誤で決めないでください。失敗した podspec から読み取ります。

```bash
# Flutter 3.44.7 -- print the floor the failing plugin actually declares
grep -r "s.platform\|deployment_target" ios/.symlinks/plugins/sqflite_darwin/darwin/*.podspec
```

下限を上げると古い端末のサポートが外れるので、インストール済みの最新 iOS ではなく、podspec が要求する値ちょうどまで上げてください。

### 3. 2つのプラグインが同じ pod を異なる正確なバージョンで固定しているなら `pubspec.yaml` を直す

`Podfile` のあらゆる編集も、あらゆるキャッシュ削除も効かないのがこのケースです。衝突が CocoaPods より上流にあるからです。見分け方は、異なる2つのプラグインを名指しする2本の `was resolved to` 行です。

```text
[!] CocoaPods could not find compatible versions for pod "GTMSessionFetcher/Core":
  In Podfile:
    firebase_auth (from `.symlinks/plugins/firebase_auth/ios`) was resolved to 5.1.0, which depends on
      GTMSessionFetcher/Core (~> 3.3)
    google_sign_in_ios (from `.symlinks/plugins/google_sign_in_ios/darwin`) was resolved to 5.7.6, which depends on
      GTMSessionFetcher/Core (< 3.0, >= 1.1)
```

`~> 3.3` と `< 3.0` に重なりはありません。podspec が互いに矛盾しないプラグインバージョンを見つけ、`pubspec.yaml` で固定します。

```yaml
# pubspec.yaml -- Flutter 3.44.7, Dart 3.12
dependencies:
  firebase_auth: ^5.1.0
  google_sign_in: ^6.2.2   # 6.2.2 ships google_sign_in_ios 5.7.7+, which allows GTMSessionFetcher 3.x
```

その後、両方の層を再解決します。

```bash
# Flutter 3.44.7, CocoaPods 1.17.0
flutter pub get
cd ios && rm Podfile.lock && pod install
```

代わりに、推移的 pod のバージョンを `Podfile` から強制することもできます。

```ruby
# ios/Podfile -- last resort, use only to unblock while waiting on a plugin release
pod 'GTMSessionFetcher/Core', '3.4.1'
```

これは期限付きの一時的なパッチとして扱ってください。プラグイン作者が意図的に書いた制約を上書きするものであり、実行時に存在しないセレクターでクラッシュするその瞬間まで、ビルドはきれいに通り続けます。

CocoaPods にたどり着く前に `flutter pub get` 自体が失敗する場合は、ネイティブ側ではなく Dart 側の解決問題であり、読むべき制約も別物です。[なぜ "Version solving failed" はバグではなく証明なのか](/ja/2026/05/fix-version-solving-failed-in-pubspec-yaml/)を参照してください。

### 4. その後にはじめて spec リポジトリを更新する

```bash
# CocoaPods 1.17.0
cd ios && pod install --repo-update
```

これが効くのは1つの状況だけです。git ベースの spec リポジトリ (`Podfile` 内の `source 'https://github.com/CocoaPods/Specs.git'`) を使っていて、ローカルのクローンが要求されたバージョンより古い場合です。Flutter が生成する `Podfile` は既定で CDN ソースを使い、pod ごとに HTTP でバージョンを問い合わせるため、その意味で古くなることはありません。`source` の行を変更していないなら、`--repo-update` は spec の完全なクローンを代償にするだけの無意味な操作です。

## 落とし穴と紛らわしいエラー

**`flutter clean` は `Podfile.lock` に触れません。** クリアされるのは `build/` と `.dart_tool/` です。`ios/Podfile.lock` と `ios/Pods/` は手つかずで生き残ります。「flutter clean はもう実行した」がこのエラーで最も多い誤った手がかりなのはこのためです。iOS の状態を実際に消し去る強硬手段は次のとおりです。

```bash
# Flutter 3.44.7, CocoaPods 1.17.0
flutter clean
cd ios && pod deintegrate && rm -rf Pods Podfile.lock .symlinks
cd .. && flutter pub get
cd ios && pod install
```

**`arch -x86_64 pod install` はもう不要です。** この回避策は `ffi` gem に arm64 バイナリがなかった2021年のものです。Ruby 3.x 上の CocoaPods 1.17.0 は Apple Silicon でネイティブに動きます。いま `arch -x86_64` を付けると、gem がインストールされていないかもしれない Rosetta 上の Ruby を強制することになり、無関係な失敗を引き起こします。

**SwiftPM へ移行したプラグインは pod グラフにそもそも現れません。** [Flutter 3.44 が Swift Package Manager を既定にして](/ja/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/)以降、`Package.swift` を同梱するプラグインは SwiftPM が解決し、CocoaPods からは見えません。アップグレードでこのエラーが消えるのは、たいていこれが理由です。同時に、2024年の StackOverflow の回答で読んだ衝突がもう再現しない可能性があること、そしてすでに移行済みのプラグインを直そうと `Podfile` で pod を固定しても何も起きないまま無視されることも意味します。回避策を書く前に、そのプラグインをどちらのリゾルバーが所有しているか確認してください。

```bash
# Flutter 3.44.7 -- if this file exists, the plugin is on SwiftPM, not CocoaPods
ls ios/Flutter/ephemeral/Packages/FlutterGeneratedPluginSwiftPackage/Package.swift
```

**下に制約ブロックのない `Error running pod install` は別のエラーです。** インデントされた `In Podfile:` セクションがない場合、CocoaPods は解決の前に失敗しており、原因はバージョン衝突ではなく Ruby や Xcode のツールチェーンの問題であるのが普通です。それは[Xcode 16 での iOS ビルドのチェックリスト](/ja/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/)の領域であり、この記事の対象ではありません。

**CI での再現性。** `ios/Podfile.lock` をコミットするのは既定として正しい判断ですが、チームの誰かがローカルで `pod install` を再実行せずにプラグインを引き上げた瞬間、CI でケース1が発火します。2つのロックファイルが同じコミットで動くことを強制するか、少なくとも失敗が決定的になるようツールチェーンを固定してください。[1つの CI パイプラインから複数の Flutter バージョンを対象にする方法](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)を参照してください。同じ種類の問題の Android 側は[assembleDebug が exit code 1 で失敗する件](/ja/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/)で扱っています。

## 知っておく価値のある期限

CocoaPods Trunk の spec リポジトリは 2026-12-02 に恒久的に読み取り専用へ移行します。2026-11-01 から 2026-11-07 にはリハーサルの停止も予定されています。既存の pod は引き続き解決され、CDN も配信を続けるのでビルドが壊れることはありませんが、以後どの pod も新しいバージョンを公開できなくなります。実務的な意味はこうです。この日を過ぎると、上記のケース3は待っていても直らなくなります。2つのプラグインが共有 pod の非互換なバージョンを固定していて、どちらも12月までに修正済みの podspec を出さなければ、救ってくれる上流リリースは永遠に来ません。残る出口は `Podfile` での上書きか、プラグインの SwiftPM への移行の2つだけです。どちらも来期ではなく、いま予算に組み込む価値があります。

## 参照元

- [CocoaPods Trunk read-only plan](https://blog.cocoapods.org/CocoaPods-Specs-Repo/) (CocoaPods ブログ)
- [Swift Package Manager for Flutter app developers](https://docs.flutter.dev/packages-and-plugins/swift-package-manager/for-app-developers) (docs.flutter.dev)
- [Flutter リリースノート](https://docs.flutter.dev/release/release-notes) (docs.flutter.dev)
- [CocoaPods のリリース](https://github.com/CocoaPods/CocoaPods/releases) (CocoaPods/CocoaPods)
- [flutter/flutter#168660: could not find compatible versions for pod Firebase/CoreOnly](https://github.com/flutter/flutter/issues/168660) (flutter/flutter)
- [flutter/flutter#148116: could not find compatible versions for pod GTMSessionFetcher/Core](https://github.com/flutter/flutter/issues/148116) (flutter/flutter)
