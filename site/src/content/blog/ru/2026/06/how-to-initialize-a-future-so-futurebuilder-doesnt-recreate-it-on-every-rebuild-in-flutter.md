---
title: "Как инициализировать Future, чтобы FutureBuilder не пересоздавал его при каждой перестройке во Flutter"
description: "FutureBuilder заново выполняет асинхронную работу при каждой перестройке родителя, потому что вы создали Future внутри build. Перенесите его в State.initState (или мемоизируйте), и FutureBuilder будет переиспользовать тот же Future. Здесь объяснение причины, воспроизводимый пример и каждый кусачий вариант."
pubDate: 2026-06-09
template: how-to
tags:
  - "flutter"
  - "dart"
  - "futurebuilder"
  - "how-to"
lang: "ru"
translationOf: "2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-09
---

Если ваш `FutureBuilder` мигает обратно к индикатору загрузки, повторно загружает данные или запускает один и тот же сетевой вызов несколько раз, причина почти всегда в том, что вы создали `Future` внутри `build`. Каждая перестройка окружающего виджета затем снова вызывает `build`, конструирует совершенно новый `Future`, и `FutureBuilder` послушно его перезапускает. Решение в том, чтобы создать `Future` ровно один раз, сохранить его в поле вашего `State` и передать это сохранённое поле в `FutureBuilder`. Это руководство использует Flutter 3.44 (стабильная версия, май 2026) и Dart 3.x.

