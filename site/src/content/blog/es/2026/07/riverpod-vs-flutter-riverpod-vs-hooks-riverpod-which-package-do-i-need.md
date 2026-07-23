---
title: "riverpod vs flutter_riverpod vs hooks_riverpod: ¿cuál paquete necesito en realidad?"
description: "Instala flutter_riverpod para casi cualquier app de Flutter. Usa riverpod solo para código Dart puro, y hooks_riverpod solo si ya usas flutter_hooks."
pubDate: 2026-07-23
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "riverpod"
lang: "es"
translationOf: "2026/07/riverpod-vs-flutter-riverpod-vs-hooks-riverpod-which-package-do-i-need"
translatedBy: "claude"
translationDate: 2026-07-23
---

Si pub.dev te muestra `riverpod`, `flutter_riverpod` y `hooks_riverpod` y no sabes cuál agregar, la respuesta para casi cualquier app de Flutter es `flutter_riverpod`. Agrega `riverpod` (sin el prefijo `flutter_`) solo cuando escribas Dart puro sin dependencia de Flutter, como una CLI o un servidor. Agrega `hooks_riverpod` solo si ya usas el paquete `flutter_hooks` y quieres `HookConsumerWidget`. Estos tres no son gestores de estado que compiten entre sí: son capas de la misma biblioteca, y elegir el incorrecto solo significa un import un poco equivocado, no una arquitectura distinta. Todas las versiones aquí apuntan a Riverpod 3.3.2 (la línea 3.0 salió el 2025-09-10), Flutter 3.44 y Dart 3.12.

## Son capas, no rivales

La confusión viene de que pub.dev los lista uno al lado del otro como si fueran alternativas como Provider y Bloc. No lo son. `riverpod` es el motor central, escrito en Dart puro y sin ningún import de Flutter. `flutter_riverpod` toma ese motor y agrega el pegamento de Flutter: `ProviderScope`, `ConsumerWidget`, `Consumer` y el `WidgetRef` sobre el que llamas `ref.watch`. `hooks_riverpod` toma `flutter_riverpod` y agrega una cosa más encima: la integración con el paquete independiente `flutter_hooks`, exponiendo `HookConsumerWidget`.

Cada paquete reexporta el que está debajo. Cuando agregas `flutter_riverpod`, también obtienes todo lo de `riverpod` sin listarlo. Cuando agregas `hooks_riverpod`, obtienes también todo lo de `flutter_riverpod`. Por eso nunca instalas más de uno a la vez, y por eso instalar `flutter_riverpod` y luego importar desde `package:riverpod/riverpod.dart` es un error que produce confusos errores de símbolos duplicados.

## Matriz de características

| Característica | `riverpod` 3.3.2 | `flutter_riverpod` 3.3.2 | `hooks_riverpod` 3.3.2 |
| --- | --- | --- | --- |
| Depende de Flutter | No | Sí | Sí |
| Motor de providers (`Provider`, `Notifier`, `ref.watch`) | Sí | Sí | Sí |
| Widget `ProviderScope` | No | Sí | Sí |
| `ConsumerWidget` / `Consumer` | No | Sí | Sí |
| `HookConsumerWidget` / `HookConsumer` | No | No | Sí |
| Requiere `flutter_hooks` al lado | No | No | Sí |
| Reexporta el paquete de abajo | -- | `riverpod` | `flutter_riverpod` |
| Adecuado para | Código Dart puro | La mayoría de apps de Flutter | Apps de Flutter que ya usan hooks |

El tipo `AsyncValue`, `ref.listen`, los modificadores de provider como `.autoDispose` y el comportamiento de reintento automático añadido en 3.0 viven todos en el paquete central `riverpod`, por lo que cada fila que los tiene es idéntica entre los tres. Las únicas diferencias reales son las clases base de widget y la dependencia de Flutter.

## Cuándo instalar flutter_riverpod

Este es el valor por defecto, y cubre la gran mayoría de las apps.

- Estás construyendo una aplicación Flutter normal (móvil, escritorio o web) y quieres `ProviderScope` en la raíz y `ConsumerWidget` en tus pantallas.
- No usas, ni planeas usar, el paquete `flutter_hooks`.
- Quieres la superficie de dependencias más pequeña que aún te dé la integración completa con Flutter.

La instalación es un solo comando:

```bash
# Flutter 3.44, flutter_riverpod 3.3.2
flutter pub add flutter_riverpod
```

Un widget mínimo que funciona se ve así:

```dart
// Flutter 3.44, Dart 3.12, flutter_riverpod 3.3.2
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

final counterProvider = NotifierProvider<Counter, int>(Counter.new);

class Counter extends Notifier<int> {
  @override
  int build() => 0;
  void increment() => state++;
}

void main() {
  // ProviderScope comes from flutter_riverpod
  runApp(const ProviderScope(child: MyApp()));
}

class CounterView extends ConsumerWidget {
  const CounterView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final count = ref.watch(counterProvider);
    return Text('$count');
  }
}
```

