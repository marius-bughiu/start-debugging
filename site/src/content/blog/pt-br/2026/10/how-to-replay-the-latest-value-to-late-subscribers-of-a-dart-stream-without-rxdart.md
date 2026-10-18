---
title: "Como reemitir o último valor para assinantes tardios de um Stream do Dart sem o BehaviorSubject do rxdart"
description: "Um StreamController broadcast descarta todo evento disparado antes de você assinar. Aqui está um substituto do BehaviorSubject sem dependências, construído com Stream.multi, uma extensão replayLatest() para streams existentes, o atalho com async* que perde eventos silenciosamente e o detalhe do initialData no StreamBuilder, tudo verificado no Dart 3.12.2."
pubDate: 2026-10-18
template: how-to
tags:
  - "dart"
  - "flutter"
  - "streams"
  - "how-to"
lang: "pt-br"
translationOf: "2026/10/how-to-replay-the-latest-value-to-late-subscribers-of-a-dart-stream-without-rxdart"
translatedBy: "claude"
translationDate: 2026-10-18
---

**Resposta curta:** envolva um `StreamController.broadcast()` em uma classe pequena que também guarda o último valor e exponha o stream por meio de `Stream.multi`. O `Stream.multi` chama seu callback `onListen` uma vez por assinante, com o `MultiStreamController` próprio daquele assinante, então você pode usar `add` com o valor em cache apenas para o novo ouvinte e depois repassar os eventos do broadcast. Esse é todo o comportamento do `BehaviorSubject` do rxdart, em cerca de 40 linhas de `dart:async`. O `Stream.multi` existe no SDK desde o Dart 2.9, e todos os trechos abaixo foram executados no Dart 3.12.2 (o SDK que acompanha o Flutter 3.44).

O restante deste post mostra por que o controller broadcast simples falha, a classe completa, uma extensão que transforma qualquer stream existente em um stream com reemissão e os casos de borda que importam em um app Flutter: erros, `close()`, pausa, cancelamento e o primeiro frame de um `StreamBuilder`.

## Por que um stream broadcast esquece tudo

Um `StreamController` de assinatura única guarda eventos em buffer até alguém ouvir, mas permite exatamente um ouvinte. Um controller broadcast permite qualquer número de ouvintes, e o preço é que ele não guarda nada em buffer. Um evento é entregue a quem estiver inscrito no momento em que ele é disparado, e depois some.

```dart
// Dart 3.12.2
import 'dart:async';

Future<void> main() async {
  final controller = StreamController<int>.broadcast();
  controller.add(1);                 // nobody is listening: dropped
  await Future(() {});

  controller.stream.listen((v) => print('late listener got $v'));
  controller.add(2);
  await Future(() {});
}
// Output:
// late listener got 2
```

Esse é o padrão certo para dados no estilo de evento (toques, notificações, linhas de log) e o errado para dados no estilo de estado. Se o stream representa "o usuário atual" ou "o status da conexão", um widget que se inscreve depois da última mudança não mostra nada até a próxima mudança, que pode nunca vir. No Flutter, isso costuma aparecer como um `StreamBuilder` preso no ramo de carregamento em uma tela para a qual você navegou depois que os dados já tinham sido carregados.

O rxdart resolve isso com o `BehaviorSubject`, que lembra o último evento e o emite para todo novo assinante. Se você já depende do rxdart, use-o. Se você só precisa desse único comportamento, trazer uma biblioteca inteira de extensões reativas para isso é exagero, e o SDK já tem a primitiva de que você precisa.

## A primitiva: Stream.multi dá a cada ouvinte seu próprio controller

`Stream<T>.multi(void Function(MultiStreamController<T>) onListen, {bool isBroadcast = false})` cria um stream que pode ser ouvido qualquer número de vezes. Cada chamada a `listen` invoca `onListen` com um `MultiStreamController` novo, e tudo o que você passar para `add` nesse controller vai somente para aquela assinatura.

Esse gancho por ouvinte é exatamente o que falta a um controller broadcast. O `StreamController.broadcast(onListen: ...)` dispara `onListen` apenas quando a contagem de ouvintes passa de zero para um, então o segundo, o terceiro e o centésimo assinante nunca recebem um callback em que você possa entregar o valor em cache.

A flag `isBroadcast` não muda o comportamento. Ela só define o getter `Stream.isBroadcast`, que alguns consumidores verificam. Defina-a como `true` quando seu stream se comportar como um stream broadcast (vários ouvintes permitidos, sem buffer por ouvinte do passado além do que você reemite), que é o caso aqui.

## Passo a passo: um BehaviorSubject sem dependências

