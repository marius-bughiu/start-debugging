---
title: "Как добавить анимацию Hero между двумя экранами в Flutter"
description: "Оберните один и тот же виджет на обеих маршрутах в Hero с идентичным tag, и Flutter анимирует его положение и размер во время навигации. Полное руководство: изображения, flightShuttleBuilder, createRectTween, дуги RectTween, переходы по жесту и коллизии tag, которые всё ломают. Проверено на Flutter 3.44, Dart 3.12."
pubDate: 2026-07-14
tags:
  - "flutter"
  - "dart"
  - "animation"
  - "navigation"
  - "how-to"
lang: "ru"
translationOf: "2026/07/how-to-add-a-hero-animation-between-two-screens-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-14
---

Короткий ответ: оберните виджет, который нужно анимировать, в `Hero` на первом экране, оберните виджет назначения во второй `Hero` с **тем же `tag`** и запушьте маршрут назначения обычным `Navigator`. `HeroController` Flutter (устанавливается по умолчанию в `MaterialApp` и `CupertinoApp`) находит два hero с совпадающим tag во время перехода между маршрутами, поднимает исходный hero в overlay и интерполирует его положение и размер, пока он не приземлится в назначении. Для базового случая вы не пишете ни `AnimationController`, ни `Tween`, ни явную длительность. Проверено на [Flutter 3.44](/ru/2026/07/flutter-3-44-read-the-screen-corner-radius-from-mediaquery/), Dart 3.12.

Это весь трюк, и это действительно два виджета `Hero` и один `Navigator.push`. Остальная часть руководства -- это то, на чём люди спотыкаются: правила tag, анимация изображения или `Icon`, меняющего форму между экранами, настройка виджета полёта, чтобы он не мерцал между темами, искривление траектории полёта и горстка ошибок, превращающих плавный переход в резкий скачок.

## Минимальный рабочий пример

Два экрана. Цветной блок на первом, тот же блок крупнее на втором. Блок перелетает между ними.

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

Нажмите на маленький блок, и он вырастет и скользнёт в центр второго экрана. Нажмите назад, и он вернётся обратно. Строка `tag` `'box-hero'` -- это вся связь между двумя виджетами. Если tag различаются хотя бы на один символ, ничего не анимируется, и оба блока просто появляются и исчезают как обычно.

## Почему совпадающие tag -- это весь механизм

`Hero` не хранит ссылку на свою пару. Вместо этого в момент старта перехода между маршрутами `HeroController` обходит дерево виджетов уходящего и приходящего маршрутов и строит отображение tag на hero. Для каждого tag, присутствующего на **обоих** маршрутах, он запускает "полёт": исходный hero убирается из своей обычной позиции (`placeholderBuilder` заполняет пробел, по умолчанию пустой), копия помещается в overlay-`Stack` у `Navigator`, и эта копия анимируется от исходного `Rect` к целевому `Rect`, используя собственную анимацию перехода маршрута как таймер.

Из этого дизайна вытекают два следствия, и оба они -- источник большинства багов Hero:

1. **tag должен быть уникальным в пределах одного маршрута.** Если на экране два виджета `Hero` с `tag: 'box-hero'`, Flutter не может решить, какой из них должен лететь, и выбрасывает `There are multiple heroes that share the same tag within a subtree`. Это бьёт сильнее всего, когда вы помещаете `Hero` внутрь элемента `ListView` и даёте каждому элементу один и тот же литеральный tag. Используйте id элемента: `tag: 'photo-${photo.id}'`.
2. **hero должен существовать в первом кадре целевого маршрута.** Controller инспектирует целевой маршрут, пока тот строится. Если ваш целевой hero стоит за `FutureBuilder`, который ещё не разрешился, внутри `Offstage` или заблокирован `if`, который ложен при первой сборке, нет целевого `Rect`, к которому лететь, и анимация молча пропускается.

## Анимация изображения или иконки, меняющей форму

Самое частое реальное применение -- миниатюра, которая раскрывается в полноэкранный заголовок. child не обязан быть идентичным на обоих маршрутах, только помечен идентичным tag. Здесь источник -- скруглённая миниатюра 80x80, а назначение -- изображение во всю ширину.

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

Два момента, за которыми стоит следить, когда child -- это `Image`. Во-первых, используйте один и тот же `url` изображения (в идеале тот же `ImageProvider` в памяти) на обоих маршрутах, чтобы сетевой запрос уже был в кеше и полёт не показывал наполовину загруженный кадр. Во-вторых, отличающийся `BoxFit` или `ClipRRect` только на одной стороне создаёт заметный скачок, когда радиус угла или обрезка резко защёлкиваются в конце полёта. Если скруглённые углы важны, оберните обе стороны в один и тот же `ClipRRect` или используйте `flightShuttleBuilder` (ниже), чтобы интерполировать радиус.

