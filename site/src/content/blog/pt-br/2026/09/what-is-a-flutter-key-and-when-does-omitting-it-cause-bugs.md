---
title: "O que é uma Key no Flutter e quando omiti-la causa bugs?"
description: "Uma Key é a metade de identidade de Widget.canUpdate, a única linha do framework que decide se um Element e seu State são reaproveitados ou descartados. Aqui está o que isso significa na prática, as edições de lista que corrompem o estado sem keys, qual tipo de key usar e onde a key precisa ficar para funcionar."
pubDate: 2026-09-04
tags:
  - "flutter"
  - "dart"
  - "state-management"
  - "listview"
lang: "pt-br"
translationOf: "2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs"
translatedBy: "claude"
translationDate: 2026-09-04
---

Uma `Key` é a metade de identidade da única comparação que o Flutter usa para decidir se um `Element` existente (e o `State` pendurado nele) pode ser reaproveitado para um `Widget` novo. Essa comparação é `oldWidget.runtimeType == newWidget.runtimeType && oldWidget.key == newWidget.key`. Sem key, filhos do mesmo tipo são pareados puramente por posição na lista de filhos, então qualquer edição que mova um item (uma reordenação, uma remoção no meio, um filtro) deixa o estado grudado no slot antigo enquanto os dados escorregam para outro. Você precisa de uma key exatamente quando um widget com estado pode mudar de posição entre seus irmãos. Tudo abaixo aponta para o canal stable atual, Flutter 3.47.2 com Dart 3.13.2, mas as regras de reconciliação não mudam desde o Flutter 1.

## Keys são uma entrada de canUpdate, e nada mais

O framework mantém três árvores paralelas: sua configuração imutável de `Widget`, a árvore de `Element` que persiste entre rebuilds, e a árvore de `RenderObject` que faz layout e pinta. Objetos `State` pertencem aos elements, não aos widgets. Quando um pai faz rebuild, cada posição de filho é resolvida por `Element.updateChild`, que faz uma única pergunta:

```dart
// package:flutter/src/widgets/framework.dart, Flutter 3.47.2
static bool canUpdate(Widget oldWidget, Widget newWidget) {
  return oldWidget.runtimeType == newWidget.runtimeType &&
      oldWidget.key == newWidget.key;
}
```

Se isso retorna `true`, o element existente é mantido e reconfigurado: seu `State` sobrevive, `didUpdateWidget` roda, `initState` não. Se retorna `false`, o element antigo é desativado e um element totalmente novo é inflado, o que significa `dispose` na saída e `initState` na entrada. Se o widget novo é null, o filho é removido de vez.

Duas consequências saem direto dessa assinatura. Primeira: uma key null é um valor de key perfeitamente válido, e `null == null` é `true`, então dois widgets sem key do mesmo tipo sempre casam. Segunda: keys nunca são comparadas entre pais diferentes; elas só são consultadas entre os filhos de um mesmo element. A documentação diz isso sem rodeios: keys precisam ser únicas entre os elements que têm o mesmo pai.

## A passada de reconciliação que decide qual filho é qual

