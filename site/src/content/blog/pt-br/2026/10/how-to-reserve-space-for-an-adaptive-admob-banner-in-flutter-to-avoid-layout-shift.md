---
title: "Como reservar espaço para um banner adaptativo do AdMob no Flutter e evitar layout shift"
description: "O exemplo oficial do google_mobile_ads não renderiza nada até o onAdLoaded, então o seu conteúdo salta 150 dp alguns segundos depois de a tela aparecer. Peça primeiro o tamanho adaptativo ancorado, reserve-o com um SizedBox, persista a altura entre as execuções e só então carregue o anúncio. Medido com Flutter 3.44.8 e google_mobile_ads 9.1.0."
pubDate: 2026-10-05
template: how-to
tags:
  - "flutter"
  - "dart"
  - "admob"
  - "android"
  - "layout"
lang: "pt-br"
translationOf: "2026/10/how-to-reserve-space-for-an-adaptive-admob-banner-in-flutter-to-avoid-layout-shift"
translatedBy: "claude"
translationDate: 2026-10-05
---

**Resposta curta:** a altura de um banner adaptativo ancorado é conhecida antes de o anúncio carregar, então reserve-a. Chame `AdSize.getLargeAnchoredAdaptiveBannerAdSize(width)` assim que tiver uma largura diferente de zero, coloque imediatamente no espaço do banner um `SizedBox` com exatamente essa altura e troque o `AdWidget` para dentro da caixa quando o `onAdLoaded` disparar. Persista a altura com `shared_preferences` para que o primeiro frame da próxima inicialização a frio já tenha o espaço, e mantenha o espaço quando um carregamento falhar, em vez de recolhê-lo. Tudo abaixo foi medido com Flutter 3.44.8 (Dart 3.12.2) e `google_mobile_ads` 9.1.0 em um emulador Android 16 (API 36).

## Por que a tela salta quando o banner chega

O guia de banners do Google para o plugin Flutter carrega o anúncio e só o adiciona à árvore no `onAdLoaded`. O trecho de exibição é protegido por `if (_bannerAd != null)`, e o tamanho da caixa vem de `_bannerAd!.size`. Até a ida e volta pela rede terminar, o espaço do banner tem zero pixels de altura. Quando o anúncio chega, o espaço cresce, o corpo do `Scaffold` encolhe na mesma medida e tudo o que o usuário estava olhando perto da parte inferior se move.

Esse salto é pior do que costumava ser por dois motivos:

1. **Banners adaptativos ancorados grandes são altos.** Desde o `google_mobile_ads` 8.0.0, `getCurrentOrientationAnchoredAdaptiveBannerAdSize` está obsoleto em favor de `getLargeAnchoredAdaptiveBannerAdSize`. O guia do Google descreve a variante grande como "até 20% da altura da tela, entre 50 e 150 dp". Em um celular típico, isso é aproximadamente o dobro da antiga faixa de 50 a 64 dp.
2. **O anúncio chega tarde.** A requisição sai depois de `MobileAds.instance.initialize()`, de um leilão de anúncios e do download do criativo. Em uma inicialização a frio isso leva segundos, não frames, que é exatamente quando os usuários começam a ler ou tocar.

## Medindo o salto

Para obter números reais, montei um app de teste: um `Scaffold` cujo corpo é uma `ListView` envolvida em um `LayoutBuilder` que registra em log cada mudança na altura do corpo, com o banner em `bottomNavigationBar`. O emulador tinha uma tela de 1080x2400 a 420 dpi, que o Flutter enxerga como 411,43 x 914,29 pixels lógicos, usando o bloco de anúncios de teste oficial de banner adaptativo `ca-app-pub-3940256099942544/9214589741` e um build de release.

Primeiro, as alturas que o SDK devolve para diferentes larguras (todos os valores em dp):

| Largura solicitada | Grande ancorado (orientação atual) | Grande, paisagem | Ancorado padrão (obsoleto) |
|---|---|---|---|
| 320 | 100 | 82 | 50 |
| 360 | 113 | 82 | 56 |
| 411 | 128 | 82 | 64 |
| 412 | 129 | 82 | 64 |
| 600 | 150 | 82 | 77 |
| 800 | 150 | 82 | 90 |

Em retrato, o tamanho grande acompanha a proporção 320x50 ampliada para 320x100 e tem teto em 150. Em paisagem ele fica fixo em 82, que é 20% dos 411 dp de altura em paisagem. Nada disso precisa de chamada de rede: o tamanho é calculado no dispositivo e resolve em poucos milissegundos.

