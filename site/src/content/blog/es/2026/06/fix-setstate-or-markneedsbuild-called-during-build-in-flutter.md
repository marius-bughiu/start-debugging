---
title: "Solución: setState() or markNeedsBuild() called during build en Flutter"
description: "Este error significa que mutaste el estado mientras Flutter compilaba. Saca el setState de build, o difiérelo con addPostFrameCallback. Aquí está por qué ocurre y la solución correcta."
pubDate: 2026-06-02
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
lang: "es"
translationOf: "2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-02
---

Llamaste a `setState()` (o algo que llama a `notifyListeners()`, `markNeedsBuild()` o `Navigator.push`) mientras Flutter estaba en medio de su fase de compilación. La solución es no cambiar el estado durante `build`. Si el disparador es realmente un callback síncrono que se ejecuta a mitad de la compilación, difiere la mutación al siguiente frame con `WidgetsBinding.instance.addPostFrameCallback((_) => setState(...))`. Esta guía usa Flutter 3.44 (estable, mayo de 2026) y Dart 3.x.

El error es una barrera de protección, no un fallo. Flutter compila los padres antes que los hijos en una sola pasada síncrona. Marcar un widget como sucio a mitad de la pasada le pediría al framework que programe una recompilación para algo que quizá ya visitó, lo cual no puede cumplir en el frame actual. Así que lanza una excepción en lugar de descartar tu actualización en silencio.

## El error en contexto

El mensaje completo que Flutter imprime en la consola se ve así:

```
======== Exception caught by widgets library =======================
The following assertion was thrown while dispatching notifications for ProductModel:
setState() or markNeedsBuild() called during build.

This _MyHomePageState widget cannot be marked as needing to build because the
framework is already in the process of building widgets. A widget can be marked
as needing to be built during the build phase only if one of its ancestors is
currently building. This exception is allowed because the framework builds parent
widgets before children, which means a dirty descendant will always be built.
Otherwise, the framework might not visit this widget during this build phase.

The widget on which setState() or markNeedsBuild() was called was: _MyHomePageState
The widget which was currently being built when the offending call was made was: Consumer<ProductModel>
====================================================================
```

Las dos líneas que importan están al final. "The widget on which setState() ... was called" es lo que intentas recompilar. "The widget which was currently being built" es de donde se originó la llamada problemática. La brecha entre esos dos widgets es el bug.

## Por qué ocurre esto

Hay cuatro disparadores comunes, aproximadamente en orden de frecuencia con que muerden:

Un listener notifica durante la compilación. Un `ChangeNotifier`, `ValueNotifier` o provider llama a `notifyListeners()` desde dentro de un método que invocaste mientras lo leías en `build`. La notificación pide de forma síncrona a cada widget que escucha que se recompile, pero tú ya estás compilando uno de ellos.

Llamaste a `setState` directamente en `build`. Normalmente por accidente: un método que calcula un valor también cambia una bandera y llama a `setState`, y tú llamas a ese método desde `build`.

Leíste un provider con `listen: true` durante una compilación que también lo muta. `Provider.of<T>(context)` (escuchando) registra una dependencia. Si el mismo frame escribe en ese provider, la escritura intenta recompilar el dependiente que todavía está compilando.

Navegaste o mostraste un diálogo desde `build`. `Navigator.push`, `showDialog` y `Scaffold.of(context).showSnackBar` marcan a los ancestros como sucios. Llamarlos desde `build` (en lugar de desde un manejador de eventos) dispara la misma aserción.

La regla unificadora del equipo de Flutter es simple: `build` debe ser una función pura de la configuración del widget y del estado. Devuelve un árbol de widgets y no hace nada más. Los efectos secundarios que cambian el estado pertenecen a los métodos de ciclo de vida (`initState`, `didChangeDependencies`) o a los manejadores de eventos (`onPressed`, `onTap`), nunca a `build`.

## Cómo encontrar la llamada problemática

El mensaje de la consola nombra dos widgets, pero la línea que necesitas cambiar normalmente no está en ninguno de ellos. Está en lo que se ejecutó de forma síncrona entre ambos. Lee el mensaje de abajo hacia arriba:

