using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;

// Internal IO representation only. External paths must first pass Sandbox.Canonical and root policy.
internal static class SandboxFileSystem
{
    [StructLayout(LayoutKind.Sequential)] struct NativeTime { internal uint Low, High; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct FindData {
        internal uint Attributes;
        internal NativeTime Creation, Access, Write;
        internal uint SizeHigh, SizeLow, Reserved0, Reserved1;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] internal string Name;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] internal string Alternate;
    }
    internal struct Entry { internal string Path; internal uint Attributes; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetFileAttributesW(string path);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr FindFirstFileW(string path, out FindData data);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool FindNextFileW(IntPtr find, out FindData data);
    [DllImport("kernel32.dll")] static extern bool FindClose(IntPtr find);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] static extern uint GetNamedSecurityInfoW(string path, int type, uint information,
        out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] static extern uint SetNamedSecurityInfoW(string path, int type, uint information,
        IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetSecurityDescriptorDacl(IntPtr descriptor,
        [MarshalAs(UnmanagedType.Bool)] out bool present, out IntPtr dacl, [MarshalAs(UnmanagedType.Bool)] out bool defaulted);

    internal static bool IsLocalDosPath(string path)
    {
        return path != null && path.Length >= 3 && ((path[0] >= 'A' && path[0] <= 'Z') || (path[0] >= 'a' && path[0] <= 'z'))
            && path[1] == ':' && (path[2] == '\\' || path[2] == '/') && path.IndexOf(':', 2) < 0 && path.IndexOf('\0') < 0;
    }
    static string IoPath(string path)
    {
        if (!IsLocalDosPath(path) || path.IndexOf('/') >= 0 || path.Length >= 32760)
            throw new ArgumentException("Invalid internal DOS path");
        string[] parts = path.Substring(3).Split('\\');
        foreach (string part in parts)
            if (part == "." || part == ".." || (part.Length == 0 && path.Length != 3))
                throw new ArgumentException("Internal path is not canonical");
        return new string('\\', 2) + "?" + '\\' + path;
    }
    internal static uint Attributes(string path)
    {
        uint attributes = GetFileAttributesW(IoPath(path));
        if (attributes == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error(), "Read sandbox filesystem metadata");
        return attributes;
    }
    internal static IEnumerable<Entry> Entries(string path)
    {
        FindData data;
        IntPtr find = FindFirstFileW(IoPath(path) + (path.EndsWith("\\") ? "*" : "\\*"), out data);
        if (find == new IntPtr(-1)) {
            int error = Marshal.GetLastWin32Error();
            if (error == 2) yield break;
            throw new Win32Exception(error, "Enumerate sandbox filesystem");
        }
        try {
            do {
                if (data.Name == "." || data.Name == "..") continue;
                if (String.IsNullOrEmpty(data.Name) || data.Name.IndexOfAny(new char[] { '\\', '/', ':', '\0' }) >= 0)
                    throw new ArgumentException("Invalid native directory entry");
                // Return a DOS child, never an externally reusable device/prefix path.
                yield return new Entry { Path = path.TrimEnd('\\') + '\\' + data.Name, Attributes = data.Attributes };
            } while (FindNextFileW(find, out data));
            int error = Marshal.GetLastWin32Error();
            if (error != 18) throw new Win32Exception(error, "Continue sandbox filesystem enumeration");
        } finally { FindClose(find); }
    }
    internal static DirectorySecurity ReadAccess(string path)
    {
        IntPtr owner, group, dacl, sacl, descriptor;
        uint error = GetNamedSecurityInfoW(IoPath(path), 1, 4, out owner, out group, out dacl, out sacl, out descriptor);
        if (error != 0) throw new Win32Exception(unchecked((int)error), "Read sandbox directory ACL");
        try {
            uint length = GetSecurityDescriptorLength(descriptor);
            if (length == 0 || length > 1024 * 1024) throw new InvalidOperationException("Invalid sandbox security descriptor");
            byte[] binary = new byte[checked((int)length)]; Marshal.Copy(descriptor, binary, 0, binary.Length);
            DirectorySecurity security = new DirectorySecurity();
            security.SetSecurityDescriptorBinaryForm(binary, AccessControlSections.Access);
            return security;
        } finally { LocalFree(descriptor); }
    }
    internal static void WriteAccess(string path, DirectorySecurity security)
    {
        byte[] binary = security.GetSecurityDescriptorBinaryForm();
        GCHandle pinned = GCHandle.Alloc(binary, GCHandleType.Pinned);
        try {
            bool present, defaulted; IntPtr dacl;
            if (!GetSecurityDescriptorDacl(pinned.AddrOfPinnedObject(), out present, out dacl, out defaulted) || !present || dacl == IntPtr.Zero)
                throw new InvalidOperationException("Sandbox ACL is absent");
            // DACL only: retain owner/group/SACL and existing DACL-protection state.
            uint error = SetNamedSecurityInfoW(IoPath(path), 1, 4, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
            if (error != 0) throw new Win32Exception(unchecked((int)error), "Write sandbox directory ACL");
        } finally { pinned.Free(); }
    }
}
