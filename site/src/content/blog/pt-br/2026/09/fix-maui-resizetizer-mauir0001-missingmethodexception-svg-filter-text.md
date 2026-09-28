---
title: "Corrigindo: MAUIR0001 MissingMethodException no Resizetizer do .NET MAUI em um SVG com <filter> ou <text>"
description: "MAUI 10.0.101 e 10.0.110 o Resizetizer traz referências de System.Memory incompatíveis, então SVGs com filtros ou texto falham. Fixe o Resizetizer em 10.0.100 ou remova o filtro e o texto."
pubDate: 2026-09-28
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "maui"
  - "msbuild"
  - "csharp"
lang: "pt-br"
translationOf: "2026/09/fix-maui-resizetizer-mauir0001-missingmethodexception-svg-filter-text"
translatedBy: "claude"
translationDate: 2026-09-28
---

Se sua build do .NET MAUI 10 começou a falhar com `error MAUIR0001: There was an exception processing the image` e um `System.MissingMethodException` para `SKImageFilter.CreateMatrixConvolution`, `SKTextBlobBuilder.AddPositionedRun` ou `SKTypeface.Clone`, a causa é o próprio pacote Resizetizer, não o seu SVG. `Microsoft.Maui.Resizetizer` 10.0.101 e 10.0.110 empacotam uma build do SkiaSharp 4.150.1 que pede `System.Memory` 4.0.5.0 ao lado de um `Svg.Skia` que pede 4.0.2.0, e o MSBuild carrega dois tipos `ReadOnlySpan<T>` diferentes. Qualquer SVG que use um elemento `<filter>` ou `<text>` trava. A correção mais rápida é fixar `Microsoft.Maui.Resizetizer` em 10.0.100 mantendo o resto do MAUI em 10.0.110; a correção duradoura é remover os filtros e converter o texto em paths nos seus SVGs de `MauiIcon`, `MauiSplashScreen` e `MauiImage`.

## O erro em contexto

Duas variantes do erro foram reportadas no upstream. A variante de filtro, de [dotnet/maui#38319](https://github.com/dotnet/maui/issues/38319):

```text
error MAUIR0001: There was an exception processing the image '...\Resources\AppIcon\appicon.svg'.
System.MissingMethodException: Method not found:
'SkiaSharp.SKImageFilter SkiaSharp.SKImageFilter.CreateMatrixConvolution(
    SkiaSharp.SKSizeI, System.ReadOnlySpan`1<Single>, Single, Single,
    SkiaSharp.SKPointI, SkiaSharp.SKShaderTileMode, Boolean, SkiaSharp.SKImageFilter)'.
   at Svg.Skia.SkiaModel.ToSKImageFilter(SKImageFilter imageFilter)
   at Svg.Skia.SkiaModel.GetRenderImageFilter(SKImageFilter imageFilter)
   at Svg.Skia.SkiaModel.CreateRenderPaint(SKPaint paint)
   at Svg.Skia.SKSvg.Load(String path)
   at Microsoft.Maui.Resizetizer.SkiaSharpSvgTools..ctor(...)
```

A variante de texto na 10.0.101, de [dotnet/maui#38507](https://github.com/dotnet/maui/issues/38507):

```text
error MAUIR0001: There was an exception processing the image '.../Resources/Images/place_capsule.svg'.
System.MissingMethodException: Method not found: 'Void SkiaSharp.SKTextBlobBuilder.AddPositionedRun
(System.ReadOnlySpan`1<UInt16>, SkiaSharp.SKFont, System.ReadOnlySpan`1<SkiaSharp.SKPoint>)'.
```

Na 10.0.110 a variante de texto migrou para um método diferente, porque a 10.0.110 atualizou o `Svg.Skia` de 5.1.1 para 5.2.3 e a nova versão resolve fontes de forma diferente. Isto é o que obtenho na 10.0.110 com um elemento `<text>` simples:

```text
error MAUIR0001: There was an exception processing the image '.../text.svg'.
System.MissingMethodException: Method not found:
'SkiaSharp.SKTypeface SkiaSharp.SKTypeface.Clone(System.ReadOnlySpan`1<SkiaSharp.SKFontVariationPositionCoordinate>)'.
   at Svg.Skia.SkiaModel.ApplyVariableFontWeight(SKTypeface typeface, SKFontStyle style)
   at Svg.Skia.SkiaModel.ResolveSKTypeface(SKTypeface typeface)
   at Svg.Skia.SkiaModel.ToSKFont(SKPaint paint)
