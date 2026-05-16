---
title: "Correção: O provisioning profile não inclui o dispositivo atualmente selecionado em MAUI iOS"
description: "O perfil que o Visual Studio escolheu foi gerado antes do UDID deste iPhone ser registrado. Registre o dispositivo novamente, regenere o perfil de desenvolvimento, baixe e implante."
pubDate: 2026-05-16
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "maui"
  - "maui-11"
  - "ios"
  - "xcode"
  - "signing"
lang: "pt-br"
translationOf: "2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios"
translatedBy: "claude"
translationDate: 2026-05-16
---

A correção: o provisioning profile de desenvolvimento com o qual o MAUI tentou assinar não lista o UDID do iPhone. Ou o perfil foi gerado antes de você registrar o dispositivo, ou o dispositivo está registrado sob um time diferente daquele que o Visual Studio está usando, ou o Bundle ID no seu csproj não corresponde ao App ID ao qual o perfil está vinculado. Adicione o UDID na Apple Developer Account, regenere o perfil iOS App Development para que ele inclua o novo dispositivo, clique em Download All Profiles no Visual Studio (ou `Download Manual Profiles` no Xcode se você usar o caminho via CLI) e implante novamente. Se você está em provisioning automático, desconectar e reconectar o dispositivo geralmente faz o Visual Studio reexecutar o provisioning e capturar o novo UDID.

```text
Could not find any available provisioning profiles for iOS.
error : The provisioning profile doesn't include the currently selected device "iPhone (00008130-001A2C3D0EF8401E)".

error MT1006: Could not install the application 'com.example.app' on the device 'iPhone'.
error : A valid provisioning profile for this executable was not found. (0xe8008015)
```

Este guia é escrito contra .NET 11 GA, o target framework `net11.0-ios`, .NET MAUI 11.0.0, Xcode 16.4 e Visual Studio 17.14 pareado com um host de build Mac. O mesmo erro e a mesma correção se aplicam sem alterações em .NET MAUI 8 e 9; apenas os IDs de workload (`maui-ios`, `ios`) e o Xcode mínimo incluído mudam entre releases. A exceção é lançada pelo `mlaunch`, a ferramenta que o MAUI usa por baixo dos panos para enviar um bundle `.app` para um dispositivo real, depois que o `codesign` já aceitou o binário. O build em si é bem-sucedido. É o passo de instalação que rejeita você.

## Por que o MAUI iOS associa perfis a UDIDs de dispositivos

O modelo de assinatura de código iOS da Apple tem três partes móveis: um certificado de assinatura (sua identidade de desenvolvedor), um App ID (o bundle identifier ao qual o perfil está vinculado) e um provisioning profile (um blob assinado que liga um certificado, um App ID, um time e uma lista de UDIDs de dispositivos permitidos). Um perfil de desenvolvimento só é válido para os dispositivos que a Apple escreveu nele no momento da geração. Conecte um novo iPhone e qualquer perfil de desenvolvimento pré-existente silenciosamente não o cobre. O SO recusa a instalação com `0xe8008015`, o erro MISAgent para "no valid provisioning profile". O `mlaunch` do MAUI mostra isso como a mensagem "provisioning profile doesn't include the currently selected device" e, em toolchains mais antigas, como o mais críptico `MT1006`.

Não há aviso em tempo de build. O `codesign` só verifica o certificado e o App ID do perfil; ele não inspeciona a lista de dispositivos. A lista de dispositivos é aplicada pelo `installd` no próprio iPhone, e é por isso que o erro sempre aparece na implantação, nunca no build.

Três coisas causam isso:

1. O UDID do dispositivo não está no perfil (mais comum, especialmente logo depois de conectar um novo dispositivo de teste).
2. O Bundle ID no seu csproj se desviou do App ID ao qual o perfil está vinculado (renomear um projeto, mudar o prefixo da organização, copiar um template).
3. O Visual Studio está assinando com um perfil de um time diferente daquele que registrou o dispositivo (um time pessoal vs um time de organização, ou um perfil desatualizado em cache local).

## Uma reprodução mínima

Pegue qualquer projeto MAUI 11 iOS, defina Bundle Signing como Manual, aponte `CodesignProvision` para um perfil de desenvolvimento que foi gerado na semana passada, depois conecte um iPhone novinho hoje.

```xml
<!-- .NET 11, .NET MAUI 11.0.0, net11.0-ios -->
<PropertyGroup Condition="'$(TargetFramework)' == 'net11.0-ios' and '$(Configuration)' == 'Debug'">
  <CodesignKey>Apple Development: Marius Bughiu (ABCDE12345)</CodesignKey>
  <CodesignProvision>MyApp Dev Profile</CodesignProvision>
  <CodesignEntitlements>Platforms/iOS/Entitlements.plist</CodesignEntitlements>
</PropertyGroup>
```

