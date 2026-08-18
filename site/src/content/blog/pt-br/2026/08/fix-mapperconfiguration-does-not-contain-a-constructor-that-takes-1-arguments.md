---
title: "Correção: 'MapperConfiguration' does not contain a constructor that takes 1 arguments"
description: "O AutoMapper 15 removeu o construtor de um único argumento de MapperConfiguration. Passe um ILoggerFactory como segundo argumento e adicione uma ação de configuração em toda chamada a AddAutoMapper."
pubDate: 2026-08-18
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "csharp"
  - "automapper"
  - "migration"
lang: "pt-br"
translationOf: "2026/08/fix-mapperconfiguration-does-not-contain-a-constructor-that-takes-1-arguments"
translatedBy: "claude"
translationDate: 2026-08-18
---

`new MapperConfiguration(cfg => ...)` não compila mais porque o AutoMapper 15.0 apagou o construtor de um único argumento. Passe um `ILoggerFactory` como segundo argumento: `new MapperConfiguration(cfg => ..., loggerFactory)`, ou `NullLoggerFactory.Instance` em testes. A mesma versão também apagou todas as sobrecargas de `AddAutoMapper` que não recebiam uma ação de configuração, então `services.AddAutoMapper(typeof(Program))` quebra no mesmo build com outro código de erro.

