---
title: "Flutter Text: деталь `leadingDistribution`, меняющая то, как \"дышит\" ваш UI"
description: "Свойство leadingDistribution в TextHeightBehavior во Flutter управляет тем, как дополнительное leading распределяется над и под глифами. Вот когда это важно и как починить текст, который выглядит вертикально смещённым."
pubDate: 2026-01-18
tags:
  - "dart"
  - "flutter"
lang: "ru"
translationOf: "2026/01/flutter-text-the-leadingdistribution-detail-that-changes-how-your-ui-breathes"
translatedBy: "claude"
translationDate: 2026-04-29
---
Видеотуториал по Flutter, опубликованный 2026-01-16, напомнил мне о тонком, но вполне реальном источнике багов в духе "почему это выглядит криво?": виджет `Text` прост, пока вы не начнёте сочетать кастомные шрифты, плотные межстрочные расстояния и многострочные раскладки.

Источник: [видео](https://www.youtube.com/watch?v=xen-Al9H-4k) и оригинальный [пост на r/FlutterDev](https://www.reddit.com/r/FlutterDev/comments/1qfhug1/how_well_do_you_really_know_the_text_widget/).

## Высота строки - это не только `TextStyle.height`

Во Flutter 3.x разработчики обычно крутят:

-   `TextStyle(height: ...)`, чтобы сжимать или растягивать строки
-   `TextHeightBehavior(...)`, чтобы управлять тем, как применяется leading

Если выставить только `height`, можно всё равно получить текст, который выглядит вертикально "несцентрированным" в `Row`, или заголовки, которые ощущаются слишком воздушными по сравнению с основным текстом. Именно здесь в игру вступает `leadingDistribution`.

`leadingDistribution` управляет тем, как дополнительное leading (пространство, добавляемое высотой строки) распределяется над и под глифами. Значение по умолчанию не всегда подходит для типографики UI.

## Маленький виджет, делающий разницу очевидной

Вот минимальный фрагмент, который можно бросить на экран и сравнить визуально:

```dart
import 'package:flutter/material.dart';

class LeadingDistributionDemo extends StatelessWidget {
  const LeadingDistributionDemo({super.key});

  @override
  Widget build(BuildContext context) {
    const style = TextStyle(
      fontSize: 20,
      height: 1.1, // intentionally tight so leading behavior is visible
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: const [
        Text('Default leadingDistribution', style: style),
        SizedBox(height: 8),
        Text(
          'Even leadingDistribution\n(two lines to show it)',
          style: style,
          textHeightBehavior: TextHeightBehavior(
            leadingDistribution: TextLeadingDistribution.even,
          ),
        ),
      ],
    );
  }
}
```

Когда вы видите два блока бок о бок, на реальных шрифтах это обычно ловится сразу: один блок "лучше" сидит в своём вертикальном пространстве, особенно при выравнивании с иконками или при ограничении высоты контейнера.

## Где это бьёт в реальных приложениях

Эта деталь обычно всплывает в тех местах Flutter-приложений, которые сложнее всего держать pixel perfect:

-   **Кнопки и чипы**: текст лейбла выглядит слишком низко или слишком высоко относительно контейнера.
-   **Карточки со смешанным контентом**: стопка из заголовка и подзаголовка ощущается неровно.
-   **Кастомные шрифты**: метрики ascent/descent сильно отличаются между гарнитурами.
-   **Интернационализация**: письменности с другими метриками глифов вскрывают ваши предположения о расстояниях.

Решение - не "всегда выставлять `leadingDistribution`". Решение в другом: когда наводите порядок в типографике, держите `TextHeightBehavior` в своей мысленной модели, а не только `fontSize` и `height`.

Если ваш UI на Flutter 3.x уже на 95% готов, но всё ещё ощущается слегка кривым, это одна из первых ручек, которые я проверяю.
