using System;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

internal static partial class Sandbox
{
    internal sealed class Profile : IDisposable {
        internal IntPtr Sid;
        readonly string name = "PaperStudio.Compiler." + Guid.NewGuid().ToString("N");
        internal string Name { get { return name; } }
        internal bool CleanupError;
        internal Profile() {
            IntPtr created;
            int result = CreateAppContainerProfile(name, name, "Isolated local TeX compilation", IntPtr.Zero, 0, out created);
            if (result != 0) Marshal.ThrowExceptionForHR(result);
            FreeSid(created);
            result = DeriveAppContainerSidFromAppContainerName(name, out Sid);
            if (result != 0) {
                if (DeleteAppContainerProfile(name) != 0) throw new CleanupFailure(name);
                Marshal.ThrowExceptionForHR(result);
            }
        }
        public void Dispose() {
            if (Sid != IntPtr.Zero) { FreeSid(Sid); Sid = IntPtr.Zero; }
            int result = DeleteAppContainerProfile(name);
            CleanupError = result != 0;
            if (CleanupError) Diagnostic("Sandbox profile cleanup failed: 0x" + result.ToString("X8"));
        }
    }
    static int Main(string[] args)
    {
        try {
            // This process only: opt into Framework 4.6.2+ path handling before the first IO.
            AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
            AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
            return RunSession(ParseSession(args));
        }
        catch (Exception error) {
            Diagnostic("[PaperStudio sandbox refused] " + FailureCode(error));
            return 125;
        }
    }
    internal static void Start(Options options, Attributes attributes, out ProcessInfo process)
    {
        string command = String.Join(" ", new string[] { options.Executable }.Concat(options.Arguments).Select(Quote));
        if (command.Length >= 32760) throw new ArgumentException("Sandbox command line too long");
        IntPtr environment = Marshal.StringToHGlobalUni(EnvironmentBlock(options));
        try {
            Check(CreateProcess(options.Executable, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, true,
                Extended | Suspended | UnicodeEnv | NoWindow, environment, options.Work, ref attributes.Startup, out process), "Create AppContainer process");
        } finally { Marshal.FreeHGlobal(environment); }
    }
}
