---
title: "解決: Flutter の Gradle ビルドで A restricted method in java.lang.System has been called が出る"
description: "JDK 24 以降で出る JEP 472 の警告は無害で、一度だけ表示されます。gradle.properties にフラグを貼り付けるのではなく、JDK と対応する Gradle バージョンを揃えて解決します。"
pubDate: 2026-08-22
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "jdk"
lang: "ja"
translationOf: "2026/08/fix-a-restricted-method-in-java-lang-system-has-been-called-in-a-flutter-gradle-build"
translatedBy: "claude"
translationDate: 2026-08-22
---

ビルドは問題ありません。これは [JEP 472](https://openjdk.org/jeps/472) に由来する JDK 24 以降の警告で、何かが `--enable-native-access` なしに `System.load` または `System.loadLibrary` でネイティブライブラリを読み込んだときに、呼び出し元モジュールごとに一度だけ表示されます。現行の Gradle は自身のデーモンにこのフラグをすでに渡しているため、この警告が見えているなら、JDK が Gradle の対応範囲より新しいか、ビルド内でフォークされたどれかの JVM にフラグが渡っていないかのどちらかです。Android Studio に同梱される JDK 21 に戻せば、警告は完全に消えます。

以下の内容はすべて、Windows 11 上の Flutter 3.44.2 stable (リビジョン `c9a6c48423`)、Gradle 9.1.0、JDK 26.0.2 (`26.0.2+10-55`)、Microsoft OpenJDK 21.0.11 で計測しました。

## エラーの実際の出力

```text
WARNING: A restricted method in java.lang.System has been called
WARNING: java.lang.System::load has been called by net.rubygrapefruit.platform.internal.NativeLibraryLoader in an unnamed module (file:/C:/Users/mariu/.gradle/wrapper/dists/gradle-9.1.0-all/7wzd0jkjit61aq2p43wpjgij9/gradle-9.1.0/lib/native-platform-0.22-milestone-28.jar)
WARNING: Use --enable-native-access=ALL-UNNAMED to avoid a warning for callers in this module
WARNING: Restricted methods will be blocked in a future release unless native access is enabled
```

2 行目は状況によって変わります。呼び出し側が絶対パスではなくライブラリ名を渡した場合は `::load` ではなく `java.lang.System::loadLibrary` になり、呼び出し元クラスは実際にネイティブコードを読み込んだクラスになります。`net.rubygrapefruit.platform.internal.NativeLibraryLoader` は Gradle 自身のネイティブ統合です。`com.sun.jna.Native` はプラグインが持ち込んだ JNA です。

## "a restricted method in java.lang.System has been called" は何を意味しますか?

JDK 24 で導入された JEP 472 により、`System::load`、`System::loadLibrary`、`Runtime::load`、`Runtime::loadLibrary` は制限付きメソッドになり、JNI の `native` メソッドのバインドも制限付き操作になりました。制限付きとは、コードがランタイムの外へ出る前に JVM が明示的な同意を求めるという意味です。不良なネイティブライブラリは、JVM が報告できない形でヒープを破壊しうるためです。

その同意が `--enable-native-access` です。これがないと、JDK 24 以降は上記の 4 行のブロックを表示したうえで処理を続行します。対処を探し始める前に、知っておく価値のある点が 3 つあります。

警告は呼び出しごとではなく、**呼び出し元モジュールごとに一度**だけ出力されます。同じクラスから 3 つのライブラリを読み込むループでも、ブロックは 1 つだけです。

```java
// JDK 26.0.2, plain javac, no flags
public class MultiProbe {
    public static void main(String[] args) {
        for (int i = 0; i < 3; i++) {
            try { System.load("C:/Windows/System32/winhttp.dll"); }
            catch (Throwable t) { /* ignore */ }
        }
        System.out.println("DONE-MULTI");
    }
}
```

これは警告ブロックを 1 つ出力し、続いて `DONE-MULTI` を表示します。ブロックが繰り返し出ているなら、1 つのビルドログの中で複数の異なる JVM、または複数の異なる jar を見ていることになります。各ブロックの 2 行目にあるモジュールパスで区別してください。

デフォルトのモードは今も `warn` です。JDK 26.0.2 で同じクラスを `--illegal-native-access=warn` 付きで実行すると、フラグなしの実行とまったく同じ出力になります。これが、使用中の JDK でデフォルトが `deny` に切り替わっていないことを確認する方法です。

そして最後の行は予告であって、あなたのコードに対する非推奨通知ではありません。"Blocked in a future release" が指しているのは将来の JDK であり、将来の Gradle や Flutter ではありません。

## どの JDK バージョンでこれが出て、なぜ JDK 21 では出ないのですか?

下限は JDK 24 です。この警告は JDK 21 や 17 には存在しません。同じ検証コードを Microsoft OpenJDK 21.0.11 で実行すると `DONE-MULTI` だけが表示されます。

ここは正確に押さえておく価値があります。制限は 2 段階で入ってきたからです。JDK 22 と 23 は Foreign Function and Memory API の制限付きメソッドについて警告するため、メッセージには `java.lang.foreign.Linker` などが現れます。JNI 側、つまりここで扱っている `java.lang.System::load` の形は JDK 24 で入りました。警告に `java.lang.System` が出ているなら、使用中の JDK は 24 以降です。

これが Flutter で重要なのは、Flutter がマシン上で最も新しい JDK を選ぶわけではないからです。`packages/flutter_tools/lib/src/android/java.dart` に従い、次の順序で 1 つを解決します。

1. `flutter config --jdk-dir` で保存されたパス。
2. Android Studio に同梱された JBR。
3. `JAVA_HOME`。
4. `PATH` 上の最初の `java`。

Android Studio に同梱される JBR は現行リリースでは 21 なので、既定の Flutter 環境ではこの警告は出ません。出ているということは、`jdk-dir` か `JAVA_HOME` を自分で JDK 24、25、26 に向けたということで、多くはパッケージマネージャーで「最新の Java」を入れた副作用です。どれが使われているかは `flutter doctor --verbose` で確認できます。解決された Java のバイナリとそのバージョンが表示されます。

## Gradle はすでにデーモンへ --enable-native-access を渡していますか?

渡しています。そして、この点が対処法を変えます。Gradle は 8.14 からこのフラグを付けています。ロジックは `org.gradle.internal.jvm.JpmsConfiguration` にあり、`gradle-base-services-8.14.jar` と `gradle-base-services-9.1.0.jar` のバイトコードは同一です。`forDaemonProcesses(int, boolean)` と `forWorkerProcesses(int, boolean)` が対象の Java バージョンを `24` と比較し、24 以上でブール値が真のときに `--enable-native-access=ALL-UNNAMED` を含むリストを返します。呼び出し側の `DefaultDaemonStarter` と `DefaultWorkerProcessBuilder` は、そのブール値として `NativeServices.NativeServicesMode.isPotentiallyEnabled()` を渡します。

これは動作中のデーモンで確認できます。任意のビルドを開始してから、JVM にコマンドラインを尋ねてください。

```bash
# JDK 26.0.2 jcmd against a running Gradle 9.1.0 daemon
jps -l | grep GradleDaemon
jcmd <pid> VM.command_line
```

JDK 26.0.2 上で動く Gradle 9.1.0 のデーモンでは、`--add-opens` の各項目に混じって `--enable-native-access=ALL-UNNAMED` が 1 つだけ表示されます。ここから分かることが 2 つあります。

- 独自の `org.gradle.jvmargs` を設定しても上書きされません。`gradle.properties` に `org.gradle.jvmargs=-Xmx4G -XX:MaxMetaspaceSize=2G` を置いても、デーモンのコマンドラインには `-Xmx4G`、`-XX:MaxMetaspaceSize=2G` に加えて `--enable-native-access=ALL-UNNAMED` が**そのまま**残ります。これは Flutter で特に重要です。アプリのテンプレートが既定で空でない `org.gradle.jvmargs` 行を持っているためです。
- 一方で `org.gradle.native=false` を設定するとフラグは消えます。`isPotentiallyEnabled()` が偽を返すからです。これは対処ではなく、Gradle がネイティブ統合そのものを丸ごと止める設定で、ファイルシステム監視も一緒に失われます。

したがって、現行の Gradle デーモンから `net.rubygrapefruit.platform.internal.NativeLibraryLoader` を名指しする警告が出ているなら、それはフラグで塞ぐ類のものではありません。その JVM が Gradle の引数を受け取っていないという意味で、原因は 3 つのいずれかです。8.14 より古い Gradle、Gradle の worker API ではなくプラグインがフォークした JVM、あるいは Tooling API 経由でビルドと話している IDE です。最後の点は Gradle 8.14 のリリースノート自身が指摘しています。Tooling API の利用者は、その JNI 利用のため起動時に自分でネイティブアクセスを有効化する必要があります。

## ビルド内のどの JVM が警告を出しているのですか?

2 行目を起点に調べます。ここには呼び出し元クラスと、その出所の jar の両方が書かれており、この組み合わせだけで JVM を特定できます。

- 呼び出し元が `~/.gradle/wrapper/dists/` 配下の `native-platform-*.jar` にあり、`jcmd` ではデーモンにフラグが付いている場合: その警告は、調べたデーモンとは別のプロセス、通常はフォークされたワーカーか、プラグインが起動したコンパイルデーモンから出ています。
- 呼び出し元が `jna-*.jar` にある場合: プラグインが JNA を読み込んでいます。`android/` ディレクトリから `./gradlew :app:dependencies --configuration runtimeClasspath` を実行し、`net.java.dev.jna` を探してください。
- 呼び出し元が `~/.gradle/caches/modules-2/` 配下の jar にある場合: Gradle 本体ではなくプラグインの依存関係であり、フラグ付きでフォークする対応はプラグイン側で必要です。

Gradle は Flutter が代わりに実行するので、まず生の出力を保存します。

```bash
# Flutter 3.44.2, run from the project root
flutter build apk --debug --verbose 2>&1 | tee build.log
grep -n "restricted method" -A 3 build.log
```

## どうすれば警告を消せますか?

推奨順に並べます。

**JDK を Gradle のバージョンに合わせる。** Gradle の互換性マトリクスは厳格です。Java 24 には Gradle 8.14 以降、Java 25 には 9.1.0 以降、Java 26 には 9.4.0 以降が必要です。Flutter 3.44.2 は Gradle 9.1.0、AGP 9.0.1、Kotlin 2.3.20 でプロジェクトを生成するため、新規プロジェクトは JDK 24 や 25 なら問題なく、JDK 26 には 1 バージョン足りません。`android/gradle/wrapper/gradle-wrapper.properties` の wrapper を上げてください。

```properties
# Flutter 3.44.2 default is gradle-9.1.0-all; 9.4.0+ is required for JDK 26
distributionUrl=https\://services.gradle.org/distributions/gradle-9.4.0-all.zip
```

マトリクスを超えた場合、警告だけでは済みません。JDK 26.0.2 上の Gradle 9.1.0 はビルドを完全に失敗させます。

```text
BUG! exception in phase 'semantic analysis' in source unit '_BuildScript_' Unsupported class file major version 70
```

Flutter はこのケースを認識します。`gradle_errors.dart` が `Unsupported class file major version\s+\d+` に一致し、Gradle のバージョンが Flutter の使う Java のバージョンと非互換であることを伝えるボックスを、`flutter doctor --verbose` への案内とともに表示します。

**本当に使いたい JDK を Flutter に指定する。** このプロジェクトで最新の JDK が必要でないなら、そもそも Flutter に渡さないのが最短の道です。

```bash
# Flutter 3.44.2; persists to the Flutter config, survives JAVA_HOME changes
flutter config --jdk-dir "C:\Program Files\Android\Android Studio\jbr"
flutter doctor --verbose
```

`jdk-dir` は解決順で `JAVA_HOME` より上にあるため、パッケージマネージャーがグローバルに設定した内容より優先され、影響範囲は Flutter だけにとどまります。

**フラグが渡っていない JVM にフラグを足す。** これは 2 行目からその JVM を特定できた後にだけ行ってください。古い Gradle のデーモンであれば、`android/gradle.properties` の `org.gradle.jvmargs` に、Flutter のテンプレートがすでに書いた内容へ追記します。

```properties
# Flutter 3.44.2 template default, plus the JEP 472 opt-in
org.gradle.jvmargs=-Xmx8G -XX:MaxMetaspaceSize=4G -XX:ReservedCodeCacheSize=512m -XX:+HeapDumpOnOutOfMemoryError --enable-native-access=ALL-UNNAMED
```

Kotlin のコンパイルデーモンでは、対応する設定は `kotlin.daemon.jvmargs` です。これはミュートボタンではなく、実質的な意味を持つ本物の同意である点に注意してください。class path 上のすべてがネイティブコードを呼んでよい、と宣言していることになります。

## --illegal-native-access=allow を gradle.properties に入れても安全ですか?

安全ではありません。ここで挙げた変更の中で、実際に同僚のビルドを壊しうるのはこれだけです。

`--illegal-native-access` は JEP 472 とともに JDK 24 で導入されました。JDK 21 には存在せず、未知の `-` オプションは JVM 起動時に致命的です。

```text
Unrecognized option: --illegal-native-access=deny
Error: Could not create the Java Virtual Machine.
Error: A fatal exception has occurred. Program will exit.
```

これを `org.gradle.jvmargs` に入れると、JDK 21 を使う全員でビルドが死にます。Android Studio 同梱の JBR を使う開発者全員と、LTS に固定された多くの CI イメージが含まれます。`--enable-native-access` はその点では安全で、JDK 21 から存在し、そこでも問題なく受け付けられますが、それでもグローバルな `GRADLE_OPTS` ではなくプロジェクト単位にとどめるべきです。

`allow` という値にはもう 1 つ問題があります。JEP 472 が一時的なもの、段階的に縮小され最終的に削除されると説明している互換モードだからです。これに依存するということは、他人のスケジュールで決まる将来のどこかの JDK で、警告がエラーとして戻ってくるということです。

## 警告がエラーになると何が起きますか?

先に同意しておけば、その結末を今日確認できます。JDK 26.0.2 で `--illegal-native-access=deny` を付けて Gradle 自身のネイティブライブラリを読み込むとこうなります。

```text
Exception in thread "main" net.rubygrapefruit.platform.NativeException: Failed to load native library 'native-platform.dll' for Windows 11 amd64.
	at net.rubygrapefruit.platform.internal.NativeLibraryLoader.load(NativeLibraryLoader.java:67)
	at net.rubygrapefruit.platform.Native.init(Native.java:60)
Caused by: java.lang.IllegalCallerException: Illegal native access from an unnamed module (file:/C:/.../gradle-9.1.0/lib/native-platform-0.22-milestone-28.jar)
	at java.base/java.lang.Module.ensureNativeAccess(Module.java:311)
	at java.base/java.lang.System$1.ensureNativeAccess(System.java:2110)
```

`IllegalCallerException` が JDK 側の担当分です。その上にあるものはすべてライブラリ自身の失敗処理であり、だからこそこの問題の将来版は、ネイティブアクセスのエラーには見えません。`.dll` や `.so` の読み込みに失敗したときにそのライブラリが言うこと、そのままの見た目になります。JDK 24 以降のジョブで CI を `--illegal-native-access=deny` を付けて回すのは、どのプラグインが最初に壊れるかを知る安価な方法です。ただし共有の `gradle.properties` には入れないでください。

## 関連記事

- [Toolchain installation does not provide the required capabilities: \[JAVA_COMPILER\]](/ja/2026/08/fix-toolchain-installation-does-not-provide-the-required-capabilities-in-flutter/) は、Gradle が JDK ではなく JRE を解決してしまうという、Flutter の JDK 事情のもう半分を扱っています。
- [Gradle task assembleDebug failed with exit code 1](/ja/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) では、Flutter の Android ビルドログから本当のエラーを取り出す手順を追っています。
- [flutter doctor が cmdline-tools コンポーネントの不足を報告する](/ja/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/) は、`flutter doctor --verbose` 自体が不満を訴えている場合の対になる記事です。
- [SDK 35 をターゲットにした後に Flutter の UI が Android のナビゲーションバーに重なる](/ja/2026/08/fix-flutter-ui-overlaps-the-android-navigation-bar-after-targeting-sdk-35/) も、Android プラットフォーム側の変更が Flutter プロジェクトに遅れて現れる事例です。

## 参考資料

- [JEP 472: Prepare to Restrict the Use of JNI](https://openjdk.org/jeps/472)。制限付きメソッドと `--enable-native-access` による同意を定義しています。
- Inside Java の [JDK 24: Prepares Restricted Native Access](https://inside.java/2024/12/09/quality-heads-up/)。JDK 24 の変更に関する Quality Outreach の告知です。
- [Gradle の Java 互換性マトリクス](https://docs.gradle.org/current/userguide/compatibility.html)。各 Java リリースに必要な Gradle バージョンが載っています。
- [Gradle 8.14 リリースノート](https://docs.gradle.org/8.14/release-notes.html)。Java 24 のデーモン対応を追加し、Tooling API 自体の JNI 要件に触れています。
- Flutter 3.44.2 のソース: JDK の解決順は `packages/flutter_tools/lib/src/android/java.dart`、class file バージョンのハンドラーは `packages/flutter_tools/lib/src/android/gradle_errors.dart`。
