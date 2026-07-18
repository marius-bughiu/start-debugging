---
title: "Исправление: ScaffoldMessenger.of() был вызван с контекстом, который не содержит Scaffold (Flutter)"
description: "Эта ошибка означает, что переданный BuildContext находится выше Scaffold или ScaffoldMessenger, а не ниже. Оберните вызов в Builder, вынесите его в отдельный виджет или используйте GlobalKey."
pubDate: 2026-07-18
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "snackbar"
lang: "ru"
translationOf: "2026/07/fix-scaffoldmessenger-of-context-does-not-contain-a-scaffold-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-18
---

`ScaffoldMessenger.of() was called with a context that does not contain a Scaffold` (и его более старый близнец `Scaffold.of() called with a context that does not contain a Scaffold`) означает, что `BuildContext`, который вы передали в `.of()`, находится *выше* `Scaffold` или `ScaffoldMessenger`, который он пытается найти, а не ниже. Почти всегда это происходит, когда вы вызываете его из того же метода `build`, который возвращает `Scaffold`. Исправьте это, обернув вызов в `Builder`, вынеся его в отдельный виджет или добравшись до messenger через `GlobalKey`. Проверено на Flutter 3.x (3.44), Dart 3.x.

## Ошибка в контексте

Есть два тесно связанных сообщения, и какое из них вы получите, зависит от того, какой API вы вызвали. Классическое, из API `Scaffold.of()` до версии 2.0, которое до сих пор используют многие старые ответы на Stack Overflow:

```
Scaffold.of() called with a context that does not contain a Scaffold.
No Scaffold ancestor could be found starting from the context that was passed
to Scaffold.of(). This usually happens when the context provided is from the
same StatefulWidget as that whose build function actually creates the Scaffold
widget being sought.
```

Современное, из `ScaffoldMessenger.of()`, -- это API, который вам следует использовать для показа `SnackBar`:

```
No ScaffoldMessenger widget found.
Scaffold widgets require a ScaffoldMessenger widget ancestor.
Typically, the ScaffoldMessenger widget is introduced by the MaterialApp at
the top of your application widget tree.
```

Оба -- это одна и та же ошибка в разной одежде: поиск предка, который начинается слишком высоко в дереве и идёт в неправильном направлении. Понимание того, *почему* поиск завершается неудачей, -- это разница между тем, чтобы вставить `Builder` наугад, и знанием, какое именно исправление нужно в вашей ситуации.

## Почему поиск начинается не в том месте

`ScaffoldMessenger.of(context)` и `Scaffold.of(context)` оба выполняют обход предков. Внутри они вызывают `context.dependOnInheritedWidgetOfExactType` (через унаследованный `_ScaffoldMessengerScope`), который начинается с элемента `context` и поднимается *вверх* к корню, ища ближайшего подходящего предка. Он никогда не смотрит вниз.

Теперь представьте виджет, который даёт сбой. Вы написали метод `build`, возвращающий `Scaffold`, и где-то в этом методе вы вызываете `Scaffold.of(context)` или `ScaffoldMessenger.of(context)`, используя параметр `context` того же `build`. Этот `context` принадлежит элементу *вашего* виджета. Ваш виджет -- **родитель** `Scaffold`, который он возвращает. Поэтому, когда поиск поднимается от вашего элемента, только что созданный `Scaffold` находится ниже точки старта, и обход никогда его не достигает. Он проходит мимо вашего виджета и поднимается к тому, что находится над вами, ничего подходящего не находит и выбрасывает исключение (assertion).

Именно этот сценарий и указывает классическое сообщение: "the context provided is from the same StatefulWidget as that whose build function actually creates the Scaffold widget being sought".

