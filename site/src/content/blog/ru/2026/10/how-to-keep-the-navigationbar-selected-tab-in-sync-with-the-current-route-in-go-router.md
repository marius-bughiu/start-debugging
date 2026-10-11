---
title: "Как синхронизировать выбранную вкладку NavigationBar с текущим маршрутом через StatefulShellRoute в go_router"
description: "Берите NavigationBar.selectedIndex из StatefulNavigationShell.currentIndex, а не из поля setState или копии, сделанной в initState. Замеры на Flutter 3.44.8 и go_router 18.0.2: какие подходы рассинхронизируются при deep link, context.go и переходах между ветками, почему индекс по location обманывает и как реагировать на смену вкладок через didUpdateWidget."
pubDate: 2026-10-11
template: how-to
tags:
  - "flutter"
  - "dart"
  - "go-router"
  - "navigation"
  - "how-to"
lang: "ru"
translationOf: "2026/10/how-to-keep-the-navigationbar-selected-tab-in-sync-with-the-current-route-in-go-router"
translatedBy: "claude"
translationDate: 2026-10-11
---

**Короткий ответ:** не храните выбранную вкладку самостоятельно. Внутри `StatefulShellRoute` go_router уже знает, какая ветка активна, и отдаёт её как `navigationShell.currentIndex`. Передавайте это значение прямо в `NavigationBar.selectedIndex` при каждой сборке и переключайте вкладки через `navigationShell.goBranch(index)`. Поле `_selectedIndex`, обновляемое в `onDestinationSelected`, или копия `currentIndex`, снятая в `initState`, меняется только когда пользователь нажимает на панель, поэтому оно устаревает, как только deep link, `context.go` изнутри страницы или обработчик уведомления меняет маршрут. Всё ниже запускалось через `flutter test` на Flutter 3.44.8 (Dart 3.12.2) и go_router 18.0.2, последнем релизе на октябрь 2026 года.

Отчёт об ошибке обычно выглядит так: "я открываю приложение по ссылке на `/profile`, а панель всё равно подсвечивает Home" или "кнопка на странице Orders отправляет пользователя в Settings, страница Settings показана, а панель по-прежнему говорит Orders". Страница верна, а панель нет, потому что два источника истины расходятся: location роутера и часть состояния виджета, которую обновляет только сама панель.

## Почему панель и маршрут расходятся

`NavigationBar` это глупый виджет. Он отрисовывает тот `selectedIndex`, который вы ему дали, и вызывает `onDestinationSelected`, когда пользователь нажимает. О существовании роутера он ничего не знает. Если вы храните индекс в `StatefulWidget`, единственный путь его обновления это обработчик нажатия, а нажатия лишь один из многих способов сменить маршрут:

- приложение стартует с deep link или `initialLocation`, указывающих на вторую вкладку
- страница вызывает `context.go('/profile/settings')` (ссылка "показать все", переход после входа, обработчик push-уведомления)
- `redirect` отправляет пользователя в другое место
- кнопка "назад" в браузере на Flutter web или восстановление состояния после того, как ОС завершила процесс

Ни один из этих случаев не затрагивает ваше поле `_selectedIndex`. Роутер пересобирает shell с новой веткой, ваш scaffold пересобирается со старым значением поля, и панель врёт.

go_router решает это за вас, если ему не мешать. Когда он собирает `StatefulShellRoute`, он создаёт `StatefulNavigationShell` и вычисляет `currentIndex` в конструкторе по navigator key той ветки, которая совпала с текущим location (см. `route.dart` в исходниках go_router, `_indexOfBranchNavigatorKey`). Новый виджет shell создаётся при каждой смене маршрута, поэтому `currentIndex` всегда является собственным ответом роутера на вопрос "какая ветка показана прямо сейчас".

## Минимальное приложение, воспроизводящее рассинхронизацию

Две ветки, Orders и Profile. На странице Orders есть кнопка, которая переходит сразу в ветку Profile. Это как раз тот вид навигации внутри страницы, который ломает самодельный индекс:

```dart
// Flutter 3.44.8, Dart 3.12.2, go_router 18.0.2
final router = GoRouter(
  initialLocation: '/orders',
  routes: [
    StatefulShellRoute.indexedStack(
      builder: (context, state, navigationShell) =>
          AppScaffold(navigationShell: navigationShell),
      branches: [
        StatefulShellBranch(routes: [
          GoRoute(
            path: '/orders',
            builder: (context, state) => const OrdersPage(),
            routes: [
              GoRoute(
                path: ':id',
                builder: (context, state) =>
                    OrderPage(id: state.pathParameters['id']!),
              ),
            ],
          ),
        ]),
        StatefulShellBranch(routes: [
          GoRoute(
            path: '/profile',
            builder: (context, state) => const ProfilePage(),
            routes: [
              GoRoute(
                path: 'settings',
                builder: (context, state) => const SettingsPage(),
              ),
            ],
          ),
        ]),
      ],
    ),
  ],
);
```

