---
title: "Как безопасно использовать BuildContext после await во Flutter"
description: "Считайте всё необходимое из context до await, а затем защитите продолжение через if (context.mounted) return. Здесь полный паттерн, правило линтера, которое его требует, и краевые случаи, которые оно не ловит."
pubDate: 2026-06-22
tags:
  - "flutter"
  - "dart"
  - "async"
lang: "ru"
translationOf: "2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-22
---

Правило короткое: `BuildContext` действителен только пока его виджет смонтирован, а `await` может размонтировать виджет до того, как ваш код возобновится. Поэтому считайте всё необходимое из context (`NavigatorState`, `ScaffoldMessengerState`, значение темы) до первого `await`, выполните асинхронную работу, а затем защитите возобновление через `if (!context.mounted) return;`, прежде чем снова трогать context. Эта единственная привычка предотвращает целое семейство сбоев вида "использовал context после того, как он покинул дерево". В этом руководстве используются Flutter 3.44 (стабильная версия, май 2026) и Dart 3.x.

`BuildContext` -- это не мешок данных, который можно отложить и переиспользовать. Это живой handle на `Element` в дереве виджетов. В тот момент, когда пользователь уходит на другой экран, родитель перестраивает вас из существования или маршрут закрывается, этот элемент деактивируется, а затем уничтожается. Чтение предка из мёртвого элемента (`Navigator.of`, `Theme.of`, `Provider.of`) не определено: в отладке вы получаете assertion, в release -- устаревшее значение или разыменование null гораздо позже. Асинхронный случай бьёт сильнее всего, потому что разрыв между "context был действителен" и "context используется" невидим в исходном коде: он прячется внутри `await`.

## Почему await -- это опасная часть

Flutter вызывает `build` синхронно и ожидает, что он завершится, прежде чем что-либо ещё тронет дерево. Пока ваш код выполняется синхронно из обработчика событий, context остаётся действительным всё это время. В тот момент, когда вы вызываете `await`, вы возвращаете управление циклу событий. Выполняются другие кадры. Пользователь может нажать кнопку назад, родительский `StreamBuilder` может перестроиться, тайм-аут может вызвать закрытие маршрута. Когда ваше продолжение возобновляется, вы находитесь в более позднем кадре, и виджет, которому принадлежал `context`, может исчезнуть.

```dart
// Flutter 3.44, Dart 3.x -- the gap is invisible but real
Future<void> _onSave() async {
  await api.save(form);            // <-- control leaves here, frames run
  Navigator.of(context).pop();     // <-- may execute on a dead context
}
```

Ничто в `_onSave` не выглядит неправильным. Ошибка структурная: `context` был неявно захвачен в точке вызова и переиспользован через точку приостановки. Это в точности та ситуация, которую [сбой при поиске предка деактивированного виджета](/ru/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/) описывает со стороны сообщения об ошибке. Здесь мы смотрим на это со стороны предотвращения.

## Безопасный паттерн, шаг за шагом

Следуйте этим четырём шагам всякий раз, когда асинхронному методу нужен context после того, как он приостановился. Первые два -- несущие; остальное -- то, как вы держите их в честности.

1. **Считайте всё из context до первого `await`.** Разрешите `Navigator.of(context)`, `ScaffoldMessenger.of(context)`, `Theme.of(context)` и любые вызовы `Provider.of`/`context.read` в локальные переменные, пока виджет ещё смонтирован. Они возвращают долгоживущие объекты состояния, которые остаются действительными даже после смерти исходного элемента.
2. **Выполните асинхронную работу.** Теперь `await` может занимать сколько угодно времени. Вы не удерживаете context через него; вы удерживаете разрешённые объекты состояния, которые переживают элемент.
3. **Защитите возобновление проверкой mounted.** Сразу после `await` напишите `if (!context.mounted) return;` (или `if (!mounted) return;` внутри `State`). Если виджет покинул дерево во время await, вы останавливаетесь здесь и никогда не трогаете мёртвый context.
4. **После разрыва используйте только захваченные объекты.** Вызывайте `navigator.pop()` и `messenger.showSnackBar(...)` на локальных переменных, которые вы захватили на шаге 1, а не снова на `Navigator.of(context)`.