Есть тонкость, которую стоит знать, потому что она объясняет, почему вы можете видеть или не видеть ошибку. `MaterialApp` вставляет `ScaffoldMessenger` рядом с вершиной вашего дерева за вас. Это означает, что `ScaffoldMessenger.of(context)` обычно завершается успешно, *даже из контекста, у которого вообще нет Scaffold выше*, потому что он находит messenger на уровне приложения. Поэтому вариант "No ScaffoldMessenger widget found" срабатывает только тогда, когда предка-messenger действительно нет: вы находитесь выше `MaterialApp`, собрали приложение на голом `WidgetsApp` без messenger или создали пользовательскую область `ScaffoldMessenger` и вызываете извне неё. Гораздо более частый сбой в реальном коде -- это сбой `Scaffold.of()`, либо `SnackBar`, который показывается не в том месте, потому что вы разрешили не тот messenger.

## Минимальное воспроизведение

Самый маленький надёжный триггер -- это кнопка, размещённая прямо в методе `build`, который возвращает `Scaffold`, вызывающая `.of()` с `context` этого метода:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
class HomePage extends StatelessWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Home')),
      body: Center(
        child: ElevatedButton(
          onPressed: () {
            // context here is HomePage's context, which is ABOVE the Scaffold.
            Scaffold.of(context).showSnackBar(   // throws
              const SnackBar(content: Text('Saved')),
            );
          },
          child: const Text('Save'),
        ),
      ),
    );
  }
}
```

Замените `Scaffold.of` на `ScaffoldMessenger.of` и, поскольку `MaterialApp` предоставляет messenger, сбой исчезнет, но `SnackBar` теперь управляется корневым messenger, а не `Scaffold` этого экрана. Для большинства приложений это нормально, и именно поэтому была сделана миграция на `ScaffoldMessenger`. Но если у вас есть вложенные области `ScaffoldMessenger`, вы всё ещё можете разрешить не тот из не того контекста.

## Исправление 1: используйте ScaffoldMessenger.of, а не Scaffold.of

Если ваша ошибка -- это вариант `Scaffold.of()` и вы всего лишь пытаетесь показать, скрыть или удалить `SnackBar`, то первое и лучшее исправление -- просто перестать использовать `Scaffold.of()`. `Scaffold.of().showSnackBar()` был объявлен устаревшим в Flutter 2.0 и удалён; текущий API находится у `ScaffoldMessenger`:

```dart
// Flutter 3.x (tested 3.44)
// Before (deprecated, throws from the same build context):
Scaffold.of(context).showSnackBar(mySnackBar);
Scaffold.of(context).hideCurrentSnackBar();
Scaffold.of(context).removeCurrentSnackBar();

// After (current API):
ScaffoldMessenger.of(context).showSnackBar(mySnackBar);
ScaffoldMessenger.of(context).hideCurrentSnackBar();
ScaffoldMessenger.of(context).removeCurrentSnackBar();
```

Поскольку messenger живёт выше `Scaffold` вашего экрана (обычно на уровне `MaterialApp`), поиск вверх успешно завершается из контекста вашего `build`. В качестве бонуса `SnackBar` теперь сохраняются и анимируются при переходах между маршрутами, вместо того чтобы исчезать при навигации, -- в этом и был весь смысл переработки `ScaffoldMessenger`. `showSnackBar` также возвращает `ScaffoldFeatureController`, который вы можете использовать, чтобы дождаться причины закрытия:

```dart
// Flutter 3.x (tested 3.44)
final controller = ScaffoldMessenger.of(context).showSnackBar(
  SnackBar(
    content: const Text('Item deleted'),
    action: SnackBarAction(label: 'Undo', onPressed: _undo),
  ),
);
final reason = await controller.closed; // SnackBarClosedReason.action, .timeout, ...
```

## Исправление 2: получите контекст ниже Scaffold с помощью Builder

Иногда вам действительно нужен контекст, который является потомком `Scaffold`: вы вызываете `Scaffold.of(context)` для чего-то помимо `SnackBar` (открытие drawer через `Scaffold.of(context).openDrawer()`, чтение `Scaffold.of(context).hasAppBar`), либо вы настроили локальный `ScaffoldMessenger` и вам нужно разрешить *именно его*. Самое дешёвое исправление -- `Builder`, который вводит свежий контекст, чья позиция в дереве находится ниже `Scaffold`:

```dart
// Flutter 3.x (tested 3.44)
@override
Widget build(BuildContext context) {
  return Scaffold(
    body: Builder(
      builder: (innerContext) {          // innerContext is BELOW the Scaffold
        return ElevatedButton(
          onPressed: () {
            ScaffoldMessenger.of(innerContext).showSnackBar(
              const SnackBar(content: Text('Saved')),
            );
          },
          child: const Text('Save'),
        );
      },
    ),
  );
}
```

`Builder` не делает ничего, кроме вызова своей функции `builder`, но `innerContext`, который он передаёт, принадлежит элементу, являющемуся потомком `Scaffold`. Теперь обход вверх сразу же достигает `Scaffold` (и области messenger). Используйте внутренний контекст, а не внешний -- в этом весь трюк.

## Исправление 3: вынесите вызывающий код в отдельный виджет

`Builder` -- это сокращение для структурного исправления: выделите кнопку в отдельный `StatelessWidget` или `StatefulWidget`. Его метод `build` получает контекст, который естественным образом находится ниже `Scaffold`, поэтому `.of()` разрешается правильно, и вы больше никогда об этом не думаете:

```dart
// Flutter 3.x (tested 3.44)
class HomePage extends StatelessWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Home')),
      body: const Center(child: SaveButton()),
    );
  }
}

