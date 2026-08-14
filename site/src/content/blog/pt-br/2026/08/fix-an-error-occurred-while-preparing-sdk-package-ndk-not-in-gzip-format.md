---
title: "Correção: An error occurred while preparing SDK package NDK (Side by side): Not in GZIP format"
description: "O SDK Manager está reextraindo um arquivo corrompido que ele guardou em .downloadIntermediates. Apague essa pasta e o diretório ndk/<version> pela metade, e compile de novo."
pubDate: 2026-08-14
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "ndk"
lang: "pt-br"
translationOf: "2026/08/fix-an-error-occurred-while-preparing-sdk-package-ndk-not-in-gzip-format"
translatedBy: "claude"
translationDate: 2026-08-14
---

Apague o cache de download do SDK Manager e o diretório do NDK parcialmente extraído, e compile de novo. O arquivo que ele está extraindo está corrompido e, como ele guarda esse arquivo em cache, vai falhar de forma idêntica em toda tentativa até você removê-lo. No Windows isso é `%LOCALAPPDATA%\Android\Sdk\.downloadIntermediates` mais `%LOCALAPPDATA%\Android\Sdk\ndk\28.2.13676358`. Se falhar de novo com o cache limpo, você está atrás de um proxy ou de um antivírus que intercepta TLS e reescreve um download de 750 MB, e a resposta é instalar o NDK na mão a partir de `dl.google.com`.

## O erro, completo

A mensagem aparece no meio da compilação, normalmente durante a fase de configuração do Gradle, e é uma linha de aviso em vez da falha de nível superior:

```
Preparing "Install NDK (Side by side) 28.2.13676358 v.28.2.13676358".
Warning: An error occurred while preparing SDK package NDK (Side by side) 28.2.13676358: Not in GZIP format.

FAILURE: Build failed with an exception.
```

Embaixo dela há um `java.util.zip.ZipException: Not in GZIP format` lançado de dentro do `GZIPInputStream`, e o número da versão varia conforme o que seu projeto fixa. As duas coisas que identificam essa falha específica são o nome do pacote `NDK (Side by side)` e o fato de ela se reproduzir byte a byte em toda tentativa, inclusive depois de reiniciar a máquina, de um `flutter clean` e de reiniciar o Android Studio. Uma rede genuinamente instável produz um erro diferente a cada vez. Essa não.

## O que faz uma build do Flutter baixar o NDK?

Esta é a parte que pega as pessoas de surpresa: um aplicativo Flutter sem código nativo, sem C++ e sem bloco `externalNativeBuild` ainda assim baixa um NDK de 750 MB na primeira build. Isso é deliberado, e é coisa do Flutter e não do Android Gradle Plugin.

O AGP precisa do NDK para remover os símbolos de depuração das bibliotecas nativas, mas só baixa o NDK quando acha que está compilando código nativo. O Flutter sempre distribui bibliotecas nativas (o engine e o seu Dart compilado com AOT), então precisa dessa remoção de símbolos e por isso engana o AGP para que ele busque o toolchain. Verificado contra uma instalação local do Flutter 3.44.2 stable, o `FlutterPlugin.kt` chama isso incondicionalmente na linha 228:

```kotlin
// Flutter 3.44.2, packages/flutter_tools/gradle/src/main/kotlin/FlutterPluginUtils.kt
internal fun forceNdkDownload(gradleProject: Project, flutterSdkRootPath: String) {
    val gradleProjectAndroidExtension = getLegacyAndroidExtension(gradleProject)
    val forcingNotRequired: Boolean =
        gradleProjectAndroidExtension.externalNativeBuild.cmake.path != null
    if (forcingNotRequired) {
        return
    }

    // Otherwise, point to an empty CMakeLists.txt, and ignore associated warnings.
    gradleProjectAndroidExtension.externalNativeBuild.cmake.path(
        "$flutterSdkRootPath/packages/flutter_tools/gradle/src/main/scripts/CMakeLists.txt"
    )
    // ...
}
```

O `CMakeLists.txt` para o qual ele aponta é um arquivo vazio cujo único propósito é fazer o AGP acreditar que há código nativo a compilar. Ou seja, o download do NDK não é opcional, não dá para pular, e toda máquina nova ou todo runner de CI novo esbarra nele. Um download de três quartos de gigabyte que roda uma vez por ambiente é exatamente o perfil que produz arquivos truncados.

