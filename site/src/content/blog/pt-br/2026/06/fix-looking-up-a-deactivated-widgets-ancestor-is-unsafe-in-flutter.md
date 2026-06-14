---
title: "Correção: Looking up a deactivated widget's ancestor is unsafe no Flutter"
description: "Esse erro significa que você chamou context.of() depois que o widget saiu da árvore, normalmente em um callback assíncrono ou no dispose(). Capture o valor antes do await ou no didChangeDependencies()."
pubDate: 2026-06-14
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
lang: "pt-br"
translationOf: "2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-14
---

Você usou um `BuildContext` para buscar um ancestral (`Navigator.of`, `Theme.of`, `ScaffoldMessenger.of`, `MediaQuery.of`, `Provider.of`, um `InheritedWidget`) depois que o widget dono desse contexto foi removido da árvore. Os dois gatilhos mais comuns são um callback assíncrono que termina depois que o usuário navegou para outra tela, e uma busca dentro do `dispose()`. A correção é capturar o que você precisa do contexto antes do `await` (ou no `didChangeDependencies`), e proteger o trabalho pós-await com `if (!mounted) return;`. Este guia usa Flutter 3.44 (estável, maio de 2026) e Dart 3.x.

Um `BuildContext` é apenas um identificador de um `Element` na árvore. Assim que esse elemento é desativado, percorrer para cima a partir dele pode retornar um ancestral obsoleto ou um nó que está prestes a se mover, então o framework recusa a busca em vez de te entregar uma resposta errada. É a mesma família de erro de ciclo de vida que um [controller usado depois de ter sido liberado](/pt-br/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/): o objeto ainda existe, mas não é mais válido tocá-lo.

## O erro em contexto

A mensagem completa que o Flutter imprime é assim:

```
FlutterError (Looking up a deactivated widget's ancestor is unsafe.
At this point the state of the widget's element tree is no longer stable.
To safely refer to a widget's ancestor in its dispose() method, save a reference
to the ancestor by calling dependOnInheritedWidgetOfExactType() in the widget's
didChangeDependencies() method.)
```

Em builds de release o texto da asserção é removido e, em vez dele, você vê uma queda direta ou um `Null check operator used on a null value` mais abaixo na pilha, porque a busca retornou `null`. A asserção dispara a partir de `Element._debugCheckStateIsActiveForAncestorLookup` em `package:flutter/src/widgets/framework.dart`, que toda chamada a `dependOnInheritedWidgetOfExactType` e `findAncestorStateOfType` executa primeiro em modo debug.

## Por que "deactivated" é diferente de "disposed"

O Flutter desmonta um widget em duas fases. Primeiro `deactivate()` é executado: o elemento é desconectado do pai e movido para uma lista de inativos, onde pode ser reativado nesse mesmo frame se foi reparentado com uma `GlobalKey`. Só se não for reaproveitado até o fim do frame é que `dispose()` é executado e o estado fica definitivamente morto.

O getter `mounted` em `State` é `false` para ambas as fases. Essa é a percepção chave: `mounted` não significa "ainda não liberado", significa "atualmente conectado à árvore". Por isso `mounted` é a proteção correta para este erro, mesmo que a palavra na mensagem seja "deactivated", não "disposed".

```dart
// Flutter 3.44, Dart 3.x
@override
void deactivate() {
  // mounted is already false by the time your async callback resumes here
  super.deactivate();
}
```

## Reprodução mínima: uma busca depois do await

A forma mais comum. Você toca um botão, faz trabalho assíncrono e depois usa o contexto. Se o usuário voltar durante o await, o contexto está desativado quando o callback é retomado.

```dart
// Flutter 3.44, Dart 3.x -- crashes if the user leaves mid-await
class SaveButton extends StatefulWidget {
  const SaveButton({super.key});
  @override
  State<SaveButton> createState() => _SaveButtonState();
}

class _SaveButtonState extends State<SaveButton> {
  Future<void> _save() async {
    await Future<void>.delayed(const Duration(seconds: 2)); // network call
    // If the widget was popped during those 2s, this throws:
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Saved')),
    );
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    return ElevatedButton(onPressed: _save, child: const Text('Save'));
  }
}
```

