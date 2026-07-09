---
title: "Migre do Riverpod 2.x para o Riverpod 3.0 no Flutter"
description: "Uma atualização passo a passo do flutter_riverpod 2.x para o 3.x: suba as versões dos pacotes, mova StateProvider e afins para o import legacy, elimine os tipos de ref AutoDispose e Family, lide com o empacotamento em ProviderException e o retry automático, e corrija a filtragem de notificações por == que descarta silenciosamente eventos do StreamProvider. Testado no Flutter 3.44, Dart 3.x, flutter_riverpod 3.3.2."
pubDate: 2026-07-09
updatedDate: 2026-07-09
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
lang: "pt-br"
translationOf: "2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-09
---

Atualizar um app real do `flutter_riverpod` 2.x para o 3.x costuma ser um trabalho de meio dia, e a maior parte é find-and-replace mecânico. A linha 3.0 foi lançada em setembro de 2025 e a versão atual é a 3.3.2 (junho de 2026); este guia foi testado nessa versão com Flutter 3.44 (stable, maio de 2026) e Dart 3.x. O que realmente quebra: `StateProvider`, `StateNotifierProvider` e `ChangeNotifierProvider` passam para trás de um import `legacy.dart`, todo subtipo de `Ref` (`FutureProviderRef`, `AutoDisposeNotifier`, `FamilyNotifier`) colapsa em um único tipo, os erros dos providers agora saem empacotados em uma `ProviderException`, e os providers agora filtram notificações com `==`. Os dois últimos são os que causam surpresas em runtime em vez de erros de compilação, então leia essas seções com atenção. Se seu código já usa geração de código (`@riverpod`), você tem menos coisa a mudar do que se tivesse escrito as declarações de provider à mão.

## Por que atualizar

O Riverpod 2.x ainda funciona, então o argumento para migrar precisa ser concreto:

- **Retry automático** com backoff exponencial vem embutido. Um `FutureProvider` que falha em uma rede instável não fica mais preso na falha até você fazer `ref.invalidate` manualmente.
- **`Ref.mounted`** substitui o mixin feito à mão de "este provider ainda está vivo depois do await" que todo app não trivial costumava carregar. Veja [como checar Ref.mounted depois de um gap assíncrono](/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/) para o padrão completo.
- **Um único tipo `Ref` unificado** e um `Notifier` por formato. Chega de nomes de tipo como `AutoDisposeFamilyAsyncNotifier` que parecem um teste de estresse para o compilador.
- **Persistência offline** e **mutations** chegam como APIs experimentais, então o estado de submissão de formulário e o cache entre reinícios deixam de ser algo que você constrói na mão.

## O que quebra

| Área                        | Mudança                                                                              | Severidade |
| --------------------------- | ----------------------------------------------------------------------------------- | -------- |
| Providers legacy            | `StateProvider`, `StateNotifierProvider`, `ChangeNotifierProvider` precisam de `legacy.dart` | alta     |
| Subtipos de Ref             | `FutureProviderRef`, `StreamProviderRef`, etc. viram todos um único `Ref`           | alta     |
| Tipos AutoDispose / Family  | `AutoDisposeNotifier`, `FamilyNotifier` removidos; use modificadores no `Notifier`  | alta     |
| Propagação de erros         | Leituras relançam `ProviderException` empacotando seu erro original                 | alta     |
| Filtragem de notificações   | Todos os providers usam `==` para decidir se notificam os listeners                 | média    |
| Retry automático            | Providers que falham fazem retry por padrão com backoff                             | média    |
| `ProviderObserver`          | Callbacks recebem um único `ProviderObserverContext`                                | média    |
| `AsyncValue.valueOrNull`    | Renomeado para `value`; o antigo getter `value` que lançava exceção foi removido    | baixa    |

## Checklist pré-voo

Antes de tocar em um único provider:

1. Faça commit ou stash de tudo. Esta migração mexe em muitos arquivos e você vai querer um `git diff` limpo para revisar.
2. Confirme que seu Dart SDK é 3.x. O Riverpod 3.0 exige isso. Rode `dart --version` e verifique.
3. Se você usa geração de código, garanta que o `build_runner` roda sem erros no código 2.x atual primeiro. Você não quer depurar erros de gerador e erros de migração ao mesmo tempo.
4. Anote se você usa `riverpod_lint`. Ele traz regras de lint e um helper de migração via `dart fix` que automatiza vários dos passos abaixo, então tê-lo instalado economiza edições manuais.

## Passo 1: Suba as versões dos pacotes

Atualize todos os pacotes do Riverpod no `pubspec.yaml` para a linha 3.x de uma vez. Misturar um pacote 2.x e um 3.x não vai resolver.

