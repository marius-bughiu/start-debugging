---
title: "Correção: Cannot provide both a color and a decoration em um Container do Flutter"
description: "Mova a cor para dentro da decoração: use decoration: BoxDecoration(color: ...) em vez de passar color e decoration para o mesmo Container."
pubDate: 2026-07-05
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "layout"
  - "container"
lang: "pt-br"
translationOf: "2026/07/fix-cannot-provide-both-a-color-and-a-decoration-in-a-flutter-container"
translatedBy: "claude"
translationDate: 2026-07-05
---

A correção em uma linha: apague o argumento `color:` do seu `Container` e coloque essa cor dentro do `BoxDecoration`, como `decoration: BoxDecoration(color: Colors.blue, ...)`. A asserção dispara porque o parâmetro `color` do `Container` nada mais é que um atalho para `decoration: BoxDecoration(color: color)`, então passar os dois daria ao widget duas definições concorrentes de plano de fundo e o Flutter se recusa a adivinhar qual vence.

```text
Cannot provide both a color and a decoration
The color argument is just a shorthand for "decoration: BoxDecoration(color: color)".

'package:flutter/src/widgets/container.dart':
Failed assertion: line 273 pos 15: 'color == null || decoration == null'
```

Este post foi escrito para Flutter 3.x (testado no 3.44) e Dart 3.x. A asserção do `Container` se lê da mesma forma desde os tempos da 1.x, então tudo aqui se aplica de forma limpa por toda a linha 3.x e para trás até a 2.x. A verificação vive em `package:flutter/src/widgets/container.dart`; o número da linha no seu stack trace pode diferir em alguns entre versões do SDK, mas a expressão da asserção `color == null || decoration == null` é estável.

## Por que Container proíbe color e decoration juntos

`Container` é um widget de conveniência. Ele não pinta nada por si só; ele compõe uma pilha de widgets mais simples (`Padding`, `DecoratedBox`, `ConstrainedBox`, `Transform` e companhia) com base nos argumentos que você passa. O argumento `color` é a menor fatia possível dessa composição: quando você o define, o `Container` constrói internamente um `DecoratedBox` com um `BoxDecoration(color: color)`. Esse é o significado completo de `color`. É açúcar sintático.

`decoration` é a versão com todo o poder da mesma coisa. Um `BoxDecoration` pode carregar uma cor de fundo, uma borda, cantos arredondados, um gradiente, uma sombra e uma imagem de fundo, tudo ao mesmo tempo. Como um `BoxDecoration` já tem seu próprio campo `color`, deixar você também passar uma `color` de nível superior criaria um widget ambíguo: qual cor pinta, a do `Container` ou a do `BoxDecoration`? Em vez de escolher um vencedor silenciosamente (e deixar metade da comunidade assumir a regra oposta), o framework dispara a asserção em tempo de construção e força você a ser explícito. O construtor contém um simples `assert(color == null || decoration == null, ...)`, e é por isso que isso só é lançado em builds de depuração e perfil, onde as asserções são executadas.

Há uma segunda razão, mais sutil, nas próprias palavras do framework: uma `decoration` pode pintar sobre a cor de fundo. Um `BoxDecoration` com um `DecorationImage` ou um gradiente desenha sobre o preenchimento da caixa, então uma `color` separada por baixo às vezes seria visível e às vezes não, dependendo da opacidade da decoração. Colapsar ambos em um único `BoxDecoration` remove toda essa classe de confusão de "por que minha cor não aparece".

## O menor repro que dispara o erro

Qualquer `Container` que queira ao mesmo tempo um fundo sólido e uma borda esbarra nisso imediatamente. Este é o caso canônico, porque a primeira tentativa natural é recorrer a `color` para o preenchimento e a `decoration` para a borda:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
import 'package:flutter/material.dart';

void main() => runApp(const MaterialApp(home: DecorationDemo()));

class DecorationDemo extends StatelessWidget {
  const DecorationDemo({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Container(
          width: 200,
          height: 120,
          // Both set at once -> assertion throws before the first frame.
          color: Colors.blue,
          decoration: BoxDecoration(
            border: Border.all(color: Colors.black, width: 2),
            borderRadius: BorderRadius.circular(12),
          ),
          child: const Center(child: Text('Card')),
        ),
      ),
    );
  }
}
```

Execute e o aplicativo nunca pinta um frame. A asserção é lançada dentro do construtor do `Container`, então o erro aparece no momento em que o `build` roda, não mais tarde durante o layout. Esse momento é um sinal útil: diferentemente de um `RenderFlex overflowed` ou um `RenderBox was not laid out`, que acontecem durante a fase de layout, este é uma violação de contrato em tempo de construção.

## A correção, na ordem da frequência com que você precisa dela

### Correção 1: mova a cor para dentro do BoxDecoration

Isso está correto praticamente sempre. Se você está passando uma `decoration`, remova o argumento `color` e defina `BoxDecoration.color` em seu lugar:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
Container(
  width: 200,
  height: 120,
  decoration: BoxDecoration(
    color: Colors.blue,               // was the top-level `color:`
    border: Border.all(color: Colors.black, width: 2),
    borderRadius: BorderRadius.circular(12),
  ),
  child: const Center(child: Text('Card')),
)
```

