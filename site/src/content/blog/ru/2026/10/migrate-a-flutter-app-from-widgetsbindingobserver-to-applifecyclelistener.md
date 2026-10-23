---
title: "Миграция Flutter-приложения с WidgetsBindingObserver.didChangeAppLifecycleState на AppLifecycleListener (Flutter 3.13+)"
description: "Замените самописный код жизненного цикла на WidgetsBindingObserver на AppLifecycleListener: соответствие колбэков, конечный автомат, который он навязывает, новое состояние hidden, ломающее исчерпывающие switch, запросы на выход на десктопе и тест, который внезапно падает на assert. Проверено на Flutter 3.44.8 и Dart 3.12.2."
pubDate: 2026-10-23
updatedDate: 2026-10-23
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "app-lifecycle"
lang: "ru"
translationOf: "2026/10/migrate-a-flutter-app-from-widgetsbindingobserver-to-applifecyclelistener"
translatedBy: "claude"
translationDate: 2026-10-23
---

Если ваше Flutter-приложение все еще подмешивает `WidgetsBindingObserver` в `State` только ради переопределения `didChangeAppLifecycleState`, замена - это `AppLifecycleListener`, добавленный во Flutter 3.13.0. Вы создаете один объект-слушатель в `initState`, передаете ему только те колбэки, которые вам нужны (`onResume`, `onPause`, `onHide`, `onShow`, `onInactive`, `onRestart`, `onDetach`, `onStateChange`, `onExitRequested`), и вызываете у него `dispose()`. Никакого миксина, никакой пары `addObserver`/`removeObserver`, никакого `switch` по `AppLifecycleState`. Миграция одного наблюдателя занимает около 10 минут и сохраняет поведение, если вы знаете две вещи: начиная с 3.13 фреймворк вставляет промежуточные состояния (переход `resumed` в `paused` теперь приходит как `inactive`, `hidden`, `paused`), а новое значение `AppLifecycleState.hidden` превращает каждый исчерпывающий `switch` без `default` в ошибку компиляции. Все ниже запускалось на Flutter 3.44.8 (Dart 3.12.2).

## Зачем уходить от "сырого" наблюдателя

- **Меньше кода, меньше утечек.** Паттерн наблюдателя требует трех согласованных частей: миксина, `WidgetsBinding.instance.addObserver(this)` в `initState` и `removeObserver(this)` в `dispose`. Если забыть последнее, уничтоженный `State` остается жить в списке наблюдателей биндинга и продолжает получать колбэки после размонтирования. `AppLifecycleListener` регистрируется в конструкторе и отписывается в `dispose()`, так что помнить нужно об одном вызове, том же, что вы уже делаете для контроллеров.
- **Переходы, а не состояния.** `didChangeAppLifecycleState` сообщает, где находится приложение. Большинству логики важно, как оно туда попало: "приложение вернулось из фона" - это `paused` в `hidden` (`onRestart`), что отличается от "закрылся системный диалог" (`inactive` в `resumed`, `onResume`). Слушатель отслеживает предыдущее состояние и вызывает колбэк, названный по переходу.
- **Запросы на выход на десктопе в том же объекте.** `onExitRequested` позволяет приложению на Windows, macOS или Linux отменить закрытие, чтобы показать запрос "есть несохраненные изменения". С сырым наблюдателем это отдельное переопределение, `didRequestAppExit`.
- **Он может жить вне дерева виджетов.** Слушатель - обычный Dart-объект, которому нужен лишь `WidgetsBinding`. Репозиторий, сервис аналитики или провайдер Riverpod могут владеть им и освобождать его вместе с сервисом.

## Что меняется в приложении

| Область | Изменение | Серьезность |
| --- | --- | --- |
| Операторы `switch (state)` | `AppLifecycleState.hidden` (добавлен в 3.13) приводит к тому, что switch без `default` падают с `non_exhaustive_switch_statement` | высокая |
| Виджет-тесты, напрямую вызывающие `handleAppLifecycleStateChanged` | Прыжок из `resumed` сразу в `paused` теперь проваливает assert внутри слушателя | высокая |
| Классы `State` с наблюдателем | Миксин и `addObserver`/`removeObserver` удалены, вместо них одно поле и `dispose()` | средняя |
| Порядок колбэков | `onStateChange` срабатывает после колбэка перехода, по разу на каждое промежуточное состояние | низкая |
| Обработка выхода | Переопределение `didRequestAppExit` переезжает в `onExitRequested`; `AppExitResponse` берется из `dart:ui` | низкая |

