---
title: "Histórico de versões da linguagem C#"
description: "A evolução do C# o transformou em uma linguagem moderna e de alto desempenho. Este guia acompanha cada marco importante. Os primeiros anos (C# 1.0 - 1.2). O C# foi lançado em 2002 como linguagem primária para o .NET Framework. Parecia com Java, mas com foco no desenvolvimento Windows. A versão 1.2 chegou logo depois com pequenas..."
pubDate: 2024-12-01
updatedDate: 2026-02-08
tags:
  - "csharp"
  - "dotnet"
lang: "pt-br"
translationOf: "2024/12/csharp-language-version-history"
translatedBy: "claude"
translationDate: 2026-05-01
---
A evolução do C# o transformou em uma linguagem moderna e de alto desempenho. Este guia acompanha cada marco importante.

## Os primeiros anos (C# 1.0 – 1.2)

O C# foi lançado em 2002 como linguagem primária para o .NET Framework. Parecia com Java, mas com foco no desenvolvimento Windows. A versão 1.2 chegou logo depois com pequenas melhorias, como o suporte a `IDisposable` em loops foreach.

A linguagem tinha os seguintes objetivos:

> -   Pretende ser uma linguagem de programação simples, moderna, de propósito geral e orientada a objetos.
> -   Deve incluir verificação forte de tipos, verificação de limites de array, detecção de tentativas de usar variáveis não inicializadas, portabilidade do código-fonte e coleta automática de lixo.
> -   Destina-se a ser usada no desenvolvimento de componentes de software que possam aproveitar ambientes distribuídos.
> -   Como a portabilidade do programador é muito importante, especialmente para aqueles já familiarizados com C e C++, o C# é o mais adequado.
> -   Fornecer suporte para internacionalização, já que isso era muito importante.
> -   Pretende ser adequado para escrever aplicações tanto para sistemas hospedados quanto embarcados.
> 
> [Fonte: Objetivos de design do C#](https://feeldotneteasy.blogspot.com/2011/01/c-design-goals.html)

## Grandes mudanças de produtividade (C# 2.0 – 5.0)

Essas versões introduziram os recursos que mais usamos hoje.

-   **C# 2.0:** Generics, métodos anônimos e tipos anuláveis mudaram a forma como lidamos com dados.
-   **C# 3.0:** LINQ, expressões lambda e métodos de extensão tornaram a consulta de dados muito mais fácil.
-   **C# 4.0:** Esta versão adicionou a palavra-chave `dynamic` e parâmetros opcionais.
-   **C# 5.0:** As palavras-chave `async` e `await` revolucionaram a programação assíncrona.

## A era do compilador moderno (C# 6.0 – 9.0)

Com o compilador Roslyn, as atualizações ficaram mais rápidas e frequentes.

-   **C# 6.0 e 7.0:** Essas versões focaram em "açúcar sintático" como membros com corpo de expressão e tuplas.
-   **C# 8.0:** Tipos de referência anuláveis ajudaram desenvolvedores a evitar exceções comuns de null pointer.
-   **C# 9.0:** Records e declarações de nível superior simplificaram a modelagem de dados e reduziram boilerplate.

## Avanços recentes (C# 10.0 – 13.0)

A linguagem agora evolui anualmente junto com o .NET.

-   **C# 10 e 11:** Diretivas using globais e literais de string brutos melhoraram a produtividade do desenvolvedor.
-   **C# 12 e 13:** Construtores primários para classes e melhorias em ref struct mantiveram a linguagem competitiva.

## O que há de novo no C# 14?

Lançado com o .NET 10, o C# 14 introduz várias melhorias de qualidade de vida.

### A palavra-chave field

Você não precisa mais declarar manualmente campos de apoio para propriedades. A palavra-chave `field` permite acessar o campo gerado pelo compilador diretamente dentro dos acessadores.

```csharp
public string Name { 
    get => field; 
    set => field = value ?? "Unknown"; 
}
```

### Membros de extensão

O C# 14 expande os métodos de extensão. Você pode agora definir propriedades de extensão, membros estáticos e até operadores dentro de um novo bloco `extension`.

### Outros recursos chave

-   **Atribuição condicional a null:** Use `?.=` para atribuir valores apenas se o alvo não for null.
-   **Conversões implícitas para Span:** Arrays e strings agora se convertem em spans de forma mais natural.
-   **Modificadores em lambdas:** Você pode usar `ref`, `in` e `out` em parâmetros de lambda sem tipos explícitos.
-   **Construtores parciais:** Geradores de código-fonte agora podem definir assinaturas para construtores em classes parciais.
