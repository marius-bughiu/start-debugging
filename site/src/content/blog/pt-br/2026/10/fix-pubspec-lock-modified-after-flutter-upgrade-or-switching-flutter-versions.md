---
title: "Correção: pubspec.lock aparece como modificado após flutter upgrade ou ao trocar de versão do Flutter"
description: "O SDK do Flutter fixa versões de meta, vector_math, test_api e matcher, então toda mudança de SDK resolve seu lockfile de novo, e o flutter upgrade executa pub upgrade no projeto em que você está. Fixe uma versão do Flutter por repositório e imponha o lockfile no CI."
pubDate: 2026-10-13
template: error-page
tags:
  - "errors"
  - "flutter"
  - "flutter-3-47"
  - "dart"
  - "pub"
lang: "pt-br"
translationOf: "2026/10/fix-pubspec-lock-modified-after-flutter-upgrade-or-switching-flutter-versions"
translatedBy: "claude"
translationDate: 2026-10-13
---

Seu `pubspec.lock` muda porque o SDK do Flutter é ele mesmo uma dependência, com seus próprios pins de versão. `flutter` e `flutter_test` exigem versões exatas de pacotes como `meta`, `vector_math`, `test_api` e `matcher`, então um SDK diferente força o pub a resolvê-los de novo, e o `flutter run` ou `flutter build` que vem depois de uma troca de SDK executa `pub get` por você. Além disso, `flutter upgrade` executa `pub upgrade` em qualquer projeto em que você esteja. A correção: fixe uma versão do Flutter por repositório (FVM mais uma restrição `environment: flutter:`), faça commit da mudança de lockfile de uma atualização de SDK separadamente e execute `flutter pub get --enforce-lockfile` no CI. Tudo abaixo foi medido no Flutter 3.44.8 (Dart 3.12.2) e no Flutter 3.47.7 (Dart 3.13.5) em 2026-10-13.

## O sintoma em contexto

Você não tocou no `pubspec.yaml`. Você executou `flutter upgrade`, trocou de canal, ou um colega com outra versão do Flutter fez push, e agora o `git status` mostra isto:

```text
 M pubspec.lock
```

O diff só toca pacotes transitivos que você nunca adicionou:

```diff
   meta:
     dependency: transitive
     description:
       name: meta
-      sha256: "1741988757a65eb6b36abe716829688cf01910bbf91c34354ff7ec1c3de2b349"
+      sha256: "307249ce4ff29d58a18e97f6345f539382eb9c9c29ecda628900f31de0443dd9"
       url: "https://pub.dev"
     source: hosted
-    version: "1.18.0"
+    version: "1.19.0"
```

Volte para o SDK antigo e execute qualquer coisa que dispare `pub get`, e o diff se inverte. Em uma equipe com versões mistas do Flutter, o lockfile vai e volta em todo pull request.

## Por que isso acontece

Existem três mecanismos separados, e a maioria das equipes cai nos três.

**1. O SDK do Flutter fixa suas próprias dependências.** `packages/flutter/pubspec.yaml` e `packages/flutter_test/pubspec.yaml` no SDK listam versões exatas. Seu app depende dos dois por meio de `sdk: flutter`, então os pins deles viram restrições na sua resolução. Quando o SDK muda, os pins mudam, as versões no seu lockfile deixam de satisfazê-los e o pub precisa escolher novas. Estas são as linhas relevantes dos dois SDKs que testei:

| Pacote | Flutter 3.44.8 | Flutter 3.47.7 |
| --- | --- | --- |
| `meta` | `1.18.0` | `^1.18.3` |
| `vector_math` | `2.2.0` | `^2.4.0` |
| `test_api` | `0.7.11` | `0.7.12` |
| `matcher` | `0.12.19` | `0.12.20` |
| `material_color_utilities` | `0.13.0` | `0.13.0` |
| `collection` | `1.19.1` | `^1.19.1` |

