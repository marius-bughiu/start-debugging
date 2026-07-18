---
title: "Solución: ScaffoldMessenger.of() se llamó con un contexto que no contiene un Scaffold (Flutter)"
description: "Este error significa que el BuildContext que pasaste está por encima del Scaffold o del ScaffoldMessenger, no por debajo. Envuelve la llamada en un Builder, extráela a su propio widget o usa un GlobalKey."
pubDate: 2026-07-18
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "snackbar"
lang: "es"
translationOf: "2026/07/fix-scaffoldmessenger-of-context-does-not-contain-a-scaffold-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-18
---

`ScaffoldMessenger.of() was called with a context that does not contain a Scaffold` (y su gemelo más antiguo, `Scaffold.of() called with a context that does not contain a Scaffold`) significa que el `BuildContext` que le pasaste a `.of()` está *por encima* del `Scaffold` o del `ScaffoldMessenger` que intenta encontrar, no por debajo. Casi siempre ocurre cuando lo llamas desde el mismo método `build` que devuelve el `Scaffold`. Se soluciona envolviendo la llamada en un `Builder`, extrayéndola a su propio widget o alcanzando el messenger mediante un `GlobalKey`. Probado en Flutter 3.x (3.44), Dart 3.x.

## El error en contexto

Hay dos mensajes muy relacionados, y cuál obtienes depende de qué API llamaste. El clásico, de la API `Scaffold.of()` anterior a la 2.0 que todavía usan muchas respuestas antiguas de Stack Overflow:

```
Scaffold.of() called with a context that does not contain a Scaffold.
No Scaffold ancestor could be found starting from the context that was passed
to Scaffold.of(). This usually happens when the context provided is from the
same StatefulWidget as that whose build function actually creates the Scaffold
widget being sought.
```

El moderno, de `ScaffoldMessenger.of()`, que es la API que deberías usar para mostrar un `SnackBar`:

```
No ScaffoldMessenger widget found.
Scaffold widgets require a ScaffoldMessenger widget ancestor.
Typically, the ScaffoldMessenger widget is introduced by the MaterialApp at
the top of your application widget tree.
```

Ambos son el mismo error con distinta ropa: una búsqueda de ancestro que empieza demasiado arriba en el árbol y camina en la dirección equivocada. Entender *por qué* falla la búsqueda es la diferencia entre pegar un `Builder` y cruzar los dedos, y saber exactamente qué solución necesita tu situación.

## Por qué la búsqueda empieza en el lugar equivocado

`ScaffoldMessenger.of(context)` y `Scaffold.of(context)` hacen ambos un recorrido de ancestros. Internamente llaman a `context.dependOnInheritedWidgetOfExactType` (a través de un `_ScaffoldMessengerScope` heredado), que empieza en el elemento de `context` y sube *hacia arriba* hacia la raíz, buscando el ancestro coincidente más cercano. Nunca mira hacia abajo.

Ahora imagina el widget que falla. Escribiste un método `build` que devuelve un `Scaffold`, y en algún punto de ese método llamas a `Scaffold.of(context)` o a `ScaffoldMessenger.of(context)` usando el parámetro `context` de ese mismo `build`. Ese `context` pertenece al elemento de *tu* widget. Tu widget es el **padre** del `Scaffold` que devuelve. Así que cuando la búsqueda sube desde tu elemento, el `Scaffold` que acabas de crear está por debajo del punto de inicio, y el recorrido nunca lo alcanza. Pasa de largo por tu widget y sube hacia lo que sea que esté por encima de ti, no encuentra nada apropiado y lanza la aserción.

Ese es exactamente el escenario que señala el mensaje clásico: "the context provided is from the same StatefulWidget as that whose build function actually creates the Scaffold widget being sought".

