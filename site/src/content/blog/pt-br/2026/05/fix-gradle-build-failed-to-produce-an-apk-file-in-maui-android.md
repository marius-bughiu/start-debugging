---
title: "Correção: o build do Gradle falhou em produzir um arquivo .apk no MAUI Android"
description: "Nove em cada dez vezes o erro real do Gradle está enterrado mais acima no log do MSBuild. Caminho do JDK 17, workload maui-android ausente e caminhos longos no Windows são as causas raiz mais comuns."
pubDate: 2026-05-15
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "maui"
  - "maui-11"
  - "android"
  - "gradle"
lang: "pt-br"
translationOf: "2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android"
translatedBy: "claude"
translationDate: 2026-05-15
---

A correção: este erro do MSBuild quase nunca é o erro real. Role o log do build para cima passando dele até atingir a primeira linha `error` do `gradlew.bat` ou `aapt2`. Nove em cada dez vezes a causa real é uma de três coisas: `JAVA_HOME` aponta para o JDK 11 (o Android Gradle Plugin 8.x no MAUI 11 precisa do JDK 17), o workload `android` ou `maui-android` não foi restaurado após uma atualização do .NET SDK, ou uma violação de caminho longo no Windows truncou a saída ofuscada do R8. Corrija o erro subjacente e o `.apk` será produzido no próximo build.

```text
C:\Program Files\dotnet\sdk\11.0.100\Sdks\Microsoft.NET.Sdk\targets\Microsoft.NET.RuntimeIdentifierInference.targets(311,5):
error XA1029: The Gradle build failed to produce an .apk file. Please check the diagnostic log.
```

Este guia foi escrito contra o .NET 11 GA, o target framework `net11.0-android`, o .NET MAUI 11.0.0 e o Android Gradle Plugin (AGP) que vem com o `Xamarin.Android.Sdk` 35.x (a versão que a Microsoft fixa para `dotnet workload install android` no .NET 11). O código `XA1029` é lançado por `Xamarin.Android.Build.Tasks` depois que `gradlew assembleDebug` ou `assembleRelease` saem com código diferente de zero. O texto "failed to produce an .apk file" é um wrapper, não a causa.

## Por que o MAUI Android encapsula o erro real do Gradle

O MAUI não chama o Gradle diretamente durante um `dotnet build` normal. O target específico de Android do MSBuild (`_CompileToDalvikWithD8`, `_GenerateAndroidPackage`) escreve um `build.gradle.kts` gerado em `obj/Debug/net11.0-android/<rid>/android/`, e então executa o `gradlew.bat` (Windows) ou `gradlew` (macOS, Linux) embutido. Quando `gradlew` sai com código diferente de zero, a tarefa do MSBuild engole o log do Gradle de vários milhares de linhas em um único arquivo de diagnóstico em `obj/Debug/net11.0-android/<rid>/android/build.log` e emite `XA1029`. O Visual Studio expõe apenas o wrapper. O stack trace real, a dependência ausente, a rejeição do JDK ou a falha de assinatura estão em `build.log` mais as linhas imediatamente acima de `XA1029` no painel de saída do MSBuild.

Trate `XA1029` como um HTTP 500: ele diz que o build quebrou, não o que quebrou. O primeiro movimento é sempre encontrar a linha real `> Task :` que falhou.

## Lendo o log de diagnóstico para encontrar a causa real

A partir de um terminal no diretório do seu projeto, refaça o build com a verbosidade que expõe cada linha do Gradle:

```bash
# .NET 11 SDK, MAUI 11.0.0
dotnet build -t:Run -f net11.0-android \
  -p:AndroidPackageFormat=apk \
  -bl:msbuild.binlog \
  -v:diag
```

