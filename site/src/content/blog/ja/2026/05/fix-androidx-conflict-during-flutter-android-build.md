---
title: "修正: Flutter の Android ビルド中の AndroidX 競合"
description: "30 秒で直す: android/gradle.properties に android.useAndroidX=true と android.enableJetifier=true を設定し、古い support library をまだ使っているプラグインを見つけてアップグレードするか置き換えます。"
pubDate: 2026-05-18
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "androidx"
lang: "ja"
translationOf: "2026/05/fix-androidx-conflict-during-flutter-android-build"
translatedBy: "claude"
translationDate: 2026-05-18
---

一息での解決策: Flutter の Android ビルド中の `AndroidX conflict` は、依存関係グラフの 2 つの半分が、どの Android support library を対象にするかで一致していないことを意味します。Flutter エンジンと過去 5 年間に公開されたあらゆるプラグインは `androidx.*` を使用します。`android.support.*` をまだ参照している 1 つのプラグイン (または推移的な Java ライブラリ) があれば、ビルドを壊すには十分です。`android/gradle.properties` に `android.useAndroidX=true` と `android.enableJetifier=true` を設定し、`flutter clean` を実行してから、再度 `flutter pub get` と `flutter build apk` を実行します。Gradle がまだ拒否する場合は、`./gradlew app:dependencies` で原因のプラグインを見つけてアップグレードするか置き換えます。`android/app/build.gradle` の下はまだ何も編集しないでください。

```text
* What went wrong:
Execution failed for task ':app:checkDebugDuplicateClasses'.
> Duplicate class android.support.v4.app.INotificationSideChannel found in modules
    core-1.6.0-runtime (androidx.core:core:1.6.0) and
    support-compat-28.0.0-runtime (com.android.support:support-compat:28.0.0)

  Go to the documentation to learn how to <a href="d.android.com/r/tools/classpath-sync-errors">Fix dependency resolution errors</a>.

FAILURE: Build failed with an exception.
BUILD FAILED in 12s
```

