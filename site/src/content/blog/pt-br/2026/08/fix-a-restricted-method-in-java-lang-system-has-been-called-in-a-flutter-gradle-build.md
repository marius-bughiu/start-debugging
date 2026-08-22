---
title: "Correção: A restricted method in java.lang.System has been called em um build Gradle do Flutter"
description: "O aviso do JEP 472 no JDK 24+ é inofensivo e aparece uma única vez. Resolva alinhando seu JDK a uma versão do Gradle que o suporte, e não colando flags no gradle.properties."
pubDate: 2026-08-22
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "jdk"
lang: "pt-br"
translationOf: "2026/08/fix-a-restricted-method-in-java-lang-system-has-been-called-in-a-flutter-gradle-build"
translatedBy: "claude"
translationDate: 2026-08-22
---

Seu build está bem. Este é um aviso do JDK 24 e posteriores vindo do [JEP 472](https://openjdk.org/jeps/472), impresso uma vez por módulo chamador quando algo carrega uma biblioteca nativa via `System.load` ou `System.loadLibrary` sem `--enable-native-access`. O Gradle atual já passa essa flag para o próprio daemon, então se você está vendo isso, ou seu JDK é mais novo do que o seu Gradle suporta, ou uma JVM bifurcada dentro do build está sem a flag. Voltar para o JDK 21 que o Android Studio embute faz o aviso sumir por completo.

Tudo abaixo foi medido no Windows 11 com Flutter 3.44.2 stable (revisão `c9a6c48423`), Gradle 9.1.0, JDK 26.0.2 (`26.0.2+10-55`) e Microsoft OpenJDK 21.0.11.

## O erro em contexto

```text
WARNING: A restricted method in java.lang.System has been called
WARNING: java.lang.System::load has been called by net.rubygrapefruit.platform.internal.NativeLibraryLoader in an unnamed module (file:/C:/Users/mariu/.gradle/wrapper/dists/gradle-9.1.0-all/7wzd0jkjit61aq2p43wpjgij9/gradle-9.1.0/lib/native-platform-0.22-milestone-28.jar)
WARNING: Use --enable-native-access=ALL-UNNAMED to avoid a warning for callers in this module
WARNING: Restricted methods will be blocked in a future release unless native access is enabled
```

A segunda linha varia. `java.lang.System::loadLibrary` aparece no lugar de `::load` quando quem chamou passou um nome de biblioteca em vez de um caminho absoluto, e a classe chamadora é quem de fato carregou o código nativo. `net.rubygrapefruit.platform.internal.NativeLibraryLoader` é a integração nativa do próprio Gradle. `com.sun.jna.Native` é o JNA, trazido por algum plugin.

## O que significa "a restricted method in java.lang.System has been called"?

O JEP 472, entregue no JDK 24, tornou `System::load`, `System::loadLibrary`, `Runtime::load` e `Runtime::loadLibrary` métodos restritos, e tornou restrita a operação de vincular um método `native` do JNI. Restrito significa que a JVM exige uma adesão explícita antes de o código sair do runtime, porque uma biblioteca nativa defeituosa pode corromper o heap de formas que a JVM não consegue reportar.

A adesão é `--enable-native-access`. Sem ela, o JDK 24 e posteriores imprimem o bloco de quatro linhas acima e seguem em frente. Vale conhecer três pontos antes de sair procurando uma correção:

O aviso é emitido **uma vez por módulo chamador**, não uma vez por chamada. Um laço que carrega três bibliotecas a partir da mesma classe imprime um único bloco:

```java
// JDK 26.0.2, plain javac, no flags
public class MultiProbe {
    public static void main(String[] args) {
        for (int i = 0; i < 3; i++) {
            try { System.load("C:/Windows/System32/winhttp.dll"); }
            catch (Throwable t) { /* ignore */ }
        }
        System.out.println("DONE-MULTI");
    }
}
```

Isso imprime um bloco de aviso seguido de `DONE-MULTI`. Se você está vendo o bloco repetido, está olhando para várias JVMs diferentes, ou vários jars diferentes, em um mesmo log de build. Leia o caminho do módulo na linha 2 de cada bloco para diferenciá-los.

O modo padrão continua sendo `warn`. Rodar a mesma classe com `--illegal-native-access=warn` no JDK 26.0.2 produz saída idêntica à execução sem flag alguma, que é justamente como você confirma que o padrão não virou `deny` no JDK que você usa.

E a última linha é uma previsão, não um aviso de descontinuação sobre o seu código. "Blocked in a future release" se refere a um JDK futuro, não a um Gradle ou Flutter futuro.

## Quais versões do JDK imprimem isso, e por que o JDK 21 não?

O JDK 24 é o piso. Esse aviso não existe no JDK 21 nem no 17. Rodar a mesma sonda no Microsoft OpenJDK 21.0.11 imprime `DONE-MULTI` e mais nada.

Vale ser preciso aqui porque a restrição chegou em duas ondas. JDK 22 e 23 avisam sobre métodos restritos na Foreign Function and Memory API, então a mensagem cita `java.lang.foreign.Linker` ou algo parecido. A metade do JNI, que é a variante `java.lang.System::load` sobre a qual você está lendo, chegou no JDK 24. Se o seu aviso cita `java.lang.System`, você está no JDK 24 ou posterior.

Isso importa para o Flutter porque o Flutter não escolhe o JDK mais novo da sua máquina. Ele resolve um, nesta ordem, conforme `packages/flutter_tools/lib/src/android/java.dart`:

1. O caminho gravado por `flutter config --jdk-dir`.
2. O JBR embutido no Android Studio.
3. `JAVA_HOME`.
4. O primeiro `java` no `PATH`.

O JBR embutido no Android Studio é um 21 nas versões atuais, então uma instalação padrão do Flutter nunca vê esse aviso. Vê-lo significa que você mesmo apontou `jdk-dir` ou `JAVA_HOME` para um JDK 24, 25 ou 26, quase sempre como efeito colateral de instalar o "Java mais recente" por um gerenciador de pacotes. Confirme qual está em jogo com `flutter doctor --verbose`, que imprime o binário do Java resolvido e sua versão.

## O Gradle já passa --enable-native-access para o daemon dele?

Sim, e é essa parte que muda a correção. O Gradle envia a flag desde a 8.14. A lógica fica em `org.gradle.internal.jvm.JpmsConfiguration`, e o bytecode em `gradle-base-services-8.14.jar` e em `gradle-base-services-9.1.0.jar` é idêntico: `forDaemonProcesses(int, boolean)` e `forWorkerProcesses(int, boolean)` comparam a versão do Java alvo com `24`, e quando ela é 24 ou maior e o booleano é verdadeiro devolvem uma lista contendo `--enable-native-access=ALL-UNNAMED`. Os chamadores, `DefaultDaemonStarter` e `DefaultWorkerProcessBuilder`, passam `NativeServices.NativeServicesMode.isPotentiallyEnabled()` como esse booleano.

Dá para ver isso em um daemon vivo. Inicie qualquer build e então peça à JVM a linha de comando dela:

```bash
# JDK 26.0.2 jcmd against a running Gradle 9.1.0 daemon
jps -l | grep GradleDaemon
jcmd <pid> VM.command_line
```

Em um daemon do Gradle 9.1.0 rodando sobre JDK 26.0.2 isso imprime, entre as entradas `--add-opens`, um único `--enable-native-access=ALL-UNNAMED`. Vale conhecer dois desdobramentos:

- Definir seu próprio `org.gradle.jvmargs` não sobrescreve a flag. Com `org.gradle.jvmargs=-Xmx4G -XX:MaxMetaspaceSize=2G` no `gradle.properties`, a linha de comando do daemon ainda carrega `-Xmx4G`, `-XX:MaxMetaspaceSize=2G` **e** `--enable-native-access=ALL-UNNAMED`. Isso importa especialmente no Flutter, porque o template do app já traz uma linha `org.gradle.jvmargs` não vazia por padrão.
- Definir `org.gradle.native=false` remove a flag, porque `isPotentiallyEnabled()` retorna falso. Isso não é uma correção, é o Gradle desligando a integração nativa por inteiro, e junto vai a vigilância do sistema de arquivos.

Então um aviso que cita `net.rubygrapefruit.platform.internal.NativeLibraryLoader` vindo de um daemon do Gradle atual não é algo que se remende com uma flag. Significa que aquela JVM não recebeu os argumentos do Gradle, o que aponta para uma de três coisas: um Gradle anterior à 8.14, uma JVM bifurcada por um plugin em vez de pela worker API do Gradle, ou uma IDE conversando com o seu build pela Tooling API. As próprias notas da versão 8.14 do Gradle destacam o último caso: quem consome a Tooling API precisa habilitar o acesso nativo na inicialização por causa do uso de JNI.

## Qual JVM do build está imprimindo o aviso?

Trabalhe a partir da linha 2. Ela cita tanto a classe chamadora quanto o jar de onde ela veio, e esse par basta para localizar a JVM:

- Chamador em um `native-platform-*.jar` sob `~/.gradle/wrapper/dists/`, e o `jcmd` mostra que o daemon tem a flag: o aviso vem de um processo diferente do daemon que você inspecionou, tipicamente um worker bifurcado ou um daemon de compilação iniciado por um plugin.
- Chamador em um `jna-*.jar`: um plugin carregou o JNA. Encontre-o com `./gradlew :app:dependencies --configuration runtimeClasspath` a partir do diretório `android/` e procure por `net.java.dev.jna`.
- Chamador em um jar sob `~/.gradle/caches/modules-2/`: é dependência de um plugin, não do Gradle em si, e quem mantém o plugin precisa bifurcar com a flag.

Como o Flutter roda o Gradle por você, capture primeiro a saída crua:

```bash
# Flutter 3.44.2, run from the project root
flutter build apk --debug --verbose 2>&1 | tee build.log
grep -n "restricted method" -A 3 build.log
```

## Como eu faço o aviso sumir?

Em ordem de preferência.

**Alinhe seu JDK à sua versão do Gradle.** A matriz de compatibilidade do Gradle é rígida: Java 24 exige Gradle 8.14 ou posterior, Java 25 exige 9.1.0 ou posterior, e Java 26 exige 9.4.0 ou posterior. O Flutter 3.44.2 gera projetos sobre Gradle 9.1.0 com AGP 9.0.1 e Kotlin 2.3.20, então um projeto novo está bem no JDK 24 ou 25 e fica uma versão aquém para o JDK 26. Suba o wrapper em `android/gradle/wrapper/gradle-wrapper.properties`:

```properties
# Flutter 3.44.2 default is gradle-9.1.0-all; 9.4.0+ is required for JDK 26
distributionUrl=https\://services.gradle.org/distributions/gradle-9.4.0-all.zip
```

Passar da matriz não gera apenas um aviso. O Gradle 9.1.0 sobre JDK 26.0.2 quebra o build de vez:

```text
BUG! exception in phase 'semantic analysis' in source unit '_BuildScript_' Unsupported class file major version 70
```

O Flutter reconhece esse caso. O `gradle_errors.dart` casa com `Unsupported class file major version\s+\d+` e imprime uma caixa dizendo que sua versão do Gradle é incompatível com a versão do Java que o Flutter está usando, com um ponteiro para `flutter doctor --verbose`.

**Aponte o Flutter para o JDK que você realmente quer.** Se você não precisa de um JDK de ponta neste projeto, o caminho mais curto é parar de entregar um para o Flutter:

```bash
# Flutter 3.44.2; persists to the Flutter config, survives JAVA_HOME changes
flutter config --jdk-dir "C:\Program Files\Android\Android Studio\jbr"
flutter doctor --verbose
```

Como `jdk-dir` fica acima de `JAVA_HOME` na ordem de resolução, isso vence o que quer que um gerenciador de pacotes tenha definido globalmente, e afeta apenas o Flutter.

**Adicione a flag à JVM que está sem ela.** Só depois de identificar essa JVM pela linha 2. Para o daemon do Gradle em um Gradle antigo, isso é `org.gradle.jvmargs` no `android/gradle.properties`, acrescentado ao que o template do Flutter já colocou lá:

```properties
# Flutter 3.44.2 template default, plus the JEP 472 opt-in
org.gradle.jvmargs=-Xmx8G -XX:MaxMetaspaceSize=4G -XX:ReservedCodeCacheSize=512m -XX:+HeapDumpOnOutOfMemoryError --enable-native-access=ALL-UNNAMED
```

Para um daemon de compilação do Kotlin, o botão equivalente é `kotlin.daemon.jvmargs`. Note que isso é uma adesão real com significado real, não um botão de silenciar: você está afirmando que tudo no class path pode chamar código nativo.

## É seguro colocar --illegal-native-access=allow no gradle.properties?

Não, e essa é a única mudança aqui que pode de fato quebrar o build de um colega.

`--illegal-native-access` foi introduzida junto com o JEP 472 no JDK 24. No JDK 21 ela não existe, e uma opção `-` desconhecida é fatal na inicialização da JVM:

```text
Unrecognized option: --illegal-native-access=deny
Error: Could not create the Java Virtual Machine.
Error: A fatal exception has occurred. Program will exit.
```

Coloque isso no `org.gradle.jvmargs` e o build morre para qualquer pessoa no JDK 21, o que inclui todo desenvolvedor usando o JBR embutido no Android Studio e a maioria das imagens de CI fixadas em um LTS. `--enable-native-access` é mais segura nesse ponto, já que existe desde o JDK 21 e é aceita lá sem reclamação, mas ainda assim vale limitá-la ao projeto em vez de a um `GRADLE_OPTS` global.

O valor `allow` tem um segundo problema: é o modo de compatibilidade que o JEP 472 descreve como temporário, a ser eliminado gradualmente e por fim removido. Construir em cima dele significa que o aviso volta como erro em algum JDK futuro, no calendário de outra pessoa.

## O que acontece quando o aviso vira erro?

Você pode ver o desfecho hoje, aderindo mais cedo. Carregar a biblioteca nativa do próprio Gradle no JDK 26.0.2 sob `--illegal-native-access=deny`:

```text
Exception in thread "main" net.rubygrapefruit.platform.NativeException: Failed to load native library 'native-platform.dll' for Windows 11 amd64.
	at net.rubygrapefruit.platform.internal.NativeLibraryLoader.load(NativeLibraryLoader.java:67)
	at net.rubygrapefruit.platform.Native.init(Native.java:60)
Caused by: java.lang.IllegalCallerException: Illegal native access from an unnamed module (file:/C:/.../gradle-9.1.0/lib/native-platform-0.22-milestone-28.jar)
	at java.base/java.lang.Module.ensureNativeAccess(Module.java:311)
	at java.base/java.lang.System$1.ensureNativeAccess(System.java:2110)
```

A `IllegalCallerException` é a parte do JDK. Tudo acima dela é o tratamento de falhas da própria biblioteca, e é por isso que a versão futura desse problema não vai parecer um erro de acesso nativo. Vai parecer o que quer que a biblioteca diga quando uma `.dll` ou um `.so` falha ao carregar. Rodar seu CI com `--illegal-native-access=deny` em um job sobre JDK 24+ é um jeito barato de descobrir qual dos seus plugins vai quebrar primeiro, desde que você mantenha isso fora do `gradle.properties` compartilhado.

## Relacionados

- [Toolchain installation does not provide the required capabilities: \[JAVA_COMPILER\]](/pt-br/2026/08/fix-toolchain-installation-does-not-provide-the-required-capabilities-in-flutter/) cobre a outra metade da história do JDK no Flutter, em que o Gradle resolve um JRE em vez de um JDK.
- [Gradle task assembleDebug failed with exit code 1](/pt-br/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) mostra como extrair o erro real de um log de build Android do Flutter.
- [flutter doctor informa que o componente cmdline-tools está faltando](/pt-br/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/) é o complemento para quando o próprio `flutter doctor --verbose` está insatisfeito.
- [A UI do Flutter sobrepõe a barra de navegação do Android após mirar o SDK 35](/pt-br/2026/08/fix-flutter-ui-overlaps-the-android-navigation-bar-after-targeting-sdk-35/) é outro caso em que uma mudança da plataforma Android aparece tarde em um projeto Flutter.

## Fontes

- [JEP 472: Prepare to Restrict the Use of JNI](https://openjdk.org/jeps/472), que define os métodos restritos e a adesão `--enable-native-access`.
- [JDK 24: Prepares Restricted Native Access](https://inside.java/2024/12/09/quality-heads-up/) no Inside Java, a nota de divulgação de qualidade para a mudança do JDK 24.
- [Matriz de compatibilidade de Java do Gradle](https://docs.gradle.org/current/userguide/compatibility.html), para a versão do Gradle exigida por cada release do Java.
- [Notas da versão Gradle 8.14](https://docs.gradle.org/8.14/release-notes.html), que adicionam suporte do daemon ao Java 24 e sinalizam o requisito de JNI da própria Tooling API.
- Fontes do Flutter 3.44.2: `packages/flutter_tools/lib/src/android/java.dart` para a ordem de resolução do JDK e `packages/flutter_tools/lib/src/android/gradle_errors.dart` para o handler da versão de class file.
