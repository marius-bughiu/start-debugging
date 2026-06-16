---
title: "Migra una app Flutter 2 a Flutter 3.x: la lista de null safety"
description: "Una guía con versiones fijadas para mover una app Flutter 2.x heredada a una versión actual de Flutter 3.x, con la migración a sound null safety como la barrera dura: por qué necesitas una ruta de dos saltos a través de Dart 2.19, qué hace dart migrate y qué se rompe en el camino."
pubDate: 2026-06-16
updatedDate: 2026-06-16
template: migration
tags:
  - "migration"
  - "flutter"
  - "flutter-2"
  - "flutter-3"
  - "dart"
  - "null-safety"
lang: "es"
translationOf: "2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist"
translatedBy: "claude"
translationDate: 2026-06-16
---

Si todavía tienes una app Flutter 2.x que optó por quedarse fuera de sound null safety, no puedes saltar directamente a una versión actual de Flutter 3.x. Dart 3, que llegó en Flutter 3.10 (mayo de 2023), eliminó por completo el null safety no seguro (unsound) y borró la herramienta `dart migrate`, así que la actualización es una migración de dos saltos: primero deja la base de código null-safe en Dart 2.19 (Flutter 3.7.x), luego sube a la última versión de Flutter 3.x. Calcula un día para una app pequeña y de tres a cinco días para una grande con muchas dependencias transitivas. La fase de null safety es la barrera; todo lo demás (Gradle, mínimos de iOS, widgets eliminados) es mecánico una vez que el analizador está en verde. Esta guía fija Flutter 2.10 / Dart 2.16 como punto de partida y una línea actual de Flutter 3.x ejecutando Dart 3 como objetivo.

## Por qué este es un viaje de dos pasos, no de uno

El instinto es descargar el Flutter más nuevo, ejecutar `flutter pub get` y arreglar lo que se rompa. Con una app Flutter 2 unsound eso falla de inmediato, porque la herramienta que necesitas ya no existe en el SDK al que estás actualizando.

Sound null safety llegó como opcional en Dart 2.12 (Flutter 2.0, marzo de 2021). Durante dos años un modo mixto permitió que las bibliotecas null-safe y las heredadas coexistieran. Dart 3 puso fin a eso. De la guía oficial: "In Dart 3, null safety is built in; you cannot turn it off." Una biblioteca que nunca migró produce, en el momento de la resolución:

```
Because pkg1 doesn't support null safety, version solving failed.
The lower bound of "sdk: '>=2.9.0 <3.0.0'" must be 2.12.0 or higher to enable null safety.
```

y en tiempo de ejecución, sobre el motor antiguo, `Library doesn't support null safety`. La herramienta interactiva `dart migrate` que arregla esto fue eliminada en Dart 3. Dart 2.19.6 es el último SDK que la incluye. Así que la única ruta admitida es: migrar a null safety mientras todavía estás en un SDK Dart 2.x, y luego actualizar el SDK.

## Por qué migrar en 2026

- Todo paquete actual en pub.dev requiere una restricción de SDK Dart 3 (`sdk: '>=3.0.0 <4.0.0'`). Quedarte en Flutter 2 te deja fuera de las nuevas versiones de `http`, `provider`, `go_router` y todos los plugins de Firebase, incluidos sus parches de seguridad.
- Dart 3 desbloqueó records, patrones, clases selladas y modificadores de clase. Ninguno de estos compila en una cadena de herramientas de Flutter 2.
- Sound null safety es una victoria real de correctitud: el compilador prueba que un `String` nunca es `null`, así que toda una clase de fallos `NoSuchMethodError: The method '...' was called on null` se vuelve imposible de publicar. Si alguna vez perseguiste ese fallo en producción, esta es la solución a nivel del sistema de tipos.
- Los requisitos de las tiendas de Apple y Google (niveles mínimos de SDK, 64 bits, herramientas de compilación actuales) han avanzado mucho más allá de lo que una compilación de Flutter 2 puede satisfacer.

