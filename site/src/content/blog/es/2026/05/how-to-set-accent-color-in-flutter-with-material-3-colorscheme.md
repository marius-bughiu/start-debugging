---
title: "Cómo establecer el color de acento en una app Flutter con Material 3 ColorScheme"
description: "La forma correcta en 2026 de establecer un color de acento en Flutter con Material 3: ColorScheme.fromSeed, el atajo colorSchemeSeed, las siete opciones de DynamicSchemeVariant, modo oscuro, dynamic_color en Android 12+ y armonización de colores de marca. Probado en Flutter 3.27.1 y Dart 3.11."
pubDate: 2026-05-06
template: how-to
tags:
  - "flutter"
  - "dart"
  - "material-3"
  - "theming"
  - "how-to"
lang: "es"
translationOf: "2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme"
translatedBy: "claude"
translationDate: 2026-05-06
---

Respuesta corta: Material 3 ya no tiene un "color de acento". El control único más cercano es el color semilla que pasas a `ColorScheme.fromSeed`. Usa `ThemeData(colorSchemeSeed: Colors.deepPurple)` para el caso más simple, o `ColorScheme.fromSeed(seedColor: ..., brightness: Brightness.light)` cuando quieras controlar variante, nivel de contraste o emparejar esquemas claro y oscuro. A partir de esa única semilla, el framework deriva la paleta M3 completa: `primary`, `onPrimary`, `secondary`, `tertiary`, `surface`, `surfaceContainer` y el resto. Verificado en Flutter 3.27.1, Dart 3.11.

Esta guía recorre la forma correcta de hacerlo en 2026, las cosas que parecen correctas pero fallan en modo oscuro o en Android 12+, y cómo conservar un color de marca existente sin perder el sistema tonal de M3.

## Por qué dejó de existir el "color de acento" en M3

Material 2 tenía `primaryColor` y `accentColor` como dos perillas más o menos independientes. Las definías y widgets como `FloatingActionButton`, `Switch` o el cursor de `TextField` elegían una u otra. En Material 3 ese vocabulario desapareció. La especificación reemplaza ambos con un sistema de roles de color que se calculan a partir de una única semilla:

- `primary`, `onPrimary`, `primaryContainer`, `onPrimaryContainer`
- `secondary`, `onSecondary`, `secondaryContainer`, `onSecondaryContainer`
- `tertiary`, `onTertiary`, `tertiaryContainer`, `onTertiaryContainer`
- `surface`, `onSurface`, `surfaceContainerLowest` ... `surfaceContainerHighest`
- `error`, `onError`, más variantes
- `outline`, `outlineVariant`, `inverseSurface`, `inversePrimary`

