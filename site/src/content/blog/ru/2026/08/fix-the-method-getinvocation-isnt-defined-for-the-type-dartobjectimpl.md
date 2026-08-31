---
title: "Решение: The method 'getInvocation' isn't defined for the type 'DartObjectImpl'"
description: "build_runner не компилируется, потому что source_gen 3.1.0 или 4.0.0 вызывает API analyzer, удалённый в analyzer 8.4.0. Обновите генератор, который держит source_gen ниже 4.0.1."
pubDate: 2026-08-31
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "build-runner"
  - "source-gen"
lang: "ru"
translationOf: "2026/08/fix-the-method-getinvocation-isnt-defined-for-the-type-dartobjectimpl"
translatedBy: "claude"
translationDate: 2026-08-31
---

`build_runner` не может скомпилировать собственный скрипт сборки, а не ваш код. `source_gen` 3.1.0 и 4.0.0 вызывают `DartObjectImpl.getInvocation()`, который `analyzer` 8.4.0 удалил, и оба пакета объявляют достаточно свободные ограничения, чтобы pub свёл их вместе. Исправляется обновлением того генератора кода в вашем `pubspec.yaml`, который держит `source_gen` ниже 4.0.1. Если обновиться прямо сейчас нельзя, добавьте `dependency_overrides: analyzer: 8.3.0` как временную меру.

## Ошибка целиком

Вы запускаете `dart run build_runner build` (или `flutter pub run build_runner build`) и получаете ошибку компиляции фронтенда Dart, указывающую в ваш кеш pub:

```text
[INFO] Generating build script...
../../.pub-cache/hosted/pub.dev/source_gen-3.1.0/lib/src/constants/revive.dart:82:40:
Error: The method 'getInvocation' isn't defined for the type 'DartObjectImpl'.
 - 'DartObjectImpl' is from 'package:analyzer/src/dart/constant/value.dart'
   ('../../.pub-cache/hosted/pub.dev/analyzer-8.4.1/lib/src/dart/constant/value.dart').
Try correcting the name to the name of an existing method, or defining a method
named 'getInvocation'.
  final i = (object as DartObjectImpl).getInvocation();
                                       ^^^^^^^^^^^^^
[SEVERE] Failed to compile build script. Check builder definitions and generated
script .dart_tool/build/entrypoint/build.dart.
```

Две детали этого вывода делают диагностику за вас. Падающий файл лежит в `source_gen`, а не в вашем проекте. И номера версий в этих двух путях кеша и есть весь баг: `source_gen-3.1.0` против `analyzer-8.4.1`.

Всё изложенное ниже проверено по архивам пакетов на pub.dev и применимо к Flutter 3.47.0 с Dart 3.13.0, стабильному каналу на август 2026 года, а также к любому более старому проекту на Dart 3.x, который разрешает ту же пару.

## Почему analyzer 8.4.0 удалил метод

`source_gen` обязан отвечать на один вопрос для каждой встреченной аннотации: какой исходный код воссоздал бы const-объект, который analyzer уже вычислил. Именно это делает `reviveInstance` в `source_gen/lib/src/constants/revive.dart`, и именно так `@JsonSerializable(fieldRename: FieldRename.snake)` превращается в пригодную конфигурацию внутри билдера.

Для этого `source_gen` нужны были конструктор и значения аргументов, стоящие за `DartObject`. Годами единственным способом их получить был импорт реализации:

```dart
// source_gen 3.1.0, lib/src/constants/revive.dart
// ignore: implementation_imports
import 'package:analyzer/src/dart/constant/value.dart' show DartObjectImpl;

// ...
final i = (object as DartObjectImpl).getInvocation();
```

Этот комментарий `// ignore: implementation_imports` и есть собственный линт analyzer, сообщающий `source_gen`, что тот лезет в каталог `src/`, который не даёт никаких гарантий стабильности API.

Команда analyzer закрыла исходный пробел. Версия 8.1.0, опубликованная 2025-08-07, добавила `DartObject.constructorInvocation` в публичную поверхность `package:analyzer/dart/constant/value.dart`, возвращая `ConstructorInvocation` с полями `constructor`, `positionalArguments` и `namedArguments`. В 8.3.0 старая точка входа ещё присутствовала и была помечена к удалению:

```dart
// analyzer 8.3.0, lib/src/dart/constant/value.dart
@Deprecated('Use constructorInvocation instead')
ConstructorInvocationImpl? getInvocation() {
  return constructorInvocation;
}
```

