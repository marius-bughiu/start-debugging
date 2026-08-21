---
title: "Исправление: интерфейс Flutter перекрывается системной панелью навигации Android после перехода на SDK 35"
description: "Переход на Android SDK 35 переводит приложение Flutter в режим edge-to-edge, поэтому тело Scaffold отрисовывается за панелью навигации. Обрабатывайте отступы через SafeArea и padding из MediaQuery вместо отказа от режима, потому что в Android 16 такой отказ уже не работает."
pubDate: 2026-08-21
template: how-to
tags:
  - "flutter"
  - "dart"
  - "android"
  - "layout"
lang: "ru"
translationOf: "2026/08/fix-flutter-ui-overlaps-the-android-navigation-bar-after-targeting-sdk-35"
translatedBy: "claude"
translationDate: 2026-08-21
---

В прошлом релизе кнопки работали. Теперь нижний ряд вашего `Scaffold` оказывается под панелью навигации Android, наполовину видимым и наполовину нажимаемым, хотя в коде разметки ничего не менялось. Изменился целевой SDK: как только приложение Flutter нацеливается на Android SDK 35 (API 35, Android 15), Android запускает его в режиме edge-to-edge, и окно приложения теперь занимает всю высоту экрана, включая полосу, которую занимают системные панели. Решение состоит не в том, чтобы вернуть себе эту полосу, а в том, чтобы прочитать отступ, о котором сообщает Android, и сдвинуть на него собственный контент. Оборачивайте привязанный к низу контент в `SafeArea`, а прокручиваемым областям задавайте padding через `MediaQuery.paddingOf(context).bottom`, чтобы список прокручивался под панелью, но останавливался перед ней. Не хватайтесь за `android:windowOptOutEdgeToEdgeEnforcement`: значение `targetSdkVersion` по умолчанию во Flutter равно 36 задолго до текущего стабильного релиза, а в API 36 этот отказ объявлен устаревшим и отключён.

Всё изложенное ниже проверено на Flutter 3.44.2 (Dart 3.12.2), а значения SDK по умолчанию дополнительно сверены с текущим стабильным релизом, Flutter 3.47.1 (выпущен 2026-08-19, Dart 3.13.1).

## Почему снизу приложения исчезли 48 логических пикселей

До Android 15 приложение, которое явно не переходило в режим edge-to-edge, получало окно, заканчивавшееся там, где начинались системные панели. Панель навигации была непрозрачной, она принадлежала системе, и ваш `Scaffold` этих пикселей просто никогда не видел. Разметка была простой, потому что отступы за вас делала операционная система.

Android 15 перевернул это поведение по умолчанию. В руководстве Android по edge-to-edge сказано: "Edge-to-edge is enforced on Android 15 (API level 35) and higher once your app targets SDK 35." Теперь ваше окно занимает весь экран. Строка состояния становится прозрачной, панель жестовой навигации становится прозрачной, а панель навигации из трёх кнопок становится полупрозрачной. Android по-прежнему сообщает через window insets, сколько именно места занимают эти панели, но больше не вычитает это место за вас.

Flutter унаследовал это в тот момент, когда сместилась его цель по умолчанию. Собственная заметка о миграции у фреймворка описывает последовательность прямо: "Prior to Flutter 3.27, Flutter apps targeted Android 14 by default and didn't opt into edge-to-edge mode automatically." Начиная с Flutter 3.27 приложения, использующие `flutter.targetSdkVersion`, нацеливаются на Android 15 и включаются в режим автоматически. Изменение попало в `3.26.0-0.0.pre` и вышло в стабильной ветке в 3.27.

С тех пор это значение по умолчанию сместилось ещё раз, и именно в этой части большинство статей про эту ошибку устарели. В Gradle-плагине, поставляемом с Flutter 3.44.2, и точно так же в теге 3.47.1 значения по умолчанию такие:

```kotlin
// packages/flutter_tools/gradle/src/main/kotlin/FlutterExtension.kt
// Identical in Flutter 3.44.2 and 3.47.1
val compileSdkVersion: Int = 36
val minSdkVersion: Int = 24
val targetSdkVersion: Int = 36
```

