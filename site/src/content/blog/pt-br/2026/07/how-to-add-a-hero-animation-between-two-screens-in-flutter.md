---
title: "Como adicionar uma animação Hero entre duas telas no Flutter"
description: "Envolva o mesmo widget nas duas rotas em um Hero com um tag idêntico e o Flutter anima sua posição e tamanho durante a navegação. Guia completo: imagens, flightShuttleBuilder, createRectTween, arcos com RectTween, transições por gesto e as colisões de tag que quebram tudo. Testado no Flutter 3.44, Dart 3.12."
pubDate: 2026-07-14
tags:
  - "flutter"
  - "dart"
  - "animation"
  - "navigation"
  - "how-to"
lang: "pt-br"
translationOf: "2026/07/how-to-add-a-hero-animation-between-two-screens-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-14
---

Resposta curta: envolva o widget que você quer animar em um `Hero` na primeira tela, envolva o widget de destino em um segundo `Hero` com o **mesmo `tag`** e empurre a rota de destino com o `Navigator` normal. O `HeroController` do Flutter (instalado por padrão em `MaterialApp` e `CupertinoApp`) encontra os dois heroes com o tag correspondente durante a transição de rota, eleva o hero de origem para um overlay e interpola sua posição e tamanho até que ele pouse no destino. Você não escreve nenhum `AnimationController`, nenhum `Tween` e nenhuma duração explícita para o caso básico. Verificado no Flutter 3.44, Dart 3.12.

Esse é todo o truque, e são de fato dois widgets `Hero` e um `Navigator.push`. O resto deste guia é a parte em que as pessoas tropeçam: as regras do tag, animar uma imagem ou um `Icon` que muda de forma entre telas, personalizar o widget de voo para que ele não pisque entre temas, curvar a trajetória do voo e o punhado de erros que transformam uma transição suave em um salto brusco.

## O exemplo mínimo que funciona

Duas telas. Uma caixa colorida na primeira, a mesma caixa maior na segunda. A caixa voa entre elas.

```dart
// Flutter 3.44, Dart 3.12
import 'package:flutter/material.dart';

void main() => runApp(const MyApp());

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(home: FirstScreen());
  }
}

class FirstScreen extends StatelessWidget {
  const FirstScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('First')),
      body: Center(
        child: GestureDetector(
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute(builder: (_) => const SecondScreen()),
          ),
          child: Hero(
            tag: 'box-hero',
            child: Container(width: 80, height: 80, color: Colors.indigo),
          ),
        ),
      ),
    );
  }
}

class SecondScreen extends StatelessWidget {
  const SecondScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Second')),
      body: Center(
        child: Hero(
          tag: 'box-hero',
          child: Container(width: 240, height: 240, color: Colors.indigo),
        ),
      ),
    );
  }
}
```

Toque na caixa pequena e ela cresce e desliza até o centro da segunda tela. Toque em voltar e ela reverte. A string `tag` `'box-hero'` é toda a ligação entre os dois widgets. Se os tags diferem por um único caractere, nada anima e as duas caixas simplesmente aparecem e desaparecem normalmente.

## Por que os tags correspondentes são todo o mecanismo

`Hero` não guarda uma referência à sua contraparte. Em vez disso, no momento em que uma transição de rota começa, o `HeroController` percorre a árvore de widgets da rota de saída e da rota de entrada e constrói um mapa de tag para hero. Para cada tag presente em **ambas** as rotas, ele inicia um "voo": o hero de origem é removido de sua posição normal (um `placeholderBuilder` preenche a lacuna, vazio por padrão), uma cópia é colocada no `Stack` de overlay do `Navigator` e essa cópia é animada do `Rect` de origem até o `Rect` de destino usando a própria animação de transição da rota como relógio.

Duas consequências decorrem desse design, e ambas são a origem da maioria dos bugs de Hero:

1. **Um tag deve ser único dentro de uma única rota.** Se uma tela tem dois widgets `Hero` com `tag: 'box-hero'`, o Flutter não consegue decidir qual voar e lança `There are multiple heroes that share the same tag within a subtree`. Isso morde com mais força quando você coloca um `Hero` dentro de um item de `ListView` e dá a cada item o mesmo tag literal. Use o id do item: `tag: 'photo-${photo.id}'`.
2. **O hero deve existir no primeiro frame da rota de destino.** O controller inspeciona a rota de destino enquanto ela está sendo construída. Se o seu hero de destino está atrás de um `FutureBuilder` que ainda não resolveu, dentro de um `Offstage`, ou bloqueado por um `if` que é falso na primeira construção, não há um `Rect` de destino para voar e a animação é silenciosamente ignorada.

## Animar uma imagem ou ícone que muda de forma

O uso real mais comum é uma miniatura que se expande em um cabeçalho de tela cheia. O filho não precisa ser idêntico nas duas rotas, apenas ter o tag idêntico. Aqui a origem é uma miniatura arredondada de 80x80 e o destino é uma imagem em toda a largura.

```dart
// Flutter 3.44, Dart 3.12
// Source: a grid thumbnail
Hero(
  tag: 'photo-${photo.id}',
  child: ClipRRect(
    borderRadius: BorderRadius.circular(12),
    child: Image.network(photo.url, width: 80, height: 80, fit: BoxFit.cover),
  ),
);

// Destination: a full-width header
Hero(
  tag: 'photo-${photo.id}',
  child: Image.network(
    photo.url,
    width: double.infinity,
    height: 300,
    fit: BoxFit.cover,
  ),
);
```

Duas coisas para observar quando o filho é uma `Image`. Primeiro, use a mesma `url` de imagem (idealmente o mesmo `ImageProvider` em memória) nas duas rotas para que o download de rede já esteja em cache e o voo não mostre um frame carregado pela metade. Segundo, um `BoxFit` divergente ou um `ClipRRect` em apenas um lado produz um estouro visível quando o raio de canto ou o recorte se ajustam de repente no fim do voo. Se os cantos arredondados importam, envolva os dois lados no mesmo `ClipRRect`, ou use um `flightShuttleBuilder` (abaixo) para interpolar o raio.

Para um `Icon` ou um trecho de `Text` estilizado, a mesma regra se aplica: o framework interpola o `Rect` delimitador e escala a renderização do filho de origem para caber nesse rect durante o voo. Um ícone de 24px voando para um ícone de 96px fica correto porque o filho é escalado, não re-disposto no meio do voo.

## Personalizar o widget de voo com flightShuttleBuilder

Por padrão, o voo mostra o filho do hero de destino, escalado. Esse padrão quebra em duas situações: quando o filho lê um `InheritedWidget` (um `Theme`, `DefaultTextStyle` ou `MediaQuery`) que difere entre as duas rotas, e quando você quer que o widget se transforme visivelmente, não apenas escale, durante o voo. `flightShuttleBuilder` dá a você controle total sobre o que é renderizado enquanto o hero está no ar.

```dart
// Flutter 3.44, Dart 3.12
Hero(
  tag: 'photo-${photo.id}',
  flightShuttleBuilder: (
    flightContext,
    animation,
    flightDirection,
    fromHeroContext,
    toHeroContext,
  ) {
    // Render the destination hero's widget, but wrapped in the
    // destination route's Material so text/icon theming is stable.
    return DefaultTextStyle(
      style: DefaultTextStyle.of(toHeroContext).style,
      child: toHeroContext.widget as Hero,
    );
  },
  child: Text(photo.title, style: Theme.of(context).textTheme.titleLarge),
);
```

O argumento `flightDirection` é `HeroFlightDirection.push` ou `HeroFlightDirection.pop`, então você pode renderizar um shuttle diferente na entrada e na saída. A `animation` é o `Animation<double>` do voo, de 0 a 1; use-o para fazer um cross-fade ou interpolar um `BorderRadius` se você quer que os cantos arredondem suavemente em vez de saltar. Essa é a correção certa para o problema "os cantos arredondados saltam no fim": conduza o raio a partir de `animation.value` dentro do shuttle.

## Curvar a trajetória do voo com createRectTween

Por padrão, o hero se move em linha reta entre os dois rects, e seu tamanho é interpolado linearmente. As próprias transições de detalhe do Material frequentemente usam um **arco**: o widget segue uma trajetória curva, que se lê como mais natural para um card que se expande em uma página. O Flutter inclui `MaterialRectArcTween` exatamente para isso, e você opta por ele por hero com `createRectTween`.

