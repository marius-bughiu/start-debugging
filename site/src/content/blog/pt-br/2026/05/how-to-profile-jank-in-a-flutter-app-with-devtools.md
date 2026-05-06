---
title: "Como perfilar jank em um app Flutter com DevTools"
description: "Guia passo a passo para encontrar e corrigir jank no Flutter 3.27 com DevTools: profile mode, o Performance overlay, a aba Frame Analysis, o CPU Profiler, raster vs thread de UI, aquecimento de shaders e particularidades do Impeller. Testado no Flutter 3.27.1, Dart 3.11, DevTools 2.40."
pubDate: 2026-05-06
template: how-to
tags:
  - "flutter"
  - "dart"
  - "devtools"
  - "performance"
  - "jank"
  - "how-to"
lang: "pt-br"
translationOf: "2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools"
translatedBy: "claude"
translationDate: 2026-05-06
---

Resposta curta: compile com `flutter run --profile` (nunca debug), abra o DevTools, vá para a aba Performance, reproduza o jank e leia o gráfico Frame Analysis. Frames acima do orçamento (16,67 ms a 60 Hz, 8,33 ms a 120 Hz) ficam coloridos. Se a barra acima do orçamento estiver vermelha na thread de UI, vá ao CPU Profiler e analise seu código Dart; se estiver vermelha na thread de raster, o gargalo é a GPU e a correção geralmente é aquecimento de shaders, imagens menores ou menos efeitos caros. Este guia passa por cada uma dessas decisões no Flutter 3.27.1, Dart 3.11 e DevTools 2.40.

## Por que você não consegue perfilar jank em debug

Builds de debug são lentos de propósito. Eles executam código JIT não otimizado, embarcam todas as asserções e pulam o pipeline AOT. O próprio framework imprime `"This is a debug build"` sobre o app para te lembrar. Os números coletados em debug costumam ser de 2x a 10x piores do que em release, então qualquer jank que você "encontrar" lá pode nem existir em produção. Pior: você também pode perder jank real porque o debug roda a uma taxa de quadros padrão menor em alguns dispositivos Android.

