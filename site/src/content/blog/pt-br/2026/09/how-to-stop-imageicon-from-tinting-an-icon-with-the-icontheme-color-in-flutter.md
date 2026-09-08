---
title: "Como impedir que o ImageIcon tinja um ícone com a cor do IconTheme ambiente no Flutter"
description: "O ImageIcon achata um PNG multicolorido em uma silhueta porque sempre aplica ColorFilter.mode(iconThemeColor, BlendMode.srcIn). O Flutter 3.47 adiciona useOriginalColors para desligar isso. Aqui está por que passar color: null nunca funcionou, o que o useOriginalColors descarta silenciosamente e a substituição manual para SDKs mais antigos."
pubDate: 2026-09-08
template: how-to
tags:
  - "flutter"
  - "dart"
  - "material-design"
  - "how-to"
lang: "pt-br"
translationOf: "2026/09/how-to-stop-imageicon-from-tinting-an-icon-with-the-icontheme-color-in-flutter"
translatedBy: "claude"
translationDate: 2026-09-08
---

O `ImageIcon` entrega sua imagem ao `Image` com `color: IconTheme.of(context).color`, e o objeto de renderização transforma isso em `ColorFilter.mode(color, BlendMode.srcIn)`, que joga fora o RGB de cada pixel e mantém apenas o alfa. Uma marca multicolorida sai como uma silhueta chapada, normalmente preta ou branca. Desde o Flutter 3.47 a correção é um único argumento: `ImageIcon(AssetImage('assets/logo.png'), useOriginalColors: true)`. Passar `color: null` não faz nada, e nunca fez, porque o `IconTheme.of` é contratualmente obrigado a devolver uma cor concreta e recorre ao preto opaco. No 3.44 e anteriores não existe a flag, então você substitui o widget por um `Image` simples e reproduz você mesmo os quatro argumentos de layout do ImageIcon. Tudo abaixo tem como alvo o canal estável atual, Flutter 3.47.2 com Dart 3.13.2.

## Por que color: null não desliga a tintura

O widget inteiro tem cerca de trinta linhas. Este é o `build` como ele é distribuído no 3.47:

```dart
// package:flutter/src/widgets/image_icon.dart, Flutter 3.47.2
@override
Widget build(BuildContext context) {
  final IconThemeData iconTheme = IconTheme.of(context);
  final double? iconSize = size ?? iconTheme.size;

  if (image == null) {
    return Semantics(
      label: semanticLabel,
      child: SizedBox(width: iconSize, height: iconSize),
    );
  }

  final double? iconOpacity = iconTheme.opacity;
  Color iconColor = color ?? iconTheme.color!;

  if (iconOpacity != null && iconOpacity != 1.0) {
    iconColor = iconColor.withOpacity(iconColor.opacity * iconOpacity);
  }

  return Semantics(
    label: semanticLabel,
    child: Image(
      image: image!,
      width: iconSize,
      height: iconSize,
      color: useOriginalColors ? null : iconColor,
      fit: BoxFit.scaleDown,
      excludeFromSemantics: true,
    ),
  );
}
```

A linha que sustenta tudo é `Color iconColor = color ?? iconTheme.color!`. Esse `!` não é otimismo, é uma garantia que o `IconTheme.of` faz explicitamente. A busca resolve o `IconTheme` ambiente mais próximo, verifica se o resultado é concreto e, se não for, preenche cada campo nulo a partir de `IconThemeData.fallback()`:

```dart
// package:flutter/src/widgets/icon_theme.dart, Flutter 3.47.2
static IconThemeData of(BuildContext context) {
  final IconThemeData iconThemeData = _getInheritedIconThemeData(context).resolve(context);
  return iconThemeData.isConcrete
      ? iconThemeData
      : iconThemeData.copyWith(
          size: iconThemeData.size ?? const IconThemeData.fallback().size,
          // ...
          color: iconThemeData.color ?? const IconThemeData.fallback().color,
          opacity: iconThemeData.opacity ?? const IconThemeData.fallback().opacity,
          // ...
        );
}
```

E `IconThemeData.fallback()` define `color = const Color(0xFF000000)`. Não existe estado da árvore de widgets em que `IconTheme.of(context).color` seja nulo. Portanto o comentário de documentação ainda anexado a `ImageIcon.color`, que diz que sem `IconTheme` ele "defaults to not recolorizing the image", descreve um comportamento que o widget não tem há muito tempo. Sem nenhum tema ambiente você recebe preto opaco, que é exatamente o resultado que as pessoas relatam como "meu ícone colorido renderiza como um borrão preto".

Definir `color: Colors.transparent` é a outra tentativa instintiva, e é pior. O `BlendMode.srcIn` compõe a cor de origem dentro do alfa do destino, então uma origem totalmente transparente produz um resultado totalmente transparente: o ícone some em vez de mostrar as próprias cores. Também não há nada a que recorrer no nível do tema, porque você não consegue expressar "sem cor" em um `IconThemeData` que o `IconTheme.of` vá devolver intacto.

