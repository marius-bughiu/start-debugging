---
title: "Correção: RenderBox was not laid out no Flutter"
description: "RenderBox was not laid out quase sempre é um erro secundário. Procure a primeira asserção de layout acima dele, geralmente um scrollable com restrições não limitadas, e corrija isso."
pubDate: 2026-06-03
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "layout"
  - "renderbox"
lang: "pt-br"
translationOf: "2026/06/fix-renderbox-was-not-laid-out-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-03
---

`RenderBox was not laid out` significa que o Flutter tentou pintar ou fazer hit-test em um render box cujo tamanho nunca foi calculado. Quase sempre é um erro derivado: uma asserção de layout anterior abortou o `performLayout` para parte da árvore, e esta mensagem é apenas os destroços. A correção real é subir até o primeiro erro do console, que geralmente é um scrollable (`ListView`, `GridView`, `SingleChildScrollView`) ao qual foram dadas restrições não limitadas no seu eixo de rolagem. Limite esse widget com `Expanded`, um tamanho fixo ou `shrinkWrap` e isso desaparece. Este guia usa Flutter 3.44 (estável, maio de 2026) e Dart 3.x.

A asserção que é lançada é `hasSize` em `package:flutter/src/rendering/box.dart`. Um `RenderBox` só recebe um tamanho durante a sua passada de `performLayout`. Se o layout nunca rodou com sucesso para esse box, pedir `.size` (algo que tanto a pintura quanto o hit-testing fazem) aciona a guarda. Por isso a mensagem é precisa mas pouco útil sozinha: ela nomeia a vítima, não o culpado.

## O erro em contexto

O bloco do console fica assim. O nome exato do widget e os IDs em hexadecimal mudam, mas o formato é constante:

```
======== Exception caught by rendering library =====================
The following assertion was thrown during performLayout():
RenderBox was not laid out: RenderShrinkWrappingViewport#4aefd
  relayoutBoundary=up13 NEEDS-PAINT NEEDS-COMPOSITING-BITS-UPDATE
'package:flutter/src/rendering/box.dart': Failed assertion: line 1966
  pos 12: 'hasSize'

The relevant error-causing widget was:
  ListView  lib/widgets/feed.dart:58
====================================================================
```

Dois detalhes importam. Primeiro, o render object nomeado (`RenderShrinkWrappingViewport`, `RenderPadding`, `RenderRepaintBoundary`, seja qual for) diz qual subárvore falhou ao fazer layout. Segundo, e mais importante, raramente esta é a única exceção. Em modo debug, o Flutter imprime a primeira falha e depois continua tentando renderizar, o que produz uma cascata dessas asserções `hasSize`. A mensagem sobre a qual você deve agir é a do topo da cascata, não aquela em que seu olhar pousa.

## Por que isso acontece

Um `RenderBox` tem um tamanho somente depois que o `performLayout` atribui um. Três situações deixam um box sem tamanho:

O box recebeu restrições que não consegue satisfazer, então o seu próprio `performLayout` lançou uma exceção. O caso clássico é um scrollable que recebeu uma restrição não limitada no seu eixo de rolagem. Um `ListView` vertical precisa de uma altura limitada para saber quanto viewport renderizar; dê a ele altura infinita e ele lança `Vertical viewport was given unbounded height`, o layout aborta, e cada ancestral que depois tentar ler o seu tamanho reporta `RenderBox was not laid out`.

Um pai pintou ou fez hit-test em um filho sem fazer layout dele primeiro. Este é o bug do `RenderObject` personalizado: você escreveu um render object cujo `paint` lê `child.size` mas cujo `performLayout` esqueceu de chamar `child.layout(...)`. O filho nunca recebeu um tamanho.

Alguém leu `.size` fora da fase de layout. Ler `context.size` ou `renderBox.size` durante `build`, `initState` ou um callback síncrono, antes de o primeiro frame ter feito o layout do widget, aciona a mesma asserção. O tamanho simplesmente ainda não existe.