## Qué se rompe

La severidad indica qué tan probable es que el cambio rompa una app típica, no qué tan difícil es la solución.

| Área | Cambio | Severidad |
| ---- | ------ | -------- |
| Null safety | El modo unsound se eliminó en Dart 3; cada línea de tu código y cada dependencia deben ser null-safe | alta |
| Herramienta `dart migrate` | Eliminada en Dart 3; solo existe hasta Dart 2.19.6 | alta |
| Restricción de SDK | El límite inferior en `pubspec.yaml` debe ser `2.12.0`, luego `3.0.0` | alta |
| Dependencias | Cualquier paquete sin una versión null-safe bloquea toda la resolución | alta |
| Widgets obsoletos eliminados | `ThemeData.accentColor`, `textSelectionColor`, `toggleableActiveColor` eliminados en la limpieza de obsoletos de 3.0 | alta |
| Cadena de herramientas de Android | Los mínimos de Gradle, Android Gradle Plugin y Kotlin subieron; los `build.gradle` antiguos fallan | alta |
| Mínimo de iOS | El objetivo de despliegue mínimo subió a iOS 12; se descartó armv7 de 32 bits | media |
| Embedding de plugins | Las apps todavía en el embedding v1 de Android deben pasar a v2 | media |

## Lista de comprobación previa

Haz todo esto antes de tocar el código:

- Confirma una base limpia y etiquétala: `git tag pre-flutter3-migration`. Volverás a ella más de una vez.
- Registra tus versiones exactas actuales: `flutter --version` y `dart --version`. Fíjalas en algún lugar para que la migración sea reproducible.
- Asegúrate de que CI compile la app en verde con el SDK antiguo primero. Migrar sobre una compilación ya rota desperdicia horas.
- Instala una cadena de herramientas Dart 2.19 / Flutter 3.7.12 junto a la actual. Usa `fvm` (Flutter Version Management) para poder cambiar por proyecto: `fvm install 3.7.12`.
- Inventaría las dependencias: `flutter pub deps --no-dev` y anota lo que esté sin mantenimiento. Un solo paquete abandonado sin versión null-safe puede detener toda la migración.

## Pasos de migración

1. **Fija Flutter 3.7.12 (Dart 2.19) para la migración.** Esta es la última cadena de herramientas que tiene `dart migrate`. Con `fvm`, ejecuta `fvm use 3.7.12` en el proyecto, luego `fvm flutter --version` para confirmar `Dart 2.19.x`. Verifica: `fvm flutter pub get` resuelve sin un error de SDK.

2. **Comprueba la preparación de las dependencias antes de migrar tu propio código.** Ejecuta `dart pub outdated --mode=null-safety`. Imprime una tabla que muestra qué paquetes ya tienen versiones null-safe y cuáles no. Verifica: cada dependencia directa muestra una versión null-safe resoluble en la columna "Upgradable" o "Resolvable". Si una no lo hace, busca un reemplazo o haz un fork ahora, antes de continuar.

3. **Actualiza las dependencias a sus versiones null-safe, de abajo hacia arriba.** Las dependencias migran en orden: si C depende de B que depende de A, entonces A debe ser null-safe primero. Las herramientas gestionan el orden cuando ejecutas `dart pub upgrade --null-safety` seguido de `dart pub get`. Verifica: `pubspec.lock` ahora lista versiones null-safe y `dart pub get` sale con 0.

4. **Ejecuta la herramienta de migración interactiva sobre tu código.** Desde la raíz del proyecto, ejecuta `dart migrate`. Analiza todo el paquete, propone nulabilidad para cada tipo y sirve una interfaz web local donde revisas cada `?`, `late` y `required` inferido. Donde se equivoque, guíala con marcadores de pista en tu fuente: `/*?*/` fuerza nullable, `/*!*/` fuerza non-nullable, `/*late*/` marca inicialización tardía, `/*required*/` marca un parámetro requerido. Verifica: la herramienta informa cero errores de análisis restantes en su resumen antes de aplicar.

