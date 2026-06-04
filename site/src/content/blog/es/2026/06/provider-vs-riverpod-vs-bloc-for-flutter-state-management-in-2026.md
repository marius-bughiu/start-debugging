---
title: "Provider vs Riverpod vs Bloc para gestión de estado en Flutter en 2026"
description: "Elige Riverpod para la mayoría de apps nuevas de Flutter en 2026. Opta por Bloc si tu equipo grande quiere una estructura basada en eventos, y conserva Provider solo para código heredado."
pubDate: 2026-06-04
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "riverpod"
  - "bloc"
lang: "es"
translationOf: "2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026"
translatedBy: "claude"
translationDate: 2026-06-04
---

Si vas a empezar una app nueva de Flutter en 2026 y no te decides entre Provider, Riverpod y Bloc, la respuesta corta es Riverpod. Con Riverpod 3.3.1 (la línea 3.0 salió el 2025-09-10) es seguro en tiempo de compilación, se puede probar sin un `BuildContext`, y la ruta de generación de código elimina casi todo el boilerplate que solía ser el principal argumento en su contra. Recurre a Bloc (`flutter_bloc` 9.1.1) cuando tengas un equipo grande que se beneficie de un contrato estricto basado en eventos y de un historial de estado rastreable. Conserva Provider (6.1.5) solo si ya lo tienes en una base de código o si le estás enseñando a alguien el modelo subyacente de `InheritedWidget`. Todos los ejemplos aquí usan Flutter 3.44 y Dart 3.12.

## Los tres paquetes no son el mismo tipo de herramienta

Antes de compararlos, ayuda ver que estas bibliotecas resuelven problemas que se solapan pero son distintos.

Provider es un envoltorio fino y bien hecho sobre el propio `InheritedWidget` de Flutter. Hace inyección de dependencias y propagación de reconstrucciones, y poco más. La clase de estado suele ser un `ChangeNotifier` que escribes a mano. Es el paquete al que recurrió la documentación oficial de Flutter cuando necesitó un ejemplo didáctico, razón por la que tantos tutoriales lo usan.

Riverpod es lo que el autor de Provider construyó después, específicamente para arreglar los problemas estructurales de Provider: la `ProviderNotFoundException` en tiempo de ejecución, la dependencia de la posición del widget en el árbol y la imposibilidad de leer el estado desde Dart puro. Los providers de Riverpod viven fuera del árbol de widgets, así que son accesibles desde cualquier parte y se resuelven en tiempo de compilación.

Bloc es primero un patrón y luego un paquete. Te empuja a modelar cada cambio como un evento explícito que fluye hacia un componente y produce un nuevo estado inmutable. Esa ceremonia es justamente el punto: en un equipo grande, una tubería forzada `Event -> Bloc -> State` hace que el comportamiento sea predecible y revisable.

## Matriz de características

| Característica | Provider 6.1.5 | Riverpod 3.3.1 | Bloc 9.1.1 |
| --- | --- | --- | --- |
| Modelo mental | `InheritedWidget` + `ChangeNotifier` | Providers fuera del árbol | Basado en eventos, estados inmutables |
| Seguridad en tiempo de compilación | No (búsqueda en tiempo de ejecución) | Sí | Sí |
| Necesita `BuildContext` para leer | Sí | No | No (vía `context.read` o directo) |
| Boilerplate | Bajo | Bajo con codegen | Alto |
| Testabilidad | Requiere montar el widget | Dart puro, sin árbol de widgets | Dart puro, ayudantes `bloc_test` |
| Estado async / de carga | Manual | `AsyncValue`, integrado | Estados manuales o `emit` |
| Reintento automático ante fallos | No | Sí (desde 3.0) | No |
| Trazabilidad del estado | Débil | Media | Fuerte (cada transición observable) |
| Curva de aprendizaje | Suave | Moderada | Pronunciada |
| Mejor encaje | Heredado, tutoriales | La mayoría de apps nuevas | Equipos grandes, flujos complejos |

La fila más importante es "seguridad en tiempo de compilación". Un Provider mal configurado lanza `ProviderNotFoundException` en tiempo de ejecución, a menudo solo en la pantalla donde falta. Riverpod y Bloc sacan a la luz esa clase de error antes de que la app se ejecute.

## El mismo contador en los tres

Un contador es lo bastante pequeño para comparar la ergonomía directamente. Observa cuánto código necesita cada uno y dónde vive el estado.

### Provider

```dart
// Flutter 3.44, provider 6.1.5
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

class CounterModel extends ChangeNotifier {
  int _count = 0;
  int get count => _count;

  void increment() {
    _count++;
    notifyListeners();
  }
}

// Register it above the widgets that need it.
ChangeNotifierProvider(
  create: (_) => CounterModel(),
  child: const CounterPage(),
);

class CounterPage extends StatelessWidget {
  const CounterPage({super.key});

  @override
  Widget build(BuildContext context) {
    final count = context.watch<CounterModel>().count;
    return Scaffold(
      body: Center(child: Text('$count')),
      floatingActionButton: FloatingActionButton(
        onPressed: () => context.read<CounterModel>().increment(),
        child: const Icon(Icons.add),
      ),
    );
  }
}
```

