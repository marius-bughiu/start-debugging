---
title: "Como proteger o setState com a verificação mounted após um intervalo assíncrono no Flutter"
description: "Depois de um await, o widget pode já estar descartado, e chamar setState lança uma exceção. Proteja a retomada com if (!mounted) return; e, melhor ainda, cancele o trabalho que o dispara. O padrão completo para o Flutter 3.44."
pubDate: 2026-07-13
template: how-to
tags:
  - "flutter"
  - "dart"
  - "async"
lang: "pt-br"
translationOf: "2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-13
---

A regra cabe em uma linha: dentro de um `State`, nunca chame `setState` após um `await` sem antes verificar `if (!mounted) return;`. Um `await` devolve o controle ao loop de eventos, o usuário pode fechar a tela enquanto seu trabalho assíncrono roda, e quando seu código retoma o widget pode já estar descartado. Chamar `setState` em um `State` descartado lança `setState() called after dispose()`. O getter `mounted` diz se o `State` ainda está na árvore, então proteger a retomada com ele torna a falha impossível. Melhor ainda: cancele o timer, a assinatura ou a requisição que chamaria `setState`, para que o callback nunca rode em um widget morto. Este guia usa Flutter 3.44 (estável atual, 2026) e Dart 3.x.

`mounted` é um getter de `State<T>`. É `true` a partir do momento em que o framework conecta seu `State` ao seu `BuildContext`, antes de `initState` rodar, e continua `true` até `dispose` ser chamado, após o que é `false` para sempre. Por baixo dos panos não passa de uma verificação de null sobre a referência ao elemento: `bool get mounted => _element != null;`. Esse é todo o mecanismo. Quando o elemento que sustenta seu widget é arrancado da árvore, `_element` vira null, `mounted` muda para `false`, e qualquer `setState` que você tente a partir daí é um erro que o framework rejeita ativamente.

## Por que um await é onde isso quebra

O Flutter conduz tudo a partir de uma única thread de UI. Enquanto seu manipulador de eventos roda de forma síncrona, o widget que você está olhando não pode sumir no meio do método: nada mais ganha a vez. No instante em que você escreve `await`, essa garantia se vai. O controle volta ao loop de eventos, outros frames são renderizados, callbacks de gestos rodam, transições de rota se completam. Sua continuação fica agendada para alguma microtarefa posterior, e entre "antes do await" e "depois do await" o usuário poderia ter tocado voltar, um pai poderia ter reconstruído você para fora da existência, ou um `Navigator.pop` em outro lugar poderia ter descartado sua rota.

```dart
// Flutter 3.44, Dart 3.x -- the crash waiting to happen
class _ProfileState extends State<Profile> {
  bool _loading = false;
  User? _user;

  Future<void> _load() async {
    setState(() => _loading = true);      // fine: still on the same frame
    final user = await api.fetchUser();    // control leaves; frames run
    setState(() {                          // may run after dispose()
      _user = user;
      _loading = false;
    });
  }
}
```

Nada em `_load` parece errado, e funciona toda vez que você testa em uma tela que não abandona. Navegue para fora enquanto `fetchUser` está em voo, porém, e o segundo `setState` pousa em um `State` descartado. Em depuração você recebe um `FlutterError`: `setState() called after dispose(): _ProfileState#1a2b3(lifecycle state: defunct, not mounted)`. Este é o mesmo erro estrutural descrito pelo lado do contexto em [usar o BuildContext com segurança após um await](/pt-br/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/), mas aqui a vítima é a mutação de estado, não uma busca de widget herdado.

## A proteção mínima, passo a passo

Siga estes três passos para qualquer método assíncrono em um `State` que chame `setState` depois de suspender.

1. **Faça o trabalho assíncrono.** Deixe o `await` levar o tempo que precisar. Você ainda não está segurando nada frágil através dele; `mounted` é um getter vivo, não um valor que você armazenou em cache.
2. **Proteja a retomada.** Imediatamente após o `await`, antes de qualquer `setState`, escreva `if (!mounted) return;`. Se o widget deixou a árvore durante o await, você para aqui e nunca toca no `State` descartado.
3. **Chame setState só depois da guarda.** Tudo que muta o estado e reconstrói o widget vai depois da verificação, no mesmo tick síncrono, de modo que nada possa descartar você entre a guarda e a chamada.

Aplicado ao exemplo quebrado:

```dart
// Flutter 3.44, Dart 3.x -- guarded
Future<void> _load() async {
  setState(() => _loading = true);
  final user = await api.fetchUser();   // 1. async work

  if (!mounted) return;                 // 2. guard the resume

  setState(() {                         // 3. safe: State is still mounted
    _user = user;
    _loading = false;
  });
}
```

Essa é a correção inteira para o caso comum. `mounted` é `false` no momento em que `dispose` rodou, então a guarda pula o `setState` exatamente quando ele teria lançado a exceção. Note que a guarda lê `mounted` fresco depois do await; uma verificação colocada *antes* do await não diz nada, porque o intervalo que importa é o próprio await.

