---
title: "Correção: flutter doctor reporta cmdline-tools component is missing"
description: "Instale o Android SDK Command-line Tools para que os binários fiquem em <sdk>/cmdline-tools/latest/bin, aponte ANDROID_HOME para a raiz do SDK e execute flutter doctor de novo."
pubDate: 2026-08-06
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "dart"
  - "tooling"
lang: "pt-br"
translationOf: "2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing"
translatedBy: "claude"
translationDate: 2026-08-06
---

A correção em uma frase: o `flutter doctor` está verificando se existe um diretório chamado `cmdline-tools` diretamente sob a raiz do seu Android SDK, e ele não existe. No Android Studio abra **Tools > SDK Manager > SDK Tools**, marque **Android SDK Command-line Tools (latest)** e clique em Apply. Sem o Android Studio, descompacte o arquivo do command-line tools de forma que os binários terminem em `<sdk-root>/cmdline-tools/latest/bin`, defina `ANDROID_HOME` apontando para `<sdk-root>` (não para a pasta `cmdline-tools`) e então execute `flutter doctor --android-licenses`. A linha "Android license status unknown" logo abaixo é uma consequência, não um segundo problema: a ferramenta de licenças é o `sdkmanager`, e o `sdkmanager` vem dentro do pacote que está faltando.

```text
[!] Android toolchain - develop for Android devices (Android SDK version 36.0.0)
    • Android SDK at C:\Users\mariu\AppData\Local\Android\Sdk
    ✗ cmdline-tools component is missing.
      Try installing or updating Android Studio.
      Alternatively, download the tools from https://developer.android.com/studio#command-line-tools-only and make sure to set the ANDROID_HOME environment variable.
      See https://developer.android.com/studio/command-line for more details.
    ✗ Android license status unknown.
      Run `flutter doctor --android-licenses` to accept the SDK licenses.
```

Tudo abaixo foi verificado com Flutter 3.44.7 stable (Dart 3.12.x), o canal stable em 2026-08-06, com um Android SDK contendo `cmdline-tools;19.0`, Build-Tools 36.0.0, Platform-Tools 37.0.0 e OpenJDK 21.0.11. A revisão mais alta do command-line tools no canal stable hoje é a 22.0.

## A verificação é um único teste de existência de diretório

Vale a pena saber o quão pouco o doctor faz aqui, porque isso explica a maioria dos casos confusos. Em `packages/flutter_tools/lib/src/android/android_workflow.dart` o validador faz isto:

```dart
// flutter_tools, stable channel, Flutter 3.44.7
_task = 'Validating Android SDK command line tools are available';
if (!androidSdk.cmdlineToolsAvailable) {
  messages.add(
    const ValidationMessage.error(
      'cmdline-tools component is missing.\n'
      'Try installing or updating Android Studio.\n'
      ...
    ),
  );
  return ValidationResult(ValidationType.missing, messages);
}
```

E `cmdlineToolsAvailable` em `android_sdk.dart` é uma linha só:

```dart
// flutter_tools, stable channel, Flutter 3.44.7
bool get cmdlineToolsAvailable =>
    directory.childDirectory('cmdline-tools').existsSync();
```

Nenhum binário é executado. Nenhuma versão é lida. O Flutter pega a raiz do SDK que resolveu, acrescenta `cmdline-tools` e chama `existsSync()`. Isso significa que só existem duas formas de ver essa mensagem: a pasta realmente não está lá, ou o Flutter resolveu uma raiz de SDK diferente daquela que você está olhando.

O segundo caso é comum o bastante para valer a pena detalhar a ordem de resolução que o Flutter usa, tirada de `locateAndroidSdk()`:

1. A chave `android-sdk` na configuração do próprio Flutter, definida por `flutter config --android-sdk <path>`.
2. A variável de ambiente `ANDROID_HOME`.
3. A variável de ambiente `ANDROID_SDK_ROOT`, que o Google marcou como obsoleta mas o Flutter ainda lê.
4. O caminho padrão da plataforma: `~/Android/Sdk` no Linux, `~/Library/Android/sdk` no macOS, `%LOCALAPPDATA%\Android\sdk` no Windows.
5. Uma última tentativa: varrer o PATH atrás de `aapt` (sob `build-tools/<version>/`) ou `adb` (sob `platform-tools/`), inferindo a raiz de onde eles estiverem.

