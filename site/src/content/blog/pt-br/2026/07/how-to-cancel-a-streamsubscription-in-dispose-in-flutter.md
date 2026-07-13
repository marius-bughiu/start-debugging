---
title: "Como cancelar um StreamSubscription no dispose para evitar um crash setState-após-dispose no Flutter"
description: "Um stream continua emitindo depois que o usuário sai da tela, seu onData chama setState em um State já destruído, e o Flutter lança uma exceção. Guarde a subscription, cancele-a no dispose antes de super.dispose, e o callback nunca poderá disparar em um widget morto. O padrão completo para Flutter 3.44."
pubDate: 2026-07-13
template: how-to
tags:
  - "flutter"
  - "dart"
  - "async"
lang: "pt-br"
translationOf: "2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-13
---

Quando você chama `stream.listen(...)` dentro de um `State`, você é dono da subscription e precisa cancelá-la no `dispose()`. Se não fizer isso, o stream continua entregando eventos depois que o usuário sai da tela, o callback `onData` executa `setState` em um `State` que já foi destruído, e o Flutter lança `setState() called after dispose()`. A solução são três linhas: guarde o `StreamSubscription` em um campo, crie-o no `initState`, e chame `_sub.cancel()` no `dispose()` antes de `super.dispose()`. Cancelar interrompe a entrega, então o callback nunca chega a rodar em um widget morto. Este guia usa Flutter 3.44 (versão estável atual, 2026) e Dart 3.x.

A distinção que importa: cancelar é a solução real, e uma verificação `mounted` é apenas um remendo sobre o sintoma. Um `StreamSubscription` é um cano vivo entre uma fonte que sobrevive ao seu widget (um `StreamController`, um listener de snapshots do Firestore, um WebSocket, um sensor, `connectivity_plus`) e um callback que captura `this`. Enquanto esse cano estiver aberto, seu `State` é acessível e seu `onData` roda a cada evento, destruído ou não. Fechar o cano é o ponto em que o vazamento de memória e o crash desaparecem ao mesmo tempo.

## Por que o callback sobrevive ao widget

O ciclo de vida do widget do Flutter e o ciclo de vida de um stream são completamente independentes. O framework destrói seu `State` quando o elemento dele sai da árvore: o usuário faz pop da rota, um pai reconstrói você para fora da existência, uma aba muda. Nada disso toca no stream. O `StreamController` na outra ponta não faz ideia de que um widget estava escutando, muito menos de que o widget se foi. Ele continua produzindo eventos, e o Dart continua despachando-os para cada subscription registrada, incluindo a sua.

```dart
// Flutter 3.44, Dart 3.x -- the crash waiting to happen
class _PriceTickerState extends State<PriceTicker> {
  double _price = 0;

  @override
  void initState() {
    super.initState();
    priceStream.listen((value) {   // subscription is never stored
      setState(() => _price = value); // runs even after dispose()
    });
  }
}
```

Esse código passa em todo teste rápido, porque em um teste rápido você não sai da tela enquanto um evento está em trânsito. Empurre uma nova rota enquanto `priceStream` ainda emite uma vez por segundo, e o próximo tick aterrissa no `onData`, que chama `setState` em um `State` defunto. Em debug você recebe um `FlutterError`: `setState() called after dispose(): _PriceTickerState#4f2a1(lifecycle state: defunct, not mounted)`. A subscription retornada por `listen` foi jogada fora, então não há handle para cancelar nem nada que interrompa o evento. O `State` também não pode ser coletado pelo garbage collector, porque a lista interna de subscriptions do stream ainda referencia o closure que o capturou. Esse é o mesmo bug de posse por trás de [como destruir controllers para evitar vazamentos de memória](/pt-br/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/): um recurso que você criou e nunca liberou.

## O padrão, passo a passo

### Passo 1: Guarde a subscription em um campo

`listen` retorna um `StreamSubscription<T>`. Guarde-o. Esse handle é a única forma de cancelar depois.

```dart
// Flutter 3.44, Dart 3.x
import 'dart:async';

class _PriceTickerState extends State<PriceTicker> {
  StreamSubscription<double>? _sub;
  double _price = 0;
  // ...
}
```

Use um campo anulável (`StreamSubscription<double>?`) quando a subscription é criada de forma condicional, para que `dispose` possa chamar `_sub?.cancel()` com segurança. Se você sempre se inscreve exatamente uma vez no `initState`, um `late final StreamSubscription<double> _sub;` é mais limpo porque documenta que o campo é sempre atribuído e permite cancelar sem condições.

### Passo 2: Inscreva-se no initState, não no build