```yaml
# pubspec.yaml -- flutter_riverpod 3.3.2, Dart 3.x
dependencies:
  flutter_riverpod: ^3.3.2
  riverpod_annotation: ^3.3.2   # only if you use code-generation

dev_dependencies:
  riverpod_generator: ^3.3.2    # only if you use code-generation
  riverpod_lint: ^3.3.2
  custom_lint: ^0.8.0
  build_runner: ^2.4.0
```

Depois resolva:

```bash
# Flutter 3.44
flutter pub get
```

**Verifique:** `flutter pub deps | grep riverpod` mostra todos os pacotes do Riverpod em uma versão 3.x. Se o pub reclamar de um conflito de versão, uma dependência transitiva ainda está fixando o `riverpod` 2.x; rode `flutter pub deps` para achar o culpado.

## Passo 2: Rode as correções automatizadas primeiro

O Riverpod 3.0 traz regras de migração via `dart fix` através do `riverpod_lint`. Rode-as antes de fazer qualquer coisa à mão, porque elas cuidam das reescritas mecânicas tediosas (os renames de subtipos de `Ref`, a remoção do prefixo `AutoDispose`) em todos os arquivos de uma vez.

```bash
# preview the changes without writing them
dart fix --dry-run

# apply them
dart fix --apply
```

**Verifique:** rode `dart fix --dry-run` de novo e confirme que as correções específicas do Riverpod sumiram da lista. Depois faça `git diff` e leia o que ele mudou. A ferramenta é boa, mas não onisciente, então os passos restantes são as partes que ela não consegue inferir.

## Passo 3: Mova os providers legacy para trás do import legacy

`StateProvider`, `StateNotifierProvider` e `ChangeNotifierProvider` ainda existem, mas agora vivem em uma biblioteca separada para que a superfície principal de import só exponha a API moderna. Se você importá-los do pacote principal, recebe um erro de "undefined name".

```dart
// Riverpod 3.x
// Add this import wherever you still use the legacy providers:
import 'package:flutter_riverpod/legacy.dart';

// StateProvider itself is unchanged in behaviour:
final counterProvider = StateProvider<int>((ref) => 0);
```

Isso é um empurrão deliberado, não um aviso de depreciação que você pode ignorar para sempre. O movimento de longo prazo é reescrever cada `StateProvider` como um `Notifier` e cada `StateNotifierProvider` como um `Notifier` ou `AsyncNotifier`, o mesmo formato alvo em que você acabaria ao [migrar do pacote provider](/2026/06/migrate-from-provider-to-riverpod-in-flutter/). Mas você não precisa fazer essa reescrita durante o bump de versão. Adicione o import, deixe verde e converta depois.

**Verifique:** o app compila. Faça grep por `legacy.dart` e confirme que todo arquivo que usa um provider legacy tem o import, e que nenhum arquivo o importa sem precisar (o linter vai sinalizar o import não usado).

## Passo 4: Colapse os subtipos de Ref e as variantes de Notifier

No 2.x, um provider gerado por código te entregava um ref tipado como `CounterRef`, e providers escritos à mão usavam `FutureProviderRef<T>`, `StreamProviderRef<T>` e assim por diante. No 3.0 existe um único `Ref`. A passagem do `dart fix` normalmente cuida disso, mas declarações escritas à mão que a ferramenta pulou precisam de edição.

```dart
// Riverpod 2.x
int example(ExampleRef ref) => 0;

Future<User> user(UserRef ref) async => fetchUser();
```

```dart
// Riverpod 3.x -- one Ref type for everything
int example(Ref ref) => 0;

Future<User> user(Ref ref) async => fetchUser();
```

A mesma unificação atinge os notifiers baseados em classe. `AutoDisposeNotifier`, `FamilyNotifier` e a explosão combinatória de nomes intermediários acabaram. Você expressa o mesmo comportamento com modificadores no `Notifier` base:

```dart
// Riverpod 2.x
class TodosNotifier extends AutoDisposeAsyncNotifier<List<Todo>> {
  @override
  Future<List<Todo>> build() => fetchTodos();
}
final todosProvider =
    AutoDisposeAsyncNotifierProvider<TodosNotifier, List<Todo>>(
  TodosNotifier.new,
);
```

```dart
// Riverpod 3.x -- autoDispose is a modifier, not a base class
class TodosNotifier extends AsyncNotifier<List<Todo>> {
  @override
  Future<List<Todo>> build() => fetchTodos();
}
final todosProvider =
    AsyncNotifierProvider.autoDispose<TodosNotifier, List<Todo>>(
  TodosNotifier.new,
);
```

