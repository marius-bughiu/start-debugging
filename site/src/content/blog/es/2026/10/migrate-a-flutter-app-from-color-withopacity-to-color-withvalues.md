---
title: "Migra una app de Flutter de Color.withOpacity a Color.withValues (Flutter 3.27+)"
description: "Reemplaza los obsoletos Color.withOpacity, opacity, value, red, green, blue y alpha por withValues, .a/.r/.g/.b y toARGB32. Qué reescribe dart fix por ti, los cuatro getters que deja sin tocar, por qué se rompen las aserciones de color exacto y las búsquedas en Map<Color, T> tras el cambio, y cómo withOpacity descarta Display P3 en silencio. Medido en Flutter 3.44.8 con Dart 3.12.2."
pubDate: 2026-10-23
updatedDate: 2026-10-23
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "colors"
lang: "es"
translationOf: "2026/10/migrate-a-flutter-app-from-color-withopacity-to-color-withvalues"
translatedBy: "claude"
translationDate: 2026-10-23
---

`Color.withOpacity` está obsoleto desde Flutter 3.27.0, cuando `dart:ui` empezó a almacenar los componentes de color como valores de punto flotante con un `ColorSpace`. El reemplazo es `color.withValues(alpha: x)`, y sus equivalentes son `.a` para `.opacity`, `toARGB32()` para `.value`, y `.r`/`.g`/`.b` (doubles de 0.0 a 1.0) para `.red`/`.green`/`.blue` (enteros de 0 a 255). `dart fix --apply` reescribe `withOpacity`, `opacity` y `value` por ti, pero deja `red`, `green`, `blue` y `alpha` en tus manos. El cambio no es puramente cosmético: `withOpacity(0.5)` almacena un alfa de `0.50196` (128/255), mientras que `withValues(alpha: 0.5)` almacena exactamente `0.5`, así que esos dos colores ya no son `==`. Cualquier prueba que haga `expect(color, const Color(0x80000000))` o cualquier `Map<Color, T>` con claves del valor anterior se rompe tras la migración. Una app típica toma de 30 minutos a una hora, la mayor parte en las pruebas. Todo lo que sigue se ejecutó en Flutter 3.44.8 (Dart 3.12.2).

## Por qué dejar withOpacity ahora

- **Precisión.** `withOpacity` cuantiza el alfa a 8 bits: su cuerpo es literalmente `withAlpha((255.0 * opacity).round())`. `withValues` conserva el double que le pasaste. Para animaciones que se desvanecen en muchos pasos pequeños, esa es la diferencia entre 256 niveles de alfa posibles y niveles continuos.
- **Espacios de color.** `withValues` conserva el `colorSpace` del receptor. `withOpacity` y `withAlpha` pasan por `Color.fromARGB`, que siempre construye un color sRGB, así que un color Display P3 vuelve etiquetado como sRGB. Más sobre esto en las trampas.
- **Las obsolescencias se convertirán en eliminaciones.** La guía de migración de Flutter describe la eliminación de la API de 8 bits como la "Phase 2", que aún no ha llegado. Cuando llegue, cada `withOpacity`, `.value` y `.red` restante pasará de ser un diagnóstico `info` a un error de compilación.
- **Ruido.** Una app grande puede tener cientos de avisos `deprecated_member_use` solo por estos getters, lo que entierra las obsolescencias que realmente necesitas atender.

## Qué cambia en la app

| Área | Cambio | Severidad |
| --- | --- | --- |
| Pruebas con igualdad exacta de `Color` | `withValues(alpha: 0.5) != const Color(0x80000000)`; usa `isSameColorAs` | alta |
| Claves de `Map<Color, T>` / `Set<Color>` | El color antiguo y el nuevo tienen hash distinto; las búsquedas devuelven `null` | alta |
| Aritmética con `.red`/`.green`/`.blue` | Los reemplazos son doubles de 0.0 a 1.0; los umbrales enteros como `< 128` se rompen en silencio | alta |
| Llamadas a `withOpacity(x)` | Pasa a `withValues(alpha: x)`, aplicado por `dart fix` | baja |
| `.value` / `.opacity` | Pasan a `toARGB32()` / `.a`, aplicado por `dart fix` | baja |
| Clases que hacen `implements Color` | Deben implementar `a`, `r`, `g`, `b`, `colorSpace`, `toARGB32`, `withValues` | media |

