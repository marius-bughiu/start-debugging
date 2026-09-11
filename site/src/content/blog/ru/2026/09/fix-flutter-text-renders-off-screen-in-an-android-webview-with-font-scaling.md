---
title: "Исправление: Text во Flutter рисуется за пределами экрана в Android WebView при включённом системном масштабе шрифта"
description: "Flutter web с 3.41 по 3.44 сообщает о переопределении высоты строки примерно в 625 раз, когда textZoom в Android WebView не равен 100. Обновитесь до 3.47 или сбросьте переопределение в MaterialApp.builder."
pubDate: 2026-09-11
template: error-page
tags:
  - "errors"
  - "flutter"
  - "flutter-web"
  - "android"
  - "accessibility"
lang: "ru"
translationOf: "2026/09/fix-flutter-text-renders-off-screen-in-an-android-webview-with-font-scaling"
translatedBy: "claude"
translationDate: 2026-09-11
---

Если ваше веб-приложение на Flutter работает внутри Android `WebView` и каждый обычный `Text` исчезает, как только пользователь меняет системный размер шрифта, это известная ошибка веб-движка. Во Flutter с 3.41.0 по 3.44.9 он ошибочно принимает `textZoom` из WebView за пользовательскую настройку высоты строки. `MediaQuery.lineHeightScaleFactorOverride` возвращает примерно `624.9`, поэтому строка высотой 18 px раскладывается высотой около 12 900 px, и её глифы рисуются далеко ниже области просмотра. Обновитесь до Flutter 3.47.0 или новее (текущая стабильная версия 3.47.3), где код обнаружения переписан. На старых версиях сбросьте ложное переопределение в `MaterialApp.builder`. Если Android-хост под вашим контролем, можно также зафиксировать `textZoom` на 100.

Статья рассматривает Flutter 3.44.8 (Dart 3.12.2), то есть версию из отчёта об ошибке, и сравнивает её с исходным кодом движка 3.47.3. Поведение на уровне виджетов, описанное ниже, воспроизведено с помощью `flutter test` на 3.44.8.

## Как выглядит сломанный экран

Нет ни исключения, ни ошибки в консоли. Веб-шрифты загружаются с HTTP 200, событие `flutter-first-frame` срабатывает, и планировщик продолжает работать. Все симптомы геометрические:

- Все виджеты `Text` невидимы, при этом иконки, рамки, изображения и фоны `Container` по-прежнему рисуются.
- Всё, что находится ниже первого `Text` в `Column`, тоже пропадает, потому что раздутый текст сдвигает это на тысячи пикселей вниз.
- Панели фиксированной высоты, такие как `NavigationBar`, обрезают свои подписи, а `TextField` растягиваются до своего `maxHeight`.
- В режиме release некоторые маршруты заменяются серым `ErrorWidget`. В отладочной сборке ожидайте [переполнение RenderFlex](/ru/2026/05/fix-renderflex-overflowed-in-flutter/), измеряемое тысячами пикселей, а не обычными несколькими пикселями за краем.

Условие срабатывания очень конкретное. Та же сборка нормально отображается в настольном Chrome, в браузере Chrome на том же телефоне, в GeckoView и в WebView на стандартном эмуляторе с настройками по умолчанию. Она ломается только в Android System WebView, у которого `textZoom` не равен ровно 100. Системный ползунок размера шрифта в Settings > Accessibility автоматически задаёт это значение для любого WebView, который его не переопределяет.