Depois, a linha do tempo da altura do corpo para o padrão do tutorial versus um espaço reservado:

| Padrão | Primeiro frame real | Mudança na altura do corpo | Quando |
|---|---|---|---|
| Renderizar nada até o `onAdLoaded` | 302 ms | 914,29 -> 762,29 | 5.338 ms, quando o anúncio carregou |
| Reservar o tamanho, obtido em `didChangeDependencies` | 439 ms | 914,29 -> 762,29 | 448 ms, um frame depois |
| Reservar o tamanho, altura restaurada do `shared_preferences` | 546 ms | 0 -> 762,29 direto | nenhum salto |

A queda de 152 dp é o banner de 128 dp mais os 24 dp do inset da navegação por gestos que o `SafeArea` adiciona abaixo dele. Na versão ingênua, isso acontece mais de cinco segundos depois de a tela aparecer. Reservar o tamanho move a queda para o frame logo após o primeiro, e persistir a altura a elimina.

## Passo 1: obtenha o tamanho antes de carregar qualquer coisa

Os métodos de tamanho em `AdSize` são estáticos e assíncronos porque atravessam o canal de plataforma, mas não dependem de um anúncio carregado. Chame-os assim que o `MediaQuery` fornecer uma largura:

```dart
// Flutter 3.44.8, google_mobile_ads 9.1.0
@override
void didChangeDependencies() {
  super.didChangeDependencies();
  final size = MediaQuery.sizeOf(context);
  final padding = MediaQuery.paddingOf(context);
  final width = (size.width - padding.left - padding.right).truncate();
  // Android can report a 0x0 window on the very first frame.
  if (width <= 0 || width == _width) return;
  _width = width;
  unawaited(_load(width));
}
```

A proteção `width <= 0` não é decorativa. No build de release, o primeiro `build` rodou com um tamanho de `MediaQuery` de 0x0: o Android ainda não tinha entregue as métricas da janela. Até `platformDispatcher.implicitView` em `main()` informava `physicalSize` 0 e `devicePixelRatio` de 1.0 antes do `runApp`. Pedir um banner ancorado grande com largura 0 devolveu `0x100`, e carregar esse tamanho falhou com `LoadAdError(code: 3, ... "Ad request doesn't meet size requirements")`. O código do tutorial dispara sua primeira requisição a partir desse frame de largura zero e só tem sucesso porque `didChangeDependencies` roda de novo um frame depois, com métricas reais.

Subtraia o padding horizontal da área segura antes de perguntar. O guia de adaptativo inline do Google é explícito ao dizer que a largura "deve levar em conta a largura do dispositivo e quaisquer áreas seguras aplicáveis", e em paisagem, em um celular com recorte no display, `MediaQuery.paddingOf(context).left` não é zero.

## Passo 2: construa um espaço que seja dono da sua altura

O espaço é um `SizedBox` com a altura reservada que está sempre na árvore. O `AdWidget` entra nele somente depois que o anúncio carregou, porque, caso contrário, o `AdWidget` lança "AdWidget requires Ad.load to be called before AdWidget is inserted into the tree".

```dart
// Flutter 3.44.8, google_mobile_ads 9.1.0, shared_preferences 2.5.5
class AnchoredBannerSlot extends StatefulWidget {
  const AnchoredBannerSlot({super.key, required this.adUnitId});

  final String adUnitId;

  @override
  State<AnchoredBannerSlot> createState() => _AnchoredBannerSlotState();
}

class _AnchoredBannerSlotState extends State<AnchoredBannerSlot> {
  BannerAd? _ad;
  bool _loaded = false;
  int? _width;
  int? _height;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final size = MediaQuery.sizeOf(context);
    final padding = MediaQuery.paddingOf(context);
    final width = (size.width - padding.left - padding.right).truncate();
    // Android can report a 0x0 window on the very first frame.
    if (width <= 0 || width == _width) return;
    _width = width;
    _height = BannerHeightCache.lookup(width);
    unawaited(_load(width));
  }

  Future<void> _load(int width) async {
    final size = await AdSize.getLargeAnchoredAdaptiveBannerAdSize(width);
    if (!mounted || width != _width || size == null) return;
    BannerHeightCache.remember(width, size.height);

    final previous = _ad;
    setState(() {
      _height = size.height;
      _ad = null;
      _loaded = false;
    });
    await previous?.dispose();
    if (!mounted || width != _width) return;

    final ad = BannerAd(
      adUnitId: widget.adUnitId,
      request: const AdRequest(),
      size: size,
      listener: BannerAdListener(
        onAdLoaded: (ad) {
          if (!mounted || ad != _ad) {
            ad.dispose();
            return;
          }
          setState(() => _loaded = true);
        },
        onAdFailedToLoad: (ad, error) {
          ad.dispose();
          // Keep the reserved height: collapsing now would be a layout shift.
          if (mounted && ad == _ad) setState(() => _ad = null);
        },
      ),
    );
    _ad = ad;
    await ad.load();
  }

  @override
  void dispose() {
    _ad?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final height = _height;
    if (height == null) return const SizedBox.shrink();
    final ad = _ad;
    return SafeArea(
      top: false,
      child: SizedBox(
        height: height.toDouble(),
        child: Center(
          child: _loaded && ad != null
              ? SizedBox(
                  width: ad.size.width.toDouble(),
                  height: ad.size.height.toDouble(),
                  child: AdWidget(ad: ad),
                )
              : null,
        ),
      ),
    );
  }
}
```

