---
title: "Solução: CocoaPods could not find compatible versions for pod durante uma build iOS do Flutter"
description: "Leia a segunda linha do erro, não a primeira. É ela que nomeia a causa: um Podfile.lock desatualizado, um deployment target baixo demais ou dois plugins fixando o mesmo pod transitivo."
pubDate: 2026-07-31
template: error-page
tags:
  - "errors"
  - "flutter"
  - "ios"
  - "cocoapods"
lang: "pt-br"
translationOf: "2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build"
translatedBy: "claude"
translationDate: 2026-07-31
---

A solução depende inteiramente da linha logo abaixo do erro, e existem apenas quatro possibilidades. Se ela diz `In snapshot (Podfile.lock)`, apague `ios/Podfile.lock` e rode `pod install`. Se diz que as specs `required a higher minimum deployment target`, aumente `platform :ios` no seu `Podfile`. Se lista dois plugins resolvendo cada um para uma versão exata diferente do mesmo pod, isso é um conflito real e você resolve no `pubspec.yaml`, não no `Podfile`. Só o quarto caso, um repositório de specs realmente desatualizado, é resolvido por `pod repo update`. Rodar `pod repo update` primeiro, que é o que quase todo mundo faz, desperdiça dois minutos nos três casos em que ele não pode ajudar.

Este artigo foi escrito contra Flutter 3.44.7 (stable, julho de 2026), CocoaPods 1.17.0 (lançado em 2026-07-06), Dart 3.12 e Xcode 16.x no macOS Sequoia.

## O erro em contexto

O formato mais comum, que aparece logo depois de um `flutter pub upgrade` que subiu um plugin do Firebase:

```text
[!] CocoaPods could not find compatible versions for pod "Firebase/CoreOnly":
  In snapshot (Podfile.lock):
    Firebase/CoreOnly (= 10.28.0)

  In Podfile:
    firebase_core (from `.symlinks/plugins/firebase_core/ios`) was resolved to 3.4.0, which depends on
      Firebase/CoreOnly (= 11.0.0)

You have either:
 * out-of-date source repos which you can update with `pod repo update` or with `pod install --repo-update`.
 * changed the constraints of dependency `Firebase/CoreOnly` inside your development pod `firebase_core`.
   You should run `pod update Firebase/CoreOnly` to apply changes you've made.

Error running pod install
Error launching application on iPhone 16 Pro.
```

O segundo formato, que parece o mesmo erro mas não é:

```text
[!] CocoaPods could not find compatible versions for pod "sqflite_darwin":
  In Podfile:
    sqflite_darwin (from `.symlinks/plugins/sqflite_darwin/darwin`)

Specs satisfying the `sqflite_darwin (from `.symlinks/plugins/sqflite_darwin/darwin`)` dependency were
found, but they required a higher minimum deployment target.
```

Os dois começam com a mesma linha de título, e é por isso que os resultados de busca para esse erro são uma bagunça de conselhos contraditórios. Eles não têm nada em comum além da primeira linha.

## Por que o CocoaPods reporta isso em vez de simplesmente escolher uma versão

O CocoaPods resolve dependências com o Molinillo, um resolvedor com backtracking no estilo SAT. Ele recebe um conjunto de restrições e precisa encontrar uma versão de cada pod que satisfaça todas simultaneamente. Quando esgota o espaço de busca sem solução, ele não chuta. Ele imprime as restrições que ainda estavam em conflito quando desistiu, mais uma lista genérica de coisas que às vezes causam conflitos.

Essa lista é genérica mesmo. Ela é impressa quer se aplique quer não. O conteúdo de diagnóstico é o bloco indentado acima dela, que nomeia cada restrição e de onde ela veio. Quatro coisas colocam uma restrição insatisfazível nesse conjunto:

