---
title: "biometric_signature 10.0.0: `simplePrompt()` это фича, новые значения `BiometricError` это настоящий breaking change (Flutter 3.x)"
description: "biometric_signature 10.0.0 добавляет simplePrompt() и новые значения BiometricError. Как обработать breaking change и подстраховать ваши auth-флоу на Flutter 3.x на будущее."
pubDate: 2026-02-07
tags:
  - "dart"
  - "flutter"
lang: "ru"
translationOf: "2026/02/biometric_signature-10-0-0-simpleprompt-is-the-feature-new-biometricerror-values-are-the-real-breaking-change-flutter-3-x"
translatedBy: "claude"
translationDate: 2026-04-29
---
**6 февраля 2026 года** Flutter-пакет **`biometric_signature`** опубликовал **v10.0.0**. Changelog кажется небольшим, но он навязывает реальное решение в вашем приложении: трактовать ли неудачи биометрии как замкнутый набор исходов или писать UI авторизации устойчивым к новым состояниям платформы?

Для современных приложений на **Flutter 3.x** это важно, потому что обновления зависимостей выходят часто, а биометрические флоу один из самых быстрых способов отгрузить регрессию в прод.

## Что вошло в 10.0.0

Внимания заслуживают два пункта:

-   **Возможность**: `simplePrompt()` для лёгкой биометрической аутентификации без криптографических операций.
-   **Breaking**: новые значения enum `BiometricError`. Если вы используете исчерпывающие `switch`, придётся обработать:
    -   `securityUpdateRequired`
    -   `notSupported`
    -   `systemCanceled`
    -   `promptError`

## Ловушка миграции: исчерпывающий `switch` по кодам ошибок

Если ваш код был написан в стиле "обработаем все известные значения и хватит", 10.0.0 либо сломает сборку (в зависимости от ваших правил анализа), либо отправит новые значения в общий "unknown"-карман, что часто даёт неверный UX.

Исправление простое: сохраните строгую обработку, но добавьте безопасную ветку fallback.

Вот шаблон, хорошо работающий с новым API `simplePrompt()`:

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

Цель не "биометрия всегда работает". Цель в предсказуемом поведении, когда она не работает.

## Когда выбирать `simplePrompt()` против подписей

Используйте `simplePrompt()`, когда нужна только проверка присутствия и блокировка UI (разблокировка после таймаута бездействия, открытие настроек, повторная аутентификация перед показом PII). Используйте API подписей, когда требуется бэкенд-проверяемое доказательство через ключи, привязанные к аппаратному обеспечению.

Иными словами: перестаньте трактовать биометрию как булево. Трактуйте её как набор состояний, способный эволюционировать вместе с обновлениями ОС.

Источники:

-   Страница пакета: [https://pub.dev/packages/biometric_signature](https://pub.dev/packages/biometric_signature)
-   Changelog (запись 10.0.0): [https://pub.dev/packages/biometric_signature/changelog](https://pub.dev/packages/biometric_signature/changelog)
