---
title: "Como compilar um app web Flutter com WebAssembly usando flutter build web --wasm"
description: "Guia completo para publicar um app web Flutter compilado para WebAssembly no Flutter 3.44: como são as duas builds emitidas, por que Firefox e Safari continuam recebendo JavaScript por causa do wasmAllowList do loader, a migração de dart:html para dart2wasm, os headers COOP/COEP que decidem se o skwasm roda com múltiplas threads, e como provar em runtime qual build o navegador realmente carregou."
pubDate: 2026-07-28
template: how-to
tags:
  - "flutter"
  - "dart"
  - "webassembly"
  - "flutter-web"
  - "performance"
  - "how-to"
lang: "pt-br"
translationOf: "2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm"
translatedBy: "claude"
translationDate: 2026-07-28
---

Para compilar um app web Flutter com WebAssembly, adicione o flag `--wasm`: `flutter build web --wasm`. Esse único flag faz a ferramenta emitir *duas* builds em `build/web`: uma build WasmGC compilada pelo `dart2wasm` que usa o renderer `skwasm`, e a build comum de `dart2js` que usa `canvaskit` como fallback. Um `flutter_bootstrap.js` gerado escolhe uma no carregamento da página. Depois disso, duas coisas decidem se os usuários reais recebem a build Wasm: nada no seu grafo de dependências pode importar `dart:html`, `dart:js`, `dart:js_util` ou `package:js`, e seu servidor precisa enviar `Cross-Origin-Opener-Policy: same-origin` mais `Cross-Origin-Embedder-Policy: credentialless`, caso contrário o `skwasm` cai silenciosamente para uma única thread. Este artigo tem como alvo o Flutter 3.44 stable (lançado em 2026-05-18, traz o Dart 3.10) e cada detalhe abaixo foi verificado contra o branch `stable` do `flutter/flutter`. A ressalva importante já de início: a partir do 3.44 o loader só habilita a build Wasm em navegadores Blink, então Firefox, Safari e todos os navegadores no iOS recebem a build JavaScript, não importa o que você compile.

## O que o `--wasm` realmente coloca em build/web

O modelo mental que a maioria tem está errado de um jeito útil. O `--wasm` não troca sua build de JavaScript para WebAssembly. Ele *adiciona* uma build WebAssembly ao lado da de JavaScript. Em `packages/flutter_tools/lib/src/commands/build_web.dart`, passar o flag produz uma lista de duas configurações de compilador, um `WasmCompilerConfig` e um `JsCompilerConfig`, e a ferramenta executa os dois compiladores. Sem o flag você recebe um `JsCompilerConfig` real mais um `WasmCompilerConfig` marcado como `dryRun: true`, que compila mas descarta o resultado (mais sobre isso em um instante).

Cada alvo compilado contribui com uma descrição de build para um `flutter_bootstrap.js` gerado. Depois de `flutter build web --wasm` no Flutter 3.44, o descritor fica assim:

```javascript
// Excerpt from build/web/flutter_bootstrap.js, Flutter 3.44 stable
if (!window._flutter) {
  window._flutter = {};
}
_flutter.buildConfig = {
  "engineRevision": "...",
  "builds": [
    {
      "compileTarget": "dart2wasm",
      "renderer": "skwasm",
      "mainWasmPath": "main.dart.wasm",
      "jsSupportRuntimePath": "main.dart.mjs"
    },
    {
      "compileTarget": "dart2js",
      "renderer": "canvaskit",
      "mainJsPath": "main.dart.js"
    }
  ]
};
```

A ordem importa: `FlutterLoader.load()` chama `buildConfig.builds.find(buildIsCompatible)` e pega a *primeira* entrada compatível, então a build Wasm ganha sempre que o ambiente permitir. O pareamento do renderer não é configurável. `WebRendererMode.defaultForWasm` é `skwasm` e `defaultForJs` é `canvaskit`, e a ferramenta não deixa você misturar os dois, o que é a primeira pegadinha listada mais abaixo.

Em disco você recebe `main.dart.wasm` (o módulo), `main.dart.mjs` (o runtime de suporte JS que o instancia) e `main.dart.js` (o fallback), além das cargas de cada renderer: `skwasm.js` e `skwasm.wasm` para o caminho Wasm, e o bundle do CanvasKit para o caminho de fallback.

## Os cinco passos que realmente importam

