---
title: "Fix: Doesn't support required ABI ao instalar um app .NET MAUI para Android"
description: "O APK não contém nenhuma biblioteca nativa para a CPU do dispositivo. Desde o .NET 9 os RuntimeIdentifiers padrão do Android são apenas de 64 bits, então a correção é definir RuntimeIdentifiers explicitamente. Cobre ADB0020, XA0036, NETSDK1083, o mapeamento de ABI para RID, o texto do Play Console e por que o trecho de quatro RIDs que todo mundo copia quebra no .NET 11."
pubDate: 2026-08-29
template: error-page
tags:
  - "errors"
  - "maui"
  - "dotnet"
  - "android"
  - "dotnet-11"
  - "coreclr"
lang: "pt-br"
translationOf: "2026/08/fix-doesnt-support-required-abi-when-installing-a-dotnet-maui-android-app"
translatedBy: "claude"
translationDate: 2026-08-29
---

O pacote do app não contém nenhuma biblioteca nativa para a CPU da máquina em que você está instalando. O Android recusa a instalação em vez de executar o binário errado. Desde o .NET 9, um projeto `net9.0-android` ou posterior compila apenas `arm64-v8a` e `x86_64`, enquanto o mesmo projeto no .NET 8 compilava quatro ABIs, então o gatilho costuma ser uma atualização e não algo que você mudou. A correção é definir `$(RuntimeIdentifiers)` no target framework do Android. O conjunto correto de RIDs depende da versão do .NET em que você está, porque o .NET 11 removeu o Android x86 por completo, o que faz o trecho de quatro RIDs presente na maioria dos resultados de busca quebrar a compilação.

## O erro em contexto

A mesma causa raiz aparece com três textos diferentes, dependendo de quem está instalando.

Ao implantar pelo Visual Studio ou por `dotnet build -t:Run` você recebe um erro de compilação do .NET for Android:

```
error ADB0020: The package does not support the CPU architecture of this device.
```

Instalando o APK você mesmo com o `adb` do SDK do Android, ele relata a falha subjacente:

```
adb: failed to install com.company.app-Signed.apk:
Failure [INSTALL_FAILED_NO_MATCHING_ABIS: Failed to extract native libraries, res=-113]
```

O ADB0020 é exatamente a tradução disso feita pelo .NET for Android, somada ao antigo `INSTALL_FAILED_CPU_ABI_INCOMPATIBLE`. E o Google Play Console diz a mesma coisa em termos de catálogo de dispositivos, que é de onde vem a expressão "required ABI":

```
Doesn't support required ABI: arm64-v8a, x86_64
```

No aparelho do usuário, a mesma condição aparece como "Seu dispositivo não é compatível com esta versão" na Play Store, ou como um simples "App não instalado" no caso de um APK instalado manualmente.

## Qual ABI o dispositivo realmente quer?

Pergunte a ele. Todo dispositivo Android e todo emulador publica as ABIs suportadas em ordem de prioridade:

```bash
adb shell getprop ro.product.cpu.abilist
```

Um celular moderno responde `arm64-v8a,armeabi-v7a`. Um dispositivo somente de 64 bits responde `arm64-v8a`. Uma imagem de emulador em um Mac com Apple Silicon responde `arm64-v8a`, e uma imagem x86_64 do Google responde `x86_64,arm64-v8a` apenas se tiver tradução de ARM, algo em que não convém confiar.

Depois pergunte ao pacote o que ele traz. As bibliotecas nativas ficam em `lib/<abi>/` dentro do APK:

```bash
unzip -l bin/Release/net11.0-android/com.company.app-Signed.apk | grep 'lib/'
```

```text
lib/arm64-v8a/libmonodroid.so
lib/arm64-v8a/libSystem.Native.so
lib/x86_64/libmonodroid.so
lib/x86_64/libSystem.Native.so
```

Em um app bundle o prefixo é `base/lib/`:

```bash
unzip -l bin/Release/net11.0-android/com.company.app-Signed.aab | grep 'base/lib/'
```

A interseção dessas duas listas é vazia. É esse o bug inteiro. A listagem acima instala em um emulador Apple Silicon e em um celular moderno, e falha em qualquer dispositivo cujo `abilist` seja apenas `armeabi-v7a`.

## O que mudou no .NET 9

O .NET 8 e anteriores compilavam as quatro ABIs do Android por padrão. O .NET 9 estreitou o padrão de `$(RuntimeIdentifiers)` para Android ao par de 64 bits:

```text
net8.0-android    armeabi-v7a  arm64-v8a  x86  x86_64
net9.0-android                 arm64-v8a       x86_64
net10.0-android                arm64-v8a       x86_64
net11.0-android                arm64-v8a       x86_64
```

O raciocínio é que o .NET segue os fabricantes das plataformas móveis, e o Google exige uma build de 64 bits para envios à Play desde 2019. Nada avisa em tempo de compilação, porque do ponto de vista da build não há nada errado. Você descobre quando alguém do time de testes com um aparelho antigo não consegue instalar, ou quando o catálogo de dispositivos do Play Console remove silenciosamente vários milhares de modelos da sua lista de compatíveis.

