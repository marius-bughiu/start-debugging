---
title: "修正: cmdline-tools 23 で flutter doctor --android-licenses が 'The --licenses option is no longer needed' と表示される"
description: "cmdline-tools 23.0 で sdkmanager --licenses が廃止されたため、3.47.3 より前の Flutter はライセンス状態を unknown と報告します。Flutter をアップグレードするか、cmdline-tools 22.0 に固定してください。"
pubDate: 2026-09-15
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "android-sdk"
  - "flutter-doctor"
lang: "ja"
translationOf: "2026/09/fix-flutter-doctor-android-licenses-fails-with-cmdline-tools-23"
translatedBy: "claude"
translationDate: 2026-09-15
---

ライセンス自体はおそらく問題ありません。Android SDK Command-line Tools 23.0 で `sdkmanager` が非推奨になり、`sdkmanager --licenses` は非推奨バナーと "Warning: The --licenses option is no longer needed." を表示するだけで、何も確認せずに終了コード 0 で終わるようになりました。Flutter 3.47.2 までは、この出力からライセンス数を読み取ろうとしますが何も見つからず、ディスク上の状態に関係なく "Android license status unknown" と報告します。`<sdk>/licenses/` を直接読むようになった Flutter 3.47.3 以降にアップグレードしてください (修正は 3.48 beta にも入っています)。アップグレードできない場合は、cmdline-tools 22.0 をインストールし、`cmdline-tools/` にそれより新しいコピーが残っていないことを確認してください。

以下の内容はすべて、macOS 上で Flutter 3.44.8 と Flutter 3.47.3、検証用 SDK に cmdline-tools 22.0 と 23.0 を並べて配置し、OpenJDK 17.0.20.1 を使って再現したものです。

## flutter doctor が表示するエラー

`flutter doctor -v` は、他の項目がすべて緑でも Android toolchain に警告を出します。

```text
[!] Android toolchain - develop for Android devices (Android SDK version 36.1.0)
    • Android SDK at /Users/you/Library/Android/sdk
    • Platform android-36, build-tools 36.1.0
    • Java version OpenJDK Runtime Environment Homebrew (build 17.0.20.1+0)
    ✗ Android license status unknown.
      Run `flutter doctor --android-licenses` to accept the SDK licenses.
      See https://flutter.dev/to/macos-android-setup for more details.
```

指示どおりに実行すると、おなじみの "Review licenses that have not been accepted (y/N)?" というプロンプトの代わりに次の出力が表示され、すぐに終了コード 0 で終了します。

```text
WARNING: The SDK Manager CLI tool (sdkmanager) is deprecated. Android CLI will be used instead.
The 'android' binary can also be found in the cmdline-tools directory, and 'android sdk' is the replacement for 'sdkmanager'.
To learn more about the Android CLI and how to use it, see the documentation (https://d.android.com/tools/agents/android-cli)

Warning: The --licenses option is no longer needed.
```