Alguns detalhes que importam:

- **`width != _width` depois de cada `await`.** A rotação muda a largura enquanto uma consulta de tamanho ou um `dispose()` está em andamento. Sem a verificação, uma requisição antiga em retrato pode sobrescrever o espaço da paisagem.
- **`ad != _ad` no `onAdLoaded`.** Se o widget já passou para uma requisição mais nova, o anúncio tardio é descartado em vez de exibido.
- **`SafeArea(top: false)` fora da caixa reservada.** O espaço fica em `bottomNavigationBar`, então ele mesmo precisa absorver o inset inferior. Com edge-to-edge obrigatório para apps que têm como alvo o Android 15 e posteriores, esse inset não é mais subtraído para você.
- **`Center` em volta do `AdWidget`.** No iOS, a documentação do plugin diz que o widget precisa de um pai "com largura e altura especificadas", caso contrário o anúncio pode não aparecer. O `SizedBox` interno dá a ele exatamente o tamanho solicitado.

Usá-lo é uma linha no `Scaffold`:

```dart
// Flutter 3.44.8, google_mobile_ads 9.1.0
Scaffold(
  body: const ArticleList(),
  bottomNavigationBar: const AnchoredBannerSlot(
    adUnitId: 'ca-app-pub-3940256099942544/9214589741', // test unit
  ),
);
```

## Passo 3: persista a altura para que o primeiro frame esteja certo

O Passo 2 ainda deixa uma lacuna de um frame na inicialização a frio: o primeiro frame com uma largura real é renderizado antes de o canal de plataforma responder. Nas medições, essa lacuna foi de 9 a 70 ms, que geralmente cai enquanto o primeiro conteúdo ainda está sendo pintado, mas é um salto e aparece em gravações de tela.

A solução é que a altura ancorada é uma função pura do dispositivo e da largura. A própria documentação do Google diz que a altura ideal "permanece constante entre diferentes requisições de anúncio". Então a última resposta do SDK é um palpite inicial perfeito para a próxima execução:

```dart
// Flutter 3.44.8, shared_preferences 2.5.5
class BannerHeightCache {
  static const _prefix = 'admob.anchoredHeight.';
  static final Map<int, int> _heights = {};

  static Future<void> restore() async {
    final prefs = await SharedPreferences.getInstance();
    for (final key in prefs.getKeys().where((k) => k.startsWith(_prefix))) {
      final width = int.tryParse(key.substring(_prefix.length));
      final height = prefs.getInt(key);
      if (width != null && height != null) _heights[width] = height;
    }
  }

  static int? lookup(int width) => _heights[width];

  static void remember(int width, int height) {
    if (_heights[width] == height) return;
    _heights[width] = height;
    unawaited(
      SharedPreferences.getInstance()
          .then((prefs) => prefs.setInt('$_prefix$width', height)),
    );
  }
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await BannerHeightCache.restore();
  unawaited(MobileAds.instance.initialize());
  runApp(const MyApp());
}
```

O espaço já lê `BannerHeightCache.lookup(width)` em `didChangeDependencies`, então, na segunda execução, o primeiro frame real é construído com uma caixa de 128 dp e o corpo vai de 0 direto para os 762,29 dp finais. A consulta ao vivo continua rodando e sobrescreve o valor em cache, então um palpite errado (nova versão do SO, outro tamanho de exibição) custa um salto e depois se corrige sozinho. O mapa em memória também ajuda dentro de uma sessão: a segunda tela que hospeda um banner recebe a altura de forma síncrona.

