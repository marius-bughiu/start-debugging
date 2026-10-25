---
title: "Как сериализовать и десериализовать иерархию sealed-классов Dart в JSON и обратно"
description: "Поместите в JSON поле-дискриминатор, переключайтесь по нему в фабрике на sealed-базе и переключайтесь по подтипу, чтобы записать объект обратно. Три рабочие версии на Dart 3.13.7: ручное сопоставление с образцом, json_serializable 6.15.2 и Freezed 4.0.3 с unionKey и fallbackUnion, а также подводные камни каждой из них."
pubDate: 2026-10-25
template: how-to
tags:
  - "dart"
  - "flutter"
  - "json"
  - "freezed"
  - "json-serializable"
  - "sealed-classes"
lang: "ru"
translationOf: "2026/10/how-to-serialize-and-deserialize-a-dart-sealed-class-hierarchy-to-and-from-json"
translatedBy: "claude"
translationDate: 2026-10-25
---

**Короткий ответ:** JSON не знает, из какого подкласса Dart получен объект, поэтому эту информацию нужно записать в данные самостоятельно, обычно в виде поля-дискриминатора, например `"type": "circle"`. Десериализуйте через `factory Shape.fromJson` на sealed-базе, который переключается по этому полю и делегирует работу нужному подклассу, а сериализуйте через `toJson`, который переключается по `this` (исчерпывающе, благодаря `sealed`) и добавляет дискриминатор обратно. Это можно написать вручную с помощью map-образцов Dart 3, можно поручить json_serializable генерацию тел для отдельных подклассов, написав диспетчеризацию самому, а можно поручить Freezed сгенерировать всё через `@Freezed(unionKey: 'type')`. Всё ниже было скомпилировано и запущено на Dart 3.13.7 (SDK из Flutter 3.47.8) с json_serializable 6.15.2, json_annotation 4.12.0, Freezed 4.0.3, freezed_annotation 3.1.0 и build_runner 2.17.1.

## Почему sealed-иерархия не проходит круговой путь сама по себе

`sealed class Shape` с подклассами `Circle` и `Rect` даёт исчерпывающую проверку `switch` внутри Dart, но `jsonDecode` возвращает только `Map<String, dynamic>`, `List<dynamic>`, `String`, `num`, `bool` и `null`. Ничто в `{"radius": 2}` не говорит, что это был `Circle`. Поэтому работа делится на два направления, которым нужны разные инструменты:

- **Из Dart в JSON** просто, потому что у вас есть настоящий объект. `switch (this)` по sealed-типу проверяется компилятором, так что если позже вы добавите `Triangle`, каждый `toJson`, в котором о нём забыли, станет ошибкой компиляции.
- **Из JSON в Dart** это сложное направление. Вы переключаетесь по *строке* из сети, и никакой компилятор не может проверить, что каждая возможная строка соответствует какому-то подклассу. Вам нужна политика для неизвестных или отсутствующих дискриминаторов.

Дискриминатор не обязан называться `type`. Freezed по умолчанию использует `runtimeType`, многие API используют `kind` или `@type`, а у некоторых API дискриминатора нет вовсе, и подтип приходится определять по тому, какие ключи присутствуют. Все три подхода ниже справляются с этими случаями.

## Минимальная иерархия и формат передачи данных

Эта форма используется во всех примерах:

```json
[
  { "type": "circle", "radius": 2 },
  { "type": "rect", "width": 3, "height": 4.5 }
]
```

Обратите внимание на `"radius": 2`. `jsonDecode` превращает это в `int`, а не в `double`, и это важно, как только ваше поле объявлено как `double`.

## Вариант 1: вручную с map-образцами Dart 3

Никаких пакетов, никакой кодогенерации. Map-образцы за один шаг проверяют, что ключ существует *и* что значение имеет правильный тип:

```dart
// Dart 3.13.7, no packages
sealed class Shape {
  const Shape();

  factory Shape.fromJson(Map<String, dynamic> json) => switch (json) {
        {'type': 'circle', 'radius': num radius} => Circle(radius.toDouble()),
        {'type': 'rect', 'width': num w, 'height': num h} =>
          Rect(w.toDouble(), h.toDouble()),
        {'type': String type} =>
          throw FormatException('Unknown or malformed Shape "$type"', json),
        _ => throw FormatException('Missing "type" discriminator', json),
      };

  Map<String, dynamic> toJson() => switch (this) {
        Circle(:final radius) => {'type': 'circle', 'radius': radius},
        Rect(:final width, :final height) =>
          {'type': 'rect', 'width': width, 'height': height},
      };
}

final class Circle extends Shape {
  const Circle(this.radius);
  final double radius;
}

final class Rect extends Shape {
  const Rect(this.width, this.height);
  final double width;
  final double height;
}
```

Запуск на приведённых выше данных:

```text
[Circle, Rect]
[{"type":"circle","radius":2.0},{"type":"rect","width":3.0,"height":4.5}]
manual unknown THREW FormatException: Unknown or malformed Shape "hexagon"
manual missing type THREW FormatException: Missing "type" discriminator
manual circle missing radius THREW FormatException: Unknown or malformed Shape "circle"
manual radius as string THREW FormatException: Unknown or malformed Shape "circle"
```

Три детали делают эту версию лучше обычного фрагмента `json['radius'] as double`:

1. **`num`, затем `.toDouble()`.** Сопоставление с `'radius': double r` провалилось бы на `2`, потому что декодированное значение является `int`. Сопоставление с `num` принимает оба варианта.
2. **Некорректные данные падают с вашим сообщением, а не с `TypeError`.** Круг без радиуса или с `"radius": "2"` не подходит под первый случай, проваливается в случай `{'type': String type}` и выбрасывает `FormatException` с проблемной картой.
3. **`toJson` проверяется компилятором.** Если вы добавите `final class Triangle extends Shape` и забудете его, анализатор вас остановит:

```text
error - The type 'Shape' isn't exhaustively matched by the switch cases since it doesn't match the pattern 'Triangle()'. Try adding a wildcard pattern or cases that match 'Triangle()'. - non_exhaustive_switch_expression
```

`fromJson` такой проверки не получает, потому что переключается по содержимому карты. Держите оба `switch` рядом на базовом классе, чтобы рецензент видел оба при добавлении подкласса.

### Когда у API нет дискриминатора

Если вы не контролируете данные и они выглядят как `{"radius": 2}` или `{"width": 3, "height": 4.5}`, те же map-образцы выполняют диспетчеризацию по *наличию* ключей:

```dart
// Dart 3.13.7: dispatch on key presence, no "type" field on the wire
factory Shape.fromJson(Map<String, dynamic> json) => switch (json) {
      {'radius': num r} => Circle(r.toDouble()),
      {'width': num w, 'height': num h} => Rect(w.toDouble(), h.toDouble()),
      _ => throw FormatException('Not a Shape', json),
    };
```

Здесь важен порядок: map-образцы игнорируют лишние ключи, поэтому ставьте самый специфичный случай первым. `RoundedRect` с `width`, `height` и `cornerRadius` нужно сопоставлять раньше `Rect`, иначе каждый скруглённый прямоугольник станет обычным.

Ручная версия подходит для трёх-пяти подклассов с горсткой полей в каждом. Дальше шаблонный код для каждого поля становится местом, где живут ошибки, и кодогенерация окупается.

## Вариант 2: json_serializable для подклассов, собственная диспетчеризация на базе

