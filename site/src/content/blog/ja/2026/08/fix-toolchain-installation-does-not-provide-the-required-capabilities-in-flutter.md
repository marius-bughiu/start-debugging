---
title: "解決: Toolchain installation does not provide the required capabilities: [JAVA_COMPILER]"
description: "Gradle は JRE でコンパイルしています。マシン全体を探すのではなく、起動時に渡された JVM をそのまま使います。flutter config --jdk-dir を本物の JDK に向けるか、org.gradle.java.home を削除してください。"
pubDate: 2026-08-21
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "java"
lang: "ja"
translationOf: "2026/08/fix-toolchain-installation-does-not-provide-the-required-capabilities-in-flutter"
translatedBy: "claude"
translationDate: 2026-08-21
---

Gradle が動作している Java ホームに `bin/javac` がないため、それは JDK ではなく JRE です。Gradle はより良いものをマシン内から探してはいません。toolchain が一切設定されていない場合、起動時の JVM をそのまま使い、即座に失敗します。Flutter の Android ビルドでは、その JVM をまず `flutter config --jdk-dir` が決めます。したがって `flutter config --jdk-dir "/path/to/a/real/jdk"` を実行して再ビルドしてください。それでもエラーが変わらない場合は、Flutter の判断を何かが上書きしています。`android/gradle.properties` の `org.gradle.java.home` を確認してください。

以下の内容はすべて Flutter 3.44.2 stable で検証しました。このバージョンの Android テンプレートは Gradle 9.1.0、Android Gradle Plugin 9.0.1、Kotlin Gradle Plugin 2.3.20、`compileSdk` 36 を固定しています。

## Gradle が出力するエラーの全文

```text
FAILURE: Build failed with an exception.

* What went wrong:
Could not determine the dependencies of task ':app:packageDebug'.
> Could not create task ':app:compileDebugJavaWithJavac'.
   > Failed to calculate the value of task ':app:compileDebugJavaWithJavac' property 'javaCompiler'.
      > Toolchain installation 'C:\path\to\some-java-home' does not provide the required capabilities: [JAVA_COMPILER]
```

`flutter build apk` 経由では通常その末尾しか見えず、`Gradle task assembleDebug failed with exit code 1` に包まれています。重要なのは引用符の中のパスです。これが Gradle の拒否した Java ホームであり、十中八九、意識して設定したものではありません。

## 設定した覚えのない Java ホームを Gradle が指摘する理由

このメッセージは Flutter でも AGP でもなく Gradle が出しています。Gradle 9.1.0 では `JavaToolchainQueryService` がスローしており、その周辺のロジックがすべてを説明します。

```java
// Gradle 9.1.0, JavaToolchainQueryService.resolveToolchain
boolean useFallback = !requestedSpec.isConfigured();
JavaToolchainSpec actualSpec = useFallback ? fallbackToolchainSpec : requestedSpec;
```

ビルドのどこにも toolchain が設定されていない場合、Gradle は「現在の JVM」を意味するフォールバック仕様を代入します。この経路は検索も絞り込みも順位付けも行いません。

```java
// Gradle 9.1.0, JavaToolchainQueryService.query
if (spec instanceof CurrentJvmToolchainSpec) {
    return asToolchainOrThrow(
        InstallationLocation.autoDetected(currentJavaHome, "current JVM"),
        spec, requiredCapabilities, isFallback);
}
```

`asToolchainOrThrow` はその 1 つのインストールだけを調べ、必要な capability が欠けていれば例外を投げます。これに対して設定済みの経路である `findInstalledToolchain` は、検出されたすべてのインストールを capability を考慮したマッチャーに通し、条件を満たさないものを黙って除外します。

この違いがここで最も役立つ知識です。このエラーは、Gradle が特定の Java ホームを 1 つ渡され、そこにコンパイラーがなかったことを意味します。「Gradle が JDK を見つけられなかった」という意味ではありません。本当に見つからない場合は、まったく別のメッセージが出ます。それは後述します。

さらに、この経路では toolchain の自動検出設定は無関係だということも意味します。同じタスクを `-Dorg.gradle.java.installations.auto-detect=false` 付きと自動検出を有効にしたままの 2 回実行して確認しました。どちらも同一の失敗でした。

## JAVA_COMPILER と言うとき Gradle が実際に確認していること

想像より少ないです。プローブも、モジュールの問い合わせも、コンパイラー API の呼び出しもありません。ファイルの存在確認だけです。

