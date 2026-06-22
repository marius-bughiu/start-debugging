---
title: "Как настроить вложенные маршруты и deep links с go_router во Flutter"
description: "Создайте постоянную оболочку с вложенными маршрутами через ShellRoute и StatefulShellRoute, а затем настройте deep links на основе путей, которые восстанавливают весь стек страниц. Полная конфигурация для Android и iOS, а также подводные камни, ломающие стек возврата."
pubDate: 2026-06-22
template: how-to
tags:
  - "flutter"
  - "dart"
  - "go-router"
  - "navigation"
lang: "ru"
translationOf: "2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-22
---

Чтобы вложить маршруты во Flutter с помощью `go_router`, поместите дочерние маршруты в список `routes:` родительского `GoRoute`, чтобы URL строил стек страниц, и оберните группу маршрутов в `ShellRoute` (или `StatefulShellRoute.indexedStack` для сохранения состояния вкладок), когда они должны разделять постоянный интерфейс, например нижнюю панель навигации. Тогда deep links появляются почти бесплатно: `go_router` разбирает входящий путь по этому дереву маршрутов и восстанавливает соответствующий стек, так что ссылка на `/orders/42` приводит пользователя на страницу деталей заказа с `/orders` под ней в стеке возврата. Единственная ручная работа -- это нативная конфигурация платформы, которая указывает Android и iOS вообще передать URL во Flutter. В этом руководстве используются `go_router` 17.3.0 (июнь 2026), Flutter 3.44 stable и Dart 3.x.

Две идеи, которые путают, -- это вложенность и deep linking, и они действительно различны. Вложенность касается формы вашего дерева маршрутов: какие экраны находятся внутри каких и какой макет сохраняется между ними. Deep linking касается внешнего URL, который входит в приложение и разрешается в экран. Они встречаются ровно в одной точке: `go_router` использует одну и ту же декларативную таблицу маршрутов для отрисовки внутренней навигации и для разрешения deep link, и именно поэтому хорошо построенное дерево маршрутов даёт корректные deep links без дополнительного кода.

## Как под-маршруты превращают URL в стек страниц

`GoRoute` может нести собственный список `routes:`. Когда совпавший путь уходит глубже родителя, `go_router` обходит дерево и добавляет по одной странице на уровень, так что итоговый стек возврата отражает сегменты URL.

```dart
// go_router 17.3.0, Flutter 3.44, Dart 3.x
final router = GoRouter(
  routes: [
    GoRoute(
      path: '/orders',
      builder: (context, state) => const OrdersScreen(),
      routes: [
        // matches /orders/42 -> stack is [OrdersScreen, OrderDetailScreen]
        GoRoute(
          path: ':id',
          builder: (context, state) {
            final id = state.pathParameters['id']!;
            return OrderDetailScreen(orderId: id);
          },
        ),
      ],
    ),
  ],
);
```

Здесь важны две детали. Во-первых, дочерние пути относительны: дочерний -- это `':id'`, а не `'/orders/:id'`. Ведущая косая черта в под-маршруте делает его абсолютным маршрутом верхнего уровня и ломает вложенность, что является одной из самых частых ошибок конфигурации. Во-вторых, поскольку стек строится из URL, нажатие системной кнопки «назад» на `/orders/42` возвращает к `/orders`, даже если пользователь попал сюда напрямую через deep link. В этом вся выгода декларативной маршрутизации: стек возврата является функцией пути, а не того, как пользователь сюда попал.

Читайте параметр пути из `state.pathParameters`, а параметр запроса -- из `state.uri.queryParameters`. Оба являются обычными strings, поэтому разбирайте и проверяйте их в builder, а не доверяйте URL.

## Совместное использование макета с ShellRoute

