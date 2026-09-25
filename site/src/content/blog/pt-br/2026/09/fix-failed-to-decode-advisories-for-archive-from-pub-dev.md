---
title: "Correção: Failed to decode advisories for archive from https://pub.dev no flutter pub get"
description: "O aviso de advisories no pub get é inofensivo: o pub get termina com código 0. O pub.dev corrigiu a resposta inválida em 2026-05-04. Se você ainda o vê, a causa é um mirror ou proxy."
pubDate: 2026-09-25
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "pub"
  - "ci"
lang: "pt-br"
translationOf: "2026/09/fix-failed-to-decode-advisories-for-archive-from-pub-dev"
translatedBy: "claude"
translationDate: 2026-09-25
---

Seus pacotes estão bem. A mensagem vem da verificação de avisos de segurança do pub, que roda depois da resolução, e o `flutter pub get` continua terminando com código 0. O surto em massa (todo projeto que depende de `archive`, `http`, `dio`, `shared_preferences_android` e assim por diante) foi um bug no servidor do pub.dev. Entre 2026-05-02 e 2026-05-04 a API de advisories retornou `"advisoriesUpdated": null`, e o pub.dev corrigiu isso em 2026-05-04. Se você ainda o vê hoje, a resposta está vindo de um mirror de pacotes (`PUB_HOSTED_URL`, Artifactory, Nexus, um servidor pub privado) ou de um proxy. Corrija esse servidor, ou atualize para o Flutter 3.47.0 / Dart 3.13.0 ou posterior, onde o stack trace é reduzido a um aviso de uma linha. Se o CI falha por causa disso, o problema real é uma etapa que trata stderr como falha.