1. **Use o Flutter 3.24 ou posterior.** A compilação para Wasm chegou ao stable no 3.24; aqui testei com o 3.44. Se você faz malabarismo com versões do SDK por projeto, minhas anotações sobre [rodar um mesmo projeto Flutter contra várias versões do SDK no CI](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) valem sem alterações para builds Wasm.
2. **Regenere o `web/index.html` se ele for anterior ao Flutter 3.22.** O caminho Wasm depende inteiramente do loader `flutter_bootstrap.js`, então o antigo bootstrap com `serviceWorkerVersion` não vai funcionar. `flutter create . --platforms web` depois de apagar `web/` entrega o template atual.
3. **Tire as incompatibilidades com o `dart2wasm` do seu grafo de dependências.** Compile primeiro com `flutter build web` sem `--wasm` e leia os achados do dry run.
4. **Compile:** `flutter build web --wasm`.
5. **Sirva com headers de isolamento de origem cruzada.** Sem eles o app ainda roda, mas com uma única thread, o que joga fora a maior parte do motivo para usar Wasm.

## Por que seu app ainda executa JavaScript no Firefox e no Safari

Esta é a parte que surpreende as pessoas, e a página oficial de suporte a Wasm está desatualizada o bastante (o frontmatter `last-update` diz Nov 6, 2024) para que lê-la não explique o comportamento atual. O WasmGC já não é a restrição: ele alcançou Baseline no Chrome 119, Firefox 120 e Safari 18.2. A restrição é uma lista de permissões fixa no loader do engine.

O arquivo `engine/src/flutter/lib/web_ui/flutter_js/src/browser_environment.js` no `stable` contém exatamente isto:

```javascript
// engine/src/flutter/lib/web_ui/flutter_js/src/browser_environment.js
export const defaultWasmSupport = {
  "blink": true,
  "gecko": false,
  "webkit": false,
  "unknown": false,
}
```

E o `loader.js` condiciona a build `skwasm` a essa lista:

```javascript
// engine/src/flutter/lib/web_ui/flutter_js/src/loader.js
const supportsDart2Wasm = browserEnvironment.supportsWasmGC;
const supportsSkwasm = supportsDart2Wasm && browserEnvironment.webGLVersion > 0;

const enableWasm = config.wasmAllowList?.[browserEnvironment.browserEngine]
  ?? defaultWasmSupport[browserEnvironment.browserEngine];
```

Então no Firefox, `supportsWasmGC()` devolve `true` (o detector valida um módulo WasmGC mínimo e o Firefox passa), mas `enableWasm` resolve para `false` por causa da entrada `gecko`, a build `skwasm` é rejeitada como incompatível, e o loader cai para `dart2js` + `canvaskit`. A mesma história para o Safari via `webkit`. O motivo não é o WasmGC, mas o renderer: o `skwasm` multithread do Flutter depende de `OffscreenCanvas.transferToImageBitmap`, e tanto o bug do Firefox (Bugzilla 1788206) quanto o do WebKit (267291) que rastreiam seu custo continuavam abertos quando verifiquei em julho de 2026.

Você pode sobrescrever a lista de permissões, o que vale a pena fazer atrás de um parâmetro de query se quiser números reais em vez de opiniões:

```javascript
// web/flutter_bootstrap.js, Flutter 3.44
{{flutter_js}}
{{flutter_build_config}}

const params = new URLSearchParams(window.location.search);
_flutter.loader.load({
  config: {
    // Only opt gecko/webkit in deliberately. Expect rendering artifacts.
    wasmAllowList: params.has('force_wasm')
      ? { blink: true, gecko: true, webkit: true, unknown: false }
      : undefined,
  },
});
```

Não publique isso em produção por palpite. Meça primeiro com o fluxo de [perfilar jank em um app Flutter com DevTools](/pt-br/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/), porque nos engines afetados o modo de falha é tempo de frame degradado, não um erro limpo.

Um limite não tem sobrescrita nenhuma: todos os navegadores no iOS são obrigados a usar o WebKit, então um app Flutter compilado para Wasm não pode rodar no iOS Safari, no iOS Chrome nem em qualquer outra coisa naquela plataforma.

## Fazendo suas dependências compilarem

O `dart2wasm` suporta apenas o interop estático de JS do Dart. Qualquer import transitivo de `dart:html`, `dart:js`, `dart:js_util` ou `package:js` derruba a compilação com mensagens como estas:

```output
Dart library 'dart:html' is not available on this platform.
JS interop library 'dart:js_util' can't be imported when compiling to Wasm.
Try using 'dart:js_interop' or 'dart:js_interop_unsafe' instead.
```

A boa notícia é que você não precisa descobrir isso na tentativa. O `--wasm-dry-run` vem como `true` por padrão, então um `flutter build web` comum já roda o `dart2wasm` em modo dry run e reporta o que encontrou:

```output
Wasm dry run findings:
...
Consider addressing these issues to enable wasm builds. See docs for more info:
https://docs.flutter.dev/platform-integration/web/wasm
```

