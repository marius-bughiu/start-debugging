---
title: "Перенос StatefulWidget с setState на Notifier из Riverpod во Flutter"
description: "Пошаговый переход от локального setState виджета к Notifier из Riverpod 3.x: как разделить состояние, написать Notifier, перейти на ConsumerWidget и пережить фильтрацию по ==, повторный вызов build() и разные значения autoDispose по умолчанию. Проверено на Flutter 3.44, Dart 3.x и flutter_riverpod 3.3.2."
pubDate: 2026-07-25
updatedDate: 2026-07-25
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
lang: "ru"
translationOf: "2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-25
---

Перенос одного экрана с `setState` на `Notifier` из Riverpod занимает около часа, если вы уже делали это дважды, и большая часть этого часа уходит на решение, что переносить **не** нужно. Руководство проверено на Flutter 3.44 (стабильный, май 2026), Dart 3.x и `flutter_riverpod` 3.3.2, а для варианта с генерацией кода на `riverpod_generator` 4.0.4 и `riverpod_annotation` 4.0.3. Ломается редко компилятор: по-настоящему кусаются три вещи. Riverpod 3.0 фильтрует уведомления по `==` (то есть изменение списка на месте, которое сходило с рук при `setState`, теперь молча перестаёт перестраивать интерфейс), `Notifier.build()` вызывается повторно там, где `initState` выполнялся один раз, и автоматическое освобождение по умолчанию работает по-разному для сгенерированных и написанных вручную провайдеров. Делайте это, когда одно и то же состояние нужно двум виджетам или когда вы хотите тестировать логику без виджета. Не делайте этого ради экрана, который владеет одним булевым флагом.

## Почему это состояние должно покинуть виджет

- **Два читателя, один источник.** Значок корзины в `AppBar` и экран корзины через два маршрута нуждаются в одних и тех же позициях. С `setState` вы либо поднимаете состояние к общему предку и протаскиваете колбэки вниз, либо держите две копии и надеетесь, что они совпадут.
- **Логика становится пригодной для модульных тестов.** `Notifier` это обычный объект Dart. Им можно управлять из `ProviderContainer.test()` в обычном блоке `test()`, без `pumpWidget`, без `WidgetTester` и без планирования кадров.
- **Состояние переживает маршрут, когда вам это нужно.** `NotifierProvider` сохраняет значение после `Navigator.pop`, а именно это и требуется корзине, черновику формы или многошаговому мастеру. Состояние виджета умирает вместе с элементом.
- **У изменений появляются имена.** `setState(() => _lines = [..._lines, line])`, разбросанный по шести колбэкам, превращается в `cartProvider.notifier.add(line)`, то есть в единственное место для журналирования, проверок или ограничения частоты.

Ничто из этого не оправдывает перенос всего подряд. `TextEditingController`, `AnimationController`, `FocusNode`, `ScrollController` и `GlobalKey<FormState>` принадлежат виджету и должны остаться в объекте `State`.

## Что ломается

| Область | Изменение | Серьёзность |
| ------- | --------- | ----------- |
| Базовый класс виджета | `StatefulWidget` становится `ConsumerWidget` или `ConsumerStatefulWidget`, если контроллеры остаются | высокая |
| Изменение коллекции на месте | Riverpod 3.0 фильтрует по `==`; `state.add(x)` с последующим `state = state` не вызывает перестроение | высокая |
| Вызовы `setState` | Заменяются присваиванием `state` внутри `Notifier` | высокая |
| `initState` | Переезжает в `Notifier.build()`, который может выполниться не один раз | средняя |
| `dispose` | Переходит в `ref.onDispose`, только для ресурсов провайдера | средняя |
| Время жизни состояния | Сгенерированные провайдеры освобождаются автоматически, написанные вручную нет | средняя |
| `context` после `await` | `context.mounted` внутри виджета становится `ref.mounted` внутри notifier | средняя |
| Тесты виджетов | `pumpWidget` требует обёртки `ProviderScope`, иначе каждое чтение выбрасывает исключение | низкая |

## Подготовительный список

1. Flutter 3.44 стабильный и Dart 3.x на машине и в CI (`flutter --version`).
2. `flutter_riverpod: ^3.3.2` в `pubspec.yaml` и `ProviderScope`, оборачивающий `runApp`. Если вы всё ещё на 2.x, сначала выполните это обновление отдельно: смотрите [переход с Riverpod 2.x на Riverpod 3.0](/ru/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/).
3. Решите про генерацию кода сейчас, а не на полпути. Для неё нужны `riverpod_annotation: ^4.0.3`, а также `riverpod_generator: ^4.0.4` и `build_runner` в `dev_dependencies`.
4. `riverpod_lint` и `custom_lint` включены в `analysis_options.yaml`. Они ловят `ref.read` внутри метода `build`, а это самая частая ошибка этого переноса.
5. Тест виджета, фиксирующий текущее поведение экрана до того, как вы его тронете. Нужен сигнал красный/зелёный, а не ощущение.
6. Отдельная ветка. Перенос обратим, но не тремя маленькими коммитами.

