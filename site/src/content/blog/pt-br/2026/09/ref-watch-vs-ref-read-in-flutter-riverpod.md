---
title: "ref.watch vs ref.read no Riverpod: qual é a diferença e quando uso cada um"
description: "ref.watch se inscreve e reconstrói, ref.read lê uma vez e nunca reconstrói. Use watch em todo método build e read apenas dentro de callbacks de eventos. Aqui está a matriz de decisão, o código-fonte dos dois métodos no flutter_riverpod 3.4.3 e as quatro falhas silenciosas: watch em um callback, read no corpo de um provider, read em um provider autoDispose e read usado como otimização."
pubDate: 2026-09-05
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
lang: "pt-br"
translationOf: "2026/09/ref-watch-vs-ref-read-in-flutter-riverpod"
translatedBy: "claude"
translationDate: 2026-09-05
---

`ref.watch` registra uma inscrição, `ref.read` não. Essa única diferença decide todo o resto. Use `ref.watch` dentro de métodos `build`, tanto o `build` de um `ConsumerWidget` quanto o `build` de um provider ou de um `Notifier`, e use `ref.read` dentro de código que roda uma vez em reação a um evento: `onPressed`, `onTap`, o callback de um `Timer`, um método de mutação de um `Notifier`. A escolha não é um compromisso de desempenho, é uma regra sobre o local da chamada: código que roda de novo quando o estado muda deve usar watch, código que roda exatamente uma vez deve usar read. Tudo abaixo foi verificado contra `riverpod` e `flutter_riverpod` 3.4.3 (publicados em 2026-09-03) no Flutter 3.47.2 stable com Dart 3.13.2, mais `riverpod_lint` 3.1.9.

## A matriz de decisão

| | `ref.watch` | `ref.read` |
| --- | --- | --- |
| Registra uma inscrição | sim | não |
| Reconstrói quem chamou quando o valor muda | sim | nunca |
| Mantém vivo um provider `autoDispose` | sim | não |
| Correto dentro de `build` | sim, é o único lugar | quase sempre um bug |
| Correto dentro de `onPressed` / `onTap` / timers | não | sim, é o único lugar |
| Correto dentro de `initState` | não | sim, para uma semeadura única |
| Correto dentro de um método de mutação de `Notifier` | não | sim |
| Pausado quando o widget sai da tela (`TickerMode` do Riverpod 3) | sim | não se aplica |
| Notificações filtradas por `==` | sim | não se aplica |
| Lança erro se você chamar no lugar errado | não, falha em silêncio | não |
| Ferramenta para reduzir reconstruções | `.select` | não é esta |

As duas linhas que mais custam tempo de depuração são as duas últimas. Não existe nenhuma proteção em tempo de execução em nenhum dos dois métodos, e `ref.read` não é a forma de cortar reconstruções.

## Os dois métodos vivem em duas classes diferentes

O Riverpod expõe `watch` e `read` duas vezes, em dois tipos sem relação entre si, e as implementações são realmente diferentes.

`WidgetRef` é o que um `ConsumerWidget`, um builder de `Consumer` ou um `ConsumerState` entrega para você. A implementação vive em `ConsumerStatefulElement`:

```dart
// package:flutter_riverpod/src/core/consumer.dart, flutter_riverpod 3.4.3
@override
StateT watch<StateT>(ProviderListenable<StateT> target) {
  _assertNotDisposed();
  return _dependencies
          .putIfAbsent(target, () {
            final oldDependency = _oldDependencies?.remove(target);
            if (oldDependency != null) {
              return oldDependency;
            }
            final sub = container.listen<StateT>(
              target,
              (_, _) => markNeedsBuild(),
            );
            _applyTickerMode(sub);
            return sub;
          })
          .readSafe()
          .valueOrProviderException
      as StateT;
}

@override
StateT read<StateT>(ProviderListenable<StateT> provider) {
  _assertNotDisposed();
  return ProviderScope.containerOf(this, listen: false).read(provider);
}
```

