---
title: "biometric_signature 10.0.0: `simplePrompt()` ist die Funktion, die neuen `BiometricError`-Werte sind der eigentliche Breaking Change (Flutter 3.x)"
description: "biometric_signature 10.0.0 fügt simplePrompt() und neue BiometricError-Werte hinzu. So gehen Sie mit dem Breaking Change um und machen Ihre Auth-Flows in Flutter 3.x zukunftssicher."
pubDate: 2026-02-07
tags:
  - "dart"
  - "flutter"
lang: "de"
translationOf: "2026/02/biometric_signature-10-0-0-simpleprompt-is-the-feature-new-biometricerror-values-are-the-real-breaking-change-flutter-3-x"
translatedBy: "claude"
translationDate: 2026-04-29
---
Am **6. Februar 2026** hat das Flutter-Paket **`biometric_signature`** die **v10.0.0** veröffentlicht. Das Changelog wirkt klein, erzwingt aber eine echte Entscheidung in Ihrer App: Behandeln Sie biometrische Fehler als geschlossene Menge von Ergebnissen oder schreiben Sie Ihre Auth-UI so, dass sie gegen neue Plattformzustände robust ist?

Das ist für moderne Apps unter **Flutter 3.x** wichtig, weil Dependency-Updates häufig kommen und biometrische Flows einer der schnellsten Wege sind, eine Regression in Produktion zu schicken.

## Was in 10.0.0 ausgeliefert wurde

Zwei Punkte verdienen Ihre Aufmerksamkeit:

-   **Funktion**: `simplePrompt()` für leichtgewichtige biometrische Authentifizierung ohne kryptografische Operationen.
-   **Breaking**: neue `BiometricError`-Enum-Werte. Wenn Sie erschöpfende Switches nutzen, müssen Sie behandeln:
    -   `securityUpdateRequired`
    -   `notSupported`
    -   `systemCanceled`
    -   `promptError`

## Die Migrationsfalle: erschöpfender `switch` auf Fehlercodes

Wurde Ihr Code im Stil "alle bekannten Werte behandeln und fertig" geschrieben, wird 10.0.0 entweder den Build brechen (je nach Ihren Analyseregeln) oder die neuen Werte in einen generischen "unknown"-Eimer leiten, der oft die falsche UX produziert.

Die Lösung ist einfach: Behalten Sie die strikte Behandlung bei, aber fügen Sie einen sicheren Fallback-Zweig hinzu.

Hier ist ein Muster, das mit der neuen `simplePrompt()`-API gut funktioniert:

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

Ihr Ziel ist nicht "Biometrie funktioniert immer". Ihr Ziel ist vorhersagbares Verhalten, wenn sie nicht funktioniert.

## Wann `simplePrompt()` vs Signaturen wählen

Nutzen Sie `simplePrompt()`, wenn Sie nur Anwesenheitsprüfung und UI-Gating brauchen (Entsperren nach Idle-Timeout, Einstellungen öffnen, Reauth vor dem Anzeigen von PII). Nutzen Sie die Signatur-APIs, wenn Sie Backend-verifizierbaren Nachweis über hardware-gestützte Schlüssel benötigen.

Mit anderen Worten: Hören Sie auf, Biometrie als Boolean zu behandeln. Behandeln Sie sie als eine Menge von Zuständen, die sich mit OS-Updates weiterentwickeln kann.

Quellen:

-   Paket-Seite: [https://pub.dev/packages/biometric_signature](https://pub.dev/packages/biometric_signature)
-   Changelog (Eintrag zu 10.0.0): [https://pub.dev/packages/biometric_signature/changelog](https://pub.dev/packages/biometric_signature/changelog)
