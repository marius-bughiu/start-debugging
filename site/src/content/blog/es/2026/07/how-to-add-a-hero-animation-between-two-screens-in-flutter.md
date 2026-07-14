---
title: "Cómo agregar una animación Hero entre dos pantallas en Flutter"
description: "Envuelve el mismo widget en ambas rutas dentro de un Hero con un tag idéntico y Flutter anima su posición y tamaño durante la navegación. Guía completa: imágenes, flightShuttleBuilder, createRectTween, arcos con RectTween, transiciones por gesto y las colisiones de tag que lo rompen. Probado en Flutter 3.44, Dart 3.12."
pubDate: 2026-07-14
tags:
  - "flutter"
  - "dart"
  - "animation"
  - "navigation"
  - "how-to"
lang: "es"
translationOf: "2026/07/how-to-add-a-hero-animation-between-two-screens-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-14
---

Respuesta corta: envuelve el widget que quieres animar en un `Hero` en la primera pantalla, envuelve el widget de destino en un segundo `Hero` con el **mismo `tag`** y empuja la ruta de destino con el `Navigator` normal. El `HeroController` de Flutter (instalado por defecto en `MaterialApp` y `CupertinoApp`) encuentra los dos heroes con el tag coincidente durante la transición de ruta, eleva el hero de origen a un overlay e interpola su posición y tamaño hasta que aterriza en el destino. No escribes ningún `AnimationController`, ningún `Tween` ni una duración explícita para el caso básico. Verificado en Flutter 3.44, Dart 3.12.

Ese es todo el truco, y de verdad son dos widgets `Hero` y un `Navigator.push`. El resto de esta guía es la parte con la que la gente tropieza: las reglas del tag, animar una imagen o un `Icon` que cambia de forma entre pantallas, personalizar el widget de vuelo para que no parpadee entre temas, curvar la trayectoria del vuelo y el puñado de errores que convierten una transición fluida en un salto brusco.

## El ejemplo mínimo que funciona

Dos pantallas. Una caja de color en la primera, la misma caja más grande en la segunda. La caja vuela entre ambas.

```dart
// Flutter 3.44, Dart 3.12
import 'package:flutter/material.dart';

void main() => runApp(const MyApp());

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(home: FirstScreen());
  }
}

class FirstScreen extends StatelessWidget {
  const FirstScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('First')),
      body: Center(
        child: GestureDetector(
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute(builder: (_) => const SecondScreen()),
          ),
          child: Hero(
            tag: 'box-hero',
            child: Container(width: 80, height: 80, color: Colors.indigo),
          ),
        ),
      ),
    );
  }
}

class SecondScreen extends StatelessWidget {
  const SecondScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Second')),
      body: Center(
        child: Hero(
          tag: 'box-hero',
          child: Container(width: 240, height: 240, color: Colors.indigo),
        ),
      ),
    );
  }
}
```

Toca la caja pequeña y crece y se desliza hasta el centro de la segunda pantalla. Toca atrás y se revierte. La cadena `tag` `'box-hero'` es todo el enlace entre los dos widgets. Si los tags difieren en un solo carácter, no se anima nada y ambas cajas simplemente aparecen y desaparecen de forma normal.

## Por qué los tags coincidentes son todo el mecanismo

`Hero` no guarda una referencia a su contraparte. En cambio, en el momento en que arranca una transición de ruta, el `HeroController` recorre el árbol de widgets de la ruta saliente y de la entrante y construye un mapa de tag a hero. Para cada tag presente en **ambas** rutas, inicia un "vuelo": el hero de origen se retira de su posición normal (un `placeholderBuilder` rellena el hueco, vacío por defecto), se coloca una copia en el `Stack` de overlay del `Navigator` y esa copia se anima desde el `Rect` de origen hasta el `Rect` de destino usando la propia animación de transición de la ruta como reloj.

De este diseño se desprenden dos consecuencias, y ambas son el origen de la mayoría de los bugs de Hero:

1. **Un tag debe ser único dentro de una sola ruta.** Si una pantalla tiene dos widgets `Hero` con `tag: 'box-hero'`, Flutter no puede decidir cuál hacer volar y lanza `There are multiple heroes that share the same tag within a subtree`. Esto muerde con más fuerza cuando pones un `Hero` dentro de un elemento de `ListView` y le das a cada elemento el mismo tag literal. Usa el id del elemento: `tag: 'photo-${photo.id}'`.
2. **El hero debe existir en el primer frame de la ruta de destino.** El controller inspecciona la ruta de destino mientras se construye. Si tu hero de destino está detrás de un `FutureBuilder` que no ha resuelto, dentro de un `Offstage`, o bloqueado por un `if` que es falso en la primera construcción, no hay un `Rect` de destino al que volar y la animación se omite silenciosamente.

## Animar una imagen o un icono que cambia de forma

El uso real más común es una miniatura que se expande en un encabezado a pantalla completa. El hijo no tiene que ser idéntico en ambas rutas, solo tener el tag idéntico. Aquí el origen es una miniatura redondeada de 80x80 y el destino es una imagen a todo el ancho.

```dart
// Flutter 3.44, Dart 3.12
// Source: a grid thumbnail
Hero(
  tag: 'photo-${photo.id}',
  child: ClipRRect(
    borderRadius: BorderRadius.circular(12),
    child: Image.network(photo.url, width: 80, height: 80, fit: BoxFit.cover),
  ),
);

// Destination: a full-width header
Hero(
  tag: 'photo-${photo.id}',
  child: Image.network(
    photo.url,
    width: double.infinity,
    height: 300,
    fit: BoxFit.cover,
  ),
);
```

Dos cosas a vigilar cuando el hijo es una `Image`. Primero, usa la misma `url` de imagen (idealmente el mismo `ImageProvider` en memoria) en ambas rutas para que la descarga de red ya esté en caché y el vuelo no muestre un frame a medio cargar. Segundo, un `BoxFit` distinto o un `ClipRRect` en un solo lado produce un salto visible cuando el radio de esquina o el recorte se ajustan de golpe al final del vuelo. Si las esquinas redondeadas importan, envuelve ambos lados en el mismo `ClipRRect`, o usa un `flightShuttleBuilder` (más abajo) para interpolar el radio.

Para un `Icon` o un fragmento de `Text` con estilo, aplica la misma regla: el framework interpola el `Rect` delimitador y escala el renderizado del hijo de origen para ajustarse a ese rect durante el vuelo. Un icono de 24px que vuela a un icono de 96px se ve correcto porque el hijo se escala, no se vuelve a maquetar a mitad del vuelo.

## Personalizar el widget de vuelo con flightShuttleBuilder

Por defecto, el vuelo muestra el hijo del hero de destino, escalado. Ese comportamiento por defecto se rompe en dos situaciones: cuando el hijo lee un `InheritedWidget` (un `Theme`, `DefaultTextStyle` o `MediaQuery`) que difiere entre las dos rutas, y cuando quieres que el widget se transforme visiblemente, no solo se escale, durante el vuelo. `flightShuttleBuilder` te da control total sobre lo que se renderiza mientras el hero está en el aire.

```dart
// Flutter 3.44, Dart 3.12
Hero(
  tag: 'photo-${photo.id}',
  flightShuttleBuilder: (
    flightContext,
    animation,
    flightDirection,
    fromHeroContext,
    toHeroContext,
  ) {
    // Render the destination hero's widget, but wrapped in the
    // destination route's Material so text/icon theming is stable.
    return DefaultTextStyle(
      style: DefaultTextStyle.of(toHeroContext).style,
      child: toHeroContext.widget as Hero,
    );
  },
  child: Text(photo.title, style: Theme.of(context).textTheme.titleLarge),
);
```

El argumento `flightDirection` es `HeroFlightDirection.push` o `HeroFlightDirection.pop`, así que puedes renderizar un shuttle distinto a la entrada que a la salida. La `animation` es el `Animation<double>` del vuelo, de 0 a 1; úsalo para hacer un cross-fade o interpolar un `BorderRadius` si quieres que las esquinas se redondeen suavemente en lugar de saltar de golpe. Esta es la solución correcta al problema de "las esquinas redondeadas saltan al final": maneja el radio desde `animation.value` dentro del shuttle.

## Curvar la trayectoria del vuelo con createRectTween

Por defecto, el hero se mueve en línea recta entre los dos rects, y su tamaño se interpola linealmente. Las propias transiciones de detalle de Material a menudo usan un **arco**: el widget sigue una trayectoria curva, que se lee como más natural para una tarjeta que se expande en una página. Flutter incluye `MaterialRectArcTween` justo para esto, y te suscribes por hero con `createRectTween`.

