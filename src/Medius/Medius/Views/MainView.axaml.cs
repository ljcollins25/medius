
using Avalonia;
using Avalonia.Controls;
using Avalonia.Interactivity;
using Medius.Core;
using Medius.ViewModels;

namespace Medius.Views;

public partial class MainView : UserControl
{
    private DateTime _lastItemClick;
    private MediaItem? _lastClickedItem;

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

        viewModel.SelectedItem = item;
        var now = DateTime.UtcNow;
        var isDoubleClick = Equals(item, _lastClickedItem)
            && now - _lastItemClick <= TimeSpan.FromMilliseconds(500);
        _lastClickedItem = item;
        _lastItemClick = now;
        if (!isDoubleClick)
        {
            return;
        }

        viewModel.Status = $"Opening {item.Name}…";
        viewModel.OpenCommand.Execute(null);
        eventArgs.Handled = true;
        _lastClickedItem = null;
    }
}