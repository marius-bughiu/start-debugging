---
title: "biometric_signature 10.0.0: `simplePrompt()` é o recurso, os novos valores de `BiometricError` são o real breaking change (Flutter 3.x)"
description: "O biometric_signature 10.0.0 adiciona simplePrompt() e novos valores de BiometricError. Veja como tratar o breaking change e blindar seus fluxos de auth no Flutter 3.x para o futuro."
pubDate: 2026-02-07
tags:
  - "dart"
  - "flutter"
lang: "pt-br"
translationOf: "2026/02/biometric_signature-10-0-0-simpleprompt-is-the-feature-new-biometricerror-values-are-the-real-breaking-change-flutter-3-x"
translatedBy: "claude"
translationDate: 2026-04-29
---
Em **6 de fevereiro de 2026**, o pacote Flutter **`biometric_signature`** publicou a **v10.0.0**. O changelog parece pequeno, mas força uma decisão real no seu app: você trata falhas biométricas como um conjunto fechado de resultados, ou escreve sua UI de auth para ser resiliente a novos estados da plataforma?

Isso importa para apps modernos no **Flutter 3.x** porque atualizações de dependências são frequentes, e fluxos biométricos são uma das formas mais rápidas de mandar uma regressão pra produção.

## O que veio na 10.0.0

Dois itens merecem sua atenção:

-   **Recurso**: `simplePrompt()` para autenticação biométrica leve sem operações criptográficas.
-   **Breaking**: novos valores do enum `BiometricError`. Se você usa `switch` exaustivo, precisa tratar:
    -   `securityUpdateRequired`
    -   `notSupported`
    -   `systemCanceled`
    -   `promptError`

## A armadilha da migração: `switch` exaustivo sobre códigos de erro

Se seu código estava escrito no estilo "trata todos os valores conhecidos e pronto", a 10.0.0 vai ou quebrar o build (dependendo das suas regras de análise) ou rotear os novos valores para um bucket genérico de "desconhecido" que costuma produzir a UX errada.

A correção é simples: mantenha o tratamento estrito, mas adicione um galho de fallback seguro.

Aqui está um padrão que funciona bem com a nova API `simplePrompt()`:

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

Você não está mirando em "biometria sempre funciona". Está mirando em comportamento previsível quando não funciona.

## Quando escolher `simplePrompt()` vs assinaturas

Use `simplePrompt()` quando você só precisa de verificação de presença e gating de UI (desbloqueio após timeout de inatividade, abrir configurações, reauth antes de mostrar PII). Use as APIs de assinatura quando você precisa de prova verificável pelo backend via chaves apoiadas em hardware.

Em outras palavras: pare de tratar biometria como um booleano. Trate como um conjunto de estados que pode evoluir com atualizações do SO.

Fontes:

-   Página do pacote: [https://pub.dev/packages/biometric_signature](https://pub.dev/packages/biometric_signature)
-   Changelog (entrada da 10.0.0): [https://pub.dev/packages/biometric_signature/changelog](https://pub.dev/packages/biometric_signature/changelog)
