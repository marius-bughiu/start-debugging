---
title: "Correção: Module was compiled with an incompatible version of Kotlin. The binary version of its metadata is X, expected version is Y (Flutter Android)"
description: "Uma dependência foi compilada com um Kotlin pelo menos duas versões menores à frente do compilador do seu build. Aumente a versão de org.jetbrains.kotlin.android em settings.gradle.kts para X menos um ou superior, ou fixe a dependência em uma versão anterior."
pubDate: 2026-10-21
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "kotlin"
  - "gradle"
lang: "pt-br"
translationOf: "2026/10/fix-module-was-compiled-with-an-incompatible-version-of-kotlin-in-a-flutter-android-build"
translatedBy: "claude"
translationDate: 2026-10-21
---

Resposta curta: alguma biblioteca no classpath do seu Android (muitas vezes um `kotlin-stdlib` mais novo, trazido de forma transitiva) foi compilada com uma versão do Kotlin pelo menos duas versões menores à frente do compilador que o seu build realmente executa. O compilador só lê metadados de uma versão menor à frente. Aumente a versão de `org.jetbrains.kotlin.android` em `android/settings.gradle.kts` para pelo menos "X menos uma versão menor" (para os metadados 2.4.0, KGP 2.3.x ou superior) e compile novamente. Tudo abaixo foi reproduzido com Flutter 3.44.8, AGP 9.0.1, Gradle 9.1.0 e artefatos do Kotlin 2.4.21.

## O erro em contexto

Em um `flutter build apk` ou `flutter run`, a tarefa `compileDebugKotlin` (ou `compileReleaseKotlin`) falha com uma linha por arquivo de módulo Kotlin no jar problemático:

```text
> Task :app:compileDebugKotlin FAILED
e: file:///Users/me/.gradle/caches/modules-2/files-2.1/org.jetbrains.kotlin/kotlin-stdlib/2.4.21/.../kotlin-stdlib-2.4.21.jar!/META-INF/kotlin-stdlib.kotlin_module Module was compiled with an incompatible version of Kotlin. The binary version of its metadata is 2.4.0, expected version is 2.2.0.
e: file:///.../MainActivity.kt:6:19 Unresolved reference 'listOf'.

FAILURE: Build failed with an exception.
* What went wrong:
Execution failed for task ':app:compileDebugKotlin'.
> A failure occurred while executing org.jetbrains.kotlin.compilerRunner.GradleCompilerRunnerWithWorkers$GradleKotlinCompilerWorkAction
   > Compilation error. See log for more details
```

Quando o código com falha está em um plugin e não no seu app, a mesma incompatibilidade é reportada por classe, e a mensagem é mais nova e mais útil:

```text
> Task :shared_preferences_android:compileDebugKotlin FAILED
e: Incompatible classes were found in dependencies. Remove them from the classpath or use '-Xskip-metadata-version-check' to suppress errors
e: .../shared_preferences_android-2.5.1/android/src/main/kotlin/io/flutter/plugins/sharedpreferences/LegacySharedPreferencesPlugin.kt:47:5 Class 'kotlin.Unit' was compiled with an incompatible version of Kotlin. The actual metadata version is 2.4.0, but the compiler version 2.2.0 can read versions up to 2.3.0.
```

Os erros "Unresolved reference" que vêm depois (`listOf`, `startsWith`, `it`) são ruído. Quando o compilador se recusa a carregar a biblioteca padrão, todo símbolo da stdlib fica sem resolução. Corrija o primeiro erro e todos eles desaparecem.

## Por que o compilador recusa metadados mais novos

