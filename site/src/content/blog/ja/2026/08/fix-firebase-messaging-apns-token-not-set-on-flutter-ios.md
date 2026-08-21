---
title: "修正: [firebase_messaging/apns-token-not-set] APNS token has not been set が Flutter iOS で発生する"
description: "APNs がデバイストークンを iOS に渡す前に getToken() が実行されています。getAPNSToken() が null 以外を返すまでポーリングしてから getToken() を呼び出してください。"
pubDate: 2026-08-21
template: error-page
tags:
  - "errors"
  - "flutter"
  - "ios"
  - "firebase"
  - "dart"
lang: "ja"
translationOf: "2026/08/fix-firebase-messaging-apns-token-not-set-on-flutter-ios"
translatedBy: "claude"
translationDate: 2026-08-21
---

APNs がデバイストークンを iOS に渡す前に `FirebaseMessaging.instance.getToken()` を呼び出したため、プラグインが処理の続行を拒否しています。`getAPNSToken()` が null 以外の値を返すまでポーリングし、それから `getToken()` を呼び出してください。10 秒経っても null のままなら、それは競合状態ではなく設定の問題です。Push Notifications の capability が設定されていない、自動初期化が無効になっている、または登録できないシミュレーターを使っている、のいずれかです。本記事は `firebase_messaging` 16.5.0 と `firebase_core` 4.13.0 を Flutter 3.44.2 上で検証した内容です。

## エラーの実際の表示

現行バージョンのプラグインは次のエラーをスローします。

```
[firebase_messaging/apns-token-not-set] APNS token has not been received on the device yet. Please ensure the APNS token is available before calling `getAPNSToken()`.
```

古いバージョンでは文面が異なっていました。この問題に関する検索結果が 2 つの文字列に分かれているのはそのためです。

```
[firebase_messaging/apns-token-not-set] APNS token has not been set yet. Please ensure the APNS token is available by calling `getAPNSToken()`.
```

どちらも同じ `FirebaseException` であり、どちらも `code: 'apns-token-not-set'` を持ち、どちらも同じ場所から発生します。このメッセージには特有の紛らわしさがあります。`getAPNSToken()` を呼べと書かれていますが、いま失敗したのはまさにその `getAPNSToken()` だからです。実際の意味は「`getAPNSToken()` が何かを返すまで待て」です。

## getToken の実行時にトークンが存在しない理由

このチェックはネイティブコードではなく Dart 側にあります。`firebase_messaging_platform_interface` 4.9.3 の `method_channel_messaging.dart` が、プライベートなガードを定義しています。

```dart
// firebase_messaging_platform_interface 4.9.3
Future<void> _APNSTokenCheck() async {
  if (defaultTargetPlatform == TargetPlatform.macOS ||
      defaultTargetPlatform == TargetPlatform.iOS) {
    String? token = await getAPNSToken();

    if (token == null) {
      throw FirebaseException(
        plugin: 'firebase_messaging',
        code: 'apns-token-not-set',
        message:
            'APNS token has not been received on the device yet. Please ensure the APNS token is available before calling `getAPNSToken()`.',
      );
    }
  }
}
```

ネイティブ側の `getAPNSToken` は、待機もリトライもしない単純な読み取りです。

```objc
// FLTFirebaseMessagingPlugin.m, firebase_messaging 16.5.0
- (void)messagingGetAPNSToken:(id)arguments
         withMethodCallResult:(FLTFirebaseMethodCallResult *)result {
  NSData *apnsToken = [FIRMessaging messaging].APNSToken;
  if (apnsToken) {
    result.success(@{@"token" : [FLTFirebaseMessagingPlugin APNSTokenFromNSData:apnsToken]});
  } else {
    result.success(@{@"token" : [NSNull null]});
  }
}
```

仕組みはこれで全部です。`FIRMessaging.APNSToken` は、iOS が `application:didRegisterForRemoteNotificationsWithDeviceToken:` を呼ぶまで nil のままであり、そのコールバックは APNs とのネットワーク往復のあと、Apple 側のタイミングで発火します。通常は起動から 1 秒か 2 秒で届きますが、そのタイミングをアプリ側から制御する手段はありません。Firebase 自身のドキュメントもこの制約を明記しています。iOS SDK 10.4.0 以降では、API リクエストを行う前に APNs トークンが利用可能である必要があります。

つまりこのエラーは「何かが壊れている」という意味ではありません。多くの場合は「聞くのが早すぎた」という意味です。

## 実際にチェックが適用される呼び出し

4.9.3 で `_APNSTokenCheck()` を待機するメソッドはちょうど 4 つです。`deleteToken()`、`getToken()`、`subscribeToTopic()`、`unsubscribeFromTopic()` です。`requestPermission()`、`getInitialMessage()`、`onMessage` ストリームを含むそれ以外はすべて、このチェックを経ずに動作します。

