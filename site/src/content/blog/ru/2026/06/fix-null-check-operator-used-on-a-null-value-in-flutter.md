---
title: "Решение: Null check operator used on a null value во Flutter"
description: "Оператор ! наткнулся на null во время выполнения. Замените его на ?. и ?? для значения по умолчанию или защитите явной проверкой на null, вместо того чтобы утверждать значение, которого не было."
pubDate: 2026-06-24
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
lang: "ru"
translationOf: "2026/06/fix-null-check-operator-used-on-a-null-value-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-24
---

Вы написали `something!`, и `something` было `null`, когда выполнялась эта строка. Оператор проверки на null (bang) обещает компилятору "это никогда не null", и Dart обеспечивает это обещание во время выполнения, выбрасывая исключение в тот момент, когда обещание нарушено. Решение почти всегда в том, чтобы перестать утверждать и начать обрабатывать: используйте `?.` для короткого замыкания, `??` для значения по умолчанию или защиту `if (x != null)`, которая позволит компилятору сузить тип за вас. На этой странице используются Flutter 3.44 (стабильный, май 2026) и Dart 3.x.

## Ошибка в контексте

Когда оператор bang наталкивается на `null`, вы получаете `TypeError` с этим точным сообщением:

```
Unhandled Exception: Null check operator used on a null value
```

В слое виджетов он обычно появляется обёрнутым фреймворком, и именно так его видит большинство:

```
======== Exception caught by widgets library =======================================================
The following _TypeError was thrown building ProfilePage(dirty):
Null check operator used on a null value

The relevant error-causing widget was:
  ProfilePage ProfilePage:file:///lib/profile_page.dart:18:12
```

Класс это `_TypeError` (подтип `TypeError`), то же семейство, которое Dart использует для неудачных приведений. Это подсказка: оператор bang это приведение. Он приводит `T?` к `T`, и, как любое приведение, может завершиться неудачей во время выполнения.

## Почему это происходит: оператор bang это проверяемое приведение

В строгой null safety `String?` и `String` это разные типы. Постфиксный `!` это сокращение, которое, по словам документации Dart, "берёт выражение слева от себя и приводит его к лежащему в основе ненулевому типу". Приведение из типа, допускающего null, к ненулевому нельзя доказать как безопасное во время компиляции, поэтому компилятор вставляет проверку во время выполнения. Если значение оказывается `null`, когда проверка выполняется, вы получаете `Null check operator used on a null value`.

Так что это никогда не баг компилятора и не баг фреймворка. Это значение, которое оказалось `null` в момент, когда ваш код поклялся, что оно им не будет. Задача в том, чтобы найти значение и решить, что должно происходить, когда оно действительно отсутствует, а не замазывать это ещё одним `!`.

## Минимальное воспроизведение

Самая простая версия это одна переменная, допускающая null, которой ещё ничего не присвоено:

```dart
// Flutter 3.44, Dart 3.x
String? name;          // nullable, defaults to null
void main() {
  print(name!.length); // throws: Null check operator used on a null value
}
```

В реальном коде Flutter самая частая форма это данные, которые ещё не загрузились. Поле равно `null`, пока его не заполнит сетевой вызов, но `build` выполняется немедленно и разыменовывает его:

```dart
// Flutter 3.44, Dart 3.x -- crashes on first build
class ProfilePage extends StatefulWidget {
  const ProfilePage({super.key});
  @override
  State<ProfilePage> createState() => _ProfilePageState();
}

class _ProfilePageState extends State<ProfilePage> {
  User? _user; // null until the fetch returns

  @override
  void initState() {
    super.initState();
    _loadUser(); // async, completes some frames later
  }

  Future<void> _loadUser() async {
    final u = await api.fetchUser();
    setState(() => _user = u);
  }

  @override
  Widget build(BuildContext context) {
    return Text(_user!.name); // <-- _user is null on the first build
  }
}
```

`build` вызывается до того, как `_loadUser` завершится, поэтому `_user` всё ещё `null` на первом кадре, и `_user!` выбрасывает исключение.

## Решение, в порядке предпочтения

Правильное решение зависит от того, является ли `null` законным состоянием (данные ещё грузятся, необязательное поле, отсутствующий ключ) или багом (вы ожидали значение, и его отсутствие означает, что выше по цепочке что-то сломано). Чаще всего это первое, и фреймворк даёт вам идиоматичные инструменты для этого.

### 1. Задайте значение по умолчанию через `??`

Если есть разумное запасное значение, оператор объединения с null это самое короткое корректное решение. Он возвращает правую сторону, когда левая равна `null`:

```dart
// Flutter 3.44, Dart 3.x
Text(_user?.name ?? 'Loading...');
```

`_user?.name` равно `null`, когда `_user` равно `null` (`?.` замыкает всю цепочку), и `??` подставляет заглушку. Без выброса исключения, и интерфейс показывает что-то полезное, пока грузятся данные.

### 2. Явно ветвитесь по состоянию загрузки

Когда нет хорошего значения по умолчанию, отрисовывайте разные виджеты для загруженного и ещё-не-загруженного состояния. Проверка `if (x != null)` повышает локальную переменную до ненулевой внутри ветки, так что `!` вам вообще не нужен:

```dart
// Flutter 3.44, Dart 3.x
@override
Widget build(BuildContext context) {
  final user = _user;            // copy to a local for promotion
  if (user == null) {
    return const Center(child: CircularProgressIndicator());
  }
  return Text(user.name);        // user is User here, not User?
}
```

Сначала скопируйте поле в локальную переменную. Dart повышает только локальные переменные, а не поля экземпляра, потому что другой метод (или другой isolate) мог бы изменить поле между проверкой и использованием. Локальная переменная это несущая часть этого шаблона.

### 3. Пусть `FutureBuilder` возьмёт на себя состояние null

Если значение приходит из одного асинхронного вызова, не мастерите флаг вручную. `FutureBuilder` моделирует загрузку, ошибку и данные как один объект, и вы читаете `data` только после того, как подтвердили, что оно присутствует:

```dart
// Flutter 3.44, Dart 3.x
FutureBuilder<User>(
  future: _userFuture, // created once, not in build -- see below
  builder: (context, snapshot) {
    if (snapshot.connectionState != ConnectionState.done) {
      return const CircularProgressIndicator();
    }
    if (snapshot.hasError) {
      return Text('Failed: ${snapshot.error}');
    }
    return Text(snapshot.data!.name); // safe: hasData is implied here
  },
);
```

`snapshot.data!` здесь законен, потому что вы уже доказали, что future завершился без ошибки. Одна оговорка, которая бьёт многих: создавайте future один раз и сохраняйте его, никогда не встраивайте прямо в `build`, иначе каждая перестройка запускает новую загрузку. Это отдельная ловушка, разобранная в [почему FutureBuilder постоянно пересоздаёт свой Future](/ru/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/).

### 4. Используйте `late` только когда инициализация действительно предшествует первому чтению

Если значение присваивается ровно один раз, до того как что-либо его прочитает, `late` убирает нулевость без bang. Но это сделка, а не бесплатный выигрыш: поле `late`, прочитанное до присваивания, выбрасывает `LateInitializationError`, другой и, пожалуй, худший сбой, потому что легко предположить, что `late` сделало значение безопасным. Прибегайте к нему только когда порядок гарантирован, например значение, заданное в `initState` и читаемое в `build`:

```dart
// Flutter 3.44, Dart 3.x
late final AnimationController _controller;

@override
void initState() {
  super.initState();
  _controller = AnimationController(vsync: this); // assigned before any build
}
```

Если порядок не гарантирован, держите поле допускающим null и защищайте его. Полный разбор того, когда `late` помогает, а когда вредит, есть в [как исправить LateInitializationError во Flutter](/ru/2026/06/fix-lateinitializationerror-field-has-not-been-initialized-in-flutter/).

## Обычные подозреваемые помимо флага загрузки

Ошибка надевает несколько личин. Вот самые частые, у каждой та же лежащая в основе причина и та же форма решения.

**`GlobalKey.currentState!` до того, как виджет смонтирован.** Вызов `_formKey.currentState!.validate()`, когда `Form` нет в дереве (или он ещё не построен), выбрасывает исключение, потому что `currentState` равно `null`, пока виджет не прикрепится. Используйте `?.`:

```dart
// Flutter 3.44, Dart 3.x
if (_formKey.currentState?.validate() ?? false) {
  // form is valid and present
}
```

**Аргументы маршрута, которые не были переданы.** `ModalRoute.of(context)!.settings.arguments as Args` предполагает и что маршрут существует, и что аргументы были предоставлены. Если вы открываете маршрут без аргументов, `arguments` равно `null`, и последующее `as` или следующий `!` взрывается. Читайте защитно:

```dart
// Flutter 3.44, Dart 3.x
final args = ModalRoute.of(context)?.settings.arguments as Args?;
if (args == null) return const ErrorScreen('Missing arguments');
```