A versão que está sendo baixada vem do Flutter, não de você. Na mesma instalação, `packages/flutter_tools/lib/src/android/gradle_utils.dart` linha 68:

```dart
// Flutter 3.44.2, packages/flutter_tools/lib/src/android/gradle_utils.dart
const ndkVersion = '28.2.13676358';
```

Esse é o NDK r28c. Conferi a cópia instalada nesta máquina e `ndk/28.2.13676358/source.properties` diz `Pkg.ReleaseName = r28c`, então a correspondência entre revisão e versão não é um chute.

## Por que o arquivo não passa na verificação de GZIP?

Ordenadas pela frequência com que cada uma é a causa real.

**Um arquivo corrompido em cache em `.downloadIntermediates`.** O SDK Manager prepara o download de um pacote em `<sdk>/.downloadIntermediates` antes de extraí-lo. Se a conexão caiu, o disco encheu ou o processo morreu no meio do caminho, um arquivo truncado fica nesse diretório. O downloader trata o arquivo em cache como um download retomável e o entrega direto ao extrator na tentativa seguinte, então tentar de novo reproduz a mesma exceção para sempre. É o caso na grande maioria dos relatos, e é por isso que "eu já tentei cinco vezes" não é prova em contrário.

**Um proxy ou antivírus com inspeção de TLS reescrevendo a resposta.** O `GZIPInputStream` lança exatamente essa string quando os dois primeiros bytes não são o número mágico do gzip `1f 8b`. Um proxy corporativo que responde com uma página HTML de bloqueio, um portal cativo que intercepta a requisição ou um scanner que define `Content-Encoding: gzip` num corpo que ele não comprimiu de fato produzem um fluxo que falha na verificação do número mágico logo no primeiro byte. O sinal é que limpar o cache não ajuda: você recebe um download novo e igualmente inválido.

**Um disco cheio.** Um download de 750 MB mais uma extração de 4 GB precisa de uma folga que o SDK Manager não verifica de antemão. Ele escreve o que consegue e o resultado truncado falha do mesmo jeito.

## Como limpo o cache de download e o NDK pela metade?

Feche o Android Studio primeiro, já que no Windows ele mantém handles abertos nesses diretórios. A raiz do SDK é `%LOCALAPPDATA%\Android\Sdk` no Windows, `~/Library/Android/sdk` no macOS e `~/Android/Sdk` no Linux.

```bash
# macOS / Linux. Adjust SDK for your platform.
SDK="$HOME/Library/Android/sdk"
rm -rf "$SDK/.downloadIntermediates" "$SDK/.temp" "$SDK/temp" "$SDK/downloadIntermediates"
rm -rf "$SDK/ndk/28.2.13676358"
```

```powershell
# Windows PowerShell
$sdk = "$env:LOCALAPPDATA\Android\Sdk"
Remove-Item -Recurse -Force "$sdk\.downloadIntermediates","$sdk\.temp","$sdk\temp","$sdk\downloadIntermediates" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$sdk\ndk\28.2.13676358" -ErrorAction SilentlyContinue
```

As duas grafias, com e sem ponto inicial, aparecem conforme a versão do Android Studio, então apague as que existirem e ignore as que não. Na instalação que inspecionei para este artigo o SDK traz `.temp` com ponto inicial.

Apagar o diretório `ndk/<version>` importa tanto quanto limpar o cache, e é o passo que quase todo guia pula. Continue lendo para ver por quê.

## E se a próxima build falhar com CXX1101?

Isso acontece porque a extração falha deixou para trás um diretório parcial, e agora outro caminho de código o encontra.

```
> [CXX1101] NDK at /Users/you/Library/Android/sdk/ndk/28.2.13676358
  did not have a source.properties file
```

O AGP resolve um NDK instalado lendo `source.properties` dentro de `ndk/<revision>/`. O SDK Manager escreve esse arquivo por último, depois que o pacote é extraído por completo, justamente para que uma instalação pela metade não seja confundida com uma boa. Quando a extração morre no erro de gzip você fica com um diretório cheio de arquivos do toolchain e sem `source.properties`, que não é nem ausente nem válido.

A partir daí o SDK Manager vê um diretório no caminho esperado e não baixa de novo, enquanto o AGP não vê `source.properties` e se recusa a usá-lo. A build fica presa entre dois componentes que discordam sobre a existência do pacote, e a mensagem de erro muda para algo que parece não ter relação. É por isso que muitas threads sobre o assunto terminam com gente definindo `ndk.dir` em `local.properties` ou fixando uma versão mais antiga do NDK: estão contornando o segundo erro sem nunca ter limpado o primeiro. Apague o diretório e os dois somem juntos.

