---
title: "Cloud Functions for Firebase が Dart に対応 (実験的)"
description: "Firebase は 2026-05-06 に Cloud Functions の Dart 実験サポートを公開しました。HTTPS と callable トリガー、AOT のコールドスタート、Firebase CLI がコンパイルを担います。"
pubDate: 2026-05-19
tags:
  - "dart"
  - "flutter"
  - "firebase"
  - "cloud-functions"
  - "backend"
lang: "ja"
translationOf: "2026/05/dart-cloud-functions-firebase-experimental"
translatedBy: "claude"
translationDate: 2026-05-19
---

2026-05-06、Firebase チームは Google I/O 2026 を数日後に控え、Cloud Functions への [Dart の実験的サポートを発表しました](https://firebase.blog/posts/2026/05/dart-functions-exp)。やむなく TypeScript でバックエンドを書いてきた Flutter チームにとって、これは Firebase 上で Dart のみのスタックを構築するための初めての公式な道であり、Firebase CLI がコンパイルからデプロイまでを一貫して引き受けます。

## Flutter チームにとってなぜ重要か

現状、典型的な Flutter アプリは Node.js または Python で書かれた Cloud Functions にサーバーロジックを送り出します。これは 2 つの言語、2 つの型システム、2 セットのバリデーションルールを意味し、同じドメインオブジェクトを両側でモデリングするたびに絶え間ないコンテキストスイッチが発生します。ネイティブな Dart 関数を使えば、共有のデータクラス、バリデーター、結果型を 1 つの `package:` にまとめ、アプリ側とバックエンド側の両方から翻訳レイヤーなしで使えます。

Firebase チームはコールドスタートも意図的な設計判断として強調しています。Firebase CLI が `dart compile exe` でローカルに関数をコンパイルし、AOT バイナリを直接 Cloud Run にアップロードするため、VM のウォームアップフェーズがありません。ローンチ記事の初期数値では、コールドスタートは 10 ms 前後と、Node.js 上の TypeScript の典型値を大きく下回っています。

## 前提条件と実験フラグ

[公式の入門ガイド](https://firebase.google.com/docs/functions/start-dart) によれば、以下が必要です。

- Dart SDK 3.9 以上
- Firebase CLI 15.15.0 以上

この機能は実験フラグの背後にあり、マシンごとに 1 回だけ有効化します。

```bash
firebase experiments:enable dartfunctions
firebase init functions
```

init ウィザードが言語を尋ねるとき、JavaScript、TypeScript、Python に並んで Dart が表示されます。

## 最小の HTTPS 関数

生成されるスケルトンには HTTPS トリガーをひとつ持つ `functions/bin/server.dart` が含まれます。形は JS SDK に近いものの、慣用的な Dart として読めます。

```dart
import 'package:firebase_functions/firebase_functions.dart';

void main(List<String> args) {
  runFunctions((firebase) {
    firebase.https.onRequest(
      name: 'hello',
      (request) async {
        return Response.ok('Hello from Dart!');
      },
    );
  });
}
```

いつものコマンドでデプロイすれば、CLI がバイナリをコンパイルしてアップロードしてくれます。

```bash
firebase deploy --only functions
```

ローカルのイテレーションでは、`firebase emulators:start` が Node.js のときと同様に動作します。Dart ファイルへのホット編集はエミュレートされた関数をリロードし、スイート全体を再起動する必要はありません。

## まだできないこと

これは実験的なリリースで、粗削りな部分は明示されています。ドキュメントから:

- デプロイできるのは HTTPS (`onRequest`) と callable (`onCall`) のトリガーのみです。Firestore、Auth、Pub/Sub、スケジュール済みトリガーはまだサポートされていません。
- デプロイ済みの callable 関数は、クライアント SDK の `httpsCallable` ヘルパー経由では呼び出せません。代わりに完全な Cloud Run URL を指定して `httpsCallableFromURL` を使う必要があります。
- このプレビュー期間中、Dart 関数は Firebase Console には表示されません。代わりに Cloud Console に表示されます。

バックエンドが主に HTTP エンドポイントで動いていて、チームがすでに Dart に深く入り込んでいるなら、これだけで実サービスの移植を始めるには十分です。Firestore トリガーやスケジュールジョブに依存している場合は、[firebase-functions-dart リポジトリ](https://github.com/firebase/firebase-functions-dart) と [Dart Admin SDK](https://pub.dev/packages/firebase_admin) を追いながら、当面は Node.js ランタイムに留まるのが妥当です。

詳細は Google I/O 2026 でさらに発表される見込みで、Flutter チームは本発表に紐づく [ブレイクアウトセッション](https://io.google/2026/explore/pa-keynote-12) を予定しています。
