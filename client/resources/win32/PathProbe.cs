// Test-only literal metadata probe. Never compiled into the production helper.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class PathProbe
{
    [StructLayout(LayoutKind.Sequential)] struct NativeTime { internal uint Low, High; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)] struct FindA {
        internal uint Attributes; internal NativeTime Creation, Access, Write;
        internal uint SizeHigh, SizeLow, Reserved0, Reserved1;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] internal string Name;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] internal string Alternate;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct FindW {
        internal uint Attributes; internal NativeTime Creation, Access, Write;
        internal uint SizeHigh, SizeLow, Reserved0, Reserved1;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] internal string Name;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] internal string Alternate;
    }
    [DllImport("kernel32.dll", ExactSpelling = true)] static extern void SetLastError(uint error);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, ExactSpelling = true, SetLastError = true, BestFitMapping = false, ThrowOnUnmappableChar = true)]
    static extern uint SearchPathA(string search, string file, string extension, uint size, StringBuilder output, out IntPtr part);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    static extern uint SearchPathW(string search, string file, string extension, uint size, StringBuilder output, out IntPtr part);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, ExactSpelling = true, SetLastError = true, BestFitMapping = false, ThrowOnUnmappableChar = true)]
    static extern IntPtr FindFirstFileA(string path, out FindA data);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    static extern IntPtr FindFirstFileW(string path, out FindW data);
    [DllImport("kernel32.dll", ExactSpelling = true)] static extern bool FindClose(IntPtr find);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    static extern uint GetFileAttributesW(string path);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", ExactSpelling = true)] static extern bool CloseHandle(IntPtr handle);

    internal static int Run(string executable)
    {
        string full = Path.GetFullPath(executable);
        if (!SandboxFileSystem.IsLocalDosPath(full) || !String.Equals(full, typeof(PathProbe).Assembly.Location, StringComparison.OrdinalIgnoreCase)
            || full.Length > 4095 || full.IndexOfAny(new char[] { '*', '?', '\0' }) >= 0)
            throw new ArgumentException("Invalid fixed fixture executable");
        foreach (char character in full)
            if (character < 32 || character > 126) throw new ArgumentException("Fixture path must be ASCII");
        List<string> prefixes = Prefixes(full);
        for (int index = 0; index < prefixes.Count; index++) {
            Search(index, prefixes[index], false); Search(index, prefixes[index], true);
            Find(index, prefixes[index], false); Find(index, prefixes[index], true);
            Attributes(index, prefixes[index]); OpenAttributes(index, prefixes[index]);
        }
        return 0;
    }
    static List<string> Prefixes(string path)
    {
        List<string> result = new List<string>(); result.Add(path.Substring(0, 3));
        for (int index = 3; index < path.Length; index++)
            if (path[index] == '\\') result.Add(path.Substring(0, index));
        result.Add(path);
        if (result.Count > 32) throw new ArgumentException("Too many fixed prefixes");
        return result;
    }
    static void Emit(int index, string api, bool success, int code)
    {
        Console.WriteLine("{\"prefix\":" + index.ToString(CultureInfo.InvariantCulture) + ",\"api\":\"" + api
            + "\",\"ok\":" + (success ? "true" : "false") + ",\"code\":" + unchecked((uint)code).ToString(CultureInfo.InvariantCulture)
            + ",\"errorDefined\":" + (success ? "false" : "true") + "}");
    }
    static void Search(int index, string path, bool wide)
    {
        StringBuilder output = new StringBuilder(4096); IntPtr part;
        SetLastError(0);
        uint length = wide ? SearchPathW(null, path, null, 4096, output, out part) : SearchPathA(null, path, null, 4096, output, out part);
        int code = Marshal.GetLastWin32Error();
        Emit(index, wide ? "SearchPathW" : "SearchPathA", length > 0 && length < 4096, code);
    }
    static void Find(int index, string path, bool wide)
    {
        FindA narrow; FindW unicode;
        SetLastError(0);
        IntPtr handle = wide ? FindFirstFileW(path, out unicode) : FindFirstFileA(path, out narrow);
        int code = Marshal.GetLastWin32Error();
        bool success = handle != new IntPtr(-1);
        if (success) FindClose(handle);
        // No FindNextFile and no name/alternate-name output, even on successful ancestor queries.
        Emit(index, wide ? "FindFirstFileW" : "FindFirstFileA", success, code);
    }
    static void Attributes(int index, string path)
    {
        SetLastError(0);
        uint attributes = GetFileAttributesW(path);
        int code = Marshal.GetLastWin32Error();
        Emit(index, "GetFileAttributesW", attributes != UInt32.MaxValue, code);
    }
    static void OpenAttributes(int index, string path)
    {
        SetLastError(0);
        // READ_ATTRIBUTES only, share R/W/delete, OPEN_EXISTING, BACKUP_SEMANTICS + OPEN_REPARSE_POINT.
        IntPtr handle = CreateFileW(path, 0x80, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        int code = Marshal.GetLastWin32Error();
        bool success = handle != new IntPtr(-1);
        if (success) CloseHandle(handle);
        Emit(index, "CreateFileW.Attributes", success, code);
    }
}
