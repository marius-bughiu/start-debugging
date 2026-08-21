---
title: "Correção: Toolchain installation does not provide the required capabilities: [JAVA_COMPILER]"
description: "O Gradle está compilando com um JRE. Ele não procura na sua máquina, usa exatamente a JVM com que foi iniciado. Aponte flutter config --jdk-dir para um JDK real, ou remova org.gradle.java.home."
pubDate: 2026-08-21
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "java"
lang: "pt-br"
translationOf: "2026/08/fix-toolchain-installation-does-not-provide-the-required-capabilities-in-flutter"
translatedBy: "claude"
translationDate: 2026-08-21
---

O diretório Java em que o Gradle está rodando não tem `bin/javac`, então é um JRE, não um JDK. O Gradle não está procurando um melhor na sua máquina: sem nenhum toolchain configurado, ele usa a JVM com que foi iniciado e falha na hora. Em uma compilação Android com Flutter, essa JVM é escolhida primeiro por `flutter config --jdk-dir`, então rode `flutter config --jdk-dir "/caminho/para/um/jdk/real"` e compile de novo. Se isso não mudar o erro, algo está sobrescrevendo o Flutter: confira `org.gradle.java.home` em `android/gradle.properties`.

Tudo abaixo foi verificado no Flutter 3.44.2 stable, cujos templates Android fixam Gradle 9.1.0, Android Gradle Plugin 9.0.1, Kotlin Gradle Plugin 2.3.20 e `compileSdk` 36.

## O erro como o Gradle o imprime

```text
FAILURE: Build failed with an exception.

* What went wrong:
Could not determine the dependencies of task ':app:packageDebug'.
> Could not create task ':app:compileDebugJavaWithJavac'.
   > Failed to calculate the value of task ':app:compileDebugJavaWithJavac' property 'javaCompiler'.
      > Toolchain installation 'C:\path\to\some-java-home' does not provide the required capabilities: [JAVA_COMPILER]
```

Pelo `flutter build apk` você normalmente só vê o final dele, embrulhado em `Gradle task assembleDebug failed with exit code 1`. O caminho entre aspas é a parte importante. É o diretório Java que o Gradle rejeitou e, nove em cada dez vezes, você não o configurou conscientemente.

## Por que o Gradle culpa um diretório Java que você nunca configurou

Essa mensagem vem do Gradle, não do Flutter nem do AGP. No Gradle 9.1.0 ela é lançada por `JavaToolchainQueryService`, e a lógica ao redor é a história inteira:

```java
// Gradle 9.1.0, JavaToolchainQueryService.resolveToolchain
boolean useFallback = !requestedSpec.isConfigured();
JavaToolchainSpec actualSpec = useFallback ? fallbackToolchainSpec : requestedSpec;
```

Se nenhum toolchain estiver configurado em lugar algum da compilação, o Gradle substitui por uma especificação de fallback que significa "a JVM atual". Esse caminho não busca, não filtra e não ordena nada:

```java
// Gradle 9.1.0, JavaToolchainQueryService.query
if (spec instanceof CurrentJvmToolchainSpec) {
    return asToolchainOrThrow(
        InstallationLocation.autoDetected(currentJavaHome, "current JVM"),
        spec, requiredCapabilities, isFallback);
}
```

`asToolchainOrThrow` inspeciona aquela única instalação e lança o erro se faltar alguma capacidade exigida. Compare com o caminho configurado, `findInstalledToolchain`, que passa todas as instalações detectadas por um comparador ciente das capacidades e descarta em silêncio as que não qualificam.

Essa diferença é a coisa mais útil de saber aqui. Este erro significa que o Gradle recebeu um diretório Java específico e esse diretório não tem compilador. Não significa "o Gradle não conseguiu achar um JDK". Quando o Gradle realmente não acha nenhum, você recebe uma mensagem completamente diferente, coberta mais adiante.

Também significa que as configurações de detecção automática de toolchain são irrelevantes nesse caminho. Confirmei isso rodando a mesma tarefa duas vezes, uma com `-Dorg.gradle.java.installations.auto-detect=false` e outra com a detecção ligada. Falha idêntica nos dois casos.

## O que o Gradle realmente verifica quando diz JAVA_COMPILER

Menos do que você imaginaria. Não há sondagem, nem consulta de módulos, nem tentativa de invocar uma API de compilador. É um teste de existência de arquivo:

