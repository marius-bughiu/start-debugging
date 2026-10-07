---
title: "修正: Flutter ビルドの Bad state: No suitable NDK found for target architecture arm64"
description: "android_libcpp_shared ビルドフック (0.2.0 以前) が NDK を見つけられないか、minSdk が NDK の最新 API より高いことが原因です。0.2.1 以降に更新するか、minSdk をカバーする NDK をインストールしてください。"
pubDate: 2026-10-07
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "ndk"
  - "native-assets"
lang: "ja"
translationOf: "2026/10/fix-no-suitable-ndk-found-for-target-architecture-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-07
---

このエラーは Gradle や Flutter が出しているものではありません。`android_libcpp_shared` パッケージ (バージョン 0.1.0 から 0.2.0) の Dart ビルドフックが投げています。`croppy` など一部の FFI パッケージが推移的にこのパッケージを取り込みます。原因は 2 つあります。1 つ目は、フック独自の NDK 検索が、Gradle が問題なく使っている NDK を見つけられないケースです。2 つ目は、見つかった NDK がすべて、アプリの `minSdk` より低い API レベルまでしか対応していないケースです。1 つ目の場合は、パッケージを 0.2.1 以降に更新します (推移的な依存なら `dependency_overrides` を使います)。2 つ目の場合は、sysroot が `minSdk` をカバーする NDK をインストールします。NDK r28c と r29 は API 35 までなので、`minSdk = 36` には r30 が必要です。

以下はすべて、macOS 上の Flutter 3.44.8 (Dart 3.12.2)、Flutter テンプレートの Gradle 9.1.0、OpenJDK 17、`/opt/homebrew/share/android-commandlinetools` にある Android SDK の NDK r28c (`28.2.13676358`) で再現しました。`android_libcpp_shared` 0.1.0 から 0.3.1 までのフックのソースは、pub.dev のアーカイブから直接読んでいます。

## エラーの全体像

新規作成したアプリに `android_libcpp_shared: 0.2.0` だけを追加し、他は何も変えずに `flutter build apk --debug --target-platform android-arm64` を実行したときの出力です (長い `--packages` のパスは省略しています)。

```text
Unhandled exception:
Bad state: No suitable NDK found for target architecture arm64.
#0      main.<anonymous closure> (file:///Users/marius/.pub-cache/hosted/pub.dev/android_libcpp_shared-0.2.0/hook/build.dart:31:7)
<asynchronous suspension>
#1      build (package:hooks/src/api/build_and_link.dart:250:5)
<asynchronous suspension>
#2      main (file:///Users/marius/.pub-cache/hosted/pub.dev/android_libcpp_shared-0.2.0/hook/build.dart:12:3)
<asynchronous suspension>

  Building assets for package:android_libcpp_shared failed.
  build.dart returned with exit code: 255.
  To reproduce run:
  (cd .../android_libcpp_shared-0.2.0/; .../dart-sdk/bin/dart --packages=.../package_config.json .../hooks_runner/android_libcpp_shared/cbb4418675/hook.dill --config=.../input.json )
  stdout:
  INFO: Searching for android NDK...

Target dart_build failed: Error: Building native assets failed. See the logs for more details.

FAILURE: Build failed with an exception.

* What went wrong:
Execution failed for task ':app:compileFlutterBuildDebug'.
```

末尾のアーキテクチャはターゲットによって `arm64`、`arm`、`x64` のいずれかになります。`--target-platform` なしのリリースビルドは 3 つすべてをビルドするため、フックランナーが最初に試した ABI が表示されます。

多くの人が混乱するのは次の点です。このマシンでは Gradle がすでに NDK `28.2.13676358` を解決していました。Flutter 自身の Gradle プラグインが、すべての Android ビルドでこの NDK のダウンロードを強制するためです。つまり NDK はインストール済みで、有効で、使われていました。フックが、その NDK のある場所を見に行かなかっただけです。

## ビルドフックがそもそも NDK を探す理由

