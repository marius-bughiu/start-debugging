---
title: "Como detectar o backspace em um TextField vazio do Flutter em um campo OTP"
description: "onChanged nunca dispara porque nenhuma edição acontece, e no iOS o deleteBackward do engine retorna sem tocar em nada quando o campo está vazio. Duas abordagens que realmente funcionam em todas as plataformas: uma sentinela de largura zero que garante uma edição, e um único EditableText atrás de células desenhadas. Verificado no Flutter 3.47.2 / Dart 3.13.2."
pubDate: 2026-09-06
template: how-to
tags:
  - "flutter"
  - "dart"
  - "how-to"
  - "textfield"
  - "forms"
lang: "pt-br"
translationOf: "2026/09/how-to-detect-a-backspace-press-on-an-empty-flutter-textfield-in-an-otp-input"
translatedBy: "claude"
translationDate: 2026-09-06
---

Não existe callback que dispare. Se um `TextField` já está vazio e o usuário toca em backspace no teclado virtual, `onChanged` não roda, `TextEditingController` não notifica e, no iOS, o engine não envia absolutamente nada ao framework. Isso não é um bug do Flutter, é o que um IME é: um aplicativo de toque que emite edições de texto, e apagar um campo vazio não produz edição nenhuma. Então a resposta para "como devolvo o foco para a célula OTP anterior" é parar de pedir o evento e mudar os dados. Ou você mantém em cada célula um caractere sentinela invisível para que o backspace sempre produza uma edição real, ou abandona o desenho de seis campos separados e coloca um único `EditableText` atrás de seis células desenhadas, que é o que o [`pinput`](https://pub.dev/packages/pinput) faz internamente. Tudo abaixo foi escrito e executado contra o canal stable atual, Flutter 3.47.2 com Dart 3.13.2.

## A versão desse widget que todo mundo escreve primeiro

Seis controllers, seis focus nodes, avançar ao digitar, voltar ao apagar. Parece obviamente correto:

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

Digite `1 2 3` e o foco cai na célula quatro. Aperte backspace uma vez e a célula três esvazia e o foco vai para a célula dois. Aperte backspace de novo e nada acontece, nunca. O usuário fica preso em uma célula que já está vazia sem forma de voltar a não ser tocando.

O motivo está visível no código acima assim que você procura por ele. `_onChanged` só é chamado pelo `TextField` quando o valor de edição muda. Apagar nada não muda nada, então não há nada com que chamá-lo.

## Teclados virtuais não têm tecla de backspace

O instinto diz que isso é um recurso faltando e que o Flutter deveria simplesmente entregar a tecla pressionada. Greg Spencer, dono do sistema de eventos de teclado, respondeu isso várias vezes na [flutter/flutter#14809](https://github.com/flutter/flutter/issues/14809), a issue canônica para esse widget OTP exato. A forma como ele coloca é a que vale internalizar. Um teclado virtual é um Input Method Editor: um aplicativo separado que recebe entrada por toque e produz um fluxo de eventos de edição, enviado ao seu app por uma conexão de edição de texto. Ele "nunca aciona nenhum botão do dispositivo", então de saída não existe tecla pressionada para repassar.

Um teclado físico levanta um evento de hardware no nível do sistema operacional e todo app em primeiro plano o enxerga. Um teclado virtual desenha a figura de uma tecla, percebe um toque e chama uma API de edição no seu campo de texto. Quando o campo está vazio não há edição a pedir, então a maioria dos IMEs não chama nada.

Essa issue foi aberta em 2018-02-21 e fechada em 2021-08-17 com a conclusão de que o Flutter não pode corrigi-la. A [issue #50587](https://github.com/flutter/flutter/issues/50587), que faz a mesma pergunta no mesmo contexto de OTP, foi fechada como duplicata dela. Se você está procurando uma issue aberta para acompanhar, ela não existe, e isso é proposital.

## O que o engine realmente faz em cada plataforma

A explicação no nível do framework é correta mas abstrata, e o comportamento por plataforma difere o bastante para que uma gambiarra pareça certa em um aparelho e esteja morta em outro. O código-fonte do engine resolve a questão.

No iOS, `FlutterTextInputView` implementa `UIKeyInput`, então o UIKit chama `deleteBackward` quando o usuário toca na tecla de apagar. Este é o formato desse método em `shell/platform/darwin/ios/framework/Source/FlutterTextInputPlugin.mm` na tag 3.47.2:

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

Leia as duas guardas juntas para um campo vazio. `hasText` é false, então o primeiro bloco é pulado e a seleção nunca é alargada. A seleção continua vazia, então o segundo bloco é pulado e `replaceRange:` nunca é chamado. `replaceRange:` é o que acaba reportando um novo estado de edição pelo canal de plataforma, então absolutamente nada atravessa para o Dart. Não há evento de teclado para interceptar no iOS porque o UIKit nunca produziu um, e não há evento de edição porque o engine corretamente se recusou a inventar um.

O Android é diferente, e é daí que vem a confusão. `InputConnection` permite que um IME escolha enviar um `KeyEvent` de verdade em vez de uma chamada de edição, e o `InputConnectionAdaptor` do Flutter o encaminha direto pelo mesmo pipeline de uma tecla física:

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

Então no Android, um IME que chama `InputConnection.sendKeyEvent` com `KEYCODE_DEL` produz um `KeyDownEvent` genuíno na sua árvore Flutter, com o campo vazio ou não. Se ele faz isso é inteiramente decisão do teclado. Os teclados numérico e de símbolos do Gboard historicamente enviaram o evento de tecla; o layout QWERTY padrão historicamente não; o teclado da Samsung, o SwiftKey e cada IME de fabricante tomam a própria decisão; e o usuário pode instalar qualquer coisa. O colaborador do Flutter LongCatIsLooong colocou o ponto de forma direta na [flutter/flutter#148375](https://github.com/flutter/flutter/issues/148375): um teclado virtual pode enviar como evento de tecla de hardware qualquer tecla que quiser, inclusive uma letra comum, e o Flutter não tem como distingui-las das reais.

## Por que a resposta com KeyboardListener funciona no seu aparelho de teste

A resposta mais votada sobre esse tema é interceptar a tecla. No Flutter moderno isso significa um wrapper `Focus`, já que `RawKeyboardListener` e `RawKeyEvent` carregam `'This feature was deprecated after v3.18.0-2.0.pre.'` e qualquer trecho do Stack Overflow que use `event.data.logicalKey` não compila limpo hoje:

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

Isso vale a pena colocar em produção, mas só como complemento. É a resposta inteira na web, no Windows, no macOS, no Linux e em qualquer tablet com teclado acoplado, onde eventos de tecla de hardware sempre chegam. É cara ou coroa no Android, dependendo do IME do usuário e do layout que seu `keyboardType` abriu. Está morto no iOS.

Justin McCandless, do próprio time do Flutter, publicou a variante com `Shortcuts`/`Actions` na #14809 em julho de 2021 e depois editou o comentário para começar com "*Update*: Not fixed, this only works for hardware keyboards." Se o trecho que você encontrou não traz essa ressalva, ele foi copiado de antes da edição.

## Correção 1: fazer a célula nunca estar realmente vazia

Se o problema é que apagar nada não produz edição, dê ao teclado algo para apagar. Inicialize cada controller com um espaço de largura zero, `U+200B`, que renderiza como nada e mede zero pixels. O backspace em uma célula visualmente vazia agora apaga um caractere real, `onChanged` dispara com `''` e você tem o seu sinal.

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

Dois detalhes fazem isso funcionar ou quebrar. O cursor precisa estar sempre depois da sentinela, e é por isso que `_setCell` escreve um `TextEditingValue` inteiro em vez de atribuir `controller.text` (o setter colapsa a seleção para o offset -1 e deixa o IME em um estado estranho). E você não pode mais usar `maxLength: 1`, porque a sentinela conta para ele; limite o tamanho dentro de `_onChanged`, como acima.

## O que a sentinela custa

É uma gambiarra, e a conta chega em seis partes.

- **A capitalização no iOS quebra.** Um campo cujo valor começa com um caractere invisível não está no início de uma frase no que diz respeito ao iOS, então o teclado para de oferecer letra maiúscula. Reportado na #14809 por kasyr em agosto de 2021, e confirmado para todos os code points invisíveis testados, não só `U+200B`. Irrelevante para OTPs numéricos, fatal para códigos alfanuméricos. A gambiarra daquela thread é guardar um espaço real e estender `TextEditingController` para sobrescrever `buildTextSpan` de modo que o espaço seja trocado por um de largura zero apenas na hora de pintar.
- **Toda leitura precisa de limpeza.** Qualquer caminho de código que toque `controller.text` e esqueça `.replaceAll(_zwsp, '')` manda um caractere invisível dentro da sua requisição de API, e ele não vai aparecer em uma linha de log nem no preview de string de um depurador.
- **A acessibilidade fica turva.** TalkBack e VoiceOver veem um campo não vazio sem conteúdo anunciável. Defina um `InputDecoration.labelText` explícito ou um rótulo `Semantics` por célula para que o estado continue descritível.
- **O preenchimento automático praticamente não funciona.** `AutofillHints.oneTimeCode` mapeia para `AUTOFILL_HINT_SMS_OTP` no Android, `oneTimeCode` no iOS e `one-time-code` na web. Nenhuma das duas plataformas móveis vai espalhar um código de seis dígitos por seis campos separados; o iOS preenche só o campo focado.
- **A seleção é alcançável pelo usuário.** Um toque longo ou arrastar o cursor podem deixá-lo antes da sentinela. Você precisa de um handler `onTap` por célula que refixe a seleção.
- **A lista de formatters precisa mudar.** `FilteringTextInputFormatter.digitsOnly` vai comer sua sentinela. Use `FilteringTextInputFormatter.allow(RegExp('[0-9\u200B]'))`.

Se o seu produto usa um código alfanumérico, pare aqui e use a próxima abordagem. Se é um OTP numérico de seis dígitos e você já tem isso em produção funcionando, a sentinela é defensável.

## Correção 2: um campo, seis células desenhadas

A resposta mais limpa é que o desenho de seis campos é o bug de verdade. O backspace em uma célula vazia só é problema porque o foco está espalhado por seis inputs. Guarde o código inteiro em um único `TextField` e desenhe as caixas você mesmo, e toda essa classe de problema some: todo backspace, exceto o que ocorre sobre um código completamente vazio, é uma edição normal que dispara `onChanged` normalmente, e um backspace sobre um código completamente vazio deve não fazer nada, que é exatamente o que acontece.

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

`enableInteractiveSelection: false` junto com `showCursor: false` é o que mantém o cursor preso no fim sem malabarismo manual de seleção, e remove a barra de seleção que apareceria por cima das suas caixas desenhadas. Reconstrua também na mudança de foco, com um listener em `_focusNode` ou envolvendo em um widget `Focus`, para que o destaque da célula ativa acompanhe corretamente.

## Por que essa é a versão para colocar em produção

Isso não é um truque esperto, é o desenho para o qual o ecossistema convergiu. O `pinput` 6.0.2, o pacote de OTP mais usado do pub.dev, constrói um único `EditableText` em `lib/src/pinput_state.dart` e pinta as células ao redor dele, exatamente por essas razões:

- **O preenchimento automático funciona.** Um campo com `AutofillHints.oneTimeCode` é o que a barra QuickType do iOS e o preenchimento de OTP por SMS do Android foram feitos para preencher. Seis campos não.
- **Colar funciona.** Um usuário que copia um código de uma mensagem cola seis caracteres em um campo e eles caem corretamente, sem lógica de distribuição.
- **Leitores de tela funcionam.** Um campo rotulado com um valor, em vez de seis campos cuja relação um leitor de tela não tem como transmitir.
- **O estado é uma string só.** Sem array de controllers para manter sincronizado, liberar e raciocinar sobre, o que remove uma família inteira de erros de ciclo de vida. Veja [como liberar controllers no Flutter para evitar vazamentos de memória](/pt-br/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) e [Fix: A TextEditingController was used after being disposed in Flutter](/pt-br/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/) para o que a versão de seis controllers costuma custar depois.
- **O backspace não é especial.** É um delete comum contra uma string não vazia até a string ficar vazia, e aí ele corretamente não faz nada.

Mantenha o handler `Focus`/`onKeyEvent` de antes só se você também dá suporte a teclado físico e quer que algo extra aconteça no backspace sobre um código vazio, como limpar um banner de erro ou fechar a rota. Esse é o único trabalho que ele faz de forma confiável em todo lugar, porque só precisa funcionar quando há um teclado de hardware presente.

## Como testar isso sem se enganar

`WidgetTester.sendKeyEvent` despacha através de `HardwareKeyboard`, que é o caminho do teclado físico. Um teste escrito com ele vai passar contra a implementação com `Focus`/`onKeyEvent`, inclusive no target iOS, enquanto o app real em um iPhone real não faz nada. Esse teste é pior que nenhum teste, porque certifica justamente a plataforma onde a abordagem não pode funcionar.

Use o canal de entrada de texto no lugar. `tester.enterText` passa por `TextInputConnection.updateEditingValue`, que é o caminho que um IME de fato usa, então encurtar a string é uma simulação fiel de um backspace de teclado virtual:

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

Para a implementação com sentinela, a asserção equivalente é que digitar `''` na célula `n` deixa a célula `n - 1` focada e ambas as células contendo exatamente um `\u200B`. Se você está fixando outro estado ambiente nesses testes, [testar um widget Flutter em um instante fixo](/pt-br/2026/08/how-to-test-a-flutter-widget-at-a-fixed-point-in-time/) cobre a versão no nível do binding da mesma ideia.

A versão curta, se você pulou até aqui: o evento que você quer não existe, então construa o widget que não precisa dele.

### Leia a seguir

- [How to dispose controllers in Flutter to avoid memory leaks](/pt-br/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)
- [Fix: A TextEditingController was used after being disposed in Flutter](/pt-br/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/)
- [Fix: A RenderFlex overflowed by N pixels on the bottom when the keyboard opens in Flutter](/pt-br/2026/08/fix-renderflex-overflowed-on-the-bottom-when-the-keyboard-opens-in-flutter/)
- [What is a Flutter Key and when does omitting it cause bugs?](/pt-br/2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs/)
- [How to test a Flutter widget at a fixed point in time without a withClock closure](/pt-br/2026/08/how-to-test-a-flutter-widget-at-a-fixed-point-in-time/)

### Fontes

- [Issue #14809: Detect when delete is typed into a TextField](https://github.com/flutter/flutter/issues/14809), flutter/flutter
- [Issue #50587: How do I listen to backspace/delete key (from the on screen keyboard) on an empty TextField?](https://github.com/flutter/flutter/issues/50587), flutter/flutter
- [Issue #148375: On Android, KeyboardListener catches software keyboard input](https://github.com/flutter/flutter/issues/148375), flutter/flutter
- [`InputConnection.sendKeyEvent`](https://developer.android.com/reference/android/view/inputmethod/InputConnection#sendKeyEvent(android.view.KeyEvent)), referência da API do Android
- [`UIKeyInput.deleteBackward()`](https://developer.apple.com/documentation/uikit/uikeyinput/deletebackward()), documentação do UIKit
- [Migrate RawKeyEvent/RawKeyboard to the KeyEvent/HardwareKeyboard system](https://docs.flutter.dev/release/breaking-changes/key-event-migration), mudanças incompatíveis do Flutter
- [`AutofillHints.oneTimeCode`](https://api.flutter.dev/flutter/services/AutofillHints/oneTimeCode-constant.html), referência da API do Flutter
- [`pinput` 6.0.2](https://pub.dev/packages/pinput), pub.dev
