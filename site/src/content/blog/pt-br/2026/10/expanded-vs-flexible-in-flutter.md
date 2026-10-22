---
title: "Expanded vs Flexible no Flutter: FlexFit.tight vs FlexFit.loose explicado"
description: "Use Expanded quando um filho precisa ocupar sua parte de um Row ou Column, e Flexible quando ele pode ser menor que sua parte. Layouts medidos no Flutter 3.44 mostram para onde vai o espaço que sobra, por que filhos loose nunca o doam aos irmãos e quando só Flexible sobrevive a constraints ilimitadas."
pubDate: 2026-10-22
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "layout"
  - "constraints"
lang: "pt-br"
translationOf: "2026/10/expanded-vs-flexible-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-22
---

**Resposta curta:** `Expanded` é literalmente `Flexible(fit: FlexFit.tight)`. Use `Expanded` quando o filho precisa ocupar sua parte do `Row` ou `Column` (listas, painéis, qualquer coisa com fundo). Use `Flexible` (o padrão `FlexFit.loose`) quando o filho pode ser menor que sua parte, o caso clássico sendo um `Text` que deve ser truncado quando longo, mas se ajustar ao conteúdo quando curto. Ambos recebem o mesmo tamanho máximo; só `Expanded` obriga o filho a ter esse tamanho. Tudo abaixo foi medido com `flutter test` no Flutter 3.44.8 / Dart 3.12.2.

A confusão é compreensível, porque nos layouts mais comuns os dois parecem idênticos. Um `ListView` ou um `Container` sem filho quer todo o espaço que conseguir, então envolvê-lo em qualquer um dos widgets produz os mesmos pixels. A diferença só aparece quando o filho está satisfeito sendo pequeno, e é exatamente aí que surgem um chip esticado, um ícone empurrado para a borda de uma linha ou um vazio que você não consegue explicar.

## A comparação em resumo

| Comportamento (Flutter 3.44)                                | `Expanded`                         | `Flexible` (padrão)                    |
| ----------------------------------------------------------- | ---------------------------------- | -------------------------------------- |
| Fit                                                         | `FlexFit.tight`                    | `FlexFit.loose`                        |
| Constraint passada no eixo principal                        | min = max = parte                  | min = 0, max = parte                   |
| Filho menor que sua parte                                   | esticado até a parte               | mantém o próprio tamanho               |
| Parte não utilizada                                         | nenhuma                            | vira espaço livre, não é dada aos irmãos |
| `mainAxisAlignment` tem algum efeito                        | não (não sobra espaço livre)       | sim                                    |
| `Row(mainAxisSize: MainAxisSize.min)` encolhe               | não, a linha ocupa a largura toda  | sim                                    |
| Dentro de um eixo principal ilimitado (scroll view)         | sempre uma assertion               | permitido com `mainAxisSize: MainAxisSize.min` |
| `fit` configurável                                          | não                                | sim                                    |

Se você lembrar de apenas uma linha, lembre da terceira: tight estica, loose não.

## O que o framework realmente faz com os dois fits

O código-fonte é curto o bastante para ser citado. Em `packages/flutter/lib/src/widgets/basic.dart` na 3.44.8:

```dart
// Flutter 3.44.8, widgets/basic.dart
class Flexible extends ParentDataWidget<FlexParentData> {
  const Flexible({super.key, this.flex = 1, this.fit = FlexFit.loose, required super.child});
  // ...
}

class Expanded extends Flexible {
  const Expanded({super.key, super.flex, required super.child}) : super(fit: FlexFit.tight);
}
```

Nenhum dos widgets faz layout de nada. São `ParentDataWidget`s que gravam `flex` e `fit` no `FlexParentData` do filho, que o `RenderFlex` (o render object por trás de `Row`, `Column` e `Flex`) lê durante o layout. É também por isso que ambos lançam o mesmo erro "must be placed inside Flex widgets" quando você os coloca sob um pai que não é flex.

`RenderFlex._computeSizes` em `rendering/flex.dart` roda em duas passadas:

1. Faz o layout de todo filho com `flex == 0` (widgets comuns) usando seu tamanho natural e soma suas extensões no eixo principal.
2. Calcula `spacePerFlex = (maxMainSize - usedByNonFlexChildren) / totalFlex` **uma única vez**, depois faz o layout de cada filho flex com um máximo de `spacePerFlex * flex`. Para `FlexFit.tight`, o mínimo é igual a esse máximo. Para `FlexFit.loose`, o mínimo é `0`.

