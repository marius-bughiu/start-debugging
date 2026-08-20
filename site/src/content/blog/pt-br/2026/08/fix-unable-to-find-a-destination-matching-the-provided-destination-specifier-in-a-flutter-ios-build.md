---
title: "Correção: Unable to find a destination matching the provided destination specifier em um build iOS de Flutter"
description: "Os runtimes do simulador do iOS 26 são apenas arm64, então uma linha EXCLUDED_ARCHS arm64 esquecida gera um Runner só Intel que nenhum simulador consegue executar."
pubDate: 2026-08-20
template: error-page
tags:
  - "errors"
  - "flutter"
  - "ios"
  - "xcode"
  - "cocoapods"
lang: "pt-br"
translationOf: "2026/08/fix-unable-to-find-a-destination-matching-the-provided-destination-specifier-in-a-flutter-ios-build"
translatedBy: "claude"
translationDate: 2026-08-20
---

Apague a linha `EXCLUDED_ARCHS[sdk=iphonesimulator*] = arm64` do seu `ios/Podfile` e rode `flutter clean` seguido de um `pod install` limpo. Essa linha é resquício da era Apple Silicon de 2020 e, no Xcode 26, ela é fatal: os runtimes do simulador do iOS 26 vêm apenas com arm64, então excluir arm64 deixa o `Runner` sem nenhuma arquitetura que o simulador possa executar, e o `xcodebuild` relata isso como destino ausente em vez de incompatibilidade de arquitetura. Se a exclusão vem de um plugin que você não controla, instale o runtime universal com `xcodebuild -downloadPlatform iOS -architectureVariant universal`.

## O erro, completo

O Flutter mostra a falha crua do `xcodebuild`, que cita o UDID do seu simulador e depois lista destinos que parecem perfeitamente válidos:

```
Uncategorized (Xcode): Unable to find a destination matching the provided destination specifier:
                { id:6B4F9D28-C76C-4146-9527-E844395B4434 }

        Available destinations for the "Runner" scheme:
                { platform:macOS, arch:arm64, variant:Designed for [iPad,iPhone], id:00006020-000221002EE8C01E, name:My Mac }
                { platform:iOS, id:dvtdevice-DVTiPhonePlaceholder-iphoneos:placeholder, name:Any iOS Device }
                { platform:iOS Simulator, id:dvtdevice-DVTiOSDeviceSimulatorPlaceholder-iphonesimulator:placeholder, name:Any iOS Simulator Device }
```

Rodar o mesmo scheme pela interface do Xcode entrega o diagnóstico que a saída do Flutter enterra:

```
iPhone 17 cannot run Runner.
Domain: IDEFoundationErrorDomain
Code: 3
Recovery Suggestion: Runner's architectures (Intel 64-bit) include none that iPhone 17 can execute (arm64).
```

Essa segunda mensagem é o erro real. O simulador existe, está iniciado e o UDID está correto. O que falta é uma arquitetura em comum entre o produto que você acabou de compilar e o dispositivo em que pediu para executá-lo.

## Por que um simulador do iOS 26 não tem nenhum destino compatível

`xcodebuild -destination` não resolve para "um dispositivo com este UDID". Ele resolve para "um dispositivo com este UDID que consiga executar o produto deste scheme". A arquitetura faz parte da correspondência, então uma incompatibilidade de arquitetura aparece como destino ausente.

Antes do iOS 26 essa distinção raramente importava. Os runtimes do simulador vinham como binários universais contendo as fatias `x86_64` e `arm64`, então um build só Intel ainda encontrava uma fatia para rodar sob Rosetta no Apple Silicon. O Xcode 26 acabou com isso. Quando você instala um runtime, a Apple resolve a variante de arquitetura para `arm64` no Apple Silicon e baixa apenas essa fatia, imprimindo `Automatically resolved architecture variant for platform iOS as 'arm64'` no caminho.

Ou seja, um simulador do iOS 26 executa exatamente uma arquitetura, e qualquer configuração de build que remova `arm64` do build para simulador produz um produto sem nenhuma fatia utilizável.

Essa configuração quase sempre vem de um Podfile. Em 2020, todo guia de contorno para Apple Silicon mandava adicionar uma exclusão de arm64 para que pods só Intel conseguissem linkar, e esse conselho foi copiado para milhares de projetos. O próprio helper de CocoaPods do Flutter preserva a exclusão: `packages/flutter_tools/bin/podhelper.rb` escreve a exclusão do simulador com `$(inherited)` na frente, o que mantém o seu valor de projeto em vez de substituí-lo.