## Предварительный чек-лист

- Flutter 3.13.0 или новее (`flutter --version`). `AppLifecycleListener` не существует в 3.10 и ранее, а файл `packages/flutter/lib/src/widgets/app_lifecycle_listener.dart` впервые появляется в теге 3.13.0.
- Поищите в кодовой базе `with WidgetsBindingObserver` и `didChangeAppLifecycleState`. Отметьте, какие наблюдатели переопределяют еще и другие колбэки, например `didChangeMetrics`, `didChangePlatformBrightness`, `didChangeLocales` или `didHaveMemoryPressure`. Для нелайфсайкл-колбэков миксин остается; переезжает только часть про жизненный цикл.
- Поищите операторы `switch` и цепочки `if` по `AppLifecycleState`. Для каждого нужно решение про `hidden`.
- Поищите в тестах `handleAppLifecycleStateChanged`. Именно эти тесты начнут падать.
- Сначала сделайте коммит или stash. Это миграция только кода, данные не затрагиваются, так что откат - это `git revert`.

## Шаги миграции

1. **Сопоставьте каждый `case` с колбэком.** Колбэки слушателя названы по переходам, а не по состояниям. Вот соответствие, взятое из исходников `AppLifecycleListener.didChangeAppLifecycleState` во Flutter 3.44.8:

   | Новое состояние | Предыдущее состояние | Колбэк |
   | --- | --- | --- |
   | `resumed` | `inactive` (или нет) | `onResume` |
   | `inactive` | `resumed` (или нет) | `onInactive` |
   | `inactive` | `hidden` | `onShow` |
   | `hidden` | `inactive` (или нет) | `onHide` |
   | `hidden` | `paused` | `onRestart` |
   | `paused` | `hidden` (или нет) | `onPause` |
   | `detached` | `paused` (или нет) | `onDetach` |
   | любое | любое | `onStateChange(state)`, после конкретного колбэка |

   `case AppLifecycleState.paused:` становится `onPause`, а `case AppLifecycleState.resumed:` становится `onResume`. Если старый код что-то делал на `inactive` независимо от направления, используйте `onStateChange` и оставьте `if`, потому что в `inactive` попадают с двух сторон, и это соответствует двум разным колбэкам. Проверка: у каждой ветки старого `switch` в ваших заметках ровно одно место назначения.

2. **Замените миксин полем-слушателем.** Типичный вариант "до":

   ```dart
   // Flutter 3.44.8, Dart 3.12.2 - BEFORE
   class PlayerScreen extends StatefulWidget {
     const PlayerScreen({super.key});
     @override
     State<PlayerScreen> createState() => _PlayerScreenState();
   }

   class _PlayerScreenState extends State<PlayerScreen>
       with WidgetsBindingObserver {
     @override
     void initState() {
       super.initState();
       WidgetsBinding.instance.addObserver(this);
     }

     @override
     void didChangeAppLifecycleState(AppLifecycleState state) {
       switch (state) {
         case AppLifecycleState.resumed:
           _player.resume();
         case AppLifecycleState.paused:
           _player.pause();
           _saveProgress();
         default:
           break;
       }
     }

     @override
     void dispose() {
       WidgetsBinding.instance.removeObserver(this);
       super.dispose();
     }

     // _player, _saveProgress and build() omitted
   }
   ```

   И вариант "после":

   ```dart
   // Flutter 3.44.8, Dart 3.12.2 - AFTER
   class _PlayerScreenState extends State<PlayerScreen> {
     late final AppLifecycleListener _lifecycle;

     @override
     void initState() {
       super.initState();
       _lifecycle = AppLifecycleListener(
         onResume: () => _player.resume(),
         onPause: () {
           _player.pause();
           _saveProgress();
         },
       );
     }

     @override
     void dispose() {
       _lifecycle.dispose();
       super.dispose();
     }

     // _player, _saveProgress and build() unchanged
   }
   ```

   Конструктор сам вызывает `binding.addObserver(this)`, так что создание объекта и есть подписка. Проверка: `flutter analyze` не сообщает о проблемах с неиспользуемым импортом `WidgetsBindingObserver`, а у класса больше нет секции `with` (если только ему не нужны другие колбэки наблюдателя, см. шаг 4).