Reproduzi cada variante abaixo no macOS com Dart 3.12.2 (o SDK do Flutter 3.44.x) e Dart 3.13.4 (o SDK do Flutter 3.47.5). Ambos rodaram contra um repositório pub local de 40 linhas que implementa a [hosted repository spec v2](https://github.com/dart-lang/pub/blob/master/doc/repository-spec-v2.md) e me deixa escolher o que o endpoint de advisories retorna.

## O erro em contexto

No Flutter 3.44.x e anteriores (Dart 3.12.x e anteriores), o `flutter pub get` ou `dart pub get` imprime isto para um pacote após o outro:

```text
Resolving dependencies...
Downloading packages...
Failed to decode advisories for archive from https://pub.dev.
FormatException: advisoriesUpdated must be a String
package:pub/src/source/hosted.dart 670                        HostedSource._extractAdvisoryDetailsForPackage
package:pub/src/source/hosted.dart 622                        HostedSource._fetchAdvisories
===== asynchronous gap ===========================
package:pub/src/source/hosted.dart 839                        HostedSource._getAdvisories
===== asynchronous gap ===========================
package:pub/src/source/hosted.dart 1120                       HostedSource.getAdvisoriesForPackageVersion
===== asynchronous gap ===========================
package:pub/src/solver/report.dart 425                        SolveReport._reportPackage
===== asynchronous gap ===========================
package:pub/src/solver/report.dart 221                        SolveReport._reportChanges
===== asynchronous gap ===========================
package:pub/src/solver/report.dart 76                         SolveReport.show
===== asynchronous gap ===========================
package:pub/src/entrypoint.dart 642                           Entrypoint.acquireDependencies
...
Failed to decode advisories for http from https://pub.dev.
FormatException: advisoriesUpdated must be a String
...
```

No Flutter 3.47.0 e posteriores (Dart 3.13.0 e posteriores) a mesma condição produz uma linha por pacote:

```text
Failed to decode advisories for archive from https://pub.dev: advisoriesUpdated must be a String
```

O `archive` costuma ser o primeiro nome que você vê. O relatório percorre os pacotes em ordem alfabética, e `archive` é uma dependência transitiva de `image` e de muitas ferramentas de build, então ele aparece cedo na maioria dos lock files de Flutter. Só pacotes que já tiveram algum aviso de segurança disparam a busca, e é por isso que `http` e `dio` estavam em todos os relatórios e `path` nunca esteve.

## Por que o pub busca advisories

Desde o Dart 3.4 ([dart-lang/pub#4062](https://github.com/dart-lang/pub/pull/4062)), `pub get`, `pub upgrade` e `pub add` relatam avisos de segurança conhecidos para as versões que você resolveu. Os dados vêm do [osv.dev](https://osv.dev), e o pub.dev os reexporta por meio de dois campos da sua API:

1. A listagem de versões, `GET /api/packages/<name>`, tem um timestamp opcional `advisoriesUpdated`. Se ele estiver presente, o cliente assume que o servidor suporta o endpoint de advisories para aquele pacote.
2. O endpoint de advisories, `GET /api/packages/<name>/advisories`, retorna `{"advisories": [...], "advisoriesUpdated": "<date-time>"}`.

O cliente guarda a segunda resposta em cache em `$PUB_CACHE/hosted/<host>/.cache/<name>-advisories.json` e usa o timestamp para decidir se esse cache está desatualizado. Em `_extractAdvisoryDetailsForPackage` no [`hosted.dart`](https://github.com/dart-lang/pub/blob/master/lib/src/source/hosted.dart), o parser é rigoroso com o timestamp:

```dart
// dart-lang/pub, lib/src/source/hosted.dart (Dart 3.12 and 3.13)
final advisoriesUpdated = body['advisoriesUpdated'];
if (advisoriesUpdated is! String) {
  throw const FormatException('advisoriesUpdated must be a String');
}
```

Essa `FormatException` é capturada em `_fetchAdvisories`, registrada como aviso, e o método retorna `null`, que significa "sem dados de advisories para este pacote". A resolução já terminou a essa altura, e nada no `pubspec.lock` depende disso. A única coisa perdida é o relatório de avisos daquele pacote.

## O que quebrou no pub.dev em maio de 2026

O [post mortem](https://github.com/dart-lang/pub-dev/issues/9372) da equipe do pub.dev explica a sequência. Em 2026-04-23 uma imagem Docker `FROM scratch` mais enxuta removeu o `unzip`, então o job que baixa o export do osv.dev parou de funcionar. Em 2026-05-01 ele foi substituído por uma implementação de unzip em Dart sem uma chamada a `init()`. Essa implementação extraía zero arquivos, então a sincronização seguinte, em 2026-05-02, "não encontrou" nenhum aviso e apagou todos do datastore.

O endpoint de advisories derivava `advisoriesUpdated` do aviso armazenado mais recente, e não sobrou nenhum, então ele retornou `null`. A listagem de versões ainda carregava o timestamp antigo da entidade do pacote. Todo cliente, portanto, via "este pacote tem avisos", buscava os avisos e engasgava com:

```json
{"advisories": [], "advisoriesUpdated": null}
```

O [dart-lang/pub-dev#9368](https://github.com/dart-lang/pub-dev/pull/9368) ("Fix advisoriesUpdated") foi publicado em 2026-05-04. Os avisos foram recarregados, e a issue foi fechada em 2026-05-05. Hoje um pacote sem avisos retorna a época Unix em vez de `null`:

```bash
# pub.dev, checked 2026-09-25
curl -s https://pub.dev/api/packages/path/advisories
# {"advisories":[],"advisoriesUpdated":"1970-01-01T00:00:00.000"}
```

Do lado do cliente, o [dart-lang/pub#4817](https://github.com/dart-lang/pub/pull/4817) ("Quiet warning instead of stack trace when failing to parse advisories") substituiu o stack trace por uma mensagem de uma linha. Verifiquei o `pub_rev` fixado no arquivo `DEPS` do Dart SDK para cada tag de release. A mudança não está nas versões 3.12.0 a 3.12.2, e está em todas as releases 3.13.x. Em termos de Flutter, as versões 3.44.0 a 3.44.9 ainda imprimem o trace completo, e a 3.47.0 é a primeira stable que não imprime.

## Reprodução mínima com um servidor pub local

Você não precisa que o pub.dev esteja quebrado para ver isso. Um pequeno servidor Node que segue a especificação do repositório, com uma chave para a resposta de advisories, reproduz todas as variantes. Esta é a parte relevante:

```js
// Node 24, server.mjs: minimal pub repository (spec v2)
if (req.url === '/api/packages/fakepkg') {
  res.writeHead(200, { 'content-type': 'application/vnd.pub.v2+json' });
  return res.end(JSON.stringify({
    name: 'fakepkg',
    advisoriesUpdated: '2026-04-20T10:00:00.000Z', // tells pub to fetch advisories
    latest: { version: '1.0.0', archive_url: `${base}/pkg/fakepkg-1.0.0.tar.gz`, pubspec },
    versions: [{ version: '1.0.0', archive_url: `${base}/pkg/fakepkg-1.0.0.tar.gz`, pubspec }],
  }));
}
if (req.url === '/api/packages/fakepkg/advisories') {
  res.writeHead(200, { 'content-type': 'application/json' });
  return res.end(JSON.stringify({ advisories: [], advisoriesUpdated: null }));
}
```

O app aponta uma dependência para ele:

```yaml
# pubspec.yaml, Dart 3.12.2 / 3.13.4
name: app
publish_to: none
environment:
  sdk: ^3.0.0
dependencies:
  fakepkg:
    hosted: http://localhost:8123
    version: ^1.0.0
```

Rodando nos dois SDKs, com um `PUB_CACHE` novo a cada vez:

```bash
# Dart 3.12.2
dart pub get > out.txt 2> err.txt; echo "exit=$?"
# exit=0
# out.txt: Resolving dependencies... Downloading packages... + fakepkg 1.0.0  Changed 1 dependency!
# err.txt: Failed to decode advisories for fakepkg from http://localhost:8123.
#          FormatException: advisoriesUpdated must be a String
#          package:pub/src/source/hosted.dart 648  HostedSource._extractAdvisoryDetailsForPackage
#          ... (full async stack trace)

# Dart 3.13.4
dart pub get > out.txt 2> err.txt; echo "exit=$?"
# exit=0
# err.txt: Failed to decode advisories for fakepkg from http://localhost:8123: advisoriesUpdated must be a String
```

Três coisas que a reprodução deixa concretas:

- **O código de saída é 0 nas duas versões.** O pacote é baixado e o `pubspec.lock` é escrito.
- **Tudo vai para o stderr.** O stdout fica limpo.
- **A resposta inválida nunca vai para o cache.** Depois, `$PUB_CACHE/hosted/localhost%588123/.cache/` contém `fakepkg-versions.json`, mas não `fakepkg-advisories.json`. A escrita no cache acontece depois de um parse bem-sucedido, então o pub pergunta de novo a cada execução, inclusive num `pub get` em que nada mudou. Apagar o cache do pub não ajuda, porque o cache nunca foi o problema. Isso bate com os relatos na issue do pub-dev de pessoas que rodaram `flutter pub cache clean` e continuaram recebendo o erro.

## Como corrigir, em ordem de probabilidade

### 1. Confirme de onde vem a resposta

Rode um get verboso e procure a requisição de advisories:

```bash
# Flutter 3.47.5 / Dart 3.13.4
dart pub get --verbose 2>&1 | grep -A3 "Fetching security advisories"
# IO  : Fetching security advisories from https://pub.dev/api/packages/archive/advisories.
# IO  : HTTP GET https://pub.dev/api/packages/archive/advisories
```

Depois busque você mesmo essa URL exata:

```bash
curl -s https://pub.dev/api/packages/archive/advisories | head -c 300
```

Se o host é `pub.dev` e o corpo tem um `advisoriesUpdated` do tipo string, o lado do servidor está saudável. Qualquer mensagem restante vem de algo entre você e o pub.dev, geralmente um proxy com inspeção de TLS que reescreve respostas. Se o host não é o pub.dev, confira `echo $PUB_HOSTED_URL` e quaisquer URLs `hosted:` no `pubspec.yaml`. Esse servidor é o culpado.

### 2. Impeça o CI de tratar o aviso como falha

O pub termina com 0, então se um pipeline ficou vermelho por causa dessa mensagem, alguma etapa está falhando por saída em stderr. Os suspeitos de sempre são tarefas de script do Azure Pipelines com `failOnStderr: true` e scripts do Windows PowerShell 5.1 que rodam `flutter pub get 2>&1` sob `$ErrorActionPreference = 'Stop'`. O PowerShell 5.1 transforma cada linha de stderr redirecionada em um `ErrorRecord`, e com `Stop` a primeira delas encerra o script. Use o código de saída como critério:

```yaml
# Azure Pipelines, Flutter 3.47.5
- script: flutter pub get
  displayName: Restore packages
  failOnStderr: false   # pub prints advisory warnings to stderr and still exits 0
```

```powershell
# Windows PowerShell 5.1, Flutter 3.47.5
$ErrorActionPreference = 'Continue'
flutter pub get
if ($LASTEXITCODE -ne 0) { throw "flutter pub get failed ($LASTEXITCODE)" }
```

Wrappers que fazem grep no log procurando `Exception` ou `Error` caem no mesmo problema. Uma falha de resolução real, como [`version solving failed`](/pt-br/2026/05/fix-version-solving-failed-in-pubspec-yaml/), define um código de saída diferente de zero, então o código de saída basta.

### 3. Atualize para o Flutter 3.47.0 ou posterior

Isso não elimina o aviso, mas a forma de uma linha assusta muito menos nos logs e não enterra a saída que importa. Se o seu CI fixa o Flutter por branch, a abordagem de [usar várias versões do Flutter em um único pipeline de CI](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) permite mover o job padrão para a 3.47.x sem mexer nos outros.

### 4. Corrija o mirror ou o servidor pub privado

A especificação dá a um mirror duas opções válidas, e ele precisa escolher uma:

- Fazer proxy de `/api/packages/<name>/advisories` fielmente, com `advisoriesUpdated` sempre como string.
- Ou remover `advisoriesUpdated` da listagem de versões que ele serve. A especificação torna o campo opcional, e quando ele está ausente o cliente nem chama o endpoint de advisories. Você perde o relatório de avisos, mas o pub para de perguntar.

Repositórios remotos no Artifactory e em produtos similares guardam em cache os metadados do upstream. Um usuário de Artifactory na issue do pub-dev encontrou uma falha diferente: o próprio parser do proxy lançou uma `NullPointerException` no campo `null`. Se o seu proxy guardou em cache uma resposta da janela de maio de 2026, limpar o cache de metadados desse repositório remoto (o Artifactory chama isso de "zap cache") faz com que ele busque a resposta corrigida. Quem administra o proxy precisa fazer isso. Nada do lado do cliente vai mudar isso.

### 5. Pule a verificação onde ela realmente não importa

`dart pub get --offline` / `flutter pub get --offline` nunca busca advisories. O código retorna cedo no modo offline. Isso só funciona quando todos os pacotes já estão no cache local do pub, então serve para agentes de build herméticos com cache pré-aquecido, não como correção geral. Não use isso para esconder um mirror quebrado nas máquinas dos desenvolvedores, porque você também perde o relatório de segurança que é a razão de existir da verificação.

## Variantes parecidas

**`Failed to decode advisories for X from ...: Unexpected character (at character 1)`** seguido de uma linha de HTML. A requisição de advisories recebeu uma página HTML, normalmente um captive portal, um login de proxy ou uma página de erro que retorna HTTP 200. Reproduzi isso retornando `<html>proxy login</html>`. O código de saída continua 0, e a correção está no caminho de rede, não no pub.

**`Warning: Unable to fetch advisories for "X" from "https://my-mirror/"`**. O endpoint de advisories retornou um status fora da faixa 2xx a partir de um host que não é o pub.dev. Isso é um aviso, com código de saída 0. Esse comportamento vem do [dart-lang/pub#4275](https://github.com/dart-lang/pub/pull/4275), de 2024. Antes disso, um mirror sem o endpoint derrubava o `pub get`.

**`Failed to fetch advisories for "X" from "https://pub.dev"`**. Mesma situação, mas o host é o pub.dev. O pub trata esse caso como fatal (`fail(...)`) e termina com código diferente de zero, já que o pub.dev deveria sempre servir o endpoint. Se você vê este, é realmente uma indisponibilidade do pub.dev ou algo bloqueando esse caminho. Consulte [o issue tracker do pub.dev](https://github.com/dart-lang/pub-dev/issues) antes de mudar qualquer coisa localmente.

**`FormatException: advisories must be a list`** ou **`advisory must be a map`**. Mesmo caminho de código, outro campo malformado. Um servidor pub caseiro está retornando o formato errado. Compare a resposta dele com a seção sobre o formato OSV da especificação.

## Relacionados

- [Correção: version solving failed no pubspec.yaml](/pt-br/2026/05/fix-version-solving-failed-in-pubspec-yaml/) cobre o erro do pub que realmente interrompe um build e como ler a saída dele.
- [Como usar várias versões do Flutter em um único pipeline de CI](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/), útil ao mover o CI para um SDK 3.47.x.
- [Fixando a versão do engine do Flutter para builds reproduzíveis](/pt-br/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/), já que saber exatamente qual SDK seus agentes rodam é como você distingue a saída da 3.44 da saída da 3.47.
- [Correção: Unexpected failure parsing device information from adb output](/pt-br/2026/09/fix-unexpected-failure-parsing-device-information-from-adb-output-in-flutter/) é outra mensagem barulhenta das ferramentas do Flutter em que a ação certa é uma versão específica do SDK.
- [O que mais saiu no hotfix do Flutter 3.47.1](/pt-br/2026/08/flutter-3-47-1-blocks-plugin-registrant-code-injection/).

## Fontes

- [dart-lang/pub-dev#9372](https://github.com/dart-lang/pub-dev/issues/9372), o relato original e o post mortem, além das duplicatas [dart-lang/sdk#63308](https://github.com/dart-lang/sdk/issues/63308) e [flutter/flutter#185943](https://github.com/flutter/flutter/issues/185943).
- [dart-lang/pub-dev#9368](https://github.com/dart-lang/pub-dev/pull/9368), a correção no servidor.
- [dart-lang/pub#4817](https://github.com/dart-lang/pub/pull/4817), o aviso mais discreto no cliente, e [dart-lang/pub#4275](https://github.com/dart-lang/pub/pull/4275), o tratamento elegante de um endpoint de advisories ausente.
- [`lib/src/source/hosted.dart`](https://github.com/dart-lang/pub/blob/master/lib/src/source/hosted.dart) no dart-lang/pub (`_fetchAdvisories`, `_extractAdvisoryDetailsForPackage`, `_getAdvisories`).
- [Hosted Pub Repository Specification v2](https://github.com/dart-lang/pub/blob/master/doc/repository-spec-v2.md), seções sobre `advisoriesUpdated` e "List security advisories for a package".
- [`DEPS` do Dart SDK](https://github.com/dart-lang/sdk/blob/3.13.0/DEPS) (`pub_rev`) nas tags 3.12.x e 3.13.x, e o [manifesto de releases do Flutter](https://storage.googleapis.com/flutter_infra_release/releases/releases_macos.json) para o mapeamento de Flutter para Dart.
- [Troubleshooting pub](https://dart.dev/tools/pub/troubleshoot) no dart.dev.
