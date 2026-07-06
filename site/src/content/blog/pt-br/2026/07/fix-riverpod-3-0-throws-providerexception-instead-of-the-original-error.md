---
title: "Correção: Riverpod 3.0 lança ProviderException em vez do erro original"
description: "O Riverpod 3.0 encapsula erros lançados durante a leitura de um provider em um ProviderException. Capture esse tipo e leia e.exception para recuperar o erro original, ou use AsyncValue.error, que não é encapsulado."
pubDate: 2026-07-06
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
lang: "pt-br"
translationOf: "2026/07/fix-riverpod-3-0-throws-providerexception-instead-of-the-original-error"
translatedBy: "claude"
translationDate: 2026-07-06
---

Seu `on NotFoundException catch` parou de disparar depois da atualização para o Riverpod 3.0 porque ler um provider que falhou não relança mais sua exceção original. Ele relança um `ProviderException` que a encapsula. Para corrigir um `try`/`catch` quebrado, capture `ProviderException` e inspecione `e.exception` para achar seu erro real, ou troque para `AsyncValue.error`, que é deliberadamente deixado sem encapsulamento. Isto foi testado no `flutter_riverpod` 3.x (a linha 3.0 foi lançada em setembro de 2025; a versão atual é a 3.3.2, de junho de 2026), Flutter 3.44 e Dart 3.x.

A atualização não introduziu uma nova falha. Seu provider ainda lança a mesma exceção que sempre lançou. O que mudou é o tipo que sai do outro lado quando outro trecho de código lê esse provider de forma imperativa.

## O erro em contexto

Você tem um provider cujo `build` lança uma exceção de domínio, e um chamador que o lê dentro de um `try`/`catch`:

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
try {
  final user = await ref.read(userProvider.future);
  showProfile(user);
} on NotFoundException catch (e) {
  showNotFound(e.id); // never runs on Riverpod 3.0
}
```

No Riverpod 2.x isto capturava `NotFoundException` diretamente. No 3.0 a cláusula `on NotFoundException` é ignorada, e se você não tiver um `catch` mais amplo, a exceção se propaga sem ser capturada. Se você registrar no log o tipo de runtime real, verá:

```
Unhandled exception:
ProviderException: An exception/error was thrown while building UserProvider.
  <original NotFoundException and its stack trace nested here>
```

A `NotFoundException` ainda está lá dentro. Agora ela é uma passageira dentro de `ProviderException`, em vez de ser a coisa que está sendo lançada.

## Por que o Riverpod 3.0 encapsula o erro

Um provider pode estar em estado de erro por dois motivos bem diferentes, e o Riverpod 2.x não conseguia distingui-los no ponto em que você capturava o erro.

O primeiro motivo: **este provider falhou**. Seu próprio `build` lançou. O segundo motivo: **este provider está bem, mas um provider do qual ele depende falhou**, e o erro se propagou grafo abaixo. Em uma cadeia de dependências como `dashboardProvider` observando `userProvider` observando `authProvider`, uma exceção em `authProvider` aparece em cada leitura downstream. Se os três relançassem o `AuthException` puro, um `catch` em torno de `dashboardProvider` não conseguiria distinguir "o próprio dashboard quebrou" de "algo três níveis acima quebrou e estou vendo o eco".

O Riverpod 3.0 resolve isso por meio do encapsulamento. Quando você lê um provider cujo valor não pôde ser calculado, o erro é embrulhado em um `ProviderException` que registra **qual provider** lançou e carrega o erro original mais seu stack trace. O encapsulamento é o sinal de que você está olhando para uma falha de provider propagada, e a propriedade `.exception` é a saída de emergência de volta ao seu erro real. Este é o comportamento descrito no [guia de migração do Riverpod 3.0](https://riverpod.dev/docs/3.0_migration) e acompanhado na [issue 4320 do riverpod](https://github.com/rrousselGit/riverpod/issues/4320).

Há um pequeno pedaço de história aqui que vale a pena conhecer. O Riverpod antigo (pré-2.0) também encapsulava em `ProviderException`, aí o `2.0.0-dev.1` removeu o encapsulamento e passou a relançar a exceção pura, e o `3.0.0-dev.16` trouxe o encapsulamento de volta deliberadamente. Se você lembra do `ProviderException` desaparecer anos atrás, não é falha da sua memória; o 3.0 o reintroduziu de propósito.

## Reprodução mínima

Dois arquivos. Um provider que lança, e um widget que o lê de forma imperativa.

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x -- reproduces the wrap.
import 'package:flutter_riverpod/flutter_riverpod.dart';

class NotFoundException implements Exception {
  const NotFoundException(this.id);
  final String id;
}

final userProvider = FutureProvider.autoDispose<User>((ref) async {
  final user = await ref.read(apiProvider).findUser('42');
  if (user == null) throw const NotFoundException('42');
  return user;
});
```

```dart
// The caller. On 2.x this printed "not found: 42".
// On 3.0 nothing prints and the ProviderException escapes.
Future<void> load(WidgetRef ref) async {
  try {
    await ref.read(userProvider.future);
  } on NotFoundException catch (e) {
    debugPrint('not found: ${e.id}');
  }
}
```

