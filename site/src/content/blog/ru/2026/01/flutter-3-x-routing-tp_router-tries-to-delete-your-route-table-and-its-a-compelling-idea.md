---
title: "Маршрутизация в Flutter 3.x: tp_router пытается удалить вашу таблицу маршрутов (и это привлекательная идея)"
description: "tp_router это управляемый генератором роутер для Flutter, устраняющий ручные таблицы маршрутов. Аннотируйте страницы, запустите build_runner и навигируйте через типизированные API вместо строковых путей."
pubDate: 2026-01-08
tags:
  - "flutter"
lang: "ru"
translationOf: "2026/01/flutter-3-x-routing-tp_router-tries-to-delete-your-route-table-and-its-a-compelling-idea"
translatedBy: "claude"
translationDate: 2026-04-30
---
Маршрутизация во Flutter одна из тех вещей, которые замечаешь только когда становится больно. Первые несколько экранов даются легко. Затем приложение растёт, пути эволюционируют, и "просто добавь ещё один маршрут" превращается в налог на обслуживание. 7 января 2026 года пост сообщества предложил идейное решение: `tp_router`, управляемый генератором роутер, который стремится к **нулю ручной конфигурации таблицы маршрутов**.

Исходная тема: [tp_router: Stop Writing Route Tables (r/FlutterDev)](https://www.reddit.com/r/FlutterDev/comments/1q6dq85/tp_router_stop_writing_route_tables/)  
Ссылки на проект: [GitHub](https://github.com/lwj1994/tp_router), [pub.dev](https://pub.dev/packages/tp_router)

## Режим отказа: строки повсюду

Большинство команд переживало некоторую версию этого:

```dart
// Define route table
final routes = {
  '/user': (context) => UserPage(
    id: int.parse(ModalRoute.of(context)!.settings.arguments as String),
  ),
};

// Navigate
Navigator.pushNamed(context, '/user', arguments: '42');
```

Это "работает", пока не перестаёт: имя маршрута меняется, тип аргумента меняется, и вы получаете крэши в runtime в частях приложения, которые не трогали.

## Сначала аннотация, потом генерация

Идея `tp_router` проста: аннотируйте страницу, запустите генератор и затем навигируйте через сгенерированные типы вместо строк.

Из поста:

```dart
@TpRoute(path: '/user/:id')
class UserPage extends StatelessWidget {
  final int id; // Auto-parsed from path
  final String section;

  const UserPage({
    required this.id,
    this.section = 'profile',
    super.key,
  });
}

// Navigate by calling .tp()
UserRoute(id: 42, section: 'posts').tp(context);
```

Эта последняя строка и есть весь смысл: если вы переименуете `section` или измените `id` с `int` на `String`, вы хотите, чтобы компилятор сломал вашу сборку, а не пользователей.

## Реальный вопрос: остаётся ли низким трение по мере роста приложения?

Если вы использовали `auto_route`, вы уже знаете, что управляемая аннотациями маршрутизация может работать хорошо, но всё равно в итоге пишете центральный список:

```dart
@AutoRouterConfig(routes: [
  AutoRoute(page: UserRoute.page, path: '/user/:id'),
  AutoRoute(page: HomeRoute.page, path: '/'),
])
class AppRouter extends RootStackRouter {}
```

`tp_router` пытается удалить этот последний шаг полностью.

## Запуск в проекте на Flutter 3.x

Зависимости, показанные в теме:

```yaml
dependencies:
  tp_router: ^0.1.0
  tp_router_annotation: ^0.1.0

dev_dependencies:
  build_runner: ^2.4.0
  tp_router_generator: ^0.1.0
```

Сгенерировать маршруты:

-   `dart run build_runner build`

И подключить:

```dart
void main() {
  final router = TpRouter(routes: tpRoutes);
  runApp(MaterialApp.router(routerConfig: router.routerConfig));
}
```

Если вы хотите меньше шаблонного кода маршрутизации и больше безопасности на этапе компиляции, `tp_router` стоит быстрого исследовательского спайка. Даже если вы не примете его на вооружение, направление верное: рассматривайте навигацию как типизированный API, а не как строковый фольклор.
