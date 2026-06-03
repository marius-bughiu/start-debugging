---
title: "Solución: RenderBox was not laid out en Flutter"
description: "RenderBox was not laid out casi siempre es un error secundario. Busca la primera aserción de layout encima, normalmente un scrollable con restricciones no acotadas, y corrige eso."
pubDate: 2026-06-03
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "layout"
  - "renderbox"
lang: "es"
translationOf: "2026/06/fix-renderbox-was-not-laid-out-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-03
---

`RenderBox was not laid out` significa que Flutter intentó pintar o hacer hit-test sobre un render box cuyo tamaño nunca se calculó. Casi siempre es un error derivado: una aserción de layout anterior abortó `performLayout` para una parte del árbol, y este mensaje no es más que los restos. La solución real es subir hasta el primer error de la consola, que normalmente es un scrollable (`ListView`, `GridView`, `SingleChildScrollView`) al que se le dieron restricciones no acotadas en su eje de scroll. Acota ese widget con `Expanded`, un tamaño fijo o `shrinkWrap` y esto desaparece. Esta guía usa Flutter 3.44 (estable, mayo de 2026) y Dart 3.x.

La aserción que se dispara es `hasSize` en `package:flutter/src/rendering/box.dart`. Un `RenderBox` solo obtiene un tamaño durante su pasada de `performLayout`. Si el layout nunca se ejecutó correctamente para ese box, pedir `.size` (cosa que hacen tanto el pintado como el hit-testing) activa la guarda. Por eso el mensaje es exacto pero poco útil por sí solo: nombra a la víctima, no al culpable.

## El error en contexto

El bloque de la consola se ve así. El nombre exacto del widget y los IDs en hexadecimal cambian, pero la forma es constante:

```
======== Exception caught by rendering library =====================
The following assertion was thrown during performLayout():
RenderBox was not laid out: RenderShrinkWrappingViewport#4aefd
  relayoutBoundary=up13 NEEDS-PAINT NEEDS-COMPOSITING-BITS-UPDATE
'package:flutter/src/rendering/box.dart': Failed assertion: line 1966
  pos 12: 'hasSize'

The relevant error-causing widget was:
  ListView  lib/widgets/feed.dart:58
====================================================================
```

Dos detalles importan. Primero, el render object nombrado (`RenderShrinkWrappingViewport`, `RenderPadding`, `RenderRepaintBoundary`, lo que sea) te dice qué subárbol falló al hacer layout. Segundo, y más importante, rara vez esta es la única excepción. En modo debug, Flutter imprime el primer fallo y luego sigue intentando renderizar, lo que produce una cascada de estas aserciones `hasSize`. El mensaje sobre el que debes actuar es el de arriba de la cascada, no en el que se posa tu vista.

## Por qué ocurre

Un `RenderBox` tiene un tamaño solo después de que `performLayout` le asigne uno. Tres situaciones dejan un box sin tamaño:

Al box se le dieron restricciones que no puede satisfacer, así que su propio `performLayout` lanzó una excepción. El caso clásico es un scrollable que recibió una restricción no acotada en su eje de scroll. Un `ListView` vertical necesita una altura acotada para saber cuánto viewport renderizar; dale altura infinita y lanza `Vertical viewport was given unbounded height`, el layout aborta, y cada ancestro que después intente leer su tamaño reporta `RenderBox was not laid out`.

Un padre pintó o hizo hit-test sobre un hijo sin hacerle layout primero. Este es el bug del `RenderObject` personalizado: escribiste un render object cuyo `paint` lee `child.size` pero cuyo `performLayout` olvidó llamar a `child.layout(...)`. El hijo nunca obtuvo un tamaño.

Alguien leyó `.size` fuera de la fase de layout. Leer `context.size` o `renderBox.size` durante `build`, `initState` o un callback síncrono, antes de que el primer frame haya hecho el layout del widget, activa la misma aserción. El tamaño simplemente todavía no existe.