```dart
// Flutter 3.44, Dart 3.12
Hero(
  tag: 'box-hero',
  createRectTween: (begin, end) {
    return MaterialRectArcTween(begin: begin, end: end);
  },
  child: const SizedBox(width: 80, height: 80),
);
```

`createRectTween` se ejecuta en el hero que es el destino del vuelo. Si quieres el arco tanto en push como en pop, configúralo en los heroes de ambas rutas. El valor por defecto es un `RectTween` simple (lineal). `MaterialRectArcTween` curva las esquinas superior-izquierda e inferior-derecha a lo largo de arcos, que es por lo que una tarjeta que se expande parece "barrer" hasta su lugar en vez de disparar en diagonal. A partir de Flutter 3.44 también puedes pasar una curva directamente a la transición vía la ruta, pero `createRectTween` sigue siendo la manera de dar forma a la trayectoria geométrica en vez del tiempo.

## Hacer que el gesto de retroceso de iOS anime el hero

En un `CupertinoPageRoute` (o un `MaterialPageRoute` en iOS), el usuario puede arrastrar desde el borde izquierdo para hacer pop de la ruta. Por defecto, el hero **no** vuela durante ese arrastre interactivo; solo vuela en un pop confirmado. Configura `transitionOnUserGestures: true` en ambos heroes para que el elemento compartido siga el arrastre.

```dart
// Flutter 3.44, Dart 3.12
Hero(
  tag: 'box-hero',
  transitionOnUserGestures: true,
  child: Container(width: 80, height: 80, color: Colors.indigo),
);
```

Configúralo tanto en el hero de origen como en el de destino. Si solo lo configuras en uno, el push anima pero el pop interactivo no, lo que se siente inconsistente. Esto es barato de añadir y rara vez hay razón para dejarlo desactivado en un par de elemento compartido genuino.

## Animación Hero con go_router y otros routers

Nada de `Hero` está atado al `Navigator.push` imperativo. La animación la maneja la transición de ruta, así que funciona igual bajo `go_router`, `auto_route` o cualquier router construido sobre `Navigator` 2.0, siempre que la página de destino use una página capaz de transición (`MaterialPage`, `CupertinoPage` o un `CustomTransitionPage`). Dale a los dos widgets el mismo tag y navega como tu app normalmente lo haga:

```dart
// Flutter 3.44, Dart 3.12, go_router 14.x
GoRoute(
  path: '/photo/:id',
  builder: (context, state) => PhotoDetailScreen(id: state.pathParameters['id']!),
);

// Trigger it from the grid:
onTap: () => context.go('/photo/${photo.id}'),
```

Una advertencia con los routers declarativos: si usas un `CustomTransitionPage` con duración cero o un `NoTransitionPage`, no hay animación de transición que el `HeroController` maneje, así que el hero no volará. Mantén una transición real (aunque sea un fundido corto) en cualquier ruta donde quieras una animación de elemento compartido. Para una comparación más profunda de los routers en sí, mira las notas sobre [rutas anidadas y deep links con go_router](/es/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/) y el desglose de [go_router vs auto_route vs Navigator 2.0](/es/2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter/).

## Los errores que rompen las animaciones Hero

Estos son los fallos que aparecen en los reportes de bugs, ordenados por cuánto tráfico de búsqueda atraen.

