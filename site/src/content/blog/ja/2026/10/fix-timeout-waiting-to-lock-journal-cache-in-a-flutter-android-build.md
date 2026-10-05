---
title: "修正: Flutter Android ビルドでの Timeout waiting to lock journal cache"
description: "別の Gradle プロセスが ~/.gradle/caches/journal-1 を保持したまま手放せない状態です。Owner PID を特定してそのデーモンを終了し、.lock ファイルの削除は避けてください。エラーの場所が移るだけです。"
pubDate: 2026-10-05
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
lang: "ja"
translationOf: "2026/10/fix-timeout-waiting-to-lock-journal-cache-in-a-flutter-android-build"
translatedBy: "claude"
translationDate: 2026-10-05
---

メッセージ内の "Owner PID" が示す別の Gradle プロセスが `~/.gradle/caches/journal-1` のロックを保持しており、ビルドからの解放要求に対して Gradle 固定の 60 秒のタイムアウト内に応答しませんでした。対処法は、そのプロセスを見つけて終了することです。`jps -l` (または `ps`) で `GradleDaemon` であることを確認し、`kill -9 <Owner PID>` (Windows では `Stop-Process -Id <Owner PID> -Force`) を実行して、`flutter run` をやり直してください。ここでは `./gradlew --stop` が何もしないことがよくあります。このコマンドは同じ Gradle バージョンのデーモンしか停止しないためです。`journal-1.lock` を削除しても解決しません。私の再現環境では、次のビルドが今度はファイルハッシュキャッシュでタイムアウトしただけでした。

以下はすべて、macOS、Flutter 3.44.8 (テンプレートは Gradle 9.1.0 と AGP 9.0.1 を固定しています)、Gradle 9.3.1 と 8.14 のディストリビューション、OpenJDK 17、使い捨ての `GRADLE_USER_HOME` で再現したものです。ロックのコードは、現行リリースであるタグ `v9.8.0` の Gradle ソースで確認しました。

## エラーの全体像

私の再現環境での実際の出力です (パスは `~` に短縮しています)。

```text
FAILURE: Build failed with an exception.

* What went wrong:
Gradle could not start your build.
> Cannot create service of type BuildSessionActionExecutor using method LauncherServices$ToolingBuildSessionScopeServices.createActionExecutor() as there is a problem with parameter #21 of type BuildLifecycleAwareVirtualFileSystem.
   ...
            > Could not create service of type FileAccessTimeJournal using GradleUserHomeScopeServices.createFileAccessTimeJournal().
               > Timeout waiting to lock journal cache (~/.gradle/caches/journal-1). It is currently in use by another process.
                 Owner PID: 52907
                 Our PID: 52963
                 Owner Operation: 
                 Our operation: 
                 Lock file: ~/.gradle/caches/journal-1/journal-1.lock

BUILD FAILED in 1m 1s
```

Flutter がビルドを実行している場合も、`FAILURE: Build failed with an exception.` の下に同じブロックが表示され、続いて Flutter 自身の `Gradle task assembleDebug failed with exit code 1` が出ます。この最後の行は知らせ役であって、原因ではありません。

どの Gradle を使っているかは、2 つの点でわかります。Gradle 8.x 以前では "It is currently in use by another **Gradle instance**" と表示されます。Gradle 9.0 からは "in use by another **process**" という表記になります。`Owner Operation` と `Our operation` の行は journal cache ではほとんど常に空なので、無視して構いません。重要なのは `Owner PID` の行です。

## Gradle がロックを取得できない理由

`~/.gradle/caches/journal-1` は、共有キャッシュ内の各ファイルが最後に使われた時刻を記録しており、Gradle のキャッシュクリーンアップが安全に削除できるものを判断するために使われます。`caches/9.1.0/` や `caches/8.14/` と違って**バージョン別ではない**ため、マシン上のすべての Gradle バージョン、すべてのデーモン、すべての IDE 同期が 1 つのディレクトリを共有します。そのため、最も頻繁にぶつかるロックになっています。

