---
title: "Correção: \"does not support provisioning profiles\" ao arquivar um app Flutter iOS depois de migrar para o Swift Package Manager"
description: "Um provisioning profile passado ao xcodebuild na linha de comando se aplica a todos os targets de resource bundle do SwiftPM. Configure a assinatura manual no target Runner."
pubDate: 2026-10-12
template: error-page
tags:
  - "errors"
  - "flutter"
  - "ios"
  - "swiftpm"
  - "xcode"
  - "ci"
lang: "pt-br"
translationOf: "2026/10/fix-does-not-support-provisioning-profiles-flutter-ios-archive-swift-package-manager"
translatedBy: "claude"
translationDate: 2026-10-12
---

Pare de passar `PROVISIONING_PROFILE_SPECIFIER` (e geralmente também `CODE_SIGN_STYLE`, `DEVELOPMENT_TEAM` e `CODE_SIGN_IDENTITY`) como argumentos de linha de comando do `xcodebuild` ou como `xcargs` do fastlane. Uma build setting passada na linha de comando substitui essa configuração em **todos** os targets da build. Depois da migração para o SwiftPM, isso inclui o target de resource bundle que o Xcode gera para cada plugin, como `url_launcher_ios_url_launcher_ios`, e um resource bundle não pode ter um provisioning profile. Em vez disso, configure a assinatura manual na configuração Release do target `Runner` e arquive com `flutter build ipa`. Com o CocoaPods, os mesmos argumentos só funcionavam porque um hook `post_install` definia `CODE_SIGNING_ALLOWED = NO` em cada pod. O SwiftPM não tem esse hook, então a migração expõe o erro. Tudo abaixo foi reproduzido com Flutter 3.44.8, Xcode 27.0 e CocoaPods 1.17.0.

## O erro completo

Você recebe um erro por plugin que inclui recursos (na prática, todo plugin com um manifesto `PrivacyInfo.xcprivacy`), seguido da falha habitual de archive:

```
.../ios/Flutter/ephemeral/Packages/.packages/url_launcher_ios-6.4.2/Package.swift: error: url_launcher_ios_url_launcher_ios does not support provisioning profiles. url_launcher_ios_url_launcher_ios does not support provisioning profiles, but provisioning profile MyApp AppStore has been manually specified. Set the provisioning profile value to "Automatic" in the build settings editor. (in target 'url_launcher_ios_url_launcher_ios' from project 'url_launcher_ios')
.../ios/Flutter/ephemeral/Packages/.packages/shared_preferences_foundation-2.5.7/Package.swift: error: shared_preferences_foundation_shared_preferences_foundation does not support provisioning profiles. shared_preferences_foundation_shared_preferences_foundation does not support provisioning profiles, but provisioning profile MyApp AppStore has been manually specified. Set the provisioning profile value to "Automatic" in the build settings editor. (in target 'shared_preferences_foundation_shared_preferences_foundation' from project 'shared_preferences_foundation')
** ARCHIVE FAILED **
```

As duas coisas a observar são o caminho, que aponta para `Flutter/ephemeral/Packages/.packages/`, e o nome do target, que segue o padrão `<package>_<target>` do SwiftPM. Ambos indicam que o target com falha é o resource bundle de um Swift package, não o seu app e nem o código de um plugin.

O conselho da mensagem, "Set the provisioning profile value to Automatic in the build settings editor", não ajuda aqui. Você não consegue abrir as build settings de um target que o Xcode sintetiza a partir de um `Package.swift`, e nada nesse target pede um profile. O profile está sendo imposto a ele de fora.

## Por que o profile chega a targets que você nunca configurou

O Xcode resolve uma build setting em várias camadas, da menor para a maior prioridade: padrões da plataforma, configurações no nível do projeto, arquivos xcconfig, configurações no nível do target e, por fim, as substituições que você passa ao `xcodebuild` como `NAME=value`. A camada mais alta não é restrita a um target. Quando um script de CI executa:

```bash
# Xcode 27.0, Flutter 3.44.8 - the pattern that breaks
xcodebuild -workspace Runner.xcworkspace -scheme Runner \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath build/Runner.xcarchive archive \
  CODE_SIGN_STYLE=Manual \
  DEVELOPMENT_TEAM=ABCDE12345 \
  CODE_SIGN_IDENTITY="Apple Distribution" \
  PROVISIONING_PROFILE_SPECIFIER="MyApp AppStore"
```