1. Mantenha um `StreamController` broadcast como hub de eventos.
2. Guarde o último valor (e se existe um valor) ao lado dele.
3. Exponha uma única instância de `Stream.multi` cujo `onListen` primeiro adiciona o valor em cache ao controller do novo assinante e depois repassa a ele os eventos do hub.
4. Conecte pause, resume e cancel do controller por ouvinte à assinatura do hub, para que nada vaze.

```dart
// Dart 3.12.2 (Stream.multi requires Dart 2.9+)
import 'dart:async';

class ValueStream<T> {
  ValueStream(T initial) : _value = initial, _hasValue = true;
  ValueStream.empty();

  final _hub = StreamController<T>.broadcast();
  late T _value;
  bool _hasValue = false;
  Object? _error;
  StackTrace? _stackTrace;

  /// Synchronous access, like BehaviorSubject.value.
  T get value => _value;
  bool get hasValue => _hasValue;

  void add(T value) {
    _value = value;
    _hasValue = true;
    _error = null;
    _hub.add(value);
  }

  void addError(Object error, [StackTrace? stackTrace]) {
    _error = error;
    _stackTrace = stackTrace;
    _hub.addError(error, stackTrace);
  }

  Future<void> close() => _hub.close();

  late final Stream<T> stream = Stream.multi((controller) {
    // 1. Replay the latest event to this listener only.
    if (_error != null) {
      controller.addError(_error!, _stackTrace);
    } else if (_hasValue) {
      controller.add(_value);
    }

    // 2. Already closed: replay, then finish.
    if (_hub.isClosed) {
      controller.close();
      return;
    }

    // 3. Forward future events.
    final sub = _hub.stream.listen(
      controller.add,
      onError: controller.addError,
      onDone: controller.close,
    );
    controller
      ..onPause = sub.pause
      ..onResume = sub.resume
      ..onCancel = sub.cancel;
  }, isBroadcast: true);
}
```

Usá-lo fica assim:

```dart
// Dart 3.12.2
Future<void> main() async {
  final status = ValueStream<int>(0);
  status.add(1);

  status.stream.listen((v) => print('A got $v'));
  await Future(() {});
  status.add(2);
  await Future(() {});

  status.stream.listen((v) => print('B got $v'));   // subscribes late
  await Future(() {});
  status.add(3);
  await Future(() {});
}
// Output:
// A got 1
// A got 2
// B got 2
// A got 3
// B got 3
```

O `B` se inscreveu depois que o `2` foi emitido e mesmo assim o recebeu, seguido de todos os eventos posteriores. O `A` não recebeu um `2` duplicado quando o `B` entrou, porque a reemissão foi para o controller do próprio `B`.

Algumas escolhas deliberadas nessa classe:

- **`stream` é um campo `late final`, não um getter.** Uma única instância de `Stream.multi` pode ser ouvida muitas vezes, então não há motivo para alocar uma nova a cada acesso. Isso também mantém `identical(store.stream, store.stream)` verdadeiro, o que importa para o `StreamBuilder` (mais abaixo).
- **A reemissão usa `add`, não `addSync`.** O `MultiStreamController` tem `addSync`, `addErrorSync` e `closeSync`, que entregam imediatamente. A documentação da API diz para usá-los apenas quando o ouvinte está pronto para receber eventos, tipicamente de dentro de outro callback assíncrono. Chamá-los dentro de `onListen` entregaria um evento antes mesmo de `listen()` ter devolvido a assinatura, o que quebra a convenção do Dart de que streams nunca emitem de forma síncrona durante o `listen`. O `add` simples enfileira o evento e preserva a ordem: no meu teste, um `listen` seguido imediatamente de duas chamadas síncronas a `add` produziu `100, 101, 102`, nessa ordem.
- **Os erros também são reemitidos.** Se a última coisa que aconteceu foi um erro, um assinante tardio vê o erro em vez de um valor desatualizado. Remova o ramo `_error` se preferir reemitir o último valor válido. O `BehaviorSubject` reemite o último evento, erro incluído, então isso o espelha.

## Transformando um stream existente em um stream com reemissão

Muitas vezes você não é dono do controller. Você recebe um `Stream<T>` de um plugin, de um snapshot do Firestore ou de um `Socket`, e quer que vários widgets o compartilhem com o último valor reemitido. A documentação do SDK para `Stream.multi` inclui um exemplo de `repeatLatest()` nessa linha. Aqui está uma versão que também trata erros, conclusão e conexão preguiçosa:

```dart
// Dart 3.12.2
import 'dart:async';

extension ReplayLatest<T> on Stream<T> {
  Stream<T> replayLatest() {
    final hub = StreamController<T>.broadcast();
    StreamSubscription<T>? source;
    var hasLatest = false;
    late T latest;
    var done = false;

    void connect() {
      source ??= listen(
        (value) {
          hasLatest = true;
          latest = value;
          hub.add(value);
        },
        onError: hub.addError,
        onDone: () {
          done = true;
          hub.close();
        },
      );
    }

    return Stream.multi((controller) {
      connect();                       // subscribe to the source on first listen
      if (hasLatest) controller.add(latest);
      if (done) {
        controller.close();
        return;
      }
      final sub = hub.stream.listen(
        controller.add,
        onError: controller.addError,
        onDone: controller.close,
      );
      controller
        ..onPause = sub.pause
        ..onResume = sub.resume
        ..onCancel = sub.cancel;
    }, isBroadcast: true);
  }
}
```

Ela funciona com fontes de assinatura única, que é justamente o ponto: a extensão ouve a fonte exatamente uma vez e distribui os eventos.

```dart
// Dart 3.12.2
Future<void> main() async {
  final source = StreamController<int>();          // single-subscription
  final shared = source.stream.replayLatest();

  shared.listen((v) => print('first: $v'));
  source.add(1);
  source.add(2);
  await Future(() {});

  shared.listen((v) => print('late: $v'), onDone: () => print('late: done'));
  await Future(() {});
  source.add(3);
  await source.close();
  await Future(() {});

  shared.listen((v) => print('after close: $v'),
      onDone: () => print('after close: done'));
  await Future(() {});
}
// Output:
// first: 1
// first: 2
// late: 2
// first: 3
// late: 3
// late: done
// after close: 3
// after close: done
```

Observe o que essa extensão deliberadamente não faz: ela nunca cancela a assinatura da fonte, mesmo quando todos os ouvintes já saíram. Isso difere do `shareValue()` do rxdart, que usa contagem de referências e cancela a fonte quando o último ouvinte sai; essa extensão se comporta como um `publishValue()` conectado uma vez e mantido vivo, que é o que você quer para estado com a duração do app. Se a fonte for cara (um stream de GPS, um WebSocket), adicione contagem de referências: acompanhe o número de controllers por ouvinte ativos em `onListen` e `onCancel` e cancele `source` quando chegar a zero. Decida de antemão se um assinante tardio depois desse ponto ainda deve receber o valor antigo em cache ou esperar por uma reconexão.

## O atalho com async* que perde eventos

A primeira coisa que a maioria das pessoas tenta é um generator:

```dart
// Dart 3.12.2 - looks right, is racy
Stream<T> withLatest<T>(T Function() current, Stream<T> updates) async* {
  yield current();
  yield* updates;
}
```

Ele parece perfeito, e está errado. Uma função `async*` é suspensa no `yield` até que o evento tenha sido entregue, e só então continua até a linha `yield*`, que é o momento em que ela se inscreve no `updates` broadcast. Qualquer coisa emitida entre a chamada a listen e essa inscrição cai na lacuna. Reproduzi isso com um evento agendado um microtask depois do `listen`:

```dart
// Dart 3.12.2
Future<void> main() async {
  final updates = StreamController<int>.broadcast();
  var current = 20;

  withLatest(() => current, updates.stream)
      .listen((v) => print('got $v'));

  scheduleMicrotask(() {
    current = 21;
    updates.add(21);
  });
  await Future(() {});
  await Future(() {});
}
// Output:
// got 20
```

O `21` nunca é impresso. O assinante fica preso mostrando `20` enquanto o estado real é `21`, e nenhum evento posterior vai corrigir isso até que outra coisa mude. A versão com `Stream.multi` não tem essa lacuna porque se inscreve no hub de forma síncrona dentro de `onListen`, antes que qualquer evento enfileirado possa disparar.

## Armadilhas em um app Flutter

**O `StreamBuilder` ainda mostra um frame de "waiting".** A reemissão é assíncrona (essa é a escolha entre `add` e `addSync` acima), e o `StreamBuilder` constrói seu primeiro frame logo depois de se inscrever no `initState`. Sem ajuda, esse primeiro frame tem `ConnectionState.waiting` e nenhum dado, o que aparece como um flash de um frame do seu indicador de carregamento. Como o `ValueStream` expõe o valor atual de forma síncrona, passe-o como `initialData`:

```dart
// Flutter 3.44, Dart 3.12.2
StreamBuilder<int>(
  stream: status.stream,
  initialData: status.hasValue ? status.value : null,
  builder: (context, snapshot) {
    if (!snapshot.hasData) return const CircularProgressIndicator();
    return Text('Status: ${snapshot.data}');
  },
)
```

