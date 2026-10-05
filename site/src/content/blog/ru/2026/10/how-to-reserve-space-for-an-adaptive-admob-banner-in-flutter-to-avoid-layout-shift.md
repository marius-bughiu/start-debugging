---
title: "Как зарезервировать место под адаптивный баннер AdMob во Flutter, чтобы избежать сдвига макета"
description: "Официальный пример google_mobile_ads ничего не рисует до onAdLoaded, поэтому ваш контент прыгает на 150 dp через несколько секунд после появления экрана. Сначала запросите размер закреплённого адаптивного баннера, зарезервируйте его через SizedBox, сохраните высоту между запусками и только потом загружайте рекламу. Измерения выполнены на Flutter 3.44.8 с google_mobile_ads 9.1.0."
pubDate: 2026-10-05
template: how-to
tags:
  - "flutter"
  - "dart"
  - "admob"
  - "android"
  - "layout"
lang: "ru"
translationOf: "2026/10/how-to-reserve-space-for-an-adaptive-admob-banner-in-flutter-to-avoid-layout-shift"
translatedBy: "claude"
translationDate: 2026-10-05
---

**Краткий ответ:** высота закреплённого адаптивного баннера известна ещё до загрузки рекламы, так что зарезервируйте её. Вызовите `AdSize.getLargeAnchoredAdaptiveBannerAdSize(width)` сразу, как только появится ненулевая ширина, сразу поместите в слот баннера `SizedBox` ровно такой высоты, а `AdWidget` подставьте внутрь, когда сработает `onAdLoaded`. Сохраните высоту через `shared_preferences`, чтобы уже самый первый кадр при следующем холодном запуске содержал слот, и оставляйте слот на месте при неудачной загрузке, а не схлопывайте его. Всё ниже измерено на Flutter 3.44.8 (Dart 3.12.2) и `google_mobile_ads` 9.1.0 в эмуляторе Android 16 (API 36).

## Почему экран прыгает, когда приходит баннер

Руководство Google по баннерам для плагина Flutter загружает рекламу и добавляет её в дерево только в `onAdLoaded`. Код отображения защищён условием `if (_bannerAd != null)`, а размер контейнера берётся из `_bannerAd!.size`. Пока не завершится сетевой запрос, слот баннера имеет нулевую высоту. Когда реклама приходит, слот увеличивается, тело `Scaffold` уменьшается на ту же величину, и всё, на что пользователь смотрел у нижнего края, смещается.

Сейчас этот сдвиг заметнее, чем раньше, по двум причинам:

1. **Большие закреплённые адаптивные баннеры высокие.** Начиная с `google_mobile_ads` 8.0.0 метод `getCurrentOrientationAnchoredAdaptiveBannerAdSize` объявлен устаревшим в пользу `getLargeAnchoredAdaptiveBannerAdSize`. Руководство Google описывает большой вариант как "up to 20% of screen height, between 50 and 150 dp". На типичном телефоне это примерно вдвое больше прежней полосы в 50-64 dp.
2. **Реклама приходит поздно.** Запрос уходит после `MobileAds.instance.initialize()`, аукциона и загрузки креатива. При холодном запуске это секунды, а не кадры, и как раз тогда пользователи начинают читать или нажимать.

## Измерение сдвига

Чтобы получить реальные цифры, я собрал пробное приложение: `Scaffold`, тело которого представляет собой `ListView` внутри `LayoutBuilder`, записывающего в журнал каждое изменение высоты тела, а баннер находится в `bottomNavigationBar`. Эмулятор имел экран 1080x2400 при 420 dpi, что Flutter видит как 411.43 x 914.29 логических пикселей. Использовался официальный тестовый блок адаптивного баннера `ca-app-pub-3940256099942544/9214589741` и релизная сборка.

Сначала высоты, которые SDK возвращает для разных ширин (все значения в dp):

| Запрошенная ширина | Большой закреплённый (текущая ориентация) | Большой, альбомная | Стандартный закреплённый (устарел) |
|---|---|---|---|
| 320 | 100 | 82 | 50 |
| 360 | 113 | 82 | 56 |
| 411 | 128 | 82 | 64 |
| 412 | 129 | 82 | 64 |
| 600 | 150 | 82 | 77 |
| 800 | 150 | 82 | 90 |