**Доступ к Map и JSON через `[key]!`.** Поиск в map возвращает `null` для отсутствующего ключа, а `json['email']!` выбрасывает исключение в тот момент, когда поле отсутствует или API его переименовал. Декодируйте через модель с явной нулевостью или задавайте значение по умолчанию каждому полю:

```dart
// Flutter 3.44, Dart 3.x
final email = (json['email'] as String?) ?? '';
```

**`firstWhere` с bang над результатом.** Иногда пишут `list.firstWhere((e) => e.id == id, orElse: () => null)!`, чтобы "найти или упасть". Это ровно непроверенное предположение. Предпочитайте `firstWhereOrNull` из `package:collection` и обрабатывайте пустой случай:

```dart
// Flutter 3.44, Dart 3.x
final match = list.firstWhereOrNull((e) => e.id == id);
if (match == null) { /* handle not found */ }
```

## Варианты, которыми это не является, и куда идти вместо этого

Поисковый трафик по этой ошибке часто принадлежит соседней странице. Три двойника:

`LateInitializationError: Field '_x' has not been initialized` это родственник, а не та же ошибка. Она происходит от чтения переменной `late` до присваивания, а не от `!` над допускающим null значением. Если в трассировке стека написано `LateInitializationError`, решение находится на [странице LateInitializationError](/ru/2026/06/fix-lateinitializationerror-field-has-not-been-initialized-in-flutter/), а не здесь.

Проверка на null, которая срывается только после навигации и только в release, часто это симптом мёртвого контекста. Поиск по деактивированному контексту возвращает `null` в release-сборках (assert, который это ловит, только для debug), и этот `null` затем срабатывает на `!` где-то ниже. Если сбой коррелирует с `await`, за которым следует использование контекста, прочитайте [как безопасно использовать BuildContext после await](/ru/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/), потому что настоящий баг находится выше bang.

`TextEditingController` или другой контроллер, использованный после `dispose`, тоже может подать `null` в более позднее утверждение. Если контроллер это источник, [как исправить ошибку освобождённого контроллера](/ru/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter) разбирает жизненный цикл напрямую.

## Линтер, который ловит это до выполнения

Dart не может предупредить о каждом `!`, который мог бы упасть, потому что в этом и весь смысл оператора: вы переопределяете анализатор. Но он может отметить те, которые может доказать как бесполезные. Правило `unnecessary_non_null_assertion`, включённое по умолчанию в `flutter_lints`, срабатывает, когда вы ставите bang на значение, которое анализатор уже знает как ненулевое, что обычно означает, что ваша мысленная модель и система типов не согласны:

```yaml
# analysis_options.yaml -- on by default via flutter_lints
include: package:flutter_lints/flutter.yaml
```

Более широкая дисциплина в том, чтобы относиться к каждому `!`, который вы печатаете, как к утверждению, которое надо защитить. Если вы не можете указать на строку, которая гарантирует, что значение ненулевое на этом пути, у вас не `!`, у вас скрытый `Null check operator used on a null value`. Моделирование асинхронных данных как явных состояний загрузки и ошибки, как в [состояния загрузки и ошибки с AsyncValue](/ru/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/), убирает большинство таких утверждений полностью, потому что фреймворк выдаёт вам значение только в той ветке, где оно существует.

## Привычка, которая отправляет ошибку на пенсию

Оператор bang это обещание компилятору, погашаемое во время выполнения, а `Null check operator used on a null value` это квитанция о нарушенном обещании. Всякий раз, когда вас тянет написать `!`, спросите себя, что должно произойти, когда значение действительно `null`: заглушка (`??`), другой виджет (`if (x != null)`) или настоящая ошибка, которую вы выбрасываете намеренно. Выберите одно из этого, и сбой никогда не дойдёт до пользователя. Оставьте `!` для редкого случая, когда `null` был бы настоящим нарушением инварианта, и даже тогда предпочтите выбросить `StateError` с сообщением, которое объясняет, что пошло не так, голому bang, который говорит лишь "это было null".

## Источники

- [Understanding null safety](https://dart.dev/null-safety/understanding-null-safety), документация Dart, которая определяет оператор `!` как проверяемое приведение к ненулевому типу и объясняет, почему проверка должна выполняться во время выполнения.
- [Null safety unsound migration and the `!` operator](https://dart.dev/null-safety), документация языка Dart.
- [unnecessary_non_null_assertion lint rule](https://dart.dev/tools/linter-rules/unnecessary_non_null_assertion), правила линтера Dart.
- [firstWhereOrNull](https://pub.dev/documentation/collection/latest/collection/IterableExtension/firstWhereOrNull.html), документация API `package:collection`.
