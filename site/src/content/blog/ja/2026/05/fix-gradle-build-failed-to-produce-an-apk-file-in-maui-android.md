---
title: "修正: MAUI Android で Gradle ビルドが .apk ファイルを生成できなかった"
description: "10 回のうち 9 回、本当の Gradle エラーは MSBuild ログのもっと上に埋もれています。JDK 17 のパス、maui-android ワークロードの欠落、Windows のロングパスが典型的な根本原因です。"
pubDate: 2026-05-15
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "maui"
  - "maui-11"
  - "android"
  - "gradle"
lang: "ja"
translationOf: "2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android"
translatedBy: "claude"
translationDate: 2026-05-15
---

修正方法: この MSBuild エラーは、ほとんどの場合、本当のエラーではありません。ビルドログをこの行よりも上にスクロールし、`gradlew.bat` または `aapt2` からの最初の `error` 行に到達してください。10 回のうち 9 回、本当の原因は次の 3 つのうちのいずれかです: `JAVA_HOME` が JDK 11 を指している (MAUI 11 の Android Gradle Plugin 8.x は JDK 17 が必要)、.NET SDK のアップグレード後に `android` または `maui-android` ワークロードがリストアされていない、または Windows のロングパス違反で R8 の難読化された出力が切り詰められた。根本的なエラーを修正すれば、次のビルドで `.apk` が生成されます。

```text
C:\Program Files\dotnet\sdk\11.0.100\Sdks\Microsoft.NET.Sdk\targets\Microsoft.NET.RuntimeIdentifierInference.targets(311,5):
error XA1029: The Gradle build failed to produce an .apk file. Please check the diagnostic log.
```

このガイドは .NET 11 GA、`net11.0-android` ターゲットフレームワーク、.NET MAUI 11.0.0、および `Xamarin.Android.Sdk` 35.x (Microsoft が .NET 11 の `dotnet workload install android` で固定しているバージョン) に同梱される Android Gradle Plugin (AGP) を対象に書かれています。`XA1029` コードは、`gradlew assembleDebug` または `assembleRelease` がゼロ以外で終了した後に `Xamarin.Android.Build.Tasks` から発生します。"failed to produce an .apk file" というテキストはラッパーであり、原因ではありません。

## なぜ MAUI Android が本当の Gradle エラーをラップするのか

MAUI は通常の `dotnet build` 中に Gradle を直接呼び出しません。Android 固有の MSBuild ターゲット (`_CompileToDalvikWithD8`、`_GenerateAndroidPackage`) は生成された `build.gradle.kts` を `obj/Debug/net11.0-android/<rid>/android/` に書き込み、その後同梱の `gradlew.bat` (Windows) または `gradlew` (macOS、Linux) を呼び出します。`gradlew` がゼロ以外で終了すると、MSBuild タスクは数千行の Gradle ログを `obj/Debug/net11.0-android/<rid>/android/build.log` の単一の診断ファイルに飲み込み、`XA1029` を発行します。Visual Studio が表示するのはラッパーだけです。本当のスタックトレース、欠落している依存関係、JDK の拒否、または署名の失敗は `build.log` と、MSBuild 出力パネルの `XA1029` の直上の行にあります。

`XA1029` を HTTP 500 のように扱ってください: ビルドが壊れたことは伝えますが、何が壊れたかは伝えません。最初の動きは常に、失敗した実際の `> Task :` 行を見つけることです。

## 本当の原因を見つけるために診断ログを読む

プロジェクトディレクトリのターミナルから、すべての Gradle 行を表示する詳細レベルでビルドを再実行します:

```bash
# .NET 11 SDK, MAUI 11.0.0
dotnet build -t:Run -f net11.0-android \
  -p:AndroidPackageFormat=apk \
  -bl:msbuild.binlog \
  -v:diag
```

