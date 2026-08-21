---
title: "Solución: la UI de Flutter se superpone a la barra de navegación del sistema Android al apuntar al SDK 35"
description: "Apuntar al SDK 35 de Android pone tu app Flutter en modo edge-to-edge, así que el cuerpo del Scaffold se dibuja detrás de la barra de navegación. Consume los insets con SafeArea y el padding de MediaQuery en lugar de desactivarlo, porque esa exclusión ya está muerta en Android 16."
pubDate: 2026-08-21
template: how-to
tags:
  - "flutter"
  - "dart"
  - "android"
  - "layout"
lang: "es"
translationOf: "2026/08/fix-flutter-ui-overlaps-the-android-navigation-bar-after-targeting-sdk-35"
translatedBy: "claude"
translationDate: 2026-08-21
---

Tus botones funcionaban en la versión anterior. Ahora la fila inferior de tu `Scaffold` queda debajo de la barra de navegación de Android, medio visible y medio pulsable, y nada en tu código de layout cambió. Lo que cambió es el SDK objetivo: en cuanto una app Flutter apunta al SDK 35 de Android (API 35, Android 15), Android la ejecuta en modo edge-to-edge, y la ventana de tu app ahora abarca toda la altura de la pantalla, incluida la franja que ocupan las barras del sistema. La solución no es recuperar esa franja, es leer el inset que Android reporta y aplicar ese espacio a tu propio contenido. Envuelve el contenido anclado abajo en `SafeArea`, y agrega padding a los scrollables con `MediaQuery.paddingOf(context).bottom` para que la lista se desplace por debajo de la barra pero se detenga antes de ella. No recurras a `android:windowOptOutEdgeToEdgeEnforcement`: el `targetSdkVersion` por defecto de Flutter es 36 desde bastante antes de la versión estable actual, y en API 36 esa exclusión está obsoleta y deshabilitada.

Todo lo que sigue fue verificado contra Flutter 3.44.2 (Dart 3.12.2), con los valores por defecto del SDK contrastados con la versión estable actual, Flutter 3.47.1 (publicada el 2026-08-19, Dart 3.13.1).

## Por qué desaparecieron 48 píxeles lógicos del fondo de tu app

Antes de Android 15, una app que no activaba explícitamente el modo edge-to-edge recibía una ventana que terminaba donde empezaban las barras del sistema. La barra de navegación era opaca, pertenecía al sistema, y tu `Scaffold` simplemente nunca veía esos píxeles. El layout era fácil porque el sistema operativo hacía el trabajo de insets por ti.

Android 15 invirtió ese comportamiento por defecto. Según la guía de edge-to-edge de Android, "Edge-to-edge is enforced on Android 15 (API level 35) and higher once your app targets SDK 35." Tu ventana ahora abarca toda la pantalla. La barra de estado se vuelve transparente, la barra de navegación por gestos se vuelve transparente, y la barra de navegación de tres botones se vuelve translúcida. Android sigue diciéndote exactamente cuánto espacio ocupan esas barras, a través de los window insets, pero ya no descuenta ese espacio por ti.

Flutter heredó esto en el momento en que su objetivo por defecto se movió. La propia nota de migración del framework es directa sobre la secuencia: "Prior to Flutter 3.27, Flutter apps targeted Android 14 by default and didn't opt into edge-to-edge mode automatically." A partir de Flutter 3.27, las apps que usan `flutter.targetSdkVersion` apuntan a Android 15 y quedan incluidas automáticamente. El cambio aterrizó en `3.26.0-0.0.pre` y llegó a estable en 3.27.

Ese valor por defecto se movió otra vez desde entonces, que es la parte en la que están desactualizados casi todos los artículos sobre este error. En el plugin de Gradle que viene con Flutter 3.44.2, e idénticamente en la etiqueta 3.47.1, los valores por defecto son:

```kotlin
// packages/flutter_tools/gradle/src/main/kotlin/FlutterExtension.kt
// Identical in Flutter 3.44.2 and 3.47.1
val compileSdkVersion: Int = 36
val minSdkVersion: Int = 24
val targetSdkVersion: Int = 36
```

