---
title: "Riverpod Notifier vs AsyncNotifier vs StreamNotifier no Flutter: qual eu estendo?"
description: "Escolha pelo tipo de retorno de build(): T significa Notifier, FutureOr<T> significa AsyncNotifier, Stream<T> significa StreamNotifier. Aqui está a matriz de decisão, a hierarquia de tipos que explica o porquê, e as armadilhas de filtragem por == e de sobrescrita de estado que atingem cada uma. Verificado com flutter_riverpod 3.4.2 no Flutter 3.44.2."
pubDate: 2026-08-15
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
lang: "pt-br"
translationOf: "2026/08/riverpod-notifier-vs-asyncnotifier-vs-streamnotifier-in-flutter"
translatedBy: "claude"
translationDate: 2026-08-15
---

A escolha entre `Notifier`, `AsyncNotifier` e `StreamNotifier` é decidida por uma coisa só: o tipo de retorno do seu método `build()`. Se ele retorna `T`, estenda `Notifier<T>`. Se retorna `Future<T>` ou um `T` simples que você talvez queira tornar assíncrono depois, estenda `AsyncNotifier<T>`. Se sua fonte de dados continua empurrando novos valores depois do primeiro, estenda `StreamNotifier<T>`. Todo o resto (métodos de mutação, `ref.watch` dentro de `build`, famílias, auto-disposição) funciona igual nas três. Tudo neste post foi verificado com `flutter_riverpod` 3.4.2 no Flutter 3.44.2 (estável, 2026-06-10) e Dart 3.12.2, com `riverpod_generator` 4.0.4 para a seção de geração de código.

## A matriz de decisão

| | `Notifier<T>` | `AsyncNotifier<T>` | `StreamNotifier<T>` |
| --- | --- | --- | --- |
| `build()` retorna | `T` | `FutureOr<T>` | `Stream<T>` |
| O provider expõe | `T` | `AsyncValue<T>` | `AsyncValue<T>` |
| Classe do provider | `NotifierProvider` | `AsyncNotifierProvider` | `StreamNotifierProvider` |
| Estado de carregamento | nunca | `AsyncLoading` primeiro | `AsyncLoading` primeiro |
| Valores após o primeiro | você escreve | você escreve | o stream escreve |
| Modificador `.future` | não | sim | sim |
| Helper `update()` | não | sim | sim |
| Assinatura de `updateShouldNotify` | `(T, T)` | `(AsyncValue<T>, AsyncValue<T>)` | `(AsyncValue<T>, AsyncValue<T>)` |
| Substitui (Riverpod 2.x) | `StateNotifier`, `StateProvider` | `FutureProvider` + métodos | `StreamProvider` + métodos |

A última linha é a que derruba as pessoas. `AsyncNotifier` não é "a versão assíncrona do `Notifier`" no sentido de ser um superconjunto. É `FutureProvider` com um lugar para colocar métodos de mutação. `StreamNotifier` é `StreamProvider` com o mesmo. Se você não precisa de métodos de mutação, um `FutureProvider` ou `StreamProvider` simples continua sendo a resposta menor.

## Por que o tipo de retorno é a regra inteira

Isso não é uma convenção de estilo. É imposto pela hierarquia de classes no `riverpod` 3.4.2. Cada uma das três classes públicas declara um `build()` abstrato com um tipo de retorno fixo:

```dart
// package:riverpod/src/providers/notifier/orphan.dart, riverpod 3.4.2
abstract class Notifier<ValueT> extends $Notifier<ValueT> {
  @visibleForOverriding
  ValueT build();
}

// package:riverpod/src/providers/async_notifier/orphan.dart
abstract class AsyncNotifier<StateT> extends $AsyncNotifier<StateT> {
  @visibleForOverriding
  FutureOr<StateT> build();
}

// package:riverpod/src/providers/stream_notifier/orphan.dart
abstract class StreamNotifier<ValueT> extends $StreamNotifier<ValueT> {
  @visibleForOverriding
  Stream<ValueT> build();
}
```

Escolha errado e você recebe um erro de compilação, não uma surpresa em tempo de execução. Estes são os diagnósticos exatos do `flutter analyze` no Flutter 3.44.2:

```text
error - 'WrongOne.build' ('Future<int> Function()') isn't a valid override of
        'Notifier.build' ('int Function()') - invalid_override

error - 'WrongTwo.build' ('Stream<int> Function()') isn't a valid override of
        'AsyncNotifier.build' ('FutureOr<int> Function()') - invalid_override

error - 'Ok' doesn't conform to the bound 'AsyncNotifier<int>' of the type
        parameter 'NotifierT' - type_argument_not_matching_bounds
```

O terceiro é o erro de pareamento incorreto: uma subclasse de `Notifier` entregue a um `AsyncNotifierProvider`. A classe notifier e a classe provider estão presas por um limite genérico, então você não pode misturá-las.

## Quando escolher Notifier

Vá de `Notifier<T>` quando o estado inicial está disponível de forma síncrona e nada fora dos seus próprios métodos o altera.

```dart
// flutter_riverpod 3.4.2, Flutter 3.44.2, Dart 3.12.2
class Counter extends Notifier<int> {
  @override
  int build() => 0;

  void increment() => state++;
}

final counterProvider = NotifierProvider<Counter, int>(Counter.new);
```

`ref.watch(counterProvider)` te dá um `int`, não um `AsyncValue<int>`. Não há ramo de carregamento para renderizar nem ramo de erro, e esse é exatamente o ponto: a seleção de um filtro, a flag de "alterado" de um formulário, o índice da aba selecionada, um carrinho de compras em memória. Se você se pegar escrevendo `AsyncData(...)` em volta de um valor que já tem, escolheu a classe base errada.

O que surpreende quem vem do `StateNotifier`: `build()` pode rodar de novo. Se você fizer `ref.watch` de outro provider lá dentro, uma mudança acima na cadeia reexecuta `build()` e reseta seu estado. A instância do notifier é preservada, então campos de instância sobrevivem:

```dart
// Verified: constructed once, built twice after the dependency changed.
expect(Instanced.built, 2);        // build() re-ran
expect(Instanced.constructed, 1);  // the object was not recreated
```

## Quando escolher AsyncNotifier

Vá de `AsyncNotifier<T>` quando o estado inicial vem de um `Future` e todo valor depois disso vem dos seus próprios métodos de mutação.

```dart
// flutter_riverpod 3.4.2
class AsyncCounter extends AsyncNotifier<int> {
  @override
  Future<int> build() async {
    await Future<void>.delayed(const Duration(milliseconds: 10));
    return 0;
  }

  Future<void> increment() async {
    final current = await future;      // resolves to the latest non-loading value
    state = AsyncData(current + 1);
  }
}

final asyncCounterProvider =
    AsyncNotifierProvider<AsyncCounter, int>(AsyncCounter.new);
```

O getter `future` dentro do notifier e o modificador `.future` no provider vêm ambos do mixin `$AsyncClassModifier`. O `update()` também, que é a versão ergonômica do ler-modificar-escrever acima:

```dart
Future<void> increment() => update((current) => current + 1);
```

Um detalhe que vale conhecer porque muda o que seu widget renderiza no primeiro frame: `build()` retorna `FutureOr<T>`, então retornar um valor de forma síncrona é legal, e quando você faz isso o provider nunca passa por `AsyncLoading`.

```dart
class SyncishAsync extends AsyncNotifier<int> {
  @override
  int build() => 42;   // legal: FutureOr<int> accepts int
}

// Verified: the very first read is AsyncData(42), not AsyncLoading.
expect(container.read(syncishProvider), isA<AsyncData<int>>());
```

Isso faz do `AsyncNotifier` um padrão razoável para estado que é síncrono hoje mas que você espera mover para trás de uma chamada de rede depois. Você paga com um invólucro `AsyncValue` que precisa desembrulhar em cada widget, e é por isso que eu não usaria para um índice de aba. Para renderizar esse invólucro de forma limpa, a mecânica é a mesma coberta em [exibir estados de carregamento e erro com AsyncValue](/pt-br/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/).

## Quando escolher StreamNotifier

