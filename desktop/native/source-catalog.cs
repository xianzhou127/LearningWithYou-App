// Read-only Windows metadata. No capture, audio, window activation, or commands.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

class SourceCatalog {
  delegate bool WindowCallback(IntPtr hwnd, IntPtr data);
  delegate bool MonitorCallback(IntPtr monitor, IntPtr dc, IntPtr rect, IntPtr data);
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct DisplayDevice {
    public int cb;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string name;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)] public string label;
    public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)] public string id;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)] public string key;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct MonitorInfo {
    public int cb; public Rect monitor, work; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string device;
  }
  [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback, IntPtr data);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint command);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder title, int count);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int count);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool EnumDisplayDevices(string device, uint index, ref DisplayDevice output, uint flags);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr rect, MonitorCallback callback, IntPtr data);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);

  static void Main() {
    // Match physical monitor coordinates regardless of the user's display scaling.
    SetProcessDpiAwarenessContext(new IntPtr(-4));
    var windows = new List<object>(); var monitors = new List<object>();
    var devices = new Dictionary<string,uint>(StringComparer.OrdinalIgnoreCase);
    for (uint index=0; index<256; index++) {
      var device = new DisplayDevice(); device.cb=Marshal.SizeOf(device);
      if (!EnumDisplayDevices(null,index,ref device,0)) break;
      if ((device.flags&1)!=0) devices[device.name]=index;
    }
    if (!EnumDisplayMonitors(IntPtr.Zero,IntPtr.Zero,(monitor,dc,rect,data)=>{
      var info=new MonitorInfo(); info.cb=Marshal.SizeOf(info); uint index;
      if (GetMonitorInfo(monitor,ref info) && devices.TryGetValue(info.device,out index))
        monitors.Add(new { id="screen:"+index+":0", device=info.device, primary=(info.flags&1)!=0,
          x=info.monitor.left,y=info.monitor.top,width=info.monitor.right-info.monitor.left,height=info.monitor.bottom-info.monitor.top });
      return true;
    },IntPtr.Zero)) throw new InvalidOperationException("Monitor enumeration failed");
    if (!EnumWindows((hwnd,data)=>{
      if (!IsWindowVisible(hwnd)) return true;
      int style=GetWindowLong(hwnd,-20), cloaked;
      if ((style&0x80)!=0 || (GetWindow(hwnd,4)!=IntPtr.Zero && (style&0x40000)==0)) return true;
      if (DwmGetWindowAttribute(hwnd,14,out cloaked,4)==0 && cloaked!=0) return true;
      var title=new StringBuilder(512); GetWindowText(hwnd,title,512); if (title.Length==0) return true;
      var className=new StringBuilder(128); GetClassName(hwnd,className,128);
      if (className.ToString()=="Progman" || className.ToString()=="WorkerW") return true;
      uint pid; GetWindowThreadProcessId(hwnd,out pid); string processName="";
      try { using(var process=Process.GetProcessById((int)pid)) processName=process.ProcessName; } catch (ArgumentException) { return true; } catch (System.ComponentModel.Win32Exception) { }
      windows.Add(new { id="window:"+hwnd.ToInt64()+":0",name=title.ToString(),pid,processName,minimized=IsIconic(hwnd) });
      return true;
    },IntPtr.Zero)) throw new InvalidOperationException("Window enumeration failed");
    Console.OutputEncoding=new UTF8Encoding(false);
    Console.Write(new JavaScriptSerializer().Serialize(new { windows,monitors }));
  }
}
