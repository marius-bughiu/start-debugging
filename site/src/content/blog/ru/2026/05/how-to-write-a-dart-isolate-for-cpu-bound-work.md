---
title: "Как написать isolate в Dart для CPU-нагруженной работы"
description: "Когда async/await недостаточно: запустите isolate в Dart, чтобы вынести CPU-нагруженную работу с UI-потока. Isolate.run, функция compute из Flutter, долгоживущие воркеры с SendPort/ReceivePort, что может пересечь границу, и оговорка для JS/web. Проверено на Dart 3.11 и Flutter 3.27.1."
pubDate: 2026-05-05
tags:
  - "dart"
  - "flutter"
  - "isolates"
  - "concurrency"
  - "performance"
  - "how-to"
lang: "ru"
translationOf: "2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work"
translatedBy: "claude"
translationDate: 2026-05-05
---

Короткий ответ: для разовой вычислительной задачи вызовите `await Isolate.run(myFunction)` (Dart 2.19+) или в Flutter `await compute(myFunction, arg)`. Для воркера, обслуживающего много запросов, используйте `Isolate.spawn` с `ReceivePort` на каждой стороне и пропускайте сообщения через `SendPort`. Функция, которую вы передаёте в isolate, должна быть верхнего уровня или `static`, сообщение и результат должны быть отправляемыми, а в вебе `compute` исполняется на event loop, потому что у dart2js нет настоящих isolates. Проверено на Dart 3.11 и Flutter 3.27.1 с Android Gradle Plugin 8.7.3.

Асинхронность в Dart -- это не параллелизм. `Future`, `await` и `Stream` планируют работу на том же однопоточном event loop, на котором выполняется ваш UI. Если синхронный шаг внутри этого future тратит 80 мс на разбор JSON-документа размером 4 МБ или вычисление хеша файла, цикл блокируется на 80 мс, GPU теряет два кадра при 60 fps, и в логах появляется `Skipped 5 frames!`. Isolate -- это способ Dart выйти за пределы единственного потока: отдельная heap виртуальной машины со своим event loop, своей сборкой мусора и без общей памяти с вызывающим isolate. Вы переносите работу туда, получаете ответ обратно, а UI-поток продолжает рисовать.

## Когда isolate -- правильный инструмент

Дорогая операция должна быть **синхронной CPU-работой**, а не долгим сетевым вызовом. Обернуть `http.get` в isolate бесполезно, потому что `http.get` уже асинхронный и уступает event loop, пока ждёт сокет. Реальные кандидаты:

- Разбор JSON-полезной нагрузки больше ~1 МБ. `jsonDecode` синхронен и масштабируется линейно с размером данных.
- Декодирование и изменение размера изображений через `package:image`. Чистый Dart, без плагина платформы, и JPEG в 12 МП занимает сотни миллисекунд.
- Криптографическое хеширование файла (SHA-256 поверх буферизованного потока, BCrypt для проверки пароля).
- Регулярные выражения по большому документу, особенно с `multiline: true` и lookbehind.
- Сжатие / распаковка через `package:archive`.
- Числовая работа: умножение матриц для маленькой ML-модели, FFT, свёртка ядра изображения.

Если вы не можете указать на стек-фрейм, который синхронно выполняется дольше ~16 мс (бюджет одного кадра при 60 fps), isolate не поможет. Сначала профилируйте через CPU profiler в Flutter DevTools; смотреть нужно на таймлайн "UI thread".

## Самый дешёвый путь: Isolate.run

`Isolate.run<R>(FutureOr<R> Function() computation, {String? debugName})` появился в Dart 2.19 и в 2026 году именно к нему документация направляет в первую очередь. Он порождает isolate, выполняет колбэк, возвращает результат без копирования на VM и сворачивает isolate.

```dart
// Dart 3.11
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';

Future<List<dynamic>> parseLargeJson(File file) async {
  final text = await file.readAsString();
  return Isolate.run(() => jsonDecode(text) as List<dynamic>);
}
```