**Não construa o stream dentro do `build`.** O `StreamBuilder` se reinscreve quando recebe um stream que não é o mesmo objeto da vez anterior. Um getter que retorna `Stream.multi(...)` ou `source.replayLatest()` a cada acesso cria um stream novo a cada rebuild, então todo rebuild cancela e se reinscreve, e com `replayLatest()` isso também abre uma nova assinatura da fonte. Crie o stream uma vez, em um campo, em um serviço ou no `initState`. A mesma regra vale para futures, como visto em [como inicializar um Future para que o FutureBuilder não o recrie a cada rebuild](/pt-br/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/).

**O cancelamento está conectado, mas você ainda precisa cancelar.** Como o `onCancel` é repassado para a assinatura do hub, um ouvinte cancelado é removido do controller broadcast. No meu teste, `_hub.hasListener` passou de `true` para `false` depois de `cancel()`. Ouvintes em que você chama `listen` manualmente ainda precisam de um campo `StreamSubscription` e de um `cancel()` no `dispose`, exatamente como em [cancelar uma StreamSubscription no dispose](/pt-br/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/). O `StreamBuilder` faz isso por você.

**Feche o hub quando o dono sair de cena.** Um `ValueStream` pertencente ao `State` de um widget deve ser fechado no `dispose()`, junto dos seus outros controllers, como descrito em [descartar controllers para evitar vazamentos de memória](/pt-br/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/). Ouvir depois de `close()` é seguro: o assinante recebe o valor final e depois um evento done.

**Erros reemitidos não tratados continuam não tratados.** Se você reemite um erro para um ouvinte que não tem `onError`, ele vira um erro assíncrono não capturado e vai para o tratador de erros da zona, que no Flutter é o `PlatformDispatcher.instance.onError`. Veja [capturar erros assíncronos não capturados no Flutter](/pt-br/2026/10/how-to-catch-uncaught-async-errors-in-flutter-with-runzonedguarded-and-platformdispatcher/) para saber onde isso vai parar.

**Filtrar por igualdade é uma decisão à parte.** O `BehaviorSubject` não elimina duplicatas, e esta classe também não. Se você quer "emitir apenas quando o valor mudar", adicione uma guarda `if (value == _value) return;` em `add` e fique atento aos trade-offs com objetos mutáveis, que cometem o mesmo erro do [filtro de igualdade do StreamProvider do Riverpod](/pt-br/2026/07/fix-riverpod-3-0-streamprovider-stops-emitting-filtered-by-equality/).

## Quando você não precisa de um stream

Se o valor só alimenta widgets e nunca cruza uma fronteira assíncrona, um `ValueNotifier<T>` com `ValueListenableBuilder` é mais simples que qualquer stream: ele tem um `value` síncrono, notifica os ouvintes quando muda, e o builder lê o valor atual no primeiro frame, então não há flash de carregamento. Recorra ao stream com reemissão quando precisar de operadores de stream (`where`, `asyncMap`, transformações no estilo `debounce`), quando os dados vierem de uma API de `Stream` existente ou quando uma biblioteca de gerenciamento de estado, como o `StreamProvider` do Riverpod, esperar um stream. Para uma comparação mais ampla dessas opções, veja [FutureBuilder e StreamBuilder vs AsyncValue do Riverpod](/pt-br/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/).

E quando você precisar de mais que o último valor, como "reemitir os últimos 10 eventos" ou "reemitir tudo", a mesma estrutura com `Stream.multi` funciona com uma `Queue<T>` limitada no lugar de um único campo. Nesse ponto você está reimplementando o `ReplaySubject` do rxdart, e adicionar o pacote é uma troca razoável.

## Fontes

- [Stream.multi constructor, Dart API docs](https://api.dart.dev/stable/dart-async/Stream/Stream.multi.html)
- [MultiStreamController class, Dart API docs](https://api.dart.dev/stable/dart-async/MultiStreamController-class.html)
- [StreamController.broadcast, Dart API docs](https://api.dart.dev/stable/dart-async/StreamController/StreamController.broadcast.html)
- [Dart SDK 2.9 changelog entry for Stream.multi](https://dart.googlesource.com/sdk/+/refs/tags/2.9.1/CHANGELOG.md)
- [rxdart on pub.dev (BehaviorSubject, ReplaySubject, shareValue)](https://pub.dev/packages/rxdart)
- [Asynchronous programming: streams, dart.dev](https://dart.dev/libraries/async/using-streams)
- [StreamBuilder class, Flutter API docs](https://api.flutter.dev/flutter/widgets/StreamBuilder-class.html)