もう一度 `flutter doctor` を実行しても、"license status unknown" の行は残ったままです。このループがバグのすべてで、[flutter/flutter#191487](https://github.com/flutter/flutter/issues/191487) (macOS、Flutter 3.47.1) として報告され、さらに [#191558](https://github.com/flutter/flutter/issues/191558) (Windows 11) と [#191963](https://github.com/flutter/flutter/issues/191963) (Windows 10、Flutter 3.47.2) としても報告されています。

## Flutter がライセンスの承諾状態を判定できない理由

Flutter の `AndroidLicenseValidator` は、ライセンスファイルを自分で読みません。`sdkmanager --licenses` を実行し、stdout を 1 行ずつ読み、3 つの正規表現と照合します。3.44.8 タグ時点の `packages/flutter_tools/lib/src/android/android_workflow.dart` のコードは次のとおりです。

```dart
// Flutter 3.44.8, packages/flutter_tools/lib/src/android/android_workflow.dart
final licenseCounts = RegExp(r'(\d+) of (\d+) SDK package licenses? not accepted.');
final licenseNotAccepted = RegExp(r'licenses? not accepted', caseSensitive: false);
final licenseAccepted = RegExp(r'All SDK package licenses accepted.');
```

いずれかがマッチすれば、状態は `some`、`none`、`all` のどれかになります。どれもマッチしなければ、バリデーターは `LicensesAccepted.unknown` を返します。これが今あなたが見ている行です。

cmdline-tools 22.0 もすでに非推奨バナーを表示しますが、その後でライセンスの処理を行うため、正規表現は目的の行を見つけられます。`android-sdk-license` だけが存在する検証用 SDK では、22.0 は次のように出力しました。

```text
Loading local repository...

6 of 7 SDK package licenses not accepted.
Review licenses that have not been accepted (y/N)?
```

cmdline-tools 23.0 では、この部分がまるごとなくなっています。23.0 の `sdkmanager --licenses` を 2 回、`licenses/` フォルダーがある状態と、名前を変えて退避させた状態で実行しました。出力はどちらもまったく同じで、バナー、"no longer needed" の警告、終了コード 0 でした。ツールはもはやライセンスの状態をいかなる形でも報告しないため、Flutter が解析できるものが何もありません。修正 PR の作者も同じ結論に達しており、新しい `android` CLI にもライセンス状態を確認するサブコマンドは見つからなかったとしています。

ループの後半も同じところから来ています。`flutter doctor --android-licenses` は、`sdkmanager --licenses` を対話モードで実行してキー入力をそのまま渡すだけのラッパーです。23.0 が警告を表示して終了すると、承諾するものは何もなく、次に `flutter doctor` を実行しても Flutter が新しく読み取れる情報はありません。

## 再現: バージョンの組み合わせ

原因がこれだけであることを確かめるため、`cmdline-tools/22.0` と `cmdline-tools/23.0` の両方を置いた検証用 SDK ルートを作り、`ANDROID_HOME` をそこに向け、各組み合わせで `flutter doctor -v` を実行しました。Flutter はまず `cmdline-tools/latest/bin/sdkmanager` を探し、なければ番号が最も大きいバージョン付きフォルダーにフォールバックするので、`23.0` フォルダーを隠すだけで切り替えられます。

| Flutter | cmdline-tools | ディスク上の `licenses/` | `flutter doctor` の出力 |
| --- | --- | --- | --- |
| 3.44.8 | 22.0 | `android-sdk-license` のみ | Some Android licenses not accepted |
| 3.44.8 | 22.0 | なし | Android licenses not accepted |
| 3.44.8 | 23.0 | `android-sdk-license` のみ | Android license status unknown |
| 3.44.8 | 23.0 | なし | Android license status unknown |
| 3.47.3 | 23.0 | `android-sdk-license` のみ | All Android licenses accepted |
| 3.47.3 | 23.0 | なし | Android licenses not accepted |
| 3.47.3 | 23.0 | `android-sdk-license` はあるが空 | Android licenses not accepted |

未修正の Flutter では、23.0 によってすべての状態が "unknown" になります。3.47.3 では、結果は再びファイルの状態に応じて決まります。

## 修正 1: Flutter を 3.47.3 以降にアップグレードする

修正は [flutter/flutter#191554](https://github.com/flutter/flutter/pull/191554) で、2026-08-29 に master にマージされ、2026-09-02 に stable ([#192133](https://github.com/flutter/flutter/pull/192133)) と beta ([#192132](https://github.com/flutter/flutter/pull/192132)) にチェリーピックされました。これを含む最初のリリースは stable 3.47.3 と beta 3.48.0-0.4.pre です。`CHANGELOG.md` の 3.47.3 hotfix の項目には、#191487 が名指しで記載されています。

```bash
# Flutter 3.47.x stable channel
flutter channel stable
flutter upgrade
flutter --version   # expect 3.47.3 or later
flutter doctor -v
```

パッチの内容は限定的です。`--licenses option is no longer needed` という正規表現を 1 つ追加しています。この行が現れ、かつ従来のパターンがどれもマッチしなかった場合、Flutter は stdout を信用するのをやめて `<sdk>/licenses/` の中身を列挙します。隠しファイルでも空でもないファイルが 1 つでもあれば `all`、使えるファイルがなければ `none` になります。ディレクトリを列挙できなければ、結果は `unknown` です。古いバージョンの `sdkmanager` は、従来の解析処理をそのまま通ります。

古い Flutter の系列 (3.44.x、3.41.x) に固定している場合、バックポートはありません。チェリーピックは 3.47 と 3.48 の候補ブランチにしか入っていないため、それらの系列では修正 3 を使うか、見た目だけの警告として受け入れてください。

## 修正 2: ライセンスが実際にディスク上にあることを確認する

doctor の表示が誤っていると判断する前に、確認しましょう。ライセンスの承諾は昔から SDK ルート配下のハッシュファイルとして記録されており、Gradle も不足している platform や build-tools パッケージを自動ダウンロードしてよいかを判断する際に、このファイルを読んでいます。

```bash
# any OS with a POSIX shell; ANDROID_HOME points at the SDK root
ls -la "$ANDROID_HOME/licenses"
cat "$ANDROID_HOME/licenses/android-sdk-license"
```

正常なマシンであれば、少なくとも `android-sdk-license` があり、`24333f8a63b6825ea9c5514f83c2829b004d1fee` のような 40 文字のハッシュが 1 つ以上含まれています。このファイルがあれば、未修正の `flutter doctor` が何と言おうと `flutter build apk` は動作します。issue の報告者も同じことに気づいており、APK のビルドは成功し続けていました。

新しい CI イメージなどでフォルダーがない場合、cmdline-tools 23.0 ではその作り方が変わっています。もうプロンプトはありません。何らかのパッケージをインストールすると、ライセンスファイルが自動的に書き込まれます。cmdline-tools 23.0 だけを `latest` としてコピーした空の SDK ルート 2 つで試しました。

```bash
# cmdline-tools 23.0, fresh SDK root with no licenses/ folder
"$ANDROID_HOME/cmdline-tools/latest/bin/android" --no-metrics --sdk="$ANDROID_HOME" sdk install platform-tools

# or, the deprecated spelling, which forwards to the same code
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$ANDROID_HOME" --install platform-tools
```

どちらのコマンドも stdin を閉じた状態で終了コード 0 で終わり、`platform-tools_r37.0.1` をダウンロードして、`24333f8a...` のハッシュを含む `licenses/android-sdk-license` を残しました。これで Flutter 3.47.3 が "All Android licenses accepted" と報告するには十分です。パッケージ名に注意してください。新しい `android sdk install` では、`sdkmanager` で使っていたセミコロンではなく、スラッシュ (`platforms/android-36`、`build-tools/36.0.0`) を使います。

## 修正 3: 古い Flutter では cmdline-tools 22.0 に固定する

修正が入っていない Flutter のリリースから離れられず、doctor の表示をきれいにしたい場合は、まだライセンス数を出力する `sdkmanager` を Flutter に渡します。Flutter は `cmdline-tools/latest` を最初に選ぶので、23.0 の `latest` の隣に 22.0 をインストールしても何も変わりません。23.0 をどかす必要があります。

Android Studio では、**Settings > Languages & Frameworks > Android SDK > SDK Tools** を開き、**Show Package Details** にチェックを入れ、**Android SDK Command-line Tools (latest)** のチェックを外して **22.0** にチェックを入れ、適用します。これは #191558 の報告者が確認した回避策です。

ターミナルからは次のようにします。

```bash
# macOS/Linux, cmdline-tools 23.0 currently installed as cmdline-tools/latest
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --install "cmdline-tools;22.0"
mv "$ANDROID_HOME/cmdline-tools/latest" "$HOME/cmdline-tools-23.0-backup"
ls "$ANDROID_HOME/cmdline-tools"   # only 22.0 should remain
flutter doctor --android-licenses
```

インストール先は `cmdline-tools/22.0` で、`latest` がなくなると Flutter はそのバージョン付きフォルダーにフォールバックします。すると `flutter doctor --android-licenses` で本来の対話プロンプトが再び表示され、未承諾のライセンスを承諾できます。非対話シェルでも、22.0 なら `yes | flutter doctor --android-licenses` が引き続き動作します。

この方法には注意点が 2 つあります。1 つ目は、これはあくまで固定であり、次に Android Studio で "update all" を実行すると 23.0 が `latest` として戻ってくることです。2 つ目は、`cmdline-tools/latest/bin` をハードコードしているツールがあることです (Gradle の SDK 自動ダウンロードや、多くの CI スクリプト)。ライセンスを承諾したら、22.0 をいつまでも残しておくより、Flutter をアップグレードして 23.0 を戻すほうがすっきりします。

## 落とし穴と紛らわしいケース

**3.47.3 の "All Android licenses accepted" は以前より甘めです。** ディスク上のファイルによるフォールバックでは、`some` と `all` を区別できません。`android-sdk-license` だけがある状態で、22.0 は "6 of 7 SDK package licenses not accepted" と表示し、古い Flutter は "Some Android licenses not accepted" と表示しました。23.0 上の 3.47.3 は "All Android licenses accepted" と表示します。`android-sdk-license` は platforms、build-tools、platform-tools、NDK をカバーしているので、通常のビルドではこれで正しいです。Preview、TV、XR のシステムイメージには専用のライセンスファイルがあり (22.0 のカウントにおける残りの 6 つがそれです)、これらをインストールする場合は doctor の表示を信じるのではなく、`licenses/` に該当するファイルがあるかを確認してください。

**空のライセンスファイルは未承諾として扱われます。** CI のレシピの中には、承諾を偽装するためにファイルを `touch` するものがあります。3.47.3 では、0 バイトの `android-sdk-license` は "Android licenses not accepted" になります。本物のハッシュを書き込むか、できれば `android sdk install` に作成させてください。

**doctor の出力を grep する CI スクリプト。** `flutter doctor -v | grep "All Android licenses accepted"` のようなステップは、23.0 と組み合わせた未修正の Flutter ではすべて失敗します。`yes | flutter doctor --android-licenses` は失敗しなくなりましたが、何もしなくなってもいます。代わりにファイルを確認してください: `test -s "$ANDROID_HOME/licenses/android-sdk-license"`。[1 つの CI パイプラインで複数の Flutter バージョンを対象にする方法](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)のように 1 つのパイプラインで複数の Flutter バージョンをテストしている場合、古いマトリックスのジョブは "unknown" を出力し、3.47.3 以降は成功すると考えてください。

**`android` バイナリは初回使用時に自身をインストールします。** 初めて `cmdline-tools/23.0/bin/android` を実行したとき、"Downloading Android CLI..." と表示されて `~/.android/cli` に展開され、SDK の利用規約と利用状況メトリクスに関する通知が表示されました。CI では `--no-metrics` を付けてください。cmdline-tools 23.0 では、`android --version` は `1.0.16261425` を返しました。このバイナリは 22.0 にも存在します。

**"Unable to locate Android SDK" は別の問題です。** 検証用 SDK を作っている途中、最初の doctor の実行はライセンスのチェックに到達する前に失敗しました。ルートに cmdline-tools はあっても `platforms` や `build-tools` がなかったためです。この行や "cmdline-tools component is missing" が表示される場合、解決策はここではなく [cmdline-tools component is missing の記事](/ja/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/)にあります。

**`flutter config --android-sdk` は `ANDROID_HOME` より優先されます。** 以前に `flutter config` でパスを設定していると、Flutter は `ANDROID_HOME` を無視し、あなたが調べているのとは別の SDK をチェックしている可能性があります。`flutter config --list` で保存されているパスを確認でき、`flutter doctor -v` は実際に使ったパスを "Android SDK at" の行に表示します。

**新しい CLI はまだ Flutter に組み込まれていません。** オープン中の PR [#191826](https://github.com/flutter/flutter/pull/191826) は、Flutter の NDK のプロビジョニングも `android sdk install` に移行するものです。2026-09-15 時点ではマージされていないため、Flutter 3.47.3 はライセンスについて引き続き非推奨の `sdkmanager` を呼び出しており、それが古いフラグを残し続けることに依存しています。

## 関連記事

- [修正: flutter doctor が cmdline-tools component is missing と報告する](/ja/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/) では、Flutter が SDK を探す順序と、ここにも当てはまる `sdkmanager` の Java 要件を扱っています。
- doctor ではなく Gradle が JDK について文句を言っている場合は、[Toolchain installation does not provide the required capabilities](/ja/2026/08/fix-toolchain-installation-does-not-provide-the-required-capabilities-in-flutter/) を参照してください。
- SDK のダウンロードが壊れている場合は、症状が異なります: [NDK (Side by side): Not in GZIP format](/ja/2026/08/fix-an-error-occurred-while-preparing-sdk-package-ndk-not-in-gzip-format/)。
- hotfix リリースが本当の修正になるもう 1 つのケース: [flutter upgrade 後の Could not create Dart VM instance](/ja/2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build/)。

## 出典

- [flutter/flutter#191487](https://github.com/flutter/flutter/issues/191487)、P1 のトラッキング issue。重複として [#191558](https://github.com/flutter/flutter/issues/191558) と [#191963](https://github.com/flutter/flutter/issues/191963)。
- [flutter/flutter#191554](https://github.com/flutter/flutter/pull/191554)、修正本体。stable と beta へのチェリーピックは [#192133](https://github.com/flutter/flutter/pull/192133) と [#192132](https://github.com/flutter/flutter/pull/192132)。
- [flutter/flutter#191826](https://github.com/flutter/flutter/pull/191826)、Android CLI の完全対応に向けたオープン中の PR。
- [3.47.3 時点の Flutter CHANGELOG](https://github.com/flutter/flutter/blob/3.47.3/CHANGELOG.md) と [3.47.3 時点の `android_workflow.dart`](https://github.com/flutter/flutter/blob/3.47.3/packages/flutter_tools/lib/src/android/android_workflow.dart)。
- `android sdk install`、`list`、`update`、`remove` の構文については [Android CLI のドキュメント](https://developer.android.com/tools/agents/android-cli)。
- [sdkmanager のドキュメント](https://developer.android.com/tools/sdkmanager)。
