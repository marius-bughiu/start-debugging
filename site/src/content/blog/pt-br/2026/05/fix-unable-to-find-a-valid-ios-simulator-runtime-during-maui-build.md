---
title: "Fix: Unable to find a valid iOS Simulator runtime durante a compilação do MAUI"
description: "Xcode 15+ não inclui mais runtimes do simulador iOS. O MAUI falha o build quando SupportedOSPlatformVersion não tem um runtime correspondente instalado. Instale um com xcodebuild -downloadPlatform iOS ou pelas Settings do Xcode, e verifique com xcrun simctl list runtimes."
pubDate: 2026-05-16
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "maui"
  - "maui-11"
  - "ios"
  - "xcode"
  - "simulator"
lang: "pt-br"
translationOf: "2026/05/fix-unable-to-find-a-valid-ios-simulator-runtime-during-maui-build"
translatedBy: "claude"
translationDate: 2026-05-16
---

A correção: a partir do Xcode 15, o runtime do simulador iOS não vem mais junto com o próprio Xcode, e a partir do Xcode 26 o runtime do Xcode anterior também não é migrado automaticamente. O toolchain do MAUI iOS lê `SupportedOSPlatformVersion` do seu csproj, pede ao Xcode um simulador nessa versão ou superior e desiste com `Unable to find a valid iOS Simulator runtime` quando nada combina. Rode `xcrun simctl list runtimes` para confirmar o que está realmente instalado, e então baixe um pelo Xcode em Settings, Platforms, no botão de mais, ou faça isso sem interface com `xcodebuild -downloadPlatform iOS`. Se `SupportedOSPlatformVersion` no seu csproj for maior que todos os runtimes instalados, baixe para uma versão que você tem ou instale o runtime correspondente.

```text
/usr/local/share/dotnet/packs/Microsoft.iOS.Sdk/18.2.9270/targets/Xamarin.Shared.Sdk.targets(1245,3):
error : Unable to find a valid iOS Simulator runtime. Please install one from Xcode > Settings > Platforms.

xcodebuild: error: Unable to find a destination matching the provided destination specifier:
        { platform:iOS Simulator, OS:18.2, name:iPhone 16 Pro }

Could not find the simulator runtime 'com.apple.CoreSimulator.SimRuntime.iOS-18-2'.
```

Este guia foi escrito contra .NET 11 preview 4, MAUI 11 preview 4, Xcode 26.0 e `Microsoft.iOS.Sdk` 18.2.9270. O comportamento apareceu no momento em que a Apple separou os runtimes do simulador do instalador do Xcode no Xcode 15, e ficou bem mais visível no Xcode 26 porque a Apple parou de importar silenciosamente o cache de runtimes do Xcode anterior na primeira inicialização. Se você atualizou recentemente e seu pipeline de build começou a falhar sem motivo aparente, quase certamente esta é a causa.

## Por que o Xcode 15 quebrou os builds de MAUI iOS

Durante a maior parte da história do Xcode, o instalador carregava o runtime do simulador iOS no mesmo `.xip` que você baixava do portal do desenvolvedor, o que é parte do motivo pelo qual o Xcode chegava a 7+ GB. Com o Xcode 15 a Apple separou os runtimes em um modelo de download separado: o aplicativo Xcode inclui o toolchain (compiladores, SDKs, headers) e o próprio app do simulador iOS, mas cada imagem de runtime concreta (`iOS 17.4`, `iOS 18.2`, e assim por diante) é um download separado em que você opta. O instalador cai para uns 3 GB, e você puxa só as plataformas que precisa.

Isso é ótimo para o uso de disco e terrível para os primeiros builds. Um projeto MAUI mirando `net11.0-ios` resolve o SDK alvo via `Microsoft.iOS.Sdk`, passa ao `xcodebuild` uma string de destino que inclui uma versão de runtime, e então `xcrun simctl create` ou `xcrun simctl boot` tenta encontrar um runtime correspondente em `~/Library/Developer/CoreSimulator/Profiles/Runtimes` e `/Library/Developer/CoreSimulator/Profiles/Runtimes`. Sem nada instalado, nenhuma dessas chamadas dá certo e você vê o erro acima.

