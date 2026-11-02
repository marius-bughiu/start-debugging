---
title: "Migre do .NET Framework 4.8 para o .NET 11 em 2026"
description: "Planeje a migração do .NET Framework 4.8 com suporte correto, fronteiras incrementais ASP.NET, dependências, configuração e rollback."
pubDate: 2026-05-28
updatedDate: 2026-11-02
template: migration
tags:
  - "migration"
  - "dotnet-framework"
  - "dotnet-11"
  - "aspnet-core"
  - "ef-core-11"
lang: "pt-br"
translationOf: "2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026"
translatedBy: "claude"
translationDate: 2026-05-28
---

**Correção — 2 de novembro de 2026:** Foram corrigidos status/suporte do .NET 11, ciclo de vida do Framework, configuração, serialização, ferramentas e implantação. Foram removidas estimativas sem evidência de duração, economia de memória e experiências supostamente realizadas.

Migrar do .NET Framework 4.8 para .NET moderno pode exigir outro host e mudanças nas bibliotecas, implantação e contratos de dados. Não é uma atualização de runtime no lugar. Identifique primeiro o motivo e qual parte pode migrar independentemente.

Nesta revisão, [.NET 11 RC3 é um pré-lançamento go-live](https://dotnet.microsoft.com/en-us/download/dotnet/11.0), .NET 11 é uma linha STS e .NET 10 é a opção LTS lançada. [O suporte do Framework acompanha o produto Windows](https://learn.microsoft.com/en-us/lifecycle/faq/dotnet-framework); não existe uma única data final do Framework 4.8 para todas as instalações Windows 10. Confira o SO real e sua versão suportada do Framework.

## Inventarie antes de alterar projetos

Compile e teste a aplicação existente no ambiente Windows suportado. Mantenha developer/reference packs e ferramentas disponíveis durante a migração. Registre autenticação, sessões, integrações Windows, bibliotecas nativas, jobs, providers e formatos persistidos. Compatibilidade depende de APIs e assets, não de uma regra que invalida toda biblioteca `net48`.

A [visão geral do Upgrade Assistant](https://learn.microsoft.com/en-us/dotnet/core/porting/upgrade-assistant-overview) agora marca a ferramenta como obsoleta e aponta para o agente de modernização do GitHub Copilot. Automação é opcional; revise e teste suas alterações. Um comando antigo sem versão fixada não garante suporte ao .NET 11.

Separe a limpeza do formato do projeto da migração do runtime quando possível. SDK-style não traduz `System.Web`, hosting WCF, COM ou tarefas MSBuild personalizadas. Preserve uma referência funcional e migre bibliotecas folha antes dos consumidores.

## Escolha a fronteira da migração

| Dependência existente | Trabalho planejado |
| --- | --- |
| ASP.NET MVC 5 / Web API 2 | Adaptar rotas, filtros, binding, autenticação, sessões e hosting |
| Web Forms / System.Web | Manter atrás de fronteira incremental ou substituir UI; ASP.NET Core não executa Web Forms |
| Servidor WCF | Avaliar CoreWCF para bindings/recursos reais ou redesenhar contrato |
| Cliente WCF | Conferir pacotes System.ServiceModel e requisitos de segurança |
| EF6 | Verificar runtime/provider modernos; planejar EF Core separadamente |
| WPF / WinForms | Alvos Windows e testes de controles, COM, componentes nativos e implantação |
| AppDomains adicionais / Remoting / CAS | Redesenhar carregamento, comunicação e isolamento |

O [guia ASP.NET](https://learn.microsoft.com/en-us/aspnet/core/migration/fx-to-core/?view=aspnetcore-10.0) admite migração incremental. Rotas atrás de proxy permitem manter o legado funcionando. Migração parcial é válida quando autenticação, roteamento, propriedade dos dados e rollback são deliberadamente gerenciados.

[CoreWCF](https://github.com/CoreWCF/CoreWCF) não garante igualdade de todos os recursos e contratos WCF. Teste os bindings e a autenticação usados. [EF6 suporta .NET moderno desde 6.3](https://learn.microsoft.com/en-us/ef/ef6/what-is-new/); escolha e teste uma versão/provider atual compatível em vez de tratar 6.5.0 como mínimo universal. EF Core não substitui EF6 sem adaptações.

## Comece por uma pequena parte funcional

A base de um projeto ASP.NET Core para avaliar .NET 11 é:

```xml
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
```

Use um SDK instalado e explicitamente selecionado, com pacotes compatíveis. O [checklist .NET 8 para 11](/pt-br/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) mostra o pin RC3 atual. Um projeto desktop precisa do TFM Windows e ajustes correspondentes; não transforme todo projeto em `Microsoft.NET.Sdk.Web`.

Este `Program.cs` completo é um smoke test, não uma aplicação migrada:

```csharp
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.MapGet("/health", () => Results.Ok(new { status = "ok" }));
app.Run();
```

Foi compilado, publicado e chamado no .NET 8 e 10 nesta correção. Uma aplicação MVC deve registrar controllers antes de mapeá-los. Autenticação exige esquema e serviços reais; adicionar `UseAuthentication()` não migra Forms Authentication.

## Preserve a semântica de configuração e dados

Um pequeno `appsettings.json`:

```json
{
  "Migration": {
    "MaxRetries": 3
  }
}
```

O [provider JSON de configuração ignora diferenças entre maiúsculas e minúsculas nas chaves](https://learn.microsoft.com/en-us/dotnet/core/extensions/configuration-providers). Isso difere das regras de serialização JSON em geral. Revise precedência e armazenamento de segredos. O provider XML não reproduz automaticamente todas as seções de `app.config` ou binding redirects. `System.Configuration.ConfigurationManager` pode ser uma opção para APIs compatíveis; eliminar todo uso não é obrigatório. `web.config` continua relevante no IIS.

A implementação incorporada de `BinaryFormatter` lança exceção desde .NET 9, mas o tipo permanece. Use outro serializador ou avalie o [leitor NRBF](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/) para extrair dados sem instanciar tipos codificados arbitrários. A conversão não exige necessariamente o antigo desserializador inseguro no Framework 4.8.

`AssemblyLoadContext` permite carregar e descarregar assemblies cooperativamente, mas não recria a fronteira de segurança de AppDomain. Referências, código ativo e eventos podem impedir a descarga. Um ciclo de GC não prova sucesso. Para código não confiável, use fronteira adequada de processo/container e permissões.

Mantenha a validação de certificados. Em falhas TLS, investigue certificado, hostname, cadeia de confiança, configurações SQL e plataforma. Não aceite todos os certificados como solução. Teste formatos/culturas e contratos concretos em vez de presumir uma mudança geral de parsing no .NET 11.

## Implante e ensaie rollback

```bash
dotnet restore
dotnet build -c Release --no-restore
dotnet test -c Release --no-build
dotnet publish -c Release --self-contained false
```

O comando publica explicitamente uma aplicação dependente do framework. Uma publicação autocontida exige `--self-contained true` e RID adequado; não é resultado automático de `dotnet publish`. Preserve CI Windows para projetos Framework restantes e valide o artefato moderno na plataforma real.

Teste acessos negados além de solicitações bem-sucedidas, sessões, escritas no banco, mensagens, jobs e integrações desktop. Mantenha a implantação antiga disponível, faça mudanças compatíveis e ensaie reverter o tráfego. Rollback exige aplicação e configuração antigas, não apenas reinstalar o redistribuível.

**Limites da verificação:** Não foram testados aplicação Windows/Framework, SDK .NET 11, serviço WCF, migração EF ou implantação produtiva. Endpoint portável e chaves JSON foram verificados no .NET 8 e 10. Estime esforço e desempenho com uma parte representativa da sua aplicação.

## Outras fontes primárias

- [AssemblyLoadContext](https://learn.microsoft.com/en-us/dotnet/core/dependency-loading/understanding-assemblyloadcontext)
- [.NET Framework technologies unavailable on .NET](https://learn.microsoft.com/en-us/dotnet/core/porting/net-framework-tech-unavailable)
- [.NET application publishing](https://learn.microsoft.com/en-us/dotnet/core/deploying/)
