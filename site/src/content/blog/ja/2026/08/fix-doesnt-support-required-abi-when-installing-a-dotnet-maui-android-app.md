---
title: "Fix: .NET MAUI の Android アプリをインストールすると Doesn't support required ABI になる"
description: "APK に端末の CPU 向けのネイティブライブラリが入っていないのが原因です。.NET 9 以降、Android の RuntimeIdentifiers の既定値は 64 ビットのみになったため、RuntimeIdentifiers を明示的に指定して解決します。ADB0020、XA0036、NETSDK1083、ABI と RID の対応、Play Console の文言、そして誰もがコピーする 4 つの RID のスニペットが .NET 11 で壊れる理由を扱います。"
pubDate: 2026-08-29
template: error-page
tags:
  - "errors"
  - "maui"
  - "dotnet"
  - "android"
  - "dotnet-11"
  - "coreclr"
lang: "ja"
translationOf: "2026/08/fix-doesnt-support-required-abi-when-installing-a-dotnet-maui-android-app"
translatedBy: "claude"
translationDate: 2026-08-29
---

インストール先のマシンの CPU に対応するネイティブライブラリが、アプリのパッケージに入っていません。Android は間違ったバイナリを実行する代わりに、インストールを拒否します。.NET 9 以降、`net9.0-android` 以降のプロジェクトがビルドするのは `arm64-v8a` と `x86_64` だけです。同じプロジェクトが .NET 8 では 4 つの ABI をビルドしていたので、きっかけは自分の変更ではなくアップグレードであることがほとんどです。Android のターゲットフレームワークに対して `$(RuntimeIdentifiers)` を設定すれば直ります。ただし正しい RID の組み合わせは .NET のバージョンによって変わります。.NET 11 が Android x86 を完全に削除したため、検索結果のほとんどに載っている 4 つの RID のスニペットは、今ではビルドを失敗させます。

## エラーの実際の姿

同じ原因が、インストールを実行する主体によって 3 通りの文言で現れます。

Visual Studio から配置した場合や `dotnet build -t:Run` を使った場合は、.NET for Android のビルドエラーになります。

```
error ADB0020: The package does not support the CPU architecture of this device.
```

Android SDK の `adb` で自分で APK をインストールすると、その下位のエラーがそのまま出ます。

```
adb: failed to install com.company.app-Signed.apk:
Failure [INSTALL_FAILED_NO_MATCHING_ABIS: Failed to extract native libraries, res=-113]
```

ADB0020 は、これと古い `INSTALL_FAILED_CPU_ABI_INCOMPATIBLE` を .NET for Android が翻訳したものです。そして Google Play Console は同じことを端末カタログの用語で表現します。"required ABI" という言い回しはここから来ています。

```
Doesn't support required ABI: arm64-v8a, x86_64
```

ユーザーの端末では、同じ状態が Play ストアの「お使いのデバイスはこのバージョンに対応していません」や、サイドロードした APK での素っ気ない「アプリをインストールできませんでした」として現れます。

## 端末が実際に必要としている ABI は何か

端末に聞いてください。Android の端末もエミュレーターも、対応する ABI を優先順位つきで公開しています。

```bash
adb shell getprop ro.product.cpu.abilist
```

最近のスマートフォンは `arm64-v8a,armeabi-v7a` と答えます。64 ビット専用の端末は `arm64-v8a` と答えます。Apple Silicon の Mac 上のエミュレーターイメージは `arm64-v8a` と答え、Google の x86_64 イメージが `x86_64,arm64-v8a` と答えるのは ARM 変換を備えている場合だけで、これはあてにすべきものではありません。

次に、パッケージの中身を確認します。ネイティブライブラリは APK の `lib/<abi>/` に入っています。

```bash
unzip -l bin/Release/net11.0-android/com.company.app-Signed.apk | grep 'lib/'
```

```text
lib/arm64-v8a/libmonodroid.so
lib/arm64-v8a/libSystem.Native.so
lib/x86_64/libmonodroid.so
lib/x86_64/libSystem.Native.so
```

App Bundle の場合、接頭辞は `base/lib/` になります。

```bash
unzip -l bin/Release/net11.0-android/com.company.app-Signed.aab | grep 'base/lib/'
```

この 2 つのリストの共通部分が空である、というのがこの不具合のすべてです。上のリストは Apple Silicon のエミュレーターと最近のスマートフォンにはインストールでき、`abilist` が `armeabi-v7a` だけの端末にはインストールできません。

## .NET 9 で何が変わったか

.NET 8 以前は、既定で Android の 4 つの ABI すべてをビルドしていました。.NET 9 は Android 向けの `$(RuntimeIdentifiers)` の既定値を、64 ビットの 2 つに絞りました。

```text
net8.0-android    armeabi-v7a  arm64-v8a  x86  x86_64
net9.0-android                 arm64-v8a       x86_64
net10.0-android                arm64-v8a       x86_64
net11.0-android                arm64-v8a       x86_64
```

