---
title: "Как запретить ImageIcon окрашивать иконку цветом окружающего IconTheme во Flutter"
description: "ImageIcon превращает многоцветный PNG в плоский силуэт, потому что всегда применяет ColorFilter.mode(iconThemeColor, BlendMode.srcIn). Во Flutter 3.47 появился флаг useOriginalColors, который это отключает. Разбираем, почему color: null никогда не работал, что useOriginalColors молча отбрасывает и чем заменить виджет на старых SDK."
pubDate: 2026-09-08
template: how-to
tags:
  - "flutter"
  - "dart"
  - "material-design"
  - "how-to"
lang: "ru"
translationOf: "2026/09/how-to-stop-imageicon-from-tinting-an-icon-with-the-icontheme-color-in-flutter"
translatedBy: "claude"
translationDate: 2026-09-08
---

`ImageIcon` передаёт изображение виджету `Image` с параметром `color: IconTheme.of(context).color`, а объект отрисовки превращает это в `ColorFilter.mode(color, BlendMode.srcIn)`, который отбрасывает RGB каждого пикселя и оставляет только альфа-канал. Многоцветный фирменный знак выходит плоским силуэтом, обычно чёрным или белым. Начиная с Flutter 3.47 решение состоит из одного аргумента: `ImageIcon(AssetImage('assets/logo.png'), useOriginalColors: true)`. Передача `color: null` не даёт ничего и никогда не давала, потому что `IconTheme.of` по контракту обязан вернуть конкретный цвет и откатывается к непрозрачному чёрному. В 3.44 и более старых версиях флага нет, поэтому виджет заменяется обычным `Image`, а четыре аргумента компоновки ImageIcon воспроизводятся вручную. Всё изложенное ниже нацелено на текущий стабильный канал, Flutter 3.47.2 с Dart 3.13.2.

## Почему color: null не отключает окрашивание

Весь виджет занимает около тридцати строк. Вот `build` в том виде, в котором он поставляется в 3.47:

```dart
// package:flutter/src/widgets/image_icon.dart, Flutter 3.47.2
@override
Widget build(BuildContext context) {
  final IconThemeData iconTheme = IconTheme.of(context);
  final double? iconSize = size ?? iconTheme.size;

  if (image == null) {
    return Semantics(
      label: semanticLabel,
      child: SizedBox(width: iconSize, height: iconSize),
    );
  }

  final double? iconOpacity = iconTheme.opacity;
  Color iconColor = color ?? iconTheme.color!;

  if (iconOpacity != null && iconOpacity != 1.0) {
    iconColor = iconColor.withOpacity(iconColor.opacity * iconOpacity);
  }

  return Semantics(
    label: semanticLabel,
    child: Image(
      image: image!,
      width: iconSize,
      height: iconSize,
      color: useOriginalColors ? null : iconColor,
      fit: BoxFit.scaleDown,
      excludeFromSemantics: true,
    ),
  );
}
```

Ключевая строка здесь `Color iconColor = color ?? iconTheme.color!`. Этот `!` не оптимизм, а гарантия, которую `IconTheme.of` даёт явно. Поиск разрешает ближайший окружающий `IconTheme`, проверяет, конкретен ли результат, и если нет, заполняет каждое null-поле из `IconThemeData.fallback()`:

```dart
// package:flutter/src/widgets/icon_theme.dart, Flutter 3.47.2
static IconThemeData of(BuildContext context) {
  final IconThemeData iconThemeData = _getInheritedIconThemeData(context).resolve(context);
  return iconThemeData.isConcrete
      ? iconThemeData
      : iconThemeData.copyWith(
          size: iconThemeData.size ?? const IconThemeData.fallback().size,
          // ...
          color: iconThemeData.color ?? const IconThemeData.fallback().color,
          opacity: iconThemeData.opacity ?? const IconThemeData.fallback().opacity,
          // ...
        );
}
```

А `IconThemeData.fallback()` задаёт `color = const Color(0xFF000000)`. Не существует состояния дерева виджетов, в котором `IconTheme.of(context).color` был бы null. Поэтому комментарий документации, до сих пор висящий на `ImageIcon.color` и утверждающий, что без `IconTheme` виджет "defaults to not recolorizing the image", описывает поведение, которого у виджета давно нет. Без какой-либо окружающей темы вы получаете непрозрачный чёрный, ровно тот результат, о котором сообщают словами "моя цветная иконка отрисовывается чёрным пятном".

Другая инстинктивная попытка, `color: Colors.transparent`, ещё хуже. `BlendMode.srcIn` накладывает цвет источника на альфа-канал приёмника, поэтому полностью прозрачный источник даёт полностью прозрачный результат: иконка исчезает вместо того, чтобы показать собственные цвета. На уровне темы тоже не за что зацепиться, потому что выразить "без цвета" в `IconThemeData`, который `IconTheme.of` вернёт нетронутым, нельзя.

