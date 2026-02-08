---
title: "Which to choose: Logic Apps vs Microsoft Power Automate"
description: "Both are design-first technologies, meaning that they provide user interfaces allowing you to draw-out your workflows as opposed to coding them. Other similarities between the two: They both can accept inputs Can run actions Able to control the workflow using conditions Can produce outputs Logic Apps Logic Apps is a service provided by Azure which…"
pubDate: 2020-11-18
tags:
  - "azure"
  - "logic-apps"
  - "microsoft-power-automate"
---
Both are design-first technologies, meaning that they provide user interfaces allowing you to draw-out your workflows as opposed to coding them. Other similarities between the two:

-   They both can accept inputs
-   Can run actions
-   Able to control the workflow using conditions
-   Can produce outputs

## Logic Apps

Logic Apps is a service provided by Azure which you can use to automate, orchestrate, and integrate disparate components of a distributed application. Through Logic Apps, you can draw out complex workflows that model complex business processes.

Logic Apps also provide a code view which allow you to create and edit workflows using JSON notation.

They are ideal for integration projects as the service provides hundreds of different connectors for different apps and external services. Additionally you can easily create your own custom connectors as well.

## Microsoft Power Automate

Microsoft Power Automate is a service built on top of Logic Apps, targeted towards people with no development or IT Pro experience with a desire to create workflows. You can create complex workflows that integrate many different components by using the website or the Microsoft Power Automate mobile app.

There are four different types of workflows:

-   **Automated**: A flow that is started by a trigger. For example, the trigger could be the arrival of a new tweet or a new file being uploaded.
-   **Button**: A flow that can be triggered manually from the mobile application.
-   **Scheduled**: A flow that executes on a regular basis.
-   **Business process**: A flow that models a business process and can have: notification to required people; with their approval recorded; calendar dates for steps; and recorded time of flow steps.

In terms of connectors, Microsoft Power Apps has the exact same connectors as Logic Apps, including the ability to create and use custom connectors.

## Diferences

Microsoft Power Automate

Logic Apps

Intended users

Office workers and business analysts

Developers and IT pros

Intended scenarios

Self-service workflow creation

Advanced integration projects

Design tools

GUI only. Browser and mobile app

Browser and Visual Studio designer. Code editing is possible using JSON

Application Lifecycle Management

Power Automate includes testing and production environments

Logic Apps source code can be included in Azure DevOps and source code management systems

## Conclusions

The two services are very similar, the main difference being in their target audience, with Microsoft Power Automate being targeted towards non-technical staff and Logic Apps leaning more towards IT professionals, developers and DevOps practitioners.