Así que una app recién creada con `flutter create` hoy no solo apunta al SDK donde edge-to-edge es el comportamiento por defecto. Apunta a aquel donde edge-to-edge es la única opción.

## Cómo se ve realmente la superposición en números

Vale la pena fijar esto con mediciones en lugar de capturas de pantalla, porque "se ve mal en mi Pixel" no es una afirmación depurable. Un widget test puede modelar el dispositivo con precisión: configura el `viewPadding` de la vista con una barra de estado de 24dp y una barra de navegación de tres botones de 48dp, pon `devicePixelRatio` en 1 para que los píxeles lógicos equivalgan a los físicos, y mide dónde caen los widgets en una ventana de 800dp de alto.

```dart
// Flutter 3.44.2 / Dart 3.12.2
void setNavBarView(WidgetTester tester) {
  tester.view.devicePixelRatio = 1.0;
  tester.view.physicalSize = const Size(400, 800);
  tester.view.viewInsets = FakeViewPadding.zero;
  tester.view.viewPadding = const FakeViewPadding(top: 24, bottom: 48);
  tester.view.padding = const FakeViewPadding(top: 24, bottom: 48);
  addTearDown(tester.view.reset);
}

testWidgets('bare Scaffold body is not inset from the nav bar', (t) async {
  setNavBarView(t);
  await t.pumpWidget(MaterialApp(
    home: Scaffold(
      body: Align(
        alignment: Alignment.bottomCenter,
        child: SizedBox(key: const Key('marker'), height: 10, width: 10),
      ),
    ),
  ));
  print('BODY_BOTTOM=${t.getRect(find.byKey(const Key('marker'))).bottom}');
});
```

Eso imprime `BODY_BOTTOM=800.0`. El borde inferior del marcador queda en 800, el fondo mismo de la pantalla, lo que significa que sus últimos 48 píxeles lógicos están debajo de la barra de navegación. `Scaffold.body` recibe la ventana completa y no hace nada para proteger a su hijo. Ese es todo el error, y funciona según lo diseñado.

## La solución en cuatro pasos

1. Mantén edge-to-edge activado y deja de buscar un interruptor para apagarlo. En API 36 no hay forma soportada de apagarlo, así que el tiempo dedicado a la exclusión es tiempo dedicado a construir algo que tendrás que quitar.

    ```dart
    // Flutter 3.44.2: nothing to add. edgeToEdge is already the default.
    ```

2. Envuelve el contenido anclado arriba y abajo en `SafeArea`. Esta es la herramienta correcta para contenido que nunca debe quedar bajo una barra: filas de botones inferiores, toolbars personalizadas, paneles flotantes, cualquier cosa posicionada con `Align` o `Positioned`.

    ```dart
    // Flutter 3.44.2
    Scaffold(
      body: SafeArea(
        child: Align(
          alignment: Alignment.bottomCenter,
          child: ElevatedButton(onPressed: _submit, child: const Text('Save')),
        ),
      ),
    )
    ```

3. Agrega padding a los scrollables en lugar de envolverlos. Un `ListView` dentro de un `SafeArea` obtiene un viewport que se detiene por encima de la barra de navegación, así que el contenido queda recortado en un borde duro y la barra translúcida muestra fondo vacío. Pasa el inset como padding de la lista: el viewport se mantiene a sangre completa y el contenido se desplaza bajo la barra pero igual se detiene por encima de ella.

    ```dart
    // Flutter 3.44.2
    ListView(
      padding: EdgeInsets.only(bottom: MediaQuery.paddingOf(context).bottom),
      children: rows,
    )
    ```

4. Verifica con un widget test en vez de a ojo, reutilizando el helper `setNavBarView` de arriba. Las alturas de barra específicas de cada dispositivo son exactamente el tipo de cosa que regresiona en silencio en un teléfono que no tienes.