```java
// Gradle 9.1.0, JvmInstallationMetadata.gatherCapabilities
if (getToolByExecutable("javac").exists()) {
    capabilities.add(JavaInstallationCapability.JAVA_COMPILER);
}
if (getToolByExecutable("javadoc").exists()) {
    capabilities.add(JavaInstallationCapability.JAVADOC_TOOL);
}
if (getToolByExecutable("jar").exists()) {
    capabilities.add(JavaInstallationCapability.JAR_TOOL);
}
```

`getToolByExecutable` は `<javaHome>/bin/<name>` をプラットフォーム固有の実行ファイル拡張子付きで解決します。Gradle がインストールを "JDK" と判定するのは `javac`、`javadoc`、`jar` の 3 つがすべて存在する場合だけで、`JAVA_COMPILER` はまさに `bin/javac` のことです。

実務上の帰結はこうです。`bin` ディレクトリに文字どおり `javac` がないという一点を除いてあらゆる意味で JDK である Java ホームも、JRE として報告されます。これには headless ランタイムのみを同梱する Fedora や Debian の `java-17-openjdk` パッケージ、JDK インストール内に残った古い `jre` サブディレクトリ、そして `java` だけを転送して他のツールを転送しないラッパーディレクトリが含まれます。

## 再現手順: JRE を作って失敗を確認する

壊れたマシンは必要ありません。`jlink` でコンパイラーモジュール抜きのランタイムイメージを作ります。それがまさに JRE です。

```bash
# JDK 21.0.11, jlink from the same JDK
MODS=$(java --list-modules | sed 's/@.*//' \
  | grep -vE '^(jdk\.compiler|jdk\.javadoc|jdk\.jshell|jdk\.jlink|jdk\.jdeps|jdk\.jpackage)$' \
  | paste -sd, -)
jlink --add-modules "$MODS" --no-header-files --no-man-pages --output ./real-jre-21
ls ./real-jre-21/bin/javac   # no such file
./real-jre-21/bin/java -version
# openjdk version "21.0.11" 2026-04-21 LTS
```

`jdk.jpackage` を除外することが重要です。これは `jdk.jlink` を引き込み、それが `jdk.jdeps` を引き込み、さらに `jdk.compiler` を連れ戻すため、避けたかった `javac` ランチャーが結局できてしまいます。

次に Flutter をそこへ向け、`flutter create` したままのアプリをビルドします。

```bash
# Flutter 3.44.2 stable, Gradle 9.1.0, AGP 9.0.1
flutter create --platforms=android toolchain_repro
flutter config --jdk-dir "$(pwd)/real-jre-21"
cd toolchain_repro && flutter build apk --debug
```

これは、toolchain ブロックがどこにもない未変更のテンプレートで、この記事の冒頭とまったく同じエラーで失敗します。

## Flutter のビルドは実際にどの Java を使うのか

デバッグ時間の大半がここで浪費されます。Flutter が最初に見るのは `JAVA_HOME` ではないからです。3.44.2 の `packages/flutter_tools/lib/src/android/java.dart` によれば、`_findJavaHome` は次の順で最初に見つかったものを返します。

1. `flutter config --jdk-dir` で設定される、Flutter 自身の設定にある `jdk-dir` の値
2. Android Studio に同梱される JDK
3. 環境変数 `JAVA_HOME`
4. `PATH` 上で `java` が解決される先

つまり古い `jdk-dir` は、まったく問題のない `JAVA_HOME` に永続的かつ静かに勝ちます。再現手順を書いている最中に私もこれに遭遇しました。`JAVA_HOME` を機能を削ったランタイムに向けたのにビルドが通り続けたのは、以前に設定した `jdk-dir` が勝っていたからです。他を変更する前に自分の値を確認してください。

```bash
# Flutter 3.44.2
flutter config --list | grep jdk-dir
```

2 番目の項目について、同梱パスは Android Studio のバージョンによって変わります。Studio 2022 以降は `<studio>/jbr`、macOS では `<studio>/jbr/Contents/Home` を使います。それより古いものは `<studio>/jre` を使います。Flutter がいまだに見つけてしまう古いインストールが残っているなら、その `jre` ディレクトリは十分に容疑者です。

これを見つけにくくしている罠は、`flutter doctor` がコンパイラーの有無を確認しないことです。JRE を設定した状態でも次のように出力します。

