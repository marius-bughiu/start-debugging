---
title: "Como definir a cor de destaque em um app Flutter com Material 3 ColorScheme"
description: "A forma correta em 2026 de definir uma cor de destaque no Flutter com Material 3: ColorScheme.fromSeed, o atalho colorSchemeSeed, as sete opções de DynamicSchemeVariant, modo escuro, dynamic_color no Android 12+ e harmonização de cores de marca. Testado no Flutter 3.27.1 e Dart 3.11."
pubDate: 2026-05-06
template: how-to
tags:
  - "flutter"
  - "dart"
  - "material-3"
  - "theming"
  - "how-to"
lang: "pt-br"
translationOf: "2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme"
translatedBy: "claude"
translationDate: 2026-05-06
---

Resposta curta: o Material 3 não tem mais uma "cor de destaque". O controle único mais próximo é a cor semente que você passa para `ColorScheme.fromSeed`. Use `ThemeData(colorSchemeSeed: Colors.deepPurple)` para o caso mais simples, ou `ColorScheme.fromSeed(seedColor: ..., brightness: Brightness.light)` quando quiser controlar a variante, o nível de contraste ou parear esquemas claro e escuro. A partir dessa única semente, o framework deriva a paleta M3 completa: `primary`, `onPrimary`, `secondary`, `tertiary`, `surface`, `surfaceContainer` e o resto. Verificado no Flutter 3.27.1, Dart 3.11.

Este guia percorre a maneira certa de fazer isso em 2026, as coisas que parecem corretas mas quebram no modo escuro ou no Android 12+, e como manter uma cor de marca existente sem perder o sistema tonal do M3.

## Por que "cor de destaque" deixou de existir no M3

O Material 2 tinha `primaryColor` e `accentColor` como dois controles aproximadamente independentes. Você os definia, e widgets como `FloatingActionButton`, `Switch` ou o cursor do `TextField` escolhiam um ou outro. No Material 3 esse vocabulário sumiu. A especificação substitui ambos por um sistema de papéis de cor que são calculados a partir de uma única semente:

- `primary`, `onPrimary`, `primaryContainer`, `onPrimaryContainer`
- `secondary`, `onSecondary`, `secondaryContainer`, `onSecondaryContainer`
- `tertiary`, `onTertiary`, `tertiaryContainer`, `onTertiaryContainer`
- `surface`, `onSurface`, `surfaceContainerLowest` ... `surfaceContainerHighest`
- `error`, `onError`, mais variantes
- `outline`, `outlineVariant`, `inverseSurface`, `inversePrimary`

