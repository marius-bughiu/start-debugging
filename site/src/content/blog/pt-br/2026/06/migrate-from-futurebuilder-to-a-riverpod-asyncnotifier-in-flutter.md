---
title: "Migre de FutureBuilder para um AsyncNotifier do Riverpod no Flutter (flutter_riverpod 3.3.2)"
description: "Uma migração passo a passo de um widget FutureBuilder inline para um AsyncNotifier do Riverpod em um app Flutter real: tire o trabalho assíncrono do build, exponha-o como um provider, renderize com .when() ou correspondência de padrões com switch, e adicione métodos de refresh e mutação. Testado no Flutter 3.44, Dart 3.x, flutter_riverpod 3.3.2."
pubDate: 2026-06-18
updatedDate: 2026-06-18
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

Mover uma tela de `FutureBuilder` para um `AsyncNotifier` do Riverpod normalmente é um trabalho de 30 a 60 minutos por tela, e a maior parte desse tempo é gasta apagando código em vez de escrevê-lo. O que muda: o Future que você costumava criar dentro do `build` vai para um provider, o widget perde seu boilerplate de `StatefulWidget`, e qualquer lógica manual de retentativa com `setState` é substituída por `ref.invalidate`. Vale a pena fazer no momento em que um segundo widget precisa dos mesmos dados, você quer cache entre navegações, ou você precisa disparar um refresh de algum lugar diferente do widget que é dono do `FutureBuilder`. Se uma tela genuinamente é dona de um Future de execução única que nada mais toca, deixe-a como um `FutureBuilder` -- essa migração não traz nenhum ganho nesse caso.

Este guia usa Flutter 3.44, Dart 3.x e `flutter_riverpod` 3.3.2. Os trechos de geração de código assumem `riverpod_annotation` 3.x e `riverpod_generator` 3.x com `build_runner`.

## Por que sair do FutureBuilder

- **O Future deixa de ser recriado a cada rebuild.** Um `FutureBuilder` cujo `future:` é construído inline reexecuta seu trabalho assíncrono cada vez que o pai faz rebuild. Um `AsyncNotifier` compila uma vez e mantém o resultado em cache até você invalidá-lo. (Se você vai continuar no `FutureBuilder` por enquanto, a correção para esse bug específico está coberta em [como evitar que o FutureBuilder recrie seu Future](/pt-br/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/).)
- **Os dados se tornam compartilháveis.** Dois widgets observando o mesmo provider atingem o cache, não duas chamadas de rede separadas.
- **Refresh e mutação ganham um lar de verdade.** Pull-to-refresh, retentativa em erro e atualizações otimistas viram métodos no notifier em vez de ginástica com `setState` no widget.
- **Erros são tipados, não engolidos.** `AsyncValue` carrega `loading`, `data` e `error` (com stack trace) como estados de primeira classe sobre os quais você faz correspondência de padrões.

## O que muda

| Área | Antes (`FutureBuilder`) | Depois (`AsyncNotifier`) | Gravidade |
| --- | --- | --- | --- |
| Onde o Future fica | Criado em `build` ou `initState` | Método `build()` do notifier | alta |
| Tipo do widget | Geralmente `StatefulWidget` | `ConsumerWidget` (stateless) | média |
| Renderização de loading/erro | `snapshot.connectionState` + `snapshot.hasError` | `AsyncValue.when` ou `switch` | média |
| Retentativa | Rebuild + recriar Future | `ref.invalidate(provider)` | baixa |
| Mutações | `setState` após `await` | método + `AsyncValue.guard` | média |
| Cancelamento no dispose | Verificações manuais de `mounted` | Automático via `ref.onDispose` | baixa |

O único item genuinamente de gravidade alta é onde o Future fica: todo o resto decorre de movê-lo.

## Checklist de preparação

- `flutter --version` reporta 3.44 ou posterior, Dart 3.x.
- `flutter_riverpod: ^3.3.2` está no `pubspec.yaml`. Se você quiser geração de código, adicione também `riverpod_annotation: ^3.0.0`, e em `dev_dependencies` adicione `riverpod_generator: ^3.0.0` e `build_runner`.
- Seu app está envolvido em um `ProviderScope` na raiz. Se não estiver, esse é o passo zero:

```dart
// Flutter 3.44, flutter_riverpod 3.3.2
void main() {
  runApp(const ProviderScope(child: MyApp()));
}
```

- Escolha um widget para migrar primeiro. Não converta o app inteiro em um único commit. Faça um teste de fumaça em cada tela conforme avança.

## O ponto de partida: um FutureBuilder inline

Aqui está o padrão do qual estamos migrando. Uma tela de perfil busca um usuário e renderiza três estados manualmente. O bug embutido nela é o clássico: `repo.fetchUser(userId)` roda de novo a cada rebuild porque o Future é criado dentro do `build`.

