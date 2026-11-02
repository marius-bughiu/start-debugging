---
title: "Миграция с FutureBuilder на Riverpod AsyncNotifier во Flutter (flutter_riverpod 3.3.2)"
description: "Миграция FutureBuilder на Riverpod 3 AsyncNotifier: проверенный ручной family-провайдер, явный срок жизни кеша, повторы и безопасное изменение данных."
pubDate: 2026-06-18
updatedDate: 2026-11-02
template: migration
tags:
  - "migration"
  - "flutter"
  - "riverpod"
lang: "ru"
translationOf: "2026/06/migrate-from-futurebuilder-to-a-riverpod-asyncnotifier-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-18
---

Перенесите запрос из `FutureBuilder` в `AsyncNotifier`, если несколько виджетов используют одно состояние или нужен общий слой для изменений данных. Миграция необязательна: сохранённый Future, принадлежащий одному виджету, хорошо подходит для `FutureBuilder`. Проблема — создание нового запроса в `build()`, а не сам `FutureBuilder`.

Пример использует ручной API Riverpod 3 с **flutter_riverpod 3.3.2**, проверенный на **Flutter 3.44.8 / Dart 3.12.2**. Генерация кода не нужна. Оба блока Dart размещаются в одном файле. Для воспроизведения закрепите `flutter_riverpod: 3.3.2`: это проверенная версия, а не заявление о самой новой версии.

## Перенесите запрос и изменение данных в провайдер

`UserRepository` задаёт контракт приложения. Реализуйте его через свой API-клиент и переопределите `userRepositoryProvider` в корневом `ProviderScope`. Заглушка намеренно выбрасывает ошибку, чтобы отсутствие реализации было заметно. В тестах используйте fake в памяти.

В Riverpod 3 ручной family-notifier наследует `AsyncNotifier<User>`, принимает ID в конструкторе и реализует `build()` без параметров. `FamilyAsyncNotifier<User, String>` — старый API. Пример явно включает автоматическое уничтожение и отключает автоматические повторы, чтобы восстановлением управляла кнопка Retry.

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

class User {
  const User(this.name);
  final String name;
}

abstract class UserRepository {
  Future<User> fetchUser(String id);
  Future<void> rename(String id, String name);
}

final userRepositoryProvider = Provider<UserRepository>(
  (ref) => throw UnimplementedError('Override with your repository'),
);

final profileControllerProvider =
    AsyncNotifierProvider.autoDispose.family<ProfileController, User, String>(
  ProfileController.new,
  retry: (retryCount, error) => null,
);

class ProfileController extends AsyncNotifier<User> {
  ProfileController(this.userId);
  final String userId;

  @override
  Future<User> build() {
    return ref.watch(userRepositoryProvider).fetchUser(userId);
  }

  Future<void> rename(String newName) async {
    if (state.isLoading) return;
    final repo = ref.read(userRepositoryProvider);
    state = const AsyncLoading();
    final next = await AsyncValue.guard(() async {
      await repo.rename(userId, newName);
      return repo.fetchUser(userId);
    });
    if (!ref.mounted) return;
    state = next;
  }
}
```

`AsyncValue.guard` преобразует ошибку изменения данных в состояние ошибки. После await проверка `ref.mounted` предотвращает запись в уничтоженный notifier. Проверка загрузки исключает одновременные rename через этот метод, но не является транзакцией или отменой HTTP.

## Отобразите общее состояние

Замените экран этим `ConsumerWidget`. `ref.watch` подписывается во время build; обработчики кнопок используют `ref.read` или `ref.invalidate`. `skipLoadingOnRefresh: false` показывает загрузку после инвалидации даже при наличии предыдущих данных.

```dart
class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key, required this.userId});
  final String userId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return ref.watch(profileControllerProvider(userId)).when(
      skipLoadingOnRefresh: false,
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (error, stack) => Column(
        children: [
          Text('Failed: $error'),
          ElevatedButton(
            onPressed: () => ref.invalidate(profileControllerProvider(userId)),
            child: const Text('Retry'),
          ),
        ],
      ),
      data: (user) => Column(
        children: [
          Text(user.name),
          ElevatedButton(
            onPressed: () => ref
                .read(profileControllerProvider(userId).notifier)
                .rename('Grace'),
            child: const Text('Rename'),
          ),
        ],
      ),
    );
  }
}
```

## Определите срок жизни результата

- Виджеты с одинаковым family-ключом в одном scope используют общее активное состояние. Равенство ключей и `hashCode` должны быть стабильными.
- `.autoDispose` позволяет уничтожить состояние после ухода последнего слушателя. Возврат после уничтожения вызывает новый запрос. Изменения зависимостей и инвалидация тоже могут повторно запустить `build()`.
- Без генерации кода автоматическое уничтожение включают явно. У генерируемых `@riverpod`-провайдеров оно включено по умолчанию. Эти настройки не эквивалентны. Используйте `ref.keepAlive()` или политику кеша только при намеренном сохранении состояния.
- Riverpod 3 по умолчанию повторяет подходящие ошибки инициализации. Пример отключает повторы через `retry: (_, _) => null`; выберите нужную политику для приложения. `AsyncValue.guard` не повторяет методы изменения данных автоматически.
- `ref.onDispose` — обработчик жизненного цикла, а не автоматическая отмена запросов. При необходимости подключите к нему отмену или очистку HTTP-клиента.

Switch только по `AsyncData` и `AsyncError` не гарантирует показ старых данных во время обновления. Выберите поведение явно; у `.when()` также есть настройки загрузки и refresh. Для pull-to-refresh ожидайте `ref.refresh(profileControllerProvider(userId).future)`, чтобы жест завершался вместе с запросом.

## Проверьте миграцию

Исправленный код прошёл анализ и provider/widget-тесты общих чтений, инвалидации, уничтожения с повторной загрузкой, ошибки и ручного восстановления, успешного и неудачного rename и завершения после уничтожения. В тестах используется fake-репозиторий; реальный сетевой сервис и авторизация не проверяются. Выполните аналогичные проверки в приложении:

```bash
flutter analyze
flutter test
```

Мигрируйте по одному экрану. Для отката восстановите реализацию с сохранённым Future и удалите неиспользуемый провайдер. Не создавайте новый Future при каждом build.

**Исправление от 2 ноября 2026 года:** заменён family API Riverpod 2, явно заданы уничтожение и повторы, исправлены утверждения о навигации, кеше и отмене запросов, добавлена проверка жизненного цикла после await. Старая инструкция версии 2 больше не выдаётся за документацию Riverpod 3.

## Источники и связанные статьи

- [Flutter: FutureBuilder](https://api.flutter.dev/flutter/widgets/FutureBuilder-class.html)
- [Riverpod 3: migration](https://riverpod.dev/docs/3.0_migration)
- [Riverpod: families](https://riverpod.dev/docs/concepts2/family)
- [Riverpod: automatic disposal](https://riverpod.dev/docs/concepts2/auto_dispose)
- [Riverpod: automatic retry](https://riverpod.dev/docs/concepts2/retry)
- [Riverpod: request cancellation](https://riverpod.dev/docs/how_to/cancel)
- [flutter_riverpod 3.3.2](https://pub.dev/packages/flutter_riverpod/versions/3.3.2)

- [FutureBuilder / Future](/ru/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/)
- [AsyncValue](/ru/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)
- [Ref / dispose](/ru/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/)
- [provider → Riverpod](/ru/2026/06/migrate-from-provider-to-riverpod-in-flutter/)
- [FutureBuilder / Riverpod](/ru/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/)