次に [MSBuild Structured Log Viewer](https://msbuildlog.com/) で `msbuild.binlog` を開き、`FAILURE: Build failed` を検索します。その上の行が失敗した Gradle タスクの名前を示します: `:app:processDebugResources`、`:app:mergeDebugResources`、`:app:lintVitalReportRelease`、または `:app:compileDebugJavaWithJavac` が一般的な容疑者です。それぞれが下記の特定の修正カテゴリーを指しています。

binlog が Gradle フェーズで空であれば、Gradle が一度も起動していないことを意味し、それはつまり、いずれかのタスクが実行される前に `JAVA_HOME` の解決またはワークロードのリストアが失敗したことを意味します。JDK とワークロードのセクションに飛んでください。

## 原因 1: JAVA_HOME が誤った JDK を指している

これは .NET SDK のアップグレード後に圧倒的に多い原因です。Xamarin.Android 35 (.NET 11 のデフォルト) と一緒に出荷される AGP 8.x は、JDK 11 では起動を拒否し、`build.log` の中に次のエラーを出します:

```text
> Task :app:checkKotlinGradlePluginConfigurationErrors
A problem occurred starting Gradle worker
> Could not resolve the Java toolchain '11'.
> Android Gradle plugin requires Java 17 to run. You are currently using Java 11.
```

対応する MSBuild の表面は `XA1029` です。Microsoft は MAUI の JDK の下限を、.NET 6 から .NET 8 の時代は Java 11、MAUI 9 以降は Java 17 として、上流の AGP の要件に追従して文書化しました。元の破壊については、長く続いている MAUI の issue [dotnet/maui#18906](https://github.com/dotnet/maui/issues/18906) を参照してください。

修正は `JAVA_HOME` を JDK 17 のインストールに向けることです。Visual Studio 2026 の Windows マシンでは、同梱の OpenJDK 17 は `C:\Program Files\Microsoft\jdk-17.0.x-hotspot` にあります。永続的に設定します:

```powershell
# PowerShell, as the same user that runs dotnet build
[Environment]::SetEnvironmentVariable(
  "JAVA_HOME",
  "C:\Program Files\Microsoft\jdk-17.0.12.7-hotspot",
  "User")
```

その後、シェルを再起動するか、CI では継承された環境に頼らずに MSBuild が拾うように `dotnet build` のコマンドラインに `-p:JavaSdkDirectory=...` も渡します:

```bash
dotnet build -f net11.0-android \
  -p:JavaSdkDirectory="/usr/lib/jvm/temurin-17-jdk-amd64"
```

binlog で `JdkDirectory` を grep するか、`dotnet build -t:_ResolveAndroidTooling -v:diag | findstr Jdk` を実行することで、MSBuild が実際にどの JDK を選択したかを確認できます。

## 原因 2: maui-android または android ワークロードの欠落

2 番目に多い原因: マシンで .NET SDK をアップグレードした (または CI で新規インストールした) のに、ワークロードをリストアしていない。Gradle 統合を所有する `Xamarin.Android.Sdk` パックがディスク上にないため、MSBuild タスクは `_GenerateAndroidPackage` で失敗します。ラッパーは依然として `XA1029` です。`build.log` の中の本当のエラーは:

```text
> Task :app:processDebugResources FAILED
The 'aapt2' executable was not found at ...\Xamarin.Android.Sdk.x.x.x\tools\aapt2.exe
```

インストールされている SDK バンドに固定されたワークロードをリストアします:

```bash
# .NET 11 GA -- installs both the android pack and maui-android
dotnet workload install maui-android
dotnet workload restore
```

`dotnet workload restore` は現在のディレクトリのすべての `*.csproj` を歩き、その `TargetFrameworks` を読み、各ターゲットフレームワークが必要とするパックをインストールします。CI ではこれが冪等でバージョン固定されているため、実行する価値があるのはこのコマンドだけです。スタンドアロンの `dotnet workload install maui-android` は新しい開発マシンでの正しい呼び出しです。Microsoft はワークロードの分割を [Install workloads with dotnet workload install](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-workload-install) に文書化しています。

Visual Studio 2026 のインストーラーで MAUI をインストールし、その後 CLI から `dotnet workload install maui` も実行した場合、Visual Studio がどちらのコピーも見つけられない状態に陥ることがあります。MAUI のトラブルシューティングのドキュメントは [完全なアンインストールと再インストールの手順](https://learn.microsoft.com/en-us/dotnet/maui/troubleshooting) を綴っています。これは見た目以上に作業ですが、ワークロードが分裂した状態からの唯一の信頼できる回復方法です。

## 原因 3: obj 出力での Windows ロングパス違反

3 番目によく見られる原因は、純粋に Windows 固有のものです。R8 と `aapt2` はどちらも `obj\Debug\net11.0-android\android\app\build\intermediates\` 以下に深くネストされた難読化されたパスを書きます。`C:\src\MyCompany\MyProduct\Mobile\MyProduct.Mobile.csproj` にあるプロジェクトでは、中間 `.dex` ファイルの完全なパスは日常的にレガシーの `MAX_PATH` 260 文字制限を超えます。Gradle worker はこれを次のように報告します:

```text
> Task :app:mergeExtDexDebug FAILED
java.io.IOException: Cannot delete '...\transforms\...\classes.dex' (path too long)
```

優先順に 2 つの修正:

1. リポジトリをより短いルートに移動: `C:\Users\you\source\repos\MyCompany\Mobile\` の代わりに `C:\src\Mobile\`。
2. OS、.NET SDK、Git にまたがってロングパスのサポートを有効にします。管理者 PowerShell として:

   ```powershell
   New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" `
     -Name "LongPathsEnabled" -Value 1 -PropertyType DWORD -Force
   git config --system core.longpaths true
   ```

   その後 `<UseAppHost>false</UseAppHost>` を追加するのはここでの修正ではありません。実際に必要なのはマニフェストのエントリです。`.csproj` を編集して `<EnableLongPaths>true</EnableLongPaths>` (Xamarin.Android 35+) を設定し、プロジェクトの `app.manifest` が `longPathAware` を宣言していることを確認します。Android 側のビルドは、サインアウトしてサインインし直すと OS フラグを拾います。

最初のオプションのほうが速く、管理者権限なしでどのマシンでも動作します。リポジトリのパスがポリシーで固定されていない限り、これを取ってください。

## 原因 4: lintVitalRelease が Release ビルドのみで失敗する

`dotnet build -c Debug` が成功し、`dotnet publish -c Release -f net11.0-android` が `XA1029` で失敗する場合、死んだ Gradle タスクは `:app:lintVitalReportRelease` です。AGP 8 は Release 構成での lint 失敗を警告からビルドエラーに昇格させました。`build.log` で次のように表示されます:

```text
> Task :app:lintVitalReportRelease FAILED
Lint found errors in the project; aborting build.
```

正しい修正は `obj/Release/net11.0-android/android/app/build/reports/lint-results-release.html` で lint レポートを読み、実際の問題 (欠落した翻訳、`<application>` ラベルのハードコードされた文字列、`compileSdkVersion 35` をターゲットにする廃止された Android API) に対処することです。

誤ってはいるが魅力的な修正は lint を抑制することです:

```xml
<!-- .csproj, .NET 11, MAUI 11 -- escape hatch only -->
<PropertyGroup Condition="'$(Configuration)' == 'Release'">
  <AndroidLintAbortOnError>false</AndroidLintAbortOnError>
</PropertyGroup>
```

これは今日リリースしなければならないバージョンの戦術的な解除としてのみ使用してください。`android:exported` 宣言の欠落に関する lint の発見は、Android 31+ での実際のバグであり、最終的には起動時にクラッシュします。

## 原因 5: 署名済み Release ビルドのキーストアの欠落または誤り

署名済み Release ビルドは、タスクリストに `:app:signReleaseBundle` を追加します。キーストアのパスが何にも解決されない場合、AGP は次のように失敗します:

```text
> Task :app:signReleaseBundle FAILED
Keystore file '/Users/runner/work/_temp/myapp.keystore' not found for signing config 'release'.
```

開発者マシンでは、これは `<AndroidSigningKeyStore>` MSBuild プロパティが現在のユーザーには存在しないファイルを指していることを意味します。CI では通常、base64 エンコードされたキーストアを含むシークレットが、`csproj` が参照するパスにデコードされていないことを意味します。最小限の正しい CI の呼び出し:

```bash
# .NET 11, MAUI 11 -- GitHub Actions
echo "$ANDROID_KEYSTORE_BASE64" | base64 --decode > $RUNNER_TEMP/release.keystore
dotnet publish src/MyApp/MyApp.csproj \
  -f net11.0-android \
  -c Release \
  -p:AndroidPackageFormat=apk \
  -p:AndroidKeyStore=true \
  -p:AndroidSigningKeyStore=$RUNNER_TEMP/release.keystore \
  -p:AndroidSigningStorePass=$ANDROID_KEYSTORE_PASS \
  -p:AndroidSigningKeyAlias=$ANDROID_KEY_ALIAS \
  -p:AndroidSigningKeyPass=$ANDROID_KEY_PASS
```

4 つの `AndroidSigning*` プロパティはまとめて必須です。3 つだけ設定すると、同じ `XA1029` と異なる Gradle タスク行で失敗します。Microsoft はプロパティ名を [Publish a .NET MAUI app for Android](https://learn.microsoft.com/en-us/dotnet/maui/android/deployment/publish-cli) に文書化しています。

## 原因 6: 破損した Gradle デーモンまたは古い .gradle キャッシュ

長い失敗ビルドの連続の後、`~/.gradle/caches/` のユーザースコープの Gradle キャッシュは、その後のすべてのビルドが汎用的な `XA1029` と lock ファイルについて文句を言う `build.log` で失敗する状態に陥ることがあります。キャッシュとワークロードスコープの Gradle ディストリビューションを吹き飛ばしてください:

```bash
# kills the daemon, deletes the cache, deletes the user gradle wrapper distribution
gradle --stop 2>/dev/null
rm -rf ~/.gradle/caches/ ~/.gradle/daemon/
rm -rf ~/.gradle/wrapper/dists/
```

Windows での同等のコマンドは `Remove-Item -Recurse -Force "$env:USERPROFILE\.gradle\caches"` です。次のビルドは AGP ディストリビューション (約 200 MB) を再ダウンロードし、依存関係グラフを再水和します。最初は 5 ～ 10 分かかり、その後は速くなります。

これは「昨日は動いていて何も変えていない」に対する正しい修正です。何が変わったか (ワークロードのアップグレード、JDK の交換、新しい NuGet パッケージ) を名指しできるときには、誤った修正です。先に原因を追跡してください。

## 落とし穴とよく似たエラー

- `XA0119: Could not find android.jar for API level 35` は同じステージの兄弟エラーです。それは常に `android-sdk;platforms;android-35` のインストールの欠落であり、Gradle の問題ではありません。`androidsdkmanager --install platforms;android-35` を実行してください。
- `error : Java.Interop.Tools.Diagnostics.XamarinAndroidException: Output directory does not exist` も `Xamarin.Android.Build.Tasks` 由来ですが、パイプラインのもっと早い段階です。通常は Defender がファイルを隔離したため `obj/` が読み取り専用であることを意味します。`Get-Acl obj` と Defender の隔離ログを確認してください。
- リンカーフェーズからの `MSB6006: "java.exe" exited with code 1` は名前が誤解を招きます: 追跡できないクラスで失敗している `R8` minification です。ProGuard ルールを追加して再試行してください。基礎となるメカニズムについては [cold-start チューニングに関する最近の投稿](/ja/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) の内訳を参照してください。同じ trim/AOT の契約が Android にも適用されます。
- `bin/` に `.apk` がない "Build SUCCESS" は、親の `Directory.Build.props` で `<AndroidPackageFormat>aab</AndroidPackageFormat>` が設定されている場合に発生します。代わりにビルドは `.aab` (App Bundle) を生成し、これが Play Store が実際に欲しいものです。`XA1029` のテキストが ".apk" と言うのは、それが歴史的なデフォルトだからにすぎません。基礎となるチェックは「パッケージステップが期待される出力ファイルを書いたか」です。

## 関連

- [MAUI アプリを Microsoft Store 用にパッケージ化する方法](/ja/2026/05/how-to-package-a-maui-app-for-the-microsoft-store/) は、同じ発行パイプラインの Windows 側を歩きます。
- [.NET 11 preview 4: dotnet watch がついに MAUI Android と iOS に着地](/ja/2026/05/dotnet-watch-maui-android-ios-net-11-preview-4/) は、同じ Gradle ハーネスの上で実行されるインナーループのツールをカバーしています。
- [.NET 11 preview 4 の MAUI が Android と iOS で CoreCLR をデフォルトに](/ja/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/) は、ランタイムの交換が Release ビルドの一部の lint ルールを警告からエラーに移した理由を説明しています。
- [高性能な Xamarin.Forms ListView を MAUI CollectionView に移行する方法](/ja/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/) は、Xamarin で問題なくビルドできていたプロジェクトが MAUI への移植後に `XA1029` に当たり始める最も一般的な理由です。

## 参考資料

- [Troubleshoot known issues in .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/troubleshooting)、Microsoft Learn、.NET MAUI 11。
- [dotnet/maui#18906: GitHub Actions no longer builds MAUI Android: Java SDK 11.0 or above is required](https://github.com/dotnet/maui/issues/18906)、JDK 要件の引き上げを追跡する正典的な issue。
- [dotnet/maui Discussion #24164: Cannot build apk in Release](https://github.com/dotnet/maui/discussions/24164)、Release 専用の `XA1029` の原因を列挙するコミュニティスレッド。
- [Publish a .NET MAUI app for Android with the CLI](https://learn.microsoft.com/en-us/dotnet/maui/android/deployment/publish-cli)、`AndroidSigning*` MSBuild プロパティの真実の源。
- [Java versions in Android builds](https://developer.android.com/build/jdks)、AGP バージョン別の JDK 下限に関する Android チームのドキュメント。
- [Install workloads with dotnet workload install](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-workload-install)、上で参照されたワークロードのインストール / リストアの意味論。
