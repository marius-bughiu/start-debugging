---
title: "Исправление: Riverpod 3.0 бросает ProviderException вместо исходной ошибки"
description: "Riverpod 3.0 оборачивает ошибки, брошенные при чтении провайдера, в ProviderException. Поймайте этот тип и прочитайте e.exception, чтобы получить исходную ошибку обратно, или используйте AsyncValue.error, который не обёрнут."
pubDate: 2026-07-06
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
lang: "ru"
translationOf: "2026/07/fix-riverpod-3-0-throws-providerexception-instead-of-the-original-error"
translatedBy: "claude"
translationDate: 2026-07-06
---

Ваш `on NotFoundException catch` перестал срабатывать после обновления до Riverpod 3.0, потому что чтение провайдера, завершившегося ошибкой, больше не пробрасывает повторно ваше исходное исключение. Оно пробрасывает `ProviderException`, который его оборачивает. Чтобы починить сломанный `try`/`catch`, поймайте `ProviderException` и проверьте `e.exception` на предмет вашей настоящей ошибки, либо переключитесь на `AsyncValue.error`, который намеренно оставлен без обёртки. Это протестировано на `flutter_riverpod` 3.x (ветка 3.0 вышла в сентябре 2025 года; текущий релиз -- 3.3.2, июнь 2026 года), Flutter 3.44 и Dart 3.x.

Обновление не привнесло нового сбоя. Ваш провайдер по-прежнему бросает то же исключение, что и всегда. Изменился тип, который выходит с другой стороны, когда другой участок кода читает этот провайдер императивно.

## Ошибка в контексте

У вас есть провайдер, чей `build` бросает доменное исключение, и вызывающий код, который читает его внутри `try`/`catch`:

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
try {
  final user = await ref.read(userProvider.future);
  showProfile(user);
} on NotFoundException catch (e) {
  showNotFound(e.id); // never runs on Riverpod 3.0
}
```

На Riverpod 2.x это ловило `NotFoundException` напрямую. На 3.0 ветвь `on NotFoundException` пропускается, и, если у вас нет более широкого `catch`, исключение распространяется непойманным. Если вы залогируете фактический тип времени выполнения, вы увидите:

```
Unhandled exception:
ProviderException: An exception/error was thrown while building UserProvider.
  <original NotFoundException and its stack trace nested here>
```

`NotFoundException` всё ещё там внутри. Теперь это пассажир внутри `ProviderException`, а не то, что бросается.

## Почему Riverpod 3.0 оборачивает ошибку

Провайдер может находиться в состоянии ошибки по двум очень разным причинам, и Riverpod 2.x не мог различить их в тот момент, когда вы ловили ошибку.

Первая причина: **этот провайдер завершился ошибкой**. Его собственный `build` бросил исключение. Вторая причина: **этот провайдер в порядке, но провайдер, от которого он зависит, завершился ошибкой**, и ошибка распространилась вниз по графу. В цепочке зависимостей вроде `dashboardProvider`, наблюдающего за `userProvider`, наблюдающим за `authProvider`, исключение в `authProvider` всплывает при каждом чтении ниже по цепочке. Если бы все три пробрасывали сырое `AuthException`, то `catch` вокруг `dashboardProvider` не смог бы отличить "сломался сам dashboard" от "что-то сломалось тремя уровнями выше, и я вижу отголосок".

Riverpod 3.0 решает это оборачиванием. Когда вы читаете провайдер, чьё значение не удалось вычислить, ошибка помещается в `ProviderException`, который фиксирует, **какой провайдер** бросил исключение, и несёт исходную ошибку вместе с её трассировкой стека. Обёртка -- это сигнал того, что вы смотрите на распространившийся сбой провайдера, а свойство `.exception` -- это запасной выход обратно к вашей настоящей ошибке. Это поведение описано в [руководстве по миграции на Riverpod 3.0](https://riverpod.dev/docs/3.0_migration) и отслеживается в [issue 4320 riverpod](https://github.com/rrousselGit/riverpod/issues/4320).

Здесь есть небольшой кусочек истории, о котором стоит знать. Ранний Riverpod (до 2.0) тоже оборачивал в `ProviderException`, затем `2.0.0-dev.1` убрал оборачивание и переключился на повторный проброс сырого исключения, а `3.0.0-dev.16` намеренно вернул обёртку. Если вы помните, как `ProviderException` исчез несколько лет назад, вы не ошибаетесь; 3.0 переввёл его специально.

## Минимальное воспроизведение

Два файла. Провайдер, который бросает исключение, и виджет, который читает его императивно.

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x -- reproduces the wrap.
import 'package:flutter_riverpod/flutter_riverpod.dart';

class NotFoundException implements Exception {
  const NotFoundException(this.id);
  final String id;
}

final userProvider = FutureProvider.autoDispose<User>((ref) async {
  final user = await ref.read(apiProvider).findUser('42');
  if (user == null) throw const NotFoundException('42');
  return user;
});
```

