---
title: "Correção: Bad state: Stream has already been listened to no Flutter"
description: "Uma stream de assinatura única aceita exatamente um listen() durante toda a sua vida. Crie a stream uma única vez e entregue-a a um só ouvinte, ou compartilhe-a com asBroadcastStream ou Stream.multi."
pubDate: 2026-10-20
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "streams"
lang: "pt-br"
translationOf: "2026/10/fix-bad-state-stream-has-already-been-listened-to-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-20
---

`Bad state: Stream has already been listened to.` significa que algo chamou `listen()` uma segunda vez em uma stream de assinatura única. Esse tipo de stream aceita exatamente uma assinatura em toda a sua vida, e cancelar a primeira não a reinicia. No Flutter, o segundo `listen()` quase sempre vem de um `StreamBuilder`: dois builders na mesma stream, um builder que foi remontado, ou um `.map()`/`.where()` escrito dentro de `build()`. A correção é criar cada stream derivada uma única vez (em `initState` ou no seu objeto de estado) e, quando mais de um widget realmente precisa dos eventos, compartilhar a origem com `asBroadcastStream()`, um `StreamController.broadcast()` ou um `Stream.multi` por ouvinte.

Cada reprodução e correção abaixo foi executada no Flutter 3.44.8 com Dart 3.12.2: os casos de Dart puro com `dart run`, os casos de widget como testes de widget com `flutter test`.

## O erro em contexto

No Dart puro, a exceção surge do segundo `listen()`, e o frame do topo é o controller recusando um segundo assinante:

```text
StateError: Bad state: Stream has already been listened to.
#0      _StreamController._subscribe (dart:async/stream_controller.dart:695:7)
#1      _ControllerStream._createSubscription (dart:async/stream_controller.dart:854:20)
#2      _StreamImpl.listen (dart:async/stream_impl.dart:516:42)
#3      main.<anonymous closure> (file:///.../repro.dart:20:14)
```

Em um app Flutter, o mesmo `StateError` é capturado pela biblioteca de widgets e reportado contra o que estava sendo construído naquele momento. Os frames que importam são as duas linhas de `_StreamBuilderBaseState`:

```text
══╡ EXCEPTION CAUGHT BY WIDGETS LIBRARY ╞═════════════════════════════════════
The following StateError was thrown building StatefulBuilder(state: _StatefulBuilderState#352fb):
Bad state: Stream has already been listened to.

When the exception was thrown, this was the stack:
#6      _StreamBuilderBaseState._subscribe (package:flutter/src/widgets/async.dart:133:38)
#7      _StreamBuilderBaseState.didUpdateWidget (package:flutter/src/widgets/async.dart:118:7)
#8      StatefulElement.update (package:flutter/src/widgets/framework.dart:5991:55)
```

Se o frame abaixo de `_subscribe` for `initState`, um novo estado de `StreamBuilder` foi criado e assinou uma stream que já pertence a outra pessoa. Se for `didUpdateWidget`, o builder recebeu um objeto de stream *diferente* em uma reconstrução e o assinou, e esse novo objeto está sobre uma origem que já foi tomada. Essa única linha diz qual das causas abaixo é a sua.

## Por que uma stream recusa um segundo ouvinte

O Dart tem dois tipos de stream. Uma stream de **assinatura única** (single-subscription) é uma sequência de uso único: ela guarda os eventos em buffer até alguém ouvir, entrega-os a esse único ouvinte e termina. Uma stream **broadcast** pode ter qualquer número de ouvintes, mas não guarda nada em buffer: cada evento vai para quem estiver inscrito naquele momento.

`StreamController()`, geradores `async*`, `Stream.value`, `Stream.periodic`, `Future.asStream()`, `File.openRead()`, `Process.stdout` e o corpo de um `StreamedResponse` do `http` são todos de assinatura única. Quando você chama `listen()` uma segunda vez, o controller lança a exceção, e lança mesmo que a primeira assinatura já tenha sido cancelada. Verifiquei isso explicitamente:

```dart
// Dart 3.12.2
import 'dart:async';

Future<void> main() async {
  final c = StreamController<int>();
  final first = c.stream.listen((_) {});
  await first.cancel();
  c.stream.listen((_) {}); // StateError: Bad state: Stream has already been listened to.
}
```

Dois fatos menos óbvios produzem a maior parte da confusão:

1. **Operadores ouvem por você.** `map`, `where`, `expand`, `asyncMap`, `transform`, `distinct` e similares retornam uma nova stream que assina a origem quando *ela* é ouvida. Assim, `c.stream.where(...)` e `c.stream.map(...)` são dois objetos de stream diferentes, mas ouvir os dois ainda significa duas chamadas de `listen()` em `c.stream`, e a segunda lança a exceção.
2. **Métodos de consumo também ouvem.** `first`, `last`, `length`, `toList()`, `forEach`, `drain`, `await for`, `pipe` e `bytesToString()` em um corpo `http` são todos `listen()` por baixo dos panos. Chamar `await stream.first` e depois `await stream.toList()` em uma stream `async*` lança a exceção na segunda chamada.

O tipo também não diz de forma confiável o que você tem. No Dart 3.12.2, `isBroadcast` é `false` para `Stream.fromIterable`, mas essa stream específica pode ser ouvida mais de uma vez (cada ouvinte recebe sua própria passada pelo iterable), enquanto `Stream.value(1)` e `Future.value(1).asStream()` lançam a exceção no segundo `toList()`. Trate toda stream que você não criou como de assinatura única, a menos que a documentação diga o contrário.

## Reprodução mínima: três formas de um StreamBuilder causar o erro

Os três casos abaixo falham com o erro acima. O helper é apenas um `StreamBuilder` que imprime o último valor:

```dart
// Flutter 3.44.8, Dart 3.12.2
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget sb(Stream<int> s) => StreamBuilder<int>(
      stream: s,
      builder: (context, snap) =>
          Text('${snap.data}', textDirection: TextDirection.ltr),
    );

void main() {
  // A: two StreamBuilders on one single-subscription stream (throws in initState)
  testWidgets('A', (t) async {
    final c = StreamController<int>();
    await t.pumpWidget(Column(children: [sb(c.stream), sb(c.stream)]));
  });

  // B: .map() inside build, then the parent rebuilds (throws in didUpdateWidget)
  testWidgets('B', (t) async {
    final c = StreamController<int>();
    late StateSetter rebuild;
    await t.pumpWidget(StatefulBuilder(builder: (context, set) {
      rebuild = set;
      return sb(c.stream.map((x) => x * 2));
    }));
    rebuild(() {});
    await t.pump();
  });

  // C: same stream object, but the StreamBuilder is remounted (throws in initState)
  testWidgets('C', (t) async {
    final stream = StreamController<int>().stream;
    await t.pumpWidget(KeyedSubtree(key: const ValueKey(1), child: sb(stream)));
    await t.pumpWidget(KeyedSubtree(key: const ValueKey(2), child: sb(stream)));
  });
}
```

O caso B é o que mais pega as pessoas, porque o primeiro frame funciona. O `StreamBuilder` só reassina quando `oldWidget.stream != widget.stream` (essa é a verificação de `didUpdateWidget` em `async.dart`), e `c.stream.map(...)` retorna um novo objeto a cada `build()`. O primeiro build assina o `map` #1 no controller. A reconstrução seguinte, que pode ser uma mudança de tema, a abertura do teclado ou um `setState` do pai, cria o `map` #2, o `StreamBuilder` cancela a assinatura do #1 e assina o #2, e o #2 tenta chamar `listen()` no controller pela segunda vez.

O caso C é a forma real de "ele quebra quando volto a esta aba" ou "ele quebra depois que eu volto e abro a página de novo". A stream vive em algum lugar de longa duração (um service, uma variável de nível superior, um widget pai), a tela que hospeda o `StreamBuilder` é descartada e recriada, e o novo `State` chama `listen()` em uma stream que já teve seu único ouvinte. Qualquer coisa que mude a forma da árvore de elementos ao redor do builder causa isso: navegação, alternativas de `IndexedStack` que reconstroem filhos, widgets condicionais ou uma mudança de `Key`.

Para comparação, passar o *mesmo* objeto de stream entre reconstruções, sem remontagem, funciona bem. O `StreamBuilder` vê uma stream idêntica em `didUpdateWidget` e mantém a assinatura existente. Esse caso passou no mesmo arquivo de teste.

## A correção, em ordem de preferência

### 1. Crie streams derivadas uma única vez, não em build()

Se a stream é usada por um só widget, a causa B é todo o problema, e a correção é parar de criar uma nova stream a cada build. Guarde-a no `State`:

```dart
// Flutter 3.44.8, Dart 3.12.2
class PriceLabel extends StatefulWidget {
  const PriceLabel({super.key, required this.ticks});
  final Stream<int> ticks;

  @override
  State<PriceLabel> createState() => _PriceLabelState();
}

class _PriceLabelState extends State<PriceLabel> {
  late Stream<String> _formatted;

  @override
  void initState() {
    super.initState();
    _formatted = widget.ticks.map((cents) => '\$${(cents / 100).toStringAsFixed(2)}');
  }

  @override
  void didUpdateWidget(PriceLabel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.ticks != widget.ticks) {
      _formatted = widget.ticks.map((cents) => '\$${(cents / 100).toStringAsFixed(2)}');
    }
  }

  @override
  Widget build(BuildContext context) => StreamBuilder<String>(
        stream: _formatted,
        builder: (context, snap) => Text(snap.data ?? '...'),
      );
}
```

