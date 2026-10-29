---
title: "Correção: flutter upgrade diz \"Your flutter checkout has local changes that would be erased by upgrading\""
description: "O flutter upgrade é abortado se o git status na pasta do SDK imprimir qualquer coisa. Inspecione, restaure o pubspec.lock ou use git stash -u, e deixe o --force como último recurso."
pubDate: 2026-10-29
template: error-page
tags:
  - "errors"
  - "flutter"
  - "flutter-3-47"
  - "git"
lang: "pt-br"
translationOf: "2026/10/fix-flutter-upgrade-your-flutter-checkout-has-local-changes"
translatedBy: "claude"
translationDate: 2026-10-29
---

O `flutter upgrade` executa `git status -s` dentro da pasta do SDK do Flutter e se recusa a continuar se isso imprimir uma única linha, incluindo arquivos não rastreados que você nunca pretendeu manter. Encontre o SDK com `flutter --version --machine` (o campo `flutterRoot`), execute `git status --short` lá e então restaure o arquivo (normalmente `pubspec.lock`), guarde suas edições com `git stash push -u` ou, se nada no SDK importa para você, execute `flutter upgrade --force`. Tudo abaixo foi verificado no Flutter 3.44.8 e 3.47.7/3.47.8 (stable, Dart 3.12.2) em 2026-10-29.

## O erro em contexto

Você executa `flutter upgrade` em uma máquina em que tem certeza de que nunca mexeu no próprio Flutter, e recebe isto:

```text
$ flutter upgrade
Your flutter checkout has local changes that would be erased by upgrading. If you want to keep these changes, it is recommended that you stash them via "git stash" or else commit the changes to a local branch. If it is okay to remove local changes, then re-run this command with "--force".
```

O código de saída é 1 e nada mudou. A mensagem fala do checkout git do **SDK**, não do repositório do seu app. O `git status` do seu app pode estar completamente limpo e mesmo assim você verá o erro.

## Por que isso acontece

O SDK do Flutter é um clone git de `flutter/flutter`, e o `flutter upgrade` é essencialmente um `git fetch` mais um `git reset --hard <nova revisão>` com algumas verificações de segurança ao redor. O código relevante fica em `packages/flutter_tools/lib/src/commands/upgrade.dart`, e a ordem das operações importa:

1. `git fetch --tags`, depois resolve a revisão upstream da sua branch (`stable`, `beta`, `main`).
2. Se você já está nessa revisão, imprime "Flutter is already up to date" e sai com 0. **Nenhuma verificação de alterações locais acontece.**
3. Se `--verify-only` foi passado, imprime a versão disponível e sai.
4. Se o commit atual não tem uma tag de release reconhecível e você não passou `--force`, aborta com "Unknown flutter tag".
5. Se você não passou `--force` e `hasUncommittedChanges()` retorna true, aborta com o erro acima.
6. `git reset --hard <revisão upstream>`, depois relança a nova ferramenta com `flutter upgrade --continue` para fazer o precache dos artefatos, executar `pub upgrade` no seu projeto e executar `flutter doctor`.

