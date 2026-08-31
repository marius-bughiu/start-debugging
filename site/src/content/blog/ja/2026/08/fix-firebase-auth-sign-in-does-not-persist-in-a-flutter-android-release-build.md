---
title: "Fix: Flutter の Android release ビルドで Firebase Auth のサインインが保持されない"
description: "Firebase Auth は Android のセッションをネットワーク通信なしでプライベートな SharedPreferences ファイルから復元します。そのため release だけで起きるサインアウトが永続化の不具合であることはまずありません。原因は別の google-services.json、拒否されたトークン更新、App Check、あるいは自前の catch ブロックです。"
pubDate: 2026-08-31
template: how-to
tags:
  - "errors"
  - "flutter"
  - "android"
  - "firebase"
  - "dart"
lang: "ja"
translationOf: "2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build"
translatedBy: "claude"
translationDate: 2026-08-31
---

サインインしてアプリを終了し、もう一度開くとユーザーが消えている。release だけで起きて、debug ではセッションが毎回の再起動を生き延びる。何かを変更する前に押さえておくべき点は、Firebase Auth は Android でサインイン済みユーザーをネットワーク通信を一切せずにプライベートな `SharedPreferences` ファイルから復元する、ということです。したがって「release で永続化が壊れている」が実際の原因であることはほとんどありません。release ビルドが別のストアファイルを開いているか、あるいは何かがそのストアを消したかのどちらかです。単に失敗したのではなく拒否されて返ってきたトークン更新、デバッグ証明書しか信頼していない App Check の強制、あるいは catch ブロックの中で `signOut()` を呼んでいる自前の起動コードです。本記事は `firebase_auth` 6.6.1 と `firebase_core` 4.14.0 を Flutter 3.47.1 (Dart 3.13.1) 上で、Android 側の依存解決が `com.google.firebase:firebase-auth:24.2.0` になる構成で検証しています。

## Android のセッションが実際に置かれている場所

Flutter プラグインは永続化を実装していません。Android SDK に委譲し、Android SDK がユーザーを `SharedPreferences` ファイルに書き込みます。`firebase-auth` 24.2.0 ではストアは `com.google.firebase.auth.internal.zzce` で、そのコンストラクタは次のように解決されます。

```java
// Decompiled from com.google.firebase:firebase-auth:24.2.0
// zzce(Context, String persistenceKey)
this.zzc = context.getSharedPreferences(
    String.format("com.google.firebase.auth.api.Store.%s", persistenceKey),
    Context.MODE_PRIVATE);
```

永続化キーは `FirebaseApp.getPersistenceKey()` から来ており、URL セーフな base64 の値 2 つをプラス記号でつないだものです。

```java
// com.google.firebase:firebase-common
// getPersistenceKey() == base64Url(appName) + "+" + base64Url(options.getApplicationId())
```

デフォルトアプリの場合、`[DEFAULT]` は `W0RFRkFVTFRd` にエンコードされるので、実機上の実際のパスは次のようになります。

```
/data/data/<applicationId>/shared_prefs/com.google.firebase.auth.api.Store.W0RFRkFVTFRd+<base64url of mobilesdk_app_id>.xml
```

このコンストラクタから 2 つの事実が導かれ、それが調査全体の方向を決めます。1 つ目は、ユーザーの復元はディスク読み取りだということです。`FirebaseAuth` のコンストラクタが `zzce` を生成して保存済みユーザーを取り出すので、ネットワークのない端末でもサインイン済みのまま起動します。2 つ目は、ファイル名が `google-services.json` の Google app ID から導出されることです。この値をビルドバリアント間で変えた場合、セッションを失ったのではなく、書き込み先のファイルを開かなくなっただけです。

## Android で `currentUser` に競合状態がない理由

`FirebaseAuth.instance.currentUser` は起動直後の一瞬だけ null になるので `authStateChanges()` を待つ必要がある、という主張が広く出回っています。Web とデスクトップ embedder では正しいのですが、Android では正しくありません。これを知っておけば、存在しない競合状態を「修正」せずに済みます。

Android プラグインは、復元したユーザーを `Firebase.initializeApp()` の実行中にプラグイン定数として公開します。