Fíjate en la dependencia de `context`. Si `CounterPage` se renderiza sin un `ChangeNotifierProvider` por encima, `context.watch<CounterModel>()` lanza en tiempo de ejecución.

### Riverpod

```dart
// Flutter 3.44, flutter_riverpod 3.3.1, riverpod_annotation
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

part 'counter.g.dart';

@riverpod
class Counter extends _$Counter {
  @override
  int build() => 0;

  void increment() => state++;
}

class CounterPage extends ConsumerWidget {
  const CounterPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final count = ref.watch(counterProvider);
    return Scaffold(
      body: Center(child: Text('$count')),
      floatingActionButton: FloatingActionButton(
        onPressed: () => ref.read(counterProvider.notifier).increment(),
        child: const Icon(Icons.add),
      ),
    );
  }
}
```

El `counterProvider` se genera y es accesible globalmente. No hay una posición en el árbol que equivocar, y `ref` se resuelve en tiempo de compilación. Envuelve la app una vez en `ProviderScope` y listo.

### Bloc

```dart
// Flutter 3.44, flutter_bloc 9.1.1, equatable
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

// Events
sealed class CounterEvent {}
class Increment extends CounterEvent {}

// Bloc: Event in, int state out.
class CounterBloc extends Bloc<CounterEvent, int> {
  CounterBloc() : super(0) {
    on<Increment>((event, emit) => emit(state + 1));
  }
}

class CounterPage extends StatelessWidget {
  const CounterPage({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider(
      create: (_) => CounterBloc(),
      child: Builder(
        builder: (context) => Scaffold(
          body: Center(
            child: BlocBuilder<CounterBloc, int>(
              builder: (context, count) => Text('$count'),
            ),
          ),
          floatingActionButton: FloatingActionButton(
            onPressed: () => context.read<CounterBloc>().add(Increment()),
            child: const Icon(Icons.add),
          ),
        ),
      ),
    );
  }
}
```

Bloc es el más verboso para un contador, y esa comparación es injusta con él: el valor de Bloc aparece cuando hay veinte eventos y diez estados, no uno. El evento `Increment` es un registro en el historial de tu app. Con un `BlocObserver` adjunto puedes registrar cada transición, que es exactamente lo que quieres al depurar una pantalla compleja.

## Cuándo elegir Riverpod

- **Una app nueva en 2026 sin restricciones heredadas.** Esta es la opción por defecto. Riverpod te da seguridad en tiempo de compilación, pruebas sin `pumpWidget` y manejo de async a través de `AsyncValue` de fábrica. Mira nuestro recorrido sobre [estados de carga y error con AsyncValue](/es/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) para ver lo limpio que queda el async.
- **Lees el estado fuera de los widgets.** Una sincronización en segundo plano, una capa de repositorio o un servicio que necesita el token de auth actual pueden llamar a `ref.read` sin un `BuildContext`. Provider no puede hacer esto de forma limpia.
- **Quieres resiliencia para providers de red inestables.** Riverpod 3.0 añadió reintento automático con retroceso exponencial (200ms duplicándose hasta 6.4s) para providers que fallan durante la inicialización, además de la pausa automática de los listeners cuando un widget sale de la pantalla.
- **Estás migrando desde GetX o similar.** Riverpod es el destino habitual. Nuestra [guía de migración de GetX a Riverpod](/es/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) cubre las piezas en movimiento.

Una advertencia: en Riverpod 3.0, `StateProvider`, `StateNotifierProvider` y `ChangeNotifierProvider` se movieron a `package:riverpod/legacy.dart`. El código nuevo debería usar las clases `Notifier` y `AsyncNotifier` mostradas arriba, idealmente con generación de código mediante `@riverpod`.

## Cuándo elegir Bloc

- **Un equipo grande que quiere un contrato forzado.** Cuando cinco personas tocan la misma funcionalidad, el flujo rígido `Event -> Bloc -> State` evita que cada una invente su propio patrón. La estructura es el entregable.
- **Necesitas un historial de estado auditable.** Un `BlocObserver` ve cada transición. Para flujos como el checkout, el onboarding o un formulario de varios pasos, reproducir la secuencia exacta de eventos que produjo un bug vale el boilerplate.
- **Lógica async compleja y ramificada.** Los transformadores de eventos de Bloc (debounce, throttle, `droppable`, `concurrent`) te dan control fino sobre cómo se manejan los eventos solapados. Eso es más difícil de expresar en los otros dos.
- **Quieres `Cubit` para los casos simples.** No toda pantalla necesita eventos completos. Un `Cubit` es un Bloc sin la capa de eventos: llamas a métodos que hacen `emit` de nuevo estado directamente, así que puedes mezclar Cubits ligeros y Blocs completos en la misma app.

