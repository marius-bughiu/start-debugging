---
title: "Como fazer o AnimatedSwitcher animar quando o tipo do widget filho não muda no Flutter"
description: "O AnimatedSwitcher só faz a transição quando Widget.canUpdate indica que o novo filho é outro widget, então de Text para Text sem key ele apenas atualiza no lugar. Aqui estão a correção de uma linha, onde a key precisa ficar, por que UniqueKey é uma armadilha, o bug de direção do slide causado por um transitionBuilder estático e o salto de layout do Stack padrão, tudo verificado com testes de widget no Flutter 3.44.8."
pubDate: 2026-10-19
template: how-to
tags:
  - "flutter"
  - "dart"
  - "animation"
  - "how-to"
lang: "pt-br"
translationOf: "2026/10/how-to-make-animatedswitcher-animate-when-the-child-type-does-not-change"
translatedBy: "claude"
translationDate: 2026-10-19
---

**Resposta curta:** dê ao filho direto do `AnimatedSwitcher` uma key que mude sempre que o conteúdo mudar, normalmente uma `ValueKey` construída a partir dos dados exibidos: `Text('$count', key: ValueKey<int>(count))`. O `AnimatedSwitcher` decide se executa uma transição com `Widget.canUpdate`, que compara apenas `runtimeType` e `key`. Dois widgets `Text` sem key são "o mesmo widget" do ponto de vista do framework, então o antigo é atualizado no lugar e nada anima. Tudo abaixo foi verificado com testes de widget no Flutter 3.44.8 (Dart 3.12.2), e o código-fonte de `_AnimatedSwitcherState` é idêntico byte a byte no branch `stable` atual.

O restante deste post mostra a linha exata do framework que causa isso, um exemplo mínimo com a saída dos testes, onde a key deve ficar (uma key um nível abaixo não faz nada), por que `UniqueKey` é a correção errada e três armadilhas que aparecem logo depois que a transição funciona: transições de slide que se movem na direção errada, conteúdo que salta para o centro e filhos que perdem o estado.

## A única comparação que o AnimatedSwitcher faz

O `AnimatedSwitcher` é um `StatefulWidget` que mantém uma "entrada atual" (o filho mais o seu próprio `AnimationController`) e um conjunto de entradas de saída que ainda estão desaparecendo. Quando o pai o reconstrói com um novo `child`, o `didUpdateWidget` executa esta verificação, direto de `packages/flutter/lib/src/widgets/animated_switcher.dart`:

```dart
// Flutter 3.44.8, _AnimatedSwitcherState.didUpdateWidget
final hasNewChild = widget.child != null;
final hasOldChild = _currentEntry != null;
if (hasNewChild != hasOldChild ||
    hasNewChild && !Widget.canUpdate(widget.child!, _currentEntry!.widgetChild)) {
  // Child has changed, fade current entry out and add new entry.
  _childNumber += 1;
  _addEntryForNewChild(animate: true);
} else if (_currentEntry != null) {
  // Child has been updated. ... keep the key from the previous transition
  // so that we update the transition instead of replacing it.
  _currentEntry!.widgetChild = widget.child!;
  _updateTransitionForEntry(_currentEntry!);
}
```

E `Widget.canUpdate` tem uma única linha:

```dart
// Flutter 3.44.8, framework.dart
static bool canUpdate(Widget oldWidget, Widget newWidget) {
  return oldWidget.runtimeType == newWidget.runtimeType && oldWidget.key == newWidget.key;
}
```

Repare no que não é comparado: o texto, a cor, a URL da imagem, nenhum campo. Uma transição começa em exatamente três casos: o filho vai de `null` para não nulo, vai de não nulo para `null`, ou o novo filho tem um tipo de runtime diferente ou uma key diferente. Se você passa de `Text('1')` para `Text('2')`, nenhum desses casos ocorre, então o ramo `else` coloca o widget na entrada existente e o usuário vê uma mudança instantânea. A documentação da API diz isso claramente, mas o sintoma ("meu AnimatedSwitcher não faz nada") raramente leva as pessoas a procurar ali. Se você quer a teoria geral por trás dessa comparação, expliquei em [o que é uma Key do Flutter e quando omiti-la causa bugs](/pt-br/2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs/).

## Um exemplo mínimo que você pode executar como teste

A forma mais rápida de ver se uma transição está em execução é contar os widgets `FadeTransition` no meio da animação. O `transitionBuilder` padrão envolve cada entrada, de entrada e de saída, em um `FadeTransition`, então um significa "sem transição" e dois significa "cross-fade em andamento".

