---
title: "Cómo reemplazar groupValue y onChanged obsoletos de Radio en Flutter con RadioGroup"
description: "Radio.groupValue y Radio.onChanged quedaron obsoletos después de Flutter 3.32 y RadioGroup llegó en 3.35. Una migración paso a paso para Radio, RadioListTile y CupertinoRadio, por qué dart fix no puede hacerla por ti, y la trampa de inferencia de tipos genéricos que deja un radio migrado deshabilitado en silencio. Verificado en Flutter 3.44.2 stable."
pubDate: 2026-08-11
updatedDate: 2026-08-11
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "material"
  - "accessibility"
lang: "es"
translationOf: "2026/08/how-to-replace-flutter-deprecated-radio-groupvalue-and-onchanged-with-radiogroup"
translatedBy: "claude"
translationDate: 2026-08-11
---

Si `flutter analyze` te dice que `groupValue` y `onChanged` están obsoletos en `Radio`, `RadioListTile` o `CupertinoRadio`, la solución es sacar ambas propiedades de los radios individuales y llevarlas a un único ancestro `RadioGroup<T>` que los envuelva. Calcula unos diez minutos por pantalla: es mecánico, pero `dart fix` no puede hacerlo por ti (lo comprobé, ver más abajo), y hay una trampa que no produce ningún error, solo un radio que deja de responder a los toques sin avisar. La obsolescencia llegó después de `v3.32.0-0.0.pre`, `RadioGroup` se publicó en Flutter 3.35, y las propiedades antiguas siguen presentes en stable 3.44. Todo lo que sigue está verificado contra Flutter 3.44.2 stable con Dart 3.12.

## Por qué Flutter sacó el estado del grupo fuera del radio

La API antigua no tenía ningún concepto de grupo. Cada `Radio` comparaba de forma independiente su propio `value` con un `groupValue` que le pasabas a cada uno, lo que significaba que el framework nunca sabía qué radios pertenecían al mismo conjunto. Eso está bien para pintar un punto, y no sirve para accesibilidad.

