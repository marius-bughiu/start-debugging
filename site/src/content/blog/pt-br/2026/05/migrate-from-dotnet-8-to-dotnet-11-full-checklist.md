---
title: "Migrar do .NET 8 para o .NET 11: o checklist completo"
description: "Planeje a migração do .NET 8 com o status atual do .NET 11 RC3, SDK exato, compatibilidade, implantação e rollback."
pubDate: 2026-05-28
updatedDate: 2026-11-02
template: migration
tags:
  - "migration"
  - "dotnet-8"
  - "dotnet-11"
  - "csharp-14"
  - "ef-core-11"
lang: "pt-br"
translationOf: "2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist"
translatedBy: "claude"
translationDate: 2026-05-28
---

**Correção — 2 de novembro de 2026:** .NET 11 foi descrito incorretamente como uma versão LTS já lançada. Também foram corrigidos SDK, pacotes, hospedagem, serialização, consultas EF, locks e rollback. Afirmações anteriores sobre resultados de migração não tinham testes registrados.

O suporte do .NET 8 termina em **10 de novembro de 2026**. A [política atual](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core) lista .NET 10 como LTS e .NET 11 RC3 como pré-lançamento go-live. .NET 11 é uma linha STS. Para um destino LTS já lançado, avalie .NET 10; se precisa do .NET 11, aceite explicitamente seu estado atual e planeje a próxima atualização. Atualizar o SDK não atualiza aplicações já implantadas.

## 1. Registre a referência e escolha o SDK

Registre runtime implantado, SDK, sistema operacional, dependências, resultados dos testes e comportamento representativo. Uma referência verde ajuda a encontrar regressões, mas não prova que toda falha posterior foi causada pela migração.

```bash
dotnet --info
dotnet --list-sdks
dotnet --version
dotnet list package --include-transitive
dotnet test -c Release
```