Здесь происходят две вещи. Во-первых, чтение файла остаётся в вызывающем isolate, потому что `readAsString` уже асинхронный и не блокирует event loop. Во-вторых, `jsonDecode` выполняется в новом isolate, и получившийся `List<dynamic>` приходит обратно через границу. Запуск isolate стоит примерно от 1 до 3 мс на современном телефоне, поэтому это оправдано только тогда, когда сама работа занимает хотя бы в десять раз больше.

Частая ошибка -- передавать замыкание, которое захватывает окружающий контекст:

```dart
// Dart 3.11 - works, but copies state you did not intend to send
Future<int> countWordsBuggy(String text, Set<String> stopWords) async {
  return Isolate.run(() {
    return text
        .split(RegExp(r'\s+'))
        .where((w) => !stopWords.contains(w))
        .length;
  });
}
```

Замыкание захватывает `text` и `stopWords`, поэтому оба копируются в новый isolate. Для маленьких входов это нормально, но если `text` весит 50 МБ, вы только что заплатили 50 МБ выделения памяти и проход сериализации. Хуже того, если захваченное состояние содержит неотправляемый объект (открытый `Socket`, `DynamicLibrary`, `ReceivePort`, что-либо помеченное `@pragma('vm:isolate-unsendable')`), вы получите `ArgumentError` во время выполнения из вызова spawn. Решение: либо держать захваченное состояние минимальным, либо привязывать точку входа верхнего уровня и явно передавать ей аргументы.

## Функция compute из Flutter и чем она на самом деле является

`compute<M, R>(ComputeCallback<M, R> callback, M message)` из `package:flutter/foundation.dart` появился раньше `Isolate.run` и до сих пор остаётся самой цитируемой API в туториалах по Flutter. На момент Flutter 3.27.1 она документирована как эквивалент `Isolate.run(() => callback(message))` на нативных платформах. На веб-таргете она исполняет колбэк синхронно на том же event loop, потому что dart2js компилируется в JavaScript, а в браузере настоящих isolates нет; параллелизма в вебе вы не получите, какой бы API вы ни вызвали.

```dart
// Flutter 3.27.1, Dart 3.11
import 'package:flutter/foundation.dart';

List<Person> _parsePeople(String body) {
  final raw = jsonDecode(body) as List<dynamic>;
  return raw.cast<Map<String, dynamic>>().map(Person.fromJson).toList();
}

Future<List<Person>> fetchPeople(http.Client client) async {
  final res = await client.get(Uri.parse('https://api.example.com/people'));
  return compute(_parsePeople, res.body);
}
```

`_parsePeople` -- функция верхнего уровня, не замыкание и не метод. Это правило, на котором ловятся чаще всего: колбэк, который вы передаёте в `compute` (или в `Isolate.spawn`), должен быть функцией верхнего уровня или `static`, чтобы передавался только её идентификатор, а не охватывающий контекст. Если вы напишете `compute(this._parsePeople, body)`, попадёте в ту же ловушку с захватом замыкания, что и раньше, и вдобавок можете попытаться отправить целиком всё дерево виджетов вокруг.

## Долгоживущие воркеры: Isolate.spawn с двунаправленными портами

`Isolate.run` одноразовый. Если вам нужен воркер, обслуживающий много запросов (поисковый индекс, который один раз загружает 200 МБ, а потом отвечает на 50 запросов), нужны `Isolate.spawn` плюс ваш собственный протокол поверх `SendPort` / `ReceivePort`.

Шаблон симметричный: каждая сторона открывает `ReceivePort` и шлёт соответствующий `SendPort` на другую сторону, после чего обе стороны общаются через эти порты.

