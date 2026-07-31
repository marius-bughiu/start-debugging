---
title: "Correção: Unable to load asset no Flutter depois de adicionar uma imagem ao pubspec.yaml"
description: "A chave do asset está faltando no bundle compilado, não no seu disco. Corrija a indentação do pubspec, adicione a barra final, iguale a chave e reinicie por completo."
pubDate: 2026-07-31
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "pubspec"
  - "assets"
lang: "pt-br"
translationOf: "2026/07/fix-unable-to-load-asset-in-flutter-after-adding-an-image-to-pubspec-yaml"
translatedBy: "claude"
translationDate: 2026-07-31
---

O arquivo está no disco, o caminho parece certo e o Flutter continua dizendo que não consegue carregá-lo. Isso acontece porque a mensagem não fala do seu disco: a chave que você passou não está no bundle de assets compilado. Em ordem de frequência, o motivo é um bloco `assets:` que não está indentado sob `flutter:`, uma entrada de diretório sem a `/` final, um arquivo em um subdiretório que nunca foi declarado, uma chave que difere em maiúsculas e minúsculas do nome do arquivo, ou um hot reload quando era preciso um restart completo. Corrija o `pubspec.yaml`, pare o app e execute-o de novo.

```text
======== Exception caught by image resource service ================================================
The following assertion was thrown resolving an image codec:
Unable to load asset: "assets/images/logo.png".
The asset does not exist or has empty data.

When the exception was thrown, this was the stack:
#0      PlatformAssetBundle.load (package:flutter/src/services/asset_bundle.dart:271:7)
<asynchronous suspension>
#1      AssetBundleImageProvider._loadAsync (package:flutter/src/painting/image_provider.dart:951:14)
```

Este guia foi escrito contra o Flutter 3.44.7 e o Dart 3.12.2, o canal stable em 2026-07-20. O comportamento descrito aqui é estável desde que o Flutter 3.16 mudou o formato do manifesto de assets, e as regras do pubspec não mudam há anos.

## O que o erro realmente significa

`Image.asset('assets/images/logo.png')` não abre um arquivo. Ele entrega uma chave de texto ao framework, que pede ao engine os bytes registrados sob aquela chave no bundle de assets do app. `PlatformAssetBundle.load` lança a exceção no momento em que o engine devolve null ou um buffer de tamanho zero:

```dart
// flutter/lib/src/services/asset_bundle.dart, Flutter 3.44.7
throw FlutterError.fromParts(<DiagnosticsNode>[
  _errorSummaryWithKey(key),
  ErrorDescription('The asset does not exist or has empty data.'),
]);
```

Esse bundle é compilado uma única vez, pela ferramenta `flutter`, a partir da seção `flutter: assets:` do `pubspec.yaml`. Tudo o que estiver listado ali é copiado para `build/flutter_assets/` e indexado em um manifesto chamado `AssetManifest.bin`, que o engine carrega na inicialização. Nada mais no seu sistema de arquivos existe do ponto de vista do app em execução.

Então duas coisas independentes precisam bater, e o erro não consegue dizer qual das duas está errada:

1. A declaração no pubspec precisa colocar o arquivo dentro do bundle.
2. A chave no seu código Dart precisa bater byte a byte com a chave do bundle.

Cada causa abaixo é uma dessas duas falhando.

## A reprodução mínima

```
my_app/
  pubspec.yaml
  assets/
    images/
      logo.png
  lib/
    main.dart
```

```yaml
# pubspec.yaml, Flutter 3.44.7
name: my_app

flutter:
  uses-material-design: true
  assets:
    - assets/images/logo.png
```

```dart
// lib/main.dart, Flutter 3.44.7, Dart 3.12.2
import 'package:flutter/material.dart';

void main() => runApp(
      const MaterialApp(
        home: Scaffold(
          body: Center(child: Image.asset('assets/images/logo.png')),
        ),
      ),
    );
```

Isso funciona. Quebre qualquer linha desse exemplo das formas abaixo e você recebe o erro, sem nenhum outro diagnóstico.

## Causa 1: o bloco assets não está aninhado sob flutter

