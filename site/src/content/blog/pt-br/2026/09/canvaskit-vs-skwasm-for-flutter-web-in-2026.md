---
title: "CanvasKit vs skwasm para Flutter web em 2026: qual renderizador você deve publicar?"
description: "Publique skwasm com flutter build web --wasm quando suas dependências compilam para Wasm: ele baixa menos e renderizou 36% mais frames que o CanvasKit em uma cena pesada. No Flutter 3.47.x, mantenha-o single-threaded até a correção do crash de texto multi-threaded sair do beta."
pubDate: 2026-09-17
template: vs
tags:
  - "comparison"
  - "flutter"
  - "flutter-web"
  - "webassembly"
  - "performance"
lang: "pt-br"
translationOf: "2026/09/canvaskit-vs-skwasm-for-flutter-web-in-2026"
translatedBy: "claude"
translationDate: 2026-09-17
---

Publique skwasm. No Flutter 3.47.4 (o stable atual, Dart 3.13.3), `flutter build web --wasm` entrega aos usuários do Chromium um download menor (1,65 MB vs 1,98 MB em brotli para o app de benchmark abaixo) e 32,7 frames por segundo vs 24,0 do CanvasKit em uma cena pesada. Firefox, Safari e todos os navegadores do iOS continuam recebendo CanvasKit a partir do mesmo build. Fique em um build somente CanvasKit apenas se alguma dependência ainda importar `dart:html` ou `package:js`. Uma ressalva do 3.47.x: o skwasm multi-threaded pode travar em frames com muito texto, então force o modo single-threaded até o 3.48 chegar ao stable.

"Renderizador" é uma palavra um pouco enganosa aqui, porque você não escolhe CanvasKit ou skwasm isoladamente. Desde que o Flutter 3.29 removeu o renderizador HTML e a flag `--web-renderer`, o renderizador decorre do alvo de compilação. A saída do `dart2js` sempre roda no CanvasKit, e a saída do `dart2wasm` sempre roda no skwasm. A ferramenta garante isso: `flutter build web --wasm --dart-define=FLUTTER_WEB_USE_SKIA=true --dart-define=FLUTTER_WEB_USE_SKWASM=false` encerra com `Do not attempt to set a web renderer when using "--wasm"`. Então a pergunta real é "build JavaScript ou build Wasm", e a resposta decide qual Skia roda por baixo.

## A matriz de recursos

| Propriedade (Flutter 3.47.4)       | CanvasKit                                           | skwasm                                                        |
| ---------------------------------- | --------------------------------------------------- | ------------------------------------------------------------- |
| Alvo de compilação                 | `dart2js`                                           | `dart2wasm` (requer WasmGC)                                   |
| Comando de build                   | `flutter build web`                                 | `flutter build web --wasm` (também gera o build CanvasKit)    |
| Navegadores que o carregam por padrão | Todos                                            | Somente Blink (Chrome, Edge, Opera, Chrome no Android)        |
| Download do engine, brotli         | 1.54 MB (variante Chromium), 2.26 MB (variante completa) | 1.21 MB (`skwasm.wasm`), 1.86 MB (`skwasm_heavy.wasm`)   |
| Rasteriza em                       | Thread principal                                    | Um Web Worker quando a página tem isolamento cross-origin     |
| Headers necessários para o melhor modo | Nenhum                                          | `Cross-Origin-Opener-Policy` + `Cross-Origin-Embedder-Policy` |
| `dart:html`, `package:js` no grafo | Tudo bem                                            | Erro de compilação                                            |
| Depuração com `flutter run -d chrome` | DevTools completo, hot reload com estado (DDC)   | Sem service protocol, hot reload vira restart                 |
| Carregamento adiado (deferred)     | Sim                                                 | Desligado por padrão, flag experimental prevista para 3.50    |
| Problema conhecido no canal stable | Nenhum bloqueante                                   | Crash multi-threaded com troca de texto, #190039              |

