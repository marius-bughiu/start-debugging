---
title: "Correção: a UI do Flutter fica sobreposta pela barra de navegação do sistema Android ao mirar o SDK 35"
description: "Mirar o SDK 35 do Android coloca seu app Flutter em modo edge-to-edge, então o corpo do Scaffold é desenhado atrás da barra de navegação. Consuma os insets com SafeArea e o padding do MediaQuery em vez de desativar, porque essa saída já morreu no Android 16."
pubDate: 2026-08-21
template: how-to
tags:
  - "flutter"
  - "dart"
  - "android"
  - "layout"
lang: "pt-br"
translationOf: "2026/08/fix-flutter-ui-overlaps-the-android-navigation-bar-after-targeting-sdk-35"
translatedBy: "claude"
translationDate: 2026-08-21
---

Seus botões funcionavam na versão anterior. Agora a linha inferior do seu `Scaffold` fica embaixo da barra de navegação do Android, meio visível e meio clicável, e nada no seu código de layout mudou. O que mudou foi o SDK alvo: assim que um app Flutter mira o SDK 35 do Android (API 35, Android 15), o Android o executa em modo edge-to-edge, e a janela do seu app passa a ocupar toda a altura da tela, incluindo a faixa que as barras do sistema ocupam. A correção não é recuperar essa faixa, é ler o inset que o Android informa e aplicar esse espaço ao seu próprio conteúdo. Envolva o conteúdo ancorado embaixo em `SafeArea`, e adicione padding aos scrollables com `MediaQuery.paddingOf(context).bottom` para que a lista role por baixo da barra mas pare antes dela. Não recorra a `android:windowOptOutEdgeToEdgeEnforcement`: o `targetSdkVersion` padrão do Flutter é 36 desde bem antes da versão estável atual, e na API 36 essa saída está obsoleta e desabilitada.

Tudo o que segue foi verificado no Flutter 3.44.2 (Dart 3.12.2), com os padrões do SDK conferidos contra a versão estável atual, Flutter 3.47.1 (lançada em 2026-08-19, Dart 3.13.1).

## Por que 48 pixels lógicos sumiram do rodapé do seu app

Antes do Android 15, um app que não entrava explicitamente em modo edge-to-edge recebia uma janela que terminava onde as barras do sistema começavam. A barra de navegação era opaca, pertencia ao sistema, e seu `Scaffold` simplesmente nunca via aqueles pixels. O layout era fácil porque o sistema operacional fazia o trabalho de insets por você.

O Android 15 inverteu esse padrão. Conforme o guia de edge-to-edge do Android, "Edge-to-edge is enforced on Android 15 (API level 35) and higher once your app targets SDK 35." Sua janela agora ocupa a tela inteira. A barra de status fica transparente, a barra de navegação por gestos fica transparente, e a barra de navegação de três botões fica translúcida. O Android continua informando exatamente quanto espaço essas barras cobrem, através dos window insets, mas não subtrai mais esse espaço em seu nome.

O Flutter herdou isso no momento em que seu alvo padrão mudou. A própria nota de migração do framework é direta sobre a sequência: "Prior to Flutter 3.27, Flutter apps targeted Android 14 by default and didn't opt into edge-to-edge mode automatically." A partir do Flutter 3.27, apps que usam `flutter.targetSdkVersion` miram o Android 15 e são incluídos automaticamente. A mudança chegou em `3.26.0-0.0.pre` e foi para estável no 3.27.

Esse padrão mudou de novo desde então, que é a parte em que quase todo texto sobre esse erro está desatualizado. No plugin Gradle que acompanha o Flutter 3.44.2, e de forma idêntica na tag 3.47.1, os padrões são:

```kotlin
// packages/flutter_tools/gradle/src/main/kotlin/FlutterExtension.kt
// Identical in Flutter 3.44.2 and 3.47.1
val compileSdkVersion: Int = 36
val minSdkVersion: Int = 24
val targetSdkVersion: Int = 36
```

