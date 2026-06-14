---
title: "Solução: Bad state: Cannot use \"ref\" after the widget was disposed no Flutter Riverpod"
description: "Esse erro significa que um WidgetRef foi usado depois que o widget saiu da árvore, geralmente em uma callback assíncrona. Leia o que precisar antes do await e proteja com uma checagem de mounted."
pubDate: 2026-06-14
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
lang: "pt-br"
translationOf: "2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod"
translatedBy: "claude"
translationDate: 2026-06-14
---

Seu código acessou um `WidgetRef` do Riverpod depois que o widget que o possui foi descartado. O culpado de costume é uma callback assíncrona (um `await`, `Future.then`, `Timer` ou listener de stream) que termina depois que o usuário saiu da tela e então chama `ref.read`, `ref.watch` ou `ref.listen`. A correção é ler tudo o que você precisa de `ref` antes do `await` e proteger qualquer trabalho posterior com uma checagem `if (!mounted) return;`. Este guia usa Flutter 3.44 (estável, maio de 2026), Dart 3.x e Riverpod 3.0 (lançado em setembro de 2025).

Um `WidgetRef` está atrelado ao tempo de vida do widget de onde veio. No momento em que esse widget é removido da árvore, o ref é invalidado, e qualquer uso posterior lança uma exceção. Isso é por design: um widget descartado não tem motivo para ler ou escrever providers, e o Riverpod prefere falhar de forma ruidosa a vazar estado em silêncio para uma tela que o usuário já abandonou.

## O erro em contexto

A mensagem completa que o Riverpod lança fica assim:

```
Unhandled Exception: Bad state: Cannot use "ref" after the widget was disposed.
#0      ProviderElementBase._assertNotDisposed (package:flutter_riverpod/...)
#1      ConsumerStatefulElement.read (package:flutter_riverpod/src/consumer.dart)
#2      _CheckoutScreenState._submit.<anonymous closure> (package:my_app/checkout_screen.dart:42)
...
```

O frame no seu próprio código nomeia a linha que tocou o ref morto: uma chamada a `ref.read(...)`, `ref.watch(...)` ou `ref.listen(...)`. Esse frame é onde a exceção aparece, mas o motivo pelo qual ela disparou é anterior no tempo, quando o widget foi descartado antes daquela linha rodar.

Há uma variante muito próxima com um substantivo ligeiramente diferente:

```
Bad state: Cannot use "ref" after the provider was disposed.
```

Essa vem do `Ref` dentro de um `Notifier` ou `AsyncNotifier`, não de um `WidgetRef` em um widget. Mesma família, mesma causa raiz, dono diferente. A versão do widget diz "widget"; a versão do provider diz "provider". A correção difere um pouco, e a seção sobre Notifiers abaixo a cobre.

## Por que isso acontece

São quatro causas, em ordem aproximada de frequência.

Um `WidgetRef` foi capturado em uma callback assíncrona que sobreviveu ao widget. Você iniciou um `await`, um `Future.then`, um `Timer` ou um `stream.listen` enquanto a tela estava viva, o usuário fechou a rota (o que descarta o `ConsumerState` e invalida seu `ref`), e então a callback terminou e chamou `ref.read`. Essa é de longe a causa mais comum, porque só quebra quando o tempo coincide: passa toda vez que o trabalho aguardado é rápido e quebra quando a rede está lenta ou o usuário é veloz.