Duas linhas merecem uma nota. A linha "Somente Blink" não tem a ver com suporte a WasmGC: Firefox e Safari já validam WasmGC hoje. O loader do Flutter os mantém fora do skwasm com uma allowlist fixa no código em `browser_environment.js` (`blink: true, gecko: false, webkit: false`). O motivo é que o skwasm multi-threaded entrega os frames do worker para a página com `OffscreenCanvas.transferToImageBitmap`, que é lento nos dois engines. Os bugs de acompanhamento, [Mozilla 1788206](https://bugzilla.mozilla.org/show_bug.cgi?id=1788206) e [WebKit 267291](https://bugs.webkit.org/show_bug.cgi?id=267291), ainda estavam como `NEW` em setembro de 2026.

A linha de depuração vem direto de `resident_web_runner.dart` no 3.47.4: `supportsServiceProtocol` é `!debuggingOptions.webUseWasm && isRunningDebug && ...`, e `reloadIsRestart` retorna `true` sempre que `webUseWasm` está definido. Por isso o desenvolvimento do dia a dia continua no caminho JavaScript, mesmo para equipes que publicam Wasm.

## O que cada build realmente baixa

Um build `--wasm` grava os dois pipelines em `build/web`, e `flutter_bootstrap.js` carrega um `buildConfig` que os lista em ordem de prioridade:

```jsonc
// flutter build web --wasm, Flutter 3.47.4
"builds": [
  {"compileTarget": "dart2wasm", "renderer": "skwasm", "mainWasmPath": "main.dart.wasm", "jsSupportRuntimePath": "main.dart.mjs"},
  {"compileTarget": "dart2js", "renderer": "canvaskit", "mainJsPath": "main.dart.js"}
]
```

O loader pega a primeira entrada compatível. Dentro de cada renderizador, ele então escolhe uma variante com base nos recursos do navegador. `canvaskit_loader.js` carrega `canvaskit/chromium/canvaskit.wasm` quando o navegador tem tanto `ImageDecoder` quanto `Intl.v8BreakIterator`. Essa variante deixa os codecs de imagem e os dados de ICU a cargo do navegador, e o Flutter 3.47.0 removeu dela os codecs restantes ([#178133](https://github.com/flutter/flutter/pull/178133)). Todo o resto recebe o `canvaskit.wasm` completo. `skwasm_loader.js` tem a mesma divisão: `skwasm.wasm` no Chromium, e o `skwasm_heavy.wasm`, maior, em qualquer lugar onde essas duas APIs faltem. Na prática, você só vê `skwasm_heavy` se sobrescrever a allowlist para colocar Firefox ou Safari no Wasm.

Medi quanto custa uma primeira visita em cada caminho, usando o build de release do app de benchmark descrito abaixo (um app Material de cerca de 180 linhas). Os tamanhos são `brotli -q 11` e `gzip -9` dos arquivos que cada caminho busca. `flutter.js`, `flutter_bootstrap.js`, fontes e assets são iguais em todos os caminhos, então ficaram de fora:

| Caminho (Flutter 3.47.4)    | Código do app                         | JS + Wasm do renderizador | Total brotli | Total gzip |
| --------------------------- | ------------------------------------- | ------------------ | ------------ | ---------- |
| CanvasKit, variante Chromium | `main.dart.js` 413 KB                | 1,564 KB           | **1,977 KB** | 2,612 KB   |
| CanvasKit, variante completa | `main.dart.js` 413 KB                | 2,281 KB           | **2,695 KB** | 3,465 KB   |
| skwasm                      | `main.dart.wasm` 416 KB + `.mjs` 6 KB | 1,225 KB           | **1,647 KB** | 2,083 KB   |

O código do app empata nesse tamanho: 1,42 MB de Wasm bruto e 1,79 MB de JavaScript minificado bruto comprimem para quase o mesmo tamanho em brotli. A economia vem do engine, já que `skwasm.wasm` é cerca de 330 KB menor que o CanvasKit Chromium. Uma ressalva para apps grandes: `dart2wasm` não divide imports adiados por padrão, então um app que depende de `deferred as` para manter pequeno o primeiro carregamento pode ver o caminho Wasm perder essa vantagem.

## O benchmark

O tamanho do download é só metade da história. A outra metade é o tempo de frame, então renderizei as mesmas cenas com cada configuração.

**Ambiente.** Apple M4, 16 GB de RAM, macOS 26. Google Chrome 153.0.8010.48 iniciado com `--headless=new --use-angle=metal` (o WebGL reportou `ANGLE Metal Renderer: Apple M4`), uma janela de 1280x800 com DPR 1 e um perfil novo a cada execução. O app foi compilado em modo release com Flutter 3.47.4 e com 3.48.0-0.5.pre, usando `flutter build web --wasm --no-web-resources-cdn`, e servido a partir de localhost com `Cache-Control: no-store`. Uma porta enviava `Cross-Origin-Opener-Policy: same-origin` e `Cross-Origin-Embedder-Policy: require-corp`, e outra não enviava nenhum dos dois.

**Metodologia.** Um único build `--wasm` serviu todas as configurações. Um `flutter_bootstrap.js` personalizado lia o renderizador da query string, então as execuções com CanvasKit usaram exatamente o mesmo fallback `main.dart.js` que usuários reais do Firefox baixam:

```js
// web/flutter_bootstrap.js, Flutter 3.47.4
{{flutter_js}}
{{flutter_build_config}}
const q = new URLSearchParams(location.search);
const config = {suppressMultithreadingWarning: true};
if (q.get('renderer')) config.renderer = q.get('renderer');   // 'skwasm' or 'canvaskit'
if (q.get('st')) config.forceSingleThreadedSkwasm = true;
if (q.get('variant')) config.canvasKitVariant = q.get('variant'); // 'full' to skip the Chromium variant
_flutter.loader.load({config});
```

Dentro do app, `SchedulerBinding.instance.addTimingsCallback` coletou `FrameTiming`s por 10 segundos após um aquecimento de 3 segundos. Na web, eles são registrados pelo `FrameTimingRecorder` do engine em torno de cada chamada `draw` do rasterizador. "Fps apresentados" é o número de timings (frames que terminaram de rasterizar) por segundo, e cada célula é a mediana de 3 execuções (5 para skwasm multi-threaded no 3.48). No 3.48.0-0.5.pre, CanvasKit (24,0 fps) e skwasm single-threaded (32,3 fps) ficaram a menos de 2% dos seus números no 3.47.4, então as tabelas mostram o 3.47.4 sempre que ele rodou sem problemas. A cena "tiles" tem 600 `Container`s girando com gradiente, cantos arredondados, um `BoxShadow` e um `Text` cujo conteúdo muda a cada frame. A cena "paths" é um `CustomPainter` desenhando o contorno de 400 paths animados de 40 segmentos.

**Cena tiles (pesada):**

| Configuração                           | Fps apresentados | Build p50 | Raster p50 | Frame span p90 | Primeiro frame |
| -------------------------------------- | ------------- | --------- | ---------- | -------------- | ----------- |
| CanvasKit, variante Chromium (3.47.4)  | 24.0          | 24.2 ms   | 17.1 ms    | 44.0 ms        | 285 ms      |
| CanvasKit, variante completa (3.47.4)  | 24.3          | 23.7 ms   | 17.2 ms    | 42.9 ms        | 286 ms      |
| skwasm, single-threaded (3.47.4)       | **32.7**      | 13.6 ms   | 16.0 ms    | 31.4 ms        | 193 ms      |
| skwasm, multi-threaded (3.47.4)        | travado       | n/a       | n/a        | n/a            | 245 ms      |
| skwasm, multi-threaded (3.48.0-0.5.pre) | **39.3**     | 14.7 ms   | 22.5 ms    | 48.0 ms        | 238 ms      |

**Cena paths (leve):**

| Configuração (3.47.4)       | Fps apresentados | Build p50 | Raster p50 |
| --------------------------- | ------------- | --------- | ---------- |
| CanvasKit, variante Chromium | 60.4         | 3.3 ms    | 3.0 ms     |
| skwasm, single-threaded     | 60.0          | 1.2 ms    | 3.9 ms     |
| skwasm, multi-threaded      | 59.9          | 1.1 ms    | 4.1 ms     |

Quatro coisas se destacam:

1. **A maior parte do ganho vem do `dart2wasm`, não do Skia.** O tempo de rasterização é quase idêntico (17,1 ms vs 16,0 ms em tiles, e o CanvasKit é até mais rápido em paths). A fase de build, ou seja, o código Dart de widgets, layout e paint, roda cerca de duas vezes mais rápido quando compilado para WasmGC. Quanto mais trabalho do framework por frame, maior a diferença.
2. **Multi-threading troca latência por throughput.** No 3.48 beta, o build multi-threaded apresentou 22% mais frames que o single-threaded (39,3 vs 32,3 fps), enquanto seu raster p50 subiu para 22,5 ms. A thread de UI compila o próximo frame enquanto o worker ainda rasteriza o anterior. `Renderer.renderScene` mantém apenas a cena pendente mais recente e descarta o resto. O resultado é mais frames no total e um intervalo maior por frame.
3. **Cenas leves ficam limitadas ao vsync de qualquer jeito.** Se o seu app é feito de formulários e listas, você não vai notar a diferença de renderizador na taxa de frames. Vai notar a diferença de download e de inicialização.
4. **O primeiro frame em localhost favorece o skwasm single-threaded em cerca de 90 ms** (193 ms vs 285 ms; iniciar o worker de renderização devolve parte disso no modo multi-threaded). Sem a rede no meio, essa diferença é custo de compilação e instanciação. Em uma conexão real, a diferença de 330 KB em brotli se soma a ela.

Trate os números absolutos como específicos de um M4 rodando Metal. As proporções é que se transferem.

## Quando escolher skwasm

- **Seu público é majoritariamente Chrome ou Edge no desktop, ou Chrome no Android.** Esses são os usuários que realmente recebem o build Wasm, e eles ganham de graça o download menor e a fase de build mais rápida. Todos os outros caem de forma transparente para o CanvasKit.
- **Seus frames são pesados em framework.** Dashboards, grids de dados e listas animadas gastam o tempo em build e layout, exatamente onde o `dart2wasm` saiu na frente no benchmark.
- **Você controla os headers de resposta.** O modo multi-threaded precisa de `Cross-Origin-Opener-Policy: same-origin` e `Cross-Origin-Embedder-Policy: credentialless` (ou `require-corp`). Sem eles o skwasm ainda funciona, em single-threaded, e registra um aviso que você pode silenciar com `suppressMultithreadingWarning: true`.
- **Todo o seu grafo de dependências está em `package:web` e `dart:js_interop`.** O `flutter build web` simples faz um dry run de Wasm a cada build e imprime "Wasm dry run succeeded" ou os imports problemáticos, então você já sabe.

## Quando escolher CanvasKit

- **Uma dependência ainda importa `dart:html`, `dart:js` ou `package:js`.** O `dart2wasm` se recusa a compilá-la, então a escolha está feita por você até esse pacote migrar.
- **A maior parte do seu tráfego é iOS ou Safari.** Esses usuários recebem CanvasKit de um build `--wasm` de qualquer forma. O build Wasm só adiciona tempo de build e um segundo pipeline para testar, sem nenhum benefício para eles.
- **Você incorpora conteúdo cross-origin e não pode adotar COEP.** Iframes de terceiros, scripts de anúncios ou imagens sem headers CORS podem quebrar com `require-corp`, e `credentialless` remove os cookies dessas requisições. O skwasm single-threaded não precisa de headers, mas você perde o ganho de throughput.
- **Você precisa de carregamento adiado para reduzir o primeiro carregamento.** Até o carregamento adiado no Wasm sair da flag experimental, um build JavaScript com imports `deferred as` pode começar menor que um `main.dart.wasm` monolítico.

## A pegadinha que escolhe por você no 3.47.x

Na cena tiles, o skwasm multi-threaded no Flutter 3.47.4 travou em 6 de 7 execuções. Em quatro delas, `requestAnimationFrame` continuou disparando e o framework continuou compilando frames a 60 fps, mas nenhum `FrameTiming` chegou após os primeiros frames, então nada novo chegou à tela. Nas outras duas, a página parou totalmente de executar timers do Dart. O console do Chrome mostrou `Uncaught RuntimeError: null function` e `table index is out of bounds` vindos de `skwasm.wasm` em algumas execuções, e absolutamente nada em outras. A mesma cena em single-threaded, e a cena paths sem texto em multi-threaded, rodaram sem problemas todas as vezes.

Isso bate com [flutter/flutter#190039](https://github.com/flutter/flutter/issues/190039). Segundo a descrição da correção, o skwasm multi-threaded é compilado com `-sWASM_WORKERS` mas sem `-pthread`, então ele linka as bibliotecas de sistema single-threaded do emscripten, onde os mutexes não fazem nada. O layout de texto na thread principal e o worker de raster passam então a compartilhar o `SkStrikeCache` global do Skia e corrompem o heap quando o texto muda a cada frame. A correção, [PR #190048](https://github.com/flutter/flutter/pull/190048) ("Use thread local strike caches in skwasm"), foi mesclada em 2026-08-05 e faz parte do 3.48.0-0.5.pre. Com o mesmo app recompilado nesse beta, 5 de 5 execuções ficaram estáveis, sem `RuntimeError`. Um pedido de cherry-pick para o stable ([#192115](https://github.com/flutter/flutter/pull/192115)) foi fechado sem merge em 2026-09-01, e nenhuma versão 3.47.x até a 3.47.4 traz a correção.

Até você estar no 3.48 stable, mantenha o build Wasm e desligue as threads em `web/flutter_bootstrap.js`:

```js
// web/flutter_bootstrap.js, Flutter 3.47.x: avoid #190039
{{flutter_js}}
{{flutter_build_config}}
_flutter.loader.load({
  config: {
    forceSingleThreadedSkwasm: true,
    suppressMultithreadingWarning: true,
  },
});
```

O skwasm single-threaded ainda superou o CanvasKit em 36% nos frames apresentados, então isso custa o bônus do multi-threading, não o ganho do Wasm. Deixar de fora os headers COOP/COEP tem o mesmo efeito, mas a flag de configuração é mais fácil de reverter depois.

Vale conhecer duas saídas de emergência na mesma configuração. `renderer: 'canvaskit'` faz o loader pular a entrada Wasm e carregar o build `dart2js`. Nas minhas execuções no 3.47.4 isso funcionou a partir de um build `--wasm` e reportou `dart.tool.dart2wasm == false`, então um seletor via query string como o de cima vira um kill switch de produção. E `verboseBuildSelection: true` (novo no 3.47.0) registra por que cada build candidato foi ignorado, que é o jeito mais rápido de responder "por que esse usuário está no CanvasKit".

## A recomendação, de novo

Compile com `flutter build web --wasm` e deixe o loader entregar skwasm ao Chromium e CanvasKit a todos os outros. No 3.47.x, adicione `forceSingleThreadedSkwasm: true` e remova quando migrar para o 3.48 stable com os headers COOP/COEP configurados. Volte para um build CanvasKit simples apenas quando uma dependência bloquear o `dart2wasm`. Os engines rasterizam praticamente na mesma velocidade. O que você está escolhendo de verdade é o `dart2wasm` para o seu próprio código Dart, e em 2026 essa é a opção mais rápida e menor onde quer que o navegador permita.

## Relacionados

- [Como compilar um app Flutter web com WebAssembly](/pt-br/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/) percorre o build `--wasm` de ponta a ponta, incluindo como provar qual build um navegador carregou.
- [Migrando um app Flutter web de `dart:html` para `package:web`](/pt-br/2026/09/migrate-a-flutter-web-app-from-dart-html-to-package-web/) é o pré-requisito se o dry run de Wasm apontar problemas no seu código.
- [Correção: Flutter web serve um build antigo do cache após recarregar](/pt-br/2026/09/fix-flutter-web-serves-a-stale-cached-build-after-reload/) cobre os headers `Cache-Control` que ficam ao lado de COOP/COEP na mesma configuração de hospedagem.
- [Flutter 3.47 torna o Impeller o renderizador padrão no desktop](/pt-br/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/) cobre a outra troca de renderizador na mesma versão.

## Fontes

- [Support for WebAssembly (Wasm)](https://docs.flutter.dev/platform-integration/web/wasm): suporte dos navegadores, headers obrigatórios, flag de carregamento adiado.
- [Flutter web app initialization](https://docs.flutter.dev/platform-integration/web/initialization): `canvasKitVariant`, `forceSingleThreadedSkwasm` e as demais opções de configuração do loader.
- Código-fonte do loader e do engine no 3.47.4: [`browser_environment.js`](https://github.com/flutter/flutter/blob/3.47.4/engine/src/flutter/lib/web_ui/flutter_js/src/browser_environment.js), [`loader.js`](https://github.com/flutter/flutter/blob/3.47.4/engine/src/flutter/lib/web_ui/flutter_js/src/loader.js), [`skwasm_loader.js`](https://github.com/flutter/flutter/blob/3.47.4/engine/src/flutter/lib/web_ui/flutter_js/src/skwasm_loader.js), [`canvaskit_loader.js`](https://github.com/flutter/flutter/blob/3.47.4/engine/src/flutter/lib/web_ui/flutter_js/src/canvaskit_loader.js).
- Código-fonte da ferramenta no 3.47.4: [`build_web.dart`](https://github.com/flutter/flutter/blob/3.47.4/packages/flutter_tools/lib/src/commands/build_web.dart), [`compile.dart`](https://github.com/flutter/flutter/blob/3.47.4/packages/flutter_tools/lib/src/web/compile.dart), [`resident_web_runner.dart`](https://github.com/flutter/flutter/blob/3.47.4/packages/flutter_tools/lib/src/isolated/resident_web_runner.dart).
- [flutter/flutter#190039](https://github.com/flutter/flutter/issues/190039), [PR #190048](https://github.com/flutter/flutter/pull/190048) e [PR #192115](https://github.com/flutter/flutter/pull/192115): o crash do skwasm multi-threaded, sua correção e o cherry-pick para o stable que foi fechado.
- [Flutter 3.47.0 release notes](https://docs.flutter.dev/release/release-notes/release-notes-3.47.0): `verboseBuildSelection`, remoção de codecs da variante Chromium do CanvasKit.
- [PR #159314](https://github.com/flutter/flutter/pull/159314): remoção da flag `--web-renderer`.
- [Mozilla bug 1788206](https://bugzilla.mozilla.org/show_bug.cgi?id=1788206) e [WebKit bug 267291](https://bugs.webkit.org/show_bug.cgi?id=267291): por que Firefox e Safari não estão na allowlist do Wasm.
