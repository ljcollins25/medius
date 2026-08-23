
using Avalonia;
using Avalonia.Controls;
using Avalonia.Interactivity;
using Medius.Core;
using Medius.ViewModels;

namespace Medius.Views;

public partial class MainView : UserControl
{
    public MainView()
    {
        InitializeComponent();
    }

    private void OnItemClicked(object? sender, RoutedEventArgs eventArgs)
    {
        if (sender is not Button button || DataContext is not MainViewModel viewModel)
        {
            return;
        }

        var item = button.Tag as MediaItem
            ?? button.DataContext as MediaItem
            ?? (button.Content as StyledElement)?.DataContext as MediaItem;
        if (item is null)
        {
            viewModel.Status = "Unable to resolve the selected explorer item.";
            return;
        }

        viewModel.Status = $"Opening {item.Name}…";
        viewModel.SelectedItem = item;
        viewModel.OpenCommand.Execute(null);
        eventArgs.Handled = true;
    }
}