Для `Icon` или стилизованного `Text` действует то же правило: framework интерполирует ограничивающий `Rect` и масштабирует отрисовку исходного child, чтобы вписать его в этот rect во время полёта. Иконка 24px, летящая к иконке 96px, выглядит корректно, потому что child масштабируется, а не перекомпоновывается посреди полёта.

## Настройка виджета полёта через flightShuttleBuilder

По умолчанию полёт показывает child целевого hero, масштабированный. Это поведение по умолчанию ломается в двух ситуациях: когда child читает `InheritedWidget` (`Theme`, `DefaultTextStyle` или `MediaQuery`), который различается между двумя маршрутами, и когда вы хотите, чтобы виджет заметно трансформировался, а не просто масштабировался, во время полёта. `flightShuttleBuilder` даёт вам полный контроль над тем, что отрисовывается, пока hero в воздухе.

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

Аргумент `flightDirection` -- это `HeroFlightDirection.push` или `HeroFlightDirection.pop`, так что вы можете отрисовывать разный shuttle на пути туда и обратно. `animation` -- это `Animation<double>` полёта от 0 до 1; используйте его для перекрёстного затухания или интерполяции `BorderRadius`, если хотите, чтобы углы плавно скруглялись, а не скакали. Это правильное решение проблемы "скруглённые углы скачут в конце": управляйте радиусом из `animation.value` внутри shuttle.

## Искривление траектории полёта через createRectTween

По умолчанию hero движется по прямой линии между двумя rect, а его размер интерполируется линейно. Собственные детальные переходы Material часто используют **дугу**: виджет следует по кривой траектории, что читается более естественно для карточки, раскрывающейся в страницу. Flutter поставляет `MaterialRectArcTween` именно для этого, и вы включаете его для каждого hero через `createRectTween`.

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

`createRectTween` выполняется на hero, который является назначением полёта. Если вы хотите дугу и при push, и при pop, задайте её на hero обоих маршрутов. По умолчанию используется простой `RectTween` (линейный). `MaterialRectArcTween` искривляет верхний левый и нижний правый углы по дугам, поэтому раскрывающаяся карточка кажется "заметающей" на своё место, а не выстреливающей по диагонали. Начиная с Flutter 3.44 вы также можете передать кривую напрямую в переход через маршрут, но `createRectTween` остаётся способом задать форму геометрической траектории, а не тайминг.

## Как заставить жест "назад" в iOS анимировать hero

На `CupertinoPageRoute` (или `MaterialPageRoute` в iOS) пользователь может провести от левого края, чтобы сделать pop маршрута. По умолчанию hero **не** летит во время этого интерактивного перетаскивания; он летит только при подтверждённом pop. Задайте `transitionOnUserGestures: true` на обоих hero, чтобы разделяемый элемент отслеживал перетаскивание.

```dart
// Flutter 3.44, Dart 3.12
Hero(
  tag: 'box-hero',
  transitionOnUserGestures: true,
  child: Container(width: 80, height: 80, color: Colors.indigo),
);
```

Задайте это и на исходном, и на целевом hero. Если задать только на одном, push анимируется, а интерактивный pop -- нет, что ощущается несогласованно. Это дёшево добавить, и редко есть причина оставлять это выключенным для настоящей пары разделяемых элементов.

## Анимация Hero с go_router и другими роутерами

Ничто в `Hero` не привязано к императивному `Navigator.push`. Анимацией управляет переход между маршрутами, поэтому она работает одинаково с `go_router`, `auto_route` или любым роутером, построенным на `Navigator` 2.0, при условии, что страница назначения использует страницу, способную к переходу (`MaterialPage`, `CupertinoPage` или `CustomTransitionPage`). Дайте двум виджетам один и тот же tag и навигируйте так, как ваше приложение обычно это делает:

```dart
// Flutter 3.44, Dart 3.12, go_router 14.x
GoRoute(
  path: '/photo/:id',
  builder: (context, state) => PhotoDetailScreen(id: state.pathParameters['id']!),
);

// Trigger it from the grid:
onTap: () => context.go('/photo/${photo.id}'),
```

Одна оговорка с декларативными роутерами: если вы используете `CustomTransitionPage` с нулевой длительностью или `NoTransitionPage`, нет анимации перехода, которой `HeroController` мог бы управлять, поэтому hero не полетит. Сохраняйте реальный переход (хотя бы короткое затухание) на любом маршруте, где вы хотите анимацию разделяемого элемента. Для более глубокого сравнения самих роутеров см. заметки о [вложенных маршрутах и deep links с go_router](/ru/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/) и разбор [go_router vs auto_route vs Navigator 2.0](/ru/2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter/).

## Ошибки, которые ломают анимации Hero