```dart
// The caller. On 2.x this printed "not found: 42".
// On 3.0 nothing prints and the ProviderException escapes.
Future<void> load(WidgetRef ref) async {
  try {
    await ref.read(userProvider.future);
  } on NotFoundException catch (e) {
    debugPrint('not found: ${e.id}');
  }
}
```

Запустите `load`, когда пользователь отсутствует. На 3.0 ветвь `on NotFoundException` не совпадает, потому что брошенный объект -- это `ProviderException`, а не `NotFoundException`.

## Исправление, в деталях

Выберите подход, соответствующий тому, как вы потребляете провайдер. В порядке предпочтения:

### 1. Поймайте ProviderException и разберите e.exception

Если вам необходимо читать провайдер императивно (внутри обработчика событий, мутации, `ref.read` в колбэке), поймайте обёртку и вытащите исходную ошибку из `.exception`:

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x -- the direct fix.
Future<void> load(WidgetRef ref) async {
  try {
    await ref.read(userProvider.future);
  } on ProviderException catch (e) {
    switch (e.exception) {
      case NotFoundException(:final id):
        debugPrint('not found: $id');
      case SocketException():
        debugPrint('offline');
      default:
        rethrow; // do not swallow errors you did not plan for
    }
  }
}
```

`e.exception` -- это исходный объект, который вы бросили, поэтому Dart-паттерн `switch` по нему читается чисто и позволяет связывать поля (`:final id`) в той же строке. Всегда держите `default: rethrow`, чтобы неожиданная ошибка не была молча проглочена; голый `on ProviderException catch` без повторного проброса проглотит каждый будущий тип ошибки, который вы забудете перечислить.

Если вы предпочитаете проверки через `is` вместо паттернов, эквивалент такой:

```dart
} on ProviderException catch (e) {
  if (e.exception is NotFoundException) {
    final id = (e.exception as NotFoundException).id;
    debugPrint('not found: $id');
  } else {
    rethrow;
  }
}
```

### 2. Читайте ошибку через AsyncValue, который не оборачивается

Это лучшее исправление, когда код находится в виджете, потому что это ещё и идиоматичная для Riverpod форма. `AsyncValue.error` несёт ваше **исходное** исключение, а не обёртку. Оборачивание происходит только на пути императивного повторного проброса (`ref.read`/`ref.watch`, бросающие исключение); реактивный `AsyncValue`, который вы получаете при наблюдении за провайдером, остаётся нетронутым:

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x -- no ProviderException here.
class UserView extends ConsumerWidget {
  const UserView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(userProvider);
    return switch (async) {
      AsyncData(:final value) => ProfileCard(value),
      AsyncError(:final error) when error is NotFoundException =>
        NotFoundCard(error.id), // error is the raw NotFoundException
      AsyncError(:final error) => ErrorCard('$error'),
      _ => const CircularProgressIndicator(),
    };
  }
}
```

