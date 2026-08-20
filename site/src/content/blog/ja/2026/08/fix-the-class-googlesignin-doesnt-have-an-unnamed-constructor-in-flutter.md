---
title: "解決: The class 'GoogleSignIn' doesn't have an unnamed constructor"
description: "google_sign_in 7.0.0 で GoogleSignIn はシングルトンになりました。GoogleSignIn(scopes: ...) を GoogleSignIn.instance に置き換え、initialize() を一度だけ待ってから authenticate() を呼びます。"
pubDate: 2026-08-20
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "google-sign-in"
  - "firebase"
lang: "ja"
translationOf: "2026/08/fix-the-class-googlesignin-doesnt-have-an-unnamed-constructor-in-flutter"
translatedBy: "claude"
translationDate: 2026-08-20
---

`google_sign_in` 7.0.0 (2025-06-24 公開) で `GoogleSignIn` はシングルトンになったため、`GoogleSignIn(...)` はもうコンパイルできません。`GoogleSignIn.instance` を使い、起動時に新しい `initialize()` メソッドをちょうど一度だけ待ち、`signIn()` の代わりに `authenticate()` を呼んでください。以前コンストラクターに渡していた `scopes:` 引数に直接の置き換えはありません。認可は `user.authorizationClient` を経由する別のステップになりました。自動マイグレーションは用意されていないため、実際のアプリでは相応の時間を見込んでください。

## エラーの全文

`google_sign_in` 7.x を解決する `pubspec.yaml` に対して、アナライザーはどのプラットフォームでも次を報告します。

```
error - The class 'GoogleSignIn' doesn't have an unnamed constructor. Try using one
        of the named constructors defined in 'GoogleSignIn' - lib\auth.dart:5:36 -
        new_with_undefined_constructor_default
```

このヒントは行き止まりです。クラスにある唯一の名前付きコンストラクターは `GoogleSignIn._()` で、パッケージ内のプライベートなものなので、呼べるものはありません。この診断はアナライザーの汎用的な「デフォルトコンストラクターがない」規則から出ており、パッケージが静的フィールド経由の利用を想定していることを知りません。

このエラーが単独で出ることはありません。Flutter 3.44.2 上で `google_sign_in` 7.2.0 に対して典型的な 6.x のサインインファイルに `flutter analyze` をかけると、次のように一気に出ます。

```
error - The class 'GoogleSignIn' doesn't have an unnamed constructor
error - The method 'signIn' isn't defined for the type 'GoogleSignIn'
error - The method 'isSignedIn' isn't defined for the type 'GoogleSignIn'
error - The method 'signInSilently' isn't defined for the type 'GoogleSignIn'
error - The getter 'accessToken' isn't defined for the type 'GoogleSignInAuthentication'
 info - Uses 'await' on an instance of 'GoogleSignInAuthentication', which is not a
        subtype of 'Future'
```

最後の `info` は注意して読む価値があります。`GoogleSignInAccount.authentication` は同期的なゲッターになったため、コード中の `await account.authentication` はどれも何もしない記述であり、アナライザーはそれをエラーではなく lint としてしか報告しません。

## なぜ google_sign_in 7.0.0 でコンストラクターが消えたのか