Parâmetros de family que antes viviam em `FamilyNotifier` agora chegam como argumentos normais de `build` (code-gen) ou através do modificador `.family` (manual). Se você usa `@riverpod`, o gerador cuida da ligação e você só precisa rodá-lo de novo.

**Verifique (usuários de code-gen):** apague os arquivos gerados e recompile.

```bash
dart run build_runner build --delete-conflicting-outputs
```

Confirme zero erros de gerador e que os arquivos `.g.dart` regerados referenciam `Ref`, e não os antigos refs tipados.

## Passo 5: Lide com o empacotamento em ProviderException

Esta é a mudança com maior probabilidade de passar despercebida por uma verificação de compilação e quebrar em runtime. No 3.0, quando o `build` de um provider lança e outro trecho de código o lê imperativamente, a leitura não relança sua exceção original. Ela relança uma `ProviderException` que a empacota. Qualquer bloco `on MyException catch` que capturava o tipo original para de disparar.

```dart
// Riverpod 2.x -- this used to work
try {
  final user = await ref.read(userProvider.future);
} on NotFoundException catch (e) {
  showNotFound();
}
```

```dart
// Riverpod 3.x -- catch the wrapper, inspect .exception
try {
  final user = await ref.read(userProvider.future);
} on ProviderException catch (e) {
  if (e.exception is NotFoundException) {
    showNotFound();
  } else {
    rethrow;
  }
}
```

O caminho sem empacotamento é o `AsyncValue`. Quando você renderiza um provider com `.when(error: ...)` ou faz pattern matching de um `AsyncError`, o erro que você recebe ali é sua exceção original, não o wrapper. Então o código de UI que lê o estado de forma reativa não é afetado; só o `ref.read(...future)` imperativo dentro de um `try`/`catch` precisa da mudança. O artigo dedicado sobre [a ProviderException do Riverpod 3.0](/2026/07/fix-riverpod-3-0-throws-providerexception-instead-of-the-original-error/) cobre os casos de canto.

**Verifique:** faça grep por `ref.read(` combinado com `.future` dentro de blocos `try`, e por qualquer cláusula `catch` que nomeie uma exceção de domínio. Adicione um teste que faz um provider lançar e verifica que seu handler ainda roda.

## Passo 6: Corrija a filtragem de notificações por ==

No 2.x, tipos diferentes de provider tinham regras diferentes para decidir quando notificar os listeners. No 3.0 todos usam `==`. Para o estado de um `Notifier` isso geralmente é ok, mas morde forte com `StreamProvider` e `StreamNotifier`: se seu stream emite objetos iguais por `==` (por exemplo, classes mutáveis que não sobrescrevem a igualdade, ou dois valores que por acaso comparam como iguais), a segunda emissão agora é descartada como duplicata.

O modo de falha é uma UI que para de atualizar mesmo que o stream esteja claramente emitindo. A correção é garantir que o tipo emitido tenha a semântica de igualdade correta. Se você emite objetos de domínio, dê a eles igualdade por valor (um `record`, uma classe Freezed ou um `==`/`hashCode` escrito à mão). Veja [records do Dart vs classes Freezed](/2026/05/dart-records-vs-freezed-classes/) para saber qual escolher.

```dart
// Riverpod 3.x -- two distinct ticks that are == would be collapsed.
// A record gives structural equality so each tick is treated as new.
Stream<({int count, DateTime at})> ticks(Ref ref) async* {
  var n = 0;
  await for (final _ in Stream.periodic(const Duration(seconds: 1))) {
    yield (count: n++, at: DateTime.now());
  }
}
```

Se você genuinamente precisa que toda emissão passe independentemente da igualdade, sobrescreva `updateShouldNotify` em um `StreamNotifier` para retornar `true`.

**Verifique:** rode o app, observe qualquer widget alimentado por stream e confirme que ele ainda atualiza em toda emissão que você espera. Este não tem sinal de compilação, então precisa de um smoke test manual.

## Passo 7: Decida sobre o retry automático

Providers que falham agora fazem retry automaticamente: um atraso inicial de 200 ms que dobra até 6,4 segundos. Para a maioria dos providers alimentados por rede isso é uma melhoria. Mas se você tem um provider cuja falha é permanente (um erro de validação, um 404 que nunca vai virar um 200), os retries silenciosos desperdiçam chamadas e podem mascarar o erro na UI por vários segundos.

Desative globalmente no escopo, ou por provider:

```dart
// Riverpod 3.x -- disable retry everywhere
ProviderScope(
  retry: (retryCount, error) => null, // null delay = do not retry
  child: MyApp(),
)
```

```dart
// Or keep it, but stop retrying non-transient errors
ProviderScope(
  retry: (retryCount, error) {
    if (error is NotFoundException) return null;
    if (retryCount >= 3) return null;
    return Duration(milliseconds: 200 * (1 << retryCount));
  },
  child: MyApp(),
)
```