## Lista de verificación previa

- Flutter 3.27.0 o posterior, idealmente la versión estable actual. `CupertinoDynamicColor.withValues` y su regla de `dart fix` llegaron después (los mensajes de obsolescencia dicen "deprecated after v3.33.0-1.0.pre"), así que las apps con mucho Cupertino deberían estar en 3.35 o posterior.
- Un `git status` limpio, para poder revisar la salida de `dart fix` como un único diff.
- Un conjunto de pruebas que pase antes de empezar. Los fallos de igualdad de color son la señal principal de que algo cambió, y quieres que sean los únicos fallos.
- Una lista de los lugares donde se persisten colores (shared preferences, JSON, una base de datos). Ahí es donde importan las conversiones a entero.

## Pasos de la migración

1. **Haz un inventario de los miembros obsoletos.** Ejecuta `flutter analyze` y filtra por los getters de color, para saber qué no tocará `dart fix`:

    ```bash
    # Flutter 3.44.8
    flutter analyze 2>&1 | grep deprecated_member_use | grep -E "'(withOpacity|opacity|value|red|green|blue|alpha)'"
    ```

    Con este archivo de ejemplo:

    ```dart
    // Flutter 3.44.8, Dart 3.12.2 (before)
    import 'package:flutter/material.dart';

    Color scrim(Color base) => base.withOpacity(0.54);

    bool isDark(Color c) => (c.red * 0.299 + c.green * 0.587 + c.blue * 0.114) < 128;

    int serialize(Color c) => c.value;

    double fade(Color c) => c.opacity;

    int alphaByte(Color c) => c.alpha;
    ```

    el analizador reporta siete `deprecated_member_use` de nivel info, uno por miembro, cada uno con el reemplazo sugerido, como `'red' is deprecated and shouldn't be used. Use (*.r * 255.0).round().clamp(0, 255).`

    Verifica: tienes un conteo. Guárdalo, lo compararás en el paso 3.

2. **Aplica las correcciones basadas en datos.** Flutter incluye reglas `fix_data` para exactamente tres miembros de `Color`: `withOpacity` a `withValues(alpha: ...)`, `opacity` a `a`, y `value` a `toARGB32()`. Primero una vista previa y luego aplica:

    ```bash
    # Flutter 3.44.8
    dart fix --dry-run .
    dart fix --apply .
    ```

    La ejecución en seco sobre el ejemplo reporta `deprecated_member_use - 3 fixes`, y el diff es:

    ```diff
    -Color scrim(Color base) => base.withOpacity(0.54);
    +Color scrim(Color base) => base.withValues(alpha: 0.54);
    -int serialize(Color c) => c.value;
    +int serialize(Color c) => c.toARGB32();
    -double fade(Color c) => c.opacity;
    +double fade(Color c) => c.a;
    ```

    Las mismas reglas existen para `CupertinoDynamicColor.withOpacity`. En un monorepo, ejecútalo una vez desde la raíz; el analizador detecta cada `pubspec.yaml` anidado.

    Verifica: `flutter analyze` ahora reporta cuatro obsolescencias de color en lugar de siete, todas de `red`, `green`, `blue` o `alpha`.