La regla unificadora es el contrato de layout de Flutter: las restricciones bajan, los tamaños suben, y el tamaño de un box es válido solo entre el final de su `performLayout` y el siguiente `markNeedsLayout`. Lee más en la página oficial [Understanding constraints](https://docs.flutter.dev/ui/layout/constraints), que es el documento más útil para todo error de layout en Flutter.

## Una reproducción mínima que puedes pegar en una app nueva

El disparador más común con diferencia: un `ListView` colocado directamente dentro de un `Column`. El `Column` da a sus hijos altura no acotada en el eje principal, el `ListView` quiere una altura acotada, y el layout falla.

```dart
// Flutter 3.44, Dart 3.x -- throws, layout aborts, "RenderBox was not laid out" follows.
import 'package:flutter/material.dart';

void main() => runApp(const MaterialApp(home: FeedScreen()));

class FeedScreen extends StatelessWidget {
  const FeedScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Column(
        children: [
          const Text('Latest'),
          // ListView inside a Column: unbounded height on the main axis.
          ListView(
            children: const [
              ListTile(title: Text('One')),
              ListTile(title: Text('Two')),
              ListTile(title: Text('Three')),
            ],
          ),
        ],
      ),
    );
  }
}
```

Ejecútalo y el primer error de la consola es `Vertical viewport was given unbounded height`. Las aserciones `RenderBox was not laid out` debajo son la consecuencia, no la causa. La solución es acotar el `ListView`.

## Solución, en detalle

Las soluciones están ordenadas por la frecuencia con que son la respuesta correcta. Elige según lo que el box sin tamaño realmente necesita.

### 1. Da un tamaño acotado a un scrollable con Expanded (recomendado)

Cuando un scrollable vive dentro de un `Column` o un `Row` y debe llenar el espacio sobrante, envuélvelo en `Expanded`. `Expanded` entrega al hijo una restricción acotada y ajustada (tight) en el eje principal, que es exactamente lo que necesita el viewport:

```dart
// Flutter 3.44, Dart 3.x -- Expanded gives the ListView a bounded height.
Column(
  children: [
    const Text('Latest'),
    Expanded(
      child: ListView(
        children: const [
          ListTile(title: Text('One')),
          ListTile(title: Text('Two')),
          ListTile(title: Text('Three')),
        ],
      ),
    ),
  ],
)
```

Esto mantiene el `ListView` perezoso: construye solo las filas que están en pantalla y desplaza el resto, que es lo que quieres para cualquier lista que pueda crecer. Esta es la solución correcta para un feed, una lista de resultados de búsqueda, o cualquier región con scroll que tenga un encabezado encima.

### 2. Usa shrinkWrap cuando la lista es corta y debe ajustarse a su contenido

Si la lista es realmente pequeña y finita (un puñado de filas de configuración, un menú fijo) y quieres que ocupe solo la altura de su contenido, pon `shrinkWrap: true`. Eso le dice al `ListView` que mida a sus hijos y reporte su altura combinada en lugar de exigir un viewport acotado:

```dart
// Flutter 3.44, Dart 3.x -- shrinkWrap sizes the list to its children.
Column(
  children: [
    const Text('Settings'),
    ListView(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      children: const [
        ListTile(title: Text('Profile')),
        ListTile(title: Text('Notifications')),
        ListTile(title: Text('Privacy')),
      ],
    ),
  ],
)
```

El compromiso es real: `shrinkWrap` hace layout de todos los hijos por adelantado, anulando el renderizado perezoso que hace barato a `ListView`. Úsalo solo para listas cortas y acotadas. Para cualquier cosa que pueda crecer a docenas de elementos, vuelve a la solución 1. Agregar `physics: NeverScrollableScrollPhysics()` impide que la lista interna haga scroll de forma independiente, que suele ser lo que quieres cuando el `Column` exterior es la superficie de scroll.

### 3. Da al box una restricción acotada explícita

A veces la respuesta correcta es un tamaño concreto. Un `SizedBox` con altura fija, o un `ConstrainedBox` con una altura máxima, da al scrollable un límite con el que trabajar:

```dart
// Flutter 3.44, Dart 3.x -- a fixed viewport height for a horizontal carousel.
SizedBox(
  height: 200,
  child: ListView(
    scrollDirection: Axis.horizontal,
    children: const [/* cards */],
  ),
)
```

Un `ListView` horizontal dentro de un `Column` es la imagen espejo de la reproducción: el `Column` acota el ancho pero deja la altura no acotada, y el viewport horizontal necesita una altura acotada. Una `height` fija lo resuelve limpiamente. Usa `ConstrainedBox(constraints: BoxConstraints(maxHeight: 300))` cuando el contenido pueda ser más corto que el tope.

### 4. Haz layout del hijo antes de leer su tamaño en un RenderObject personalizado

Si escribiste un `RenderObject` personalizado (o una subclase de `RenderBox`), la aserción te está diciendo que `performLayout` accedió al tamaño de un hijo antes de hacerle layout. Llama siempre a `child.layout(...)` antes de leer `child.size`:

```dart
// Flutter 3.44, Dart 3.x -- lay out the child, THEN read its size.
@override
void performLayout() {
  final BoxConstraints childConstraints = constraints.loosen();
  child!.layout(childConstraints, parentUsesSize: true); // must come first
  size = constraints.constrain(child!.size);              // now .size is valid
}
```

El flag `parentUsesSize: true` es obligatorio cuando el tamaño del propio padre depende del hijo. Omítelo y Flutter puede saltarse el relayout cuando el hijo cambia, lo que produce layouts obsoletos que parecen este mismo error de forma intermitente. El contrato está documentado en la [página de la API RenderBox.size](https://api.flutter.dev/flutter/rendering/RenderBox/size.html): el tamaño solo es válido durante y después de `performLayout`, y leerlo desde un padre requiere `parentUsesSize: true` en el momento de `layout`.

### 5. Difiere la lectura del tamaño hasta después del primer frame

Si necesitas el tamaño renderizado de un widget en Dart (para posicionar un overlay, dimensionar un hermano, o alimentar una medición de vuelta al estado), no leas `context.size` durante `build`. El render box todavía no ha hecho layout. Léelo después del frame:

```dart
// Flutter 3.44, Dart 3.x -- the size exists only after layout has run.
@override
void initState() {
  super.initState();
  WidgetsBinding.instance.addPostFrameCallback((_) {
    if (!mounted) return;
    final Size? size = context.size; // valid now: the frame has been laid out
    setState(() => _measuredHeight = size?.height);
  });
}
```

Para medir durante el layout en lugar de después, recurre a `LayoutBuilder` (que te entrega las restricciones del padre) o a un `RenderObject` con `parentUsesSize: true`, no a una lectura de tamaño post-frame. El enfoque post-frame es para el caso "solo necesito los píxeles finales una vez".

## Trampas y errores parecidos

- `Vertical viewport was given unbounded height` y `Horizontal viewport was given unbounded width` son los errores primarios que *causan* la mayoría de las cascadas de `RenderBox was not laid out`. Si ves cualquiera de los dos encima de la aserción `hasSize`, corrige ese y el resto desaparece. La solución son las soluciones 1 a 3 de arriba.
- `A RenderFlex overflowed by N pixels` es un fallo distinto: el flex hizo layout bien pero sus hijos excedieron el espacio disponible. Eso pinta una franja en lugar de abortar el layout. Consulta [la guía sobre el desbordamiento de RenderFlex](/es/2026/05/fix-renderflex-overflowed-in-flutter/) para ese caso; no es lo mismo que un box sin tamaño.
- `BoxConstraints forces an infinite height` lanzado por `IntrinsicHeight` o `IntrinsicWidth` envolviendo un scrollable. Los widgets intrínsecos hacen una pasada de layout especulativa en la que los scrollables se niegan a participar. Elimina el `IntrinsicHeight`, o acota el scrollable directamente con un `SizedBox`.
- Un `TabBarView`, `PageView`, o un `ListView` anidado dentro de otro scrollable choca contra el mismo muro de restricciones no acotadas. Envuelve el scrollable interior en un `Expanded` (si el exterior es un flex) o dale una altura fija, y pon `shrinkWrap` solo cuando la lista interior es corta.
- Leer `renderBox.size` desde un `GlobalKey` inmediatamente después de un `setState` devuelve el tamaño del frame *anterior*, o lanza una excepción si el widget todavía no ha hecho layout en absoluto. Protege siempre estas lecturas detrás de `addPostFrameCallback` y una comprobación de `mounted`, la misma disciplina que evita los fallos por disposición cubiertos en [la guía sobre disponer controllers](/es/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).
- En modo release la aserción se compila fuera, así que en lugar de una pantalla roja obtienes una región en blanco, un widget de tamaño cero, o un pintado omitido en silencio. Por eso corriges la causa en debug en lugar de pasar de largo un aviso de la consola: el síntoma cambia de forma en release pero el bug sigue ahí.

## Encontrar al culpable real rápido

Como este error hace cascada, el camino más rápido es leer la consola de arriba abajo y detenerte en la primera excepción. Luego acota el subárbol:

1. El primer error nombra un widget y una ubicación de origen (`lib/widgets/feed.dart:58`). Abre ese archivo y mira cuál es el padre del widget nombrado. Un scrollable cuyo padre es un `Column`, un `Row`, un `IntrinsicHeight`, u otro scrollable es tu sospechoso.
2. Activa `debugPaintSizeEnabled = true;` en `main` (o alterna Debug Paint en el Flutter Inspector) para ver el contorno de cada box. Un box que no pinta nada o que se colapsa a una línea es el que falló al hacer layout.
3. Abre el Layout Explorer en DevTools y selecciona el widget que falla. Su panel de restricciones muestra si recibió `h=unbounded` o `w=unbounded`, lo que confirma el diagnóstico. Si no has usado DevTools para trabajo de layout, el recorrido en [perfilar el jank de una app Flutter con DevTools](/es/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) cubre cómo abrir una sesión contra un dispositivo real; la misma sesión maneja el Layout Explorer.

La lección más profunda es que `RenderBox was not laid out` nunca es el bug en sí. Es Flutter reportando que no pudo terminar el trabajo que empezó un widget anterior. Entrénate para ignorar el mensaje más ruidoso y encontrar el primero, el silencioso, y este error deja de ser un misterio. Mantén tus scrollables acotados, haz layout de los hijos antes de medirlos, y nunca leas un tamaño antes del frame que lo produce, y la aserción nunca se dispara.

## Relacionado

- [Solución: A RenderFlex overflowed by N pixels en Flutter](/es/2026/05/fix-renderflex-overflowed-in-flutter/) es el error de layout hermano: el flex hizo layout pero sus hijos no cupieron, que es un modo de fallo distinto a un box sin tamaño.
- [Solución: setState() or markNeedsBuild() called during build en Flutter](/es/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) es el otro error de "toqué el framework en el momento equivocado", y comparte la solución del post-frame-callback.
- [Cómo perfilar el jank de una app Flutter con DevTools](/es/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) configura la misma sesión de DevTools cuyo Layout Explorer señala la restricción no acotada detrás de este error.
- [Cómo disponer controllers en Flutter para evitar fugas de memoria](/es/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) cubre la disciplina de `mounted` y de ciclo de vida que mantiene seguras las lecturas de tamaño post-frame.

## Fuentes

- [Understanding constraints](https://docs.flutter.dev/ui/layout/constraints), la explicación canónica de cómo encajan las restricciones, los tamaños y el protocolo de layout.
- [Referencia de la API RenderBox.size](https://api.flutter.dev/flutter/rendering/RenderBox/size.html), que indica que el tamaño de un box solo es válido durante y después de `performLayout` y requiere `parentUsesSize: true` para las lecturas del padre.
- [Common Flutter errors](https://docs.flutter.dev/testing/common-errors), la lista oficial que define los errores de viewport no acotado y de desbordamiento que causan la mayoría de estas cascadas.
- [flutter/flutter issue #130967](https://github.com/flutter/flutter/issues/130967), un reporte representativo de la aserción `hasSize` disparándose desde un viewport con shrink-wrap al que se le dieron restricciones no acotadas.
