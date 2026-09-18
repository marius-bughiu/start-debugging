---
title: "Migre um projeto Android do Flutter para o AGP 9 com Kotlin integrado"
description: "O caminho completo de um app Flutter no AGP 8 que aplica kotlin-android até o AGP 9.1 com android.builtInKotlin=true no Flutter 3.47. Cada passo foi compilado e medido, incluindo as duas edições que parecem opcionais e não são: kotlinOptions é um erro de compilação no KGP 2.2+, e a linha do KGP em settings.gradle.kts precisa ficar."
pubDate: 2026-09-18
updatedDate: 2026-09-18
template: migration
tags:
  - "migration"
  - "flutter"
  - "android"
  - "gradle"
  - "kotlin"
lang: "pt-br"
translationOf: "2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin"
translatedBy: "claude"
translationDate: 2026-09-18
---

Para um app Flutter criado antes do Flutter 3.44, a migração são quatro edições: atualizar o Gradle wrapper para 9.3.1 e o AGP para 9.1.0, atualizar a versão do Kotlin Gradle Plugin (KGP) em `settings.gradle.kts` para 2.4.0 mas manter a linha, substituir `kotlinOptions` por um bloco `kotlin { compilerOptions { ... } }` no nível superior, e apagar `id("kotlin-android")` de `app/build.gradle.kts`. Depois você ativa `android.builtInKotlin=true` em `gradle.properties`, o que exige Flutter 3.47 ou posterior, e só quando todos os plugins dos quais você depende também tiverem abandonado o KGP. Reserve uma hora para um app com dependências atualizadas, mais se algum plugin ainda aplicar `kotlin-android`. Vale a pena fazer isso agora: o Flutter já se recusa a compilar com Gradle abaixo de 8.14 ou AGP abaixo de 8.11.1, e anunciou que vai remover o suporte ao KGP por completo ([flutter#184837](https://github.com/flutter/flutter/issues/184837)).

Tudo o que segue foi executado no Flutter 3.47.4 stable (revisão do framework `9584c6713b`, Dart 3.13), OpenJDK 17.0.20 e Android SDK build-tools 36.1, partindo de um projeto estruturado exatamente como o template `android-kotlin` do Flutter 3.35: AGP 8.9.1, KGP 2.1.0, Gradle 8.12, `id("kotlin-android")` no módulo do app e um bloco `kotlinOptions`. Também conferi o estado final no Flutter 3.44.8. Cada passo mostra a saída exata que obtive.

## Por que esta migração deixou de ser opcional

- **O Flutter 3.47 impõe versões mínimas que um projeto AGP 8 de 2025 não atende.** `DependencyVersionChecker.kt` no 3.47.4 gera erro com Gradle abaixo de 8.14.0, AGP abaixo de 8.11.1 e KGP abaixo de 2.2.20, e emite aviso abaixo de Gradle 9.1.0, AGP 9.0.1 e KGP 2.3.20. Meu projeto intocado da era 3.35 falhou no primeiro build com `Your project's Gradle version (8.12.0) is lower than Flutter's minimum supported version of 8.14.0`.
- **O AGP 9 inverte dois padrões.** Segundo as [notas de versão do AGP 9.0](https://developer.android.com/build/releases/agp-9-0-0-release-notes), `android.builtInKotlin` e `android.newDsl` passam a ter `true` como padrão. Kotlin integrado significa que o próprio AGP compila o Kotlin, e aplicar `org.jetbrains.kotlin.android` é um erro.
- **As opções de desativação são temporárias dos dois lados.** Os templates do próprio Flutter vêm hoje com `android.builtInKotlin=false` e `android.newDsl=false`, mas a [visão geral da migração para Kotlin integrado](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin) diz que o suporte ao KGP será removido em uma versão futura do Flutter, e o Google diz que a saída de emergência `newDsl=false` desaparece no AGP 10.
- **Seus plugins são avaliados pela mesma regra.** Depois que você ativa o Kotlin integrado, qualquer plugin que ainda aplique `kotlin-android` quebra o seu build, não o CI dele. Encontrar esses plugins cedo é a maior parte do trabalho real.

## O que quebra

| Área | Mudança | Gravidade |
| --- | --- | --- |
| Gradle wrapper | O Flutter 3.47 gera erro abaixo de 8.14; o AGP 9.1 exige 9.3.1 | alta |
| `kotlin-android` no módulo do app | Falha com o Kotlin integrado ativado | alta |
| `kotlinOptions { jvmTarget = ... }` | Erro de compilação de script no KGP 2.2 e posteriores | alta |
| Plugins que aplicam o KGP | Quebram seu build quando `android.builtInKotlin=true` | alta |
| `android.newDsl=true` | O Flutter Gradle Plugin ainda faz cast para a DSL antiga, `ClassCastException` | alta (mantenha `false`) |
| Entrada do KGP em `settings.gradle.kts` | Removê-la faz o Kotlin cair para o 2.2.10 embutido no AGP, abaixo do mínimo do Flutter | média |
| Projetos com `build.gradle` (Groovy) | Mesmas edições, sintaxe diferente; layouts `buildscript` anteriores ao 3.16 precisam antes da migração para plugins declarativos | média |

## Checklist antes de começar

- **Flutter 3.47.x na máquina e no CI.** O Flutter 3.44 adicionou suporte ao AGP 9 com o Kotlin integrado *desativado*; ativá-lo só é suportado a partir do 3.47. Confira com `flutter --version`.
- **JDK 17 ou mais recente para o Gradle.** O AGP 9 exige JDK 17. `flutter doctor -v` mostra qual JDK o Flutter entrega ao Gradle; se for um JRE ou um JDK 11, corrija isso primeiro (veja [o erro de toolchain JAVA_COMPILER](/pt-br/2026/08/fix-toolchain-installation-does-not-provide-the-required-capabilities-in-flutter/) para entender como o Flutter escolhe o JDK).
- **Android SDK build-tools 36.0.0 ou mais recente.** Esse é o mínimo do AGP 9.
- **Uma árvore de trabalho limpa.** A ferramenta do Flutter reescreve `gradle.properties` por conta própria na primeira vez que compila com 3.44+, então faça commit antes de começar e confira o diff depois.
- **Uma lista dos seus plugins Android.** `flutter pub deps --style=compact` basta. Você vai conferir o changelog de cada um em busca de suporte ao Kotlin integrado no passo 6.

## Passos da migração

1. **Deixe a ferramenta do Flutter adicionar as duas flags de desativação e depois confira.** Execute qualquer build Android uma vez com Flutter 3.44 ou posterior. Os migradores da ferramenta acrescentam as duas flags a `android/gradle.properties` se elas estiverem faltando. No meu projeto o build ainda falhou (por causa do Gradle 8.12), mas o arquivo já tinha sido reescrito:

   ```properties
   # android/gradle.properties, written by the Flutter 3.47.4 migrators
   org.gradle.jvmargs=-Xmx8G -XX:MaxMetaspaceSize=4G -XX:ReservedCodeCacheSize=512m -XX:+HeapDumpOnOutOfMemoryError
   android.useAndroidX=true
   # This builtInKotlin flag was added automatically by Flutter migrator
   android.builtInKotlin=false
   # This newDsl flag was added automatically by Flutter migrator
   android.newDsl=false
   ```

   O migrador nunca roda em projetos host de add-to-app, porque o host é um projeto Android comum. Nesse caso você adiciona as duas linhas à mão no `gradle.properties` do host. Verifique: `grep -E 'builtInKotlin|newDsl' android/gradle.properties` imprime as duas linhas.

2. **Atualize o Gradle wrapper para 9.3.1.** O AGP 9.0.x exige Gradle 9.1.0 ou posterior, e as ferramentas do Flutter associam o AGP 9.1.x ao 9.3.1 ou posterior, que também é o que o template do Flutter 3.47 traz:

   ```properties
   # android/gradle/wrapper/gradle-wrapper.properties, Flutter 3.47.4
   distributionUrl=https\://services.gradle.org/distributions/gradle-9.3.1-all.zip
   ```

   Verifique: `cd android && ./gradlew --version` informa `Gradle 9.3.1`.

3. **Atualize o AGP e o KGP em `settings.gradle.kts`, e mantenha a linha do Kotlin.** Estas são as versões que o `flutter create` escreve no 3.47.4:

   ```kotlin
   // android/settings.gradle.kts, Flutter 3.47.4, AGP 9.1.0, KGP 2.4.0
   plugins {
       id("dev.flutter.flutter-plugin-loader") version "1.0.0"
       id("com.android.application") version "9.1.0" apply false
       id("org.jetbrains.kotlin.android") version "2.4.0" apply false
   }
   ```

   Dá vontade de apagar a linha `org.jetbrains.kotlin.android`, já que o objetivo da migração é parar de usar o KGP. Não apague. Com `apply false` ela só coloca aquela versão do Kotlin no classpath do build, e o Kotlin integrado compila com ela. Quando eu a removi, o AGP 9.1.0 voltou para o Kotlin 2.2.10 embutido, e o Flutter Gradle Plugin rejeitou o build: `Your project's Kotlin version (2.2.10) is lower than Flutter's minimum supported version of 2.2.20`. A linha também importa enquanto `builtInKotlin=false`, porque nesse caso o próprio Flutter Gradle Plugin aplica `kotlin-android` a todo subprojeto Android que não o aplica, e precisa do KGP no classpath para isso.

   Verifique: nada ainda. O build continua falhando até o passo 4.

4. **Substitua `kotlinOptions` pela DSL `compilerOptions`.** Esta é a edição que surpreende as pessoas, porque ela é necessária antes mesmo de você mexer no Kotlin integrado. Com AGP 9.1.0, KGP 2.4.0, `kotlin-android` ainda aplicado e `builtInKotlin=false`, meu build falhou na compilação do script:

   ```text
   Script compilation errors:
     Line 18:     kotlinOptions {
                  ^ 'fun BaseAppModuleExtension.kotlinOptions(configure: Action<DeprecatedKotlinJvmOptions>): Unit' is deprecated. Please migrate to the compilerOptions DSL.
     Line 19:         jvmTarget = JavaVersion.VERSION_11.toString()
                      ^ 'var jvmTarget: String' is deprecated. Please migrate to the compilerOptions DSL.
   ```

   [O Kotlin 2.2.0 elevou a depreciação de `kotlinOptions` a erro](https://kotlinlang.org/docs/whatsnew22.html), e o Flutter 3.47 não deixa você ficar abaixo do KGP 2.2.20, então não existe combinação de versões em que `kotlinOptions` sobreviva. Mova o JVM target do bloco `android {}` para um bloco `kotlin {}` no nível superior:

   ```kotlin
   // android/app/build.gradle.kts, Flutter 3.47.4, AGP 9.1.0, KGP 2.4.0
   android {
       // ...
       compileOptions {
           sourceCompatibility = JavaVersion.VERSION_17
           targetCompatibility = JavaVersion.VERSION_17
       }
       // kotlinOptions { jvmTarget = JavaVersion.VERSION_17.toString() }  <- delete
   }

   kotlin {
       compilerOptions {
           jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
       }
   }
   ```

   Mantenha `jvmTarget` igual a `targetCompatibility`. Templates antigos usavam 11, os novos usam 17; qualquer um funciona desde que os dois coincidam. Verifique: `flutter build apk --debug` é bem-sucedido. Neste ponto ele também imprime `WARNING: Your Android app project: app ... applies the Kotlin Gradle Plugin, which will cause build failures in future versions of Flutter.` Esse aviso é esperado, e é justamente o que o passo 5 remove.

5. **Remova `kotlin-android` do módulo do app.** Apague a linha do plugin e nada mais:

   ```kotlin
   // android/app/build.gradle.kts, Flutter 3.47.4
   plugins {
       id("com.android.application")
       // id("kotlin-android")  <- delete
       // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
       id("dev.flutter.flutter-gradle-plugin")
   }
   ```

   Se o seu módulo do app usa a forma de version catalog, a linha a apagar é `alias(libs.plugins.kotlin.android)`. Em um `build.gradle` Groovy, é `apply plugin: 'kotlin-android'` ou `id "kotlin-android"`, e o bloco `kotlin { compilerOptions { ... } }` do passo 4 é Groovy válido do jeito que está. Verifique: `flutter build apk --debug` é bem-sucedido sem aviso de KGP para `app`. Com `builtInKotlin` ainda `false`, o Flutter Gradle Plugin agora aplica o KGP em seu nome, e é por isso que esse estado intermediário compila.

6. **Encontre os plugins que ainda aplicam o KGP.** Compile mais uma vez com `builtInKotlin=false` e leia a saída do Gradle. O Flutter 3.47 lista os nomes para você:

   ```text
   WARNING: Your app uses the following plugins that apply Kotlin Gradle Plugin (KGP): oldplug
   Future versions of Flutter will fail to build if your app uses plugins that apply KGP.
   Please check the changelogs of these plugins and upgrade to a version that supports Built-in Kotlin.
   ```

   Para cada plugin listado, procure no pub.dev uma versão mais nova cujo changelog mencione Kotlin integrado ou AGP 9, e atualize. Se não houver nenhuma, abra uma issue no plugin (o guia do Flutter para desenvolvedores de apps inclui [um template de issue](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin/for-app-developers#report-incompatible-kotlin-gradle-plugin-usage-to-plugin-authors)) e pare aqui: você está no AGP 9 com o Kotlin integrado desativado, que é um estado suportado. Verifique: o aviso não lista mais nenhum plugin.

7. **Ative o Kotlin integrado.** Somente depois que o passo 6 voltar limpo:

   ```properties
   # android/gradle.properties, Flutter 3.47.4, AGP 9.1.0
   android.builtInKotlin=true
   android.newDsl=false
   ```

   Deixe `android.newDsl=false`. Verifique: `flutter build apk --debug` é bem-sucedido sem avisos de KGP, e depois `flutter run` em um dispositivo ou emulador abre o app.

## Checklist de verificação

- `flutter build apk --debug` e `flutter build appbundle --release` são bem-sucedidos sem nenhum aviso `applies the Kotlin Gradle Plugin` na saída.
- Seu código Kotlin realmente foi parar no APK. Conferi isso porque o Kotlin integrado é um caminho de compilação diferente: faça `unzip` do APK e procure seu `MainActivity` nos arquivos `classes*.dex`. No meu projeto migrado, `Lnet/sd/app347/MainActivity;` estava em `classes4.dex`.
- `flutter test` e qualquer suíte `integration_test` continuam passando em um dispositivo Android.
- O CI usa a mesma versão do Flutter e o JDK 17. Uma imagem de CI presa no Flutter 3.44 compila com o Kotlin integrado ativado, mas imprime uma mensagem enganosa (veja as armadilhas).
- `git diff android/` mostra apenas os arquivos acima. Um migrador que reescreveu outra coisa silenciosamente merece ser lido antes do commit.

## Plano de rollback

A migração é reversível em cada passo, e o rollback mais barato é parcial. Se um plugin quebrar depois do passo 7, defina `android.builtInKotlin=false` de novo: com essa flag o AGP 9 aceita o KGP, e o Flutter Gradle Plugin volta a aplicar `kotlin-android` aos módulos que precisam dele, então você não precisa restaurar a linha `kotlin-android` no módulo do app. Um rollback completo para o AGP 8 significa restaurar `settings.gradle.kts` e o wrapper a partir do git, mas no Flutter 3.47 você não pode ficar abaixo de AGP 8.11.1, Gradle 8.14 ou KGP 2.2.20, então "rollback" na prática significa AGP 8.11+, não o seu 8.9 original. A mudança `kotlin { compilerOptions }` do passo 4 fica de qualquer forma.

## Armadilhas que encontrei no caminho

**O primeiro erro não tem nada a ver com Kotlin.** No projeto não migrado, o Flutter 3.47.4 imprimiu o problema real (Gradle 8.12 abaixo de 8.14) dentro da saída do Gradle, e logo abaixo uma caixa "Flutter Fix" dizendo `Starting AGP 9+, only the new DSL interface will be read` e sugerindo desativar `android.newDsl`. O projeto estava no AGP 8.9.1. A caixa é uma heurística que dispara em qualquer falha ao aplicar o Flutter Gradle Plugin, então leia primeiro a seção `* What went wrong:`, o mesmo conselho do [guia do assembleDebug com exit code 1](/pt-br/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).

**A mensagem de erro para um `kotlin-android` esquecido depende da sua versão do KGP.** Com o KGP 2.4.0 ela é explícita:

```text
> Failed to apply plugin 'kotlin-android'.
   > ⛔ Failed to apply plugin 'org.jetbrains.kotlin.android'
     The 'org.jetbrains.kotlin.android' plugin is no longer required for Kotlin support since AGP 9.0.
     Solution: Remove the 'org.jetbrains.kotlin.android' plugin from this project's build file: app/build.gradle.kts.
```

Com versões mais antigas do KGP, o mesmo erro aparece como `Cannot add extension with name 'kotlin'`, que é a forma citada pela maioria das respostas do Stack Overflow. A linha `Solution:` é útil quando o culpado é um plugin: no meu plugin de teste ela apontou para `../../oldplug/android/build.gradle.kts`. Para um pacote do pub.dev, o caminho aponta para dentro de `~/.pub-cache/hosted/pub.dev/<package>-<version>/android/`, o que diz exatamente qual pacote atualizar. Não edite arquivos no pub cache; eles são sobrescritos no próximo `pub get`.

**`android.newDsl=true` ainda é uma falha fatal.** Com todo o resto migrado, ativá-la produziu `class com.android.build.gradle.internal.dsl.ApplicationExtensionImpl$AgpDecorated_Decorated cannot be cast to class com.android.build.gradle.AbstractAppExtension`. O Flutter Gradle Plugin ainda lê os tipos da DSL legada ([flutter#180137](https://github.com/flutter/flutter/issues/180137) acompanha a adaptação). Deixe a flag em `false` até que uma versão do Flutter diga o contrário, e conte com essa versão chegando antes do AGP 10.

**O Flutter 3.44 funciona pela metade com o Kotlin integrado ativado.** A documentação diz que `android.builtInKotlin=true` exige o 3.47. Rodei o projeto totalmente migrado no Flutter 3.44.8 mesmo assim: o APK foi gerado e o `MainActivity` estava no dex, mas a ferramenta imprimiu `Applying the Kotlin Android Plugin (KGP) was unsuccessful. KGP was not found on the classpath.` Isso vem do Flutter Gradle Plugin do 3.44, que não lê a flag e tenta aplicar o KGP de qualquer forma. É inofensivo em um app trivial e confuso em um log de CI, então trate o 3.47 como o mínimo real, exatamente como documentado.

**Projetos anteriores ao 3.16 precisam de uma migração anterior primeiro.** Se o seu `android/build.gradle` ainda tem `buildscript { ext.kotlin_version = '...' }` e o seu módulo do app usa `apply from: ".../flutter.gradle"`, os passos acima não se encaixam direito. Faça antes a [migração para plugins declarativos](https://docs.flutter.dev/release/breaking-changes/flutter-gradle-plugin-apply) e depois volte ao passo 2. Não reproduzi esse layout para este post; a documentação do Flutter é a referência nesse caso. Se em vez disso você estiver travado na mensagem antiga sobre a versão do Kotlin, [o post sobre o erro de versão do KGP](/pt-br/2023/08/flutter-your-project-requires-a-newer-version-of-the-kotlin-gradle-plugin/) mostra onde essa versão fica nos layouts mais antigos.

**O Gradle 9 transforma outros avisos antigos em erros.** O Gradle 9 removeu APIs que o Gradle 8 apenas marcava como obsoletas, então um plugin antigo pode falhar por motivos que não têm relação com Kotlin. Se um aviso do JDK 24 como `A restricted method in java.lang.System has been called` aparecer junto, ele é tratado em [um post próprio](/pt-br/2026/08/fix-a-restricted-method-in-java-lang-system-has-been-called-in-a-flutter-gradle-build/).

## Resultados medidos

| Estado do projeto (Flutter 3.47.4, salvo indicação) | Resultado |
| --- | --- |
| AGP 8.9.1, KGP 2.1.0, Gradle 8.12, `kotlin-android` | Falha: Gradle abaixo de 8.14 |
| AGP 9.1.0, KGP 2.4.0, Gradle 9.3.1, `kotlinOptions` mantido | Falha: erros de compilação de script |
| Igual, `compilerOptions`, `kotlin-android` mantido, `builtInKotlin=false` | Compila, aviso de KGP para `app` |
| Igual, `builtInKotlin=true` | Falha: KGP não é mais necessário desde o AGP 9.0 |
| `kotlin-android` removido, `builtInKotlin=true` | Compila, 4,0 s incremental |
| Linha do KGP removida de `settings.gradle.kts` | Falha: Kotlin 2.2.10 abaixo de 2.2.20 |
| Plugin aplicando KGP, `builtInKotlin=true` | Falha, indica o arquivo de build do plugin |
| Plugin aplicando KGP, `builtInKotlin=false` | Compila, o aviso lista o plugin |
| Migrado, `newDsl=true` | Falha: `ClassCastException` no Flutter Gradle Plugin |
| Migrado, `builtInKotlin=true`, Flutter 3.44.8 | Compila, mensagem enganosa "KGP was not found" |

## Relacionados

- [Correção: Gradle task assembleDebug failed with exit code 1 em um build Android do Flutter](/pt-br/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/)
- [Correção: Toolchain installation does not provide the required capabilities: [JAVA_COMPILER]](/pt-br/2026/08/fix-toolchain-installation-does-not-provide-the-required-capabilities-in-flutter/)
- [Correção: A restricted method in java.lang.System has been called em um build Gradle do Flutter](/pt-br/2026/08/fix-a-restricted-method-in-java-lang-system-has-been-called-in-a-flutter-gradle-build/)
- [Correção: flutter doctor --android-licenses falha com cmdline-tools 23](/pt-br/2026/09/fix-flutter-doctor-android-licenses-fails-with-cmdline-tools-23/)
- [Flutter: your project requires a newer version of the Kotlin Gradle plugin](/pt-br/2023/08/flutter-your-project-requires-a-newer-version-of-the-kotlin-gradle-plugin/)

## Fontes

- [Migrating Flutter Android projects to built-in Kotlin](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin) e o [guia para desenvolvedores de apps](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin/for-app-developers), documentação do Flutter.
- [Built-in Kotlin migration for plugin authors](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin/for-plugin-authors), documentação do Flutter.
- [Notas de versão do Android Gradle Plugin 9.0](https://developer.android.com/build/releases/agp-9-0-0-release-notes): Gradle 9.1.0, JDK 17, dependência de runtime do KGP 2.2.10, novos padrões.
- [What's new in Kotlin 2.2.0](https://kotlinlang.org/docs/whatsnew22.html): depreciação de `kotlinOptions` elevada a erro.
- Código-fonte do Flutter 3.47.4: `packages/flutter_tools/gradle/src/main/kotlin/DependencyVersionChecker.kt` (versões mínimas), `FlutterPluginUtils.kt` (`isBuiltInKotlinEnabled`, KGP aplicado automaticamente), `lib/src/android/migrations/disable_built_in_kotlin_migration.dart`.
- Issues do Flutter [#181383](https://github.com/flutter/flutter/issues/181383), [#183909](https://github.com/flutter/flutter/issues/183909), [#184837](https://github.com/flutter/flutter/issues/184837), [#180137](https://github.com/flutter/flutter/issues/180137).
