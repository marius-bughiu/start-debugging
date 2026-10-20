---
title: "修正: Flutter の Google Sign-In で PlatformException(sign_in_failed, com.google.android.gms.common.api.ApiException: 10) が発生する"
description: "ApiException: 10 は DEVELOPER_ERROR です。インストールされた APK のパッケージ名と署名証明書の SHA-1 の組み合わせを Google が認識していません。ビルドに実際に署名した鍵の SHA-1 を登録し、Web クライアント ID を serverClientId として渡してください。"
pubDate: 2026-10-20
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "google-sign-in"
  - "firebase"
lang: "ja"
translationOf: "2026/10/fix-platformexception-sign-in-failed-apiexception-10-google-sign-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-20
---

`ApiException: 10` は `CommonStatusCodes.DEVELOPER_ERROR` です。Google Play services がサインインを拒否したのは、"Android のパッケージ名 + インストールされた APK に署名した証明書の SHA-1" の組み合わせが、`serverClientId` の背後にある Google Cloud プロジェクト内のどの Android OAuth クライアントとも一致しないためです。Dart のコードには問題ありません。`./gradlew signingReport` (またはインストールした APK そのものに対する `apksigner verify --print-certs`) を実行し、その SHA-1 をその正確な `applicationId` に対して登録し、ストア向けビルドには Play App Signing の SHA-1 も追加してください。そのうえで、`serverClientId` が Android のものではなく **Web** クライアント ID であることを確認します。検証環境は、Flutter 3.44.8 と AGP 9.0.1 上の `google_sign_in` 6.3.0 (`google_sign_in_android` 6.2.1) および `google_sign_in` 7.2.0 (`google_sign_in_android` 7.2.18、`play-services-auth` 21.6.0、`androidx.credentials` 1.6.0) です。

## エラーの全文

`google_sign_in` 6.x では、Android で `GoogleSignIn().signIn()` が次の例外をスローします。

```
PlatformException(sign_in_failed, com.google.android.gms.common.api.ApiException: 10: , null, null)
```

`google_sign_in` 7.x では、同じ設定ミスが `PlatformException` としては届かなくなります。7.x の Android プラグインは失敗を構造化された結果として報告し、Dart 側がそれを `GoogleSignInException` に変換します。どのステップで失敗するかによって、次のいずれかが表示されます。

```
GoogleSignInException(code GoogleSignInExceptionCode.unknownError, [28444] Developer console is not set up correctly., null)
GoogleSignInException(code GoogleSignInExceptionCode.canceled, ...)
GoogleSignInException(code GoogleSignInExceptionCode.unknownError, Authorization failed: 10: ..., null)
```

1 つ目は `authenticate()` の間に Credential Manager から返されます。2 つ目が厄介です。プラグインの README にも、設定エラーによっては、ユーザーがアカウントを選択した後に Credential Manager が "canceled" を返すことがあり、プラグインはそれを本当のキャンセルと区別できない、と記載されています。3 つ目は `authorizationClient.authorizeScopes()` から返されます。これは依然として Play services の `AuthorizationClient` を経由するため、同じステータスコード 10 が表面化します。6.x から 7.x に移行してエラーが "変わった" 場合、おそらく何も解決していません。根本原因は同じで、報告のされ方が違うだけです。

## Google が DEVELOPER_ERROR を返す理由

これらの数値は Play services の定数であり、魔法ではありません。この再現用に Gradle が解決した jar からダンプしました。

```bash
# play-services-basement 18.1.0, play-services-auth 21.6.0
javap -constants -cp classes.jar com.google.android.gms.common.api.CommonStatusCodes
#   public static final int DEVELOPER_ERROR = 10;
javap -constants -cp classes.jar com.google.android.gms.auth.api.signin.GoogleSignInStatusCodes
#   public static final int SIGN_IN_FAILED = 12500;
#   public static final int SIGN_IN_CANCELLED = 12501;
```