Um único `BoxDecoration` agora possui todo o visual: preenchimento, borda e raio de canto. Essa é a forma que você quer para qualquer cartão, chip, badge ou fundo de botão, porque no momento em que você precisa de uma borda ou cantos arredondados você sempre ia acabar em um `BoxDecoration` de qualquer maneira.

### Correção 2: se você só precisa de uma cor chapada, mantenha color e apague a decoration

Se você recorreu a `decoration` apenas para adicionar cantos arredondados ou uma borda, isso é deliberado e a Correção 1 é a certa. Mas se a `decoration` entrou de um copiar e colar e tudo o que você realmente precisa é de um preenchimento sólido sem borda, gradiente ou raio, faça o oposto: mantenha a `color` de nível superior e apague a `decoration` por completo.

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
Container(
  width: 200,
  height: 120,
  color: Colors.blue,   // fine on its own; no decoration present
  child: const Center(child: Text('Card')),
)
```

O atalho `color` não está obsoleto nem é desencorajado para o caso de preenchimento chapado. Ele se lê mais limpo do que envolver uma única cor em um `BoxDecoration`, e produz o mesmo `DecoratedBox` por baixo. Recorra ao `BoxDecoration` completo apenas quando precisar de um de seus recursos extras.

### Correção 3: descarte o Container por completo para uma caixa colorida simples

Quando seu `Container` não tem padding, nem restrições além de um tamanho, nem uma transformação, e você só quer um retângulo de cor, `ColoredBox` é o widget mais enxuto e nunca tem essa ambiguidade porque recebe uma `color` obrigatória e nenhuma decoração:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
const ColoredBox(
  color: Colors.blue,
  child: SizedBox(
    width: 200,
    height: 120,
    child: Center(child: Text('Card')),
  ),
)
```

`ColoredBox` pode ser `const` quando seu filho é `const`, o que permite ao Flutter pular sua reconstrução e repintura. Esse é um ganho real, ainda que pequeno, em uma lista de muitos tiles estáticos. Para qualquer coisa com uma borda ou raio, volte para a Correção 1; `ColoredBox` não pode desenhar isso.

## Onde isso realmente morde em código real

### Tematizar um widget espalhando uma decoração compartilhada

Design systems muitas vezes mantêm um `BoxDecoration` compartilhado e depois tentam sobrescrever apenas a cor por instância:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
// WRONG: passes both the reused decoration AND a color override.
Container(
  color: theme.colorScheme.surfaceContainerHigh,
  decoration: cardDecoration, // already a BoxDecoration
  child: content,
)
```

Você não pode sobrepor uma `color` de nível superior em cima de um `BoxDecoration` existente. Use `copyWith` na decoração em seu lugar, que é exatamente para o que ela serve:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
Container(
  decoration: cardDecoration.copyWith(
    color: theme.colorScheme.surfaceContainerHigh,
  ),
  child: content,
)
```

Se você está puxando cores de um `ColorScheme` do Material 3 aqui, os papéis (`surface`, `surfaceContainerHigh`, `primaryContainer`) importam para o contraste tanto no modo claro quanto no escuro; veja [como definir a cor de destaque em um app Flutter com o ColorScheme do Material 3](/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/) para saber qual papel usar.

### AnimatedContainer tem exatamente a mesma regra

`AnimatedContainer` compartilha o contrato do construtor do `Container`, então a asserção idêntica dispara ali. A armadilha é pior porque as pessoas animam uma cor interpolando a `color` de nível superior enquanto uma `decoration` estática fornece a borda:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
// WRONG: AnimatedContainer with both color and decoration.
AnimatedContainer(
  duration: const Duration(milliseconds: 200),
  color: _selected ? Colors.blue : Colors.grey,
  decoration: BoxDecoration(border: Border.all()),
)
```

Anime a cor dentro do `BoxDecoration`, e o `AnimatedContainer` interpolará toda a decoração para você, borda inclusa:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
AnimatedContainer(
  duration: const Duration(milliseconds: 200),
  decoration: BoxDecoration(
    color: _selected ? Colors.blue : Colors.grey,
    border: Border.all(),
  ),
)
```

`BoxDecoration` implementa a interpolação necessária para que a borda e a cor animem juntas, algo que a versão de dois argumentos nunca poderia fazer.

### Um condicional que deixa os dois definidos

