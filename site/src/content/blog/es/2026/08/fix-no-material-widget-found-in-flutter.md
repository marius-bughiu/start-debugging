---
title: "Solución: No Material widget found en Flutter"
description: "Envuelve el subárbol en Material(type: MaterialType.transparency) o coloca la pantalla dentro de un Scaffold. MaterialApp por sí solo no aporta un ancestro Material, por eso TextField e InkWell fallan."
pubDate: 2026-08-04
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "material"
lang: "es"
translationOf: "2026/08/fix-no-material-widget-found-in-flutter"
translatedBy: "claude"
translationDate: 2026-08-04
---

`No Material widget found` significa que el widget que acabas de construir (`TextField`, `InkWell`, `ListTile`, `Chip`, `Switch`, `Slider` y compañía) subió por el árbol buscando un ancestro `Material` y no lo encontró. La solución rápida y segura es envolver el subárbol en `Material(type: MaterialType.transparency, child: ...)`, que no cambia nada visualmente. La solución estructural es colocar la pantalla dentro de un `Scaffold`. Ten en cuenta que `MaterialApp` por sí solo **no** aporta un `Material`. Verificado con Flutter 3.44 stable, Dart 3.x.

## El error en contexto

La aserción se lanza desde el método `build` del widget que falla, así que la primera línea nombra al widget que no pudo encontrar su ancestro:

```
======== Exception caught by widgets library ===================================
The following assertion was thrown building TextField(dirty, state: _TextFieldState#3f2a1):
No Material widget found.

TextField widgets require a Material widget ancestor within the closest LookupBoundary.
In Material Design, most widgets are conceptually "printed" on a sheet of
material. In Flutter's material library, that material is represented by the
Material widget. It is the Material widget that renders ink splashes, for
instance. Because of this, many material library widgets require that there be
a Material widget in the tree above them.

To introduce a Material widget, you can either directly include one, or use a
widget that contains Material itself, such as a Card, Dialog, Drawer, or
Scaffold.

The specific widget that could not find a Material ancestor was:
  TextField
The ancestors of this widget were:
  Center
  Semantics
  ...
```

Existe una segunda redacción con la que te puedes encontrar, y es un problema genuinamente distinto:

```
No Material widget found within the closest LookupBoundary.
There is an ancestor Material widget, but it is hidden by a LookupBoundary.
```

Esa significa que sí existe un `Material` por encima de ti, pero un `LookupBoundary` está bloqueando el recorrido a propósito. Tiene su propia sección más abajo.

## Qué widgets requieren realmente un ancestro Material

Esto importa porque la lista es más corta que "todo lo que hay en `package:flutter/material.dart`". Buscar `assert(debugCheckHasMaterial(context))` en `packages/flutter/lib/src/material/` en la rama stable de Flutter 3.44 da el conjunto real:

- `InkWell`, `InkResponse` (vía `InkResponse.debugCheckContext`) e `Ink`
- `TextField`
- `ListTile`
- `Chip`, `InputChip`, `ActionChip`, `ChoiceChip`, `FilterChip`
- `Checkbox`, `Radio`, `Switch`, `Slider`
- `DropdownButton`
- `DataTable`
- `TabBar`
- `Stepper`
- `ExpandIcon`

Igual de útil es lo que *no* está en la lista. `ElevatedButton`, `FilledButton`, `OutlinedButton`, `TextButton`, `FloatingActionButton`, `Card` y `Tooltip` no hacen la aserción, porque cada uno construye internamente su propio `Material` y luego coloca la superficie de tinta debajo de su propio hijo. Por eso una pantalla llena de botones funciona sin problema fuera de un `Scaffold` hasta que agregas un solo `TextField` y todo revienta.

`IconButton` es un caso especial que conviene conocer. Su aserción vive únicamente en la ruta de código de Material 2: `build` retorna anticipadamente a través de `_SelectableIconButton` cuando `theme.useMaterial3` es true, y el `assert(debugCheckHasMaterial(context))` viene después de ese return. Como `useMaterial3` tiene el valor por defecto `true` desde Flutter 3.16, un `IconButton` estándar ya no necesita un ancestro `Material`. Regresa tu tema a `useMaterial3: false` y volverá a fallar.

## Por qué MaterialApp no basta

