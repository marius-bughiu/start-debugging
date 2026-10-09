---
title: "Migre um app Flutter iOS do CocoaPods para o Swift Package Manager (Flutter 3.44 a 3.47)"
description: "O Flutter 3.44 tornou o Swift Package Manager o padrão para iOS e macOS, mas um app existente continua com o CocoaPods até você removê-lo. Como verificar quais plugins já suportam SwiftPM, deixar a ferramenta migrar o projeto Xcode, excluir o Podfile com segurança, lidar com plugins somente com pods e lógica personalizada no Podfile, e fazer rollback se precisar."
pubDate: 2026-10-09
updatedDate: 2026-10-09
template: migration
tags:
  - "migration"
  - "flutter"
  - "ios"
  - "swiftpm"
  - "cocoapods"
  - "xcode"
lang: "pt-br"
translationOf: "2026/10/migrate-a-flutter-ios-app-from-cocoapods-to-swift-package-manager"
translatedBy: "claude"
translationDate: 2026-10-09
---

Se o seu app Flutter foi criado antes do Flutter 3.44, ele ainda tem um `Podfile`, um diretório `Pods/` e linhas `#include` do CocoaPods nos arquivos xcconfig, mesmo que o Swift Package Manager (SwiftPM) seja o padrão desde o 3.44. Atualizar o Flutter faz apenas metade da migração. O primeiro `flutter build ios` ou `flutter run` adiciona o pacote SwiftPM ao seu projeto Xcode, mas não remove o CocoaPods. Isso fica por sua conta, e só depois que todos os plugins que você usa trouxerem um `Package.swift`. Para um app típico com 5 a 15 plugins, leva cerca de 30 minutos. O que costuma quebrar é um `Podfile` editado à mão (lógica `post_install` personalizada, macros de pré-processador, pods extras) e plugins que ainda são somente com pods. Faça isso agora: o trunk do CocoaPods passa a ser somente leitura em 2026-12-02. Tudo abaixo foi testado com Flutter 3.44.8, Xcode 27.0 e CocoaPods 1.17.0, e conferido com a versão estável atual, Flutter 3.47.6.

## Por que remover o CocoaPods em vez de deixá-lo por aí

- **Chega de Ruby na máquina de build.** Quando não sobra nenhum pod, o `flutter build ios` deixa de executar `pod install`, então o CI não precisa mais de Ruby, da gem `cocoapods` nem do workaround `LANG=en_US.UTF-8`.
- **Builds mais rápidos.** O `flutter_tools` diz isso diretamente: "Removing CocoaPods integration will improve the project's build time." As fases de script `[CP] Embed Pods Frameworks` e `[CP] Copy Pods Resources` somem de todo build.
- **O trunk do CocoaPods congela.** Ele se torna somente leitura de forma permanente em 2026-12-02. Os pods que já existem continuam sendo resolvidos, mas nenhum plugin poderá publicar um podspec corrigido depois disso. Qualquer plugin ainda no CocoaPods é um plugin cujo lado iOS está congelado.
- **Plugins somente com pods estão avisados.** O Flutter 3.44+ informa que um plugin somente com pods "will become an error in a future version of Flutter", e o pub.dev agora reduz a pontuação de pacotes sem suporte a SwiftPM.

## O que muda no projeto

| Área | Mudança | Gravidade |
| --- | --- | --- |
| `ios/Runner.xcodeproj/project.pbxproj` | `FlutterGeneratedPluginSwiftPackage` adicionado como dependência de pacote local do `Runner` (automático) | baixa |
| `Runner.xcscheme` | Pré-ação de build "Run Prepare Flutter Framework Script" adicionada (automático, por scheme) | baixa |
| `ios/Podfile`, `Podfile.lock`, `Pods/`, `.symlinks/` | Excluídos por você | média |
| `ios/Flutter/Debug.xcconfig`, `Release.xcconfig` | Linhas `#include? "Pods/..."` removidas por você | média |
| Lógica personalizada no `Podfile` | Hooks `post_install`, `GCC_PREPROCESSOR_DEFINITIONS` e pods que não são do Flutter precisam ir para outro lugar | alta |
| Plugins somente com pods | Forçam o CocoaPods a permanecer; o `Podfile` é regenerado se você o excluir | alta |
| Versão mínima do iOS | Plugins SwiftPM podem declarar um mínimo maior que o do seu target `Runner` | média |

