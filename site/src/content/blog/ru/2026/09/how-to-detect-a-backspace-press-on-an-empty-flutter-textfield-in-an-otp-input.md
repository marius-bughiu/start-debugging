---
title: "Как определить нажатие Backspace в пустом TextField во Flutter при вводе OTP"
description: "onChanged не срабатывает, потому что никакого редактирования не происходит, а на iOS метод deleteBackward в движке просто возвращается, ничего не тронув, если поле пустое. Два подхода, которые действительно работают на всех платформах: сторожевой символ нулевой ширины, гарантирующий редактирование, и один EditableText за отрисованными ячейками. Проверено на Flutter 3.47.2 / Dart 3.13.2."
pubDate: 2026-09-06
template: how-to
tags:
  - "flutter"
  - "dart"
  - "how-to"
  - "textfield"
  - "forms"
lang: "ru"
translationOf: "2026/09/how-to-detect-a-backspace-press-on-an-empty-flutter-textfield-in-an-otp-input"
translatedBy: "claude"
translationDate: 2026-09-06
---

Никакого колбэка здесь не срабатывает. Если `TextField` уже пуст и пользователь нажимает Backspace на экранной клавиатуре, `onChanged` не вызывается, `TextEditingController` не уведомляет слушателей, а на iOS движок вообще ничего не отправляет во фреймворк. Это не ошибка Flutter, а суть того, чем является IME: сенсорное приложение, которое выдаёт правки текста, а удаление в пустом поле не порождает никакой правки. Поэтому ответ на вопрос "как вернуть фокус в предыдущую ячейку OTP" состоит в том, чтобы перестать ждать событие и изменить сами данные. Либо каждая ячейка постоянно содержит невидимый сторожевой символ, чтобы Backspace всегда порождал настоящую правку, либо вы отказываетесь от схемы из шести отдельных полей и ставите один `EditableText` за шестью отрисованными ячейками, как это делает внутри [`pinput`](https://pub.dev/packages/pinput). Всё изложенное ниже написано и проверено на текущем стабильном канале, Flutter 3.47.2 с Dart 3.13.2.

## Вариант этого виджета, который все пишут первым

Шесть контроллеров, шесть узлов фокуса, переход вперёд при вводе, возврат назад при удалении. Выглядит очевидно правильным:

```dart
// Flutter 3.47.2, Dart 3.13.2
class _NaiveOtpRowState extends State<NaiveOtpRow> {
  static const int _length = 6;

  final List<TextEditingController> _controllers =
      List<TextEditingController>.generate(_length, (_) => TextEditingController());
  final List<FocusNode> _nodes = List<FocusNode>.generate(_length, (_) => FocusNode());

  @override
  void dispose() {
    for (final TextEditingController c in _controllers) {
      c.dispose();
    }
    for (final FocusNode n in _nodes) {
      n.dispose();
    }
    super.dispose();
  }

  void _onChanged(String value, int index) {
    if (value.isNotEmpty && index < _length - 1) {
      _nodes[index + 1].requestFocus();
      return;
    }
    // This branch runs when a filled cell is emptied.
    // It never runs when the cell was already empty.
    if (value.isEmpty && index > 0) {
      _nodes[index - 1].requestFocus();
    }
  }

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceEvenly,
      children: <Widget>[
        for (int i = 0; i < _length; i++)
          SizedBox(
            width: 44,
            child: TextField(
              controller: _controllers[i],
              focusNode: _nodes[i],
              textAlign: TextAlign.center,
              keyboardType: TextInputType.number,
              maxLength: 1,
              decoration: const InputDecoration(counterText: ''),
              onChanged: (String value) => _onChanged(value, i),
            ),
          ),
      ],
    );
  }
}
```

Наберите `1 2 3`, и фокус окажется в четвёртой ячейке. Нажмите Backspace один раз: третья ячейка очистится, а фокус перейдёт во вторую. Нажмите Backspace ещё раз, и не произойдёт ничего, никогда. Пользователь застревает в уже пустой ячейке без возможности вернуться иначе, чем касанием.

Причина видна в коде выше, стоит только её поискать. `_onChanged` вызывается из `TextField` только при изменении редактируемого значения. Удаление пустоты ничего не меняет, значит, вызывать колбэк просто не с чем.

## У экранных клавиатур нет клавиши Backspace

Первая мысль: это недостающая возможность, и Flutter должен просто доставить нажатие. Грег Спенсер, отвечающий за систему событий клавиатуры, отвечал на это несколько раз в [flutter/flutter#14809](https://github.com/flutter/flutter/issues/14809), каноническом issue именно про этот OTP-виджет. Его формулировку стоит усвоить. Экранная клавиатура это Input Method Editor: отдельное приложение, которое принимает касания и порождает поток событий редактирования, отправляемый в ваше приложение через соединение ввода текста. Она "никогда не нажимает никаких кнопок на устройстве", так что передавать изначально нечего.

Физическая клавиатура порождает аппаратное событие на уровне операционной системы, и его видит любое приложение на переднем плане. Экранная клавиатура рисует картинку клавиши, замечает касание и вызывает API редактирования на вашем текстовом поле. Когда поле пусто, запрашивать нечего, поэтому большинство IME не вызывают ничего.

Этот issue был открыт 2018-02-21 и закрыт 2021-08-17 с выводом, что Flutter не может это исправить. [Issue #50587](https://github.com/flutter/flutter/issues/50587), задающий тот же вопрос в том же OTP-контексте, был закрыт как его дубликат. Если вы ищете открытый issue, на который можно подписаться, его нет, и это сделано намеренно.

## Что движок реально делает на каждой платформе

Объяснение на уровне фреймворка верно, но абстрактно, а поведение платформ различается достаточно сильно, чтобы обходной приём выглядел рабочим на одном устройстве и был мёртв на другом. Исходники движка ставят точку.

На iOS `FlutterTextInputView` реализует `UIKeyInput`, поэтому UIKit вызывает `deleteBackward`, когда пользователь нажимает клавишу удаления. Вот форма этого метода в `shell/platform/darwin/ios/framework/Source/FlutterTextInputPlugin.mm` на теге 3.47.2:

```objc
// Flutter engine 3.47.2, abridged.
- (void)deleteBackward {
  _selectionAffinity = kTextAffinityDownstream;
  // ...
  if (_selectedTextRange.isEmpty && [self hasText]) {
    // Move the collapsed selection back one grapheme cluster,
    // widening it into a one-character range to delete.
  }

  if (!_selectedTextRange.isEmpty) {
    [self replaceRange:_selectedTextRange withText:@""];
  }
}
```

Прочитайте оба условия вместе применительно к пустому полю. `hasText` равно false, поэтому первый блок пропускается и выделение никогда не расширяется. Выделение по-прежнему пусто, поэтому второй блок тоже пропускается и `replaceRange:` не вызывается. Именно `replaceRange:` в итоге сообщает новое состояние редактирования через platform channel, так что в Dart не попадает вообще ничего. Перехватывать событие клавиши на iOS нечего, потому что UIKit его не порождал, и события редактирования тоже нет, потому что движок справедливо отказался его выдумывать.

На Android всё иначе, и отсюда берётся путаница. `InputConnection` позволяет IME отправить настоящее `KeyEvent` вместо вызова редактирования, а `InputConnectionAdaptor` во Flutter направляет его прямо в тот же конвейер, что и физическую клавишу:

```java
// engine/src/flutter/shell/platform/android/io/flutter/plugin/editing/InputConnectionAdaptor.java, 3.47.2
// This function is called both when hardware key events occur and aren't
// handled by the framework, as well as when soft keyboard editing events
// occur, and need a chance to be handled by the framework.
@Override
public boolean sendKeyEvent(KeyEvent event) {
  return keyboardDelegate.handleEvent(event);
}
```

То есть на Android IME, вызывающий `InputConnection.sendKeyEvent` с `KEYCODE_DEL`, порождает настоящее `KeyDownEvent` в вашем дереве Flutter, независимо от того, пусто поле или нет. Делает ли он это, решает исключительно клавиатура. Цифровая и символьная раскладки Gboard исторически отправляли событие клавиши, стандартная раскладка QWERTY исторически нет; клавиатура Samsung, SwiftKey и любой IME производителя решают сами, а пользователь может установить что угодно. Контрибьютор Flutter LongCatIsLooong сформулировал это в [flutter/flutter#148375](https://github.com/flutter/flutter/issues/148375): экранная клавиатура может отправить как аппаратное событие клавиши любое нажатие, вплоть до обычной буквы, и у Flutter нет способа отличить такие события от настоящих.

## Почему ответ с KeyboardListener работает на вашем тестовом устройстве

Самый популярный ответ на эту тему предлагает перехватить клавишу. В современном Flutter это означает обёртку `Focus`, поскольку `RawKeyboardListener` и `RawKeyEvent` несут пометку `'This feature was deprecated after v3.18.0-2.0.pre.'`, а любой фрагмент со Stack Overflow, использующий `event.data.logicalKey`, сегодня уже не соберётся без замечаний:

```dart
// Flutter 3.47.2. Works on hardware keyboards. Works on *some* Android IMEs.
// Never works on iOS.
Focus(
  onKeyEvent: (FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent) {
      return KeyEventResult.ignored;
    }
    if (event.logicalKey != LogicalKeyboardKey.backspace) {
      return KeyEventResult.ignored;
    }
    if (_controllers[index].text.isNotEmpty) {
      return KeyEventResult.ignored; // Let the field handle a real delete.
    }
    if (index > 0) {
      _controllers[index - 1].clear();
      _nodes[index - 1].requestFocus();
    }
    return KeyEventResult.handled;
  },
  child: TextField(controller: _controllers[index], focusNode: _nodes[index]),
)
```

Это стоит выпускать в продакшен, но только как дополнение. Это исчерпывающий ответ в вебе, на Windows, macOS, Linux и на любом планшете с подключённой клавиатурой, где аппаратные события клавиш приходят всегда. На Android это подбрасывание монеты, зависящее от IME пользователя и от раскладки, которую открыл ваш `keyboardType`. На iOS это мертво.

Джастин Маккэндлесс из самой команды Flutter опубликовал вариант с `Shortcuts`/`Actions` в #14809 в июле 2021 года, а затем отредактировал комментарий так, чтобы он начинался с "*Update*: Not fixed, this only works for hardware keyboards." Если найденный вами фрагмент не содержит этой оговорки, он скопирован до правки.

## Решение 1: сделать так, чтобы ячейка никогда не была по-настоящему пустой

Если проблема в том, что удаление ничего не порождает правки, дайте клавиатуре то, что можно удалить. Инициализируйте каждый контроллер пробелом нулевой ширины, `U+200B`, который отрисовывается как ничто и занимает ноль пикселей. Backspace в визуально пустой ячейке теперь удаляет настоящий символ, `onChanged` срабатывает со значением `''`, и нужный сигнал у вас есть.

```dart
// Flutter 3.47.2, Dart 3.13.2
const String _zwsp = '\u200B';

class _SentinelOtpRowState extends State<SentinelOtpRow> {
  static const int _length = 6;

  late final List<TextEditingController> _controllers = List<TextEditingController>.generate(
    _length,
    (_) => TextEditingController(text: _zwsp),
  );
  late final List<FocusNode> _nodes = List<FocusNode>.generate(_length, (_) => FocusNode());

  String get code => _controllers.map((TextEditingController c) => c.text.replaceAll(_zwsp, '')).join();

  // Always rewrite the whole value so the caret is guaranteed to sit
  // after the sentinel. If it sits before it, backspace deletes nothing
  // and you are back where you started.
  void _setCell(int index, String digit) {
    final String text = '$_zwsp$digit';
    _controllers[index].value = TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
    );
  }

  void _onChanged(String value, int index) {
    if (value.isEmpty) {
      // The sentinel itself was deleted: backspace on an empty cell.
      _setCell(index, '');
      if (index > 0) {
        _setCell(index - 1, '');
        _nodes[index - 1].requestFocus();
      }
      return;
    }

    final String digits = value.replaceAll(_zwsp, '');
    if (digits.isEmpty) {
      // A filled cell was emptied. Stay put; the next backspace steps left.
      _setCell(index, '');
      return;
    }

    if (digits.length > 1) {
      // A paste, or a fast typist. Spread it across the remaining cells.
      for (int i = 0; i < digits.length && index + i < _length; i++) {
        _setCell(index + i, digits[i]);
      }
      final int next = index + digits.length;
      _nodes[next < _length ? next : _length - 1].requestFocus();
      return;
    }

    _setCell(index, digits);
    if (index < _length - 1) {
      _nodes[index + 1].requestFocus();
    }
  }
}
```

Две детали решают судьбу этого приёма. Каретка всегда должна стоять после сторожевого символа, поэтому `_setCell` записывает целиком `TextEditingValue`, а не присваивает `controller.text` (сеттер схлопывает выделение в смещение -1 и оставляет IME в странном состоянии). И `maxLength: 1` использовать больше нельзя, потому что сторожевой символ в него засчитывается; ограничивайте длину внутри `_onChanged`, как показано выше.

## Во что обходится сторожевой символ

Это обходной приём, и счёт приходит из шести пунктов.

- **Ломается автозаглавная буква на iOS.** Поле, значение которого начинается с невидимого символа, с точки зрения iOS не находится в начале предложения, поэтому клавиатура перестаёт предлагать заглавную букву. Сообщено в #14809 пользователем kasyr в августе 2021 года и подтверждено для всех проверенных невидимых кодовых точек, а не только для `U+200B`. Для числовых OTP несущественно, для буквенно-цифровых кодов фатально. Обходной приём из той же ветки: хранить настоящий пробел и унаследовать `TextEditingController`, переопределив `buildTextSpan` так, чтобы пробел подменялся на символ нулевой ширины только при отрисовке.
- **Каждое чтение требует очистки.** Любой путь кода, который обращается к `controller.text` и забывает `.replaceAll(_zwsp, '')`, отправляет невидимый символ в ваш запрос к API, и его не будет видно ни в строке лога, ни в предпросмотре строки в отладчике.
- **Доступность становится мутной.** TalkBack и VoiceOver видят непустое поле без озвучиваемого содержимого. Задайте явный `InputDecoration.labelText` или метку `Semantics` для каждой ячейки, чтобы состояние оставалось описуемым.
- **Автозаполнение почти не работает.** `AutofillHints.oneTimeCode` отображается в `AUTOFILL_HINT_SMS_OTP` на Android, в `oneTimeCode` на iOS и в `one-time-code` в вебе. Ни одна из мобильных платформ не разложит шестизначный код по шести отдельным полям; iOS заполняет только сфокусированное поле.
- **Выделение доступно пользователю.** Долгое нажатие или перетаскивание каретки может поставить её перед сторожевым символом. Нужен обработчик `onTap` для каждой ячейки, заново фиксирующий выделение.
- **Список форматтеров надо обновить.** `FilteringTextInputFormatter.digitsOnly` съест ваш сторожевой символ. Используйте `FilteringTextInputFormatter.allow(RegExp('[0-9\u200B]'))`.

Если в вашем продукте код буквенно-цифровой, остановитесь здесь и переходите к следующему подходу. Если это шестизначный числовой OTP и он уже работает в продакшене, сторожевой символ вполне защитим.

## Решение 2: одно поле и шесть отрисованных ячеек

Более чистый ответ состоит в том, что настоящая ошибка это сама схема из шести полей. Backspace в пустой ячейке становится проблемой только потому, что фокус размазан по шести полям ввода. Держите весь код в одном `TextField` и рисуйте рамки сами, и весь этот класс проблем исчезает: любой Backspace, кроме нажатого при полностью пустом коде, это обычная правка, штатно вызывающая `onChanged`, а Backspace при полностью пустом коде и должен не делать ничего, что и происходит.

```dart
// Flutter 3.47.2, Dart 3.13.2
class OtpInput extends StatefulWidget {
  const OtpInput({super.key, this.length = 6, required this.onCompleted});

  final int length;
  final ValueChanged<String> onCompleted;

  @override
  State<OtpInput> createState() => _OtpInputState();
}

class _OtpInputState extends State<OtpInput> {
  final TextEditingController _controller = TextEditingController();
  final FocusNode _focusNode = FocusNode();

  @override
  void initState() {
    super.initState();
    _controller.addListener(_handleChange);
  }

  @override
  void dispose() {
    _controller.removeListener(_handleChange);
    _controller.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  void _handleChange() {
    setState(() {});
    if (_controller.text.length == widget.length) {
      widget.onCompleted(_controller.text);
    }
  }

  Widget _cell(int index) {
    final String code = _controller.text;
    final bool filled = index < code.length;
    final bool active = _focusNode.hasFocus && index == code.length;
    return Container(
      width: 44,
      height: 56,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(8),
        border: Border.all(
          width: active ? 2 : 1,
          color: active ? Theme.of(context).colorScheme.primary : Theme.of(context).dividerColor,
        ),
      ),
      child: Text(filled ? code[index] : '', style: Theme.of(context).textTheme.headlineSmall),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: <Widget>[
        IgnorePointer(
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceEvenly,
            children: <Widget>[for (int i = 0; i < widget.length; i++) _cell(i)],
          ),
        ),
        // The real input sits on top, invisible, and owns every gesture.
        Positioned.fill(
          child: TextField(
            controller: _controller,
            focusNode: _focusNode,
            autofocus: true,
            keyboardType: TextInputType.number,
            autofillHints: const <String>[AutofillHints.oneTimeCode],
            maxLength: widget.length,
            showCursor: false,
            enableInteractiveSelection: false,
            inputFormatters: <TextInputFormatter>[FilteringTextInputFormatter.digitsOnly],
            style: const TextStyle(color: Colors.transparent, height: 0.01),
            decoration: const InputDecoration(
              counterText: '',
              border: InputBorder.none,
              contentPadding: EdgeInsets.zero,
            ),
          ),
        ),
      ],
    );
  }
}
```

`enableInteractiveSelection: false` вместе с `showCursor: false` удерживает каретку в конце без ручного жонглирования выделением и убирает панель выделения, которая иначе всплывала бы поверх ваших нарисованных рамок. Перестраивайте виджет и при смене фокуса, слушателем на `_focusNode` или обёрткой в виджет `Focus`, чтобы подсветка активной ячейки корректно следовала за состоянием.

## Почему выпускать стоит именно этот вариант

Это не хитрый трюк, а решение, к которому пришла вся экосистема. `pinput` 6.0.2, самый популярный OTP-пакет на pub.dev, строит один `EditableText` в `lib/src/pinput_state.dart` и рисует ячейки вокруг него ровно по этим причинам:

- **Работает автозаполнение.** Одно поле с `AutofillHints.oneTimeCode` это именно то, что панель QuickType на iOS и автозаполнение OTP из SMS на Android рассчитаны заполнять. Шесть полей нет.
- **Работает вставка.** Пользователь, скопировавший код из сообщения, вставляет шесть символов в одно поле, и они попадают куда нужно без всякой логики распределения.
- **Работают программы чтения с экрана.** Одно поле с меткой и одним значением вместо шести полей, связь между которыми программа чтения передать не может.
- **Состояние это одна строка.** Никакого массива контроллеров, который нужно синхронизировать, освобождать и держать в голове, что убирает целое семейство ошибок жизненного цикла. Смотрите [как освобождать контроллеры во Flutter, чтобы избежать утечек памяти](/ru/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) и [Fix: A TextEditingController was used after being disposed in Flutter](/ru/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/), чтобы понять, во что вариант с шестью контроллерами обычно обходится потом.
- **Backspace ничем не выделяется.** Это обычное удаление из непустой строки, пока строка не опустеет, а затем он справедливо не делает ничего.

Сохраняйте обработчик `Focus`/`onKeyEvent` из предыдущего раздела только если вы дополнительно поддерживаете физическую клавиатуру и хотите, чтобы при Backspace на пустом коде происходило что-то ещё, например очищался баннер с ошибкой или закрывался маршрут. Это единственная задача, которую он надёжно выполняет везде, потому что работать ему нужно только при наличии аппаратной клавиатуры.

## Как тестировать это, не обманывая себя

`WidgetTester.sendKeyEvent` отправляет события через `HardwareKeyboard`, то есть по пути физической клавиатуры. Тест, написанный на нём, пройдёт против реализации с `Focus`/`onKeyEvent`, в том числе для цели iOS, тогда как настоящее приложение на настоящем iPhone не сделает ничего. Такой тест хуже, чем его отсутствие, потому что он сертифицирует ровно ту платформу, где подход работать не может.

Вместо этого работайте через канал ввода текста. `tester.enterText` идёт через `TextInputConnection.updateEditingValue`, то есть по тому пути, которым реально пользуется IME, так что укорачивание строки это точная имитация Backspace на экранной клавиатуре:

```dart
// Flutter 3.47.2, package:flutter_test
testWidgets('deleting the last digit clears the cell without losing focus', (WidgetTester tester) async {
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: OtpInput(onCompleted: (_) {}))));

  await tester.enterText(find.byType(TextField), '123456');
  await tester.pump();
  expect(find.text('6'), findsOneWidget);

  await tester.enterText(find.byType(TextField), '12345'); // soft-keyboard backspace
  await tester.pump();
  expect(find.text('6'), findsNothing);

  await tester.enterText(find.byType(TextField), ''); // and again on an empty code
  await tester.pump();
  expect(tester.widget<TextField>(find.byType(TextField)).focusNode!.hasFocus, isTrue);
});
```

Для реализации со сторожевым символом эквивалентная проверка такова: ввод `''` в ячейку `n` оставляет ячейку `n - 1` в фокусе, а обе ячейки содержат ровно один `\u200B`. Если в этих тестах вы фиксируете и другое окружающее состояние, [тестирование виджета Flutter в фиксированный момент времени](/ru/2026/08/how-to-test-a-flutter-widget-at-a-fixed-point-in-time/) разбирает ту же идею на уровне binding.

Коротко, если вы пролистали сюда сразу: нужного вам события не существует, поэтому постройте виджет, которому оно не нужно.

### Читайте дальше

- [How to dispose controllers in Flutter to avoid memory leaks](/ru/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)
- [Fix: A TextEditingController was used after being disposed in Flutter](/ru/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/)
- [Fix: A RenderFlex overflowed by N pixels on the bottom when the keyboard opens in Flutter](/ru/2026/08/fix-renderflex-overflowed-on-the-bottom-when-the-keyboard-opens-in-flutter/)
- [What is a Flutter Key and when does omitting it cause bugs?](/ru/2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs/)
- [How to test a Flutter widget at a fixed point in time without a withClock closure](/ru/2026/08/how-to-test-a-flutter-widget-at-a-fixed-point-in-time/)

### Источники

- [Issue #14809: Detect when delete is typed into a TextField](https://github.com/flutter/flutter/issues/14809), flutter/flutter
- [Issue #50587: How do I listen to backspace/delete key (from the on screen keyboard) on an empty TextField?](https://github.com/flutter/flutter/issues/50587), flutter/flutter
- [Issue #148375: On Android, KeyboardListener catches software keyboard input](https://github.com/flutter/flutter/issues/148375), flutter/flutter
- [`InputConnection.sendKeyEvent`](https://developer.android.com/reference/android/view/inputmethod/InputConnection#sendKeyEvent(android.view.KeyEvent)), справочник API Android
- [`UIKeyInput.deleteBackward()`](https://developer.apple.com/documentation/uikit/uikeyinput/deletebackward()), документация UIKit
- [Migrate RawKeyEvent/RawKeyboard to the KeyEvent/HardwareKeyboard system](https://docs.flutter.dev/release/breaking-changes/key-event-migration), несовместимые изменения Flutter
- [`AutofillHints.oneTimeCode`](https://api.flutter.dev/flutter/services/AutofillHints/oneTimeCode-constant.html), справочник API Flutter
- [`pinput` 6.0.2](https://pub.dev/packages/pinput), pub.dev