## Воспроизведение: один PNG и три места, где он сереет

Любой виджет Material, владеющий своим слотом для иконки, устанавливает над этим слотом `IconTheme`, поэтому один и тот же ресурс уплощается в каждом из них. Код работает на 3.47 как есть; замените импорт на `package:flutter/material.dart`, если вы ещё не выполнили переход на [отдельные пакеты material_ui и cupertino_ui](/ru/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/).

```dart
// Flutter 3.47.2, Dart 3.13.2
import 'package:material_ui/material_ui.dart';

const AssetImage brandMark = AssetImage('assets/brand/logo.png');

class TintDemo extends StatelessWidget {
  const TintDemo({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Tinting'),
        // Flattened to ColorScheme.onSurface.
        actions: const <Widget>[ImageIcon(brandMark)],
      ),
      body: Column(
        children: <Widget>[
          // Flattened to the button's resolved foreground color.
          ElevatedButton.icon(
            onPressed: () {},
            icon: const ImageIcon(brandMark),
            label: const Text('Open'),
          ),
          // Flattened to ListTileThemeData.iconColor.
          const ListTile(
            leading: ImageIcon(brandMark),
            title: Text('Account'),
          ),
          // Not flattened: no IconTheme is being applied to raw images.
          const Image(image: brandMark, width: 24, height: 24),
        ],
      ),
    );
  }
}
```

Последняя строка и есть подсказка. Тот же ресурс, тот же размер, никакого цветового фильтра, правильные цвета. С PNG всё в порядке, и с разрешением ресурса тоже, хотя именно это подозревают первым делом, когда изображение выглядит неправильно; тот сценарий сбоя выглядит совершенно иначе и разобран в статье [unable to load asset во Flutter после добавления изображения в pubspec.yaml](/ru/2026/07/fix-unable-to-load-asset-in-flutter-after-adding-an-image-to-pubspec-yaml/).

## Шаги перевода ImageIcon на исходные цвета