1. "The widget which was currently being built" te dice la compilación en curso. Busca en tu código el método `build` de ese widget, o el callback `builder` si es un `Consumer`, `Builder`, `LayoutBuilder` o `ValueListenableBuilder`.
2. Dentro de esa compilación, encuentra cada llamada a un método que no sea una lectura pura. Un getter que incrementa un contador, un método llamado `load`, `refresh`, `fetch` o `update`, cualquier cosa que toque un `ChangeNotifier`. Esa llamada es tu sospechoso.
3. Si nada en la compilación parece impuro, el disparador es un listener. Mira la línea "dispatching notifications for X" al principio: `X` es el notificador que se disparó. Encuentra dónde se llama a `X.notifyListeners()` y rastrea hacia atrás qué lo invocó durante este frame.

En compilaciones de depuración, la traza de pila bajo el mensaje apunta directamente al sitio de la llamada `notifyListeners` o `setState`. En compilaciones de producción la aserción se elimina al compilar, por lo que el bug se manifiesta como una actualización descartada o un frame obsoleto en lugar de un fallo. Por eso precisamente quieres arreglar la causa, no silenciar el síntoma: el síntoma solo existe en depuración.

## Una reproducción mínima

Este widget lanza la excepción en su primer frame. El modelo notifica a sus listeners desde un método que se ejecuta mientras un `Consumer` está compilando.

```dart
// Flutter 3.44, Dart 3.x -- throws "setState() or markNeedsBuild() called during build".
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

class ProductModel extends ChangeNotifier {
  int _count = 0;
  int get count => _count;

  // Looks like a harmless getter-with-side-effect. It is not.
  int countAndTrack() {
    _count++;
    notifyListeners(); // fires synchronously, during build
    return _count;
  }
}

class CounterText extends StatelessWidget {
  const CounterText({super.key});

  @override
  Widget build(BuildContext context) {
    return Consumer<ProductModel>(
      builder: (context, model, _) {
        // Calling a method that notifies, from inside build:
        return Text('Seen ${model.countAndTrack()} times');
      },
    );
  }
}
```

El `Consumer` está compilando. Su `builder` llama a `countAndTrack()`, que llama a `notifyListeners()`, que pide al `Consumer` que se recompile mientras todavía está compilando. Flutter lanza la excepción.

La misma forma aparece sin Provider. Cualquier callback de `addListener` que termine llamando a `setState` de forma síncrona durante la compilación de un padre lo provocará.

## Solución, en detalle

Las soluciones están ordenadas según cuánto las recomiendo. La primera es casi siempre la respuesta real.

### 1. Saca el cambio de estado fuera de build (recomendado)

No mutes durante la compilación. Calcula valores derivados en `build`, pero realiza el cambio de estado real en un método de ciclo de vida o en un manejador de eventos. En la reproducción, la mutación pertenece a `initState`, no al `builder`:

```dart
// Flutter 3.44, Dart 3.x -- correct: mutate once, off the build path.
class CounterText extends StatefulWidget {
  const CounterText({super.key});

  @override
  State<CounterText> createState() => _CounterTextState();
}

class _CounterTextState extends State<CounterText> {
  @override
  void initState() {
    super.initState();
    // Mutate here, before the first build, not during it.
    context.read<ProductModel>().countAndTrack();
  }

  @override
  Widget build(BuildContext context) {
    // build only reads; it does not write.
    final count = context.watch<ProductModel>().count;
    return Text('Seen $count times');
  }
}
```

`context.read<T>()` obtiene el modelo sin suscribirse, así que es seguro en `initState`. `context.watch<T>()` se suscribe y es seguro en `build` porque solo lee. La escritura ocurre una vez, antes del frame, y la lectura impulsa las recompilaciones después.

### 2. Difiere la mutación con addPostFrameCallback

Usa esto cuando el disparador esté realmente fuera de tu control: un callback de terceros, un evento de stream que aterriza a mitad de la compilación, o un `LayoutBuilder` que necesita reaccionar a un tamaño medido en el mismo frame. `WidgetsBinding.instance.addPostFrameCallback` ejecuta tu closure después de que el frame actual esté completamente compilado y pintado, así que `setState` vuelve a ser legal.

```dart
// Flutter 3.44, Dart 3.x -- defer the rebuild to after this frame.
@override
Widget build(BuildContext context) {
  if (_needsRefresh) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return; // the widget may have been disposed
      setState(() => _needsRefresh = false);
    });
  }
  return Text(_label);
}
```

Dos protecciones hacen esto seguro. La comprobación `mounted` evita un fallo `setState after dispose` si el widget abandonó el árbol antes de que se ejecutara el callback. Y el callback debe ser condicional (aquí controlado por `_needsRefresh`), o programas una recompilación nueva en cada frame y quemas la CPU en un bucle infinito. `addPostFrameCallback` es un aplazamiento, no una licencia para recompilar en cada pintado.