Hay un matiz que vale la pena conocer, porque explica por qué puede que veas o no el error. `MaterialApp` inserta un `ScaffoldMessenger` cerca de la parte superior de tu árbol por ti. Eso significa que `ScaffoldMessenger.of(context)` normalmente tiene éxito *incluso desde un contexto que no tiene ningún Scaffold por encima*, porque encuentra el messenger a nivel de la aplicación. Así que la variante "No ScaffoldMessenger widget found" solo se dispara cuando realmente no hay ningún messenger ancestro: estás por encima de `MaterialApp`, construiste la aplicación con un `WidgetsApp` pelado y sin messenger, o creaste un ámbito `ScaffoldMessenger` personalizado y estás llamando desde fuera de él. El fallo mucho más común en código real es el de `Scaffold.of()`, o un `SnackBar` que se muestra en el lugar equivocado porque resolviste el messenger equivocado.

## La reproducción mínima

El disparador más fiable y pequeño es un botón colocado directamente en el método `build` que devuelve el `Scaffold`, llamando a `.of()` con el `context` de ese método:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
class HomePage extends StatelessWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Home')),
      body: Center(
        child: ElevatedButton(
          onPressed: () {
            // context here is HomePage's context, which is ABOVE the Scaffold.
            Scaffold.of(context).showSnackBar(   // throws
              const SnackBar(content: Text('Saved')),
            );
          },
          child: const Text('Save'),
        ),
      ),
    );
  }
}
```

Cambia `Scaffold.of` por `ScaffoldMessenger.of` y, como `MaterialApp` provee un messenger, el fallo desaparece pero el `SnackBar` ahora lo gestiona el messenger raíz en lugar del `Scaffold` de esta pantalla. Eso está bien para la mayoría de las apps, y es exactamente por eso que se hizo la migración a `ScaffoldMessenger`. Pero si tienes ámbitos `ScaffoldMessenger` anidados, todavía puedes resolver el equivocado desde el contexto equivocado.

## Solución 1: usa ScaffoldMessenger.of, no Scaffold.of

Si tu error es la variante de `Scaffold.of()` y solo intentas mostrar, ocultar o quitar un `SnackBar`, la primera y mejor solución es simplemente dejar de usar `Scaffold.of()`. `Scaffold.of().showSnackBar()` quedó obsoleto en Flutter 2.0 y se eliminó; la API actual está en `ScaffoldMessenger`:

```dart
// Flutter 3.x (tested 3.44)
// Before (deprecated, throws from the same build context):
Scaffold.of(context).showSnackBar(mySnackBar);
Scaffold.of(context).hideCurrentSnackBar();
Scaffold.of(context).removeCurrentSnackBar();

// After (current API):
ScaffoldMessenger.of(context).showSnackBar(mySnackBar);
ScaffoldMessenger.of(context).hideCurrentSnackBar();
ScaffoldMessenger.of(context).removeCurrentSnackBar();
```

Como el messenger vive por encima del `Scaffold` de tu pantalla (normalmente a nivel de `MaterialApp`), la búsqueda hacia arriba tiene éxito desde el contexto de tu `build`. Como beneficio adicional, los `SnackBar` ahora persisten y se animan a través de las transiciones de rutas en lugar de desaparecer cuando navegas, que era el objetivo del rediseño de `ScaffoldMessenger`. `showSnackBar` también devuelve un `ScaffoldFeatureController` que puedes usar para esperar el motivo de cierre:

```dart
// Flutter 3.x (tested 3.44)
final controller = ScaffoldMessenger.of(context).showSnackBar(
  SnackBar(
    content: const Text('Item deleted'),
    action: SnackBarAction(label: 'Undo', onPressed: _undo),
  ),
);
final reason = await controller.closed; // SnackBarClosedReason.action, .timeout, ...
```

## Solución 2: obtén un contexto por debajo del Scaffold con un Builder

A veces necesitas de verdad un contexto que sea descendiente del `Scaffold`: estás llamando a `Scaffold.of(context)` para algo que no es un `SnackBar` (abrir el drawer con `Scaffold.of(context).openDrawer()`, leer `Scaffold.of(context).hasAppBar`), o configuraste un `ScaffoldMessenger` local y necesitas resolver *ese*. La solución más barata es un `Builder`, que introduce un contexto nuevo cuya posición en el árbol está por debajo del `Scaffold`:

```dart
// Flutter 3.x (tested 3.44)
@override
Widget build(BuildContext context) {
  return Scaffold(
    body: Builder(
      builder: (innerContext) {          // innerContext is BELOW the Scaffold
        return ElevatedButton(
          onPressed: () {
            ScaffoldMessenger.of(innerContext).showSnackBar(
              const SnackBar(content: Text('Saved')),
            );
          },
          child: const Text('Save'),
        );
      },
    ),
  );
}
```

El `Builder` no hace nada más que llamar a su función `builder`, pero el `innerContext` que pasa pertenece a un elemento que es hijo del `Scaffold`. Ahora el recorrido hacia arriba alcanza el `Scaffold` (y el ámbito del messenger) de inmediato. Usa el contexto interno, no el externo: ese es todo el truco.

## Solución 3: extrae la llamada a su propio widget

`Builder` es un atajo para una solución estructural: separa el botón en un `StatelessWidget` o `StatefulWidget` aparte. Su método `build` recibe un contexto que está naturalmente por debajo del `Scaffold`, así que `.of()` resuelve correctamente y nunca vuelves a pensar en ello:

```dart
// Flutter 3.x (tested 3.44)
class HomePage extends StatelessWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Home')),
      body: const Center(child: SaveButton()),
    );
  }
}