class SaveButton extends StatelessWidget {
  const SaveButton({super.key});

  @override
  Widget build(BuildContext context) {
    // This context is a descendant of the Scaffold above.
    return ElevatedButton(
      onPressed: () => ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Saved')),
      ),
      child: const Text('Save'),
    );
  }
}
```

Это предпочтительный вариант для всего, что сложнее одноразового callback. Он читаемее вложенного `Builder`, сохраняет виджет экрана тонким и делает кнопку тестируемой независимо.

## Исправление 4: используйте GlobalKey, когда нет пригодного контекста

Исправления на основе контекста предполагают, что вы находитесь внутри дерева виджетов в момент показа сообщения. Когда это не так (`SnackBar`, вызванный из `bloc`, репозитория, фонового callback или обработчика ошибок, у которого нет `BuildContext`), добирайтесь до messenger через `GlobalKey<ScaffoldMessengerState>`, подключённый к `MaterialApp`:

```dart
// Flutter 3.x (tested 3.44)
final rootScaffoldMessengerKey = GlobalKey<ScaffoldMessengerState>();

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      scaffoldMessengerKey: rootScaffoldMessengerKey,
      home: const HomePage(),
    );
  }
}

// Anywhere, with no BuildContext at all:
void notifySaved() {
  rootScaffoldMessengerKey.currentState?.showSnackBar(
    const SnackBar(content: Text('Saved')),
  );
}
```

`currentState` равен null, пока приложение не смонтировано, поэтому защитите его через `?.`. Это официально рекомендуемый шаблон для показа `SnackBar` извне виджета, и он полностью обходит вопрос «какой контекст?», потому что никакой контекст не задействован.

## Подводные камни и похожие случаи

**`maybeOf` возвращает null вместо выбрасывания.** Если вы хотите *попытаться* показать сообщение и тихо ничего не делать, когда messenger отсутствует (редко, но полезно в общем коде, который может работать вне дерева Material), используйте `ScaffoldMessenger.maybeOf(context)?.showSnackBar(...)`. Он выполняет тот же поиск, но возвращает `null` вместо выбрасывания исключения. Не прибегайте к нему, чтобы замаскировать реальную структурную ошибку: если вы ожидаете, что messenger там будет, исключение оказывает вам услугу.

**Вызов `.of()` в `initState`.** Частый вариант -- попытка показать `SnackBar` в `initState`. Контекст существует, но кадр ещё не был размещён, и вы всё ещё внутри build/mount. Отложите это: `WidgetsBinding.instance.addPostFrameCallback((_) => ScaffoldMessenger.of(context).showSnackBar(...))`. Ещё лучше -- используйте `GlobalKey` из Исправления 4, чтобы не зависеть от тайминга `context`.

**Использование контекста после `await`.** Получение `ScaffoldMessenger.of(context)` после асинхронного разрыва может выбросить исключение или разрешить устаревший messenger, если виджет был уничтожен, пока вы ожидали. Захватите messenger *до* await или защититесь через `mounted`. Это та же дисциплина, что и [безопасное использование BuildContext после await](/ru/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) и [защита setState проверкой mounted](/ru/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/).

**`SnackBar` показывается не на том экране.** Сбоя нет, но сообщение появляется на другом маршруте, чем вы ожидали. Это проблема *какой messenger*, а не *нет messenger*: вы разрешили корневой messenger `MaterialApp`, когда хотели вложенный `ScaffoldMessenger`, которым обернули поддерево. Разрешайте из контекста внутри этой вложенной области (Исправление 2 или Исправление 3) либо держите key на конкретный messenger.

**`showModalBottomSheet` и `openDrawer` упираются в ту же стену.** Любой вызов `Scaffold.of(context)` из собственного контекста `build` экрана даёт сбой точно так же, не только `showSnackBar`. `Scaffold.of(context).openDrawer()` и `showModalBottomSheet(context: context, ...)` оба нуждаются в контексте ниже `Scaffold`. Исправления с `Builder` и вынесением в виджет применяются без изменений.

**Это assertion, поэтому release-сборки ведут себя иначе.** Сбой `of()` выбрасывает assertion в debug и исключение в release. Не думайте, что release-сборка, которая «не упала при тестировании», безопасна: если messenger действительно отсутствует, release тоже выбросит исключение. Устраните это в debug.

Если ваш фактический сбой -- это другой виджет Material, жалующийся, что не может найти предка (`No MaterialLocalizations found`, `No Directionality widget found`, `No MediaQuery widget ancestor found`), механизм тот же -- промах поиска вверх, и исправление той же формы: дайте вызывающему коду контекст, который находится ниже нужного виджета, либо добавьте недостающего предка. Ошибка Flutter [поиск предка деактивированного виджета небезопасен](/ru/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/) -- это основанный на времени двоюродный брат этой структурной ошибки.

## Связанное

- [Как безопасно использовать BuildContext после await во Flutter](/ru/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) -- захват messenger перед асинхронным разрывом, чтобы он оставался валидным, когда сработает `SnackBar`.
- [Как защитить setState проверкой mounted после асинхронного разрыва во Flutter](/ru/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/) -- та же дисциплина жизненного цикла, которая делает безопасными вызовы `.of()` после await.
- [Исправление: поиск предка деактивированного виджета небезопасен во Flutter](/ru/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/) -- основанный на времени сбой поиска предка, в отличие от этого структурного.
- [Исправление: Incorrect use of ParentDataWidget. Expanded widgets must be placed inside Flex widgets](/ru/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/) -- другая ошибка «неправильное место в дереве виджетов», которую фреймворк ловит на этапе build.

## Источники

- [SnackBars managed by the ScaffoldMessenger, критические изменения Flutter](https://docs.flutter.dev/release/breaking-changes/scaffold-messenger) -- миграция с `Scaffold.of().showSnackBar` на `ScaffoldMessenger.of().showSnackBar`, `scaffoldMessengerKey` и точное сообщение assertion "No ScaffoldMessenger widget found".
- [ScaffoldMessenger.of, справочник API Flutter](https://api.flutter.dev/flutter/material/ScaffoldMessenger/of.html) -- документирует, что `of()` выбрасывает assertion в debug и исключение в release, когда messenger отсутствует в области видимости, и указывает на `maybeOf` и шаблон `GlobalKey`.
- [ScaffoldMessenger.maybeOf, справочник API Flutter](https://api.flutter.dev/flutter/material/ScaffoldMessenger/maybeOf.html) -- поиск, возвращающий null, для случая, когда messenger может законно отсутствовать.
- [Scaffold.of, справочник API Flutter](https://api.flutter.dev/flutter/material/Scaffold/of.html) -- классическое сообщение "context that does not contain a Scaffold" и средство с `Builder`.