最近の Flutter stable では、パッケージが `hook/build.dart` を同梱でき、`flutter build` の最中にネイティブコードのコンパイルやバンドルのために実行されます ("native assets" または "build hooks" 機能で、`package:hooks` と `package:code_assets` の上に作られています)。Flutter はこれらのフックを `dart_build` ターゲットで、Gradle が何かをコンパイルする前に実行し、各フックに JSON 設定を渡します。ここには対象 OS、アーキテクチャ、Flutter が見つけた C コンパイラー、`targetNdkApi` が含まれます。

`android_libcpp_shared` は `libc++_shared.so` をバンドルするためのパッケージです。これは、`-stl=c++_shared` でコンパイルされた FFI ライブラリが実行時に必要とする、共有 C++ ランタイムです。そのためディスク上の NDK を見つける必要があり、0.2.0 以前では Flutter が渡した NDK を信用せず、独自の検索を行っていました。この検索の中で空の結果を返しうる箇所が 2 つあり、どちらも同じ `StateError` に行き着きます。

### 原因 1: フックの検索場所が Gradle より狭い

0.2.0 の `NDKLocator.locate()` は、次の 4 つの情報源から候補を集めます。

1. `PATH` 上の `ndk-build`。ただし NDK ディレクトリそのものではなくその親を解決してしまうため、この情報源は一度も一致しませんでした (0.2.1 の changelog がこれを修正として挙げています)。
2. 環境変数 `ANDROID_NDK`、`ANDROID_NDK_HOME`、`ANDROID_NDK_LATEST_HOME`、`ANDROID_NDK_ROOT`。
3. OS ごとに固定されたグロブ。macOS は `$HOME/Library/Android/sdk/ndk/*/`、Linux は `$HOME/Android/Sdk/ndk/*/`、Windows は `$HOME/AppData/Local/Android/Sdk/ndk/*/` です。
4. `ANDROID_HOME`、`ANDROID_SDK_ROOT`、`ANDROID_SDK_HOME` の下にある `ndk/*/`。

読んでいないのは、Gradle が実際に SDK の場所を得ている `android/local.properties` の `sdk.dir`、そして `flutter config --android-sdk` で設定した `android-sdk` の値です。Flutter 自身はこの両方を尊重します。そのため、デフォルトの Android Studio の場所の外にある SDK で、`ANDROID_HOME` をエクスポートしていない場合は、フックから見えません。Homebrew の `android-commandlinetools`、Windows のカスタムドライブ、`local.properties` だけを書く CI イメージが該当します。Windows にはもう 1 つ罠があります。グロブは `$HOME` を `Platform.environment['HOME']!` で展開しますが、通常の `cmd.exe` セッションでは `HOME` が設定されていません。

### 原因 2: minSdk が、見つかったどの NDK の最新 API よりも高い

NDK が見つかっても、フックがそれを受け入れるのは、その sysroot にアプリの最小 SDK 以上の API レベルのディレクトリがある場合だけです。

```dart
// android_libcpp_shared 0.2.0, lib/src/locate_ndk.dart
NDKApiLevel? highestMatching(int minApiLevel) {
  final suitableApiLevels =
      _apiLevels.where((api) => api.level >= minApiLevel).toList()
        ..sort((a, b) => b.level.compareTo(a.level));
  return suitableApiLevels.isNotEmpty ? suitableApiLevels.first : null;
}
```

`minApiLevel` はフック設定の `targetNdkApi` で、Flutter はこれをアプリのマージ済み `minSdk` から埋めます。`FlutterPlugin.kt` が `variant.mergedFlavor.minSdkVersion` を読み、`flutter assemble` に `-dMinSdkVersion` として渡します。API ディレクトリは `toolchains/llvm/prebuilt/<host>/sysroot/usr/lib/aarch64-linux-android/` から得られます。現行の 3 つの NDK について一覧を確認しました。

| NDK | リビジョン | sysroot の API レベル |
|-----|----------|--------------------|
| r28c | `28.2.13676358` (Flutter 3.44 のデフォルト `ndkVersion`) | 21 から 35 |
| r29 | `29.0.14206865` | 21 から 35 |
| r30 | `30.0.16248370` | 21 から 37 |

