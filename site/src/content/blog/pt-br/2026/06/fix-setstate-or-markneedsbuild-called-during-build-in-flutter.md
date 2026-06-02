---
title: "Solução: setState() or markNeedsBuild() called during build no Flutter"
description: "Este erro significa que você mutou o estado enquanto o Flutter compilava. Tire o setState do build, ou adie-o com addPostFrameCallback. Aqui está por que acontece e a solução correta."
pubDate: 2026-06-02
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
lang: "pt-br"
translationOf: "2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-02
---

Você chamou `setState()` (ou algo que chama `notifyListeners()`, `markNeedsBuild()` ou `Navigator.push`) enquanto o Flutter estava no meio da sua fase de compilação. A solução é não mudar o estado durante o `build`. Se o gatilho for realmente um callback síncrono que executa no meio da compilação, adie a mutação para o próximo frame com `WidgetsBinding.instance.addPostFrameCallback((_) => setState(...))`. Este guia usa Flutter 3.44 (estável, maio de 2026) e Dart 3.x.

O erro é uma proteção, não uma falha. O Flutter compila os pais antes dos filhos em uma única passada síncrona. Marcar um widget como sujo no meio da passada pediria ao framework para agendar uma recompilação de algo que talvez ele já tenha visitado, o que não pode ser honrado no frame atual. Então ele lança uma exceção em vez de descartar sua atualização em silêncio.

## O erro em contexto

A mensagem completa que o Flutter imprime no console fica assim:

```
======== Exception caught by widgets library =======================
The following assertion was thrown while dispatching notifications for ProductModel:
setState() or markNeedsBuild() called during build.

This _MyHomePageState widget cannot be marked as needing to build because the
framework is already in the process of building widgets. A widget can be marked
as needing to be built during the build phase only if one of its ancestors is
currently building. This exception is allowed because the framework builds parent
widgets before children, which means a dirty descendant will always be built.
Otherwise, the framework might not visit this widget during this build phase.

The widget on which setState() or markNeedsBuild() was called was: _MyHomePageState
The widget which was currently being built when the offending call was made was: Consumer<ProductModel>
====================================================================
```

As duas linhas que importam estão no final. "The widget on which setState() ... was called" é o que você está tentando recompilar. "The widget which was currently being built" é de onde a chamada problemática se originou. A diferença entre esses dois widgets é o bug.

## Por que isso acontece

Há quatro gatilhos comuns, mais ou menos em ordem de frequência com que mordem:

Um listener notifica durante a compilação. Um `ChangeNotifier`, `ValueNotifier` ou provider chama `notifyListeners()` de dentro de um método que você invocou enquanto o lia no `build`. A notificação pede de forma síncrona a cada widget que escuta para recompilar, mas você já está compilando um deles.

Você chamou `setState` diretamente no `build`. Geralmente por acidente: um método que calcula um valor também vira uma flag e chama `setState`, e você chama esse método a partir do `build`.

Você leu um provider com `listen: true` durante uma compilação que também o muta. `Provider.of<T>(context)` (escutando) registra uma dependência. Se o mesmo frame escreve nesse provider, a escrita tenta recompilar o dependente que ainda está compilando.

Você navegou ou exibiu um diálogo a partir do `build`. `Navigator.push`, `showDialog` e `Scaffold.of(context).showSnackBar` marcam os ancestrais como sujos. Chamá-los a partir do `build` (em vez de um manipulador de eventos) dispara a mesma asserção.

A regra unificadora da equipe do Flutter é simples: o `build` deve ser uma função pura da configuração do widget e do estado. Ele retorna uma árvore de widgets e não faz mais nada. Efeitos colaterais que mudam o estado pertencem aos métodos de ciclo de vida (`initState`, `didChangeDependencies`) ou aos manipuladores de eventos (`onPressed`, `onTap`), nunca ao `build`.

## Como encontrar a chamada problemática

A mensagem do console nomeia dois widgets, mas a linha que você precisa mudar geralmente não está em nenhum deles. Está no que executou de forma síncrona entre eles. Leia a mensagem de baixo para cima:

1. "The widget which was currently being built" informa a compilação em andamento. Procure no seu código o método `build` desse widget, ou o callback `builder` se for um `Consumer`, `Builder`, `LayoutBuilder` ou `ValueListenableBuilder`.
2. Dentro dessa compilação, encontre cada chamada de método que não seja uma leitura pura. Um getter que incrementa um contador, um método chamado `load`, `refresh`, `fetch` ou `update`, qualquer coisa que toque um `ChangeNotifier`. Essa chamada é o seu suspeito.
3. Se nada na compilação parecer impuro, o gatilho é um listener. Olhe a linha "dispatching notifications for X" bem no topo: `X` é o notificador que disparou. Encontre onde `X.notifyListeners()` é chamado e rastreie de volta o que o invocou durante este frame.

Em compilações de depuração, o stack trace abaixo da mensagem aponta diretamente para o ponto da chamada `notifyListeners` ou `setState`. Em compilações de produção a asserção é removida na compilação, então o bug se manifesta como uma atualização descartada ou um frame obsoleto em vez de uma falha. É exatamente por isso que você quer corrigir a causa, não silenciar o sintoma: o sintoma só existe na depuração.

## Uma reprodução mínima

Este widget lança a exceção no seu primeiro frame. O modelo notifica seus listeners de um método que executa enquanto um `Consumer` está compilando.

```dart
// Flutter 3.44, Dart 3.x -- throws "setState() or markNeedsBuild() called during build".
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

class ProductModel extends ChangeNotifier {
  int _count = 0;
  int get count => _count;

  // Looks like a harmless getter-with-side-effect. It is not.
  int countAndTrack() {
    _count++;
    notifyListeners(); // fires synchronously, during build
    return _count;
  }
}

class CounterText extends StatelessWidget {
  const CounterText({super.key});

  @override
  Widget build(BuildContext context) {
    return Consumer<ProductModel>(
      builder: (context, model, _) {
        // Calling a method that notifies, from inside build:
        return Text('Seen ${model.countAndTrack()} times');
      },
    );
  }
}
```

O `Consumer` está compilando. Seu `builder` chama `countAndTrack()`, que chama `notifyListeners()`, que pede ao `Consumer` para recompilar enquanto ele ainda está compilando. O Flutter lança a exceção.

A mesma forma aparece sem o Provider. Qualquer callback de `addListener` que acabe chamando `setState` de forma síncrona durante a compilação de um pai vai provocá-la.

## Solução, em detalhe

As soluções estão ordenadas por quanto eu as recomendo. A primeira é quase sempre a resposta de verdade.

### 1. Tire a mudança de estado de fora do build (recomendado)

Não mute durante a compilação. Calcule valores derivados no `build`, mas execute a mudança de estado real em um método de ciclo de vida ou em um manipulador de eventos. Na reprodução, a mutação pertence ao `initState`, não ao `builder`:

```dart
// Flutter 3.44, Dart 3.x -- correct: mutate once, off the build path.
class CounterText extends StatefulWidget {
  const CounterText({super.key});

  @override
  State<CounterText> createState() => _CounterTextState();
}

class _CounterTextState extends State<CounterText> {
  @override
  void initState() {
    super.initState();
    // Mutate here, before the first build, not during it.
    context.read<ProductModel>().countAndTrack();
  }

  @override
  Widget build(BuildContext context) {
    // build only reads; it does not write.
    final count = context.watch<ProductModel>().count;
    return Text('Seen $count times');
  }
}
```

`context.read<T>()` obtém o modelo sem se inscrever, então é seguro no `initState`. `context.watch<T>()` se inscreve e é seguro no `build` porque só lê. A escrita acontece uma vez, antes do frame, e a leitura impulsiona as recompilações depois.

### 2. Adie a mutação com addPostFrameCallback

Use isto quando o gatilho estiver realmente fora do seu controle: um callback de terceiros, um evento de stream que chega no meio da compilação, ou um `LayoutBuilder` que precisa reagir a um tamanho medido no mesmo frame. `WidgetsBinding.instance.addPostFrameCallback` executa seu closure depois que o frame atual está totalmente compilado e pintado, então `setState` volta a ser legal.

```dart
// Flutter 3.44, Dart 3.x -- defer the rebuild to after this frame.
@override
Widget build(BuildContext context) {
  if (_needsRefresh) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return; // the widget may have been disposed
      setState(() => _needsRefresh = false);
    });
  }
  return Text(_label);
}
```

Duas proteções tornam isto seguro. A verificação `mounted` evita uma falha `setState after dispose` se o widget deixou a árvore antes de o callback executar. E o callback deve ser condicional (controlado por `_needsRefresh` aqui), ou você agenda uma nova recompilação a cada frame e queima a CPU em um loop infinito. `addPostFrameCallback` é um adiamento, não uma licença para recompilar a cada pintura.

