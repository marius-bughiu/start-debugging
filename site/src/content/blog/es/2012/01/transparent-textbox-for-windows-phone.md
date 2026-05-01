---
title: "TextBox transparente para Windows Phone"
description: "Un estilo XAML para Windows Phone que hace un TextBox totalmente transparente, eliminando también el efecto de fondo blanco al hacer focus."
pubDate: 2012-01-02
updatedDate: 2023-11-04
tags:
  - "windows-phone"
lang: "es"
translationOf: "2012/01/transparent-textbox-for-windows-phone"
translatedBy: "claude"
translationDate: 2026-05-01
---
Abajo tienes un estilo que, aplicado a tu textbox, lo hará totalmente transparente. La diferencia entre aplicar este estilo y simplemente poner la propiedad `Background` de tu textbox a transparente o quitarla por completo es que este estilo también elimina el efecto de focus que el textbox recibe al pulsarse. Da igual qué color de fondo pongas, cuando el textbox se enfoca el fondo se vuelve blanco.

Aquí tienes el estilo (debes añadirlo a los recursos de tu app/page/user control):

```xml
<ControlTemplate x:Key="PhoneDisabledTextBoxTemplate" TargetType="TextBox">
	<ContentControl x:Name="ContentElement" BorderThickness="0" HorizontalContentAlignment="Stretch" Margin="{StaticResource PhoneTextBoxInnerMargin}" Padding="{TemplateBinding Padding}" VerticalContentAlignment="Stretch"/>
</ControlTemplate>
<Style x:Key="TransparentTextBoxStyle" TargetType="TextBox">
	<Setter Property="FontFamily" Value="{StaticResource PhoneFontFamilyNormal}"/>
	<Setter Property="FontSize" Value="{StaticResource PhoneFontSizeMediumLarge}"/>
	<Setter Property="Background" Value="{StaticResource PhoneTextBoxBrush}"/>
	<Setter Property="Foreground" Value="{StaticResource PhoneTextBoxForegroundBrush}"/>
	<Setter Property="BorderBrush" Value="{StaticResource PhoneTextBoxBrush}"/>
	<Setter Property="SelectionBackground" Value="{StaticResource PhoneAccentBrush}"/>
	<Setter Property="SelectionForeground" Value="{StaticResource PhoneTextBoxSelectionForegroundBrush}"/>
	<Setter Property="BorderThickness" Value="{StaticResource PhoneBorderThickness}"/>
	<Setter Property="Padding" Value="2"/>
	<Setter Property="Template">
		<Setter.Value>
			<ControlTemplate TargetType="TextBox">
				<Grid Background="Transparent">
					<VisualStateManager.VisualStateGroups>
						<VisualStateGroup x:Name="CommonStates">
							<VisualState x:Name="Normal"/>
							<VisualState x:Name="MouseOver"/>
							<VisualState x:Name="Disabled">
								<Storyboard>
									<ObjectAnimationUsingKeyFrames Storyboard.TargetProperty="Visibility" Storyboard.TargetName="EnabledBorder">
										<DiscreteObjectKeyFrame KeyTime="0">
											<DiscreteObjectKeyFrame.Value>
												<Visibility>Collapsed</Visibility>
											</DiscreteObjectKeyFrame.Value>
										</DiscreteObjectKeyFrame>
									</ObjectAnimationUsingKeyFrames>
									<ObjectAnimationUsingKeyFrames Storyboard.TargetProperty="Visibility" Storyboard.TargetName="DisabledOrReadonlyBorder">
										<DiscreteObjectKeyFrame KeyTime="0">
											<DiscreteObjectKeyFrame.Value>
												<Visibility>Visible</Visibility>
											</DiscreteObjectKeyFrame.Value>
										</DiscreteObjectKeyFrame>
									</ObjectAnimationUsingKeyFrames>
								</Storyboard>
							</VisualState>
							<VisualState x:Name="ReadOnly">
								<Storyboard>
									<ObjectAnimationUsingKeyFrames Storyboard.TargetProperty="Visibility" Storyboard.TargetName="EnabledBorder">
										<DiscreteObjectKeyFrame KeyTime="0">
											<DiscreteObjectKeyFrame.Value>
												<Visibility>Collapsed</Visibility>
											</DiscreteObjectKeyFrame.Value>
										</DiscreteObjectKeyFrame>
									</ObjectAnimationUsingKeyFrames>
									<ObjectAnimationUsingKeyFrames Storyboard.TargetProperty="Visibility" Storyboard.TargetName="DisabledOrReadonlyBorder">
										<DiscreteObjectKeyFrame KeyTime="0">
											<DiscreteObjectKeyFrame.Value>
												<Visibility>Visible</Visibility>
											</DiscreteObjectKeyFrame.Value>
										</DiscreteObjectKeyFrame>
									</ObjectAnimationUsingKeyFrames>
									<ObjectAnimationUsingKeyFrames Storyboard.TargetProperty="Foreground" Storyboard.TargetName="DisabledOrReadonlyContent">
										<DiscreteObjectKeyFrame KeyTime="0" Value="{StaticResource PhoneTextBoxReadOnlyBrush}"/>
									</ObjectAnimationUsingKeyFrames>
								</Storyboard>
							</VisualState>
						</VisualStateGroup>
						<VisualStateGroup x:Name="FocusStates">
							<VisualState x:Name="Focused"/>
							<VisualState x:Name="Unfocused"/>
						</VisualStateGroup>
						<VisualStateGroup x:Name="ValidationStates">
							<VisualState x:Name="InvalidFocused"/>
							<VisualState x:Name="Valid"/>
							<VisualState x:Name="InvalidUnfocused"/>
						</VisualStateGroup>
					</VisualStateManager.VisualStateGroups>
					<Border x:Name="EnabledBorder" BorderThickness="{TemplateBinding BorderThickness}" Margin="{StaticResource PhoneTouchTargetOverhang}">
						<ContentControl x:Name="ContentElement" BorderThickness="0" HorizontalContentAlignment="Stretch" Margin="{StaticResource PhoneTextBoxInnerMargin}" Padding="{TemplateBinding Padding}" VerticalContentAlignment="Stretch"/>
					</Border>
					<Border x:Name="DisabledOrReadonlyBorder" BorderThickness="{TemplateBinding BorderThickness}" Margin="{StaticResource PhoneTouchTargetOverhang}" Visibility="Collapsed">
						<TextBox x:Name="DisabledOrReadonlyContent" Foreground="{StaticResource PhoneDisabledBrush}" FontWeight="{TemplateBinding FontWeight}" FontStyle="{TemplateBinding FontStyle}" FontSize="{TemplateBinding FontSize}" FontFamily="{TemplateBinding FontFamily}" IsReadOnly="True" SelectionForeground="{TemplateBinding SelectionForeground}" SelectionBackground="{TemplateBinding SelectionBackground}" TextAlignment="{TemplateBinding TextAlignment}" TextWrapping="{TemplateBinding TextWrapping}" Text="{TemplateBinding Text}" Template="{StaticResource PhoneDisabledTextBoxTemplate}"/>
					</Border>
				</Grid>
			</ControlTemplate>
		</Setter.Value>
	</Setter>
</Style>
```

Una vez que tienes el estilo, lo único que queda es aplicarlo a tu textbox así:

```xml
<TextBox Style="{StaticResource TransparentTextBoxStyle}"/>
```

Y eso es todo. Tu textbox debería ser 100% transparente ahora. Por si quieres probarlo antes de usarlo, hice un proyecto de muestra que puedes descargar [aquí](https://www.dropbox.com/s/mees8r22uug23sn/TransparentTextboxSample.zip?dl=0).
