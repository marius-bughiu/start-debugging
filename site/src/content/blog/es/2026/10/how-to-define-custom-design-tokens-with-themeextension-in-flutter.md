---
title: "Cómo definir design tokens personalizados con ThemeExtension y animarlos entre los temas claro y oscuro en Flutter"
description: "Crea una subclase de ThemeExtension, registra una instancia por ThemeData mediante la lista extensions, léela con Theme.of(context).extension<T>() y escribe un lerp real para que el AnimatedTheme de MaterialApp interpole tus tokens durante el cambio entre claro y oscuro. Cubre colores, radios, sombras, estilos de texto y booleanos, el fallo por extensión ausente, la trampa de copyWith que descarta todas las demás extensiones y por qué necesitas == y hashCode, todo verificado con pruebas de widgets en Flutter 3.44.8."
pubDate: 2026-10-19
template: how-to
tags:
  - "flutter"
  - "dart"
  - "theming"
  - "material-3"
  - "how-to"
lang: "es"
translationOf: "2026/10/how-to-define-custom-design-tokens-with-themeextension-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-19
---

**Respuesta corta:** crea una clase `@immutable` que extienda `ThemeExtension<AppTokens>`, dale los campos que necesite tu sistema de diseño (colores, radios, espaciado, sombras, estilos de texto) e implementa `copyWith` y `lerp`. Coloca una instancia en `ThemeData(extensions: [...])` para `theme` y otra para `darkTheme`, y luego léela en cualquier parte con `Theme.of(context).extension<AppTokens>()!`. `MaterialApp` ya envuelve tu aplicación en un `AnimatedTheme`, que llama a `ThemeData.lerp` en cada fotograma durante un cambio de tema, y este a su vez llama a tu `lerp`. Si tu `lerp` interpola cada campo con `Color.lerp`, `lerpDouble`, `BorderRadius.lerp` y similares, tus tokens personalizados se funden entre claro y oscuro exactamente en los mismos 200 ms que el `ColorScheme` integrado. Todo lo que sigue se verificó con pruebas de widgets en Flutter 3.44.8 (Dart 3.12.2).

El resto de este artículo cubre qué es realmente `ThemeExtension` dentro de `ThemeData`, una clase de tokens completa con siete tipos de campo distintos, la configuración en `MaterialApp`, cómo controlar la animación y cuatro problemas que encontré en las pruebas: una extensión que existe solo en uno de los temas, `copyWith` eliminando en silencio tus otras extensiones, una animación que se reinicia en cada reconstrucción y booleanos que cambian exactamente en el punto medio.

## Por qué ColorScheme no basta para los design tokens

El `ColorScheme` de Material 3 tiene unos 45 roles, y si defines tu color de marca con `ColorScheme.fromSeed` obtienes gratis una paleta coherente (consulta [cómo establecer el color de acento con un ColorScheme de Material 3](/es/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/)). Pero un sistema de diseño real tiene tokens en los que Material nunca pensó: un verde de "éxito" que no es `tertiary`, una superficie elevada de tarjeta que difiere de `surfaceContainerHigh` en unos pocos puntos porcentuales, un estilo de texto para bloques de código, un radio de tarjeta, una sombra que existe en modo claro y desaparece en modo oscuro.

Las soluciones habituales son todas malas. Una clase global `AppColors` con constantes estáticas no puede cambiar con el brillo. Un ternario `context.isDark ? x : y` esparcido por los widgets cambia de golpe cuando el tema cambia mientras el resto de la aplicación se anima, lo que se ve roto. Un `InheritedWidget` personalizado funciona, pero tienes que reconstruir la infraestructura de animación que `ThemeData` ya tiene.

