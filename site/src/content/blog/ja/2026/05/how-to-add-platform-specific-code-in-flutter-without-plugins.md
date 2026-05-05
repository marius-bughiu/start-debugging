---
title: "プラグインなしで Flutter にプラットフォーム固有コードを追加する方法"
description: "プラグインを書かずに Flutter 3.x アプリから Android (Kotlin) と iOS (Swift) のネイティブコードを呼び出します。MethodChannel、EventChannel、BasicMessageChannel、StandardMessageCodec の型対応表、スレッドのルール、それでもプラグインに分があるケースまで解説します。"
pubDate: 2026-05-05
template: how-to
tags:
  - "flutter"
  - "dart"
  - "android"
  - "ios"
  - "platform-channels"
  - "how-to"
lang: "ja"
translationOf: "2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins"
translatedBy: "claude"
translationDate: 2026-05-05
---

短く言うと、`main.dart` に `MethodChannel` を置き、Android の `FlutterActivity` と iOS の `AppDelegate` で同じチャネル名を登録して、`await channel.invokeMethod(...)` で呼び出します。ネイティブから Dart へのストリーム (センサー、ブロードキャスト) には `EventChannel` を、生のバイトや文字列には `BasicMessageChannel` を使います。連合プラグインが必要になるのは、複数のアプリで連携を再利用したい場合や pub.dev に公開したい場合だけです。Flutter 3.27.1、Android Gradle Plugin 8.7.3、Xcode 16.2 (Swift 5.10) で検証済みです。

「プラットフォーム固有コード」という表現は Flutter のドキュメントでは通常ひとつのことを指します。Dart とネイティブの境界をまたぐ method channel です。この橋はプラグインの有無に関わらず、すべての Flutter アプリにすでに存在します。プラグインとは、Dart のファサードと、2 つの `Podfile` / Gradle ファイルへのビルド時登録を加えてチャネルをパッケージ化したものにすぎません。連携が 1 つのアプリでしか必要ないなら、パッケージ化はオーバーヘッドです。本記事ではそれをスキップしつつ、コードのメンテナンス性を保つ方法を示します。

## なぜプラグインの足場をスキップするのか

`flutter create --template plugin` は連合プラグインを生成します。`my_plugin`、`my_plugin_android`、`my_plugin_ios`、`my_plugin_platform_interface`、それにサンプルアプリです。これは複数アプリで連携を共有する場合や公開を意図する場合には正しい形ですが、1 つのアプリ向けには次のコストがかかります。

- 追加で 6 個の `pubspec.yaml`、ワンショット CI を望むなら `melos.yaml`。
- メソッドごとに 1 段の間接呼び出しを増やすプラットフォームインターフェース。
- アプリコードが新しいネイティブメソッドを呼び出したくなるたびにバンプする独立したパッケージバージョン。
- 実アプリと乖離していく 2 つ目のテスト基盤 (プラグインの `example/` アプリ)。

単一アプリのコードベースなら、チャネルはそれを使う機能の隣に置けます。フラッシュライトの状態を切り替えるボタンと、チャネルをラップする `FlashlightService` は、Dart で 20 行、Kotlin / Swift で 20 行ずつです。

## 本当に必要な 3 つのチャネル

Flutter は `package:flutter/services.dart` に 3 種類のチャネルを用意しています。機能ではなく呼び出しの形で選びます。

- `MethodChannel`: リクエスト / レスポンス。Dart がネイティブ側の名前付きメソッドを呼び、結果を待ち、ネイティブ側は型付きエラーを投げられます。「ファイルピッカーを開く」「デバイスのモデルを取得」「200 ms バイブレーション」などに使います。
- `EventChannel`: ネイティブから Dart へのプッシュ ストリーム。ネイティブ側で `StreamSink` を開き、Dart が購読してリッスンします。センサー、システムのブロードキャストレシーバー (充電状態、ネットワーク変化) など、OS がコールバックを返してくる用途に使います。
- `BasicMessageChannel`: 自分が選んだコーデック (`StandardMessageCodec`、`JSONMessageCodec`、`StringCodec`、`BinaryCodec`) を使う、生で型なしのメッセージ。両端を自分で握っていてメソッド名のオーバーヘッドを避けたいときや、バイト列 (オーディオフレーム、画像バッファ) を送るときに使います。