Gradle はビルドの間ずっとこれらのロックを保持するわけではありません。"オンデマンド" で取得し、他のプロセスから求められたら手放します。`DefaultFileLockManager` のアルゴリズムは次のとおりです。

1. ロックファイルの state 領域に対して OS のファイルロックを取得しようとします。
2. 失敗した場合、ロックファイルの info 領域から所有者の PID と UDP ポートを読み取り、ループバック経由で所有者に ping を送ります。
3. 所有者がキャッシュを使用中でなければ、ロックを解放して応答します。
4. ロックを取得できるか `DEFAULT_LOCK_TIMEOUT` (60,000 ms) が尽きるまで、指数バックオフで再試行します。

```java
// Gradle v9.8.0, DefaultFileLockManager.java
public static final int DEFAULT_LOCK_TIMEOUT = 60000;
```

タイムアウトは `BasicGlobalScopeServices` から渡される定数です。この値を引き上げる Gradle プロパティもシステムプロパティもないため、"ロックのタイムアウトを延ばす" という選択肢はありません。

つまり、このエラーが "古いロックファイルが残っている" という意味になることはありません。所有者のプロセスが終了していれば、オペレーティングシステムがそのファイルロックを解放し、ビルドは即座にロックを取得できるはずです。このエラーは、**生きているプロセスがロックを保持していて、ping に応答しなかった**ことを意味します。現実的な理由は 4 つあります。