Вывод значений `MediaQuery` изнутри приложения всё проясняет. В [flutter/flutter#190350](https://github.com/flutter/flutter/issues/190350) автор отчёта запустил стандартное приложение из `flutter create` на Flutter 3.44.8 и менял только `adb shell settings put system font_scale`:

```text
font_scale  textZoom  lineHeightScaleFactorOverride  textScaler  Text visible
0.85        85        624.9374824709756              0.85        no
1.0         100       null                           1.0         yes
1.15        115       624.9347955648752              1.15        no
1.3         130       624.9375229225718              1.3         no
```

`textScaler` корректен на каждом шаге. `lineHeightScaleFactorOverride` равен `null` при 100 и примерно 624.94 при любом другом уровне масштаба, независимо от того, стал текст меньше или больше. Значение, которое не меняется, в какую бы сторону ни двигались входные данные, не является измерением. Это просочившееся сторожевое значение.

## Почему веб-движок сообщает о высоте строки в 625 раз больше

Начиная с Flutter 3.41 веб-движок поддерживает настройки [межстрочного и межбуквенного интервала WCAG 1.4.12](https://www.w3.org/WAI/WCAG21/Understanding/text-spacing.html), которые применяют расширения браузера и пользовательские таблицы стилей. Эту поддержку добавил [PR #178081](https://github.com/flutter/flutter/pull/178081). Flutter рисует текст на холсте, поэтому не может прочитать эти CSS-переопределения из собственного содержимого. Вместо этого `EnginePlatformDispatcher._addTypographySettingsObserver` добавляет в `document.body` скрытый элемент-зонд `<p>` с намеренно абсурдными встроенными стилями и отслеживает его через `ResizeObserver`. В 3.44.8 соответствующая часть `engine/src/flutter/lib/web_ui/lib/src/engine/platform_dispatcher.dart` выглядит так:

```dart
// Flutter 3.44.8, lib/web_ui/lib/src/engine/platform_dispatcher.dart (abridged)
const spacingDefault = 9999.0;
_typographyMeasurementElement!.style
  ..lineHeight = '${spacingDefault}px'
  ..letterSpacing = '${spacingDefault}px'
  ..wordSpacing = '${spacingDefault}px'
  ..margin = '0px 0px ${spacingDefault}px 0px';
domDocument.body!.append(_typographyMeasurementElement!);
final double typographyMeasurementElementFontSize =
    parseFontSize(_typographyMeasurementElement!)?.toDouble() ?? _defaultRootFontSize;
final double defaultLineHeightFactor = spacingDefault / typographyMeasurementElementFontSize;

// Inside the ResizeObserver callback:
final double? computedLineHeightScaleFactor =
    fontSize != null && lineHeight != null && lineHeight != spacingDefault
    ? lineHeight / fontSize
    : null;
_updateLineHeightScaleFactorOverride(
  computedLineHeightScaleFactor == defaultLineHeightFactor
      ? null
      : computedLineHeightScaleFactor,
);
```

Замысел в том, что если ничто за пределами Flutter не трогало зонд, его вычисленный `line-height` по-прежнему равен ровно `9999px`, и переопределение остаётся `null`. Любое другое значение означает пользовательскую настройку, и его отношение к размеру шрифта становится новым коэффициентом высоты строки.

`textZoom` в Android WebView ломает обе проверки. Он масштабирует корневой `font-size`, а также масштабирует пиксельный `line-height` зонда, что вовсе не является пользовательской настройкой. Посчитаем для `textZoom` 115 и корневого размера по умолчанию 16 px:

1. Размер шрифта зонда равен `16 * 1.15 = 18.4px`, поэтому `defaultLineHeightFactor = 9999 / 18.4 = 543.4`.
2. Вычисленный `line-height` равен `9999 * 1.15 = 11498.85px`. Это не `9999`, поэтому движок считает его переопределением.
3. `computedLineHeightScaleFactor = 11498.85 / 18.4 = 624.9375`, что в точности равно `9999 / 16`. Коэффициент масштаба сокращается, и именно поэтому сообщаемое значение почти не меняется между уровнями масштаба.
4. `624.9375` не равно `543.4`, поэтому оно публикуется как `MediaQueryData.lineHeightScaleFactorOverride`.

Фреймворк принимает это значение за чистую монету. `Text.build` читает `MediaQuery.maybeLineHeightScaleFactorOverrideOf(context)` и принудительно записывает его в `TextStyle.height` спана, а при заданном strut ещё и в `StrutStyle.height`, независимо от `inherit`. `TextStyle.height` является множителем размера шрифта, как описано в [статье о leadingDistribution](/ru/2026/01/flutter-text-the-leadingdistribution-detail-that-changes-how-your-ui-breathes/), поэтому строчный блок становится в 625 раз выше глифов. Виджеты, которые напрямую строят `RichText`, например `Icon`, никогда не обращаются к переопределению. Поэтому иконки остаются видимыми на экране, где весь текст пропал.

Это разновидность более ранней ошибки. [#178856](https://github.com/flutter/flutter/issues/178856) описывала то же аномальное значение после изменения размера шрифта браузера во время работы, и [PR #178862](https://github.com/flutter/flutter/pull/178862) исправил её 2 декабря 2025 года. Это исправление по-прежнему сравнивало значение ровно с `9999`, поэтому масштаб, уже активный при первой отрисовке, проходит проверку. Бисекция в обсуждении задачи помещает регрессию между 3.39.0-0.2.pre (исправна) и 3.40.0-0.1.pre (сломана). Среди стабильных релизов сторожевое значение 9999 px присутствует во всех тегах с 3.41.0 по 3.44.9 и отсутствует в 3.38.x.

Рендерер значения не имеет. В обсуждении ошибку воспроизводят с CanvasKit, с CanvasKit, принудительно переведённым на CPU, и со skwasm из сборки [`flutter build web --wasm`](/ru/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/), потому что дефект находится в общем коде на Dart.

## Минимальное воспроизведение

Веб-часть представляет собой стандартное приложение, которое выводит переопределения через `RichText`, чтобы отчёт оставался читаемым, пока ошибка активна:

```dart
// Flutter 3.44.8, web target. Serve build/web and load it in an Android WebView.
import 'package:flutter/material.dart';

void main() => runApp(
      const MaterialApp(home: Scaffold(body: SafeArea(child: Probe()))),
    );

class Probe extends StatelessWidget {
  const Probe({super.key});

  @override
  Widget build(BuildContext context) {
    final mq = MediaQuery.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        RichText(
          text: TextSpan(
            text: 'line=${mq.lineHeightScaleFactorOverride}\n'
                'scale10=${mq.textScaler.scale(10)}',
            style: const TextStyle(fontSize: 15, color: Colors.black),
          ),
        ),
        const Text('PLAIN TEXT', style: TextStyle(fontSize: 18, color: Colors.red)),
      ],
    );
  }
}
```

Соберите его командой `flutter build web --release` и раздайте `build/web`. Затем выполните `adb shell settings put system font_scale 1.15` и откройте страницу в обычном `android.webkit.WebView` с включённым JavaScript. Хосту не нужно вызывать `setTextZoom`, потому что WebView сам подхватывает системный масштаб.

Если устройства нет, половину ошибки, относящуюся к фреймворку, можно воспроизвести в виджет-тесте, передав значение, которое сообщает движок:

```dart
// Flutter 3.44.8, flutter_test
testWidgets('engine-reported override inflates Text', (tester) async {
  await tester.pumpWidget(MaterialApp(
    builder: (context, child) => MediaQuery(
      data: MediaQuery.of(context)
          .copyWith(textScaler: const TextScaler.linear(1.15))
          .applyTextStyleOverrides(
            lineHeightScaleFactorOverride: 624.9375,
            letterSpacingOverride: null,
            wordSpacingOverride: null,
            paragraphSpacingOverride: null,
          ),
      child: child!,
    ),
    home: const Scaffold(
      body: SingleChildScrollView(
        child: Text('plain', key: Key('t'), style: TextStyle(fontSize: 18)),
      ),
    ),
  ));
  debugPrint('${tester.getSize(find.byKey(const Key('t'))).height}');
});
```

На 3.44.8 этот тест выводит `12936.0`, то есть ту же высоту строки 12 936 px, которую автор отчёта измерил в настоящем WebView.

## Исправление 1: обновиться до Flutter 3.47

[PR #186474](https://github.com/flutter/flutter/pull/186474), слитый 19 мая 2026 года, переписал логику зонда. Он создавался для ошибки Safari с настройкой "никогда не использовать шрифты меньше" ([#185931](https://github.com/flutter/flutter/issues/185931)), которая через тот же механизм давала тот же раздутый коэффициент. Исправление впервые вышло в 3.46.0-0.1.pre и есть во всех стабильных релизах 3.47. Ветка хотфиксов 3.44.x, включая 3.44.9 от 5 августа 2026 года, его так и не получила. Новый код:

```dart
// Flutter 3.47.3, lib/web_ui/lib/src/engine/platform_dispatcher.dart (abridged)
const spacingDefault = 100.0;
final double defaultLineHeightFactor =
    spacingDefault / (typographyMeasurementElementFontSize / findBrowserTextScaleFactor());

bool isDefault(double? value, double defaultValue) {
  if (value == null) {
    return true;
  }
  return (value - defaultValue).abs() < _typographyPrecisionErrorTolerance ||
      (value - defaultValue * computedTextScaleFactor).abs() <
          _typographyPrecisionErrorTolerance;
}
```

`findBrowserTextScaleFactor()` равен корневому размеру шрифта, делённому на 16, то есть 1.15 при `textZoom` 115. Масштабированная высота строки `100 * 1.15` теперь считается значением "по умолчанию", как и масштабированные межбуквенный интервал, интервал между словами и отступ абзаца. Переопределение остаётся `null`, а `textScaler` по-прежнему сообщает 1.15. Кроме того, сторожевое значение уменьшилось с 9999 px до 100 px, поэтому будущая ошибка обнаружения дала бы коэффициент около 6, а не 625.

Одна оговорка: #190350 всё ещё открыта, и никто в обсуждении не опубликовал результаты теста на устройстве с 3.47. Анализ выше основан на чтении исходного кода, а не на запуске в WebView. После обновления запустите зонд на `RichText` на реальном устройстве при `font_scale` 1.15 и убедитесь, что выводится `line=null`, прежде чем удалять какой-либо обходной путь. Если вы всё равно обновляетесь с 3.44, стоит прочитать об [изменении рендерера для десктопа в 3.47](/ru/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/) ради других платформ вашего приложения.

```bash
flutter upgrade
flutter --version
```

## Исправление 2: сбросить неправдоподобные переопределения в MaterialApp.builder

Если пока нельзя уйти с версий с 3.41 по 3.44 или хост-приложение вам неподконтрольно, исправьте проблему в корне дерева виджетов. `MediaQuery.applyTextStyleOverrides` заменяет четыре переопределения интервалов для всего, что находится ниже. Он устанавливает каждое ровно в то значение, которое вы передали, включая `null`, и сохраняет `textScaler`, поэтому выбранный пользователем размер шрифта по-прежнему применяется.

Обходной путь, опубликованный в задаче, устанавливает все четыре в `null`. Это работает, но заодно отбрасывает настоящие настройки интервалов WCAG, то есть ту самую возможность, ради которой существует зонд. Более узкая защита отбрасывает только значения, которые не может дать ни одна реальная пользовательская настройка:

```dart
// Flutter 3.41.0 to 3.44.9, workaround for flutter/flutter#190350
import 'package:flutter/widgets.dart';

/// Drops text spacing overrides that no real user preference can produce.
Widget sanitizeTextSpacing(BuildContext context, Widget? child) {
  final mq = MediaQuery.of(context);
  double? sane(double? value, double max) =>
      value == null || value.abs() > max ? null : value;

  final lineHeight = sane(mq.lineHeightScaleFactorOverride, 4);
  final letter = sane(mq.letterSpacingOverride, 100);
  final word = sane(mq.wordSpacingOverride, 100);
  final paragraph = sane(mq.paragraphSpacingOverride, 1000);

  if (lineHeight == mq.lineHeightScaleFactorOverride &&
      letter == mq.letterSpacingOverride &&
      word == mq.wordSpacingOverride &&
      paragraph == mq.paragraphSpacingOverride) {
    return child ?? const SizedBox.shrink();
  }
  return MediaQuery.applyTextStyleOverrides(
    lineHeightScaleFactorOverride: lineHeight,
    letterSpacingOverride: letter,
    wordSpacingOverride: word,
    paragraphSpacingOverride: paragraph,
    child: child ?? const SizedBox.shrink(),
  );
}
```

Подключите её в каждый корень приложения:

```dart
// Flutter 3.44.8
MaterialApp(
  builder: sanitizeTextSpacing,
  home: const HomePage(),
);
```

WCAG 1.4.12 требует высоту строки 1.5 и межбуквенный интервал 0.12em, поэтому ограничение коэффициента в 4 и ограничение в 100 px оставляют достаточный запас для реальных настроек. На 3.44.8 я проверил это виджет-тестом. Переопределение `624.9375` превращается в `null`, и `Text` размером 18 px имеет высоту 30 px вместо 12 936 px. Переопределение `1.5` проходит без изменений. `textScaler.scale(10)` возвращает `11.5` в обоих случаях.

Здесь важно несколько деталей:

- **Защита нужна каждому корню.** builder охватывает только свой `MaterialApp`. Если у вас есть отдельные приложения для загрузки, техобслуживания или онбординга со своими `MaterialApp` или `WidgetsApp`, оберните каждое из них.
- **Она отслеживает изменения во время работы.** `MediaQuery.of(context)` подписывается на окружающие данные, поэтому, когда пользователь меняет размер шрифта при открытой странице, движок публикует значения заново, и защита срабатывает снова.
- **`MediaQuery.withNoTextScaling` не помогает.** Он сбрасывает только `textScaler`, который никогда не был проблемой. Ограничение масштаба текста оставляет переопределение высоты строки на месте.
- **После обновления она безвредна.** На 3.47 движок в случае с WebView должен сообщать `null`, поэтому защита возвращает `child` без изменений. Её можно удалить после того, как обновление будет подтверждено на устройстве.

## Исправление 3: зафиксировать textZoom на 100 в Android-хосте

Если нативный хост тоже поставляете вы, можно добиться того, чтобы WebView никогда не передавал системный масштаб шрифта странице. Из трёх исправлений это самое грубое. Веб-содержимое на Flutter вообще перестаёт следовать выбранному пользователем размеру шрифта, потому что `textScaler` остаётся равным 1.0. Используйте его только тогда, когда у веб-приложения есть собственная настройка размера текста.

В хосте на Kotlin:

```kotlin
// Android System WebView, API 14+
webView.settings.javaScriptEnabled = true
webView.settings.textZoom = 100
```

В хосте на Flutter, использующем `webview_flutter` 4.14.1, эта настройка находится в контроллере платформы Android в `webview_flutter_android` 4.14.1:

```dart
// webview_flutter 4.14.1, webview_flutter_android 4.14.1
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

WebViewController buildController(Uri appUrl) {
  final controller = WebViewController()
    ..setJavaScriptMode(JavaScriptMode.unrestricted)
    ..loadRequest(appUrl);

  final platform = controller.platform;
  if (platform is AndroidWebViewController) {
    // Opt out of Android's system font scale for this WebView.
    platform.setTextZoom(100);
  }
  return controller;
}
```

Это также объясняет сообщения о том, что ошибку не удаётся воспроизвести. Согласно обсуждению задачи, хосты на основе `flutter_inappwebview` невосприимчивы к ней, потому что этот плагин по умолчанию устанавливает `textZoom` в 100. Хосты на обычном `android.webkit.WebView` или `webview_flutter` затронуты, как только пользователь сдвигает ползунок шрифта с положения по умолчанию.

## Похожие проблемы, которые не являются этой ошибкой

- **На устройствах Samsung с GPU Xclipse вообще ничего не отображается.** Если иконки и фоны тоже отсутствуют, причём только в CanvasKit, перед вами [#188164](https://github.com/flutter/flutter/issues/188164), регрессия отрисовки ANGLE поверх Vulkan. Она проявляется даже при `textZoom` 100.
- **Огромные промежутки между виджетами в Safari 26.5.** Это [#185931](https://github.com/flutter/flutter/issues/185931). У неё та же первопричина, только через настройку минимального размера шрифта в Safari, и помогают те же исправления.
- **Текст переполняется после `flutter upgrade` на нативных Android или iOS.** Зонд типографики существует только в веб-движке. На мобильных платформах смотрите на `TextScaler` и ограничения вашей разметки. Аксессоры для отдельных аспектов, такие как `MediaQuery.textScalerOf`, которые работают так же, как аксессор, используемый для [чтения радиуса скругления углов экрана во Flutter 3.44](/ru/2026/07/flutter-3-44-read-the-screen-corner-radius-from-mediaquery/), позволяют записать в журнал именно то, что сообщает платформа.

Быстрый способ понять, столкнулись ли вы с этой ошибкой: запишите в журнал `PlatformDispatcher.instance.lineHeightScaleFactorOverride` при запуске. Любое значение выше примерно 3 в вебе означает, что движок неверно прочитал зонд, а не что пользователь об этом просил.

## Связанные материалы

- [Исправление: A RenderFlex overflowed by N pixels во Flutter](/ru/2026/05/fix-renderflex-overflowed-in-flutter/), о полосе в отладочном режиме, которую вызывает эта ошибка.
- [Деталь `leadingDistribution` во Flutter `Text`](/ru/2026/01/flutter-text-the-leadingdistribution-detail-that-changes-how-your-ui-breathes/), о том, как `TextStyle.height` превращается в геометрию строчного блока.
- [Как собрать веб-приложение на Flutter с WebAssembly](/ru/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/), поскольку под skwasm ошибка та же.
- [Flutter 3.47 делает Impeller рендерером по умолчанию на десктопе](/ru/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/), о релизе, в который вошло исправление движка.

## Источники

- [flutter/flutter#190350](https://github.com/flutter/flutter/issues/190350): отчёт о `textZoom` в Android WebView, бисекция и обходные пути.
- [flutter/flutter#178856](https://github.com/flutter/flutter/issues/178856) и [PR #178862](https://github.com/flutter/flutter/pull/178862): первый вариант с изменением размера шрифта во время работы и его частичное исправление.
- [PR #178081](https://github.com/flutter/flutter/pull/178081): поддержка переопределения интервалов текста в вебе, которая добавила зонд.
- [PR #186474](https://github.com/flutter/flutter/pull/186474) и [flutter/flutter#185931](https://github.com/flutter/flutter/issues/185931): устойчивое к масштабу обнаружение, вошедшее в 3.46 и 3.47.
- [`platform_dispatcher.dart` в 3.44.8](https://github.com/flutter/flutter/blob/3.44.8/engine/src/flutter/lib/web_ui/lib/src/engine/platform_dispatcher.dart) и [в 3.47.3](https://github.com/flutter/flutter/blob/3.47.3/engine/src/flutter/lib/web_ui/lib/src/engine/platform_dispatcher.dart).
- Документация API [`MediaQuery.applyTextStyleOverrides`](https://api.flutter.dev/flutter/widgets/MediaQuery/applyTextStyleOverrides.html) и [`MediaQueryData.lineHeightScaleFactorOverride`](https://api.flutter.dev/flutter/widgets/MediaQueryData/lineHeightScaleFactorOverride.html).
- [`WebSettings.setTextZoom`](https://developer.android.com/reference/android/webkit/WebSettings#setTextZoom(int)) и [`AndroidWebViewController.setTextZoom`](https://pub.dev/documentation/webview_flutter_android/latest/webview_flutter_android/AndroidWebViewController/setTextZoom.html).