Esta es la parte que atrapa a casi todo el mundo, y no resulta obvia por el nombre. `MaterialApp` te da un `Theme`, `MaterialLocalizations`, un `Navigator`, un `ScaffoldMessenger` y un `WidgetsApp`. No inserta un `Material` en ninguna parte. No existe ni una sola construcción `Material(` en `packages/flutter/lib/src/material/app.dart`.

El `Material` viene del `Scaffold`. El `build` de su estado envuelve todo el diseño en uno:

```dart
// Flutter 3.44, packages/flutter/lib/src/material/scaffold.dart
child: ScrollNotificationObserver(
  child: Material(
    color: widget.backgroundColor ?? themeData.scaffoldBackgroundColor,
    child: Builder(...),
  ),
),
```

Lo mismo vale para `Card`, `Dialog`, `Drawer` y la hoja que construye `showModalBottomSheet`: cada uno construye un `Material` alrededor de su hijo. Esa es exactamente la lista que te da la pista del error, y es esa lista porque son los widgets que realmente lo hacen.

## La reproducción mínima

Doce líneas, y falla en el primer frame:

```dart
// Flutter 3.44, Dart 3.x
import 'package:flutter/material.dart';

void main() => runApp(const MyApp());

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      home: Center(child: TextField()), // throws: No Material widget found.
    );
  }
}
```

Cambia `TextField` por `ElevatedButton` y se renderiza. Cámbialo por `ListTile` y vuelve a fallar. El ingrediente que falla nunca es `MaterialApp`, es la ausencia de un `Scaffold` (o de cualquier otro portador de `Material`) entre la aplicación y el widget.

## Solución 1: coloca la pantalla dentro de un Scaffold

Si el widget que falla forma parte de una pantalla, esta es la solución correcta, no un parche. Obtienes el `Material`, más el color de fondo, el espacio para la barra de aplicación, el manejo del área segura y los desplazamientos del teclado sobre los que el widget fue implícitamente diseñado para apoyarse:

```dart
// Flutter 3.44, Dart 3.x
class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      home: Scaffold(
        appBar: AppBar(title: const Text('Sign in')),
        body: const Padding(
          padding: EdgeInsets.all(16),
          child: TextField(
            decoration: InputDecoration(labelText: 'Email'),
          ),
        ),
      ),
    );
  }
}
```

Recurre a alguna de las otras soluciones solo cuando un `Scaffold` genuinamente no corresponda: una entrada de overlay, una prueba de widget, un fragmento renderizado fuera del árbol de rutas normal.

## Solución 2: Material con MaterialType.transparency

Cuando necesitas la superficie de tinta pero no los efectos visuales, esta es la solución que no te cuesta nada:

```dart
// Flutter 3.44, Dart 3.x
Material(
  type: MaterialType.transparency,
  child: InkWell(
    onTap: _handleTap,
    child: const Padding(
      padding: EdgeInsets.all(12),
      child: Text('Tap me'),
    ),
  ),
)
```

El tipo importa más de lo que parece. Dos cosas cambian según él, ambas visibles en el método build de `Material`:

```dart
// Flutter 3.44, packages/flutter/lib/src/material/material.dart
final Color? backgroundColor = widget.color ?? switch (widget.type) {
  MaterialType.canvas => theme.canvasColor,
  MaterialType.card => theme.cardColor,
  MaterialType.button || MaterialType.circle || MaterialType.transparency => null,
};
// ...
child: _InkFeatures(
  absorbHitTest: widget.type != MaterialType.transparency,
  color: backgroundColor,
  ...
),
```

Un `Material(child: ...)` pelado usa por defecto `MaterialType.canvas`, que pinta un rectángulo opaco de `theme.canvasColor` sobre lo que hubiera detrás y establece `absorbHitTest: true`, tragándose los eventos de puntero que antes pasaban hacia los widgets de abajo. `MaterialType.transparency` no pinta nada y no absorbe nada. Si estás parcheando un diseño existente, empieza siempre con `transparency` para no cambiar un fallo por un gesto silenciosamente roto o una caja blanca sobre tu degradado.

Una cosa de la que `transparency` no te libra: `Material` siempre envuelve a su hijo en un `AnimatedDefaultTextStyle` usando `widget.textStyle ?? Theme.of(context).textTheme.bodyMedium`. Si un `Text` sin estilo dentro del subárbol recién envuelto cambia de repente de tamaño o color, esa es la razón. Pasa un `textStyle` explícito, o define el estilo en los propios widgets `Text`.

