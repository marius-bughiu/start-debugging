---
title: "Transparent TextBox for Windows Phone"
description: "Below you have a style which applied to your textbox will make it fully transparent. The difference between applying this style and simply setting the Background property of your textbox to transparent or removing it completely is that the style also removes the focus effect the textbox gets when tapped. I mean no matter what…"
pubDate: 2012-01-02
updatedDate: 2023-11-04
tags:
  - "windows-phone"
---
Below you have a style which applied to your textbox will make it fully transparent. The difference between applying this style and simply setting the `Background` property of your textbox to transparent or removing it completely is that the style also removes the focus effect the textbox gets when tapped. I mean no matter what background color you set when the textbox gets focused the background turns white.

So here’s the style (you need to add this to your app/page/user control resources):

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

Now that you’ve got the style, all you need to do is apply it to your textbox like so:

```xml
<TextBox Style="{StaticResource TransparentTextBoxStyle}"/>
```

And that’s all. Your textbox should be 100% transparent now. Also, in case you want to try it out before using it I’ve made a sample project you can download [here](https://www.dropbox.com/s/mees8r22uug23sn/TransparentTextboxSample.zip?dl=0).
