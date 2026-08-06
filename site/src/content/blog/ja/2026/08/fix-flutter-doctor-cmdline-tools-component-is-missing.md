---
title: "対処法: flutter doctor が cmdline-tools component is missing と報告する"
description: "Android SDK Command-line Tools をインストールしてバイナリを <sdk>/cmdline-tools/latest/bin に配置し、ANDROID_HOME を SDK ルートに向けてから flutter doctor を再実行します。"
pubDate: 2026-08-06
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "dart"
  - "tooling"
lang: "ja"
translationOf: "2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing"
translatedBy: "claude"
translationDate: 2026-08-06
---

一言で言うと、`flutter doctor` は Android SDK ルートの直下に `cmdline-tools` という名前のディレクトリが存在するかを確認していて、それが存在しないということです。Android Studio では **Tools > SDK Manager > SDK Tools** を開き、**Android SDK Command-line Tools (latest)** にチェックを入れて Apply をクリックしてください。Android Studio を使わない場合は、command-line tools のアーカイブを展開してバイナリが `<sdk-root>/cmdline-tools/latest/bin` に来るように配置し、`ANDROID_HOME` を `<sdk-root>` に設定して (`cmdline-tools` フォルダーではありません)、その後 `flutter doctor --android-licenses` を実行します。その下に出る "Android license status unknown" の行は結果であって二つ目の問題ではありません。ライセンス用のツールは `sdkmanager` であり、`sdkmanager` はまさに不足しているそのパッケージに同梱されているからです。

```text
[!] Android toolchain - develop for Android devices (Android SDK version 36.0.0)
    • Android SDK at C:\Users\mariu\AppData\Local\Android\Sdk
    ✗ cmdline-tools component is missing.
      Try installing or updating Android Studio.
      Alternatively, download the tools from https://developer.android.com/studio#command-line-tools-only and make sure to set the ANDROID_HOME environment variable.
      See https://developer.android.com/studio/command-line for more details.
    ✗ Android license status unknown.
      Run `flutter doctor --android-licenses` to accept the SDK licenses.
```

以下の内容はすべて Flutter 3.44.7 stable (Dart 3.12.x)、2026-08-06 時点の stable チャンネルで検証しています。Android SDK には `cmdline-tools;19.0`、Build-Tools 36.0.0、Platform-Tools 37.0.0 が入っており、OpenJDK 21.0.11 を使用しました。stable チャンネルにおける command-line tools の最新リビジョンは現時点で 22.0 です。

## このチェックはディレクトリ存在確認 1 回だけです

doctor がここで行っている処理がいかに少ないかを知っておく価値があります。紛らわしいケースのほとんどはそれで説明が付くからです。`packages/flutter_tools/lib/src/android/android_workflow.dart` のバリデーターは次のようになっています。

```dart
// flutter_tools, stable channel, Flutter 3.44.7
_task = 'Validating Android SDK command line tools are available';
if (!androidSdk.cmdlineToolsAvailable) {
  messages.add(
    const ValidationMessage.error(
      'cmdline-tools component is missing.\n'
      'Try installing or updating Android Studio.\n'
      ...
    ),
  );
  return ValidationResult(ValidationType.missing, messages);
}
```

そして `android_sdk.dart` の `cmdlineToolsAvailable` は 1 行だけです。

```dart
// flutter_tools, stable channel, Flutter 3.44.7
bool get cmdlineToolsAvailable =>
    directory.childDirectory('cmdline-tools').existsSync();
```

バイナリは実行されません。バージョンも解析されません。Flutter は解決済みの SDK ルートに `cmdline-tools` を連結して `existsSync()` を呼ぶだけです。つまりこのメッセージが出る経路は 2 つしかありません。フォルダーが本当に無いか、あるいは Flutter があなたの見ているものとは別の SDK ルートを解決したか、です。

後者は十分によくあるので、`locateAndroidSdk()` が使う解決順を書き出しておきます。

1. Flutter 自身の設定にある `android-sdk` キー。`flutter config --android-sdk <path>` で設定されます。
2. 環境変数 `ANDROID_HOME`。
3. 環境変数 `ANDROID_SDK_ROOT`。Google は非推奨としていますが、Flutter は今も読み取ります。
4. プラットフォームごとの既定パス。Linux では `~/Android/Sdk`、macOS では `~/Library/Android/sdk`、Windows では `%LOCALAPPDATA%\Android\sdk`。
5. 最後の手段として、PATH を走査して `aapt` (`build-tools/<version>/` 配下) または `adb` (`platform-tools/` 配下) を探し、その位置からルートを推定します。