## Отправная точка

Экран корзины, который держит всё в `State`, с колбэком, протащенным до дочернего виджета, чтобы значок мог обновляться:

```dart
// Flutter 3.44, Dart 3.x -- before
class CartScreen extends StatefulWidget {
  const CartScreen({super.key});
  @override
  State<CartScreen> createState() => _CartScreenState();
}

class _CartScreenState extends State<CartScreen> {
  List<CartLine> _lines = const [];
  bool _isSubmitting = false;
  final _couponController = TextEditingController();

  @override
  void initState() {
    super.initState();
    _lines = CartStorage.instance.load();
  }

  @override
  void dispose() {
    _couponController.dispose();
    super.dispose();
  }

  void _add(CartLine line) {
    setState(() => _lines = [..._lines, line]);
  }

  void _setQuantity(String sku, int quantity) {
    setState(() {
      _lines = [
        for (final l in _lines)
          if (l.sku == sku) l.copyWith(quantity: quantity) else l,
      ];
    });
  }

  Future<void> _submit() async {
    setState(() => _isSubmitting = true);
    await CheckoutApi.submit(_lines);
    if (!mounted) return;
    setState(() => _isSubmitting = false);
  }

  @override
  Widget build(BuildContext context) => CartView(
        lines: _lines,
        isSubmitting: _isSubmitting,
        couponController: _couponController,
        onQuantityChanged: _setQuantity,
      );
}
```

## Шаги переноса

1. **Разберите каждое поле объекта `State`.** Разделите их на два списка на бумаге, прежде чем писать код. Доменное состояние, которое правдоподобно может понадобиться другому виджету (`_lines`, `_isSubmitting`), переезжает в notifier. Объекты фреймворка, привязанные к элементу этого виджета (`_couponController`, focus node, контроллеры анимации, ключи формы), остаются. *Проверка:* каждое поле ровно в одном списке, и ничто из списка "остаётся" не читается другим маршрутом.

2. **Опишите состояние одним неизменяемым значением.** Два разрозненных поля превращаются в класс, чтобы одно присваивание `state` описывало весь экран. *Проверка:* `dart analyze` чист, у класса есть `copyWith`.

   ```dart
   // Flutter 3.44, Dart 3.x
   class CartState {
     const CartState({this.lines = const [], this.isSubmitting = false});
     final List<CartLine> lines;
     final bool isSubmitting;

     int get itemCount => lines.fold(0, (sum, l) => sum + l.quantity);

     CartState copyWith({List<CartLine>? lines, bool? isSubmitting}) =>
         CartState(
           lines: lines ?? this.lines,
           isSubmitting: isSubmitting ?? this.isSubmitting,
         );
   }
   ```

3. **Напишите `Notifier`.** `build()` возвращает начальное состояние и заменяет `initState`. Каждое прежнее замыкание `setState` становится публичным методом, который присваивает `state`. *Проверка:* файл компилируется без единой ссылки на `BuildContext`, `setState` или любой тип виджета.

   ```dart
   // flutter_riverpod 3.3.2 -- no codegen
   import 'package:flutter_riverpod/flutter_riverpod.dart';

   final cartProvider = NotifierProvider<CartNotifier, CartState>(
     CartNotifier.new,
   );

   class CartNotifier extends Notifier<CartState> {
     @override
     CartState build() => CartState(lines: CartStorage.instance.load());

     void add(CartLine line) {
       state = state.copyWith(lines: [...state.lines, line]);
     }

     void setQuantity(String sku, int quantity) {
       state = state.copyWith(
         lines: [
           for (final l in state.lines)
             if (l.sku == sku) l.copyWith(quantity: quantity) else l,
         ],
       );
     }

     Future<void> submit() async {
       state = state.copyWith(isSubmitting: true);
       await CheckoutApi.submit(state.lines);
       if (!ref.mounted) return;
       state = state.copyWith(isSubmitting: false);
     }
   }
   ```

   Вариант с генерацией кода это тот же класс с выведенным провайдером:

   ```dart
   // riverpod_annotation 4.0.3, riverpod_generator 4.0.4
   @Riverpod(keepAlive: true)
   class Cart extends _$Cart {
     @override
     CartState build() => CartState(lines: CartStorage.instance.load());
     // ...same methods
   }
   ```

