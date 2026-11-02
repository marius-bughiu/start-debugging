---
title: "O tracker do .NET 11"
description: "Acompanhe .NET 11 RC3, política de suporte, mudanças de runtime e validação da migração com guias de testes de integração, EF Core e logs de requisição."
tagline: "Um favorito para o ciclo inteiro do .NET 11."
pubDate: 2026-04-18
updatedDate: 2026-11-02
indexTags:
  - ".net 11"
  - "dotnet 11"
  - ".net 11 preview"
  - "dotnet-11"
lang: "pt-br"
translationOf: "dotnet-11-tracker"
---

Em 2 de novembro de 2026, **.NET 11 RC3** é a candidata atual. A Microsoft a publicou em 25 de outubro como [atualização de segurança fora do ciclo](https://devblogs.microsoft.com/dotnet/dotnet-october-2026-oob-security-updates/). A [política de suporte](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core) informa o status go-live e o período de suporte. .NET 11 é uma versão STS (Standard Term Support). Ao migrar do .NET 8 LTS, considere essa diferença no planejamento da próxima atualização.

**Correção, 2 de novembro de 2026.** A versão anterior em inglês apresentava RC2 como a mais recente e descrevia a migração de .NET 8 para 11 como LTS para LTS. O índice agora seleciona tags específicas de .NET 11 para evitar artigos de outras versões incluídos apenas por uma tag geral de .NET.

## Release e runtime

Sobre RC2, veja [leitura incremental de CBOR](/pt-br/2026/10/dotnet-11-rc-2-cborreader-reads-cbor-incrementally/). RC1 inclui [imagens de contêiner reproduzíveis](/pt-br/2026/09/dotnet-11-rc-1-reproducible-container-images-source-date-epoch/), [sinais de processo](/pt-br/2026/09/dotnet-11-rc-1-process-signal-exit-status/) e [renovação de autenticação do SignalR](/pt-br/2026/09/signalr-authentication-refresh-finalized-dotnet-11-rc-1/). No runtime, veja [desvirtualização de métodos genéricos](/pt-br/2026/09/dotnet-11-jit-devirtualizes-generic-virtual-methods/), [convenções de chamada de structs](/pt-br/2026/10/what-is-transparent-struct-layout-and-why-does-a-single-field-wrapper-struct-change-the-calling-convention-in-dotnet/) e [compatibilidade de CPU](/pt-br/2026/06/dotnet-11-minimum-cpu-baseline-x86-64-v2/).

## Planejar e validar a atualização

Comece com a [lista de migração do .NET 8](/pt-br/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) ou o [guia para .NET Framework 4.8](/pt-br/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/). Em soluções com vários projetos, revise [seleção do SDK](/pt-br/2026/10/dotnetup-public-preview-installs-the-sdk-your-global-json-pins/) e [gerenciamento central de pacotes](/pt-br/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/). Ao mudar de runner, consulte [Microsoft.Testing.Platform](/pt-br/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/), [código de saída 5](/pt-br/2026/10/fix-dotnet-test-exit-code-5-zero-tests-ran-microsoft-testing-platform/) e [fallback para VSTest](/pt-br/2026/10/fix-dotnet-test-falls-back-to-vstest-in-linux-ci-microsoft-testing-platform/).

Use [WebApplicationFactory e Testcontainers](/pt-br/2026/08/webapplicationfactory-vs-testcontainers-for-aspnetcore-integration-tests/) para escolher quais comportamentos HTTP e de banco testar. Para alterações de dados, a [conversão de enum em string](/pt-br/2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter/) explica por que valores numéricos em texto e nomes podem produzir consultas diferentes. Para rastrear requisições autenticadas, veja [ID do usuário nos logs](/pt-br/2026/09/how-to-add-the-current-user-id-to-every-log-entry-in-aspnet-core/).

## Índice de tópicos

O índice cronológico seleciona tags de versão do .NET 11. Para referências específicas, veja [EF Core 11](/pt-br/pillars/efcore-11-cheat-sheet/) e [C# 14](/pt-br/pillars/csharp-14-features/).