O detalhe que importa é "uma única vez". A parte de cada um é decidida antes de qualquer filho flexível ser medido. Se um filho loose usa menos que sua parte, o restante não é entregue aos irmãos. Ele vira espaço livre para o `mainAxisAlignment`, que é a origem da maioria das perguntas do tipo "por que há um vazio".

## Medido: o mesmo filho sob os dois fits

Todos os números abaixo vêm de testes de widget que fixam o `Row` em uma caixa de 400 pixels lógicos de largura e leem de volta `tester.getSize` e `tester.getTopLeft`. Aqui estão o harness e o primeiro caso:

```dart
// Flutter 3.44.8, Dart 3.12.2, flutter_test
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget host(Widget child) => Directionality(
      textDirection: TextDirection.ltr,
      child: Align(
        alignment: Alignment.topLeft,
        child: SizedBox(width: 400, height: 100, child: child),
      ),
    );

const a = Key('a'), b = Key('b');

void main() {
  testWidgets('tight vs loose with a small child', (t) async {
    await t.pumpWidget(host(Row(children: [
      Expanded(child: SizedBox(key: a, width: 50, height: 10)),
      Flexible(child: SizedBox(key: b, width: 50, height: 10)),
    ])));
    print('Expanded=${t.getSize(find.byKey(a))} '
        'Flexible=${t.getSize(find.byKey(b))}');
  });
}
```

Saída: `Expanded=Size(200.0, 10.0) Flexible=Size(50.0, 10.0)`. Os dois filhos receberam 200 pixels (400 divididos por um flex total de 2). O `SizedBox(width: 50)` sob `Expanded` foi sobrescrito pela constraint tight e ficou com 200 de largura; sob `Flexible` manteve seus 50. O `width: 50` é um pedido, e uma constraint tight vinda do pai sempre vence.

O conjunto completo de testes, na mesma linha de 400 px:

| Layout (Flutter 3.44.8)                                                        | Resultado                                           |
| ------------------------------------------------------------------------------ | --------------------------------------------------- |
| `Expanded(SizedBox(w: 50))` + `Flexible(SizedBox(w: 50))`                      | 200 e 50                                            |
| `Flexible(SizedBox(w: 50))` + `Flexible(SizedBox(w: 1000))`                    | 50 e 200, 150 px sem uso no final                   |
| `SizedBox(w: 100)` + `Expanded(flex: 2)` + `Flexible(flex: 1, SizedBox(w: 40))` | 200 e 40, 60 px sem uso                            |
| `Flexible(fit: FlexFit.tight, SizedBox(w: 50))` + `SizedBox(w: 100)`           | 300, idêntico a `Expanded`                          |
| `Flexible(Container(color: ...))` + `SizedBox(w: 100)`                         | 300 x 100, o fit loose não mudou nada               |

A segunda linha é a que vale internalizar. O filho de 1000 pixels foi limitado a 200 mesmo com o irmão usando apenas 50, porque os 150 não utilizados do irmão nunca foram redistribuídos. Se você quer "o pequeno pega o que precisa e o grande fica com o resto", o pequeno não deve ser flexível: torne-o um filho comum e deixe apenas o grande como `Expanded`.

A última linha explica por que tanta gente conclui que "Flexible e Expanded são a mesma coisa". Um `Container` sem filho, sem largura e sem alinhamento assume o maior tamanho que suas constraints permitem. Dê a ele um máximo loose de 300 e ele escolhe 300. O mesmo vale para `ListView`, `TextField` (que preenche sua largura) e qualquer outro widget que se expande por padrão. Com filhos gulosos, o fit é invisível.

## Quando escolher Expanded

