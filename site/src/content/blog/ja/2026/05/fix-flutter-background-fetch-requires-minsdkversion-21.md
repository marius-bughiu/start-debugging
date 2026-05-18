---
title: "修正: Flutter の background_fetch プラグインは minSdkVersion 21 を要求する"
description: "30 秒で済む修正: android/app/build.gradle で minSdkVersion を 21 以上にしてください。background_fetch は API 21 から登場した Android の JobScheduler の上に作られています。"
pubDate: 2026-05-18
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "background_fetch"
lang: "ja"
translationOf: "2026/05/fix-flutter-background-fetch-requires-minsdkversion-21"
translatedBy: "claude"
translationDate: 2026-05-18
---

一息での修正: `background_fetch` プラグイン (Transistor Software) は、API 21 (Android 5.0 Lollipop) で導入された Android の `JobScheduler` を結びつける `AndroidManifest.xml` と Kotlin コードを同梱しています。お使いの Flutter アプリの `android/app/build.gradle` がまだ `minSdkVersion 19` (もしくは 2023 年より前の Flutter SDK で生成されたアプリでは `16`) を使っていると、マニフェストマージャーは `uses-sdk:minSdkVersion 19 cannot be smaller than version 21 declared in library [:background_fetch]` というメッセージでビルドを拒否します。`android/app/build.gradle` を開き、`minSdkVersion` を少なくとも `21` に変更して、`flutter clean` を実行し、続いて `flutter pub get` と `flutter build apk` を実行してください。`minSdk flutter.minSdkVersion` を使う新しい Flutter SDK 上にいる場合は、数値をハードコードせずに Flutter 全体のデフォルトを上書きしてください。そうしないと、Flutter の Gradle プラグインが次のビルドであなたの編集を黙って上書きします。

```text
> Manifest merger failed : uses-sdk:minSdkVersion 19 cannot be smaller than version 21 declared in library [:background_fetch]
    /Users/me/myapp/build/background_fetch/intermediates/merged_manifest/debug/AndroidManifest.xml as the library might be using APIs not available in 19
    Suggestion: use a compatible library with a minSdk of at most 19,
        or increase this project's minSdk version to at least 21,
        or use tools:overrideLibrary="com.transistorsoft.flutter.backgroundfetch" to force usage (may lead to runtime failures)

FAILURE: Build failed with an exception.
BUILD FAILED in 14s
```

このガイドは、2026 年 5 月時点の安定版チャネルである Flutter 3.41.5、Dart 3.11、`background_fetch` 1.6.2、Android Gradle Plugin 8.7、Gradle 8.11 を対象に書いています。エラーそのものは `background_fetch` 1.0.0 以来安定しており、変わったのは新規生成された Flutter プロジェクトに付いてくる `minSdkVersion` のデフォルトだけです。だからこそ、最近アップグレードしたアプリの初回ビルドでこれに遭遇するチームもあれば、一度も見たことがないチームもあるのです。

## このエラーが実際に言っていること

