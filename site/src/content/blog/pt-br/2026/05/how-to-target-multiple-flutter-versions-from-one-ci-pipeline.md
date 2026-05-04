---
title: "Como mirar várias versões do Flutter a partir de um único pipeline de CI"
description: "Guia prático para rodar um projeto Flutter contra várias versões do SDK na CI: matriz do GitHub Actions com subosito/flutter-action v2, .fvmrc do FVM 3 como fonte de verdade, fixação de canal, cache e os detalhes que mordem quando a matriz cresce além de três versões."
pubDate: 2026-05-04
template: how-to
tags:
  - "flutter"
  - "dart"
  - "ci"
  - "github-actions"
  - "fvm"
  - "how-to"
lang: "pt-br"
translationOf: "2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline"
translatedBy: "claude"
translationDate: 2026-05-04
---

Resposta curta: fixe a versão principal do Flutter do projeto em `.fvmrc` (estilo FVM 3) e use esse arquivo como fonte de verdade para o desenvolvimento local. Na CI, rode um job `strategy.matrix` sobre as versões extras do Flutter que importam, instale cada uma com `subosito/flutter-action@v2` (ele lê `flutter-version-file: .fvmrc` para a build principal e aceita um `flutter-version: ${{ matrix.flutter-version }}` explícito para as entradas da matriz), habilite tanto `cache: true` quanto `pub-cache: true`, e proteja a matriz com `fail-fast: false` para que uma única versão quebrada não esconda as outras. Trate a versão principal como obrigatória e as versões da matriz como informativas até que você as tenha estabilizado.

Este guia é para projetos Flutter 3.x em maio de 2026, validado contra `subosito/flutter-action@v2` (último v2.x), FVM 3.2.x e Flutter SDK 3.27.x e 3.32.x em runners hospedados pelo GitHub no Ubuntu e macOS. Assume um repo, um `pubspec.yaml`, e o objetivo de pegar regressões entre versões do Flutter antes que cheguem em uma branch de release. Os padrões traduzem para GitLab CI e Bitbucket Pipelines com pequenas mudanças de sintaxe; os conceitos de matriz são idênticos.

## Por que um repo só contra várias versões do Flutter é até uma coisa

Flutter tem dois canais de release, `stable` e `beta`, e apenas `stable` é suportado em produção. A documentação do Flutter recomenda stable para novos usuários e para releases em produção, o que está correto, e seria adorável se cada time pudesse escolher um patch stable e ficar nele. Na prática três pressões empurram os times para fora desse caminho:

1. Um pacote do qual você depende sobe seu limite inferior `environment.flutter`, e o novo limite está um minor à frente de onde você está.
2. Um novo stable aterrissa com um fix de Impeller ou um fix de build de iOS que você precisa, mas um pacote transitivo ainda não se certificou contra ele.
3. Você publica uma biblioteca ou template (um starter kit, um design system interno) que apps consumidoras usam sobre qualquer Flutter que o time delas tenha padronizado, e você precisa saber que não quebra sob nenhum de `stable - 1`, `stable` ou `beta`.

Nos três casos a resposta é a mesma disciplina chata: escolha uma versão como contrato para as máquinas dos seus desenvolvedores, e trate qualquer outra versão que importa como uma entrada de matriz de CI. Esse é o modelo que o resto deste post constrói.

