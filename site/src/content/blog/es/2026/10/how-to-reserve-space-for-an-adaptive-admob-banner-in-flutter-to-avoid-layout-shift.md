---
title: "Cómo reservar espacio para un banner adaptable de AdMob en Flutter y evitar el salto de diseño"
description: "El ejemplo oficial de google_mobile_ads no renderiza nada hasta onAdLoaded, así que tu contenido salta 150 dp segundos después de que aparece la pantalla. Pide primero el tamaño adaptable anclado, resérvalo con un SizedBox, persiste la altura entre lanzamientos y solo entonces carga el anuncio. Medido en Flutter 3.44.8 con google_mobile_ads 9.1.0."
pubDate: 2026-10-05
template: how-to
tags:
  - "flutter"
  - "dart"
  - "admob"
  - "android"
  - "layout"
lang: "es"
translationOf: "2026/10/how-to-reserve-space-for-an-adaptive-admob-banner-in-flutter-to-avoid-layout-shift"
translatedBy: "claude"
translationDate: 2026-10-05
---

**Respuesta corta:** la altura de un banner adaptable anclado se conoce antes de que el anuncio cargue, así que resérvala. Llama a `AdSize.getLargeAnchoredAdaptiveBannerAdSize(width)` en cuanto tengas un ancho distinto de cero, coloca de inmediato en el espacio del banner un `SizedBox` con exactamente esa altura, e intercambia el `AdWidget` dentro de la caja cuando se dispare `onAdLoaded`. Persiste la altura con `shared_preferences` para que el primer fotograma del siguiente arranque en frío ya tenga el espacio, y conserva el espacio cuando falle una carga en lugar de colapsarlo. Todo lo que sigue se midió con Flutter 3.44.8 (Dart 3.12.2) y `google_mobile_ads` 9.1.0 en un emulador de Android 16 (API 36).

## Por qué la pantalla salta cuando llega el banner

La guía de banners de Google para el plugin de Flutter carga el anuncio y solo lo agrega al árbol en `onAdLoaded`. El fragmento de visualización está protegido por `if (_bannerAd != null)`, y el tamaño de la caja sale de `_bannerAd!.size`. Hasta que termina el viaje de ida y vuelta por la red, el espacio del banner mide cero píxeles de alto. Cuando el anuncio llega, el espacio crece, el cuerpo del `Scaffold` se encoge en la misma cantidad, y todo lo que el usuario miraba cerca de la parte inferior se mueve.

Ese salto es peor que antes por dos razones:

1. **Los banners adaptables anclados grandes son altos.** Desde `google_mobile_ads` 8.0.0, `getCurrentOrientationAnchoredAdaptiveBannerAdSize` está obsoleto en favor de `getLargeAnchoredAdaptiveBannerAdSize`. La guía de Google describe la variante grande como "up to 20% of screen height, between 50 and 150 dp". En un celular típico eso es aproximadamente el doble de la antigua franja de 50 a 64 dp.
2. **El anuncio llega tarde.** La solicitud sale después de `MobileAds.instance.initialize()`, una subasta de anuncios y la descarga del creativo. En un arranque en frío son segundos, no fotogramas, que es justo cuando los usuarios empiezan a leer o a tocar.

## Medir el salto

Para obtener números reales construí una app de prueba: un `Scaffold` cuyo cuerpo es un `ListView` envuelto en un `LayoutBuilder` que registra cada cambio en la altura del cuerpo, con el banner en `bottomNavigationBar`. El emulador tenía una pantalla de 1080x2400 a 420 dpi, que Flutter ve como 411.43 x 914.29 píxeles lógicos, con la unidad de prueba oficial de banner adaptable `ca-app-pub-3940256099942544/9214589741` y una compilación release.

Primero, las alturas que devuelve el SDK para distintos anchos (todos los valores en dp):

| Ancho solicitado | Grande anclado (orientación actual) | Grande, horizontal | Anclado estándar (obsoleto) |
|---|---|---|---|
| 320 | 100 | 82 | 50 |
| 360 | 113 | 82 | 56 |
| 411 | 128 | 82 | 64 |
| 412 | 129 | 82 | 64 |
| 600 | 150 | 82 | 77 |
| 800 | 150 | 82 | 90 |

En vertical, el tamaño grande sigue la proporción 320x50 escalada a 320x100 y llega a un tope de 150. En horizontal queda fijo en 82, que es el 20% de los 411 dp de alto en horizontal. Nada de esto necesita una llamada de red: el tamaño se calcula en el dispositivo y se resuelve en unos pocos milisegundos.