```text
[√] Android toolchain - develop for Android devices (Android SDK version 36.0.0)
    • Java binary at: /path/to/real-jre-21/bin/java
      This JDK is specified in your Flutter configuration.
    • Java version OpenJDK Runtime Environment Microsoft-13877171 (build 21.0.11+10-LTS)
```

緑のチェックと "This JDK" という表記です。doctor は `java --version` を実行して出力を解析するだけで、JRE でも問題なく応答できます。`javac` は一度も探しません。すでに doctor の問題を追っているのであれば、`cmdline-tools component is missing` は独自の対処法を持つ別の診断です。

## Flutter を本物の JDK に向けるには

`jdk-dir` を明示的に設定して再ビルドします。一般的なケースではこれが解決策です。

```bash
# Flutter 3.44.2
flutter config --jdk-dir "/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home"
flutter build apk --debug
```

設定する前にそのディレクトリを検証してください。Gradle が行う確認こそ、あなたが行うべき確認です。

```bash
ls "$YOUR_JDK/bin/javac"
```

このファイルが存在しなければ、ディレクトリ名が何であれそのパスは JRE です。Debian と Ubuntu では `openjdk-21-jre-headless` がこの状態を招くパッケージで、必要なのは `openjdk-21-jdk` です。macOS の Homebrew では `openjdk@21` をインストールし、シムではなく表示されるバージョン付きパスを使ってください。

`JAVA_HOME` と通常の優先順位に戻すには、上書きを解除します。

```bash
# Flutter 3.44.2, empty value removes the setting
flutter config --jdk-dir ""
```

## Flutter の JDK 選択を上書きするものは何か

`android/gradle.properties` が Flutter の決定をすべて上書きできます。`org.gradle.java.home` は Gradle デーモンが動作する JVM を指定し、失敗する経路が「現在の JVM」である以上、これを JRE に向ければ `flutter config --jdk-dir` が正しい JDK であってもエラーが再現します。この組み合わせを実際に検証しました。正しい `jdk-dir`、追加した 1 行、そして同じ失敗です。

```properties
# android/gradle.properties, delete this line if it points at a JRE
org.gradle.java.home=/path/to/real-jre-21
```

同じプロパティを `~/.gradle/gradle.properties` でも確認してください。こちらはマシン上のすべてのビルドに適用され、忘れられがちです。その後、Gradle が何を見ているかを確認します。

```bash
# run from android/, Gradle 9.1.0
./gradlew -q javaToolchains
```

このレポートは利用できる中で最速の診断手段です。重要な 2 つのフィールドを出力するからです。

```text
 + Microsoft JDK 21 (21.0.11+10-LTS)
     | Location:           C:\Program Files\Microsoft\jdk-21.0.11.10-hotspot
     | Language Version:   21
     | Is JDK:             true
     | Detected by:        Current JVM

 + Oracle JDK 26 (26.0.2+10-55)
     | Location:           C:\Program Files\Java\jdk-26.0.2
     | Language Version:   26
     | Is JDK:             true
     | Detected by:        Windows Registry
```

エラーメッセージのパスと Location が一致するエントリに `Is JDK: false` と出ていれば、それだけで診断が確定します。

## toolchain ブロックを足せば解決するのか

このエラーに対して最もよく見る助言は、`android/app/build.gradle.kts` で toolchain を宣言することです。確かに結果は変わりますが、望ましい方向とは限りません。ビルドが現在の JVM の経路からマッチングの経路へ移り、そこでは Gradle が実際に検出できたインストールしか受け付けないからです。

まさにそれを試しました。JRE を `jdk-dir` に設定したまま、次を追加すると:

```kotlin
// android/app/build.gradle.kts, AGP 9.0.1, Gradle 9.1.0
java {
    toolchain { languageVersion = JavaLanguageVersion.of(21) }
}
```

別の失敗が発生しました。

```text
> Cannot find a Java installation on your machine (Windows 11 10.0 amd64) matching:
  {languageVersion=21, vendor=any vendor, implementation=vendor-specific, nativeImageCapable=false}.
  Toolchain download repositories have not been configured.
```

JDK 21 は最初からずっとインストールされていました。Gradle が見つけられなかったのは、自動検出がそれを一度も認識していなかったからです。上の `javaToolchains` の出力をもう一度見ると、Microsoft JDK 21 は `Detected by: Current JVM` と表示されています。現在の JVM が JRE になった時点でそのエントリは候補一覧から消え、レジストリのスキャンでは 21 の要求を満たさない JDK 26 しか浮かび上がりませんでした。