4. **Покройте notifier модульными тестами до того, как тронете хоть один виджет.** Ради этого всё и затевалось, поэтому забирайте выигрыш сразу. *Проверка:* `flutter test test/cart_notifier_test.dart` проходит без единого отрисованного виджета.

   ```dart
   // flutter_riverpod 3.3.2
   test('setQuantity replaces the matching line', () {
     final container = ProviderContainer.test();
     container.read(cartProvider.notifier).add(const CartLine(sku: 'A', quantity: 1));
     container.read(cartProvider.notifier).setQuantity('A', 3);
     expect(container.read(cartProvider).itemCount, 3);
   });
   ```

5. **Переведите виджет.** Если после шага 1 в виджете ничего не осталось, `StatefulWidget` сжимается до `ConsumerWidget`, а `build` получает `WidgetRef`. Поскольку контроллер купона остался, этот экран становится `ConsumerStatefulWidget`. *Проверка:* `flutter analyze` сообщает о нуле замечаний, включая правила `riverpod_lint`.

   ```dart
   // Flutter 3.44, flutter_riverpod 3.3.2 -- after
   class CartScreen extends ConsumerStatefulWidget {
     const CartScreen({super.key});
     @override
     ConsumerState<CartScreen> createState() => _CartScreenState();
   }

   class _CartScreenState extends ConsumerState<CartScreen> {
     final _couponController = TextEditingController();

     @override
     void dispose() {
       _couponController.dispose();
       super.dispose();
     }

     @override
     Widget build(BuildContext context) {
       final cart = ref.watch(cartProvider);
       return CartView(
         lines: cart.lines,
         isSubmitting: cart.isSubmitting,
         couponController: _couponController,
         onQuantityChanged: (sku, qty) =>
             ref.read(cartProvider.notifier).setQuantity(sku, qty),
       );
     }
   }
   ```

6. **Примените правило watch/read в каждой точке вызова.** `ref.watch` в `build`, потому что перестроения нужны. `ref.read(provider.notifier)` в колбэках, потому что там они не нужны. Никогда не вызывайте `ref.watch` внутри `onPressed`. *Проверка:* найдите в файле `ref.read(` и убедитесь, что каждое вхождение находится в колбэке или асинхронном методе, но не в `build`.

7. **Удалите протащенные колбэки и позвольте другому виджету наблюдать напрямую.** Именно этот шаг окупает перенос. Значок перестаёт получать счётчик через три конструктора и читает провайдер сам. *Проверка:* промежуточные виджеты больше не объявляют удалённые параметры, а добавление товара с экрана корзины обновляет значок на другом маршруте.

   ```dart
   // flutter_riverpod 3.3.2
   class CartBadge extends ConsumerWidget {
     const CartBadge({super.key});
     @override
     Widget build(BuildContext context, WidgetRef ref) {
       final count = ref.watch(cartProvider.select((s) => s.itemCount));
       return Badge(label: Text('$count'));
     }
   }
   ```

   `select` здесь важен. Без него значок перестраивается при каждом переключении `isSubmitting`, чего при `setState` не было вовсе, потому что он даже не находился в этом поддереве.

8. **Перенесите очистку ресурсов провайдера в `ref.onDispose`.** Всё, что создал notifier (`StreamSubscription`, таймер, сокет), освобождается там, а не в `dispose` виджета. *Проверка:* уйдите с экрана и вернитесь, убедитесь, что в журнале нет дублирующихся подписок.

   ```dart
   @override
   CartState build() {
     final sub = PriceFeed.stream.listen(_onPriceChanged);
     ref.onDispose(sub.cancel);
     return CartState(lines: CartStorage.instance.load());
   }
   ```

## Проверка

Пройдите этот список перед слиянием:

- `flutter analyze` сообщает о нуле замечаний при включённом `riverpod_lint`.
- `flutter test` проходит, а тесты виджетов теперь оборачивают экран в `ProviderScope`. Без него первый же `ref.watch` выбросит исключение во время выполнения, а не при компиляции.
- Экран строится, и каждое взаимодействие, раньше использовавшее `setState`, по-прежнему обновляет интерфейс. Пройдите по всем; отказ из-за фильтрации по `==` (смотрите ниже) не даёт никакой ошибки, только застывший виджет.
- Откройте экран, закройте и откройте снова. Убедитесь, что сохранение состояния соответствует замыслу, а не случайности.
- Проверка в режиме profile через DevTools: число перестроений родителя должно остаться прежним или снизиться. Если оно выросло, не хватает `select`.

## План отката

Перенос обратим через `git revert`, если вы держали его в отдельной ветке, потому что на диске и в сети ничего не меняется. Откат не восстановит только поведение, зависевшее от нового времени жизни: если вы уже выпустили версию и пользователи привыкли, что корзина переживает возврат назад, откат к локальному состоянию виджета молча теряет её при `pop`. Верните код и заново проверьте сценарии навигации, а не только сборку.