Так что созданное сегодня через `flutter create` приложение нацеливается не просто на SDK, где edge-to-edge включён по умолчанию. Оно нацеливается на тот, где edge-to-edge является единственным вариантом.

## Как перекрытие выглядит в числах

Это стоит зафиксировать измерениями, а не скриншотами, потому что "на моём Pixel выглядит неправильно" не является отлаживаемым утверждением. Widget-тест позволяет точно смоделировать устройство: задайте у view значение `viewPadding` со строкой состояния 24dp и панелью навигации из трёх кнопок 48dp, установите `devicePixelRatio` в 1, чтобы логические пиксели совпадали с физическими, и измерьте, куда попадают виджеты в окне высотой 800dp.

```dart
// Flutter 3.44.2 / Dart 3.12.2
void setNavBarView(WidgetTester tester) {
  tester.view.devicePixelRatio = 1.0;
  tester.view.physicalSize = const Size(400, 800);
  tester.view.viewInsets = FakeViewPadding.zero;
  tester.view.viewPadding = const FakeViewPadding(top: 24, bottom: 48);
  tester.view.padding = const FakeViewPadding(top: 24, bottom: 48);
  addTearDown(tester.view.reset);
}

testWidgets('bare Scaffold body is not inset from the nav bar', (t) async {
  setNavBarView(t);
  await t.pumpWidget(MaterialApp(
    home: Scaffold(
      body: Align(
        alignment: Alignment.bottomCenter,
        child: SizedBox(key: const Key('marker'), height: 10, width: 10),
      ),
    ),
  ));
  print('BODY_BOTTOM=${t.getRect(find.byKey(const Key('marker'))).bottom}');
});
```

Он выводит `BODY_BOTTOM=800.0`. Нижняя граница маркера находится на 800, у самого низа экрана, а значит его последние 48 логических пикселей находятся под панелью навигации. `Scaffold.body` получает всё окно и ничего не делает для защиты своего потомка. В этом и состоит вся ошибка, и работает она ровно так, как задумано.

## Исправление в четыре шага

1. Оставьте edge-to-edge включённым и перестаньте искать выключатель. В API 36 поддерживаемого способа его отключить нет, поэтому время, потраченное на отказ, это время, потраченное на то, что придётся удалять.

    ```dart
    // Flutter 3.44.2: nothing to add. edgeToEdge is already the default.
    ```

2. Оборачивайте контент, привязанный к верху и к низу, в `SafeArea`. Это правильный инструмент для контента, который никогда не должен оказаться под панелью: нижние ряды кнопок, собственные панели инструментов, плавающие панели, всё, что размещено через `Align` или `Positioned`.

    ```dart
    // Flutter 3.44.2
    Scaffold(
      body: SafeArea(
        child: Align(
          alignment: Alignment.bottomCenter,
          child: ElevatedButton(onPressed: _submit, child: const Text('Save')),
        ),
      ),
    )
    ```

3. Прокручиваемым областям задавайте padding вместо оборачивания. `ListView` внутри `SafeArea` получает viewport, который заканчивается над панелью навигации, поэтому контент обрезается по жёсткой границе, а под полупрозрачной панелью виден пустой фон. Вместо этого передайте отступ как padding списка: viewport остаётся во весь экран, а контент прокручивается под панелью, но всё равно останавливается над ней.

    ```dart
    // Flutter 3.44.2
    ListView(
      padding: EdgeInsets.only(bottom: MediaQuery.paddingOf(context).bottom),
      children: rows,
    )
    ```

4. Проверяйте widget-тестом, а не на глаз, повторно используя показанный выше помощник `setNavBarView`. Высоты панелей, зависящие от устройства, это ровно тот случай, который молча ломается на телефоне, которого у вас нет.