5. **Aplica la migración y sube la restricción de SDK.** Haz clic en "Apply migration". La herramienta reescribe tus archivos `.dart`, elimina los comentarios de pista y establece el límite inferior en `pubspec.yaml`:

   ```yaml
   # pubspec.yaml -- after the null safety migration, still on Dart 2.19
   environment:
     sdk: '>=2.12.0 <3.0.0'
   ```

   Verifica: `dart analyze` no informa errores y `flutter test` pasa en Flutter 3.7.12. Confirma esto como un punto de control independiente: ahora tienes una app sound, null-safe, que todavía corre en la cadena de herramientas antigua.

6. **Cambia a la cadena de herramientas actual de Flutter 3.x.** Ahora haz el segundo salto. Ejecuta `fvm install stable` y `fvm use stable` (o tu objetivo fijado como `3.35.x`). Sube la restricción de SDK a Dart 3:

   ```yaml
   # pubspec.yaml -- targeting the current Flutter 3.x / Dart 3 line
   environment:
     sdk: '>=3.0.0 <4.0.0'
     flutter: '>=3.10.0'
   ```

   Ejecuta `flutter pub get`. Verifica: la resolución tiene éxito. Si falla con "version solving failed", una dependencia todavía carece de una restricción Dart 3; ejecuta `dart pub outdated` para encontrarla. Este mismo error aparece también por errores simples en pubspec; consulta la [solución de version solving failed](/es/2026/05/fix-version-solving-failed-in-pubspec-yaml/) para el árbol de decisiones completo.

7. **Limpia los errores de APIs eliminadas y obsoletas con `dart fix`.** Flutter 3.0 borró APIs que estaban obsoletas en la línea 2.x. Ejecuta `dart fix --dry-run` para previsualizar, luego `dart fix --apply` para reescribir automáticamente las mecánicas. Las víctimas comunes son propiedades de tema: `ThemeData.accentColor` desapareció, que es exactamente el [error de compilación de accentColor](/es/2023/08/flutter-fix-the-getter-accentcolor-isnt-defined-for-the-class-themedata/) que hace tropezar a casi toda actualización de 2 a 3. Verifica: `flutter analyze` está limpio.

8. **Arregla las herramientas de compilación de Android.** Una carpeta `android/` de Flutter 2 casi siempre tiene versiones de Gradle, AGP y Kotlin demasiado viejas para el nuevo embedding. Actualiza `android/gradle/wrapper/gradle-wrapper.properties`, `android/build.gradle` y `android/app/build.gradle` a las versiones que el Flutter actual espera (la plantilla de `flutter create` para una app desechable es la referencia). Verifica: `flutter build apk --debug` tiene éxito. Si te topas con un `AndroidX conflict`, la [solución del conflicto de AndroidX](/es/2026/05/fix-androidx-conflict-during-flutter-android-build/) recorre la resolución.

## Verificación

Ejecuta esta prueba de humo después del paso 8, en ambas plataformas:

- `flutter analyze` informa cero problemas.
- `flutter test` pasa con el mismo conteo que tu base previa a la migración. Una caída significa que un archivo de pruebas falló silenciosamente al compilar.
- `flutter build apk --release` y `flutter build ios --release --no-codesign` tienen éxito ambos.
- Lanza en un dispositivo real, no solo en el simulador, y ejercita las pantallas que antes fallaban con errores de null. Sound null safety debería haber eliminado por completo esos modos de fallo.
- Compara el tiempo de arranque de la app y los tiempos de fotograma contra la base etiquetada. El compilador AOT de Dart 3 suele ser más rápido, pero verifícalo en lugar de asumirlo.

## Plan de reversión