3. **Решите, что `hidden` значит для вашей логики.** `AppLifecycleState.hidden` добавили во Flutter 3.13 для десктопа и веба, где приложение можно свернуть или оно может оказаться во фоновой вкладке, не будучи "приостановленным" в мобильном смысле. На iOS и Android фреймворк синтезирует его между `inactive` и `paused`. Если вы останавливали видео в `onPause`, это по-прежнему работает везде, где работало раньше. Если вы хотите, чтобы видео останавливалось и при сворачивании десктопного окна, то `onHide` - колбэк, срабатывающий на всех платформах, а `onShow` - его пара. Для всего, что должно происходить только когда пользователь покидает приложение на мобильном устройстве (сохранение черновика, сброс аналитики), подходит пара `onPause` и `onRestart`. Проверка: запишите для каждого колбэка, под какие платформы вы выпускаетесь и срабатывает ли он там (`onRestart` и `onDetach` задокументированы как только для мобильных).

4. **Оставьте миксин только для нелайфсайкл-колбэков.** `AppLifecycleListener` покрывает `didChangeAppLifecycleState` и `didRequestAppExit` и ничего больше. Если наблюдатель переопределяет еще и `didChangeMetrics`, чтобы реагировать на отступы клавиатуры, оставьте миксин для этого переопределения и вынесите только метод жизненного цикла. Проверка: после правки поищите в классе методы `@override` из `WidgetsBindingObserver`; если их не осталось, удалите миксин и вызовы `addObserver`/`removeObserver`.

5. **Перенесите `didRequestAppExit` в `onExitRequested`** (только десктоп). Колбэк возвращает `Future<AppExitResponse>`, а это перечисление живет в `dart:ui`, а не в `package:flutter/widgets.dart` или `services.dart`. Без импорта вы получите `Undefined name 'AppExitResponse'`.

   ```dart
   // Flutter 3.44.8, Dart 3.12.2
   import 'dart:ui' show AppExitResponse;
   import 'package:flutter/material.dart';

   class _EditorState extends State<Editor> {
     late final AppLifecycleListener _lifecycle;
     bool _dirty = false;

     @override
     void initState() {
       super.initState();
       _lifecycle = AppLifecycleListener(
         onExitRequested: () async {
           if (!_dirty) return AppExitResponse.exit;
           final discard = await showDialog<bool>(
             context: context,
             builder: (context) => AlertDialog(
               title: const Text('Discard unsaved changes?'),
               actions: [
                 TextButton(
                   onPressed: () => Navigator.pop(context, false),
                   child: const Text('Cancel'),
                 ),
                 TextButton(
                   onPressed: () => Navigator.pop(context, true),
                   child: const Text('Discard'),
                 ),
               ],
             ),
           );
           return discard == true ? AppExitResponse.exit : AppExitResponse.cancel;
         },
       );
     }

     @override
     void dispose() {
       _lifecycle.dispose();
       super.dispose();
     }

     @override
     Widget build(BuildContext context) => const Placeholder();
   }
   ```

   В этот колбэк попадают только отменяемые выходы. `ServicesBinding.instance.exitApplication(AppExitType.required)` завершает приложение без вопросов. Учтите, что `WidgetsBinding.handleRequestAppExit` опрашивает всех наблюдателей, даже после того как один ответил `cancel`, и отменяет выход, если отменил хотя бы один. Один слушатель в любом месте приложения может наложить вето на выход, при этом `onExitRequested` всех остальных слушателей все равно выполняется, так что не кладите туда необратимую очистку. Проверка: запустите на десктопе, сделайте редактор "грязным", закройте окно и убедитесь, что появляется диалог, а "Cancel" оставляет окно открытым.

6. **Исправьте `switch`, сломанные значением `hidden`.** Если вы оставляете `switch` (например, внутри `onStateChange`), он обязан покрывать `hidden`. Это компилируется на Flutter 3.10 и не проходит на 3.13+:

   ```dart
   // Flutter 3.44.8, Dart 3.12.2 - fails flutter analyze
   String describe(AppLifecycleState state) {
     switch (state) {
       case AppLifecycleState.resumed:
         return 'resumed';
       case AppLifecycleState.inactive:
         return 'inactive';
       case AppLifecycleState.paused:
         return 'paused';
       case AppLifecycleState.detached:
         return 'detached';
     }
   }
   ```

   Анализатор сообщает: "The type 'AppLifecycleState' isn't exhaustively matched by the switch cases since it doesn't match the pattern 'AppLifecycleState.hidden'" (`non_exhaustive_switch_statement`). Добавьте явный `case AppLifecycleState.hidden:` вместо `default`, чтобы следующее значение перечисления, добавленное Flutter, снова стало ошибкой компиляции, а не тихим проваливанием. Проверка: `flutter analyze` чист.

