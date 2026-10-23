---
title: "Migre um app Flutter de Color.withOpacity para Color.withValues (Flutter 3.27+)"
description: "Substitua os membros obsoletos Color.withOpacity, opacity, value, red, green, blue e alpha por withValues, .a/.r/.g/.b e toARGB32. O que o dart fix reescreve para você, os quatro getters que ele deixa para trás, por que asserções de cor exata e buscas em Map<Color, T> quebram após a troca, e como withOpacity descarta silenciosamente o Display P3. Medido no Flutter 3.44.8 com Dart 3.12.2."
pubDate: 2026-10-23
updatedDate: 2026-10-23
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "colors"
lang: "pt-br"
translationOf: "2026/10/migrate-a-flutter-app-from-color-withopacity-to-color-withvalues"
translatedBy: "claude"
translationDate: 2026-10-23
---

`Color.withOpacity` está obsoleto desde o Flutter 3.27.0, quando o `dart:ui` passou a armazenar os componentes de cor como valores de ponto flutuante com um `ColorSpace`. A substituição é `color.withValues(alpha: x)`, e seus equivalentes são `.a` para `.opacity`, `toARGB32()` para `.value`, e `.r`/`.g`/`.b` (doubles de 0.0 a 1.0) para `.red`/`.green`/`.blue` (ints de 0 a 255). O `dart fix --apply` reescreve `withOpacity`, `opacity` e `value` para você, mas deixa `red`, `green`, `blue` e `alpha` por sua conta. A troca não é puramente cosmética: `withOpacity(0.5)` armazena um alpha de `0.50196` (128/255), enquanto `withValues(alpha: 0.5)` armazena exatamente `0.5`, então essas duas cores deixam de ser `==`. Qualquer teste que faça `expect(color, const Color(0x80000000))` ou qualquer `Map<Color, T>` indexado pelo valor antigo quebra após a migração. Um app típico leva de 30 minutos a uma hora, a maior parte nos testes. Tudo abaixo foi executado no Flutter 3.44.8 (Dart 3.12.2).

## Por que sair do withOpacity agora

- **Precisão.** `withOpacity` quantiza o alpha em 8 bits: o corpo dele é literalmente `withAlpha((255.0 * opacity).round())`. `withValues` mantém o double que você passou. Em animações que fazem fade por muitos passos pequenos, essa é a diferença entre 256 níveis de alpha possíveis e níveis contínuos.
- **Espaços de cor.** `withValues` preserva o `colorSpace` do receptor. `withOpacity` e `withAlpha` passam por `Color.fromARGB`, que sempre cria uma cor sRGB, então uma cor Display P3 volta marcada como sRGB. Mais sobre isso nas armadilhas.
- **As obsolescências vão virar remoções.** O guia de migração do Flutter descreve a remoção da API de 8 bits como "Phase 2", que ainda não chegou. Quando chegar, todo `withOpacity`, `.value` e `.red` restante vira erro de compilação em vez de um diagnóstico `info`.
- **Ruído.** Um app grande pode ter centenas de ocorrências de `deprecated_member_use` só desses getters, o que enterra as obsolescências em que você realmente precisa agir.

## O que muda no app

| Área | Mudança | Gravidade |
| --- | --- | --- |
| Testes com igualdade exata de `Color` | `withValues(alpha: 0.5) != const Color(0x80000000)`; use `isSameColorAs` | alta |
| Chaves de `Map<Color, T>` / `Set<Color>` | Cores antigas e novas têm hash diferente; as buscas retornam `null` | alta |
| Aritmética com `.red`/`.green`/`.blue` | As substituições são doubles de 0.0 a 1.0; limites inteiros como `< 128` quebram silenciosamente | alta |
| Pontos de chamada de `withOpacity(x)` | Viram `withValues(alpha: x)`, aplicado pelo `dart fix` | baixa |
| `.value` / `.opacity` | Viram `toARGB32()` / `.a`, aplicado pelo `dart fix` | baixa |
| Classes que fazem `implements Color` | Precisam implementar `a`, `r`, `g`, `b`, `colorSpace`, `toARGB32`, `withValues` | média |