Vá de `StreamNotifier<T>` quando a fonte continua empurrando dados. Um listener de snapshots do Firestore, um WebSocket, um `Stream` de um plugin, um timer periódico.

```dart
// flutter_riverpod 3.4.2
class Ticker extends StreamNotifier<int> {
  @override
  Stream<int> build() {
    final controller = StreamController<int>();
    var i = 0;
    final timer = Timer.periodic(const Duration(milliseconds: 5), (_) {
      controller.add(i++);
    });
    ref.onDispose(() {
      timer.cancel();
      controller.close();
    });
    return controller.stream;
  }
}

final tickerProvider = StreamNotifierProvider<Ticker, int>(Ticker.new);
```

O comportamento distintivo é que o estado continua mudando sem você escrever em `state`. Escutar esse provider e coletar as emissões dá `[0, 1, 2, ...]`, onde um `AsyncNotifier` teria dado exatamente um `AsyncData` e parado.

O Riverpod gerencia a assinatura para você. Quando `build()` roda de novo porque uma dependência observada mudou, a assinatura anterior é cancelada antes de o novo stream ser assinado:

```dart
// Verified with a StreamController whose onCancel increments a counter.
expect(Feed.subscribes, 2);  // build re-ran, new stream
expect(Feed.cancels, 1);     // Riverpod cancelled the old subscription
```

Você ainda precisa do `ref.onDispose` acima para recursos que o próprio stream não possui, como o `Timer`. O Riverpod cancela a assinatura dele no seu stream; ele não conhece o timer que alimenta o stream. É a mesma disciplina de [descartar controllers no Flutter para evitar vazamentos de memória](/pt-br/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).

## AsyncNotifier e StreamNotifier são irmãos, não pai e filho

O dartdoc de `StreamNotifier` o chama de "uma variante de `AsyncNotifier`", o que soa como herança. Não é. Ambos estendem a mesma base interna e diferem apenas em um argumento genérico:

```dart
// package:riverpod/src/providers/async_notifier.dart, riverpod 3.4.2
abstract class $AsyncNotifier<ValueT> extends $AsyncNotifierBase<ValueT>
    with $AsyncClassModifier<ValueT, FutureOr<ValueT>> {}

// package:riverpod/src/providers/stream_notifier.dart
abstract class $StreamNotifier<ValueT> extends $AsyncNotifierBase<ValueT>
    with $AsyncClassModifier<ValueT, Stream<ValueT>> {}
```

`$AsyncNotifierBase<ValueT>` estende `AnyNotifier<AsyncValue<ValueT>, ValueT>` nos dois casos, e é por isso que ambos expõem `AsyncValue<T>` e ambos ganham `future` e `update()`. A única diferença é `CreatedT`: `FutureOr<ValueT>` contra `Stream<ValueT>`. Enquanto isso `$Notifier<StateT>` estende `$SyncNotifierBase<StateT>`, que estende `AnyNotifier<StateT, StateT>`, então seu tipo de estado e seu tipo de valor são o mesmo.

A consequência prática é que uma verificação de tipo contra `AsyncNotifier` não vai casar com um `StreamNotifier`, então código genérico que faz `if (notifier is AsyncNotifier)` pula silenciosamente seus providers baseados em stream:

```dart
// Verified on riverpod 3.4.2
expect(Ticker(), isNot(isA<AsyncNotifier<int>>()));
expect(AsyncCounter(), isNot(isA<StreamNotifier<int>>()));
```

## A armadilha da filtragem por == atinge as três

O Riverpod 3.0 padronizou o uso de `==` para decidir se notifica os listeners. A maioria dos textos trata isso como um problema do `Notifier`, porque o sintoma clássico é mutar uma `List` no lugar e não ver rebuild nenhum. Não é um problema do `Notifier`. Vale para `AsyncNotifier` e `StreamNotifier` também, porque `AsyncValue.operator ==` compara o valor embrulhado com `==`:

```dart
// package:riverpod/src/core/async_value.dart, riverpod 3.4.2
@override
bool operator ==(Object other) {
  return runtimeType == other.runtimeType &&
      other is AsyncValue<ValueT> &&
      other._loading == _loading &&
      other.valueFilled == valueFilled &&
      other._errorFilled == _errorFilled;
}
```

