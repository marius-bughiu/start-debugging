---
title: "Как восстановить состояние UI после остановки процесса Android во Flutter с помощью RestorationMixin"
description: "Android завершает фоновые приложения Flutter, чтобы освободить память, и когда пользователь возвращается, каждый StatefulWidget начинает с нуля. Здесь показано, как включить восстановление через restorationScopeId, RestorationMixin и свойства Restorable, восстановить текстовые поля, позиции прокрутки и открытые маршруты, написать собственный RestorableValue и протестировать всё это с помощью restartAndRestore и adb. Проверено на Flutter 3.44.8 и эмуляторе Android 16."
pubDate: 2026-10-19
template: how-to
tags:
  - "flutter"
  - "dart"
  - "android"
  - "state-restoration"
  - "how-to"
lang: "ru"
translationOf: "2026/10/how-to-restore-ui-state-after-android-process-death-in-flutter-with-restorationmixin"
translatedBy: "claude"
translationDate: 2026-10-19
---

**Коротко:** задайте `restorationScopeId: 'app'` у `MaterialApp`, подмешайте `RestorationMixin` в каждый `State`, который хранит то, что пользователю будет жаль потерять, храните эти данные в `RestorableInt`, `RestorableTextEditingController`, `RestorableEnum` и им подобных вместо обычных полей, зарегистрируйте каждое из них в `restoreState` и открывайте экраны через `Navigator.restorablePush` вместо `Navigator.push`. Тогда Flutter сериализует эти значения в `Bundle` сохранённого состояния экземпляра Android, а когда Android пересоздаёт activity в новом процессе, фреймворк возвращает значения на место до первого кадра. Всё описанное ниже проверено на Flutter 3.44.8 (Dart 3.12.2) с помощью виджет-тестов и реальных завершений процесса на эмуляторе Android 16 (API 36); файл `restoration.dart` в ветке `stable` не менялся с июля 2025 года.

Дальше в статье объясняется, что такое остановка процесса и почему ваше состояние исчезает, собирается небольшая форма заказа, которая это переживает, разбираются маршруты и позиции прокрутки, показано, как написать `RestorableValue` для собственного класса, и перечислены подводные камни, с которыми я столкнулся при тестировании, включая один, при котором `restorablePush` не работает, пока не вынести построитель маршрута в функцию верхнего уровня.

## Что такое остановка процесса и почему состояние Flutter её не переживает

Когда пользователь переключается из вашего приложения, Android останавливает activity, но оставляет процесс. Если памяти становится мало, система завершает этот фоновый процесс. Пользователю об этом не сообщается: приложение по-прежнему отображается в списке недавних со своим последним снимком экрана. Когда пользователь нажимает на него, Android запускает новый процесс, создаёт новую `FlutterActivity` и передаёт ей `Bundle`, который старая activity записала в `onSaveInstanceState`.

Приложение Flutter хранит всё состояние UI в объектах Dart в куче умершего процесса. Новый процесс означает новый изолят Dart, новый `main()` и новые объекты `State`. Если никто не записал ваши счётчики, поля формы и стек навигации в этот `Bundle`, они потеряны, а пользователь оказывается на главном экране с пустой формой. Это классический баг "я сделал фото, вернулся, и приложение всё забыло".

Фреймворк восстановления состояния Flutter как раз и пишет в этот `Bundle`. На Android `FlutterActivityAndFragmentDelegate` сохраняет сериализованные данные фреймворка как массив байтов под ключом `"framework"` (а состояние плагинов под ключом `"plugins"`). Ничего не сохраняется, пока дерево виджетов явно не включило эту возможность, поэтому большинство приложений даже не подозревает о её существовании.

Две ситуации, которые *не* являются остановкой процесса и поэтому по замыслу ничего не восстанавливают:

- Пользователь смахивает приложение из списка недавних. Задача удаляется вместе с сохранённым состоянием.
- Приложение принудительно остановлено (через Настройки или `adb shell am force-stop`). Результат тот же.

Оба случая я проверил на эмуляторе ниже. Восстановление нужно только для ситуации "система завершила меня, пока я был в фоне".

## Три составляющие для включения восстановления

