---
title: "Como mudar para C# 13"
description: "Como corrigir 'Feature is not available in C# 12.0' e mudar seu projeto para C# 13 alterando o target framework ou definindo LangVersion no seu arquivo .csproj."
pubDate: 2025-01-01
updatedDate: 2025-01-02
tags:
  - "csharp-13"
  - "csharp"
  - "dotnet"
  - "dotnet-9"
lang: "pt-br"
translationOf: "2025/01/how-to-switch-to-c-13"
translatedBy: "claude"
translationDate: 2026-05-01
---
Ao experimentar os recursos do C# 13, é possível que você encontre erros semelhantes a estes:

> Feature is not available in C# 12.0. Please use language version 13.0 or later.

ou

> Error CS8652: The feature ‘<feature name>’ is currently in Preview and _unsupported_. To use Preview features, use the ‘preview’ language version.

Há duas formas de resolver esse erro:

-   altere o target framework do seu projeto para .NET 9 ou superior. A versão da linguagem deve ser atualizada automaticamente.
-   edite seu arquivo **.csproj** e especifique o **<LangVersion>** desejado como no exemplo abaixo:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net9.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <LangVersion>preview</LangVersion>
  </PropertyGroup>
</Project>
```

## A versão da linguagem está acinzentada e não pode ser modificada

[![](/wp-content/uploads/2023/03/image.png)](/wp-content/uploads/2023/03/image.png)

A versão da linguagem não pode ser alterada pela janela **Properties** do projeto. A versão está vinculada à versão do target .NET framework do seu projeto e será atualizada de acordo.

Se você precisar sobrescrever a versão da linguagem, deve fazê-lo como especificado acima, modificando o arquivo **.csproj** e especificando o **LangVersion**.

Lembre-se de que cada versão da linguagem C# tem uma versão mínima suportada de .NET. C# 13 é suportado apenas em .NET 9 e versões mais recentes. C# 12 é suportado apenas em .NET 8 e versões mais recentes.

## Opções de LangVersion do C#

Além dos números de versão, existem certas palavras-chave que podem ser usadas para especificar a versão da linguagem do seu projeto:

-   **preview** – refere-se à versão prévia mais recente
-   **latest** – a versão lançada mais recente (incluindo versão menor)
-   **latestMajor** ou **default** – a versão maior lançada mais recente

## Não é o que você está procurando?

Talvez você esteja procurando mudar para uma versão diferente do C#, nesse caso:

-   [Como mudar para C# 12](/2023/06/how-to-switch-to-c-12/)
-   [Como mudar para C# 11](/2023/03/how-to-switch-to-c-11/)