## Checklist prévio

- Flutter 3.27.0 ou mais recente, de preferência o stable atual. `CupertinoDynamicColor.withValues` e sua regra de `dart fix` vieram depois (as mensagens de obsolescência dizem "deprecated after v3.33.0-1.0.pre"), então apps com muito Cupertino devem estar no 3.35 ou mais recente.
- Um `git status` limpo, para que você possa revisar a saída do `dart fix` como um único diff.
- Uma suíte de testes passando antes de começar. Falhas de igualdade de cor são o principal sinal de que algo mudou, e você quer que sejam as únicas falhas.
- Uma lista dos lugares que persistem cores (shared preferences, JSON, banco de dados). É ali que as conversões para inteiro importam.

## Passos da migração

1. **Faça o inventário dos membros obsoletos.** Execute `flutter analyze` e filtre pelos getters de cor, para saber o que o `dart fix` não vai tocar:

    ```bash
    # Flutter 3.44.8
    flutter analyze 2>&1 | grep deprecated_member_use | grep -E "'(withOpacity|opacity|value|red|green|blue|alpha)'"
    ```

    Neste arquivo de exemplo:

    ```dart
    // Flutter 3.44.8, Dart 3.12.2 (before)
    import 'package:flutter/material.dart';

    Color scrim(Color base) => base.withOpacity(0.54);

    bool isDark(Color c) => (c.red * 0.299 + c.green * 0.587 + c.blue * 0.114) < 128;

    int serialize(Color c) => c.value;

    double fade(Color c) => c.opacity;

    int alphaByte(Color c) => c.alpha;
    ```

    o analisador reporta sete infos `deprecated_member_use`, uma por membro, cada uma com a substituição sugerida, como `'red' is deprecated and shouldn't be used. Use (*.r * 255.0).round().clamp(0, 255).`

    Verifique: você tem uma contagem. Guarde-a, você vai compará-la no passo 3.

2. **Aplique as correções guiadas por dados.** O Flutter traz regras `fix_data` para exatamente três membros de `Color`: `withOpacity` para `withValues(alpha: ...)`, `opacity` para `a`, e `value` para `toARGB32()`. Visualize e depois aplique:

    ```bash
    # Flutter 3.44.8
    dart fix --dry-run .
    dart fix --apply .
    ```

    O dry run no exemplo reporta `deprecated_member_use - 3 fixes`, e o diff é:

    ```diff
    -Color scrim(Color base) => base.withOpacity(0.54);
    +Color scrim(Color base) => base.withValues(alpha: 0.54);
    -int serialize(Color c) => c.value;
    +int serialize(Color c) => c.toARGB32();
    -double fade(Color c) => c.opacity;
    +double fade(Color c) => c.a;
    ```

    As mesmas regras existem para `CupertinoDynamicColor.withOpacity`. Em um monorepo, execute uma vez a partir da raiz; o analisador encontra todo `pubspec.yaml` aninhado.

    Verifique: o `flutter analyze` agora reporta quatro obsolescências de cor em vez de sete, todas de `red`, `green`, `blue` ou `alpha`.