3. **Reescribe a mano los getters enteros, conservando la escala.** Aquí es donde aparecen los errores reales. `.red` devuelve un `int` de 0 a 255; `.r` devuelve un `double` de 0.0 a 1.0. Cambiar uno por otro compila sin problema porque ambos son `num`, y luego la comparación queda mal para siempre:

    ```dart
    // Flutter 3.44.8: compiles, always returns true
    bool isDark(Color c) => (c.r * 0.299 + c.g * 0.587 + c.b * 0.114) < 128;
    ```

    O bien mueve toda la expresión a la escala de 0 a 1, o bien convierte explícitamente donde de verdad necesites bytes:

    ```dart
    // Flutter 3.44.8, Dart 3.12.2 (after)
    bool isDark(Color c) => (c.r * 0.299 + c.g * 0.587 + c.b * 0.114) < 0.5;

    // Or, better for contrast decisions, the built-in WCAG luminance:
    bool isDarkWcag(Color c) => c.computeLuminance() < 0.179;

    extension ColorBytes on Color {
      int get alpha8 => (a * 255.0).round().clamp(0, 255);
      int get red8 => (r * 255.0).round().clamp(0, 255);
      int get green8 => (g * 255.0).round().clamp(0, 255);
      int get blue8 => (b * 255.0).round().clamp(0, 255);
    }

    int alphaByte(Color c) => c.alpha8;
    ```

    La extensión usa la fórmula exacta que sugiere el mensaje de obsolescencia, y coincide con `toARGB32()`, que internamente hace `(x * 255.0).round().clamp(0, 255)` por canal. Para `Colors.blue[500]` (`0xFF2196F3`), `.red` es `33` y `.r` es `0.12941176470588237`.

    Verifica: `flutter analyze` reporta cero obsolescencias de color, y `grep -rnE '\.(red|green|blue)\b' lib/` no muestra nada que compare un double al estilo `.r` con un literal del tamaño de un byte.

4. **Corrige las aserciones de color exacto en las pruebas.** Ejecuta el conjunto de pruebas. Cualquier prueba que compare un color migrado con un literal entero ahora falla, porque el literal pasa por el constructor de 8 bits y obtiene un alfa de 128/255:

    ```dart
    // Flutter 3.44.8, flutter_test
    import 'package:flutter/material.dart';
    import 'package:flutter_test/flutter_test.dart';

    Color scrim() => Colors.black.withValues(alpha: 0.5);

    void main() {
      // Fails after the migration
      test('exact', () => expect(scrim(), const Color(0x80000000)));
      // Passes
      test('same color', () => expect(scrim(), isSameColorAs(const Color(0x80000000))));
    }
    ```

    La que falla imprime:

    ```text
    Expected: Color:<Color(alpha: 0.5020, red: 0.0000, green: 0.0000, blue: 0.0000, colorSpace: ColorSpace.sRGB)>
      Actual: Color:<Color(alpha: 0.5000, red: 0.0000, green: 0.0000, blue: 0.0000, colorSpace: ColorSpace.sRGB)>
    ```

    `isSameColorAs` compara cada componente con un umbral por defecto de `colorEpsilon = 0.004` (aproximadamente un paso de 8 bits) y exige el mismo `colorSpace`. Úsalo en todo lugar donde una prueba compare colores producidos por aritmética. Si prefieres mantener la expectativa exacta, escríbela con el mismo constructor que usa el código: `Colors.black.withValues(alpha: 0.5)`.

    Verifica: `flutter test` está en verde, y las únicas ediciones en las pruebas son cambios de matcher, no nuevos valores esperados.

5. **Audita las colecciones indexadas por color y los valores persistidos.** Busca `Map<Color`, `Set<Color>`, `switch` sobre colores y cualquier cosa que almacene `toARGB32()`. Importan ambos sentidos del viaje de ida y vuelta, y la siguiente sección muestra el comportamiento medido.

    Verifica: una prueba unitaria que guarda y recarga un color elegido por el usuario afirma con `isSameColorAs`, no con `==`.

## Verificación

Tras los pasos anteriores, ejecuta:

```bash
# Flutter 3.44.8
flutter analyze
flutter test
dart fix --dry-run .
```

