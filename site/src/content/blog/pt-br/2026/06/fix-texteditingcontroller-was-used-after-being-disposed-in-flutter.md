---
title: "Correção: A TextEditingController was used after being disposed no Flutter"
description: "Esse erro significa que o código usou um controller depois que dispose() rodou. Proteja callbacks assíncronas com uma checagem de mounted e nunca libere um controller que não é seu."
pubDate: 2026-06-03
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
lang: "pt-br"
translationOf: "2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-03
---

Algo leu ou escreveu em um `TextEditingController` depois que o `dispose()` dele já tinha rodado. O culpado de sempre é uma callback assíncrona (um `Future.then`, um `await`, um `Timer` ou um listener de stream) que completa depois que o usuário saiu da tela e o `State` foi destruído. Proteja o código posterior ao await com `if (!mounted) return;` antes de tocar no controller. A outra causa comum é confusão de propriedade: um widget filho liberou um controller que recebeu mas que não é dele. Este guia usa Flutter 3.44 (estável, maio de 2026) e Dart 3.x.

O erro não é específico do `TextEditingController`. A mesma mensagem aparece para qualquer `ChangeNotifier` (`ScrollController`, `FocusNode`, `AnimationController`, `ValueNotifier`, o modelo de um Provider) porque a asserção mora no próprio `ChangeNotifier`. O tipo em tempo de execução na mensagem só te diz qual deles você acessou tarde demais.

## O erro em contexto

A mensagem completa que o Flutter lança fica assim:

```
A TextEditingController was used after being disposed.
Once you have called dispose() on a TextEditingController, it can no longer be used.

When the exception was thrown, this was the stack:
#0      ChangeNotifier._debugAssertNotDisposed.<anonymous closure> (package:flutter/src/foundation/change_notifier.dart)
#1      ChangeNotifier._debugAssertNotDisposed (package:flutter/src/foundation/change_notifier.dart)
#2      ChangeNotifier.addListener (package:flutter/src/foundation/change_notifier.dart)
#3      TextEditingController.text= (package:flutter/src/widgets/editable_text.dart)
...
```

O frame da pilha logo abaixo dos frames do `ChangeNotifier` é a linha no seu código. Ele nomeia a operação que tocou no controller morto: `text=`, `.text`, `addListener`, `clear()` ou `.selection`. Esse frame é onde você corrige, mas a razão de ter disparado está mais cedo no tempo, quando `dispose()` rodou antes daquela linha.

## Por que isso acontece

Há quatro causas, em ordem aproximada de frequência.

Uma callback assíncrona sobreviveu ao widget. Você iniciou um `await`, um `Future.then`, um `Timer` ou um `stream.listen` enquanto a tela estava viva, o usuário navegou para fora (o que libera o `State` e o controller) e então a callback completou e tocou no controller. Essa é de longe a causa mais comum, porque só quebra quando o timing coincide: passa sempre que a resposta é rápida e quebra quando o usuário é rápido ou a rede é lenta.

Um filho liberou um controller que não é dele. Um pai criou o controller e o passou para baixo; o filho chamou `dispose()` nele no próprio `dispose()`. Agora o pai (ou um irmão, ou o próximo rebuild) usa um controller que o filho já matou. A propriedade é o inverso do problema do vazamento: libere um controller que não é seu e você obtém esse erro, esqueça de liberar um que é seu e você obtém um vazamento de memória.

Uma camada de gerenciamento de estado o liberou. Se o controller mora em um provider `autoDispose` do Riverpod, em um controller do GetX ou em um `ChangeNotifier` que o framework destruiu, o widget que ainda mantém uma referência vai bater em uma instância liberada. O `autoDispose` do Riverpod é um gatilho frequente: o provider é recalculado ou liberado quando ninguém mais o observa, levando o controller junto, enquanto uma closure obsoleta ainda aponta para o antigo.

`didUpdateWidget` liberou o antigo cedo demais. Quando um controller depende de uma propriedade de `widget`, você libera o controller antigo e cria um novo na atualização. Se uma callback pendente capturou o controller antigo, ela agora toca em uma instância liberada.

