---
title: "Como verificar Ref.mounted após um intervalo assíncrono no Flutter Riverpod 3"
description: "Em um Notifier, resolva as dependências antes do await e depois proteja a escrita de state com if (!ref.mounted) return. É a substituição no Riverpod 3.0 do antigo mixin com onDispose, e evita UnmountedRefException quando um provider é descartado no meio de um await. Testado em flutter_riverpod 3.x, Flutter 3.44, Dart 3.x."
pubDate: 2026-07-04
template: how-to
tags:
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
  - "how-to"
lang: "pt-br"
translationOf: "2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3"
translatedBy: "claude"
translationDate: 2026-07-04
---

A regra é curta: dentro de um `Notifier` ou `AsyncNotifier`, um `await` pode descartar o provider antes de o seu código retomar, e escrever `state` em um provider descartado lança uma exceção. Então leia tudo o que você precisa de `ref` antes do primeiro `await`, faça o trabalho assíncrono e depois proteja a escrita de `state` com `if (!ref.mounted) return;`. `Ref.mounted` é uma propriedade do Riverpod 3.0, a gêmea do lado do provider de `BuildContext.mounted`, e é a forma suportada de perguntar "este provider ainda está vivo?" após um intervalo assíncrono. Este guia foi testado em `flutter_riverpod` 3.x (a linha 3.0 saiu em setembro de 2025; a versão atual é a 3.3.2), Flutter 3.44 (estável, maio de 2026) e Dart 3.x.

Se você já escreveu um mixin personalizado que inverte um booleano em `ref.onDispose` para poder verificá-lo após um await, agora pode apagá-lo. `Ref.mounted` faz exatamente isso, de forma correta e sem código repetitivo.

## Por que um await pode deixar um provider descartado

O `Ref` de um provider está ligado ao tempo de vida desse provider. Quando o provider é descartado, seu `Ref` é invalidado, e o Riverpod 3.0 lança uma exceção em qualquer interação posterior com ele, incluindo ler `ref`, chamar `ref.read` ou atribuir `state`. A exceção que você recebe é `UnmountedRefException`: "usar `ref` ou `state` após um intervalo assíncrono lançará uma exceção se o notifier já estiver desmontado".

O motivo pelo qual isso morde especificamente após um `await` é o intervalo assíncrono. Três coisas podem descartar um provider enquanto você está suspenso em um `Future`:

Um provider `autoDispose` perde seu último ouvinte. Se o widget que observa o provider é removido da pilha durante o await, o provider não tem mais ninguém ouvindo, então o Riverpod o descarta. Sua continuação então acorda segurando um `Ref` morto.

O provider é invalidado explicitamente. Outra parte do aplicativo chama `ref.invalidate(myProvider)` ou `ref.refresh(myProvider)` durante o intervalo, o que destrói a instância atual e constrói uma nova. O `Ref` da instância antiga, o que o seu método suspenso está segurando, agora está descartado.

Uma dependência muda. O provider faz `watch` de algo que mudou, forçando uma reconstrução. O `Ref` da compilação anterior é aposentado.

