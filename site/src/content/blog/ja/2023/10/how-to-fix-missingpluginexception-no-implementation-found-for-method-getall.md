---
title: "修正方法: MissingPluginException: No implementation found for method getAll"
description: "Flutter の `MissingPluginException` 'No implementation found for method getAll' を、shared_preferences や package_info_plus などの類似プラグインで解消する方法を解説します。ProGuard、プラグイン登録、minSdkVersion、ホットリスタートなどを取り上げます。"
pubDate: 2023-10-30
updatedDate: 2023-11-01
tags:
  - "flutter"
lang: "ja"
translationOf: "2023/10/how-to-fix-missingpluginexception-no-implementation-found-for-method-getall"
translatedBy: "claude"
translationDate: 2026-05-01
---
これは Flutter の release ビルドで起きやすい、わりとよくある問題です。多くの場合、ビルド時に ProGuard が必要な API を削ってしまうことが原因で、下のような実装欠落の例外につながります。

```plaintext
Unhandled exception:
MissingPluginException(No implementation found for method getAll on channel plugins.flutter.io/shared_preferences)
      MethodChannel.invokeMethod (package:flutter/src/services/platform_channel.dart:278:7)
<asynchronous suspension>
      SharedPreferences.getInstance (package:shared_preferences/shared_preferences.dart:25:27)
<asynchronous suspension>
      main (file:///lib/main.dart)
<asynchronous suspension>
      _startIsolate.<anonymous closure> (dart:isolate/runtime/libisolate_patch.dart:279:19)
      _RawReceivePortImpl._handleMessage (dart:isolate/runtime/libisolate_patch.dart:165:12)
```

とはいえ、この問題には実際には複数の原因が考えられ、その分だけ複数の解決策もあります。以下ではそれらをひとつずつ見ていきます。

## minify と shrink を無効化する

ProGuard が本当に原因なら、設定を少し変えるだけでこれをすぐに解決できるはずです。`/android/app/build.gradle` を開き、`release` ビルドの設定を、

```gradle
buildTypes {
    release {
        signingConfig signingConfigs.release
    }
}
```

から、こう変更します。

```gradle
buildTypes {
        release {
            signingConfig signingConfigs.release
            
            minifyEnabled false
            shrinkResources false
        }
}
```

## ProGuard の設定を更新する

それで直らない場合は、もう一歩進んで ProGuard の設定を変更します。`build.gradle` の中、`shrinkResources false` の行のすぐ下に、次の 2 行を追加してください。

```gradle
useProguard true
proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
```

次に、`build.gradle` と同じフォルダー (`android/app/proguard-rules.pro`) に `proguard-rules.pro` ファイルを作成し、次の内容を入れます。

```gradle
-keep class androidx.lifecycle.DefaultLifecycleObserver
```

## `main.dart` でプラグインを直接参照する

ProGuard の minify や shrink を無効にしたくない場合は、`main.dart` でプラグインを明示的に参照してみるという手があります。これにより ProGuard が必要な依存関係を辿りやすくなり、ビルド時に削られにくくなります。

`main.dart` の中でプラグインのメソッドを直接ひとつ呼び出してから、もう一度アプリを実行してみてください。

## プラグインが登録されていなかった

`main.dart` で `registerWith` メソッドを呼び出して、プラグインがちゃんと登録されているか確認しましょう。

```dart
if (Platform.isAndroid) {
    SharedPreferencesAndroid.registerWith();
} else if (Platform.isIOS) {
    SharedPreferencesIOS.registerWith();
}
```

## `background_fetch` を使うとき

`background_fetch` を使う場合、headless タスクの中でプラグインを再登録することが重要です。上の登録コードをそのまま使い、タスク関数の先頭に追加してください。

```dart
void backgroundFetchTask(HeadlessTask task) async {
    if (Platform.isAndroid) {
        SharedPreferencesAndroid.registerWith();
    } else if (Platform.isIOS) {
        SharedPreferencesIOS.registerWith();
    }
}
```

## `minSdkVersion` が低すぎる

プラグインが要求する最低 SDK バージョンより低いバージョンをターゲットにしている可能性があります。その場合、アプリのコールドスタート後に下のようなエラーが出るはずです。

```gradle
The plugin shared_preferences requires a higher Android SDK version.
Fix this issue by adding the following to the file android\app\build.gradle:

android {
  defaultConfig {
    minSdkVersion 21
  }
}
```

エラーメッセージの指示に従えば、問題は解消されるはずです。

## ビルドが不正な状態になっているかもしれない

コードや依存関係には何も問題がないかもしれません。プラグインのインストール時にプロジェクトが不正な状態になってしまった可能性があります。それを試しに直すには、`flutter clean` を実行してから `flutter pub get` を実行してください。これで依存関係がクリーンに復元されます。再度アプリを実行して、問題が残っているかどうか確認しましょう。

## 他のパッケージとの競合

この問題を引き起こしうる、競合が知られているパッケージがいくつか存在します。それらをひとつずつ削除して問題が消えるか確認し、原因が特定できたらパッケージを更新してみてください。新しいバージョンで競合が解消されている場合があります。

`MissingPluginException` を引き起こしうるパッケージの一覧を以下に示します。

-   admob\_flutter
-   flutter\_webrtc
-   flutter\_facebook\_login