## Solución 3: usa un widget contenedor que ya lleve un Material

A veces la respuesta correcta no es ni `Scaffold` ni un `Material` en crudo, porque el contenedor ya era lo que querías:

```dart
// Flutter 3.44, Dart 3.x
Card(
  child: ListTile(                    // ListTile asserts; Card supplies the Material
    leading: const Icon(Icons.person),
    title: const Text('Marius'),
    onTap: _openProfile,
  ),
)
```

`showDialog`, `showModalBottomSheet` y `Drawer` te dan un `Material` gratis, así que `ListTile` y `TextField` funcionan dentro de ellos sin un `Scaffold`. El modo de fallo que hay que vigilar es `showGeneralDialog`, cuyo `pageBuilder` devuelve tu widget en crudo, sin ningún envoltorio `Material`. Envuélvelo tú, o usa `Dialog`.

Las entradas de `Overlay` tienen la misma forma de problema. El builder de un `OverlayEntry` se monta como hijo del `Overlay`, no de tu `Scaffold`, así que no hereda el `Material` del `Scaffold` sin importar qué tan profundo en el árbol viva el código que lo insertó.

## Solución 4: quien use WidgetsApp necesita MaterialApp

Si la raíz de tu aplicación es `WidgetsApp` o `CupertinoApp` y de todos modos estás usando widgets de Material, obtienes este error más su hermano `No MaterialLocalizations found`. Esto se cerró como uso inválido en [flutter/flutter#103843](https://github.com/flutter/flutter/issues/103843), y los mantenedores tienen razón: o bien pasas a `MaterialApp`, o bien agregas tú mismo los ámbitos `Material` y `Localizations`. `MaterialApp` es la respuesta más barata para casi todo el mundo.

## La variante de LookupBoundary

La redacción `within the closest LookupBoundary` significa que el recorrido fue interceptado. `debugCheckHasMaterial` usa `LookupBoundary.findAncestorWidgetOfExactType<Material>(context)`, no el recorrido simple de elementos, y un `LookupBoundary` lo detiene en seco incluso cuando hay un `Material` perfectamente válido más arriba.

En el código del framework, el único lugar que inserta uno es `view.dart`:

```dart
// Flutter 3.44, packages/flutter/lib/src/widgets/view.dart (ViewAnchor.build)
return _MultiChildComponentWidget(
  views: <Widget>[if (view != null) LookupBoundary(child: view!)],
  child: child,
);
```

Así que si estás renderizando en una segunda `FlutterView` a través de `ViewAnchor` (un tooltip en su propia vista de plataforma, una ventana secundaria de escritorio), la barrera es intencional: el contenido de esa vista es un árbol de renderizado separado y no debe depender silenciosamente de ancestros de la vista anfitriona. La solución es dar a la nueva vista su propio `Material` (o su propio `Scaffold`) en lugar de intentar atravesar la barrera. Esta es una de las aristas más filosas cuando [habilitas soporte multiventana en una aplicación de escritorio Flutter](/es/2026/08/how-to-enable-multi-window-support-in-a-flutter-desktop-app/).

Si insertaste tú mismo un `LookupBoundary` para aislar un subárbol, aplica la misma regla: todo lo que el subárbol necesite tiene que vivir dentro de él.

## Trampas y falsos parecidos

**En debug falla, en release no.** `debugCheckHasMaterial` está envuelto en `assert(() { ... }())`, así que se elimina por completo de las compilaciones de release y la función simplemente devuelve `true`. Un `TextField` sin `Material` se renderiza en `--release` y falla en debug, que es exactamente la confusión detrás del issue 103843. No tomes el "funciona en release" como prueba de que el árbol está bien. En el momento en que un efecto de tinta se dispare de verdad, se ejecuta `Material.of(context)`, y ese sí lanza también en release: "Material.of() was called with a context that does not contain a Material widget."

**El splash es invisible pero no hay error.** Bug distinto, mismo vecindario. Los splashes de tinta se pintan sobre el propio `Material`, *debajo* de todo lo dibujado encima, así que un `InkWell` envuelto en un `Container(color: ...)` pinta su splash detrás del relleno opaco del container. Cambia `Container(color: x)` por `Ink(color: x)` (o define el color en el `Material`), porque `Ink` pinta su decoración sobre el `Material` padre para que el splash quede encima. Relacionado: [Cannot provide both a color and a decoration en un Container de Flutter](/es/2026/07/fix-cannot-provide-both-a-color-and-a-decoration-in-a-flutter-container/).

**Las pruebas de widget fallan donde la aplicación funciona.** `tester.pumpWidget(const TextField())` falla por la misma razón que `runApp`. Las pruebas de widget necesitan los ancestros explícitos: `MaterialApp(home: Scaffold(body: TextField()))`, o como mínimo `Material(child: Directionality(textDirection: TextDirection.ltr, child: ...))`. La falta de `Directionality` y la falta de `MediaQuery` producen la misma forma de error desde `debugCheckHasDirectionality` y `MediaQuery.of`.

**No envuelvas toda la aplicación en un solo Material.** Funciona, y es una trampa. Un único `Material` a nivel de aplicación hace que todos los splashes de tinta de la app se rendericen sobre una sola superficie, anula los colores de fondo por pantalla y aplica un único estilo de texto `bodyMedium` por defecto en todas partes. Agrega el `Material` en el ámbito más pequeño que corrija el error.

**Anidar Material cambia sobre qué superficie caen los splashes.** `Material.of` resuelve el ancestro *más cercano*, así que un `Material` interno con un `borderRadius` o un `shape` recorta los splashes a esa forma. Normalmente eso es lo que quieres para una tarjeta personalizada, y ocasionalmente es la razón por la que un splash se ve cuadrado cuando lo esperabas redondeado.

**`No MaterialLocalizations found` es otro ancestro faltante.** Mismo mecanismo de recorrido hacia arriba, ámbito distinto, emitido por `debugCheckHasMaterialLocalizations`. Agregar un `Material` no lo va a arreglar; agregar un `MaterialApp` o un delegado de `Localizations` sí.

## Relacionados

- [Solución: ScaffoldMessenger.of() was called with a context that does not contain a Scaffold](/es/2026/07/fix-scaffoldmessenger-of-context-does-not-contain-a-scaffold-in-flutter/): el mismo fallo de búsqueda de ancestros, una capa más arriba, además del truco del `Builder` para obtener un contexto por debajo del widget que necesitas.
- [Solución: Looking up a deactivated widget's ancestor is unsafe en Flutter](/es/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/): cuando el ancestro existe pero la búsqueda ocurre en el momento equivocado del ciclo de vida.
- [Solución: Incorrect use of ParentDataWidget. Expanded widgets must be placed inside Flex widgets](/es/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/): otra aserción estructural de "lugar equivocado en el árbol de widgets" que Flutter detecta durante el build.
- [Cómo habilitar el soporte multiventana en una aplicación de escritorio Flutter](/es/2026/08/how-to-enable-multi-window-support-in-a-flutter-desktop-app/): dónde `LookupBoundary` empieza a bloquear búsquedas de ancestros en aplicaciones reales.
- [Cómo definir el color de acento en una aplicación Flutter con el ColorScheme de Material 3](/es/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/): el `canvasColor` y el `scaffoldBackgroundColor` que un `Material` toma cuando no le pasas ninguno.

## Fuentes

- [debugCheckHasMaterial, referencia de la API de Flutter](https://api.flutter.dev/flutter/material/debugCheckHasMaterial.html): la aserción en sí, incluida la rama de `LookupBoundary` y el texto exacto de la pista.
- [Clase Material, referencia de la API de Flutter](https://api.flutter.dev/flutter/material/Material-class.html): los valores de `MaterialType`, el recorte, la elevación y cómo se adjuntan los efectos de tinta.
- [Clase Ink, referencia de la API de Flutter](https://api.flutter.dev/flutter/material/Ink-class.html): por qué los splashes quedan ocultos por una decoración opaca dibujada sobre el `Material`, y cómo `Ink` lo evita.
- [flutter/flutter#103843: Error "No Material widget found.", but not in release build](https://github.com/flutter/flutter/issues/103843): la aserción exclusiva de debug confirmada por los mantenedores, cerrada como uso inválido de `WidgetsApp`.
- [flutter/flutter `packages/flutter/lib/src/material/debug.dart` (stable)](https://github.com/flutter/flutter/blob/stable/packages/flutter/lib/src/material/debug.dart): el código fuente de `debugCheckHasMaterial` y `debugCheckHasMaterialLocalizations`.