O Xcode 26 acrescentou uma nuance. A Apple agora trata os runtimes como totalmente independentes do bundle do Xcode, e o novo framework `CoreSimulator` mantém uma matriz de compatibilidade por Xcode. Se você tinha o Xcode 16 com o simulador iOS 18.2 instalado, atualizou para o Xcode 26 e o seu csproj mira `iOS 19.0`, o runtime 18.2 ainda está em disco mas não é o que o MAUI está pedindo. A redação do erro é a mesma, e por isso confunde as pessoas no upgrade.

## O que o MAUI realmente pede

Quando você roda `dotnet build -t:Run -f net11.0-ios -p:_DeviceName=":v2:runtime=com.apple.CoreSimulator.SimRuntime.iOS-19-0,devicetype=com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro"`, os targets do MAUI iOS no `Microsoft.iOS.Sdk` fazem algumas coisas:

1. Resolvem `SupportedOSPlatformVersion` e `_MtouchTargetiOSVersion` do seu projeto.
2. Invocam `xcrun simctl list runtimes -j` para descobrir o que está instalado localmente.
3. Escolhem o primeiro runtime cuja versão seja maior ou igual ao seu alvo e que combine com a plataforma (`iOS-Simulator`).
4. Se nada combinar, a tarefa MSBuild lança o erro `Unable to find a valid iOS Simulator runtime` antes mesmo de chamar `xcrun simctl boot`.

Isso é implementado na tarefa `_DetectSimulator` em `Xamarin.Shared.Sdk.targets`. A conclusão: o erro significa que sua lista de runtimes instalados está vazia para a plataforma, ou todos os runtimes instalados têm uma versão menor que o alvo do seu csproj.

## Verifique o que está realmente instalado

Antes de mexer no csproj, liste os runtimes:

```bash
# macOS, any shell
xcrun simctl list runtimes --json | jq '.runtimes[] | {name, version, identifier, isAvailable}'
```

Uma máquina saudável imprime algo como:

```json
{
  "name": "iOS 19.0",
  "version": "19.0",
  "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-19-0",
  "isAvailable": true
}
```

Uma máquina quebrada após um upgrade do Xcode imprime um array `runtimes` vazio, ou runtimes marcados com `"isAvailable": false` e uma string `availabilityError` explicando que o runtime é "incompatível com esta versão do Xcode". Um runtime marcado como indisponível está em disco mas o Xcode se recusa a usá-lo, então o MAUI o trata como ausente.

Você também pode ver a mesma informação dentro do Xcode em **Settings, Platforms**. A lista mostra os runtimes instalados com um check e deixa você instalar ou remover cada um.

## Instale o runtime pela linha de comando

Se está sem interface ou em CI, não clique pela UI do Xcode. O Xcode 15 introduziu a flag `-downloadPlatform` para o `xcodebuild`:

```bash
# Xcode 15+, downloads the latest iOS simulator runtime
# compatible with this Xcode version
xcodebuild -downloadPlatform iOS

# Xcode 16+, pin to a specific build of the runtime
xcodebuild -downloadPlatform iOS -buildVersion 18.2
```

O comando roda em primeiro plano, imprime uma porcentagem de progresso e escreve o runtime em `~/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS <version>.simruntime`. São uns 8 GB por runtime, então planeje o CI levando isso em conta. A Apple documenta isso em [Downloading and installing additional Xcode components](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components).

Para versões mais antigas do Xcode (apenas Xcode 15), a forma antiga é `xcodebuild -downloadAllPlatforms`, que baixa o runtime de toda plataforma compatível. É muito mais pesado que `-downloadPlatform iOS` e você quase nunca vai querer isso em CI.

Se precisa de um runtime que não está no conjunto de compatibilidade do Xcode atual, por exemplo quer iOS 17.4 para reproduzir um bug de cliente no Xcode 26, instale por um `.dmg` ou `.simruntime` baixado:

```bash
# Manually install a simruntime image from disk
xcrun simctl runtime add "/path/to/iOS 17.4.simruntime"
```

O subcomando `xcrun simctl runtime` existe no Xcode 16+ e é a forma suportada de registrar um runtime baixado separadamente. Você pode listar as imagens de runtime registradas com `xcrun simctl runtime list`.

## Alinhe SupportedOSPlatformVersion com o que você tem

Se você instalou `iOS 18.2` mas seu csproj mira `iOS 19.0`, o erro vai se repetir. Abra a seção específica de iOS do seu csproj e ou baixe o alvo ou aceite que precisa de um runtime mais novo:

```xml
<!-- .NET 11, MAUI 11, Microsoft.iOS.Sdk 18.2.9270 -->
<PropertyGroup Condition="$(TargetFramework.Contains('-ios'))">
  <SupportedOSPlatformVersion>15.0</SupportedOSPlatformVersion>
</PropertyGroup>
```

`SupportedOSPlatformVersion` é a versão **mínima** de iOS que seu aplicativo suporta em runtime. O runtime de simulador que você inicializar precisa ser maior ou igual a esse número. O simulador que o MAUI lança por padrão é o runtime instalado de maior versão, não o mínimo, então se você tem iOS 19.0 instalado seu app ainda inicializa em iOS 19.0 mesmo que o piso do projeto seja 15.0.

Não suba `SupportedOSPlatformVersion` para silenciar o erro, essa é a alavanca errada. A jogada certa é instalar o runtime e deixar o mínimo do projeto onde precisa estar para o seu público.

## Fixe um simulador específico via dotnet build

Quando você tem múltiplos runtimes instalados e quer um específico, passe `_DeviceName` para o target Run do iOS no MAUI. Essa é a mesma string que `xcrun simctl` usa internamente:

```bash
# .NET 11 preview 4, MAUI 11 preview 4
dotnet build -t:Run -f net11.0-ios \
  -p:_DeviceName=":v2:runtime=com.apple.CoreSimulator.SimRuntime.iOS-18-2,devicetype=com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro"
```

O prefixo `:v2:` é obrigatório, o MAUI faz o parse dele como o seletor de dispositivo no formato novo. O identificador de runtime combina com o que `xcrun simctl list runtimes` imprime em `identifier`. O identificador de tipo de dispositivo combina com `xcrun simctl list devicetypes`.

Se você omitir `_DeviceName`, o MAUI pega o simulador de iPhone instalado mais recente no maior runtime instalado, o que tudo bem para dev local e surpreendentemente frágil em CI quando uma release pontual nova do Xcode chega.

## Corrigindo no CI especificamente

Em um runner novo `macos-15` ou `macos-26` do GitHub Actions, o Xcode vem pré-instalado mas o runtime do simulador iOS que combina com o seu `SupportedOSPlatformVersion` pode não estar. As imagens hospedadas da Apple incluem um ou dois runtimes embutidos; agentes de build de outros provedores variam. O padrão seguro é instalar explicitamente antes de rodar `dotnet build`:

```yaml
# .github/workflows/maui-ios.yml
- name: Select Xcode
  run: sudo xcode-select -s /Applications/Xcode_26.0.app

- name: Install iOS 18.2 simulator runtime
  run: xcodebuild -downloadPlatform iOS -buildVersion 18.2

- name: Verify runtime is registered
  run: xcrun simctl list runtimes

- name: Build MAUI iOS
  run: dotnet build src/App/App.csproj -c Release -f net11.0-ios
```