Todo arquivo de classe Kotlin/JVM carrega uma anotação `@kotlin.Metadata`, e todo jar tem um arquivo `META-INF/*.kotlin_module`, ambos marcados com a versão de metadados do compilador que os produziu. Os [princípios de evolução do Kotlin](https://kotlinlang.org/docs/kotlin-evolution-principles.html) prometem compatibilidade retroativa (um compilador mais novo lê todos os binários mais antigos), mas apenas compatibilidade futura em regime de melhor esforço com a próxima versão da linguagem, "but not later ones". O compilador aplica essa regra logo de início: um compilador 2.2 aceita metadados até 2.3.0 e rejeita 2.4.0. É exatamente isso que a mensagem mais nova explicita: "the compiler version 2.2.0 can read versions up to 2.3.0".

Então os dois números no erro significam:

- **"binary version of its metadata is X"**: a versão do Kotlin que compilou o jar da biblioteca indicado no caminho.
- **"expected version is Y"**: o compilador Kotlin que o seu build do Gradle está executando, que vem do Kotlin Gradle Plugin (KGP) no classpath do build. Não é o Kotlin instalado no Android Studio, e não é necessariamente a versão que você digitou.

Em apps Flutter, o gatilho quase sempre é um destes, em ordem de frequência:

1. **Uma atualização de plugin ou de biblioteca AndroidX/Google** traz um `kotlin-stdlib` mais novo de forma transitiva. A resolução de conflitos do Gradle escolhe a maior stdlib solicitada, então uma única dependência moderna atualiza a stdlib do módulo inteiro.
2. **O KGP do seu projeto é antigo**, em geral porque o app foi criado anos atrás e o `settings.gradle.kts` (ou `ext.kotlin_version` em um `android/build.gradle` anterior ao Flutter 3.16) nunca foi atualizado.
3. **Um plugin compilado com um Kotlin mais novo distribui um AAR ou jar pré-compilado** com classes Kotlin dentro (comum em plugins que encapsulam SDKs, como mapas, pagamentos e analytics).

## Reprodução mínima

Comece com um projeto Flutter 3.44.8 novo, reduza o KGP e adicione uma dependência compilada com Kotlin 2.4:

```kotlin
// android/settings.gradle.kts -- Flutter 3.44.8, AGP 9.0.1, Gradle 9.1.0
plugins {
    id("dev.flutter.flutter-plugin-loader") version "1.0.0"
    id("com.android.application") version "9.0.1" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false // template ships 2.3.20
}
```

```kotlin
// android/app/build.gradle.kts -- Flutter 3.44.8
dependencies {
    // Stands in for any library compiled with Kotlin 2.4.x
    implementation("org.jetbrains.kotlin:kotlin-stdlib:2.4.21")
}
```

```kotlin
// android/app/src/main/kotlin/com/example/kapp/MainActivity.kt -- Kotlin source that touches stdlib
package com.example.kapp

import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity() {
    val doubled = listOf(1, 2, 3).map { it * 2 }
}
```

Dois detalhes da reprodução valem a pena antes de você começar a mudar versões.

**A versão que você declarou pode não ser a que roda.** Declarei o KGP 2.0.21, mas o erro diz "expected version is 2.2.0", e o Flutter Gradle Plugin avisou "Flutter support for your project's Kotlin version (2.2.10) will soon be dropped". O AGP 9.0.1 declara uma dependência de runtime em `kotlin-gradle-plugin:2.2.10`, e o Gradle resolve o classpath do build para a maior versão solicitada. Declarar um KGP *abaixo* do que o AGP traz não tem efeito algum. Leia a "expected version" no erro, não no seu arquivo de configurações.

**O erro só dispara quando o código Kotlin toca as classes mais novas.** Com o `class MainActivity : FlutterActivity()` padrão de uma linha, o mesmo classpath compilou sem problemas, porque nada forçou o compilador a desserializar os metadados da stdlib. Adicionar `listOf(...)` quebrou o build. É por isso que o erro costuma aparecer "do nada" depois que você adiciona algumas linhas de Kotlin no `MainActivity` ou em um handler de method channel, mesmo que a atualização da dependência tenha acontecido semanas antes.

## Correção 1: aumentar o Kotlin Gradle Plugin (recomendada)

A regra é: a versão menor do KGP deve ser pelo menos a versão menor dos metadados da biblioteca menos um. Para os metadados 2.4.0, isso significa 2.3.x ou superior; igualar exatamente (2.4.x) é a escolha mais segura.

```kotlin
// android/settings.gradle.kts -- Flutter 3.44.8, AGP 9.0.1
plugins {
    id("dev.flutter.flutter-plugin-loader") version "1.0.0"
    id("com.android.application") version "9.0.1" apply false
    id("org.jetbrains.kotlin.android") version "2.3.20" apply false
}
```

Com o 2.3.20, a mesma reprodução compilou sem problemas (`BUILD SUCCESSFUL`): uma versão menor de antecipação é suficiente. Siga esta ordem:

1. Leia o X no erro ("binary version of its metadata is 2.4.0").
2. Abra `android/settings.gradle.kts` (ou `settings.gradle`) e defina a versão de `org.jetbrains.kotlin.android` como X menos uma versão menor ou superior. Em projetos criados antes do Flutter 3.16, a versão fica em `android/build.gradle` como `ext.kotlin_version = '...'` dentro de `buildscript`; altere lá.
3. Confira o novo KGP contra o seu AGP e Gradle na [tabela de compatibilidade do Kotlin Gradle plugin](https://kotlinlang.org/docs/gradle-configure-project.html#apply-the-plugin). O KGP 2.3.20 suporta Gradle 7.6.3 a 9.3.0 e AGP 8.2.2 a 9.0.0; o KGP 2.4.20 exige AGP 8.5.2 ou superior. Projetos Flutter mais antigos com AGP 7.x precisam atualizar o AGP e o Gradle na mesma alteração.
4. Execute `flutter clean` e compile novamente, para que nenhuma saída em cache do Gradle do compilador antigo permaneça.

As próprias ferramentas do Flutter 3.44.8 confirmam isso: o template vem com KGP 2.3.20, e o Flutter Gradle Plugin avisa abaixo de 2.2.20 e dá erro abaixo de 2.0.0 (`warnKGPVersion` e `errorKGPVersion` em `packages/flutter_tools/gradle/src/main/kotlin/DependencyVersionChecker.kt`). Se você ainda está em um projeto Kotlin 1.x, vai esbarrar nesse erro com quase todo release atual do AndroidX, então essa é a atualização a fazer de qualquer forma.

## Correção 2: quando o erro está em um módulo de plugin, corrija mesmo assim no app

Se a tarefa com falha é `:some_plugin:compileReleaseKotlin`, o instinto é culpar o `build.gradle` do plugin. A reprodução mostra por que esse é o arquivo errado. O `shared_preferences_android` 2.5.1 declara o próprio KGP no buildscript:

```kotlin
// ~/.pub-cache/hosted/pub.dev/shared_preferences_android-2.5.1/android/build.gradle.kts (excerpt)
val kotlinVersion = "2.3.0"
classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:$kotlinVersion")
```

Mesmo assim, o erro dizia "the compiler version 2.2.0". Plugins são subprojetos do build do Gradle do seu app, e o KGP já carregado pelo build raiz (a partir do `settings.gradle.kts`, possivelmente atualizado pelo AGP) é o que os compila. A declaração do plugin não prevalece. Então:

1. Aumente o KGP no `android/settings.gradle.kts` do seu app, exatamente como na Correção 1.
2. Se o próprio plugin fixa um Kotlin antigo de um jeito que ainda falha, atualize o plugin (`flutter pub upgrade <name>` ou aumente a restrição no `pubspec.yaml`). Nunca edite arquivos em `~/.pub-cache`: o `pub get` os sobrescreve.

## Correção 3: encontrar e fixar a dependência que trouxe o Kotlin mais novo

Às vezes você não pode aumentar o KGP agora (uma branch de release, uma imagem de CI congelada). Nesse caso, descubra quem solicitou a nova stdlib e fixe essa dependência em uma versão anterior. A partir da pasta `android/`:

```bash
./gradlew :app:dependencyInsight --dependency org.jetbrains.kotlin:kotlin-stdlib --configuration releaseRuntimeClasspath
```

Na minha reprodução, a seção "Selection reasons" explicou a história toda em uma linha:

```text
- By conflict resolution: between versions 2.4.21, 2.2.10, 1.8.22, 2.0.21, 1.6.21, 1.7.10, 1.8.10, 1.3.20, 1.8.20, 1.9.24, 2.0.0, 1.9.25 and 2.0.20
```

Abaixo disso, cada linha `org.jetbrains.kotlin:kotlin-stdlib:1.x -> 2.4.21` aparece indentada sob a dependência que a solicitou. Suba pela árvore até a que pede 2.4.x e então faça downgrade dessa biblioteca ou do plugin Flutter que a traz. Para uma dependência transitiva de um plugin, execute o mesmo comando contra o projeto do plugin (`:plugin_name:dependencyInsight`). Fixar versão é uma medida de curto prazo: o autor da biblioteca migrou para o novo Kotlin por um motivo, e a próxima atualização de qualquer outra coisa vai trazer você de volta aqui.

Não "corrija" forçando a `kotlin-stdlib` para baixo com um `resolutionStrategy.force(...)`. A biblioteca foi compilada contra a API mais nova da stdlib e pode chamar funções que não existem na versão mais antiga, o que transforma um erro de compilação em um `NoSuchMethodError` em tempo de execução.

## Correção 4: -Xskip-metadata-version-check (último recurso)

A própria mensagem do compilador sugere uma flag, e ela funciona:

```kotlin
// android/app/build.gradle.kts -- Kotlin compiler option, use only temporarily
kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
        freeCompilerArgs.add("-Xskip-metadata-version-check")
    }
}
```

Com ela, a reprodução compilou. É uma flag `-X`, ou seja, sem suporte oficial, e ela apenas desliga a verificação de segurança: o compilador passa a ler metadados de um formato que não conhece. Se a biblioteca mais nova usa um recurso da linguagem codificado de um jeito que o seu compilador não consegue interpretar, você recebe assinaturas erradas ou uma falha no compilador em vez de um erro claro. Ela também só vale para o módulo em que você a colocou, então um módulo de plugin com falha continuaria falhando. Use-a para destravar um build de hotfix e remova-a quando atualizar o KGP.

## Erros parecidos que caem aqui

- **`Your project requires a newer version of the Kotlin Gradle plugin`**: essa é a verificação prévia do próprio Flutter, não o compilador Kotlin. Ela tem um caminho de correção diferente, descrito no [post sobre o erro de versão antiga do KGP](/pt-br/2023/08/flutter-your-project-requires-a-newer-version-of-the-kotlin-gradle-plugin/).
- **`Daemon compilation failed: null`**: uma falha de compilação incremental dentro do daemon do Kotlin, não uma incompatibilidade de versão. Veja [como corrigir Daemon compilation failed: null](/pt-br/2026/09/fix-daemon-compilation-failed-null-in-a-flutter-android-gradle-build/).
- **Erros de Kotlin logo após migrar para o AGP 9**: se o build quebrou quando você atualizou o AGP e aparece `Cannot add extension with name 'kotlin'`, trata-se da migração para o Kotlin integrado. [O guia de migração para o AGP 9](/pt-br/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/) explica o processo, inclusive por que você deve manter a linha do KGP no `settings.gradle.kts`.
- **`Execution failed for task ':app:compileFlutterBuildDebug'` ou um simples `exit code 1`**: a linha de resumo que o Flutter imprime esconde o erro real do Gradle. Role para cima ou execute novamente com `--verbose`; [o guia sobre o exit code 1 do assembleDebug](/pt-br/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) mostra onde olhar.
- **"Expected version is 1.x" em um projeto que você acha que usa Kotlin 2**: você está lendo o arquivo errado. Procure um `ext.kotlin_version` esquecido em `android/build.gradle`, ou um bloco `buildscript` no projeto raiz que ainda coloca um `kotlin-gradle-plugin` antigo no classpath.

## Relacionados

- [Migrar um projeto Flutter Android para o AGP 9 com Kotlin integrado](/pt-br/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/)
- [Correção: Daemon compilation failed: null em um build Gradle do Flutter Android](/pt-br/2026/09/fix-daemon-compilation-failed-null-in-a-flutter-android-gradle-build/)
- [Correção: Gradle task assembleDebug failed with exit code 1 no Flutter](/pt-br/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/)
- [Correção: Timeout waiting to lock journal cache em um build Flutter Android](/pt-br/2026/10/fix-timeout-waiting-to-lock-journal-cache-in-a-flutter-android-build/)

## Fontes

- [Kotlin evolution principles: binary compatibility](https://kotlinlang.org/docs/kotlin-evolution-principles.html)
- [Kotlin Gradle plugin: compatibility with Gradle and AGP](https://kotlinlang.org/docs/gradle-configure-project.html#apply-the-plugin)
- [Android Gradle Plugin 9.0 release notes](https://developer.android.com/build/releases/agp-9-0-0-release-notes) (dependência de runtime do KGP 2.2.10)
- [Flutter: Kotlin and Gradle version requirements](https://docs.flutter.dev/release/breaking-changes/kotlin-version)
- [flutter/flutter#179253](https://github.com/flutter/flutter/issues/179253), a mesma incompatibilidade reportada com metadados 2.2.0 contra uma versão esperada 1.8.0