Você usou `ref` dentro do `dispose()`. Um `ConsumerState.dispose()` que chama `ref.read` para fazer limpeza (cancelar uma assinatura, esvaziar um buffer, notificar um provider) cai neste erro, porque quando o `dispose` roda o `WidgetRef` já foi destruído. A equipe do Riverpod registra exatamente esse formato na [issue 4142](https://github.com/rrousselGit/riverpod/issues/4142): o widget ainda parece montado, mas o ref do elemento não existe mais. A limpeza precisa acontecer pelo próprio `ref.onDispose` do provider, não pelo `dispose` do widget.

Você armazenou um `WidgetRef` em um objeto de vida longa. Um controller, serviço ou classe de "lógica" que guarda o `ref` recebido em `build` manterá uma referência obsoleta. Quando o widget reconstrói ou sai, esse ref armazenado aponta para um elemento descartado. Um `WidgetRef` não é um handle durável; ele só é válido para a instância de widget que o possui.

Um provider foi descartado durante uma lacuna assíncrona dentro de um Notifier. Em um Notifier `autoDispose`, você dá `await` em algo, o provider perde seu último listener (ou é invalidado) durante a lacuna, o Riverpod o descarta e a linha após o `await` lê `ref`. Essa é a variante "after the provider was disposed". O Riverpod 3.0 a deixou mais rara ao pausar listeners na reconstrução em vez de removê-los imediatamente, mas um provider `autoDispose` que realmente perde todos os seus watchers no meio do await ainda é descartado. O tema é discutido na [issue 4096 do riverpod](https://github.com/rrousselGit/riverpod/issues/4096).

O contrato subjacente, segundo as notas de versão do Riverpod 3.0: "Refs and Notifiers can no longer be interacted with after they have been disposed". O Riverpod 3.0 lança exceção em qualquer interação após o descarte em vez de tolerá-la, e por isso o código que antes falhava em silêncio no 2.x agora quebra ruidosamente. Isso é o framework fazendo o seu trabalho.

## Um repro mínimo

Esta tela quebra quando você sai dela antes do envio terminar. Ela compila e roda, e passa toda vez que a rede está rápida.

```dart
// Flutter 3.44, Dart 3.x, Riverpod 3.0 -- throws "Cannot use \"ref\" after the widget was disposed".
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

final cartProvider = NotifierProvider<CartNotifier, int>(CartNotifier.new);

class CartNotifier extends Notifier<int> {
  @override
  int build() => 3;
  void clear() => state = 0;
}

class CheckoutScreen extends ConsumerStatefulWidget {
  const CheckoutScreen({super.key});

  @override
  ConsumerState<CheckoutScreen> createState() => _CheckoutScreenState();
}

class _CheckoutScreenState extends ConsumerState<CheckoutScreen> {
  Future<void> _submit() async {
    // Pretend this posts the order and takes ~800ms.
    await Future.delayed(const Duration(milliseconds: 800));
    // If the user popped this screen during those 800ms, the ConsumerState and
    // its WidgetRef are already disposed. This line then throws.
    ref.read(cartProvider.notifier).clear();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: ElevatedButton(
          onPressed: _submit,
          child: const Text('Place order'),
        ),
      ),
    );
  }
}
```

Toque em "Place order" e então feche a tela antes de 800 milissegundos. O `ConsumerState` é descartado, seu `ref` é invalidado, o `Future` termina e `ref.read(cartProvider.notifier)` lança a exceção. O erro depende do tempo, que é justamente por que ele sobrevive à revisão de código e vai para produção.

## A correção, em detalhe

As correções estão ordenadas pelo quanto eu as recomendo. Escolha a que combina com a sua causa.

### 1. Leia antes do await, proteja o resto com mounted (recomendado)

Duas regras cobrem quase toda ocorrência do lado do widget. Primeiro, resolva tudo o que você precisa de `ref` antes do `await`, enquanto o widget está garantidamente vivo. Segundo, depois do `await`, cheque `mounted` antes de tocar a árvore, chamar `setState` ou fazer qualquer outra chamada a `ref`.

```dart
// Flutter 3.44, Dart 3.x, Riverpod 3.0 -- correct.
Future<void> _submit() async {
  // Resolve the notifier BEFORE the await, while ref is still valid.
  final cart = ref.read(cartProvider.notifier);

  await Future.delayed(const Duration(milliseconds: 800)); // post the order

  if (!mounted) return; // the ConsumerState (and its WidgetRef) may be gone
  cart.clear();
}
```

`cart` é uma referência a um objeto comum (o notifier); ela não fica obsoleta quando o widget é descartado, então chamar `cart.clear()` depois do await é seguro. A checagem de `mounted` impede que você também conduza a UI (um `setState`, um `Navigator.push`, uma chamada ao `ScaffoldMessenger`) sobre um widget morto. `mounted` aqui é o `State.mounted` padrão, que o `ConsumerState` expõe como qualquer outro `State`.

A regra é a mesma que corrige os erros de descarte de controllers: depois de cada `await` em um método de `State`, a próxima linha que toca `this`, `ref` ou a árvore precisa ser precedida por uma checagem de `mounted`. O lint do analisador do Dart `use_build_context_synchronously` pega a versão com `BuildContext` desse erro; trate `ref` exatamente igual. A mesma disciplina aparece na [correção para TextEditingController usado após ser descartado](/pt-br/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/), porque é a mesma classe de bug com um objeto diferente.

### 2. Em um Notifier, cheque ref.mounted depois da lacuna assíncrona

Se o erro é a variante "after the provider was disposed", você está dentro de um `Notifier` ou `AsyncNotifier`, não de um widget. O Riverpod 3.0 adicionou `Ref.mounted`, o equivalente do lado do provider ao `BuildContext.mounted`. Leia as dependências antes do await e então condicione a escrita de estado a `ref.mounted`.

```dart
// Flutter 3.44, Dart 3.x, Riverpod 3.0
class OrdersNotifier extends AsyncNotifier<List<Order>> {
  @override
  Future<List<Order>> build() => _repo().fetch();

  OrderRepository _repo() => ref.read(orderRepositoryProvider);

  Future<void> refresh() async {
    final repo = _repo(); // read deps before the gap
    final next = await AsyncValue.guard(repo.fetch);

    if (!ref.mounted) return; // the provider may have been disposed mid-fetch
    state = next;
  }
}
```

Antes do Riverpod 3.0 não havia `ref.mounted`, e a solução alternativa comum era um pequeno mixin que ativa uma flag no `ref.onDispose`. No 3.0 você pode apagar esse mixin: `ref.mounted` é a checagem suportada. Definir `state` em um notifier descartado é o que lança a exceção, então a proteção fica imediatamente antes da atribuição. Esse é o mesmo formato que mantém os [estados de carregamento e erro com AsyncValue](/pt-br/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) seguros através de uma lacuna assíncrona.

### 3. Não armazene um WidgetRef em uma classe de lógica

Se o erro não é assíncrono, muitas vezes é um ref armazenado. Um `WidgetRef` pertence a um único widget e morre com ele, então um controller ou serviço que o segura acabará desreferenciando um cadáver. Mova a lógica para um Notifier e deixe-o usar o `Ref` sempre vivo do provider.

```dart
// Flutter 3.44, Dart 3.x, Riverpod 3.0 -- the logic owns a durable Ref, not a WidgetRef.
final sessionProvider = NotifierProvider<SessionNotifier, Session?>(SessionNotifier.new);

class SessionNotifier extends Notifier<Session?> {
  @override
  Session? build() => null;

  Future<void> signOut() async {
    await ref.read(authProvider).signOut(); // ref here is the provider's Ref
    if (!ref.mounted) return;
    state = null;
  }
}
```

Os widgets então chamam `ref.read(sessionProvider.notifier).signOut()` a partir de um manipulador de eventos, e o trabalho de longa duração vive atrás de um `Ref` que o Riverpod mantém vivo enquanto o provider estiver em uso. O widget nunca precisa sobreviver ao seu próprio `ref`. Mover a posse do ciclo de vida para fora dos widgets e para dentro dos Notifiers é justamente o formato sobre o qual uma [migração de GetX para Riverpod](/pt-br/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) é construída, e é uma das razões pelas quais o [Riverpod é a escolha padrão de gerenciamento de estado em 2026](/pt-br/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/).

### 4. Nunca use ref dentro do dispose() do widget

A limpeza que precisa de um provider não pertence ao `ConsumerState.dispose()`, porque a essa altura o `WidgetRef` já está invalidado. Há dois lares corretos para ela. Se o recurso é de propriedade de um provider, registre a limpeza com `ref.onDispose` dentro desse provider, onde ela roda quando o provider é descartado:

```dart
// Flutter 3.44, Dart 3.x, Riverpod 3.0 -- cleanup lives with the provider, not the widget.
final socketProvider = NotifierProvider<SocketNotifier, void>(SocketNotifier.new);

class SocketNotifier extends Notifier<void> {
  late final WebSocketChannel _channel;

  @override
  void build() {
    _channel = WebSocketChannel.connect(Uri.parse('wss://example.com'));
    ref.onDispose(_channel.sink.close); // runs when the provider goes away
  }
}
```

Se você realmente precisa fazer algo no desmonte do widget, capture o objeto comum (o notifier, a assinatura, o valor) em `initState` ou `didChangeDependencies` e guarde-o em um campo, depois use esse campo em `dispose()`. Não chame `ref.read` a partir do próprio `dispose`.

## Pegadinhas e variantes

`Cannot use "ref" after the provider was disposed`. O gêmeo do lado do Notifier deste erro, coberto pela correção 2 acima. Se o frame do stack está dentro de um `Notifier`/`AsyncNotifier` em vez de um `ConsumerState`, você quer `ref.mounted`, não `State.mounted`. As duas mensagens diferem em uma palavra e essa palavra diz qual checagem usar.

`ref.read` em `onPressed` funciona, `ref.read` depois de `await` no mesmo manipulador não. A parte síncrona de um manipulador de eventos roda enquanto o widget está vivo, então um `ref.read` simples no início de `onPressed` está ok. Só o código depois de um `await` pode pousar em um widget descartado. A linha divisória é o primeiro `await`, não o manipulador.

O erro só acontece às vezes. Essa é a assinatura da causa assíncrona, não de um framework instável. Um backend rápido o esconde; um lento ou um usuário veloz o expõem. Reproduza-o de forma determinística adicionando um `Future.delayed` artificial antes da chamada a `ref` e fechando a tela durante o atraso, exatamente como o repro acima faz.

Começou depois de atualizar para o Riverpod 3.0. O Riverpod 3.0 lança exceção em interações após o descarte onde o 2.x às vezes as tolerava. O código que "funcionava" antes já estava tocando um ref descartado; o 3.0 trouxe à tona um bug latente em vez de introduzir um. As notas de versão afirmam claramente que refs e notifiers não podem mais ser usados após o descarte. Corrija o acesso, não volte a fixar o 2.x para escondê-lo.

`ConsumerWidget` (sem estado) causando isso. Um `ConsumerWidget` não tem `mounted`, porque não tem `State`. Se você captura o `ref` dele em uma callback que sobrevive ao widget, migre para um `ConsumerStatefulWidget` para ter uma flag `mounted` com a qual se proteger, ou empurre o trabalho assíncrono para um Notifier (correção 3) para que o widget nunca segure o ref além da própria vida.

`use_build_context_synchronously` não marca `ref`. O lint do analisador que pega um `BuildContext` usado após um await não tem equivalente embutido para `WidgetRef`. Analisadores estáticos como o DCM e o conjunto de lints do Riverpod 3.0 adicionam regras para isso (usar ref e state de forma síncrona), e vale a pena ativá-los, mas de fábrica o compilador não vai avisar. Trate todo `ref` depois de um `await` como suspeito do mesmo jeito que você trata `context`.

A única disciplina que elimina toda essa classe de bug: um `WidgetRef` só é válido dentro do corpo síncrono do widget que o possui, então leia o que precisar antes de qualquer `await`, proteja tudo o que vem depois com `mounted` (widgets) ou `ref.mounted` (Notifiers), e mantenha a lógica durável em providers em vez de em widgets que vão e vêm. Coloque isso no seu reflexo de manipuladores assíncronos e o erro para de aparecer. É o mesmo reflexo de proteção com `mounted` que corrige o [erro setState ou markNeedsBuild chamado durante o build](/pt-br/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/), e o tempo de resposta lento que o dispara costuma ser rastreado até [como o app trata erros de rede](/pt-br/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/).

## Relacionados

- [Solução: A TextEditingController was used after being disposed no Flutter](/pt-br/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/) é o mesmo erro de pós-descarte para controllers, com a mesma correção de proteção com mounted.
- [Como mostrar estados de carregamento e erro com AsyncValue no Flutter Riverpod](/pt-br/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) mantém resultados assíncronos no estado de um Notifier, fora do perigoso caminho pós-await.
- [Solução: setState() or markNeedsBuild() called during build no Flutter](/pt-br/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) compartilha a disciplina de proteção com mounted para callbacks assíncronas.
- [Como migrar um app Flutter de GetX para Riverpod](/pt-br/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) mostra como mover a lógica para Notifiers que possuem um Ref durável.
- [Provider vs Riverpod vs Bloc para gerenciamento de estado no Flutter em 2026](/pt-br/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) cobre por que o ciclo de vida nas mãos do Notifier é o padrão moderno.

## Fontes

- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new) -- apresenta `Ref.mounted` e a regra "refs and notifiers can no longer be interacted with after they have been disposed".
- [Riverpod FAQ](https://riverpod.dev/docs/root/faq) -- sobre o tempo de vida do `WidgetRef` versus o `Ref` de um provider.
- [rrousselGit/riverpod issue 4142](https://github.com/rrousselGit/riverpod/issues/4142) -- o erro lançado ao usar `ref` na callback `dispose` de um widget.
- [rrousselGit/riverpod issue 4096](https://github.com/rrousselGit/riverpod/issues/4096) -- usar `ref` em um Notifier depois de uma lacuna assíncrona, e a correção de pausa de listeners no 3.0.
- [Como verificar se um AsyncNotifier está montado, codewithandrea](https://codewithandrea.com/articles/async-notifier-mounted-riverpod/) -- o padrão `ref.mounted` no Riverpod 3.0 e o mixin herdado do 2.x.
