---
title: "Solución: A RenderFlex overflowed by N pixels on the bottom cuando se abre el teclado en Flutter"
description: "El teclado reduce la altura máxima del cuerpo del Scaffold, así que una Column que apenas cabía ahora se desborda. Envuelve el cuerpo en un scrollable en lugar de desactivar resizeToAvoidBottomInset."
pubDate: 2026-08-01
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "layout"
  - "keyboard"
lang: "es"
translationOf: "2026/08/fix-renderflex-overflowed-on-the-bottom-when-the-keyboard-opens-in-flutter"
translatedBy: "claude"
translationDate: 2026-08-01
---

Envuelve el cuerpo del `Scaffold` en un `SingleChildScrollView` (o convierte la `Column` en un `ListView`). El teclado no se superpone a tu layout, lo encoge: `Scaffold` resta `MediaQuery.viewInsets.bottom` de la altura máxima que entrega al cuerpo, así que una `Column` que llenaba exactamente la pantalla ahora se pasa del presupuesto por la altura del teclado. Poner `resizeToAvoidBottomInset: false` también silencia la franja, pero lo hace dejando que el teclado tape tu campo de texto, que casi nunca es lo que quieres. Este post está escrito contra Flutter 3.x (probado en 3.44) y Dart 3.x.

```text
The following assertion was thrown during layout:
A RenderFlex overflowed by 291 pixels on the bottom.

The relevant error-causing widget was:
  Column  Column:file:///Users/me/app/lib/screens/login_screen.dart:37:18

The overflowing RenderFlex has an orientation of Axis.vertical.
The edge of the RenderFlex that is overflowing has been marked in the
rendering with a yellow and black striped pattern.
```

La señal de que se trata de la variante del teclado y no del [desbordamiento genérico de RenderFlex](/es/2026/05/fix-renderflex-overflowed-in-flutter/) es el momento en que ocurre: el layout está limpio hasta que tocas un `TextField`, el número del desbordamiento se parece sospechosamente a la altura del teclado (de 250 a 350 píxeles lógicos en la mayoría de los celulares) y desaparece en cuanto cierras el teclado.

## Por qué el teclado encoge el cuerpo en lugar de taparlo

En Android, la plantilla de proyecto de Flutter define `android:windowSoftInputMode="adjustResize"` en `MainActivity`, así que la plataforma redimensiona la vista de Flutter en lugar de desplazarla. El motor reporta la región cubierta a Dart como `MediaQueryData.viewInsets`, que la documentación de la API define con precisión: cuando el teclado de un dispositivo móvil está visible, `viewInsets.bottom` corresponde al borde superior del teclado.

Después `Scaffold` hace la aritmética. En `_ScaffoldState.build` calcula los insets mínimos que debe mantener libres:

```dart
// packages/flutter/lib/src/material/scaffold.dart, Flutter 3.x
final EdgeInsets minInsets = MediaQuery.paddingOf(
  context,
).copyWith(bottom: _resizeToAvoidBottomInset ? MediaQuery.viewInsetsOf(context).bottom : 0.0);
```

y en `_ScaffoldLayout.performLayout` lo convierte en el presupuesto de altura del cuerpo:

```dart
// packages/flutter/lib/src/material/scaffold.dart, Flutter 3.x
final double contentBottom = math.max(
  0.0,
  bottom - math.max(minInsets.bottom, bottomWidgetsHeight),
);

if (hasChild(_ScaffoldSlot.body)) {
  double bodyMaxHeight = math.max(0.0, contentBottom - contentTop);
  // ...
```

`_resizeToAvoidBottomInset` es `widget.resizeToAvoidBottomInset ?? true`, así que este es el camino por defecto. En una pantalla de 852 píxeles de alto con una barra de aplicación de 56 píxeles y un teclado de 291 píxeles, el `maxHeight` del cuerpo baja de 796 a 505. Tu `Column` sigue queriendo 796. `RenderFlex` no recorta ni desplaza, así que pinta la advertencia a rayas y reporta la diferencia, que es exactamente los 291 píxeles del mensaje. El número es la altura del teclado porque antes el layout cabía sin holgura.

## Una reproducción que cabe en una pantalla y luego ya no

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
import 'package:flutter/material.dart';

void main() => runApp(const MaterialApp(home: LoginScreen()));

