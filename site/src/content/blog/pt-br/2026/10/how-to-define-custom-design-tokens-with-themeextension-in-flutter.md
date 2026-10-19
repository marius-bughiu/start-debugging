---
title: "Como definir design tokens personalizados com ThemeExtension e animá-los entre os temas claro e escuro no Flutter"
description: "Herde de ThemeExtension, registre uma instância por ThemeData pela lista extensions, leia com Theme.of(context).extension<T>() e escreva um lerp de verdade para que o AnimatedTheme do MaterialApp interpole seus tokens durante a troca entre claro e escuro. Cobre cores, raios, sombras, estilos de texto e booleanos, o crash por extensão ausente, a armadilha do copyWith que descarta todas as outras extensões e por que você precisa de == e hashCode, tudo verificado com testes de widget no Flutter 3.44.8."
pubDate: 2026-10-19
template: how-to
tags:
  - "flutter"
  - "dart"
  - "theming"
  - "material-3"
  - "how-to"
lang: "pt-br"
translationOf: "2026/10/how-to-define-custom-design-tokens-with-themeextension-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-19
---

**Resposta curta:** crie uma classe `@immutable` que estende `ThemeExtension<AppTokens>`, dê a ela os campos que o seu design system precisa (cores, raios, espaçamentos, sombras, estilos de texto) e implemente `copyWith` e `lerp`. Coloque uma instância em `ThemeData(extensions: [...])` para `theme` e outra para `darkTheme`, e então leia em qualquer lugar com `Theme.of(context).extension<AppTokens>()!`. O `MaterialApp` já envolve o seu app em um `AnimatedTheme`, que chama `ThemeData.lerp` a cada frame durante uma troca de tema, e isso chama o seu `lerp`. Se o seu `lerp` interpolar cada campo com `Color.lerp`, `lerpDouble`, `BorderRadius.lerp` e similares, seus tokens personalizados fazem a transição entre claro e escuro exatamente nos mesmos 200 ms do `ColorScheme` embutido. Tudo abaixo foi verificado com testes de widget no Flutter 3.44.8 (Dart 3.12.2).

O restante deste post cobre o que o `ThemeExtension` realmente é dentro do `ThemeData`, uma classe de tokens completa com sete tipos de campo diferentes, a ligação no `MaterialApp`, como controlar a animação e quatro armadilhas que encontrei nos testes: uma extensão que existe em apenas um tema, o `copyWith` apagando silenciosamente suas outras extensões, uma animação que reinicia a cada rebuild e booleanos que viram exatamente no ponto médio.

## Por que o ColorScheme não basta para design tokens

O `ColorScheme` do Material 3 tem cerca de 45 papéis, e se você define a cor da sua marca com `ColorScheme.fromSeed` ganha uma paleta coerente de graça (veja [como definir a cor de destaque com um ColorScheme do Material 3](/pt-br/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/)). Mas um design system de verdade tem tokens que o Material nunca previu: um verde de "sucesso" que não é `tertiary`, uma superfície de card elevado que difere de `surfaceContainerHigh` por poucos pontos percentuais, um estilo de texto para blocos de código, um raio de card, uma sombra que existe no modo claro e desaparece no modo escuro.

As soluções alternativas de sempre são todas ruins. Uma classe global `AppColors` com constantes estáticas não consegue mudar com o brilho. Um ternário `context.isDark ? x : y` espalhado pelos widgets muda instantaneamente quando o tema troca, enquanto o resto do app anima, o que parece quebrado. Um `InheritedWidget` personalizado funciona, mas você precisa reconstruir a infraestrutura de animação que o `ThemeData` já tem.