Обратите внимание, что `error is NotFoundException` совпадает напрямую. Никакого распаковывания, потому что `AsyncValue.error` изначально никогда не держал `ProviderException`. Если вы всё равно отрисовываете UI загрузки и ошибок, предпочитайте это императивному `try`/`catch`; тот же паттерн лежит в основе [отображения состояний загрузки и ошибок с AsyncValue](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/).

### 3. Обрабатывайте ошибку в onError у ref.listen, тоже без обёртки

Для побочных эффектов (snackbar, навигация, аналитика), запускаемых сбоем провайдера, колбэк `onError` у `ref.listen` тоже получает сырую ошибку:

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
ref.listen<AsyncValue<User>>(userProvider, (prev, next) {}, onError: (error, stack) {
  // error is the original NotFoundException, not a ProviderException.
  if (error is NotFoundException) showSnack('User ${error.id} is gone');
});
```

## Какие API оборачивают, а какие нет

Самая полезная таблица, которую стоит держать в голове. Обёртка появляется только тогда, когда провайдер **пробрасывает повторно** в ваш код императивно.

Обёрнуто в `ProviderException` (читайте `.exception`):

- `ref.read(p.future)`, где `p` не смог собраться.
- `ref.watch(p)` на синхронном провайдере, который бросил исключение, когда чтение пробрасывает его повторно.
- `await container.read(p.future)` в тестах.

Не обёрнуто (вы получаете исходную ошибку напрямую):

- `AsyncValue.error` из `ref.watch(asyncProvider)`. Проверяйте `value.error is MyException`.
- `ref.listen(p, ..., onError: (e, s) => ...)`. Здесь `e` сырой.
- `ProviderObserver.providerDidFail` (и хуки наблюдателя в целом). Наблюдатели видят неизменённую ошибку и стек.

Если ваша обработка живёт в `build` виджета через `AsyncValue`, или в слушателе, или в наблюдателе, вам, скорее всего, ничего менять не нужно. Боль миграции сосредоточена в императивном `try`/`catch` вокруг `ref.read(...future)`.

## Подводные камни и версионные ловушки

**На некоторых ранних сборках 3.0 нельзя импортировать ProviderException.** [Issue 4320](https://github.com/rrousselGit/riverpod/issues/4320) документирует период, когда документация описывала оборачивание, но сборка бросала `StateError`, а `ProviderException` ещё не был экспортирован. Если `on ProviderException` не компилируется или вы ловите `StateError` вместо него, вы на затронутой предварительной версии. Обновитесь до текущей стабильной (`flutter_riverpod` 3.3.2 или новее), где тип экспортирован, а поведение соответствует документации. Не пишите постоянный `on StateError catch` в качестве обходного решения; он снова сломается, когда вы обновитесь.

**Не оборачивайте дважды в собственном отображении ошибок.** Если у вас есть перехватчик, который ловит всё и повторно бросает нормализованное `AppException`, убедитесь, что он сначала распаковывает `ProviderException`, иначе вы вложите `ProviderException` внутрь вашего `AppException` внутрь ещё одного `ProviderException` при следующем чтении. Распаковывайте на границе: `final real = e is ProviderException ? e.exception : e;`.

**Повтор игнорирует обёртку.** Автоматический повтор Riverpod 3.0 (экспоненциальная выдержка, удвоение 200ms до потолка 6.4s) повторяет настоящие сбои сборки провайдера, но не повторяет `ProviderException`, который просто распространился от зависимости, что предотвращает запуск бури повторов через каждый нижестоящий провайдер из-за одного сбойного листового провайдера. Вы это не настраиваете; просто знайте, что пойманный и повторно брошенный `ProviderException` рассматривается как "уже учтённый".

**Обёртка не является защитой от async-разрыва.** Ловля `ProviderException` обрабатывает *сбой* провайдера; она ничего не делает с тем, что провайдер *освобождается* посреди await. Это отдельные падения. Если вы также видите `UnmountedRefException` после await, это [проблема ref.mounted](/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/), а не эта, и ей нужна защита `if (!ref.mounted) return;`, а не catch.

**`rethrow` внутри `on ProviderException` пробрасывает обёртку, а не внутреннюю ошибку.** Если ваша ветвь `default` делает `rethrow`, вызывающий код выше по стеку по-прежнему видит `ProviderException`. Обычно это то, что вам нужно (происхождение сохраняется), но если внешний слой ожидает сырые доменные исключения, пробросьте внутреннее явно: `Error.throwWithStackTrace(e.exception, e.stackTrace)`.

## Где это вписывается в обновление с 2.x на 3.0

Это один пункт в более крупной миграции на 3.0, наряду с изменением жизненного цикла `Ref.mounted` и переходом к унифицированным классам `Notifier`. Если вы делаете обновление сейчас, прогрепайте свою кодовую базу на вызовы `ref.read(`, обёрнутые в `try` с типизированным `on SomeException catch`, и на чтения `.future` внутри блоков `catch`. Это те места вызовов, которые молча перестали совпадать. Код виджетов, отрисовывающий `AsyncValue`, безопасен. Чтобы понять более широкую картину того, почему жизненный цикл и семантика ошибок, принадлежащие Notifier, являются современным умолчанием, смотрите [Provider против Riverpod против Bloc в 2026 году](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/), а если вы всё ещё на старом пакете `provider`, [миграция с provider на Riverpod](/2026/06/migrate-from-provider-to-riverpod-in-flutter/) покрывает переход до того, как вы столкнётесь с чем-либо из этого.

Ментальная модель, которая держит всё в порядке: `ProviderException` означает "провайдер в графе завершился ошибкой, и вы прочитали его императивно". Тянитесь к `.exception` за настоящей причиной или, что лучше, потребляйте сбой реактивно через `AsyncValue`, где оборачивания не происходит вовсе. Та же дисциплина, что держит [сетевые ошибки обработанными аккуратно](/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/), применима и здесь: решайте для каждого места вызова, реагируете ли вы на значение или на брошенный сбой, и выбирайте API, который отдаёт вам ошибку в той форме, которую вы ожидаете.

## Похожее

- [Как проверить Ref.mounted после async-разрыва в Flutter Riverpod 3](/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/) -- это другая ошибка Riverpod 3.0, которая всплывает только после обновления, на пути async-разрыва, а не на пути броска.
- [Как показать состояния загрузки и ошибок с AsyncValue в Flutter Riverpod](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) -- это реактивная альтернатива императивному try/catch, и она не затронута оборачиванием.
- [Исправление: нельзя использовать "ref" после того, как виджет был освобождён, в Flutter Riverpod](/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/) -- это другое падение Riverpod, которое люди путают с этим.
- [Provider против Riverpod против Bloc для управления состоянием Flutter в 2026 году](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) покрывает, почему модель ошибок и жизненного цикла Riverpod является текущим умолчанием.
- [Миграция с provider на Riverpod в Flutter](/2026/06/migrate-from-provider-to-riverpod-in-flutter/) -- это шаг перед этим, если вы всё ещё на устаревшем пакете.

## Источники

- [Миграция с 2.0 на 3.0](https://riverpod.dev/docs/3.0_migration) -- официальное заявление о том, что сбои чтения провайдера повторно бросаются как `ProviderException`, и паттерн ловли `e.exception`.
- [Что нового в Riverpod 3.0](https://riverpod.dev/docs/whats_new) -- обоснование оборачивания (различение сбоя провайдера и зависимости от сбойного провайдера), плюс поведение повтора, которое игнорирует `ProviderException`.
- [rrousselGit/riverpod issue 4320](https://github.com/rrousselGit/riverpod/issues/4320) -- ранняя расхождение 3.0, где бросался `StateError`, а `ProviderException` нельзя было импортировать.
- [changelog пакета riverpod](https://pub.dev/packages/riverpod/changelog) -- история: `2.0.0-dev.1` убрал обёртку, `3.0.0-dev.16` вернул её; текущая стабильная 3.3.2 (июнь 2026 года).