```java
// Gradle 9.1.0, JvmInstallationMetadata.gatherCapabilities
if (getToolByExecutable("javac").exists()) {
    capabilities.add(JavaInstallationCapability.JAVA_COMPILER);
}
if (getToolByExecutable("javadoc").exists()) {
    capabilities.add(JavaInstallationCapability.JAVADOC_TOOL);
}
if (getToolByExecutable("jar").exists()) {
    capabilities.add(JavaInstallationCapability.JAR_TOOL);
}
```

`getToolByExecutable` resolve `<javaHome>/bin/<name>` com o sufixo de executável da plataforma. O Gradle rotula uma instalação como "JDK" apenas quando os três estão presentes: `javac`, `javadoc` e `jar`, e `JAVA_COMPILER` é exatamente `bin/javac`.

A consequência prática: um diretório Java que é um JDK em todos os sentidos, exceto por seu diretório `bin` não conter literalmente `javac`, será reportado como JRE. Isso cobre os pacotes `java-17-openjdk` do Fedora e do Debian que trazem apenas o runtime headless, um diretório `jre` antigo deixado dentro de uma instalação de JDK, e qualquer diretório invólucro que encaminhe `java` mas não o resto das ferramentas.

## Reprodução: construa um JRE e veja falhar

Você não precisa de uma máquina quebrada para ver isso. Construa uma imagem de runtime sem os módulos do compilador usando `jlink`, que é o que um JRE é:

```bash
# JDK 21.0.11, jlink from the same JDK
MODS=$(java --list-modules | sed 's/@.*//' \
  | grep -vE '^(jdk\.compiler|jdk\.javadoc|jdk\.jshell|jdk\.jlink|jdk\.jdeps|jdk\.jpackage)$' \
  | paste -sd, -)
jlink --add-modules "$MODS" --no-header-files --no-man-pages --output ./real-jre-21
ls ./real-jre-21/bin/javac   # no such file
./real-jre-21/bin/java -version
# openjdk version "21.0.11" 2026-04-21 LTS
```

Excluir `jdk.jpackage` importa. Ele puxa `jdk.jlink`, que puxa `jdk.jdeps`, que puxa `jdk.compiler` de volta, e você acaba com o lançador `javac` que estava tentando evitar.

Agora aponte o Flutter para lá e compile um app recém-criado com `flutter create`:

```bash
# Flutter 3.44.2 stable, Gradle 9.1.0, AGP 9.0.1
flutter create --platforms=android toolchain_repro
flutter config --jdk-dir "$(pwd)/real-jre-21"
cd toolchain_repro && flutter build apk --debug
```

Isso falha com o erro exato do início deste artigo, em um template intocado e sem nenhum bloco de toolchain.

## Qual Java uma compilação Flutter realmente usa?

É aqui que a maior parte do tempo de depuração se perde, porque `JAVA_HOME` não é a primeira coisa que o Flutter olha. Conforme `packages/flutter_tools/lib/src/android/java.dart` no 3.44.2, `_findJavaHome` retorna a primeira ocorrência nesta ordem:

1. o valor `jdk-dir` na configuração do próprio Flutter, definido por `flutter config --jdk-dir`
2. o JDK incluído no Android Studio
3. a variável de ambiente `JAVA_HOME`
4. o que quer que `java` resolva no `PATH`

Ou seja, um `jdk-dir` desatualizado vence um `JAVA_HOME` perfeitamente bom, de forma permanente e silenciosa. Esbarrei nisso enquanto escrevia a reprodução: exportei `JAVA_HOME` apontando para o runtime mutilado e a compilação continuava passando, porque um `jdk-dir` configurado antes estava vencendo. Confira o seu antes de mudar qualquer outra coisa:

```bash
# Flutter 3.44.2
flutter config --list | grep jdk-dir
```

Para o item 2, o caminho incluído depende da versão do Android Studio. Studio 2022 e posteriores usam `<studio>/jbr`, ou `<studio>/jbr/Contents/Home` no macOS. Qualquer versão anterior usa `<studio>/jre`. Se você tem uma instalação antiga esquecida que o Flutter ainda encontra, esse diretório `jre` é um culpado plausível.

A armadilha que dificulta perceber isso é que o `flutter doctor` não verifica se há compilador. Com o JRE configurado, ele imprime:

```text
[√] Android toolchain - develop for Android devices (Android SDK version 36.0.0)
    • Java binary at: /path/to/real-jre-21/bin/java
      This JDK is specified in your Flutter configuration.
    • Java version OpenJDK Runtime Environment Microsoft-13877171 (build 21.0.11+10-LTS)
```

Um sinal verde, e as palavras "This JDK". O doctor roda `java --version` e analisa a saída, algo que um JRE responde perfeitamente bem. Ele nunca procura `javac`. Se você já está atrás de um problema do doctor, `cmdline-tools component is missing` é um diagnóstico separado com solução própria.

## Como aponto o Flutter para um JDK real?

Defina `jdk-dir` explicitamente e compile de novo. Esta é a correção no caso comum:

```bash
# Flutter 3.44.2
flutter config --jdk-dir "/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home"
flutter build apk --debug
```

Verifique o diretório antes de defini-lo. A checagem que o Gradle faz é a que você deveria fazer:

```bash
ls "$YOUR_JDK/bin/javac"
```

Se esse arquivo não existir, o caminho é um JRE, não importa o nome do diretório. No Debian e no Ubuntu, `openjdk-21-jre-headless` é o pacote que leva você até aqui e `openjdk-21-jdk` é o que você quer. No macOS com Homebrew, instale `openjdk@21` e use o caminho versionado que ele imprime em vez de um atalho intermediário.

Para voltar ao `JAVA_HOME` e à cadeia de precedência normal, limpe a sobrescrita:

```bash
# Flutter 3.44.2, empty value removes the setting
flutter config --jdk-dir ""
```

## O que sobrescreve a escolha de JDK do Flutter?

`android/gradle.properties` pode sobrescrever tudo o que o Flutter decidiu. `org.gradle.java.home` define a JVM em que o daemon do Gradle roda e, como o caminho que falha é "a JVM atual", apontá-lo para um JRE reproduz o erro mesmo quando `flutter config --jdk-dir` é um JDK válido. Verifiquei essa combinação específica: `jdk-dir` correto, uma linha adicionada, a mesma falha.

```properties
# android/gradle.properties, delete this line if it points at a JRE
org.gradle.java.home=/path/to/real-jre-21
```

Confira a mesma propriedade em `~/.gradle/gradle.properties`, que se aplica a todas as compilações da máquina e é fácil de esquecer. Depois confirme o que o Gradle enxerga:

```bash
# run from android/, Gradle 9.1.0
./gradlew -q javaToolchains
```

O relatório é o diagnóstico mais rápido disponível, porque imprime os dois campos que importam:

```text
 + Microsoft JDK 21 (21.0.11+10-LTS)
     | Location:           C:\Program Files\Microsoft\jdk-21.0.11.10-hotspot
     | Language Version:   21
     | Is JDK:             true
     | Detected by:        Current JVM

 + Oracle JDK 26 (26.0.2+10-55)
     | Location:           C:\Program Files\Java\jdk-26.0.2
     | Language Version:   26
     | Is JDK:             true
     | Detected by:        Windows Registry
```

Um `Is JDK: false` na entrada cuja localização bate com o caminho da sua mensagem de erro confirma o diagnóstico em uma linha.

## Adicionar um bloco de toolchain resolve?

O conselho mais comum para esse erro é declarar um toolchain em `android/app/build.gradle.kts`. Isso muda o resultado, mas nem sempre na direção que você quer, porque tira a compilação do caminho da JVM atual e a coloca no caminho de correspondência, onde o Gradle só aceita uma instalação que ele consiga de fato descobrir.

Testei exatamente isso. Com o JRE ainda configurado como `jdk-dir`, adicionar:

```kotlin
// android/app/build.gradle.kts, AGP 9.0.1, Gradle 9.1.0
java {
    toolchain { languageVersion = JavaLanguageVersion.of(21) }
}
```

produziu uma falha diferente:

```text
> Cannot find a Java installation on your machine (Windows 11 10.0 amd64) matching:
  {languageVersion=21, vendor=any vendor, implementation=vendor-specific, nativeImageCapable=false}.
  Toolchain download repositories have not been configured.
```

Havia um JDK 21 instalado o tempo todo. O Gradle não o encontrou porque a detecção automática nunca o tinha visto: olhe de novo a saída de `javaToolchains` acima e note que o Microsoft JDK 21 aparece como `Detected by: Current JVM`. Assim que a JVM atual passou a ser o JRE, aquela entrada sumiu da lista de candidatos, e a varredura do registro só trouxe um JDK 26 que não satisfaz um pedido de 21.