Это отказы, которые всплывают в баг-репортах, упорядоченные по тому, сколько поискового трафика они привлекают.

1. **`There are multiple heroes that share the same tag within a subtree`.** Два hero на одном маршруте делят один tag. Почти всегда это список, где каждый элемент использовал константный tag. Исправление: выводите tag из уникального ключа, например `'item-${item.id}'`. Если вам действительно нужно одно и то же изображение на экране дважды, только один из них может участвовать в полёте; дайте остальным разные tag или вообще никакого `Hero`.
2. **hero просто появляется, без полёта.** Целевой hero отсутствует в первом кадре. Он стоит за неразрешённым `FutureBuilder`, внутри `Offstage` или заблокирован флагом, ложным при первой сборке. Убедитесь, что помеченный tag виджет присутствует в дереве немедленно, даже если его данные загружаются позже, чтобы был rect, к которому лететь. Связанная ловушка -- инициализация этого `Future` внутри `build`, что пересоздаёт его при каждой пересборке; см. [инициализация Future так, чтобы FutureBuilder его не пересоздавал](/ru/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/).
3. **child скачет или мерцает в конце полёта.** Отличающиеся `BoxFit`, радиус `ClipRRect` или зависящий от `InheritedWidget` стиль между двумя маршрутами. Исправьте с помощью `flightShuttleBuilder`, который отрисовывает стабильный виджет и интерполирует отличающееся свойство из `animation.value`.
4. **`Navigator.pop` выбрасывает исключение, или стрелка назад ничего не делает.** Это не проблема Hero, но она выглядит как таковая, потому что происходит на экране с hero. Убедитесь, что маршрут был запушен `Navigator`, которому принадлежит `HeroController`. Пользовательским вложенным `Navigator` нужен собственный `HeroController` в `observers`, иначе hero не будут летать между ними.
5. **Раскладка скачет, потому что у hero неограниченный размер.** `Hero`, оборачивающий `Text` или `Row` внутри `Column`, может попасть в ситуацию неограниченной ширины во время полёта, когда его поднимают в overlay-`Stack`. Оберните child у hero в `Material` с `type: MaterialType.transparency` или дайте ему явные ограничения. Если вы в целом сталкиваетесь с ошибками неограниченной высоты, это тот же класс багов раскладки, разобранный в [вложение ListView в Column](/ru/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/).

## Тексту нужен предок Material во время полёта

Тонкий момент, заслуживающий отдельной заметки: пока hero в полёте, он живёт в overlay у `Navigator`, отсоединённый от `Scaffold` и его `Material`. `Text` и виджеты на основе `Ink` ищут предка `Material` для своего стиля текста по умолчанию и всплесков ink. Во время полёта они могут его не найти, поэтому стилизованный текст может отрисоваться со стилем отладки по умолчанию (чёрное подчёркивание) на один кадр. Оберните child полёта в `Material`:

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

`MaterialType.transparency` даёт тексту предка `Material` для разрешения его стиля, не рисуя фон, что сохраняет полёт визуально чистым.

## Когда не стоит использовать Hero

`Hero` -- правильный инструмент, когда *один и тот же концептуальный элемент* существует на обоих экранах: миниатюра, становящаяся заголовком, аватар, становящийся фото профиля, карточка, становящаяся страницей деталей. Это неправильный инструмент для декоративного движения, где ничего не разделяется. Если вы хотите, чтобы вся страница скользила, затухала или масштабировалась, это `transitionsBuilder` маршрута (или `PageRouteBuilder`), а не `Hero`. Если вы хотите анимировать виджет *внутри* одного экрана, обратитесь к `AnimatedContainer`, `AnimatedPositioned` или явному `AnimationController`. Hero специально владеет случаем разделяемого элемента между маршрутами, и использование его для чего-либо ещё борется с framework.

Для более широкой работы над производительностью и UI Flutter, которая часто всплывает вместе с добавлением переходов, руководства по [профилированию подтормаживаний с DevTools](/ru/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) и [заданию акцентного цвета через Material 3 ColorScheme](/ru/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/) охватывают две вещи, которые люди обычно полируют сразу после того, как навигация начинает ощущаться хорошо: бюджет кадров и оформление.

## Источники

- Flutter API: [класс `Hero`](https://api.flutter.dev/flutter/widgets/Hero-class.html)
- Документация Flutter: [Hero animations](https://docs.flutter.dev/ui/animations/hero-animations)
- Cookbook Flutter: [Animate a widget across screens](https://docs.flutter.dev/cookbook/navigation/hero-animations)
- Flutter API: [`MaterialRectArcTween`](https://api.flutter.dev/flutter/material/MaterialRectArcTween-class.html)
- Flutter API: [`HeroController`](https://api.flutter.dev/flutter/widgets/HeroController-class.html)
