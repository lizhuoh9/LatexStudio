using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

internal static partial class Sandbox
{
    // Every compile token carries this named capability. The managed runtime root keeps one persistent,
    // inheritable read/execute ACE for it, so a session needs no per-session ACL propagation over the TeX tree.
    // Work directories still get per-session grants to the per-session AppContainer SID. The persistent ACE is
    // intentional state: a session's cleanup:true covers per-session grants/profile only, not this ACE.
    internal const string RuntimeCapabilityName = "paperStudioTexRuntime";
    internal const string RuntimeGrantMarker = "paperstudio-runtime-acl.txt";
    internal const uint SeGroupEnabled = 0x00000004;
    const FileSystemRights RuntimeRights = FileSystemRights.ReadAndExecute;
    const InheritanceFlags RuntimeInheritance = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;

    internal static SecurityIdentifier RuntimeCapability()
    {
        IntPtr groups, capabilities;
        uint groupCount, capabilityCount;
        Check(DeriveCapabilitySidsFromName(RuntimeCapabilityName, out groups, out groupCount, out capabilities, out capabilityCount),
            "Derive runtime capability");
        try {
            if (capabilityCount != 1 || capabilities == IntPtr.Zero) throw new InvalidOperationException("Unexpected runtime capability count");
            SecurityIdentifier sid = new SecurityIdentifier(Marshal.ReadIntPtr(capabilities));
            if (!sid.Value.StartsWith("S-1-15-3-1024-", StringComparison.Ordinal))
                throw new InvalidOperationException("Runtime capability is not a named capability SID");
            return sid;
        } finally { FreeSidArray(groups, groupCount); FreeSidArray(capabilities, capabilityCount); }
    }

    static void FreeSidArray(IntPtr array, uint count)
    {
        if (array == IntPtr.Zero) return;
        for (int index = 0; index < count; index++) LocalFree(Marshal.ReadIntPtr(array, index * IntPtr.Size));
        LocalFree(array);
    }

    /// <summary>Ensures the persistent runtime ACE is present AND fully propagated. The marker is written only after a
    /// successful propagation, so an interrupted first grant (ACE on the root, children incomplete) is redone next time.
    /// Any other ACE for the capability is refused, never extended.</summary>
    internal static bool EnsureRuntimeGrant(string root, SecurityIdentifier capability, Action check)
    {
        string marker = Path.Combine(root, RuntimeGrantMarker);
        DirectorySecurity security = SandboxFileSystem.ReadAccess(root);
        bool present = HasRuntimeRule(security, capability);
        if (present && MarkerMatches(marker, capability)) return false;
        if (MarkerAttributes(marker) != null) File.Delete(Canonical(marker, false));
        int count = 0;
        CheckTree(root, ref count, check);
        if (!present) security.AddAccessRule(new FileSystemAccessRule(capability, RuntimeRights, RuntimeInheritance, PropagationFlags.None, AccessControlType.Allow));
        if (Canonical(root, true) != root) throw new InvalidOperationException("Runtime root changed before grant");
        SandboxFileSystem.WriteAccess(root, security); // DACL write; Windows (re)propagates inherited ACEs to the tree.
        if (!HasRuntimeRule(SandboxFileSystem.ReadAccess(root), capability)) throw new InvalidOperationException("Runtime grant was not recorded");
        using (FileStream stream = new FileStream(marker, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
            byte[] bytes = Encoding.ASCII.GetBytes(capability.Value);
            stream.Write(bytes, 0, bytes.Length);
        }
        return true;
    }

    static bool MarkerMatches(string marker, SecurityIdentifier capability)
    {
        uint? attributes = MarkerAttributes(marker);
        if (attributes == null) return false;
        if ((attributes.Value & ((uint)FileAttributes.Directory | (uint)FileAttributes.ReparsePoint)) != 0) throw new InvalidOperationException("Invalid runtime grant marker");
        FileInfo info = new FileInfo(marker);
        if (info.Length > 256) throw new InvalidOperationException("Invalid runtime grant marker");
        return File.ReadAllText(marker, Encoding.ASCII) == capability.Value;
    }

    /// <summary>Null only when the marker does not exist; every other metadata error propagates.</summary>
    static uint? MarkerAttributes(string marker)
    {
        try { return SandboxFileSystem.Attributes(marker); }
        catch (Win32Exception error) {
            if (error.NativeErrorCode == 2 || error.NativeErrorCode == 3) return null;
            throw;
        }
    }

    static bool HasRuntimeRule(DirectorySecurity security, SecurityIdentifier capability)
    {
        bool found = false;
        foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
            if (!rule.IdentityReference.Equals(capability)) continue;
            bool exact = !rule.IsInherited && rule.AccessControlType == AccessControlType.Allow
                && (rule.FileSystemRights & RuntimeRights) == RuntimeRights
                && (rule.FileSystemRights & ~(RuntimeRights | FileSystemRights.Synchronize)) == 0
                && rule.InheritanceFlags == RuntimeInheritance && rule.PropagationFlags == PropagationFlags.None;
            if (!exact || found) throw new InvalidOperationException("Unexpected runtime capability ACE");
            found = true;
        }
        return found;
    }
}