O override de `didUpdateWidget` importa: se o pai entrega uma origem realmente nova, você quer uma nova stream derivada para ela, e somente nesse caso. É a mesma regra do `FutureBuilder`, e o raciocínio em [inicializar um Future para que o FutureBuilder não o recrie a cada reconstrução](/pt-br/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/) vale aqui um para um. No meu teste, guardar `c.stream.map(...)` em um `final` e passá-lo por uma reconstrução do pai renderizou `42` depois de `c.add(21)`, sem erro.

A mesma disciplina vale fora dos widgets. Se você precisa do primeiro valor e do restante, pegue ambos de uma única assinatura em vez de chamar `first` e depois `listen`:

```dart
// Dart 3.12.2
Future<void> readAll(Stream<int> source) async {
  var isFirst = true;
  await for (final value in source) {
    if (isFirst) {
      print('first: $value');
      isFirst = false;
    }
    print('value: $value');
  }
}
```

### 2. Faça uma factory, não um campo, quando cada ouvinte deve começar do zero

Se cada consumidor deve receber sua própria sequência independente (uma consulta, uma leitura de arquivo, um gerador), não guarde a stream. Guarde uma função que cria uma e chame-a por ouvinte. Uma função `async*` já é essa função:

```dart
// Dart 3.12.2
Stream<int> countdown(int from) async* {
  for (var i = from; i >= 0; i--) {
    yield i;
    await Future<void>.delayed(const Duration(seconds: 1));
  }
}

// Two independent subscriptions, no error:
// countdown(3).listen(print);
// countdown(3).listen(print);
```

Chamar `countdown(3)` duas vezes rodou sem erro e deu a cada chamador `[3, 2, 1, 0]`. Reutilizar um único `final s = countdown(3)` para duas chamadas de `toList()` lançou a exceção. A maioria das APIs de dados do Flutter já funciona assim: um método de repositório como `watchOrders()` que retorna uma nova stream por chamada é seguro de chamar em cada widget que precisa dele, desde que você o chame em `initState` e não em `build()`.

Quando você quer um único objeto que possa ser ouvido repetidamente mas ainda se comporte por ouvinte, o `Stream.multi` oferece exatamente isso. Seu callback roda uma vez por `listen()` com o controller próprio daquele ouvinte:

```dart
// Dart 3.12.2
final Stream<int> config = Stream<int>.multi((controller) {
  controller.add(1);
  controller.close();
});

// await config.toList(); // [1]
// await config.toList(); // [1] again, no StateError
```

### 3. Compartilhe uma origem com asBroadcastStream() ou um controller broadcast

Quando vários widgets precisam observar a *mesma* origem ao vivo (um socket, uma característica BLE, um `Process.stdout`), converta-a para broadcast uma única vez e distribua essa stream convertida:

```dart
// Flutter 3.44.8, Dart 3.12.2
class ConnectionService {
  ConnectionService(Stream<int> socketEvents)
      : events = socketEvents.asBroadcastStream();

  final Stream<int> events;
}
```

Com `final shared = c.stream.asBroadcastStream()`, dois `StreamBuilder`s em `shared` renderizaram `5` depois de `c.add(5)`, e remontar um deles não lançou exceção. Se você é dono do produtor, crie-o como `StreamController<T>.broadcast()` desde o início.

A chamada precisa acontecer **uma única vez**. `widget.stream.asBroadcastStream()` dentro de `build()` é o caso B de novo: cada chamada cria um novo wrapper broadcast que tenta assinar a mesma origem de assinatura única.

## Armadilhas e variantes

**Streams broadcast descartam eventos que ninguém estava ouvindo.** Esse é o preço da correção 3, e aparece como uma tela em branco em vez de uma exceção. Nos meus testes, um ouvinte tardio em `asBroadcastStream()` recebeu apenas `[3]` enquanto o primeiro ouvinte recebeu `[1, 2, 3]`, e um `StreamBuilder` remontado em uma stream broadcast mostrou `null` até o próximo evento, mesmo que `7` tivesse sido emitido antes. Um controller de assinatura única, por outro lado, guardou em buffer o `1` adicionado antes de alguém ouvir. Se um widget precisa do valor atual quando aparece, passe `initialData` ou use uma stream com replay; [reenviar o último valor para assinantes tardios sem rxdart](/pt-br/2026/10/how-to-replay-the-latest-value-to-late-subscribers-of-a-dart-stream-without-rxdart/) constrói uma sobre `Stream.multi`.

