---
title: "Azure Functions vs WebJobs – Which to choose"
description: "Compare Azure Functions and WebJobs: key differences in scaling, pricing, triggers, and when to choose one over the other."
pubDate: 2020-11-18
updatedDate: 2021-02-19
tags:
  - "azure"
  - "azure-functions"
---
Both are code-first technologies targeting developers ([as opposed to design-first workflow services](/2020/11/which-to-choose-logic-apps-vs-microsoft-power-automate/)). They enable the orchestration and integration of different business applications into a single workflow and provide more control over the performance of your workflow plus the ability to write custom code as part of the business process.

## Azure WebJobs

WebJobs are a part of the Azure App Service that you can use to run a program or script automatically. There are two kinds of WebJob:

-   **Continuous.** They execute in a continuous loop. For example, you could use a continuous WebJob to check a shared folder for a new photo.
-   **Triggered.** Can be executed manually or on a schedule.

For determining the actions of your WebJob, you can write code in several different languages. For example, you can script the WebJob by writing code in a Shell Script (Windows, PowerShell, Bash). Alternatively, you can write a program in PHP, Python, Node.js, JavaScript or .NET and any of the languages supported by the framework.

## Azure Functions

An Azure Function is in many ways similar to a WebJob, the main difference between them being that you don't need to worry about the infrastructure at all.

It is ideal for running small pieces of code in the cloud. Azure will automatically scale your function in response to demand, and with the consumption plan, you only pay for the time your code takes to run.

They can run on a series of different triggers like for example:

-   **HTTPTrigger**. Executes in response to a request sent through the HTTP protocol.
-   **TimerTrigger**. Enables execution according to a schedule.
-   **BlobTrigger**. When a new blob is added to an Azure Storage account.
-   **CosmosDBTrigger**. In response to new or updated documents in a NoSQL database.

## Differences

| Feature | Azure WebJobs | Azure Functions |
| --- | --- | --- |
| Automatic scaling | No | Yes |
| Development and testing in a browser | No | Yes |
| Pay-per-use pricing | No | Yes |
| Integration with Logic Apps | No | Yes |
| Package managers | NuGet if you are using the WebJobs SDK | NuGet and NPM |
| Can be part of an App Service application | Yes | No |
| Provides close control of `JobHost` | Yes | No |

## Conclusions

Azure Functions are in general more flexible and easier to administrate. However, WebJobs are a better solution when:

-   You want the code to be a part of an existing App Service application and to be managed as part of that application, for example in the same Azure DevOps environment.
-   You need close control over the object that listens for events that trigger the code.
