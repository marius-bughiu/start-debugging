---
title: "Migrar do .NET 8 para o .NET 11: o checklist completo"
description: "Um checklist de migração com versões fixadas, do .NET 8 LTS para o .NET 11 LTS, cobrindo instalação do SDK, target framework do csproj, mudanças incompatíveis em ASP.NET Core, EF Core, System.Text.Json e a virada de resolução de sobrecargas do C# 14, com notas de rollback."
pubDate: 2026-05-28
updatedDate: 2026-05-28
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

Pular dois ciclos LTS de uma vez é a atualização de .NET mais barata que a maioria dos times fará nesta década. O .NET 8 deixa o suporte padrão em novembro de 2026, o .NET 11 é o LTS atual, e o caminho entre eles atravessa três conjuntos de mudanças incompatíveis (.NET 9, 10, 11) mais três versões da linguagem C# (C# 13, 14, com C# 12 já entregue no 8). Um fim de semana de trabalho focado costuma ser suficiente para um serviço pequeno. Um monólito de tamanho médio com EF Core, middleware customizado e alguns source generators geralmente custa de três a cinco dias. Bases de código que prendem `BinaryFormatter`, dependem de shims de `System.Web.HttpContext` ou rodam Azure Functions in-process custam mais, e essa dor aparece primeiro.

Este post usa `net8.0` como origem e `net11.0` como destino. Cada bloco de código fixa versões explicitamente para que os passos continuem reproduzíveis depois de alguns patch releases.

## Por que migrar agora

- O suporte padrão do .NET 8 termina em 2026-11-10. Depois dessa data, sem patches de segurança, sem servicing. Seu código em produção no 8 fica exposto a auditoria três semanas antes da Black Friday.
- O .NET 11 entrega ganhos de runtime significativos de graça: PGO dinâmico está ligado por padrão, o novo JIT escalonado lida com máquinas de estado `async` sem a penalidade histórica, e o Native AOT agora suporta minimal APIs do ASP.NET Core e a maior parte do caminho de leitura do EF Core.
- O tipo `System.Threading.Lock` introduzido no .NET 9 remove uma classe de armadilhas de reentrância de monitor. Pular a migração deixa o velho padrão `lock(object)` em cima da mesa.
- O C# 14 traz a palavra-chave `field` estável em propriedades e construtores `partial`. Úteis, mas não são o motivo de migrar; trate como bônus.

## O que quebra

| Área                       | Mudança                                                                              | Severidade |
| -------------------------- | ------------------------------------------------------------------------------------ | ---------- |
| `lock(object)`             | O novo tipo `System.Threading.Lock` muda a semântica do monitor quando adotado       | baixa      |
| `BinaryFormatter`          | Removido por completo no .NET 9. Sem switch de opt-in                                | alta       |
| `System.Text.Json`         | O `JsonNumberHandling` padrão para round-trips de `JsonObject` mudou no .NET 10      | média      |
| Pipeline de queries do EF Core | A tradução de coleções primitivas mudou no EF Core 10; algum LINQ agora lança exceção | alta   |
| Middleware do ASP.NET Core | As assinaturas de sobrecarga de `UseExceptionHandler` mudaram no .NET 10             | baixa      |
| Avisos de trim do Native AOT | Vários caminhos de `System.Reflection.Emit` agora emitem avisos `IL2026`            | média      |
| Resolução de sobrecargas do C# 14 | Sobrecargas de Span agora vencem sobre as de array em casos ambíguos          | média      |
| `IWebHostBuilder`          | Já obsoleto no 8, removido no 11. Mova para `WebApplication.CreateBuilder`           | alta       |
| Ferramenta `dotnet ef`     | Salto de versão maior necessário (`dotnet tool update --global dotnet-ef --version 11.*`) | baixa |
| Azure Functions            | O modelo in-process foi removido; o isolated worker é obrigatório                    | alta       |