したがって、Flutter のデフォルト NDK では `minSdk = 36` は、NDK の見つけ方に関係なく失敗します。このチェックは 0.2.1 や 0.3.x にも残っており、メッセージが改善されただけです。`libc++_shared.so` は 1 階層上の `sysroot/usr/lib/<triple>/` にあり、API ごとに分かれていないため、このチェックは少し奇妙です。しかしこれがパッケージの強制するルールなので、満たすしかありません。

## 最小再現手順

どちらの原因もテンプレートアプリで再現できます。原因 1 では、デフォルト以外の場所にある SDK と、未設定の `ANDROID_HOME` が必要です。原因 2 はどのマシンでも再現します。

```bash
# Flutter 3.44.8, android_libcpp_shared 0.2.0, NDK r28c
flutter create --platforms=android -e ndkapp
cd ndkapp
flutter pub add android_libcpp_shared:0.2.0
flutter build apk --debug --target-platform android-arm64
```

Gradle のフルビルドなしで、フックから見たマシンの状態を確認するには、使い捨てのコンソールパッケージからロケーターを直接呼び出します。2 つの原因の切り分けにはこれを使いました。

```dart
// Dart 3.12.2, android_libcpp_shared 0.2.0
// bin/repro.dart  -  dart run bin/repro.dart 36
import 'package:android_libcpp_shared/src/locate_ndk.dart';

Future<void> main(List<String> args) async {
  final minSdk = int.parse(args.first);
  final ndks = await NDKLocator.locate();
  print('NDKs found: ${ndks.length}');
  for (final ndk in ndks) {
    final target = ndk.hostArchitectures.first.findTarget(LibArch.arm64);
    print('${ndk.path.toFilePath()} '
        'match(minSdk=$minSdk): ${target?.highestMatching(minSdk)}');
  }
}
```

私のマシンでは、`ANDROID_HOME` なしだと `NDKs found: 0` と出力されます (原因 1)。`ANDROID_HOME` を設定して引数に `24` を渡すと `android-35` が、`36` を渡すと `null` が出力されます (原因 2)。

## 修正手順

### 1. android_libcpp_shared に依存しているパッケージを調べる

自分で追加した覚えはないはずです。

```bash
# Flutter 3.44.8
flutter pub deps --style=compact | grep android_libcpp_shared
flutter pub deps --style=tree | grep -B5 android_libcpp_shared
```

執筆時点で pub.dev 上でこれに依存しているパッケージは、`croppy` (1.5.3 は `0.1.0` を厳密に固定)、`flutter_piper_tts` (`^0.1.1`)、`mecab_for_dart` と `than_audiotag` (`^0.2.1`)、`liblsl` (`^0.3.0`) です。解決結果が 0.2.0 以前なら、手順 2 で原因 1 が直ります。

### 2. 0.2.1 以降に更新する

0.2.1 (2026-08-12 公開) で検出処理が書き直されました。Flutter ツールがビルドに使っている NDK (フック設定の C コンパイラーのパスから導出) が候補に加わり、さらに `local.properties` の `sdk.dir` と `ndk.dir`、`flutter config --android-sdk`、より長い既知ディレクトリのリスト、修正された `PATH` 検索も対象になります。Windows では `USERPROFILE` も読みます。

直接の依存ならバージョンを上げてください。推移的で固定されている場合は、オーバーライドします。

```yaml
# pubspec.yaml, Flutter 3.44.8
dependency_overrides:
  android_libcpp_shared: ^0.2.1
```

どの系列を選ぶかは Flutter のバージョンによります。0.2.x は `code_assets ^1.0.0` と `hooks ^2.0.2` に依存します。0.3.0 と 0.3.1 は `code_assets ^2.0.0` に移行しています。Flutter 3.44.8 の `flutter_tools` 自体が `code_assets 1.0.0` を固定しているため、3.44 では検証済みの `^0.2.1` を推奨します。0.2.1 では `ANDROID_HOME` なしでも同じテンプレートアプリがビルドでき、APK には `lib/arm64-v8a/libc++_shared.so` が含まれます。

オーバーライドはグラフ全体に適用されるので、古いバージョンを固定していたパッケージが新しいバージョンでも動くか確認してください。`croppy` は `android_libcpp_shared` をフックの副作用のためだけに使っているので、壊れる API はありません。