class SaveButton extends StatelessWidget {
  const SaveButton({super.key});

  @override
  Widget build(BuildContext context) {
    // This context is a descendant of the Scaffold above.
    return ElevatedButton(
      onPressed: () => ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Saved')),
      ),
      child: const Text('Save'),
    );
  }
}
```

Esta es la opción a preferir para cualquier cosa más allá de una llamada desechable. Es más legible que un `Builder` anidado, mantiene delgado tu widget de pantalla y hace que el botón sea comprobable de forma independiente.

## Solución 4: usa un GlobalKey cuando no haya contexto utilizable

Las soluciones basadas en contexto asumen que estás dentro del árbol de widgets en el momento en que muestras el mensaje. Cuando no lo estás (un `SnackBar` disparado desde un `bloc`, un repositorio, un callback en segundo plano o un manejador de errores que no tiene `BuildContext`), alcanza el messenger mediante un `GlobalKey<ScaffoldMessengerState>` conectado a `MaterialApp`:

```dart
// Flutter 3.x (tested 3.44)
final rootScaffoldMessengerKey = GlobalKey<ScaffoldMessengerState>();

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      scaffoldMessengerKey: rootScaffoldMessengerKey,
      home: const HomePage(),
    );
  }
}

// Anywhere, with no BuildContext at all:
void notifySaved() {
  rootScaffoldMessengerKey.currentState?.showSnackBar(
    const SnackBar(content: Text('Saved')),
  );
}
```

`currentState` es null hasta que la app se ha montado, así que protégelo con `?.`. Este es el patrón recomendado oficialmente para mostrar un `SnackBar` desde fuera de un widget, y esquiva por completo la pregunta de "¿qué contexto?" porque no hay ningún contexto involucrado.

## Trampas y casos parecidos

**`maybeOf` devuelve null en lugar de lanzar.** Si quieres *intentar* mostrar un mensaje y no hacer nada silenciosamente cuando no hay messenger (raro, pero útil en código compartido que puede ejecutarse fuera de un árbol Material), usa `ScaffoldMessenger.maybeOf(context)?.showSnackBar(...)`. Hace la misma búsqueda pero devuelve `null` en vez de lanzar la aserción. No lo uses para tapar un error estructural real: si esperas que haya un messenger ahí, la aserción te está haciendo un favor.

**Llamar a `.of()` en `initState`.** Una variante común es intentar mostrar un `SnackBar` en `initState`. El contexto existe, pero el frame aún no se ha dispuesto y todavía estás dentro de build/mount. Difiérelo: `WidgetsBinding.instance.addPostFrameCallback((_) => ScaffoldMessenger.of(context).showSnackBar(...))`. Mejor aún, usa el `GlobalKey` de la Solución 4 para no depender del momento del `context`.

**Usar el contexto después de un `await`.** Tomar `ScaffoldMessenger.of(context)` después de un salto asíncrono puede lanzar o resolver un messenger obsoleto si el widget se destruyó mientras esperabas. Captura el messenger *antes* del await, o protégete con `mounted`. Es la misma disciplina que [usar BuildContext de forma segura después de un await](/es/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) y [proteger setState con la comprobación de mounted](/es/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/).

**El `SnackBar` se muestra en la pantalla equivocada.** Sin fallo, pero el mensaje aparece en una ruta distinta de la que esperabas. Eso es un problema de *qué messenger*, no de *ningún messenger*: resolviste el messenger raíz de `MaterialApp` cuando querías un `ScaffoldMessenger` anidado con el que envolviste un subárbol. Resuelve desde un contexto dentro de ese ámbito anidado (Solución 2 o Solución 3), o guarda una key al messenger específico.

**`showModalBottomSheet` y `openDrawer` chocan con la misma pared.** Cualquier llamada a `Scaffold.of(context)` desde el propio contexto de `build` de la pantalla falla de forma idéntica, no solo `showSnackBar`. `Scaffold.of(context).openDrawer()` y `showModalBottomSheet(context: context, ...)` necesitan ambos un contexto por debajo del `Scaffold`. Las soluciones del `Builder` y de extraer un widget aplican sin cambios.

**Es una aserción, así que las builds de release se comportan distinto.** El fallo de `of()` lanza la aserción en debug y lanza una excepción en release. No asumas que una build de release que "no falló en pruebas" es segura: si el messenger realmente falta, release también lanzará. Resuélvelo en debug.

Si tu fallo real es otro widget Material quejándose de que no encuentra un ancestro (`No MaterialLocalizations found`, `No Directionality widget found`, `No MediaQuery widget ancestor found`), el mecanismo es la misma búsqueda hacia arriba fallida, y la solución tiene la misma forma: dale a la llamada un contexto que esté por debajo del widget que necesita, o añade el ancestro que falta. El error de Flutter [buscar el ancestro de un widget desactivado no es seguro](/es/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/) es el primo basado en el tiempo de este error estructural.

## Relacionado

- [Cómo usar BuildContext de forma segura después de un await en Flutter](/es/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) -- capturar el messenger antes de un salto asíncrono para que siga siendo válido cuando se dispare el `SnackBar`.
- [Cómo proteger setState con la comprobación de mounted tras un salto asíncrono en Flutter](/es/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/) -- la misma disciplina de ciclo de vida que mantiene seguras las llamadas a `.of()` tras un await.
- [Solución: buscar el ancestro de un widget desactivado no es seguro en Flutter](/es/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/) -- el fallo de búsqueda de ancestro basado en el tiempo, frente a este estructural.
- [Solución: Incorrect use of ParentDataWidget. Expanded widgets must be placed inside Flex widgets](/es/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/) -- otro error de "lugar equivocado en el árbol de widgets" que el framework detecta en tiempo de build.

## Fuentes

- [SnackBars managed by the ScaffoldMessenger, cambios importantes de Flutter](https://docs.flutter.dev/release/breaking-changes/scaffold-messenger) -- la migración de `Scaffold.of().showSnackBar` a `ScaffoldMessenger.of().showSnackBar`, el `scaffoldMessengerKey` y la aserción exacta "No ScaffoldMessenger widget found".
- [ScaffoldMessenger.of, referencia de la API de Flutter](https://api.flutter.dev/flutter/material/ScaffoldMessenger/of.html) -- documenta que `of()` lanza la aserción en debug y una excepción en release cuando no hay ningún messenger en el ámbito, y apunta a `maybeOf` y al patrón del `GlobalKey`.
- [ScaffoldMessenger.maybeOf, referencia de la API de Flutter](https://api.flutter.dev/flutter/material/ScaffoldMessenger/maybeOf.html) -- la búsqueda que devuelve null para cuando un messenger puede estar legítimamente ausente.
- [Scaffold.of, referencia de la API de Flutter](https://api.flutter.dev/flutter/material/Scaffold/of.html) -- el mensaje clásico "context that does not contain a Scaffold" y el remedio del `Builder`.