3. **Reescreva os getters inteiros à mão, mantendo a escala.** É aqui que nascem os bugs de verdade. `.red` retorna um `int` de 0 a 255; `.r` retorna um `double` de 0.0 a 1.0. Trocar um pelo outro compila sem problemas porque ambos são `num`, e então a comparação fica errada para sempre:

    ```dart
    // Flutter 3.44.8: compiles, always returns true
    bool isDark(Color c) => (c.r * 0.299 + c.g * 0.587 + c.b * 0.114) < 128;
    ```

    Ou mova a expressão inteira para a escala de 0 a 1, ou converta explicitamente onde você realmente precisa de bytes:

    ```dart
    // Flutter 3.44.8, Dart 3.12.2 (after)
    bool isDark(Color c) => (c.r * 0.299 + c.g * 0.587 + c.b * 0.114) < 0.5;

    // Or, better for contrast decisions, the built-in WCAG luminance:
    bool isDarkWcag(Color c) => c.computeLuminance() < 0.179;

    extension ColorBytes on Color {
      int get alpha8 => (a * 255.0).round().clamp(0, 255);
      int get red8 => (r * 255.0).round().clamp(0, 255);
      int get green8 => (g * 255.0).round().clamp(0, 255);
      int get blue8 => (b * 255.0).round().clamp(0, 255);
    }

    int alphaByte(Color c) => c.alpha8;
    ```

    A extensão usa a fórmula exata que a mensagem de obsolescência sugere, e coincide com `toARGB32()`, que internamente faz `(x * 255.0).round().clamp(0, 255)` por canal. Para `Colors.blue[500]` (`0xFF2196F3`), `.red` é `33` e `.r` é `0.12941176470588237`.

    Verifique: o `flutter analyze` reporta zero obsolescências de cor, e `grep -rnE '\.(red|green|blue)\b' lib/` não mostra nada comparando um double no estilo de `.r` com um literal do tamanho de um byte.

4. **Corrija as asserções de cor exata nos testes.** Execute a suíte. Qualquer teste que compare uma cor migrada com um literal inteiro agora falha, porque o literal passa pelo construtor de 8 bits e recebe alpha 128/255:

    ```dart
    // Flutter 3.44.8, flutter_test
    import 'package:flutter/material.dart';
    import 'package:flutter_test/flutter_test.dart';

    Color scrim() => Colors.black.withValues(alpha: 0.5);

    void main() {
      // Fails after the migration
      test('exact', () => expect(scrim(), const Color(0x80000000)));
      // Passes
      test('same color', () => expect(scrim(), isSameColorAs(const Color(0x80000000))));
    }
    ```

    O que falha imprime:

    ```text
    Expected: Color:<Color(alpha: 0.5020, red: 0.0000, green: 0.0000, blue: 0.0000, colorSpace: ColorSpace.sRGB)>
      Actual: Color:<Color(alpha: 0.5000, red: 0.0000, green: 0.0000, blue: 0.0000, colorSpace: ColorSpace.sRGB)>
    ```

    `isSameColorAs` compara cada componente com um limite padrão de `colorEpsilon = 0.004` (cerca de um passo de 8 bits) e exige o mesmo `colorSpace`. Use-o em todo lugar em que um teste compare cores produzidas por aritmética. Se preferir manter a expectativa exata, escreva-a com o mesmo construtor que o código usa: `Colors.black.withValues(alpha: 0.5)`.

    Verifique: o `flutter test` está verde, e as únicas edições nos testes são trocas de matcher, não novos valores esperados.

5. **Audite coleções indexadas por cor e valores persistidos.** Procure por `Map<Color`, `Set<Color>`, `switch` sobre cores e qualquer coisa que armazene `toARGB32()`. Os dois sentidos do ciclo de ida e volta importam, e a próxima seção mostra o comportamento medido.

    Verifique: um teste de unidade que salva e recarrega uma cor escolhida pelo usuário faz a asserção com `isSameColorAs`, não com `==`.

## Verificação

Depois dos passos acima, execute:

```bash
# Flutter 3.44.8
flutter analyze
flutter test
dart fix --dry-run .
```

O `flutter analyze` não deve mostrar `deprecated_member_use` em membros de `Color`, o `flutter test` deve estar verde, e o `dart fix --dry-run` deve imprimir `Nothing to fix!` para as regras de cor. Depois, abra o app e confira as telas que usam sobreposições translúcidas (scrims, botões desabilitados, cores de ripple e hover do seu tema). Visualmente nada deve se mover: para qualquer alpha que você passava a `withOpacity`, o `toARGB32()` da cor antiga e da nova é idêntico (`0x80000000` para ambas com 0.5), então tudo que é quantizado em 8 bits acaba igual.

