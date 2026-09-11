---
title: "Correção: o Text do Flutter é renderizado fora da tela em uma WebView Android quando o dimensionamento de fonte do sistema está ativado"
description: "O Flutter web 3.41 a 3.44 reporta um override de altura de linha de ~625x quando o textZoom de uma WebView Android não é 100. Atualize para a 3.47 ou limpe o override no MaterialApp.builder."
pubDate: 2026-09-11
template: error-page
tags:
  - "errors"
  - "flutter"
  - "flutter-web"
  - "android"
  - "accessibility"
lang: "pt-br"
translationOf: "2026/09/fix-flutter-text-renders-off-screen-in-an-android-webview-with-font-scaling"
translatedBy: "claude"
translationDate: 2026-09-11
---

Se o seu app Flutter web roda dentro de uma `WebView` Android e todo `Text` simples desaparece assim que o usuário muda o tamanho da fonte do sistema, você está diante de um bug conhecido do engine web. Do Flutter 3.41.0 ao 3.44.9, ele interpreta o `textZoom` da WebView como uma preferência de altura de linha do usuário. `MediaQuery.lineHeightScaleFactorOverride` volta com algo em torno de `624.9`, então uma linha de 18 px é disposta com cerca de 12.900 px de altura e seus glifos são pintados bem abaixo da viewport. Atualize para o Flutter 3.47.0 ou posterior (a 3.47.3 é a stable atual), em que o código de detecção foi reescrito. Em versões mais antigas, limpe o override falso no `MaterialApp.builder`. Se você controla o host Android, também pode fixar o `textZoom` em 100.

Este post trata do Flutter 3.44.8 (Dart 3.12.2), que é a versão do relatório de bug, e o compara com o código-fonte do engine da 3.47.3. O comportamento no nível dos widgets descrito abaixo foi reproduzido com `flutter test` na 3.44.8.

## Como fica a tela quebrada

Não há exceção nem erro no console. As web fonts carregam com HTTP 200, o evento `flutter-first-frame` dispara e o scheduler continua rodando. Os sintomas são todos geométricos:

- Todo widget `Text` fica invisível, enquanto ícones, bordas, imagens e fundos de `Container` continuam sendo pintados.
- Tudo o que vem abaixo do primeiro `Text` em uma `Column` também some, porque o texto inflado empurra o resto milhares de pixels para baixo.
- Barras de altura fixa como `NavigationBar` cortam seus rótulos, e os `TextField`s crescem até o `maxHeight`.
- Em modo release, algumas rotas são substituídas pelo `ErrorWidget` cinza. Em um build de debug, espere um [overflow de RenderFlex](/pt-br/2026/05/fix-renderflex-overflowed-in-flutter/) medido em milhares de pixels, e não os poucos de sempre além da borda.

O gatilho é específico. O mesmo build renderiza bem no Chrome desktop, no app do navegador Chrome no mesmo celular, no GeckoView e em uma WebView no emulador padrão com configurações default. Ele só quebra em uma Android System WebView cujo `textZoom` não seja exatamente 100. O controle deslizante de tamanho de fonte do sistema em Configurações > Acessibilidade define esse valor automaticamente para qualquer WebView que não o sobrescreva.