Se o seu app é um projeto pessoal ou mira hardware recente, o novo padrão é o correto e você deve deixá-lo como está. Duas ABIs de 64 bits em vez de quatro reduzem um APK de MAUI praticamente à metade.

## A correção

Defina `$(RuntimeIdentifiers)` explicitamente, condicionado ao target framework do Android para que não vaze para as builds de iOS ou Windows:

```xml
<!-- .NET 9 and .NET 10 -->
<PropertyGroup Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'android'">
  <RuntimeIdentifiers>android-arm;android-arm64;android-x86;android-x64</RuntimeIdentifiers>
</PropertyGroup>
```

Um projeto de target único pode usar a condição mais simples sobre a string do TFM:

```xml
<PropertyGroup Condition="'$(TargetFramework)' == 'net10.0-android'">
  <RuntimeIdentifiers>android-arm;android-arm64;android-x64</RuntimeIdentifiers>
</PropertyGroup>
```

Esse segundo conjunto é o que você deve usar por padrão. Ele restaura o ARM de 32 bits, a única ABI de 32 bits com hardware real por trás, e deixa de fora o x86 de 32 bits, que na prática significa imagens de emulador antigas e um punhado de tablets com Intel Atom.

Recompile depois de mudar isso. As bibliotecas nativas por ABI ficam preparadas em `obj/`, e uma build incremental reaproveita alegremente um layout anterior à propriedade.

## Nomes de ABI não são runtime identifiers

Esta é a primeira tentativa frustrada mais comum. `$(AndroidSupportedAbis)` recebia nomes de ABI, então as pessoas colam nomes de ABI na propriedade que a substituiu:

```xml
<!-- wrong -->
<RuntimeIdentifiers>armeabi-v7a;arm64-v8a;x86;x86_64</RuntimeIdentifiers>
```

```text
error NETSDK1083: The specified RuntimeIdentifier 'armeabi-v7a' is not recognized.
```

Os dois vocabulários se correspondem um a um:

| ABI do Android | Runtime identifier do .NET |
| --- | --- |
| `armeabi-v7a` | `android-arm` |
| `arm64-v8a` | `android-arm64` |
| `x86` | `android-x86` |
| `x86_64` | `android-x64` |

Note que `x86_64` mapeia para `android-x64` e não para `android-x86_64`, e que `android-x86` é o de 32 bits. Trocar esses dois produz uma build bem-sucedida e um APK que não instala em nada que você tenha.

## A página do ADB0020 recomenda uma propriedade que não funciona mais

Seguir a página oficial do ADB0020 leva você a um segundo erro. Ela sugere:

```xml
<AndroidSupportedAbis>armeabi-v7a;x86;x86_64;arm64-v8a</AndroidSupportedAbis>
```

Esse conselho é anterior ao .NET 6. Adicione isso a um projeto moderno e a build avisa:

```text
warning XA0036: The 'AndroidSupportedAbis' MSBuild property is no longer supported. Edit the project
file in a text editor, remove any uses of 'AndroidSupportedAbis', and use the 'RuntimeIdentifiers'
MSBuild property instead.
```

Como o XA0036 é um aviso e não um erro, a build passa, a propriedade é ignorada e o APK continua com duas ABIs. Se você herdou um projeto migrado do Xamarin.Forms, procure por um `AndroidSupportedAbis` esquecido em algum `Directory.Build.props` ou em um argumento do servidor de build antes de concluir que `RuntimeIdentifiers` não está fazendo efeito.

## O .NET 11 muda a resposta de novo

Não cole o trecho de quatro RIDs em um projeto `net11.0-android`. [O MAUI passou a usar CoreCLR no Android, iOS e Mac Catalyst no .NET 11 Preview 4](/pt-br/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/), e o CoreCLR não trouxe consigo todas as arquiteturas que o Mono suportava. O Android x86 acabou, e pedir por ele quebra a build em vez de ser descartado em silêncio:

```text
error NETSDK1082: There was no runtime pack for Microsoft.Android.Runtime available for the specified
RuntimeIdentifier 'android-x86'.
```

O ARM de 32 bits demorou mais. Constava como em análise quando o CoreCLR virou padrão, e o suporte chegou na Preview 7. Como [a Preview 6 removeu por completo o caminho do Mono no mobile](/pt-br/2026/07/maui-coreclr-only-runtime-in-dotnet-11-preview-6/), não há mais a saída de emergência do `$(UseMonoRuntime)`. Para um projeto .NET 11 o conjunto que funciona é:

```xml
<PropertyGroup Condition="'$(TargetFramework)' == 'net11.0-android'">
  <RuntimeIdentifiers>android-arm;android-arm64;android-x64</RuntimeIdentifiers>
</PropertyGroup>
```