Ou seja, um bloco de toolchain sozinho troca um erro claro por um mais vago. Use-o junto com um caminho de instalação explícito, não no lugar dele.

## Como fixo um JDK para CI de modo que isso não volte a acontecer?

Declare o toolchain e diga ao Gradle onde estão as instalações. Essa combinação compila com sucesso mesmo quando o daemon roda sobre um JRE, que é a propriedade que você quer em um agente de build onde você não controla o `JAVA_HOME`:

```properties
# android/gradle.properties, Gradle 9.1.0
org.gradle.java.installations.paths=/opt/hostedtoolcache/Java_Temurin-Hotspot_jdk/21.0.11/x64
```

Combinada com o bloco `java { toolchain { ... } }` acima, essa foi a configuração que confirmei verde enquanto o `jdk-dir` ainda apontava para o runtime sem compilador. Dois parâmetros relacionados valem a pena: `org.gradle.java.installations.fromEnv=JDK21` lê caminhos de variáveis de ambiente nomeadas, o que combina com imagens de CI que já as exportam, e `org.gradle.java.installations.auto-detect=false` desliga a varredura por completo, para que um agente sem caminhos fixados falhe de forma barulhenta em vez de escolher algo arbitrário.

Não recorra a `org.gradle.java.installations.auto-download=true` como correção. O Gradle 9 marca como obsoleto o uso de toolchains provisionados automaticamente sem repositórios de toolchain declarados e avisa que isso virará erro no Gradle 10.

## Variantes que parecem esse erro mas não são

`Toolchain installation '...' could not be probed` é lançado duas linhas antes no mesmo método e significa que o Gradle não conseguiu executar `java` de jeito nenhum. Isso é uma instalação quebrada ou parcial, um problema de permissões ou uma arquitetura incompatível, não um JRE.

`Cannot find a Java installation on your machine ... matching` é o caminho do toolchain configurado sem encontrar candidato. Corrige-se adicionando o caminho de instalação, como acima.

`Unsupported class file major version` e `Gradle requires JVM 17 or later` são incompatibilidades de versão, não falhas de capacidade. O Flutter 3.44.2 carrega uma tabela de compatibilidade Java-Gradle em `gradle_utils.dart`: Java 21 precisa de Gradle 8.4 ou posterior, Java 24 precisa de 8.14 e Java 25 precisa de 9.1.0.

`Cannot add extension with name 'kotlin'` é o suporte embutido a Kotlin do AGP 9 colidindo com o plugin legado `kotlin-android`, e é a outra causa frequente de um `assembleDebug` que falha em 2026.

## Relacionado

- O Flutter reporta falhas do Gradle através de uma linha invólucro, e o [erro real geralmente fica truncado acima dela](/pt-br/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).
- Um sinal verde no toolchain do Android ainda pode esconder uma peça faltante, como com [o componente cmdline-tools](/pt-br/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/).
- Outra falha do SDK do Android que se repete igual até você limpar um cache: [um arquivo NDK corrompido](/pt-br/2026/08/fix-an-error-occurred-while-preparing-sdk-package-ndk-not-in-gzip-format/).
- Mais configurações que quebram builds e moram em `android/gradle.properties`: [as flags de AndroidX e Jetifier](/pt-br/2026/05/fix-androidx-conflict-during-flutter-android-build/).
- Contexto de versões para os padrões de toolchain citados aqui: [o que mudou no Flutter 3.44](/pt-br/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).

## Fontes

- Guia do usuário do Gradle, [Toolchains for JVM projects](https://docs.gradle.org/current/userguide/toolchains.html), para as fontes de detecção automática, a precedência e as propriedades de instalação.
- Código-fonte do Gradle 9.1.0, `JavaToolchainQueryService.java` e `JvmInstallationMetadata.java`, incluídos no diretório `src` da distribuição `gradle-9.1.0-all`.
- Código-fonte do Flutter 3.44.2, `packages/flutter_tools/lib/src/android/java.dart` para a ordem de busca do Java e `gradle_utils.dart` para as versões fixadas de Gradle, AGP e Kotlin.
- Issues do Gradle [#30499](https://github.com/gradle/gradle/issues/30499) e [#30421](https://github.com/gradle/gradle/issues/30421), onde a mesma mensagem é reportada contra pacotes OpenJDK do Linux.