А вот scaffold, который большинство пишет первым, потому что именно так выглядит каждый пример `NavigationBar` без роутера:

```dart
// Flutter 3.44.8, go_router 18.0.2 -- DRIFTS, do not copy
class AppScaffold extends StatefulWidget {
  const AppScaffold({super.key, required this.navigationShell});
  final StatefulNavigationShell navigationShell;

  @override
  State<AppScaffold> createState() => _AppScaffoldState();
}

class _AppScaffoldState extends State<AppScaffold> {
  int _selectedIndex = 0;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: widget.navigationShell,
      bottomNavigationBar: NavigationBar(
        selectedIndex: _selectedIndex,
        onDestinationSelected: (index) {
          setState(() => _selectedIndex = index);
          widget.navigationShell.goBranch(index);
        },
        destinations: const [
          NavigationDestination(icon: Icon(Icons.list), label: 'Orders'),
          NavigationDestination(icon: Icon(Icons.person), label: 'Profile'),
        ],
      ),
    );
  }
}
```

Чуть более умный вариант инициализирует поле из shell (`_selectedIndex = widget.navigationShell.currentIndex;` в `initState`). Это чинит холодный старт и больше ничего. `StatefulNavigationShell` имеет стабильный ключ для каждого shell route, а ваш scaffold стоит на том же месте в дереве с тем же типом, поэтому Flutter сохраняет его `State` между сменами маршрута. `initState` выполняется один раз за сессию приложения, а не при каждой навигации.

## Что на самом деле показывает каждый подход

Я прогнал все варианты через виджет-тесты (`tester.tap`, `GoRouter.go`, `GoRouter.push`) и прочитал `NavigationBar.selectedIndex` после `pumpAndSettle`. "Верно" означает вкладку, в ветке которой находится видимая страница.

| Сценарий | Показанная страница | Поле `setState` | Копия в `initState` | `navigationShell.currentIndex` |
| --- | --- | --- | --- | --- |
| Холодный старт на `/profile` | Profile | 0 (неверно) | 1 | 1 |
| `context.go('/profile/settings')` со страницы Orders | Settings | 0 (неверно) | 0 (неверно) | 1 |
| `router.go('/profile')` извне дерева виджетов | Profile | 0 (неверно) | 0 (неверно) | 1 |
| `context.go('/orders/42')` со страницы Profile | Order 42 | 0 | 1 (неверно) | 0 |
| Пользователь нажимает Profile, затем Orders | Profile, Orders | 1, 0 | 1, 0 | 1, 0 |

Только последняя строка, которую каждый разработчик проверяет вручную, работает у всех трёх. Индекс shell был верным в каждом сценарии.

## Решение: читать currentIndex при каждой сборке

Правильный scaffold не хранит состояние. Ему нечего хранить, потому что это делает роутер:

```dart
// Flutter 3.44.8, Dart 3.12.2, go_router 18.0.2
class AppScaffold extends StatelessWidget {
  const AppScaffold({super.key, required this.navigationShell});
  final StatefulNavigationShell navigationShell;

  void _onTap(int index) {
    navigationShell.goBranch(
      index,
      // Tapping the tab you are already on pops that branch back to its root.
      initialLocation: index == navigationShell.currentIndex,
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: navigationShell,
      bottomNavigationBar: NavigationBar(
        selectedIndex: navigationShell.currentIndex,
        onDestinationSelected: _onTap,
        destinations: const [
          NavigationDestination(icon: Icon(Icons.list), label: 'Orders'),
          NavigationDestination(icon: Icon(Icons.person), label: 'Profile'),
        ],
      ),
    );
  }
}
```

Шаги по порядку:

1. Пусть scaffold принимает `StatefulNavigationShell` из builder у `StatefulShellRoute` и отображает его как `body`.
2. Установите `NavigationBar.selectedIndex` равным `navigationShell.currentIndex`. Удалите поле `_selectedIndex` и каждый `setState`, который его трогал.
3. В `onDestinationSelected` вызывайте `navigationShell.goBranch(index)`. Не вызывайте `context.go('/profile')` для переключения вкладок: это работает, но сбрасывает сохранённый стек ветки вместо того, чтобы восстановить его.
4. Передавайте `initialLocation: index == navigationShell.currentIndex`, чтобы повторное нажатие на активную вкладку возвращало её к корню ветки. Именно такого поведения ждут пользователи iOS и Android.
5. Если тот же scaffold на широких экранах отображает `NavigationRail`, передайте ему тот же `currentIndex`. Один источник, два виджета, никакого кода синхронизации.

Шага "обновить панель при смене маршрута" не существует. Нажатие вызывает `goBranch`, роутер меняет location, go_router собирает новый shell с новым `currentIndex`, и панель следует за ним. Нажатию даже не нужно ничего пересобирать локально.

Руководство 2026/06 про [вложенные маршруты и deep link в go_router](/ru/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/) показывает эту же схему как часть полной настройки shell. Этот пост о том, почему обходные пути ломаются.

## Реакция на смену вкладок без хранения индекса

Иногда действительно нужно знать, когда вкладка сменилась: записать просмотр экрана, поставить на паузу видео на покинутой вкладке, прокрутить список наверх. Возникает соблазн вернуть поле `_selectedIndex` "только для этого". Оно не нужно. Снова сделайте scaffold `StatefulWidget`, но сравнивайте старый и новый shell в `didUpdateWidget`:

```dart
// Flutter 3.44.8, Dart 3.12.2, go_router 18.0.2
class _AppScaffoldState extends State<AppScaffold> {
  @override
  void didUpdateWidget(AppScaffold oldWidget) {
    super.didUpdateWidget(oldWidget);
    final from = oldWidget.navigationShell.currentIndex;
    final to = widget.navigationShell.currentIndex;
    if (from != to) {
      analytics.logTabChange(from: from, to: to);
    }
  }

  @override
  Widget build(BuildContext context) {
    // selectedIndex still comes from widget.navigationShell.currentIndex
    return Scaffold(body: widget.navigationShell /* , bottomNavigationBar: ... */);
  }
}
```

При вызовах `router.go('/profile')` и затем `router.go('/orders')` в журнале появилось `initState 0`, `tab changed 0 -> 1`, `tab changed 1 -> 0`. Это срабатывает одинаково для нажатий, deep link и программной навигации, потому что отслеживается ответ роутера, а не ввод панели. Держите работу в `didUpdateWidget` лёгкой и без навигации: вызов `goBranch` из колбэка на этапе сборки быстро приводит к ошибке [setState() or markNeedsBuild() called during build](/ru/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/).

## Подводные камни и граничные случаи

### Индекс по location обманывает после push в другую ветку

Другой распространённый подход, унаследованный от обычного `ShellRoute`, это вычислять индекс по URL: `state.uri.path.startsWith('/profile') ? 1 : 0`. Он переживает deep link и `context.go`, поэтому ему и доверяют. Но ломается на `push`.

Когда страница Profile вызывает `context.push('/orders/42')`, go_router 18.0.2 кладёт страницу заказа в navigator *текущей* ветки. Я проверил это в тесте: загруженная страница находится внутри scaffold shell, `currentIndex` остаётся 1, а после переключения на Orders и обратно на Profile вкладка Profile по-прежнему показывает Order 42 поверх своего стека. Однако location теперь `/orders/42`, поэтому панель, определяющая индекс по location, подсвечивает Orders, пока пользователь находится внутри стека Profile. Нажмите Orders, и вы получите ветку Orders, а не ту страницу, на которую смотрели. `currentIndex` всё время показывал 1, что совпадает с тем, где страница реально находится.

Если вы хотите, чтобы детали заказа открывались под вкладкой Orders, используйте `context.go('/orders/42')` (он переключает ветку, и `currentIndex` становится 0). Если нужно поверх текущей вкладки, подойдёт `push`. В любом случае пусть `currentIndex` решает, какая вкладка подсвечена.

### У обычного ShellRoute нет currentIndex

Нестатичный `ShellRoute` даёт один вложенный navigator и `child`, без веток и индекса. Там вам придётся самостоятельно сопоставлять location с вкладкой. Делайте это через `GoRouterState` из builder (или `GoRouterState.of(context)`) и сопоставляйте по `uri.path`, а не по `matchedLocation`. В моём тесте после `push('/orders/7')` с `/profile` состояние shell сообщало `uri=/orders/7`, `fullPath=/orders/:id` и `matchedLocation=/profile`. Здесь действует та же оговорка про push из предыдущего раздела, и это ещё одна причина перевести вкладочные макеты на `StatefulShellRoute.indexedStack`, если вы хотите, чтобы каждая вкладка хранила собственный стек возврата ([сравнение go_router, auto_route и Navigator 2.0](/ru/2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter/) описывает, что каждый роутер предлагает для вкладок).