`ProviderScope`, `ConsumerWidget` y `WidgetRef` los provee `flutter_riverpod`. El `NotifierProvider`, `Notifier` y `state` vienen del motor central que `flutter_riverpod` reexporta. Nunca importas `package:riverpod/riverpod.dart` directamente en una app de Flutter.

## Cuándo instalar riverpod a secas

Recurre al paquete `riverpod` desnudo solo cuando no haya Flutter en el proyecto en absoluto.

- Una herramienta de línea de comandos en Dart que comparte lógica basada en providers con una app de Flutter.
- Un servidor `dart_frog` o `shelf` que quiere el grafo de dependencias de Riverpod en el backend.
- Un paquete Dart puro del que dependen otras apps, donde arrastrar Flutter sería incorrecto.

```bash
# Dart 3.12, riverpod 3.3.2
dart pub add riverpod
```

En un contexto solo Dart no hay árbol de widgets, así que en lugar de `ProviderScope` construyes tú mismo un `ProviderContainer` y lees de él:

```dart
// Dart 3.12, riverpod 3.3.2 (no Flutter)
import 'package:riverpod/riverpod.dart';

final greetingProvider = Provider<String>((ref) => 'hello from Dart');

void main() {
  final container = ProviderContainer();
  print(container.read(greetingProvider)); // hello from Dart
  container.dispose();
}
```

Si tu proyecto tiene un `pubspec.yaml` con `flutter:` bajo dependencies, casi nunca es el paquete que quieres. Agregar `riverpod` a secas a una app de Flutter y luego preguntarse por qué `ConsumerWidget` y `ProviderScope` no se resuelven es uno de los errores de configuración de Riverpod más comunes.

## Cuándo instalar hooks_riverpod

Instala `hooks_riverpod` solo cuando ya estés comprometido con `flutter_hooks` y quieras usar hooks dentro del mismo widget que lee providers.

El dato clave: `flutter_hooks` y Riverpod son dos paquetes independientes. `flutter_hooks` es un port de los hooks de React que gestiona estado local del widget, cosas como un `TextEditingController` o un `AnimationController` acotados a un solo widget. Riverpod gestiona estado compartido de la aplicación. Resuelven problemas distintos, y puedes usar cualquiera sin el otro. `hooks_riverpod` existe puramente para que un único widget pueda hacer ambas cosas sin un conflicto de herencia de clases.

Ese conflicto es real. `HookWidget` (de `flutter_hooks`) y `ConsumerWidget` (de `flutter_riverpod`) son ambas clases base, y una clase de Dart solo puede extender una superclase. No puedes escribir `class X extends HookWidget, ConsumerWidget`. `hooks_riverpod` resuelve esto entregando `HookConsumerWidget`, una única clase base que es ambas a la vez:

```dart
// Flutter 3.44, hooks_riverpod 3.3.2, flutter_hooks 0.21.2
import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

class SearchField extends HookConsumerWidget {
  const SearchField({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // useTextEditingController is a hook: local widget state
    final controller = useTextEditingController();
    // ref.watch is Riverpod: shared app state
    final results = ref.watch(searchResultsProvider);

    return TextField(controller: controller);
  }
}
```

Dos cosas por notar. Primera, `hooks_riverpod` no empaqueta `flutter_hooks`, así que debes agregar ambos:

```bash
# Flutter 3.44
flutter pub add hooks_riverpod
flutter pub add flutter_hooks
```

Segunda, como `hooks_riverpod` reexporta `flutter_riverpod`, no debes, y no deberías, listar también `flutter_riverpod` en `pubspec.yaml`. El único import de `hooks_riverpod` te da `ProviderScope`, `ConsumerWidget` y `HookConsumerWidget` todos juntos. Un archivo que solo lee providers todavía puede extender el `ConsumerWidget` normal; recurres a `HookConsumerWidget` solo en los archivos específicos que además llaman a hooks.

La documentación oficial es directa sobre esto para principiantes: si eres nuevo en Riverpod, no empieces con hooks. Agregan un segundo modelo mental sobre uno que ya es poco familiar. Aprende `flutter_riverpod` primero, y adopta `hooks_riverpod` después solo si te descubres queriendo hooks para estado local. Si hoy gestionas controllers a mano, la disciplina de liberación en [liberar controllers de Flutter para evitar fugas de memoria](/es/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) es exactamente el boilerplate que los hooks buscan eliminar, que es el caso honesto para adoptarlos.

## ¿El paquete de anotaciones reemplaza al paquete de runtime?

Un seguimiento frecuente: si agrego `riverpod_annotation` para el codegen de `@riverpod`, ¿todavía necesito `flutter_riverpod`? Sí. El paquete de anotaciones solo aporta el marcador `@riverpod` y los tipos contra los que el generador emite. No contiene runtime: ni `ProviderScope`, ni `Notifier`, ni `ref`. Tu app sigue corriendo sobre uno de los tres paquetes de runtime, y el código generado importa de él. Así que una app de Flutter con codegen depende de ambos, `flutter_riverpod` (runtime) y `riverpod_annotation` (anotaciones), no de uno en lugar del otro.