このガイドは、2026 年 5 月時点の安定版チャネルである Flutter 3.41.5、Dart 3.11、Android Gradle Plugin 8.7、Gradle 8.11 に対して書かれています。ここで説明する動作は、Android tooling チームが 2018 年に `android.support.*` 名前空間を凍結し、レガシーバイトコードのブリッジとして Jetifier を出荷して以来、同じです。Flutter プロジェクトは [Flutter 1.12](https://docs.flutter.dev/release/breaking-changes/androidx-migration) (2019 年 12 月) で新しいアプリに対して AndroidX をデフォルトで有効にしました。それ以降に生成されたものは、`useAndroidX=true` が標準で出荷されます。このエラーに遭遇しているなら、そのアプリはほぼ確実に 1.12 以前の Flutter SDK で作成され、マイグレーションが適用されたことがありません。

## このエラーが実際に意味すること

`androidx.*` は Android support library の第二世代です。Google はパッケージ名前空間を一度書き直し、二度と改名しないと約束しました。`android.support.v4.*`、`android.support.v7.*`、`android.support.design.*` などの下のクラスは元の support library であり、2018 年 9 月の 28.0.0 以来凍結されています。

Android ビルドシステムは、両方の半分を同時に含む APK のコンパイルを拒否します。これは、重複したクラス名がクラスパス上で衝突するためです。エラーは 3 つの具体的な形式のいずれかで現れます:

```text
> Duplicate class android.support.v4.app.INotificationSideChannel found in modules ...
```

```text
This app is using AndroidX dependencies, but the project does not have
the property android.useAndroidX set to true. Configure your project for
AndroidX. See https://goo.gle/flutter-androidx-migration
```

```text
Cannot fit requested classes in a single dex file (# methods: 73512 > 65536)
```

1 つ目は文字通りのクラスパス衝突です。2 つ目は Flutter ツールの事前チェックが、プロジェクトにまだレガシーのデフォルトがあることに気付いたものです。3 つ目は同じ競合の下流での表れです: 両方のライブラリを取り込むと、すべての support クラスに AndroidX の双子があるため、Dalvik の 64K メソッド制限を超えます。

Jetifier は AGP に同梱されている回避策です。ビルド時に、サードパーティ依存関係から来る任意の JAR または AAR 内のすべての `android.support.*` 参照を、対応する `androidx.*` 参照に書き換えます。Jetifier がオンの場合、support library のバイトコードをまだ出荷しているプラグインは静かに翻訳され、クラス重複の衝突は消えます。Jetifier がオフの場合、重複が露出してビルドが失敗します。AGP 8 以降では、ビルド速度の理由から `enableJetifier` がデフォルトで `false` になっています。これが、何年もの間ツリー内のレガシープラグインに誰も気付かずに生きてきたプロジェクトで、このエラーが再びトップページに戻ってきた理由です。

## 最小再現

最近の SDK で新しい Flutter アプリを作成し、推移的な Java 依存関係を通じてまだ support library を参照しているプラグインを追加します:

```bash
# Flutter 3.41.5
flutter create androidx_repro
cd androidx_repro
flutter pub add some_old_plugin:^1.2.0  # any plugin whose Android side
                                        # depends on com.android.support:*
```

次に、意図的に回避策をオフにします:

```properties
# android/gradle.properties, Flutter 3.41.5, AGP 8.7
org.gradle.jvmargs=-Xmx4G -XX:MaxMetaspaceSize=2G
android.useAndroidX=true
android.enableJetifier=false
```

ビルドを実行します:

```bash
flutter build apk --debug
```

Gradle は上記のクラス重複の失敗を出力し、ゼロ以外で終了します。退行を引き起こす単一の行は、`com.android.support:*` への推移的依存関係と組み合わせた `enableJetifier=false` です。Jetifier をオンに戻すと、プラグインツリーについて何も変更していなくても、同じビルドが成功します。

## 修正、それが答えである頻度の順

手順を順番に実行してください。各手順は、前の手順がエラーを解決しなかったことを前提とします。

### 1. 両方の AndroidX フラグを設定する

`android/gradle.properties` (Flutter SDK 内の Gradle ファイルではなく、ルートプロジェクトの `build.gradle` でもありません) を開き、両方の行が存在することを確認します:

```properties
# android/gradle.properties, Flutter 3.41.5
android.useAndroidX=true
android.enableJetifier=true
```

`useAndroidX=true` は、あなた自身のコードと Flutter エンジンが AndroidX であることを AGP に伝えます。`enableJetifier=true` は、support library をまだ参照しているサードパーティのバイトコードを書き換えるよう AGP に伝えます。両方が必要です。プラグインがまだ support クラスを出荷しているときに `useAndroidX=true` だけを設定することは、まさにクラス重複エラーを生成する構成です。

ファイルが存在しない場合 (Flutter 1.12+ プロジェクトでは稀、ネイティブ Android から移行したアプリでは一般的)、作成してください。次に実行します:

```bash
flutter clean
flutter pub get
flutter build apk --debug
```

ここで `flutter clean` が必須なのは、Gradle が依存関係解決グラフをキャッシュするためです。これがないと、ビルドは失敗したグラフを再利用して同じエラーを報告します。

### 2. レガシープラグインを見つけてアップグレードする

Jetifier がオンでもビルドが失敗する場合、重複は support library 自体ではなく、`android/build.gradle` が `com.android.support:*` を直接宣言し、Jetifier が書き換えられないもの (annotation processor が最も一般的な違反者です。Jetifier はデフォルトでランタイムクラスパスの JAR にのみ動作するためです) を使っているプラグインです。

Android 依存関係ツリーをリストします:

```bash
# from android/ directory, Flutter 3.41.5
./gradlew app:dependencies --configuration releaseRuntimeClasspath | grep -i "com.android.support"
```

出力はプラグインと support library 座標を名指しします。`pubspec.yaml` と相互参照します。優先順位順に 3 つの解決策:

1. **プラグインをアップグレードする** 新しいバージョンが存在する場合。`flutter pub outdated` を実行して違反者を探します。2019 年後半以降に公開されたバージョンは AndroidX ネイティブであり、競合は消えます。
2. **プラグインを置き換える** メンテナンスされていない場合。Flutter コミュニティは、ほとんどの 1.12 以前のプラグインを別の名前で再構築しました。[pub.dev](https://pub.dev) で同じドメイン (通知、image picker など) を検索し、最新のメンテナンスされているオプションを選んでください。
3. **フォークしてパッチを当てる** どちらも役に立たない場合。プラグインのリポジトリをクローンし、`android/build.gradle` のすべての `com.android.support:appcompat-v7:28.0.0` 行を `androidx.appcompat:appcompat:1.6.1` に変更し ([AndroidX のクラスマッピング](https://developer.android.com/jetpack/androidx/migrate/class-mappings) が古い名前を新しい名前に翻訳します)、`pubspec.yaml` を `git:` 経由でフォークを指すように更新し、`flutter pub get` を実行します。

### 3. `compileSdk` を AndroidX を含むバージョンに上げる

このアプリをネイティブ Android から移行した場合、`android/app/build.gradle` が `compileSdkVersion` を 28 以下にピン留めしている可能性があります。AndroidX は `compileSdk` 28 以上を必要とし、最新の安定版で最もよく動作します。Flutter 3.41.5 はデフォルトで `flutter.compileSdkVersion` を 35 に設定します。これをオーバーライドした場合は、デフォルトを復元するか、明示的に設定します:

```groovy
// android/app/build.gradle, Flutter 3.41.5, AGP 8.7
android {
    namespace "com.example.androidx_repro"
    compileSdk 35
    ndkVersion flutter.ndkVersion

    defaultConfig {
        applicationId "com.example.androidx_repro"
        minSdkVersion 21      // AndroidX requires at least 19; pick 21 unless you have a reason
        targetSdkVersion 35
    }
}
```

`minSdkVersion 21` は 2026 年における AndroidX アプリの実用的な下限です。それより下げることは原理的には機能しますが、互換性シムを取り込み、マージステップ中に異なるが同じくらい紛らわしいクラスパスエラーを生成します。

### 4. 重複が消えても dex 制限エラーが残る場合は multidex を有効にする

64K メソッド制限は AndroidX より前から存在し、AGP は `minSdkVersion >= 21` のときに multidex を自動的にオンにします。まだ "cannot fit requested classes" エラーが見える場合は、`minSdk` が 21 未満であり、明示的にオプトインする必要があります:

```groovy
// android/app/build.gradle
android {
    defaultConfig {
        multiDexEnabled true
    }
}

dependencies {
    implementation "androidx.multidex:multidex:2.0.1"
}
```

これは AndroidX の競合自体の修正ではなく、すでに重複クラスを解決したものの残りのメソッド数がまだあふれている場合のクリーンアップパスです。

### 5. 最後の手段: すべての依存関係を監査してからのみ Jetifier をオフにする

`./gradlew app:dependencies` を通じて、ツリー内のどのプラグインも `com.android.support:*` をまだ参照していないことを確認したら、ビルド速度の向上のために `android.enableJetifier=false` に設定します。Jetifier のクラスパス書き換えは、大規模な Flutter アプリのコールド Android ビルドで単一で最も高価なステップです (私たちの測定では、典型的なプロジェクトで 15-30 秒)。無効にしても、コードや pub 依存関係への変更はゼロですが、最初に監査せずにこれを行うと、次に推移的な更新がレガシーライブラリを取り込んだときに競合が戻り、Jetifier を数週間前に削除したからエラーは Jetifier とは無関係だと思うことになります。

## 落とし穴と類似ケース

類似のエラーを生成したり、AndroidX の競合のように見えるが実はそうではないいくつかのケース:

- **`Could not find com.android.tools.build:gradle:X.Y.Z`**: AndroidX の問題ではありません。Google Maven リポジトリが到達不能か、`settings.gradle` が `google()` リポジトリエントリを失いました。`pluginManagement.repositories` と `dependencyResolutionManagement.repositories` に `google()` を追加してください。
- **`Manifest merger failed : Attribute application@appComponentFactory ...`**: これは AGP のバイトコードレベルチェックが存在する前の、マニフェストにおける AndroidX/support 衝突の歴史的な兆候です。同じ修正 (両方のフラグを有効にする) で解決しますが、トリガーは、プラグインの Java コードが support クラスを参照することではなく、プラグインの `AndroidManifest.xml` が `android.support.*` コンポーネント名を宣言していることです。
- **`Class not found: com.android.support.FileProvider`**: プラグインの `AndroidManifest.xml` が support library のパスをハードコードしています。Jetifier はデフォルトでマニフェスト XML を書き換えません。プラグインをアップグレードするか、自分の `AndroidManifest.xml` で `<provider>` 要素を AndroidX 等価物 (`androidx.core.content.FileProvider`) でオーバーライドしてください。
- **release ビルドで `flutter run` 中の `Execution failed for task ':app:processDebugMainManifest'`**: 通常はプラグイン間の `targetSdkVersion` 不一致です。AndroidX は問題なく、activity の `android:exported` について 2 つのプラグインが一致しないためマージが失敗します。同じ Gradle ステップで現れるとはいえ、無関係です。
- **macOS ではビルドが成功するが Linux CI では失敗する**: 最も一般的な根本原因は、開発者マシンの古い `~/.gradle/caches` が、欠けている AndroidX フラグを覆い隠していることです。Linux ランナーはクリーンなキャッシュを持ち、依存関係グラフをゼロから解決します。修正は同じ (フラグ) ですが、症状は CI 固有の問題のように見えます。
- **クリーンな `flutter create` プロジェクトがこれにぶつかる**: ぶつかるべきではありません。新品のアプリがプラグインを追加する前に AndroidX 競合にぶつかる場合、Flutter SDK が 1.12 より古く、アップグレードする必要があります。`flutter upgrade` を実行し、新しい SDK に対して再度 `flutter create` を実行してください。壊れたプロジェクトを編集するのではなく、`lib/` をコピーしてください。

同じプロジェクトで年に 1 回以上 `enableJetifier=true` に頼っているなら、メンテナーが Android プラットフォームを追うのをやめたプラグインが少なくとも 1 つあります。置き換えてください。Jetifier は公式に過渡的なシムとして指定されており、AGP チームは将来のメジャーリリースでそれが削除されると公に述べています。

## 関連

- [修正: pubspec.yaml の Version solving failed](/ja/2026/05/fix-version-solving-failed-in-pubspec-yaml/)
- [修正: MAUI Android の Gradle build failed to produce an .apk file](/ja/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/)
- [修正: Xcode 16 と Flutter 3.x での Failed to build iOS app](/ja/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/)
- [1 つの CI パイプラインから複数の Flutter バージョンをターゲットする方法](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)
- [修正: Flutter の A RenderFlex overflowed by N pixels](/ja/2026/05/fix-renderflex-overflowed-in-flutter/)

## 情報源

- [Flutter の AndroidX マイグレーション](https://docs.flutter.dev/release/breaking-changes/androidx-migration) (docs.flutter.dev)
- [Migrate to AndroidX](https://developer.android.com/jetpack/androidx/migrate) (developer.android.com)
- [AndroidX クラスマッピング](https://developer.android.com/jetpack/androidx/migrate/class-mappings) (developer.android.com)
- [Android Gradle Plugin リリースノート: enableJetifier のデフォルト](https://developer.android.com/build/releases/gradle-plugin) (developer.android.com)
- [flutter/flutter issue 25325: AndroidX サポート追跡](https://github.com/flutter/flutter/issues/25325) (元のマイグレーションの正典スレッド)