Luego, la línea de tiempo de la altura del cuerpo para el patrón del tutorial frente a un espacio reservado:

| Patrón | Primer fotograma real | Cambio de altura del cuerpo | Cuándo |
|---|---|---|---|
| No renderizar nada hasta `onAdLoaded` | 302 ms | 914.29 -> 762.29 | 5,338 ms, cuando cargó el anuncio |
| Reservar el tamaño, obtenido en `didChangeDependencies` | 439 ms | 914.29 -> 762.29 | 448 ms, un fotograma después |
| Reservar el tamaño, altura restaurada desde `shared_preferences` | 546 ms | 0 -> 762.29 directamente | ningún salto |

La caída de 152 dp es el banner de 128 dp más el margen de 24 dp de la navegación por gestos que `SafeArea` añade debajo. En la versión ingenua ocurre más de cinco segundos después de que aparece la pantalla. Reservar el tamaño la mueve al fotograma siguiente al primero, y persistir la altura la elimina.

## Paso 1: obtén el tamaño antes de cargar nada

Los métodos de tamaño de `AdSize` son estáticos y asíncronos porque cruzan el canal de plataforma, pero no dependen de que haya un anuncio cargado. Llámalos en cuanto `MediaQuery` te dé un ancho:

```dart
// Flutter 3.44.8, google_mobile_ads 9.1.0
@override
void didChangeDependencies() {
  super.didChangeDependencies();
  final size = MediaQuery.sizeOf(context);
  final padding = MediaQuery.paddingOf(context);
  final width = (size.width - padding.left - padding.right).truncate();
  // Android can report a 0x0 window on the very first frame.
  if (width <= 0 || width == _width) return;
  _width = width;
  unawaited(_load(width));
}
```

La protección `width <= 0` no es decorativa. En la compilación release, el primer `build` se ejecutó con un tamaño de `MediaQuery` de 0x0: Android aún no había entregado las métricas de la ventana. Incluso `platformDispatcher.implicitView` en `main()` reportaba un `physicalSize` de 0 y un `devicePixelRatio` de 1.0 antes de `runApp`. Pedir un banner anclado grande con ancho 0 devolvía `0x100`, y cargar ese tamaño fallaba con `LoadAdError(code: 3, ... "Ad request doesn't meet size requirements")`. El código del tutorial lanza su primera solicitud desde ese fotograma de ancho cero y solo funciona porque `didChangeDependencies` se ejecuta de nuevo un fotograma después con métricas reales.

Resta el relleno horizontal del área segura antes de preguntar. La guía de adaptables en línea de Google es explícita en que el ancho "should take into account the device width and any safe areas that are applicable", y en horizontal, en un celular con muesca en la pantalla, `MediaQuery.paddingOf(context).left` no es cero.

## Paso 2: construye un espacio que sea dueño de su altura

El espacio es un `SizedBox` con la altura reservada que siempre está en el árbol. El `AdWidget` entra en él solo después de que el anuncio cargó, porque de lo contrario `AdWidget` lanza "AdWidget requires Ad.load to be called before AdWidget is inserted into the tree".

```dart
// Flutter 3.44.8, google_mobile_ads 9.1.0, shared_preferences 2.5.5
class AnchoredBannerSlot extends StatefulWidget {
  const AnchoredBannerSlot({super.key, required this.adUnitId});

  final String adUnitId;

  @override
  State<AnchoredBannerSlot> createState() => _AnchoredBannerSlotState();
}

class _AnchoredBannerSlotState extends State<AnchoredBannerSlot> {
  BannerAd? _ad;
  bool _loaded = false;
  int? _width;
  int? _height;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final size = MediaQuery.sizeOf(context);
    final padding = MediaQuery.paddingOf(context);
    final width = (size.width - padding.left - padding.right).truncate();
    // Android can report a 0x0 window on the very first frame.
    if (width <= 0 || width == _width) return;
    _width = width;
    _height = BannerHeightCache.lookup(width);
    unawaited(_load(width));
  }

  Future<void> _load(int width) async {
    final size = await AdSize.getLargeAnchoredAdaptiveBannerAdSize(width);
    if (!mounted || width != _width || size == null) return;
    BannerHeightCache.remember(width, size.height);

    final previous = _ad;
    setState(() {
      _height = size.height;
      _ad = null;
      _loaded = false;
    });
    await previous?.dispose();
    if (!mounted || width != _width) return;

    final ad = BannerAd(
      adUnitId: widget.adUnitId,
      request: const AdRequest(),
      size: size,
      listener: BannerAdListener(
        onAdLoaded: (ad) {
          if (!mounted || ad != _ad) {
            ad.dispose();
            return;
          }
          setState(() => _loaded = true);
        },
        onAdFailedToLoad: (ad, error) {
          ad.dispose();
          // Keep the reserved height: collapsing now would be a layout shift.
          if (mounted && ad == _ad) setState(() => _ad = null);
        },
      ),
    );
    _ad = ad;
    await ad.load();
  }

  @override
  void dispose() {
    _ad?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final height = _height;
    if (height == null) return const SizedBox.shrink();
    final ad = _ad;
    return SafeArea(
      top: false,
      child: SizedBox(
        height: height.toDouble(),
        child: Center(
          child: _loaded && ad != null
              ? SizedBox(
                  width: ad.size.width.toDouble(),
                  height: ad.size.height.toDouble(),
                  child: AdWidget(ad: ad),
                )
              : null,
        ),
      ),
    );
  }
}
```