## Checklist de pré-voo

1. Flutter 3.44 ou mais recente (`flutter --version`). O SwiftPM era opt-in desde o 3.24, mas é no 3.44 que a migração automática e os avisos abaixo vêm ativados por padrão.
2. Xcode 15 ou mais recente. O `flutter_tools` recusa o SwiftPM em versões mais antigas do Xcode.
3. Uma árvore de trabalho limpa, para que o diff do `project.pbxproj` e do scheme possa ser revisado e revertido.
4. SwiftPM não desabilitado. Verifique se `flutter config --list` não mostra `enable-swift-package-manager: false` e se o `pubspec.yaml` não tem `config: enable-swift-package-manager: false` sob `flutter:`. Versões anteriores, quando o SwiftPM ainda era opt-in, documentavam uma chave diferente, `disable-swift-package-manager: true`, diretamente sob `flutter:`. Remova-a se algum colega a adicionou naquela época.
5. Se você usa flavors, anote o nome de cada scheme. A pré-ação é adicionada por scheme.

## Passos da migração

1. **Atualize os plugins primeiro.** Muitos plugins adicionaram `Package.swift` em uma versão minor, e um lockfile antigo mantém você na versão somente com pods. Execute `flutter pub upgrade` e, para qualquer coisa fixada no `pubspec.yaml`, `flutter pub outdated`. Verifique com `git diff pubspec.lock` que as implementações iOS dos plugins (`*_ios`, `*_darwin`, `*_foundation`, `*_apple`) avançaram.

2. **Liste quais plugins estão no SwiftPM e quais não estão.** O `flutter_tools` decide isso com uma checagem de arquivo: um plugin suporta SwiftPM se `ios/<plugin_name>/Package.swift` existir no pacote dele (ou `darwin/<plugin_name>/Package.swift` para plugins que compartilham código de iOS e macOS). A ferramenta lê os caminhos dos plugins a partir de `.flutter-plugins-dependencies`, então você pode executar a mesma checagem por conta própria antes de tocar no projeto Xcode:

   ```bash
   #!/usr/bin/env bash
   # Flutter 3.44+, run from the app root after `flutter pub get`. Needs jq.
   jq -r '.plugins.ios[] | [.name, .path, (if .shared_darwin_source then "darwin" else "ios" end)] | @tsv' \
     .flutter-plugins-dependencies |
   while IFS=$'\t' read -r name path dir; do
     base="${path%/}/$dir"
     if [ -f "$base/$name/Package.swift" ]; then echo "swiftpm    $name"
     elif [ -f "$base/$name.podspec" ];     then echo "pods-only  $name"
     else                                       echo "dart-only  $name"
     fi
   done
   ```

   Em um app de teste com dez plugins comuns, foi isto que ele imprimiu:

   ```text
   swiftpm    audioplayers_darwin
   swiftpm    device_info_plus
   swiftpm    flutter_contacts
   swiftpm    flutter_secure_storage_darwin
   pods-only  flutter_tts
   swiftpm    geolocator_apple
   swiftpm    image_gallery_saver_plus
   swiftpm    package_info_plus
   dart-only  path_provider_foundation
   swiftpm    vibration
   ```

   `dart-only` significa que o plugin não tem nenhum código nativo de iOS (o `path_provider_foundation` 2.6.0 conversa com o Foundation via FFI), então nenhum dos gerenciadores de dependência está envolvido. Qualquer linha `pods-only` significa que você pode migrar o projeto Xcode, mas ainda não pode excluir o CocoaPods. Pule para o gotcha "Plugins somente com pods trazem o Podfile de volta" mais abaixo.

