---
title: "Como habilitar a redução e a ofuscação do R8 em um build de release Android do .NET MAUI"
description: "Defina AndroidLinkTool como r8, mantenha o trimming ligado e adicione um arquivo ProguardConfiguration. Por que o .NET 10 e o .NET 11 RC 1 ainda entregam Java sem ofuscação, como a nova propriedade AndroidR8ObfuscationMode muda isso e como verificar se o R8 realmente rodou."
pubDate: 2026-09-13
template: how-to
tags:
  - "dotnet-maui"
  - "android"
  - "r8"
  - "dotnet-11"
  - "dotnet-10"
  - "google-play"
lang: "pt-br"
translationOf: "2026/09/how-to-enable-r8-shrinking-and-obfuscation-for-a-dotnet-maui-android-release-build"
translatedBy: "claude"
translationDate: 2026-09-13
---

**Resposta curta:** adicione `<AndroidLinkTool>r8</AndroidLinkTool>` a um `PropertyGroup` exclusivo de Release no `.csproj` do seu MAUI, deixe o trimming ligado (ele já vem ligado por padrão em Release) e coloque as regras de keep em um arquivo `proguard.cfg` com a build action `ProguardConfiguration`. Isso liga a redução e a otimização do R8 no lado Java do seu app. Isso **não** ofusca nada nos SDKs disponíveis hoje: o .NET for Android 36.1.69 (.NET 10) e o 37.0.0-rc.1.2257 (.NET 11 RC 1) injetam `-dontobfuscate` na configuração do R8. A ofuscação de verdade chega com a nova propriedade `AndroidR8ObfuscationMode`, cujo padrão é `private-members` no .NET 11 depois do RC 1 e que é um backport opcional para a próxima versão de manutenção do .NET 10.

Esse último detalhe importa mais do que antes. O Google anunciou em 26 de agosto de 2026 que, a partir de fevereiro de 2027, os app bundles no Google Play vão precisar de pelo menos 25% de cobertura de otimização, redução e ofuscação do código DEX (o Android vitals só emite alerta quando um bundle carrega 10 MB de DEX, no caso de apps, ou 50 MB, no caso de jogos). Um app MAUI puxa muito Java do AndroidX e do Google Play services, então o lado DEX não é pequeno.

Tudo o que vem abaixo foi rastreado no código-fonte do `dotnet/android` nas tags de release citadas acima, então você mesmo pode conferir cada afirmação nos targets do MSBuild.

## O que o R8 toca em um app MAUI, e o que ele não toca

Um pacote Android do MAUI carrega dois tipos de código, e eles são reduzidos por ferramentas diferentes:

- **Código gerenciado** (seu C#, o MAUI, a BCL) é aparado pelo ILLink quando `PublishTrimmed` é `true`. O R8 nunca o vê. Ofuscar C# é um problema separado que o R8 não resolve.
- **Bytecode Java** (AndroidX, Material, Google Play services, Firebase, qualquer `.aar` que você faça binding, além dos Java Callable Wrappers que o build gera para cada tipo gerenciado que estende um tipo Java) é transformado em `classes.dex`. Por padrão, o compilador D8 faz isso sem nenhuma redução. Com `AndroidLinkTool=r8`, o R8 gera o DEX e reduz em uma única passada.

As porcentagens do Google Play são medidas sobre o DEX, que é exatamente a metade do R8. Então, quando alguém diz "habilite o R8 no MAUI", está falando de deixar essa metade Java menor e, com o tempo, renomeada.

Só a redução já vale a pena. Na [dotnet/android #12535](https://github.com/dotnet/android/issues/12535), um desenvolvedor mediu um app .NET 10 no 36.1.69 com 20,18 MB de DEX descomprimido usando D8 e 11,43 MB usando R8 com as regras padrão do SDK. É quase metade do código Java removida, sem nenhuma regra de keep escrita à mão.

## A alteração mínima no projeto

Esta é a configuração completa para um app MAUI voltado para .NET 10 e .NET 11:

```xml
<!-- MyApp.csproj, .NET 10 (Microsoft.Android.Sdk 36.1.x) and .NET 11 RC 1 (37.0.0-rc.1) -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFrameworks>net11.0-android;net11.0-ios</TargetFrameworks>
    <OutputType>Exe</OutputType>
    <UseMaui>true</UseMaui>
  </PropertyGroup>

  <PropertyGroup Condition="'$(Configuration)' == 'Release' And $(TargetFramework.Contains('-android'))">
    <AndroidLinkTool>r8</AndroidLinkTool>
    <!-- Default in Release already. Written out because R8 without trimming strips Java types your C# still uses. -->
    <PublishTrimmed>true</PublishTrimmed>
  </PropertyGroup>

  <ItemGroup Condition="$(TargetFramework.Contains('-android'))">
    <ProguardConfiguration Include="Platforms/Android/proguard.cfg" />
  </ItemGroup>
</Project>
```

Depois, publique como de costume:

```bash
dotnet publish -f net11.0-android -c Release
```

O `proguard.cfg` pode começar vazio. Você só adiciona regras a ele quando o R8 remove algo que é acessado por reflexão, o que é tratado mais adiante.

## O que o SDK faz quando você define AndroidLinkTool

`AndroidLinkTool` é a única chave de que você precisa, porque o `Xamarin.Android.Common.targets` deriva o resto a partir dela. Resumido dos targets do .NET 10 e do .NET 11:

```xml
<!-- Xamarin.Android.Common.targets (dotnet/android 36.1.69 and 37.0.0-rc.1.2257), condensed -->
<AndroidDexTool   Condition=" '$(AndroidLinkTool)' == 'r8' ">d8</AndroidDexTool>
<AndroidLinkTool  Condition=" '$(AndroidLinkTool)' == 'proguard' And '$(AndroidEnableDesugar)' == 'True' ">r8</AndroidLinkTool>
<AndroidEnableProguard Condition=" '$(AndroidLinkTool)' != '' ">True</AndroidEnableProguard>
<AndroidCreateProguardMappingFile Condition="'$(AndroidCreateProguardMappingFile)' == '' And '$(AndroidLinkTool)' == 'r8'">True</AndroidCreateProguardMappingFile>
<AndroidProguardMappingFile Condition=" '$(AndroidLinkTool)' == 'r8' And '$(AndroidCreateProguardMappingFile)' == 'True' ">$(OutputPath)mapping.txt</AndroidProguardMappingFile>
```

Algumas consequências decorrem disso:

- `AndroidLinkTool=proguard` é silenciosamente promovido para `r8`, porque o desugaring vem ligado por padrão com o D8. A ferramenta ProGuard standalone não é usada pelo .NET for Android moderno.
- O antigo `AndroidEnableProguard=true` / `EnableProguard=true` da era Xamarin ainda funciona, mas produz o aviso XA1028 (ou XA1027) e define a ferramenta de link como `proguard` por padrão, que depois vira `r8`. Defina `AndroidLinkTool` diretamente e evite o aviso.
- Um `mapping.txt` é gerado em `$(OutputPath)` por padrão (por exemplo `bin/Release/net11.0-android/mapping.txt`), e o `dotnet publish` o copia para a pasta de publicação. Quando você compila um `.aab`, o arquivo de mapeamento também é embutido nos metadados do bundle como `com.android.tools.build.obfuscation/proguard.map`, então o Play Console o recebe sem upload manual. Para um `.apk` instalado por sideload, você mesmo faz o upload.

## Por que o R8 precisa do trimming ligado

O R8 não consegue descobrir sozinho quais tipos Java o seu C# ainda usa. Essa lista vem do trimmer do .NET: depois que o ILLink roda, uma etapa customizada escreve `proguard_project_references.cfg` com uma regra de keep para cada tipo Java ao qual um tipo gerenciado sobrevivente faz binding. O target que o gera é condicionado ao trimming:

```xml
<!-- Microsoft.Android.Sdk.TypeMap.LlvmIr.targets, 37.0.0-rc.1.2257 -->
<Target Name="_GenerateProguardConfiguration"
    AfterTargets="_PrepareLinkedAssembliesForProguard"
    Condition=" '$(PublishTrimmed)' == 'true' and '$(_ProguardProjectConfiguration)' != '' "
```

A decisão de rodar o R8, porém, não verifica o trimming. O `Xamarin.Android.D8.targets` só precisa que a propriedade de caminho esteja definida, e o `_ResolveAssemblies` a define em todo build em que `AndroidLinkTool` não está vazio:

```xml
<!-- Xamarin.Android.D8.targets, same in 36.1.69 and 37.0.0-rc.1.2257 -->
<_UseR8 Condition=" ('$(AndroidLinkTool)' == 'r8' And '$(_ProguardProjectConfiguration)' != '') Or '$(AndroidEnableMultiDex)' == 'True' ">True</_UseR8>
```

Então, com `PublishTrimmed=false` (ou `AndroidLinkMode=None` em Release, um contorno comum para problemas de reflexão), o R8 ainda roda, mas sem o arquivo que protege seus bindings. O build apenas registra XA4304 ("ProGuard configuration file '...proguard_project_references.cfg' was not found"), e o app morre com `java.lang.ClassNotFoundException` na primeira vez que toca um tipo Java que o R8 removeu. Essa sequência exata é a [dotnet/android #6612](https://github.com/dotnet/android/issues/6612), em que os mantenedores confirmaram que o R8 depende do linker do .NET estar habilitado.

É também por isso que a condição de Release no arquivo de projeto não é cosmética. Builds de Debug não fazem trimming, então um `AndroidLinkTool=r8` incondicional faz o Debug rodar o R8 sem o arquivo de referências também, e com o fast deployment ligado você ainda recebe XA0119: "Using fast deployment and a code shrinker at the same time is not recommended".

## Quais arquivos de configuração o R8 realmente recebe

Quando o R8 roda, o SDK monta as entradas `--pg-conf` nesta ordem (itens `_ProguardConfiguration` em `Xamarin.Android.Common.targets`):

1. `$(ProguardConfigFiles)`, se você definir essa propriedade.
2. O `proguard-android.txt` do Android SDK (base sem otimização). Em SDKs mais novos com `AndroidR8ObfuscationMode=private-members`, ele passa a ser `proguard-android-optimize.txt`.
3. `obj/.../proguard/proguard_xamarin.cfg`: regras de keep do runtime para `mono.android.**`, `net.dot.jni.**` e afins. Nos SDKs disponíveis hoje, esse arquivo começa com `-dontobfuscate`.
4. `proguard_project_references.cfg`: regras de keep para cada tipo Java ao qual um tipo gerenciado sobrevivente faz binding, geradas depois do ILLink.
5. `proguard_project_primary.cfg`: uma regra `-keep class X { *; }` por Java Callable Wrapper do mapa de ACW, para que toda `Activity`, `Service` e `View` customizada que o seu C# define sobreviva.
6. Seus itens `@(ProguardConfiguration)`.
7. Regras de consumidor (`proguard.txt`) extraídas dos arquivos `.aar` referenciados.

Os itens 4 e 5 explicam por que um app MAUI raramente precisa de regras de keep escritas à mão para os próprios tipos: o build já sabe quais classes Java o lado gerenciado consegue alcançar. O que ele não sabe é o que o código Java alcança por reflexão.

## Por que hoje você ganha redução, mas não ofuscação

As opções do ProGuard são globais. Se qualquer arquivo de configuração disser `-dontobfuscate`, a ofuscação fica desligada em toda a execução do R8, e não existe flag oposta que você possa adicionar no seu próprio `proguard.cfg` para religá-la. Como o `proguard_xamarin.cfg` no 36.1.69 e no 37.0.0-rc.1.2257 contém essa linha, um build MAUI com R8 em qualquer um dos dois SDKs reduz e otimiza, mas mantém todos os nomes Java intactos. O `mapping.txt` gerado ainda registra membros removidos e mudanças de número de linha, mas não vai mostrar renomeações.

As medições da #12535 batem com isso: 34 de 15.235 classes renomeadas no `mapping.txt` de um app (0,2%), e o Play Console reportando 1% de ofuscação para outro. Definir `AndroidCreateProguardMappingFile=true`, como algumas respostas sugerem, não muda nada aqui; isso só controla se o arquivo de mapeamento é gerado.

O `-dontobfuscate` geral foi a escolha segura. O JNI associa peers gerenciados a classes Java pelo nome, então renomear um Java Callable Wrapper ou um método do AndroidX com binding quebraria as buscas do `JNIEnv` em runtime. A mesma thread descobriu que remover a linha à mão também não basta: as regras de keep geradas não protegiam campos que os bindings leem pelo nome via JNI, então os apps travavam na inicialização. Espere pela chave suportada descrita abaixo em vez de remendar a configuração do SDK.

## Ligando a ofuscação de verdade com AndroidR8ObfuscationMode

O [dotnet/android #12668](https://github.com/dotnet/android/pull/12668), mesclado em 10 de setembro de 2026, substitui a regra geral por uma seletiva e adiciona uma propriedade pública:

| `AndroidR8ObfuscationMode` | Ofuscação | Base de otimização | Padrão |
|---|---|---|---|
| `disabled` | nenhuma, todos os nomes Java preservados | `proguard-android.txt` | manutenção do .NET 10 |
| `private-members` | membros private e package-private renomeados | `proguard-android-optimize.txt` | .NET 11 depois do RC 1 |

No mesmo dia, o [#12752](https://github.com/dotnet/android/pull/12752) fez o backport para `release/10.0.1xx` com `disabled` como padrão, para que uma atualização de manutenção não altere apps existentes. Nenhuma tag lançada contém isso ainda (o 36.1.69 é anterior, e o `release/11.0.1xx-rc1` foi criado antes do merge), então espere por isso no .NET 11 RC 2 e na próxima atualização de manutenção do .NET 10.

No modo `private-members`, a task do R8 escreve estas regras no lugar de `-dontobfuscate`:

```proguard
# Generated by the R8 task in dotnet/android main (post .NET 11 RC 1)
-keep,allowshrinking,allowoptimization class **
-keepclassmembers,allowshrinking,allowoptimization class ** {
   public protected *;
}
-keep,allowoptimization interface ** {
   public protected *;
}
-keep,allowshrinking class * implements **
```

Leia assim: toda classe mantém o nome, todo membro public e protected mantém o nome, e qualquer coisa private ou package-private pode ser renomeada. Código não usado ainda pode ser removido. As regras de interface existem porque a seleção de proxy gerenciado chama `Class.getInterfaces()`, que o R8 não enxerga; sem elas, a fusão de classes poderia descartar uma relação de interface e entregar o proxy errado ao código gerenciado.

Para habilitar no .NET 10 quando a versão de manutenção sair, ou para desabilitar no .NET 11:

```xml
<!-- .NET 10 servicing (opt in) or .NET 11 (opt out with "disabled") -->
<PropertyGroup Condition="'$(Configuration)' == 'Release' And $(TargetFramework.Contains('-android'))">
  <AndroidLinkTool>r8</AndroidLinkTool>
  <AndroidR8ObfuscationMode>private-members</AndroidR8ObfuscationMode>
</PropertyGroup>
```

Qualquer outro valor faz o build falhar com XA1050: "The 'AndroidR8ObfuscationMode' MSBuild property has an invalid value". O PR também remove as chaves não documentadas `_AndroidR8DontObfuscate` e `_AndroidR8DontOptimize`, então tire-as do seu projeto se você as copiou de alguma thread de issue.

Mantenha as expectativas calibradas. O PR relata que o Google Play mediu um template `dotnet new maui -sc` com 62% de otimização, 65% de redução e 28% de ofuscação. Isso passa da barra de 25%, mas a ofuscação é a mais apertada, porque nomes visíveis ao JNI não podem ser renomeados. Trate `private-members` como "suficiente para o requisito do Play", não como proteção para a lógica do seu C#.

## Escrevendo regras de keep que realmente importam

O R8 só remove código Java que ele consegue provar que é inalcançável. O código que precisa de regras é aquele alcançado de formas que o R8 não enxerga:

```proguard
# Platforms/Android/proguard.cfg  (.NET 10 / .NET 11, R8 via AndroidLinkTool=r8)

# A Java SDK that loads its own classes with Class.forName and ships no consumer rules
-keep class com.example.vendorsdk.** { *; }

# Classes you look up by string from C#, e.g. Java.Lang.Class.ForName("com.example.Probe")
-keep class com.example.Probe { *; }

# JSON models serialized by a Java library (Gson, Moshi) that uses reflection
-keepattributes Signature,*Annotation*
-keep class com.example.api.models.** { <fields>; }

# Silence a known-harmless missing optional class instead of ignoring all warnings
-dontwarn androidx.window.extensions.**
```

Vale a pena adicionar duas regras de diagnóstico temporariamente enquanto você faz esse ajuste, porque o seu próprio arquivo `ProguardConfiguration` é tratado como configuração da aplicação e pode usar opções globais:

```proguard
# Temporary: dump what R8 removed and the fully merged configuration
-printusage r8-usage.txt
-printconfiguration r8-merged.txt
```

O R8 resolve esses caminhos relativos a partir da pasta do arquivo de configuração, então os dois vão parar ao lado do `proguard.cfg`. Procure `-dontobfuscate` em `r8-merged.txt` para confirmar qual comportamento de ofuscação o seu SDK aplicou, e procure um nome de classe em `r8-usage.txt` para provar que o R8 a removeu antes de escrever uma regra para ela. Remova as duas linhas antes de fazer commit, porque elas aumentam o tempo de todo build de Release.

## Armadilhas que pegam na prática

- **Avisos de classe ausente ficam ocultos por padrão.** `AndroidR8IgnoreWarnings` tem `True` como padrão, o que adiciona `-ignorewarnings` e (desde o .NET 8) passa `--map-diagnostics warning info`, então as mensagens "Missing class" do R8 aparecem como linhas de info em um log de build detalhado. É por isso que issues como a [dotnet/maui #10901](https://github.com/dotnet/maui/issues/10901) (`androidx.window.extensions.WindowExtensions`) normalmente não fazem o build falhar. Defini-la como `False` é mais rigoroso e pode transformar uma classe ausente em erro de build. Resolva com um `-dontwarn` direcionado, não voltando a chave global.
- **Um caminho digitado errado é só um aviso.** Se o caminho do `ProguardConfiguration` não existir, você recebe XA4304 ("ProGuard configuration file '...' was not found") e o R8 roda sem as suas regras. Trate XA4304 como erro no CI com `<WarningsAsErrors>XA4304</WarningsAsErrors>`.
- **`EnableR8` e `AndroidLinkMode=r8` não fazem nada.** Nenhuma das duas existe como chave do R8. O MSBuild aceita propriedades desconhecidas em silêncio, e `AndroidLinkMode` só controla o trimmer gerenciado (`None`, `SdkOnly`, `Full`). Só `AndroidLinkTool=r8` liga o R8.
- **Regras de biblioteca com opções globais são ignoradas.** A partir do .NET 11 Preview 7, um `proguard.txt` dentro de um `.aar` que contenha `-dontobfuscate`, `-dontoptimize`, `-printmapping` ou algo semelhante é descartado com XA4322, a mesma restrição que o AGP 9 introduziu. Se uma biblioteca de terceiros de repente travar depois do upgrade, procure XA4322 no log de build e copie as regras de keep dela (sem a opção global) para o seu próprio `proguard.cfg`.
- **A página de build items do MS Learn está desatualizada.** Ela diz que os arquivos `ProguardConfiguration` são ignorados a menos que `EnableProguard` seja `True`. Com `AndroidLinkTool=r8`, `AndroidEnableProguard` é forçado para `True` para você, então os itens são usados.
- **Stack traces ofuscados precisam do arquivo de mapeamento.** Quando `private-members` estiver ligado, os frames Java privados em um relatório de crash aparecem como `a.b.c`. Guarde o `mapping.txt` de todo build de Release que você publicar (o `.aab` o leva para o Play, e ferramentas de relatório de crash como o Firebase Crashlytics precisam dele enviado separadamente).
- **O R8 custa tempo de build.** Espere que builds de Release demorem bem mais, já que o R8 faz análise de programa inteiro sobre todo o bytecode do AndroidX e do Play services. Mantenha-o só em Release.

## Verificando se o R8 realmente rodou

Não confie só na propriedade; confirme pela saída do build:

1. Compile com um log binário: `dotnet publish -f net11.0-android -c Release -bl`. Abra o `msbuild.binlog` no MSBuild Structured Log Viewer e procure a task `R8` sob `_CompileToDalvik`. Se você só encontrar `D8`, a propriedade nunca chegou ao build Android, geralmente porque a condição dela não bate com o seu `TargetFramework`. Se o R8 rodou, mas o log contém XA4304 para `proguard_project_references.cfg`, o trimming está desligado e o app vai travar em runtime.
2. Verifique se `bin/Release/net11.0-android/mapping.txt` existe e tem um timestamp recente.
3. Abra `obj/Release/net11.0-android/android-arm64/proguard/proguard_xamarin.cfg` (a pasta de RID exata depende dos seus `RuntimeIdentifiers`). No 36.1.69 ou no 37.0.0-rc.1.2257, ele começa com `-dontobfuscate`. Em um SDK com `AndroidR8ObfuscationMode=private-members`, ele começa com o bloco `-keep,allowshrinking,allowoptimization class **`.
4. Envie o `.aab` para uma faixa de teste interno e leia as porcentagens de otimização, redução e ofuscação no explorador de app bundles do Play Console. Esse é o número que o Google exige, então é ele que você deve acompanhar. O Play lê as porcentagens de um arquivo de metadados de build `r8.json` quando o bundle tem um e, caso contrário, as estima a partir do `mapping.txt`. O SDK passa a empacotar o `r8.json` com o [dotnet/android #12646](https://github.com/dotnet/android/pull/12646), que está em `release/10.0.1xx` e `main`, mas não no 37.0.0-rc.1.2257.

## Leitura relacionada

- Se o Play também rejeitou o seu bundle por alinhamento de biblioteca nativa, a correção está em [Google Play rejeitando um app MAUI por causa do tamanho de página de 16 KB](/pt-br/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/).
- Trocar o runtime muda o conteúdo do APK com que o R8 trabalha; veja [migrando um app MAUI Android do Mono para o CoreCLR no .NET 11](/pt-br/2026/09/migrate-a-dotnet-maui-android-app-from-mono-to-coreclr-in-dotnet-11/).
- O outro requisito do Play com prazo neste ciclo é tratado em [mirando o Android API level 36 a partir do .NET MAUI](/pt-br/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/).
- Quando um build de Release falha dentro da toolchain Java em vez de falhar em silêncio, comece por [Gradle build failed to produce an .apk file no MAUI Android](/pt-br/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/).
- A técnica do `-printusage` acima é a mesma usada para descartar o R8 como causa em [login do Firebase Auth que não persiste em um build de release Android do Flutter](/pt-br/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/).

## Fontes

- [Propriedades de build do .NET for Android](https://learn.microsoft.com/en-us/dotnet/android/building-apps/build-properties) (`AndroidLinkTool`, `AndroidCreateProguardMappingFile`, `AndroidProguardMappingFile`, `AndroidR8IgnoreWarnings`)
- [Build items do .NET for Android](https://learn.microsoft.com/en-us/dotnet/android/building-apps/build-items) (`ProguardConfiguration`, `AndroidAppBundleMetaDataFile`)
- [Especificação da integração do D8 e do R8](https://github.com/dotnet/android/blob/main/Documentation/guides/D8andR8.md) no dotnet/android
- [`Xamarin.Android.D8.targets`](https://github.com/dotnet/android/blob/37.0.0-rc.1.2257/src/Xamarin.Android.Build.Tasks/Xamarin.Android.D8.targets) e [`proguard_xamarin.cfg`](https://github.com/dotnet/android/blob/37.0.0-rc.1.2257/src/Xamarin.Android.Build.Tasks/Resources/proguard_xamarin.cfg) no 37.0.0-rc.1.2257
- [dotnet/android #6612: R8 sem o linker do .NET](https://github.com/dotnet/android/issues/6612) e [#12535: -dontobfuscate incondicional versus o requisito do Play](https://github.com/dotnet/android/issues/12535)
- [dotnet/android #12668: ofuscação e otimização configuráveis de membros privados](https://github.com/dotnet/android/pull/12668) e o [backport para o .NET 10 #12752](https://github.com/dotnet/android/pull/12752)
- [Android Developers Blog: redução do uso de memória e melhoria da migração entre dispositivos](https://android-developers.googleblog.com/2026/08/app-quality-memory-optimization-secure-onboarding.html) (requisito de otimização de DEX de fevereiro de 2027)
- [Otimização de código DEX no Android vitals](https://developer.android.com/topic/performance/vitals/code-optimization) (limites de 10 MB / 50 MB de DEX)