```dart
// Flutter 3.44.8, Dart 3.12.2 -- test/switcher_test.dart
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget host(Widget child) => Directionality(
      textDirection: TextDirection.ltr,
      child: AnimatedSwitcher(
        duration: const Duration(milliseconds: 300),
        child: child,
      ),
    );

int fades(WidgetTester t) => find.byType(FadeTransition).evaluate().length;

void main() {
  testWidgets('no key: same type is updated in place', (t) async {
    await t.pumpWidget(host(const Text('1')));
    await t.pumpWidget(host(const Text('2')));
    await t.pump(const Duration(milliseconds: 100));
    print('no key -> ${fades(t)}'); // no key -> 1
  });

  testWidgets('ValueKey on the direct child animates', (t) async {
    await t.pumpWidget(host(const Text('1', key: ValueKey(1))));
    await t.pumpWidget(host(const Text('2', key: ValueKey(2))));
    await t.pump(const Duration(milliseconds: 100));
    print('ValueKey -> ${fades(t)}'); // ValueKey -> 2
    await t.pumpAndSettle();
    print('settled -> ${fades(t)}'); // settled -> 1
  });
}
```

Sem key há um `FadeTransition` aos 100 ms de uma animação de 300 ms, o que significa que não existe animação. Com `ValueKey` há dois, e depois de `pumpAndSettle` a entrada de saída foi descartada e removida.

## Corrigindo em um widget real

Aqui está a mesma correção em um widget de app. A key vai no widget que você passa como `child`, e é derivada do valor que deve disparar a transição:

```dart
// Flutter 3.44.8, Dart 3.12.2
class Counter extends StatefulWidget {
  const Counter({super.key});
  @override
  State<Counter> createState() => _CounterState();
}

class _CounterState extends State<Counter> {
  int _count = 0;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        AnimatedSwitcher(
          duration: const Duration(milliseconds: 250),
          transitionBuilder: (child, animation) =>
              ScaleTransition(scale: animation, child: child),
          child: Text(
            '$_count',
            key: ValueKey<int>(_count), // the whole fix
            style: Theme.of(context).textTheme.displayMedium,
          ),
        ),
        FilledButton(
          onPressed: () => setState(() => _count++),
          child: const Text('Increment'),
        ),
      ],
    );
  }
}
```

O mesmo padrão cobre todos os casos de "mesmo tipo, conteúdo diferente" que as pessoas encontram:

- Trocar imagens: `Image.network(url, key: ValueKey(url))`.
- Trocar ícones: `Icon(isPlaying ? Icons.pause : Icons.play_arrow, key: ValueKey(isPlaying))`.
- Alternar entre estados de um modelo: `key: ValueKey(user.id)` em um card de perfil, para que editar o mesmo usuário não anime, mas selecionar outro usuário anime.
- Ramos de carregamento, erro e dados que por acaso retornam o mesmo tipo de widget (por exemplo três widgets `Center`): dê a eles `ValueKey('loading')`, `ValueKey('error')`, `ValueKey('data')`. Se o seu estado assíncrono vem do Riverpod, isso combina naturalmente com [exibir estados de carregamento e erro com AsyncValue](/pt-br/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/).

Escolher o que entra na key é escolher quando a animação dispara. Uma key construída a partir de `count` anima a cada incremento. Uma key construída a partir de `count ~/ 10` anima apenas quando o dígito das dezenas muda, enquanto o texto interno continua sendo atualizado no lugar.

## A key precisa estar no filho direto

O `canUpdate` olha somente para `widget.child`, o widget que você entrega diretamente ao `AnimatedSwitcher`. Uma key em algo aninhado dentro dele é invisível para essa comparação:

```dart
// Flutter 3.44.8 -- does NOT animate
AnimatedSwitcher(
  duration: const Duration(milliseconds: 300),
  child: Padding(
    padding: const EdgeInsets.all(8),
    child: Text('$_count', key: ValueKey<int>(_count)), // too deep
  ),
)
```

No meu teste isso produziu um `FadeTransition` no meio da animação, o mesmo que sem nenhuma key. O `Padding` externo não tem key e é do mesmo tipo todas as vezes, então o switcher o atualiza no lugar, e o `Text` interno recebe um novo elemento por conta própria, sem nenhuma transição. Mova a key para o `Padding` (ou para o widget de nível mais alto que você tiver, geralmente um `Container`, `Card` ou o seu próprio `StatelessWidget`) e funciona.

Isso também pega quando o filho é a sua própria classe de widget:

```dart
// Flutter 3.44.8
AnimatedSwitcher(
  duration: const Duration(milliseconds: 300),
  child: StatusBadge(status: status, key: ValueKey(status)),
)
```

Passar `key` por `super.key` no construtor de `StatusBadge` é suficiente. Colocar uma key em algo dentro de `StatusBadge.build` não é.