```dart
// Dart 3.11
import 'dart:async';
import 'dart:isolate';

class SearchWorker {
  late final SendPort _toWorker;
  late final ReceivePort _fromWorker;
  final Map<int, Completer<List<int>>> _pending = {};
  int _nextId = 0;

  static Future<SearchWorker> start(List<String> corpus) async {
    final fromWorker = ReceivePort('search.fromWorker');
    await Isolate.spawn(_entry, [fromWorker.sendPort, corpus],
        debugName: 'search-worker');
    final ready = Completer<SendPort>();
    final iter = StreamIterator(fromWorker);
    if (await iter.moveNext()) ready.complete(iter.current as SendPort);

    final w = SearchWorker._();
    w._toWorker = await ready.future;
    w._fromWorker = fromWorker;
    fromWorker.listen(w._onMessage);
    return w;
  }

  SearchWorker._();

  Future<List<int>> query(String term) {
    final id = _nextId++;
    final c = Completer<List<int>>();
    _pending[id] = c;
    _toWorker.send([id, term]);
    return c.future;
  }

  void _onMessage(dynamic msg) {
    final list = msg as List;
    final id = list[0] as int;
    final hits = (list[1] as List).cast<int>();
    _pending.remove(id)?.complete(hits);
  }

  void dispose() {
    _toWorker.send(null); // sentinel
    _fromWorker.close();
  }
}

void _entry(List args) async {
  final replyTo = args[0] as SendPort;
  final corpus = (args[1] as List).cast<String>();
  final inbound = ReceivePort('search.inbound');
  replyTo.send(inbound.sendPort);

  await for (final msg in inbound) {
    if (msg == null) {
      inbound.close();
      break;
    }
    final list = msg as List;
    final id = list[0] as int;
    final term = (list[1] as String).toLowerCase();
    final hits = <int>[];
    for (var i = 0; i < corpus.length; i++) {
      if (corpus[i].toLowerCase().contains(term)) hits.add(i);
    }
    replyTo.send([id, hits]);
  }
  Isolate.exit();
}
```

На пару моментов стоит обратить внимание. Рукопожатие (воркер создаёт входящий `ReceivePort`, шлёт свой `SendPort` обратно по порту, который дал ему хост) -- это бойлерплейт, но избежать его нельзя: глобального реестра портов isolates не существует. Карта `_pending` плюс монотонный id -- то, что позволяет иметь несколько одновременно летящих запросов; без id вы можете только сериализовать запросы. Сторожевое значение `null` корректно завершает воркер, а `Isolate.exit()` быстрее, чем дождаться возврата `main`, потому что он шлёт последнее сообщение без копирования.

Если вам нужна семантика pause / resume или kill, сохраните `Isolate`, который возвращает `Isolate.spawn`, и вызовите `isolate.kill(priority: Isolate.immediate)`. Учтите, что `kill` не запускает финализаторы в воркере, поэтому любой открытый файл или хендл базы данных, который держал воркер, утечёт до завершения процесса.

## Что может пересечь границу

Большинство объектов Dart можно отправлять. Исключения на момент Dart 3.11:

- Объекты с нативными ресурсами: `Socket`, `RawSocket`, `RandomAccessFile`, `Process`.
- `ReceivePort`, `RawReceivePort`, `DynamicLibrary`, `Pointer`, все финализаторы из `dart:ffi`.
- Всё, помеченное `@pragma('vm:isolate-unsendable')`.
- Замыкания, захватывающие неотправляемое состояние. Захват проверяется транзитивно, поэтому замыкание, ссылающееся на экземпляр класса, у которого есть поле `Socket`, тоже неотправляемое.

К отправляемым типам относятся все примитивы, `String`, `Uint8List` и другие типизированные списки, `List`, `Map`, `Set`, `DateTime`, `Duration`, `BigInt`, `RegExp`, а также любой экземпляр класса, у которого все поля сами отправляемы. Отправка typed-data буфера копирует его через heap, если только вы не оборачиваете его в `TransferableTypedData`, который даёт передачу без копирования:

```dart
// Dart 3.11
import 'dart:typed_data';
import 'dart:isolate';

Future<int> sumBytes(Uint8List bytes) async {
  final transferable = TransferableTypedData.fromList([bytes]);
  return Isolate.run(() {
    final view = transferable.materialize().asUint8List();
    var sum = 0;
    for (final b in view) {
      sum += b;
    }
    return sum;
  });
}
```

`materialize()` одноразовый на каждый `TransferableTypedData`, поэтому отправитель теряет доступ к буферу, как только воркер его материализует. В этом и весь смысл: память перемещается, а не дублируется. Для полезных нагрузок выше нескольких мегабайт разница между `TransferableTypedData` и обычной копией -- это разница между 1 мс и 30 мс.

## Подводные камни, на которые попадается каждая команда