Sempre perfile com `flutter run --profile` em um dispositivo real. O simulador e o iOS Simulator não representam o comportamento real da GPU, especialmente para compilação de shaders. O profile mode mantém os hooks do DevTools (eventos de timeline, rastreamento de alocações, observatory) mas compila seu Dart com o pipeline AOT, então os números ficam dentro de uma pequena porcentagem do release. A [documentação de desempenho do Flutter](https://docs.flutter.dev/perf/ui-performance) é explícita sobre isso.

```bash
# Flutter 3.27.1
flutter run --profile -d <your-device-id>
```

Se o dispositivo está conectado via USB, você também pode usar `--profile --trace-startup` para capturar um arquivo de timeline de inicialização em `build/start_up_info.json`, útil para medir especificamente o jank de cold-start.

## Abra o DevTools e escolha a aba certa

Assim que `flutter run --profile` estiver rodando, o console imprime uma URL do DevTools como `http://127.0.0.1:9100/?uri=...`. Abra-a no Chrome. As abas relevantes para jank são, em ordem:

1. **Performance**: timeline de frames, Frame Analysis, raster cache, controles de enhance tracing.
2. **CPU Profiler**: profiler por amostragem com visões bottom-up, top-down e árvore de chamadas.
3. **Memory**: rastreamento de alocações e eventos de GC. Útil se o jank correlaciona com GC.
4. **Inspector**: árvore de widgets. Útil para confirmar uma tempestade de rebuilds.

O "Performance overlay" que você também pode ativar de dentro do app em execução (`P` no terminal, ou `WidgetsApp.showPerformanceOverlay = true` no código) é uma versão menor dos mesmos dados desenhada sobre sua UI. É ótimo para identificar jank em tempo real em um dispositivo, mas não dá para detalhar um frame específico a partir dele. Use o overlay para encontrar um cenário com jank e capture-o no DevTools.

## Lendo o gráfico Frame Analysis

Em Performance, o gráfico de cima mostra uma barra por frame renderizado. Cada barra tem dois segmentos empilhados horizontalmente: o segmento de baixo é a thread de UI (sua caminhada `build`, `layout`, `paint` em Dart), o de cima é a thread de raster (onde o engine rasteriza a árvore de camadas na GPU). Se qualquer segmento ultrapassar o orçamento do frame, a barra fica vermelha.

O orçamento do frame é `1000 ms / refresh_rate`. Em um dispositivo de 60 Hz são 16,67 ms no total, mas você não tem 16,67 ms para cada thread. Um frame só fica no tempo certo se UI e raster terminarem dentro do orçamento, o que na prática significa cerca de 8 ms para cada (o restante é overhead do engine e alinhamento com vsync). Em um dispositivo de 120 Hz, divida tudo por dois.

Clique em um frame vermelho e o painel inferior muda para "Frame Analysis". Essa é a visão mais útil do DevTools 2.40. Ela mostra:

- Os eventos de timeline daquele único frame.
- Se o custo dominante é `Build`, `Layout`, `Paint` ou `Raster`.
- Se houve compilação de shaders, decodificação de imagens ou chamadas por platform channel.
- Uma dica em texto como "This frame's UI work was dominated by a single Build phase" para você não precisar adivinhar.

Se a dica diz que o problema foi a thread de UI, a correção está no seu código Dart. Se aponta para a thread de raster, a correção está no formato da árvore de widgets, nos shaders, nas imagens ou nos efeitos.

## Quando o gargalo é a thread de UI

Jank na thread de UI é seu código rodando por tempo demais dentro de um frame. As maiores fontes são:

- Um método `build` que faz trabalho real (parsear JSON, percorrer uma lista de 10k itens, regex em uma string longa).
- Um `setState` que reconstrói uma subárvore muito maior que o necessário.
- Um `File.readAsStringSync` síncrono ou qualquer I/O bloqueante.
- Uma mudança pesada de `Listenable` que se propaga para muitos listeners.

Vá para a aba CPU Profiler enquanto a interação com jank está acontecendo. Coloque "Profile granularity" em "high" para rajadas curtas e comece a gravar. Pare a gravação após os frames com jank. A visão bottom-up ("Heaviest frames at the top") costuma identificar o culpado em segundos.

```dart
// Flutter 3.27.1, Dart 3.11
class ProductList extends StatelessWidget {
  const ProductList({super.key, required this.json});
  final String json;

  @override
  Widget build(BuildContext context) {
    // Bad: parses a 4 MB JSON blob on every rebuild on the UI thread.
    final products = (jsonDecode(json) as List)
        .map((e) => Product.fromJson(e as Map<String, dynamic>))
        .toList();

    return ListView.builder(
      itemCount: products.length,
      itemBuilder: (_, i) => ProductTile(product: products[i]),
    );
  }
}
```

A correção é mover o trabalho para fora da thread de UI, seja com uma chamada pontual a `compute(...)` ou, para trabalho CPU-bound recorrente, um isolate de longa duração. Há um passo a passo completo de ambos em [o guia dedicado de como escrever um isolate de Dart para trabalho CPU-bound](/pt-br/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/).

Um custo mais sutil da thread de UI é reconstruir demais. Embrulhe a parte que realmente muda em um widget pequeno para que o `build` dele seja o único que roda no `setState`. O controle "Highlight Repaints" do Inspector (em Performance > More options) desenha uma borda colorida em volta de cada camada que se repinta, o jeito mais rápido de identificar um `Container` perto da raiz reconstruindo a tela inteira.

## Quando o gargalo é a thread de raster

Jank na thread de raster significa que o engine está fazendo trabalho de GPU demais para a árvore de camadas que seus widgets produzem. A correção raramente é "use um celular mais rápido". Geralmente é uma destas:

1. **Jank por compilação de shaders**: efeitos de primeira vez (transições de página, gradientes, blurs, custom painters) compilam shaders em meio ao frame, o que faz disparar o tempo de raster. Aparece como um ou dois frames extremos na primeira vez que uma tela abre.
2. **Camadas fora da tela**: `Opacity`, `ShaderMask`, `BackdropFilter` e `ClipRRect` com `antiAlias: true` podem forçar o engine a renderizar uma subárvore para uma textura e compor. Tudo bem para um elemento, caro para uma lista deles.
3. **Imagens superdimensionadas**: um JPEG 4k decodificado em um `Image.asset` cobre a tela do celular com muito mais pixels do que você consegue ver. Use `cacheWidth` / `cacheHeight` para reduzir a resolução na decodificação.
4. **Chamadas a `saveLayer`**: um padrão delator no timeline do engine. `saveLayer` é o que `Opacity` usa internamente. Substituir `Opacity(opacity: 0.5, child: ...)` por um `AnimatedOpacity` ou um filho que pinta com o alpha já aplicado evita a chamada.

O DevTools 2.40 expõe isso diretamente. Em Performance > "Enhance Tracing", ative "Track widget builds", "Track layouts" e "Track paints" para mais detalhe no timeline. O Frame Analysis também acende um painel "Raster cache": se ele mostrar uma proporção alta de "raster cache hits / misses", o engine não está cacheando camadas que poderia.

## Aquecimento de shaders no Impeller e no Skia

Essa é a pergunta mais frequente sobre desempenho de Flutter: "na primeira vez que abro essa tela, ela engasga". A causa é compilação de shaders. A correção depende do backend de renderização.

O Impeller é o renderer moderno do engine. A partir do Flutter 3.27, o Impeller é o padrão no iOS e é o padrão no Android (com o Skia disponível como alternativa para dispositivos antigos). O Impeller compila todos os shaders previamente, então em dispositivos só Impeller o jank por compilação de shaders não deveria existir. Se você ainda vir jank no primeiro frame com Impeller, é decodificação de imagem ou setup de camadas, não shaders.

No caminho do Skia (Android antigo, web, desktop), a compilação de shaders ainda acontece em runtime. O fluxo tradicional `flutter build --bundle-sksl-path` usava o cache SkSL, mas a partir do Flutter 3.7 o engine descontinuou esse fluxo porque o Impeller o tornou desnecessário. Se hoje você precisa entregar para um dispositivo Skia, o caminho recomendado é:

- Renderize uma vez cada página com efeitos incomuns durante a splash screen.
- Aqueça gradientes, blurs e transições animadas montando-as fora da tela na inicialização do app.
- Teste em um Android de gama baixa, não em um topo de linha.

Você confirma qual renderer está ativo nos logs do app em execução (`flutter run` imprime `Using the Impeller rendering backend`) ou na aba "Diagnostics" do DevTools.

## Um fluxo repetível que de fato funciona

Esse é o loop que eu uso, em ordem:

1. `flutter run --profile -d <real-device>`. Rejeite qualquer medição de jank que veio do simulador.
2. Reproduza o jank. Ative o Performance overlay dentro do app (`P` no terminal) para ver as barras de UI vs raster em tempo real. Confirme que o jank é real e reproduzível.
3. Abra o DevTools > Performance. Pressione "Record" antes do jank, reproduza-o, pressione "Stop".
4. Clique no pior frame vermelho. Leia o Frame Analysis. Decida UI vs raster.
5. Se UI: abra a aba CPU Profiler, grave o mesmo cenário, vá bottom-up até a função mais pesada. Mova o trabalho para fora da thread de UI ou reduza a área de rebuild.
6. Se raster: ative "Track paints" e "Highlight Repaints", procure `saveLayer`, imagens superdimensionadas e eventos de compilação de shaders. Substitua, reduza ou aqueça.
7. Verifique a correção no mesmo dispositivo. Trave o orçamento em um benchmark para que não haja regressão.

Para o passo 7, `package:flutter_driver` está descontinuado desde o Flutter 3.13 em favor do `package:integration_test` com `IntegrationTestWidgetsFlutterBinding.framework.allReportedDurations`. O [guia de testes de desempenho do time do Flutter](https://docs.flutter.dev/cookbook/testing/integration/profiling) mostra como conectar e emitir um arquivo JSON que você consegue comparar no CI. Se você roda uma matriz CI com várias versões do SDK do Flutter, o mesmo arnês encaixa em [um pipeline multiversão de Flutter](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).

## Eventos de timeline customizados para casos difíceis

Às vezes os eventos do engine não bastam e você quer ver seu próprio código no timeline. A biblioteca `dart:developer` expõe uma API de trace síncrono que o DevTools coleta automaticamente:

```dart
// Flutter 3.27.1, Dart 3.11
import 'dart:developer' as developer;

List<Product> parseCatalog(String json) {
  developer.Timeline.startSync('parseCatalog');
  try {
    return (jsonDecode(json) as List)
        .map((e) => Product.fromJson(e as Map<String, dynamic>))
        .toList();
  } finally {
    developer.Timeline.finishSync();
  }
}
```

Agora `parseCatalog` aparece como um span rotulado no timeline da thread de UI, e o Frame Analysis pode atribuir tempo a ele diretamente. Use com moderação: cada `Timeline.startSync` tem um custo pequeno mas não zero, então não embrulhe seu loop interno quente com um. Use-os em fronteiras grossas (um parse, um handler de resposta de rede, um método de controlador) onde o custo é desprezível comparado ao trabalho medido.

Para trabalho assíncrono, use `Timeline.timeSync` para seções síncronas dentro de funções async, ou `Timeline.startSync('name', flow: Flow.begin())` em conjunto com `Flow.step` e `Flow.end` para desenhar uma linha de fluxo que costura eventos relacionados entre threads. O painel Frame Analysis pode mostrar esse fluxo quando um frame é selecionado.

## Pressão de memória pode parecer jank

Se você está vendo soluços periódicos de 50 a 100 ms que aparecem na thread de UI mas não batem com nenhum código na sua pilha de chamadas, a causa costuma ser uma coleta de lixo maior. Abra a aba Memory e olhe a linha de marcador de GC. Coletas frequentes na geração antiga correlacionam com alocação de muitos objetos de vida curta por frame.

Os culpados habituais são:

- Alocar novos objetos `TextStyle` ou `Paint` dentro de `build`.
- Reconstruir listas imutáveis (`List.from`, `[...spread]`) a cada frame para `ListView`.
- Usar `Future.delayed(Duration.zero, () => setState(...))` como gambiarra para reentrância, o que agenda uma microtask a cada frame.

Tire constantes para fora do `build` (`const TextStyle(...)` no escopo do arquivo é seu amigo) e prefira listas mutáveis que você muta a reconstruir. O recurso "Profile Memory" da aba Memory captura um perfil de alocação de heap que aponta qual classe está produzindo o lixo.

## Chamar código nativo é seu próprio problema de profiling

Se seu app usa platform channels (um `MethodChannel`, um `EventChannel`), o Dart vê essas chamadas como simples `Future`s mas o trabalho real acontece em uma thread de plataforma. O DevTools mostra a espera do lado Dart mas não consegue ver dentro do handler nativo. Se um frame está com jank por causa de uma implementação lenta em Kotlin ou Swift, você precisa anexar um profiler nativo (CPU Profiler do Android Studio ou Xcode Instruments) ao mesmo processo.

A outra pegadinha é que chamadas síncronas por platform channel são ilegais no Flutter moderno (quebram com `Synchronous platform messages are not allowed`), então qualquer bloqueio é bloqueio assíncrono no lado Dart. Se um `MethodChannel.invokeMethod` leva 200 ms, são 200 ms durante os quais `await` retorna e um frame consegue completar, mas qualquer coisa encadeada ao resultado vai cair em um frame posterior, o que pode parecer frames pulados. A correção é arquitetar o canal de modo que a UI nunca dependa de um único round-trip para renderizar. Há mais nuance no [guia de platform channels](/pt-br/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/).

## Falsos positivos comuns

Um frame não é "janky" só por ser longo. Alguns padrões que parecem jank mas não são:

- O primeiro frame após um hot reload. Hot reload re-resolve widgets e propositalmente não é otimizado. Ignore o primeiro frame após qualquer reload.
- Um frame que roda enquanto o app está indo para segundo plano. O sistema operacional pode pausar o renderer no meio do frame.
- Um frame fantasma durante recompilação em segundo plano.

Na dúvida, reproduza o jank duas vezes em um `flutter run --profile` recém-iniciado e só acredite no que for consistente entre as duas execuções.

## Relacionados

- [Escrever um isolate de Dart para trabalho CPU-bound](/pt-br/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) cobre como mover parses ou cálculos pesados para fora da thread de UI.
- [Adicionar código específico de plataforma em Flutter sem plugins](/pt-br/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) aprofunda em `MethodChannel` e no modelo de threads.
- [Mirar várias versões do Flutter em um único pipeline CI](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) é o arnês que você quer assim que tiver um benchmark de regressão.
- [Migrar um app Flutter de GetX para Riverpod](/pt-br/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) trata do escopo de rebuilds, uma das maiores fontes de jank na thread de UI.
- [Depurar Flutter iOS pelo Windows: um fluxo com dispositivo real](/pt-br/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/) mostra como anexar o DevTools a um dispositivo iOS construído remotamente quando você não consegue rodar o Xcode localmente.

## Links de referência

- [Visão geral de desempenho de apps Flutter](https://docs.flutter.dev/perf/ui-performance) (docs.flutter.dev)
- [Vista Performance do DevTools](https://docs.flutter.dev/tools/devtools/performance) (docs.flutter.dev)
- [CPU Profiler do DevTools](https://docs.flutter.dev/tools/devtools/cpu-profiler) (docs.flutter.dev)
- [Perfilando o desempenho do app com testes de integração](https://docs.flutter.dev/cookbook/testing/integration/profiling) (docs.flutter.dev)
- [Engine de renderização Impeller](https://docs.flutter.dev/perf/impeller) (docs.flutter.dev)
- [API Timeline de `dart:developer`](https://api.dart.dev/stable/dart-developer/Timeline-class.html) (api.dart.dev)