A lista oficial completa vive na [documentação de mudanças incompatíveis do .NET 11](https://learn.microsoft.com/en-us/dotnet/core/compatibility/11.0). Leia do início ao fim antes de tocar em qualquer `.csproj`.

## Checklist de pré-decolagem

Rode isso antes de mudar qualquer target framework.

1. Instale o SDK do .NET 11 em toda máquina de dev e em todo runner de CI. Verifique com `dotnet --list-sdks` e confirme que `11.0.x` aparece. O SDK é side-by-side, então o .NET 8 continua funcionando.
2. Fixe o SDK no `global.json` para que o CI não avance silenciosamente:
   ```json
   // global.json, repo root
   {
     "sdk": {
       "version": "11.0.100",
       "rollForward": "latestFeature"
     }
   }
   ```
3. Capture um baseline: rode `dotnet test` no .NET 8 e guarde os resultados. Você quer um verde limpo antes de começar para que o primeiro vermelho depois do upgrade seja inequívoco.
4. Tire um snapshot do runtime de produção: faça dump de `dotnet --info` de um host vivo. Se algo faz link contra um runtime mais antigo que 8.0.0 (uma publicação self-contained antiga, um plugin de terceiros), encontre agora.
5. Inventarie pacotes NuGet com `dotnet list package --outdated --include-transitive`. Qualquer coisa que prenda `Microsoft.*` em `8.0.x` vai precisar de um salto maior; qualquer coisa presa em `7.*` ou mais antiga é uma bandeira vermelha.
6. Crie uma branch para a migração. Um PR por passo lógico é mais fácil de reverter do que um único PR gigante de luz verde.

## Passos de migração

1. **Suba o target framework.** Abra cada `.csproj` e mude o valor de `TargetFramework` (ou `TargetFrameworks`). Verifique com `dotnet build` e trate a primeira rodada de erros de compilação como o escopo real da migração.

   ```xml
   <!-- src/MyApi.csproj, .NET 11 -->
   <Project Sdk="Microsoft.NET.Sdk.Web">
     <PropertyGroup>
       <TargetFramework>net11.0</TargetFramework>
       <LangVersion>14.0</LangVersion>
       <Nullable>enable</Nullable>
       <ImplicitUsings>enable</ImplicitUsings>
     </PropertyGroup>
   </Project>
   ```

   Verificação: `dotnet build` sai com 0 pelo menos para os projetos folha, ou falha com erros que você reconhece.

2. **Atualize todos os pacotes NuGet `Microsoft.*` para a linha 11.x.** Faça isso como um lote único com `dotnet add package` por projeto em vez de tocar `Directory.Packages.props` às cegas. O runtime, ASP.NET Core, EF Core e os pacotes `Microsoft.Extensions.*` versionam em lockstep com o SDK.

   ```bash
   # .NET 11
   dotnet add package Microsoft.AspNetCore.OpenApi --version 11.0.0
   dotnet add package Microsoft.EntityFrameworkCore.SqlServer --version 11.0.0
   dotnet add package Microsoft.Extensions.Hosting --version 11.0.0
   ```

   Verificação: `dotnet restore` tem sucesso e `dotnet list package` não mostra nenhum `8.0.x` restante sob o namespace `Microsoft.*`.

3. **Remova o uso de `BinaryFormatter`.** Se a base de código serializa qualquer coisa com `BinaryFormatter`, substitua agora. `System.Text.Json`, MessagePack ou `protobuf-net` são as substituições usuais dependendo se você precisa de um formato JSON ou binário. Não existe flag de compatibilidade no .NET 9 ou posterior; o tipo não existe mais.

   Verificação: `grep -r "BinaryFormatter" src/` não retorna nada. Se você precisa ler blobs legados de `BinaryFormatter` do armazenamento, escreva uma ferramenta de migração one-shot no .NET 8 para convertê-los antes de desligar o ambiente do .NET 8.

4. **Substitua `IWebHostBuilder` por `WebApplication.CreateBuilder`.** O velho shim do host genérico foi obsoletado no .NET 6 e removido no .NET 11. Qualquer `Program.cs` que ainda chame `Host.CreateDefaultBuilder().ConfigureWebHostDefaults(...)` não vai compilar.

   ```csharp
   // Program.cs, .NET 11, C# 14
   var builder = WebApplication.CreateBuilder(args);
   builder.Services.AddOpenApi();
   builder.Services.AddDbContext<AppDb>(o =>
       o.UseSqlServer(builder.Configuration.GetConnectionString("Default")));

   var app = builder.Build();
   app.MapOpenApi();
   app.MapControllers();
   app.Run();
   ```

   Verificação: o app sobe com `dotnet run` e o endpoint `/openapi/v1.json` responde HTTP 200.

5. **Audite o `System.Text.Json` por mudanças de comportamento.** O tratamento padrão de round-trips de números em `JsonObject` mudou no .NET 10 para que inteiros não percam mais precisão ao serem re-serializados, e o desserializador polimórfico é mais estrito com discriminadores desconhecidos por padrão. Se você mantém um contrato público de API, rode seus testes de contrato e leia as falhas com cuidado. Frequentemente o contrato não mudou, mas uma divergência antes silenciosa agora lança. O post complementar sobre o [fix de "JSON value could not be converted to System.DateTime"](/pt-br/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) cobre o modo de falha de conversão mais comum.

   Verificação: `dotnet test` sai limpo para qualquer projeto que exercite serialização contra arquivos JSON de fixtures.

6. **Migre queries do EF Core que usam coleções primitivas.** O EF Core 10 refez como `List<int>.Contains(x)` é traduzido para que coleções parametrizadas produzam um único parâmetro SQL em vez de expandir numa cláusula `IN`. Isso corrigiu o problema de inchaço do plano-cache, mas quebrou um pequeno conjunto de queries que combinavam `Contains` com outras expressões avaliadas no servidor. Re-rode todos os testes de integração do EF Core e inspecione qualquer query que agora lance `InvalidOperationException: The LINQ expression ... could not be translated`. A válvula de escape é materializar a coleção com `.ToList()` antes do join.

   Verificação: cada teste de integração exercitando LINQ cru sobre `DbSet<T>` passa; verifique por amostragem o SQL gerado com `LogTo(Console.WriteLine, LogLevel.Information)` em uma query representativa.

7. **Adote `System.Threading.Lock` de forma seletiva, não substitua em massa.** Substituir `private readonly object _gate = new();` por `private readonly System.Threading.Lock _gate = new();` está correto na maioria dos casos, mas muda se a reentrância da mesma thread é observável. Caminhe pelos caminhos do código primeiro. Uma comparação de trade-offs mais profunda está em [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock](/pt-br/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/).

   Verificação: o code review cobre explicitamente cada local `lock(...)` que foi mudado; sem mudança funcional na suite de testes.

8. **Rerode os analyzers de trim e AOT.** Se o projeto define `<PublishAot>true</PublishAot>` ou `<TrimMode>full</TrimMode>`, o .NET 11 emite novos avisos em torno de caminhos de `System.Reflection.Emit` que eram silenciosos no .NET 8. A correção costuma ser adicionar anotações `[DynamicallyAccessedMembers]` ou registrar um source generator de JSON. A [comparação Native AOT vs ReadyToRun vs JIT](/pt-br/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) cobre quando cada modelo vale o custo.

   Verificação: `dotnet publish -c Release` emite zero avisos `IL2026` ou `IL3050` no projeto folha; o binário nativo resultante sobe localmente.

9. **Ajuste as surpresas de resolução de sobrecargas do C# 14.** O C# 14 mudou as regras de resolução para que sobrecargas que aceitam `ReadOnlySpan<T>` sejam preferidas sobre as que aceitam `T[]` quando ambas se aplicam. A maior parte do código não é afetada. Os casos que quebram costumam ser mocks, bibliotecas de assertions fluentes e métodos de extensão customizados escritos assumindo que a sobrecarga de array venceria. O compilador emite um diagnóstico claro; o fix geralmente é um cast. A [mudança incompatível de resolução de sobrecargas do C# 14 com spans](/pt-br/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/) caminha pelo diagnóstico e pelo padrão do cast.

   Verificação: `dotnet build` está limpo de avisos com `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>`.

10. **Atualize as imagens dos runners de CI.** Suba o `dotnet-version` do `actions/setup-dotnet` do GitHub Actions para `11.0.x`, atualize qualquer Dockerfile para a imagem base `mcr.microsoft.com/dotnet/sdk:11.0` e `mcr.microsoft.com/dotnet/aspnet:11.0`, e remova os pins na imagem do SDK do .NET 8. Runners self-hosted precisam do SDK instalado manualmente antes do CI passar.

    Verificação: uma execução da pipeline numa branch de feature está verde de ponta a ponta, incluindo o passo de publish.

## Verificação (checklist de smoke)

Depois dos passos acima, o app deve passar cada linha desta lista antes do PR de migração ser mergeado:

- `dotnet --list-sdks` mostra 11.0.x como a versão realmente usada pelo build (`dotnet --version` na raiz do repo imprime `11.0.x`).
- `dotnet restore && dotnet build -c Release` sai com 0 e zero avisos.
- `dotnet test -c Release` está verde e a contagem de testes bate com o baseline do .NET 8.
- `dotnet publish -c Release` produz um artefato que sobe localmente e serve `/health`.
- Um caminho de leitura representativo e um caminho de escrita representativo são exercitados contra um ambiente de staging; a latência p50/p95 está dentro de 10 por cento do baseline do .NET 8.
- Os logs não mostram referências first-chance a `BinaryFormatter`, `IWebHostBuilder` ou `IL2026`.

Se qualquer uma falhar, pare. Não mergeie uma base de código parcialmente migrada.

## Rollback

Esta migração é reversível até o primeiro deploy de produção que receba uma escrita sob .NET 11. Até lá, reverta o `global.json`, o `TargetFramework` e os bumps de NuGet em um único commit. Depois da primeira escrita em produção sob .NET 11, o rollback é tecnicamente possível mas raramente vale a pena: mudanças de esquema que você pode ter feito sob o tradutor do EF Core 11, saídas JSON serializadas sob os novos padrões e qualquer adoção de `System.Threading.Lock` precisam de raciocínio separado. Planeje seguir em frente e consertar adiante.

## Pegadinhas que encontramos

- **Um pacote NuGet que mira apenas `net8.0` não está necessariamente quebrado no net11.0**, mas vai carregar silenciosamente a fachada de .NET Standard 2.0 se o pacote expor uma. Isso às vezes traz dependências `System.*` mais antigas de volta. Depois do bump, `dotnet list package --include-transitive` não é opcional.
- **As versões de `Microsoft.Data.SqlClient` importam.** O EF Core 11 quer `Microsoft.Data.SqlClient` 7.x ou posterior. Um pin transitivo mais antigo compilará, depois falhará em tempo de execução na negociação TLS 1.3 contra caixas SQL Server mais novas.
- **Source generators construídos sobre o Roslyn 4.6 emitem avisos sobre o Roslyn que vem com o .NET 11.** A maioria resolve subindo a referência `Microsoft.CodeAnalysis.CSharp` do gerador. Se você publica o próprio gerador, faça isso em um PR separado.
- **Azure Functions in-process não existem mais.** Se um único projeto de função ainda usa o modelo in-process no .NET 8, o .NET 11 não vai rodá-lo. Mova para o modelo isolated worker primeiro, depois suba.
- **A semântica de cancelamento de `HttpClient` no .NET 11** lança corretamente `TaskCanceledException` cujo `CancellationToken` bate com o token fornecido, onde antes alguns caminhos lançavam com `CancellationToken.None`. Blocos catch que fazem pattern-match sobre o token vão precisar de um pequeno ajuste; a justificativa está na discussão de [async void vs async Task em C#](/pt-br/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/).

## Relacionados

- [ConfigureAwait(false) vs padrão no .NET 11](/pt-br/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- [Native AOT vs ReadyToRun vs JIT no .NET 11](/pt-br/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [EF Core 11 vs Dapper para inserts em massa: benchmark real](/pt-br/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/)
- [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock](/pt-br/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/)
- [Minimal APIs vs controllers no ASP.NET Core 11](/pt-br/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)

## Fontes

- [Mudanças incompatíveis do .NET 11](https://learn.microsoft.com/en-us/dotnet/core/compatibility/11.0)
- [Calendário e política de suporte do .NET](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core)
- [Mudanças incompatíveis do EF Core 10 e 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/)
- [Referência da linguagem C# 14](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/csharp-14)
- [Referência da API `System.Threading.Lock`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.lock)
