---
title: "O que é uma Key no Flutter e quando omiti-la causa bugs?"
description: "Keys no Flutter identificam linhas durante reordenação. Quando ValueKey basta, quando um builder precisa do novo índice e como GlobalKey preserva o estado."
pubDate: 2026-09-04
updatedDate: 2026-11-02
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

Uma key do Flutter ajuda o pai a associar uma nova configuração de widget a um elemento existente. `Widget.canUpdate` verifica `runtimeType` e keys iguais. Uma linha sem key pode manter seu estado quando dados diferentes ocupam sua posição. Isso importa quando ela possui um controlador de texto, foco ou animação de um item específico.

**Correção, 2 de novembro de 2026.** Uma key estável pode não bastar quando um builder lazy muda a ordem, e desativar não significa descartar imediatamente. Cinco testes de widgets verificaram linhas comuns, linhas lazy e uma mudança com `GlobalKey` no Flutter 3.44.8 / Dart 3.12.2. Os exemplos usam a biblioteca widgets.

## Irmãos comuns: identifique o item, não a posição

```dart
import 'package:flutter/widgets.dart';

class RowLabel extends StatefulWidget {
  const RowLabel(this.id, {super.key});
  final String id;

  @override
  State<RowLabel> createState() => _RowLabelState();
}

class _RowLabelState extends State<RowLabel> {
  late final String createdFor = widget.id;

  @override
  Widget build(BuildContext context) => SizedBox(
    height: 48,
    child: Text('row=${widget.id}, state=$createdFor'),
  );
}

Widget rows(List<String> ids, {required bool stableKeys}) => Column(
  children: [
    for (final id in ids)
      RowLabel(id, key: stableKeys ? ValueKey<String>(id) : null),
  ],
);
```

Renderize `rows(['A', 'B'], stableKeys: false)` dentro de `Directionality` e reconstrua com `['B', 'A']`. A primeira linha exibe `row=B, state=A`: a configuração mudou, mas o estado da posição ficou. Com `stableKeys: true`, o estado criado para A acompanha A. `ValueKey(index)` identificaria a posição. IDs devem ser estáveis e únicos entre irmãos.

Coloque a key no filho direto que o pai reordena. Se `Padding` envolve cada linha, coloque a key no `Padding`. Uma key também pode reiniciar deliberadamente uma única subárvore ao trocar de registro. Para animar duas versões do mesmo tipo, veja [AnimatedSwitcher e keys do filho](/pt-br/2026/10/how-to-make-animatedswitcher-animate-when-the-child-type-does-not-change/).

## Builders lazy: localizar o novo índice pela key

`ListView.builder` cria filhos sob demanda. Quando a ordem muda, `findChildIndexCallback` permite ao delegate localizar o índice atual de um filho existente. Crie o mapa com os mesmos dados ordenados de `itemBuilder` e retorne `null` para IDs removidos:

```dart
Widget lazyRows(List<String> ids, {bool remap = true}) {
  final indexById = {for (var i = 0; i < ids.length; i++) ids[i]: i};
  int? indexForKey(Key key) => key is ValueKey<String> ? indexById[key.value] : null;

  return ListView.builder(
    itemCount: ids.length,
    findChildIndexCallback: remap ? indexForKey : null,
    itemBuilder: (_, index) {
      final id = ids[index];
      return RowLabel(id, key: ValueKey<String>(id));
    },
  );
}
```

O teste reordenou `[A, B, C]` para `[C, B, A]` com todas as linhas visíveis. Com o callback, A manteve o mesmo objeto `State`. Com `remap: false`, A recebeu novo estado nessa fixture. O Flutter documenta que a falta do mapeamento **pode** causar perda de estado. Uma key também não mantém automaticamente um filho fora da tela vivo. Guarde os dados duráveis no modelo e configure keep-alive quando necessário.

## Desativar, reinserir ou descartar

Um elemento stateful compatível pode receber nova configuração sem criar outro `State`. Ao removê-lo, o Flutter primeiro o desativa. Uma subárvore com `GlobalKey` pode ser reinserida sob outro pai no mesmo frame e reativada com o mesmo estado. Se a remoção for permanente, `dispose` ocorre após a desativação.

No teste, mover o filho entre pais produziu `init → deactivate → activate` com o mesmo estado. Remover no frame seguinte produziu `deactivate → dispose`. Libere os controladores próprios em `dispose`. Veja [descarte de controladores](/pt-br/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) e [acesso a ancestrais após desativação](/pt-br/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/).

## Escolher a identidade adequada

| Key | O que identifica |
| --- | --- |
| `ValueKey(id)` | Tipo e valor iguais. Use um ID de domínio estável para linhas. |
| `ObjectKey(object)` | A mesma instância. Recriar o modelo pode mudar a identidade. |
| `UniqueKey()` | Uma instância específica de key. Uma nova em todo build provoca substituições repetidas. |
| `PageStorageKey(value)` | Um local em `PageStorage`, comum para posições de rolagem. Não preserva o objeto de estado inteiro. |
| `GlobalKey` | Identidade única na árvore para mover a subárvore no mesmo frame ou acessar estado. Mantenha a instância fora de `build`. |

Para filhos stateless fixos ou listas que apenas crescem no final, a key pode ser dispensável. Use o ID do item se o estado precisar acompanhá-lo nas edições.

## Fontes

- [Widget.canUpdate](https://api.flutter.dev/flutter/widgets/Widget/canUpdate.html)
- [Inside Flutter: linear reconciliation](https://docs.flutter.dev/resources/inside-flutter)
- [SliverChildBuilderDelegate.findChildIndexCallback](https://api.flutter.dev/flutter/widgets/SliverChildBuilderDelegate/findChildIndexCallback.html)
- [State.deactivate](https://api.flutter.dev/flutter/widgets/State/deactivate.html) · [GlobalKey](https://api.flutter.dev/flutter/widgets/GlobalKey-class.html)
- [PageStorageKey](https://api.flutter.dev/flutter/widgets/PageStorageKey-class.html)