Ao contrário do que se costuma supor, o Flutter não roda um diff genérico de árvores. Cada element reconcilia sua própria lista de filhos com uma passada linear `O(N)` descrita no [Inside Flutter](https://docs.flutter.dev/resources/inside-flutter):

1. Percorre as duas listas de cima para baixo, pareando enquanto `runtimeType` e `key` combinarem.
2. Percorre as duas listas de baixo para cima, fazendo o mesmo.
3. O intervalo não pareado que sobrar no meio: coloca os filhos antigos em uma tabela hash indexada pela `key`, depois percorre o intervalo do meio novo e consulta cada um.
4. Filhos antigos sem correspondência são desmontados; widgets novos sem correspondência ganham elements novos.

O passo 3 é onde as keys ganham o salário. Um filho sem key não tem nada para colocar na tabela hash, então só pode ser pareado pelos percursos posicionais dos passos 1 e 2. É por isso que listas sem key sobrevivem a acréscimos no fim (o passo 1 pareia tudo e a cauda é nova) e quebram silenciosamente em qualquer outra coisa.

## A reprodução mínima: estado que fica para trás

Dois tiles, cada um escolhendo uma cor uma vez no seu próprio `State`, mais um botão que inverte a lista. Nada exótico aqui. Desde o Flutter 3.47 os widgets do Material vivem no pacote independente, então o import difere dos exemplos antigos; veja o passo a passo de como [migrar suas importações para material_ui](/pt-br/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/) se as suas ainda apontam para a cópia do SDK.

```dart
// Flutter 3.47.2, Dart 3.13.2
import 'dart:math';
import 'package:material_ui/material_ui.dart';

class ColorTile extends StatefulWidget {
  const ColorTile({super.key, required this.label});

  final String label;

  @override
  State<ColorTile> createState() => _ColorTileState();
}

class _ColorTileState extends State<ColorTile> {
  // Chosen once when the State is created, and never again.
  late final Color color = Color(0xFF000000 | Random().nextInt(0xFFFFFF));

  @override
  Widget build(BuildContext context) => Container(
        width: 120,
        height: 120,
        color: color,
        alignment: Alignment.center,
        child: Text(widget.label),
      );
}
```

```dart
// Flutter 3.47.2, Dart 3.13.2
class _TileSwapperState extends State<TileSwapper> {
  List<String> labels = ['A', 'B'];

  @override
  Widget build(BuildContext context) => Column(
        children: [
          Row(
            // No keys.
            children: [for (final l in labels) ColorTile(label: l)],
          ),
          TextButton(
            onPressed: () => setState(() => labels = labels.reversed.toList()),
            child: const Text('Swap'),
          ),
        ],
      );
}
```

Aperte Swap e as letras trocam de lugar, mas as cores não se movem. O slot 0 tinha um `ColorTile` com key null, o novo slot 0 é um `ColorTile` com key null, `canUpdate` retorna `true`, então o element e seu `_ColorTileState` são reaproveitados e só `widget.label` muda. A cor é estado, e o estado ficou onde estava.

Adicionar uma identidade resolve:

```dart
// Flutter 3.47.2, Dart 3.13.2
children: [for (final l in labels) ColorTile(key: ValueKey(l), label: l)],
```

Agora os percursos posicionais falham nas duas pontas, os dois filhos caem no intervalo do meio, a tabela hash mapeia `ValueKey('A')` para o element que estava no slot 0, e esse element é reparentado para o slot 1 com a cor intacta.

## A versão desse bug que chega em produção

Uma cor aleatória é brinquedo. O mesmo mecanismo corrompe dados reais sempre que o estado mora dentro do widget de linha:

```dart
// Flutter 3.47.2, Dart 3.13.2
// Each row owns a TextEditingController in its State.
Column(
  children: [
    for (final task in tasks) TaskRow(task: task), // no key
  ],
)
```

Apague a tarefa no índice 0. A lista encolhe em um e todas as tarefas restantes sobem uma posição. A reconciliação pareia o slot antigo 0 com o slot novo 0, então o controller que segura a nota digitada pela metade da tarefa apagada agora está sentado na linha que renderiza a *próxima* tarefa. `didUpdateWidget` dispara com outro `widget.task`, mas o texto do controller, o deslocamento de rolagem, o checkbox, a flag de expandido, o focus node, nada disso deriva de `widget`, então nada disso se move. A pessoa usuária vê o texto dela contra o registro de outra, e quando ela salva você grava ali. O mesmo formato aparece com expansion tiles mantendo o painel errado aberto, animações reiniciando na linha errada e erros de validação grudados em um campo que ninguém tocou. Controllers criados por linha também precisam da disciplina de ciclo de vida de sempre, que é um vazamento separado e igualmente comum: veja [como liberar controllers no Flutter](/pt-br/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).

`ValueKey(task.id)` no `TaskRow` resolve tudo isso de uma vez.

## Coloque a key no widget mais externo da lista

Keys são pareadas entre irmãos sob um mesmo pai. Se você envolve a linha, o invólucro é o irmão, então o invólucro é quem precisa da key:

```dart
// Wrong: Padding is unkeyed, so Paddings match positionally. The TaskRows
// inside then get compared slot-for-slot, their keys disagree, canUpdate
// returns false, and every row's State is destroyed and rebuilt.
for (final task in tasks)
  Padding(
    padding: const EdgeInsets.all(8),
    child: TaskRow(key: ValueKey(task.id), task: task),
  ),

// Right: the key sits on the widget that is directly a child of the list.
for (final task in tasks)
  Padding(
    key: ValueKey(task.id),
    padding: const EdgeInsets.all(8),
    child: TaskRow(task: task),
  ),
```

A versão errada é pior do que nenhuma key: em vez de atribuir o estado errado, ela joga o estado fora a cada reordenação, o que aparece como piscada, animações reiniciadas e campos de texto limpos.

A outra forma garantida de escrever uma key que não faz nada é `ValueKey(index)`. O índice *é* a identidade posicional que você já tinha, então usá-lo como key reproduz exatamente o comportamento sem key enquanto se parece com uma correção. Use como key algo que o item possua: um id de banco, um UUID, um slug.

## Qual tipo de key

| Tipo | Identidade | Use quando |
| ---- | -------- | ----------------- |
| `ValueKey<T>(v)` | `runtimeType` e `v ==` | O item tem um valor de domínio estável: id, slug, data ISO em texto. A escolha padrão. |
| `ObjectKey(o)` | `identical(o, other.value)` | O modelo sobrescreve `==` por valor (records, classes Freezed) mas duas instâncias iguais precisam continuar distintas. |
| `UniqueKey()` | Igual apenas a si mesma | Você quer forçar uma subárvore nova, uma vez. Nunca construa uma dentro de `build`; uma instância nova a cada frame significa `canUpdate` false a cada frame e a subárvore reconstruída do zero para sempre. |
| `PageStorageKey<T>(v)` | Uma `ValueKey` que também nomeia um slot no `PageStorage` que a envolve | Preservar o deslocamento de rolagem entre um push de rota ou uma troca de aba, onde o próprio element é destruído. |
| `GlobalKey` | Única no app inteiro; expõe `currentState`, `currentContext`, `currentWidget` | Mover uma subárvore para outro pai mantendo o estado, ou alcançar um `FormState` de fora da subárvore dele. |

`Key('some string')` é uma factory que devolve `ValueKey<String>`, ou seja, a mesma coisa com menos caracteres.

## GlobalKey é outra ferramenta e tem um preço real

Uma `GlobalKey` é a única key que funciona entre pais diferentes, que é o que torna o reparenting de uma subárvore possível, e é a única que entrega o `State` do filho para você:

```dart
// Flutter 3.47.2, Dart 3.13.2
class _CheckoutFormState extends State<CheckoutForm> {
  // Long-lived: a field on the State, not a local in build().
  final _formKey = GlobalKey<FormState>();

  void _submit() {
    if (_formKey.currentState?.validate() ?? false) {
      _formKey.currentState!.save();
    }
  }

  @override
  Widget build(BuildContext context) => Form(key: _formKey, child: /* ... */);
}
```

Três coisas mordem aqui. O reparenting via `GlobalKey` está documentado como relativamente caro: dispara `State.deactivate` e força o rebuild de todo widget que dependa de um `InheritedWidget` naquela subárvore, que também é o caminho mais rápido para [procurar o ancestral de um widget desativado](/pt-br/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/). Construir a key dentro de `build` destrói o estado da subárvore a cada frame, e faz isso em silêncio: um `GestureDetector` sob uma `GlobalKey` regenerada simplesmente para de acompanhar gestos no meio de um arrasto. E dois widgets vivos carregando a mesma `GlobalKey` é um assert, "Multiple widgets used the same GlobalKey", que é o motivo de uma instância de widget compartilhada e reutilizada em dois ramos de um `TabBarView` ou sob `Navigator`s aninhados quebrar em vez de degradar.

Use uma `LocalKey` a menos que você precise especificamente de identidade entre pais ou de `currentState`.

## Keys também funcionam ao contrário: forçar um reset

Como `canUpdate` retornando false significa dispose e depois initState, mudar uma key de propósito é a forma mais limpa de resetar uma subárvore. Um painel de detalhe que troca de registro dentro da mesma rota é o caso padrão:

```dart
// Flutter 3.47.2, Dart 3.13.2
// Without the key, switching selectedOrderId reuses the same State, so the
// TextEditingController inside OrderEditor still holds the previous order's
// notes and any AnimationController keeps its current value.
OrderEditor(
  key: ValueKey(selectedOrderId),
  orderId: selectedOrderId,
)
```

Essa é a mesma falha que faz um `Future` criado em `build` disparar de novo em rebuilds sem relação, vista do outro lado: às vezes você quer o reset, às vezes você quer impedi-lo, e a pergunta que decide é sempre se a identidade mudou. Vale ler junto [a versão com FutureBuilder desse problema](/pt-br/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/).

Dois widgets tornam a key obrigatória em vez de recomendada: `Dismissible` dispara um assert com key null, porque um deslizar-para-remover pareado por posição animaria a saída da linha errada, e `ReorderableListView` exige uma key em cada filho exatamente pelo mesmo motivo.

## Quando dá para omitir a key

- **A subárvore não tem estado.** Se tudo abaixo do filho é stateless e cada pixel deriva dos campos do próprio widget, o pareamento posicional produz a saída correta. Reordenar filhos stateless sem key custa algum rebuild extra, mas não é um bug de correção.
- **A lista só cresce no fim.** Feeds que só acrescentam ao final são inteiramente cobertos pelo percurso de cima para baixo.
- **Filhos adjacentes já diferem em `runtimeType`.** `canUpdate` é false de qualquer jeito, então uma key não muda nada.
- **Você está dando key a um filho único que nunca tem irmãos.** O `body` de um `Scaffold` tem um slot só; não há o que desambiguar.

O parâmetro `super.key` em todo construtor de widget é uma convenção para quem chama, não uma dica de que você deveria estar passando algo.

## Dois limites que vale conhecer antes de confiar nas keys

Keys não vencem a reciclagem do viewport. `ListView.builder` e a família de slivers destroem elements assim que um item passa do cache extent, com key ou sem key, e reconstroem na volta. Se uma linha precisa lembrar de algo através desse limite, ou você eleva o estado para o seu modelo ou adota `AutomaticKeepAliveClientMixin`, ao custo da memória que a reciclagem estava economizando. É a mesma pergunta de orçamento que aparece quando você [combina seções de lista e grid em uma única área de rolagem com slivers](/pt-br/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/).

E `LocalKey`s duplicadas entre irmãos são um assert em modo debug, "Duplicate keys found. If multiple keyed widgets exist as children of another widget, they must have unique keys", levantado por `debugChildrenHaveDuplicateKeys`. Normalmente significa que o campo escolhido como key não é tão único quanto você supôs, o que é um bug de dados vestido de erro de framework.

O ponto mais fundo é que uma key conserta a reconciliação, não a arquitetura. Cada um dos bugs acima existe porque o estado por item mora dentro do `State` de um widget, onde a identidade é posicional por padrão. Estado que pertence a uma tarefa deveria morar com a tarefa, e assim que mora, a pergunta da reordenação deixa de ser pergunta. Esse é quase todo o argumento para [mover o estado de setState para um notifier do Riverpod](/pt-br/2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter/). Keys continuam sendo a resposta certa para estado genuinamente efêmero e por element, como deslocamentos de rolagem, foco e controllers de animação, e para esses você deve posicioná-las de propósito em vez de espalhá-las.

## Relacionados

- [Como liberar controllers no Flutter para evitar vazamentos de memória](/pt-br/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)
- [Correção: Looking up a deactivated widget's ancestor is unsafe no Flutter](/pt-br/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/)
- [Como inicializar um Future para que o FutureBuilder não o recrie a cada rebuild](/pt-br/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/)
- [Como misturar um ListView e um GridView em uma única área de rolagem com slivers](/pt-br/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/)
- [Migre um StatefulWidget com setState para um Notifier do Riverpod no Flutter](/pt-br/2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter/)

## Fontes

- [Inside Flutter: reconciliação linear](https://docs.flutter.dev/resources/inside-flutter)
- [Widget.canUpdate, documentação da API do Flutter](https://api.flutter.dev/flutter/widgets/Widget/canUpdate.html)
- [Element.updateChild, documentação da API do Flutter](https://api.flutter.dev/flutter/widgets/Element/updateChild.html)
- [Classe Key, documentação da API do Flutter](https://api.flutter.dev/flutter/foundation/Key-class.html)
- [Classe GlobalKey, documentação da API do Flutter](https://api.flutter.dev/flutter/widgets/GlobalKey-class.html)
- [Classe PageStorageKey, documentação da API do Flutter](https://api.flutter.dev/flutter/widgets/PageStorageKey-class.html)
- [debugChildrenHaveDuplicateKeys, documentação da API do Flutter](https://api.flutter.dev/flutter/widgets/debugChildrenHaveDuplicateKeys.html)
- [AutomaticKeepAliveClientMixin, documentação da API do Flutter](https://api.flutter.dev/flutter/widgets/AutomaticKeepAliveClientMixin-mixin.html)
- [Novidades no Flutter 3.47, blog do Flutter](https://flutter.dev/blog/whats-new-in-flutter-3-47)
