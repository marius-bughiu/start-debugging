---
title: "biometric_signature 10.0.0: `simplePrompt()` is the feature, new `BiometricError` values are the real breaking change (Flutter 3.x)"
description: "On Feb 6, 2026, the Flutter package biometric_signature published v10.0.0. The changelog looks small, but it forces a real decision in your app: do you treat biometric failures as a closed set of outcomes, or do you write your auth UI to be resilient to new platform states? This matters for modern apps on Flutter…"
pubDate: 2026-02-07
tags:
  - "dart"
  - "flutter"
---
On **Feb 6, 2026**, the Flutter package **`biometric_signature`** published **v10.0.0**. The changelog looks small, but it forces a real decision in your app: do you treat biometric failures as a closed set of outcomes, or do you write your auth UI to be resilient to new platform states?

This matters for modern apps on **Flutter 3.x** because dependency updates are frequent, and biometric flows are one of the fastest ways to ship a production regression.

## What shipped in 10.0.0

Two items are worth your attention:

-   **Feature**: `simplePrompt()` for lightweight biometric authentication without cryptographic operations.
-   **Breaking**: new `BiometricError` enum values. If you use exhaustive switches, you must handle:
-   `securityUpdateRequired`
-   `notSupported`
-   `systemCanceled`
-   `promptError`

## The migration trap: exhaustive `switch` on error codes

If your code was written like “handle all known values and we are done”, 10.0.0 will either fail the build (depending on your analysis rules) or it will route new values into a generic “unknown” bucket that often produces the wrong UX.

The fix is simple: keep the strict handling, but add a safe fallback branch.

Here is a pattern that works well with the new `simplePrompt()` API:

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

You are not aiming for “biometrics always work”. You are aiming for predictable behavior when they do not.

## When to pick `simplePrompt()` vs signatures

Use `simplePrompt()` when you just need presence verification and UI gating (unlock after idle timeout, open settings, reauth before showing PII). Use the signature APIs when you need backend-verifiable proof via hardware-backed keys.

In other words: stop treating biometrics as a boolean. Treat it as a set of states that can evolve with OS updates.

Sources:

-   Package page: [https://pub.dev/packages/biometric_signature](https://pub.dev/packages/biometric_signature)
-   Changelog (10.0.0 entry): [https://pub.dev/packages/biometric_signature/changelog](https://pub.dev/packages/biometric_signature/changelog)
