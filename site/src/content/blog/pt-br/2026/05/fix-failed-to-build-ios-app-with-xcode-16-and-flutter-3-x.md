---
title: "Correção: Failed to build iOS app com Xcode 16 e Flutter 3.x"
description: "A correção em 60 segundos: atualize o Flutter para 3.24.4 ou posterior, suba a plataforma do Podfile para iOS 13, apague Pods e DerivedData, depois pod install. O erro raramente está no seu código Dart."
pubDate: 2026-05-17
tags:
  - "errors"
  - "flutter"
  - "ios"
  - "xcode"
  - "cocoapods"
lang: "pt-br"
translationOf: "2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x"
translatedBy: "claude"
translationDate: 2026-05-17
---

A correção em uma frase: `Failed to build iOS app` depois de atualizar para o Xcode 16 quase nunca é o seu código Dart. É uma de quatro causas, nesta ordem de frequência: um SDK do Flutter anterior ao 3.24.4 que não conhece o novo verificador de módulos do Xcode 16, um `Podfile` que ainda fixa `platform :ios, '11.0'` (o Xcode 16 removeu o suporte ao simulador do iOS 11), um cache obsoleto de `ios/Pods` e `~/Library/Developer/Xcode/DerivedData/ModuleCache.noindex` do Xcode anterior, ou um plugin que ainda não publicou uma release compatível com Swift 6 / Xcode 16. Atualize o Flutter, suba o Podfile para iOS 13, limpe os dois caches, rode `pod install`, recompile. Pare de recorrer ao `flutter clean` como primeiro passo; ele não toca nos caches de iOS que estão realmente quebrados.

```text
Launching lib/main.dart on iPhone 16 Pro in debug mode...
Running Xcode build...
Xcode build done.                                           38.4s
Failed to build iOS app
Error (Xcode): Swift Compiler Error (Xcode): No such module 'Flutter'
/Users/me/MyApp/ios/Runner/AppDelegate.swift:2:8

Could not build the application for the simulator.
Error launching application on iPhone 16 Pro.
```