Android のビルドシステムはマニフェストマージャーのパスを走らせ、アプリの `AndroidManifest.xml` をクラスパス上のすべての AAR のマニフェストと結合します。各マニフェストは `<uses-sdk android:minSdkVersion="X"/>` タグを宣言しています。マージャーは最も高い値を選び、アプリケーションレベルの `minSdkVersion` がいずれかのライブラリが宣言する値より低いビルドを拒否します。`background_fetch` は[プラグインのマニフェスト](https://github.com/transistorsoft/flutter_background_fetch/blob/master/android/src/main/AndroidManifest.xml)で `minSdkVersion 21` を宣言しており、マージャーを満たす唯一の方法はアプリケーション側を同じ値まで引き上げることです。

このエラーは Android Gradle Plugin のバージョンや Flutter テンプレート世代によって、3 つの具体的な形で現れます。

```text
Manifest merger failed : uses-sdk:minSdkVersion 19 cannot be smaller than version 21
declared in library [:background_fetch]
```

```text
The plugin background_fetch requires a higher Android SDK version.
Fix this issue by adding the following to /Users/me/myapp/android/app/build.gradle:
android {
  defaultConfig {
    minSdkVersion 21
  }
}
```

```text
A problem occurred evaluating project ':background_fetch'.
> com.transistorsoft.flutter.backgroundfetch requires Android SDK 21 or above
```

1 つ目はマニフェストマージャーの生の出力です。2 つ目は `flutter` CLI のプリフライトのヒントで、Flutter プラグインディスクリプタを通じて `minSdkVersion` を告知しているプラグインに対してのみ発火します。3 つ目はプラグインの `android/build.gradle` に組み込まれた Gradle のアサーションです。3 つすべて同じ制約に帰着します: `JobScheduler` と、`background_fetch` が呼び出す `android.app.job.JobInfo`、`JobService`、`JobParameters` クラスは API 21 で追加されました。API 19 ではそれらは存在すらしません。API 20 (Android Wear 4.4W) では `JobService` の一部だけが出荷されました。プラグインは 21 未満では動作しないため、マニフェストマージャーは壊れた APK を出荷する前にビルドをブロックします。

## なぜ API 21 なのか

`JobScheduler` には理由があります。それ以前は Android で繰り返しのバックグラウンド作業をスケジュールするということは、wake lock 付きの `AlarmManager`、`IntentService`、独自のリトライループを意味していました。このやり方はバッテリーを消費し、Android 6.0 以降は Doze モードを回避し、Android 8.0、9.0、10 で段階的に非推奨にされました。`JobScheduler` は OS がアプリ間でバックグラウンド作業を合体させ、充電状態やネットワーク種別に応じて延期し、プロセス死を生き延びることを可能にします。`background_fetch` は内部的には `JobScheduler` (および iOS の対応物である `BGTaskScheduler`) の Dart に優しい薄いラッパーです。バックエンド全体を書き直さない限り、構造上 21 未満の API を狙うことはできません。

プラグインの [README](https://pub.dev/packages/background_fetch) と `CHANGELOG.md` は 2018 年の 1.0.0 以来この要件を述べていますが、エラーが再び一般的になったのは 2025 年で、Google Play が `targetSdkVersion 33` 以下を狙うアプリを拒否し始め、2019 年以来 `android/app/build.gradle` に手を入れていなかった長寿命の Flutter コードベースの大規模なリビルドを引き起こしたためです。

## 最小再現

まだ `minSdkVersion 19` をデフォルトとする SDK で Flutter アプリを作成し、プラグインを追加し、デバッグビルドを実行します。

```bash
# Flutter 3.7.0 (December 2022), the last template before the 19 -> 21 bump
flutter create background_fetch_repro
cd background_fetch_repro
flutter pub add background_fetch
flutter build apk --debug
```

`flutter pub add background_fetch` は `^1.6.2` に解決され、Android プラグインのマニフェストへの推移的な依存を書き込みます。次のビルドは `Manifest merger failed` で失敗します。別のプラグイン (たとえば `flutter_blue_classic`) がより低い値を必要としているように見えたために `minSdkVersion` を手動で下げた場合、新しく生成された Flutter 3.41.5 のプロジェクトでも同じエラーが再現します。

## 修正の詳細

どの Flutter SDK がプロジェクトを生成したかによって、3 つの実現可能な経路があります。お使いの `android/app/build.gradle` に合う経路を選んでください。

### 経路 A: 数値をハードコードした Groovy build.gradle

`android/app/build.gradle` がリテラルの `minSdkVersion 19` を含む場合、リテラルを変更します。

```groovy
// android/app/build.gradle
// Flutter 3.0 through 3.15 era template
android {
    compileSdkVersion 34

    defaultConfig {
        applicationId "com.example.myapp"
        minSdkVersion 21        // was 19
        targetSdkVersion 34
        versionCode flutterVersionCode.toInteger()
        versionName flutterVersionName
    }
}
```

保存して、`flutter clean && flutter pub get && flutter build apk` を実行します。マージャーはアプリから 21 を選び、プラグインの 21 を受け入れます。

### 経路 B: flutter.minSdkVersion を使う Groovy build.gradle

Flutter 3.16 以降では、リテラルを Flutter の Gradle プラグインが設定するプロパティへの参照に置き換えます。

```groovy
// android/app/build.gradle
// Flutter 3.16 through 3.27 era template
android {
    defaultConfig {
        minSdkVersion flutter.minSdkVersion
    }
}
```

`flutter.minSdkVersion` は Flutter 3.16 以降、デフォルトで 21 になっているので、この分岐はすでに通ります。プロジェクトがこのテンプレートでありながらマニフェストマージャーに失敗する場合は、何かがプロパティを上書きしています。`android/local.properties` に古い `flutter.minSdkVersion=19` の行がないか確認して削除するか、CI が古い値を注入しているなら Gradle のコマンドラインで `-Pflutter.minSdkVersion=21` を渡してください。プロパティ参照をリテラルに置き換えてはいけません。Flutter 3.41 の Gradle プラグインは特定の条件下で `flutter run` のたびに `android/app/build.gradle` を書き換え ([flutter/flutter#177141](https://github.com/flutter/flutter/issues/177141))、あなたの編集を取り消します。

### 経路 C: Kotlin DSL の build.gradle.kts

Flutter 3.29 はテンプレートを Kotlin DSL に切り替えました。形は Kotlin 構文で同じです。

```kotlin
// android/app/build.gradle.kts
// Flutter 3.29 and later
android {
    defaultConfig {
        applicationId = "com.example.myapp"
        minSdk = flutter.minSdkVersion       // resolves to 21 on Flutter 3.29+
        targetSdk = flutter.targetSdkVersion
    }
}
```

値を明示的に固定する必要がある場合 (たとえば、別のプラグインが 23 を要求するため) は、代わりに `minSdk = 23` を設定してください。Flutter の Gradle プラグインは Kotlin DSL テンプレートでは明示的なリテラルを尊重します。書き換えのバグが現在あるのは Groovy テンプレートだけです。

3 つのいずれかの後で、次を実行します。

```bash
flutter clean
flutter pub get
flutter build apk --release
```

`flutter clean` がここで重要なのは、マニフェストマージャーが決定を `build/app/intermediates/merged_manifest/` にキャッシュするからです。clean ステップなしで後続のビルドを行うと、ディスクから失敗したマージを再生し続け、編集が何もしなかったように見えます。

## minSdkVersion を 21 に上げる実際のコスト

API 21 は 2014 年 10 月にリリースされた Android 5.0 Lollipop を意味します。Google 自身の[配布ダッシュボード](https://developer.android.com/about/dashboards) (Google が Android Studio 内部に移す前の最後の意味のある更新) によれば、2026 年時点で API 21 未満のデバイスのシェアは 0.3 パーセントをはるかに下回り、ほぼすべて古い Kindle Fire のタブレットと新興市場の未更新の端末です。Play Store はそもそも API 24 未満を狙う新しいリリースをもう受け付けないので、Play 経由で配布されるアプリにとってこれは無関係です。サイドロードで APK を配布したり、代替ストアで出荷したりしている場合は、API 19 や 20 にロングテールの観客がいるかもしれません。その場合 `background_fetch` は単に選択肢になりません。シムは存在しません。[Pigeon](https://pub.dev/packages/pigeon) チャネル経由で `WorkManager` を直接使うか、永続的な通知を伴うフォアグラウンドサービスを受け入れてください。

## マージャーが通った後の落とし穴

いくつかの後続のエラーは最初のものに似て見えますが、根本原因が異なります。これらを認識して、無駄に `minSdkVersion` を上げ続けて互換性を壊さないようにしましょう。

**別のプラグインが 21 より多くを必要としている。** 修正の後に `cannot be smaller than version 23 declared in library [:flutter_blue_plus]` が出る場合、それは API 23 を要求している別のプラグインです。ツリー内のいずれかのプラグインが宣言する最大値に `minSdkVersion` を上げてください。`android/` から `./gradlew app:dependencies` を実行して列挙します。

**ヘッドレスタスク用のマニフェストタグが欠けている。** アプリが終了している間にコールバックを受け取るために `BackgroundFetch.registerHeadlessTask` を使う場合、マニフェストは receiver を宣言する必要があります。プラグインのマニフェストにはすでに含まれていますが、`<application>` タグに手動で `tools:replace="android:label"` を設定するアプリ (AndroidX 移行時代の修正) は、誤って `android:name` も上書きしたり、receiver を落としたりすることがあります。これが疑われる場合は[AndroidX 競合ガイド](/ja/2026/05/fix-androidx-conflict-during-flutter-android-build/)を読んでください。症状はビルドエラーではなく沈黙 (コールバックが発火しない) です。

**iOS BGTaskScheduler の識別子が欠けている。** Android 側のエラーが最も騒がしいですが、並行する iOS の構成が必要です。`Info.plist` は `com.transistorsoft.fetch` を含む `BGTaskSchedulerPermittedIdentifiers` 配列を必要とし、Xcode プロジェクトは Signing and Capabilities の下で `background-fetch` の capability を有効にしている必要があります。上の Android 修正は Android でビルドを通すだけで、iOS ビルドは依然として失敗するか、さらに悪いことに、ビルドは通って本番でコールバックが発火しません。

**Gradle デーモンが結合済みマニフェストをキャッシュする。** CI では `flutter clean` だけでは常に十分とは限りません。Gradle デーモンは `:app:processDebugManifest` の出力を `~/.gradle/caches/` に保持します。古い `minSdkVersion` で CI 実行が一度失敗していると、次のビルドの前に `./gradlew --stop` を呼ぶか、キャッシュディレクトリを削除しない限り、次の実行は失敗を再生する可能性があります。

**最近の AGP では Jetifier がエラーの見た目を変える。** AGP 8.7 はデフォルトで Jetifier を無効にします。`gradle.properties` で明示的に再有効化している (`android.enableJetifier=true`) 場合、マニフェストマージャーは Jetifier がライブラリ AAR を書き換えた後に動くので、エラーメッセージは `com.transistorsoft.flutter.backgroundfetch` を `androidx.*` に書き換えられた名前に入れ替えます。根本原因は同じ、表面のテキストが違うだけ。修正は同一です。

**ピン留めされた NDK や 30 未満の buildToolsVersion。** 非常に少数の長寿命プロジェクトは `android/app/build.gradle` で `buildToolsVersion "29.0.3"` を固定しています。`background_fetch` 1.6 は Android 14 のビルドツールに対してコンパイルされており、30 未満では `JobService` のシンボルに対してリンクできません。ピンを外すか `34.0.0` に引き上げてください。

## 関連する読み物

AndroidX 移行は古いプロジェクトで Flutter Android ビルドが壊れるもう半分の理由です。マニフェストマージャーと Jetifier の振る舞いの詳細は [Flutter Android ビルド中の AndroidX 競合](/ja/2026/05/fix-androidx-conflict-during-flutter-android-build/) を参照してください。代わりに `flutter pub get` が失敗している場合は、[pubspec.yaml の version solving failed](/ja/2026/05/fix-version-solving-failed-in-pubspec-yaml/) が制約ソルバーの「because」連鎖の読み方を案内します。多くの同じ症状の iOS 側は [Xcode 16 と Flutter 3.x で iOS アプリのビルドに失敗](/ja/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/) に置かれています。そして、実際の Android の失敗がマニフェストマージャーではなく Gradle のコマンドラインである場合、[MAUI Android で Gradle ビルドが .apk を生成できなかった](/ja/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/) には MAUI 固有のパスで同じトリアージ手順があり、AGP キャッシュに関する注記も同様に適用されます。

## 出典

- [pub.dev の `background_fetch` パッケージ](https://pub.dev/packages/background_fetch)
- [`flutter_background_fetch` Android インストールガイド](https://github.com/transistorsoft/flutter_background_fetch/blob/master/help/INSTALL-ANDROID.md)
- [Android `JobScheduler` API リファレンス (API 21 で追加)](https://developer.android.com/reference/android/app/job/JobScheduler)
- [Android Gradle Plugin マニフェストマージャードキュメント](https://developer.android.com/build/manage-manifests)
- [flutter/flutter#177141: Flutter の Gradle プラグインが明示的な `minSdk` を上書きする](https://github.com/flutter/flutter/issues/177141)
- [Flutter 3.16 リリースノート: デフォルトの `minSdkVersion` が 21 に引き上げ](https://docs.flutter.dev/release/release-notes/release-notes-3.16.0)