A segunda reprodução é uma busca no `dispose()`, que é sempre insegura porque o elemento já está desconectado a essa altura:

```dart
// Flutter 3.44, Dart 3.x -- always throws in debug
@override
void dispose() {
  // The element is detached; this ancestor lookup is the exact thing the
  // assertion forbids.
  final messenger = ScaffoldMessenger.of(context);
  messenger.clearSnackBars();
  super.dispose();
}
```

## Correção 1: capture antes do await, proteja depois

Esta é a correção certa para o caso assíncrono e a primeira a usar. Um `BuildContext` só é seguro de ler enquanto o widget está montado, então leia tudo o que você precisa dele de forma síncrona, antes do primeiro `await`. Depois, qualquer objeto que você capturou (um `NavigatorState`, um `ScaffoldMessengerState`) continua válido mesmo que o widget saia da árvore, porque esses objetos de estado sobrevivem à busca individual do elemento.

```dart
// Flutter 3.44, Dart 3.x -- safe
Future<void> _save() async {
  // Capture the ancestor state objects while still mounted.
  final messenger = ScaffoldMessenger.of(context);
  final navigator = Navigator.of(context);

  await Future<void>.delayed(const Duration(seconds: 2));

  if (!mounted) return; // the widget left the tree; stop here

  messenger.showSnackBar(const SnackBar(content: Text('Saved')));
  navigator.pop();
}
```

Duas coisas estão fazendo o trabalho aqui. Capturar `messenger` e `navigator` antes do `await` significa que você nunca chama `.of(context)` em um contexto desativado. O `if (!mounted) return;` então pula completamente as atualizações da interface se o usuário já saiu, o que quase sempre é o que você quer de qualquer forma. Note que `mounted` deve ser verificado depois do `await`, não antes, porque o await é onde a brecha se abre.

Desde o Flutter 3.7 também existe um getter `BuildContext.mounted`, então se você só tem um contexto (não um `State`) pode escrever `if (!context.mounted) return;`. A regra de lint `use_build_context_synchronously`, ativada por padrão no `flutter_lints`, sinaliza exatamente a proteção ausente nesta reprodução, então ative-a e deixe o analisador pegar esses casos antes do tempo de execução.

## Correção 2: leia os inherited widgets no didChangeDependencies

Se você realmente precisa de um valor herdado durante o `dispose()`, por exemplo para se desregistrar de algo que encontrou via `.of(context)`, não pode buscá-lo no momento do dispose. Capture-o antes. `didChangeDependencies()` é executado logo após o `initState` e novamente sempre que uma dependência herdada muda, e o contexto é totalmente válido ali.

```dart
// Flutter 3.44, Dart 3.x -- safe dispose-time access
class _MyWidgetState extends State<MyWidget> {
  late MyModel _model;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Captured while mounted; survives into dispose().
    _model = MyModelScope.of(context);
  }

  @override
  void dispose() {
    _model.removeListener(_onChange); // no context lookup needed
    super.dispose();
  }
}
```

Isto é exatamente o que a mensagem de erro manda você fazer, modernizado: o texto ainda diz `dependOnInheritedWidgetOfExactType()`, que é a chamada de baixo nível que `Theme.of`, `MediaQuery.of` e companhia envolvem. Você raramente a chama diretamente; chamar o acessor tipado `.of` no `didChangeDependencies` faz a mesma coisa.

## Correção 3: não busque contexto dentro de callbacks que você não controla

Uma variante sutil: a busca não está no seu `dispose()`, mas em um callback que dispara depois do dispose, como um `Timer`, um listener de stream, um listener de status de animação ou um `Future.then`. A correção é a mesma proteção, mas você também quer cancelar a fonte no `dispose()` para que o callback pare de disparar por completo.

```dart
// Flutter 3.44, Dart 3.x
StreamSubscription<int>? _sub;

@override
void initState() {
  super.initState();
  _sub = someStream.listen((value) {
    if (!mounted) return;          // guard
    Navigator.of(context).pushNamed('/next');
  });
}

@override
void dispose() {
  _sub?.cancel();                  // stop the source
  super.dispose();
}
```