### 3. 更新できない場合: 古いフックが検索するパスを与える

0.2.0 以前では、ビルド前にフックが読む変数のいずれかをエクスポートします。

```bash
# macOS / Linux, android_libcpp_shared 0.2.0
export ANDROID_HOME="$HOME/path/to/your/android/sdk"
flutter clean
flutter build apk
```

```powershell
# Windows PowerShell, android_libcpp_shared 0.2.0
$env:ANDROID_HOME = "D:\Android\Sdk"
$env:HOME = $env:USERPROFILE
flutter clean
flutter build apk
```

この変数は、ビルドを起動するプロセスの環境に入っている必要があります。`flutter build` と Gradle 9.1.0 での私のテストでは、起動済みの Gradle デーモンは次のビルドで新しい値を拾い、それは両方向で同じでした。問題が起きるのは、Dock、スタートメニュー、ランチャーから起動した Android Studio です。GUI アプリは `~/.zshrc` を読まないため、同じコマンドがターミナルでは動くのに、IDE からの `flutter run` は失敗します。変数を持つシェルから IDE を起動するか、手順 2 を使ってください。

これを試すときは `flutter clean` を省略しないでください。Flutter はフックの結果を `.dart_tool/` 以下にキャッシュします。私の再現では、`ANDROID_HOME` なしのビルドが、直前のビルドで成功したフックの出力を再利用して通り続けました。クリーンな CI ランナーで失敗するまで、修正できたと思い込んでしまいます。

### 4. minSdk が 35 を超える場合: それをカバーする NDK をインストールする

原因 2 の正しい修正は、sysroot が `minSdk` に届く NDK を使うことだけです。すべてのマシンと CI ランナーで Gradle がダウンロードするよう、明示的に指定します。

```kotlin
// android/app/build.gradle.kts, Flutter 3.44.8, AGP 9.0.1
android {
    ndkVersion = "30.0.16248370" // NDK r30: sysroot API levels 21 to 37
    defaultConfig {
        minSdk = 36
    }
}
```

0.2.1 以降は、見つけたすべての NDK をバージョンでソートし、API チェックを通る最新のものを選びます。そのため、r28c と並べて r30 がインストールされていれば十分です。何か変更する前に、インストール済みの NDK を自分で確認してください。

```bash
# any NDK r23 or later; the host folder is darwin-x86_64 even on Apple silicon
ls "$ANDROID_HOME"/ndk/*/toolchains/llvm/prebuilt/*/sysroot/usr/lib/aarch64-linux-android/
```

その一覧で最大の数値が、この NDK がこのフックに対して満たせる最大の `minSdk` です。

## libcpp_shared_path のオーバーライドとマルチ ABI の罠

0.2.1 では、ライブラリを直接指すユーザー定義という抜け道も追加されました。0.2.1 以降のエラーメッセージは、これを提案さえしています。

```yaml
# pubspec.yaml, android_libcpp_shared 0.2.1
hooks:
  user_defines:
    android_libcpp_shared:
      libcpp_shared_path: /path/to/ndk/toolchains/llvm/prebuilt/darwin-x86_64/sysroot/usr/lib/aarch64-linux-android/libc++_shared.so
```

値がファイルの場合、NDK の検出と API チェックを完全にスキップするので、`minSdk = 36` のビルドは確かに通ります。ただし、全アーキテクチャで同じ 1 つのパスになります。このオーバーライドでリリース APK をビルドして中身を調べました。

```text
lib/arm64-v8a/libc++_shared.so:   ELF 64-bit LSB shared object, ARM aarch64
lib/armeabi-v7a/libc++_shared.so: ELF 64-bit LSB shared object, ARM aarch64
lib/x86_64/libc++_shared.so:      ELF 64-bit LSB shared object, ARM aarch64
```