Analyzer 8.4.0, опубликованный 2025-10-15, этот метод убрал. `constructorInvocation` остался, но ничего с именем `getInvocation` в пакете больше нет. Любой код, который его всё ещё вызывает, перестаёт компилироваться в тот момент, когда эта версия оказывается разрешена.

`source_gen` к тому времени уже переехал. Версия 4.0.1, опубликованная 2025-09-04, перешла на публичный геттер и ужесточила собственное ограничение до `analyzer: ^8.1.1`:

```dart
// source_gen 4.0.1 and later, lib/src/constants/revive.dart
final i = object.constructorInvocation;
if (i != null) {
  url = Uri.parse(urlOfElement(i.constructor.enclosingElement));
  // ...
}
```

Обратите внимание на исчезнувший импорт реализации. Это и есть настоящее исправление, и поэтому любая версия `source_gen` начиная с 4.0.1 к проблеме невосприимчива.

## Дыра в решателе версий, которая сводит сломанные версии вместе

Если `source_gen` 4.0.1 исправил это в сентябре, а analyzer 8.4.0 вышел в октябре, почему кто-то вообще на это натыкается? Потому что сломанные версии никогда не объявляли несовместимость, а pub читает только объявления.

Вот ограничения, которые имеют значение:

| Пакет | Ограничение на analyzer | Вызывает `getInvocation` |
| --- | --- | --- |
| `source_gen` 3.0.0 | `^7.4.0` | да, но ограничен ниже 8.0.0, поэтому безопасен |
| `source_gen` 3.1.0 | `>=7.4.0 <9.0.0` | да, и 8.4.x попадает в диапазон |
| `source_gen` 4.0.0 | `>=7.4.0 <9.0.0` | да, и 8.4.x попадает в диапазон |
| `source_gen` 4.0.1+ | `^8.1.1` | нет |

`source_gen` 3.1.0 и 4.0.0 - единственные две опубликованные версии, которые одновременно вызывают удалённый метод и допускают analyzer 8.4.x. Их верхняя граница `<9.0.0` была ставкой на то, что мажорный скачок принесёт с собой любое ломающее изменение. Команда analyzer удалила устаревший член в минорном релизе, что нормально для того, что и так никогда не было публичным API.

Pub предпочитает самую свежую версию, удовлетворяющую всем ограничениям, поэтому проект без иного давления разрешает `source_gen` 4.3.0 и этого никогда не видит. Сбою нужно, чтобы что-то в вашем графе удерживало `source_gen` внизу. Это что-то почти всегда - генератор кода с caret-пином. `objectbox_generator` 5.0.0, опубликованный 2025-10-01, объявлял `source_gen: ^3.1.0`, что разрешается ровно в одну версию, 3.1.0, потому что 3.1.0 - последний релиз линейки 3.x. Через две недели вышел analyzer 8.4.0, и каждый проект с ObjectBox, запустивший `dart pub upgrade`, получил скрипт сборки, который не компилируется.

Changelog ObjectBox для 5.0.1 называет сбой прямо: "Generator: migrate to `analyzer` 8 APIs. Require at least `analyzer` 8.1.1 and `source_gen` 4.0.1. Resolves `Error: The method 'getInvocation' isn't defined` when running the generator using `analyzer` 8.4.0".

ObjectBox был не один. `json_serializable` 6.11.0 вышел с `source_gen: ^3.1.0` и расширил его до `>=3.1.0 <5.0.0` в 6.11.1. `retrofit_generator` 10.0.2, `chopper_generator` 8.3.1, `built_value_generator` 8.11.1 и `envied_generator` 1.2.1 несли пин той же формы в том же окне. Поскольку `source_gen` - это единственный общий узел графа зависимостей, один устаревший генератор тянет за собой на 3.1.0 все остальные генераторы вашего проекта. Проект, использующий `freezed`, `json_serializable` и один заброшенный билдер, каждый раз будет винить не тот пакет.

## Воспроизведение с чистого pubspec

```yaml
# pubspec.yaml
# Dart 3.9.x. Any SDK that admits analyzer 8.4.x reproduces this.
name: repro
environment:
  sdk: ^3.9.0

dependencies:
  objectbox: 5.0.0

dev_dependencies:
  build_runner: ^2.9.0
  objectbox_generator: 5.0.0
```

Запустите `dart pub get`, а затем прочитайте, что было выбрано на самом деле:

```bash
dart pub deps --style=compact | grep -E 'source_gen|analyzer'
```

