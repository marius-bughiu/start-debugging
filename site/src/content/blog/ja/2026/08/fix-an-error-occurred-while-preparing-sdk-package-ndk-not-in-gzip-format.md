---
title: "解決: An error occurred while preparing SDK package NDK (Side by side): Not in GZIP format"
description: "SDK Manager が .downloadIntermediates にキャッシュした壊れたアーカイブを展開し直しています。そのフォルダーと展開途中の ndk/<version> ディレクトリを削除して、ビルドし直してください。"
pubDate: 2026-08-14
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "ndk"
lang: "ja"
translationOf: "2026/08/fix-an-error-occurred-while-preparing-sdk-package-ndk-not-in-gzip-format"
translatedBy: "claude"
translationDate: 2026-08-14
---

SDK Manager のダウンロードキャッシュと、展開途中の NDK ディレクトリを削除してから、もう一度ビルドしてください。展開しようとしているアーカイブが壊れており、しかもそのアーカイブがキャッシュされるため、削除するまで再試行のたびに同じように失敗します。Windows では `%LOCALAPPDATA%\Android\Sdk\.downloadIntermediates` と `%LOCALAPPDATA%\Android\Sdk\ndk\28.2.13676358` です。キャッシュを消しても再び失敗する場合は、750 MB のダウンロードを書き換えるプロキシか TLS 検査型のウイルス対策ソフトの背後にいるので、答えは `dl.google.com` から NDK を手動でインストールすることです。

## エラーの全文

このメッセージはビルドの途中、通常は Gradle の構成フェーズで現れ、最上位の失敗ではなく警告行として出ます。

```
Preparing "Install NDK (Side by side) 28.2.13676358 v.28.2.13676358".
Warning: An error occurred while preparing SDK package NDK (Side by side) 28.2.13676358: Not in GZIP format.

FAILURE: Build failed with an exception.
```

その下にあるのは `GZIPInputStream` から投げられた `java.util.zip.ZipException: Not in GZIP format` で、バージョン番号はプロジェクトが固定している値によって変わります。この特定の失敗を見分ける手がかりは 2 つあります。パッケージ名が `NDK (Side by side)` であること、そして再起動後も、`flutter clean` の後も、Android Studio の再起動後も、毎回バイト単位で同じ結果になることです。本当に不安定なネットワークなら毎回違うエラーが出ます。これは違います。

## Flutter のビルドが NDK をダウンロードするのはなぜですか?

ここが多くの人のつまずくところです。ネイティブコードも C++ も `externalNativeBuild` ブロックもない Flutter アプリでも、初回ビルドで 750 MB の NDK をダウンロードします。これは意図的な動作で、Android Gradle Plugin ではなく Flutter 側の仕業です。

AGP はネイティブライブラリからデバッグシンボルを取り除くために NDK を必要としますが、ネイティブコードをコンパイルしていると判断したときにしか NDK をダウンロードしません。Flutter は常にネイティブライブラリ (エンジンと AOT コンパイルされた Dart) を同梱するのでシンボル除去が必要になり、そのため AGP を騙して toolchain を取得させます。ローカルの Flutter 3.44.2 stable インストールで確認したところ、`FlutterPlugin.kt` は 228 行目でこれを無条件に呼び出しています。

```kotlin
// Flutter 3.44.2, packages/flutter_tools/gradle/src/main/kotlin/FlutterPluginUtils.kt
internal fun forceNdkDownload(gradleProject: Project, flutterSdkRootPath: String) {
    val gradleProjectAndroidExtension = getLegacyAndroidExtension(gradleProject)
    val forcingNotRequired: Boolean =
        gradleProjectAndroidExtension.externalNativeBuild.cmake.path != null
    if (forcingNotRequired) {
        return
    }

    // Otherwise, point to an empty CMakeLists.txt, and ignore associated warnings.
    gradleProjectAndroidExtension.externalNativeBuild.cmake.path(
        "$flutterSdkRootPath/packages/flutter_tools/gradle/src/main/scripts/CMakeLists.txt"
    )
    // ...
}
```

参照先の `CMakeLists.txt` は空のファイルで、その唯一の目的はビルドすべきネイティブコードがあると AGP に信じ込ませることです。つまり NDK のダウンロードは任意ではなく、スキップもできず、新しいマシンや新しい CI ランナーは必ずこれに遭遇します。1 つの環境につき一度だけ走る 4 分の 3 ギガバイトのダウンロードは、まさに切り詰められたアーカイブを生みやすい条件です。

取得されるバージョンを決めているのは Flutter であり、あなたではありません。同じインストールの `packages/flutter_tools/lib/src/android/gradle_utils.dart` 68 行目です。

