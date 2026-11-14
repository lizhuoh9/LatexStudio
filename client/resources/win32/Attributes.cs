using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

internal static partial class Sandbox
{
    internal sealed class Attributes : IDisposable {
        internal StartupEx Startup;
        IntPtr capabilities, handles, capabilitySid, capabilityList;
        /// <param name="capability">Binary named-capability SID added (enabled) to the AppContainer token.</param>
        internal Attributes(IntPtr sid, byte[] capability, IntPtr input, IntPtr output, IntPtr error) {
            try { Initialize(sid, capability, input, output, error); }
            catch { Dispose(); throw; }
        }
        void Initialize(IntPtr sid, byte[] capability, IntPtr input, IntPtr output, IntPtr error) {
            Startup.Info.Size = Marshal.SizeOf(typeof(StartupEx));
            Startup.Info.Flags = 0x100;
            Startup.Info.Input = input; Startup.Info.Output = output; Startup.Info.Error = error;
            IntPtr size = IntPtr.Zero;
            int count = 2;
            InitializeProcThreadAttributeList(IntPtr.Zero, count, 0, ref size);
            IntPtr list = Marshal.AllocHGlobal(size);
            if (!InitializeProcThreadAttributeList(list, count, 0, ref size)) {
                int failure = Marshal.GetLastWin32Error();
                Marshal.FreeHGlobal(list);
                throw new System.ComponentModel.Win32Exception(failure, "Initialize attributes");
            }
            Startup.Attributes = list;
            capabilities = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Capabilities)));
            capabilitySid = Marshal.AllocHGlobal(capability.Length);
            Marshal.Copy(capability, 0, capabilitySid, capability.Length);
            capabilityList = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SidAndAttributes)));
            Marshal.StructureToPtr(new SidAndAttributes { Sid = capabilitySid, Attributes = SeGroupEnabled }, capabilityList, false);
            Marshal.StructureToPtr(new Capabilities { Sid = sid, Caps = capabilityList, Count = 1 }, capabilities, false);
            Set(SecurityCaps, capabilities, Marshal.SizeOf(typeof(Capabilities)));
            handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.Copy(new IntPtr[] { input, output, error }, 0, handles, 3);
            Set(HandleList, handles, IntPtr.Size * 3);
        }
        void Set(int key, IntPtr pointer, int size) {
            Check(UpdateProcThreadAttribute(Startup.Attributes, 0, new IntPtr(key), pointer, new IntPtr(size), IntPtr.Zero, IntPtr.Zero), "Set sandbox attribute");
        }
        public void Dispose() {
            if (Startup.Attributes != IntPtr.Zero) { DeleteProcThreadAttributeList(Startup.Attributes); Marshal.FreeHGlobal(Startup.Attributes); }
            if (capabilities != IntPtr.Zero) Marshal.FreeHGlobal(capabilities);
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            if (capabilityList != IntPtr.Zero) Marshal.FreeHGlobal(capabilityList);
            if (capabilitySid != IntPtr.Zero) Marshal.FreeHGlobal(capabilitySid);
        }
    }
    internal sealed class Pipe : IDisposable {
        internal IntPtr Child;
        internal FileStream Parent;
        internal Pipe(bool output) {
            SecurityAttributes attributes = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Inherit = true };
            IntPtr read, write;
            Check(CreatePipe(out read, out write, ref attributes, 0), "Create stdio pipe");
            Child = output ? write : read;
            IntPtr parent = output ? read : write;
            Check(SetHandleInformation(parent, 1, 0), "Protect parent pipe");
            Parent = new FileStream(new SafeFileHandle(parent, true), output ? FileAccess.Read : FileAccess.Write, 4096, false);
        }
        internal void CloseChild() { if (Child != IntPtr.Zero) { CloseHandle(Child); Child = IntPtr.Zero; } }
        internal Task Pump(Stream destination) {
            return Task.Factory.StartNew(delegate { Parent.CopyTo(destination); destination.Flush(); });
        }
        public void Dispose() { CloseChild(); if (Parent != null) Parent.Dispose(); }
    }
    internal static string Quote(string value)
    {
        StringBuilder quoted = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value) {
            if (character == '\\') { slashes++; continue; }
            if (character == '"') quoted.Append('\\', slashes * 2 + 1).Append('"');
            else quoted.Append('\\', slashes).Append(character);
            slashes = 0;
        }
        return quoted.Append('\\', slashes * 2).Append('"').ToString();
    }
}