- **Um scrollable dentro de um `Column`.** `Column(children: [Header(), Expanded(child: ListView(...))])` é o layout canônico. A lista precisa de uma altura limitada, e ela deve ser exatamente a altura restante para que sua extensão de rolagem fique correta. Esta é a primeira correção no [guia sobre ListView dentro de um Column](/pt-br/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/), e [o motivo de ela superar `shrinkWrap` em listas longas](/pt-br/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/) é que a lista continua construindo seus filhos de forma preguiçosa.
- **Painéis com fundo, borda ou área de toque.** Uma barra lateral colorida e uma área de conteúdo divididas em 1:3 devem usar `Expanded(flex: 1)` e `Expanded(flex: 3)` para que as cores vão de ponta a ponta, independentemente do que o conteúdo mede.
- **Grades proporcionais construídas com `Row`s.** Se três células precisam se alinhar com três células da linha seguinte, fits tight garantem as mesmas larguras. Fits loose deixam cada linha variar conforme seu conteúdo.
- **Empurrar elementos para longe um do outro.** `Spacer()` é `Expanded(flex: flex, child: SizedBox.shrink())`. No teste, `SizedBox(w: 50)`, `Spacer()`, `SizedBox(w: 50)` coloca a segunda caixa em x = 350, rente à direita.

## Quando escolher Flexible

- **Texto que só deve ser truncado quando precisa.** Este é o caso que mais importa em apps reais. Compare um rótulo seguido de um ícone:

```dart
// Flutter 3.44.8: label that hugs its text but ellipsizes when long
Row(
  children: [
    Flexible(
      child: Text(
        userName,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
    ),
    const Icon(Icons.verified, size: 16),
  ],
)
```

Medido em uma linha de 400 px dentro de um `Scaffold`, com `userName = 'Short'`: sob `Flexible` o texto tem 71,25 px de largura e o ícone fica em x = 71,25, bem ao lado do nome. Troque por `Expanded` e o texto passa a ter 376 px de largura, com o ícone empurrado para x = 376, a borda da linha. Para um nome longo, as duas versões limitam o texto a 376 px e mostram reticências, então a correção do overflow é a mesma, mas só `Flexible` mantém o caso curto com boa aparência. Se você chegou aqui por causa da faixa amarela e preta, o [guia de RenderFlex overflowed](/pt-br/2026/05/fix-renderflex-overflowed-in-flutter/) cobre as outras causas.

- **Chips, badges e botões que devem manter seu tamanho natural**, mas não podem estourar em telas estreitas ou com texto de acessibilidade grande. Fits tight esticam a área de toque deles pela linha toda.
- **Quando você quer que `mainAxisAlignment` funcione.** Com dois filhos loose de 50 px e `MainAxisAlignment.spaceBetween`, o segundo filho fica em x = 350. Com dois filhos `Expanded`, o alinhamento é ignorado e o segundo fica em x = 200, porque um layout tight não tem espaço livre para distribuir.
- **Linhas que se ajustam ao conteúdo.** `Row(mainAxisSize: MainAxisSize.min, children: [Flexible(child: SizedBox(width: 50)), SizedBox(width: 20)])` mediu 70 px de largura. A mesma linha com `Expanded` mediu os 400 px completos, porque um filho tight consome todo o espaço que o pai oferece, então não sobra nada para `MainAxisSize.min` minimizar. Isso pega quem constrói um contêiner em formato de pílula que deveria envolver seu rótulo.

## A pegadinha que decide por você: eixo principal ilimitado

Coloque um `Column` dentro de um `SingleChildScrollView` (ou um `Row` dentro de um `ListView` horizontal) e o flex recebe uma constraint infinita no eixo principal. O `RenderFlex` não consegue dividir o infinito, então em `_computeSizes` ele define `canFlex = false` e faz o layout de todos os filhos como se não tivessem flex algum.

O que acontece em seguida depende do fit. A verificação de debug `_debugCheckConstraints` lança uma exceção se um filho tem flex diferente de zero **e** o flex usa `MainAxisSize.max` ou o filho é `FlexFit.tight`:

```dart
// Flutter 3.44.8: throws in debug
SingleChildScrollView(
  child: Column(
    mainAxisSize: MainAxisSize.min,
    children: [
      Expanded(child: SizedBox(height: 50)),
    ],
  ),
)
// RenderFlex children have non-zero flex but incoming height constraints are unbounded.
```

```dart
// Flutter 3.44.8: lays out fine, child is 50 px tall
SingleChildScrollView(
  child: Column(
    mainAxisSize: MainAxisSize.min,
    children: [
      Flexible(child: SizedBox(height: 50)),
    ],
  ),
)
```