```kotlin
// firebase_auth 6.6.1, android/.../FlutterFirebaseAuthPlugin.kt
override fun getPluginConstantsForFirebaseApp(
    firebaseApp: FirebaseApp?
): Task<MutableMap<String, Any>> {
  // ...
  val firebaseAuth = FirebaseAuth.getInstance(firebaseApp!!)
  val firebaseUser = firebaseAuth.currentUser
  val user = PigeonParser.parseFirebaseUser(firebaseUser)
  if (user != null) {
    constants["APP_CURRENT_USER"] = PigeonParser.manuallyToList(user)
  }
  // ...
}
```

この定数が `MethodChannelFirebaseAuth.setInitialValues` に渡され、ストリームはネイティブのイベントチャネルから何かが届くより先に、その値を再送します。

```dart
// firebase_auth_platform_interface, method_channel_firebase_auth.dart
@override
Stream<UserPlatform?> authStateChanges() async* {
  yield currentUser;
  yield* _authStateChangesListeners[app.name]!.stream.map((event) => event.value);
}
```

つまり Android では、`await Firebase.initializeApp()` が戻った時点で `currentUser` はすでに正しく、`authStateChanges()` の最初のイベントも同じ値です。release でそれが null なら、ストアは本当に空でした。`currentUser` を `StreamBuilder` に置き換えても答えは変わりません。ただし別の理由から認証ゲートの形としては依然として正しく、その点は [StreamBuilder と Riverpod の AsyncValue の比較](/ja/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/)と合わせて読む価値があります。

## 原因を切り分ける診断手順

順番に実行してください。それぞれが説明の一群をまるごと排除でき、最初の 2 つは 5 分程度で終わります。

1. **release ビルドを調査できるようデバッグ可能にします。**
   `adb shell run-as` はデバッグ可能でないパッケージを扱うことを拒否します。そのため通常の release APK からストアを読み出すことはできません。`android/app/build.gradle.kts` に使い捨ての build type を追加してビルドし、終わったら削除します。

   ```kotlin
   // android/app/build.gradle.kts, temporary
   buildTypes {
       create("releaseProbe") {
           initWith(getByName("release"))
           isDebuggable = true
           matchingFallbacks += listOf("release")
       }
   }
   ```

2. **ストアファイルが存在するか、そしてどのファイルなのかを確認します。**
   サインインし、強制停止してから、アプリの preferences ディレクトリを一覧表示します。ファイルが存在して中身も空でないのにアプリがサインアウト状態で起動するなら、ストレージではなくコードの問題です。ファイルが無いなら、何かが消しています。

   ```bash
   adb shell run-as com.example.app ls -l shared_prefs/
   adb shell run-as com.example.app cat 'shared_prefs/com.google.firebase.auth.api.Store.W0RFRkFVTFRd+...xml'
   ```

3. **各バリアントが実際に埋め込んでいる Google app ID を比較します。**
   `google-services` Gradle プラグインは、解析した値をバリアントごとの生成リソースファイルに書き出します。両者を比較してください。ここに差があれば症状は完全に説明でき、それ以上調べる必要はありません。

   ```bash
   grep google_app_id android/app/build/generated/res/google-services/debug/values/values.xml
   grep google_app_id android/app/build/generated/res/google-services/release/values/values.xml
   ```

4. **推測ではなく usage レポートで R8 を除外します。**
   Flutter の release ビルドではコード圧縮が有効なので R8 は妥当な容疑者ですが、除外するのは簡単です。`android/app/proguard-rules.pro` に `-printusage build/r8-usage.txt` を追加して再ビルドし、レポート内を `com.google.firebase.auth` で検索します。

5. **トークン更新を観察します。**
   Firebase Auth の詳細ログを有効にし、ネットワークを有効にした状態でアプリをコールドスタートします。トランスポートエラーで失敗した更新はセッションをそのまま残します。拒否された更新こそがセッションを消します。

   ```bash
   adb shell setprop log.tag.FirebaseAuth VERBOSE
   adb logcat -s FirebaseAuth:V FirebaseApp:V
   ```

6. **プロジェクトに登録されている証明書フィンガープリントを確認します。**
   release バリアントが実際に署名されているフィンガープリントを出力し、Firebase のプロジェクト設定、Google Cloud の API キー制限、Play Console の App Signing ページと突き合わせます。

   ```bash
   cd android && ./gradlew signingReport
   ```

