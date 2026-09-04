---
title: "¿Qué es una Key en Flutter y cuándo provoca errores omitirla?"
description: "Una Key es la mitad de identidad de Widget.canUpdate, la única línea del framework que decide si un Element y su State se reutilizan o se descartan. Esto es lo que significa en la práctica, las ediciones de listas que corrompen el estado sin keys, qué tipo de key usar y dónde debe ir la key para funcionar."
pubDate: 2026-09-04
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

Una `Key` es la mitad de identidad de la única comparación que Flutter usa para decidir si un `Element` existente (y el `State` que cuelga de él) puede reutilizarse para un `Widget` nuevo. Esa comparación es `oldWidget.runtimeType == newWidget.runtimeType && oldWidget.key == newWidget.key`. Sin key, los hijos del mismo tipo se emparejan puramente por posición en la lista de hijos, así que cualquier edición que mueva un elemento (un reordenamiento, una eliminación en el medio, un filtro) deja el estado pegado a la posición vieja mientras los datos se deslizan a otra. Necesitas una key exactamente cuando un widget con estado puede cambiar de posición entre sus hermanos. Todo lo que sigue apunta al canal stable actual, Flutter 3.47.2 con Dart 3.13.2, pero las reglas de reconciliación no han cambiado desde Flutter 1.

## Las keys son una entrada de canUpdate, y nada más

El framework mantiene tres árboles paralelos: tu configuración inmutable de `Widget`, el árbol de `Element` que persiste entre reconstrucciones, y el árbol de `RenderObject` que hace layout y pinta. Los objetos `State` pertenecen a los elements, no a los widgets. Cuando un padre se reconstruye, cada posición de hijo se resuelve a través de `Element.updateChild`, que hace una sola pregunta:

```dart
// package:flutter/src/widgets/framework.dart, Flutter 3.47.2
static bool canUpdate(Widget oldWidget, Widget newWidget) {
  return oldWidget.runtimeType == newWidget.runtimeType &&
      oldWidget.key == newWidget.key;
}
```

Si eso devuelve `true`, el element existente se conserva y se reconfigura: su `State` sobrevive, `didUpdateWidget` se ejecuta, `initState` no. Si devuelve `false`, el element viejo se desactiva y se infla un element completamente nuevo, lo que significa `dispose` a la salida e `initState` a la entrada. Si el widget nuevo es null, el hijo se elimina directamente.

De esa firma salen dos consecuencias. Primera: una key null es un valor de key perfectamente válido, y `null == null` es `true`, así que dos widgets sin key del mismo tipo siempre coinciden. Segunda: las keys nunca se comparan entre padres distintos; solo se consultan entre los hijos de un mismo element. La documentación lo dice sin rodeos: las keys deben ser únicas entre los elements que comparten padre.

## La pasada de reconciliación que decide qué hijo es cuál