2 台前のマシンから残っている古い `flutter config --android-sdk` は、完全に正しい `ANDROID_HOME` に打ち勝ちます。`flutter doctor -v` は最終的に採用したパスを表示するので、まず読むべきはその行です。

フォルダーが存在すると、実行ファイル本体は別の探索で見つけられます。`getCmdlineToolsPath` は次の順で試します。

1. `cmdline-tools/latest/bin/sdkmanager[.bat]`
2. `cmdline-tools/<version>/bin/sdkmanager[.bat]` のうち番号が最大のもの
3. `tools/bin/sdkmanager[.bat]`。2020 年より前のレイアウトで、`sdkmanager` は `skipOldTools: true` で要求されるためスキップされます

つまり `latest` が優先されますが、バージョン番号付きのフォルダーでも動作します。この違いは後述の落とし穴の 1 つで効いてきます。

## 10 秒で再現する

動作しているマシンなら、リネーム 1 回でこのエラーになります。

```bash
# Flutter 3.44.7 stable, Windows, Android SDK at %LOCALAPPDATA%\Android\Sdk
mv "$LOCALAPPDATA/Android/Sdk/cmdline-tools" "$LOCALAPPDATA/Android/Sdk/cmdline-tools.bak"
flutter doctor
```

障害の仕組みはこれで全部です。「Android Studio を再インストールしてください」という助言がたいてい間違った理由で効くのもこのためです。Studio を新規インストールすると command-line tools のチェックボックスが入るので、フォルダーが現れるだけです。

## 対処 1: Android Studio の SDK Manager からインストールする

Android Studio があるならこれが推奨経路です。Studio がパッケージを最新に保ってくれるからです。

1. **Tools > SDK Manager** (またはツールバーの SDK Manager アイコン)。
2. **SDK Tools** タブを選びます。
3. **Android SDK Command-line Tools (latest)** にチェックを入れます。ついでに **Android SDK Build-Tools** と **Android SDK Platform-Tools** にもチェックが入っていることを確認してください。Flutter はこれらも必要とします。
4. **Apply** をクリックし、ライセンスに同意してダウンロードを待ちます。
5. `flutter doctor --android-licenses` を実行してすべて同意し、再度 `flutter doctor` を実行します。

チェックボックスのラベルにある "(latest)" という接尾辞に注目してください。これは飾りではありません。Studio がバージョン番号付きフォルダーではなく `cmdline-tools/latest/` にインストールするのは、この指定があるからです。

## 対処 2: すでに何らかのバージョンがあるなら sdkmanager でインストールする

古いものでも構わないので command-line tools が何かしらあるなら、それを使って現行パッケージをインストールします。

```bash
# Android SDK Command-line Tools 19.0, JDK 21
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --install "cmdline-tools;latest"
```

Windows ではバイナリ名は `sdkmanager.bat` です。CI で動く標的ではなく再現可能な固定が欲しい場合は、リビジョンを明示してください。

```bash
# Pin for CI. 22.0 is the newest on the stable channel as of 2026-08-06.
sdkmanager --install "cmdline-tools;22.0"
```

ここには明らかな循環があります。`sdkmanager` は `cmdline-tools` の中にあるので、パッケージが無い状態では `sdkmanager` でそれをインストールすることはできません。そのための対処 3 です。

## 対処 3: パッケージを手作業で用意する

GUI の無い Linux マシン、コンテナー、そして Android Studio を入れたくない人向けの経路です。Android Studio のダウンロードページから "Command line tools only" のアーカイブを取得し、Google のツール群が期待するレイアウトを組み立てます。アーカイブは文字どおり `cmdline-tools` という名前のフォルダーに展開されますが、これは正しい構成より 1 階層足りません。

```bash
# Android SDK Command-line Tools, Linux, 2026-08
export ANDROID_HOME="$HOME/Android/Sdk"
mkdir -p "$ANDROID_HOME/cmdline-tools"
unzip -q commandlinetools-linux-*.zip -d /tmp/clt
mv /tmp/clt/cmdline-tools "$ANDROID_HOME/cmdline-tools/latest"
```

目標とするレイアウトは、SDK Manager のドキュメントが規定しているものです。

```text
$ANDROID_HOME/
└── cmdline-tools/
    └── latest/
        ├── bin/
        ├── lib/
        ├── NOTICE.txt
        └── source.properties
```

参考までに、実際の 19.0 インストール (Windows なので `.bat` ラッパー) の `bin/` の中身は次のとおりです。

