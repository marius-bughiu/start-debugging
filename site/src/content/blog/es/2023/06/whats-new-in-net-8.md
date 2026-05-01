---
title: "Novedades de .NET 8"
description: ".NET 8 fue lanzado el 14 de noviembre de 2023 como versión LTS (Long Term Support), lo que significa que seguirá recibiendo soporte, actualizaciones y correcciones de errores durante al menos tres años desde su lanzamiento. Como es habitual, .NET 8 trae soporte para una nueva versión del lenguaje C#, en este caso C# 12."
pubDate: 2023-06-10
updatedDate: 2023-11-15
tags:
  - "dotnet"
  - "dotnet-8"
lang: "es"
translationOf: "2023/06/whats-new-in-net-8"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 fue lanzado el **14 de noviembre de 2023** como versión LTS (Long Term Support), lo que significa que seguirá recibiendo soporte, actualizaciones y correcciones de errores durante al menos tres años desde su lanzamiento.

Como es habitual, .NET 8 trae soporte para una nueva versión del lenguaje C#, en este caso C# 12. Consulta nuestra página dedicada que cubre [novedades de C# 12](/2023/06/whats-new-in-c-12/).

Veamos la lista de cambios y nuevas funcionalidades de .NET 8:

-   [.NET Aspire (preview)](/es/2023/11/what-is-net-aspire/)
    -   [Requisitos previos](/es/2023/11/how-to-install-net-aspire/)
    -   [Cómo empezar](/es/2023/11/getting-started-with-net-aspire/)
-   Cambios en el SDK de .NET
    -   [Comando 'dotnet workload clean'](/es/2023/09/dotnet-workload-clean/)
    -   Recursos de 'dotnet publish' y 'dotnet pack'
-   Serialización
    -   [Políticas de nombres JSON snake\_case y kebab-case](/es/2023/08/net-8-json-serialize-property-names-using-snake-case-and-kebab-case/)
    -   [Manejar miembros faltantes durante la serialización](/es/2023/09/net-8-handle-missing-members-during-json-deserialization/)
    -   [Deserializar en propiedades de solo lectura](/es/2023/09/net-8-deserialize-into-read-only-properties/)
    -   [Incluir propiedades no públicas en la serialización](/es/2023/09/net-8-include-non-public-members-in-json-serialization/)
    -   [Añadir modificadores a instancias existentes de IJsonTypeInfoResolver](/es/2023/10/system-text-json-how-to-modify-existing-type-info-resolver/)
    -   Deserialización en streaming: [de JSON a AsyncEnumerable](/es/2023/10/httpclient-get-json-as-asyncenumerable/)
    -   JsonNode: [clonación profunda, copia profunda](/es/2023/10/deep-cloning-and-deep-equality-of-a-jsonnode/) y [otras actualizaciones de API](/es/2023/10/jsonnode-net-8-api-updates/)
    -   [Desactivar la serialización predeterminada basada en reflexión](/es/2023/10/system-text-json-disable-reflection-based-serialization/)
    -   [Añadir/eliminar TypeInfoResolver en instancias existentes de JsonSerializerOptions](/es/2023/10/add-remove-typeinforesolver-to-existing-jsonserializeroptions/)
-   Bibliotecas principales de .NET
    -   [FrozenDictionary -- comparación de rendimiento](/es/2023/08/net-8-performance-dictionary-vs-frozendictionary/)
    -   Métodos para trabajar con aleatoriedad -- [GetItems<T>()](/es/2023/11/c-randomly-choose-items-from-a-list/) y [Shuffle<T>()](/es/2023/10/c-how-to-shuffle-an-array/)
-   Bibliotecas de extensión
-   Recolección de basura
-   Source generator para enlace de configuración
-   Mejoras en reflexión
    -   No más reflexión: te presentamos [UnsafeAccessorAttribute](/es/2023/10/unsafe-accessor/) (consulta los [benchmarks de rendimiento](/es/2023/11/net-8-performance-unsafeaccessor-vs-reflection/))
    -   [Actualizar campos `readonly`](/2023/06/whats-new-in-net-8/)
-   Soporte para Native AOT
-   Mejoras de rendimiento
-   Imágenes de contenedor de .NET
-   .NET en Linux
-   Windows Presentation Foundation (WPF)
    -   [Aceleración por hardware en RDP](/es/2023/10/wpf-hardware-acceleration-in-rdp/)
    -   [Diálogo Open Folder](/es/2023/10/wpf-open-folder-dialog/)
        -   Opciones adicionales del diálogo ([ClientGuid](/es/2023/10/wpf-individual-dialog-states-using-clientguid/), [RootDirectory](/es/2023/10/wpf-limit-openfiledialog-folder-tree-to-a-certain-folder/), [AddToRecent](/es/2023/10/wpf-prevent-file-dialog-selection-from-being-added-to-recents/) y CreateTestFile)
-   NuGet
