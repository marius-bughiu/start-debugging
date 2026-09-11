---
title: "Correção: The argument type 'TextTheme' can't be assigned to the parameter type 'TextTheme?' com google_fonts"
description: "Seu app importa material_ui, mas o google_fonts 8.2.1 ainda retorna o TextTheme do SDK. Monte o TextTheme você mesmo a partir de tear-offs de GoogleFonts.roboto até o google_fonts migrar."
pubDate: 2026-09-11
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "material-design"
  - "google-fonts"
lang: "pt-br"
translationOf: "2026/09/fix-textheme-cant-be-assigned-to-textheme-google-fonts-material-ui"
translatedBy: "claude"
translationDate: 2026-09-11
---

Você tem duas classes diferentes chamadas `TextTheme` no mesmo programa. Seu app importa `package:material_ui/material_ui.dart`, então `ThemeData.textTheme` espera a cópia de `TextTheme` do `material_ui`. O `google_fonts` 8.2.1, a versão mais recente, ainda importa `package:flutter/material.dart`, então `GoogleFonts.robotoTextTheme()` retorna a cópia do SDK. O Dart trata as duas como tipos sem relação. A correção que funciona hoje: pare de chamar os helpers `...TextTheme()` e aplique a fonte estilo por estilo com um tear-off de `GoogleFonts.roboto`, que retorna um `TextStyle`, um tipo que as duas cópias compartilham. O `MaterialUiCompatibilityBridge` não resolve isso, porque é um erro de compilação.

Tudo abaixo foi reproduzido no Flutter 3.44.8 (Dart 3.12.2) com `material_ui` 1.2.0, `cupertino_ui` 1.0.2 e `google_fonts` 8.2.1, e conferido contra o código-fonte do `google_fonts` no branch main de `flutter/packages` em 2026-09-11. O mesmo erro se reproduz na linha estável 3.47 e no master, porque a incompatibilidade está no pacote, não no SDK.

## O que o analyzer e o compilador imprimem

`flutter analyze` e a IDE mostram a forma curta, que parece não fazer sentido porque os dois nomes de tipo são idênticos:

```text
error • The argument type 'TextTheme' can't be assigned to the parameter type 'TextTheme?'.  • lib/main.dart:13:20 • argument_type_not_assignable
```

O compilador front end, que roda em `flutter run`, `flutter build` e `flutter test`, ajuda mais. Ele numera os dois tipos e diz onde cada um fica:

```text
lib/main.dart:13:47: Error: The argument type 'TextTheme/*1*/' can't be assigned to the parameter type 'TextTheme/*2*/?'.
 - 'TextTheme/*1*/' is from 'package:flutter/src/material/text_theme.dart' ('/opt/homebrew/share/flutter/packages/flutter/lib/src/material/text_theme.dart').
 - 'TextTheme/*2*/' is from 'package:material_ui/src/text_theme.dart' ('/Users/marius/.pub-cache/hosted/pub.dev/material_ui-1.2.0/lib/src/text_theme.dart').
        textTheme: GoogleFonts.robotoTextTheme(),
                                              ^
```

Essa segunda mensagem é o diagnóstico. Se a sua cita `package:flutter/src/material/...` e `package:material_ui/src/...`, você está no lugar certo. Se ela cita duas outras bibliotecas, pule para a seção de erros parecidos no final.

## Por que existem duas classes TextTheme

Desde o Flutter 3.44, Material e Cupertino são distribuídos como os pacotes independentes `material_ui` e `cupertino_ui`. O `material_ui` 1.0.0, publicado em 2026-08-12, é uma cópia da biblioteca Material que foi congelada no SDK em abril. Não é um re-export. `material_ui/lib/src/text_theme.dart` declara a sua própria `class TextTheme`, assim como declara seus próprios `ThemeData`, `Theme` e `ColorScheme`.

No Dart, a identidade de um tipo vem da biblioteca que o declara, não do nome. O `TextTheme` de `package:flutter/src/material/text_theme.dart` e o `TextTheme` de `package:material_ui/src/text_theme.dart` têm os mesmos campos e o mesmo código, mas nenhum é subtipo do outro, então nenhum pode ser atribuído ao outro.

O `google_fonts` 8.2.1 foi publicado em 2026-07-31, antes de o `material_ui` chegar à 1.0. O seu `lib/src/google_fonts_all_parts.dart` ainda tem:

```dart
// google_fonts 8.2.1, lib/src/google_fonts_all_parts.dart
import 'package:flutter/material.dart';
```

e todo helper `...TextTheme` gerado é construído sobre esse import:

```dart
// google_fonts 8.2.1, lib/src/google_fonts_parts/part_r.dart (trimmed)
static TextTheme robotoTextTheme([TextTheme? textTheme]) {
  textTheme ??= ThemeData.light().textTheme;
  return TextTheme(
    displayLarge: roboto(textStyle: textTheme.displayLarge),
    // ...14 more styles
  );
}
```

Tanto o parâmetro quanto o tipo de retorno são o `TextTheme` do SDK. Assim que o seu arquivo importa `material_ui` em vez de `package:flutter/material.dart`, que é exatamente o que `dart fix --apply --code=migrate_design_widgets` faz, toda chamada a `GoogleFonts.xxxTextTheme()` para de compilar. Isso é acompanhado em [flutter/flutter#191067](https://github.com/flutter/flutter/issues/191067), aberta no dia seguinte ao lançamento do `material_ui` 1.0.0.

## Repro mínimo

```yaml
# pubspec.yaml, Flutter 3.44.8
dependencies:
  flutter:
    sdk: flutter
  google_fonts: ^8.2.1
  material_ui: ^1.2.0
```

```dart
// Flutter 3.44.8, material_ui 1.2.0, google_fonts 8.2.1
import 'package:google_fonts/google_fonts.dart';
import 'package:material_ui/material_ui.dart';

void main() => runApp(const App());

class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      theme: ThemeData(
        textTheme: GoogleFonts.robotoTextTheme(), // error here
      ),
      home: const Scaffold(body: Center(child: Text('Hello'))),
    );
  }
}
```

Troque o import de volta para `package:flutter/material.dart` e compila, e é por isso que tantos relatos desse erro dizem "funcionava antes".

## Por que o MaterialUiCompatibilityBridge não ajuda

A ponte que o `material_ui` 0.0.3 adicionou é a primeira coisa que as pessoas tentam, e também foi a primeira sugestão de um mantenedor na #191067. Ela não corrige este erro, e não tem como corrigir. A ponte é um widget. Ela insere os inherited widgets legados `Theme` e `Localizations` na árvore para que um pacote não migrado que chama `Theme.of(context)` em runtime encontre alguma coisa. Isso cobre dependências que *leem* estado do Material a partir do `BuildContext`.

O `google_fonts` não lê nada da árvore. Ele *retorna* um tipo do Material do SDK na sua API pública, e esse valor entra no seu código como argumento, que o verificador de tipos rejeita antes de qualquer widget existir. [flutter/flutter#191448](https://github.com/flutter/flutter/issues/191448) documenta esse limite em termos gerais e cita o caso do `google_fonts` como o exemplo first-party. Se o código não compila, nenhum widget wrapper entra em jogo.

## Correção 1: aplique a fonte estilo por estilo com um tear-off (recomendado)

`TextStyle` é declarado em `package:flutter/painting.dart`, que faz parte do SDK e é compartilhado pelas duas cópias do Material. `GoogleFonts.roboto(...)` retorna um `TextStyle`. Então a única peça que você precisa substituir é o loop de quinze linhas que o helper `...TextTheme` faz por você, e você pode escrevê-lo contra o `TextTheme` do `material_ui`:

```dart
// lib/theme/google_text_theme.dart
// Flutter 3.44.8, Dart 3.12.2, material_ui 1.2.0, google_fonts 8.2.1
import 'package:google_fonts/google_fonts.dart';
import 'package:material_ui/material_ui.dart';

/// Applies a Google Font to every style of a material_ui [TextTheme].
///
/// Pass a tear-off such as `GoogleFonts.roboto`. Only [TextStyle] crosses
/// the package boundary, and TextStyle lives in package:flutter/painting.dart,
/// which both copies of Material share.
TextTheme withGoogleFont(
  TextTheme base,
  TextStyle Function({TextStyle? textStyle}) font,
) {
  TextStyle? apply(TextStyle? style) =>
      style == null ? null : font(textStyle: style);

  return base.copyWith(
    displayLarge: apply(base.displayLarge),
    displayMedium: apply(base.displayMedium),
    displaySmall: apply(base.displaySmall),
    headlineLarge: apply(base.headlineLarge),
    headlineMedium: apply(base.headlineMedium),
    headlineSmall: apply(base.headlineSmall),
    titleLarge: apply(base.titleLarge),
    titleMedium: apply(base.titleMedium),
    titleSmall: apply(base.titleSmall),
    bodyLarge: apply(base.bodyLarge),
    bodyMedium: apply(base.bodyMedium),
    bodySmall: apply(base.bodySmall),
    labelLarge: apply(base.labelLarge),
    labelMedium: apply(base.labelMedium),
    labelSmall: apply(base.labelSmall),
  );
}
```

O tipo do parâmetro `font` é o truque que mantém as chamadas curtas. Todo método de fonte gerado tem a assinatura `TextStyle Function({TextStyle? textStyle, Color? color, double? fontSize, ...})`. Um tipo de função com mais parâmetros nomeados opcionais é subtipo de um com menos, então `GoogleFonts.roboto`, `GoogleFonts.lato` ou `GoogleFonts.pangolin` podem ser passados diretamente.

Depois monte o tema primeiro e substitua o text theme dele:

```dart
// lib/main.dart
// Flutter 3.44.8, Dart 3.12.2, material_ui 1.2.0, google_fonts 8.2.1
import 'package:google_fonts/google_fonts.dart';
import 'package:material_ui/material_ui.dart';

import 'theme/google_text_theme.dart';

ThemeData buildTheme(Brightness brightness) {
  final base = ThemeData(
    brightness: brightness,
    colorSchemeSeed: Colors.indigo,
  );
  return base.copyWith(
    textTheme: withGoogleFont(base.textTheme, GoogleFonts.roboto),
  );
}

class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      home: const Scaffold(body: Center(child: Text('Hello'))),
    );
  }
}
```

Com isso, o `flutter analyze` fica limpo, e um widget test confirma que a saída bate com o que `GoogleFonts.robotoTextTheme()` produzia: todo estilo recebe `fontFamily: 'Roboto_regular'` com `fontFamilyFallback: ['Roboto']`, que é como o `google_fonts` nomeia uma variante carregada.

Esta versão também é melhor que a chamada que ela substitui em um aspecto. `robotoTextTheme()` sem argumento parte de `ThemeData.light().textTheme`, então se você a reutilizava em `darkTheme` sem passar `ThemeData.dark().textTheme`, ficava com texto escuro sobre uma superfície escura. Derivar de `base.textTheme` para cada brightness acerta as cores por construção. No teste acima, o `bodyMedium` claro resolve para um quase preto `Color(0xFF1B1B21)` e o `bodyMedium` escuro para um quase branco `Color(0xFFE4E1E9)`.

Quando a migração chegar no upstream, apagar este arquivo e voltar para `GoogleFonts.robotoTextTheme(base.textTheme)` é uma mudança de uma linha por tema.

### Quando o nome da família só é conhecido em runtime

Se os usuários escolhem uma fonte em uma tela de configurações, você provavelmente chamava `GoogleFonts.getTextTheme(name)`, que tem o mesmo problema. Envolva `getFont`, que retorna um `TextStyle`:

```dart
// Flutter 3.44.8, material_ui 1.2.0, google_fonts 8.2.1
TextTheme withGoogleFontNamed(TextTheme base, String family) =>
    withGoogleFont(
      base,
      ({TextStyle? textStyle}) =>
          GoogleFonts.getFont(family, textStyle: textStyle),
    );
```

Saiba o que isso custa. `getFont` procura a família em `GoogleFonts.asMap()`, um mapa const que referencia todos os métodos de fonte gerados, então o compilador não consegue mais fazer tree-shaking dos que não são usados. O tear-off direto da Correção 1 referencia uma única fonte. Essa diferença de tamanho é o alvo do entry point `google_fonts_lite.dart` em [flutter/packages#11433](https://github.com/flutter/packages/pull/11433); ele teve merge em 2026-09-04, mas ainda não foi publicado. Use `getFont` só se você realmente precisa de um nome em runtime.

## Correção 2: converta um TextTheme legado existente na fronteira

Se o `TextTheme` do SDK chega até você de algum lugar que você não controla, por exemplo um pacote de tema compartilhado que você não pode mudar esta semana, converta-o campo por campo. Importe a biblioteca legada com um prefixo e uma cláusula `show` para que ela não vaze nenhum outro nome para o arquivo:

```dart
// lib/theme/legacy_adapter.dart
// Flutter 3.44.8, Dart 3.12.2, material_ui 1.2.0, google_fonts 8.2.1
// Temporary: delete once google_fonts ships a material_ui release.
import 'package:flutter/material.dart' as legacy show TextTheme;
import 'package:material_ui/material_ui.dart';

extension LegacyTextThemeToMaterialUi on legacy.TextTheme {
  TextTheme toMaterialUi() => TextTheme(
        displayLarge: displayLarge,
        displayMedium: displayMedium,
        displaySmall: displaySmall,
        headlineLarge: headlineLarge,
        headlineMedium: headlineMedium,
        headlineSmall: headlineSmall,
        titleLarge: titleLarge,
        titleMedium: titleMedium,
        titleSmall: titleSmall,
        bodyLarge: bodyLarge,
        bodyMedium: bodyMedium,
        bodySmall: bodySmall,
        labelLarge: labelLarge,
        labelMedium: labelMedium,
        labelSmall: labelSmall,
      );
}
```

```dart
// Flutter 3.44.8, material_ui 1.2.0, google_fonts 8.2.1
final theme = ThemeData(
  textTheme: GoogleFonts.pangolinTextTheme().toMaterialUi(),
);
```

Isso compila porque cada campo é um `TextStyle`. Funciona especificamente para `TextTheme` porque a classe é só um conjunto de quinze estilos. Não se generaliza: a #191448 mostra que o mesmo truque de adaptador falha um nível abaixo para tipos como `FloatingActionButtonLocation`, cujos métodos recebem outros tipos do Material como argumentos. Ele também mantém o padrão só claro descrito acima e reintroduz o import do Material do SDK que a migração deveria remover, então mantenha-o em um único arquivo com um comentário e prefira a Correção 1.

## Correção 3: espere a migração do google_fonts

Dois pull requests migram o próprio `google_fonts`: [flutter/packages#12489](https://github.com/flutter/packages/pull/12489), aberto em 2026-08-17 e vinculado à #191067, e [flutter/packages#12810](https://github.com/flutter/packages/pull/12810), aberto em 2026-09-09 como parte da iniciativa para todo o ecossistema, [flutter/flutter#191322](https://github.com/flutter/flutter/issues/191322). O segundo também eleva o mínimo do pacote para Flutter 3.44 e Dart 3.12. Nenhum dos dois tinha merge em 2026-09-11. Quando um deles entrar, os helpers `...TextTheme` vão receber e retornar o tipo do `material_ui`, e a linha única original vai compilar de novo. Acompanhe o [changelog do google_fonts](https://pub.dev/packages/google_fonts/changelog).

Duas formas de esperar que eu não recomendaria para um app em produção:

- **Reverter o import só no arquivo do tema.** Isso não funciona. O `ThemeData` desse arquivo vira o `ThemeData` do SDK, e o seu `MaterialApp` do `material_ui` o rejeita com o mesmo erro, só que um tipo acima. O app inteiro precisa estar de um lado só.
- **Uma referência git em `dependency_overrides` apontando para o branch de um PR aberto.** Compila, e um comentarista na #191067 oferece exatamente isso. Mas você estará distribuindo código não revisado de um fork. Se fizer mesmo assim, fixe `ref:` em um SHA de commit, não em um branch.

Se por algum motivo você não pode usar a Correção 1, a alternativa honesta é adiar a migração para o `material_ui` até o `google_fonts` lançar a nova versão. A biblioteca Material dentro do SDK está congelada, mas ainda funciona na 3.47.

## Pegadinha: o peso ainda não está no tema

Algo que os helpers `...TextTheme` sempre fizeram e que a Correção 1 herda: `ThemeData.textTheme` guarda só cores e famílias no momento da construção. Os tamanhos e pesos vêm de `Typography.englishLike` e são mesclados depois, quando `Theme.of` localiza o tema. Então, quando o `google_fonts` vê `titleMedium`, o peso é `null`, ele escolhe a variante regular, e o estilo recebe `fontFamily: 'Roboto_regular'`. Em runtime, `Theme.of(context).textTheme.titleMedium` resolve para `Roboto_regular` com `FontWeight.w500`, o que significa que o engine renderiza um estilo de peso 500 a partir do arquivo de peso 400.

Se os seus títulos e labels precisam do arquivo medium de verdade, mescle a geometria antes de aplicar a fonte:

```dart
// Flutter 3.44.8, material_ui 1.2.0, google_fonts 8.2.1
final geometry = Typography.material2021().englishLike.merge(base.textTheme);
final textTheme = withGoogleFont(geometry, GoogleFonts.roboto);
// titleMedium -> fontFamily 'Roboto_500', fontWeight w500
```

Verifiquei os dois resultados em um widget test. A contrapartida: os tamanhos English-like agora ficam fixos, então se você distribui em chinês, japonês ou coreano, escolha a geometria por locale (`Typography.material2021().tall` ou `.dense`). O mesmo raciocínio explica por que `TextTheme.apply(fontFamily: GoogleFonts.roboto().fontFamily)` é uma armadilha: ele define `'Roboto_regular'` em todo estilo, qualquer que seja o peso.

## Erros parecidos que não são este bug

- **`The argument type 'TextTheme' can't be assigned to the parameter type 'CupertinoTextThemeData'`.** Você passou um text theme do Material para `CupertinoThemeData.textTheme`. São classes diferentes por design, relatado lá em 2022 como [material-foundation/flutter-packages#227](https://github.com/material-foundation/flutter-packages/issues/227). Não existe helper `...TextTheme` para Cupertino; monte um `CupertinoTextThemeData` você mesmo e passe objetos de estilo `GoogleFonts.lato()` para o seu `textStyle` e parâmetros relacionados.
- **Mesma mensagem, mas o compilador cita um dos seus próprios arquivos.** Uma classe chamada `TextTheme` no seu código ou em um arquivo de design tokens gerado faz sombra à do Material. A saída numerada do compilador diz qual arquivo renomear.
- **Mesma mensagem para `ColorScheme`.** Esse era o `dynamic_color`, que retornava o `ColorScheme` do SDK a partir de `DynamicColorBuilder`. Está corrigido: o `dynamic_color` 2.1.0 depende do `material_ui`, como o mantenedor confirmou em [material-foundation/flutter-packages#698](https://github.com/material-foundation/flutter-packages/issues/698).
- **Compila, mas os widgets de um pacote quebram com "Could not find an ancestor of type Theme".** Essa é a metade de runtime da mesma separação, e é o caso que o `MaterialUiCompatibilityBridge` de fato corrige.

## Relacionados

- A migração completa da qual este erro surge, incluindo quando você precisa da ponte de compatibilidade, está em [migrar os imports de Material e Cupertino do Flutter para material_ui e cupertino_ui](/pt-br/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/).
- Para o contexto de por que o Material saiu do SDK, veja [o Flutter 3.44 separa Material e Cupertino do SDK](/pt-br/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).
- Se você rodou a reescrita de imports em um monorepo, [rodar o dart fix em um repositório inteiro](/pt-br/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/) mostra como delimitar e revisar pacote por pacote.
- A mesma abordagem de partir do `ThemeData` usada na Correção 1 também vale para cores: [definir a cor de destaque com um ColorScheme do Material 3](/pt-br/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/).
- Para uma falha de busca de ancestral vinda do seu próprio código em vez de uma dependência, leia [como corrigir "No Material widget found" no Flutter](/pt-br/2026/08/fix-no-material-widget-found-in-flutter/).

## Fontes

- [flutter/flutter#191067](https://github.com/flutter/flutter/issues/191067), conflito do `TextTheme` do material_ui com o `google_fonts`
- [flutter/flutter#191448](https://github.com/flutter/flutter/issues/191448), o `MaterialUiCompatibilityBridge` não cobre acoplamento na assinatura da API
- [flutter/flutter#191322](https://github.com/flutter/flutter/issues/191322), migrar os pacotes first-party para `material_ui` e `cupertino_ui`
- [flutter/packages#12489](https://github.com/flutter/packages/pull/12489) e [flutter/packages#12810](https://github.com/flutter/packages/pull/12810), os pull requests abertos de migração do `google_fonts`
- [flutter/packages#11433](https://github.com/flutter/packages/pull/11433), o entry point `google_fonts_lite.dart`
- [google_fonts no pub.dev](https://pub.dev/packages/google_fonts), versão 8.2.1, e o seu [código-fonte](https://github.com/flutter/packages/tree/main/packages/google_fonts)
- [material_ui no pub.dev](https://pub.dev/packages/material_ui), versão 1.2.0, e o seu [changelog](https://pub.dev/packages/material_ui/changelog)
- [argument_type_not_assignable](https://dart.dev/diagnostics/argument_type_not_assignable), diagnósticos do Dart