```

Um comentário na #38507 também reporta uma variante `HarfBuzzSharp.Font.SetVariations(ReadOnlySpan<Variation>)` da mesma exceção vinda da etapa `GenerateSplashStoryboard` do iOS. Seja qual for o nome do método, olhe a assinatura: todos eles recebem um `ReadOnlySpan<T>`. Esse é o bug inteiro.

## Por que o Resizetizer não consegue encontrar um método que existe

A primeira coisa que todo mundo faz é abrir `SkiaSharp.dll` em um decompilador e encontrar o método bem ali. Quem reportou a #38507 fez exatamente isso e confirmou por reflection que `AddPositionedRun(ReadOnlySpan<ushort>, SKFont, ReadOnlySpan<SKPoint>)` está presente. Fiz o mesmo com `System.Reflection.Metadata` contra a pasta `buildTransitive` de cada versão do pacote, e confere: os métodos existem na 10.0.100, 10.0.101 e 10.0.110.

A diferença está nas referências de assembly. Aqui está o que cada assembly empacotado pede:

| Resizetizer | SkiaSharp.dll (TFM) | SkiaSharp pede System.Memory | Svg.Skia pede System.Memory | System.Memory.dll enviado |
|---|---|---|---|---|
| 10.0.100 | 3.116.1 (net462) | 4.0.1.2 | 4.0.1.2 | 4.0.1.2 |
| 10.0.101 | 4.150.1 (net462) | 4.0.5.0 | 4.0.2.0 | 4.0.2.0 |
| 10.0.110 | 4.150.1 (net462) | 4.0.5.0 | 4.0.2.0 | 4.0.2.0 |
| 11.0.0-rc.1 | 3.116.1 (net462) | 4.0.1.2 | 4.0.1.2 | 4.0.1.2 |

A atualização do SkiaSharp veio via [dotnet/maui#37731](https://github.com/dotnet/maui/pull/37731) ("Update SkiaSharp to 4.150.1"), que foi retroportada para o branch de servicing 10.0.1xx e lançada na 10.0.101.

Agora veja como o `dotnet build` carrega as dependências de uma task. O MSBuild no .NET coloca cada assembly de task no seu próprio `MSBuildLoadContext`. Quando uma dependência é solicitada, ele investiga a pasta da task, e em [`MSBuildLoadContext.Load`](https://github.com/dotnet/msbuild/blob/main/src/Framework/Loader/MSBuildLoadContext.cs) ele pula o arquivo local se a versão local for menor que a solicitada:

```csharp
// dotnet/msbuild main, src/Framework/Loader/MSBuildLoadContext.cs (abridged)
AssemblyName candidateAssemblyName = AssemblyLoadContext.GetAssemblyName(candidatePath);
if (candidateAssemblyName.Version < assemblyName.Version)
{
    continue;
}
return LoadFromAssemblyPath(candidatePath);
```

Então na 10.0.101 e 10.0.110:

1. O `Svg.Skia` pede `System.Memory` 4.0.2.0. A pasta da task tem a 4.0.2.0, então o MSBuild carrega esse arquivo no contexto do plugin. Esse `System.Memory.dll` é a build out-of-band do pacote netstandard2.0, que **define seu próprio** tipo `System.ReadOnlySpan<T>`.
2. O `SkiaSharp` pede `System.Memory` 4.0.5.0. A 4.0.2.0 local é antiga demais, então a investigação recai no contexto padrão, que resolve o facade `System.Memory` do shared framework. Esse facade encaminha (type-forward) `ReadOnlySpan<T>` para o `System.Private.CoreLib`.
3. O `Svg.Skia` compila uma chamada para `SKImageFilter.CreateMatrixConvolution(..., ReadOnlySpan<float> [do System.Memory.dll], ...)`. O `SkiaSharp` expõe `CreateMatrixConvolution(..., ReadOnlySpan<float> [do CoreLib], ...)`. Mesmo nome, mesmo texto, identidade de tipo diferente. O runtime não consegue fazer o bind e lança `MissingMethodException` quando faz o JIT do método chamador.

Isso também explica por que o trace da #38319 nomeia `CreateMatrixConvolution` mesmo o SVG de reprodução usando apenas `feGaussianBlur`: a exceção dispara quando `Svg.Skia.SkiaModel.ToSKImageFilter` é compilado pelo JIT, e esse método contém a chamada para toda primitiva de filtro. Qualquer SVG com qualquer `<filter>` chega até lá. SVGs sem filtros ou texto nunca tocam em uma API do SkiaSharp que receba span durante a rasterização, e é por isso que o ícone padrão do template ainda compila.

Para provar o mecanismo, copiei a pasta `buildTransitive` da 10.0.110, apaguei apenas o `System.Memory.dll`, e apontei a task para a cópia. Os dois SVGs que falhavam rasterizaram normalmente, porque agora toda solicitação de `System.Memory` cai no facade do framework e existe apenas um `ReadOnlySpan<T>`. Não use esse hack em produção, mas ele confirma o diagnóstico.

## Reprodução mínima

Você não precisa do workload MAUI para reproduzir isso, porque o Resizetizer é uma task comum do MSBuild. Extraia `microsoft.maui.resizetizer.10.0.110.nupkg` e rode a task diretamente:

```xml
<!-- .NET SDK 10.0.302, Microsoft.Maui.Resizetizer 10.0.110 (extracted nupkg), run.proj -->
<Project>
  <UsingTask AssemblyFile="$(RzDir)/Microsoft.Maui.Resizetizer.dll"
             TaskName="Microsoft.Maui.Resizetizer.ResizetizeImages" />
  <Target Name="Build">
    <ItemGroup><Img Include="$(Svg)" BaseSize="128,128" /></ItemGroup>
    <ResizetizeImages PlatformType="android"
                      IntermediateOutputPath="$(MSBuildThisFileDirectory)out/"
                      InputsFile="$(MSBuildThisFileDirectory)out/inputs.txt"
                      Images="@(Img)" />
  </Target>