`google_sign_in_android` 6.2.1 では、`errorCodeForStatus` が 12501 を `sign_in_canceled` に、4 を `sign_in_required` に、7 を `network_error` にマッピングし、10 を含むそれ以外はすべて `sign_in_failed` にフォールスルーさせ、メッセージとして `e.toString()` を使います。検索で見つかる文字列に、常に完全修飾名の `ApiException` クラス名が含まれているのはこのためです。

DEVELOPER_ERROR が実際に意味するのは次のことです。Google は Android アプリを、パッケージ名と署名証明書の SHA-1 フィンガープリントで識別します。これは Google の [Authenticating Your Client](https://developers.google.com/android/guides/client-auth) ガイドに記載されています。アプリが Web クライアント ID 向けの ID トークンを要求すると、Google は **同じプロジェクト** 内で、そのパッケージ名とフィンガープリントを持つ Android OAuth クライアントを探します。一致するものがなければエラー 10 になります。よく見かける順に、原因は次のとおりです。

1. **このビルドに署名した鍵の SHA-1 が登録されていない。** たいていはリリース鍵か Play App Signing の鍵で、別のマシンや CI 上のデバッグ鍵であることもあります。
2. **パッケージ名が一致していない。** `applicationIdSuffix` を使ったフレーバーは `com.example.app.dev` をインストールしますが、登録されているのは `com.example.app` だけです。
3. **`serverClientId` に誤ったクライアント ID が渡されている。** Web ではなく Android のクライアント ID を渡している、または別の Google Cloud プロジェクトの Web クライアントを渡している場合です。
4. **古い `google-services.json`** に Web OAuth クライアントのエントリがないため、プラグインが何も取得できないか、誤った `default_web_client_id` を取得してしまう。

## 最小の再現手順

エラーを再現する最小構成は、Dart 側は正しく、Google Cloud プロジェクトが署名鍵を知らない状態です。これは 7.x のコードです。ここには間違いはなく、それがポイントです。

```dart
// Flutter 3.44.8, google_sign_in 7.2.0 (google_sign_in_android 7.2.18)
import 'package:flutter/material.dart';
import 'package:google_sign_in/google_sign_in.dart';

// Web OAuth client ID (client_type 3), NOT the Android one.
const String kWebClientId = '1234567890-abc.apps.googleusercontent.com';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await GoogleSignIn.instance.initialize(serverClientId: kWebClientId);
  runApp(const MaterialApp(home: SignInPage()));
}

class SignInPage extends StatelessWidget {
  const SignInPage({super.key});

  Future<void> _signIn() async {
    try {
      final GoogleSignInAccount user = await GoogleSignIn.instance.authenticate();
      debugPrint('Signed in as ${user.email}');
    } on GoogleSignInException catch (e) {
      // e.code is a GoogleSignInExceptionCode, e.description holds the
      // platform message, for example "[28444] Developer console is not set up correctly".
      debugPrint('Google Sign-In failed: ${e.code.name} / ${e.description}');
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        body: Center(
          child: FilledButton(onPressed: _signIn, child: const Text('Sign in')),
        ),
      );
}
```

周辺のプロジェクトは標準の `flutter create` テンプレートに、実際のアプリの多くが持つ変更を 1 つ加えたものです。`applicationIdSuffix = ".dev"` を持つ `dev` フレーバーと、アップロードキーストアで署名されたリリースビルドです。ベースパッケージにデバッグ用の SHA-1 だけを登録すると、`prodDebug` を除くすべてのバリアントがエラー 10 で失敗します。この記事のために Google Cloud プロジェクトに対する実際のサインインは実行していません (Play 対応デバイスと実在のアカウントが必要なため)。以下のビルド、署名、パッケージ名の出力は、この正確なプロジェクトで計測したものです。

## 修正 1: ビルドに実際に署名した鍵の SHA-1 を登録する

どの鍵かを推測してはいけません。Gradle に尋ねてください。Flutter プロジェクトの `android/` フォルダーで次を実行します。

```bash
# Flutter 3.44.8, AGP 9.0.1, OpenJDK 17
cd android
./gradlew signingReport
```

出力には、各バリアントとそのキーストアおよびフィンガープリントが一覧表示されます。再現用プロジェクトでの出力 (一部省略) は次のとおりです。

```
Variant: devDebug
Config: debug
Store: /Users/<you>/.android/debug.keystore
SHA1: <debug-sha1>
Variant: devRelease
Config: upload
Store: .../android/app/upload-keystore.jks
SHA1: 16:AF:74:41:29:46:E2:5B:13:BB:A5:A4:29:C5:CC:D8:36:83:06:E9
Variant: prodRelease
Config: upload
Store: .../android/app/upload-keystore.jks
SHA1: 16:AF:74:41:29:46:E2:5B:13:BB:A5:A4:29:C5:CC:D8:36:83:06:E9
```

ここから読み取れることが 2 つあります。1 つ目は、デバッグとリリースは別の鍵なので、2 つのフィンガープリントが必要だということです。2 つ目は、デバッグキーストアは **各マシンごとに** `~/.android/debug.keystore` にあるということです。チームメイトのノート PC と CI ランナーは、初回ビルド時にそれぞれ独自のキーストアを生成し、フィンガープリントも異なります。"自分のマシンでは動くのに、あなたのマシンではエラー 10 になる" というのはまさにこの状況です。

次に、プロジェクトを管理している場所にフィンガープリントを追加します。

- **Firebase**: プロジェクトの設定、マイアプリ、Android アプリを選択、フィンガープリントを追加。Firebase が、基盤となる Google Cloud プロジェクトに対応する Android OAuth クライアントを自動的に作成します。
- **Google Cloud のみ**: Google Auth Platform、クライアント、クライアントを作成、タイプは Android を選び、パッケージ名と SHA-1 を入力します。Android クライアントは (パッケージ名, SHA-1) のペアごとに 1 つです。

すでに手元にあるビルドのフィンガープリントが必要な場合は、使ったと思われるキーストアからではなく、成果物そのものから読み取ってください。APK には、Android build-tools の `apksigner` を使います。

```bash
# Android build-tools 36.1.0
apksigner verify --print-certs build/app/outputs/flutter-apk/app-dev-release.apk
# Signer #1 certificate DN: CN=Repro
# Signer #1 certificate SHA-256 digest: af3cbfe5...cc071a0a
# Signer #1 certificate SHA-1 digest: 16af74412946e25b13bba5a429c5ccd8368306e9
```

Flutter の APK に `keytool -printcert -jarfile` を使わないでください。このプロジェクトでは `Not a signed jar file` と表示されます。テンプレートの `minSdk` が 24 で、AGP が APK Signature Scheme v2 のみで署名するためです (`apksigner verify -v` は `Verified using v1 scheme (JAR signing): false` と報告します)。`keytool -printcert -jarfile` は、アップロード鍵で jar 署名された `.aab` に対しては機能します。

### ストア向けビルド: Play App Signing の鍵も追加する

これは、"リリース APK では動くのに、Google Play からインストールすると失敗する" という報告の大半の原因です。新規アプリで必須となっている Play App Signing では、Google がアップロード署名を取り除き、配信する APK を Google 独自のアプリ署名鍵で署名し直します。ユーザーのデバイスが提示する SHA-1 は **その** 鍵のものであり、手元には一度もありません。Play Console の テスト とリリース、アプリの完全性、アプリの署名、"アプリ署名鍵の証明書" からコピーし、アップロード鍵と並べて登録してください。内部テストトラックも同様に再署名されるため、本番より先にこの問題を検出できます。

標準の Flutter テンプレートはこれをさらに悪化させます。`release` ビルドタイプがデバッグ鍵で署名されるからです ("Signing with the debug keys for now, so `flutter run --release` works")。ローカルで動くリリースビルドは、単にデバッグ署名されたビルドである可能性があり、Play が使う鍵については何も証明しません。

## 修正 2: 実際にインストールされているパッケージ名を登録する

`signingReport` はパッケージ名を出力しません。インストールされているパッケージ名は APK から読み取ります。

```bash
# Android build-tools 36.1.0
aapt2 dump badging build/app/outputs/flutter-apk/app-dev-release.apk | head -1
# package: name='net.startdebugging.gsiapp.dev' versionCode='1' versionName='0.1.0' ...
```

`dev` フレーバーの `applicationIdSuffix` によって `net.startdebugging.gsiapp` が `net.startdebugging.gsiapp.dev` になりました。Google から見ると、これは別のアプリです。各フレーバーには、それぞれ専用の Android OAuth クライアントが必要です (Firebase の場合は、`android/app/src/<flavor>/` 配下に専用の `google-services.json` を持つ専用の Android アプリ)。なお、`build.gradle.kts` の `namespace` はここでは無関係です。デバイスが報告するのは `applicationId` (とサフィックス) だけです。フレーバーに馴染みがない場合は、[Flutter のフレーバーとは何か、ビルドモードとどう違うのか](/ja/2026/10/what-is-a-flutter-flavor-and-how-is-it-different-from-a-build-mode/)で `applicationIdSuffix` の位置づけを説明しています。

## 修正 3: Web クライアント ID を serverClientId として渡す

ID トークンは **サーバー** 向けに発行されるため、プラグインに渡すクライアント ID は Web アプリケーションのクライアントです (Firebase では `google-services.json` 内で `client_type: 3` と呼ばれます)。Android クライアントはコード内では一切渡さず、Google がパッケージ名と SHA-1 で見つけます。Android のクライアント ID や別プロジェクトの Web クライアントを `serverClientId` として渡すと、同じエラー 10 になります。

```dart
// google_sign_in 7.2.0
await GoogleSignIn.instance.initialize(
  // From Google Auth Platform > Clients, type "Web application",
  // in the SAME project as the Android client.
  serverClientId: '1234567890-web.apps.googleusercontent.com',
);
```

```dart
// google_sign_in 6.3.0 (legacy API)
final googleSignIn = GoogleSignIn(
  serverClientId: '1234567890-web.apps.googleusercontent.com',
  scopes: ['email'],
);
```

`serverClientId` を省略すると、どちらのプラグインバージョンも、`google-services` Gradle プラグインが `google-services.json` から生成する `default_web_client_id` 文字列リソースにフォールバックします。7.x では、そのリソースもない場合、別の明示的なエラーが出ます。`GoogleSignInExceptionCode.clientConfigurationError` と "serverClientId must be provided on Android" です。これが表示された場合、`google-services.json` に `client_type: 3` の `oauth_client` エントリがありません。Firebase で Google をサインインプロバイダーとして有効にするか (またはプロジェクトにウェブアプリを追加して)、ファイルを再ダウンロードしてください。

## 修正 4: google-services.json を再ダウンロードして待つ

Firebase でフィンガープリントを追加した後、`google-services.json` を再ダウンロードして `android/app/google-services.json` を置き換えてください。厳密には、Android クライアントはサーバー側で照合されるため、このファイルが主に影響するのは `default_web_client_id` ですが、変更前のファイルは Web クライアントのエントリが古い、または欠けている原因としてよくあります。そのうえで `flutter clean` を実行し、生成されたリソースを再構築します。Google Cloud での変更も常に即時反映されるわけではありません。追加したばかりのフィンガープリントには数分間の猶予を与えてください。もっと時間がかかるという報告もよくあります。うまくいかなかったと結論づけるのはその後です。

## 落とし穴と似たエラー

**`ApiException: 12500` は同じエラーではありません。** 12500 は `SIGN_IN_FAILED` です。未知のパッケージとフィンガープリントではなく、OAuth 同意画面が不完全 (サポートメールやアプリ名が未設定) といった問題で発生します。まず同意画面の設定を修正してください。

**`ApiException: 12501` はキャンセルです。** 6.x プラグインはこれを `sign_in_canceled` にマッピングします。ユーザーが実際にはキャンセルしていない場合は、あらためて設定を確認してください。特に 7.x では、Credential Manager が設定ミスをキャンセルに見せかけることがあります。

**`ApiException: 7` はネットワークエラーです** (6.x では `network_error`)。これは接続のないエミュレーターで発生するもので、設定ミスではありません。

**デバイスにアカウントがない。** 7.x では、Google アカウントにサインインしていないエミュレーターや、Google アカウント設定で "Google でログイン" のプロンプトが無効になっているエミュレーターで `NoCredentialException` が発生し、プラグインはこれを "No credential available" として報告します。これはデバイスの状態であり、エラー 10 ではありません。Google Play 対応のエミュレーターイメージを使ってください。

**7.x への移行で SHA の要件が変わるわけではありません。** Credential Manager も同じ Android OAuth クライアントの照合を使います。移行の途中でコンストラクターの変更につまずいている場合は、[GoogleSignIn シングルトンへの移行の記事](/ja/2026/08/fix-the-class-googlesignin-doesnt-have-an-unnamed-constructor-in-flutter/)で API 側を扱っています。

**Firebase Auth を併用する場合。** Google の ID トークンを `FirebaseAuth.signInWithCredential` に渡す場合、Google 側の設定が正しくても、デバッグ用 SHA-1 に紐づく API キー制限など、Firebase 側のリリース関連の問題が残ることがあります。これらは [Flutter Android のリリースビルドで Firebase Auth のサインインが永続化されない問題](/ja/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/)で扱っています。

**リリースビルドだけの失敗は無関係な場合があります。** サインインに到達する前にリリースビルドがクラッシュする場合は別の問題です。[リリースビルドの "Could not create Dart VM instance" の修正](/ja/2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build/)を参照してください。

## 決着をつけるチェックリスト

1. 失敗している正確なバリアントをビルドし、その APK に対して `apksigner verify --print-certs` と `aapt2 dump badging` を実行します。
2. Web クライアント ID を所有する Google Cloud プロジェクトで、まさにそのパッケージ名と SHA-1 を持つ Android クライアントが存在することを確認します。
3. Play からインストールされるビルドには、Play Console の "アプリ署名鍵の証明書" の SHA-1 を追加します。
4. `serverClientId` (または `default_web_client_id`) が、同じプロジェクトの Web クライアントであることを確認します。
5. `google-services.json` を再ダウンロードし、`flutter clean` を実行して再ビルドし、Google に数分の猶予を与えます。

5 つすべてを満たしていてもエラー 10 が出る場合は、トークンを要求している先とは別のプロジェクトを見ている可能性がほぼ確実です。Web クライアント ID の数字のプレフィックスを、コンソールのプロジェクト番号と比較してください。

## 関連記事

- [Fix: The class 'GoogleSignIn' doesn't have an unnamed constructor](/ja/2026/08/fix-the-class-googlesignin-doesnt-have-an-unnamed-constructor-in-flutter/)
- [Fix: Firebase Auth sign-in does not persist in a Flutter Android release build](/ja/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/)
- [Flutter のフレーバーとは何か、ビルドモードとどう違うのか](/ja/2026/10/what-is-a-flutter-flavor-and-how-is-it-different-from-a-build-mode/)
- [Fix: Could not create Dart VM instance in a Flutter release build](/ja/2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build/)

## 参考資料

- [google_sign_in_android README: Integration and Troubleshooting](https://pub.dev/packages/google_sign_in_android)
- [google_sign_in on pub.dev](https://pub.dev/packages/google_sign_in)
- [Authenticating Your Client (SHA-1 fingerprints, signingReport)](https://developers.google.com/android/guides/client-auth)
- [CommonStatusCodes reference](https://developers.google.com/android/reference/com/google/android/gms/common/api/CommonStatusCodes)
- [Credential Manager troubleshooting guide](https://developer.android.com/identity/sign-in/credential-manager-troubleshooting-guide)
- [Use Play App Signing](https://support.google.com/googleplay/android-developer/answer/9842756)
- [FlutterFire discussion #18477: ApiException 10 only in the Google Play version](https://github.com/firebase/flutterfire/discussions/18477)
