---
title: "Correção: Flutter web serve um build antigo do cache depois de recarregar a aba do navegador"
description: "Um reload só revalida o index.html, então um main.dart.js sem hash continua vindo do cache do navegador. Envie Cache-Control: no-cache para a saída do build do Flutter, carimbe um build id onde você não consegue definir headers e deixe o service worker de autolimpeza aposentar os caches anteriores ao 3.41."
pubDate: 2026-09-11
template: how-to
tags:
  - "flutter"
  - "flutter-web"
  - "deployment"
  - "caching"
  - "how-to"
lang: "pt-br"
translationOf: "2026/09/fix-flutter-web-serves-a-stale-cached-build-after-reload"
translatedBy: "claude"
translationDate: 2026-09-11
---

**Resposta curta:** o Flutter web gera pontos de entrada com nomes de arquivo fixos (`flutter_bootstrap.js`, `main.dart.js`, `main.dart.wasm`, `canvaskit/...`), e um reload normal do navegador só revalida o documento HTML. Se o seu host envia qualquer tempo de validade para esses arquivos (o Firebase Hosting envia `max-age=3600`, o GitHub Pages envia `max-age=600`), a página recarregada recebe um `index.html` novo e um `main.dart.js` antigo, vindo do cache. Corrija servindo a pasta `build/web` inteira com `Cache-Control: no-cache` ou, em hosts onde você não consegue definir headers, carimbando um build id em `flutter_bootstrap.js` e `main.dart.js` depois do `flutter build web`. Se os usuários ainda têm o service worker offline-first do Flutter 3.38 ou anterior, continue implantando o `flutter_service_worker.js` padrão: desde o Flutter 3.41 ele é um worker de autolimpeza que cancela o registro do antigo e recarrega a aba.

Tudo o que segue foi reproduzido com Flutter 3.44.8 (Dart 3.12.2) e conferido com o código-fonte do tool e da engine da versão 3.47.3, que se comportam da mesma forma para este problema. Os testes de navegador rodaram em um navegador baseado em Chromium contra um pequeno servidor Node capaz de alternar sua política de `Cache-Control`.

## Dois caches diferentes, dependendo de quando você publicou pela primeira vez

Os resultados de busca para este problema misturam duas épocas, e a correção é diferente:

- **Flutter 3.38.x e anteriores** geravam um service worker offline-first. Ele servia cada arquivo listado no seu mapa `RESOURCES` direto do Cache Storage, buscava apenas o `index.html` com prioridade para a rede e precisava de um segundo carregamento para que uma nova implantação assumisse. É daí que vem o conselho clássico "tenho que recarregar duas vezes".
- **Flutter 3.41.0 e posteriores** não instalam mais um service worker de cache para novos visitantes. O [PR #176834](https://github.com/flutter/flutter/pull/176834) (mesclado em outubro de 2025, primeira versão estável na 3.41.0) substituiu o worker de 6 KB por um worker de limpeza de 784 bytes, e o loader em `flutter.js` só o registra quando a origem já tem um registro. Em um app novo na 3.41+, o único cache que continua em jogo é o cache HTTP comum, e é principalmente dele que este post trata.

Você pode confirmar em qual mundo está abrindo DevTools, Application, Service workers. Nenhum registro significa que o culpado é o cache HTTP.

## Por que um reload não busca o novo main.dart.js

Veja o que o `flutter build web` coloca em `build/web` na 3.44.8:

```text
# flutter build web, Flutter 3.44.8
index.html
flutter_bootstrap.js
flutter.js
flutter_service_worker.js
main.dart.js
version.json
manifest.json
assets/AssetManifest.bin
assets/FontManifest.json
assets/fonts/MaterialIcons-Regular.otf
canvaskit/canvaskit.js
canvaskit/canvaskit.wasm
```

Nenhum desses nomes contém um hash de conteúdo. O `index.html` carrega o `flutter_bootstrap.js`, que carrega um `_flutter.buildConfig` cujo `mainJsPath` é a string literal `"main.dart.js"`. Toda implantação reutiliza as mesmas URLs, então o navegador não consegue distinguir um build novo de um antigo apenas pela URL.

Agora combine isso com o funcionamento do reload. O reload do Chrome revalida o recurso principal e depois faz um carregamento de página normal. O texto de 2017 da equipe do Chromium diz que o navegador optou por "only validate the main resource and continue with a regular page load" ([blog do Chromium](https://blog.chromium.org/2017/01/reload-reloaded-faster-and-leaner-page_26.html)). Sub-recursos que ainda estão válidos segundo o seu `Cache-Control` vêm direto do cache em disco, sem requisição. Em uma navegação simples (um favorito, uma URL digitada, um link), todo navegador reutiliza cópias válidas, incluindo o próprio `index.html`.

Então, se o reload mostra ou não o build novo depende inteiramente do que o seu host envia para esses arquivos:

| Host | `Cache-Control` padrão para arquivos estáticos | Janela de conteúdo antigo após uma implantação |
| --- | --- | --- |
| Firebase Hosting | `max-age=3600` (observado em `*.firebaseapp.com`) | até 1 hora |
| GitHub Pages | `max-age=600`, não configurável | até 10 minutos |
| Netlify, Vercel, Cloudflare Pages | `public, max-age=0, must-revalidate` | nenhuma |
| Nginx, Apache, `python -m http.server` sem configuração | nenhum header, mas `Last-Modified` é enviado | heurística, veja abaixo |

A última linha pega muita gente. A ausência do header `Cache-Control` não significa "não faça cache". Com um header `Last-Modified`, a [RFC 9111 seção 4.2.2](https://www.rfc-editor.org/rfc/rfc9111#section-4.2.2) permite que o navegador escolha um tempo de validade heurístico, normalmente 10% do tempo desde a última modificação do arquivo. Um `main.dart.js` implantado pela última vez há dez dias pode ser tratado como válido por um dia inteiro.

O Firebase de fato limpa sua CDN a cada implantação, então a borda serve os arquivos novos imediatamente. O cache do próprio navegador não é limpo, e é essa cópia que o reload usa.

## Reprodução mínima

Este servidor serve `build/web` com uma política alternável. `firebase` imita o padrão do Firebase Hosting, `fixed` é a correção:

```js
// server.mjs, Node 22. Usage: MODE=firebase node server.mjs build/web
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.wasm': 'application/wasm', '.json': 'application/json' };

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, p);
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  const stat = fs.statSync(file);
  const headers = {
    'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
    'ETag': `"${stat.size}-${stat.mtimeMs}"`,
    'Cache-Control': process.env.MODE === 'fixed' ? 'no-cache' : 'max-age=3600',
  };
  if (req.headers['if-none-match'] === headers.ETag) { res.writeHead(304, headers); return res.end(); }
  console.log(200, p);
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}).listen(8765);
```

E um app cuja única função é mostrar qual build está rodando:

```dart
// lib/main.dart, Flutter 3.44.8, Dart 3.12.2
import 'package:flutter/material.dart';

const build = 'A';

void main() => runApp(
  const MaterialApp(home: Scaffold(body: Center(child: Text('Build $build')))),
);
```

Passos: compile com `build = 'A'`, inicie o servidor com `MODE=firebase` e abra `http://localhost:8765/`. Mude a constante para `'B'`, rode `flutter build web` de novo e recarregue a aba. A página continua dizendo "Build A". O log do servidor para esse reload mostra uma única requisição:

```text
200 /index.html
```

`flutter_bootstrap.js`, `main.dart.js`, o CanvasKit e as fontes foram todos servidos do cache do navegador. Repita a sequência inteira com `MODE=fixed` em uma origem nova e o reload mostra "Build B". Um segundo reload sem nova implantação custa então uma requisição condicional por arquivo, cada uma respondida com um `304` e sem corpo.

## A correção, passo a passo

1. **Sirva a saída do build do Flutter com `Cache-Control: no-cache`.** `no-cache` não desativa o cache. Ele diz ao navegador para manter o arquivo, mas revalidá-lo com `If-None-Match` ou `If-Modified-Since` antes de cada uso. Arquivos inalterados custam uma ida e volta e um `304`. Arquivos alterados são baixados. Aplique a `index.html`, `flutter_bootstrap.js`, `flutter.js`, `flutter_service_worker.js`, `main.dart.js`, `main.dart.mjs`, `main.dart.wasm`, `version.json`, `manifest.json`, tudo em `assets/` e a pasta local `canvaskit/`. A regra correta mais simples é "tudo em `build/web`".
2. **Coloque a regra na configuração do seu host.** Seguem exemplos abaixo para Firebase Hosting, Nginx e o arquivo `_headers` usado pelo Netlify e pelo Cloudflare Pages.
3. **Espere passar um tempo de validade antigo.** Headers novos só se aplicam a respostas buscadas depois da mudança. Navegadores que colocaram `main.dart.js` em cache sob `max-age=3600` continuam usando essa cópia até a hora acabar. Publique a mudança de header uma implantação antes de precisar dela, ou combine-a com um build id (passo 4) no primeiro rollout.
4. **Onde você não consegue definir headers, carimbe um build id.** O GitHub Pages é o caso comum. Reescreva as URLs dos pontos de entrada após cada build para que cada implantação tenha URLs novas.
5. **Avise as abas que já estão abertas.** Headers só ajudam no próximo carregamento. Uma aba aberta há muito tempo continua rodando o build antigo até o usuário recarregar, então consulte periodicamente um pequeno arquivo com o build id e ofereça um reload.

### Firebase Hosting

O [FAQ do Flutter web](https://docs.flutter.dev/platform-integration/web/faq) sugere `max-age=0,s-maxage=604800` para `js`, `mjs`, `wasm` e `json`, o que mantém a CDN aquecida enquanto força o navegador a revalidar. Esse padrão deixa de fora o HTML e o `.bin`, e dá a imagens e fontes `max-age=3600`, então `index.html`, `assets/AssetManifest.bin` e qualquer imagem que você substituiu com o mesmo nome ficam desatualizados por uma hora. Este `firebase.json` cobre o build inteiro:

```json
{
  "hosting": {
    "public": "build/web",
    "headers": [
      {
        "source": "**",
        "headers": [
          { "key": "Cache-Control", "value": "no-cache" }
        ]
      }
    ]
  }
}
```

Como o Firebase limpa sua CDN na implantação, você não precisa de `s-maxage` para manter a borda correta. Adicione-o de volta só se medir um problema de latência.

### Nginx

```nginx
# nginx 1.27, serving the output of flutter build web
server {
    listen 80;
    root /var/www/app/build/web;

    location / {
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-cache" always;
        etag on;
    }
}
```

Mantenha `etag on` (o padrão). Sem um validador, o navegador não tem com o que revalidar e baixa o arquivo completo toda vez.

### Netlify e Cloudflare Pages

Os dois já usam `max-age=0, must-revalidate` por padrão, o que se comporta corretamente. Se uma configuração anterior ou um preset de framework adicionou um tempo de validade maior, sobrescreva-o com um arquivo `_headers` em `web/`, para que o `flutter build web` o copie para `build/web`:

```text
# web/_headers, copied to build/web by flutter build web (Flutter 3.44)
/*
  Cache-Control: no-cache
```

### GitHub Pages e outros hosts sem headers

Rode um pequeno script pós-build. Ele acrescenta `?v=<id>` à tag de script do bootstrap e aos caminhos de build dentro de `_flutter.buildConfig`, e grava o id em `build_id.txt` para o passo 5:

```bash
#!/usr/bin/env bash
# bust.sh, run after `flutter build web` (Flutter 3.44 output layout)
set -euo pipefail
ID="${1:-$(git rev-parse --short HEAD 2>/dev/null || date +%s)}"
OUT=build/web
sed -i.bak "s|src=\"flutter_bootstrap.js\"|src=\"flutter_bootstrap.js?v=$ID\"|" "$OUT/index.html"
sed -i.bak -E "s#\"(main\.dart\.(js|wasm|mjs))\"#\"\1?v=$ID\"#g" "$OUT/flutter_bootstrap.js"
rm "$OUT"/*.bak
echo "$ID" > "$OUT/build_id.txt"
```

Sob uma política `max-age=600`, um reload após implantar um build carimbado requisitou exatamente três arquivos (`index.html`, `flutter_bootstrap.js?v=...`, `main.dart.js?v=...`) e mostrou o build novo, enquanto o CanvasKit e as fontes continuaram vindo do cache. Essa é a abordagem que o FAQ do Flutter descreve, observando que o Flutter não acrescenta build ids automaticamente. O próprio `index.html` continua sujeito ao tempo de validade de 10 minutos em uma navegação simples (um reload sempre o revalida), e assets que você substitui com o mesmo nome não são cobertos, então renomeie as imagens alteradas em vez de sobrescrevê-las.

### Ofereça um reload às abas abertas

Passe o mesmo id para o app em tempo de compilação e compare-o com o `build_id.txt` implantado. `cache: 'no-store'` mantém a própria verificação fora do cache HTTP:

```dart
// lib/update_check.dart, Flutter 3.44.8, Dart 3.12.2, package:web 1.1.1
import 'dart:async';
import 'dart:js_interop';

import 'package:flutter/material.dart';
import 'package:web/web.dart' as web;

/// flutter build web --dart-define=BUILD_ID=$(git rev-parse --short HEAD)
const buildId = String.fromEnvironment('BUILD_ID', defaultValue: 'dev');

Future<bool> newBuildAvailable() async {
  try {
    final response = await web.window
        .fetch('build_id.txt'.toJS, web.RequestInit(cache: 'no-store'))
        .toDart;
    if (!response.ok) return false;
    final deployed = (await response.text().toDart).toDart.trim();
    return deployed.isNotEmpty && deployed != buildId;
  } catch (_) {
    return false; // offline or blocked: keep running the current build
  }
}

void startUpdateCheck(GlobalKey<ScaffoldMessengerState> messenger) {
  if (buildId == 'dev') return;
  Timer.periodic(const Duration(minutes: 5), (timer) async {
    if (!await newBuildAvailable()) return;
    timer.cancel();
    messenger.currentState?.showSnackBar(
      SnackBar(
        duration: const Duration(days: 1),
        content: const Text('A new version is available.'),
        action: SnackBarAction(
          label: 'Reload',
          onPressed: () => web.window.location.reload(),
        ),
      ),
    );
  });
}
```

Dê ao `MaterialApp` uma `scaffoldMessengerKey` e chame `startUpdateCheck` com ela a partir do `main`. Compilando com `--dart-define=BUILD_ID=A` e implantando um `build_id.txt` contendo `B`, `newBuildAvailable()` retornou `true` na primeira verificação. Se você não usa o `bust.sh`, grave o `build_id.txt` no CI com o mesmo id. Isso importa mais quando a API do seu backend muda junto com o frontend, porque uma aba antiga chamando uma API nova é um bug pior do que uma UI antiga.

## Se você publicou o service worker antes do Flutter 3.41

Usuários que abriram seu app pela primeira vez quando ele era compilado com 3.38.x ou anterior ainda têm o worker offline-first e seu `flutter-app-cache` no navegador. Veja o que acontece na primeira vez que eles carregam uma implantação compilada com 3.41 ou posterior, de acordo com o código-fonte da 3.44.8 e da 3.47.3:

1. O worker antigo ainda está no controle, então ele responde à navegação com prioridade para a rede (`index.html` novo), mas serve `flutter_bootstrap.js` e `main.dart.js` do Cache Storage. O usuário pode ver o build antigo por um instante.
2. A verificação de atualização de service worker do navegador busca `flutter_service_worker.js` na rede. O arquivo é diferente byte a byte (agora é o worker de limpeza de 784 bytes), então ele é instalado.
3. O worker de limpeza chama `skipWaiting()`, depois, em `activate`, chama `self.registration.unregister()` e navega cada janela que controla para a URL atual dela.
4. Essa navegação acontece sem service worker, então a página carrega o build atual pelo cache HTTP. Com os headers da seção anterior, esse é o build novo.

O worker de limpeza não apaga `flutter-app-cache`, `flutter-temp-cache` nem `flutter-app-manifest`. Sem um worker, nada os lê, mas eles continuam ocupando armazenamento. Se isso importa para você, apague-os uma vez na inicialização pela API Cache Storage (`caches.delete('flutter-app-cache')` e assim por diante, via `package:web`).

Dois erros de implantação bloqueiam essa passagem de controle:

- **Remover `flutter_service_worker.js` da implantação.** Se a verificação de atualização recebe um `404`, o navegador mantém o worker existente, e o worker antigo continua servindo o `main.dart.js` antigo do Cache Storage. Continue publicando o arquivo enquanto você puder ter visitantes legados.
- **Compilar com `--pwa-strategy=none` cedo demais.** O flag está oculto e obsoleto na 3.44 e imprime uma referência para [flutter/flutter#156910](https://github.com/flutter/flutter/issues/156910). Com `none`, o tool grava um `flutter_service_worker.js` vazio e remove `serviceWorkerSettings` do `flutter_bootstrap.js`, então nada cancela o registro do worker antigo. O navegador acaba instalando o script vazio, mas ele só assume depois que todas as abas do app são fechadas, e o registro nunca desaparece. O build padrão é o que inclui o caminho de limpeza.

Se você precisa de suporte offline de verdade, o [FAQ do Flutter](https://docs.flutter.dev/platform-integration/web/faq) agora diz para trazer seu próprio worker, por exemplo com Workbox. Dê a ele um nome de cache versionado e uma estratégia network-first para `index.html` e `flutter_bootstrap.js`, ou você vai recriar o problema antigo.

## Armadilhas e problemas parecidos

- **O hard reload esconde o bug.** Ctrl+Shift+R (Cmd+Shift+R no macOS) ignora o cache HTTP e o service worker naquele carregamento, então os desenvolvedores raramente veem o problema. Teste com um reload normal, ou com "Disable cache" desligado no DevTools.
- **O CanvasKit da CDN é seguro, o CanvasKit local não.** Por padrão, o loader busca o CanvasKit em `gstatic.com` por uma URL que contém a revisão da engine, então um upgrade do Flutter muda a URL. Com `--no-web-resources-cdn`, o CanvasKit é servido de `canvaskit/` com o mesmo nome em toda versão. Um tempo de validade agressivo ali pode combinar um `main.dart.js` novo com um CanvasKit antigo após um upgrade do Flutter.
- **Tempos de validade longos em assets "estáticos".** Alguns hosts e presets de CDN dão a arquivos `.js` valores de `max-age` de 30 dias, supondo nomes com hash. Essa suposição é falsa para a saída do Flutter. Confira os headers reais da resposta com `curl -I https://your.app/main.dart.js`.
- **Builds Wasm têm mais pontos de entrada.** Um build `--wasm` também carrega `main.dart.mjs` e `main.dart.wasm`, e o loader recorre ao `main.dart.js` para navegadores fora da sua lista de permitidos. Os três precisam do mesmo tratamento, e é por isso que o `bust.sh` reescreve todos eles.
- **Comportamento desatualizado que não é o cache.** Se o build novo carrega, mas as rotas dão 404 ao atualizar, falta uma regra de rewrite de SPA (`try_files ... /index.html` ou `"rewrites"` no `firebase.json`). Se os assets dão 404 só sob um subcaminho, verifique o `--base-href`.

## Relacionados

- [Como compilar um app Flutter web com WebAssembly](/pt-br/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/), que cobre os pontos de entrada extras do Wasm e os headers COOP/COEP que ficam ao lado do `Cache-Control` na mesma configuração do host.
- [Migrando um app Flutter web de `dart:html` para `package:web`](/pt-br/2026/09/migrate-a-flutter-web-app-from-dart-html-to-package-web/), para o estilo de interop usado na verificação de atualização.
- [Correção: Text do Flutter renderiza fora da tela em uma Android WebView](/pt-br/2026/09/fix-flutter-text-renders-off-screen-in-an-android-webview-with-font-scaling/), outro problema do Flutter web que só aparece depois da implantação.
- [Output caching vs response caching no ASP.NET Core 11](/pt-br/2026/07/output-caching-vs-response-caching-in-aspnetcore-11/), se o seu build Flutter web é servido por um backend ASP.NET Core e você define os headers `Cache-Control` lá.

## Fontes

- [FAQ do Flutter web](https://docs.flutter.dev/platform-integration/web/faq): remoção do service worker, orientações sobre `Cache-Control` e a técnica do build id.
- [Inicialização de app Flutter web](https://docs.flutter.dev/platform-integration/web/initialization): tokens de template do `flutter_bootstrap.js`.
- [flutter/flutter#156910](https://github.com/flutter/flutter/issues/156910): obsolescência e remoção do `flutter_service_worker.js`.
- [flutter/flutter PR #176834](https://github.com/flutter/flutter/pull/176834): o service worker de autolimpeza, publicado pela primeira vez na 3.41.0.
- [`service_worker_loader.js` na 3.47.3](https://github.com/flutter/flutter/blob/3.47.3/engine/src/flutter/lib/web_ui/flutter_js/src/service_worker_loader.js) e [`flutter_service_worker.js` na 3.38.10](https://github.com/flutter/flutter/blob/3.38.10/packages/flutter_tools/lib/src/web/file_generators/js/flutter_service_worker.js) para o comportamento do worker antigo e do novo.
- [Blog do Chromium: Reload, reloaded](https://blog.chromium.org/2017/01/reload-reloaded-faster-and-leaner-page_26.html): o reload só revalida o recurso principal.
- [RFC 9111, seção 4.2.2](https://www.rfc-editor.org/rfc/rfc9111#section-4.2.2): validade heurística quando nenhum tempo de validade explícito é enviado.
- [Comportamento de cache do Firebase Hosting](https://firebase.google.com/docs/hosting/manage-cache): limpeza da CDN ao reimplantar.