`flutter analyze` no debería mostrar `deprecated_member_use` en miembros de `Color`, `flutter test` debería estar en verde, y `dart fix --dry-run` debería imprimir `Nothing to fix!` para las reglas de color. Después, lanza la app y revisa las pantallas que usan superposiciones translúcidas (scrims, botones deshabilitados, colores de ripple y hover de tu tema). Visualmente nada debería moverse: para cualquier alfa que pasabas a `withOpacity`, el `toARGB32()` del color antiguo y del nuevo es idéntico (`0x80000000` en ambos con 0.5), así que lo que se cuantiza a 8 bits termina igual.

## Cómo revertir

La migración es reversible: `withOpacity`, `.opacity`, `.value` y los getters enteros siguen existiendo en 3.44.8 y conservan su semántica anterior, así que un `git revert` del commit de la migración restaura el comportamiento exacto. A lo que no puedes volver es a una versión futura de Flutter en la que la Phase 2 los haya eliminado. Si necesitas mantenerte en la API obsoleta por un tiempo, suprime el diagnóstico por archivo con `// ignore_for_file: deprecated_member_use` en lugar de hacerlo globalmente, para que las demás obsolescencias sigan visibles.

## Trampas de una migración real

Todo esto proviene de una prueba de sondeo ejecutada en Flutter 3.44.8. Los números son salida impresa, no estimaciones.

### El color antiguo y el nuevo no son iguales, ni tienen el mismo hash

```dart
// Flutter 3.44.8
final o = Colors.black.withOpacity(0.5);
final v = Colors.black.withValues(alpha: 0.5);

print(o.a);                          // 0.5019607843137255
print(v.a);                          // 0.5
print(o == v);                       // false
print(o.toARGB32() == v.toARGB32()); // true (both 0x80000000)
print({o: 'x'}[v]);                  // null
```

`Color.==` compara `a`, `r`, `g`, `b` y `colorSpace` como doubles, y `hashCode` calcula el hash de los mismos campos. Si la mitad de un código base está migrada y la otra mitad no, un color producido en una mitad no encontrará su entrada en un mapa construido por la otra. Migra una tabla de búsqueda y todos los puntos de llamada que la consultan en el mismo commit, o indexa el mapa por `toARGB32()`.

### Persistir con toARGB32 devuelve el color antiguo

```dart
// Flutter 3.44.8
final stored = v.toARGB32();
print(Color(stored) == v); // false
print(Color(stored) == o); // true
```

`toARGB32()` pierde información por diseño: redondea cada canal a un byte. Un color restaurado con `Color(int)` obtiene un alfa de `128/255`, que es el valor de `withOpacity`, no el que guardaste. Eso está bien para dibujar y mal para comprobaciones de igualdad como "¿el acento guardado sigue siendo el seleccionado?". Si necesitas ida y vuelta exactos, almacena los cuatro doubles y el nombre del espacio de color, y reconstruye con `Color.from(alpha: ..., red: ..., green: ..., blue: ..., colorSpace: ...)`.

### `.a` no es `.opacity` con otro nombre

`dart fix` renombra `opacity` a `a`, pero el getter antiguo se calculaba a partir del alfa de 8 bits. Para `Colors.black.withValues(alpha: 0.3)`, `.opacity` devuelve `0.30196078431372547` y `.a` devuelve `0.3`. El código que comparaba `opacity` con un literal como `0.30196` o lo usaba como clave de un mapa cambia de comportamiento tras el renombrado. Es poco común, pero es el único cambio de `dart fix` que no es semánticamente neutro.

### withOpacity convierte en silencio los colores Display P3 a sRGB

```dart
// Flutter 3.44.8
const p3 = Color.from(alpha: 1, red: 1, green: 0, blue: 0, colorSpace: ColorSpace.displayP3);

print(p3.withOpacity(0.5));
// Color(alpha: 0.5020, red: 1.0000, green: 0.0000, blue: 0.0000, colorSpace: ColorSpace.sRGB)
print(p3.withValues(alpha: 0.5));
// Color(alpha: 0.5000, red: 1.0000, green: 0.0000, blue: 0.0000, colorSpace: ColorSpace.displayP3)
```