Então um app recém-criado com `flutter create` hoje não mira apenas o SDK onde edge-to-edge é o padrão. Ele mira aquele onde edge-to-edge é a única opção.

## Como a sobreposição realmente se parece em números

Vale a pena fixar isso com medições em vez de capturas de tela, porque "está errado no meu Pixel" não é uma afirmação depurável. Um widget test consegue modelar o dispositivo com precisão: defina o `viewPadding` da view com uma barra de status de 24dp e uma barra de navegação de três botões de 48dp, ponha `devicePixelRatio` em 1 para que pixels lógicos equivalham aos físicos, e meça onde os widgets caem numa janela de 800dp de altura.

```dart
// Flutter 3.44.2 / Dart 3.12.2
void setNavBarView(WidgetTester tester) {
  tester.view.devicePixelRatio = 1.0;
  tester.view.physicalSize = const Size(400, 800);
  tester.view.viewInsets = FakeViewPadding.zero;
  tester.view.viewPadding = const FakeViewPadding(top: 24, bottom: 48);
  tester.view.padding = const FakeViewPadding(top: 24, bottom: 48);
  addTearDown(tester.view.reset);
}

testWidgets('bare Scaffold body is not inset from the nav bar', (t) async {
  setNavBarView(t);
  await t.pumpWidget(MaterialApp(
    home: Scaffold(
      body: Align(
        alignment: Alignment.bottomCenter,
        child: SizedBox(key: const Key('marker'), height: 10, width: 10),
      ),
    ),
  ));
  print('BODY_BOTTOM=${t.getRect(find.byKey(const Key('marker'))).bottom}');
});
```

Isso imprime `BODY_BOTTOM=800.0`. A borda inferior do marcador fica em 800, o fundo exato da tela, o que significa que seus últimos 48 pixels lógicos estão embaixo da barra de navegação. `Scaffold.body` recebe a janela inteira e não faz nada para proteger seu filho. Esse é o bug inteiro, e ele funciona conforme projetado.

## A correção em quatro passos

1. Mantenha o edge-to-edge ligado e pare de procurar um interruptor para desligá-lo. Na API 36 não existe forma suportada de desligá-lo, então tempo gasto com a saída é tempo gasto construindo algo que você vai ter que remover.

    ```dart
    // Flutter 3.44.2: nothing to add. edgeToEdge is already the default.
    ```

2. Envolva o conteúdo ancorado no topo e no rodapé em `SafeArea`. Essa é a ferramenta certa para conteúdo que nunca pode ficar sob uma barra: linhas de botões inferiores, toolbars personalizadas, painéis flutuantes, qualquer coisa posicionada com `Align` ou `Positioned`.

    ```dart
    // Flutter 3.44.2
    Scaffold(
      body: SafeArea(
        child: Align(
          alignment: Alignment.bottomCenter,
          child: ElevatedButton(onPressed: _submit, child: const Text('Save')),
        ),
      ),
    )
    ```

3. Adicione padding aos scrollables em vez de envolvê-los. Um `ListView` dentro de um `SafeArea` recebe um viewport que para acima da barra de navegação, então o conteúdo é cortado numa borda dura e a barra translúcida mostra fundo vazio. Passe o inset como padding da lista: o viewport continua ocupando tudo e o conteúdo rola por baixo da barra mas ainda assim para acima dela.

    ```dart
    // Flutter 3.44.2
    ListView(
      padding: EdgeInsets.only(bottom: MediaQuery.paddingOf(context).bottom),
      children: rows,
    )
    ```

4. Verifique com um widget test em vez de no olho, reaproveitando o helper `setNavBarView` acima. Alturas de barra específicas de cada aparelho são exatamente o tipo de coisa que regride em silêncio num celular que você não tem.