### 3. Divida um notify síncrono em uma microtask

Se você é dono do notificador e um método legitimamente precisa notificar, mas você não pode garantir que ele nunca seja chamado durante a compilação, empurre a notificação para fora do caminho síncrono:

```dart
// Flutter 3.44, Dart 3.x -- notify after the current synchronous work unwinds.
int countAndTrack() {
  _count++;
  // scheduleMicrotask runs after the current build call stack returns,
  // but before the next frame -- so the UI updates without a frame of lag.
  scheduleMicrotask(notifyListeners);
  return _count;
}
```

Isto é um último recurso. Esconde o cheiro de design (um getter com efeito colateral) em vez de removê-lo, e microtasks ainda podem competir com a liberação. Prefira a solução 1.

## Pegadinhas e variantes

`setState() called after dispose()`. Asserção diferente, causa relacionada. Você chamou `setState` de um callback assíncrono (um `Future.then`, um `Timer`, um listener de stream) que se completou depois que o widget foi removido da árvore. Proteja cada `setState` assíncrono com `if (!mounted) return;`. Veja os padrões de liberação no [guia de liberação de controladores](/pt-br/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).

`setState` no `initState`. Chamar `setState` de forma síncrona no `initState` não é um erro, mas é inútil: a primeira compilação ainda não aconteceu, então o estado já vai ser lido de qualquer forma. Apenas atribua o campo diretamente. O Flutter não lança a exceção aqui, ao contrário do caso da fase de compilação.

`Navigator.push` a partir do `build`. Uma variante frequente deste erro. Se você quer navegar como efeito colateral do estado (digamos, redirecionar quando um usuário sai da sessão), faça isso em `addPostFrameCallback` ou, melhor, com um pacote de roteamento que modele os redirecionamentos de forma declarativa em vez de imperativa a partir do `build`.

`FutureBuilder` / `StreamBuilder` que recompila para sempre. Se o `future` ou o `stream` é criado dentro do `build`, cada recompilação cria um novo, que se completa, que chama `setState` internamente, que recompila. Crie o future ou o stream uma única vez no `initState` e guarde-o em um campo. Isto não é exatamente a mesma exceção, mas leva você ao mesmo território de "estou recompilando durante uma recompilação" e é uma causa comum de [jank no Flutter que você pode detectar no DevTools](/pt-br/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/).

Usuários de Riverpod. Ler um provider com `ref.watch` dentro de um callback que executa durante a compilação, e então escrever nele na mesma passada síncrona, esbarra na mesma parede. O `AsyncValue` do Riverpod mais um `Notifier` mantêm a leitura e a escrita em caminhos separados; veja [estados de carregamento e erro com AsyncValue](/pt-br/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) para o padrão.

O ponto mais profundo: o `build` é chamado com frequência, de forma imprevisível e possivelmente muitas vezes por frame. Qualquer coisa que você coloque ali executa segundo o cronograma do Flutter, não o seu. Leituras estão ok porque são idempotentes. Escritas não, porque mudam o que a próxima leitura retorna, e o Flutter não tem um lugar seguro para absorver essa mudança no meio da compilação. Mantenha o `build` puro e o erro desaparece para sempre. A mesma disciplina torna bugs não relacionados como [o estouro do RenderFlex](/pt-br/2026/05/fix-renderflex-overflowed-in-flutter/) mais fáceis de raciocinar, porque seu layout é uma função limpa do estado em vez de um alvo móvel. Se seu widget realmente precisa reagir a dados assíncronos, modele esses dados como estado e deixe [o tratamento elegante de erros e carregamento](/pt-br/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) impulsionar as recompilações por você.

## Fontes

- [State.setState API docs](https://api.flutter.dev/flutter/widgets/State/setState.html) -- o contrato de quando setState é legal.
- [State.build API docs](https://api.flutter.dev/flutter/widgets/State/build.html) -- "build should be a pure function of the widget's configuration and the State."
- [WidgetsBinding.addPostFrameCallback API docs](https://api.flutter.dev/flutter/scheduler/SchedulerBinding/addPostFrameCallback.html) -- agendar trabalho depois do frame atual.
- [ChangeNotifier.notifyListeners API docs](https://api.flutter.dev/flutter/foundation/ChangeNotifier/notifyListeners.html) -- quando os listeners são chamados de forma síncrona.