La migración a null safety es, en la práctica, de una sola dirección a nivel de código: una vez que los tipos llevan `?` y `late`, revertir a mano es impracticable. Por eso el paso 5 es un commit independiente. Si el salto a Dart 3 (pasos 6 a 8) sale mal, no deshaces el trabajo de null safety: haces `git reset --hard` de vuelta al punto de control del paso 5, que es una app null-safe totalmente funcional en Flutter 3.7.12, y reintentas la subida de la cadena de herramientas. Mantén la etiqueta `pre-flutter3-migration` hasta que la nueva compilación lleve un ciclo de lanzamiento en producción.

## Problemas que encontramos

**Una dependencia abandonada sin versión null-safe.** Este es el bloqueo más común con diferencia. `dart pub outdated --mode=null-safety` lo señala, pero la solución es humana: reemplaza el paquete, haz un fork y migra tú mismo, o inclúyelo en tu propio repositorio. Decide esto en la comprobación previa, porque descubrirlo a mitad de la migración significa retroceder.

**`late` usado como muleta.** La herramienta de migración con gusto marcará un campo como `late` para evitar forzarte a proporcionar un inicializador. Cada `late` es un `LateInitializationError` diferido esperando una ruta de código que lea antes de escribir. Audita cada uno que la herramienta inserte y prefiere un tipo nullable real o la inicialización en el constructor donde el ciclo de vida no sea hermético.

**`dynamic` oculta los null al analizador.** Null safety solo protege el código tipado estáticamente. Los campos y mapas JSON tipados como `dynamic` todavía dejan que `null` fluya y falle en el punto de uso. Migrar es el momento adecuado para dar a tus factorías `fromJson` tipos reales; un campo mal tipado ahí lanza `FormatException` o un fallo por null que el sistema de tipos no puede atrapar. Si analizas mucho JSON, aprieta esos modelos mientras estás aquí.

**Embedding v1 de plugins.** Las apps anteriores al embedding v2 de Android fallan al compilar en el Flutter actual con un error de `MainActivity` o `FlutterApplication`. Regenera `android/app/src/main/.../MainActivity.kt` desde la plantilla actual y elimina las referencias antiguas a `GeneratedPluginRegistrant`.

**Saltarte la cadena de herramientas intermedia.** Es tentador instalar el Flutter actual e intentar abrirte paso a la fuerza. Sin `dart migrate`, estás anotando a mano miles de tipos a partir de errores del analizador, que es exactamente el trabajo que la herramienta automatiza. Da los dos saltos.

## Relacionado

- [Fix: version solving failed en pubspec.yaml](/es/2026/05/fix-version-solving-failed-in-pubspec-yaml/)
- [Flutter: the getter accentColor isn't defined for the class ThemeData](/es/2023/08/flutter-fix-the-getter-accentcolor-isnt-defined-for-the-class-themedata/)
- [Fix: conflicto de AndroidX durante una compilación de Flutter en Android](/es/2026/05/fix-androidx-conflict-during-flutter-android-build/)
- [Cómo migrar una app Flutter de GetX a Riverpod](/es/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/)
- [Provider vs Riverpod vs Bloc para gestión de estado en Flutter en 2026](/es/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/)

## Fuentes

- [Dart 3 migration guide](https://dart.dev/resources/dart-3-migration) -- null safety obligatorio en Dart 3, `dart migrate` eliminado, usa Dart 2.19 para migrar primero.
- [Migrating to null safety](https://github.com/dart-community/migrate-to-null-safety/blob/main/docs/migrate.md) -- `dart pub outdated --mode=null-safety`, `dart migrate`, marcadores de pista, orden de dependencias de abajo hacia arriba, Dart 2.19.6 como el último SDK que incluye la herramienta.
- [Flutter breaking changes and migration guides](https://docs.flutter.dev/release/breaking-changes) -- la lista por versión de APIs eliminadas y cambiadas.
</content>