В портретной ориентации большой размер следует пропорции 320x50, увеличенной до 320x100, и ограничен значением 150. В альбомной ориентации он зафиксирован на 82, то есть на 20% от альбомной высоты 411 dp. Для всего этого не нужен сетевой вызов: размер вычисляется на устройстве и определяется за несколько миллисекунд.

Теперь хронология высоты тела для шаблона из руководства и для зарезервированного слота:

| Шаблон | Первый реальный кадр | Изменение высоты тела | Когда |
|---|---|---|---|
| Ничего не рисовать до `onAdLoaded` | 302 мс | 914.29 -> 762.29 | 5,338 мс, когда реклама загрузилась |
| Зарезервировать размер, полученный в `didChangeDependencies` | 439 мс | 914.29 -> 762.29 | 448 мс, на кадр позже |
| Зарезервировать размер, высота восстановлена из `shared_preferences` | 546 мс | 0 -> 762.29 сразу | сдвига нет вообще |

Падение на 152 dp складывается из баннера в 128 dp и 24 dp нижнего отступа навигации жестами, который добавляет `SafeArea` под ним. В наивной версии это происходит более чем через пять секунд после появления экрана. Резервирование размера переносит его на кадр сразу после первого, а сохранение высоты устраняет его совсем.

## Шаг 1: получите размер до загрузки чего-либо

Методы размеров в `AdSize` статические и асинхронные, потому что проходят через канал платформы, но от загруженной рекламы не зависят. Вызывайте их, как только `MediaQuery` даст вам ширину:

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

Проверка `width <= 0` нужна не для украшения. В релизной сборке первый `build` выполнился с размером `MediaQuery` 0x0: Android ещё не передал метрики окна. Даже `platformDispatcher.implicitView` в `main()` сообщал `physicalSize` 0 и `devicePixelRatio` 1.0 до `runApp`. Запрос большого закреплённого баннера с шириной 0 вернул `0x100`, а загрузка такого размера завершилась ошибкой `LoadAdError(code: 3, ... "Ad request doesn't meet size requirements")`. Код из руководства отправляет первый запрос из этого кадра с нулевой шириной и срабатывает только потому, что `didChangeDependencies` вызывается снова кадром позже с настоящими метриками.

Перед запросом вычтите горизонтальные отступы безопасной области. Руководство Google по встроенным адаптивным баннерам прямо говорит, что ширина "should take into account the device width and any safe areas that are applicable", а в альбомной ориентации на телефоне с вырезом в дисплее `MediaQuery.paddingOf(context).left` не равен нулю.

## Шаг 2: постройте слот, который сам владеет своей высотой

Слот представляет собой `SizedBox` с зарезервированной высотой, который всегда находится в дереве. `AdWidget` помещается внутрь только после загрузки рекламы, иначе он выбрасывает исключение "AdWidget requires Ad.load to be called before AdWidget is inserted into the tree".

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

Несколько важных деталей:

- **`width != _width` после каждого `await`.** Поворот экрана меняет ширину, пока выполняется запрос размера или `dispose()`. Без этой проверки устаревший портретный запрос может перезаписать альбомный слот.
- **`ad != _ad` в `onAdLoaded`.** Если виджет уже перешёл к более новому запросу, запоздавшая реклама уничтожается, а не показывается.
- **`SafeArea(top: false)` снаружи зарезервированного контейнера.** Слот находится в `bottomNavigationBar`, поэтому он сам должен поглощать нижний отступ. Когда для приложений с таргетом Android 15 и новее принудительно включён режим edge-to-edge, этот отступ больше не вычитается за вас.
- **`Center` вокруг `AdWidget`.** В документации плагина для iOS сказано, что виджету нужен родитель "with a specified width and height", иначе реклама может не показаться. Внутренний `SizedBox` задаёт ему ровно запрошенный размер.

Использование сводится к одной строке в `Scaffold`:

```dart
// Flutter 3.44.8, google_mobile_ads 9.1.0
Scaffold(
  body: const ArticleList(),
  bottomNavigationBar: const AnchoredBannerSlot(
    adUnitId: 'ca-app-pub-3940256099942544/9214589741', // test unit
  ),
);
```

