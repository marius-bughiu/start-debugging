---
title: "CV Shortlist: notas históricas sobre un SaaS de IA con .NET 10"
description: "Lo que anunció el autor de CV Shortlist, lo que describía su antiguo README y las ideas de diseño .NET que siguen siendo útiles sin el repositorio público."
pubDate: 2026-01-18
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-10"
lang: "es"
translationOf: "2026/01/cv-shortlist-an-ai-powered-net-10-saas-went-open-source-and-the-stack-is-worth-studying"
translatedBy: "claude"
translationDate: 2026-04-29
---

**Estado comprobado el 2 de noviembre de 2026:** el antiguo repositorio público `github.com/mihnea-radulescu/cvshortlist` devuelve 404, también mediante la API de GitHub. Eso no demuestra si se eliminó, se hizo privado o se trasladó. No se verificó un sustituto público. Esta es una nota histórica, no un recorrido por código actualmente ejecutable.

## Lo que anunció el autor

En el [anuncio original](https://www.reddit.com/r/csharp/comments/1qgbjo4/saas_educational_free_and_opensource_example_cv/), Mihnea Radulescu describió un SaaS comercial iniciado en noviembre de 2025, cerrado después y ofrecido como proyecto educativo con licencia MIT. Mencionó .NET 10, ASP.NET Core, Blazor Server, Azure Cloud y Azure AI Foundry. Su objetivo era preseleccionar candidaturas. Son descripciones del autor, no pruebas independientes de precisión o preparación para producción.

Una copia en caché del antiguo README describe extracción de PDF con Document Intelligence y comparación con ofertas de trabajo mediante un modelo de la familia GPT-5. Enumera EF Core 10, almacenamiento y bases de datos de Azure, y una opción autoalojada que aún requería recursos de IA de Azure; las instrucciones nombraban `gpt-5-mini`. Esto no verifica el código actual, la disponibilidad del modelo, los requisitos actuales ni resultados de tests. En esta revisión no se compiló ni auditó el repositorio inaccesible.

## Preguntas de diseño que siguen siendo útiles

Separar extracción documental y procesamiento con modelos es un diseño que merece evaluarse. La [documentación de layout de Document Intelligence](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/prebuilt/layout?view=doc-intel-4.0.0) describe extracción de texto, tablas y estructura. Prueba los resultados con tus documentos antes de enviarlos a un modelo. Extraer contenido y llamar a un LLM no demuestra por sí solo una arquitectura RAG.

Mantén la configuración fuera del código y valida los ajustes que realmente necesita tu aplicación. La recomendación histórica de user secrets y variables de entorno no constituye un diseño completo de seguridad para producción. La [guía de Secret Manager](https://learn.microsoft.com/en-us/aspnet/core/security/app-secrets?view=aspnetcore-10.0) aclara que user secrets son para desarrollo y no están cifrados. Las variables de entorno también necesitan controles de acceso. Se eliminó el bloque ilustrativo de `Program.cs`: no era código inspeccionado del repositorio, y sus propiedades C# `required` no aportaban validación de valores obligatorios en ejecución mediante `ValidateDataAnnotations()`.

Para un recorrido de aprendizaje disponible, consulta [Generative AI for Beginners .NET v2](/es/2026/03/generative-ai-beginners-dotnet-v2-dotnet10-meai/) y sus materiales sobre procesamiento documental e integración de modelos, en lugar de usar un proyecto inaccesible como plantilla de despliegue.

**Corrección del 2 de noviembre de 2026:** se separaron el anuncio y el README histórico del código actual verificado; se retiraron recomendaciones de implementación sin respaldo y el ejemplo de configuración no verificado.
