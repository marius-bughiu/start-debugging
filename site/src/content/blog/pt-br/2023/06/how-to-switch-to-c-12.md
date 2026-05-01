---
title: "Como mudar para o C# 12"
description: "Resolva os erros de versão da linguagem C# 12 atualizando seu target framework para o .NET 8 ou definindo LangVersion no seu arquivo .csproj."
pubDate: 2023-06-10
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "pt-br"
translationOf: "2023/06/how-to-switch-to-c-12"
translatedBy: "claude"
translationDate: 2026-05-01
---
Ao experimentar recursos do C# 12, é possível que você encontre erros parecidos com estes:

> Feature is not available in C# 11.0. Please use language version 12.0 or later.

ou

> Error CS8652: The feature '<feature name>' is currently in Preview and _unsupported_. To use Preview features, use the 'preview' language version.

Existem duas formas de resolver esse erro:

-   altere o target framework do seu projeto para .NET 8 ou superior. A versão da linguagem deve ser atualizada automaticamente.
-   edite o arquivo **.csproj** e especifique o **<LangVersion>** desejado, como no exemplo abaixo:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
	<LangVersion>preview</LangVersion>
  </PropertyGroup>
</Project>
```

## A versão da linguagem está esmaecida e não pode ser modificada

[![](/wp-content/uploads/2023/03/image.png)](/wp-content/uploads/2023/03/image.png)

A versão da linguagem não pode ser alterada pela janela de **Propriedades** do projeto. A versão está vinculada à versão do target .NET framework do seu projeto e será atualizada de acordo com ela.

Se você precisa sobrescrever a versão da linguagem, faça isso como descrito acima: modificando o arquivo **.csproj** e definindo **LangVersion**.

Lembre-se de que cada versão da linguagem C# tem uma versão mínima do .NET suportada. C# 12 só tem suporte no .NET 8 e versões mais novas. C# 11 só tem suporte no .NET 7 e versões mais novas. C# 10 só tem suporte no .NET 6 e versões mais novas. E assim por diante.

## Opções de LangVersion no C#

Além dos números de versão, existem certas palavras-chave que podem ser usadas para especificar a versão da linguagem do seu projeto:

-   **preview** -- refere-se à última versão prévia
-   **latest** -- a última versão lançada (incluindo a versão menor)
-   **latestMajor** ou **default** -- a última versão maior lançada