Imprimir os valores de `MediaQuery` de dentro do app deixa tudo evidente. Em [flutter/flutter#190350](https://github.com/flutter/flutter/issues/190350), o autor do relatório rodou um app padrão de `flutter create` no Flutter 3.44.8 e mudou apenas `adb shell settings put system font_scale`:

```text
font_scale  textZoom  lineHeightScaleFactorOverride  textScaler  Text visible
0.85        85        624.9374824709756              0.85        no
1.0         100       null                           1.0         yes
1.15        115       624.9347955648752              1.15        no
1.3         130       624.9375229225718              1.3         no
```

`textScaler` está correto em todos os passos. `lineHeightScaleFactorOverride` é `null` em 100 e cerca de 624,94 em qualquer outro nível de zoom, tenha o texto ficado menor ou maior. Um valor que permanece o mesmo não importa para que lado a entrada se mova não é uma medição. É um sentinela vazando.

## Por que o engine web reporta uma altura de linha de 625x

Desde o Flutter 3.41, o engine web suporta as preferências de [espaçamento de texto do WCAG 1.4.12](https://www.w3.org/WAI/WCAG21/Understanding/text-spacing.html) que extensões de navegador e folhas de estilo do usuário aplicam. O [PR #178081](https://github.com/flutter/flutter/pull/178081) adicionou isso. O Flutter desenha o texto em um canvas, então não consegue ler esses overrides de CSS a partir do próprio conteúdo. Em vez disso, `EnginePlatformDispatcher._addTypographySettingsObserver` adiciona um elemento `<p>` oculto de sondagem ao `document.body` com estilos inline deliberadamente absurdos e depois o observa com um `ResizeObserver`. Na 3.44.8, a parte relevante de `engine/src/flutter/lib/web_ui/lib/src/engine/platform_dispatcher.dart` é esta:

```dart
// Flutter 3.44.8, lib/web_ui/lib/src/engine/platform_dispatcher.dart (abridged)
const spacingDefault = 9999.0;
_typographyMeasurementElement!.style
  ..lineHeight = '${spacingDefault}px'
  ..letterSpacing = '${spacingDefault}px'
  ..wordSpacing = '${spacingDefault}px'
  ..margin = '0px 0px ${spacingDefault}px 0px';
domDocument.body!.append(_typographyMeasurementElement!);
final double typographyMeasurementElementFontSize =
    parseFontSize(_typographyMeasurementElement!)?.toDouble() ?? _defaultRootFontSize;
final double defaultLineHeightFactor = spacingDefault / typographyMeasurementElementFontSize;

// Inside the ResizeObserver callback:
final double? computedLineHeightScaleFactor =
    fontSize != null && lineHeight != null && lineHeight != spacingDefault
    ? lineHeight / fontSize
    : null;
_updateLineHeightScaleFactorOverride(
  computedLineHeightScaleFactor == defaultLineHeightFactor
      ? null
      : computedLineHeightScaleFactor,
);
```

A ideia é que, se nada fora do Flutter tocou no elemento de sondagem, seu `line-height` computado continua exatamente `9999px` e o override permanece `null`. Qualquer outro valor significa uma preferência do usuário, e sua razão em relação ao tamanho da fonte vira o novo fator de altura de linha.

O `textZoom` da WebView Android quebra as duas verificações. Ele escala o `font-size` raiz e também escala o `line-height` em pixels do elemento de sondagem, o que não é preferência do usuário de forma alguma. Faça as contas para `textZoom` 115 e um tamanho raiz padrão de 16 px:

1. O tamanho da fonte do elemento de sondagem é `16 * 1.15 = 18.4px`, então `defaultLineHeightFactor = 9999 / 18.4 = 543.4`.
2. O `line-height` computado é `9999 * 1.15 = 11498.85px`. Isso não é `9999`, então o engine o trata como um override.
3. `computedLineHeightScaleFactor = 11498.85 / 18.4 = 624.9375`, que é exatamente `9999 / 16`. O fator de zoom se cancela, e é por isso que o valor reportado quase não muda entre níveis de zoom.
4. `624.9375` não é igual a `543.4`, então ele é publicado como `MediaQueryData.lineHeightScaleFactorOverride`.

O framework aceita esse valor sem questionar. `Text.build` lê `MediaQuery.maybeLineHeightScaleFactorOverrideOf(context)` e o força no `TextStyle.height` do span, e no `StrutStyle.height` quando um strut está definido, independentemente de `inherit`. `TextStyle.height` é um multiplicador do tamanho da fonte, como descrito no [post sobre leadingDistribution](/pt-br/2026/01/flutter-text-the-leadingdistribution-detail-that-changes-how-your-ui-breathes/), então a caixa de linha fica 625 vezes mais alta que os glifos. Widgets que constroem um `RichText` diretamente, como `Icon`, nunca consultam o override. É por isso que os ícones sobrevivem em uma tela onde todo o texto sumiu.

Esta é uma variante de um bug anterior. A [#178856](https://github.com/flutter/flutter/issues/178856) descrevia o mesmo valor anormal depois de mudar o tamanho da fonte do navegador em tempo de execução, e o [PR #178862](https://github.com/flutter/flutter/pull/178862) o corrigiu em 2 de dezembro de 2025. Essa correção ainda comparava exatamente com `9999`, então um zoom que já está ativo no primeiro paint passa direto. Um bisect na thread da issue coloca a regressão entre 3.39.0-0.2.pre (boa) e 3.40.0-0.1.pre (ruim). Entre as versões stable, o sentinela de 9999 px está presente em todas as tags de 3.41.0 a 3.44.9 e ausente na 3.38.x.

O renderizador não importa. A thread reproduz o bug com CanvasKit, CanvasKit forçado para CPU e skwasm a partir de um build [`flutter build web --wasm`](/pt-br/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/), porque o defeito está em código Dart compartilhado.

## Reprodução mínima

O lado web é um app padrão que imprime os overrides com `RichText`, para que o relatório continue legível enquanto o bug está ativo:

```dart
// Flutter 3.44.8, web target. Serve build/web and load it in an Android WebView.
import 'package:flutter/material.dart';

void main() => runApp(
      const MaterialApp(home: Scaffold(body: SafeArea(child: Probe()))),
    );

class Probe extends StatelessWidget {
  const Probe({super.key});

  @override
  Widget build(BuildContext context) {
    final mq = MediaQuery.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        RichText(
          text: TextSpan(
            text: 'line=${mq.lineHeightScaleFactorOverride}\n'
                'scale10=${mq.textScaler.scale(10)}',
            style: const TextStyle(fontSize: 15, color: Colors.black),
          ),
        ),
        const Text('PLAIN TEXT', style: TextStyle(fontSize: 18, color: Colors.red)),
      ],
    );
  }
}
```

Compile com `flutter build web --release` e sirva `build/web`. Depois execute `adb shell settings put system font_scale 1.15` e abra a página em uma `android.webkit.WebView` simples com JavaScript ativado. O host não precisa chamar `setTextZoom`, porque a WebView pega a escala do sistema sozinha.

Se você não tem um dispositivo, pode reproduzir a metade do framework em um teste de widget, fornecendo o valor que o engine reporta:

```dart
// Flutter 3.44.8, flutter_test
testWidgets('engine-reported override inflates Text', (tester) async {
  await tester.pumpWidget(MaterialApp(
    builder: (context, child) => MediaQuery(
      data: MediaQuery.of(context)
          .copyWith(textScaler: const TextScaler.linear(1.15))
          .applyTextStyleOverrides(
            lineHeightScaleFactorOverride: 624.9375,
            letterSpacingOverride: null,
            wordSpacingOverride: null,
            paragraphSpacingOverride: null,
          ),
      child: child!,
    ),
    home: const Scaffold(
      body: SingleChildScrollView(
        child: Text('plain', key: Key('t'), style: TextStyle(fontSize: 18)),
      ),
    ),
  ));
  debugPrint('${tester.getSize(find.byKey(const Key('t'))).height}');
});
```

Na 3.44.8 isso imprime `12936.0`, que é a mesma altura de linha de 12.936 px que o autor da issue mediu na WebView real.

## Correção 1: atualize para o Flutter 3.47

O [PR #186474](https://github.com/flutter/flutter/pull/186474), mesclado em 19 de maio de 2026, reescreveu a lógica de sondagem. Ele foi escrito para um bug do Safari com a opção "nunca usar tamanhos de fonte menores que" ([#185931](https://github.com/flutter/flutter/issues/185931)), que produzia o mesmo fator inflado pelo mesmo mecanismo. A correção saiu primeiro na 3.46.0-0.1.pre e está em todas as versões stable da 3.47. A linha de hotfix 3.44.x, incluindo a 3.44.9 de 5 de agosto de 2026, nunca a recebeu. O novo código:

```dart
// Flutter 3.47.3, lib/web_ui/lib/src/engine/platform_dispatcher.dart (abridged)
const spacingDefault = 100.0;
final double defaultLineHeightFactor =
    spacingDefault / (typographyMeasurementElementFontSize / findBrowserTextScaleFactor());

bool isDefault(double? value, double defaultValue) {
  if (value == null) {
    return true;
  }
  return (value - defaultValue).abs() < _typographyPrecisionErrorTolerance ||
      (value - defaultValue * computedTextScaleFactor).abs() <
          _typographyPrecisionErrorTolerance;
}
```

`findBrowserTextScaleFactor()` é o tamanho da fonte raiz dividido por 16, o que dá 1,15 com `textZoom` 115. A altura de linha com zoom de `100 * 1.15` agora conta como "padrão", assim como o espaçamento entre letras, o espaçamento entre palavras e a margem de parágrafo com zoom. O override permanece `null` enquanto `textScaler` continua reportando 1,15. O sentinela também caiu de 9999 px para 100 px, então uma detecção errada no futuro daria um fator de cerca de 6 em vez de 625.

Uma ressalva: a #190350 continua aberta, e ninguém na thread publicou um teste em dispositivo na 3.47. A análise acima vem da leitura do código-fonte, não de uma execução em WebView. Depois de atualizar, rode a sondagem com `RichText` em um dispositivo real com `font_scale` 1.15 e confirme `line=null` antes de remover qualquer contorno. Se você vai atualizar da 3.44 de qualquer forma, vale a pena ler sobre a [mudança de renderizador desktop da 3.47](/pt-br/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/) por causa dos outros alvos do seu app.

```bash
flutter upgrade
flutter --version
```

## Correção 2: limpe os overrides implausíveis no MaterialApp.builder

Se você ainda não pode sair da 3.41 a 3.44, ou não controla o app host, corrija na raiz da árvore de widgets. `MediaQuery.applyTextStyleOverrides` substitui os quatro overrides de espaçamento para tudo o que está abaixo dele. Ele define cada um exatamente com o que você passa, `null` incluído, e mantém o `textScaler`, então a escolha de tamanho de fonte do usuário continua valendo.

O contorno publicado na issue define os quatro como `null`. Isso funciona, mas também descarta preferências reais de espaçamento de texto do WCAG, que é justamente o recurso para o qual a sondagem existe. Uma proteção mais restrita descarta apenas valores que nenhuma configuração real do usuário conseguiria produzir:

```dart
// Flutter 3.41.0 to 3.44.9, workaround for flutter/flutter#190350
import 'package:flutter/widgets.dart';

/// Drops text spacing overrides that no real user preference can produce.
Widget sanitizeTextSpacing(BuildContext context, Widget? child) {
  final mq = MediaQuery.of(context);
  double? sane(double? value, double max) =>
      value == null || value.abs() > max ? null : value;

  final lineHeight = sane(mq.lineHeightScaleFactorOverride, 4);
  final letter = sane(mq.letterSpacingOverride, 100);
  final word = sane(mq.wordSpacingOverride, 100);
  final paragraph = sane(mq.paragraphSpacingOverride, 1000);

  if (lineHeight == mq.lineHeightScaleFactorOverride &&
      letter == mq.letterSpacingOverride &&
      word == mq.wordSpacingOverride &&
      paragraph == mq.paragraphSpacingOverride) {
    return child ?? const SizedBox.shrink();
  }
  return MediaQuery.applyTextStyleOverrides(
    lineHeightScaleFactorOverride: lineHeight,
    letterSpacingOverride: letter,
    wordSpacingOverride: word,
    paragraphSpacingOverride: paragraph,
    child: child ?? const SizedBox.shrink(),
  );
}
```

Conecte-a em cada raiz de app:

```dart
// Flutter 3.44.8
MaterialApp(
  builder: sanitizeTextSpacing,
  home: const HomePage(),
);
```

O WCAG 1.4.12 pede uma altura de linha de 1,5 e espaçamento entre letras de 0,12em, então um limite de fator de 4 e um limite de 100 px deixam bastante folga para preferências reais. Na 3.44.8, testei isso com um teste de widget. Um override de `624.9375` vira `null`, e o `Text` de 18 px mede 30 px em vez de 12.936 px. Um override de `1.5` passa inalterado. `textScaler.scale(10)` retorna `11.5` nos dois casos.

Alguns detalhes importam aqui:

- **Toda raiz precisa dela.** O builder cobre apenas o próprio `MaterialApp`. Se você roda apps separados de carregamento, manutenção ou onboarding com seu próprio `MaterialApp` ou `WidgetsApp`, envolva cada um.
- **Ela acompanha mudanças em tempo de execução.** `MediaQuery.of(context)` se inscreve nos dados do ambiente, então quando o usuário muda o tamanho da fonte com a página aberta, o engine republica e a proteção roda de novo.
- **`MediaQuery.withNoTextScaling` não ajuda.** Ele só redefine o `textScaler`, que nunca foi o problema. Limitar a escala do texto deixa o override de altura de linha no lugar.
- **Ela é inofensiva depois da atualização.** Na 3.47, o engine deve reportar `null` no caso da WebView, então a proteção devolve `child` intacto. Você pode removê-la depois que a atualização for confirmada em um dispositivo.

## Correção 3: fixe o textZoom em 100 no host Android

Se você também distribui o host nativo, pode garantir que a WebView nunca repasse a escala de fonte do sistema para a página. Das três correções, esta é a mais bruta. O conteúdo Flutter web deixa de acompanhar o tamanho de fonte do usuário por completo, porque o `textScaler` fica em 1,0. Use-a apenas quando o app web tiver seu próprio controle de tamanho de texto dentro do app.

Em um host Kotlin:

```kotlin
// Android System WebView, API 14+
webView.settings.javaScriptEnabled = true
webView.settings.textZoom = 100
```

Em um host Flutter que usa `webview_flutter` 4.14.1, a configuração fica no controller da plataforma Android em `webview_flutter_android` 4.14.1:

```dart
// webview_flutter 4.14.1, webview_flutter_android 4.14.1
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

WebViewController buildController(Uri appUrl) {
  final controller = WebViewController()
    ..setJavaScriptMode(JavaScriptMode.unrestricted)
    ..loadRequest(appUrl);

  final platform = controller.platform;
  if (platform is AndroidWebViewController) {
    // Opt out of Android's system font scale for this WebView.
    platform.setTextZoom(100);
  }
  return controller;
}
```

Isso também explica os relatos de que o bug não pode ser reproduzido. Segundo a thread da issue, hosts construídos sobre `flutter_inappwebview` são imunes porque esse plugin define `textZoom` como 100 por padrão. Hosts construídos sobre `android.webkit.WebView` simples ou `webview_flutter` são afetados assim que o usuário tira o controle deslizante de fonte do valor padrão.

## Sintomas parecidos que não são este bug

- **Nada renderiza em dispositivos Samsung com GPUs Xclipse.** Se ícones e fundos também estão faltando, e apenas no CanvasKit, você está diante da [#188164](https://github.com/flutter/flutter/issues/188164), uma regressão de renderização do ANGLE sobre Vulkan. Ela acontece mesmo com `textZoom` 100.
- **Espaços enormes entre widgets no Safari 26.5.** Esta é a [#185931](https://github.com/flutter/flutter/issues/185931). Ela tem a mesma causa raiz, através da configuração de tamanho mínimo de fonte do Safari, e as mesmas correções se aplicam.
- **Texto transbordando depois de `flutter upgrade` no Android ou iOS nativo.** A sondagem de tipografia só existe no engine web. Em alvos móveis, olhe para o `TextScaler` e para as restrições do seu layout. Os acessores por aspecto, como `MediaQuery.textScalerOf`, que funcionam do mesmo jeito que o usado para [ler o raio dos cantos da tela no Flutter 3.44](/pt-br/2026/07/flutter-3-44-read-the-screen-corner-radius-from-mediaquery/), permitem registrar em log exatamente o que a plataforma reporta.

Um jeito rápido de saber se você está esbarrando neste bug: registre em log `PlatformDispatcher.instance.lineHeightScaleFactorOverride` na inicialização. Qualquer valor acima de cerca de 3 na web significa que o engine interpretou mal a sondagem, e não que o usuário pediu isso.

## Relacionados

- [Correção: A RenderFlex overflowed by N pixels no Flutter](/pt-br/2026/05/fix-renderflex-overflowed-in-flutter/), para a faixa de modo debug que este bug produz.
- [O detalhe do `leadingDistribution` no `Text` do Flutter](/pt-br/2026/01/flutter-text-the-leadingdistribution-detail-that-changes-how-your-ui-breathes/), para entender como `TextStyle.height` se transforma na geometria da caixa de linha.
- [Como compilar um app Flutter web com WebAssembly](/pt-br/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/), já que o bug é o mesmo com skwasm.
- [Flutter 3.47 torna o Impeller o renderizador padrão no desktop](/pt-br/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/), para a versão que traz a correção do engine.

## Fontes

- [flutter/flutter#190350](https://github.com/flutter/flutter/issues/190350): o relatório sobre o `textZoom` da WebView Android, o bisect e os contornos.
- [flutter/flutter#178856](https://github.com/flutter/flutter/issues/178856) e [PR #178862](https://github.com/flutter/flutter/pull/178862): a primeira variante com tamanho de fonte alterado em tempo de execução e sua correção parcial.
- [PR #178081](https://github.com/flutter/flutter/pull/178081): o suporte a overrides de espaçamento de texto na web que adicionou a sondagem.
- [PR #186474](https://github.com/flutter/flutter/pull/186474) e [flutter/flutter#185931](https://github.com/flutter/flutter/issues/185931): a detecção tolerante a zoom lançada na 3.46 e na 3.47.
- [`platform_dispatcher.dart` na 3.44.8](https://github.com/flutter/flutter/blob/3.44.8/engine/src/flutter/lib/web_ui/lib/src/engine/platform_dispatcher.dart) e [na 3.47.3](https://github.com/flutter/flutter/blob/3.47.3/engine/src/flutter/lib/web_ui/lib/src/engine/platform_dispatcher.dart).
- Documentação da API de [`MediaQuery.applyTextStyleOverrides`](https://api.flutter.dev/flutter/widgets/MediaQuery/applyTextStyleOverrides.html) e [`MediaQueryData.lineHeightScaleFactorOverride`](https://api.flutter.dev/flutter/widgets/MediaQueryData/lineHeightScaleFactorOverride.html).
- [`WebSettings.setTextZoom`](https://developer.android.com/reference/android/webkit/WebSettings#setTextZoom(int)) e [`AndroidWebViewController.setTextZoom`](https://pub.dev/documentation/webview_flutter_android/latest/webview_flutter_android/AndroidWebViewController/setTextZoom.html).