Um `flutter config --android-sdk` obsoleto de dois notebooks atrás ganha de um `ANDROID_HOME` perfeitamente correto. O `flutter doctor -v` imprime o caminho que ele escolheu, e essa é a primeira linha a ler.

Depois que a pasta existe, uma busca separada encontra o executável de verdade. `getCmdlineToolsPath` tenta, nesta ordem:

1. `cmdline-tools/latest/bin/sdkmanager[.bat]`
2. a pasta `cmdline-tools/<version>/bin/sdkmanager[.bat]` de maior número
3. `tools/bin/sdkmanager[.bat]`, o layout anterior a 2020, que é ignorado para o `sdkmanager` porque ele é solicitado com `skipOldTools: true`

Ou seja, `latest` tem preferência, mas uma pasta com número de versão também funciona. Essa distinção importa em uma das pegadinhas mais abaixo.

## Reproduzindo em dez segundos

Numa máquina que funciona, o erro está a um rename de distância:

```bash
# Flutter 3.44.7 stable, Windows, Android SDK at %LOCALAPPDATA%\Android\Sdk
mv "$LOCALAPPDATA/Android/Sdk/cmdline-tools" "$LOCALAPPDATA/Android/Sdk/cmdline-tools.bak"
flutter doctor
```

Esse é o modo de falha inteiro. É também por isso que o conselho de "reinstale o Android Studio" costuma funcionar pelo motivo errado: uma instalação nova do Studio marca a caixa do command-line tools, então a pasta aparece.

## Correção 1: instalar pelo SDK Manager do Android Studio

Este é o caminho recomendado se você tem o Android Studio, porque o Studio também mantém o pacote atualizado.

1. **Tools > SDK Manager** (ou o ícone do SDK Manager na barra de ferramentas).
2. Selecione a aba **SDK Tools**.
3. Marque **Android SDK Command-line Tools (latest)**. Já que você está lá, confirme que **Android SDK Build-Tools** e **Android SDK Platform-Tools** também estão marcados, já que o Flutter precisa deles.
4. Clique em **Apply**, aceite a licença e espere o download.
5. Execute `flutter doctor --android-licenses` e aceite tudo, depois `flutter doctor` novamente.

Repare no sufixo "(latest)" no rótulo da caixa. Ele não é decoração: é o que faz o Studio instalar em `cmdline-tools/latest/` em vez de numa pasta numerada.

## Correção 2: instalar com o sdkmanager, se você já tem alguma versão

Se você tem qualquer command-line tools, mesmo uma antiga, use-a para instalar o pacote atual:

```bash
# Android SDK Command-line Tools 19.0, JDK 21
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --install "cmdline-tools;latest"
```

No Windows o binário é `sdkmanager.bat`. Se você quer um pin reproduzível para CI em vez de um alvo móvel, nomeie a revisão explicitamente:

```bash
# Pin for CI. 22.0 is the newest on the stable channel as of 2026-08-06.
sdkmanager --install "cmdline-tools;22.0"
```

Existe uma circularidade óbvia aqui: o `sdkmanager` mora dentro do `cmdline-tools`, então se o pacote está faltando você não pode usar o `sdkmanager` para instalá-lo. É para isso que serve a Correção 3.

## Correção 3: montar o pacote na mão

Este é o caminho para máquinas Linux sem interface gráfica, contêineres e qualquer um que não queira o Android Studio. Baixe o arquivo "Command line tools only" na página de download do Android Studio e então monte o layout que o tooling do Google espera. O arquivo descompacta numa pasta chamada literalmente `cmdline-tools`, o que fica um nível aquém do correto.

```bash
# Android SDK Command-line Tools, Linux, 2026-08
export ANDROID_HOME="$HOME/Android/Sdk"
mkdir -p "$ANDROID_HOME/cmdline-tools"
unzip -q commandlinetools-linux-*.zip -d /tmp/clt
mv /tmp/clt/cmdline-tools "$ANDROID_HOME/cmdline-tools/latest"
```

O layout de destino, que é o especificado pela documentação do SDK Manager:

```text
$ANDROID_HOME/
└── cmdline-tools/
    └── latest/
        ├── bin/
        ├── lib/
        ├── NOTICE.txt
        └── source.properties
```

Como referência, o `bin/` de uma instalação real da 19.0 (Windows, por isso os wrappers `.bat`) contém:

```text
apkanalyzer.bat  avdmanager.bat  d8.bat     lint.bat      profgen.bat
r8.bat           resourceshrinker.bat  retrace.bat  screenshot2.bat  sdkmanager.bat
```