32 ビット ARM と x86_64 のスロットに、arm64 のライブラリが入っています。ビルドは成功し、アプリも出荷されますが、arm64 以外のデバイスやエミュレーターではライブラリの読み込みに失敗します。ファイルパスを使うのは、単一の ABI をビルドするとき (`--target-platform android-arm64`) だけにしてください。ユーザー定義や `ANDROID_LIBCPP_SHARED_PATH` 環境変数が NDK のルートディレクトリを指している場合、フックは各アーキテクチャを正しく解決しますが、そのパスは API チェックを経由するため、原因 2 の回避にはなりません。

## 新しいバージョンが代わりに出力するもの

0.2.1 以降を使っていてもまだ失敗する場合、"No suitable NDK" という文言は表示されません。フックは、検討したすべての NDK を列挙する、より長い `StateError` を投げます。0.2.1 での `minSdk = 36` の再現では、次のように出力されました。

```text
Could not find libc++_shared.so for target architecture arm64 (minimum NDK API level 36).
NDK installations considered:
  - 1 NDK installation(s) found, but none support arm64 at API level 36
```

"Found, but none support ... at API level" は原因 2 で、手順 4 が当てはまります。"No Android NDK installation was found" は、拡張された検索でも見つからないマシンでの原因 1 です。多くの場合、NDK が一度もダウンロードされていません。任意の Android プロジェクトで Gradle ビルドを 1 回実行するか、`sdkmanager "ndk;28.2.13676358"` でインストールしてください。

## よく似たエラー

- `NDK at .../ndk/<version> did not have a source.properties file` は、展開が途中で終わった NDK です。そのディレクトリを削除すれば直ります。これと他の NDK バージョン不一致は、[assembleDebug の終了コード 1 の解説](/ja/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/)で扱っています。
- `An error occurred while preparing SDK package NDK (Side by side): Not in GZIP format` は、NDK のダウンロード自体が壊れています。[SDK Manager のダウンロードキャッシュを消去する方法](/ja/2026/08/fix-an-error-occurred-while-preparing-sdk-package-ndk-not-in-gzip-format/)を参照してください。
- `No toolchains found in the NDK toolchains folder for ABI with prefix: mips64el-linux-android` は、古い Android Gradle Plugin が新しい NDK と組み合わさったときのエラーです。ビルドフックとは無関係です。
- 上に別の例外が出ている `Building native assets failed` は、別のパッケージのフックです。`Building assets for package:<name> failed` の行を読んで、どのパッケージか確認してください。

## 関連記事

- [Flutter アプリが 16 KB ページサイズで Google Play に拒否される問題](/ja/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/)は、固定した NDK バージョンがリリースの可否を左右する、もう 1 つの場面です。
- [Gradle のジャーナルキャッシュのロックタイムアウト](/ja/2026/10/fix-timeout-waiting-to-lock-journal-cache-in-a-flutter-android-build/)では、Gradle デーモンが、それを起動したビルドより長く生き続ける仕組みを扱っています。
- [Flutter Android ビルドでの AndroidX の競合の解消](/ja/2026/05/fix-androidx-conflict-during-flutter-android-build/)では、`ndkVersion` を含む `android/app/build.gradle` の設定を順に見ていきます。

## 参考資料

- [android_libcpp_shared on pub.dev](https://pub.dev/packages/android_libcpp_shared): 0.2.1 と 0.3.x の [changelog](https://pub.dev/packages/android_libcpp_shared/changelog) を含みます。
- [NexusDynamic/android_libcpp_shared on GitHub](https://github.com/NexusDynamic/android_libcpp_shared): フックと `locate_ndk.dart` のソースです。
- [Flutter docs: hooks and native assets](https://docs.flutter.dev/platform-integration/bind-native-code)
- [package:hooks](https://pub.dev/packages/hooks) と [package:code_assets](https://pub.dev/packages/code_assets): ビルドフックのプロトコルです。
- [Android NDK revision history](https://developer.android.com/ndk/downloads/revision_history): r28c、r29、r30 について。
- Flutter 3.44.8 の `flutter_tools` ソース: `lib/src/android/gradle_utils.dart` (デフォルトの `ndkVersion`)、`lib/src/android/android_sdk.dart` (`getNdkBinaryPath`)、`gradle/src/main/kotlin/FlutterPlugin.kt` (`-dMinSdkVersion`)。
