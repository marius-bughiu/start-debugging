---
title: "SkiaSharp 4.0 Preview 1: SKPath imutável, fontes variáveis e um novo co-mantenedor"
description: "SkiaSharp 4.0 Preview 1 chega com a Uno Platform como co-mantenedora ao lado do time do .NET. SKPath se torna imutável por trás de um novo SKPathBuilder, e o HarfBuzzSharp ganha controle completo de eixos de fontes variáveis OpenType."
pubDate: 2026-04-29
tags:
  - "skiasharp"
  - "dotnet"
  - "maui"
  - "graphics"
  - "uno-platform"
lang: "pt-br"
translationOf: "2026/04/skiasharp-4-0-preview-1-uno-platform-comaintainer"
translatedBy: "claude"
translationDate: 2026-04-29
---

David Ortinau [anunciou o SkiaSharp 4.0 Preview 1 em 28 de abril de 2026](https://devblogs.microsoft.com/dotnet/welcome-to-skia-sharp-40-preview1/), com duas notícias que importam mais do que o salto de versão em si: a Uno Platform agora é co-mantenedora oficial ao lado do time do .NET, e o motor Skia foi avançado anos de trabalho upstream em uma única versão.

## Um SkiaSharp co-mantido

Até esta versão, as atualizações do SkiaSharp seguiam a cadência da Microsoft, que tinha desacelerado visivelmente em 2024 e 2025 enquanto o foco do time se deslocava para outros lugares. Trazer a Uno Platform para um papel formal de co-mantenedora é significativo porque a Uno já mantém um fork interno de longa data (`unoplatform/Uno.SkiaSharp`) para WebAssembly, e esse fork tem sido a fonte da maioria dos engine bumps neste preview ([PRs #3560](https://github.com/mono/SkiaSharp/pull/3560) e [#3702](https://github.com/mono/SkiaSharp/pull/3702)). O efeito prático: os gráficos do .NET MAUI, os controles do Avalonia, os apps Uno e cada renderer de console que usa SkiaSharp agora rodam em um Skia atual em vez de um que estava atrás do Chromium por um ano ou mais.

Correções de build para Android API 36, tooling de gerador no lado Linux e uma galeria WebAssembly renovada vieram pelo mesmo conjunto de contribuições.

## SKPath se torna imutável

A maior mudança de API é que o `SKPath` agora é imutável por baixo dos panos. Os métodos mutadores familiares permanecem para compatibilidade retroativa, mas a forma moderna de construir um path é através do novo `SKPathBuilder`:

```csharp
using var builder = new SKPathBuilder();
builder.MoveTo(50, 0);
builder.LineTo(50, -50);
builder.LineTo(-30, -80);
builder.Close();

using SKPath path = builder.Detach();
canvas.DrawPath(path, paint);
```

`Detach()` te entrega o resultado imutável. Como o `SkPath` subjacente não muta mais após a construção, o runtime pode compartilhar, fazer hash e reutilizar geometria de path com segurança entre threads, o que importa para qualquer framework de UI que faz cache de primitivas de desenho entre frames. Código existente que chama `path.MoveTo(...)` diretamente continua compilando e rodando, então apps MAUI e Xamarin.Forms não precisam mudar nada para adotar o Preview 1.

## Fontes variáveis através do HarfBuzzSharp

A outra adição de destaque é o controle completo de eixos de fontes variáveis OpenType. O HarfBuzzSharp agora expõe os eixos que uma fonte declara (peso, largura, inclinação, tamanho ótico ou qualquer eixo customizado) e permite criar variantes de typeface sem precisar enviar dez arquivos de fonte estáticos:

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
canvas.DrawText("Hello, variable fonts", 0, 0, font, paint);
```

Antes disso, quem chamava precisava descer para handles nativos do HarfBuzz para definir coordenadas de eixos. O Preview 1 expõe os mesmos controles em APIs gerenciadas simples em SkiaSharp e HarfBuzzSharp.

## Pegando o preview

O pacote está publicado em `aka.ms/skiasharp-40-package`. O preview tem como alvo o mesmo conjunto de plataformas do 3.x (`net8.0`, `net9.0`, `net10.0`, mais os heads móveis habituais), e o time está pedindo feedback antes de fechar a superfície de API para a versão estável 4.0. Se você mantém uma biblioteca de controles Skia customizada, esta é a janela para testar a semântica de path imutável contra seu loop de desenho e reportar qualquer coisa que mute um path depois de cacheá-lo: esse é exatamente o padrão que vai de "funciona no 3.x" para "precisa de um `SKPathBuilder`" no 4.0.

Para um passeio mais profundo, a Uno Platform vai realizar um evento Focus on SkiaSharp em 30 de junho, com sessões dos engenheiros por trás desta versão.
