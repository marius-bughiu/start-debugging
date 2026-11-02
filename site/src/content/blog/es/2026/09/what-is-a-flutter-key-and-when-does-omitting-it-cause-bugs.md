---
title: "¿Qué es una Key en Flutter y cuándo provoca errores omitirla?"
description: "Las keys de Flutter identifican filas al reordenar. Cuándo basta ValueKey, cuándo un builder necesita localizar el nuevo índice y cómo GlobalKey conserva estado."
pubDate: 2026-09-04
updatedDate: 2026-11-02
tags:
  - "flutter"
  - "dart"
  - "state-management"
  - "listview"
lang: "es"
translationOf: "2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs"
translatedBy: "claude"
translationDate: 2026-09-04
---

Una key de Flutter ayuda al padre a asociar una nueva configuración de widget con un elemento existente. `Widget.canUpdate` comprueba `runtimeType` y keys iguales. Una fila sin key puede conservar su estado cuando datos distintos ocupan su posición. Esto importa si contiene un controlador de texto, foco o animación perteneciente a un elemento concreto.

**Corrección, 2 de noviembre de 2026.** Una key estable puede no bastar con un builder que cambia de orden, y la desactivación no implica eliminación inmediata. Cinco pruebas de widgets comprobaron filas normales, filas lazy y un movimiento con `GlobalKey` en Flutter 3.44.8 / Dart 3.12.2. Los ejemplos usan la biblioteca widgets.

## Hermanos normales: identifica el elemento, no el índice

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

Renderiza `rows(['A', 'B'], stableKeys: false)` bajo `Directionality` y reconstruye con `['B', 'A']`. La primera fila muestra `row=B, state=A`: cambió la configuración pero sobrevivió el estado de esa posición. Con `stableKeys: true`, el estado de A sigue a A. `ValueKey(index)` identificaría la posición. Los IDs deben ser estables y únicos entre hermanos.

Pon la key en el hijo directo que reordena el padre. Si `Padding` envuelve cada fila, ponla en `Padding`. Una key también puede reiniciar deliberadamente un único subárbol al cambiar de registro. Para animar dos versiones del mismo tipo, consulta [AnimatedSwitcher y keys del hijo](/es/2026/10/how-to-make-animatedswitcher-animate-when-the-child-type-does-not-change/).

## Builders lazy: localizar el nuevo índice por key

`ListView.builder` crea hijos bajo demanda. Cuando cambia el orden, `findChildIndexCallback` permite al delegate localizar el índice nuevo de un hijo existente. Construye el mapa con los mismos datos ordenados que usa `itemBuilder`, y devuelve `null` para IDs eliminados:

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

La prueba reordenó `[A, B, C]` como `[C, B, A]` con todas las filas visibles. Con el callback, A conservó el mismo objeto `State`. Con `remap: false`, A recibió un estado nuevo en este caso. Flutter documenta que omitir la correspondencia **puede** provocar pérdida de estado. Una key tampoco mantiene vivo automáticamente un hijo fuera de pantalla. Guarda datos duraderos en el modelo y configura el keep-alive donde haga falta.

## Desactivar, reinsertar o liberar

Un elemento stateful compatible puede recibir configuración nueva sin crear otro `State`. Al retirarlo se desactiva primero. Un subárbol con `GlobalKey` puede reinsertarse bajo otro padre y reactivarse con el mismo estado en ese frame. Cuando la retirada es permanente, Flutter ejecuta `dispose` después de la desactivación.

En la prueba, mover el hijo entre dos padres produjo `init → deactivate → activate` con el mismo estado. Al quitarlo en el frame siguiente se observó `deactivate → dispose`. Libera los controladores propios en `dispose`. Consulta [liberación de controladores](/es/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) y [acceso a ancestros tras desactivación](/es/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/).

## Elegir la identidad apropiada

| Key | Qué identifica |
| --- | --- |
| `ValueKey(id)` | Tipo y valor iguales. Usa un ID estable de dominio para filas. |
| `ObjectKey(object)` | La misma instancia. Recrear el modelo puede cambiar la identidad. |
| `UniqueKey()` | Una instancia concreta de key. Una nueva en cada build provoca reemplazos repetidos. |
| `PageStorageKey(value)` | Un lugar en `PageStorage`, común para posiciones de scroll. No conserva todo el objeto de estado. |
| `GlobalKey` | Identidad única en el árbol para mover un subárbol en el mismo frame o acceder al estado. Conserva la instancia fuera de `build`. |

Para hijos stateless fijos o listas que solo agregan al final, puede no hacer falta una key. Usa el ID del elemento si su estado debe acompañarlo al editar la lista.

## Fuentes

- [Widget.canUpdate](https://api.flutter.dev/flutter/widgets/Widget/canUpdate.html)
- [Inside Flutter: linear reconciliation](https://docs.flutter.dev/resources/inside-flutter)
- [SliverChildBuilderDelegate.findChildIndexCallback](https://api.flutter.dev/flutter/widgets/SliverChildBuilderDelegate/findChildIndexCallback.html)
- [State.deactivate](https://api.flutter.dev/flutter/widgets/State/deactivate.html) · [GlobalKey](https://api.flutter.dev/flutter/widgets/GlobalKey-class.html)
- [PageStorageKey](https://api.flutter.dev/flutter/widgets/PageStorageKey-class.html)
