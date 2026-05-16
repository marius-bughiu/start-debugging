---
title: "Fix: MAUI ビルド時の Unable to find a valid iOS Simulator runtime"
description: "Xcode 15 以降は iOS シミュレーターランタイムが同梱されません。SupportedOSPlatformVersion に一致するランタイムが未インストールだと MAUI のビルドが失敗します。xcodebuild -downloadPlatform iOS または Xcode Settings からインストールし、xcrun simctl list runtimes で確認してください。"
pubDate: 2026-05-16
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "maui"
  - "maui-11"
  - "ios"
  - "xcode"
  - "simulator"
lang: "ja"
translationOf: "2026/05/fix-unable-to-find-a-valid-ios-simulator-runtime-during-maui-build"
translatedBy: "claude"
translationDate: 2026-05-16
---

修正方法: Xcode 15 以降、iOS シミュレーターランタイムは Xcode 本体に同梱されなくなり、Xcode 26 以降は前バージョンの Xcode のランタイムも自動的には移行されなくなりました。MAUI iOS のツールチェーンは csproj から `SupportedOSPlatformVersion` を読み取り、そのバージョン以上のシミュレーターを Xcode に要求し、一致するものがないと `Unable to find a valid iOS Simulator runtime` で停止します。`xcrun simctl list runtimes` を実行して実際に何がインストールされているかを確認し、Xcode の Settings、Platforms、プラスボタンからダウンロードするか、ヘッドレスで `xcodebuild -downloadPlatform iOS` を実行してください。csproj の `SupportedOSPlatformVersion` がインストール済みのどのランタイムよりも高い場合は、手元にあるバージョンまで下げるか、対応するランタイムをインストールします。

```text
/usr/local/share/dotnet/packs/Microsoft.iOS.Sdk/18.2.9270/targets/Xamarin.Shared.Sdk.targets(1245,3):
error : Unable to find a valid iOS Simulator runtime. Please install one from Xcode > Settings > Platforms.

xcodebuild: error: Unable to find a destination matching the provided destination specifier:
        { platform:iOS Simulator, OS:18.2, name:iPhone 16 Pro }

Could not find the simulator runtime 'com.apple.CoreSimulator.SimRuntime.iOS-18-2'.
```

本ガイドは .NET 11 preview 4、MAUI 11 preview 4、Xcode 26.0、`Microsoft.iOS.Sdk` 18.2.9270 を対象としています。この挙動は、Apple が Xcode 15 でシミュレーターランタイムを Xcode インストーラーから切り離した瞬間に出現したもので、Xcode 26 では前バージョンの Xcode のランタイムキャッシュを初回起動時に暗黙的に取り込まなくなったため、はるかに目立つようになりました。最近アップグレードして理由もなくビルドパイプラインが落ち始めたなら、原因はほぼ間違いなくこれです。

## なぜ Xcode 15 が MAUI iOS のビルドを壊したのか

Xcode の歴史の大部分において、インストーラーは Apple Developer ポータルからダウンロードしたのと同じ `.xip` の中に iOS シミュレーターランタイムを抱え込んでおり、それが Xcode のサイズが 7GB 以上になっていた理由の一端でした。Xcode 15 で Apple はランタイムを別ダウンロードモデルに切り出しました。Xcode アプリにはツールチェーン (コンパイラー、SDK、ヘッダー) と iOS シミュレーターアプリ自体が同梱されますが、個別のランタイムイメージ (`iOS 17.4`、`iOS 18.2` など) はそれぞれ別ダウンロードで、自分が必要なものだけを取得します。インストーラーは約 3GB まで縮み、必要なプラットフォームだけ引いてくる形になります。

ディスク使用量にとっては素晴らしい話で、初回のビルドにとっては最悪です。`net11.0-ios` をターゲットにする MAUI プロジェクトは `Microsoft.iOS.Sdk` からターゲット SDK を解決し、ランタイムバージョンを含む destination 文字列を `xcodebuild` に渡し、`xcrun simctl create` または `xcrun simctl boot` が `~/Library/Developer/CoreSimulator/Profiles/Runtimes` および `/Library/Developer/CoreSimulator/Profiles/Runtimes` で一致するランタイムを探そうとします。何もインストールされていなければ、これらの呼び出しのどれも成功せず、上記のエラーが出ます。

Xcode 26 では別のひねりが加わりました。Apple はランタイムを Xcode バンドルから完全に独立したものとして扱うようになり、新しい `CoreSimulator` フレームワークは Xcode ごとの互換性マトリックスを保持します。Xcode 16 で iOS 18.2 シミュレーターをインストールしていて、Xcode 26 にアップグレードし、csproj が `iOS 19.0` をターゲットにしているなら、18.2 ランタイムはディスク上にあるものの、MAUI が要求しているものとは違います。エラーメッセージの文言は変わらないため、アップグレード時に混乱を招くわけです。