O que era seu "accent" no M2 geralmente mapeia para `primary` no M3, e às vezes para `tertiary` se você usava o accent para destaques. A [documentação de papéis de cor do Material 3](https://m3.material.io/styles/color/roles) é a fonte canônica para saber qual papel vai em qual superfície.

A consequência prática: se você buscar uma resposta antiga no StackOverflow que diz "defina `ThemeData.accentColor`", essa propriedade ainda compila em alguns caminhos estreitos, mas nenhum widget Material 3 a lê. Você passará uma tarde se perguntando por que nada mudou. Está obsoleta e é praticamente um no-op para widgets M3.

## O padrão mínimo correto

O Material 3 está ativado por padrão no Flutter 3.16 em diante. Você não precisa mais definir `useMaterial3: true`. A cor de destaque mais simples e idiomática para um app novo:

```dart
// Flutter 3.27.1, Dart 3.11
import 'package:flutter/material.dart';

void main() => runApp(const MyApp());

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Demo',
      theme: ThemeData(
        colorSchemeSeed: Colors.deepPurple,
        brightness: Brightness.light,
      ),
      darkTheme: ThemeData(
        colorSchemeSeed: Colors.deepPurple,
        brightness: Brightness.dark,
      ),
      themeMode: ThemeMode.system,
      home: const Scaffold(),
    );
  }
}
```

`colorSchemeSeed` é um atalho dentro de `ThemeData` que equivale a:

```dart
// What colorSchemeSeed expands to internally
ThemeData(
  colorScheme: ColorScheme.fromSeed(
    seedColor: Colors.deepPurple,
    brightness: Brightness.light,
  ),
);
```

Se você só precisa da semente e do brilho, prefira `colorSchemeSeed`. Recorra diretamente a `ColorScheme.fromSeed` quando precisar ajustar a variante, o nível de contraste, ou sobrescrever um ou dois papéis específicos.

## Escolhendo um DynamicSchemeVariant

Desde o Flutter 3.22, o construtor `ColorScheme.fromSeed` aceita um parâmetro `dynamicSchemeVariant`. Ele seleciona qual algoritmo das Material Color Utilities deriva a paleta. As opções, em ordem de quão agressivamente preservam sua semente visível:

- `DynamicSchemeVariant.tonalSpot` (padrão): a receita padrão do Material 3. Saturação média, equilibrada. A semente vira a fonte de `primary`, com `secondary` e `tertiary` puxados de tons vizinhos.
- `DynamicSchemeVariant.fidelity`: mantém `primary` muito próximo da cor semente exata. Use quando a marca quiser que a semente apareça literalmente.
- `DynamicSchemeVariant.content`: similar a `fidelity` mas projetado para paletas derivadas de conteúdo (por exemplo, a cor dominante de uma imagem hero).
- `DynamicSchemeVariant.monochrome`: tons de cinza. `primary`, `secondary` e `tertiary` são todos neutros.
- `DynamicSchemeVariant.neutral`: croma baixo. A semente mal colore o resultado.
- `DynamicSchemeVariant.vibrant`: empurra o croma. Bom para apps lúdicos ou pesados em mídia.
- `DynamicSchemeVariant.expressive`: rotaciona `secondary` e `tertiary` mais ao redor da roda. Visualmente mais carregado.
- `DynamicSchemeVariant.rainbow`, `DynamicSchemeVariant.fruitSalad`: variantes extremas, usadas mais por launchers Material You do que por apps típicos.

Um exemplo concreto. Se sua cor de marca é exatamente `#7B1FA2` e o time de marketing já aprovou esse roxo específico, o `tonalSpot` vai dessaturá-lo. O `fidelity` o preserva:

```dart
// Flutter 3.27.1
final brand = const Color(0xFF7B1FA2);

final lightScheme = ColorScheme.fromSeed(
  seedColor: brand,
  brightness: Brightness.light,
  dynamicSchemeVariant: DynamicSchemeVariant.fidelity,
);
```

Escolha a variante uma vez e aplique-a tanto ao brilho claro quanto ao escuro para que a aparência fique consistente entre temas.

## Pareando esquemas claro e escuro corretamente

Construir duas instâncias de `ColorScheme` a partir da mesma semente (uma por `Brightness`) é a abordagem certa. O framework regenera a paleta tonal por brilho para que as razões de contraste fiquem acima dos mínimos do M3. Não inverta as cores você mesmo.

```dart
// Flutter 3.27.1
final seed = Colors.indigo;

final light = ColorScheme.fromSeed(
  seedColor: seed,
  brightness: Brightness.light,
);
final dark = ColorScheme.fromSeed(
  seedColor: seed,
  brightness: Brightness.dark,
);

return MaterialApp(
  theme: ThemeData(colorScheme: light),
  darkTheme: ThemeData(colorScheme: dark),
  themeMode: ThemeMode.system,
  home: const Home(),
);
```

Um bug comum aqui: construir o tema claro com `Brightness.light` mas esquecer de passar `Brightness.dark` para o tema escuro. O esquema escuro então reusa os tons claros, que ficam desbotados sobre superfície preta e falham o contraste WCAG AA no texto do corpo. Sempre passe os dois.

Se você precisar de mais controle sobre o contraste, `ColorScheme.fromSeed` aceita um `contrastLevel` de `-1.0` (menor contraste) a `1.0` (maior contraste). O padrão `0.0` corresponde à especificação do M3. Contraste mais alto é útil quando seu app precisa atender a auditorias de acessibilidade corporativas.

## Usando uma cor de marca mantendo a geração do M3

Às vezes a cor de marca é inegociável, mas o resto da paleta está em aberto. Use `ColorScheme.fromSeed` e sobrescreva um único papel:

```dart
// Flutter 3.27.1
final scheme = ColorScheme.fromSeed(
  seedColor: Colors.indigo,
  brightness: Brightness.light,
).copyWith(
  primary: const Color(0xFF1E3A8A), // exact brand
);
```

Isso mantém todo o resto (`secondary`, `tertiary`, `surface`, etc.) na paleta derivada algoritmicamente e fixa apenas `primary`. Não sobrescreva mais do que um ou dois papéis. O ponto principal do sistema M3 é que os papéis sejam mutuamente consistentes. Fixar quatro cores normalmente quebra o contraste em algum lugar.

Uma alternativa mais segura quando você tem múltiplas cores de marca obrigatórias é harmonizá-las contra a semente em vez de substituir papéis. As Material Color Utilities expõem `MaterialDynamicColors.harmonize`, disponível através do pacote [`dynamic_color`](https://pub.dev/packages/dynamic_color):

```dart
// Flutter 3.27.1, dynamic_color 1.7.0
import 'package:dynamic_color/dynamic_color.dart';

final brandError = const Color(0xFFD32F2F);
final harmonized = brandError.harmonizeWith(scheme.primary);
```

`harmonizeWith` desloca ligeiramente o tom de marca em direção à semente para que os dois coexistam visualmente, sem perder a identidade da marca. Esta é a ferramenta certa quando o design system exige um vermelho exato, por exemplo, para botões de erro ou destrutivos.

## Material You: cor dinâmica no Android 12+

Se você publica no Android 12 ou superior, o sistema pode entregar a você um `ColorScheme` derivado do papel de parede. Conecte-o com o `DynamicColorBuilder` do `dynamic_color`. No iOS, na web, no desktop ou em Android antigo, o builder retorna `null` e você cai de volta na sua semente.

```dart
// Flutter 3.27.1, dynamic_color 1.7.0
import 'package:dynamic_color/dynamic_color.dart';
import 'package:flutter/material.dart';

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return DynamicColorBuilder(
      builder: (lightDynamic, darkDynamic) {
        final ColorScheme light = lightDynamic ??
            ColorScheme.fromSeed(
              seedColor: Colors.indigo,
              brightness: Brightness.light,
            );
        final ColorScheme dark = darkDynamic ??
            ColorScheme.fromSeed(
              seedColor: Colors.indigo,
              brightness: Brightness.dark,
            );

        return MaterialApp(
          theme: ThemeData(colorScheme: light),
          darkTheme: ThemeData(colorScheme: dark),
          themeMode: ThemeMode.system,
          home: const Home(),
        );
      },
    );
  }
}
```

Uma sutileza: `lightDynamic` e `darkDynamic` nem sempre são derivados do mesmo papel de parede. Em alguns dispositivos Pixel, o esquema escuro vem de outra fonte. Trate-os como independentes. Se você precisar harmonizar um vermelho de marca com qualquer esquema com o qual o usuário tenha terminado, faça `brandRed.harmonizeWith(scheme.primary)` por build, não uma única vez no startup.

## Lendo a cor nos seus widgets

Uma vez que o esquema esteja definido, acesse os papéis via `Theme.of(context).colorScheme`. Não codifique valores hex dentro dos widgets e não referencie os getters do M2 `primaryColor` / `accentColor`.

```dart
// Flutter 3.27.1
class CallToAction extends StatelessWidget {
  const CallToAction({super.key, required this.label});
  final String label;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return FilledButton(
      style: FilledButton.styleFrom(
        backgroundColor: scheme.primary,
        foregroundColor: scheme.onPrimary,
      ),
      onPressed: () {},
      child: Text(label),
    );
  }
}
```

`FilledButton` já usa `primary` e `onPrimary` por padrão, então o `styleFrom` explícito está aí apenas para demonstrar os nomes dos papéis. A maioria dos widgets M3 tem padrões sensatos, então a resposta mais simples para "como estilizo meus botões com a cor de destaque" é "escolha o widget certo", não "sobrescreva o style".

Um mapeamento rápido para a transição de M2 para M3:

| Ideia M2 | Papel M3 |
| --- | --- |
| `accentColor` em destaque de toggles, sliders, FAB | `primary` |
| `accentColor` usado como fundo suave de chip | `secondaryContainer` com texto `onSecondaryContainer` |
| `accentColor` usado como um "terceiro" destaque | `tertiary` |
| `primaryColor` em app bar | `primary` (ou `surface` para o app bar M3 padrão) |
| `cardColor` | `surfaceContainer` |
| `dividerColor` | `outlineVariant` |
| `disabledColor` | `onSurface` em 38% de opacidade |

## Coisas que parecem corretas mas estão erradas

Cinco erros que vejo toda semana:

1. **Definir `useMaterial3: false`** em um app novo para "facilitar a estilização" e depois perguntar por que `colorSchemeSeed` ainda produz tons M3. `colorSchemeSeed` é exclusivo do M3. Se você opta por não usar o M3, também opta por não usar esquemas de cor por semente. Permaneça no M3 a menos que tenha um requisito rígido.
2. **Construir um único `ColorScheme` e reusá-lo para os dois temas.** O esquema claro sobre fundo preto falha no contraste. Construa dois a partir da mesma semente.
3. **Chamar `ColorScheme.fromSeed` dentro de `build()`** de um widget no topo da árvore. Roda as Material Color Utilities a cada rebuild, o que não é catastrófico mas é desperdício. Construa o esquema uma vez no `main` ou no `State` do seu `App`, e então passe-o para baixo.
4. **Usar `Colors.deepPurple.shade300` como semente.** Sementes funcionam melhor quando são saturadas e claramente coloridas. Uma variante desbotada te dá uma paleta desbotada. Passe a cor base (por exemplo, `Colors.deepPurple`, que é a variante 500) e deixe `tonalSpot` fazer o trabalho de dessaturação para os papéis mais claros.
5. **Codificar uma cor hex no FAB ou no thumb selecionado do `Switch`** porque "a cor de destaque sumiu". O papel é `primary`. Se `primary` não fica bem nessa superfície, sua variante está errada, não seu widget.

## Limpando um app antigo: uma migração de 5 minutos

Se o app já tem `accentColor` ou `primarySwatch` em algum lugar, a migração correta mais barata é:

1. Remover `accentColor` e `primarySwatch` de `ThemeData(...)`.
2. Adicionar `colorSchemeSeed: <seu primary antigo>`.
3. Remover `useMaterial3: false` se você o tiver; M3 é o padrão em 3.16+.
4. Buscar no projeto por `Theme.of(context).accentColor`, `theme.primaryColor` e `theme.colorScheme.background` (renomeado para `surface` em Flutters mais novos), e substituir cada um pelo papel M3 certo da tabela acima.
5. Rodar `flutter analyze`. Tudo que ainda avisar sobre uma propriedade de tema obsoleta recebe o mesmo tratamento.

A maior mudança visual que você verá depois disso é que o fundo padrão do `AppBar` agora é `surface`, não `primary`. Se você quiser de volta o app bar colorido, defina `appBarTheme: AppBarTheme(backgroundColor: scheme.primary, foregroundColor: scheme.onPrimary)`. Muitos times descobrem depois que, na verdade, preferiam o app bar M3 com `surface` depois de se acostumar.

## Leitura relacionada

Se você está migrando um app Flutter maior ao mesmo tempo, o [passo a passo de migração de GetX para Riverpod](/pt-br/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) e o [guia para perfilar jank com o DevTools](/pt-br/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) cobrem duas coisas que costumam aparecer durante uma atualização de tema: rotatividade de gerenciamento de estado e tempestades surpresa de rebuild. Para pontes nativas (por exemplo, expor um sinal de tema do sistema que você não consegue só pelo Flutter), veja [adicionar código específico de plataforma sem plugins](/pt-br/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/). E se sua matriz de CI cobre SDKs antigos e novos do Flutter enquanto você migra, o post sobre [mirar múltiplas versões do Flutter em um único pipeline de CI](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) mantém ambos os branches verdes.

## Fontes

- API do Flutter: [`ColorScheme.fromSeed`](https://api.flutter.dev/flutter/material/ColorScheme/ColorScheme.fromSeed.html)
- API do Flutter: [`ThemeData.colorSchemeSeed`](https://api.flutter.dev/flutter/material/ThemeData/colorSchemeSeed.html)
- API do Flutter: [`DynamicSchemeVariant`](https://api.flutter.dev/flutter/material/DynamicSchemeVariant.html)
- Especificação do Material 3: [papéis de cor](https://m3.material.io/styles/color/roles)
- pub.dev: [`dynamic_color`](https://pub.dev/packages/dynamic_color) para Material You e harmonização