La diferencia del paso 3 es medible. Con un `ListView` dentro de `SafeArea`, el borde inferior del viewport del scrollable mide 752.0, así que el viewport mismo queda 48 corto respecto de la ventana. Con el enfoque de padding, el borde inferior del viewport es 800.0 (a sangre completa, el contenido se desplaza visiblemente bajo la barra translúcida) mientras que el borde inferior de la última fila cae en 752.0, dando exactamente 48 píxeles lógicos de margen. El mismo margen para el contenido, el comportamiento correcto para el scroll.

## Los widgets inferiores de Material ya manejan esto, los tuyos no

La hora perdida más común aquí es agregar padding que Material ya agregó, y luego preguntarse por qué el espacio se ve duplicado. `Scaffold` sí aplica insets a algunos de sus slots, pero solo para los widgets que lo solicitan. Midiendo cada slot contra la misma barra de navegación simulada de 48dp:

| Widget | Alto renderizado | Borde superior | Resultado |
| --- | --- | --- | --- |
| `SizedBox(height: 56)` como `bottomNavigationBar` | 56.0 | 744.0 | se superpone, margen cero |
| `NavigationBar` (2 destinos) | 128.0 | 672.0 | los iconos libran la barra por 86.0 |
| `BottomAppBar` | 128.0 | 672.0 | absorbe el inset de 48dp |
| `FloatingActionButton` | por defecto | | borde inferior en 736.0, margen 64.0 |
| `AppBar` | 80.0 | 0.0 | borde superior del título en 38.0 |

Lee las dos primeras filas juntas, porque ahí está toda la lección. Un `SizedBox` de 56 de alto colocado en el slot `bottomNavigationBar` se renderiza exactamente con 56 de alto y llega hasta y=800, así que sus últimos 48 píxeles quedan bajo la barra. Un `NavigationBar` real con un alto nominal de 80 se renderiza en 128, que es 80 más el inset de 48dp que él mismo consumió. `BottomAppBar` se comporta igual. El `FloatingActionButton` termina en 736 dando 64 de margen: el inset de 48dp más el margen habitual de 16dp del Scaffold. `AppBar` se renderiza con 80 de alto, que son los 56dp de la toolbar más los 24dp de la barra de estado, así que la parte superior de la pantalla ya estaba resuelta mucho antes de todo esto.

La regla que se desprende: los widgets inferiores de Material crecen con el inset, los widgets personalizados en el mismo slot no. Si construiste una barra inferior propia, el padding es tuyo. Si ya usas `NavigationBar` y lo envuelves en un `SafeArea`, obtienes 96dp de espacio muerto y una barra que se ve rota.

## La trampa del teclado que hace parecer inestable a SafeArea

Esta es la parte que produce reportes de error que dicen "SafeArea funciona, pero solo a veces." No es inestable. Es `MediaQueryData.padding` haciendo exactamente lo que documenta.

Android reporta dos valores relacionados. `viewPadding` es el inset crudo que ocupan las barras del sistema. `padding` es ese mismo inset con `viewInsets` (el teclado) ya restado y acotado en cero. Cuando se abre el teclado virtual, este cubre la barra de navegación, así que el inset inferior que importaba para el layout desaparece. Medido con un teclado de 300dp abierto:

```text
KEYBOARD_UP padding.bottom=0.0 viewPadding.bottom=48.0
```

`SafeArea` lee `padding` por defecto, así que su inset inferior colapsa a cero en el instante en que aparece el teclado, y lo que hayas anclado abajo cae 48 píxeles lógicos. A veces eso es correcto, porque la barra realmente está cubierta. Cuando no lo es, `SafeArea` tiene una bandera para ello, y la implementación del framework es un intercambio de dos líneas:

```dart
// packages/flutter/lib/src/widgets/safe_area.dart, Flutter 3.44.2
EdgeInsets padding = MediaQuery.paddingOf(context);
// Bottom padding has been consumed - i.e. by the keyboard
if (maintainBottomViewPadding) {
  padding = padding.copyWith(bottom: MediaQuery.viewPaddingOf(context).bottom);
}
```

