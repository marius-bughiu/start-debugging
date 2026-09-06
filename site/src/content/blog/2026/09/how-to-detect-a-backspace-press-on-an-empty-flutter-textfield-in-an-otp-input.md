---
title: "How to detect a backspace press on an empty Flutter TextField in an OTP input"
description: "onChanged never fires because no edit happens, and on iOS the engine's deleteBackward returns without touching anything when the field is empty. Two approaches that actually work on every platform: a zero-width sentinel that guarantees an edit, and a single EditableText behind painted cells. Verified on Flutter 3.47.2 / Dart 3.13.2."
pubDate: 2026-09-06
template: how-to
tags:
  - "flutter"
  - "dart"
  - "how-to"
  - "textfield"
  - "forms"
---

There is no callback that fires. If a `TextField` is already empty and the user taps backspace on the soft keyboard, `onChanged` does not run, `TextEditingController` does not notify, and on iOS the engine does not send anything to the framework at all. That is not a Flutter bug, it is what an IME is: a touchscreen app that emits text edits, and an empty field being deleted produces no edit. So the answer to "how do I move focus back to the previous OTP cell" is to stop asking for the event and change the data instead. Either keep every cell holding an invisible sentinel character so backspace always produces a real edit, or drop the six-separate-fields design and put one `EditableText` behind six painted cells, which is what [`pinput`](https://pub.dev/packages/pinput) does internally. Everything below was written and run against the current stable channel, Flutter 3.47.2 with Dart 3.13.2.

## The version of this widget that everybody writes first

Six controllers, six focus nodes, advance on input, step back on delete. It looks obviously correct:

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

Type `1 2 3` and focus lands on cell four. Press backspace once and cell three empties and focus steps to cell two. Press backspace again and nothing happens, forever. The user is stuck in a cell that is already empty with no way back except tapping.

The reason is visible in the code above once you look for it. `_onChanged` is only ever called by `TextField` when the editing value changes. Deleting nothing changes nothing, so there is nothing to call it with.

## Soft keyboards do not have a backspace key

The instinct is that this is a missing feature and Flutter should just deliver the key press. Greg Spencer, who owns the key event system, has answered this several times on [flutter/flutter#14809](https://github.com/flutter/flutter/issues/14809), the canonical issue for this exact OTP widget. His framing is the one worth internalising. A soft keyboard is an Input Method Editor: a separate application that takes touch input and produces an editing event stream, sent to your app over a text editing connection. It "never activates any buttons on the device", so there is no key press to forward in the first place.

A physical keyboard raises a hardware event at the OS level and every app in the foreground sees it. A soft keyboard draws a picture of a key, notices a touch, and calls an editing API on your text field. When the field is empty there is no edit to request, so most IMEs call nothing.

That issue was opened on 2018-02-21 and closed on 2021-08-17 with the conclusion that Flutter cannot fix it. [Issue #50587](https://github.com/flutter/flutter/issues/50587), which asks the same question in the same OTP context, was closed as a duplicate of it. If you are searching for an open tracking issue to subscribe to, there is not one, and that is deliberate.

## What the engine actually does on each platform

The framework-level explanation is accurate but abstract, and the platform behaviour differs enough that a workaround can look correct on one device and dead on another. The engine source settles it.

On iOS, `FlutterTextInputView` implements `UIKeyInput`, so UIKit calls `deleteBackward` when the user taps the delete key. Here is the shape of that method in `shell/platform/darwin/ios/framework/Source/FlutterTextInputPlugin.mm` at tag 3.47.2:

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

Read the two guards together for an empty field. `hasText` is false, so the first block is skipped and the selection is never widened. The selection is still empty, so the second block is skipped and `replaceRange:` is never called. `replaceRange:` is what eventually reports a new editing state over the platform channel, so nothing whatsoever crosses into Dart. There is no key event to intercept on iOS because UIKit never produced one, and there is no editing event because the engine correctly declined to invent one.

Android is different, and this is where the confusion comes from. `InputConnection` lets an IME choose to send a real `KeyEvent` instead of an editing call, and Flutter's `InputConnectionAdaptor` routes it straight into the same pipeline as a physical key:

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

So on Android, an IME that calls `InputConnection.sendKeyEvent` with `KEYCODE_DEL` produces a genuine `KeyDownEvent` in your Flutter tree, empty field or not. Whether it does that is entirely the keyboard's decision. Gboard's numeric and symbol keypads have historically sent the key event; the standard QWERTY layout has historically not; Samsung's keyboard, SwiftKey, and every OEM IME make their own choice; and a user can install anything. Flutter contributor LongCatIsLooong put the point sharply on [flutter/flutter#148375](https://github.com/flutter/flutter/issues/148375): a software keyboard can send any key press it likes as a hardware key event, up to and including a plain letter, and Flutter has no way to tell those apart from the real thing.

## Why the KeyboardListener answer works on your test device

The most upvoted answer on this topic is to intercept the key. In modern Flutter that means a `Focus` wrapper, since `RawKeyboardListener` and `RawKeyEvent` carry `'This feature was deprecated after v3.18.0-2.0.pre.'` and any Stack Overflow snippet using `event.data.logicalKey` will not compile cleanly today:

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

This is worth shipping, but only as a supplement. It is the whole answer on web, Windows, macOS, Linux, and any tablet with an attached keyboard, where hardware key events always arrive. It is a coin flip on Android depending on the user's IME and the keypad layout your `keyboardType` opened. It is dead on iOS.

Flutter's own Justin McCandless posted the `Shortcuts`/`Actions` variant of this on #14809 in July 2021 and then edited the comment to lead with "*Update*: Not fixed, this only works for hardware keyboards." If a snippet you found does not carry that caveat, it was copied from before the edit.

## Fix 1: make the cell never actually empty

If the problem is that deleting nothing produces no edit, give the keyboard something to delete. Seed every controller with a zero-width space, `U+200B`, which renders as nothing and measures zero pixels. Backspace on a visually empty cell now deletes a real character, `onChanged` fires with `''`, and you have your signal.

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

Two details make or break this. The caret must always be after the sentinel, which is why `_setCell` writes a whole `TextEditingValue` rather than assigning `controller.text` (the setter collapses the selection to offset -1 and leaves the IME in an odd state). And you cannot use `maxLength: 1` any more, because the sentinel counts toward it; cap the length in `_onChanged` instead, as above.

## What the sentinel costs you

It is a workaround, and the bill comes in six parts.

- **iOS capitalization breaks.** A field whose value starts with an invisible character is not at the start of a sentence as far as iOS is concerned, so the keyboard stops offering a capital letter. Reported on #14809 by kasyr in August 2021, and confirmed for every invisible code point they tried, not just `U+200B`. Irrelevant for numeric OTPs, fatal for alphanumeric codes. The workaround in that thread is to store a real space and subclass `TextEditingController` to override `buildTextSpan` so the space is swapped for a zero-width one at paint time only.
- **Every read needs stripping.** Any code path that touches `controller.text` and forgets `.replaceAll(_zwsp, '')` ships an invisible character into your API request, and it will not be visible in a log line or a debugger's string preview.
- **Accessibility gets muddy.** TalkBack and VoiceOver see a non-empty field with no announceable content. Set an explicit `InputDecoration.labelText` or a `Semantics` label per cell so the state is still describable.
- **Autofill mostly does not work.** `AutofillHints.oneTimeCode` maps to `AUTOFILL_HINT_SMS_OTP` on Android, `oneTimeCode` on iOS, and `one-time-code` on web. Neither mobile platform will fan a six-digit code out across six separate fields; iOS fills the focused field only.
- **Selection is user-reachable.** A long press or a caret drag can put the cursor before the sentinel. You need an `onTap` handler per cell that re-pins the selection.
- **The formatter list needs updating.** `FilteringTextInputFormatter.digitsOnly` will eat your sentinel. Use `FilteringTextInputFormatter.allow(RegExp('[0-9\u200B]'))`.

If your product is an alphanumeric code, stop here and use the next approach. If it is a six-digit numeric OTP and you already have this shipped and working, the sentinel is defensible.

## Fix 2: one field, six painted cells

The cleaner answer is that the six-field design is the actual bug. Backspace on an empty cell is only a problem because focus is spread across six inputs. Hold the whole code in one `TextField` and render the boxes yourself, and the entire class of problem disappears: every backspace except the one on a completely empty code is a normal edit that fires `onChanged` normally, and a backspace on a completely empty code should do nothing, which is exactly what happens.

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

`enableInteractiveSelection: false` plus `showCursor: false` is what keeps the caret pinned at the end without any manual selection juggling, and it removes the selection toolbar that would otherwise pop up over your painted boxes. Rebuild on focus change too, either with a `_focusNode` listener or by wrapping in a `Focus` widget, so the active-cell highlight tracks correctly.

## Why this is the version to ship

This is not a clever trick, it is the design the ecosystem converged on. `pinput` 6.0.2, the most-used OTP package on pub.dev, builds a single `EditableText` in `lib/src/pinput_state.dart` and paints its cells around it, for exactly these reasons:

- **Autofill works.** One field with `AutofillHints.oneTimeCode` is what the iOS QuickType bar and Android's SMS OTP autofill are designed to fill. Six fields are not.
- **Paste works.** A user copying a code out of a message pastes six characters into one field and it lands correctly, with no distribution logic.
- **Screen readers work.** One labelled field with one value, instead of six fields whose relationship a screen reader has no way to convey.
- **State is one string.** No array of controllers to keep in sync, dispose, and reason about, which removes a whole family of lifecycle mistakes. See [how to dispose controllers in Flutter to avoid memory leaks](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) and [Fix: A TextEditingController was used after being disposed in Flutter](/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/) for what the six-controller version tends to cost you later.
- **Backspace is not special.** It is an ordinary delete against a non-empty string until the string is empty, and then it correctly does nothing.

Keep the `Focus`/`onKeyEvent` handler from earlier only if you also support a physical keyboard and want something extra to happen on backspace at an empty code, such as clearing an error banner or popping the route. That is the one job it can do reliably everywhere, because it only has to work when a hardware keyboard is present.

## Testing this without fooling yourself

`WidgetTester.sendKeyEvent` dispatches through `HardwareKeyboard`, which is the physical-keyboard path. A test written with it will pass against the `Focus`/`onKeyEvent` implementation, including on the iOS target, while the real app on a real iPhone does nothing. That test is worse than no test, because it certifies the one platform where the approach cannot work.

Drive the text input channel instead. `tester.enterText` goes through `TextInputConnection.updateEditingValue`, which is the path an IME actually uses, so shortening the string is a faithful simulation of a soft-keyboard backspace:

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

For the sentinel implementation, the equivalent assertion is that entering `''` into cell `n` leaves cell `n - 1` focused and both cells holding exactly one `\u200B`. If you are pinning other ambient state in these tests, [testing a Flutter widget at a fixed point in time](/2026/08/how-to-test-a-flutter-widget-at-a-fixed-point-in-time/) covers the binding-level version of the same idea.

The short version, if you skipped here: the event you want does not exist, so build the widget that does not need it.

### Read next

- [How to dispose controllers in Flutter to avoid memory leaks](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)
- [Fix: A TextEditingController was used after being disposed in Flutter](/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/)
- [Fix: A RenderFlex overflowed by N pixels on the bottom when the keyboard opens in Flutter](/2026/08/fix-renderflex-overflowed-on-the-bottom-when-the-keyboard-opens-in-flutter/)
- [What is a Flutter Key and when does omitting it cause bugs?](/2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs/)
- [How to test a Flutter widget at a fixed point in time without a withClock closure](/2026/08/how-to-test-a-flutter-widget-at-a-fixed-point-in-time/)

### Sources

- [Issue #14809: Detect when delete is typed into a TextField](https://github.com/flutter/flutter/issues/14809), flutter/flutter
- [Issue #50587: How do I listen to backspace/delete key (from the on screen keyboard) on an empty TextField?](https://github.com/flutter/flutter/issues/50587), flutter/flutter
- [Issue #148375: On Android, KeyboardListener catches software keyboard input](https://github.com/flutter/flutter/issues/148375), flutter/flutter
- [`InputConnection.sendKeyEvent`](https://developer.android.com/reference/android/view/inputmethod/InputConnection#sendKeyEvent(android.view.KeyEvent)), Android API reference
- [`UIKeyInput.deleteBackward()`](https://developer.apple.com/documentation/uikit/uikeyinput/deletebackward()), UIKit documentation
- [Migrate RawKeyEvent/RawKeyboard to the KeyEvent/HardwareKeyboard system](https://docs.flutter.dev/release/breaking-changes/key-event-migration), Flutter breaking changes
- [`AutofillHints.oneTimeCode`](https://api.flutter.dev/flutter/services/AutofillHints/oneTimeCode-constant.html), Flutter API reference
- [`pinput` 6.0.2](https://pub.dev/packages/pinput), pub.dev