Вы увидите `source_gen 3.1.0` и `analyzer 8.4.1`. Эта пара и есть баг. `dart run build_runner build` после этого падает с ошибкой из начала статьи, ещё до того, как будет проанализирована хоть одна строка вашего кода.

## Решение 1: обновите генератор, который держит source_gen

Это правильное исправление, и обычно оно занимает одну строку. Найдите ограничение, которое ограничивает `source_gen`, и поднимите его.

Заставьте pub назвать виновника, потребовав версию, которую он не может выдать:

```bash
dart pub add dev:source_gen:^4.0.1
```

Разрешение версий падает, и объяснение называет пакет, удерживающий пин:

```text
Because objectbox_generator 5.0.0 depends on source_gen ^3.1.0 and no versions
        of objectbox_generator match >5.0.0 <6.0.0, objectbox_generator 5.0.0
        requires source_gen ^3.1.0.
So, because repro depends on both objectbox_generator 5.0.0 and
source_gen ^4.0.1, version solving failed.
```

Читайте это снизу вверх, так же как читали бы любой [сбой разрешения версий в pub](/ru/2026/05/fix-version-solving-failed-in-pubspec-yaml/). Верхняя строка - тот факт, который нужно менять.

Затем поднимите названный пакет и дайте исправлению разойтись по графу:

```bash
dart pub upgrade objectbox objectbox_generator
dart run build_runner build --delete-conflicting-outputs
```

Заведомо рабочие нижние границы, если вы предпочитаете задать их явно:

- `objectbox_generator` 5.0.1 или новее
- `json_serializable` 6.11.1 или новее
- `chopper_generator` 8.5.0 или новее
- `envied_generator` 1.3.2 или новее
- `retrofit_generator` 10.2.3 или новее
- `built_value_generator` 8.11.2 или новее

Не добавляйте `source_gen` в собственные `dev_dependencies` в качестве исправления. Это транзитивная зависимость ваших генераторов, и пин в вашем pubspec лишь переносит конфликт в ваш файл, где он будет гнить.

## Решение 2: закрепите analyzer как временную меру

Если проблемный генератор заброшен или вы в середине релиза и не можете принять обновление, удержите analyzer на последней версии, где устаревший метод ещё есть:

```yaml
# pubspec.yaml
# Temporary. Delete once the generator is upgraded.
dependency_overrides:
  analyzer: 8.3.0
```

Analyzer 8.3.0 (2025-10-10) - последний релиз, где `getInvocation` присутствует. Это работает, потому что устаревший метод был однострочной переадресацией к `constructorInvocation`, так что поведение идентично.

Две цены, обе настоящие. `dependency_overrides` заглушает решатель для каждого пакета в графе, поэтому второй пакет, которому действительно нужен analyzer 8.4+, теперь упадёт во время компиляции, а не на `pub get`. И переопределения игнорируются, когда ваш пакет потребляется как зависимость, так что опубликованный пакет не может поставить это своим пользователям как исправление. Относитесь к этому как к разблокировке на уровне ветки с датированным TODO и добавьте задачу CI, которая собирает без переопределения, чтобы узнать, когда оно станет ненужным. Если вы поддерживаете несколько веток на разных SDK, [нацеливание на несколько версий Flutter из одного пайплайна CI](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) - подходящий шаблон, чтобы обе оставались честными.

## Решение 3: если вызов находится в вашем собственном билдере

Если падающий путь в ошибке - ваш собственный пакет, а не `source_gen`, вызов написали вы, и миграция ваша. Это прямая замена:

```dart
// Before. Requires the implementation import of DartObjectImpl.
// ignore: implementation_imports
import 'package:analyzer/src/dart/constant/value.dart' show DartObjectImpl;

final invocation = (object as DartObjectImpl).getInvocation();
```

```dart
// After. analyzer 8.1.0 and later. Public API, no src/ import.
import 'package:analyzer/dart/constant/value.dart';

final invocation = object.constructorInvocation;
if (invocation != null) {
  final ctor = invocation.constructor;
  final positional = invocation.positionalArguments;
  final named = invocation.namedArguments;
}
```

Удалите вместе с ним и ignore для `implementation_imports`. Затем задайте собственную нижнюю границу `analyzer: '>=8.1.1'`, чтобы pub не смог подсунуть вашему коду analyzer без этого геттера. Именно эту нижнюю границу обычно пропускают, и именно она превращает исправленный пакет обратно в сломанный для того, кто сидит на более старом SDK.

Раз уж вы здесь, учтите, что `ConstructorInvocation.constructor2` существует и объявлен устаревшим в пользу `constructor`. Мигрируйте оба за один проход, а не меняйте одно удаление на следующее.