class LoginScreen extends StatelessWidget {
  const LoginScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Sign in')),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            const FlutterLogo(size: 160),
            const TextField(decoration: InputDecoration(labelText: 'Email')),
            const TextField(
              obscureText: true,
              decoration: InputDecoration(labelText: 'Password'),
            ),
            FilledButton(onPressed: () {}, child: const Text('Sign in')),
          ],
        ),
      ),
    );
  }
}
```

Esto se renderiza perfectamente. Toca cualquiera de los dos campos y aparece el desbordamiento. Nada cambió en el árbol de widgets; solo cambió el `maxHeight` entrante.

## Las soluciones, en el orden en que deberías probarlas

### 1. Haz que el cuerpo sea desplazable

Esta es la solución correcta para prácticamente cualquier formulario, y es lo que recomienda la [documentación de errores comunes de Flutter](https://docs.flutter.dev/testing/common-errors) para un desbordamiento inferior. Un viewport le da a su hijo espacio ilimitado en el eje principal, así que a la `Column` deja de importarle lo que el teclado le hizo al `Scaffold`:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
body: SingleChildScrollView(
  padding: const EdgeInsets.all(24),
  child: Column(
    children: [
      const FlutterLogo(size: 160),
      const SizedBox(height: 24),
      const TextField(decoration: InputDecoration(labelText: 'Email')),
      const SizedBox(height: 12),
      const TextField(
        obscureText: true,
        decoration: InputDecoration(labelText: 'Password'),
      ),
      const SizedBox(height: 24),
      FilledButton(onPressed: () {}, child: const Text('Sign in')),
    ],
  ),
),
```

Dos cosas más que cambiar ya que estás ahí. Quita `mainAxisAlignment: MainAxisAlignment.spaceBetween`: dentro de un viewport el espacio disponible es infinito, así que la alineación en el eje principal no tiene nada que distribuir y en silencio no hace nada. Reemplaza el espaciado con `SizedBox` explícitos. Y si la lista es larga o se construye a partir de datos, usa `ListView` o `ListView.builder` para que los hijos se construyan de forma diferida; los compromisos son los mismos que cubre [shrinkWrap vs Expanded vs slivers para listas largas](/es/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/).

Esta solución te da un extra: `EditableText` desplaza el campo enfocado hasta hacerlo visible a través del `Scrollable` ancestro más cercano, con el relleno de `TextField.scrollPadding`, cuyo valor por defecto es `EdgeInsets.all(20.0)`. Sin un ancestro desplazable no hay nada que desplazar, y por eso a veces el campo bajo tu dedo sigue oculto aunque el desbordamiento no sea visible.

### 2. Llenar la pantalla cuando hay espacio y desplazarse cuando no lo hay

La solución del scroll view tiene un costo estético: en una pantalla alta con el teclado cerrado, el contenido se amontona arriba en vez de repartirse. El patrón de la [documentación de la API de SingleChildScrollView](https://api.flutter.dev/flutter/widgets/SingleChildScrollView-class.html) lo arregla dándole a la `Column` una altura mínima igual al viewport y obligándola a ser exactamente tan alta como su contenido cuando este es mayor:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
body: LayoutBuilder(
  builder: (context, viewportConstraints) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: ConstrainedBox(
        constraints: BoxConstraints(minHeight: viewportConstraints.maxHeight - 48),
        child: IntrinsicHeight(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: const [
              FlutterLogo(size: 160),
              TextField(decoration: InputDecoration(labelText: 'Email')),
              TextField(
                obscureText: true,
                decoration: InputDecoration(labelText: 'Password'),
              ),
            ],
          ),
        ),
      ),
    );
  },
),
```

Los dos envoltorios cargan peso. Sin `ConstrainedBox` la columna se ajusta a su contenido y nunca llena una pantalla alta; sin `IntrinsicHeight` toma la altura mínima incluso cuando sus hijos necesitan más, y vuelves al desbordamiento. `LayoutBuilder` ve las restricciones posteriores al teclado porque está dentro del slot del cuerpo, así que `viewportConstraints.maxHeight` ya tiene el teclado restado.

La documentación es directa sobre el costo: esto hace el layout del subárbol dos veces, una para los intrínsecos y otra de verdad. Está bien para un formulario de inicio de sesión, mal para una página de ajustes de cincuenta filas.

### 3. Usa SliverFillRemaining en lugar de IntrinsicHeight

Si la pasada de intrínsecos aparece en tus tiempos de frame, expresa la misma intención con slivers. `SliverFillRemaining(hasScrollBody: false)` deja que el hijo llene el viewport restante y, según su contrato de API, si la extensión del hijo excede el viewport el sliver cede al tamaño del hijo en vez de imponerle el suyo, que es precisamente el comportamiento que quieres cuando llega el teclado:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
body: CustomScrollView(
  slivers: [
    SliverFillRemaining(
      hasScrollBody: false,
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: const [
            FlutterLogo(size: 160),
            TextField(decoration: InputDecoration(labelText: 'Email')),
            TextField(
              obscureText: true,
              decoration: InputDecoration(labelText: 'Password'),
            ),
          ],
        ),
      ),
    ),
  ],
),
```