```dart
// Flutter 3.44, Dart 3.x -- the BEFORE
class ProfileScreen extends StatelessWidget {
  const ProfileScreen({super.key, required this.userId});
  final String userId;

  @override
  Widget build(BuildContext context) {
    final repo = UserRepository();
    return FutureBuilder<User>(
      future: repo.fetchUser(userId), // re-runs on every rebuild
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snapshot.hasError) {
          return Center(child: Text('Failed: ${snapshot.error}'));
        }
        final user = snapshot.data!;
        return Text(user.name);
      },
    );
  }
}
```

## Passos da migração

1. **Declare o provider.** Mova a chamada assíncrona para um notifier. Há duas formas de escrevê-lo; escolha uma e mantenha a consistência em toda a base de código.

**Estilo com geração de código (recomendado para código novo):**

```dart
// flutter_riverpod 3.3.2, riverpod_annotation 3.x
import 'package:riverpod_annotation/riverpod_annotation.dart';

part 'profile_controller.g.dart';

@riverpod
class ProfileController extends _$ProfileController {
  @override
  Future<User> build(String userId) {
    return ref.watch(userRepositoryProvider).fetchUser(userId);
  }
}
```

O parâmetro `userId` no `build` torna isto uma family: `profileControllerProvider(userId)` te dá um notifier em cache por id. Rode o gerador e verifique que ele produz o arquivo `.g.dart` sem erros:

```bash
# verify: the build completes and emits profile_controller.g.dart
dart run build_runner build --delete-conflicting-outputs
```

**Estilo manual (sem geração de código):**

```dart
// flutter_riverpod 3.3.2
final profileControllerProvider =
    AsyncNotifierProvider.family<ProfileController, User, String>(
  ProfileController.new,
);

class ProfileController extends FamilyAsyncNotifier<User, String> {
  @override
  Future<User> build(String userId) {
    return ref.watch(userRepositoryProvider).fetchUser(userId);
  }
}
```

Ambos produzem um provider cujo valor é um `AsyncValue<User>`. O `build` do notifier roda uma vez por `userId` e o resultado fica em cache até ser invalidado. Note que você não constrói mais `UserRepository()` manualmente: injete-o por meio de outro provider para que seja testável e compartilhado.

2. **Converta o widget para um `ConsumerWidget`.** O `StatefulWidget`/`StatelessWidget` vira um `ConsumerWidget`, e o `build` ganha um `WidgetRef`. Leia o provider com `ref.watch`, e então renderize o `AsyncValue`.

```dart
// flutter_riverpod 3.3.2 -- the AFTER
class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key, required this.userId});
  final String userId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final userAsync = ref.watch(profileControllerProvider(userId));
    return userAsync.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (err, stack) => Center(child: Text('Failed: $err')),
      data: (user) => Text(user.name),
    );
  }
}
```

Verifique: faça hot-restart da tela. Ela deve buscar exatamente uma vez. Navegue para fora e de volta -- ela não deve buscar de novo (o cache fica vivo enquanto algo mantiver o provider montado). Esse comportamento de busca única é todo o sentido da migração.

3. **Renderize com correspondência de padrões usando switch (opcional, mas mais limpo).** A correspondência de padrões do Dart 3 lê melhor que `.when()` para alguns times e permite manter dados antigos visíveis durante um refresh. O tratamento completo desses padrões está em [como mostrar estados de loading e erro com AsyncValue](/pt-br/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/), mas a versão curta:

```dart
// Dart 3.x switch over AsyncValue
final userAsync = ref.watch(profileControllerProvider(userId));
return switch (userAsync) {
  AsyncData(:final value) => Text(value.name),
  AsyncError(:final error) => Text('Failed: $error'),
  _ => const Center(child: CircularProgressIndicator()),
};
```

Verifique: isto compila sem aviso de `non-exhaustive switch`. O `_` captura tudo e trata o `AsyncLoading`.

4. **Substitua a retentativa por `ref.invalidate`.** O antigo caminho de retentativa recriava o Future fazendo rebuild. Agora a retentativa é uma linha. Adicione um botão ao ramo de erro:

```dart
// flutter_riverpod 3.3.2
error: (err, stack) => Center(
  child: Column(
    mainAxisSize: MainAxisSize.min,
    children: [
      Text('Failed: $err'),
      ElevatedButton(
        onPressed: () => ref.invalidate(profileControllerProvider(userId)),
        child: const Text('Retry'),
      ),
    ],
  ),
),
```

`ref.invalidate` descarta o valor em cache e reexecuta o `build`, o que vira o `AsyncValue` de volta para `loading` e depois para `data` ou `error`. Verifique: force um erro (desligue a rede), toque em Retry com a rede de volta, confirme que ele transita de loading para data.

5. **Adicione mutações com `AsyncValue.guard`.** Esta é a capacidade que o `FutureBuilder` nunca teve. Para atualizar o usuário e refletir o resultado, adicione um método ao notifier. `AsyncValue.guard` envolve a chamada assíncrona de modo que uma exceção lançada vira um `AsyncError` em vez de um crash não tratado.