Под-маршруты дают вам глубину, но не дают постоянного каркаса. Если `/orders` и `/profile` должны отрисовываться внутри одного и того же scaffold с одной и той же нижней панелью, вам нужен `ShellRoute`. `ShellRoute` вводит вложенный `Navigator`: его дочерние маршруты отрисовываются в виджет `child`, который вы помещаете внутрь своей оболочки, и сама оболочка никогда не перестраивается, пока пользователь перемещается между дочерними элементами.

```dart
// go_router 17.3.0 -- one shared scaffold, swappable body
ShellRoute(
  builder: (context, state, child) => ScaffoldWithNavBar(child: child),
  routes: [
    GoRoute(path: '/orders', builder: (_, __) => const OrdersScreen()),
    GoRoute(path: '/profile', builder: (_, __) => const ProfileScreen()),
  ],
),
```

`child`, передаваемый в builder оболочки, -- это текущий совпавший под-маршрут. Ваш `ScaffoldWithNavBar` помещает `child` в `body` и отрисовывает `BottomNavigationBar` вокруг него. Нажатие на вкладку вызывает `context.go('/profile')`, вложенный navigator заменяет body, а scaffold остаётся смонтированным. Эта постоянность -- вся причина обращаться к `ShellRoute` вместо простого списка маршрутов верхнего уровня.

Ограничение: `ShellRoute` держит один navigator, поэтому все вкладки разделяют один стек возврата, и body перестраивается с нуля при каждом переключении. Позиция прокрутки, ввод в форму и любое эфемерное состояние внутри вкладки теряются при переключении. Для многих приложений это приемлемо. Для приложения в стиле Instagram, где каждая вкладка должна помнить, где она была, вам нужен вариант с состоянием.

## Дать каждой вкладке собственный стек возврата с StatefulShellRoute

`StatefulShellRoute.indexedStack` создаёт отдельный `Navigator` на каждую ветвь и держит все ветви живыми в `IndexedStack`, так что переключение вкладок сохраняет стек и состояние каждой вкладки. Это значение по умолчанию на 2026 год для любого приложения с нижней панелью навигации, где вкладки должны быть независимыми.

```dart
// go_router 17.3.0 -- independent stacks per tab
StatefulShellRoute.indexedStack(
  builder: (context, state, navigationShell) =>
      ScaffoldWithNavBar(navigationShell: navigationShell),
  branches: [
    StatefulShellBranch(
      routes: [
        GoRoute(
          path: '/orders',
          builder: (_, __) => const OrdersScreen(),
          routes: [
            GoRoute(
              path: ':id',
              builder: (context, state) =>
                  OrderDetailScreen(orderId: state.pathParameters['id']!),
            ),
          ],
        ),
      ],
    ),
    StatefulShellBranch(
      routes: [
        GoRoute(path: '/profile', builder: (_, __) => const ProfileScreen()),
      ],
    ),
  ],
)
```

Builder передаёт вам `StatefulNavigationShell` вместо обычного `child`. Вы переключаете ветвь с помощью `navigationShell.goBranch(index)`, а не `context.go(...)`, потому что `goBranch` восстанавливает существующий стек этой ветви, а не начинает новую навигацию:

```dart
// go_router 17.3.0 -- the nav bar drives the shell, not context.go
BottomNavigationBar(
  currentIndex: navigationShell.currentIndex,
  onTap: (index) => navigationShell.goBranch(
    index,
    // re-tapping the active tab pops to its root, like native apps
    initialLocation: index == navigationShell.currentIndex,
  ),
  items: const [
    BottomNavigationBarItem(icon: Icon(Icons.list), label: 'Orders'),
    BottomNavigationBarItem(icon: Icon(Icons.person), label: 'Profile'),
  ],
)
```

Недавние версии также предоставляют флаг `preload` на `StatefulShellBranch`, который строит первый маршрут ветви до того, как пользователь её посетит, разменивая часть стоимости запуска на мгновенное первое переключение вкладки. Оставьте его выключенным, если только профилировщик не покажет, что первое переключение подтормаживает.

## Настройка платформ, чтобы deep link достиг Flutter