つまり toolchain ブロックを単独で置くと、明確なエラーが曖昧なエラーに置き換わります。明示的なインストールパスの代わりではなく、それと併用してください。

## CI で JDK を固定して再発を防ぐには

toolchain を宣言し、インストールの場所を Gradle に伝えます。この組み合わせはデーモンが JRE 上で動いていてもビルドに成功します。`JAVA_HOME` を制御できないビルドエージェントで欲しいのは、まさにこの性質です。

```properties
# android/gradle.properties, Gradle 9.1.0
org.gradle.java.installations.paths=/opt/hostedtoolcache/Java_Temurin-Hotspot_jdk/21.0.11/x64
```

上の `java { toolchain { ... } }` ブロックと組み合わせたこの構成が、`jdk-dir` がコンパイラーのないランタイムを指したままでもグリーンになることを確認した設定です。関連する 2 つのスイッチも知っておく価値があります。`org.gradle.java.installations.fromEnv=JDK21` は名前付き環境変数からパスを読み取るため、すでにそれらをエクスポートしている CI イメージに適します。`org.gradle.java.installations.auto-detect=false` はスキャンを完全に無効化し、パスを固定していないエージェントが任意のものを選ばずに大きな音を立てて失敗するようにします。

解決策として `org.gradle.java.installations.auto-download=true` に手を伸ばさないでください。Gradle 9 は toolchain リポジトリを宣言せずに自動プロビジョニングされた toolchain を使うことを非推奨とし、Gradle 10 でエラーになると警告しています。

## 似ているが別物のエラー

`Toolchain installation '...' could not be probed` は同じメソッドの 2 行前でスローされ、Gradle が `java` をそもそも実行できなかったことを意味します。これは壊れたインストールや不完全なインストール、権限の問題、アーキテクチャの不一致であり、JRE の問題ではありません。

`Cannot find a Java installation on your machine ... matching` は、設定済み toolchain の経路が候補を見つけられなかった状態です。上記のとおりインストールパスを追加すれば解決します。

`Unsupported class file major version` と `Gradle requires JVM 17 or later` は capability の不足ではなくバージョンの不一致です。Flutter 3.44.2 は `gradle_utils.dart` に Java と Gradle の互換表を持っています。Java 21 は Gradle 8.4 以降、Java 24 は 8.14、Java 25 は 9.1.0 が必要です。

`Cannot add extension with name 'kotlin'` は AGP 9 の組み込み Kotlin サポートが旧来の `kotlin-android` プラグインと衝突したもので、2026 年に `assembleDebug` が失敗するもう 1 つの頻出原因です。

## 関連記事

- Flutter は Gradle の失敗をラッパー行で報告するため、[本当のエラーはたいていその上で切り捨てられています](/ja/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/)。
- Android toolchain が緑でも欠けている部品を隠していることがあります。たとえば [cmdline-tools コンポーネント](/ja/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/)です。
- キャッシュを消すまで同じように繰り返す、もう 1 つの Android SDK の失敗: [破損した NDK アーカイブ](/ja/2026/08/fix-an-error-occurred-while-preparing-sdk-package-ndk-not-in-gzip-format/)。
- `android/gradle.properties` に置かれる、ビルドを壊しうる他の設定: [AndroidX と Jetifier のフラグ](/ja/2026/05/fix-androidx-conflict-during-flutter-android-build/)。
- ここで触れた toolchain の既定値に関するバージョンの背景: [Flutter 3.44 での変更点](/ja/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/)。

## 参考資料

- Gradle ユーザーガイド [Toolchains for JVM projects](https://docs.gradle.org/current/userguide/toolchains.html)。自動検出のソース、優先順位、インストール関連プロパティについて。
- Gradle 9.1.0 のソース `JavaToolchainQueryService.java` と `JvmInstallationMetadata.java`。`gradle-9.1.0-all` ディストリビューションの `src` ディレクトリに同梱されています。
- Flutter 3.44.2 のソース。Java の探索順は `packages/flutter_tools/lib/src/android/java.dart`、固定された Gradle、AGP、Kotlin のバージョンは `gradle_utils.dart` を参照しました。
- Gradle の issue [#30499](https://github.com/gradle/gradle/issues/30499) と [#30421](https://github.com/gradle/gradle/issues/30421)。Linux の OpenJDK パッケージで同じメッセージが報告されています。