Algunos detalles que importan:

- **`width != _width` después de cada `await`.** La rotación cambia el ancho mientras una consulta de tamaño o un `dispose()` está en curso. Sin la comprobación, una solicitud vertical obsoleta puede sobrescribir el espacio horizontal.
- **`ad != _ad` en `onAdLoaded`.** Si el widget ya pasó a una solicitud más nueva, el anuncio tardío se descarta en lugar de mostrarse.
- **`SafeArea(top: false)` fuera de la caja reservada.** El espacio está en `bottomNavigationBar`, así que tiene que absorber por sí mismo el margen inferior. Con edge-to-edge obligatorio para las apps que apuntan a Android 15 y posteriores, ese margen ya no se resta por ti.
- **`Center` alrededor del `AdWidget`.** En iOS, la documentación del plugin dice que el widget necesita un padre "with a specified width and height", o de lo contrario puede que el anuncio no se muestre. El `SizedBox` interior le da exactamente el tamaño solicitado.

Usarlo es una línea en el `Scaffold`:

```dart
// Flutter 3.44.8, google_mobile_ads 9.1.0
Scaffold(
  body: const ArticleList(),
  bottomNavigationBar: const AnchoredBannerSlot(
    adUnitId: 'ca-app-pub-3940256099942544/9214589741', // test unit
  ),
);
```

## Paso 3: persiste la altura para que el primer fotograma sea correcto

El paso 2 todavía deja un hueco de un fotograma en el arranque en frío: el primer fotograma con un ancho real se renderiza antes de que responda el canal de plataforma. En las mediciones ese hueco fue de 9 a 70 ms, que suele caer mientras el primer contenido aún se está pintando, pero es un salto y se nota en las grabaciones de pantalla.

La solución es que la altura anclada es una función pura del dispositivo y el ancho. La propia documentación de Google dice que la altura óptima "remains constant across different ad requests". Así que la última respuesta del SDK es una primera estimación perfecta para el siguiente lanzamiento:

```dart
// Flutter 3.44.8, shared_preferences 2.5.5
class BannerHeightCache {
  static const _prefix = 'admob.anchoredHeight.';
  static final Map<int, int> _heights = {};

  static Future<void> restore() async {
    final prefs = await SharedPreferences.getInstance();
    for (final key in prefs.getKeys().where((k) => k.startsWith(_prefix))) {
      final width = int.tryParse(key.substring(_prefix.length));
      final height = prefs.getInt(key);
      if (width != null && height != null) _heights[width] = height;
    }
  }

  static int? lookup(int width) => _heights[width];

  static void remember(int width, int height) {
    if (_heights[width] == height) return;
    _heights[width] = height;
    unawaited(
      SharedPreferences.getInstance()
          .then((prefs) => prefs.setInt('$_prefix$width', height)),
    );
  }
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await BannerHeightCache.restore();
  unawaited(MobileAds.instance.initialize());
  runApp(const MyApp());
}
```

El espacio ya lee `BannerHeightCache.lookup(width)` en `didChangeDependencies`, así que en el segundo lanzamiento el primer fotograma real se construye con una caja de 128 dp y el cuerpo pasa de 0 directamente a sus 762.29 dp finales. La consulta en vivo sigue ejecutándose y sobrescribe el valor en caché, de modo que una estimación errónea (nueva versión del sistema operativo, distinto ajuste de tamaño de pantalla) cuesta un salto y luego se corrige sola. El mapa en memoria también ayuda dentro de una sesión: la segunda pantalla que aloje un banner obtiene la altura de forma síncrona.

