---
title: "Corrigir: LateInitializationError: Field '...' has not been initialized no Flutter"
description: "Corrija leituras de campos late não inicializados no Flutter com inicialização síncrona ou estados explícitos de carga, erro e dados e código testado."
pubDate: 2026-06-24
updatedDate: 2026-11-02
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
lang: "pt-br"
translationOf: "2026/06/fix-lateinitializationerror-field-has-not-been-initialized-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-24
---

Ler um campo `late` ainda não atribuído causa `LateInitializationError`. Localize a leitura no primeiro frame do seu código e veja qual caminho deveria ter atribuído o campo antes. `late` não espera uma operação assíncrona terminar. Os exemplos foram verificados com Flutter 3.44.8 e Dart 3.12.2.

## Reproduzir o erro

Este programa compila, mas falha ao ler `name`:

```dart
class Profile {
  late String name;
}

void main() {
  print(Profile().name);
}
```

A VM do Dart mostra `LateInitializationError: Field 'name' has not been initialized.` É uma mensagem de diagnóstico, não uma classe pública de `dart:core` que você precise importar ou capturar. Corrija a inicialização ausente.

## Representar carregamento, erro e dados

Uma requisição iniciada em `initState()` pode continuar pendente no primeiro `build()`. Este widget completo usa estado nullable e trata sucesso e falha. Passe sua função assíncrona como `loadName`:

```dart
import 'package:flutter/material.dart';

class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key, required this.loadName});
  final Future<String> Function() loadName;

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  String? _name;
  Object? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final name = await widget.loadName();
      if (!mounted) return;
      setState(() => _name = name);
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = error);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null) return Text('Failed: $_error');
    final name = _name;
    if (name == null) return const CircularProgressIndicator();
    return Text(name);
  }
}
```

O exemplo carrega uma vez por instância de `State`. Se a requisição depende de entradas variáveis do widget, trate mudanças em `didUpdateWidget` ou use um widget/provedor com a chave adequada. As verificações de `mounted` impedem atualizar um estado descartado; não cancelam a requisição. Um `FutureBuilder` com Future armazenado ou um `AsyncValue` também serve. O campo que guarda o Future pode ser `late final` se for atribuído antes da leitura; o resultado pode chegar depois.

## Inicializar conforme a dependência

- **Valor síncrono:** atribua antes da primeira leitura, normalmente em `initState()` quando precisar de `widget`. Libere um `TextEditingController` em `dispose()`.
- **Valor adiado:** `late final value = compute();` executa o inicializador no primeiro acesso. Um inicializador late de instância pode acessar membros da instância, inclusive `widget` em um `State`; o primeiro acesso precisa respeitar o ciclo de vida. O inicializador ainda pode lançar um erro ou entrar em recursão.
- **Dependência herdada:** chamadas que registram dependências, como `Theme.of(context)`, pertencem a `build()` ou `didChangeDependencies()`, não a `initState()`. Esse hook roda antes do primeiro build e quando as dependências mudam. A restrição é sobre registrar dependências, não sobre todo uso de `context`.

## Erros semelhantes e correções enganosas

Atribuir duas vezes a um campo `late final` produz a variante «already initialized». Remova a atribuição duplicada ou use um campo mutável se a reatribuição for intencional. `late` não desliga todas as verificações do analisador: o Dart detecta variáveis locais late definitivamente não atribuídas e algumas atribuições repetidas a locais late final. As verificações em execução continuam necessárias quando a análise estática não consegue garantir o fluxo. Não são assertions exclusivas de debug; a mensagem pode variar por backend e modo de compilação.

O valor precisa estar pronto antes da leitura, ou o estado pendente deve ser explícito. Um `await` não torna `late` incorreto se todos os consumidores aguardarem a preparação primeiro; o problema é a leitura prematura pelo widget.

**Correção em 2 de novembro de 2026:** corrigidas as afirmações sobre o analisador, acesso adiado a membros da instância, dependências herdadas e diagnósticos em release; removida a referência a uma classe pública inexistente. O widget revisado passou pela análise e por testes de sucesso, erro e descarte.

## Fontes e leituras relacionadas

- [Dart: late variables](https://dart.dev/language/variables#late-variables)
- [Dart: definitely_unassigned_late_local_variable](https://dart.dev/tools/diagnostics/definitely_unassigned_late_local_variable)
- [Flutter: initState](https://api.flutter.dev/flutter/widgets/State/initState.html)
- [Flutter: didChangeDependencies](https://api.flutter.dev/flutter/widgets/State/didChangeDependencies.html)
- [Dart: null safety](https://dart.dev/null-safety/understanding-null-safety#late-variables)

- [BuildContext / await](/pt-br/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/)
- [AsyncValue](/pt-br/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)
- [TextEditingController / dispose](/pt-br/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/)
- [Controllers / dispose](/pt-br/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)
- [Flutter 2 → 3.x / null safety](/pt-br/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/)