```dart
// Flutter 3.44.2, packages/flutter_tools/lib/src/android/gradle_utils.dart
const ndkVersion = '28.2.13676358';
```

これは NDK r28c です。このマシンにインストール済みのものを確認したところ、`ndk/28.2.13676358/source.properties` に `Pkg.ReleaseName = r28c` とあったので、リビジョンとリリースの対応は推測ではありません。

## アーカイブが GZIP チェックに失敗するのはなぜですか?

実際の原因になる頻度の高い順に並べます。

**`.downloadIntermediates` にキャッシュされた壊れたアーカイブ。** SDK Manager はパッケージのダウンロードを展開前に `<sdk>/.downloadIntermediates` に置きます。接続が切れた、ディスクがいっぱいになった、途中でプロセスが停止した、といった場合、切り詰められたファイルがそのディレクトリに残ります。ダウンローダーはキャッシュされたファイルを再開可能なダウンロードとして扱い、次の試行でそのまま展開処理に渡すので、再試行しても同じ例外が延々と再現します。報告の大多数はこのケースであり、「もう 5 回試した」が反証にならないのはそのためです。

**レスポンスを書き換えるプロキシまたは TLS 検査型ウイルス対策ソフト。** `GZIPInputStream` は先頭 2 バイトが gzip のマジックナンバー `1f 8b` でないとき、まさにこの文字列を投げます。HTML のブロックページを返す企業プロキシ、リクエストを横取りする captive portal、実際には圧縮していない本文に `Content-Encoding: gzip` を付けるスキャナー、いずれも 1 バイト目でマジックナンバー検査に失敗するストリームを作ります。見分け方は、キャッシュを消しても効かないことです。新しく、しかし同じように無効なダウンロードが得られます。

**ディスクの空き不足。** 750 MB のダウンロードに加えて 4 GB の展開には余裕が必要ですが、SDK Manager は事前にそれを確認しません。書ける分だけ書き、切り詰められた結果が同じように失敗します。

## ダウンロードキャッシュと展開途中の NDK はどう消しますか?

先に Android Studio を終了してください。Windows ではこれらのディレクトリのハンドルを保持しています。SDK のルートは Windows では `%LOCALAPPDATA%\Android\Sdk`、macOS では `~/Library/Android/sdk`、Linux では `~/Android/Sdk` です。

```bash
# macOS / Linux. Adjust SDK for your platform.
SDK="$HOME/Library/Android/sdk"
rm -rf "$SDK/.downloadIntermediates" "$SDK/.temp" "$SDK/temp" "$SDK/downloadIntermediates"
rm -rf "$SDK/ndk/28.2.13676358"
```

```powershell
# Windows PowerShell
$sdk = "$env:LOCALAPPDATA\Android\Sdk"
Remove-Item -Recurse -Force "$sdk\.downloadIntermediates","$sdk\.temp","$sdk\temp","$sdk\downloadIntermediates" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$sdk\ndk\28.2.13676358" -ErrorAction SilentlyContinue
```

先頭のドットがある綴りとない綴りは Android Studio のバージョンによって両方現れるので、存在するものを削除し、ないものは無視してください。この記事のために調べたインストールでは、SDK に含まれるのはドット付きの `.temp` でした。

`ndk/<version>` ディレクトリの削除はキャッシュの削除と同じくらい重要で、しかもほとんどの解説が飛ばす手順です。理由は次のセクションで説明します。

## 次のビルドが CXX1101 で失敗する場合はどうしますか?

これは、失敗した展開が不完全なディレクトリを残し、今度は別のコードパスがそれを見つけるために起こります。

```
> [CXX1101] NDK at /Users/you/Library/Android/sdk/ndk/28.2.13676358
  did not have a source.properties file
```

AGP はインストール済みの NDK を `ndk/<revision>/` 内の `source.properties` を読んで解決します。SDK Manager はこのファイルをアーカイブの展開が完全に終わった後、最後に書き込みます。中途半端なインストールを正常なものと取り違えないためです。展開が gzip エラーで停止すると、toolchain のファイルで満たされていて `source.properties` がないディレクトリが残ります。存在しないわけでも有効でもない状態です。

そこから先、SDK Manager は期待されたパスにディレクトリがあると判断して再ダウンロードせず、AGP は `source.properties` が見えないので使用を拒否します。ビルドは、パッケージが存在するかどうかで意見の食い違う 2 つのコンポーネントの間で立ち往生し、エラーメッセージは一見無関係なものに変わります。この話題のスレッドの多くが、`local.properties` に `ndk.dir` を設定したり古い NDK バージョンを固定したりして終わるのはそのためです。最初の問題を一度も片付けないまま、2 番目のエラーを回避しているのです。ディレクトリを削除すれば、両方まとめて消えます。

