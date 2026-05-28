---
title: "Migre do .NET Framework 4.8 para o .NET 11 em 2026"
description: "Um manual de migração com versões fixadas para mover uma base de código .NET Framework 4.8 para o .NET 11 LTS em 2026, abrangendo a reescrita do csproj no formato SDK, System.Web para ASP.NET Core, WCF, EF6 para EF Core 11, remoção do BinaryFormatter, substituições de AppDomain e um plano de rollback realista."
pubDate: 2026-05-28
updatedDate: 2026-05-28
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

Mover uma base de código .NET Framework 4.8 para o .NET 11 não é uma simples atualização de versão. É um exercício de re-plataformização que toca no formato do projeto, na pilha web, na camada de acesso a dados, no modelo de hospedagem e em uma longa cauda de APIs que silenciosamente desapareceram entre 2017 e 2026. A janela oficial de suporte do .NET Framework 4.8 ainda está aberta em 2026, mas o runtime não recebe uma atualização de recursos desde 2019, todo plano moderno do Azure App Service está na pilha Core por padrão e quase todo pacote NuGet que vale a pena depender abandonou os alvos `net48`. O esforço realista para um aplicativo típico de linha de negócio é de duas a seis semanas para um serviço pequeno, e de dois a quatro meses para uma base de código média com WCF, EF6 e um front end WebForms ou MVC 5. Aplicativos WebForms permanecem onde estão ou são reescritos; não há porte no local. Este post fixa `net48` como origem e `net11.0` como alvo, e assume que o projeto está no Windows.

## Por que migrar agora

- O .NET Framework 4.8 está em manutenção apenas desde o lançamento do 4.8.1 em agosto de 2022. Sem novas APIs, sem novos recursos de linguagem C#. O runtime do .NET 11 entrega PGO dinâmico ativado por padrão, o JIT em camadas modernizado e Native AOT para APIs mínimas do ASP.NET Core.
- Todo framework novo da Microsoft (Aspire, Microsoft Agent Framework, Semantic Kernel 1.x, Azure Functions isolated worker) tem como alvo `net8.0` ou mais recente e não será retroportado. Permanecer no 4.8 significa que nenhum deles está acessível a partir do seu próprio processo.
- Custo de nuvem. O consumo de memória do runtime do .NET 11 para uma API mínima ASP.NET Core ociosa é aproximadamente 35 a 50 por cento de um processo worker do ASP.NET 4.8 em carga comparável, o que se traduz diretamente em planos do App Service menores ou maior densidade de pods no Kubernetes.
- Contratação e ferramentas. Analisadores Roslyn, geradores de código-fonte e a CLI moderna `dotnet` assumem um projeto no formato SDK. A versão da linguagem C# em `net48` é limitada ao C# 7.3 a menos que você lute contra o compilador, o que deixa uma década de recursos de linguagem fora do alcance.

Se a base de código é um aplicativo desktop Windows (WinForms ou WPF) que só roda no Windows e não tem planos de implantar em outro lugar, a pergunta é justa. A resposta ainda costuma ser sim, porque a vida útil suportada do net48 termina com a janela de suporte estendido do Windows 10, e o suporte de ferramentas já está enfraquecido.

## O que quebra

| Área                          | Mudança                                                                                              | Severidade |
| ----------------------------- | --------------------------------------------------------------------------------------------------- | ---------- |
| Formato do projeto            | `packages.config` e o XML antigo do csproj não são suportados pelo SDK do .NET 11                    | alta       |
| `System.Web`                  | Removido inteiramente. `HttpContext.Current`, módulos, handlers, WebForms não têm equivalente no .NET 11 | alta       |
| Servidor WCF                  | `System.ServiceModel` do lado servidor não é suportado. Use CoreWCF ou reescreva para gRPC ou HTTP   | alta       |
| Cliente WCF                   | Suportado via pacotes NuGet `System.ServiceModel.*` 6.x, com bindings limitados                      | média      |
| Entity Framework 6            | Roda no .NET 11 com EF6 6.5.0 ou posterior, mas novo desenvolvimento deve usar EF Core 11           | média      |
| `AppDomain`                   | Apenas o `AppDomain` padrão existe. Sem `CreateDomain`, sem contêineres de plugin descarregáveis     | alta       |
| `BinaryFormatter`             | Removido no .NET 9, sem chave de opt-in                                                              | alta       |
| .NET Remoting                 | Foi-se. Sem substituto; reescreva para um protocolo de rede que você realmente queira                | alta       |
| Code Access Security          | Foi-se. `[SecurityCritical]`, `PermissionSet`, sandboxing todos removidos                            | alta       |
| `web.config`                  | A configuração move para `appsettings.json`. As seções `system.web` não se aplicam                   | alta       |
| `app.config`                  | A maioria das configurações ainda funciona via `Microsoft.Extensions.Configuration.Xml`, mas redirecionamentos de binding foram-se | média |
| WPF e WinForms                | Suportados no .NET 11, apenas Windows. A maioria dos controles de terceiros precisa de uma build 6.x ou posterior | média |
| `System.Drawing.Common`       | Suporte multiplataforma removido no .NET 6. Apenas Windows desde então                               | média      |