```text
apkanalyzer.bat  avdmanager.bat  d8.bat     lint.bat      profgen.bat
r8.bat           resourceshrinker.bat  retrace.bat  screenshot2.bat  sdkmanager.bat
```

続いて環境設定を永続化し、ツールを PATH に追加します。

```bash
# ~/.bashrc or ~/.zshrc
export ANDROID_HOME="$HOME/Android/Sdk"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
```

`ANDROID_HOME` は SDK ルートでなければなりません。これを `$HOME/Android/Sdk/cmdline-tools` や `.../cmdline-tools/latest/bin` に向けてしまうのが、このエラーの自作自演として最も多いパターンです。`<そのパス>/cmdline-tools` が存在しないため、まったく同じメッセージが出ます。

最後に、Flutter が必要とする残りをインストールして検証します。

```bash
sdkmanager --install "platform-tools" "platforms;android-36" "build-tools;36.0.0"
sdkmanager --version
sdkmanager --list_installed
flutter doctor --android-licenses
flutter doctor -v
```

`sdkmanager --list_installed` が正直な確認方法です。この記事を書いたマシンでは次のように出力されます。

```text
Installed packages:
  Path                  | Version       | Description                             | Location
  cmdline-tools;19.0    | 19.0          | Android SDK Command-line Tools (latest) | cmdline-tools\latest
  build-tools;36.0.0    | 36.0.0        | Android SDK Build-Tools 36              | build-tools\36.0.0
  platform-tools        | 37.0.0        | Android SDK Platform-Tools              | platform-tools
  platforms;android-36  | 2             | Android SDK Platform 36, rev 2          | platforms\android-36
```

## 対処 4: SDK の実際の場所を Flutter に教える

フォルダーが存在し `sdkmanager --version` も動くのに `flutter doctor` が文句を言い続ける場合、Flutter は別の場所を見ています。解決順の 1 番目を上書きしてください。

```bash
flutter config --android-sdk "$HOME/Android/Sdk"
flutter doctor -v
```

ここには罠が 2 つあります。`flutter config --android-studio-dir` は SDK ではなく Studio のインストール場所を指す別の設定であり、これを `.../cmdline-tools/latest/bin` に向けるのはこのエラーに逆戻りする既知の経路です。また `flutter config` はユーザーレベルの設定ファイルに書き込むため、一度設定した値は `flutter config --android-sdk ""` で消すまですべてのプロジェクトに付いて回ります。

## 同じエラーに見える落とし穴

**"Observed package id 'cmdline-tools;19.0' in inconsistent location"**。私のマシンでは `sdkmanager` を呼ぶたびにこれが出ます。

```text
Warning: Observed package id 'cmdline-tools;19.0' in inconsistent location
'C:\Users\mariu\AppData\Local\Android\Sdk\cmdline-tools\latest'
(Expected 'C:\Users\mariu\AppData\Local\Android\Sdk\cmdline-tools\19.0')
```

これは表示上のものです。インストール済みパッケージは `source.properties` に `Pkg.Path=cmdline-tools;19.0` と記録しますが、SDK Manager はそれを `latest` に配置しました。"(latest)" パッケージとはそういう意味だからです。`sdkmanager` は動き続けますし、`flutter doctor` も通り続けます。`latest` を `19.0` にリネームして「直そう」としないでください。Flutter はバージョン番号付きの探索で見つけられますが、Gradle の SDK 自動ダウンロードや大半の CI スクリプトは `cmdline-tools/latest/bin` をハードコードしているため壊れます。

**`latest` フォルダーが 2 つある**。`latest` の隣に `latest-2` がある場合、SDK Manager が置き換えられなかったディレクトリの上にインストールしたということです。たいていは `sdkmanager` か `adb` のプロセスがファイルハンドルを掴んでいたのが原因です。`latest` を削除し、`latest-2` を `latest` にリネームして `flutter doctor` を再実行してください。

**`ANDROID_SDK_ROOT` は設定済みだが `ANDROID_HOME` が空**。Flutter は両方を読み、`ANDROID_HOME` を優先します。Gradle と Android Gradle Plugin は何年も逆方向に動いており、サードパーティーのツールには今や `ANDROID_HOME` しか読まないものもあります。`ANDROID_HOME` を設定してください。`ANDROID_SDK_ROOT` は、ツールチェーンの中でまだ必要としているものがある場合にのみ同じ値を設定します。