3 つとも Dart 側では非同期です。3 つともペイロードを `MessageCodec` でシリアライズします。デフォルトのコーデックは `StandardMessageCodec` で、固定された小さな型集合を扱えます。ペイロードがその集合に収まらない場合は自分でシリアライズします。

## StandardMessageCodec の型対応表

チャネルのコードを書く間は、この表を開いておくとよいでしょう。範囲外のものはプラットフォームに応じて `null` で返るか例外が投げられます。

| Dart                                | Android (Java/Kotlin)               | iOS (Swift)                                  |
| ----------------------------------- | ----------------------------------- | -------------------------------------------- |
| `null`                              | `null`                              | `nil` / `NSNull`                             |
| `bool`                              | `Boolean`                           | `Bool` / `NSNumber(value: Bool)`             |
| `int` (32 or 64 bit)                | `Integer` / `Long`                  | `Int32` / `Int64` / `NSNumber`               |
| `double`                            | `Double`                            | `Double` / `NSNumber(value: Double)`         |
| `String`                            | `String`                            | `String`                                     |
| `Uint8List`                         | `byte[]`                            | `FlutterStandardTypedData(bytes:)`           |
| `Int32List` / `Int64List` / `Float64List` | `int[]` / `long[]` / `double[]` | `FlutterStandardTypedData(int32:)` etc.      |
| `List<dynamic>`                     | `List<Object?>`                     | `[Any?]`                                     |
| `Map<dynamic, dynamic>`             | `Map<Object?, Object?>`             | `[AnyHashable: Any?]`                        |

`DateTime`、独自クラス、`BigInt` はリストにありません。境界で `int` (epoch ms)、`Map`、`String` に変換してください。

## MethodChannel の完全な例: バッテリーレベル

これは Flutter の典型的なサンプルを、実際に出荷するファイル構成まで広げたものです。

### 1. Dart 側 (`lib/services/battery_service.dart`)

```dart
// Flutter 3.27.1, Dart 3.6
import 'package:flutter/services.dart';

class BatteryUnavailable implements Exception {
  final String message;
  BatteryUnavailable(this.message);
  @override
  String toString() => 'BatteryUnavailable: $message';
}

class BatteryService {
  static const _channel = MethodChannel('com.example.app/battery');

  Future<int> getBatteryLevel() async {
    try {
      final level = await _channel.invokeMethod<int>('getBatteryLevel');
      if (level == null) throw BatteryUnavailable('null result');
      return level;
    } on PlatformException catch (e) {
      throw BatteryUnavailable(e.message ?? e.code);
    } on MissingPluginException {
      throw BatteryUnavailable('handler not registered on this platform');
    }
  }
}
```

注目すべき点が 3 つあります。1 つ目はチャネル名で、逆引き DNS に機能名のサフィックスを付ける形にしています。これは Flutter のすべてのプラグインが従う慣例で、将来パッケージと衝突するのを防げます。2 つ目は `invokeMethod<int>` がジェネリックで、コーデックが何を返すべきかをコンパイル時のシグナルとして得られることです。3 つ目は `MissingPluginException` で、これは実行中のプラットフォームでチャネル名が登録されていないときに投げられます。これをキャッチして妥当なエラーに変換しないと、ユーザーには `package:flutter` のスタックトレースが届いてしまいます。

### 2. Android 側 (`android/app/src/main/kotlin/.../MainActivity.kt`)

```kotlin
// AGP 8.7.3, Kotlin 2.0, Flutter 3.27.1
package com.example.app

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private val channelName = "com.example.app/battery"

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "getBatteryLevel" -> {
                        val level = readBatteryLevel()
                        if (level >= 0) result.success(level)
                        else result.error("UNAVAILABLE", "Battery level not available", null)
                    }
                    else -> result.notImplemented()
                }
            }
    }

    private fun readBatteryLevel(): Int {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            val bm = getSystemService(Context.BATTERY_SERVICE) as BatteryManager
            bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        } else {
            val intent = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            val l = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
            val s = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
            if (l >= 0 && s > 0) (l * 100) / s else -1
        }
    }
}
```