## Por que verificar mounted é o piso, não o teto

O framework do Flutter é direto sobre isso no próprio texto do erro de `setState`. Sua correção recomendada não é apenas verificar `mounted`, é cancelar o trabalho que chamaria `setState` em primeiro lugar. O raciocínio: uma guarda `mounted` evita a exceção, mas o trabalho assíncrono ainda rodou até o fim e queimou CPU, rede e bateria produzindo um resultado que você então descarta. Se um `Timer` dispara a cada segundo em uma tela que o usuário deixou dez minutos atrás, proteger cada tick com `mounted` para a falha mas deixa o timer rodando para sempre.

Então trate `if (!mounted) return;` como a última linha de defesa, e cancele a fonte em `dispose` como a correção de verdade onde quer que a fonte seja cancelável.

```dart
// Flutter 3.44, Dart 3.x -- cancel the source, then guard as backup
class _ClockState extends State<Clock> {
  Timer? _timer;
  DateTime _now = DateTime.now();

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;             // backstop
      setState(() => _now = DateTime.now());
    });
  }

  @override
  void dispose() {
    _timer?.cancel();                   // the real fix: stop the source
    super.dispose();
  }
}
```

Com o `cancel()` em `dispose`, o callback para de disparar no momento em que o widget vai embora, então a guarda `mounted` quase nunca é acionada. Manter a guarda mesmo assim não custa nada e cobre a corrida estreita em que um tick já está enfileirado quando `dispose` roda. Esta é a mesma disciplina que você aplica quando [descarta controllers para evitar vazamentos de memória](/pt-br/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/): assumir o ciclo de vida de qualquer coisa que possa chamar de volta seu widget.

## Assinaturas de Stream são o infrator clássico

Uma `StreamSubscription` cujo `onData` chame `setState` continuará entregando eventos depois que o widget se foi, a menos que você a cancele. Guarde a assinatura e cancele-a em `dispose`.

```dart
// Flutter 3.44, Dart 3.x
class _FeedState extends State<Feed> {
  StreamSubscription<Item>? _sub;
  final _items = <Item>[];

  @override
  void initState() {
    super.initState();
    _sub = repository.itemStream.listen((item) {
      if (!mounted) return;
      setState(() => _items.add(item));
    });
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }
}
```

Esquecer o `cancel()` aqui é uma das formas mais comuns de ver `setState() called after dispose()` nos logs de produção: o stream sobrevive ao widget, e cada evento que chega após o descarte é uma falha que a guarda `mounted` está absorvendo em silêncio. Cancele a assinatura e os eventos param na fonte. Cancelar em `dispose` cada listener que você abre vale a pena tornar tão automático quanto o [descarte de controllers que previne vazamentos](/pt-br/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).

## mounted em State versus mounted em BuildContext

Há dois getters `mounted`, e escolher o certo importa. `State.mounted` é sobre o que este guia inteiro trata: vive na sua classe de estado, segue o ciclo de vida do widget que você possui, e é o que você verifica antes de `setState`. Existe desde as primeiras versões do Flutter.

`BuildContext.mounted` chegou no Flutter 3.7 para código que só tem um contexto, não um `State`: funções auxiliares, callbacks de `StatelessWidget`, métodos de extensão. Responde à mesma pergunta "este elemento ainda está na árvore?", mas você recorre a ele quando não há um `State` em escopo.

```dart
// Flutter 3.44, Dart 3.x
// Inside a State subclass, before setState:
if (!mounted) return;          // State.mounted

// In a helper that only has a BuildContext:
if (!context.mounted) return;  // BuildContext.mounted
```

Dentro de um `State`, prefira `mounted` em vez de `context.mounted`. Geralmente eles concordam, mas `State.mounted` lê o ciclo de vida do objeto exato no qual você está prestes a chamar `setState`, que é precisamente a coisa que pode estar defunta. Reserve `context.mounted` para as situações cobertas em [usar o BuildContext com segurança após um await](/pt-br/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/), onde a carga é uma busca de `Navigator` ou `ScaffoldMessenger` em vez de uma mutação de estado.

## Vários awaits significam várias guardas

Cada ponto de suspensão reabre a janela. Se um método faz await duas vezes e chama `setState` depois de cada um, ele precisa de uma guarda após cada await, não só após o primeiro.

```dart
// Flutter 3.44, Dart 3.x
Future<void> _submit() async {
  setState(() => _status = 'validating');
  final valid = await validate(form);
  if (!mounted) return;                 // guard after await #1

  setState(() => _status = valid ? 'saving' : 'invalid');
  if (!valid) return;

  await repository.save(form);
  if (!mounted) return;                 // guard after await #2

  setState(() => _status = 'done');
}
```