参考までに、正しくインストールされたコピーには両方のファイルが含まれます。

```
ndk/28.2.13676358/source.properties   # Pkg.Revision = 28.2.13676358, Pkg.ReleaseName = r28c
ndk/28.2.13676358/package.xml         # written by the SDK Manager, not present in the standalone zip
```

## コマンドラインから NDK をインストールするには?

Gradle と Android Studio を経路から外すと失敗がはるかに読みやすくなり、`sdkmanager` は 1 行の警告ではなく元のスタックトレースを出力します。バイナリは `<sdk>/cmdline-tools/latest/bin` にあります。そこになければ、[Android SDK Command-line Tools のインストール](/ja/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/)が前提条件になります。

```bash
# Android SDK Command-line Tools 19.0, NDK r28c
cd "$HOME/Library/Android/sdk/cmdline-tools/latest/bin"
./sdkmanager --install "ndk;28.2.13676358" --verbose
```

プロキシの背後にいる場合は、`sdkmanager` が読まない Studio の設定に頼らず、明示的に渡してください。

```bash
./sdkmanager --install "ndk;28.2.13676358" \
  --proxy=http --proxy_host=proxy.corp.example --proxy_port=8080
```

解決策として `--no_https` に手を出さないでください。転送を平文の HTTP に格下げするので、傍受するプロキシが本文を壊す可能性はむしろ高まります。このオプションは CONNECT を完全にブロックする環境のためのものです。

## ダウンローダーが失敗し続けるとき、NDK を手動でインストールするには?

これは閉じたネットワークにおける確実な避難経路です。ダウンロードを自分の管理下のツールに移し、バイト列を検証できるからです。

1. `https://dl.google.com/android/repository/android-ndk-r28c-linux.zip` から単体アーカイブをダウンロードします。Windows では `windows` に置き換えてください。macOS ではこの URL から zip ではなく `.dmg` が配布されるので、マウントして中身をコピーします。

2. 信用する前に、NDK ダウンロードページで公開されている値と SHA-1 を照合してください。r28c の Linux 版 zip は 722,261,334 バイトで SHA-1 は `a7b54a5de87fecd125a17d54f73c446199e72a64`、Windows 版 zip は 748,118,221 バイトで SHA-1 は `086bba43ff2f5eb0e387b15c8278bb4e0d89ba1d` です。ハッシュが合わなければプロキシが原因だと確定し、キャッシュをいくら消しても解決しません。

```bash
# Verify, then unpack. NDK r28c.
sha1sum android-ndk-r28c-linux.zip
unzip -q android-ndk-r28c-linux.zip
```

3. 展開された `android-ndk-r28c` ディレクトリをリビジョン番号にリネームして、SDK 内へ移動します。AGP が探すのはリリース名ではなくリビジョンです。

```bash
mv android-ndk-r28c "$HOME/Android/Sdk/ndk/28.2.13676358"
cat "$HOME/Android/Sdk/ndk/28.2.13676358/source.properties"
# Pkg.Revision = 28.2.13676358
```

4. ビルドします。AGP は `source.properties` を読み、toolchain を受け入れます。管理下のインストールとの唯一の違いは `package.xml` がないことで、そのため `sdkmanager --list_installed` はこのパッケージを報告しません。ビルド上は見た目の問題にすぎませんが、CI がディレクトリではなくパッケージ一覧をチェックしている場合は影響します。

## プロジェクトに本当に必要な NDK バージョンはどれですか?

プロジェクトが固定しているもので、既定では Flutter があなたの代わりに固定します。2026 年 8 月時点では次のとおりです。

| 役割 | NDK リリース | リビジョン文字列 |
| --- | --- | --- |
| Flutter 3.44 の既定 | r28c | `28.2.13676358` |
| 最新の安定版 | r29 | `29.0.14206865` |
| 最新の LTS | r27d | `27.3.13750724` |

たまたまマシンにキャッシュされている NDK へ下げることで、このエラーを「解決」しないでください。NDK r28 は、Google Play が現在必須としている 16 KB メモリページ向けにアラインされた共有ライブラリをビルドできる最初のリリースです。ダウンロードの問題を避けるために r27 へ下げるのは、ビルドの失敗を[ストアでの却下](/ja/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/)と引き換えにする行為です。

一方で、プラグインが Flutter の既定より新しい toolchain を要求する場合には、実際にバージョンを上げる必要があります。Flutter はそれを検出し、何を書けばよいかを正確に伝えます。

