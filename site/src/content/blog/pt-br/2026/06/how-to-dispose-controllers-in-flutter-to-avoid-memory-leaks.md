---
title: "Como liberar controllers no Flutter para evitar vazamentos de memória"
description: "AnimationController, TextEditingController e ScrollController retêm recursos que o GC do Dart não consegue reclamar até você liberá-los. Aqui está o padrão correto, as regras de ordem e como detectar vazamentos antes de publicar."
pubDate: 2026-06-01
template: how-to
tags:
  - "flutter"
  - "dart"
  - "memory"
lang: "pt-br"
translationOf: "2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks"
translatedBy: "claude"
translationDate: 2026-06-01
---

Se um controller expõe um método `dispose()`, você precisa chamá-lo a partir do seu `State.dispose()`, e precisa fazê-lo antes de `super.dispose()`. Em concreto: crie o controller em `initState` (ou como um campo `late final`), chame `controller.dispose()` em `dispose()`, e para `AnimationController` adicione um `SingleTickerProviderStateMixin` para que o ticker pare quando o widget sair da árvore. Pular qualquer um desses passos deixa vivo e acessível um `Ticker`, uma lista de listeners ou uma assinatura de stream, o que prende toda a subárvore de widgets na memória. Este guia usa Flutter 3.44 (estável, maio de 2026) e Dart 3.x.

A coleta de lixo não te salva aqui. O GC do Dart reclama objetos que não são mais acessíveis, mas um `AnimationController` em execução é acessível a partir da lista de tickers do `SchedulerBinding`, e um `TextEditingController` que você entregou a um `TextField` é acessível a partir do grafo de listeners enquanto algo retiver o controller. O vazamento não é um bug do GC. É um bug de propriedade: você criou um recurso e nunca o liberou.

## Por que um controller sobrevive ao seu widget

Um `StatefulWidget` é barato e descartável. O Flutter reconstrói o objeto widget constantemente. O objeto `State` é o que tem um ciclo de vida, e os controllers que você cria pertencem a esse `State`. Quando o widget é removido da árvore, o Flutter chama `State.dispose()` exatamente uma vez. Essa chamada é a sua única chance de liberar recursos nativos e do framework.

Três categorias de controller vazam de maneiras distintas:

`AnimationController` registra um `Ticker` no `SchedulerBinding`. O ticker dispara uma callback em cada frame enquanto a animação está em execução. Até você liberar o controller (o que libera o ticker), o `SchedulerBinding` retém uma referência ao ticker, o ticker retém uma referência à sua callback, e sua callback captura `this`, seu `State`, e através dele toda a subárvore. Em builds de depuração o Flutter de fato lança uma asserção sobre isso: se você esquecer o `dispose`, recebe `AnimationController.dispose() called more than once` ou uma asserção de ticker ainda ativo quando o widget é destruído.

`TextEditingController`, `ScrollController` e `FocusNode` são `ChangeNotifier` (ou contêm um). Eles mantêm uma lista de listeners. Um `TextField` se adiciona como listener para poder repintar quando o texto muda. Se você também chama `controller.addListener(...)` e nunca libera, o controller, sua lista de listeners e cada closure nessa lista continuam vivos. O controller retém os listeners, não o contrário, então o GC não consegue coletar nenhum deles.

`StreamSubscription` e `Timer` têm o mesmo formato sem o nome `dispose()`: você chama `subscription.cancel()` e `timer.cancel()`. Uma assinatura viva é referenciada pelo stream, que mantém viva sua callback `onData`.