```ruby
# Flutter 3.44.2, packages/flutter_tools/bin/podhelper.rb
build_configuration.build_settings['VALID_ARCHS[sdk=iphonesimulator*]'] = '$(ARCHS_STANDARD)'
build_configuration.build_settings['EXCLUDED_ARCHS[sdk=iphonesimulator*]'] = '$(inherited) i386'
build_configuration.build_settings['EXCLUDED_ARCHS[sdk=iphoneos*]'] = '$(inherited) armv7'
```

A exclusão padrão é só `i386`, que é inofensiva. Quem mata o build é o `arm64` herdado.

Existe uma segunda origem. Se qualquer target de pod excluir `arm64`, o Flutter propaga a exclusão para o próprio app. `packages/flutter_tools/lib/src/ios/xcode_build_settings.dart` decide isso enquanto gera o `Generated.xcconfig`:

```dart
// Flutter 3.44.2, packages/flutter_tools/lib/src/ios/xcode_build_settings.dart
var excludedSimulatorArchs = 'i386';
if (!(await project.ios.pluginsSupportArmSimulator(printWarnings: printWarnings))) {
  excludedSimulatorArchs += ' arm64';
}
xcodeBuildSettings.add(
  'EXCLUDED_ARCHS[sdk=${XcodeSdk.IPhoneSimulator.platformName}*]=$excludedSimulatorArchs',
);
```

`pluginsSupportArmSimulator` roda `xcodebuild -showBuildSettings` em `Pods/Pods.xcodeproj` e devolve false se o `EXCLUDED_ARCHS` de algum target mencionar `arm64`. Basta uma dependência transitiva mal configurada para deixar o app inteiro só Intel.

## Reprodução mínima: a linha do Podfile que quebra o build para simulador

Adicione a solução clássica a um app Flutter padrão e rode em um simulador do iOS 26:

```ruby
# ios/Podfile, Flutter 3.44.2, CocoaPods 1.16.2, Xcode 26.0.1
post_install do |installer|
  installer.pods_project.build_configurations.each do |config|
    config.build_settings['EXCLUDED_ARCHS[sdk=iphonesimulator*]'] = 'arm64'
  end
end
```

```bash
# Flutter 3.44.2 (stable, 11 June 2026), Dart 3.12.2
flutter run -d 6B4F9D28-C76C-4146-9527-E844395B4434
```

O Flutter monta o argumento `-destination` a partir do dispositivo que você selecionou, em `packages/flutter_tools/lib/src/ios/mac.dart`:

```dart
// Flutter 3.44.2, packages/flutter_tools/lib/src/ios/mac.dart
buildCommands.add('-destination');
if (deviceID != null) {
  buildCommands.add('id=$deviceID');
} else if (environmentType == EnvironmentType.physical) {
  buildCommands.add(XcodeSdk.IPhoneOS.genericPlatform);
} else {
  buildCommands.add(XcodeSdk.IPhoneSimulator.genericPlatform);
}
```

`genericPlatform` expande para `generic/platform=iOS Simulator`. Qualquer uma das formas falha do mesmo jeito depois que o produto vira só Intel, e é por isso que `flutter build ios --simulator` reproduz o erro sem nenhum dispositivo selecionado.

## Como removo a exclusão de arm64?

Trabalhe de dentro para fora, do seu projeto até as dependências.

Primeiro, apague a exclusão do `ios/Podfile`. Remova a atribuição inteira de `EXCLUDED_ARCHS[sdk=iphonesimulator*]` em vez de deixá-la como string vazia, para que o padrão `i386` do próprio Flutter valha limpo.

Segundo, verifique o projeto do Xcode, já que a mesma linha costuma ser colada nas build settings em vez do Podfile:

```bash
# Xcode 26.0.1
cd ios
xcodebuild -showBuildSettings -project Runner.xcodeproj -scheme Runner \
  -sdk iphonesimulator | grep -i EXCLUDED_ARCHS
```

Qualquer coisa que mencione `arm64` no SDK do simulador precisa sair. Limpe no Xcode em Build Settings, Excluded Architectures, tanto para Debug quanto para Release.

Terceiro, reconstrua os pods do zero. `Pods` e `DerivedData` desatualizados mantêm as configurações antigas vivas e fazem parecer que a correção não surtiu efeito:

```bash
# Flutter 3.44.2, CocoaPods 1.16.2
flutter clean
rm -rf ios/Pods ios/Podfile.lock ~/Library/Developer/Xcode/DerivedData
flutter pub get
cd ios && pod install
```