```
Your project is configured with Android NDK 28.2.13676358, but the following
plugin(s) depend on a different Android NDK version:
- some_plugin requires Android NDK 29.0.14206865
Fix this issue by using the highest Android NDK version (they are backward compatible).
```

```kotlin
// android/app/build.gradle.kts, AGP 8.x
android {
    ndkVersion = "29.0.14206865"
}
```

この文字列を変更すると別パッケージの新しいダウンロードが始まるので、大きな転送が壊れるネットワークにまだいるなら、固定値を変える前に新しいリビジョンを手動でインストールしてください。そうしないと、同じエラーがバージョン番号を変えて現れるだけです。

## 同じメッセージが別の理由で出るケース

**レイヤー容量に余裕のない Docker や CI のイメージ。** 展開の途中で書き込み領域を使い切ったビルドコンテナーは、切り詰められたダウンロードとまったく同じように失敗します。ネットワークを疑う前に SDK のボリュームの空き容量を確認してください。イメージに NDK を焼き込んでおくのが恒久的な対策で、各ジョブから 750 MB のダウンロードを取り除けます。

**1 つの SDK を奪い合う 2 つのビルド。** マウントされた SDK ディレクトリを共有する並列 CI ジョブは `.downloadIntermediates` への書き込みが交錯し、互いのアーカイブを壊します。各ジョブに固有の `ANDROID_SDK_ROOT` を与えるか、初回のインストールを直列化してください。

**`Failed to install the following Android SDK packages as some licences have not been accepted`。** 別のエラーですが、同じビルドフェーズで出ます。これはキャッシュの削除ではなく `sdkmanager --licenses` で解決します。

**一般的な `Gradle task assembleDebug failed with exit code 1`。** この行はラッパーにすぎず、gzip の警告はずっと上にスクロールしている場合があります。本当の原因が見えないなら、当て推量をせずに[まず詳細出力でビルドし直してください](/ja/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/)。

**プラグイン自身のダウンロード処理で起きる `.gz` の失敗。** 一部のプラグインは構成時に自前のビルド済みバイナリを取得します。失敗しているパッケージ名が `NDK (Side by side)` でなければ、この記事は該当しません。

## 関連記事

NDK のダウンロードが関わる前からビルドが不健全だった場合は、[Flutter の Android ビルドにおける AndroidX の競合](/ja/2026/05/fix-androidx-conflict-during-flutter-android-build/)と[プラグインに起因する minSdkVersion の不一致](/ja/2026/05/fix-flutter-background-fetch-requires-minsdkversion-21/)が、新しいマシンでの初回ビルド失敗の下に潜んでいることが最も多い 2 つです。ランナーごとにこのダウンロードのコストを払っているチームには、[1 つの CI パイプラインから複数の Flutter バージョンを対象にする方法](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)が、ジョブごとではなくイメージごとに一度で済むよう SDK を適切にキャッシュする手順を扱っています。

## 参考資料

- [NDK Downloads](https://developer.android.com/ndk/downloads)。r29、r28c、r27d のリビジョン文字列、アーカイブのサイズ、上で引用した SHA-1 チェックサムの出典です。
- [sdkmanager コマンドラインリファレンス](https://developer.android.com/studio/command-line/sdkmanager)。`--install`、`--sdk_root`、`--verbose`、および `--proxy`、`--proxy_host`、`--proxy_port` の 3 点セットの出典です。
- [NDK does not have Source properties file in my project](https://github.com/flutter/flutter/issues/164085) と [New, default Flutter Projects fail on build with NDK...did not have a source.properties file](https://github.com/flutter/flutter/issues/102831)。後続の CXX1101 の失敗と、キャッシュ削除の代わりに選ばれがちな回避策の出典です。
- [Android NDK version doesn't seem to be right for new projects](https://github.com/flutter/flutter/issues/163945)。Flutter の既定リビジョンがどう選ばれるか、プラグインがそれ以上を要求するのはどんなときかの出典です。
- ローカルの Flutter 3.44.2 stable インストールから引用したソース: `packages/flutter_tools/gradle/src/main/kotlin/FlutterPlugin.kt`、`FlutterPluginUtils.kt`、`FlutterExtension.kt`、`packages/flutter_tools/gradle/src/main/scripts/CMakeLists.txt`、`packages/flutter_tools/lib/src/android/gradle_utils.dart`。
- このマシンの Android SDK で確認した SDK 構成の詳細: `ndk/28.2.13676358/source.properties` (`Pkg.ReleaseName = r28c`)、`ndk/28.2.13676358/package.xml`、およびドット付きの `.temp` キャッシュディレクトリ。
