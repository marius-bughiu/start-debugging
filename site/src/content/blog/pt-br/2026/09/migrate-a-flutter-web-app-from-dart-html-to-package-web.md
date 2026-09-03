---
title: "Migre um app web Flutter de dart:html para package:web e dart:js_interop"
description: "Uma migração passo a passo dos obsoletos dart:html, dart:js_util e package:js para package:web 1.1.1 e dart:js_interop: como encontrar cada import problemático com o compilador dart2wasm, o que o dart fix renomeia e o que não renomeia, as armadilhas do JSImmutableListWrapper e do innerHTML, e como verificar com flutter build web --wasm."
pubDate: 2026-09-03
updatedDate: 2026-09-03
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "flutter-web"
  - "interop"
  - "webassembly"
lang: "pt-br"
translationOf: "2026/09/migrate-a-flutter-web-app-from-dart-html-to-package-web"
translatedBy: "claude"
translationDate: 2026-09-03
---

Um código web Flutter de um único app com algumas chamadas a `dart:html` é uma migração de meio dia. Um código onde `dart:html` vazou para pacotes compartilhados, para mocks ou para um plugin que você mantém leva uma semana, e o gargalo quase nunca é o seu próprio código: é a dependência transitiva que ainda importa a biblioteca legada. Nada disso é mais opcional. `dart:html`, `dart:js`, `dart:js_util` e `package:js` foram descontinuados no Dart 3.7 (fevereiro de 2025), nenhum deles compila sob `dart2wasm`, e o par substituto, [`package:web`](https://pub.dev/packages/web) 1.1.1 junto com `dart:js_interop`, está estável desde julho de 2024. Este guia tem como alvo o canal stable atual, Flutter 3.47.2 com Dart 3.13.2 (lançado em 2026-08-27), e `package:web` 1.1.1, que exige Dart `^3.4.0`. Toda saída de compilador abaixo foi capturada em uma execução real com o toolchain stable Flutter 3.44.8 / Dart 3.12.2 e o mesmo `package:web` 1.1.1.

## Por que você não pode mais adiar

- **WebAssembly depende disso.** O `dart2wasm` se recusa a compilar um programa que alcance `dart:html` de forma transitiva. Se você quer o ganho descrito em [compilar um app web Flutter com `flutter build web --wasm`](/pt-br/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/), esta migração é o preço da entrada, não uma otimização.
- **A descontinuação já pesa.** O `dart analyze` reporta `deprecated_member_use` na própria linha do import, então qualquer job de CI com `--fatal-infos` já está falhando ou está a uma mudança de configuração de falhar.
- **`package:web` é versionado separadamente do SDK.** Adições às APIs do navegador chegam como uma versão do pacote em vez de esperar por uma versão do SDK, e `package:web` é gerado diretamente a partir do Web IDL, então os nomes batem com o MDN em vez de com um guia de estilo do Dart de 2013.
- **Se você publica um pacote, seus usuários não conseguem compilar para Wasm até você migrar.** Um único import de `dart:html` em um pacote folha bloqueia todo o grafo de dependências abaixo dele.

## O que quebra

| Área | Mudança | Severidade |
| ---- | ------- | ---------- |
| Nomes de tipos | Nomes no estilo Dart voltam aos nomes do IDL: `HtmlElement` vira `HTMLElement`, `InputElement` vira `HTMLInputElement`, `AnchorElement` vira `HTMLAnchorElement` | alta, mas quase toda automatizável |
| Coleções | `querySelectorAll` e `children` retornam `NodeList` / `HTMLCollection`, que não implementam `List` | alta |
| Testes de tipo | `is` e `as` não funcionam mais em tipos do navegador, porque todo tipo do `package:web` é apagado para `JSObject` | alta |
| Mocking | Extension types não têm despacho virtual, então um mock que faz `implements` de uma classe do `dart:html` não consegue implementar um tipo do `package:web` | alta |
| Assinaturas de tipo | `innerHTML` é `JSAny`, listeners de eventos recebem `JSFunction`, então os pontos de chamada precisam de `.toJS` | média |
| Zonas | Callbacks não são mais vinculados automaticamente à zona atual | média |
| Imports condicionais | `dart.library.html` precisa virar `dart.library.js_interop` | média |
| Views de plataforma | Factories de view precisam retornar um elemento do `package:web` e registrar via `dart:ui_web` | média |
| `dart:js_util` | `getProperty` / `setProperty` / `callMethod` migram para `dart:js_interop_unsafe` com chaves `JSAny` | baixa, mecânica |

## Checklist de preparação

- Flutter 3.47.2 ou mais recente no canal stable. Qualquer versão a partir do Flutter 3.22 (Dart 3.4) funciona, mas as correções do analisador descritas abaixo são melhores em SDKs recentes.
- `flutter pub add web`, que resolve para `web: ^1.1.1`.
- Um job de CI que rode `flutter build web --wasm` mesmo que você ainda não publique a build Wasm. É o único detector confiável de imports legados escondidos em dependências.
- Uma branch, não uma série de commits pequenos na `main`. A passada de renomeação toca muitos arquivos de uma vez e é dolorosa de revisar em fatias.
- Um inventário dos pacotes de que você depende que foram publicados pela última vez antes de meados de 2024. Esses são os seus bloqueadores prováveis.

## Passos da migração

1. **Encontre cada import problemático com o compilador, não com grep.** `grep -r "dart:html" lib/` acha o seu código e perde a dependência três níveis abaixo que realmente bloqueia você. O `dart2wasm` imprime a cadeia completa de imports. Rode `flutter build web --wasm` e leia o primeiro erro:

   ```text
   Target dart2wasm failed: ProcessException: Process exited abnormally with exit code 254:
   lib/legacy_bit.dart:1:8: Error: Dart library 'dart:html' is not available on this platform.
   import 'dart:html' as html;
          ^
   Context: The unavailable library 'dart:html' is imported through these packages:

       main.dart => package:fweb => dart:html

   Detailed import paths for (some of) the these imports:

       main.dart => package:fweb/main.dart => package:fweb/legacy_bit.dart => dart:html
   ```

   O bloco "Detailed import paths" é a parte útil. Quando a cadeia termina em um pacote do pub em vez do seu próprio `lib/`, você encontrou uma dependência que precisa ser atualizada, forkada ou substituída antes que o seu app possa migrar.

   Verificação: todo caminho impresso pelo compilador está anotado e classificado como "meu código", "meu pacote" ou "de terceiros". Nada fica como "provavelmente está tudo bem".

2. **Troque o import e adicione a dependência.** Por arquivo, `import 'dart:html' as html;` vira `import 'package:web/web.dart' as web;`. Mantenha o prefixo. Um import de `package:web` sem prefixo joga várias centenas de nomes de nível superior no escopo e colide com `Element`, `Image` e `Text` do próprio Flutter.

   ```console
   flutter pub add web
   ```

   Verificação: `flutter pub deps | grep web` mostra `web 1.1.1`, e os erros do arquivo mudam de "deprecated" para uma lista de nomes indefinidos. Nomes indefinidos são progresso: são o trabalho de renomeação tornado visível.

3. **Rode o `dart fix` para as renomeações de tipos e termine o resto na mão.** O `package:web` traz um `lib/fix_data.yaml` com 141 transformações de renomeação, então o analisador consegue reescrever a maioria dos nomes de tipos legados assim que o novo import estiver no lugar:

   ```console
   dart fix --dry-run
   dart fix --apply
   ```

   Em um arquivo contendo `InputElement`, `HtmlElement` e `CheckboxInputElement`, o `dart fix --apply` reescreve os dois primeiros e deixa o terceiro intacto:

   ```dart
   // After dart fix --apply, package:web 1.1.1
   final HTMLInputElement input = HTMLInputElement();
   final HTMLElement box = document.querySelector('#box') as HTMLElement;
   final CheckboxInputElement cb = CheckboxInputElement(); // still undefined
   ```

   `CheckboxInputElement` não é uma renomeação: é um tipo de conveniência do `dart:html` sem contrapartida no IDL. A forma manual é `HTMLInputElement()..type = 'checkbox'`. Quando um nome não tem transformação, procure a anotação `@Native` na antiga classe do `dart:html`: o valor dela é o nome no `package:web`.

   Verificação: `dart analyze` reporta zero diagnósticos `undefined_class` e `undefined_function` nos arquivos migrados.

4. **Substitua `dart:js_util` e `package:js` por `dart:js_interop`.** Os acessadores dinâmicos antigos migram para `dart:js_interop_unsafe` e recebem chaves `JSAny` em vez de `String`. A interoperabilidade declarada sai de classes `@JS()` para extension types sobre `JSObject`. Antes:

   ```dart
   // dart:html + dart:js_util, Dart 3.12.2
   import 'dart:convert';
   import 'dart:html';
   import 'dart:js_util' as js_util;

   void downloadCsv(String csv) {
     final blob = Blob([csv], 'text/csv');
     final url = Url.createObjectUrlFromBlob(blob);
     AnchorElement(href: url)
       ..download = 'report.csv'
       ..click();
     Url.revokeObjectUrl(url);
   }

   Future<Map<String, dynamic>> loadJson(String path) async {
     final text = await HttpRequest.getString(path);
     return jsonDecode(text) as Map<String, dynamic>;
   }

   void unsafeAccess() {
     final maybe = js_util.getProperty(window, 'myLegacyGlobal');
     if (maybe != null) {
       js_util.callMethod(maybe, 'init', ['flutter']);
     }
   }
   ```

   Depois:

   ```dart
   // package:web 1.1.1 + dart:js_interop, Dart 3.12.2
   import 'dart:convert';
   import 'dart:js_interop';
   import 'dart:js_interop_unsafe';
   import 'package:web/web.dart';

   void downloadCsv(String csv) {
     final blob = Blob([csv.toJS].toJS, BlobPropertyBag(type: 'text/csv'));
     final url = URL.createObjectURL(blob);
     final anchor = document.createElement('a') as HTMLAnchorElement
       ..href = url
       ..download = 'report.csv';
     anchor.click();
     URL.revokeObjectURL(url);
   }

   Future<Map<String, dynamic>> loadJson(String path) async {
     final response = await window.fetch(path.toJS).toDart;
     final text = await response.text().toDart;
     return jsonDecode(text.toDart) as Map<String, dynamic>;
   }

   void unsafeAccess() {
     final maybe = globalContext.getProperty<JSObject?>('myLegacyGlobal'.toJS);
     if (maybe != null) {
       maybe.callMethod<JSAny?>('init'.toJS, 'flutter'.toJS);
     }
   }
   ```

   Três padrões para internalizar: `allowInterop(fn)` vira `fn.toJS`, `js_util.promiseToFuture(p)` vira `p.toDart`, e uma `JSPromise<T>` aguardada com `.toDart` devolve um `Future<T>`. `HttpRequest` não tem substituto direto que valha a pena usar; a resposta é `window.fetch` ou `package:http`.

   Verificação: `dart analyze` está limpo e nenhum arquivo do repositório ainda importa `dart:js`, `dart:js_util` ou `package:js`.

5. **Mova as factories de view de plataforma para `dart:ui_web`.** Qualquer código que registre uma view HTML agora precisa retornar um elemento do `package:web`. O registro vive em `dart:ui_web`, e `registerViewFactory` é declarado como `registerViewFactory(String viewType, Function viewFactory, {bool isVisible = true})`:

   ```dart
   // Flutter 3.44.8, package:web 1.1.1
   import 'dart:ui_web' as ui_web;

   import 'package:flutter/widgets.dart';
   import 'package:web/web.dart' as web;

   const _viewType = 'startdebugging-iframe';

   void registerIframeFactory() {
     ui_web.platformViewRegistry.registerViewFactory(_viewType, (int viewId) {
       final iframe = web.document.createElement('iframe') as web.HTMLIFrameElement
         ..src = 'https://startdebugging.net/'
         ..style.border = 'none'
         ..style.width = '100%'
         ..style.height = '100%';
       return iframe;
     });
   }

   class EmbeddedSite extends StatelessWidget {
     const EmbeddedSite({super.key});

     @override
     Widget build(BuildContext context) =>
         const HtmlElementView(viewType: _viewType);
   }
   ```

   Verificação: a view renderiza no `flutter run -d chrome`, e o `flutter build web --wasm` compila o arquivo sem reclamar.

6. **Reescreva os imports condicionais para depender de `dart.library.js_interop`.** A grafia antiga seleciona silenciosamente a implementação stub sob `dart2wasm`, porque ali `dart.library.html` é falso, o que produz um `UnsupportedError` em tempo de execução em vez de um erro de compilação. Esse é o pior modo de falha de toda esta migração:

   ```dart
   // lib/platform_open.dart, Dart 3.12.2
   export 'src/open_stub.dart'
       if (dart.library.io) 'src/open_io.dart'
       if (dart.library.js_interop) 'src/open_web.dart';
   ```

   ```dart
   // lib/src/open_web.dart
   import 'package:web/web.dart' as web;

   void openUrl(String url) => web.window.open(url, '_blank');
   ```

   Verificação: faça grep de `dart.library.html` no repositório e confirme zero resultados, depois rode o app em um target nativo e na web para provar que cada branch ainda resolve. A mesma técnica vale para o problema mais amplo de [código específico de plataforma sem um plugin](/pt-br/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/).

7. **Conserte os testes por último, porque os mocks quebram de outro jeito.** Tipos do `package:web` são extension types sobre `JSObject`, então um fake que faz `implements HTMLElement` não compila. Substitua fakes baseados em classe por nós DOM reais criados no teste, ou por um objeto JS que você constrói e entrega ao código sob teste. Tudo que recorria a `dynamic` para chamar um membro do DOM também para de funcionar, porque membros de extension type resolvem apenas estaticamente.

   Verificação: `flutter test` passa e não sobra nenhuma cláusula `implements` apontando para um tipo do `package:web` na suíte.

## Verificação

Rode os quatro, nesta ordem:

```console
dart analyze --fatal-infos
flutter test
flutter build web
flutter build web --wasm
```

O último comando é o portão de verdade. Em um app migrado ele termina com `Built build/web` e deixa `main.dart.wasm`, `main.dart.mjs` e o fallback do `dart2js` `main.dart.js` em `build/web`. Se ainda falhar, o erro nomeia a cadeia exata de imports que sobrou. Depois disso, carregue o app e percorra tudo que toca o DOM: downloads de arquivos, área de transferência, iframes, `localStorage` e qualquer SDK JS com o qual você fale por interoperabilidade.

## Plano de rollback

O rollback por arquivo é fácil e o rollback do repositório inteiro não vale o planejamento. `package:web` e `dart:html` podem coexistir no mesmo programa, então você pode migrar um arquivo, publicá-lo e reverter só aquele arquivo se algo quebrar. O que você não pode fazer é reverter depois de ter apagado os caminhos de código com `dart:html` e publicado uma build Wasm, porque a build Wasm nunca os suportou. Mantenha a build `dart2js` como alvo de produção até terminar a passagem manual descrita acima; o `flutter build web --wasm` emite as duas, e o carregador faz o fallback sozinho.

## Armadilhas que vale conhecer antes de começar

**O exemplo oficial do `JSImmutableListWrapper` não compila.** `JSImmutableListWrapper<T, U>` não consegue inferir `U` a partir do argumento do construtor, então cai para o limite do parâmetro, `JSObject`:

```dart
for (final a in JSImmutableListWrapper(document.querySelectorAll('a'))) {
  a.classList.add('link'); // error: The getter 'classList' isn't defined for the type 'JSObject'
}
```

Passe os dois argumentos de tipo explicitamente:

```dart
// package:web 1.1.1
for (final a in JSImmutableListWrapper<NodeList, Element>(
  document.querySelectorAll('a'),
)) {
  a.classList.add('link');
}
```

**`innerHTML` é `JSAny`, nas duas direções.** Escrever exige `.toJS`, e ler exige um cast: `final String s = el.innerHTML;` falha com "A value of type 'JSAny' can't be assigned to a variable of type 'String'". Leia como `(el.innerHTML as JSString).toDart`. O mesmo vale para `outerHTML` e para `insertAdjacentHTML`, cujo segundo parâmetro é `JSAny`.

**`element.text` é um setter sem getter.** O `package:web` mantém um setter `text` descontinuado por conveniência na migração, mas a leitura exige `textContent`, que é `String?` em vez de `String`. Código que fazia `if (el.text.isEmpty)` agora precisa de uma checagem de null.

**Callbacks perdem a zona.** O `dart:html` vinculava callbacks de eventos à zona atual automaticamente; o `package:web` não faz isso. Se você depende de valores locais da zona ou de um manipulador de erros baseado em zona capturando o que acontece dentro de um listener, vincule manualmente antes de converter:

```dart
element.addEventListener(
  'click',
  Zone.current.bindUnaryCallback((Event event) {
    // zone-local values are preserved here
  }).toJS,
);
```

**Testes de tipo mudam de significado em silêncio.** `obj is Window` compilava bem sob `dart:html`; sob `package:web` todo tipo é apagado para `JSObject`, então a checagem não significa nada. Use `element.isA<HTMLInputElement>()` (Dart 3.4 em diante) ou `obj.instanceOfString('Window')`.

**Alguns hábitos do `dart:html` sobrevivem como shims descontinuados.** `window.localStorage['k'] = 'v'` ainda passa na análise, com "'[]=' is deprecated and shouldn't be used. Use Storage.setItem instead", e existe um `querySelector` de nível superior com "Directly use document.querySelector instead". Eles compilam hoje, mas não são um destino. Converta-os na mesma passada ou você fará isso duas vezes.

**Streams de eventos continuam existindo, e são o caminho ergonômico.** O `package:web` traz helpers de stream, então `input.onClick.listen(...)` funciona sem mudanças e retorna `ElementStream<MouseEvent>`. Prefira-os ao `addEventListener` cru mais `.toJS` para tudo que você precise cancelar. Note que os streams helper entregam alguns eventos de forma assíncrona onde o `dart:html` era síncrono, então código sensível a tempo pede uma segunda olhada.

## Relacionado

- O ganho deste trabalho está descrito por completo em [compilar um app web Flutter com WebAssembly](/pt-br/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/), incluindo por que Firefox e Safari ainda recebem a build JavaScript.
- Estruturalmente esta é a mesma classe de passada ampla e mecânica que [migrar um app Flutter 2 para Flutter 3.x](/pt-br/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/): um plano de dois saltos e um compilador que avisa quando você terminou.
- O mecanismo de imports condicionais do passo 6 é o mesmo por trás de [código específico de plataforma sem um plugin](/pt-br/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/).
- Se você está atualizando o Flutter ao mesmo tempo, leia [o que o Flutter 3.47 mudou na renderização em desktop](/pt-br/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/) antes de culpar esta migração por uma regressão visual.
- A web também é onde os [isolates do Dart](/pt-br/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) se comportam de forma diferente de qualquer outra plataforma, o que vale saber antes de mover trabalho intensivo em CPU na mesma passada.

## Fontes

- [Migrate to package:web](https://dart.dev/interop/js-interop/package-web), dart.dev
- [Past JS interop](https://dart.dev/interop/js-interop/past-js-interop), dart.dev
- [JS types and conversions](https://dart.dev/interop/js-interop/js-types), dart.dev
- [Breaking changes and deprecations](https://dart.dev/resources/breaking-changes), dart.dev
- [package:web no pub.dev](https://pub.dev/packages/web), versão 1.1.1
- [Referência da API EventStreamProviders](https://pub.dev/documentation/web/latest/web/EventStreamProviders-class.html), package:web
- [dart:ui_web PlatformViewRegistry](https://api.flutter.dev/flutter/dart-ui_web/PlatformViewRegistry-class.html), documentação da API do Flutter
- [Announcing Dart 3.13](https://dart.dev/blog/announcing-dart-3-13), o blog do Dart