3. **Deixe o Flutter migrar o projeto Xcode.** Execute um build de verdade, não um apenas de configuração:

   ```bash
   # Flutter 3.44.8, Xcode 27.0
   flutter build ios --simulator --debug
   ```

   No meu teste, `flutter build ios --config-only` executou `pod install` e regenerou o pacote SwiftPM em `ios/Flutter/ephemeral/Packages/`, mas não tocou no `project.pbxproj` nem no scheme. A integração com o projeto Xcode acontece logo antes de o `xcodebuild` rodar. Verifique:

   ```bash
   grep -c FlutterGeneratedPluginSwiftPackage ios/Runner.xcodeproj/project.pbxproj   # > 0
   grep "Run Prepare Flutter Framework Script" ios/Runner.xcodeproj/xcshareddata/xcschemes/*.xcscheme
   ```

   Se todos os plugins estiverem no SwiftPM, a saída do build agora termina com um checklist adaptado ao seu projeto:

   ```text
   All plugins found for ios are Swift Packages, but your project still has CocoaPods integration. To remove CocoaPods integration, complete the following steps:
     * In the ios/ directory run "pod deintegrate"
     * Also in the ios/ directory, delete the Podfile
     * Remove the include to "Pods/Target Support Files/Pods-Runner/Pods-Runner.debug.xcconfig" in your ios/Flutter/Debug.xcconfig
     * Remove the include to "Pods/Target Support Files/Pods-Runner/Pods-Runner.release.xcconfig" in your ios/Flutter/Release.xcconfig

   Removing CocoaPods integration will improve the project's build time.
   ```

   Se aparecer uma mensagem diferente, "Your project uses a non-standard Podfile and will need to be migrated to Swift Package Manager manually", o Flutter comparou o seu `Podfile` byte a byte com o template dele e encontrou edições. Leia o gotcha "Um Podfile personalizado precisa ser traduzido, não excluído" antes de continuar. Faça um commit neste ponto: o projeto agora compila com os dois gerenciadores, e este é o seu ponto de ancoragem para rollback.

4. **Desintegre o CocoaPods.**

   ```bash
   # CocoaPods 1.17.0
   cd ios
   pod deintegrate
   rm -rf Podfile Podfile.lock Pods .symlinks
   cd ..
   ```

   O `pod deintegrate` remove do `project.pbxproj` as fases de build `[CP]`, o link do `Pods_Runner.framework` e as referências xcconfig dos Pods. Verifique com `grep -c "\[CP\]" ios/Runner.xcodeproj/project.pbxproj`, que deve imprimir `0`.

5. **Remova os includes dos Pods dos arquivos xcconfig.** Ambos os arquivos começam com um include opcional que o `pod deintegrate` não toca:

   ```text
   // ios/Flutter/Debug.xcconfig, before
   #include? "Pods/Target Support Files/Pods-Runner/Pods-Runner.debug.xcconfig"
   #include "Generated.xcconfig"

   // after
   #include "Generated.xcconfig"
   ```

   Faça o mesmo no `Release.xcconfig` e em qualquer xcconfig por flavor que você tenha criado (`Debug-dev.xcconfig` e assim por diante). A forma `#include?` significa que um arquivo ausente é ignorado silenciosamente, então deixá-la lá não quebra o build. Mas o `flutter_tools` procura essa linha e continua imprimindo o checklist de remoção enquanto ela existir. Verifique com `grep -rn "Pods" ios/Flutter/*.xcconfig`, que não deve imprimir nada.

6. **Limpe a referência no workspace.** O `pod deintegrate` termina com "The workspace referencing the Pods project still remains." Abra `ios/Runner.xcworkspace/contents.xcworkspacedata` e exclua o elemento `<FileRef location = "group:Pods/Pods.xcodeproj">`, para que o Xcode pare de mostrar um projeto ausente em vermelho. Mantenha o próprio `Runner.xcworkspace`; o Flutter e o Xcode ainda abrem o app por meio dele.

7. **Recompile do zero.**

   ```bash
   # Flutter 3.44.8 / 3.47.6
   flutter clean
   flutter pub get
   flutter build ios --simulator --debug
   ```

   Verifique duas coisas na saída: não há nenhuma linha `Running pod install...`, e o `ios/Podfile` não foi recriado. Se o `Podfile` voltou, ainda há um plugin somente com pods no grafo.

8. **Atualize o CI.** Remova os passos `pod install`, `pod repo update`, configuração do Ruby e cache do CocoaPods. Faça cache de `~/Library/Developer/Xcode/DerivedData/<project>/SourcePackages` ou passe `-clonedSourcePackagesDirPath` ao `xcodebuild` se você compila direto pelo Xcode. Verifique executando o pipeline em uma imagem de runner sem a gem `cocoapods` instalada.

