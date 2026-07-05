---
title: "Correção: Incorrect use of ParentDataWidget. Expanded widgets must be placed inside Flex widgets (Flutter)"
description: "Este erro significa que um Expanded ou Flexible não é filho direto de um Row, Column ou Flex. Mova-o diretamente para baixo do widget flex, ou remova Expanded se o pai não for um flex."
pubDate: 2026-07-05
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "layout"
lang: "pt-br"
translationOf: "2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-05
---

`Incorrect use of ParentDataWidget. Expanded widgets must be placed inside Flex widgets` significa que um `Expanded` (ou `Flexible`) não é filho direto de um `Row`, `Column` ou `Flex`. Algum outro widget -- um `Container`, `SizedBox`, `Padding`, `Center`, `Stack` ou `Wrap` -- fica entre eles. Corrija fazendo com que `Expanded` seja o filho direto do flex, ou removendo `Expanded` por completo se o pai não for um flex. Testado no Flutter 3.x (3.44), Dart 3.x.

## O erro em contexto

O Flutter lança isso durante a fase de build, como uma asserção, antes de o layout ser executado. A linha de resumo curta é a que as pessoas pesquisam, mas a mensagem completa no Flutter atual diz exatamente qual widget está errado e dentro do que ele está aninhado incorretamente:

```
Incorrect use of ParentDataWidget.

The ParentDataWidget Expanded(flex: 1) wants to apply ParentData of type
FlexParentData to a RenderObject, which has been set up to accept ParentData of
incompatible type BoxParentData.

Usually, this means that the Expanded widget has the wrong ancestor
RenderObjectWidget. Typically, Expanded widgets are placed directly inside Flex
widgets.
The offending Expanded is currently placed inside a SizedBox widget.

The ownership chain for the RenderObject that received the incompatible parent data
was:
  SizedBox ← Expanded ← Column ← ...
```

Duas linhas carregam toda a informação. "wants to apply ParentData of type `FlexParentData` to a RenderObject, which has been set up to accept ParentData of incompatible type `BoxParentData`" é a incompatibilidade de tipos. "The offending Expanded is currently placed inside a `SizedBox` widget" nomeia o pai errado pelo tipo de widget. Em versões mais antigas do Flutter, tudo isso se resume ao resumo que você provavelmente digitou na barra de busca: `Expanded widgets must be placed inside Flex widgets`.

## Por que um pai Flex é obrigatório, não apenas recomendado

`Expanded` não desenha nada. Ele é um `ParentDataWidget`: sua única tarefa é anexar um trecho de configuração ao seu filho para que o render object pai saiba como posicionar esse filho. Para o `Expanded`, essa configuração é um fator flex, e ela vive em um objeto do tipo `FlexParentData`.

Este é o mecanismo. Um `Row`, `Column` ou `Flex` é sustentado por um `RenderFlex`. Quando o `RenderFlex` adota um filho, ele configura um slot de `FlexParentData` nesse filho para guardar o valor flex e o fit. `Expanded` sobe até seu render object pai e chama `applyParentData`, que escreve `flex` e `fit` nesse slot. `RenderFlex` lê o slot durante o layout: filhos com um fator flex dividem o espaço restante do eixo principal em proporção aos seus fatores. Esse acordo é a única razão pela qual `Expanded` funciona.

Todo outro render object configura um tipo diferente de `ParentData`. Um `SizedBox`, `Container` ou `Padding` dá ao seu único filho `BoxParentData`. Um `Stack` dá aos filhos `StackParentData`. Um `Wrap` dá aos filhos `WrapParentData`. Nenhum deles tem um campo `flex`, e `FlexParentData` não pode ser escrito em um slot `BoxParentData`. Então, quando `Expanded` tenta fazer `applyParentData` em um pai que não é flex, a verificação `debugIsValidRenderObject` do framework detecta a incompatibilidade de tipos logo de início e lança o erro, em vez de ignorar silenciosamente o fator flex ou falhar mais tarde durante o layout. A mensagem é gerada a partir do `debugTypicalAncestorWidgetDescription` do widget, que para `Expanded` é "Flex widgets": daí vem a frase "must be placed inside Flex widgets".

Esta é uma falha diferente de um [overflow de RenderFlex](/pt-br/2026/05/fix-renderflex-overflowed-in-flutter/), que acontece quando um `Row` ou `Column` fica sem espaço em tempo de layout. Esta dispara antes, em tempo de build, e é um erro de tipo: a configuração flex não tem nenhum lugar válido para pousar.

## O repro mínimo

