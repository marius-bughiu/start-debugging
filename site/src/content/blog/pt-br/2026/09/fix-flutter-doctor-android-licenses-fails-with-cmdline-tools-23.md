---
title: "Correção: flutter doctor --android-licenses diz 'The --licenses option is no longer needed' com cmdline-tools 23"
description: "O cmdline-tools 23.0 aposentou o sdkmanager --licenses, então o Flutter anterior ao 3.47.3 informa status de licença desconhecido. Atualize o Flutter ou fixe o cmdline-tools 22.0."
pubDate: 2026-09-15
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "android-sdk"
  - "flutter-doctor"
lang: "pt-br"
translationOf: "2026/09/fix-flutter-doctor-android-licenses-fails-with-cmdline-tools-23"
translatedBy: "claude"
translationDate: 2026-09-15
---

Suas licenças provavelmente estão em ordem. O Android SDK Command-line Tools 23.0 descontinuou o `sdkmanager`, e o `sdkmanager --licenses` agora imprime um aviso de descontinuação mais "Warning: The --licenses option is no longer needed." e sai com código 0 sem pedir nada. O Flutter até a versão 3.47.2 analisa essa saída em busca de uma contagem de licenças, não encontra nenhuma e informa "Android license status unknown", independentemente do que existe no disco. Atualize para o Flutter 3.47.3 ou posterior (a correção também está no beta 3.48), que lê `<sdk>/licenses/` diretamente. Se você não puder atualizar, instale o cmdline-tools 22.0 e garanta que nenhuma cópia mais nova tenha ficado em `cmdline-tools/`.

Tudo o que vem a seguir foi reproduzido no macOS com Flutter 3.44.8 e Flutter 3.47.3, cmdline-tools 22.0 e 23.0 lado a lado em um SDK de rascunho, e OpenJDK 17.0.20.1.

## O erro como o flutter doctor o imprime

`flutter doctor -v` sinaliza o Android toolchain mesmo com todo o resto verde:

```text
[!] Android toolchain - develop for Android devices (Android SDK version 36.1.0)
    • Android SDK at /Users/you/Library/Android/sdk
    • Platform android-36, build-tools 36.1.0
    • Java version OpenJDK Runtime Environment Homebrew (build 17.0.20.1+0)
    ✗ Android license status unknown.
      Run `flutter doctor --android-licenses` to accept the SDK licenses.
      See https://flutter.dev/to/macos-android-setup for more details.
```

Você faz o que ele manda e, em vez do conhecido prompt "Review licenses that have not been accepted (y/N)?", recebe isto, seguido de uma saída imediata com código 0:

```text
WARNING: The SDK Manager CLI tool (sdkmanager) is deprecated. Android CLI will be used instead.
The 'android' binary can also be found in the cmdline-tools directory, and 'android sdk' is the replacement for 'sdkmanager'.
To learn more about the Android CLI and how to use it, see the documentation (https://d.android.com/tools/agents/android-cli)

Warning: The --licenses option is no longer needed.
```