## Como reverter

A migração é reversível: `withOpacity`, `.opacity`, `.value` e os getters inteiros ainda existem no 3.44.8 e mantêm a semântica antiga, então um `git revert` no commit da migração restaura o comportamento exato. O que você não consegue reverter é uma versão futura do Flutter em que a Phase 2 os tenha removido. Se precisar permanecer na API obsoleta por um tempo, suprima o diagnóstico por arquivo com `// ignore_for_file: deprecated_member_use` em vez de globalmente, para que as outras obsolescências continuem visíveis.

## Armadilhas de uma migração real

Tudo isto vem de um único teste de sondagem executado no Flutter 3.44.8. Os números são saída impressa, não estimativas.

### A cor antiga e a nova não são iguais, nem têm o mesmo hash

```dart
// Flutter 3.44.8
final o = Colors.black.withOpacity(0.5);
final v = Colors.black.withValues(alpha: 0.5);

print(o.a);                          // 0.5019607843137255
print(v.a);                          // 0.5
print(o == v);                       // false
print(o.toARGB32() == v.toARGB32()); // true (both 0x80000000)
print({o: 'x'}[v]);                  // null
```

`Color.==` compara `a`, `r`, `g`, `b` e `colorSpace` como doubles, e `hashCode` calcula o hash dos mesmos campos. Se metade de uma base de código estiver migrada e a outra não, uma cor produzida em uma das metades não encontrará sua entrada em um mapa construído pela outra. Migre uma tabela de consulta e todos os pontos de chamada que a consultam no mesmo commit, ou indexe o mapa por `toARGB32()`.

### Persistir com toARGB32 traz de volta a cor antiga

```dart
// Flutter 3.44.8
final stored = v.toARGB32();
print(Color(stored) == v); // false
print(Color(stored) == o); // true
```

`toARGB32()` tem perda por design: ele arredonda cada canal para um byte. Uma cor restaurada com `Color(int)` recebe alpha `128/255`, que é o valor do `withOpacity`, não o que você salvou. Isso é aceitável para desenhar e errado para verificações de igualdade como "o destaque salvo ainda é o selecionado". Se ciclos de ida e volta exatos importam, armazene os quatro doubles e o nome do espaço de cor, e reconstrua com `Color.from(alpha: ..., red: ..., green: ..., blue: ..., colorSpace: ...)`.

### `.a` não é `.opacity` com outro nome

O `dart fix` renomeia `opacity` para `a`, mas o getter antigo era calculado a partir do alpha de 8 bits. Para `Colors.black.withValues(alpha: 0.3)`, `.opacity` retorna `0.30196078431372547` e `.a` retorna `0.3`. Código que comparava `opacity` com um literal como `0.30196` ou o usava como chave de mapa muda de comportamento após a renomeação. É raro, mas é a única mudança do `dart fix` que não é semanticamente neutra.

### withOpacity converte silenciosamente cores Display P3 para sRGB

```dart
// Flutter 3.44.8
const p3 = Color.from(alpha: 1, red: 1, green: 0, blue: 0, colorSpace: ColorSpace.displayP3);

print(p3.withOpacity(0.5));
// Color(alpha: 0.5020, red: 1.0000, green: 0.0000, blue: 0.0000, colorSpace: ColorSpace.sRGB)
print(p3.withValues(alpha: 0.5));
// Color(alpha: 0.5000, red: 1.0000, green: 0.0000, blue: 0.0000, colorSpace: ColorSpace.displayP3)
```