## MAUI が実際に要求しているもの

`dotnet build -t:Run -f net11.0-ios -p:_DeviceName=":v2:runtime=com.apple.CoreSimulator.SimRuntime.iOS-19-0,devicetype=com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro"` を実行すると、`Microsoft.iOS.Sdk` の MAUI iOS ターゲットは次のような処理を行います。

1. プロジェクトから `SupportedOSPlatformVersion` と `_MtouchTargetiOSVersion` を解決します。
2. `xcrun simctl list runtimes -j` を呼び出して、ローカルにインストールされているものを調べます。
3. バージョンがターゲット以上で、プラットフォーム (`iOS-Simulator`) が一致する最初のランタイムを選びます。
4. 何も一致しない場合、MSBuild タスクは `xcrun simctl boot` を呼び出す前に `Unable to find a valid iOS Simulator runtime` エラーを投げます。

これは `Xamarin.Shared.Sdk.targets` の `_DetectSimulator` タスクで実装されています。要点は次のとおり: このエラーは、当該プラットフォーム向けのインストール済みランタイムリストが空であるか、インストール済みのすべてのランタイムが csproj のターゲットより低いバージョンであることを意味します。

## 実際に何がインストールされているか確認する

csproj に手を入れる前に、ランタイムを一覧表示してください。

```bash
# macOS, any shell
xcrun simctl list runtimes --json | jq '.runtimes[] | {name, version, identifier, isAvailable}'
```

健全なマシンでは次のような出力が得られます。

```json
{
  "name": "iOS 19.0",
  "version": "19.0",
  "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-19-0",
  "isAvailable": true
}
```

Xcode のアップグレード後に壊れているマシンでは、`runtimes` 配列が空になっているか、`"isAvailable": false` のフラグが立ち、`availabilityError` 文字列でランタイムが「この Xcode のバージョンとは非互換」と説明されます。利用不可とマークされたランタイムはディスク上にはあるものの Xcode が使用を拒否するため、MAUI は欠落しているものとして扱います。

同じ情報は Xcode 内の **Settings、Platforms** からも確認できます。インストール済みランタイムにはチェックマークが付き、それぞれインストール／削除を行えます。

## コマンドラインからランタイムをインストールする

ヘッドレスや CI 環境であれば、Xcode の UI をクリックして回らないでください。Xcode 15 で `xcodebuild` に `-downloadPlatform` フラグが追加されました。

```bash
# Xcode 15+, downloads the latest iOS simulator runtime
# compatible with this Xcode version
xcodebuild -downloadPlatform iOS

# Xcode 16+, pin to a specific build of the runtime
xcodebuild -downloadPlatform iOS -buildVersion 18.2
```

このコマンドはフォアグラウンドで動作し、進捗率を表示しながらランタイムを `~/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS <version>.simruntime` に書き込みます。1 ランタイムあたり約 8GB なので、CI ではそれを前提に計画してください。Apple は [Downloading and installing additional Xcode components](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components) でこれを文書化しています。

古い Xcode (Xcode 15 のみ) では、古い形式である `xcodebuild -downloadAllPlatforms` が、互換性のあるすべてのプラットフォームランタイムをダウンロードします。`-downloadPlatform iOS` よりはるかに重く、CI ではほぼ使うべきではありません。

現行 Xcode の互換性セットに含まれないランタイムが必要な場合、たとえば Xcode 26 で顧客のバグを再現するために iOS 17.4 が欲しいといった場合は、ダウンロードした `.dmg` や `.simruntime` からインストールしてください。

```bash
# Manually install a simruntime image from disk
xcrun simctl runtime add "/path/to/iOS 17.4.simruntime"
```

サブコマンド `xcrun simctl runtime` は Xcode 16+ に存在し、別途ダウンロードしたランタイムを登録するためのサポート対象の方法です。登録済みのランタイムイメージは `xcrun simctl runtime list` で一覧できます。

## SupportedOSPlatformVersion を手持ちのランタイムに合わせる

`iOS 18.2` をインストールしても csproj が `iOS 19.0` をターゲットにしているなら、エラーは繰り返します。csproj の iOS 固有セクションを開き、ターゲットを下げるか、新しいランタイムが必要であることを受け入れてください。

```xml
<!-- .NET 11, MAUI 11, Microsoft.iOS.Sdk 18.2.9270 -->
<PropertyGroup Condition="$(TargetFramework.Contains('-ios'))">
  <SupportedOSPlatformVersion>15.0</SupportedOSPlatformVersion>
</PropertyGroup>
```