Crie a subscription no `initState` (ou no `didChangeDependencies` se o stream vier de um inherited widget), nunca no `build`. `build` roda a cada frame, então inscrever-se ali empilha um novo listener a cada reconstrução, e cada um dispara `setState`, que agenda outra reconstrução. Esse loop de realimentação é uma classe de bug diferente da deste post, e aparece como [setState() or markNeedsBuild() called during build](/pt-br/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/).

```dart
// Flutter 3.44, Dart 3.x
@override
void initState() {
  super.initState();
  _sub = priceStream.listen(
    (value) => setState(() => _price = value),
    onError: (Object e, StackTrace s) => setState(() => _price = -1),
  );
}
```

### Passo 3: Cancele no dispose, antes de super.dispose

Esta é a linha que de fato conserta o crash.

```dart
// Flutter 3.44, Dart 3.x
@override
void dispose() {
  _sub?.cancel();
  super.dispose();
}
```

A ordem importa da mesma forma que para os controllers: libere seus próprios recursos primeiro, depois passe o controle para o framework com `super.dispose()`. Depois que `cancel()` retorna, a subscription está morta. Ela não entregará nenhum callback `onData`, `onError` ou `onDone` posterior, mesmo para eventos que a fonte já tenha produzido mas ainda não tenha despachado. Essa é a garantia que você compra: o closure que chama `setState` não pode mais rodar, então o `State` destruído fica intocável.

## Por que você não aguarda cancel no dispose

`StreamSubscription.cancel()` retorna um `Future<void>`, e `dispose()` retorna `void`, então você não pode usar `await` nele. Isso confunde as pessoas, mas não é um problema. O future completa quando o callback `onCancel` do stream termina qualquer limpeza que ele precise (fechar um socket, liberar um file handle). A entrega ao seu callback para imediatamente, independentemente de quando esse future resolva. Para o propósito de não chamar `setState` em um widget morto, o `cancel()` sem await é plenamente eficaz no momento em que é chamado.

O future só importa se você especificamente precisa saber quando a fonte terminou de limpar, o que é raro dentro de um widget. Se você mesmo é dono do `StreamController` e quer garantir que o `onCancel` dele rodou antes de prosseguir, faça essa limpeza fora do `dispose`, onde você pode aguardá-la com await.

## Múltiplas subscriptions em um widget

Uma tela frequentemente escuta vários streams: conectividade, um feed de dados, um stream de visibilidade do teclado. Cancele cada um. Duas abordagens limpas.

Campos separados quando as subscriptions são de tipos diferentes e você as referencia individualmente:

```dart
// Flutter 3.44, Dart 3.x
StreamSubscription<ConnectivityResult>? _connSub;
StreamSubscription<Order>? _orderSub;

@override
void dispose() {
  _connSub?.cancel();
  _orderSub?.cancel();
  super.dispose();
}
```

Uma lista quando você só precisa desmontá-las todas juntas:

```dart
// Flutter 3.44, Dart 3.x
final _subs = <StreamSubscription<dynamic>>[];

@override
void initState() {
  super.initState();
  _subs.add(connectivity.onConnectivityChanged.listen(_onConn));
  _subs.add(orders.stream.listen(_onOrder));
}

@override
void dispose() {
  for (final s in _subs) {
    s.cancel();
  }
  super.dispose();
}
```

A lista escala sem que você precise lembrar de adicionar uma linha `cancel` correspondente para cada campo novo, que é exatamente o tipo de omissão que reintroduz o crash meses depois.

## Reinscrever-se sem vazar a subscription antiga

Se o stream que você escuta depende de uma propriedade do widget ou de um valor herdado, a fonte pode mudar enquanto o widget continua montado. Trate isso no `didUpdateWidget` ou no `didChangeDependencies`, e cancele a subscription anterior antes de abrir uma nova. Pular o cancel vaza a antiga e mantém o `setState` dela vivo no mesmo `State`.

```dart
// Flutter 3.44, Dart 3.x
@override
void didUpdateWidget(PriceTicker old) {
  super.didUpdateWidget(old);
  if (old.symbol != widget.symbol) {
    _sub?.cancel();                       // drop the old stream
    _sub = priceStreamFor(widget.symbol)  // subscribe to the new one
        .listen((v) => setState(() => _price = v));
  }
}
```

## Quando você é dono do StreamController, feche-o também

Cancelar uma subscription e fechar um controller são responsabilidades diferentes. Cancele sua subscription quando você é apenas consumidor do stream de outra pessoa. Se seu widget também criou o `StreamController` que dá suporte ao stream, feche o controller no `dispose` também, caso contrário o controller e o buffer dele vazam.

```dart
// Flutter 3.44, Dart 3.x
final _controller = StreamController<String>();
StreamSubscription<String>? _sub;

@override
void initState() {
  super.initState();
  _sub = _controller.stream.listen((msg) => setState(() => _last = msg));
}

@override
void dispose() {
  _sub?.cancel();       // stop consuming
  _controller.close();  // release the source you own
  super.dispose();
}
```

