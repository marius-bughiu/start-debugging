---
title: "Android 15 で Flutter の位置情報トラッキングをバックグラウンドで動かし続ける方法"
description: "Android 15 と 16 で、ホームボタン、履歴からのスワイプ、再起動を乗り越える Flutter の位置情報トラッカーを動かす方法です。独自の Flutter エンジンで動く location タイプのフォアグラウンドサービス、必要な権限の正確な一覧、そして while-in-use のルールに引っかかったときに発生する SecurityException を解説します。geolocator 14.0.3 と flutter_foreground_task 11.0.3 で検証済みです。"
pubDate: 2026-09-22
template: how-to
tags:
  - "flutter"
  - "dart"
  - "android"
  - "location"
  - "foreground-service"
lang: "ja"
translationOf: "2026/09/how-to-keep-flutter-location-tracking-running-in-the-background-on-android-15"
translatedBy: "claude"
translationDate: 2026-09-22
---

**要点:** Android 15 (および 16) で Flutter の位置情報トラッカーが動き続けるのは、位置情報の更新が UI isolate 内のストリームからではなく、**独自の Flutter エンジンを持つ**、**タイプ `location` のフォアグラウンドサービス**から届く場合だけです。`FOREGROUND_SERVICE` と `FOREGROUND_SERVICE_LOCATION`、それに `ACCESS_FINE_LOCATION` を宣言し、サービスに `android:foregroundServiceType="location"` を指定し、アクティビティが表示されている間にボタンのタップからサービスを開始して、そのサービス内で `Geolocator.getPositionStream` をリッスンします。"アプリがバックグラウンドにある間もトラッキングを続ける" だけなら `geolocator` 自身の `foregroundNotificationConfig` で十分ですが、ユーザーがアプリをスワイプして閉じるとそれは止まります。再起動やシステムによる再起動の後にもトラッカーを復帰させる必要がある場合は、ユーザーが "常に許可" (`ACCESS_BACKGROUND_LOCATION`) を付与しなければなりません。そうしないと、サービスが `startForeground` を呼んだ瞬間に Android が `SecurityException` をスローします。

以下の内容はすべて Flutter 3.44.8 (デフォルトで `targetSdkVersion` 36)、`geolocator` 14.0.3 (`geolocator_android` 5.0.3)、`flutter_foreground_task` 11.0.3 でビルドし、Android 16 (API 36) のエミュレーターで実行しました。Android 16 はここで説明する Android 14 と Android 15 のフォアグラウンドサービスのルールをすべて適用します。また Google Play は 2026-08-31 以降の新規アプリとアップデートに `targetSdkVersion` 36 を要求するため、ユーザーの Android バージョンにかかわらず、アプリはこれらのルールのもとで動作します。

## Android 15 で実際に変わったこと、変わっていないこと

"Android 15 でトラッカーが止まる" という報告の多くは、Android 15 自体が原因ではありません。位置情報トラッカーを止めるルールはもっと古いものです。

