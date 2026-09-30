---
title: "Исправление: Can't have modifier 'final' here для параметров после обновления до Dart 3.13"
description: "Dart 3.13 резервирует final и var в списках параметров для первичных конструкторов. Запустите dart fix --apply --code=extraneous_modifier, чтобы убрать их, а вместо final используйте lint parameter_assignments."
pubDate: 2026-09-30
template: error-page
tags:
  - "errors"
  - "dart"
  - "flutter"
  - "dart-3-13"
lang: "ru"
translationOf: "2026/09/fix-dart-3-13-cant-have-modifier-final-here-on-parameters"
translatedBy: "claude"
translationDate: 2026-09-30
---

Dart 3.13 (SDK во Flutter 3.47) больше не позволяет писать `final` или `var` у параметров обычных функций, методов, замыканий и конструкторов с телом. Оба ключевых слова теперь зарезервированы для объявления параметров в первичных конструкторах, поэтому `int add(int a, final int b)` падает с ошибкой `extraneous_modifier`, как только в вашем `pubspec.yaml` появляется `sdk: ^3.13.0`. Запустите `dart fix --apply --code=extraneous_modifier`, чтобы убрать все лишние модификаторы за один проход. Если вы использовали `final`, чтобы запретить переприсваивание параметров, включите вместо этого lint `parameter_assignments`.