Una regla que hay que recordar aquí: todo lo que esté directamente bajo `CustomScrollView.slivers` tiene que ser un sliver. Poner ahí una `Column` sin envolverla produce [RenderViewport expected a RenderSliver child](/es/2026/07/fix-renderviewport-expected-a-rendersliver-in-a-flutter-customscrollview/).

### 4. resizeToAvoidBottomInset: false, y solo a propósito

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
Scaffold(
  resizeToAvoidBottomInset: false,
  body: /* ... */,
)
```

Vuelve a leer el código fuente de arriba: esto pone `minInsets.bottom` en `0.0`, el cuerpo conserva su altura completa y el teclado se pinta encima de lo que haya ahí abajo. No se arregla nada, simplemente la advertencia de desbordamiento se queda sin nada de qué avisar. Es legítimo en una pantalla cuyo campo de entrada está en el tercio superior, en un mapa o vista de cámara a pantalla completa donde redimensionar sería brusco, o en una pantalla de chat donde manejas el inset tú mismo. Es la respuesta equivocada para un formulario, porque el campo en el que el usuario está escribiendo es justo lo que queda detrás del teclado.

## Detalles que hacen dar vueltas en círculo

**`viewInsets.bottom` vale `0` dentro del cuerpo del Scaffold.** Esta es la parte más confusa de todo el tema. `Scaffold` le pasa al cuerpo un `MediaQuery` modificado:

```dart
// packages/flutter/lib/src/material/scaffold.dart, Flutter 3.x
if (removeBottomInset) {
  data = data.removeViewInsets(removeBottom: true);
}
```

y el slot del cuerpo se registra con `removeBottomInset: _resizeToAvoidBottomInset`. Así que con la configuración por defecto, un widget dentro de `Scaffold.body` que lea `MediaQuery.viewInsetsOf(context).bottom` obtiene `0.0` incluso con el teclado abierto, porque `Scaffold` ya consumió ese inset encogiendo el cuerpo. Añadir a mano `Padding(padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom))` ahí dentro no hace nada. Para leer el valor real, léelo por encima del `Scaffold`, o pon `resizeToAvoidBottomInset: false` y encárgate tú del manejo del inset.

**Los modal bottom sheets son la excepción.** Una ruta de `showModalBottomSheet` no es el cuerpo de un `Scaffold`, así que ahí `viewInsets` está intacto y el truco del padding es la solución correcta. Combínalo con `isScrollControlled: true`, si no la hoja queda limitada a media pantalla:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
showModalBottomSheet(
  context: context,
  isScrollControlled: true,
  builder: (context) => Padding(
    padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
    child: const ComposeForm(),
  ),
);
```

**Un bottomNavigationBar no se suma al teclado.** `contentBottom` usa `math.max(minInsets.bottom, bottomWidgetsHeight)`, no la suma. En cuanto el teclado es más alto que la barra de navegación, el cuerpo se encoge solo por la altura del teclado, y la barra conserva su lugar al fondo del scaffold, debajo del teclado. Si quieres que desaparezca mientras se escribe, ocúltala tú: lee `MediaQuery.viewInsetsOf(context).bottom` desde un `Builder` colocado por encima del `Scaffold` y pasa `bottomNavigationBar: inset > 0 ? null : const MyNavBar()`.

