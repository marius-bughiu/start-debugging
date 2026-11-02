---
title: "CV Shortlist: notas históricas sobre um SaaS de IA em .NET 10"
description: "O anúncio do autor de CV Shortlist, o conteúdo do antigo README e as ideias de design .NET ainda úteis após a indisponibilidade do repositório público."
pubDate: 2026-01-18
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-10"
lang: "pt-br"
translationOf: "2026/01/cv-shortlist-an-ai-powered-net-10-saas-went-open-source-and-the-stack-is-worth-studying"
translatedBy: "claude"
translationDate: 2026-04-29
---

**Estado verificado em 2 de novembro de 2026:** o antigo repositório público `github.com/mihnea-radulescu/cvshortlist` retorna 404, inclusive pela API do GitHub. Isso não prova se foi apagado, tornado privado ou movido. Não foi verificado um substituto público. Esta é uma nota histórica, não um roteiro de código atualmente executável.

## O que o autor anunciou

No [anúncio original](https://www.reddit.com/r/csharp/comments/1qgbjo4/saas_educational_free_and_opensource_example_cv/), Mihnea Radulescu descreveu um SaaS comercial iniciado em novembro de 2025, depois encerrado e oferecido como projeto educacional sob a licença MIT. Citou .NET 10, ASP.NET Core, Blazor Server, Azure Cloud e Azure AI Foundry. O objetivo era selecionar candidaturas. São descrições do autor, não provas independentes de precisão ou prontidão para produção.

Uma cópia em cache do antigo README descreve extração de PDF com Document Intelligence e comparação com descrições de vagas por um modelo da família GPT-5. Lista EF Core 10, armazenamento e bancos de dados Azure, além de uma opção auto-hospedada que ainda exigia recursos de IA Azure; as instruções citavam `gpt-5-mini`. Isso não verifica o código atual, disponibilidade do modelo, requisitos atuais ou resultados de testes. O repositório indisponível não foi compilado nem auditado nesta revisão.

## Questões de design que continuam úteis

Separar extração de documentos e processamento pelo modelo é um design a avaliar. A [documentação de layout do Document Intelligence](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/prebuilt/layout?view=doc-intel-4.0.0) descreve extração de texto, tabelas e estrutura. Teste os resultados nos seus documentos antes de enviá-los a um modelo. Extração seguida de uma chamada a LLM não estabelece, por si só, uma arquitetura RAG.

Mantenha a configuração fora do código e valide as opções realmente necessárias. A orientação histórica sobre user secrets e variáveis de ambiente não é um projeto completo de segurança de produção. A [documentação do Secret Manager](https://learn.microsoft.com/en-us/aspnet/core/security/app-secrets?view=aspnetcore-10.0) explica que user secrets são para desenvolvimento e não são criptografados. Variáveis de ambiente também exigem controle de acesso. O bloco ilustrativo de `Program.cs` foi removido: não era código inspecionado do repositório, e as propriedades C# `required` não forneciam validação de valores obrigatórios em execução por `ValidateDataAnnotations()`.

Para um caminho de aprendizado disponível, veja [Generative AI for Beginners .NET v2](/pt-br/2026/03/generative-ai-beginners-dotnet-v2-dotnet10-meai/) e seus materiais sobre documentos e integração de modelos, em vez de tratar um projeto indisponível como modelo de implantação.

**Correção em 2 de novembro de 2026:** separados o anúncio e o README histórico do código atual verificado; removidas recomendações sem respaldo e o exemplo de configuração não verificado.
