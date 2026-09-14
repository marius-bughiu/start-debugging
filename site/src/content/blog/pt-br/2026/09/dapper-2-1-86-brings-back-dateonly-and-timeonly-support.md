---
title: "Dapper 2.1.86 traz de volta DateOnly e TimeOnly, dois anos depois de removê-los"
description: "O Dapper 2.1.86 reativa o mapeamento nativo de DateOnly e TimeOnly para parâmetros, membros e escalares, com os bugs de deslocamento de coluna e de default(T) silencioso corrigidos. O que mudou, o que eu medi e o que isso significa para os seus type handlers personalizados."
pubDate: 2026-09-14
tags:
  - "dapper"
  - "dotnet"
  - "csharp"
lang: "pt-br"
translationOf: "2026/09/dapper-2-1-86-brings-back-dateonly-and-timeonly-support"
translatedBy: "claude"
translationDate: 2026-09-14
---

O Dapper 2.1.86 chegou ao NuGet em 2026-09-12, e o destaque é uma linha nas [notas de versão](https://github.com/DapperLib/Dapper/releases/tag/2.1.86): "Re-enable DateOnly/TimeOnly support, fixing the defects that got it disabled". Se você carrega um `SqlMapper.TypeHandler<DateOnly>` desde o .NET 6, esta é a versão que permite apagá-lo.

## Como o suporte a DateOnly foi lançado, quebrou e sumiu

O mapeamento nativo de `DateOnly`/`TimeOnly` chegou pela primeira vez na 2.1.37 via [#2051](https://github.com/DapperLib/Dapper/pull/2051) em março de 2024. Em poucas semanas, usuários da 2.1.44 esbarraram no [#2072](https://github.com/DapperLib/Dapper/issues/2072): uma coluna `datetime` mapeada para uma propriedade `DateOnly` falhava com `Error parsing column 1 (FromDate=Ed - String)`, o que parecia um erro de deslocamento por um, porque a mensagem reportava o valor da coluna errada. Em abril de 2024 o recurso foi removido da compilação ([#2080](https://github.com/DapperLib/Dapper/pull/2080)), e todas as versões da 2.1.66 até a 2.1.79 saíram sem ele.

O [PR #2228](https://github.com/DapperLib/Dapper/pull/2228) corrige as causas raiz, não os sintomas:

- Uma coluna cujo tipo reportado exige conversão (um `datetime` para `DateOnly`) não passa mais por `GetFieldValue<T>`. Esse era o crash do #2072.
- Os caminhos de membro, escalar e `Parse<T>` agora convertem `DateOnly`/`TimeOnly` de e para `DateTime`/`TimeSpan` nas duas direções. Isso importa porque os providers divergem: o Npgsql 10 faz boxing de uma coluna `date` como `DateOnly`, enquanto o SqlClient e o Npgsql 9 fazem boxing como `DateTime` ([#2226](https://github.com/DapperLib/Dapper/issues/2226)).
- `QuerySingle<DateOnly>` não retorna mais `default(T)` sem erro ([#2227](https://github.com/DapperLib/Dapper/issues/2227)).

## Antes e depois, medido

Rodei o mesmo app baseado em arquivo contra a 2.1.79 e a 2.1.86 no .NET SDK 10.0.302 com `Microsoft.Data.Sqlite` 10.0.12:

```csharp
#:package Dapper@2.1.86
#:package Microsoft.Data.Sqlite@10.0.12
#:property PublishAot=false
using Dapper;
using Microsoft.Data.Sqlite;

using var c = new SqliteConnection("Data Source=:memory:");
c.Open();

c.ExecuteScalar<string>("select @d", new { d = new DateOnly(2026, 9, 14) });
c.ExecuteScalar<string>("select @t", new { t = new TimeOnly(9, 30) });
c.QuerySingle<DateOnly>("select '2026-09-14'");
c.QuerySingle<Row>("select 'x' as Name, '2026-09-14' as Due");

public class Row { public string Name { get; set; } = ""; public DateOnly Due { get; set; } }
```

| Chamada | 2.1.79 | 2.1.86 |
| --- | --- | --- |
| Parâmetro `DateOnly` | `NotSupportedException`: não pode ser usado como valor de parâmetro | `2026-09-14` |
| Parâmetro `TimeOnly` | `NotSupportedException` | `09:30:00` |
| `QuerySingle<DateOnly>` | `0001-01-01`, sem erro | `2026-09-14` |
| Membro `DateOnly` | `DataException`: Error parsing column 1 | `2026-09-14` |

A linha do escalar é a que deve preocupar quem ainda está numa versão antiga: dado errado, nenhuma exceção.

## O que acontece com o seu type handler existente

A solução alternativa padrão era um `SqlMapper.TypeHandler<DateOnly>` registrado na inicialização. Com esse mesmo handler registrado na 2.1.86, meu teste mostrou o mapeamento nativo assumindo o controle para parâmetros e membros `DateOnly`: o `SetValue` e o `Parse` do handler nunca foram chamados. Só o caminho escalar `QuerySingle<DateOnly>` ainda chamou `Parse`. Na 2.1.79 o mesmo handler rodava nos três caminhos.

Se o seu handler só convertia entre `DateOnly` e `DateTime`, você não perde nada. Se ele fazia algo personalizado, como gravar datas como strings `yyyyMMdd` ou inteiros, agora ele é ignorado no caminho de parâmetros, e o banco de dados recebe o que quer que o provider faça com um `DateOnly` puro. Teste antes de atualizar.

## Escopo

O suporte é compilado para os targets `net8.0` e `net10.0` do pacote. Os builds `netstandard2.0` e `net461` não o têm, e a suíte de testes explicitamente não espera que funcione com o legado `System.Data.SqlClient`. Use `Microsoft.Data.SqlClient`.

A mesma versão também aposenta os feeds do MyGet e do AppVeyor: o Dapper agora publica apenas no nuget.org, via Trusted Publishing (OIDC). Se um `nuget.config` ainda aponta para o antigo feed do MyGet para builds de pré-lançamento, remova-o.