`hasUncommittedChanges()` é um wrapper fino em torno de `git status -s`. No canal stable, qualquer saída não vazia é uma alteração. Desde o Flutter 3.47.0 ([PR #184997](https://github.com/flutter/flutter/pull/184997)), os canais beta e main ignoram linhas que terminam em `pubspec.lock`, porque o main grava restrições de SDK de desenvolvimento nesse arquivo por conta própria. O stable não recebe nenhuma exceção desse tipo.

Duas consequências decorrem diretamente do uso de `git status -s`:

- **Arquivos não rastreados contam.** Um `notes.txt` perdido na pasta do SDK bloqueia o upgrade, mesmo que o `git reset --hard` nunca fosse apagá-lo.
- **Arquivos ignorados pelo git não contam.** O `.gitignore` do SDK já cobre `.idea/`, `.vscode/*`, `.pub-cache/`, `.dart_tool/`, `bin/cache/`, `*.log` e todo `*.lock`, exceto o `/pubspec.lock` da raiz. O `.pub-cache/` foi adicionado depois da [issue #128635](https://github.com/flutter/flutter/issues/128635), em que uma instalação via snap mantinha o cache do pub dentro do SDK.

Então a pergunta real nunca é "tenho alterações locais", e sim "o que o `git status --short` imprime na pasta do SDK, e quem colocou isso lá".

## Repro mínimo

Reproduzi todos os casos em um clone de teste de `flutter/flutter` resetado para a tag `3.47.7`, uma versão atrás do `stable` (3.47.8). Para evitar executar código recém-clonado, conduzi a lógica de upgrade a partir do meu Flutter 3.44.8 instalado, usando a flag oculta `--working-directory` da ferramenta, que aponta o comando para outro checkout e pula a segunda metade reentrante. A verificação do canal stable é idêntica byte a byte entre 3.44.8 e 3.47.8.

```bash
# Flutter 3.44.8 tool, scratch checkout at 3.47.7, upstream stable = 3.47.8
C=~/scratch/flutter
git -C "$C" reset -q --hard 3.47.7

echo hi > "$C/notes.txt"                       # untracked file only
flutter upgrade --working-directory="$C"
# Your flutter checkout has local changes that would be erased by upgrading. ...
# exit=1
```

Veja o que cada cenário fez:

| Estado do checkout do SDK | `git status -s` | Resultado do `flutter upgrade` |
| --- | --- | --- |
| Limpo, uma versão atrás | (vazio) | Atualiza |
| `notes.txt` não rastreado | `?? notes.txt` | Bloqueado |
| Arquivos em `.idea/`, `.pub-cache/`, `debug.log` | (vazio, aparece só com `--ignored`) | Não bloqueado |
| `pubspec.lock` da raiz editado | ` M pubspec.lock` | Bloqueado |
| Código-fonte do framework editado + arquivo não rastreado, `--force` | ` M packages/flutter/...`, `?? notes.txt` | Atualiza; a edição no framework some, `notes.txt` continua lá |
| Já na 3.47.8 com `?? notes.txt` | `?? notes.txt` | "Flutter is already up to date", saída 0 |

A última linha explica um padrão confuso: o arquivo perdido fica lá por meses sem reclamação, e o erro só aparece no dia de uma release, quando finalmente há algo para o qual atualizar.

## A causa mais comum: o `pubspec.lock` do próprio SDK

Se o `git status --short` mostra ` M pubspec.lock` e mais nada, o Flutter modificou o próprio lockfile. O repositório do Flutter é um workspace do pub, e seu `pubspec.lock` da raiz é o único lockfile rastreado na árvore. Qualquer coisa que execute `pub upgrade` com a raiz do SDK como projeto o reescreve, porque pacotes publicados depois da release (por exemplo, um `objective_c` mais novo) satisfazem as mesmas restrições.

Até o Flutter 3.44.x inclusive, o `flutter upgrade` fazia exatamente isso consigo mesmo. O `flutter upgrade --continue` reentrante era iniciado com a raiz do SDK como diretório de trabalho, então a etapa "atualizar os pacotes do seu projeto" chamava `findProjectRoot()`, que sobe a partir do diretório atual procurando um `pubspec.yaml`, encontrava o do próprio SDK e executava `pub upgrade` nele. O upgrade tinha sucesso, deixava um lockfile sujo para trás, e o *próximo* upgrade falhava. Essa é a [issue #187977](https://github.com/flutter/flutter/issues/187977), e combina com os relatos de "só acontece em instalações que já foram atualizadas uma vez".

Você mesmo pode ver o desvio. Em um checkout limpo da tag `3.44.0`, executar `pub upgrade` na raiz do SDK com o Dart 3.12.2 (a linha do Dart que acompanha o 3.44) reescreveu o lockfile (14 inserções, 6 remoções):

```bash
# Flutter 3.44.0 checkout, Dart 3.12.2, 2026-10-29
cd ~/scratch/flutter && dart pub upgrade
git diff --stat
#  pubspec.lock | 20 ++++++++++++++------
```

```diff
       name: jni
-    version: "1.0.0"
+    version: "1.1.1"
       name: jni_flutter
-    version: "1.0.1"
+    version: "1.0.4+1"
       name: objective_c
-    version: "9.2.3"
+    version: "9.3.0"
```

`objective_c` 9.2.3 para 9.3.0 é exatamente o diff do relato da issue. O [PR #188794](https://github.com/flutter/flutter/pull/188794) corrigiu isso iniciando a segunda metade no seu diretório de trabalho original, e foi lançado no Flutter 3.47.0. Então, se você está na 3.44.x, espere este erro mais uma vez no caminho para a 3.47, e depois ele deve parar.

Há uma pegadinha nessa correção. A segunda metade agora executa `pub upgrade` em qualquer projeto que o `findProjectRoot()` encontre a partir do **seu** diretório atual, e essa função sobe pela árvore. Se você executa `flutter upgrade` de dentro da árvore do SDK, digamos `~/development/flutter/bin`, ela encontra o `pubspec.yaml` do SDK de novo e suja o lockfile também na 3.47. Execute os upgrades a partir do seu diretório home ou de uma pasta de app, nunca de dentro do SDK. (Executar a partir de uma pasta de app atualiza as dependências desse app, o que é outro assunto, tratado em [por que o `pubspec.lock` muda depois do `flutter upgrade`](/pt-br/2026/10/fix-pubspec-lock-modified-after-flutter-upgrade-or-switching-flutter-versions/).)

## Correção, em detalhes

### 1. Encontre o SDK e olhe antes de forçar

Não recorra ao `--force` primeiro. Descubra o que realmente está lá.

```bash
# Flutter 3.44+ on macOS / Linux (needs jq)
SDK="$(flutter --version --machine | jq -r .flutterRoot)"
git -C "$SDK" status --short
git -C "$SDK" diff --stat
```

```powershell
# Flutter 3.44+ on Windows PowerShell
$sdk = (flutter --version --machine | ConvertFrom-Json).flutterRoot
git -C $sdk status --short
git -C $sdk diff --stat
```

O `flutter doctor -v` imprime o mesmo caminho na linha "Flutter version X on channel Y at <path>" se você preferir não interpretar JSON. Em uma instalação via Homebrew cask, o `flutterRoot` é o checkout real (`/opt/homebrew/share/flutter` na minha máquina), não o symlink `bin/flutter`.

### 2a. Só o `pubspec.lock` está modificado: restaure-o

Este é o caso em que o Flutter o escreveu, descrito acima. O arquivo é regenerado de qualquer forma, então descarte a alteração e atualize normalmente:

```bash
# Flutter 3.44.x -> 3.47.x, stable channel
git -C "$SDK" checkout -- pubspec.lock
cd ~ && flutter upgrade
```

Executar o upgrade a partir de `~` evita que a segunda metade encontre um `pubspec.yaml` dentro do SDK.

### 2b. Você alterou arquivos do framework de propósito: guarde-os com stash

Talvez você tenha corrigido um widget enquanto perseguia um bug, ou adicionado um `debugPrint` dentro de `packages/flutter`. Se quiser essas edições de volta depois do upgrade, guarde-as com stash, incluindo arquivos não rastreados:

```bash
# Flutter 3.47.7 -> 3.47.8, verified 2026-10-29
git -C "$SDK" stash push -u -m "before flutter upgrade"
flutter upgrade
git -C "$SDK" stash pop
```

No meu repro isso atualizou limpo para a 3.47.8 e o `stash pop` restaurou tanto o `text.dart` modificado quanto o `notes.txt` não rastreado. Se os arquivos que você tocou mudaram no upstream entre as duas versões, o `stash pop` pode gerar conflito, que é o resultado honesto: seu patch foi escrito para uma versão diferente do framework.

Se você mantém patches de longa duração no framework, o stash é a ferramenta errada. Faça commit deles em uma branch local ou, melhor ainda, mantenha um fork e aponte um SDK específico do projeto para ele com um gerenciador de versões, para que o SDK que você atualiza não seja o que você modifica.

### 2c. Nada ali importa: `--force`

Quando o `git status --short` mostra apenas ruído que não interessa, force:

```bash
# Flutter 3.47.x, stable channel
flutter upgrade --force    # or: flutter upgrade -f
```

Saiba o que o `--force` faz, porque não é o que a maioria das pessoas supõe:

- Ele pula a verificação "Unknown flutter tag" e a verificação de alterações locais. Só isso.
- Depois executa `git reset --hard <revisão upstream>`. Edições em arquivos rastreados são descartadas sem backup, e quaisquer commits que você fez na sua branch `stable` local saem da branch, recuperáveis apenas via `git reflog`.
- Ele **não** apaga arquivos não rastreados. No meu repro, o `notes.txt` sobreviveu ao `--force` e ainda era listado pelo `git status` depois. Ele não bloqueou a execução seguinte só porque essa execução caiu em "already up to date" antes. Na próxima release, ele bloqueia de novo.

Para limpar os arquivos não rastreados de vez, veja a prévia e depois apague:

```bash
# Run inside the SDK folder; -n is a dry run
git -C "$SDK" clean -n -d
git -C "$SDK" clean -f -d
```

O `git clean` apaga arquivos permanentemente e respeita o `.gitignore`, então não vai tocar em `bin/cache/` nem em `.pub-cache/`. Leia a saída do `-n` antes de executar a versão real.

### 3. Impeça que volte

- Chegue ao Flutter 3.47.0 ou posterior, que contém a correção do diretório de trabalho reentrante.
- Nunca execute `flutter upgrade` de dentro da árvore do SDK.
- Não mantenha arquivos temporários, anotações ou projetos de experimento dentro da pasta do SDK. Crie os apps ao lado dela, não dentro.
- No Windows, não instale o SDK extraindo o arquivo compactado com "Extrair tudo" do Explorador de Arquivos. O Explorador não consegue criar alguns caminhos profundos do SDK (os goldens do app de cenário do iOS excedem o `MAX_PATH`), pula esses arquivos, e esses arquivos rastreados ausentes aparecem como excluídos no `git status`, o que bloqueia todos os upgrades futuros ([issue #193197](https://github.com/flutter/flutter/issues/193197), acompanhada em [#183172](https://github.com/flutter/flutter/issues/183172)). Instale com `git clone`, depois de habilitar caminhos longos no Git (`core.longpaths`) e no Windows, como descrevem os [documentos de upgrade do Flutter](https://docs.flutter.dev/install/upgrade). Se você já tem uma instalação assim, `git -C $sdk checkout -- .` depois de habilitar caminhos longos restaura os arquivos ausentes.

## Pegadinhas e erros parecidos

**"Unknown flutter tag. Abandoning upgrade to avoid destroying local changes."** Verificação diferente, mesma família. Ela dispara quando o `git describe` não encontra uma tag de release perto do seu commit, normalmente depois de um clone raso sem tags ou depois de fazer checkout de um commit arbitrário. Em um canal oficial, a mensagem manda usar o git diretamente; em outros casos, sugere `--force`. Busque as tags (`git -C "$SDK" fetch --tags`) antes de forçar.

**"Your Flutter checkout is currently not on a release branch."** Você está em um HEAD destacado, geralmente porque seguiu o conselho da documentação de fazer `git checkout <version>` para fixar uma versão. Execute `flutter channel stable` para voltar a uma branch e então atualize.

**"The current Flutter branch/channel is not tracking any remote repository."** Sua branch local não tem upstream. Reinstalar é a correção documentada; `git -C "$SDK" branch -u origin/stable` também funciona, se `origin` for o remoto oficial.

**Ruído de modo de arquivo ou de fim de linha.** Se o `git diff` no SDK mostra apenas linhas `old mode 100755` / `new mode 100644`, algo (um `chmod -R`, uma cópia entre sistemas de arquivos, uma pasta sincronizada) mudou as permissões. Se todos os arquivos aparecem como modificados no Windows, o checkout foi copiado com fins de linha diferentes. Nos dois casos, nada que importe para você mudou; `git -C "$SDK" checkout -- .` ou `--force` é a escolha certa. O `.gitattributes` do SDK usa `* text=auto`, então um clone novo é a saída mais limpa se a cópia estiver muito bagunçada.

**O erro aparece no CI.** Se uma imagem de CI faz cache do SDK entre execuções e um job anterior executou `flutter upgrade` em um SDK 3.44.x (ou de dentro da árvore do SDK), o checkout em cache carrega o lockfile sujo e toda etapa de upgrade seguinte falha. Fixe a versão em vez de atualizar no CI; veja [como direcionar várias versões do Flutter a partir de um único pipeline de CI](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).

**O `flutter upgrade` funcionou, mas seu projeto agora não resolve as dependências.** Isso é a segunda metade executando `pub upgrade` no seu app com os novos pins do SDK, não este erro. Comece por [corrigir "version solving failed" no pubspec.yaml](/pt-br/2026/05/fix-version-solving-failed-in-pubspec-yaml/).

## Veja também

- [Correção: pubspec.lock aparece como modificado depois do flutter upgrade ou de trocar de versão do Flutter](/pt-br/2026/10/fix-pubspec-lock-modified-after-flutter-upgrade-or-switching-flutter-versions/) cobre o mesmo desvio no lockfile do seu app em vez do SDK.
- [Como direcionar várias versões do Flutter a partir de um único pipeline de CI](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) para fixar SDKs em vez de atualizá-los no lugar.
- [Correção: "version solving failed" no pubspec.yaml](/pt-br/2026/05/fix-version-solving-failed-in-pubspec-yaml/) para o que pode quebrar logo depois de um upgrade.
- [Correção: flutter doctor --android-licenses falha com cmdline-tools 23](/pt-br/2026/09/fix-flutter-doctor-android-licenses-fails-with-cmdline-tools-23/), outro erro de ferramentas em que a correção depende de qual release do Flutter você usa.

## Fontes

- [`upgrade.dart` na branch stable](https://github.com/flutter/flutter/blob/stable/packages/flutter_tools/lib/src/commands/upgrade.dart), a ordem das verificações e a chamada a `git status -s`.
- [`findProjectRoot` em `os.dart`](https://github.com/flutter/flutter/blob/stable/packages/flutter_tools/lib/src/base/os.dart), a busca ascendente por `pubspec.yaml`.
- [PR #188794: Run re-entrant upgrade in original CWD](https://github.com/flutter/flutter/pull/188794), lançado na 3.47.0.
- [PR #184997: Ignore pubspec.lock dirty checkout modifications on non-stable channels](https://github.com/flutter/flutter/pull/184997), lançado na 3.47.0.
- [Issue #187977](https://github.com/flutter/flutter/issues/187977) (desvio do `objective_c` no stable), [issue #178777](https://github.com/flutter/flutter/issues/178777) (desvio no main), [issue #128635](https://github.com/flutter/flutter/issues/128635) (`.pub-cache` dentro do SDK), [issue #193197](https://github.com/flutter/flutter/issues/193197) (extração pelo Explorador do Windows).
- [Upgrading Flutter](https://docs.flutter.dev/install/upgrade) em docs.flutter.dev, incluindo a seção "Filename too long" do Windows.