Восстановление состояния представляет собой дерево из `RestorationBucket`. Каждый узел дерева запрашивает у родителя корзину по идентификатору, а конечные значения хранятся внутри этих корзин. Вам нужно:

1. **Корневая область.** `MaterialApp(restorationScopeId: 'app')` (или `CupertinoApp`, `WidgetsApp`) создаёт `RootRestorationScope` и заодно включает восстановление для `Navigator` приложения. Без неё записывать некуда, и каждый потомок получает `null`.
2. **`RestorationMixin` в вашем `State`.** Он запрашивает дочернюю корзину по геттеру `restorationId`, который вы переопределяете.
3. **Restorable-свойства.** Подклассы `RestorableProperty<T>` оборачивают значение и умеют превращать его в примитивы, которые может закодировать `StandardMessageCodec`. Каждое из них вы регистрируете под уникальным ключом внутри корзины.

## Минимальная форма заказа, которая переживает остановку процесса

Вот экран, который я использовал во всех тестах в этой статье. В нём есть количество, флажок, перечисление, два текстовых поля и длинный список, а также одно обычное поле `int` для сравнения.

```dart
// Flutter 3.44.8, Dart 3.12
import 'package:flutter/material.dart';

void main() => runApp(const App());

class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      restorationScopeId: 'app',
      home: OrderPage(),
    );
  }
}

enum Shipping { standard, express }

class OrderPage extends StatefulWidget {
  const OrderPage({super.key});

  @override
  State<OrderPage> createState() => _OrderPageState();
}

class _OrderPageState extends State<OrderPage> with RestorationMixin {
  final RestorableInt _quantity = RestorableInt(1);
  final RestorableBool _giftWrap = RestorableBool(false);
  final RestorableEnum<Shipping> _shipping =
      RestorableEnum(Shipping.standard, values: Shipping.values);
  final RestorableTextEditingController _note = RestorableTextEditingController();
  int _plainCounter = 0; // not restorable, for contrast

  @override
  String? get restorationId => 'order_page';

  @override
  void restoreState(RestorationBucket? oldBucket, bool initialRestore) {
    registerForRestoration(_quantity, 'quantity');
    registerForRestoration(_giftWrap, 'gift_wrap');
    registerForRestoration(_shipping, 'shipping');
    registerForRestoration(_note, 'note');
  }

  @override
  void dispose() {
    _quantity.dispose();
    _giftWrap.dispose();
    _shipping.dispose();
    _note.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Order')),
      body: ListView(
        restorationId: 'order_list',
        children: [
          ListTile(
            title: Text('Quantity: ${_quantity.value}'),
            trailing: IconButton(
              icon: const Icon(Icons.add),
              onPressed: () => setState(() => _quantity.value++),
            ),
          ),
          CheckboxListTile(
            title: const Text('Gift wrap'),
            value: _giftWrap.value,
            onChanged: (v) => setState(() => _giftWrap.value = v ?? false),
          ),
          SwitchListTile(
            title: Text('Shipping: ${_shipping.value.name}'),
            value: _shipping.value == Shipping.express,
            onChanged: (v) => setState(() =>
                _shipping.value = v ? Shipping.express : Shipping.standard),
          ),
          TextField(
            controller: _note.value,
            decoration: const InputDecoration(labelText: 'Note'),
          ),
          TextField(
            restorationId: 'coupon',
            decoration: const InputDecoration(labelText: 'Coupon'),
          ),
          // ... more rows
        ],
      ),
    );
  }
}
```

Несколько моментов, на которые стоит обратить внимание:

- Вы читаете и записываете `.value` и по-прежнему вызываете `setState`. `RestorableValue` уведомляет миксин, чтобы корзина обновилась, но не перестраивает ваш виджет.
- `restoreState` это единственное место, где вызывается `registerForRestoration`. Фреймворк вызывает его один раз при первой сборке (с `initialRestore: true`) и снова всякий раз, когда корзина подменяется. Регистрация свойства загружает сохранённое значение, если оно есть, или значение по умолчанию, если нет.
- Restorable-свойства это `ChangeNotifier`. Освобождайте их в `dispose()`, после чего `RestorationMixin` сам завершает свою внутреннюю бухгалтерию в `super.dispose()`.
- `RestorableTextEditingController` через `.value` отдаёт настоящий `TextEditingController`. Если вам нужен только текст, а не контроллер, `TextField(restorationId: 'coupon')` делает то же самое внутри. Встроенные виджеты, принимающие `restorationId`: `TextField`, `TextFormField`, виджеты на основе `Scrollable` (`ListView`, `GridView`, `CustomScrollView`, `SingleChildScrollView`, `PageView`), `Scaffold` (состояние открытости выдвижной панели), `FormField`, `DropdownMenu`, а также выбор даты и времени.