`configureFlutterEngine` はエンジンごとに 1 回呼ばれ、アクティビティの再生成のたびには呼ばれません。そのためここがハンドラーを配線する安全な場所です。`MainActivity` が `FlutterFragmentActivity` を継承している場合、`onCreate` の中でチャネルを登録すると構成変更のたびにハンドラーがリークします。

### 3. iOS 側 (`ios/Runner/AppDelegate.swift`)

```swift
// Xcode 16.2, Swift 5.10, iOS 13+ deployment target, Flutter 3.27.1
import UIKit
import Flutter

@main
@objc class AppDelegate: FlutterAppDelegate {
    override func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        let controller = window?.rootViewController as! FlutterViewController
        let channel = FlutterMethodChannel(
            name: "com.example.app/battery",
            binaryMessenger: controller.binaryMessenger
        )

        channel.setMethodCallHandler { [weak self] call, result in
            guard call.method == "getBatteryLevel" else {
                result(FlutterMethodNotImplemented)
                return
            }
            self?.readBatteryLevel(result: result)
        }

        GeneratedPluginRegistrant.register(with: self)
        return super.application(application, didFinishLaunchingWithOptions: launchOptions)
    }

    private func readBatteryLevel(result: FlutterResult) {
        let device = UIDevice.current
        device.isBatteryMonitoringEnabled = true
        if device.batteryState == .unknown {
            result(FlutterError(code: "UNAVAILABLE", message: "Battery info unavailable", details: nil))
        } else {
            result(Int(device.batteryLevel * 100))
        }
    }
}
```

プラットフォーム固有の注意点が 3 つあります。1 つ目は `batteryLevel` を読む前に `isBatteryMonitoringEnabled` を `true` にしておく必要があり、そうでないと `-1.0` が返ります。2 つ目は `FlutterError` が iOS 側で Android の `result.error(...)` に対応するもので、Dart には `PlatformException` として届きます。3 つ目は、自分でプラグインを書いていなくても `GeneratedPluginRegistrant.register(with: self)` は残しておく点で、ビルドは依然として `pubspec.yaml` 内の任意の推移的プラグイン用にレジストラントを生成します。

## ストリームには EventChannel

`MethodChannel` は「バッテリー状態が変わったら教えて」には向きません。ポーリング実装になってしまいます。`EventChannel` ならネイティブ側からプッシュできます。

### Dart の購読側

```dart
// Flutter 3.27.1
import 'package:flutter/services.dart';

class BatteryStateService {
  static const _events = EventChannel('com.example.app/battery_state');

  Stream<String> watch() => _events
      .receiveBroadcastStream()
      .map((dynamic event) => event as String);
}
```

`receiveBroadcastStream()` はすべてのリスナーで共有される単一のブロードキャストストリームを返します。最後の購読をキャンセルするとネイティブ側にブロードキャストレシーバーやオブザーバーを片付けるよう伝わるので、使わない購読への参照を保持しないでください。

### Android のハンドラー

```kotlin
// AGP 8.7.3, Kotlin 2.0
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import io.flutter.plugin.common.EventChannel

class BatteryStateStreamHandler(private val context: Context) : EventChannel.StreamHandler {
    private var receiver: BroadcastReceiver? = null

    override fun onListen(arguments: Any?, events: EventChannel.EventSink) {
        receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
                val charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
                               status == BatteryManager.BATTERY_STATUS_FULL
                events.success(if (charging) "charging" else "discharging")
            }
        }
        context.registerReceiver(receiver, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
    }

    override fun onCancel(arguments: Any?) {
        if (receiver != null) {
            context.unregisterReceiver(receiver)
            receiver = null
        }
    }
}
```

`configureFlutterEngine` の中で配線します。

```kotlin
EventChannel(flutterEngine.dartExecutor.binaryMessenger, "com.example.app/battery_state")
    .setStreamHandler(BatteryStateStreamHandler(applicationContext))
```

アクティビティではなく `applicationContext` を使います。そうしないとブロードキャストレシーバーの寿命の間ずっとアクティビティをリークします。

### iOS のハンドラー