## Por que UniqueKey é a correção errada

A primeira resposta que muita gente encontra é `key: UniqueKey()`. Ela de fato faz o switcher animar, mas anima a cada reconstrução do pai, não apenas quando o conteúdo muda:

```dart
// Flutter 3.44.8, Dart 3.12.2
testWidgets('UniqueKey animates on every rebuild', (t) async {
  await t.pumpWidget(host(Text('1', key: UniqueKey())));
  await t.pumpWidget(host(Text('1', key: UniqueKey()))); // same text
  await t.pump(const Duration(milliseconds: 100));
  print(fades(t)); // 2
});
```

Mesmo texto, um cross-fade completo. Em uma tela real o pai é reconstruído por motivos não relacionados ao conteúdo trocado: uma mudança de `MediaQuery` quando o teclado abre, uma mudança de tema, um `setState` não relacionado, um provider notificando. Cada um deles reinicia a transição e descarta o elemento e o estado do filho. O erro oposto é uma key constante, como `ValueKey('label')` em um `Text` cuja string muda. Essa key nunca muda, então `canUpdate` é verdadeiro e nada anima. Meu teste confirmou um `FadeTransition` e o novo texto exibido instantaneamente. Derive a key dos dados, sempre.

## Trocas rápidas e filhos nulos

Dois comportamentos que vale conhecer para não confundi-los com bugs:

1. Se o filho muda de novo antes de a transição anterior terminar, o switcher não cancela nada. A entrada atual é movida para o conjunto de saída e revertida, então vários filhos podem estar desaparecendo ao mesmo tempo. Alternar de 1 para 2 e para 3 em menos de 100 ms deixou três widgets `FadeTransition` na árvore. É também por isso que a mesma key pode voltar com segurança: cada transição é envolvida em um `KeyedSubtree` com key de um contador interno (`_childNumber`), então um novo filho com key `A` nunca é confundido com um filho de saída que também tinha a key `A`.
2. Definir `child: null` é uma forma válida de animar a saída do conteúdo. `hasNewChild != hasOldChild` dispara a transição, o filho antigo desaparece e nada aparece no lugar.

## Armadilha: transições de slide que vão para o lado errado

Depois que o cross-fade funciona, o próximo pedido costuma ser um slide horizontal: o novo valor entra deslizando pela direita, o antigo sai pela esquerda. A versão ingênua desliza ambos os filhos de e para a direita, porque o controller do filho de saída simplesmente roda ao contrário sobre o mesmo tween. O truque padrão é verificar no `transitionBuilder` se o filho sendo envolvido é o atual:

```dart
// Flutter 3.44.8, Dart 3.12.2
Widget _slide(Widget child, Animation<double> animation) {
  final incoming = child.key == ValueKey<int>(_count);
  final offset = Tween<Offset>(
    begin: Offset(incoming ? 1 : -1, 0),
    end: Offset.zero,
  ).animate(animation);
  return ClipRect(child: SlideTransition(position: offset, child: child));
}
```

Aqui está a parte sutil. O `AnimatedSwitcher` só executa novamente o `transitionBuilder` para as entradas de saída quando `widget.transitionBuilder != oldWidget.transitionBuilder`. Um literal de função escrito inline em `build`, como `transitionBuilder: (c, a) => _slide(c, a)`, cria um novo objeto closure a cada build, então a comparação é verdadeira, toda entrada é reconstruída com o `_count` mais recente e o filho antigo é corretamente marcado como de saída. Um tear-off de método como `transitionBuilder: _slide`, ou um builder guardado em um campo, pode ser igual entre builds, então a entrada de saída mantém a transição com a qual foi construída quando era de entrada. Executei as duas variantes e li os offsets do `SlideTransition` na metade da animação:

```text
inline closure:   child 1 dx=-0.50   child 2 dx=0.50
stored function:  child 1 dx= 0.50   child 2 dx=0.50
```

Com a função guardada, o filho antigo desliza de volta para a direita, por cima do novo. Se você escrever um `transitionBuilder` sensível à direção, passe-o como uma closure inline (ou garanta de outra forma que ele seja um novo objeto sempre que a key mudar) e adicione um teste como o acima para que uma refatoração para um tear-off não quebre isso silenciosamente.

## Armadilha: o conteúdo salta para o centro ou o tamanho dá um salto

O `layoutBuilder` padrão coloca os filhos de saída e o filho atual em um `Stack` com `alignment: Alignment.center`. Dois efeitos colaterais visíveis:

- Conteúdo alinhado à esquerda, por exemplo um rótulo em um `Row` ou o subtítulo de um `ListTile`, salta para o centro enquanto a transição executa.
- O `Stack` tem o tamanho do maior filho, então quando uma string longa é substituída por uma curta, o espaço só encolhe depois que o filho antigo desaparece.