## Проверка реальным завершением процесса

Виджет-тесты быстрые, но доказать нужно другое: что состояние переживает настоящее завершение процесса. Я собрал релизный APK приведённого выше приложения, установил его на эмулятор arm64 с API 36, заполнил форму и затем имитировал гибель при нехватке памяти:

```bash
# Flutter 3.44.8 release APK on an Android 16 (API 36) emulator
flutter build apk --release
adb install -r build/app/outputs/flutter-apk/app-release.apk
# ...interact with the app, then send it to the background:
adb shell input keyevent KEYCODE_HOME
adb shell am kill net.startdebugging.restore_demo     # only kills background processes
adb shell pidof net.startdebugging.restore_demo        # prints nothing: the process is gone
adb shell am start -n net.startdebugging.restore_demo/.MainActivity
```

`am start` вывел "Activity not started, its current task has been brought to the front", что в точности соответствует нажатию в списке недавних. У нового процесса другой PID (5813 до, 6210 после). На экране:

| Поле | До завершения | После завершения |
| --- | --- | --- |
| `RestorableInt` quantity | 3 | 3 |
| обычный счётчик `int` | 1 | 0 |
| `RestorableBool` gift wrap | включён | включён |
| `RestorableEnum` shipping | express | express |
| `RestorableTextEditingController` note | "leave at door" | "leave at door" |
| `TextField(restorationId:)` coupon | "SAVE10" | "SAVE10" |
| `TextField` без restorationId | "gone" | пусто |
| прокрутка `ListView(restorationId:)` | прокручен | то же смещение |

Затем негативные случаи на той же сборке: смахивание задачи из списка недавних и повторный запуск дали quantity 1, и `am force-stop` с последующим запуском тоже. Как и ожидалось, восстанавливается только гибель, инициированная системой.

Можно также включить **Developer options > Don't keep activities** (`adb shell settings put global always_finish_activities 1`). Это уничтожает activity, как только вы её покидаете, но оставляет процесс живым (в моём запуске PID не изменился), и состояние восстановилось так же. Это удобная ручная проверка, но `am kill` ближе к настоящей остановке процесса, потому что он ещё и уничтожает кучу Dart.

## Восстановление стека навигации

`Navigator` приложения восстанавливает историю маршрутов автоматически, как только задан `restorationScopeId`, но только для тех маршрутов, которые он может пересоздать. Маршрут, открытый через `Navigator.push(context, MaterialPageRoute(...))`, держит замыкание, а замыкания нельзя сериализовать. Используйте `restorablePush`, который принимает статическую функцию или функцию верхнего уровня и аргументы, которые умеет кодировать `StandardMessageCodec`:

```dart
// Flutter 3.44.8
@pragma('vm:entry-point')
Route<void> _summaryRoute(BuildContext context, Object? arguments) {
  return MaterialPageRoute<void>(
    builder: (_) => SummaryPage(quantity: arguments! as int),
  );
}

// in the button's onPressed:
Navigator.restorablePush(context, _summaryRoute, arguments: _quantity.value);
```

Тот же эмулятор, та же последовательность завершения: после `restorablePush` приложение вернулось на страницу Summary с надписью "Ordering 3". После обычного `push` оно вернулось на страницу Order, а страница Summary была молча потеряна.

Именованные маршруты работают так же через `Navigator.restorablePushNamed`. Если вы открываете маршрут и вам нужен его результат, оберните его в `RestorableRouteFuture<T>` и зарегистрируйте как любое другое свойство, чтобы обратный вызов `onComplete` был заново подключён после восстановления. Диалоги `showDatePicker` и `showTimePicker` восстанавливаются тем же механизмом, если открывать их через `RestorableRouteFuture` и задавать `restorationId` у `DatePickerDialog`.