- **Android 12 (API 31)** は、アプリがバックグラウンドにある間のフォアグラウンドサービスの開始を禁止しています。例外は[除外リスト](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)にあるもの (起動完了、通知のタップ、正確なアラームなど) だけです。
- **Android 14 (API 34)** は、すべてのフォアグラウンドサービスに[タイプ](https://developer.android.com/develop/background-work/services/fg-service-types)の宣言と対応する権限の保持を要求します。`location` の場合は `FOREGROUND_SERVICE_LOCATION` に加えて、サービスがフォアグラウンドに移行する時点で `ACCESS_COARSE_LOCATION` または `ACCESS_FINE_LOCATION` が付与されている必要があります。
- **While-in-use 権限**: 正確な位置情報とおおよその位置情報の権限は、アプリが表示されている間しか有効になりません。バックグラウンドから開始された `location` サービスは、開始そのものが許可された除外に該当する場合でも、アプリが `ACCESS_BACKGROUND_LOCATION` を持っていなければ失敗します。

[Android 15](https://developer.android.com/about/versions/15/behavior-changes-15) で追加されたのは、`dataSync` と `mediaProcessing` サービスに対する 1 日 6 時間の制限、`BOOT_COMPLETED` レシーバーから開始できなくなったタイプのリスト (`dataSync`、`camera`、`mediaPlayback`、`phoneCall`、`mediaProjection`、そして Android 14 からの `microphone`)、そしてより厳しくなった `SYSTEM_ALERT_WINDOW` の除外です。`location` はどちらのリストにも含まれていません。これが重要なのは、Flutter のトラッキングコードの多くが `dataSync` を宣言している `flutter_foreground_task` のサンプルをコピーしているからです。Android 15 では、そうしたトラッカーは 6 時間後に停止され、再起動後に復帰することもできなくなります。正しいタイプを宣言すれば、両方の問題が解決します。

## ウィジェット内のストリームが止まる理由

素朴なトラッカーは、`State` オブジェクト内の `StreamSubscription<Position>` です。そのコールバックは、`FlutterActivity` に属する Flutter エンジンの UI isolate で実行されます。Android がそのプロセスをアイドル状態と判断したり、ユーザーがアプリを履歴からスワイプしたりすると、そのエンジンは消え、Dart コードも一緒に消えます。もう存在しないエンジンでコードを動かし続けられるフォアグラウンド通知はありません。

`geolocator` には、このための中途半端な手段があります。`foregroundNotificationConfig` を含む `AndroidSettings` を渡すと、`geolocator_android` は自身の `GeolocatorLocationService` をフォアグラウンドサービスに昇格させます。

```dart
// Flutter 3.44.8, geolocator 14.0.3
final sub = Geolocator.getPositionStream(
  locationSettings: AndroidSettings(
    accuracy: LocationAccuracy.high,
    distanceFilter: 10,
    intervalDuration: const Duration(seconds: 5),
    foregroundNotificationConfig: const ForegroundNotificationConfig(
      notificationTitle: 'Recording trip',
      notificationText: 'Tracking in the background',
      enableWakeLock: true,
    ),
  ),
).listen((p) => debugPrint('GEO_ONLY ${p.latitude},${p.longitude}'));
```

プラグイン自身のマニフェストは、すでにこのサービスを `android:foregroundServiceType="location"` で宣言しています。しかし `GeolocatorPlugin` は `startService` ではなく `bindService` でサービスに接続し、エンジンがデタッチされるとバインドを解除します。プラグインのドキュメントコメントにもそう書かれていて、この通知は "does not run your service in the background" とあります。API 36 のエミュレーターで計測した結果です。

| シナリオ | `foregroundNotificationConfig` 付きの `geolocator` | `flutter_foreground_task` のサービス + その中の `geolocator` |
| --- | --- | --- |
| アプリが表示中 | 位置情報が届く | 位置情報が届く |
| ホームボタンを押した | 位置情報が届く、FGS タイプ `0x8` | 位置情報が届く、FGS タイプ `0x8` |
| 履歴からスワイプした | サービスが破棄され、位置情報が届かなくなる | 同じプロセスが動き続け、位置情報が届く |
| 再起動、while-in-use のみ | 該当なし | `startForeground` で `SecurityException` |
| 再起動、"常に許可" | 該当なし | サービスが再開され、位置情報が届く |

スワイプの後、geolocator だけのログは "Unbinding from location service" と "Destroying location service" で終わっていました。もう一方のビルドでは、サービスのエンジンが接続されたまま ("There is still another flutter engine connected, not stopping location service") で、通知は新しい座標で更新され続けました。

つまり `foregroundNotificationConfig` が適しているのは、"バックグラウンド" が "ランニング中にユーザーがしばらく別のアプリに切り替えた" という意味の場合です。ユーザーが停止ボタンを押すまで動き続けなければならない走行記録アプリ、配達トラッカー、フィットネスアプリでは、位置情報の更新は独自のエンジンを持つサービスの中で動かす必要があります。

## 別のサービスエンジンでトラッカーを構築する

`flutter_foreground_task` は、(単にバインドされるだけでなく) 実際に開始されるフォアグラウンドサービスを起動し、その中で 2 つ目の Flutter エンジンを立ち上げ、そこでトップレベルの Dart エントリーポイントを呼び出します。そのエンジンからは `geolocator` を含む任意のプラグインを実行できます。手順は次のとおりです。

1. パッケージを追加します。

   ```yaml
   # pubspec.yaml -- Flutter 3.44.8
   dependencies:
     geolocator: ^14.0.3
     flutter_foreground_task: ^11.0.3
   ```

   `flutter_foreground_task` 11.x には Flutter 3.44+、Kotlin 2.2.20+、Gradle 8.11.1+ が必要です。Flutter 3.44.8 で作成したプロジェクトは、すでに AGP 9.0.1、Kotlin 2.3.20、Gradle 9.1.0 を使っています。プロジェクトがそれより古い場合は、先に[Flutter の Android プロジェクトを組み込み Kotlin 付きの AGP 9 に移行する方法](/ja/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/)を参照してください。

2. `android/app/src/main/AndroidManifest.xml` で権限とサービスを宣言します。

   ```xml
   <!-- targetSdkVersion 36, flutter_foreground_task 11.0.3 -->
   <manifest xmlns:android="http://schemas.android.com/apk/res/android">
       <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
       <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
       <!-- Only if the tracker must restart after boot or a system kill -->
       <uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />
       <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
       <uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />
       <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />

       <application ...>
           <!-- ... your activity ... -->
           <service
               android:name="com.pravera.flutter_foreground_task.service.ForegroundService"
               android:foregroundServiceType="location"
               android:exported="false" />
       </application>
   </manifest>
   ```

   サービスの名前は変更しないでください。プラグインはこのクラス名でサービスを開始します。`FOREGROUND_SERVICE`、`WAKE_LOCK`、`RECEIVE_BOOT_COMPLETED`、`POST_NOTIFICATIONS` はプラグイン自身のマニフェストからも取り込まれます。`FOREGROUND_SERVICE_LOCATION` はどちらのプラグインからも取り込まれないため、自分で追加する必要があります。ビルドした APK に対して `aapt2 dump xmltree` を実行すると、プラグインのものと geolocator のものの両方のサービスが `foregroundServiceType=0x00000008` (location) で表示されます。

3. サービスエンジンで動くタスクハンドラーを書きます。

   ```dart
   // lib/location_task.dart -- Flutter 3.44.8, geolocator 14.0.3, flutter_foreground_task 11.0.3
   import 'dart:async';

   import 'package:flutter_foreground_task/flutter_foreground_task.dart';
   import 'package:geolocator/geolocator.dart';

   // Runs in the service's own Flutter engine, not in the UI isolate.
   @pragma('vm:entry-point')
   void startLocationTask() {
     FlutterForegroundTask.setTaskHandler(LocationTaskHandler());
   }

   // Shared by the UI (settings check) and the service (tracking).
   AndroidSettings trackingSettings() => AndroidSettings(
     accuracy: LocationAccuracy.high,
     distanceFilter: 10,
     intervalDuration: const Duration(seconds: 5),
     // No foregroundNotificationConfig: the flutter_foreground_task service
     // already is the location foreground service.
   );

   class LocationTaskHandler extends TaskHandler {
     StreamSubscription<Position>? _sub;

     @override
     Future<void> onStart(DateTime timestamp, TaskStarter starter) async {
       _sub = Geolocator.getPositionStream(locationSettings: trackingSettings())
           .listen(
             (p) {
               FlutterForegroundTask.updateService(
                 notificationText:
                     '${p.latitude.toStringAsFixed(5)}, ${p.longitude.toStringAsFixed(5)}',
               );
               FlutterForegroundTask.sendDataToMain(<String, Object>{
                 'lat': p.latitude,
                 'lng': p.longitude,
                 'ts': p.timestamp.millisecondsSinceEpoch,
               });
             },
             onError: (Object e) =>
                 FlutterForegroundTask.sendDataToMain('error: $e'),
           );
     }

     @override
     void onRepeatEvent(DateTime timestamp) {}

     @override
     Future<void> onDestroy(DateTime timestamp, bool isTimeout) async {
       await _sub?.cancel();
     }
   }
   ```

   `@pragma('vm:entry-point')` は省略できません。これがないと、リリースビルドでは、ネイティブコードからしか呼ばれない関数がツリーシェーカーによって削除されてしまいます。位置情報は `sendDataToMain` に頼らず、ここで永続化してください (SQLite、ファイル、または HTTP のバッチ送信など)。スワイプや再起動の後には、リッスンしている UI isolate が存在しないからです。[dispose で StreamSubscription をキャンセルする方法](/ja/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/)で説明しているのと同じ理由で、`onDestroy` でサブスクリプションをキャンセルします。

4. 権限を要求し、位置情報の設定を解決してから、UI からサービスを開始します。

   ```dart
   // lib/main.dart (excerpt) -- Flutter 3.44.8, geolocator 14.0.3, flutter_foreground_task 11.0.3
   void main() {
     FlutterForegroundTask.initCommunicationPort();
     runApp(const MaterialApp(home: TrackerPage()));
   }

   // In the State's initState:
   FlutterForegroundTask.init(
     androidNotificationOptions: AndroidNotificationOptions(
       channelId: 'tracking',
       channelName: 'Trip tracking',
       channelDescription: 'Shown while a trip is being recorded.',
       onlyAlertOnce: true,
     ),
     iosNotificationOptions: const IOSNotificationOptions(),
     foregroundTaskOptions: ForegroundTaskOptions(
       eventAction: ForegroundTaskEventAction.nothing(),
       autoRunOnBoot: true,
       allowWakeLock: true,
     ),
   );

   Future<bool> _ensurePermissions() async {
     if (!await Geolocator.isLocationServiceEnabled()) return false;

     var perm = await Geolocator.checkPermission();
     if (perm == LocationPermission.denied) {
       perm = await Geolocator.requestPermission();
     }
     if (perm == LocationPermission.denied ||
         perm == LocationPermission.deniedForever) {
       return false;
     }

     // Resolve the "improve location accuracy" prompt here, while there is an
     // Activity. The service engine has none, so geolocator would report
     // "location service disabled" instead of showing the dialog.
     try {
       await Geolocator.getCurrentPosition(
         locationSettings: trackingSettings(),
       ).timeout(const Duration(seconds: 20));
     } on TimeoutException {
       // A slow first fix is fine; the settings check already ran.
     } on LocationServiceDisabledException {
       return false;
     }

     if (await FlutterForegroundTask.checkNotificationPermission() !=
         NotificationPermission.granted) {
       await FlutterForegroundTask.requestNotificationPermission();
     }
     return true;
   }

   Future<void> _start() async {
     if (!await _ensurePermissions()) return;
     // Called from a button tap: the activity is visible, so the
     // while-in-use location permission counts.
     final result = await FlutterForegroundTask.isRunningService
         ? await FlutterForegroundTask.restartService()
         : await FlutterForegroundTask.startService(
             serviceId: 4242,
             serviceTypes: [ForegroundServiceTypes.location],
             notificationTitle: 'Recording trip',
             notificationText: 'Waiting for GPS fix',
             callback: startLocationTask,
           );
     if (result is ServiceRequestFailure) {
       debugPrint('start failed: ${result.error}');
     }
   }
   ```

   `serviceTypes: [ForegroundServiceTypes.location]` は明示的に渡してください。これがないと、プラグインは `FOREGROUND_SERVICE_TYPE_MANIFEST` で `startForeground` を呼び出します。これはマニフェストの属性にあるすべてのタイプを意味するため、そこに紛れ込んだ `dataSync` があると Android 15 の時間制限が適用されてしまいます。システムの戻るボタンでアクティビティを閉じずにアプリを最小化したい場合は、`Scaffold` を `WithForegroundTask` で囲みます。

5. "常に許可" が必要かどうかを判断します。ユーザーが走行記録を続けている間だけトラッキングが動けばよいなら、ここで終わりです。正確な位置情報の権限と、表示中のアクティビティから開始したサービスがあれば十分で、私のテストではホームボタンとスワイプの両方を乗り越えました。再起動後 (`autoRunOnBoot`)、アプリのアップデート後、またはシステムがプロセスを停止した後に自動で復帰する必要がある場合は、バックグラウンドの位置情報を別の 2 段階目のステップとして要求します。正確な位置情報が付与された後に `Geolocator.requestPermission()` をもう一度呼ぶと、`ACCESS_BACKGROUND_LOCATION` が要求されます。マニフェストでこれが宣言されていて現在のステータスが `whileInUse` の場合、`geolocator_android` がリクエストに追加するからです。Android 11+ ではダイアログを表示する代わりにユーザーをシステムの設定画面に移動させるので、呼び出す前に理由を説明してください。

## バックグラウンドの位置情報なしで発生する SecurityException

これは、while-in-use の位置情報だけを付与し、`targetSdkVersion` 36、API 36 のエミュレーターで行った再起動テストのログです。

```text
I ActivityManager: Background started FGS: Allowed [callingPackage: net.startdebugging.tracker; ... code:BOOT_COMPLETED; ... allowWiu:-1; targetSdkVersion:36 ...]
W ActivityManager: Foreground service started from background can not have location/camera/microphone access: service net.startdebugging.tracker/com.pravera.flutter_foreground_task.service.ForegroundService
E ForegroundService: java.lang.SecurityException: Starting FGS with type location callerApp=ProcessRecord{b79ac40 3076:net.startdebugging.tracker/u0a214} targetSDK=36 requires permissions: all of the permissions allOf=true [android.permission.FOREGROUND_SERVICE_LOCATION] any of the permissions allOf=false [android.permission.ACCESS_COARSE_LOCATION, android.permission.ACCESS_FINE_LOCATION]  and the app must be in the eligible state/exemptions to access the foreground only permission
E ForegroundService: 	at android.app.Service.startForeground(Service.java:863)
E ForegroundService: 	at com.pravera.flutter_foreground_task.service.ForegroundService.startForegroundService(ForegroundService.kt:283)
```

このログは 2 つに分けて読みます。最初の行は、*開始* が許可されたことを示しています。`BOOT_COMPLETED` はバックグラウンド開始の除外に該当し、Android 15 は起動時の `location` をブロックしません。残りの部分は、*位置情報へのアクセス* が許可されなかったことを示しています。`allowWiu:-1` は while-in-use の除外が適用されなかったことを意味するので、正確な位置情報の権限は有効にならず、`startForeground` が例外をスローしました。`pm grant ... ACCESS_BACKGROUND_LOCATION` を実行してもう一度再起動すると、同じレシーバーがサービスを開始し、`geolocator` が "position updates started" をログに出力し、通知に新しい座標が表示されました。

このメッセージには誤解を招く点が 1 つあります。すべて付与されている場合でも、`FOREGROUND_SERVICE_LOCATION` と正確/おおよその位置情報の権限を列挙するのです。このメッセージを見たら、マニフェストを確認する前に、サービスが *どこから* 開始されたかを確認してください。`FOREGROUND_SERVICE_LOCATION` が本当に欠けている場合も、まったく同じテキストが出力されます。この場合はフォアグラウンドでのボタンのタップからでも出力されます。

## 時間を取られた落とし穴

**サービスエンジンには Activity がありません。** `geolocator` の fused クライアントは、まず `SettingsClient.checkLocationSettings` を呼び出します。Google の "位置情報の精度" の設定がオフの場合、この呼び出しには解決用のダイアログが必要で、Activity がないと `geolocator_android` は代わりに `locationServicesDisabled` を報告します。私の最初の実行では、位置情報がオンなのに、タスクハンドラーは "The location service on the device is disabled." を受け取りました。サービスを開始する前に、UI から同じ設定で `getCurrentPosition` を実行すると、ダイアログが一度表示されます。ユーザーがそれを承諾すれば、サービス内でもチェックが通ります。その設定に依存したくない場合は、`forceLocationManager: true` で Play services を完全に回避できます。

**サービスがクラッシュループしていても、`startService` が成功を報告することがあります。** `FOREGROUND_SERVICE_LOCATION` を削除した状態で、`FlutterForegroundTask.startService` は `ServiceRequestFailure` を返しませんでした。プラグインは `onStartCommand` 内で `SecurityException` をキャッチしてサービスを停止し、その後 `allowAutoRestart` のロジック ("The service will be restarted after 5 seconds because it wasn't properly stopped.") が次の試行をスケジュールします。その結果、約 25 秒で同じ例外が 8 回発生しました。マニフェストを新しくするたびに、最初の開始の後で `adb logcat | grep ForegroundService` を確認してください。

**開始は表示中の UI か、許可されたトリガーからだけにしてください。** アプリ内のタップ、通知のアクション、ウィジェットなら動作します。ユーザーがアプリを離れた後に発火する `Timer`、FCM のデータメッセージ、`WorkManager` のジョブでは、アプリがバックグラウンドの位置情報を持っていない限り `location` サービスは開始できません。さらに、開始そのものにも Android 12 の除外のいずれかが必要です。

**OEM のタスクキラーは別の問題です。** Pixel やエミュレーターでは、通知が表示されている `location` フォアグラウンドサービスは無期限に動き続けます。一部の OEM のビルドでは、それでも停止されます。`FlutterForegroundTask.requestIgnoreBatteryOptimization()` は一部の端末で効果があり、それ自体がバックグラウンド開始の除外の 1 つでもあります。すべてのユーザーにこれを求めるのは Play のポリシーの問題になるので、トラッカーの中核的な目的がこれに依存する場合にだけ要求してください。

**通知は非表示にできますが、サービスは動き続けます。** Android 13+ では、`POST_NOTIFICATIONS` が拒否されると通知シェードから通知が消えます。それでもサービスは開始され、タスクマネージャーにも表示されます。それでも権限は要求してください。通知が見えないユーザーには、バッテリーが減る理由がわからないからです。

**Play Console では 2 つの申告が必要です。** Android 14+ をターゲットとするアプリは、各フォアグラウンドサービスのタイプを説明と動画付きで Play Console で申告しなければなりません。`ACCESS_BACKGROUND_LOCATION` にはさらに、権限の申告フォーム、アプリ内での目立つ開示、プライバシーポリシーが必要です。Google の[バックグラウンドの位置情報に関するガイダンス](https://support.google.com/googleplay/android-developer/answer/9799150)は、可能な限りフォアグラウンドでのアクセスを優先するよう求めています。これも、自動での再開が本当に必要な場合にだけステップ 5 を出荷すべき理由の 1 つです。

**iOS はまったく別のモデルです。** iOS での `flutter_foreground_task` は、15 分ごとに約 30 秒動く `BGTaskScheduler` のフェッチです。継続的なトラッキングではありません。iOS で継続的なトラッキングを行うには、`UIBackgroundModes` の `location` に加えて、`geolocator` で `AppleSettings(allowBackgroundLocationUpdates: true, showBackgroundLocationIndicator: true)` を使います。2 つのプラットフォームは別々のコードパスに分けておいてください。

## 関連記事

- プラグインを使わずに Kotlin で自分でサービスを書くことになった場合は、[プラグインなしで Flutter にプラットフォーム固有のコードを追加する方法](/ja/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/)でチャネルの配線を解説しています。
- SDK 35 以上をターゲットにすると、サービス以外にも変化があります。[SDK 35 をターゲットにした後に Flutter の UI が Android のナビゲーションバーと重なる問題の修正](/ja/2026/08/fix-flutter-ui-overlaps-the-android-navigation-bar-after-targeting-sdk-35/)を参照してください。
- 定期的で継続的でないバックグラウンド処理には、[background_fetch の minSdkVersion の修正](/ja/2026/05/fix-flutter-background-fetch-requires-minsdkversion-21/)が良い出発点になります。

## 出典

- Android Developers: [フォアグラウンドサービスのタイプ](https://developer.android.com/develop/background-work/services/fg-service-types) (location タイプ、while-in-use に関する注記)
- Android Developers: [バックグラウンドからのフォアグラウンドサービスの開始に関する制限](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)
- Android Developers: [Android 15 の動作の変更点](https://developer.android.com/about/versions/15/behavior-changes-15) (FGS の強化、`BOOT_COMPLETED` のリスト、`dataSync` のタイムアウト)
- Play Console ヘルプ: [フォアグラウンドサービスの要件](https://support.google.com/googleplay/android-developer/answer/13392821)と[対象 API レベルの要件](https://support.google.com/googleplay/android-developer/answer/11926878)
- [`geolocator` 14.0.3](https://pub.dev/packages/geolocator) と [`geolocator_android` 5.0.3 のソース](https://github.com/baseflow/flutter-geolocator/tree/main/geolocator_android) (`GeolocatorLocationService`、`StreamHandlerImpl`、`FusedLocationClient`)
- [`flutter_foreground_task` 11.0.3](https://pub.dev/packages/flutter_foreground_task) (`ForegroundService.kt`、`RebootReceiver.kt`)