## Подводные камни, на которые мы наткнулись

**Изменение на месте перестало вызывать перестроение.** При `setState` вызов `_lines.add(line)` внутри замыкания работал, потому что `setState` помечает элемент грязным независимо от того, что изменилось. Riverpod 3.0 сравнивает старое и новое состояние через `==` и пропускает уведомление, если они равны, поэтому вот это не делает ровно ничего:

```dart
// broken on flutter_riverpod 3.x
void add(CartLine line) {
  state.lines.add(line); // mutates the same List instance
  state = state;         // identical, == is true, no listeners notified
}
```

Всегда стройте новое значение, как в шаге 3. Это та же самая фильтрация по равенству, которая застаёт врасплох, когда [StreamProvider в Riverpod 3.0 перестаёт выдавать события](/ru/2026/07/fix-riverpod-3-0-streamprovider-stops-emitting-filtered-by-equality/). Здесь она бьёт сильнее, если ваш класс состояния использует `equatable` или тип-значение из `freezed`, потому что тогда даже корректно пересозданный объект с неизменным содержимым будет отфильтрован.

**`build()` это не `initState`.** `initState` выполняется один раз на элемент. `Notifier.build()` выполняется заново при каждом изменении наблюдаемой зависимости и сбрасывает `state` в то, что он вернёт. Если вызвать `ref.watch(authProvider)` внутри `build()`, обновление токена сотрёт корзину. Используйте `ref.read` для значений, нужных только при инициализации, а `ref.watch` в `build()` оставьте для зависимостей, которые действительно должны сбрасывать состояние.

**Значения автоматического освобождения по умолчанию различаются в двух синтаксисах.** Написанный вручную `NotifierProvider(CartNotifier.new)` по умолчанию остаётся живым; включить освобождение можно через `isAutoDispose: true`. Сгенерированный провайдер `@riverpod` по умолчанию освобождается автоматически; отключить это можно через `@Riverpod(keepAlive: true)`. Команды, использующие обе формы в одной кодовой базе, получают корзину, которая на одних экранах очищается сама, а на других нет, и никакой ошибки, объясняющей это, не будет.

**`mounted` переехал.** Внутри виджета вы по-прежнему используете `context.mounted` и обычную [проверку `mounted` после асинхронного разрыва](/ru/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/). Внутри notifier нет `BuildContext`, поэтому проверка это [`ref.mounted` после await](/ru/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/). Забыв о ней, вы получите исключение, если провайдер был освобождён, пока запрос был в полёте.

**Контроллерам не место в notifier.** Положить `TextEditingController` в состояние провайдера выглядит аккуратно ровно до момента, когда провайдер переживёт виджет и вы будете печатать в контроллер, слушателей у которого уже нет. Оставьте [правила освобождения контроллеров](/ru/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) ровно там, где они были.

## Связанные материалы

- [Provider против Riverpod против Bloc для управления состоянием во Flutter в 2026](/ru/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/), если вы ещё выбираете цель.
- [Переход с Riverpod 2.x на Riverpod 3.0](/ru/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/), обновление, которое стоит сделать раньше этого.
- [Переход с FutureBuilder на AsyncNotifier из Riverpod](/ru/2026/06/migrate-from-futurebuilder-to-a-riverpod-asyncnotifier-in-flutter/), асинхронный аналог этого переноса.
- [Какой пакет Riverpod вам действительно нужен](/ru/2026/07/riverpod-vs-flutter-riverpod-vs-hooks-riverpod-which-package-do-i-need/), потому что `riverpod` и `flutter_riverpod` невзаимозаменяемы.
- [Показ состояний загрузки и ошибок через AsyncValue](/ru/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/), когда notifier начнёт работать с вводом-выводом.

## Источники

- [Что нового в Riverpod 3.0](https://riverpod.dev/docs/whats_new) про единый `Ref`, `ref.mounted`, `ProviderContainer.test()` и фильтрацию уведомлений по `==`.
- [Справочник по провайдерам Riverpod](https://riverpod.dev/docs/concepts2/providers) про контракт `Notifier` и `build()`.
- [Автоматическое освобождение в Riverpod](https://riverpod.dev/docs/concepts2/auto_dispose) про `isAutoDispose` и `ref.keepAlive()`.
- [Переход с 2.0 на 3.0](https://riverpod.dev/docs/3.0_migration) про удаление интерфейсов `AutoDispose`.
- [flutter_riverpod на pub.dev](https://pub.dev/packages/flutter_riverpod) и [riverpod_generator на pub.dev](https://pub.dev/packages/riverpod_generator) про версии 3.3.2 и 4.0.4.
- [Заметки о выпусках Flutter](https://docs.flutter.dev/release/release-notes) про базовую версию 3.44 стабильную.
