---
title: "修正: プロビジョニングプロファイルに現在選択されているデバイスが含まれていない (MAUI iOS)"
description: "Visual Studio が選択したプロファイルは、この iPhone の UDID を登録する前に生成されました。デバイスを再登録し、開発用プロファイルを再生成、ダウンロードし、再度デプロイしてください。"
pubDate: 2026-05-16
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "maui"
  - "maui-11"
  - "ios"
  - "xcode"
  - "signing"
lang: "ja"
translationOf: "2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios"
translatedBy: "claude"
translationDate: 2026-05-16
---

修正方法: MAUI が署名に使おうとした開発用プロビジョニングプロファイルに、iPhone の UDID がリストされていません。プロファイルがデバイス登録より前に生成されたか、デバイスが Visual Studio が使っているのと別のチームで登録されているか、csproj の Bundle ID がプロファイルがバインドされている App ID と一致していないかのいずれかです。Apple Developer Account で UDID を追加し、iOS App Development プロファイルを新しいデバイスを含めて再生成し、Visual Studio で Download All Profiles をクリック (CLI パスを使う場合は Xcode で `Download Manual Profiles`)、そして再デプロイしてください。自動プロビジョニングを使っている場合は、デバイスを抜き差しすれば通常 Visual Studio がプロビジョニングを再実行し、新しい UDID を取得します。

```text
Could not find any available provisioning profiles for iOS.
error : The provisioning profile doesn't include the currently selected device "iPhone (00008130-001A2C3D0EF8401E)".

error MT1006: Could not install the application 'com.example.app' on the device 'iPhone'.
error : A valid provisioning profile for this executable was not found. (0xe8008015)
```

このガイドは .NET 11 GA、ターゲットフレームワーク `net11.0-ios`、.NET MAUI 11.0.0、Xcode 16.4、そして Mac ビルドホストとペアリングされた Visual Studio 17.14 に対して書かれています。同じエラーと同じ修正方法が .NET MAUI 8 および 9 にもそのまま当てはまります。リリース間で変わるのはワークロード ID (`maui-ios`、`ios`) と同梱される Xcode の最低バージョンだけです。例外は `mlaunch` から発生します。これは MAUI が裏側で使うツールで、`.app` バンドルを実機にプッシュするためのもので、`codesign` がすでにバイナリを受け入れた後に動きます。ビルド自体は成功します。あなたを拒否するのはインストールステップです。

## なぜ MAUI iOS はプロファイルをデバイスの UDID に紐づけるのか

Apple の iOS コード署名モデルには 3 つの可動パーツがあります。署名証明書 (あなたの開発者アイデンティティ)、App ID (プロファイルがバインドされている bundle identifier)、そしてプロビジョニングプロファイル (証明書、App ID、チーム、許可されたデバイス UDID のリストを束ねた署名済みの blob) です。開発用プロファイルは、Apple が生成時点でその中に書き込んだデバイスに対してのみ有効です。新しい iPhone を挿せば、既存のいかなる開発用プロファイルも黙ってそれをカバーしなくなります。OS は `0xe8008015` (「no valid provisioning profile」を意味する MISAgent エラー) でインストールを拒否します。MAUI の `mlaunch` はそれを "provisioning provile doesn't include the currently selected device" というメッセージとして、古いツールチェーンではより難解な `MT1006` として表面化させます。

ビルド時には警告はありません。`codesign` は証明書とプロファイルの App ID だけをチェックし、デバイスリストを検査しません。デバイスリストは iPhone 上の `installd` 自身によって強制されます。これがエラーが常にデプロイ時に現れ、ビルド時には決して現れない理由です。

これを引き起こす原因は 3 つあります。

1. デバイスの UDID がプロファイルにない (最も一般的で、特に新しいテストデバイスを挿した直後)。
2. csproj の Bundle ID がプロファイルがバインドされている App ID から逸脱した (プロジェクトのリネーム、組織プレフィックスの変更、テンプレートのコピー)。
3. Visual Studio がデバイスを登録したチームとは別のチームのプロファイルで署名している (個人チーム vs 組織チーム、またはローカルにキャッシュされた古いプロファイル)。

## 最小の再現

任意の MAUI 11 iOS プロジェクトを取り、Bundle Signing を Manual に設定し、`CodesignProvision` を先週生成された開発用プロファイルに向け、今日まっさらな iPhone を挿してください。

```xml
<!-- .NET 11, .NET MAUI 11.0.0, net11.0-ios -->
<PropertyGroup Condition="'$(TargetFramework)' == 'net11.0-ios' and '$(Configuration)' == 'Debug'">
  <CodesignKey>Apple Development: Marius Bughiu (ABCDE12345)</CodesignKey>
  <CodesignProvision>MyApp Dev Profile</CodesignProvision>
  <CodesignEntitlements>Platforms/iOS/Entitlements.plist</CodesignEntitlements>
</PropertyGroup>
```