Este guia foi escrito contra o Flutter 3.41.5 (canal stable, maio de 2026), a linha Xcode 16.x (16.0 a 16.4 no momento desta redação), CocoaPods 1.16.2 e macOS Sequoia 15.3 em Apple Silicon. As mesmas correções se aplicam ao Flutter 3.24.4 e posteriores; se você está no Flutter 3.19 ou anterior, veja primeiro o passo de atualização porque nenhuma quantidade de mexidas nos pods vai te salvar nesse branch. As mudanças relevantes do Flutter que fizeram o Xcode 16 funcionar limpo chegaram em [flutter/flutter#155438](https://github.com/flutter/flutter/issues/155438) e as correções de modulemap posteriores em [flutter/flutter#157461](https://github.com/flutter/flutter/issues/157461).

## O que `Failed to build iOS app` realmente te diz

`Failed to build iOS app` é a mensagem guarda-chuva da ferramenta do Flutter. Ela só significa "xcodebuild retornou um código de saída diferente de zero". O diagnóstico real é a linha imediatamente acima ou abaixo, prefixada com `Error (Xcode):`. Existem aproximadamente seis erros subjacentes distintos que aparecem todos sob o mesmo guarda-chuva:

1. `No such module 'Flutter'` -- o compilador Swift não encontra o módulo do framework Flutter. Quase sempre um problema de Podfile ou de pod install depois da atualização para Xcode 16.
2. `no such file or directory: '.../ModuleCache.noindex/Session.modulevalidation'` -- o novo verificador de módulos do Xcode 16 não consegue ler um arquivo de cache escrito pelo Xcode 15. Veja a [issue #157461](https://github.com/flutter/flutter/issues/157461).
3. `Using bridging headers with module interfaces is unsupported` -- um padrão de `module.modulemap` mais bridging header de um plugin que funcionava no Xcode 15 agora é um erro duro.
4. `type 'UIApplication' does not conform to protocol 'Launcher'` -- um erro de conformidade estrita do Swift 6 em um plugin desatualizado (comumente `url_launcher_ios` antes de 6.3.0).
5. `Undefined symbol: _swift_FORCE_LOAD$_swiftCompatibility56` -- incompatibilidade de ABI do runtime do Swift, quase sempre um cache do CocoaPods de um SDK do Xcode anterior.
6. `The iOS deployment target 'IPHONEOS_DEPLOYMENT_TARGET' is set to 11.0, but the range of supported deployment target versions is 12.0 to 18.4` -- seu `Podfile` ainda fixa iOS 11, que o Xcode 16 removeu.

Cada um deles é um bug diferente com uma causa raiz diferente. A primeira tarefa é identificar qual deles a ferramenta realmente atingiu. Role para cima no terminal até encontrar a linha `error:` que tem um caminho de arquivo e um número de linha. Essa é a verdade; `Failed to build iOS app` é o sintoma.

## Lendo o erro real do `flutter build`

Rode com logging detalhado para que a saída subjacente do `xcodebuild` não seja resumida:

```bash
# Flutter 3.41.5
flutter build ios --verbose 2>&1 | tee build.log
```

Depois procure no log pelo primeiro `error:` (minúsculo, esse é o prefixo do Xcode), não `Error (Xcode)` (que é o reformat do Flutter):

```bash
grep -n "error:" build.log | head -20
```

A primeira ocorrência é a que precisa ser corrigida. Os erros seguintes geralmente são cascatas da primeira. Se você não tem a saída verbosa, está chutando.

## Uma reprodução mínima que demonstra uma das formas comuns

A forma mais comum em 2026 é a combinação do pin de plataforma do `Podfile` com um diretório `Pods` obsoleto. Crie um projeto Flutter novo e fixe o deployment target do iOS em 11.0:

```ruby
# ios/Podfile, Flutter 3.41.5, CocoaPods 1.16.2
platform :ios, '11.0'

# CocoaPods analytics sends network stats synchronously affecting flutter build latency.
ENV['COCOAPODS_DISABLE_STATS'] = 'true'

project 'Runner', {
  'Debug' => :debug,
  'Profile' => :release,
  'Release' => :release,
}

# ... rest of the default Podfile ...
```

Rode `flutter build ios --no-codesign` sob o Xcode 16 e a compilação falha com:

```text
[!] Automatically assigning platform `iOS` with version `11.0` on target `Runner`
    because no platform was specified. Please specify a platform for this target
    in your Podfile.
...
error: The iOS deployment target 'IPHONEOS_DEPLOYMENT_TARGET' is set to 11.0,
       but the range of supported deployment target versions is 12.0 to 18.4.
       (in target 'firebase_core' from project 'Pods')
Failed to build iOS app
```

O mesmo Podfile sob o Xcode 15.4 compila sem reclamar. O bug é o novo piso de deployment target no Xcode 16, não o seu código.

## Correção, em ordem de quão frequente é a resposta

Aplique estes passos em ordem. Cada passo assume que o anterior não funcionou.

### 1. Atualize o Flutter para 3.24.4 ou posterior

Flutter 3.24.4 (outubro de 2024) é a primeira release stable que traz as correções para Xcode 16 no `xcode_backend.sh` e no template do Generated.xcconfig. Qualquer release da linha 3.41.x em 2026 está atualizada. Verifique o que você tem e atualize:

```bash
flutter --version
flutter upgrade
```

Se `flutter upgrade` se recusar porque seu canal está em `master` ou você tem modificações locais no engine, volte para `stable`:

```bash
flutter channel stable
flutter upgrade
```

Esse único passo resolve a maioria dos relatos de `No such module 'Flutter'` abertos contra o Xcode 16 em 2024 e 2025. A equipe do Flutter fechou a [issue #155438](https://github.com/flutter/flutter/issues/155438) como corrigida no 3.24.4 exatamente por esse motivo.

### 2. Suba a plataforma do Podfile para iOS 13

O Xcode 16 ainda suporta iOS 12 como deployment target, mas a maioria dos plugins modernos (Firebase, Google Maps, qualquer coisa que toque em SwiftUI) agora requer iOS 13. Definir iOS 13 como piso é o padrão seguro em 2026:

```ruby
# ios/Podfile, Flutter 3.41.5
platform :ios, '13.0'
```

Você também precisa espelhar isso no projeto do runner. Abra `ios/Runner.xcworkspace`, selecione o target `Runner`, vá em `Build Settings` e defina `iOS Deployment Target` como `13.0` para debug e release. As build settings do workspace ganham do `Podfile` para o target Runner; a linha do `Podfile` só afeta os targets dos pods.

Se você tem um bloco `post_install` no Podfile, force cada pod a herdar o mesmo mínimo (este é o snippet do template moderno do Flutter):

```ruby
post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_ios_build_settings(target)
    target.build_configurations.each do |config|
      config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '13.0'
    end
  end
end
```

### 3. Apague Pods, o lockfile e o cache de módulos

Este é o passo que corrige o erro do `ModuleCache.noindex` e a maioria dos relatos de `Undefined symbol: _swift_FORCE_LOAD$_swiftCompatibility56`. O cache de ABI do Swift do seu Xcode anterior é incompatível com o `swiftc` do Xcode 16, e `flutter clean` não toca nele. A partir da raiz do projeto:

```bash
# Flutter 3.41.5, CocoaPods 1.16.2
flutter clean
cd ios
rm -rf Pods Podfile.lock .symlinks
rm -rf ~/Library/Developer/Xcode/DerivedData
pod cache clean --all
pod install --repo-update
cd ..
flutter pub get
```

`pod install --repo-update` (atenção: não `pod install` sozinho) atualiza o repositório de specs do CocoaPods para que você pegue qualquer podspec de plugin publicado desde a sua última compilação. Pule isso e você vai instalar o `firebase_core.podspec` de ontem que ainda fixa iOS 11.

### 4. Atualize plugins, especialmente os que aparecem no erro

Se o erro for `type 'UIApplication' does not conform to protocol 'Launcher'`, o plugin está desatualizado. Os dois infratores mais comuns são `url_launcher_ios` e `webview_flutter_wkwebview`. Suba para a última minor:

```bash
flutter pub upgrade --major-versions
```

Se você não pode fazer uma atualização geral porque alguma dependência prende, atualize só o plugin nomeado no erro:

```bash
flutter pub upgrade --major-versions url_launcher_ios
```

Depois refaça o passo 3 (os pods são cacheados por versão; uma mudança no `pubspec.yaml` não roda `pod install` automaticamente de novo). Para um guia mais profundo sobre como ler as reclamações do resolvedor do `pubspec` se `pub upgrade` em si falhar, veja [por que "Version solving failed" é uma prova e não um bug](/pt-br/2026/05/fix-version-solving-failed-in-pubspec-yaml/).

### 5. Force uma única versão do Swift em todos os pods

Um subconjunto de falhas de compilação vem de pods que não declararam um `SWIFT_VERSION`, o que sob o Xcode 16 cai no modo estrito do Swift 6 por padrão e então explode em código Swift 5 perfeitamente legal. A correção é prender cada pod ao Swift 5 no mesmo bloco `post_install`:

```ruby
post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_ios_build_settings(target)
    target.build_configurations.each do |config|
      config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '13.0'
      config.build_settings['SWIFT_VERSION'] = '5.0'
    end
  end
end
```

Isto é um workaround, não uma correção. A solução correta de longo prazo é abrir uma issue contra o plugin para que ele declare sua própria versão do Swift, mas a fixação vai te destravar hoje.

### 6. Apague e regenere as configurações do `ios/Runner.xcodeproj` só como último recurso

Se você editou à mão o `project.pbxproj` (adicionou targets nativos, fases de compilação customizadas, extensões App Clip) e nada acima funcionou, o target Runner pode ter build settings obsoletas anteriores ao Xcode 16. Faça backup do `ios/Runner.xcodeproj`, depois compare com um recém-gerado:

```bash
# Flutter 3.41.5
flutter create --platforms=ios --project-name=runner /tmp/scratch
diff -r ios/Runner.xcodeproj /tmp/scratch/ios/Runner.xcodeproj
```

Migre as build settings relevantes (`IPHONEOS_DEPLOYMENT_TARGET`, `SWIFT_VERSION`, `ENABLE_USER_SCRIPT_SANDBOXING`, `STRING_CATALOG_GENERATE_SYMBOLS`) do projeto scratch para o seu, uma por vez, recompilando entre cada uma. É tedioso, mas também é a única forma confiável de recuperar um projeto que acumulou cinco anos de detritos de atualizações do Xcode.

## Pegadinhas e casos parecidos

Alguns casos que se parecem com este erro mas não são:

- **`Sandbox: rsync deny file-write-create`**: o Xcode 16 ativou `ENABLE_USER_SCRIPT_SANDBOXING=YES` por padrão para projetos novos. O `xcode_backend.sh` do Flutter escreve fora do sandbox. Defina `ENABLE_USER_SCRIPT_SANDBOXING=NO` nas Build Settings do target Runner. O template do instalador do Flutter desde 3.24.4 já define isso, mas projetos criados antes não.
- **`Provisioning profile doesn't include the currently selected device`**: não é uma falha de compilação do Flutter de jeito nenhum. O binário nativo compilou bem; o passo de instalação falhou. Veja [Provisioning profile doesn't include the currently selected device](/pt-br/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/) -- o artigo de MAUI cobre a mesma causa raiz do lado da Apple.
- **`Unable to find a valid iOS Simulator runtime`**: o Xcode 15 parou de empacotar os runtimes do Simulator; o Xcode 16 continua sem empacotar. Rode `xcodebuild -downloadPlatform iOS`. O artigo detalhado está em [Unable to find a valid iOS Simulator runtime during MAUI build](/pt-br/2026/05/fix-unable-to-find-a-valid-ios-simulator-runtime-during-maui-build/) e se aplica identicamente ao Flutter.
- **`Xcode 26 update -- Clang dependency scanning failure: module 'Flutter' not found`**: esta é a variante do Xcode 26 (preview para desenvolvedores) rastreada em [flutter/flutter#185210](https://github.com/flutter/flutter/issues/185210). Não envie builds de release contra o Xcode 26 ainda; fique na linha 16.x até o Flutter publicar uma nota de compatibilidade.
- **CI falha mas builds locais passam**: seu CI está em uma imagem antiga do Xcode. A imagem `macos-14` do GitHub Actions traz Xcode 15.4; você precisa de `macos-15` (ou explicitamente `macos-15-large`) para Xcode 16. Fixe a imagem do runner e selecione a versão do Xcode com `sudo xcode-select -s /Applications/Xcode_16.app`. Se você também está malabarismando várias versões do Flutter no CI, o [padrão de matriz para Flutter no subosito/flutter-action](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) mostra como manter o build verde em várias versões.
- **`No such module 'Flutter'` só em um target watchOS ou App Clip**: o framework Flutter não é embarcado em targets companheiros por padrão. Você tem que adicionar uma fase Run Script que copie `Flutter.framework` para os binários embarcados, ou usar a configuração de projeto [add-to-app](https://docs.flutter.dev/add-to-app/ios/project-setup). Isto está documentado em [flutter/flutter#164597](https://github.com/flutter/flutter/issues/164597) para o caso do Apple Watch.
- **`flutter clean` apagou o `ios/Flutter/Generated.xcconfig` e agora nada compila**: é esperado. Rode `flutter pub get` para regenerá-lo. Se `flutter pub get` tiver sucesso mas o arquivo não for regenerado, seu `pubspec.yaml` não declara iOS como plataforma; adicione `flutter:` `plugin:` `platforms:` `ios:` ou rode `flutter create --platforms=ios .`.

Se você já iterou pelos passos 1 a 5 duas vezes e ainda vê o mesmo erro, o próximo movimento é bisseccionar plugins. Comente cada dependência direta no `pubspec.yaml` exceto `flutter` e `cupertino_icons`, rode o ciclo de limpar e compilar, e confirme que o projeto vazio compila. Depois descomente dependências em grupos de três. O primeiro grupo que reintroduzir a falha contém o plugin culpado. É lento, mas é determinístico e te dá um bug report pronto para registrar.

## Relacionados

- [Correção: Version solving failed em pubspec.yaml](/pt-br/2026/05/fix-version-solving-failed-in-pubspec-yaml/)
- [Correção: Provisioning profile doesn't include the currently selected device (MAUI iOS)](/pt-br/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/)
- [Correção: Unable to find a valid iOS Simulator runtime during MAUI build](/pt-br/2026/05/fix-unable-to-find-a-valid-ios-simulator-runtime-during-maui-build/)
- [Como mirar em várias versões do Flutter a partir de um único pipeline de CI](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)
- [Depurando Flutter iOS a partir do Windows: um fluxo de trabalho com dispositivo real](/pt-br/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/)

## Fontes

- [flutter/flutter#155438: After updating to xCode 16, Failed to build iOS app in Flutter 3.19.5](https://github.com/flutter/flutter/issues/155438)
- [flutter/flutter#157461: Xcode 16 and iOS 18 project not compiling: ModuleCache.noindex error](https://github.com/flutter/flutter/issues/157461)
- [flutter/flutter#155873: No such module 'Flutter' after updating to Xcode 16](https://github.com/flutter/flutter/issues/155873)
- [flutter/flutter#164597: Flutter 3.29.0 + Xcode 16 build failure with Apple Watch target](https://github.com/flutter/flutter/issues/164597)
- [flutter/flutter#185210: Xcode 26 update -- Clang dependency scanning failure](https://github.com/flutter/flutter/issues/185210)
- [Flutter add-to-app iOS project setup](https://docs.flutter.dev/add-to-app/ios/project-setup) (docs.flutter.dev)
- [CocoaPods 1.16.x changelog](https://github.com/CocoaPods/CocoaPods/releases) (CocoaPods/CocoaPods)