**Замыкания захватывают больше, чем вам кажется.** Даже пустое замыкание внутри метода захватывает `this`. Если `this` -- это state у `StatefulWidget`, вы только что закрепили всё поддерево виджетов на heap воркера до завершения вызова. Всегда вытаскивайте нужные данные в локальные переменные и передавайте их аргументами в функцию верхнего уровня.

**Запуск isolate не бесплатен.** Голый `Isolate.run` с пустым колбэком стоит примерно 2 мс на Pixel 7 и от 4 до 6 мс на старом Android-устройстве. Если вы вызываете `compute` 60 раз в секунду на каждое нажатие, вы написали себе собственное узкое место. Либо группируйте работу пачками, либо постройте долгоживущий воркер.

**Веб-таргет -- ложь в части параллелизма.** И `compute`, и `Isolate.run` на вебе откатываются к выполнению на текущем event loop, потому что Dart, скомпилированный в JavaScript, выполняется в одном потоке браузера. Если вам важен параллелизм в вебе, нужен настоящий Web Worker, написанный отдельно, со своим протоколом сообщений. Поддержка воркеров в `dart:js_interop` развивается, но на момент Dart 3.11 она не является заменой `Isolate.run` без правок.

**`debugPrint` из воркера может перемежаться.** У каждого isolate свой пайплайн `print`. На Android порядок в `logcat` -- best-effort. Если вы отлаживаете состояние гонки, добавляйте к каждой строке лога в воркере порядковый номер, чтобы вы могли пересортировать их офлайн.

**Не делите состояние по ссылке.** Частый шаблон бага -- считать, что `Map`, который вы отправили в isolate, -- это "тот же" map. Это не так; воркер получил глубокую копию. Мутация её в воркере не имеет эффекта в вызывающей стороне. Относитесь к каждой границе isolate как к границе сериализации.

## Как это вписывается в остальной Flutter-пайплайн

Конкретно для Flutter-проектов окружение важно не меньше самого isolate. Профилируйте стоимость холодного старта в DevTools, прежде чем тянуться к spawn, потому что работа первого кадра обычно доминирует на слабых Android-устройствах. Если вы пишете долгоживущий воркер, который загружает нативные ресурсы, действуют те же правила потоков, что и при [обращении к коду платформы через method channels](/ru/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/), потому что вызовы `MethodChannel` из воркер-isolate не поддерживаются на Android (только корневой isolate имеет binary messenger по умолчанию). Для воспроизводимости в CI явно фиксируйте и Flutter, и Dart, а тесты, нагруженные isolates, прогоняйте на каждой версии, которую выпускаете; [матричный CI-workflow](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) -- самый дешёвый способ поймать регрессию, в которой стоимость spawn или кодек поменялись у вас под ногами. А когда вы отлаживаете воркер, который зависает, [workflow для iOS из Windows](/ru/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/) рассказывает, как присоединиться к observer port по сети, чтобы видеть стек-фреймы воркера в реальном времени.

Самая короткая формулировка правила: если вы написали `await`, а UI всё равно подвисает, в ожидаемой цепочке где-то есть синхронная работа. `Isolate.run` для одного вызова, `compute` если вы живёте внутри Flutter и хотите на один импорт меньше, `Isolate.spawn` плюс ваш собственный протокол портов, когда у воркера есть состояние инициализации, которое стоит держать тёплым. Всё остальное (таблицы типов, ловушки замыканий, оговорка про веб) -- это бухгалтерия вокруг этих трёх вариантов.

## Source links

- [Dart concurrency and isolates](https://dart.dev/language/concurrency)
- [Isolate.run API reference](https://api.dart.dev/stable/dart-isolate/Isolate/run.html)
- [Isolate.spawn API reference](https://api.dart.dev/stable/dart-isolate/Isolate/spawn.html)
- [Flutter compute function](https://api.flutter.dev/flutter/foundation/compute.html)
- [TransferableTypedData](https://api.dart.dev/stable/dart-isolate/TransferableTypedData-class.html)
- [`@pragma('vm:isolate-unsendable')` annotation](https://github.com/dart-lang/sdk/blob/main/runtime/docs/pragmas.md)