Depois:

```bash
# .NET 11.0.100, MAUI workload 11.0.0
dotnet build -t:Run -f net11.0-ios -p:_DeviceName=":v2:udid=00008130-001A2C3D0EF8401E"
```

O build é bem-sucedido. A implantação falha com a mensagem de dispositivo não incluído, porque o perfil chamado `MyApp Dev Profile` foi gerado antes de `00008130-001A2C3D0EF8401E` ser um dispositivo que a Apple conhecia.

## Caminho de correção A: provisioning automático que ficou obsoleto

Se seu esquema de `iOS Bundle Signing` está definido como **Automatic Provisioning** (o padrão recomendado para desenvolvimento), o Visual Studio deveria reexecutar o provisioning toda vez que um novo dispositivo é conectado e silenciosamente regenerar o perfil para incluí-lo. Quando esse mecanismo trava, o erro que você está lendo é o sintoma.

1. Abra **Tools > Options > Xamarin > Apple Accounts**, selecione seu time, clique em **View Details**. Confirme que o time que você espera é o time que o Visual Studio está usando. Se você ver dois times (um time pessoal "Marius Bughiu" e um time de organização), cada um tem seu próprio conjunto de perfis e o Visual Studio só vai auto-provisionar contra o time atualmente vinculado ao projeto.
2. Clique com o botão direito no projeto, **Properties**, **iOS > Bundle Signing**. Confirme que **Scheme** é **Automatic Provisioning**, que **Signing Identity** e **Provisioning Profile** estão ambos em **Automatic**, e que **Configure Automatic Provisioning** mostra um check verde. Se o diálogo reporta um erro, leia; "Authentication Service Is Unavailable" quase sempre significa que há um acordo não aceito no [App Store Connect](https://appstoreconnect.apple.com/) ou na [Apple Developer](https://developer.apple.com/account).
3. Desconecte o iPhone do host de build Mac, espere dois segundos, conecte novamente. O Visual Studio escuta o evento USB e reexecuta o provisioning automático, que é o que registra um novo UDID e regenera o perfil de desenvolvimento. Observe o painel **Output > General** por `Automatic provisioning succeeded` antes de implantar novamente.
4. Se você trocou de Mac desde o último build bem-sucedido, a chave privada do seu certificado de assinatura provavelmente nunca atravessou. O Visual Studio vai te dizer isso no diálogo Apple Accounts com o status **Not in Keychain**. Exporte o `.p12` do Keychain Access no Mac original e importe via **Import Certificate** no diálogo Apple Accounts, então tente novamente.

O provisioning automático ainda exige que o host de build Mac esteja pareado e acessível. Se `Pair to Mac` mostra amarelo, o evento de dispositivo USB não se propaga e seu UDID novo nunca é registrado. Refaça o pareamento primeiro.

## Caminho de correção B: provisioning manual, o caminho explícito do csproj

Se você mantém a assinatura iOS sob controle explícito (CI, distribuição enterprise, uma conta Apple compartilhada entre o time), faça o registro e a regeneração manualmente.

1. No Mac, **Xcode > Window > Devices and Simulators**, selecione o iPhone, copie a string **Identifier**. Este é o UDID que o `installd` verifica. O formato é `00008130-001A2C3D0EF8401E` para um dispositivo A12+. Não digite; copie. UDIDs têm 25 caracteres com um traço; um caractere errado e o perfil silenciosamente não corresponde.
2. Em um navegador, [Devices na Apple Developer](https://developer.apple.com/account/resources/devices/list), **+**, selecione a plataforma **iOS, tvOS, watchOS**, cole o UDID, dê um nome memorável, **Continue**, **Register**.
3. [Profiles](https://developer.apple.com/account/resources/profiles/list), encontre seu perfil de desenvolvimento, **Edit**, marque o dispositivo recém-adicionado na lista Devices, **Save**, **Download**. Editar o perfil o regenera; o nome do arquivo permanece o mesmo, o conteúdo muda. A Apple não envia o arquivo novo para sua máquina; você tem que baixar.
4. Instale o perfil regenerado. No Mac, dar duplo clique no `.mobileprovision` o registra em `~/Library/MobileDevice/Provisioning Profiles/`. No Windows, no Visual Studio vá em **Tools > Options > Xamarin > Apple Accounts**, selecione seu time, **View Details**, **Download All Profiles**. O perfil sincroniza tanto para o Windows quanto para o Mac pareado.
5. Confirme que seu csproj aponta para o perfil correto. A string em `CodesignProvision` deve corresponder ao **Name** do perfil na Apple Developer exatamente, não ao nome do arquivo, não ao UUID:

    ```xml
    <!-- .NET 11, .NET MAUI 11.0.0 -->
    <PropertyGroup Condition="'$(TargetFramework)' == 'net11.0-ios' and '$(Configuration)' == 'Debug'">
      <CodesignKey>Apple Development: Marius Bughiu (ABCDE12345)</CodesignKey>
      <CodesignProvision>MyApp Dev Profile</CodesignProvision>
    </PropertyGroup>
    ```

    O `CodesignKey` é o nome comum do certificado como aparece no Keychain Access em **My Certificates**. O `CodesignProvision` é o nome do perfil que você digitou no passo 3 do fluxo Apple Developer. Ambos diferenciam maiúsculas e minúsculas. Veja [CodesignKey](https://learn.microsoft.com/en-us/dotnet/ios/building-apps/build-properties#codesignkey) e [CodesignProvision](https://learn.microsoft.com/en-us/dotnet/ios/building-apps/build-properties#codesignprovision) para o esquema completo.

6. Recompile e implante novamente. Se a falha persistir, pule para os gotchas abaixo; o UDID foi registrado corretamente, então algo mais está errado.

## Verifique que o perfil realmente contém o dispositivo

Antes de desmontar o projeto, prove que o perfil está correto. O `security` no macOS decodifica o envelope CMS em volta de um `.mobileprovision`:

```bash
# macOS, security tool ships with the OS
security cms -D -i ~/Library/MobileDevice/Provisioning\ Profiles/<UUID>.mobileprovision \
  | plutil -convert xml1 -o - - \
  | grep -A1000 ProvisionedDevices \
  | head -50
```

Você deve ver um elemento `<string>` com seu UDID dentro de `<key>ProvisionedDevices</key>`. Se ele estiver faltando, o perfil na sua pasta Provisioning Profiles é a cópia pré-regeneração. Apague e baixe novamente do Visual Studio ou Xcode. O macOS não sobrescreve um perfil existente com um mais novo de mesmo UUID a menos que você remova o arquivo antigo primeiro; isso pega muita gente que acha que tem "o perfil novo" mas na verdade tem o da semana passada.

Já que está aí, verifique o valor `<key>application-identifier</key>`. Ele deve ser igual a `<TEAM_ID>.<bundle-id>`, onde o bundle id é exatamente o **Application ID** no seu csproj. Se eles diferem, seu csproj ou seu `Info.plist` se desviaram. Veja a seção sobre desvio de Bundle ID em gotchas.

## Gotchas e casos parecidos

**Você está implantando no simulador, não num dispositivo.** O simulador não exige provisioning profile algum, mas o `mlaunch` ainda vai reclamar se seu projeto força um perfil via `CodesignProvision` e você acidentalmente selecionou um target `iPhone 15 Pro Simulator`. Mude o **Debug Target** na barra de ferramentas do Visual Studio para **iOS Remote Devices** e escolha o dispositivo físico.

**Você está rodando Distribution, não Development.** Um perfil de desenvolvimento só inclui dispositivos habilitados para Development e só assina com um certificado `Apple Development`. Se `Configuration` é `Release` e o projeto usa um certificado `Apple Distribution`, é necessário um perfil de distribuição ad-hoc e seu perfil dev não será selecionado. Veja o guia oficial sobre [publicação para distribuição ad-hoc](https://learn.microsoft.com/en-us/dotnet/maui/ios/deployment/publish-ad-hoc?view=net-maui-10.0) para os passos manuais paralelos.

**Desvio de Bundle ID.** O Application ID em **Project Properties > MAUI Shared > General** deve corresponder ao Bundle ID que um App ID wildcard ou explícito cobre. Um perfil wildcard `com.example.*` cobre `com.example.app` mas não `com.example.app.dev`. Se você forkou um sample e nunca atualizou o App ID, seu perfil é rejeitado por incompatibilidade de App ID e o `mlaunch` reporta isso como o erro de dispositivo não incluído porque o SO mete as duas verificações no mesmo código 0xe8008015.

**Perfil wildcard mas uma entitlement que precisa de App ID explícito.** Push Notifications, App Groups, Apple Pay, iCloud, Game Center, HealthKit, HomeKit, NFC, Associated Domains, In-App Purchase e Wireless Accessory Configuration todos exigem um App ID explícito. Se você habilitou uma destas em `Entitlements.plist` enquanto seu perfil é wildcard, a instalação falha. Mude para um App ID explícito que corresponda ao seu bundle identifier e regenere o perfil com a entitlement marcada.

**Dois perfis, mesmo App ID, times diferentes.** Perfis em cache não indexam por time. Se você já entrou em um time Apple Developer diferente na mesma máquina, os perfis dos dois times vivem lado a lado em `~/Library/MobileDevice/Provisioning Profiles/`. O Visual Studio escolhe um, muitas vezes o mais antigo ou o primeiro alfabeticamente, e a lista de dispositivos não bate porque o dispositivo está registrado sob o outro time. Apague os arquivos de perfil obsoletos e baixe novamente via **Download All Profiles**.

**O dispositivo está supervisionado ou perdeu a confiança.** No iPhone, **Settings > General > VPN & Device Management** deve listar o certificado de desenvolvedor e permitir tocar em **Trust**. Se "Trust This Computer" foi dispensado, o `installd` rejeita a implantação sem um motivo claro e o `mlaunch` pode mostrar a mensagem de dispositivo não incluído. Refaça o pareamento, toque em Trust, tente de novo.

**Contas Apple ID gratuitas têm um tempo de vida de perfil de 7 dias.** Times pessoais (sem assinatura paga) geram perfis de desenvolvimento que expiram sete dias depois da criação. A expiração se manifesta no momento da implantação da mesma forma que o caso de dispositivo faltante. A correção é regenerar clicando em Run no Xcode pelo menos uma vez, ou fazer upgrade para uma conta Apple Developer Program paga.

**`MT1006: Could not install the application`.** Este é o wrapper do `mlaunch` para qualquer falha de implantação, não uma causa específica. A primeira linha irmã no log de build é o erro real; no caso de dispositivo faltante é a linha "provisioning profile doesn't include". O artigo do Khalid Abuhakmeh sobre [missing entitlements](https://khalidabuhakmeh.com/fix-dotnet-maui-missingentitlement-and-provisioning-profiles-issues) percorre a variante de entitlements da mesma superfície MT1006.

## Relacionado

- O equivalente Android para "o wrapper do build esconde o erro real" está coberto em [o passo a passo da falha XA1029 de build do Gradle](/pt-br/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/).
- Se você está configurando hot-reload iOS no mesmo projeto, [dotnet watch em MAUI Android e iOS no .NET 11 preview 4](/pt-br/2026/05/dotnet-watch-maui-android-ios-net-11-preview-4/) cobre o loop de watch ao qual você pode retornar uma vez que a assinatura esteja consertada.
- Para fluxos de distribuição depois que o loop de desenvolvimento funciona, veja [empacotar um aplicativo MAUI para a Microsoft Store](/pt-br/2026/05/how-to-package-a-maui-app-for-the-microsoft-store/) para o lado Windows e a [documentação de distribuição ad-hoc](https://learn.microsoft.com/en-us/dotnet/maui/ios/deployment/publish-ad-hoc?view=net-maui-10.0) para o lado iOS.
- Se seu target é só desktop e você quer pular a assinatura mobile inteiramente, [um aplicativo MAUI que roda apenas no Windows e macOS, sem targets mobile](/pt-br/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) mostra como descartar o TFM `net11.0-ios`.
- Para o contexto de runtime subjacente em iOS no .NET 11, o post [CoreCLR como padrão do MAUI para Android e iOS no .NET 11 preview 4](/pt-br/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/) cobre o que mudou por baixo do `mlaunch`.

## Fontes

- [Manual provisioning for .NET MAUI iOS apps](https://learn.microsoft.com/en-us/dotnet/maui/ios/device-provisioning/manual-provisioning?view=net-maui-10.0) (Microsoft Learn)
- [Automatic provisioning for .NET MAUI iOS apps](https://learn.microsoft.com/en-us/dotnet/maui/ios/device-provisioning/automatic-provisioning?view=net-maui-10.0) (Microsoft Learn)
- [Device provisioning for .NET MAUI apps on iOS](https://learn.microsoft.com/en-us/dotnet/maui/ios/device-provisioning/?view=net-maui-10.0) (Microsoft Learn)
- [Build properties for iOS: CodesignKey and CodesignProvision](https://learn.microsoft.com/en-us/dotnet/ios/building-apps/build-properties#codesignkey) (Microsoft Learn)
- [Publish a .NET MAUI iOS app for ad-hoc distribution](https://learn.microsoft.com/en-us/dotnet/maui/ios/deployment/publish-ad-hoc?view=net-maui-10.0) (Microsoft Learn)
- [Manual iOS Provisioning, dotnet/maui#7056](https://github.com/dotnet/maui/issues/7056) (GitHub)
- [Khalid Abuhakmeh: Fix .NET MAUI MissingEntitlement and Provisioning Profiles Issues](https://khalidabuhakmeh.com/fix-dotnet-maui-missingentitlement-and-provisioning-profiles-issues)