`SupportedOSPlatformVersion` はアプリがランタイム時にサポートする iOS の**最小**バージョンです。起動するシミュレーターランタイムはこの数値以上である必要があります。MAUI がデフォルトで起動する実際のシミュレーターは最小ではなくインストール済みランタイムの最高バージョンなので、iOS 19.0 がインストールされていれば、プロジェクトの下限が 15.0 でもアプリは iOS 19.0 で起動します。

エラーを黙らせるために `SupportedOSPlatformVersion` を引き上げてはいけません。それは間違ったレバーです。正しい手は、ランタイムをインストールして、プロジェクトの下限はあなたの利用者にとって本来必要な値のまま残すことです。

## dotnet build から特定のシミュレーターを指定する

複数のランタイムがインストールされていて特定のものを使いたい場合は、MAUI の iOS Run ターゲットに `_DeviceName` を渡します。これは `xcrun simctl` が内部で使うものと同じ文字列です。

```bash
# .NET 11 preview 4, MAUI 11 preview 4
dotnet build -t:Run -f net11.0-ios \
  -p:_DeviceName=":v2:runtime=com.apple.CoreSimulator.SimRuntime.iOS-18-2,devicetype=com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro"
```

プレフィックス `:v2:` は必須で、MAUI は新フォーマットのデバイスセレクターとしてこれを解析します。ランタイム識別子は `xcrun simctl list runtimes` の `identifier` 出力と一致し、デバイスタイプ識別子は `xcrun simctl list devicetypes` の出力と一致します。

`_DeviceName` を省略すると、MAUI は最も高いインストール済みランタイムで最新の iPhone シミュレーターを選びます。ローカル開発には十分ですが、CI で Xcode の新しいポイントリリースが降ってくると驚くほど脆くなります。

## CI 特有の修正

GitHub Actions のまっさらな `macos-15` や `macos-26` ランナーでは、Xcode はプリインストール済みですが、`SupportedOSPlatformVersion` と一致する iOS シミュレーターランタイムは入っていない可能性があります。Apple のホストイメージはランタイムを 1 つか 2 つ焼き込んでいますが、他プロバイダーのビルドエージェントはまちまちです。安全なパターンは、`dotnet build` の前に明示的にインストールすることです。

```yaml
# .github/workflows/maui-ios.yml
- name: Select Xcode
  run: sudo xcode-select -s /Applications/Xcode_26.0.app

- name: Install iOS 18.2 simulator runtime
  run: xcodebuild -downloadPlatform iOS -buildVersion 18.2

- name: Verify runtime is registered
  run: xcrun simctl list runtimes

- name: Build MAUI iOS
  run: dotnet build src/App/App.csproj -c Release -f net11.0-ios
```