С go_router передайте `restorationScopeId` в конструктор `GoRouter` и в `MaterialApp.router`, а для вложенных навигаторов задайте `ShellRoute` собственный `restorationScopeId`. go_router сам создаёт объекты `Page`, поэтому `restorablePush` там вызывать не нужно, но прежде чем доверять результату, запустите тест `restartAndRestore` (ниже) на вашей реальной таблице маршрутов.

## Собственный RestorableValue для вашего типа

Встроенные классы покрывают примитивы (`RestorableInt`, `RestorableDouble`, `RestorableString`, `RestorableBool` и их варианты `N`, допускающие null), `RestorableDateTime`, `RestorableEnum`, `RestorableTimeOfDay` и `RestorableTextEditingController`. Для всего остального создайте подкласс `RestorableValue<T>` и преобразуйте значение в типы, которые поддерживает `StandardMessageCodec`, и обратно (null, bool, num, String, `Uint8List` и родственные, `List`, `Map`):

```dart
// Flutter 3.44.8
class PriceFilter {
  const PriceFilter({required this.min, required this.max, required this.inStockOnly});
  final double min;
  final double max;
  final bool inStockOnly;
}

class RestorablePriceFilter extends RestorableValue<PriceFilter> {
  RestorablePriceFilter(this._defaultValue);
  final PriceFilter _defaultValue;

  @override
  PriceFilter createDefaultValue() => _defaultValue;

  @override
  void didUpdateValue(PriceFilter? oldValue) => notifyListeners();

  @override
  PriceFilter fromPrimitives(Object? data) {
    final map = (data! as Map<Object?, Object?>).cast<String, Object?>();
    return PriceFilter(
      min: map['min']! as double,
      max: map['max']! as double,
      inStockOnly: map['inStock']! as bool,
    );
  }

  @override
  Object toPrimitives() => <String, Object>{
        'min': value.min,
        'max': value.max,
        'inStock': value.inStockOnly,
      };
}
```

Две детали, на которых спотыкаются. `didUpdateValue` должен вызывать `notifyListeners()`, иначе миксин не узнает, что значение изменилось, и корзина сохранит старые данные. И карта приходит как `Map<Object?, Object?>`, а не `Map<String, Object>`, поэтому приводите её через `cast`, а не через `as Map<String, Object>`, который выбрасывает исключение. В виджет-тесте установка фильтра в `min: 10, max: 50, inStockOnly: true` и перезапуск вывели после восстановления `50.0 true`.

## Тестирование восстановления без устройства

`flutter_test` умеет имитировать весь цикл целиком. `restartAndRestore` берёт текущие данные восстановления, уничтожает дерево виджетов и пересобирает его из этих данных, что соответствует стороне Dart при перезапуске процесса:

```dart
// Flutter 3.44.8, flutter_test
testWidgets('order state survives restart', (tester) async {
  await tester.pumpWidget(const App());
  await tester.tap(find.byIcon(Icons.add));
  await tester.tap(find.byIcon(Icons.add));
  await tester.pump();

  await tester.restartAndRestore();

  expect(find.text('Quantity: 3'), findsOneWidget);
});
```

Результаты в точности совпали с эмулятором: restorable-поля и смещение `ListView` (580.0 до, 580.0 после) вернулись, обычный счётчик и незарегистрированный `TextField` нет, а маршрут из `restorablePush` пережил перезапуск, тогда как маршрут из `push` нет. Если тест падает с сообщением "The current widget tree did not inject the root bucket of the RestorationManager", значит, вы забыли `restorationScopeId` у приложения.

## Подводные камни, с которыми я столкнулся при тестировании

**`restorablePush` со статическим методом может зависнуть в тесте.** В документации Flutter построитель маршрута показан как `static`-метод класса `State` с `@pragma('vm:entry-point')`. На Flutter 3.44.8 у меня это упало под `flutter test` с сообщением "To access 'package:restore_demo/main.dart::_OrderPageState' from native code, it must be annotated", а тест так и не завершился. VM определяет дескриптор обратного вызова через охватывающий класс, поэтому pragma нужен и классу. Либо аннотируйте класс `State` тоже через `@pragma('vm:entry-point')`, либо, проще, сделайте построитель функцией верхнего уровня, как показано выше. Оба варианта прошли.