</Project>
```

Com duas imagens de teste:

```xml
<!-- filter.svg: fails on Resizetizer 10.0.101 and 10.0.110 -->
<svg width="456" height="456" viewBox="0 0 456 456" xmlns="http://www.w3.org/2000/svg">
  <filter id="blur"><feGaussianBlur stdDeviation="8" /></filter>
  <rect width="456" height="456" fill="#512BD4" filter="url(#blur)" />
</svg>
```

```xml
<!-- text.svg: fails on Resizetizer 10.0.101 and 10.0.110 -->
<svg width="456" height="456" viewBox="0 0 456 456" xmlns="http://www.w3.org/2000/svg">
  <rect width="456" height="456" fill="#512BD4" />
  <text font-family="Arial" font-size="120" fill="#FFFFFF"><tspan x="60 150 240" y="280">SD!</tspan></text>
</svg>
```

Rodar `dotnet build run.proj -nodeReuse:false -p:RzDir=<buildTransitive folder> -p:Svg=<file>` contra cada versão do pacote me deu isto no macOS com o SDK 10.0.302:

| Resizetizer | SVG simples | `<filter>` | `<text>` |
|---|---|---|---|
| 10.0.100 | OK | OK | OK |
| 10.0.101 | OK | `CreateMatrixConvolution` | `AddPositionedRun` |
| 10.0.110 | OK | `CreateMatrixConvolution` | `SKTypeface.Clone` |
| 11.0.0-rc.1.26451.6 | OK | OK | OK |

Trocar `PlatformType` para `ios` falha da mesma forma na 10.0.110, então a 10.0.110 não corrigiu nenhuma das duas variantes em nenhuma das plataformas nos meus testes. Até hoje, as issues #38319 e #38507 seguem abertas, e a correção proposta, [dotnet/maui#38883](https://github.com/dotnet/maui/pull/38883), é um draft que troca o SkiaSharp empacotado pela sua build netstandard2.0. A execução de CI dela revelou incompatibilidades de bibliotecas nativas, então não conte com que ela chegue no próximo service release.

## Correção 1: fixar o Microsoft.Maui.Resizetizer em 10.0.100

O Resizetizer só atua em tempo de build. Ele gera PNGs e arquivos de recursos; nada dele vai para o seu app. Isso torna seguro segurá-lo uma versão atrás enquanto o resto do MAUI permanece na 10.0.110.

O SDK do MAUI adiciona `Microsoft.Maui.Resizetizer` como um `PackageReference` implícito em `$(MauiVersion)`, mas os targets removem o item implícito quando você declara um explícito com o mesmo nome. O `Microsoft.Maui.Controls` 10.0.110 também depende de `Microsoft.Maui.Resizetizer >= 10.0.110`, então um downgrade simples falha o restore:

```text
error NU1605: Warning As Error: Detected package downgrade: Microsoft.Maui.Resizetizer from 10.0.110 to 10.0.100.
  App -> Microsoft.Maui.Controls 10.0.110 -> Microsoft.Maui.Resizetizer (>= 10.0.110)
  App -> Microsoft.Maui.Resizetizer (>= 10.0.100)