## A reprodução: um PNG, três lugares onde ele fica cinza

Qualquer widget do Material que seja dono do seu espaço de ícone instala um `IconTheme` sobre esse espaço, então o mesmo asset é achatado em todos eles. Isto roda no 3.47 como está escrito; troque o import por `package:flutter/material.dart` se você ainda não fez a mudança para os [pacotes independentes material_ui e cupertino_ui](/pt-br/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/).

```dart
// Flutter 3.47.2, Dart 3.13.2
import 'package:material_ui/material_ui.dart';

const AssetImage brandMark = AssetImage('assets/brand/logo.png');

class TintDemo extends StatelessWidget {
  const TintDemo({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Tinting'),
        // Flattened to ColorScheme.onSurface.
        actions: const <Widget>[ImageIcon(brandMark)],
      ),
      body: Column(
        children: <Widget>[
          // Flattened to the button's resolved foreground color.
          ElevatedButton.icon(
            onPressed: () {},
            icon: const ImageIcon(brandMark),
            label: const Text('Open'),
          ),
          // Flattened to ListTileThemeData.iconColor.
          const ListTile(
            leading: ImageIcon(brandMark),
            title: Text('Account'),
          ),
          // Not flattened: no IconTheme is being applied to raw images.
          const Image(image: brandMark, width: 24, height: 24),
        ],
      ),
    );
  }
}
```

A última linha é a pista. Mesmo asset, mesmo tamanho, sem filtro de cor, cores corretas. Não há nada de errado com o PNG, e nada de errado com a resolução do asset também, que é a primeira suspeita habitual quando uma imagem parece errada; esse modo de falha é completamente diferente e está coberto em [unable to load asset no Flutter depois de adicionar uma imagem ao pubspec.yaml](/pt-br/2026/07/fix-unable-to-load-asset-in-flutter-after-adding-an-image-to-pubspec-yaml/).

## Passos para mudar um ImageIcon para as cores originais