json_serializable не понимает sealed-иерархии. Запрос на эту возможность, [google/json_serializable.dart#1342 "Support dart3 sealed class"](https://github.com/google/json_serializable.dart/issues/1342), открыт с августа 2023 года и всё ещё открыт на момент версии 6.15.2. Зато он хорошо генерирует пополевой код для каждого конкретного класса, поэтому схема такая: аннотируйте подклассы, а оба `switch` на базе пишите вручную.

```dart
// Dart 3.13.7, json_serializable 6.15.2, json_annotation 4.12.0
import 'package:json_annotation/json_annotation.dart';

part 'shape.g.dart';

sealed class Shape {
  const Shape();

  factory Shape.fromJson(Map<String, dynamic> json) => switch (json['type']) {
        'circle' => Circle.fromJson(json),
        'rect' => Rect.fromJson(json),
        final type => throw CheckedFromJsonException(
            json, 'type', 'Shape', 'Unknown Shape type "$type"'),
      };

  Map<String, dynamic> toJson();
}

@JsonSerializable()
final class Circle extends Shape {
  const Circle(this.radius);
  final double radius;

  factory Circle.fromJson(Map<String, dynamic> json) => _$CircleFromJson(json);

  @override
  Map<String, dynamic> toJson() => {'type': 'circle', ..._$CircleToJson(this)};
}

@JsonSerializable()
final class Rect extends Shape {
  const Rect(this.width, this.height);
  final double width;
  final double height;

  factory Rect.fromJson(Map<String, dynamic> json) => _$RectFromJson(json);

  @override
  Map<String, dynamic> toJson() => {'type': 'rect', ..._$RectToJson(this)};
}
```

Запустите `dart run build_runner build`. Сгенерированный `_$CircleToJson` содержит только `radius`; он ничего не знает о дискриминаторе, поэтому каждое переопределение добавляет его в карту, которая начинается с `'type'`. Выбрасывание `CheckedFromJsonException` для неизвестных типов сохраняет форму ошибки такой же, как у сгенерированного кода в других местах, так что один обработчик `on CheckedFromJsonException` покрывает оба случая.

Поскольку у `Shape` теперь есть фабрика `fromJson` и метод `toJson`, json_serializable обращается с ним как с любым другим сериализуемым типом, когда он встречается в качестве поля. Класс-контейнер для декодирования просто работает:

```dart
// Dart 3.13.7, json_serializable 6.15.2
@JsonSerializable(explicitToJson: true)
class Drawing {
  Drawing(this.name, this.shapes);
  final String name;
  final List<Shape> shapes;

  factory Drawing.fromJson(Map<String, dynamic> json) => _$DrawingFromJson(json);
  Map<String, dynamic> toJson() => _$DrawingToJson(this);
}
```

Сгенерированный декодер вызывает `Shape.fromJson(e as Map<String, dynamic>)` для каждого элемента, так что написанная вами диспетчеризация используется повторно. Оставьте `explicitToJson: true`; причина указана в подводных камнях ниже.

Единственная слабость: когда в данных отсутствует поле, сгенерированный код не сообщает, какое именно. `Shape.fromJson({'type': 'circle'})` выбрасывает `type 'Null' is not a subtype of type 'num' in type cast`. Добавьте `@JsonSerializable(checked: true)` к подклассам, если хотите получить `CheckedFromJsonException` с именем ключа.

## Вариант 3: Freezed генерирует весь union

Freezed моделирует sealed-иерархию как класс с несколькими фабричными конструкторами, и когда json_serializable тоже подключён как dev-зависимость, он генерирует диспетчеризацию, дискриминатор и код для каждого случая:

```dart
// Dart 3.13.7, freezed 4.0.3, freezed_annotation 3.1.0, json_serializable 6.15.2
import 'package:freezed_annotation/freezed_annotation.dart';

part 'shape.freezed.dart';
part 'shape.g.dart';

@Freezed(unionKey: 'type', unionValueCase: FreezedUnionCase.snake)
sealed class Shape with _$Shape {
  const factory Shape.circle({required double radius}) = Circle;
  const factory Shape.rect({required double width, required double height}) =
      Rect;
  const factory Shape.roundedRect({
    required double width,
    required double height,
    required double cornerRadius,
  }) = RoundedRect;

  factory Shape.fromJson(Map<String, dynamic> json) => _$ShapeFromJson(json);
}
```

Dev-зависимости: `build_runner`, `freezed` и `json_serializable`; обычные зависимости: `freezed_annotation` и `json_annotation`. Freezed 4.0.3 требует Dart 3.13, поэтому на Flutter 3.44 (Dart 3.12) вы остаётесь на Freezed 3.2.x, где те же аннотации работают.

Что делает сгенерированный код:

```text
[{"radius":2.0,"type":"circle"},{"width":3.0,"height":4.5,"type":"rect"},{"width":1.0,"height":2.0,"cornerRadius":0.5,"type":"rounded_rect"}]
fz unknown THREW CheckedFromJsonException: Could not create `Shape`. There is a problem with "type". Invalid union type "hexagon"!
fz missing type THREW CheckedFromJsonException: Could not create `Shape`. There is a problem with "type". Invalid union type "null"!
```

- `unionKey: 'type'` переименовывает дискриминатор. Без него Freezed пишет и читает `runtimeType`, так что обычный union с `@freezed` выдаёт `{"n": 1, "runtimeType": "a"}`. Это почти никогда не то, чего ожидает бэкенд.
- `unionValueCase` управляет тем, как имена конструкторов превращаются в значения: `roundedRect` становится `rounded_rect` с `FreezedUnionCase.snake`, `rounded-rect` с `kebab`, `RoundedRect` с `pascal` и остаётся `roundedRect` при значении по умолчанию `none`.
- `@FreezedUnionValue('rounded-rect')` на одном конструкторе переопределяет значение только для этого случая, так можно подогнаться под формат передачи, не следующий единому правилу регистра.
- Сгенерированные классы являются настоящими подтипами, поэтому исчерпывающий `switch (shape) { Circle(:final radius) => ..., Rect() => ..., RoundedRect() => ... }` работает точно так же, как в варианте 1.

Если вы хотите задать настройки везде, а не для каждого класса, поместите их в `build.yaml`:

```yaml
# build.yaml, freezed 4.0.3
targets:
  $default:
    builders:
      freezed:
        options:
          union_key: type
          union_value_case: snake
```

### Неизвестные типы: `fallbackUnion`

Клиенты живут дольше деплоев сервера. Когда бэкенд добавляет новый тип события, приложение, которое выбрасывает исключение на неизвестных дискриминаторах, падает на списке, который могло бы отобразить. `fallbackUnion` во Freezed направляет все нераспознанные значения в один конструктор:

```dart
// Dart 3.13.7, freezed 4.0.3
@Freezed(unionKey: 'type', fallbackUnion: 'unknown')
sealed class Event with _$Event {
  const factory Event.click({required int x, required int y}) = ClickEvent;
  const factory Event.unknown() = UnknownEvent;

  factory Event.fromJson(Map<String, dynamic> json) => _$EventFromJson(json);
}
```

Декодирование `{"type": "scroll", "dy": 120}` даёт `Event.unknown()`, а его `toJson()` возвращает `{type: scroll}`: Freezed сохраняет исходный дискриминатор в скрытом поле `$type`, но полезная нагрузка (`dy`) теряется. Отсутствующий ключ `type` тоже попадает в запасной вариант. Если вам нужно точно повторно отправлять или журналировать неизвестные события, добавьте запасному конструктору поле `Map<String, dynamic>` и заполняйте его собственным `fromJson`, либо используйте ручную версию, где случай `_` может сохранить всю карту.

## Подводные камни, которые встречаются при любом подходе

1. **Вложенный `toJson` возвращает объекты, а не карты, пока вы не попросите иначе.** Без `explicitToJson: true` json_serializable пишет `'shapes': instance.shapes`. Результат `Drawing.toJson()` равен `{name: d, shapes: [Instance of 'Circle', Instance of 'Rect']}`. `jsonEncode` скрывает проблему, потому что вызывает `toJson()` у всего, что не может закодировать, так что строка выглядит правильно. Всё, что потребляет именно *карту* (Firestore, `shared_preferences` через карту, сообщения `Isolate`, тест, сравнивающий карты), получает объекты Dart. У Freezed то же поведение по умолчанию; исправление там состоит в аннотации фабричного конструктора:

   ```dart
   // Dart 3.13.7, freezed 4.0.3
   @freezed
   abstract class FzDrawing with _$FzDrawing {
     @JsonSerializable(explicitToJson: true)
     const factory FzDrawing({required String name, required List<Shape> shapes}) =
         _FzDrawing;

     factory FzDrawing.fromJson(Map<String, dynamic> json) =>
         _$FzDrawingFromJson(json);
   }
   ```

   После этого изменения `toJson()` выдавал `{name: d, shapes: [{radius: 2.0, type: circle}, ...]}`, а круговой путь декодирование-кодирование-декодирование давал равные объекты.

2. **`int` против `double`.** Сгенерированный код уже делает `(json['radius'] as num).toDouble()`. Написанный вручную код с приведением `as double` падает на `2`, а `jsonEncode` в Dart пишет обратно `2.0`, так что побайтовое сравнение с исходными данными не проходит, даже если значение прошло круговой путь правильно. Сравнивайте декодированные объекты, а не строки.

3. **Дискриминатор не должен пересекаться с полем.** Если у какого-то случая уже есть поле с именем `type`, Freezed не жалуется. С `unionKey: 'type'` и `const factory Note.email({required String type, required String to})` метод `toJson()` вернул `{type: urgent, to: a}`: поле молча заменило дискриминатор, поэтому декодирование такого вывода выбрасывает `Invalid union type "urgent"!`. В обратную сторону `Note.fromJson({'type': 'email', 'to': 'a'})` засовывает дискриминатор в поле (`Note.email(type: email, ...)`). Выберите `unionKey`, который не использует ни одно поле, например `kind`. У ручной версии и версии с json_serializable та же ловушка, если `toJson` подкласса содержит ключ `type`, потому что spread перезаписывает литерал.

4. **Переименование конструктора меняет формат передачи.** Во Freezed значение дискриминатора выводится из имени конструктора. Переименование `Shape.rect` в `Shape.rectangle` молча меняет то, что вы отправляете, и ломает каждый сохранённый документ и старый клиент. Фиксируйте значения через `@FreezedUnionValue('rect')` для всего, что сохраняется или используется совместно с другим сервисом.

5. **Флаги `build_runner` переехали.** На build_runner 2.17.1 команда `dart run build_runner build --delete-conflicting-outputs` печатает `These options have been removed and were ignored: --delete-conflicting-outputs` и всё равно собирает проект. Старые README и CI-скрипты всё ещё передают его; предупреждение безвредно, но уберите флаг, чтобы он не скрывал настоящее предупреждение.

6. **Дженерикам нужен `genericArgumentFactories`.** `sealed class Result<T>` со случаями `Ok<T>` и `Err<T>` требует `@JsonSerializable(genericArgumentFactories: true)` (или `@Freezed(genericArgumentFactories: true)`), и тогда `fromJson` принимает дополнительный параметр `T Function(Object?) fromJsonT`. Продумайте эту сигнатуру до того, как разнесёте `Result.fromJson` по всей кодовой базе.

## Что выбрать

- **Вручную** для небольших стабильных иерархий или когда в данных нет дискриминатора и тип нужно выводить по ключам. Ноль зависимостей, лучшие сообщения об ошибках, но каждое поле это код, который вы поддерживаете.
- **json_serializable на подклассах**, когда вы уже используете его для обычных DTO и хотите оставить подклассы обычными классами со своими методами. Вы пишете около десяти строк диспетчеризации на иерархию.
- **Freezed**, когда вам также нужны `copyWith`, равенство по значению и `toString` или когда иерархия большая. Задавайте `unionKey` явно, фиксируйте значения через `@FreezedUnionValue` для сохраняемых данных и заранее решите, будут ли неизвестные типы выбрасывать исключение или попадать в `fallbackUnion`. [Сравнение records и Freezed](/ru/2026/05/dart-records-vs-freezed-classes/) разбирает, когда кодогенерация Freezed вообще нужна.

### Читайте дальше

- [Fix FormatException: Unexpected character when parsing JSON in Dart](/ru/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/) о шаге до запуска `fromJson`.
- [Fix "type 'Null' is not a subtype of type" in Dart](/ru/2026/07/fix-type-null-is-not-a-subtype-of-type-in-dart/), ошибка, которую порождает отсутствующее поле в сгенерированном коде `fromJson`.
- [How to handle network errors gracefully in a Flutter app](/ru/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/), в том числе о том, где в интерфейсе должна проявляться ошибка декодирования.
- Аналог на C#, [serializing a polymorphic hierarchy with JsonDerivedType in System.Text.Json](/ru/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/), решает ту же задачу с дискриминатором через атрибуты.

### Источники

- [Dart language: patterns, map patterns](https://dart.dev/language/pattern-types#map) и [class modifiers: sealed](https://dart.dev/language/class-modifiers#sealed)
- [Freezed README: fromJSON for classes with multiple constructors](https://pub.dev/packages/freezed#fromjson---classes-with-multiple-constructors) и [Freezed changelog](https://pub.dev/packages/freezed/changelog)
- [json_serializable on pub.dev](https://pub.dev/packages/json_serializable) и [issue #1342, sealed class support](https://github.com/google/json_serializable.dart/issues/1342)
- [build_runner changelog](https://pub.dev/packages/build_runner/changelog)
