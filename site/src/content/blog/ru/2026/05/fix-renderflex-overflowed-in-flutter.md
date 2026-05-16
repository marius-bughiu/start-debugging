---
title: "Решение: A RenderFlex overflowed by N pixels во Flutter"
description: "Решение за 30 секунд: оберните потомка, вызвавшего переполнение, в Expanded или Flexible. Затем прочитайте остальное, чтобы понять, почему Row и Column не обрезают молча, что значат неограниченные constraints и какое решение подходит к какому макету."
pubDate: 2026-05-16
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "layout"
  - "renderflex"
lang: "ru"
translationOf: "2026/05/fix-renderflex-overflowed-in-flutter"
translatedBy: "claude"
translationDate: 2026-05-16
---

Решение в одном предложении: оберните потомка, ставшего слишком широким (или слишком высоким), в `Expanded` или `Flexible`, установите `mainAxisSize: MainAxisSize.min` на охватывающем `Row` или `Column`, либо оберните всё в `SingleChildScrollView`, если содержимое действительно должно прокручиваться. Жёлто-чёрная полоса -- не баг рендеринга, а сообщение Flutter о том, что неограниченный потомок внутри `Row`, `Column` или `Flex` запросил больше места, чем родитель мог ему предоставить.

```text
A RenderFlex overflowed by 124 pixels on the right.

The overflowing RenderFlex has an orientation of Axis.horizontal.
The edge of the RenderFlex that is overflowing has been marked in the rendering
with a yellow and black striped pattern. This is usually caused by the contents
being too big for the RenderFlex.

The relevant error-causing widget was:
  Row  lib/widgets/profile_header.dart:42
```

Это руководство написано для Flutter 3.27.1, Dart 3.11 и виджетов Material 3 в стабильном канале. Всё описанное здесь работает без изменений начиная с Flutter 3.10 и через всю линейку 3.x. API виджетов `Row`, `Column`, `Expanded`, `Flexible` и `Flex` годами не меняется; нижележащий `RenderFlex` находится в `package:flutter/src/rendering/flex.dart`, и именно там выбрасывается ассерт.

## Почему Row и Column не обрезают молча

Flutter выполняет компоновку за один проход. Каждый родитель передаёт потомкам объект `BoxConstraints`, потомки выбирают размер, удовлетворяющий этим constraints, а родитель их позиционирует. Большинство виджетов принимает любой размер, который выберет потомок, но `Row`, `Column` и нижележащий `Flex` устроены иначе: они сначала располагают нефлексибельных потомков по их собственным размерам, а затем делят оставшееся пространство между потомками `Expanded` и `Flexible`. Если нефлексибельные потомки вместе превышают пространство по главной оси, которое родитель выделил флексу, делить нечего, и компоновка выходит за бюджет.