そして:

```bash
# .NET 11.0.100, MAUI workload 11.0.0
dotnet build -t:Run -f net11.0-ios -p:_DeviceName=":v2:udid=00008130-001A2C3D0EF8401E"
```

ビルドは成功します。デプロイは「デバイスが含まれていない」メッセージで失敗します。なぜなら `MyApp Dev Profile` という名前のプロファイルは、`00008130-001A2C3D0EF8401E` が Apple の認識するデバイスになる前に生成されたからです。

## 修正パス A: 古くなった自動プロビジョニング

`iOS Bundle Signing` スキームが **Automatic Provisioning** (開発の推奨デフォルト) に設定されている場合、Visual Studio は新しいデバイスが挿されるたびにプロビジョニングを再実行し、それを含めるためにプロファイルを黙って再生成するはずです。そのメカニズムが詰まると、あなたが読んでいるエラーはその症状です。

1. **Tools > Options > Xamarin > Apple Accounts** を開き、チームを選択し、**View Details** をクリックします。期待しているチームが Visual Studio が使っているチームであることを確認してください。2 つのチーム (個人チーム「Marius Bughiu」と組織チーム) が見える場合、それぞれが独自のプロファイルプールを持っており、Visual Studio は現在プロジェクトにバインドされているチームに対してのみ自動プロビジョニングします。
2. プロジェクトを右クリックし、**Properties**、**iOS > Bundle Signing**。**Scheme** が **Automatic Provisioning** で、**Signing Identity** と **Provisioning Profile** がともに **Automatic** に設定されており、**Configure Automatic Provisioning** が緑のチェックを表示していることを確認してください。ダイアログがエラーを報告する場合は、それを読んでください。「Authentication Service Is Unavailable」はほぼ常に、[App Store Connect](https://appstoreconnect.apple.com/) または [Apple Developer](https://developer.apple.com/account) に未承認の契約があることを意味します。
3. iPhone を Mac ビルドホストから抜き、2 秒待ち、もう一度挿してください。Visual Studio は USB イベントを聞いており、自動プロビジョニングを再実行します。これが新しい UDID を登録し、開発用プロファイルを再生成します。再デプロイ前に **Output > General** ペインで `Automatic provisioning succeeded` を確認してください。
4. 最後の成功ビルド以降に Mac を入れ替えた場合、署名証明書のプライベートキーはおそらく移動していません。Visual Studio はそれを Apple Accounts ダイアログで **Not in Keychain** ステータスで知らせます。元の Mac の Keychain Access から `.p12` をエクスポートし、Apple Accounts ダイアログの **Import Certificate** でインポートし、再試行してください。

自動プロビジョニングはまだ Mac ビルドホストがペアリングされて到達可能であることを必要とします。`Pair to Mac` が黄色を示す場合、USB デバイスイベントは伝播せず、新しい UDID は決して登録されません。先に再ペアリングしてください。

## 修正パス B: 手動プロビジョニング、明示的な csproj パス

iOS の署名を明示的なコントロール下に保つ場合 (CI、エンタープライズ配布、チーム間で共有された Apple アカウント)、登録と再生成を手作業で行います。

1. Mac で **Xcode > Window > Devices and Simulators**、iPhone を選択し、**Identifier** 文字列をコピーします。これは `installd` がチェックする UDID です。A12+ デバイスではフォーマットは `00008130-001A2C3D0EF8401E` です。タイプしないでください。コピーしてください。UDID はハイフン付きで 25 文字です。1 文字でも間違えれば、プロファイルは黙って一致しません。
2. ブラウザで [Apple Developer の Devices](https://developer.apple.com/account/resources/devices/list)、**+**、プラットフォーム **iOS, tvOS, watchOS** を選択、UDID を貼り付け、覚えやすい名前を付け、**Continue**、**Register**。
3. [Profiles](https://developer.apple.com/account/resources/profiles/list) で開発用プロファイルを見つけ、**Edit**、Devices リストで新しく追加されたデバイスにチェックを入れ、**Save**、**Download**。プロファイルを編集すると再生成されます。ファイル名は同じままで、中身が変わります。Apple は新しいファイルをあなたのマシンにプッシュしません。あなたがダウンロードする必要があります。
4. 再生成されたプロファイルをインストールします。Mac では `.mobileprovision` をダブルクリックすると `~/Library/MobileDevice/Provisioning Profiles/` に登録されます。Windows では、Visual Studio で **Tools > Options > Xamarin > Apple Accounts** に行き、チームを選択、**View Details**、**Download All Profiles**。プロファイルは Windows とペアリングされた Mac の両方に同期されます。
5. csproj が正しいプロファイルを指していることを確認します。`CodesignProvision` の文字列は Apple Developer のプロファイル **Name** と完全に一致しなければなりません。ファイル名ではなく、UUID でもありません。

    ```xml
    <!-- .NET 11, .NET MAUI 11.0.0 -->
    <PropertyGroup Condition="'$(TargetFramework)' == 'net11.0-ios' and '$(Configuration)' == 'Debug'">
      <CodesignKey>Apple Development: Marius Bughiu (ABCDE12345)</CodesignKey>
      <CodesignProvision>MyApp Dev Profile</CodesignProvision>
    </PropertyGroup>
    ```

    `CodesignKey` は Keychain Access の **My Certificates** に表示される証明書の common name です。`CodesignProvision` は Apple Developer ワークフローのステップ 3 で入力したプロファイル名です。両方とも大文字小文字を区別します。完全なスキーマは [CodesignKey](https://learn.microsoft.com/en-us/dotnet/ios/building-apps/build-properties#codesignkey) と [CodesignProvision](https://learn.microsoft.com/en-us/dotnet/ios/building-apps/build-properties#codesignprovision) を参照してください。

6. リビルドして再デプロイします。失敗が続く場合は、下の gotcha に飛んでください。UDID は正しく登録されているので、何か他のことがおかしいのです。

## プロファイルが実際にデバイスを含むことを検証する

プロジェクトを解体する前に、プロファイルが正しいことを証明してください。macOS の `security` は `.mobileprovision` の周りの CMS エンベロープをデコードします。

```bash
# macOS, security tool ships with the OS
security cms -D -i ~/Library/MobileDevice/Provisioning\ Profiles/<UUID>.mobileprovision \
  | plutil -convert xml1 -o - - \
  | grep -A1000 ProvisionedDevices \
  | head -50
```

`<key>ProvisionedDevices</key>` の中にあなたの UDID を持つ `<string>` 要素が見えるはずです。それがなければ、Provisioning Profiles フォルダ内のプロファイルは再生成前のコピーです。削除し、Visual Studio または Xcode から再ダウンロードしてください。macOS は古いファイルを先に削除しない限り、同じ UUID の新しいプロファイルで既存のプロファイルを上書きしません。これが「新しいプロファイル」を持っていると思っているけれど、実際には先週のものを持っている多くの人を捕まえます。

そこにいるついでに、`<key>application-identifier</key>` の値もチェックしてください。これは `<TEAM_ID>.<bundle-id>` と等しくなければなりません。ここで bundle id は csproj の **Application ID** と完全に同じです。それらが異なる場合、csproj または `Info.plist` がドリフトしています。gotchas の Bundle ID ドリフトのセクションを参照してください。

## Gotcha と紛らわしいケース

**デバイスではなく、シミュレーターにデプロイしている。** シミュレーターはプロビジョニングプロファイルを全く必要としませんが、プロジェクトが `CodesignProvision` 経由でプロファイルを強制しており、誤って `iPhone 15 Pro Simulator` ターゲットを選択していると、`mlaunch` はそれでも文句を言います。Visual Studio ツールバーの **Debug Target** を **iOS Remote Devices** に切り替え、物理デバイスを選んでください。

**Development ではなく Distribution を実行している。** 開発用プロファイルは Development 対応デバイスのみを含み、`Apple Development` 証明書でのみ署名します。`Configuration` が `Release` で、プロジェクトが `Apple Distribution` 証明書を使う場合、ad-hoc distribution プロファイルが必要で、あなたの dev プロファイルは選ばれません。並列の手動ステップについては [ad-hoc 配布のための公開](https://learn.microsoft.com/en-us/dotnet/maui/ios/deployment/publish-ad-hoc?view=net-maui-10.0) の公式ガイドを参照してください。

**Bundle ID ドリフト。** **Project Properties > MAUI Shared > General** の Application ID は、ワイルドカードまたは明示的な App ID がカバーする Bundle ID と一致しなければなりません。ワイルドカードプロファイル `com.example.*` は `com.example.app` をカバーしますが、`com.example.app.dev` はカバーしません。サンプルをフォークして App ID を更新しなかった場合、プロファイルは App ID の不一致で拒否され、OS が両方のチェックを同じ 0xe8008015 コードに丸めるため、`mlaunch` はそれを「デバイスが含まれていない」エラーとして報告します。

**ワイルドカードプロファイルだが、明示的な App ID が必要な entitlement。** Push Notifications、App Groups、Apple Pay、iCloud、Game Center、HealthKit、HomeKit、NFC、Associated Domains、In-App Purchase、Wireless Accessory Configuration はすべて明示的な App ID を必要とします。プロファイルがワイルドカードである間にこれらを `Entitlements.plist` で有効にすると、インストールは失敗します。bundle identifier に一致する明示的な App ID に切り替え、entitlement にチェックを入れてプロファイルを再生成してください。

**同じ App ID、別のチームの 2 つのプロファイル。** キャッシュされたプロファイルはチームでキーされません。同じマシンで別の Apple Developer チームにサインインしたことがある場合、両方のチームのプロファイルが `~/Library/MobileDevice/Provisioning Profiles/` に並んで存在します。Visual Studio は 1 つを選びますが、しばしば古いものまたはアルファベット順で最初のものを選び、デバイスが別のチームで登録されているためデバイスリストが一致しません。古いプロファイルファイルを削除し、**Download All Profiles** で再ダウンロードしてください。

**デバイスが supervised か、信頼を失った。** iPhone で **Settings > General > VPN & Device Management** に開発者証明書がリストされ、**Trust** をタップできるはずです。「Trust This Computer」が却下されていた場合、`installd` は明確な理由なしにデプロイを拒否し、`mlaunch` は「デバイスが含まれていない」メッセージを表面化させることがあります。再ペアリングし、Trust をタップし、再試行してください。

**無料の Apple ID アカウントはプロファイルの寿命が 7 日です。** 個人チーム (有料メンバーシップなし) は作成後 7 日で期限切れになる開発用プロファイルを生成します。期限切れはデプロイ時に、デバイスが見つからないケースと同じ形で現れます。修正方法は Xcode から少なくとも 1 回 Run をクリックして再生成するか、有料の Apple Developer Program アカウントにアップグレードすることです。

**`MT1006: Could not install the application`。** これは `mlaunch` の任意のデプロイ失敗のラッパーで、特定の原因ではありません。ビルドログの最初の兄弟行が本当のエラーです。デバイスが見つからないケースでは、それが "provisioning profile doesn't include" の行です。Khalid Abuhakmeh の [missing entitlements](https://khalidabuhakmeh.com/fix-dotnet-maui-missingentitlement-and-provisioning-profiles-issues) の書き込みは、同じ MT1006 表面の entitlements バリアントを歩きます。

## 関連

- 「ビルドラッパーが本当のエラーを隠す」の Android 版は [XA1029 Gradle ビルド失敗のウォークスルー](/ja/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/) でカバーされています。
- 同じプロジェクトで iOS ホットリロードを設定している場合、[.NET 11 preview 4 の MAUI Android と iOS での dotnet watch](/ja/2026/05/dotnet-watch-maui-android-ios-net-11-preview-4/) は署名が修正されたら戻れる watch ループをカバーします。
- 開発ループが動作した後の配布フローについては、Windows 側について [Microsoft Store 向けの MAUI アプリのパッケージ化](/ja/2026/05/how-to-package-a-maui-app-for-the-microsoft-store/)、iOS 側について [ad-hoc 配布のドキュメント](https://learn.microsoft.com/en-us/dotnet/maui/ios/deployment/publish-ad-hoc?view=net-maui-10.0) を参照してください。
- ターゲットがデスクトップのみで、モバイル署名を完全にスキップしたい場合、[Windows と macOS のみで動作する MAUI アプリ、モバイルターゲットなし](/ja/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) は TFM `net11.0-ios` を削除する方法を示します。
- .NET 11 の iOS における基盤となるランタイムコンテキストについては、[.NET 11 preview 4 の MAUI CoreCLR デフォルト for Android と iOS](/ja/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/) の投稿が `mlaunch` の下で何が変わったかをカバーします。

## ソース

- [Manual provisioning for .NET MAUI iOS apps](https://learn.microsoft.com/en-us/dotnet/maui/ios/device-provisioning/manual-provisioning?view=net-maui-10.0) (Microsoft Learn)
- [Automatic provisioning for .NET MAUI iOS apps](https://learn.microsoft.com/en-us/dotnet/maui/ios/device-provisioning/automatic-provisioning?view=net-maui-10.0) (Microsoft Learn)
- [Device provisioning for .NET MAUI apps on iOS](https://learn.microsoft.com/en-us/dotnet/maui/ios/device-provisioning/?view=net-maui-10.0) (Microsoft Learn)
- [Build properties for iOS: CodesignKey and CodesignProvision](https://learn.microsoft.com/en-us/dotnet/ios/building-apps/build-properties#codesignkey) (Microsoft Learn)
- [Publish a .NET MAUI iOS app for ad-hoc distribution](https://learn.microsoft.com/en-us/dotnet/maui/ios/deployment/publish-ad-hoc?view=net-maui-10.0) (Microsoft Learn)
- [Manual iOS Provisioning, dotnet/maui#7056](https://github.com/dotnet/maui/issues/7056) (GitHub)
- [Khalid Abuhakmeh: Fix .NET MAUI MissingEntitlement and Provisioning Profiles Issues](https://khalidabuhakmeh.com/fix-dotnet-maui-missingentitlement-and-provisioning-profiles-issues)
