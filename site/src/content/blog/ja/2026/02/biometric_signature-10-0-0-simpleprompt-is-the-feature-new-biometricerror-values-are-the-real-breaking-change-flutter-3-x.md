---
title: "biometric_signature 10.0.0: `simplePrompt()` が目玉機能、新しい `BiometricError` 値が本当の破壊的変更 (Flutter 3.x)"
description: "biometric_signature 10.0.0 は simplePrompt() と新しい BiometricError 値を追加します。破壊的変更への対処と、Flutter 3.x の認証フローを将来にわたって守るための方法です。"
pubDate: 2026-02-07
tags:
  - "dart"
  - "flutter"
lang: "ja"
translationOf: "2026/02/biometric_signature-10-0-0-simpleprompt-is-the-feature-new-biometricerror-values-are-the-real-breaking-change-flutter-3-x"
translatedBy: "claude"
translationDate: 2026-04-29
---
**2026年2月6日**、Flutter パッケージ **`biometric_signature`** が **v10.0.0** を公開しました。changelog は小さく見えますが、アプリ側に本物の判断を迫ります。生体認証の失敗を閉じた結果集合として扱うのか、それともプラットフォームの新しい状態に強い認証 UI を書くのか、という選択です。

これが **Flutter 3.x** 上のモダンなアプリにとって重要なのは、依存関係の更新が頻繁に来るからであり、生体認証フローは本番にリグレッションを送り込む最速ルートのひとつだからです。

## 10.0.0 で出荷されたもの

注目すべき項目は2つです:

-   **機能**: 暗号操作なしの軽量な生体認証用 `simplePrompt()`。
-   **破壊的変更**: 新しい `BiometricError` enum 値。網羅的な switch を使っているなら、次を扱う必要があります:
    -   `securityUpdateRequired`
    -   `notSupported`
    -   `systemCanceled`
    -   `promptError`

## マイグレーションの罠: エラーコードに対する網羅的な `switch`

「既知の値をすべて処理して終わり」というスタイルでコードが書かれていた場合、10.0.0 は (解析ルール次第で) ビルドを失敗させるか、新しい値を汎用の「unknown」バケットに流し込みます。後者はしばしば UX を取り違えます。

修正は簡単です。厳密な扱いはそのままに、安全なフォールバック分岐を追加します。

新しい `simplePrompt()` API でうまく機能するパターンはこちらです:

```dart
import 'package:biometric_signature/biometric_signature.dart';

final bio = BiometricSignature();

Future<bool> reauthForSensitiveScreen() async {
  final result = await bio.simplePrompt(
    promptMessage: 'Authenticate to continue',
  );

  if (result.success == true) return true;

  switch (result.code) {
    case BiometricError.userCanceled:
    case BiometricError.systemCanceled:
      // Soft failure: user backed out or OS interrupted.
      return false;

    case BiometricError.notSupported:
    case BiometricError.notAvailable:
      // Device/OS cannot do what you asked. Offer PIN/password fallback.
      return false;

    case BiometricError.securityUpdateRequired:
      // Treat this as “blocked until the OS catches up”.
      return false;

    case BiometricError.promptError:
      // Prompt could not be shown. Log and fall back.
      return false;

    default:
      // Future-proofing: new values can appear again.
      return false;
  }
}
```

目指すのは「生体認証は常に動く」ではありません。動かないときに予測可能に振る舞うことです。

## `simplePrompt()` と署名のどちらを選ぶか

存在確認と UI のゲーティング (アイドル後のロック解除、設定を開く、PII を見せる前の再認証) だけが必要なら `simplePrompt()` を使ってください。バックエンドで検証可能な、ハードウェア裏付けの鍵による証明が必要なときは署名 API を使ってください。

言い換えると、生体認証を真偽値として扱うのをやめましょう。OS のアップデートに応じて変化しうる状態の集合として扱ってください。

参考:

-   パッケージページ: [https://pub.dev/packages/biometric_signature](https://pub.dev/packages/biometric_signature)
-   changelog (10.0.0 のエントリ): [https://pub.dev/packages/biometric_signature/changelog](https://pub.dev/packages/biometric_signature/changelog)