理由は、.NET がモバイルプラットフォームのベンダーに追随しているからで、Google は 2019 年から Play への申請に 64 ビットビルドを必須としています。ビルド時には何の警告も出ません。ビルドの側から見れば何も間違っていないからです。気づくのは、古い端末を使うテスターがインストールできないと言ってきたときか、Play Console の端末カタログが対応端末リストから数千のモデルを黙って落としたときです。

趣味のプロジェクトだったり、比較的新しいハードウェアを対象にしていたりするなら、新しい既定値のほうが適切なのでそのままにしておくべきです。ABI が 4 つから 64 ビットの 2 つになると、MAUI の APK はおよそ半分になります。

## 解決方法

`$(RuntimeIdentifiers)` を明示的に設定します。iOS や Windows のビルドに漏れないよう、Android のターゲットフレームワークを条件にしてください。

```xml
<!-- .NET 9 and .NET 10 -->
<PropertyGroup Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'android'">
  <RuntimeIdentifiers>android-arm;android-arm64;android-x86;android-x64</RuntimeIdentifiers>
</PropertyGroup>
```

ターゲットが 1 つだけのプロジェクトなら、TFM の文字列に対する単純な条件で構いません。

```xml
<PropertyGroup Condition="'$(TargetFramework)' == 'net10.0-android'">
  <RuntimeIdentifiers>android-arm;android-arm64;android-x64</RuntimeIdentifiers>
</PropertyGroup>
```

既定で選ぶべきなのは、この 2 つ目の組み合わせです。実際のハードウェアが存在する唯一の 32 ビット ABI である 32 ビット ARM を復活させ、実質的には古いエミュレーターイメージと少数の Intel Atom タブレットを意味するだけの 32 ビット x86 を外しています。

変更したらリビルドしてください。ABI ごとのネイティブライブラリは `obj/` に配置されるので、増分ビルドはこのプロパティより前のレイアウトを平然と再利用します。

## ABI 名は runtime identifier ではない

これが最もよくある最初の失敗です。`$(AndroidSupportedAbis)` は ABI 名を受け取っていたので、その後継のプロパティにも ABI 名を貼り付けてしまうわけです。

```xml
<!-- wrong -->
<RuntimeIdentifiers>armeabi-v7a;arm64-v8a;x86;x86_64</RuntimeIdentifiers>
```

```text
error NETSDK1083: The specified RuntimeIdentifier 'armeabi-v7a' is not recognized.
```

2 つの語彙は 1 対 1 で対応します。

| Android の ABI | .NET の runtime identifier |
| --- | --- |
| `armeabi-v7a` | `android-arm` |
| `arm64-v8a` | `android-arm64` |
| `x86` | `android-x86` |
| `x86_64` | `android-x64` |

`x86_64` が対応するのは `android-x86_64` ではなく `android-x64` であること、そして `android-x86` は 32 ビットのほうであることに注意してください。この 2 つを取り違えると、ビルドは成功するのに手元のどの端末にもインストールできない APK ができあがります。

## ADB0020 のページは、もう効かないプロパティを勧めてくる

公式の ADB0020 のページに従うと、2 つ目のエラーに突き当たります。そこではこう提案されています。

```xml
<AndroidSupportedAbis>armeabi-v7a;x86;x86_64;arm64-v8a</AndroidSupportedAbis>
```

この助言は .NET 6 より前のものです。最近のプロジェクトに追加すると、ビルドがそう教えてくれます。

```text
warning XA0036: The 'AndroidSupportedAbis' MSBuild property is no longer supported. Edit the project
file in a text editor, remove any uses of 'AndroidSupportedAbis', and use the 'RuntimeIdentifiers'
MSBuild property instead.
```

XA0036 はエラーではなく警告なので、ビルドは成功し、プロパティは無視され、APK には相変わらず 2 つの ABI しか入りません。Xamarin.Forms から移行したプロジェクトを引き継いだ場合は、`RuntimeIdentifiers` が効いていないと結論づける前に、`Directory.Build.props` やビルドサーバーの引数に `AndroidSupportedAbis` が残っていないか確認してください。

## .NET 11 でまた答えが変わる

`net11.0-android` のプロジェクトに 4 つの RID のスニペットを貼らないでください。[.NET 11 Preview 4 で MAUI は Android、iOS、Mac Catalyst において CoreCLR に移行しました](/ja/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/)が、CoreCLR は Mono が対応していたすべてのアーキテクチャを引き継いだわけではありません。Android x86 はなくなり、これを要求すると黙って無視されるのではなくビルドが失敗します。

```text
error NETSDK1082: There was no runtime pack for Microsoft.Android.Runtime available for the specified
RuntimeIdentifier 'android-x86'.
```

32 ビット ARM はもっと待つことになりました。CoreCLR が既定になった時点では検討中とされていて、対応が入ったのは Preview 7 です。[Preview 6 がモバイル向けの Mono の経路を完全に削除した](/ja/2026/07/maui-coreclr-only-runtime-in-dotnet-11-preview-6/)ため、`$(UseMonoRuntime)` という逃げ道もありません。.NET 11 のプロジェクトで動く組み合わせは次のとおりです。

```xml
<PropertyGroup Condition="'$(TargetFramework)' == 'net11.0-android'">
  <RuntimeIdentifiers>android-arm;android-arm64;android-x64</RuntimeIdentifiers>
</PropertyGroup>
```