Não tente calcular a altura por conta própria a partir da tabela acima. A proporção 100/320 e os tetos são comportamento observado do SDK, não um contrato documentado, e o Google já mudou o dimensionamento adaptativo antes. Guardar em cache a resposta do SDK dá a mesma precisão no primeiro frame sem apostar em uma fórmula.

## Passo 4: decida o que acontece quando nenhum anúncio volta

Com um espaço reservado, um carregamento que falha deixa uma faixa vazia na parte inferior. Você tem duas opções honestas:

1. **Manter a faixa.** O layout nunca se move, e a próxima requisição (na navegação, em um temporizador ou pela atualização automática do AdMob, se você a configurou) a preenche. É o que o widget acima faz.
2. **Recolher a faixa.** Você recupera o espaço ao custo de exatamente um layout shift, e precisa reservar de novo antes da próxima tentativa.

Para um banner ancorado na parte inferior, prefiro a primeira. Os usuários deixam de ver uma faixa em branco de 128 dp como "faltando" muito rápido, mas nunca deixam de notar uma lista que pula sob o polegar. Se você recolher, anime com um `AnimatedSize` para que a mudança ao menos pareça intencional.

## O anúncio de teste era menor que o espaço

Mais uma coisa que o app de teste revelou. Depois do `onAdLoaded`, `BannerAd.getPlatformAdSize()` informou `411x64` para um anúncio solicitado em `411x128`. O criativo de teste é um banner de altura padrão. A view nativa o centralizou dentro da requisição de 128 dp, e renderizar o `AdWidget` em 128 dp ou no tamanho da plataforma ficou idêntico. Não reduza o espaço para o tamanho da plataforma depois do carregamento: isso é um layout shift na outra direção, e a próxima atualização pode muito bem devolver um criativo de altura total.

## Banners adaptativos inline em conteúdo rolável

Os banners adaptativos inline são a outra família adaptativa, feita para ser colocada dentro de um feed. A altura deles é escolhida pelo servidor, então `AdSize.getCurrentOrientationInlineAdaptiveBannerAdSize(width)` devolve um tamanho com altura 0 e você só descobre a altura real por `getPlatformAdSize()` depois do carregamento. O exemplo do Google lida com isso renderizando um `Container()` vazio até o carregamento e só então dimensionando a caixa, o que desloca todos os itens abaixo dele.

Você não pode reservar uma altura desconhecida, mas pode limitá-la. Use `AdSize.getInlineAdaptiveBannerAdSize(width, maxHeight)` e reserve `maxHeight`:

```dart
// Flutter 3.44.8, google_mobile_ads 9.1.0
class InlineBannerSlot extends StatefulWidget {
  const InlineBannerSlot({super.key, required this.adUnitId, this.maxHeight = 250});

  final String adUnitId;
  final int maxHeight;

  @override
  State<InlineBannerSlot> createState() => _InlineBannerSlotState();
}

class _InlineBannerSlotState extends State<InlineBannerSlot> {
  BannerAd? _ad;
  AdSize? _platformSize;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_ad != null) return;
    final width = MediaQuery.sizeOf(context).width.truncate();
    if (width <= 0) return;
    _ad = BannerAd(
      adUnitId: widget.adUnitId,
      request: const AdRequest(),
      size: AdSize.getInlineAdaptiveBannerAdSize(width, widget.maxHeight),
      listener: BannerAdListener(
        onAdLoaded: (ad) async {
          final size = await (ad as BannerAd).getPlatformAdSize();
          if (mounted) setState(() => _platformSize = size);
        },
        onAdFailedToLoad: (ad, error) => ad.dispose(),
      ),
    )..load();
  }

  @override
  void dispose() {
    _ad?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ad = _ad;
    final size = _platformSize;
    return SizedBox(
      height: widget.maxHeight.toDouble(),
      child: Center(
        child: ad != null && size != null
            ? SizedBox(
                width: size.width.toDouble(),
                height: size.height.toDouble(),
                child: AdWidget(ad: ad),
              )
            : null,
      ),
    );
  }
}
```