## Verificação

- `flutter build ios --release --no-codesign` é concluído com sucesso e não imprime nenhuma linha `pod install`.
- `flutter run` em um celular real funciona, incluindo o hot reload. Isso prova que a pré-ação preparou o `Flutter.framework` corretamente.
- No Xcode, todo scheme que você distribui tem a pré-ação "Run Prepare Flutter Framework Script" em Edit Scheme, Build, Pre-actions. Os schemes de flavor criados à mão são os que mais frequentemente não a têm.
- Cada plugin com código nativo funciona em runtime: peça uma permissão, abra uma URL, leia um valor do secure storage. Um plugin que compilou mas perdeu sua configuração falha aqui, não no build (veja o gotcha do `permission_handler`).
- O archive compila: `flutter build ipa` é concluído com sucesso e o envio passa na validação do App Store Connect, que é o primeiro lugar onde um recurso de plugin ou privacy manifest ausente apareceria.

## Fazendo rollback

Esta migração é reversível. Se você fez commit após o passo 3, um `git revert` do commit de desintegração mais `cd ios && pod install` restaura a configuração mista. Para sair do SwiftPM por completo, desative-o para o projeto inteiro no `pubspec.yaml`:

```yaml
# pubspec.yaml, Flutter 3.44+
flutter:
  config:
    enable-swift-package-manager: false
```

Depois remova `FlutterGeneratedPluginSwiftPackage` de Package Dependencies e de Frameworks, Libraries, and Embedded Content do target `Runner`, e exclua a pré-ação de cada scheme. Só desativar deixa a integração com o SwiftPM no arquivo de projeto, e o Flutter continua gerando um pacote vazio para ela. Trate a desativação como temporária, porque o suporte ao CocoaPods está em modo de manutenção e eventualmente vai acabar.

## Gotchas de uma migração real

### Plugins somente com pods trazem o Podfile de volta

Se um único plugin não tiver `Package.swift`, o Flutter roda em modo misto. Adicionei o `flutter_tts` 4.2.5 a um app totalmente migrado, sem `Podfile`, e o build seguinte imprimiu:

```text
The following plugins do not support Swift Package Manager for ios:
  - flutter_tts
This will become an error in a future version of Flutter. Please contact the plugin maintainers to request Swift Package Manager adoption.
Running pod install...
```

O Flutter regenerou o `ios/Podfile` a partir do template e recolocou as linhas `#include?` nos dois arquivos xcconfig. O modo misto compila normalmente, então isso não é uma emergência. Suas opções são trocar o plugin, incorporar o código iOS dele em um pacote local com um `Package.swift`, ou manter a configuração mista e checar o plugin de novo mais tarde. Não exclua o `Podfile` regenerado em loop; ele vai continuar voltando enquanto esse plugin estiver no `pubspec.lock`.

### O permission_handler ignora as macros do seu Podfile no SwiftPM

A configuração clássica do `permission_handler` coloca `PERMISSION_CAMERA=1` e similares em `GCC_PREPROCESSOR_DEFINITIONS` no bloco `post_install` do `Podfile`. No SwiftPM esse bloco não roda mais. A partir do `permission_handler_apple` 9.4.8, o manifesto do pacote habilita uma permissão quando a chave `NS*UsageDescription` correspondente existe no seu `Info.plist`. A 9.5.1 corrigiu a detecção para plists específicos de configuração de build e de flavor, e a 9.6.0 adicionou um `permission_handler.yaml` para permissões por flavor, então garanta que o seu lockfile resolva a 9.6.x. Duas consequências: uma permissão sem descrição de uso é removida na compilação e reporta `denied` em runtime em vez de falhar o build, e o manifesto fica em cache, então depois de alterar o `Info.plist` você precisa executar `rm -rf ~/Library/Developer/Xcode/DerivedData` uma vez. É por isso que a checagem em runtime da lista de verificação importa.

### Um Podfile personalizado precisa ser traduzido, não excluído