これは、一見矛盾して見える報告パターンを説明します。権限ダイアログは正常に表示されフォアグラウンドのメッセージも届くのに、`subscribeToTopic()` だけが例外をスローする、というものです。トピック購読はガードの対象ですが、メッセージ配信は対象外なのです。

`getAPNSToken()` 自体はガードの対象ではありません。例外をスローせず null を返すため、ポーリングしても安全です。

## 最小限の再現コードはどのようなものですか

起動時にトークンを取得するアプリなら、コールドスタートで必ずこの問題に当たります。

```dart
// Flutter 3.44.2, firebase_core 4.13.0, firebase_messaging 16.5.0
Future<String?> brokenRegisterForPush() async {
  await Firebase.initializeApp();
  return FirebaseMessaging.instance.getToken();
}
```

このバグの最も厄介な性質は、発生が断続的だという点です。ウォームスタート時や、最近すでに登録を済ませたデバイスでは、トークンが `FIRMessaging` 内にキャッシュ済みであることが多く、呼び出しは成功します。クリーンインストール直後、低速なネットワーク、アプリ再インストール後の初回起動では失敗します。修正できたと判断する前に、必ずクリーンインストールで確認してください。

## getToken を呼ぶ前に APNs トークンを待つにはどうすればよいですか

「APNs トークンが利用可能になった」ことを知らせるコールバックもストリームも存在しないため、ポーリングがサポートされた手法です。次のヘルパーは `firebase_messaging` 16.5.0 に対して警告なしで解析を通過します。

```dart
// Flutter 3.44.2, firebase_messaging 16.5.0
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';

/// Polls `getAPNSToken()` until APNs hands the token to the Firebase iOS SDK.
/// Returns null on non-Apple platforms and on timeout.
Future<String?> waitForAPNSToken({
  Duration timeout = const Duration(seconds: 10),
  Duration interval = const Duration(milliseconds: 250),
}) async {
  if (kIsWeb ||
      (defaultTargetPlatform != TargetPlatform.iOS &&
          defaultTargetPlatform != TargetPlatform.macOS)) {
    return null;
  }

  final stopwatch = Stopwatch()..start();
  while (stopwatch.elapsed < timeout) {
    final token = await FirebaseMessaging.instance.getAPNSToken();
    if (token != null) return token;
    await Future<void>.delayed(interval);
  }
  return null;
}
```

Android と Web で null を返す点は重要です。プラットフォーム判定を省いて単純な `while (token == null)` ループとしてガードを書くと、Android では `getAPNSToken()` が永久に null を返し、Android の起動のたびにタイムアウトまで空回りすることになります。platform interface の実装は、Apple 以外のプラットフォームに対しては method channel に触れる前に null を返して短絡します。

これを登録処理に組み込みます。

```dart
// Flutter 3.44.2, firebase_messaging 16.5.0
Future<String?> registerForPush() async {
  await Firebase.initializeApp();

  final messaging = FirebaseMessaging.instance;
  await messaging.setAutoInitEnabled(true);

  final settings = await messaging.requestPermission();
  debugPrint('authorizationStatus: ${settings.authorizationStatus}');

  final apnsToken = await waitForAPNSToken();
  if (apnsToken == null && !kIsWeb) {
    debugPrint('No APNs token: check Push Notifications capability.');
    return null;
  }

  return messaging.getToken();
}
```

トピック関連の呼び出しもガードの対象なので、同じ対応を行ってください。

```dart
// Flutter 3.44.2, firebase_messaging 16.5.0
Future<void> subscribeSafely(String topic) async {
  await waitForAPNSToken();
  await FirebaseMessaging.instance.subscribeToTopic(topic);
}
```

既存の起動処理を作り直したくない場合は、例外をキャッチして 1 回だけリトライする方法もあります。最初に失敗する往復を 1 回消費するぶん、あらかじめ待つ方式より明確に劣りますが、差分は小さく済みます。

```dart
// Flutter 3.44.2, firebase_messaging 16.5.0
Future<String?> registerForPushHandled() async {
  try {
    return await FirebaseMessaging.instance.getToken();
  } on FirebaseException catch (e) {
    if (e.code == 'apns-token-not-set') {
      final token = await waitForAPNSToken();
      if (token == null) return null;
      return FirebaseMessaging.instance.getToken();
    }
    rethrow;
  }
}
```