`RenderFlex` мог бы молча обрезать переполнение, но это скрывало бы ошибки компоновки, которые проявляются только на самом маленьком устройстве в вашем парке. Поэтому в режиме debug Flutter печатает ассерт, рисует полосатый предупреждающий прямоугольник на переполняющемся краю и продолжает рендеринг. В release полоса исчезает, но компоновка по-прежнему неверна: текст обрезается, цели нажатия уходят за пределы экрана, а программы чтения с экрана зачитывают содержимое, которого пользователь не видит. Это задокументировано на [странице распространённых ошибок Flutter](https://docs.flutter.dev/testing/common-errors) и совпадает с комментарием в начале [flex.dart в SDK Flutter](https://github.com/flutter/flutter/blob/3.27.1/packages/flutter/lib/src/rendering/flex.dart).

## Минимальная воспроизводимая проблема, которую можно вставить в новое приложение

```dart
// Flutter 3.27.1, Dart 3.11
import 'package:flutter/material.dart';

void main() => runApp(const MaterialApp(home: OverflowDemo()));

class OverflowDemo extends StatelessWidget {
  const OverflowDemo({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          children: [
            const Icon(Icons.message),
            const SizedBox(width: 8),
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text('Title', style: Theme.of(context).textTheme.headlineMedium),
                const Text(
                  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, '
                  'sed do eiusmod tempor incididunt ut labore et dolore '
                  'magna aliqua.',
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
```

Это канонический случай. Внешний `Row` имеет ширину, ограниченную `Scaffold`, `Icon` и `SizedBox` нефлексибельны и невелики, но внутренний `Column` тоже нефлексибельный и обёртывает `Text`, который хочет быть таким же широким, как весь абзац в одной строке. Запустите это на любой телефонной разметке -- и получите переполнение справа.

## Выберите правильное решение: Expanded, Flexible или прокручиваемое

Есть три правильных решения, и они не взаимозаменяемы.

### Решение 1: оберните прожорливого потомка в `Expanded`

Используйте, когда потомок должен занять всё оставшееся пространство по главной оси. В воспроизведении прожорливый потомок -- это `Column`:

```dart
// Flutter 3.27.1, Dart 3.11
Row(
  children: [
    const Icon(Icons.message),
    const SizedBox(width: 8),
    Expanded(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text('Title', style: Theme.of(context).textTheme.headlineMedium),
          const Text(
            'Lorem ipsum dolor sit amet, consectetur adipiscing elit, '
            'sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
          ),
        ],
      ),
    ),
  ],
)
```

`Expanded` -- это `Flexible` с `flex: 1` и `fit: FlexFit.tight`. "Tight" значит, что потомок обязан заполнить отведённое ему пространство ровно. Внутри `Row` это даёт внутреннему `Text` ограниченную ширину, и движок текста может разбить содержимое на несколько строк. Переполнение исчезает, потому что собственная ширина `Text` больше не участвует в подсчёте ширины `Row`.

В 80 процентах случаев это правильное решение. Применяйте его, когда у вас в строке есть ведущая иконка плюс блок текста, или в колонке -- заголовок плюс прокручиваемое тело. Формальный контракт см. в [справке по классу Expanded](https://api.flutter.dev/flutter/widgets/Expanded-class.html).

### Решение 2: оберните потомка в `Flexible`, если он может занимать меньше своей доли

По умолчанию `Flexible` использует `fit: FlexFit.loose`, что значит "можешь занять до этого, но не обязан". Применяйте, когда у вас два потомка, которые должны делить оставшееся пространство пропорционально, но ни один не обязан использовать всю свою долю. Классический случай -- два равнозначных `TextField` рядом друг с другом, каждый по половине строки:

```dart
// Flutter 3.27.1, Dart 3.11
Row(
  children: [
    Flexible(child: TextField(decoration: const InputDecoration(labelText: 'First'))),
    const SizedBox(width: 8),
    Flexible(child: TextField(decoration: const InputDecoration(labelText: 'Last'))),
  ],
)
```

Если бы вы использовали здесь `Expanded`, поля по-прежнему делили бы строку 50/50, но если бы вместо `TextField` стоял `Chip`, `Expanded` растянул бы область чипа на всю ширину, и это выглядело бы сломано. `Flexible` с собственной шириной чипа сохраняет правильный визуальный размер и всё равно устраняет переполнение.

Эмпирическое правило: `Expanded` для "заполни то, что осталось", `Flexible` для "можешь вырасти до того, что осталось". Неверный выбор обычно не приводит к переполнению, а лишь к уродливо растянутому виджету.

### Решение 3: сделайте ось прокручиваемой, когда содержимое действительно не помещается

Переполнения внизу `Column` внутри экрана телефона почти всегда означают, что пользователь должен прокручивать. Решение не `Expanded`, а поместить `Column` внутрь `SingleChildScrollView` (или заменить на `ListView`):

```dart
// Flutter 3.27.1, Dart 3.11
Scaffold(
  body: SingleChildScrollView(
    padding: const EdgeInsets.all(16),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final section in sections) SectionCard(section),
      ],
    ),
  ),
)
```

Для длинного списка с известным количеством элементов и однородными потомками предпочитайте `ListView.builder`, который лениво создаёт только видимые на экране элементы. `SingleChildScrollView` с `Column` каждый кадр строит каждого потомка, что нормально для страницы настроек с восемью строками, но губительно для ленты из тысячи строк. [Документация по прокрутке Flutter](https://docs.flutter.dev/ui/layout/scrolling) проводит эту границу чётко.

## Причина за причиной: четыре способа, как эта ошибка проникает в код

### Виджет `Text` внутри `Row` без ограниченной ширины

Самая частая причина, показанная в воспроизведении выше. Длинные строки, длинные названия товаров и переведённые строки UI (немецкий, как известно, шире английского) ломают `Row`, которые работали на машине разработчика. Всегда оборачивайте пользовательский или локализованный текст в `Expanded` или `Flexible`, когда он находится внутри `Row`. Если текст должен обрезаться, а не переноситься, добавьте `overflow: TextOverflow.ellipsis` и `maxLines: 1` на сам виджет `Text`:

```dart
// Flutter 3.27.1, Dart 3.11
Row(
  children: [
    const Icon(Icons.person),
    const SizedBox(width: 8),
    Expanded(
      child: Text(
        user.fullName,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
    ),
  ],
)
```

### Неограниченная главная ось: `Column` внутри `Column` или `Row` внутри `Row`

Если `Column` является потомком другого `Column`, внутренний получает неограниченную высоту. Всё, что внутри него запрашивает "сколько захочу", получает бесконечность, на что и жалуется RenderFlex. Решение -- обернуть внутренний `Column` в `Expanded` либо задать `mainAxisSize: MainAxisSize.min` и поместить всё внутрь прокручиваемого контейнера.

То же относится к `Row` внутри `Row`, `ListView` внутри `Column` и любой комбинации, где главная ось не ограничена. Прочитайте [Understanding constraints](https://docs.flutter.dev/ui/layout/constraints) один раз -- и остальное перестанет удивлять; это описание мантры "constraints go down, sizes go up, parent sets position", на которой держится вся система компоновки. Та же передача constraints вызывает и jank при шторме изменений размера, что мы разбираем в [как профилировать jank во Flutter с DevTools](/ru/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/).

### Жёстко заданные `width` или `height` у SizedBox или Container

`SizedBox(width: 400)` внутри `Row` шириной с телефон переполнит правую сторону на `400 - rowWidth + remaining children` пикселей. Это тот единственный случай, когда решение -- не `Expanded`, а "перестаньте жёстко задавать ширину". Используйте адаптивную компоновку: `Expanded`, `Flexible`, `FractionallySizedBox(widthFactor: 0.5)` или вычисляйте размер из `MediaQuery.sizeOf(context)`.

То же касается изображений. `Image.network` без constraint ширины сообщает свой собственный размер, который может составлять 2000 пикселей для серверного ассета. Либо задайте `Image` ограниченную ширину (`Image.network(url, width: 64)`), либо оберните его в `Expanded`.

### Локализация, масштабирование шрифта и размеры текста для доступности

`Row`, который прекрасно вписывается при стандартном масштабе шрифта, переполнится при масштабе 1.4x или 2.0x. Это и есть тот баг, что доходит до App Store и приносит одну звезду от пользователя с включённым крупным шрифтом. Тестируйте каждый экран с переопределениями `MediaQuery` для доступных масштабов:

```dart
// Flutter 3.27.1, Dart 3.11
MaterialApp(
  builder: (context, child) => MediaQuery(
    data: MediaQuery.of(context).copyWith(textScaler: const TextScaler.linear(1.5)),
    child: child!,
  ),
  home: const MyHomePage(),
)
```

`TextScaler` заменяет старое API `textScaleFactor` начиная с Flutter 3.16 и является поддерживаемым способом тестировать масштабирование текста. Если компоновка переполняется внутри такой обёртки `MediaQuery`, она переполнится и на реальных устройствах, и решение то же: `Expanded`, `Flexible` или прокручиваемый контейнер.

## Отладка: какой виджет переполняется

Ассерт всегда называет виджет и место в исходниках, но место указывает на `Row` или `Column`, который переполнился, а не на потомка, вызвавшего проблему. Три инструмента сужают поиск:

1. Жёлто-чёрная полоса в режиме debug показывает край (правый, нижний и т. д.), что уже сужает область поиска.
2. Включите "Debug Paint" в Flutter Inspector (также доступно через `debugPaintSizeEnabled = true;` в `main`), чтобы увидеть контуры каждого render box. Прожорливый потомок обычно явно выступает за пределы родителя.
3. Используйте режим выбора виджета в Inspector и кликните по проблемной области на симуляторе. Панель `RenderObject` выбранного виджета показывает его размер и constraints. Сравните их с родителем.

Для более глубокой отладки та же сессия DevTools, которой вы пользуетесь для работы с производительностью, поддерживает отладку компоновки на вкладке Layout Explorer. Если этот процесс вам незнаком, статья [как профилировать jank во Flutter с DevTools](/ru/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) проводит через открытие DevTools в режиме profile на реальном устройстве.

## Подводные камни и похожие ошибки

- `Vertical viewport was given unbounded height` -- сестринская ошибка, когда `ListView` живёт внутри `Column` без `Expanded`. Решение того же вида: ограничьте потомка или сделайте родителя прокручиваемым. Не "чините" её, выставляя `shrinkWrap: true` на `ListView`; это отключает ленивый рендеринг и воссоздаёт исходное переполнение при более высоких позициях прокрутки.
- `RenderBox was not laid out` значит, что выше в логе сработал ассерт переполнения `RenderFlex`, и пайплайн компоновки так и не дошёл до вычисления геометрии отрисовки. Прокрутите лог ошибок вверх до первого сообщения о переполнении -- именно там настоящий баг.
- `BoxConstraints forces an infinite width`, выбрасываемое `Text`, значит, что `Text` находится внутри чего-то, что даёт неограниченную главную ось, обычно `Row` внутри горизонтального `ListView`. Оберните `Text` в контейнер с фиксированной шириной или используйте `Flexible`.
- `A RenderFlex overflowed by Infinity pixels` -- вариант с неограниченным constraint. Решение никогда не "сделать число меньше", а "дать родителю ограниченный constraint", обычно через `Expanded` выше по дереву.
- Замолчать предупреждение через `clipBehavior: Clip.hardEdge` на `Row` или `Column` уберёт полосу, но оставит нижележащий баг компоновки. Прибегайте к обрезанию только тогда, когда вы доказали, что переполнение намеренное (например, специально обрезанная бегущая строка).

## Связанное

- [Как профилировать jank во Flutter с DevTools](/ru/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) описывает настройку DevTools, которая заодно является вашим самым быстрым отладчиком компоновки.
- [Как задать цвет акцента в приложении Flutter с Material 3 ColorScheme](/ru/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/) -- место, где у новичков и начинаются проблемы переполнения, потому что переход на виджеты M3 меняет собственные размеры.
- [Как добавить платформо-специфичный код во Flutter без плагинов](/ru/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) становится актуальным, когда вы начинаете прятать строки на устройствах меньшего размера.
- [Как нацелиться на несколько версий Flutter из одного CI-пайплайна](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) важно, потому что точное число пикселей в сообщении о переполнении меняется между версиями SDK при изменении метрик текста.

## Источники

- [Common Flutter errors -- A RenderFlex overflowed](https://docs.flutter.dev/testing/common-errors), официальный раздел документации Flutter, определяющий ошибку и каноническое решение.
- [Understanding constraints](https://docs.flutter.dev/ui/layout/constraints), объяснение протокола компоновки, лежащего в основе каждого решения по flex layout в этой статье.
- [Справка по классу Expanded](https://api.flutter.dev/flutter/widgets/Expanded-class.html), документ API, закрепляющий, что `Expanded` -- это `Flexible(flex: 1, fit: FlexFit.tight)`.
- [Справка по классу Flexible](https://api.flutter.dev/flutter/widgets/Flexible-class.html), документ API, объясняющий `FlexFit.loose` vs `FlexFit.tight`.
- [Справка по классу Row](https://api.flutter.dev/flutter/widgets/Row-class.html) и [справка по классу Column](https://api.flutter.dev/flutter/widgets/Column-class.html), которые буквально описывают алгоритм определения размера по главной оси.
- [flex.dart на теге 3.27.1](https://github.com/flutter/flutter/blob/3.27.1/packages/flutter/lib/src/rendering/flex.dart), исходник, где выбрасывается ассерт переполнения.
