---
title: "Correção: A RenderFlex overflowed by N pixels on the bottom quando o teclado abre no Flutter"
description: "O teclado reduz a altura máxima do corpo do Scaffold, então uma Column que mal cabia agora estoura. Envolva o corpo em um scrollable em vez de desligar resizeToAvoidBottomInset."
pubDate: 2026-08-01
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "layout"
  - "keyboard"
lang: "pt-br"
translationOf: "2026/08/fix-renderflex-overflowed-on-the-bottom-when-the-keyboard-opens-in-flutter"
translatedBy: "claude"
translationDate: 2026-08-01
---

Envolva o corpo do `Scaffold` em um `SingleChildScrollView` (ou transforme a `Column` em um `ListView`). O teclado não se sobrepõe ao seu layout, ele o encolhe: o `Scaffold` subtrai `MediaQuery.viewInsets.bottom` da altura máxima que entrega ao corpo, então uma `Column` que preenchia exatamente a tela agora ultrapassa o orçamento pela altura do teclado. Definir `resizeToAvoidBottomInset: false` também silencia a faixa listrada, mas faz isso deixando o teclado cobrir seu campo de texto, o que quase nunca é o que você quer. Este post foi escrito contra o Flutter 3.x (testado no 3.44) e Dart 3.x.

```text
The following assertion was thrown during layout:
A RenderFlex overflowed by 291 pixels on the bottom.

The relevant error-causing widget was:
  Column  Column:file:///Users/me/app/lib/screens/login_screen.dart:37:18

The overflowing RenderFlex has an orientation of Axis.vertical.
The edge of the RenderFlex that is overflowing has been marked in the
rendering with a yellow and black striped pattern.
```

O sinal de que esta é a variante do teclado e não o [estouro genérico de RenderFlex](/pt-br/2026/05/fix-renderflex-overflowed-in-flutter/) é o momento: o layout está limpo até você tocar em um `TextField`, o número do estouro é suspeitosamente próximo da altura do teclado (250 a 350 pixels lógicos na maioria dos celulares) e ele some assim que você fecha o teclado.

## Por que o teclado encolhe o corpo em vez de cobri-lo

No Android, o template de projeto do Flutter define `android:windowSoftInputMode="adjustResize"` na `MainActivity`, então a plataforma redimensiona a view do Flutter em vez de deslocá-la. O engine reporta a região coberta para o Dart como `MediaQueryData.viewInsets`, que a documentação da API define com precisão: quando o teclado de um dispositivo móvel está visível, `viewInsets.bottom` corresponde ao topo do teclado.

Em seguida o `Scaffold` faz a aritmética. Em `_ScaffoldState.build` ele calcula os insets mínimos que precisa manter livres:

```dart
// packages/flutter/lib/src/material/scaffold.dart, Flutter 3.x
final EdgeInsets minInsets = MediaQuery.paddingOf(
  context,
).copyWith(bottom: _resizeToAvoidBottomInset ? MediaQuery.viewInsetsOf(context).bottom : 0.0);
```

e em `_ScaffoldLayout.performLayout` ele transforma isso no orçamento de altura do corpo:

```dart
// packages/flutter/lib/src/material/scaffold.dart, Flutter 3.x
final double contentBottom = math.max(
  0.0,
  bottom - math.max(minInsets.bottom, bottomWidgetsHeight),
);

if (hasChild(_ScaffoldSlot.body)) {
  double bodyMaxHeight = math.max(0.0, contentBottom - contentTop);
  // ...
```

`_resizeToAvoidBottomInset` é `widget.resizeToAvoidBottomInset ?? true`, então este é o caminho padrão. Em uma tela de 852 pixels de altura com uma app bar de 56 pixels e um teclado de 291 pixels, o `maxHeight` do corpo cai de 796 para 505. Sua `Column` continua querendo 796. O `RenderFlex` não recorta e não rola, então ele pinta o aviso listrado e reporta a diferença, que é exatamente os 291 pixels da mensagem. O número é a altura do teclado porque antes o layout cabia sem nenhuma folga.

## Uma reprodução que cabe em uma tela e depois não cabe mais

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
import 'package:flutter/material.dart';

void main() => runApp(const MaterialApp(home: LoginScreen()));

