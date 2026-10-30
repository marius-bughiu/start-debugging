---
title: "Marten 9.55 corrige o I turco nos nomes de tabelas de documentos: renomeie antes de atualizar"
description: "O Marten 9.55.0 converte para minúsculas os aliases de documentos, as chaves de template DDL e os nomes das funções de upsert de tabelas planas usando a cultura invariante. Apps que rodam com tr-TR ou az-AZ e guardam documentos em tabelas como mt_doc_ınvoice precisam renomeá-las antes, ou seus dados parecerão ter sumido."
pubDate: 2026-10-30
tags:
  - "marten"
  - "postgresql"
  - "dotnet"
  - "globalization"
  - "breaking-changes"
lang: "pt-br"
translationOf: "2026/10/marten-9-55-fixes-the-turkish-i-in-document-table-names"
translatedBy: "claude"
translationDate: 2026-10-30
---

O [Marten 9.55.0](https://github.com/JasperFx/marten/releases/tag/V9.55.0) foi lançado em 28 de outubro de 2026, e suas notas de versão começam com uma seção "leia antes de atualizar" que só importa para alguns apps, mas importa muito para eles. Se o seu processo roda com cultura turca (`tr-TR`) ou azerbaijana (`az-AZ`) e você tem um tipo de documento com um `I` maiúsculo no nome, a tabela que o Marten procura mudou.

## De onde veio o ı sem ponto

O Marten deriva o alias de um documento, e portanto o nome da tabela, a partir do nome do tipo. Até a 9.55 ele fazia isso com `string.ToLower()`, que usa a cultura atual. Nas culturas turcas, a forma minúscula de `I` é o `ı` sem ponto (U+0131), e não `i`:

```csharp
using System.Globalization;

var tr = CultureInfo.GetCultureInfo("tr-TR");

Console.WriteLine("Invoice".ToLower(tr));        // ınvoice
Console.WriteLine("Invoice".ToLowerInvariant()); // invoice
```

Assim, um tipo de documento `Invoice` ficava em `mt_doc_ınvoice` em um servidor turco e em `mt_doc_invoice` em todos os outros lugares. O [PR #5778](https://github.com/JasperFx/marten/pull/5778) troca `DocumentMapping` para `ToLowerInvariant()`. A partir da 9.55.0, o mesmo tipo é mapeado para `mt_doc_invoice` independentemente da cultura, e o Marten vai criar essa tabela vazia ao lado da antiga sem reclamar.

## Mais dois identificadores na mesma versão

O [PR #5783](https://github.com/JasperFx/marten/pull/5783) corrigiu mais dois lugares que usavam a cultura atual para converter em minúsculas:

- **Buscas de `DdlTemplate`.** O Weasel indexa os templates pelo nome do arquivo em minúsculas invariantes, e o cache de templates cria uma entrada vazia para qualquer chave ausente. Com `tr-TR`, `DdlTemplate("Invoicing")` procurava `ınvoicing`, obtinha um template vazio e não escrevia nenhum `GRANT`, sem avisar. Essa é só uma correção de bug, não há nada a migrar.
- **Funções de upsert de projeções de tabela plana.** `mt_upsert_{table}_{event}` costumava sair como `mt_upsert_ınvoices_ınvoiceıssued`. Depois da atualização, a próxima migração cria uma função com o nome correto e deixa a antiga para trás, sem uso. Nenhum dado é movido, então você pode removê-la manualmente.

## Renomeando as tabelas

Faça isso antes de o build 9.55 tocar no banco de dados. Este bloco DO renomeia toda tabela de documentos do Marten que contém um `ı` sem ponto:

```sql
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT schemaname, tablename
    FROM pg_tables
    WHERE tablename LIKE 'mt\_doc\_%' AND tablename LIKE '%ı%'
  LOOP
    EXECUTE format('ALTER TABLE %I.%I RENAME TO %I',
      r.schemaname, r.tablename, replace(r.tablename, 'ı', 'i'));
  END LOOP;
END $$;
```

As notas de versão também pedem que você renomeie as funções de upsert correspondentes. Como alternativa, remova as funções antigas `mt_upsert_`, `mt_insert_`, `mt_update_` e `mt_overwrite_` cujos nomes contêm `ı` e deixe o Marten regenerá-las; `SELECT proname FROM pg_proc WHERE proname LIKE '%ı%'` lista essas funções. Depois execute `await store.Storage.ApplyAllConfiguredChangesToDatabaseAsync()` primeiro em uma cópia e confira o diff gerado. Quaisquer nomes de índices ou constraints que ainda carreguem a grafia antiga aparecerão ali.

Se os seus apps definem `<InvariantGlobalization>true</InvariantGlobalization>` ou rodam com uma cultura inglesa, os nomes que eles geram não mudam e não há nada a fazer.

## Mais uma nota de versão para todos os outros

`StoredDocument.Version` para documentos de projeção que usam `UseVersionFromMatchingStream` agora é `<mt_version>:<epoch microseconds>` em vez do `mt_version` puro ([#5773](https://github.com/JasperFx/marten/issues/5773)), então o código que o interpretava como inteiro vai quebrar. A versão também corrige a geração de ids HiLo continuar quebrada após uma queda do banco de dados em um store novo.

Uma ressalva que o PR destaca: o `ToTableAlias` do JasperFx, que alimenta os nomes de tipos de evento em `mt_events.type`, continua sensível à cultura. Alterá-lo deixaria linhas de eventos existentes órfãs sob `tr-TR`, então isso é acompanhado separadamente. Se você roda o Marten em um servidor turco, fique de olho nesse acompanhamento.

```bash
dotnet add package Marten --version 9.55.0
```
