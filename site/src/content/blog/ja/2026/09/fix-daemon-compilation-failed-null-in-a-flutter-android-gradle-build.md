---
title: "修正: Flutter の Android Gradle ビルドで発生する e: Daemon compilation failed: null"
description: "Windows では、Flutter プロジェクトと pub キャッシュが別のドライブにあると Kotlin のインクリメンタルコンパイルが失敗します。PUB_CACHE をプロジェクトと同じドライブに移すか、pub キャッシュ上のプラグインだけ IC を無効にしてください。"
pubDate: 2026-09-25
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "kotlin"
lang: "ja"
translationOf: "2026/09/fix-daemon-compilation-failed-null-in-a-flutter-android-gradle-build"
translatedBy: "claude"
translationDate: 2026-09-25
---

このエラーは Windows で、Flutter プロジェクトがあるドライブ (`D:\`) と pub キャッシュがあるドライブ (`C:\Users\<you>\AppData\Local\Pub\Cache`) が異なる場合に発生します。Kotlin のインクリメンタルコンパイラーは、プラグインのソースファイルをすべて `android\` フォルダーからの相対パスとして保存します。`D:\` から `C:\` への相対パスは存在しないため、`shared_preferences_android` のようなプラグインで `compileDebugKotlin` がクラッシュします。最善の修正は、`PUB_CACHE` をプロジェクトと同じドライブに置き、`flutter clean` と `flutter pub get` を実行することです。それができない場合は、プラグインのサブプロジェクトに対してだけ `kotlin.incremental=false` を設定します (後述のスニペットを参照)。Kotlin Gradle Plugin 2.3.0 以前では APK は問題なくビルドされ、エラーはただのノイズです。KGP 2.3.20 (Flutter 3.44 のテンプレート) と KGP 2.4.0 (Flutter 3.47) 以降では、ビルドそのものが失敗することがあります。

以下のバージョン情報は、Flutter 3.47.5 (Dart 3.13.4、AGP 9.1.0、Gradle 9.3.1、KGP 2.4.0)、`shared_preferences` 2.5.5 / `shared_preferences_android` 2.4.28、およびタグ `v1.9.22` から `v2.4.20` までの Kotlin Gradle Plugin のソースで確認しています。

## エラーの全体像

[flutter/flutter#173456](https://github.com/flutter/flutter/issues/173456) や [flutter/flutter#144566](https://github.com/flutter/flutter/issues/144566) の報告は、どれもプラグインごとに次のような出力になっています。

```text
e: Daemon compilation failed: null
java.lang.Exception
	at org.jetbrains.kotlin.daemon.common.CompileService$CallResult$Error.get(CompileService.kt:69)
	at org.jetbrains.kotlin.daemon.common.CompileService$CallResult$Error.get(CompileService.kt:65)
	at org.jetbrains.kotlin.compilerRunner.GradleKotlinCompilerWork.compileWithDaemon(GradleKotlinCompilerWork.kt:244)
	...
Caused by: java.lang.AssertionError: java.lang.Exception: Could not close incremental caches in
  D:\src\my_app\build\shared_preferences_android\kotlin\compileReleaseKotlin\cacheable\caches-jvm\jvm\kotlin:
  class-fq-name-to-source.tab, source-to-classes.tab, internal-name-to-source.tab
	at org.jetbrains.kotlin.incremental.IncrementalCachesManager.close(IncrementalCachesManager.kt:55)
	...
	Suppressed: java.lang.IllegalArgumentException: this and base files have different roots:
	  C:\Users\me\AppData\Local\Pub\Cache\hosted\pub.dev\shared_preferences_android-2.4.28\android\src\main\kotlin\io\flutter\plugins\sharedpreferences\LegacySharedPreferencesPlugin.kt
	  and D:\src\my_app\android.
```

先頭行が `null` になっているのは、デーモンが本当の失敗をメッセージなしの素の `java.lang.Exception` で包んでいるからです。役に立つのは最後の行、`this and base files have different roots` です。ログにこの行があれば、この記事の修正が当てはまります。なければ、末尾の「似たエラー」に進んでください。

## Kotlin のインクリメンタルコンパイラーが単一ドライブを必要とする理由

Kotlin のインクリメンタルコンパイル (IC) は、`build/<module>/kotlin/compile<Variant>Kotlin/cacheable/caches-jvm` の下にルックアップテーブルを保持します。このテーブルは、各ソースファイルとそこから生成されるクラスを対応付けます。Gradle のビルドキャッシュを再配置可能に保つため、Kotlin 1.9.20 からこれらのパスを絶対パスではなく、ベースディレクトリからの相対パスとして保存するようになりました。以下は Kotlin リポジトリの `build-common` にある変換処理です。

```kotlin
// Kotlin build-common, RelocatableFileToPathConverter.kt (unchanged through 2.4.20)
override fun toPath(file: File): String {
    // ...
    // Note: If the given file is located outside `baseDir`, the relative path will start with "../".
    // It's not "clean", but it can work.
    return file.relativeTo(baseDir).invariantSeparatorsPath
}
```

ソースファイルの場合、`baseDir` は**ルートプロジェクトのディレクトリ**で、Flutter アプリでは `<project>\android` です。Flutter のプラグインは Gradle のサブプロジェクトですが、そのソースは pub キャッシュ、つまりこのフォルダーの外にあります。macOS と Linux では、すべてのパスがルート `/` を共有しているので問題なく動きます。実際に私の Mac では、`shared_preferences_android` の IC キャッシュに次のエントリが入っています。

```text
../../../../../../../../Users/marius/.pub-cache/hosted/pub.dev/shared_preferences_android-2.4.28/android/src/main/kotlin/io/flutter/plugins/sharedpreferences/LegacySharedPreferencesPlugin.kt
```

Windows では、`D:\src\my_app\android` と `C:\Users\...\Pub\Cache` はルートが異なります。`..\` をいくら連ねてもドライブをまたぐことはできないので、`File.relativeTo` が `IllegalArgumentException` をスローします。この例外は IC がキャッシュを書き込む途中で発生するため、「Could not close incremental caches」として表面化し、デーモンはそれを「Daemon compilation failed」と報告します。

定番の回避策が効くのもこれで説明がつきます。「プロジェクトを `C:` に移す」、「Kotlin を 1.9.10 (相対パス導入前の最後のバージョン) にダウングレードする」、「一部のプラグインでしか失敗しない」(Kotlin のソースを持つプラグインだけが Kotlin コンパイラーを通るため) の 3 つです。JetBrains はこの根本原因を [KT-63983](https://youtrack.jetbrains.com/issue/KT-63983) で追跡していますが、ステータスはまだ「To be discussed」です。JetBrains のエンジニアは、単純な修正 (`relativeToOrSelf`) ではビルドキャッシュの誤ヒットが起きると指摘しています。Flutter 側の issue は [flutter/flutter#105395](https://github.com/flutter/flutter/issues/105395) で、2022 年から開いたままです。

ソースとルートプロジェクトのルートが異なる構成なら、どれでも同じクラッシュが起きます。`subst` による仮想ドライブ ([KT-65155](https://youtrack.jetbrains.com/issue/KT-65155))、RAM ディスク上のビルドディレクトリ、`\mnt\d\project` のような WSL パスと `D:\project` の混在などです。

## それでも APK がビルドされることがある理由

ログが `e:` の行で埋まったあとに `√ Built build\app\outputs\flutter-apk\app-release.apk` と表示される、という報告が多くあります。一方で、特に Flutter 3.44 以降では本当に `BUILD FAILED` になる人もいます。違いは、デーモンが失敗したあとに Kotlin Gradle Plugin がどのコンパイラー経路を取るかです。各タグの KGP ソースを読んで確認しました。

| KGP バージョン | デフォルトのコンパイラー経路 | デーモン失敗後のフォールバック | ドライブをまたぐプロジェクトでの結果 |
| --- | --- | --- | --- |
| 1.9.20 から 2.3.0 | `GradleKotlinCompilerWork` | `compileInProcess`。明示的に**非インクリメンタル** ("in-process execution strategy is non-incremental") | `e:` の出力がうるさいが、APK はビルドされる |
| 2.3.20 以降 | Build Tools API (`kotlin.compiler.runViaBuildToolsApi` のデフォルトは `true`) | `ROOT_PROJECT_DIR` を含む**同じ**インクリメンタル構成での `performCompilation(IN_PROCESS)` | フォールバックも同じ `relativeTo` に当たり、ビルドが失敗しうる |

Flutter のテンプレートは `android/settings.gradle.kts` で KGP のバージョンを固定しているため、`flutter create` を実行した時点の Flutter バージョンでどちらの行に当たるかが決まります。

| Flutter テンプレート | `templateKotlinGradlePluginVersion` |
| --- | --- |
| 3.35.0 | 2.1.0 |
| 3.38.0, 3.41.0 | 2.2.20 |
| 3.44.0 | 2.3.20 |
| 3.47.0 から 3.47.5 | 2.4.0 |

これは issue のスレッドの内容と一致します。Flutter 3.32 と 3.35 での 2025 年の報告は「APK はビルドされる」と言っています。2026 年 6 月のコメントには「Flutter 3.44 にアップグレードしたらこの問題が出た」とあります。AGP 9.1.0 と KGP 2.4.0 を使った 3.47.0 での 2026 年 8 月の報告では、クリーンな実行で `:shared_preferences_android:compileDebugKotlin` がビルドを失敗させています。これらの人たちが見ているのは新しいバグではありません。以前は古いバグを隠していた Kotlin のフォールバックが、もう隠してくれなくなったのです。

## 最小再現手順

ドライブが 2 つある Windows (または `subst` ドライブを 1 つ) が必要です。pub キャッシュはデフォルトのまま `C:` に置きます。

```powershell
# Windows 11, Flutter 3.47.5, default PUB_CACHE on C:
D:
cd \src
flutter create --platforms=android daemon_repro
cd daemon_repro
flutter pub add shared_preferences
flutter build apk --debug
```

3.47.5 で新規作成したプロジェクトには `com.android.application` 9.1.0、`org.jetbrains.kotlin.android` 2.4.0、Gradle 9.3.1 が入り、Kotlin の IC はデフォルトで有効です。プラグインがなければ、テンプレートのアプリには `android\` の外に Kotlin でコンパイルするものがないため、問題なくビルドされます。「パッケージを 1 つ追加した途端に壊れた」というよくある声はこれで説明できます。

## 修正 1: pub キャッシュをプロジェクトと同じドライブに置く

これが推奨される修正です。原因そのものを取り除き、インクリメンタルコンパイルもすべての場所で維持できます。プロジェクトがあるドライブ上のフォルダーを選び、`PUB_CACHE` をそこに向けて、依存関係を解決し直します。

```powershell
# Windows, any Flutter 3.x: user-level env var, picked up by new shells and IDEs
[Environment]::SetEnvironmentVariable("PUB_CACHE", "D:\PubCache", "User")

# open a NEW terminal (and restart VS Code / Android Studio), then:
cd D:\src\my_app
flutter clean
flutter pub get
flutter build apk --debug
```

`flutter pub get` は新しいキャッシュにパッケージをダウンロードし、`.dart_tool\package_config.json` と `.flutter-plugins-dependencies` を再生成します。Flutter の Gradle プラグインはこれらのファイルからプラグインのパスを読み取るので、すべてのプラグインのサブプロジェクトが `D:\PubCache\...` に解決されるようになります。`flutter clean` が重要なのは、`build\` の下の古い IC キャッシュに以前の配置のパスが残っているからです。古い `C:\Users\<you>\AppData\Local\Pub\Cache` はあとで削除してかまいません。

この修正の限界として、プロジェクトを複数のドライブに置いている場合、キャッシュと一致させられるのはそのうち 1 つだけです。その場合は修正 2 を使ってください。

## 修正 2: プラグインのサブプロジェクトだけインクリメンタルコンパイルを無効にする

pub キャッシュのプラグインはビルド間で変わらないので、IC を使っても何も得をしません。IC が効果を発揮するのは自分の `app` モジュールで、そのソースは `android\` の中にあるため影響を受けません。KGP はプロジェクトごとに、プロジェクトの extra プロパティも含めて `kotlin.incremental` を読み取るので、このスイッチの適用範囲を絞れます。`android/build.gradle.kts` の末尾に次を追加します。

```kotlin
// android/build.gradle.kts, Flutter 3.47.5, AGP 9.1.0, KGP 2.4.0
// Kotlin incremental compilation stores source paths relative to this
// directory. Plugins from the pub cache live outside it, which breaks on
// Windows when the cache is on another drive (KT-63983). Turn IC off for
// those subprojects only; the :app module stays incremental.
subprojects {
    if (!projectDir.canonicalPath.startsWith(rootDir.canonicalPath)) {
        extra["kotlin.incremental"] = "false"
    }
}
```

Groovy の `android/build.gradle` では、次のように書きます。

```groovy
// android/build.gradle, Flutter 3.35 to 3.47
subprojects {
    if (!projectDir.canonicalPath.startsWith(rootDir.canonicalPath)) {
        ext.set("kotlin.incremental", "false")
    }
}
```

macOS 上で 3.47.5 の再現プロジェクトを使い、`flutter clean && flutter build apk --debug` のあとにどのモジュールが IC キャッシュを書き込むかを見て確認しました。スニペットがない場合は、`build/app/kotlin/compileDebugKotlin/cacheable/caches-jvm` と `build/shared_preferences_android/.../caches-jvm` の両方が存在します。スニペットを入れると `app` のものだけになり、APK もビルドされます。Groovy 版でも同じ結果でした。手元にはドライブが 2 つある Windows マシンがないため、Windows のクラッシュが消えるところを自分の目では確認していませんが、仕組みは同じです。IC が無効なら KGP はインクリメンタル構成を作らず、`RelocatableFileToPathConverter` を呼ぶものもなくなります。

正しそうに見えるのに**うまくいかない**方法が 2 つあり、どちらも 3.47.5 で試しました。

- `subprojects {}` の中で `tasks.withType<KotlinCompile>().configureEach { incremental = false }` を書く方法。KGP 自身の構成アクションがあとから `task.incremental = propertiesProvider.incrementalJvm ?: true` を実行し、設定した値を上書きします。`doFirst` で確認したところ、`incremental=true` と出力されました。
- 同じものを `afterEvaluate {}` で包む方法。結果は同じで、キャッシュは書き込まれたままでした。

モジュール単位のスイッチとして生き残るのは、KGP 自身が読み取るプロパティを設定する方法だけです。

リポジトリ内のパス依存 (`path: ../packages/my_plugin`) も `android\` の外にあるので、このスニペットはそれに対しても IC を無効にします。その結果、ビルドのたびにそのプラグインの Kotlin がフルで再コンパイルされますが、通常は 1、2 秒程度です。それが気になる場合は、たとえば `projectDir.canonicalPath.contains("Pub${File.separator}Cache")` のように、判定を pub キャッシュのパスに絞ってください。

## 修正 3: Kotlin のインクリメンタルコンパイルを全体で無効にする

最も大雑把な修正で、issue のスレッドで最もよく引用されているものです。`android/gradle.properties` に次のように書きます。

```properties
# android/gradle.properties, any Flutter / KGP version
kotlin.incremental=false
```

これで動きますし、設定後はどのモジュールにも `caches-jvm` フォルダーが作られないことを確認しました。代償は、`app` モジュールの Kotlin もビルドのたびにゼロから再コンパイルされることです。Flutter テンプレートの `MainActivity.kt` 1 つだけなら問題になりません。ネイティブの Kotlin が多いアプリ (プラットフォームチャネル、ウィジェット、Wear OS モジュールなど) では、`flutter run` の間に積み重なっていきます。その場合は修正 1 か修正 2 を選んでください。

## やってはいけないこと

- **KGP を 1.9.10 にダウングレードしないでください。** 相対パス導入前の最後のバージョンなのでクラッシュは消えます。しかし Flutter 3.47 は 2.2.20 未満の KGP を拒否し、AGP 9 は新しい KGP を必要とするため、Android のツールチェーン全体を 2023 年の状態に固定することになります。
- **「それでも APK はビルドされる」という以前の挙動を取り戻すために `kotlin.compiler.runViaBuildToolsApi=false` を設定しないでください。** KGP 2.4 ではこのプロパティは非推奨として注釈されており (KT-85433、"non-BTA JVM compiler invocation is deprecated")、ビルドのたびにクラッシュのログも出続けます。次の KGP でこのプロパティが削除されるまで、問題を隠すだけです。
- **`kotlin.daemon.useFallbackStrategy=false` を設定しないでください。** 古い KGP バージョンでも、「それでも APK はビルドされる」ケースが完全な失敗に変わります。
- **Flutter SDK を移動しないでください。** SDK の場所はここでは無関係です。Flutter の Gradle プラグインは独自のルートを持つ included build で、そのソースはその隣にあります。問題になるのは、pub キャッシュとプロジェクトのドライブが分かれていることだけです。

## 似たエラー

`Daemon compilation failed` の行がすべてこのバグとは限りません。`Caused by` と `Suppressed` の行を確認してください。

- **`Daemon compilation failed: Could not connect to Kotlin compile daemon`**。デーモンが起動しなかったか途中で落ちたもので、アンチウイルスの干渉やメモリ不足が原因であることが多いです。`cd android; .\gradlew --stop` を実行してから再度ビルドしてください。古い KGP バージョンではフォールバックがデーモンなしでコンパイルするので、通常は無害です。
- **デーモンまたは Gradle での `OutOfMemoryError`**。`gradle.properties` の `kotlin.daemon.jvmargs` と `org.gradle.jvmargs` を増やしてください。[flutter/flutter#133371](https://github.com/flutter/flutter/issues/133371) を参照してください。
- **`Module was compiled with an incompatible version of Kotlin`**。プラグインが、使用中の KGP より新しい Kotlin メタデータバージョンでビルドされています。これは IC の問題ではなくバージョンの不一致で、[AGP 9 移行ガイド](/ja/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/)で扱っています。
- **Kotlin デーモンの行がない、汎用的な `Gradle task assembleDebug failed with exit code 1`**。[assembleDebug の一般的なチェックリスト](/ja/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/)から始めてください。

デーモンの生ログは `android\.kotlin\errors\errors-<timestamp>.log` と `%TEMP%\kotlin-daemon.*.log` にあります。コンソール出力が途中で切れている場合は、これらのファイルで `different roots` を検索してください。

## 関連記事

- [Flutter の Android プロジェクトを組み込み Kotlin 付きの AGP 9 に移行する](/ja/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/)では、この警告を失敗に変えた AGP 9.1 / KGP 2.4 のテンプレートについて説明しています。
- [修正: Flutter で Gradle task assembleDebug failed with exit code 1](/ja/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) は、Android のビルド失敗全般をまとめた記事です。
- [修正: Flutter の Gradle ビルドで A restricted method in java.lang.System has been called](/ja/2026/08/fix-a-restricted-method-in-java-lang-system-has-been-called-in-a-flutter-gradle-build/) も、致命的かどうかを判断する必要がある、目立つ Gradle メッセージです。
- [修正: cmdline-tools 23 で flutter doctor --android-licenses が失敗する](/ja/2026/09/fix-flutter-doctor-android-licenses-fails-with-cmdline-tools-23/) は、今月よく見られるもう 1 つの Windows の Android ツールチェーンの問題です。
- Windows がメインの Flutter マシンなら、[Windows から Flutter iOS をデバッグする](/ja/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/)も参考にしてください。

## 出典

- [flutter/flutter#173456](https://github.com/flutter/flutter/issues/173456) (オープン)。Flutter 3.47.0、AGP 9.1.0、KGP 2.4.0 での 2026-08-16 の再現を含みます。ドライブをまたぐ問題の追跡 issue である [flutter/flutter#105395](https://github.com/flutter/flutter/issues/105395) も参照してください。
- [flutter/flutter#144566](https://github.com/flutter/flutter/issues/144566) と [flutter/flutter#170534](https://github.com/flutter/flutter/issues/170534)。完全なスタックを含む、以前の報告です。
- Kotlin のトラッカー上の [KT-63983](https://youtrack.jetbrains.com/issue/KT-63983)、[KT-65155](https://youtrack.jetbrains.com/issue/KT-65155)、[KT-80077](https://youtrack.jetbrains.com/issue/KT-80077)。
- Kotlin のソース: [`RelocatableFileToPathConverter.kt`](https://github.com/JetBrains/kotlin/blob/master/build-common/src/org/jetbrains/kotlin/incremental/storage/RelocatableFileToPathConverter.kt)、`libraries/tools/kotlin-gradle-plugin` 内の `GradleKotlinCompilerWork.kt` と `btapi/BuildToolsApiCompilationWork.kt`、およびタグ `v2.3.0`、`v2.3.20`、`v2.4.0` の `PropertiesProvider.kt` / `KotlinCompileConfig.kt`。
- Flutter のソース: タグ 3.35.0 から 3.47.5 までの `packages/flutter_tools/lib/src/android/gradle_utils.dart` (`templateKotlinGradlePluginVersion`)。
- `kotlin.incremental` については、kotlinlang.org の [Kotlin Gradle plugin compilation and caches](https://kotlinlang.org/docs/gradle-compilation-and-caches.html)。
- `PUB_CACHE` については、dart.dev の [Environment variables for pub](https://dart.dev/tools/pub/environment-variables)。