Embrulhar a mesma instância de `List` em um `AsyncData` novo produz portanto um valor que é `==` ao estado anterior, e a notificação é descartada:

```dart
// Verified: both of these are silent no-ops for listeners.
class AsyncTodoList extends AsyncNotifier<List<String>> {
  @override
  List<String> build() => <String>[];

  void addMutating(String v) {
    final list = state.requireValue..add(v);
    state = AsyncData(list);            // same list instance, == is true
  }

  void addReplacing(String v) =>
      state = AsyncData([...state.requireValue, v]);   // new list, notifies
}

final list = ['x'];
expect(AsyncData(list) == AsyncData(list), isTrue);
expect(AsyncData(['x']) == AsyncData(['x']), isFalse);
```

A correção é a mesma nas três classes: sempre atribua uma nova instância da coleção em vez de mutar e reatribuir. A saída de emergência também é a mesma, mas repare que a assinatura muda com a classe base, porque `updateShouldNotify` recebe o tipo de *estado*, não o tipo de valor:

```dart
// Notifier<List<String>>
@override
bool updateShouldNotify(List<String> previous, List<String> next) => true;

// AsyncNotifier<List<String>> or StreamNotifier<List<String>>
@override
bool updateShouldNotify(
  AsyncValue<List<String>> previous,
  AsyncValue<List<String>> next,
) => true;
```

Se você chegou aqui depois de um stream misteriosamente parar de atualizar a UI, a mesma causa raiz é coberta com mais profundidade no texto sobre [os eventos do StreamProvider filtrados por igualdade no Riverpod 3.0](/pt-br/2026/07/fix-riverpod-3-0-streamprovider-stops-emitting-filtered-by-equality/).

## A armadilha do StreamNotifier: suas escritas são sobrescritas

`StreamNotifier` herda o setter de `state`, então nada impede você de atribuir a ele. Mas o stream continua vivo, e o próximo evento vence:

```dart
// Verified against a StreamNotifier whose build() emits every 5ms.
container.read(tickerProvider.notifier).poke();       // state = AsyncData(999)
expect(container.read(tickerProvider).value, 999);    // holds, briefly

await Future<void>.delayed(const Duration(milliseconds: 20));
expect(container.read(tickerProvider).value, isNot(999));  // the stream won
```

Isso não é um bug, e não é motivo para evitar métodos de mutação em um `StreamNotifier`. É motivo para tornar a mutação otimista e deixar o stream confirmá-la. Escreva em `state` para a resposta imediata da UI, envie a mudança para o backend, e deixe o evento devolvido pelo stream virar a fonte da verdade:

```dart
// flutter_riverpod 3.4.2
Future<void> send(String message) async {
  state = AsyncData([...(state.value ?? const []), message]);  // optimistic
  await _api.post(message);   // the server echoes this back down the stream
}
```

Se o stream não devolve suas mutações, seu problema não tem formato de stream. Use um `AsyncNotifier` e cuide do estado você mesmo.

## A geração de código escolhe por você

Com o `riverpod_generator` você nunca nomeia a classe base. Você anota com `@riverpod`, estende o `_$Foo` gerado, e o gerador lê o tipo de retorno de `build()`. Aqui estão três classes que diferem só nesse tipo de retorno, e as declarações geradas correspondentes do `riverpod_generator` 4.0.4:

```dart
// gen.dart
@riverpod
class Counter extends _$Counter {
  @override
  int build() => 0;
}

@riverpod
class AsyncCounter extends _$AsyncCounter {
  @override
  Future<int> build() async => 0;
}

@riverpod
class Ticker extends _$Ticker {
  @override
  Stream<int> build() => Stream.value(0);
}
```

```dart
// gen.g.dart, generated
final class CounterProvider extends $NotifierProvider<Counter, int> { ... }
abstract class _$Counter extends $Notifier<int> { ... }

final class AsyncCounterProvider
    extends $AsyncNotifierProvider<AsyncCounter, int> { ... }
abstract class _$AsyncCounter extends $AsyncNotifier<int> { ... }

final class TickerProvider extends $StreamNotifierProvider<Ticker, int> { ... }
abstract class _$Ticker extends $StreamNotifier<int> { ... }
```

