---
title: "Marten 9.55 corrige la I turca en los nombres de tablas de documentos: renómbralas antes de actualizar"
description: "Marten 9.55.0 convierte a minúsculas los alias de documentos, las claves de plantillas DDL y los nombres de las funciones upsert de tablas planas con la cultura invariante. Las aplicaciones que se ejecutan bajo tr-TR o az-AZ y guardan documentos en tablas como mt_doc_ınvoice deben renombrarlas primero, o sus datos parecerán desaparecer."
pubDate: 2026-10-30
tags:
  - "marten"
  - "postgresql"
  - "dotnet"
  - "globalization"
  - "breaking-changes"
lang: "es"
translationOf: "2026/10/marten-9-55-fixes-the-turkish-i-in-document-table-names"
translatedBy: "claude"
translationDate: 2026-10-30
---

[Marten 9.55.0](https://github.com/JasperFx/marten/releases/tag/V9.55.0) se publicó el 28 de octubre de 2026, y sus notas de versión comienzan con una sección "léelo antes de actualizar" que solo afecta a algunas aplicaciones, pero que les afecta mucho. Si tu proceso se ejecuta bajo una cultura turca (`tr-TR`) o azerbaiyana (`az-AZ`) y tienes un tipo de documento con una `I` mayúscula en su nombre, la tabla que Marten busca ha cambiado.

## De dónde salió la ı sin punto

Marten deriva el alias de un documento, y por lo tanto el nombre de su tabla, a partir del nombre del tipo. Hasta la 9.55 lo hacía con `string.ToLower()`, que usa la cultura actual. En las culturas turcas la forma minúscula de `I` es la `ı` sin punto (U+0131), no `i`:

```csharp
using System.Globalization;

var tr = CultureInfo.GetCultureInfo("tr-TR");

Console.WriteLine("Invoice".ToLower(tr));        // ınvoice
Console.WriteLine("Invoice".ToLowerInvariant()); // invoice
```

Así, un tipo de documento `Invoice` vivía en `mt_doc_ınvoice` en un servidor turco y en `mt_doc_invoice` en todos los demás. El [PR #5778](https://github.com/JasperFx/marten/pull/5778) cambia `DocumentMapping` a `ToLowerInvariant()`. A partir de la 9.55.0, el mismo tipo se asigna a `mt_doc_invoice` sin importar la cultura, y Marten creará felizmente esa tabla vacía junto a la anterior.

## Dos identificadores más en la misma versión

El [PR #5783](https://github.com/JasperFx/marten/pull/5783) corrigió otros dos lugares que convertían a minúsculas con la cultura actual:

- **Búsquedas de `DdlTemplate`.** Weasel indexa las plantillas por nombre de archivo en minúsculas invariantes, y la caché de plantillas crea una entrada vacía para cualquier clave inexistente. Bajo `tr-TR`, `DdlTemplate("Invoicing")` buscaba `ınvoicing`, obtenía una plantilla vacía y no escribía ninguna sentencia `GRANT` sin avisar. Es una corrección de errores pura, no hay nada que migrar.
- **Funciones upsert de proyecciones de tablas planas.** `mt_upsert_{table}_{event}` solía resultar en `mt_upsert_ınvoices_ınvoiceıssued`. Tras actualizar, la siguiente migración crea una función con el nombre correcto y deja la anterior sin usar. No se mueven datos, así que puedes eliminarla a mano.

## Renombrar las tablas

Hazlo antes de que la compilación 9.55 toque la base de datos. Este bloque DO renombra toda tabla de documentos de Marten que contenga una `ı` sin punto:

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

Las notas de versión también piden renombrar las funciones upsert correspondientes. Como alternativa, elimina las funciones `mt_upsert_`, `mt_insert_`, `mt_update_` y `mt_overwrite_` antiguas cuyos nombres contengan `ı` y deja que Marten las regenere; `SELECT proname FROM pg_proc WHERE proname LIKE '%ı%'` las lista. Luego ejecuta `await store.Storage.ApplyAllConfiguredChangesToDatabaseAsync()` primero contra una copia y revisa la diferencia generada. Cualquier nombre de índice o restricción que aún conserve la grafía antigua aparecerá ahí.

Si tus aplicaciones establecen `<InvariantGlobalization>true</InvariantGlobalization>` o se ejecutan con una cultura inglesa, los nombres que generan no cambian y no hay nada que hacer.

## Una nota de versión más para todos los demás

`StoredDocument.Version` para los documentos de proyección que usan `UseVersionFromMatchingStream` ahora es `<mt_version>:<epoch microseconds>` en lugar del simple `mt_version` ([#5773](https://github.com/JasperFx/marten/issues/5773)), por lo que el código que lo analizaba como entero dejará de funcionar. La versión también corrige que la generación de ids HiLo siguiera rota tras una caída de la base de datos en un store nuevo.

Una advertencia que señala el PR: `ToTableAlias` de JasperFx, que alimenta los nombres de tipos de evento en `mt_events.type`, sigue siendo sensible a la cultura. Cambiarlo dejaría huérfanas las filas de eventos existentes bajo `tr-TR`, así que se sigue por separado. Si ejecutas Marten en un servidor turco, mantente atento a ese seguimiento.

```bash
dotnet add package Marten --version 9.55.0
```
