---
title: "Azure Functions vs WebJobs: cuál elegir"
description: "Compara Azure Functions y WebJobs: diferencias clave en escalado, precios, triggers, y cuándo elegir uno u otro."
pubDate: 2020-11-18
updatedDate: 2021-02-19
tags:
  - "azure"
  - "azure-functions"
lang: "es"
translationOf: "2020/11/azure-functions-vs-webjobs-which-to-choose"
translatedBy: "claude"
translationDate: 2026-05-01
---
Ambos son tecnologías "code-first" dirigidas a desarrolladores ([a diferencia de los servicios de workflow design-first](/es/2020/11/which-to-choose-logic-apps-vs-microsoft-power-automate/)). Permiten orquestar e integrar distintas aplicaciones de negocio en un único flujo de trabajo y ofrecen mayor control sobre el rendimiento de tu workflow, además de la posibilidad de escribir código personalizado como parte del proceso de negocio.

## Azure WebJobs

Los WebJobs son parte del Azure App Service y se pueden usar para ejecutar un programa o script de forma automática. Hay dos tipos de WebJob:

-   **Continuous.** Se ejecutan en un bucle continuo. Por ejemplo, podrías usar un WebJob continuo para comprobar si hay una nueva foto en una carpeta compartida.
-   **Triggered.** Se pueden ejecutar manualmente o según un calendario.

Para determinar las acciones de tu WebJob puedes escribir código en distintos lenguajes. Por ejemplo, puedes scriptear el WebJob escribiendo código en Shell Script (Windows, PowerShell, Bash). Como alternativa, puedes escribir un programa en PHP, Python, Node.js, JavaScript o .NET, y cualquiera de los lenguajes soportados por el framework.

## Azure Functions

Una Azure Function es muy similar a un WebJob, siendo la principal diferencia que no necesitas preocuparte por la infraestructura en absoluto.

Es ideal para ejecutar pequeños fragmentos de código en la nube. Azure escalará tu función automáticamente según la demanda, y con el consumption plan solo pagas por el tiempo que tu código tarda en ejecutarse.

Pueden ejecutarse en respuesta a una serie de triggers, por ejemplo:

-   **HTTPTrigger**. Se ejecuta en respuesta a una solicitud enviada por el protocolo HTTP.
-   **TimerTrigger**. Permite la ejecución según un calendario.
-   **BlobTrigger**. Cuando se añade un nuevo blob a una cuenta de Azure Storage.
-   **CosmosDBTrigger**. En respuesta a documentos nuevos o actualizados en una base de datos NoSQL.

## Diferencias

| Característica | Azure WebJobs | Azure Functions |
| --- | --- | --- |
| Escalado automático | No | Sí |
| Desarrollo y pruebas en el navegador | No | Sí |
| Precios pay-per-use | No | Sí |
| Integración con Logic Apps | No | Sí |
| Gestores de paquetes | NuGet si usas el WebJobs SDK | NuGet y NPM |
| Puede formar parte de una aplicación App Service | Sí | No |
| Ofrece control estrecho de `JobHost` | Sí | No |

## Conclusiones

En general, Azure Functions es más flexible y más fácil de administrar. Sin embargo, los WebJobs son una mejor solución cuando:

-   Quieres que el código forme parte de una aplicación App Service existente y se gestione como parte de esa aplicación, por ejemplo en el mismo entorno de Azure DevOps.
-   Necesitas un control estrecho sobre el objeto que escucha los eventos que disparan el código.
