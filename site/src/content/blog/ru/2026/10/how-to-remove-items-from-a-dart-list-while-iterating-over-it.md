---
title: "Как удалять элементы из List в Dart во время обхода без ConcurrentModificationError"
description: "Вызов remove внутри цикла for-in или forEach выбрасывает ConcurrentModificationError. Используйте removeWhere для фильтрации на месте, создайте новый список через where или collection-for либо обходите индексы в обратном порядке. Проверено на Dart 3.13.7, с бенчмарком, который показывает, почему removeAt в цикле работает медленно."
pubDate: 2026-10-25
template: how-to
tags:
  - "dart"
  - "flutter"
  - "collections"
  - "errors"
lang: "ru"
translationOf: "2026/10/how-to-remove-items-from-a-dart-list-while-iterating-over-it"
translatedBy: "claude"
translationDate: 2026-10-25
---

**Коротко:** вызывать `remove`, `removeAt` или `add` у `List`, пока её обходит цикл `for (final x in list)` или `list.forEach`, нельзя: итератор на каждом шаге проверяет длину списка и выбрасывает `ConcurrentModificationError`, как только она меняется. Замените цикл на `list.removeWhere((x) => condition)`, чтобы отфильтровать список на месте, или создайте новый список через `list.where((x) => !condition).toList()` (или collection-for), если нужно иммутабельное обновление. Если цикл по индексу действительно необходим, идите в обратном порядке, от `list.length - 1` до `0`. Всё описанное ниже проверено на Dart 3.13.7 (SDK, который поставляется с Flutter 3.47.8) на VM, в режиме AOT и после компиляции в JavaScript.

## Ошибка в контексте

Вот код, который почти каждый пишет первым:

```dart
// Dart 3.13.7
void main() {
  final numbers = [1, 2, 3];
  for (final n in numbers) {
    if (n == 1) numbers.remove(n);
  }
}
```

А вот что печатает VM:

```
Unhandled exception:
Concurrent modification during iteration: Instance(length:2) of '_GrowableList'.
#0      ListIterator.moveNext (dart:_internal/iterable.dart:366:7)
#1      main (file:///.../main.dart:4:19)
```

`length:2` в сообщении означает длину списка *после* вашего изменения, а `_GrowableList` это класс реализации VM для обычного литерала `[]`. В вебе тот же код падает с `Concurrent modification during iteration: Instance of 'JSArray<int>'.`, поэтому не ищите `_GrowableList` в логах, если баг-репорт пришёл из сборки Flutter web. У Map и Set свои варианты, `_Map len:2.` и `_Set len:2.`, с той же первопричиной.

## Почему итератор выбрасывает ошибку, а не просто перескакивает дальше

Цикл `for-in` по `List` это синтаксический сахар: берётся `list.iterator` и вызывается `moveNext()`, пока он не вернёт `false`. Итератор, который Dart использует для списков, `ListIterator` из `dart:_internal`, запоминает длину списка при создании и сравнивает её при каждом `moveNext()`:

```dart
// dart:_internal, sdk/lib/internal/iterable.dart (Dart 3.13.7)
bool moveNext() {
  int length = _iterable.length;
  if (_length != length) {
    throw ConcurrentModificationError(_iterable);
  }
  if (_index >= length) {
    _current = null;
    return false;
  }
  _current = _iterable.elementAt(_index);
  _index++;
  return true;
}
```

`List.forEach` делает ту же проверку после каждого колбэка, `removeWhere` проверяет внутри собственного цикла, и ошибка выбрасывается на *следующем* шаге, а не в строке, которая изменила список. Поэтому трассировка стека указывает на `moveNext`, а не на `remove`.