El [patrón de grupo de radios de WAI-ARIA](https://www.w3.org/WAI/ARIA/apg/patterns/radio) exige que un grupo se comporte como una sola parada en el orden de tabulación, con las flechas moviendo la selección dentro de él. No puedes implementar eso sin un widget que sea dueño del conjunto. `RadioGroup` es ese widget, y por eso el rediseño ocurrió en lugar de una limpieza cosmética de la API.

El comportamiento que obtienes gratis después de migrar, que confirmé en un widget test sobre 3.44.2:

- **Tab y Shift+Tab** mueven el foco hacia dentro y fuera del grupo completo, no por cada radio uno a uno.
- **Las flechas** mueven la selección entre radios en orden de lectura y dan la vuelta en los extremos. Empezando en `Flavor.vanilla` y presionando flecha abajo dos veces, pasó de `vanilla` a `chocolate` y de vuelta a `vanilla`.
- **Espacio** alterna el radio enfocado.

Hay otra ganancia menor: los radios en sí quedan más cortos. Un `Radio<int>` en un árbol migrado es `Radio<int>(value: 0)` y nada más.

## Qué se rompe

| Área | Cambio | Severidad |
| --- | --- | --- |
| `Radio.groupValue` / `Radio.onChanged` | Obsoletos; muévelos a un ancestro `RadioGroup<T>` | alta |
| `RadioListTile.groupValue` / `.onChanged` | Misma obsolescencia, misma solución | alta |
| `CupertinoRadio.groupValue` / `.onChanged` | Misma obsolescencia, misma solución | alta |
| Deshabilitar un radio | `onChanged: null` reemplazado por `enabled: false` | media |
| Inferencia de tipos genéricos | `RadioGroup<T>` se busca por tipo exacto, y `T` se infiere distinto que en el radio | alta |
| Orden de tabulación | El grupo ahora es una sola parada en vez de N | media |
| `RadioListTile.selected` | Sigue sin coordinarse automáticamente con el estado marcado | baja |
| Migración automatizada | No existe ninguna regla de `dart fix`; esto es una edición a mano | media |

## Lista de verificación previa

- Flutter 3.35 o posterior. `RadioGroup` llegó en `3.34.0-0.0.pre` y alcanzó stable en 3.35, así que en cualquier versión anterior la clase no existe. Compruébalo con `flutter --version`.
- Encuentra cada punto de uso: `flutter analyze` reporta cada uno como `deprecated_member_use`. En un archivo de prueba emitió `'groupValue' is deprecated and shouldn't be used. Use a RadioGroup ancestor to manage group value instead. This feature was deprecated after v3.32.0-0.0.pre.`
- No esperes que `dart fix` ayude. Ejecuté `dart fix --dry-run` contra un proyecto lleno de usos obsoletos de `Radio` en 3.44.2 y obtuve `Nothing to fix!`. No hay ningún `fix_radio*.yaml` en el directorio `lib/fix_data/fix_material` del framework, lo cual tiene sentido: envolver widgets en un ancestro nuevo es una edición estructural, no un renombrado de parámetros.
- Revisa tus dependencias. Algunos paquetes de pub.dev todavía usan la API antigua internamente ([flutter/flutter#170915](https://github.com/flutter/flutter/issues/170915) lo rastrea para los paquetes de primera parte). No puedes migrar un widget que no te pertenece, y no hace falta: las propiedades obsoletas siguen funcionando.

## Pasos de la migración

1. **Envuelve el grupo en `RadioGroup<T>` y mueve `groupValue` y `onChanged` a él.** Esta es toda la migración en una sola edición. La variable de estado y la llamada a `setState` no se mueven; solo las propiedades.

   Antes, en Flutter 3.44:

   ```dart
   // Flutter 3.44, Dart 3.12 - deprecated API
   Widget build(BuildContext context) {
     return Column(
       children: <Widget>[
         Radio<Flavor>(
           value: Flavor.vanilla,
           groupValue: _flavor,
           onChanged: (Flavor? v) => setState(() => _flavor = v),
         ),
         Radio<Flavor>(
           value: Flavor.chocolate,
           groupValue: _flavor,
           onChanged: (Flavor? v) => setState(() => _flavor = v),
         ),
       ],
     );
   }
   ```

   Después:

   ```dart
   // Flutter 3.44, Dart 3.12 - RadioGroup API
   Widget build(BuildContext context) {
     return RadioGroup<Flavor>(
       groupValue: _flavor,
       onChanged: (Flavor? v) => setState(() => _flavor = v),
       child: const Column(
         children: <Widget>[
           Radio<Flavor>(value: Flavor.vanilla),
           Radio<Flavor>(value: Flavor.chocolate),
         ],
       ),
     );
   }
   ```

   Verifica: `flutter analyze` sobre ese archivo baja de cuatro avisos `deprecated_member_use` a cero, y tocar el segundo radio sigue actualizando el estado.

2. **Escribe siempre el argumento de tipo de forma explícita tanto en el grupo como en los radios.** La inferencia de tipos no te dará lo que esperas cuando el tipo del valor es anulable. Escribe `RadioGroup<Flavor?>` y `Radio<Flavor?>`, nunca un `RadioGroup(...)` pelado. La siguiente sección explica por qué esto importa más de lo que parece.

   Verifica: busca en el diff `RadioGroup(` sin `<`. Cada coincidencia es un error latente.

3. **Reemplaza `onChanged: null` por `enabled: false` en cualquier radio que estuvieras deshabilitando.** En la API antigua, un callback nulo era la forma de atenuar una opción. `RadioGroup.onChanged` es `required` y no anulable, así que esa palanca desapareció a nivel de grupo y se movió a cada radio.

   ```dart
   // Flutter 3.44 - one disabled option inside an otherwise live group
   RadioGroup<int>(
     groupValue: _value,
     onChanged: (int? v) => setState(() => _value = v),
     child: const Column(
       children: <Widget>[
         Radio<int>(value: 0),
         Radio<int>(value: 2, enabled: false),
       ],
     ),
   )
   ```

   Verifica: el radio deshabilitado se dibuja en gris y su nodo de semántica tiene `hasEnabledState` sin `isEnabled`.

4. **Haz la misma edición para `RadioListTile` y `CupertinoRadio`.** Aceptan el mismo ancestro `RadioGroup`. `RadioListTile` además conserva su propia propiedad `enabled`, resuelta como `widget.enabled ?? (widget.onChanged != null || registry != null)`.

   ```dart
   // Flutter 3.44 - RadioListTile inside a lazy list
   RadioGroup<int>(
     groupValue: _value,
     onChanged: (int? v) => setState(() => _value = v),
     child: ListView.builder(
       itemCount: options.length,
       itemBuilder: (BuildContext context, int i) =>
           RadioListTile<int>(value: i, title: Text(options[i])),
     ),
   )
   ```

   Verifica: esto funciona con construcción diferida. En un `ListView.builder` de 200 elementos con solo 11 tiles realmente construidos, tocar el elemento 3 fijó el valor del grupo en 3.

5. **Separa los grupos mixtos por tipo, o anídalos.** Si una columna contiene radios de dos tipos de valor distintos, envuelve el conjunto interior en su propio `RadioGroup`. El anidamiento funciona porque la búsqueda es por tipo y, para tipos idénticos, gana el ancestro más cercano. Confirmé que un `RadioGroup<String>` anidado dentro de otro `RadioGroup<String>` enruta los toques solo al `onChanged` del grupo interior.

   Verifica: toca un radio de cada subgrupo y confirma que cada callback se dispara exactamente una vez.

6. **Ejecuta el analizador y los widget tests.** `flutter analyze` no debe reportar ningún `deprecated_member_use` para miembros de radio, y cualquier test que toque un radio debe seguir pasando. Los tests son donde se detecta el fallo silencioso que se describe abajo.

## Verificación

Después de la migración, ejecuta estas cuatro comprobaciones antes de dar la pantalla por terminada:

- `flutter analyze` no reporta ningún `deprecated_member_use` relacionado con radios.
- Cada radio sigue respondiendo visiblemente a un toque. Un radio migrado que se dibuja en gris es el modo de fallo descrito más abajo, no un problema de estilos.
- Teclado: tabula hasta el grupo, presiona flecha abajo, confirma que la selección se mueve. Esta es la funcionalidad por la que migraste, así que vale la pena ejercitarla una vez por pantalla.
- Lector de pantalla o `debugDumpSemanticsTree`: el nodo de semántica de un radio funcional lleva `isEnabled` y una acción `tap`. Uno muerto lleva `hasEnabledState` pero no `isEnabled`.

## Plan de reversión

Esta migración sí es reversible de verdad. Las propiedades obsoletas siguen existiendo en stable 3.44 y no están programadas para eliminarse en ninguna versión anunciada, así que un `git revert` del commit de migración compila y se ejecuta exactamente como antes. Aun así, haz el trabajo en una rama, porque el modo de fallo aquí es silencioso y querrás un diff limpio contra el que hacer bisect.

## La trampa: un radio migrado que deja de funcionar en silencio

Esta es la parte que la guía oficial de migración no cubre, y está detrás de [flutter/flutter#175705](https://github.com/flutter/flutter/issues/175705), un issue que se cerró sin diagnóstico.

Dos hechos se combinan mal.

Primero, un `Radio` sin ancestro `RadioGroup` y sin `onChanged` no lanza excepción. Mira cómo lo resuelve `_RadioState`:

```dart
// packages/flutter/lib/src/material/radio.dart, Flutter 3.44 stable
bool get _enabled =>
    widget.enabled ??
    (widget.onChanged != null ||
        widget.groupRegistry != null ||
        RadioGroup.maybeOf<T>(context) != null);
```

Con los tres en null, `_enabled` es `false` y el radio se dibuja como un control deshabilitado. La aserción `'Radio is enabled but has no Radio.onChange or registry above'` solo se dispara si pasas `enabled: true` de forma explícita. Monté dos widgets `Radio<Flavor>` sin grupo alguno: ninguna excepción, y el nodo de semántica volvió como `flags: [hasCheckedState, hasEnabledState, isInMutuallyExclusiveGroup]`. Fíjate en lo que falta: `isEnabled`, y cualquier acción de toque.

Segundo, `RadioGroup` se encuentra por tipo genérico exacto:

```dart
// packages/flutter/lib/src/widgets/radio_group.dart, Flutter 3.44 stable
static RadioGroupRegistry<T>? maybeOf<T>(BuildContext context) {
  return context.dependOnInheritedWidgetOfExactType<_RadioGroupStateScope<T>>()?.state;
}
```

`dependOnInheritedWidgetOfExactType` significa que `_RadioGroupStateScope<Flavor>` no satisface una búsqueda de `_RadioGroupStateScope<Flavor?>`. La covarianza no te ayuda aquí.

Ahora junta eso con la inferencia de Dart. `RadioGroup` declara `T? groupValue`, mientras que `Radio` y `RadioListTile` declaran `T value`. Pásale a ambos una variable anulable y cada uno infiere un argumento de tipo distinto:

```dart
// Flutter 3.44, Dart 3.12
String? selected;
final group = RadioGroup(groupValue: selected, onChanged: (v) {}, child: const SizedBox());
final tile = RadioListTile(value: selected, title: const Text('x'));
// group.runtimeType -> RadioGroup<String>
// tile.runtimeType  -> RadioListTile<String?>
```

Esos son los tipos en tiempo de ejecución impresos por una ejecución real del test. El grupo es `RadioGroup<String>`; el tile es `RadioListTile<String?>`. El tile busca `_RadioGroupStateScope<String?>`, no encuentra nada, resuelve `_enabled` a `false`, y se dibuja muerto. Sin excepción, sin aviso del analizador.

La reproducción tiene exactamente la forma con la que la gente se topa al migrar una opción "System default", donde `null` es una elección legítima. En un grupo donde un tile recibió `Flavor?` y su hermano recibió `Flavor`, la semántica volvió así:

```text
System  -> flags: [hasEnabledState, hasSelectedState]
Vanilla -> actions: [focus, tap], flags: [hasEnabledState, isEnabled, isFocusable, hasSelectedState]
```

Tocar "System" disparó el `onChanged` del grupo cero veces. Tocar "Vanilla" lo disparó una vez.

La solución es fijar el argumento de tipo en ambos lados:

```dart
// Flutter 3.44 - explicit nullable type argument on group and tiles
RadioGroup<Flavor?>(
  groupValue: _flavor,
  onChanged: (Flavor? v) => setState(() => _flavor = v),
  child: const Column(
    children: <Widget>[
      RadioListTile<Flavor?>(value: null, title: Text('System')),
      RadioListTile<Flavor?>(value: Flavor.vanilla, title: Text('Vanilla')),
    ],
  ),
)
```

Con `RadioGroup<Flavor?>` escrito de forma explícita, tocar "System" fija correctamente el valor del grupo en `null`. Esa es la respuesta al issue cerrado: los valores anulables no están deshabilitados por diseño, simplemente los argumentos de tipo inferidos no coincidían.

## Trampas menores que conviene conocer

**`toggleable` se quedó en el radio.** No es una propiedad a nivel de grupo. Un `Radio<Flavor>(value: Flavor.vanilla, toggleable: true)` dentro de un `RadioGroup<Flavor>` sigue llamando al `onChanged` del grupo con `null` cuando tocas la opción ya seleccionada. Verificado en 3.44.2. Por lo tanto tu `groupValue` tiene que ser anulable si lo usas, lo cual te devuelve directo a la trampa de inferencia de arriba.

**No hay deshabilitación a nivel de grupo.** `RadioGroup.onChanged` es requerido y no anulable, así que no puedes atenuar un grupo entero anulando un callback como hacías antes. Pon `enabled: false` en cada radio, o recorre tus opciones y pasa un indicador.

**`RadioListTile.selected` sigue siendo manual.** El framework documenta que "no effort is made to automatically coordinate the selected state and the checked state" y te dice que pongas `selected: true` cuando `value` coincida con `RadioGroup.groupValue`. Migrar no cambia eso; sigues comparando a mano.

**La navegación por teclado solo alcanza los radios construidos.** En un `ListView.builder`, las flechas solo pueden moverse por los tiles que están en ese momento en el árbol de widgets. En mi prueba de 200 elementos, se construyeron 11. Para una lista larga de opciones esto es un límite real de accesibilidad, y es una buena razón para preferir una `Column` acotada dentro de un scroll view antes que la construcción diferida para grupos de radios. Si de todos modos necesitas la lista diferida, los [patrones de listas con scroll infinito](/es/2026/08/how-to-build-an-infinite-scrolling-paginated-list-in-flutter-with-scrollcontroller/) siguen aplicando.

**`Radio.adaptive` está bien.** Reenvía `groupRegistry: _effectiveRegistry` y `enabled: _enabled` hacia `CupertinoRadio`, así que un radio adaptativo dentro de un `RadioGroup` recoge el registro en iOS y macOS sin trabajo extra.

**Para widgets tipo radio personalizados, implementa el registro.** `RadioGroupRegistry<T>` es una interfaz pública pequeña (`groupValue`, `onChanged`, `registerClient`, `unregisterClient`) y `RawRadio` acepta un `groupRegistry` directamente. Ese es el camino soportado si estás construyendo un control con tema propio que debe participar en la navegación por teclado del grupo. `RawRadio` afirma `'an enabled raw radio must have a registry'`, así que conéctalo antes de habilitarlo.

La migración no es urgente, ya que las propiedades obsoletas siguen compilando en 3.44. Vale la pena hacerla igual, porque el comportamiento de accesibilidad no es algo que puedas añadir tú después, y porque cada pantalla que dejes en la API antigua es una pantalla que migrarás más tarde bajo presión de tiempo. Hazlo ahora, escribe los argumentos de tipo, y deja que el analizador te diga cuándo terminaste.

## Relacionados

- [Solución: No Material widget found en Flutter](/es/2026/08/fix-no-material-widget-found-in-flutter/)
- [Cómo proteger setState con la comprobación mounted tras un hueco asíncrono en Flutter](/es/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/)
- [Migra de Riverpod 2.x a Riverpod 3.0 en Flutter](/es/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/)
- [Cómo liberar controladores en Flutter para evitar fugas de memoria](/es/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)
- [Cómo crear una lista paginada con scroll infinito en Flutter con ScrollController](/es/2026/08/how-to-build-an-infinite-scrolling-paginated-list-in-flutter-with-scrollcontroller/)

## Fuentes

- [Redesigned the Radio widget, cambios que rompen de Flutter](https://docs.flutter.dev/release/breaking-changes/radio-api-redesign)
- [Clase RadioGroup, documentación de la API de Flutter](https://api.flutter.dev/flutter/widgets/RadioGroup-class.html)
- [Clase Radio, documentación de la API de Flutter](https://api.flutter.dev/flutter/material/Radio-class.html)
- [Clase RadioListTile, documentación de la API de Flutter](https://api.flutter.dev/flutter/material/RadioListTile-class.html)
- [Issue 113562: semántica del grupo de radios](https://github.com/flutter/flutter/issues/113562)
- [PR 168161: introducción de RadioGroup](https://github.com/flutter/flutter/pull/168161)
- [Issue 175705: valor null en RadioGroup](https://github.com/flutter/flutter/issues/175705)
- [WAI-ARIA Authoring Practices: patrón de grupo de radios](https://www.w3.org/WAI/ARIA/apg/patterns/radio)