ここでは 2 点が人を噛みます。第 1 に、ランナーはオプトインしない限りジョブ間でキャッシュしないため、ランタイムバージョンをキーにした [`actions/cache`](https://github.com/actions/cache) を組み込まないと、各ジョブが 8GB を再ダウンロードします。第 2 に、`xcodebuild -downloadPlatform` はランタイムが既にインストールされていてもエラーにはなりませんが、メタデータの再取得は行います。キャッシュが温まっていれば数秒で完了します。

CI が古い Xcode (Xcode 14 以前) で動いている場合、`-downloadPlatform` は存在しません。Xcode をアップグレードするか、`xcodes` (`brew install xcodes`) のようなサードパーティーツールにフォールバックして `sudo xcodes runtimes install "iOS 18.2"` を実行します。コミュニティーメンテナンスの `xcodes` は Xcode 15 以前の唯一の良い答えでしたし、Apple がもう Developer ポータルでホストしていない古いランタイムが必要なときにも今なお有用です。

## アップグレード後に CoreSimulator サービスが詰まる

ランタイムがインストールされ、`xcrun simctl list runtimes` で利用可能と表示され、それでも MAUI が失敗することがあります。原因はたいてい、アップグレード前の Xcode のランタイム一覧をキャッシュしている古い `CoreSimulatorService` です。kill してください。

```bash
sudo killall -9 com.apple.CoreSimulator.CoreSimulatorService
```

このサービスは次の `xcrun simctl` 呼び出しで再起動し、ランタイムディレクトリを読み直します。これは [dotnet/macios#22243](https://github.com/dotnet/macios/issues/22243) を含む `dotnet/macios` の複数の issue で文書化されており、再起動なしで CoreSimulator を更新する `softwareupdate -ai` の後にもっとも頻発します。

サービスを kill しても解決しない場合は、`~/Library/Developer/CoreSimulator/Caches` も削除して再起動してください。`CoreSimulator` には派生データキャッシュがあり、これが削除済みのランタイムパスを指していることがあります。

## 間違った Xcode が選択されているとき

もう 1 つよくある偽陽性: `xcode-select -p` が、ランタイムをインストールした Xcode とは別の Xcode を指しているケースです。ランタイムは技術的には `CoreSimulator` を介してアクティブな Xcode に対して登録されており、Xcode を切り替えるとファイルは存在していても新しいアクティブな Xcode からはランタイムが見えない状態になり得ます。

```bash
# Show the active Xcode
xcode-select -p
# /Applications/Xcode_26.0.app/Contents/Developer

# Switch to a specific Xcode
sudo xcode-select -s /Applications/Xcode_26.0.app
```

MAUI は `DEVELOPER_DIR` も尊重します。CI ステップがこれをエクスポートすると、`xcode-select` を上書きします。`xcode-select` と `DEVELOPER_DIR` の不一致は、パイプラインを 2 回目に走らせたときにだけ顕在化するタイプのバグで、キャッシュされた環境変数が新規ランナーの初期値と衝突するケースです。[MAUI のトラブルシューティングガイド](https://learn.microsoft.com/en-us/dotnet/maui/troubleshooting?view=net-maui-10.0) は Xcode 選択の優先順位を文書化しています: `DEVELOPER_DIR`、次に非推奨の plist ファイル、次に `xcode-select -p`、次に `/Applications/Xcode.app`。

## 修正後の落とし穴

ランタイムをインストールした後でも、いくつかの点で人はつまずきます。

1. **Apple Silicon と Intel のシミュレータースライス**。iOS 17.0+ のシミュレーターランタイムは arm64 スライスのみを同梱します。Rosetta 上の Intel Mac で動かしている場合、起動できません。古いランタイムを使うか、ビルドエージェントをアップグレードしてください。
2. **Mac Catalyst の混同**。`net11.0-maccatalyst` はシミュレーターランタイムを必要とせず、macOS 上でネイティブに動作します。Mac Catalyst のビルドがこのエラーで失敗するなら、同じプロジェクトに紛れ込んだ `net11.0-ios` ターゲットを IDE が拾ってしまったケースがほとんどです。
3. **`-buildVersion` の不一致**。`xcodebuild -downloadPlatform iOS -buildVersion 18.2` は `18.2` のようなマーケティングバージョンを受け取りますが、`22C150` のような内部ビルド番号は受け取りません。ビルド番号を渡すと、暗黙的に最新版がダウンロードされます。
4. **App Store Connect へのアップロードはシミュレーターなしでも動く**。デバイス向けビルド (`-p:RuntimeIdentifier=ios-arm64`) はシミュレーターランタイムをまったく必要としません。CI が TestFlight への配信のみであれば、インストールを完全にスキップして署名だけ整えれば済みます。

同じプロジェクトで Android 側のビルドエラーとも戦っている場合、同じパターン (ツールチェーンが期待するコンポーネントをインストーラーがもう同梱していない) がそちらでも発生します。[MAUI Android で Gradle が APK 生成に失敗する件](/ja/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/) の解説を参照してください。シミュレーターには関係しないものの見た目が似ている iOS 側のエラーには、[プロビジョニングプロファイルのデバイス不一致の修正](/ja/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/) が該当の経路をカバーします。このプロジェクトでクロスプラットフォームモバイルから完全に離れたい場合は、[Windows と macOS のみで動作する MAUI](/ja/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) の記事がデスクトップ専用のターゲットフレームワークを解説しています。MAUI 11 のリリース全体の背景については、[.NET 11 preview 4 における MAUI の CoreCLR デフォルト化](/ja/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/) の投稿が、内部で何が変わったかを説明しています。

最短の修正はほぼ確実に `xcodebuild -downloadPlatform iOS` の後に `dotnet build` です。少し長めの修正は、その 1 行を CI スクリプトに書いておくことで、チームに次に加わるエージェントが午後を 1 つ無駄にしなくて済みます。

## 参考リンク

- [Downloading and installing additional Xcode components](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components)
- [Troubleshoot known issues - .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/troubleshooting?view=net-maui-10.0)
- [dotnet/macios#22243 - Can't find simulator when a particular iOS SDK version doesn't contain a simulator](https://github.com/dotnet/macios/issues/22243)
- [dotnet/maui#23352 - iOS build failed with iossimulator-x64 RuntimeIdentifier](https://github.com/dotnet/maui/issues/23352)
- [Build with a specific version of Xcode](https://learn.microsoft.com/en-us/dotnet/ios/cli)