[Документация `Iterable`](https://api.dart.dev/dart-core/Iterable-class.html) формулирует контракт прямо: изменять коллекцию во время обхода в общем случае нельзя, и обычно об этом сигнализирует ConcurrentModificationError при следующем вызове Iterator.moveNext. Проверка существует потому, что альтернатива хуже. Удаление элемента `i` сдвигает всё, что идёт после него, на одну позицию влево, поэтому итератор на основе индекса молча пропустил бы элемент, который переехал на позицию `i`. Dart предпочитает падать громко.

Два следствия "следующего `moveNext()`" удивляют многих:

- **Удаление последнего элемента тоже выбрасывает ошибку.** Можно ожидать, что удалить `4` из `[1, 2, 3, 4]` на последней итерации безопасно, ведь посещать больше нечего. Это не так. Цикл вызывает `moveNext()` ещё раз, чтобы понять, что он закончился, видит изменившуюся длину и выбрасывает ошибку.
- **Добавление тоже выбрасывает.** `numbers.add(x)` внутри цикла меняет длину так же, как `remove`. В Dart нет `Iterator.remove()`, как в Java, поэтому "безопасного" способа изменить список через сам итератор не существует.

## Как выбрать правильное решение

Вот порядок, которым пользуюсь я. Каждый вариант подробно разобран ниже.

1. Если нужно убрать элементы из существующего списка на месте, вызовите `removeWhere` (или `retainWhere` для обратного условия).
2. Если список входит в иммутабельное состояние (Riverpod, Bloc, `ValueNotifier`, поле `final`, которое передаётся в виджеты), создайте новый список через `where(...).toList()` или collection-for и присвойте его.
3. Если решение об удалении зависит от индекса или соседних элементов, обходите индексы в обратном порядке и используйте `removeAt`.
4. Если тело цикла делает много работы и лишь часть итераций удаляет элементы, обходите копию (`for (final x in list.toList())`) и удаляйте из оригинала.

## Решение 1: `removeWhere` для фильтрации на месте

Это канонический ответ, и именно он должен быть вариантом по умолчанию:

```dart
// Dart 3.13.7
void main() {
  final numbers = [1, 2, 2, 3];
  numbers.removeWhere((n) => n == 2);
  print(numbers); // [1, 3]

  final tasks = <({String title, bool done})>[
    (title: 'write post', done: true),
    (title: 'review PR', done: false),
  ];
  tasks.retainWhere((t) => !t.done);
  print(tasks); // [(done: false, title: review PR)]
}
```

`removeWhere` делает один проход. В общей реализации `ListBase` он обходит список один раз, собирает оставшиеся элементы, затем записывает их обратно одним `setRange` и укорачивает длину. Он удаляет все совпадения, в отличие от `remove`, который удаляет только первый элемент, равный аргументу. Кроме того, это самый быстрый вариант с огромным отрывом, см. бенчмарк ниже.

У Map и Set есть такой же метод. `map.removeWhere((key, value) => value == 2)` и `set.removeWhere((x) => x.isEven)` исправляют варианты этой ошибки для `_Map` и `_Set`.

Внутри предиката по-прежнему действует одно правило: не изменяйте список из `test`. Предикат, который вызывает `numbers.add(...)`, выбрасывает `ConcurrentModificationError` изнутри `removeWhere` по той же причине, что и цикл `for-in`.

## Решение 2: создавать новый список вместо изменения

Если список принадлежит состоянию, на которое ссылается другой код, изменение на месте и есть настоящий баг, а `ConcurrentModificationError` лишь симптом, который случайно всплыл. Создайте новый список:

```dart
// Dart 3.13.7
void main() {
  final numbers = [1, 2, 3, 4];

  final odds = numbers.where((n) => n.isOdd).toList();
  final alsoOdds = [for (final n in numbers) if (n.isOdd) n];

  print(odds);     // [1, 3]
  print(alsoOdds); // [1, 3]
  print(numbers);  // [1, 2, 3, 4], untouched
}
```

Во Flutter именно такая форма нужна для всего, что вызывает перестроение:

```dart
// Flutter 3.47.8, Dart 3.13.7, flutter_riverpod 3.x
class TodoList extends Notifier<List<Todo>> {
  @override
  List<Todo> build() => const [];

  void clearCompleted() {
    state = [for (final t in state) if (!t.done) t];
  }
}
```

Riverpod, Bloc и `ValueNotifier` уведомляют слушателей только тогда, когда присваивается новое значение, отличающееся от старого. Вызов `state.removeWhere(...)` изменяет тот же экземпляр списка, ничего не присваивая, поэтому ничего не перестраивается, а если `state` был создан через `const []` или `List.unmodifiable`, вместо этого выбрасывается `UnsupportedError: Cannot remove from an unmodifiable list`. Если вы переводите виджет с `setState` на эту модель, [миграция с setState на Notifier в Riverpod](/ru/2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter/) описывает остальную часть перехода.

Осторожно с ленивостью. `where` возвращает ленивый `Iterable`, который читает исходный список по мере потребления, поэтому такой код всё равно выбрасывает ошибку:

```dart
// Dart 3.13.7: throws ConcurrentModificationError
for (final n in numbers.where((n) => n.isEven)) {
  numbers.remove(n);
}
```

Именно `.toList()` материализует результат и разрывает связь с источником.

## Решение 3: обход индексов в обратном порядке

Иногда решение зависит от позиции: "удалить элемент, если он равен предыдущему" или "удалить все записи после первой ошибки". Цикл по индексу здесь подходит, если он идёт в обратном порядке:

```dart
// Dart 3.13.7
void main() {
  final values = [1, 2, 2, 3, 3, 3, 4];

  // Remove consecutive duplicates.
  for (var i = values.length - 1; i > 0; i--) {
    if (values[i] == values[i - 1]) values.removeAt(i);
  }
  print(values); // [1, 2, 3, 4]
}
```

Циклы по индексу никогда не трогают итератор, поэтому никогда не выбрасывают `ConcurrentModificationError`. Но это не делает прямой цикл корректным:

```dart
// Dart 3.13.7: no exception, wrong answer for adjacent matches
final numbers = [1, 2, 2, 3];
for (var i = 0; i < numbers.length; i++) {
  if (numbers[i] == 2) numbers.removeAt(i);
}
print(numbers); // [1, 2, 3]  (one 2 survived)
```

Когда выполняется `removeAt(1)`, вторая `2` переезжает на индекс 1, а затем `i++` проходит мимо неё. Обратный обход этого избегает, потому что удаление индекса `i` сдвигает только уже посещённые элементы. Если вы всё же хотите прямой цикл, увеличивайте `i` только тогда, когда ничего не удалили, но в обратном цикле ошибиться сложнее.

## Решение 4: обход копии

Когда тело цикла делает реальную работу (журналирование, вызов колбэков, обновление других структур), а удаление лишь побочный эффект некоторых итераций, обход снимка сохраняет читаемость кода:

```dart
// Dart 3.13.7
void main() {
  final pending = [1, 2, 2, 3];
  for (final job in pending.toList()) {
    final ok = job != 2; // pretend this ran the job
    if (ok) pending.remove(job);
  }
  print(pending); // [2, 2]
}
```

`toList()` стоит одной аллокации и копирования ссылок, что пренебрежимо мало для списков размером с UI. Помните, что `remove(job)` удаляет *первый* элемент, равный `job`: для уникальных объектов это нормально, а для повторяющихся значений неожиданно. Для `Map` аналог выглядит как `for (final key in map.keys.toList())`.

## Почему `removeAt` в цикле работает медленно

Каждый `removeAt(i)` сдвигает все элементы после `i` на одну позицию влево, поэтому удаление `k` элементов из списка длиной `n` стоит примерно `O(n * k)` перемещений. `removeWhere` и `where(...).toList()` делают один проход за `O(n)`. Я измерил все три варианта на `List<int>` из 200 000 элементов, удаляя 100 000 чётных чисел, со сборкой через `dart compile exe` на Mac с Apple Silicon:

```dart
// Dart 3.13.7, dart compile exe, macOS arm64
void main() {
  const n = 200000;
  var a = List<int>.generate(n, (i) => i);
  var sw = Stopwatch()..start();
  for (var i = a.length - 1; i >= 0; i--) {
    if (a[i].isEven) a.removeAt(i);
  }
  print('removeAt backwards: ${sw.elapsedMilliseconds} ms');

  var b = List<int>.generate(n, (i) => i);
  sw = Stopwatch()..start();
  b.removeWhere((x) => x.isEven);
  print('removeWhere: ${sw.elapsedMicroseconds} us');

  var c = List<int>.generate(n, (i) => i);
  sw = Stopwatch()..start();
  final d = c.where((x) => x.isOdd).toList();
  print('where.toList: ${sw.elapsedMicroseconds} us (${d.length})');
}
```

| Подход | Время (медиана 3 запусков) |
| --- | --- |
| обратный цикл с `removeAt` | ~3 720 ms |
| `removeWhere` | ~1.0 ms |
| `where(...).toList()` | ~1.45 ms |

Это три с половиной порядка. Для списка из 20 задач всё это не важно, и стоит выбрать самый читаемый вариант. Для всего, что обрабатывает данные (разобранные строки CSV, записи журнала, очистка кеша), используйте `removeWhere`, а цикл по индексу оставьте для логики, которой действительно нужны позиции. Если очень большой список нужно обработать вне UI-потока, [выполнение работы в изоляте Dart](/ru/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) сохранит плавность кадров, но цикл `O(n^2)` это не исправит.

## Когда нужны ещё и удалённые элементы

`removeWhere` возвращает `void`, поэтому увидеть удалённое нельзя. Соблазнительное решение вызывает предикат дважды:

```dart
final removed = items.where(isExpired).toList();
items.removeWhere(isExpired);
```

Это корректно только если `isExpired` детерминирован. Если он читает `DateTime.now()`, элемент может истечь между двумя вызовами и исчезнуть, не попав в `removed`. Вместо этого разделите элементы за один проход:

```dart
// Dart 3.13.7
extension RemoveAndCollect<E> on List<E> {
  List<E> removeWhereAndCollect(bool Function(E element) test) {
    final removed = <E>[];
    final kept = <E>[];
    for (final e in this) {
      (test(e) ? removed : kept).add(e);
    }
    if (removed.isNotEmpty) {
      setRange(0, kept.length, kept);
      length = kept.length;
    }
    return removed;
  }
}

void main() {
  final items = [1, 2, 3, 4, 5];
  final evens = items.removeWhereAndCollect((x) => x.isEven);
  print(items); // [1, 3, 5]
  print(evens); // [2, 4]
}
```

`for-in` здесь безопасен, потому что ничто не изменяет `this`, пока цикл не завершится.

## Подводные камни, которые скрывают или меняют ошибку

**Удаление и последующее добавление в одной итерации молча портят цикл.** Итератор сравнивает только длины. Если итерация удаляет один элемент и добавляет другой, длина не меняется и ничего не выбрасывается:

```dart
// Dart 3.13.7: no exception, element 3 is never visited
final l = [1, 2, 3, 4];
for (final x in l) {
  print('visit $x'); // visit 1, visit 2, visit 4, visit 20
  if (x == 2) {
    l.remove(x);
    l.add(20);
  }
}
```

`3` переехала на уже посещённую позицию и была пропущена. Отсутствие `ConcurrentModificationError` не доказывает корректность кода. Замена элемента на месте, `l[i] = newValue`, действительно безопасна, потому что не меняет длину и ничего не сдвигает.

**`await` внутри цикла открывает дверь другому коду.** Именно эта версия проявляется во Flutter-приложениях как нерегулярный краш:

```dart
// Dart 3.13.7
import 'dart:async';

Future<void> main() async {
  final items = [1, 2, 3];
  Timer(const Duration(milliseconds: 5), () => items.removeAt(0));

  for (final x in items) {
    await Future<void>.delayed(const Duration(milliseconds: 10));
    print('processed $x');
  }
  // processed 1, then ConcurrentModificationError
}
```

Ничто в теле цикла не трогает `items`. Это делает таймер, слушатель stream или обработчик нажатия кнопки, который выполняется во время `await`. Решение то же, что и в Решении 4: обходите `items.toList()` или сделайте общий список иммутабельным и заменяйте его. Если асинхронный цикл находится в `State`, именно в этом разрыве нужна и [проверка mounted перед вызовом setState](/ru/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/), а вызов без `await` внутри цикла это ровно то, что должны ловить [линты `unawaited_futures` и `discarded_futures`](/ru/2026/10/unawaited-futures-vs-discarded-futures-lint-in-dart/).

**Map допускает обновление значений, но не изменение ключей.** `for (final k in map.keys) map[k] = 0;` работает, потому что обновление существующего ключа не меняет структуру Map. `map.remove(k)` или добавление нового ключа выбрасывает ошибку. Удаление отсутствующего ключа ничего не делает и ошибку не выбрасывает.

**`addAll` самого себя выбрасывает ошибку сразу.** `list.addAll(list)` для growable-списка VM выбрасывает `ConcurrentModificationError` безо всякого цикла. Используйте `list.addAll(list.toList())` или `[...list, ...list]`.

**Списки фиксированной длины и неизменяемые списки выбрасывают `UnsupportedError`, а не эту ошибку.** `List.filled(3, 0).removeWhere(...)` выбрасывает `Unsupported operation: Cannot remove from a fixed-length list`, а список `const` или `List.unmodifiable` выбрасывает `Cannot remove from an unmodifiable list`. [Документация `removeWhere`](https://api.dart.dev/dart-core/List/removeWhere.html) говорит об этом прямо: список должен быть growable. Для таких случаев используйте Решение 2.

**Удаление из списка, на котором построен `ListView`, требует ключей.** После `setState(() => _items.removeWhere(...))` Flutter сопоставляет старые и новые дочерние элементы по позиции, если вы не задали им ключи, поэтому состояние элемента (чекбокс, текстовое поле, анимация) может перескочить в чужую строку. [Статья о ключах во Flutter](/ru/2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs/) разбирает решение с `ValueKey(item.id)`.

### Что почитать дальше

- [Как защитить setState проверкой mounted после асинхронного разрыва во Flutter](/ru/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/)
- [Что такое Key во Flutter и когда его отсутствие приводит к багам?](/ru/2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs/)
- [Миграция StatefulWidget с setState на Notifier в Riverpod](/ru/2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter/)
- [Линты unawaited_futures и discarded_futures в Dart](/ru/2026/10/unawaited-futures-vs-discarded-futures-lint-in-dart/)

### Источники

- [Документация класса `Iterable`](https://api.dart.dev/dart-core/Iterable-class.html), раздел об изменении коллекции во время обхода
- [Класс `ConcurrentModificationError`](https://api.dart.dev/dart-core/ConcurrentModificationError-class.html)
- [`List.removeWhere`](https://api.dart.dev/dart-core/List/removeWhere.html) и [`List.retainWhere`](https://api.dart.dev/dart-core/List/retainWhere.html)
- Исходный код Dart SDK: [`ListIterator.moveNext` в `sdk/lib/internal/iterable.dart`](https://github.com/dart-lang/sdk/blob/main/sdk/lib/internal/iterable.dart) и [`ListBase._filter` в `sdk/lib/collection/list.dart`](https://github.com/dart-lang/sdk/blob/main/sdk/lib/collection/list.dart)