Применительно к неисправному примеру:

```dart
// Flutter 3.44, Dart 3.x -- safe
Future<void> _onSave() async {
  final navigator = Navigator.of(context);          // 1. capture
  final messenger = ScaffoldMessenger.of(context);

  await api.save(form);                              // 2. async work

  if (!context.mounted) return;                      // 3. guard

  messenger.showSnackBar(                            // 4. use captures
    const SnackBar(content: Text('Saved')),
  );
  navigator.pop();
}
```

Две независимые вещи делают это корректным. Захват `navigator` и `messenger` до await означает, что вы никогда не вызываете `.of(context)` на деактивированном элементе. Проверка `context.mounted` затем полностью пропускает работу с UI, когда пользователь уже ушёл, что почти всегда и есть желаемое поведение: нет смысла показывать snackbar на экране, на который никто не смотрит.

## mounted на State против mounted на BuildContext

Существует два геттера `mounted`, и они не взаимозаменяемы по тому, где вы к ним обращаетесь, хотя и отвечают на один и тот же вопрос.

`State.mounted` существовал всегда. Внутри класса состояния `StatefulWidget` пишите `if (!mounted) return;`. Он равен `true` между `initState` и `dispose` и, что критично, уже равен `false` во время `deactivate`, так что он корректно ловит случай "виджет уходит", а не только "виджет полностью мёртв".

`BuildContext.mounted` появился во Flutter 3.7 (Dart 2.19) для случая, когда у вас есть только context, а не `State`: вспомогательные функции, колбэки в `StatelessWidget`, методы-расширения. Он возвращает, смонтирован ли ещё нижележащий элемент.

```dart
// Flutter 3.44, Dart 3.x
// Inside a State subclass:
if (!mounted) return;          // State.mounted

// In a helper that only has a context:
if (!context.mounted) return;  // BuildContext.mounted
```

Предпочитайте `State.mounted`, когда находитесь внутри класса состояния, потому что он читает жизненный цикл виджета, которым вы действительно владеете. Используйте `context.mounted`, когда context -- это всё, что у вас есть. Оба должны проверяться *после* await, никогда до: разрыв -- это await, так что проверка, выполняемая до него, ничего не говорит о состоянии после.

## Почему одного захвата недостаточно и одной защиты недостаточно

Люди часто делают одну из двух половин и полагают, что они защищены. Это не так.

Если вы только **захватываете**, но пропускаете защиту, вы избегаете сбоя деактивированного context, но всё ещё можете выполнять побочные эффекты UI на экране, который пользователь уже покинул: snackbar, мелькающий на неправильном маршруте, `pop()`, закрывающий маршрут, который уже не ваш. Захват делает вызов законным; защита делает его *корректным*.

Если вы только **защищаете**, но пропускаете захват, у вас есть тонкая ошибка порядка. Рассмотрите:

```dart
// Flutter 3.44, Dart 3.x -- still wrong despite the guard
Future<void> _onSave() async {
  await api.save(form);
  if (!context.mounted) return;
  Navigator.of(context).pop();   // re-reads context AFTER the gap
}
```

Обычно это работает, потому что проверка `context.mounted` прошла на том же синхронном тике, что и вызов `Navigator.of`. Но это хрупко: если вы добавите второй `await` между проверкой и поиском, окно снова откроется. Паттерн "сначала захват" полностью убирает поиск с пути после await, так что не остаётся ничего, что могло бы устареть. Относитесь к "захватить до, защитить после, использовать захваченное" как к единому неделимому действию.

## Правило линтера, которое это требует: use_build_context_synchronously

Dart поставляется с правилом линтера `use_build_context_synchronously`, которое помечает `BuildContext`, использованный после асинхронного разрыва без защиты `mounted` между await и использованием. Оно включено по умолчанию в пакете `flutter_lints`, который новые проекты Flutter подключают через `analysis_options.yaml`:

```yaml
# analysis_options.yaml -- on by default in flutter_lints
include: package:flutter_lints/flutter.yaml
```

Если ваш проект старше значения по умолчанию или вы убрали include, добавьте правило явно:

```yaml
# analysis_options.yaml
linter:
  rules:
    use_build_context_synchronously: true
```

Правило понимает защиту. Написание `if (!context.mounted) return;` (или `if (context.mounted) { ... }`) после await снимает предупреждение, потому что анализатор может доказать, что context жив на пути, который его использует. Вот почему канонической формой является `if (context.mounted)`, а не какой-то эквивалент, написанный вами вручную: линтер сопоставляет с образцом известные безопасные формы. Более ранние версии анализатора даже выдавали ложное срабатывание, когда `BuildContext.mounted` использовался вне буквальной формы `if (context.mounted) {}`, что зафиксировано в списке issue Dart SDK; текущие версии обрабатывают распространённые формы, но это ещё одна причина придерживаться идиоматической защиты.

То, что линтер **не** ловит, столь же важно. Это синтаксическая проверка, так что она не может видеть через границы функций. Если вы передаёте `BuildContext` во вспомогательную функцию и вызываете `await` внутри неё, анализатор часто не может связать разрыв с последующим использованием. Он также не спасёт вас от логики, которая захватывает context в поле и переиспользует его гораздо позже. Линтер -- сильная первая линия обороны, но не доказательство.

## Передача context во вспомогательную функцию

Частый способ ускользнуть от линтера -- перенести await во вспомогательную функцию, которая принимает `BuildContext` как параметр. Паттерн нормален, но вспомогательная функция теперь берёт на себя ответственность за защиту и должна перепроверять `mounted` сама, а не доверять вызывающему.

```dart
// Flutter 3.44, Dart 3.x -- the helper guards its own context use
Future<void> confirmAndDelete(BuildContext context, Item item) async {
  final messenger = ScaffoldMessenger.of(context);

  final ok = await showDialog<bool>(
    context: context,
    builder: (_) => const ConfirmDialog(),
  );

  if (ok != true) return;
  if (!context.mounted) return;   // guard inside the helper

  await repository.delete(item);
  if (!context.mounted) return;   // second await, second guard

  messenger.showSnackBar(const SnackBar(content: Text('Deleted')));
}
```

Два await означают две защиты. Каждая точка приостановки заново открывает окно, так что проверка `mounted` уместна после каждой, которая предшествует использованию context, а не только после первой. Захват `messenger` заранее означает, что последняя строка никогда не перечитывает context.

## Циклы, повторы и несколько await

Везде, где использование context стоит после более чем одной возможной приостановки, проверьте каждый путь. Цикл повторов -- хрестоматийный случай:

```dart
// Flutter 3.44, Dart 3.x
Future<void> _uploadWithRetry() async {
  final messenger = ScaffoldMessenger.of(context);

  for (var attempt = 1; attempt <= 3; attempt++) {
    try {
      await api.upload(file);     // suspension point inside the loop
      break;
    } catch (_) {
      if (attempt == 3) rethrow;
      await Future<void>.delayed(const Duration(seconds: 1)); // another one
    }
  }

  if (!context.mounted) return;   // single guard after the loop is enough
  messenger.showSnackBar(const SnackBar(content: Text('Uploaded')));
}
```

Здесь вам не нужна защита внутри цикла, потому что ничто внутри цикла не трогает context; единственное использование context -- после него, так что одна защита покрывает все пути выхода. Принцип обобщается: размещайте защиту непосредственно перед каждым использованием context, после последнего await, который может ему предшествовать. Обращение к структурированному подходу вроде [аккуратной обработки ошибок и загрузки](/ru/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) сохраняет эти потоки читаемыми, потому что состояния повтора и ошибки становятся данными, которые рендерит ваш виджет, а не императивными вызовами UI, разбросанными после await.

## У StatelessWidget нет mounted, так что используйте context