Execute `load` quando o usuário estiver ausente. No 3.0 a cláusula `on NotFoundException` não corresponde porque o objeto lançado é um `ProviderException`, não um `NotFoundException`.

## A correção, em detalhe

Escolha a abordagem que combina com a forma como você está consumindo o provider. Em ordem de preferência:

### 1. Capture ProviderException e faça switch em e.exception

Se você precisa ler o provider de forma imperativa (dentro de um manipulador de eventos, uma mutação, um `ref.read` em um callback), capture o encapsulamento e extraia o erro original de `.exception`:

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x -- the direct fix.
Future<void> load(WidgetRef ref) async {
  try {
    await ref.read(userProvider.future);
  } on ProviderException catch (e) {
    switch (e.exception) {
      case NotFoundException(:final id):
        debugPrint('not found: $id');
      case SocketException():
        debugPrint('offline');
      default:
        rethrow; // do not swallow errors you did not plan for
    }
  }
}
```

`e.exception` é o objeto original que você lançou, então um `switch` de padrão do Dart nele fica limpo e permite vincular campos (`:final id`) na mesma linha. Sempre mantenha um `default: rethrow` para que um erro inesperado não seja engolido silenciosamente; um `on ProviderException catch` sem rethrow vai engolir todo tipo de erro futuro que você esquecer de enumerar.

Se você prefere verificações com `is` a padrões, o equivalente é:

```dart
} on ProviderException catch (e) {
  if (e.exception is NotFoundException) {
    final id = (e.exception as NotFoundException).id;
    debugPrint('not found: $id');
  } else {
    rethrow;
  }
}
```

### 2. Leia o erro através do AsyncValue, que não é encapsulado

Esta é a melhor correção quando o código está em um widget, porque também é o formato idiomático do Riverpod. `AsyncValue.error` carrega sua exceção **original**, não o encapsulamento. O encapsulamento só acontece no caminho imperativo de rethrow (`ref.read`/`ref.watch` lançando); o `AsyncValue` reativo que você obtém ao observar um provider fica intocado:

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x -- no ProviderException here.
class UserView extends ConsumerWidget {
  const UserView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(userProvider);
    return switch (async) {
      AsyncData(:final value) => ProfileCard(value),
      AsyncError(:final error) when error is NotFoundException =>
        NotFoundCard(error.id), // error is the raw NotFoundException
      AsyncError(:final error) => ErrorCard('$error'),
      _ => const CircularProgressIndicator(),
    };
  }
}
```

Note que `error is NotFoundException` corresponde diretamente. Sem desencapsulamento, porque `AsyncValue.error` nunca chegou a conter um `ProviderException` em primeiro lugar. Se você já está renderizando UI de carregamento e de erro de qualquer forma, prefira isto a um `try`/`catch` imperativo; o mesmo padrão sustenta [exibir estados de carregamento e erro com AsyncValue](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/).

### 3. Trate o erro no onError do ref.listen, também sem encapsulamento