Depois, persista o ambiente e coloque as ferramentas no PATH:

```bash
# ~/.bashrc or ~/.zshrc
export ANDROID_HOME="$HOME/Android/Sdk"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
```

`ANDROID_HOME` precisa ser a raiz do SDK. Apontá-la para `$HOME/Android/Sdk/cmdline-tools` ou para `.../cmdline-tools/latest/bin` é a versão autoinfligida mais comum desse erro, e produz exatamente a mesma mensagem porque `<esse caminho>/cmdline-tools` não existe.

Por fim, instale o resto do que o Flutter quer e verifique:

```bash
sdkmanager --install "platform-tools" "platforms;android-36" "build-tools;36.0.0"
sdkmanager --version
sdkmanager --list_installed
flutter doctor --android-licenses
flutter doctor -v
```

`sdkmanager --list_installed` é a verificação honesta. Na máquina em que este artigo foi escrito, ela imprime:

```text
Installed packages:
  Path                  | Version       | Description                             | Location
  cmdline-tools;19.0    | 19.0          | Android SDK Command-line Tools (latest) | cmdline-tools\latest
  build-tools;36.0.0    | 36.0.0        | Android SDK Build-Tools 36              | build-tools\36.0.0
  platform-tools        | 37.0.0        | Android SDK Platform-Tools              | platform-tools
  platforms;android-36  | 2             | Android SDK Platform 36, rev 2          | platforms\android-36
```

## Correção 4: dizer ao Flutter onde o SDK realmente está

Se a pasta existe e `sdkmanager --version` funciona mas o `flutter doctor` continua reclamando, o Flutter está olhando para outro lugar. Sobrescreva a ordem de resolução no primeiro passo:

```bash
flutter config --android-sdk "$HOME/Android/Sdk"
flutter doctor -v
```

Duas armadilhas aqui. `flutter config --android-studio-dir` é outra configuração, para a instalação do Studio e não para o SDK, e apontá-la para `.../cmdline-tools/latest/bin` é uma forma documentada de voltar a esse erro. E o `flutter config` escreve num arquivo de configuração de nível de usuário, então um valor definido uma vez segue você em todo projeto até que você o limpe com `flutter config --android-sdk ""`.

## Pegadinhas que parecem o mesmo erro

**"Observed package id 'cmdline-tools;19.0' in inconsistent location"**. Toda invocação do `sdkmanager` na minha máquina imprime isto:

```text
Warning: Observed package id 'cmdline-tools;19.0' in inconsistent location
'C:\Users\mariu\AppData\Local\Android\Sdk\cmdline-tools\latest'
(Expected 'C:\Users\mariu\AppData\Local\Android\Sdk\cmdline-tools\19.0')
```

É cosmético. O pacote instalado registra `Pkg.Path=cmdline-tools;19.0` no seu `source.properties`, mas o SDK Manager o colocou em `latest` porque é isso que o pacote "(latest)" significa. O `sdkmanager` continua funcionando, o `flutter doctor` continua passando. Não "conserte" isso renomeando `latest` para `19.0`: o Flutter ainda o encontraria pela busca com número de versão, mas o download automático de SDK do Gradle e a maioria dos scripts de CI têm `cmdline-tools/latest/bin` escrito na mão e quebrariam.

**Duas pastas `latest`**. Se você vir `latest` ao lado de `latest-2`, o SDK Manager instalou sobre um diretório que não conseguiu substituir, normalmente porque um processo `sdkmanager` ou `adb` mantinha um arquivo aberto. Apague `latest`, renomeie `latest-2` para `latest` e execute o `flutter doctor` de novo.

**`ANDROID_SDK_ROOT` definida mas `ANDROID_HOME` vazia**. O Flutter lê as duas e prefere `ANDROID_HOME`. O Gradle e o Android Gradle Plugin vêm se movendo na direção oposta há anos, e algumas ferramentas de terceiros hoje leem apenas `ANDROID_HOME`. Defina `ANDROID_HOME`; defina `ANDROID_SDK_ROOT` com o mesmo valor só se algo no seu toolchain ainda precisar dela.