## Шаг 3: сохраните высоту, чтобы первый кадр был правильным

Шаг 2 всё же оставляет зазор в один кадр при холодном запуске: первый кадр с реальной шириной отрисовывается раньше, чем отвечает канал платформы. В измерениях этот зазор составлял от 9 до 70 мс, что обычно приходится на момент, пока первый контент ещё отрисовывается, но это всё равно сдвиг, и он виден в записях экрана.

Решение в том, что высота закреплённого баннера является чистой функцией устройства и ширины. В документации Google сказано, что оптимальная высота "remains constant across different ad requests". Значит, последний ответ SDK служит отличной первой догадкой для следующего запуска:

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

Слот уже читает `BannerHeightCache.lookup(width)` в `didChangeDependencies`, поэтому при втором запуске первый реальный кадр строится с контейнером в 128 dp, и тело сразу переходит от 0 к итоговым 762.29 dp. Живой запрос по-прежнему выполняется и перезаписывает кешированное значение, так что неверная догадка (новая версия ОС, другой размер отображения) стоит одного сдвига, после чего всё исправляется само. Карта в памяти помогает и в пределах одной сессии: второй экран с баннером получает высоту синхронно.

Не пытайтесь вычислять высоту самостоятельно по таблице выше. Соотношение 100/320 и ограничения представляют собой наблюдаемое поведение SDK, а не документированный контракт, и Google уже менял адаптивные размеры раньше. Кеширование ответа SDK даёт ту же точность первого кадра без ставки на формулу.

## Шаг 4: решите, что делать, если реклама не пришла

При зарезервированном слоте неудачная загрузка оставляет пустую полосу внизу. У вас есть два честных варианта:

1. **Оставить полосу.** Макет никогда не двигается, а следующий запрос (при навигации, по таймеру или через автоматическое обновление AdMob, если вы его настроили) заполнит её. Именно так работает виджет выше.
2. **Схлопнуть полосу.** Вы возвращаете себе место ценой ровно одного сдвига макета, и перед следующей попыткой нужно снова зарезервировать место.

Для баннера, закреплённого снизу, я предпочитаю первый вариант. Пользователи очень быстро перестают воспринимать пустую полосу в 128 dp как "отсутствующую", но никогда не перестают замечать список, прыгающий под пальцем. Если вы всё же схлопываете, анимируйте это через `AnimatedSize`, чтобы изменение хотя бы выглядело намеренным.

## Тестовая реклама оказалась меньше слота

Ещё одна вещь, которую показал пробный запуск. После `onAdLoaded` метод `BannerAd.getPlatformAdSize()` сообщил `411x64` для рекламы, запрошенной как `411x128`. Тестовый креатив имеет высоту стандартного баннера. Нативное представление центрировало его внутри запроса в 128 dp, и отрисовка `AdWidget` в 128 dp или в платформенном размере выглядела одинаково. Не уменьшайте слот до платформенного размера после загрузки: это сдвиг макета в обратную сторону, а следующее обновление вполне может вернуть креатив полной высоты.

## Встроенные адаптивные баннеры в прокручиваемом контенте

Встроенные адаптивные баннеры представляют собой второе семейство адаптивных, предназначенное для размещения внутри ленты. Их высоту выбирает сервер, поэтому `AdSize.getCurrentOrientationInlineAdaptiveBannerAdSize(width)` возвращает размер с высотой 0, а настоящую высоту вы узнаёте из `getPlatformAdSize()` только после загрузки. Пример Google решает это так: до загрузки рисует пустой `Container()`, а затем задаёт размер контейнера, из-за чего сдвигается каждый элемент ниже.

Зарезервировать неизвестную высоту нельзя, но её можно ограничить. Используйте `AdSize.getInlineAdaptiveBannerAdSize(width, maxHeight)` и резервируйте `maxHeight`:

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

Платой за это служат поля сверху и снизу, когда креатив ниже `maxHeight`. Если в вашем дизайне это выглядит неправильно, альтернатива состоит в том, чтобы начинать запрос заблаговременно, до того как элемент попадёт в область видимости (`ListView` строит элементы в пределах `cacheExtent` от области просмотра, по умолчанию 250 пикселей), и смириться с тем, что сдвиг выше области просмотра меняет позицию прокрутки. Google также предупреждает, что встроенные баннеры в прокручиваемых областях могут работать медленно на Android 9 и ниже, тогда как закреплённые баннеры этого не касается.