**`asBroadcastStream()` mantém a assinatura da origem viva.** Por padrão, quando o último ouvinte broadcast cancela, o wrapper apenas pausa, e o `onCancel` da origem nunca roda. Minha sonda imprimiu `sourceCancelled(default)=false`. Passar `onCancel: (sub) => sub.cancel()` cancela a origem, mas então a origem fica esgotada para sempre: o próximo ouvinte no wrapper recebeu apenas `done`. Para um socket ou sensor que você quer fechar quando a tela sai, assuma o ciclo de vida explicitamente em vez de depender do wrapper.

**Cancelar não é reiniciar.** Algumas correções na internet sugerem cancelar a assinatura antiga antes de ouvir de novo. Isso evita vazamentos, e você deve fazê-lo (veja [cancelar uma StreamSubscription no dispose](/pt-br/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/)), mas não torna uma stream de assinatura única reutilizável. Só uma nova stream faz isso.

**O hot reload mantém a stream quebrada.** O hot reload preserva o `State` e as variáveis de nível superior, então, depois de corrigir o código, uma stream que já foi consumida no app em execução continua consumida. Faça um hot restart, ou pare e execute de novo, antes de decidir que a correção não funcionou.

**Corpos de `http` são de uso único.** `StreamedResponse.stream` só pode ser lido uma vez. Um middleware de log que chama `response.stream.bytesToString()` e depois devolve a mesma resposta ao chamador faz a leitura do chamador lançar este erro. Leia o corpo uma vez para bytes e depois construa um novo `http.Response` a partir deles, se algo adiante precisar dele de novo.

**Bibliotecas de gerenciamento de estado cuidam disso na maior parte.** O `stream` de um `Bloc` e o `StreamProvider` do Riverpod já expõem streams broadcast ou por ouvinte, então o erro geralmente significa que um controller bruto foi passado junto delas. Se você está tirando uma tela de `StreamBuilder`s brutos, [FutureBuilder e StreamBuilder vs AsyncValue do Riverpod](/pt-br/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/) e [Notifier vs AsyncNotifier vs StreamNotifier](/pt-br/2026/08/riverpod-notifier-vs-asyncnotifier-vs-streamnotifier-in-flutter/) explicam qual tipo de provider é dono do ciclo de vida da stream.

**Parecidos: `Bad state: Cannot add new events after calling close`.** Mesmo tipo de `StateError`, lado oposto da stream: o produtor chamou `add` em um controller fechado, geralmente a partir de um timer ou callback que sobreviveu ao `dispose()`. **Parecido: `Bad state: No element`.** Esse vem de `first`, `single` ou `last` em uma stream (ou iterable) que terminou vazia. Nenhum dos dois é resolvido por streams broadcast.

## Veja também

- [How to cancel a StreamSubscription in dispose to avoid a setState-after-dispose crash in Flutter](/pt-br/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/)
- [How to replay the latest value to late subscribers of a Dart stream without rxdart](/pt-br/2026/10/how-to-replay-the-latest-value-to-late-subscribers-of-a-dart-stream-without-rxdart/)
- [How to initialize a Future so FutureBuilder does not recreate it on every rebuild](/pt-br/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/)
- [FutureBuilder and StreamBuilder vs Riverpod AsyncValue in Flutter](/pt-br/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/)
- [Riverpod Notifier vs AsyncNotifier vs StreamNotifier](/pt-br/2026/08/riverpod-notifier-vs-asyncnotifier-vs-streamnotifier-in-flutter/)

## Fontes

- [Asynchronous programming: Streams](https://dart.dev/libraries/async/using-streams) em dart.dev, a seção sobre assinatura única vs broadcast.
- [Creating streams in Dart](https://dart.dev/libraries/async/creating-streams), que cobre `async*`, `StreamController` e quando usar cada um.
- Referência da API de [`Stream.asBroadcastStream`](https://api.dart.dev/stable/dart-async/Stream/asBroadcastStream.html) e [`Stream.multi`](https://api.dart.dev/stable/dart-async/Stream/Stream.multi.html).
- Referência da API de [`StreamBuilder`](https://api.flutter.dev/flutter/widgets/StreamBuilder-class.html) e a implementação de `_StreamBuilderBaseState.didUpdateWidget` em `packages/flutter/lib/src/widgets/async.dart` do Flutter 3.44.8.