1. **`There are multiple heroes that share the same tag within a subtree`.** Dos heroes en la misma ruta comparten un tag. Casi siempre una lista donde cada elemento usó un tag constante. Solución: deriva el tag de una clave única como `'item-${item.id}'`. Si legítimamente necesitas el mismo visual en pantalla dos veces, solo uno de ellos puede participar en el vuelo; dales a los demás tags distintos o ningún `Hero`.
2. **El hero simplemente aparece, sin vuelo.** El hero de destino no está presente en el primer frame. Está detrás de un `FutureBuilder` sin resolver, dentro de un `Offstage`, o bloqueado por una bandera que es falsa en la primera construcción. Asegúrate de que el widget con tag esté en el árbol de inmediato, aunque sus datos carguen más tarde, para que haya un rect al que volar. Una trampa relacionada es inicializar ese `Future` dentro de `build`, lo que lo recrea en cada reconstrucción; mira [inicializar un Future para que FutureBuilder no lo recree](/es/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/).
3. **El hijo salta o parpadea al final del vuelo.** `BoxFit`, radio de `ClipRRect` o un estilo dependiente de `InheritedWidget` distintos entre las dos rutas. Se soluciona con un `flightShuttleBuilder` que renderice un widget estable e interpole la propiedad que difiere desde `animation.value`.
4. **`Navigator.pop` lanza o la flecha de retroceso no hace nada.** Esto no es un problema de Hero, pero lo parece porque ocurre en la pantalla con el hero. Confirma que la ruta se empujó con un `Navigator` que posee un `HeroController`. Los `Navigator`s anidados personalizados necesitan su propio `HeroController` en `observers` o los heroes no volarán entre ellos.
5. **La maquetación salta porque el hero tiene tamaño sin límites.** Un `Hero` que envuelve un `Text` o un `Row` dentro de un `Column` puede caer en una situación de ancho sin límites durante el vuelo cuando se eleva al `Stack` de overlay. Envuelve el hijo del hero en un `Material` con `type: MaterialType.transparency`, o dale restricciones explícitas. Si estás topándote con errores de altura sin límites de forma más general, el patrón es la misma familia de bug de maquetación tratada en [anidar un ListView dentro de un Column](/es/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/).

## El texto necesita un ancestro Material durante el vuelo

Uno sutil que merece su propia nota: mientras un hero está en vuelo vive en el overlay del `Navigator`, desconectado del `Scaffold` y su `Material`. `Text` y los widgets basados en `Ink` buscan un ancestro `Material` para su estilo de texto por defecto y sus salpicaduras de ink. Durante el vuelo puede que no lo encuentren, así que el texto con estilo puede renderizarse con el estilo de depuración por defecto (subrayado negro) durante un frame. Envuelve el hijo del vuelo en un `Material`:

```dart
// Flutter 3.44, Dart 3.12
Hero(
  tag: 'title-hero',
  flightShuttleBuilder: (ctx, anim, dir, fromCtx, toCtx) {
    return Material(
      type: MaterialType.transparency,
      child: toCtx.widget,
    );
  },
  child: Material(
    type: MaterialType.transparency,
    child: Text('Details', style: Theme.of(context).textTheme.headlineSmall),
  ),
);
```

`MaterialType.transparency` le da al texto un ancestro `Material` para resolver su estilo sin pintar un fondo, lo que mantiene el vuelo visualmente limpio.

## Cuándo no usar un Hero

Un `Hero` es la herramienta correcta cuando el *mismo elemento conceptual* existe en ambas pantallas: una miniatura que se convierte en encabezado, un avatar que se convierte en foto de perfil, una tarjeta que se convierte en página de detalle. Es la herramienta equivocada para movimiento decorativo donde no se comparte nada. Si quieres que toda la página se deslice, se funda o se escale, eso es un `transitionsBuilder` de ruta (o un `PageRouteBuilder`), no un `Hero`. Si quieres que un widget se anime *dentro* de una pantalla, recurre a `AnimatedContainer`, `AnimatedPositioned` o un `AnimationController` explícito. Hero es dueño específicamente del caso de elemento compartido entre rutas, y usarlo para cualquier otra cosa es pelear contra el framework.

Para trabajo más amplio de rendimiento y UI de Flutter que suele aparecer junto con agregar transiciones, las guías sobre [perfilar el jank con DevTools](/es/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) y [definir un color de acento con Material 3 ColorScheme](/es/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/) cubren las dos cosas que la gente suele pulir justo después de que la navegación se siente bien: el presupuesto de frames y el theming.

## Fuentes

- API de Flutter: [clase `Hero`](https://api.flutter.dev/flutter/widgets/Hero-class.html)
- Docs de Flutter: [Hero animations](https://docs.flutter.dev/ui/animations/hero-animations)
- Cookbook de Flutter: [Animate a widget across screens](https://docs.flutter.dev/cookbook/navigation/hero-animations)
- API de Flutter: [`MaterialRectArcTween`](https://api.flutter.dev/flutter/material/MaterialRectArcTween-class.html)
- API de Flutter: [`HeroController`](https://api.flutter.dev/flutter/widgets/HeroController-class.html)
