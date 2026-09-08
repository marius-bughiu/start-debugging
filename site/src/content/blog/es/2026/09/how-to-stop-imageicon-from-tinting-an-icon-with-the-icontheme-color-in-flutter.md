---
title: "Cómo evitar que ImageIcon tiña un icono con el color del IconTheme ambiental en Flutter"
description: "ImageIcon aplana un PNG multicolor y lo convierte en una silueta porque siempre aplica ColorFilter.mode(iconThemeColor, BlendMode.srcIn). Flutter 3.47 agrega useOriginalColors para desactivarlo. Aquí verás por qué pasar color: null nunca funcionó, qué descarta useOriginalColors en silencio y el reemplazo manual para SDK más antiguos."
pubDate: 2026-09-08
template: how-to
tags:
  - "flutter"
  - "dart"
  - "material-design"
  - "how-to"
lang: "es"
translationOf: "2026/09/how-to-stop-imageicon-from-tinting-an-icon-with-the-icontheme-color-in-flutter"
translatedBy: "claude"
translationDate: 2026-09-08
---

`ImageIcon` entrega tu imagen a `Image` con `color: IconTheme.of(context).color`, y el objeto de renderizado convierte eso en `ColorFilter.mode(color, BlendMode.srcIn)`, que descarta el RGB de cada píxel y conserva solo su alfa. Una marca multicolor sale como una silueta plana, normalmente negra o blanca. Desde Flutter 3.47 la solución es un solo argumento: `ImageIcon(AssetImage('assets/logo.png'), useOriginalColors: true)`. Pasar `color: null` no hace nada, y nunca lo hizo, porque `IconTheme.of` está obligado por contrato a devolver un color concreto y recurre al negro opaco. En 3.44 y versiones anteriores no existe la bandera, así que reemplazas el widget por un `Image` simple y reproduces tú mismo los cuatro argumentos de layout de ImageIcon. Todo lo que sigue apunta al canal estable actual, Flutter 3.47.2 con Dart 3.13.2.

## Por qué color: null no desactiva el tinte

El widget completo tiene unas treinta líneas. Este es `build` tal como se distribuye en 3.47:

```dart
// package:flutter/src/widgets/image_icon.dart, Flutter 3.47.2
@override
Widget build(BuildContext context) {
  final IconThemeData iconTheme = IconTheme.of(context);
  final double? iconSize = size ?? iconTheme.size;

  if (image == null) {
    return Semantics(
      label: semanticLabel,
      child: SizedBox(width: iconSize, height: iconSize),
    );
  }

  final double? iconOpacity = iconTheme.opacity;
  Color iconColor = color ?? iconTheme.color!;

  if (iconOpacity != null && iconOpacity != 1.0) {
    iconColor = iconColor.withOpacity(iconColor.opacity * iconOpacity);
  }

  return Semantics(
    label: semanticLabel,
    child: Image(
      image: image!,
      width: iconSize,
      height: iconSize,
      color: useOriginalColors ? null : iconColor,
      fit: BoxFit.scaleDown,
      excludeFromSemantics: true,
    ),
  );
}
```

La línea que soporta todo el peso es `Color iconColor = color ?? iconTheme.color!`. Ese `!` no es optimismo, es una garantía que `IconTheme.of` hace de forma explícita. La búsqueda resuelve el `IconTheme` ambiental más cercano, comprueba si el resultado es concreto y, si no lo es, rellena cada campo nulo desde `IconThemeData.fallback()`:

```dart
// package:flutter/src/widgets/icon_theme.dart, Flutter 3.47.2
static IconThemeData of(BuildContext context) {
  final IconThemeData iconThemeData = _getInheritedIconThemeData(context).resolve(context);
  return iconThemeData.isConcrete
      ? iconThemeData
      : iconThemeData.copyWith(
          size: iconThemeData.size ?? const IconThemeData.fallback().size,
          // ...
          color: iconThemeData.color ?? const IconThemeData.fallback().color,
          opacity: iconThemeData.opacity ?? const IconThemeData.fallback().opacity,
          // ...
        );
}
```