Um lembrete rápido sobre o que `pubspec.yaml` realmente impõe. A restrição `environment.flutter` é verificada pelo `pub` apenas como um limite inferior. Como coberto em [flutter/flutter#107364](https://github.com/flutter/flutter/issues/107364) e [#113169](https://github.com/flutter/flutter/issues/113169), o SDK não impõe o limite superior na restrição `flutter:`, então escrever `flutter: ">=3.27.0 <3.33.0"` não vai impedir um desenvolvedor no Flutter 3.40 de instalar seu pacote. Você precisa de um mecanismo externo. Esse mecanismo é o FVM para humanos e o `flutter-action` para CI.

## Passo 1: faça do `.fvmrc` a fonte de verdade do projeto

Instale o [FVM 3](https://fvm.app/) uma vez por estação de trabalho, e então fixe o projeto a partir da raiz do repo:

```bash
# FVM 3.2.x, May 2026
dart pub global activate fvm
fvm install 3.32.0
fvm use 3.32.0
```

`fvm use` escreve `.fvmrc` e atualiza `.gitignore` para que o pesado diretório `.fvm/` não seja commitado. Conforme a [documentação de configuração do FVM](https://fvm.app/documentation/getting-started/configuration), apenas `.fvmrc` (e o legado `fvm_config.json` se você tiver um do FVM 2) pertence ao controle de versão. Faça o commit dele e o arquivo se torna o contrato que cada desenvolvedor e cada job de CI lê.

Um `.fvmrc` mínimo se parece com isto:

```json
{
  "flutter": "3.32.0",
  "flavors": {
    "next": "3.33.0-1.0.pre",
    "edge": "beta"
  },
  "updateVscodeSettings": true,
  "updateGitIgnore": true
}
```

O mapa `flavors` é o conceito do FVM que mapeia perfeitamente para uma matriz de CI: cada entrada é uma versão nomeada do Flutter que seu projeto tolera. `next` é o próximo stable em que você quer luz verde, `edge` é o canal beta ao vivo para sinal de aviso antecipado. Localmente, um desenvolvedor pode rodar `fvm use next` para fazer um teste de sanidade antes de abrir um PR. Na CI, você vai iterar os mesmos nomes de flavor a partir da matriz, então os nomes ficam alinhados.

## Passo 2: um workflow, uma build principal, um job de matriz

A armadilha em que a maioria dos times cai na primeira tentativa é colocar cada versão do Flutter na mesma matriz e tratá-las todas como obrigatórias. Isso faz o tempo de execução inflar e transforma uma beta instável em uma branch main vermelha. O padrão que escala são dois jobs no mesmo arquivo de workflow:

- Um job **principal** que instala apenas a versão de `.fvmrc` e roda o pipeline completo de testes, build e entrega. É exigido pela proteção de branch.
- Um job de matriz de **compatibilidade** que instala cada versão extra, roda o analisador e os testes, e é informativo até que você confie nele.

Aqui está o workflow, com a v6 do `actions/checkout` (atual em maio de 2026) e `subosito/flutter-action@v2`:

```yaml
# .github/workflows/flutter-ci.yml
name: Flutter CI

on:
  push:
    branches: [main]
  pull_request:

concurrency:
  group: flutter-ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  primary:
    name: Primary (.fvmrc)
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v6
      - uses: subosito/flutter-action@v2
        with:
          flutter-version-file: .fvmrc
          channel: stable
          cache: true
          pub-cache: true
      - run: flutter --version
      - run: flutter pub get
      - run: dart format --output=none --set-exit-if-changed .
      - run: flutter analyze
      - run: flutter test --coverage

  compat:
    name: Compat (Flutter ${{ matrix.flutter-version }})
    needs: primary
    runs-on: ${{ matrix.os }}
    timeout-minutes: 20
    continue-on-error: ${{ matrix.experimental }}
    strategy:
      fail-fast: false
      matrix:
        include:
          - flutter-version: "3.27.4"
            channel: stable
            os: ubuntu-latest
            experimental: false
          - flutter-version: "3.32.0"
            channel: stable
            os: macos-latest
            experimental: false
          - flutter-version: "3.33.0-1.0.pre"
            channel: beta
            os: ubuntu-latest
            experimental: true
    steps:
      - uses: actions/checkout@v6
      - uses: subosito/flutter-action@v2
        with:
          flutter-version: ${{ matrix.flutter-version }}
          channel: ${{ matrix.channel }}
          cache: true
          pub-cache: true
      - run: flutter pub get
      - run: flutter analyze
      - run: flutter test
```

Algumas coisas nesse arquivo são deliberadas e vale a pena destacar antes de você copiar.

**`fail-fast: false`** é obrigatório para uma matriz de compatibilidade. Sem isso, a primeira versão que falha cancela as outras, o que derrota o propósito. Você quer ver, em uma única execução de CI, que 3.27 passa, 3.32 falha e beta passa, não apenas "alguma coisa falhou".

**`continue-on-error` por entrada de matriz** permite marcar beta como vermelho tolerado. A proteção de branch deve exigir o nome do check `Primary (.fvmrc)` e quaisquer entradas de compatibilidade que você tenha classificado como obrigatórias. Beta e "next" ficam esverdeados no dashboard mas nunca bloqueiam um merge.

**`needs: primary`** é um detalhe de sequenciamento pequeno mas importante. Significa que minutos de CI não são queimados na matriz até a build principal provar que a mudança é pelo menos sintaticamente sã. Em uma matriz de 30 jobs isso importa. Em uma matriz de 3 jobs ainda é uma vitória de graça.

**`concurrency`** cancela execuções em andamento na mesma ref quando um novo commit aterrissa. Sem isso, um desenvolvedor que faz push três vezes em um minuto paga por três execuções completas de matriz.

## Passo 3: cache que de fato acerta entre versões

`subosito/flutter-action@v2` faz cache da instalação do SDK do Flutter com `actions/cache@v5` por baixo dos panos. Cada combinação única de `(os, channel, version, arch)` produz uma entrada de cache separada, que é exatamente o que você quer. A chave de cache padrão é função desses tokens, então uma matriz de 3 versões produz 3 caches de SDK e uma matriz de 2 OS por 3 versões produz 6. Isso está bem até você começar a customizar.

As duas alavancas que vale a pena conhecer:

- `cache: true` faz cache do próprio SDK. Economiza cerca de 90 segundos por execução no Ubuntu, mais no macOS onde a instalação puxa artefatos relacionados ao Xcode.
- `pub-cache: true` faz cache de `~/.pub-cache`. Esta é a maior vitória para mudanças incrementais. Um app Flutter típico com 80 pacotes transitivos leva 25-40 segundos para `pub get` a frio, menos de 5 segundos a quente.

Se você tem um monorepo com vários projetos Flutter compartilhando dependências, configure um `cache-key` e `pub-cache-key` que incluam o hash de todos os arquivos `pubspec.lock` relevantes, não apenas o padrão. Caso contrário cada subprojeto sobrescreve o cache dos outros. A action expõe os tokens `:hash:` e `:sha256:` exatamente para isso; veja o [README](https://github.com/subosito/flutter-action) para a sintaxe.

O que **não** pertence à sua chave de cache de matriz é o nome do canal do SDK do Flutter quando você está fixando em uma build `*-pre`. Tags beta são reconstruídas ocasionalmente, então um cache hit em uma versão `*-pre` pode servir um binário desatualizado. A solução mais simples é pular o cache para as entradas `experimental: true`:

```yaml
- uses: subosito/flutter-action@v2
  with:
    flutter-version: ${{ matrix.flutter-version }}
    channel: ${{ matrix.channel }}
    cache: ${{ !matrix.experimental }}
    pub-cache: ${{ !matrix.experimental }}
```

Você abre mão de um minuto de tempo de instalação na entrada beta e ganha confiança de que a build beta é reproduzível.

## Passo 4: conecte `.fvmrc` e a matriz

O ponto dos flavors do FVM mais uma matriz é que os nomes se alinham. Adicionar um novo alvo de compatibilidade deve ser uma mudança de uma linha em `.fvmrc` e uma mudança de uma linha no workflow. Para mantê-los em sincronia sem coordenação manual, gere a matriz a partir do arquivo no momento do job. GitHub Actions pode fazer isso com um pequeno job de bootstrap que emite uma matriz JSON:

```yaml
  matrix-builder:
    name: Build matrix from .fvmrc
    runs-on: ubuntu-latest
    outputs:
      matrix: ${{ steps.build.outputs.matrix }}
    steps:
      - uses: actions/checkout@v6
      - id: build
        run: |
          MATRIX=$(jq -c '
            {
              include: (
                .flavors // {} | to_entries
                | map({
                    "flutter-version": .value,
                    "channel": (if (.value | test("pre|dev")) then "beta" else "stable" end),
                    "os": "ubuntu-latest",
                    "experimental": (.key == "edge")
                  })
              )
            }' .fvmrc)
          echo "matrix=$MATRIX" >> "$GITHUB_OUTPUT"

  compat:
    needs: [primary, matrix-builder]
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix: ${{ fromJson(needs.matrix-builder.outputs.matrix) }}
    # ... same steps as before
```

Agora adicionar `"perf-investigation": "3.31.2"` em `.fvmrc` automaticamente adiciona um job de compatibilidade na próxima execução de CI. Sem segunda fonte de verdade, sem desvio entre o que o FVM local tenta e o que a CI verifica. A action `flutter-actions/pubspec-matrix-action` do GitHub faz uma coisa similar se você preferir usar uma dependência mantida em vez do `jq` inline; ambas as abordagens funcionam.

## Detalhes que aparecem depois da segunda entrada de matriz

Uma vez que a matriz tem mais de três versões, você vai bater em pelo menos um destes.

**Envenenamento do cache de pub.** Um pacote que usa imports condicionais para símbolos mais novos do Flutter pode resolver de forma diferente em 3.27 versus 3.32. Se ambas as versões compartilham um `pub-cache`, o lock file escrito por 3.32 pode ser servido de volta para 3.27 e produzir uma build que "funciona" com o caminho de código errado. Use um `pub-cache-key` que inclua o token de versão do Flutter (`:version:`) para mantê-las separadas. O custo é um cache mais frio; o benefício é a reprodutibilidade.

**Churn do `pubspec.lock`.** Se você commita `pubspec.lock` (recomendado para repos de aplicativo, não para bibliotecas), a matriz vai regerá-lo de forma diferente por versão do Flutter, e um desenvolvedor rodando na versão de `.fvmrc` vai ver um lock diferente do que as entradas de matriz da CI veem. A solução é pular a reescrita do lock no job de matriz: passe `--enforce-lockfile` para `flutter pub get`, que falha em divergência de resolução em vez de mutar o lock. Aplique isto apenas no job de matriz; o job principal deve ainda permitir atualizações para que PRs do Renovate ou Dependabot consigam chegar ao verde.

**Builds de iOS e canal beta.** `subosito/flutter-action@v2` instala o SDK do Flutter mas não muda a versão do Xcode no `macos-latest`. O Xcode do runner é atualizado em uma cadência diferente da do canal beta do Flutter, e o Flutter beta às vezes vai exigir um Xcode que o runner ainda não entrega. Quando o passo de build de iOS (`flutter build ipa --no-codesign`) começa a falhar apenas no beta, verifique o Xcode do runner contra os requisitos do [`flutter doctor`](https://docs.flutter.dev/get-started/install) antes de assumir que seu código está quebrado. Fixar o runner com `runs-on: macos-15` em vez de `macos-latest` te dá controle sobre essa variável.

**Defaults de arquitetura.** Em maio de 2026 os runners hospedados pelo GitHub são ARM64 por padrão no macOS e x64 no Ubuntu. Se você compila plugins nativos, o token de arquitetura na chave de cache importa; caso contrário um cache de Apple Silicon pode ser servido a um runner x64 em uma migração futura. A `cache-key` padrão da action inclui `:arch:` por essa razão; não a remova quando customizar.

**Desvio do SDK do Dart.** Cada versão do Flutter traz um SDK do Dart específico. Uma execução de `dart format` no Flutter 3.32 (Dart 3.7) produz formatação diferente em alguns casos limite que no Flutter 3.27 (Dart 3.5). Rode a formatação apenas no job principal, não na matriz, para evitar relatórios espúrios de "format check failed" em versões mais antigas. A mesma lógica se aplica para lints: um lint novo introduzido no Dart 3.7 vai disparar em 3.32 e não em 3.27. Use um `analysis_options.yaml` no nível do projeto e só ative os lints novos quando a versão mais antiga da matriz os suportar.

## Quando parar de adicionar versões

O ponto de tudo isso é pegar regressões cedo, não testar exaustivamente. Uma matriz de mais de três ou quatro versões geralmente significa que o time tem medo de atualizar em vez de confiança em atualizar. Se sua matriz cresceu para cinco, pergunte qual entrada não pegou uma regressão em seis meses. Essa entrada provavelmente deveria ser aposentada. A cadência certa para a maioria dos apps é `stable atual`, `próximo stable quando anunciado` e `beta`, o que significa que o script matrix-builder do Passo 4 mantém isso limitado pelo que `.fvmrc` declara.

A disciplina que paga dividendos é a mesma que faz [fixar o SDK do Flutter de forma reproduzível](/pt-br/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/) funcionar em primeiro lugar: declare as versões que importam, instale apenas essas versões, e trate qualquer coisa fora desse conjunto como fora de contrato. A matriz é a aplicação.

## Relacionado

- [Flutter 3.38.6 e o bump do engine.version: builds reproduzíveis ficam mais fáceis se você fixar](/pt-br/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/) cobre por que fixar o SDK importa mesmo dentro de um único canal.
- [Dev tags do Dart 3.12 estão se movendo rápido](/pt-br/2026/01/dart-3-12-dev-tags-are-moving-fast-how-to-read-them-and-what-to-do-as-a-flutter-3-x-developer/) explica como a cadência de dev tags do Dart interage com escolhas de canal do Flutter.
- [Depurando Flutter iOS a partir do Windows](/pt-br/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/) é a peça companheira para times cuja CI precisa cobrir macOS mas cujos desenvolvedores não rodam Macs no dia a dia.
- [FlutterGuard CLI: uma verificação rápida de "o que um atacante pode extrair" para apps Flutter 3.x](/pt-br/2026/01/flutterguard-cli-a-fast-what-can-an-attacker-extract-check-for-flutter-3-x-apps/) é um passo adicional útil para acrescentar ao job principal uma vez que sua matriz esteja estável.

## Links de origem

- [README do subosito/flutter-action](https://github.com/subosito/flutter-action)
- [flutter-actions/setup-flutter](https://github.com/flutter-actions/setup-flutter) (a alternativa mantida se v2 algum dia ficar para trás)
- [Documentação do FVM 3](https://fvm.app/documentation/getting-started/configuration)
- [Opções de pubspec do Flutter](https://docs.flutter.dev/tools/pubspec)
- [Atualizar Flutter](https://docs.flutter.dev/install/upgrade)
- [flutter/flutter#107364: o limite superior da restrição do SDK não é imposto](https://github.com/flutter/flutter/issues/107364)
- [flutter/flutter#113169: Definir versão exata do Flutter no pubspec.yaml não funciona](https://github.com/flutter/flutter/issues/113169)