```dart
// Flutter 3.44, Dart 3.12
Hero(
  tag: 'box-hero',
  createRectTween: (begin, end) {
    return MaterialRectArcTween(begin: begin, end: end);
  },
  child: const SizedBox(width: 80, height: 80),
);
```

`createRectTween` roda no hero que é o destino do voo. Se você quer o arco tanto no push quanto no pop, configure-o nos heroes das duas rotas. O padrão é um `RectTween` simples (linear). `MaterialRectArcTween` curva os cantos superior-esquerdo e inferior-direito ao longo de arcos, que é por que um card em expansão parece "varrer" até o lugar em vez de disparar na diagonal. A partir do Flutter 3.44 você também pode passar uma curva diretamente para a transição via a rota, mas `createRectTween` continua sendo a maneira de dar forma à trajetória geométrica em vez do tempo.

## Fazer o gesto de voltar do iOS animar o hero

Em um `CupertinoPageRoute` (ou um `MaterialPageRoute` no iOS), o usuário pode arrastar a partir da borda esquerda para fazer pop da rota. Por padrão, o hero **não** voa durante esse arraste interativo; ele só voa em um pop confirmado. Configure `transitionOnUserGestures: true` nos dois heroes para que o elemento compartilhado acompanhe o arraste.

```dart
// Flutter 3.44, Dart 3.12
Hero(
  tag: 'box-hero',
  transitionOnUserGestures: true,
  child: Container(width: 80, height: 80, color: Colors.indigo),
);
```

Configure-o tanto no hero de origem quanto no de destino. Se você configurar em apenas um, o push anima mas o pop interativo não, o que parece inconsistente. Isso é barato de adicionar e raramente há motivo para deixá-lo desligado em um par de elemento compartilhado genuíno.

## Animação Hero com go_router e outros routers

Nada em `Hero` está preso ao `Navigator.push` imperativo. A animação é conduzida pela transição de rota, então ela funciona da mesma forma sob `go_router`, `auto_route` ou qualquer router construído sobre o `Navigator` 2.0, desde que a página de destino use uma página capaz de transição (`MaterialPage`, `CupertinoPage` ou um `CustomTransitionPage`). Dê aos dois widgets o mesmo tag e navegue como o seu app normalmente faz:

```dart
// Flutter 3.44, Dart 3.12, go_router 14.x
GoRoute(
  path: '/photo/:id',
  builder: (context, state) => PhotoDetailScreen(id: state.pathParameters['id']!),
);

// Trigger it from the grid:
onTap: () => context.go('/photo/${photo.id}'),
```

Uma ressalva com routers declarativos: se você usa um `CustomTransitionPage` com duração zero ou um `NoTransitionPage`, não há animação de transição para o `HeroController` conduzir, então o hero não voará. Mantenha uma transição real (mesmo um fade curto) em qualquer rota onde você quer uma animação de elemento compartilhado. Para uma comparação mais profunda dos routers em si, veja as notas sobre [rotas aninhadas e deep links com go_router](/pt-br/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/) e a análise de [go_router vs auto_route vs Navigator 2.0](/pt-br/2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter/).

## Os erros que quebram as animações Hero

Estas são as falhas que aparecem nos relatórios de bugs, ordenadas por quanto tráfego de busca elas atraem.