A diferença do passo 3 é mensurável. Com um `ListView` dentro de `SafeArea`, a borda inferior do viewport do scrollable mede 752.0, então o próprio viewport fica 48 aquém da janela. Com a abordagem de padding, a borda inferior do viewport é 800.0 (ocupando tudo, o conteúdo visivelmente rola por baixo da barra translúcida) enquanto a borda inferior da última linha cai em 752.0, dando exatamente 48 pixels lógicos de folga. A mesma folga para o conteúdo, o comportamento correto para a rolagem.

## Os widgets inferiores do Material já cuidam disso, os seus não

A hora perdida mais comum aqui é adicionar padding que o Material já adicionou, e depois se perguntar por que o espaço parece dobrado. O `Scaffold` de fato aplica insets em alguns dos seus slots, mas só para os widgets que aderem. Medindo cada slot contra a mesma barra de navegação simulada de 48dp:

| Widget | Altura renderizada | Borda superior | Resultado |
| --- | --- | --- | --- |
| `SizedBox(height: 56)` como `bottomNavigationBar` | 56.0 | 744.0 | sobrepõe, folga zero |
| `NavigationBar` (2 destinos) | 128.0 | 672.0 | ícones livram a barra por 86.0 |
| `BottomAppBar` | 128.0 | 672.0 | absorve o inset de 48dp |
| `FloatingActionButton` | padrão | | borda inferior em 736.0, folga 64.0 |
| `AppBar` | 80.0 | 0.0 | topo do título em 38.0 |

Leia as duas primeiras linhas juntas, porque nelas está a lição inteira. Um `SizedBox` de altura 56 colocado no slot `bottomNavigationBar` renderiza exatamente com 56 de altura e vai até y=800, então seus últimos 48 pixels ficam sob a barra. Um `NavigationBar` de verdade com altura nominal de 80 renderiza em 128, que é 80 mais o inset de 48dp que ele mesmo consumiu. `BottomAppBar` se comporta do mesmo jeito. O `FloatingActionButton` termina em 736 dando 64 de folga: o inset de 48dp mais a margem habitual de 16dp do Scaffold. `AppBar` renderiza com 80 de altura, que são os 56dp da toolbar mais os 24dp da barra de status, então o topo da tela já estava resolvido muito antes de tudo isso.

A regra que decorre disso: os widgets inferiores do Material crescem com o inset, widgets personalizados no mesmo slot não. Se você construiu uma barra inferior própria, o padding é seu. Se você já usa `NavigationBar` e o envolve num `SafeArea`, ganha 96dp de espaço morto e uma barra que parece quebrada.

## A armadilha do teclado que faz o SafeArea parecer instável

Essa é a parte que gera relatos de bug dizendo "o SafeArea funciona, mas só às vezes." Não é instável. É o `MediaQueryData.padding` fazendo exatamente o que documenta.

O Android informa dois valores relacionados. `viewPadding` é o inset bruto que as barras do sistema ocupam. `padding` é esse mesmo inset com `viewInsets` (o teclado) já subtraído e limitado em zero. Quando o teclado virtual abre, ele cobre a barra de navegação, então o inset inferior que importava para o layout some. Medido com um teclado de 300dp aberto:

```text
KEYBOARD_UP padding.bottom=0.0 viewPadding.bottom=48.0
```

O `SafeArea` lê `padding` por padrão, então seu inset inferior colapsa para zero no instante em que o teclado aparece, e o que você ancorou embaixo cai 48 pixels lógicos. Às vezes isso está certo, porque a barra realmente está coberta. Quando não está, o `SafeArea` tem uma flag para isso, e a implementação do framework é uma troca de duas linhas:

```dart
// packages/flutter/lib/src/widgets/safe_area.dart, Flutter 3.44.2
EdgeInsets padding = MediaQuery.paddingOf(context);
// Bottom padding has been consumed - i.e. by the keyboard
if (maintainBottomViewPadding) {
  padding = padding.copyWith(bottom: MediaQuery.viewPaddingOf(context).bottom);
}
```

