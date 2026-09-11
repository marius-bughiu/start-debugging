---
title: "Solución: The argument type 'TextTheme' can't be assigned to the parameter type 'TextTheme?' con google_fonts"
description: "Tu app importa material_ui, pero google_fonts 8.2.1 todavía devuelve el TextTheme del SDK. Construye el TextTheme tú mismo a partir de tear-offs de GoogleFonts.roboto hasta que google_fonts migre."
pubDate: 2026-09-11
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "material-design"
  - "google-fonts"
lang: "es"
translationOf: "2026/09/fix-textheme-cant-be-assigned-to-textheme-google-fonts-material-ui"
translatedBy: "claude"
translationDate: 2026-09-11
---

Tienes dos clases distintas llamadas `TextTheme` en un mismo programa. Tu app importa `package:material_ui/material_ui.dart`, así que `ThemeData.textTheme` espera la copia de `TextTheme` de `material_ui`. `google_fonts` 8.2.1, la versión más reciente, todavía importa `package:flutter/material.dart`, así que `GoogleFonts.robotoTextTheme()` devuelve la copia del SDK. Dart las trata como tipos sin relación. La solución que funciona hoy: deja de llamar a los helpers `...TextTheme()` y aplica la fuente estilo por estilo con un tear-off de `GoogleFonts.roboto`, que devuelve un `TextStyle`, un tipo que ambas copias comparten. `MaterialUiCompatibilityBridge` no puede arreglar esto, porque es un error en tiempo de compilación.

Todo lo que sigue se reprodujo en Flutter 3.44.8 (Dart 3.12.2) con `material_ui` 1.2.0, `cupertino_ui` 1.0.2 y `google_fonts` 8.2.1, y se comprobó contra el código fuente de `google_fonts` en la rama main de `flutter/packages` a fecha de 2026-09-11. El mismo error se reproduce en la línea estable 3.47 y en master, porque el desajuste está en el paquete, no en el SDK.

## Lo que imprimen el analizador y el compilador

`flutter analyze` y el IDE te dan la forma corta, que parece no tener sentido porque los dos nombres de tipo son idénticos:

```text
error • The argument type 'TextTheme' can't be assigned to the parameter type 'TextTheme?'.  • lib/main.dart:13:20 • argument_type_not_assignable
```

El compilador front end, que se ejecuta con `flutter run`, `flutter build` y `flutter test`, es más útil. Numera los dos tipos y te dice dónde vive cada uno:

```text
lib/main.dart:13:47: Error: The argument type 'TextTheme/*1*/' can't be assigned to the parameter type 'TextTheme/*2*/?'.
 - 'TextTheme/*1*/' is from 'package:flutter/src/material/text_theme.dart' ('/opt/homebrew/share/flutter/packages/flutter/lib/src/material/text_theme.dart').
 - 'TextTheme/*2*/' is from 'package:material_ui/src/text_theme.dart' ('/Users/marius/.pub-cache/hosted/pub.dev/material_ui-1.2.0/lib/src/text_theme.dart').
        textTheme: GoogleFonts.robotoTextTheme(),
                                              ^
```

Ese segundo mensaje es el diagnóstico. Si el tuyo menciona `package:flutter/src/material/...` y `package:material_ui/src/...`, estás en el lugar correcto. Si menciona otras dos bibliotecas, salta a la sección de errores parecidos al final.

## Por qué existen dos clases TextTheme

Desde Flutter 3.44, Material y Cupertino se distribuyen como los paquetes independientes `material_ui` y `cupertino_ui`. `material_ui` 1.0.0, publicado el 2026-08-12, es una copia de la biblioteca Material que quedó congelada en el SDK en abril. No es una reexportación. `material_ui/lib/src/text_theme.dart` declara su propia `class TextTheme`, igual que declara sus propios `ThemeData`, `Theme` y `ColorScheme`.

En Dart, la identidad de un tipo viene de la biblioteca que lo declara, no del nombre. El `TextTheme` de `package:flutter/src/material/text_theme.dart` y el `TextTheme` de `package:material_ui/src/text_theme.dart` tienen los mismos campos y el mismo código, pero ninguno es subtipo del otro, así que ninguno se puede asignar al otro.

`google_fonts` 8.2.1 se publicó el 2026-07-31, antes de que `material_ui` llegara a 1.0. Su `lib/src/google_fonts_all_parts.dart` todavía tiene:

```dart
// google_fonts 8.2.1, lib/src/google_fonts_all_parts.dart
import 'package:flutter/material.dart';
```

y cada helper `...TextTheme` generado se construye sobre ese import:

```dart
// google_fonts 8.2.1, lib/src/google_fonts_parts/part_r.dart (trimmed)
static TextTheme robotoTextTheme([TextTheme? textTheme]) {
  textTheme ??= ThemeData.light().textTheme;
  return TextTheme(
    displayLarge: roboto(textStyle: textTheme.displayLarge),
    // ...14 more styles
  );
}
```

Tanto el parámetro como el tipo de retorno son el `TextTheme` del SDK. En cuanto tu archivo importa `material_ui` en lugar de `package:flutter/material.dart`, que es exactamente lo que hace `dart fix --apply --code=migrate_design_widgets`, cada llamada a `GoogleFonts.xxxTextTheme()` deja de compilar. Esto se sigue en [flutter/flutter#191067](https://github.com/flutter/flutter/issues/191067), abierto el día después de que saliera `material_ui` 1.0.0.

## Reproducción mínima

```yaml
# pubspec.yaml, Flutter 3.44.8
dependencies:
  flutter:
    sdk: flutter
  google_fonts: ^8.2.1
  material_ui: ^1.2.0
```

```dart
// Flutter 3.44.8, material_ui 1.2.0, google_fonts 8.2.1
import 'package:google_fonts/google_fonts.dart';
import 'package:material_ui/material_ui.dart';

void main() => runApp(const App());

class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      theme: ThemeData(
        textTheme: GoogleFonts.robotoTextTheme(), // error here
      ),
      home: const Scaffold(body: Center(child: Text('Hello'))),
    );
  }
}
```

Vuelve a cambiar el import a `package:flutter/material.dart` y compila, por eso tantos reportes de este error dicen "antes funcionaba".

## Por qué MaterialUiCompatibilityBridge no ayuda

El bridge que añadió `material_ui` 0.0.3 es lo primero que la gente prueba, y también fue la primera sugerencia de un mantenedor en #191067. No arregla este error, y no puede hacerlo. El bridge es un widget. Inserta los inherited widgets heredados `Theme` y `Localizations` en el árbol para que un paquete sin migrar que llama a `Theme.of(context)` en runtime encuentre algo. Eso cubre las dependencias que *leen* estado de Material desde `BuildContext`.

`google_fonts` no lee nada del árbol. *Devuelve* un tipo de Material del SDK desde su API pública, y ese valor llega a tu código como argumento, que el verificador de tipos rechaza antes de que exista ningún widget. [flutter/flutter#191448](https://github.com/flutter/flutter/issues/191448) documenta este límite en términos generales y cita el caso de `google_fonts` como el ejemplo de primera parte. Si no puedes compilar, ningún widget envoltorio entra en juego.

## Solución 1: aplica la fuente estilo por estilo con un tear-off (recomendada)

`TextStyle` está declarado en `package:flutter/painting.dart`, que forma parte del SDK y lo comparten ambas copias de Material. `GoogleFonts.roboto(...)` devuelve un `TextStyle`. Así que la única pieza que tienes que reemplazar es el bucle de quince líneas que el helper `...TextTheme` hace por ti, y puedes escribirlo contra el `TextTheme` de `material_ui`:

```dart
// lib/theme/google_text_theme.dart
// Flutter 3.44.8, Dart 3.12.2, material_ui 1.2.0, google_fonts 8.2.1
import 'package:google_fonts/google_fonts.dart';
import 'package:material_ui/material_ui.dart';

/// Applies a Google Font to every style of a material_ui [TextTheme].
///
/// Pass a tear-off such as `GoogleFonts.roboto`. Only [TextStyle] crosses
/// the package boundary, and TextStyle lives in package:flutter/painting.dart,
/// which both copies of Material share.
TextTheme withGoogleFont(
  TextTheme base,
  TextStyle Function({TextStyle? textStyle}) font,
) {
  TextStyle? apply(TextStyle? style) =>
      style == null ? null : font(textStyle: style);

  return base.copyWith(
    displayLarge: apply(base.displayLarge),
    displayMedium: apply(base.displayMedium),
    displaySmall: apply(base.displaySmall),
    headlineLarge: apply(base.headlineLarge),
    headlineMedium: apply(base.headlineMedium),
    headlineSmall: apply(base.headlineSmall),
    titleLarge: apply(base.titleLarge),
    titleMedium: apply(base.titleMedium),
    titleSmall: apply(base.titleSmall),
    bodyLarge: apply(base.bodyLarge),
    bodyMedium: apply(base.bodyMedium),
    bodySmall: apply(base.bodySmall),
    labelLarge: apply(base.labelLarge),
    labelMedium: apply(base.labelMedium),
    labelSmall: apply(base.labelSmall),
  );
}
```

El tipo del parámetro `font` es el truco que mantiene cortas las llamadas. Cada método de fuente generado tiene la firma `TextStyle Function({TextStyle? textStyle, Color? color, double? fontSize, ...})`. Un tipo de función con más parámetros nombrados opcionales es subtipo de uno con menos, así que `GoogleFonts.roboto`, `GoogleFonts.lato` o `GoogleFonts.pangolin` se pueden pasar directamente.

Luego construye primero el tema y reemplaza su text theme:

```dart
// lib/main.dart
// Flutter 3.44.8, Dart 3.12.2, material_ui 1.2.0, google_fonts 8.2.1
import 'package:google_fonts/google_fonts.dart';
import 'package:material_ui/material_ui.dart';

import 'theme/google_text_theme.dart';

ThemeData buildTheme(Brightness brightness) {
  final base = ThemeData(
    brightness: brightness,
    colorSchemeSeed: Colors.indigo,
  );
  return base.copyWith(
    textTheme: withGoogleFont(base.textTheme, GoogleFonts.roboto),
  );
}

class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      home: const Scaffold(body: Center(child: Text('Hello'))),
    );
  }
}
```

`flutter analyze` queda limpio con esto, y un widget test confirma que el resultado coincide con lo que producía `GoogleFonts.robotoTextTheme()`: cada estilo recibe `fontFamily: 'Roboto_regular'` con `fontFamilyFallback: ['Roboto']`, que es como `google_fonts` nombra una variante cargada.

Esta versión además es mejor que la llamada a la que reemplaza en un aspecto. `robotoTextTheme()` sin argumento parte de `ThemeData.light().textTheme`, así que si lo reutilizabas en `darkTheme` sin pasar `ThemeData.dark().textTheme`, obtenías texto oscuro sobre una superficie oscura. Derivar de `base.textTheme` según el brillo deja los colores correctos por construcción. En el test anterior, `bodyMedium` claro se resuelve a un `Color(0xFF1B1B21)` casi negro y `bodyMedium` oscuro a un `Color(0xFFE4E1E9)` casi blanco.

Cuando la migración llegue al paquete original, borrar este archivo y volver a `GoogleFonts.robotoTextTheme(base.textTheme)` es un cambio de una línea por tema.

### Cuando el nombre de la familia solo se conoce en runtime

Si los usuarios eligen una fuente en una pantalla de ajustes, probablemente llamabas a `GoogleFonts.getTextTheme(name)`, que tiene el mismo problema. Envuelve `getFont`, que devuelve un `TextStyle`:

```dart
// Flutter 3.44.8, material_ui 1.2.0, google_fonts 8.2.1
TextTheme withGoogleFontNamed(TextTheme base, String family) =>
    withGoogleFont(
      base,
      ({TextStyle? textStyle}) =>
          GoogleFonts.getFont(family, textStyle: textStyle),
    );
```

Ten claro lo que esto cuesta. `getFont` busca la familia en `GoogleFonts.asMap()`, un mapa const que referencia cada método de fuente generado, así que el compilador ya no puede eliminar por tree-shaking los que no se usan. El tear-off directo de la Solución 1 referencia una sola fuente. Esa diferencia de tamaño es lo que ataca el punto de entrada `google_fonts_lite.dart` de [flutter/packages#11433](https://github.com/flutter/packages/pull/11433); se fusionó el 2026-09-04, pero todavía no se ha publicado. Usa `getFont` solo si de verdad necesitas un nombre en runtime.

## Solución 2: convierte un TextTheme heredado existente en la frontera

Si el `TextTheme` del SDK te llega desde algún lugar que no controlas, por ejemplo un paquete de temas compartido que no puedes cambiar esta semana, conviértelo campo por campo. Importa la biblioteca heredada con un prefijo y una cláusula `show` para que no pueda filtrar ningún otro nombre al archivo:

```dart
// lib/theme/legacy_adapter.dart
// Flutter 3.44.8, Dart 3.12.2, material_ui 1.2.0, google_fonts 8.2.1
// Temporary: delete once google_fonts ships a material_ui release.
import 'package:flutter/material.dart' as legacy show TextTheme;
import 'package:material_ui/material_ui.dart';

extension LegacyTextThemeToMaterialUi on legacy.TextTheme {
  TextTheme toMaterialUi() => TextTheme(
        displayLarge: displayLarge,
        displayMedium: displayMedium,
        displaySmall: displaySmall,
        headlineLarge: headlineLarge,
        headlineMedium: headlineMedium,
        headlineSmall: headlineSmall,
        titleLarge: titleLarge,
        titleMedium: titleMedium,
        titleSmall: titleSmall,
        bodyLarge: bodyLarge,
        bodyMedium: bodyMedium,
        bodySmall: bodySmall,
        labelLarge: labelLarge,
        labelMedium: labelMedium,
        labelSmall: labelSmall,
      );
}
```

```dart
// Flutter 3.44.8, material_ui 1.2.0, google_fonts 8.2.1
final theme = ThemeData(
  textTheme: GoogleFonts.pangolinTextTheme().toMaterialUi(),
);
```

Esto compila porque cada campo es un `TextStyle`. Funciona específicamente para `TextTheme` porque la clase es una simple bolsa de quince estilos. No se generaliza: #191448 muestra que el mismo truco de adaptador falla un nivel más abajo con tipos como `FloatingActionButtonLocation`, cuyos métodos reciben otros tipos de Material como argumentos. Además conserva el valor por defecto solo claro descrito arriba, y reintroduce el import de Material del SDK que la migración pretendía eliminar, así que mantenlo en un solo archivo con un comentario y prefiere la Solución 1.

## Solución 3: espera a la migración de google_fonts

Dos pull requests migran el propio `google_fonts`: [flutter/packages#12489](https://github.com/flutter/packages/pull/12489), abierto el 2026-08-17 y vinculado a #191067, y [flutter/packages#12810](https://github.com/flutter/packages/pull/12810), abierto el 2026-09-09 como parte de [flutter/flutter#191322](https://github.com/flutter/flutter/issues/191322), que abarca todo el ecosistema. El segundo también sube el mínimo del paquete a Flutter 3.44 y Dart 3.12. Ninguno se había fusionado a fecha de 2026-09-11. Cuando uno lo haga, los helpers `...TextTheme` recibirán y devolverán el tipo de `material_ui` y la línea original volverá a compilar. Sigue el [changelog de google_fonts](https://pub.dev/packages/google_fonts/changelog).

Dos formas de esperar que no recomendaría para una app en producción:

- **Revertir el import solo en el archivo del tema.** Eso no funciona. El `ThemeData` de ese archivo pasa a ser el `ThemeData` del SDK, y tu `MaterialApp` de `material_ui` lo rechaza con el mismo error, solo que un tipo más arriba. Toda la app tiene que estar del mismo lado.
- **Una referencia git en `dependency_overrides` a la rama de un PR abierto.** Compila, y un comentarista en #191067 ofrece exactamente eso. Pero estás distribuyendo código sin revisar desde un fork. Si lo haces de todos modos, fija `ref:` a un SHA de commit, no a una rama.

Si por algún motivo no puedes usar la Solución 1, la alternativa honesta es posponer la migración a `material_ui` hasta que salga `google_fonts`. La biblioteca Material dentro del SDK está congelada, pero sigue funcionando en 3.47.

## Detalle a tener en cuenta: el peso todavía no está en el tema

Algo que los helpers `...TextTheme` siempre hicieron y que la Solución 1 hereda: `ThemeData.textTheme` solo contiene colores y familias en el momento de construirlo. Los tamaños y pesos vienen de `Typography.englishLike` y se fusionan después, cuando `Theme.of` localiza el tema. Así que cuando `google_fonts` ve `titleMedium`, el peso es `null`, elige la variante regular y el estilo recibe `fontFamily: 'Roboto_regular'`. En runtime, `Theme.of(context).textTheme.titleMedium` se resuelve a `Roboto_regular` con `FontWeight.w500`, lo que significa que el motor renderiza un estilo de peso 500 a partir del archivo de peso 400.

Si tus títulos y etiquetas necesitan el archivo medium real, fusiona la geometría antes de aplicar la fuente:

```dart
// Flutter 3.44.8, material_ui 1.2.0, google_fonts 8.2.1
final geometry = Typography.material2021().englishLike.merge(base.textTheme);
final textTheme = withGoogleFont(geometry, GoogleFonts.roboto);
// titleMedium -> fontFamily 'Roboto_500', fontWeight w500
```

Verifiqué ambos resultados en un widget test. La contrapartida: los tamaños English-like ahora quedan fijados, así que si distribuyes en chino, japonés o coreano, elige la geometría por locale (`Typography.material2021().tall` o `.dense`). El mismo razonamiento explica por qué `TextTheme.apply(fontFamily: GoogleFonts.roboto().fontFamily)` es una trampa: asigna `'Roboto_regular'` a cada estilo, sea cual sea su peso.

## Errores parecidos que no son este bug

- **`The argument type 'TextTheme' can't be assigned to the parameter type 'CupertinoTextThemeData'`.** Pasaste un text theme de Material a `CupertinoThemeData.textTheme`. Son clases distintas por diseño, algo que ya se reportó en 2022 como [material-foundation/flutter-packages#227](https://github.com/material-foundation/flutter-packages/issues/227). No hay helper `...TextTheme` para Cupertino; construye tú mismo un `CupertinoTextThemeData` y pasa objetos de estilo `GoogleFonts.lato()` a su `textStyle` y a los parámetros relacionados.
- **El mismo mensaje, pero el compilador menciona uno de tus propios archivos.** Una clase llamada `TextTheme` en tu propio código o en un archivo generado de design tokens oculta la de Material. La salida numerada del compilador te dice qué archivo renombrar.
- **El mismo mensaje para `ColorScheme`.** Ese era `dynamic_color`, que devolvía el `ColorScheme` del SDK desde `DynamicColorBuilder`. Está corregido: `dynamic_color` 2.1.0 depende de `material_ui`, como confirmó el mantenedor en [material-foundation/flutter-packages#698](https://github.com/material-foundation/flutter-packages/issues/698).
- **Compila, pero los widgets de un paquete fallan con "Could not find an ancestor of type Theme".** Esa es la mitad de runtime de la misma separación, y es el caso que `MaterialUiCompatibilityBridge` sí arregla.

## Relacionado

- La migración completa de la que surge este error, incluido cuándo necesitas el bridge de compatibilidad, está en [migrar los imports de Material y Cupertino de Flutter a material_ui y cupertino_ui](/es/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/).
- Para el contexto de por qué Material salió del SDK, consulta [Flutter 3.44 separa Material y Cupertino del SDK](/es/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).
- Si ejecutaste la reescritura de imports en todo un monorepo, [ejecutar dart fix en todo un repositorio](/es/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/) explica cómo acotarla y revisarla paquete por paquete.
- El mismo enfoque de construir primero el `ThemeData` que usa la Solución 1 también sirve para los colores: [configurar el color de acento con un ColorScheme de Material 3](/es/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/).
- Para un fallo de búsqueda de ancestro que viene de tu propio código y no de una dependencia, lee [cómo solucionar "No Material widget found" en Flutter](/es/2026/08/fix-no-material-widget-found-in-flutter/).

## Fuentes

- [flutter/flutter#191067](https://github.com/flutter/flutter/issues/191067), conflicto del `TextTheme` de material_ui con `google_fonts`
- [flutter/flutter#191448](https://github.com/flutter/flutter/issues/191448), `MaterialUiCompatibilityBridge` no puede cubrir el acoplamiento por firmas de API
- [flutter/flutter#191322](https://github.com/flutter/flutter/issues/191322), migrar los paquetes de primera parte a `material_ui` y `cupertino_ui`
- [flutter/packages#12489](https://github.com/flutter/packages/pull/12489) y [flutter/packages#12810](https://github.com/flutter/packages/pull/12810), los pull requests abiertos de migración de `google_fonts`
- [flutter/packages#11433](https://github.com/flutter/packages/pull/11433), el punto de entrada `google_fonts_lite.dart`
- [google_fonts en pub.dev](https://pub.dev/packages/google_fonts), versión 8.2.1, y su [código fuente](https://github.com/flutter/packages/tree/main/packages/google_fonts)
- [material_ui en pub.dev](https://pub.dev/packages/material_ui), versión 1.2.0, y su [changelog](https://pub.dev/packages/material_ui/changelog)
- [argument_type_not_assignable](https://dart.dev/diagnostics/argument_type_not_assignable), diagnósticos de Dart
