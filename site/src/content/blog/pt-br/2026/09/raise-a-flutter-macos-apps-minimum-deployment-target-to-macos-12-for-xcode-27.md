---
title: "Eleve o deployment target mínimo de um app Flutter para macOS ao macOS 12 para o Xcode 27"
description: "O Xcode 27 se recusa a compilar qualquer coisa abaixo do macOS 12, e o Flutter 3.47 moveu o próprio piso de 10.15 para 12.0. O que a migração automática reescreve, os três lugares que ela ignora em silêncio (valores personalizados, overrides no post_install do Podfile, podspecs de plugins) e uma correção no Podfile para equipes ainda no Flutter 3.44."
pubDate: 2026-09-18
updatedDate: 2026-09-18
template: migration
tags:
  - "migration"
  - "flutter"
  - "macos"
  - "xcode"
  - "cocoapods"
lang: "pt-br"
translationOf: "2026/09/raise-a-flutter-macos-apps-minimum-deployment-target-to-macos-12-for-xcode-27"
translatedBy: "claude"
translationDate: 2026-09-18
---

Para a maioria dos apps Flutter para macOS, isso é um trabalho de cinco minutos: atualize para o Flutter 3.47 ou posterior (3.47.4 é o stable atual, Dart 3.13.3), execute `flutter build macos` uma vez e faça commit das três linhas que a ferramenta reescreve em `macos/Runner.xcodeproj/project.pbxproj`, mais a linha `platform :osx` em `macos/Podfile`. A migração só reconhece os valores padrão exatos que o Flutter já gerou algum dia (10.11, 10.13, 10.14, 10.15, 11.0), então um projeto que alguém editou à mão para `11.5` ou `10.14.6`, um bloco `post_install` no Podfile que fixa os pods em uma versão antiga ou um podspec de plugin desatualizado vão sobreviver a ela e depois falhar no Xcode 27 com `The macOS deployment target 'MACOSX_DEPLOYMENT_TARGET' is set to ..., but the range of supported deployment target versions is 12.0 to 27.0.x`. Tudo abaixo foi verificado em um Mac com Xcode 26.6, Flutter 3.44.8 e 3.47.4, e CocoaPods 1.17.0.

## Por que o piso mudou

A Apple elevou o deployment target mínimo do macOS no Xcode 27 do macOS 11 para o macOS 12 (o iOS continua em 15, o watchOS vai de 8 para 9). O Xcode 27 chegou à disponibilidade geral em meados de setembro de 2026, então imagens de CI e máquinas de desenvolvedores estão migrando agora mesmo. Abaixo do piso, o Xcode 27 não emite um aviso e ajusta o valor como as versões anteriores faziam: ele interrompe o build com um erro de integridade do target.