**Verifique:** aponte um provider para um endpoint que retorna um 404 e confirme que ele não martela o servidor, ou que seu predicado de retry faz curto-circuito como pretendido.

## Passo 8: Atualize o ProviderObserver e o rename de valueOrNull

Se você tem um `ProviderObserver` customizado (analytics, logging), as assinaturas dos seus callbacks mudaram. Os argumentos de container e provider foram fundidos em um único `ProviderObserverContext`.

```dart
// Riverpod 3.x
class LoggingObserver extends ProviderObserver {
  @override
  void didUpdateProvider(
    ProviderObserverContext context,
    Object? previousValue,
    Object? newValue,
  ) {
    debugPrint('${context.provider.name} -> $newValue');
  }
}
```

E a pequena: `AsyncValue.valueOrNull` foi renomeado para `value`. O antigo getter `value` (que lançava exceção em loading/error) foi removido. Se você dependia do comportamento de lançar exceção, faça pattern matching do caso `AsyncData` em vez disso.

**Verifique:** o analyzer sinaliza cada chamada de `valueOrNull`; a passagem do `dart fix` do Passo 2 normalmente as reescreve, mas confirme que nenhuma sobrou.

## Verificação: o smoke test completo

Depois de todos os passos, rode o checklist de ponta a ponta:

- `flutter pub get` resolve com todos os pacotes do Riverpod no 3.x.
- `dart run build_runner build --delete-conflicting-outputs` produz zero erros (usuários de code-gen).
- `flutter analyze` está limpo, sem referências remanescentes a `AutoDispose`/`valueOrNull`/refs tipados.
- `flutter test` passa, incluindo os novos testes que você adicionou para o tratamento de `ProviderException` e a emissão de stream.
- Exercite manualmente: uma tela alimentada por stream, uma tela de erro e uma tela que dispara uma falha de provider, para confirmar que retry, empacotamento e filtragem por `==` se comportam corretamente.

## Plano de rollback

Na prática, esta migração é uma porta de mão única. No momento em que você escreve `import 'package:flutter_riverpod/legacy.dart'` e adota o tipo `Ref` único, reverter significa desfazer todos os arquivos. O rollback limpo é o `git`, não o código: faça a migração inteira em uma branch, mantenha a branch 2.x intocada e só faça o merge quando o smoke test passar. Não faça uma migração pela metade e a envie para produção; um código com alguns arquivos na semântica 3.x e outros com as premissas do 2.x (especialmente em torno do empacotamento de erros) é pior do que qualquer uma das versões sozinha.

## Pegadinhas que encontramos

- **A filtragem por `==` é invisível até não ser.** Um `StreamProvider<List<Item>>` alimentado por uma lista que o mesmo código muta no lugar vai emitir a mesma instância de lista duas vezes, e o 3.0 descarta a segunda notificação. Emita uma lista nova (ou um tipo com igualdade por valor) toda vez.
- **`ref.read(provider.future)` dentro de um `catch` é o traiçoeiro.** Ele compila sem problemas e só se revela quando o provider de fato dá erro em produção. Procure por ele proativamente.
- **`dart fix` não toca em referências de provider tipadas por string ou construídas dinamicamente.** Qualquer coisa que o analyzer não consiga ver estaticamente, você edita à mão.
- **Não atualize o `riverpod` sem atualizar o `riverpod_generator` em sincronia.** Um runtime 3.x com um gerador 2.x produz código que referencia os antigos subtipos de `Ref` e falha ao compilar de maneiras confusas.

## Relacionados

- [Migre do provider para o Riverpod no Flutter](/2026/06/migrate-from-provider-to-riverpod-in-flutter/)
- [Como checar Ref.mounted depois de um gap assíncrono no Flutter Riverpod 3](/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/)
- [Correção: Riverpod 3.0 lança ProviderException em vez do erro original](/2026/07/fix-riverpod-3-0-throws-providerexception-instead-of-the-original-error/)
- [Provider vs Riverpod vs Bloc para gerenciamento de estado no Flutter em 2026](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/)
- [Migre do FutureBuilder para um AsyncNotifier do Riverpod no Flutter](/2026/06/migrate-from-futurebuilder-to-a-riverpod-asyncnotifier-in-flutter/)

## Fontes

- [Migrating from 2.0 to 3.0, Riverpod docs](https://riverpod.dev/docs/3.0_migration)
- [What's new in Riverpod 3.0, Riverpod docs](https://riverpod.dev/docs/whats_new)
- [riverpod on pub.dev](https://pub.dev/packages/flutter_riverpod)