Deep link работает только если операционная система направит URL в ваше приложение. `go_router` не может сделать эту часть за вас; он берёт управление только после того, как Flutter получит ссылку. Встроенный deep linking во Flutter включён по умолчанию во Flutter 3.44, так что в основном вы добавляете маршруты платформы и, на Android, включаете проверку App Links.

Существует два типа ссылок, и нативная настройка различается:

- **Пользовательская схема** (`myapp://orders/42`): тривиальна в настройке, работает офлайн, но любое приложение может заявить ту же схему. Подходит для внутренних передач между приложениями.
- **Universal links / App Links** (`https://example.com/orders/42`): привязаны к домену, которым вы владеете, через размещённый файл ассоциации, так что только ваше приложение может их заявить. Это то, что вам нужно для ссылок, которыми делятся через веб.

На Android добавьте `intent-filter` к главной активности в `android/app/src/main/AndroidManifest.xml`. Атрибут `android:autoVerify="true"` -- это то, что повышает простую `https`-ссылку до проверенного App Link:

```xml
<!-- AndroidManifest.xml -->
<intent-filter android:autoVerify="true">
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="https" android:host="example.com" />
</intent-filter>
```

Deep linking во Flutter включён по умолчанию, но если вам когда-нибудь понадобится его переключить, явный флаг -- это запись `meta-data` с именем `flutter_deeplinking_enabled`, установленная в `true` или `false`. App Links также требуют файл `assetlinks.json`, размещённый по адресу `https://example.com/.well-known/assetlinks.json`, содержащий имя пакета вашего приложения и отпечаток подписи, иначе операционная система прибегнет к открытию браузера.

На iOS эквивалентный ключ в `Info.plist` -- это `FlutterDeepLinkingEnabled`. Universal links требуют entitlement Associated Domains (`applinks:example.com`) плюс файл `apple-app-site-association`, размещённый на вашем домене. Пользовательская схема вместо этого использует запись `CFBundleURLTypes` в `Info.plist`. Точный XML для обеих платформ находится в cookbooks Flutter, ссылки на которые приведены в конце; имена ключей выше -- это несущие части.

## Пошаговая настройка

Вот полная последовательность, чтобы перейти от плоского приложения к вложенным маршрутам с работающими deep links.

1. **Добавьте и зафиксируйте зависимость.** Выполните `flutter pub add go_router` и убедитесь, что `pubspec.yaml` показывает `go_router: ^17.3.0`. Зафиксируйте мажорную версию, потому что у `go_router` были несовместимые изменения в API оболочки между мажорными версиями.
2. **Определите дерево маршрутов.** Постройте один `GoRouter` с вашими маршрутами верхнего уровня. Вкладывайте экраны деталей внутрь списка `routes:` их родителя, используя относительные пути (`':id'`, никогда `'/parent/:id'`).
3. **Добавьте оболочку для общего макета.** Оберните маршруты с вкладками в `StatefulShellRoute.indexedStack` (независимые стеки вкладок) или `ShellRoute` (один общий стек). Отрисовывайте `navigationShell` или `child` внутри body вашего scaffold.
4. **Подключите router к приложению.** Передайте его в `MaterialApp.router(routerConfig: router)`, чтобы виджет `Router` от Flutter управлял навигацией и подключался обработчик deep links платформы.
5. **Навигируйте по пути.** Используйте `context.go('/orders/42')`, чтобы заменить стек, `context.push('/orders/42')`, чтобы добавить поверх, и `navigationShell.goBranch(index)`, чтобы переключать вкладки без потери их состояния.
6. **Настройте платформы.** Добавьте Android `intent-filter` с `autoVerify` и iOS entitlement Associated Domains, и разместите файлы `assetlinks.json` / `apple-app-site-association` для проверенных ссылок.
7. **Протестируйте ссылку из конца в конец.** На Android: `adb shell am start -W -a android.intent.action.VIEW -d "https://example.com/orders/42"`. В симуляторе iOS: `xcrun simctl openurl booted "https://example.com/orders/42"`. Приложение должно открыться прямо на экране деталей заказа с `/orders` в стеке возврата.