Всё описанное ниже воспроизведено на Dart 3.13.3 (Flutter 3.47.4) и Dart 3.12.2 (Flutter 3.44.8) на macOS arm64 и сверено с журналом изменений 3.13.0, принятой спецификацией первичных конструкторов и обсуждением [dart-lang/sdk#64151](https://github.com/dart-lang/sdk/issues/64151), где команда Dart подтвердила, что это ограничение сделано намеренно.

## Ошибка в контексте

`dart analyze` и IDE сообщают об этом как об ошибке анализатора:

```text
error - lib/a.dart:2:16 - Can't have modifier 'final' here. Try removing 'final'. - extraneous_modifier
```

`dart run`, `flutter run` и `flutter build` проходят через front-end компилятор, который печатает тот же текст со значком под ключевым словом:

```text
lib/a.dart:2:16: Error: Can't have modifier 'final' here.
Try removing 'final'.
int add(int a, final int b) => a + b;
               ^^^^^
```

Для `var` в сообщении меняется только ключевое слово: `Can't have modifier 'var' here. Try removing 'var'.` Параметр `var int n` с типом дополнительно даёт `var_and_type`, но это была ошибка и до 3.13.

Сбивает с толку причина. Никто не трогал файл. Изменилось ограничение SDK: кто-то поднял `environment: sdk:` до `^3.13.0`, чтобы попробовать первичные конструкторы, или шаблон сгенерировал новый пакет с нижней границей 3.13, и код, который годами компилировался, начал падать. Типичный сбой в CI выглядит так же, как в #64151: приватный вспомогательный метод, написанный несколько месяцев назад с `final int precision` в списке параметров, в классе, где нет ни одного первичного конструктора.

## Почему Dart 3.13 отвергает final у параметров

Dart 3.13.0 выпустил [первичные конструкторы](https://dart.dev/language/primary-constructors) 2026-08-12. Первичный конструктор находится в заголовке класса, а параметр с `final` или `var` там является *объявляющим параметром*: он объявляет поле экземпляра и одновременно параметр конструктора.

```dart
// Dart 3.13.3
class Point(final int x, final int y); // declares fields x and y
```

Чтобы это значение оставалось однозначным, [спецификация возможности](https://github.com/dart-lang/language/blob/main/accepted/3.13/primary-constructors/feature-specification.md) запрещает `var x`, `final x` и `final T x` как формальные параметры в любой функции, не являющейся первичным конструктором. Команда Dart выбрала единообразие вместо более узкого правила: в #64151 Leaf Petersen на вопрос "предполагалось ли более узкое правило?" ответил прямо, что так и задумано.

Две особенности делают это похожим на регрессию, а не на изменение языка:

1. **Оно привязано к версии языка.** Ограничение действует только в библиотеках с версией языка 3.13 или выше. Версия языка берётся из нижней границы `sdk:` в `pubspec.yaml`, поэтому тот же код с `sdk: ^3.12.0` по-прежнему компилируется на SDK 3.13. Поэтому команда Dart и не сочла это breaking change в формальном смысле.
2. **В момент релиза это почти не было описано.** Исходный журнал изменений 3.13.0 описывал первичные конструкторы, но не упоминал влияние на обычные функции. После #64151 в раздел Language добавили запись "**Breaking change**: You can no longer use `final` or `var` on non-declaring parameters", а на странице первичных конструкторов появился раздел "Constraints and breaking changes". Единственным более ранним сигналом было объявление lint `prefer_final_parameters` устаревшим в Dart 3.11.

## Минимальный пример воспроизведения

Достаточно двух файлов. Pubspec задаёт версию языка:

```yaml
# Dart 3.13.3
name: fp
environment:
  sdk: ^3.13.0
```

И библиотека, использующая `final` и `var` во всех типичных позициях параметров:

```dart
// Dart 3.13.3, language version 3.13
int add(int a, final int b) => a + b;                   // error

void named({required final String id, final int retries = 3}) {} // 2 errors

void positional([final int? x]) {}                      // error

void callback(final void Function(int) onTap) {}        // error

void untypedVar(var x) {}                               // error

class Money {
  final int cents;
  Money(final int c) : cents = c;                       // error, in-body constructor
  Money operator +(final Money other) => Money(cents + other.cents); // error
  set value(final int v) {}                             // error
  static Money zero(final int unused) => Money(0);      // error
}

void loops(List<int> xs) {
  for (final x in xs) {                                 // fine, not a parameter
    print(x);
  }
  final local = xs.length;                              // fine, local variable
  xs.forEach((final v) => print(v + local));            // error, closure parameter
}

class Point(final int x, final int y);                  // fine, declaring parameters
```

`dart analyze` на 3.13.3 выдаёт по одной ошибке `extraneous_modifier` на каждый помеченный выше параметр. Если заменить pubspec на `sdk: ^3.12.0`, все они исчезают, а остаются ошибки только в строке `Point`, где теперь написано `This requires the 'primary-constructors' language feature to be enabled`.

Формальные параметры полей и super-параметры тоже попадают под правило. `T2(final this.x)` и `C(final super.y)` на 3.13 дают `extraneous_modifier` плюс предупреждение `unnecessary_final`, потому что такие параметры всегда были неявно final.

Что *не* затронуто: локальные переменные, `for (final ... in ...)`, переменные шаблонов, поля и обычные параметры `this.x` / `super.x`.

## Исправление подробно

Выберите один из вариантов, в порядке предпочтения.

### 1. Пусть dart fix уберёт модификаторы

Анализатор поставляется с исправлением для `extraneous_modifier`, так что миграция механическая:

```bash
dart fix --dry-run
```

На тестовом пакете это выводит `extraneous_modifier - 11 fixes` в `lib/a.dart`, по одному на каждую ошибку. Применяйте только этот код, чтобы остальной проект не переписывался:

```bash
dart fix --apply --code=extraneous_modifier
```

Получившийся diff в точности совпадает с тем, что вы написали бы вручную:

```dart
// Dart 3.13.3, after dart fix
int add(int a, int b) => a + b;
void named({required String id, int retries = 3}) {}
void positional([int? x]) {}
void callback(void Function(int) onTap) {}
void untypedVar(x) {}

class Money {
  final int cents;
  Money(int c) : cents = c;
  Money operator +(Money other) => Money(cents + other.cents);
  set value(int v) {}
  static Money zero(int unused) => Money(0);
}
```

После исправления `dart analyze` не находит проблем, и программа запускается. Во Flutter-приложении команда та же: `flutter` просто использует встроенный Dart SDK, так что запускайте `dart fix` из корня проекта при условии, что Flutter 3.47 есть в PATH.

Обратите внимание, что `var x` превращается в голое `x`, то есть в неявно `dynamic` параметр. Это компилируется, но если у вас включены `strict-raw-types` или подобные настройки анализатора, заодно укажите настоящий тип.

### 2. Сохраните правило "не переприсваивать параметры" через lint

Большинство писало `final` у параметров, чтобы переприсваивание было ошибкой компиляции. Теперь эту гарантию обеспечивает линтер:

```yaml
# analysis_options.yaml, Dart 3.13.3
linter:
  rules:
    - parameter_assignments
```

```dart
// Dart 3.13.3
int clamp(int value, int max) {
  if (value > max) value = max; // info: Invalid assignment to the parameter 'value'.
  return value;
}
```

Не включайте `prefer_final_parameters`, чтобы вернуть старое поведение. Он объявлен устаревшим с Dart 3.11, а на 3.13 его включение даёт `The lint rule 'prefer_final_parameters' is deprecated and shouldn't be enabled`. Его рекомендации теперь вели бы к коду, который не компилируется. Если общий пакет lint-правил в вашей команде всё ещё включает его, этот пакет тоже нужно обновить.

### 3. Закрепите один файл на старой версии языка

Когда сегодня вы не можете изменить файл, например сгенерированный код или вендорную библиотеку, комментарий с версией языка в начале файла исключает эту одну библиотеку:

```dart
// @dart=3.12
// Dart 3.13.3 SDK, this library uses language version 3.12
int legacyAdd(int a, final int b) => a + b; // compiles
```

Остальная часть пакета может использовать первичные конструкторы. Это временная мера: файл, закреплённый на 3.12, не может использовать ни одну возможность 3.13, и комментарий стоит удалить, как только файл будет приведён в порядок.

### 4. Оставьте ограничение SDK на 3.12, пока не будете готовы

Поскольку проверка зависит от версии языка вашего пакета, а не от запущенного SDK, SDK 3.13 спокойно компилирует пакет с ограничением `sdk: ^3.12.0`. Если вы подняли ограничение только потому, что это сделал за вас шаблон или `pub upgrade --major-versions`, возврат нижней границы является допустимым краткосрочным решением. Зависимости в любом случае не затрагиваются: в моём примере path-зависимость с `sdk: ^3.12.0` и `final` у параметра компилировалась и работала внутри приложения на 3.13, потому что каждый пакет компилируется со своей версией языка.

## Подготовка кодовой базы на 3.12 до обновления

Если вы всё ещё на Flutter 3.44 / Dart 3.12, можно найти и исправить всё до повышения ограничения. Страница первичных конструкторов рекомендует два lint-правила, которые существуют на 3.12.2:

```yaml
# analysis_options.yaml, Dart 3.12.2
linter:
  rules:
    - avoid_final_parameters
    - var_with_no_type_annotation
```

На 3.12.2 они сообщают `Parameters should not be marked as 'final'` и `Avoid declaring parameters with var and no type annotation`, и у обоих есть поддержка `dart fix` (`--code=avoid_final_parameters` и `--code=var_with_no_type_annotation`). Исправьте предупреждения, затем поднимите `sdk:` до `^3.13.0`, и при обновлении не появится ни одной ошибки `extraneous_modifier`.

## Подводные камни и похожие ошибки

- **Генераторы кода тоже это выдают.** freezed 3.x генерировал конструкторы вроде `const _Example({required final List<String> someField})` для полей-коллекций, что ломается в пакете на 3.13 ([rrousselGit/freezed#1365](https://github.com/rrousselGit/freezed/issues/1365)). freezed 4.0.0 (2026-08-22) убрал `final` в параметрах сгенерированных конструкторов, а 4.0.2 является текущим релизом. Обновите генератор и заново запустите `dart run build_runner build`. Запускать `dart fix` на файлах `.freezed.dart` бессмысленно, потому что следующая сборка их перегенерирует. Если вы используете другой генератор, поищите в его журнале изменений "Dart 3.13" или "primary constructors", прежде чем винить собственный код.
- **Инструменты, разбирающие ваш код, могут столкнуться с этим даже на 3.12.** В #64151 сбой вызвал инструмент, вызывавший `parseString()` анализатора без `featureSet`. В этом случае по умолчанию берётся самая новая версия языка, известная анализатору, поэтому analyzer 13.1.0 и новее отвергал параметры `final` в пакете, который всё ещё был на более старой версии языка. Если пользовательский builder, инструмент документации или скрипт метрик кода падает, пока `dart analyze` проходит, причина именно в этом, и исправлять нужно сам инструмент.
- **Сообщение нигде не упоминает первичные конструкторы.** Команда Dart обсуждала более длинное сообщение в #64151 и решила от него отказаться, поэтому вы получаете `Try removing 'final'`. Если вы попали сюда по этой самой строке, эта страница и есть объяснение.
- **`var` без типа становится `dynamic`.** `dart fix` превращает `(var x)` в `(x)`, а не в `(Object? x)`. Добавьте тип, если это важно.
- **Соответствие версий Flutter.** Flutter с 3.47.0 по 3.47.5 включает Dart с 3.13.0 по 3.13.4. Одно обновление Flutter ничего не меняет; ошибки появляются только тогда, когда нижняя граница `sdk:` пакета достигает 3.13, поэтому после этого повышения скопированные фрагменты из старых ответов с параметрами `final` сразу перестают работать.
- **Это не то же самое, что поля `final` в первичном конструкторе.** `class User(final String name);` является корректным кодом 3.13 и объявляет поле. Если вы получаете `extraneous_modifier` на параметре первичного конструктора, проверьте, что список параметров действительно находится в заголовке класса, а не в конструкторе с телом.

## Связанные материалы

- Возможность, из-за которой это произошло, на экспериментальной стадии: [первичные конструкторы в Dart 3.12](/ru/2026/06/dart-3-12-experimental-primary-constructors/).
- Ещё один неприятный сюрприз при обновлении до 3.13, не видимый в вашем diff: [CERTIFICATE_VERIFY_FAILED в Docker-образе Dart 3.13](/ru/2026/09/fix-certificate-verify-failed-in-dart-3-13-docker-image/).
- Если повышение ограничения SDK заодно сломало разрешение зависимостей, см. [как исправить version solving failed в pubspec.yaml](/ru/2026/05/fix-version-solving-failed-in-pubspec-yaml/).
- Выбор между сгенерированными классами данных и встроенными типами после обновления freezed 4.0: [записи Dart и классы freezed](/ru/2026/05/dart-records-vs-freezed-classes/).
- Если `dart fix` и анализатор медленно работают на большом репозитории, [ускорьте сервер анализа Dart в VS Code](/ru/2026/09/how-to-speed-up-a-slow-dart-analysis-server-in-vs-code-for-a-large-flutter-monorepo/).

## Источники

- [dart-lang/sdk#64151: `final` no longer allowed on parameters of normal functions/methods](https://github.com/dart-lang/sdk/issues/64151)
- [Dart SDK CHANGELOG, 3.13.0 Language section](https://github.com/dart-lang/sdk/blob/main/CHANGELOG.md)
- [Primary constructors feature specification (accepted/3.13)](https://github.com/dart-lang/language/blob/main/accepted/3.13/primary-constructors/feature-specification.md)
- [Primary constructors, dart.dev](https://dart.dev/language/primary-constructors)
- [`parameter_assignments` lint rule](https://dart.dev/tools/linter-rules/parameter_assignments)
- [`avoid_final_parameters` lint rule](https://dart.dev/tools/linter-rules/avoid_final_parameters)
- [rrousselGit/freezed#1365: invalid `final` keyword in generated constructor parameters](https://github.com/rrousselGit/freezed/issues/1365)
- [freezed CHANGELOG (4.0.0, 4.0.2)](https://github.com/rrousselGit/freezed/blob/master/packages/freezed/CHANGELOG.md)