Para efeitos colaterais (um snackbar, uma navegação, analytics) disparados pela falha de um provider, o callback `onError` do `ref.listen` também recebe o erro puro:

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
ref.listen<AsyncValue<User>>(userProvider, (prev, next) {}, onError: (error, stack) {
  // error is the original NotFoundException, not a ProviderException.
  if (error is NotFoundException) showSnack('User ${error.id} is gone');
});
```

## Quais APIs encapsulam e quais não

A tabela mais útil para manter na cabeça. O encapsulamento aparece somente quando um provider **relança** para dentro do seu código de forma imperativa.

Encapsulado em `ProviderException` (leia `.exception`):

- `ref.read(p.future)` onde `p` falhou ao construir.
- `ref.watch(p)` em um provider síncrono que lançou, quando a leitura relança.
- `await container.read(p.future)` em testes.

Não encapsulado (você obtém o erro original diretamente):

- `AsyncValue.error` de `ref.watch(asyncProvider)`. Verifique `value.error is MyException`.
- `ref.listen(p, ..., onError: (e, s) => ...)`. O `e` é puro.
- `ProviderObserver.providerDidFail` (e os hooks de observer em geral). Observers veem o erro e o stack inalterados.

Se o seu tratamento vive no build de um widget via `AsyncValue`, ou em um listener, ou em um observer, provavelmente você não precisa mudar nada. A dor da migração se concentra em `try`/`catch` imperativo em torno de `ref.read(...future)`.

## Pegadinhas e armadilhas de versão

**Você não consegue importar ProviderException em alguns builds iniciais do 3.0.** A [issue 4320](https://github.com/rrousselGit/riverpod/issues/4320) documenta uma janela em que a documentação descrevia o encapsulamento, mas um build lançava um `StateError` e `ProviderException` ainda não era exportado. Se `on ProviderException` não compilar, ou você estiver capturando `StateError` em vez disso, você está em uma pré-release afetada. Atualize para uma versão estável atual (`flutter_riverpod` 3.3.2 ou posterior) onde o tipo é exportado e o comportamento combina com a documentação. Não escreva um `on StateError` permanente para contornar isso; isso vai quebrar de novo quando você atualizar.

**Não encapsule duas vezes no seu próprio mapeamento de erros.** Se você tem um interceptador que captura tudo e relança um `AppException` normalizado, garanta que ele desencapsule `ProviderException` primeiro, senão você aninha um `ProviderException` dentro do seu `AppException` dentro de outro `ProviderException` na próxima leitura. Desencapsule na fronteira: `final real = e is ProviderException ? e.exception : e;`.

**O retry ignora o encapsulamento.** O retry automático do Riverpod 3.0 (backoff exponencial, dobrando de 200ms até um teto de 6,4s) refaz falhas genuínas de build de provider, mas não refaz um `ProviderException` que apenas se propagou de uma dependência, o que impede que um provider folha que falhou dispare uma tempestade de retries em todos os providers downstream. Você não configura isso; apenas saiba que um `ProviderException` capturado e relançado é tratado como "já contabilizado".

**O encapsulamento não é uma proteção contra async gap.** Capturar `ProviderException` trata a *falha* do provider; não faz nada quanto ao provider ser *descartado* no meio de um await. São crashes separados. Se você também vê `UnmountedRefException` depois de um await, isso é o [problema do ref.mounted](/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/), não este, e precisa de uma proteção `if (!ref.mounted) return;` em vez de um catch.

**`rethrow` dentro de `on ProviderException` relança o encapsulamento, não o erro interno.** Se o seu ramo `default` faz `rethrow`, o chamador acima na pilha ainda vê um `ProviderException`. Isso normalmente é o que você quer (a proveniência é preservada), mas se uma camada externa espera exceções de domínio puras, relance a interna explicitamente: `Error.throwWithStackTrace(e.exception, e.stackTrace)`.

## Onde isto se encaixa em uma atualização de 2.x para 3.0

Este é um item de linha na migração maior do 3.0, junto da mudança de ciclo de vida do `Ref.mounted` e da migração para classes `Notifier` unificadas. Se você está fazendo a atualização agora, faça grep no seu código por chamadas `ref.read(` envolvidas em `try` com um `on SomeException catch` tipado, e por leituras `.future` dentro de blocos `catch`. Esses são os pontos de chamada que silenciosamente pararam de corresponder. Código de widget que renderiza `AsyncValue` está seguro. Para o panorama mais amplo de por que o ciclo de vida controlado por Notifier e a semântica de erro são o padrão moderno, veja [Provider vs Riverpod vs Bloc em 2026](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/), e se você ainda está no pacote `provider` antigo, a [migração de provider para Riverpod](/2026/06/migrate-from-provider-to-riverpod-in-flutter/) cobre a mudança antes de você esbarrar em qualquer coisa disto.

O modelo mental que mantém tudo em ordem: um `ProviderException` significa "um provider no grafo falhou e você o leu de forma imperativa". Alcance dentro de `.exception` para achar a causa real, ou, melhor ainda, consuma a falha de forma reativa através de `AsyncValue`, onde nenhum encapsulamento acontece. A mesma disciplina que mantém os [erros de rede tratados com elegância](/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) se aplica aqui: decida, por ponto de chamada, se você está reagindo a um valor ou reagindo a uma falha lançada, e escolha a API que entrega o erro no formato que você espera.

## Relacionados

- [Como verificar Ref.mounted depois de um async gap no Flutter Riverpod 3](/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/) é o outro erro do Riverpod 3.0 que aparece só depois da atualização, no caminho do async gap em vez do caminho do throw.
- [Como exibir estados de carregamento e erro com AsyncValue no Flutter Riverpod](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) é a alternativa reativa ao try/catch imperativo, e não é afetada pelo encapsulamento.
- [Correção: Cannot use "ref" after the widget was disposed no Flutter Riverpod](/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/) é um crash diferente do Riverpod que as pessoas confundem com este.
- [Provider vs Riverpod vs Bloc para gerenciamento de estado no Flutter em 2026](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) cobre por que o modelo de erro e ciclo de vida do Riverpod é o padrão atual.
- [Migrar de provider para Riverpod no Flutter](/2026/06/migrate-from-provider-to-riverpod-in-flutter/) é o passo anterior a este se você ainda está no pacote legado.

## Fontes

- [Migrando de 2.0 para 3.0](https://riverpod.dev/docs/3.0_migration) -- a declaração oficial de que falhas de leitura de provider são relançadas como `ProviderException` e o padrão de captura `e.exception`.
- [O que há de novo no Riverpod 3.0](https://riverpod.dev/docs/whats_new) -- a justificativa do encapsulamento (distinguir um provider que falha de um que depende de um provider que falhou), mais o comportamento de retry que ignora `ProviderException`.
- [rrousselGit/riverpod issue 4320](https://github.com/rrousselGit/riverpod/issues/4320) -- a discrepância no início do 3.0 onde um `StateError` era lançado e `ProviderException` não podia ser importado.
- [changelog do pacote riverpod](https://pub.dev/packages/riverpod/changelog) -- o histórico: `2.0.0-dev.1` removeu o encapsulamento, `3.0.0-dev.16` o reintroduziu; estável atual 3.3.2 (junho de 2026).