El rojo P3 queda fuera de sRGB (convertido a sRGB extendido es `red: 1.0931, green: -0.2267, blue: -0.1501`), pero `withOpacity` simplemente reetiqueta los mismos valores de componente como sRGB, así que el color se ve claramente más apagado. `withAlpha(128)` hace lo mismo, y no está obsoleto, por lo que no aparecerá en el analizador. Si tu app usa colores de marca de gama amplia, busca también `withAlpha(` y reemplázalo por `withValues(alpha: n / 255)`.

### withValues no valida el rango

`Colors.black.withOpacity(1.5)` lanza un `AssertionError` en compilaciones de depuración. `Colors.black.withValues(alpha: 1.5)` tiene éxito y almacena `a == 1.5`; `toARGB32()` lo limita a `0xff000000`, pero la igualdad y cualquier otra cosa que lea `.a` ve `1.5`. Si el alfa proviene de aritmética (un valor de animación multiplicado por un factor, por ejemplo), límitalo tú mismo con `clampDouble(x, 0, 1)`. `Color.lerp` limita su salida, así que los tweens son seguros.

### Clases que implementan Color

La guía señala que Flutter pretende hacer `Color` `sealed` eventualmente. Si tienes una clase que hace `implements Color` (algunos paquetes de temas lo hicieron para envolver un color dinámico), ahora debe implementar los getters de punto flotante, `colorSpace`, `toARGB32` y `withValues`. La dirección recomendada es la composición: mantén un campo `Color` y exponlo, en lugar de fingir ser uno. `CupertinoDynamicColor` es la implementación de referencia: cada sobrescritura delega en `_effectiveColor`.

## Relacionado

- Las tres reescrituras mecánicas del paso 2 son correcciones estándar basadas en datos; [ejecutar dart fix en todo un repositorio](/es/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/) cubre las opciones, los casos en que reporta "Nothing to fix" en un repositorio sucio, y por qué su código de salida es inútil en CI.
- La mayoría de las llamadas a `withOpacity` en las apps viven junto a colores del tema. Si de todos modos las vas a tocar, [establecer el color de acento con un ColorScheme de Material 3](/es/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/) muestra cómo derivar esas variantes translúcidas del esquema en lugar de ajustar alfas a mano.
- Los design tokens personalizados son donde se encuentran `Color.lerp` y las comparaciones exactas de color; consulta [definir design tokens con ThemeExtension en Flutter](/es/2026/10/how-to-define-custom-design-tokens-with-themeextension-in-flutter/).
- Otra obsolescencia que se convertirá en error de compilación en una futura actualización: [migrar fuera de describeEnum antes de que Flutter lo elimine](/es/2026/09/migrate-off-describeenum-before-flutter-removes-it/).
- El color de gama amplia solo llega a la pantalla en Impeller; para destinos de escritorio, [migrar una app de Flutter para Windows o Linux a Impeller](/es/2026/10/migrate-a-flutter-windows-or-linux-desktop-app-to-impeller/) cubre el cambio de renderizador.

## Fuentes

- [Migration guide for wide gamut Color](https://docs.flutter.dev/release/breaking-changes/wide-gamut-framework) (docs.flutter.dev)
- [Migration guide for wide gamut CupertinoDynamicColor](https://docs.flutter.dev/release/breaking-changes/wide-gamut-cupertino-dynamic-color) (docs.flutter.dev)
- [`Color.withValues`](https://api.flutter.dev/flutter/dart-ui/Color/withValues.html) y [`Color.withOpacity`](https://api.flutter.dev/flutter/dart-ui/Color/withOpacity.html) (api.flutter.dev)
- [`isSameColorAs` matcher](https://api.flutter.dev/flutter/flutter_test/isSameColorAs.html) (api.flutter.dev)
- [flutter/flutter#127855: Implement wide gamut color support in the Framework](https://github.com/flutter/flutter/issues/127855) y [flutter/engine#54737: Framework wide color](https://github.com/flutter/engine/pull/54737)
- [`fix_dart_ui.yaml` data-driven fixes](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/fix_data/fix_dart_ui.yaml) (flutter/flutter)