Execute os comandos no diretório da solução com o SDK desejado. A [seleção do SDK](https://learn.microsoft.com/en-us/dotnet/core/tools/global-json) é independente do framework alvo. Para avaliar a versão completa RC3 da [página de download](https://dotnet.microsoft.com/en-us/download/dotnet/11.0), use este `global.json`:

```json
{
  "sdk": {
    "version": "11.0.100-rc.3.26522.148",
    "rollForward": "disable",
    "allowPrerelease": true
  }
}
```

`disable` exige exatamente esse SDK; `latestFeature` permite bandas posteriores. Instale o SDK escolhido também no CI. O pin RC3 foi conferido nos metadados publicados, mas não foi instalado ou executado neste artigo. Atualize-o deliberadamente ao mudar de versão.

## 2. Altere o alvo e revise cada dependência

A estrutura mínima de um projeto web é:

```xml
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
```

Esta é uma definição .NET 11, não um projeto testado aqui no .NET 11. Deixe a linguagem no padrão SDK/TFM salvo uma razão concreta para fixá-la. C# 14 pertence ao .NET 10; não é a nova versão de linguagem do .NET 11.

**Não atualize todos os pacotes `Microsoft.*` para versão 11.** Produtos possuem linhas independentes. Confira frameworks, dependências, compatibilidade de providers e estado de lançamento. Alinhe EF Core, provider, pacote Design e ferramentas conforme a documentação. Revise `Directory.Packages.props` se houver gerenciamento central. Um pacote `net8.0` pode continuar compatível; NuGet não prefere automaticamente um asset .NET Standard antigo porque o alvo é mais novo.

## 3. Revise todas as versões intermediárias

Leia as listas de compatibilidade do [.NET 9](https://learn.microsoft.com/en-us/dotnet/core/compatibility/9.0), [.NET 10](https://learn.microsoft.com/en-us/dotnet/core/compatibility/10.0) e [.NET 11](https://learn.microsoft.com/en-us/dotnet/core/compatibility/11), além das notas dos frameworks/providers. A lista do .NET 11 ainda está explicitamente em elaboração.

- **BinaryFormatter:** Desde .NET 9, a implementação incorporada lança exceção; os tipos da API permanecem. Prefira outro formato. O [guia de migração](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/) explica como ler NRBF sem construir tipos serializados arbitrários. Converter não exige necessariamente executar a aplicação antiga no .NET 8.
- **Hosting:** `WebHostBuilder`, `IWebHost` e `WebHost` foram [marcados obsoletos no .NET 10](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/10/webhostbuilder-deprecated?view=aspnetcore-10.0). Isso não prova a remoção de todo código com `IWebHostBuilder` ou `ConfigureWebHostDefaults`. Prefira `WebApplication.CreateBuilder` em código novo e trate diagnósticos reais.
- **Consultas EF:** No SQL Server, EF8 introduziu parâmetros JSON para coleções; [EF10 usa parâmetros escalares por padrão](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew#improved-translation-for-parameterized-collection). Inspecione SQL e planos no provider real. Adicionar `ToList()` indiscriminadamente pode levar trabalho para memória; não é correção universal.
- **Serialização e compilação:** Teste contratos JSON reais, datas, números, enums e polimorfismo. Investigue diagnósticos específicos, inclusive conversões span, sem presumir que toda sobrecarga span vence uma de array.
- **Locks:** `System.Threading.Lock` e Monitor são reentrantes. Um `Lock` tipado estaticamente usa mecanismo diferente de uma referência convertida para `object`; não misture os dois para proteger o mesmo estado. Trocar locks é opcional.
- **Serviços hospedados:** Azure Functions possui sua própria [matriz de suporte](https://learn.microsoft.com/en-us/azure/azure-functions/dotnet-isolated-process-guide#supported-versions). Nesta revisão, .NET 10 é o maior alvo isolated worker; suporte in-process termina em 10 de novembro de 2026. SDK disponível não prova suporte ao .NET 11.

## 4. Verifique o artefato implantado

Este `Program.cs` completo fornece um endpoint de smoke test. Não configura autenticação, controllers ou banco de produção:

```csharp
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.MapGet("/health", () => Results.Ok(new { status = "ok" }));
app.Run();
```

```bash
dotnet restore
dotnet build -c Release --no-restore
dotnet test -c Release --no-build
dotnet publish -c Release --self-contained false
```

O exemplo foi compilado, publicado e chamado com sucesso no .NET 8.0.33 e 10.0.10. `--self-contained false` exige runtime compatível no host. Para publicação autocontida, escolha um RID real e `--self-contained true`; teste no SO de destino. `/health` não é criado automaticamente em qualquer projeto.

Teste também autenticação, autorização, contratos de leitura/escrita, transações, tarefas em segundo plano e rollback em staging. Meça uma carga acordada. Com trimming/AOT, resolva avisos reais e execute o resultado publicado; anotações não tornam qualquer geração dinâmica de código compatível com Native AOT.

## 5. Preserve a compatibilidade do rollback

Guarde o artefato antigo e sua configuração. Schema, dados persistidos, mensagens e estado de autenticação determinam a coexistência. A primeira escrita não impede automaticamente rollback, e uma troca de SDK não cria migração de banco. Use alterações compatíveis e ensaie reverter o tráfego antes da troca.

**Limites da verificação:** Nenhuma migração .NET 11, atualização EF/banco, implantação Azure ou comparação de desempenho foi executada. O exemplo portável e correções selecionadas foram testados no .NET 8/10; orientações específicas de versão foram conferidas na documentação primária.

## Outras fontes primárias

- [System.Threading.Lock](https://learn.microsoft.com/en-us/dotnet/api/system.threading.lock?view=net-10.0)
- [C# 14 span overload resolution](https://learn.microsoft.com/en-us/dotnet/core/compatibility/core-libraries/10.0/csharp-overload-resolution)
- [.NET application publishing](https://learn.microsoft.com/en-us/dotnet/core/deploying/)