1. Confira seu SDK com `flutter --version`. O `useOriginalColors` chegou no [PR 180491](https://github.com/flutter/flutter/pull/180491) em 2026-04-27 e foi distribuído na versão estável Flutter 3.47. Em qualquer coisa mais antiga, pule para a substituição manual abaixo.
2. Remova o argumento `color` do ponto de chamada. O construtor tem um assert de que `color` é nulo sempre que `useOriginalColors` é true, então deixar os dois no lugar é um erro duro.
3. Adicione `useOriginalColors: true`. Essa é a mudança inteira: o `build` passa então `color: null` para o `Image`, nenhum `ColorFilter` é instalado no objeto de renderização e os pixels decodificados chegam ao canvas intactos.
4. Reveja toda variante desse ícone que dependa de estado. Os estados selecionado, não selecionado, desabilitado e pressionado são todos expressos como cores diferentes de `IconThemeData`, e você acabou de abrir mão de todos eles de uma vez.
5. Decida o que carrega a aparência de desabilitado agora. Se o widget dependia de uma cor de tintura translúcida para parecer esmaecido, envolva o ícone em `Opacity` ou forneça um asset dessaturado separado.

O ponto de chamada final:

```dart
// Flutter 3.47.2, Dart 3.13.2
const ImageIcon(
  AssetImage('assets/brand/logo.png'),
  useOriginalColors: true,
  semanticLabel: 'Acme',
)
```

O tamanho continua vindo do `IconTheme` ambiente, então o ícone segue alinhado com os widgets `Icon` ao lado dele. Só o filtro de cor sumiu.

## O que o useOriginalColors descarta junto com a tintura

Olhe de novo para as duas linhas do `build` que importam:

```dart
if (iconOpacity != null && iconOpacity != 1.0) {
  iconColor = iconColor.withOpacity(iconColor.opacity * iconOpacity);
}
// ...
color: useOriginalColors ? null : iconColor,
```

O `IconTheme.opacity` é dobrado dentro do alfa da cor de tintura, e a cor de tintura é o único canal pelo qual ele chega à imagem. Defina `useOriginalColors: true` e todo o `iconColor` calculado é descartado, opacidade incluída. Um ancestral que escurece sua subárvore com `IconTheme(data: IconThemeData(opacity: 0.38), ...)` vai escurecer cada `Icon` ao redor e deixar sua imagem em força total.

O mesmo vale para cores de tintura translúcidas, que é como o Material expressa ícones desabilitados hoje. Os padrões do `NavigationBar` resolvem o estado desabilitado para `onSurfaceVariant` com alfa de 38 por cento, e esse alfa viaja pelo `srcIn` até o resultado renderizado. Abra mão do filtro e o destino desabilitado parece habilitado.

Se você precisa da opacidade ambiente de volta, leia e aplique você mesmo:

```dart
// Flutter 3.47.2, Dart 3.13.2
class BrandIcon extends StatelessWidget {
  const BrandIcon({super.key, required this.image});

  final ImageProvider image;

  @override
  Widget build(BuildContext context) {
    final double opacity = IconTheme.of(context).opacity ?? 1.0;
    final Widget icon = ImageIcon(image, useOriginalColors: true);
    return opacity == 1.0 ? icon : Opacity(opacity: opacity, child: icon);
  }
}
```

O `Opacity` é uma camada de composição de verdade e não é de graça, e é por isso que vale a pena manter a guarda contra o caso comum de `1.0` em vez de envolver incondicionalmente.

## A substituição anterior ao 3.47

Não há flag para portar de volta, nem combinação de valores de `color` que chegue ao mesmo resultado, então no 3.44 e anteriores você para de usar o `ImageIcon`. A substituição é curta porque o próprio ImageIcon é curto: as partes que valem a pena manter são a busca do tamanho, o `BoxFit.scaleDown` e a divisão semântica que coloca o rótulo no invólucro e exclui a imagem da árvore.

```dart
// Flutter 3.44 or older. Drop-in for ImageIcon that keeps the image's colors.
import 'package:flutter/widgets.dart';

class OriginalColorImageIcon extends StatelessWidget {
  const OriginalColorImageIcon(
    this.image, {
    super.key,
    this.size,
    this.semanticLabel,
  });

  final ImageProvider image;
  final double? size;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final double? iconSize = size ?? IconTheme.of(context).size;
    return Semantics(
      label: semanticLabel,
      child: Image(
        image: image,
        width: iconSize,
        height: iconSize,
        fit: BoxFit.scaleDown,
        excludeFromSemantics: true,
      ),
    );
  }
}
```

Dois detalhes são fáceis de perder se você colocar um `Image.asset` pelado no lugar. O `BoxFit.scaleDown` nunca aumenta: um asset cujo tamanho intrínseco é menor que a caixa do ícone fica no tamanho intrínseco e centraliza, igual ao comportamento do `ImageIcon`, e evita o borrão que o `BoxFit.contain` introduziria. E `excludeFromSemantics: true` no `Image` interno impede que a árvore de acessibilidade carregue tanto o rótulo do invólucro quanto o da própria imagem, que é o que o `ImageIcon` faz pelo mesmo motivo.

## Quais widgets instalam o IconTheme que te morde

| Widget | O que ele coloca no IconTheme ambiente |
| --- | --- |
| `AppBar`, `SliverAppBar` | `iconTheme` para o widget leading e `actionsIconTheme` para as actions, com padrão `ColorScheme.onSurface` |
| `ElevatedButton.icon` e as outras variantes de `ButtonStyleButton` | um `AnimatedTheme` cujo `iconTheme` é mesclado com a cor de primeiro plano resolvida e o tamanho do ícone |
| `IconButton` | a cor de primeiro plano resolvida para o estado atual do widget |
| `NavigationBar`, `NavigationRail` | um `WidgetStateProperty<IconThemeData>` resolvido separadamente para selecionado, não selecionado e desabilitado |
| `BottomNavigationBar` | as cores de item selecionado e não selecionado |
| `ListTile` | `ListTileThemeData.iconColor`, ou uma cor desabilitada quando `enabled: false` |
| `Chip` e suas variantes | o tema de ícone do próprio chip |
| `TabBar` | `labelColor` e `unselectedLabelColor` |

É por isso que o relatório de bug que costuma ser aberto, o mais famoso [flutter/flutter#81643](https://github.com/flutter/flutter/issues/81643), é fechado como inválido. O widget faz exatamente o que um widget de ícone deve fazer. O sistema de temas do Material assume que ícones são silhuetas monocromáticas que ele tem permissão para recolorir, a mesma suposição por trás do jeito como [o ColorScheme do Material 3 conduz as cores de destaque em um app Flutter](/pt-br/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/).

## Destinos selecionado e não selecionado precisam de dois widgets separados

O `NavigationBar` não troca um ícone por outro. Ele constrói os dois, envolve cada um no seu próprio `IconTheme.merge` e faz o cross-fade em um `Stack`:

```dart
// package:flutter/src/material/navigation_bar.dart, Flutter 3.47.2
final Widget selectedIconWidget = IconTheme.merge(
  data: enabled ? selectedIconTheme : disabledIconTheme,
  child: selectedIcon ?? icon,
);
final Widget unselectedIconWidget = IconTheme.merge(
  data: enabled ? unselectedIconTheme : disabledIconTheme,
  child: icon,
);
```

Como o `icon` é usado para o espaço não selecionado e também para o selecionado quando `selectedIcon` é nulo, um único widget com `useOriginalColors: true` abre mão da tintura nos dois estados. Se você quer as cores da marca só quando o destino está ativo, passe dois widgets:

```dart
// Flutter 3.47.2, Dart 3.13.2
NavigationDestination(
  icon: const ImageIcon(AssetImage('assets/brand/logo_mono.png')),
  selectedIcon: const ImageIcon(
    AssetImage('assets/brand/logo.png'),
    useOriginalColors: true,
  ),
  label: 'Acme',
)
```

O asset monocromático do espaço não selecionado continua recebendo a tintura, que é o que você quer: ele acompanha o tema como qualquer outro destino, e a marca em cores cheias aparece só na seleção.

## Detalhes que vale conhecer antes de subir isso

**O assert é uma checagem de modo debug, não um erro de compilação, a menos que você o transforme em um.** O `ImageIcon` tem um construtor `const`, então `const ImageIcon(image, useOriginalColors: true, color: Colors.red)` é avaliado em tempo de compilação e o analisador rejeita de cara. Escrito sem `const`, ele só lança em builds debug e profile. Em release o assert é removido, o `build` continua avaliando `useOriginalColors ? null : iconColor`, e sua cor é ignorada silenciosamente. Prefira `const` nesses pontos de chamada.

**O `Icon` não tem equivalente e não precisa de um.** Ícones baseados em fonte são contornos de um único glifo; não há cores originais a preservar. Se você precisa de um glifo multicolorido, precisa de uma imagem ou de um vetor, não de um `IconFont`.

**O `flutter_svg` funciona ao contrário.** O `SvgPicture.asset` não lê `IconTheme` de jeito nenhum, então um SVG mantém as próprias cores por padrão e você opta pela tintura com um `colorFilter: ColorFilter.mode(IconTheme.of(context).color!, BlendMode.srcIn)` explícito. Se o seu SVG sai monocromático sem você esperar, procure um `fill` fixo dentro do arquivo, não um tema ambiente.

**Verifique isso em um teste de widget em vez de olhar uma captura de tela.** Os pixels renderizados são difíceis de conferir, mas a configuração do widget não é:

```dart
// Flutter 3.47.2, Dart 3.13.2
testWidgets('brand mark ignores the ambient icon color', (WidgetTester tester) async {
  await tester.pumpWidget(
    const IconTheme(
      data: IconThemeData(color: Color(0xFFFF0000)),
      child: Directionality(
        textDirection: TextDirection.ltr,
        child: ImageIcon(
          AssetImage('assets/brand/logo.png'),
          useOriginalColors: true,
        ),
      ),
    ),
  );

  expect(tester.widget<Image>(find.byType(Image)).color, isNull);
});
```

Um teste golden também pega a regressão, mas este falha com uma mensagem legível e roda sem depender de o bundle de assets se comportar.

**Envie a densidade certa.** O `BoxFit.scaleDown` não amplia, então um espaço de ícone de 24 pixels lógicos em um dispositivo 3x quer um asset de 72 pixels em `assets/brand/3.0x/`. Um único PNG de 24 pixels que parecia bom enquanto era achatado em silhueta vai parecer visivelmente borrado assim que você puder ver os pixels de verdade.

### Leia em seguida

- [Migrar os imports de Material e Cupertino do Flutter para os pacotes material_ui e cupertino_ui](/pt-br/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/)
- [Como definir uma cor de destaque no Flutter com o ColorScheme do Material 3](/pt-br/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/)
- [Fix: unable to load asset no Flutter depois de adicionar uma imagem ao pubspec.yaml](/pt-br/2026/07/fix-unable-to-load-asset-in-flutter-after-adding-an-image-to-pubspec-yaml/)
- [Fix: cannot provide both a color and a decoration em um Container do Flutter](/pt-br/2026/07/fix-cannot-provide-both-a-color-and-a-decoration-in-a-flutter-container/)
- [O que é uma Key do Flutter e quando omiti-la causa bugs?](/pt-br/2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs/)

### Fontes

- [Classe ImageIcon, referência da API do Flutter](https://api.flutter.dev/flutter/widgets/ImageIcon-class.html)
- [Added useOriginalColors flag which allows ImageIcon to bypass IconTheme colorization, flutter/flutter PR 180491](https://github.com/flutter/flutter/pull/180491)
- [Notas de versão do Flutter 3.47.0](https://docs.flutter.dev/release/release-notes/release-notes-3.47.0)
- [IconTheme.of, referência da API do Flutter](https://api.flutter.dev/flutter/widgets/IconTheme/of.html)
- [BlendMode.srcIn, referência da API do dart:ui](https://api.flutter.dev/flutter/dart-ui/BlendMode.html)
- [ImageIcon displays a colourful icon as black & white, flutter/flutter issue 81643](https://github.com/flutter/flutter/issues/81643)
