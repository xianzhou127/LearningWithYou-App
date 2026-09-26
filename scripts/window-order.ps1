param([string[]]$WindowHandles)
$ErrorActionPreference = 'Stop'
if (!$WindowHandles.Count -or ($WindowHandles | Where-Object { $_ -notmatch '^\d+$' })) { throw 'Invalid window handles' }
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class WindowOrder {
 public delegate bool Visitor(IntPtr handle, IntPtr parameter);
 [DllImport("user32.dll")] static extern bool EnumWindows(Visitor visitor, IntPtr parameter);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
 [DllImport("user32.dll")] static extern bool IsIconic(IntPtr handle);
 public static string[] VisibleOrder() {
  var result = new List<string>();
  EnumWindows((handle, parameter) => { if (IsWindowVisible(handle) && !IsIconic(handle)) result.Add(handle.ToInt64().ToString()); return true; }, IntPtr.Zero);
  return result.ToArray();
 }
}
'@
@{ foreground=[WindowOrder]::GetForegroundWindow().ToInt64().ToString(); order=@([WindowOrder]::VisibleOrder() | Where-Object { $WindowHandles -contains $_ }) } | ConvertTo-Json -Compress