A política do Flutter é [acompanhar o intervalo de deployment do Xcode atual](https://flutter.dev/go/match-xcode-deployment-range), então a equipe abriu a [flutter/flutter#187762](https://github.com/flutter/flutter/issues/187762) e integrou a [flutter/flutter#188520](https://github.com/flutter/flutter/pull/188520) (merge em 2026-06-29), que chega no 3.47.0. Ela faz três coisas:

- `FlutterDarwinPlatform.macos.deploymentTarget()` em `flutter_tools` agora retorna `12.0` em vez de `10.15`. Esse valor alimenta o pacote SwiftPM gerado, os templates de plugin e o podspec do `FlutterMacOS`.
- O `FlutterMacOS.framework` do engine é compilado para o macOS 12. No meu build com 3.44.8, o `LC_BUILD_VERSION` dele diz `minos 11.0`; no build com 3.47.4, diz `minos 12.0`.
- `MacOSDeploymentTargetMigration` e `podhelper.rb` foram atualizados para mover projetos existentes para `12.0`.

O segundo ponto importa mesmo que você nunca instale o Xcode 27. Um app com Flutter 3.47 que ainda declara suporte ao macOS 11 está fazendo uma promessa que o binário do engine não consegue cumprir.

## O que quebra

| Área | Mudança | Gravidade |
| ---- | ------ | -------- |
| `MACOSX_DEPLOYMENT_TARGET` abaixo de 12.0 no `Runner` | Erro de build no Xcode 27 | alta, migrado automaticamente para valores padrão |
| `platform :osx` abaixo de 12.0 em `macos/Podfile` | Pods compilados para a versão antiga, erro no Xcode 27 | alta, migrado automaticamente para valores padrão |
| `post_install` no Podfile que define `MACOSX_DEPLOYMENT_TARGET` nos pods | Os overrides sobrevivem à migração, erro no Xcode 27 | alta, correção manual |
| Podspec ou `Package.swift` de plugin declarando abaixo de 12.0 | Tratado pelo `podhelper.rb` (3.47+) e pelo pacote SwiftPM gerado | baixa para autores de apps, limpeza para autores de plugins |
| Usuários no macOS 10.15 e 11 | Não conseguem instalar novos builds (`LSMinimumSystemVersion` passa a ser 12.0) | decisão de produto |

A última linha é a única que não é um problema de build. `macos/Runner/Info.plist` define `LSMinimumSystemVersion` como `$(MACOSX_DEPLOYMENT_TARGET)`, então no momento em que a configuração de build muda, a App Store e os atualizadores no estilo Sparkle deixam de oferecer sua nova versão para máquinas com Catalina e Big Sur. Confira seus dados de analytics antes de publicar e avise o suporte.

## Checklist antes de começar

- Flutter 3.47.0 ou posterior em todas as máquinas e runners de CI que compilam o target macOS. `flutter --version` deve exibir `3.47.x` ou mais recente.
- Uma árvore de trabalho limpa em `macos/`, para que o diff da migração possa ser revisado isoladamente.
- CocoaPods 1.16 ou posterior se você ainda usa CocoaPods para plugins macOS (aqui foi usado o 1.17.0).
- Uma lista de todos os lugares em que seu repositório define uma versão do macOS. Este comando de uma linha encontra todos:

```bash
# Flutter 3.47.4, run from the project root
grep -rnE "MACOSX_DEPLOYMENT_TARGET|platform :osx|osx.deployment_target|\.macOS\(" \
  macos/ --include='*.pbxproj' --include='Podfile' --include='*.xcconfig' \
  --include='*.podspec' --include='Package.swift'
```

## Passos da migração

1. Atualize o SDK com `flutter upgrade` (ou fixe o 3.47.4 na sua configuração do FVM ou de CI) e depois execute `flutter clean`. Verifique com `flutter --version` que a ferramenta informa 3.47.x ou mais recente.
2. Execute `flutter build macos --debug` uma vez. A ferramenta roda `MacOSDeploymentTargetMigration` antes do `pod install` e exibe `Updating minimum macOS deployment target to 12.0.` exatamente uma vez. Verifique com `git diff --stat macos/` que `project.pbxproj` e `Podfile` mudaram.
3. Rode de novo o grep do checklist inicial e confirme que não sobrou nada abaixo de 12.0 em `Runner`, `RunnerTests`, targets adicionais, arquivos `.xcconfig` ou no Podfile. Corrija à mão tudo o que a migração ignorou (detalhes abaixo).
4. Remova ou atualize qualquer bloco `post_install` do Podfile que escreva `MACOSX_DEPLOYMENT_TARGET` nos targets dos pods e depois execute `flutter build macos --debug` novamente. Verifique com `grep MACOSX_DEPLOYMENT_TARGET macos/Pods/Pods.xcodeproj/project.pbxproj | sort | uniq -c` que todas as entradas são 12.0 ou superiores.
5. Confira o binário gerado: `plutil -p` no `Contents/Info.plist` do app compilado deve mostrar `LSMinimumSystemVersion => 12.0`, e `otool -l` no executável deve mostrar `minos 12.0`.
6. Mude o CI para uma imagem com Xcode 27 e execute um build de release (`flutter build macos --release`). Este é o único passo que prova que o projeto compila no Xcode 27.

## O que a migração realmente reescreve

Em um projeto criado pelo Flutter 3.44.8 (que gera 10.15 em todo lugar), com `url_launcher` adicionado e CocoaPods habilitado, o primeiro build com 3.47.4 exibiu a linha de status e produziu exatamente este diff nos dois arquivos que ele controla:

```diff
# macos/Podfile (Flutter 3.47.4 migration)
-platform :osx, '10.15'
+platform :osx, '12.0'

# macos/Runner.xcodeproj/project.pbxproj (Debug, Release, Profile)
-				MACOSX_DEPLOYMENT_TARGET = 10.15;
+				MACOSX_DEPLOYMENT_TARGET = 12.0;
```

O build então teve sucesso e todo `MACOSX_DEPLOYMENT_TARGET` em `Pods.xcodeproj` estava em 12.0, embora o `url_launcher_macos` 3.2.6 ainda declare `s.platform = :osx, '10.15'` no seu podspec. É o `podhelper.rb` em ação: `flutter_additional_macos_build_settings` remove o deployment target próprio do pod quando a versão major dele está abaixo de 12, de modo que o pod herda a plataforma do Podfile. Antes do 3.47 o corte era 10.15, então um pod que declarava 10.15 mantinha o seu valor, e é isso que faz projetos com Flutter 3.44 falharem no Xcode 27 mesmo depois de você editar o target Runner (veja a última seção).

Com SwiftPM (o padrão desde o Flutter 3.44 para projetos sem o opt-out), a migração também move o target Runner, e a ferramenta regenera `macos/Flutter/ephemeral/Packages/FlutterGeneratedPluginSwiftPackage/Package.swift` a partir do `MACOSX_DEPLOYMENT_TARGET` do Runner. Na minha execução ele passou de `.macOS("10.15")` para `.macOS("12.0")` no primeiro build com 3.47.4. O `Package.swift` dentro do `url_launcher_macos` ainda diz `.macOS("10.15")`; no Xcode 26.6 isso compilou sem problemas. Não consegui rodar o Xcode 27 nesta máquina, então não verifiquei se manifests de plugins abaixo de 12.0 também compilam sem problemas lá.

## Pegadinha 1: uma versão editada à mão é invisível para a migração

O migrador é uma substituição de strings linha a linha. Pelo `macos_deployment_target_migration.dart` na tag `3.47.4`, ele procura estas strings literais e nada mais:

```dart
// flutter_tools 3.47.4, lib/src/macos/migrations/macos_deployment_target_migration.dart
const deploymentTargetOriginal1015 = 'MACOSX_DEPLOYMENT_TARGET = 10.15;';
const deploymentTargetOriginal110 = 'MACOSX_DEPLOYMENT_TARGET = 11.0;';
const podfilePlatformVersionOriginal1015 = "platform :osx, '10.15'";
const podfilePlatformVersionOriginal110 = "platform :osx, '11.0'";
// ...plus 10.11, 10.13 and 10.14 in both forms
```

Então `11.5`, `10.14.6`, `11.0.1`, um valor definido em um `.xcconfig` ou `platform :osx, "10.15"` com aspas duplas ficam todos intactos, sem nenhuma mensagem. Defini o target Runner e o Podfile como 11.5 e compilei com 3.47.4. Não apareceu nenhuma linha `Updating minimum macOS deployment target`, o `git status` não mostrou mudanças em nenhum dos dois arquivos e o build ainda teve sucesso no Xcode 26.6, com avisos do linker que passam facilmente despercebidos na rolagem:

```text
ld: warning: building for macOS-11.5, but linking with dylib
'@rpath/FlutterMacOS.framework/Versions/A/FlutterMacOS' which was built for newer version 12.0
```

O app resultante tem `LSMinimumSystemVersion` 11.5 e `minos 11.5`, enquanto distribui um engine compilado para 12.0. No Xcode 27, o mesmo projeto falha de cara. A correção é definir o valor à mão no Xcode (projeto Runner, target Runner, General, Minimum Deployments) ou no arquivo:

```bash
# Flutter 3.47.4 project, replace any leftover value below 12.0
sed -i '' -E 's/MACOSX_DEPLOYMENT_TARGET = (10\.[0-9.]+|11\.[0-9.]+);/MACOSX_DEPLOYMENT_TARGET = 12.0;/' \
  macos/Runner.xcodeproj/project.pbxproj
sed -i '' -E "s/platform :osx, ['\"][0-9.]+['\"]/platform :osx, '12.0'/" macos/Podfile
```

Elevar a plataforma do Podfile importa tanto quanto o target Runner. Quando deixei o Runner em 10.14.6 e o Podfile em 11.5, até o Xcode 26.6 parou com `compiling for macOS 10.14.6, but module 'url_launcher_macos' has a minimum deployment target of macOS 11.5` em `GeneratedPluginRegistrant.swift`. Mantenha os dois sincronizados.

## Pegadinha 2: overrides no post_install do Podfile sobrevivem

Um copia-e-cola comum da época do Xcode 14 força todos os pods para uma única versão:

```ruby
# macos/Podfile, a pattern that breaks on Xcode 27
post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_macos_build_settings(target)
    target.build_configurations.each do |config|
      config.build_settings['MACOSX_DEPLOYMENT_TARGET'] = '10.14'
    end
  end
end
```

A migração alterou a linha `platform :osx` desse Podfile e exibiu sua mensagem de status, então parece concluída. Depois do build, `Pods.xcodeproj` continha 15 entradas `MACOSX_DEPLOYMENT_TARGET = 10.14;` e apenas 3 em 12.0: o override roda depois de `flutter_additional_macos_build_settings` e prevalece. O Xcode 26.6 compilou esses pods silenciosamente para o macOS 11.0 (o próprio piso dele), e é por isso que ninguém percebe. O Xcode 27, em vez disso, gera erro em cada um deles.

Apague o loop interno. Se um pod realmente precisar de uma versão fixa, fixe-a em `12.0` ou superior, nunca abaixo da plataforma do Podfile.

## Pegadinha 3: o erro guiado só existe a partir do 3.47

Quando o Xcode rejeita o target, o Flutter 3.47 reconhece a linha (a lógica de correspondência veio na [flutter/flutter#188812](https://github.com/flutter/flutter/pull/188812), a partir da [flutter/flutter#187855](https://github.com/flutter/flutter/issues/187855)) e exibe uma mensagem em caixa:

```text
The macOS deployment target is too low. Xcode requires at least 12.0.

To upgrade your macOS deployment target, follow these steps:
  1. Open the project in Xcode:
     open macos/Runner.xcworkspace
  2. Select the "Runner" project in the project navigator.
  3. Select the "Runner" TARGET, and in the "General" tab:
     Update "Minimum Deployments" to at least 12.0.
```

Duas ressalvas. A mensagem só aparece quando a linha com falha menciona `MACOSX_DEPLOYMENT_TARGET` e o intervalo suportado, e o conselho só cobre o target Runner, então, para uma falha em um target de pod (Pegadinha 2), a correção sugerida não é a que você precisa. E o Flutter 3.44 e anteriores não têm esse tratamento: você recebe `Build process failed` mais a linha crua do Xcode, que nos fixtures de teste desse PR diz `error: The macOS deployment target 'MACOSX_DEPLOYMENT_TARGET' is set to 10.11, but the range of supported deployment target versions is 12.0 to 27.0.x. (in target 'Runner' from project 'Runner')`. O sufixo `(in target '...')` diz qual target corrigir.

## Continuando no Flutter 3.44 com o Xcode 27

Às vezes você não consegue fazer um upgrade do Flutter nesta semana, mas sua imagem de CI já migrou para o Xcode 27. Você pode atualizar o projeto à mão, mas o `podhelper.rb` do 3.44 só remove deployment targets de pods abaixo de 10.15, então pods que declaram de 10.15 a 11.x mantêm seus valores. Em um projeto 3.44.8 com o Runner e o Podfile editados para 12.0, `Pods.xcodeproj` ainda tinha 9 entradas em `10.15`. Esta adição ao `post_install` removeu todas, deixando cada pod no 12.0 herdado:

```ruby
# macos/Podfile, Flutter 3.44.x workaround for Xcode 27
post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_macos_build_settings(target)
    target.build_configurations.each do |config|
      pod_target = config.build_settings['MACOSX_DEPLOYMENT_TARGET']
      if pod_target && Gem::Version.new(pod_target) < Gem::Version.new('12.0')
        config.build_settings.delete 'MACOSX_DEPLOYMENT_TARGET'
      end
    end
  end
end
```

Apagar em vez de sobrescrever é o mesmo truque que o Flutter 3.47 usa: o pod herda o valor mais alto do projeto, e um pod que realmente exige algo mais novo que 12.0 mantém o seu próprio requisito. O framework do engine no 3.44 é compilado para o macOS 11, então isso não muda onde seu binário pode rodar, apenas satisfaz o Xcode 27. Remova o bloco quando estiver no 3.47, já que ele se torna redundante.

## Para autores de plugins

Se você publica um plugin para macOS, atualize o podspec (`s.platform = :osx, '12.0'` ou `s.osx.deployment_target = '12.0'`) e a plataforma do `Package.swift` (`.macOS("12.0")`) na sua próxima versão, e eleve sua restrição `environment: flutter:` para `>=3.47.0` se você depender de algo dessa versão. Apps no 3.47 já estão protegidos pelo `podhelper.rb`, então isso é higiene e não uma emergência, mas evita que seu plugin apareça no `grep` de alguém como falso positivo, e os templates de plugin do 3.47 já geram 12.0 de qualquer forma.

## Verificação

- `flutter build macos --release` tem sucesso em um runner com Xcode 27.
- `grep -rn MACOSX_DEPLOYMENT_TARGET macos/ --include='*.pbxproj' --include='*.xcconfig'` não mostra nada abaixo de 12.0, incluindo `macos/Pods/Pods.xcodeproj/project.pbxproj`.
- `plutil -p build/macos/Build/Products/Release/<App>.app/Contents/Info.plist | grep LSMinimumSystemVersion` exibe `12.0`.
- O log de build não tem avisos `building for macOS-11.x, but linking with dylib ... built for newer version 12.0`.
- O app abre na versão mais antiga do macOS em que você ainda testa (12.x, se você tiver uma máquina ou VM para isso).

## Plano de rollback

A mudança no código-fonte é reversível com `git revert`, mas o SDK do Flutter não é: no 3.47 e posteriores o engine é compilado para o macOS 12, e a ferramenta vai executar a migração novamente no próximo build sempre que encontrar um valor padrão abaixo de 12.0. Voltar a dar suporte ao macOS 10.15 ou 11 significa ficar no Flutter 3.44.x e no Xcode 26, que a Apple vai deixar de aceitar para envios à App Store quando passar a exigir o SDK do macOS 27. Trate isso como um caminho sem volta e tome a decisão sobre o suporte ao macOS 11 de forma explícita antes do merge.

## Relacionados

- O lado Android do mesmo upgrade para o 3.47: [migrando um projeto Flutter Android para o AGP 9 com Kotlin integrado](/pt-br/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/).
- O que mais mudou para desktop nessa versão: [o Flutter 3.47 torna o Impeller o renderizador padrão no desktop](/pt-br/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/).
- Por que seu projeto pode estar no SwiftPM sem que você tenha escolhido: [o Flutter 3.44 adota o SwiftPM como padrão](/pt-br/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).
- Quando o problema do Podfile é resolução de versões, e não deployment targets: [corrigindo "CocoaPods could not find compatible versions for pod"](/pt-br/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/).
- A rodada anterior disso no iOS: [corrigindo "Failed to build iOS app" com Xcode 16 e Flutter 3.x](/pt-br/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/).

## Fontes

- [flutter/flutter#187762: Increase macOS minimum supported version from 10.15 to 12 to support Xcode 27](https://github.com/flutter/flutter/issues/187762)
- [flutter/flutter#188520: a mudança no SDK, nos templates, no podhelper e na migração](https://github.com/flutter/flutter/pull/188520)
- [flutter/flutter#188812: mensagem guiada quando a versão mínima é baixa demais](https://github.com/flutter/flutter/pull/188812)
- [`macos_deployment_target_migration.dart` no 3.47.4](https://github.com/flutter/flutter/blob/3.47.4/packages/flutter_tools/lib/src/macos/migrations/macos_deployment_target_migration.dart)
- [`podhelper.rb` no 3.47.4](https://github.com/flutter/flutter/blob/3.47.4/packages/flutter_tools/bin/podhelper.rb)
- [Notas de versão do Flutter 3.47.0](https://docs.flutter.dev/release/release-notes/release-notes-3.47.0)
- [Notas de versão do Xcode 27](https://developer.apple.com/go/?id=xcode-27-sdk-rn)