`watch` guarda uma `ProviderSubscription` em um mapa `_dependencies` por element, cujo listener chama `markNeedsBuild()`. `read` alcança o `ProviderContainer` com `listen: false` e chama `read` nele. Sem entrada no mapa, sem listener, sem reconstrução, nunca.

`Ref` é o que o corpo de um provider ou um `Notifier` recebe. Mesmos nomes, mecânica diferente:

```dart
// package:riverpod/src/core/ref.dart, riverpod 3.4.3
@override
StateT watch<StateT>(ProviderListenable<StateT> listenable) {
  _throwIfInvalidUsage();
  late ProviderSubscription<StateT> sub;
  sub = _element.listen<StateT>(
    listenable,
    (prev, value) => _invalidateSelf(asReload: true, manual: false),
    onError: (err, stack) => _invalidateSelf(asReload: true, manual: false),
    onDependencyMayHaveChanged: _element._markDependencyMayHaveChanged,
  );
  return sub.readSafe().valueOrProviderException;
}

@override
StateT read<StateT>(ProviderListenable<StateT> listenable) {
  _throwIfInvalidUsage();
  final result = container.read(listenable);
  if (kDebugMode) _debugAssertCanDependOn(listenable);
  return result;
}
```

Do lado do provider, `watch` é `listen` mais `invalidateSelf`, algo que a documentação oficial deixa explícito no comentário de documentação de `Ref.watch`. `read` é uma leitura simples do container. O padrão é idêntico nas duas classes: watch cria uma aresta no grafo, read não.

## A regra é sobre o local da chamada, não sobre o provider

Faça uma pergunta: esta linha de código precisa rodar de novo quando o valor mudar?

- Dentro de `build`, sim. O sentido de `build` é exatamente permitir que o Riverpod o chame de novo. Use `ref.watch`.
- Dentro de `onPressed`, não. A pessoa vai apertar o botão de novo e o callback vai rodar de novo com um valor fresco. Use `ref.read`.

A documentação oficial é direta sobre qual é o padrão. Da página de refs do Riverpod: "Do not use Ref.read as a mean to 'optimize' your code by avoiding Ref.watch. This will make your code more brittle." E do próprio comentário de documentação de `Ref.read` na 3.4.3: "If possible, avoid using [read] and prefer [watch], which is generally safer to use."

Esta é a forma correta em toda versão do Riverpod desde a 2.0:

```dart
// flutter_riverpod 3.4.3, Flutter 3.47.2, Dart 3.13.2
final counterProvider = NotifierProvider<Counter, int>(Counter.new);

class Counter extends Notifier<int> {
  @override
  int build() => 0;

  void increment() => state++;
}

class CounterView extends ConsumerWidget {
  const CounterView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Rerun this line on every change: watch.
    final count = ref.watch(counterProvider);

    return Column(
      children: [
        Text('$count'),
        ElevatedButton(
          // Runs once per tap: read.
          onPressed: () => ref.read(counterProvider.notifier).increment(),
          child: const Text('increment'),
        ),
      ],
    );
  }
}
```

## `ref.watch` dentro de um callback não lança erro, e esse é o problema inteiro

Se você mover `ref.watch(counterProvider)` para dentro do closure de `onPressed`, o app compila, o analisador fica quieto e o valor devolvido está correto. Nada no `riverpod_lint` 3.1.9 sinaliza isso: o conjunto de regras é `missing_provider_scope`, `provider_dependencies`, `scoped_providers_should_specify_dependencies`, `avoid_build_context_in_providers`, `provider_parameters`, `avoid_public_notifier_properties`, `unsupported_provider_value`, `functional_ref`, `notifier_extends`, `avoid_ref_inside_state_dispose`, `avoid_keep_alive_dependency_inside_auto_dispose`, `notifier_build`, `riverpod_syntax_error`, `async_value_nullable_pattern` e `protected_notifier_properties`. Nenhuma delas é "watch fora do build".

O que acontece de verdade é pior do que um crash. Olhe de novo para `ConsumerStatefulElement.build`:

```dart
// package:flutter_riverpod/src/core/consumer.dart, flutter_riverpod 3.4.3
@override
Widget build() {
  if (_tickerModeNotifier == null) {
    _updateTickerModeNotifier();
  }
  try {
    _oldDependencies = _dependencies;
    for (var i = 0; i < _listeners.length; i++) {
      _listeners[i].close();
    }
    _listeners.clear();
    _dependencies = {};
    return super.build();
  } finally {
    for (final dep in _oldDependencies!.values) {
      dep.close();
    }
    _oldDependencies = null;
  }
}
```

Todo build troca `_dependencies` por um mapa novo e fecha o que sobreviveu do anterior. Um `ref.watch` chamado a partir de `onPressed` roda quando `_oldDependencies` é `null`, então ele insere uma inscrição totalmente nova no mapa `_dependencies` vivo. Desse momento até a próxima reconstrução, o widget está inscrito em um provider que o método `build` dele nunca menciona. Se o provider mudar nessa janela, `markNeedsBuild` dispara e o widget reconstrói. Depois a reconstrução descarta a inscrição, porque `build` não a registra de novo, e a segunda mudança não faz nada.

Isso é reatividade de um único disparo que depende do ritmo dos frames. É exatamente o tipo de bug que só reproduz em um aparelho lento.

Repare no contraste com `ref.listen`, que se protege:

```dart
// package:flutter_riverpod/src/core/consumer.dart, flutter_riverpod 3.4.3
@override
void listen<StateT>(
  ProviderListenable<StateT> provider,
  void Function(StateT? previous, StateT value) listener, {
  void Function(Object error, StackTrace stackTrace)? onError,
  bool weak = false,
}) {
  _assertNotDisposed();
  assert(
    debugDoingBuild,
    'ref.listen can only be used within the build method of a ConsumerWidget',
  );
  ...
}
```

`listen` faz um assert em builds de depuração. `watch` não. Não leia a ausência de assert como permissão.

## `ref.read` no corpo de um provider congela a dependência para sempre

O mesmo erro do lado do provider é ainda mais silencioso, porque não existe nenhum widget que visivelmente deixe de reconstruir.

```dart
// riverpod 3.4.3, WRONG
final localeProvider = NotifierProvider<LocaleNotifier, Locale>(LocaleNotifier.new);

final greetingProvider = Provider<String>((ref) {
  // No graph edge. This provider will never be recomputed when the locale changes.
  final locale = ref.read(localeProvider);
  return locale.languageCode == 'fr' ? 'Bonjour' : 'Hello';
});
```

`greetingProvider` calcula uma vez e guarda o resultado em cache. Mudar o locale reconstrói `localeProvider` e todo widget que o observa, e deixa `greetingProvider` sentado em uma string obsoleta até que outra coisa o invalide. Troque por `ref.watch(localeProvider)` e a aresta existe: `Ref.watch` chama `_invalidateSelf(asReload: true)` a cada mudança, então `greetingProvider` é recalculado sob demanda.

O mesmo vale dentro de um `Notifier`. O comentário de documentação de `Notifier.build` na 3.4.3 diz isso diretamente: "It is safe to use [Ref.watch] or [Ref.listen] inside this method." Watch no `build`. Em `increment()` ou `submit()`, read.

## `ref.read` em um provider `autoDispose` joga o trabalho fora

Esta é a que produz um relato de bug intitulado "meu estado volta para zero".

O descarte automático é rastreado por listeners, não por leituras. Com geração de código, `@riverpod` usa `keepAlive: false` por padrão, então todo provider gerado se auto-descarta a menos que você diga o contrário:

```dart
// riverpod_annotation 3.x
final class Riverpod {
  const Riverpod({
    this.keepAlive = false,
    ...
  });
}
```

Providers escritos à mão funcionam ao contrário. `NotifierProvider` e `Provider` no `riverpod` 3.4.3 declaram ambos `super.isAutoDispose = false`, então são mantidos vivos por padrão e você opta pelo contrário com `NotifierProvider.autoDispose` ou `isAutoDispose: true`.

Agora considere um contador gerado e auto-descartável que nada na tela está observando:

```dart
// riverpod_generator 4.x, riverpod 3.4.3
@riverpod
class Counter extends _$Counter {
  @override
  int build() => 0;

  void increment() => state++;
}

// In a widget that does NOT watch counterProvider anywhere:
onPressed: () {
  ref.read(counterProvider.notifier).increment(); // state becomes 1
},
```

`ref.read` cria o provider, roda `build()`, devolve o notifier e não adiciona nenhum listener. A documentação de descarte descreve o tempo: quando a contagem de listeners chega a zero o provider é considerado "not used", o Riverpod "waits for one frame", e se ele continuar sem uso o provider é destruído. Então o incremento cai sobre um `Counter` que é desmontado um frame depois. O próximo toque começa de `0` de novo.

A correção não é `ref.watch` no callback. É garantir que algo observe o provider de forma legítima, normalmente o widget que exibe a contagem, ou chamar `ref.keepAlive()` dentro de `build` se o estado realmente precisa sobreviver aos seus listeners.

## Observe o valor, leia o notifier

`ref.read(counterProvider.notifier)` é a forma canônica de chegar aos métodos de mutação, e aparece literalmente no comentário de documentação de `Notifier`. `ref.watch(counterProvider.notifier)` não é um crime, mas é inútil: o Riverpod filtra todas as notificações por `==` na 3.x, e o comentário de documentação de `Notifier` afirma que quando `build` roda de novo "the [Notifier] will **not** be recreated. Its instance will be preserved between executions of [build]." A mesma instância é igual a si mesma, então observar `.notifier` quase nunca emite. Ele só emite quando o provider é totalmente descartado e recriado. Você ganha uma inscrição que não traz nada além de um keep-alive de auto-descarte que você não pediu.

Portanto: `ref.watch(provider)` para o valor, `ref.read(provider.notifier)` para os métodos.

## `initState` não quer nenhum dos dois

Em um `ConsumerState`, `initState` roda antes do primeiro `build`. Ali `ref.watch` não lança erro, mas a inscrição que ele cria é descartada pelo primeiro build a menos que `build` por acaso observe o mesmo provider, o que torna o comportamento acidental. `ref.listen` lança o assert de `debugDoingBuild`. A API suportada é `listenManual`:

```dart
// flutter_riverpod 3.4.3
class _FormState extends ConsumerState<MyForm> {
  late final ProviderSubscription<AsyncValue<void>> _sub;

  @override
  void initState() {
    super.initState();
    // Seed a controller once: read is correct here.
    _controller.text = ref.read(draftProvider);

    // Subscribe outside build: listenManual is correct here.
    _sub = ref.listenManual(submitProvider, (previous, next) {
      next.whenOrNull(error: (e, _) => showErrorBar(context, e));
    });
  }
}
```

`listenManual` lê deliberadamente o container com `listen: false` para ser seguro em `initState`, e `ConsumerStatefulElement.unmount` fecha os listeners manuais depois que `State.dispose` roda. Você não precisa fechá-lo, embora a inscrição devolvida permita isso.

Já que você está em código de ciclo de vida de `State`, lembre do outro extremo: tocar em `ref` no `dispose` lança erro, e a regra `avoid_ref_inside_state_dispose` do `riverpod_lint` existe justamente para isso. A mensagem na 3.4.3 é `Using "ref" when a widget is about to or has been unmounted is unsafe.`, que é a redação atual do antigo [erro Cannot use "ref" after the widget was disposed](/pt-br/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/).

## O Riverpod 3 pausa as inscrições de watch, o que mata o último argumento a favor de read

O folclore de "read é mais barato" é anterior ao Riverpod 3. Na 3.x, as inscrições criadas por `WidgetRef.watch` participam do `TickerMode`:

```dart
// package:flutter_riverpod/src/core/consumer.dart, flutter_riverpod 3.4.3
void _updateTickerMode() {
  final isActive = _tickerModeNotifier!.value;
  if (isActive != _isActive) {
    _isActive = isActive;
    for (final sub in _dependencies.values) {
      if (isActive) {
        sub.resume();
      } else {
        sub.pause();
      }
    }
  }
}
```