todo target que participa do archive recebe `PROVISIONING_PROFILE_SPECIFIER = MyApp AppStore`. A validação de assinatura do Xcode então rejeita a configuração em qualquer tipo de produto que não pode ser provisionado, como resource bundles, bibliotecas estáticas e frameworks. A Apple nem sempre aplicou essa regra de forma consistente: uma [thread nos fóruns de desenvolvedores](https://developer.apple.com/forums/thread/700327) acompanha o mesmo erro para dependências nativas de Swift package, que apareceu nos betas do Xcode 13.3, sumiu no GM do 13.3 e voltou no Xcode 14. No Xcode 27.0 ele é aplicado.

Depois da migração, os targets de um archive são `Runner`, o agregado `FlutterGeneratedPluginSwiftPackage`, o produto de biblioteca de cada plugin e um target `.bundle` por plugin que declara `resources:` no seu `Package.swift`. A maioria dos plugins oficiais agora inclui um manifesto de privacidade dessa forma, então quase todo app real tem vários desses bundles.

### Por que funcionava com o CocoaPods

Executei o mesmo comando no mesmo app com o SwiftPM desativado (`enable-swift-package-manager: false` em `flutter: config:` no `pubspec.yaml`). Também falha, só que com nomes de target diferentes:

```
ios/Pods/Pods.xcodeproj: error: Pods-Runner does not support provisioning profiles. ...
ios/Pods/Pods.xcodeproj: error: url_launcher_ios does not support provisioning profiles. ...
ios/Pods/Pods.xcodeproj: error: shared_preferences_foundation does not support provisioning profiles. ...
```

Ou seja, a linha de comando nunca esteve correta. Os projetos que compilavam com ela tinham um bloco `post_install` no `Podfile` parecido com este, geralmente copiado de uma resposta do Stack Overflow anos atrás:

```ruby
# ios/Podfile, CocoaPods 1.17.0
post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_ios_build_settings(target)
    target.build_configurations.each do |config|
      config.build_settings['CODE_SIGNING_ALLOWED'] = 'NO'
    end
  end
end
```

Com esse hook, o archive passa por todos os targets de pod e apenas o `Runner` é validado contra o profile. O hook funciona porque o Xcode ignora a validação de assinatura em um target que não pode assinar, mesmo que o profile forçado ainda esteja nas configurações dele. Quando você apaga o `Podfile` como último passo da migração, o hook vai junto, e o SwiftPM não oferece equivalente. Não existe `post_install` para packages, e o `Package.swift` gerado em `Flutter/ephemeral` é reescrito a cada build.

## Repro mínimo

```bash
# Flutter 3.44.8, Xcode 27.0, SwiftPM enabled (the default since 3.44)
flutter create --platforms=ios -e --org com.example myapp
cd myapp
flutter pub add url_launcher shared_preferences
# Xcode 27 rejects the template's 13.0 deployment target
sed -i '' 's/IPHONEOS_DEPLOYMENT_TARGET = 13.0/IPHONEOS_DEPLOYMENT_TARGET = 15.0/g' \
  ios/Runner.xcodeproj/project.pbxproj
flutter build ios --simulator --debug   # applies the SwiftPM project migration
cd ios
xcodebuild -workspace Runner.xcworkspace -scheme Runner -configuration Release \
  -destination 'generic/platform=iOS' -archivePath ../build/Runner.xcarchive archive \
  CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=ABCDE12345 \
  PROVISIONING_PROFILE_SPECIFIER="MyApp AppStore" CODE_SIGN_IDENTITY="Apple Distribution"
```

Você não precisa de um certificado ou profile reais para ver o erro. O Xcode reporta os erros "does not support provisioning profiles" para os dois targets de bundle durante o planejamento da build, ao lado do erro esperado "No profile for team" para o `Runner`.

## Correção 1: configure a assinatura manual no target Runner e use `flutter build ipa`

A assinatura pertence aos targets que produzem algo assinável: o `Runner`, mais as extensões de app que você tiver (share extension, notification service extension, widget). Configure lá e em nenhum outro lugar.

No Xcode, abra `ios/Runner.xcworkspace`, selecione o target `Runner`, vá em **Signing & Capabilities**, escolha a aba **Release**, desative **Automatically manage signing** e escolha seu time e seu profile. Se preferir ver o resultado, isto é o que fica na configuração Release do target `Runner` em `ios/Runner.xcodeproj/project.pbxproj`:

```
/* Flutter 3.44.8, Xcode 27.0 - Runner target, Release configuration */
CODE_SIGN_STYLE = Manual;
DEVELOPMENT_TEAM = ABCDE12345;
"CODE_SIGN_IDENTITY[sdk=iphoneos*]" = "Apple Distribution";
"PROVISIONING_PROFILE_SPECIFIER[sdk=iphoneos*]" = "MyApp AppStore";
```

Repita para a configuração `Profile` se você arquiva builds de profile. Depois remova todos os argumentos de assinatura do comando e arquive normalmente:

```bash
# Flutter 3.44.8
flutter build ipa --release
```

Quando movi as mesmas quatro configurações da linha de comando para o target `Runner`, os erros dos packages desapareceram e só restou o erro esperado "No profile ... found" para o `Runner`. Minha máquina de teste não tem um profile de distribuição, então o repro termina aí, mas esse erro restante é o normal que você recebe apenas para o `Runner` quando o profile indicado não está instalado.

O `flutter build ipa` não adiciona substituições de assinatura por conta própria. No Flutter 3.44.8, o `build_ios.dart` lê as build settings resolvidas do `Runner` depois do archive. Se `CODE_SIGN_STYLE` é `Manual` e tanto `PROVISIONING_PROFILE_SPECIFIER` quanto `DEVELOPMENT_TEAM` estão definidos, ele encontra o profile instalado correspondente e gera um `ExportOptions.plist` com `signingStyle` `manual` e uma entrada em `provisioningProfiles` para o seu bundle ID. Se precisar de controle total, por exemplo em um app com extensões, passe seu próprio arquivo:

```bash
# Flutter 3.44.8
flutter build ipa --release --export-options-plist=ios/ExportOptions.plist
```

```xml
<!-- ios/ExportOptions.plist, Xcode 27.0 -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store-connect</string>
  <key>signingStyle</key>
  <string>manual</string>
  <key>teamID</key>
  <string>ABCDE12345</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>com.example.myapp</key>
    <string>MyApp AppStore</string>
  </dict>
</dict>
</plist>
```

Liste em `provisioningProfiles` apenas os bundle IDs do app e das extensões do app. Frameworks e bundles de plugins nunca recebem uma entrada.

## Correção 2: no fastlane, altere o projeto, não a linha de comando

A versão fastlane do padrão ruim é `build_app(xcargs: "PROVISIONING_PROFILE_SPECIFIER=...")`, e `xcargs` é exatamente a camada de linha de comando. Use `update_code_signing_settings` com `targets:` para que a configuração seja gravada apenas no `Runner`, e depois compile sem `xcargs` de assinatura:

```ruby
# fastlane 2.x, Flutter 3.44.8, Xcode 27.0
lane :release do
  update_code_signing_settings(
    path: "ios/Runner.xcodeproj",
    use_automatic_signing: false,
    targets: ["Runner"],
    build_configurations: ["Release"],
    team_id: "ABCDE12345",
    code_sign_identity: "Apple Distribution",
    sdk: "iphoneos*",
    profile_name: "MyApp AppStore"
  )
  build_app(
    workspace: "ios/Runner.xcworkspace",
    scheme: "Runner",
    configuration: "Release",
    export_method: "app-store",
    export_options: {
      provisioningProfiles: { "com.example.myapp" => "MyApp AppStore" }
    }
  )
end
```

O parâmetro `targets` assume por padrão todos os targets do projeto. Os bundles dos plugins não estão em `Runner.xcodeproj`, então omiti-lo não reproduziria o erro, mas nomear o target evita que uma futura extensão ou target de testes receba o profile errado.

## Correção 3: mude o archive para assinatura automática

Se você não precisa de um profile específico, deixe o Xcode gerenciá-lo. Mantenha `CODE_SIGN_STYLE = Automatic` no `Runner` e deixe o `xcodebuild` buscar ou criar profiles com uma chave de API do App Store Connect:

```bash
# Xcode 27.0
xcodebuild -workspace ios/Runner.xcworkspace -scheme Runner -configuration Release \
  -destination 'generic/platform=iOS' -archivePath build/Runner.xcarchive archive \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$ASC_KEY_PATH" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID"
```

Os targets de bundle dos packages não precisam de assinatura nesse modo, então passam na validação sem nenhum trabalho extra. O custo é que a máquina de CI precisa da chave de API e cria profiles por conta própria, o que alguns processos de release não permitem.

## Soluções alternativas que parecem certas, mas não são

- **`CODE_SIGNING_ALLOWED=NO` na linha de comando.** Ele também atinge o `Runner`, então você obtém um archive sem assinatura que o `-exportArchive` não consegue transformar em um IPA enviável.
- **Configurações condicionais na linha de comando.** `"PROVISIONING_PROFILE_SPECIFIER[sdk=iphoneos*]=MyApp AppStore"` não é interpretado como condicional. No Xcode 27.0 o valor resultou em `iphoneos*]=MyApp AppStore` e o `Runner` falhou com "No profile ... matching 'iphoneos*]=MyApp AppStore' found". Condições só funcionam em arquivos de projeto e arquivos xcconfig.
- **`-xcconfig` ou `XCODE_XCCONFIG_FILE`.** Ambos aplicam o arquivo como uma substituição para a build inteira, então um profile nesse arquivo chega aos targets dos packages exatamente como um argumento `NAME=value`.
- **Desativar o SwiftPM de novo.** `enable-swift-package-manager: false` mais o antigo hook `post_install` faz o erro sumir, mas só trazendo o CocoaPods de volta. Isso ganha tempo, não é uma correção, e o trunk do CocoaPods passa a ser somente leitura em 2 de dezembro de 2026.

## Erros parecidos vindos da mesma linha de comando

Omitir o profile mas manter as outras substituições apenas muda o erro. Com `CODE_SIGN_STYLE=Manual` e `CODE_SIGN_IDENTITY` na linha de comando e sem time, o Xcode 27.0 reporta `Signing for "url_launcher_ios_url_launcher_ios" requires a development team` para cada bundle. Adicione `DEVELOPMENT_TEAM` e ele vira `No signing certificate "iOS Distribution" found` nos mesmos targets de bundle. Os três têm a mesma causa e a mesma correção: nenhuma configuração de assinatura na linha de comando.

Uma mensagem diferente, `exportArchive: SomeKit.framework does not support provisioning profiles`, vem da etapa de export, não do archive. Significa que seu `ExportOptions.plist` (ou o `export_options` do fastlane) mapeia o bundle ID de um framework para um profile. Remova essa entrada. Apenas o app e suas extensões pertencem a ela.

Se o archive passa da assinatura e depois falha nos deployment targets, esse é o mínimo de iOS 15 do Xcode 27, não um problema de assinatura. A versão dessa falha do lado do CocoaPods é tratada em [o post sobre conflitos de versão do CocoaPods em builds Flutter iOS](/pt-br/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/).

## Relacionados

- [Migrate a Flutter iOS app from CocoaPods to Swift Package Manager](/pt-br/2026/10/migrate-a-flutter-ios-app-from-cocoapods-to-swift-package-manager/) cobre a migração que remove o hook do `Podfile`, incluindo como mover outra lógica `post_install` personalizada.
- [Flutter 3.44 makes SwiftPM the default](/pt-br/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/) explica por que apps atualizados para a 3.44 mudaram sem nenhuma alteração do seu lado.
- [Fix: Unable to find a destination matching the provided destination specifier](/pt-br/2026/08/fix-unable-to-find-a-destination-matching-the-provided-destination-specifier-in-a-flutter-ios-build/) é outra falha de build iOS causada por configurações remanescentes da era CocoaPods.
- [Fix: the provisioning profile doesn't include the currently selected device](/pt-br/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/) trata do lado de registro de dispositivos no provisionamento, do ponto de vista do .NET MAUI.

## Fontes

- [Swift Package Manager for app developers](https://docs.flutter.dev/packages-and-plugins/swift-package-manager/for-app-developers), documentação do Flutter.
- [Build and release an iOS app](https://docs.flutter.dev/deployment/ios), documentação do Flutter (`flutter build ipa` e `--export-options-plist`).
- [`build_ios.dart` in flutter_tools](https://github.com/flutter/flutter/blob/stable/packages/flutter_tools/lib/src/commands/build_ios.dart), a geração do ExportOptions para assinatura manual.
- [update_code_signing_settings](https://docs.fastlane.tools/actions/update_code_signing_settings/), documentação do fastlane.
- [Apple Developer Forums thread 700327](https://developer.apple.com/forums/thread/700327), o mesmo erro para dependências nativas de Swift package em um archive de CI com assinatura manual, e como sua aplicação mudou entre o Xcode 13 e o 14.
- [Apple Developer Forums thread 726714](https://developer.apple.com/forums/thread/726714), a variante do CocoaPods, levantada para cada target do projeto `Pods`.