```

Suprima o `NU1605` apenas nessa referência, para não esconder downgrades reais em outros lugares:

```xml
<!-- .NET 10, Microsoft.Maui.Controls 10.0.110, App.csproj -->
<ItemGroup>
  <PackageReference Include="Microsoft.Maui.Controls" Version="$(MauiVersion)" />

  <!-- Workaround for dotnet/maui#38319 and #38507. Remove when a fixed Resizetizer ships. -->
  <PackageReference Include="Microsoft.Maui.Resizetizer"
                    Version="10.0.100"
                    PrivateAssets="all"
                    NoWarn="NU1605" />
</ItemGroup>
```

Verifiquei que isso restaura de forma limpa e que o `project.assets.json` resolve `Microsoft.Maui.Resizetizer/10.0.100`. Se você usa Central Package Management, coloque a `Version` em um item `PackageVersion` e mantenha `NoWarn="NU1605"` no `PackageReference`.

A alternativa mais bruta, que os dois relatores das issues usaram, é fixar todo o MAUI de volta com `<MauiVersion>10.0.100</MauiVersion>`. Isso funciona, mas você abre mão de todas as correções da 10.0.110 para contornar uma build task. Só faça isso se já tiver um motivo para segurar o MAUI.

## Correção 2: remover filtros e texto dos SVGs que o Resizetizer processa

Esta é a correção que eu manteria mesmo depois que o upstream lançar uma correção, porque ela também faz seus ícones renderizarem igual em todo lugar. O Resizetizer rasteriza SVGs com o `Svg.Skia`, que não é um navegador. O texto depende das fontes presentes na máquina de build (seu runner de CI no macOS e seu notebook Windows vão escolher fallbacks diferentes), e os filtros SVG sempre foram a parte menos fiel de qualquer renderizador que não seja um navegador.

Converta texto em contornos. No Inkscape 1.x você pode fazer isso pela linha de comando, o que é útil para uma pasta cheia de assets:

```bash
# Inkscape 1.x, converts <text> to <path> and drops editor metadata
inkscape design/splash-source.svg --export-text-to-path --export-plain-svg --export-filename=Resources/Splash/splash.svg
```

No Figma, use "Outline stroke" / "Flatten" na camada de texto antes de exportar; no Illustrator, "Create Outlines". Mantenha o arquivo-fonte editável em algum lugar fora de `Resources/` para que o Resizetizer nunca o veja.

Para filtros, você tem duas opções:

- Substituir o efeito por geometria. Uma sombra em um ícone de app geralmente é uma segunda forma com opacidade menor, deslocada alguns pixels. Um brilho suave pode ser um gradiente radial. Nenhum dos dois precisa de `<filter>`.
- Rasterizar a camada de efeito você mesmo e usar um PNG. `MauiIcon` e `MauiSplashScreen` aceitam PNGs, e PNGs nunca passam pelo `Svg.Skia`. Exporte no maior tamanho que você precisar (1024x1024 para um ícone de app iOS). Segundo a [documentação de ícones de app](https://learn.microsoft.com/dotnet/maui/user-interface/images/app-icons), um bitmap usado como imagem principal só é redimensionado quando você define `BaseSize`, então a configuração mais simples mantém um SVG de fundo e move o efeito para um PNG de primeiro plano:

```xml
<!-- .NET 10, MAUI 10.0.110, App.csproj -->
<ItemGroup>
  <MauiIcon Include="Resources\AppIcon\appicon.svg"
            ForegroundFile="Resources\AppIcon\appiconfg.png"
            Color="#512BD4" />