Cancelar a inscrição é o cinto; a verificação de `mounted` é o suspensório. Cancelar sozinho costuma resolver, mas um callback que já estava em andamento quando `cancel()` é executado ainda pode ser retomado uma vez, então mantenha a proteção. O mesmo par se aplica quando você [libera controllers e outros recursos](/pt-br/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/): libere a fonte e proteja qualquer coisa que possa disparar tarde.

## Detalhes para vigiar e casos parecidos

**`initState` é cedo demais para `.of(context)` com inherited widgets.** Você pode ler `context` no `initState` para algumas coisas, mas `dependOnInheritedWidgetOfExactType` (e portanto `Theme.of`, `MediaQuery.of`) não é permitido ali porque o elemento ainda não está ligado às suas dependências herdadas. Mova essas leituras para o `didChangeDependencies`. Isso lança uma asserção diferente ("dependOnInheritedWidgetOfExactType was called before initState completed"), então se a sua mensagem menciona `initState`, você está diante da variante de busca antecipada, não a de desativação.

**`Navigator.pop` seguido de um uso do contexto.** Um padrão frequente no FlutterFlow e em formulários feitos à mão é `Navigator.pop(context)` e depois, na linha seguinte, outra chamada `.of(context)`. Após o pop, o elemento da rota começa a se desativar, então a segunda busca pode lançar o erro. Capture o navigator ou o messenger antes de fazer o pop.

**Reparentamento com `GlobalKey`.** Se você move uma subárvore com uma `GlobalKey` e algo dentro dela faz uma busca de ancestral durante o frame do reparentamento, você pode bater nisso de forma transitória. É mais raro; a correção é adiar a busca para depois do frame com `WidgetsBinding.instance.addPostFrameCallback` e depois reverificar `mounted`.

**Builds de release o escondem.** Como a mensagem vem de um `assert`, ela só aparece em debug. Em profile e release a busca retorna `null` em silêncio e você quebra mais tarde com uma desreferência de null. Se você vê um `Null check operator used on a null value` só em release e só depois de navegar, suspeite disso. A [proteção de `setState() called during build`](/pt-br/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) se comporta da mesma forma: uma asserção só de debug escondendo um null em modo release.

**A versão do Riverpod disso.** Se você usa um `WidgetRef` em vez de `BuildContext`, o erro equivalente é [`Cannot use "ref" after the widget was disposed`](/pt-br/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/). Mesma causa raiz, mesma correção: leia antes do await, proteja depois. Recorrer a um padrão assíncrono estruturado como [`AsyncValue` para estados de carregamento e erro](/pt-br/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) evita a maioria dessas proteções manuais porque o framework rastreia o ciclo de vida do widget por você.

## A única regra que previne todos esses casos

Trate o `BuildContext` como válido apenas entre `build` e o próximo ponto de suspensão. No momento em que você faz `await`, o contexto pode ter sumido quando você retornar, então capture o que precisa primeiro e proteja com `mounted`, ou reestruture para que a busca nunca cruze uma fronteira assíncrona. Uma vez que esse hábito está no lugar, o erro de "deactivated widget's ancestor", o de controller liberado e o de ref liberado param de aparecer todos pela mesma razão.

## Sources

- [State.mounted property](https://api.flutter.dev/flutter/widgets/State/mounted.html) e [State.didChangeDependencies](https://api.flutter.dev/flutter/widgets/State/didChangeDependencies.html), documentação da API do Flutter.
- [BuildContext.dependOnInheritedWidgetOfExactType](https://api.flutter.dev/flutter/widgets/BuildContext/dependOnInheritedWidgetOfExactType.html), documentação da API do Flutter (a chamada nomeada na mensagem de erro).
- [flutter/flutter#19462: "Looking up a deactivated widget's ancestor is unsafe"](https://github.com/flutter/flutter/issues/19462), o issue canônico que o rastreia até `Navigator.push` dentro de um callback assíncrono.
- [use_build_context_synchronously lint](https://dart.dev/tools/linter-rules/use_build_context_synchronously), regras do linter do Dart, que sinaliza a proteção ausente de forma estática.