Preview 6 以前の SDK を使っている場合は `android-arm` も外し、更新できるまで 64 ビットのみで我慢してください。.NET 11 の GA は 2026 年 11 月です。

エミュレーターにとっての実務上の帰結はこうです。32 ビット x86 のシステムイメージで .NET 11 の MAUI アプリが動くことは決してありません。CI がまだそれを起動しているなら、`x86_64` に、Apple Silicon のランナーなら `arm64-v8a` に移してください。

## 開発ループを速く保つ

1 台の端末でデバッグするために 4 つの ABI をビルドするのは時間の無駄です。単数形の `$(RuntimeIdentifier)` は複数形より優先され、ちょうど 1 つだけをビルドします。

```bash
dotnet build -f net11.0-android -t:Run -p:RuntimeIdentifier=android-arm64
```

これを Debug 構成に結びつけ、完全な組み合わせは Release 用に残します。

```xml
<PropertyGroup Condition="'$(Configuration)' == 'Debug' and $(TargetFramework.Contains('-android'))">
  <RuntimeIdentifier>android-arm64</RuntimeIdentifier>
</PropertyGroup>
```

複数形のプロパティをコマンドラインで渡すときの注意が 1 つあります。MSBuild は `-p:` の値をセミコロンで分割するため、`-p:RuntimeIdentifiers=android-arm64;android-x64` は 2 つの RID ではなく、シェルか MSBuild の構文エラーになります。区切り文字を `%3B` としてエスケープしてください。

```bash
dotnet publish -f net11.0-android -c Release -p:RuntimeIdentifiers=android-arm64%3Bandroid-x64
```

## Google Play が実際に要求していること

Play は 2019 年 8 月から、32 ビットバイナリを含める場合はそれと並べて 64 ビットバイナリを置くことを要求しています。32 ビットのほうを要求したことは一度もありません。つまり .NET 9 の既定値は要件を満たしており、`android-arm` を戻すのはリーチに関する判断であって、コンプライアンス上の修正ではありません。

APK のサイズを費やす前に、実際の数字を確認してください。Play Console のリリースの端末カタログには、そのバンドルが到達できる対応端末数が表示されます。ABI が 2 つのビルドと 3 つのビルドの差は、あなたの市場で今も使われている `armeabi-v7a` のみの端末の数です。2026 年時点で多くのアプリにとってこの数字は無視できるほど小さく、端末の買い替えサイクルが長い地域に配信するアプリにとってはそうではありません。

App Bundle で配信するなら、Play はいずれにせよ ABI ごとに分割するので、各ユーザーがダウンロードするのは 1 つのアーキテクチャだけです。ABI を増やして増えるのはビルド時間とアップロードサイズであって、インストールサイズではありません。

## 関連記事

- ネイティブライブラリは、[Google Play が 16 KB メモリページサイズ非対応を理由に Flutter や .NET MAUI のアプリを却下する](/ja/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/)理由でもあります。このチェックは、上で一覧表示したのと同じ `lib/<abi>/` のエントリーに対して実行されます。
- .NET 11 のアーキテクチャ変更の背景にあるランタイムの切り替えは、[MAUI が Android、iOS、Mac Catalyst で既定で CoreCLR に切り替わる](/ja/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/)で扱っています。
- 残存した `AndroidSupportedAbis` は、たいてい[Xamarin.Forms から MAUI 11 への移行](/ja/2026/05/migrate-from-xamarin-forms-to-maui-11/)で扱っている他のレガシーなビルドプロパティと一緒に紛れ込んできます。
- インストールできるパッケージが生成される前にビルドが失敗する場合は、[Gradle build failed to produce an APK file in MAUI Android](/ja/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/) から始めてください。

## 参考資料

- [.NET for Android エラー ADB0020](https://learn.microsoft.com/ja-jp/dotnet/android/messages/adb0020)、`INSTALL_FAILED_NO_MATCHING_ABIS` とビルドエラーの対応について。
- [.NET for Android 警告 XA0036](https://learn.microsoft.com/ja-jp/dotnet/android/messages/xa0036)、`AndroidSupportedAbis` の非推奨の文言について。
- [Xamarin.Android プロジェクトの移行](https://learn.microsoft.com/ja-jp/dotnet/maui/migration/android-projects)、ABI から `RuntimeIdentifiers` への置き換えを記載しています。
- [.NET RID カタログ](https://learn.microsoft.com/ja-jp/dotnet/core/rid-catalog)、Android の runtime identifier 名について。
- [CoreCLR progress and the Mono timeline for .NET MAUI](https://devblogs.microsoft.com/dotnet/coreclr-progress-and-mono-timeline-dotnet-maui/)、Preview 6 での Mono 経路の削除と arm32 の状況について。
- [dotnet/maui#27697](https://github.com/dotnet/maui/issues/27697)、.NET 9 の既定値変更を Play ストアの互換性リグレッションとして表面化させた報告。
- [64 ビットアーキテクチャのサポート](https://developer.android.com/google-play/64-bit)、Google Play のデベロッパー向けドキュメント。