La misma regla de "un solo paquete de runtime" se aplica en las pruebas. Una prueba de widget que monta un `ProviderScope` usa `flutter_riverpod` (vía `flutter_test`), mientras que una prueba unitaria de Dart puro que levanta un `ProviderContainer` usa `riverpod` a secas. No agregas un paquete de pruebas separado para Riverpod; el `ProviderContainer` y los `overrides` que necesitas para las pruebas ya vienen dentro del paquete de runtime que instalaste.

## El detalle que de verdad hace tropezar: los paquetes de codegen versionan distinto

Aquí está la parte que sorprende incluso a usuarios experimentados de Riverpod en la era 3.x. Los paquetes de runtime (`riverpod`, `flutter_riverpod`, `hooks_riverpod`) están en la línea 3.3.x, pero los paquetes de generación de código están en una versión mayor totalmente distinta:

| Paquete | Rol | Versión (2026-07) |
| --- | --- | --- |
| `flutter_riverpod` | runtime | 3.3.2 |
| `hooks_riverpod` | runtime | 3.3.2 |
| `riverpod` | runtime | 3.3.2 |
| `riverpod_annotation` | anotaciones de codegen | 4.0.3 |
| `riverpod_generator` | codegen (dev) | 4.0.4 |
| `riverpod_lint` | reglas de lint (dev) | 3.x |

Si usas la anotación `@riverpod` para generar providers, instalas cuatro paquetes, no uno. `riverpod_annotation` es una dependencia normal; `riverpod_generator` y `build_runner` son dependencias de desarrollo:

```bash
# Flutter 3.44, Riverpod 3.x
flutter pub add flutter_riverpod riverpod_annotation
flutter pub add dev:riverpod_generator dev:build_runner
flutter pub add dev:custom_lint dev:riverpod_lint   # optional, for lint rules
```

Luego genera con:

```bash
# runs the generator once, or use `watch` to keep it running
dart run build_runner watch -d
```

No intentes fijar `riverpod_annotation` a `^3.0.0` para que coincida con el runtime. La línea 4.x de anotaciones es la que coincide con el runtime 3.3.x; los números de versión están deliberadamente desacoplados porque el generador evoluciona a su propio ritmo. Deja que `flutter pub add` resuelva las restricciones y no las edites a mano para "alinearlas", porque no se supone que se alineen. Este es el fallo de `pub get` más común en un proyecto Riverpod 3 recién creado.

La generación de código es opcional. Todo en este artículo funciona sin ella. El enfoque de anotaciones principalmente te ahorra escribir a mano el boilerplate de tipos de provider (`NotifierProvider<Counter, int>`), y es un buen valor por defecto para proyectos nuevos, pero es una decisión separada de cuál paquete de runtime instalas.

## Qué escribir en realidad

Quitando la explicación y la decisión es corta:

- Construyendo una app de Flutter, sin hooks: `flutter pub add flutter_riverpod`. Eres tú, el 90% de las veces.
- Dart puro, sin Flutter: `dart pub add riverpod`.
- App de Flutter que ya usa `flutter_hooks`: `flutter pub add hooks_riverpod flutter_hooks`.
- Usando la anotación `@riverpod` sobre cualquiera de los anteriores: agrega `riverpod_annotation` más las dependencias de desarrollo `riverpod_generator` y `build_runner`, y deja que el resolvedor elija la línea 4.x.

Sea cual sea el paquete de runtime que elijas, los providers, la API de `Notifier` y `AsyncValue` se comportan de forma idéntica, porque todos vienen del mismo motor central. Solo estás eligiendo cuánto pegamento de Flutter y soporte de hooks apilar encima. Una vez resuelto eso, el verdadero aprendizaje está en la API en sí: cómo [AsyncValue de Riverpod se compara con FutureBuilder y StreamBuilder](/es/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/), cómo [comprobar ref.mounted tras una brecha async](/es/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/), y cómo el nuevo [reintento automático de providers en 3.0](/es/2026/07/how-to-disable-riverpod-3-0-automatic-provider-retry/) cambia el manejo de errores. Si todavía estás decidiendo si usar Riverpod en absoluto, la [comparación Provider vs Riverpod vs Bloc](/es/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) toma esa decisión; si te estás moviendo de la línea antigua, la [guía de migración de Riverpod 2.x a 3.0](/es/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/) cubre los cambios que rompen.

## Fuentes

- [Riverpod: Getting started](https://riverpod.dev/docs/introduction/getting_started) -- comandos oficiales de instalación de `riverpod`, `flutter_riverpod`, `hooks_riverpod` y los paquetes de codegen.
- [Riverpod: About hooks](https://riverpod.dev/docs/concepts/about_hooks) -- la relación entre `flutter_hooks`, `flutter_riverpod` y `HookConsumerWidget`, y el consejo para principiantes.
- [riverpod_generator changelog](https://pub.dev/packages/riverpod_generator/changelog) -- confirma la línea 4.x de codegen emparejada con el runtime 3.3.x.
- [flutter_hooks en pub.dev](https://pub.dev/packages/flutter_hooks) -- el paquete independiente de hooks con el que se integra `hooks_riverpod`.