Se você está em um SDK da Preview 6 ou anterior, remova também o `android-arm` e aceite somente 64 bits até conseguir atualizar. O .NET 11 chega ao GA em novembro de 2026.

A consequência prática para emuladores: uma imagem de sistema x86 de 32 bits nunca vai rodar um app MAUI do .NET 11. Se o seu CI ainda sobe uma, mude para `x86_64`, ou para `arm64-v8a` em runners com Apple Silicon.

## Mantenha o ciclo de desenvolvimento rápido

Compilar quatro ABIs para depurar em um único dispositivo é tempo desperdiçado. `$(RuntimeIdentifier)`, no singular, prevalece sobre a forma no plural e compila exatamente uma:

```bash
dotnet build -f net11.0-android -t:Run -p:RuntimeIdentifier=android-arm64
```

Amarre isso à configuração Debug e deixe o conjunto completo para Release:

```xml
<PropertyGroup Condition="'$(Configuration)' == 'Debug' and $(TargetFramework.Contains('-android'))">
  <RuntimeIdentifier>android-arm64</RuntimeIdentifier>
</PropertyGroup>
```

Um alerta sobre passar a propriedade no plural pela linha de comando: o MSBuild quebra os valores de `-p:` em ponto e vírgula, então `-p:RuntimeIdentifiers=android-arm64;android-x64` te dá um erro de parsing do shell ou do MSBuild em vez de dois RIDs. Escape o separador como `%3B`:

```bash
dotnet publish -f net11.0-android -c Release -p:RuntimeIdentifiers=android-arm64%3Bandroid-x64
```

## O que o Google Play realmente exige

A Play exige um binário de 64 bits ao lado de qualquer binário de 32 bits desde agosto de 2019. Ela nunca exigiu o de 32 bits. Portanto o padrão do .NET 9 está em conformidade, e recolocar `android-arm` é uma decisão de alcance, não uma correção de conformidade.

Confira o número real antes de gastar tamanho de APK com isso. No Play Console, o catálogo de dispositivos da versão mostra quantos dispositivos compatíveis um bundle alcança, e a diferença entre uma build de duas e uma de três ABIs é a população de aparelhos que só suportam `armeabi-v7a` e ainda estão em uso nos seus mercados. Para muitos apps, em 2026 esse número é pequeno o bastante para ignorar; para apps distribuídos em regiões com ciclos longos de troca de aparelho, não é.

Se você publica um app bundle, a Play o divide por ABI de qualquer forma, então cada usuário baixa uma única arquitetura. A ABI extra custa tempo de build e tamanho de upload, não tamanho de instalação.

## Relacionados

- Bibliotecas nativas são também o motivo pelo qual [o Google Play rejeita um app Flutter ou .NET MAUI por falta de suporte a páginas de memória de 16 KB](/pt-br/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/), uma verificação que roda sobre as mesmas entradas `lib/<abi>/` que você listou acima.
- A troca de runtime por trás das mudanças de arquitetura do .NET 11 é tratada em [MAUI passa a usar CoreCLR por padrão no Android, iOS e Mac Catalyst](/pt-br/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/).
- Um `AndroidSupportedAbis` esquecido normalmente vem junto com o resto das propriedades de build legadas tratadas em [migrar do Xamarin.Forms para o MAUI 11](/pt-br/2026/05/migrate-from-xamarin-forms-to-maui-11/).
- Se a build falha antes mesmo de produzir um pacote instalável, comece por [Gradle build failed to produce an APK file in MAUI Android](/pt-br/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/).

## Fontes

- [Erro ADB0020 do .NET for Android](https://learn.microsoft.com/pt-br/dotnet/android/messages/adb0020), para o mapeamento de `INSTALL_FAILED_NO_MATCHING_ABIS` ao erro de build.
- [Aviso XA0036 do .NET for Android](https://learn.microsoft.com/pt-br/dotnet/android/messages/xa0036), para o texto de descontinuação de `AndroidSupportedAbis`.
- [Migração de projetos Xamarin.Android](https://learn.microsoft.com/pt-br/dotnet/maui/migration/android-projects), que documenta a substituição de ABI por `RuntimeIdentifiers`.
- [Catálogo de RIDs do .NET](https://learn.microsoft.com/pt-br/dotnet/core/rid-catalog) para os nomes dos runtime identifiers do Android.
- [CoreCLR progress and the Mono timeline for .NET MAUI](https://devblogs.microsoft.com/dotnet/coreclr-progress-and-mono-timeline-dotnet-maui/), para a remoção do caminho do Mono na Preview 6 e o status do arm32.
- [dotnet/maui#27697](https://github.com/dotnet/maui/issues/27697), o relato que trouxe à tona a mudança de padrão do .NET 9 como uma regressão de compatibilidade na Play Store.
- [Oferecer suporte a arquiteturas de 64 bits](https://developer.android.com/google-play/64-bit) na documentação para desenvolvedores do Google Play.
