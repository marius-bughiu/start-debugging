---
title: "Миграция пользовательских переходов между страницами после реорганизации page transition builders во Flutter (Flutter 3.44 - 3.47)"
description: "Flutter перенёс PageTransitionsBuilder и два встроенных билдера в слой widgets, а CupertinoPageTransitionsBuilder вынес из Material. Что на самом деле ломается (один импорт, с вводящей в заблуждение ошибкой 'Not a constant expression'), что делает dart fix и в чём он ошибается для проектов на material_ui, и как переписать пользовательские билдеры и маршруты, чтобы они вообще не зависели от Material."
pubDate: 2026-10-08
updatedDate: 2026-10-08
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "navigation"
  - "cupertino"
lang: "ru"
translationOf: "2026/10/migrate-custom-page-transitions-after-the-flutter-page-transition-builders-reorganization"
translatedBy: "claude"
translationDate: 2026-10-08
---

Для большинства приложений это миграция на пять минут с единственным изменением, ломающим исходный код: начиная с Flutter 3.44 `CupertinoPageTransitionsBuilder` находится в библиотеке Cupertino, поэтому любой файл, который импортирует только `package:flutter/material.dart` (или `package:material_ui/material_ui.dart`) и помещает этот билдер в `PageTransitionsTheme`, перестаёт компилироваться. Добавьте импорт Cupertino, и всё готово. Остальная часть реорганизации, которая перенесла базовый класс `PageTransitionsBuilder`, а также `FadeUpwardsPageTransitionsBuilder` и `OpenUpwardsPageTransitionsBuilder` в `package:flutter/widgets.dart` во Flutter 3.38 и 3.41, ничего не ломает, но именно на неё стоит обратить внимание: ваши пользовательские билдеры теперь могут полностью отказаться от зависимости от Material, а это то, что позволяет им продолжать работать при переходе на отдельные пакеты дизайн-систем. Всё ниже было скомпилировано и протестировано на Flutter 3.44.8 с Dart 3.12.2 и проверено на текущей стабильной версии Flutter 3.47.6 с [`material_ui`](https://pub.dev/packages/material_ui) 1.6.0 и [`cupertino_ui`](https://pub.dev/packages/cupertino_ui) 1.1.2.

## Зачем билдеры перенесли

`PageTransitionsBuilder` начинал как класс Material, потому что единственными его потребителями были `PageTransitionsTheme` и `MaterialPageRoute`. Для приложения на Cupertino или для команды со своей дизайн-системой на базе `WidgetsApp` это не имело смысла: чтобы переиспользовать объект перехода, приходилось импортировать Material. [Issue #172929](https://github.com/flutter/flutter/issues/172929) во Flutter ("Move platform specific page transitions outside of Material and Cupertino") отслеживала это разделение в рамках более широкой работы по выпуску Material и Cupertino как отдельных пакетов.

Конкретные результаты:

- **Пользовательским билдерам больше не нужен Material.** Подкласс `PageTransitionsBuilder` может импортировать только `package:flutter/widgets.dart` и использоваться в написанном вручную `PageRoute`, в `WidgetsApp`, в `CupertinoApp` или в `PageTransitionsTheme`.
- **Приложения на Cupertino получают iOS-билдер без подключения Material.** `CupertinoPageTransitionsBuilder` теперь лежит рядом с `CupertinoPageRoute` в `cupertino/route.dart`.
- **Билдеры переживают миграцию на `material_ui`.** Поскольку базовый класс находится в слое widgets, который не выходит из SDK, билдер, написанный поверх `widgets.dart`, является тем же типом и для `PageTransitionsTheme` из SDK, и для той, что в `material_ui`.

## Что ломается

| Область | Изменение | Попало в stable | Серьёзность |
| ------- | --------- | --------------- | ----------- |
| `PageTransitionsBuilder` | Перенесён из Material в `widgets.dart` ([PR #174321](https://github.com/flutter/flutter/pull/174321)) | 3.38 | нет, Material реэкспортирует widgets |
| `FadeUpwardsPageTransitionsBuilder` | Перенесён в `widgets.dart` ([PR #175560](https://github.com/flutter/flutter/pull/175560)) | 3.41 | нет |
| `OpenUpwardsPageTransitionsBuilder` | Перенесён в `widgets.dart` ([PR #177080](https://github.com/flutter/flutter/pull/177080)) | 3.41 | нет |
| `CupertinoPageTransitionsBuilder` | Перенесён из Material в `cupertino.dart` ([PR #179776](https://github.com/flutter/flutter/pull/179776)) | 3.44 | высокая для файлов только с Material, исправляется одним импортом |
| `ZoomPageTransitionsBuilder`, `FadeForwardsPageTransitionsBuilder`, `PredictiveBackPageTransitionsBuilder`, `PageTransitionsTheme` | Без изменений, по-прежнему Material | н/д | нет |

Первые три строки незаметны для приложения на Material, потому что `material.dart` делает `export 'package:flutter/widgets.dart'`. Файл, в котором написано `extends PageTransitionsBuilder` и есть только импорт Material, разрешает этот класс через реэкспорт точно так же, как раньше. Официальная [страница о breaking change](https://docs.flutter.dev/release/breaking-changes/decouple-page-transition-builders) по той же причине перечисляет `FadeUpwardsPageTransitionsBuilder` и `OpenUpwardsPageTransitionsBuilder` в разделе "Material": при импорте Material именно оттуда они и кажутся происходящими.

## Предварительный чек-лист

- Узнайте, какая у вас версия Flutter: `flutter --version`. Поломка требует версии 3.44 или новее. Текущая стабильная версия - 3.47.x.
- Найдите все упоминания, прежде чем что-либо менять:

  ```bash
  # Any Flutter version
  grep -rn "PageTransitionsBuilder\|PageTransitionsTheme" lib test packages
  ```

- Определите, на чём построен проект: на библиотеках SDK (`package:flutter/material.dart`) или на отдельных пакетах (`package:material_ui/material_ui.dart`). Идея исправления одна и та же, но строка импорта отличается, и `dart fix` ошибается ровно в одном из случаев (см. шаг 3).
- Проверьте также path- и git-зависимости. Пакет, который ссылается на `CupertinoPageTransitionsBuilder` только с импортом Material, ломает вашу сборку точно так же, а исправить это из своего приложения вы не можете.

## Шаги миграции

1. **Обновитесь и воспроизведите ошибку.** Перейдите на целевой SDK и запустите анализатор, который выдаёт гораздо более понятное сообщение, чем компилятор:

   ```bash
   # Flutter 3.44.8 or later
   flutter upgrade
   flutter analyze
   ```

   Возьмём такой `ThemeData` из типичного приложения, который прекрасно компилировался на 3.41:

   ```dart
   // Flutter 3.44.8, Dart 3.12.2 -- fails to compile
   import 'package:flutter/material.dart';

   final ThemeData theme = ThemeData(
     pageTransitionsTheme: const PageTransitionsTheme(
       builders: <TargetPlatform, PageTransitionsBuilder>{
         TargetPlatform.android: PredictiveBackPageTransitionsBuilder(),
         TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
         TargetPlatform.macOS: CupertinoPageTransitionsBuilder(),
       },
     ),
   );
   ```

   `flutter analyze` сообщает настоящую причину, `undefined_method`: "The method 'CupertinoPageTransitionsBuilder' isn't defined", плюс шум в виде `invalid_constant` и `non_constant_map_value` для каждой записи. Проверка: вы видите по одному `undefined_method` на каждое использование `CupertinoPageTransitionsBuilder` и никаких других новых ошибок.

2. **Добавьте импорт Cupertino в каждый затронутый файл.** Для библиотек SDK:

   ```dart
   // Flutter 3.44+, SDK libraries
   import 'package:flutter/cupertino.dart';
   import 'package:flutter/material.dart';
   ```

   Для отдельных пакетов:

   ```dart
   // Flutter 3.47.6, material_ui 1.6.0, cupertino_ui 1.1.2
   import 'package:cupertino_ui/cupertino_ui.dart';
   import 'package:material_ui/material_ui.dart';
   ```

   `material_ui` уже зависит от `cupertino_ui`, но импорт транзитивной зависимости срабатывает на линт `depend_on_referenced_packages`, поэтому добавьте пакет явно командой `flutter pub add cupertino_ui`. Проверка: `flutter analyze` не выдаёт замечаний по этим файлам.

3. **Или доверьте это `dart fix`, а затем проверьте результат.** Обе библиотеки поставляются с data-driven исправлением для этого переноса (запись `replacedBy` в `fix_material.yaml`):

   ```bash
   # Flutter 3.44+
   dart fix --dry-run
   dart fix --apply
   ```

   В проекте на библиотеках SDK он вставляет `import 'package:flutter/cupertino.dart';` и ничего больше, и это правильно. В проекте на `material_ui` 1.6.0 данные исправления всё ещё указывают на `package:flutter/cupertino.dart`, то есть на замороженную копию из SDK, а не на `cupertino_ui`. Ваш код компилируется, потому что билдер из SDK наследует тот же базовый класс слоя widgets, но вы только что вернули импорт дизайн-библиотеки SDK в проект, который от неё уже отошёл. Замените эту строку импортом `cupertino_ui` вручную. Проверка: `grep -rn "package:flutter/cupertino.dart" lib` ничего не возвращает в мигрированном проекте.

4. **Перенацельте пользовательские билдеры на слой widgets.** Билдеру, который лишь комбинирует `SlideTransition`, `FadeTransition`, `ScaleTransition` и кривые, больше незачем импортировать Material:

   ```dart
   // Flutter 3.44+, Dart 3.12 -- no Material import needed
   import 'package:flutter/widgets.dart';

   class FadeSlidePageTransitionsBuilder extends PageTransitionsBuilder {
     const FadeSlidePageTransitionsBuilder();

     @override
     Duration get transitionDuration => const Duration(milliseconds: 250);

     @override
     Widget buildTransitions<T>(
       PageRoute<T> route,
       BuildContext context,
       Animation<double> animation,
       Animation<double> secondaryAnimation,
       Widget child,
     ) {
       final Animation<Offset> position = animation.drive(
         Tween<Offset>(begin: const Offset(0.0, 0.08), end: Offset.zero)
             .chain(CurveTween(curve: Curves.easeOutCubic)),
       );
       return FadeTransition(
         opacity: animation,
         child: SlideTransition(position: position, child: child),
       );
     }
   }
   ```

   Тот же класс без изменений подходит и для темы Material, потому что `PageTransitionsTheme.builders` типизирован именно этим базовым классом. Проверка: единственный импорт Flutter в файле - `widgets.dart`, а `flutter analyze` не выдаёт замечаний.

5. **Замените шаблонный код `PageRouteBuilder` маршрутом, который делегирует работу билдеру.** Именно под этот паттерн и задумывалась реорганизация: один класс маршрута, любой переход, никакого Material:

   ```dart
   // Flutter 3.44+, Dart 3.12
   import 'package:flutter/widgets.dart';

   class BuilderPageRoute<T> extends PageRoute<T> {
     BuilderPageRoute({
       required this.builder,
       this.transitionsBuilder = const FadeSlidePageTransitionsBuilder(),
       super.settings,
     });

     final WidgetBuilder builder;
     final PageTransitionsBuilder transitionsBuilder;

     @override
     Duration get transitionDuration => transitionsBuilder.transitionDuration;

     @override
     Duration get reverseTransitionDuration =>
         transitionsBuilder.reverseTransitionDuration;

     @override
     DelegatedTransitionBuilder? get delegatedTransition =>
         transitionsBuilder.delegatedTransition;

     @override
     Color? get barrierColor => null;

     @override
     String? get barrierLabel => null;

     @override
     bool get maintainState => true;

     @override
     Widget buildPage(
       BuildContext context,
       Animation<double> animation,
       Animation<double> secondaryAnimation,
     ) => builder(context);

     @override
     Widget buildTransitions(
       BuildContext context,
       Animation<double> animation,
       Animation<double> secondaryAnimation,
       Widget child,
     ) => transitionsBuilder.buildTransitions<T>(
       this,
       context,
       animation,
       secondaryAnimation,
       child,
     );
   }
   ```

   Важно пробрасывать `transitionDuration`, `reverseTransitionDuration` и `delegatedTransition`. [Официальный пример](https://api.flutter.dev/flutter/widgets/PageTransitionsBuilder-class.html) жёстко задаёт 300 мс, что молча игнорирует длительность, объявленную билдером, а без `delegatedTransition` переданный в этот маршрут `CupertinoPageTransitionsBuilder` анимирует входящую страницу, но оставляет предыдущую неподвижной вместо того, чтобы сдвигать её влево. Проверьте это виджет-тестом (следующий раздел).

6. **Подключите маршрут к тому виджету приложения, который вы используете.** Для дизайн-системы на базе `WidgetsApp` передайте его как `pageRouteBuilder`:

   ```dart
   // Flutter 3.44+
   WidgetsApp(
     color: const Color(0xFF0B57D0),
     pageRouteBuilder: <T>(RouteSettings settings, WidgetBuilder builder) =>
         BuilderPageRoute<T>(builder: builder, settings: settings),
     home: const HomeScreen(),
   );
   ```

   В приложении на Material продолжайте использовать `PageTransitionsTheme` для перехода по умолчанию и открывайте `BuilderPageRoute` только там, где экрану нужен другой переход. Проверка: переход на открытый экран показывает новую анимацию, а `flutter analyze` не выдаёт замечаний.

## Проверка

Не доверяйте глазам при анимации в 250 мс. Прокрутите маршрут до середины и проверьте виджет перехода:

```dart
// Flutter 3.44.8, flutter_test
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:my_app/transitions.dart';

void main() {
  testWidgets('BuilderPageRoute uses the builder duration', (tester) async {
    final navigator = GlobalKey<NavigatorState>();
    await tester.pumpWidget(WidgetsApp(
      navigatorKey: navigator,
      color: const Color(0xFF000000),
      pageRouteBuilder: <T>(RouteSettings s, WidgetBuilder b) =>
          BuilderPageRoute<T>(builder: b, settings: s),
      home: const Text('home', textDirection: TextDirection.ltr),
    ));

    navigator.currentState!.push(BuilderPageRoute<void>(
      builder: (_) => const Text('second', textDirection: TextDirection.ltr),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 125));

    final fade = tester.widget<FadeTransition>(find
        .ancestor(of: find.text('second'), matching: find.byType(FadeTransition))
        .first);
    expect(fade.opacity.value, 0.5);

    await tester.pumpAndSettle();
    expect(find.text('second'), findsOneWidget);
  });
}
```

На Flutter 3.44.8 тест проходит, и непрозрачность на 125 мс равна ровно `0.5`, что доказывает: маршрут подхватил длительность билдера в 250 мс. Если кто-то снова жёстко пропишет 300 мс, значение упадёт примерно до `0.42`, и тест не пройдёт. Кроме того:

- `flutter analyze` не сообщает диагностик `undefined_method` и `undefined_hidden_name`.
- `flutter test` проходит, включая golden-тесты, которые снимают кадры в середине перехода, если они у вас есть.
- В симуляторе iOS смахните назад от левого края на экране, использующем `CupertinoPageTransitionsBuilder`, и убедитесь, что предыдущая страница движется вместе с жестом.

## План отката

Изменения в коде аддитивны: лишний импорт и несколько классов, которым больше не нужен Material. Все они компилируются и на 3.41, с той разницей, что на 3.41 `CupertinoPageTransitionsBuilder` разрешается через импорт Material, поэтому добавленный импорт `cupertino.dart` просто избыточен. Откат SDK через `flutter downgrade` или закреплённая версия в CI не требует отмены ни одного из этих изменений. Единственное, что нельзя откатить ниже 3.38, - это билдер, импортирующий только `widgets.dart`, поскольку базового класса там ещё не было.

## Подводные камни

**Ошибка компилятора указывает не на ту проблему.** Внутри `const`-карты, а именно так записана почти любая `PageTransitionsTheme`, фронтенд не говорит, что имя не определено. `flutter build` и `flutter test` печатают только:

```text
lib/main.dart:14:33: Error: Not a constant expression.
            TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
                                ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
```

Люди удаляют `const`, и ошибка превращается в "The method 'CupertinoPageTransitionsBuilder' isn't defined for the type 'App'", после чего начинают искать метод. Сначала запустите `flutter analyze`: он показывает диагностику `undefined_method` рядом с шумом про константы.

**Неполная карта `builders` не сливается со значениями по умолчанию.** Передача `builders:` заменяет всю карту по умолчанию, а отсутствующие платформы во время выполнения получают `CupertinoPageTransitionsBuilder` только на iOS и `ZoomPageTransitionsBuilder` везде в остальных случаях, включая macOS. Если перечислить только Android и iOS, macOS получит переход масштабированием. Раз уж вы всё равно правите этот файл, перечислите все платформы, на которых выпускаете приложение.

**Смешивание импортов Cupertino из SDK и из пакета в одном файле.** В проекте на `material_ui` файл, который импортирует и `package:flutter/cupertino.dart` (оставленный `dart fix`), и `package:cupertino_ui/cupertino_ui.dart`, получает ошибки `ambiguous_import` для каждого имени Cupertino. Оставьте ровно один.

**Устаревшие конструкции `hide`.** В некоторых кодовых базах писали `import 'package:flutter/material.dart' hide CupertinoPageTransitionsBuilder;`, чтобы избежать конфликта с локальным классом с тем же именем. На 3.44+ это имя больше не существует в пространстве имён Material, и анализатор сообщает `undefined_hidden_name`. Удалите эту конструкцию.

**Сторонние билдеры продолжают работать.** `SharedAxisPageTransitionsBuilder` из [`animations`](https://pub.dev/packages/animations) и похожие классы наследуют базовый класс через собственный импорт Material, который реэкспортирует тип из слоя widgets, поэтому они по-прежнему встраиваются в вашу тему. Ломаются только пакеты, которые сами ссылаются на `CupertinoPageTransitionsBuilder` с импортом только Material, и им нужен релиз пакета, а не изменение в вашем приложении.

**Наследование от билдера Material всё ещё требует Material.** `ZoomPageTransitionsBuilder`, `FadeForwardsPageTransitionsBuilder` и билдеры predictive back остались в Material. Если ваш пользовательский билдер наследует один из них, чтобы подправить длительность, он сохраняет свой импорт Material (или `material_ui`).

## См. также

- Изменение импортов здесь - лишь часть более крупного переноса, описанного в [миграции импортов Flutter Material и Cupertino на пакеты material_ui и cupertino_ui](/ru/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/).
- О релизе, с которого началось разделение, читайте в [разделении Material и Cupertino на пакеты во Flutter 3.44](/ru/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).
- Ещё одна ошибка компиляции 3.44 с той же первопричиной: [исправление "Undefined name 'awaitNotRequired'" с material_ui и cupertino_ui](/ru/2026/10/fix-undefined-name-awaitnotrequired-material-ui-cupertino-ui-flutter-3-44/).
- Если ваш пользовательский переход на самом деле относится к общему элементу, лучше подойдёт [Hero-анимация между двумя экранами](/ru/2026/07/how-to-add-a-hero-animation-between-two-screens-in-flutter/).
- Роутеры, которые сами строят страницы, например `CustomTransitionPage` из go_router, сравниваются в [go_router vs auto_route vs Navigator 2.0](/ru/2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter/).

## Источники

- [Page transition builders reorganization](https://docs.flutter.dev/release/breaking-changes/decouple-page-transition-builders), breaking changes Flutter.
- [Справочник API `PageTransitionsBuilder`](https://api.flutter.dev/flutter/widgets/PageTransitionsBuilder-class.html).
- [flutter/flutter#172929](https://github.com/flutter/flutter/issues/172929), отслеживающая issue.
- PR [#174321](https://github.com/flutter/flutter/pull/174321), [#175560](https://github.com/flutter/flutter/pull/175560), [#177080](https://github.com/flutter/flutter/pull/177080) и [#179776](https://github.com/flutter/flutter/pull/179776).
- [Data-driven fixes](https://dart.dev/tools/fix) в документации Dart.