1. **`There are multiple heroes that share the same tag within a subtree`.** Dois heroes na mesma rota compartilham um tag. Quase sempre uma lista onde cada item usou um tag constante. Correção: derive o tag de uma chave única como `'item-${item.id}'`. Se você legitimamente precisa do mesmo visual na tela duas vezes, apenas um deles pode participar do voo; dê aos outros tags distintos ou nenhum `Hero`.
2. **O hero simplesmente aparece, sem voo.** O hero de destino não está presente no primeiro frame. Está atrás de um `FutureBuilder` não resolvido, dentro de um `Offstage`, ou bloqueado por uma flag que é falsa na primeira construção. Garanta que o widget com tag esteja na árvore imediatamente, mesmo que seus dados carreguem depois, para que haja um rect para voar. Uma armadilha relacionada é inicializar esse `Future` dentro de `build`, o que o recria a cada reconstrução; veja [inicializar um Future para que o FutureBuilder não o recrie](/pt-br/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/).
3. **O filho salta ou pisca no fim do voo.** `BoxFit`, raio de `ClipRRect` ou um estilo dependente de `InheritedWidget` divergentes entre as duas rotas. Corrija com um `flightShuttleBuilder` que renderize um widget estável e interpole a propriedade divergente a partir de `animation.value`.
4. **`Navigator.pop` lança ou a seta de voltar não faz nada.** Isso não é um problema de Hero, mas parece um porque acontece na tela com o hero. Confirme que a rota foi empurrada com um `Navigator` que possui um `HeroController`. `Navigator`s aninhados personalizados precisam do seu próprio `HeroController` em `observers` ou os heroes não voarão entre eles.
5. **O layout salta porque o hero tem tamanho sem limites.** Um `Hero` envolvendo um `Text` ou um `Row` dentro de um `Column` pode cair em uma situação de largura sem limites durante o voo quando é elevado para o `Stack` de overlay. Envolva o filho do hero em um `Material` com `type: MaterialType.transparency`, ou dê a ele restrições explícitas. Se você está esbarrando em erros de altura sem limites de forma mais geral, o padrão é a mesma família de bug de layout tratada em [aninhar um ListView dentro de um Column](/pt-br/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/).

## O texto precisa de um ancestral Material durante o voo

Um sutil que merece a própria nota: enquanto um hero está em voo ele vive no overlay do `Navigator`, desconectado do `Scaffold` e do seu `Material`. `Text` e widgets baseados em `Ink` procuram um ancestral `Material` para seu estilo de texto padrão e seus respingos de ink. Durante o voo eles podem não encontrá-lo, então texto estilizado pode renderizar com o estilo de depuração padrão (sublinhado preto) por um frame. Envolva o filho do voo em um `Material`:

```dart
// Flutter 3.44, Dart 3.12
Hero(
  tag: 'title-hero',
  flightShuttleBuilder: (ctx, anim, dir, fromCtx, toCtx) {
    return Material(
      type: MaterialType.transparency,
      child: toCtx.widget,
    );
  },
  child: Material(
    type: MaterialType.transparency,
    child: Text('Details', style: Theme.of(context).textTheme.headlineSmall),
  ),
);
```

`MaterialType.transparency` dá ao texto um ancestral `Material` para resolver seu estilo sem pintar um fundo, o que mantém o voo visualmente limpo.

## Quando não usar um Hero

Um `Hero` é a ferramenta certa quando o *mesmo elemento conceitual* existe nas duas telas: uma miniatura que vira um cabeçalho, um avatar que vira uma foto de perfil, um card que vira uma página de detalhe. É a ferramenta errada para movimento decorativo onde nada é compartilhado. Se você quer que a página inteira deslize, dê fade ou escale, isso é um `transitionsBuilder` de rota (ou um `PageRouteBuilder`), não um `Hero`. Se você quer que um widget se anime *dentro* de uma tela, recorra a `AnimatedContainer`, `AnimatedPositioned` ou um `AnimationController` explícito. O Hero é dono especificamente do caso de elemento compartilhado entre rotas, e usá-lo para qualquer outra coisa é lutar contra o framework.

Para trabalho mais amplo de desempenho e UI do Flutter que costuma aparecer junto com adicionar transições, os guias sobre [perfilar o jank com DevTools](/pt-br/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) e [definir uma cor de destaque com Material 3 ColorScheme](/pt-br/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/) cobrem as duas coisas que as pessoas costumam polir logo depois de a navegação parecer boa: o orçamento de frames e o theming.

## Fontes

- API do Flutter: [classe `Hero`](https://api.flutter.dev/flutter/widgets/Hero-class.html)
- Docs do Flutter: [Hero animations](https://docs.flutter.dev/ui/animations/hero-animations)
- Cookbook do Flutter: [Animate a widget across screens](https://docs.flutter.dev/cookbook/navigation/hero-animations)
- API do Flutter: [`MaterialRectArcTween`](https://api.flutter.dev/flutter/material/MaterialRectArcTween-class.html)
- API do Flutter: [`HeroController`](https://api.flutter.dev/flutter/widgets/HeroController-class.html)