1. **O `Podfile.lock` fixa uma versão exata antiga.** O arquivo de lock participa da resolução como uma restrição rotulada `In snapshot (Podfile.lock)`. Uma atualização de plugin do lado do Dart mudou o que o podspec exige, e o lock continua insistindo no número antigo. A causa mais comum de longe.
2. **Todas as versões candidatas precisam de um deployment target maior do que o seu `Podfile` declara.** O Molinillo filtra as specs cujo `deployment_target` excede sua linha de plataforma e então reporta um conjunto de candidatas vazio. Essa é a variante `required a higher minimum deployment target`.
3. **Dois plugins fixam versões exatas incompatíveis de um pod transitivo compartilhado.** Um diamante genuíno. Nenhuma edição do `Podfile` resolve, porque a restrição se origina em dois podspecs que o Flutter gerou a partir do seu `pubspec.yaml`.
4. **O repositório de specs é anterior à versão sendo pedida.** Só é relevante se você usa um repositório de specs baseado em git. A fonte CDN que o `Podfile` padrão do Flutter usa não precisa de `pod repo update`.

## Reprodução mínima

O caso 1 se reproduz em três comandos em qualquer projeto com um plugin que tenha uma dependência nativa fixada:

```bash
# Flutter 3.44.7, CocoaPods 1.17.0
flutter create podconflict && cd podconflict
flutter pub add firebase_core:3.1.0 && (cd ios && pod install)
flutter pub add firebase_core:3.4.0 && (cd ios && pod install)   # boom
```

O primeiro `pod install` escreve `Firebase/CoreOnly (= 11.0.0)` em `ios/Podfile.lock`. O segundo `flutter pub add` troca o plugin por um cujo podspec exige uma versão exata diferente, e a restrição do lock agora é insatisfazível contra o novo podspec.

O caso 2 se reproduz baixando a linha de plataforma abaixo do que um plugin precisa:

```ruby
# ios/Podfile -- Flutter 3.44.7, CocoaPods 1.17.0
platform :ios, '12.0'
```

com um plugin cujo podspec declara:

```ruby
# .symlinks/plugins/sqflite_darwin/darwin/sqflite_darwin.podspec
s.platform = :ios, '13.0'
```

## A solução, em ordem de prioridade

### 1. Se o erro diz `In snapshot (Podfile.lock)`, descarte o lock

O arquivo de lock é um cache de uma resolução anterior, não uma fonte de verdade. O Flutter regenera todo o grafo de pods a partir do `pubspec.lock` em cada build, então um `ios/Podfile.lock` que discorda dele está desatualizado por definição, não é autoritativo.

```bash
# Flutter 3.44.7, CocoaPods 1.17.0 -- run from the repo root
flutter pub get
cd ios
rm Podfile.lock
pod install
```

Repare na ordem. O `flutter pub get` precisa rodar primeiro, porque é ele que reescreve `ios/.symlinks/plugins/` para apontar para as versões de plugin resolvidas no cache do pub. Rodar `pod install` antes dele resolve os podspecs das versões de plugin que estivessem lá da última vez, o que produz o mesmo erro com números diferentes e te faz andar em círculos.

Se o plugin é um que você controla ou um em que você quer uma mudança cirúrgica em vez de uma re-resolução completa:

```bash
# CocoaPods 1.17.0 -- surgical alternative, keeps other pins intact
cd ios && pod update Firebase/CoreOnly
```

Em um app Flutter, prefira apagar o lock. `pod update <pod>` é a escolha certa em um projeto iOS escrito à mão, onde o arquivo de lock codifica fixações deliberadas; em um app Flutter essas fixações vieram do `pubspec.lock`, e é de lá que você quer que elas continuem vindo.

### 2. Se o erro diz `higher minimum deployment target`, aumente a plataforma em dois lugares

Tanto o `Podfile` quanto o projeto Xcode precisam disso. Editar só o `Podfile` conserta a resolução de pods e depois falha na hora do link, porque a própria configuração de build do target `Runner` ainda declara o piso antigo.

```ruby
# ios/Podfile -- Flutter 3.44.7
platform :ios, '15.0'
```

```ruby
# ios/Podfile -- force every pod target to inherit the same floor
post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_ios_build_settings(target)
    target.build_configurations.each do |config|
      config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '15.0'
    end
  end
end
```