- **所有者がハングしている。** ヒープ不足で GC が空回りしているデーモン、デバッガーで停止しているデーモン、サスペンドされているデーモンなどです。プロセスは生きているので OS はロックを保持し続けますが、ping には応答できません ([gradle/gradle#16299](https://github.com/gradle/gradle/issues/16299))。
- **ping が届かない。** エンドポイントセキュリティやファイアウォール製品 (CrowdStrike、SentinelOne、Symantec WSS、Netskope、一部の VPN クライアント) が、Gradle のループバック UDP トラフィックを破棄することが知られています。macOS 15.1 のファイアウォールの事例は [gradle/gradle#31245](https://github.com/gradle/gradle/issues/31245) で、Gradle 8.12.1 で修正されています。
- **所有者が別のコンテナにいる。** 同じ `~/.gradle` ボリュームをマウントしている 2 つの CI コンテナは、ロックファイルは共有しますがループバックインターフェースは共有しないため、ping が届きません ([gradle/gradle#8750](https://github.com/gradle/gradle/issues/8750))。Gradle のドキュメントには、同時キャッシュアクセスは "is only supported if the different Gradle processes can communicate together" と書かれています。
- **ファイルシステムがロックを正しく扱えない。** ExFAT、一部のネットワーク共有、一部の同期フォルダーなどです ([gradle/gradle#4329](https://github.com/gradle/gradle/issues/4329))。

Flutter の開発マシンでは最初の原因が大半を占めます。Flutter プロジェクトには複数の Gradle クライアントが向きがちだからです。ターミナルや VS Code からの `flutter run`、Android Studio の Gradle 同期、スクリプトからの `flutter build apk` などです。これらが異なる JDK (Android Studio 同梱の JBR と `JAVA_HOME`) や異なる Gradle バージョン (別の Flutter リリースで作成された 2 つのプロジェクト) を使っていると、それぞれが独自のデーモンを持ち、すべてが `journal-1` を共有することになります。

## 最小再現

再現するのに Flutter も実機も必要ありません。1 タスクだけの Gradle プロジェクト、使い捨ての Gradle ユーザーホーム、そしてハングしたデーモンを模す `kill -STOP` があれば十分です。

```bash
# macOS 26, OpenJDK 17, Gradle 9.3.1 (same 9.x error wording as Gradle 9.1.0 in the Flutter 3.44 template)
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
export GRADLE_USER_HOME=/tmp/guh          # keep your real ~/.gradle out of it
mkdir -p /tmp/plain && cd /tmp/plain
echo "rootProject.name = 'plain'" > settings.gradle
echo "tasks.register('hello') { doLast { println 'hello' } }" > build.gradle

gradle hello -q                           # starts a daemon, which keeps journal-1 on demand
PID=$(jps -l | awk '/GradleDaemon/{print $1}')
kill -STOP "$PID"                         # the daemon is alive but cannot answer pings

gradle hello --no-daemon                  # fails after ~60 s: Timeout waiting to lock journal cache
kill -CONT "$PID"
```

同じ使い捨てユーザーホームで測定した結果は次のとおりです。

| シナリオ | 結果 |
| --- | --- |
| 正常でアイドル状態の 9.3.1 デーモン、2 つ目の 9.3.1 ビルド | 2 秒で成功 (デーモンがロックを引き渡します) |
| フリーズした 9.3.1 デーモン、2 つ目の 9.3.1 ビルド | 62 秒後に `journal cache` で失敗、`Owner PID` はフリーズしたデーモン |
| フリーズした 9.3.1 デーモン、`journal-1.lock` を削除して 2 つ目のビルド | 62 秒後に今度は `file hash cache (caches/9.3.1/fileHashes)` で失敗 |
| フリーズした 9.3.1 デーモン、`gradle --stop` (9.3.1) | "Stopping Daemon(s)" でハング (25 秒後もまだ待機中) |
| 正常な 9.3.1 デーモン、Gradle 8.14 からの `gradle --stop` | 9.3.1 のデーモンは動き続けているのに "No Gradle daemons are running." と表示 |
| フリーズした 9.3.1 デーモン、Gradle 8.14 のビルド | 64 秒後に `journal cache` で失敗、古い "another Gradle instance" の表記 |
| フリーズしたデーモンに `kill -9` をして、そのあとビルド | 2 秒で成功 |

3 行目と 5 行目が、このエラーが厄介だと言われる理由を説明しています。

## 修正手順

### 1. Owner PID を特定する

何かを終了する前に、エラーに出ている PID を確認します。

```bash
# macOS / Linux, any Gradle version
ps -o pid,stat,etime,command -p 52907
jps -l                                    # lists every JVM; Gradle daemons show as org.gradle.launcher.daemon.bootstrap.GradleDaemon
```

```powershell
# Windows PowerShell, any Gradle version
Get-CimInstance Win32_Process -Filter "ProcessId = 52907" | Select-Object ProcessId, CommandLine
Get-CimInstance Win32_Process -Filter "Name = 'java.exe'" |
  Where-Object CommandLine -match 'GradleDaemon' |
  Select-Object ProcessId, CommandLine
```

コマンドラインには、デーモンの Gradle バージョンと実行している JDK が含まれているので、誰が起動したのかがわかります。Android Studio の `jbr` フォルダー配下のデーモンは、IDE の同期から来たものです。macOS や Linux の `stat` 列にある `T` は、プロセスが停止していることを意味します。その PID が Gradle デーモンではないプロセス (Kotlin コンパイルデーモンやテスト用の JVM) だった場合は、メモしておいてください。ビルドがあなたの Gradle ユーザーホームを使って長時間動作する JVM をフォークしていることを示しているからです。

その PID がマシン上に存在しない場合、所有者は別の場所、つまり同じ `.gradle` ディレクトリを共有している別のコンテナや VM にいます。下の CI のセクションに進んでください。

### 2. ロックファイルではなく、そのプロセスを終了する

```bash
# macOS / Linux (a stopped or hung JVM ignores a plain kill, so use -9)
kill -9 52907
```

```powershell
# Windows
Stop-Process -Id 52907 -Force
```

所有者が終了すると、オペレーティングシステムがそのロックを解放します。`flutter run` を再実行すれば、ビルドは通常どおり始まります。削除するものはなく、`flutter clean` も不要です。そもそも `flutter clean` は `~/.gradle` には触れません。

すべてのバージョンのすべてのデーモンを一度に片付けるには次のようにします (1 日中プロジェクトを切り替えたあとに便利です)。

```bash
# macOS / Linux: stops all Gradle daemons regardless of version
jps -l | awk '/GradleDaemon/{print $1}' | xargs kill
```

`android/` 内での `./gradlew --stop` は、所有者がラッパーと*同じ* Gradle バージョンの正常なデーモンである場合には問題ありません。Gradle のドキュメントには、"terminates all Daemon processes started with the same version of Gradle used to execute the command" とはっきり書かれています。私の再現では両方の失敗パターンが出ました。別バージョンの `--stop` は所有者を認識すらせず、同じバージョンの `--stop` はハングしたデーモンを終了させずに待ち続けます。

### 3. ハングの原因を取り除く

同じデーモンがハングし続ける場合は、再発する前に理由を調べてください。

- **ヒープ。** Flutter 3.44 のテンプレートは `android/gradle.properties` に `org.gradle.jvmargs=-Xmx8G -XX:MaxMetaspaceSize=4G` を設定します。古い Flutter バージョンで作成されたプロジェクトでは、この値がかなり小さいことが多く、R8 を有効にした大規模なアプリではデーモンが GC の空回りに陥ることがあります。終了する前に `jstack <Owner PID>` を実行してください。GC や `OutOfMemoryError` のフレームだらけであれば確定です。
- **2 つの JDK。** Flutter と Android Studio が同じ JDK を使うようにして、デーモンを 2 つではなく 1 つに共有させます。`flutter doctor -v` は Flutter が使う `Java binary at:` を表示します。Android Studio の Gradle JDK 設定を同じものに向けるか、`flutter config --jdk-dir <path>` で Flutter を Android Studio の JDK に向けてください。
- **セキュリティソフトウェア。** 2 つのプロジェクトを同時にビルドするたびにエラーが出て、所有者が正常な場合は、ループバック UDP をフィルタリングしているファイアウォールやエンドポイントエージェントを疑ってください。プロジェクトの Gradle ラッパーを 8.12.1 より新しいものにアップグレードし (現行の Flutter テンプレートのプロジェクトはすでにそうなっています)、そのうえで、お使いの JDK からのループバックトラフィックを例外にするよう IT 部門に依頼してください。

## CI ランナーと Docker

CI では、Owner PID は通常、別のジョブにあります。有効な構成は 3 つです。

1. **ジョブごとに Gradle ユーザーホームを分ける。** `GRADLE_USER_HOME` をジョブのワークスペース内のパスに設定し、CI のキャッシュステップで実行間の永続化を行います。同時に動作する 2 つのプロセスがロックファイルを共有することはなくなります。
2. **共有の読み取り専用依存関係キャッシュ。** Gradle の `GRADLE_RO_DEP_CACHE` は、事前に作成した `modules-2` ディレクトリを指します。Gradle はこれをロックなしで読み取り、各コンテナは書き込み可能な自分用のユーザーホームを持ちます。この機能は Gradle のドキュメントではまだ incubating とされており、ビルドが読み取っている間は共有コピーに書き込んではいけません。
3. **デーモンを残さない。** `flutter build apk --no-android-gradle-daemon` (このフラグは Flutter 3.44.8 では既定で true です) はラッパーに `--no-daemon` を渡すので、ビルドの JVM はビルドの終了とともに終了します。同時に動作する 2 つのジョブ間の競合は防げませんが、最もよくある所有者、つまり再利用されるランナーで前のジョブが残したデーモンはなくなります。

```yaml
# GitHub Actions, Flutter 3.44.8: per-job Gradle home, cached between runs
env:
  GRADLE_USER_HOME: ${{ github.workspace }}/.gradle-home
steps:
  - uses: actions/cache@v4
    with:
      path: ${{ github.workspace }}/.gradle-home/caches
      key: gradle-${{ runner.os }}-${{ hashFiles('android/**/*.gradle*', 'android/gradle/wrapper/gradle-wrapper.properties') }}
  - run: flutter build apk --release --no-android-gradle-daemon
```

コンテナをホストネットワークで実行しても ping は届くようになりますが、コンテナに求めていた分離を手放すことになります。そのため、私ならまずジョブごとのホームを検討します。

## ".lock ファイルを削除する" という助言がなくならない理由

このエラーで最も支持されている助言は `find ~/.gradle -type f -name "*.lock" -delete` です。所有者がまだ生きている場合にこれが何をするかは、私の再現で確認できます。2 つ目のビルドは新しい `journal-1.lock` を作成してロックしたものの、60 秒後に `caches/9.3.1/fileHashes/fileHashes.lock` でタイムアウトしました。フリーズしたデーモンがそちらのロックも保持していたからです。すべてのロックファイルを削除すれば新しいビルドは先に進めますが、今度は 2 つのプロセスが同じキャッシュファイルを自分のものだと思い込むことになります。その結果が `CorruptedCacheException` と `~/.gradle/caches` の全消去で、[gradle/gradle#30135](https://github.com/gradle/gradle/issues/30135) で報告されているとおりです。

うまくいったように見える場合は、たまたまその間に所有者が終了したか、死んだからです。所有者を終了すれば、破損のリスクなしに同じ結果が得られます。

## よく似たエラー

- **`Timeout waiting to lock file hash cache`、`build cache`、`Generated Gradle JARs cache`、`artifact cache`。** 仕組みも対処も同じです。Owner PID を見つけて終了します。変わるのはキャッシュ名だけです。
- **`Timeout waiting to lock ... It is currently in use by this process.`** `Owner PID` の行がありません。競合は 1 つのビルド内の 2 つのスレッド間で起きており、通常はプラグインやテストキットの誤用が原因です ([gradle/gradle#35592](https://github.com/gradle/gradle/issues/35592))。デーモンを終了しても効果はありません。
- **単独で出る `Gradle task assembleDebug failed with exit code 1`。** これは Gradle が失敗した内容を Flutter がまとめて表示したものです。[assembleDebug failed の裏にある本当のエラーの読み方](/ja/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/)を参照してください。
- **`e: Daemon compilation failed: null`。** "daemon" という語が含まれていますが、これは Kotlin コンパイルデーモンとドライブをまたぐパスのバグで、[Daemon compilation failed の修正](/ja/2026/09/fix-daemon-compilation-failed-null-in-a-flutter-android-gradle-build/)で扱っています。

## 関連記事

- [Fix: Gradle task assembleDebug failed with exit code 1 in a Flutter Android build](/ja/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) では、Flutter のビルドから Gradle 自身のエラーブロックを取り出す方法を説明しています。
- [Migrating a Flutter Android project to AGP 9 with built-in Kotlin](/ja/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/) では、新しいテンプレートが固定する Gradle と AGP のバージョンを扱っています。
- [Fix: A restricted method in java.lang.System has been called](/ja/2026/08/fix-a-restricted-method-in-java-lang-system-has-been-called-in-a-flutter-gradle-build/) は、Gradle デーモンを動かす JDK が重要になる別の事例です。
- [Targeting multiple Flutter versions from one CI pipeline](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) では、ジョブごとの Gradle ホームが効果を発揮するマトリックスビルドを紹介しています。

## 参考資料

- Gradle ソース、[`DefaultFileLockManager.java` at v9.8.0](https://github.com/gradle/gradle/blob/v9.8.0/platforms/core-execution/persistent-cache/src/main/java/org/gradle/cache/internal/DefaultFileLockManager.java) と [`DefaultFileLockContentionHandler.java`](https://github.com/gradle/gradle/blob/v9.8.0/platforms/core-execution/persistent-cache/src/main/java/org/gradle/cache/internal/locklistener/DefaultFileLockContentionHandler.java)。
- Gradle ドキュメント: [The Gradle Daemon](https://docs.gradle.org/current/userguide/gradle_daemon.html) (`--stop` の範囲、デーモンの互換性) と [Dependency caching](https://docs.gradle.org/current/userguide/dependency_caching.html) (キャッシュのロック、`GRADLE_RO_DEP_CACHE`)。
- [gradle/gradle#8750](https://github.com/gradle/gradle/issues/8750)、[#16299](https://github.com/gradle/gradle/issues/16299)、[#31245](https://github.com/gradle/gradle/issues/31245)、[#30135](https://github.com/gradle/gradle/issues/30135)、[#8375](https://github.com/gradle/gradle/issues/8375)。
- Flutter 3.44.8 `flutter_tools`、`lib/src/android/gradle.dart` と `lib/src/runner/flutter_command.dart` (`--android-gradle-daemon` フラグ)。