No intentes calcular la altura tú mismo a partir de la tabla anterior. La proporción 100/320 y los topes son comportamiento observado del SDK, no un contrato documentado, y Google ya ha cambiado el dimensionamiento adaptable antes. Guardar en caché la respuesta del SDK te da la misma precisión en el primer fotograma sin apostar por una fórmula.

## Paso 4: decide qué pasa cuando no vuelve ningún anuncio

Con un espacio reservado, una carga fallida deja una franja vacía en la parte inferior. Tienes dos opciones honestas:

1. **Conservar la franja.** El diseño nunca se mueve, y la siguiente solicitud (al navegar, con un temporizador, o mediante la actualización automática de AdMob si la configuraste) la llena. Esto es lo que hace el widget de arriba.
2. **Colapsar la franja.** Recuperas el espacio, a costa de exactamente un salto de diseño, y necesitas volver a reservar antes del siguiente intento.

Para un banner anclado abajo prefiero la primera. Los usuarios dejan de ver una franja en blanco de 128 dp como algo "faltante" muy rápido, pero nunca dejan de notar una lista que salta bajo su pulgar. Si colapsas, anímalo con un `AnimatedSize` para que al menos el cambio parezca intencional.

## El anuncio de prueba era más pequeño que el espacio

Una cosa más que mostró la app de prueba. Después de `onAdLoaded`, `BannerAd.getPlatformAdSize()` reportó `411x64` para un anuncio solicitado a `411x128`. El creativo de prueba es un banner de altura estándar. La vista nativa lo centró dentro de la solicitud de 128 dp, y renderizar el `AdWidget` a 128 dp o al tamaño de la plataforma se veía idéntico. No reduzcas el espacio al tamaño de la plataforma tras la carga: eso es un salto de diseño en la otra dirección, y la siguiente actualización bien puede devolver un creativo de altura completa.

## Banners adaptables en línea dentro de contenido con desplazamiento

Los banners adaptables en línea son la otra familia adaptable, pensada para colocarse dentro de un feed. Su altura la elige el servidor, así que `AdSize.getCurrentOrientationInlineAdaptiveBannerAdSize(width)` devuelve un tamaño con altura 0 y solo conoces la altura real con `getPlatformAdSize()` después de la carga. El ejemplo de Google lo maneja renderizando un `Container()` vacío hasta la carga y luego dimensionando la caja, lo que desplaza cada elemento que está debajo.

No puedes reservar una altura desconocida, pero sí acotarla. Usa `AdSize.getInlineAdaptiveBannerAdSize(width, maxHeight)` y reserva `maxHeight`:

```dart
// Flutter 3.44.8, google_mobile_ads 9.1.0
class InlineBannerSlot extends StatefulWidget {
  const InlineBannerSlot({super.key, required this.adUnitId, this.maxHeight = 250});

  final String adUnitId;
  final int maxHeight;

  @override
  State<InlineBannerSlot> createState() => _InlineBannerSlotState();
}

class _InlineBannerSlotState extends State<InlineBannerSlot> {
  BannerAd? _ad;
  AdSize? _platformSize;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_ad != null) return;
    final width = MediaQuery.sizeOf(context).width.truncate();
    if (width <= 0) return;
    _ad = BannerAd(
      adUnitId: widget.adUnitId,
      request: const AdRequest(),
      size: AdSize.getInlineAdaptiveBannerAdSize(width, widget.maxHeight),
      listener: BannerAdListener(
        onAdLoaded: (ad) async {
          final size = await (ad as BannerAd).getPlatformAdSize();
          if (mounted) setState(() => _platformSize = size);
        },
        onAdFailedToLoad: (ad, error) => ad.dispose(),
      ),
    )..load();
  }

  @override
  void dispose() {
    _ad?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ad = _ad;
    final size = _platformSize;
    return SizedBox(
      height: widget.maxHeight.toDouble(),
      child: Center(
        child: ad != null && size != null
            ? SizedBox(
                width: size.width.toDouble(),
                height: size.height.toDouble(),
                child: AdWidget(ad: ad),
              )
            : null,
      ),
    );
  }
}
```