class LoginScreen extends StatelessWidget {
  const LoginScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Sign in')),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            const FlutterLogo(size: 160),
            const TextField(decoration: InputDecoration(labelText: 'Email')),
            const TextField(
              obscureText: true,
              decoration: InputDecoration(labelText: 'Password'),
            ),
            FilledButton(onPressed: () {}, child: const Text('Sign in')),
          ],
        ),
      ),
    );
  }
}
```

Isso renderiza perfeitamente. Toque em qualquer um dos campos e o estouro aparece. Nada mudou na árvore de widgets; só o `maxHeight` que chega mudou.

## As correções, na ordem em que você deve tentá-las

### 1. Torne o corpo rolável

Esta é a correção certa para praticamente qualquer formulário, e é o que a [documentação de erros comuns do Flutter](https://docs.flutter.dev/testing/common-errors) recomenda para um estouro na parte de baixo. Um viewport dá ao seu filho espaço ilimitado no eixo principal, então a `Column` para de se importar com o que o teclado fez com o `Scaffold`:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
body: SingleChildScrollView(
  padding: const EdgeInsets.all(24),
  child: Column(
    children: [
      const FlutterLogo(size: 160),
      const SizedBox(height: 24),
      const TextField(decoration: InputDecoration(labelText: 'Email')),
      const SizedBox(height: 12),
      const TextField(
        obscureText: true,
        decoration: InputDecoration(labelText: 'Password'),
      ),
      const SizedBox(height: 24),
      FilledButton(onPressed: () {}, child: const Text('Sign in')),
    ],
  ),
),
```

Já que você está mexendo aí, mude mais duas coisas. Remova `mainAxisAlignment: MainAxisAlignment.spaceBetween`: dentro de um viewport o espaço disponível é infinito, então o alinhamento no eixo principal não tem nada para distribuir e silenciosamente não faz nada. Substitua o espaçamento por `SizedBox` explícitos. E se a lista for longa ou construída a partir de dados, use `ListView` ou `ListView.builder` para que os filhos sejam construídos sob demanda; as trocas são as mesmas cobertas em [shrinkWrap vs Expanded vs slivers para listas longas](/pt-br/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/).

Essa correção vem com um bônus: o `EditableText` rola o campo focado até ele ficar visível através do `Scrollable` ancestral mais próximo, com o espaçamento de `TextField.scrollPadding`, cujo padrão é `EdgeInsets.all(20.0)`. Sem um ancestral rolável não há nada para rolar, e é por isso que às vezes o campo embaixo do seu dedo continua escondido mesmo quando o estouro não está visível.

### 2. Preencher a tela quando há espaço e rolar quando não há

A correção com scroll view tem um custo estético: em uma tela alta com o teclado fechado, o conteúdo se amontoa no topo em vez de se distribuir. O padrão da [documentação da API do SingleChildScrollView](https://api.flutter.dev/flutter/widgets/SingleChildScrollView-class.html) resolve isso dando à `Column` uma altura mínima igual à do viewport e forçando-a a ter exatamente a altura do seu conteúdo quando ele for maior:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
body: LayoutBuilder(
  builder: (context, viewportConstraints) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: ConstrainedBox(
        constraints: BoxConstraints(minHeight: viewportConstraints.maxHeight - 48),
        child: IntrinsicHeight(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: const [
              FlutterLogo(size: 160),
              TextField(decoration: InputDecoration(labelText: 'Email')),
              TextField(
                obscureText: true,
                decoration: InputDecoration(labelText: 'Password'),
              ),
            ],
          ),
        ),
      ),
    );
  },
),
```

Os dois wrappers são essenciais. Sem o `ConstrainedBox` a coluna se ajusta ao conteúdo e nunca preenche uma tela alta; sem o `IntrinsicHeight` ela assume a altura mínima mesmo quando os filhos precisam de mais, e você volta ao estouro. O `LayoutBuilder` enxerga as restrições pós-teclado porque fica dentro do slot do corpo, então `viewportConstraints.maxHeight` já vem com o teclado subtraído.

A documentação é direta sobre o custo: isso faz o layout da subárvore duas vezes, uma para os valores intrínsecos e outra de verdade. Tudo bem para um formulário de login, ruim para uma tela de configurações com cinquenta linhas.

### 3. Use SliverFillRemaining em vez de IntrinsicHeight

Se a passada de intrínsecos aparecer nos seus tempos de frame, expresse a mesma intenção com slivers. `SliverFillRemaining(hasScrollBody: false)` deixa o filho preencher o restante do viewport e, pelo contrato da API, se a extensão do filho exceder o viewport o sliver cede ao tamanho do filho em vez de sobrescrevê-lo, que é exatamente o comportamento desejado quando o teclado chega:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
body: CustomScrollView(
  slivers: [
    SliverFillRemaining(
      hasScrollBody: false,
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: const [
            FlutterLogo(size: 160),
            TextField(decoration: InputDecoration(labelText: 'Email')),
            TextField(
              obscureText: true,
              decoration: InputDecoration(labelText: 'Password'),
            ),
          ],
        ),
      ),
    ),
  ],
),
```