6.x の API は Google Sign-In SDK の Dart ラッパーでしたが、この SDK は Android と Web の両方で非推奨になりました。Android での置き換えは Credential Manager と `AuthorizationClient` であり、Google は [2024 年 9 月から開発者に告知しています](https://android-developers.googleblog.com/2024/09/streamlining-android-authentication-credential-manager-replaces-legacy-apis.html)。`play-services-auth` の旧サインイン API は廃止されます。これらの SDK は構造が根本的に異なるため、Flutter プラグインの API 表面も一緒に変わりました。

そのうち 3 点が、遭遇するコンパイルエラーのほとんどを説明します。

プラグインはもう「設定してから使うオブジェクト」をモデル化していません。基盤となる SDK はプロセス全体で動作し、6.x で `GoogleSignIn` オブジェクトを 2 つ作っても実際には正しく動きませんでした。パッケージのマイグレーションガイドははっきり書いています。クラスをシングルトンにしたのは、すでに存在していた制約を明示しただけです。

設定はコンストラクターから、明示的な非同期の `initialize()` 呼び出しへ移りました。Web ではこの呼び出しに実際の処理があり、体感できる時間がかかることもあります。これはコンストラクターでは表現できません。

認証と認可が分離されました。6.x の `GoogleSignIn(scopes: [...])` は「このユーザーは誰か」と「連絡先を読ませてほしい」を 1 つの同意ダイアログにまとめていました。7.x ではまず認証し、データが実際に必要になった時点で scopes を要求します。

## 最小再現: コンパイルできなくなる 6.x のコード

```dart
// Flutter 3.44.2, Dart 3.12.2, google_sign_in 7.2.0
// Every line of this compiled fine on google_sign_in 6.3.0.
import 'package:google_sign_in/google_sign_in.dart';

final GoogleSignIn _googleSignIn = GoogleSignIn(
  scopes: <String>['email', 'https://www.googleapis.com/auth/contacts.readonly'],
);

Future<void> signIn() async {
  final GoogleSignInAccount? account = await _googleSignIn.signIn();
  if (account == null) return;
  final GoogleSignInAuthentication auth = await account.authentication;
  print(auth.accessToken);
  print(auth.idToken);
}
```

ここで `dart fix` に頼るのはやめてください。`google_sign_in` 7.2.0 をインストールした状態でこのファイルに `dart fix --dry-run` を実行すると `Nothing to fix!` と表示されます。パッケージは削除されたメンバー向けの互換用シムを一切同梱していないためです。呼び出し箇所はすべて手作業での修正になります。

## GoogleSignIn(...) をシングルトンに置き換えるには

プラグインに他の何かが触れる前に、`initialize()` を一度だけ呼びます。Flutter アプリでは `main()` か一度きりのブートストラップ処理であり、二重に push されうるサインイン画面の `initState` ではありません。

```dart
// Flutter 3.44.2, google_sign_in 7.2.0
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  await GoogleSignIn.instance.initialize(
    // Both are optional. Omit them if your Info.plist GIDClientID or your
    // google-services.json already supplies the values.
    clientId: 'IOS_OR_WEB_CLIENT_ID.apps.googleusercontent.com',
    serverClientId: 'SERVER_CLIENT_ID.apps.googleusercontent.com',
  );

  runApp(const MyApp());
}
```

`initialize()` は `clientId`、`serverClientId`、`nonce`、`hostedDomain` を受け取ります。ここで渡した値は、プラットフォームの設定ファイルにある値より優先されます。`scopes` パラメーターも `signInOption` もありません。`SignInOption.games` はプラットフォームインターフェースから完全に削除されました。

対話的なサインイン呼び出しはこうなります。

```dart
// Flutter 3.44.2, google_sign_in 7.2.0
Future<void> onSignInPressed() async {
  if (!GoogleSignIn.instance.supportsAuthenticate()) {
    return; // Web. See the renderButton section below.
  }
  try {
    final GoogleSignInAccount user = await GoogleSignIn.instance.authenticate();
    final String? idToken = user.authentication.idToken; // no await
  } on GoogleSignInException catch (e) {
    if (e.code == GoogleSignInExceptionCode.canceled) return;
    debugPrint('${e.code}: ${e.description}');
  }
}
```

型レベルで重要な違いが 2 つあります。`authenticate()` は null 許容でない `GoogleSignInAccount` を返すため、6.x の `if (account == null)` ガードはデッドコードになります。そしてキャンセルは null ではなく例外になりました。ユーザーが中断すると、`code` が `GoogleSignInExceptionCode.canceled` の `GoogleSignInException` がスローされます。古い null チェックを消したうえで try/catch を書き忘れると、キャンセルされたサインインがすべて未処理の例外としてログに出ます。

`GoogleSignInExceptionCode` には `interrupted`、`clientConfigurationError`、`providerConfigurationError`、`uiUnavailable`、`userMismatch`、`unknownError` もあります。7.0.0 では誤ってエクスポートされておらず 7.1.0 で戻されたので、switch で分岐したい場合は 7.1.0 以上を要求してください。

## signIn、signInSilently、currentUser の代わりは何か

削除された各メンバーと 7.x での対応表です。`google_sign_in` 7.2.0 で確認しました。

| google_sign_in 6.x | google_sign_in 7.x |
| --- | --- |
| `GoogleSignIn(...)` | `GoogleSignIn.instance` と `await initialize(...)` |
| `signIn()` | `authenticate({scopeHint})` |
| `signInSilently()` | `attemptLightweightAuthentication()` |
| `isSignedIn()` | `authenticationEvents` から自分で追跡する |
| `currentUser` | `authenticationEvents` から自分で追跡する |
| `onCurrentUserChanged` | `authenticationEvents` |
| `canAccessScopes(scopes)` | `authorizationClient.authorizationForScopes(scopes)` |
| `requestScopes(scopes)` | `authorizationClient.authorizeScopes(scopes)` |
| `account.authHeaders` | `authorizationClient.authorizationHeaders(scopes)` |
| `account.serverAuthCode` | `authorizationClient.authorizeServer(scopes)` |
| `clearAuthCache(token:)` | `clearAuthorizationToken(accessToken:)`、7.2.0 で追加 |
| `signOut()`、`disconnect()` | 変更なし |

生き残った 2 つは覚えておく価値があります。`signOut()` と `disconnect()` は名前もシグネチャーもそのままです。だからこそ、中途半端な移行は 1 つのファイルではコンパイルが通り、次のファイルで失敗します。

`attemptLightweightAuthentication()` の戻り値の型はタイプミスに見えますが、そうではありません。`Future<GoogleSignInAccount?>?`、つまり null 許容の Future です。Future が null であれば、そのプラットフォームは素早く答えを返せないという意味です (パッケージが挙げる例は FedCM を使う Web です)。その場合は何かを await するのではなく、サインアウト状態の UI を表示して `authenticationEvents` を待ってください。

```dart
// Flutter 3.44.2, google_sign_in 7.2.0
final Future<GoogleSignInAccount?>? attempt =
    GoogleSignIn.instance.attemptLightweightAuthentication();
if (attempt != null) {
  final GoogleSignInAccount? user = await attempt;
}
```

また「軽量」は「無音」ではありません。この改名は意図的です。Web では浮動するサインインカードが、Android ではアカウント選択シートが表示されることがあります。既定ではこの呼び出しは `canceled`、`interrupted`、`uiUnavailable` を飲み込んで null を返します。例外として受け取りたい場合は `reportAllExceptions: true` を渡してください。

## scopes 引数はどこへ行ったのか

2 つ目の独立したステップに移りました。`GoogleSignInAccount` は `authorizationClient` を公開しており、アクセストークンは今そこにあります。推奨される形は、まず既存の許可を試し、それが失敗したときだけ UI を出すというものです。

```dart
// Flutter 3.44.2, google_sign_in 7.2.0
const List<String> scopes = <String>[
  'https://www.googleapis.com/auth/contacts.readonly',
];

Future<String> accessTokenFor(GoogleSignInAccount user) async {
  // Returns null instead of prompting if the scopes are not yet granted.
  final GoogleSignInClientAuthorization? existing =
      await user.authorizationClient.authorizationForScopes(scopes);
  if (existing != null) return existing.accessToken;

  // Shows consent UI. Call it from a button press, not from initState.
  final GoogleSignInClientAuthorization granted =
      await user.authorizationClient.authorizeScopes(scopes);
  return granted.accessToken;
}
```

この 2 つのメソッドは、フラグが 1 つ違うだけで同じプラットフォーム入口に到達します。テストで偽の `GoogleSignInPlatform` に対してこのフローを流すと、まさに次の呼び出し順序が記録されます。

```
init
authenticate scopeHint=[]
clientAuth prompt=false     <- authorizationForScopes
clientAuth prompt=true      <- authorizeScopes
```

以前の統合された同意ダイアログが欲しい場合は、`authenticate()` に `scopeHint` を渡します。ただしこれはヒント以上のものではありません。フローを統合できないプラットフォームは無視しますし、その後も `authorizationForScopes` が null を返しうるとパッケージは明示的に警告しています。フォールバック経路は必ず書いてください。

サーバー側との交換には `authorizeServer(scopes)` を使い、`serverAuthCode` を持つ `GoogleSignInServerAuthorization` を受け取ります。これはクライアント認可とは別の往復であり、サインイン結果から `account.serverAuthCode` を直接読んでいたアプリにとって最も多い驚きどころです。

## authentication.accessToken はどこへ行ったのか

別の型へ移りました。アクセストークンは認可の成果物であり、`authentication` は認証の成果物だけを運ぶようになったためです。7.x の `GoogleSignInAuthentication` のフィールドはちょうど 1 つです。

```dart
// google_sign_in 7.2.0, lib/src/token_types.dart
class GoogleSignInAuthentication {
  const GoogleSignInAuthentication({required this.idToken});
  final String? idToken;
}
```

アクセストークンは null 許容でない `GoogleSignInClientAuthorization.accessToken` へ、サーバー認可コードは `GoogleSignInServerAuthorization.serverAuthCode` へ移りました。

Firebase Auth との連携を壊すのはこの変更ですが、修正は多くのマイグレーション議論が示唆するより小さいものです。`firebase_auth` 6.5.7 の `GoogleAuthProvider.credential` は `credential({String? idToken, String? accessToken})` と宣言され、少なくとも一方を要求する assert が付いています。ID トークンだけで十分です。

```dart
// Flutter 3.44.2, google_sign_in 7.2.0, firebase_auth 6.5.7
Future<UserCredential> signInWithGoogle() async {
  final GoogleSignInAccount user = await GoogleSignIn.instance.authenticate();

  final AuthCredential credential = GoogleAuthProvider.credential(
    idToken: user.authentication.idToken,
  );
  return FirebaseAuth.instance.signInWithCredential(credential);
}
```

この呼び出しのために `accessToken` を用意する目的だけで `authorizeScopes` を呼ばないでください。使いもしない scopes について、ユーザーに不要な同意ダイアログを見せることになります。

## Flutter web で authenticate はどうなるのか

例外を投げます。`google_sign_in_web` 1.1.3 は `supportsAuthenticate()` で `false` を返し、`authenticate()` は例外を送出します。

```
UnimplementedError: authenticate is not supported on the web.
Instead, use renderButton to create a sign-in widget.
```

Google Identity Services はサインインボタンを自身の SDK が描画することを要求するため、独自の `ElevatedButton` ではフローを開始できません。`supportsAuthenticate()` でガードし、Web では `package:google_sign_in_web/web_only.dart` のウィジェットを描画して、結果は `authenticationEvents` から受け取ってください。なお、マイグレーションガイドはこれを `UnsupportedError` と説明していますが、実装が実際に投げるのは `UnimplementedError` です。厳密な型で一致を取らないでください。

関連する Web 固有の落とし穴として、そこでは `authorizationRequiresUserInteraction()` が `true` を返します。認可フローがポップアップを使い、ブラウザーはユーザー操作の外ではそれをブロックするためです。`FutureBuilder` や `initState` からの `authorizeScopes` 呼び出しはモバイルでは動作し、Web では失敗します。

## google_sign_in 6.x に固定するだけで済ませられるか

短期間なら可能です。`google_sign_in: 6.3.0` は Flutter 3.44.2 でも問題なく解決し、`google_sign_in_android` 6.2.1 と `google_sign_in_ios` 5.9.0 を引き込みます。現行の安定版 Flutter SDK に、これを妨げるものはありません。

ただし応急処置であって計画ではありません。6.x の Android 側は非推奨になった `play-services-auth` のサインイン API に乗っており、[Google 自身のマイグレーションページ](https://developer.android.com/identity/sign-in/legacy-gsi-migration)はそれらが削除されると述べています。選べるのは移行するかどうかではなく、いつ移行するかです。

## コンパイルが通っても残る落とし穴

**`initialize()` を飛ばすとイベントストリームが黙って死にます。** アプリ側パッケージが `authenticationEvents` にイベントを合成するのは、プラットフォーム実装が独自のイベントストリームを持たないと `initialize()` が判断した場合だけです。偽のプラットフォームを使ったテストでこの挙動を確認できます。初期化せずに認証すると、例外も出ないままストリームは空のままです。サインインは成功し、UI は決して更新されません。

**`initialize()` を複数回呼ぶのは未定義動作です。** パッケージはその言葉どおりに文書化しています。プロバイダーの再構築で再実行されるブートストラップ処理がこれに該当します。

**Android では設定ミスが `canceled` として届くことがあります。** Credential Manager SDK は一部の設定ミスに対してキャンセルを返し、プラグインには両者を区別する手段がありません。アカウント選択の直後に `authenticate()` が `canceled` を投げる場合は、そのビルドバリアントの署名 SHA を確認し、`google-services.json` に `client_type: 3` の `oauth_client` エントリーがあることを確かめてください。

**Flutter のバージョンが Android 実装の上限になることがあります。** `google_sign_in` 7.2.0 自体は Flutter 3.29 と Dart 3.7 を要求しますが、`google_sign_in_android` 7.2.16 は Flutter 3.44 と Dart 3.12 を要求します。より古い Flutter では pub は失敗せず古い実装パッケージを解決するため、`pubspec.lock` のプラグインバージョンだけでは全体像がわかりません。これは[再現可能なビルドのために Flutter エンジンのバージョンを固定する](/ja/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/)のと同じ種類の落とし穴です。

**パッケージ自身の `testing.dart` はいまだに 6.x の API を説明しています。** `FakeSignInBackend` のドキュメントコメントには `GoogleSignIn()` と `setMockMethodCallHandler` が載っています。7.x 向けに更新されておらず、メソッドチャンネル名もプラグインと一致しません。代わりに偽の `GoogleSignInPlatform` を書いて `GoogleSignInPlatform.instance` に代入してください。

## 関連記事

- 同じ形のアップグレードは [Riverpod 2.x から Riverpod 3.0 への移行](/ja/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/)にも現れます。そこでもコンパイルエラーは簡単な部分で、挙動の変化はそうではありません。
- API ではなくエラー値の名前を変えたプラグインのアップグレード: [biometric_signature 10.0.0 と新しい BiometricError の値](/ja/2026/02/biometric_signature-10-0-0-simpleprompt-is-the-feature-new-biometricerror-values-are-the-real-breaking-change-flutter-3-x/)。
- サインインは長い非同期の切れ目なので、[非同期の切れ目のあとに mounted チェックで setState を守る](/ja/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/)方法は、いま書き換えているコードにそのまま当てはまります。
- プラグイン更新で iOS のビルドも壊れた場合は、[CocoaPods could not find compatible versions for pod](/ja/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/) から始めてください。
- こうした移行の間もアプリを複数の SDK でビルド可能に保つには、[1 つの CI パイプラインから複数の Flutter バージョンを対象にする](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)を参照してください。

## 参照

- [pub.dev の google_sign_in](https://pub.dev/packages/google_sign_in)、バージョン 7.2.0、2025-09-17 公開。パッケージ内に同梱される `MIGRATION.md` が 6.x から 7.x への正式な対応表です。
- [google_sign_in の変更履歴](https://pub.dev/packages/google_sign_in/changelog)。7.0.0 の破壊的変更一覧と、7.1.0 での `GoogleSignInExceptionCode` エクスポート修正について。
- [pub.dev の google_sign_in_android](https://pub.dev/packages/google_sign_in_android)。README に `serverClientId` の要件と、`canceled` が設定ミスを意味しうる挙動が記載されています。
- Android Developers の [About the migration from legacy Google Sign-In](https://developer.android.com/identity/sign-in/legacy-gsi-migration)。
- [Streamlining Android authentication: Credential Manager replaces legacy APIs](https://android-developers.googleblog.com/2024/09/streamlining-android-authentication-credential-manager-replaces-legacy-apis.html)、プラグイン刷新の背景となった 2024 年 9 月の発表。

上記のエラー文字列、バージョン解決、呼び出し順序はすべて Flutter 3.44.2 と Dart 3.12.2 でローカルに再現したものです。