7. **Обновите тесты, которые вызывают смену жизненного цикла.** См. следующий раздел; именно здесь большинство миграций на самом деле застревает. Проверка: `flutter test` проходит.

## Проверка

Самое быстрое доказательство того, что поведение не изменилось, - виджет-тест, который отправляет изменения жизненного цикла так же, как движок: строкой в канал `flutter/lifecycle`. Этот путь проходит через генератор переходов биндинга, в точности как на настоящем устройстве.

```dart
// Flutter 3.44.8, Dart 3.12.2 - test/lifecycle_test.dart
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

Future<void> sendLifecycle(WidgetTester tester, AppLifecycleState state) async {
  final message = const StringCodec().encodeMessage(state.toString());
  await tester.binding.defaultBinaryMessenger
      .handlePlatformMessage('flutter/lifecycle', message, (_) {});
}

void main() {
  testWidgets('background and foreground', (tester) async {
    final log = <String>[];
    final listener = AppLifecycleListener(
      onResume: () => log.add('onResume'),
      onInactive: () => log.add('onInactive'),
      onHide: () => log.add('onHide'),
      onShow: () => log.add('onShow'),
      onPause: () => log.add('onPause'),
      onRestart: () => log.add('onRestart'),
      onStateChange: (s) => log.add('state:${s.name}'),
    );
    addTearDown(listener.dispose);

    await sendLifecycle(tester, AppLifecycleState.resumed);
    await sendLifecycle(tester, AppLifecycleState.paused);
    await sendLifecycle(tester, AppLifecycleState.resumed);

    expect(log, [
      'onResume', 'state:resumed',
      'onInactive', 'state:inactive',
      'onHide', 'state:hidden',
      'onPause', 'state:paused',
      'onRestart', 'state:hidden',
      'onShow', 'state:inactive',
      'onResume', 'state:resumed',
    ]);
  });
}
```

Этот тест проходит на 3.44.8 и фиксирует три факта в одном месте. Переход платформы из `resumed` сразу в `paused` приходит тремя шагами. Путь назад выполняет `onRestart`, `onShow`, `onResume`, именно в таком порядке. А `onStateChange` всегда идет после именованного колбэка для того же шага. Двукратная подряд отправка `resumed` второй раз ничего не даст, потому что и биндинг, и слушатель отбрасывают повторяющиеся состояния.

Затем ручные проверки: на Android и iOS отправьте приложение в фон и верните его, и убедитесь, что работа, которую вы перенесли в `onPause` и `onResume`, по-прежнему выполняется по одному разу. На десктопе сверните и восстановите окно, если что-то перенесли в `onHide`/`onShow`, и закройте окно, если реализовали `onExitRequested`.

## Откат

Миграция - чистое изменение кода, сохраненного состояния она не затрагивает. Сделайте `git revert` коммита, и вы снова на наблюдателе. Единственное, что не откатится чисто, - это `switch`, исправленный под `hidden`: оставьте это исправление, потому что старый код уже был сломан на 3.13+.

## Подводные камни реальной миграции

### Тесты, вызывающие `handleAppLifecycleStateChanged`, теперь падают на assert

Во многих наборах тестов сворачивание приложения имитируют через `tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused)`. Этот метод передает заданное состояние напрямую, без синтезированных промежуточных. Обычному наблюдателю это безразлично. Слушатель проверяет каждый переход, поэтому при приложении в состоянии `resumed` такой тест падает:

```dart
// Flutter 3.44.8, Dart 3.12.2 - fails
testWidgets('direct jump', (tester) async {
  final listener = AppLifecycleListener(onPause: () {});
  addTearDown(listener.dispose);
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
});
```

Сбой - это assert, брошенный при передаче наблюдателям: "Invalid state transition from AppLifecycleState.resumed to AppLifecycleState.paused", и `onPause` не вызывается никогда. Либо отправляйте каждое промежуточное состояние сами (`inactive`, `hidden`, `paused`), либо используйте хелпер канала `flutter/lifecycle` из раздела "Проверка", который позволяет фреймворку сгенерировать их. Assert есть только в debug-сборках, так что на релизное поведение это не влияет; риск лишь в красном наборе тестов.