У `StatelessWidget` нет `State`, так что нет и поля `mounted`. Используйте `context.mounted`, для чего он именно и существует:

```dart
// Flutter 3.44, Dart 3.x -- StatelessWidget callback
ElevatedButton(
  onPressed: () async {
    final navigator = Navigator.of(context);
    await Future<void>.delayed(const Duration(seconds: 1));
    if (!context.mounted) return;
    navigator.pop();
  },
  child: const Text('Close'),
);
```

Если вы обнаруживаете, что вам нужно несколько защит в колбэках виджета без состояния, это часто сигнал о том, что виджет должен быть stateful, или о том, что асинхронная работа принадлежит контроллеру или notifier, а не встроена в обработчик кнопки.

## Ловушки и похожие случаи

**`Navigator.pop`, затем использование context.** Классические две строки: `Navigator.pop(context)`, за которым следует ещё один вызов `.of(context)`. Pop начинает деактивировать элемент маршрута, так что второй поиск может упасть даже без await на виду. Захватите navigator (и всё остальное) до закрытия.

**`initState` не может делать поиск inherited.** `Theme.of`, `MediaQuery.of` и любой `dependOnInheritedWidgetOfExactType` незаконны в `initState`, потому что элемент ещё не подключён к своим унаследованным зависимостям. Перенесите эти чтения в `didChangeDependencies`, где context полностью действителен. Это другой assertion, отличный от асинхронного, но он проистекает из того же вопроса "действителен ли context прямо сейчас?".

**Release-сборки скрывают сбой.** Assertion деактивированного context срабатывает только в отладке. В profile и release поиск возвращает null, и вы получаете `Null check operator used on a null value` где-то ниже по стеку. Если сбой появляется только в release и только после навигации, подозревайте незащищённое использование context после await. [Защита от setState, вызванного во время build](/ru/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) имеет тот же характер assertion, активного только в отладке.

**Эквивалент в Riverpod.** Если вы удерживаете `WidgetRef` вместо `BuildContext`, соответствующий сбой -- [Cannot use "ref" after the widget was disposed](/ru/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/). Та же корневая причина, то же решение: читать до await, защищать после. Моделирование асинхронной работы как [состояний загрузки и ошибки с AsyncValue](/ru/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) обходит большинство ручных защит, потому что фреймворк отслеживает жизненный цикл виджета за вас, и вы перестаёте трогать context вручную.

**Таймеры и слушатели потоков.** Context, использованный в `Timer`, `Stream.listen` или слушателе статуса анимации, может сработать после того, как виджет исчез. Защищайтесь с помощью `mounted`, а также отменяйте источник в `dispose`, чтобы колбэк вообще перестал срабатывать -- та же дисциплина, которую вы применяете, когда [освобождаете контроллеры, чтобы избежать утечек](/ru/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).

## Единственная привычка, которая упраздняет весь этот класс ошибок

Считайте `BuildContext` действительным только от начала синхронного прогона до следующего `await`. Прежде чем приостановиться, считайте объекты состояния, которые вам понадобятся. После возобновления проверьте `mounted`, прежде чем трогать что-либо, привязанное к дереву. Делайте это механически, и сбой деактивированного предка, сбой освобождённого контроллера и разыменование null после await перестают появляться, потому что это никогда не было тремя ошибками. Это было одно правило, нарушенное тремя способами.

## Источники

- [Правило линтера use_build_context_synchronously](https://dart.dev/tools/linter-rules/use_build_context_synchronously), правила линтера Dart, определяющие, что помечает анализатор и какие формы защиты он распознаёт.
- [Свойство BuildContext.mounted](https://api.flutter.dev/flutter/widgets/BuildContext/mounted.html), документация API Flutter (добавлено во Flutter 3.7).
- [Свойство State.mounted](https://api.flutter.dev/flutter/widgets/State/mounted.html), документация API Flutter.
- [flutter/flutter#19462](https://github.com/flutter/flutter/issues/19462), канонический issue, прослеживающий сбой деактивированного context до асинхронных колбэков.
