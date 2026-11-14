using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Security.AccessControl;
using System.Security.Principal;

internal static partial class Sandbox
{
    internal sealed class Options {
        internal string Work, Executable, Runtime, Distribution;
        internal string[] Arguments;
    }
    internal sealed class CleanupFailure : Exception {
        internal readonly string Profile;
        internal CleanupFailure(string profile = null) : base("Sandbox setup cleanup is unconfirmed") { Profile = profile; }
    }
    internal static bool Within(string root, string path)
    {
        return path.Equals(root, StringComparison.OrdinalIgnoreCase) || path.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    }
    internal static string Canonical(string value, bool directory)
    {
        if (!SandboxFileSystem.IsLocalDosPath(value))
            throw new ArgumentException("Only local absolute DOS paths are allowed");
        string path = Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar);
        if (path.Length < 4 || (((SandboxFileSystem.Attributes(path) & 16) != 0) != directory))
            throw new ArgumentException("Sandbox path type is invalid or is a volume root");
        string current = path;
        while (!String.IsNullOrEmpty(current)) {
            if ((SandboxFileSystem.Attributes(current) & (uint)FileAttributes.ReparsePoint) != 0)
                throw new ArgumentException("Sandbox paths cannot traverse reparse points");
            current = Path.GetDirectoryName(current);
        }
        return path;
    }
    internal static void CheckTree(string path, ref int count, Action check)
    {
        if (check != null) check();
        if (++count > 300000) throw new IOException("Sandbox tree is too large");
        foreach (SandboxFileSystem.Entry entry in SandboxFileSystem.Entries(path)) {
            if ((count & 127) == 0 && check != null) check();
            if ((entry.Attributes & (uint)FileAttributes.ReparsePoint) != 0) throw new IOException("Sandbox tree contains a reparse point");
            if ((entry.Attributes & (uint)FileAttributes.Directory) != 0) CheckTree(entry.Path, ref count, check);
            else if (++count > 300000) throw new IOException("Sandbox tree is too large");
        }
    }
    internal sealed class Grant : IDisposable {
        readonly string path;
        readonly FileSystemAccessRule rule;
        internal bool CleanupError;
        internal Grant(string path, SecurityIdentifier sid, FileSystemRights rights, Action check = null) {
            this.path = path;
            int count = 0; CheckTree(path, ref count, check);
            rule = new FileSystemAccessRule(sid, rights, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                PropagationFlags.None, AccessControlType.Allow);
            DirectorySecurity security = SandboxFileSystem.ReadAccess(path);
            security.AddAccessRule(rule);
            try { SandboxFileSystem.WriteAccess(path, security); }
            catch { Dispose(); if (CleanupError) throw new CleanupFailure(); throw; }
        }
        public void Dispose() {
            try {
                DirectorySecurity security = SandboxFileSystem.ReadAccess(path);
                security.RemoveAccessRuleSpecific(rule);
                SandboxFileSystem.WriteAccess(path, security);
            } catch (Exception) { CleanupError = true; Diagnostic("Sandbox ACL cleanup failed"); }
        }
    }
    internal static void Diagnostic(string message)
    {
        try { Console.Error.WriteLine(message); }
        catch (IOException) { }
        catch (ObjectDisposedException) { }
    }
    internal static string FailureCode(Exception error)
    {
        Win32Exception native = error as Win32Exception;
        return "class=" + error.GetType().Name + ";hresult=0x" + error.HResult.ToString("X8")
            + ";win32=" + (native == null ? "none" : native.NativeErrorCode.ToString(System.Globalization.CultureInfo.InvariantCulture));
    }
    internal static void Check(bool result, string operation)
    {
        if (!result) throw new Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error(), operation);
    }
}