## 原因 1: release バリアントが別の `google-services.json` を読んでいる

これが最も多い答えであり、最も見落とされやすい答えでもあります。認証の問題らしく見える要素がどこにも無いからです。

Android の source set を使うと `google-services.json` を `android/app/src/debug/`、`android/app/src/prod/`、あるいは任意の flavor ディレクトリに置くことができ、Gradle プラグインはビルド中のバリアントに対して最も具体的なものを選びます。FlutterFire CLI も `--android-out` で同じ配置を促します。debug バリアントが開発用 Firebase プロジェクトのファイルを解決し、release バリアントが本番のものを解決すると、`options.getApplicationId()` が変わり、永続化キーが変わり、ストアファイル名が変わります。

結果は明快です。一方のバリアントが書いたセッションはもう一方からは見えず、設定を差し替える前に release バリアントが書いたセッションは差し替え後には見えません。上の手順 3 がコマンド 1 つでこれを捕まえます。修正すべきはコードではなく、出荷するバリアントが毎回同じプロジェクトに対してサインインし読み戻すこと、そしてテストする人が設定の差し替えはサインアウトと同義だと理解していることです。

debug の `applicationIdSuffix` はこれに近いがもっと単純な状況を生みます。サンドボックスの分かれた 2 つの別インストールです。これは期待どおりの挙動で、報告される事象とは通常異なります。

## 原因 2: release で R8 は有効だが、標準構成は安全

Flutter は release ビルドのコード圧縮を自ら有効にします。Flutter の Gradle プラグインから引用します。このロジックが 3.44 以降変わっていないことをローカルの 3.44.8 SDK で確認しています。

```kotlin
// packages/flutter_tools/gradle/src/main/kotlin/FlutterPlugin.kt
if (FlutterPluginUtils.shouldShrinkResources(project)) {
    val releaseBuildType: BuildType = ...buildTypes.getByName("release")
    releaseBuildType.isMinifyEnabled = true
    releaseBuildType.isShrinkResources = FlutterPluginUtils.isBuiltAsApp(project)
    releaseBuildType.proguardFiles.add(...getDefaultProguardFile("proguard-android-optimize.txt"))
    releaseBuildType.proguardFiles.add(flutterProguardRules)
    // plus android/app/proguard-rules.pro if it exists
}
```

`shouldShrinkResources` は Gradle プロパティ `shrink` が明示的に false でない限り true を返し、コマンドラインフラグ `--shrink` は現在では文書化された no-op です。ヘルプテキストは "This flag has no effect. Code shrinking is always enabled in release builds." と書かれています。つまり `build.gradle.kts` に何も書いていなくても R8 は release ビルドに対して動きます。

とはいえ、それで R8 が有力な容疑者になるわけではありません。`firebase-auth` は AGP が自動適用する consumer ルールを同梱しているからです。24.2.0 の AAR に入っている `proguard.txt` は全文でもこれだけです。

```proguard
-keepclassmembers class * extends com.google.android.gms.internal.firebase-auth-api.zzalt {
  <fields>;
}
-dontwarn rx.**
-dontwarn android.crypto.hpke.**
```

`-keep class com.google.firebase.** { *; }` のような当て推量のルールを足すのではなく、手順 4 を使ってください。包括的な keep ルールは疑問に答えるのではなく覆い隠すだけであり、usage レポートで `com.google.firebase.auth` から何も削除されていないと分かれば、この筋を完全に排除できます。

## 原因 3: 更新が拒否される、しかも release でだけ

コールドスタート時、SDK はユーザーをディスクから復元し、その後 1 時間有効な ID トークンを `securetoken.googleapis.com` に対して更新します。SDK はトランスポートの失敗と拒否を区別します。トランスポートの失敗では保存済みユーザーはそのまま残り、だからこそオフライン端末はサインイン状態を保ちます。SDK のエラーテーブルにある確定的なコード、たとえば `TOKEN_EXPIRED`、`USER_DISABLED`、`USER_NOT_FOUND` を伴う拒否は、保存済みユーザーを消して認証状態リスナーを null で発火させます。症状がハングではなくきれいなサインアウトになるのはそのためです。

動作していた更新を release ビルドでだけ拒否させる構成が 2 つあります。