O Flutter 3.47 é a primeira versão estável com o [PR #185268, "Unpin sdk package dependencies"](https://github.com/flutter/flutter/pull/185268), que encerrou a antiga issue [#158050, "Stop pinning dependencies"](https://github.com/flutter/flutter/issues/158050). A maioria dos pins virou intervalos com circunflexo. `test_api` e `matcher` continuam exatos porque o SDK importa as bibliotecas `src/` deles, e `material_color_utilities` também continua fixado (a descrição do PR explica os dois casos). Então, mesmo no 3.47 e posteriores, toda versão do Flutter que altera `test_api` ou `matcher` reescreve essas entradas do lockfile.

**2. O Flutter executa `pub get` por baixo dos panos após uma troca de SDK.** `flutter run`, `flutter build`, `flutter test` e companhia chamam `pub get` antes de fazer qualquer outra coisa. A ferramenta do Flutter só o ignora quando `.dart_tool/version` coincide com a versão atual do framework e o `pubspec.yaml` é mais antigo que o `pubspec.lock` e o `.dart_tool/package_config.json`. A verificação está em `packages/flutter_tools/lib/src/dart/pub.dart`. Por isso o primeiro `flutter run` depois de trocar de SDK sempre resolve de novo, e o lockfile muda mesmo que você nunca tenha digitado `pub`.

**3. `flutter upgrade` executa `pub upgrade` no seu projeto.** Este é o que a maioria das pessoas deixa passar. Depois de atualizar o SDK, `UpgradeCommand.updatePackages` procura um `pubspec.yaml` no diretório atual ou em qualquer diretório pai, e se encontrar um, chama `pub.get(..., upgrade: true)` nesse projeto. Isso é `pub upgrade`, não `pub get`, então move *todas* as dependências para a versão mais nova que suas restrições permitem, inclusive pacotes que não têm nada a ver com o SDK. O código faz isso pelo menos desde o Flutter 3.0.0.

## Repro mínimo

Crie um projeto no SDK mais antigo, faça commit e depois resolva com o mais novo. Mantive os dois SDKs lado a lado: o Flutter 3.44.8 do Homebrew e o zip estável do 3.47.7 descompactado em uma pasta temporária.

```bash
# Flutter 3.44.8 (Dart 3.12.2) creates and locks the project
flutter create -e --platforms=android app
cd app
flutter pub add http shared_preferences intl
git init -q && git add -A && git commit -qm base

# Same project, Flutter 3.47.7 (Dart 3.13.5)
~/sdks/flutter-3.47.7/bin/flutter pub get
git diff --stat
```

Saída no 3.47.7:

```text
Resolving dependencies...
Downloading packages...
  clock 1.1.2 (1.1.3 available)
> matcher 0.12.20 (was 0.12.19)
  material_color_utilities 0.13.0 (0.13.1 available)
> meta 1.19.0 (was 1.18.0)
  stack_trace 1.12.1 (1.12.2 available)
> test_api 0.7.12 (was 0.7.11) (0.7.15 available)
> vector_math 2.4.3 (was 2.2.0)
Changed 4 dependencies!
Upgrading analysis_options.yaml to exclude build and platform directories.
 analysis_options.yaml |  4 ++++
 pubspec.lock          | 16 ++++++++--------
 2 files changed, 12 insertions(+), 8 deletions(-)
```

Quatro pacotes mudaram, todos eles pins do SDK ou ex-pins do SDK. `http`, `shared_preferences` e `intl` ficaram exatamente onde estavam: o `pub get` simples mantém toda versão travada que conseguir. Repare na mudança de arquivo de bônus. O Flutter 3.47 traz uma `AnalysisOptionsMigration` que adiciona `build/**` e uma exclusão `<platform>/**` por pasta de plataforma ao `analysis_options.yaml` na primeira vez que executa `pub get` no seu projeto. É uma edição única, e você deve fazer o commit dela junto com o lockfile.

Agora volte para o 3.44.8:

```text
< matcher 0.12.19 (was 0.12.20) (0.12.20 available)
< meta 1.18.0 (was 1.19.0) (1.19.0 available)
< test_api 0.7.11 (was 0.7.12) (0.7.15 available)
< vector_math 2.2.0 (was 2.4.3) (2.4.3 available)
Changed 4 dependencies!
```

Esse é o vai e volta. Nenhum dos SDKs aceita o lockfile do outro, então vence quem executou por último.

Para comparar, `pub upgrade` no 3.47.7 a partir do mesmo lockfile do 3.44 (que é o que o `flutter upgrade` faz por você) mudou seis pacotes em vez de quatro, porque também moveu `clock` e `stack_trace` para as versões mais recentes. Em um app real com algumas dezenas de dependências, esse número costuma ser bem maior.

## A correção, em detalhes

O objetivo não é impedir que o lockfile mude. Ele precisa mudar quando o SDK muda, porque a resolução antiga deixou de ser válida. O objetivo é fazê-lo mudar uma vez, de propósito, em um commit que você possa revisar.

### 1. Faça commit do `pubspec.lock` em apps, e somente em apps

A [documentação do Dart sobre `pub get`](https://dart.dev/tools/pub/cmd/pub-get) diz que pacotes de aplicativo devem versionar o lockfile, para que todo desenvolvedor e toda implantação usem as mesmas versões, enquanto pacotes reutilizáveis não devem. Se a instabilidade que você vê é em um repositório de *pacote*, a correção mais simples é parar de versionar o lockfile ali. Tudo abaixo pressupõe um app.

### 2. Fixe uma versão do Flutter por repositório

O vai e volta só acontece quando pessoas executam SDKs diferentes contra o mesmo lockfile. Faça a versão fazer parte do repositório.

Com o [FVM](https://fvm.app/), `fvm use` grava a versão em `.fvmrc` na raiz do projeto, e todos executam `fvm flutter ...` contra ela:

```bash
# FVM 3.x, Flutter 3.47.7
fvm install 3.47.7
fvm use 3.47.7
git add .fvmrc
```

Depois reforce isso com uma restrição de Flutter no `pubspec.yaml`, que o pub impõe a todos, usem FVM ou não:

```yaml
# pubspec.yaml, Flutter 3.47.7 / Dart 3.13.5
environment:
  sdk: ^3.13.5
  flutter: ">=3.47.0 <3.48.0"
```

O pub verifica os dois limites. Com o intervalo definido como `<3.45.0`, o Flutter 3.47.7 se recusou a resolver:

```text
The current Flutter SDK version is 3.47.7.

Because app2 requires Flutter SDK version >=3.0.0 <3.45.0, version solving failed.
Failed to update packages.
```

Esse erro é muito melhor do que um lockfile reescrito em silêncio: o colega com o SDK errado descobre na hora, em vez de no code review. Espere que o bloco `sdks:` no fim do `pubspec.lock` repita sua restrição (`flutter: ">=3.47.0 <3.48.0"`), porque o pub registra ali a interseção de todas as restrições de SDK do grafo. Essa linha muda sempre que você edita a restrição, o que é normal.

Se você quer que o CI siga o mesmo arquivo, a [configuração de CI com várias versões](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) lê a versão de `.fvmrc`.

### 3. Atualize o Flutter como uma mudança própria, fora do diretório do projeto

Como o `flutter upgrade` executa `pub upgrade` no projeto que encontra a partir do seu diretório de trabalho, atualizar de dentro de um repositório mistura duas mudanças bem diferentes em um só diff: a nova resolução causada pelo SDK e uma atualização completa de dependências. Separe-as:

```bash
# Flutter 3.44.8 -> 3.47.7
cd ~                # no pubspec.yaml here or in any parent directory
flutter upgrade     # upgrades only the SDK

cd ~/src/my_app
flutter pub get     # re-resolves only what the new SDK forces
git add pubspec.lock analysis_options.yaml
git commit -m "Flutter 3.47.7: re-resolve SDK-pinned packages"
```

Se você usa FVM, ganha o mesmo efeito de graça: `fvm install` e `fvm use` nunca chamam `pub upgrade` no seu app. Quando quiser pacotes mais novos, execute `flutter pub upgrade` deliberadamente em um segundo commit, para que uma regressão seja localizada via bisect como "SDK novo" ou "pacotes novos", não os dois. É a mesma separação que recomendo para [a quebra do `awaitNotRequired`](/pt-br/2026/10/fix-undefined-name-awaitnotrequired-material-ui-cupertino-ui-flutter-3-44/), em que um pacote retirado e uma incompatibilidade de SDK pareciam um único problema.

### 4. Imponha o lockfile no CI

`--enforce-lockfile` faz o `pub get` falhar em vez de reescrever o lockfile quando a resolução commitada não é válida para o SDK atual. A documentação o recomenda para CI e implantações em produção. Veja o lockfile do 3.44 sob o Flutter 3.47.7:

```text
> matcher 0.12.20 (was 0.12.19)
> meta 1.19.0 (was 1.18.0)
> test_api 0.7.12 (was 0.7.11) (0.7.15 available)
> vector_math 2.4.3 (was 2.2.0)
Would change 4 dependencies.
Unable to satisfy `pubspec.yaml` using `pubspec.lock`.

To update `pubspec.lock` run `flutter pub get` without
`--enforce-lockfile`.
Failed to update packages.
```

O comando termina com código de saída 65 e deixa o `pubspec.lock` intocado. Coloque-o antes de todo build:

```yaml
# GitHub Actions, subosito/flutter-action v2, Flutter 3.47.7
- uses: subosito/flutter-action@v2
  with:
    flutter-version-file: .fvmrc
- run: flutter pub get --enforce-lockfile
- run: flutter build apk --release
```

Agora um runner de CI com o SDK errado, ou um lockfile que alguém esqueceu de commitar após uma atualização de SDK, vira um build vermelho com uma mensagem clara em vez de um build verde em versões que ninguém revisou. `--enforce-lockfile` também falha se o hash de conteúdo de um pacote hospedado deixar de coincidir com o `sha256` registrado no lockfile, o que é uma boa verificação de cadeia de suprimentos de brinde.

### 5. Não lute contra o diff com `--no-pub`

`flutter run --no-pub` ignora o `pub get` implícito, e de fato impede que o lockfile mude. Mas isso também significa que você está executando o SDK novo contra um `package_config.json` resolvido para o antigo. Funciona até o dia em que não funciona, geralmente como um erro de compilação dentro de `flutter_test` ou de uma anotação de `meta` que o novo framework espera. Use `--no-pub` para experimentos rápidos, nunca como a correção.

## Pegadinhas e problemas parecidos

**Projetos novos no 3.47+ começam nos limites inferiores.** Desde o [PR #175352](https://github.com/flutter/flutter/pull/175352), `flutter create` grava um `pubspec.lock` que trava as dependências do SDK no extremo inferior dos novos intervalos. Um projeto novo no 3.47.7 trava `meta` 1.18.3 e `vector_math` 2.4.0; o primeiro `flutter pub upgrade` os move para 1.19.0 e 2.4.3. Esse diff é esperado, e cabe a você escolher quando aceitá-lo.

**Versões de patch raramente mexem nos pins.** O pubspec do `flutter_test` é idêntico no 3.47.0, 3.47.6 e 3.47.7, então uma atualização de patch dentro de uma mesma minor normalmente deixa o lockfile em paz. Versões minor (3.44 para 3.47) quase sempre o alteram. Planeje-se para o diff quando cruzar uma versão minor.

**As aspas no `sha256` não são instabilidade.** Nos diffs acima, alguns hashes aparecem entre aspas e outros não. O pub coloca aspas em qualquer hash que comece com um dígito para que o YAML não o leia como número. Se uma linha de hash muda, é porque a versão mudou, não a formatação.

**Monorepos com pub workspace.** Com workspaces do Dart há um único `pubspec.lock` na raiz do workspace, e o `flutter upgrade` executado a partir de qualquer pasta de membro sobe a árvore e também encontra um `pubspec.yaml`. As mesmas regras valem, com um raio de impacto maior. Se seu editor ficar lento após uma nova resolução, veja [como acelerar o servidor de análise do Dart em um monorepo grande](/pt-br/2026/09/how-to-speed-up-a-slow-dart-analysis-server-in-vs-code-for-a-large-flutter-monorepo/).

**"version solving failed" em vez de um diff.** Se um pacote do qual você depende fixa o mesmo pacote que o SDK fixa, uma troca de SDK falha na resolução de vez, em vez de reescrever o lockfile discretamente. Esse é outro problema, com seu próprio passo a passo: [corrigindo "version solving failed" no pubspec.yaml](/pt-br/2026/05/fix-version-solving-failed-in-pubspec-yaml/).

**Os artefatos do engine são um pin separado.** Fixar a versão do framework também fixa o engine, o que importa para builds de release reproduzíveis. O contexto está no [post sobre a versão do engine no Flutter 3.38.6](/pt-br/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/).

## Relacionados

- [How to fix "version solving failed" in pubspec.yaml](/pt-br/2026/05/fix-version-solving-failed-in-pubspec-yaml/)
- [How to target multiple Flutter versions from one CI pipeline](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)
- [Fix: Undefined name 'awaitNotRequired' from material_ui or cupertino_ui on Flutter 3.44](/pt-br/2026/10/fix-undefined-name-awaitnotrequired-material-ui-cupertino-ui-flutter-3-44/)
- [Flutter 3.38.6 and the engine version bump: reproducible builds get easier if you pin it](/pt-br/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/)
- [How to speed up a slow Dart analysis server in VS Code for a large Flutter monorepo](/pt-br/2026/09/how-to-speed-up-a-slow-dart-analysis-server-in-vs-code-for-a-large-flutter-monorepo/)

## Fontes

- [dart.dev: `dart pub get`](https://dart.dev/tools/pub/cmd/pub-get), sobre versões travadas, `--enforce-lockfile` e o commit do lockfile.
- [flutter/flutter#158050: Stop pinning dependencies](https://github.com/flutter/flutter/issues/158050) e o [documento de design](https://flutter.dev/go/unpin-flutter-sdk-dependencies).
- [flutter/flutter#184821: Unpin sdk package dependencies](https://github.com/flutter/flutter/pull/184821) e seu reland [#185268](https://github.com/flutter/flutter/pull/185268).
- [flutter/flutter#175352: Have `flutter create` create a pubspec.lock](https://github.com/flutter/flutter/pull/175352).
- Código-fonte da ferramenta do Flutter na [tag 3.47.7](https://github.com/flutter/flutter/tree/3.47.7/packages/flutter_tools/lib/src): `commands/upgrade.dart` (`updatePackages`), `dart/pub.dart` (a verificação que ignora o pub get), `migrations/analysis_options_migration.dart`.