Troque `Future<int> build()` por `Stream<int> build()`, rode o builder de novo, e a classe base muda por baixo sem nenhuma outra edição. Esse é o argumento prático mais forte a favor da geração de código nessa pergunta específica.

Uma assimetria que a saída gerada torna visível: providers gerados são auto-disposing, os escritos à mão não.

```dart
// gen.g.dart: every generated provider passes isAutoDispose: true
CounterProvider._() : super(..., isAutoDispose: true, ...);

// Hand-written, verified on riverpod 3.4.2:
expect(counterProvider.isAutoDispose, isFalse);
expect(asyncCounterProvider.isAutoDispose, isFalse);
expect(tickerProvider.isAutoDispose, isFalse);
```

Para um `StreamNotifier` essa diferença sai cara: um provider de stream escrito à mão mantém a assinatura aberta para sempre assim que algo o lê, porque `NotifierProvider`, `AsyncNotifierProvider` e `StreamNotifierProvider` deixam `isAutoDispose` em `false` por padrão. Passe `NotifierProvider(..., isAutoDispose: true)` se quiser o comportamento gerado sem gerar.

## Mais uma ressalva de versão

No Flutter 3.44.2 os pacotes mais novos não resolvem juntos no momento. `flutter_riverpod` 3.4.2 mais qualquer versão do `riverpod_generator` falha na resolução de versões contra o `matcher` 0.12.19 e o `test_api` 0.7.11 que esse SDK do Flutter fixa via `flutter_test`. A combinação que resolve limpa é `flutter_riverpod` 3.3.2 com `riverpod_annotation` 4.0.3 e `riverpod_generator` 4.0.4, que foi de onde saiu a saída gerada acima. Nada na regra de seleção de classe difere entre 3.3.2 e 3.4.2, mas se você usa geração de código, espere ficar uma versão menor atrás do pacote de runtime até a restrição do SDK alcançar.

## A recomendação

Por padrão use `AsyncNotifier` para tudo que toca E/S, `Notifier` para tudo que não toca, e `StreamNotifier` só quando uma fonte de fato empurra mais de um valor. O modo de falha de escolher `AsyncNotifier` quando `Notifier` bastaria é um pouco de ruído de desembrulhar `AsyncValue` nos seus widgets. O modo de falha de escolher `Notifier` quando o dado é assíncrono é um campo `late`, um `LateInitializationError` e um booleano de carregamento manual, o que é estritamente pior. E se você usa geração de código, pare de pensar nisso: escreva o `build()` que você realmente quer e deixe o gerador escolher.

## Relacionados

- [Qual pacote do Riverpod instalar: riverpod, flutter_riverpod ou hooks_riverpod](/pt-br/2026/07/riverpod-vs-flutter-riverpod-vs-hooks-riverpod-which-package-do-i-need/)
- [FutureBuilder e StreamBuilder comparados ao AsyncValue do Riverpod](/pt-br/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/)
- [O guia completo de migração do Riverpod 2.x para o 3.0](/pt-br/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/)
- [Movendo um StatefulWidget com setState para um Notifier do Riverpod](/pt-br/2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter/)
- [Transformando um FutureBuilder em um AsyncNotifier do Riverpod](/pt-br/2026/06/migrate-from-futurebuilder-to-a-riverpod-asyncnotifier-in-flutter/)

## Fontes

- [O que há de novo no Riverpod 3.0](https://riverpod.dev/docs/whats_new), sobre a unificação dos notifiers e a mudança para `==` na filtragem de notificações.
- [riverpod 3.4.2 no pub.dev](https://pub.dev/packages/riverpod/versions/3.4.2), fonte das declarações de `Notifier`, `AsyncNotifier` e `StreamNotifier` citadas acima.
- [flutter_riverpod 3.4.2 no pub.dev](https://pub.dev/packages/flutter_riverpod/versions/3.4.2).
- [riverpod_generator 4.0.4 no pub.dev](https://pub.dev/packages/riverpod_generator/versions/4.0.4), o gerador cuja saída é mostrada na seção de geração de código.