**デバッグ証明書に絞られた API キー制限。** Firebase の API キーに Android apps のアプリケーション制限が付いている場合、すべてのリクエストはリストに載っているパッケージ名と SHA-1 証明書フィンガープリントを提示しなければなりません。デバッグ keystore の SHA-1 に制限されたキーは `flutter run` では完璧に動作し、アプリが release 用に署名された途端に "Requests from this Android client application are blocked" を伴う `403 PERMISSION_DENIED` を返します。これにはもっと厄介な第 2 の型があります。Firebase は、Authentication がキーの API 制限の許可リストに 2 つの API を必要とすると文書化しています。Identity Toolkit API (`identitytoolkit.googleapis.com`) と Token Service API (`securetoken.googleapis.com`) です。前者だけを許可すると、報告どおりの形になります。サインインは成功し、次回起動時の更新が失敗します。

**App Check の強制。** App Check が Authentication に対して強制されている場合、クライアントは証明トークンを添付しなければなりません。Flutter での一般的な設定はビルドモードでプロバイダを切り替えます。

```dart
// firebase_app_check, called after Firebase.initializeApp()
await FirebaseAppCheck.instance.activate(
  androidProvider: kDebugMode ? AndroidProvider.debug : AndroidProvider.playIntegrity,
);
```

デバッグプロバイダは Firebase コンソールで手動登録するもので、手元では必ず動きます。Play Integrity には、インストール済みアプリが実際に署名されている証明書の SHA-256 フィンガープリントが必要で、Play App Signing を使っているならそれは Google の鍵であってアップロード鍵ではありません。これを登録し忘れると App Check は本番でだけ失敗します。Firebase はさらに、Google Play 経由で配布されていないビルドは `PLAY_RECOGNIZED` の判定を得られないとも述べています。社内配布する release APK では対応する詳細設定を緩めておかないと、まったく健全な端末で証明に失敗します。

どちらもフィンガープリントの問題であり、同じ罠が二度人をつかまえます。`flutter run --release` はデバッグ設定で署名します。Flutter 自身のテンプレートが意図的にそうしているからです。生成された `android/app/build.gradle.kts` のコメントにこう書かれています。"Signing with the debug keys for now, so `flutter run --release` works." 自分のマシンからは動いて Play からは失敗する release ビルドは、ビルドモードの違いではなくフィンガープリントの違いです。

## 原因 4: 自前のコードがサインアウトしている

ストア、設定、フィンガープリントがすべて問題ないなら、残る可能性はアプリ自身がやったということです。よくある形は、Firebase の ID トークンを自前のバックエンドのセッションと交換する起動時の呼び出しです。

```dart
// The bug: any failure is treated as an invalid session.
try {
  final token = await FirebaseAuth.instance.currentUser!.getIdToken();
  await api.exchange(token);
} catch (_) {
  await FirebaseAuth.instance.signOut(); // wipes a perfectly good session
}
```

debug ではこの catch ブロックは一度も実行されません。release では App Check や API キーの拒否がここに落ちてきて、自前のコードがユーザーをサインアウトさせます。次回起動時にはストアが本当に空なので、その状態が定着します。エラーコードでケースを分けてください。

```dart
try {
  final token = await FirebaseAuth.instance.currentUser!.getIdToken();
  await api.exchange(token);
} on FirebaseAuthException catch (e) {
  const fatal = {'user-token-expired', 'user-disabled', 'user-not-found', 'invalid-user-token'};
  if (fatal.contains(e.code)) {
    await FirebaseAuth.instance.signOut();
  } else {
    // network-request-failed, too-many-requests, and anything unexpected:
    // keep the session and retry later.
  }
}
```

この経路を守ることは、非同期呼び出しが飛んでいる最中にシェルから画面遷移しないということでもあり、[dispose でストリームのサブスクリプションをキャンセルする](/ja/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/)のと同じ規律です。

## これに似ているが違うもの

**INTERNET パーミッション不足という答えは Firebase Auth には当てはまりません。** Flutter の `src/main/AndroidManifest.xml` テンプレートはパーミッションを一切宣言していない一方、生成される `src/debug/` と `src/profile/` のマニフェストはどちらも `android.permission.INTERNET` を宣言しており、ツールが hot reload のために必要とする旨のコメントが付いています。これは release ビルドでの素の `http` や `dio` の呼び出しを実際に壊します。しかし Firebase Auth は壊しません。`firebase-auth` 24.2.0 のライブラリマニフェストが自らこのパーミッションを宣言しており、マニフェストマージャーがそれをあなたの APK に取り込むからです。