Poner `maintainBottomViewPadding: true` mantiene el espacio estable. Medidos lado a lado con el teclado abierto, un `SafeArea` simple da un espacio inferior de 0.0 y uno con la bandera da 48.0. Úsalo cuando un control inferior se anima junto con el teclado y no quieres que salte visiblemente. Este es el mismo tipo de problema que [un RenderFlex que se desborda por abajo cuando se abre el teclado](/es/2026/08/fix-renderflex-overflowed-on-the-bottom-when-the-keyboard-opens-in-flutter/), donde el teclado cambia las restricciones en lugar del padding.

## Anidar SafeArea no duplica el padding

Vale la pena saberlo antes de salir a cazar un espacio fantasma: `SafeArea` quita el padding que consumió del `MediaQuery` que entrega a su subárbol. Un `SafeArea` dentro de un `SafeArea` produce un espacio inferior de 48.0, no de 96.0. El interno ve padding cero y no agrega nada.

Eso es una buena noticia para la composición, porque puedes poner un `SafeArea` en un scaffold de página compartido y dejar que cada pantalla agregue el suyo sin auditar todo el árbol. Es una mala noticia para depurar, porque un espacio incorrecto nunca se debe al anidamiento doble, así que si tu espacio está mal la causa está en otro lado, normalmente un widget personalizado en un slot de `Scaffold` como se describió arriba.

## La exclusión existe, caduca y puede hacerte crashear

Por completitud, ya que es el primer resultado en la mayoría de las búsquedas sobre este síntoma. Flutter documenta una exclusión para apps que apuntan al SDK 35: agrega `android:windowOptOutEdgeToEdgeEnforcement` tanto a `LaunchTheme` como a `NormalTheme` en `android/app/src/main/res/values/styles.xml`, y al `values-night/styles.xml` correspondiente.

```xml
<!-- android/app/src/main/res/values/styles.xml -->
<style name="NormalTheme" parent="@android:style/Theme.Light.NoTitleBar">
    <item name="android:windowOptOutEdgeToEdgeEnforcement">true</item>
</style>
```

Tres razones para no construir sobre esto. Primero, Android 16 la mató: la página de cambios de comportamiento indica que para apps que apuntan a API 36, `R.attr#windowOptOutEdgeToEdgeEnforcement` "is deprecated and disabled, and your app can't opt-out of going edge-to-edge." Segundo, Flutter ya te pone por defecto en `targetSdkVersion = 36`, así que tendrías que bajar activamente tu objetivo para que el atributo signifique algo. Tercero, la propia nota de migración de Flutter advierte que usar la exclusión en Android 16 o posterior "might cause your app to crash," y la mitigación sugerida es un directorio de recursos específico de versión `your_app/android/app/src/main/res/values-35` con estilos sin el atributo. Eso es fontanería de recursos real a cambio de un comportamiento que ya desapareció en los dispositivos actuales.

El mismo razonamiento aplica a `SystemChrome.setEnabledSystemUIMode`. En API 36 los demás modos simplemente no se respetan, y el framework lo dice en la documentación de la API de `SystemUiMode`: si tu app apunta al SDK 36 o posterior usa `edgeToEdge` por defecto en Android, y "There is no way to opt out." `leanBack`, `immersive` e `immersiveSticky` son ignorados por el sistema Android con ese objetivo.

## Los colores de las barras del sistema ahora se ignoran, y el contraste es automático

Una víctima más que vale la pena nombrar, porque produce un síntoma distinto: nada crashea, tu color simplemente no se aplica. Bajo edge-to-edge, `SystemUiOverlayStyle.statusBarColor` y `SystemUiOverlayStyle.systemNavigationBarColor` no funcionan. En API 35 vuelven si tomas la exclusión; en API 36 desaparecieron de forma permanente.

Lo que sí sigue funcionando es el brillo de los iconos. `statusBarIconBrightness` y `systemNavigationBarIconBrightness` controlan si los glifos propios del sistema se renderizan claros u oscuros, que es lo que realmente necesitas cuando el contenido detrás de la barra cambia de tono:

```dart
// Flutter 3.44.2
AppBar(
  systemOverlayStyle: SystemUiOverlayStyle(
    statusBarIconBrightness:
        MediaQuery.platformBrightnessOf(context) == Brightness.dark
            ? Brightness.light
            : Brightness.dark,
  ),
)
```

Prefiere configurar `AppBar.systemOverlayStyle`, o un `AnnotatedRegion<SystemUiOverlayStyle>` cuando no hay app bar, antes que llamar a `SystemChrome.setSystemUIOverlayStyle` directamente. La región anotada se somete a hit-test en cada frame contra lo que realmente está bajo las barras de estado y navegación, así que se mantiene correcta mientras el usuario hace scroll o navega. Un `AppBar` crea una automáticamente, así que no envuelvas un `AppBar` en otro `AnnotatedRegion`.

Por último, desde API 29 Android pinta un velo translúcido detrás de una barra de navegación transparente para mantener legibles los tres botones sobre contenido arbitrario. Si tu diseño ya garantiza el contraste y el velo lo está enturbiando, `systemNavigationBarContrastEnforced: false` (y `systemStatusBarContrastEnforced` para la parte superior) lo desactiva. Los dispositivos con API 28 o inferior nunca lo aplicaron en primer lugar.

Si estás construyendo el aspecto a sangre completa a propósito y no reparándolo, lo siguiente que querrás es la curva física de la pantalla, que Flutter ahora [lee desde MediaQuery como radios de esquina físicos](/es/2026/07/flutter-3-44-read-the-screen-corner-radius-from-mediaquery/) para que tu contenido se recorte al cristal en lugar de a un radio adivinado.

## Relacionados

- [Solución: A RenderFlex overflowed by N pixels on the bottom cuando se abre el teclado en Flutter](/es/2026/08/fix-renderflex-overflowed-on-the-bottom-when-the-keyboard-opens-in-flutter/) -- la otra mitad de la historia del inset inferior, donde el teclado cambia las restricciones en vez del padding.
- [Flutter 3.44: Lee el radio de las esquinas físicas de la pantalla desde MediaQuery](/es/2026/07/flutter-3-44-read-the-screen-corner-radius-from-mediaquery/) -- la API complementaria para layouts a sangre completa en pantallas redondeadas.
- [Cómo combinar un ListView y un GridView en una sola vista de scroll con slivers en Flutter](/es/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/) -- dónde aplicar el inset inferior cuando tu vista de scroll es un `CustomScrollView` y no un `ListView`.
- [shrinkWrap vs Expanded vs slivers para listas largas en Flutter: ¿cuál elegir?](/es/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/) -- elegir el scrollable correcto antes de empezar a agregarle padding.
- [Solución: Google Play rechaza una app Flutter o .NET MAUI por no soportar páginas de memoria de 16 KB](/es/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/) -- otro requisito de Android impuesto por la tienda que aparece como una sorpresa en tiempo de compilación.

## Fuentes

- [Set default of SystemUiMode to edge-to-edge](https://docs.flutter.dev/release/breaking-changes/default-systemuimode-edge-to-edge) -- la guía de migración de Flutter, incluidos los estilos de exclusión y la nota sobre `values-35`.
- [Display content edge-to-edge in your app](https://developer.android.com/develop/ui/views/layout/edge-to-edge) -- la declaración de Android sobre la imposición en API 35 y superiores.
- [Behavior changes: Apps targeting Android 16 or higher](https://developer.android.com/about/versions/16/behavior-changes-16) -- la obsolescencia y deshabilitación de `windowOptOutEdgeToEdgeEnforcement`.
- [SystemUiMode API documentation](https://api.flutter.dev/flutter/services/SystemUiMode.html) -- notas por modo sobre qué respetan API 35 y API 36.
- [Issue 168635: App UI overlaps with 3-button navigation bar on Samsung One UI 7 / Android 15](https://github.com/flutter/flutter/issues/168635) -- la discusión de seguimiento a la que apunta la propia documentación de Flutter.