Se seu app já estiver limpo, o mesmo mecanismo empurra na direção oposta com `Wasm dry run succeeded. Consider building and testing your application with the --wasm flag.` De qualquer forma, `flutter build web --no-wasm-dry-run` silencia isso depois que você tomou sua decisão.

Para o código que é seu, a migração é `package:web` no lugar de `dart:html` e `dart:js_interop` no lugar de `package:js`:

```dart
// Dart 3.10, Flutter 3.44 -- wasm-compatible
import 'dart:js_interop';
import 'package:web/web.dart' as web;

@JS('navigator.clipboard.writeText')
external JSPromise<JSAny?> _writeText(String text);

Future<void> copy(String text) async {
  await _writeText(text).toDart;
  web.document.querySelector('#status')?.textContent = 'Copied';
}
```

Três diferenças machucam durante a migração. Os nomes seguem o IDL do navegador, então `HtmlElement` passa a ser `HTMLElement` e `innerHtml` passa a ser `innerHTML`. `querySelectorAll` retorna um iterável que não é uma `List`. E como os tipos de interop são extension types, `is` e `as` não fazem o que você espera; use `isA<T>()` em vez disso. Os imports condicionais também mudam: a guarda agora é `dart.library.js_interop`, não `dart.library.html`. Se você escreve o interop na mão em vez de puxar um plugin, os padrões de [adicionar código específico de plataforma no Flutter sem plugins](/pt-br/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) se aplicam diretamente.

Para o código que não é seu, filtre o pub.dev por `is:wasm-ready`. Quando uma dependência é o bloqueio, atualizá-la costuma ser a solução inteira, e vale a dor habitual de resolução de restrições; se você cair no inferno do resolver, [Fix: Version solving failed em pubspec.yaml](/pt-br/2026/05/fix-version-solving-failed-in-pubspec-yaml/) cobre a saída.

## COOP e COEP decidem se você recebe threads

O Flutter compila o `skwasm` com memória compartilhada. Você vê isso na invocação do compilador em `build_system/targets/web.dart`, que acrescenta `--import-shared-memory` e `--shared-memory-max-pages=32768` para o renderer `skwasm`. Memória compartilhada em um navegador exige isolamento de origem cruzada, que exige dois headers de resposta. A ferramenta fixa o par que quer:

```dart
// packages/flutter_tools/lib/src/web/web_constants.dart, Flutter 3.44
const kCrossOriginIsolationHeaders = <String, String>{
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};
```

O `flutter run -d chrome --wasm` envia esses headers no seu próprio servidor de desenvolvimento, que é exatamente o motivo pelo qual o problema nunca aparece localmente e depois aparece em produção. Não há erro nenhum quando eles faltam. O `skwasm_loader.js` calcula `skwasmSingleThreaded: ... || !browserEnvironment.crossOriginIsolated || ...` e inicia silenciosamente um engine de uma única thread.

Para o nginx:

```nginx
# nginx, serving build/web
location / {
    add_header Cross-Origin-Opener-Policy   same-origin   always;
    add_header Cross-Origin-Embedder-Policy credentialless always;
    try_files $uri $uri/ /index.html;
}
```

Para o Firebase Hosting:

```json
{
  "hosting": {
    "public": "build/web",
    "headers": [
      {
        "source": "**",
        "headers": [
          { "key": "Cross-Origin-Opener-Policy",   "value": "same-origin" },
          { "key": "Cross-Origin-Embedder-Policy", "value": "credentialless" }
        ]
      }
    ]
  }
}
```

Verifique no console do navegador com `window.crossOriginIsolated`, que precisa ser `true`. Note que o GitHub Pages não consegue enviar headers customizados de jeito nenhum, então uma build Wasm hospedada lá sempre vai rodar com uma única thread.

O isolamento de origem cruzada não é de graça. O `require-corp` quebra qualquer subrecurso de origem cruzada que não opte por participar com `Cross-Origin-Resource-Policy`, o que na prática significa imagens de terceiros, fontes, beacons de análise e iframes embutidos. O `credentialless` é o mais suave dos dois: ele carrega subrecursos de origem cruzada sem credenciais em vez de bloqueá-los. Comece com `credentialless` e depois audite o painel de rede procurando requisições que perderam seus cookies.

## Provando qual build o navegador carregou

Não deduza isso com um cronômetro. O compilador define uma variável de ambiente que você pode ler:

```dart
// Flutter 3.44, Dart 3.10
const isRunningWithWasm = bool.fromEnvironment('dart.tool.dart2wasm');
```

Existe também uma sonda comportamental que funciona sem recompilar, baseada no fato de o Wasm usar a representação nativa de números:

```dart
final isRunningWithWasm = identical(double.nan, double.nan);
```

O painel de rede é a terceira checagem: uma requisição de `main.dart.wasm` significa a build Wasm, `main.dart.js` significa o fallback.

## Pegadinhas que vale conhecer antes de publicar

**Definir um renderer com `--wasm` é erro fatal.** O `build_web.dart` chama `throwToolExit('Do not attempt to set a web renderer when using "--wasm"')` quando o renderer resolvido não é `skwasm`. Então `--wasm` combinado com `--dart-define=FLUTTER_WEB_USE_SKIA=true` falha na CLI, por design.

**`config.renderer: 'canvaskit'` em uma build Wasm falha em runtime.** O `buildIsCompatible` rejeita qualquer build cujo `renderer` não seja igual ao valor configurado, e uma build `--wasm` não contém entrada `dart2wasm` + `canvaskit`. Todos os candidatos são filtrados e o loader lança `FlutterLoader could not find a build compatible with configuration and environment.` Isso é rastreado como flutter/flutter#183265. Remova a chave `renderer`, ou defina como `skwasm`.

**Engines que não são Chromium carregam uma carga de renderer mais pesada.** O `loadSkwasm` escolhe `skwasm_heavy` em vez de `skwasm` quando falta ao navegador o `ImageDecoder` ou os break iterators do Chromium, então se você forçar a abertura da lista de permissões, também paga um download maior.

**Extensões do Chrome são forçadas a uma única thread.** O loader detecta `chrome.runtime.id` e desativa as threads, porque a CSP das extensões bloqueia o carregamento dinâmico de scripts de que os workers precisam.

**Nomes de símbolos são removidos por padrão.** O `--strip-wasm` vem como `true`. Passe `--no-strip-wasm` quando precisar de stack traces legíveis de uma build de perfilamento, e `--source-maps` para emitir `main.dart.wasm.map`.

**Wasm não resolve SEO.** As duas builds pintam em um canvas, então os crawlers continuam vendo quase nenhum HTML semântico. Wasm deixa um app web Flutter mais rápido; não o transforma em um documento.

**A ferramenta ainda chama isso de novo.** O `flutter build web --wasm` imprime um box dizendo `WebAssembly compilation is new. Understand the details before deploying to production.` Trate isso como algo preciso, não como texto de praxe: fixe sua versão do Flutter e mantenha o caminho de fallback em JavaScript na sua matriz de testes, porque com a lista de permissões de hoje esse é o caminho em que a maioria dos seus usuários está.

## Relacionados

- [Como perfilar jank em um app Flutter com DevTools](/pt-br/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/)
- [Como adicionar código específico de plataforma no Flutter sem plugins](/pt-br/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/)
- [Como mirar várias versões do Flutter a partir de um único pipeline de CI](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)
- [Fix: Version solving failed em pubspec.yaml](/pt-br/2026/05/fix-version-solving-failed-in-pubspec-yaml/)
- [Migre um app Flutter 2 para o Flutter 3.x: o checklist de null safety](/pt-br/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/)

## Fontes

- Documentação do Flutter, [Support for WebAssembly (Wasm)](https://docs.flutter.dev/platform-integration/web/wasm)
- Documentação do Flutter, [Flutter web app initialization](https://docs.flutter.dev/platform-integration/web/initialization)
- Documentação do Flutter, [Build and release a web app](https://docs.flutter.dev/deployment/web)
- Código do Flutter, [`packages/flutter_tools/lib/src/commands/build_web.dart`](https://github.com/flutter/flutter/blob/stable/packages/flutter_tools/lib/src/commands/build_web.dart)
- Código do Flutter, [`engine/src/flutter/lib/web_ui/flutter_js/src/loader.js`](https://github.com/flutter/flutter/blob/stable/engine/src/flutter/lib/web_ui/flutter_js/src/loader.js) e [`browser_environment.js`](https://github.com/flutter/flutter/blob/stable/engine/src/flutter/lib/web_ui/flutter_js/src/browser_environment.js)
- Issue do Flutter [#183265, FlutterLoader could not find a build compatible with configuration and environment](https://github.com/flutter/flutter/issues/183265)
- Documentação do Dart, [Migrate to package:web](https://dart.dev/interop/js-interop/package-web) e [WebAssembly (Wasm) compilation](https://dart.dev/web/wasm)
- web.dev, [WasmGC and Wasm tail call optimizations are now Baseline Newly available](https://web.dev/blog/wasmgc-wasm-tail-call-optimizations-baseline)
- Chrome for Developers, [COEP: credentialless](https://developer.chrome.com/blog/coep-credentialless-origin-trial)