### Слушатель видит изменения только после своего создания

Конструктор делает снимок `binding.lifecycleState` и считает его предыдущим состоянием. Если вы создаете слушатель на экране, открытом спустя долгое время после старта, `onResume` для текущего состояния не сработает, потому что перехода не было. У старого наблюдателя было то же поведение, но код иногда полагался на вызов в `initState`, чтобы "один раз выполнить логику возобновления". Оставьте это явным: читайте `WidgetsBinding.instance.lifecycleState` в `initState`, если вам нужно текущее состояние, как и раньше.

### Старые наблюдатели тоже видят синтезированные состояния

Генерация промежуточных состояний живет в `ServicesBinding`, а не в слушателе. В воспроизведении выше обычный `WidgetsBindingObserver`, зарегистрированный рядом со слушателем, тоже получил `inactive`, `hidden`, `paused` на единственное платформенное сообщение `paused`. Так что если еще не мигрированный наблюдатель делает "на все, кроме `resumed`, приостановить воспроизведение", теперь этот код выполняется три раза за одно сворачивание. Сделайте такие обработчики идемпотентными или перенесите их на один именованный колбэк.

### Создание слушателя до `runApp`

`AppLifecycleListener()` по умолчанию берет `binding` равным `WidgetsBinding.instance`, а это бросает исключение, если биндинг еще не инициализирован. Слушателю, которым владеет сервис, создаваемый в `main()` до `runApp`, сначала нужен `WidgetsFlutterBinding.ensureInitialized()`. Для сервисов, живущих дольше любого виджета, также убедитесь, что кто-то вызывает `dispose()`; с Riverpod это `ref.onDispose(listener.dispose)` в провайдере, который его создает.

### `onExitRequested` - не хук кнопки "назад" на мобильных

Соблазнительно считать `onExitRequested` сигналом "приложение вот-вот закроется" на Android. Это не так: в исходниках движка запросы на выход отправляют только embedder'ы для Windows, macOS и Linux, поэтому на Android и iOS он не срабатывает никогда. Чтобы перехватить жест "назад" на Android, используйте `PopScope`. Чтобы выполнить очистку, когда мобильное приложение уходит, используйте `onPause`; `onDetach` не гарантированно выполнится до того, как ОС убьет фоновый процесс.

## Связанные материалы

- `dispose()` слушателя относится к остальной вашей очистке; см. [как освобождать контроллеры во Flutter, чтобы избежать утечек памяти](/ru/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).
- Приостановка потока при уходе приложения в фон - частая задача для `onPause`, а [отмена StreamSubscription в dispose](/ru/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/) покрывает вторую половину.
- `onPause` - не ваш последний шанс на Android: после него ОС может убить процесс. То, что вернется после этого, обрабатывает [восстановление состояния UI после смерти процесса Android с помощью RestorationMixin](/ru/2026/10/how-to-restore-ui-state-after-android-process-death-in-flutter-with-restorationmixin/).
- Если вы вычищаете сразу несколько устаревших API, [запуск dart fix по всему репозиторию](/ru/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/) автоматизирует механические из них (эта миграция к ним не относится).
- `onExitRequested` важнее всего в десктопных приложениях с несколькими окнами; см. [включение поддержки нескольких окон в десктопном приложении Flutter](/ru/2026/08/how-to-enable-multi-window-support-in-a-flutter-desktop-app/).

## Источники

- [`AppLifecycleListener` class](https://api.flutter.dev/flutter/widgets/AppLifecycleListener-class.html) (api.flutter.dev)
- [`AppLifecycleState` enum and state diagram](https://api.flutter.dev/flutter/dart-ui/AppLifecycleState.html) (api.flutter.dev)
- [`WidgetsBindingObserver` class](https://api.flutter.dev/flutter/widgets/WidgetsBindingObserver-class.html) (api.flutter.dev)
- [`ServicesBinding.exitApplication`](https://api.flutter.dev/flutter/services/ServicesBinding/exitApplication.html) (api.flutter.dev)
- [`app_lifecycle_listener.dart` source](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/src/widgets/app_lifecycle_listener.dart) and [`ServicesBinding` transition generation](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/src/services/binding.dart) (flutter/flutter)
- [Breaking change: new `AppLifecycleState.hidden` enum value](https://docs.flutter.dev/release/breaking-changes/add-applifecyclestate-hidden) (docs.flutter.dev)
