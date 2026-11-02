---
title: "Migre de FutureBuilder para um AsyncNotifier do Riverpod no Flutter (flutter_riverpod 3.3.2)"
description: "Migração de FutureBuilder para Riverpod 3 AsyncNotifier com family manual testada, duração de cache e repetição explícitas e mutações seguras."
pubDate: 2026-06-18
updatedDate: 2026-11-02
template: migration
tags:
  - "migration"
  - "flutter"
  - "riverpod"
lang: "pt-br"
translationOf: "2026/06/migrate-from-futurebuilder-to-a-riverpod-asyncnotifier-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-18
---

Mova uma requisição de `FutureBuilder` para `AsyncNotifier` quando vários widgets precisarem compartilhar estado ou quando quiser centralizar mutações. A migração é opcional: um Future armazenado e exclusivo de um widget continua adequado para `FutureBuilder`. O problema é criar uma requisição nova em `build()`, não o próprio widget.

O exemplo usa a API manual do Riverpod 3 com **flutter_riverpod 3.3.2**, verificada em **Flutter 3.44.8 / Dart 3.12.2**. Não usa geração de código. Os dois blocos Dart pertencem ao mesmo arquivo. Fixe `flutter_riverpod: 3.3.2` para reproduzir a versão testada; não há afirmação de que seja a mais recente.

## Mover a requisição e a mutação para um provedor

`UserRepository` define o contrato com a aplicação. Implemente-o com seu cliente de API e sobrescreva `userRepositoryProvider` no `ProviderScope` raiz. O padrão lança um erro de propósito para deixar visível uma implementação ausente. Nos testes, use um fake em memória.

No Riverpod 3, um notifier family manual estende `AsyncNotifier<User>`, recebe o ID no construtor e implementa `build()` sem parâmetros. `FamilyAsyncNotifier<User, String>` pertence à API antiga. O provedor abaixo ativa descarte automático e desativa novas tentativas automáticas para que o botão Retry controle a recuperação do exemplo.

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

class User {
  const User(this.name);
  final String name;
}

abstract class UserRepository {
  Future<User> fetchUser(String id);
  Future<void> rename(String id, String name);
}

final userRepositoryProvider = Provider<UserRepository>(
  (ref) => throw UnimplementedError('Override with your repository'),
);

final profileControllerProvider =
    AsyncNotifierProvider.autoDispose.family<ProfileController, User, String>(
  ProfileController.new,
  retry: (retryCount, error) => null,
);

class ProfileController extends AsyncNotifier<User> {
  ProfileController(this.userId);
  final String userId;

  @override
  Future<User> build() {
    return ref.watch(userRepositoryProvider).fetchUser(userId);
  }

  Future<void> rename(String newName) async {
    if (state.isLoading) return;
    final repo = ref.read(userRepositoryProvider);
    state = const AsyncLoading();
    final next = await AsyncValue.guard(() async {
      await repo.rename(userId, newName);
      return repo.fetchUser(userId);
    });
    if (!ref.mounted) return;
    state = next;
  }
}
```

`AsyncValue.guard` transforma falhas da mutação em estado de erro. Após o await, `ref.mounted` evita escrever em um notifier descartado. A verificação de carregamento impede renomeações simultâneas por esse método; não é uma transação nem cancelamento HTTP.

## Exibir o estado compartilhado

Substitua a tela por este `ConsumerWidget`. `ref.watch` assina durante build; callbacks de botões usam `ref.read` ou `ref.invalidate`. `skipLoadingOnRefresh: false` mostra carregamento após invalidar mesmo se houver dados anteriores.

```dart
class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key, required this.userId});
  final String userId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return ref.watch(profileControllerProvider(userId)).when(
      skipLoadingOnRefresh: false,
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (error, stack) => Column(
        children: [
          Text('Failed: $error'),
          ElevatedButton(
            onPressed: () => ref.invalidate(profileControllerProvider(userId)),
            child: const Text('Retry'),
          ),
        ],
      ),
      data: (user) => Column(
        children: [
          Text(user.name),
          ElevatedButton(
            onPressed: () => ref
                .read(profileControllerProvider(userId).notifier)
                .rename('Grace'),
            child: const Text('Rename'),
          ),
        ],
      ),
    );
  }
}
```

## Definir o tempo de vida do resultado

- Widgets com a mesma chave family no mesmo scope compartilham o estado ativo. As chaves precisam de igualdade e `hashCode` estáveis.
- `.autoDispose` permite descartar o estado quando não restam listeners. Voltar após o descarte faz uma nova busca. Mudanças nas dependências e invalidações também podem executar `build()` novamente.
- Sem geração de código, o descarte automático é opcional. Provedores gerados com `@riverpod` o ativam por padrão. Esses padrões não são equivalentes. Use `ref.keepAlive()` ou uma política de cache apenas quando quiser reter o estado.
- Riverpod 3 repete automaticamente falhas elegíveis de inicialização por padrão. O exemplo desativa isso com `retry: (_, _) => null`; escolha a política apropriada para sua aplicação. `AsyncValue.guard` não repete métodos de mutação automaticamente.
- `ref.onDispose` é um hook, não um cancelamento automático de requisições. Conecte-o ao mecanismo de cancelamento ou limpeza do cliente HTTP quando necessário.

Um switch somente sobre `AsyncData` e `AsyncError` não garante manter dados antigos visíveis durante uma atualização. Escolha a apresentação explicitamente; `.when()` também oferece opções de carregamento e refresh. Em pull-to-refresh, aguarde `ref.refresh(profileControllerProvider(userId).future)` para encerrar o gesto junto com a requisição.

## Verificar a migração

O código corrigido passou pela análise e por testes de providers/widgets para leituras compartilhadas, invalidação, descarte e nova busca, erro e recuperação manual, renomeação com sucesso e falha e conclusão após descarte. Os testes usam um repositório fake; não validam seu serviço nem sua autenticação. Execute verificações equivalentes na aplicação:

```bash
flutter analyze
flutter test
```

Migre uma tela por vez. Para reverter, restaure a implementação com Future armazenado e remova o provedor sem uso. Evite criar um novo Future em cada build.

**Correção em 2 de novembro de 2026:** substituída a API family do Riverpod 2, explicitadas as políticas de descarte e repetição, corrigidas as afirmações sobre navegação, cache e cancelamento e adicionada a verificação do ciclo de vida após await. A antiga documentação de versão 2 não é mais apresentada como Riverpod 3.

## Fontes e leituras relacionadas

- [Flutter: FutureBuilder](https://api.flutter.dev/flutter/widgets/FutureBuilder-class.html)
- [Riverpod 3: migration](https://riverpod.dev/docs/3.0_migration)
- [Riverpod: families](https://riverpod.dev/docs/concepts2/family)
- [Riverpod: automatic disposal](https://riverpod.dev/docs/concepts2/auto_dispose)
- [Riverpod: automatic retry](https://riverpod.dev/docs/concepts2/retry)
- [Riverpod: request cancellation](https://riverpod.dev/docs/how_to/cancel)
- [flutter_riverpod 3.3.2](https://pub.dev/packages/flutter_riverpod/versions/3.3.2)

- [FutureBuilder / Future](/pt-br/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/)
- [AsyncValue](/pt-br/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)
- [Ref / dispose](/pt-br/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/)
- [provider → Riverpod](/pt-br/2026/06/migrate-from-provider-to-riverpod-in-flutter/)
- [FutureBuilder / Riverpod](/pt-br/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/)