**Uma mensagem diferente: "Android sdkmanager not found."** Por extenso: `Android sdkmanager not found. Update to the latest Android SDK and ensure that the cmdline-tools are installed to resolve this.` Essa é uma verificação posterior, e significa que a pasta passou no teste de existência mas nenhum binário `sdkmanager` foi encontrado sob `latest/bin` nem sob qualquer `bin` numerado. A causa usual é um unzip aninhado, `cmdline-tools/latest/cmdline-tools/bin/`, por mover a pasta do arquivo em vez do conteúdo dela.

**Uma terceira mensagem: "Android sdkmanager tool was found, but failed to run."** Por extenso: `Android sdkmanager tool was found, but failed to run ($sdkManagerPath): "$error".` O binário existe e está executando; alguma coisa dentro dele está lançando exceção. Execute-o diretamente para ver o stack trace real. O culpado clássico é `JAVA_HOME` apontando para um runtime antigo, o que aparece como `UnsupportedClassVersionError` com "class file version 61.0" (Java 17) contra um runtime que "recognizes class file versions up to 55.0" (Java 11). As command-line tools 11.0 e posteriores são compiladas para Java 17. JDKs mais novos não são problema na direção contrária: a 19.0 roda sem reclamar sobre o OpenJDK 21.0.11, verificado para este artigo.

**WSL e contêineres**. Não aponte um `ANDROID_HOME` do Linux para um SDK do Windows via `/mnt/c`. Os binários de Linux não estão lá, os bits de execução estão errados e você vai acabar perseguindo a variante "sdkmanager not found". Instale um SDK nativo dentro do ambiente Linux.

**Runners de CI**. No GitHub Actions, o `android-actions/setup-android` instala o command-line tools e o coloca no PATH antes de qualquer outra coisa rodar, o que elimina essa classe de falha do pipeline por completo. Fixe a revisão em vez de seguir o `latest` se você quer que builds de seis meses atrás continuem reproduzíveis, o mesmo raciocínio que se aplica quando você [mira várias versões do Flutter a partir de um único pipeline de CI](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).

**A linha de licenças não some sozinha**. Depois que o pacote estiver instalado, o `flutter doctor` ainda vai reportar `Android license status unknown` até você executar `flutter doctor --android-licenses` e aceitar cada uma. Num shell não interativo, `yes | flutter doctor --android-licenses` resolve.

## Relacionados

- [Correção: Gradle task assembleDebug failed with exit code 1 em um build Android do Flutter](/pt-br/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) -- a próxima parede em que você bate depois que o toolchain valida e o build realmente começa.
- [Correção: conflito de AndroidX durante um build Android do Flutter](/pt-br/2026/05/fix-androidx-conflict-during-flutter-android-build/) -- uma falha de Android no nível de dependências em vez do nível de SDK.
- [Como mirar várias versões do Flutter a partir de um único pipeline de CI](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) -- onde fixar a versão do SDK deixa de ser opcional.
- [Correção: Version solving failed em pubspec.yaml](/pt-br/2026/05/fix-version-solving-failed-in-pubspec-yaml/) -- o equivalente do lado Dart de um ambiente quebrado, com um diagnóstico bem diferente.
- [Correção: Gradle build failed to produce an .apk file em MAUI Android](/pt-br/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/) -- o mesmo encanamento do Android SDK visto do lado .NET.

## Fontes

- [Troubleshooting installation](https://docs.flutter.dev/install/troubleshoot), documentação do Flutter, que mostra o caminho do SDK Manager para exatamente essa saída do doctor.
- [sdkmanager](https://developer.android.com/tools/sdkmanager), documentação do Android Studio, para o layout `cmdline-tools/latest` exigido e as flags `--install`, `--list_installed`, `--sdk_root` e `--channel`.
- [Android SDK Command-Line Tools release notes](https://developer.android.com/tools/releases/cmdline-tools).
- `packages/flutter_tools/lib/src/android/android_workflow.dart` e `android_sdk.dart` no branch stable do [flutter/flutter](https://github.com/flutter/flutter), para o texto do validador e a ordem de resolução do SDK.
- [flutter/flutter#139288](https://github.com/flutter/flutter/issues/139288), em que quem reportou tinha apontado um caminho de configuração do Flutter para `cmdline-tools/latest/bin` em vez da raiz do SDK.
- [flutter/flutter#167413](https://github.com/flutter/flutter/issues/167413), um relato ainda aberto do doctor não detectando um SDK corretamente estruturado no Debian 12 com `ANDROID_SDK_ROOT` definida e `ANDROID_HOME` vazia.
- [android-actions/setup-android](https://github.com/android-actions/setup-android), para a abordagem de CI.