## Подводные камни и похожие случаи

**`flutter clean` это не чинит и никогда не чинил.** Самый повторяемый совет при сбоях build_runner - удалить `.dart_tool` и пересобрать. Здесь это лишь повторно запускает ту же компиляцию с теми же разрешёнными версиями. Если ошибка упоминает файл внутри `.pub-cache`, разрешение зависимостей неверное, и никакая очистка кеша его не изменит.

**`--delete-conflicting-outputs` тоже не помогает.** Этот флаг разбирается со сборкой, которая произвела файл, который хочет записать другой билдер. Он срабатывает после того, как скрипт сборки скомпилирован, а здесь скрипт сборки не компилируется вообще.

**Обычный триггер - lock-файл.** В вашем pubspec ничего не менялось; `dart pub upgrade`, чистый checkout в CI без закоммиченного `pubspec.lock` или чужой `pub get` подняли analyzer до 8.4.x, пока `source_gen` остался закреплён на 3.1.0. Если у коллеги машина всё ещё собирает проект, начните со сравнения двух lock-файлов.

**Родственные ошибки, причина та же.** `The getter 'name' isn't defined for the class 'NamedType'`, `The getter 'tmp' isn't defined for the class 'Diagnostic'` и `DotShorthandConstructorInvocation isn't defined` - это один и тот же режим отказа: билдер, скомпилированный против API analyzer, которое переехало. Диагностика не меняется. Прочитайте две версии из путей кеша в тексте ошибки, найдите пакет, который держит более старую, и обновите его. Это тот же тип поломки, что и [плагин, убравший безымянный конструктор](/ru/2026/08/fix-the-class-googlesignin-doesnt-have-an-unnamed-constructor-in-flutter/), только API принадлежит пакету, который вы никогда не выписывали.

**Analyzer 9.0.0 - не та граница, которая вам нужна.** Он вышел 2025-10-23, через восемь дней после 8.4.0. Ограничение `analyzer: <9.0.0` вас не защитит, потому что 8.4.x уже ниже него. Единственные безопасные нижние границы - `source_gen: '>=4.0.1'` на стороне генератора и `analyzer: '>=8.1.1'` на вашей.

## Похожие материалы

- Умение читать доказательство сбоя от pub здесь ключевое: [Version solving failed in pubspec.yaml](/ru/2026/05/fix-version-solving-failed-in-pubspec-yaml/) разбирает вывод PubGrub строка за строкой.
- `freezed` - такой же билдер на `source_gen`, как любой другой, поэтому этот сбой может задеть проект, который использует его только для классов данных. [Dart records против классов Freezed](/ru/2026/05/dart-records-vs-freezed-classes/) разбирает, нужна ли вам кодогенерация вообще.
- Генератор Riverpod стоит на том же стеке: [переход с Riverpod 2.x на Riverpod 3.0](/ru/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/) включает скачок кодогенерации.
- Обновление пакета, удаляющее конструктор, а не метод: [The class 'GoogleSignIn' doesn't have an unnamed constructor](/ru/2026/08/fix-the-class-googlesignin-doesnt-have-an-unnamed-constructor-in-flutter/).
- Чтобы проект продолжал собираться, пока приземляется обновление генератора, смотрите [нацеливание на несколько версий Flutter из одного пайплайна CI](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).

## Источники

- [Changelog source_gen](https://pub.dev/packages/source_gen/changelog), про переход 4.0.1 на `analyzer: ^8.1.1`. Ограничения версий и даты публикации считаны из архивов пакетов pub.dev для 3.1.0, 4.0.0 и 4.0.1.
- [Changelog analyzer](https://pub.dev/packages/analyzer/changelog), про добавление `DartObject.constructorInvocation` в 8.1.0. Наличие устаревшего `getInvocation()` в 8.3.0 и его отсутствие в 8.4.0 подтверждены по опубликованным архивам обеих версий.
- [Changelog objectbox](https://pub.dev/packages/objectbox/changelog), версия 5.0.1, опубликована 2025-10-29, где эта ошибка и её исправление названы прямо.
- [build_runner на pub.dev](https://pub.dev/packages/build_runner). Сообщение "Failed to compile build script" приходит из `lib/src/bootstrap/bootstrapper.dart`.
- [dart pub deps](https://dart.dev/tools/pub/cmd/pub-deps) и [документация решателя PubGrub](https://github.com/dart-lang/pub/blob/master/doc/solver.md) для команд диагностики.