```swift
// Swift 5.10
import Flutter
import UIKit

class BatteryStateStreamHandler: NSObject, FlutterStreamHandler {
    private var sink: FlutterEventSink?

    func onListen(withArguments arguments: Any?, eventSink events: @escaping FlutterEventSink) -> FlutterError? {
        sink = events
        UIDevice.current.isBatteryMonitoringEnabled = true
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(stateChanged),
            name: UIDevice.batteryStateDidChangeNotification,
            object: nil
        )
        stateChanged()
        return nil
    }

    func onCancel(withArguments arguments: Any?) -> FlutterError? {
        NotificationCenter.default.removeObserver(self)
        sink = nil
        return nil
    }

    @objc private func stateChanged() {
        let s = UIDevice.current.batteryState
        sink?(s == .charging || s == .full ? "charging" : "discharging")
    }
}
```

そして `AppDelegate` で次のように書きます。

```swift
let stateChannel = FlutterEventChannel(
    name: "com.example.app/battery_state",
    binaryMessenger: controller.binaryMessenger
)
stateChannel.setStreamHandler(BatteryStateStreamHandler())
```

`onListen` で初期値を送出してください。そうしないと最初の `await for (final s in service.watch())` が OS からの最初のブロードキャストを待って止まってしまいます。

## 生のペイロードには BasicMessageChannel

`BasicMessageChannel` はメソッド名のディスパッチャーをスキップし、与えたコーデックを使います。両端が自分の管理下にあり、ペイロードが均一なときに便利です。

```dart
// Flutter 3.27.1
import 'package:flutter/services.dart';

final _logChannel = BasicMessageChannel<String>(
  'com.example.app/log',
  StringCodec(),
);

Future<void> sendLog(String line) => _logChannel.send(line) as Future<void>;
```

```kotlin
// AGP 8.7.3, Kotlin 2.0
import io.flutter.plugin.common.BasicMessageChannel
import io.flutter.plugin.common.StringCodec

BasicMessageChannel(flutterEngine.dartExecutor.binaryMessenger, "com.example.app/log", StringCodec.INSTANCE)
    .setMessageHandler { message, reply ->
        android.util.Log.i("flutter", message ?: "")
        reply.reply(null)
    }
```

バイナリペイロードでは両側で `BinaryCodec` を使い、Dart では `ByteData`、Kotlin では `ByteBuffer`、Swift では `FlutterStandardTypedData` を受け取ります。

## スレッドモデルとハマりどころ

チャネル自体は非同期ですが、ハンドラーのコールバックはバックグラウンドスレッドではなくプラットフォームスレッドで動きます。

- **Android**: ハンドラーは Android のメインスレッドで動きます。長い処理は UI スレッドをブロックし、ANR を引き起こします。処理はコルーチンや `Executors.newSingleThreadExecutor()` に逃がし、その後メインスレッドに戻して `result.success(...)` を呼びます (`Handler(Looper.getMainLooper()).post { ... }`)。
- **iOS**: ハンドラーはメインの `DispatchQueue` で動きます。同じルールで、処理はバックグラウンドキューで行い、`result(...)` 呼び出しはメインへ dispatch します。
- **バックグラウンド isolate**: `MethodChannel` は歴史的にルート isolate を必要としていました。Flutter 3.7 以降は、バックグラウンド isolate からも `BackgroundIsolateBinaryMessenger.ensureInitialized(token)` を使ってカスタムの `binaryMessenger` を渡せますが、自分で生成したチャネルに限り、また isolate ローカルな状態をキャプチャしないコーデックに限ります。
- **ホットリスタート**: ホットリスタートは `main()` を再実行しますが、`configureFlutterEngine` は再実行しません。`configureFlutterEngine` で登録したハンドラーはホットリスタートを越えて生き残り、これが望ましい挙動です。Flutter ウィジェットの `initState` で登録したハンドラーは生き残らず、エンジンが直前の登録を保持しているため、ハンドラーが 2 つ並ぶ羽目になります。

「ハンドラー 2 つ」の罠は、ホットリロード後の `MissingPluginException` の最大の原因です。誰かがウィジェットからハンドラーを登録し、そのウィジェットが再構築され、古いハンドラーが残ったまま、新しいハンドラーがチャネルを取り合うのです。チャネルは `MainActivity.configureFlutterEngine` か `AppDelegate.application(_:didFinishLaunchingWithOptions:)` のどちらかで、ちょうど 1 回だけ登録してください。