Uma regra para lembrar aqui: tudo que estiver diretamente sob `CustomScrollView.slivers` precisa ser um sliver. Colocar uma `Column` ali sem envolvê-la produz [RenderViewport expected a RenderSliver child](/pt-br/2026/07/fix-renderviewport-expected-a-rendersliver-in-a-flutter-customscrollview/).

### 4. resizeToAvoidBottomInset: false, e só de propósito

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
Scaffold(
  resizeToAvoidBottomInset: false,
  body: /* ... */,
)
```

Releia o código-fonte acima: isso define `minInsets.bottom` como `0.0`, o corpo mantém a altura total e o teclado é pintado por cima do que estiver lá embaixo. Nada é corrigido, o aviso de estouro apenas fica sem nada sobre o que avisar. É legítimo em uma tela cujo campo de entrada fica no terço superior, em um mapa ou visualização de câmera em tela cheia onde redimensionar seria desagradável, ou em uma tela de chat onde você mesmo controla o inset. É a resposta errada para um formulário, porque o campo em que o usuário está digitando é justamente o que vai parar atrás do teclado.

## Detalhes que fazem as pessoas andarem em círculos

**`viewInsets.bottom` vale `0` dentro do corpo do Scaffold.** Esta é a parte mais confusa de todo o assunto. O `Scaffold` passa ao corpo um `MediaQuery` modificado:

```dart
// packages/flutter/lib/src/material/scaffold.dart, Flutter 3.x
if (removeBottomInset) {
  data = data.removeViewInsets(removeBottom: true);
}
```

e o slot do corpo é registrado com `removeBottomInset: _resizeToAvoidBottomInset`. Então, com a configuração padrão, um widget dentro de `Scaffold.body` que leia `MediaQuery.viewInsetsOf(context).bottom` recebe `0.0` mesmo com o teclado aberto, porque o `Scaffold` já consumiu esse inset encolhendo o corpo. Adicionar manualmente `Padding(padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom))` ali dentro não faz nada. Para ler o valor real, leia acima do `Scaffold`, ou defina `resizeToAvoidBottomInset: false` e assuma o controle do inset.

**Modal bottom sheets são a exceção.** Uma rota de `showModalBottomSheet` não é o corpo de um `Scaffold`, então lá o `viewInsets` está intacto e o truque do padding é a correção certa. Combine com `isScrollControlled: true`, senão a sheet fica limitada a metade da tela:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
showModalBottomSheet(
  context: context,
  isScrollControlled: true,
  builder: (context) => Padding(
    padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
    child: const ComposeForm(),
  ),
);
```

**Um bottomNavigationBar não se soma ao teclado.** `contentBottom` usa `math.max(minInsets.bottom, bottomWidgetsHeight)`, não a soma. Assim que o teclado fica mais alto que a barra de navegação, o corpo encolhe apenas pela altura do teclado, e a barra mantém seu lugar no fundo do scaffold, embaixo do teclado. Se você quer que ela suma enquanto o usuário digita, esconda-a você mesmo: leia `MediaQuery.viewInsetsOf(context).bottom` de um `Builder` colocado acima do `Scaffold` e passe `bottomNavigationBar: inset > 0 ? null : const MyNavBar()`.