A regra unificadora é o contrato de layout do Flutter: as restrições descem, os tamanhos sobem, e o tamanho de um box é válido somente entre o fim do seu `performLayout` e o próximo `markNeedsLayout`. Leia mais na página oficial [Understanding constraints](https://docs.flutter.dev/ui/layout/constraints), que é o documento mais útil para todo erro de layout no Flutter.

## Uma reprodução mínima que você pode colar em um app novo

O gatilho mais comum de longe: um `ListView` colocado diretamente dentro de um `Column`. O `Column` dá aos seus filhos altura não limitada no eixo principal, o `ListView` quer uma altura limitada, e o layout falha.

```dart
// Flutter 3.44, Dart 3.x -- throws, layout aborts, "RenderBox was not laid out" follows.
import 'package:flutter/material.dart';

void main() => runApp(const MaterialApp(home: FeedScreen()));

class FeedScreen extends StatelessWidget {
  const FeedScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Column(
        children: [
          const Text('Latest'),
          // ListView inside a Column: unbounded height on the main axis.
          ListView(
            children: const [
              ListTile(title: Text('One')),
              ListTile(title: Text('Two')),
              ListTile(title: Text('Three')),
            ],
          ),
        ],
      ),
    );
  }
}
```

Rode e o primeiro erro do console é `Vertical viewport was given unbounded height`. As asserções `RenderBox was not laid out` abaixo são a consequência, não a causa. A correção é limitar o `ListView`.

## Correção, em detalhe

As correções estão ordenadas pela frequência com que são a resposta certa. Escolha conforme o que o box sem tamanho realmente precisa.

### 1. Dê a um scrollable um tamanho limitado com Expanded (recomendado)

Quando um scrollable vive dentro de um `Column` ou `Row` e deve preencher o espaço restante, envolva-o em `Expanded`. O `Expanded` entrega ao filho uma restrição limitada e apertada (tight) no eixo principal, que é exatamente o que o viewport precisa:

```dart
// Flutter 3.44, Dart 3.x -- Expanded gives the ListView a bounded height.
Column(
  children: [
    const Text('Latest'),
    Expanded(
      child: ListView(
        children: const [
          ListTile(title: Text('One')),
          ListTile(title: Text('Two')),
          ListTile(title: Text('Three')),
        ],
      ),
    ),
  ],
)
```

Isso mantém o `ListView` preguiçoso: ele constrói apenas as linhas que estão na tela e rola o resto, que é o que você quer para qualquer lista que possa crescer. Esta é a correção certa para um feed, uma lista de resultados de busca, ou qualquer região com rolagem que tenha um cabeçalho acima.

### 2. Use shrinkWrap quando a lista é curta e deve se ajustar ao seu conteúdo

Se a lista é realmente pequena e finita (um punhado de linhas de configuração, um menu fixo) e você quer que ela ocupe apenas a altura do seu conteúdo, defina `shrinkWrap: true`. Isso diz ao `ListView` para medir seus filhos e reportar a altura combinada deles em vez de exigir um viewport limitado:

```dart
// Flutter 3.44, Dart 3.x -- shrinkWrap sizes the list to its children.
Column(
  children: [
    const Text('Settings'),
    ListView(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      children: const [
        ListTile(title: Text('Profile')),
        ListTile(title: Text('Notifications')),
        ListTile(title: Text('Privacy')),
      ],
    ),
  ],
)
```

O custo é real: o `shrinkWrap` faz layout de todos os filhos antecipadamente, anulando a renderização preguiçosa que torna o `ListView` barato. Use-o apenas para listas curtas e limitadas. Para qualquer coisa que possa crescer para dezenas de itens, volte à correção 1. Adicionar `physics: NeverScrollableScrollPhysics()` impede que a lista interna role de forma independente, que costuma ser o que você quer quando o `Column` externo é a superfície de rolagem.

### 3. Dê ao box uma restrição limitada explícita

Às vezes a resposta certa é um tamanho concreto. Um `SizedBox` com altura fixa, ou um `ConstrainedBox` com uma altura máxima, dá ao scrollable um limite com o qual trabalhar:

```dart
// Flutter 3.44, Dart 3.x -- a fixed viewport height for a horizontal carousel.
SizedBox(
  height: 200,
  child: ListView(
    scrollDirection: Axis.horizontal,
    children: const [/* cards */],
  ),
)
```

Um `ListView` horizontal dentro de um `Column` é a imagem espelhada da reprodução: o `Column` limita a largura mas deixa a altura não limitada, e o viewport horizontal precisa de uma altura limitada. Uma `height` fixa resolve isso de forma limpa. Use `ConstrainedBox(constraints: BoxConstraints(maxHeight: 300))` quando o conteúdo puder ser mais curto que o teto.

### 4. Faça layout do filho antes de ler o tamanho dele em um RenderObject personalizado

Se você escreveu um `RenderObject` personalizado (ou uma subclasse de `RenderBox`), a asserção está dizendo que o `performLayout` acessou o tamanho de um filho antes de fazer layout dele. Sempre chame `child.layout(...)` antes de ler `child.size`:

```dart
// Flutter 3.44, Dart 3.x -- lay out the child, THEN read its size.
@override
void performLayout() {
  final BoxConstraints childConstraints = constraints.loosen();
  child!.layout(childConstraints, parentUsesSize: true); // must come first
  size = constraints.constrain(child!.size);              // now .size is valid
}
```

O flag `parentUsesSize: true` é obrigatório quando o tamanho do próprio pai depende do filho. Omita-o e o Flutter pode pular o relayout quando o filho muda, o que produz layouts obsoletos que parecem esse mesmo erro de forma intermitente. O contrato está documentado na [página da API RenderBox.size](https://api.flutter.dev/flutter/rendering/RenderBox/size.html): o tamanho só é válido durante e depois do `performLayout`, e lê-lo a partir de um pai requer `parentUsesSize: true` no momento do `layout`.

### 5. Adie a leitura do tamanho para depois do primeiro frame

Se você precisa do tamanho renderizado de um widget em Dart (para posicionar um overlay, dimensionar um irmão, ou alimentar uma medição de volta ao estado), não leia `context.size` durante o `build`. O render box ainda não fez layout. Leia-o depois do frame:

```dart
// Flutter 3.44, Dart 3.x -- the size exists only after layout has run.
@override
void initState() {
  super.initState();
  WidgetsBinding.instance.addPostFrameCallback((_) {
    if (!mounted) return;
    final Size? size = context.size; // valid now: the frame has been laid out
    setState(() => _measuredHeight = size?.height);
  });
}
```

Para medir durante o layout em vez de depois dele, recorra ao `LayoutBuilder` (que entrega a você as restrições do pai) ou a um `RenderObject` com `parentUsesSize: true`, não a uma leitura de tamanho pós-frame. A abordagem pós-frame é para o caso "só preciso dos pixels finais uma vez".

## Pegadinhas e erros parecidos

- `Vertical viewport was given unbounded height` e `Horizontal viewport was given unbounded width` são os erros primários que *causam* a maioria das cascatas de `RenderBox was not laid out`. Se você vir qualquer um deles acima da asserção `hasSize`, corrija esse e o resto some. A correção são as correções 1 a 3 acima.
- `A RenderFlex overflowed by N pixels` é uma falha diferente: o flex fez layout bem mas seus filhos excederam o espaço disponível. Isso pinta uma faixa em vez de abortar o layout. Veja [o guia sobre o overflow de RenderFlex](/pt-br/2026/05/fix-renderflex-overflowed-in-flutter/) para esse caso; não é o mesmo que um box sem tamanho.
- `BoxConstraints forces an infinite height` lançado por `IntrinsicHeight` ou `IntrinsicWidth` envolvendo um scrollable. Os widgets intrínsecos fazem uma passada de layout especulativa da qual os scrollables se recusam a participar. Remova o `IntrinsicHeight`, ou limite o scrollable diretamente com um `SizedBox`.
- Um `TabBarView`, `PageView`, ou um `ListView` aninhado dentro de outro scrollable bate no mesmo muro de restrições não limitadas. Envolva o scrollable interno em um `Expanded` (se o externo for um flex) ou dê a ele uma altura fixa, e defina `shrinkWrap` apenas quando a lista interna for curta.
- Ler `renderBox.size` a partir de um `GlobalKey` imediatamente depois de um `setState` retorna o tamanho do frame *anterior*, ou lança uma exceção se o widget ainda não fez layout nenhum. Sempre proteja essas leituras atrás de `addPostFrameCallback` e uma verificação de `mounted`, a mesma disciplina que evita as falhas de descarte cobertas em [o guia sobre descartar controllers](/pt-br/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).
- Em modo release a asserção é compilada para fora, então em vez de uma tela vermelha você obtém uma região em branco, um widget de tamanho zero, ou uma pintura pulada em silêncio. Por isso você corrige a causa em debug em vez de passar batido por um aviso do console: o sintoma muda de forma em release mas o bug continua lá.

## Encontrar o verdadeiro culpado rápido

Como este erro faz cascata, o caminho mais rápido é ler o console de cima para baixo e parar na primeira exceção. Depois afunile o subárvore:

1. O primeiro erro nomeia um widget e uma localização de origem (`lib/widgets/feed.dart:58`). Abra esse arquivo e veja qual é o pai do widget nomeado. Um scrollable cujo pai é um `Column`, um `Row`, um `IntrinsicHeight`, ou outro scrollable é o seu suspeito.
2. Ative `debugPaintSizeEnabled = true;` no `main` (ou alterne Debug Paint no Flutter Inspector) para ver o contorno de cada box. Um box que não pinta nada ou que colapsa para uma linha é o que falhou ao fazer layout.
3. Abra o Layout Explorer no DevTools e selecione o widget que falha. O painel de restrições dele mostra se recebeu `h=unbounded` ou `w=unbounded`, o que confirma o diagnóstico. Se você não usou o DevTools para trabalho de layout, o passo a passo em [perfilar o jank de um app Flutter com DevTools](/pt-br/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) cobre como abrir uma sessão contra um dispositivo real; a mesma sessão maneja o Layout Explorer.

A lição mais profunda é que `RenderBox was not laid out` nunca é o bug em si. É o Flutter reportando que não conseguiu terminar o trabalho que um widget anterior começou. Treine-se para ignorar a mensagem mais barulhenta e encontrar a primeira, a silenciosa, e este erro deixa de ser um mistério. Mantenha seus scrollables limitados, faça layout dos filhos antes de medi-los, e nunca leia um tamanho antes do frame que o produz, e a asserção nunca dispara.

## Relacionado

- [Correção: A RenderFlex overflowed by N pixels no Flutter](/pt-br/2026/05/fix-renderflex-overflowed-in-flutter/) é o erro de layout irmão: o flex fez layout mas seus filhos não couberam, que é um modo de falha diferente de um box sem tamanho.
- [Correção: setState() or markNeedsBuild() called during build no Flutter](/pt-br/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) é o outro erro de "toquei o framework no momento errado", e compartilha a correção do post-frame-callback.
- [Como perfilar o jank de um app Flutter com DevTools](/pt-br/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) configura a mesma sessão de DevTools cujo Layout Explorer aponta a restrição não limitada por trás deste erro.
- [Como descartar controllers no Flutter para evitar vazamentos de memória](/pt-br/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) cobre a disciplina de `mounted` e de ciclo de vida que mantém seguras as leituras de tamanho pós-frame.

## Fontes

- [Understanding constraints](https://docs.flutter.dev/ui/layout/constraints), a explicação canônica de como as restrições, os tamanhos e o protocolo de layout se encaixam.
- [Referência da API RenderBox.size](https://api.flutter.dev/flutter/rendering/RenderBox/size.html), que afirma que o tamanho de um box só é válido durante e depois do `performLayout` e requer `parentUsesSize: true` para as leituras do pai.
- [Common Flutter errors](https://docs.flutter.dev/testing/common-errors), a lista oficial que define os erros de viewport não limitado e de overflow que causam a maioria dessas cascatas.
- [flutter/flutter issue #130967](https://github.com/flutter/flutter/issues/130967), um relato representativo da asserção `hasSize` disparando a partir de um viewport com shrink-wrap ao qual foram dadas restrições não limitadas.