Definir `maintainBottomViewPadding: true` mantém o espaço estável. Medidos lado a lado com o teclado aberto, um `SafeArea` simples dá um espaço inferior de 0.0 e um com a flag dá 48.0. Use quando um controle inferior anima junto com o teclado e você não quer que ele salte visivelmente. Esse é o mesmo tipo de problema que [um RenderFlex estourando embaixo quando o teclado abre](/pt-br/2026/08/fix-renderflex-overflowed-on-the-bottom-when-the-keyboard-opens-in-flutter/), onde o teclado muda as restrições em vez do padding.

## Aninhar SafeArea não dobra o padding

Vale saber antes de sair caçando um espaço fantasma: o `SafeArea` remove o padding que consumiu do `MediaQuery` que entrega à sua subárvore. Um `SafeArea` dentro de um `SafeArea` produz um espaço inferior de 48.0, não de 96.0. O interno vê padding zero e não adiciona nada.

Isso é boa notícia para composição, porque você pode colocar um `SafeArea` num scaffold de página compartilhado e deixar cada tela adicionar o seu sem auditar a árvore inteira. É má notícia para depuração, porque um espaço errado nunca vem do aninhamento duplo, então se o seu espaço está errado a causa está em outro lugar, normalmente um widget personalizado num slot do `Scaffold` como descrito acima.

## A saída existe, expira e pode derrubar seu app

Por completude, já que é o primeiro resultado na maioria das buscas sobre esse sintoma. O Flutter documenta uma saída para apps que miram o SDK 35: adicione `android:windowOptOutEdgeToEdgeEnforcement` tanto ao `LaunchTheme` quanto ao `NormalTheme` em `android/app/src/main/res/values/styles.xml`, e ao `values-night/styles.xml` correspondente.

```xml
<!-- android/app/src/main/res/values/styles.xml -->
<style name="NormalTheme" parent="@android:style/Theme.Light.NoTitleBar">
    <item name="android:windowOptOutEdgeToEdgeEnforcement">true</item>
</style>
```

Três motivos para não construir em cima disso. Primeiro, o Android 16 matou a saída: a página de mudanças de comportamento afirma que para apps que miram a API 36, `R.attr#windowOptOutEdgeToEdgeEnforcement` "is deprecated and disabled, and your app can't opt-out of going edge-to-edge." Segundo, o Flutter já te coloca por padrão em `targetSdkVersion = 36`, então você teria que rebaixar ativamente seu alvo para o atributo significar alguma coisa. Terceiro, a própria nota de migração do Flutter avisa que usar a saída no Android 16 ou posterior "might cause your app to crash," e a mitigação sugerida é um diretório de recursos específico de versão `your_app/android/app/src/main/res/values-35` contendo estilos sem o atributo. Isso é encanamento de recursos de verdade em troca de um comportamento que já sumiu nos aparelhos atuais.

O mesmo raciocínio vale para `SystemChrome.setEnabledSystemUIMode`. Na API 36 os outros modos simplesmente não são respeitados, e o framework diz isso na documentação da API de `SystemUiMode`: se seu app mira o SDK 36 ou posterior, ele usa `edgeToEdge` por padrão no Android, e "There is no way to opt out." `leanBack`, `immersive` e `immersiveSticky` são ignorados pelo sistema Android nesse alvo.

## As cores das barras do sistema agora são ignoradas, e o contraste é automático

Mais uma vítima que vale nomear, porque produz um sintoma diferente: nada quebra, sua cor só não é aplicada. Sob edge-to-edge, `SystemUiOverlayStyle.statusBarColor` e `SystemUiOverlayStyle.systemNavigationBarColor` não funcionam. Na API 35 elas voltam se você usar a saída; na API 36 sumiram de vez.

O que continua funcionando é o brilho dos ícones. `statusBarIconBrightness` e `systemNavigationBarIconBrightness` controlam se os glifos do próprio sistema são renderizados claros ou escuros, que é o que você realmente precisa quando o conteúdo atrás da barra muda de tom:

```dart
// Flutter 3.44.2
AppBar(
  systemOverlayStyle: SystemUiOverlayStyle(
    statusBarIconBrightness:
        MediaQuery.platformBrightnessOf(context) == Brightness.dark
            ? Brightness.light
            : Brightness.dark,
  ),
)
```

Prefira definir `AppBar.systemOverlayStyle`, ou um `AnnotatedRegion<SystemUiOverlayStyle>` quando não houver app bar, em vez de chamar `SystemChrome.setSystemUIOverlayStyle` diretamente. A região anotada passa por hit-test a cada frame contra o que realmente está sob as barras de status e navegação, então continua correta enquanto o usuário rola ou navega. Um `AppBar` cria uma automaticamente, então não envolva um `AppBar` em outro `AnnotatedRegion`.

Por fim, desde a API 29 o Android pinta um véu translúcido atrás de uma barra de navegação transparente para manter os três botões legíveis sobre conteúdo arbitrário. Se o seu design já garante contraste e o véu está sujando isso, `systemNavigationBarContrastEnforced: false` (e `systemStatusBarContrastEnforced` para o topo) desliga. Aparelhos na API 28 ou inferior nunca aplicaram esse véu.

Se você está construindo o visual de tela cheia de propósito em vez de consertá-lo, a próxima coisa que vai querer é a curva física da tela, que o Flutter agora [lê do MediaQuery como raios de canto físicos](/pt-br/2026/07/flutter-3-44-read-the-screen-corner-radius-from-mediaquery/) para que seu conteúdo se recorte no vidro em vez de num raio chutado.

## Relacionados

- [Correção: A RenderFlex overflowed by N pixels on the bottom quando o teclado abre no Flutter](/pt-br/2026/08/fix-renderflex-overflowed-on-the-bottom-when-the-keyboard-opens-in-flutter/) -- a outra metade da história do inset inferior, onde o teclado muda as restrições em vez do padding.
- [Flutter 3.44: Leia o raio dos cantos físicos da tela pelo MediaQuery](/pt-br/2026/07/flutter-3-44-read-the-screen-corner-radius-from-mediaquery/) -- a API complementar para layouts de tela cheia em telas arredondadas.
- [Como misturar um ListView e um GridView em uma única área de rolagem com slivers no Flutter](/pt-br/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/) -- onde aplicar o inset inferior quando sua área de rolagem é um `CustomScrollView` e não um `ListView`.
- [shrinkWrap vs Expanded vs slivers para listas longas no Flutter: qual escolher?](/pt-br/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/) -- escolher o scrollable certo antes de começar a adicionar padding nele.
- [Solução: Google Play rejeita um app Flutter ou .NET MAUI por falta de suporte a páginas de memória de 16 KB](/pt-br/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/) -- outro requisito do Android imposto pela loja que aparece como surpresa em tempo de compilação.

## Fontes

- [Set default of SystemUiMode to edge-to-edge](https://docs.flutter.dev/release/breaking-changes/default-systemuimode-edge-to-edge) -- o guia de migração do Flutter, incluindo os estilos de saída e a nota sobre `values-35`.
- [Display content edge-to-edge in your app](https://developer.android.com/develop/ui/views/layout/edge-to-edge) -- a declaração do Android sobre a imposição na API 35 e superiores.
- [Behavior changes: Apps targeting Android 16 or higher](https://developer.android.com/about/versions/16/behavior-changes-16) -- a obsolescência e desativação de `windowOptOutEdgeToEdgeEnforcement`.
- [SystemUiMode API documentation](https://api.flutter.dev/flutter/services/SystemUiMode.html) -- notas por modo sobre o que a API 35 e a API 36 respeitam.
- [Issue 168635: App UI overlaps with 3-button navigation bar on Samsung One UI 7 / Android 15](https://github.com/flutter/flutter/issues/168635) -- a discussão de acompanhamento para a qual a própria documentação do Flutter aponta.