Разница из шага 3 измерима. С `ListView` внутри `SafeArea` нижняя граница viewport прокручиваемой области равна 752.0, то есть сам viewport не достаёт до окна 48 пикселей. При подходе с padding нижняя граница viewport равна 800.0 (во весь экран, контент заметно прокручивается под полупрозрачной панелью), а нижняя граница последней строки оказывается на 752.0, что даёт ровно 48 логических пикселей запаса. Тот же запас для контента и корректное поведение прокрутки.

## Нижние виджеты самого Material это уже учитывают, а ваши нет

Самый распространённый способ потерять здесь час это добавить padding, который Material уже добавил, а затем недоумевать, почему промежуток выглядит удвоенным. `Scaffold` действительно задаёт отступы некоторым своим слотам, но только тем виджетам, которые об этом просят. Каждый слот, измеренный на той же смоделированной панели навигации 48dp:

| Виджет | Отрисованная высота | Верхняя граница | Результат |
| --- | --- | --- | --- |
| `SizedBox(height: 56)` в роли `bottomNavigationBar` | 56.0 | 744.0 | перекрывается, запаса нет |
| `NavigationBar` (2 назначения) | 128.0 | 672.0 | значки отстоят от панели на 86.0 |
| `BottomAppBar` | 128.0 | 672.0 | поглощает отступ 48dp |
| `FloatingActionButton` | по умолчанию | | нижняя граница на 736.0, запас 64.0 |
| `AppBar` | 80.0 | 0.0 | верх заголовка на 38.0 |

Первые две строки нужно читать вместе, в них весь смысл. Голый `SizedBox` высотой 56, помещённый в слот `bottomNavigationBar`, отрисовывается ровно высотой 56 и доходит до y=800, поэтому его нижние 48 пикселей находятся под панелью. Настоящий `NavigationBar` с номинальной высотой 80 отрисовывается на 128, то есть 80 плюс отступ 48dp, который он поглотил сам. `BottomAppBar` ведёт себя так же. `FloatingActionButton` заканчивается на 736, давая запас 64: отступ 48dp плюс обычное поле Scaffold в 16dp. `AppBar` отрисовывается высотой 80, то есть 56dp панели инструментов плюс 24dp строки состояния, так что верх экрана был решён задолго до всего этого.

Отсюда следует правило: нижние виджеты Material растут на величину отступа, а собственные виджеты в том же слоте нет. Если вы сделали свою нижнюю панель, padding для неё ваш. Если вы уже используете `NavigationBar` и оборачиваете его в `SafeArea`, вы получаете 96dp мёртвого пространства и панель, которая выглядит сломанной.

## Ловушка с клавиатурой, из-за которой SafeArea кажется нестабильной

Именно эта часть порождает баг-репорты вида "SafeArea работает, но только иногда". Нестабильности здесь нет. Это `MediaQueryData.padding` делает ровно то, что задокументировано.

Android сообщает два связанных значения. `viewPadding` это сырой отступ, который занимают системные панели. `padding` это тот же отступ, из которого уже вычтен `viewInsets` (клавиатура) и который ограничен снизу нулём. Когда открывается экранная клавиатура, она закрывает панель навигации, поэтому нижний отступ, важный для разметки, исчезает. Измерено при открытой клавиатуре высотой 300dp:

```text
KEYBOARD_UP padding.bottom=0.0 viewPadding.bottom=48.0
```

`SafeArea` по умолчанию читает `padding`, поэтому его нижний отступ схлопывается до нуля в тот же миг, когда появляется клавиатура, и то, что вы привязали к низу, опускается на 48 логических пикселей. Иногда это правильно, ведь панель действительно закрыта. Когда неправильно, у `SafeArea` для этого есть флаг, а реализация во фреймворке представляет собой подмену в две строки:

```dart
// packages/flutter/lib/src/widgets/safe_area.dart, Flutter 3.44.2
EdgeInsets padding = MediaQuery.paddingOf(context);
// Bottom padding has been consumed - i.e. by the keyboard
if (maintainBottomViewPadding) {
  padding = padding.copyWith(bottom: MediaQuery.viewPaddingOf(context).bottom);
}
```

