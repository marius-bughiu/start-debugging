---
title: "biometric_signature 10.0.0: `simplePrompt()` es la característica, los nuevos valores de `BiometricError` son el verdadero breaking change (Flutter 3.x)"
description: "biometric_signature 10.0.0 agrega simplePrompt() y nuevos valores de BiometricError. Aquí está cómo manejar el breaking change y blindar tus flujos de auth en Flutter 3.x para el futuro."
pubDate: 2026-02-07
tags:
  - "dart"
  - "flutter"
lang: "es"
translationOf: "2026/02/biometric_signature-10-0-0-simpleprompt-is-the-feature-new-biometricerror-values-are-the-real-breaking-change-flutter-3-x"
translatedBy: "claude"
translationDate: 2026-04-29
---
El **6 de febrero de 2026**, el paquete de Flutter **`biometric_signature`** publicó la **v10.0.0**. El changelog parece pequeño, pero fuerza una decisión real en tu app: ¿tratas las fallas biométricas como un conjunto cerrado de resultados, o escribes tu UI de auth para que sea resiliente a nuevos estados de la plataforma?

Esto importa para apps modernas en **Flutter 3.x** porque las actualizaciones de dependencias son frecuentes, y los flujos biométricos son una de las formas más rápidas de mandar una regresión a producción.

## Qué llegó en 10.0.0

Hay dos cosas que merecen tu atención:

-   **Característica**: `simplePrompt()` para autenticación biométrica liviana sin operaciones criptográficas.
-   **Breaking**: nuevos valores del enum `BiometricError`. Si usas `switch` exhaustivos, debes manejar:
    -   `securityUpdateRequired`
    -   `notSupported`
    -   `systemCanceled`
    -   `promptError`

## La trampa de la migración: `switch` exhaustivo sobre códigos de error

Si tu código estaba escrito al estilo "maneja todos los valores conocidos y listo", la 10.0.0 o bien te va a romper la compilación (según tus reglas de análisis), o va a enrutar los nuevos valores a un bucket genérico de "desconocido" que muchas veces produce la UX equivocada.

La solución es simple: mantén el manejo estricto, pero agrega una rama de fallback segura.

Aquí hay un patrón que funciona bien con la nueva API `simplePrompt()`:

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

No estás buscando que "la biometría siempre funcione". Estás buscando comportamiento predecible cuando no funciona.

## Cuándo elegir `simplePrompt()` vs firmas

Usa `simplePrompt()` cuando solo necesitas verificar presencia y bloquear UI (desbloqueo tras tiempo de inactividad, abrir ajustes, reauth antes de mostrar PII). Usa las APIs de firma cuando necesitas prueba verificable desde el backend mediante claves respaldadas por hardware.

En otras palabras: deja de tratar la biometría como un booleano. Trátala como un conjunto de estados que puede evolucionar con las actualizaciones del SO.

Fuentes:

-   Página del paquete: [https://pub.dev/packages/biometric_signature](https://pub.dev/packages/biometric_signature)
-   Changelog (entrada de 10.0.0): [https://pub.dev/packages/biometric_signature/changelog](https://pub.dev/packages/biometric_signature/changelog)