La contrapartida son las franjas laterales cuando el creativo es más corto que `maxHeight`. Si eso se ve mal en tu diseño, la alternativa es iniciar la solicitud bastante antes de que el elemento entre en la vista (un `ListView` construye los elementos dentro del `cacheExtent` del viewport, 250 píxeles por defecto) y aceptar que un salto por encima del viewport mueve la posición del desplazamiento. Google también advierte que los banners en línea en vistas con desplazamiento pueden rendir mal en Android 9 y anteriores, mientras que los banners anclados no se ven afectados.

## Problemas frecuentes

- **Un `BannerAd`, un `AdWidget`.** Reutilizar un objeto de anuncio en dos lugares lanza "This AdWidget is already in the Widget tree". Cada espacio es dueño de su propio anuncio.
- **`getLargeAnchoredAdaptiveBannerAdSize` puede devolver `null`.** El plugin devuelve `null` cuando el SDK no encuentra una altura para la ventana. El espacio entonces no renderiza nada, lo que equivale a no mostrar un anuncio.
- **No uses los tamaños obsoletos para "ahorrar espacio".** `getCurrentOrientationAnchoredAdaptiveBannerAdSize` sigue funcionando en 9.1.0 y da 64 dp en lugar de 128 con 411 dp de ancho, pero está obsoleto y el formato grande es el que Google optimiza.
- **Los cambios de orientación son una nueva solicitud.** El ancho cambia, el espacio reserva de inmediato la nueva altura (en horizontal son 82 dp en este dispositivo) y se carga un nuevo anuncio para ella. Ese salto lo causa la propia rotación, así que es esperable.
- **El hot reload oculta el error del primer fotograma.** El primer fotograma de ancho cero solo aparece en un arranque en frío. Prueba el espacio reservado con `flutter run --release` después de forzar la detención, no después de un hot restart.
- **Una compilación release puede fallar antes de que se ejecute tu código de anuncios.** En la app de prueba, R8 eliminó `androidx.work.impl.WorkDatabase`, que el SDK de anuncios incorpora a través de WorkManager, y la app murió con "Failed to create an instance of androidx.work.impl.WorkDatabase". Desactivar la minificación (`isMinifyEnabled = false`) lo solucionó en la prueba; una regla keep de ProGuard para las clases de la base de datos de WorkManager es la solución más acotada. Si tu compilación release falla y la de debug no, revisa `adb logcat` antes de culpar al código del banner.

Si también ejecutas banners desde .NET MAUI, el mismo razonamiento aplica allí: la [guía de AdMob para MAUI con banners, intersticiales y anuncios con recompensa](/2026/07/monetize-a-net-maui-app-with-admob-banner-interstitial-rewarded/) usa las vistas nativas, que tienen las mismas API de dimensionamiento previas a la carga.

## Relacionado

- [Solución: la UI de Flutter se superpone con la barra de navegación del sistema de Android tras apuntar a SDK 35](/es/2026/08/fix-flutter-ui-overlaps-the-android-navigation-bar-after-targeting-sdk-35/) explica el margen inferior que el espacio del banner tiene que absorber.
- [Cómo usar BuildContext de forma segura después de un await en Flutter](/es/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) cubre las comprobaciones de `mounted` que el espacio hace después de cada paso asíncrono.
- [Cómo perfilar el jank en una app de Flutter con DevTools](/es/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) te ayuda a confirmar que la vista de plataforma no te cuesta fotogramas una vez que el banner está en su lugar.
- [Monetiza una app .NET MAUI con banners, intersticiales y anuncios con recompensa de AdMob](/2026/07/monetize-a-net-maui-app-with-admob-banner-interstitial-rewarded/) es el lado MAUI de la misma configuración de AdMob.

## Fuentes

- [Set up banner ads (Flutter)](https://developers.google.com/admob/flutter/banner) para el dimensionamiento adaptable anclado grande, los ID de unidades de anuncios de prueba y la nota de dimensionamiento en iOS.
- [Use inline adaptive for scrolling banners (Flutter)](https://developers.google.com/admob/flutter/banner/inline-adaptive) para `getInlineAdaptiveBannerAdSize` y `getPlatformAdSize`.
- [Set up banner ads (Android)](https://developers.google.com/admob/android/banner/anchored-adaptive) para el rango de 50 a 150 dp, 20% de la altura de la pantalla, de los banners adaptables grandes.
- [google_mobile_ads on pub.dev](https://pub.dev/packages/google_mobile_ads) y su [changelog](https://pub.dev/packages/google_mobile_ads/changelog), incluidas las obsolescencias de 8.0.0.
- [shared_preferences on pub.dev](https://pub.dev/packages/shared_preferences).