Procure três coisas no seu `Podfile` antes de excluí-lo. Pods que não são do Flutter (`pod 'GoogleMLKit/...'`, SDKs de analytics) precisam virar dependências de pacote Swift adicionadas pela aba Package Dependencies do Xcode no projeto `Runner`. Sobrescritas de build settings no `post_install` (`ENABLE_BITCODE`, `EXCLUDED_ARCHS`, deployment targets) afetavam apenas targets de pods, então a maioria pode simplesmente sumir. Macros de pré-processador consumidas por plugins precisam do equivalente SwiftPM do plugin, como no caso do `permission_handler` acima. Se você pular isso, o build geralmente ainda é concluído com sucesso e o recurso desaparece silenciosamente.

### Incompatibilidades de versão mínima do iOS

Um plugin SwiftPM pode declarar uma plataforma mais alta que a do seu app, o que falha com "The package product 'plugin_name_ios' requires minimum platform version 14.0 for the iOS platform, but this target supports 12.0". Aumente o Minimum Deployments no target `Runner` e execute `flutter build ios --config-only` para regenerar a configuração. No Xcode 27 há um segundo piso: ele rejeita qualquer deployment target de iOS abaixo de 15.0, e um projeto criado pelo Flutter 3.44.8 ainda diz 13.0. Esse erro atinge o projeto `Runner` e, no modo misto, todos os targets de pods. Para os pods, adicione uma sobrescrita ao bloco `post_install` depois de `flutter_additional_ios_build_settings(target)`:

```ruby
# ios/Podfile, Flutter 3.44.8 + Xcode 27.0, mixed mode only
target.build_configurations.each do |config|
  config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '15.0'
end
```

O macOS tem a sua própria versão desse problema, tratada em [aumentar o deployment target mínimo de um app Flutter macOS para macOS 12 por causa do Xcode 27](/pt-br/2026/09/raise-a-flutter-macos-apps-minimum-deployment-target-to-macos-12-for-xcode-27/).

### As antigas correções do StackOverflow deixam de valer

Fixar a versão de um pod no `Podfile` para resolver um conflito não faz nada quando esse plugin passa a ser resolvido pelo SwiftPM, porque o CocoaPods nunca o vê. Se você já brigou com [o erro "could not find compatible versions for pod" do CocoaPods](/pt-br/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/), exclua essas fixações ao migrar em vez de levá-las adiante.

### Módulos add-to-app são diferentes

Um módulo Flutter embutido em um app iOS nativo usa o próprio `Podfile` do módulo, que o `flutter_tools` deliberadamente não toca. Siga o guia de configuração de projeto add-to-app em vez dos passos acima.

## Relacionados

- A versão que mudou o padrão: [Flutter 3.44 torna o Swift Package Manager o padrão](/pt-br/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).
- Se o problema é o próprio Xcode e não o gerenciador de dependências, comece por [falha ao compilar um app iOS com Xcode 16 e Flutter 3.x](/pt-br/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/).
- Para distribuir a migração por várias versões do Flutter no CI sem quebrar branches mais antigas, veja [como atender várias versões do Flutter a partir de um único pipeline de CI](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).

## Fontes

- [Swift Package Manager for app developers](https://docs.flutter.dev/packages-and-plugins/swift-package-manager/for-app-developers) (docs.flutter.dev)
- [Swift Package Manager for plugin authors](https://docs.flutter.dev/packages-and-plugins/swift-package-manager/for-plugin-authors) (docs.flutter.dev)
- [Saying goodbye to CocoaPods](https://flutter.dev/blog/saying-goodbye-to-cocoapods-swift-package-manager-is-soon-the-default-in-flutter) (blog do flutter.dev)
- [`darwin_dependency_management.dart`](https://github.com/flutter/flutter/blob/master/packages/flutter_tools/lib/src/macos/darwin_dependency_management.dart), a fonte dos avisos citados acima (flutter/flutter)
- [Changelog do `permission_handler_apple`](https://github.com/Baseflow/flutter-permission-handler/blob/main/permission_handler_apple/CHANGELOG.md) (Baseflow/flutter-permission-handler)
- [Plano de repositório Specs somente leitura do CocoaPods](https://blog.cocoapods.org/CocoaPods-Specs-Repo/) (blog do CocoaPods)