Lo que en M2 era tu "accent" suele mapear a `primary` en M3, y a veces a `tertiary` si lo usabas para resaltes. La [documentación de roles de color de Material 3](https://m3.material.io/styles/color/roles) es la fuente canónica para saber qué rol va en qué superficie.

La consecuencia práctica: si encuentras una respuesta vieja en StackOverflow que dice "establece `ThemeData.accentColor`", esa propiedad todavía compila por algunos caminos estrechos pero ningún widget de Material 3 la lee. Pasarás una tarde preguntándote por qué nada cambia. Está en desuso y es prácticamente un no-op para los widgets M3.

## El patrón mínimo correcto

Material 3 está activado por defecto en Flutter 3.16 y posteriores. Ya no necesitas establecer `useMaterial3: true`. El color de acento más simple e idiomático para una app nueva:

```dart
// Flutter 3.27.1, Dart 3.11
import 'package:flutter/material.dart';

void main() => runApp(const MyApp());

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Demo',
      theme: ThemeData(
        colorSchemeSeed: Colors.deepPurple,
        brightness: Brightness.light,
      ),
      darkTheme: ThemeData(
        colorSchemeSeed: Colors.deepPurple,
        brightness: Brightness.dark,
      ),
      themeMode: ThemeMode.system,
      home: const Scaffold(),
    );
  }
}
```

`colorSchemeSeed` es un atajo dentro de `ThemeData` equivalente a:

```dart
// What colorSchemeSeed expands to internally
ThemeData(
  colorScheme: ColorScheme.fromSeed(
    seedColor: Colors.deepPurple,
    brightness: Brightness.light,
  ),
);
```

Si solo necesitas la semilla y el brillo, prefiere `colorSchemeSeed`. Recurre directamente a `ColorScheme.fromSeed` cuando necesites afinar la variante, el nivel de contraste o sobrescribir uno o dos roles específicos.

## Cómo elegir un DynamicSchemeVariant

Desde Flutter 3.22 el constructor `ColorScheme.fromSeed` acepta un parámetro `dynamicSchemeVariant`. Este selecciona qué algoritmo de Material Color Utilities deriva la paleta. Las opciones, en orden de qué tan agresivamente conservan tu semilla visible:

- `DynamicSchemeVariant.tonalSpot` (predeterminado): la receta estándar de Material 3. Saturación media, equilibrada. La semilla se convierte en la fuente para `primary`, mientras que `secondary` y `tertiary` se extraen de tonos vecinos.
- `DynamicSchemeVariant.fidelity`: mantiene `primary` muy cerca del color semilla exacto. Úsalo cuando la marca quiera que la semilla se renderice literalmente.
- `DynamicSchemeVariant.content`: similar a `fidelity` pero diseñado para paletas derivadas de contenido (por ejemplo, el color dominante de una imagen hero).
- `DynamicSchemeVariant.monochrome`: escala de grises. `primary`, `secondary` y `tertiary` son todos neutros.
- `DynamicSchemeVariant.neutral`: croma bajo. La semilla apenas tiñe el resultado.
- `DynamicSchemeVariant.vibrant`: empuja el croma. Bueno para apps lúdicas o con mucho contenido multimedia.
- `DynamicSchemeVariant.expressive`: rota `secondary` y `tertiary` más alrededor de la rueda. Visualmente más cargado.
- `DynamicSchemeVariant.rainbow`, `DynamicSchemeVariant.fruitSalad`: variantes extremas, usadas más por launchers de Material You que por apps típicas.

Un ejemplo concreto. Si tu color de marca es exactamente `#7B1FA2` y el equipo de marketing ya aprobó ese morado específico, `tonalSpot` lo desaturará. `fidelity` lo preserva:

```dart
// Flutter 3.27.1
final brand = const Color(0xFF7B1FA2);

final lightScheme = ColorScheme.fromSeed(
  seedColor: brand,
  brightness: Brightness.light,
  dynamicSchemeVariant: DynamicSchemeVariant.fidelity,
);
```

Elige la variante una vez y luego aplícala tanto al brillo claro como al oscuro para que el aspecto sea consistente entre temas.

## Emparejar correctamente esquemas claro y oscuro

Construir dos instancias de `ColorScheme` a partir de la misma semilla (una por `Brightness`) es el enfoque correcto. El framework regenera la paleta tonal por brillo para que las relaciones de contraste se mantengan por encima de los mínimos de M3. No inviertas los colores tú mismo.

```dart
// Flutter 3.27.1
final seed = Colors.indigo;

final light = ColorScheme.fromSeed(
  seedColor: seed,
  brightness: Brightness.light,
);
final dark = ColorScheme.fromSeed(
  seedColor: seed,
  brightness: Brightness.dark,
);

return MaterialApp(
  theme: ThemeData(colorScheme: light),
  darkTheme: ThemeData(colorScheme: dark),
  themeMode: ThemeMode.system,
  home: const Home(),
);
```

Un bug común aquí: construir el tema claro con `Brightness.light` pero olvidarse de pasar `Brightness.dark` al tema oscuro. El esquema oscuro entonces reutiliza los tonos claros, que se ven deslavados sobre superficie negra y fallan el contraste WCAG AA en el texto del cuerpo. Pasa siempre ambos.

Si necesitas más control sobre el contraste, `ColorScheme.fromSeed` acepta un `contrastLevel` desde `-1.0` (menor contraste) hasta `1.0` (mayor contraste). El valor predeterminado `0.0` coincide con la especificación de M3. Un contraste más alto es útil cuando tu app debe satisfacer auditorías de accesibilidad empresariales.

## Usar un color de marca conservando la generación de M3

A veces el color de marca es innegociable pero el resto de la paleta queda libre. Usa `ColorScheme.fromSeed` y sobrescribe un único rol:

```dart
// Flutter 3.27.1
final scheme = ColorScheme.fromSeed(
  seedColor: Colors.indigo,
  brightness: Brightness.light,
).copyWith(
  primary: const Color(0xFF1E3A8A), // exact brand
);
```

Esto deja todo lo demás (`secondary`, `tertiary`, `surface`, etc.) en la paleta derivada algorítmicamente y solo fija `primary`. No sobrescribas más de uno o dos roles. Todo el sentido del sistema M3 es que los roles sean mutuamente consistentes. Fijar cuatro colores normalmente rompe el contraste en algún punto.

Una alternativa más segura cuando tienes varios colores de marca obligatorios es armonizarlos contra la semilla en lugar de reemplazar roles. Las Material Color Utilities exponen `MaterialDynamicColors.harmonize`, disponible a través del paquete [`dynamic_color`](https://pub.dev/packages/dynamic_color):

```dart
// Flutter 3.27.1, dynamic_color 1.7.0
import 'package:dynamic_color/dynamic_color.dart';

final brandError = const Color(0xFFD32F2F);
final harmonized = brandError.harmonizeWith(scheme.primary);
```

`harmonizeWith` desplaza ligeramente el tono de marca hacia la semilla para que ambos coexistan visualmente, sin perder la identidad de la marca. Esta es la herramienta correcta cuando el sistema de diseño exige un rojo exacto, por ejemplo, para botones de error o destructivos.

## Material You: color dinámico en Android 12+

Si publicas en Android 12 o superior, el sistema puede entregarte un `ColorScheme` derivado del fondo de pantalla. Conéctalo con el `DynamicColorBuilder` de `dynamic_color`. En iOS, web, escritorio o Android antiguo, el builder devuelve `null` y caes de vuelta a tu semilla.

```dart
// Flutter 3.27.1, dynamic_color 1.7.0
import 'package:dynamic_color/dynamic_color.dart';
import 'package:flutter/material.dart';

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return DynamicColorBuilder(
      builder: (lightDynamic, darkDynamic) {
        final ColorScheme light = lightDynamic ??
            ColorScheme.fromSeed(
              seedColor: Colors.indigo,
              brightness: Brightness.light,
            );
        final ColorScheme dark = darkDynamic ??
            ColorScheme.fromSeed(
              seedColor: Colors.indigo,
              brightness: Brightness.dark,
            );

        return MaterialApp(
          theme: ThemeData(colorScheme: light),
          darkTheme: ThemeData(colorScheme: dark),
          themeMode: ThemeMode.system,
          home: const Home(),
        );
      },
    );
  }
}
```

Una sutileza: `lightDynamic` y `darkDynamic` no siempre se derivan del mismo fondo de pantalla. En algunos dispositivos Pixel el esquema oscuro proviene de otra fuente. Trátalos como independientes. Si necesitas armonizar un rojo de marca con cualquiera que sea el esquema con el que terminó el usuario, haz `brandRed.harmonizeWith(scheme.primary)` por build, no una sola vez al arrancar.

## Cómo leer el color en tus widgets

Una vez establecido el esquema, accede a los roles vía `Theme.of(context).colorScheme`. No codifiques valores hex dentro de los widgets y no referencies los getters de M2 `primaryColor` / `accentColor`.

```dart
// Flutter 3.27.1
class CallToAction extends StatelessWidget {
  const CallToAction({super.key, required this.label});
  final String label;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return FilledButton(
      style: FilledButton.styleFrom(
        backgroundColor: scheme.primary,
        foregroundColor: scheme.onPrimary,
      ),
      onPressed: () {},
      child: Text(label),
    );
  }
}
```

`FilledButton` ya usa `primary` y `onPrimary` por defecto, así que el `styleFrom` explícito está ahí solo para mostrar los nombres de los roles. La mayoría de los widgets M3 tienen valores predeterminados sensatos, así que la respuesta más simple a "cómo doy estilo a mis botones con el color de acento" es "elige el widget correcto", no "sobrescribe el style".

Un mapeo rápido para la transición de M2 a M3:

| Idea M2 | Rol M3 |
| --- | --- |
| `accentColor` resaltando toggles, sliders, FAB | `primary` |
| `accentColor` usado como fondo suave de chip | `secondaryContainer` con texto `onSecondaryContainer` |
| `accentColor` usado como un "tercer" resalte | `tertiary` |
| `primaryColor` en app bar | `primary` (o `surface` para el app bar M3 predeterminado) |
| `cardColor` | `surfaceContainer` |
| `dividerColor` | `outlineVariant` |
| `disabledColor` | `onSurface` al 38% de opacidad |

## Cosas que parecen correctas pero están mal

Cinco errores que veo cada semana:

1. **Establecer `useMaterial3: false`** en una app nueva para "facilitar el styling" y luego preguntar por qué `colorSchemeSeed` sigue produciendo tonos M3. `colorSchemeSeed` es solo M3. Si te sales de M3, también te sales de los esquemas de color basados en semilla. Quédate en M3 a menos que tengas un requisito duro.
2. **Construir un `ColorScheme` y reusarlo para ambos temas.** El esquema claro sobre fondo negro falla el contraste. Construye dos a partir de la misma semilla.
3. **Llamar a `ColorScheme.fromSeed` dentro de `build()`** de un widget alto en el árbol. Ejecuta las Material Color Utilities en cada rebuild, lo cual no es catastrófico pero sí desperdicio. Construye el esquema una vez en `main` o en el `State` de tu `App`, y luego pásalo hacia abajo.
4. **Usar `Colors.deepPurple.shade300` como semilla.** Las semillas funcionan mejor cuando están saturadas y tienen un tono claro. Una variante deslavada te da una paleta deslavada. Pasa el color base (por ejemplo, `Colors.deepPurple`, que es la variante 500) y deja que `tonalSpot` haga el trabajo de desaturación para los roles más claros.
5. **Codificar a mano un color hex para el FAB o para el thumb del `Switch` seleccionado** porque "el color de acento se fue". El rol es `primary`. Si `primary` no se ve bien sobre esa superficie, tu variante está mal, no tu widget.

## Limpiar una app antigua: una migración de 5 minutos

Si la app ya tiene `accentColor` o `primarySwatch` en algún lado, la migración correcta más barata es:

1. Eliminar `accentColor` y `primarySwatch` de `ThemeData(...)`.
2. Agregar `colorSchemeSeed: <tu antiguo primary>`.
3. Eliminar `useMaterial3: false` si lo tienes; M3 es el predeterminado en 3.16+.
4. Buscar en tu proyecto `Theme.of(context).accentColor`, `theme.primaryColor` y `theme.colorScheme.background` (renombrado a `surface` en Flutters más recientes), y reemplazar cada uno con el rol M3 correcto de la tabla anterior.
5. Ejecutar `flutter analyze`. Cualquier cosa que siga advirtiendo sobre una propiedad de tema obsoleta recibe el mismo tratamiento.

El cambio visual más grande que verás después de esto es que el fondo predeterminado de `AppBar` ahora es `surface`, no `primary`. Si quieres recuperar el app bar coloreado, define `appBarTheme: AppBarTheme(backgroundColor: scheme.primary, foregroundColor: scheme.onPrimary)`. Muchos equipos descubren después de hecho que en realidad preferían el app bar M3 con `surface` una vez que se acostumbraron.

## Lectura relacionada

Si estás migrando una app Flutter más grande al mismo tiempo, el [recorrido de migración de GetX a Riverpod](/es/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) y la [guía para perfilar jank con DevTools](/es/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) cubren dos cosas que suelen aparecer durante un refresh de theming: la rotación en gestión de estado y tormentas inesperadas de rebuild. Para puentes nativos (por ejemplo, exponer una señal de tema del sistema que no puedes obtener solo desde Flutter), revisa [agregar código específico de plataforma sin plugins](/es/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/). Y si tu matriz de CI cubre SDKs de Flutter viejos y nuevos mientras migras, el post sobre [apuntar a múltiples versiones de Flutter desde un solo pipeline de CI](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) mantiene ambas ramas en verde.

## Fuentes

- API de Flutter: [`ColorScheme.fromSeed`](https://api.flutter.dev/flutter/material/ColorScheme/ColorScheme.fromSeed.html)
- API de Flutter: [`ThemeData.colorSchemeSeed`](https://api.flutter.dev/flutter/material/ThemeData/colorSchemeSeed.html)
- API de Flutter: [`DynamicSchemeVariant`](https://api.flutter.dev/flutter/material/DynamicSchemeVariant.html)
- Especificación de Material 3: [roles de color](https://m3.material.io/styles/color/roles)
- pub.dev: [`dynamic_color`](https://pub.dev/packages/dynamic_color) para Material You y armonización