Y `IconThemeData.fallback()` fija `color = const Color(0xFF000000)`. No existe ningún estado del árbol de widgets en el que `IconTheme.of(context).color` sea nulo. Así que el comentario de documentación que sigue adjunto a `ImageIcon.color`, que dice que sin `IconTheme` "defaults to not recolorizing the image", describe un comportamiento que el widget no tiene desde hace mucho. Sin ningún tema ambiental obtienes negro opaco, que es exactamente el resultado que la gente reporta como "mi icono a color se renderiza como una mancha negra".

Poner `color: Colors.transparent` es el otro intento instintivo, y es peor. `BlendMode.srcIn` compone el color de origen dentro del alfa del destino, así que un origen totalmente transparente produce un resultado totalmente transparente: el icono desaparece en lugar de mostrar sus propios colores. Tampoco hay nada a lo que recurrir a nivel de tema, porque no puedes expresar "sin color" en un `IconThemeData` que `IconTheme.of` vaya a devolver intacto.

## La reproducción: un PNG, tres lugares donde se vuelve gris

Cualquier widget de Material que sea dueño de su espacio de icono instala un `IconTheme` sobre ese espacio, así que el mismo asset se aplana en todos ellos. Esto se ejecuta en 3.47 tal cual; cambia el import por `package:flutter/material.dart` si todavía no hiciste el traslado a los [paquetes independientes material_ui y cupertino_ui](/es/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/).

```dart
// Flutter 3.47.2, Dart 3.13.2
import 'package:material_ui/material_ui.dart';

const AssetImage brandMark = AssetImage('assets/brand/logo.png');

class TintDemo extends StatelessWidget {
  const TintDemo({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Tinting'),
        // Flattened to ColorScheme.onSurface.
        actions: const <Widget>[ImageIcon(brandMark)],
      ),
      body: Column(
        children: <Widget>[
          // Flattened to the button's resolved foreground color.
          ElevatedButton.icon(
            onPressed: () {},
            icon: const ImageIcon(brandMark),
            label: const Text('Open'),
          ),
          // Flattened to ListTileThemeData.iconColor.
          const ListTile(
            leading: ImageIcon(brandMark),
            title: Text('Account'),
          ),
          // Not flattened: no IconTheme is being applied to raw images.
          const Image(image: brandMark, width: 24, height: 24),
        ],
      ),
    );
  }
}
```

La última fila es la señal. Mismo asset, mismo tamaño, sin filtro de color, colores correctos. El PNG no tiene nada malo, y la resolución del asset tampoco, que es la primera sospecha habitual cuando una imagen se ve mal; ese modo de fallo se ve completamente distinto y está cubierto en [unable to load asset en Flutter después de agregar una imagen a pubspec.yaml](/es/2026/07/fix-unable-to-load-asset-in-flutter-after-adding-an-image-to-pubspec-yaml/).

## Pasos para cambiar un ImageIcon a sus colores originales