O vermelho P3 está fora do sRGB (convertido para sRGB estendido ele é `red: 1.0931, green: -0.2267, blue: -0.1501`), mas `withOpacity` apenas reetiqueta os mesmos valores de componente como sRGB, então a cor fica visivelmente mais opaca. `withAlpha(128)` faz o mesmo, e ele não está obsoleto, então não aparece no analisador. Se o seu app usa cores de marca de gamut amplo, procure também por `withAlpha(` e substitua por `withValues(alpha: n / 255)`.

### withValues não valida o intervalo

`Colors.black.withOpacity(1.5)` lança um `AssertionError` em builds de debug. `Colors.black.withValues(alpha: 1.5)` funciona e armazena `a == 1.5`; `toARGB32()` o limita a `0xff000000`, mas a igualdade e qualquer outra coisa que leia `.a` enxerga `1.5`. Se o alpha vem de aritmética (um valor de animação vezes um fator, por exemplo), limite-o você mesmo com `clampDouble(x, 0, 1)`. `Color.lerp` limita sua saída, então os tweens são seguros.

### Classes que implementam Color

O guia observa que o Flutter pretende tornar `Color` `sealed` eventualmente. Se você tem uma classe que faz `implements Color` (alguns pacotes de tema fizeram isso para envolver uma cor dinâmica), ela agora precisa implementar os getters de ponto flutuante, `colorSpace`, `toARGB32` e `withValues`. A direção recomendada é a composição: guardar um campo `Color` e expô-lo, em vez de fingir ser uma. O próprio `CupertinoDynamicColor` é a implementação de referência: cada override encaminha para `_effectiveColor`.

## Relacionados

- As três reescritas mecânicas do passo 2 são correções guiadas por dados padrão; [executar o dart fix em um repositório inteiro](/pt-br/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/) cobre as flags, os casos em que ele reporta "Nothing to fix" em um repositório sujo, e por que o código de saída dele é inútil no CI.
- A maioria das chamadas de `withOpacity` em apps fica perto de cores de tema. Se você vai mexer nelas de qualquer forma, [definir a cor de destaque com um ColorScheme do Material 3](/pt-br/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/) mostra como derivar essas variantes translúcidas do esquema em vez de ajustar alphas na mão.
- Design tokens personalizados são onde `Color.lerp` e comparações exatas de cor se encontram; veja [definir design tokens com ThemeExtension no Flutter](/pt-br/2026/10/how-to-define-custom-design-tokens-with-themeextension-in-flutter/).
- Outra obsolescência que vai virar erro de compilação em uma atualização futura: [sair do describeEnum antes que o Flutter o remova](/pt-br/2026/09/migrate-off-describeenum-before-flutter-removes-it/).
- A cor de gamut amplo só chega à tela no Impeller; para destinos desktop, [migrar um app Flutter para Windows ou Linux para o Impeller](/pt-br/2026/10/migrate-a-flutter-windows-or-linux-desktop-app-to-impeller/) cobre a troca de renderizador.

## Fontes

- [Migration guide for wide gamut Color](https://docs.flutter.dev/release/breaking-changes/wide-gamut-framework) (docs.flutter.dev)
- [Migration guide for wide gamut CupertinoDynamicColor](https://docs.flutter.dev/release/breaking-changes/wide-gamut-cupertino-dynamic-color) (docs.flutter.dev)
- [`Color.withValues`](https://api.flutter.dev/flutter/dart-ui/Color/withValues.html) e [`Color.withOpacity`](https://api.flutter.dev/flutter/dart-ui/Color/withOpacity.html) (api.flutter.dev)
- [`isSameColorAs` matcher](https://api.flutter.dev/flutter/flutter_test/isSameColorAs.html) (api.flutter.dev)
- [flutter/flutter#127855: Implement wide gamut color support in the Framework](https://github.com/flutter/flutter/issues/127855) e [flutter/engine#54737: Framework wide color](https://github.com/flutter/engine/pull/54737)
- [`fix_dart_ui.yaml` data-driven fixes](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/fix_data/fix_dart_ui.yaml) (flutter/flutter)