Ambos foram verificados no teste: a variante com `Expanded` produziu a assertion, a variante com `Flexible` fez o layout de um filho de 10 x 50 sem nenhuma exceção. Isso importa para widgets reutilizáveis. Se um componente envolve parte de si mesmo em `Expanded`, ele nunca poderá ser colocado em uma coluna rolável. Se ele usa `Flexible` e sua coluna usa `MainAxisSize.min`, ele se degrada com elegância: pai limitado, ele flexiona; pai ilimitado, ele assume seu tamanho natural. Observe que no caso ilimitado o `Flexible` é efetivamente um no-op, então um filho guloso sob ele (um `ListView`) ainda lançará seu próprio erro de "unbounded height".

## Pegadinhas menores e variantes

**`flex: 0` desliga o widget.** O `RenderFlex` verifica `flex > 0` antes de tratar um filho como flexível. `Flexible(flex: 0, ...)` faz layout como um filho comum. `Spacer` exige `flex > 0` via assert para impedir que você faça isso sem querer.

**`Flexible(fit: FlexFit.tight)` e `Expanded` são intercambiáveis.** O teste produziu tamanhos idênticos. Prefira `Expanded` pela legibilidade; recorra a um `fit` explícito apenas quando ele for calculado, por exemplo `Flexible(fit: isCompact ? FlexFit.loose : FlexFit.tight, child: ...)`.

**O eixo transversal não é afetado.** Ambos os widgets restringem apenas o eixo principal. Se você quer que o filho preencha também o eixo transversal, isso é `crossAxisAlignment: CrossAxisAlignment.stretch` no `Row` ou `Column`, não um widget flex diferente.

**`spacing` sai primeiro.** Desde o Flutter 3.27, `Row` e `Column` têm um parâmetro `spacing`. `_computeSizes` inicia o espaço usado com `spacing * (childCount - 1)` antes de dividir, então os espaçamentos são subtraídos antes de qualquer parte flex ser calculada.

**Não os encadeie.** `Expanded(child: Flexible(...))` lança o erro de ParentDataWidget porque o pai do widget interno não é um flex. Veja [a correção de "Expanded widgets must be placed inside Flex widgets"](/pt-br/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/) para a lista completa de wrappers que causam isso.

## A recomendação, com o contexto por trás dela

Use `Expanded` como padrão. A maioria dos filhos flexíveis em apps reais são scrollables, painéis ou campos que querem todo o espaço de qualquer forma, e fits tight dão layouts previsíveis e alinhados, sem surpresas de espaço livre.

Mude para `Flexible` em exatamente três situações: o filho tem um tamanho natural que você quer manter (texto ao lado de um ícone, um chip), você precisa que `mainAxisAlignment` ou `MainAxisSize.min` continuem funcionando, ou você está escrevendo um widget reutilizável que pode cair dentro de uma scroll view. E quando você se pegar colocando `Flexible` em dois irmãos esperando que o pequeno doe espaço ao grande, pare: torne o pequeno um filho comum e o grande `Expanded`, porque o `RenderFlex` nunca redistribui a parte não utilizada de um filho loose.

## Relacionados

- [Corrigir "A RenderFlex overflowed by N pixels" no Flutter](/pt-br/2026/05/fix-renderflex-overflowed-in-flutter/) para os casos de overflow em que a escolha entre os dois é a correção.
- [Por que um ListView dentro de um Column lança um erro de altura ilimitada](/pt-br/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/) e as quatro formas de limitá-lo.
- [shrinkWrap vs Expanded vs slivers para listas longas](/pt-br/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/) quando o filho flexível é um scrollable.
- [Corrigindo "Incorrect use of ParentDataWidget"](/pt-br/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/) quando `Expanded` ou `Flexible` não é um filho flex direto.

## Fontes

- [Flexible class, Flutter API reference](https://api.flutter.dev/flutter/widgets/Flexible-class.html)
- [Expanded class, Flutter API reference](https://api.flutter.dev/flutter/widgets/Expanded-class.html)
- [FlexFit enum, Flutter API reference](https://api.flutter.dev/flutter/rendering/FlexFit.html)
- [Spacer class, Flutter API reference](https://api.flutter.dev/flutter/widgets/Spacer-class.html)
- [RenderFlex source, flutter/flutter `rendering/flex.dart`](https://github.com/flutter/flutter/blob/stable/packages/flutter/lib/src/rendering/flex.dart)
- [Understanding constraints, Flutter docs](https://docs.flutter.dev/ui/layout/constraints)
