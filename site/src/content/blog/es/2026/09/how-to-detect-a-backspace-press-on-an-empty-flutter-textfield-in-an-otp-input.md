---
title: "Cómo detectar una pulsación de retroceso en un TextField vacío de Flutter en un campo OTP"
description: "onChanged nunca se dispara porque no ocurre ninguna edición, y en iOS el deleteBackward del engine retorna sin tocar nada cuando el campo está vacío. Dos enfoques que sí funcionan en todas las plataformas: un centinela de ancho cero que garantiza una edición, y un único EditableText detrás de celdas dibujadas. Verificado en Flutter 3.47.2 / Dart 3.13.2."
pubDate: 2026-09-06
template: how-to
tags:
  - "flutter"
  - "dart"
  - "how-to"
  - "textfield"
  - "forms"
lang: "es"
translationOf: "2026/09/how-to-detect-a-backspace-press-on-an-empty-flutter-textfield-in-an-otp-input"
translatedBy: "claude"
translationDate: 2026-09-06
---

No hay ningún callback que se dispare. Si un `TextField` ya está vacío y el usuario toca retroceso en el teclado en pantalla, `onChanged` no se ejecuta, `TextEditingController` no notifica y, en iOS, el engine no envía absolutamente nada al framework. Eso no es un bug de Flutter, es lo que un IME es: una aplicación táctil que emite ediciones de texto, y borrar un campo vacío no produce ninguna edición. Así que la respuesta a "cómo devuelvo el foco a la celda OTP anterior" es dejar de pedir el evento y cambiar los datos. O bien haces que cada celda contenga un carácter centinela invisible para que el retroceso siempre produzca una edición real, o bien abandonas el diseño de seis campos separados y pones un único `EditableText` detrás de seis celdas dibujadas, que es lo que hace [`pinput`](https://pub.dev/packages/pinput) internamente. Todo lo que sigue se escribió y ejecutó contra el canal stable actual, Flutter 3.47.2 con Dart 3.13.2.

## La versión de este widget que todo el mundo escribe primero

Seis controladores, seis nodos de foco, avanzar al escribir, retroceder al borrar. Parece obviamente correcto:

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

Escribe `1 2 3` y el foco cae en la celda cuatro. Pulsa retroceso una vez y la celda tres se vacía y el foco pasa a la celda dos. Pulsa retroceso otra vez y no ocurre nada, nunca. El usuario queda atrapado en una celda que ya está vacía sin forma de volver salvo tocando.

El motivo está a la vista en el código de arriba en cuanto lo buscas. `_onChanged` solo lo llama `TextField` cuando cambia el valor de edición. Borrar nada no cambia nada, así que no hay nada con lo que llamarlo.

## Los teclados en pantalla no tienen tecla de retroceso

El instinto dice que esto es una funcionalidad ausente y que Flutter simplemente debería entregar la pulsación. Greg Spencer, responsable del sistema de eventos de teclado, ha respondido esto varias veces en [flutter/flutter#14809](https://github.com/flutter/flutter/issues/14809), el issue canónico para este widget OTP exacto. Su planteamiento es el que conviene interiorizar. Un teclado en pantalla es un Input Method Editor: una aplicación aparte que toma entrada táctil y produce un flujo de eventos de edición, enviado a tu app por una conexión de edición de texto. "Nunca activa ningún botón del dispositivo", así que de entrada no hay ninguna pulsación de tecla que reenviar.

Un teclado físico levanta un evento de hardware a nivel del sistema operativo y toda app en primer plano lo ve. Un teclado en pantalla dibuja la imagen de una tecla, detecta un toque y llama a una API de edición sobre tu campo de texto. Cuando el campo está vacío no hay ninguna edición que pedir, así que la mayoría de los IME no llaman a nada.

Ese issue se abrió el 2018-02-21 y se cerró el 2021-08-17 con la conclusión de que Flutter no puede arreglarlo. El [issue #50587](https://github.com/flutter/flutter/issues/50587), que hace la misma pregunta en el mismo contexto OTP, se cerró como duplicado suyo. Si estás buscando un issue abierto al que suscribirte, no existe, y es deliberado.

## Qué hace realmente el engine en cada plataforma

La explicación a nivel de framework es correcta pero abstracta, y el comportamiento por plataforma difiere lo suficiente como para que un apaño parezca correcto en un dispositivo y esté muerto en otro. El código fuente del engine lo zanja.

En iOS, `FlutterTextInputView` implementa `UIKeyInput`, así que UIKit llama a `deleteBackward` cuando el usuario toca la tecla de borrado. Esta es la forma de ese método en `shell/platform/darwin/ios/framework/Source/FlutterTextInputPlugin.mm` en el tag 3.47.2:

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

Lee las dos guardas juntas para un campo vacío. `hasText` es false, así que el primer bloque se salta y la selección nunca se ensancha. La selección sigue vacía, así que el segundo bloque se salta y `replaceRange:` nunca se llama. `replaceRange:` es lo que finalmente reporta un nuevo estado de edición por el canal de plataforma, así que absolutamente nada cruza hacia Dart. No hay evento de teclado que interceptar en iOS porque UIKit nunca produjo ninguno, y no hay evento de edición porque el engine se negó correctamente a inventarse uno.

Android es distinto, y de ahí viene la confusión. `InputConnection` permite que un IME elija enviar un `KeyEvent` real en lugar de una llamada de edición, y el `InputConnectionAdaptor` de Flutter lo enruta directamente por la misma tubería que una tecla física:

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

Así que en Android, un IME que llama a `InputConnection.sendKeyEvent` con `KEYCODE_DEL` produce un `KeyDownEvent` genuino en tu árbol de Flutter, con el campo vacío o no. Que lo haga es enteramente decisión del teclado. Los teclados numérico y de símbolos de Gboard históricamente han enviado el evento de tecla; el layout QWERTY estándar históricamente no; el teclado de Samsung, SwiftKey y cada IME de fabricante toman su propia decisión; y un usuario puede instalar lo que quiera. El colaborador de Flutter LongCatIsLooong lo dejó claro en [flutter/flutter#148375](https://github.com/flutter/flutter/issues/148375): un teclado en pantalla puede enviar como evento de tecla de hardware cualquier pulsación que le apetezca, incluida una letra normal, y Flutter no tiene forma de distinguirlas de las reales.

## Por qué la respuesta con KeyboardListener funciona en tu dispositivo de pruebas

La respuesta más votada sobre este tema es interceptar la tecla. En Flutter moderno eso significa un envoltorio `Focus`, ya que `RawKeyboardListener` y `RawKeyEvent` llevan `'This feature was deprecated after v3.18.0-2.0.pre.'` y cualquier fragmento de Stack Overflow que use `event.data.logicalKey` no compilará limpiamente hoy:

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

Esto merece la pena enviarlo a producción, pero solo como complemento. Es la respuesta completa en web, Windows, macOS, Linux y cualquier tablet con teclado conectado, donde los eventos de tecla de hardware siempre llegan. Es cara o cruz en Android según el IME del usuario y el layout de teclado que haya abierto tu `keyboardType`. Está muerto en iOS.

Justin McCandless, del propio equipo de Flutter, publicó la variante con `Shortcuts`/`Actions` en el #14809 en julio de 2021 y luego editó el comentario para empezar con "*Update*: Not fixed, this only works for hardware keyboards." Si el fragmento que encontraste no lleva esa advertencia, se copió de antes de la edición.

## Solución 1: hacer que la celda nunca esté realmente vacía

Si el problema es que borrar nada no produce ninguna edición, dale al teclado algo que borrar. Inicializa cada controlador con un espacio de ancho cero, `U+200B`, que se renderiza como nada y mide cero píxeles. El retroceso sobre una celda visualmente vacía ahora borra un carácter real, `onChanged` se dispara con `''` y ya tienes tu señal.

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

Dos detalles hacen que esto funcione o falle. El cursor debe estar siempre después del centinela, que es por lo que `_setCell` escribe un `TextEditingValue` completo en lugar de asignar `controller.text` (el setter colapsa la selección al offset -1 y deja el IME en un estado raro). Y ya no puedes usar `maxLength: 1`, porque el centinela cuenta para él; limita la longitud dentro de `_onChanged`, como arriba.

## Lo que te cuesta el centinela

Es un apaño, y la factura llega en seis partes.

- **Se rompe la capitalización en iOS.** Un campo cuyo valor empieza con un carácter invisible no está al inicio de una frase en lo que respecta a iOS, así que el teclado deja de ofrecer mayúscula. Reportado en el #14809 por kasyr en agosto de 2021, y confirmado para todos los puntos de código invisibles que probaron, no solo `U+200B`. Irrelevante para OTP numéricos, fatal para códigos alfanuméricos. El apaño en ese hilo es guardar un espacio real y subclasear `TextEditingController` para sobrescribir `buildTextSpan` de modo que el espacio se cambie por uno de ancho cero solo en el momento de pintar.
- **Cada lectura necesita limpieza.** Cualquier ruta de código que toque `controller.text` y olvide `.replaceAll(_zwsp, '')` envía un carácter invisible dentro de tu petición a la API, y no será visible en una línea de log ni en la vista previa de cadena de un depurador.
- **La accesibilidad se enturbia.** TalkBack y VoiceOver ven un campo no vacío sin contenido anunciable. Pon un `InputDecoration.labelText` explícito o una etiqueta `Semantics` por celda para que el estado siga siendo describible.
- **El autocompletado prácticamente no funciona.** `AutofillHints.oneTimeCode` se mapea a `AUTOFILL_HINT_SMS_OTP` en Android, `oneTimeCode` en iOS y `one-time-code` en web. Ninguna de las dos plataformas móviles repartirá un código de seis dígitos entre seis campos separados; iOS rellena solo el campo enfocado.
- **La selección es alcanzable por el usuario.** Una pulsación larga o arrastrar el cursor pueden dejarlo antes del centinela. Necesitas un manejador `onTap` por celda que vuelva a fijar la selección.
- **La lista de formatters hay que actualizarla.** `FilteringTextInputFormatter.digitsOnly` se comerá tu centinela. Usa `FilteringTextInputFormatter.allow(RegExp('[0-9\u200B]'))`.

Si tu producto usa un código alfanumérico, párate aquí y usa el siguiente enfoque. Si es un OTP numérico de seis dígitos y ya lo tienes en producción funcionando, el centinela es defendible.

## Solución 2: un campo, seis celdas dibujadas

La respuesta más limpia es que el diseño de seis campos es el bug de verdad. El retroceso en una celda vacía solo es un problema porque el foco está repartido entre seis entradas. Guarda el código entero en un único `TextField` y dibuja tú las cajas, y toda esta clase de problema desaparece: cada retroceso salvo el que ocurre sobre un código completamente vacío es una edición normal que dispara `onChanged` con normalidad, y un retroceso sobre un código completamente vacío no debería hacer nada, que es exactamente lo que ocurre.

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

`enableInteractiveSelection: false` junto con `showCursor: false` es lo que mantiene el cursor anclado al final sin malabares manuales de selección, y elimina la barra de selección que si no aparecería sobre tus cajas dibujadas. Reconstruye también al cambiar el foco, con un listener sobre `_focusNode` o envolviendo en un widget `Focus`, para que el resaltado de la celda activa siga correctamente.

## Por qué esta es la versión que hay que enviar

Esto no es un truco ingenioso, es el diseño hacia el que convergió el ecosistema. `pinput` 6.0.2, el paquete OTP más usado de pub.dev, construye un único `EditableText` en `lib/src/pinput_state.dart` y pinta sus celdas alrededor, exactamente por estas razones:

- **El autocompletado funciona.** Un campo con `AutofillHints.oneTimeCode` es lo que la barra QuickType de iOS y el autocompletado de OTP por SMS de Android están diseñados para rellenar. Seis campos no.
- **Pegar funciona.** Un usuario que copia un código de un mensaje pega seis caracteres en un campo y aterrizan correctamente, sin lógica de reparto.
- **Los lectores de pantalla funcionan.** Un campo etiquetado con un valor, en lugar de seis campos cuya relación un lector de pantalla no tiene forma de transmitir.
- **El estado es una sola cadena.** Sin un array de controladores que mantener sincronizado, liberar y razonar, lo que elimina toda una familia de errores de ciclo de vida. Mira [cómo liberar controladores en Flutter para evitar fugas de memoria](/es/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) y [Fix: A TextEditingController was used after being disposed in Flutter](/es/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/) para ver lo que la versión de seis controladores suele costarte más adelante.
- **El retroceso no es especial.** Es un borrado corriente contra una cadena no vacía hasta que la cadena queda vacía, y entonces correctamente no hace nada.

Conserva el manejador `Focus`/`onKeyEvent` de antes solo si además das soporte a teclado físico y quieres que ocurra algo extra al pulsar retroceso sobre un código vacío, como limpiar un banner de error o cerrar la ruta. Ese es el único trabajo que puede hacer de forma fiable en todas partes, porque solo tiene que funcionar cuando hay un teclado de hardware presente.

## Cómo probar esto sin autoengañarte

`WidgetTester.sendKeyEvent` despacha a través de `HardwareKeyboard`, que es la ruta del teclado físico. Un test escrito con él pasará contra la implementación con `Focus`/`onKeyEvent`, incluido el target de iOS, mientras que la app real en un iPhone real no hace nada. Ese test es peor que no tener test, porque certifica justo la plataforma donde el enfoque no puede funcionar.

Usa en su lugar el canal de entrada de texto. `tester.enterText` pasa por `TextInputConnection.updateEditingValue`, que es la ruta que realmente usa un IME, así que acortar la cadena es una simulación fiel de un retroceso de teclado en pantalla:

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

Para la implementación con centinela, la aserción equivalente es que introducir `''` en la celda `n` deja enfocada la celda `n - 1` y ambas celdas conteniendo exactamente un `\u200B`. Si en estos tests estás fijando otro estado ambiental, [probar un widget de Flutter en un instante fijo](/es/2026/08/how-to-test-a-flutter-widget-at-a-fixed-point-in-time/) cubre la versión a nivel de binding de la misma idea.

La versión corta, si te saltaste hasta aquí: el evento que quieres no existe, así que construye el widget que no lo necesita.

### Sigue leyendo

- [How to dispose controllers in Flutter to avoid memory leaks](/es/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)
- [Fix: A TextEditingController was used after being disposed in Flutter](/es/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/)
- [Fix: A RenderFlex overflowed by N pixels on the bottom when the keyboard opens in Flutter](/es/2026/08/fix-renderflex-overflowed-on-the-bottom-when-the-keyboard-opens-in-flutter/)
- [What is a Flutter Key and when does omitting it cause bugs?](/es/2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs/)
- [How to test a Flutter widget at a fixed point in time without a withClock closure](/es/2026/08/how-to-test-a-flutter-widget-at-a-fixed-point-in-time/)

### Fuentes

- [Issue #14809: Detect when delete is typed into a TextField](https://github.com/flutter/flutter/issues/14809), flutter/flutter
- [Issue #50587: How do I listen to backspace/delete key (from the on screen keyboard) on an empty TextField?](https://github.com/flutter/flutter/issues/50587), flutter/flutter
- [Issue #148375: On Android, KeyboardListener catches software keyboard input](https://github.com/flutter/flutter/issues/148375), flutter/flutter
- [`InputConnection.sendKeyEvent`](https://developer.android.com/reference/android/view/inputmethod/InputConnection#sendKeyEvent(android.view.KeyEvent)), referencia de la API de Android
- [`UIKeyInput.deleteBackward()`](https://developer.apple.com/documentation/uikit/uikeyinput/deletebackward()), documentación de UIKit
- [Migrate RawKeyEvent/RawKeyboard to the KeyEvent/HardwareKeyboard system](https://docs.flutter.dev/release/breaking-changes/key-event-migration), cambios incompatibles de Flutter
- [`AutofillHints.oneTimeCode`](https://api.flutter.dev/flutter/services/AutofillHints/oneTimeCode-constant.html), referencia de la API de Flutter
- [`pinput` 6.0.2](https://pub.dev/packages/pinput), pub.dev