A contrapartida é o letterboxing quando o criativo é mais baixo que `maxHeight`. Se isso ficar ruim no seu design, a alternativa é iniciar a requisição bem antes de o item rolar para a vista (uma `ListView` constrói itens dentro do `cacheExtent` da área visível, 250 pixels por padrão) e aceitar que um salto acima da área visível move a posição de rolagem. O Google também avisa que banners inline em views roláveis podem ter desempenho ruim no Android 9 e anteriores, enquanto os banners ancorados não são afetados.

## Armadilhas

- **Um `BannerAd`, um `AdWidget`.** Reutilizar um objeto de anúncio em dois lugares lança "This AdWidget is already in the Widget tree". Cada espaço é dono do seu próprio anúncio.
- **`getLargeAnchoredAdaptiveBannerAdSize` pode devolver `null`.** O plugin devolve `null` quando o SDK não consegue encontrar uma altura para a janela. O espaço então não renderiza nada, o que equivale a não exibir um anúncio.
- **Não use os tamanhos obsoletos para "economizar espaço".** `getCurrentOrientationAnchoredAdaptiveBannerAdSize` ainda funciona na 9.1.0 e dá 64 dp em vez de 128 com 411 dp de largura, mas está obsoleto e o formato grande é aquele que o Google otimiza.
- **Mudanças de orientação são uma nova requisição.** A largura muda, o espaço reserva imediatamente a nova altura (a paisagem é 82 dp neste dispositivo) e um novo anúncio é carregado para ela. Esse salto é causado pela própria rotação, então é esperado.
- **O hot reload esconde o bug do primeiro frame.** O primeiro frame com largura zero só aparece em uma inicialização a frio. Teste o espaço reservado com `flutter run --release` depois de forçar a parada do app, não depois de um hot restart.
- **Um build de release pode travar antes de o seu código de anúncios rodar.** No app de teste, o R8 removeu `androidx.work.impl.WorkDatabase`, que o SDK de anúncios traz pelo WorkManager, e o app morreu com "Failed to create an instance of androidx.work.impl.WorkDatabase". Desativar a minificação (`isMinifyEnabled = false`) resolveu no app de teste; uma regra keep do ProGuard para as classes do banco de dados do WorkManager é a correção mais estreita. Se o seu build de release trava e o de debug não, confira o `adb logcat` antes de culpar o código do banner.

Se você também usa banners no .NET MAUI, o mesmo raciocínio vale lá: o [guia de AdMob no MAUI para banners, intersticiais e anúncios com recompensa](/2026/07/monetize-a-net-maui-app-with-admob-banner-interstitial-rewarded/) usa as views nativas, que têm as mesmas APIs de dimensionamento pré-carregamento.

## Veja também

- [Correção: a UI do Flutter se sobrepõe à barra de navegação do sistema Android depois de usar o SDK 35 como alvo](/pt-br/2026/08/fix-flutter-ui-overlaps-the-android-navigation-bar-after-targeting-sdk-35/) explica o inset inferior que o espaço do banner precisa absorver.
- [Como usar o BuildContext com segurança depois de um await no Flutter](/pt-br/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) trata das verificações de `mounted` que o espaço faz depois de cada etapa assíncrona.
- [Como perfilar jank em um app Flutter com o DevTools](/pt-br/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) ajuda você a confirmar que a platform view não está custando frames depois que o banner está no lugar.
- [Monetize um app .NET MAUI com banners, intersticiais e anúncios com recompensa do AdMob](/2026/07/monetize-a-net-maui-app-with-admob-banner-interstitial-rewarded/) é o lado MAUI da mesma configuração do AdMob.

## Fontes

- [Set up banner ads (Flutter)](https://developers.google.com/admob/flutter/banner) para o dimensionamento adaptativo ancorado grande, os IDs dos blocos de anúncios de teste e a observação de dimensionamento no iOS.
- [Use inline adaptive for scrolling banners (Flutter)](https://developers.google.com/admob/flutter/banner/inline-adaptive) para `getInlineAdaptiveBannerAdSize` e `getPlatformAdSize`.
- [Set up banner ads (Android)](https://developers.google.com/admob/android/banner/anchored-adaptive) para a faixa de 50 a 150 dp, 20% da altura da tela, dos banners adaptativos grandes.
- [google_mobile_ads no pub.dev](https://pub.dev/packages/google_mobile_ads) e seu [changelog](https://pub.dev/packages/google_mobile_ads/changelog), incluindo as descontinuações da 8.0.0.
- [shared_preferences no pub.dev](https://pub.dev/packages/shared_preferences).
