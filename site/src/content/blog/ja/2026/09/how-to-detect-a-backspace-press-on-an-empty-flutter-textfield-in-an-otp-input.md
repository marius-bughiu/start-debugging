---
title: "OTP 入力で空の Flutter TextField の Backspace 押下を検知する方法"
description: "編集が発生しないため onChanged は呼ばれず、iOS ではフィールドが空のときエンジンの deleteBackward が何も触らずに戻ります。すべてのプラットフォームで実際に動く 2 つの方法、すなわち編集を保証するゼロ幅のセンチネル文字と、描画したセルの背後に置く単一の EditableText を解説します。Flutter 3.47.2 / Dart 3.13.2 で検証しました。"
pubDate: 2026-09-06
template: how-to
tags:
  - "flutter"
  - "dart"
  - "how-to"
  - "textfield"
  - "forms"
lang: "ja"
translationOf: "2026/09/how-to-detect-a-backspace-press-on-an-empty-flutter-textfield-in-an-otp-input"
translatedBy: "claude"
translationDate: 2026-09-06
---

呼ばれるコールバックは存在しません。`TextField` がすでに空の状態でユーザーがソフトウェアキーボードの Backspace をタップしても、`onChanged` は実行されず、`TextEditingController` も通知せず、iOS ではエンジンがフレームワークに何ひとつ送りません。これは Flutter のバグではなく、IME というものの性質です。IME はテキスト編集を発行するタッチアプリケーションであり、空のフィールドを削除しても編集は発生しません。したがって「どうすれば直前の OTP セルにフォーカスを戻せるか」への答えは、イベントを求めるのをやめてデータのほうを変える、というものになります。各セルに不可視のセンチネル文字を保持させて Backspace が常に実際の編集を生むようにするか、6 個の独立したフィールドという設計をやめて、描画した 6 個のセルの背後に単一の `EditableText` を置くかのどちらかです。後者は [`pinput`](https://pub.dev/packages/pinput) が内部で採っている方法です。以下の内容はすべて現行の stable チャネル、Flutter 3.47.2 と Dart 3.13.2 で記述し、実行しました。

## 誰もが最初に書くこのウィジェットの形

6 個のコントローラー、6 個のフォーカスノード、入力で前進し、削除で後退する。いかにも正しそうに見えます。

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

`1 2 3` と入力するとフォーカスは 4 番目のセルに移ります。Backspace を 1 回押すと 3 番目のセルが空になり、フォーカスは 2 番目のセルへ移ります。もう一度 Backspace を押しても、何も起きません。永遠にです。ユーザーはすでに空のセルに閉じ込められ、タップする以外に戻る手段がありません。

理由は上のコードの中に見えています。`_onChanged` は編集値が変化したときにだけ `TextField` から呼ばれます。何もないものを削除しても何も変わらないので、呼び出す材料そのものがないのです。

## ソフトウェアキーボードに Backspace キーは存在しない

直感的には、これは足りない機能であり Flutter がキー押下をそのまま届けるべきだ、と思えます。キーイベントシステムを担当する Greg Spencer は、まさにこの OTP ウィジェットに関する正典的な issue である [flutter/flutter#14809](https://github.com/flutter/flutter/issues/14809) で、この点に何度も答えています。彼の整理の仕方こそ身につける価値があります。ソフトウェアキーボードは Input Method Editor です。つまり、タッチ入力を受け取って編集イベントのストリームを生成し、それをテキスト入力コネクションであなたのアプリへ送る、独立したアプリケーションです。それは「デバイス上のボタンを一切押していない」ので、そもそも転送すべきキー押下が存在しません。

物理キーボードは OS レベルでハードウェアイベントを発生させ、フォアグラウンドのすべてのアプリがそれを見ます。ソフトウェアキーボードはキーの絵を描き、タッチを検知して、あなたのテキストフィールドに対して編集 API を呼びます。フィールドが空なら要求すべき編集がないので、ほとんどの IME は何も呼びません。

この issue は 2018-02-21 に作成され、Flutter 側では修正できないという結論とともに 2021-08-17 にクローズされました。同じ OTP の文脈で同じ質問をしている [issue #50587](https://github.com/flutter/flutter/issues/50587) も、その重複としてクローズされています。購読できる追跡用のオープンな issue を探しているなら、それは存在しませんし、それは意図的なものです。

## エンジンが各プラットフォームで実際に行っていること

フレームワークレベルの説明は正確ですが抽象的で、プラットフォームごとの挙動の差は、あるデバイスでは正しく見える回避策が別のデバイスでは死んでいる程度には大きいものです。エンジンのソースがこの点に決着をつけてくれます。

iOS では `FlutterTextInputView` が `UIKeyInput` を実装しているため、ユーザーが削除キーをタップすると UIKit が `deleteBackward` を呼びます。タグ 3.47.2 の `shell/platform/darwin/ios/framework/Source/FlutterTextInputPlugin.mm` におけるこのメソッドの形は次のとおりです。

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

空のフィールドについて 2 つのガードをまとめて読んでください。`hasText` は false なので最初のブロックはスキップされ、選択範囲が広げられることはありません。選択範囲は空のままなので 2 番目のブロックもスキップされ、`replaceRange:` は呼ばれません。プラットフォームチャネル越しに新しい編集状態を報告するのは最終的に `replaceRange:` なので、Dart 側には何ひとつ届きません。UIKit がキーイベントを生成していないので iOS には捕まえるべきキーイベントがなく、エンジンが編集イベントをでっちあげることを正しく拒んだので編集イベントもありません。

Android は事情が違い、混乱の元はここにあります。`InputConnection` は IME が編集呼び出しの代わりに本物の `KeyEvent` を送ることを許しており、Flutter の `InputConnectionAdaptor` はそれを物理キーとまったく同じパイプラインへ直接流します。

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

つまり Android では、`InputConnection.sendKeyEvent` を `KEYCODE_DEL` で呼ぶ IME は、フィールドが空かどうかに関係なく、あなたの Flutter ツリーに本物の `KeyDownEvent` を発生させます。そうするかどうかは完全にキーボード側の判断です。Gboard の数字キーパッドと記号キーパッドは歴史的にキーイベントを送ってきましたが、標準の QWERTY レイアウトは歴史的に送りません。Samsung のキーボード、SwiftKey、各 OEM の IME はそれぞれ独自に判断しますし、ユーザーは何でもインストールできます。Flutter のコントリビューターである LongCatIsLooong は [flutter/flutter#148375](https://github.com/flutter/flutter/issues/148375) でこの点を端的に指摘しています。ソフトウェアキーボードは、ふつうの文字も含めて好きなキー押下をハードウェアキーイベントとして送れてしまい、Flutter にはそれを本物と区別する手段がありません。

## KeyboardListener を使う回答があなたのテスト端末で動く理由

この話題で最も支持を集めている回答は、キーを横取りするというものです。現代の Flutter ではそれは `Focus` でのラップを意味します。`RawKeyboardListener` と `RawKeyEvent` には `'This feature was deprecated after v3.18.0-2.0.pre.'` が付いており、`event.data.logicalKey` を使う Stack Overflow のスニペットは今日では警告なしにコンパイルできないからです。

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

これは出荷する価値がありますが、あくまで補助としてです。ハードウェアキーイベントが必ず届く web、Windows、macOS、Linux、そしてキーボードを接続したタブレットでは、これが答えのすべてです。Android ではユーザーの IME と、あなたの `keyboardType` が開いたキーパッドのレイアウト次第のコイントスになります。iOS では死んでいます。

Flutter チームの Justin McCandless 自身が 2021 年 7 月に #14809 で `Shortcuts`/`Actions` を使う変種を投稿し、その後コメントを編集して "*Update*: Not fixed, this only works for hardware keyboards." で始まるようにしました。見つけたスニペットにこの但し書きが付いていないなら、それは編集前からコピーされたものです。

## 対処 1: セルが本当に空にならないようにする

何もないものを削除しても編集が発生しないことが問題なら、キーボードに削除する対象を与えましょう。各コントローラーをゼロ幅スペース `U+200B` で初期化します。これは何も描画されず、幅も 0 ピクセルです。見た目上は空のセルでの Backspace が実際の文字を削除するようになり、`onChanged` が `''` で発火して、必要なシグナルが手に入ります。

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

成否を分ける点が 2 つあります。キャレットは常にセンチネルの後ろになければならず、そのために `_setCell` は `controller.text` へ代入するのではなく `TextEditingValue` を丸ごと書き込んでいます (セッターは選択範囲をオフセット -1 に潰し、IME を奇妙な状態のまま残します)。そして `maxLength: 1` はもう使えません。センチネルがその長さに数えられてしまうからです。上記のように `_onChanged` の中で長さを制限してください。

## センチネルが要求する代償

これは回避策であり、請求書は 6 項目に分かれて届きます。

- **iOS の自動大文字化が壊れます。** 値が不可視文字で始まるフィールドは、iOS から見ると文の先頭ではないため、キーボードが大文字を提案しなくなります。2021 年 8 月に kasyr が #14809 で報告し、`U+200B` だけでなく試したすべての不可視コードポイントで確認されています。数字の OTP には無関係ですが、英数字コードには致命的です。同スレッドの回避策は、本物のスペースを保持したうえで `TextEditingController` を継承して `buildTextSpan` をオーバーライドし、描画時にだけスペースをゼロ幅のものへ差し替えるというものです。
- **読み出しのたびに除去が必要です。** `controller.text` に触れて `.replaceAll(_zwsp, '')` を忘れたコードパスは、不可視文字を API リクエストに紛れ込ませます。しかもログ行にもデバッガーの文字列プレビューにも見えません。
- **アクセシビリティが濁ります。** TalkBack と VoiceOver からは、読み上げる内容のない空でないフィールドに見えます。状態を説明可能に保つため、セルごとに明示的な `InputDecoration.labelText` か `Semantics` ラベルを設定してください。
- **自動入力はほぼ機能しません。** `AutofillHints.oneTimeCode` は Android では `AUTOFILL_HINT_SMS_OTP`、iOS では `oneTimeCode`、web では `one-time-code` に対応します。どちらのモバイルプラットフォームも 6 桁のコードを 6 個の独立したフィールドへ分配してはくれません。iOS はフォーカスされたフィールドだけを埋めます。
- **選択位置はユーザーが動かせます。** 長押しやキャレットのドラッグで、カーソルをセンチネルより前へ置けてしまいます。選択位置を固定し直す `onTap` ハンドラーがセルごとに必要です。
- **フォーマッターのリストを更新する必要があります。** `FilteringTextInputFormatter.digitsOnly` はセンチネルを食べてしまいます。`FilteringTextInputFormatter.allow(RegExp('[0-9\u200B]'))` を使ってください。

扱うのが英数字コードなら、ここで止めて次の方法へ進んでください。6 桁の数字 OTP で、すでにこの形が本番で動いているのなら、センチネルは擁護できる選択です。

## 対処 2: 1 個のフィールドと描画した 6 個のセル

より筋のよい答えは、6 フィールドという設計こそが本当のバグだ、というものです。空のセルでの Backspace が問題になるのは、フォーカスが 6 個の入力に分散しているからにすぎません。コード全体を 1 個の `TextField` に保持し、枠は自分で描画すれば、この種の問題は丸ごと消えます。完全に空のコードに対する 1 回を除けば、どの Backspace も `onChanged` を普通に発火させる通常の編集ですし、完全に空のコードに対する Backspace は何もすべきではなく、実際に何も起きません。

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

`enableInteractiveSelection: false` と `showCursor: false` の組み合わせが、選択位置を手作業でやりくりすることなくキャレットを末尾に固定し、そのままでは描画した枠の上に現れてしまう選択ツールバーも取り除いてくれます。アクティブなセルのハイライトが正しく追随するよう、`_focusNode` のリスナーか `Focus` ウィジェットでのラップによって、フォーカス変化時にも再ビルドしてください。

## なぜこちらが出荷すべき形なのか

これは気の利いた小技ではなく、エコシステムが収束した設計です。pub.dev で最も使われている OTP パッケージである `pinput` 6.0.2 は、`lib/src/pinput_state.dart` で単一の `EditableText` を構築し、その周りにセルを描いています。理由はまさに次のとおりです。

- **自動入力が動きます。** `AutofillHints.oneTimeCode` を付けた 1 個のフィールドこそ、iOS の QuickType バーと Android の SMS OTP 自動入力が埋めるように設計された対象です。6 個のフィールドは違います。
- **貼り付けが動きます。** メッセージからコードをコピーしたユーザーが 6 文字を 1 個のフィールドへ貼り付けると、分配ロジックなしで正しく収まります。
- **スクリーンリーダーが動きます。** ラベル付きの 1 個のフィールドと 1 個の値であり、スクリーンリーダーには関係を伝えようがない 6 個のフィールドではありません。
- **状態は 1 本の文字列です。** 同期を取り、破棄し、頭の中で追わなければならないコントローラーの配列が不要になり、ライフサイクル由来のバグ一族がまるごと消えます。6 コントローラー版が後々もたらしがちな代償については、[Flutter でメモリリークを避けるためにコントローラーを破棄する方法](/ja/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) と [Fix: A TextEditingController was used after being disposed in Flutter](/ja/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/) を参照してください。
- **Backspace は特別ではありません。** 文字列が空になるまでは空でない文字列に対する通常の削除であり、空になれば正しく何もしません。

先ほどの `Focus`/`onKeyEvent` ハンドラーを残すのは、物理キーボードもサポートしていて、空のコードで Backspace が押されたときにエラーバナーを消す、ルートを閉じるといった追加の動作をさせたい場合だけにしてください。それはハードウェアキーボードがある場合にだけ動けばよい仕事なので、どの環境でも確実にこなせる唯一の役割です。

## 自分を欺かずにこれをテストする方法

`WidgetTester.sendKeyEvent` は `HardwareKeyboard` 経由でディスパッチします。これは物理キーボードの経路です。これで書いたテストは iOS ターゲットを含めて `Focus`/`onKeyEvent` の実装に対して通ってしまいますが、実機の iPhone 上の実アプリは何もしません。このテストはテストがないより悪いものです。そのアプローチが動きようのないプラットフォームを、まさに合格として認定してしまうからです。

代わりにテキスト入力チャネルを駆動してください。`tester.enterText` は `TextInputConnection.updateEditingValue` を通ります。これは IME が実際に使う経路なので、文字列を短くすることはソフトウェアキーボードの Backspace の忠実なシミュレーションになります。

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

センチネル実装での同等のアサーションは、セル `n` に `''` を入力するとセル `n - 1` がフォーカスされたままになり、両方のセルがちょうど 1 個の `\u200B` を保持している、というものです。これらのテストで他の周辺状態も固定しているなら、[Flutter ウィジェットを固定の時点でテストする方法](/ja/2026/08/how-to-test-a-flutter-widget-at-a-fixed-point-in-time/) が同じ発想を binding のレベルで扱っています。

ここまで読み飛ばしてきた方向けに短くまとめると、欲しいイベントは存在しないので、それを必要としないウィジェットを作りましょう、ということです。

### 次に読む

- [How to dispose controllers in Flutter to avoid memory leaks](/ja/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)
- [Fix: A TextEditingController was used after being disposed in Flutter](/ja/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/)
- [Fix: A RenderFlex overflowed by N pixels on the bottom when the keyboard opens in Flutter](/ja/2026/08/fix-renderflex-overflowed-on-the-bottom-when-the-keyboard-opens-in-flutter/)
- [What is a Flutter Key and when does omitting it cause bugs?](/ja/2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs/)
- [How to test a Flutter widget at a fixed point in time without a withClock closure](/ja/2026/08/how-to-test-a-flutter-widget-at-a-fixed-point-in-time/)

### 参考資料

- [Issue #14809: Detect when delete is typed into a TextField](https://github.com/flutter/flutter/issues/14809), flutter/flutter
- [Issue #50587: How do I listen to backspace/delete key (from the on screen keyboard) on an empty TextField?](https://github.com/flutter/flutter/issues/50587), flutter/flutter
- [Issue #148375: On Android, KeyboardListener catches software keyboard input](https://github.com/flutter/flutter/issues/148375), flutter/flutter
- [`InputConnection.sendKeyEvent`](https://developer.android.com/reference/android/view/inputmethod/InputConnection#sendKeyEvent(android.view.KeyEvent)), Android API リファレンス
- [`UIKeyInput.deleteBackward()`](https://developer.apple.com/documentation/uikit/uikeyinput/deletebackward()), UIKit ドキュメント
- [Migrate RawKeyEvent/RawKeyboard to the KeyEvent/HardwareKeyboard system](https://docs.flutter.dev/release/breaking-changes/key-event-migration), Flutter の破壊的変更
- [`AutofillHints.oneTimeCode`](https://api.flutter.dev/flutter/services/AutofillHints/oneTimeCode-constant.html), Flutter API リファレンス
- [`pinput` 6.0.2](https://pub.dev/packages/pinput), pub.dev