Tudo abaixo foi verificado com AutoMapper 15.1.3 e 16.2.0 no SDK do .NET 10.0.201, tendo como alvo `net10.0`. A mudança chegou na [15.0.0 em 2025-07-02](https://github.com/LuckyPennySoftware/AutoMapper/releases/tag/v15.0.0) e continua sendo o formato da API na 16.2.0.

## O erro em contexto

```text
Repro.cs(11,26): error CS1729: 'MapperConfiguration' does not contain a constructor that takes 1 arguments
```

Se você registra o AutoMapper via injeção de dependência, o mesmo build normalmente produz mais dois erros que são a mesma mudança incompatível com outra roupagem:

```text
Repro.cs(15,32): error CS1503: Argument 2: cannot convert from 'System.Type' to 'System.Action<AutoMapper.IMapperConfigurationExpression>'
Repro.cs(16,32): error CS1503: Argument 2: cannot convert from 'System.Reflection.Assembly' to 'System.Action<AutoMapper.IMapperConfigurationExpression>'
```

Três erros, uma causa. Corrigir apenas o construtor deixa o build vermelho.

## Por que o construtor de um argumento sumiu

O AutoMapper 15 acrescentou uma chave de licença e o registro em log do estado dessa licença, e esse log precisa de algum lugar para escrever. Em vez de recorrer a um logger estático ou a um destino ambiente, os mantenedores tornaram a dependência explícita: `MapperConfiguration` agora recebe o `ILoggerFactory` pelo qual vai escrever. Jimmy Bogard [confirmou na issue #4542](https://github.com/LuckyPennySoftware/AutoMapper/issues/4542) que essa é uma mudança incompatível intencional e que ela ficou de fora das notas de versão originais, o que explica por que tanta gente esbarra nisso sem ideia do que pesquisar.

Reflexão sobre os assemblies publicados deixa a diferença concreta. O AutoMapper 14.0.0 expõe:

```text
// AutoMapper 14.0.0
MapperConfiguration.ctor(MapperConfigurationExpression)
MapperConfiguration.ctor(Action`1)
```

O AutoMapper 15.1.3 e o 16.2.0 expõem ambos:

```text
// AutoMapper 15.1.3 and 16.2.0
MapperConfiguration.ctor(MapperConfigurationExpression, ILoggerFactory)
MapperConfiguration.ctor(Action`1, ILoggerFactory)
```

Não existe sobrecarga com um parâmetro `ILoggerFactory` com valor padrão, então não há como manter a chamada antiga compilando. Toda construção direta precisa ser tocada.

## Reprodução mínima

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3
using AutoMapper;

public record Source(int Id, string Name);
public record Dest(int Id, string Name);

public class Repro
{
    public void OldStyle()
    {
        // error CS1729
        var config = new MapperConfiguration(cfg => cfg.CreateMap<Source, Dest>());
        var mapper = config.CreateMapper();
    }
}
```

Um `csproj` com nada além de `<PackageReference Include="AutoMapper" Version="15.1.3" />` reproduz o problema. Repare que essa quebra é só em tempo de compilação. Nada no motor de mapeamento mudou, então assim que as chamadas compilarem, seus mapeamentos se comportam exatamente como na 14.

## O que eu passo como ILoggerFactory fora da injeção de dependência?

Para configurações estáticas do mapper, fixtures de teste e ferramentas de console onde não existe host, `NullLoggerFactory.Instance` de `Microsoft.Extensions.Logging.Abstractions` é a resposta certa. O AutoMapper já depende de `Microsoft.Extensions.Logging.Abstractions`, então não há pacote novo para adicionar.

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3
using AutoMapper;
using Microsoft.Extensions.Logging.Abstractions;

public static class Maps
{
    public static readonly MapperConfiguration Config = new(
        cfg =>
        {
            cfg.LicenseKey = "<your key>";
            cfg.AddProfile<MyProfile>();
        },
        NullLoggerFactory.Instance);

    public static readonly IMapper Mapper = Config.CreateMapper();
}
```

Um `MapperConfiguration` estático continua sendo um padrão suportado. Essa era a outra preocupação na issue #4542, e Bogard respondeu diretamente: uma instância estática está ok, e a chave de licença pode vir de `IConfiguration` ou de um cofre de segredos em vez de ficar cravada em um literal.

`AssertConfigurationIsValid()` continua pendurado no objeto de configuração exatamente como antes, então testes de validação não precisam de mudanças além do construtor:

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3
[Fact]
public void Mapping_configuration_is_valid()
{
    var config = new MapperConfiguration(
        cfg => cfg.AddProfile<MyProfile>(),
        NullLoggerFactory.Instance);

    config.AssertConfigurationIsValid();
}
```

Se você quiser os diagnósticos de licença visíveis em uma execução de testes, troque `NullLoggerFactory.Instance` por uma factory real. É a única coisa para a qual esse parâmetro serve.

## Como eu corrijo as chamadas a AddAutoMapper que quebraram junto?

Toda sobrecarga de `AddAutoMapper` sem ação de configuração foi apagada na 15.0. Comparando os membros estáticos públicos de `Microsoft.Extensions.DependencyInjection.ServiceCollectionExtensions` entre as versões, estas três desapareceram:

```text
// Present in AutoMapper 14.0.0, gone in 15.0.0 and later
AddAutoMapper(IServiceCollection, Assembly[])
AddAutoMapper(IServiceCollection, Type[])
AddAutoMapper(IServiceCollection, IEnumerable<Assembly>, ServiceLifetime)
```

Ou seja, a ação de configuração agora é obrigatória e vem sempre em segundo lugar:

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3, ASP.NET Core minimal host
var builder = WebApplication.CreateBuilder(args);

// Before (AutoMapper 14):
// builder.Services.AddAutoMapper(typeof(Program));

// After:
builder.Services.AddAutoMapper(
    cfg => cfg.LicenseKey = builder.Configuration["AutoMapper:LicenseKey"],
    typeof(Program));
```

Se a ação não tem nada a dizer, uma lambda vazia é válida: `services.AddAutoMapper(_ => { }, typeof(Program))`. Ela continua obrigatória por posição.

O caminho de injeção de dependência fornece o `ILoggerFactory` para você, então não há nenhum `MapperConfiguration` para construir na mão. Vale saber o que fica registrado, porque os tempos de vida são assimétricos:

```text
// Registered by AddAutoMapper, AutoMapper 15.1.3
AutoMapper.IConfigurationProvider -> Singleton
AutoMapper.IMapper               -> Transient
```

O objeto caro, a configuração compilada, é o singleton. `IMapper` é um invólucro transient barato em cima dela, e por isso injetar `IMapper` em serviços scoped e transient não custa nada e não cai no [problema da dependência cativa de um serviço scoped a partir de um singleton](/pt-br/2026/05/fix-cannot-consume-scoped-service-from-singleton/).

Existe também uma sobrecarga que entrega o `IServiceProvider`, útil quando a chave vive atrás de um serviço em vez de configuração crua:

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3
services.AddAutoMapper(
    (sp, cfg) => cfg.LicenseKey = sp.GetRequiredService<ILicenseStore>().AutoMapperKey,
    typeof(MyProfile));
```

## E se 'No service for type ILoggerFactory has been registered' aparecer logo em seguida?

Você corrige o construtor, o build fica verde, e um teste explode em tempo de execução:

```text
System.InvalidOperationException: No service for type 'Microsoft.Extensions.Logging.ILoggerFactory' has been registered.
```

Esse é o registro de injeção de dependência procurando a factory de logger que o AutoMapper agora precisa. Em uma aplicação ASP.NET Core você nunca vai ver isso, porque o `WebApplicationBuilder` configura o log antes de você ter chance de chamar `AddAutoMapper`. Você vê em testes unitários e em pequenas aplicações de console que montam um `ServiceCollection` pelado:

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3 - throws on resolve
var services = new ServiceCollection();
services.AddAutoMapper(cfg => cfg.CreateMap<Source, Dest>());
var mapper = services.BuildServiceProvider().GetRequiredService<IMapper>();
```

Uma linha resolve:

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3 - resolves
var services = new ServiceCollection();
services.AddLogging();                       // this is the missing piece
services.AddAutoMapper(cfg => cfg.CreateMap<Source, Dest>());
var mapper = services.BuildServiceProvider().GetRequiredService<IMapper>();
```

A mensagem de erro é genérica o bastante para as pessoas caçarem como se fosse outro bug, do mesmo jeito que [um registro faltante de DbContextOptions](/pt-br/2026/06/fix-no-service-for-type-dbcontextoptions-has-been-registered/) manda todo mundo procurar no arquivo errado. Se apareceu no mesmo commit que levou você para o AutoMapper 15, é isso.

## O que acontece de verdade se você nunca definir uma chave de licença

Nada quebra. O AutoMapper 15.1.3 mapeia objetos numa boa sem chave nenhuma, com uma chave inválida ou com string vazia. O que você recebe é uma mensagem de log, na categoria `LuckyPennySoftware.AutoMapper.License`:

```text
warn: LuckyPennySoftware.AutoMapper.License[0]
      You do not have a valid license key for the Lucky Penny software AutoMapper. This is allowed for
      development and testing scenarios. If you are running in production you are required to have a
      licensed version. Please visit https://luckypennysoftware.com to obtain a valid license.
```

Esse é todo o mecanismo de imposição, e é por isso que o parâmetro `ILoggerFactory` precisou existir. A documentação é explícita: não há outra imposição de licença além das mensagens de log. Isso é uma obrigação legal, não uma trava técnica, então trate o aviso como item de conformidade e não como um problema de execução para silenciar.

Um detalhe que custa uma tarde a muita gente: uma chave malformada é registrada em nível crítico antes do aviso, com uma falha de parse de JWT, porque a chave é um JWT assinado:

```text
crit: LuckyPennySoftware.AutoMapper.License[0]
      Error validating the Lucky Penny software license key
      Microsoft.IdentityModel.Tokens.SecurityTokenMalformedException: IDX14100: JWT is not well formed,
      there are no dots (.).
```

Se o seu pipeline de log dispara alerta em `Critical`, uma chave truncada ou com espaços tortos numa variável de ambiente vai acordar alguém enquanto a aplicação continua funcionando corretamente. Procure por essa string antes de assumir que o AutoMapper quebrou.

Mais duas notas práticas sobre a chave. Primeiro, `cfg.LicenseKey` não é o único caminho documentado: a documentação lista as variáveis de ambiente `AUTOMAPPER_LICENSE_KEY` e `LUCKYPENNY_LICENSE_KEY`, resolvidas nessa ordem depois do valor explícito em código. Nos meus testes na 15.1.3 nenhuma das duas variáveis de ambiente foi lida, já que um valor deliberadamente malformado em cada uma produziu apenas o aviso genérico de falta de licença e nunca o erro de parse de JWT que um `cfg.LicenseKey` explícito dispara. Na linha 15.x, defina a chave em código e leia de configuração. Segundo, o AutoMapper 16.2.0 não registrou mensagem alguma de licença no mesmo teste, então não leia a ausência de aviso como prova de que uma chave foi aceita.

## Vale fixar no AutoMapper 14 em vez disso?

Essa é a alternativa mais sugerida nas threads de issues, e desde 2026-03 é uma má ideia. O AutoMapper 14.0.0 e tudo abaixo da 15.1.1 carregam [GHSA-rvv3-g6hj-g44x](https://github.com/advisories/GHSA-rvv3-g6hj-g44x), um problema de recursão descontrolada de severidade alta (CVSS 7.5): mapear um grafo de objetos profundamente aninhado ou autorreferente esgota a pilha e derruba o processo com um `StackOverflowException` que não pode ser capturado. Se entrada não confiável chega a um tipo mapeado, isso é negação de serviço. Restaurar a 14.0.0 hoje produz isto em todo build:

```text
warning NU1903: Package 'AutoMapper' 14.0.0 has a known high severity vulnerability,
https://github.com/advisories/GHSA-rvv3-g6hj-g44x
```

A correção saiu na 15.1.1 e na 16.1.1, ambas lançadas em 2026-03. Ou seja, a escolha real é entre 15.1.3 e 16.2.0, não entre 15 e 14. As duas recebem o mesmo construtor, então o trabalho de migração descrito acima é idêntico de qualquer forma.

Se você prefere não pagar por um mapper de jeito nenhum, essa decisão é separada deste erro de compilação e merece ser tomada com calma, e não sob pressão de build. Os prós e contras estão detalhados no passo a passo de [migrar do AutoMapper para mapeamento gerado por código-fonte com Mapperly](/pt-br/2026/05/migrate-from-automapper-to-source-generated-mapping/), e a mesma questão de licença comercial já se desenrolou com outra biblioteca do Bogard em [MediatR vs classes de serviço simples](/pt-br/2026/05/mediatr-vs-plain-service-classes-in-2026/).

## O que muda de novo no AutoMapper 16

Nada que você precise tocar. O formato do construtor e as assinaturas de `AddAutoMapper` são idênticos entre 15.1.3 e 16.2.0, então código corrigido para a 15 compila na 16 sem mudanças. As diferenças estão no empacotamento:

- A 15.x tem como alvo `net8.0`, `net9.0` e `netstandard2.0`.
- A 16.x acrescenta `net10.0` e `net471`, e sobe suas dependências `Microsoft.Extensions.*` de 8.0.0 para 10.0.0.

Se você já está no .NET 10, a 16.2.0 evita puxar os pacotes de extensões 8.0.0 para o seu grafo. Se você está preso no .NET 8 com um conjunto de dependências transitivas travado, a 15.1.3 é um lugar suportado e corrigido para ficar. As duas estão além da correção de segurança, e a atualização em si é a mesma edição de três linhas nos dois casos: adicione a factory de logger, adicione a ação de configuração, decida onde a chave vai morar.

## Relacionados

- [Migrar do AutoMapper para mapeamento gerado por codigo-fonte com Mapperly](/pt-br/2026/05/migrate-from-automapper-to-source-generated-mapping/)
- [MediatR vs classes de serviço simples em 2026: a mudança de licença deveria te mover?](/pt-br/2026/05/mediatr-vs-plain-service-classes-in-2026/)
- [Corrigir: No service for type 'Microsoft.EntityFrameworkCore.DbContextOptions' has been registered](/pt-br/2026/06/fix-no-service-for-type-dbcontextoptions-has-been-registered/)
- [Correção: Cannot consume scoped service 'X' from singleton 'Y'](/pt-br/2026/05/fix-cannot-consume-scoped-service-from-singleton/)
- [Migrar do EF Core 6 para o EF Core 11: as mudanças incompatíveis que realmente doem](/pt-br/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)

## Fontes

- [Guia de atualização do AutoMapper 15.0](https://docs.automapper.io/en/stable/15.0-Upgrade-Guide.html)
- [Notas de versão do AutoMapper v15.0.0](https://github.com/LuckyPennySoftware/AutoMapper/releases/tag/v15.0.0)
- [Issue #4542: MapperConfiguration single argument constructor](https://github.com/LuckyPennySoftware/AutoMapper/issues/4542)
- [Documentação de configuração de licença do AutoMapper](https://docs.automapper.io/en/stable/License-configuration.html)
- [Documentação de injeção de dependência do AutoMapper](https://docs.automapper.io/en/stable/Dependency-injection.html)
- [GHSA-rvv3-g6hj-g44x: recursão descontrolada no AutoMapper](https://github.com/advisories/GHSA-rvv3-g6hj-g44x)