## Подводные камни

- **Один `BannerAd`, один `AdWidget`.** Повторное использование объекта рекламы в двух местах выбрасывает исключение "This AdWidget is already in the Widget tree". Каждый слот владеет собственной рекламой.
- **`getLargeAnchoredAdaptiveBannerAdSize` может вернуть `null`.** Плагин возвращает `null`, когда SDK не может определить высоту для окна. Тогда слот ничего не рисует, что равносильно отсутствию рекламы.
- **Не используйте устаревшие размеры, чтобы "сэкономить место".** `getCurrentOrientationAnchoredAdaptiveBannerAdSize` всё ещё работает в 9.1.0 и даёт 64 dp вместо 128 при ширине 411 dp, но он устарел, а Google оптимизирует именно большой формат.
- **Смена ориентации означает новый запрос.** Ширина меняется, слот сразу резервирует новую высоту (в альбомной ориентации на этом устройстве это 82 dp), и для неё загружается новая реклама. Этот сдвиг вызван самим поворотом, поэтому он ожидаем.
- **Горячая перезагрузка скрывает ошибку первого кадра.** Первый кадр с нулевой шириной появляется только при холодном запуске. Проверяйте зарезервированный слот через `flutter run --release` после принудительной остановки, а не после горячего перезапуска.
- **Релизная сборка может упасть ещё до выполнения вашего кода рекламы.** В пробном приложении R8 удалил `androidx.work.impl.WorkDatabase`, который рекламный SDK подтягивает через WorkManager, и приложение завершилось с ошибкой "Failed to create an instance of androidx.work.impl.WorkDatabase". Отключение минификации (`isMinifyEnabled = false`) исправило это в пробном приложении; более точечное решение представляет собой правило ProGuard keep для классов базы данных WorkManager. Если ваша релизная сборка падает, а отладочная нет, загляните в `adb logcat`, прежде чем винить код баннера.

Если вы также показываете баннеры из .NET MAUI, то же рассуждение применимо и там: [руководство по AdMob для MAUI с баннерами, межстраничной и вознаграждаемой рекламой](/2026/07/monetize-a-net-maui-app-with-admob-banner-interstitial-rewarded/) использует нативные представления, у которых есть те же API определения размера до загрузки.

## Связанные материалы

- [Fix: Flutter UI overlaps the Android system navigation bar after targeting SDK 35](/ru/2026/08/fix-flutter-ui-overlaps-the-android-navigation-bar-after-targeting-sdk-35/) объясняет нижний отступ, который должен поглощать слот баннера.
- [How to use BuildContext safely after an await in Flutter](/ru/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) рассматривает проверки `mounted`, которые слот выполняет после каждого асинхронного шага.
- [How to profile jank in a Flutter app with DevTools](/ru/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) поможет убедиться, что платформенное представление не отнимает у вас кадры после появления баннера.
- [Monetize a .NET MAUI app with AdMob banners, interstitials and rewarded ads](/2026/07/monetize-a-net-maui-app-with-admob-banner-interstitial-rewarded/) описывает ту же настройку AdMob со стороны MAUI.

## Источники

- [Set up banner ads (Flutter)](https://developers.google.com/admob/flutter/banner) для большого закреплённого адаптивного размера, идентификаторов тестовых рекламных блоков и замечания о размерах на iOS.
- [Use inline adaptive for scrolling banners (Flutter)](https://developers.google.com/admob/flutter/banner/inline-adaptive) для `getInlineAdaptiveBannerAdSize` и `getPlatformAdSize`.
- [Set up banner ads (Android)](https://developers.google.com/admob/android/banner/anchored-adaptive) для диапазона больших адаптивных баннеров от 50 до 150 dp, 20% высоты экрана.
- [google_mobile_ads on pub.dev](https://pub.dev/packages/google_mobile_ads) и его [changelog](https://pub.dev/packages/google_mobile_ads/changelog), включая устаревания в 8.0.0.
- [shared_preferences on pub.dev](https://pub.dev/packages/shared_preferences).