A menor versão é um `Expanded` envolvido em qualquer widget de filho único:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
class Sidebar extends StatelessWidget {
  const Sidebar({super.key});

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 200,
      child: Expanded(          // wrong: SizedBox is not a Flex
        child: ListView(
          children: const [Text('a'), Text('b')],
        ),
      ),
    );
  }
}
```

`SizedBox` dá ao seu filho `BoxParentData`. `Expanded` quer escrever `FlexParentData`. O build falha. A falha idêntica aparece se você trocar `SizedBox` por `Container`, `Padding`, `Center`, `Align`, `Card`, `Wrap` ou um `Stack`: qualquer coisa que não seja um `Row`, `Column` ou `Flex`.

## Correção 1: faça Expanded ser filho direto do Row, Column ou Flex

Se você de fato tem um pai flex e um widget intermediário se infiltrou, a correção é reordenar para que `Expanded` fique diretamente abaixo do flex. Este é de longe o caso mais comum: alguém envolveu um filho do flex em um `Padding` ou `Container` para estilizar, e o `Expanded` acabou do lado errado dele.

Errado -- `Expanded` está dentro do `Padding`, e `Padding` é um box:

```dart
// Flutter 3.x (tested 3.44)
Column(
  children: [
    const Text('Header'),
    Padding(
      padding: const EdgeInsets.all(8),
      child: Expanded(child: content),   // throws: parent is Padding
    ),
  ],
)
```

Certo -- `Expanded` é o filho direto do `Column`, e o `Padding` vai dentro dele:

```dart
// Flutter 3.x (tested 3.44)
Column(
  children: [
    const Text('Header'),
    Expanded(
      child: Padding(
        padding: const EdgeInsets.all(8),
        child: content,
      ),
    ),
  ],
)
```

A regra a interiorizar: `Expanded` deve ser o widget mais externo naquele espaço da lista `children`. Tudo o que você quiser decorar, preencher ou dimensionar vai dentro do seu `child`, não em volta dele.

## Correção 2: remova Expanded quando o pai não for um flex de forma alguma

Se realmente não há nenhum `Row`, `Column` ou `Flex` acima do widget, então `Expanded` é a ferramenta errada e nenhum grau de aninhamento o tornará legal. Você quer uma forma diferente de preencher o espaço:

- **Para preencher a largura ou a altura do pai**, dimensione o filho diretamente. Use `SizedBox(width: double.infinity)`, `SizedBox.expand` ou `double.infinity` nas restrições de um `Container`:

```dart
// Flutter 3.x (tested 3.44)
// Was: Container(child: Expanded(child: button))  -- illegal
SizedBox(
  width: double.infinity,
  child: button,
)
```

- **Para preencher uma fração do pai**, use `FractionallySizedBox`:

```dart
// Flutter 3.x (tested 3.44)
FractionallySizedBox(
  widthFactor: 0.5,
  child: button,
)
```

- **Se você na verdade queria uma divisão proporcional**, você buscava `Expanded` pela razão certa, mas esqueceu o pai flex. Introduza um. Envolva o grupo em um `Row` ou `Column` e coloque os filhos `Expanded` diretamente dentro dele:

```dart
// Flutter 3.x (tested 3.44)
Row(
  children: [
    Expanded(flex: 2, child: leftPane),
    Expanded(flex: 1, child: rightPane),
  ],
)
```

Escolha pela intenção. Se você só tem um filho, não precisa de flex nenhum: dimensione o box. Se está dividindo espaço entre irmãos, precisa de um pai flex de verdade.

## Correção 3: cuidado com um RenderObjectWidget escondido no caminho

O contrato do `Expanded` é mais rígido do que "em algum lugar abaixo de um Column". A documentação afirma que o caminho do `Expanded` para cima até seu `Row`, `Column` ou `Flex` envolvente deve conter **apenas** `StatelessWidget`s ou `StatefulWidget`s. No momento em que um `RenderObjectWidget` aparece nesse caminho, ele se torna o pai que recebe os parent data, e a incompatibilidade lança o erro.

Isso morde de duas maneiras sorrateiras:

**Um `Container` com certas propriedades insere render widgets.** `Container` é uma composição: dê a ele `padding` e ele envolve seu filho em um `Padding`; dê a ele um `color` ou `decoration` e ele adiciona um `DecoratedBox`; dê a ele `alignment` e ele adiciona um `Align`. Então `Container(padding: ..., child: Expanded(...))` coloca um `Padding` (um `RenderObjectWidget`) diretamente acima do seu `Expanded`, mesmo que você nunca tenha escrito `Padding`. Esse é o repro da Correção 1 disfarçado.

**Seu próprio `RenderObjectWidget` no caminho.** Se você tem um render widget sob medida envolvendo os filhos antes de eles chegarem ao `Column`, a mesma regra se aplica. Wrappers `StatelessWidget` e `StatefulWidget` próprios são aceitáveis; um `RenderObjectWidget` próprio não.

A conclusão: não basta que um `Flex` seja ancestral. `Expanded` tem que alcançá-lo através de nada além de widgets de composição simples.

## Armadilhas e casos parecidos

**`flex: 0` ainda lança o erro.** É tentador achar que `Expanded(flex: 0)` é um no-op que o framework deixaria passar. Não é. A verificação do tipo de parent data roda independentemente do valor flex, então `Expanded(flex: 0)` dentro de um `Wrap` falha com exatamente o mesmo erro, nomeando `WrapParentData` como o tipo incompatível. Isso foi confirmado como comportamento intencional na [issue 154950 do flutter/flutter](https://github.com/flutter/flutter/issues/154950). Se você quer um filho que participe de um `Wrap` com uma largura fixa, dê a ele um `SizedBox`, não um `Expanded`.

**`Flexible` tem a regra idêntica.** `Expanded` é apenas `Flexible` com `fit: FlexFit.tight`. `Flexible` também é um `ParentDataWidget<FlexParentData>`, então colocar um `Flexible` dentro de um pai que não é flex lança o mesmo erro "Flexible widgets must be placed inside Flex widgets". Trocar `Expanded` por `Flexible` nunca corrige este erro: apenas muda o nome do widget na mensagem.

**`Positioned` fora de um `Stack` é o mesmo tipo de bug.** Se você vê `Incorrect use of ParentDataWidget. Positioned widgets must be placed directly inside Stack widgets`, é exatamente o mesmo mecanismo com tipos diferentes: `Positioned` escreve `StackParentData` e precisa de um `Stack` (sustentado por `RenderStack`) como pai. O padrão de correção é idêntico: faça-o ser filho direto de um `Stack`, ou use um layout sem posicionamento.

**Um condicional ou um spread que produz um `Expanded` no nível superior.** Construir os filhos com um helper, um spread `...[]` ou um ternário pode entregar acidentalmente um `Expanded` a um pai que não é flex quando o ramo que você não testou é tomado. O erro nomeia o pai em tempo de execução, então confie em "currently placed inside a X widget" mais do que na aparência do código-fonte à primeira vista.

**O erro só faz asserção em builds de debug.** A verificação `debugIsValidRenderObject` é uma asserção de modo debug. Em um build de release a asserção é removida na compilação, os dados flex são descartados silenciosamente, e você obtém um layout sutilmente errado em vez de uma falha, o que é pior de diagnosticar. Sempre resolva isso em debug antes de publicar; não presuma que um build de release que "parece bom" está correto.

## Relacionados

- [Correção: A RenderFlex overflowed in Flutter](/pt-br/2026/05/fix-renderflex-overflowed-in-flutter/) -- o outro erro de `Row`/`Column`, lançado em tempo de layout quando os filhos flex pedem mais espaço do que existe.
- [Correção: RenderBox was not laid out in Flutter](/pt-br/2026/06/fix-renderbox-was-not-laid-out-in-flutter/) -- uma asserção de tempo de layout que você costuma encontrar no mesmo encanamento de scroll e flex.
- [Correção: A RenderViewport expected a RenderSliver em um CustomScrollView do Flutter](/pt-br/2026/07/fix-renderviewport-expected-a-rendersliver-in-a-flutter-customscrollview/) -- a mesma ideia de "protocolo errado", mas para slivers versus boxes em vez de parent data de flex versus box.
- [Como aninhar um ListView dentro de um Column sem o erro de altura não limitada](/pt-br/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/) -- onde `Expanded` é a resposta certa, dando a um `ListView` uma altura limitada dentro de um `Column`.

## Fontes

- [Classe Expanded, referência da API do Flutter](https://api.flutter.dev/flutter/widgets/Expanded-class.html) -- afirma que `Expanded` deve ser descendente de `Row`, `Column` ou `Flex`, com apenas widgets Stateless/Stateful no caminho.
- [Classe ParentDataWidget, referência da API do Flutter](https://api.flutter.dev/flutter/widgets/ParentDataWidget-class.html) -- `applyParentData`, `debugTypicalAncestorWidgetDescription` e a verificação de validade que gera esta mensagem.
- [Classe Flexible, referência da API do Flutter](https://api.flutter.dev/flutter/widgets/Flexible-class.html) -- a classe base do `Expanded`, sujeita ao mesmo requisito de pai flex.
- [issue 154950 do flutter/flutter](https://github.com/flutter/flutter/issues/154950) -- confirma que o erro ainda dispara para `Expanded(flex: 0)` dentro de um pai que não é flex, por design.