Um controller de subscription única não deixará um segundo listener se conectar, então se você também expõe esse stream em outro lugar, crie-o com `StreamController.broadcast()`, e lembre-se de que cada listener em um stream do tipo broadcast precisa do próprio `cancel`.

## Por que StreamBuilder é frequentemente a melhor resposta

Se a única coisa que sua subscription faz é alimentar um valor para a interface, você provavelmente não precisa gerenciar uma subscription de forma alguma. `StreamBuilder` se inscreve quando é inserido, reconstrói a cada evento através do `builder` dele, e cancela automaticamente quando é removido da árvore. Não há `setState`, nem campo, nem contabilidade no `dispose`, e portanto nenhuma forma de deixar uma subscription rodando após a destruição.

```dart
// Flutter 3.44, Dart 3.x
StreamBuilder<double>(
  stream: priceStream,
  builder: (context, snap) => Text('${snap.data ?? 0}'),
)
```

Recorra a um `listen` manual mais `setState` só quando o evento faz algo além de renderizar: navegar em um evento de conclusão, mostrar um `SnackBar`, escrever em outro controller, disparar um efeito colateral. Esses são exatamente os casos em que um callback obsoleto é perigoso, e exatamente onde cancelar no `dispose` não é negociável. O mesmo trade-off entre gerenciamento manual e automático aparece com o `TextEditingController`, e é por isso que [um controller usado após ser destruído](/pt-br/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/) lança o erro análogo.

## pause não é cancel, e mounted não é um substituto

Dois atalhos parecem resolver isso e não resolvem.

`StreamSubscription.pause()` interrompe a entrega temporariamente, mas uma subscription pausada continua registrada e continua retendo seu `State`. Pausar no `dispose` vaza; você precisa usar `cancel`.

Um `if (!mounted) return;` no início do `onData` evita a chamada de `setState`, mas não interrompe o stream. A subscription continua viva, continua despachando eventos, e continua mantendo seu `State` acessível. O crash fica mascarado enquanto o vazamento continua. Use a verificação `mounted` só para o caso para o qual ela foi projetada, um `await` dentro do callback que retoma depois que o widget se foi, e cubra isso a fundo aprendendo a [proteger setState com a verificação mounted após um intervalo async](/pt-br/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/). Para o caso simples de "o stream continua emitindo", cancel é a solução correta e completa.

Se seu `onData` for ele mesmo assíncrono, você pode atingir os dois problemas de uma vez: a subscription entrega um evento, você usa `await` dentro do handler, e o widget é destruído durante o await. Cancel trata da entrega; a verificação `mounted` trata da retomada após o await. Aí o cinto e suspensórios se justificam.

## A versão de arquivo único para copiar

```dart
// Flutter 3.44, Dart 3.x
import 'dart:async';
import 'package:flutter/material.dart';

class PriceTicker extends StatefulWidget {
  const PriceTicker({super.key, required this.stream});
  final Stream<double> stream;

  @override
  State<PriceTicker> createState() => _PriceTickerState();
}

class _PriceTickerState extends State<PriceTicker> {
  StreamSubscription<double>? _sub;
  double _price = 0;

  @override
  void initState() {
    super.initState();
    _sub = widget.stream.listen(
      (value) => setState(() => _price = value),
      onError: (Object e, StackTrace s) => setState(() => _price = -1),
    );
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Text(_price.toStringAsFixed(2));
}
```

Guarde a subscription, cancele-a antes de `super.dispose()`, e o crash `setState()-após-dispose()` se torna estruturalmente impossível em vez de evitado por probabilidade. Estado em streaming que vem da rede merece o mesmo cuidado no caminho de erro, algo que vale a pena combinar com uma olhada em como [tratar erros de rede com elegância em um app Flutter](/pt-br/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) para que um stream com falha mostre um estado sobre o qual o usuário possa agir em vez de um spinner que nunca resolve.

## Fontes

- [StreamSubscription.cancel API](https://api.flutter.dev/flutter/dart-async/StreamSubscription/cancel.html) - o contrato do cancel e seu retorno `Future<void>`.
- [State.dispose API](https://api.flutter.dev/flutter/widgets/State/dispose.html) - "subclasses should override this method to release any resources retained by this object (e.g., stop any active animations)".
- [StreamBuilder class](https://api.flutter.dev/flutter/widgets/StreamBuilder-class.html) - inscrição e cancelamento automáticos ligados ao ciclo de vida do widget.
- [Dart streams tutorial](https://dart.dev/libraries/async/using-streams) - streams de subscription única versus broadcast e gerenciamento de listeners.