`ThemeExtension` se añadió a Flutter en la versión 3.0 (PR #98033) para resolver exactamente esto. Te permite colgar tus propios objetos tipados de `ThemeData`, y como `ThemeData.lerp` los conoce, participan en las animaciones de tema.

## Qué hace ThemeData con tu extensión

Todo el mecanismo es lo bastante pequeño como para leerlo de una sentada. Desde `packages/flutter/lib/src/material/theme_data.dart` en Flutter 3.44.8:

```dart
// Flutter 3.44.8, theme_data.dart (abridged)
abstract class ThemeExtension<T extends ThemeExtension<T>> {
  const ThemeExtension();

  Object get type => T;

  ThemeExtension<T> copyWith();

  ThemeExtension<T> lerp(covariant ThemeExtension<T>? other, double t);
}

// On ThemeData:
final Map<Object, ThemeExtension<dynamic>> extensions;

T? extension<T>() => extensions[T] as T?;
```

De esto se desprenden tres hechos:

1. Las extensiones se almacenan en un `Map` con clave `type`, que es el argumento genérico `T`. Puedes tener como máximo una extensión por tipo, y la búsqueda es una lectura de mapa.
2. `extension<T>()` devuelve `T?`. Si el tema actual no tiene una entrada para `T`, obtienes `null`, no una excepción.
3. `lerp` es responsabilidad tuya. El framework nunca inspecciona tus campos.

Y así es como `ThemeData.lerp` combina los dos mapas:

```dart
// Flutter 3.44.8, ThemeData._lerpThemeExtensions
final Map<Object, ThemeExtension<dynamic>> newExtensions = a.extensions.map((
  Object id,
  ThemeExtension<dynamic> extensionA,
) {
  final ThemeExtension<dynamic>? extensionB = b.extensions[id];
  return MapEntry<Object, ThemeExtension<dynamic>>(id, extensionA.lerp(extensionB, t));
});
// Add [b]-only extensions.
newExtensions.addEntries(
  b.extensions.entries.where(
    (MapEntry<Object, ThemeExtension<dynamic>> entry) => !a.extensions.containsKey(entry.key),
  ),
);
```

A cada extensión del tema de origen se le llama `lerp(matching, t)`, donde `matching` puede ser `null`. Las extensiones que solo existen en el tema de destino se copian sin interpolación. Ten esto presente para la sección de problemas.

## Paso a paso: construir un conjunto de tokens animado

1. Define una subclase `@immutable` de `ThemeExtension<AppTokens>` con solo campos no anulables.
2. Implementa `copyWith` para que quien la use pueda sobrescribir tokens individuales.
3. Implementa `lerp` con el helper `lerp` correspondiente para cada tipo de campo.
4. Sobrescribe `==` y `hashCode` para que los conjuntos de tokens iguales se comparen como iguales.
5. Registra una instancia clara en `theme` y una oscura en `darkTheme`.
6. Lee los tokens mediante un getter de extensión sobre `BuildContext`.

### Pasos 1 a 4: la clase de tokens

```dart
// Flutter 3.44.8, Dart 3.12.2
import 'dart:ui' show lerpDouble;

import 'package:flutter/foundation.dart' show listEquals;
import 'package:flutter/material.dart';

@immutable
class AppTokens extends ThemeExtension<AppTokens> {
  const AppTokens({
    required this.surfaceRaised,
    required this.success,
    required this.cardRadius,
    required this.cardElevationShadow,
    required this.gap,
    required this.codeStyle,
    required this.useHairlineBorders,
  });

  final Color surfaceRaised;
  final Color success;
  final BorderRadius cardRadius;
  final List<BoxShadow> cardElevationShadow;
  final double gap;
  final TextStyle codeStyle;
  final bool useHairlineBorders;

  static const light = AppTokens(
    surfaceRaised: Color(0xFFFFFFFF),
    success: Color(0xFF1B873F),
    cardRadius: BorderRadius.all(Radius.circular(12)),
    cardElevationShadow: [
      BoxShadow(color: Color(0x1F000000), blurRadius: 12, offset: Offset(0, 4)),
    ],
    gap: 16,
    codeStyle: TextStyle(fontFamily: 'monospace', fontSize: 13, color: Color(0xFF24292F)),
    useHairlineBorders: false,
  );

  static const dark = AppTokens(
    surfaceRaised: Color(0xFF1E2228),
    success: Color(0xFF4ADE80),
    cardRadius: BorderRadius.all(Radius.circular(12)),
    cardElevationShadow: [
      BoxShadow(color: Color(0x00000000), blurRadius: 0, offset: Offset.zero),
    ],
    gap: 16,
    codeStyle: TextStyle(fontFamily: 'monospace', fontSize: 13, color: Color(0xFFE6EDF3)),
    useHairlineBorders: true,
  );

  @override
  AppTokens copyWith({
    Color? surfaceRaised,
    Color? success,
    BorderRadius? cardRadius,
    List<BoxShadow>? cardElevationShadow,
    double? gap,
    TextStyle? codeStyle,
    bool? useHairlineBorders,
  }) {
    return AppTokens(
      surfaceRaised: surfaceRaised ?? this.surfaceRaised,
      success: success ?? this.success,
      cardRadius: cardRadius ?? this.cardRadius,
      cardElevationShadow: cardElevationShadow ?? this.cardElevationShadow,
      gap: gap ?? this.gap,
      codeStyle: codeStyle ?? this.codeStyle,
      useHairlineBorders: useHairlineBorders ?? this.useHairlineBorders,
    );
  }

  @override
  AppTokens lerp(AppTokens? other, double t) {
    if (other is! AppTokens) return this;
    return AppTokens(
      surfaceRaised: Color.lerp(surfaceRaised, other.surfaceRaised, t)!,
      success: Color.lerp(success, other.success, t)!,
      cardRadius: BorderRadius.lerp(cardRadius, other.cardRadius, t)!,
      cardElevationShadow:
          BoxShadow.lerpList(cardElevationShadow, other.cardElevationShadow, t)!,
      gap: lerpDouble(gap, other.gap, t)!,
      codeStyle: TextStyle.lerp(codeStyle, other.codeStyle, t)!,
      useHairlineBorders: t < 0.5 ? useHairlineBorders : other.useHairlineBorders,
    );
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is AppTokens &&
          other.surfaceRaised == surfaceRaised &&
          other.success == success &&
          other.cardRadius == cardRadius &&
          listEquals(other.cardElevationShadow, cardElevationShadow) &&
          other.gap == gap &&
          other.codeStyle == codeStyle &&
          other.useHairlineBorders == useHairlineBorders;

  @override
  int get hashCode => Object.hash(
        surfaceRaised,
        success,
        cardRadius,
        Object.hashAll(cardElevationShadow),
        gap,
        codeStyle,
        useHairlineBorders,
      );
}
```

Algunas decisiones aquí son deliberadas:

- **Campos no anulables.** El ejemplo oficial del repositorio de Flutter (`examples/api/lib/material/theme/theme_extension.1.dart`) usa `Color?`. Eso compila, pero entonces cada punto de uso necesita `!` o un valor de respaldo, y `Color.lerp(null, x, t)` se funde desde transparente, que rara vez es lo que quieres. Si un token siempre existe en tu sistema de diseño, hazlo obligatorio.
- **El tipo del parámetro de `lerp` es `AppTokens?`, no `ThemeExtension<AppTokens>?`.** La firma base marca el parámetro como `covariant`, así que puedes estrecharlo. `other is! AppTokens` cubre el caso `null`.
- **Cada tipo de campo tiene un `lerp` estático correspondiente.** `Color.lerp`, `lerpDouble`, `BorderRadius.lerp`, `EdgeInsets.lerp`, `TextStyle.lerp`, `BoxShadow.lerpList`, `Gradient.lerp`, `Offset.lerp` y `Size.lerp` existen todos. Devuelven tipos anulables porque aceptan entradas anulables, de ahí el `!` cuando ambas entradas son no anulables.
- **Los valores discretos cambian en el punto medio.** No existe un valor con sentido a medio camino entre `true` y `false`. El propio `ThemeData` usa el patrón `t < 0.5 ? a : b` para cosas como `platform` y `useMaterial3`, así que lo copio.
- **Una sombra que "desaparece" es una sombra transparente, no una lista vacía.** `BoxShadow.lerpList` puede interpolar listas de distinta longitud, pero una sombra con la misma geometría y alfa cero produce un fundido limpio. En mi prueba, en el punto medio el alfa de la sombra fue `0.0608`, aproximadamente la mitad del valor claro `0x1F` (`0.1216`), que es exactamente el fundido que quieres.

### Paso 5: registrar ambas instancias

```dart
// Flutter 3.44.8
MaterialApp(
  theme: ThemeData(
    colorScheme: ColorScheme.fromSeed(seedColor: Colors.teal),
    extensions: const <ThemeExtension<dynamic>>[AppTokens.light],
  ),
  darkTheme: ThemeData(
    colorScheme: ColorScheme.fromSeed(
      seedColor: Colors.teal,
      brightness: Brightness.dark,
    ),
    extensions: const <ThemeExtension<dynamic>>[AppTokens.dark],
  ),
  themeMode: themeMode, // ThemeMode.system, .light or .dark
  home: const HomePage(),
);
```

Eso es toda la configuración de animación que necesitas. `_MaterialAppState._materialBuilder` elige `theme` o `darkTheme` según `themeMode` y el brillo de la plataforma, y luego envuelve el subárbol en `AnimatedTheme(data: theme, duration: ..., curve: ...)`. Cuando cambia el `ThemeData` seleccionado, `AnimatedTheme` ejecuta un `ThemeDataTween`, cuyo `lerp` es literalmente `ThemeData.lerp(begin!, end!, t)`. Tus tokens ya forman parte de ese tween.

Esto funciona tanto cuando tu propio código cambia `themeMode` como cuando el usuario activa el modo oscuro en el sistema operativo mientras `themeMode` es `ThemeMode.system`.

### Paso 6: leer los tokens sin ceremonia

`Theme.of(context).extension<AppTokens>()!` es largo. Una extensión de `BuildContext` hace que los puntos de uso se lean como código de sistema de diseño:

```dart
// Flutter 3.44.8
extension AppTokensContext on BuildContext {
  AppTokens get tokens => Theme.of(this).extension<AppTokens>()!;
}

class TokenCard extends StatelessWidget {
  const TokenCard({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    return Container(
      padding: EdgeInsets.all(tokens.gap),
      decoration: BoxDecoration(
        color: tokens.surfaceRaised,
        borderRadius: tokens.cardRadius,
        boxShadow: tokens.cardElevationShadow,
        border: tokens.useHairlineBorders
            ? Border.all(color: Theme.of(context).colorScheme.outlineVariant, width: 0.5)
            : null,
      ),
      child: DefaultTextStyle.merge(style: tokens.codeStyle, child: child),
    );
  }
}
```

Como `Theme.of` registra una dependencia del tema heredado, `TokenCard` se reconstruye en cada fotograma de la animación del tema y ve los valores interpolados. Ten en cuenta que `Container` con `color` y `decoration` a la vez lanza una excepción, por eso el color vive dentro de `BoxDecoration` (la historia completa está en [la solución a "Cannot provide both a color and a decoration"](/es/2026/07/fix-cannot-provide-both-a-color-and-a-decoration-in-a-flutter-container/)).

## Demostrar que los tokens realmente se animan

La inspección visual no es fiable a 200 ms. Una prueba de widgets que avanza hasta la mitad de la animación sí lo es:

```dart
// Flutter 3.44.8, flutter_test
AppTokens? seen;

class Probe extends StatelessWidget {
  const Probe({super.key});
  @override
  Widget build(BuildContext context) {
    seen = Theme.of(context).extension<AppTokens>();
    return const SizedBox();
  }
}

Widget app(ThemeMode mode) => MaterialApp(
      theme: ThemeData(extensions: const [AppTokens.light]),
      darkTheme: ThemeData(
        brightness: Brightness.dark,
        extensions: const [AppTokens.dark],
      ),
      themeMode: mode,
      home: const Probe(),
    );

testWidgets('tokens interpolate during a theme switch', (tester) async {
  await tester.pumpWidget(app(ThemeMode.light));
  expect(seen!.surfaceRaised, AppTokens.light.surfaceRaised);

  await tester.pumpWidget(app(ThemeMode.dark));
  await tester.pump(const Duration(milliseconds: 100)); // halfway of 200 ms
  expect(seen!.surfaceRaised, isNot(AppTokens.light.surfaceRaised));
  expect(seen!.surfaceRaised, isNot(AppTokens.dark.surfaceRaised));

  await tester.pumpAndSettle();
  expect(seen!.surfaceRaised, AppTokens.dark.surfaceRaised);
});
```

A los 100 ms el color de la superficie fue `Color(red: 0.5588, green: 0.5667, blue: 0.5784)`, casi exactamente el punto medio entre blanco y `#1E2228`. La curva por defecto es `Curves.linear`, así que `t` es igual al tiempo transcurrido dividido por la duración.

## Controlar la duración y la curva

`MaterialApp` expone la animación mediante dos parámetros antiguos y uno nuevo:

```dart
// Flutter 3.44.8
MaterialApp(
  // Older API, still supported:
  themeAnimationDuration: const Duration(milliseconds: 350),
  themeAnimationCurve: Curves.easeInOut,

  // Newer API, takes precedence when non-null:
  themeAnimationStyle: AnimationStyle(
    duration: const Duration(milliseconds: 350),
    curve: Curves.easeInOutCubic,
  ),
  // ...
);
```

El valor por defecto es `kThemeAnimationDuration`, que son 200 ms. Pasar `themeAnimationStyle: AnimationStyle.noAnimation` reemplaza `AnimatedTheme` por un `Theme` simple, de modo que el cambio es instantáneo. Confirmé que el primer fotograma tras el cambio ya informa el `surfaceRaised` oscuro en ese modo. Esa es la configuración correcta para las pruebas golden y para los usuarios que activan "reducir movimiento", algo que puedes leer con `MediaQuery.disableAnimationsOf(context)`.

## Problemas que aparecieron en las pruebas

### Una extensión ausente en uno de los temas provoca un fallo al final de la animación

Supón que registras `AppTokens.light` en `theme` pero lo olvidas en `darkTheme`. Durante la animación, `_lerpThemeExtensions` llama a `AppTokens.light.lerp(null, t)`, que devuelve `this`, así que los widgets siguen viendo los tokens claros. En mi prueba el fotograma del punto medio devolvió una instancia de `AppTokens`. Luego el tween llega a `t == 1.0`, `Tween.transform` devuelve `end` directamente, y `end` no tiene ningún `AppTokens`. `extension<AppTokens>()` devuelve `null` y `context.tokens` lanza un error de comprobación de nulo en el último fotograma.

El resultado es un fallo que solo ocurre después de un cambio de tema, que es el tipo más fácil de pasar por alto. La solución es estructural: construye ambos temas desde una sola función para que la lista de extensiones esté siempre presente.

```dart
// Flutter 3.44.8
ThemeData buildTheme(Brightness brightness) {
  final isDark = brightness == Brightness.dark;
  return ThemeData(
    colorScheme: ColorScheme.fromSeed(seedColor: Colors.teal, brightness: brightness),
    extensions: <ThemeExtension<dynamic>>[
      isDark ? AppTokens.dark : AppTokens.light,
    ],
  );
}
```

### ThemeData.copyWith(extensions: ...) reemplaza todo el mapa

Este te muerde cuando sobrescribes un solo token para un subárbol. El código fuente de `ThemeData.copyWith` es:

```dart
extensions: (extensions != null) ? _themeExtensionIterableToMap(extensions) : this.extensions,
```

No hay fusión. En mi prueba, un tema con `AppTokens` y `BrandTokens` que pasó por `copyWith(extensions: [BrandTokens(...)])` salió con `extension<AppTokens>()` devolviendo `null`. Para sobrescribir una extensión y conservar el resto, expande primero los valores existentes. Las entradas posteriores ganan porque el mapa se construye con un bucle `for` con clave `type`:

```dart
// Flutter 3.44.8
final theme = Theme.of(context);
return Theme(
  data: theme.copyWith(
    extensions: [
      ...theme.extensions.values,
      context.tokens.copyWith(gap: 8), // overrides AppTokens only
    ],
  ),
  child: const CompactSection(),
);
```

Deja el literal de lista sin tipo aquí. Escribir `<ThemeExtension<dynamic>>[...]` falla al compilar con "Can't assign spread elements of type 'ThemeExtension<dynamic>' to collection elements of type 'ThemeExtension<ThemeExtension<dynamic>>'" en Dart 3.12.2, una peculiaridad de la cota autorreferencial `T extends ThemeExtension<T>`. Dejar que la inferencia elija el tipo de elemento compila y se comporta correctamente: en mi prueba el subárbol vio `gap: 8.0` y la extensión `BrandTokens` intacta.

Un widget `Theme` simple no se anima. Si la propia sobrescritura debe hacer una transición (por ejemplo, una sección de "zona de peligro" que se tiñe al pasar el cursor), usa `AnimatedTheme` directamente.

### Sin == y hashCode la animación del tema se reinicia en cada reconstrucción

`ThemeData.==` compara `extensions` con `mapEquals`, que llama a `==` en cada extensión. Si tu clase no sobrescribe `==`, dos instancias con valores idénticos no son iguales. Eso importa en cuanto construyes tokens en tiempo de ejecución en lugar de usar instancias `const`, por ejemplo a partir del color de acento elegido por el usuario, o con `AppTokens.light.copyWith()` dentro de `build`.

Lo probé reconstruyendo `MaterialApp` con una instancia nueva pero idéntica de `copyWith()` después de que la primera animación se hubiera asentado. Sin `==`, `tester.hasRunningAnimations` fue `true`: `AnimatedTheme` vio un tema "nuevo" e inició otro tween de 200 ms, reconstruyendo todos los widgets que dependen del tema durante 12 fotogramas sin ningún cambio visual. Tras añadir las sobrescrituras de `==` y `hashCode` mostradas arriba, la misma prueba informó `false`. Si no quieres escribirlas a mano, paquetes como `theme_extensions_builder` generan `copyWith`, `lerp`, `==` y `hashCode` a partir de una anotación.

### Los booleanos y enums cambian exactamente en t = 0.5

Con el patrón `t < 0.5`, `useHairlineBorders` ya era `true` en el fotograma de 100 ms, porque `t` era exactamente `0.5`. Eso es coherente con cómo `ThemeData` interpola sus propios campos discretos, pero significa que un borde puede aparecer de golpe a mitad de un fundido de color. Si eso se ve mal, expresa lo visual como un token continuo: reemplaza el booleano por un `Color` de borde que vaya de transparente a `outlineVariant`, y deja que `Color.lerp` se encargue.

### La clave es el argumento genérico, no el tipo en tiempo de ejecución

`type` devuelve `T`, el argumento de tipo que pasaste a `ThemeExtension`, no `runtimeType`. Si escribes `class BrandAppTokens extends AppTokens`, una instancia de ella se almacena bajo `AppTokens` y reemplaza a la base. Eso suele ser lo que quieres para el white-labelling, pero significa que no puedes registrar una base y una subclase una al lado de la otra.

## Dónde encaja ThemeExtension junto a otras herramientas de temas

Usa `ColorScheme` primero para todo lo que consuman los componentes de Material, porque los botones, chips y barras de aplicación nunca leerán tu extensión. Usa los temas de componentes (`CardThemeData`, `FilledButtonThemeData`) cuando quieras rediseñar un widget de Material en todas partes. Usa `ThemeExtension` para todo lo que tus propios widgets necesiten y para lo que Material no tiene un espacio. Si además cargas fuentes con `google_fonts`, mantén el `TextTheme` en `ThemeData.textTheme` y coloca en la extensión solo los estilos no estándar (bloques de código, visualizaciones numéricas); el desajuste de tipos que a veces aparece ahí se cubre en [la solución del TextTheme de google_fonts](/es/2026/09/fix-textheme-cant-be-assigned-to-textheme-google-fonts-material-ui/).

El mismo modelo de "valor ambiental del widget heredado más cercano" impulsa a `IconTheme`, lo que explica por qué los iconos toman colores que no estableciste, como se describe en [cómo evitar que ImageIcon se tiña con el color de IconTheme](/es/2026/09/how-to-stop-imageicon-from-tinting-an-icon-with-the-icontheme-color-in-flutter/). Y si el botón de alternancia de tu tema cambia un icono de sol por uno de luna, [AnimatedSwitcher necesita una clave para animar ese cambio](/es/2026/10/how-to-make-animatedswitcher-animate-when-the-child-type-does-not-change/).

### Lecturas recomendadas

- [Cómo establecer el color de acento en una aplicación Flutter con el ColorScheme de Material 3](/es/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/)
- [Cómo hacer que AnimatedSwitcher se anime cuando el tipo del widget hijo no cambia](/es/2026/10/how-to-make-animatedswitcher-animate-when-the-child-type-does-not-change/)
- [Cómo evitar que ImageIcon tiña un icono con el color ambiental de IconTheme](/es/2026/09/how-to-stop-imageicon-from-tinting-an-icon-with-the-icontheme-color-in-flutter/)
- [Fix: The argument type 'TextTheme' can't be assigned to the parameter type 'TextTheme?' with google_fonts](/es/2026/09/fix-textheme-cant-be-assigned-to-textheme-google-fonts-material-ui/)

## Fuentes

- [`ThemeExtension` class, Flutter API docs](https://api.flutter.dev/flutter/material/ThemeExtension-class.html)
- [`ThemeData.extensions` property, Flutter API docs](https://api.flutter.dev/flutter/material/ThemeData/extensions.html)
- [`MaterialApp.themeAnimationStyle`, Flutter API docs](https://api.flutter.dev/flutter/material/MaterialApp/themeAnimationStyle.html)
- [`theme_data.dart` source on GitHub](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/src/material/theme_data.dart)
- [Official `ThemeExtension` sample, `theme_extension.1.dart`](https://github.com/flutter/flutter/blob/master/examples/api/lib/material/theme/theme_extension.1.dart)
- [Introduce Theme extensions (flutter/flutter#98033)](https://github.com/flutter/flutter/pull/98033)