Установка `maintainBottomViewPadding: true` удерживает промежуток неизменным. При измерении рядом с открытой клавиатурой обычный `SafeArea` даёт нижний промежуток 0.0, а вариант с флагом даёт 48.0. Используйте его, когда нижний элемент управления анимируется вместе с клавиатурой и не должен заметно прыгать. Это та же семья проблем, что и [переполнение RenderFlex снизу при открытии клавиатуры](/ru/2026/08/fix-renderflex-overflowed-on-the-bottom-when-the-keyboard-opens-in-flutter/), где клавиатура меняет ограничения, а не padding.

## Вложенный SafeArea не удваивает padding

Это стоит знать, прежде чем идти охотиться за призрачным промежутком: `SafeArea` убирает поглощённый padding из того `MediaQuery`, который передаёт своему поддереву. `SafeArea` внутри `SafeArea` даёт нижний промежуток 48.0, а не 96.0. Внутренний видит нулевой padding и ничего не добавляет.

Для композиции это хорошая новость, потому что можно поместить `SafeArea` в общий каркас страницы и позволить отдельным экранам добавлять свой, не проверяя всё дерево. Для отладки это плохая новость, потому что неверный промежуток никогда не вызван двойной вложенностью, так что если промежуток неправильный, причина в другом месте, обычно в собственном виджете в слоте `Scaffold`, как описано выше.

## Отказ существует, истекает и может уронить приложение

Для полноты картины, поскольку это первый результат по большинству запросов об этом симптоме. Flutter документирует отказ для приложений, нацеленных на SDK 35: добавьте `android:windowOptOutEdgeToEdgeEnforcement` и в `LaunchTheme`, и в `NormalTheme` в файле `android/app/src/main/res/values/styles.xml`, а также в соответствующий `values-night/styles.xml`.

```xml
<!-- android/app/src/main/res/values/styles.xml -->
<style name="NormalTheme" parent="@android:style/Theme.Light.NoTitleBar">
    <item name="android:windowOptOutEdgeToEdgeEnforcement">true</item>
</style>
```

Три причины не строить на этом. Во-первых, Android 16 его убил: страница изменений поведения указывает, что для приложений, нацеленных на API 36, `R.attr#windowOptOutEdgeToEdgeEnforcement` "is deprecated and disabled, and your app can't opt-out of going edge-to-edge." Во-вторых, Flutter уже по умолчанию ставит вам `targetSdkVersion = 36`, так что пришлось бы намеренно понижать цель, чтобы атрибут вообще что-то значил. В-третьих, собственная заметка о миграции Flutter предупреждает, что использование отказа на Android 16 и выше "might cause your app to crash," а предлагаемое смягчение это версионно-специфичный каталог ресурсов `your_app/android/app/src/main/res/values-35` со стилями без этого атрибута. Это вполне реальная возня с ресурсами в обмен на поведение, которого на актуальных устройствах уже нет.

То же рассуждение относится к `SystemChrome.setEnabledSystemUIMode`. В API 36 остальные режимы просто не учитываются, и фреймворк говорит об этом в документации API для `SystemUiMode`: если приложение нацелено на SDK 36 или выше, на Android оно использует `edgeToEdge` по умолчанию, и "There is no way to opt out." Режимы `leanBack`, `immersive` и `immersiveSticky` система Android при такой цели игнорирует.

## Цвета системных панелей теперь игнорируются, а контраст задаётся автоматически

Ещё одна потеря, которую стоит назвать, потому что она даёт другой симптом: ничего не падает, просто ваш цвет не применяется. В режиме edge-to-edge `SystemUiOverlayStyle.statusBarColor` и `SystemUiOverlayStyle.systemNavigationBarColor` не работают. В API 35 они возвращаются, если воспользоваться отказом, в API 36 они исчезли навсегда.

Что продолжает работать, так это яркость значков. `statusBarIconBrightness` и `systemNavigationBarIconBrightness` управляют тем, светлыми или тёмными отрисовываются собственные глифы системы, а это именно то, что нужно, когда контент за панелью меняет оттенок:

```dart
// Flutter 3.44.2
AppBar(
  systemOverlayStyle: SystemUiOverlayStyle(
    statusBarIconBrightness:
        MediaQuery.platformBrightnessOf(context) == Brightness.dark
            ? Brightness.light
            : Brightness.dark,
  ),
)
```

Предпочитайте задавать `AppBar.systemOverlayStyle` или `AnnotatedRegion<SystemUiOverlayStyle>`, когда панели приложения нет, вместо прямого вызова `SystemChrome.setSystemUIOverlayStyle`. Аннотированная область проверяется попаданием каждый кадр относительно того, что реально находится под строкой состояния и панелью навигации, поэтому она остаётся корректной, пока пользователь прокручивает или переходит между экранами. `AppBar` создаёт такую область автоматически, так что не оборачивайте `AppBar` в ещё один `AnnotatedRegion`.

Наконец, начиная с API 29 Android рисует полупрозрачную вуаль за прозрачной панелью навигации, чтобы три кнопки оставались читаемыми поверх произвольного контента. Если ваш дизайн уже обеспечивает контраст, а вуаль его портит, `systemNavigationBarContrastEnforced: false` (и `systemStatusBarContrastEnforced` для верха) её отключает. Устройства на API 28 и ниже её вообще никогда не применяли.

Если вы делаете полноэкранный вид намеренно, а не чинитесь, следующее, что вам понадобится, это физический изгиб экрана, который Flutter теперь [читает из MediaQuery как физические радиусы углов](/ru/2026/07/flutter-3-44-read-the-screen-corner-radius-from-mediaquery/), чтобы контент обрезался по стеклу, а не по угаданному радиусу.

## Похожие статьи

- [Исправление: A RenderFlex overflowed by N pixels on the bottom при открытии клавиатуры во Flutter](/ru/2026/08/fix-renderflex-overflowed-on-the-bottom-when-the-keyboard-opens-in-flutter/) -- вторая половина истории про нижний отступ, где клавиатура меняет ограничения, а не padding.
- [Flutter 3.44: чтение физического радиуса углов экрана из MediaQuery](/ru/2026/07/flutter-3-44-read-the-screen-corner-radius-from-mediaquery/) -- сопутствующий API для полноэкранных разметок на скруглённых экранах.
- [Как объединить ListView и GridView в одной прокрутке с помощью sliver-ов во Flutter](/ru/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/) -- куда применять нижний отступ, когда ваша область прокрутки это `CustomScrollView`, а не `ListView`.
- [shrinkWrap vs Expanded vs sliver-ы для длинных списков в Flutter: что выбрать?](/ru/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/) -- выбор правильной прокручиваемой области до того, как начать задавать ей padding.
- [Решение: Google Play отклоняет приложение на Flutter или .NET MAUI из-за отсутствия поддержки страниц памяти 16 КБ](/ru/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/) -- ещё одно продиктованное магазином требование Android, которое всплывает как сюрприз во время сборки.

## Источники

- [Set default of SystemUiMode to edge-to-edge](https://docs.flutter.dev/release/breaking-changes/default-systemuimode-edge-to-edge) -- руководство по миграции от Flutter, включая стили отказа и примечание про `values-35`.
- [Display content edge-to-edge in your app](https://developer.android.com/develop/ui/views/layout/edge-to-edge) -- формулировка Android о принудительном включении начиная с API 35.
- [Behavior changes: Apps targeting Android 16 or higher](https://developer.android.com/about/versions/16/behavior-changes-16) -- объявление `windowOptOutEdgeToEdgeEnforcement` устаревшим и его отключение.
- [SystemUiMode API documentation](https://api.flutter.dev/flutter/services/SystemUiMode.html) -- примечания по каждому режиму о том, что учитывают API 35 и API 36.
- [Issue 168635: App UI overlaps with 3-button navigation bar on Samsung One UI 7 / Android 15](https://github.com/flutter/flutter/issues/168635) -- обсуждение, на которое ссылается собственная документация Flutter.