Leia o [.NET Framework to .NET porting overview](https://learn.microsoft.com/en-us/dotnet/core/porting/) e a [.NET 11 breaking changes list](https://learn.microsoft.com/en-us/dotnet/core/compatibility/11.0) uma vez antes de tocar em um `.csproj`. A primeira lista é de longe a mais extensa das duas.

## Checklist pré-decolagem

Execute essas etapas antes de mudar um único arquivo de projeto.

1. Instale o SDK do .NET 11 em cada máquina de desenvolvimento e runner de CI. Verifique com `dotnet --list-sdks` e confirme que `11.0.x` aparece. Mantenha o developer pack do .NET Framework 4.8 instalado para que a solução antiga ainda abra no Visual Studio.
2. Instale a CLI do .NET Upgrade Assistant e execute-a primeiro em modo de análise. Ela não migra código; ela produz um relatório acionável.
   ```bash
   # .NET 11, upgrade-assistant 0.6.x
   dotnet tool install --global upgrade-assistant
   upgrade-assistant analyze MySolution.sln
   ```
3. Execute o .NET Portability Analyzer ou `apiport` contra os assemblies compilados. Qualquer coisa marcada como "not portable" é trabalho de migração que a ferramenta upgrade-assistant não fará por você.
4. Capture uma linha de base. Execute a suíte de testes existente no .NET Framework 4.8 e armazene o resultado. Um verde limpo no runtime antigo significa que o primeiro vermelho no .NET 11 é, sem ambiguidade, uma regressão de migração.
5. Inventarie pacotes NuGet de terceiros. Qualquer coisa que entregue apenas assemblies `net48` ou `net472` é um bloqueador. Substituições: `log4net` 2.0.16, `Newtonsoft.Json` 13.x, `AutoMapper` 13.x, `Dapper` 2.1.x todos multi-target e funcionam no .NET 11. Qualquer outra coisa precisa de um ticket de atualização contra o fornecedor.
6. Ramifique a migração. Planeje pelo menos um PR por projeto, e um PR separado para os projetos de teste. Um único mega-PR para uma base de código média é não-revisável.

## Etapas de migração

1. **Converta cada `.csproj` para o formato SDK.** Substitua o XML antigo pelo cabeçalho no formato SDK. O novo formato infere arquivos, descarta a maioria das referências de assembly e usa `PackageReference` em vez de `packages.config`. A ferramenta `try-convert` (incluída no .NET Upgrade Assistant) lida com a parte mecânica.

   ```xml
   <!-- src/MyApi.csproj, .NET 11, after conversion -->
   <Project Sdk="Microsoft.NET.Sdk.Web">
     <PropertyGroup>
       <TargetFramework>net11.0</TargetFramework>
       <LangVersion>14.0</LangVersion>
       <Nullable>enable</Nullable>
       <ImplicitUsings>enable</ImplicitUsings>
     </PropertyGroup>
     <ItemGroup>
       <PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="11.0.0" />
       <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0" />
     </ItemGroup>
   </Project>
   ```

   Verificação: `dotnet build` sai com erros que nomeiam APIs removidas em vez de erros de parser contra o próprio arquivo de projeto. Apague `packages.config` após a conversão ser bem-sucedida.

2. **Apague o uso de `BinaryFormatter` em todos os lugares.** O tipo foi removido no .NET 9 sem chave de compatibilidade. Substitua-o por `System.Text.Json`, MessagePack ou `protobuf-net` dependendo se você precisa de um formato JSON ou binário no fio. Se você tem blobs armazenados serializados com `BinaryFormatter`, escreva um utilitário de conversão de uso único que ainda rode no .NET Framework 4.8 para traduzi-los para o novo formato antes de desativar o ambiente antigo. Fazer essa conversão a partir do .NET 11 não é possível.

   Verificação: `grep -r "BinaryFormatter" src/` está vazio. Qualquer armazenamento de blob que anteriormente continha payloads binário-formatados foi re-serializado e o novo formato faz round-trip através de um teste unitário.

3. **Reescreva a pilha web de `System.Web` para ASP.NET Core 11.** Esta é a maior peça única de trabalho. Controllers MVC 5 mapeiam quase um-para-um para controllers do ASP.NET Core, mas atributos de roteamento, model binding, action filters e injeção de dependência diferem todos. `HttpContext.Current` foi-se; controllers e middleware recebem `HttpContext` explicitamente. `Application_Start` em `Global.asax` torna-se código de inicialização em `Program.cs`. Controllers WebAPI 2 são muito próximos de controllers ASP.NET Core, mas herdam de `ControllerBase` em vez de `ApiController`.

   ```csharp
   // Program.cs, .NET 11, C# 14
   var builder = WebApplication.CreateBuilder(args);
   builder.Services.AddControllers();
   builder.Services.AddOpenApi();
   builder.Services.AddDbContext<AppDb>(o =>
       o.UseSqlServer(builder.Configuration.GetConnectionString("Default")));

   var app = builder.Build();
   app.UseAuthentication();
   app.UseAuthorization();
   app.MapControllers();
   app.MapOpenApi();
   app.Run();
   ```

   WebForms (`.aspx`) não tem caminho de migração. Ou mantenha o aplicativo WebForms no .NET Framework 4.8 pelo resto de sua vida por trás de um proxy reverso, ou reescreva as páginas afetadas como Blazor, MVC ou Razor Pages. A comparação [Blazor Server vs Blazor WebAssembly vs Blazor United](/pt-br/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) é o ponto de partida certo se Blazor está sobre a mesa.

   Verificação: cada controller tem pelo menos um teste de integração que exercita uma rota HTTP contra `WebApplicationFactory<Program>` e afirma tanto o código de status quanto o corpo da resposta.

4. **Mova `web.config` para `appsettings.json`.** Connection strings, appSettings customizados e configuração de logging movem para JSON. Seções `system.web` não se aplicam. Seções `system.webServer` que configuram o IIS ainda se aplicam se você hospedar atrás do IIS via o módulo in-process, mas a maioria das implantações de produção agora usa Kestrel diretamente. Configurações de autenticação movem das seções `<authentication>` e `<authorization>` do web.config para `builder.Services.AddAuthentication(...)` e a API de política de autorização.

   ```json
   // appsettings.json, .NET 11
   {
     "ConnectionStrings": {
       "Default": "Server=.;Database=App;Trusted_Connection=True;TrustServerCertificate=True;"
     },
     "Logging": {
       "LogLevel": { "Default": "Information", "Microsoft.AspNetCore": "Warning" }
     }
   }
   ```

   Verificação: o aplicativo lê cada valor anteriormente dirigido por configuração através de `IConfiguration` ou do padrão fortemente tipado `IOptions<T>`; nenhuma chamada para `ConfigurationManager.AppSettings` sobrevive no código de produção.

5. **Lide com WCF.** WCF do lado servidor não é suportado no .NET 11. Dois caminhos realistas:
   - **CoreWCF** (o porte mantido pela comunidade). Adicione `CoreWCF.Primitives`, `CoreWCF.Http` e os bindings que você realmente usa. A maioria dos serviços `BasicHttpBinding` e `NetTcpBinding` migra com uma referência de contrato e uma chamada de configuração `UseServiceModel`. Streaming, transações e segurança em nível de mensagem têm graus variados de suporte; verifique a [CoreWCF compatibility matrix](https://github.com/CoreWCF/CoreWCF) antes de se comprometer.
   - **Reescreva para gRPC ou uma API HTTP.** Teto mais alto, mais trabalho. A escolha certa quando a interface WCF só foi consumida por clientes que você controla.

   WCF do lado cliente é suportado via os pacotes NuGet `System.ServiceModel.*` 6.x com `BasicHttpBinding`, `NetTcpBinding` (limitado) e `WSHttpBinding` (apenas segurança de transporte). Se seu cliente usa `WSFederationHttpBinding` ou segurança em nível de mensagem, você vai reescrever o consumidor.

   Verificação: cada endpoint WCF tem um teste de contrato que executa o cliente .NET 11 contra o novo host CoreWCF ou o substituto reescrito, e afirma os mesmos payloads que o cliente .NET Framework antigo.

6. **Mova Entity Framework 6 para EF Core 11 (quando valer a pena).** EF6 roda no .NET 11 via o pacote `EntityFramework` 6.5.0, então um lift-and-shift estrito é possível. Mas EF6 não recebe novos recursos, a API `DbContext` no EF Core está mais próxima do que você quer para injeção de dependência do ASP.NET Core, e as consultas compiladas do EF Core 11 e a tradução de coleções primitivas são significativamente mais rápidas. Para a maioria das equipes, a escolha certa é entregar a migração no EF6 primeiro, depois mover para EF Core em um PR de acompanhamento. O post [EF Core compiled queries vs raw SQL vs Dapper](/pt-br/2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper/) quantifica os ganhos no caminho quente.

   Verificação: o ORM escolhido passa na mesma suíte de testes de integração que rodava sob EF6 no .NET Framework, incluindo quaisquer testes que afirmavam o SQL gerado.

7. **Substitua os carregadores de plugin `AppDomain.CreateDomain`.** `AppDomain` não é mais um limite de isolamento no .NET 11; apenas o domínio padrão existe. Sistemas de plugin que anteriormente carregavam assemblies em um `AppDomain` filho para semântica de descarregamento ou isolamento de falhas devem mover para `AssemblyLoadContext` com `isCollectible: true` e chamar `Unload()` quando terminado. Plugins fora-de-processo via processos worker `dotnet` são o padrão mais seguro quando o plugin é não confiável.

   Verificação: um teste unitário carrega um assembly de plugin, chama nele, descarrega o `AssemblyLoadContext` e afirma que uma `WeakReference` ao contexto torna-se `null` após um ciclo `GC.Collect()`.

8. **Audite os saltos de versão da linguagem C#.** Ir do C# 7.3 para o C# 14 é doze lançamentos de linguagem em um passo. A maior parte é aditiva e segura, mas tipos de referência anuláveis (introduzidos no C# 8) vão sinalizar milhares de avisos em código legado se você ligar `<Nullable>enable</Nullable>` globalmente. O caminho realista é `<Nullable>annotations</Nullable>` primeiro (apenas anotações, sem diagnósticos), depois conversão arquivo por arquivo usando pragmas `#nullable enable`. A mudança de resolução de sobrecarga do C# 14 em torno de sobrecargas de span está documentada no post de correção [C# 14 overload resolution breaking change with spans](/pt-br/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/).

   Verificação: `dotnet build -warnaserror` está limpo no escopo anulável acordado antes do merge.

9. **Atualize as imagens dos runners de CI.** Suba o `actions/setup-dotnet` do GitHub Actions para `dotnet-version: 11.0.x`, atualize qualquer imagem base do Dockerfile para `mcr.microsoft.com/dotnet/sdk:11.0` e `mcr.microsoft.com/dotnet/aspnet:11.0`, e remova a imagem MSBuild antiga do .NET Framework. Se algum projeto ainda tem que compilar sob .NET Framework (por exemplo, a ferramenta de conversão única do `BinaryFormatter` da etapa 2), mantenha um único runner `windows-2022` com o developer pack do .NET Framework 4.8 instalado e proteja-o atrás de um filtro de caminho.

   Verificação: uma execução de pipeline em um branch de feature está verde de ponta a ponta, incluindo `dotnet publish`, build de imagem de contêiner e deploy de fumaça em um ambiente de staging.

## Verificação (checklist de fumaça)

Após as etapas acima, o aplicativo deve passar cada linha desta lista antes do PR de migração entrar em merge:

- `dotnet --list-sdks` mostra `11.0.x` e `dotnet --version` a partir da raiz do repositório imprime `11.0.x`.
- `dotnet restore && dotnet build -c Release` sai com 0 e zero avisos no escopo anulável que você acordou.
- `dotnet test -c Release` está verde e a contagem de testes corresponde (ou excede) à linha de base do .NET Framework 4.8.
- `dotnet publish -c Release` produz um artefato self-contained que inicializa em um host de staging limpo sem o redistribuível do .NET Framework 4.8 instalado.
- Cada rota HTTP tem pelo menos um teste de integração contra `WebApplicationFactory<Program>`.
- Os logs não mostram referências de primeira chance a `BinaryFormatter`, `IWebHostBuilder`, `HttpContext.Current` ou `ConfigurationManager` em caminhos de código de produção.
- Um deploy de staging serve o caminho dourado; latência p50/p95 está dentro de 20 por cento da linha de base do .NET Framework em hardware equivalente.

Se qualquer um deles falhar, pare. Uma migração parcial para .NET 11 é pior que um deploy limpo do .NET Framework 4.8 porque compromete com os dois runtimes.

## Rollback

A migração é reversível apenas enquanto o esquema do banco de dados e quaisquer formatos no fio não tenham mudado. A troca de runtime em si é reversível: reverta as mudanças do `.csproj` e reinstale o redistribuível do .NET Framework 4.8 no host. As decisões que tornam o rollback caro são geralmente ortogonais:

- Uma nova migração do EF Core 11 rodou contra o banco de dados de produção. Faça rollback do esquema primeiro.
- Payloads JSON foram re-serializados sob padrões do `System.Text.Json` que diferem do `Newtonsoft.Json`. Consumidores downstream que fazem pattern-match em ordenação de campos ou tratamento de null verão drift.
- A autenticação mudou de cookies `FormsAuthentication` para os cookies de data-protection do ASP.NET Core. Sessões existentes são invalidadas de qualquer jeito.

O plano pragmático é manter o deploy do .NET Framework quente em um slot separado por uma semana após o cutover, e proteger o cutover atrás de uma feature flag no load balancer em vez de no momento do deploy. Corrija para frente depois dessa janela.

## Pegadinhas que encontramos

- **`HttpClient` no .NET 11 impõe estritamente a indicação de nome de servidor TLS.** Chamadas para serviços internos que apresentam um certificado sem um SAN correspondente falham com `AuthenticationException`. Ou conserte o certificado ou defina `SslOptions.RemoteCertificateValidationCallback` deliberadamente. Os padrões do .NET Framework eram mais frouxos, e isso mascarava a lacuna do SAN.
- **`DateTime.Parse` no .NET 11 é mais estrito sobre formatos ambíguos que o .NET Framework 4.8.** Código que fazia round-trip de `DateTime` através de string sem um `IFormatProvider` explícito vai começar a lançar `FormatException` em entradas que aceitava antes. Sempre passe `CultureInfo.InvariantCulture` e um formato conhecido. A correção [JSON value could not be converted to System.DateTime](/pt-br/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) cobre a variante mais comum quando a data chega através de JSON.
- **`Microsoft.Data.SqlClient` substitui `System.Data.SqlClient` em qualquer caminho moderno.** EF Core 11 quer `Microsoft.Data.SqlClient` 7.x ou posterior. Um pin transitivo no `System.Data.SqlClient` antigo vai compilar mas falhar em runtime na negociação TLS 1.3 contra caixas SQL Server mais novas.
- **A vinculação de configuração diferencia maiúsculas de minúsculas no JSON, mas não no `app.config`.** Uma propriedade chamada `MaxRetries` em `appsettings.json` não vincula a partir de uma chave `maxretries`. O `ConfigurationManager` do .NET Framework não se importava.
- **`HostingEnvironment.MapPath` foi-se.** Substitua por `IWebHostEnvironment.ContentRootPath` e `Path.Combine`. A sintaxe de caminho virtual `~/` não é entendida por nada no ASP.NET Core.
- **Surrogates de datacontract do WCF não fazem round-trip identicamente através do CoreWCF.** Se você depende de `IDataContractSurrogate`, escreva um teste de contrato que afirma o formato exato no fio antes e depois da migração, não apenas igualdade de objetos.

## Relacionados

- [Migre do .NET 8 para o .NET 11: o checklist completo](/pt-br/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)
- [Native AOT vs ReadyToRun vs JIT no .NET 11](/pt-br/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [APIs mínimas vs controllers no ASP.NET Core 11](/pt-br/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)
- [System.Text.Json vs Newtonsoft.Json em 2026](/pt-br/2026/05/system-text-json-vs-newtonsoft-json-in-2026/)
- [EF Core 11 vs Dapper para inserções em massa: benchmark real](/pt-br/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/)

## Fontes

- [.NET Framework to .NET porting overview](https://learn.microsoft.com/en-us/dotnet/core/porting/)
- [.NET 11 breaking changes](https://learn.microsoft.com/en-us/dotnet/core/compatibility/11.0)
- [.NET Upgrade Assistant documentation](https://learn.microsoft.com/en-us/dotnet/core/porting/upgrade-assistant-overview)
- [CoreWCF project and compatibility matrix](https://github.com/CoreWCF/CoreWCF)
- [Migrate from ASP.NET to ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/migration/proper-to-2x/)
- [AssemblyLoadContext API reference](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.loader.assemblyloadcontext)