Essa é a falha mais comum e a mais frustrante, porque nada reclama. `flutter pub get` termina bem, o build termina bem e o app sobe com um bundle vazio.

```yaml
# Wrong. Valid YAML, silently ignored.
flutter:
  uses-material-design: true
assets:
  - assets/images/logo.png
```

`assets:` no nível superior é uma chave que a ferramenta do Flutter não lê. Não é um erro, é apenas configuração de outra pessoa no que diz respeito ao parser. A forma correta indenta `assets:` exatamente dois espaços sob `flutter:`, com os itens da lista dois espaços mais adentro:

```yaml
# Right.
flutter:
  uses-material-design: true
  assets:
    - assets/images/logo.png
```

Uma variante relacionada: uma segunda chave `flutter:` mais abaixo no arquivo. Mapeamentos YAML não podem ter chaves duplicadas e, dependendo do parser, uma delas vence silenciosamente. Se o seu pubspec cresceu de forma orgânica, procure nele cada ocorrência de `flutter:` na coluna zero antes de depurar qualquer outra coisa.

## Causa 2: uma entrada de diretório sem barra final, ou um subdiretório que nunca foi declarado

Entradas de diretório são opcionais uma a uma e não são recursivas. Da documentação do Flutter sobre como adicionar assets: "Only files located directly in the directory are included. Resolution-aware asset image variants are the only exception. To add files located in subdirectories, create an entry per directory."

Então isto não declara nada útil se as suas imagens ficam em `assets/images/icons/`:

```yaml
flutter:
  assets:
    - assets/images/
```

e isto é o que você precisa:

```yaml
flutter:
  assets:
    - assets/images/
    - assets/images/icons/
    - assets/images/illustrations/
```

A barra final é o que torna a entrada um diretório. `- assets/images` sem ela é lida como um único arquivo chamado `images` e, como esse arquivo não existe, o build falha no nível da ferramenta com uma mensagem que de fato ajuda:

```text
Error: unable to find directory entry in pubspec.yaml: /path/to/my_app/assets/images/
```

Vale conhecer isso ao contrário: se o seu build teve sucesso e você ainda recebe `Unable to load asset` em tempo de execução, a entrada casou com alguma coisa. O problema então é uma chave que não bate, não uma declaração faltando.

A única exceção à regra de não recursividade são as variantes por resolução. Se você declara `assets/images/logo.png`, então `assets/images/2.0x/logo.png` e `assets/images/3.0x/logo.png` entram no bundle automaticamente e o `AssetImage` escolhe a certa para o device pixel ratio. Você nunca declara os diretórios de variantes.

## Causa 3: a chave no código não bate com a chave no bundle

Chaves de bundle são strings exatas. Três formas de elas se desviarem do que você digitou:

**Maiúsculas e minúsculas.** Sua máquina de desenvolvimento quase certamente tem um sistema de arquivos que ignora maiúsculas (APFS no macOS por padrão, NTFS no Windows). `Image.asset('assets/images/Logo.png')` resolve um arquivo chamado `logo.png` localmente e falha em um dispositivo Android, no iOS, na web e em qualquer runner de CI com Linux. Se um build funciona no seu notebook e falha em todo o resto, verifique isso primeiro. Essa é a explicação mais provável para o caso de mesmo código com resultado diferente por máquina.

**Um `./` inicial ou um espaço perdido.** `'./assets/images/logo.png'` é uma string diferente de `'assets/images/logo.png'`, e o bundle contém apenas a segunda. Espaço em branco no fim de um valor YAML entre aspas tem o mesmo efeito.

**O prefixo `packages/`.** Um asset que vem dentro de um pacote do qual você depende tem a chave `packages/<package_name>/<path>`, com o diretório `lib/` do pacote implícito e nunca escrito. Para carregar `lib/assets/bg.png` de um pacote chamado `fancy_backgrounds`:

```dart
// Flutter 3.44.7. Either form works; they produce the same key.
Image.asset('packages/fancy_backgrounds/assets/bg.png');
Image.asset('assets/bg.png', package: 'fancy_backgrounds');
```

