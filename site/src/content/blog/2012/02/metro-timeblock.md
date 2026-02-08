---
title: "Metro TimeBlock"
description: "Metro TimeBlock is a customizable time display control for Windows Phone that lets you set any color, background, and size."
pubDate: 2012-02-08
updatedDate: 2023-11-05
tags:
  - "metro"
  - "windows-phone"
---
Metro TimeBlock is a time display control that I’ve made which should allow you to display time in any color and with any background you want. Size is also adjustable and you can choose to display either the current time or a time of your own.

[![Metro TimeBlock](https://lh4.googleusercontent.com/--uwO3WD479Q/TzK6qBeZ-FI/AAAAAAAAAEM/JekVV927X8o/s640/metroTimeBlock.png)](https://lh4.googleusercontent.com/--uwO3WD479Q/TzK6qBeZ-FI/AAAAAAAAAEM/JekVV927X8o/s640/metroTimeBlock.png)

Properties of the control:

**Time** – takes in any DateTime object. The control will display the Time you provide within that DateTime object. Leave blank if you want to display the current time.

**Spacer –** this is the string to display between the hours and minutes and between the minutes and seconds. Use spacers like “:” or ” “.

**Size –** you can choose from **Small, Normal, Medium, MediumLarge, Large, ExtraLarge, ExtraExtraLarge** and **Huge**. I chose to do this instead of allowing FontSize because this way I can also control the way the background blocks look.

**Foreground** – tells the control what color to use to display the time.

**Fill –** sets the background color of the control (the square-like blocks).

That's about it. If you have any problems with it or need help, leave a comment below. You can download the code from [this link](https://www.dropbox.com/s/mjiba8cugtj8fdz/StartDebugging.zip?dl=0), it contains both the control and a couple of samples.