**Alguien cambió `windowSoftInputMode` a `adjustPan`.** Si el desbordamiento nunca aparece en Android pero el campo queda tapado, o `viewInsets.bottom` se queda en `0` para siempre, revisa `android/app/src/main/AndroidManifest.xml`. La plantilla de Flutter trae `android:windowSoftInputMode="adjustResize"`; en algún momento una respuesta de Stack Overflow convenció a alguien de usar `adjustPan`, y ahora la plataforma está desplazando la ventana en lugar de reportar un inset.

**Envolver al culpable en `Expanded` es el reflejo equivocado aquí.** `Expanded` es la solución para el caso horizontal en el que un hijo voraz se come una `Row`. En el caso del teclado todos los hijos ya están en su tamaño natural y el total simplemente excede el presupuesto, así que `Expanded` le roba espacio a un widget que lo necesitaba o mueve el desbordamiento a un hermano. Y un `Expanded` que termina fuera de un `Flex` te da [Incorrect use of ParentDataWidget](/es/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/) en su lugar.

**Cierra el teclado al arrastrar.** Una vez que el cuerpo se desplaza, añade `keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag` al scroll view. Cuesta una línea y elimina la queja más común sobre las pantallas de formulario.

**Errores parecidos.** `Vertical viewport was given unbounded height` es la imagen espejo, un desplazable dentro de un padre sin límites, cubierto en [anidar un ListView dentro de una Column](/es/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/). `RenderBox was not laid out` suele ser la segunda excepción tras un fallo de layout real; sube hasta la primera. Y si el desbordamiento aparece con una escala de texto de 1.5x en vez de al abrir el teclado, es el mismo tipo de bug con otro disparador, que el [post general sobre desbordamiento de RenderFlex](/es/2026/05/fix-renderflex-overflowed-in-flutter/) cubre en detalle.

## Relacionados

- [Solución: A RenderFlex overflowed by N pixels en Flutter](/es/2026/05/fix-renderflex-overflowed-in-flutter/) es el post padre para las variantes horizontal y de escala de texto de la misma aserción.
- [Cómo anidar un ListView dentro de una Column sin el error de altura sin límites](/es/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/) cubre el caso en que el formulario mismo contiene una lista.
- [shrinkWrap vs Expanded vs slivers para listas largas en Flutter](/es/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/) explica por qué `ListView.builder` le gana a un `SingleChildScrollView` cuando el contenido crece.
- [Solución: RenderViewport expected a RenderSliver child](/es/2026/07/fix-renderviewport-expected-a-rendersliver-in-a-flutter-customscrollview/) es el error que te espera si tomas el camino de los slivers.
- [Solución: Incorrect use of ParentDataWidget, Expanded debe estar dentro de Flex](/es/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/) cubre el modo de fallo de recurrir a `Expanded` demasiado rápido.

## Fuentes

- [Common Flutter errors](https://docs.flutter.dev/testing/common-errors), la página oficial que define la aserción de desbordamiento de RenderFlex y sus soluciones canónicas.
- [Scaffold.resizeToAvoidBottomInset](https://api.flutter.dev/flutter/material/Scaffold/resizeToAvoidBottomInset.html), que documenta el valor por defecto `true` y su dependencia de `MediaQueryData.viewInsets`.
- [MediaQueryData.viewInsets](https://api.flutter.dev/flutter/widgets/MediaQueryData/viewInsets.html), origen de la definición "viewInsets.bottom corresponde al borde superior del teclado" y de la separación respecto a `padding` y `viewPadding`.
- [scaffold.dart en la rama stable](https://github.com/flutter/flutter/blob/stable/packages/flutter/lib/src/material/scaffold.dart), donde viven `minInsets`, `contentBottom` y la llamada a `removeViewInsets` del cuerpo.
- [Referencia de la clase SingleChildScrollView](https://api.flutter.dev/flutter/widgets/SingleChildScrollView-class.html), que documenta la receta de `LayoutBuilder` más `ConstrainedBox` más `IntrinsicHeight` y su costo.
- [Referencia de la clase SliverFillRemaining](https://api.flutter.dev/flutter/widgets/SliverFillRemaining-class.html), para la semántica exacta de `hasScrollBody: false`.
- [EditableText.scrollPadding](https://api.flutter.dev/flutter/widgets/EditableText/scrollPadding.html), que explica el comportamiento automático de desplazar hasta hacer visible y su valor por defecto `EdgeInsets.all(20.0)`.