Quando um widget sai da tela, em uma aba inativa de um `TabBarView` ou sob uma rota empilhada por cima, cada uma das suas inscrições de watch é pausada e os providers por trás delas param de trabalhar. Não existe economia equivalente ao trocar para `ref.read`, porque `ref.read` nunca teve uma inscrição para pausar. O custo em tempo de execução de um watch é uma entrada em um `HashMap` mais um callback de listener, o que não é o que está machucando o seu orçamento de frame.

Se você quer mesmo menos reconstruções, a ferramenta é `.select`, não `read`:

```dart
// flutter_riverpod 3.4.3
// Rebuilds on every user field change:
final user = ref.watch(userProvider);
Text(user.name);

// Rebuilds only when the name changes, because select's output is compared with ==:
final name = ref.watch(userProvider.select((u) => u.name));
Text(name);
```

`select` preserva a inscrição, o que significa que preserva a reatividade e o keep-alive, e apenas filtra o que conta como mudança. Essa é a otimização. `ref.read` não é uma otimização, é a remoção de um recurso.

Note que o filtro por `==` é global no Riverpod 3.0 e vale igualmente para `watch`, `select` e `listen`, o que é uma classe própria de surpresa quando a sua classe de estado não implementa igualdade. Se um watch não dispara quando você espera, cheque `==` antes de culpar o local da chamada: é o mesmo mecanismo por trás de [StreamProvider descartando eventos no Riverpod 3.0](/pt-br/2026/07/fix-riverpod-3-0-streamprovider-stops-emitting-filtered-by-equality/).

## O que digitar na prática

Use `ref.watch` por padrão. Recorra a `ref.read` em exatamente três lugares: um callback de evento, um método de mutação de um `Notifier`, e um `Ref` que você guardou deliberadamente em uma classe de serviço simples para que o serviço possa puxar valores atuais sem ser recriado, que é o caso de uso mostrado pela própria documentação de `Ref.read`. Em todo o resto, watch. Se você se pegar substituindo um watch por um read para parar alguma reconstrução, você encontrou uma oportunidade de `select` ou um provider com escopo grosso demais, não um motivo para cortar a aresta do grafo.

E se um `ref.watch` parece pertencer a um callback, o que você provavelmente quer é `ref.listen` no `build` (para efeitos colaterais enquanto o widget está vivo) ou `ref.listenManual` no `initState` (para efeitos colaterais amarrados ao `State`).

## Relacionado

- [Riverpod Notifier vs AsyncNotifier vs StreamNotifier](/pt-br/2026/08/riverpod-notifier-vs-asyncnotifier-vs-streamnotifier-in-flutter/)
- [Checar ref.mounted depois de um intervalo assíncrono no Riverpod 3](/pt-br/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/)
- [Qual pacote do Riverpod instalar: riverpod, flutter_riverpod ou hooks_riverpod](/pt-br/2026/07/riverpod-vs-flutter-riverpod-vs-hooks-riverpod-which-package-do-i-need/)
- [Mostrando estados de carregamento e erro com AsyncValue](/pt-br/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)
- [O guia completo de migração do Riverpod 2.x para o 3.0](/pt-br/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/)

## Fontes

- [Refs](https://riverpod.dev/docs/concepts2/refs), a página oficial de `Ref.watch`, `Ref.read` e `Ref.listen`.
- [Automatic disposal](https://riverpod.dev/docs/concepts2/auto_dispose), sobre o período de carência de um frame e o rastreamento por contagem de listeners.
- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new), sobre o filtro por `==` e a pausa dirigida pelo `TickerMode`.
- [flutter_riverpod 3.4.3 no pub.dev](https://pub.dev/packages/flutter_riverpod/versions/3.4.3), fonte do `ConsumerStatefulElement` citado acima.
- [riverpod 3.4.3 no pub.dev](https://pub.dev/packages/riverpod/versions/3.4.3), fonte de `Ref.watch` e `Ref.read` citados acima.
- [riverpod_lint 3.1.9 no pub.dev](https://pub.dev/packages/riverpod_lint), a lista completa de regras referenciada acima.