1. Comprueba tu SDK con `flutter --version`. `useOriginalColors` llegó en el [PR 180491](https://github.com/flutter/flutter/pull/180491) el 2026-04-27 y se distribuyó en la versión estable Flutter 3.47. En cualquier versión anterior, salta al reemplazo manual de más abajo.
2. Elimina el argumento `color` del sitio de llamada. El constructor comprueba con un assert que `color` sea nulo siempre que `useOriginalColors` sea true, así que dejar ambos es un error duro.
3. Agrega `useOriginalColors: true`. Ese es todo el cambio: `build` pasa entonces `color: null` hacia `Image`, no se instala ningún `ColorFilter` en el objeto de renderizado y los píxeles decodificados llegan al lienzo intactos.
4. Revisa de nuevo cada variante de ese icono que dependa del estado. Los estados seleccionado, no seleccionado, deshabilitado y presionado se expresan todos como colores distintos de `IconThemeData`, y acabas de renunciar a todos ellos de una vez.
5. Decide qué transmite ahora el aspecto deshabilitado. Si el widget dependía de un color de tinte translúcido para verse atenuado, envuelve el icono en `Opacity` o proporciona un asset desaturado aparte.

El sitio de llamada terminado:

```dart
// Flutter 3.47.2, Dart 3.13.2
const ImageIcon(
  AssetImage('assets/brand/logo.png'),
  useOriginalColors: true,
  semanticLabel: 'Acme',
)
```

El tamaño sigue viniendo del `IconTheme` ambiental, así que el icono se mantiene alineado con los widgets `Icon` que tiene al lado. Solo desaparece el filtro de color.

## Qué descarta useOriginalColors junto con el tinte

Mira otra vez las dos líneas de `build` que importan:

```dart
if (iconOpacity != null && iconOpacity != 1.0) {
  iconColor = iconColor.withOpacity(iconColor.opacity * iconOpacity);
}
// ...
color: useOriginalColors ? null : iconColor,
```

`IconTheme.opacity` se pliega dentro del alfa del color de tinte, y el color de tinte es el único canal por el que llega a la imagen. Pon `useOriginalColors: true` y todo el `iconColor` calculado se descarta, opacidad incluida. Un ancestro que atenúa su subárbol con `IconTheme(data: IconThemeData(opacity: 0.38), ...)` atenuará cada `Icon` a su alrededor y dejará tu imagen a plena intensidad.

Lo mismo aplica a los colores de tinte translúcidos, que es como Material expresa hoy los iconos deshabilitados. Los valores por defecto de `NavigationBar` resuelven el estado deshabilitado a `onSurfaceVariant` con un alfa del 38 por ciento, y ese alfa viaja a través de `srcIn` hasta el resultado renderizado. Renuncia al filtro y el destino deshabilitado parece habilitado.

Si necesitas recuperar la opacidad ambiental, léela y aplícala tú mismo:

```dart
// Flutter 3.47.2, Dart 3.13.2
class BrandIcon extends StatelessWidget {
  const BrandIcon({super.key, required this.image});

  final ImageProvider image;

  @override
  Widget build(BuildContext context) {
    final double opacity = IconTheme.of(context).opacity ?? 1.0;
    final Widget icon = ImageIcon(image, useOriginalColors: true);
    return opacity == 1.0 ? icon : Opacity(opacity: opacity, child: icon);
  }
}
```

`Opacity` es una capa de composición real y no es gratis, por eso vale la pena mantener la guarda contra el caso común de `1.0` en vez de envolver sin condiciones.

## El reemplazo anterior a 3.47

No hay bandera que retroportar, ni combinación de valores de `color` que llegue al mismo resultado, así que en 3.44 y anteriores dejas de usar `ImageIcon`. El reemplazo es corto porque ImageIcon en sí es corto: las partes que vale la pena conservar son la búsqueda del tamaño, `BoxFit.scaleDown` y la separación semántica que pone la etiqueta en el envoltorio y excluye la imagen del árbol.

```dart
// Flutter 3.44 or older. Drop-in for ImageIcon that keeps the image's colors.
import 'package:flutter/widgets.dart';

class OriginalColorImageIcon extends StatelessWidget {
  const OriginalColorImageIcon(
    this.image, {
    super.key,
    this.size,
    this.semanticLabel,
  });

  final ImageProvider image;
  final double? size;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final double? iconSize = size ?? IconTheme.of(context).size;
    return Semantics(
      label: semanticLabel,
      child: Image(
        image: image,
        width: iconSize,
        height: iconSize,
        fit: BoxFit.scaleDown,
        excludeFromSemantics: true,
      ),
    );
  }
}
```

Hay dos detalles fáciles de perder si en su lugar pones un `Image.asset` pelado. `BoxFit.scaleDown` nunca agranda: un asset cuyo tamaño intrínseco es menor que la caja del icono se queda en su tamaño intrínseco y se centra, igual que se comporta `ImageIcon`, y evita el desenfoque que introduciría `BoxFit.contain`. Y `excludeFromSemantics: true` en el `Image` interno impide que el árbol de accesibilidad cargue tanto la etiqueta del envoltorio como la de la propia imagen, que es lo que hace `ImageIcon` por la misma razón.

## Qué widgets instalan el IconTheme que te muerde

| Widget | Qué pone en el IconTheme ambiental |
| --- | --- |
| `AppBar`, `SliverAppBar` | `iconTheme` para el widget leading y `actionsIconTheme` para las acciones, con `ColorScheme.onSurface` por defecto |
| `ElevatedButton.icon` y las demás variantes de `ButtonStyleButton` | un `AnimatedTheme` cuyo `iconTheme` se fusiona con el color de primer plano resuelto y el tamaño del icono |
| `IconButton` | el color de primer plano resuelto para el estado actual del widget |
| `NavigationBar`, `NavigationRail` | un `WidgetStateProperty<IconThemeData>` resuelto por separado para seleccionado, no seleccionado y deshabilitado |
| `BottomNavigationBar` | los colores de elemento seleccionado y no seleccionado |
| `ListTile` | `ListTileThemeData.iconColor`, o un color deshabilitado cuando `enabled: false` |
| `Chip` y sus variantes | el tema de iconos propio del chip |
| `TabBar` | `labelColor` y `unselectedLabelColor` |

Por eso el reporte de bug que se suele abrir, el más famoso [flutter/flutter#81643](https://github.com/flutter/flutter/issues/81643), se cierra como inválido. El widget hace exactamente lo que se supone que hace un widget de icono. El sistema de temas de Material asume que los iconos son siluetas monocromas que tiene permitido recolorear, la misma suposición detrás de la forma en que [el ColorScheme de Material 3 dirige los colores de acento en una app Flutter](/es/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/).

## Los destinos seleccionado y no seleccionado necesitan dos widgets separados

`NavigationBar` no intercambia un icono por otro. Construye los dos, envuelve cada uno en su propio `IconTheme.merge` y los funde en un `Stack`:

```dart
// package:flutter/src/material/navigation_bar.dart, Flutter 3.47.2
final Widget selectedIconWidget = IconTheme.merge(
  data: enabled ? selectedIconTheme : disabledIconTheme,
  child: selectedIcon ?? icon,
);
final Widget unselectedIconWidget = IconTheme.merge(
  data: enabled ? unselectedIconTheme : disabledIconTheme,
  child: icon,
);
```

Como `icon` se usa para el espacio no seleccionado y también para el seleccionado cuando `selectedIcon` es nulo, un único widget con `useOriginalColors: true` renuncia al tinte en ambos estados. Si quieres los colores de marca solo cuando el destino está activo, pasa dos widgets:

```dart
// Flutter 3.47.2, Dart 3.13.2
NavigationDestination(
  icon: const ImageIcon(AssetImage('assets/brand/logo_mono.png')),
  selectedIcon: const ImageIcon(
    AssetImage('assets/brand/logo.png'),
    useOriginalColors: true,
  ),
  label: 'Acme',
)
```

El asset monocromo del espacio no seleccionado sigue recibiendo el tinte, que es lo que quieres: sigue al tema como cualquier otro destino, y la marca a todo color aparece solo al seleccionar.

## Detalles que conviene conocer antes de enviar esto

**El assert es una comprobación de modo debug, no un error de compilación, salvo que lo conviertas en uno.** `ImageIcon` tiene un constructor `const`, así que `const ImageIcon(image, useOriginalColors: true, color: Colors.red)` se evalúa en tiempo de compilación y el analizador lo rechaza de plano. Escrito sin `const`, solo lanza en compilaciones debug y profile. En release el assert se elimina, `build` sigue evaluando `useOriginalColors ? null : iconColor` y tu color se ignora en silencio. Prefiere `const` en estos sitios de llamada.

**`Icon` no tiene equivalente y no lo necesita.** Los iconos basados en fuentes son contornos de un solo glifo; no hay colores originales que preservar. Si necesitas un glifo multicolor necesitas una imagen o un vector, no un `IconFont`.

**`flutter_svg` funciona al revés.** `SvgPicture.asset` no lee `IconTheme` en absoluto, así que un SVG conserva sus propios colores por defecto y tú optas por el tinte con un `colorFilter: ColorFilter.mode(IconTheme.of(context).color!, BlendMode.srcIn)` explícito. Si tu SVG sale monocromo sin esperarlo, busca un `fill` fijado dentro del archivo, no un tema ambiental.

**Verifícalo en un test de widget en lugar de mirar una captura de pantalla.** Los píxeles renderizados son difíciles de comprobar, pero la configuración del widget no:

```dart
// Flutter 3.47.2, Dart 3.13.2
testWidgets('brand mark ignores the ambient icon color', (WidgetTester tester) async {
  await tester.pumpWidget(
    const IconTheme(
      data: IconThemeData(color: Color(0xFFFF0000)),
      child: Directionality(
        textDirection: TextDirection.ltr,
        child: ImageIcon(
          AssetImage('assets/brand/logo.png'),
          useOriginalColors: true,
        ),
      ),
    ),
  );

  expect(tester.widget<Image>(find.byType(Image)).color, isNull);
});
```

Un test golden también atrapa la regresión, pero este falla con un mensaje legible y corre sin depender de que el bundle de assets se porte bien.

**Envía la densidad correcta.** `BoxFit.scaleDown` no amplía, así que un espacio de icono de 24 píxeles lógicos en un dispositivo 3x quiere un asset de 72 píxeles en `assets/brand/3.0x/`. Un único PNG de 24 píxeles que se veía bien mientras lo aplanaban a una silueta se verá claramente borroso en cuanto puedas ver sus píxeles reales.

### Lee a continuación

- [Migrar los imports de Material y Cupertino de Flutter a los paquetes material_ui y cupertino_ui](/es/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/)
- [Cómo definir un color de acento en Flutter con el ColorScheme de Material 3](/es/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/)
- [Fix: unable to load asset en Flutter después de agregar una imagen a pubspec.yaml](/es/2026/07/fix-unable-to-load-asset-in-flutter-after-adding-an-image-to-pubspec-yaml/)
- [Fix: cannot provide both a color and a decoration en un Container de Flutter](/es/2026/07/fix-cannot-provide-both-a-color-and-a-decoration-in-a-flutter-container/)
- [¿Qué es una Key de Flutter y cuándo causa bugs omitirla?](/es/2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs/)

### Fuentes

- [Clase ImageIcon, referencia de la API de Flutter](https://api.flutter.dev/flutter/widgets/ImageIcon-class.html)
- [Added useOriginalColors flag which allows ImageIcon to bypass IconTheme colorization, flutter/flutter PR 180491](https://github.com/flutter/flutter/pull/180491)
- [Notas de la versión Flutter 3.47.0](https://docs.flutter.dev/release/release-notes/release-notes-3.47.0)
- [IconTheme.of, referencia de la API de Flutter](https://api.flutter.dev/flutter/widgets/IconTheme/of.html)
- [BlendMode.srcIn, referencia de la API de dart:ui](https://api.flutter.dev/flutter/dart-ui/BlendMode.html)
- [ImageIcon displays a colourful icon as black & white, flutter/flutter issue 81643](https://github.com/flutter/flutter/issues/81643)
