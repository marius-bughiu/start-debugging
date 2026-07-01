---
title: "SkiaSharp 4.0 chega estavel: renderizacao de GPU 24% mais rapida e uma API enxuta"
description: "SkiaSharp 4.148.0 e a primeira versao estavel da v4. Interfaces pesadas em GPU renderizam ate 24% mais rapido, shaders em CPU rodam ~6x mais rapido e a superficie de API legada finalmente e aposentada. Veja quanto atualizar realmente custa."
pubDate: 2026-07-01
tags:
  - "skiasharp"
  - "dotnet"
  - "graphics"
  - "maui"
  - "performance"
lang: "pt-br"
translationOf: "2026/07/skiasharp-4-0-stable-release-faster-gpu-rendering"
translatedBy: "claude"
translationDate: 2026-07-01
---

Matthew Leibowitz [anunciou a primeira versao estavel do SkiaSharp 4.0 em 29 de junho de 2026](https://devblogs.microsoft.com/dotnet/skiasharp-4-0-stable/), publicada como o pacote NuGet `SkiaSharp 4.148.0`. Esta e a versao que consolida cada versao previa da v4 em um unico pacote que voce pode colocar em producao, e se voce adiou as versoes previas (que cobrimos aqui em [SkiaSharp 4.0 Preview 1](/pt-br/2026/04/skiasharp-4-0-preview-1-uno-platform-comaintainer/)) esperando a API se estabilizar, a API agora se estabilizou.

## O ganho de desempenho e real

O destaque nao e um recurso, e um numero. No backend acelerado por GPU, o trabalho que domina as interfaces modernas (cartoes elevados, sombras, superficies em camadas) renderiza ate 24% mais rapido que a versao estavel anterior. Os proprios numeros da Microsoft, medidos no Windows 11 com .NET 10 sobre OpenGL: um painel de cartoes com sombra subiu de 65 para 80 FPS, e um feed de atividade com rolagem passou de 47 para 58 FPS.

O trabalho limitado por CPU melhorou ainda mais. Os shaders procedurais de ruido Perlin, do tipo que voce usaria para efeitos de textura ou neblina, rodam cerca de 6 vezes mais rapido. Para apps de MAUI, Avalonia e Uno que dependem do SkiaSharp para desenho personalizado, e uma melhoria gratuita no seu orcamento de quadros sem alteracao de codigo no caminho quente.

## O que 4.148.0 realmente entrega

Tres adicoes concretas chegam a API estavel:

- Controle total de eixos de fontes variaveis OpenType no SkiaSharp e no HarfBuzzSharp, para voce definir `wght`, `wdth` ou qualquer eixo personalizado a partir de codigo gerenciado em vez de descer para handles nativos do HarfBuzz.
- Paletas de cor para fontes de emoji e icones.
- Codificacao de WebP animado.

O caminho das fontes variaveis e o que a maioria dos apps vai usar primeiro:

```csharp
using var blob = SKData.Create("Inter.ttf");
using var typeface = SKTypeface.FromData(blob);

var variation = new SKFontVariation
{
    { "wght", 650 },
    { "wdth", 110 },
};

using var variant = typeface.CreateVariant(variation);
using var font = new SKFont(variant, size: 24);
canvas.DrawText("One font file, every weight", 0, 0, font, paint);
```

## A parte que o anuncio suaviza

"Uma API mais limpa e correta" e o jeito diplomatico de dizer. A traducao pratica: a v4 conclui uma longa migracao e a superficie de API legada e aposentada. Se seu codigo ainda chama membros obsoletos da 3.x, ou se voce construiu uma biblioteca de controles personalizados contra o modelo mutavel do `SKPath`, a compilacao e onde voce descobre. O padrao imutavel `SKPath` mais `SKPathBuilder` introduzido nas versoes previas agora e o padrao, entao qualquer laco de desenho que mutava um caminho em cache precisa migrar para um builder.

Para a maioria dos consumidores a atualizacao e uma mudanca de uma linha:

```xml
<PackageReference Include="SkiaSharp" Version="4.148.0" />
```

Faca isso em uma branch, compile e leia os avisos antes de ler as notas de versao. Uma compilacao verde significa que voce ja estava limpo. Uma vermelha e uma lista curta e mecanica de chamadas aposentadas, nao uma reescrita. De todo modo, os FPS valem a tarde.

Os detalhes completos estao na [versao SkiaSharp 4.148.0 no GitHub](https://github.com/mono/SkiaSharp/releases).