```dart
// flutter_riverpod 3.3.2
@riverpod
class ProfileController extends _$ProfileController {
  @override
  Future<User> build(String userId) {
    return ref.watch(userRepositoryProvider).fetchUser(userId);
  }

  Future<void> rename(String newName) async {
    final repo = ref.read(userRepositoryProvider);
    state = const AsyncValue.loading();
    state = await AsyncValue.guard(() async {
      await repo.rename(userId, newName);
      return repo.fetchUser(userId);
    });
  }
}
```

Chame-o a partir do widget com `ref.read(...).rename(...)` dentro de um callback (use `read`, não `watch`, em callbacks). Verifique: dispare um rename, observe a UI ir para loading e então mostrar o novo nome; dispare um rename que falha e confirme que o estado de erro é renderizado em vez de lançar.

## Verificação

Rode este checklist depois de migrar uma tela:

- `flutter analyze` não reporta novos avisos, e se você usou codegen, `dart run build_runner build` completa limpo.
- A tela busca exatamente uma vez na primeira abertura (adicione um print no repositório ou observe a aba de rede).
- Navegar para fora e de volta não busca de novo, a menos que você invalide.
- O ramo de erro é renderizado para uma falha forçada e o Retry recupera.
- `flutter test` passa. Os providers são trivialmente testáveis: sobrescreva `userRepositoryProvider` com um fake em um `ProviderContainer` e faça asserções sobre o `AsyncValue`.

```dart
// flutter_test + flutter_riverpod 3.3.2
test('loads the user', () async {
  final container = ProviderContainer(overrides: [
    userRepositoryProvider.overrideWithValue(FakeUserRepository()),
  ]);
  addTearDown(container.dispose);

  final user = await container.read(profileControllerProvider('42').future);
  expect(user.name, 'Ada');
});
```

## Plano de rollback

Esta migração é reversível por tela porque você pode converter um widget de cada vez. Para reverter uma única tela, restaure o widget `FutureBuilder` e apague seu provider; nada mais depende dele se você migrou incrementalmente. A única porta de mão única é remover o antigo encanamento de `StatefulWidget` em muitas telas em um único commit -- não faça isso. Mantenha a migração de cada tela em seu próprio commit para que uma reversão seja um `git revert` de uma linha.

## Pegadinhas que encontramos

**`ref.watch` dentro de callbacks não faz rebuild de nada útil.** Em um handler `onPressed` use `ref.read`. `watch` é para o `build`; usá-lo em um callback inscreve no momento errado e é uma fonte comum da confusão "meu botão não atualiza a tela".

**O parâmetro da family precisa ser estável.** `profileControllerProvider(userId)` indexa o cache por `userId`. Se você acidentalmente passar um objeto recém-construído (uma nova instância de `User`, um map) em vez de uma chave com igualdade por valor, você ganha um notifier novo a cada rebuild e o cache nunca acerta. Use primitivos ou tipos com `==` adequado.

**`ref` descartado após um await.** Se uma mutação aguarda e o provider é descartado no meio do caminho (o usuário navegou para fora), tocar em `ref` depois disso lança. O Riverpod 3 expõe isso claramente; a correção e a mensagem exata estão em [como corrigir "Cannot use ref after the widget was disposed"](/pt-br/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/). Proteja com `ref.mounted` se você precisar tocar em `ref` após um await em uma mutação longa.

**O provider é descartado cedo demais.** Por padrão, um provider sem listeners é descartado. Se você navega para fora e de volta e vê uma nova busca que não queria, isso é o auto-dispose fazendo seu trabalho. Mantenha-o vivo deliberadamente com `ref.keepAlive()` dentro do `build`, ou aceite a nova busca como comportamento correto de cache.

**Não misture isto com o estado do pacote `provider`.** Se seu app ainda usa o pacote legado `provider` em outros lugares, migre isso separadamente; os dois coexistem, mas borram o modelo mental. A [migração de provider para Riverpod](/pt-br/2026/06/migrate-from-provider-to-riverpod-in-flutter/) cobre esse caminho. E se você ainda está decidindo se o `AsyncNotifier` é mesmo a escolha certa para um dado widget, o [guia de decisão FutureBuilder vs Riverpod AsyncValue](/pt-br/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/) traça a linha.

## Fontes

- [Migrating from 2.0 to 3.0](https://riverpod.dev/docs/3.0_migration) -- guia oficial de migração do Riverpod para o `Ref` unificado e mudanças no notifier.
- [(Async)NotifierProvider](https://riverpod.dev/docs/providers/notifier_provider) -- o contrato canônico de `AsyncNotifier` e `build()`.
- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new) -- a lista de recursos e mudanças incompatíveis da 3.0.
- [flutter_riverpod on pub.dev](https://pub.dev/packages/flutter_riverpod) -- confirmação da versão 3.3.2.