Rode `flutter doctor` de novo e a linha "license status unknown" continua lá. Esse loop é o bug inteiro, relatado como [flutter/flutter#191487](https://github.com/flutter/flutter/issues/191487) (macOS, Flutter 3.47.1) e novamente como [#191558](https://github.com/flutter/flutter/issues/191558) (Windows 11) e [#191963](https://github.com/flutter/flutter/issues/191963) (Windows 10, Flutter 3.47.2).

## Por que o Flutter não consegue saber se suas licenças foram aceitas

O `AndroidLicenseValidator` do Flutter não lê os arquivos de licença por conta própria. Ele executa `sdkmanager --licenses`, lê o stdout linha por linha e aplica três expressões regulares. Este é o código em `packages/flutter_tools/lib/src/android/android_workflow.dart` na tag 3.44.8:

```dart
// Flutter 3.44.8, packages/flutter_tools/lib/src/android/android_workflow.dart
final licenseCounts = RegExp(r'(\d+) of (\d+) SDK package licenses? not accepted.');
final licenseNotAccepted = RegExp(r'licenses? not accepted', caseSensitive: false);
final licenseAccepted = RegExp(r'All SDK package licenses accepted.');
```

Se uma delas corresponder, o status passa a ser `some`, `none` ou `all`. Se nenhuma corresponder, o validador retorna `LicensesAccepted.unknown`, que é a linha que você está encarando.

O cmdline-tools 22.0 já imprime o aviso de descontinuação, mas ainda faz o trabalho das licenças depois dele, então as regexes ainda encontram sua linha. Com o meu SDK de rascunho, em que só `android-sdk-license` estava presente, o 22.0 imprimiu:

```text
Loading local repository...

6 of 7 SDK package licenses not accepted.
Review licenses that have not been accepted (y/N)?
```

O cmdline-tools 23.0 elimina essa parte por completo. Rodei o `sdkmanager --licenses` do 23.0 duas vezes, uma com a pasta `licenses/` presente e outra com ela renomeada. A saída foi idêntica nas duas: o aviso, o warning "no longer needed", código de saída 0. A ferramenta não informa mais o estado das licenças de forma alguma, então não há nada para o Flutter analisar. O autor do PR de correção chegou à mesma conclusão e também não encontrou nenhum subcomando de status de licença na nova CLI `android`.

A segunda metade do loop vem do mesmo lugar. `flutter doctor --android-licenses` é só um wrapper que executa `sdkmanager --licenses` de forma interativa e repassa o que você digita. Quando o 23.0 imprime o warning e sai, não há nada para aceitar, e o Flutter não tem nada novo para ler na próxima execução do `flutter doctor`.

## Reproduzindo: a matriz de versões

Para ter certeza de que essa era a história toda, montei uma raiz de SDK de rascunho com `cmdline-tools/22.0` e `cmdline-tools/23.0`, apontei `ANDROID_HOME` para ela e rodei `flutter doctor -v` com cada combinação. O Flutter procura primeiro `cmdline-tools/latest/bin/sdkmanager` e depois recorre à pasta versionada de número mais alto, então esconder a pasta `23.0` basta para alternar.

| Flutter | cmdline-tools | `licenses/` no disco | `flutter doctor` diz |
| --- | --- | --- | --- |
| 3.44.8 | 22.0 | apenas `android-sdk-license` | Some Android licenses not accepted |
| 3.44.8 | 22.0 | ausente | Android licenses not accepted |
| 3.44.8 | 23.0 | apenas `android-sdk-license` | Android license status unknown |
| 3.44.8 | 23.0 | ausente | Android license status unknown |
| 3.47.3 | 23.0 | apenas `android-sdk-license` | All Android licenses accepted |
| 3.47.3 | 23.0 | ausente | Android licenses not accepted |
| 3.47.3 | 23.0 | `android-sdk-license` presente, mas vazio | Android licenses not accepted |

Em um Flutter sem a correção, o 23.0 transforma todo estado em "unknown". No 3.47.3, a resposta volta a depender dos arquivos.

## Correção 1: atualize o Flutter para 3.47.3 ou posterior

A correção é o [flutter/flutter#191554](https://github.com/flutter/flutter/pull/191554), mesclado no master em 2026-08-29 e aplicado via cherry-pick no stable ([#192133](https://github.com/flutter/flutter/pull/192133)) e no beta ([#192132](https://github.com/flutter/flutter/pull/192132)) em 2026-09-02. As primeiras versões que o contêm são a stable 3.47.3 e a beta 3.48.0-0.4.pre. A entrada do hotfix 3.47.3 no `CHANGELOG.md` cita o #191487 pelo nome.

```bash
# Flutter 3.47.x stable channel
flutter channel stable
flutter upgrade
flutter --version   # expect 3.47.3 or later
flutter doctor -v
```

O que o patch faz é limitado. Ele adiciona mais uma regex, `--licenses option is no longer needed`. Quando essa linha aparece e nenhum dos padrões antigos correspondeu, o Flutter para de confiar no stdout e lista `<sdk>/licenses/`. Qualquer arquivo não oculto e não vazio ali significa `all`. Nenhum arquivo utilizável significa `none`. Se o diretório não puder ser listado, o resultado é `unknown`. Versões mais antigas do `sdkmanager` continuam passando pela análise original, sem alterações.

Se você está preso a uma linha mais antiga do Flutter (3.44.x, 3.41.x), não há backport. Os cherry-picks só foram para os branches candidatos 3.47 e 3.48, então nessas linhas use a Correção 3 ou conviva com o aviso cosmético.

## Correção 2: confirme que as licenças estão mesmo no disco

Antes de assumir que a linha do doctor está mentindo, verifique. A aceitação das licenças sempre foi registrada como arquivos de hash sob a raiz do SDK, e é isso que o Gradle lê quando decide se pode baixar automaticamente uma plataforma ou um pacote build-tools ausente:

```bash
# any OS with a POSIX shell; ANDROID_HOME points at the SDK root
ls -la "$ANDROID_HOME/licenses"
cat "$ANDROID_HOME/licenses/android-sdk-license"
```

Em uma máquina funcionando você verá pelo menos `android-sdk-license`, contendo um ou mais hashes de 40 caracteres como `24333f8a63b6825ea9c5514f83c2829b004d1fee`. Se o arquivo estiver lá, `flutter build apk` funciona independentemente do que um `flutter doctor` sem a correção diga. Quem relatou o issue percebeu a mesma coisa: os builds de APK continuavam dando certo.

Se a pasta estiver ausente, por exemplo em uma imagem de CI recém-criada, o cmdline-tools 23.0 mudou a forma de obtê-la. Não há mais prompt. Instalar qualquer pacote grava o arquivo de licença para você. Testei isso em duas raízes de SDK vazias, apenas com o cmdline-tools 23.0 copiado como `latest`:

```bash
# cmdline-tools 23.0, fresh SDK root with no licenses/ folder
"$ANDROID_HOME/cmdline-tools/latest/bin/android" --no-metrics --sdk="$ANDROID_HOME" sdk install platform-tools

# or, the deprecated spelling, which forwards to the same code
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$ANDROID_HOME" --install platform-tools
```

Os dois comandos saíram com código 0 com o stdin fechado, baixaram `platform-tools_r37.0.1` e deixaram `licenses/android-sdk-license` com o hash `24333f8a...`. Isso basta para o Flutter 3.47.3 informar "All Android licenses accepted". Repare nos nomes dos pacotes: o novo `android sdk install` usa barras (`platforms/android-36`, `build-tools/36.0.0`), e não os pontos e vírgulas que o `sdkmanager` usava.

## Correção 3: fixe o cmdline-tools 22.0 em um Flutter mais antigo

Se você está preso a uma versão do Flutter sem a correção e quer a linha do doctor limpa, dê ao Flutter um `sdkmanager` que ainda imprima contagens de licenças. O Flutter escolhe `cmdline-tools/latest` primeiro, então instalar o 22.0 ao lado de um `latest` 23.0 não muda nada. Você precisa tirar o 23.0 do caminho.

No Android Studio, abra **Settings > Languages & Frameworks > Android SDK > SDK Tools**, marque **Show Package Details**, desmarque **Android SDK Command-line Tools (latest)**, marque **22.0** e aplique. Esse é o workaround que quem relatou o #191558 confirmou.

Pelo terminal:

```bash
# macOS/Linux, cmdline-tools 23.0 currently installed as cmdline-tools/latest
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --install "cmdline-tools;22.0"
mv "$ANDROID_HOME/cmdline-tools/latest" "$HOME/cmdline-tools-23.0-backup"
ls "$ANDROID_HOME/cmdline-tools"   # only 22.0 should remain
flutter doctor --android-licenses
```

A instalação vai para `cmdline-tools/22.0` e, sem o `latest`, o Flutter recorre a essa pasta versionada. `flutter doctor --android-licenses` volta então a mostrar o prompt interativo de verdade, e você pode aceitar as que faltam. Em um shell não interativo, `yes | flutter doctor --android-licenses` ainda funciona no 22.0.

Dois alertas sobre esse caminho. Primeiro, é uma fixação de versão, e o próximo "update all" no Android Studio vai colocar o 23.0 de volta como `latest`. Segundo, algumas ferramentas têm `cmdline-tools/latest/bin` fixo no código (o download automático de SDK do Gradle, muitos scripts de CI). Depois que as licenças forem aceitas, é mais limpo atualizar o Flutter e deixar o 23.0 voltar do que manter o 22.0 para sempre.

## Armadilhas e problemas parecidos

**"All Android licenses accepted" no 3.47.3 é mais generoso do que antes.** O fallback baseado no disco não consegue distinguir `some` de `all`. Com apenas `android-sdk-license` presente, o 22.0 dizia "6 of 7 SDK package licenses not accepted" e o Flutter antigo dizia "Some Android licenses not accepted". O 3.47.3 com o 23.0 diz "All Android licenses accepted". Para builds comuns isso está correto, já que `android-sdk-license` cobre plataformas, build-tools, platform-tools e o NDK. As imagens de sistema de preview, TV e XR têm seus próprios arquivos de licença (são as outras seis na contagem do 22.0), então, se você instalar uma delas, procure o arquivo correspondente em `licenses/` em vez de confiar na linha do doctor.

**Um arquivo de licença vazio conta como não aceito.** Algumas receitas de CI fazem `touch` no arquivo para simular a aceitação. No 3.47.3, um `android-sdk-license` de zero bytes resulta em "Android licenses not accepted". Grave o hash real ou, melhor ainda, deixe o `android sdk install` criá-lo.

**Scripts de CI que fazem grep na saída do doctor.** Um passo como `flutter doctor -v | grep "All Android licenses accepted"` falha em todo Flutter sem a correção com o 23.0. `yes | flutter doctor --android-licenses` não falha mais, mas também não faz mais nada. Verifique o arquivo em vez disso: `test -s "$ANDROID_HOME/licenses/android-sdk-license"`. Se você testa várias versões do Flutter em um único pipeline, como em [direcionar várias versões do Flutter a partir de um único pipeline de CI](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/), espere que as pernas mais antigas da matriz imprimam "unknown" enquanto o 3.47.3 e posteriores passam.

**O binário `android` se instala sozinho no primeiro uso.** Na primeira vez que rodei `cmdline-tools/23.0/bin/android`, ele imprimiu "Downloading Android CLI...", descompactou em `~/.android/cli` e mostrou os termos de serviço do SDK e um aviso sobre métricas de uso. Adicione `--no-metrics` no CI. `android --version` informou `1.0.16261425` com o cmdline-tools 23.0. O binário também existe no 22.0.

**"Unable to locate Android SDK" é outro problema.** Enquanto eu montava o SDK de rascunho, minha primeira execução do doctor falhou antes mesmo de chegar à verificação de licenças, porque a raiz tinha o cmdline-tools, mas nenhum `platforms` ou `build-tools`. Se você vir essa linha, ou "cmdline-tools component is missing", a correção está [no post sobre cmdline-tools component is missing](/pt-br/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/), não aqui.

**`flutter config --android-sdk` tem prioridade sobre `ANDROID_HOME`.** Se em algum momento você definiu um caminho com `flutter config`, o Flutter ignora `ANDROID_HOME` e pode estar verificando um SDK diferente daquele que você está inspecionando. `flutter config --list` mostra o caminho armazenado, e `flutter doctor -v` imprime o caminho que realmente usou na linha "Android SDK at".

**A nova CLI ainda não está integrada ao Flutter.** Um PR aberto, o [#191826](https://github.com/flutter/flutter/pull/191826), também move o provisionamento do NDK do Flutter para `android sdk install`. Em 2026-09-15 ele não foi mesclado, então o Flutter 3.47.3 ainda invoca o `sdkmanager` descontinuado para as licenças e depende de ele manter as flags antigas funcionando.

## Relacionados

- [Correção: flutter doctor informa cmdline-tools component is missing](/pt-br/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/) cobre a ordem de busca do SDK pelo Flutter e os requisitos de Java do `sdkmanager`, que também se aplicam aqui.
- Se é o Gradle, e não o doctor, que está reclamando do seu JDK, veja [Toolchain installation does not provide the required capabilities](/pt-br/2026/08/fix-toolchain-installation-does-not-provide-the-required-capabilities-in-flutter/).
- Um download corrompido do SDK aparece de forma diferente: [NDK (Side by side): Not in GZIP format](/pt-br/2026/08/fix-an-error-occurred-while-preparing-sdk-package-ndk-not-in-gzip-format/).
- Outro caso em que uma versão de hotfix é a verdadeira correção: [Could not create Dart VM instance após flutter upgrade](/pt-br/2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build/).

## Fontes

- [flutter/flutter#191487](https://github.com/flutter/flutter/issues/191487), o issue de acompanhamento P1, com as duplicatas [#191558](https://github.com/flutter/flutter/issues/191558) e [#191963](https://github.com/flutter/flutter/issues/191963).
- [flutter/flutter#191554](https://github.com/flutter/flutter/pull/191554), a correção, com os cherry-picks para stable e beta [#192133](https://github.com/flutter/flutter/pull/192133) e [#192132](https://github.com/flutter/flutter/pull/192132).
- [flutter/flutter#191826](https://github.com/flutter/flutter/pull/191826), o PR aberto para suporte completo à Android CLI.
- [CHANGELOG do Flutter na 3.47.3](https://github.com/flutter/flutter/blob/3.47.3/CHANGELOG.md) e [`android_workflow.dart` na 3.47.3](https://github.com/flutter/flutter/blob/3.47.3/packages/flutter_tools/lib/src/android/android_workflow.dart).
- [Documentação da Android CLI](https://developer.android.com/tools/agents/android-cli) para a sintaxe de `android sdk install`, `list`, `update` e `remove`.
- [Documentação do sdkmanager](https://developer.android.com/tools/sdkmanager).