O contrato subjacente, segundo a [documentação da API ChangeNotifier do Flutter](https://api.flutter.dev/flutter/foundation/ChangeNotifier-class.html): depois que `dispose()` é chamado, o objeto fica inutilizável e qualquer uso posterior lança em builds de depuração. A asserção é removida das builds de release, então em release o mesmo código não quebra mas lê estado obsoleto ou nulo. É por isso que você corrige a causa, não silencia a asserção.

## Uma reprodução mínima

Este widget quebra quando você sai da tela antes do fetch retornar. Ele compila e roda, e passa quando a rede é rápida.

```dart
// Flutter 3.44, Dart 3.x -- throws "A TextEditingController was used after being disposed".
import 'package:flutter/material.dart';

class SearchBox extends StatefulWidget {
  const SearchBox({super.key});

  @override
  State<SearchBox> createState() => _SearchBoxState();
}

class _SearchBoxState extends State<SearchBox> {
  final _controller = TextEditingController();

  @override
  void initState() {
    super.initState();
    _prefill();
  }

  Future<void> _prefill() async {
    // Pretend this hits the network and takes ~500ms.
    final lastQuery = await Future.delayed(
      const Duration(milliseconds: 500),
      () => 'flutter dispose error',
    );
    // If the user popped this screen during those 500ms, the State and the
    // controller are already disposed. This line then throws.
    _controller.text = lastQuery;
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return TextField(controller: _controller);
  }
}
```

Abra esta tela e então feche-a em menos de meio segundo. `dispose()` roda, `_controller.dispose()` mata o controller, o `Future` completa e `_controller.text = ...` lança. O erro depende do timing, que é exatamente por que ele sobrevive à revisão de código e vai para produção.

## A correção, em detalhe

As correções estão ordenadas pelo quanto eu as recomendo. Escolha a que combina com a sua causa.

### 1. Proteja callbacks assíncronas com mounted (recomendado)

Em todo lugar onde um `await` (ou qualquer callback adiada) é seguido por código que toca no controller ou chama `setState`, cheque `mounted` primeiro. `mounted` é `false` assim que o `State` foi liberado, então a proteção faz um curto-circuito antes de o controller ser tocado.

```dart
// Flutter 3.44, Dart 3.x -- correct: bail out if the widget is gone.
Future<void> _prefill() async {
  final lastQuery = await Future.delayed(
    const Duration(milliseconds: 500),
    () => 'flutter dispose error',
  );
  if (!mounted) return; // the State (and the controller) may be disposed
  _controller.text = lastQuery;
}
```

A regra: depois de cada `await` em um método de `State`, a próxima linha que toca em `this`, no controller ou em `setState` deve ser precedida por uma checagem de `mounted`. Aqui há um `await`, então há uma proteção. Se um método tem dois awaits e toca no controller depois de cada um, ele precisa de duas proteções. O lint `use_build_context_synchronously` do analisador do Dart pega a versão de `BuildContext` desse erro; trate um controller exatamente do mesmo jeito.

Para um `Timer` ou um `stream.listen`, a proteção vai dentro da callback:

```dart
// Flutter 3.44, Dart 3.x
_sub = someStream.listen((value) {
  if (!mounted) return;
  _controller.text = value;
});
```

Melhor ainda, cancele a inscrição ou o timer em `dispose()` para que a callback nunca dispare após a destruição. Cancelar é mais limpo do que proteger, porque uma inscrição protegida mas não cancelada ainda acorda, aloca memória e roda a proteção a cada evento de uma tela que o usuário já abandonou. Veja a ordem de liberação no [guia sobre liberação de controllers](/pt-br/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).

### 2. Corrija a propriedade: não libere o que não é seu

Se o erro não é assíncrono, quase sempre é de propriedade. A regra é uma linha: quem cria o controller o libera, e mais ninguém. Um widget que recebe um controller pelo construtor nunca deve liberá-lo.

```dart
// Flutter 3.44, Dart 3.x
class ParentForm extends StatefulWidget {
  const ParentForm({super.key});
  @override
  State<ParentForm> createState() => _ParentFormState();
}

class _ParentFormState extends State<ParentForm> {
  final _email = TextEditingController(); // parent creates -> parent owns

  @override
  void dispose() {
    _email.dispose(); // owner disposes, exactly once
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => EmailField(controller: _email);
}

class EmailField extends StatelessWidget {
  final TextEditingController controller;
  const EmailField({super.key, required this.controller});

  // Receives the controller. Does NOT dispose it. No dispose() here at all.
  @override
  Widget build(BuildContext context) => TextField(controller: controller);
}
```

Se `EmailField` fosse um `StatefulWidget` e liberasse `widget.controller`, o uso posterior de `_email` pelo pai lançaria esse mesmo erro. A correção é apagar essa chamada a `dispose()` do filho. O erro espelhado (o pai esquecendo de liberar) é um vazamento, coberto no guia de liberação acima.

### 3. Deixe a camada de gerenciamento de estado ser dona da liberação

Quando um controller é içado para um provider do Riverpod, um controller do GetX ou qualquer objeto fora do widget, a liberação se move com ele. O widget não deve liberar um controller que pegou emprestado de um provider, e o `onDispose` (Riverpod) ou o `onClose` (GetX) do provider é onde a chamada a `dispose()` mora agora. Com `autoDispose` do Riverpod, mantenha o provider vivo enquanto a tela precisar dele (use `ref.keepAlive()` ou um provider sem `autoDispose`) para que ele não seja recalculado por baixo de um widget que ainda mantém o controller. Mover a propriedade do ciclo de vida durante uma migração de gerenciamento de estado é exatamente onde isso quebra em silêncio; escrevi [migrar um app Flutter de GetX para Riverpod](/pt-br/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) como um movimento deliberado e passo a passo por essa razão.

### 4. Recrie com cuidado em didUpdateWidget

Se um controller depende de uma propriedade de `widget` e você o troca em `didUpdateWidget`, libere o antigo e atribua um novo, e garanta que nenhuma callback pendente ainda referencie a instância antiga:

```dart
// Flutter 3.44, Dart 3.x
@override
void didUpdateWidget(covariant MyField oldWidget) {
  super.didUpdateWidget(oldWidget);
  if (oldWidget.initialText != widget.initialText) {
    _controller.dispose();
    _controller = TextEditingController(text: widget.initialText);
  }
}
```

Qualquer trabalho assíncrono iniciado contra o controller antigo deve checar `mounted` (e idealmente ser cancelado) antes de aterrissar, ou vai escrever na instância liberada que você acabou de substituir.

## Detalhes que mordem e variantes

`setState() called after dispose()`. A mesma causa raiz, uma asserção diferente. Uma callback assíncrona que chama `setState` após a destruição lança isso em vez da mensagem do controller, porque `setState` checa internamente um estado equivalente a `mounted`. A correção é idêntica: proteja com `if (!mounted) return;`. Costuma viajar junto com o erro do controller, já que a mesma callback geralmente escreve no controller e chama `setState`. Veja [setState ou markNeedsBuild chamado durante build](/pt-br/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) para o primo da fase de build dessa família.

`A ScrollController was used after being disposed`, `A FocusNode was used after being disposed`, `An AnimationController was used after being disposed`. A mesma asserção, as mesmas correções. A mensagem nomeia qual `ChangeNotifier` você tocou; o diagnóstico (assíncrono após dispose ou dono errado) não muda.

O erro só acontece às vezes. Essa é a assinatura da causa assíncrona, não um framework instável. Uma rede rápida o esconde; uma rede lenta ou um usuário rápido o expõem. Não descarte uma versão intermitente desse erro como ruído. Reproduza-o adicionando um atraso artificial antes da escrita no controller e fechando a tela durante o atraso.

Ele lança nos testes mas não no app. Os widget tests destroem os widgets de forma agressiva e avançam os frames de maneira determinística, então uma proteção de `mounted` faltante que se esconde em um app real aparece imediatamente sob `testWidgets`. Isso é o teste fazendo o seu trabalho. O time do Flutter rastreia uma variante disso na [issue 98965 do flutter/flutter](https://github.com/flutter/flutter/issues/98965), onde timers pendentes nos testes tocam controllers liberados; a correção lá também é cancelar o timer em `dispose()`.

Reusar um controller entre dois `TextField` em rotas diferentes. Um controller é de um único dono. Se você guarda um `TextEditingController` em um singleton de vida longa e o passa para um campo na tela A e outro na tela B, liberar uma tela libera o controller por baixo da outra. Dê a cada campo o seu próprio controller, ou mova o texto para um estado compartilhado e deixe cada campo ser dono de um controller local.

A única disciplina que elimina toda essa classe de bug: um controller tem exatamente um dono, esse dono o libera exatamente uma vez, e todo caminho assíncrono que o toca está protegido por uma checagem de `mounted` ou cancelado antes da destruição. Integre isso no seu reflexo de `dispose()` e o erro para de aparecer. Se você também quer pegar a falha oposta (controllers que nunca são liberados), o [fluxo do leak_tracker no guia de liberação](/pt-br/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) vai te fazer cumprir os dois lados do contrato, e modelar seus dados assíncronos como estado com [estados de carregamento e erro elegantes](/pt-br/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) mantém as perigosas escritas pós-await fora do controller por completo.

## Relacionados

- [Como liberar controllers no Flutter para evitar vazamentos de memória](/pt-br/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) é a imagem espelhada: esse erro é usar um controller liberado, aquele guia é esquecer de liberar um.
- [Correção: setState() ou markNeedsBuild() chamado durante build no Flutter](/pt-br/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) compartilha a correção da proteção de `mounted` para callbacks assíncronas.
- [Como tratar erros de rede com elegância em um app Flutter](/pt-br/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) é de onde costuma vir a lentidão de resposta que dispara esse erro.
- [Como mostrar estados de carregamento e erro com AsyncValue no Flutter Riverpod](/pt-br/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) mantém os resultados assíncronos no estado em vez de escrevê-los direto em um controller após um await.

## Fontes

- [ChangeNotifier, referência da API do Flutter](https://api.flutter.dev/flutter/foundation/ChangeNotifier-class.html) -- onde a asserção "used after being disposed" é definida.
- [TextEditingController, referência da API do Flutter](https://api.flutter.dev/flutter/widgets/TextEditingController-class.html) -- o ciclo de vida do controller e o contrato de `dispose()`.
- [State.mounted, referência da API do Flutter](https://api.flutter.dev/flutter/widgets/State/mounted.html) -- o flag que diz se o controller ainda está vivo.
- [Issue 98965 do flutter/flutter](https://github.com/flutter/flutter/issues/98965) -- o erro aparecendo em widget tests por causa de timers pendentes.