O `ThemeExtension` foi adicionado ao Flutter na versão 3.0 (PR #98033) para resolver exatamente isso. Ele permite pendurar seus próprios objetos tipados no `ThemeData` e, como o `ThemeData.lerp` os conhece, eles participam das animações de tema.

## O que o ThemeData faz com a sua extensão

O mecanismo inteiro é pequeno o bastante para ser lido de uma vez. De `packages/flutter/lib/src/material/theme_data.dart` no Flutter 3.44.8:

```dart
// Flutter 3.44.8, theme_data.dart (abridged)
abstract class ThemeExtension<T extends ThemeExtension<T>> {
  const ThemeExtension();

  Object get type => T;

  ThemeExtension<T> copyWith();

  ThemeExtension<T> lerp(covariant ThemeExtension<T>? other, double t);
}

// On ThemeData:
final Map<Object, ThemeExtension<dynamic>> extensions;

T? extension<T>() => extensions[T] as T?;
```

Três fatos saem daí:

1. As extensões ficam guardadas em um `Map` indexado por `type`, que é o argumento genérico `T`. Você pode ter no máximo uma extensão por tipo, e a busca é uma leitura de mapa.
2. `extension<T>()` retorna `T?`. Se o tema atual não tem entrada para `T`, você recebe `null`, não uma exceção.
3. O `lerp` é responsabilidade sua. O framework nunca inspeciona os seus campos.

E aqui está como o `ThemeData.lerp` combina os dois mapas:

```dart
// Flutter 3.44.8, ThemeData._lerpThemeExtensions
final Map<Object, ThemeExtension<dynamic>> newExtensions = a.extensions.map((
  Object id,
  ThemeExtension<dynamic> extensionA,
) {
  final ThemeExtension<dynamic>? extensionB = b.extensions[id];
  return MapEntry<Object, ThemeExtension<dynamic>>(id, extensionA.lerp(extensionB, t));
});
// Add [b]-only extensions.
newExtensions.addEntries(
  b.extensions.entries.where(
    (MapEntry<Object, ThemeExtension<dynamic>> entry) => !a.extensions.containsKey(entry.key),
  ),
);
```

Toda extensão do tema "de origem" recebe uma chamada `lerp(matching, t)`, em que `matching` pode ser `null`. As extensões que existem apenas no tema "de destino" são copiadas sem interpolação. Guarde isso para a seção de armadilhas.

## Passo a passo: construindo um conjunto de tokens animado

1. Defina uma subclasse `@immutable` de `ThemeExtension<AppTokens>` apenas com campos não anuláveis.
2. Implemente `copyWith` para que quem chama possa sobrescrever tokens individuais.
3. Implemente `lerp` com o helper `lerp` correspondente para cada tipo de campo.
4. Sobrescreva `==` e `hashCode` para que conjuntos de tokens iguais sejam comparados como iguais.
5. Registre uma instância clara em `theme` e uma escura em `darkTheme`.
6. Leia os tokens por meio de um getter em uma extension de `BuildContext`.

### Passos 1 a 4: a classe de tokens

```dart
// Flutter 3.44.8, Dart 3.12.2
import 'dart:ui' show lerpDouble;

import 'package:flutter/foundation.dart' show listEquals;
import 'package:flutter/material.dart';

@immutable
class AppTokens extends ThemeExtension<AppTokens> {
  const AppTokens({
    required this.surfaceRaised,
    required this.success,
    required this.cardRadius,
    required this.cardElevationShadow,
    required this.gap,
    required this.codeStyle,
    required this.useHairlineBorders,
  });

  final Color surfaceRaised;
  final Color success;
  final BorderRadius cardRadius;
  final List<BoxShadow> cardElevationShadow;
  final double gap;
  final TextStyle codeStyle;
  final bool useHairlineBorders;

  static const light = AppTokens(
    surfaceRaised: Color(0xFFFFFFFF),
    success: Color(0xFF1B873F),
    cardRadius: BorderRadius.all(Radius.circular(12)),
    cardElevationShadow: [
      BoxShadow(color: Color(0x1F000000), blurRadius: 12, offset: Offset(0, 4)),
    ],
    gap: 16,
    codeStyle: TextStyle(fontFamily: 'monospace', fontSize: 13, color: Color(0xFF24292F)),
    useHairlineBorders: false,
  );

  static const dark = AppTokens(
    surfaceRaised: Color(0xFF1E2228),
    success: Color(0xFF4ADE80),
    cardRadius: BorderRadius.all(Radius.circular(12)),
    cardElevationShadow: [
      BoxShadow(color: Color(0x00000000), blurRadius: 0, offset: Offset.zero),
    ],
    gap: 16,
    codeStyle: TextStyle(fontFamily: 'monospace', fontSize: 13, color: Color(0xFFE6EDF3)),
    useHairlineBorders: true,
  );

  @override
  AppTokens copyWith({
    Color? surfaceRaised,
    Color? success,
    BorderRadius? cardRadius,
    List<BoxShadow>? cardElevationShadow,
    double? gap,
    TextStyle? codeStyle,
    bool? useHairlineBorders,
  }) {
    return AppTokens(
      surfaceRaised: surfaceRaised ?? this.surfaceRaised,
      success: success ?? this.success,
      cardRadius: cardRadius ?? this.cardRadius,
      cardElevationShadow: cardElevationShadow ?? this.cardElevationShadow,
      gap: gap ?? this.gap,
      codeStyle: codeStyle ?? this.codeStyle,
      useHairlineBorders: useHairlineBorders ?? this.useHairlineBorders,
    );
  }

  @override
  AppTokens lerp(AppTokens? other, double t) {
    if (other is! AppTokens) return this;
    return AppTokens(
      surfaceRaised: Color.lerp(surfaceRaised, other.surfaceRaised, t)!,
      success: Color.lerp(success, other.success, t)!,
      cardRadius: BorderRadius.lerp(cardRadius, other.cardRadius, t)!,
      cardElevationShadow:
          BoxShadow.lerpList(cardElevationShadow, other.cardElevationShadow, t)!,
      gap: lerpDouble(gap, other.gap, t)!,
      codeStyle: TextStyle.lerp(codeStyle, other.codeStyle, t)!,
      useHairlineBorders: t < 0.5 ? useHairlineBorders : other.useHairlineBorders,
    );
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is AppTokens &&
          other.surfaceRaised == surfaceRaised &&
          other.success == success &&
          other.cardRadius == cardRadius &&
          listEquals(other.cardElevationShadow, cardElevationShadow) &&
          other.gap == gap &&
          other.codeStyle == codeStyle &&
          other.useHairlineBorders == useHairlineBorders;

  @override
  int get hashCode => Object.hash(
        surfaceRaised,
        success,
        cardRadius,
        Object.hashAll(cardElevationShadow),
        gap,
        codeStyle,
        useHairlineBorders,
      );
}
```

Algumas escolhas aqui são deliberadas:

- **Campos não anuláveis.** O exemplo oficial no repositório do Flutter (`examples/api/lib/material/theme/theme_extension.1.dart`) usa `Color?`. Isso compila, mas todo ponto de uso então precisa de `!` ou de um valor padrão, e `Color.lerp(null, x, t)` faz a transição a partir do transparente, o que raramente é o que você quer. Se um token sempre existe no seu design system, torne-o obrigatório.
- **O tipo do parâmetro de `lerp` é `AppTokens?`, não `ThemeExtension<AppTokens>?`.** A assinatura base marca o parâmetro como `covariant`, então você pode restringi-lo. `other is! AppTokens` cobre o caso `null`.
- **Todo tipo de campo tem um `lerp` estático correspondente.** `Color.lerp`, `lerpDouble`, `BorderRadius.lerp`, `EdgeInsets.lerp`, `TextStyle.lerp`, `BoxShadow.lerpList`, `Gradient.lerp`, `Offset.lerp` e `Size.lerp` existem todos. Eles retornam tipos anuláveis porque aceitam entradas anuláveis, daí o `!` quando as duas entradas são não nulas.
- **Valores discretos trocam no ponto médio.** Não existe valor significativo a meio caminho entre `true` e `false`. O próprio `ThemeData` usa o padrão `t < 0.5 ? a : b` para coisas como `platform` e `useMaterial3`, então eu o copio.
- **Uma sombra que "desaparece" é uma sombra transparente, não uma lista vazia.** `BoxShadow.lerpList` consegue interpolar listas de tamanhos diferentes, mas uma sombra com a mesma geometria e alfa zero dá uma transição limpa. No meu teste, no ponto médio o alfa da sombra foi `0.0608`, aproximadamente metade do valor claro `0x1F` (`0.1216`), que é exatamente o cross-fade que você quer.

### Passo 5: registre as duas instâncias

```dart
// Flutter 3.44.8
MaterialApp(
  theme: ThemeData(
    colorScheme: ColorScheme.fromSeed(seedColor: Colors.teal),
    extensions: const <ThemeExtension<dynamic>>[AppTokens.light],
  ),
  darkTheme: ThemeData(
    colorScheme: ColorScheme.fromSeed(
      seedColor: Colors.teal,
      brightness: Brightness.dark,
    ),
    extensions: const <ThemeExtension<dynamic>>[AppTokens.dark],
  ),
  themeMode: themeMode, // ThemeMode.system, .light or .dark
  home: const HomePage(),
);
```

Essa é toda a ligação de animação de que você precisa. O `_MaterialAppState._materialBuilder` escolhe `theme` ou `darkTheme` com base em `themeMode` e no brilho da plataforma, e então envolve a subárvore em `AnimatedTheme(data: theme, duration: ..., curve: ...)`. Quando o `ThemeData` selecionado muda, o `AnimatedTheme` executa um `ThemeDataTween`, cujo `lerp` é literalmente `ThemeData.lerp(begin!, end!, t)`. Seus tokens agora fazem parte desse tween.

Isso funciona tanto quando o seu próprio código alterna `themeMode` quanto quando o usuário ativa o modo escuro no sistema operacional com `themeMode` em `ThemeMode.system`.

### Passo 6: leia os tokens sem cerimônia

`Theme.of(context).extension<AppTokens>()!` é longo. Uma extension de `BuildContext` faz os pontos de uso parecerem código de design system:

```dart
// Flutter 3.44.8
extension AppTokensContext on BuildContext {
  AppTokens get tokens => Theme.of(this).extension<AppTokens>()!;
}

class TokenCard extends StatelessWidget {
  const TokenCard({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    return Container(
      padding: EdgeInsets.all(tokens.gap),
      decoration: BoxDecoration(
        color: tokens.surfaceRaised,
        borderRadius: tokens.cardRadius,
        boxShadow: tokens.cardElevationShadow,
        border: tokens.useHairlineBorders
            ? Border.all(color: Theme.of(context).colorScheme.outlineVariant, width: 0.5)
            : null,
      ),
      child: DefaultTextStyle.merge(style: tokens.codeStyle, child: child),
    );
  }
}
```

Como `Theme.of` registra uma dependência do tema herdado, o `TokenCard` é reconstruído a cada frame da animação do tema e enxerga os valores interpolados. Note que `Container` com `color` e `decoration` juntos lança uma exceção, e é por isso que a cor fica dentro do `BoxDecoration` (a história completa está em [a correção de "Cannot provide both a color and a decoration"](/pt-br/2026/07/fix-cannot-provide-both-a-color-and-a-decoration-in-a-flutter-container/)).

## Provando que os tokens realmente animam

A inspeção visual é pouco confiável em 200 ms. Um teste de widget que avança até o meio da animação não é:

```dart
// Flutter 3.44.8, flutter_test
AppTokens? seen;

class Probe extends StatelessWidget {
  const Probe({super.key});
  @override
  Widget build(BuildContext context) {
    seen = Theme.of(context).extension<AppTokens>();
    return const SizedBox();
  }
}

Widget app(ThemeMode mode) => MaterialApp(
      theme: ThemeData(extensions: const [AppTokens.light]),
      darkTheme: ThemeData(
        brightness: Brightness.dark,
        extensions: const [AppTokens.dark],
      ),
      themeMode: mode,
      home: const Probe(),
    );

testWidgets('tokens interpolate during a theme switch', (tester) async {
  await tester.pumpWidget(app(ThemeMode.light));
  expect(seen!.surfaceRaised, AppTokens.light.surfaceRaised);

  await tester.pumpWidget(app(ThemeMode.dark));
  await tester.pump(const Duration(milliseconds: 100)); // halfway of 200 ms
  expect(seen!.surfaceRaised, isNot(AppTokens.light.surfaceRaised));
  expect(seen!.surfaceRaised, isNot(AppTokens.dark.surfaceRaised));

  await tester.pumpAndSettle();
  expect(seen!.surfaceRaised, AppTokens.dark.surfaceRaised);
});
```

Aos 100 ms a cor da superfície era `Color(red: 0.5588, green: 0.5667, blue: 0.5784)`, quase exatamente o ponto médio entre o branco e `#1E2228`. A curva padrão é `Curves.linear`, então `t` é igual ao tempo decorrido dividido pela duração.

## Controlando a duração e a curva

O `MaterialApp` expõe a animação por dois parâmetros mais antigos e um mais novo:

```dart
// Flutter 3.44.8
MaterialApp(
  // Older API, still supported:
  themeAnimationDuration: const Duration(milliseconds: 350),
  themeAnimationCurve: Curves.easeInOut,

  // Newer API, takes precedence when non-null:
  themeAnimationStyle: AnimationStyle(
    duration: const Duration(milliseconds: 350),
    curve: Curves.easeInOutCubic,
  ),
  // ...
);
```

O padrão é `kThemeAnimationDuration`, que equivale a 200 ms. Passar `themeAnimationStyle: AnimationStyle.noAnimation` substitui o `AnimatedTheme` por um `Theme` simples, então a troca é instantânea. Confirmei que, nesse modo, o primeiro frame logo após a troca já reporta o `surfaceRaised` escuro. Essa é a configuração certa para golden tests e para usuários que ativam "reduzir movimento", o que você pode ler com `MediaQuery.disableAnimationsOf(context)`.

## Armadilhas que apareceram nos testes

### Uma extensão ausente em um dos temas causa crash no fim da animação

Suponha que você registre `AppTokens.light` em `theme` mas esqueça em `darkTheme`. Durante a animação, `_lerpThemeExtensions` chama `AppTokens.light.lerp(null, t)`, que retorna `this`, então os widgets continuam vendo tokens claros. No meu teste, o frame do ponto médio retornou uma instância de `AppTokens`. Então o tween chega a `t == 1.0`, `Tween.transform` retorna `end` diretamente, e `end` não tem `AppTokens` nenhum. `extension<AppTokens>()` retorna `null` e `context.tokens` lança um erro de null-check no último frame.

O resultado é um crash que só acontece depois de uma troca de tema, o tipo mais fácil de passar despercebido. A correção é estrutural: construa os dois temas a partir de uma única função para que a lista de extensões esteja sempre presente.

```dart
// Flutter 3.44.8
ThemeData buildTheme(Brightness brightness) {
  final isDark = brightness == Brightness.dark;
  return ThemeData(
    colorScheme: ColorScheme.fromSeed(seedColor: Colors.teal, brightness: brightness),
    extensions: <ThemeExtension<dynamic>>[
      isDark ? AppTokens.dark : AppTokens.light,
    ],
  );
}
```

### ThemeData.copyWith(extensions: ...) substitui o mapa inteiro

Esta pega quando você sobrescreve um único token para uma subárvore. O código-fonte de `ThemeData.copyWith` é:

```dart
extensions: (extensions != null) ? _themeExtensionIterableToMap(extensions) : this.extensions,
```

Não há mesclagem. No meu teste, um tema com `AppTokens` e `BrandTokens` que passou por `copyWith(extensions: [BrandTokens(...)])` saiu com `extension<AppTokens>()` retornando `null`. Para sobrescrever uma extensão e manter as demais, espalhe primeiro os valores existentes. As entradas posteriores vencem, porque o mapa é construído com um laço `for` indexado por `type`:

```dart
// Flutter 3.44.8
final theme = Theme.of(context);
return Theme(
  data: theme.copyWith(
    extensions: [
      ...theme.extensions.values,
      context.tokens.copyWith(gap: 8), // overrides AppTokens only
    ],
  ),
  child: const CompactSection(),
);
```

Deixe o literal de lista sem tipo aqui. Escrever `<ThemeExtension<dynamic>>[...]` falha na compilação com "Can't assign spread elements of type 'ThemeExtension<dynamic>' to collection elements of type 'ThemeExtension<ThemeExtension<dynamic>>'" no Dart 3.12.2, uma peculiaridade do limite autorreferente `T extends ThemeExtension<T>`. Deixar a inferência escolher o tipo do elemento compila e se comporta corretamente: no meu teste, a subárvore viu `gap: 8.0` e a extensão `BrandTokens` intacta.

Um widget `Theme` simples não anima. Se a própria sobrescrita deve fazer transição (por exemplo, uma seção de "zona de perigo" que muda de tom ao passar o mouse), use `AnimatedTheme` diretamente.

### Sem == e hashCode, a animação do tema reinicia a cada rebuild

O `ThemeData.==` compara `extensions` com `mapEquals`, que chama `==` em cada extensão. Se a sua classe não sobrescreve `==`, duas instâncias com valores idênticos não são iguais. Isso importa assim que você constrói tokens em tempo de execução em vez de usar instâncias `const`, por exemplo a partir da cor de destaque escolhida pelo usuário, ou com `AppTokens.light.copyWith()` dentro de `build`.

Testei isso reconstruindo o `MaterialApp` com uma instância nova mas idêntica de `copyWith()` depois que a primeira animação já tinha terminado. Sem `==`, `tester.hasRunningAnimations` era `true`: o `AnimatedTheme` viu um tema "novo" e iniciou outro tween de 200 ms, reconstruindo todos os widgets que dependem do tema por 12 frames sem nenhuma mudança visual. Depois de adicionar as sobrescritas de `==` e `hashCode` mostradas acima, o mesmo teste reportou `false`. Se você não quiser escrevê-las à mão, pacotes como `theme_extensions_builder` geram `copyWith`, `lerp`, `==` e `hashCode` a partir de uma anotação.

### Booleanos e enums viram exatamente em t = 0.5

Com o padrão `t < 0.5`, `useHairlineBorders` já era `true` no frame de 100 ms, porque `t` era exatamente `0.5`. Isso é consistente com a forma como o `ThemeData` faz o lerp dos seus próprios campos discretos, mas significa que uma borda pode aparecer de repente no meio de uma transição de cor. Se isso parecer errado, expresse o visual como um token contínuo: substitua o booleano por uma `Color` de borda que vai de transparente a `outlineVariant`, e deixe o `Color.lerp` cuidar disso.

### A chave é o argumento genérico, não o tipo em tempo de execução

`type` retorna `T`, o argumento de tipo que você passou para `ThemeExtension`, e não `runtimeType`. Se você escrever `class BrandAppTokens extends AppTokens`, uma instância dela é armazenada sob `AppTokens` e substitui a base. Geralmente é isso que se quer para white-labelling, mas significa que você não pode registrar uma base e uma subclasse lado a lado.

## Onde o ThemeExtension se encaixa entre as outras ferramentas de tema

Use o `ColorScheme` primeiro para tudo o que os componentes do Material consomem, porque botões, chips e app bars nunca vão ler a sua extensão. Use temas de componente (`CardThemeData`, `FilledButtonThemeData`) quando quiser reestilizar um widget do Material em todo lugar. Use o `ThemeExtension` para tudo o que os seus próprios widgets precisam e para o qual o Material não tem um espaço. Se você também carrega fontes pelo `google_fonts`, mantenha o `TextTheme` em `ThemeData.textTheme` e coloque na extensão apenas estilos fora do padrão (blocos de código, exibições numéricas); a incompatibilidade de tipos que às vezes aparece ali é tratada em [a correção do TextTheme com google_fonts](/pt-br/2026/09/fix-textheme-cant-be-assigned-to-textheme-google-fonts-material-ui/).

O mesmo modelo de "valor ambiente vindo do widget herdado mais próximo" move o `IconTheme`, o que explica por que os ícones assumem cores que você não definiu, como descrito em [como impedir que o ImageIcon seja tingido com a cor do IconTheme](/pt-br/2026/09/how-to-stop-imageicon-from-tinting-an-icon-with-the-icontheme-color-in-flutter/). E se o botão de alternar tema troca um ícone de sol por um de lua, [o AnimatedSwitcher precisa de uma key para animar essa troca](/pt-br/2026/10/how-to-make-animatedswitcher-animate-when-the-child-type-does-not-change/).

### Leia a seguir

- [Como definir a cor de destaque em um app Flutter com o ColorScheme do Material 3](/pt-br/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/)
- [Como fazer o AnimatedSwitcher animar quando o tipo do widget filho não muda](/pt-br/2026/10/how-to-make-animatedswitcher-animate-when-the-child-type-does-not-change/)
- [Como impedir que o ImageIcon tinja um ícone com a cor do IconTheme ambiente](/pt-br/2026/09/how-to-stop-imageicon-from-tinting-an-icon-with-the-icontheme-color-in-flutter/)
- [Correção: The argument type 'TextTheme' can't be assigned to the parameter type 'TextTheme?' com google_fonts](/pt-br/2026/09/fix-textheme-cant-be-assigned-to-textheme-google-fonts-material-ui/)

## Fontes

- [`ThemeExtension` class, Flutter API docs](https://api.flutter.dev/flutter/material/ThemeExtension-class.html)
- [`ThemeData.extensions` property, Flutter API docs](https://api.flutter.dev/flutter/material/ThemeData/extensions.html)
- [`MaterialApp.themeAnimationStyle`, Flutter API docs](https://api.flutter.dev/flutter/material/MaterialApp/themeAnimationStyle.html)
- [`theme_data.dart` source on GitHub](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/src/material/theme_data.dart)
- [Official `ThemeExtension` sample, `theme_extension.1.dart`](https://github.com/flutter/flutter/blob/master/examples/api/lib/material/theme/theme_extension.1.dart)
- [Introduce Theme extensions (flutter/flutter#98033)](https://github.com/flutter/flutter/pull/98033)