A versão mais desagradável compila bem e só é lançada em um ramo. Alguém adiciona uma borda condicionalmente mas esquece de mover a cor:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
// WRONG on the highlighted branch only.
Container(
  color: Colors.white,
  decoration: isHighlighted
      ? BoxDecoration(border: Border.all(color: Colors.amber, width: 2))
      : null,
  child: child,
)
```

Quando `isHighlighted` é false, `decoration` é `null` e a asserção passa, então o código parece correto em cada captura de tela até que um usuário destaque uma linha. Empurre a cor para ambos os ramos (ou para um único `BoxDecoration` construído com uma borda condicional) para que não haja nenhum estado em que ambos sejam não nulos.

## Encontrar qual Container é o culpado em uma árvore grande

A mensagem da asserção nomeia o arquivo e a linha dentro de `container.dart`, não o seu widget. Para encontrar o seu `Container` infrator:

1. Leia o stack trace abaixo da asserção. O primeiro frame no seu próprio código (um arquivo sob `lib/`) é o método `build` que criou o `Container` errado. O Flutter imprime "The relevant error-causing widget was" seguido do seu widget e sua localização de origem na maioria das versões.
2. Se o trace não ajudar porque o `Container` é construído em um laço ou em um builder compartilhado, faça um grep no seu projeto por `color:` e `decoration:` aparecendo juntos. A regex `Container\([^)]*color:[^)]*decoration:` captura a maioria dos casos de uma linha; os de várias linhas precisam de uma varredura manual do cartão ou tile compartilhado.
3. Como isso é lançado em tempo de construção, o hot reload faz o erro aflorar instantaneamente. Adicione a borda ou a decoração, salve, e se o frame ficar vermelho você tem o widget certo na tela.

Esse comportamento em tempo de construção é o oposto de asserções de layout como [RenderBox was not laid out](/2026/06/fix-renderbox-was-not-laid-out-in-flutter/), que só aparecem depois que o pipeline de layout roda e muitas vezes apontam para vários widgets de distância da causa real.

## Armadilhas e erros parecidos

- **`BoxDecoration.color` versus `Container.color` e a ordem de pintura.** Eles não são idênticos em todos os casos. `Container.color` pinta atrás do filho mas também atrás de qualquer `decoration` caso uma fosse permitida; `BoxDecoration.color` pinta como parte da decoração, que fica atrás de `foregroundDecoration`. Para um preenchimento chapado o resultado é o mesmo pixel, mas se você também usar `foregroundDecoration`, a ordem das camadas importa.
- **Os splashes de `Ink` e `InkWell` desaparecem sobre um Container colorido.** Se você deu a um `Container` uma `color` e depois envolveu um filho em `InkWell`, o efeito de onda pinta atrás da cor do `Container` e some. A correção é o mesmo movimento: remova `Container.color` e use um widget `Ink` com uma `decoration`, ou um `Material` com uma cor, para que a camada de tinta fique acima do preenchimento.
- **`The following assertion was thrown building` com uma mensagem diferente.** Se o seu erro menciona `Incorrect use of ParentDataWidget` em vez de color e decoration, esse é um bug de contrato de layout distinto; veja [Incorrect use of ParentDataWidget: Expanded deve estar dentro de Flex](/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/).
- **Builds de release escondem isso, não corrigem.** Como a verificação é um `assert`, um build de release a remove e pinta usando o argumento que o construtor tiver armazenado. Não envie na suposição de que "funciona em release". Funciona por acidente, e a próxima atualização do SDK pode mudar qual argumento vence.
- **`DecoratedBox` lança o mesmo erro conceitual de forma diferente.** `DecoratedBox` não tem nenhum argumento `color`, apenas `decoration`, então você não pode esbarrar nessa asserção ali. Se você estava usando `DecoratedBox` e queria uma cor, ela sempre vai no `BoxDecoration`.

## Relacionado

- [Correção: A RenderFlex overflowed no Flutter](/2026/05/fix-renderflex-overflowed-in-flutter/) é a outra asserção em que iniciantes esbarram primeiro ao construir layouts de cartões e linhas.
- [Correção: RenderBox was not laid out no Flutter](/2026/06/fix-renderbox-was-not-laid-out-in-flutter/) cobre um erro em tempo de layout que, diferentemente deste, aponta para longe da causa real.
- [Correção: Incorrect use of ParentDataWidget: Expanded deve estar dentro de Flex](/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/) é uma asserção de contrato de construção irmã que vale a pena reconhecer.
- [Como definir a cor de destaque em um app Flutter com o ColorScheme do Material 3](/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/) explica qual papel do `ColorScheme` alimentar no seu `BoxDecoration.color`.

## Fontes

- [Construtor Container.new -- API do Flutter](https://api.flutter.dev/flutter/widgets/Container/Container.html), que documenta o atalho `color` e a regra "cannot provide both" literalmente.
- [Referência da classe BoxDecoration](https://api.flutter.dev/flutter/painting/BoxDecoration-class.html), a decoração que possui `color`, `border`, `borderRadius`, `gradient` e `boxShadow`.
- [flutter/flutter issue #119484](https://github.com/flutter/flutter/issues/119484), a issue de acompanhamento que discute como a mensagem de erro poderia ser mais clara.
- [flutter/flutter issue #31312](https://github.com/flutter/flutter/issues/31312), o relatório original que mostra a asserção exata e o stack trace de `container.dart`.