**別のメッセージ: "Android sdkmanager not found."** 全文は `Android sdkmanager not found. Update to the latest Android SDK and ensure that the cmdline-tools are installed to resolve this.` です。これはより後段のチェックで、フォルダーは存在確認を通ったものの、`latest/bin` にもバージョン番号付きの `bin` にも `sdkmanager` バイナリが見つからなかったことを意味します。よくある原因は展開の入れ子で、アーカイブのフォルダーごと移動して中身を移動しなかったために `cmdline-tools/latest/cmdline-tools/bin/` になっているパターンです。

**3 つ目のメッセージ: "Android sdkmanager tool was found, but failed to run."** 全文は `Android sdkmanager tool was found, but failed to run ($sdkManagerPath): "$error".` です。バイナリは存在し起動もしていますが、内部で例外が投げられています。直接実行して本当のスタックトレースを確認してください。定番の原因は `JAVA_HOME` が古いランタイムを指していることで、"class file version 61.0" (Java 17) に対してランタイム側が "recognizes class file versions up to 55.0" (Java 11) と報告する `UnsupportedClassVersionError` として現れます。command-line tools は 11.0 以降 Java 17 向けにコンパイルされています。逆方向、つまり新しい JDK は問題ありません。19.0 は OpenJDK 21.0.11 上で何の警告も無く動作することを、この記事のために確認しています。

**WSL とコンテナー**。Linux 側の `ANDROID_HOME` を `/mnt/c` 経由で Windows の SDK に向けないでください。Linux 用バイナリはそこに無く、実行ビットも正しくないため、代わりに "sdkmanager not found" の変種を追いかけることになります。Linux 環境の内部にネイティブの SDK をインストールしてください。

**CI ランナー**。GitHub Actions では `android-actions/setup-android` が他の何よりも先に command-line tools をインストールして PATH に載せるため、この種の失敗をパイプラインから完全に取り除けます。半年前のビルドを再現可能に保ちたいなら `latest` を追うのではなくリビジョンを固定してください。[1 本の CI パイプラインから複数の Flutter バージョンを対象にする](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)ときと同じ理屈です。

**ライセンスの行は自然には消えません**。パッケージをインストールしても、`flutter doctor --android-licenses` を実行して 1 つずつ同意するまで `flutter doctor` は `Android license status unknown` を報告し続けます。非対話シェルなら `yes | flutter doctor --android-licenses` で済みます。

## 関連記事

- [対処法: Flutter の Android ビルドで Gradle task assembleDebug failed with exit code 1](/ja/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/)：ツールチェーンの検証が通ってビルドが実際に始まった後に次にぶつかる壁です。
- [対処法: Flutter の Android ビルド中の AndroidX 競合](/ja/2026/05/fix-androidx-conflict-during-flutter-android-build/)：SDK レベルではなく依存関係レベルで起きる Android の失敗です。
- [1 本の CI パイプラインから複数の Flutter バージョンを対象にする方法](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)：SDK のバージョン固定が任意ではなくなる場面です。
- [対処法: pubspec.yaml の Version solving failed](/ja/2026/05/fix-version-solving-failed-in-pubspec-yaml/)：壊れた環境の Dart 側の対応物で、診断方法はまったく異なります。
- [対処法: MAUI Android で Gradle build failed to produce an .apk file](/ja/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/)：同じ Android SDK の配管を .NET 側から見たものです。

## 参照

- [Troubleshooting installation](https://docs.flutter.dev/install/troubleshoot)。Flutter のドキュメントで、まさにこの doctor 出力に対する SDK Manager 経由の手順が示されています。
- [sdkmanager](https://developer.android.com/tools/sdkmanager)。Android Studio のドキュメントで、必須の `cmdline-tools/latest` レイアウトと `--install`、`--list_installed`、`--sdk_root`、`--channel` の各フラグについて。
- [Android SDK Command-Line Tools release notes](https://developer.android.com/tools/releases/cmdline-tools)。
- [flutter/flutter](https://github.com/flutter/flutter) の stable ブランチにある `packages/flutter_tools/lib/src/android/android_workflow.dart` と `android_sdk.dart`。バリデーターの文言と SDK 解決順の出典です。
- [flutter/flutter#139288](https://github.com/flutter/flutter/issues/139288)。報告者が Flutter の設定パスを SDK ルートではなく `cmdline-tools/latest/bin` に向けていた事例です。
- [flutter/flutter#167413](https://github.com/flutter/flutter/issues/167413)。`ANDROID_SDK_ROOT` を設定し `ANDROID_HOME` を空にした Debian 12 上で、正しく配置された SDK を doctor が検出しないという未解決の報告です。
- [android-actions/setup-android](https://github.com/android-actions/setup-android)。CI でのアプローチについて。