## 実務でのエラー、型、コーデック

3 つのルールでチャネルのコードは退屈に保てます。

1. **Dart 側は常に型指定する**: `invokeMethod<int>`、`invokeMethod<String>`、`invokeMethod<Map<Object?, Object?>>`。コーデックは実行時には動的なので、静的検査を効かせるのが目的です。
2. **ネイティブからは常に `result.error(code, message, details)` を送る**: `code` は `PlatformException.code` になり、Dart コードはそれで switch します。ハンドラーの中から throw しないでください。`MethodChannel` は Kotlin の例外を、ラップしない限り `PlatformException` には変換しません。
3. **境界で変換する**: 混合型の `Map<String, Object>` を送りつけて反対側でパースするのは避けてください。小さな DTO (`{level: int, charging: bool}`) を定義し、各側に `fromMap` コンストラクターを書きます。DTO がフィールド 4 個を超えて育ったら、marshalling 生成に [Pigeon](https://pub.dev/packages/pigeon) を使ってください。チャネル自体は引き続き自分のものです。

## それでもプラグインに分があるとき

次のいずれかが当てはまるまでは、プラグインを後回しにしましょう。

- pub.dev に公開したい。プラグインはプラットフォームインターフェースに堅い契約があります。
- 同じ連携を 3 つ以上のアプリで必要としている。3 つ目のコピーになるあたりで、プライベートパッケージのコストがチャネル同期のコストを下回ります。
- `web`、`windows`、`linux` 向けの条件付きインポートが必要で、Dart コードが存在しないネイティブ側を呼ばないようにしたい。連合プラグインのパターンは空のデフォルト実装でこれを処理します。1 つのアプリでは、スタブクラスで同じ考え方を手動で再現します。
- 複数のチャネルを登録し、遅延アタッチさせたい。`FlutterPlugin.onAttachedToEngine` がサポートされたライフサイクルフックです。自前で書くと、Android でアクティビティの attach / detach を扱い始めた途端に間違えやすくなります。

ロングテール (1 つのチャネル、1 つのアプリ、1 組のプラットフォーム) では、上記のインライン方式が、実際の Flutter コードベースで採られている形です。

## 関連記事

- [MissingPluginException 'No implementation found for method getAll' の修正](/ja/2023/10/how-to-fix-missingpluginexception-no-implementation-found-for-method-getall/) では、登録済みのチャネルがリリースビルドで投げてしまうケース (ProGuard、プラグイン登録、ホットリスタート) の対応を扱っています。
- マルチバージョンの CI でチャネルコードを複数の Flutter SDK に通すなら、[1 本の CI パイプラインから複数の Flutter バージョンを対象にする方法](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) を参照してください。
- プラットフォーム側のコードが .NET 側で、連携が Flutter ではなく MAUI なら、[Windows と macOS のみを対象にする MAUI ガイド](/ja/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) がターゲットフレームワークでのゲーティングという同等の方式を示しています。

## ソース

- Flutter ドキュメント、[Writing custom platform-specific code](https://docs.flutter.dev/platform-integration/platform-channels)。
- Flutter API リファレンス、[MethodChannel](https://api.flutter.dev/flutter/services/MethodChannel-class.html)、[EventChannel](https://api.flutter.dev/flutter/services/EventChannel-class.html)、[BasicMessageChannel](https://api.flutter.dev/flutter/services/BasicMessageChannel-class.html)。
- Flutter API リファレンス、[StandardMessageCodec](https://api.flutter.dev/flutter/services/StandardMessageCodec-class.html) のサポート型一覧。
- Android ドキュメント、[BatteryManager](https://developer.android.com/reference/android/os/BatteryManager)。
- Apple ドキュメント、[UIDevice batteryLevel](https://developer.apple.com/documentation/uikit/uidevice/1620042-batterylevel)。
- Flutter のバックグラウンド isolate チャネル、[BackgroundIsolateBinaryMessenger](https://api.flutter.dev/flutter/services/BackgroundIsolateBinaryMessenger-class.html) (Flutter 3.7+)。