**Дублирующиеся идентификаторы падают во время выполнения.** Два виджета, запрашивающие один и тот же `restorationId` у одной родительской корзины, выбрасывают "Multiple owners claimed child RestorationBuckets with the same IDs" в конце кадра. В списках формируйте идентификатор из стабильного ключа элемента (`'item_${item.id}'`), а не из индекса, либо оборачивайте каждое поддерево в собственный `RestorationScope`.

**Нет корневой области: нет ошибки, но нет и восстановления.** Без `restorationScopeId` ваш `restoreState` всё равно вызывается, с `bucket == null`, а свойства работают как обычные значения в памяти. Ничто не сообщает, что они не сохраняются. Один тест `restartAndRestore` это выявляет.

**Держите данные небольшими.** Байты проходят через `Bundle` сохранённого состояния экземпляра Android, а он пересекает транзакцию Binder. Большой объём вызывает `TransactionTooLargeException`. Храните идентификаторы и введённые в форму данные, а не списки загруженных записей; после восстановления загружайте данные из репозитория заново.

**Кешированные движки по умолчанию не восстанавливаются.** В сценариях add-to-app с `FlutterActivity.withCachedEngine` метод `shouldRestoreAndSaveState()` возвращает `false`, чтобы данные восстановления не перезаписывали состояние живого движка. Переопределите его в вашем наследнике `FlutterActivity`, если хотите восстановление и там.

**Восстановление это не сохранение данных.** Оно переживает остановку процесса, но не выход из приложения, перезагрузку или смахивание из списка недавних. Черновики, которые пользователь ожидает найти завтра, относятся к `shared_preferences` или базе данных.

**Для iOS нужна дополнительная настройка.** Тот же код Dart работает на iOS, но в проекте iOS нужно ещё задать `FlutterViewController` идентификатор восстановления. Шаги описаны на официальной странице "Restore state on iOS".

**Riverpod, Bloc и другие хранилища состояния за вас не восстанавливаются.** Состояние провайдера живёт в той же куче Dart, которая умерла. Либо восстанавливайте входные данные (идентификаторы, фильтры, поля формы) через restorable-свойства и позволяйте провайдеру пересчитаться, либо сохраняйте сериализованное состояние провайдера в `RestorableValue` и подставляйте его при восстановлении.

## Что почитать дальше

- [Fix: A TextEditingController was used after being disposed in Flutter](/ru/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/)
- [How to set up nested routes and deep links with go_router in Flutter](/ru/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/)
- [go_router vs auto_route vs Navigator 2.0 in Flutter](/ru/2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter/)
- [Migrate a setState StatefulWidget to a Riverpod Notifier in Flutter](/ru/2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter/)
- [How to catch uncaught async errors in Flutter with runZonedGuarded and PlatformDispatcher](/ru/2026/10/how-to-catch-uncaught-async-errors-in-flutter-with-runzonedguarded-and-platformdispatcher/)

## Источники

- [Restore state on Android, Flutter docs](https://docs.flutter.dev/platform-integration/android/restore-state-android)
- [Restore state on iOS, Flutter docs](https://docs.flutter.dev/platform-integration/ios/restore-state-ios)
- [RestorationMixin, Flutter API docs](https://api.flutter.dev/flutter/widgets/RestorationMixin-mixin.html)
- [RestorableValue, Flutter API docs](https://api.flutter.dev/flutter/widgets/RestorableValue-class.html)
- [Navigator.restorablePush, Flutter API docs](https://api.flutter.dev/flutter/widgets/Navigator/restorablePush.html)
- [WidgetTester.restartAndRestore, Flutter API docs](https://api.flutter.dev/flutter/flutter_test/WidgetTester/restartAndRestore.html)
- [GoRouter constructor, go_router API docs](https://pub.dev/documentation/go_router/latest/go_router/GoRouter/GoRouter.html)
- [Save UI states, Android Developers](https://developer.android.com/topic/libraries/architecture/saving-states)