Команда Flutter явно говорит об этом в [документации API FutureBuilder](https://api.flutter.dev/flutter/widgets/FutureBuilder-class.html): "The future must have been obtained earlier, e.g. during State.initState, State.didUpdateWidget, or State.didChangeDependencies. It must not be created during the State.build or StatelessWidget.build method call when constructing the FutureBuilder." Причина следует сразу же: "If the future is created at the same time as the FutureBuilder, then every time the FutureBuilder's parent is rebuilt, the asynchronous task will be restarted." Это и есть весь баг, сформулированный самим фреймворком.

## Почему свежий Future перезапускает всё целиком

`FutureBuilder` не отслеживает "операцию, которую вы хотели выполнить". Он отслеживает конкретный объект `Future` по идентичности. В `didUpdateWidget` он сравнивает `oldWidget.future` с новым `widget.future`. Если это не один и тот же экземпляр, он отбрасывает старую подписку, сбрасывает свой `AsyncSnapshot` в `ConnectionState.waiting` (или `none`) и подписывается на новый. Здесь нет дедупликации по значению и нет встроенной мемоизации. Идентичность -- единственный сигнал, который у него есть.

Теперь подумайте о том, что делает `build`. Вызов `something()`, возвращающего `Future`, порождает новый экземпляр `Future` при каждом вызове, даже если лежащая в основе работа идентична. `Future.delayed(...)`, `http.get(...)`, `repository.load()` -- каждый вызов выделяет отдельный объект. Поэтому если аргумент `future:` -- это выражение, вычисляемое внутри `build`, `FutureBuilder` видит другую идентичность в каждом кадре и заключает, корректно по своим собственным правилам, что вы передали ему новую задачу.

А `build` выполняется гораздо чаще, чем ожидают. `setState` родителя, изменение наследуемого виджета (`MediaQuery` при повороте, `Theme` при переключении яркости), `Scaffold`, открывающий клавиатуру, анимация предка, hot reload -- любое из этого перестраивает ваш виджет и заново вычисляет выражение `future:`. Асинхронная работа не медленная и не сломанная. Её отбрасывают и перезапускают с нуля каждый раз.

## Минимальный воспроизводимый пример, который перезагружает при каждой перестройке

Вот антипаттерн в чистейшем виде. `Future` конструируется встроенно внутри `build`, а счётчик принудительно вызывает перестройки, чтобы вы могли наблюдать его неправильное поведение.

```dart
// Flutter 3.44, Dart 3.x
// BROKEN: future is created inside build()
class ProfilePage extends StatefulWidget {
  const ProfilePage({super.key});
  @override
  State<ProfilePage> createState() => _ProfilePageState();
}

class _ProfilePageState extends State<ProfilePage> {
  int _counter = 0;

  Future<String> _loadName() async {
    // Pretend this is a network call.
    await Future<void>.delayed(const Duration(seconds: 2));
    return 'Marius';
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        FutureBuilder<String>(
          // New Future every build -> restarts every rebuild.
          future: _loadName(),
          builder: (context, snapshot) {
            if (snapshot.connectionState != ConnectionState.done) {
              return const CircularProgressIndicator();
            }
            return Text('Hello, ${snapshot.data}');
          },
        ),
        ElevatedButton(
          onPressed: () => setState(() => _counter++),
          child: Text('Rebuilt $_counter times'),
        ),
      ],
    );
  }
}
```

Нажмите на кнопку. Каждое нажатие вызывает `setState`, который вызывает `build`, который снова вызывает `_loadName()`, который возвращает новый двухсекундный `Future`. Индикатор возвращается при каждом нажатии. В реальном приложении, где `_loadName()` -- это HTTP-запрос, вы только что превратили одну загрузку в одну-загрузку-на-перестройку, и пользователь видит, как экран многократно мигает белым. Это та же семья ошибок, что и [вызов setState во время build](/ru/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/): выполнение в `build` работы, которой `build` не имеет права владеть.

## Решение, шаг за шагом

Вынесите `Future` из `build` в поле, которое инициализируется ровно один раз.

1. **Преобразуйте виджет в `StatefulWidget`**, если он ещё не является им. У `StatelessWidget` нет `initState` и нет места, чтобы долговременно хранить `Future`, поэтому он не может удовлетворить правило "получено ранее". (Подробнее о случае без состояния ниже.)
2. **Объявите поле `late final Future<T>`** в классе `State`. `late final` позволяет присвоить его в `initState` и гарантирует, что оно записывается ровно один раз.
3. **Присвойте поле в `initState`**, вызывая там ваш асинхронный метод вместо `build`. `initState` выполняется один раз за время жизни `State`, независимо от того, сколько раз перестраивается виджет.
4. **Передайте сохранённое поле в `FutureBuilder`**, никогда -- встроенный вызов. Аргумент `future:` становится простой ссылкой на поле без скобок.
5. **Проверьте с принудительной перестройкой**: многократно запустите `setState` и убедитесь, что индикатор не возвращается, а работа не выполняется заново.

Применительно к воспроизводимому примеру:

```dart
// Flutter 3.44, Dart 3.x
// FIXED: future is created once in initState
class _ProfilePageState extends State<ProfilePage> {
  late final Future<String> _nameFuture;
  int _counter = 0;

  @override
  void initState() {
    super.initState();
    _nameFuture = _loadName(); // created exactly once
  }

  Future<String> _loadName() async {
    await Future<void>.delayed(const Duration(seconds: 2));
    return 'Marius';
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        FutureBuilder<String>(
          future: _nameFuture, // same instance every build
          builder: (context, snapshot) {
            if (snapshot.connectionState != ConnectionState.done) {
              return const CircularProgressIndicator();
            }
            return Text('Hello, ${snapshot.data}');
          },
        ),
        ElevatedButton(
          onPressed: () => setState(() => _counter++),
          child: Text('Rebuilt $_counter times'),
        ),
      ],
    );
  }
}
```

Теперь кнопка увеличивает счётчик, `build` выполняется снова, но `future: _nameFuture` указывает на тот же самый экземпляр `Future`, созданный ранее в `initState`. `FutureBuilder.didUpdateWidget` видит, что `oldWidget.future == widget.future`, сохраняет существующую подписку и никогда не сбрасывает снимок. Загрузка происходит один раз. Это канонический паттерн, и он покрывает подавляющее большинство реальных случаев.

## Когда Future зависит от параметра виджета

У подхода с `initState` есть острый край: `initState` не может увидеть новое значение `widget`. Если ваш `Future` зависит от `widget.userId`, который родитель может изменить, инициализация только в `initState` означает, что данные устаревают, когда родитель передаёт другой id, потому что объект `State` переиспользуется через это изменение.

Собственный список одобренных мест фреймворка уже назвал ответ: `State.didUpdateWidget`. Пересоздайте `Future` там, но только когда соответствующий ввод действительно изменился, чтобы не вернуть перезапуск-на-каждую-перестройку.

```dart
// Flutter 3.44, Dart 3.x
class _UserPageState extends State<UserPage> {
  late Future<User> _userFuture;

  @override
  void initState() {
    super.initState();
    _userFuture = _fetchUser(widget.userId);
  }

  @override
  void didUpdateWidget(covariant UserPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Only refetch when the id genuinely changed.
    if (oldWidget.userId != widget.userId) {
      _userFuture = _fetchUser(widget.userId);
    }
  }

  Future<User> _fetchUser(String id) async {
    // ...network call keyed by id...
    return User(id: id);
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<User>(
      future: _userFuture,
      builder: (context, snapshot) {
        // ...render data / loading / error...
        return const SizedBox.shrink();
      },
    );
  }
}
```

Защита `if (oldWidget.userId != widget.userId)` -- в этом весь смысл. Без неё вы снова загружали бы при каждой перестройке родителя, лишь на один слой дальше от исходной ошибки. Если ваш `Future` зависит от `InheritedWidget` (значения, прочитанного через `context.dependOnInheritedWidgetOfExactType`, например `Locale` или область видимости провайдера), используйте `didChangeDependencies` с той же защитой обнаружения изменений, так как это тот колбэк, который Flutter запускает при изменении наследуемой зависимости.

## Принудительная намеренная перезагрузка

Перенос `Future` в поле поднимает очевидный вопрос: как перезагрузить намеренно, например при потягивании-для-обновления? Переприсвойте поле внутри `setState`. Это даёт `FutureBuilder` новую идентичность ровно тогда, когда вы это намереваете.

```dart
// Flutter 3.44, Dart 3.x
void _refresh() {
  setState(() {
    _nameFuture = _loadName(); // new instance, intentional restart
  });
}
```

Это контролируемая версия сломанного паттерна: новый `Future` создаётся в ответ на действие пользователя, а не как побочный эффект несвязанной перестройки. Сочетайте его с `RefreshIndicator`, чей `onRefresh` возвращает новый future, чтобы индикатор оставался, пока загрузка не разрешится. Пока вы подключаете перезагрузку, решите, как builder отображает неудавшуюся перезагрузку; паттерны из [изящной обработки сетевых ошибок в приложении Flutter](/ru/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) применяются напрямую к ветке `snapshot.hasError`.

## Мемоизация без написания шаблонного кода initState

Если вы поддерживаете много таких и церемония из `initState` плюс `didUpdateWidget` вас раздражает, `AsyncMemoizer` из пакета `async` сворачивает её: он выполняет колбэк не более одного раза и возвращает тот же `Future` при последующих вызовах, так что даже встроенный вызов в `build` разрешается в одну лежащую в основе операцию.

```dart
// Flutter 3.44, Dart 3.x
// package: async ^2.11
import 'package:async/async.dart';

class _CatalogPageState extends State<CatalogPage> {
  final _memoizer = AsyncMemoizer<List<Item>>();

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<List<Item>>(
      // runOnce returns the SAME future after the first call.
      future: _memoizer.runOnce(() => _repository.loadItems()),
      builder: (context, snapshot) => const SizedBox.shrink(),
    );
  }
}
```

`runOnce` выполняет свой колбэк в первый раз и кеширует получившийся `Future`; последующие вызовы игнорируют новый колбэк и возвращают кешированный. Мемоизатор по-прежнему живёт в `State`, поэтому разделяет те же гарантии времени жизни, что и поле `late final`. Для случая, зависящего от параметров, вам пришлось бы заводить свежий мемоизатор на каждый id, что больше бухгалтерии, чем `didUpdateWidget`, поэтому обращайтесь к `AsyncMemoizer` в основном тогда, когда у операции нет входов.

## Почему StatelessWidget не может это исправить

У `StatelessWidget` нет `initState`, нет `State` и нет стабильного места, чтобы спрятать `Future`. Любое поле, которое вы добавите, пересоздаётся всякий раз, когда родитель перестраивает виджет, потому что Flutter свободно отбрасывает и пересоздаёт экземпляры `StatelessWidget`. Поэтому правило "создай его раньше" неудовлетворимо в `StatelessWidget`: самое раннее, когда вы можете создать `Future`, -- это `build`, ровно то место, которое запрещает документация. Если вы обнаруживаете, что хотите долгоживущий `Future` внутри `StatelessWidget`, это сигнал либо повысить его до `StatefulWidget`, либо поднять `Future` в слой управления состоянием, который переживает виджет целиком.

Второй вариант всё чаще является идиоматическим. `FutureProvider` или `AsyncNotifier` из Riverpod кеширует свой `Future` за вас и пересчитывает только при изменении зависимости, что убирает ручной танец `initState` и переживает перестройки виджета и даже смену маршрутов. Если вы выбираете долгосрочный подход, а не латаете один экран, компромиссы изложены в [Provider против Riverpod против Bloc для управления состоянием Flutter в 2026](/ru/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/), а трёхсостоянийное отображение, которое вы получаете из `AsyncValue` провайдера, рассмотрено в [отображении состояний загрузки и ошибки с AsyncValue во Flutter Riverpod](/ru/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/).

## Две связанные ловушки, которые паттерн с полем не решает

Перенос `Future` исправляет перезапуск, но две смежные проблемы выживают. Во-первых, `FutureBuilder` внутри прокручиваемого списка, который неправильно использует `AutomaticKeepAliveClientMixin`, всё ещё может перестраиваться, когда строка прокручивается обратно в поле зрения; поле `Future` защищает данные, но убедитесь, что само состояние строки сохраняется живым, если вы хотите избежать мигания перестройки. Во-вторых, `Future`, который завершается после того, как виджета уже нет, попытается доставить результат в уже уничтоженный `State`. Сам `FutureBuilder` внутренне защищается от `setState`-после-уничтожения, но если ваш асинхронный метод трогает другие контроллеры при разрешении, вы всё ещё можете столкнуться с ошибками жизненного цикла. Дисциплина уничтожения из [уничтожения контроллеров во Flutter во избежание утечек памяти](/ru/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) -- сопутствующая привычка: владейте каждым создаваемым ресурсом и освобождайте его в `dispose`.

Ментальная модель, которую стоит удержать: `FutureBuilder` -- это тонкий адаптер, наблюдающий за одним `Future` по идентичности. Ваша задача -- сделать эту идентичность стабильной. Создавайте `Future` в `initState`, обновляйте его в `didUpdateWidget` или `didChangeDependencies` только когда изменился ввод, и переприсваивайте в `setState` только когда пользователь запросил свежие данные. Сделайте это, и индикатор покажется ровно один раз, сеть будет затронута ровно один раз, и экран перестанет мигать.

## Источники

- [FutureBuilder class - widgets library](https://api.flutter.dev/flutter/widgets/FutureBuilder-class.html): правило "must have been obtained earlier" и предупреждение о перезапуске, процитированные выше.
- [State.initState method](https://api.flutter.dev/flutter/widgets/State/initState.html): выполняется один раз за время жизни State.
- [State.didUpdateWidget method](https://api.flutter.dev/flutter/widgets/State/didUpdateWidget.html): хук для реакции на изменённую конфигурацию виджета.
- [AsyncMemoizer class - async package](https://pub.dev/documentation/async/latest/async/AsyncMemoizer-class.html): выполняет колбэк не более одного раза.