Duas coisas pegam as pessoas aqui. Primeiro, o runner faz cache entre jobs só se você optar, então cada job baixa de novo 8 GB a menos que você plugue [`actions/cache`](https://github.com/actions/cache) com chave na versão do runtime. Segundo, `xcodebuild -downloadPlatform` não falha se o runtime já está instalado, mas refaz a busca de metadados. Com cache quente o comando termina em segundos.

Se o seu CI está rodando um Xcode mais antigo (Xcode 14 ou anterior), `-downloadPlatform` não existe. Ou atualize o Xcode, ou recorra a uma ferramenta de terceiros como `xcodes` (`brew install xcodes`) e `sudo xcodes runtimes install "iOS 18.2"`. O `xcodes` mantido pela comunidade era a única boa resposta antes do Xcode 15 e ainda é útil quando você precisa de runtimes antigos que a Apple não hospeda mais no portal do desenvolvedor.

## Serviço CoreSimulator travado após o upgrade

Às vezes o runtime está instalado, `xcrun simctl list runtimes` mostra ele como disponível, e o MAUI ainda falha. A causa normalmente é um `CoreSimulatorService` velho que cacheou a lista de runtimes do Xcode anterior ao upgrade. Mate ele:

```bash
sudo killall -9 com.apple.CoreSimulator.CoreSimulatorService
```

O serviço relança na próxima chamada do `xcrun simctl` e relê o diretório de runtimes. Isso está documentado em vários issues do `dotnet/macios`, incluindo [dotnet/macios#22243](https://github.com/dotnet/macios/issues/22243), e aparece mais depois que `softwareupdate -ai` roda e atualiza o CoreSimulator sem reiniciar.

Se matar o serviço não ajudar, limpe também `~/Library/Developer/CoreSimulator/Caches` e reinicie. O `CoreSimulator` mantém um cache de dados derivados que ocasionalmente aponta para um caminho de runtime deletado.

## Quando o Xcode errado está selecionado

O outro falso positivo comum: `xcode-select -p` aponta para um Xcode diferente daquele em que você instalou o runtime. Os runtimes ficam tecnicamente registrados contra o Xcode ativo via `CoreSimulator`, e trocar de Xcode pode deixar o novo Xcode ativo sem runtimes visíveis mesmo que os arquivos existam:

```bash
# Show the active Xcode
xcode-select -p
# /Applications/Xcode_26.0.app/Contents/Developer

# Switch to a specific Xcode
sudo xcode-select -s /Applications/Xcode_26.0.app
```

O MAUI também respeita `DEVELOPER_DIR`. Se um passo de CI exporta essa variável, ela sobrescreve `xcode-select`. A divergência entre `xcode-select` e `DEVELOPER_DIR` é um daqueles bugs que só aparece na segunda execução do pipeline, quando uma variável de ambiente cacheada conflita com o default novo de um runner. O [guia de troubleshooting do MAUI](https://learn.microsoft.com/en-us/dotnet/maui/troubleshooting?view=net-maui-10.0) documenta a precedência da seleção do Xcode: `DEVELOPER_DIR`, depois arquivos plist deprecados, depois `xcode-select -p`, depois `/Applications/Xcode.app`.

## Pegadinhas depois da correção

Algumas coisas ainda tropeçam as pessoas após o runtime estar instalado:

1. **Slices de simulador Apple Silicon vs Intel**. Os runtimes do simulador iOS 17.0+ só trazem a slice arm64. Se você roda num Mac Intel sob Rosetta, não consegue inicializar eles. Use um runtime mais antigo ou atualize o agente de build.
2. **Confusão com Mac Catalyst**. `net11.0-maccatalyst` não precisa de runtime de simulador, ele roda nativamente no macOS. Se um build do Mac Catalyst falhar com esse erro, quase certamente você tem um target `net11.0-ios` perdido no mesmo projeto e a sua IDE pegou ele.
3. **Divergências de `-buildVersion`**. `xcodebuild -downloadPlatform iOS -buildVersion 18.2` aceita versões de marketing como `18.2`, não números de build internos como `22C150`. Passar um número de build baixa silenciosamente a última versão em vez disso.
4. **Uploads para o App Store Connect ainda funcionam sem simulador**. Builds para dispositivo (`-p:RuntimeIdentifier=ios-arm64`) não precisam do runtime do simulador. Se o seu CI só envia para o TestFlight, dá para pular a instalação por completo e configurar só a assinatura.

Se você também briga com erros de build do lado Android no mesmo projeto, o mesmo padrão (toolchain espera um componente que o instalador não inclui mais) aparece lá também: veja o artigo sobre [a falha do Gradle em produzir o APK no MAUI Android](/pt-br/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/). Para erros do lado iOS que parecem similares mas não estão relacionados a simuladores, a [correção da divergência de dispositivo no provisioning profile](/pt-br/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/) cobre esse caminho. Se você quer se afastar de móvel cross-platform por completo neste projeto, o post sobre [rodar MAUI só em Windows e macOS](/pt-br/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) percorre os target frameworks só de desktop. Para contexto sobre a onda do release MAUI 11, o post sobre [o default do CoreCLR no MAUI no .NET 11 preview 4](/pt-br/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/) explica o que mudou sob o capô.

A correção mais curta é quase sempre `xcodebuild -downloadPlatform iOS` seguida de um `dotnet build`. A correção mais longa é escrever essa linha única no seu script de CI, para o próximo agente que entrar no time não perder uma tarde nisso.

## Links das fontes

- [Downloading and installing additional Xcode components](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components)
- [Troubleshoot known issues - .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/troubleshooting?view=net-maui-10.0)
- [dotnet/macios#22243 - Can't find simulator when a particular iOS SDK version doesn't contain a simulator](https://github.com/dotnet/macios/issues/22243)
- [dotnet/maui#23352 - iOS build failed with iossimulator-x64 RuntimeIdentifier](https://github.com/dotnet/maui/issues/23352)
- [Build with a specific version of Xcode](https://learn.microsoft.com/en-us/dotnet/ios/cli)