Quarto, confirme que a exclusão sumiu do arquivo que o Flutter gera. O `ios/Flutter/Generated.xcconfig` deve mostrar `EXCLUDED_ARCHS[sdk=iphonesimulator*]=i386` sem `arm64`. Se `arm64` sobreviver a um `pod install` limpo, a origem é uma dependência, não você.

## E se um plugin ainda excluir arm64?

No Xcode 26 e posteriores, o Flutter 3.41.0 (11 de fevereiro de 2026) e versões mais novas citam os targets culpados durante o build, a partir de `packages/flutter_tools/lib/src/xcode_project.dart`:

```
The following target(s) do not support arm64 architecture, which is a requirement for Apple Silicon iOS 26+ simulators:
  - SomePlugin (Flutter plugin)
  - SomeVendorSDK (transitive dependency of Flutter plugin SomePlugin)

Please contact plugin maintainers to request arm64 support to continue to be able to use the plugin on a simulator.
```

Esse aviso chegou no [PR #177065](https://github.com/flutter/flutter/pull/177065), integrado em 5 de novembro de 2025. Comparar o commit de merge com as tags de release o coloca fora da 3.38.10 e dentro da 3.41.0, então quem continua na linha 3.38 recebe a falha sem nenhuma explicação junto.

Se o target for um framework binário de fornecedor sem fatia arm64 para simulador, você não consegue remover a exclusão. Instale um runtime universal no lugar, para que um produto só Intel ainda tenha onde rodar:

```bash
# Xcode 26.0.1
xcrun simctl delete unavailable
xcodebuild -downloadPlatform iOS -architectureVariant universal
```

Apague antes o runtime do iOS 26 só arm64 que você já tem, pelo painel Settings, Components do Xcode. Caso contrário o download resolve para o runtime já instalado e termina sem buscar a variante universal. Verifique depois:

```bash
# Xcode 26.0.1
xcrun simctl list runtimes --json | grep -i x86_64
```

Essa é a solução que o próprio Flutter recomenda. Desde a 3.41.4 (4 de março de 2026), a ferramenta imprime a sugestão depois de um build para simulador que falhou, condicionada ao Xcode 26 ou posterior e a o runtime selecionado realmente não ter a fatia `x86_64`:

```
The selected simulator is incompatible with the current build settings.
Please use a simulator that supports x86_64, such as a simulator prior to iOS 26 or download the universal variant of the iOS 26 simulator using "xcodebuild -downloadPlatform iOS -architectureVariant universal".
```

Trate isso como paliativo. Um runtime universal é um download maior, roda seu app sob Rosetta e não ajuda em nada o próximo colega que instalar o runtime do jeito padrão. Remover a exclusão é a correção duradoura.

## E se o erro disser que a plataforma não está instalada?

Um modo de falha diferente imprime o mesmo cabeçalho com um bloco `Ineligible destinations` embaixo:

```
Unable to find a destination matching the provided destination specifier:
                { id:1234D567-890C-1DA2-34E5-F6789A0123C4 }

        Ineligible destinations for the "Runner" scheme:
                { platform:iOS, id:dvtdevice-DVTiPhonePlaceholder-iphoneos:placeholder, name:Any iOS Device, error:iOS 17.0 is not installed. To use with Xcode, first download and install the platform }
```

Isso não é problema de arquitetura. Seu deployment target ou seu scheme referenciam um runtime que não está na máquina, algo comum logo depois de atualizar o Xcode, porque o Xcode 26 não carrega runtimes antigos adiante. O Flutter extrai a expressão `is not installed` dessa mensagem e imprime instruções de instalação apontando para o painel Components do Xcode. Instale o runtime que falta, ou suba o deployment target para um que você tenha.

## E se o destino for um UDID de simulador obsoleto?

Se o UDID do erro não existe mais, o `xcodebuild` acrescenta uma linha distinta:

```
The requested device could not be found because no available devices matched the request.
```

O Flutter exclui explicitamente esse caso do seu diagnóstico de arquitetura, então essa frase significa que você está atrás de um dispositivo fantasma, não de uma incompatibilidade de arquitetura. Normalmente acontece depois de uma atualização de iOS ou Xcode que regenerou o conjunto de simuladores enquanto uma configuração da IDE, um `launch.json` ou um alias de shell continuavam fixando o identificador antigo:

```bash
# Xcode 26.0.1, Flutter 3.44.2
xcrun simctl list devices available
xcrun simctl delete unavailable
flutter devices
```

Depois passe um UDID que o `flutter devices` realmente reporte, ou tire o `-d` e deixe o Flutter escolher.

## O que quebra isso no CI quando funciona localmente?

Em um servidor de build, a mesma mensagem geralmente significa que a plataforma iOS não está instalada. Na [issue #163011](https://github.com/flutter/flutter/issues/163011) a lista de destinos continha apenas entradas de macOS, que é a cara de uma imagem macOS com um conjunto incompleto de componentes do Xcode. `flutter build ipa` passa `generic/platform=iOS`, e sem plataforma iOS presente não há nada para corresponder.

Verifique a imagem antes de culpar o projeto:

```bash
# Xcode 26.0.1 on a CI runner
xcodebuild -showsdks
xcrun simctl list runtimes
```

Se o iOS estiver faltando, adicione `xcodebuild -downloadPlatform iOS` como passo pré-build e fixe a versão do Xcode para que uma atualização da imagem não mude a resposta em silêncio. É a mesma disciplina que mantém previsível [um pipeline de CI que compila contra várias versões do Flutter](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).

## Pegadinhas e variantes parecidas

`ONLY_ACTIVE_ARCH` não é substituto. O Flutter já passa `ONLY_ACTIVE_ARCH` e `ARCHS` explicitamente quando conhece a arquitetura ativa, e definir isso na mão não devolve uma fatia que o `EXCLUDED_ARCHS` removeu.

Fique de olho também na forma legada `VALID_ARCHS[sdk=iphonesimulator*] = x86_64`. Ela é anterior ao `EXCLUDED_ARCHS` e produz um produto só Intel idêntico. O podhelper do Flutter a redefine para `$(ARCHS_STANDARD)` nos targets de pods, mas não no target do seu app.

Um build para dispositivo físico que falha com a mesma string é outro problema. Ali o destino é `generic/platform=iOS`, e a causa habitual é assinatura de código, mais perto de [um provisioning profile que não inclui o dispositivo selecionado](/pt-br/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/).

Por fim, se o build passa da verificação de destino e morre no lançamento, você está em outro terreno. Um build debug que inicia e cai imediatamente na Dart VM é [a falha de mprotect permission denied](/pt-br/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/), e um que nunca linka é mais provavelmente [um conflito de resolução de versões do CocoaPods](/pt-br/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/).

## Qual versão do Flutter relata a causa real

A incompatibilidade de fundo é da Apple, então atualizar o Flutter não faz um produto só Intel rodar em um runtime só arm64. O que a atualização compra é um diagnóstico em vez de um enigma. O Flutter 3.41.0 adiciona o aviso que cita cada target que exclui arm64, e a 3.41.4 adiciona a dica pós-falha sobre o runtime universal. Ambos estão na stable atual, 3.47.1, lançada em 19 de agosto de 2026.

Se você está na 3.38 ou anterior e não pode atualizar, rode o grep de `-showBuildSettings` acima na mão. É exatamente a verificação que o Flutter agora faz por você. Para uma varredura mais ampla de falhas de build iOS depois de atualizar o Xcode, a ordem de triagem de [o passo a passo da falha de build com Xcode 16](/pt-br/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/) continua valendo.

## Relacionado

- [Correção: mprotect failed: 13 (Permission denied) em um build debug de Flutter para iOS](/pt-br/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/)
- [Correção: CocoaPods could not find compatible versions for pod em um build iOS de Flutter](/pt-br/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/)
- [Correção: Failed to build iOS app com Xcode 16 e Flutter 3.x](/pt-br/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/)
- [Flutter 3.44 torna o Swift Package Manager o padrão](/pt-br/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/)
- [Como mirar várias versões do Flutter em um único pipeline de CI](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)

## Fontes

- [flutter/flutter issue #176188, flutter run não funciona no simulador do iOS 26](https://github.com/flutter/flutter/issues/176188)
- [flutter/flutter PR #177065, remoção da exclusão de arm64 para suportar simuladores do Xcode 26](https://github.com/flutter/flutter/pull/177065)
- [flutter/flutter issue #163011, falha de destination specifier com uma plataforma iOS genérica](https://github.com/flutter/flutter/issues/163011)
- [Fóruns da Apple Developer, instalação de runtimes do simulador do iOS 26 e variantes de arquitetura](https://developer.apple.com/forums/thread/801106)
- [Apple, download e instalação de componentes adicionais do Xcode](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components)
- [Apple, instalação de runtimes adicionais do simulador](https://developer.apple.com/documentation/xcode/installing-additional-simulator-runtimes)