なお、権限とトークンの利用可否は別の話です。APNs のデバイストークンを生成するのはリモート通知への登録であり、プラグインは権限ダイアログへの応答ではなく自身の登録処理の中でそれを実行します。通知ダイアログを拒否したユーザーでも有効な APNs トークンを持ちうるのであり、バックグラウンドのサイレント push が機能するのはこの性質のおかげです。

## 自動初期化が無効のときには何が起きるのですか

これは見落とされがちな原因であり、理解しておく価値があります。症状が「どれだけポーリングしてもトークンが一向に届かない」という形で現れるからです。

`Info.plist` の `FirebaseMessagingAutoInitEnabled` が `NO` になっている場合、あるいは `setAutoInitEnabled(false)` を呼んでその値が永続化されている場合、プラグインは起動時にリモート通知の登録自体を行いません。

```objc
// FLTFirebaseMessagingPlugin.m, firebase_messaging 16.5.0
if ([FIRMessaging messaging].isAutoInitEnabled) {
  [self registerForRemoteNotifications];
}
```

さらに、アプリ内の別の箇所が登録を行ったとしても、デリゲートのコールバックはトークンを内部に退避するだけで、`FIRMessaging` には渡さずに戻ります。

```objc
// FLTFirebaseMessagingPlugin.m, firebase_messaging 16.5.0
- (void)application:(UIApplication *)application
    didRegisterForRemoteNotificationsWithDeviceToken:(NSData *)deviceToken {
  FIRMessaging *messaging = [FIRMessaging messaging];
  if (!messaging.isAutoInitEnabled) {
    _apnsToken = deviceToken;
    return;
  }
  // ... setAPNSToken happens only past this point
}
```

`FIRMessaging.APNSToken` は nil のままなので `getAPNSToken()` は null を返し続け、iOS がアプリにデバイストークンを正常に渡していても、ポーリングループはタイムアウトします。

復旧経路は用意されていますが、こちらから起動する必要があります。`setAutoInitEnabled(true)` は `registerForRemoteNotifications` を呼んだあと、退避されたトークンをフラッシュします。またこのフラッシュは、プラグインが処理するすべてのメソッド呼び出しの冒頭でも実行されます。

```objc
// FLTFirebaseMessagingPlugin.m, firebase_messaging 16.5.0
- (void)ensureAPNSTokenSetting {
  FIRMessaging *messaging = [FIRMessaging messaging];

  if (messaging.isAutoInitEnabled && messaging.APNSToken == nil && _apnsToken != nil) {
    [messaging setAPNSToken:_apnsToken type:FIRMessagingAPNSTokenTypeSandbox];
    _apnsToken = nil;
  }
}
```

同意取得の都合で FCM の登録を意図的に遅らせること自体は問題ありませんが、その場合も `await messaging.setAutoInitEnabled(true)` はトークンを待つ処理より前に置く必要があります。上の `registerForPush()` にこの行が入っているのはそのためです。

## トークンがまったく届かないときに確認すること

このリストを上から順に確認してください。実機でポーリングがタイムアウトするケースの大半は、最初の 2 項目で説明がつきます。

1. **Push Notifications の capability。** Xcode で Runner ターゲットを開き、Signing and Capabilities タブで Push Notifications が一覧にあることを確認します。これがないとアプリに `aps-environment` の entitlement が付与されず、`registerForRemoteNotifications` は失敗し、iOS は代わりに `didFailToRegisterForRemoteNotificationsWithError:` を呼びます。プラグインはこのエラーを `NSLog` で出力するだけなので見落としやすいです。Xcode のコンソールで、アプリに push の権限がない旨の行を探してください。
2. **Background Modes。** Background fetch と Remote notifications を有効にします。FlutterFire のセットアップガイドは両方を必須としており、APNs はフォアグラウンドとバックグラウンドの両方のメッセージングに必要です。
3. **APNs キーの Firebase へのアップロード。** Firebase Console の Project Settings、Cloud Messaging タブで確認します。最低 1 つのキーが必須です。キーがなくても APNs トークンの取得自体は妨げられませんが、その後の処理はすべて壊れるので、ついでに直しておいてください。
4. **Method swizzling。** Firebase の Flutter クライアントガイドは、swizzling が必須であり、それなしでは FCM のトークン処理が機能しないと明記しています。`Info.plist` で `FirebaseAppDelegateProxyEnabled` を `NO` に設定している場合は、APNs のデリゲートコールバックを自分で転送する必要があります。最も簡単な解決策はそのキーを削除することです。
5. **bundle ID の不一致。** Xcode のバンドル識別子は `GoogleService-Info.plist` のものと一致していなければなりません。ここが食い違うと、明快なエラーではなく分かりにくい後続の不具合として現れます。

## iOS シミュレーターは APNs トークンを取得できますか