Al contrario de lo que se suele suponer, Flutter no ejecuta un diff general de árboles. Cada element reconcilia su propia lista de hijos con una pasada lineal `O(N)` descrita en [Inside Flutter](https://docs.flutter.dev/resources/inside-flutter):

1. Recorre ambas listas desde arriba, emparejando mientras `runtimeType` y `key` coincidan.
2. Recorre ambas listas desde abajo, haciendo lo mismo.
3. El rango sin emparejar que quede en el medio: mete los hijos viejos en una tabla hash indexada por su `key`, luego recorre el rango medio nuevo y busca cada uno.
4. Los hijos viejos sin coincidencia se desmontan; los widgets nuevos sin coincidencia reciben elements frescos.

El paso 3 es donde las keys se ganan el sueldo. Un hijo sin key no tiene nada que poner en la tabla hash, así que solo puede emparejarse por los recorridos posicionales de los pasos 1 y 2. Por eso las listas sin key sobreviven a añadir al final (el paso 1 empareja todo y luego la cola es nueva) y se rompen en silencio con cualquier otra cosa.

## La reproducción mínima: estado que se queda atrás

Dos tiles, cada uno eligiendo un color una vez en su propio `State`, más un botón que invierte la lista. Nada exótico. Desde Flutter 3.47 los widgets de Material viven en el paquete independiente, así que el import difiere de los ejemplos antiguos; mira el recorrido de cómo [migrar tus importaciones a material_ui](/es/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/) si los tuyos todavía apuntan a la copia del SDK.

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

Pulsa Swap y las letras intercambian su lugar, pero los colores no se mueven. La posición 0 tenía un `ColorTile` con key null, la nueva posición 0 es un `ColorTile` con key null, `canUpdate` devuelve `true`, así que el element y su `_ColorTileState` se reutilizan y solo cambia `widget.label`. El color es estado, y el estado se quedó donde estaba.

Añadir una identidad lo arregla:

```dart
// Flutter 3.47.2, Dart 3.13.2
children: [for (final l in labels) ColorTile(key: ValueKey(l), label: l)],
```

Ahora los recorridos posicionales fallan en ambos extremos, los dos hijos caen en el rango medio, la tabla hash mapea `ValueKey('A')` al element que estaba en la posición 0, y ese element se reasigna a la posición 1 con su color intacto.

## La versión de este bug que llega a producción

Un color aleatorio es un juguete. El mismo mecanismo corrompe datos reales siempre que el estado vive dentro del widget de fila:

```dart
// Flutter 3.47.2, Dart 3.13.2
// Each row owns a TextEditingController in its State.
Column(
  children: [
    for (final task in tasks) TaskRow(task: task), // no key
  ],
)
```

Elimina la tarea del índice 0. La lista se encoge en uno y todas las tareas restantes suben una posición. La reconciliación empareja la posición vieja 0 con la posición nueva 0, así que el controlador que guarda la nota a medio escribir de la tarea eliminada está ahora sentado en la fila que renderiza la tarea *siguiente*. `didUpdateWidget` se dispara con otro `widget.task`, pero el texto del controlador, el desplazamiento de scroll, el checkbox, el flag de expandido, el focus node, nada de eso deriva de `widget`, así que nada de eso se mueve. La persona usuaria ve su texto contra el registro de otro, y cuando pulsa guardar lo escribes ahí. La misma forma aparece con expansion tiles que dejan abierto el panel equivocado, animaciones que se reinician en la fila equivocada, y errores de validación de formulario pegados a un campo que nadie tocó. Los controladores creados por fila también necesitan la disciplina de ciclo de vida habitual, que es una fuga distinta e igual de común: mira [cómo liberar controladores en Flutter](/es/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).

`ValueKey(task.id)` sobre `TaskRow` arregla todo eso de golpe.

## Pon la key en el widget más externo de la lista

Las keys se emparejan entre hermanos bajo un mismo padre. Si envuelves la fila, el envoltorio es el hermano, así que el envoltorio es lo que necesita la key:

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

La versión incorrecta es peor que no poner key: en vez de asignar mal el estado, lo tira en cada reordenamiento, lo que se ve como parpadeo, animaciones reiniciadas y campos de texto vaciados.

La otra forma garantizada de escribir una key que no hace nada es `ValueKey(index)`. El índice *es* la identidad posicional que ya tenías, así que usarlo como key reproduce exactamente el comportamiento sin key mientras aparenta ser un arreglo. Usa como key algo que el elemento posea: un id de base de datos, un UUID, un slug.

## Qué tipo de key

| Tipo | Identidad | Úsalo cuando |
| ---- | -------- | ----------------- |
| `ValueKey<T>(v)` | `runtimeType` y `v ==` | El elemento tiene un valor de dominio estable: id, slug, fecha ISO en texto. La opción por defecto. |
| `ObjectKey(o)` | `identical(o, other.value)` | El modelo sobrescribe `==` por valor (records, clases Freezed) pero dos instancias iguales deben seguir siendo distintas. |
| `UniqueKey()` | Solo igual a sí misma | Quieres forzar un subárbol nuevo, una vez. Nunca la construyas dentro de `build`; una instancia nueva por frame significa que `canUpdate` es false en cada frame y el subárbol se reconstruye desde cero para siempre. |
| `PageStorageKey<T>(v)` | Una `ValueKey` que además nombra una ranura en el `PageStorage` que la envuelve | Preservar un desplazamiento de scroll entre un push de ruta o un cambio de pestaña, donde el element en sí se destruye. |
| `GlobalKey` | Única en toda la app; expone `currentState`, `currentContext`, `currentWidget` | Mover un subárbol a otro padre conservando su estado, o alcanzar un `FormState` desde fuera de su subárbol. |

`Key('some string')` es una factory que devuelve `ValueKey<String>`, así que es lo mismo con menos caracteres.

## GlobalKey es otra herramienta y tiene un precio real

Una `GlobalKey` es la única key que funciona entre padres distintos, que es lo que hace posible reasignar un subárbol, y es la única que te entrega el `State` del hijo:

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

Aquí muerden tres cosas. Reasignar a través de una `GlobalKey` está documentado como relativamente caro: dispara `State.deactivate` y obliga a reconstruir a todo widget que dependa de un `InheritedWidget` en ese subárbol, que es también la ruta más rápida a [buscar el ancestro de un widget desactivado](/es/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/). Construir la key dentro de `build` destruye el estado del subárbol en cada frame, y lo hace en silencio: un `GestureDetector` bajo una `GlobalKey` regenerada simplemente deja de seguir gestos a mitad de un arrastre. Y dos widgets vivos con la misma `GlobalKey` es un assert, "Multiple widgets used the same GlobalKey", que es la razón por la que una instancia de widget compartida y reutilizada en dos ramas de un `TabBarView` o bajo `Navigator`s anidados revienta en vez de degradarse.

Usa una `LocalKey` salvo que necesites específicamente identidad entre padres o `currentState`.

## Las keys también funcionan al revés: forzar un reinicio

Como que `canUpdate` devuelva false significa dispose y luego initState, cambiar una key a propósito es la forma más limpia de reiniciar un subárbol. Un panel de detalle que cambia de registro dentro de la misma ruta es el caso estándar:

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

Este es el mismo fallo que hace que un `Future` creado en `build` se vuelva a disparar en reconstrucciones no relacionadas, visto desde el otro lado: a veces quieres el reinicio, a veces quieres evitarlo, y la pregunta que decide es siempre si la identidad cambió. Vale la pena leer junto a esto [la versión con FutureBuilder de ese problema](/es/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/).

Dos widgets hacen la key obligatoria en vez de recomendable: `Dismissible` lanza un assert con key null, porque un deslizar-para-eliminar que emparejara por posición animaría la salida de la fila equivocada, y `ReorderableListView` exige una key en cada hijo exactamente por lo mismo.

## Cuándo puedes omitir la key

- **El subárbol no tiene estado.** Si todo lo que hay debajo del hijo es stateless y cada píxel deriva de los campos del propio widget, el emparejamiento posicional produce la salida correcta. Reordenar hijos stateless sin key cuesta algo de trabajo extra de reconstrucción, pero no es un bug de corrección.
- **La lista solo crece por el final.** Los feeds que solo añaden al final quedan cubiertos por el recorrido descendente.
- **Los hijos adyacentes ya difieren en `runtimeType`.** `canUpdate` es false de todos modos, así que una key no cambia nada.
- **Estás poniendo key a un hijo único que nunca tiene hermanos.** El `body` de un `Scaffold` tiene una sola ranura; no hay nada que desambiguar.

El parámetro `super.key` en cada constructor de widget es una convención para quien llama, no una pista de que deberías estar pasando algo.

## Dos límites que conviene conocer antes de fiarte de las keys

Las keys no derrotan al reciclaje del viewport. `ListView.builder` y la familia de slivers destruyen elements en cuanto un elemento sale del cache extent, con key o sin ella, y los reconstruyen al volver. Si una fila debe recordar algo más allá de ese límite, o elevas el estado a tu modelo o adoptas `AutomaticKeepAliveClientMixin`, al costo de la memoria que el reciclaje estaba ahorrando. Es la misma pregunta de presupuesto que aparece cuando [combinas secciones de lista y grid en una sola vista de scroll con slivers](/es/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/).

Y las `LocalKey`s duplicadas entre hermanos son un assert en modo debug, "Duplicate keys found. If multiple keyed widgets exist as children of another widget, they must have unique keys", lanzado por `debugChildrenHaveDuplicateKeys`. Normalmente significa que el campo que usaste como key no es tan único como suponías, que es un bug de datos disfrazado de error de framework.

El punto de fondo es que una key repara la reconciliación, no la arquitectura. Cada uno de los bugs de arriba existe porque el estado por elemento vive dentro del `State` de un widget, donde su identidad es posicional por defecto. El estado que pertenece a una tarea debería vivir con la tarea, y una vez que lo hace, la pregunta del reordenamiento deja de ser una pregunta. Ese es casi todo el argumento para [mover el estado de setState a un notifier de Riverpod](/es/2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter/). Las keys siguen siendo la respuesta correcta para estado genuinamente efímero y por element, como desplazamientos de scroll, foco y controladores de animación, y para esos deberías colocarlas de forma deliberada en lugar de esparcirlas.

## Relacionado

- [Cómo liberar controladores en Flutter para evitar fugas de memoria](/es/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)
- [Solución: Looking up a deactivated widget's ancestor is unsafe en Flutter](/es/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/)
- [Cómo inicializar un Future para que FutureBuilder no lo recree en cada reconstrucción](/es/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/)
- [Cómo combinar un ListView y un GridView en una sola vista de scroll con slivers](/es/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/)
- [Migra un StatefulWidget con setState a un Notifier de Riverpod en Flutter](/es/2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter/)

## Fuentes

- [Inside Flutter: reconciliación lineal](https://docs.flutter.dev/resources/inside-flutter)
- [Widget.canUpdate, documentación de la API de Flutter](https://api.flutter.dev/flutter/widgets/Widget/canUpdate.html)
- [Element.updateChild, documentación de la API de Flutter](https://api.flutter.dev/flutter/widgets/Element/updateChild.html)
- [Clase Key, documentación de la API de Flutter](https://api.flutter.dev/flutter/foundation/Key-class.html)
- [Clase GlobalKey, documentación de la API de Flutter](https://api.flutter.dev/flutter/widgets/GlobalKey-class.html)
- [Clase PageStorageKey, documentación de la API de Flutter](https://api.flutter.dev/flutter/widgets/PageStorageKey-class.html)
- [debugChildrenHaveDuplicateKeys, documentación de la API de Flutter](https://api.flutter.dev/flutter/widgets/debugChildrenHaveDuplicateKeys.html)
- [AutomaticKeepAliveClientMixin, documentación de la API de Flutter](https://api.flutter.dev/flutter/widgets/AutomaticKeepAliveClientMixin-mixin.html)
- [Novedades de Flutter 3.47, blog de Flutter](https://flutter.dev/blog/whats-new-in-flutter-3-47)