Para referência, uma cópia corretamente instalada contém os dois arquivos:

```
ndk/28.2.13676358/source.properties   # Pkg.Revision = 28.2.13676358, Pkg.ReleaseName = r28c
ndk/28.2.13676358/package.xml         # written by the SDK Manager, not present in the standalone zip
```

## Como instalo o NDK pela linha de comando?

Tirar o Gradle e o Android Studio do caminho deixa a falha muito mais fácil de ler, e o `sdkmanager` imprime o stack trace por baixo em vez de um aviso de uma linha só. O binário fica em `<sdk>/cmdline-tools/latest/bin`. Se ele não estiver lá, [instalar as Android SDK Command-line Tools](/pt-br/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/) é o pré-requisito.

```bash
# Android SDK Command-line Tools 19.0, NDK r28c
cd "$HOME/Library/Android/sdk/cmdline-tools/latest/bin"
./sdkmanager --install "ndk;28.2.13676358" --verbose
```

Se você está atrás de um proxy, passe-o explicitamente em vez de contar com as configurações do Studio, que o `sdkmanager` não lê:

```bash
./sdkmanager --install "ndk;28.2.13676358" \
  --proxy=http --proxy_host=proxy.corp.example --proxy_port=8080
```

Não recorra a `--no_https` como solução. Ele rebaixa a transferência para HTTP simples, o que deixa um proxy interceptador mais propenso a estragar o corpo, não menos. Ele existe para ambientes que bloqueiam CONNECT por completo.

## Como instalo o NDK na mão quando o downloader continua falhando?

Essa é a saída de emergência confiável numa rede restrita, porque move o download para uma ferramenta que você controla e deixa você verificar os bytes.

1. Baixe o arquivo avulso de `https://dl.google.com/android/repository/android-ndk-r28c-linux.zip`, trocando por `windows` no Windows. O macOS entrega um `.dmg` em vez de um zip nessa URL, então monte-o e copie o conteúdo.

2. Verifique o SHA-1 contra o valor publicado na página de downloads do NDK antes de confiar nele. Para o r28c o zip de Linux tem 722.261.334 bytes com SHA-1 `a7b54a5de87fecd125a17d54f73c446199e72a64`, e o de Windows tem 748.118.221 bytes com SHA-1 `086bba43ff2f5eb0e387b15c8278bb4e0d89ba1d`. Se o hash estiver errado, seu proxy está confirmado como culpado e nenhuma limpeza de cache vai ajudar.

```bash
# Verify, then unpack. NDK r28c.
sha1sum android-ndk-r28c-linux.zip
unzip -q android-ndk-r28c-linux.zip
```

3. Renomeie o diretório extraído `android-ndk-r28c` para o número da revisão e mova-o para dentro do SDK. É a revisão, não o nome da versão, que o AGP procura:

```bash
mv android-ndk-r28c "$HOME/Android/Sdk/ndk/28.2.13676358"
cat "$HOME/Android/Sdk/ndk/28.2.13676358/source.properties"
# Pkg.Revision = 28.2.13676358
```

4. Compile. O AGP lê `source.properties` e aceita o toolchain. A única diferença em relação a uma instalação gerenciada é o `package.xml` que falta, então o `sdkmanager --list_installed` não vai reportar o pacote. Isso é cosmético para a build, mas importa se o seu CI valida a listagem de pacotes em vez do diretório.

## De qual versão do NDK meu projeto precisa de verdade?

A que o seu projeto fixar e, por padrão, o Flutter fixa por você. Em agosto de 2026:

| Papel | Versão do NDK | String de revisão |
| --- | --- | --- |
| Padrão do Flutter 3.44 | r28c | `28.2.13676358` |
| Última estável | r29 | `29.0.14206865` |
| Última LTS | r27d | `27.3.13750724` |

Não "conserte" esse erro caindo para um NDK que por acaso já está em cache na sua máquina. O NDK r28 é a primeira versão que compila bibliotecas compartilhadas alinhadas para páginas de memória de 16 KB, que o Google Play agora exige, então descer para o r27 para desviar de um problema de download troca uma falha de build por [uma rejeição na loja](/pt-br/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/).

Às vezes você precisa mesmo subir a versão, quando um plugin exige um toolchain mais novo que o padrão do Flutter. O Flutter detecta isso e te diz exatamente o que escrever:

```
Your project is configured with Android NDK 28.2.13676358, but the following
plugin(s) depend on a different Android NDK version:
- some_plugin requires Android NDK 29.0.14206865
Fix this issue by using the highest Android NDK version (they are backward compatible).
```

```kotlin
// android/app/build.gradle.kts, AGP 8.x
android {
    ndkVersion = "29.0.14206865"
}
```

Mudar essa string inicia um download novo de um pacote diferente, então se você ainda está numa rede que corrompe transferências grandes, instale a nova revisão na mão antes de mudar o valor fixado. Caso contrário você vai ver o mesmo erro mudar de número de versão.

## Pegadinhas que produzem a mesma mensagem por outro motivo

**Imagens de Docker e de CI com pouco orçamento de camada.** Um contêiner de build que fica sem espaço de escrita no meio da extração falha igual a um download truncado. Confira o espaço livre no volume do SDK antes de culpar a rede. Deixar o NDK pré-instalado na imagem é a solução duradoura, e remove um download de 750 MB de cada job.

**Duas builds disputando um mesmo SDK.** Jobs de CI em paralelo que compartilham um diretório de SDK montado intercalam escritas em `.downloadIntermediates` e corrompem os arquivos um do outro. Dê a cada job o seu próprio `ANDROID_SDK_ROOT`, ou serialize a instalação da primeira execução.

**`Failed to install the following Android SDK packages as some licences have not been accepted`.** Erro diferente, mesma fase da build. Esse se resolve com `sdkmanager --licenses`, não limpando caches.

**Um genérico `Gradle task assembleDebug failed with exit code 1`.** Essa linha é um invólucro, e o aviso de gzip pode ter ficado bem acima dela. Se você não consegue ver a causa real, [rode a build em modo detalhado primeiro](/pt-br/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) em vez de adivinhar.

**Uma falha de `.gz` no download do próprio plugin.** Alguns plugins buscam seus próprios binários pré-compilados em tempo de configuração. Se o nome do pacote que falha não for `NDK (Side by side)`, este artigo é a página errada.

## Relacionados

Se a build já estava doente antes de o download do NDK entrar em cena, [conflitos de AndroidX durante uma build Flutter para Android](/pt-br/2026/05/fix-androidx-conflict-during-flutter-android-build/) e [incompatibilidades de minSdkVersion vindas de plugins](/pt-br/2026/05/fix-flutter-background-fetch-requires-minsdkversion-21/) são os dois que mais costumam estar por baixo de uma falha de primeira execução numa máquina nova. Para times em que cada runner paga esse download uma vez, [mirar em várias versões do Flutter a partir de um único pipeline de CI](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) cobre como cachear o SDK direito para que isso aconteça uma vez por imagem e não uma vez por job.

## Fontes

- [NDK Downloads](https://developer.android.com/ndk/downloads), para as strings de revisão do r29, r28c e r27d, os tamanhos dos arquivos e as somas SHA-1 citadas acima.
- [Referência de linha de comando do sdkmanager](https://developer.android.com/studio/command-line/sdkmanager), para `--install`, `--sdk_root`, `--verbose` e o trio `--proxy`, `--proxy_host`, `--proxy_port`.
- [NDK does not have Source properties file in my project](https://github.com/flutter/flutter/issues/164085) e [New, default Flutter Projects fail on build with NDK...did not have a source.properties file](https://github.com/flutter/flutter/issues/102831), para a falha subsequente CXX1101 e os contornos que as pessoas adotam em vez de limpar o cache.
- [Android NDK version doesn't seem to be right for new projects](https://github.com/flutter/flutter/issues/163945), para entender como a revisão padrão do Flutter é escolhida e quando um plugin obriga você a subir.
- Código citado de uma instalação local do Flutter 3.44.2 stable: `packages/flutter_tools/gradle/src/main/kotlin/FlutterPlugin.kt`, `FlutterPluginUtils.kt`, `FlutterExtension.kt`, `packages/flutter_tools/gradle/src/main/scripts/CMakeLists.txt` e `packages/flutter_tools/lib/src/android/gradle_utils.dart`.
- Detalhes da estrutura do SDK verificados contra um Android SDK nesta máquina: `ndk/28.2.13676358/source.properties` (`Pkg.ReleaseName = r28c`), `ndk/28.2.13676358/package.xml` e o diretório de cache `.temp` com ponto inicial.