```xml
<!-- com.google.firebase:firebase-auth:24.2.0, AndroidManifest.xml -->
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
```

どちらの主張も鵜呑みにせず、自分のビルドで確認してください。`build/app/outputs/logs/manifest-merger-release-report.txt` にどのライブラリがどのノードを提供したかが記録されています。

**Android Auto Backup が端末に古いセッションを渡すことがあります。** `android:allowBackup` の既定値は true で `SharedPreferences` ファイルも対象に含まれるため、認証ストアはクラウドバックアップや端末間転送を通じて移動します。Flutter のテンプレートも `firebase-auth` のマニフェストもこれを除外していません。報告がバックアップから復元した新しい端末に集中しているなら、明示的に除外してください。

```xml
<!-- android/app/src/main/res/xml/data_extraction_rules.xml, API 31+ -->
<data-extraction-rules>
  <cloud-backup>
    <exclude domain="sharedpref" />
  </cloud-backup>
  <device-transfer>
    <exclude domain="sharedpref" />
  </device-transfer>
</data-extraction-rules>
```

**アンインストールはストアを消し、アプリデータの削除も同様です。** Firebase はこれをネイティブの永続化を消去する唯一のサポートされた方法として文書化しています。アンインストールしてから新しい APK を入れ直すテスターは、あなたのバグを再現していません。

## 関連記事

Flutter アプリの Android release と Firebase まわりの問題に取り組んでいるなら、以下が隣接する不具合を扱っています。Firebase Auth に渡す資格情報の取得方法が変わる [`google_sign_in` 7.x のシングルトン移行](/ja/2026/08/fix-the-class-googlesignin-doesnt-have-an-unnamed-constructor-in-flutter/)、iOS で同じ「debug では動くが release では無反応」という形になる [APNs トークンの順序問題](/ja/2026/08/fix-firebase-messaging-apns-token-not-set-on-flutter-ios/)、リリースのアップロード自体を止める [16 KB メモリページサイズによる審査却下](/ja/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/)、そして同じアップグレード時期にやってくる [SDK 35 を target した後の edge-to-edge レイアウト変更](/ja/2026/08/fix-flutter-ui-overlaps-the-android-navigation-bar-after-targeting-sdk-35/) です。

## 参考資料

- [Get Started with Firebase Authentication on Flutter](https://firebase.google.com/docs/auth/flutter/start) - ネイティブの永続化が設定不可であるという記述と、`authStateChanges`、`idTokenChanges`、`userChanges` の違い。
- [Learn about and manage API keys for Firebase](https://firebase.google.com/docs/projects/api-keys) - Authentication は API キーの許可リストに Identity Toolkit API と Token Service API の両方を必要とすること。
- [Get started using App Check with Play Integrity on Android](https://firebase.google.com/docs/app-check/android/play-integrity-provider) - SHA-256 登録の要件と、Google Play 以外で配布するビルドに対する `PLAY_RECOGNIZED` の注意点。
- [flutterfire issue #12727](https://github.com/firebase/flutterfire/issues/12727) - API キーの Android アプリケーション制限が生む "Requests from this Android client application are blocked" の 403。
- `com.google.firebase:firebase-auth:24.2.0` - `SharedPreferences` ストア名については `com/google/firebase/auth/internal/zzce`、サーバーエラーコード表については `com/google/firebase/auth/internal/zzaq`、および同梱の `proguard.txt` と `AndroidManifest.xml`。
- `firebase_auth` 6.6.1 - `getPluginConstantsForFirebaseApp` については `android/.../FlutterFirebaseAuthPlugin.kt`、`currentUser` を再送するストリームについては `firebase_auth_platform_interface` の `method_channel_firebase_auth.dart`。
- Flutter SDK 3.44.8 - release のコード圧縮の既定値については `packages/flutter_tools/gradle/src/main/kotlin/FlutterPlugin.kt`、no-op の `--shrink` フラグについては `runner/flutter_command.dart`、および `android.tmpl` のマニフェストと Gradle テンプレート。
