
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
        if (sender is not StyledElement { DataContext: MediaItem item }
            || DataContext is not MainViewModel viewModel)
        {
            return;
        }

        if (!viewModel.OpenCommand.CanExecute(null))
        {
            return;
        }

        viewModel.SelectedItem = item;
        viewModel.OpenCommand.Execute(null);
        eventArgs.Handled = true;
    }
}