
using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Medius.Core;
using Medius.ViewModels;

namespace Medius.Views;

public partial class MainView : UserControl
{
    private DateTime _lastItemClick;
    private MediaItem? _lastClickedItem;
    private CancellationTokenSource? _longPressCancellation;
    private Control? _longPressControl;
    private Point _longPressStart;
    private bool _suppressNextItemClick;

    public MainView()
    {
        InitializeComponent();
        AddHandler(PointerPressedEvent, OnItemPointerPressed, RoutingStrategies.Tunnel, true);
        AddHandler(PointerReleasedEvent, OnItemPointerReleased, RoutingStrategies.Tunnel, true);
        AddHandler(PointerMovedEvent, OnItemPointerMoved, RoutingStrategies.Tunnel, true);
        AddHandler(PointerCaptureLostEvent, OnItemPointerCaptureLost, RoutingStrategies.Tunnel, true);
    }


    private void OnItemClicked(object? sender, RoutedEventArgs eventArgs)
    {
        if (ConsumeSuppressedClick(eventArgs))
        {
            return;
        }

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
        if (MediaTypes.IsSubtitle(item))
        {
            viewModel.OpenCommand.Execute(null);
            eventArgs.Handled = true;
            _lastClickedItem = null;
            return;
        }

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

    private void OnItemActionClicked(object? sender, RoutedEventArgs eventArgs)
    {
        if (ConsumeSuppressedClick(eventArgs))
        {
            return;
        }

        if (sender is not Button button || DataContext is not MainViewModel viewModel)
        {
            return;
        }

        var item = button.Tag as MediaItem
            ?? button.DataContext as MediaItem
            ?? (button.Content as StyledElement)?.DataContext as MediaItem;
        if (item is null)
        {
            return;
        }

        viewModel.SelectedItem = item;
        viewModel.OpenCommand.Execute(null);
        eventArgs.Handled = true;
        _lastClickedItem = null;
    }

    private void OnItemMenuClicked(object? sender, RoutedEventArgs eventArgs)
    {
        if (ConsumeSuppressedClick(eventArgs))
        {
            return;
        }

        if (sender is Control control)
        {
            OpenItemMenu(control);
            eventArgs.Handled = true;
        }
    }

    private void OnItemContextRequested(object? sender, ContextRequestedEventArgs eventArgs)
    {
        if (sender is Control control)
        {
            OpenItemMenu(control);
            eventArgs.Handled = true;
        }
    }

    private async void OnItemPointerPressed(object? sender, PointerPressedEventArgs eventArgs)
    {
        var control = FindItemControl(eventArgs.Source);
        if (control is null || eventArgs.Pointer.Type != PointerType.Touch)
        {
            return;
        }

        _longPressCancellation?.Cancel();
        _longPressCancellation?.Dispose();
        _longPressCancellation = new CancellationTokenSource();
        _longPressControl = control;
        _longPressStart = eventArgs.GetPosition(control);
        var cancellation = _longPressCancellation;
        try
        {
            await Task.Delay(650, cancellation.Token);
            if (ReferenceEquals(_longPressCancellation, cancellation))
            {
                _suppressNextItemClick = true;
                OpenItemMenu(control);
            }
        }
        catch (OperationCanceledException)
        {
        }
    }

    private void OnItemPointerMoved(object? sender, PointerEventArgs eventArgs)
    {
        if (_longPressControl is not { } control || eventArgs.Pointer.Type != PointerType.Touch)
        {
            return;
        }

        var position = eventArgs.GetPosition(control);
        if (Math.Abs(position.X - _longPressStart.X) > 12 || Math.Abs(position.Y - _longPressStart.Y) > 12)
        {
            CancelLongPress();
        }
    }

    private void OnItemPointerReleased(object? sender, PointerReleasedEventArgs eventArgs) => CancelLongPress();

    private void OnItemPointerCaptureLost(object? sender, PointerCaptureLostEventArgs eventArgs) => CancelLongPress();

    private void CancelLongPress()
    {
        _longPressCancellation?.Cancel();
        _longPressCancellation?.Dispose();
        _longPressCancellation = null;
        _longPressControl = null;
    }

    private static Control? FindItemControl(object? source)
    {
        for (var control = source as Control; control is not null; control = control.Parent as Control)
        {
            if (control.Tag is MediaItem)
            {
                return control;
            }
        }

        return null;
    }

    private bool ConsumeSuppressedClick(RoutedEventArgs eventArgs)
    {
        if (!_suppressNextItemClick)
        {
            return false;
        }

        _suppressNextItemClick = false;
        eventArgs.Handled = true;
        return true;
    }

    private void OpenItemMenu(Control control)
    {
        if (DataContext is not MainViewModel viewModel)
        {
            return;
        }
        var item = control.Tag as MediaItem
            ?? control.DataContext as MediaItem
            ?? ((control as ContentControl)?.Content as StyledElement)?.DataContext as MediaItem;
        if (item is null)
        {
            return;
        }

        viewModel.SelectedItem = item;
        var menuItems = new List<MenuItem>
        {
            new()
            {
                Header = item.IsDirectory ? "Open" : MediaTypes.IsVideo(item) ? "Play" : "Apply",
                Command = viewModel.OpenCommand
            }
        };
        if (MediaTypes.IsVideo(item))
        {
            menuItems.Add(new MenuItem { Header = "Add to selected playlist", Command = viewModel.AddSelectedToPlaylistCommand });
            menuItems.Add(new MenuItem { Header = "Keep offline", Command = viewModel.KeepSelectedOfflineCommand });
            menuItems.Add(new MenuItem { Header = "Remove offline copy", Command = viewModel.RemoveSelectedOfflineCommand });
            menuItems.Add(new MenuItem { Header = "Playlist & offline settings", Command = viewModel.TogglePlaylistPanelCommand });
        }

        var menu = new ContextMenu
        {
            ItemsSource = menuItems
        };
        menu.Open(control);
    }
}