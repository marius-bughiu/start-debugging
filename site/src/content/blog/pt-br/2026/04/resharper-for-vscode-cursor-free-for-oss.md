---
title: "ReSharper chega ao VS Code e Cursor, grátis para uso não comercial"
description: "A JetBrains lançou o ReSharper como uma extensão do VS Code com análise de C#, refatoração e testes unitários completos. Funciona também no Cursor e no Google Antigravity, e não custa nada para OSS e aprendizado."
pubDate: 2026-04-12
tags:
  - "resharper"
  - "vs-code"
  - "csharp"
  - "tooling"
lang: "pt-br"
translationOf: "2026/04/resharper-for-vscode-cursor-free-for-oss"
translatedBy: "claude"
translationDate: 2026-04-25
---

Por anos, ReSharper significou uma coisa: uma extensão do Visual Studio. Se você queria análise de C# de qualidade JetBrains fora do Visual Studio, o Rider era a resposta. Isso mudou em 5 de março de 2026, quando a JetBrains [lançou o ReSharper para Visual Studio Code](https://blog.jetbrains.com/dotnet/2026/03/05/resharper-for-visual-studio-code-cursor-and-compatible-editors-is-out/), Cursor e Google Antigravity. A [versão 2026.1](https://blog.jetbrains.com/dotnet/2026/03/30/resharper-2026-1-released/) de 30 de março veio em seguida com monitoramento de desempenho e integração mais apertada.

## O que você ganha

A extensão traz a experiência central do ReSharper para qualquer editor que fale a API de extensões do VS Code:

- **Análise de código** para C#, XAML, Razor, e Blazor com o mesmo banco de dados de inspeções que o ReSharper usa no Visual Studio
- **Refatoração ao nível de solução**: renomear, extrair método, mover tipo, inline variável, e o resto do catálogo
- **Navegação** incluindo ir para definição em código-fonte descompilado
- **Um Solution Explorer** que lida com projetos, pacotes NuGet, e geradores de código-fonte
- **Testes unitários** para NUnit, xUnit.net, e MSTest com controles inline de execução/depuração

Depois de instalar a extensão e abrir uma pasta, o ReSharper detecta arquivos `.sln`, `.slnx`, `.slnf`, ou `.csproj` independentes automaticamente. Sem configuração manual necessária.

## O ângulo de licenciamento

A JetBrains tornou isso grátis para uso não comercial. Isso cobre contribuições de código aberto, aprendizado, criação de conteúdo, e projetos por hobby. Equipes comerciais precisam de uma licença ReSharper ou dotUltimate, a mesma que cobre a extensão do Visual Studio.

## Um teste rápido

Instale da VS Code Marketplace, depois abra qualquer solução C#:

```bash
code my-project/
```

O ReSharper indexa a solução e começa a mostrar inspeções imediatamente. Experimente o Command Palette (`Ctrl+Shift+P`) e digite "ReSharper" para ver as ações disponíveis, ou clique com o botão direito em qualquer símbolo para o menu de refatoração.

Uma maneira rápida de verificar se está funcionando:

```csharp
// ReSharper will flag this with "Use collection expression" in C# 12+
var items = new List<string> { "a", "b", "c" };
```

Se você ver a sugestão de converter para `["a", "b", "c"]`, o motor de análise está rodando.

## Para quem isso é

Usuários de Cursor escrevendo C# agora ganham análise de primeira classe sem deixar seu editor AI-nativo. Usuários do VS Code que evitaram o Rider por custo ou preferência ganham a mesma profundidade de inspeção que o ReSharper ofereceu aos usuários do Visual Studio por duas décadas. E mantenedores de OSS ganham tudo grátis.

O [post de anúncio completo](https://blog.jetbrains.com/dotnet/2026/03/05/resharper-for-visual-studio-code-cursor-and-compatible-editors-is-out/) cobre detalhes de instalação e limitações conhecidas.