Se você escreveu o pacote, ele também precisa declarar esses arquivos no próprio `pubspec.yaml`. Assets de uma dependência não entram no bundle só porque o arquivo existe em `.pub-cache`.

## Causa 4: você fez hot reload quando precisava reiniciar

O hot reload troca código Dart dentro de um isolate em execução. O bundle de assets e o manifesto dele são produzidos pela ferramenta quando o app é lançado. Editar o `pubspec.yaml` para adicionar uma entrada nova muda o manifesto, e um app em execução mantém o manifesto com que subiu.

Pare a sessão e comece de novo. Nem `r`, nem `R`:

```bash
# Flutter 3.44.7
# Ctrl-C to end the current run, then:
flutter run
```

Mudar os *bytes* de um asset que já está declarado é re-empacotado no reload e não precisa disso. Mudar o *conjunto* de assets declarados precisa.

## Causa 5: saída obsoleta no disco

Raramente é a causa, é barato descartar e é a primeira coisa que toda resposta na internet manda fazer, motivo pelo qual leva a culpa por muito mais falhas do que produz. É uma causa real no iOS, onde um bundle `.app` atualizado pela metade pode sobreviver a um rebuild:

```bash
# Flutter 3.44.7
flutter clean
flutter pub get
flutter run
```

Se o que falha no caminho é o próprio `flutter pub get`, aí é um problema de resolução de dependências e não de assets, e a saída do solucionador de restrições é um exercício à parte: veja [como ler um erro de version solving failed no pubspec.yaml](/pt-br/2026/05/fix-version-solving-failed-in-pubspec-yaml/).

## Pare de adivinhar: imprima as chaves que realmente estão no bundle

Cada seção acima é uma hipótese. Você pode substituir todas elas por uma única medição. `AssetManifest` é a API suportada para ler o manifesto em tempo de execução, adicionada quando `AssetManifest.json` foi substituído por `AssetManifest.bin`:

```dart
// Flutter 3.44.7, Dart 3.12.2
import 'package:flutter/services.dart';

Future<void> dumpAssetKeys() async {
  final manifest = await AssetManifest.loadFromAssetBundle(rootBundle);
  for (final key in manifest.listAssets()..sort()) {
    debugPrint(key);
  }
}
```

Chame isso a partir do `main` atrás de uma checagem `kDebugMode` e leia o console. O que for impresso é o que o engine consegue servir. Se o seu caminho não estiver ali, o problema é a Causa 1 ou a 2. Se houver algo quase igual ao seu caminho, é a Causa 3, e a diferença entre as duas strings é a sua correção.

Não faça o parse do `AssetManifest.bin` por conta própria. O Flutter o documenta como um detalhe de implementação cujo formato pode mudar sem aviso, e o `AssetManifest.json` não é mais gerado, então código que ainda chama `rootBundle.loadString('AssetManifest.json')` lança exatamente este erro com `AssetManifest.json` como chave.

Você também pode inspecionar o bundle sem executar nada:

```bash
# Flutter 3.44.7. Writes the bundle the engine would load.
flutter build bundle
ls build/flutter_assets/assets/images/

# Or check what shipped inside a built APK:
unzip -l build/app/outputs/flutter-apk/app-debug.apk | grep flutter_assets
```

## Variantes que caem nesta página