条件つきで取得できます。その条件は明確に述べられるほど限定的です。シミュレーターが本物のリモート通知と本物のデバイストークンをサポートするのは、iOS 16 以降で、macOS 13 以降の上で動作し、かつ Apple silicon または T2 チップを搭載した Mac である場合に限られます。トークンはそのシミュレーターとその Mac の組み合わせごとに固有であり、シミュレーターは APNs のサンドボックス環境に対して登録します。

この組み合わせから外れると、シミュレーターはリモート通知に登録できず、`getAPNSToken()` は永久に null を返し、どんな設定変更でも解決しません。Xcode 14 より前は、そもそもどのシミュレーターもデバイストークンを生成できませんでした。古いシミュレーター、Intel Mac、iOS 15 のランタイムでこのエラーを追いかけているなら、コードを変更する前に実機に切り替えてください。

## 落とし穴と紛らわしいケース

**サンドボックスと本番のトークン種別。** プラグインはコンパイル時のプリプロセッサマクロ `DEBUG` によって APNs のトークン種別を決めており、デバッグビルドでは `FIRMessagingAPNSTokenTypeSandbox`、それ以外では `FIRMessagingAPNSTokenTypeProd` を使います。これが `apns-token-not-set` を引き起こすことはありませんが、「デバッグでは動くのに TestFlight では無反応」という典型的な症状の原因になります。リリースビルドで通知が届かなくなった場合に見るべきなのは、この記事ではなくそちらです。

**再インストールするとトークンは無効になります。** アプリを削除して再インストールすると、新しい APNs トークンと新しい FCM トークンが発行されます。以前のインストールに対応するサーバー側のトークンレコードは無効です。初回起動時に一度だけ取得して永続的にキャッシュするのではなく、`FirebaseMessaging.instance.onTokenRefresh` を購読して再アップロードしてください。

**`getAPNSToken()` が null を返すことはこの例外ではありません。** APNs トークンが null なのに例外がスローされていないなら、それは `getAPNSToken()` を直接呼んだということです。null を返すのは仕様であり、その null を `FirebaseException` に変換するのはガード対象の 4 メソッドだけです。

**10 秒というタイムアウトは目安であって保証ではありません。** ネットワークがないデバイスでは、コールバックはそもそも発火しません。タイムアウトはソフトな失敗として扱ってください。null を返してアプリの動作は継続させ、スプラッシュ画面を永久にブロックするのではなく、後で登録をリトライします。

## 関連記事

Flutter アプリの iOS ビルドや統合まわりの問題に取り組んでいるなら、次の記事が周辺の不具合をカバーしています。Firebase プラグインを追加した直後に現れる [CocoaPods のバージョン解決の失敗](/ja/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/)、4 つの異なる原因を持つ [Xcode 16 での iOS ビルドの破損](/ja/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/)、Podfile に残った古いアーキテクチャ除外設定が引き起こす [destination が見つからないエラー](/ja/2026/08/fix-unable-to-find-a-destination-matching-the-provided-destination-specifier-in-a-flutter-ios-build/)、どの entitlement でも解決できない [iOS デバッグビルドでの Dart VM のクラッシュ](/ja/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/)、そして Firebase Auth を同時に組み込んでいる場合に役立つ [google_sign_in 7.0 のシングルトン移行](/ja/2026/08/fix-the-class-googlesignin-doesnt-have-an-unnamed-constructor-in-flutter/) です。

## 参考資料

- [Flutter で Firebase Cloud Messaging クライアントアプリをセットアップする](https://firebase.google.com/docs/cloud-messaging/flutter/client) - iOS SDK 10.4.0 以降の APNs トークン要件と、method swizzling の要件。
- [FlutterFire の Apple 統合ガイド](https://firebase.flutter.dev/docs/messaging/apple-integration/) - Push Notifications の capability、Background Modes、APNs キーのアップロード。
- `firebase_messaging_platform_interface` 4.9.3 の `lib/src/method_channel/method_channel_messaging.dart` - `_APNSTokenCheck()` ガードと、それを待機する 4 つのメソッド。
- `firebase_messaging` 16.5.0 の `ios/firebase_messaging/Sources/firebase_messaging/FLTFirebaseMessagingPlugin.m` - `messagingGetAPNSToken`、`ensureAPNSTokenSetting`、および登録時の自動初期化の条件分岐。
- [flutterfire の issue #10625](https://github.com/firebase/flutterfire/issues/10625) - `_APNSTokenCheck` のソースコメントが、ガードの存在理由として挙げている issue。
- [Xcode 14 でのシミュレーターの push 通知サポート](https://github.com/firebase/firebase-ios-sdk/pull/10503) - シミュレーターのデバイストークンを利用可能にした firebase-ios-sdk の変更。