A regra unificadora, direto da [documentação da API State.dispose](https://api.flutter.dev/flutter/widgets/State/dispose.html) da equipe do Flutter: "Se o método build de um State depende de um objeto que pode mudar de estado por si mesmo, ... assine esse objeto durante initState ... e cancele a assinatura em dispose".

## Um repro mínimo que vaza

Aqui está um widget que vaza os três tipos de recurso. Ele compila e executa. Simplesmente nunca solta nada.

```dart
// Flutter 3.44, Dart 3.x -- DO NOT COPY, this leaks on purpose.
import 'dart:async';
import 'package:flutter/material.dart';

class LeakyScreen extends StatefulWidget {
  const LeakyScreen({super.key});

  @override
  State<LeakyScreen> createState() => _LeakyScreenState();
}

class _LeakyScreenState extends State<LeakyScreen>
    with SingleTickerProviderStateMixin {
  late final AnimationController _anim =
      AnimationController(vsync: this, duration: const Duration(seconds: 1))
        ..repeat();
  final TextEditingController _text = TextEditingController();
  final ScrollController _scroll = ScrollController();
  late final StreamSubscription<int> _ticks =
      Stream.periodic(const Duration(seconds: 1), (i) => i).listen((_) {});

  // No dispose() override. Every push/pop of this screen leaks
  // one AnimationController, one ticker, one TextEditingController,
  // one ScrollController, and one live StreamSubscription.

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: ListView(
        controller: _scroll,
        children: [
          TextField(controller: _text),
          RotationTransition(turns: _anim, child: const FlutterLogo()),
        ],
      ),
    );
  }
}
```

Empurre e remova essa tela 50 vezes e você terá 50 tickers disparando em cada frame, 50 assinaturas de stream entregando eventos e 50 subárvores de widgets desconectadas que o GC nunca tocará. Só os tickers de animação vão degradar visivelmente os tempos de frame, porque cada um deles ainda quer executar em cada vsync.

## O padrão de liberação, completo

A correção é mecânica assim que você a internaliza. Espelhe cada recurso que você cria com uma chamada de liberação em `dispose()`, e coloque `super.dispose()` por último.

```dart
// Flutter 3.44, Dart 3.x
import 'dart:async';
import 'package:flutter/material.dart';

class StableScreen extends StatefulWidget {
  const StableScreen({super.key});

  @override
  State<StableScreen> createState() => _StableScreenState();
}

class _StableScreenState extends State<StableScreen>
    with SingleTickerProviderStateMixin {
  late final AnimationController _anim;
  late final TextEditingController _text;
  late final ScrollController _scroll;
  late final FocusNode _focus;
  StreamSubscription<int>? _ticks;

  @override
  void initState() {
    super.initState();
    _anim = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 1),
    )..repeat();
    _text = TextEditingController();
    _scroll = ScrollController()..addListener(_onScroll);
    _focus = FocusNode();
    _ticks = Stream.periodic(const Duration(seconds: 1), (i) => i)
        .listen(_onTick);
  }

  void _onScroll() {/* react to scroll offset */}
  void _onTick(int value) {/* react to each tick */}

  @override
  void dispose() {
    // Cancel subscriptions and remove listeners first.
    _ticks?.cancel();
    _scroll.removeListener(_onScroll);
    // Then dispose every controller you own.
    _anim.dispose();
    _text.dispose();
    _scroll.dispose();
    _focus.dispose();
    // super.dispose() LAST, always.
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: ListView(
        controller: _scroll,
        children: [
          TextField(controller: _text, focusNode: _focus),
          RotationTransition(turns: _anim, child: const FlutterLogo()),
        ],
      ),
    );
  }
}
```

Algumas coisas nesse código são fundamentais, então vale a pena ser explícito sobre cada uma.

### Crie em initState, não em build

`build` executa muitas vezes. Se você escreve `final _text = TextEditingController()` como inicializador de campo com um valor não `late`, está tudo bem porque inicializadores de campo executam uma única vez. Mas se você algum dia construir um controller dentro de `build`, aloca um novo a cada reconstrução e deixa o anterior órfão imediatamente. Construa controllers em `initState` ou como campos `late final`, nunca em `build`.

### Por que super.dispose() vem por último

A convenção é a inversa de `initState`. Em `initState` você chama `super.initState()` primeiro, depois configura seu estado. Em `dispose` você desmonta seu estado primeiro, depois chama `super.dispose()` por último. O `State.dispose()` base marca o objeto como extinto; tocar seus próprios campos depois disso é um bug, e o build de depuração do framework vai sinalizar um `dispose` chamado em um `State` já liberado. Desmontar seus recursos antes de devolver o controle à classe base mantém a ordem coerente.

### removeListener antes de dispose, ou apenas dispose

Se você chamou `addListener` em um controller, pode chamar `removeListener` com a mesma callback antes de `dispose`, ou confiar que `dispose()` descarte toda a lista de listeners. Liberar um `ChangeNotifier` limpa seus listeners, então um `removeListener` explícito logo antes de `dispose` do mesmo objeto é redundante. A razão para manter o `removeListener` explícito é quando você se adicionou como listener a um controller que não possui (um passado de um pai). Você precisa remover seu listener desse controller em `dispose`, porque não é você quem o libera.

## AnimationController precisa de um TickerProvider

`AnimationController` é o único controller que precisa de mais do que uma chamada a `dispose`: ele precisa de um argumento `vsync`, que é um `TickerProvider`. O `TickerProvider` é o que vincula o ticker do controller à taxa de atualização da tela e, crucialmente, ao ciclo de vida do widget.

Use `SingleTickerProviderStateMixin` quando o `State` possui exatamente um `AnimationController`. Use `TickerProviderStateMixin` quando possui vários. O mixin de ticker único é uma pequena otimização e lança uma asserção se você acidentalmente criar dois controllers contra ele, o que é uma proteção útil.

```dart
// Flutter 3.44 -- one controller
class _OneAnim extends State<OneAnim>
    with SingleTickerProviderStateMixin {
  late final _c = AnimationController(vsync: this, duration: ...);
  @override
  void dispose() { _c.dispose(); super.dispose(); }
}

// Flutter 3.44 -- multiple controllers
class _ManyAnim extends State<ManyAnim>
    with TickerProviderStateMixin {
  late final _a = AnimationController(vsync: this, duration: ...);
  late final _b = AnimationController(vsync: this, duration: ...);
  @override
  void dispose() { _a.dispose(); _b.dispose(); super.dispose(); }
}
```

Se sua animação é simples, a forma mais limpa de nunca vazar um controller é não possuir nenhum. Os widgets de animação implícita como `AnimatedContainer`, `AnimatedOpacity` e `TweenAnimationBuilder` gerenciam seus próprios controllers internamente e os liberam por você. Recorra a um `AnimationController` explícito apenas quando você precisa conduzir, reverter, repetir ou encadear a animação você mesmo. Perfilar o jank de animação é uma habilidade à parte: se suas animações são fluidas mas o app ainda engasga, a causa costuma ser trabalho na thread de UI, o que eu cubro em [o guia sobre perfilar jank em um app Flutter com DevTools](/pt-br/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/).

## Quem possui o controller decide quem o libera

O vazamento mais comum do mundo real (e o crash por dupla liberação mais comum) vem de propriedade pouco clara. A regra: quem cria o controller o libera. Se um controller é criado no widget A e passado ao widget B, então A o libera, e B não deve.

Isso importa porque os widgets do Flutter frequentemente aceitam um controller como parâmetro de construtor precisamente para que um pai possa controlá-los. `TextField`, `ListView`, `PageView` e `TabBar` todos recebem um controller opcional. Quando você passa um, mantém a responsabilidade de liberá-lo:

```dart
// Flutter 3.44, Dart 3.x
class FormSection extends StatefulWidget {
  // This widget OWNS the controller, so it disposes it.
  const FormSection({super.key});
  @override
  State<FormSection> createState() => _FormSectionState();
}

class _FormSectionState extends State<FormSection> {
  final _name = TextEditingController();

  @override
  void dispose() {
    _name.dispose(); // owner disposes
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // The child widget receives the controller but must NOT dispose it.
    return NameField(controller: _name);
  }
}

class NameField extends StatelessWidget {
  final TextEditingController controller;
  const NameField({super.key, required this.controller});

  @override
  Widget build(BuildContext context) =>
      TextField(controller: controller); // no dispose here
}
```

Se `NameField` liberasse um controller que não criou, o pai mais tarde tentaria usar um controller liberado e quebraria com `A TextEditingController was used after being disposed`. Esse erro exato tem seu próprio diagnóstico, mas a causa raiz quase sempre são dois widgets brigando pelo ciclo de vida de um controller.

O erro oposto eleva um controller para uma camada de gerenciamento de estado (um `ChangeNotifier`, um `Notifier` do Riverpod, um controller do GetX) e depois esquece que a camada agora possui a liberação. Se você move um `TextEditingController` para fora de um `State` e para um provider do Riverpod, o `onDispose`/`dispose` do provider é onde a chamada `controller.dispose()` agora vive, não o widget. Quando você está reestruturando a propriedade do ciclo de vida durante uma migração de gerenciamento de estado, esse é exatamente o tipo de coisa que quebra silenciosamente, o que é parte do motivo de eu ter escrito [migrar um app Flutter de GetX para Riverpod](/pt-br/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) como um movimento cuidadoso, passo a passo, em vez de um buscar e substituir.

## Casos limite que mordem

**Criação condicional.** Se um controller só é criado em alguns caminhos de código, torne o campo anulável e proteja a liberação: `_optional?.dispose();`. Não deixe um controller `late final` não inicializado e depois chame `dispose` nele, o que lança `LateInitializationError`.

**Recriar um controller ao atualizar o widget.** Se seu controller depende de uma propriedade do `widget`, você pode precisar liberar o antigo e criar um novo em `didUpdateWidget`. O padrão é: em `didUpdateWidget`, compare `oldWidget.x` com `widget.x`, e se diferirem, `_controller.dispose()` e depois atribua um novo. Esquecer a liberação em `didUpdateWidget` vaza um controller por cada mudança de propriedade relevante.

**GlobalKey e controllers são coisas diferentes.** Uma `GlobalKey` não precisa de liberação, mas um controller alcançado através de uma key sim. Não confunda os dois.

**O hot reload esconde os vazamentos.** O hot reload preserva o `State`, então um `dispose` esquecido pode não aparecer durante o desenvolvimento. Você só percebe quando a tela é de fato empurrada e removida, ou sob o rastreador de vazamentos. Teste o caminho de navegação real, não apenas o hot reload.

**Trabalho pesado em uma callback de controller pertence fora da thread de UI.** Se seu listener de `ScrollController` ou `AnimationController` faz computação significativa, esse trabalho executa no isolate de UI e compete com a renderização. Mova-o para um isolate em segundo plano; eu percorro isso em [escrever um isolate de Dart para trabalho intensivo em CPU](/pt-br/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/).

## Detectar vazamentos antes de publicar

Você não precisa encontrá-los lendo código. O Flutter inclui `leak_tracker`, e desde o Flutter 3.x o framework de testes se integra com ele para que vazamentos de liberação façam seus testes de widget falharem automaticamente quando o rastreamento de vazamentos está habilitado. A equipe do Flutter documenta o fluxo no [guia oficial de rastreamento de vazamentos](https://github.com/dart-lang/leak_tracker/blob/main/doc/leak_tracking/OVERVIEW.md). O modelo mental: espera-se que cada objeto descartável seja liberado; se o GC coleta um que nunca foi liberado, isso é um vazamento "não liberado", e se um é liberado mas nunca coletado, isso é um vazamento "não coletado pelo GC". Ambos são reportados com o stack trace da alocação, então você é apontado direto ao `initState` que criou o órfão.

Para um app em execução, abra o DevTools e use a visão de Memória. Empurre e remova a tela suspeita várias vezes, force um GC, e observe a contagem de instâncias de `AnimationController`, `TextEditingController` ou sua classe `State`. Se a contagem sobe e nunca cai, você tem um vazamento, e a visão de caminho de retenção mostra o que ainda aponta para o objeto. A mesma sessão do DevTools é onde você investigaria o timing dos frames, o que se sobrepõe ao fluxo de perfilamento de jank.

A disciplina é simples o bastante para enunciá-la em uma linha e vale a pena transformá-la em um reflexo de revisão de código: para cada `Controller`, `FocusNode`, `StreamSubscription` e `Timer` que você cria em um `State`, há exatamente uma chamada de liberação correspondente em `dispose()`, e `super.dispose()` é a última instrução do método. Conecte o `leak_tracker` aos seus testes de widget e o framework vai te cobrar isso.

## Relacionado

- [Como perfilar jank em um app Flutter com DevTools](/pt-br/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) cobre as visões de Memória e Desempenho que você usa para confirmar um vazamento.
- [Como escrever um isolate de Dart para trabalho intensivo em CPU](/pt-br/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) é onde as callbacks de controller que fazem trabalho real deveriam executar.
- [Como migrar um app Flutter de GetX para Riverpod](/pt-br/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) mostra como a propriedade da liberação se move quando você muda de camada de gerenciamento de estado.
- [Solução: RenderFlex overflowed no Flutter](/pt-br/2026/05/fix-renderflex-overflowed-in-flutter/) é o outro bug clássico do Flutter com o qual você esbarra construindo as mesmas telas.

## Fontes

- [State.dispose, referência da API do Flutter](https://api.flutter.dev/flutter/widgets/State/dispose.html)
- [AnimationController, referência da API do Flutter](https://api.flutter.dev/flutter/animation/AnimationController-class.html)
- [TextEditingController, referência da API do Flutter](https://api.flutter.dev/flutter/widgets/TextEditingController-class.html)
- [Visão geral do leak_tracker, dart-lang/leak_tracker](https://github.com/dart-lang/leak_tracker/blob/main/doc/leak_tracking/OVERVIEW.md)
- [Usar a visão de Memória, documentação do Flutter DevTools](https://docs.flutter.dev/tools/devtools/memory)