Ambos se resolvem com um `layoutBuilder` personalizado, opcionalmente envolvido em `AnimatedSize` para suavizar a mudança de tamanho:

```dart
// Flutter 3.44.8, Dart 3.12.2
AnimatedSize(
  duration: const Duration(milliseconds: 200),
  alignment: Alignment.centerLeft,
  child: AnimatedSwitcher(
    duration: const Duration(milliseconds: 200),
    layoutBuilder: (currentChild, previousChildren) => Stack(
      alignment: Alignment.centerLeft,
      children: [
        ...previousChildren,
        if (currentChild != null) currentChild,
      ],
    ),
    child: Text(status, key: ValueKey(status)),
  ),
)
```

Mantenha `previousChildren` antes de `currentChild` para que o widget de entrada seja pintado por cima, como no padrão.

## Armadilha: o estado do filho é descartado

Uma key alterada significa um novo elemento. Qualquer `State` abaixo do filho trocado, como o controller de um `TextField` criado em `initState`, uma posição de rolagem ou um flag de expansão, é criado do zero para o filho de entrada. No meu teste, o elemento antes e depois de uma mudança de key era um objeto diferente. Em geral é isso que você quer para "mostrar outra coisa", mas é a ferramenta errada para "animar uma propriedade da mesma coisa". Se o usuário está digitando em um campo e você usa o texto como key, cada tecla recria o campo e perde o foco.

Para mudanças de propriedade no mesmo widget, use uma animação implícita: `AnimatedDefaultTextStyle`, `AnimatedContainer`, `AnimatedOpacity` ou `TweenAnimationBuilder` para um valor arbitrário. Elas mantêm o elemento e interpolam a propriedade. O `AnimatedSwitcher` serve para substituir conteúdo, e a key é como você avisa que o conteúdo foi substituído. Se você precisa que a transição atravesse telas em vez de acontecer dentro de uma, veja [uma animação Hero entre duas telas](/pt-br/2026/07/how-to-add-a-hero-animation-between-two-screens-in-flutter/) ou [transições de página personalizadas](/pt-br/2026/10/migrate-custom-page-transitions-after-the-flutter-page-transition-builders-reorganization/).

## Checklist quando o AnimatedSwitcher não faz nada

1. Coloque uma key no widget passado diretamente como `child`, não em algo dentro dele.
2. Derive a key dos dados que devem disparar a transição, normalmente `ValueKey(value)`, nunca `UniqueKey()` criada em `build`.
3. Verifique se a key realmente muda: uma `ValueKey('x')` constante equivale a nenhuma key para este fim.
4. Certifique-se de que o próprio `AnimatedSwitcher` não é recriado: se um ancestral muda de tipo ou de key, o estado do switcher é reconstruído do zero e o primeiro filho é exibido sem animação (`initState` chama `_addEntryForNewChild(animate: false)`).
5. Se você usa um `transitionBuilder` sensível à direção, passe-o como closure inline para que as entradas de saída sejam reconstruídas.
6. Corrija alinhamento e tamanho com um `layoutBuilder` personalizado e `AnimatedSize`.

### Leia a seguir

- [O que é uma Key do Flutter e quando omiti-la causa bugs?](/pt-br/2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs/)
- [Como exibir estados de carregamento e erro com AsyncValue no Flutter Riverpod](/pt-br/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)
- [Como adicionar uma animação Hero entre duas telas no Flutter](/pt-br/2026/07/how-to-add-a-hero-animation-between-two-screens-in-flutter/)
- [Migre transições de página personalizadas após a reorganização dos page transition builders do Flutter](/pt-br/2026/10/migrate-custom-page-transitions-after-the-flutter-page-transition-builders-reorganization/)
- [Correção: setState() ou markNeedsBuild() chamado durante o build no Flutter](/pt-br/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/)

## Fontes

- [Classe AnimatedSwitcher, documentação da API do Flutter](https://api.flutter.dev/flutter/widgets/AnimatedSwitcher-class.html)
- [AnimatedSwitcher.layoutBuilder, documentação da API do Flutter](https://api.flutter.dev/flutter/widgets/AnimatedSwitcher/layoutBuilder.html)
- [Widget.canUpdate, documentação da API do Flutter](https://api.flutter.dev/flutter/widgets/Widget/canUpdate.html)
- [animated_switcher.dart no branch stable, flutter/flutter](https://github.com/flutter/flutter/blob/stable/packages/flutter/lib/src/widgets/animated_switcher.dart)
- [Animações implícitas, documentação do Flutter](https://docs.flutter.dev/codelabs/implicit-animations)