### 3. Divide un notify síncrono en una microtarea

Si eres dueño del notificador y un método legítimamente necesita notificar, pero no puedes garantizar que nunca se llame durante la compilación, empuja la notificación fuera de la ruta síncrona:

```dart
// Flutter 3.44, Dart 3.x -- notify after the current synchronous work unwinds.
int countAndTrack() {
  _count++;
  // scheduleMicrotask runs after the current build call stack returns,
  // but before the next frame -- so the UI updates without a frame of lag.
  scheduleMicrotask(notifyListeners);
  return _count;
}
```

Esto es un último recurso. Oculta el olor de diseño (un getter con un efecto secundario) en lugar de eliminarlo, y las microtareas todavía pueden competir con la liberación. Prefiere la solución 1.

## Trucos y variantes

`setState() called after dispose()`. Aserción distinta, causa relacionada. Llamaste a `setState` desde un callback asíncrono (un `Future.then`, un `Timer`, un listener de stream) que se completó después de que el widget fuera removido del árbol. Protege cada `setState` asíncrono con `if (!mounted) return;`. Consulta los patrones de liberación en [la guía de liberación de controladores](/es/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).

`setState` en `initState`. Llamar a `setState` de forma síncrona en `initState` no es un error, pero es inútil: la primera compilación aún no ha ocurrido, así que el estado de todos modos se va a leer. Simplemente asigna el campo directamente. Flutter no lanza la excepción aquí, a diferencia del caso de la fase de compilación.

`Navigator.push` desde `build`. Una variante frecuente de este error. Si quieres navegar como efecto secundario del estado (digamos, redirigir cuando un usuario cierra sesión), hazlo en `addPostFrameCallback` o, mejor, con un paquete de enrutamiento que modele las redirecciones de forma declarativa en lugar de imperativa desde `build`.

`FutureBuilder` / `StreamBuilder` que se recompila eternamente. Si el `future` o el `stream` se crea dentro de `build`, cada recompilación crea uno nuevo, que se completa, que llama a `setState` internamente, que recompila. Crea el future o el stream una sola vez en `initState` y guárdalo en un campo. Esto no es estrictamente la misma excepción, pero te lleva al mismo territorio de "estoy recompilando durante una recompilación" y es una causa común de [jank en Flutter que puedes detectar en DevTools](/es/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/).

Usuarios de Riverpod. Leer un provider con `ref.watch` dentro de un callback que se ejecuta durante la compilación, y luego escribir en él en la misma pasada síncrona, choca contra el mismo muro. El `AsyncValue` de Riverpod más un `Notifier` mantienen la lectura y la escritura en rutas separadas; consulta [estados de carga y error con AsyncValue](/es/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) para el patrón.

El punto más profundo: `build` se llama a menudo, de forma impredecible y posiblemente muchas veces por frame. Cualquier cosa que pongas ahí se ejecuta según el calendario de Flutter, no el tuyo. Las lecturas están bien porque son idempotentes. Las escrituras no, porque cambian lo que devuelve la siguiente lectura, y Flutter no tiene un lugar seguro para absorber ese cambio a mitad de la compilación. Mantén `build` puro y el error desaparece para siempre. La misma disciplina hace que bugs no relacionados como [el desbordamiento de RenderFlex](/es/2026/05/fix-renderflex-overflowed-in-flutter/) sean más fáciles de razonar, porque tu layout es una función limpia del estado en lugar de un objetivo móvil. Si tu widget realmente necesita reaccionar a datos asíncronos, modela esos datos como estado y deja que [el manejo elegante de errores y carga](/es/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) impulse las recompilaciones por ti.

## Fuentes

- [State.setState API docs](https://api.flutter.dev/flutter/widgets/State/setState.html) -- el contrato de cuándo setState es legal.
- [State.build API docs](https://api.flutter.dev/flutter/widgets/State/build.html) -- "build should be a pure function of the widget's configuration and the State."
- [WidgetsBinding.addPostFrameCallback API docs](https://api.flutter.dev/flutter/scheduler/SchedulerBinding/addPostFrameCallback.html) -- programar trabajo después del frame actual.
- [ChangeNotifier.notifyListeners API docs](https://api.flutter.dev/flutter/foundation/ChangeNotifier/notifyListeners.html) -- cuándo se llama a los listeners de forma síncrona.