- **`Unable to load asset: "fonts/Inter-Regular.ttf"`**. Fontes são declaradas sob `flutter: fonts:`, não sob `assets:`, e o nome da família no seu `TextStyle` precisa bater com o valor de `family:` e não com o nome do arquivo. O modo de falha e a lógica da correção são idênticos.
- **`Unable to load asset` vindo de `SvgPicture.asset`**. O `flutter_svg` carrega pelo mesmo `AssetBundle`, então o erro é do framework e não do pacote. Tudo acima se aplica sem mudanças.
- **O asset existe mas "has empty data"**. Leia essa frase literalmente. O culpado de sempre é o Git LFS: um repositório em que as imagens são rastreadas por LFS, com checkout em um runner de CI sem `lfs: true`, deixa um ponteiro de texto de 130 bytes onde deveria estar o PNG. O build tem sucesso, o bundle contém a chave e a decodificação falha. Verifique o tamanho do arquivo antes de qualquer outra coisa. Uma regra de `.gitignore` ou `.dockerignore` que exclui `assets/` produz o mesmo formato de "passa local, falha no CI", algo que vale descartar quando você está [rodando builds com várias versões do Flutter em um único pipeline](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).
- **Só quebra no Flutter web, só depois do deploy**. Se o app está hospedado sob um subcaminho, `build/web/index.html` precisa de `<base href="/my-app/">` e o build precisa de `flutter build web --base-href /my-app/`. Sem isso o engine pede `/assets/...` a partir da raiz do domínio e recebe um 404, que aparece como este erro. A mesma armadilha vale para um [build WebAssembly com `flutter build web --wasm`](/pt-br/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/).
- **Só quebra no `flutter test`**. Assets declarados no `pubspec.yaml` funcionam sim nos testes de widget: a ferramenta compila `build/unit_test_assets/`, exporta o caminho como `UNIT_TEST_ASSETS` e o `mockFlutterAssets()` serve as chaves a partir dali. Duas coisas continuam quebrando. Assets empacotados condicionalmente por flavor não estão nesse diretório, e um teste de golden que renderiza `Image.asset` precisa que o carregamento termine, então envolva o pump em `tester.runAsync` ou chame `precacheImage` antes de comparar.
- **Só quebra em release, não em debug**. Não é problema de assets. Verifique se o caminho de código que monta a chave está sendo alcançado, e se uma string `const` está sendo montada a partir de algo que difere entre os modos de build.
- **O build do Android nunca chegou longe o suficiente para empacotar nada**. Se a falha é em tempo de build e não de execução, você está olhando para [uma tarefa do Gradle que falhou com exit code 1](/pt-br/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/), e nenhuma quantidade de edições no pubspec vai ajudar.

A ideia central: este erro é uma busca que não encontrou nada em uma estrutura de dados que o seu build produziu. Trate-o assim. Imprima `listAssets()`, compare a string que você passou com as strings que existem, e a correção está sempre em um dos dois lados dessa comparação.

## Relacionados

- [Correção: Version solving failed no pubspec.yaml](/pt-br/2026/05/fix-version-solving-failed-in-pubspec-yaml/) -- quando o `flutter pub get` da sequência de rebuild limpo é justamente o que falha.
- [Correção: Gradle task assembleDebug failed with exit code 1 em um build Android do Flutter](/pt-br/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) -- a contraparte em tempo de build, em que o bundle nunca chega a ser produzido.
- [Como compilar um app web Flutter com WebAssembly](/pt-br/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/) -- cobre a configuração de base href e de caminho de hospedagem que quebra as URLs de assets na web.
- [Como mirar em várias versões do Flutter a partir de um único pipeline de CI](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) -- os detalhes de checkout e cache por trás da maioria dos relatos de assets que passam local e falham no CI.
- [Correção: Cannot provide both a color and a decoration em um Container do Flutter](/pt-br/2026/07/fix-cannot-provide-both-a-color-and-a-decoration-in-a-flutter-container/) -- o outro erro que aparece na primeira vez que você coloca uma imagem atrás de uma caixa estilizada.

## Fontes

- [Adding assets and images](https://docs.flutter.dev/ui/assets/assets-and-images), documentação do Flutter
- [Removal of AssetManifest.json](https://docs.flutter.dev/release/breaking-changes/asset-manifest-dot-json), documentação do Flutter
- [Classe `AssetManifest`](https://api.flutter.dev/flutter/services/AssetManifest-class.html), referência da API do Flutter
- [`asset_bundle.dart`](https://github.com/flutter/flutter/blob/stable/packages/flutter/lib/src/services/asset_bundle.dart), flutter/flutter
- [`_binding_io.dart` e `mockFlutterAssets`](https://github.com/flutter/flutter/blob/stable/packages/flutter_test/lib/src/_binding_io.dart), flutter/flutter
- [Conditionally bundling assets based on flavor makes tests fail](https://github.com/flutter/flutter/issues/150296), flutter/flutter