**Alguém mudou `windowSoftInputMode` para `adjustPan`.** Se o estouro nunca aparece no Android mas o campo fica coberto, ou `viewInsets.bottom` fica em `0` para sempre, verifique `android/app/src/main/AndroidManifest.xml`. O template do Flutter traz `android:windowSoftInputMode="adjustResize"`; em algum momento uma resposta do Stack Overflow convenceu alguém a usar `adjustPan`, e agora a plataforma está deslocando a janela em vez de reportar um inset.

**Envolver o culpado em `Expanded` é o reflexo errado aqui.** `Expanded` é a correção para o caso horizontal em que um filho guloso devora uma `Row`. No caso do teclado todos os filhos já estão no tamanho natural e o total simplesmente excede o orçamento, então o `Expanded` ou rouba espaço de um widget que precisava dele ou move o estouro para um irmão. E um `Expanded` que acaba fora de um `Flex` te dá [Incorrect use of ParentDataWidget](/pt-br/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/) no lugar.

**Feche o teclado ao arrastar.** Depois que o corpo passa a rolar, adicione `keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag` ao scroll view. Custa uma linha e elimina a reclamação mais comum sobre telas de formulário.

**Erros parecidos.** `Vertical viewport was given unbounded height` é a imagem espelhada, um rolável dentro de um pai sem limites, coberto em [aninhar um ListView dentro de uma Column](/pt-br/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/). `RenderBox was not laid out` costuma ser a segunda exceção depois de uma falha real de layout; suba até a primeira. E se o estouro aparece com escala de texto de 1,5x em vez de quando o teclado abre, é o mesmo tipo de bug com outro gatilho, que o [post geral sobre estouro de RenderFlex](/pt-br/2026/05/fix-renderflex-overflowed-in-flutter/) cobre em detalhe.

## Relacionados

- [Correção: A RenderFlex overflowed by N pixels no Flutter](/pt-br/2026/05/fix-renderflex-overflowed-in-flutter/) é o post pai para as variantes horizontal e de escala de texto da mesma asserção.
- [Como aninhar um ListView dentro de uma Column sem o erro de altura sem limites](/pt-br/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/) trata do caso em que o próprio formulário contém uma lista.
- [shrinkWrap vs Expanded vs slivers para listas longas no Flutter](/pt-br/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/) explica por que `ListView.builder` ganha de um `SingleChildScrollView` quando o conteúdo cresce.
- [Correção: RenderViewport expected a RenderSliver child](/pt-br/2026/07/fix-renderviewport-expected-a-rendersliver-in-a-flutter-customscrollview/) é o erro que espera por você se seguir o caminho dos slivers.
- [Correção: Incorrect use of ParentDataWidget, Expanded precisa estar dentro de Flex](/pt-br/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/) cobre o modo de falha de recorrer a `Expanded` cedo demais.

## Fontes

- [Common Flutter errors](https://docs.flutter.dev/testing/common-errors), a página oficial que define a asserção de estouro do RenderFlex e suas correções canônicas.
- [Scaffold.resizeToAvoidBottomInset](https://api.flutter.dev/flutter/material/Scaffold/resizeToAvoidBottomInset.html), que documenta o padrão `true` e sua dependência de `MediaQueryData.viewInsets`.
- [MediaQueryData.viewInsets](https://api.flutter.dev/flutter/widgets/MediaQueryData/viewInsets.html), origem da definição "viewInsets.bottom corresponde ao topo do teclado" e da separação em relação a `padding` e `viewPadding`.
- [scaffold.dart no branch stable](https://github.com/flutter/flutter/blob/stable/packages/flutter/lib/src/material/scaffold.dart), onde vivem `minInsets`, `contentBottom` e a chamada de `removeViewInsets` do corpo.
- [Referência da classe SingleChildScrollView](https://api.flutter.dev/flutter/widgets/SingleChildScrollView-class.html), que documenta a receita de `LayoutBuilder` mais `ConstrainedBox` mais `IntrinsicHeight` e seu custo.
- [Referência da classe SliverFillRemaining](https://api.flutter.dev/flutter/widgets/SliverFillRemaining-class.html), para a semântica exata de `hasScrollBody: false`.
- [EditableText.scrollPadding](https://api.flutter.dev/flutter/widgets/EditableText/scrollPadding.html), que explica o comportamento automático de rolar até ficar visível e seu padrão `EdgeInsets.all(20.0)`.