Depois configure também no target do app. Abra `ios/Runner.xcworkspace`, selecione o target `Runner`, vá em `Build Settings` e defina `iOS Deployment Target` com o mesmo valor para Debug e Release. A configuração do workspace vence sobre o `Podfile` para o próprio `Runner`; a linha do `Podfile` governa apenas os targets de pods.

Não escolha o número por tentativa e erro. Leia direto do podspec que falhou:

```bash
# Flutter 3.44.7 -- print the floor the failing plugin actually declares
grep -r "s.platform\|deployment_target" ios/.symlinks/plugins/sqflite_darwin/darwin/*.podspec
```

Aumentar o piso derruba o suporte a aparelhos mais antigos, então aumente exatamente para o que o podspec precisa, não para o iOS mais novo que você tem instalado.

### 3. Se dois plugins fixam o mesmo pod em versões exatas diferentes, conserte no `pubspec.yaml`

Este é o caso em que toda edição do `Podfile` e toda limpeza de cache falham, porque o conflito está acima do CocoaPods. O sinal são duas linhas `was resolved to` nomeando dois plugins diferentes:

```text
[!] CocoaPods could not find compatible versions for pod "GTMSessionFetcher/Core":
  In Podfile:
    firebase_auth (from `.symlinks/plugins/firebase_auth/ios`) was resolved to 5.1.0, which depends on
      GTMSessionFetcher/Core (~> 3.3)
    google_sign_in_ios (from `.symlinks/plugins/google_sign_in_ios/darwin`) was resolved to 5.7.6, which depends on
      GTMSessionFetcher/Core (< 3.0, >= 1.1)
```

`~> 3.3` e `< 3.0` não têm interseção. Encontre as versões de plugin cujos podspecs concordam e fixe-as no `pubspec.yaml`:

```yaml
# pubspec.yaml -- Flutter 3.44.7, Dart 3.12
dependencies:
  firebase_auth: ^5.1.0
  google_sign_in: ^6.2.2   # 6.2.2 ships google_sign_in_ios 5.7.7+, which allows GTMSessionFetcher 3.x
```

Depois re-resolva as duas camadas:

```bash
# Flutter 3.44.7, CocoaPods 1.17.0
flutter pub get
cd ios && rm Podfile.lock && pod install
```

Você pode, em vez disso, forçar uma versão de um pod transitivo pelo `Podfile`:

```ruby
# ios/Podfile -- last resort, use only to unblock while waiting on a plugin release
pod 'GTMSessionFetcher/Core', '3.4.1'
```

Trate isso como um remendo temporário com prazo de validade. Ele sobrescreve uma restrição que o autor do plugin escreveu de propósito, e vai compilar limpo exatamente até quebrar em runtime por causa de um seletor inexistente.

Se o próprio `flutter pub get` falhar antes de você chegar ao CocoaPods, você tem um problema de resolução do lado do Dart e não um nativo, e as restrições a ler são outras: veja [por que "Version solving failed" é uma prova e não um bug](/pt-br/2026/05/fix-version-solving-failed-in-pubspec-yaml/).

### 4. Só então atualize o repositório de specs

```bash
# CocoaPods 1.17.0
cd ios && pod install --repo-update
```

Isso ajuda em exatamente uma situação: você usa um repositório de specs baseado em git (`source 'https://github.com/CocoaPods/Specs.git'` no seu `Podfile`) e seu clone local é anterior à versão pedida. O `Podfile` gerado pelo Flutter usa a fonte CDN por padrão, que consulta versões por HTTP pod a pod e nunca fica desatualizada nesse sentido. Se você não mudou a linha `source`, `--repo-update` é uma operação nula que custa um clone completo das specs.

## Pegadinhas e erros parecidos

**`flutter clean` não toca no `Podfile.lock`.** Ele limpa `build/` e `.dart_tool/`. `ios/Podfile.lock` e `ios/Pods/` sobrevivem intactos, e é por isso que "eu já rodei flutter clean" é a pista falsa mais comum nesse erro. A opção nuclear que de fato limpa o estado do iOS:

```bash
# Flutter 3.44.7, CocoaPods 1.17.0
flutter clean
cd ios && pod deintegrate && rm -rf Pods Podfile.lock .symlinks
cd .. && flutter pub get
cd ios && pod install
```

**`arch -x86_64 pod install` está obsoleto.** Essa gambiarra é de 2021, quando a gem `ffi` não tinha binário arm64. O CocoaPods 1.17.0 sobre Ruby 3.x roda nativo em Apple Silicon. Prefixar `arch -x86_64` hoje força um Ruby sob Rosetta que pode não ter suas gems instaladas e produz uma falha sem relação nenhuma.

**Um plugin que migrou para o SwiftPM não vai aparecer no grafo de pods.** Desde que o [Flutter 3.44 tornou o Swift Package Manager o padrão](/pt-br/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/), plugins que publicam um `Package.swift` são resolvidos pelo SwiftPM e o CocoaPods nunca os vê. É isso que costuma fazer esse erro sumir depois de uma atualização. Também significa que um conflito descrito em uma resposta do StackOverflow de 2024 pode não reproduzir mais, e que fixar um pod no seu `Podfile` para consertar um plugin que já migrou não vai fazer nada, silenciosamente. Verifique qual resolvedor é dono de um plugin antes de remendar em volta dele:

```bash
# Flutter 3.44.7 -- if this file exists, the plugin is on SwiftPM, not CocoaPods
ls ios/Flutter/ephemeral/Packages/FlutterGeneratedPluginSwiftPackage/Package.swift
```

**`Error running pod install` sem bloco de restrições embaixo é outro erro.** Se não houver uma seção indentada `In Podfile:`, o CocoaPods falhou antes da resolução, normalmente por um problema de toolchain de Ruby ou Xcode e não por conflito de versões. Isso pertence ao [checklist de build iOS com Xcode 16](/pt-br/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/), não a este artigo.

**Reprodutibilidade no CI.** Versionar o `ios/Podfile.lock` é o padrão correto, mas faz o caso 1 disparar no CI na primeira vez que alguém do time sobe um plugin sem rodar `pod install` localmente. Ou você exige que os dois arquivos de lock andem no mesmo commit, ou fixa a toolchain para que a falha seja ao menos determinística: veja [como mirar várias versões do Flutter em um único pipeline de CI](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/). O lado Android do mesmo tipo de problema está coberto em [assembleDebug falhando com exit code 1](/pt-br/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).

## O prazo que vale a pena conhecer

O repositório de specs do CocoaPods Trunk fica permanentemente em modo somente leitura em 2026-12-02, com um ensaio de indisponibilidade entre 2026-11-01 e 2026-11-07. Pods existentes continuam resolvendo e o CDN continua servindo, então as builds não quebram, mas nenhum pod vai publicar uma versão nova nunca mais. Na prática: depois dessa data, o caso 3 acima deixa de ter solução por espera. Se dois plugins fixam versões incompatíveis de um pod compartilhado e nenhum dos dois publica um podspec corrigido antes de dezembro, nenhuma versão vai chegar de cima para te salvar, e as únicas saídas são um override no `Podfile` ou mover o plugin para o SwiftPM. Vale orçar as duas agora, e não no primeiro trimestre.

## Fontes

- [CocoaPods Trunk read-only plan](https://blog.cocoapods.org/CocoaPods-Specs-Repo/) (blog do CocoaPods)
- [Swift Package Manager for Flutter app developers](https://docs.flutter.dev/packages-and-plugins/swift-package-manager/for-app-developers) (docs.flutter.dev)
- [Notas de versão do Flutter](https://docs.flutter.dev/release/release-notes) (docs.flutter.dev)
- [Releases do CocoaPods](https://github.com/CocoaPods/CocoaPods/releases) (CocoaPods/CocoaPods)
- [flutter/flutter#168660: could not find compatible versions for pod Firebase/CoreOnly](https://github.com/flutter/flutter/issues/168660) (flutter/flutter)
- [flutter/flutter#148116: could not find compatible versions for pod GTMSessionFetcher/Core](https://github.com/flutter/flutter/issues/148116) (flutter/flutter)