### Полноэкранные маршруты на корневом navigator

Оформление заказа или просмотр медиа часто находятся под путём ветки, но должны закрывать панель, поэтому объявляются с `parentNavigatorKey: rootNavigatorKey`. Переход на такой маршрут из Profile оставил `currentIndex` равным 1 без scaffold на сцене, а возврат вернул на Profile с правильной подсвеченной вкладкой. Прямой переход через `router.go('/orders/checkout')` собрал shell снизу с `currentIndex` 0, потому что маршрут принадлежит ветке Orders. В обоих случаях панель верна, когда снова появляется, без какого-либо кода.

### Ветка без пункта в панели

Часто бывает ветка, доступная только по ссылке, например Inbox, открываемая из уведомления, без значка в панели. Тогда `currentIndex` будет 2 при двух пунктах, а `NavigationBar` в debug-сборках проверяет через assert условие `0 <= selectedIndex && selectedIndex < destinations.length`. Сопоставляйте ветки с пунктами явно, а не передавайте индекс напрямую:

```dart
// Flutter 3.44.8, go_router 18.0.2
// Branch order: 0 orders, 1 profile, 2 inbox (no bar destination).
const _branchForDestination = [0, 1];

int _destinationFor(int branch) {
  final i = _branchForDestination.indexOf(branch);
  return i == -1 ? 0 : i; // NavigationBar cannot show "nothing selected"
}

NavigationBar(
  selectedIndex: _destinationFor(navigationShell.currentIndex),
  onDestinationSelected: (i) =>
      navigationShell.goBranch(_branchForDestination[i]),
  destinations: const [ /* Orders, Profile */ ],
);
```

`NavigationRail.selectedIndex` допускает null, поэтому на rail для скрытых веток можно вернуть `null` и не показывать выбор.

### Смена порядка или скрытие вкладок во время выполнения

Если пункты меняются в зависимости от feature flag или роли пользователя, список веток в роутере обычно не меняется. Держите индексы веток фиксированными и переназначайте их через таблицу, как выше. Изменение самих веток на лету означает новую конфигурацию роутера, а в changelog go_router 18.0.2 отмечено исправление потери вложенных в shell маршрутов при смене динамической конфигурации, поэтому при таком подходе оставайтесь на 18.0.2 или новее.

### Тестирование синхронизации

Каждый сценарий из таблицы выше это недорогой виджет-тест. Соберите `MaterialApp.router` с вашим настоящим роутером, запустите его на deep link через `initialLocation`, вызовите `router.go(...)` из теста и проверяйте `tester.widget<NavigationBar>(find.byType(NavigationBar)).selectedIndex`. Если на ваших вкладках есть контент, зависящий от времени, сочетайте это с подходом из [тестирования Flutter-виджета в фиксированный момент времени](/ru/2026/08/how-to-test-a-flutter-widget-at-a-fixed-point-in-time/), чтобы проверки были детерминированными. Одного теста на каждую точку входа навигации (deep link, `go` внутри страницы, обработчик уведомления) достаточно, чтобы поймать рассинхронизацию раньше пользователя.

## Практическое правило

Если вы пишете `setState` рядом с `NavigationBar` внутри shell go_router, остановитесь. Location принадлежит роутеру, location определяет ветку, а `StatefulNavigationShell.currentIndex` и есть это решение. Читайте его, никогда не копируйте, и панель не рассинхронизируется, как бы пользователь ни попал на экран.

## Источники

- [go_router 18.0.2 on pub.dev](https://pub.dev/packages/go_router) and its [changelog](https://pub.dev/packages/go_router/changelog)
- [StatefulShellRoute class API](https://pub.dev/documentation/go_router/latest/go_router/StatefulShellRoute-class.html)
- [StatefulNavigationShell class API](https://pub.dev/documentation/go_router/latest/go_router/StatefulNavigationShell-class.html) (`currentIndex`, `goBranch`)
- [go_router source: `lib/src/route.dart`](https://github.com/flutter/packages/blob/main/packages/go_router/lib/src/route.dart)
- [Official StatefulShellRoute example](https://github.com/flutter/packages/blob/main/packages/go_router/example/lib/stateful_shell_route.dart)
- [NavigationBar class API](https://api.flutter.dev/flutter/material/NavigationBar-class.html)