O Riverpod 3.0 tornou o primeiro caso mais raro ao pausar os ouvintes durante uma reconstrução em vez de descartá-los imediatamente, então um provider que apenas reconstrói não se descarta avidamente. Mas um provider `autoDispose` genuinamente órfão, um que perde todos os observadores no meio de um await, ainda se descarta. A mudança de ciclo de vida reduziu os falsos positivos; não removeu os reais. Este é exatamente o cenário rastreado na [issue 4096 do riverpod](https://github.com/rrousselGit/riverpod/issues/4096).

O modelo mental importante: a falha depende do tempo. Quando o trabalho aguardado é rápido, o provider geralmente ainda está vivo quando você retoma e tudo funciona. Quando a rede está lenta ou o usuário navega rápido, o provider é descartado primeiro e a escrita de `state` falha. É por isso que este bug passa na revisão de código, passa na sua máquina e quebra em produção.

## A menor reprodução

Este `AsyncNotifier` busca uma lista e depois a escreve de volta em `state` após o await. Ele compila, roda e passa toda vez que a busca é rápida.

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x -- throws UnmountedRefException.
import 'package:flutter_riverpod/flutter_riverpod.dart';

final ordersProvider =
    AsyncNotifierProvider.autoDispose<OrdersNotifier, List<Order>>(
  OrdersNotifier.new,
);

class OrdersNotifier extends AutoDisposeAsyncNotifier<List<Order>> {
  @override
  Future<List<Order>> build() => ref.read(orderRepositoryProvider).fetch();

  Future<void> refresh() async {
    state = const AsyncLoading();
    // ~800ms round trip. If the screen that watches ordersProvider is popped
    // during this await, the autoDispose provider loses its last listener and
    // is disposed. The line below then runs on a dead Ref.
    final orders = await ref.read(orderRepositoryProvider).fetch();
    state = AsyncData(orders); // throws UnmountedRefException
  }
}
```

Dispare `refresh()`, remova a tela dentro dos 800 milissegundos, e a linha `state = AsyncData(orders)` lança a exceção. Não há nada de errado na busca. O problema é que `refresh` presumiu que o provider ainda existiria quando o `Future` fosse concluído, e para um provider `autoDispose` cujo observador foi embora, ele não existe.

## A correção, passo a passo

Duas regras cobrem quase todas as ocorrências. Resolva suas dependências antes do intervalo e proteja a escrita de state depois dele.

1. **Leia cada dependência de que você precisa antes do primeiro `await`.** Enquanto o provider está garantidamente vivo (a parte síncrona do seu método), chame `ref.read` para cada serviço, repositório ou notifier que você vai usar, e guarde os resultados em variáveis locais. Uma referência a um objeto simples não fica obsoleta quando o provider é descartado; apenas o `Ref` fica.

2. **Faça o trabalho assíncrono.** Aguarde seus `Future` usando as variáveis locais que você capturou. Não toque em `ref` dentro das expressões aguardadas se puder evitar.

3. **Proteja a retomada com `ref.mounted`.** Imediatamente antes de atribuir `state` (ou chamar qualquer método de `ref`), verifique `if (!ref.mounted) return;`. Se o provider foi descartado durante o intervalo, você sai de forma limpa em vez de lançar uma exceção.

4. **Atribua `state`.** Agora a escrita cai sobre um provider vivo.

Aqui está o notifier corrigido:

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x -- correct.
class OrdersNotifier extends AutoDisposeAsyncNotifier<List<Order>> {
  @override
  Future<List<Order>> build() => ref.read(orderRepositoryProvider).fetch();

  Future<void> refresh() async {
    final repo = ref.read(orderRepositoryProvider); // 1. read deps first
    state = const AsyncLoading();

    final next = await AsyncValue.guard(repo.fetch); // 2. async work

    if (!ref.mounted) return; // 3. the provider may be gone
    state = next;             // 4. safe write
  }
}
```

`repo` é um manipulador de objeto durável; funciona bem após o await mesmo que o provider esteja morto. A verificação `ref.mounted` é o que impede a falha: retorna `false` quando o provider foi descartado, então a atribuição de `state` nunca é executada contra um `Ref` invalidado. Esta é a mesma disciplina que mantém seguros os [estados de carregamento e erro com AsyncValue](/pt-br/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/), e é estruturalmente idêntica à [proteção de BuildContext após um await](/pt-br/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) do lado do widget.

A documentação oficial do Riverpod 3.0 mostra exatamente este padrão:

```dart
// From the Riverpod 3.0 "what's new" docs.
Future<void> addTodo(String title) async {
  final newTodo = await api.addTodo(title);
  if (!ref.mounted) return;
  state = [...state, newTodo];
}
```

## ref.mounted, WidgetRef e context.mounted: qual verificação vai onde

A fonte mais comum de confusão é qual `mounted` você quer, porque há três delas e elas vivem em três objetos diferentes.

`ref.mounted` está no `Ref` do provider, o que você obtém dentro de um `Notifier`, `AsyncNotifier` ou no corpo de um provider funcional (`Ref ref`). Use-o quando o código assíncrono vive em um provider. Esta é a propriedade que o Riverpod 3.0 adicionou; ela não existia no 2.x.

`context.mounted` está no `BuildContext`. Use-o quando o código assíncrono vive em um widget e você precisa tocar a árvore depois (`Navigator`, `ScaffoldMessenger`, `Theme.of`). O lint `use_build_context_synchronously` do analisador do Dart faz cumprir esta.

`State.mounted` está no `State` (e portanto no `ConsumerState`). Use-o em um `ConsumerStatefulWidget` antes de chamar `setState` ou de ler `WidgetRef` após um await. Atenção à armadilha: um `WidgetRef` em um widget não é o mesmo objeto que o `Ref` de um provider, e não tem `ref.mounted`. Em um widget você protege com `context.mounted` ou `State.mounted`, não com `ref.mounted`.

A regra prática: se o quadro da pilha que lança a exceção está dentro de um `Notifier` ou `AsyncNotifier`, você quer `ref.mounted`. Se está dentro de um `ConsumerState` ou um `ConsumerWidget` (build/callback), você quer `context.mounted` ou `State.mounted`. Errar nisso é a raiz da muito relacionada [falha Cannot use "ref" after the widget was disposed](/pt-br/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/), cuja variante do lado do provider é a resposta proativa deste guia.

## O mixin do 2.x que agora você pode apagar

Antes do Riverpod 3.0 não havia `Ref.mounted`, então a solução alternativa da comunidade era um mixin que rastreava o descarte manualmente:

```dart
// Riverpod 2.x workaround -- no longer needed on 3.0.
mixin NotifierMounted {
  bool _mounted = true;
  void setUnmounted() => _mounted = false;
  bool get mounted => _mounted;
}

class SomeNotifier extends AutoDisposeAsyncNotifier<void>
    with NotifierMounted {
  @override
  FutureOr<void> build() {
    ref.onDispose(setUnmounted); // flip the flag when disposed
  }

  Future<void> doAsyncWork() async {
    final next = await AsyncValue.guard(someFuture);
    if (mounted) {
      state = next;
    }
  }
}
```

Isso funcionava, mas o mantenedor do Riverpod o desaconselhou explicitamente, e tinha arestas afiadas (você tinha que lembrar de registrar `onDispose`, e a flag vivia na instância do notifier em vez de no ref). No 3.0 todo o mixin colapsa em uma única propriedade:

```dart
// Riverpod 3.x -- the mixin is gone, ref.mounted is built in.
class SomeNotifier extends AutoDisposeAsyncNotifier<void> {
  @override
  FutureOr<void> build() {}

  Future<void> doAsyncWork() async {
    final next = await AsyncValue.guard(someFuture);
    if (!ref.mounted) return;
    state = next;
  }
}
```

Se você está atualizando a partir do 2.x e vê um mixin `NotifierMounted` (ou qualquer flag `_mounted` feita à mão) na sua base de código, agora é peso morto. Apague o mixin, apague a linha `ref.onDispose(setUnmounted)` e substitua `if (mounted)` por `if (!ref.mounted) return;`.

## Armadilhas e casos extremos

**`ref.mounted` não substitui a limpeza com `ref.onDispose`.** A proteção impede uma escrita em um provider descartado; ela não limpa recursos. Se o seu provider possui uma assinatura, um socket ou um timer, registre o desmonte dele com `ref.onDispose` no `build`. E não chame `ref.read` dentro de um callback de `onDispose`: o provider já está sendo descartado nesse ponto, então `ref` é inválido e você vai bater em `UnmountedRefException` de novo. O lint `avoid-ref-inside-state-dispose` do DCM sinaliza exatamente isso.

**Ler um provider `autoDispose` via `.future` pode descartá-lo após o primeiro await.** Há um caso sutil, discutido na [discussão 4293 do riverpod](https://github.com/rrousselGit/riverpod/discussions/4293), onde um provider `autoDispose` lido através de seu `.future` é descartado após o primeiro `await` porque o ouvinte temporário criado pela leitura é liberado. Se você está encadeando leituras através de awaits, mantenha um ouvinte real vivo (observe-o, ou use `ref.keepAlive()`), em vez de presumir que `.future` mantém o provider aberto.

**`ref.keepAlive()` muda o cálculo.** Um provider que você fixou com `ref.keepAlive()` não fará `autoDispose` quando seu último widget for embora, então a causa "perdeu o último ouvinte" desaparece. Ele ainda pode ser descartado por um `invalidate` ou `refresh` explícito, então mantenha a proteção `ref.mounted`, mas entenda que fixar remove o gatilho mais comum.

**`AsyncValue.guard` não protege a montagem.** `AsyncValue.guard` converte uma exceção lançada em um `AsyncError` para que o erro caia no seu estado em vez de quebrar. Ele não faz nada quanto ao descarte. Você ainda precisa do `if (!ref.mounted) return;` depois dele, antes de atribuir o resultado protegido a `state`. Os dois mecanismos resolvem problemas diferentes: `guard` lida com a falha do Future, `ref.mounted` lida com o desaparecimento do provider.

**Um `ConsumerWidget` não tem `ref.mounted`.** Seu `ref` é um `WidgetRef`, não um `Ref` de provider. Se você capturou um `WidgetRef` em um callback assíncrono dentro de um `ConsumerWidget` sem estado, não há `mounted` para verificar. Mova o trabalho assíncrono para um Notifier para que ele rode por trás de um `Ref` de provider durável (esta é a forma que uma [migração de FutureBuilder para AsyncNotifier](/pt-br/2026/06/migrate-from-futurebuilder-to-a-riverpod-asyncnotifier-in-flutter/) produz), ou mude para um `ConsumerStatefulWidget` para ter `State.mounted`.

**Começou a lançar a exceção apenas após a atualização para o 3.0.** O Riverpod 3.0 lança uma exceção na interação pós-descarte onde o 2.x às vezes a tolerava em silêncio. O código que "funcionava" antes já estava escrevendo em um provider descartado; o 3.0 trouxe à tona um bug latente em vez de criá-lo. Adicione a proteção, não volte para o 2.x para escondê-lo.

## Deixe o linter pegar as que passam

A proteção é um hábito, e hábitos falham. Duas regras de análise estática transformam "lembre-se de verificar `ref.mounted`" em um erro de compilação. O DCM inclui `use-ref-and-state-synchronously`, que sinaliza um acesso a `ref` ou `state` após um intervalo assíncrono que não é precedido por uma verificação de montagem, e `avoid-ref-inside-state-dispose` para o caso de `onDispose`. O próprio conjunto de lints do Riverpod inclui equivalentes. De fábrica, o compilador do Dart não vai avisá-lo sobre `ref` após um await como faz para `BuildContext`, então ativar essas regras é a diferença entre pegar o bug no CI e pegá-lo em um relatório de falha.

A única disciplina que elimina toda essa classe de bug: trate o `Ref` de um provider exatamente como um `BuildContext`. Ele é válido de forma síncrona, um `await` pode invalidá-lo, então leia o que você precisa antes do intervalo e proteja cada toque em `ref` ou `state` posterior ao await com `if (!ref.mounted) return;`. Integre isso no seu reflexo de async-notifier e `UnmountedRefException` para de aparecer. É uma das razões pelas quais [o ciclo de vida de propriedade do Notifier do Riverpod é a escolha padrão de gerenciamento de estado em 2026](/pt-br/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/).

## Relacionado

- [Fix: Cannot use "ref" after the widget was disposed in Flutter Riverpod](/pt-br/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/) é a contraparte reativa: a falha que você recebe quando pula esta proteção, tanto do lado do widget quanto do provider.
- [Como usar BuildContext com segurança após um await no Flutter](/pt-br/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) é a mesma proteção para o `context.mounted` do lado do widget.
- [Como mostrar estados de carregamento e erro com AsyncValue no Flutter Riverpod](/pt-br/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) mostra o padrão de `AsyncNotifier` mais `AsyncValue.guard` que esta proteção resguarda.
- [Migrar de FutureBuilder para um AsyncNotifier do Riverpod no Flutter](/pt-br/2026/06/migrate-from-futurebuilder-to-a-riverpod-asyncnotifier-in-flutter/) move o trabalho assíncrono para um provider onde `ref.mounted` está disponível.
- [Provider vs Riverpod vs Bloc para gerenciamento de estado no Flutter em 2026](/pt-br/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) cobre por que o ciclo de vida de propriedade do Notifier é o padrão moderno.

## Fontes

- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new) -- apresenta `Ref.mounted`, o padrão `if (!ref.mounted) return;` e a mudança de ciclo de vida de pausar-ouvintes-na-reconstrução.
- [Riverpod FAQ](https://riverpod.dev/docs/root/faq) -- sobre o tempo de vida do `Ref` de um provider frente a um `WidgetRef`.
- [rrousselGit/riverpod issue 4096](https://github.com/rrousselGit/riverpod/issues/4096) -- usar `ref` em um notifier após um intervalo assíncrono, e a correção do 3.0.
- [rrousselGit/riverpod discussion 4293](https://github.com/rrousselGit/riverpod/discussions/4293) -- por que os providers `autoDispose` são descartados após o primeiro `await` quando lidos através de `.future`.
- [DCM use-ref-and-state-synchronously rule](https://dcm.dev/docs/rules/riverpod/use-ref-and-state-synchronously/) -- o lint que faz cumprir uma verificação de montagem após um intervalo assíncrono.
- [How to Check if an AsyncNotifier is Mounted with Riverpod, codewithandrea](https://codewithandrea.com/articles/async-notifier-mounted-riverpod/) -- o antigo mixin do 2.x e a substituição `ref.mounted` do 3.0.
</content>