Em seguida, abra `msbuild.binlog` no [MSBuild Structured Log Viewer](https://msbuildlog.com/) e busque por `FAILURE: Build failed`. A linha acima dele nomeia a tarefa do Gradle que falhou: `:app:processDebugResources`, `:app:mergeDebugResources`, `:app:lintVitalReportRelease` ou `:app:compileDebugJavaWithJavac` são os suspeitos comuns. Cada uma aponta para uma categoria específica de correção abaixo.

Se o binlog estiver vazio para a fase do Gradle, isso significa que o Gradle nunca iniciou, o que por sua vez significa que a resolução de `JAVA_HOME` ou a restauração do workload falhou antes que qualquer tarefa rodasse. Pule para as seções de JDK e workload.

## Causa 1: JAVA_HOME aponta para o JDK errado

Esta é a causa mais comum depois de uma atualização do .NET SDK. O AGP 8.x, que vem com o Xamarin.Android 35 (o padrão do .NET 11), recusa-se a iniciar sob o JDK 11 com este erro dentro do `build.log`:

```text
> Task :app:checkKotlinGradlePluginConfigurationErrors
A problem occurred starting Gradle worker
> Could not resolve the Java toolchain '11'.
> Android Gradle plugin requires Java 17 to run. You are currently using Java 11.
```

A superfície correspondente do MSBuild é `XA1029`. A Microsoft documentou o piso do JDK para o MAUI como Java 11 para a era .NET 6 a .NET 8, depois Java 17 do MAUI 9 em diante, acompanhando o requisito do AGP upstream. Veja a issue de longa data do MAUI [dotnet/maui#18906](https://github.com/dotnet/maui/issues/18906) para a quebra original.

A correção é apontar `JAVA_HOME` para uma instalação do JDK 17. Em uma máquina Windows com Visual Studio 2026, o OpenJDK 17 embutido fica em `C:\Program Files\Microsoft\jdk-17.0.x-hotspot`. Defina-o de forma permanente:

```powershell
# PowerShell, as the same user that runs dotnet build
[Environment]::SetEnvironmentVariable(
  "JAVA_HOME",
  "C:\Program Files\Microsoft\jdk-17.0.12.7-hotspot",
  "User")
```

Em seguida, reinicie o shell ou, em CI, passe também `-p:JavaSdkDirectory=...` na linha de comando do `dotnet build` para que o MSBuild o capture sem depender do ambiente herdado:

```bash
dotnet build -f net11.0-android \
  -p:JavaSdkDirectory="/usr/lib/jvm/temurin-17-jdk-amd64"
```

Você pode verificar qual JDK o MSBuild realmente selecionou procurando por `JdkDirectory` no binlog, ou rodando `dotnet build -t:_ResolveAndroidTooling -v:diag | findstr Jdk`.

## Causa 2: workload maui-android ou android ausente

A segunda causa mais comum: você atualizou o .NET SDK na máquina (ou instalou do zero em CI) e nunca restaurou os workloads. A tarefa do MSBuild falha em `_GenerateAndroidPackage` porque o pack `Xamarin.Android.Sdk` que possui a integração do Gradle não está em disco. O wrapper ainda é `XA1029`; o erro real dentro do `build.log` é:

```text
> Task :app:processDebugResources FAILED
The 'aapt2' executable was not found at ...\Xamarin.Android.Sdk.x.x.x\tools\aapt2.exe
```

Restaure o workload fixado à banda do SDK que você tem instalada:

```bash
# .NET 11 GA -- installs both the android pack and maui-android
dotnet workload install maui-android
dotnet workload restore
```

`dotnet workload restore` percorre cada `*.csproj` no diretório atual, lê seus `TargetFrameworks` e instala quaisquer packs que cada target framework precise. Em CI esse é o único comando que vale a pena rodar porque é idempotente e fixado por versão. O `dotnet workload install maui-android` standalone é a chamada certa em uma máquina de desenvolvimento nova. A Microsoft documenta a divisão de workloads em [Install workloads with dotnet workload install](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-workload-install).

Se você instalou o MAUI através do instalador do Visual Studio 2026 e depois também rodou `dotnet workload install maui` da CLI, pode acabar em um estado onde o Visual Studio não consegue localizar nenhuma das cópias. A documentação de troubleshooting do MAUI detalha a [sequência completa de desinstalação e reinstalação](https://learn.microsoft.com/en-us/dotnet/maui/troubleshooting), que é mais trabalho do que parece, mas é a única recuperação confiável de um estado de workload dividido.

## Causa 3: violação de caminho longo no Windows na saída obj

A terceira causa recorrente é puramente um artefato do Windows. R8 e `aapt2` ambos escrevem caminhos ofuscados profundamente aninhados em `obj\Debug\net11.0-android\android\app\build\intermediates\`. Para um projeto em `C:\src\MyCompany\MyProduct\Mobile\MyProduct.Mobile.csproj` o caminho completo de um arquivo `.dex` intermediário rotineiramente excede o limite herdado `MAX_PATH` de 260 caracteres. O worker do Gradle reporta isso como:

```text
> Task :app:mergeExtDexDebug FAILED
java.io.IOException: Cannot delete '...\transforms\...\classes.dex' (path too long)
```

Duas correções, em ordem de preferência:

1. Mova o repositório para uma raiz mais curta: `C:\src\Mobile\` em vez de `C:\Users\you\source\repos\MyCompany\Mobile\`.
2. Habilite o suporte a caminhos longos no SO, no .NET SDK e no Git. Como PowerShell de Administrador:

   ```powershell
   New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" `
     -Name "LongPathsEnabled" -Value 1 -PropertyType DWORD -Force
   git config --system core.longpaths true
   ```

   Em seguida, adicionar `<UseAppHost>false</UseAppHost>` não é a correção aqui; o que você realmente precisa é a entrada do manifesto. Edite seu `.csproj` para definir `<EnableLongPaths>true</EnableLongPaths>` (Xamarin.Android 35+) e garanta que o `app.manifest` do seu projeto declare `longPathAware`. O lado Android do build captura a flag do SO depois que você sair e entrar novamente.

A primeira opção é mais rápida e funciona em qualquer máquina sem admin. Tome-a a menos que o caminho do seu repositório seja fixado por política.

## Causa 4: lintVitalRelease falha apenas em um build Release

Se `dotnet build -c Debug` tiver sucesso e `dotnet publish -c Release -f net11.0-android` falhar com `XA1029`, a tarefa do Gradle que morreu é `:app:lintVitalReportRelease`. O AGP 8 promoveu falhas de lint de avisos para erros de build em configurações Release. Você verá isso em `build.log`:

```text
> Task :app:lintVitalReportRelease FAILED
Lint found errors in the project; aborting build.
```

A correção certa é ler o relatório de lint em `obj/Release/net11.0-android/android/app/build/reports/lint-results-release.html` e tratar os problemas reais (traduções ausentes, strings hardcoded em rótulos `<application>`, APIs Android obsoletas mirando `compileSdkVersion 35`).

A correção errada-mas-tentadora é suprimir o lint:

```xml
<!-- .csproj, .NET 11, MAUI 11 -- escape hatch only -->
<PropertyGroup Condition="'$(Configuration)' == 'Release'">
  <AndroidLintAbortOnError>false</AndroidLintAbortOnError>
</PropertyGroup>
```

Use isso apenas como um desbloqueio tático para uma versão que precisa ser lançada hoje. Achados de lint sobre declarações `android:exported` ausentes são bugs reais no Android 31+ e eventualmente vão crashar no launch.

## Causa 5: keystore ausente ou errado para builds Release assinados

Um build Release assinado adiciona `:app:signReleaseBundle` à lista de tarefas. Se o caminho do keystore se resolver para nada, o AGP falha com:

```text
> Task :app:signReleaseBundle FAILED
Keystore file '/Users/runner/work/_temp/myapp.keystore' not found for signing config 'release'.
```

Em uma máquina de desenvolvedor, isso significa que sua propriedade MSBuild `<AndroidSigningKeyStore>` aponta para um arquivo que não existe para o usuário atual. Em CI, geralmente significa que o segredo contendo o keystore codificado em base64 não foi decodificado no caminho que o `csproj` referencia. A invocação mínima correta de CI:

```bash
# .NET 11, MAUI 11 -- GitHub Actions
echo "$ANDROID_KEYSTORE_BASE64" | base64 --decode > $RUNNER_TEMP/release.keystore
dotnet publish src/MyApp/MyApp.csproj \
  -f net11.0-android \
  -c Release \
  -p:AndroidPackageFormat=apk \
  -p:AndroidKeyStore=true \
  -p:AndroidSigningKeyStore=$RUNNER_TEMP/release.keystore \
  -p:AndroidSigningStorePass=$ANDROID_KEYSTORE_PASS \
  -p:AndroidSigningKeyAlias=$ANDROID_KEY_ALIAS \
  -p:AndroidSigningKeyPass=$ANDROID_KEY_PASS
```

As quatro propriedades `AndroidSigning*` são obrigatórias juntas. Definir apenas três delas falha com o mesmo `XA1029` e uma linha de tarefa do Gradle diferente. A Microsoft documenta os nomes das propriedades em [Publish a .NET MAUI app for Android](https://learn.microsoft.com/en-us/dotnet/maui/android/deployment/publish-cli).

## Causa 6: daemon do Gradle corrompido ou cache .gradle obsoleto

Após uma longa sequência de builds falhos, o cache do Gradle no escopo do usuário em `~/.gradle/caches/` pode aterrissar em um estado em que cada build subsequente falha com um `XA1029` genérico e um `build.log` reclamando de arquivos de lock. Apague o cache e a distribuição do Gradle no escopo do workload:

```bash
# kills the daemon, deletes the cache, deletes the user gradle wrapper distribution
gradle --stop 2>/dev/null
rm -rf ~/.gradle/caches/ ~/.gradle/daemon/
rm -rf ~/.gradle/wrapper/dists/
```

No Windows o equivalente é `Remove-Item -Recurse -Force "$env:USERPROFILE\.gradle\caches"`. O próximo build vai rebaixar a distribuição do AGP (cerca de 200 MB) e re-hidratar o grafo de dependências; leva de 5 a 10 minutos da primeira vez e é rápido depois disso.

Esta é a correção certa para "funcionava ontem e nada mudou". É a correção errada quando você consegue nomear o que mudou (uma atualização de workload, uma troca de JDK, um novo pacote NuGet); persiga a causa primeiro.

## Detalhes e erros parecidos

- `XA0119: Could not find android.jar for API level 35` é um erro irmão do mesmo estágio. É sempre uma instalação ausente de `android-sdk;platforms;android-35`, não um problema do Gradle. Rode `androidsdkmanager --install platforms;android-35`.
- `error : Java.Interop.Tools.Diagnostics.XamarinAndroidException: Output directory does not exist` também é do `Xamarin.Android.Build.Tasks`, mas mais cedo no pipeline. Geralmente significa que `obj/` está somente leitura porque o Defender colocou um arquivo em quarentena. Verifique `Get-Acl obj` e o log de quarentena do Defender.
- `MSB6006: "java.exe" exited with code 1` da fase do linker tem um nome enganoso: é o `R8` minification falhando em uma classe que ele não consegue rastrear. Adicione uma regra de ProGuard e tente novamente. Veja o detalhamento em [um post recente sobre ajuste de cold-start](/pt-br/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) para os mecanismos subjacentes; os mesmos contratos de trim/AOT se aplicam no Android.
- "Build SUCCESS" sem um `.apk` em `bin/` acontece quando `<AndroidPackageFormat>aab</AndroidPackageFormat>` está definido em um `Directory.Build.props` pai. O build produz um `.aab` (App Bundle) em vez disso, que é o que a Play Store realmente quer. O texto `XA1029` diz ".apk" apenas porque é o padrão histórico; a verificação subjacente é "o passo de empacotamento escreveu seu arquivo de saída esperado?"

## Relacionado

- [Como empacotar um app MAUI para a Microsoft Store](/pt-br/2026/05/how-to-package-a-maui-app-for-the-microsoft-store/) percorre o lado Windows do mesmo pipeline de publicação.
- [.NET 11 preview 4: dotnet watch finalmente chega ao MAUI Android e iOS](/pt-br/2026/05/dotnet-watch-maui-android-ios-net-11-preview-4/) cobre as ferramentas de inner-loop que rodam em cima do mesmo arnês de Gradle.
- [MAUI no .NET 11 preview 4 torna o CoreCLR padrão para Android e iOS](/pt-br/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/) explica por que a troca de runtime moveu algumas regras de lint de avisos para erros em builds Release.
- [Como migrar um Xamarin.Forms ListView de alto desempenho para MAUI CollectionView](/pt-br/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/) é a razão mais comum pela qual um projeto que compilava bem no Xamarin começa a bater em `XA1029` após a migração para o MAUI.

## Fontes

- [Troubleshoot known issues in .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/troubleshooting), Microsoft Learn, .NET MAUI 11.
- [dotnet/maui#18906: GitHub Actions no longer builds MAUI Android: Java SDK 11.0 or above is required](https://github.com/dotnet/maui/issues/18906), a issue canônica que rastreia a mudança do requisito de JDK.
- [dotnet/maui Discussion #24164: Cannot build apk in Release](https://github.com/dotnet/maui/discussions/24164), thread da comunidade enumerando causas de `XA1029` exclusivas de Release.
- [Publish a .NET MAUI app for Android with the CLI](https://learn.microsoft.com/en-us/dotnet/maui/android/deployment/publish-cli), a fonte de verdade para as propriedades MSBuild `AndroidSigning*`.
- [Java versions in Android builds](https://developer.android.com/build/jdks), documentação do time Android sobre o piso do JDK por versão do AGP.
- [Install workloads with dotnet workload install](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-workload-install), a semântica de instalação / restauração de workloads referenciada acima.