1. Проверьте SDK командой `flutter --version`. Флаг `useOriginalColors` появился в [PR 180491](https://github.com/flutter/flutter/pull/180491) 2026-04-27 и вышел в стабильном релизе Flutter 3.47. На всём, что старше, переходите к ручной замене ниже.
2. Уберите аргумент `color` из места вызова. Конструктор проверяет ассертом, что `color` равен null, когда `useOriginalColors` истинно, так что оставить оба параметра означает жёсткую ошибку.
3. Добавьте `useOriginalColors: true`. Это всё изменение: `build` передаёт `color: null` в `Image`, никакой `ColorFilter` на объект отрисовки не ставится, и декодированные пиксели доходят до холста нетронутыми.
4. Перепроверьте каждый зависящий от состояния вариант этой иконки. Выбранное, невыбранное, отключённое и нажатое состояния выражаются разными цветами `IconThemeData`, а вы только что отказались от всех сразу.
5. Решите, чем теперь передаётся вид отключённого элемента. Если виджет полагался на полупрозрачный цвет окрашивания, чтобы выглядеть приглушённым, оберните иконку в `Opacity` или подготовьте отдельный обесцвеченный ресурс.

Готовое место вызова:

```dart
// Flutter 3.47.2, Dart 3.13.2
const ImageIcon(
  AssetImage('assets/brand/logo.png'),
  useOriginalColors: true,
  semanticLabel: 'Acme',
)
```

Размер по-прежнему берётся из окружающего `IconTheme`, поэтому иконка остаётся выровненной с соседними виджетами `Icon`. Исчезает только цветовой фильтр.

## Что useOriginalColors отбрасывает вместе с окрашиванием

Посмотрите ещё раз на две значимые строки `build`:

```dart
if (iconOpacity != null && iconOpacity != 1.0) {
  iconColor = iconColor.withOpacity(iconColor.opacity * iconOpacity);
}
// ...
color: useOriginalColors ? null : iconColor,
```

`IconTheme.opacity` сворачивается в альфа-канал цвета окрашивания, и этот цвет остаётся единственным каналом, через который прозрачность доходит до изображения. Поставьте `useOriginalColors: true`, и весь вычисленный `iconColor` отбрасывается вместе с прозрачностью. Предок, приглушающий своё поддерево через `IconTheme(data: IconThemeData(opacity: 0.38), ...)`, приглушит все окружающие `Icon` и оставит ваше изображение в полную силу.

То же касается полупрозрачных цветов окрашивания, а именно так Material сегодня и выражает отключённые иконки. Значения по умолчанию `NavigationBar` разрешают отключённое состояние в `onSurfaceVariant` с альфой 38 процентов, и эта альфа проходит через `srcIn` в отрисованный результат. Откажитесь от фильтра, и отключённое направление будет выглядеть доступным.

Если окружающая прозрачность нужна обратно, прочитайте её и примените сами:

```dart
// Flutter 3.47.2, Dart 3.13.2
class BrandIcon extends StatelessWidget {
  const BrandIcon({super.key, required this.image});

  final ImageProvider image;

  @override
  Widget build(BuildContext context) {
    final double opacity = IconTheme.of(context).opacity ?? 1.0;
    final Widget icon = ImageIcon(image, useOriginalColors: true);
    return opacity == 1.0 ? icon : Opacity(opacity: opacity, child: icon);
  }
}
```

`Opacity` создаёт настоящий слой композиции и стоит недёшево, поэтому защиту от распространённого случая `1.0` имеет смысл сохранить вместо безусловной обёртки.

## Замена для версий до 3.47

Флаг перенести назад нельзя, и никакая комбинация значений `color` того же результата не даёт, поэтому в 3.44 и старше от `ImageIcon` просто отказываются. Замена короткая, потому что сам ImageIcon короткий: сохранить стоит получение размера, `BoxFit.scaleDown` и разделение семантики, при котором метка живёт на обёртке, а изображение исключается из дерева.

```dart
// Flutter 3.44 or older. Drop-in for ImageIcon that keeps the image's colors.
import 'package:flutter/widgets.dart';

class OriginalColorImageIcon extends StatelessWidget {
  const OriginalColorImageIcon(
    this.image, {
    super.key,
    this.size,
    this.semanticLabel,
  });

  final ImageProvider image;
  final double? size;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final double? iconSize = size ?? IconTheme.of(context).size;
    return Semantics(
      label: semanticLabel,
      child: Image(
        image: image,
        width: iconSize,
        height: iconSize,
        fit: BoxFit.scaleDown,
        excludeFromSemantics: true,
      ),
    );
  }
}
```

Две детали легко потерять, если вместо этого вставить голый `Image.asset`. `BoxFit.scaleDown` никогда не увеличивает: ресурс, чей собственный размер меньше рамки иконки, остаётся в своём размере и центрируется, ровно как ведёт себя `ImageIcon`, и это избавляет от размытия, которое внёс бы `BoxFit.contain`. А `excludeFromSemantics: true` на внутреннем `Image` не даёт дереву доступности нести одновременно метку обёртки и метку самого изображения, и `ImageIcon` делает то же самое по той же причине.

## Какие виджеты устанавливают тот самый IconTheme

| Виджет | Что он кладёт в окружающий IconTheme |
| --- | --- |
| `AppBar`, `SliverAppBar` | `iconTheme` для leading-виджета и `actionsIconTheme` для действий, по умолчанию `ColorScheme.onSurface` |
| `ElevatedButton.icon` и остальные варианты `ButtonStyleButton` | `AnimatedTheme`, чей `iconTheme` объединён с разрешённым цветом переднего плана и размером иконки |
| `IconButton` | разрешённый цвет переднего плана для текущего состояния виджета |
| `NavigationBar`, `NavigationRail` | `WidgetStateProperty<IconThemeData>`, разрешаемый отдельно для выбранного, невыбранного и отключённого состояний |
| `BottomNavigationBar` | цвета выбранного и невыбранного элемента |
| `ListTile` | `ListTileThemeData.iconColor` или цвет отключённого состояния при `enabled: false` |
| `Chip` и его варианты | собственная тема иконок чипа |
| `TabBar` | `labelColor` и `unselectedLabelColor` |

Именно поэтому регулярно заводимый баг-репорт, самый известный из которых [flutter/flutter#81643](https://github.com/flutter/flutter/issues/81643), закрывают как невалидный. Виджет делает ровно то, что и должен делать виджет иконки. Система тем Material исходит из того, что иконки представляют собой монохромные силуэты, которые ей разрешено перекрашивать, и на том же допущении построен способ, которым [ColorScheme из Material 3 задаёт акцентные цвета во Flutter-приложении](/ru/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/).

## Выбранному и невыбранному направлению нужны два отдельных виджета

`NavigationBar` не подменяет одну иконку другой. Он строит обе, оборачивает каждую в собственный `IconTheme.merge` и плавно смешивает их в `Stack`:

```dart
// package:flutter/src/material/navigation_bar.dart, Flutter 3.47.2
final Widget selectedIconWidget = IconTheme.merge(
  data: enabled ? selectedIconTheme : disabledIconTheme,
  child: selectedIcon ?? icon,
);
final Widget unselectedIconWidget = IconTheme.merge(
  data: enabled ? unselectedIconTheme : disabledIconTheme,
  child: icon,
);
```

Поскольку `icon` используется и для невыбранного слота, и для выбранного, когда `selectedIcon` равен null, один виджет с `useOriginalColors: true` отключает окрашивание сразу в обоих состояниях. Если фирменные цвета нужны только у активного направления, передайте два виджета:

```dart
// Flutter 3.47.2, Dart 3.13.2
NavigationDestination(
  icon: const ImageIcon(AssetImage('assets/brand/logo_mono.png')),
  selectedIcon: const ImageIcon(
    AssetImage('assets/brand/logo.png'),
    useOriginalColors: true,
  ),
  label: 'Acme',
)
```

Монохромный ресурс в невыбранном слоте по-прежнему окрашивается, и это то, что нужно: он следует за темой, как любое другое направление, а полноцветный знак появляется только при выборе.

## Что стоит знать перед выкаткой

**Ассерт это проверка режима debug, а не ошибка компиляции, если вы сами её таковой не сделаете.** У `ImageIcon` есть `const`-конструктор, поэтому `const ImageIcon(image, useOriginalColors: true, color: Colors.red)` вычисляется на этапе компиляции и отвергается анализатором сразу. Записанное без `const`, оно бросает исключение только в сборках debug и profile. В release ассерт вырезается, `build` всё так же вычисляет `useOriginalColors ? null : iconColor`, и ваш цвет молча игнорируется. В таких местах вызова лучше использовать `const`.

**У `Icon` аналога нет, и он не нужен.** Шрифтовые иконки это контуры одного глифа; сохранять там нечего. Если нужен многоцветный глиф, нужно изображение или вектор, а не `IconFont`.

**`flutter_svg` работает наоборот.** `SvgPicture.asset` вообще не читает `IconTheme`, поэтому SVG по умолчанию сохраняет свои цвета, а окрашивание подключается явным `colorFilter: ColorFilter.mode(IconTheme.of(context).color!, BlendMode.srcIn)`. Если ваш SVG неожиданно монохромный, ищите жёстко прописанный в файле `fill`, а не окружающую тему.

**Проверяйте это виджет-тестом, а не разглядыванием скриншота.** Отрисованные пиксели проверять тяжело, а конфигурацию виджета легко:

```dart
// Flutter 3.47.2, Dart 3.13.2
testWidgets('brand mark ignores the ambient icon color', (WidgetTester tester) async {
  await tester.pumpWidget(
    const IconTheme(
      data: IconThemeData(color: Color(0xFFFF0000)),
      child: Directionality(
        textDirection: TextDirection.ltr,
        child: ImageIcon(
          AssetImage('assets/brand/logo.png'),
          useOriginalColors: true,
        ),
      ),
    ),
  );

  expect(tester.widget<Image>(find.byType(Image)).color, isNull);
});
```

Golden-тест регрессию тоже поймает, но этот падает с читаемым сообщением и не зависит от того, корректно ли ведёт себя бандл ресурсов.

**Поставляйте правильную плотность.** `BoxFit.scaleDown` не увеличивает, поэтому слоту иконки в 24 логических пикселя на устройстве 3x нужен ресурс на 72 пикселя в `assets/brand/3.0x/`. Единственный PNG на 24 пикселя, который выглядел нормально, пока его уплощали до силуэта, станет заметно мыльным, как только вы увидите его настоящие пиксели.

### Читайте дальше

- [Перевод импортов Material и Cupertino во Flutter на пакеты material_ui и cupertino_ui](/ru/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/)
- [Как задать акцентный цвет во Flutter через ColorScheme из Material 3](/ru/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/)
- [Fix: unable to load asset во Flutter после добавления изображения в pubspec.yaml](/ru/2026/07/fix-unable-to-load-asset-in-flutter-after-adding-an-image-to-pubspec-yaml/)
- [Fix: cannot provide both a color and a decoration в Container во Flutter](/ru/2026/07/fix-cannot-provide-both-a-color-and-a-decoration-in-a-flutter-container/)
- [Что такое Key во Flutter и когда его отсутствие приводит к ошибкам?](/ru/2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs/)

### Источники

- [Класс ImageIcon, справочник API Flutter](https://api.flutter.dev/flutter/widgets/ImageIcon-class.html)
- [Added useOriginalColors flag which allows ImageIcon to bypass IconTheme colorization, flutter/flutter PR 180491](https://github.com/flutter/flutter/pull/180491)
- [Примечания к релизу Flutter 3.47.0](https://docs.flutter.dev/release/release-notes/release-notes-3.47.0)
- [IconTheme.of, справочник API Flutter](https://api.flutter.dev/flutter/widgets/IconTheme/of.html)
- [BlendMode.srcIn, справочник API dart:ui](https://api.flutter.dev/flutter/dart-ui/BlendMode.html)
- [ImageIcon displays a colourful icon as black & white, flutter/flutter issue 81643](https://github.com/flutter/flutter/issues/81643)
