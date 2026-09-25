---
title: "Correção: e: Daemon compilation failed: null em um build Android Gradle do Flutter"
description: "No Windows, a compilação incremental do Kotlin falha quando o projeto Flutter e o pub cache estão em unidades diferentes. Mova o PUB_CACHE para a unidade do projeto ou desative a IC para os plugins do pub cache."
pubDate: 2026-09-25
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "kotlin"
lang: "pt-br"
translationOf: "2026/09/fix-daemon-compilation-failed-null-in-a-flutter-android-gradle-build"
translatedBy: "claude"
translationDate: 2026-09-25
---

Isso acontece no Windows quando o seu projeto Flutter está em uma unidade (`D:\`) e o pub cache está em outra (`C:\Users\<you>\AppData\Local\Pub\Cache`). O compilador incremental do Kotlin armazena cada arquivo-fonte de plugin como um caminho relativo à sua pasta `android\`. Não existe caminho relativo de `D:\` para `C:\`, então `compileDebugKotlin` quebra para plugins como `shared_preferences_android`. A melhor correção é colocar o `PUB_CACHE` na mesma unidade dos seus projetos e depois executar `flutter clean` e `flutter pub get`. Se não puder fazer isso, defina `kotlin.incremental=false` apenas para os subprojetos de plugin (trecho abaixo). No Kotlin Gradle Plugin 2.3.0 e anteriores o APK ainda é gerado e o erro é só ruído. A partir do KGP 2.3.20 (o template do Flutter 3.44) e do KGP 2.4.0 (Flutter 3.47) o build pode falhar de vez.

As versões abaixo foram conferidas com Flutter 3.47.5 (Dart 3.13.4, AGP 9.1.0, Gradle 9.3.1, KGP 2.4.0), `shared_preferences` 2.5.5 / `shared_preferences_android` 2.4.28 e o código-fonte do Kotlin Gradle Plugin nas tags `v1.9.22` até `v2.4.20`.

## O erro em contexto

Os relatos em [flutter/flutter#173456](https://github.com/flutter/flutter/issues/173456) e [flutter/flutter#144566](https://github.com/flutter/flutter/issues/144566) são todos assim, uma vez por plugin:

```text
e: Daemon compilation failed: null
java.lang.Exception
	at org.jetbrains.kotlin.daemon.common.CompileService$CallResult$Error.get(CompileService.kt:69)
	at org.jetbrains.kotlin.daemon.common.CompileService$CallResult$Error.get(CompileService.kt:65)
	at org.jetbrains.kotlin.compilerRunner.GradleKotlinCompilerWork.compileWithDaemon(GradleKotlinCompilerWork.kt:244)
	...
Caused by: java.lang.AssertionError: java.lang.Exception: Could not close incremental caches in
  D:\src\my_app\build\shared_preferences_android\kotlin\compileReleaseKotlin\cacheable\caches-jvm\jvm\kotlin:
  class-fq-name-to-source.tab, source-to-classes.tab, internal-name-to-source.tab
	at org.jetbrains.kotlin.incremental.IncrementalCachesManager.close(IncrementalCachesManager.kt:55)
	...
	Suppressed: java.lang.IllegalArgumentException: this and base files have different roots:
	  C:\Users\me\AppData\Local\Pub\Cache\hosted\pub.dev\shared_preferences_android-2.4.28\android\src\main\kotlin\io\flutter\plugins\sharedpreferences\LegacySharedPreferencesPlugin.kt
	  and D:\src\my_app\android.
```

A primeira linha diz `null` porque o daemon embrulha a falha real em um `java.lang.Exception` genérico, sem mensagem. A linha útil é a última: `this and base files have different roots`. Se o seu log tem essa linha, este post é a sua correção. Se não tem, pule para "Erros parecidos" no final.

## Por que o compilador incremental do Kotlin precisa de uma única unidade

A compilação incremental (IC) do Kotlin mantém tabelas de consulta em `build/<module>/kotlin/compile<Variant>Kotlin/cacheable/caches-jvm`. As tabelas mapeiam cada arquivo-fonte para as classes que ele gera. Para manter o build cache do Gradle relocável, o Kotlin 1.9.20 passou a armazenar esses caminhos relativos a um diretório base em vez de caminhos absolutos. Este é o conversor do `build-common` no repositório do Kotlin:

```kotlin
// Kotlin build-common, RelocatableFileToPathConverter.kt (unchanged through 2.4.20)
override fun toPath(file: File): String {
    // ...
    // Note: If the given file is located outside `baseDir`, the relative path will start with "../".
    // It's not "clean", but it can work.
    return file.relativeTo(baseDir).invariantSeparatorsPath
}
```

Para arquivos-fonte, `baseDir` é o **diretório do projeto raiz**, que em um app Flutter é `<project>\android`. Plugins Flutter são subprojetos Gradle, mas o código-fonte deles fica no pub cache, fora dessa pasta. No macOS e no Linux isso funciona, porque todo caminho compartilha a raiz `/`. No meu Mac, o cache de IC de `shared_preferences_android` contém de fato esta entrada:

```text
../../../../../../../../Users/marius/.pub-cache/hosted/pub.dev/shared_preferences_android-2.4.28/android/src/main/kotlin/io/flutter/plugins/sharedpreferences/LegacySharedPreferencesPlugin.kt
```

No Windows, `D:\src\my_app\android` e `C:\Users\...\Pub\Cache` têm raízes diferentes. Nenhuma sequência de `..\` leva de uma unidade à outra, então `File.relativeTo` lança `IllegalArgumentException`. A exceção ocorre enquanto a IC grava seus caches, por isso aparece como "Could not close incremental caches" e o daemon a reporta como "Daemon compilation failed".

É também por isso que os contornos clássicos funcionam: "mova o projeto para `C:`", "faça downgrade do Kotlin para 1.9.10" (a última versão antes dos caminhos relativos) e "só falha com alguns plugins" (só plugins com código-fonte Kotlin passam pelo compilador Kotlin). A JetBrains acompanha a causa raiz como [KT-63983](https://youtrack.jetbrains.com/issue/KT-63983), que continua em "To be discussed". Um engenheiro da JetBrains observou que a correção trivial (`relativeToOrSelf`) causaria acertos incorretos no build cache. Do lado do Flutter, a issue é [flutter/flutter#105395](https://github.com/flutter/flutter/issues/105395), aberta desde 2022.

O mesmo crash atinge qualquer configuração em que código-fonte e projeto raiz estejam em raízes diferentes: unidades virtuais com `subst` ([KT-65155](https://youtrack.jetbrains.com/issue/KT-65155)), um diretório de build em RAM disk ou um caminho do WSL como `\mnt\d\project` misturado com `D:\project`.

## Por que o APK às vezes é gerado mesmo assim

Muita gente relata que o log fica cheio de linhas `e:` e depois imprime `√ Built build\app\outputs\flutter-apk\app-release.apk`. Outros, principalmente desde o Flutter 3.44, recebem um `BUILD FAILED` de verdade. A diferença está no caminho de compilação que o Kotlin Gradle Plugin segue depois que o daemon falha. Eu li isso no código-fonte do KGP em cada tag:

| Versão do KGP | Caminho de compilação padrão | Fallback após a falha do daemon | Resultado em um projeto com unidades diferentes |
| --- | --- | --- | --- |
| 1.9.20 a 2.3.0 | `GradleKotlinCompilerWork` | `compileInProcess`, que é explicitamente **não incremental** ("in-process execution strategy is non-incremental") | Saída `e:` ruidosa, APK é gerado |
| 2.3.20 e posteriores | Build Tools API (`kotlin.compiler.runViaBuildToolsApi` tem padrão `true`) | `performCompilation(IN_PROCESS)` com a **mesma** configuração incremental, incluindo `ROOT_PROJECT_DIR` | O fallback cai no mesmo `relativeTo`, o build pode falhar |

O template do Flutter fixa a versão do KGP em `android/settings.gradle.kts`, então a sua versão do Flutter no momento do `flutter create` decide em qual linha você está:

| Template do Flutter | `templateKotlinGradlePluginVersion` |
| --- | --- |
| 3.35.0 | 2.1.0 |
| 3.38.0, 3.41.0 | 2.2.20 |
| 3.44.0 | 2.3.20 |
| 3.47.0 a 3.47.5 | 2.4.0 |

Isso bate com as threads das issues. Os relatos de 2025 no Flutter 3.32 e 3.35 dizem "o APK ainda é gerado". Os comentários de junho de 2026 dizem "tive esse problema depois de atualizar para o Flutter 3.44". O relato de agosto de 2026 no 3.47.0 com AGP 9.1.0 e KGP 2.4.0 mostra `:shared_preferences_android:compileDebugKotlin` derrubando o build em uma execução limpa. Essas pessoas não estão vendo um bug novo. O fallback do Kotlin que escondia o antigo simplesmente deixou de escondê-lo.

## Reprodução mínima

Você precisa de Windows com duas unidades (ou uma unidade `subst`). Mantenha o pub cache padrão em `C:`:

```powershell
# Windows 11, Flutter 3.47.5, default PUB_CACHE on C:
D:
cd \src
flutter create --platforms=android daemon_repro
cd daemon_repro
flutter pub add shared_preferences
flutter build apk --debug
```

Um projeto 3.47.5 recém-criado recebe `com.android.application` 9.1.0, `org.jetbrains.kotlin.android` 2.4.0 e Gradle 9.3.1, com a IC do Kotlin ativada por padrão. Sem o plugin, o app do template não tem nada fora de `android\` para o Kotlin compilar, então o build passa sem erros. Isso explica a observação comum "quebrou assim que adicionei um pacote".

## Correção 1: coloque o pub cache na mesma unidade dos seus projetos

Esta é a correção recomendada. Ela elimina a causa e mantém a compilação incremental em todo lugar. Escolha uma pasta na unidade onde ficam seus projetos, aponte o `PUB_CACHE` para ela e resolva as dependências de novo:

```powershell
# Windows, any Flutter 3.x: user-level env var, picked up by new shells and IDEs
[Environment]::SetEnvironmentVariable("PUB_CACHE", "D:\PubCache", "User")

# open a NEW terminal (and restart VS Code / Android Studio), then:
cd D:\src\my_app
flutter clean
flutter pub get
flutter build apk --debug
```

`flutter pub get` baixa os pacotes para o novo cache e regenera `.dart_tool\package_config.json` e `.flutter-plugins-dependencies`. O plugin Gradle do Flutter lê os caminhos dos plugins desses arquivos, então todo subprojeto de plugin passa a apontar para `D:\PubCache\...`. O `flutter clean` é importante porque os caches de IC antigos em `build\` ainda guardam caminhos do layout anterior. Depois você pode apagar o antigo `C:\Users\<you>\AppData\Local\Pub\Cache`.

O limite desta correção: se você mantém projetos em várias unidades, só uma delas pode coincidir com o cache. Nesse caso, use a correção 2.

## Correção 2: desative a compilação incremental só para os subprojetos de plugin

Plugins do pub cache nunca mudam entre builds, então a IC não economiza nada com eles. O seu próprio módulo `app` é onde a IC compensa, e o código-fonte dele fica dentro de `android\`, então ele não é afetado. O KGP lê `kotlin.incremental` por projeto, incluindo as extra properties do projeto, então você pode limitar o escopo da chave. Acrescente isto ao `android/build.gradle.kts`:

```kotlin
// android/build.gradle.kts, Flutter 3.47.5, AGP 9.1.0, KGP 2.4.0
// Kotlin incremental compilation stores source paths relative to this
// directory. Plugins from the pub cache live outside it, which breaks on
// Windows when the cache is on another drive (KT-63983). Turn IC off for
// those subprojects only; the :app module stays incremental.
subprojects {
    if (!projectDir.canonicalPath.startsWith(rootDir.canonicalPath)) {
        extra["kotlin.incremental"] = "false"
    }
}
```

Para um `android/build.gradle` em Groovy, o equivalente é:

```groovy
// android/build.gradle, Flutter 3.35 to 3.47
subprojects {
    if (!projectDir.canonicalPath.startsWith(rootDir.canonicalPath)) {
        ext.set("kotlin.incremental", "false")
    }
}
```

Verifiquei isso no macOS com o projeto de reprodução 3.47.5, observando quais módulos gravam caches de IC depois de `flutter clean && flutter build apk --debug`. Sem o trecho, existem tanto `build/app/kotlin/compileDebugKotlin/cacheable/caches-jvm` quanto `build/shared_preferences_android/.../caches-jvm`. Com ele, só o de `app` existe, e o APK é gerado. A versão em Groovy deu o mesmo resultado. Não tenho aqui uma máquina Windows com segunda unidade, então não vi pessoalmente o crash do Windows sumir, mas o mecanismo é o mesmo: com a IC desativada, o KGP não monta nenhuma configuração incremental e nada chama `RelocatableFileToPathConverter`.

Duas abordagens que parecem corretas **não** funcionam, e testei as duas no 3.47.5:

- `tasks.withType<KotlinCompile>().configureEach { incremental = false }` dentro de `subprojects {}`. A ação de configuração do próprio KGP executa `task.incremental = propertiesProvider.incrementalJvm ?: true` depois e sobrescreve o seu valor. Uma sonda com `doFirst` imprimiu `incremental=true`.
- Envolver a mesma coisa em `afterEvaluate {}`. Mesmo resultado: os caches continuaram sendo gravados.

Definir a propriedade que o próprio KGP lê é a única chave por módulo que sobrevive.

Uma dependência por caminho dentro do seu repositório (`path: ../packages/my_plugin`) também fica fora de `android\`, então o trecho desativa a IC para ela também. Isso custa uma recompilação completa do Kotlin desse plugin a cada build, normalmente um ou dois segundos. Se isso importar, restrinja a verificação a caminhos do pub cache, por exemplo `projectDir.canonicalPath.contains("Pub${File.separator}Cache")`.

## Correção 3: desative a compilação incremental do Kotlin globalmente

A correção mais bruta, e a mais citada nas threads das issues. Em `android/gradle.properties`:

```properties
# android/gradle.properties, any Flutter / KGP version
kotlin.incremental=false
```

Funciona, e confirmei que depois disso nenhuma pasta `caches-jvm` é criada para nenhum módulo. O custo é que o Kotlin do seu módulo `app` também é recompilado do zero a cada build. Para o único `MainActivity.kt` do template do Flutter isso não importa. Para um app com bastante Kotlin nativo (platform channels, um widget, um módulo Wear OS) isso pesa durante o `flutter run`. Nesse caso, prefira a correção 1 ou a correção 2.

## O que não fazer

- **Não faça downgrade do KGP para 1.9.10.** É a última versão antes dos caminhos relativos, então o crash some. Mas o Flutter 3.47 rejeita KGP abaixo de 2.2.20 e o AGP 9 exige um KGP moderno, então você estaria prendendo todo o seu toolchain Android em 2023.
- **Não defina `kotlin.compiler.runViaBuildToolsApi=false` para trazer de volta o comportamento antigo de "o APK é gerado mesmo assim".** No KGP 2.4 essa propriedade está anotada como obsoleta (KT-85433, "non-BTA JVM compiler invocation is deprecated") e ainda registra o crash no log a cada build. Ela esconde o problema até o próximo KGP removê-la.
- **Não defina `kotlin.daemon.useFallbackStrategy=false`.** Isso transforma o caso "o APK é gerado mesmo assim" em uma falha definitiva também nas versões antigas do KGP.
- **Não mova o Flutter SDK.** A localização do SDK é irrelevante aqui. O plugin Gradle do Flutter é um included build com raiz própria, e o código-fonte dele fica ao lado. Só importa a divisão entre a unidade do pub cache e a do projeto.

## Erros parecidos

Nem toda linha `Daemon compilation failed` é este bug. Confira as linhas `Caused by` e `Suppressed`:

- **`Daemon compilation failed: Could not connect to Kotlin compile daemon`**. O daemon não iniciou ou morreu, muitas vezes por interferência do antivírus ou falta de memória. Execute `cd android; .\gradlew --stop` e compile de novo. Em versões antigas do KGP o fallback compila sem o daemon, então este costuma ser inofensivo.
- **Um `OutOfMemoryError` no daemon ou no Gradle**. Aumente `kotlin.daemon.jvmargs` e `org.gradle.jvmargs` em `gradle.properties`, veja [flutter/flutter#133371](https://github.com/flutter/flutter/issues/133371).
- **`Module was compiled with an incompatible version of Kotlin`**. Um plugin foi compilado com uma versão de metadados do Kotlin mais nova que o seu KGP. Isso é incompatibilidade de versões, não um problema de IC, e está coberto no [guia de migração para o AGP 9](/pt-br/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/).
- **Um `Gradle task assembleDebug failed with exit code 1` genérico** sem linhas do daemon do Kotlin. Comece pelo [checklist geral do assembleDebug](/pt-br/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).

Os logs brutos do daemon ficam em `android\.kotlin\errors\errors-<timestamp>.log` e `%TEMP%\kotlin-daemon.*.log`. Procure por `different roots` neles se a saída do console estiver truncada.

## Relacionados

- [Migrar um projeto Android do Flutter para o AGP 9 com Kotlin integrado](/pt-br/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/) explica o template AGP 9.1 / KGP 2.4 que transformou este aviso em falha.
- [Correção: Gradle task assembleDebug failed with exit code 1 no Flutter](/pt-br/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) é o post central sobre falhas de build Android.
- [Correção: A restricted method in java.lang.System has been called em um build Gradle do Flutter](/pt-br/2026/08/fix-a-restricted-method-in-java-lang-system-has-been-called-in-a-flutter-gradle-build/), outra mensagem barulhenta do Gradle em que você precisa decidir se ela é fatal.
- [Correção: flutter doctor --android-licenses falha com cmdline-tools 23](/pt-br/2026/09/fix-flutter-doctor-android-licenses-fails-with-cmdline-tools-23/) para o outro problema comum do toolchain Android no Windows deste mês.
- [Depurando Flutter iOS a partir do Windows](/pt-br/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/) se o Windows é a sua máquina principal para Flutter.

## Fontes

- [flutter/flutter#173456](https://github.com/flutter/flutter/issues/173456) (aberta), incluindo a reprodução de 2026-08-16 no Flutter 3.47.0, AGP 9.1.0, KGP 2.4.0, e [flutter/flutter#105395](https://github.com/flutter/flutter/issues/105395), a issue que acompanha o problema de unidades diferentes.
- [flutter/flutter#144566](https://github.com/flutter/flutter/issues/144566) e [flutter/flutter#170534](https://github.com/flutter/flutter/issues/170534), relatos anteriores com o stack completo.
- [KT-63983](https://youtrack.jetbrains.com/issue/KT-63983), [KT-65155](https://youtrack.jetbrains.com/issue/KT-65155) e [KT-80077](https://youtrack.jetbrains.com/issue/KT-80077) no tracker do Kotlin.
- Código-fonte do Kotlin: [`RelocatableFileToPathConverter.kt`](https://github.com/JetBrains/kotlin/blob/master/build-common/src/org/jetbrains/kotlin/incremental/storage/RelocatableFileToPathConverter.kt), `GradleKotlinCompilerWork.kt` e `btapi/BuildToolsApiCompilationWork.kt` em `libraries/tools/kotlin-gradle-plugin`, e `PropertiesProvider.kt` / `KotlinCompileConfig.kt` nas tags `v2.3.0`, `v2.3.20` e `v2.4.0`.
- Código-fonte do Flutter: `packages/flutter_tools/lib/src/android/gradle_utils.dart` (`templateKotlinGradlePluginVersion`) nas tags 3.35.0 até 3.47.5.
- [Kotlin Gradle plugin compilation and caches](https://kotlinlang.org/docs/gradle-compilation-and-caches.html) no kotlinlang.org, para `kotlin.incremental`.
- [Environment variables for pub](https://dart.dev/tools/pub/environment-variables) no dart.dev, para `PUB_CACHE`.