</ItemGroup>
```

Para encontrar todo arquivo afetado antes que o CI o faça, procure pelos dois nomes de elemento:

```bash
# any shell with grep; lists SVGs the 10.0.101/10.0.110 Resizetizer will choke on
grep -rlE "<(filter|text)[ >]" --include="*.svg" Resources/
```

## Correção 3: migrar para o MAUI 11 se você já ia fazer isso de qualquer forma

O Resizetizer do .NET MAUI 11 RC 1 (`11.0.0-rc.1.26451.6`) ainda empacota o SkiaSharp 3.116.1 e um `Svg.Skia` 2.0.0.4 compatível, e os três SVGs de teste rasterizaram bem com ele. Isso não é motivo para pular para um release candidate por causa de um único erro de build, mas se a atualização já está programada, esse problema desaparece junto com ela. Tenha em mente que o branch de servicing 10.0.1xx recebeu o SkiaSharp 4.150.1 primeiro, então uma build futura do MAUI 11 pode herdar a mesma combinação se ela não for corrigida na origem.

## Pegadinhas e casos parecidos

- **Funciona localmente e falha no CI.** O Resizetizer é incremental. Se os PNGs foram gerados por uma build anterior na 10.0.100, o target é pulado e sua build local continua verde depois da atualização. Builds limpas no CI regeneram os PNGs e falham. Rode `dotnet clean` ou apague `obj/` localmente para ver o estado real.
- **`dotnet build-server shutdown` não ajuda.** Isto não é um node do MSBuild obsoleto segurando um SkiaSharp antigo. Quem reportou a #38319 confirmou que reproduz com `-nodeReuse:false`, e minha reprodução também usa essa flag.
- **Adicionar um `PackageReference` do SkiaSharp no seu app não ajuda.** A task carrega as cópias da pasta `buildTransitive` do pacote, não do grafo de dependências do seu app. É por isso também que a atualização não gerou nenhum aviso do NuGet.
- **Existem outras causas para o MAUIR0001.** `MAUIR0001` é o código genérico de "exception processing the image" do Resizetizer. Um `ArgumentNullException` ou `Unable to allocate pixels for the bitmap` sob o mesmo código é um problema diferente com suas próprias issues no upstream (por exemplo [dotnet/maui#12109](https://github.com/dotnet/maui/issues/12109)). Só o `MissingMethodException` com um parâmetro `ReadOnlySpan` é este bug.
- **Fontes em `MauiFont` não são afetadas.** O crash está apenas na rasterização de SVG. A renderização de texto em runtime, incluindo fontes customizadas, não toca nesse código.
- **Falhas de carregamento de assembly no seu próprio app parecem iguais mas não são.** Se você receber `MissingMethodException` ou `FileLoadException` em runtime em vez de durante a build, veja [como corrigir Could not load file or assembly em um app publicado](/pt-br/2026/05/fix-could-not-load-file-or-assembly-in-published-app/).

## Relacionados

- Se a build do Android também falhar logo depois da etapa do Resizetizer, [corrigindo "Gradle build failed to produce an .apk file" no MAUI Android](/pt-br/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/) cobre a próxima quebra de CI mais comum.
- Para runners de CI do iOS que também pararam de compilar depois de uma atualização do SDK, veja [Unable to find a valid iOS Simulator runtime durante uma build MAUI](/pt-br/2026/05/fix-unable-to-find-a-valid-ios-simulator-runtime-during-maui-build/).
- O pipeline de assets do Resizetizer e os itens `MauiIcon` / `MauiSplashScreen` são percorridos em [migrando do Xamarin.Forms para o .NET MAUI 11](/pt-br/2026/05/migrate-from-xamarin-forms-to-maui-11/).
- O empacotamento para a Store regenera todos os tamanhos de ícone, então [empacotando um app .NET MAUI para a Microsoft Store](/pt-br/2026/05/how-to-package-a-maui-app-for-the-microsoft-store/) é onde um ícone SVG com filtro vai morder no Windows.

## Fontes

- [dotnet/maui#38319: Resizetizer fails on any SVG app icon containing a `<filter>`](https://github.com/dotnet/maui/issues/38319)
- [dotnet/maui#38507: Resizetizer 10.0.101 fails on SVG `<text>` elements](https://github.com/dotnet/maui/issues/38507)
- [dotnet/maui#37731: Update SkiaSharp to 4.150.1](https://github.com/dotnet/maui/pull/37731)
- [dotnet/maui#38883: Fix Resizetizer loading incorrect SkiaSharp assembly (draft)](https://github.com/dotnet/maui/pull/38883)
- [dotnet/msbuild `MSBuildLoadContext.cs`](https://github.com/dotnet/msbuild/blob/main/src/Framework/Loader/MSBuildLoadContext.cs)
- [Microsoft.Maui.Resizetizer on NuGet](https://www.nuget.org/packages/Microsoft.Maui.Resizetizer)
- [Add images to a .NET MAUI app project (MS Learn)](https://learn.microsoft.com/dotnet/maui/user-interface/images/images)
</content>