Uma guarda cobre só os awaits que a precedem. Adicione um novo `await` entre uma guarda existente e um `setState`, e você reabriu o intervalo em silêncio. Quando um método brota mais de duas dessas guardas, isso costuma ser um sinal de que o trabalho assíncrono pertence a um controller, um `AsyncNotifier` ou um stream que seu widget renderiza de forma declarativa, em vez de a uma pilha de chamadas `setState` imperativas. Modelá-lo como [estados de carregamento e erro com AsyncValue](/pt-br/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) entrega ao framework a contabilidade do ciclo de vida e remove a maioria das guardas manuais por completo.

## O linter não pega esta

Vale a pena ser claro sobre o que a ferramenta faz e não faz aqui. O linter `use_build_context_synchronously` do `flutter_lints` sinaliza um `BuildContext` usado após um intervalo assíncrono sem uma guarda. Ele **não** sinaliza um `setState` cru após um await, porque `setState` não recebe um contexto e o linter não está procurando por ele. Não há regra de análise que sublinhe o `setState` desprotegido do primeiro exemplo deste post. Isso torna o hábito inteiramente seu para manter: o compilador está quieto, o analisador está quieto, e o único sinal é uma falha em um log depois que um usuário navegou para fora na hora errada.

A consequência prática é que você não pode se apoiar em um rabisco vermelho para encontrá-los. Audite qualquer método de `State` que ao mesmo tempo faça `await` e chame `setState`, e torne a guarda um reflexo do mesmo jeito que você já trata `super.dispose()`.

## Armadilhas e sósias

**Esta é uma falha diferente de setState durante o build.** A falha `setState() called after dispose()` e a falha `setState() or markNeedsBuild() called during build` não têm relação apesar do texto parecido. A de dispose é sobre chamar `setState` tarde demais, depois que o widget se foi; a de build é sobre chamá-lo cedo demais, de forma síncrona dentro de uma passada de build. As correções são diferentes, e a [guarda de setState chamado durante o build](/pt-br/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) cobre a segunda. Se seu stack trace diz "during build", a verificação `mounted` não é sua correção.

**Builds de release ainda quebram, só que mais tarde.** O erro `setState() called after dispose()` é um `FlutterError` realmente lançado, não uma asserção só de depuração, então, ao contrário das buscas de contexto descartado, ele de fato aparece em release. Mas como dispara de um callback assíncrono, o stack trace muitas vezes aponta para código do framework longe do seu método `_load`, o que facilita atribuí-lo errado. Uma falha que só aparece após a navegação, de dentro de um `Future.then` ou um manipulador de stream, é quase sempre um `setState` pós-await sem proteção.

**`FutureBuilder` e `StreamBuilder` contornam a guarda.** Se você entregar o trabalho assíncrono a um `FutureBuilder` ou um `StreamBuilder` em vez de chamar `setState` na mão, o builder segue o ciclo de vida do widget por você e nunca chama `setState` em um `State` morto. Recorrer a [FutureBuilder ou StreamBuilder em vez de setState manual](/pt-br/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/) remove uma categoria inteira dessas falhas, ao custo de reestruturar o fluxo assíncrono em torno do builder.

**O equivalente no Riverpod.** Se você segura um `WidgetRef` ou o `Ref` de um notifier em vez de um `State`, a falha correspondente é um erro de ref descartado em vez de um erro de `State` descartado, e a guarda é `ref.mounted` em vez de `mounted`. A mesma causa raiz, o mesmo formato de correção, coberto em [verificar Ref.mounted após um intervalo assíncrono no Riverpod 3.0](/pt-br/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/).

## O hábito que aposenta a falha

Leia um `State` como válido só do início de uma corrida síncrona até o próximo `await`. Depois de retomar, verifique `mounted` antes de chamar `setState`. E onde quer que a coisa que dispara `setState` seja um timer, uma assinatura ou qualquer fonte de vida longa, cancele-a em `dispose` para que o callback nunca dispare em um widget que já se foi. Faça isso mecanicamente e `setState() called after dispose()` para de aparecer nos seus logs, porque você removeu tanto a falha quanto o trabalho desperdiçado por trás dela.

## Fontes

- [Propriedade State.mounted](https://api.flutter.dev/flutter/widgets/State/mounted.html), documentação da API do Flutter, sobre quando `mounted` é true e false ao longo do ciclo de vida do `State`.
- [Método State.setState](https://api.flutter.dev/flutter/widgets/State/setState.html), documentação da API do Flutter, que detalha o erro `setState() called after dispose()` e recomenda cancelar a fonte em vez de apenas verificar `mounted`.
- [Método State.dispose](https://api.flutter.dev/flutter/widgets/State/dispose.html), documentação da API do Flutter, sobre liberar timers e assinaturas quando o widget deixa a árvore.
- [Regra do linter use_build_context_synchronously](https://dart.dev/tools/linter-rules/use_build_context_synchronously), regras do linter do Dart, sobre o que o analisador sinaliza e o que não.