## Cuándo elegir Provider

- **Ya lo tienes.** Una app que funciona con Provider no necesita una reescritura. No hay nada malo en `ChangeNotifier` para estado de app que no sea crítico en rendimiento.
- **Estás enseñando los fundamentos.** Provider mapea casi uno a uno sobre `InheritedWidget`, así que es la forma más clara de mostrarle a alguien cómo Flutter propaga el estado sin una abstracción de terceros.
- **Una app genuinamente diminuta.** Una sola pantalla de ajustes con un interruptor no justifica generación de código ni una tubería de eventos.

Lo que Provider no debería ser en 2026 es la opción por defecto para una app nueva y no trivial. El modelo de búsqueda en tiempo de ejecución es justo el problema que Riverpod fue construido para eliminar.

## Las pegas que deciden por ti

Algunas restricciones se imponen a la preferencia personal.

**Leer el estado desde código que no es widget.** Si tu arquitectura tiene una capa de servicio o repositorio que debe leer el estado de la app directamente, Provider queda prácticamente descartado. Necesita un `BuildContext`. Riverpod y Bloc permiten leer el estado desde Dart puro, lo que normalmente zanja la decisión por sí solo.

**Tamaño del equipo y cultura de revisión.** En un proyecto en solitario o un equipo pequeño, la ceremonia de Bloc es fricción con poca recompensa, y Riverpod gana en velocidad. En un equipo de 15 personas donde la consistencia entre funcionalidades importa más que las líneas de código, la rigidez de Bloc es una ventaja, no un costo.

**Disciplina de estado inmutable.** Tanto Bloc como el Riverpod moderno te empujan hacia objetos de estado inmutables. Si tu equipo se siente cómodo con clases selladas e igualdad por valor (mira [Dart records vs clases Freezed](/es/2026/05/dart-records-vs-freezed-classes/) para las opciones de modelado), ambos encajan. Si tienes una base de código grande construida sobre objetos `ChangeNotifier` mutables, la ruta más barata puede ser quedarte en Provider hasta que una funcionalidad realmente necesite más.

**Patrones async existentes.** El `AsyncValue` de Riverpod es la forma de menor esfuerzo para renderizar carga, datos y error desde una única fuente de verdad. Si tus pantallas son en su mayoría obtenciones de datos async, eso solo ya es una razón fuerte para elegirlo.

## La recomendación, repetida

Para la mayoría de apps nuevas de Flutter en 2026, usa Riverpod 3.3.1 con generación de código. Obtienes seguridad en tiempo de compilación, lecturas sin contexto, async de primera clase y las características de resiliencia de 3.0, a un costo de boilerplate que codegen acerca al de Provider.

Elige Bloc 9.1.1 cuando una estructura forzada basada en eventos y un historial de estado totalmente rastreable valgan más para tu equipo que la concisión, lo cual suele ser cierto en equipos grandes y flujos complejos. Usa Cubits dentro de una app Bloc para las pantallas que no necesiten eventos completos.

Conserva Provider 6.1.5 para apps heredadas, enseñanza y pantallas triviales, pero no lo elijas por defecto en un proyecto nuevo y no trivial. La pregunta decisiva rara vez es "cuál tiene el contador más bonito", es "¿leo estado fuera de los widgets, qué tan grande es mi equipo y cuánto async tengo?". Responde esas tres y la elección suele hacerse sola. Si estás sopesando Flutter frente a otros stacks por completo, nuestra [comparación de Flutter vs React Native vs MAUI](/es/2026/05/flutter-vs-react-native-vs-maui-for-a-new-mobile-project-in-2026/) aleja la vista un nivel. Y elijas lo que elijas, recuerda [liberar tus controllers](/es/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/), porque ninguna biblioteca de gestión de estado los limpiará por ti.

## Fuentes

- [Riverpod: novedades de la 3.0](https://riverpod.dev/docs/whats_new) - APIs heredadas, reintento automático, pausa/reanudación, persistencia offline, mutaciones.
- [flutter_riverpod en pub.dev](https://pub.dev/packages/flutter_riverpod) y [changelog](https://pub.dev/packages/flutter_riverpod/changelog) - versión 3.3.1, 3.0.0 lanzada el 2025-09-10.
- [flutter_bloc en pub.dev](https://pub.dev/packages/flutter_bloc) - versión 9.1.1, BlocProvider / BlocBuilder / BlocListener, Cubit vs Bloc.
- [provider en pub.dev](https://pub.dev/packages/provider) - versión 6.1.5, ChangeNotifierProvider, Flutter Favorite.
- [Notas de versión de Flutter](https://docs.flutter.dev/release/release-notes) - Flutter 3.44 estable, Dart 3.12.