## Подводные камни, которые тихо ломают навигацию

**Абсолютные пути дочерних маршрутов.** Дочерний маршрут, записанный как `'/orders/:id'` вместо `':id'`, тихо становится маршрутом верхнего уровня. Вложенность ломается, и кнопка «назад» перестаёт возвращать к `/orders`. Это самая частая ошибка.

**Показ диалога или полноэкранного маршрута внутри оболочки.** Экран входа или модальное окно обычно не должны отрисовываться внутри scaffold нижней панели навигации. Дайте маршруту `parentNavigatorKey`, указывающий на ключ корневого navigator, чтобы он добавлялся поверх оболочки, а не внутрь неё. Без этого ваша страница входа появляется с прикреплённой нижней панелью.

**Использование `context.go` для переключения вкладок.** Внутри `StatefulShellRoute` вызов `context.go('/profile')` работает, но отбрасывает сохранённый стек этой ветви. Всегда используйте `navigationShell.goBranch(index)` из панели навигации, чтобы каждая вкладка помнила, где она была.

**Чтение context после асинхронного редиректа.** Редиректы и асинхронная навигация могут перестроить или уничтожить виджет, который их инициировал. Если вы навигируете после `await`, защитите возобновление так же, как вы делали бы это в любом другом месте, как описано в [безопасное использование BuildContext после await](/ru/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/). Игнорирование этого вызывает [сбой при поиске предка деактивированного виджета](/ru/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/).

**Предположение, что deep link валиден.** `state.pathParameters['id']` -- это то, что содержал URL, включая мусор из набранной вручную или устаревшей ссылки. Разберите его, проверьте и направьте на экран «не найдено» в случае сбоя. Сочетайте это с аккуратной [обработкой сетевых ошибок](/ru/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/), когда ресурс по deep link нужно получить, а его может уже не быть.

**Уничтожение controllers на экранах, которые сохраняются.** С `StatefulShellRoute.indexedStack` экраны вкладок остаются живыми в фоне, поэтому их controllers не уничтожаются при переключении вкладки. Обычно это то, что вам нужно, но действуйте обдуманно, так же как вы делали бы при [уничтожении controllers во избежание утечек](/ru/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) на маршрутах, которые действительно появляются и исчезают.

## Когда надстраивать типизированные маршруты

Всё вышеперечисленное использует строковые маршруты. Их легко читать, но легко опечататься, и неверная строка маршрута падает во время выполнения, а не во время компиляции. Для большого приложения добавьте `go_router_builder`, чтобы генерировать типобезопасные классы маршрутов из аннотированных определений, так что `OrderDetailRoute(id: 42).go(context)` заменит сырую строку, а компилятор поймает отсутствующий параметр. Форма дерева маршрутов, оболочки и конфигурация deep links идентичны; типизированные маршруты -- это слой генерации кода поверх того же `GoRouter`. Начните со строк, убедитесь, что модель навигации верна, а затем введите типизированные маршруты, когда структура станет стабильной. Если вы также выбираете подход к управлению состоянием для экранов, которые отрисовывают эти маршруты, компромиссы в [Provider vs Riverpod vs Bloc](/ru/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) естественно сочетаются с этой настройкой маршрутизации.

## Источники

- [Пакет go_router на pub.dev](https://pub.dev/packages/go_router) (версия 17.3.0, июнь 2026)
- [API класса ShellRoute](https://pub.dev/documentation/go_router/latest/go_router/ShellRoute-class.html)
- [API класса StatefulShellRoute](https://pub.dev/documentation/go_router/latest/go_router/StatefulShellRoute-class.html)
- [Тема deep linking, документация go_router](https://pub.dev/documentation/go_router/latest/topics/Deep%20linking-topic.html)
- [Документация по deep linking во Flutter](https://docs.flutter.dev/ui/navigation/deep-linking)
